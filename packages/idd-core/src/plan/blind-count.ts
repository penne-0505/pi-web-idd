import type { AgentRunner, ReviewExtra, RiskRoute } from "../agent/port.ts";
import type { PipelineSnapshot } from "../config/pipeline.ts";
import { reviewPolicy } from "../config/pipeline.ts";
import { firstBlindOfPass, judgeSync, passPolicy } from "../ledger/review-loop.ts";
import { reviewNextStep } from "../ledger/review-loop-next.ts";
import { reviewBaseOf } from "../ledger/base.ts";
import { headCommit } from "../worktree/ensure.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { DEPTH_TABLE, MAX_SPEC, recordedDepth, type Depth } from "./depth.ts";
import { laneDepth } from "./depth-read.ts";
import { conflictMerge, conflictRoundPending, lastReviewRound, laneRisk, mergedReviewTree } from "./review-scope.ts";

/**
 * The one count of the blind copies a round holds, read by the stage that starts the round and by the wait list that
 * says which lanes are held back. Both ask for the same round and the same pipeline, so they get the same numbers
 * whatever the round's depth, extras, spec check, routes or conflict scope are.
 */

/** what decides how many runs a blind or final round makes */
export interface BlindRound {
  kind: "blind" | "final";
  /** a conflict scope round: it reads the merge's resolution only */
  conflict: boolean;
  /** the depth the round runs at; none for a lane that declared none (and for a review lane) */
  depth?: Depth;
  /** the extra roles the round adds */
  extras: ReviewExtra[];
  /** how many routes the round's map drew; a routed round makes one blind per route and one for the rest */
  routes: number;
  /** the pass's first blind that no conflict scope narrows: the round a map may be drawn before */
  mapped?: boolean;
}

export interface BlindCount {
  /** the copies the plain gate is held against: the slot's usual size, or the round's own for a conflict scope round */
  fits: number;
  /** a routed round's gate on top of the plain one: the copies its own runs hold */
  routed?: number;
  /** the runs the round starts, added to the copies held once it has */
  runs: number;
  /** a conflict scope round: it is held against its own runs alone, and the lane cap does not hold it back */
  conflict?: true;
}

/**
 * The copies a usual Issue lane's round is held against: one per run of the slot (its roles with its models, and the
 * extras), and the spec check's copy beside them when the slot that runs it is declared. A depth-bearing round is the
 * only one that starts the check, but the usual size stays the largest a round may be, so `concurrency` keeps meaning
 * the lanes that run at once.
 */
export function blindSlotSize(pipe: PipelineSnapshot): number {
  return pipe.size("review_blind") + (pipe.declared("spec_check") ? MAX_SPEC : 0);
}

/** the runs the round starts, the way the stage's runner lists them: the slot's runs, the extras, the depth's cut, the routes, the spec check */
export function blindRoundRuns(pipe: PipelineSnapshot, round: BlindRound): number {
  const roster = pipe.roster("review_blind");
  const runs = round.conflict ? roster.runs.slice(0, 1) : [...roster.runs];
  for (const x of round.extras) for (const run of roster.extra[x]) if (!runs.includes(run)) runs.push(run);
  const high = roster.extra.high_risk;
  // the depth's table cuts a blind to its count, and leaves the last review the senior role alone
  const limited = round.depth === undefined
    ? runs.length
    : round.kind === "final"
      ? (high.length ? high.length : Math.min(1, runs.length))
      : Math.min(DEPTH_TABLE[round.depth].blind, runs.length);
  const blinds = round.routes > 0 && limited > 0 ? Math.min(round.routes, pipe.maxRoutes()) + 1 : limited;
  const spec = round.depth !== undefined && pipe.declared("spec_check") ? Math.min(DEPTH_TABLE[round.depth].spec, pipe.roster("spec_check").runs.length) : 0;
  return blinds + spec;
}

/**
 * What to hold the round against and what it adds. The plain gate stays at `usual` (the slot's size) so a shallow round
 * does not let more lanes in than `concurrency` says; a conflict scope round, which cuts only what it starts, and a
 * routed round, whose size no usual round has, are held against their own runs.
 */
export function blindCountOf(pipe: PipelineSnapshot, round: BlindRound, usual: number): BlindCount {
  const runs = blindRoundRuns(pipe, round);
  return { fits: round.conflict ? runs : usual, ...(round.routes > 0 ? { routed: runs } : {}), runs, ...(round.conflict ? { conflict: true as const } : {}) };
}

/**
 * The one gate a blind (or confirm) round passes before it starts, read by the stage that starts rounds and by the wait
 * list. It holds the copies in use and the lanes using them. A round is held against the copies the slot allows
 * (`concurrency` × the usual size) and, so that `concurrency` keeps meaning the lanes that run at once while a shallow
 * round adds fewer copies than the usual size, against the lanes too. A conflict scope round reads only the hunks the
 * merge resolved, so it waits for its own copies alone; once it runs it counts as a lane like any other.
 */
export class BlindGate {
  private copies: number;
  private lanes: number;
  private readonly copyCap: number;
  private readonly laneCap: number;
  constructor(laneCap: number, usual: number, copies: number, lanes: number) {
    this.laneCap = laneCap;
    this.copyCap = laneCap * usual;
    this.copies = copies;
    this.lanes = lanes;
  }
  private roomFor(copies: number): boolean {
    return this.copies === 0 || this.copies + copies <= this.copyCap;
  }
  /** whether the round may start now */
  fits(count: BlindCount): boolean {
    if (!this.roomFor(count.fits)) return false;
    return this.copies === 0 || count.conflict === true || this.lanes < this.laneCap;
  }
  /** whether a routed round's own runs fit on top of the plain gate */
  fitsRouted(count: BlindCount): boolean {
    return this.roomFor(count.routed ?? count.fits);
  }
  /** a lane started a round that holds `runs` copies */
  took(runs: number): void {
    this.copies += runs;
    this.lanes += 1;
  }
  /** a lane's round holding `runs` copies is done with */
  released(runs: number): void {
    this.copies -= runs;
    this.lanes -= 1;
  }
}

/**
 * Whether the map the lane's blind would read was drawn at a head the lane has left: the stage draws the map again
 * before it starts anything then, so the lane holds no copy. The fold answers it, with the other gates open, from the
 * same facts the stage asks with.
 */
export function mapHeadMoved(events: LifecycleRecord[], reviewOn: boolean, mapOn: boolean, at: LaneAt): boolean {
  return reviewNextStep(events, { reviewOn, mapOn, mapFits: true, blindFits: true, routeBlindFits: true, at }).event === "s2_map_head_moved";
}

/**
 * Why the diff gets no map, asked of the runner the stage starts rounds with; undefined when it gets one (or the runner
 * cannot tell, which the stage reads the same way). The stage and the wait list both ask it here, so the lanes the stage
 * draws a map for first are the ones the wait list leaves out of the blind's copies.
 */
export function mapSkipReasonOf(runner: AgentRunner | null | undefined, at: { worktree: string; base: string; head: string }): string | undefined {
  return runner?.riskMapSkipReason?.(at) ?? undefined;
}

/**
 * Whether the stage draws the map before it starts the round's blind: the slot is declared, the lane has no map yet, the
 * round is the pass's first blind and the runner says the diff is large enough. The map takes a slot of its own and
 * holds none of the blind's copies, so such a lane is held by the map's cap alone. A process whose runner starts no
 * review run starts nothing, so it reads no map first and counts the blind.
 */
export function mapComesFirst(runner: AgentRunner | null | undefined, mapOn: boolean, hasMap: boolean, mapped: boolean | undefined, at: { worktree: string; base: string; head: string } | undefined): boolean {
  if (!runner?.startReviewRun || !mapOn || hasMap || !mapped || !at) return false;
  return !mapSkipReasonOf(runner, at);
}

/** a review lane's blind round: the slot's runs over the PR's diff, with no extras, no depth and no spec check beside them */
export function reviewLaneBlindCount(pipe: PipelineSnapshot, routes: number): BlindCount {
  return blindCountOf(pipe, { kind: "blind", conflict: false, extras: [], routes }, pipe.size("review_blind"));
}

/** the count of a round that cannot be read (no worktree, no head): the most it may hold, which is the usual size */
export function unreadBlindCount(usual: number): BlindCount {
  return { fits: usual, runs: usual };
}

/** the lane's worktree, the commit its work started from and its head now, when all three can be read */
export interface LaneAt {
  worktree: string;
  base: string;
  head: string;
}

export function laneAtOf(worktree: string | undefined, events: LifecycleRecord[]): LaneAt | undefined {
  if (!worktree) return undefined;
  const base = reviewBaseOf(events);
  const head = headCommit(worktree);
  return base && head ? { worktree, base, head } : undefined;
}

/**
 * The round the lane's next start would be, read without writing a record or a ref: the depth it would run at, the
 * extras it would add, whether it is a conflict scope round and how many routes it would be given. The stage reads
 * the same things as it goes, so the round it starts is the round this reads.
 */
export function upcomingBlindRound(rec: BacklogRecord, evs: LifecycleRecord[], st: { kind: string; map?: { routes: RiskRoute[] } }, at: LaneAt): BlindRound | undefined {
  if (st.kind !== "blind" && st.kind !== "final") return undefined;
  const kind = st.kind;
  const policy = reviewPolicy();
  // the lane's own origin: the declaration is matched against its whole change, not against what the round is shown
  const laneBase = at.base;
  let matchBase = laneBase;
  let conflict = false;
  if (kind === "blind" && policy.afterMerge === "conflict" && conflictRoundPending(evs)) {
    const since = lastReviewRound(evs);
    const m = since ? conflictMerge(at.worktree, evs, since, at.head) : undefined;
    if (m) {
      // the base the round will diff against (the lane's review origin with the mainline it takes in merged), read here
      // without writing a ref: the count has to rest on the risk that round will read, or the wait and the round disagree
      matchBase = mergedReviewTree(at.worktree, laneBase, m.mainline) ?? m.mainline;
      conflict = m.recordOnly;
    }
  }
  // under `high_risk_when: last` the stage reads the lane's Risk once, on the lane's own origin, before a conflict moves
  // the base; otherwise it reads it where the round's base stands, so the extras are decided on the same base here
  const newHigh = policy.highRiskWhen === "last" && policy.extras.high_risk > 0;
  const risk = () => laneRisk(rec, at.worktree, newHigh ? laneBase : matchBase).high;
  let depth = passPolicy(evs).depth;
  // the first blind of a pass reads the lane's depth afresh: the record's, raised by the lane's Risk
  if (kind === "blind" && firstBlindOfPass(evs) && recordedDepth(evs) !== undefined) depth = laneDepth(rec, at.worktree, laneBase);
  // a depth-bearing round takes its roles from the depth's table; the fold decides the extras of one that has none
  const extras: ReviewExtra[] = depth !== undefined
    ? (kind === "final" ? ["high_risk"] : [])
    : judgeSync<{ extras?: ReviewExtra[] }>("round_extras", evs, { policy, kind, conflict }, (need) => {
      if (need.kind === "risk") return risk();
      throw new Error(`知らない事実です: ${need.kind}`);
    }).extras ?? [];
  // the map's routes serve the pass's first blind alone
  const mapped = kind === "blind" && !conflict && firstBlindOfPass(evs);
  return { kind, conflict, ...(depth !== undefined ? { depth } : {}), extras, routes: mapped ? st.map?.routes.length ?? 0 : 0, mapped };
}

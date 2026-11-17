import { pipelineSnapshot, reviewPolicy, type PipelineSnapshot } from "../config/pipeline.ts";
import { executorWait } from "./review-loop.ts";
import { deriveStage, laneHeld, planReviewPhase, withoutNotes } from "../ledger/derive.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { inStartOrder } from "../ledger/start-order.ts";
import { blindEverRan, reviewLoopState, type ReviewLoopState } from "../ledger/review-loop.ts";
import { reviewLaneState, type ReviewEvent, type ReviewLaneRecord } from "../review-lane/state.ts";
import { listReviewLanes } from "../review-lane/store.ts";
import { quotaHoldOf } from "./quota-wait.ts";
import { getAgentRunner } from "../agent/port.ts";
import { BlindGate, type BlindCount, blindCountOf, blindSlotSize, laneAtOf, mapComesFirst, mapHeadMoved, reviewLaneBlindCount, unreadBlindCount, upcomingBlindRound } from "./blind-count.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";

/**
 * The stages with a parallel cap. `review_lane` / `review_lane_map` are the review lanes (someone else's PR): they
 * read the caps of review_blind / risk_map but count their own runs, apart from the Issue lanes' review loop.
 */
export type CappedSlot =
  | "planner" | "executor" | "plan_review" | "review_blind" | "risk_map" | "triage" | "confirm"
  | "review_lane" | "review_lane_map";

export interface SlotWaitLane {
  id: string;
  /** when the lane came to be ready to start this stage, read from its record */
  since: string;
  waitedMinutes: number;
}

export interface SlotWait {
  slot: CappedSlot;
  cap: number;
  /** the lanes holding the stage's slots now (for the blind rounds, the lanes, not the copies) */
  running: number;
  /** ready to start and held back only by the cap, in the order the stage would take them */
  lanes: SlotWaitLane[];
  /**
   * ready to start and not held back: the lanes the stage takes on its next pass into the slots free now. A lane
   * that waited for the cap is here, not in `lanes`, from the tick a slot frees until the stage starts it.
   */
  next: string[];
}

/**
 * The shortest tail of a lane's record over which it has stood ready: the event that made it ready. Waiting for
 * the cap adds nothing to the record, so this is read again each time instead of being written down.
 */
function readySince<T extends { at: string }>(events: T[], ready: (prefix: T[]) => boolean): string | undefined {
  let len = events.length;
  while (len > 1 && ready(events.slice(0, len - 1))) len -= 1;
  return events[len - 1]?.at;
}

/**
 * The lane's next start waits for Claude Code's windows when the same judgment the stage's start uses holds it
 * (quotaHoldOf): the runtime's reading now, or the record's reset when this process cannot read it. A refusal
 * whose reset has passed no longer holds it, so from the reset on the lane waits for the cap.
 */

/** the later of the lane's ready and the reset of the windows that refused it */
function later(since: string | undefined, resetAt: string | undefined): string | undefined {
  if (!resetAt || !since) return since ?? resetAt;
  return Date.parse(resetAt) > Date.parse(since) ? resetAt : since;
}

class Tally {
  readonly lanes: { id: string; since: string }[] = [];
  /** the lanes the stage would start into the slots free now */
  readonly next: string[] = [];
  /** the slots held as the stage would take them this tick: the ones held now, then each lane it would start */
  private taken: number;
  readonly slot: CappedSlot;
  readonly cap: number;
  readonly running: number;
  constructor(slot: CappedSlot, cap: number, running: number) {
    this.slot = slot;
    this.cap = cap;
    this.running = running;
    this.taken = running;
  }
  take(id?: string): boolean {
    if (this.taken >= this.cap) return false;
    this.taken += 1;
    if (id) this.next.push(id);
    return true;
  }
  wait(id: string, since: string | undefined, fallback: string): void {
    this.lanes.push({ id, since: since ?? fallback });
  }
  view(now: number): SlotWait {
    return {
      slot: this.slot,
      cap: this.cap,
      running: this.running,
      lanes: this.lanes.map((l) => {
        const t = Date.parse(l.since);
        return { ...l, waitedMinutes: Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 60000)) };
      }),
      next: [...this.next],
    };
  }
}

/**
 * Which lanes each capped stage leaves waiting for its cap, as the next tick would see them: the stage's gate and
 * order are followed, and a lane that waits on anything else (a dependency, Claude's windows, its budget, penne,
 * a question) is not counted. The stages are the ones the tick starts; one that is not declared is left out.
 * roles.yaml and each ledger file are read once per call; a caller that has read the ledger hands it over.
 */
export function slotWaits(opts: { now?: number; backlog?: BacklogRecord[]; events?: LifecycleRecord[] } = {}): SlotWait[] {
  const now = opts.now ?? Date.now();
  const pipe = pipelineSnapshot();
  const backlog = opts.backlog ?? readBacklog();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of opts.events ?? readLifecycle()) {
    const list = byLane.get(e.idd_id);
    if (list) list.push(e);
    else byLane.set(e.idd_id, [e]);
  }
  const evsOf = (id: string) => byLane.get(id) ?? [];
  const has = (id: string, names: string[]) => evsOf(id).some((e) => names.includes(e.event));
  const created = new Map(backlog.map((r) => [r.idd_id, r.created_at]));
  const recOf = new Map(backlog.map((r) => [r.idd_id, r]));
  // the one order the capped stages take their lanes in: what they would start next, in the user's order
  const ordered = inStartOrder(backlog);
  const hold = (evs: LifecycleRecord[]) => quotaHoldOf(withoutNotes(evs).at(-1), "claude_quota_wait", now);
  const out: Tally[] = [];

  /** one stage whose lanes are ready by `ready` and taken in the given order, one slot each */
  const simple = (t: Tally, recs: BacklogRecord[], skip: (id: string, evs: LifecycleRecord[]) => boolean, ready: (id: string, evs: LifecycleRecord[]) => boolean) => {
    for (const rec of recs) {
      const evs = evsOf(rec.idd_id);
      if (skip(rec.idd_id, evs) || !ready(rec.idd_id, evs)) continue;
      const q = hold(evs);
      if (q.held || t.take(rec.idd_id)) continue;
      t.wait(rec.idd_id, later(readySince(evs, (prefix) => ready(rec.idd_id, prefix)), q.resetAt), rec.created_at);
    }
    out.push(t);
  };

  // S1: the planner, in the order prep takes them; a session holds its slot until the planner's ready
  const planners = readSessions("planner");
  simple(
    new Tally("planner", pipe.concurrency("planner"), planners.filter((r) => !has(r.idd_id, ["s1_ready", "s1_defer", "lane_close"])).length),
    ordered,
    (id) => planners.some((r) => r.idd_id === id),
    (_id, evs) => {
      const d = deriveStage(evs);
      return d.group === "prep" && !d.decision;
    },
  );

  // S1: the plan review
  if (pipe.declared("plan_review")) {
    const closed = (evs: LifecycleRecord[]) => evs.some((e) => e.event === "lane_close" || e.event === "s1_defer");
    const running = [...byLane.values()].filter((evs) => !closed(evs) && planReviewPhase(evs).phase === "running").length;
    simple(new Tally("plan_review", pipe.concurrency("plan_review"), running), ordered, (_, evs) => closed(evs), (_id, evs) => !laneHeld(evs) && planReviewPhase(evs).phase === "waiting");
  }

  // S2: the executor; a session holds its slot until its result
  const executors = readSessions("executor");
  simple(
    new Tally("executor", pipe.concurrency("executor"), executors.filter((r) => !has(r.idd_id, ["s2_result", "lane_close"])).length),
    ordered,
    (id) => executors.some((r) => r.idd_id === id),
    (_id, evs) => deriveStage(evs).group === "impl",
  );

  // S2: the review loop's stages, one step per lane in the backlog's order, as runReviewLoop takes them
  const worktrees = new Map(executors.map((r) => [r.idd_id, r.worktree_path]));
  out.push(...reviewLoopWaits(pipe, ordered.map((r) => r.idd_id), evsOf, created, hold, worktrees, recOf, now));

  out.push(...reviewLaneWaits(pipe, now));
  return out.map((t) => t.view(now));
}

function reviewLoopWaits(
  pipe: PipelineSnapshot,
  ids: string[],
  evsOf: (id: string) => LifecycleRecord[],
  created: Map<string, string>,
  hold: (evs: LifecycleRecord[]) => ReturnType<typeof quotaHoldOf>,
  worktrees: Map<string, string | undefined>,
  recOf: Map<string, BacklogRecord>,
  now: number,
): Tally[] {
  const executorStillSeconds = reviewPolicy().executorStillSeconds;
  const executorHeld = new Set<string>();
  const unjudged = new Set<string>();
  const reviewOn = pipe.declared("review_blind");
  const mapOn = pipe.declared("risk_map");
  const closed = (evs: LifecycleRecord[]) => evs.some((e) => e.event === "lane_close" || e.event === "s3_defer");
  const lanes = ids.map((id) => {
    const evs = evsOf(id);
    return { id, evs, st: closed(evs) ? null : reviewLoopState(evs) };
  });
  const holding = (state: ReviewLoopState["state"], heldToo = true) => lanes.filter((l) => l.st?.state === state && (heldToo || !laneHeld(l.evs))).length;
  // the blind cap counts copies (one per run); what is shown is the lanes holding them
  // the Issue lane's round holds the spec check's copy beside its blinds, when the slot that runs it is declared
  const size = blindSlotSize(pipe);
  // the gate holds the lanes that run at once beside the copies, the way the stage's does
  const running = lanes.flatMap((l) => (l.st?.state === "running_blind" ? [l.st.runIds.length] : []));
  const gate = new BlindGate(pipe.concurrency("review_blind"), size, running.reduce((n, runs) => n + runs, 0), running.length);
  const blind = new Tally("review_blind", pipe.concurrency("review_blind"), holding("running_blind"));
  // a lane stopped for penne does not hold a map slot
  const map = new Tally("risk_map", pipe.concurrency("risk_map"), holding("running_map", false));
  const triage = new Tally("triage", pipe.concurrency("triage"), holding("running_triage"));
  const confirm = new Tally("confirm", pipe.concurrency("confirm"), holding("running_confirm"));
  const at = (state: ReviewLoopState["state"]) => (evs: LifecycleRecord[]) => !laneHeld(evs) && reviewLoopState(evs).state === state;

  for (const { id, evs, st } of lanes) {
    if (!st || laneHeld(evs)) continue;
    const q = hold(evs);
    if (q.held) continue;
    const fallback = created.get(id) ?? "";
    const since = (state: ReviewLoopState["state"]) => later(readySince(evs, at(state)), q.resetAt);
    if (st.state === "start_blind") {
      // a kept check left by a lane from before R2 was removed starts no run: it holds none of the review_blind copies
      if (st.kind === "kept") continue;
      // with no blind declared the first round is skipped, not started (a lane whose loop never ran a blind)
      if (st.kind === "blind" && !blindEverRan(evs) && !reviewOn) continue;
      // a lane whose executor has not stopped yet waits for it before any slot, the map's included: the stage starts nothing
      // for it and takes no slot (read only here; the stage is the one that records the wait)
      if (st.kind === "blind" && executorWait(id, evs, executorStillSeconds, now)) { executorHeld.add(id); continue; }
      // the round the stage would start, counted the way the stage counts it (blind-count.ts); one that cannot be read
      // (no worktree, no head) holds the most a round may. A lane whose reading throws (a roles.yaml that does not
      // parse into a runner's answer) is left out of the list, not counted as waiting or next: the stage fails its start
      // and records it, and the other lanes' waits are still shown
      let count: BlindCount;
      try {
        const rec = recOf.get(id);
        const at = laneAtOf(worktrees.get(id), evs);
        const round = rec && at ? upcomingBlindRound(rec, evs, st, at) : undefined;
        // a lane whose map was drawn at a head it has left draws the map again before it starts anything: it holds no
        // copy and is not held back by the cap (the stage asks the same fold, before the cap)
        if (at && mapHeadMoved(evs, reviewOn, mapOn, at)) continue;
        count = round ? blindCountOf(pipe, round, size) : unreadBlindCount(size);
        // a lane the stage draws the map for first (the runner says the diff is large enough) starts no blind this tick and
        // holds none of its copies: it is held by the map's cap alone, as the stage holds it, whatever the blind's cap holds
        if (mapComesFirst(getAgentRunner(), mapOn, !!st.map, round?.mapped, at)) {
          if (!map.take()) map.wait(id, since("start_blind"), fallback);
          continue;
        }
      } catch {
        unjudged.add(id);
        continue;
      }
      if (!gate.fits(count)) { blind.wait(id, since("start_blind"), fallback); continue; }
      if (count.routed !== undefined && !gate.fitsRouted(count)) { blind.wait(id, since("start_blind"), fallback); continue; }
      gate.took(count.runs);
    } else if (st.state === "start_triage") {
      if (!triage.take(id)) triage.wait(id, since("start_triage"), fallback);
    } else if (st.state === "start_confirm") {
      if (!confirm.take(id)) confirm.wait(id, since("start_confirm"), fallback);
    }
  }
  // the blind round's next lanes: the ones at its start that the count above left unheld, in the stage's order. A
  // lane the round skips or maps first is here too: it moves on this pass as well, and it is not waiting on the cap
  // a lane held for its executor starts nothing this pass either, so it is not a next lane
  const held = new Set([...blind.lanes, ...map.lanes].map((l) => l.id).concat([...executorHeld], [...unjudged]));
  for (const { id, evs, st } of lanes) {
    if (st?.state === "start_blind" && !laneHeld(evs) && !hold(evs).held && !held.has(id)) blind.next.push(id);
  }
  return [
    ...(reviewOn ? [blind] : []),
    ...(mapOn ? [map] : []),
    ...(pipe.declared("triage") ? [triage] : []),
    ...(pipe.declared("confirm") ? [confirm] : []),
  ];
}

/** the review lanes: blind and confirm rounds share the copies of review_blind's cap, counted apart from the Issue lanes */
function reviewLaneWaits(pipe: PipelineSnapshot, now: number): Tally[] {
  if (!pipe.declared("review_blind")) return [];
  const mapOn = pipe.declared("risk_map");
  const recs = listReviewLanes().map((rec) => ({ rec, st: reviewLaneState(rec) }));
  const size = pipe.size("review_blind");
  const cap = pipe.concurrency("review_blind");
  const running = recs.flatMap(({ st }) => (st.state === "running_blind" ? [st.runIds.length] : st.state === "running_confirm" ? [size] : []));
  const gate = new BlindGate(cap, size, running.reduce((n, copies) => n + copies, 0), running.length);
  const lanes = new Tally("review_lane", cap, recs.filter(({ st }) => st.state === "running_blind" || st.state === "running_confirm").length);
  const unjudged = new Set<string>();
  const map = new Tally("review_lane_map", pipe.concurrency("risk_map"), recs.filter(({ st }) => st.state === "running_map").length);

  for (const { rec, st } of recs) {
    const q = quotaHoldOf(rec.history[rec.history.length - 1], "r_quota_wait", now);
    if (q.held) continue;
    const since = () => later(readySince<ReviewEvent>(rec.history, (history) => reviewLaneState({ ...rec, history } as ReviewLaneRecord).state === st.state), q.resetAt);
    if (st.state === "start_blind") {
      const count = reviewLaneBlindCount(pipe, st.map?.routes.length ?? 0);
      // as in the Issue lanes: a lane the stage draws the map for first holds none of the blind's copies, and the blind's cap is not asked of it
      // (a lane whose reading throws is left out of the list, as there)
      const path = String(rec.history.findLast((e) => e.event === "r_wt_ready")?.attrs?.path ?? "");
      try {
        if (mapComesFirst(getAgentRunner(), mapOn, !!st.map, true, { worktree: path, base: st.base, head: st.head })) {
          if (!map.take()) map.wait(rec.id, since(), rec.created_at);
          continue;
        }
      } catch {
        unjudged.add(rec.id);
        continue;
      }
      if (!gate.fits(count)) { lanes.wait(rec.id, since(), rec.created_at); continue; }
      if (count.routed !== undefined && !gate.fitsRouted(count)) { lanes.wait(rec.id, since(), rec.created_at); continue; }
      gate.took(count.runs);
    } else if (st.state === "start_confirm") {
      const confirm = { fits: size, runs: size };
      if (!gate.fits(confirm)) { lanes.wait(rec.id, since(), rec.created_at); continue; }
      gate.took(size);
    }
  }
  // as in the Issue lanes: the next lanes are the ones at a start the count above left unheld
  const held = new Set([...lanes.lanes, ...map.lanes].map((l) => l.id).concat([...unjudged]));
  for (const { rec, st } of recs) {
    if ((st.state === "start_blind" || st.state === "start_confirm") && !quotaHoldOf(rec.history[rec.history.length - 1], "r_quota_wait", now).held && !held.has(rec.id)) lanes.next.push(rec.id);
  }
  return [lanes, ...(mapOn ? [map] : [])];
}

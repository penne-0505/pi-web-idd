/**
 * Where a lane stands, cut the same way for the closed lanes' usual durations and for an open lane's elapsed time
 * (DEC-104-1). Every point of a lane's record is one of the machine stages, a human gate, a wait, or the end.
 * Machine stages carry the time that counts; a gate and a wait carry none, so the question gate, the order and
 * dependency waits, the cap wait and Claude's windows never enter a stage's length.
 *
 * The reading is the one the engine already has: deriveStage for the gates and the waits, planReviewPhase for the
 * plan review, reviewLoopState for the order wait, and the shared question reading for the question gate. The
 * landing approval lives in the overlay layer, which the ledger must not read back: the caller hands the decision
 * in (DEC-104-5). The split is versioned so a change to it measures the old rows again.
 */

import type { LifecycleRecord } from "../schema/records.ts";
import { deriveStage, planReviewPhase, quotaWait, replanView, withoutNotes, type DecisionKind } from "./derive.ts";
import { unansweredQuestions } from "./questions.ts";
import { beginsFixRound, feedbackPassAt, MERGE_ONLY_SKIP_EVENT, reviewLoopState } from "./review-loop.ts";
import type { QuotaCut } from "../plan/quota-wait.ts";

/**
 * The version of this split. Bump it whenever the cut changes: rows of an older version are measured again.
 * 3: a round skipped because the head was only the mainline merged in ends the round as a converged one does, so the
 *    S3 and submit after it are no longer counted as the fix round that preceded it.
 * The stage after convergence was keyed `r2` while R2 ran in it; it is `checks` since R2 was removed (2026-10-22), and
 * the rows written under the old key are read as `checks` (stage-durations.ts), so the split itself did not change.
 * 4: a plan the review sent back and the planner re-readied waits for a second review (`planReviewPhase` says
 *    `waiting`), so the time between that ready and the next review is the plan review's, not the GO gate's.
 */
export const STAGE_RULE_VERSION = 4;

export type StageKey = "plan" | "plan_review" | "impl" | "review" | "fix" | "checks" | "land";
export type GateKey = "question" | "go" | "sign" | "card";
export type WaitKey = "order" | "dependency" | "outside" | "quota" | "slot";

export type StagePoint =
  | { kind: "closed" }
  | { kind: "gate"; gate: GateKey }
  | { kind: "wait"; wait: WaitKey }
  | { kind: "stage"; stage: StageKey; /** only a fix round carries the round it belongs to */ fixRound?: number };

/** the one fact the split needs that is not in the ledger: whether a landing approval is in force */
export interface StageSplitContext {
  /** overlay/land.ts's currentLandApproval, handed in so the ledger never reads the overlay; its value is used as a truth */
  landApproved?: (events: LifecycleRecord[]) => unknown;
  /**
   * How this cut reads Claude Code's windows. Left out to read the runtime now — the current point of an open
   * lane. A past prefix is cut with "record" instead, so no sample moves with the clock (C-133-4).
   */
  quota?: QuotaCut;
}

const CLOSE_EVENTS: readonly string[] = ["lane_close", "s1_defer", "s3_defer"];
const CONVERGED_EVENTS: readonly string[] = ["s2_review_converged", "s2_review_skipped", MERGE_ONLY_SKIP_EVENT];

function lastIndex(events: LifecycleRecord[], name: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return i;
  return -1;
}

function lastIndexOfAny(events: LifecycleRecord[], names: readonly string[]): number {
  return Math.max(...names.map((n) => lastIndex(events, n)));
}

/** the decision kinds that are a human gate: the GO card, the signature, and everything else penne must judge */
function gateOf(decision: DecisionKind): GateKey {
  if (decision === "go") return "go";
  if (decision === "ship") return "sign";
  return "card";
}

/** the indices where a fix round began, in record order */
export function fixRoundStarts(events: LifecycleRecord[]): number[] {
  return events.flatMap((e, i) => (beginsFixRound(e) ? [i] : []));
}

/**
 * Where a lane stands at the end of this prefix of its record. The order is the table's: the end first, then the
 * question gate (which hits any stage), then the landing, then the other gates, then the waits, then the machine
 * stages. A PR feedback pass that began after convergence is the first review again until its own fix: the loop
 * judges the comments there, and that judgement is not the checks. deriveStage's `question` decision is
 * deliberately not read as the question gate: after `s2_start` it does not set `question` at all, so an executor's
 * question is picked up from `unansweredQuestions` instead.
 */
export function classify(allEvents: LifecycleRecord[], ctx: StageSplitContext = {}): StagePoint {
  // a lane sent back to its plan stands at the plan again: the stretch before the send-back is not read as this one
  const events = replanView(allEvents);
  if (!events.length) return { kind: "stage", stage: "plan" };
  const names = events.map((e) => e.event);
  const has = (n: string) => names.includes(n);

  if (CLOSE_EVENTS.some((n) => has(n))) return { kind: "closed" };
  if (unansweredQuestions(events).length > 0) return { kind: "gate", gate: "question" };
  if (ctx.landApproved?.(events)) return { kind: "stage", stage: "land" };

  const d = deriveStage(events, ctx.quota);
  if (d.decision && d.decision !== "question") return { kind: "gate", gate: gateOf(d.decision) };
  const notes = withoutNotes(events);
  const lastEvent = notes[notes.length - 1]?.event;

  if (d.group === "waiting") {
    if (has("s2_start") && reviewLoopState(events).state === "awaiting_order") return { kind: "wait", wait: "order" };
    if (lastEvent === "blocked_by_dependency") return { kind: "wait", wait: "dependency" };
    return { kind: "wait", wait: "outside" };
  }
  if (lastEvent === "claude_quota_wait" && quotaWait(events, ctx.quota).held) return { kind: "wait", wait: "quota" };
  // GO reached and the executor's start not written: waiting for the executor's cap (not a stage's time)
  if (has("s1_go") && lastIndex(events, "s1_go") > lastIndex(events, "s2_start")) return { kind: "wait", wait: "slot" };

  const firstStart = names.indexOf("s2_start");
  if (firstStart < 0) {
    // the plan and its review run before the executor's start; a send-back from the GO card puts the lane back here
    const phase = planReviewPhase(events);
    if (!has("s1_ready") || phase.phase === "sent_back") return { kind: "stage", stage: "plan" };
    return { kind: "stage", stage: "plan_review" };
  }

  const firstResult = names.indexOf("s2_result");
  if (firstResult < 0) return { kind: "stage", stage: "impl" };
  const starts = fixRoundStarts(events);
  const converged = lastIndexOfAny(events, CONVERGED_EVENTS);
  // the loop converged after the last fix: what follows is the checks, unless a send-back opened a new round
  if (starts.length && starts[starts.length - 1] > converged) return { kind: "stage", stage: "fix", fixRound: starts.length };
  // PR feedback after convergence: the pass it opens judges the comments before it sends a fix, and that judgement
  // is the first review again, not the checks (the cap the pass left behind is not this pass's)
  const feedback = feedbackPassAt(events);
  if (feedback >= 0 && feedback > converged) return { kind: "stage", stage: "review" };
  if (converged >= 0) return { kind: "stage", stage: "checks" };
  return { kind: "stage", stage: "review" };
}

export type StageSpan = StagePoint & {
  /** the time the classification began */
  from: string;
  /** the time it ended (the next change, the lane's end, or now for an open lane) */
  to: string;
};

function samePoint(a: StagePoint, b: StagePoint): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "stage" && b.kind === "stage") return a.stage === b.stage && a.fixRound === b.fixRound;
  if (a.kind === "gate" && b.kind === "gate") return a.gate === b.gate;
  if (a.kind === "wait" && b.kind === "wait") return a.wait === b.wait;
  return true;
}

function spanOf(point: StagePoint, from: string, to: string): StageSpan {
  return { ...point, from, to };
}

/**
 * The lane's record cut into spans of one classification each, in record order. A span begins when its
 * classification began and ends when the next classification began. The last span runs to `now` for an open lane,
 * and to the closing record for a closed one. Nothing is written: the closed lanes' samples and the open lanes'
 * current stage both come from here.
 */
export function stageSpans(events: LifecycleRecord[], ctx: StageSplitContext = {}, now?: number): StageSpan[] {
  if (!events.length) return [];
  const spans: StageSpan[] = [];
  // every prefix but the last is a past cut: the record alone decides, so the observation cannot move a sample
  const past: StageSplitContext = { ...ctx, quota: "record" };
  let cur = classify(events.slice(0, 1), events.length === 1 ? ctx : past);
  let from = events[0].at;
  for (let i = 1; i < events.length; i += 1) {
    const next = classify(events.slice(0, i + 1), i === events.length - 1 ? ctx : past);
    if (!samePoint(cur, next)) {
      spans.push(spanOf(cur, from, events[i].at));
      cur = next;
      from = events[i].at;
    }
  }
  const endAt = cur.kind === "closed" ? events[events.length - 1].at : new Date(now ?? Date.now()).toISOString();
  spans.push(spanOf(cur, from, endAt));
  return spans;
}

export interface LaneDurations {
  /** minutes on each machine stage that counts as one sample per lane; a stage the lane never stood on is absent */
  stages: Partial<Record<StageKey, number>>;
  /** one entry per fix round, minutes (the rounds are samples of their own) */
  fixRounds: number[];
  /** where the record stands at its end */
  point: StagePoint;
  /** when the current (last) span began */
  since: string;
}

function minutesBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 60000) : 0;
}

/**
 * The lane's machine-stage lengths and fix-round lengths, from the same spans the open lanes' elapsed time comes
 * from (INV-104-1). A stage's minutes are the sum of every span it had (the plan returns after a send-back); a fix
 * round's minutes are the sum of the spans of that round, so a question gate inside the round leaves no time in it.
 */
export function laneDurations(events: LifecycleRecord[], ctx: StageSplitContext = {}, now?: number): LaneDurations {
  const spans = stageSpans(events, ctx, now);
  const stages: Partial<Record<StageKey, number>> = {};
  const fixRounds: number[] = [];
  for (const span of spans) {
    if (span.kind !== "stage") continue;
    const minutes = minutesBetween(span.from, span.to);
    if (span.stage === "fix") {
      const round = Math.max(1, span.fixRound ?? 1);
      fixRounds[round - 1] = (fixRounds[round - 1] ?? 0) + minutes;
    } else {
      stages[span.stage] = (stages[span.stage] ?? 0) + minutes;
    }
  }
  const last = spans[spans.length - 1];
  return {
    stages,
    fixRounds: fixRounds.map((m) => m ?? 0),
    point: last ? spanPoint(last) : { kind: "stage", stage: "plan" },
    since: last?.from ?? events[0]?.at ?? "",
  };
}

/** the classification of a span, without its times */
export function spanPoint(span: StageSpan): StagePoint {
  if (span.kind === "stage") return span.fixRound === undefined ? { kind: "stage", stage: span.stage } : { kind: "stage", stage: span.stage, fixRound: span.fixRound };
  if (span.kind === "gate") return { kind: "gate", gate: span.gate };
  if (span.kind === "wait") return { kind: "wait", wait: span.wait };
  return { kind: "closed" };
}

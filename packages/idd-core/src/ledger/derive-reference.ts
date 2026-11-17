import type { LifecycleRecord } from "../schema/records.ts";
import type { LaneGroup, DecisionKind, PlanReviewPhase } from "./derive.ts";
import { lastReturnToPlan, replanView } from "./replan-view.ts";
import { reviewLoopLabel, reviewLoopState, isLoopLane } from "./review-loop-reference.ts";

/**
 * The stage derivation as it stood in TypeScript before the MoonBit derivation replaced it. It is not on the
 * running path: the cross-check (`packages/idd-fold/crosscheck.mjs`) holds it against the MoonBit answer on every
 * prefix of a real ledger and on the committed fixtures, and the gate's fixture test holds both against each
 * other (C-186-4). The quota overlay is not part of it: the floor is the record's own answer, before the
 * runtime's wait is put on top (C-191-1).
 */

/** Events that note something on a lane without moving it. */
export const LANE_NOTE_EVENTS: readonly string[] = "s1_base_advanced lane_stall_instructed lane_wait_notified lane_start_skipped fix_plan_started fix_plan_done s2_executor_wait_ended s2_shape_started s2_shape_judged".split(" ");

export function withoutNotes<T extends { event: string }>(events: T[]): T[] {
  return events.some((e) => LANE_NOTE_EVENTS.includes(e.event)) ? events.filter((e) => !LANE_NOTE_EVENTS.includes(e.event)) : events;
}

export const PLANNER_REVISING = "査読の指摘を反映中";
export const PLANNER_SENT_BACK = "penne の指示を反映中";

function idx(events: LifecycleRecord[], name: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return i;
  return -1;
}

/** The reviews one lane start, or one send-back by penne, may run on its own: the first, and one more to check the planner's fix. */
const PLAN_REVIEW_ROUNDS = 2;

/** Where a lane stands in the plan review, from its lifecycle alone. */
export function planReviewPhase(events: LifecycleRecord[]): PlanReviewPhase {
  const ready = idx(events, "s1_ready");
  if (ready < 0 || idx(events, "s1_go") >= 0) return { phase: "none" };
  // a return to the plan sends the plan back the way penne's revise does (`plan_review_phase` in stage.mbt)
  const sentBack = Math.max(idx(events, "s1_revise_requested"), lastReturnToPlan(events));
  if (sentBack > ready) return { phase: "sent_back" };
  const after = (i: number) => (i > sentBack ? i : -1);
  const started = after(idx(events, "s1_plan_review_started"));
  const done = after(idx(events, "s1_plan_review_done"));
  const skipped = after(idx(events, "s1_plan_review_skipped"));
  const actionableOf = (attrs: Record<string, unknown>): number => {
    if (Boolean(attrs.failed)) return 0;
    const sentBackAttr = typeof attrs.sent_back === "boolean" ? attrs.sent_back : null;
    return sentBackAttr === false ? 0 : Number(attrs.must ?? 0) + (sentBackAttr === null ? Number(attrs.should ?? 0) : 0);
  };
  const roundsRun = events.slice(sentBack + 1).filter((e) => e.event === "s1_plan_review_started").length;
  // a review nobody declared cannot be asked again, so a skip after a must stands as the review's end: the card opens
  // and the GO needs a reason (the must stays unconfirmed). Only a round started after the skip is a review to wait
  // for, running
  const fixAwaitsRound = done >= 0 && ready > done && actionableOf(events[done].attrs ?? {}) > 0 && started > skipped;
  if (skipped >= 0 && skipped > done && !fixAwaitsRound) return { phase: "reviewed", failed: false, actionable: 0 };
  if (started > done) {
    const a = events[started].attrs ?? {};
    const runIds = Array.isArray(a.run_ids) ? a.run_ids.map(String).filter(Boolean) : a.run_id ? [String(a.run_id)] : [];
    return { phase: "running", runIds };
  }
  if (done < 0) return { phase: "waiting" };
  const attrs = events[done].attrs ?? {};
  const failed = Boolean(attrs.failed);
  const actionable = actionableOf(attrs);
  if (actionable > 0 && ready < done) return { phase: "revising" };
  // the planner fixed what the review sent back: the fix is reviewed before GO, until the rounds are spent
  if (actionable > 0 && roundsRun < PLAN_REVIEW_ROUNDS) return { phase: "waiting" };
  return { phase: "reviewed", failed, actionable };
}

/** whether the lane stands on an unanswered split / merge proposal (the record-only reading of granularity.ts) */
export function granularityWaiting(events: { event: string; attrs?: Record<string, unknown> }[]): boolean {
  const proposal = granularityProposalOf(events);
  if (!proposal || proposal.kind === "single") return false;
  return granularityAnswerOf(events) === null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type GranularityProposal = { kind: "single" | "split" | "merge"; reason: string };

function proposalFrom(attrs: Record<string, unknown>): GranularityProposal | null {
  const kind = text(attrs.kind);
  if (kind !== "single" && kind !== "split" && kind !== "merge") return null;
  if (!text(attrs.reason)) return null;
  if (kind === "merge") {
    const target = attrs.merge_target ?? attrs.mergeTarget;
    const ref = text(target && typeof target === "object" && !Array.isArray(target) ? (target as Record<string, unknown>).ref : target);
    return ref ? { kind, reason: text(attrs.reason) } : null;
  }
  if (kind === "split") {
    if (!Array.isArray(attrs.children) || attrs.children.length === 0) return null;
    for (const raw of attrs.children) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      const c = raw as Record<string, unknown>;
      const title = text(c.title);
      const whole = text(c.whole);
      const places = Array.isArray(c.places) ? c.places.map(text).filter(Boolean) : [];
      if (!title || !whole || !places.length) return null;
    }
    return { kind, reason: text(attrs.reason) };
  }
  return { kind, reason: text(attrs.reason) };
}

function granularityProposalOf(events: { event: string; attrs?: Record<string, unknown> }[]): GranularityProposal | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event !== "s1_granularity_proposed") continue;
    return proposalFrom(events[i].attrs ?? {});
  }
  return null;
}

function granularityAnswerOf(events: { event: string; attrs?: Record<string, unknown> }[]): { decision: string } | null {
  let proposed = -1;
  for (let i = 0; i < events.length; i += 1) if (events[i].event === "s1_granularity_proposed") proposed = i;
  if (proposed < 0) return null;
  for (let i = events.length - 1; i > proposed; i -= 1) {
    if (events[i].event !== "s1_granularity_answered") continue;
    const decision = text(events[i].attrs?.decision);
    if (decision !== "approve" && decision !== "single" && decision !== "revise") continue;
    return { decision };
  }
  return null;
}

/** a lane's budget: the default, or what penne raised it to last */
export function laneBudget(events: LifecycleRecord[], base: number): number {
  const raised = [...events].reverse().find((e) => e.event === "lane_budget_extended")?.attrs?.limit;
  return typeof raised === "number" && raised > 0 ? raised : base;
}

/**
 * A lane that only waits, on its PR or (merged) on the import, starts no work that spends, so its budget is not
 * judged. Answering the PR's feedback is work again. Read from the lane's progress, leaving any budget stop aside.
 */
export function laneBudgetIdle(events: LifecycleRecord[]): boolean {
  const d = deriveStageReference(events.filter((e) => e.event !== "lane_over_budget"));
  return d.group === "waiting" && d.stageDone === 5;
}

/**
 * A lane stopped for its spend and not given more budget since. A stop recorded while the lane only waited, or on
 * a lane that has come to only wait (its PR merged meanwhile), does not hold it.
 */
export function laneOverBudget(events: LifecycleRecord[]): { cost: number; limit: number } | null {
  const names = events.map((e) => e.event);
  const at = names.lastIndexOf("lane_over_budget");
  if (at < 0 || at < names.lastIndexOf("lane_budget_extended")) return null;
  if (laneBudgetIdle(events) || laneBudgetIdle(events.slice(0, at))) return null;
  const a = events[at].attrs ?? {};
  return { cost: Number(a.cost ?? 0), limit: Number(a.limit ?? 0) };
}

/** a lane held for penne (over its budget, its agent stopped, or the engine found it stuck): no stage starts more work for it */
export function laneHeld(events: LifecycleRecord[]): boolean {
  return laneOverBudget(events) !== null || laneStall(events) !== null || laneHalt(events) !== null;
}

/**
 * The last halt the stall watch recorded for the lane, or null: a lane the engine found stuck and left for penne.
 * A result, a rejection, a re-ready or penne's resume clears it; a later halt is a new stop.
 */
export function laneHalt(events: LifecycleRecord[]): { stage: string; since: string; lastEvent: { event: string; at: string }; reason: string; causes: string[]; canSendBack: boolean } | null {
  const names = events.map((e) => e.event);
  const at = names.lastIndexOf("lane_stall_detected");
  if (at < 0) return null;
  const since = Math.max(...["lane_stall_resumed", "s4_verify_user_judgment_answered", "s3_reject", "s2_result", "s1_ready", "s1_revise_requested"].map((n) => names.lastIndexOf(n)));
  if (at < since) return null;
  const a = events[at].attrs ?? {};
  const last = a.last_event && typeof a.last_event === "object" ? (a.last_event as { event?: unknown; at?: unknown }) : {};
  return {
    stage: String(a.stage ?? ""),
    since: String(a.since ?? events[at].at),
    lastEvent: { event: String(last.event ?? ""), at: String(last.at ?? events[at].at) },
    reason: String(a.reason ?? ""),
    causes: Array.isArray(a.causes) ? a.causes.map(String) : [],
    canSendBack: Boolean(a.can_send_back),
  };
}

/** an executor / planner session that stopped without answering and was not resumed since */
export function laneStall(events: LifecycleRecord[]): { role: string; cause: string; reason: string } | null {
  const names = events.map((e) => e.event);
  const at = names.lastIndexOf("lane_stalled");
  if (at < 0) return null;
  const since = Math.max(...["s2_result", "s1_ready", "question_batch_asked", "lane_stall_resumed"].map((n) => names.lastIndexOf(n)));
  if (at < since) return null;
  const a = events[at].attrs ?? {};
  return { role: String(a.role ?? "agent"), cause: String(a.cause ?? ""), reason: String(a.reason ?? "") };
}

export type Stage = {
  group: LaneGroup;
  stageDone: number;
  stageCurrent: number | null;
  blockedBy?: string;
  decision?: DecisionKind;
};

/** The record-only stage: the answer before the runtime's quota wait is put on top. */
export function deriveStageReference(all: LifecycleRecord[]): Stage {
  return progressOf(withoutNotes(replanView(all)));
}

/** the events after which the planner owes a question batch or a ready */
export const PLANNER_WORK = ["lane_open", "s0_requeue_go", "s1_plan_review_done", "s1_revise_requested"];

/** the index of the oldest batch asked after `since` that penne has not answered, or -1 */
export function oldestUnansweredReference(events: LifecycleRecord[], since = -1): number {
  for (let i = Math.max(0, since + 1); i < events.length; i += 1) {
    if (events[i].event !== "question_batch_asked") continue;
    const asked = events[i].attrs?.batch_id;
    let answered = false;
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[j].event === "question_batch_answered" && (asked === undefined || events[j].attrs?.batch_id === asked)) {
        answered = true;
        break;
      }
    }
    if (!answered) return i;
  }
  return -1;
}

function progressOf(events: LifecycleRecord[]): Stage {
  const names = events.map((e) => e.event);
  const last = names[names.length - 1] ?? "";
  const has = (n: string) => names.includes(n);
  const lastOf = (n: string) => [...events].reverse().find((e) => e.event === n);

  if (has("lane_close")) return { group: "closed", stageDone: 5, stageCurrent: null };
  if (has("s1_defer") || has("s3_defer")) return { group: "closed", stageDone: 2, stageCurrent: null };
  // an Issue taken in again after its lane was closed waits for penne before the planner spends anything
  const requeuedFrom = events.find((e) => e.event === "lane_open")?.attrs?.requeued_from;
  const over = laneOverBudget(events);
  if (over) {
    const stage = has("s2_start") ? 2 : 1;
    return { group: "judge", stageDone: stage, stageCurrent: stage, decision: "stuck", blockedBy: `費用が予算を超えた（$${over.cost.toFixed(2)} / $${over.limit.toFixed(2)}）` };
  }
  const stall = laneStall(events);
  if (stall) {
    const stage = has("s2_start") ? 2 : 1;
    return { group: "judge", stageDone: stage, stageCurrent: stage, decision: "stuck", blockedBy: `${stall.role} が止まった: ${stall.reason}` };
  }
  const halt = laneHalt(events);
  if (halt) {
    const stage = has("s2_start") ? 2 : 1;
    return { group: "judge", stageDone: stage, stageCurrent: stage, decision: "stuck", blockedBy: `engine が進められない: ${halt.reason}` };
  }
  if (requeuedFrom && !has("s0_requeue_go")) return { group: "judge", stageDone: 0, stageCurrent: 0, decision: "requeue", blockedBy: `${String(requeuedFrom)} の取り込み直し` };
  const latest = (n: string) => names.lastIndexOf(n);
  if (latest("s4_merged") > Math.max(latest("s4_submit_started"), latest("s2_result"))) return { group: "waiting", stageDone: 5, stageCurrent: 5, blockedBy: "本流の受け入れ・記録回収" };
  if (latest("s4_verify_user_judgment_answered") > Math.max(latest("s2_result"), latest("s4_submit_started"))) return { group: "impl", stageDone: 2, stageCurrent: 2 };
  // the S2 review loop comes first: a lane sent back from S4 re-enters it, whatever S3 / S4 recorded before
  if (has("s2_start")) {
    const loop = reviewLoopState(events);
    if (loop.state === "escalated") return { group: "judge", stageDone: 2, stageCurrent: 2, decision: "stuck", blockedBy: loop.reason };
    // penne took the code: the lane waits on a person's turn, with the card that says what is left (DEC-113-11)
    if (loop.state === "awaiting_hand_fix") return { group: "judge", stageDone: 2, stageCurrent: 2, decision: "stuck", blockedBy: "人の手番（自分で直す）" };
    // a lane waiting for the lanes ahead of it before its first review does no work: it is not an executor's lane
    if (loop.state === "awaiting_order") return { group: "waiting", stageDone: 2, stageCurrent: 2, blockedBy: reviewLoopLabel(loop) };
    if (loop.state !== "idle" && loop.state !== "done") return { group: "impl", stageDone: 2, stageCurrent: 2, ...(reviewLoopLabel(loop) ? { blockedBy: reviewLoopLabel(loop) } : {}) };
  }
  // a loop lane goes through S3 without a card: R2, then the submit card
  if (isLoopLane(events) && latest("s3_ready") > Math.max(latest("s3_ok"), latest("s4_submit_started"))) {
    const r2 = latest("s3_r2_started") > latest("s3_ready") && Math.max(latest("s3_r2_done"), latest("s3_r2_skipped")) < latest("s3_r2_started");
    return { group: "impl", stageDone: 3, stageCurrent: 3, blockedBy: r2 ? "R2 中" : "提出の準備中" };
  }
  // for a loop lane new work only comes from a send-back or a fix of the PR's feedback, so a stray result does not end the PR wait
  const newWork = isLoopLane(events) ? Math.max(latest("s4_verify_user_judgment_answered"), latest("s2_fix_sent")) : latest("s2_result");
  if (has("s4_pr_created") && latest("s4_pr_created") > Math.max(latest("s4_submit_started"), latest("s4_ship_failed"), newWork, latest("s3_ready"))) {
    const pr = lastOf("s4_pr_created")?.attrs?.pr_number;
    return { group: "waiting", stageDone: 5, stageCurrent: null, blockedBy: pr ? `PR #${pr}` : "PR" };
  }
  if (last === "blocked_by_dependency") {
    const dep = lastOf("blocked_by_dependency")?.attrs?.depends_on;
    return { group: "waiting", stageDone: 2, stageCurrent: 2, blockedBy: Array.isArray(dep) ? String(dep[0]) : undefined };
  }
  if (latest("s3_ready") > latest("s4_submit_started") && latest("s3_ok") < latest("s3_ready")) return { group: "judge", stageDone: 3, stageCurrent: 3, decision: "review" };
  // the submit card belongs to the S3 it was opened after: new work since then (a fix of the PR's feedback, a
  // send-back) goes through S3 and R2 again, and the next S3 opens a submit of its own. Until then the tick
  // must not push it
  if (has("s4_submit_started") && latest("s4_submit_started") > Math.max(latest("s2_result"), latest("s2_fix_sent"), latest("s3_ready"))) {
    return { group: "judge", stageDone: 4, stageCurrent: 4, decision: "ship" };
  }
  if (has("s3_ready")) {
    if (!has("s3_ok")) return { group: "judge", stageDone: 3, stageCurrent: 3, decision: "review" };
    return { group: "impl", stageDone: 4, stageCurrent: 4 };
  }
  if (has("s2_start")) {
    const loop = reviewLoopState(events);
    if (loop.state === "escalated") return { group: "judge", stageDone: 2, stageCurrent: 2, decision: "stuck", blockedBy: loop.reason };
    if (loop.state === "awaiting_hand_fix") return { group: "judge", stageDone: 2, stageCurrent: 2, decision: "stuck", blockedBy: "人の手番（自分で直す）" };
    return { group: "impl", stageDone: 2, stageCurrent: 2, ...(reviewLoopLabel(loop) ? { blockedBy: reviewLoopLabel(loop) } : {}) };
  }
  if (has("s1_go")) return { group: "impl", stageDone: 2, stageCurrent: 2 };
  // the lane waits on a person's answer to its split / merge proposal before it writes the request: it is a person's
  // decision however shallow the lane is (C-127-4), so no automatic GO and no watch wake may pass it
  if (granularityWaiting(events)) return { group: "judge", stageDone: 1, stageCurrent: 1, decision: "granularity" };
  if (has("s1_ready")) {
    const review = planReviewPhase(events);
    if (review.phase === "waiting") return { group: "prep", stageDone: 1, stageCurrent: 1, blockedBy: "plan 査読待ち" };
    if (review.phase === "running") return { group: "prep", stageDone: 1, stageCurrent: 1, blockedBy: "plan 査読中" };
    if (review.phase === "revising") return { group: "prep", stageDone: 1, stageCurrent: 1, blockedBy: PLANNER_REVISING };
    if (review.phase === "sent_back") return { group: "prep", stageDone: 1, stageCurrent: 1, blockedBy: PLANNER_SENT_BACK };
    return { group: "judge", stageDone: 2, stageCurrent: null, decision: "go" };
  }
  // the question gate is open while a batch asked since the planner was last handed work has no answer (C-274-1)
  const plannerWork = Math.max(...PLANNER_WORK.map((n) => names.lastIndexOf(n)), lastReturnToPlan(events));
  if (oldestUnansweredReference(events, plannerWork) >= 0) return { group: "judge", stageDone: 1, stageCurrent: 1, decision: "question" };
  if (has("lane_open")) return { group: "prep", stageDone: 1, stageCurrent: 1 };
  return { group: "prep", stageDone: 0, stageCurrent: 0 };
}


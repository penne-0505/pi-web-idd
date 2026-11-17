import type { LifecycleRecord } from "../schema/records.ts";
import { reviewLaneLabel, reviewLaneState, type ReviewLaneRecord } from "../review-lane/state.ts";
import { withoutNotes } from "./derive.ts";
import { returnsToPlan } from "./replan-view.ts";
import { MERGE_ONLY_SKIP_EVENT } from "./review-loop.ts";

/**
 * One stretch of a lane at one stage. A lane's lifecycle is cut into spans for the timing chart: the stage's key
 * and name, when it began, when it ended, and whose time it is (a machine's work or a person's turn). A span still
 * running has no end; a closed lane has none open.
 */
export type SpanOwner = "machine" | "person";

export interface StageSpan {
  /** a stable key of the stage; the display names of one key never change between reads */
  key: string;
  /** the stage's name as the timing chart shows it */
  label: string;
  start: string;
  /** absent while the span is still running: the lane's last stage, with the lane still open */
  end?: string;
  owner: SpanOwner;
}

type Stage = { key: string; label: string; owner: SpanOwner };

const MACHINE = "machine" as const;
const PERSON = "person" as const;

const PLAN: Stage = { key: "plan", label: "計画", owner: MACHINE };
const QUESTION: Stage = { key: "question", label: "質問待ち", owner: PERSON };
const PLAN_REVIEW: Stage = { key: "plan_review", label: "計画の査読", owner: MACHINE };
const GO: Stage = { key: "go", label: "GO 待ち", owner: PERSON };
const IMPL: Stage = { key: "impl", label: "実装", owner: MACHINE };
const REVIEW_ROUND: Stage = { key: "review_round", label: "レビューの巡", owner: MACHINE };
// a lane whose fix budget ran out and penne took the code: a person's turn, not the engine's
const HAND_FIX: Stage = { key: "hand_fix", label: "人の手番（自分で直す）", owner: PERSON };
const CHECKS: Stage = { key: "checks", label: "検査", owner: MACHINE };
const SIGN: Stage = { key: "sign", label: "署名待ち", owner: PERSON };
const MERGE: Stage = { key: "merge", label: "merge", owner: MACHINE };

/**
 * The stage an event moves the lane into, or null when the event says nothing about the stage. Notes the engine
 * writes on a lane without moving it are already dropped before this is read. An event that is not here leaves
 * the lane where it was: an unknown record must not open a stage of its own.
 */
const ENTER: Record<string, Stage> = {
  lane_open: PLAN,
  s0_requeue_go: PLAN,
  s1_prep_start: PLAN,
  question_batch_asked: QUESTION,
  question_batch_answered: PLAN,
  s1_plan_review_started: PLAN_REVIEW,
  s1_plan_review_done: PLAN,
  s1_plan_review_skipped: PLAN,
  s1_revise_requested: PLAN,
  s1_replan_requested: PLAN,
  s1_revise: PLAN,
  s1_rethink: PLAN,
  s1_recovery_attempt: PLAN,
  s1_ready: GO,
  s1_go: IMPL,
  s2_start: IMPL,
  s2_fix_sent: IMPL,
  s2_resume: IMPL,
  s2_retry: IMPL,
  s2_recovery_attempt: IMPL,
  s3_reject: IMPL,
  s4_revise: IMPL,
  s4_verify_user_judgment_answered: IMPL,
  s2_result: REVIEW_ROUND,
  s2_review_started: REVIEW_ROUND,
  s2_triage_started: REVIEW_ROUND,
  s2_triage_done: REVIEW_ROUND,
  s2_confirm_started: REVIEW_ROUND,
  s2_confirm_done: REVIEW_ROUND,
  s2_review_resumed: REVIEW_ROUND,
  s2_review_findings: REVIEW_ROUND,
  s2_map_started: REVIEW_ROUND,
  s2_map_done: REVIEW_ROUND,
  s2_device_started: REVIEW_ROUND,
  s2_device_done: REVIEW_ROUND,
  // the repo's required checks before the loop converges: the checks stage begins there, and a failure the lane made
  // goes back to the fix (IMPL) as any fix does
  s2_checks_started: CHECKS,
  s2_checks_done: CHECKS,
  s2_review_converged: CHECKS,
  // the round read nothing (the head was only the mainline merged in): the lane is on its way to S3, as after a convergence
  [MERGE_ONLY_SKIP_EVENT]: CHECKS,
  s3_ready: CHECKS,
  // R2 ran here until it was removed (2026-10-22); a lane's past R2 events still read as this stage
  s3_r2_started: CHECKS,
  s3_r2_done: CHECKS,
  s3_r2_skipped: CHECKS,
  s3_check_in_progress: CHECKS,
  s3_check_clean: CHECKS,
  s3_mechanical_resolve: CHECKS,
  s4_submit_started: CHECKS,
  s4_prepare: CHECKS,
  s4_land_check_failed: CHECKS,
  s3_ok: SIGN,
  s4_push_approved: MERGE,
  s4_land_approved: MERGE,
  s4_pushed: MERGE,
  s4_change_pushed: MERGE,
};

/** events that end the lane's machine work: the span closes and no new one opens, so the wait that follows is a gap */
const STOPS = new Set([
  "lane_close", "s1_defer", "s3_defer", "lane_abort", "lane_drop",
  "s4_merged", "s4_land_merged", "s4_local_completed", "s4_pr_created",
]);

/**
 * The stage spans of one Issue lane, read from its lifecycle alone: the lane's records, notes the engine wrote
 * without moving it dropped. The events are walked in order; a mapped event ends the span before it and opens its
 * own stage, an event with a stage already open and the same key only extends it, and an event that ends the lane
 * closes the span. Spans therefore run in time order and never overlap, and at most the last one is open.
 */
export function laneStageSpans(events: LifecycleRecord[]): StageSpan[] {
  return spansOf(withoutNotes(events), (e) => {
    if (STOPS.has(e.event)) return null;
    // penne's hand turn: the answer that takes the code opens a person's span; "直した" hands it back
    if (e.event === "s2_review_resumed" && e.attrs?.decision === "hand_fix") return HAND_FIX;
    if (e.event === "s2_hand_fixed") return IMPL;
    // a rejection that sends the lane back to its plan opens the plan's stage again; `ENTER` holds the one that goes back to the implementation
    if (e.event === "s3_reject" && returnsToPlan(e)) return PLAN;
    return ENTER[e.event] ?? undefined;
  });
}

/**
 * The stage spans of a review lane (someone else's PR). Its records are shaped differently, so its own reader maps
 * them: the lane running its map / blind / triage / confirm is a machine's time, the draft waiting for penne's
 * approval is a person's, and waiting for the author is neither (a gap). A lane whose history the reader cannot
 * cut finer than its whole length reads as one span: the state machine only cuts where a record changes it.
 */
export function reviewLaneStageSpans(rec: ReviewLaneRecord): StageSpan[] {
  return spansOf(rec.history, (e, prefix) => {
    if (e.event === "r_closed") return null;
    const st = reviewLaneState({ ...rec, history: prefix } as ReviewLaneRecord);
    if (st.state === "closed" || st.state === "awaiting_author") return null;
    if (st.state === "awaiting_penne") return { key: "pr_review_penne", label: "投稿カードの確認待ち", owner: PERSON };
    if (st.state === "stuck") return { key: "pr_review_stuck", label: "要判断", owner: MACHINE };
    return { key: "pr_review", label: reviewLaneLabel(st), owner: MACHINE };
  });
}

/** walk a record in order, cutting it into spans; a null stage ends the span before it without opening one */
function spansOf<T extends { event: string; at: string }>(records: T[], stageOf: (record: T, prefix: T[]) => Stage | null | undefined): StageSpan[] {
  const spans: StageSpan[] = [];
  let open: Stage & { start: string } | null = null;
  const close = (end: string): void => {
    if (!open) return;
    if (open.start !== end) spans.push({ key: open.key, label: open.label, start: open.start, end, owner: open.owner });
    open = null;
  };
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const next = stageOf(rec, records.slice(0, i + 1));
    // undefined says the event says nothing about the stage; null says it ends the lane's work
    if (next === undefined) continue;
    if (next === null) { close(rec.at); continue; }
    if (open && open.key === next.key) continue;
    close(rec.at);
    open = { ...next, start: rec.at };
  }
  if (open) spans.push({ key: open.key, label: open.label, start: open.start, owner: open.owner });
  return spans;
}

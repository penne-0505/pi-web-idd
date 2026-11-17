import { returnsToPlan } from "./replan-view.ts";

/** events that hand the executor work it must answer with a result */
export const EXECUTOR_WORK = ["s2_start", "s2_fix_sent", "s4_verify_user_judgment_answered", "s3_reject", "s2_review_base_instructed", "s2_records_instructed"];

type WorkRow = { event: string; attrs?: Record<string, unknown> | undefined };

/**
 * Whether a row hands the executor work it must answer with a result. A rejection is the executor's only when it
 * sends the lane back to its implementation: one that sends it back to its plan hands the work to the planner.
 */
export function isExecutorWork(row: WorkRow): boolean {
  return EXECUTOR_WORK.includes(row.event) && !(row.event === "s3_reject" && returnsToPlan(row));
}

/**
 * Whether the executor still owes the lane a result: the last work it was handed is after the last result it gave.
 * The write side asks it before it hands the lane to the planner, so the planner and the executor never write in
 * the lane's worktree at the same time.
 */
export function executorOwesResult(rows: readonly WorkRow[]): boolean {
  return rows.findLastIndex(isExecutorWork) > rows.findLastIndex((e) => e.event === "s2_result");
}

/** a lifecycle row as the readings of a return to the plan see it: its event and the fields of `attrs` they decide with */
interface PlanReturnRow {
  event: string;
  attrs?: Record<string, unknown> | undefined;
}

/**
 * Whether a row sends the lane back to its plan: the card's "計画から考え直す" (`s1_replan_requested`), or a rejection
 * at the review that records the plan as where it goes (`s3_reject` with `next_stage` `s1_rethink`). A rejection that
 * names no place, or any other, sends the lane back to its implementation. The MoonBit fold reads the same rows the
 * same way (`returns_to_plan` in `packages/idd-fold/lifecycle.mbt`); a TypeScript reading that looks for a return to
 * the plan itself asks this, not the event's name.
 */
export function returnsToPlan(row: PlanReturnRow): boolean {
  return row.event === "s1_replan_requested" || (row.event === "s3_reject" && row.attrs?.next_stage === "s1_rethink");
}

/** the index of the last row that sends the lane back to its plan, or -1 */
export function lastReturnToPlan(rows: readonly PlanReturnRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (returnsToPlan(rows[i]!)) return i;
  return -1;
}

/**
 * One lane's records as the readings of "has this ever run" see them after the lane went back to its plan (the
 * card's "計画から考え直す", or "方針へ戻す" at the review): the records from the lane's first `s1_go` up to its last
 * return to the plan (`returnsToPlan`) are left out, so the GO, the executor's start and the loop's rounds start
 * again. The MoonBit fold reads the same view for every answer it gives (`replan_view` in
 * `packages/idd-fold/api.mbt`); a TypeScript reading that looks for an event itself reads the lane through this. A
 * `lane_budget_extended` in that era is kept. The ledger is not changed.
 *
 * This is a plain filter that reads no MoonBit answer, so `derive.ts` and the stage reference (`derive-reference.ts`)
 * both read it from here: the reference still stands on its own, and cannot check the fold against the fold.
 */
export function replanView<T extends PlanReturnRow>(events: T[]): T[] {
  const kept = replanKeptIndexes(events);
  return kept.length === events.length ? events : kept.map((i) => events[i]!);
}

/**
 * The role of the session that holds a lane's work now: the executor once the lane's implementation has started in
 * the view (`replanView`), the planner before it. After the lane went back to its plan the executor's `s2_start` is
 * out of the view, so the planner is the one a wait for the plan reaches, whatever sessions are on record. The
 * MoonBit fold's `awaited_agent` reads the same view for the role it waits on, so the wait, the turn and the session
 * the watch wakes are one answer.
 */
export function laneSessionRole(events: readonly PlanReturnRow[]): "planner" | "executor" {
  return replanView([...events]).some((e) => e.event === "s2_start") ? "executor" : "planner";
}

/**
 * The places (in the caller's rows) of the rows `replanView` keeps, in order: every place when the lane did not go
 * back to its plan. A reading that answers over the view and hands an index back counts in the caller's rows, so it
 * carries the view's index across with this (`index_reading` and `ledger_index` in `packages/idd-fold/api.mbt` do the
 * same on the MoonBit side). `replanView` is built on it, so the boundary is defined once.
 */
export function replanKeptIndexes(events: readonly PlanReturnRow[]): number[] {
  const all = events.map((_, i) => i);
  const replan = lastReturnToPlan(events);
  const go = events.findIndex((e) => e.event === "s1_go");
  if (replan < 0 || go < 0 || go >= replan) return all;
  // a raised budget stays: the limit the lane was given holds after it came back to its plan
  return all.filter((i) => i < go || i >= replan || events[i]!.event === "lane_budget_extended");
}

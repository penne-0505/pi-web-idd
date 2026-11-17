/**
 * Which shape a lane's intent records take. The harness decides it when it hands the planner its brief, and
 * writes it down so no reader has to guess from the presence of a file: a v2 planner that happened to leave a
 * decision.md behind must still be read from the state, or its Choices would go silently unread.
 *
 * `docs` is the old shape (decision.md, the qa's Rounds, the Intent Delta). `state` is the shape this change
 * introduces: the planner's Choices ride on the plan report and are written to the state's column, the executor
 * writes them through the intent door, and the readers take them from the state.
 */
import type { LifecycleRecord } from "../schema/records.ts";
import { readLifecycle, readSessions } from "../ledger/read.ts";

export type RecordShape = "docs" | "state";

/** the value the planner session and the ready carry for the state shape */
export const RECORDS_SHAPE_STATE = "state";

/** the shape as the lifecycle alone tells it: the last ready's mark, else the old shape */
export function recordShapeOfEvents(events: { event: string; attrs?: Record<string, unknown> }[]): RecordShape {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event !== "s1_ready") continue;
    return events[i].attrs?.records_shape === RECORDS_SHAPE_STATE ? "state" : "docs";
  }
  return "docs";
}

/**
 * The lane's shape, read from the ready first and the planner's session second. The ready carries it because
 * readers that only see lifecycle events (the submit review) need it; the session carries it because a lane that
 * has not re-ported yet (a ready from before the mark existed) still knows which shape it was planned under.
 */
export function laneRecordShape(iddId: string, events?: LifecycleRecord[]): RecordShape {
  const evs = events ?? readLifecycle().filter((e) => e.idd_id === iddId);
  const fromEvents = recordShapeOfEvents(evs);
  if (fromEvents === "state") return "state";
  const session = readSessions("planner").filter((s) => s.idd_id === iddId).pop();
  return session?.records_shape === RECORDS_SHAPE_STATE ? "state" : "docs";
}

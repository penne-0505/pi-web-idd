import type { LifecycleRecord } from "../schema/records.ts";
import { acStatesForLane, criterionKey, isVerified, readWorkRows, workColumnPath } from "../plan/work-records.ts";
import { readBacklog, readLifecycle } from "./read.ts";

/** a criterion's state as the lane's own reports last stated it: confirmed, running, or nothing said about it */
export type CriterionReportState = "verified" | "in_progress" | "other";

/** what the lane's own reports say about its acceptance criteria, read through one fold */
export interface LaneCriteria {
  /** whether the reports last confirmed the criterion; the id is read by its number, so `AC-01` and `AC-001` agree */
  has(id: string): boolean;
  /** the criterion's state, or `other` when no report named it */
  stateOf(id: string): CriterionReportState;
  /** every confirmed criterion, in the canonical form the reports were folded to */
  verifiedIds(): string[];
}

/**
 * The key two reports name the same criterion by. Kept re-exported here for the callers that read it by this path;
 * the implementation lives with the states it folds (see `work-records.ts`).
 */
export { criterionKey };

/**
 * What the lane's own reports say about its acceptance criteria, read through the one fold in
 * `acStatesForLane`: the work column when the lane has one, otherwise its `s2_result` records and the progress
 * note. It stays the reading the card, the lane detail, the submit check and the closing record call, so the same
 * lane's confirmed set is the same everywhere (DEC-105-1, DEC-109-2). A criterion named in progress but never
 * confirmed reads as `in_progress`; one no report named is `other`.
 *
 * The events are the lane's own, oldest first, as `readLifecycle` returns them. Pass them when the caller already
 * holds them; otherwise the lane's are read from the lifecycle.
 */
export function laneCriteria(iddId: string, events?: LifecycleRecord[]): LaneCriteria {
  const evs = events ?? readLifecycle();
  const area = readBacklog().find((r) => r.idd_id === iddId)?.area;
  const rows = area ? readWorkRows(workColumnPath(area)) : [];
  const byKey = new Map(acStatesForLane({ lane: iddId, rows, events: evs }).map((s) => [criterionKey(s.id), s]));
  const stateOf = (id: string): CriterionReportState => {
    const state = byKey.get(criterionKey(id));
    if (!state) return "other";
    if (isVerified(state)) return "verified";
    return state.status === "covered" ? "in_progress" : "other";
  };
  return {
    has: (id) => stateOf(id) === "verified",
    stateOf,
    verifiedIds: () => [...byKey.values()].filter(isVerified).map((s) => criterionKey(s.id)),
  };
}

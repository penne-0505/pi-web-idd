import type { LifecycleRecord } from "../schema/records.ts";
import { MERGE_ONLY_SKIP_EVENT } from "./review-loop.ts";

/**
 * The record a review round's start writes when the executor took the mainline in after the lane's first review: the
 * origin moves past the mainline commit the head carries. A name of its own, because `s2_review_base_merged` is the
 * merge before the first review, and the screen reads it as that (DEC-2212).
 */
export const ORIGIN_CAUGHT_UP_EVENT ="s2_review_base_advanced";

/**
 * The commit the S2 review diffs the lane's head against: where S2 first started (the lane's first `s2_start`, read
 * from the rows as they are, not through the view of a return to the plan: a lane sent back to its plan keeps the
 * changes of its earlier implementation in what reaches the mainline, so they are in the review's diff and in the
 * `risk_paths` check), moved on by each base received
 * since (that start with the base's new work merged in), by each mainline merge the harness took in before the
 * lane's first review (`s2_review_base_merged`), and by each mainline merge a review round took in after a conflict
 * (`s2_review_started` attr `review_base`, built the same way), so none of them is reviewed as the lane's.
 * by each mainline commit the executor took in between rounds (`s2_review_base_advanced`, written as a round starts),
 * so a merge the executor made after the first review is no more the lane's change than one before it.
 * A round skipped because the head was only the mainline merged in moves it the same way: the merge brought nothing
 * the lane wrote, so what came before it is the lane's change and what came with it is not.
 * A mainline merge taken in after the lane went back to its plan moves it like any other, and one taken in during
 * the first implementation stays in the origin, so another's change is the lane's in neither cycle.
 * Empty when S2 has not started.
 */
export function reviewBaseOf(events: LifecycleRecord[]): string {
  const start = events.findIndex((e) => e.event === "s2_start");
  if (start < 0) return "";
  for (let i = events.length - 1; i > start; i -= 1) {
    const e = events[i];
    const base = e.event === "lane_base_received" || e.event === "s2_review_started" || e.event === "s2_review_base_merged" || e.event === ORIGIN_CAUGHT_UP_EVENT || e.event === MERGE_ONLY_SKIP_EVENT ? e.attrs?.review_base : undefined;
    if (typeof base === "string" && base) return base;
  }
  return String(events[start].attrs?.started_from_commit ?? "");
}

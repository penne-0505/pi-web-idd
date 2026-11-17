/**
 * The checks that failed without holding the signature, folded once for both screens. A check a repo declared
 * `required: false` does not count in `blocking`, nor does a required one that fails on the same failures at the public base,
 * so the submit card is signed as it stands and its failure sits only in the check list — a list the new screen does
 * not draw at all. The values here move that failure near the heading, without touching the signature.
 */

// a relative path: the engine's state tests run under node, whose loader maps `@idd/core` alone and not a path below it
import { baselinePhrase, checkReason, failingAtBase } from "../../packages/idd-core/src/overlay/check-reason.ts";
import type { CheckLike } from "../../packages/idd-core/src/overlay/check-reason.ts";

/** one failed non-blocking check, with the line of its output that says why */
export interface CheckWarning {
  name: string;
  reason: string;
}

export type { CheckLike } from "../../packages/idd-core/src/overlay/check-reason.ts";
export { blockingFailures, blockingPhrase, blockingWhy, checkReason } from "../../packages/idd-core/src/overlay/check-reason.ts";
export type { BlockingFailure, CheckBaseline } from "../../packages/idd-core/src/overlay/check-reason.ts";

/**
 * The failed checks that do not hold the signature, in the record's own order, each with its reason: a non-blocking
 * check, and a required one that fails on the same failures at the public base (the reason says so first). A check
 * that passed or did not apply is left out, so a card whose checks all passed carries nothing to show.
 */
export function nonBlockingFailures(checks: readonly CheckLike[] | undefined | null): CheckWarning[] {
  return (checks ?? [])
    .filter((check) => (check.severity === "non-blocking" && check.status === "fail") || (check.severity === "blocking" && failingAtBase(check)))
    .map((check) => {
      const reason = checkReason(check.detail, check.status);
      return { name: check.name, reason: failingAtBase(check) ? `${baselinePhrase(check.baseline)}: ${reason}` : reason };
    });
}

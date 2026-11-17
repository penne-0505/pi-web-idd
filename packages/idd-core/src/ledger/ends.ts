import { laneAnswer } from "../intent/moonbit-fold.ts";
import { laneEndedEvents } from "../plan/ledger-reads.ts";

/**
 * Events after which a lane no longer goes on: closed (merged, completed locally, aborted, dropped), stopped at
 * GO, or put on hold at S3. Intake takes such a lane's Issue in again as a new lane, a submit refuses it, and
 * the new lane does not take its branch over. Retiring worktrees reads its own, narrower list (plan/close.ts).
 */
export const LANE_ENDED_EVENTS: readonly string[] = laneEndedEvents();

/** whether any of the lane's own rows ends it, folded by the MoonBit derivation (C-191-1) */
export function laneHasEnded(iddId: string, events: { idd_id: string; event: string }[]): boolean {
  return laneAnswer<boolean>("lane_ended", events.filter((e) => e.idd_id === iddId) as never);
}

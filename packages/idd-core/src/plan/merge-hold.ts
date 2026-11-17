import { laneHalt } from "../ledger/derive.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/** the `source` the merge acceptance writes on the halt record it raises, so the close pass tells its cards from the stall watch's */
export const MERGE_ACCEPT_SOURCE = "merge_accept";

/**
 * The records that answer a halt (the fold's own list, `laneHalt`) and the close that ends the lane. A pass that read the
 * lane before one of them was written has read a lane that has since moved on: it writes nothing for it.
 */
const ANSWERS: readonly string[] = ["lane_stall_resumed", "s4_verify_user_judgment_answered", "s3_reject", "s2_result", "s1_ready", "s1_revise_requested", "lane_close"];

/** where the lane's last answer stands in its records (-1 when none): a pass compares it before and after its slow work */
export function answerMark(events: LifecycleRecord[]): number {
  const names = events.map((e) => e.event);
  return Math.max(-1, ...ANSWERS.map((n) => names.lastIndexOf(n)));
}

export interface AcceptHold {
  /** the stop as the tick wrote it */
  reason: string;
  /** where the receive and the lane stood when it stopped; a read again is due when they stand elsewhere */
  stand: string;
}

/** the halt the merge acceptance has up for the lane (its card is showing), or null when none is up */
export function acceptHold(events: LifecycleRecord[]): AcceptHold | null {
  if (!laneHalt(events)) return null;
  const names = events.map((e) => e.event);
  const attrs = events[names.lastIndexOf("lane_stall_detected")]?.attrs;
  if (!attrs || attrs.source !== MERGE_ACCEPT_SOURCE) return null;
  return { reason: String(attrs.reason ?? ""), stand: String(attrs.stand ?? "") };
}

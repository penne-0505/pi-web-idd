import { laneAnswer } from "../intent/moonbit-fold.ts";
import { quotaFactOf } from "./derive.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The stages' answer to "do you pick this lane up?". The answer is folded by the MoonBit module, so the tick's
 * lane, the card and the write side cannot disagree about which stage owns a lane (C-199-1). Every stage asks
 * its own question, at the moment it asks it, so the answer is read from the ledger as it stands then
 * (C-199-2).
 *
 * What the ledger does not hold is handed in as a fact: whether a session exists, whether the repo publishes,
 * what the worktree's head is, what the lane has spent, how deep the lane is, and the readings of the outside
 * world (C-199-3).
 */

/** the answer of a stage: whether it picks the lane up, and why it leaves it when it does not */
export interface PickAnswer {
  pick: boolean;
  reason?: string;
  /** the step the stage takes, when the stage has more than one */
  branch?: string;
}

/** the answer of the stage a caller names */
export function stagePick(stage: string, events: LifecycleRecord[], facts: Record<string, unknown> = {}, now?: number): PickAnswer {
  return laneAnswer<PickAnswer>("stage_pick", events, { stage, facts, quota: quotaFactOf(events, undefined, now) });
}

/**
 * The lanes whose signature is still in force, in the order the ledger records it: the last approval of each
 * lane, in the order the approvals were written. The order decides which merge moves the mainline first, so it
 * is folded with the rest (C-199-2).
 */
export function landOrder(events: LifecycleRecord[]): string[] {
  return laneAnswer<string[]>("land_order", events);
}

import type { LifecycleRecord } from "../schema/records.ts";
import { laneAnswer } from "../intent/moonbit-fold.ts";
import { quotaFactOf } from "./derive.ts";

/**
 * The events checked against the lane's stage before they are written: the ones that raced (a GO from an old screen
 * on a plan sent back, a GO and a send-back pressed together, a second close, a second executor). Every other event
 * goes through as it did.
 *
 * The stage the rule reads is folded by the MoonBit module, so the write side's refusal and the screen's card cannot
 * disagree about which stage the lane is on (C-199-1). Whether a name is one of the strict events, and which rule it
 * is checked by, comes from the fold's one table of name and rule: a name added there is both checked and listed,
 * and a rule added without its wording does not build (C-202-4). The list below is that same table's names, read for
 * display and the tests.
 */
export const STRICT_EVENTS: readonly string[] = laneAnswer<string[]>("strict_events", []);

/** whether the name is one of the events the write side checks against the lane's stage, as the fold's closed type says */
export function isStrictEvent(event: string): boolean {
  return laneAnswer<boolean>("strict_event", [], { event });
}

/** why the lane with these records may not take the event now, or null when it may (an event outside the table always may) */
export function transitionRefusal(event: string, events: LifecycleRecord[]): string | null {
  return laneAnswer<string | null>("transition_refusal", events, { event, quota: quotaFactOf(events) });
}

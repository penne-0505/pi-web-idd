import { laneAnswer } from "../intent/moonbit-fold.ts";
import { quotaFactOf, quotaFactOfAny } from "./derive.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * Whose turn a lane is on. Every open lane maps to exactly one of these; `engine` is the remainder, so a state
 * nobody listed still has an owner and is caught by the stall watch's time limit.
 */
export type LaneTurn = "agent" | "penne" | "lane" | "outside" | "engine";

/**
 * The facts a caller has to gather for a lane, because they are not in the ledger: an envelope waiting to be
 * delivered, and whether the lane's card can actually be built (a ship card needs a readable worktree).
 * Everything else is read from the records.
 */
export interface LaneFacts {
  /** what the watch's reading answered for the lane: the role it waits on, or nothing */
  awaitedAgent?: { role: "executor" | "planner" } | null;
  /** an envelope is queued for the lane and not delivered */
  pendingEnvelope?: boolean;
  /** the lane's decision card can be built; only the ship card depends on the worktree, so only it reads this */
  cardBuildable?: boolean;
}

/**
 * The fold answers whose turn a lane is on, and when it came to the step it is on now. The reading is folded by
 * the MoonBit module, so the tick's lane, the screen's card and the write side's refusal cannot disagree
 * (C-199-1). What the record cannot answer is handed in as a fact: the runtime's reading of Claude Code's
 * windows, the envelope waiting for the lane, and whether the ship card can be built (C-199-3).
 */
export function laneTurn(events: LifecycleRecord[], facts: LaneFacts = {}): LaneTurn | null {
  return laneAnswer<LaneTurn | null>("lane_turn", events, {
    awaitedAgent: facts.awaitedAgent ?? null,
    pendingEnvelope: facts.pendingEnvelope ?? false,
    cardBuildable: facts.cardBuildable ?? null,
    quota: quotaFactOf(events),
  });
}

/**
 * When the lane came to the step it is on now: the time of the event its last stretch at the same step began
 * with. The tail is shortened one record at a time while the step is unchanged, so a record that moves no lane
 * does not restart the clock. Penne's resume starts a fresh clock.
 */
export function turnSince(events: LifecycleRecord[], facts: LaneFacts = {}): string | undefined {
  return laneAnswer<string | null>("turn_since", events, {
    awaitedAgent: facts.awaitedAgent ?? null,
    pendingEnvelope: facts.pendingEnvelope ?? false,
    cardBuildable: facts.cardBuildable ?? null,
    quota: quotaFactOfAny(events),
  }) ?? undefined;
}

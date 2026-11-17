import { runAfterDecision, type AfterDecision } from "@idd/core";
import { TICK_AGAIN_FILE, TICK_AGAIN_INTAKE_FILE, TICK_HOLD_FILE, stateDir } from "@idd/core";
import { bookFollowUpTick, requestTick, type TickKick } from "@idd/lane";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** decide actions that record nothing a tick could act on (the submit view is only built) */
const NOT_A_RECORD = new Set(["s4_prepare"]);

/** whether a decision (or another write by penne) asks for a tick: only what was recorded can move a lane on */
export function decisionAsksForTick(action: string, ok: boolean): boolean {
  return ok && !NOT_A_RECORD.has(action);
}

function warnIfFailed(kick: TickKick): TickKick {
  if (kick.outcome === "failed") console.warn(`[tick] 次の tick を頼めませんでした: ${kick.detail ?? ""}`.slice(0, 400));
  return kick;
}

/**
 * A stage's end (an executor's result, a planner's ready) or penne's decision was recorded: ask for a tick so the
 * next stage does not wait for the timer. Best effort; the write it follows is already recorded and answered as it was.
 */
export function kickTickAfterRecord(request: () => TickKick = requestTick): TickKick | null {
  try {
    return warnIfFailed(request());
  } catch (err) {
    console.warn(`[tick] 次の tick を頼めませんでした: ${String(err)}`.slice(0, 400));
    return null;
  }
}

export function kickTickAfterDecision(action: string, ok: boolean, request: () => TickKick = requestTick): TickKick | null {
  return decisionAsksForTick(action, ok) ? kickTickAfterRecord(request) : null;
}

/** a tick or a decision that let the lock go with a request still there: book one more tick for it */
export function bookTickIfPending(result: { pending?: true } | object | null | undefined, book: () => TickKick = bookFollowUpTick): TickKick | null {
  if (!result || !("pending" in result) || result.pending !== true) return null;
  return kickTickAfterRecord(book);
}

/**
 * A tick request left in the state while the engine was down (`tick.again`, and the intake beside it), or the
 * held request of a pass that waited for a replacement (`tick.hold`): book one tick now rather than waiting for the
 * next timer (up to 15 minutes). The booked tick runs without the intake, but the tick's own pass reads the left
 * intake request and folds it in (`withLeftIntake`), so nothing is dropped. A failure is a warning only: the start
 * is not held back by it.
 */
export function pickUpLeftTick(opts: { state?: string; book?: () => TickKick } = {}): TickKick | null {
  let dir: string;
  try {
    dir = opts.state ?? stateDir();
  } catch {
    return null;
  }
  if (!existsSync(join(dir, TICK_AGAIN_FILE)) && !existsSync(join(dir, TICK_AGAIN_INTAKE_FILE)) && !existsSync(join(dir, TICK_HOLD_FILE))) return null;
  return kickTickAfterRecord(opts.book ?? bookFollowUpTick);
}

export interface DecisionFollowUpDeps {
  runAfter?: typeof runAfterDecision;
  request?: () => TickKick;
  book?: () => TickKick;
}

/**
 * What follows a recorded decision in `/api/idd/decide`: the executor after a GO and the queued envelopes, under the
 * tick's lock (a running tick takes them instead), then a tick for the next stage, and one more when a request was
 * left while the lock was held.
 */
export async function runDecisionFollowUps(action: string, ok: boolean, deps: DecisionFollowUpDeps = {}): Promise<AfterDecision> {
  if (!ok) return {};
  const after = await (deps.runAfter ?? runAfterDecision)({ exec: action === "s1_go" });
  kickTickAfterDecision(action, true, deps.request);
  bookTickIfPending(after, deps.book);
  return after;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";

export const LANE_GATE_FILE = "lane-gate.lock";

/**
 * How long a holder may keep the gate without refreshing it before another process takes it as abandoned. Longer
 * by far than the longest work done inside it: reading the lane's records again and a few appends (a decision also
 * writes its envelope). Building the submit card, the conflict check's merge-tree, the records brought back before a
 * close, the executor's spawn and anything that waits on an agent or the network run outside it.
 */
export const LANE_GATE_STALE_MS = 5 * 60 * 1000;

/** what penne is told when the gate stays busy */
export const LANE_GATE_BUSY_MESSAGE = "ほかの処理が lane を更新中です。少し待ってからもう一度押してください";

/** how long a caller waits for the gate before giving up (IDD_LANE_GATE_WAIT_MS, 10 s by default) */
export function laneGateWaitMs(): number {
  const v = Number(process.env.IDD_LANE_GATE_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
}

/**
 * Another holder kept the gate for the whole wait: the caller says so and goes on, never fails as a whole. Its
 * message is only the words penne is told; it goes on to a tick's failures and the cron's record, so it names
 * neither the lock's file nor the state's place.
 */
export class LaneGateBusyError extends Error {
  constructor() {
    super(LANE_GATE_BUSY_MESSAGE);
    this.name = "LaneGateBusyError";
  }
}

export function isLaneGateBusy(err: unknown): err is LaneGateBusyError {
  return err instanceof LaneGateBusyError;
}

/**
 * Whether the work running now is inside a hold of the gate. The flag is cleared when the hold ends, so work that
 * was started inside and runs on after it (a timer, a promise left behind) takes the lock for itself.
 */
const holding = new AsyncLocalStorage<{ held: boolean }>();

export function laneGateHeld(): boolean {
  return holding.getStore()?.held === true;
}

const STEP_MS = 100;

/**
 * One lock for the writes whose check and write must not interleave: every write that moves a lane from one stage
 * to the next, and the intake making a lane. Each checks and writes inside it, so of two that race the one that
 * comes second sees the first (reading back and cancelling after the write lets both cancel). A caller waits for up
 * to the wait above while another holder has it; past it the caller gets LaneGateBusyError (the write gate turns it
 * into a refusal). A lock that cannot be made for any other reason (permissions, a full or read-only disk) is a
 * fault, not a busy gate: it is thrown as it is, at once. Work already inside the gate may take it again: it runs
 * at once, inside the same hold.
 */
export async function withLaneGate<T>(fn: () => Promise<T>): Promise<T> {
  if (laneGateHeld()) return fn();
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, LANE_GATE_FILE);
  if (!existsSync(path)) writeFileSync(path, "");
  const deadline = Date.now() + laneGateWaitMs();
  let release: () => Promise<void>;
  for (;;) {
    try {
      release = await lockfile.lock(path, {
        stale: LANE_GATE_STALE_MS,
        // the lock was taken over (its holder looked abandoned): the work inside goes on and is said, never thrown from a
        // timer where nothing could catch it
        onCompromised: (err) => console.warn(`[lane-gate] lock が奪われました（中の処理は続けます）: ${String(err).slice(0, 300)}`),
      });
      break;
    } catch (err) {
      // only another holder is a busy gate; the retry is ours, so a fault is not waited on for the whole wait
      if ((err as NodeJS.ErrnoException).code !== "ELOCKED") throw err;
      if (Date.now() >= deadline) throw new LaneGateBusyError();
      await new Promise((r) => setTimeout(r, STEP_MS));
    }
  }
  const store = { held: true };
  try {
    return await holding.run(store, fn);
  } finally {
    store.held = false;
    // a lock that was taken over cannot be released; that is not the caller's failure
    await release().catch((err) => console.warn(`[lane-gate] lock を放せませんでした: ${String(err).slice(0, 300)}`));
  }
}

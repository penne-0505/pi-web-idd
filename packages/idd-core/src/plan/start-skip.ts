import { readLifecycle } from "../ledger/read.ts";
import { LANE_NOTE_EVENTS } from "../ledger/derive.ts";
import { appendLifecycle } from "../ledger/write.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/** the note a lane gets when a stage could not start it: the stage and the reason the stage itself gave */
export const LANE_START_SKIPPED = "lane_start_skipped";

/** the stages that start a lane's agent, as the note names them */
export type StartStage = "planner" | "executor";

/** the reasons are the stage's own words; one that carries a count or a path is kept to a line's length */
const REASON_LIMIT = 400;

/** the Claude windows' wait is a row of its own (`claude_quota_wait`), written in the same pass with the same reason */
const QUOTA_PREFIX = "claude quota: ";

/**
 * The lane's last word about a start, read from its own rows: the note while nothing but notes follows it. A row
 * that is not a note (the stage started, the quota wait, a card) is the lane having moved, so the note is history.
 */
export function startSkipOf(events: LifecycleRecord[]): { stage: StartStage; reason: string; wait: boolean } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event === LANE_START_SKIPPED) {
      const stage = e.attrs?.stage === "executor" ? "executor" : "planner";
      return typeof e.attrs?.reason === "string" ? { stage, reason: e.attrs.reason, wait: e.attrs.wait === true } : undefined;
    }
    if (!LANE_NOTE_EVENTS.includes(e.event)) return undefined;
  }
  return undefined;
}

/**
 * Put the reasons a stage gave for the lanes it did not start on the lanes' own records, once: a pass that meets the
 * same stage and the same reason again adds nothing, a changed reason adds a line, and an earlier line is never
 * rewritten (the lines' times tell the reason now from the history). The Claude windows' wait already has its own
 * row with the reason, so it is not written a second time. `wait` is the stage's own answer that it is waiting, not
 * failing (the stall watch owes no card for it); it is carried as the stage gave it, and is not part of the key. A write that fails stays here: the tick goes on.
 */
export async function recordStartSkips(
  stage: StartStage,
  skipped: { iddId: string; reason: string; wait?: boolean }[],
): Promise<void> {
  if (!skipped.length) return;
  const events = readLifecycle();
  for (const s of skipped) {
    const reason = s.reason.trim().slice(0, REASON_LIMIT);
    if (!reason || reason.startsWith(QUOTA_PREFIX)) continue;
    try {
      const last = startSkipOf(events.filter((e) => e.idd_id === s.iddId));
      if (last?.stage === stage && last.reason === reason) continue;
      await appendLifecycle(LANE_START_SKIPPED, s.iddId, { stage, reason, ...(s.wait ? { wait: true } : {}) });
    } catch (err) {
      console.warn(`[tick] ${s.iddId} の起動の理由を記録できませんでした: ${String(err).slice(0, 400)}`);
    }
  }
}

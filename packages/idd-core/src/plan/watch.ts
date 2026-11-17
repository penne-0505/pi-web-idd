import { getAgentRunner } from "../agent/port.ts";
import { FIX_TYPES, pendingEnvelopes } from "../agent/outbox.ts";
import { deriveStage, quotaFactOf } from "../ledger/derive.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { quotaWaitOf, recordQuotaWait } from "./quota-wait.ts";
import { resumeTargetFor, runResume, type ResumeResult, type ResumeTarget } from "./resume.ts";
import { laneAnswer } from "../intent/moonbit-fold.ts";
import { stagePick } from "../ledger/pick.ts";
import { heldBatches } from "../ledger/routing-hold.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/** a stop younger than this may still be followed by the agent's own callback */
export const STALL_GRACE_MS = 120_000;

export { EXECUTOR_WORK, isExecutorWork } from "../ledger/executor-work.ts";

const ATTEMPTS = ["s2_recovery_attempt", "s1_recovery_attempt"];

type WatchEvent = { event: string; attrs?: Record<string, unknown> };

/**
 * The batch a lane is waiting on penne for: the oldest question with no answer since the work it is on now, with
 * the role that was handed the work and the index of the question. The watch, the turn and the cards all read
 * this one reading, so a wait nobody sees cannot exist on one side alone. The reading is folded by the MoonBit
 * module (C-199-1).
 */
export function awaitingQuestion(events: WatchEvent[] | LifecycleRecord[]): { role: "executor" | "planner"; index: number } | null {
  const rows = events as LifecycleRecord[];
  return laneAnswer<{ role: "executor" | "planner"; index: number } | null>("awaiting_question", rows, { quota: quotaFactOf(rows) });
}

/**
 * The role a lane is waiting on and the index of the event that handed it the work, or null. The reading is
 * folded by the MoonBit module (C-199-1).
 */
export function awaitedAgent(events: WatchEvent[] | LifecycleRecord[]): { role: "executor" | "planner"; since: number } | null {
  const rows = events as LifecycleRecord[];
  return laneAnswer<{ role: "executor" | "planner"; since: number } | null>("awaited_agent", rows, { quota: quotaFactOf(rows) });
}

/** whether the stage lets the watch act on the lane now; a fix or a send-back still waiting to start a new session means the stopped old one must not be resumed first */
function watchPicks(iddId: string, evs: LifecycleRecord[], awaitedRole: "executor" | "planner", targetRole: "executor" | "planner"): boolean {
  return stagePick("watch", evs, {
    awaitedRole,
    pendingFixEnvelope: pendingEnvelopes().some((e) => e.idd_id === iddId && FIX_TYPES.has(e.type)),
    targetRole,
  }).pick;
}

/**
 * Why the lane's wait on an agent cannot be answered by a resume, or null when it can, or when the wait is a right
 * one. A session that was never started (a lane in the prep's queue) and a stage that holds the lane back (a fix or
 * a send-back waiting for its new session, a lane already stopped or closed) are waits the watch leaves alone: the
 * stage's refusal that is not about the role is read with the role granted. What stays is a lane the agent of the
 * role it waits on cannot be reached for: its session is not on record, or the session the lane has is of another role.
 */
function unresumableReason(iddId: string, evs: LifecycleRecord[], awaitedRole: "executor" | "planner", target: ResumeTarget | null): string | null {
  if (!watchPicks(iddId, evs, awaitedRole, awaitedRole)) return null;
  if (!target) {
    // a planner's session is on record once the lane has been to its prep; before the first plan nothing started it yet
    const started = awaitedRole === "executor" || evs.some((e) => e.event === "s1_ready");
    return started ? `${awaitedRole} の session の記録が無く、再開できない` : null;
  }
  if (!watchPicks(iddId, evs, awaitedRole, target.role)) return `待つ役は ${awaitedRole} だが、起こせる session は ${target.role} のもの`;
  return null;
}

/** a stop that no automatic resume can undo: written once, since the lane that is stopped is left alone by the stage */
async function recordStall(result: WatchResult, iddId: string, role: "executor" | "planner", cause: string, reason: string): Promise<void> {
  await appendLifecycle("lane_stalled", iddId, { role, cause, reason });
  result.stalled.push(iddId);
}

/** how many resumes the lane has had, automatic or by penne: a status read before one of them says nothing about the lane after it */
function resumeCount(evs: LifecycleRecord[]): number {
  return evs.filter((e) => e.event === "lane_stall_resumed" || ATTEMPTS.includes(e.event)).length;
}

export interface WatchResult {
  resumed: string[];
  stalled: string[];
  errors: { id: string; error: string }[];
}

/**
 * Resume an executor or planner whose session stopped without answering: once on its own, then the
 * lane goes to penne. Penne's resume allows one more automatic attempt.
 */
export async function runWatch(now = Date.now()): Promise<WatchResult> {
  const result: WatchResult = { resumed: [], stalled: [], errors: [] };
  const runner = getAgentRunner();
  if (!runner?.sessionStatus) return result;
  for (const rec of readBacklog()) {
    // read at this lane's turn: an earlier lane's status read can take a while, and a lane sent back to its plan meanwhile
    // must be judged on the lifecycle the resume target is read from, not on the one from before the wait (C-275-1)
    let evs = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
    const awaited = awaitedAgent(evs);
    if (!awaited) continue;
    // the judge is reading a batch of this lane's questions: the batch is on no row and no event yet, so the planner
    // looks like one that stopped without a result, but it is waiting on the judge (C-263-1)
    if (heldBatches(rec.idd_id).length) continue;
    // the stage asks its own question, at the moment it asks it (C-199-2)
    const target = resumeTargetFor(rec.idd_id);
    if (!target || !watchPicks(rec.idd_id, evs, awaited.role, target.role)) {
      const why = unresumableReason(rec.idd_id, evs, awaited.role, target);
      if (why) await recordStall(result, rec.idd_id, awaited.role, "unresumable", why).catch((err) => { result.errors.push({ id: rec.idd_id, error: String(err) }); });
      continue;
    }
    try {
      // a resume that completes while the status is being read makes the status older than the lane: count them first
      const resumesBefore = resumeCount(readLifecycle().filter((e) => e.idd_id === rec.idd_id));
      const status = await runner.sessionStatus(target.sessionId);
      // the status read can take a while: the judge may have taken the batch, a fix or a send-back may have been queued,
      // or the lane may have moved on, in the meantime. Everything below is decided on the lane as it is now, not as it
      // was before the wait (C-263-1)
      evs = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
      const fresh = awaitedAgent(evs);
      if (!fresh || fresh.since !== awaited.since || fresh.role !== awaited.role) continue;
      if (heldBatches(rec.idd_id).length) continue;
      // the status was read before a resume that has since finished, so it describes the stopped session, not the resumed one;
      // the next pass reads a status of the lane as it is now
      if (resumeCount(evs) > resumesBefore) continue;
      // the session the wait was about must still be the lane's, and the stage must still want it watched
      const current = resumeTargetFor(rec.idd_id);
      if (!current || current.sessionId !== target.sessionId || !watchPicks(rec.idd_id, evs, fresh.role, current.role)) continue;
      // waiting for Claude Code's windows is not a stop: the runtime is asked to wake it, and penne is not
      if (status.state === "quota_wait") {
        const woke = runner.wakeSession ? await runner.wakeSession(target.sessionId) : false;
        if (!woke) await recordQuotaWait(rec.idd_id, evs, awaited.role, { reason: status.reason, ...(status.resetsAt !== undefined ? { resetsAt: status.resetsAt } : {}) });
        continue;
      }
      if (status.state !== "stopped" || now - Date.parse(status.at) < STALL_GRACE_MS) continue;
      const names = evs.map((e) => e.event);
      const from = Math.max(awaited.since, names.lastIndexOf("lane_stall_resumed"));
      const attempts = evs.slice(from + 1).filter((e) => ATTEMPTS.includes(e.event)).length;
      const reason = status.cause === "error" ? `応答がエラーで止まった: ${status.error ?? ""}`.slice(0, 300)
        : status.cause === "interrupted" ? "応答の途中で session が止まった"
          : status.cause === "stopped" ? "人が session を止めた"
            : "応答を終えたが、結果が届いていない";
      // a stop by a person is theirs to undo: only penne's resume after it lets the watch start the session again
      const resumedAt = Date.parse(String(evs[names.lastIndexOf("lane_stall_resumed")]?.at ?? "")) || 0;
      if (status.cause === "stopped" && resumedAt < Date.parse(status.at)) {
        await appendLifecycle("lane_stalled", rec.idd_id, { role: awaited.role, cause: status.cause, reason });
        result.stalled.push(rec.idd_id);
        continue;
      }
      if (attempts === 0) {
        // penne's note on the resume goes along with the situation
        const note = String(evs[names.lastIndexOf("lane_stall_resumed")]?.attrs?.note ?? "").trim();
        // a hold made from here on stops the resume itself: the check sits next to the delivery (C-263-1)
        const asked = note && from > awaited.since ? `${reason}\n    penne から: ${note}` : reason;
        let quota: ReturnType<typeof quotaWaitOf> = null;
        const r = await runResume(rec.idd_id, asked, { unlessHeld: true }).catch((err): ResumeResult => {
          // the windows refused the delivery: that is a wait, not a refusal a person has to see (the next tick tries again)
          quota = quotaWaitOf(err);
          return { ok: false, error: String(err) };
        });
        if (quota) {
          await recordQuotaWait(rec.idd_id, evs, awaited.role, quota);
          continue;
        }
        if (r.ok) result.resumed.push(rec.idd_id);
        else if (!r.held) {
          // a resume the runner refused is a stop a person has to see: the next tick would only be refused again
          result.errors.push({ id: rec.idd_id, error: r.error });
          await recordStall(result, rec.idd_id, awaited.role, "resume_refused", `再開を断られた: ${r.error}`.slice(0, 300));
        }
      } else {
        await appendLifecycle("lane_stalled", rec.idd_id, { role: awaited.role, cause: status.cause, reason });
        result.stalled.push(rec.idd_id);
      }
    } catch (err) {
      result.errors.push({ id: rec.idd_id, error: String(err) });
    }
  }
  return result;
}

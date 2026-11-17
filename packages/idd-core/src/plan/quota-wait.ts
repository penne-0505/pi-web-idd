import { getAgentRunner, type QuotaFallback, type QuotaWindowBlock } from "../agent/port.ts";
import { withoutNotes } from "../ledger/derive.ts";
import { appendLifecycle } from "../ledger/write.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/** a stage's run the runner did not start because Claude Code's subscription windows are too full right now */
export interface QuotaWait {
  reason: string;
  /** UNIX seconds from when it can start */
  resetsAt?: number;
}

/**
 * How a cut of a lane's record reads Claude Code's windows. The runtime's answer, or null when it says they let a
 * lane start (a file with no observation included), or the literal "record": the record alone decides, which is
 * what a past prefix gets so a sample never moves with the clock (C-133-4). Absent means read the runtime now.
 */
export type QuotaCut = QuotaWindowBlock | null | "record";

/** whether a lane's recorded wait for the windows still holds now, and the reset the display reads */
export interface QuotaHold {
  held: boolean;
  /** the reading's reset while held, or the record's own reset once passed, as an ISO time */
  resetAt?: string;
  /** the runtime's reason while held */
  reason?: string;
}

/** how long one runtime answer about the windows is reused: a tick classifies every prefix of every lane */
const WINDOWS_TTL_MS = 1000;

let lastRead: { runner: unknown; at: number; block: QuotaWindowBlock | null | undefined } | null = null;

const isoOf = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

/**
 * What the runtime says about the windows now: a block when they hold a lane, null when they let it start (a file
 * with no observation included), or undefined when this process cannot be told (no runner, no method for it, or a
 * read that failed). Read once per short window, since only a Claude run's report moves the file.
 */
export function readQuotaWindows(): QuotaWindowBlock | null | undefined {
  const runner = getAgentRunner();
  const block = runner?.quotaBlock;
  if (!block) return undefined;
  const at = Date.now();
  if (lastRead && lastRead.runner === runner && at - lastRead.at < WINDOWS_TTL_MS) return lastRead.block;
  let answer: QuotaWindowBlock | null | undefined;
  try {
    answer = block.call(runner);
  } catch {
    // a failed read is not a read that freed the lane: the caller falls back to the record's own reset
    answer = undefined;
  }
  lastRead = { runner, at, block: answer };
  return answer;
}

/**
 * Whether a lane whose last word is this wait is held for Claude Code's windows now. One judgment for the four
 * readers (C-133-1): the cap wait list, the display, the cut of the stages, and the stall watch. `cut` says how
 * the windows are read; absent reads the runtime now, and an unreadable reading falls back to the record's own
 * reset, so an unreadable process still answers the same everywhere (C-133-2).
 */
export function quotaHoldOf(last: { event: string; attrs?: Record<string, unknown> } | undefined, name: string, now: number, cut?: QuotaCut): QuotaHold {
  if (last?.event !== name) return { held: false };
  const at = last.attrs?.resets_at;
  const own = typeof at === "number" ? isoOf(at) : undefined;
  if (cut === "record") return { held: true, ...(own ? { resetAt: own } : {}) };
  const reading = cut === undefined ? readQuotaWindows() : cut;
  if (reading === undefined) {
    const passed = typeof at === "number" && at * 1000 <= now;
    return { held: !passed, ...(own ? { resetAt: own } : {}) };
  }
  if (reading === null) return { held: false };
  return { held: true, ...(reading.resetsAt !== undefined ? { resetAt: isoOf(reading.resetsAt) } : {}), reason: reading.reason };
}

/**
 * The runner's refusal for the windows (ClaudeQuotaBlocked of @idd/lane), told by its code. It is a wait, not a
 * failure: the stage is tried again on the next tick, is not counted as a failed start, and is not skipped.
 */
export function quotaWaitOf(err: unknown): QuotaWait | null {
  if (typeof err !== "object" || err === null || (err as { code?: unknown }).code !== "claude_quota") return null;
  const e = err as { message?: unknown; resetsAt?: unknown };
  return { reason: typeof e.message === "string" ? e.message : String(err), ...(typeof e.resetsAt === "number" ? { resetsAt: e.resetsAt } : {}) };
}

/**
 * The roles the runner ran on their fallback because the windows refused them, as attrs of the event that
 * records the stage's start (the start and what it ran on are one append). The stage started, so this is not a wait.
 */
export function fallbackAttrs(fallbacks: QuotaFallback[] | undefined): { fallbacks?: QuotaFallback[] } {
  if (!fallbacks?.length) return {};
  return { fallbacks: fallbacks.map((f) => ({ ...f, reason: f.reason.slice(0, 400) })) };
}

/**
 * For a start that has no event of its own (the planner's spawn): one line per fallback, written after the
 * session is recorded, so a failure here never leaves a session unrecorded.
 */
export async function recordQuotaFallbacks(iddId: string, stage: string, fallbacks: QuotaFallback[] | undefined): Promise<void> {
  for (const f of fallbackAttrs(fallbacks).fallbacks ?? []) {
    await appendLifecycle("claude_quota_fallback", iddId, { stage, ...f });
  }
}

/** Put the wait on the lane's record, once: a tick that meets the same wait again adds nothing. */
export async function recordQuotaWait(iddId: string, events: LifecycleRecord[], stage: string, wait: QuotaWait): Promise<void> {
  const reason = wait.reason.slice(0, 400);
  const last = withoutNotes(events).at(-1);
  if (last?.event === "claude_quota_wait" && last.attrs?.stage === stage && last.attrs?.reason === reason) return;
  await appendLifecycle("claude_quota_wait", iddId, { stage, reason, ...(wait.resetsAt !== undefined ? { resets_at: wait.resetsAt } : {}) });
}

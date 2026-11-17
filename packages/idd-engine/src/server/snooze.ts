import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "@idd/core";
import { writePrivateFileAtomicSync } from "../../../../lib/atomic-file.ts";
import { SNOOZE_DEFAULT_MINUTES, sleepNoticeDays, snoozeKey } from "../../../../lib/idd-ui/snooze.ts";
import type { InboxItem } from "../../../../lib/idd-ui/types.ts";

/**
 * "あとで" and "寝かせる" are view states of the inbox only. They live in their own small file beside the ledger so
 * every device sees the same inbox, and nothing that drives a lane (tick, budget, watch) reads it.
 * A sleeping card never comes back by itself: `notice_at` is when the inbox asks about it, `step` how many times
 * penne kept it asleep when asked (null notice_at: it asks no more).
 */
interface SleepEntry { at: string; step: number; notice_at: string | null }

interface SnoozeFile {
  entries: Record<string, { until: string; at: string }>;
  sleeps: Record<string, SleepEntry>;
}

const DAY_MS = 86_400_000;

function noticeAfter(step: number, from: number): string | null {
  const days = sleepNoticeDays(step);
  return days === null ? null : new Date(from + days * DAY_MS).toISOString();
}

export function snoozePath(): string {
  return join(stateDir(), "inbox-snooze.json");
}

export function readSnoozes(): SnoozeFile {
  const path = snoozePath();
  if (!existsSync(path)) return { entries: {}, sleeps: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown; sleeps?: unknown };
    const entries: SnoozeFile["entries"] = {};
    const sleeps: SnoozeFile["sleeps"] = {};
    const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : []);
    // only well-formed entries count: a hand edit or an older shape is read as nothing put off
    for (const [key, e] of record(raw?.entries)) {
      const v = e as { until?: unknown; at?: unknown } | null;
      if (v && typeof v === "object" && typeof v.until === "string") entries[key] = { until: v.until, at: typeof v.at === "string" ? v.at : v.until };
    }
    for (const [key, e] of record(raw?.sleeps)) {
      const v = e as { at?: unknown; step?: unknown; notice_at?: unknown } | null;
      if (!v || typeof v !== "object" || typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) continue;
      const step = typeof v.step === "number" && v.step >= 0 ? Math.floor(v.step) : 0;
      // a notice time that is not a date would have the page wake at once, again and again: take the one its step has
      const notice_at = v.notice_at === null || v.notice_at === undefined
        ? null
        : typeof v.notice_at === "string" && !Number.isNaN(Date.parse(v.notice_at)) ? v.notice_at : noticeAfter(step, Date.parse(v.at));
      sleeps[key] = { at: v.at, step, notice_at };
    }
    return { entries, sleeps };
  } catch {
    return { entries: {}, sleeps: {} };
  }
}

// writes in this process go one at a time; the file lock still guards against another process
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const g = globalThis as { __iddSnoozeQueue?: Promise<unknown> };
  const run = (g.__iddSnoozeQueue ?? Promise.resolve()).then(task, task);
  g.__iddSnoozeQueue = run.catch(() => {});
  return run;
}

function updateSnoozes(fn: (file: SnoozeFile) => boolean): Promise<void> {
  return serialized(() => updateSnoozesLocked(fn));
}

async function updateSnoozesLocked(fn: (file: SnoozeFile) => boolean): Promise<void> {
  const path = snoozePath();
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ entries: {}, sleeps: {} }), "utf8");
  const release = await lockfile.lock(path, { retries: { retries: 8, minTimeout: 40 } });
  try {
    const file = readSnoozes();
    if (fn(file)) writePrivateFileAtomicSync(path, `${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await release();
  }
}

export async function snooze(key: string, minutes = SNOOZE_DEFAULT_MINUTES, now = Date.now()): Promise<string> {
  const until = new Date(now + minutes * 60_000).toISOString();
  await updateSnoozes((file) => {
    file.entries[key] = { until, at: new Date(now).toISOString() };
    return true;
  });
  return until;
}

/** bring a card back to the front, whether it was put off or put to sleep */
export async function wake(key: string): Promise<void> {
  await updateSnoozes((file) => {
    if (!(key in file.entries) && !(key in file.sleeps)) return false;
    delete file.entries[key];
    delete file.sleeps[key];
    return true;
  });
}

/** put a card to sleep: out of both decks until penne brings it back; the inbox asks about it a day later */
export async function sleep(key: string, now = Date.now()): Promise<void> {
  await updateSnoozes((file) => {
    delete file.entries[key];
    file.sleeps[key] = { at: new Date(now).toISOString(), step: 0, notice_at: noticeAfter(0, now) };
    return true;
  });
}

/** "まだ寝かせる" on the ask: the next ask comes after the next interval, or never after the last; false when it is not asleep */
export async function keepSleeping(key: string, now = Date.now()): Promise<boolean> {
  let kept = false;
  await updateSnoozes((file) => {
    const e = file.sleeps[key];
    if (!e) return false;
    const step = e.step + 1;
    file.sleeps[key] = { ...e, step, notice_at: noticeAfter(step, now) };
    kept = true;
    return true;
  });
  return kept;
}

/**
 * Mark the cards that are put off, and drop the entries whose card is gone (decided here, from the
 * CLI, or closed) or whose time has passed, so a later card with the same key starts in the front.
 */
export async function applySnoozes(items: InboxItem[], now = Date.now()): Promise<InboxItem[]> {
  try {
    return await markSnoozed(items, now);
  } catch {
    // "あとで" is a view state: when it cannot be read the inbox shows every card in the front
    return items;
  }
}

async function markSnoozed(items: InboxItem[], now: number): Promise<InboxItem[]> {
  const { entries, sleeps } = readSnoozes();
  const live = new Set(items.map(snoozeKey));
  const staleIn = (file: SnoozeFile) =>
    Object.entries(file.entries).filter(([key, e]) => !live.has(key) || !(Date.parse(e.until) > now)).map(([key]) => key);
  // a sleeping card stays asleep however long: its entry goes only with the card
  const goneIn = (file: SnoozeFile) => Object.keys(file.sleeps).filter((key) => !live.has(key));
  if (staleIn({ entries, sleeps }).length || goneIn({ entries, sleeps }).length) {
    try {
      // judged again under the lock: a card put off meanwhile must not be dropped
      await updateSnoozes((file) => {
        const stale = staleIn(file);
        const gone = goneIn(file);
        for (const key of stale) delete file.entries[key];
        for (const key of gone) delete file.sleeps[key];
        return stale.length + gone.length > 0;
      });
    } catch {
      // tidying is best effort: a busy lock must not fail the inbox read
    }
  }
  return items.map((item) => {
    const key = snoozeKey(item);
    const z = sleeps[key];
    if (z) return { ...item, sleptAt: z.at, sleepStep: z.step, ...(z.notice_at ? { sleepNoticeAt: z.notice_at } : {}) };
    const e = entries[key];
    return e && Date.parse(e.until) > now ? { ...item, snoozedUntil: e.until } : item;
  });
}

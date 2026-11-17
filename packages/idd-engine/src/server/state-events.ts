import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { jsonlCacheRevision, stateDir } from "@idd/core";
import { liveConversationIds } from "@idd/lane";

import { etagOf } from "../http.ts";
import { ensureAgentRunner } from "./agent-runner";
import { scheduleCardTexts } from "./card-text.ts";
import { isEmptyOverlay, replayDerived } from "./derived";
import { derivedOverlay, requestDerivationIfChanged } from "./derived-service";
import { applySnoozes, readSnoozes } from "./snooze";
import { engineStaleView } from "./staleness";
import { buildStateWithCosts, type IddState } from "./state";
import { buildWork } from "./work";

/**
 * The state picture, numbered, and the tick that finds it has moved.
 *
 * The screens used to read the state and Work doors every few seconds, which made the number of requests a function
 * of how many screens are open and how long they stay open — and once an answer took longer than the interval, the
 * requests stacked and the engine stopped answering judgments (#172). The engine now finds the change itself and
 * hands the whole picture to whoever is listening, so what a screen asks for is decided by how often the picture
 * moves, and an idle minute costs nothing.
 *
 * Three things can move the picture, and every one of them is watched here, whoever wrote it: the columns (the
 * engine's own writes and the idd CLI's, which appends from its own process), the derivation that reads git and the
 * worktrees, and the values that come from the clock and this process's memory (a sleeping card's hour, the day's
 * cut, the engine's staleness, a running conversation). The tick only stats the columns and reads what is already in
 * memory: the answer itself is derived when something moved, never on every tick.
 *
 * A number a screen holds is only ever compared with numbers from the same engine process: the numbers start from
 * the time, like a conversation's log, so a replaced process's numbers are never read as a continuation of the old
 * one's. A screen that reconnects is handed the whole picture whatever number it carries (the picture can always be
 * overwritten with the current values, unlike a conversation's text), so an engine replacement never leaves a screen
 * quietly showing the state before it.
 */

/** what a screen receives: the whole picture, and the numbers that say when each half of it moved */
export interface StateFrameView {
  /** the state answer's number; a later number is an answer read later, and the stream's `id:` carries it */
  seq: number;
  /** the Work picture's number: it moves only when the Work answer's own content moved */
  workSeq: number;
  state: IddState;
}

export type StateFrameListener = (frame: StateFrameView) => void;

/** how often the columns and the memory are looked at; a change is expected to reach a screen within a few seconds */
export function stateEventsIntervalMs(): number {
  const raw = Number(process.env.IDD_STATE_EVENTS_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000;
}

/**
 * The numbers handed out in this process. Seeded from the time for the same reason a conversation's log is: a screen
 * that still holds a number from the process this one replaced must not read this one's answers as already seen.
 */
let nextNumber = Math.max(Date.now(), 1);

function takeNumber(): number {
  const n = nextNumber;
  nextNumber += 1;
  return n;
}

let lastStateSeq = takeNumber() - 1;
let lastWorkSeq = takeNumber() - 1;
/** the fingerprint of the Work answer's content, without the clock it carries */
let workFingerprint: string | null = null;
/** the picture last handed to the listeners: a derivation that finds the same picture sends nothing */
let emitted: { state: string; work: number } | null = null;

const listeners = new Set<StateFrameListener>();

let timer: ReturnType<typeof setInterval> | null = null;
let lastStamp: string | null = null;

/** the picture a screen that just connected is handed, whatever number it carried: always whole, always now */
export function subscribeStateFrames(listener: StateFrameListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** the number the last derivation of this process was given (a test reads it to see the order) */
export function lastStateNumber(): number {
  return lastStateSeq;
}

function publish(frame: StateFrameView): void {
  const fingerprint = etagOf(JSON.stringify(frame.state));
  if (emitted && emitted.state === fingerprint && emitted.work === frame.workSeq) return;
  emitted = { state: fingerprint, work: frame.workSeq };
  for (const listener of listeners) {
    try {
      listener(frame);
    } catch {
      // one screen that went away must not stop the others, nor the tick that found the change
    }
  }
}

/**
 * The answers are derived one at a time, in the order they were asked for. The numbers are what a screen uses to
 * throw away an answer built before a judgment it has already sent, so a later number must never belong to an
 * earlier look at the columns: two derivations running side by side could finish in either order.
 */
let queue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function liveSessions(): Set<string> {
  return new Set(liveConversationIds());
}

/**
 * The state door's answer: the ledger read here and now (it is what a judgment just wrote), and everything that
 * costs git or a lane's worktree from the last derivation. The snoozes are marked last, as the door always did.
 * The Work picture is built beside it, not to answer a Work read, but so the same derivation can say whether Work
 * moved: its own door is read only when this number says it did.
 */
async function derive(): Promise<StateFrameView> {
  ensureAgentRunner();
  const revision = jsonlCacheRevision();
  const live = liveSessions();
  const state = await buildStateWithCosts({ liveSessions: live }, replayDerived(derivedOverlay()));
  const items = await applySnoozes(state.items);
  // a card that came with no words yet starts its writer here, beside this derivation: the answer below is built
  // from what is on record, and never waits for the run (the record it leaves moves the columns once, and no more)
  scheduleCardTexts(items);
  const answer: IddState = { ...state, items };
  // a column moved under the read: the values that come from git and the worktrees are stale now
  requestDerivationIfChanged(revision);
  const work = buildWork({ liveSessions: live }, replayDerived(derivedOverlay()));

  lastStateSeq = takeNumber();
  const nextWork = etagOf(JSON.stringify({ ...work, now: "" }));
  if (nextWork !== workFingerprint) {
    workFingerprint = nextWork;
    lastWorkSeq = takeNumber();
  }
  const frame: StateFrameView = { seq: lastStateSeq, workSeq: lastWorkSeq, state: answer };
  // a read is a look at the columns too: if the picture it found moved, the screens listening hear it here rather
  // than at the next tick, so a judgment's effect reaches every open screen as soon as one read has seen it
  publish(frame);
  return frame;
}

/** the state door's answer, with the number a screen's floor is kept in */
export function stateAnswer(): Promise<StateFrameView> {
  return oneAtATime(derive);
}

/** what a stream that just connected is handed: the whole picture, never a difference from the screen's number */
export function currentStateFrame(): Promise<StateFrameView> {
  return stateAnswer();
}

// ---- finding that the picture moved ----

/**
 * The columns as they stand: every name under the state's top, its size and modification time, and how many cron runs
 * exist. They are stat'ed, not read — the answer reads them, and a column that changed since the last derivation is
 * found here by its size or its modification time, whichever process appended. The names are not listed in code: a
 * column the answer learns to read later is watched without this file being taught about it, and the answer itself is
 * what decides whether a stamped change moved the picture. The cron runs are thousands of files that only ever gain
 * one, so they are counted rather than stat'ed.
 */
export function columnStamp(dir: string = stateDir()): string {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return "none";
  }
  const parts: string[] = [];
  let cron = 0;
  for (const name of names) {
    if (name.startsWith("cron-run-")) {
      cron += 1;
      continue;
    }
    const st = statSync(join(dir, name), { throwIfNoEntry: false });
    parts.push(`${name}:${st ? `${st.size}/${st.mtimeMs}/${st.ino}` : "gone"}`);
  }
  parts.sort();
  return `${cron}|${parts.join(",")}`;
}

const JST_OFFSET_MS = 9 * 3600 * 1000;

function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The next moment a sleeping or put-off card comes back on its own. A card's hour passing moves the answer without
 * any column moving, so the hour itself is what the tick compares: when it is gone from this value, the card is due.
 */
function nextSnoozeDue(now: number): string {
  const { entries, sleeps } = readSnoozes();
  const due: number[] = [];
  for (const entry of Object.values(entries)) {
    const at = Date.parse(entry.until);
    if (Number.isFinite(at) && at > now) due.push(at);
  }
  for (const sleep of Object.values(sleeps)) {
    const at = sleep.notice_at ? Date.parse(sleep.notice_at) : NaN;
    if (Number.isFinite(at) && at > now) due.push(at);
  }
  return due.length ? String(Math.min(...due)) : "";
}

/**
 * Everything outside the columns that can move the answer: the day's cut, the next sleeping card's hour, what the
 * engine's own watch remembers about the checkout, and the conversations running now (a lane's activity mark reads
 * them, and a conversation that has been quiet long enough stops being one). The minute is here as well: the age a
 * lane's row shows is written in minutes, so a picture built in the next minute can say something else — the clock is
 * looked at once a minute for that, which is the whole of what an idle screen costs.
 */
export function memoryStamp(now: number = Date.now()): string {
  const stale = engineStaleView();
  const live = liveConversationIds(now).join(",");
  return [
    jstDay(now),
    String(Math.floor(now / 60_000)),
    nextSnoozeDue(now),
    `${stale.stale ? "1" : "0"}${stale.landings ?? 0}/${stale.commits ?? 0}/${stale.head ?? ""}`,
    live,
  ].join("|");
}

/** the whole input of the answer as one string: unchanged string, unchanged picture */
export function inputStamp(now: number = Date.now()): string {
  return `${columnStamp()}|${memoryStamp(now)}|${derivedOverlay().revision}`;
}

function tick(): void {
  // nothing has been derived yet (a process that just started): the doors answer from the readers themselves as they
  // always did, and the derivation child's first landing is what this watch starts from. Deriving here first would do
  // that cold reading — a `git` per lane — on the engine's own thread at startup, which is the very stall #172 fixed
  if (isEmptyOverlay(derivedOverlay())) return;
  let stamp: string;
  try {
    stamp = inputStamp();
  } catch {
    // a column that cannot be stat'ed says nothing about the picture: the next tick looks again
    return;
  }
  if (stamp === lastStamp) return;
  lastStamp = stamp;
  stateAnswer().catch((error) => {
    // the last picture stays; the next change asks again
    console.warn(`[idd state events] 状態を組み直せませんでした: ${String(error).slice(0, 400)}`);
  });
}

/**
 * Start the watch. Called from the engine's entry, never from `startEngine` (a test's engine must not start a timer
 * that reads a real state directory). The timer is unref'd, so it never keeps the process alive on its own.
 */
export function startStateEvents(options: { intervalMs?: number } = {}): void {
  if (timer) return;
  tick();
  const every = options.intervalMs ?? stateEventsIntervalMs();
  timer = setInterval(tick, every);
  (timer as { unref?: () => void }).unref?.();
}

export function stopStateEvents(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  listeners.clear();
  lastStamp = null;
  emitted = null;
  workFingerprint = null;
  queue = Promise.resolve();
  nextNumber = Math.max(Date.now(), nextNumber);
  lastStateSeq = takeNumber() - 1;
  lastWorkSeq = takeNumber() - 1;
}

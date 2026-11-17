import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { jsonlCacheRevision } from "@idd/core";
import { emptyOverlay, type DerivedOverlay } from "./derived";

/**
 * The last derivation, and the clock that asks for the next one. The state and Work doors answer from `overlay()`
 * and never read git or a worktree themselves, so an answer costs what the ledger costs and does not wait for a
 * lane's `git` to come back (#172: one answer took 17 to 108 seconds and the poll stacked the engine's event loop
 * shut, so the judgment door stopped answering).
 *
 * A derivation is started when the columns moved (the door tells this module that it read something new) and at a
 * fixed interval even when they did not, because git and the worktrees move without the ledger moving (C-177-3,
 * q1's 30 seconds). The derivation runs in its own process, so the interval's seconds are not seconds the engine
 * cannot answer in: while one runs, requests are served from the value in hand.
 */

/** how long git and the worktrees may lag the ledger when nothing in the ledger moved (q1: 30 seconds) */
export function deriveIntervalMs(): number {
  const raw = Number(process.env.IDD_DERIVE_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export interface DerivationHandlers {
  onOverlay(overlay: DerivedOverlay): void;
  onFail(error: string): void;
}

/** how a derivation is run: the real one is a child process; a test puts its own in */
export interface DerivationRunner {
  start(handlers: DerivationHandlers): void;
  request(): void;
  stop(): void;
}

let overlay: DerivedOverlay = emptyOverlay();
let runner: DerivationRunner | null = null;
let busy = false;
let queued = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function derivedOverlay(): DerivedOverlay {
  return overlay;
}

/** whether a derivation is out; the answer does not wait for it, a test uses it to see that */
export function derivationBusy(): boolean {
  return busy;
}

/**
 * Ask for a derivation now. While one is out the ask is remembered and taken as soon as it lands, so a run of
 * changes asks once rather than a queue of runs.
 */
export function requestDerivation(): void {
  if (!runner) return;
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  runner.request();
}

/**
 * The columns may have moved under the reader that just answered (the judgment door writes from this same process,
 * the idd CLI from its own): if they did, the values that come from them are stale now. The reader takes the
 * revision before its reads and hands it here after.
 */
export function requestDerivationIfChanged(revision: number): void {
  if (jsonlCacheRevision() !== revision) requestDerivation();
}

function landed(next: DerivedOverlay): void {
  // every landing is a new picture, numbered here rather than in the child: a reader compares the number to see
  // whether git and the worktrees moved, and the time the child measured is not that number (two landings can
  // carry the same millisecond)
  overlay = { ...next, revision: overlay.revision + 1 };
  busy = false;
  if (queued) {
    queued = false;
    requestDerivation();
  }
}

function failed(error: string): void {
  busy = false;
  console.warn(`[idd derive] 導き直しに失敗しました: ${error.slice(0, 400)}`);
  if (queued) {
    queued = false;
    requestDerivation();
  }
}

export function startDerivedService(options: { runner?: DerivationRunner } = {}): void {
  if (runner) return;
  runner = options.runner ?? childRunner();
  runner.start({ onOverlay: landed, onFail: failed });
  timer = setInterval(() => requestDerivation(), deriveIntervalMs());
  // the interval is not what keeps the engine up: a test process that starts this must still be able to end
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
}

export function stopDerivedService(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  runner?.stop();
  runner = null;
  busy = false;
  queued = false;
  overlay = emptyOverlay();
}

/** a restart after the child died on its own: long enough not to spin, short enough to catch up in the same minute */
const RESTART_MS = 5_000;

/**
 * The real runner: one child process, kept up between derivations so the columns it has already parsed stay parsed
 * and the lanes' costs stay cached. The child is asked for a new derivation with a line on stdin and answers with
 * one line of JSON. A child that dies is started again; until it answers, the doors keep serving the last value.
 */
function childRunner(): DerivationRunner {
  const script = fileURLToPath(new URL("./derive-child.ts", import.meta.url));
  const boot = fileURLToPath(new URL("./derive-boot.mjs", import.meta.url));
  const bun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

  let handlers: DerivationHandlers | null = null;
  let child: ChildProcess | null = null;
  let buffer = "";
  let stopped = false;
  let restart: ReturnType<typeof setTimeout> | null = null;

  const start = () => {
    if (stopped) return;
    // bun reads the aliases from the checkout's tsconfig; node needs the loader the engine's tests register
    const args = bun ? [script] : [...process.execArgv, boot];
    const next = spawn(process.execPath, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    child = next;
    buffer = "";
    let stderr = "";
    next.stdout?.setEncoding("utf8");
    next.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed: { type?: string; overlay?: DerivedOverlay; error?: string };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue; // anything the child printed that is not its answer
        }
        if (parsed.type === "derived" && parsed.overlay) handlers?.onOverlay(parsed.overlay);
        else if (parsed.type === "derived-error") handlers?.onFail(parsed.error ?? "unknown");
      }
    });
    next.stderr?.setEncoding("utf8");
    next.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-500);
    });
    next.on("error", (err) => {
      handlers?.onFail(String(err));
    });
    next.on("close", () => {
      if (child !== next) return;
      child = null;
      if (stopped) return;
      if (stderr.trim()) console.warn(`[idd derive] 導き直しの子が終わりました: ${stderr.trim()}`);
      restart = setTimeout(() => {
        restart = null;
        start();
      }, RESTART_MS);
      if (restart && typeof restart === "object" && "unref" in restart) restart.unref();
    });
  };

  return {
    start(next) {
      handlers = next;
      start();
    },
    request() {
      if (!child) {
        // no child to ask: start one, whose first derivation is the ask
        if (!restart) start();
        return;
      }
      child.stdin?.write("refresh\n");
    },
    stop() {
      stopped = true;
      if (restart) {
        clearTimeout(restart);
        restart = null;
      }
      child?.kill("SIGTERM");
      child = null;
    },
  };
}

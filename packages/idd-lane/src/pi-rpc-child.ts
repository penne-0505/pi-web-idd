import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";

/*
 * A pi child in `--mode rpc`, spoken to over JSONL on stdin / stdout. The lane supervisor owns the process for
 * one reply: it sends the message as a prompt, waits for pi to say it will not continue, and answers the
 * extension dialogs pi raises. An `ask` question waits for the harness's answer; every other dialog is cancelled
 * at once, so a user's extension cannot hold the reply (the harness has no person to put the question to).
 *
 * Framing is LF only. `U+2028` / `U+2029` are valid inside JSON strings, so a reader that splits on them (Node's
 * `readline`, for one) would cut a record in two; the decoder keeps multi-byte characters whole across chunks and
 * only `\n` ends a record. Every record read is appended to the reply's file as it arrives, whole lines only.
 *
 * The budget counts the time the reply is not waiting on an answer: a person's wait must not cut a reply that is
 * doing nothing but wait, while the time it does work keeps its bound.
 */

export interface PiRpcRecord {
  type?: string;
  [key: string]: unknown;
}

export interface PiRpcReplyExit {
  exit: number;
  ended: "exit" | "timeout" | "stopped";
  spawnError?: string;
  /** pi took the message up: the prompt response said a run started */
  reached: boolean;
  /** the question waits this reply did, with the batch and the milliseconds waited */
  waits: { batchId: string; ms: number }[];
}

export interface PiRpcAsk {
  batchId: string;
  /** hand the answer's body to pi, or null to cancel the dialog (the reply is stopping) */
  finish: (value: string | null) => void;
}

export interface PiRpcReplyOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  message: string;
  eventsPath: string;
  stderrPath: string;
  /** the reply's budget over the time it is not waiting on an answer */
  budgetMs: number;
  /** how soon a reply may be cut for its budget; the role's minutes are the real bound (tests shorten this) */
  floorMs: number;
  stopping: () => boolean;
  onAsk: (ask: PiRpcAsk) => void;
  /** the child's pid, as soon as it is known (the lane record carries it) */
  onPid?: (pid: number) => void;
}

/** how long after `abort` is sent the process is signalled, then forced down */
const ABORT_GRACE_MS = 2000;
const KILL_GRACE_MS = 2000;
/** how often the stop port and the budget are checked */
const TICK_MS = 100;

/** the title an `ask` question carries to the supervisor, and the reading of it */
export function askTitle(batchId: string): string {
  return JSON.stringify({ idd: "ask", batch_id: batchId });
}

/** the batch an extension dialog's title names, or null when the dialog is not an `ask` */
export function parseAskTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(title); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as { idd?: unknown; batch_id?: unknown };
  return o.idd === "ask" && typeof o.batch_id === "string" && o.batch_id ? o.batch_id : null;
}

/** whether pi takes a message as text rather than an extension command: a leading `/` would be expanded */
export function rpcMessageBody(message: string): string {
  return message.startsWith("/") ? ` ${message}` : message;
}

/**
 * Run one reply: start pi, send the message as a prompt, wait for the settle, then close stdin. The promise
 * resolves once the process is gone and every line it printed is in the events file.
 */
export function runPiRpcReply(opts: PiRpcReplyOptions): Promise<PiRpcReplyExit> {
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let buffer = "";
    let done = false;
    let ended: PiRpcReplyExit["ended"] = "exit";
    let spawnError: string | undefined;
    let reached = false;
    const waits: { batchId: string; ms: number }[] = [];
    let pending: { id: string; batchId: string; startedAt: number } | null = null;
    let stopHandled = false;
    let activeMs = 0;
    let lastTick = Date.now();
    let waiting = false;
    const decoder = new TextDecoder("utf-8");
    const timers: {
      budget?: ReturnType<typeof setInterval>;
      stop?: ReturnType<typeof setInterval>;
      abort?: ReturnType<typeof setTimeout>;
      kill?: ReturnType<typeof setTimeout>;
    } = {};

    const finish = (exit: number) => {
      if (done) return;
      done = true;
      // a reply whose supervisor is stopping is stopped, whichever path cancelled the question first
      if (ended === "exit" && opts.stopping()) ended = "stopped";
      clearInterval(timers.budget);
      clearInterval(timers.stop);
      clearTimeout(timers.abort);
      clearTimeout(timers.kill);
      resolve({ exit, ended, ...(spawnError ? { spawnError } : {}), reached, waits });
    };

    const write = (record: Record<string, unknown>) => {
      try { child?.stdin?.write(`${JSON.stringify(record)}\n`); } catch { /* the child is gone */ }
    };

    const finishAsk = (value: string | null) => {
      if (!pending) return;
      const { id, batchId, startedAt } = pending;
      pending = null;
      waiting = false;
      lastTick = Date.now();
      waits.push({ batchId, ms: Date.now() - startedAt });
      write({ type: "extension_ui_response", id, ...(value === null ? { cancelled: true } : { value }) });
    };

    const onLine = (line: string) => {
      // the record first: the reply's file holds exactly what pi printed, whole lines in arrival order
      try { appendFileSync(opts.eventsPath, `${line}\n`); } catch { /* the record is best effort */ }
      let record: PiRpcRecord;
      try { record = JSON.parse(line) as PiRpcRecord; } catch { return; }
      switch (record.type) {
        case "response": {
          if (record.command !== "prompt") return;
          const disposition = (record.data as { disposition?: unknown } | undefined)?.disposition;
          if (record.success === true && disposition === "started") { reached = true; return; }
          // pi did not start a run on the message: close stdin so the process exits, and the message goes back
          try { child?.stdin?.end(); } catch { /* gone */ }
          return;
        }
        case "agent_settled":
          // pi will not continue on its own: an orderly shutdown closes stdin
          try { child?.stdin?.end(); } catch { /* gone */ }
          return;
        case "extension_ui_request": {
          const id = record.id;
          const method = record.method;
          if (typeof id !== "string") return;
          if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return;
          const batchId = method === "input" ? parseAskTitle(record.title) : null;
          if (batchId && !pending) {
            pending = { id, batchId, startedAt: Date.now() };
            waiting = true;
            lastTick = Date.now();
            opts.onAsk({ batchId, finish: finishAsk });
            return;
          }
          // every other dialog is cancelled at once: a user extension must not hold the reply
          write({ type: "extension_ui_response", id, cancelled: true });
          return;
        }
        default:
          return;
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) break;
        let line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        onLine(line);
      }
    };

    try {
      child = spawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      spawnError = String(err);
      // the reply's stream file exists whether or not the harness started, as before
      try { appendFileSync(opts.eventsPath, ""); } catch { /* nothing */ }
      finish(-1);
      return;
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (d: Buffer) => { try { appendFileSync(opts.stderrPath, d); } catch { /* nothing */ } });
    child.on("error", (err) => { spawnError = String(err); if (child?.pid === undefined) finish(-1); });
    // pi that exits before reading stdin fails the writes with EPIPE: without this the error is unhandled and takes
    // the supervisor down; the child's close is the reply's end either way
    child.stdin?.on("error", () => { /* pi exited before reading it all; its exit says why */ });
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
    if (child.pid !== undefined) opts.onPid?.(child.pid);

    timers.budget = setInterval(() => {
      const now = Date.now();
      if (!waiting) activeMs += now - lastTick;
      lastTick = now;
      if (activeMs >= Math.max(opts.budgetMs, opts.floorMs)) {
        ended = "timeout";
        try { child?.kill("SIGTERM"); } catch { /* gone */ }
      }
    }, TICK_MS);
    timers.stop = setInterval(() => {
      if (stopHandled || !opts.stopping()) return;
      stopHandled = true;
      ended = "stopped";
      finishAsk(null);
      write({ type: "abort" });
      timers.abort = setTimeout(() => { try { child?.kill("SIGTERM"); } catch { /* gone */ } }, ABORT_GRACE_MS);
      timers.kill = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* gone */ } }, ABORT_GRACE_MS + KILL_GRACE_MS);
    }, TICK_MS * 2);

    write({ id: "reply-1", type: "prompt", message: rpcMessageBody(opts.message) });
  });
}

import { spawn } from "node:child_process";

import { agentEnv } from "./agent-env.ts";
import { piBinary } from "./paths.ts";

/**
 * The parts of a one-shot `pi -p --mode json` run that every caller of one needs: the child with its stdin closed and
 * a clock on it, and the assistant messages of the JSONL it writes. The canary and the question router each decide
 * what a message is worth; this file only starts the child and reads its lines.
 */

/** what a one-shot run left behind when its process ended */
export interface PiRun {
  stdout: string;
  stderr: string;
  /** the clock ended it */
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** how long a child gets after SIGTERM before SIGKILL, and after SIGKILL before the run is given up on */
export const KILL_GRACE_MS = 5_000;

/** how long the pipes get to hand over what the child wrote, once the child itself has ended */
export const DRAIN_MS = 300;

/**
 * Starts pi with `args` and resolves when the process has ended, whatever its code: a caller reads the facts and
 * decides what a non-zero exit or a timeout means. It rejects only when the process cannot start. stdin is closed,
 * because `pi -p` waits for piped input otherwise and never returns.
 *
 * The run ends with the child, not with its pipes. A grandchild that inherited stdout/stderr keeps them open after
 * the child has answered and exited, so `close` may never come; the run waits `drainMs` for the pipes to hand over
 * what is left, then lets go of them and resolves with what was read. A run the clock ended is still read as timed
 * out, and what it had written is the caller's to ignore.
 *
 * The clock ends the run in three steps, so the promise always settles: SIGTERM at the limit, SIGKILL `graceMs`
 * later if the child has not closed, and `graceMs` after that the run is resolved as it stands even if no close
 * came. The caller waiting on the promise (the judge holds a batch until it settles) is never left waiting on a child
 * that ignores signals. A run the clock ended has `timedOut` set, whichever step ended it. A child that had already
 * ended when the limit came is not one the clock ended, even when a stalled event loop ran the limit before the exit notice.
 */
export function runPiOnce(args: string[], opts: { agentDir: string; timeoutMs: number; cwd?: string; env?: Record<string, string>; graceMs?: number; drainMs?: number }): Promise<PiRun> {
  return new Promise((resolve, reject) => {
    const graceMs = opts.graceMs ?? KILL_GRACE_MS;
    const drainMs = opts.drainMs ?? DRAIN_MS;
    const child = spawn(piBinary(), args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: agentEnv(process.env, { PI_CODING_AGENT_DIR: opts.agentDir, PI_DISABLE_UPDATE_CHECK: "1", ...opts.env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const run: PiRun = { stdout: "", stderr: "", timedOut: false, code: null, signal: null };
    for (const [stream, key] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) stream.on("data", (chunk) => { run[key] += String(chunk); });
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    const clearAll = () => { for (const t of timers) clearTimeout(t); };
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearAll();
      resolve({ ...run, code, signal });
    };
    let exited = false;
    timers.push(setTimeout(() => {
      // A stalled event loop runs this timer before the exit notice of a child that ended before the limit. The notice is
      // read in the poll phase that follows, so look again after it: a child that has ended is not timed out.
      setImmediate(() => {
        if (settled || exited || child.exitCode !== null || child.signalCode !== null) return;
        run.timedOut = true;
        child.kill("SIGTERM");
        timers.push(setTimeout(() => {
          child.kill("SIGKILL");
          timers.push(setTimeout(() => {
            // no close even after SIGKILL: let go of the child's pipes and give the caller what was read
            child.stdout.destroy();
            child.stderr.destroy();
            settle(null, "SIGKILL");
          }, graceMs));
        }, graceMs));
      });
    }, opts.timeoutMs));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearAll();
      reject(err);
    });
    child.on("exit", (code, signal) => {
      exited = true;
      // the child is gone: a clock that has not fired yet no longer has anything to stop, so a run that ended before its limit is never read as timed out while the pipes drain.
      // A clock that already fired keeps `timedOut`; its kill steps are dropped because the child they were for has ended.
      clearAll();
      // close ends the run at once when the pipes are done, and the drain ends it when a grandchild holds them
      timers.push(setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(code, signal);
      }, drainMs));
    });
    child.on("close", (code, signal) => settle(code, signal));
  });
}

/** why a run that did not end well ended, as the line a failure carries */
export function piExitText(run: PiRun): string {
  return `pi が ${run.signal ?? `exit ${run.code}`} で終了${run.stderr ? `: ${run.stderr.slice(-300)}` : ""}`;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: { type?: string; text?: unknown } | null) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

/** one assistant turn of the run: its text and the usage pi reported for that turn */
export interface AssistantTurn {
  text: string;
  usage?: Record<string, unknown>;
}

/** the assistant turns of the JSONL a `--mode json` run writes, in order; a line that is not JSON is skipped */
export function assistantTurns(stdout: string): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let record: { type?: string; message?: { role?: unknown; content?: unknown; usage?: Record<string, unknown> } };
    try { record = JSON.parse(line); } catch { continue; }
    const message = record.message;
    if (record.type !== "message_end" || !message || message.role !== "assistant") continue;
    turns.push({ text: textOf(message.content), ...(message.usage ? { usage: message.usage } : {}) });
  }
  return turns;
}

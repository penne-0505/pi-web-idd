import { execFileSync, spawnSync } from "node:child_process";

export function git(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: opts.timeout ?? 120000, stdio: ["ignore", "pipe", "pipe"],
    ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
  });
}

export function gitTry(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

/**
 * git with bytes in and out, for the plumbing that moves objects (a pack in, a tree out). `env` is added to this one
 * call only: a temporary index, an author. Like `git`, it is not an agent, so it starts from the process environment.
 */
export function gitBytes(cwd: string, args: string[], opts: { input?: Buffer; env?: Record<string, string> } = {}): Buffer {
  return execFileSync("git", args, {
    cwd, ...(opts.input ? { input: opts.input } : {}), env: { ...process.env, ...opts.env },
    timeout: 120000, maxBuffer: 1024 * 1024 * 1024, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

export function isClean(cwd: string): boolean {
  return git(cwd, ["status", "--short"]).trim() === "";
}

export function headOf(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** run a shell command in the foreground with a hard timeout; never detaches */
export function runShell(cwd: string, command: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const started = Date.now();
  const r = spawnSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = r.error?.name === "Error" && String(r.error.message).includes("ETIMEDOUT") || r.signal === "SIGTERM";
  return {
    exit: r.status ?? (timedOut ? 124 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    durationMs: Date.now() - started,
    timedOut,
  };
}

export function tail(text: string, lines = 40): string {
  const arr = text.trimEnd().split("\n");
  return arr.slice(-lines).join("\n");
}

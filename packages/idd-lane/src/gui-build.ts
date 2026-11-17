import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GUI_BUILD_COMMAND, GUI_STAMP_FILE, guiBundleDir, readBundleCommit } from "../../idd-core/src/install/gui-bundle.ts";
import { resolveStateDir } from "../../idd-core/src/install/pointers.ts";
import { repoRoot } from "./paths.ts";

/**
 * Rebuilding the screen's bundle from the checkout.
 *
 * The engine asks for this as a systemd transient unit (it never builds inside its own process: a build would be
 * cut by the engine's own replacement and would count as an in-flight request). This module is the command that
 * unit runs: build the bundle at the checkout's head and record the result. The engine reads `dist/` on every
 * request, so a new bundle is served without a restart. The build puts the bundle in place only when it is whole
 * (`packages/idd-gui/build.ts`), so a failed build leaves the earlier bundle, and the engine decides on the
 * bundle's own commit stamp whether that earlier bundle may still be served.
 */

export const GUI_BUILD_RECORD_FILE = "gui-build.json";
export const GUI_BUILD_LOG_FILE = "gui-build.log";
export { GUI_BUILD_COMMAND, GUI_STAMP_FILE, guiBundleDir, readBundleCommit };

/** the build's result as the state and the screen read it */
export interface GuiBuildRecord {
  startedAt: string;
  finishedAt?: string;
  head?: string;
  /** running: the build is under way; no-change: the bundle is already the head's; failed: the build's exit was not 0 */
  outcome: "running" | "no-change" | "built" | "failed";
  /** why it did nothing (the bundle is already the head's) */
  reason?: string;
  exitCode?: number;
  logPath?: string;
}

/** how the build is run; a test stands in for the real shell */
export type BuildRunner = (cmd: string, args: string[], opts?: { cwd?: string; log?: string; timeoutMs?: number }) => { status: number | null; error?: Error };

const defaultRunner: BuildRunner = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  if (opts.log) {
    try {
      writeFileSync(opts.log, `${r.stdout ?? ""}${r.stderr ? `\n${r.stderr}` : ""}`);
    } catch {
      // a log that cannot be written never changes the build's outcome
    }
  }
  return { status: r.status, ...(r.error ? { error: r.error } : {}) };
};

function stateOf(env: NodeJS.ProcessEnv, root: string): string {
  return resolveStateDir({ checkout: root, env });
}

function gitOut(root: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "" };
}

function writeRecord(path: string, record: GuiBuildRecord): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // the record is for the screen; failing to write it never fails the build
  }
}

export interface GuiBuildOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  run?: BuildRunner;
  now?: () => Date;
}

/**
 * The build command: build the bundle at the checkout's head unless it already is the head's, and record the result
 * under the state for the engine and the screen to read.
 */
export async function runGuiBuild(opts: GuiBuildOptions = {}): Promise<GuiBuildRecord> {
  const root = opts.root ?? repoRoot();
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRunner;
  const now = opts.now ?? (() => new Date());
  const state = stateOf(env, root);
  const recordPath = join(state, GUI_BUILD_RECORD_FILE);
  const logPath = join(state, GUI_BUILD_LOG_FILE);
  const record: GuiBuildRecord = { startedAt: now().toISOString(), outcome: "running" };

  const head = gitOut(root, ["rev-parse", "HEAD"]);
  if (head.ok && head.stdout.trim()) record.head = head.stdout.trim();
  writeRecord(recordPath, record);

  if (record.head && readBundleCommit(guiBundleDir(root)) === record.head) {
    record.outcome = "no-change";
    record.reason = "bundle は HEAD と同じ commit から作られている";
    record.finishedAt = now().toISOString();
    writeRecord(recordPath, record);
    return record;
  }

  const [cmd, ...args] = [...GUI_BUILD_COMMAND];
  mkdirSync(state, { recursive: true });
  const built = run(cmd, args, { cwd: root, log: logPath });
  record.logPath = logPath;
  record.finishedAt = now().toISOString();
  if (built.status !== 0 || built.error) {
    record.outcome = "failed";
    record.exitCode = built.status ?? -1;
  } else {
    record.outcome = "built";
  }
  writeRecord(recordPath, record);
  return record;
}

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { installRecordPath, readInstallRecord, type InstallRecord } from "./records.ts";

/**
 * Where the state and the pi are, decided in one place for every TypeScript caller: the value the environment was
 * given, else install.json's, else the default. (bin/pointers.sh is the same order for the two shell entrances.)
 * The record counts only when its checkout is this code's own checkout, so a lane's worktree or another clone never
 * borrows the machine's pointers. Nothing is written: a caller that wants children to inherit the value calls
 * `settlePointers`.
 *
 * The record is read once per process, the first time an answer needs it, and kept: an `idd install` that rewrites it
 * later changes what the next process starts with, not what a running one reads and writes. (The environment is not
 * cached; it is the process's own and a child it starts is given the settled value.)
 */

const recordsRead = new Map<string, InstallRecord | null>();

function recordOfThisProcess(home: string | undefined): InstallRecord | null {
  const key = installRecordPath(home);
  if (!recordsRead.has(key)) recordsRead.set(key, readInstallRecord(home));
  return recordsRead.get(key) ?? null;
}

/** the state and pi the install record names for this checkout; empty when there is no record or it is for another checkout */
export function installedPointers(checkout: string, env: NodeJS.ProcessEnv = process.env): { stateDir?: string; piBin?: string } {
  const record = recordOfThisProcess(env.HOME?.trim() || undefined);
  if (!record || !sameDir(record.checkout, checkout)) return {};
  return { ...(record.state_dir ? { stateDir: record.state_dir } : {}), ...(record.pi_bin ? { piBin: record.pi_bin } : {}) };
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** the state someone named, absolute: IDD_STATE_DIR (a relative one is read against the cwd), else the record's; undefined when neither */
export function namedStateDir(opts: { checkout: string; env?: NodeJS.ProcessEnv }): string | undefined {
  const env = opts.env ?? process.env;
  const given = env.IDD_STATE_DIR?.trim();
  if (given) return resolve(given);
  const recorded = installedPointers(opts.checkout, env).stateDir;
  return recorded ? resolve(recorded) : undefined;
}

/** the one absolute state: the named one, else `<checkout>/state` */
export function resolveStateDir(opts: { checkout: string; env?: NodeJS.ProcessEnv }): string {
  return namedStateDir(opts) ?? join(opts.checkout, "state");
}

/** the pi a process starts: IDD_PI_BIN, else the record's, else the checkout's own node_modules, else `pi` on PATH */
export function resolvePiBin(opts: { checkout: string; env?: NodeJS.ProcessEnv }): string {
  const env = opts.env ?? process.env;
  const given = env.IDD_PI_BIN?.trim();
  if (given) return given;
  const recorded = installedPointers(opts.checkout, env).piBin;
  if (recorded) return recorded;
  const local = join(opts.checkout, "node_modules", ".bin", "pi");
  return existsSync(local) ? local : "pi";
}

/**
 * Put the decided state (always) and the recorded pi (when the environment has none) into `env`, so a process this one
 * starts inherits the same values and does not decide again. A pi no one named stays unset: `resolvePiBin` falls back.
 */
export function settlePointers(opts: { checkout: string; env?: NodeJS.ProcessEnv }): { stateDir: string } {
  const env = opts.env ?? process.env;
  const stateDir = resolveStateDir(opts);
  env.IDD_STATE_DIR = stateDir;
  if (!env.IDD_PI_BIN?.trim()) {
    const piBin = installedPointers(opts.checkout, env).piBin;
    if (piBin) env.IDD_PI_BIN = piBin;
  }
  return { stateDir };
}

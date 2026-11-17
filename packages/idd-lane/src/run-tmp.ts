import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { lanesRoot } from "./paths.ts";
import { repoForPath } from "./repos.ts";

/*
 * A lane run's temp dir. A repo that names `tmp_dir` in config/repos.yaml gives each run on its worktrees or review
 * copies a dir of its own, <tmp_dir>/<state>/<run id>, as TMPDIR / TEMP / TMP: what the run's agent and its shell write
 * to the temp dir (flutter test leaves 0.4-1GB of flutter_tools.* per run, and more when it is killed) goes to that
 * disk instead of the machine's /tmp, and goes away with the run. A repo that names none changes nothing.
 *
 * <state> is a short hash of the runs' records dir (<state>/lanes). Every process that reads the same registry shares
 * tmp_dir (another checkout's CLI, a bench with its own IDD_STATE_DIR), but whether a run is alive can only be read
 * from the records of the state it belongs to; so each state keeps its own dirs under its own name, and a sweep looks
 * only there.
 */

/** a run id as claimLaneId makes it (<yyyymmdd>-<hhmmss>-<role>[-n]); only such names are made and taken down */
const RUN_ID = /^\d{8}-\d{6}-[A-Za-z0-9_.-]+$/;

/**
 * How long a dir is kept when no live run is known for it: a dir is made before the run's record names a process
 * (a lane's record is written after its environment is built, a follow-up names its pid after the spawn)
 */
export const RUN_TMP_GRACE_MS = 10 * 60 * 1000;

/** whether the run that owns a dir is alive: read from the run's own record by the caller */
export type RunAlive = (runId: string) => boolean;

/** a path with its links resolved, as far as it exists (a root not made yet is compared by its existing parent) */
function realOf(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) {
    try { return realpathSync(abs); } catch { return abs; }
  }
  const parent = dirname(abs);
  return parent === abs ? abs : join(realOf(parent), basename(abs));
}

/** the name this state's runs keep their dirs under: a short hash of its records dir */
function stateKey(): string {
  return createHash("sha256").update(realOf(lanesRoot())).digest("hex").slice(0, 12);
}

/**
 * This state's root for the runs' temp dirs of the worktree's repo; null when the repo names none or the registry
 * cannot be read. A tmp_dir in the runs' records (<state>/lanes) or under it is not used: the records are dirs named by
 * run ids too.
 */
export function runTmpRoot(worktree: string | undefined): string | null {
  if (!worktree) return null;
  let root: string | null;
  try {
    root = repoForPath(worktree)?.tmpDir ?? null;
  } catch {
    // a registry that cannot be read is reported by the engine's own reading of it; the run keeps the engine's temp dir
    return null;
  }
  if (!root) return null;
  const records = realOf(lanesRoot());
  const real = realOf(root);
  if (real === records || real.startsWith(`${records}/`)) return null;
  return join(root, stateKey());
}

/** a run's own temp dir, or null when its repo names no root */
export function runTmpDir(runId: string, worktree: string | undefined): string | null {
  const root = runTmpRoot(worktree);
  return root && RUN_ID.test(runId) ? join(root, runId) : null;
}

/**
 * The variables that send a run's temp files to its own dir, with the dir made (or its time renewed, so a sweep reads
 * it as in use) and the leftovers of this state's runs that are gone taken down first. {} for a repo that names no
 * root, and when the dir cannot be made (the run then keeps the engine's temp dir rather than one that does not exist).
 */
export function runTmpEnv(runId: string, worktree: string | undefined, alive: RunAlive): Record<string, string> {
  const root = runTmpRoot(worktree);
  if (!root || !RUN_ID.test(runId)) return {};
  const dir = join(root, runId);
  sweepRunTmp(root, alive, { keep: runId });
  try {
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    utimesSync(dir, now, now);
  } catch {
    return {};
  }
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/** take down a run's temp dir once the run has ended; nothing for a repo that names no root */
export function removeRunTmp(runId: string, worktree: string | undefined): void {
  const dir = runTmpDir(runId, worktree);
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* a file still held open goes with the next sweep */ }
}

/**
 * Take down the dirs under a root whose run is not alive and that have not changed for the grace: a run killed with
 * the engine or the machine leaves its dir, and the next run of the repo removes it. Only names shaped like a run id
 * are touched, so a root shared with other files keeps them.
 */
export function sweepRunTmp(root: string, alive: RunAlive, opts: { keep?: string; now?: number } = {}): string[] {
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (name === opts.keep || !RUN_ID.test(name)) continue;
    const path = join(root, name);
    try {
      if (now - lstatSync(path).mtimeMs <= RUN_TMP_GRACE_MS) continue;
      if (alive(name)) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch { /* gone already, or held: the next run tries again */ }
  }
  return removed;
}

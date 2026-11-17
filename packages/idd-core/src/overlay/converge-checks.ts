import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AreaCheck } from "../config/areas.ts";
import { alive } from "../worktree/copies.ts";
import { checksRunning, read, recordPath, save } from "./git.ts";
import type { GateCheck } from "./gate.ts";
import { heavyLockHeld, heavyOwner, sweepHeavyLock } from "./heavy-lock.ts";
import { canScopeLandCheck, landCheckCommand, landCheckRunningFor, laneSlice, systemdRunBinary } from "./land-run.ts";

/**
 * The checks a repo runs at a lane's head before the S2 review loop converges (`checks_before_converge`), as a run of
 * their own: the loop starts one and goes on with its tick, and a later tick reads what the run wrote. A Flutter test
 * takes 35 minutes; run inside the tick it would hold every other lane's stages that long.
 *
 * The run holds the repo's heavy-checks lock for its whole life (heavy-lock.ts), never the overlay lock: two long checks
 * of one repo (the Flutter test) never run side by side (out of memory, a full /tmp), while an executor's start, a
 * mainline merge, a submit's preparation and an import of the repo go on. The submit's checks take the same lock inside
 * the overlay lock (overlay → heavy, and this run takes no overlay lock, so no ring of waits). A run the lock or a
 * landing check of the repo keeps out waits as `busy` (the lane still reads as checking), and the loop starts it again
 * as the same run once they are free; one that waited past its limit is put to penne by the loop.
 *
 * The checks run in a detached copy (the lane's worktree is never touched) of the tree the submit would check now: the
 * head without the records merged over the public base's tip, built by the submit's own function (`submitTreeOf`), and
 * told the files the submit would tell them. The failures are compared with that tip without the records, by the
 * submit's own comparison (`withBaseComparison`), and the results are kept by tree for the submit to read
 * (`check-results.ts`): while the public base stays where it was, the submit runs neither the head's checks nor the
 * base's again. When that tree cannot be had (the public side cannot be fetched, the head conflicts with it, the submit
 * would refuse), the run checks the head's own tree and compares with the lane's base (the merge-base with the work
 * side's mainline), as it did before, and says why in its record (`basis_note`).
 */

/** what a run's tree was built on: the public base's tip merged with the head (the submit's), or the head alone against the lane's base */
export type ConvergeBasis = "public" | "lane";

export type ConvergeRunStatus = "running" | "done" | "failed" | "busy";

/** what the detached run needs */
export interface ConvergeCheckSpec {
  runId: string;
  lane: string;
  area: string;
  /** the lane's worktree: the copy is cut from its clone, the lock is its clone's */
  repo: string;
  /** the clone the files in `copy` are taken from */
  from: string;
  head: string;
  /**
   * the lane's base (a commit; its records are left out): the failures are compared at it when the run cannot build the
   * submit's tree, which it does itself under the heavy-checks lock
   */
  base: string;
  checks: AreaCheck[];
  /** the files the lane changed against `base`, told the checks (IDD_CHANGED_FILES) of the head's own tree */
  changed: string[];
  manifestPaths: string[];
  deps?: string;
}

/** one lane's newest run of the checks before the convergence */
export interface ConvergeCheckRun {
  id: string;
  lane: string;
  status: ConvergeRunStatus;
  started_at: string;
  ended_at?: string;
  /** the run process, once it named itself */
  pid?: number;
  /** the process the launcher started, until the run names itself */
  spawn_pid?: number;
  repo: string;
  head: string;
  /** the commit a failure is compared with: the lane's base until the run built its tree, then the one it compared with */
  base: string;
  /** the tree the checks ran on, without the records */
  tree?: string;
  /** what that tree was built on */
  basis?: ConvergeBasis;
  /** why the run checked the head's own tree and not the submit's */
  basis_note?: string;
  /** the checks' rows, each compared with `base` when it failed */
  rows?: GateCheck[];
  error?: string;
  log?: string;
  /** what the run was started with, so a run the repo's checks kept out (`busy`) starts again as the same run */
  spec?: ConvergeCheckSpec;
  /** since when the run has waited for the repo's heavy checks (set at the first `busy`, cleared when it starts) */
  waiting_since?: string;
}

/** how long a record that names no process is taken as starting */
const START_GRACE_MS = 30_000;

export function convergeRunPath(lane: string): string { return recordPath("converge-check", lane); }
export function readConvergeRun(lane: string): ConvergeCheckRun | null {
  try { return read<ConvergeCheckRun>(convergeRunPath(lane)); } catch { return null; }
}
export function saveConvergeRun(rec: ConvergeCheckRun): ConvergeCheckRun { save(convergeRunPath(rec.lane), rec); return rec; }

/**
 * Whether the repo's heavy checks are taken now: its heavy-checks lock is held (after the sweep), a holder of its overlay
 * lock marked it as checking (a submit or an import about to take the heavy lock), or a landing check runs
 */
export function repoChecksBusy(repo: string): boolean {
  try {
    if (heavyLockHeld(repo) || checksRunning(repo)) return true;
  } catch { return true; }
  return landCheckRunningFor(repo);
}

/** the holder the repo's heavy-checks lock names, in words for a stop */
export function heavyHolderText(repo: string): string {
  try {
    const owner = heavyOwner(repo);
    return owner ? `run ${owner.run || "なし"}・pid ${owner.pid}・${owner.at} から` : landCheckRunningFor(repo) ? "取り込みの検査" : "持ち主の書かれていない lock";
  } catch { return "読めない lock"; }
}

/** whether the run the record names still has a process */
function runAlive(rec: ConvergeCheckRun, now = Date.now()): boolean {
  if (rec.status !== "running") return false;
  if (rec.pid) return alive(rec.pid);
  if (rec.spawn_pid && alive(rec.spawn_pid)) return true;
  const started = Date.parse(rec.started_at ?? "");
  return !Number.isNaN(started) && now - started < START_GRACE_MS;
}

/**
 * The lane's run as the loop reads it: a run that says it is running with no process behind it died (a kill, a
 * machine that went down), so it is closed as failed here and the lock it held is let go. Null when the lane's newest
 * run is not the one named.
 */
export function settleConvergeRun(lane: string, runId: string): ConvergeCheckRun | null {
  const rec = readConvergeRun(lane);
  if (!rec || rec.id !== runId) return null;
  if (rec.status !== "running" || runAlive(rec)) return rec;
  // the lock a dead run held names its gone process: the sweep lets it go, whoever holds the lane
  try { sweepHeavyLock(rec.repo); } catch { /* a repo git cannot read holds no lock */ }
  return saveConvergeRun({ ...rec, status: "failed", ended_at: new Date().toISOString(), error: rec.error ?? "検査の run の process が消えました" });
}

/** what the loop hands the launcher to start a run */
export type ConvergeCheckInput = Omit<ConvergeCheckSpec, "runId">;

/** what the loop reads of a run */
export interface ConvergeRunReading { id: string; lane: string; status: ConvergeRunStatus; rows?: GateCheck[]; base?: string; basis?: ConvergeBasis; error?: string; waitingSince?: string; holder?: string }

/** the seam the loop starts and reads runs through: the detached run, or a test's stand-in */
export interface ConvergeCheckLauncher {
  /** start a run; one the repo's heavy checks keep out is recorded as waiting (`busy`) and started later by `restart` */
  start(input: ConvergeCheckInput): { id: string } | null;
  /** the run as it stands, or null when the lane's newest run is another */
  status(lane: string, runId: string): ConvergeRunReading | null;
  /** start again, as the same run, a run the repo's checks kept out; false while they still do */
  restart(lane: string, runId: string): boolean;
}

/** the run's own entry point */
export function convergeCheckScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "converge-check-run.ts");
}

/** where the run's own output is kept */
function logPath(lane: string): string {
  const p = join(dirname(convergeRunPath(lane)), "logs");
  mkdirSync(p, { recursive: true });
  return join(p, `${randomBytes(6).toString("hex")}.log`);
}

/** the command a run is started with, in its own scope when systemd is used (the landing check's way) */
function launch(script: string, specPath: string, runId: string): { cmd: string; args: string[] } {
  const direct = landCheckCommand(script, specPath, { ...process.env, IDD_LAND_CHECK_BIN: process.env.IDD_CONVERGE_CHECK_BIN ?? "" });
  if (!canScopeLandCheck()) return direct;
  return {
    cmd: systemdRunBinary(),
    args: ["--user", "--scope", "--quiet", "--collect", `--unit=idd-converge-${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}`, `--slice=${laneSlice()}`, direct.cmd, ...direct.args],
  };
}

/** start the detached process of a run whose record is written */
function spawnRun(rec: ConvergeCheckRun, spec: ConvergeCheckSpec): void {
  const dir = dirname(convergeRunPath(spec.lane));
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, `${spec.runId}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const log = rec.log ?? logPath(spec.lane);
  const how = launch(convergeCheckScript(), specPath, spec.runId);
    const fd = openSync(log, "a");
    try {
      const child = spawn(how.cmd, how.args, { detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
      saveConvergeRun({ ...rec, log, spawn_pid: child.pid ?? undefined });
    } catch (err) {
      saveConvergeRun({ ...rec, status: "failed", ended_at: new Date().toISOString(), error: `検査の run を起動できませんでした: ${String((err as Error).message ?? err).slice(0, 200)}` });
      try { rmSync(specPath, { force: true }); } catch { /* left for the next sweep */ }
    } finally { closeSync(fd); }
}

/** the detached run, as the engine starts it */
export const detachedLauncher: ConvergeCheckLauncher = {
  start(input) {
    const id = `${process.pid.toString(36)}${randomBytes(6).toString("hex")}`;
    const spec: ConvergeCheckSpec = { runId: id, ...input };
    const now = new Date().toISOString();
    // the repo's heavy checks are taken: the run is on record as waiting, so the lane reads as checking and the wait
    // is counted from now
    if (repoChecksBusy(input.repo)) {
      saveConvergeRun({ id, lane: input.lane, status: "busy", started_at: now, repo: input.repo, head: input.head, base: input.base, log: logPath(input.lane), spec, waiting_since: now });
      return { id };
    }
    const rec = saveConvergeRun({ id, lane: input.lane, status: "running", started_at: now, repo: input.repo, head: input.head, base: input.base, log: logPath(input.lane), spec });
    spawnRun(rec, spec);
    return { id };
  },
  restart(lane, runId) {
    const rec = readConvergeRun(lane);
    if (!rec || rec.id !== runId || rec.status !== "busy" || !rec.spec) return false;
    if (repoChecksBusy(rec.repo)) return false;
    const again: ConvergeCheckRun = { ...rec, status: "running", started_at: new Date().toISOString() };
    delete again.ended_at;
    delete again.error;
    delete again.pid;
    delete again.spawn_pid;
    delete again.waiting_since;
    saveConvergeRun(again);
    spawnRun(again, rec.spec);
    return true;
  },
  status(lane, runId) {
    const rec = settleConvergeRun(lane, runId);
    if (!rec) return null;
    return {
      id: rec.id, lane: rec.lane, status: rec.status, ...(rec.rows ? { rows: rec.rows } : {}), base: rec.base, ...(rec.basis ? { basis: rec.basis } : {}), ...(rec.error ? { error: rec.error } : {}),
      ...(rec.status === "busy" ? { waitingSince: rec.waiting_since ?? rec.ended_at ?? rec.started_at, holder: heavyHolderText(rec.repo) } : {}),
    };
  },
};

let current: ConvergeCheckLauncher | null = null;

/** the launcher the loop uses: the detached run, unless a test stood in for it */
export function convergeCheckLauncher(): ConvergeCheckLauncher { return current ?? detachedLauncher; }

/** for the tests: stand in for the detached run (null puts it back) */
export function setConvergeCheckLauncher(launcher: ConvergeCheckLauncher | null): void { current = launcher; }

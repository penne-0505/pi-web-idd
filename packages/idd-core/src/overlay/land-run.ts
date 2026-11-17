import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as yamlLoad } from "js-yaml";

import { rolesPath } from "../config/pipeline.ts";
import { stateDir } from "../paths.ts";
import { alive, dropCopy } from "../worktree/copies.ts";
import { checksRunning, dir, git, key, read, recordPath, save } from "./git.ts";
import type { AreaCheck } from "../config/areas.ts";
import type { AreaIncrement } from "../config/increments.ts";
import type { GateCheck } from "./gate.ts";
import type { StructureMeasure } from "./structure.ts";
import type { LandClose, LandInherit } from "./land.ts";

/**
 * One landing check as a run of its own: the merge commit the preparation made is checked in a detached copy by a
 * process that outlives whoever asked for it, and the result is written into the land record. The tick, the card and
 * the CLI start one and return; the next tick and the card read what the run wrote (C-144-1).
 *
 * The record is also the mark that the check is running (C-144-8): the overlay lock is held only while the merge
 * commit and the copy are made (C-144-2), so the old `checks: true` lock no longer says a check is running. One
 * record per lane holds that lane's newest check, so a run that a newer one replaced never writes over it (C-144-6).
 */

/** how long a record that names no process is taken as starting, the same grace the lane runs use (IDD-114) */
export const LAND_RUN_START_GRACE_MS = 30_000;

/** the landing checks that may run at once, when `IDD_LAND_CHECK_LIMIT` names none (the Issue's value) */
export const DEFAULT_LAND_CHECK_LIMIT = 2;

export type LandRunStatus = "running" | "done" | "failed" | "stopped";

/**
 * What the detached run needs to make the same merge the preparation made and to check it: the copy and the commit,
 * the repo's checks, and everything the land record carries (the approval token and the close the signature covers).
 */
export interface LandCheckSpec {
  /** the run this spec belongs to: the launcher's name for it, and the record the run has to still own */
  runId: string;
  lane: string;
  /** the clone the copied files come from and the checks are read against */
  repo: string;
  area: string;
  checks: AreaCheck[];
  /** the counts this landing may not increase (config/repos.yaml increments), measured beside the checks */
  increments?: AreaIncrement[];
  changed: string[];
  deps?: string;
  head: string;
  mainTip: string;
  mergeCommit: string;
  branch: string;
  workBase: string;
  configKey: string;
  /** the declarations (`increments` and `checkPrep`) the checks were started under, written into the record (C-193-1) */
  declaredKey?: string;
  repoName?: string;
  token: string;
  expiresAt: string;
  close?: LandClose;
  closeCard?: { repo: string; issue: number; url: string };
  /**
   * the checked results this run takes over from a check at an earlier mainline tip. The run writes them into the record
   * beside the checks it runs itself, and the record's token and window are the ones in this spec (C-193-1, C-193-2).
   */
  inherit?: LandInherit;
  /**
   * the lanes whose changes are laid one on the other in the merge commit this run checks, in order, when the run
   * checks a batch: the run's `lane` is then the batch's id and the result is read as the batch's (C-247-3)
   */
  batch?: string[];
}

export interface LandCheckRun {
  /** the run's own name, so a superseded run is told apart from the one that replaced it */
  id: string;
  lane: string;
  status: LandRunStatus;
  started_at: string;
  ended_at?: string;
  /** the run process; a record naming none is taken as starting for the grace */
  pid?: number;
  /** the process the launcher started (systemd-run's when the run is in a scope), used to stop a run that has not named itself yet */
  spawn_pid?: number;
  /** the detached copy the run reads: removed when the run ends, even when it died (C-144-7) */
  copy?: string;
  /** the work clone the copy belongs to */
  repo: string;
  /** the repo's common git dir, so a check of this repo is read without asking git again */
  common: string;
  head: string;
  mainTip: string;
  mergeCommit: string;
  /** the check runs for an approval still in force: a full limit stops an unsigned one to make room (C-144-5) */
  signed: boolean;
  spec: LandCheckSpec;
  /** where the run's own output goes, for a failure that has to be read afterwards */
  log: string;
  /** what the run found, for the CLI's reading of where it ended */
  result?: { blocking: number; checks: { name: string; status: string }[] };
  error?: string;
}

export function landRunPath(lane: string): string { return recordPath("land-run", lane); }
export function readLandRun(lane: string): LandCheckRun | null { return read<LandCheckRun>(landRunPath(lane)); }
export function saveLandRun(rec: LandCheckRun): LandCheckRun { save(landRunPath(rec.lane), rec); return rec; }

/** where a kind of record is kept, named without making it: a reader (the metrics) must write nothing into the state */
const existingDir = (name: string): string => join(stateDir(), "overlay", name);

/** every lane's newest landing check, without settling the dead ones */
export function listLandRuns(): LandCheckRun[] {
  const from = existingDir("land-run");
  let names: string[];
  try { names = readdirSync(from); } catch { return []; }
  const out: LandCheckRun[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const rec = read<LandCheckRun>(join(from, name));
    if (rec?.lane) out.push(rec);
  }
  return out;
}

/** the landing checks of the state, or of one lane, settled: a dead run is closed and its copy removed on the way */
export function landChecks(lane?: string): LandCheckRun[] {
  const recs = lane
    ? [readLandRun(lane)].filter((r): r is LandCheckRun => Boolean(r))
    : listLandRuns();
  return recs.map((rec) => closeDeadLandRun(rec));
}

/** the landing checks of the state, settled: a dead one is closed and its copy removed on the way */
export function readAllLandRuns(opts: LandRunReadOptions = {}): LandCheckRun[] {
  return listLandRuns().map((rec) => closeDeadLandRun(rec, opts));
}

/**
 * One finished round of a lane's landing check, appended and never rewritten: the lane's newest run record is
 * overwritten by the next round, so a week's table (flaky tests, CPU seconds, wall time) has nowhere to read a
 * round from unless the rounds are kept. A round stopped from outside carries no checks and no result, and is never
 * counted as a checked round.
 */
export interface LandRoundRecord {
  /** the run's own name, so a round that is written twice (the run and the launcher) is kept once */
  id: string;
  lane: string;
  status: "done" | "failed" | "stopped";
  started_at: string;
  ended_at: string;
  /** how long the round ran (seconds) */
  wall_seconds: number;
  /** the CPU the round used (seconds) and where the reading came from */
  cpu_seconds?: number;
  cpu_source?: string;
  /** the group it checked: the lane's head and the mainline tip it was merged with */
  head: string;
  mainTip: string;
  mergeCommit: string;
  /** the check was for an approval still in force */
  signed: boolean;
  repo: string;
  /** the lines the merge changed from the mainline tip (added + deleted), when git could read them */
  diff_lines?: number;
  /** every check the round ran, with its own time and the numbers it measured */
  checks: GateCheck[];
  /** the earlier mainline tip whose checked results this round took over, when it took any over */
  inherit?: { mainTip: string; mergeCommit?: string; checks: string[] };
  /** the structure counts of both trees this round measured (C-243-3), absent for a repo that declares none and for a round that measured nothing */
  structure?: StructureMeasure;
  /** how many of them stop a landing */
  blocking: number;
  error?: string;
}

/** one lane's rounds, beside the run records (`land-rounds/<key>.jsonl`, one round a line) */
export function landRoundHistoryPath(lane: string): string {
  return join(dir("land-rounds"), `${key(lane)}.jsonl`);
}

function readRounds(path: string): LandRoundRecord[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const out: LandRoundRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as LandRoundRecord;
      if (rec && typeof rec.id === "string" && rec.lane) out.push(rec);
    } catch { /* one bad line does not lose the rest */ }
  }
  return out;
}

/** one lane's finished rounds, in the order they ended */
export function readLandRounds(lane: string): LandRoundRecord[] {
  return readRounds(landRoundHistoryPath(lane));
}

/** every lane's finished rounds, in no particular order */
export function listLandRounds(): LandRoundRecord[] {
  const from = existingDir("land-rounds");
  let names: string[];
  try { names = readdirSync(from); } catch { return []; }
  return names.filter((n) => n.endsWith(".jsonl")).flatMap((n) => readRounds(join(from, n)));
}

/**
 * Append one round, once. One write a row, so two writers (a run closing itself and the launcher sweeping it) never
 * interleave, and a round whose id is already in the file is left alone: the first reading of a round is the one
 * kept, so a later writer cannot turn a stopped round into a checked one or the other way round.
 */
export function appendLandRound(round: LandRoundRecord): void {
  if (readRounds(landRoundHistoryPath(round.lane)).some((r) => r.id === round.id)) return;
  appendFileSync(landRoundHistoryPath(round.lane), `${JSON.stringify(round)}\n`, "utf8");
}

/** what a round's wall time is, from its two times (0 when either does not read) */
export function roundWallSeconds(startedAt: string, endedAt: string): number {
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 100) / 10) : 0;
}

/** one reading of the CPU this process (and its scope) has used so far */
export interface CpuReading { usec: number; source: string }

/**
 * The CPU the round used, read from the scope it runs in (`cpu.stat`'s usage_usec) or, where that cannot be read,
 * from the run process's own usage. A reading that cannot be taken at all is null: a round with no CPU reading is
 * still a round, and a wrong number is worse than none.
 */
export function cpuReading(): CpuReading | null {
  try {
    const cgroup = /^0::(.+)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1]?.trim();
    if (cgroup) {
      const stat = readFileSync(join("/sys/fs/cgroup", cgroup, "cpu.stat"), "utf8");
      const usec = /^usage_usec\s+(\d+)$/m.exec(stat)?.[1];
      if (usec) return { usec: Number(usec), source: "cgroup" };
    }
  } catch { /* no cgroup: fall through to the process's own usage */ }
  try {
    const usage = process.resourceUsage();
    return { usec: usage.userCPUTime + usage.systemCPUTime, source: "process" };
  } catch {
    return null;
  }
}

/** the CPU between two readings of the same source; null when either is missing or they are not comparable */
export function cpuSecondsBetween(before: CpuReading | null, after: CpuReading | null): number | null {
  if (!before || !after || before.source !== after.source) return null;
  return Math.max(0, Math.round((after.usec - before.usec) / 1000) / 1000);
}

/** whether the run the record names still has a process: the run's own, or the launcher's until it names itself */
export function landRunAlive(rec: Pick<LandCheckRun, "status" | "pid" | "spawn_pid" | "started_at">, now = Date.now(), isAlive: (pid: number) => boolean = alive): boolean {
  if (rec.status !== "running") return false;
  if (rec.pid) return isAlive(rec.pid);
  if (rec.spawn_pid) return isAlive(rec.spawn_pid);
  const started = Date.parse(rec.started_at ?? "");
  return !Number.isNaN(started) && now - started < LAND_RUN_START_GRACE_MS;
}

export interface LandRunReadOptions {
  alive?: (pid: number) => boolean;
  now?: number;
}

/**
 * Settle a record that says running with no process behind it: the run died (a kill, a machine that went down), so
 * its copy is removed here and the record is closed. Its result is not kept, so the lane is checked again by a later
 * tick (C-144-7, AC-007). The record is read once more before the write, as the lane runs' door does, so a run that
 * just finished is not rewritten as a failure. Only reads, and writes the one record it closes.
 */
export function closeDeadLandRun(rec: LandCheckRun, opts: LandRunReadOptions = {}): LandCheckRun {
  const isAlive = opts.alive ?? alive;
  const now = opts.now ?? Date.now();
  if (rec.status !== "running") return rec;
  if (landRunAlive(rec, now, isAlive)) return rec;
  const fresh = readLandRun(rec.lane);
  if (!fresh) return rec;
  if (fresh.status !== "running" || landRunAlive(fresh, now, isAlive)) return fresh;
  if (fresh.copy) dropCopy(fresh.copy, fresh.repo);
  // the run's own working copy of the spec goes with it: it is never read again, and a dead run leaves nothing
  try { rmSync(join(dir("land-run"), `${fresh.id}.spec.json`), { force: true }); } catch { /* the next sweep can */ }
  const endedAt = new Date(now).toISOString();
  appendLandRound({
    id: fresh.id, lane: fresh.lane, status: "failed", started_at: fresh.started_at, ended_at: endedAt,
    wall_seconds: roundWallSeconds(fresh.started_at, endedAt),
    head: fresh.head, mainTip: fresh.mainTip, mergeCommit: fresh.mergeCommit, signed: fresh.signed, repo: fresh.repo,
    checks: [], blocking: 0, error: fresh.error ?? "検査の run の process が消えました",
  });
  return saveLandRun({
    ...fresh,
    status: "failed",
    ended_at: new Date(now).toISOString(),
    error: fresh.error ?? "検査の run の process が消えました",
  });
}

/** the lane's newest landing check, if one is running now: a dead one is closed, never answered as running */
export function landRunChecking(lane: string, opts: LandRunReadOptions = {}): LandCheckRun | null {
  const rec = readLandRun(lane);
  if (!rec) return null;
  const settled = closeDeadLandRun(rec, opts);
  return settled.status === "running" ? settled : null;
}

/** every landing check that is running now; dead ones are closed (and their copies removed) on the way */
export function runningLandRuns(opts: LandRunReadOptions = {}): LandCheckRun[] {
  return listLandRuns().map((rec) => closeDeadLandRun(rec, opts)).filter((rec) => rec.status === "running");
}

/** how many landing checks may run at once, from `IDD_LAND_CHECK_LIMIT` (the default is the Issue's 2) */
export function landCheckLimit(env: NodeJS.ProcessEnv = process.env): number {
  const given = Number(env.IDD_LAND_CHECK_LIMIT);
  return Number.isInteger(given) && given >= 1 ? given : DEFAULT_LAND_CHECK_LIMIT;
}

/** whether a landing check of the repo at `cwd` is running now: a read of the run records, and nothing else */
export function landCheckRunningFor(cwd: string): boolean {
  let common: string;
  try { common = resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()); } catch { return false; }
  return runningLandRuns().some((r) => r.common === common);
}

/**
 * Whether a check is running at the repo at `cwd` now: the overlay's own hold on the repo (the submit's and the
 * import's checks, and the landing preparation's brief one), or a landing check running as a run of its own (C-144-8).
 * This is the whole question the sweep and the card ask; `checksRunning` in `overlay/git.ts` is only its lock half.
 */
export function landChecksRunning(cwd: string): boolean {
  return checksRunning(cwd) || landCheckRunningFor(cwd);
}

/** the run's own entry point, resolved from this module's place so no caller has to know the layout */
export function landCheckScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "land-check.ts");
}

/** the systemd-run binary; a test stands in for it with IDD_SYSTEMD_RUN_BIN */
export function systemdRunBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.IDD_SYSTEMD_RUN_BIN?.trim() || "systemd-run";
}

/** the scope one landing check runs in: a name of its own, so two checks never share one (C-144-6) */
export function landScopeUnit(runId: string): string {
  return `idd-land-${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

/** the slice every lane runs in, from config/roles.yaml; the land runs join the same one (C-144-6) */
export function laneSlice(): string {
  try {
    const raw = yamlLoad(readFileSync(rolesPath(), "utf8")) as { defaults?: { lane_cpu?: { slice?: unknown } } } | null;
    const slice = raw?.defaults?.lane_cpu?.slice;
    return typeof slice === "string" && slice.trim() ? slice.trim() : "idd_lanes.slice";
  } catch {
    return "idd_lanes.slice";
  }
}

/**
 * Whether a landing check can be put in a scope of its own here: `IDD_LANE_SCOPE=off` and a machine whose systemd
 * will not take one (a container, a dev box) run the check as a plain detached process instead (C-144-6 leaves this
 * to the free part). Asked once per systemd-run binary: a probe that fails would otherwise be paid for by every
 * check, and the check itself would never start.
 */
const scopeUsable = new Map<string, boolean>();

export function canScopeLandCheck(env: NodeJS.ProcessEnv = process.env, probe?: (cmd: string, args: string[]) => { status: number | null }): boolean {
  if (env.IDD_LANE_SCOPE === "off") return false;
  const bin = systemdRunBinary(env);
  const asked = scopeUsable.get(bin);
  if (asked !== undefined) return asked;
  const run = probe ?? ((cmd, args) => spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000 }));
  const r = run(bin, ["--user", "--scope", "--quiet", "--collect", `--unit=idd-land-probe-${process.pid}`, "true"]);
  const usable = r.status === 0;
  scopeUsable.set(bin, usable);
  return usable;
}

/** the command and arguments a landing check is started with, in its own scope when systemd is used */
export function landCheckLaunch(script: string, specPath: string, runId: string, env: NodeJS.ProcessEnv = process.env, probe?: (cmd: string, args: string[]) => { status: number | null }): { cmd: string; args: string[] } {
  const direct = landCheckCommand(script, specPath, env);
  if (!canScopeLandCheck(env, probe)) return direct;
  return {
    cmd: systemdRunBinary(env),
    args: ["--user", "--scope", "--quiet", "--collect", `--unit=${landScopeUnit(runId)}`, `--slice=${laneSlice()}`, direct.cmd, ...direct.args],
  };
}

/**
 * How the run is started: the runtime this process runs on (bun in the engine and in the CLI, node in the tests),
 * with node's type stripping flag only for node. A test may stand in for both with IDD_LAND_CHECK_BIN.
 */
export function landCheckCommand(script: string, specPath: string, env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  const given = env.IDD_LAND_CHECK_BIN?.trim();
  if (given) return { cmd: given, args: [script, specPath] };
  const exec = process.execPath;
  const bun = /(^|[/\\])bun(\.exe)?$/.test(exec);
  return { cmd: exec, args: [...(bun ? [] : ["--experimental-strip-types"]), script, specPath] };
}

/** where the run's own output is kept, beside its record */
function landRunLogPath(lane: string): string {
  const p = join(dirname(landRunPath(lane)), "land-run-logs");
  mkdirSync(p, { recursive: true });
  return join(p, `${randomBytes(6).toString("hex")}.log`);
}

export interface StartLandRun {
  lane: string;
  spec: Omit<LandCheckSpec, "lane" | "runId">;
  signed: boolean;
}

/**
 * Start the landing check of a lane and record it (C-144-1): the spec is written, the run is started detached in its
 * own scope, and the record is left so the tick, the card and the CLI can read that the check is running. The copy is
 * cut by the run itself, under the lock, so it is named after the run's life (C-144-2, C-144-7).
 */
export function startLandRun(input: StartLandRun): LandCheckRun {
  const lane = input.lane;
  const id = `${process.pid.toString(36)}${randomBytes(6).toString("hex")}`;
  const laneDir = dirname(landRunPath(lane));
  mkdirSync(laneDir, { recursive: true });
  const specPath = join(laneDir, `${id}.spec.json`);
  const spec: LandCheckSpec = { runId: id, lane, ...input.spec };
  const log = landRunLogPath(lane);
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  let common = "";
  try { common = resolve(spec.repo, git(spec.repo, ["rev-parse", "--git-common-dir"]).trim()); } catch { /* read back off the repo at the reader's ask */ }
  const rec: LandCheckRun = {
    id, lane, status: "running", started_at: new Date().toISOString(),
    repo: spec.repo, common, head: spec.head, mainTip: spec.mainTip, mergeCommit: spec.mergeCommit,
    signed: input.signed, spec, log,
  };
  saveLandRun(rec);
  const launch = landCheckLaunch(landCheckScript(), specPath, id);
  const fd = openSync(log, "a");
  const child = spawn(launch.cmd, launch.args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  return saveLandRun({ ...rec, spawn_pid: child.pid ?? undefined });
}

/**
 * Stop a landing check from outside (C-144-5): the run is asked to end, and its copy is removed at once so the place
 * is free. The record says stopped, so the run does not write its result as if it had been checked. Best effort: a
 * run that is already gone changes nothing.
 */
export function stopLandRun(rec: LandCheckRun, reason = "署名済みの取り込みの検査のために止めました"): LandCheckRun {
  const pid = rec.pid ?? rec.spawn_pid;
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  if (rec.copy) dropCopy(rec.copy, rec.repo);
  const endedAt = new Date().toISOString();
  // a round stopped from outside keeps no result and no checks: it is recorded as stopped, never as checked
  appendLandRound({
    id: rec.id, lane: rec.lane, status: "stopped", started_at: rec.started_at, ended_at: endedAt,
    wall_seconds: roundWallSeconds(rec.started_at, endedAt),
    head: rec.head, mainTip: rec.mainTip, mergeCommit: rec.mergeCommit, signed: rec.signed, repo: rec.repo,
    checks: [], blocking: 0, error: reason,
  });
  return saveLandRun({ ...rec, status: "stopped", ended_at: endedAt, error: reason });
}

/** the run is asked to stop: the same shape every stopping path writes */
export function signalLandRun(rec: LandCheckRun): void {
  const pid = rec.pid ?? rec.spawn_pid;
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
}

/**
 * What one landing check shows a reader: its own life, the group it reads, and where it ended. The spec (the checks'
 * commands and the group's files) is left out: `idd lane status` lists every lane at once.
 */
export interface LandCheckSummary {
  id: string;
  lane: string;
  role: "land-check";
  status: LandRunStatus;
  started_at: string;
  ended_at?: string;
  pid?: number;
  /** the detached copy the check reads (present once it was cut) */
  worktree?: string;
  head: string;
  mainTip: string;
  mergeCommit: string;
  /** the check runs for an approval still in force */
  signed: boolean;
  /** what the checks found, once they ran */
  result?: { blocking: number; checks: { name: string; status: string }[] };
  error?: string;
}

export function landCheckSummary(rec: LandCheckRun): LandCheckSummary {
  return {
    id: rec.id, lane: rec.lane, role: "land-check", status: rec.status, started_at: rec.started_at,
    ...(rec.ended_at ? { ended_at: rec.ended_at } : {}),
    ...(rec.pid ? { pid: rec.pid } : {}),
    ...(rec.copy ? { worktree: rec.copy } : {}),
    head: rec.head, mainTip: rec.mainTip, mergeCommit: rec.mergeCommit, signed: rec.signed,
    ...(rec.result ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {}),
  };
}

/** whether the state holds any landing check record at all */
export function hasLandRuns(): boolean {
  return listLandRuns().length > 0;
}

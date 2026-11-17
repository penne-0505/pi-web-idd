import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import lockfile from "proper-lockfile";

import { namedStateDir } from "../../idd-core/src/install/pointers.ts";
import { agentEnv } from "./agent-env.ts";
import { repoRoot } from "./paths.ts";
import { changedSinceBase, GATE_DEFAULT_TIMEOUT_MINUTES } from "./gate.ts";
import { gitTry } from "./git.ts";
import { repoByName, repoForPath, type LaneRepo } from "./repos.ts";
import { RECORDLESS_MARK } from "./worktree.ts";

/**
 * The `idd wait-run` command: run one long command with the call in the foreground, but return every few minutes
 * so the agent's turn ends and the prompt cache of a 5-minute run does not expire. The command itself is started
 * in a session of its own (detached), so it keeps running after the call returns, and each further call with the
 * same lane / directory / command attaches to that run instead of starting a second one.
 *
 * The state lives under `IDD_STATE_DIR/wait-run/`, never in the worktree: a role that requires a clean tree must
 * not fail because a check was wrapped here.
 */

/** the exit code of a call that returns while the command is still running. Not 0, and not 124 (the cut of a limit) */
export const WAIT_RUNNING_EXIT = 75;
/** the exit code of a call that finds the run was stopped from outside (its process is gone, no exit was written) */
export const WAIT_INTERRUPTED_EXIT = 74;
/** the limit's exit code, the same one the harness's gate and shell cut with. Used for the command's own 124 too */
export const WAIT_TIMEOUT_EXIT = 124;
/** the exit code of a `--check` run whose changed-files list could not be taken: the check is not started at all */
export const WAIT_NO_LIST_EXIT = 3;
/** how long one call waits before returning the output so far: under the 5-minute cache hold, and under a 15-minute tool limit */
export const WAIT_DEFAULT_SLICE_MS = 4 * 60_000;
/** the slice when the lane has no tool call limit: under Claude Code's own default of about two minutes */
export const WAIT_NO_LIMIT_SLICE_MS = 90_000;
/** what is left of the tool call's limit before the slice: the call must return, not be cut by Claude Code */
const SLICE_MARGIN_MS = 15_000;
const SLICE_MIN_MS = 5_000;
/** how long the processes of a run are given to end after the limit's SIGTERM before SIGKILL */
const DEFAULT_KILL_GRACE_MS = 3_000;

export interface WaitRunRecord {
  key: string;
  lane: string;
  cwd: string;
  command: string;
  pid: number;
  /** /proc/<pid>/stat field 22 at the launch: tells a reused pid from the run's own ("" when it could not be read) */
  pid_start: string;
  started_at: string;
  /** total limit in ms for the wrapped command, null for none */
  limit_ms: number | null;
  slice_ms: number;
  /** bytes of the output file already returned to an earlier call */
  offset: number;
  exit?: number;
  consumed?: boolean;
  interrupted?: boolean;
  timed_out?: boolean;
  ended_at?: string;
  /** the temp file holding IDD_CHANGED_FILES for a `--check` run, removed when the run ends */
  list_file?: string;
}

export interface WaitRunOptions {
  /** the literal command, without the `--` */
  command?: string;
  /** a repo check to run by name (its command, limit and changed-files list come from config/repos.yaml) */
  check?: string;
  /** an explicit total limit in minutes: wins over the lane's tool limit and the check's own */
  timeoutMinutes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** the slice, for tests: defaults to waitSliceMs(env) */
  sliceMs?: number;
  /** the grace given to a run's processes after the limit's SIGTERM, for tests */
  killGraceMs?: number;
  /** the wait loop's poll interval, for tests */
  pollMs?: number;
}

export interface WaitRunPaths {
  key: string;
  dir: string;
  record: string;
  out: string;
  exitFile: string;
  lock: string;
}

/** the directory a lane's wait-runs live in: the lane's state, never the worktree */
export function waitRunRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = namedStateDir({ checkout: repoRoot(), env }) ?? join(homedir(), ".cache", "idd");
  return join(base, "wait-run");
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "lane";

/**
 * The files of one run. The key is the lane, the directory and the command string: the same three make the same
 * key, so a call with the same command finds the run an earlier call started.
 */
export function waitRunPaths(lane: string, cwd: string, command: string, env: NodeJS.ProcessEnv = process.env): WaitRunPaths {
  const key = createHash("sha256").update(`${lane}\0${cwd}\0${command}`).digest("hex").slice(0, 20);
  const dir = join(waitRunRoot(env), sanitize(lane));
  return { key, dir, record: join(dir, `${key}.json`), out: join(dir, `${key}.out`), exitFile: join(dir, `${key}.exit`), lock: join(dir, `${key}.lock`) };
}

/**
 * How long one call waits before handing back the output so far. Under the 5-minute hold, so the next call comes
 * before the cache expires; under the tool call's own limit when there is one (Claude Code cuts the call there),
 * and under Claude Code's default when there is not.
 */
export function waitSliceMs(env: NodeJS.ProcessEnv = process.env, override?: number): number {
  if (override !== undefined) return Math.max(1, override);
  const raw = Number(env.BASH_MAX_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return WAIT_NO_LIMIT_SLICE_MS;
  return Math.max(SLICE_MIN_MS, Math.min(WAIT_DEFAULT_SLICE_MS, raw - SLICE_MARGIN_MS));
}

/** the total limit for the wrapped command: the explicit minutes, else the check's own, else the lane's tool limit */
export function waitLimitMs(opts: Pick<WaitRunOptions, "timeoutMinutes">, env: NodeJS.ProcessEnv = process.env, checkTimeoutMinutes?: number): number | null {
  if (opts.timeoutMinutes !== undefined) return Math.max(1000, Math.round(opts.timeoutMinutes * 60_000));
  if (checkTimeoutMinutes !== undefined) return Math.max(1000, Math.round(checkTimeoutMinutes * 60_000));
  const raw = Number(env.BASH_MAX_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return null;
}

/** /proc/<pid>/stat field 22 (the process start time), or null when it cannot be read */
function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

/** whether the run's own process is still there: the pid and its start time must both match */
function alive(rec: WaitRunRecord): boolean {
  if (rec.pid <= 0) return false;
  const start = procStartTime(rec.pid);
  if (start !== null) return rec.pid_start === "" || start === rec.pid_start;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord(recordPath: string): WaitRunRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath, "utf8")) as WaitRunRecord;
  } catch {
    return null;
  }
}

function writeRecord(recordPath: string, rec: WaitRunRecord): void {
  writeFileSync(recordPath, `${JSON.stringify(rec)}\n`);
}

function readOutput(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
}

function readExit(path: string): number | null {
  try {
    const v = readFileSync(path, "utf8").trim();
    return /^-?\d+$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  // the run is started detached, so it is the leader of its own group: the negative pid reaches it and its children
  try {
    process.kill(-pid, sig);
  } catch {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** start the command detached, its output appended to the run's file, and record the exit in the run's exit file */
function launch(paths: WaitRunPaths, command: string, cwd: string, env: NodeJS.ProcessEnv): { pid: number; pid_start: string } {
  mkdirSync(paths.dir, { recursive: true });
  rmSync(paths.exitFile, { force: true });
  const out = openSync(paths.out, "w");
  try {
    const child = spawn("bash", ["-c", 'bash -lc "$1"; __s=$?; printf "%s" "$__s" > "$2"', "wait-run", command, paths.exitFile], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.on("error", () => { /* the exit file stays absent: the next call reports the run as interrupted */ });
    const pid = child.pid ?? -1;
    child.unref();
    return { pid, pid_start: pid > 0 ? procStartTime(pid) ?? "" : "" };
  } finally {
    closeSync(out);
  }
}

export interface ResolvedWaitCheck {
  name: string;
  command: string;
  timeoutMinutes?: number;
}

/**
 * A repo check by name, from the registry of the directory it is asked in: the same lookup `idd gate` uses. An
 * unknown name, an unknown repo or a check with no command is an error the caller turns into the usage.
 */
export function resolveWaitCheck(name: string, cwd: string): ResolvedWaitCheck | { error: string } {
  let repo;
  try {
    repo = repoOfDir(cwd);
  } catch (err) {
    return { error: `repo の登録を読めませんでした: ${String(err)}` };
  }
  if (!repo) return { error: `config/repos.yaml にこの path を含む repo がありません: ${cwd}` };
  const check = repo.checks.find((c) => c.name === name);
  if (!check) return { error: `検査 "${name}" が repo ${repo.name} にありません（あるもの: ${repo.checks.map((c) => c.name).join(", ") || "なし"}）` };
  return { name, command: check.command, ...(check.timeoutMinutes !== undefined ? { timeoutMinutes: check.timeoutMinutes } : {}) };
}

interface Plan {
  kind: "start" | "attach" | "consume" | "interrupted";
  rec: WaitRunRecord;
}

/**
 * One call. The decision (start, attach, hand over a finished result, or report an interruption) is taken under a
 * lock, so two calls of the same command never start two runs. The waiting happens after the lock is released.
 */
export async function runWaitRun(opts: WaitRunOptions): Promise<number> {
  const code = await runOnce(opts);
  // a check run in a recordless copy says so with its result, whatever that result is
  if (opts.check) {
    const stripped = strippedPaths(resolve(opts.cwd ?? process.cwd()));
    if (stripped) (opts.stdout ?? ((t: string) => process.stdout.write(t)))(recordlessNotice(stripped));
  }
  return code;
}

async function runOnce(opts: WaitRunOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const say = opts.stdout ?? ((t: string) => process.stdout.write(t));
  const warn = opts.stderr ?? ((t: string) => process.stderr.write(t));
  const cwd = resolve(opts.cwd ?? process.cwd());
  const lane = env.IDD_LANE_ID?.trim() || "adhoc";

  let command = opts.command ?? "";
  let check: ResolvedWaitCheck | undefined;
  if (opts.check) {
    const resolved = resolveWaitCheck(opts.check, cwd);
    if ("error" in resolved) {
      warn(`${resolved.error}\n`);
      return 2;
    }
    check = resolved;
    command = resolved.command;
  }
  if (!command.trim()) {
    warn("wait-run: コマンドか --check NAME を指定してください\n");
    return 2;
  }

  // A check runs from the changed-files list. When the list cannot be taken, the check must not run: an empty
  // list is shaped exactly like "no changes", so a check that reads it would pass without examining anything.
  let changed: string[] | null = null;
  if (check) {
    changed = changedSinceBase(cwd, repoOfDir(cwd)!);
    if (changed === null) {
      warn(noListNotice());
      return WAIT_NO_LIST_EXIT;
    }
  }

  const paths = waitRunPaths(lane, cwd, command, env);
  const slice = waitSliceMs(env, opts.sliceMs);
  // a check's own limit wins over the lane's tool limit; without one it runs under the same limit as `idd gate`
  const checkTimeout = check ? check.timeoutMinutes ?? GATE_DEFAULT_TIMEOUT_MINUTES : undefined;
  const limit = waitLimitMs(opts, env, checkTimeout);
  mkdirSync(paths.dir, { recursive: true });
  // the child's environment: a check gets IDD_CHANGED_FILES the way `idd gate` hands it (the changed-files list of
  // the directory), and a literal command inherits none of it, since the agent wrapped it itself
  const childEnv = opts.check ? agentEnv(env) : { ...env };
  delete childEnv.IDD_CHANGED_FILES;

  const release = await lockfile.lock(paths.lock, { realpath: false, retries: { retries: 100, minTimeout: 10, maxTimeout: 100 } });
  let plan: Plan;
  try {
    const existing = readRecord(paths.record);
    if (existing && existing.exit === undefined && alive(existing)) {
      plan = { kind: "attach", rec: existing };
    } else if (existing && existing.exit === undefined) {
      // the record says running but its process is gone: if the command wrote its exit before it went, it finished;
      // otherwise it was stopped from outside
      const finished = readExit(paths.exitFile);
      if (finished !== null) {
        plan = { kind: "consume", rec: { ...existing, exit: finished, ended_at: new Date().toISOString() } };
      } else {
        const rec: WaitRunRecord = { ...existing, exit: WAIT_INTERRUPTED_EXIT, interrupted: true, ended_at: new Date().toISOString(), consumed: true };
        writeRecord(paths.record, rec);
        removeListFile(existing);
        plan = { kind: "interrupted", rec };
      }
    } else if (existing && existing.consumed !== true) {
      plan = { kind: "consume", rec: existing };
    } else {
      // a new run: the previous record (consumed or finished) and its output go
      rmSync(paths.record, { force: true });
      rmSync(paths.out, { force: true });
      if (existing) removeListFile(existing);
      let listFile: string | undefined;
      if (check) {
        listFile = join(paths.dir, `${paths.key}.changed`);
        writeFileSync(listFile, (changed ?? []).map((f) => `${f}\0`).join(""));
        childEnv.IDD_CHANGED_FILES = listFile;
      }
      const { pid, pid_start } = launch(paths, command, cwd, childEnv);
      const rec: WaitRunRecord = {
        key: paths.key,
        lane,
        cwd,
        command,
        pid,
        pid_start,
        started_at: new Date().toISOString(),
        limit_ms: limit,
        slice_ms: slice,
        offset: 0,
        ...(listFile ? { list_file: listFile } : {}),
      };
      writeRecord(paths.record, rec);
      plan = { kind: "start", rec };
    }
  } finally {
    await release();
  }

  if (plan.kind === "consume") {
    const rec = plan.rec;
    const exit = rec.exit ?? 1;
    say(outputSince(paths.out, rec.offset));
    say(finishNotice(exit));
    await withLock(paths.lock, () => writeRecord(paths.record, { ...rec, offset: readOutput(paths.out).length, consumed: true }));
    removeListFile(rec);
    return exit;
  }
  if (plan.kind === "interrupted") {
    say(outputSince(paths.out, plan.rec.offset));
    warn(interruptedNotice());
    return WAIT_INTERRUPTED_EXIT;
  }

  return await waitFor(paths, plan.rec, { say, warn, slice, pollMs: opts.pollMs, killGraceMs: opts.killGraceMs });
}

/** wait for the run's process to end, the slice to pass, or the command's limit to be reached */
async function waitFor(
  paths: WaitRunPaths,
  start: WaitRunRecord,
  io: { say: (t: string) => void; warn: (t: string) => void; slice: number; pollMs?: number; killGraceMs?: number },
): Promise<number> {
  const poll = Math.max(5, io.pollMs ?? 100);
  const sliceDeadline = Date.now() + io.slice;
  const limitDeadline = start.limit_ms === null ? Infinity : Date.parse(start.started_at) + start.limit_ms;
  for (;;) {
    const rec = readRecord(paths.record) ?? start;
    const exitFromFile = readExit(paths.exitFile);
    if (exitFromFile !== null) {
      const exit = exitFromFile;
      io.say(outputSince(paths.out, rec.offset));
      io.say(finishNotice(exit));
      // this call waited for the command and hands the result over now: the next call starts a new run
      await withLock(paths.lock, () => writeRecord(paths.record, { ...(readRecord(paths.record) ?? rec), exit, offset: readOutput(paths.out).length, consumed: true, ended_at: new Date().toISOString() }));
      removeListFile(rec);
      return exit;
    }
    if (!alive(rec)) {
      const out = outputSince(paths.out, rec.offset);
      io.say(out);
      io.warn(interruptedNotice());
      await withLock(paths.lock, () => writeRecord(paths.record, { ...(readRecord(paths.record) ?? rec), exit: WAIT_INTERRUPTED_EXIT, interrupted: true, offset: readOutput(paths.out).length, consumed: true, ended_at: new Date().toISOString() }));
      removeListFile(rec);
      return WAIT_INTERRUPTED_EXIT;
    }
    if (Date.now() >= limitDeadline) {
      killGroup(rec.pid, "SIGTERM");
      const grace = io.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      const until = Date.now() + grace;
      while (Date.now() < until && alive(rec)) await sleep(Math.min(50, Math.max(1, until - Date.now())));
      if (alive(rec)) killGroup(rec.pid, "SIGKILL");
      io.say(outputSince(paths.out, rec.offset));
      io.warn(timeoutNotice(rec.limit_ms));
      await withLock(paths.lock, () => writeRecord(paths.record, { ...(readRecord(paths.record) ?? rec), exit: WAIT_TIMEOUT_EXIT, timed_out: true, offset: readOutput(paths.out).length, consumed: true, ended_at: new Date().toISOString() }));
      removeListFile(rec);
      return WAIT_TIMEOUT_EXIT;
    }
    if (Date.now() >= sliceDeadline) {
      const out = readOutput(paths.out);
      io.say(out.subarray(rec.offset).toString("utf8"));
      io.warn(runningNotice());
      await withLock(paths.lock, () => writeRecord(paths.record, { ...(readRecord(paths.record) ?? rec), offset: out.length }));
      return WAIT_RUNNING_EXIT;
    }
    await sleep(Math.min(poll, Math.max(1, Math.min(sliceDeadline, limitDeadline) - Date.now())));
  }
}

function outputSince(path: string, offset: number): string {
  return readOutput(path).subarray(offset).toString("utf8");
}

function removeListFile(rec: WaitRunRecord): void {
  if (rec.list_file) rmSync(rec.list_file, { force: true });
}

async function withLock<T>(lockPath: string, fn: () => T): Promise<T> {
  const release = await lockfile.lock(lockPath, { realpath: false, retries: { retries: 100, minTimeout: 10, maxTimeout: 100 } });
  try {
    return fn();
  } finally {
    await release();
  }
}

/** the notice appended to the output of a call that found the command still running */
export function runningNotice(): string {
  return "\n[wait-run] まだ走っています。同じ行をもう一度呼び出すと、同じ実行の続きを待てます。\n";
}

/** the notice of a check that was not run because its changed-files list could not be taken */
export function noListNotice(): string {
  return "\n[wait-run] 変更したファイルの一覧が取れなかったので、検査を始めません（base の ref が見つからないか、base を持つ remote が 2 つあります）。\n";
}

interface RecordlessMarkBody {
  stripped: string[];
  repo?: string;
}

/** a recordless copy's mark, read from the copy's git directory; null when `cwd` is not in such a copy */
function readMark(cwd: string): RecordlessMarkBody | null {
  const mark = gitTry(cwd, ["rev-parse", "--path-format=absolute", "--git-path", RECORDLESS_MARK])?.trim();
  if (!mark) return null;
  try {
    const parsed = JSON.parse(readFileSync(mark, "utf8")) as { stripped?: unknown; repo?: unknown };
    return {
      stripped: Array.isArray(parsed.stripped) ? parsed.stripped.filter((p): p is string => typeof p === "string") : [],
      ...(typeof parsed.repo === "string" ? { repo: parsed.repo } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The registered repo a directory belongs to. A review copy lives under the lane's state, outside every root the
 * registry knows, and is a repository of its own, so the path alone names no repo: its mark names the one it was cut
 * for. A mark with no repo (or one the registry no longer has) falls back to the path.
 */
function repoOfDir(cwd: string): LaneRepo | null {
  const named = readMark(cwd)?.repo;
  if (named) {
    try { return repoByName(named); } catch { /* a repo the registry dropped: look by path */ }
  }
  return repoForPath(cwd);
}

/** the paths a recordless copy took out, read from its mark; null when `cwd` is not in such a copy */
function strippedPaths(cwd: string): string[] | null {
  return readMark(cwd)?.stripped ?? null;
}

/** the notice of a check run in a recordless copy: the result does not show the lane's change in the paths the copy took out */
export function recordlessNotice(stripped: string[]): string {
  const list = stripped.length ? stripped.join(", ") : "なし";
  return `\n[wait-run] この場所は記録を剥がした複製です。剥がした path（設定・記録）: ${list}。検査の結果は、これらの path を読む検査では lane の差分を映しません（通っても「不備なし」ではなく、落ちても lane の欠陥とは限りません）。\n`;
}

/** the notice of a call that found the run stopped from outside */
export function interruptedNotice(): string {
  return "\n[wait-run] 実行は途中で止められました。ここまでの出力は上にあります。もう一度呼び出すと新しく走らせます。\n";
}

/** the notice of a call that cut the command at its limit */
export function timeoutNotice(limitMs: number | null): string {
  const min = limitMs === null ? "?" : String(Math.round(limitMs / 60_000));
  return `\n[wait-run] コマンドが上限（${min} 分）を超えたので、コマンドとその子を止めました（終了コード ${WAIT_TIMEOUT_EXIT}）。\n`;
}

/** the notice of a call that found the command ended: the exit code is its own, so the report can read it */
export function finishNotice(exit: number): string {
  return `\n[wait-run] コマンドは終了しました（終了コード ${exit}）。\n`;
}

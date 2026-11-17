import { spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { readAreas } from "../config/areas.ts";
import type { AreaCheck, CheckPrep } from "../config/areas.ts";
import type { Manifest } from "./manifest.ts";
import { clean, dir, git, names, tree } from "./git.ts";
import { copyName, dropCopy, sweepCopies } from "../worktree/copies.ts";
import { baselinePhrase, failingAtBase, holdsSignature } from "./check-reason.ts";
import type { CheckBaseline } from "./check-reason.ts";
import { failureIdsOf, ranToEnd } from "./failure-ids.ts";
import type { FailureIdRule } from "../config/areas.ts";

export type GateSeverity = "blocking" | "non-blocking";
export type FailureIdsUnread = "cut" | "signal" | "incomplete" | "hidden";
export type GateStatus = "pass" | "fail" | "skipped" | "not-applicable";

/**
 * The two numbers a check that compares a change against the mainline measured. Kept beside the text so a week's
 * table can read the absolute count (the mainline's) and the increase without parsing a sentence.
 */
export interface GateCounts {
  mainline?: number;
  merged?: number;
  /** the mainline tip the two numbers were measured at: a count taken over from an earlier tip names that tip */
  at?: string;
}

/** the side of a structure count that could not be taken: the mainline tip's tree, or the merge commit's */
export type StructureSide = "mainline" | "merged";

/**
 * What kind of structure row a check is, written by the run that counted (C-253-1): a count that grew, a count that
 * could not be taken (and on which side), or a merge commit whose declaration holds less than the mainline's. A reader
 * takes the kind from here and never from the words of `detail`. `command` is the declaration's command that graded
 * the row, with the values of the files the repo copies taken out; it is left out when those cannot be told apart.
 */
export type StructureRowKind =
  | { kind: "increase"; command?: string[] }
  | { kind: "unmeasured"; sides: StructureSide[]; command?: string[] }
  | { kind: "weakened"; command?: string[] };

export interface GateCheck {
  name: string;
  status: GateStatus;
  severity: GateSeverity;
  detail?: string;
  /** how long the check itself ran (ms), when the run measured it */
  ms?: number;
  /** the numbers a comparison check measured */
  counts?: GateCounts;
  /** the lane a records check ran for, when it ran once per lane of a batch */
  lane?: string;
  /** the kind of a structure row, when this is one */
  structure?: StructureRowKind;
  /** the names of the tests a failed row lists, written by the landing run that read them */
  failedTests?: string[];
  /**
   * the failures a failed row's output names, read with the check's `failure_id_pattern` (failure-ids.ts) over the
   * whole output. Absent when the check declares no pattern, or when the run's list may be partial (`failureIdsUnread`)
   */
  failureIds?: string[];
  /**
   * why a failed row of a check that declares a pattern names no failure: cut by its limit or its output (or not run),
   * ended by a signal (an exit code past 128, or none), without the line its `complete_pattern` says a finished run
   * prints, or with an output kept back because a copied file could not be read out
   */
  failureIdsUnread?: FailureIdsUnread;
  /** the command's exit code, on a row that did not pass (null: no code, ended by a signal) */
  exitCode?: number | null;
  /** what the same check found at the public base, when a required public check failed at the submit's head */
  baseline?: CheckBaseline;
  /** the row is a kept result of the same tree, check and changed files (check-results.ts), checked at `at` */
  reused?: { at: string };
}

/** the limit of a check that does not write timeout_minutes */
export const DEFAULT_CHECK_MINUTES = 5;
/** the limit of one setup command, the same as for a review copy's setup */
export const SETUP_MINUTES = 15;
/**
 * How long past its limit a command may still run: timeout(1) waits `--kill-after=30` seconds before it kills, and the
 * run's own timer kills the group once more a minute after the limit. A caller that must know the longest a command
 * can hold something (a lock) adds this to the limit.
 */
export const COMMAND_GRACE_SECONDS = 60;
const OUTPUT_LIMIT = 64 * 1024 * 1024;
/**
 * The cap on what one check's output may hold. A test may lower it through IDD_GATE_OUTPUT_LIMIT; the
 * default (and so what a repo's check sees) is not changed by that.
 */
function outputLimit(): number {
  const given = Number(process.env.IDD_GATE_OUTPUT_LIMIT);
  return Number.isFinite(given) && given > 0 ? given : OUTPUT_LIMIT;
}
const HIDDEN = "[伏せた値]";
/**
 * The heads a check's detail starts with when the run was cut by the harness, not failed by the command itself: the
 * landing stage reads them to tell a failure of the environment from a failure of the change (`landFailureCause`).
 */
export const CUT_BY_TIME = (minutes: number) => `時間の上限（${minutes} 分）で打ち切りました`;
export const CUT_BY_TIME_RE = /^時間の上限（[\d.]+ 分）で打ち切りました/m;
export const CUT_BY_OUTPUT = "出力が上限を超えたので打ち切りました";

export interface CheckOptions {
  /** check name -> its limit in minutes */
  timeouts?: Record<string, number>;
  /** the files the checks are about, handed to them as IDD_CHANGED_FILES: the path of a NUL-separated list */
  changed?: string[];
  /** what the files copied into the copy hold, kept out of every detail */
  hide?: Hidden;
  /** the lane a records check runs for, handed to it as IDD_ID; a public check is never told it */
  laneId?: string;
  /**
   * the lanes a records check runs for when one tree holds several lanes' changes (a batch): the check runs once per
   * lane, each with that lane's id as IDD_ID, and each row names its lane. A public check still runs once.
   */
  laneIds?: string[];
  /** stop the checks from outside: no further check is started and the running one is killed (C-144-5) */
  signal?: AbortSignal;
  /** check name -> how its failures are named in a failed run's output (`failure_id_pattern`, `complete_pattern`) */
  failureIds?: Record<string, FailureIdRule>;
}

/** the values of the copied files, and the copied files whose values could not be read out (their output is not kept at all) */
export interface Hidden { values: string[]; opaque: string[] }

/** `output` is stdout and stderr as they came; `stdout` is the command's own stdout alone, for a reader that wants the data without the noise */
export interface Limited { code: number | null; timedOut: boolean; missing: boolean; noTimeout: boolean; overflow: boolean; stopped: boolean; output: string; stdout: string }

/**
 * Whether the command is on the PATH, as execvp would find it. timeout(1)'s own "failed to run command"
 * message is localized, so the missing-command reading cannot safely depend on it (AC-009).
 */
function commandFound(name: string, env: NodeJS.ProcessEnv): boolean {
  const executable = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
  if (name.includes("/")) return executable(name);
  for (const dir of (env.PATH ?? "").split(":")) if (dir && executable(join(dir, name))) return true;
  return false;
}

/**
 * Run argv in cwd for at most `minutes`. timeout(1) puts the command in a process group of its own and
 * signals the whole group, so what the command started (a test runner's workers) goes with it. The wait
 * is asynchronous: the engine's event loop keeps answering while a check or a setup command runs.
 *
 * `signal` stops the command from outside (a landing's check is a detached run that a signed landing may have to
 * stop to make room, C-144-5): the whole group is killed and the wait answers with `stopped`.
 */
export function runLimited(cwd: string, argv: string[], minutes: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Limited> {
  const seconds = Math.max(1, Math.ceil(minutes * 60));
  const started = Date.now();
  const limit = outputLimit();
  return new Promise((resolve) => {
    const child = spawn("timeout", ["--kill-after=30", String(seconds), ...argv], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let output = "";
    let stdout = "";
    let overflow = false;
    let outer = false;
    let stopped = false;
    let done = false;
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { outer = true; killGroup(); }, (seconds + COMMAND_GRACE_SECONDS) * 1000);
    const onAbort = () => { stopped = true; killGroup(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const keep = (own: boolean) => (chunk: Buffer | string) => {
      if (overflow) return;
      const text = chunk.toString();
      output += text;
      if (own) stdout += text;
      // the cap is on the collected output; past it the command is stopped and the run is a failure (DEC-2323)
      if (output.length > limit) { overflow = true; killGroup(); }
    };
    child.stdout?.on("data", keep(true));
    child.stderr?.on("data", keep(false));
    const finish = (code: number | null, errorCode?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        // 137 is also a check killed from outside (out of memory); only past the limit is it the limit's kill
        timedOut: !stopped && (outer || code === 124 || (code === 137 && Date.now() - started >= seconds * 1000) || errorCode === "ETIMEDOUT"),
        missing: errorCode === "ENOENT" || (code === 127 && (!commandFound(argv[0], env) || /^timeout: failed to run command/m.test(output))),
        noTimeout: errorCode === "ENOENT",
        overflow,
        stopped,
        output,
        stdout,
      });
    };
    child.on("error", (err) => finish(null, (err as NodeJS.ErrnoException).code));
    child.on("close", (code) => finish(code));
  });
}

export function hideIn(text: string, hide: string[] = []): string {
  let out = text;
  for (const v of [...hide].sort((a, b) => b.length - a.length)) out = out.split(v).join(HIDDEN);
  return out;
}

export function describe(run: Limited, minutes: number, hide?: Hidden): string {
  const head = run.noTimeout ? "timeout(1) が見つからないので回せませんでした（coreutils の timeout が PATH に要ります）"
    : run.timedOut ? CUT_BY_TIME(minutes)
    : run.overflow ? CUT_BY_OUTPUT : "";
  const body = hide?.opaque.length
    ? `copy したファイル（${hide.opaque.join(", ")}）の値を含みうるので出力を省きました（exit ${run.code ?? "?"}）`
    : hideIn(run.output || `exit ${run.code ?? "?"}`, hide?.values).slice(head ? -1400 : -1500);
  return head ? `${head}\n${body}` : body;
}

/** the env for a repo's command: no Linear key, no lane's dangerous-path declaration (the engine's checks are
 * not handed a declaration: reading another repo's would judge it by paths that are not its own), and no lane id
 * inherited from the engine's own process (only a records check is told which lane it runs for) */
export function commandEnv(list?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LINEAR_API_KEY;
  delete env.IDD_CHANGED_FILES;
  delete env.IDD_RISK_PATHS;
  delete env.IDD_ID;
  if (list) env.IDD_CHANGED_FILES = list;
  return env;
}

export async function runChecks(work: string, checks: AreaCheck[], options: CheckOptions = {}): Promise<GateCheck[]> {
  let listDir: string | undefined;
  try {
    let list: string | undefined;
    if (options.changed) {
      listDir = mkdtempSync(join(tmpdir(), "idd-changed-"));
      list = join(listDir, "changed");
      writeFileSync(list, options.changed.map((f) => `${f}\0`).join(""));
    }
    const baseEnv = commandEnv(list);
    const results: GateCheck[] = [];
    // the checks run one at a time, in the configured order: they share the copy, so running them together
    // would let them tread on each other's output and files (DEC-2323)
    for (const check of checks) {
      // a run that was stopped from outside starts nothing more: its results are thrown away where it is discarded
      if (options.signal?.aborted) break;
      const severity = check.required ? "blocking" : "non-blocking";
      if (check.applicable === false) { results.push({ name: check.name, status: "not-applicable", severity }); continue; }
      if (!check.command?.length) { results.push({ name: check.name, status: "skipped", severity, detail: "検査コマンドがありません" }); continue; }
      const minutes = options.timeouts?.[check.name] ?? DEFAULT_CHECK_MINUTES;
      // only a records check is told which lane it runs for: the records rules read a lane's own records, while a
      // public check must run as CI does, with no lane in its environment. In a batch each lane's records are read by
      // the check run for that lane, so one lane's failure names that lane (and a batch id is never a lane's id)
      const perLane = check.scope === "records" && options.laneIds?.length ? options.laneIds : null;
      for (const lane of perLane ?? [undefined]) {
        if (options.signal?.aborted) break;
        const id = lane ?? (check.scope === "records" ? options.laneId : undefined);
        const env = id ? { ...baseEnv, IDD_ID: id } : baseEnv;
        const name = lane ? `${check.name}（${lane}）` : check.name;
        const startedAt = Date.now();
        const run = await runLimited(work, check.command, minutes, env, options.signal);
        const ms = Date.now() - startedAt;
        const tag = lane ? { lane } : {};
        if (run.code === 0 && !run.timedOut && !run.overflow) results.push({ name, status: "pass", severity, ms, ...tag });
        else {
          // the names are read from the whole output, not the tail a detail keeps. A run that did not go to its end
          // (cut, killed by a signal, out of memory, or without the line a finished run prints) names no failure: its
          // list may be partial, and a partial list would read as fewer failures than there are
          const rule = options.failureIds?.[check.name];
          const unread = rule ? unreadOf(run, rule, work, options.hide) : undefined;
          const ids = rule && !unread ? failureIdsOf(run.output, rule.pattern, work).map((id) => hideIn(id, options.hide?.values)) : undefined;
          results.push({
            name, status: run.missing ? "skipped" : "fail", severity, ms, detail: describe(run, minutes, options.hide), exitCode: run.code,
            ...(ids ? { failureIds: ids } : {}), ...(unread ? { failureIdsUnread: unread } : {}), ...tag,
          });
        }
      }
    }
    return results;
  } finally {
    if (listDir) rmSync(listDir, { recursive: true, force: true });
  }
}

/** why a failed run of a check with a failure pattern cannot name its failures, or undefined when it can */
export function unreadOf(run: Limited, rule: FailureIdRule, copy: string, hide?: Hidden): FailureIdsUnread | undefined {
  if (run.timedOut || run.overflow || run.stopped || run.missing || run.noTimeout) return "cut";
  // 128 and past is a signal's end in a shell (137 is SIGKILL, which out of memory sends); null is no code at all
  if (run.code === null || run.code >= 128) return "signal";
  if (hide?.opaque.length) return "hidden";
  if (rule.complete && !ranToEnd(run.output, rule.complete, copy)) return "incomplete";
  return undefined;
}

const ENV_LINE = /^(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*(.*)$/;
/** a value shorter than this is too common a string to take out of an output */
const MIN_HIDDEN = 6;
const MAX_READ = 256 * 1024;

/** where the quote that opened `body` closes (a double quote skips what a backslash escapes), or -1 */
function closing(body: string, quote: string): number {
  for (let i = 0; i < body.length; i += 1) {
    if (quote === '"' && body[i] === "\\") { i += 1; continue; }
    if (body[i] === quote) return i;
  }
  return -1;
}

/**
 * The values of a copied file read as an env file (`KEY=value`, `export KEY=value`, `KEY: value`, comments,
 * quoted values that close later on the line or on a later line; an unquoted value both up to a comment and
 * up to its first #, as flutter_dotenv reads it), each also with its escapes (\n, \t, \")
 * expanded and cut into its lines, since a program may print it either way. A file that is not in this form
 * (JSON, a key store), is too large to read, leaves a quote open, or has more than a comment after a closing
 * quote is opaque: nothing of it can be told apart.
 */
function valuesOf(path: string): { values: string[]; opaque: boolean } {
  const opaque = { values: [], opaque: true };
  let text: string;
  try {
    if (statSync(path).size > MAX_READ) return opaque;
    text = readFileSync(path, "utf8");
  } catch {
    return opaque;
  }
  if (text.includes("\0")) return opaque;
  const raw: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t || t.startsWith("#")) continue;
    const m = ENV_LINE.exec(t);
    if (!m) return opaque;
    const rest = m[1];
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let body = rest.slice(1);
      let at = closing(body, quote);
      while (at < 0 && i + 1 < lines.length) { i += 1; body += `\n${lines[i]}`; at = closing(body, quote); }
      // after the closing quote only a comment may follow; anything else (a second quoted part, YAML's '' escape) is a form not read here
      if (at < 0 || !/^\s*(#.*)?$/.test(body.slice(at + 1))) return opaque;
      raw.push(body.slice(0, at));
    } else {
      raw.push(rest.replace(/(^|\s)#.*$/, "").trim());
      // flutter_dotenv ends an unquoted value at the first #, spaces or not
      raw.push(rest.split("#")[0].trim());
    }
  }
  const values = new Set<string>();
  for (const v of raw) {
    const expanded = v.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\(["'\\$`])/g, "$1");
    for (const x of [v, expanded, ...v.split(/\\n|\r?\n/), ...expanded.split(/\r?\n/)]) {
      const piece = x.trim();
      if (piece.length >= MIN_HIDDEN) values.add(piece);
    }
  }
  return { values: [...values], opaque: false };
}

/**
 * What the files in `copy` hold in the clone `from`, read without cutting or preparing a copy: for a command that runs
 * without `setup` and still must not write a copied file's value into a detail. A path outside the repo is not read.
 */
export function hiddenOf(from: string, copy: string[]): Hidden {
  const hide: Hidden = { values: [], opaque: [] };
  for (const file of copy) {
    const rel = normalize(file);
    const src = join(from, rel);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || !existsSync(src)) continue;
    const read = valuesOf(src);
    hide.values.push(...read.values);
    if (read.opaque) hide.opaque.push(rel);
  }
  return hide;
}

export interface PreparedCopy {
  /** the check that stopped the preparation, or null when the copy is ready */
  failure: GateCheck | null;
  /** what the copied files hold, to be kept out of the checks' details */
  hide: Hidden;
}

/**
 * Make a fresh copy ready for the repo's checks the way a review copy is: the files in `copy` from the
 * clone the copy was cut from (a missing one is skipped), then `setup` in order. The copied files' contents
 * are kept out of every detail. A copy that no longer holds the submitted files afterwards (a tracked file
 * changed, or a file that is not ignored left behind) is not checked: its checks would be about other files.
 */
export async function prepareCopy(copy: string, from: string, prep: CheckPrep, signal?: AbortSignal): Promise<PreparedCopy> {
  const hide: Hidden = { values: [], opaque: [] };
  const fail = (detail: string): PreparedCopy => ({ failure: { name: "setup", status: "fail", severity: "blocking", detail: hideIn(detail, hide.values).slice(-1500) }, hide });
  for (const file of prep.copy) {
    const rel = normalize(file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return fail(`copy は repo の中の相対パスで書いてください: ${file}`);
    const src = join(from, rel);
    if (!existsSync(src)) continue;
    const dst = join(copy, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  Object.assign(hide, hiddenOf(from, prep.copy));
  const env = commandEnv();
  for (const command of prep.setup) {
    // a run stopped from outside stops the setup it is in too: a landing's check may be stopped to make room for a
    // signed one, and waiting out a long `setup` would hold the slot (C-144-5)
    if (signal?.aborted) return fail(`検査を止めました（準備の途中）`);
    const run = await runLimited(copy, ["bash", "-c", command], SETUP_MINUTES, env, signal);
    if (run.code !== 0 || run.timedOut || run.overflow) return fail(`準備のコマンドが失敗しました: ${command}\n${describe(run, SETUP_MINUTES, hide)}`);
  }
  const left = git(copy, ["status", "--porcelain", "--untracked-files=all"]).trim();
  if (left) return fail(`準備が提出内容を変えたので、検査を回していません:\n${left.split("\n").slice(0, 20).join("\n")}`);
  return { failure: null, hide };
}

export interface CopyCheckOptions {
  /** the registry key: its review_root is the place for the copy, its copy / setup / timeouts are used */
  area: string;
  /** the clone the files in `copy` are taken from */
  from: string;
  /** a node_modules linked into the copy when it has none */
  deps?: string;
  /** the files the checks are about (IDD_CHANGED_FILES) */
  changed: string[];
  /** the lane a records check runs for (IDD_ID); a repo-level acceptance names none */
  laneId?: string;
  /** the lanes a batch's tree holds: a records check runs once for each */
  laneIds?: string[];
}

/** the place a copy of a check is cut under: the repo's review_root, or the state when it has none */
export function copyParent(area: string): string {
  const root = readAreas().reviewRoots?.[area];
  const parent = root ? join(root, "submit-checks") : dir("checks");
  mkdirSync(parent, { recursive: true });
  return parent;
}

/**
 * Cut a detached copy of `commit` in the place a check reads, with a node_modules linked in when it has none. The
 * copy is named after the process that runs the check (`copyPid`), not the one that cuts it: a landing's check runs
 * in a detached run, and the copy belongs to that run's life (C-144-1, C-144-7). The caller sweeps and removes it.
 */
export function cutCopy(repo: string, commit: string, options: { area: string; deps?: string; copyPid?: number; name?: string }): string {
  const parent = copyParent(options.area);
  sweepCopies(parent, repo);
  const copy = options.name ?? copyName(parent, options.copyPid);
  git(repo, ["worktree", "add", "--detach", copy, commit]);
  if (options.deps && existsSync(options.deps) && !existsSync(join(copy, "node_modules"))) symlinkSync(options.deps, join(copy, "node_modules"));
  return copy;
}

/**
 * Run a repo's checks in a copy already cut (`cutCopy`): the copied files, the setup commands, the checks, and the
 * reading that the checks changed nothing of what was checked. The copy is the caller's to remove. The checks named in
 * `elsewhere` are left out of the run when the copy is ready (the caller has their result from another run); a copy
 * whose preparation failed skips them with the rest.
 */
export async function runChecksInCopy(copy: string, repo: string, commit: string, checks: AreaCheck[], options: Omit<CopyCheckOptions, "area" | "deps"> & { area: string; signal?: AbortSignal; elsewhere?: string[] }): Promise<GateCheck[]> {
  const areas = readAreas();
  const prep = areas.checkPrep?.[options.area] ?? { copy: [], setup: [], timeouts: {} };
  const ready = await prepareCopy(copy, options.from, prep, options.signal);
  if (ready.failure) return [ready.failure, ...checks.map(c => ({ name: c.name, status: "skipped" as const, severity: c.required ? "blocking" as const : "non-blocking" as const, detail: "準備に失敗したので回していません" }))];
  // a check the caller reads from another run of the same copy (a landing's increment) is not run twice here
  const own = options.elsewhere?.length ? checks.filter((c) => !options.elsewhere?.includes(c.name)) : checks;
  const rules = areas.failureIds?.[options.area];
  const results = await runChecks(copy, own, { timeouts: prep.timeouts, changed: options.changed, hide: ready.hide, ...(options.laneId ? { laneId: options.laneId } : {}), ...(options.laneIds?.length ? { laneIds: options.laneIds } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(rules ? { failureIds: rules } : {}) });
  if (tree(repo, commit) !== tree(copy, "HEAD") || !clean(copy)) results.push({ name: "check-mutation", status: "fail", severity: "blocking", detail: describeMutation(copy, commit) });
  return results;
}

/** how many changed paths the reason of a mutated copy lists before it counts the rest */
const MUTATION_LISTED = 20;
/** how many binary names the reason's last line (the one a card shows) carries */
const MUTATION_NAMED = 3;

/**
 * Why a check that changed the copy fails the run: the paths it changed, and which of them are tracked binaries.
 * A tracked binary a check rewrites is a build product that was committed (a `.pyc`, say), so the reason names it as a
 * generated file: the way out (stop tracking it, or ignore it) is then readable from the card without running the
 * check again. A path of any other kind is listed as a changed path all the same, so no kind of product has to be
 * known beforehand. The last line sums up, because the card shows a check's last line as its reason.
 */
export function describeMutation(copy: string, commit: string): string {
  const head = "検査が提出内容を変更しました";
  try {
    const changed = new Map<string, string>();
    // what the checks left uncommitted (tracked changes and files that are not ignored), as `git status` names them
    for (const entry of git(copy, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]).split("\0").filter(Boolean)) {
      changed.set(entry.slice(3), entry.slice(0, 2));
    }
    // and anything a check committed into the copy: its tree no longer is the submitted one
    for (const path of names(copy, commit, "HEAD")) if (!changed.has(path)) changed.set(path, "C ");
    if (!changed.size) return head;
    // a binary shows as `-\t-\t<path>` in numstat; only a tracked path is in it. Both what a check committed into the
    // copy (the submitted commit against HEAD) and what it left uncommitted (HEAD against the work tree) are read.
    const binary = new Set<string>();
    for (const range of [[commit, "HEAD"], ["HEAD"]]) {
      for (const entry of git(copy, ["diff", ...range, "--numstat", "-z", "--no-renames"]).split("\0").filter(Boolean)) {
        const [added, removed, ...rest] = entry.split("\t");
        if (added === "-" && removed === "-") binary.add(rest.join("\t"));
      }
    }
    const paths = [...changed.keys()];
    const lines = paths.slice(0, MUTATION_LISTED).map((path) => `${changed.get(path)} ${path}`);
    if (paths.length > MUTATION_LISTED) lines.push(`ほか ${paths.length - MUTATION_LISTED} 件`);
    const generated = paths.filter((path) => binary.has(path));
    const named = (list: string[]) => `${list.slice(0, MUTATION_NAMED).join(", ")}${list.length > MUTATION_NAMED ? ` ほか ${list.length - MUTATION_NAMED} 件` : ""}`;
    const sum = generated.length
      ? `変えた path ${paths.length} 件。うち追跡されたバイナリ（生成物）${generated.length} 件: ${named(generated)}。追跡から外すか .gitignore に入れてください`
      : `変えた path ${paths.length} 件: ${named(paths)}`;
    return [`${head}:`, ...lines, sum].join("\n");
  } catch {
    return head;
  }
}

/**
 * Run checks in a detached copy of `commit` cut from `repo`, made ready first (prepareCopy): the submission
 * snapshot and the copy of an import's resolution. The copy goes under the repo's review_root (the state
 * when it has none), copies a dead process left there are swept first, and it is removed afterwards even
 * when a check locked it. A check that changes the copy fails the run.
 */
export async function checkInCopy(repo: string, commit: string, checks: AreaCheck[], options: CopyCheckOptions): Promise<GateCheck[]> {
  const copy = cutCopy(repo, commit, { area: options.area, ...(options.deps ? { deps: options.deps } : {}) });
  try {
    return await runChecksInCopy(copy, repo, commit, checks, options);
  } finally { dropCopy(copy, repo); }
}

export async function runGate(work: string, manifest: Manifest, keep: string[], checks?: AreaCheck[], options: CheckOptions = {}): Promise<GateCheck[]> {
  return [
    { name: "manifest", status: manifest.issues.length ? "fail" : "pass", severity: "blocking", detail: manifest.issues.map(i => `${i.path}: ${i.reason}`).join(" / ") },
    { name: "publish", status: keep.length ? "pass" : "not-applicable", severity: "blocking", detail: keep.length ? undefined : "公開差分なし。記録回収後にローカル完了できます" },
    { name: "worktree", status: clean(work) ? "pass" : "fail", severity: "blocking", detail: clean(work) ? undefined : "未 commit の変更があります" },
    ...(checks ? await runChecks(work, checks, options) : [{ name: "checks", status: "skipped" as const, severity: "blocking" as const, detail: "repo の検査設定がありません" }]),
  ];
}
/** the checks that hold a submit or a landing: a failure the public base has as well does not (`holdsSignature`) */
export function blockingCount(checks: GateCheck[]): number { return checks.filter(holdsSignature).length; }
/**
 * Why the checks hold, as the hold's reason on the ledger: each check that holds, with what the comparison with the
 * public base found before its output, then the failures the base has as well, which do not hold
 */
export function blockingSummary(checks: GateCheck[]): string {
  const held = checks.filter(holdsSignature).map((c) => {
    const phrase = baselinePhrase(c.baseline);
    return `${c.name}: ${phrase ? `${phrase}\n` : ""}${c.detail ?? c.status}`;
  });
  const already = checks.filter(failingAtBase).map((c) => `${c.name}（${baselinePhrase(c.baseline)}）`);
  return [...held, ...(already.length ? [`止めない失敗: ${already.join("、")}`] : [])].join(" / ");
}

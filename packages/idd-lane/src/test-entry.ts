import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one entry every test group is started through. A lane's shell puts a git shim on the PATH and hands down
 * `IDD_` variables that point at the real state; a test that reads either reports a failure that only exists in
 * the lane. The same shell hands down the tool-call limit of the agent (`BASH_MAX_TIMEOUT_MS` and its siblings);
 * a test that reads one of those fails in a Claude Code lane and passes in a clean checkout. The entry starts the
 * runner in an environment where the git shim is off the PATH, no `IDD_` variable is set, the lane's tool-limit
 * variables are dropped, and git may only talk to local files. The gh shim stays, so the entry is not a way out of
 * the lane.
 *
 * A run also gets one place of its own under `_meta/scratch`, handed to the runner in `TEST_SCRATCH_DIR`, and the
 * entry removes that place when the runner is done, passed or failed. The place is the only thing the entry ever
 * removes, and only after a sweep removed the places of runs that were stopped before they could clean up.
 *
 * Only the runner of a known group is ever started, and only the test files given as arguments are handed to it.
 */

export type TestGroup = "test" | "core" | "lane";

/**
 * The variables a lane's shell sets to bound the agent's tool calls (the same set `claudeToolLimitEnv` in runner.ts
 * hands the agent). They reach the test process through the shell that started the runner, so a test that reads one
 * behaves differently in a lane and in a clean checkout. The entry drops them with the `IDD_` variables; the lane's
 * tool limit is the lane's business, not the test's.
 */
export const LANE_TOOL_ENV_KEYS = [
  "BASH_MAX_TIMEOUT_MS",
  "BASH_DEFAULT_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
] as const;

/**
 * The variables the coding agents set that make `bun test` leave out the line of every test that passed. The lane's
 * shell sets them, so a lane's run has no "last test that finished" to read; the entry drops them with the `IDD_`
 * variables. Each of the two drops the lines on its own (checked 2026-10-05, bun 1.3.14); `CLAUDE_CODE_ENTRYPOINT`
 * does not, so it is left in place.
 */
export const AGENT_QUIET_ENV_KEYS = ["CLAUDECODE", "AGENT"] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

/** the checkout the groups run in: the module's own root, so a copy's checks run in the copy */
export function entryRepoRoot(): string {
  return process.env.IDD_LANE_ROOT?.trim() || resolve(HERE, "..", "..", "..");
}

/** the name the land card shows for a group */
export const GROUP_LABELS: Record<TestGroup, string> = { test: "test", core: "test:core", lane: "test:lane" };

interface GroupDef {
  runner: "node" | "bun";
  args: string[];
  targets: string[];
}

const GROUPS: Record<TestGroup, GroupDef> = {
  test: {
    runner: "node",
    args: ["--experimental-strip-types", "--test"],
    targets: ["lib/**/*.test.mjs", "packages/idd-engine/src/**/*.test.mjs", "packages/idd-gui/test/*.test.mjs"],
  },
  core: {
    runner: "node",
    args: ["--experimental-strip-types", "--test"],
    targets: ["packages/idd-core/test/*.test.mjs"],
  },
  lane: {
    runner: "bun",
    // the per-test limit only stops a test that hangs; the default 5 s is short enough to fail a test on a loaded
    // machine alone (the entry's own summary of a stopped run is what reads a real hang)
    args: ["test", "--preload", "./packages/idd-lane/test/helpers/tmp.ts", "--timeout=30000"],
    // `./` makes bun read each target as a path: a bare one is a filter matched against every file path, which also
    // took the tests of the review copies under state/pipeline/review-wt/ when run in the main checkout (2026-10-26)
    targets: ["./packages/idd-lane/test", "./packages/idd-cli/test", "./packages/idd-engine/test"],
  },
};

export function isTestGroup(value: string): value is TestGroup {
  return value === "test" || value === "core" || value === "lane";
}

/**
 * The one place under `_meta/scratch` the entry owns. The name is deliberately not `IDD_`-shaped: `testEntryEnv`
 * drops those, and a variable of the entry's own must not look like one of them.
 */
export const TEST_SCRATCH_ENV = "TEST_SCRATCH_DIR";

/** set this to keep the run's place; the entry writes the path and a marker, and a later sweep leaves it alone */
export const KEEP_TEST_SCRATCH_ENV = "KEEP_TEST_SCRATCH";

/** the file inside a place that tells every later sweep to leave it for a person to remove */
export const KEEP_TEST_SCRATCH_MARKER = "KEEP";

const SCRATCH_PLACE_NAME = "test-runs";
const SCRATCH_RUN_RE = /^run-(\d+)-/;

/** the directory the entry's places live in, under the given checkout root */
export function testScratchPlace(scratchRoot: string): string {
  return join(scratchRoot, "_meta", "scratch", SCRATCH_PLACE_NAME);
}

/** true when the variable asks for the place to be kept */
function wantsKeep(env: NodeJS.ProcessEnv): boolean {
  const value = env[KEEP_TEST_SCRATCH_ENV];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/** the process number a place's name carries, or null when the name does not carry one */
export function scratchOwnerPid(name: string): number | null {
  const m = SCRATCH_RUN_RE.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * True while a process with the pid is still there. Only `ESRCH` means gone; every other answer (`EPERM`, a
 * missing /proc on another platform, an unexpected error) counts as alive, so a place is never removed on doubt.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove the places of earlier runs whose process is gone. A run killed with the entry never removes its own place,
 * so the next run does it here. Only the place directory is read, an entry must be a real directory directly under
 * it (a symlink is never followed), a name without a pid and a place carrying the keep marker are left alone, and
 * a place whose owner is still running is left alone. Nothing outside the place directory is ever touched.
 */
export function sweepTestScratch(scratchRoot: string, onError?: (message: string) => void): void {
  const place = testScratchPlace(scratchRoot);
  let placeStat;
  try {
    placeStat = lstatSync(place);
  } catch {
    return; // no place yet, nothing to sweep
  }
  if (!placeStat.isDirectory()) return; // the place is a symlink or a file: not the entry's to remove
  let names: string[];
  try {
    names = readdirSync(place);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(place, name);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue; // a symlink is not followed
    const pid = scratchOwnerPid(name);
    if (pid === null) continue;
    if (processAlive(pid)) continue;
    if (existsSync(join(dir, KEEP_TEST_SCRATCH_MARKER))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      onError?.(`[test-entry] 止まった回の置き場を消せませんでした: ${dir} (${(e as Error).message})\n`);
    }
  }
}

/** make one run's place; a kept place carries the marker at once, so a later sweep leaves it */
function createTestScratch(scratchRoot: string, keep: boolean): string {
  const place = testScratchPlace(scratchRoot);
  mkdirSync(place, { recursive: true });
  const dir = mkdtempSync(join(place, `run-${process.pid}-`));
  if (keep) writeFileSync(join(dir, KEEP_TEST_SCRATCH_MARKER), `${process.pid}\n`);
  return dir;
}

/**
 * The process numbers that name this run's place in their environment. A conversation's supervisor (and the agents
 * it starts) inherit the runner's environment, so the run's place is how the entry finds what the run left behind.
 * Linux only: where `/proc` cannot be read nothing is found, and the entry goes on as before.
 */
function processesNaming(runDir: string): number[] {
  const wanted = `${TEST_SCRATCH_ENV}=${runDir}`;
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let env: Buffer;
    try {
      env = readFileSync(join("/proc", name, "environ"));
    } catch {
      continue; // another user's process, or one that just ended
    }
    if (env.toString("utf8").split("\0").includes(wanted)) pids.push(Number(name));
  }
  return pids;
}

/**
 * Stop the processes the run left behind before its place goes. A conversation's supervisor is detached and can
 * outlive the runner; left alone it would write into the place after the entry removed it, and the place would come
 * back. Only processes naming this run's place are touched, so another run's work is never reached. Best effort:
 * where `/proc` cannot be read nothing is stopped, and a process that outlasts the SIGTERM grace is killed harder.
 */
export async function stopRunLeftovers(runDir: string, onError?: (message: string) => void): Promise<void> {
  const first = processesNaming(runDir);
  if (!first.length) return;
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") onError?.(`[test-entry] 置き場を書く process を止められませんでした: pid ${pid} (${(e as Error).message})\n`);
    }
  };
  for (const pid of first) signal(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processesNaming(runDir).length) await new Promise<void>((r) => setTimeout(r, 100));
  for (const pid of processesNaming(runDir)) signal(pid, "SIGKILL");
}

/** the shim dir the PATH holds, found by the marker its git shim carries; null when no shim is on the PATH */
function findShimDir(pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      if (readFileSync(join(dir, "git"), "utf8").includes("idd lane shim")) return dir;
    } catch { /* not a shim dir */ }
  }
  return null;
}

/** an executable from the given PATH, resolved before the PATH is rewritten (the runner itself must still start) */
function resolveBinary(name: string, pathValue: string | undefined): string {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return name;
}

/**
 * The environment a test runner is started in. The shim dir is found before the `IDD_` variables are dropped
 * (dropping first would move `laneStateDir()` and lose the shim). `GIT_ALLOW_PROTOCOL` is limited to `file`, so
 * a test's `git push` can reach a local fixture but not the network. The gh shim is copied into a dir of its own
 * and kept first on the PATH; the git shim is left out, so `git` is the real one.
 */
export function testEntryEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const shimDir = findShimDir(base.PATH);
  const dropped = new Set<string>([...LANE_TOOL_ENV_KEYS, ...AGENT_QUIET_ENV_KEYS]);
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("IDD_") && !dropped.has(k)) env[k] = v;
  const realPath = (base.PATH ?? "").split(delimiter).filter((p) => p && (shimDir === null || resolve(p) !== resolve(shimDir)));
  const protocols = (base.GIT_ALLOW_PROTOCOL ?? "").split(":").filter(Boolean);
  if (!protocols.includes("file")) protocols.unshift("file");
  env.GIT_ALLOW_PROTOCOL = protocols.join(":");
  // the disk's free space is the machine's, not the test's: pin the start hold's threshold so a nearly-full / 
  // does not fail every test that cuts a worktree. A test that cares writes storage.min_free_gb itself
  env.PROPTER_DISK_MIN_FREE_GB = "0";
  if (shimDir) {
    const ghDir = mkdtempSync(join(tmpdir(), "idd-test-gh-"));
    copyFileSync(join(shimDir, "gh"), join(ghDir, "gh"));
    chmodSync(join(ghDir, "gh"), 0o755);
    env.PATH = [ghDir, ...realPath].join(delimiter);
  } else {
    env.PATH = realPath.join(delimiter);
  }
  return env;
}

/** the runner and its arguments for a group: the group's own command, plus the test files given (never a caller's command) */
export function testRunnerCommand(group: TestGroup, files: string[], base: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  const def = GROUPS[group];
  const targets = files.length ? files : def.targets;
  const cmd = def.runner === "bun" ? resolveBinary("bun", base.PATH) : process.execPath;
  return { cmd, args: [...def.args, ...targets] };
}

export interface ParsedFailures {
  failed: number;
  names: string[];
}

/** the failing-tests block node's spec reporter ends with: one entry per failed test, and only those */
const NODE_FAILING_BLOCK = "✖ failing tests:";

/**
 * The failed tests out of node's `✖ failing tests:` block, each as `<name> (<file>:<line>:<col>)`. The progress part
 * above the block also lists the suites a failed test sits in, and a test name can repeat across suites; the block
 * lists each failed test once, with the place the test is declared at. The place is part of every name, never only
 * of a repeated one: whether a name repeats can change from one round to the next, and the same test must keep the
 * same name. Empty when the block is not there or holds no test.
 */
function nodeBlockNames(lines: string[]): string[] {
  const start = lines.indexOf(NODE_FAILING_BLOCK);
  if (start < 0) return [];
  const names: string[] = [];
  let place: string | null = null;
  for (const line of lines.slice(start + 1)) {
    const at = line.match(/^test at (\S.*:\d+:\d+)\s*$/);
    if (at) { place = at[1]; continue; }
    const head = line.match(/^✖\s+(.*?)(?:\s+\([\d.]+m?s\))?\s*$/);
    if (!head || !place) continue;
    const name = head[1].trim();
    if (name) names.push(`${name} (${place})`);
    place = null;
  }
  return names;
}

/**
 * The failed test names and count out of a runner's output. Node's spec reporter writes each failure twice and
 * ends its own summary in the middle; when its `failing tests:` block is there the names come from that block (the
 * progress part also lists suites, which the count does not). Otherwise, and for bun's `(fail) name [ms]` and count
 * line, the names are read line by line and de-duplicated in the order they first appear.
 *
 * Bun writes a `<file>.test.ts:` line before a file's tests, and two files can hold a test of the same name; a bun
 * failure under such a line is named `<name> (<file>)`, always, so the same test keeps one name from round to round.
 * A `(fail)` with no such line above it keeps its bare name. Bun's closing recap (`N tests failed:` and the `(fail)`
 * lines again) has no file line, so it is not read: it would add names the count does not have.
 */
export function parseFailures(output: string): ParsedFailures {
  const lines = output.split("\n").map((l) => l.replace(/\r$/, ""));
  const names = nodeBlockNames(lines);
  if (names.length === 0) {
    const seen = new Set<string>();
    let file: string | undefined;
    for (const line of lines) {
      let m: RegExpMatchArray | null;
      if (/^\s*\d+\s+tests?\s+failed:\s*$/.test(line)) break;
      const heading = line.match(/^(\S+\.test\.[cm]?[jt]sx?):\s*$/);
      if (heading) { file = heading[1]; continue; }
      if ((m = line.match(/^✖\s+(.*?)(?:\s+\([\d.]+m?s\))?\s*$/))) {
        // node spec: "✖ name (1.2ms)", and the header "✖ failing tests:" is not a test
      } else if ((m = line.match(/^not ok\s+\d+\s+-\s+(.*?)\s*$/))) {
        // node tap
      } else if ((m = line.match(/^\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?\s*$/))) {
        // bun
        if (file && m[1].trim()) m[1] = `${m[1].trim()} (${file})`;
      } else {
        continue;
      }
      const name = m[1].trim();
      if (!name || name === "failing tests:") continue;
      if (!seen.has(name)) { seen.add(name); names.push(name); }
    }
  }
  const nodeFail = output.match(/^ℹ\s+fail\s+(\d+)\s*$/m);
  const bunFail = output.match(/^\s*(\d+)\s+fail\s*$/m);
  const failed = nodeFail ? Number(nodeFail[1]) : bunFail ? Number(bunFail[1]) : names.length;
  return { failed, names };
}

/** the most the summary may hold: it must fit the detail frame the land card keeps (1400 characters at worst) */
export const SUMMARY_MAX_CHARS = 1300;

/**
 * The block the entry writes at the very end when a group failed: the group, the number of failed tests, and
 * their names. Names that would outgrow the frame are left out, with the count of what is left.
 */
export function failureSummary(group: TestGroup, output: string): string {
  const { failed, names } = parseFailures(output);
  const lines = [`[test-entry] 組 ${GROUP_LABELS[group]} が落ちました: 落ちたテスト ${failed} 件`];
  // the omitted line is written after the loop: keep room for the longest it can be
  const reserve = `  （ほか ${names.length} 件）`.length;
  let used = lines[0].length + 1;
  let shown = 0;
  for (const name of names) {
    const line = `  - ${name}`;
    if (used + line.length + 1 > SUMMARY_MAX_CHARS - reserve) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < names.length) lines.push(`  （ほか ${names.length - shown} 件）`);
  return `${lines.join("\n")}\n`;
}

export interface TestProgress {
  /** the test file the runner is in now, when its output names it (bun does; node's spec reporter does not) */
  file?: string;
  /** the last test the runner reported as finished */
  lastTest?: string;
  /** how many tests finished: the pass and fail lines of both reporters */
  finished: number;
}

/** a report line whose name is a file, not a test: node's spec reporter names a cancelled or failed file that way */
const TEST_FILE_NAME = /\.test\.[cm]?[jt]sx?$/;

/**
 * Where a group got to, read from the runner's own output: the file it is in, the last test that finished, and how
 * many did. `bun test` writes a `file.test.ts:` line before a file's tests and a `(pass)`/`(fail)` line per test;
 * node's spec reporter writes `✔`/`✖` per test and no file line. A `✖` whose name is the file is the reporter's own
 * line, not a test, and is left out. Where both reporters agree, the later line wins.
 */
export function parseProgress(output: string): TestProgress {
  let file: string | undefined;
  let lastTest: string | undefined;
  let finished = 0;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const fileMatch = line.match(/^(\S+\.test\.[cm]?[jt]sx?):\s*$/);
    if (fileMatch) { file = fileMatch[1]; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:\(pass\)|\(fail\))\s+(.*?)(?:\s+\[[\d.]+m?s\])?\s*$/))) {
      // bun: "(pass) name [0.5ms]" and "(fail) name [0.5ms]"
    } else if ((m = line.match(/^\s*[✔✖]\s+(.*?)(?:\s+\([\d.]+m?s\))?\s*$/))) {
      // node spec: "✔ name (1.2ms)" and "✖ name (1.2ms)"
    } else {
      continue;
    }
    const name = m[1].trim();
    if (!name || name === "failing tests:" || TEST_FILE_NAME.test(name)) continue;
    lastTest = name;
    finished += 1;
  }
  return { ...(file ? { file } : {}), ...(lastTest ? { lastTest } : {}), finished };
}

/**
 * The block the entry writes last when `timeout(1)` stopped the group: the group, the elapsed time, how many tests
 * finished, and the last of them. It fits the same frame the failure summary fits, so the tail the land card keeps
 * names where the run had got to when it was stopped.
 */
export function timeoutSummary(group: TestGroup, output: string, elapsedMs: number): string {
  const { file, lastTest, finished } = parseProgress(output);
  const cut = (text: string) => (text.length > 300 ? `${text.slice(0, 299)}…` : text);
  const lines = [
    `[test-entry] 組 ${GROUP_LABELS[group]} が時間で止められました: 経過 ${Math.round(elapsedMs / 1000)} 秒、終わったテスト ${finished} 件`,
    ...(file ? [`  途中のファイル: ${cut(file)}`] : []),
    `  最後に終わったテスト: ${lastTest ? cut(lastTest) : "なし"}`,
  ];
  return `${lines.join("\n")}\n`;
}

export interface TestEntryOptions {
  group: TestGroup;
  /** the test files to run; empty means the group's own default set */
  files?: string[];
  /** the environment to sanitize; the lane's own by default */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** the checkout whose `_meta/scratch` holds the run's place; the entry's own root by default */
  scratchRoot?: string;
  /** keep the run's place for looking at a failure; the KEEP_TEST_SCRATCH variable by default */
  keepScratch?: boolean;
  /** stop the runner early; the place is removed before the promise settles */
  signal?: AbortSignal;
  io?: { stdout?: (text: string) => void; stderr?: (text: string) => void };
}

/**
 * Run one group through the entry. The runner's output is passed through, and on a non-zero exit the summary is
 * written last, so the tail the land card keeps names the group and the failed tests.
 *
 * The run gets a place of its own under `_meta/scratch`, and the place is removed when the runner closes, whether
 * it passed or failed. `signal` stops the runner: the entry kills the runner's process group, waits for it to
 * close, removes the place, and returns a non-zero code; the stopped summary (where the run got to) is written
 * instead of the failure one. No process-wide signal listener is set here: a test calls this function many times
 * in one process, so a listener per call would pile up and change how the test's own signals behave.
 */
export async function runTestEntry(opts: TestEntryOptions): Promise<number> {
  const out = opts.io?.stdout ?? ((t: string) => process.stdout.write(t));
  const err = opts.io?.stderr ?? ((t: string) => process.stderr.write(t));
  const base = opts.env ?? process.env;
  const files = opts.files ?? [];
  if (files.some((f) => f.startsWith("-"))) {
    err(`[test-entry] テストのファイルに option は渡せません: ${files.join(" ")}\n`);
    return 2;
  }
  const { cmd, args } = testRunnerCommand(opts.group, files, base);
  const env = testEntryEnv(base);
  const cwd = opts.cwd ?? entryRepoRoot();
  const scratchRoot = opts.scratchRoot ?? entryRepoRoot();
  const keep = opts.keepScratch ?? wantsKeep(base);
  sweepTestScratch(scratchRoot, err);
  const runDir = createTestScratch(scratchRoot, keep);
  env[TEST_SCRATCH_ENV] = runDir;
  // the user's instructions live in the user's own dir, which the runner's HOME would point at: a test that builds a brief
  // must read none of the real ones. The run's own place holds an empty dir for them, removed with the place
  env.IDD_INSTRUCTIONS_DIR = join(runDir, "instructions");
  const ghDir = env.PATH?.split(delimiter)[0];
  const started = Date.now();
  let output = "";
  let abortListener: (() => void) | null = null;
  let stopped = false;
  let code = 1;
  try {
    code = await new Promise<number>((resolveCode) => {
      const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      const finish = (c: number) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolveCode(c);
      };
      // the runner starts its own process group, so the negative pid reaches it and anything it started
      const stop = () => {
        if (stopped) return;
        stopped = true;
        const pid = child.pid;
        try {
          if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch { /* already gone */ }
        // a runner that ignores the first signal must still not hold the place open, and a runner that outlasts the
        // harder signal must not hold the promise open either: the summary is written from what did arrive
        killTimer = setTimeout(() => {
          try {
            if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { /* already gone */ }
          finish(1);
        }, 5_000);
        killTimer.unref();
      };
      child.stdout?.on("data", (chunk: Buffer) => { const text = chunk.toString(); output += text; out(text); });
      child.stderr?.on("data", (chunk: Buffer) => { const text = chunk.toString(); output += text; err(text); });
      child.on("error", (e) => { err(`[test-entry] 起動できませんでした: ${e.message}\n`); finish(1); });
      child.on("close", (c) => finish(stopped ? 1 : (c ?? 1)));
      const signal = opts.signal;
      abortListener = stop;
      if (signal) {
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }
    });
  } finally {
    if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
    if (ghDir && ghDir.includes("idd-test-gh-")) {
      try { rmSync(ghDir, { recursive: true, force: true }); } catch { /* the tmp dir is not worth failing over */ }
    }
    if (keep) err(`[test-entry] 作業場所を残しました: ${runDir}\n`);
    else {
      // a detached supervisor the run started can outlive the runner: stop it before the place is removed, or its
      // write would put the place back after the entry removed it
      await stopRunLeftovers(runDir, err);
      try { rmSync(runDir, { recursive: true, force: true }); } catch { /* the place is not worth failing over */ }
    }
  }
  // a stopped run writes the stopped summary instead of the failure one: the two are never both last
  if (stopped) err(timeoutSummary(opts.group, output, Date.now() - started));
  else if (code !== 0) err(failureSummary(opts.group, output));
  return code;
}

async function main(argv: string[]): Promise<number> {
  const [group, ...files] = argv;
  if (!group || !isTestGroup(group)) {
    process.stderr.write("[test-entry] 組を指定してください（test / core / lane）\n");
    return 2;
  }
  const controller = new AbortController();
  let received: NodeJS.Signals | null = null;
  const onSigint = () => { received = "SIGINT"; controller.abort(); };
  const onSigterm = () => { received = "SIGTERM"; controller.abort(); };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const code = await runTestEntry({ group, files, signal: controller.signal });
    if (received === "SIGINT") return 130;
    if (received === "SIGTERM") return 143;
    return code;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

// started as a command (not imported by a test): run the group and take its exit code
if (process.argv[1] && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

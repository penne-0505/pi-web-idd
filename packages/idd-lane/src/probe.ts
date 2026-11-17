import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { git, isClean, runShell, tail, type RunResult } from "./git.ts";
import { expandHome, laneStateDir } from "./paths.ts";

export interface ProbeOptions {
  worktree: string;
  /** revert these files to this rev before running */
  to?: string;
  files?: string[];
  /** or apply this patch (git apply) before running */
  patch?: string;
  run: string;
  timeoutMinutes?: number;
  /** snapshot of test names that must fail / pass, for the summary only */
  name?: string;
}

export interface ProbeResult {
  name: string;
  worktree: string;
  reverted: string[];
  patch?: string;
  command: string;
  exit: number;
  timed_out: boolean;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
  failed_tests: string[];
  restored: boolean;
  clean_after: boolean;
}

/** one probe at a time per worktree; a second caller fails fast instead of corrupting the first */
function acquire(worktree: string): () => void {
  const dir = join(laneStateDir(), "locks");
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${Buffer.from(worktree).toString("base64url")}.lock`);
  let fd: number;
  try { fd = openSync(lock, "wx"); } catch {
    const holder = existsSync(lock) ? readFileSync(lock, "utf8") : "?";
    throw new Error(`この worktree は別のプローブが使用中です（${holder.trim()}）: ${worktree}`);
  }
  writeFileSync(lock, `pid ${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);
  return () => { try { unlinkSync(lock); } catch { /* gone */ } };
}

/**
 * The real git, not the lane shim. A probe launched from inside a lane inherits the shim PATH,
 * which refuses `reset --hard`; the restore is the tool's own guarantee (INV-017), so it bypasses
 * the shim by resolving git through IDD_LANE_REAL_PATH.
 */
function realGitBinary(): string {
  const real = process.env.IDD_LANE_REAL_PATH;
  if (!real) return "git";
  for (const dir of real.split(delimiter)) {
    if (dir && existsSync(join(dir, "git"))) return join(dir, "git");
  }
  return "git";
}

function gitRestore(cwd: string, args: string[]): boolean {
  try {
    execFileSync(realGitBinary(), args, { cwd, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch { return false; }
}

function extractFailedTests(out: string): string[] {
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    // flutter test: "  ✗ name" / "[E] name" / "Some tests failed" lines
    const m = line.match(/^\s*(?:✗|\[E\]|✖)\s+(.+?)\s*$/);
    if (m) names.add(m[1].trim());
    const m2 = line.match(/^\s*\d{2}:\d{2} \+\d+ -\d+: (.+?) \[E\]\s*$/);
    if (m2) names.add(m2[1].trim());
    const m3 = line.match(/^(?:not ok|FAIL(?:ED)?)[: ]+(.+)$/i);
    if (m3) names.add(m3[1].trim());
  }
  return [...names];
}

export function runProbe(opts: ProbeOptions): ProbeResult {
  const worktree = resolve(expandHome(opts.worktree));
  if (!opts.to && !opts.patch) throw new Error("--to REV -- files... か --patch FILE が必要です");
  if (opts.to && !opts.files?.length) throw new Error("--to には対象ファイルを 1 つ以上指定してください");
  if (!isClean(worktree)) throw new Error(`worktree が clean ではありません（プローブ前に片付けてください）: ${worktree}`);
  const release = acquire(worktree);
  const reverted: string[] = [];
  let result: RunResult | null = null;
  let patchApplied = false;
  let restored = false;
  try {
    if (opts.to) {
      for (const f of opts.files ?? []) {
        const content = git(worktree, ["show", `${opts.to}:${f}`]);
        writeFileSync(join(worktree, f), content);
        reverted.push(f);
      }
    }
    if (opts.patch) {
      git(worktree, ["apply", "--index", "--whitespace=nowarn", resolve(expandHome(opts.patch))]);
      patchApplied = true;
    }
    result = runShell(worktree, opts.run, { timeoutMs: (opts.timeoutMinutes ?? 15) * 60 * 1000 });
  } finally {
    // restore no matter what; a probe must not leave the worktree modified
    restored = gitRestore(worktree, ["reset", "--quiet", "--hard", "HEAD"]);
    restored = gitRestore(worktree, ["clean", "--quiet", "-fd", "--", ...(reverted.length ? reverted : ["."])]) && restored;
    if (patchApplied) restored = gitRestore(worktree, ["reset", "--quiet", "--hard", "HEAD"]) && restored;
    release();
  }
  const clean = isClean(worktree);
  const r = result as RunResult;
  const combined = `${r.stdout}\n${r.stderr}`;
  return {
    name: opts.name ?? (opts.to ? `revert ${reverted.length} file(s) to ${opts.to}` : `patch ${opts.patch}`),
    worktree, reverted, ...(opts.patch ? { patch: opts.patch } : {}), command: opts.run,
    exit: r.exit, timed_out: r.timedOut, duration_ms: r.durationMs,
    stdout_tail: tail(r.stdout), stderr_tail: tail(r.stderr, 20),
    failed_tests: extractFailedTests(combined), restored, clean_after: clean,
  };
}

/** keep a copy of a probe result next to the lane report for the record */
export function saveProbe(res: ProbeResult, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, `probe-${Date.now()}.json`);
  writeFileSync(p, `${JSON.stringify(res, null, 2)}\n`);
  return p;
}

export function cleanupProbeArtifacts(worktree: string): void {
  const p = join(resolve(expandHome(worktree)), ".idd-probe");
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

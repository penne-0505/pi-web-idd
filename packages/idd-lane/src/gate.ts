import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { agentEnv } from "./agent-env.ts";
import { git, gitTry, headOf, isClean, runShell, tail } from "./git.ts";
import { expandHome } from "./paths.ts";
import { repoForPath, riskPathsEnv, type LaneRepo } from "./repos.ts";
import { parseRenameDiff, placeMovesOf, type PlaceMove } from "../../idd-core/src/intent/rename.ts";

/** a large repo's changed and untracked files outgrow a child process's default output buffer (1MB) */
const LIST_BUFFER = 64 * 1024 * 1024;

/** the limit one check runs under when its definition writes none: the same value `idd gate` and `idd wait-run --check` use */
export const GATE_DEFAULT_TIMEOUT_MINUTES = 20;

export interface GateCheck {
  name: string;
  command: string;
  required: boolean;
  exit: number;
  duration_ms: number;
  timed_out: boolean;
  tail: string;
}

export interface GateResult {
  worktree: string;
  head: string;
  repo: string;
  ok: boolean;
  clean_before: boolean;
  clean_after: boolean;
  checks: GateCheck[];
}

/**
 * Where the repo's base may be found in the clone of `worktree`, in order: `<remote>/<base>`, the local
 * `<base>`, the public base a submission fetched into the work clone (`refs/idd/public/<key>`, the engine's
 * fetchPublic), and the one remote that has `<base>` when the clone's remote is named otherwise (a work
 * clone that fetches from `dayseum`). Two remotes with it are no answer: the pick would be a guess.
 */
function baseRefs(worktree: string, repo: LaneRepo, baseName: string = repo.base): string[] {
  const refs = repo.remote ? [`${repo.remote}/${baseName}`, baseName] : [baseName];
  refs.push(`refs/idd/public/${createHash("sha256").update(JSON.stringify(baseName)).digest("hex")}`);
  const remotes = (gitTry(worktree, ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${baseName}`]) ?? "").split("\n").filter(Boolean);
  if (remotes.length === 1) refs.push(remotes[0]);
  return refs;
}

/** where the list of changed files starts for `head`: its merge base with the first of baseRefs the clone has, null when none */
export function changeStartOf(worktree: string, repo: LaneRepo, head: string): string | null {
  return baseRefs(worktree, repo).map((ref) => gitTry(worktree, ["merge-base", ref, head])?.trim()).find(Boolean) || null;
}

/**
 * The files the worktree changes against the repo's base (the merge base with the first of baseRefs that
 * the clone has): committed, uncommitted and untracked, deleted ones left out. Null when no base is found.
 */
export function changedSinceBase(worktree: string, repo: LaneRepo): string[] | null {
  const base = changeStartOf(worktree, repo, "HEAD");
  if (!base) return null;
  const list = (args: string[]): string | null => {
    try {
      return git(worktree, args, { maxBuffer: LIST_BUFFER });
    } catch {
      return null;
    }
  };
  const tracked = list(["diff", "--no-renames", "--name-only", "-z", "--diff-filter=d", base]);
  const untracked = list(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (tracked === null || untracked === null) return null;
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
}

/**
 * The files the worktree touches against the repo's base: committed, uncommitted and untracked, deleted ones
 * included. A rename shows as its old path and its new one. Null when no base is found. This is the list an
 * instruction that must answer for a removed Place needs; `changedSinceBase` stays the list the gate checks
 * read, which leaves deletions out.
 */
export function touchedSinceBase(worktree: string, repo: LaneRepo): string[] | null {
  // a lane is cut from the work side's mainline, so what it touched is counted from there, not from the public
  // base the gate's own list uses: the public base may be far behind, and its whole difference would read as the
  // lane's. A repo with no work_base keeps the public base.
  const base = baseRefs(worktree, repo, repo.workBase ?? repo.base).map((ref) => gitTry(worktree, ["merge-base", ref, "HEAD"])?.trim()).find(Boolean);
  if (!base) return null;
  const list = (args: string[]): string | null => {
    try {
      return git(worktree, args, { maxBuffer: LIST_BUFFER });
    } catch {
      return null;
    }
  };
  const tracked = list(["diff", "--no-renames", "--name-only", "-z", base]);
  const untracked = list(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (tracked === null || untracked === null) return null;
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
}

/**
 * The renames the worktree made against the repo's base, read with git's own rename detection. It reads the same
 * diff the landing reads (`parseRenameDiff` / `placeMovesOf`), so the lane's own check and the landing's follow
 * agree on what moved: a Place on a moved file is looked at where the file went, and is followed there when the
 * lane lands. Null when no base is found.
 */
export function placeMovesSinceBase(worktree: string, repo: LaneRepo): PlaceMove[] | null {
  const base = baseRefs(worktree, repo, repo.workBase ?? repo.base).map((ref) => gitTry(worktree, ["merge-base", ref, "HEAD"])?.trim()).find(Boolean);
  if (!base) return null;
  let raw: string;
  try {
    raw = git(worktree, ["diff", "-M", "--name-status", "-z", base], { maxBuffer: LIST_BUFFER });
  } catch {
    return null;
  }
  const files = parseRenameDiff(raw);
  if (!files.length) return [];
  const dirExists = (path: string): boolean => gitTry(worktree, ["cat-file", "-t", `HEAD:${path.replace(/\/$/, "")}`])?.trim() === "tree";
  return placeMovesOf(files, dirExists);
}

/** the base names of every file git tracks or finds untracked in the worktree, for a verification anchor written as a bare test name */
export function fileNamesInTree(worktree: string): (name: string) => boolean {
  const list = (args: string[]): string => {
    try {
      return git(worktree, args, { maxBuffer: LIST_BUFFER });
    } catch {
      return "";
    }
  };
  const names = new Set(
    `${list(["ls-files", "-z"])}${list(["ls-files", "-z", "--others", "--exclude-standard"])}`
      .split("\0")
      .filter(Boolean)
      .map((path) => path.split("/").pop() ?? path),
  );
  return (name: string) => names.has(name);
}

/** Run the repo's gate checks in the given worktree (cwd is never redirected to another clone). */
export function runGate(worktree: string, opts: { repo?: LaneRepo; only?: string[]; stopOnFail?: boolean } = {}): GateResult {
  const abs = resolve(expandHome(worktree));
  const repo = opts.repo ?? repoForPath(abs);
  if (!repo) throw new Error(`config/repos.yaml にこの path を含む repo がありません: ${abs}`);
  const cleanBefore = isClean(abs);
  const checks: GateCheck[] = [];
  let ok = true;
  // the list is taken before any check runs, so what a check writes is not in it
  const changed = changedSinceBase(abs, repo);
  const listDir = changed ? mkdtempSync(join(tmpdir(), "idd-changed-")) : null;
  // a check is not an agent, but it has no more need of the engine's credentials than one
  const env = agentEnv();
  delete env.IDD_CHANGED_FILES;
  // the worktree's repo decides the declaration: another repo's, inherited from the caller, is never used
  delete env.IDD_RISK_PATHS;
  Object.assign(env, riskPathsEnv(repo));
  try {
    if (listDir && changed) {
      env.IDD_CHANGED_FILES = join(listDir, "changed");
      writeFileSync(env.IDD_CHANGED_FILES, changed.map((f) => `${f}\0`).join(""));
    }
    for (const c of repo.checks) {
      if (opts.only?.length && !opts.only.includes(c.name)) continue;
      const r = runShell(abs, c.command, { timeoutMs: (c.timeoutMinutes ?? GATE_DEFAULT_TIMEOUT_MINUTES) * 60 * 1000, env });
      checks.push({ name: c.name, command: c.command, required: c.required, exit: r.exit, duration_ms: r.durationMs, timed_out: r.timedOut, tail: tail(`${r.stdout}\n${r.stderr}`, 30) });
      if (r.exit !== 0 && c.required) {
        ok = false;
        if (opts.stopOnFail) break;
      }
    }
  } finally {
    if (listDir) rmSync(listDir, { recursive: true, force: true });
  }
  return { worktree: abs, head: headOf(abs), repo: repo.name, ok, clean_before: cleanBefore, clean_after: isClean(abs), checks };
}

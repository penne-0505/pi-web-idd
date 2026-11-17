
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { readManifest } from "../overlay/manifest.ts";
import { workBaseManifest } from "../overlay/work-base.ts";
import { branchFor, readAreas } from "../config/areas.ts";
import { readLifecycle } from "../ledger/read.ts";
import { laneHasEnded } from "../ledger/ends.ts";
import { resolveWorktree } from "./changed-files.ts";
import { laneStartHold, LaneStartHeldError } from "../storage/hold.ts";
import { laneStartPoint } from "../overlay/base.ts";
import { laneRecording, recordedLaneBranch, recordLaneCut } from "./lane-branch.ts";

export { recordedLaneBranch };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
}

export interface LaneWorktree {
  path: string;
  branch: string;
}

export function lanesRoot(area: string): string | null {
  const cfg = readAreas().areas[area];
  if (!cfg?.local_path) return null;
  return cfg.lanes_root || join(dirname(cfg.local_path), `${basename(cfg.local_path)}-lanes`);
}

/** the worktree that has the branch checked out, if any */
function worktreeHolding(repo: string, branch: string): string | undefined {
  let path: string | undefined;
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

function laneEnded(iddId: string): boolean {
  return laneHasEnded(iddId, readLifecycle());
}

function branchExists(repo: string, branch: string): boolean {
  try { git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); return true; } catch { return false; }
}

/** the name with the first free suffix (-2, -3 ...): the Issue's identifier stays in it */
function freshBranch(repo: string, named: string, iddId: string): string {
  for (let n = 2; ; n += 1) {
    const candidate = `${named}-${n}`;
    if (!branchExists(repo, candidate) && !laneRecording(candidate, iddId)) return candidate;
  }
}

function heldError(root: string, holder: string, branch: string): Error {
  const rel = relative(root, holder);
  const inLanes = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return new Error(inLanes
    ? `branch ${branch} は前の lane の worktree（${holder}）が使っています。同じ Issue を取り込み直した lane は、前の lane の worktree を退役させてから始めてください`
    : `branch ${branch} は lane の置き場の外の worktree（${holder}）が使っています。その worktree で作業中でないか確かめ、使い終えていれば外してから始めてください`);
}

export function ensureLaneWorktree(area: string, iddId: string): LaneWorktree | null {
  const cfg = readAreas().areas[area];
  const root = lanesRoot(area);
  if (!cfg?.local_path || !root || !existsSync(cfg.local_path)) return null;

  const recorded = recordedLaneBranch(iddId);
  const named = recorded ?? branchFor(area, iddId);
  const path = join(root, iddId);
  if (!cfg.work_base || !cfg.public_base) throw new Error("repo に work_base と public_base を設定してください");
  git(cfg.local_path, ["check-ref-format", "--branch", named]);
  git(cfg.local_path, ["rev-parse", "--verify", `refs/heads/${cfg.work_base}`]);
  if (existsSync(path)) {
    const current = git(path, ["branch", "--show-current"]).trim();
    // a lane made on a suffixed branch that has not recorded it in a session yet
    const same = current === named || (!recorded && new RegExp(`^${named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(current));
    if (!same || readManifest(path).issues.length) throw new Error("既存 lane の branch または overlay が一致しません");
    // a lane cut before its cut was recorded, or whose record was cut short, is recorded now
    recordLaneCut(iddId, current);
    return { path, branch: current };
  }
  let branch = named;
  let hasBranch = branchExists(cfg.local_path, branch);
  if (hasBranch) {
    const owner = recorded ? undefined : laneRecording(branch, iddId);
    // the branch of a lane still going on is that lane's, with its worktree there or not
    if (owner && !laneEnded(owner)) throw new Error(`branch ${branch} は進行中の lane ${owner} のものです。同じ Issue の lane を 2 つ同時には進めません`);
    const holder = worktreeHolding(cfg.local_path, branch);
    if (holder) throw heldError(root, holder, branch);
    if (owner) {
      // an ended lane's branch holds its commits and what it threw away: the Issue taken in again starts fresh
      branch = freshBranch(cfg.local_path, named, iddId);
      hasBranch = false;
    }
  }
  // before any worktree or branch: what the worktree is cut from (the branch it takes, else the parent's work, else
  // the work base) without a usable manifest would stop the lane half made. A refusal is a failure, not a wait
  const start = hasBranch ? `refs/heads/${branch}` : laneStartPoint(iddId) ?? cfg.work_base;
  const shortfall = workBaseManifest(area, start === cfg.work_base ? undefined : start);
  if (shortfall) throw new Error(shortfall.message);
  // a new worktree is not cut when the place is out of space: the lane waits for the next pass, and no failure is recorded
  const hold = laneStartHold(area);
  if (hold) throw new LaneStartHeldError(hold);
  // a lane stacked on another lane starts from the parent's published work, else from the work branch
  git(cfg.local_path, hasBranch
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, start]);
  // the cut is recorded at once: the session is recorded only once its spawn goes through, and a lane whose spawn
  // failed has its branch all the same (the planner's and the executor's paths both come here)
  recordLaneCut(iddId, branch);
  if (readManifest(path).issues.length) throw new Error("lane の manifest が不正です");
  return { path, branch };
}

/**
 * Where a lane's committed work is read once its worktree was retired: the lane's branch in the work clone.
 * Undefined while the worktree is there, or when the branch is gone too.
 */
export function laneBranchSource(area: string, worktreePath: string | undefined, branch: string | undefined): { repo: string; ref: string } | undefined {
  if (!worktreePath || !branch || resolveWorktree(worktreePath)) return undefined;
  const repo = readAreas().areas[area]?.local_path;
  if (!repo || !existsSync(repo)) return undefined;
  const ref = `refs/heads/${branch}`;
  try { git(repo, ["rev-parse", "--verify", "--quiet", ref]); } catch { return undefined; }
  return { repo, ref };
}

/** whether two commits hold the same files: the same commit, or no difference between their trees */
export function sameTree(worktreePath: string, a: string, b: string): boolean {
  if (a === b) return true;
  try {
    git(worktreePath, ["diff", "--quiet", a, b, "--"]);
    return true;
  } catch {
    return false;
  }
}

export function headCommit(worktreePath: string): string | null {
  try {
    return git(worktreePath, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

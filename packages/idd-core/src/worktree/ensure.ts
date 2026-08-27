// intent: DEC-670 — lane ごとに worktree を切る。lane の作業が互いの working tree を踏まない前提を物理で担保する

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { branchFor, readAreas } from "../config/areas.ts";

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

export function ensureLaneWorktree(area: string, iddId: string): LaneWorktree | null {
  const cfg = readAreas().areas[area];
  const root = lanesRoot(area);
  if (!cfg?.local_path || !root || !existsSync(cfg.local_path)) return null;

  const branch = branchFor(area, iddId);
  const path = join(root, iddId);
  if (existsSync(path)) return { path, branch };

  const hasBranch = (() => {
    try {
      git(cfg.local_path, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  })();

  git(cfg.local_path, hasBranch
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path]);
  return { path, branch };
}

// intent: DEC-685 — 実装の起点 commit を記録する。差分の基準がないと「何を書いたか」が後から復元できない
export function headCommit(worktreePath: string): string | null {
  try {
    return git(worktreePath, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}


import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { stateDir } from "../paths.ts";

interface UnusedSessionRecord {
  idd_id: string;
  planner_session_id?: string;
  executor_session_id?: string;
  started_at: string;
  worktree_path: string;
  branch: string;
  model?: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function resolveWorktree(path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(stateDir(), path);
  return existsSync(abs) ? abs : null;
}

const cache = new Map<string, { at: number; files: { path: string; delta: string }[] }>();
const TTL_MS = 5000;

/**
 * The files a lane changed, against where it started. A lane whose worktree was retired is read from `branch`
 * (its committed state) in place of the worktree.
 */
export function changedFiles(worktreePath: string, fromCommit?: string, branch?: { repo: string; ref: string }): { path: string; delta: string }[] {
  const tree = resolveWorktree(worktreePath);
  const cwd = tree ?? (branch && existsSync(branch.repo) ? branch.repo : null);
  if (!cwd) return [];
  const head = tree ? "HEAD" : branch!.ref;

  const key = `${cwd}::${head}::${fromCommit ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;

  let base = fromCommit?.trim();
  if (!base) {
    for (const ref of ["origin/main", "main", "origin/master", "master"]) {
      const merged = git(cwd, ["merge-base", head, ref])?.trim();
      if (merged) { base = merged; break; }
    }
  }
  if (!base) return [];

  // the worktree's uncommitted edits count; a branch has only what it committed
  const out = git(cwd, tree ? ["diff", "--numstat", base] : ["diff", "--numstat", base, head]);
  if (out === null) return [];

  const files = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...rest] = l.split("\t");
      const path = rest.join("\t");
      const plus = add === "-" ? "" : `+${add}`;
      const minus = del === "-" ? "" : `−${del}`;
      return { path, delta: [plus, minus].filter(Boolean).join(" ") || "binary" };
    })
    .filter((f) => f.path);

  cache.set(key, { at: Date.now(), files });
  return files;
}

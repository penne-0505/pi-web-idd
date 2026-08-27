// intent: DEC-607 — 触っているファイルは worktree の git から取り、起点が無ければ空を返す

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

export function changedFiles(worktreePath: string, fromCommit?: string): { path: string; delta: string }[] {
  const cwd = resolveWorktree(worktreePath);
  if (!cwd) return [];

  const key = `${cwd}::${fromCommit ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;

  let base = fromCommit?.trim();
  if (!base) {
    for (const ref of ["origin/main", "main", "origin/master", "master"]) {
      const merged = git(cwd, ["merge-base", "HEAD", ref])?.trim();
      if (merged) { base = merged; break; }
    }
  }
  if (!base) return [];

  const out = git(cwd, ["diff", "--numstat", base]);
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

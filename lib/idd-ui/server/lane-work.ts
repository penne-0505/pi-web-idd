// intent: lane が「いま何を触っているか」を実物から取る。
// executor-progress の recent_activity は自然文なので file 一覧の代わりにならない (あれは stream 側で使う)。
// worktree の場所は planner/executor-sessions.jsonl が持っているので、そこで git を叩く。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { stateDir } from "./state-paths";

export interface SessionRecord {
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

/** worktree_path は state file からの相対で書かれうる。 */
export function resolveWorktree(path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(stateDir(), path);
  return existsSync(abs) ? abs : null;
}

/* lane detail を開くたびに git を叩かないよう、短く memo 化する。
   実装中の lane は数秒で変わるので、長く持つと嘘になる。 */
const cache = new Map<string, { at: number; files: { path: string; delta: string }[] }>();
const TTL_MS = 5000;

/**
 * 起点からの差分。起点は s2_start の started_from_commit があればそれ、
 * 無ければ既定ブランチとの分岐点。どちらも取れなければ空を返す (嘘を出さない)。
 */
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

  // 未 commit の変更も含めたいので working tree との比較 (--numstat は名前と増減だけ)
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

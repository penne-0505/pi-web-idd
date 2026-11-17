import { existsSync } from "node:fs";

import { readAreas } from "../config/areas.ts";
import { attempt } from "./git.ts";
import { MANIFEST_FILE, parseManifest } from "./manifest.ts";

export interface WorkBaseManifest {
  /** what to say to the person who sets the repo up: what is wrong (no manifest, or the file and why it cannot be used), and how to prepare it */
  message: string;
}

/** why a `git ls-tree` row is not a file git checks out and reads (a symlink points elsewhere, a submodule is a commit), or null for a regular file */
function notRegularFile(row: string): string | null {
  const [mode, type] = row.split(/\s+/);
  if (type === "blob" && (mode === "100644" || mode === "100755")) return null;
  return mode === "120000" ? "symlink" : type === "commit" ? "submodule" : "通常の file ではない entry";
}

/**
 * What a lane's worktree is cut from must hold the overlay's list, as a regular file git can check out and read. The
 * manifest is read from a rev, not from a working tree, so intake and the worktree step see the same one: the work
 * base's by default, or the rev the worktree is cut from (`cutFrom`: a parent lane's work, or the branch the lane
 * already has). Null when it is usable, and also when it cannot be told here: no work clone on this machine, no
 * work_base set, or a clone git cannot read. Those are not a missing manifest, and the lane's start keeps answering
 * them in its own words.
 */
export function workBaseManifest(area: string, cutFrom?: string): WorkBaseManifest | null {
  const cfg = readAreas().areas[area];
  if (!cfg?.local_path || !cfg.work_base || !existsSync(cfg.local_path)) return null;
  const rev = cutFrom ?? `refs/heads/${cfg.work_base}`;
  if (attempt(cfg.local_path, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) === null) return null;
  const tracked = attempt(cfg.local_path, ["ls-tree", rev, "--", MANIFEST_FILE]);
  if (tracked === null) return null;
  const what = cutFrom ? `lane を切る起点 ${cutFrom}` : `work の本流 ${cfg.work_base}`;
  const where = cutFrom ? `${cfg.local_path} の ${cutFrom} を含む branch（親の lane の branch）` : `${cfg.local_path} の ${cfg.work_base} branch`;
  if (!tracked.trim()) {
    return {
      message: `${what} に ${MANIFEST_FILE} がありません。Issue lane は work の本流から切るので、${where} に ${MANIFEST_FILE} を commit してください。`
        + `中身は、公開側に出さない path を 1 行ずつ書いたものです（例: _docs/ と ${MANIFEST_FILE} 自身の行）`,
    };
  }
  const kind = notRegularFile(tracked);
  const text = kind ? null : attempt(cfg.local_path, ["show", `${rev}:${MANIFEST_FILE}`]);
  // the tree names a regular file but its blob cannot be read (missing from the object database): the commit is
  // readable, so this is the manifest being unusable, not a clone we cannot tell about
  const issues = kind
    ? [{ line: 0, path: MANIFEST_FILE, reason: `通常の file ではなく ${kind} です。checkout して読める通常の file にしてください` }]
    : text === null
      ? [{ line: 0, path: MANIFEST_FILE, reason: "tree には在るが中身（blob）を git の object database から読めません。clone を fetch し直すか、manifest を commit し直してください" }]
      : parseManifest(MANIFEST_FILE, text).issues;
  if (!issues.length) return null;
  const rows = issues.map((i) => (i.line ? `${i.line} 行目 ${i.path}: ${i.reason}` : `${i.path}: ${i.reason}`)).join("、");
  return {
    message: `${what} の ${MANIFEST_FILE} が使えません（${rows}）。${where} で直して commit してください。`
      + `中身は、公開側に出さない repo 相対の path を 1 行ずつ書き、${MANIFEST_FILE} 自身の行を含めたものです`,
  };
}

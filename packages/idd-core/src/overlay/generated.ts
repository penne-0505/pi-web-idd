import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GeneratedFiles } from "../config/generated.ts";
import { commandEnv, describe, runLimited } from "./gate.ts";
import { attempt, commitTree, git, treeFromIndex } from "./git.ts";

/**
 * Generated files at a landing (config/repos.yaml `generated_files`): a file that is a pure function of the sources of
 * its tree is made again in the merge commit, so a conflict on it carries no decision and a text merge of it is never
 * what the tree's sources build. The landing makes it between the merge and the commit, so the tree the checks read is
 * the tree the mainline takes (C-261-1). Only the declared paths are taken out of the build; whatever else the command
 * wrote is dropped with the build's own worktree (C-261-2).
 */

/** the declared paths, as the set a conflict list is read against */
export function generatedPathsOf(outputs: GeneratedFiles[]): Set<string> {
  return new Set(outputs.flatMap((o) => o.paths));
}

/**
 * Whether every path of a conflict is a declared generated file. Such a conflict carries no decision: the file is a
 * function of the sources of the tree, and the landing makes it again from the merged sources (C-261-1). This is the
 * one place that reads the question: the pre-review merge, the S3 record and the landing forecast all ask it, so a
 * conflict is called a conflict by all of them or by none (C-266-4). No path, or no declaration, is not this kind.
 */
export function generatedOnlyConflict(files: string[], outputs: GeneratedFiles[]): boolean {
  if (!files.length || !outputs.length) return false;
  const declared = generatedPathsOf(outputs);
  return files.every((f) => declared.has(f));
}

/**
 * What `git merge-tree --write-tree --name-only --no-messages -z` printed: the merged tree (written whether or not the
 * merge conflicted) and the conflicted paths, NUL-separated so a path with non-ASCII characters is the raw repo-root
 * path and matches a declared one as it is. Null when the first field is no object name.
 */
export function parseMergeTree(out: string): { tree: string; files: string[] } | null {
  const [tree, ...rest] = out.split("\0");
  if (!/^[0-9a-f]{40,64}$/.test(tree?.trim() ?? "")) return null;
  return { tree: tree.trim(), files: [...new Set(rest.filter(Boolean))] };
}

/**
 * Whether a declared path changed on either side of the merge: from the merge base to the mainline tip, or from the base
 * to the lane's head. A landing that touches none of them keeps its tree as the text merge made it (C-261-4). A diff git
 * cannot answer counts as touched: the rebuild that follows falls back by itself when it cannot be made.
 */
export function generatedTouched(cwd: string, base: string, tip: string, head: string, outputs: GeneratedFiles[]): boolean {
  const paths = [...generatedPathsOf(outputs)];
  if (!paths.length) return false;
  for (const side of [tip, head]) {
    const out = attempt(cwd, ["diff", "--no-renames", "--name-only", "-z", base, side, "--", ...paths]);
    if (out === null || out.split("\0").some(Boolean)) return true;
  }
  return false;
}

/** the mode a declared path takes in the tree: the one it has as a regular file, else a plain file */
function modeIn(cwd: string, tree: string, path: string): string | null {
  const out = attempt(cwd, ["ls-tree", "-z", tree, "--", path]);
  const row = out?.split("\0").find(Boolean);
  if (!row) return "100644";
  const mode = row.slice(0, row.indexOf(" "));
  return mode === "100644" || mode === "100755" ? mode : null;
}

/** the blob a declared path holds in a tree, or null when the tree has none */
function blobIn(cwd: string, tree: string, path: string): string | null {
  const out = attempt(cwd, ["rev-parse", "--verify", "--quiet", `${tree}:${path}`]);
  return out ? out.trim() : null;
}

/** a tree that is `tree` with the given blobs at the given paths; nothing else moves */
function treeWithBlobs(cwd: string, tree: string, writes: { path: string; oid: string; mode: string }[]): string {
  return treeFromIndex(cwd, tree, (run) => {
    for (const w of writes) run(["update-index", "--add", "--cacheinfo", `${w.mode},${w.oid},${w.path}`]);
  });
}

/** the generated files made again: the tree they are in, and the declared paths whose bytes differ from the tree they were made from */
export interface Rebuilt {
  tree: string;
  changed: string[];
}

/**
 * Why a rebuild was not made, for the landing it stops. `environment`: the command could not be run here (no
 * worktree, the tool is not found, the time or output limit cut it), so the same head and mainline tip are tried again
 * later and a person is asked only after the checks' own number of tries. `build`: the command ran and refused the
 * merged sources, or did not write the declared file, so the lane's sources are what to fix and the lane is sent back
 * once. A single lane's landing that could not be rebuilt is never checked or approved as one that could: its record has
 * no merge commit and carries the failure, and one decision reads it on every path (`land_unbuilt_next`). The batch
 * landing is the exception and keeps what it did before: it does not wait out an environment failure or send a build
 * failure back itself. A step whose only conflict is on generated files is taken out of the batch; a step without a
 * conflict goes on with the tree git made, and the failure stays on the batch's record (`rebuildFailures`) and card.
 */
export interface RebuildFailure {
  cause: "environment" | "build";
  reason: string;
  paths: string[];
  /** when a single landing's record took the failure: the tick waits from it before it tries the same group again */
  at?: string;
}

/** the exit code a shell gives for a command it did not find, which the build script gives too when moon is missing */
const NOT_FOUND_CODE = 127;

/**
 * Make the declared files again from the sources of `tree`: the tree is checked out in a detached worktree, each
 * declaration's command runs there, and the files it names are written back into the tree as they were built. The
 * answer is a failure, with why, when the worktree cannot be made, a command fails, is cut, or is not found, or a
 * declared file is not a regular file afterwards: a single landing then does not land this tree, while the batch
 * landing goes on as it did before. The failure says whether the environment or the build is to blame, for the tick
 * and the card to tell.
 *
 * `deps` is the `node_modules` the checks read: like the checks' own copy, the worktree gets it as a symlink when the
 * tree carries none, so the command builds against the dependencies the check's build does. The symlink is dropped
 * with the worktree and never reaches the tree, which takes the declared paths only.
 */
export async function rebuildGenerated(input: { cwd: string; tree: string; outputs: GeneratedFiles[]; deps?: string }): Promise<Rebuilt | { failure: RebuildFailure }> {
  const { cwd, tree, outputs, deps } = input;
  if (!outputs.length) return { tree, changed: [] };
  let where: string | undefined;
  const paths = outputs.flatMap((o) => o.paths);
  const failure = (cause: RebuildFailure["cause"], reason: string, own: string[] = paths): { failure: RebuildFailure } => ({ failure: { cause, reason, paths: own } });
  try {
    where = mkdtempSync(join(tmpdir(), "idd-land-generated-"));
    // a commit of the tree alone: the worktree needs a commit to check out, and the scaffold is no history of the repo
    const scaffold = commitTree(cwd, tree, [], "generated files: rebuild scaffold");
    git(cwd, ["worktree", "add", "--detach", where, scaffold]);
    const modules = join(where, "node_modules");
    if (deps && existsSync(deps) && !lstatSync(modules, { throwIfNoEntry: false })) symlinkSync(deps, modules);
    const env = commandEnv();
    const built: { path: string; oid: string; mode: string }[] = [];
    for (const output of outputs) {
      // the merged tree's own copy of a declared file is the very thing in doubt (a text merge, or a conflict-marked
      // file), so it is taken away first: a file found after the command is one the command wrote from these sources
      for (const path of output.paths) rmSync(join(where, path), { force: true });
      const run = await runLimited(where, output.command, output.timeoutMinutes, env);
      if (run.code !== 0 || run.timedOut || run.overflow || run.missing || run.noTimeout) {
        const environment = run.timedOut || run.overflow || run.missing || run.noTimeout || run.stopped || run.code === null || run.code === NOT_FOUND_CODE;
        return failure(environment ? "environment" : "build", `${output.paths.join(", ")} を作り直すコマンドが失敗しました:\n${describe(run, output.timeoutMinutes)}`.slice(0, 1500), output.paths);
      }
      for (const path of output.paths) {
        const mode = modeIn(cwd, tree, path);
        if (mode === null) return failure("build", `${path} は通常の file ではないので作り直せません`, [path]);
        const made = lstatSync(join(where, path), { throwIfNoEntry: false });
        if (!made?.isFile()) return failure("build", `${path} を作り直すコマンドが、通常の file として書きませんでした（成功で終わっても、出力しなければ作り直しとは数えません）`, [path]);
        built.push({ path, oid: git(where, ["hash-object", "-w", "--no-filters", "--", path]).trim(), mode });
      }
    }
    const changed = built.filter((b) => blobIn(cwd, tree, b.path) !== b.oid).map((b) => b.path);
    return { tree: changed.length ? treeWithBlobs(cwd, tree, built.filter((b) => changed.includes(b.path))) : tree, changed };
  } catch (e) {
    // the worktree or a git step could not be made: the environment, not the sources
    return failure("environment", String((e as Error).message ?? e).slice(0, 400));
  } finally {
    if (where) {
      attempt(cwd, ["worktree", "remove", "--force", where]);
      try { rmSync(where, { recursive: true, force: true }); } catch { /* 診断用に残る */ }
      attempt(cwd, ["worktree", "prune"]);
    }
  }
}

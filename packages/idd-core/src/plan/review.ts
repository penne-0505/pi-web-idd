
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { stagePick } from "../ledger/pick.ts";
import { reviewLoopState } from "../ledger/review-loop.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle, transition } from "../ledger/write.ts";
import { readAreas, publishes } from "../config/areas.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { laneBaseWorkRef } from "../overlay/base.ts";
import { generatedOnlyConflict, parseMergeTree } from "../overlay/generated.ts";

function git(cwd: string, args: string[], opts: { maxBuffer?: number; timeout?: number } = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: opts.timeout ?? 20000, ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}), stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * What a diff read may take. Node's default stdout limit (1 MiB) is below a real lane's diff, so a read that hits it is not
 * a diff of nothing: the limit is set far above the diffs a lane produces, and a read that still fails is told on the card.
 */
const DIFF_READ = { maxBuffer: 256 * 1024 * 1024, timeout: 60000 };

export function lanesAwaitingCheck(): BacklogRecord[] {
  const events = readLifecycle();
  const byLane = new Map<string, typeof events>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  return readBacklog().filter((rec) => {
    const laneEvents = byLane.get(rec.idd_id) ?? [];
    // the stage asks its own question, at the moment it asks it (C-199-2)
    return stagePick("check", laneEvents).pick;
  });
}

export interface CheckResult {
  iddId: string;
  outcome: "clean" | "conflict" | "skipped";
  conflictFiles: string[];
  reason?: string;
}

function conflictsAgainst(repo: string, base: string, branch: string): string[] | null {
  try {
    git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, branch]);
    return [];
  } catch (err) {
    const files = parseMergeTree(String((err as { stdout?: string }).stdout ?? ""))?.files ?? [];
    return files.length ? files : null;
  }
}

export async function runCheck(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const declared = readAreas();
  const areas = declared.areas;

  for (const rec of lanesAwaitingCheck()) {
    const session = readSessions("executor").filter((r) => r.idd_id === rec.idd_id).pop();
    const repo = areas[rec.area]?.local_path;
    if (!session || !repo) {
      results.push({ iddId: rec.idd_id, outcome: "skipped", conflictFiles: [], reason: "no session or local_path" });
      continue;
    }

    await appendLifecycle("s3_check_in_progress", rec.idd_id, { check_type: "merge_tree_only" });

    // a stacked lane merges into its parent's branch: the conflicts that matter are with the parent's work
    const against = laneBaseWorkRef(rec.idd_id);
    const found = against ? conflictsAgainst(repo, against, session.branch) : null;
    // a conflict on declared generated files alone holds no decision: the landing makes them again from the merged
    // sources, so the record does not call it a conflict (C-266-3). A publishing repo goes through a PR, where nothing
    // makes them again: its declaration is not applied here (C-266-5)
    const generated = publishes(areas[rec.area]) ? [] : declared.generatedFiles?.[rec.area] ?? [];
    const conflicts = found && generatedOnlyConflict(found, generated) ? [] : found;
    if (conflicts === null) {
      results.push({ iddId: rec.idd_id, outcome: "skipped", conflictFiles: [], reason: "merge-tree に失敗" });
      continue;
    }
    const conflictType = against === `refs/heads/${areas[rec.area]?.work_base}` ? "vs_work_base" : "vs_base_lane";
    // S3 starts through the gate, with the check's outcome in the same hold; a busy gate leaves it for the next tick
    const ready = await transition(rec.idd_id, "s3_ready", {}, {
      then: [conflicts.length
        ? { event: "s3_check_conflict", attrs: { conflict_files: conflicts, conflict_type: conflictType, against } }
        : { event: "s3_check_clean", attrs: {} }],
    });
    if (!ready.ok) {
      results.push({ iddId: rec.idd_id, outcome: "skipped", conflictFiles: [], reason: ready.reason });
      continue;
    }
    results.push(conflicts.length
      ? { iddId: rec.idd_id, outcome: "conflict", conflictFiles: conflicts }
      : { iddId: rec.idd_id, outcome: "clean", conflictFiles: [] });
  }
  return results;
}

/** the lane whose session works in this checkout */
function laneOfWorktree(worktree: string): string | null {
  const at = resolve(worktree);
  const own = [...readSessions("executor"), ...readSessions("planner")].filter((s) => s.worktree_path && resolve(s.worktree_path) === at).pop();
  return own?.idd_id ?? null;
}

/**
 * Where the lane's own changes start: on its parent lane's work for a stacked lane (the parent's last state once it
 * ended), else on the work branch. When the lane's base cannot be read (its parent ended and left nothing), the
 * fallback or null: never the work branch, where the parent's changes would be counted as the lane's.
 */
export function laneBase(worktree: string, fallback?: string): string | null {
  const common = resolve(worktree, git(worktree, ["rev-parse", "--git-common-dir"]).trim());
  const lane = laneOfWorktree(worktree);
  for (const cfg of Object.values(readAreas().areas)) {
    if (!cfg.local_path || !cfg.work_base) continue;
    try {
      if (resolve(cfg.local_path, git(cfg.local_path, ["rev-parse", "--git-common-dir"]).trim()) !== common) continue;
      const ref = lane ? laneBaseWorkRef(lane) : `refs/heads/${cfg.work_base}`;
      if (!ref) return fallback ?? null;
      return git(worktree, ["merge-base", "HEAD", ref]).trim();
    } catch { continue; }
  }
  return fallback ?? null;
}

/**
 * Where the lane's own changes start, read by lane: the merge-base of its head (the worktree's HEAD, or its branch's
 * tip once the worktree is retired) with its base's work branch. A base taken in moves it on, so the base's changes
 * are not counted as the lane's. Null when it cannot be read.
 */
export function laneForkPoint(iddId: string, cwd: string, head = "HEAD"): string | null {
  const ref = laneBaseWorkRef(iddId);
  if (!ref) return null;
  try {
    return git(cwd, ["merge-base", head, ref]).trim() || null;
  } catch {
    return null;
  }
}

export interface LaneDiff {
  file: string;
  fileIndex: number;
  fileTotal: number;
  before: { lineNo?: string; marker?: string; code: string }[];
  after: { lineNo?: string; marker?: string; code: string }[];
  /** why git could not give this file's (or the whole) diff; the lines above then say so and are no diff, so a verdict must not rest on them */
  unread?: string;
}

/**
 * The files the lane changed, as git names them. `-z` keeps a path with a space, a quote or a non-ASCII character exact
 * (git would quote it on a line), and renames are not paired, so a rename reads as the old path removed and the new added,
 * the same way `laneDiffAll` splits the patch.
 */
export function laneDiffFiles(worktree: string, base: string): string[] {
  try {
    return readDiffFiles(worktree, base);
  } catch {
    return [];
  }
}

/**
 * The files changed from `base` to the commit `head`, as git names them; the working tree is not read, and a failure is
 * thrown (`laneDiffFiles` answers none for it, which a caller that must tell the two apart cannot take).
 */
export function laneCommittedFiles(worktree: string, base: string, head: string): string[] {
  return readDiffFiles(worktree, base, undefined, head);
}

function readDiffFiles(worktree: string, base: string, maxBuffer?: number, head?: string): string[] {
  return git(worktree, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-color", base, ...(head ? [head] : [])], { ...DIFF_READ, ...(maxBuffer ? { maxBuffer } : {}) }).split("\0").filter(Boolean);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);

/** a file (or the whole diff) git could not give: the card says so in its own lines, so no one reads it as a diff of nothing */
function unreadDiff(file: string, fileIndex: number, fileTotal: number, why: unknown): LaneDiff & { omitted: { before: number; after: number } } {
  return { file, fileIndex, fileTotal, before: [], after: [{ code: `（この差分は読めませんでした: ${message(why)}）` }], omitted: { before: 0, after: 0 }, unread: message(why) };
}

/** one hunk line list per side, as the card shows them: the lines a patch removed or kept, and the ones it added or kept */
function sidesOfPatch(patch: string, maxLines: number): Pick<LaneDiff, "before" | "after"> {
  const before: LaneDiff["before"] = [];
  const after: LaneDiff["after"] = [];
  let oldNo = 0;
  let newNo = 0;
  // the header ("--- a/x", "+++ b/x") comes before the first hunk; inside a hunk a removed "-- x" line is a line, not a header
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) after.push({ lineNo: String(newNo++), marker: "+", code: line.slice(1) });
    else if (line.startsWith("-")) before.push({ lineNo: String(oldNo++), marker: "-", code: line.slice(1) });
    else if (line.startsWith(" ")) {
      before.push({ lineNo: String(oldNo++), code: line.slice(1) });
      after.push({ lineNo: String(newNo++), code: line.slice(1) });
    }
  }
  return { before: before.slice(0, maxLines), after: after.slice(0, maxLines) };
}

/**
 * Every file the lane changed, each with its own diff, read by one `git diff` (the review card moves from file to
 * file inside the card, so the answer carries them all; a path git quotes in its header still gets its own patch). A side is cut at `maxLines`; `before`/`after` of a file longer than
 * that are the first lines, and `omitted` counts what was left out so the card never reads as if it showed all.
 */
export function laneDiffAll(worktree: string, base: string, opts: { maxLines?: number; maxFiles?: number; maxBuffer?: number } = {}): (LaneDiff & { omitted: { before: number; after: number } })[] {
  const maxLines = opts.maxLines ?? 200;
  const maxFiles = opts.maxFiles ?? 100;
  const read = { ...DIFF_READ, ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}) };
  let files: string[];
  try {
    files = readDiffFiles(worktree, base, opts.maxBuffer);
  } catch (e) {
    // the file list itself is unread: that is no "nothing changed", the review is told it cannot see the files
    return [unreadDiff("（変更した file の一覧）", 1, 1, e)];
  }
  if (!files.length) return [];
  let all: string | null = null;
  try {
    all = git(worktree, ["diff", "--unified=3", "--no-renames", "--no-ext-diff", "--no-color", base], read);
  } catch {
    // the whole diff did not come in one read: each file is read alone below, and one that cannot be read is told
    all = null;
  }
  // Each file is one "diff --git" section, in the same path order as the list above (both come from the same diff with no
  // rename pairing). The section is matched to its file by position, never by reading the path out of the header: git
  // quotes a path with a special character there, and a configured prefix (or none) changes "b/". A body line of a
  // section begins with " ", "+" or "-", so a line that begins "diff --git " is always a header.
  const parts = all === null ? [] : all.split(/^diff --git /m).slice(1);
  const patchOf = (file: string, i: number): string => {
    if (all !== null && parts.length === files.length) return parts[i];
    // the two readings disagree (the tree moved between them), or the whole did not fit: read this file alone rather than pair the wrong patch
    return git(worktree, ["diff", "--unified=3", "--no-renames", "--no-ext-diff", "--no-color", base, "--", `:(literal)${file}`], read);
  };
  return files.slice(0, maxFiles).map((file, i) => {
    let patch: string;
    try {
      patch = patchOf(file, i);
    } catch (e) {
      return unreadDiff(file, i + 1, files.length, e);
    }
    const full = sidesOfPatch(patch, Number.MAX_SAFE_INTEGER);
    return {
      file,
      fileIndex: i + 1,
      fileTotal: files.length,
      before: full.before.slice(0, maxLines),
      after: full.after.slice(0, maxLines),
      omitted: { before: Math.max(0, full.before.length - maxLines), after: Math.max(0, full.after.length - maxLines) },
    };
  });
}

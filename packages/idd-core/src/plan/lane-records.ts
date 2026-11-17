import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { areaSegment, slugOf } from "../intent/parse.ts";
import { git, isLockRefusal, lock } from "../overlay/git.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { headCommit } from "../worktree/ensure.ts";
import type { CommitGate } from "./commit-gate.ts";
import { lanePlanDoc } from "./plan-doc.ts";

/**
 * The commit the harness makes of a lane's planner records. A fixed subject, so a lane's history says what the
 * commit is; the records themselves are private (the overlay keeps them out of the published diff).
 */
const RECORD_COMMIT_SUBJECT = "docs(records): 計画役の記録を commit する";
const RECORD_COMMIT_BODY = "計画役の記録は公開の差分に入らないので、実装役の git add に任せず、ハーネスが確定で commit する。";
/**
 * The trailer the record commit carries while its lane has not started: the head the commit was made against. A
 * start can commit the records and then stop before its `s2_start` (a busy lane gate); the next tick reads the base
 * from the commit it left, so the records stay inside the review's diff even then. The line is the record commit's
 * own, so it leaves no new lifecycle event behind and no other reader is affected.
 */
const RECORD_BASE_TRAILER = "Record-Base:";

/**
 * The directories a lane's planner writes its records in, as they exist in the worktree: the plan, the qa, the
 * reference, the old shape's intent, and the context document the planner and the executor write. Paths the planner
 * never made are left out: a `git add` on a missing directory fails.
 */
export function laneRecordDirs(rec: BacklogRecord, worktree: string): string[] {
  const seg = areaSegment(rec.area);
  const slug = slugOf(rec);
  return [
    `_docs/plan/${seg}/${slug}`,
    `_docs/qa/${seg}/${slug}`,
    `_docs/reference/${seg}/${slug}`,
    `_docs/intent/${seg}/${slug}`,
    `_docs/context/${seg}/${slug}`,
  ].filter((rel) => existsSync(join(worktree, rel)));
}

/** the paths git reports as changed (untracked included), or only those under `paths` when it is given */
export function dirtyPaths(worktree: string, paths?: string[]): string[] {
  if (paths && !paths.length) return [];
  const out = git(worktree, ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames", ...(paths ? ["--", ...paths] : [])]);
  return out.split("\0").filter(Boolean).map((entry) => entry.slice(3));
}

/** whether a changed path is one of the lane's records */
export function isLaneRecordPath(dirs: string[], path: string): boolean {
  return dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/**
 * The review base a record commit already left on the lane's head, or "" when the head is not one of ours. The
 * subject is checked as well, so a `Record-Base:` line an executor's commit happens to carry is not read.
 */
export function pendingRecordBase(worktree: string): string {
  try {
    if (git(worktree, ["log", "-1", "--format=%s"]).trim() !== RECORD_COMMIT_SUBJECT) return "";
    const body = git(worktree, ["log", "-1", "--format=%B"]);
    const m = new RegExp(`^${RECORD_BASE_TRAILER}\\s+([0-9a-f]{7,64})\\s*$`, "m").exec(body);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function errText(e: unknown): string {
  const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err.message ?? e);
}

/**
 * Write the record commit: the record directories are staged and committed alone, so a lane with other changes
 * commits none of them. A commit that does not go through puts the index back to HEAD, so the next tick does not
 * find a half-staged lane and the records stay in the worktree. The commit is the machine's (the records are), so
 * it carries the harness's identity and does not depend on the checkout's git config.
 */
function commitRecordPaths(worktree: string, dirs: string[], base?: string): { ok: true } | { ok: false; reason: string } {
  const body = base ? `${RECORD_COMMIT_BODY}\n\n${RECORD_BASE_TRAILER} ${base}` : RECORD_COMMIT_BODY;
  try {
    git(worktree, ["add", "--", ...dirs]);
    git(worktree, ["-c", "user.name=IDD", "-c", "user.email=idd@localhost", "commit", "-q", "-m", RECORD_COMMIT_SUBJECT, "-m", body, "--", ...dirs]);
    return { ok: true };
  } catch (err) {
    try { git(worktree, ["reset", "-q", "HEAD", "--", ...dirs]); } catch { /* the worktree keeps the records; git status shows what is left */ }
    return { ok: false, reason: `計画役の記録を commit できませんでした: ${errText(err).slice(0, 300)}` };
  }
}

export interface RecordCommitOptions {
  /**
   * Right before the commit: take what the commit must hold and say whether the branch may still be written. A
   * refusal is returned as the result; `later` says the cause was a wait (the repo's lock) rather than the worktree.
   */
  beforeCommit?: () => CommitGate;
}

export type RecordCommitResult = { ok: true } | { ok: false; reason: string; later?: true };

/** commit the lane's records under the given gate, releasing it when the commit is done */
export function commitRecordChanges(worktree: string, dirs: string[], opts: RecordCommitOptions = {}): RecordCommitResult {
  let hold: { release: () => void } | undefined;
  try {
    if (opts.beforeCommit) {
      const gate = opts.beforeCommit();
      if ("refuse" in gate) return { ok: false, reason: gate.refuse, ...(gate.later ? { later: true as const } : {}) };
      hold = gate;
    }
    return commitRecordPaths(worktree, dirs);
  } finally {
    hold?.release();
  }
}

/**
 * The gate the executor start's record commit takes: the repo's overlay lock. Any refusal is read as a wait
 * whatever the holder wrote; the lane stays queued and the next tick commits the records and starts it.
 */
export function overlayLockGate(worktree: string): CommitGate {
  try {
    return { release: lock(worktree) };
  } catch (err) {
    const message = String((err as Error).message ?? err);
    return isLockRefusal(err)
      ? { refuse: `repo の overlay の lock が取られているので、計画役の記録を commit していません: ${message}`, later: true }
      : { refuse: `repo の overlay の lock を取れないので、計画役の記録を commit していません: ${message}`, later: false };
  }
}

export type PlannerRecordCommitResult = { base: string } | { error: string; later?: true };

/**
 * Commit the lane's planner records before its executor starts, and answer the commit the review is diffed from:
 * the head before that commit, so the records stay inside the review's diff. The base rides on the commit
 * itself, so a start that stops after the commit and is tried again reads the same base from its head. The lock is
 * taken whether or not there is anything to commit: the record commit is part of the start, and a start that meets
 * a running check waits.
 */
export function commitPlannerRecords(rec: BacklogRecord, worktree: string): PlannerRecordCommitResult {
  const gate = overlayLockGate(worktree);
  if ("refuse" in gate) return { error: gate.refuse, ...(gate.later ? { later: true as const } : {}) };
  try {
    const pending = pendingRecordBase(worktree);
    const base = pending || headCommit(worktree) || "";
    const dirs = laneRecordDirs(rec, worktree);
    if (!dirtyPaths(worktree, dirs).length) return { base };
    const committed = commitRecordPaths(worktree, dirs, base);
    if (!committed.ok) return { error: committed.reason };
    return { base };
  } finally {
    gate.release();
  }
}

/**
 * The paths the plan's "触る範囲" lists, as the entries `roundTrace` matches a changed file against, every one a
 * repo-relative path. A bullet names a module in backticks and, after a dash, the names under it the change touches
 * (the run of backticked names that opens what follows the dash, told apart by `・`・`、`・`,`・`と`; a path in the
 * reason after it is no file of the change): `dir/` — `a.ts`・`b.ts` is `dir/a.ts` and `dir/b.ts`, not the whole
 * directory (the module is only the parent), and `packages/x/` — `dist/`・`dist/x.js` is `packages/x/dist/` and
 * `packages/x/dist/x.js`. A name with a directory in it may as well be written from the repo's root, so it is kept as
 * written too (a name that opens with the module's own path only so). A module with no name after it is the whole
 * directory, a file path stands for itself, and a bullet the plan marks 範囲外 names nothing. A table row is read as
 * `referenceTokens` (`base-advance.ts`) reads one: the paths of its first cell are the places, and the cells after it
 * are the reason. A glob (`packages/*` + `/test/`) is kept as written; the fold matches a changed file against it (`*`
 * inside one segment, `**` across segments).
 */
export function planTouchScope(planMd: string): string[] {
  const lines = planMd.split("\n");
  const at = lines.findIndex((l) => /^\s*-\s*触る範囲/.test(l));
  if (at < 0) return [];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const base = indentOf(lines[at]!);
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    if (indentOf(line) <= base) break;
    out.push(...(line.trimStart().startsWith("|") ? tableRowPlaces(line) : bulletPlaces(line)));
  }
  return [...new Set(out)];
}

const backquotedNames = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** whether the text a place is explained by opens by marking the place 範囲外: a bullet's tail after the dash, a table row's reason */
const marksOutOfScope = (text: string): boolean => /^\s*範囲外/.test(text);

/**
 * the places of a table row: the paths of its first cell, the cells after it being the reason (the header and the
 * rule carry none). A reason that opens with 範囲外 makes the row name nothing, as it does for a bullet.
 */
function tableRowPlaces(line: string): string[] {
  const m = /^\s*\|([^|]*)\|(.*)$/.exec(line);
  if (!m) return [];
  if (m[2]!.split("|").some(marksOutOfScope)) return [];
  return backquotedNames(m[1]!).filter((n) => !/\s/.test(n));
}

/** the places of a bullet: its module and the names that follow the dash, each resolved to a repo-relative path */
function bulletPlaces(line: string): string[] {
  const dash = line.indexOf("—");
  const head = dash < 0 ? line : line.slice(0, dash);
  const tail = dash < 0 ? "" : line.slice(dash + 1);
  if (marksOutOfScope(tail)) return [];
  // the names are the run of backticked names that opens the tail (`a.ts`・`b.ts`, `a.ts` と `b.ts`); a path in the
  // sentence after it gives the reason and is not a file the change may touch
  const run = /^(?:\s*`[^`]+`\s*(?:[・、,]|と)?)+/.exec(tail)?.[0] ?? "";
  const named = backquotedNames(run).filter((n) => !/\s/.test(n));
  const parents = backquotedNames(head);
  const fullPaths = named.filter((n) => n.includes("/"));
  const out: string[] = [];
  for (const parent of parents) {
    if (parent.endsWith("/") && named.length) out.push(...named.flatMap((n) => underModule(parent, n)));
    // a module that is no directory has no names under it; a path the tail names in full is a file of its own
    else out.push(parent, ...fullPaths);
  }
  if (!parents.length) out.push(...fullPaths);
  return out;
}

/** a name after a directory module as repo-relative paths: under the module, and as written when it carries a directory of its own (`dist/x.js` may be written from the root) */
function underModule(parent: string, name: string): string[] {
  if (name.startsWith(parent)) return [name];
  return name.replace(/\/$/, "").includes("/") ? [`${parent}${name}`, name] : [`${parent}${name}`];
}

/**
 * The scope a GO records for its plan: the plan's touch list as written (a glob stays a glob; the fold matches it), and
 * the lane's own record directories (the planner's and the executor's context documents are changes the plan never
 * lists). Only the plan is read, so the same plan gives the same scope.
 */
export function scopeWithRecords(scope: string[], rec: { area: string; idd_id: string; title: string } & Parameters<typeof slugOf>[0]): string[] {
  const seg = areaSegment(rec.area);
  const slug = slugOf(rec);
  const records = ["plan", "qa", "reference", "intent", "context"].map((kind) => `_docs/${kind}/${seg}/${slug}/`);
  return [...new Set([...scope, ...records])];
}

/**
 * A lane's plan scope as its worktree holds the plan now, for the GO to write into the ledger: the rounds' "outside the
 * plan" column is read from that record and never from the plan document again, so a later edit of the plan does not
 * move a line already read. A lane with no plan document (planned before the request form), an unreadable one, or one
 * with no touch list has no scope, and no file is outside it.
 */
export function laneTraceScope(rec: BacklogRecord, worktree: string | undefined): string[] {
  if (!worktree) return [];
  const plan = lanePlanDoc(rec, worktree);
  if (!plan) return [];
  let text: string;
  try {
    text = readFileSync(join(worktree, plan.rel), "utf8");
  } catch {
    // an unreadable plan names no scope: the column is empty rather than every file being outside
    return [];
  }
  const touch = planTouchScope(text);
  return touch.length ? scopeWithRecords(touch, rec) : [];
}

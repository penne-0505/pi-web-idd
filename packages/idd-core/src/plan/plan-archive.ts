import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { git } from "../overlay/git.ts";
import { commitRecordChanges, dirtyPaths, isLaneRecordPath, laneRecordDirs, type RecordCommitOptions } from "./lane-records.ts";
import { lanePlanDoc } from "./plan-doc.ts";
import type { CommitGate } from "./commit-gate.ts";

/** the commit subject of the plan move: one commit, the move and the references it rewrites, so the branch is never taken for a records change */
const ARCHIVE_SUBJECT = "docs(plan): 作業指示を archive へ移す";
/** the subject of a repair commit on a lane whose plan was archived before this rewriting existed */
const REF_FIX_SUBJECT = "docs(plan): archive へ移した作業指示への参照を直す";

export type PlanArchiveResult =
  | { moved: true; from: string; to: string; commit: string; files: string[] }
  /** the plan was already archived and the references still pointed at the live path: they are fixed now */
  | { repaired: true; files: string[]; commit: string }
  /** nothing to move or fix: the lane has no plan, or its archived plan has no reference left pointing at the live path */
  | { moved: false; reason: string }
  /**
   * the move, or the repair of a lane already archived, did not go through and the worktree is as it was; the lane
   * waits for the next tick, so the caller records the reason. `later` says the cause was a wait (the repo's lock)
   * rather than the worktree, so the caller does not write the failure on the lane
   */
  | { error: string; later?: true };

/** one file whose links to a lane's plan are rewritten, with the text the move must be able to put back */
export interface RefRewrite {
  /** repo-relative path */
  path: string;
  before: string;
  after: string;
}

/**
 * Move a lane's work instruction from `_docs/plan/` to `_docs/archives/plan/` as its own commit, before the submit,
 * and rewrite the references the record check follows so they point at the archived path in the same commit. The
 * harness does this: a plan left beside the permanent records would be read as intent by someone changing the code
 * later, and a lane whose plan could not be moved must not be submitted (DEC-2646). A lane with no plan, one already
 * archived (its remaining references are repaired), and one whose worktree is dirty are left alone; a failed commit
 * is undone so the lane is not held by a half-written move. A worktree whose only uncommitted changes are the
 * lane's own records is committed first, so a lane whose executor left its records behind still archives.
 */
export function archiveLanePlan(rec: { area: string; idd_id: string; title: string } & Parameters<typeof lanePlanDoc>[0], worktree: string, opts: RecordCommitOptions = {}): PlanArchiveResult {
  const plan = lanePlanDoc(rec, worktree);
  if (!plan) return { moved: false, reason: "plan.md がありません" };
  if (plan.archived) {
    const from = plan.rel.replace(/^_docs\/archives\/plan\//, "_docs/plan/");
    const rewrites = planRefRewrites(worktree, from, plan.rel);
    if (!rewrites.length) return { moved: false, reason: "直す参照がありません" };
    const fixed = commitRefRewrites(worktree, rewrites);
    // a repair that could not go through is a failure, not the "nothing to do" case: the caller keeps the lane and writes why
    return fixed.fixed ? { repaired: true, files: fixed.files, commit: fixed.commit } : { error: `plan.md の参照を直せませんでした: ${fixed.reason}` };
  }
  const dirty = dirtyPaths(worktree);
  if (dirty.length) {
    const dirs = laneRecordDirs(rec, worktree);
    // a lane whose worktree holds anything but its own records is left as before: committing the records would put
    // a lane that is going to stop on the branch anyway, and the records outside would be someone else's to judge
    if (dirty.some((path) => !isLaneRecordPath(dirs, path))) {
      return { error: "lane の worktree に未 commit の変更があるので、plan.md を archive へ移せません" };
    }
    const committed = commitRecordChanges(worktree, dirs, opts);
    if (!committed.ok) return { error: committed.reason, ...(committed.later ? { later: true as const } : {}) };
  }
  const startHead = git(worktree, ["rev-parse", "HEAD"]).trim();
  const to = plan.rel.replace(/^_docs\/plan\//, "_docs/archives/plan/");
  if (to === plan.rel) return { error: `plan.md の archive 先を決められません: ${plan.rel}` };
  // found before the move: afterwards the live path is gone and a relative link cannot be resolved against it
  const rewrites = planRefRewrites(worktree, plan.rel, to);
  try {
    mkdirSync(dirname(join(worktree, to)), { recursive: true });
    git(worktree, ["mv", plan.rel, to]);
    for (const r of rewrites) writeFileSync(join(worktree, r.path), r.after);
    const paths = [...rewrites.map((r) => r.path), plan.rel, to];
    if (rewrites.length) git(worktree, ["add", "--", ...rewrites.map((r) => r.path)]);
    git(worktree, ["commit", "-q", "-m", ARCHIVE_SUBJECT, "-m", commitBody(rewrites.length), "--", ...paths]);
  } catch (err) {
    const detail = errText(err);
    try {
      // the index and the working tree are put back: a half-written move must not hold the lane. `reset --hard` is
      // forbidden inside a lane, so the move is undone by unstaging it, rewriting the files and renaming the file back
      if (git(worktree, ["rev-parse", "HEAD"]).trim() === startHead) undoMove(worktree, plan.rel, to, rewrites);
    } catch {
      // the failure below stands; git status in the worktree shows what is left
    }
    return { error: `plan.md を archive へ移せませんでした: ${detail}` };
  }
  return { moved: true, from: plan.rel, to, commit: git(worktree, ["rev-parse", "HEAD"]).trim(), files: rewrites.map((r) => r.path) };
}

/** the second body line of the move commit: says the rewrite only when there was one */
function commitBody(count: number): string {
  const base = "完了した lane の作業指示は、恒久の記録と混ざらないよう archive に置く。";
  return count ? `${base}記録の中の plan.md への参照も、移した後の path に書き換えた。` : base;
}

/**
 * Whether the lane's archived plan still has references the record check would follow to the live path, without
 * writing anything. The repair below and the tick's recovery both ask this first; an empty list is a lane to leave.
 */
export function pendingPlanRefRewrites(rec: { area: string; idd_id: string; title: string } & Parameters<typeof lanePlanDoc>[0], worktree: string): RefRewrite[] {
  const plan = lanePlanDoc(rec, worktree);
  if (!plan || !plan.archived) return [];
  const from = plan.rel.replace(/^_docs\/archives\/plan\//, "_docs/plan/");
  return planRefRewrites(worktree, from, plan.rel);
}

export interface PlanRefFixOptions {
  /**
   * Right before the commit: take what the commit must hold (the repo's overlay lock, the pushed check) and say
   * whether the branch may still be written. The recovery of a stopped lane passes this; the S3 repair does not.
   */
  beforeCommit?: () => CommitGate;
}

export type PlanRefFixResult =
  | { fixed: true; files: string[]; commit: string }
  /** nothing was committed; `later` says the cause was a wait (a lock) rather than the worktree */
  | { fixed: false; reason: string; later?: true };

/**
 * Fix the references of a lane whose plan is already archived, as its own commit. The worktree must be clean; the
 * commit touches only the rewritten files, and a failure puts them back. Answers without fixing when there is
 * nothing to rewrite, so a caller can ask before it spends a commit.
 */
export function fixArchivedPlanRefs(rec: { area: string; idd_id: string; title: string } & Parameters<typeof lanePlanDoc>[0], worktree: string, opts: PlanRefFixOptions = {}): PlanRefFixResult {
  const plan = lanePlanDoc(rec, worktree);
  if (!plan || !plan.archived) return { fixed: false, reason: "plan.md が archive にありません" };
  if (git(worktree, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
    return { fixed: false, reason: "lane の worktree に未 commit の変更があるので、参照を直せません" };
  }
  const from = plan.rel.replace(/^_docs\/archives\/plan\//, "_docs/plan/");
  const rewrites = planRefRewrites(worktree, from, plan.rel);
  if (!rewrites.length) return { fixed: false, reason: "直す参照がありません" };
  const out = commitRefRewrites(worktree, rewrites, opts);
  if (!out.fixed) return out;
  return { fixed: true, files: out.files, commit: out.commit };
}

/** write the rewritten files and commit them, putting them back when the commit does not go through */
function commitRefRewrites(worktree: string, rewrites: RefRewrite[], opts: PlanRefFixOptions = {}): { fixed: true; files: string[]; commit: string } | { fixed: false; reason: string; later?: true } {
  if (!rewrites.length) return { fixed: false, reason: "直す参照がありません" };
  if (git(worktree, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
    return { fixed: false, reason: "lane の worktree に未 commit の変更があるので、参照を直せません" };
  }
  const startHead = git(worktree, ["rev-parse", "HEAD"]).trim();
  let hold: { release: () => void } | undefined;
  let committed = false;
  try {
    if (opts.beforeCommit) {
      const gate = opts.beforeCommit();
      if ("refuse" in gate) return { fixed: false, reason: gate.refuse, ...(gate.later ? { later: true as const } : {}) };
      hold = gate;
    }
    // the check ran on the branch as it was; a branch that moved since (another writer) is not written on
    if (git(worktree, ["rev-parse", "HEAD"]).trim() !== startHead) {
      return { fixed: false, reason: "参照を直す間に lane の branch が動いたので commit していません（次の機会に直す）", later: true };
    }
    for (const r of rewrites) writeFileSync(join(worktree, r.path), r.after);
    const paths = rewrites.map((r) => r.path);
    git(worktree, ["add", "--", ...paths]);
    git(worktree, ["commit", "-q", "-m", REF_FIX_SUBJECT, "-m", "archive へ移した作業指示を、恒久の記録の中の参照が指している。参照を移した後の path に直す。", "--", ...paths]);
    committed = true;
    return { fixed: true, files: paths, commit: git(worktree, ["rev-parse", "HEAD"]).trim() };
  } catch (err) {
    const detail = errText(err);
    if (!committed) {
      try {
        if (git(worktree, ["rev-parse", "HEAD"]).trim() === startHead) undoRefRewrites(worktree, rewrites);
      } catch {
        // the failure below stands; git status in the worktree shows what is left
      }
    }
    return { fixed: false, reason: `参照を直せませんでした: ${detail}` };
  } finally {
    hold?.release();
  }
}

/** put a staged reference rewrite back: the index entry is reset and the file's text is written back */
function undoRefRewrites(worktree: string, rewrites: RefRewrite[]): void {
  const paths = rewrites.map((r) => r.path);
  try { git(worktree, ["reset", "-q", "HEAD", "--", ...paths]); } catch { /* the text below still goes back */ }
  for (const r of rewrites) {
    try { writeFileSync(join(worktree, r.path), r.before); } catch { /* git status in the worktree shows what is left */ }
  }
}

/** put a staged rename and its reference rewrites back: reset the index entries, restore the texts, rename the file back */
function undoMove(worktree: string, from: string, to: string, rewrites: RefRewrite[] = []): void {
  const paths = [...rewrites.map((r) => r.path), from, to];
  try { git(worktree, ["reset", "-q", "HEAD", "--", ...paths]); } catch { /* the rename below still puts the file back */ }
  for (const r of rewrites) {
    try { writeFileSync(join(worktree, r.path), r.before); } catch { /* git status in the worktree shows what is left */ }
  }
  if (!existsSync(join(worktree, to)) || existsSync(join(worktree, from))) return;
  mkdirSync(dirname(join(worktree, from)), { recursive: true });
  renameSync(join(worktree, to), join(worktree, from));
}

// ---------------------------------------------------------------- the reference rewriting

const ROOT_RELATIVE_PREFIXES = ["_docs/", "_meta/", ".agents/", ".claude/", ".github/", "scripts/"];
const ROOT_RELATIVE_FILES = ["README.md", "AGENTS.md", "TODO.md", "QUICKSTART.md", "LICENSE.txt"];

/** the validator's path shape: `a/./b`, `a/../b` are folded away, as `scripts/validate-doc-links.ts` does */
function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "." : path.slice(0, at);
}

const isRootRelative = (target: string): boolean =>
  ROOT_RELATIVE_PREFIXES.some((prefix) => target.startsWith(prefix)) ||
  ROOT_RELATIVE_FILES.includes(target);

/** the validator's resolution: a `_docs/`-style target from the root, anything else from the file's directory */
function resolveTarget(fromFile: string, target: string): string | null {
  if (target.startsWith("/")) return null;
  const base = isRootRelative(target) ? "." : dirOf(fromFile);
  return normalizePath(`${base}/${target}`);
}

/** the target of a markdown link or a reference line, rewritten to the archived root path when it names the lane's plan */
function rewriteTarget(raw: string, fileRel: string, fromRel: string, toRel: string): string | null {
  const target = raw.trim();
  if (!target) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  const hashAt = target.indexOf("#");
  const beforeAnchor = hashAt >= 0 ? target.slice(0, hashAt) : target;
  const anchor = hashAt >= 0 ? target.slice(hashAt) : "";
  const queryAt = beforeAnchor.indexOf("?");
  const clean = queryAt >= 0 ? beforeAnchor.slice(0, queryAt) : beforeAnchor;
  const query = queryAt >= 0 ? beforeAnchor.slice(queryAt) : "";
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* the raw form is compared as it is */ }
  if (!decoded) return null;
  const resolved = resolveTarget(fileRel, decoded);
  if (resolved !== fromRel) return null;
  return toRel + query + anchor;
}

/** a link's target with its `<...>` wrapper and title kept, or null when it does not name the lane's plan */
function rewriteLinkTarget(raw: string, fileRel: string, fromRel: string, toRel: string): string | null {
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  const trail = raw.slice(raw.trimEnd().length);
  let body = raw.trim();
  let wrapped = false;
  let title = "";
  if (body.startsWith("<")) {
    const close = body.indexOf(">");
    if (close >= 0) { wrapped = true; title = body.slice(close + 1); body = body.slice(1, close); }
  } else {
    const at = body.search(/\s/);
    if (at >= 0) { title = body.slice(at); body = body.slice(0, at); }
  }
  const next = rewriteTarget(body, fileRel, fromRel, toRel);
  if (next === null) return null;
  return lead + (wrapped ? `<${next}>${title}` : `${next}${title}`) + trail;
}

/** a `references` item's scalar, with its quote style kept, or null when it does not name the lane's plan */
function rewriteScalar(raw: string, fileRel: string, fromRel: string, toRel: string): string | null {
  const body = raw.trim();
  const quoted = body.match(/^(["'])([\s\S]*)\1$/);
  const quote = quoted ? quoted[1] : "";
  const value = quoted ? quoted[2] : body;
  const next = rewriteTarget(value, fileRel, fromRel, toRel);
  if (next === null) return null;
  return `${quote}${next}${quote}`;
}

/** the items of a one-line YAML flow array, split at the commas outside quotes */
function splitInlineArray(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if ((ch === '"' || ch === "'") && inner[i - 1] !== "\\") quote = quote === ch ? null : quote ?? ch;
    if (ch === "," && quote === null) { items.push(current.trim()); current = ""; }
    else current += ch;
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
}

/** the front matter's span: the text between the two `---` lines, or null for a file without one */
function frontMatterSpan(src: string): { fm: string; end: number } | null {
  if (!src.startsWith("---")) return null;
  const firstNl = src.indexOf("\n");
  if (firstNl < 0 || src.slice(0, firstNl).trim() !== "---") return null;
  const rest = src.slice(firstNl + 1);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return null;
  return { fm: rest.slice(0, close.index), end: firstNl + 1 + close.index + close[0].length };
}

/** rewrite only the `references` lines of the front matter; the rest of the block is left as written */
function rewriteFrontMatter(fm: string, fileRel: string, fromRel: string, toRel: string): string | null {
  const lines = fm.split("\n");
  let changed = false;
  let inRefs = false;
  for (let i = 0; i < lines.length; i += 1) {
    const key = lines[i].match(/^(\s*)references:\s*(.*)$/);
    if (key) {
      const value = key[2].replace(/\s+$/, "");
      if (value.startsWith("[") && value.endsWith("]")) {
        const items = splitInlineArray(value.slice(1, -1));
        const nextItems = items.map((it) => rewriteScalar(it, fileRel, fromRel, toRel) ?? it);
        if (nextItems.some((it, j) => it !== items[j])) {
          changed = true;
          lines[i] = `${key[1]}references: [${nextItems.join(", ")}]`;
        }
        inRefs = false;
      } else {
        inRefs = true;
      }
      continue;
    }
    if (inRefs) {
      const item = lines[i].match(/^(\s*)-\s+(.*)$/);
      if (item) {
        const next = rewriteScalar(item[2], fileRel, fromRel, toRel);
        if (next !== null) { changed = true; lines[i] = `${item[1]}- ${next.trim()}`; }
        continue;
      }
      inRefs = false;
    }
  }
  return changed ? lines.join("\n") : null;
}

/** rewrite the inline links and the reference definitions of the body; fenced code blocks are skipped */
function rewriteBody(body: string, fileRel: string, fromRel: string, toRel: string): string | null {
  let changed = false;
  let inFence = false;
  const out = body.split("\n").map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    let next = line.replace(/(!?\[[^\]]*]\()([^)]+)(\))/g, (whole, pre: string, target: string, post: string) => {
      const rewritten = rewriteLinkTarget(target, fileRel, fromRel, toRel);
      if (rewritten === null) return whole;
      changed = true;
      return pre + rewritten + post;
    });
    const def = next.match(/^(\s{0,3}\[[^\]]+]:\s*)(\S+(?:\s+\S+)*)(\s*)$/);
    if (def) {
      const rewritten = rewriteLinkTarget(def[2], fileRel, fromRel, toRel);
      if (rewritten !== null) { changed = true; next = def[1] + rewritten + def[3]; }
    }
    return next;
  }).join("\n");
  return changed ? out : null;
}

/** the file's text with every reference to the lane's plan rewritten, or null when none was */
function rewriteText(src: string, fileRel: string, fromRel: string, toRel: string): string | null {
  const span = frontMatterSpan(src);
  if (!span) return rewriteBody(src, fileRel, fromRel, toRel);
  const head = src.slice(0, src.indexOf("\n") + 1);
  const nextFm = rewriteFrontMatter(span.fm, fileRel, fromRel, toRel);
  const nextBody = rewriteBody(src.slice(span.end), fileRel, fromRel, toRel);
  if (nextFm === null && nextBody === null) return null;
  return head + (nextFm ?? span.fm) + "---" + (nextBody ?? src.slice(span.end));
}

/** the rewrites the lane's live plan still needs among the markdown files that name its path */
function planRefRewrites(worktree: string, fromRel: string, toRel: string): RefRewrite[] {
  const needle = fromRel.replace(/^_docs\//, "");
  let listed = "";
  try {
    // no pathspec: `git` runs with GIT_LITERAL_PATHSPECS, so a `-- '*.md'` would match nothing
    listed = git(worktree, ["grep", "-l", "-F", needle]);
  } catch {
    // no match is exit 1, and `git` throws it: there is nothing to rewrite
    return [];
  }
  const paths = listed.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((p) => p.endsWith(".md"))
    .filter((p) => !p.startsWith("_meta/scratch/"))
    .filter((p) => p !== fromRel && p !== toRel);
  const out: RefRewrite[] = [];
  for (const path of paths) {
    let before: string;
    try { before = readFileSync(join(worktree, path), "utf8"); } catch { continue; }
    const after = rewriteText(before, path, fromRel, toRel);
    if (after !== null && after !== before) out.push({ path, before, after });
  }
  return out;
}

function errText(e: unknown): string {
  const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err.message ?? e);
}

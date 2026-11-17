import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { reviewPolicy, type ReviewPolicy } from "../config/pipeline.ts";
import { readAreas } from "../config/areas.ts";
import { RISK_KEYS, riskPathsMatching, type RiskKey, type RiskPaths } from "../config/risk-paths.ts";
import { reviewBaseOf } from "../ledger/base.ts";
import { readLifecycle } from "../ledger/read.ts";
import { readyRiskTableOf, riskTableTouches } from "../agent/risk-table.ts";
import { attempt, commitTree, git, names, tree } from "../overlay/git.ts";
import { isOverlayPath, readManifest } from "../overlay/manifest.ts";
import { laneLocations } from "../overlay/export.ts";
import { isAncestor, laneBaseWorkRef, laneHasMainline } from "../overlay/base.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { conflictSendBacks } from "../ledger/review-loop.ts";
import { followupTaskId } from "./followups.ts";
import { planReviewInputs } from "./plan-review.ts";

/**
 * What the review loop counts as a change to how the code behaves: any file that is not a record and not a test.
 * Records are the overlay's paths (what never leaves the work side), `_docs/`, the TODO and every Markdown file;
 * tests are `*.test.*` files and anything under a `test/` or `tests/` directory. A fix that touched only those
 * gets no final review of its own.
 */
export function isBehaviourPath(path: string, overlayPaths: string[] = []): boolean {
  const p = path.replace(/^\.\//, "");
  if (!p) return false;
  if (/\.md$/i.test(p) || /^_docs\//.test(p) || /(^|\/)TODO\.md$/.test(p)) return false;
  if (/(^|\/)[^/]*\.test\.[^/]+$/.test(p) || /(^|\/)tests?\//.test(p)) return false;
  return !isOverlayPath(overlayPaths, p);
}

/**
 * What counts as a record for the review scope: `_docs/`, a TODO and every Markdown file, and the overlay's paths.
 * A test is not a record, so a commit that changed one is not a records-only commit. Defined on its own rather than
 * as the negation of `isBehaviourPath`, which counts tests as not-behaviour.
 */
export function isRecordPath(path: string, overlayPaths: string[] = []): boolean {
  const p = path.replace(/^\.\//, "");
  if (!p) return false;
  if (/\.md$/i.test(p) || /^_docs\//.test(p) || /(^|\/)TODO\.md$/.test(p)) return true;
  return isOverlayPath(overlayPaths, p);
}

/** the overlay's paths as the worktree has them now; none when it has no readable manifest */
export function overlayPathsOf(worktree: string): string[] {
  try {
    const m = readManifest(worktree);
    return m.issues.length && !m.paths.length ? [] : m.paths;
  } catch {
    return [];
  }
}

/** the behaviour files changed between two commits, or null when git cannot say */
export function behaviourChanges(worktree: string, from: string, to: string): string[] | null {
  if (from === to) return [];
  let changed: string[];
  try {
    changed = names(worktree, from, to);
  } catch {
    return null;
  }
  const overlay = overlayPathsOf(worktree);
  return changed.filter((p) => isBehaviourPath(p, overlay));
}

/** the last review round of the loop that recorded the head it read (a blind or a final, never the device check) */
export function lastReviewRound(events: LifecycleRecord[]): { index: number; head: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event !== "s2_review_started" || (e.attrs?.kind ?? "blind") === "device") continue;
    const head = e.attrs?.head;
    return typeof head === "string" && head ? { index: i, head } : undefined;
  }
  return undefined;
}

/**
 * The mainline merge a conflict send-back asked for, when the lane's commits since the last review round are that
 * merge: the newest merge on the lane's first-parent line since `from`, the mainline commit it took in (its second
 * parent), and whether every other commit since `from` changed records only (only then do its resolved hunks show
 * everything the round has not seen). Undefined when nothing was sent back for a conflict since that round, or no
 * such merge is there.
 */
export function conflictMerge(worktree: string, events: LifecycleRecord[], since: { index: number; head: string }, head: string): { merge: string; mainline: string; only: boolean; recordOnly: boolean; origin: string } | undefined {
  const last = conflictSendBacks(events).filter((s) => s.index > since.index).at(-1);
  if (!last) return undefined;
  // the send-back's own head is where the next round counts from; a record without one falls back to the last round
  const origin = last.head ?? since.head;
  const m = mergeSince(worktree, origin, head);
  return m ? { ...m, origin } : undefined;
}

/**
 * The mainline merge the lane's next conflict round reads, when the commits since the send-back are that merge and
 * records-only commits. Undefined when the next round is not a conflict scope one.
 */
export function pendingConflict(worktree: string, events: LifecycleRecord[], head: string): { merge: string; mainline: string; origin: string } | undefined {
  const since = lastReviewRound(events);
  if (!since) return undefined;
  const m = conflictMerge(worktree, events, since, head);
  return m && m.recordOnly ? { merge: m.merge, mainline: m.mainline, origin: m.origin } : undefined;
}

/**
 * Whether the lane's next round could be a conflict scope one: a send-back after the last review round. Cheap (no
 * git), so a caller that would have to read the worktree's head to know can ask this first.
 */
export function conflictRoundPending(events: LifecycleRecord[]): boolean {
  const since = lastReviewRound(events);
  return conflictSendBacks(events).some((s) => s.index > (since?.index ?? -1));
}

/** the paths a single commit changed, or null when git cannot say (a merge, a missing commit) */
function commitChanged(worktree: string, rev: string): string[] | null {
  const out = attempt(worktree, ["diff-tree", "--no-commit-id", "--name-only", "-r", rev]);
  return out === null ? null : out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** whether a commit changed records only: false when git cannot say, and for a commit that touched anything else */
function recordCommit(worktree: string, overlay: string[], rev: string): boolean {
  const changed = commitChanged(worktree, rev);
  return changed !== null && changed.every((p) => isRecordPath(p, overlay));
}

/**
 * The newest merge on the lane's first-parent line between two of its commits, the commit it took in (its second
 * parent), whether it is the only commit there, and whether it is the only merge and every other commit there
 * changed records only. Undefined when there is none, or `from` is not behind `to`.
 *
 * Two merges since `from` make `recordOnly` false: the older one's resolved hunks are not in the newest merge, so
 * showing only the newest would leave what was resolved by hand unread. The round falls back to the whole diff,
 * whose base still takes the newest mainline in.
 */
export function mergeSince(worktree: string, from: string, to: string): { merge: string; mainline: string; only: boolean; recordOnly: boolean } | undefined {
  if (from === to) return undefined;
  if (attempt(worktree, ["merge-base", "--is-ancestor", from, to]) === null) return undefined;
  const lines = (attempt(worktree, ["rev-list", "--first-parent", "--parents", `${from}..${to}`]) ?? "").split("\n").map((l) => l.trim().split(/\s+/)).filter((l) => l[0]);
  const at = lines.findIndex((l) => l.length >= 3);
  if (at < 0) return undefined;
  const overlay = overlayPathsOf(worktree);
  const merges = lines.filter((l) => l.length >= 3).length;
  const recordOnly = merges === 1 && lines.every((l) => l.length >= 3 || recordCommit(worktree, overlay, l[0]));
  return { merge: lines[at][0], mainline: lines[at][2], only: lines.length === 1, recordOnly };
}

/**
 * The follow-ups a lane has already recorded on its own records (`s3_followups_written`),
 * each path-and-claim once. A conflict scope round hands them to its judgement so they are not reported again.
 */
export function writtenFollowups(events: LifecycleRecord[]): { severity: string; claim: string; path?: string }[] {
  const out: { severity: string; claim: string; path?: string }[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.event !== "s3_followups_written") continue;
    const entries = Array.isArray(e.attrs?.entries) ? (e.attrs.entries as Record<string, unknown>[]) : [];
    for (const x of entries) {
      if (typeof x.claim !== "string" || !x.claim) continue;
      const path = typeof x.path === "string" && x.path ? x.path : undefined;
      const key = `${path ?? ""}|${x.claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ severity: typeof x.severity === "string" && x.severity ? x.severity : "should", claim: x.claim, ...(path ? { path } : {}) });
    }
  }
  return out;
}

/** the files a merge's resolution changed (where the result differs from both parents), or null when git cannot say */
export function mergeResolutionChanges(worktree: string, merge: string): string[] | null {
  const out = attempt(worktree, ["diff-tree", "-r", "--cc", "--name-only", merge]);
  return out === null ? null : out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * The conflict scope round the lane's S3 sits on: the send-back it followed and the newest mainline merge. Undefined
 * unless `review_loop.after_merge` is `conflict`, the last review round recorded itself as a conflict scope one
 * (`diff_scope: conflict`) after that send-back, and the lane's commits since the send-back are that one merge and
 * records-only commits.
 *
 * The policy is read here, not left to the caller: under `after_merge: whole` no round is a conflict scope one, so
 * an S3 whose git shape happens to match still reads the whole diff. A whole-diff round after a
 * send-back records no `diff_scope`, and reaches the same conclusion.
 */
function conflictScopeMerge(worktree: string, events: LifecycleRecord[], head: string, policy: ReviewPolicy): { merge: string; origin: string } | undefined {
  if (policy.afterMerge !== "conflict") return undefined;
  const since = lastReviewRound(events);
  if (!since || events[since.index]?.attrs?.diff_scope !== "conflict") return undefined;
  const last = conflictSendBacks(events).filter((s) => s.index < since.index).at(-1);
  if (!last?.head) return undefined;
  const m = mergeSince(worktree, last.head, head);
  return m && m.recordOnly ? { merge: m.merge, origin: last.head } : undefined;
}

/**
 * Whether the lane's S3 sits on a conflict scope round: a conflict scope one closed it, and the lane's commits since
 * its send-back are the mainline merge and records-only commits. False under `after_merge: whole` and for a lane a
 * whole-diff round closed.
 */
export function isConflictScopeRound(worktree: string, events: LifecycleRecord[], head: string, policy: ReviewPolicy = reviewPolicy()): boolean {
  return !!conflictScopeMerge(worktree, events, head, policy);
}

/**
 * The review base with a mainline merge taken in: a commit whose tree is the prior base merged with the mainline
 * commit and whose parents are both, built as the base receive builds its review base, and kept from gc by the same
 * ref. The mainline commit itself when the two do not merge cleanly (its tree is what the lane merged onto).
 */
export function mergedReviewBase(worktree: string, iddId: string, prior: string, mainline: string): string {
  const combined = attempt(worktree, ["merge-tree", "--write-tree", "--no-messages", prior, mainline]);
  const base = combined ? commitTree(worktree, combined.split("\n")[0].trim(), [prior, mainline], "review base") : mainline;
  git(worktree, ["update-ref", `refs/idd/review-base/${iddId}`, base]);
  return base;
}

/**
 * The tree of the same merge `mergedReviewBase` builds, without writing a commit object or a ref: what a caller that
 * only has to compare (the slot wait's count, read again each time for display) can use in place of the base.
 * Undefined when the two do not merge cleanly; the caller reads `mainline` as the base, as `mergedReviewBase` does.
 */
export function mergedReviewTree(worktree: string, prior: string, mainline: string): string | undefined {
  const combined = attempt(worktree, ["merge-tree", "--write-tree", "--no-messages", prior, mainline]);
  const id = combined?.split("\n")[0]?.trim();
  return id && /^[0-9a-f]{40,64}$/.test(id) ? id : undefined;
}

/**
 * What the review origin lacks of the mainline the lane's head has taken in: the fork point of the head and the lane's
 * mainline (the parent lane's branch for a stacked lane, else the work base), never the mainline's tip: a tip the lane
 * has not taken in would show as a change the lane removed. A head that is itself the fork point (the executor took the
 * mainline in by a fast-forward) is read like any other. Read in the lane's worktree, then in the clone it was cut from.
 * "carried" says the origin needs nothing (it already carries the fork point, or the lane has no mainline to follow);
 * "unknown" says the answer could not be had (git did not answer, or the mainline's ref of a lane that has one cannot
 * be read, as with a parent whose branch is gone), which is not the same as nothing to take in.
 */
export type TakenMainline = { kind: "carried" } | { kind: "untaken"; mainline: string } | { kind: "unknown" };

export function takenMainline(worktree: string, iddId: string, prior: string, head: string): TakenMainline {
  let ref: string | null = null;
  let clone = "";
  try {
    ref = laneBaseWorkRef(iddId);
    // no ref is "nothing to follow" only for a lane whose area has no work branch; a parent whose branch or published
    // work cannot be read leaves a mainline that exists and is not known
    if (!ref) return laneHasMainline(iddId) ? { kind: "unknown" } : { kind: "carried" };
    clone = laneLocations(iddId)?.config.local_path ?? "";
  } catch {
    return { kind: "unknown" };
  }
  if (!prior) return { kind: "unknown" };
  for (const cwd of [worktree, clone]) {
    if (!cwd) continue;
    const mainline = attempt(cwd, ["merge-base", head, ref])?.trim();
    if (!mainline || !/^[0-9a-f]{40,64}$/.test(mainline)) continue;
    return isAncestor(cwd, mainline, prior) ? { kind: "carried" } : { kind: "untaken", mainline };
  }
  return { kind: "unknown" };
}

/** whether the lane's work base reaches a commit: read in the lane's worktree, then in the clone it was cut from */
function workBaseReaches(worktree: string, iddId: string, commit: string): boolean {
  let loc: ReturnType<typeof laneLocations> = null;
  try { loc = laneLocations(iddId); } catch { return false; }
  const workBase = loc?.config.work_base;
  if (!loc || !workBase) return false;
  const ref = `refs/heads/${workBase}`;
  for (const cwd of [worktree, loc.config.local_path]) {
    if (!cwd) continue;
    const tip = attempt(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])?.trim();
    if (tip && attempt(cwd, ["merge-base", "--is-ancestor", commit, tip]) !== null) return true;
  }
  return false;
}

/** what a head that is only the mainline merged in says: the merge and the mainline commit it took in */
export interface MergeOnlyHead { merge: string; mainline: string }

/** why a head since the last review is not only the mainline merged in, in words a caller may record */
export interface MergeOnlyRefusal { refusal: string }

/**
 * Whether the lane's head since `from` is only the mainline merged in, so that a round over it would read nothing
 * unreviewed: one merge and records-only commits since `from`, the merge's second parent a commit the lane's work
 * base reaches, and the merge's tree what git makes of its own two parents (no line was added or picked by hand).
 *
 * Resolved lines are left to a round: `--cc` would read a resolution that took one side as no resolution at all, so
 * the whole tree is compared instead. The second parent has to be the lane's work base and not another branch, whose
 * own commits no review read anywhere. Every answer git cannot give is a refusal: the caller runs the round then,
 * because a wrong skip is the one error that lets unreviewed code through.
 */
export function mergeOnlyHead(worktree: string, iddId: string, from: string, head: string): MergeOnlyHead | MergeOnlyRefusal {
  if (!from || from === head) return { refusal: "前回レビューした head から今の head までに commit が無い" };
  const m = mergeSince(worktree, from, head);
  if (!m) return { refusal: "前回レビューした head から今の head までに merge が無い" };
  if (!m.recordOnly) return { refusal: "merge のほかに、記録の置き場にない commit がある" };
  const parents = (attempt(worktree, ["rev-list", "--parents", "-n", "1", m.merge]) ?? "").trim().split(/\s+/).slice(1);
  if (parents.length !== 2 || parents[1] !== m.mainline) return { refusal: "merge の親を 2 つ読めない" };
  if (!workBaseReaches(worktree, iddId, m.mainline)) return { refusal: "merge の第 2 親が work_base から届く commit といえない" };
  const auto = mergedReviewTree(worktree, parents[0], m.mainline);
  if (!auto) return { refusal: "git に解かせた merge の tree が答えない" };
  let merged: string;
  try { merged = tree(worktree, m.merge); } catch { return { refusal: "merge の tree を読めない" }; }
  if (merged !== auto) return { refusal: "merge の結果が git に解かせた merge と違い、手で解いた行がある" };
  return { merge: m.merge, mainline: m.mainline };
}

/**
 * The last review round that recorded a hit of the repo's declaration, with the declared value of that round, as the
 * ship card and the lane detail read it. Undefined for a lane that never hit one (an old record's missing field too).
 */
export function recordedRiskMatch(events: LifecycleRecord[]): { risk: string; match: RiskMatch } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event !== "s2_review_started") continue;
    const raw = e.attrs?.risk_match;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const hits = (raw as { hits?: unknown }).hits;
    if (!Array.isArray(hits)) continue;
    const parsed: RiskPathHit[] = [];
    for (const h of hits) {
      if (!h || typeof h !== "object" || Array.isArray(h)) continue;
      const kind = (h as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !(RISK_KEYS as readonly string[]).includes(kind)) continue;
      const paths = Array.isArray((h as { paths?: unknown }).paths) ? ((h as { paths: unknown[] }).paths).map(String) : [];
      const total = Number((h as { total?: unknown }).total);
      parsed.push({ kind: kind as RiskKey, paths, total: Number.isFinite(total) && total > paths.length ? total : paths.length });
    }
    if (!parsed.length) continue;
    return { risk: typeof e.attrs?.risk === "string" && e.attrs.risk ? e.attrs.risk : "unknown", match: { hits: parsed } };
  }
  return undefined;
}

const HIGH = /^(high|critical)$/i;

/** how many matching paths one kind keeps in the record; the count of all of them is kept beside them */
export const RISK_MATCH_PATH_LIMIT = 5;

/** one kind of harm the lane's own change touched, with the paths that fell under the repo's declaration */
export interface RiskPathHit {
  kind: RiskKey;
  /** the matching paths, at most RISK_MATCH_PATH_LIMIT of them */
  paths: string[];
  /** how many paths matched in all (a moved-from and a moved-to path count as two) */
  total: number;
}

/** the kinds of harm the lane's own diff fell under, as the repo declared them */
export interface RiskMatch {
  hits: RiskPathHit[];
}

export interface LaneRiskRead {
  high: boolean;
  risk: string;
  from: "qa" | "todo" | "unknown";
  /** set only when the lane's own diff touched a declared path */
  match?: RiskMatch;
}

/**
 * The paths of the lane's own change, between `from` and the worktree's head, that fall under the repo's
 * declaration, by kind; null when git cannot compare the two. Every changed path is tried (`names` detects no
 * move, so a moved-from and a moved-to path, and a removed path, are all here). Empty when nothing matched.
 */
function matchRiskPaths(worktree: string, from: string, to: string, declared: RiskPaths): RiskPathHit[] | null {
  let changed: string[];
  try {
    changed = names(worktree, from, to);
  } catch {
    return null;
  }
  const kept = new Map<RiskKey, string[]>();
  const total = new Map<RiskKey, number>();
  for (const p of changed) {
    for (const kind of riskPathsMatching(declared, p)) {
      total.set(kind, (total.get(kind) ?? 0) + 1);
      const paths = kept.get(kind) ?? [];
      if (paths.length < RISK_MATCH_PATH_LIMIT) paths.push(p);
      kept.set(kind, paths);
    }
  }
  return RISK_KEYS.filter((kind) => total.has(kind)).map((kind) => ({ kind, paths: kept.get(kind) ?? [], total: total.get(kind) ?? 0 }));
}

/**
 * The repo's declaration for the lane's area, or `broken` when the repos file cannot be read at all. A repo whose
 * area the file does not mention has no declaration, which is not an error: the reading is unchanged there.
 */
function declaredRiskPaths(area: string): { declared?: RiskPaths; broken: boolean } {
  try {
    return { declared: readAreas().riskPaths?.[area], broken: false };
  } catch {
    return { broken: true };
  }
}

/**
 * The lane's Risk, and whether it counts as high (High or Critical): the `risk:` of the lane's qa frontmatter in its
 * worktree, else the `- **Risk**:` of the TODO task its intake names, else unknown, which counts as high. The last
 * ready's six-kind table only ever raises it: a row that says the lane touches a kind of harm makes the lane high
 * whatever the qa says, and a table of not-touching rows never lowers a declared High (DEC-2568).
 *
 * The repo's declaration of dangerous paths raises it too: when any path of the lane's own change, from the lane's
 * review origin (`base`, else `reviewBaseOf`) to its head, falls under a declared kind, the lane is high whatever
 * the qa and the table say, and the kinds and paths are returned. A repo with no declaration for the lane's area is
 * read exactly as before, without taking a diff. When the answer cannot be given (a broken repos file, no origin,
 * no head, git unable to compare) the lane is high, never low: this reading exists to raise a missed one.
 */
export function laneRisk(rec: Parameters<typeof planReviewInputs>[0] & { context?: string }, worktree: string, base?: string): LaneRiskRead {
  let declared: { high: boolean; risk: string; from: "qa" | "todo" | "unknown" } | undefined;
  try {
    const qa = join(worktree, planReviewInputs(rec)[1]);
    if (existsSync(qa)) {
      const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(qa, "utf8"))?.[1] ?? "";
      const risk = /^risk:\s*["']?([A-Za-z]+)/m.exec(front)?.[1];
      if (risk) declared = { high: HIGH.test(risk), risk, from: "qa" };
    }
  } catch {
    // an unreadable qa is read as if it were not there
  }
  if (!declared) {
    const id = followupTaskId({ title: rec.title, context: rec.context ?? "" });
    if (id) {
      for (const p of ["TODO.md", "starter/TODO.md"]) {
        try {
          const file = join(worktree, p);
          if (!existsSync(file)) continue;
          const todo = readFileSync(file, "utf8");
          const head = new RegExp(`^###\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:\\s]`, "m").exec(todo);
          if (!head) continue;
          const rest = todo.slice(head.index + head[0].length);
          const next = /^#{2,3}\s/m.exec(rest);
          const block = next ? rest.slice(0, next.index) : rest;
          const risk = /^\s*-\s+\*\*Risk\*\*:\s*([A-Za-z]+)/m.exec(block)?.[1];
          if (risk) { declared = { high: HIGH.test(risk), risk, from: "todo" }; break; }
        } catch {
          // go on to the next place
        }
      }
    }
  }
  // the table is read from the lane's lifecycle events; a table nobody answered in full reads as no table
  const events = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
  const plain: LaneRiskRead = riskTableTouches(readyRiskTableOf(events))
    ? (declared ? { ...declared, high: true } : { high: true, risk: "table", from: "unknown" })
    : declared ?? { high: true, risk: "unknown", from: "unknown" };
  const { declared: paths, broken } = declaredRiskPaths(rec.area);
  if (broken) return { ...plain, high: true };
  // no declaration for this repo: the reading is what it was before the matching existed
  if (!paths) return plain;
  const origin = base ?? reviewBaseOf(events);
  const head = attempt(worktree, ["rev-parse", "HEAD"])?.trim();
  if (!origin || !head) return { ...plain, high: true };
  const hits = matchRiskPaths(worktree, origin, head, paths);
  if (hits === null) return { ...plain, high: true };
  return hits.length ? { ...plain, high: true, match: { hits } } : plain;
}

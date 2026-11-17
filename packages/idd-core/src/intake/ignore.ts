import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";
import { readBacklog, readLifecycle, readPendingReviews } from "../ledger/read.ts";
import { transition } from "../ledger/write.ts";
import { granularityApprovable, granularityProposalOf, granularityWaiting } from "../plan/granularity.ts";
import { stopLaneWork, type StopWorkResult } from "../agent/stop.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { canonicalLinearUrl } from "./linear.ts";

/**
 * The Issues intake leaves out: one line per change in `intake-ignores.jsonl` in the state, the last line for an
 * Issue deciding. Only intake reads it. Nothing that drives a lane (its stage, the slots, the delivery, the watch,
 * the GO) does, and nothing is written to GitHub or Linear.
 */
export const INTAKE_IGNORES_FILE = "intake-ignores.jsonl";

export function intakeIgnoresPath(): string {
  return join(stateDir(), INTAKE_IGNORES_FILE);
}

/** an Issue as intake sees it: its URL, and Linear's own id when it came from Linear */
export interface IssueKey {
  url: string;
  linearId?: string;
}

/** two names of one Issue: the same Linear id, the same URL, or the same Linear URL once its title is dropped */
export function sameKey(a: IssueKey, b: IssueKey): boolean {
  if (a.linearId && b.linearId && a.linearId === b.linearId) return true;
  return a.url === b.url || canonicalLinearUrl(a.url) === canonicalLinearUrl(b.url);
}

const GH_ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)$/;

/** the ref intake uses for an Issue: #12 for GitHub, APP-1234 for Linear */
export function refOfIssueUrl(url: string): string {
  const gh = GH_ISSUE_URL.exec(url);
  if (gh) return `#${gh[1]}`;
  const m = /\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(canonicalLinearUrl(url));
  return m ? m[1].toUpperCase() : url;
}

/** the Issue a lane was taken in from, or null for a lane without one */
export function issueKeyOf(rec: BacklogRecord): IssueKey | null {
  const url = rec.gh_issue_url ?? rec.linear_issue_url;
  if (!url) return null;
  return { url, ...(rec.linear_issue_id ? { linearId: rec.linear_issue_id } : {}) };
}

export interface IgnoreRecord {
  action: "ignore" | "unignore";
  source: "github" | "linear";
  url: string;
  linear_id?: string;
  /** #12, APP-1234: how intake names it */
  ref: string;
  title: string;
  area?: string;
  /** the lane whose stop put it on the list */
  lane?: string;
  at: string;
  /** user, or `ignore` for the one operation that closes a lane and puts its Issue on (s1_defer / lane_abort are read from older records) */
  at_by: string;
}

/** an Issue to put on the list or take off, as intake would name it */
export interface IgnoreTarget extends IssueKey {
  source: "github" | "linear";
  ref: string;
  title: string;
  area?: string;
  lane?: string;
}

export type IgnoreResult = { ok: true; changed: boolean; target: IgnoreTarget; warning?: string } | { ok: false; error: string };

function parse(text: string): IgnoreRecord[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    try {
      const r = JSON.parse(l) as IgnoreRecord;
      return r && (r.action === "ignore" || r.action === "unignore") && typeof r.url === "string" ? [r] : [];
    } catch {
      return [];
    }
  });
}

export function readIgnores(): IgnoreRecord[] {
  const path = intakeIgnoresPath();
  return existsSync(path) ? parse(readFileSync(path, "utf8")) : [];
}

const keyOfRecord = (r: IgnoreRecord): IssueKey => ({ url: r.url, ...(r.linear_id ? { linearId: r.linear_id } : {}) });

/** the last line the list has for an Issue, or undefined */
function lastFor(issue: IssueKey, records: IgnoreRecord[]): IgnoreRecord | undefined {
  let last: IgnoreRecord | undefined;
  for (const r of records) if (sameKey(issue, keyOfRecord(r))) last = r;
  return last;
}

/** the line that puts the Issue on the list now, or undefined when intake takes it in: the last line for it decides */
export function ignoredLine(issue: IssueKey, records: IgnoreRecord[] = readIgnores()): IgnoreRecord | undefined {
  const last = lastFor(issue, records);
  return last?.action === "ignore" ? last : undefined;
}

/** whether intake leaves the Issue out: the last line for it decides (none: taken in) */
export function isIgnored(issue: IssueKey, records: IgnoreRecord[] = readIgnores()): boolean {
  return ignoredLine(issue, records) !== undefined;
}

export interface IgnoredIssue {
  ref: string;
  title: string;
  url: string;
  source: "github" | "linear";
  area?: string;
  at: string;
  /** user, or `ignore` for a lane's stop (`s1_defer` / `lane_abort` in records written before it) */
  by: string;
  lane?: string;
}

/** every Issue on the list now, in the order it was put on */
export function listIgnored(records: IgnoreRecord[] = readIgnores()): IgnoredIssue[] {
  const out: { first: number; issue: IgnoredIssue }[] = [];
  const seen: IssueKey[] = [];
  records.forEach((r, i) => {
    const key = keyOfRecord(r);
    if (seen.some((k) => sameKey(k, key))) return;
    seen.push(key);
    const last = lastFor(key, records);
    if (last?.action !== "ignore") return;
    out.push({ first: i, issue: { ref: last.ref, title: last.title, url: last.url, source: last.source, ...(last.area ? { area: last.area } : {}), at: last.at, by: last.at_by, ...(last.lane ? { lane: last.lane } : {}) } });
  });
  return out.map((o) => o.issue);
}

function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/**
 * Put an Issue on the list or take it off: one line, written under the file's lock after the list is read again
 * there, so two changes at once are both judged against what the other wrote. Putting on an Issue already on the
 * list writes nothing; taking off one that is not on it is refused.
 */
export async function setIgnored(action: "ignore" | "unignore", target: IgnoreTarget, by = "user"): Promise<IgnoreResult> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = intakeIgnoresPath();
  // created for the lock only, appending nothing: a line another writer put in meanwhile is kept
  if (!existsSync(path)) writeFileSync(path, "", { flag: "a" });
  const release = await lockfile.lock(path, { retries: { retries: 8, minTimeout: 40 } });
  try {
    const on = isIgnored(target, parse(readFileSync(path, "utf8")));
    if (action === "ignore" && on) return { ok: true, changed: false, target };
    if (action === "unignore" && !on) return { ok: false, error: `${target.ref} は無視リストにありません` };
    const line: IgnoreRecord = {
      action,
      source: target.source,
      url: target.url,
      ...(target.linearId ? { linear_id: target.linearId } : {}),
      ref: target.ref,
      title: target.title,
      ...(target.area ? { area: target.area } : {}),
      ...(target.lane ? { lane: target.lane } : {}),
      at: nowIso(),
      at_by: by,
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
    return { ok: true, changed: true, target };
  } finally {
    await release();
  }
}

/** the Issue of a lane as a target of the list */
export function ignoreTargetOfLane(rec: BacklogRecord): IgnoreTarget | null {
  const key = issueKeyOf(rec);
  if (!key) return null;
  return { ...key, source: rec.linear_issue_url && !rec.gh_issue_url ? "linear" : "github", ref: refOfIssueUrl(key.url), title: rec.title, area: rec.area, lane: rec.idd_id };
}

/** a closed lane's Issue goes on the list, by the operation that closed it; null for a lane without an Issue */
export async function ignoreLaneIssue(iddId: string, by = "ignore"): Promise<IgnoreResult | null> {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  const target = rec ? ignoreTargetOfLane(rec) : null;
  return target ? setIgnored("ignore", target, by) : null;
}

/** what `ignore` did to one lane: the close, the list line, and the sessions and runs stopped right here */
export interface IgnoreLaneResult {
  ok: boolean;
  /** the lifecycle paths written (the lane's close) */
  wrote: string[];
  /** the list write, when the lane has an Issue */
  list?: IgnoreResult;
  /** the sessions and runs the runtime was told to stop right here */
  stopped?: StopWorkResult;
  /** the lane was closed, but a part that goes with it was not (shown as a notice on the card) */
  warning?: string;
  error?: string;
}

/**
 * Take a lane out with `ignore`: close it first, put its Issue on the list, then stop the sessions and runs it has
 * going right here. The close goes through the write gate and comes before the list, so a close that is refused
 * (an already closed lane, a busy gate) writes nothing to the list. The stop runs outside the gate: it waits on the
 * runtime and on the removal of a run's review copy, which must not hold the gate. A list that cannot be written
 * after the close leaves the close standing and is told as a warning.
 */
export async function ignoreLane(iddId: string, opts: { reason?: string } = {}): Promise<IgnoreLaneResult> {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  if (!rec) return { ok: false, wrote: [], error: `lane がありません: ${iddId}` };
  const closed = await transition(iddId, "lane_close", { outcome: "aborted", via: "ignore", reason: opts.reason ?? "" });
  if (!closed.ok) return { ok: false, wrote: [], error: closed.reason };
  const wrote = [closed.path];

  const target = ignoreTargetOfLane(rec);
  let list: IgnoreResult | undefined;
  let warning: string | undefined;
  if (target) {
    list = await setIgnored("ignore", target, "ignore").catch((err): IgnoreResult => ({ ok: false, error: String(err) }));
    if (!list.ok) warning = `lane は閉じましたが、起票を無視リストに載せられませんでした（idd ignore で載せてください）: ${list.error}`;
  }

  const stopped = await stopLaneWork(iddId, { via: "ignore" }).catch((): StopWorkResult => ({ sessions: [], runs: [], failed: [] }));
  return { ok: true, wrote, ...(list ? { list } : {}), stopped, ...(warning ? { warning } : {}) };
}

/**
 * Approve a lane's granularity proposal. The children are not opened here: that is a later Issue's work, so the
 * approval closes the parent lane and puts its Issue on the ignore list, and the proposal stays readable in the
 * lane's own record for a person to open the children again from (C-127-5, C-127-6). A proposal over the child
 * limit is never approved: the card shows it as a re-slicing of the intake instead. The answer is written before
 * the close, so the record tells an approved split from an approved merge.
 */
export async function approveGranularity(iddId: string): Promise<IgnoreLaneResult> {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  if (!rec) return { ok: false, wrote: [], error: `lane がありません: ${iddId}` };
  const events = readLifecycle().filter((e) => e.idd_id === iddId);
  const proposal = granularityProposalOf(events);
  if (!proposal || !granularityWaiting(events)) return { ok: false, wrote: [], error: "この lane は粒度の案への答え待ちではありません（画面を更新してください）" };
  if (!granularityApprovable(proposal)) return { ok: false, wrote: [], error: "子が 4 を超える案はそのまま承認できません。起票の切り方から見直してください" };
  const answered = await transition(iddId, "s1_granularity_answered", {
    decision: "approve",
    kind: proposal.kind,
    ...(proposal.children ? { children: proposal.children.length } : {}),
    ...(proposal.mergeTarget ? { merge_target: proposal.mergeTarget.ref } : {}),
  });
  if (!answered.ok) return { ok: false, wrote: [], error: answered.reason };
  const closed = await ignoreLane(iddId, { reason: `粒度の案（${proposal.kind}）を承認: ${proposal.reason}` });
  if (!closed.ok) return { ...closed, warning: "粒度の案の承認は記録しましたが、lane を閉じられませんでした" };
  return { ...closed, wrote: [answered.path, ...closed.wrote] };
}

/** a duplicate review line as either writer wrote it: the intake side (`incoming`) and the reader's own (`candidate`) */
interface PendingReviewLine {
  review_id?: string;
  incoming?: { url?: unknown; title?: unknown };
  candidate?: { gh_issue_url?: unknown; linear_issue_url?: unknown; title?: unknown };
}

/** the URL of the Issue the duplicate card is about, from either shape of the line */
function pendingReviewUrl(line: PendingReviewLine): { url: string; title: string } | null {
  const incoming = line.incoming;
  if (typeof incoming?.url === "string" && incoming.url) {
    return { url: incoming.url, title: typeof incoming.title === "string" ? incoming.title : "" };
  }
  const candidate = line.candidate;
  for (const url of [candidate?.gh_issue_url, candidate?.linear_issue_url]) {
    if (typeof url === "string" && url) return { url, title: typeof candidate?.title === "string" ? candidate.title : "" };
  }
  return null;
}

/**
 * The duplicate card's cancel: the Issue intake was about to take in goes on the ignore list, and the judgement is
 * recorded (`pending_review_resolved`, outcome `ignore`). The list is written first, so a record that cannot be
 * written leaves the Issue out of intake and the card up: pressing again writes the record. Nothing is written to
 * GitHub or Linear.
 */
export async function ignorePendingReview(reviewId: string): Promise<{ ok: boolean; wrote: string[]; target?: IgnoreTarget; warning?: string; error?: string }> {
  const line = (readPendingReviews() as unknown as PendingReviewLine[]).filter((r) => r.review_id === reviewId).pop();
  if (!line) return { ok: false, wrote: [], error: `重複の判定がありません: ${reviewId}` };
  const found = pendingReviewUrl(line);
  if (!found) return { ok: false, wrote: [], error: `取り込む起票の URL が判定の行にありません: ${reviewId}` };
  const target: IgnoreTarget = {
    source: /^https:\/\/github\.com\//.test(found.url) ? "github" : "linear",
    url: found.url,
    ref: refOfIssueUrl(found.url),
    title: found.title,
  };
  const list = await setIgnored("ignore", target, "ignore").catch((err): IgnoreResult => ({ ok: false, error: String(err) }));
  if (!list.ok) return { ok: false, wrote: [], error: list.error };

  const resolved = await transition(reviewId, "pending_review_resolved", { review_id: reviewId, outcome: "ignore" });
  if (!resolved.ok) return { ok: true, wrote: [], target, warning: `起票は無視リストに載せましたが、重複の判定を記録できませんでした: ${resolved.reason}` };
  return { ok: true, wrote: [resolved.path], target };
}

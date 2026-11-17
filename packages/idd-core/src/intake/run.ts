
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { githubAreas, linearAreas, type LinearArea } from "../config/areas.ts";
import { workBaseManifest } from "../overlay/work-base.ts";
import { pipelineSettings } from "../config/pipeline.ts";
import { closedLanes, landedLanes } from "../plan/ledger-reads.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord, CronSlotWait, HeldIssue, IssueBlocker } from "../schema/records.ts";
import type { SlotWait } from "../plan/slot-wait.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { appendLifecycle, transition, withdrawJsonl } from "../ledger/write.ts";
import { isLaneGateBusy, withLaneGate } from "../ledger/gate.ts";
import { listIssues, readIssue, type GithubIssue, type IssueRead } from "./github.ts";
import { ignoredLine, readIgnores, refOfIssueUrl } from "./ignore.ts";
import { LINEAR_DONE_TYPES, canonicalLinearUrl, createLinearClient, readLinearKey, type LinearClient, type LinearFetch, type LinearIssue } from "./linear.ts";

export interface IntakeResult {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  added: string[];
  duplicates: { iddId: string; url: string }[];
  /** GitHub numbers and Linear identifiers that were named but are not open for intake */
  unmatched: (number | string)[];
  /** Issues read but not taken in (a Linear team no repo takes, a state or label outside the filter, a GitHub Issue moved elsewhere) */
  skipped: { ref: string; title: string; reason: string }[];
  failures: { area: string; reason: string }[];
  /** Issues a filtered run held back because a same-repo dependency is still open */
  held: HeldIssue[];
  /** blockers in another repo / team a run read but did not follow */
  ignoredBlockers: { ref: string; title: string; blocker: IssueBlocker }[];
}

export interface DuplicateDetector {
  (incoming: IncomingIssue, backlog: BacklogRecord[]): Promise<{ existing: BacklogRecord; similarity: number } | null>;
}

function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

/** the next IDD number a lane opened from this backlog gets */
export function nextIddId(backlog: BacklogRecord[]): number {
  const max = backlog.reduce((acc, rec) => {
    const m = rec.idd_id.match(/^IDD-(\d+)$/);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return max + 1;
}

async function appendBacklog(rec: BacklogRecord): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "backlog.jsonl");
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
  } finally {
    await release();
  }
}

async function openPendingReview(rec: {
  reviewId: string;
  incoming: { title: string; url: string };
  existing: BacklogRecord;
  similarity: number;
  detectionMethod: "url" | "semantic";
}): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "pending-reviews.jsonl");
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify({
      review_id: rec.reviewId,
      opened_at: nowIso(),
      incoming: rec.incoming,
      existing_idd_id: rec.existing.idd_id,
      existing_title: rec.existing.title,
      similarity: rec.similarity,
      detection_method: rec.detectionMethod,
    })}\n`, "utf8");
  } finally {
    await release();
  }
  await appendLifecycle("pending_review_open", rec.existing.idd_id, {
    review_id: rec.reviewId,
    detection_method: rec.detectionMethod,
  });
}

/** closed lanes, each with the time of its last close (ms; NaN when the event has no readable time) */
export function closedLaneIds(): Map<string, number> {
  // the ends a lane does not go on after are listed in the fold, so intake's list and the fold's are one
  return closedLanes(readLifecycle());
}

/** an Issue from either source, as the rest of intake sees it */
export interface IncomingIssue {
  source: "github" | "linear";
  /** #12 for GitHub, APP-1234 for Linear */
  ref: string;
  title: string;
  url: string;
  body: string;
}

export interface Gathered extends IncomingIssue {
  area: string;
  repo: string;
  primary: boolean;
  number?: number;
  identifier?: string;
  /** Linear's own id of the Issue */
  linearId?: string;
  /** when the Issue last changed on Linear */
  updatedAt?: string;
  /** Linear's estimate and priority as read: shown in the list, never a condition or a record */
  estimate?: number | null;
  priority?: number;
  /** this Issue came from the unassigned query, not from the assigned list */
  unassigned?: boolean;
  /** dependencies the source reported for this Issue, as it described them */
  blockers: IssueBlocker[];
  /** the source returned more blockers than it read */
  blockersTruncated: boolean;
}

interface Skipped { ref: string; title: string; reason: string }
type Failure = { area: string; reason: string };

/** the record is for this Issue: the same GitHub URL, the same Linear id, or the same Linear URL */
function sameIssue(rec: BacklogRecord, issue: { url: string; linearId?: string }): boolean {
  if (rec.gh_issue_url && rec.gh_issue_url === issue.url) return true;
  if (issue.linearId && rec.linear_issue_id && rec.linear_issue_id === issue.linearId) return true;
  return Boolean(rec.linear_issue_url) && canonicalLinearUrl(rec.linear_issue_url as string) === canonicalLinearUrl(issue.url);
}

function urlDuplicate(issue: { url: string; linearId?: string }, backlog: BacklogRecord[], closed: Map<string, number>): BacklogRecord | undefined {
  return laneHoldingIssue(issue, backlog, closed);
}

/**
 * The lane that still holds this Issue, or undefined when none does. `except` leaves one out: a redo asks this
 * before it closes the lane it is replacing, so it can refuse without closing anything.
 */
export function laneHoldingIssue(issue: { url: string; linearId?: string }, backlog: BacklogRecord[], closed: Map<string, number>, except?: string): BacklogRecord | undefined {
  return backlog.find((rec) => rec.idd_id !== except && !closed.has(rec.idd_id) && sameIssue(rec, issue));
}

/**
 * A Linear Issue stays Todo when its lane closes, so it would come back on every run. Unnamed, it comes back only once
 * it changed on Linear after the lane's last close. GitHub Issues are left as they were.
 */
function closedAndUntouched(issue: Gathered, backlog: BacklogRecord[], closed: Map<string, number>): BacklogRecord | undefined {
  if (issue.source !== "linear" || urlDuplicate(issue, backlog, closed)) return undefined;
  const updated = Date.parse(issue.updatedAt ?? "");
  return backlog.filter((rec) => closed.has(rec.idd_id) && sameIssue(rec, issue)).find((rec) => {
    const closedAt = closed.get(rec.idd_id) as number;
    return Number.isNaN(updated) || Number.isNaN(closedAt) || updated <= closedAt;
  });
}

export interface LinearIntakeDeps {
  /** replaces the network call (tests) */
  linearFetch?: LinearFetch;
  /** the most Issues read from Linear in one run */
  linearLimit?: number;
  /** how long one request to Linear may take (ms, default 20000) */
  linearTimeoutMs?: number;
}

/**
 * The listing's own option: with it the list also reads the unassigned Issues of repos that do not take them in,
 * so a person can see them and name one. It never changes what a run would take in, nor what `idd ignore` looks at.
 */
export interface LinearListDeps extends LinearIntakeDeps {
  includeUnassigned?: boolean;
}

function gatherGithub(): { items: Gathered[]; failures: Failure[] } {
  const items: Gathered[] = [];
  const failures: Failure[] = [];
  for (const area of githubAreas()) {
    let issues: GithubIssue[];
    const refused = workBaseManifest(area.area);
    if (refused) {
      failures.push({ area: area.area, reason: refused.message });
      continue;
    }
    try {
      issues = listIssues(area.repo, area.labels);
    } catch (err) {
      failures.push({ area: area.area, reason: (err as Error).message });
      continue;
    }
    for (const issue of issues) {
      items.push({
        source: "github", ref: `#${issue.number}`, title: issue.title, url: issue.url, body: issue.body,
        area: area.area, repo: area.repo, primary: area.primary, number: issue.number,
        blockers: githubBlockers(issue, area.repo), blockersTruncated: issue.blockersTruncated,
      });
    }
  }
  return { items, failures };
}

/** a GitHub blocker is followed only in the candidate's own repo; the repo names compare without case */
function githubBlockers(issue: GithubIssue, repo: string): IssueBlocker[] {
  return issue.blockers.map((b) => {
    const repoName = b.repo;
    // a node that named neither a repo nor a number cannot be placed: it is not another repo's blocker
    return {
      ref: b.number === null ? "#?" : `#${b.number}`,
      title: b.title, url: b.url, state: b.state, scope: repoName ?? "",
      outOfScope: repoName !== null && b.number !== null && repoName.toLowerCase() !== repo.toLowerCase(),
    };
  });
}

/**
 * GitHub Issues named by number, each read by itself whatever its labels. A bare number names an Issue only when
 * exactly one intake repo has it open, and is not guessed when a repo could not be read.
 */
function gatherGithubNamed(refs: { repo?: string; number: number }[]): { items: Gathered[]; unmatched: number[]; skipped: Skipped[]; failures: Failure[] } {
  const items: Gathered[] = [];
  const unmatched: number[] = [];
  const skipped: Skipped[] = [];
  const failures: Failure[] = [];
  const areas = githubAreas();
  // a repo whose work base cannot start a lane is refused once, however many Issues are named
  const refusals = new Map<string, string | null>();
  const refusalOf = (name: string): string | null => {
    if (!refusals.has(name)) {
      const refused = workBaseManifest(name)?.message ?? null;
      refusals.set(name, refused);
      if (refused) failures.push({ area: name, reason: refused });
    }
    return refusals.get(name)!;
  };
  for (const ref of refs) {
    const hits: Gathered[] = [];
    const moved: Skipped[] = [];
    const read = new Set<string>();
    let failed = false;
    for (const area of areas) {
      if ((ref.repo && area.repo !== ref.repo) || read.has(area.repo)) continue;
      read.add(area.repo);
      if (refusalOf(area.area)) {
        failed = true;
        continue;
      }
      let got: IssueRead;
      try {
        got = readIssue(area.repo, ref.number);
      } catch (err) {
        failures.push({ area: area.area, reason: (err as Error).message });
        failed = true;
        continue;
      }
      if ("movedTo" in got) {
        moved.push({ ref: `${area.repo}#${ref.number}`, title: got.title, reason: `${area.repo}#${ref.number} は ${got.movedTo} へ移されています。取り込む repo の Issue ではないので取り込みません` });
      } else if ("issue" in got) {
        const issue = got.issue;
        hits.push({
          source: "github", ref: `#${issue.number}`, title: issue.title, url: issue.url, body: issue.body,
          area: area.area, repo: area.repo, primary: area.primary, number: issue.number,
          blockers: githubBlockers(issue, area.repo), blockersTruncated: issue.blockersTruncated,
        });
      }
    }
    if (hits.length > 1) failures.push({ area: `#${ref.number}`, reason: `#${ref.number} は ${hits.map((h) => h.repo).join(", ")} にあります。owner/name#${ref.number} で指定してください` });
    else if (failed) continue;
    else if (hits.length) items.push(hits[0]);
    else {
      unmatched.push(ref.number);
      skipped.push(...moved);
    }
  }
  return { items, unmatched, skipped, failures };
}

/** the repos that take Linear Issues in and the key to read them with; null (with the failures) when Linear is not asked */
function linearIntake(failures: Failure[]): { areas: LinearArea[]; key: string } | null {
  const areas: LinearArea[] = [];
  for (const area of linearAreas()) {
    const refused = workBaseManifest(area.area);
    if (refused) failures.push({ area: area.area, reason: refused.message });
    if (area.teams.length) areas.push(refused ? { ...area, refusal: refused.message } : area);
    else failures.push({ area: area.area, reason: "Linear から取り込む repo ですが linear_teams（チームの対応）がありません" });
  }
  if (!areas.length) return null;
  const key = readLinearKey();
  if (key.key === null) {
    failures.push({ area: "linear", reason: key.reason });
    return null;
  }
  return { areas, key: key.key };
}

function linearTeams(areas: LinearArea[]): Map<string, LinearArea> {
  const byTeam = new Map<string, LinearArea>();
  for (const area of areas) for (const team of area.teams) byTeam.set(team, area);
  return byTeam;
}

function linearItem(issue: LinearIssue, area: LinearArea, blockers: IssueBlocker[] = [], blockersTruncated = false, unassigned = false): Gathered {
  return {
    source: "linear", ref: issue.identifier, title: issue.title, url: issue.url, body: issue.description,
    area: area.area, repo: area.repo, primary: area.primary, identifier: issue.identifier,
    ...(issue.id ? { linearId: issue.id } : {}), updatedAt: issue.updatedAt,
    estimate: issue.estimate, priority: issue.priority,
    ...(unassigned ? { unassigned: true as const } : {}),
    blockers, blockersTruncated,
  };
}

/** a Linear blocker is followed only when its team maps to the candidate's own repo */
function linearBlockers(issue: LinearIssue, area: LinearArea, byTeam: Map<string, LinearArea>): IssueBlocker[] {
  return issue.blockers.map((b) => {
    const blockerArea = byTeam.get(b.teamKey.toUpperCase());
    return {
      ref: b.identifier, title: b.title, url: b.url,
      state: LINEAR_DONE_TYPES.has(b.stateType) ? "closed" : "open",
      scope: b.teamKey,
      outOfScope: !blockerArea || blockerArea.area !== area.area,
    };
  });
}

const refusedReason = (area: LinearArea): string => `${area.area} は work の本流の overlay.manifest が整うまで取り込みません（failures の ${area.area} を参照）`;

const noTeam = (issue: LinearIssue): Skipped => ({ ref: issue.identifier, title: issue.title, reason: `チーム ${issue.teamKey} に対応する repo がありません` });

/**
 * The repo that takes this Issue in, or the reason none does. Assigned and unassigned Issues go through the same
 * conditions: state, the labels it must carry, and the labels that say «not now» (a label outranks the rest).
 */
function routeLinear(issue: LinearIssue, byTeam: Map<string, LinearArea>): { area: LinearArea } | { skip: Skipped } {
  const area = byTeam.get(issue.teamKey.toUpperCase());
  if (!area) return { skip: noTeam(issue) };
  const skip = (reason: string) => ({ skip: { ref: issue.identifier, title: issue.title, reason } });
  if (area.refusal) return skip(refusedReason(area));
  if (!area.statuses.includes(issue.state)) return skip(`状態 ${issue.state} は ${area.area} の取り込み対象外です`);
  const missing = area.labels.filter((l) => !issue.labels.includes(l));
  if (missing.length) return skip(`ラベル ${missing.join(", ")} がありません`);
  const excluded = area.excludeLabels.filter((l) => issue.labels.includes(l));
  if (excluded.length) return skip(`除外のラベル ${excluded.join(", ")} が付いています`);
  return { area };
}

/**
 * Issues assigned to the key's owner, routed to a repo by team key, plus (for a repo that asks for them) the
 * unassigned Issues of its teams. Nothing is asked of Linear when no repo takes Linear Issues in; a missing key is
 * one failure line, and the GitHub side goes on. The unassigned read is only added on top: a repo that writes
 * nothing is read exactly as before.
 */
async function gatherLinear(opts: LinearListDeps): Promise<{ items: Gathered[]; skipped: Skipped[]; failures: Failure[]; unassigned: Gathered[] }> {
  const items: Gathered[] = [];
  const skipped: Skipped[] = [];
  const failures: Failure[] = [];
  const unassigned: Gathered[] = [];
  const intake = linearIntake(failures);
  if (!intake) return { items, skipped, failures, unassigned };
  const { areas } = intake;
  const limit = opts.linearLimit ?? 100;
  const states = [...new Set(areas.flatMap((a) => a.statuses))];
  const client = createLinearClient(intake.key, { fetch: opts.linearFetch, timeoutMs: opts.linearTimeoutMs });
  let listed: Awaited<ReturnType<LinearClient["listAssignedIssues"]>>;
  try {
    listed = await client.listAssignedIssues({ states, limit });
  } catch (err) {
    failures.push({ area: "linear", reason: (err as Error).message });
    return { items, skipped, failures, unassigned };
  }
  if (listed.truncated) failures.push({ area: "linear", reason: `割り当てられた Issue が上限 ${limit} 件を超えています。${limit} 件目より後は読んでいません` });

  const byTeam = linearTeams(areas);
  for (const issue of listed.issues) {
    const routed = routeLinear(issue, byTeam);
    if ("skip" in routed) { skipped.push(routed.skip); continue; }
    items.push(linearItem(issue, routed.area, linearBlockers(issue, routed.area, byTeam), issue.blockersTruncated));
  }

  // the teams whose unassigned Issues are read: a repo that takes them in (they can become lanes), and, when the
  // caller lists them, every repo that takes Linear in (those are shown apart and never become lanes)
  const takesIn = new Set(areas.filter((a) => a.includeUnassigned).flatMap((a) => a.teams));
  const shown = opts.includeUnassigned ? new Set(areas.flatMap((a) => a.teams)) : new Set<string>();
  const teams = [...new Set([...takesIn, ...shown])];
  if (teams.length) {
    let extra: Awaited<ReturnType<LinearClient["listUnassignedIssues"]>>;
    try {
      extra = await client.listUnassignedIssues({ teams, states, limit });
    } catch (err) {
      failures.push({ area: "linear", reason: (err as Error).message });
      return { items, skipped, failures, unassigned };
    }
    if (extra.truncated) failures.push({ area: "linear", reason: `未アサインの Issue が上限 ${limit} 件を超えています。${limit} 件目より後は読んでいません` });
    for (const issue of extra.issues) {
      const routed = routeLinear(issue, byTeam);
      if ("skip" in routed) { skipped.push(routed.skip); continue; }
      if (routed.area.includeUnassigned) items.push(linearItem(issue, routed.area, linearBlockers(issue, routed.area, byTeam), issue.blockersTruncated, true));
      else unassigned.push(linearItem(issue, routed.area, [], issue.blockersTruncated, true));
    }
  }
  return { items, skipped, failures, unassigned };
}

/**
 * Linear Issues named by identifier, each read by itself: whoever it is assigned to, whatever its state and labels.
 * It still has to belong to a team some repo takes in.
 */
async function gatherLinearNamed(identifiers: string[], deps: LinearIntakeDeps): Promise<{ items: Gathered[]; unmatched: string[]; skipped: Skipped[]; failures: Failure[] }> {
  const items: Gathered[] = [];
  const unmatched: string[] = [];
  const skipped: Skipped[] = [];
  const failures: Failure[] = [];
  const intake = linearIntake(failures);
  if (!intake) {
    if (!failures.length) unmatched.push(...identifiers);
    return { items, unmatched, skipped, failures };
  }
  const client = createLinearClient(intake.key, { fetch: deps.linearFetch, timeoutMs: deps.linearTimeoutMs });
  const byTeam = linearTeams(intake.areas);
  const asked = [...new Set(identifiers)];
  for (const [i, identifier] of asked.entries()) {
    let issue: LinearIssue | null;
    try {
      issue = await client.getIssue(identifier);
    } catch (err) {
      // Linear is down or refuses the key: the rest would fail the same way
      failures.push({ area: "linear", reason: `${(err as Error).message}（読めなかった識別子: ${asked.slice(i).join(", ")}）` });
      break;
    }
    if (!issue) { unmatched.push(identifier); continue; }
    const area = byTeam.get(issue.teamKey.toUpperCase());
    if (!area) { skipped.push(noTeam(issue)); continue; }
    if (area.refusal) { skipped.push({ ref: issue.identifier, title: issue.title, reason: refusedReason(area) }); continue; }
    items.push(linearItem(issue, area));
  }
  return { items, unmatched, skipped, failures };
}

/**
 * The GitHub Issue URLs of lanes that ended by being landed into the work side's mainline (lane_close with the merge
 * commit). Until penne approves the close one-liner the Issue is still open and would come back on every run.
 */
function landedLaneIssues(backlog: BacklogRecord[]): Set<string> {
  const byId = new Map(backlog.map((r) => [r.idd_id, r]));
  const urls = new Set<string>();
  for (const idd of landedLanes(readLifecycle())) {
    const url = byId.get(idd)?.gh_issue_url;
    if (url) urls.add(url);
  }
  return urls;
}

/**
 * A repo's primary source comes first. Unnamed, a Linear Issue whose lane closed waits for an update on Linear
 * (it moves to skipped); a named one comes back at once, as a requeue of the closed lane. A GitHub Issue whose lane
 * was landed into the work side's mainline is likewise left out unnamed until penne approves closing it.
 */
function settle(gh: Gathered[], ln: Gathered[], skipped: Skipped[], backlog: BacklogRecord[], closed: Map<string, number>, named = false): Gathered[] {
  const open = named ? ln : ln.filter((it) => {
    const closedLane = closedAndUntouched(it, backlog, closed);
    if (closedLane) skipped.push({ ref: it.ref, title: it.title, reason: `${closedLane.idd_id} が閉じた後に Linear で更新されていません` });
    return !closedLane;
  });
  const landed = landedLaneIssues(backlog);
  const ghOpen = named ? gh : gh.filter((it) => {
    if (!landed.has(it.url)) return true;
    skipped.push({ ref: it.ref, title: it.title, reason: "取り込みで閉じた lane の Issue です（`idd intake owner/name#N` と名指しすると取り込みます）" });
    return false;
  });
  // the primary source takes the lower IDD numbers when both sources have work
  return [...ghOpen, ...open].map((it, i) => ({ it, i }))
    .sort((a, b) => Number(!a.it.primary) - Number(!b.it.primary) || a.i - b.i)
    .map(({ it }) => it);
}

/** Issues on the ignore list move to skipped, whichever way they were read (the list is read here and nowhere else in intake) */
function dropIgnored(items: Gathered[], skipped: Skipped[]): Gathered[] {
  const records = readIgnores();
  if (!records.length) return items;
  return items.filter((it) => {
    const on = ignoredLine({ url: it.url, ...(it.linearId ? { linearId: it.linearId } : {}) }, records);
    if (!on) return true;
    // named as the list names it: a Linear Issue moved to another team is on the list under its old ref
    skipped.push({ ref: it.ref, title: it.title, reason: `無視リストにあります（idd unignore ${on.ref} で外すと取り込みます）` });
    return false;
  });
}

async function gather(opts: { backlog: BacklogRecord[]; closed: Map<string, number> } & LinearListDeps): Promise<{ items: Gathered[]; skipped: Skipped[]; failures: Failure[]; unassigned: Gathered[] }> {
  const gh = gatherGithub();
  const ln = await gatherLinear(opts);
  const skipped = [...ln.skipped];
  const items = dropIgnored(settle(gh.items, ln.items, skipped, opts.backlog, opts.closed), skipped);
  return { items, skipped, failures: distinctFailures([...gh.failures, ...ln.failures]), unassigned: ln.unassigned };
}

/** a repo on both sources (GitHub and Linear) is refused by both reads: the same line once */
function distinctFailures(failures: Failure[]): Failure[] {
  return failures.filter((f, i) => failures.findIndex((g) => g.area === f.area && g.reason === f.reason) === i);
}

function sameGathered(a: Gathered, b: Gathered): boolean {
  return a.url === b.url || (Boolean(a.linearId) && a.linearId === b.linearId);
}

/** a named Issue that the filtered run also found (or left out) is the named one only */
function combine(
  named: { items: Gathered[]; unmatched: (number | string)[]; skipped: Skipped[]; failures: Failure[] } | null,
  listed: { items: Gathered[]; skipped: Skipped[]; failures: Failure[] } | null,
): { items: Gathered[]; unmatched: (number | string)[]; skipped: Skipped[]; failures: Failure[] } {
  if (!listed) return named!;
  if (!named) return { unmatched: [], ...listed };
  const namedRefs = new Set(named.items.map((it) => it.ref));
  return {
    items: [...named.items, ...listed.items.filter((it) => !named.items.some((n) => sameGathered(n, it)))],
    unmatched: named.unmatched,
    skipped: [...named.skipped, ...listed.skipped.filter((x) => !namedRefs.has(x.ref))],
    failures: distinctFailures([...named.failures, ...listed.failures]),
  };
}

/** only the named Issues, each read by itself; naming Issues reads only the sources they are in */
async function gatherNamed(refs: IssueRef[], opts: { backlog: BacklogRecord[]; closed: Map<string, number> } & LinearIntakeDeps): Promise<{ items: Gathered[]; unmatched: (number | string)[]; skipped: Skipped[]; failures: Failure[] }> {
  const ghRefs = refs.filter((r): r is { repo?: string; number: number } => "number" in r);
  const linearRefs = refs.filter((r): r is { identifier: string } => "identifier" in r).map((r) => r.identifier);
  const gh = ghRefs.length ? gatherGithubNamed(ghRefs) : { items: [], unmatched: [], skipped: [], failures: [] };
  const ln = linearRefs.length ? await gatherLinearNamed(linearRefs, opts) : { items: [], unmatched: [], skipped: [], failures: [] };
  const skipped = [...gh.skipped, ...ln.skipped];
  const items = dropIgnored(settle(gh.items, ln.items, skipped, opts.backlog, opts.closed, true), skipped);
  return { items, unmatched: [...gh.unmatched, ...ln.unmatched], skipped, failures: distinctFailures([...gh.failures, ...ln.failures]) };
}

/** the blockers a filtered run follows: blockers in another repo / team are read, but do not hold */
export function followedBlockers(issue: { blockers?: IssueBlocker[] }): IssueBlocker[] {
  return (issue.blockers ?? []).filter((b) => !b.outOfScope);
}

/** why a filtered run leaves this Issue out, or undefined when nothing in its tracker blocks it */
export function holdReason(issue: Gathered): string | undefined {
  if (issue.blockersTruncated) return "blocker の数が 1 回で読める数を超えています";
  const open = followedBlockers(issue).filter((b) => b.state !== "closed");
  if (!open.length) return undefined;
  const refs = open.map((b) => b.ref).join(", ");
  // an empty scope is a GitHub node the list did not place: its repo and number were not in the answer
  if (open.some((b) => b.scope === "")) return `blocker を読めませんでした（${refs}）`;
  return open.some((b) => b.state === "unknown")
    ? `blocker の状態を読めませんでした（${refs}）`
    : `開いた blocker があります（${refs}）`;
}

/** the Issues a run read but did not follow: another repo's, another team's */
function ignoredBlockersOf(items: Gathered[]): { ref: string; title: string; blocker: IssueBlocker }[] {
  return items.flatMap((it) => it.blockers.filter((b) => b.outOfScope).map((b) => ({ ref: it.ref, title: it.title, blocker: b })));
}

export const INTAKE_HOLDS_FILE = "intake-holds.json";

export function intakeHoldsPath(): string {
  return join(stateDir(), INTAKE_HOLDS_FILE);
}

/** the Issues a filtered run held back; an unreadable file is no holds (the next filtered run writes it again) */
export function readIntakeHolds(): { holds: HeldIssue[]; error: string | null } {
  const path = intakeHoldsPath();
  if (!existsSync(path)) return { holds: [], error: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { holds?: unknown };
    return { holds: Array.isArray(parsed?.holds) ? (parsed.holds as HeldIssue[]) : [], error: null };
  } catch (err) {
    return { holds: [], error: (err as Error).message };
  }
}

/** replace the holds: a reader never sees the file half written */
function writeIntakeHolds(holds: HeldIssue[]): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = intakeHoldsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updated_at: nowIso(), holds }, null, 2), "utf8");
  renameSync(tmp, path);
}

const heldKey = (h: HeldIssue): string => `${h.source}:${h.url}`;

/**
 * The holds to leave: this run's, plus the ones of a source the run could not read (a repo gh refused, Linear).
 * Dropping those would make a temporary read failure look like the dependency was resolved.
 */
function mergeHolds(previous: HeldIssue[], fresh: HeldIssue[], failures: Failure[]): HeldIssue[] {
  const failed = new Set(failures.map((f) => f.area));
  if (!failed.size) return fresh;
  const kept = previous.filter((h) => failed.has(h.area) || (failed.has("linear") && h.source === "linear"));
  const keptKeys = new Set(kept.map(heldKey));
  return [...kept, ...fresh.filter((h) => !keptKeys.has(heldKey(h)))];
}

function heldFrom(issue: Gathered, reason: string): HeldIssue {
  return { source: issue.source, area: issue.area, ref: issue.ref, title: issue.title, url: issue.url, reason, blockers: followedBlockers(issue) };
}

export interface IntakeCandidate {
  source: "github" | "linear";
  area: string;
  /** #12 or APP-1234 */
  ref: string;
  number?: number;
  title: string;
  url: string;
  /** Linear's own id: it stays when the Issue moves to another team (a new identifier and URL) */
  linearId?: string;
  /** Linear's estimate and priority as read: shown in the list, never a condition, an order, or a record */
  estimate?: number | null;
  priority?: number;
  alreadyInBacklog: string | null;
  /** how a filtered run would hold this Issue back (absent when it would take it in) */
  hold?: { reason: string; blockers: IssueBlocker[] };
}

/** an unassigned Linear Issue of a repo that does not take unassigned Issues in: shown apart, and never a lane */
export interface UnassignedIssue {
  area: string;
  /** APP-1234 */
  ref: string;
  title: string;
  url: string;
  /** Linear's own id: it stays when the Issue moves to another team (a new identifier and URL) */
  linearId?: string;
  estimate: number | null;
  priority: number;
}

/** what a run would take in, read only: nothing is written and no lane opens */
export async function listIntakeCandidates(deps: LinearListDeps = {}): Promise<{ candidates: IntakeCandidate[]; skipped: Skipped[]; failures: Failure[]; ignoredBlockers: { ref: string; title: string; blocker: IssueBlocker }[]; unassigned: UnassignedIssue[] }> {
  const backlog = readBacklog();
  const closed = closedLaneIds();
  const { items, skipped, failures, unassigned } = await gather({ backlog, closed, ...deps });
  const candidates = items.map((it) => {
    // a lane already holds the Issue: that is a duplicate, not a dependency wait
    const already = urlDuplicate(it, backlog, closed)?.idd_id ?? null;
    const reason = already ? undefined : holdReason(it);
    return {
      source: it.source,
      area: it.area,
      ref: it.ref,
      ...(it.number !== undefined ? { number: it.number } : {}),
      title: it.title,
      url: it.url,
      ...(it.linearId ? { linearId: it.linearId } : {}),
      ...(it.source === "linear" ? { estimate: it.estimate ?? null, priority: it.priority ?? 0 } : {}),
      alreadyInBacklog: already,
      ...(reason ? { hold: { reason, blockers: followedBlockers(it) } } : {}),
    };
  });
  return {
    candidates, skipped, failures, ignoredBlockers: ignoredBlockersOf(items),
    unassigned: unassigned.map((it) => ({
      area: it.area,
      ref: it.ref,
      title: it.title,
      url: it.url,
      ...(it.linearId ? { linearId: it.linearId } : {}),
      estimate: it.estimate ?? null,
      priority: it.priority ?? 0,
    })),
  };
}

/** an Issue to take in: a GitHub number (`repo` owner/name narrows it to one repo) or a Linear identifier */
export type IssueRef = { repo?: string; number: number } | { identifier: string };

/** one named Issue read by itself, for a caller that re-reads the Issue a lane was taken in from (redo): the Issue, or why it is not read */
export async function readNamedIssue(ref: IssueRef, deps: LinearIntakeDeps = {}): Promise<{ issue: Gathered | null; reason: string }> {
  const { items, skipped, failures } = await gatherNamed([ref], { backlog: readBacklog(), closed: closedLaneIds(), ...deps });
  if (items.length) return { issue: items[0], reason: "" };
  const label = "identifier" in ref ? ref.identifier : `#${ref.number}`;
  return { issue: null, reason: skipped[0]?.reason ?? failures[0]?.reason ?? `${label} は取り込み元に開いていません（閉じたか、移されたか、読めませんでした）` };
}

/** how a lane opened from an Issue stands to the lane it replaces: a re-take (`requeued`) or penne's own redo */
export interface OpenLaneFrom {
  iddId: string;
  kind: "requeued" | "redo";
}

/**
 * Open a lane from one Issue: the backlog row and its `lane_open`, inside the lane gate, from the backlog read
 * again there, so two callers (two intakes, an intake and a redo) never open the same Issue twice. A lane taken in
 * again carries `requeued_from`, one penne starts over `redo_of`: the stage derivation waits for penne only for the
 * first. The row goes first (the lifecycle's file is chosen by the row's area) and is taken back when `lane_open`
 * cannot be written, so no row is left without its lane.
 */
export async function openLaneForIssue(issue: Gathered, from?: OpenLaneFrom): Promise<{ added: string; rec: BacklogRecord; wrote: string } | { duplicate: string }> {
  return withLaneGate(async () => {
    const current = readBacklog();
    const dup = laneHoldingIssue(issue, current, closedLaneIds(), from?.iddId);
    if (dup) return { duplicate: dup.idd_id };
    const iddId = `IDD-${String(nextIddId(current)).padStart(3, "0")}`;
    const linear = issue.source === "linear";
    const previous = from ? current.find((r) => r.idd_id === from.iddId) : current.filter((r) => sameIssue(r, issue)).pop();
    const rec: BacklogRecord = {
      idd_id: iddId,
      parent_id: previous?.idd_id ?? null,
      created_at: nowIso(),
      linear_issue_url: linear ? issue.url : null,
      ...(linear && issue.linearId ? { linear_issue_id: issue.linearId } : {}),
      gh_issue_url: linear ? null : issue.url,
      pull_req_url: null,
      source_type: issue.source,
      context: issue.body.slice(0, 2000),
      title: issue.title,
      area: issue.area,
      // the same-repo dependencies stay with the lane: the GO waits on them until they land, named or not
      ...(followedBlockers(issue).length ? { blockers: followedBlockers(issue) } : {}),
    };
    const opened = await transition(iddId, "lane_open", {
      source_type: issue.source,
      area: issue.area,
      ...(linear ? { linear_issue_url: issue.url, linear_identifier: issue.identifier, ...(issue.linearId ? { linear_issue_id: issue.linearId } : {}) } : { gh_issue_url: issue.url }),
      ...(previous ? { [from?.kind === "redo" ? "redo_of" : "requeued_from"]: previous.idd_id } : {}),
      // the pipeline as it stood when the lane opened (C-184-10): a lane is grouped by the settings it ran under, not
      // by the date it opened. The copy is read once, here and never written again; a lane opened before the copy
      // existed has none, and is read as "no record" rather than given one after the fact
      pipeline: pipelineSettings(),
    }, {
      before: () => appendBacklog(rec),
      undo: () => withdrawJsonl(join(stateDir(), "backlog.jsonl"), (row) => row.idd_id === iddId),
    });
    if (!opened.ok) throw new Error(`lane_open を書けませんでした: ${opened.reason}`);
    return { added: iddId, rec, wrote: opened.path };
  });
}

export function parseIssueRef(token: string): IssueRef | null {
  const t = token.trim();
  const linear = /^([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(t);
  if (linear) return { identifier: linear[1].toUpperCase() };
  const m = /^(?:([\w.-]+\/[\w.-]+)#)?(\d+)$/.exec(t);
  return m ? { ...(m[1] ? { repo: m[1] } : {}), number: Number(m[2]) } : null;
}

/** the ref an Issue's URL names, exactly as intake names it (`a/gh#12`, `APP-1234`); null when the URL names neither */
export function issueRefOfUrl(url: string): IssueRef | null {
  // GitHub: the repo the URL names goes with the number, so a redo reads the lane's own repo and not another
  // repo's Issue of the same number
  const gh = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(url);
  if (gh) return { repo: gh[1], number: Number(gh[2]) };
  return parseIssueRef(refOfIssueUrl(url).replace(/^#(?=\d+$)/, ""));
}

/**
 * `all` with named Issues runs both: the named ones read by themselves, and every Issue the intake filter takes.
 * An Issue both find is taken once, as a named one.
 */
export async function runIntake(opts: { detector?: DuplicateDetector; issueNumbers?: number[]; issueRefs?: IssueRef[]; all?: boolean } & LinearIntakeDeps = {}): Promise<IntakeResult> {
  const startedAt = nowIso();
  const result: IntakeResult = {
    startedAt, finishedAt: startedAt, scanned: 0, added: [], duplicates: [], unmatched: [], skipped: [], failures: [], held: [], ignoredBlockers: [],
  };

  const backlog = readBacklog();
  const closed = closedLaneIds();
  const refs: IssueRef[] | null = opts.issueRefs?.length ? opts.issueRefs : opts.issueNumbers?.length ? opts.issueNumbers.map((number) => ({ number })) : null;
  let seq = nextIddId(backlog);

  // a named Issue is read by itself and skips the intake filter; unnamed, the filter decides
  const named = refs ? await gatherNamed(refs, { backlog, closed, ...opts }) : null;
  const listed = !named || opts.all ? await gather({ backlog, closed, ...opts }) : null;
  const gathered = combine(named, listed);
  result.failures.push(...gathered.failures);
  result.skipped.push(...gathered.skipped);
  result.unmatched.push(...gathered.unmatched);
  result.scanned = gathered.items.length;
  result.ignoredBlockers.push(...ignoredBlockersOf(gathered.items));

  // a named Issue is taken in whatever its dependencies: naming it is how a person jumps the order
  const namedItems = named?.items ?? [];
  const isNamed = (it: Gathered) => namedItems.some((n) => sameGathered(n, it));

  for (const issue of gathered.items) {
    const already = urlDuplicate(issue, backlog, closed);
    if (already) {
      result.duplicates.push({ iddId: already.idd_id, url: issue.url });
      continue;
    }

    // a dependency wait keeps a filtered Issue out of both the duplicate check's follow-up and the review
    if (!isNamed(issue)) {
      const reason = holdReason(issue);
      if (reason) {
        result.held.push(heldFrom(issue, reason));
        continue;
      }
    }

    const incoming: IncomingIssue = { source: issue.source, ref: issue.ref, title: issue.title, url: issue.url, body: issue.body };
    const similar = opts.detector ? await opts.detector(incoming, backlog) : null;
    if (similar) {
      const reviewId = `REV-${String(seq).padStart(3, "0")}`;
      await openPendingReview({
        reviewId,
        incoming: { title: issue.title, url: issue.url },
        existing: similar.existing,
        similarity: similar.similarity,
        detectionMethod: "semantic",
      });
      result.duplicates.push({ iddId: similar.existing.idd_id, url: issue.url });
      continue;
    }

    // another run (the CLI, the screen, the timer's tick) may have read the same Issue meanwhile: the lane is made
    // inside the lane gate, from the backlog and the ends read again there, so of two runs only one opens it
    try {
      const made = await openLaneForIssue(issue);
      if ("duplicate" in made) result.duplicates.push({ iddId: made.duplicate, url: issue.url });
      else {
        result.added.push(made.added);
        backlog.push(made.rec);
        seq = Math.max(seq, nextIddId(backlog));
      }
    } catch (err) {
      // the gate stayed busy: this Issue waits for the next run, the others and the rest of the tick go on
      if (!isLaneGateBusy(err)) throw err;
      result.failures.push({ area: issue.ref, reason: err.message });
    }
  }

  result.finishedAt = nowIso();
  // only a run that read the filter takes the holds over; a named-only run leaves the last filtered read standing,
  // and a source the run could not read keeps its previous holds
  if (listed) writeIntakeHolds(mergeHolds(readIntakeHolds().holds, result.held, result.failures));
  await writeCronRun(result);
  return result;
}

function cronRunPath(startedAt: string): string {
  return join(stateDir(), `cron-run-${startedAt.replace(/[:+]/g, "-")}.json`);
}

async function writeCronRun(result: IntakeResult): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = cronRunPath(result.startedAt);
  // a reader never sees the record half written
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    cron_run_id: result.startedAt,
    started_at: result.startedAt,
    completed_at: result.finishedAt,
    intake_count: result.added.length,
    duplicate_count: result.duplicates.length,
    unmatched: result.unmatched,
    skipped: result.skipped,
    new_lane_count: result.added.length,
    failures: result.failures.map((f) => ({ idd_id: f.area, reason: f.reason })),
    held: result.held,
    ignored_blockers: result.ignoredBlockers,
  }, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Add the lanes each capped stage left waiting for its cap to the record of the run that took Issues in, once the
 * tick's stages have run. Written in the run's own record, so how the waits piled up can be read back run by run.
 */
export function recordCronRunSlotWaits(startedAt: string, waits: SlotWait[]): void {
  const path = cronRunPath(startedAt);
  if (!existsSync(path)) return;
  let run: Record<string, unknown>;
  try {
    run = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  run.slot_waits = cronSlotWaits(waits);
  // a reader never sees the record half written
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2), "utf8");
  renameSync(tmp, path);
}

export function cronSlotWaits(waits: SlotWait[]): CronSlotWait[] {
  return waits.map((w) => ({
    slot: w.slot,
    cap: w.cap,
    running: w.running,
    lanes: w.lanes.map((l) => ({ id: l.id, since: l.since, waited_min: l.waitedMinutes })),
  }));
}

import { readBlockerState } from "../intake/github.ts";
import { canonicalLinearUrl } from "../intake/linear.ts";
import type { BacklogRecord, BlockerState, IssueBlocker, LifecycleRecord } from "../schema/records.ts";
import { laneAnswer } from "../intent/moonbit-fold.ts";
import { laneHasEnded } from "./ends.ts";
import { readBacklog, readLifecycle } from "./read.ts";
import { routedUnreadableReason } from "./routed-answers.ts";
import { routingHoldReason } from "./routing-hold.ts";

/**
 * A lane's dependencies after intake, read side. Intake holds an Issue back while a same-repo blocker is open, but
 * a named Issue goes through, and until 2026-10-18 the blockers were forgotten once the lane existed: the GO card
 * came up, the executor met the brief's return condition and returned without a change, the review of the empty
 * diff converged, and a records-only landing closed the Issue. The blockers now ride on the backlog row
 * (`BacklogRecord.blockers`), and this module says what a lane still waits for: a blocker has landed when a lane
 * opened from it landed in the work side's mainline, or when its tracker says it is closed. A tracker that cannot be
 * read is "unknown", and the lane keeps waiting with that reason on its card. The GO's write side refuses on it
 * (`goBlockedReason`); the tick's stage that moves waiting lanes is plan/blockers.ts.
 */

/** how long one reading of a blocker's tracker state stands before the tick reads it again */
export const BLOCKER_STATE_TTL_MS = 5 * 60 * 1000;

/** reads a blocker's state from its tracker; null when the tracker cannot answer (not when the blocker is closed) */
export type TrackerRead = (blocker: IssueBlocker) => BlockerState | null;

export interface BlockerWaitItem {
  /** #12 or APP-1234 */
  ref: string;
  title: string;
  url: string;
  /** open: the tracker (or the record) says so; unknown: the tracker could not be read */
  state: "open" | "unknown";
  /** the open lane taken in from the blocker, when one exists */
  lane?: string;
}

export interface BlockerWait {
  items: BlockerWaitItem[];
  /** one line for a card or a refusal */
  reason: string;
}

export interface BlockerContext {
  backlog: BacklogRecord[];
  byLane: Map<string, LifecycleRecord[]>;
  now?: number;
  /** read the tracker for a blocker whose cached reading is stale (the tick does; a card build reads the cache) */
  refresh?: boolean;
  tracker?: TrackerRead;
}

const trackerCache = new Map<string, { state: BlockerState; at: number }>();

/** tests: forget every tracker reading */
export function resetBlockerStateCache(): void {
  trackerCache.clear();
}

function ghRefOfUrl(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(url);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** the tracker read the engine has: GitHub through gh; a Linear blocker has none here and keeps the recorded state */
const defaultTracker: TrackerRead = (b) => {
  const gh = ghRefOfUrl(b.url);
  return gh ? readBlockerState(gh.repo, gh.number) : null;
};

/**
 * The blocker's state as the engine knows it now: a reading not older than the TTL; else, when asked to refresh, a
 * new reading (a failure is kept as unknown for the TTL, so one unreachable tracker is not asked on every read);
 * else what intake recorded. A blocker this engine has no tracker read for (Linear) keeps the recorded state.
 */
function trackerState(b: IssueBlocker, ctx: BlockerContext): BlockerState {
  const now = ctx.now ?? Date.now();
  const cached = trackerCache.get(b.url);
  if (cached && now - cached.at < BLOCKER_STATE_TTL_MS) return cached.state;
  if (ctx.refresh && (ctx.tracker || ghRefOfUrl(b.url))) {
    const state: BlockerState = (ctx.tracker ?? defaultTracker)(b) ?? "unknown";
    trackerCache.set(b.url, { state, at: now });
    return state;
  }
  return cached?.state ?? b.state;
}

function sameIssueUrl(rec: BacklogRecord, url: string): boolean {
  if (rec.gh_issue_url && rec.gh_issue_url === url) return true;
  return Boolean(rec.linear_issue_url) && canonicalLinearUrl(rec.linear_issue_url as string) === canonicalLinearUrl(url);
}

/** the lane's work landed: merged into the work side's mainline, or its PR merged, or closed with the merge commit */
export function laneLanded(evs: LifecycleRecord[]): boolean {
  return laneAnswer<boolean>("lane_landed", evs);
}

/**
 * What the lane still waits for among its recorded same-repo blockers, or null when nothing holds it: each blocker
 * whose lane has not landed and whose tracker does not say closed. Out-of-scope blockers were never followed.
 */
export function laneBlockerWait(rec: BacklogRecord, ctx: BlockerContext): BlockerWait | null {
  const items: BlockerWaitItem[] = [];
  for (const b of rec.blockers ?? []) {
    if (b.outOfScope) continue;
    const lanes = ctx.backlog.filter((r) => r.idd_id !== rec.idd_id && sameIssueUrl(r, b.url));
    if (lanes.some((r) => laneLanded(ctx.byLane.get(r.idd_id) ?? []))) continue;
    const state = trackerState(b, ctx);
    if (state === "closed") continue;
    const open = lanes.filter((r) => !laneHasEnded(r.idd_id, ctx.byLane.get(r.idd_id) ?? [])).pop();
    items.push({ ref: b.ref, title: b.title, url: b.url, state: state === "open" ? "open" : "unknown", ...(open ? { lane: open.idd_id } : {}) });
  }
  if (!items.length) return null;
  const open = items.filter((i) => i.state === "open").map((i) => i.ref);
  const unknown = items.filter((i) => i.state === "unknown").map((i) => i.ref);
  const reason = [
    open.length ? `blocker が本流に着地していません（${open.join(", ")}）` : "",
    unknown.length ? `blocker の状態を読めません（${unknown.join(", ")}）` : "",
  ].filter(Boolean).join("。");
  return { items, reason };
}

export function lifecycleByLane(all: LifecycleRecord[]): Map<string, LifecycleRecord[]> {
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of all) byLane.set(e.idd_id, [...(byLane.get(e.idd_id) ?? []), e]);
  return byLane;
}

/**
 * Why the lane may not take its GO now, or null: the question judge still holds a batch of its planner's questions, the
 * answers the mechanism gave for them could not be read, or a recorded blocker has not landed. Read for the GO's write side (a person's press, the engine's automatic GO, the
 * API), with the tracker read when the cached reading is stale.
 */
export function goBlockedReason(iddId: string, opts: { now?: number; tracker?: TrackerRead } = {}): string | null {
  const held = routingHoldReason(iddId);
  if (held) return held;
  // the mechanism's answers are what a person confirms at the GO: a lane whose answers could not be read has nothing to
  // confirm them on, and an empty list is not the same as none
  const unconfirmed = routedUnreadableReason(iddId);
  if (unconfirmed) return unconfirmed;
  const backlog = readBacklog();
  const rec = backlog.find((r) => r.idd_id === iddId);
  if (!rec?.blockers?.length) return null;
  const wait = laneBlockerWait(rec, { backlog, byLane: lifecycleByLane(readLifecycle()), refresh: true, ...opts });
  return wait ? `blocker が着地するまで GO できません: ${wait.reason}` : null;
}

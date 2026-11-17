import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_STALL_MINUTES } from "../config/pipeline.ts";
import { classify } from "../ledger/stage-spans.ts";
import { stateDir } from "../paths.ts";
import type { LifecycleRecord, SessionRecord } from "../schema/records.ts";

/**
 * The people's hands and the silent stops, read from the ledger and the state's own records. Nothing is written, and the
 * same records give the same numbers: every total, lane row and weekly table is made from `handsOf` and `silentOf`.
 *
 * A hand is only a row the ledger holds. Work done outside a lane (a file copied into a worktree, a service stopped, a
 * hotfix commit, a state edited by hand) leaves no row and is not counted; a direct commit has its own column.
 */

/** where a hand falls: the gate (an approval), outside it (anything else a person does), an answer, or no declared kind */
export type HandSide = "inside" | "outside" | "answer" | "unclassified";

export interface HandKindCount {
  side: HandSide;
  /** the event, with the decision of the one event whose decision says what the hand was */
  kind: string;
  count: number;
}

/** one lane's (or the period's) hands: each side's count, and the kinds behind them in the order a person reads them */
export interface MetricsHands {
  inside: number;
  outside: number;
  answer: number;
  unclassified: number;
  /** by side (inside, outside, answer, unclassified), then the most counted first */
  kinds: HandKindCount[];
}

type Attrs = Record<string, unknown>;

interface HandDecl {
  side: Exclude<HandSide, "unclassified">;
  /** whether the row is a person's: the mark this event carries, or true for an event only a person writes */
  human: (a: Attrs, laneAnswered: boolean) => boolean;
  kind?: (a: Attrs) => string;
}

const byUser = (a: Attrs): boolean => a.at_by === "user";
const always = (): boolean => true;
// an approval written before signing was required carries no `signed` attribute and was a person's signature too;
// only an explicit `signed: false` is a machine's row
const signed = (a: Attrs): boolean => a.signed === undefined || a.signed === true;
// a person's approval of the review card writes no mark, and neither do a GO or a decision recorded before `at_by` was
// written; the harness's own pass-through writes `at_by: auto`, the one mark that is not a person's
const notAuto = (a: Attrs): boolean => a.at_by !== "auto";
// `idd ignore` writes its close with no person's mark. The close that follows an approved granularity proposal is the
// same press as that answer (which is already counted inside), so it is not counted again
const closedByPerson = (a: Attrs, laneAnswered: boolean): boolean => a.at_by === "user" || (a.via === "ignore" && !laneAnswered);
// the stall watch writes its own send-back with `by: harness`; a person's has no mark
const notHarness = (a: Attrs): boolean => a.by !== "harness";
// the router marks a batch it answered by itself; a batch with no such mark was answered by a person
const notRouted = (a: Attrs): boolean => typeof a.answered_by !== "string";
// a decision tells the hand apart: continue, accept and hand_fix are not one kind
const withDecision = (a: Attrs): string => `s2_review_resumed:${typeof a.decision === "string" ? a.decision : "?"}`;

/**
 * The one line between inside and outside, and every kind it knows. Inside is an approval the system leaves to a
 * person: the GO, the signature, a budget extension, the answer to a granularity proposal. Outside is every other hand,
 * the repairs (a send-back, a replan, an answer to a stop, a message, a resume, a hand fix). An answer to a question is
 * kept apart, because the machine cannot tell whether a question could have been led away. The confirmation of a
 * Purpose and its Choices rides on the GO's one row and is not a hand of its own.
 *
 * Each kind reads its own mark (`at_by`, `signed`, the harness's `by`, the router's `answered_by`). A GO or a decision
 * with no `at_by` (the form before it was written) is a person's too; only `at_by: auto` is the machine's. An event that
 * carries no mark (`s2_interjection`, `s3_reject`, `pending_review_resolved`, the granularity answer) is declared here
 * as one a person writes.
 */
const HANDS = new Map<string, HandDecl>();
const declare = (side: HandDecl["side"], human: HandDecl["human"], events: string[], kind?: HandDecl["kind"]): void => {
  for (const event of events) HANDS.set(event, { side, human, ...(kind ? { kind } : {}) });
};
declare("inside", notAuto, ["s1_go", "s3_ok"]);
declare("inside", always, ["s4_push_approved", "s1_granularity_answered"]);
declare("inside", byUser, ["lane_budget_extended"]);
declare("inside", signed, ["s4_land_approved"]);
declare("outside", byUser, [
  "s1_revise_requested", "s1_replan_requested", "s2_hand_fixed", "lane_stall_resumed", "s0_requeue_go",
  "s3_r2_recorded", "s3_r2_not_recorded", "s3_followups_written", "s3_followups_not_written",
]);
declare("outside", notAuto, ["s2_review_resumed"], withDecision);
declare("outside", closedByPerson, ["lane_close"]);
// `lane_abort` is what a card's abort wrote before `idd ignore` closed a lane by itself: a person's press with no mark
declare("outside", always, ["s2_interjection", "s3_reject", "pending_review_resolved", "s1_defer", "s3_defer", "lane_abort"]);
declare("outside", notHarness, ["s4_verify_user_judgment_answered"]);
declare("answer", notRouted, ["question_batch_answered"]);

/** the events the table above names, for a check that every event the timeline calls a person's is read here or left out on purpose */
export const HAND_EVENTS: readonly string[] = [...HANDS.keys()];

/** the marks a person leaves on a row of a kind this table does not know (`s3_ok`'s `at_by: auto` is not one) */
const humanMarked = (a: Attrs): boolean => a.at_by === "user" || a.signed === true || a.elevated_by === "user";

const SIDE_ORDER: Record<HandSide, number> = { inside: 0, outside: 1, answer: 2, unclassified: 3 };

/** the side and kind of a row when it is a person's hand; null when it is not */
function handOf(e: LifecycleRecord, laneAnswered: boolean): { side: HandSide; kind: string } | null {
  const attrs = e.attrs ?? {};
  const decl = HANDS.get(e.event);
  if (decl) return decl.human(attrs, laneAnswered) ? { side: decl.side, kind: decl.kind ? decl.kind(attrs) : e.event } : null;
  return humanMarked(attrs) ? { side: "unclassified", kind: e.event } : null;
}

/** the hands in a list of kind counts, folded by side */
function foldKinds(kinds: HandKindCount[]): MetricsHands {
  const merged = new Map<string, HandKindCount>();
  for (const k of kinds) {
    const key = `${k.side}\u0000${k.kind}`;
    const seen = merged.get(key);
    if (seen) seen.count += k.count;
    else merged.set(key, { ...k });
  }
  const sorted = [...merged.values()].sort((a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || b.count - a.count || a.kind.localeCompare(b.kind));
  const sum = (side: HandSide) => sorted.filter((k) => k.side === side).reduce((a, k) => a + k.count, 0);
  return { inside: sum("inside"), outside: sum("outside"), answer: sum("answer"), unclassified: sum("unclassified"), kinds: sorted };
}

/** a lane's hands: every row that is a person's, counted once under the kind it is */
export function handsOf(events: LifecycleRecord[]): MetricsHands {
  const kinds: HandKindCount[] = [];
  let laneAnswered = false;
  for (const e of events) {
    if (e.event === "s1_granularity_answered" && e.attrs?.decision === "approve") laneAnswered = true;
    const hand = handOf(e, laneAnswered);
    if (hand) kinds.push({ ...hand, count: 1 });
  }
  return foldKinds(kinds);
}

/** the period's hands: the lanes' kinds added up, so the total and the rows come from the same reading */
export function addHands(lanes: MetricsHands[]): MetricsHands {
  return foldKinds(lanes.flatMap((h) => h.kinds));
}

/** the minutes a lane stood still when nothing was waiting on a person and nothing was known to be running */
export interface MetricsSilent {
  minutes: number;
  /** the stops, after the overlapping ones are joined */
  spans: number;
  /** how many of those stops the stall watch recorded (the rest nobody picked up) */
  from_watch: number;
}

/** the minutes a lane's gap must last to be a stop when the lane's own copy of the setting says none (0 turns the watch off) */
export function stopThresholdMinutes(open: LifecycleRecord | undefined): number {
  const watch = (open?.attrs?.pipeline as { pipeline?: { stall_watch?: { stall_minutes?: unknown } } } | undefined)?.pipeline?.stall_watch;
  const set = watch?.stall_minutes;
  return typeof set === "number" && Number.isFinite(set) && set > 0 ? set : DEFAULT_STALL_MINUTES;
}

/** the stall watch's records: each marks part of one stop */
const WATCH_EVENTS: readonly string[] = ["lane_stall_detected", "lane_stall_instructed", "lane_stalled"];
// the rows after which a lane is over: nothing is running or waiting past one, so no stop starts there
const CLOSE_EVENTS: readonly string[] = ["lane_close", "s1_defer", "s3_defer", "lane_abort", "lane_drop"];

interface Interval {
  from: number;
  to: number;
  watch?: true;
}

const MINUTE = 60_000;

/** the part of [from, to] that no interval of `busy` covers, as intervals */
function without(from: number, to: number, busy: Interval[]): Interval[] {
  const out: Interval[] = [];
  let at = from;
  for (const b of [...busy].sort((x, y) => x.from - y.from)) {
    if (b.to <= at) continue;
    if (b.from >= to) break;
    if (b.from > at) out.push({ from: at, to: b.from });
    at = Math.max(at, b.to);
    if (at >= to) break;
  }
  if (at < to) out.push({ from: at, to });
  return out;
}

/** a run's window from its own record; null when the record is gone (a run's directory is kept for 7 days) or unreadable */
function runWindow(id: string): { from: number; to?: number } | null {
  try {
    const rec = JSON.parse(readFileSync(join(stateDir(), "lanes", id, "lane.json"), "utf8")) as { started_at?: unknown; ended_at?: unknown; attempts?: unknown };
    const attempts = Array.isArray(rec.attempts) ? (rec.attempts as Attrs[]) : [];
    const time = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);
    const from = [rec.started_at, attempts[0]?.started_at].map(time).find((t) => !Number.isNaN(t));
    if (from === undefined) return null;
    const to = [rec.ended_at, attempts.at(-1)?.ended_at].map(time).find((t) => !Number.isNaN(t));
    return { from, ...(to === undefined ? {} : { to }) };
  } catch {
    return null;
  }
}

export interface SilentInput {
  events: LifecycleRecord[];
  /** the lane's sessions, planner's and executor's together (a session's record has a start and no end) */
  sessions: SessionRecord[];
  /** the ad-hoc runs the lane's events name */
  runIds: string[];
  /** the landing checks that ran for the lane (its rounds and the newest run's record): a check with no end is running */
  landChecks: { started_at: string; ended_at?: string }[];
  /** the ledger's newest time: where a lane still open is read up to */
  now: number;
  /** the stall watch's minutes when the lane opened; a gap shorter than this is no stop */
  thresholdMinutes: number;
  /** the landing approval, handed in as the stage cut asks (the overlay is not read from here) */
  landApproved: (events: LifecycleRecord[]) => unknown;
}

/**
 * Where something was known to run for the lane: a session from its start to the next session's start (to the lane's
 * close, or the ledger's last row, when there is no next one: its end is not recorded), and a run from its start to its
 * end. A landing check counts as a run from its start to its end (to the lane's end while it has none). A run whose record
 * is gone is not read as running, so a stop it would have covered stays a stop.
 */
function busyOf(input: SilentInput, laneEnd: number): Interval[] {
  const starts = input.sessions.map((s) => Date.parse(s.started_at)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  const busy: Interval[] = starts.map((from, i) => ({ from, to: starts[i + 1] ?? laneEnd }));
  for (const id of input.runIds) {
    const w = runWindow(id);
    if (w) busy.push({ from: w.from, to: w.to ?? laneEnd });
  }
  for (const c of input.landChecks) {
    const from = Date.parse(c.started_at);
    const to = c.ended_at === undefined ? laneEnd : Date.parse(c.ended_at);
    if (!Number.isNaN(from) && !Number.isNaN(to)) busy.push({ from, to });
  }
  return busy;
}

/**
 * The stops of the gaps between two rows: a gap the stage cut calls neither a gate nor a wait, with the time something
 * ran taken out; what is left counts whole when it is the watch's minutes or longer (the threshold is not subtracted).
 */
function gapStops(input: SilentInput, busy: Interval[], laneEnd: number): Interval[] {
  const { events } = input;
  const stops: Interval[] = [];
  for (const [i, row] of events.entries()) {
    if (CLOSE_EVENTS.includes(row.event)) continue;
    const from = Date.parse(row.at);
    const to = i + 1 < events.length ? Date.parse(events[i + 1].at) : laneEnd;
    if (Number.isNaN(from) || Number.isNaN(to) || to - from < input.thresholdMinutes * MINUTE) continue;
    // the cut is the record's alone, so the same rows give the same cut whenever they are read
    const point = classify(events.slice(0, i + 1), { landApproved: input.landApproved, quota: "record" });
    if (point.kind !== "stage") continue;
    stops.push(...without(from, to, busy).filter((s) => s.to - s.from >= input.thresholdMinutes * MINUTE));
  }
  return stops;
}

/**
 * The stop one stall-watch record marks: from its `since`, else from the row before the send-back the watch wrote just
 * ahead of it, to its own time. A `since` that does not read makes no stop.
 */
function watchStops(events: LifecycleRecord[]): Interval[] {
  const stops: Interval[] = [];
  for (const [i, e] of events.entries()) {
    if (!WATCH_EVENTS.includes(e.event)) continue;
    const to = Date.parse(e.at);
    let from: number;
    if (e.attrs?.since !== undefined) {
      from = typeof e.attrs.since === "string" ? Date.parse(e.attrs.since) : Number.NaN;
    } else {
      let j = i - 1;
      while (j >= 0 && events[j].event === "s4_verify_user_judgment_answered" && events[j].attrs?.by === "harness") j -= 1;
      from = j >= 0 ? Date.parse(events[j].at) : Number.NaN;
    }
    if (!Number.isNaN(from) && !Number.isNaN(to) && from < to) stops.push({ from, to, watch: true });
  }
  return stops;
}

/**
 * A lane's silent stops: the stage cut's stage gaps of the watch's minutes or longer with the running time taken out,
 * and the stops the watch itself recorded. Where the two overlap the time is counted once, and the count is of the
 * stops after they are joined.
 */
export function silentOf(input: SilentInput): MetricsSilent {
  const closed = input.events.find((e) => CLOSE_EVENTS.includes(e.event));
  const last = input.events.reduce((a, e) => Math.max(a, Date.parse(e.at) || 0), 0);
  // a lane that is closed is read to its close; one still open to the ledger's last row (its session's end is not there)
  const laneEnd = closed ? Date.parse(closed.at) : Math.max(input.now, last);
  const all = [...gapStops(input, busyOf(input, laneEnd), laneEnd), ...watchStops(input.events)].sort((a, b) => a.from - b.from);
  const joined: Interval[] = [];
  for (const s of all) {
    const cur = joined.at(-1);
    if (cur && s.from < cur.to) {
      cur.to = Math.max(cur.to, s.to);
      if (s.watch) cur.watch = true;
    } else joined.push({ ...s });
  }
  return {
    minutes: joined.reduce((a, s) => a + (s.to - s.from) / MINUTE, 0),
    spans: joined.length,
    from_watch: joined.filter((s) => s.watch).length,
  };
}

/**
 * a lane's plan review: one entry per `s1_plan_review_done` row, in the order they ran. An entry is the must that round
 * found, or null when the round failed (its must was never read, so it is not a must of 0).
 */
export interface MetricsPlanReview {
  rounds: number;
  must: (number | null)[];
}

export function planReviewOf(events: LifecycleRecord[]): MetricsPlanReview {
  const must = events
    .filter((e) => e.event === "s1_plan_review_done")
    .map((e) => (e.attrs?.failed ? null : Number(e.attrs?.must ?? 0) || 0));
  return { rounds: must.length, must };
}

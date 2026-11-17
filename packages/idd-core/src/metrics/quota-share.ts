import { laneSessions, SUBSCRIPTION_HARNESS } from "../plan/budget.ts";
import type { ReviewLaneRecord } from "../review-lane/state.ts";
import type { LifecycleRecord, SessionRecord } from "../schema/records.ts";
import type { MetricsConsumptionRow } from "./build.ts";

/**
 * How much of the Claude subscription (the one account's windows) the period's records say propter used, cut by lane,
 * by role and model, and by stage. What is read is only propter's own consumption rows: the share is a ratio of what
 * propter recorded, never a share of the window itself, which also holds penne's own conversations and is not recorded.
 *
 * The weight of one row is not given: the subscription's limit is not published, so how a cache read counts is a
 * choice. Both ends are kept on every row (the recorded price, and every token counted alike), and neither is the
 * "real" one.
 */

/** what one row of the share adds up: the four token kinds and the recorded price (USD, the API equivalent) */
export interface QuotaShareTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

/** one row's part of the period's Claude consumption, under each of the two weights (0..1) */
export interface QuotaShare {
  /** the recorded price's ratio: this row's USD over the period's */
  price: number;
  /** every token (input, output, cache read, cache write) counted alike: this row's tokens over the period's */
  tokens: number;
}

export interface QuotaShareRow {
  /** what the row is keyed by: a lane id, `role / model`, or a stage name; "" for the one row that could not be told */
  key: string;
  /** the row's name as it is written */
  label: string;
  /** the lane's title, on the lane cut only */
  title?: string;
  /** true on the one row of a cut that gathers what the records cannot place */
  unplaced?: true;
  units: number;
  tokens: QuotaShareTokens;
  share: QuotaShare;
}

/** the three cuts of the same consumption; each cut's shares add up to 1 under both weights */
export interface QuotaShareCuts {
  lanes: QuotaShareRow[];
  roles: QuotaShareRow[];
  stages: QuotaShareRow[];
}

/** the rise of one window of the subscription, read from the observations the runs left (by the lane's side) */
export interface QuotaWindowPeak {
  /** the window the observations belong to: when it started and when it resets (ISO) */
  start: string;
  end: string;
  /** the first and the last observation of the period in the window */
  first_at: string;
  last_at: string;
  from: number;
  to: number;
  /** `to` minus `from` (utilization, 0..1) */
  rise: number;
  observations: number;
}

export interface QuotaWindowReading {
  /** the window's name as Claude Code reports it: five_hour, seven_day */
  window: string;
  label: string;
  /** every observation of the period that carries the window */
  observations: number;
  /** observations with no reset time: they cannot be placed in a window and are not in `peak` */
  unplaced: number;
  /** the window that rose the most; absent when the period has no observation of this window */
  peak?: QuotaWindowPeak;
}

/** the windows' readings, handed over by the lane's side; the core reads no observation file and cuts no window */
export interface QuotaWindows {
  windows: QuotaWindowReading[];
}

export interface MetricsQuotaShare {
  /** the period's Claude rows the share is read from; 0 says there was nothing to cut, not that every share is 0 */
  rows: number;
  total: QuotaShareTokens;
  cuts: QuotaShareCuts;
  /** the observations of the windows; absent when the caller did not hand any over (it is not read here) */
  windows?: QuotaWindows;
}

/** one consumption row as the share reads it: the row the metrics already take */
export type QuotaShareRowInput = MetricsConsumptionRow;

export const UNPLACED_LANE = "lane に結べない消費";
export const UNPLACED_STAGE = "段の記録なし";

const REVIEW_FAMILY = ["s2_review_", "s2_triage_", "s2_map_", "s2_confirm_", "s2_device_"];
/** a PR review lane's history names its runs with these; it has no final review, so they are all a round's */
const PR_REVIEW_FAMILY = ["r_map_", "r_blind_", "r_triage_", "r_confirm_"];

/**
 * The stage the lifecycle's event that started a run names. The role does not say: a blind reviewer runs in every
 * round and in the last review, and a planner plans and plans the fix. An event this table does not know places
 * nothing, so a run it names is "not on record" like a run no event names.
 */
export function stageOfEvent(event: string, attrs: Record<string, unknown> | undefined): string | undefined {
  if (event.startsWith("s1_plan_review_")) return "計画の査読";
  if (event.startsWith("fix_plan_")) return "直しの計画";
  if (event.startsWith("s2_shape_")) return "形の判断";
  if (event.startsWith("s3_r2_")) return "検査の再確認";
  if (REVIEW_FAMILY.some((p) => event.startsWith(p))) return attrs?.kind === "final" ? "最後のレビュー" : "巡のレビュー";
  if (PR_REVIEW_FAMILY.some((p) => event.startsWith(p))) return "巡のレビュー";
  return undefined;
}

/** a PR review lane's history in the lifecycle's shape, so one table of runs reads both (the lane's id is the REV id) */
function reviewLaneEvents(lanes: ReviewLaneRecord[]): LifecycleRecord[] {
  return lanes.flatMap((rec) => (rec.history ?? []).map((h) => ({ idd_id: rec.id, event: h.event, at: h.at, attrs: h.attrs }) as LifecycleRecord));
}

/** the run id → the lane and the stage the lifecycle's records give it, the first record that names the run deciding */
export function runsOfLifecycle(lifecycle: LifecycleRecord[]): Map<string, { lane: string; stage?: string }> {
  const runs = new Map<string, { lane: string; stage?: string }>();
  for (const e of lifecycle) {
    const a = e.attrs ?? {};
    const ids = [
      ...(typeof a.run_id === "string" && a.run_id ? [a.run_id] : []),
      ...(Array.isArray(a.run_ids) ? a.run_ids.filter((id): id is string => typeof id === "string" && id !== "") : []),
    ];
    const stage = stageOfEvent(e.event, a);
    for (const id of ids) {
      const seen = runs.get(id);
      if (!seen) runs.set(id, { lane: e.idd_id, ...(stage ? { stage } : {}) });
      else if (!seen.stage && stage) seen.stage = stage;
    }
  }
  return runs;
}

/**
 * The stage a conversation's session ran: the planner's, the executor's, or a fix round's, the labels the budget's
 * reader puts on the same sessions (one executor session per fix round, the first being the lane's own). A reply's row
 * names the conversation's lane, not the session, so each session is also keyed by the lane the caller says it ran in.
 */
function sessionStages(planner: SessionRecord[], executor: SessionRecord[], laneOf: (sessionId: string) => string | null): Map<string, string> {
  const stages = new Map<string, string>();
  for (const { label, id } of laneSessions(planner, executor)) {
    stages.set(id, label);
    const lane = laneOf(id);
    if (lane) stages.set(lane, label);
  }
  return stages;
}

const emptyTokens = (): QuotaShareTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 });

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const tokenSum = (t: QuotaShareTokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/** whether a row is the subscription's: the contract names it, and a row without one is read by its harness */
export function isSubscriptionRow(row: { contract?: string; harness?: string }): boolean {
  return (row.contract || row.harness) === SUBSCRIPTION_HARNESS;
}

interface Bucket {
  key: string;
  label: string;
  title?: string;
  unplaced?: true;
  units: number;
  tokens: QuotaShareTokens;
}

function cutOf(buckets: Map<string, Bucket>, total: QuotaShareTokens): QuotaShareRow[] {
  const price = total.usd;
  const tokens = tokenSum(total);
  return [...buckets.values()]
    // the unplaced row is last whatever its size: the placed rows read first, and what could not be placed stays at the foot
    .sort((a, b) => Number(a.unplaced === true) - Number(b.unplaced === true) || b.tokens.usd - a.tokens.usd || a.key.localeCompare(b.key))
    .map((b) => ({
      key: b.key,
      label: b.label,
      ...(b.title === undefined ? {} : { title: b.title }),
      ...(b.unplaced ? { unplaced: true as const } : {}),
      units: b.units,
      tokens: b.tokens,
      share: { price: price > 0 ? b.tokens.usd / price : 0, tokens: tokens > 0 ? tokenSum(b.tokens) / tokens : 0 },
    }));
}

export interface QuotaShareInput {
  /** the consumption rows; only the subscription's rows inside the period are read */
  rows: QuotaShareRowInput[];
  /** the period, JST days (inclusive); a row is cut by its own time, not by the day its lane opened */
  inPeriod: (at: string) => boolean;
  lifecycle: LifecycleRecord[];
  /** the PR review lanes, whose history names the runs they started; read only when a row is in the period */
  reviewLanes: () => ReviewLaneRecord[];
  /** the sessions the budget's reader knows, read only when a conversation's row is in the period */
  sessions: () => { planner: SessionRecord[]; executor: SessionRecord[] };
  /** the lane a conversation's session ran in (the lane's side knows it); a row of a reply names that lane */
  conversationLaneOf: (sessionId: string) => string | null;
  titleOf: (iddId: string) => string | undefined;
  windows?: QuotaWindows;
}

/**
 * The period's subscription consumption cut three ways. A row is placed by the record that made it: a conversation's
 * row names its lane, a stage's run is found in the lifecycle by its id (the row carries no lane of its own), and the
 * stage comes from the event that started the run or the session the conversation was. What no record places is one
 * row of its own in the cut, never given by guess (a role's name does not say a stage, nor a lane).
 */
export function buildQuotaShare(input: QuotaShareInput): MetricsQuotaShare {
  const used = input.rows.filter((r) => isSubscriptionRow(r) && typeof r.at === "string" && input.inPeriod(r.at));
  const total = emptyTokens();
  const lanes = new Map<string, Bucket>();
  const roles = new Map<string, Bucket>();
  const stages = new Map<string, Bucket>();
  if (used.length) {
    const reviews = input.reviewLanes();
    const runs = runsOfLifecycle([...input.lifecycle, ...reviewLaneEvents(reviews)]);
    const reviewTitles = new Map(reviews.map((r) => [r.id, r.title]));
    const titleOf = (id: string): string | undefined => input.titleOf(id) ?? reviewTitles.get(id);
    const sessions = input.sessions();
    const sessionStage = sessionStages(sessions.planner, sessions.executor, input.conversationLaneOf);
    const add = (map: Map<string, Bucket>, key: string, make: () => Omit<Bucket, "key" | "units" | "tokens">, row: QuotaShareTokens): void => {
      const cur = map.get(key) ?? { key, ...make(), units: 0, tokens: emptyTokens() };
      cur.units += 1;
      for (const k of ["input", "output", "cacheRead", "cacheWrite", "usd"] as const) cur.tokens[k] += row[k];
      map.set(key, cur);
    };
    for (const r of used) {
      const row: QuotaShareTokens = { input: num(r.input), output: num(r.output), cacheRead: num(r.cache_read), cacheWrite: num(r.cache_write), usd: num(r.cost) };
      for (const k of ["input", "output", "cacheRead", "cacheWrite", "usd"] as const) total[k] += row[k];
      const run = r.lane ? runs.get(r.lane) : undefined;
      const lane = r.idd_id || run?.lane || "";
      const stage = (r.lane ? sessionStage.get(r.lane) : undefined) ?? run?.stage ?? "";
      const role = r.role?.trim() || "unknown";
      const model = r.model_name?.trim() || r.model?.trim() || "";
      add(lanes, lane, () => (lane ? { label: lane, ...(titleOf(lane) === undefined ? {} : { title: titleOf(lane) }) } : { label: UNPLACED_LANE, unplaced: true }), row);
      add(roles, `${role}\u0000${model}`, () => ({ label: model ? `${role} / ${model}` : role }), row);
      add(stages, stage, () => (stage ? { label: stage } : { label: UNPLACED_STAGE, unplaced: true }), row);
    }
  }
  return {
    rows: used.length,
    total,
    cuts: { lanes: cutOf(lanes, total), roles: cutOf(roles, total), stages: cutOf(stages, total) },
    ...(input.windows ? { windows: input.windows } : {}),
  };
}

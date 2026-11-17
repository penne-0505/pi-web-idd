import { laneCost, laneRunIds, type CostPart } from "../plan/budget.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { stageSpans, type GateKey, type StageKey, type WaitKey } from "../ledger/stage-spans.ts";
import { currentLandApproval } from "../overlay/land.ts";
import { listLandRounds, listLandRuns, type LandRoundRecord } from "../overlay/land-run.ts";
import { readAreas } from "../config/areas.ts";
import { pipelineSettings, type PipelineSettings } from "../config/pipeline.ts";
import { attempt } from "../overlay/git.ts";
import { STRUCTURE_ROW_PREFIX } from "../overlay/structure.ts";
import type { BacklogRecord, LifecycleRecord, SessionRecord } from "../schema/records.ts";
import { canaryWindows, type CanaryRoleRecord, type CanaryStructureVerdict } from "../canary/record.ts";
import { leaksOf, type LandedLane, type MetricsLeakArea } from "./leaks.ts";
import { addHands, handsOf, planReviewOf, silentOf, stopThresholdMinutes, type MetricsHands, type MetricsPlanReview, type MetricsSilent } from "./hands.ts";
import { laneRunIdList } from "../agent/stop.ts";
import { listReviewLanes } from "../review-lane/store.ts";
import type { ReviewLaneRecord } from "../review-lane/state.ts";
import { buildQuotaShare, type MetricsQuotaShare, type QuotaWindows } from "./quota-share.ts";
import { buildReviewNet, type MetricsNet } from "./net.ts";

/**
 * The period's numbers, read from the records that already hold them: the ledger (a lane's events), the landing
 * rounds (what each landing check found and cost), the backlog (which lane is which), git (the direct commits on the
 * work side's mainline) and the budget's own reader (what a lane cost). Nothing is written, and the same records give
 * the same numbers whoever asks.
 *
 * The lanes are grouped by the pipeline copy their `lane_open` carries: a lane opened before the copy existed has
 * none, and is read as "no record" instead of being given one after the fact.
 */

/** one part of a lane's money: what the budget counts, or the subscription's API equivalent */
export interface MetricsTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

export interface MetricsRole {
  role: string;
  /** the model the run used: the model definition's name, or the call target when there is none */
  model?: string;
  usd: number;
  tokens: MetricsTokens;
}

/** a lane's time, cut into the three kinds one interval belongs to exactly one of (the same cut as the forecast) */
export interface MetricsTimeSplit {
  /** minutes on the machine's stages */
  stage: number;
  /** minutes at a gate a person decides */
  gate: number;
  /** minutes waiting on the machine (order, dependency, outside, quota, slot) */
  wait: number;
}

export interface MetricsLane {
  iddId: string;
  area: string;
  title: string;
  opened_at: string;
  closed_at?: string;
  /** the key of the pipeline copy the lane opened under; "" when the lane has none */
  settings_key: string;
  cost: {
    /** what the budget counts (API spend), the same reading the budget's stop uses */
    budget: number;
    /** the Claude Code spend (subscription, API equivalent), kept out of the budget */
    subscription: number;
    /** the budget spend per 1,000 lines the lane landed; absent when the lane landed nothing */
    per_1000_lines?: number;
    roles: MetricsRole[];
    /** the parts the budget's reader reported, kept so a number in the table can be traced */
    parts: CostPart[];
  };
  time: MetricsTimeSplit;
  stages: Partial<Record<StageKey, number>>;
  gates: Partial<Record<GateKey, number>>;
  waits: Partial<Record<WaitKey, number>>;
  checks: {
    /** landing-check rounds recorded in the period */
    rounds: number;
    /** rounds whose typecheck failed */
    typecheck_failures: number;
    /** the newest round's count in the merge commit, and its increase over the mainline */
    eslint_warnings?: number;
    eslint_delta?: number;
    /** the earlier mainline tip the count was really measured at, when the newest round took it over (C-193-4) */
    eslint_at?: string;
    wall_seconds: number;
    cpu_seconds?: number;
  };
  /** lines the landed merges changed (added + deleted) */
  landed_lines?: number;
  /** the amounts of the granularity work: proposed, split, fixes sent, escalations, landings signed */
  granularity: { proposed: number; split: number; fix_sent: number; escalated: number; signed: number };
  /** how often the lane was sent back after the executor's result (a judgement of revise) */
  sent_back: number;
  /** the people's hands the ledger holds, by side and kind (what no row records is not here) */
  hands: MetricsHands;
  /** the minutes the lane stood still with no one waited on and nothing known to run */
  silent: MetricsSilent;
  /** the plan review's rounds and each round's must */
  plan_review: MetricsPlanReview;
}

export interface MetricsGroup {
  /** the settings key, or "none" for the lanes whose `lane_open` carries no copy */
  settings_key: string;
  /** the copy itself, absent for the none group */
  settings?: PipelineSettings;
  lanes: string[];
  cost: { budget: number; subscription: number; per_1000_lines?: number };
  time: MetricsTimeSplit;
  /** the same split, averaged over the group's lanes */
  time_mean: MetricsTimeSplit;
  checks: { rounds: number; typecheck_failures: number; wall_seconds: number; cpu_seconds: number };
  landed_lines: number;
}

/** one test that failed in a round and passed in a later round at the same head: a candidate for an issue */
export interface MetricsFlaky {
  lane: string;
  check: string;
  test: string;
  /** how many rounds of this lane failed on it at a head a later round passed at */
  count: number;
}

/** one role's answer to one question on one day: what the week's table compares */
export interface CanaryTaskValue {
  role: string;
  model: string;
  task: string;
  kind: string;
  structure: CanaryStructureVerdict;
  chars: number;
  /** the runner's whole run for the question: seconds in the table, never the model's own reply time */
  total_ms: number;
  usd: number;
  day: string;
  error?: string;
}

/** one row of the canary's table: the period's value beside the same role's and question's value of the period before */
export interface CanaryRow {
  role: string;
  model: string;
  task: string;
  kind: string;
  current: CanaryTaskValue;
  previous?: CanaryTaskValue;
  /** the current value over the previous one, for the two numbers a change is read from */
  ratio: { chars?: number; total_ms?: number };
  /** what the row's own values make worth a look: a failed shape, or a length or a time twice the last period's */
  marks: { structure: boolean; chars: boolean; total_ms: boolean };
}

/**
 * The canary's reading of a period. It is a reading of its own, kept out of the lanes' cost and totals: the canary is
 * the harness watching its models, not a lane's work, and mixing the two wallets would change what a lane's numbers
 * mean.
 */
export interface CanaryView {
  since: string;
  until: string;
  /** the same number of days immediately before the period, which the rows are compared with */
  previous: { since: string; until: string };
  rows: CanaryRow[];
}

/** a value 2 times the other either way: the size of a change the week's table marks */
export const CANARY_MARK_RATIO = 2;

/** whether one value stands at 2 times the other or more, either up or down; no comparison without a positive other */
function ratioOf(value: number, other: number | undefined): number | undefined {
  if (other === undefined || other <= 0) return undefined;
  return value / other;
}

function marked(ratio: number | undefined): boolean {
  return ratio !== undefined && (ratio >= CANARY_MARK_RATIO || ratio <= 1 / CANARY_MARK_RATIO);
}

/**
 * The canary's rows for a period, from the records of the period and the same number of days before it. The newest
 * day's answer of a role and a question is the one compared: a role's record is written once a day, so a day has one.
 * A row is only drawn for a value the period itself has; a role measured before and not now is not shown as zero.
 */
export function buildCanaryView(records: readonly CanaryRoleRecord[], opts: { since: string; until: string }): CanaryView {
  const windows = canaryWindows(opts.since, opts.until);
  const current = new Map<string, CanaryTaskValue>();
  const previous = new Map<string, CanaryTaskValue>();
  // the records come in day order, so a later day's answer replaces the day before's: the newest day is the row's value
  for (const record of [...records].sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""))) {
    const intoCurrent = record.day >= opts.since && record.day <= opts.until;
    const intoPrevious = windows.previous.includes(record.day);
    if (!intoCurrent && !intoPrevious) continue;
    for (const task of record.tasks) {
      const key = `${record.role}\u0000${record.model_name ?? record.model}\u0000${task.id}`;
      const value: CanaryTaskValue = {
        role: record.role,
        model: record.model,
        task: task.id,
        kind: task.kind,
        structure: task.structure,
        chars: Number(task.chars ?? 0) || 0,
        total_ms: Number(task.total_ms ?? 0) || 0,
        usd: Number(task.usd ?? 0) || 0,
        day: record.day,
        ...(task.error ? { error: task.error } : {}),
      };
      (intoCurrent ? current : previous).set(key, value);
    }
  }
  const rows: CanaryRow[] = [];
  for (const [key, value] of current) {
    const before = previous.get(key);
    const charRatio = ratioOf(value.chars, before?.chars);
    const timeRatio = ratioOf(value.total_ms, before?.total_ms);
    rows.push({
      role: value.role,
      model: value.model,
      task: value.task,
      kind: value.kind,
      current: value,
      ...(before ? { previous: before } : {}),
      ratio: {
        ...(charRatio === undefined ? {} : { chars: charRatio }),
        ...(timeRatio === undefined ? {} : { total_ms: timeRatio }),
      },
      marks: { structure: value.structure === "fail", chars: marked(charRatio), total_ms: marked(timeRatio) },
    });
  }
  rows.sort((a, b) => a.role.localeCompare(b.role) || a.task.localeCompare(b.task));
  return {
    since: opts.since,
    until: opts.until,
    previous: { since: windows.previousSince, until: windows.previousUntil },
    rows,
  };
}

export interface MetricsView {
  since: string;
  until: string;
  lanes: MetricsLane[];
  groups: MetricsGroup[];
  /** the flaky checks, by lane and test: the table's candidates for an issue (nothing is filed by the machine) */
  flaky: MetricsFlaky[];
  /** the work side's mainline commits that are neither a merge nor another lane's merge, per repo */
  direct_commits: { area: string; repo: string; commits: number | null }[];
  /** the canary's values for the period beside the period before it (its cost is not in the lanes' totals) */
  canary: CanaryView;
  /** what the review net caught and let through, cut by the time of each judgement and each fix (not by `lane_open`) */
  net: MetricsNet;
  /**
   * The Claude subscription's consumption of the period cut by lane, by role and model, and by stage. It is cut by each
   * row's own time, so its lanes are not `lanes` above (those are the lanes opened in the period) and `lanes` is not
   * changed by it.
   */
  quota: MetricsQuotaShare;
  totals: {
    lanes: number;
    cost: { budget: number; subscription: number; per_1000_lines?: number };
    time: MetricsTimeSplit;
    checks: { rounds: number; typecheck_failures: number; wall_seconds: number; cpu_seconds: number };
    landed_lines: number;
    granularity: MetricsLane["granularity"];
    sent_back: number;
    hands: MetricsHands;
    silent: MetricsSilent;
  };
}

/** where and when a call was made, and under which contract (claude for the subscription) */
export interface MetricsConsumptionOrigin {
  /** when the call ended (ISO) */
  at?: string;
  /** attempt: a stage's run; reply: a conversation's answer */
  unit?: string;
  contract?: string;
  harness?: string;
}

/** one consumption row, as the engine reads it: the tokens a lane's roles used (kept out of core's imports) */
export interface MetricsConsumptionRow extends MetricsConsumptionOrigin {
  idd_id?: string;
  lane?: string;
  role?: string;
  /** the model definition the run used; the call target when there is none */
  model?: string;
  /** the model definition's name, when the row names one */
  model_name?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cost?: number;
}

export interface MetricsOptions {
  /** the first day of the period, JST (YYYY-MM-DD); a lane opened on or after it is in the period */
  since: string;
  /** the last day, JST (inclusive); today when left out */
  until?: string;
  /** the consumption rows, when the caller has them: they are the only source of tokens by role */
  consumption?: MetricsConsumptionRow[];
  /** the landing rounds; read from the state when left out */
  rounds?: LandRoundRecord[];
  /** the canary's records, for the period and the period before it; read by the caller that has the state */
  canary?: CanaryRoleRecord[];
  /** what one lane cost; the budget's reader when left out (a process with no agent runner reads 0 for sessions) */
  laneCostOf?: (iddId: string, events: LifecycleRecord[]) => Promise<{ total: number; parts: CostPart[]; subscription: CostPart[] }>;
  lifecycle?: LifecycleRecord[];
  backlog?: BacklogRecord[];
  /** the planner and executor sessions, read from the state when left out (and only when the share has a conversation row) */
  sessions?: { planner: SessionRecord[]; executor: SessionRecord[] };
  /** the PR review lanes, read from the state when left out (and only when the share has a row in the period) */
  reviewLanes?: ReviewLaneRecord[];
  /** the lane a conversation's session ran in, read by the caller (a reply's row names the lane, the session records name the session) */
  conversationLaneOf?: (sessionId: string) => string | null;
  /**
   * The subscription's windows over the period the metrics resolved (JST days, inclusive). The caller that holds the
   * lane's records reads them: the core reads no observation file and cuts no window.
   */
  quotaWindows?: (period: { since: string; until: string }) => QuotaWindows;
  now?: number;
}

/** the JST day of an instant (YYYY-MM-DD); "" when it does not read */
export function jstDayOf(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** the time of the newest record; the machine's clock only when there is no record to read it from */
function latestAt(lifecycle: LifecycleRecord[]): number {
  const times = lifecycle.map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  return times.length ? times.reduce((a, b) => (b > a ? b : a)) : Date.now();
}

/** the JST day now, or at the given instant */
export function todayJst(now = Date.now()): string {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function minutes(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 60000) : 0;
}

/** the three-way split of a lane's intervals; every interval lands in exactly one of the three */
function splitOf(events: LifecycleRecord[], now: number): { time: MetricsTimeSplit; stages: MetricsLane["stages"]; gates: MetricsLane["gates"]; waits: MetricsLane["waits"] } {
  const time: MetricsTimeSplit = { stage: 0, gate: 0, wait: 0 };
  const stages: MetricsLane["stages"] = {};
  const gates: MetricsLane["gates"] = {};
  const waits: MetricsLane["waits"] = {};
  for (const span of stageSpans(events, { landApproved: (evs) => currentLandApproval(evs) }, now)) {
    const m = minutes(span.from, span.to);
    if (span.kind === "stage") {
      time.stage += m;
      if (span.stage) stages[span.stage] = (stages[span.stage] ?? 0) + m;
    } else if (span.kind === "gate") {
      time.gate += m;
      if (span.gate) gates[span.gate] = (gates[span.gate] ?? 0) + m;
    } else if (span.kind === "wait") {
      time.wait += m;
      if (span.wait) waits[span.wait] = (waits[span.wait] ?? 0) + m;
    }
  }
  return { time, stages, gates, waits };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The lines a merge changed, from what the round recorded (added + deleted). A round that ran over the same merge as
 * an earlier one (the same head against the same mainline tip: re-measured after the mainline moved, or run again
 * after a failure) is that merge's lines once; counting each round would grow the landed lines by how often the check
 * was re-run, and shrink the cost per 1,000 lines with it.
 */
function linesOf(rounds: LandRoundRecord[]): number | undefined {
  const byMerge = new Map<string, number>();
  for (const r of rounds) {
    if (typeof r.diff_lines !== "number" || r.status === "stopped") continue;
    const merge = `${r.head}\u0000${r.mainTip}`;
    if (!byMerge.has(merge)) byMerge.set(merge, r.diff_lines);
  }
  if (!byMerge.size) return undefined;
  let total = 0;
  for (const lines of byMerge.values()) total += lines;
  return total;
}

/** the newest round of the rounds given (by end time) */
function newestRound(rounds: LandRoundRecord[]): LandRoundRecord | null {
  return rounds.reduce<LandRoundRecord | null>((a, r) => {
    if (!a) return r;
    return Date.parse(r.ended_at) >= Date.parse(a.ended_at) ? r : a;
  }, null);
}

/** the test names a failed check's detail carries (the test entry's own summary) */
export function failedTestNames(detail: string | undefined): string[] {
  if (!detail) return [];
  const names: string[] = [];
  for (const line of detail.split("\n")) {
    const m = /^\s+- (.+?)\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** the checks that failed in one round and passed in a later round at the same head: the flaky ones */
export function flakyOf(lane: string, rounds: LandRoundRecord[]): MetricsFlaky[] {
  const done = rounds
    .filter((r) => r.status !== "stopped")
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const out: MetricsFlaky[] = [];
  for (const [i, r] of done.entries()) {
    for (const failed of r.checks.filter((c) => c.status === "fail")) {
      const passedLater = done.slice(i + 1).some((later) => later.head === r.head && later.checks.some((c) => c.name === failed.name && c.status === "pass"));
      if (!passedLater) continue;
      const names = failedTestNames(failed.detail);
      if (!names.length) {
        out.push({ lane, check: failed.name, test: "", count: 1 });
        continue;
      }
      for (const test of names) out.push({ lane, check: failed.name, test, count: 1 });
    }
  }
  return out;
}

/** the flaky readings of one lane, folded into counts per check and test */
function foldFlaky(rows: MetricsFlaky[]): MetricsFlaky[] {
  const map = new Map<string, MetricsFlaky>();
  for (const row of rows) {
    const k = `${row.lane}\u0000${row.check}\u0000${row.test}`;
    const seen = map.get(k);
    if (seen) seen.count += row.count;
    else map.set(k, { ...row });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane) || a.check.localeCompare(b.check) || a.test.localeCompare(b.test));
}

/** the amounts of the granularity work, from the events the stage records */
function granularityOf(events: LifecycleRecord[]): MetricsLane["granularity"] {
  const count = (name: string, pred: (e: LifecycleRecord) => boolean = () => true) => events.filter((e) => e.event === name && pred(e)).length;
  const answered = events.filter((e) => e.event === "s1_granularity_answered");
  return {
    proposed: count("s1_granularity_proposed"),
    // a split is an answer whose outcome, decision or kind says the lane was cut (the field the planner writes today
    // is `kind`, an older row may carry `outcome` or `answer`)
    split: answered.filter((e) => [e.attrs?.outcome, e.attrs?.decision, e.attrs?.answer, e.attrs?.kind].some((v) => v === "split")).length,
    fix_sent: count("s2_fix_sent"),
    escalated: count("s2_review_escalated"),
    signed: count("s4_land_approved", (e) => e.attrs?.signed === true),
  };
}

/** how often the lane was sent back after the executor's result (the judgement's revise) */
function sentBackOf(events: LifecycleRecord[]): number {
  return events.filter((e) => e.event === "s4_verify_user_judgment_answered" && e.attrs?.outcome === "revise").length;
}

/** the tokens and dollars each role and model of a lane used, from the consumption rows */
function rolesOf(iddId: string, rows: MetricsConsumptionRow[], runIds: Set<string>): MetricsRole[] {
  const byRole = new Map<string, MetricsRole>();
  for (const row of rows) {
    const mine = row.idd_id ? row.idd_id === iddId : row.lane ? runIds.has(row.lane) : false;
    if (!mine) continue;
    const role = row.role?.trim() || "unknown";
    const model = row.model_name?.trim() || row.model?.trim() || undefined;
    const key = `${role}\u0000${model ?? ""}`;
    const cur = byRole.get(key) ?? { role, ...(model ? { model } : {}), usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 } };
    const usd = Number(row.cost ?? 0) || 0;
    cur.usd += usd;
    cur.tokens.input += Number(row.input ?? 0) || 0;
    cur.tokens.output += Number(row.output ?? 0) || 0;
    cur.tokens.cacheRead += Number(row.cache_read ?? 0) || 0;
    cur.tokens.cacheWrite += Number(row.cache_write ?? 0) || 0;
    cur.tokens.usd += usd;
    byRole.set(key, cur);
  }
  return [...byRole.values()].sort((a, b) => b.usd - a.usd || a.role.localeCompare(b.role) || (a.model ?? "").localeCompare(b.model ?? ""));
}

/** the direct commits on the work side's mainline since a day: neither a merge nor a lane's merge */
function directCommits(cwd: string | undefined, base: string | undefined, since: string): number | null {
  if (!cwd || !base) return null;
  const out = attempt(cwd, ["-c", "log.showSignature=false", "log", "--first-parent", "--no-merges", `--since=${since}T00:00:00+09:00`, "--format=%H", `refs/heads/${base}`, "--"]);
  if (out === null) return null;
  return out.split("\n").map((l) => l.trim()).filter(Boolean).length;
}

/**
 * The lanes that landed on a work side's mainline, by area: the merge each made and the Issue it closed. A lane of a
 * public repo has no `s4_land_merged`; its PR merge is `s4_merged`, which holds no commit, so the head the PR was pushed
 * at stands for it and the merge is solved from git. A lane that has both is read by `s4_land_merged`, and a lane whose
 * `s4_merged` was written several times is one landing.
 */
function landsByArea(lifecycle: LifecycleRecord[], backlog: BacklogRecord[]): Map<string, LandedLane[]> {
  const areaOf = new Map(backlog.map((b) => [b.idd_id, b.area]));
  const issueOf = new Map<string, number>();
  const landed = new Set<string>();
  for (const e of lifecycle) {
    const close = e.event === "s4_land_approved" ? (e.attrs?.close as { issue?: unknown } | undefined) : undefined;
    if (typeof close?.issue === "number") issueOf.set(e.idd_id, close.issue);
    if (e.event === "s4_land_merged" && typeof e.attrs?.merge_commit === "string" && e.attrs.merge_commit) landed.add(e.idd_id);
  }
  const lands = new Map<string, LandedLane[]>();
  const add = (area: string, land: LandedLane) => {
    const list = lands.get(area) ?? [];
    list.push(land);
    lands.set(area, list);
  };
  const perLane = new Map<string, LifecycleRecord[]>();
  for (const e of lifecycle) {
    const merge = e.event === "s4_land_merged" ? e.attrs?.merge_commit : undefined;
    const area = areaOf.get(e.idd_id) ?? (typeof e.attrs?.area === "string" ? e.attrs.area : undefined);
    if (typeof merge === "string" && merge && area) {
      const issue = issueOf.get(e.idd_id);
      add(area, { lane: e.idd_id, merge, ...(issue === undefined ? {} : { issue }) });
    }
    if (!landed.has(e.idd_id) && (e.event === "s4_merged" || e.event === "s4_pushed" || e.event === "s4_pr_created")) {
      perLane.set(e.idd_id, [...(perLane.get(e.idd_id) ?? []), e]);
    }
  }
  for (const [lane, events] of perLane) {
    const mergedAt = events.map((e) => e.event).lastIndexOf("s4_merged");
    const merged = events[mergedAt];
    if (!merged) continue;
    const area = areaOf.get(lane) ?? (typeof merged.attrs?.area === "string" ? merged.attrs.area : undefined);
    if (!area) continue;
    // the commit the PR was last pushed at before it merged: the push, or the PR's own record of its head
    const before = events.slice(0, mergedAt);
    const commitOf = (name: string): string | undefined =>
      before.filter((e) => e.event === name).map((e) => e.attrs?.commit).filter((c): c is string => typeof c === "string" && c !== "").pop();
    const head = commitOf("s4_pushed") ?? commitOf("s4_pr_created");
    const issue = issueOf.get(lane);
    const at = typeof merged.attrs?.merged_at === "string" && !Number.isNaN(Date.parse(merged.attrs.merged_at)) ? merged.attrs.merged_at : merged.at;
    add(area, { lane, at, ...(head === undefined ? {} : { head }), ...(issue === undefined ? {} : { issue }) });
  }
  return lands;
}

function addTime(a: MetricsTimeSplit, b: MetricsTimeSplit): MetricsTimeSplit {
  return { stage: a.stage + b.stage, gate: a.gate + b.gate, wait: a.wait + b.wait };
}

function meanTime(a: MetricsTimeSplit, n: number): MetricsTimeSplit {
  if (!n) return { stage: 0, gate: 0, wait: 0 };
  return { stage: a.stage / n, gate: a.gate / n, wait: a.wait / n };
}

function perThousand(cost: number, lines: number | undefined): number | undefined {
  if (!lines || lines <= 0) return undefined;
  return cost / (lines / 1000);
}

/**
 * The period's numbers. A lane is in the period when its `lane_open` falls on or after `since` and on or before
 * `until`; its events are every event the ledger holds for it, so a lane that opened in the period still shows the
 * work it did after the period's end. The settings copy comes from that same `lane_open`.
 */
export async function buildMetrics(opts: MetricsOptions): Promise<MetricsView> {
  const since = opts.since;
  const lifecycle = opts.lifecycle ?? readLifecycle();
  // the clock is the newest record's time, not the machine's: a lane still open is read up to the last thing the ledger
  // holds about it, so the same records give the same numbers whenever they are read
  const now = opts.now ?? latestAt(lifecycle);
  const until = opts.until ?? todayJst(now);
  const backlog = opts.backlog ?? readBacklog();
  const rounds = opts.rounds ?? listLandRounds();
  const consumption = opts.consumption ?? [];
  const costOf = opts.laneCostOf ?? (async (iddId, events) => laneCost(iddId, events));
  const eventsByLane = new Map<string, LifecycleRecord[]>();
  for (const e of lifecycle) {
    const list = eventsByLane.get(e.idd_id) ?? [];
    list.push(e);
    eventsByLane.set(e.idd_id, list);
  }
  const inPeriod = (lane: string, events: LifecycleRecord[]): boolean => {
    const open = events.find((e) => e.event === "lane_open");
    if (!open) return false;
    const day = jstDayOf(open.at);
    return Boolean(day) && day >= since && day <= until;
  };
  const runIdsOf = (iddId: string, events: LifecycleRecord[]): Set<string> => new Set(laneRunIds(events));
  // a session's record has its start and no end, so the lane's sessions are read once for every lane of the period
  // (the ones the caller handed in when it did: the stops are read from the same records as the quota share)
  const sessionRecords = opts.sessions ?? { planner: readSessions("planner"), executor: readSessions("executor") };
  const sessions = [...sessionRecords.planner, ...sessionRecords.executor];
  // a landing check is something running for the lane: its rounds, and the newest run's record while it has no round yet
  // (a batch's check runs for each lane laid in it)
  const landRuns = listLandRuns();
  const landChecksOf = (iddId: string): { started_at: string; ended_at?: string }[] => [
    ...rounds.filter((r) => r.lane === iddId),
    ...landRuns.filter((r) => r.lane === iddId || r.spec?.batch?.includes(iddId)),
  ];
  const lanes: MetricsLane[] = [];
  const flaky: MetricsFlaky[] = [];
  for (const rec of backlog) {
    const events = eventsByLane.get(rec.idd_id) ?? [];
    if (!events.length || !inPeriod(rec.idd_id, events)) continue;
    const open = events.find((e) => e.event === "lane_open")!;
    const copied = open.attrs?.pipeline as PipelineSettings | undefined;
    const split = splitOf(events, now);
    const laneRounds = rounds.filter((r) => r.lane === rec.idd_id);
    const cost = await costOf(rec.idd_id, events);
    const landed = linesOf(laneRounds);
    const newest = newestRound(laneRounds.filter((r) => r.status !== "stopped"));
    const eslint = newest?.checks.find((c) => typeof c.counts?.merged === "number" && !c.name.startsWith(STRUCTURE_ROW_PREFIX));
    // a count taken over from an earlier mainline tip names the tip it was measured at (C-193-4): the number beside it
    // is a check of that tip's tree, not of the newest round's own
    const eslintAt = eslint?.counts?.at;
    const carried = eslintAt !== undefined && newest !== null && eslintAt !== newest.mainTip;
    const close = events.find((e) => e.event === "lane_close");
    // a round stopped from outside is not a checked round: its time is not the time of a check
    const checked = laneRounds.filter((r) => r.status !== "stopped");
    const checks = {
      rounds: checked.length,
      typecheck_failures: checked.filter((r) => r.checks.some((c) => c.name === "typecheck" && c.status === "fail")).length,
      ...(eslint?.counts?.merged === undefined ? {} : { eslint_warnings: eslint.counts.merged }),
      ...(eslint?.counts?.merged === undefined || eslint.counts.mainline === undefined ? {} : { eslint_delta: eslint.counts.merged - eslint.counts.mainline }),
      ...(carried && eslintAt !== undefined ? { eslint_at: eslintAt } : {}),
      wall_seconds: round(checked.reduce((a, r) => a + r.wall_seconds, 0)),
      ...(checked.some((r) => typeof r.cpu_seconds === "number")
        ? { cpu_seconds: round(checked.reduce((a, r) => a + (r.cpu_seconds ?? 0), 0)) }
        : {}),
    };
    const subscription = cost.subscription.reduce((a, p) => a + p.cost, 0);
    lanes.push({
      iddId: rec.idd_id,
      area: rec.area,
      title: rec.title,
      opened_at: open.at,
      ...(close ? { closed_at: close.at } : {}),
      settings_key: copied?.key ?? "",
      cost: {
        budget: round(cost.total),
        subscription: round(subscription),
        ...(perThousand(cost.total, landed) === undefined ? {} : { per_1000_lines: round(perThousand(cost.total, landed)!) }),
        roles: rolesOf(rec.idd_id, consumption, runIdsOf(rec.idd_id, events)),
        parts: cost.parts.map((p) => ({ label: p.label, cost: round(p.cost) })),
      },
      time: { stage: round(split.time.stage), gate: round(split.time.gate), wait: round(split.time.wait) },
      stages: Object.fromEntries(Object.entries(split.stages).map(([k, v]) => [k, round(v)])),
      gates: Object.fromEntries(Object.entries(split.gates).map(([k, v]) => [k, round(v)])),
      waits: Object.fromEntries(Object.entries(split.waits).map(([k, v]) => [k, round(v)])),
      checks,
      ...(landed === undefined ? {} : { landed_lines: landed }),
      granularity: granularityOf(events),
      sent_back: sentBackOf(events),
      hands: handsOf(events),
      silent: (() => {
        const stop = silentOf({
          events,
          sessions: sessions.filter((s) => s.idd_id === rec.idd_id),
          // the whole-diff runs of a review round ran for the lane as much as the runs it names under `run_ids`
          runIds: laneRunIdList(events),
          landChecks: landChecksOf(rec.idd_id),
          now,
          thresholdMinutes: stopThresholdMinutes(open),
          landApproved: (evs) => currentLandApproval(evs),
        });
        return { ...stop, minutes: round(stop.minutes) };
      })(),
      plan_review: planReviewOf(events),
    });
    flaky.push(...flakyOf(rec.idd_id, laneRounds));
  }
  lanes.sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  // the groups: one per settings copy, and one for the lanes that opened without a copy
  const groups = new Map<string, MetricsGroup>();
  for (const lane of lanes) {
    const k = lane.settings_key || "none";
    const g = groups.get(k) ?? {
      settings_key: k,
      ...(k === "none" ? {} : { settings: settingsFor(k, lifecycle) }),
      lanes: [],
      cost: { budget: 0, subscription: 0 },
      time: { stage: 0, gate: 0, wait: 0 },
      time_mean: { stage: 0, gate: 0, wait: 0 },
      checks: { rounds: 0, typecheck_failures: 0, wall_seconds: 0, cpu_seconds: 0 },
      landed_lines: 0,
    };
    g.lanes.push(lane.iddId);
    g.cost.budget += lane.cost.budget;
    g.cost.subscription += lane.cost.subscription;
    g.time = addTime(g.time, lane.time);
    g.checks.rounds += lane.checks.rounds;
    g.checks.typecheck_failures += lane.checks.typecheck_failures;
    g.checks.wall_seconds = round(g.checks.wall_seconds + lane.checks.wall_seconds);
    g.checks.cpu_seconds = round(g.checks.cpu_seconds + (lane.checks.cpu_seconds ?? 0));
    g.landed_lines += lane.landed_lines ?? 0;
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    g.cost.budget = round(g.cost.budget);
    g.cost.subscription = round(g.cost.subscription);
    const per = perThousand(g.cost.budget, g.landed_lines);
    if (per !== undefined) g.cost.per_1000_lines = round(per);
    g.time = { stage: round(g.time.stage), gate: round(g.time.gate), wait: round(g.time.wait) };
    g.time_mean = meanTime(g.time, g.lanes.length);
    g.time_mean = { stage: round(g.time_mean.stage), gate: round(g.time_mean.gate), wait: round(g.time_mean.wait) };
  }
  const areas = readAreas().areas;
  const direct = Object.entries(areas)
    .filter(([, cfg]) => cfg.local_path && cfg.work_base)
    .map(([area, cfg]) => ({ area, repo: cfg.linked_repo, commits: directCommits(cfg.local_path, cfg.work_base, since) }));
  const inPeriodAt = (at: string): boolean => {
    const day = jstDayOf(at);
    return Boolean(day) && day >= since && day <= until;
  };
  const landed = landsByArea(lifecycle, backlog);
  const leaks: MetricsLeakArea[] = Object.entries(areas)
    .filter(([, cfg]) => cfg.local_path && cfg.work_base)
    .map(([area, cfg]) => {
      const read = leaksOf(cfg.local_path, cfg.work_base, landed.get(area) ?? [], { since, until });
      return { area, repo: cfg.linked_repo, rows: read?.rows ?? null, ...(read?.unresolved ? { unresolved: read.unresolved } : {}) };
    });
  const net: MetricsNet = { ...buildReviewNet(eventsByLane, inPeriodAt), leaks };
  const titles = new Map(backlog.map((b) => [b.idd_id, b.title]));
  const quota = buildQuotaShare({
    rows: consumption,
    inPeriod: inPeriodAt,
    lifecycle,
    reviewLanes: () => opts.reviewLanes ?? listReviewLanes(),
    sessions: () => sessionRecords,
    conversationLaneOf: opts.conversationLaneOf ?? (() => null),
    titleOf: (iddId) => titles.get(iddId),
    ...(opts.quotaWindows ? { windows: opts.quotaWindows({ since, until }) } : {}),
  });
  const totals = {
    lanes: lanes.length,
    cost: {
      budget: round(lanes.reduce((a, l) => a + l.cost.budget, 0)),
      subscription: round(lanes.reduce((a, l) => a + l.cost.subscription, 0)),
      ...(() => {
        const lines = lanes.reduce((a, l) => a + (l.landed_lines ?? 0), 0);
        const per = perThousand(lanes.reduce((a, l) => a + l.cost.budget, 0), lines);
        return per === undefined ? {} : { per_1000_lines: round(per) };
      })(),
    },
    time: {
      stage: round(lanes.reduce((a, l) => a + l.time.stage, 0)),
      gate: round(lanes.reduce((a, l) => a + l.time.gate, 0)),
      wait: round(lanes.reduce((a, l) => a + l.time.wait, 0)),
    },
    checks: {
      rounds: lanes.reduce((a, l) => a + l.checks.rounds, 0),
      typecheck_failures: lanes.reduce((a, l) => a + l.checks.typecheck_failures, 0),
      wall_seconds: round(lanes.reduce((a, l) => a + l.checks.wall_seconds, 0)),
      cpu_seconds: round(lanes.reduce((a, l) => a + (l.checks.cpu_seconds ?? 0), 0)),
    },
    landed_lines: lanes.reduce((a, l) => a + (l.landed_lines ?? 0), 0),
    granularity: lanes.reduce<MetricsLane["granularity"]>((a, l) => ({
      proposed: a.proposed + l.granularity.proposed,
      split: a.split + l.granularity.split,
      fix_sent: a.fix_sent + l.granularity.fix_sent,
      escalated: a.escalated + l.granularity.escalated,
      signed: a.signed + l.granularity.signed,
    }), { proposed: 0, split: 0, fix_sent: 0, escalated: 0, signed: 0 }),
    sent_back: lanes.reduce((a, l) => a + l.sent_back, 0),
    hands: addHands(lanes.map((l) => l.hands)),
    silent: {
      minutes: round(lanes.reduce((a, l) => a + l.silent.minutes, 0)),
      spans: lanes.reduce((a, l) => a + l.silent.spans, 0),
      from_watch: lanes.reduce((a, l) => a + l.silent.from_watch, 0),
    },
  };
  return {
    since,
    until,
    lanes,
    groups: [...groups.values()].sort((a, b) => b.lanes.length - a.lanes.length || a.settings_key.localeCompare(b.settings_key)),
    flaky: foldFlaky(flaky),
    direct_commits: direct,
    canary: buildCanaryView(opts.canary ?? [], { since, until }),
    net,
    quota,
    totals,
  };
}

/** the copy a settings key names, read from a lane whose `lane_open` carries it (the groups read it once) */
function settingsFor(key: string, lifecycle: LifecycleRecord[]): PipelineSettings {
  for (const e of lifecycle) {
    const copy = e.attrs?.pipeline as PipelineSettings | undefined;
    if (copy?.key === key) return copy;
  }
  // a group whose copy cannot be read back (the lane's row was removed) is still shown as the settings it was set to
  return { pipeline: {}, models: {}, key };
}

/** the pipeline as it is now, for a caller that has no lane to read (the weekly table's footnote) */
export function currentPipelineSettings(): PipelineSettings {
  return pipelineSettings();
}

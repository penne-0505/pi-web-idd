import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAgentRunner } from "../agent/port.ts";
import { laneBudgetUsd } from "../config/pipeline.ts";
import { deriveStage, laneBudget, laneBudgetIdle } from "../ledger/derive.ts";
import { stagePick } from "../ledger/pick.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { stateDir } from "../paths.ts";
import { jstDay } from "../time.ts";
import { readRoutingCost, routingCostPath } from "./routing-cost.ts";
import type { LifecycleRecord, SessionRecord } from "../schema/records.ts";

export { DEFAULT_LANE_BUDGET_USD, laneBudgetUsd, parseLaneBudget } from "../config/pipeline.ts";

/** the ad-hoc runs a lane's stages started, as they recorded them in the lifecycle */
export function laneRunIds(events: { attrs?: Record<string, unknown> }[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    const a = e.attrs ?? {};
    if (typeof a.run_id === "string" && a.run_id) ids.add(a.run_id);
    if (Array.isArray(a.run_ids)) for (const id of a.run_ids) if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids];
}

/** one record's spend, split by the JST day it was spent on (an empty day never appears) */
export interface DailyCost {
  day: string;
  /** what the budget counts */
  budget: number;
  /** the Claude Code spend (subscription, API equivalent) */
  subscription: number;
}

/** the total and per-day spend one record (a session or a run) has */
interface CostReading {
  cost: number;
  daily: DailyCost[];
}

interface RunReading extends CostReading {
  harness?: string;
  missing?: true;
  /** one entry per attempt when the record has an attempt list, each read by its own harness */
  segments?: RunSegment[];
}

/** one attempt's spend within a run, read by that attempt's own harness and day */
interface RunSegment extends CostReading {
  label: string;
  harness?: string;
}

/**
 * The readings already taken, keyed by record and kept until the record's fingerprint (its size and update time)
 * changes. A cache dropped by time would return a stale reading right after a record grew, which is the mismatch
 * DEC-9142 forbids; a finished run never changes, so it is read once.
 */
const readings = new Map<string, { fingerprint: string; value: unknown }>();

/** drop the cached readings (tests); a live process keeps them while the records hold */
export function clearCostCache(): void {
  readings.clear();
}

/** the size-and-update-time fingerprint of a file, or null when it cannot be read */
function fingerprintOf(path: string): string | null {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/** a record's spend as one day's budget or subscription part */
function dayCost(day: string, cost: number, harness: string | undefined): DailyCost {
  const subscription = harness === SUBSCRIPTION_HARNESS;
  return { day, budget: subscription ? 0 : cost, subscription: subscription ? cost : 0 };
}

/** what one ad-hoc run cost, from its lane record, split by the day it ended (a run that is still going cost 0) */
export function runReading(id: string): RunReading {
  const p = join(stateDir(), "lanes", id, "lane.json");
  const fingerprint = fingerprintOf(p);
  if (fingerprint === null) return { cost: 0, daily: [], missing: true };
  const key = `run:${id}`;
  const hit = readings.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit.value as RunReading;
  try {
    const rec = JSON.parse(readFileSync(p, "utf8")) as {
      usage?: { cost?: unknown };
      role_preset?: { harness?: unknown };
      ended_at?: unknown;
      started_at?: unknown;
      attempts?: unknown;
    };
    // a run that moved to another candidate wrote one entry per attempt, each with its own harness: the budget
    // and the subscription are split by those entries, so a Claude attempt stays out of the total (DEC-110-6)
    const attempts = Array.isArray(rec.attempts) ? (rec.attempts as Record<string, unknown>[]) : [];
    if (attempts.length) {
      const segments: RunSegment[] = attempts.map((a, i) => {
        const harness = typeof a.harness === "string" ? a.harness : undefined;
        const cost = Number((a.usage as { cost?: unknown } | undefined)?.cost ?? 0) || 0;
        const at = typeof a.ended_at === "string" && a.ended_at ? a.ended_at : typeof a.started_at === "string" ? a.started_at : "";
        const day = jstDay(at);
        return { label: `${id} #${i + 1}`, cost, harness, daily: cost && day ? [dayCost(day, cost, harness)] : [] };
      });
      const harnesses = new Set(segments.map((s) => s.harness));
      const value: RunReading = {
        cost: segments.reduce((a, s) => a + s.cost, 0),
        daily: segments.flatMap((s) => s.daily),
        ...(harnesses.size === 1 && segments[0].harness ? { harness: segments[0].harness } : {}),
        segments,
      };
      readings.set(key, { fingerprint, value });
      return value;
    }
    const harness = typeof rec.role_preset?.harness === "string" ? rec.role_preset.harness : undefined;
    const cost = Number(rec.usage?.cost ?? 0) || 0;
    // a run whose end time was cleared (a resume) is split by when it started
    const at = typeof rec.ended_at === "string" && rec.ended_at ? rec.ended_at : typeof rec.started_at === "string" ? rec.started_at : "";
    const day = jstDay(at);
    const value: RunReading = { cost, daily: cost && day ? [dayCost(day, cost, harness)] : [], ...(harness ? { harness } : {}) };
    readings.set(key, { fingerprint, value });
    return value;
  } catch {
    return { cost: 0, daily: [], missing: true };
  }
}

/** what one ad-hoc run cost, from its lane record, and which harness ran it */
export function runCost(id: string): { cost: number; harness?: string; missing?: true } {
  const r = runReading(id);
  return { cost: r.cost, ...(r.harness ? { harness: r.harness } : {}), ...(r.missing ? { missing: true } : {}) };
}

export interface CostPart {
  label: string;
  cost: number;
}

/**
 * Claude Code runs on the subscription: what it reports is an API-equivalent figure, not money spent. It is
 * bounded by the subscription's windows instead of the lane's budget.
 */
export const SUBSCRIPTION_HARNESS = "claude";

/** the subscription's API-equivalent sum of a lane's spend */
export function subscriptionTotal(cost: { subscription: CostPart[] }): number {
  return cost.subscription.reduce((a, p) => a + p.cost, 0);
}

/**
 * One session's spend, from the runner. Its record's fingerprint decides whether the reading is taken again, so an
 * unchanged session (or a finished one) is not read twice (DEC-9142); a runner with no day split falls back to the
 * plain cost, taken as spent today.
 */
async function sessionReading(id: string, harness: string | undefined): Promise<CostReading> {
  const runner = getAgentRunner();
  if (runner?.sessionDailyCost && runner.sessionRecordFingerprint) {
    let fingerprint: string | null;
    try {
      fingerprint = runner.sessionRecordFingerprint(id);
    } catch {
      fingerprint = null;
    }
    if (fingerprint === null) return { cost: 0, daily: [] };
    const key = `session:${id}`;
    const hit = readings.get(key);
    if (hit && hit.fingerprint === fingerprint) return hit.value as CostReading;
    let raw: { cost: number; daily: { day: string; cost: number }[] } | null = null;
    try {
      raw = runner.sessionDailyCost(id);
    } catch {
      raw = null;
    }
    const daily = (raw?.daily ?? []).filter((d) => d && d.day && Number.isFinite(d.cost) && d.cost !== 0).map((d) => dayCost(d.day, d.cost, harness));
    const value: CostReading = { cost: raw?.cost ?? 0, daily };
    readings.set(key, { fingerprint, value });
    return value;
  }
  if (!runner?.sessionCost) return { cost: 0, daily: [] };
  const cost = await runner.sessionCost(id).catch(() => 0);
  const day = jstDay(Date.now());
  return { cost, daily: cost && day ? [dayCost(day, cost, harness)] : [] };
}

/** what the question judge spent on a lane's batches, split by the JST day of each run; it runs on pi, so the budget counts it */
function routingReading(iddId: string): CostReading {
  const fingerprint = fingerprintOf(routingCostPath());
  if (fingerprint === null) return { cost: 0, daily: [] };
  const key = `routing:${iddId}`;
  const hit = readings.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit.value as CostReading;
  const rows = readRoutingCost(iddId);
  const value: CostReading = {
    cost: rows.reduce((a, r) => a + r.cost, 0),
    daily: rows.flatMap((r) => {
      const day = jstDay(r.at);
      return r.cost && day ? [dayCost(day, r.cost, undefined)] : [];
    }),
  };
  readings.set(key, { fingerprint, value });
  return value;
}

/**
 * The conversation sessions of lanes with the label each one carries: every planner session is "planner", and a lane's
 * executor sessions are "executor" then "修正 n" in the order its records are in (one per fix round, the first being the
 * lane's own). The budget's reader and the quota share both read a session's stage from this one assignment.
 */
export function laneSessions(planners: SessionRecord[], executors: SessionRecord[]): { label: string; id: string; harness: string | undefined }[] {
  const out: { label: string; id: string; harness: string | undefined }[] = [];
  for (const p of planners) if (p.planner_session_id) out.push({ label: "planner", id: p.planner_session_id, harness: p.harness });
  const seen = new Map<string, number>();
  for (const e of executors) {
    const i = seen.get(e.idd_id) ?? 0;
    seen.set(e.idd_id, i + 1);
    if (e.executor_session_id) out.push({ label: i === 0 ? "executor" : `修正 ${i}`, id: e.executor_session_id, harness: e.harness });
  }
  return out;
}

/**
 * A lane's spend: its planner and executor sessions and every run its stages started. `total` and `parts`
 * are what the budget counts; `subscription` lists the Claude Code ones, kept out of the total. `daily` splits the
 * same spend by the JST day it was spent on, for today's total.
 */
export async function laneCost(iddId: string, events: LifecycleRecord[]): Promise<{ total: number; parts: CostPart[]; subscription: CostPart[]; daily: DailyCost[] }> {
  const parts: CostPart[] = [];
  const subscription: CostPart[] = [];
  const byDay = new Map<string, DailyCost>();
  const add = (part: CostPart, reading: CostReading, harness: string | undefined) => {
    (harness === SUBSCRIPTION_HARNESS ? subscription : parts).push(part);
    for (const d of reading.daily) {
      const cur = byDay.get(d.day) ?? { day: d.day, budget: 0, subscription: 0 };
      cur.budget += d.budget;
      cur.subscription += d.subscription;
      byDay.set(d.day, cur);
    }
  };
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  // a lane carries one executor session per fix round: every one of them counts toward its spend
  const executors = readSessions("executor").filter((r) => r.idd_id === iddId);
  for (const { label, id, harness } of laneSessions(planner ? [planner] : [], executors)) {
    const reading = await sessionReading(id, harness);
    add({ label, cost: reading.cost }, reading, harness);
  }
  for (const id of laneRunIds(events)) {
    const run = runReading(id);
    if (run.segments?.length) {
      for (const seg of run.segments) add({ label: seg.label, cost: seg.cost }, seg, seg.harness);
      continue;
    }
    add({ label: id, cost: run.cost }, run, run.harness);
  }
  const routed = routingReading(iddId);
  if (routed.cost > 0) add({ label: "質問の振り分け", cost: routed.cost }, routed, undefined);
  return { total: parts.reduce((a, p) => a + p.cost, 0), parts, subscription, daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

function rounded(parts: CostPart[]): CostPart[] {
  return parts.filter((p) => p.cost > 0).map((p) => ({ label: p.label, cost: Math.round(p.cost * 1000) / 1000 }));
}

/**
 * Stop a lane for penne once its spend passes its budget: a safety valve against a lane that keeps
 * spending, not a condition for convergence. Penne can add to the budget and let it go on.
 */
export async function runBudget(): Promise<{ stopped: string[]; errors: { id: string; error: string }[] }> {
  const result = { stopped: [] as string[], errors: [] as { id: string; error: string }[] };
  const base = laneBudgetUsd();
  const events = readLifecycle();
  for (const rec of readBacklog()) {
    const evs = events.filter((e) => e.idd_id === rec.idd_id);
    const d = deriveStage(evs);
    // a lane waiting on its PR or on the import spends nothing: a stop there would only hold up the close
    if (d.group === "closed" || d.decision === "stuck" || laneBudgetIdle(evs)) continue;
    try {
      const cost = await laneCost(rec.idd_id, evs);
      const limit = laneBudget(evs, base);
      // the stage asks its own question, at the moment it asks it (C-199-2)
      if (!stagePick("budget", evs, { cost: cost.total, base }).pick) continue;
      await appendLifecycle("lane_over_budget", rec.idd_id, {
        cost: Math.round(cost.total * 100) / 100,
        limit,
        parts: rounded(cost.parts),
        ...(cost.subscription.some((p) => p.cost > 0) ? { subscription_parts: rounded(cost.subscription) } : {}),
      });
      result.stopped.push(rec.idd_id);
    } catch (err) {
      result.errors.push({ id: rec.idd_id, error: String(err) });
    }
  }
  return result;
}

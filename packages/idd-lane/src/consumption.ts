import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { laneStateDir } from "./paths.ts";
import type { FailureKind } from "./roles.ts";

/**
 * One model call the lane's agents made, per attempt of a stage's run and per reply of a conversation. The rows
 * are appended only, one write each, so several supervisors may add them at once without a lock and no reader ever
 * sees half a row. They are not read by the budget's reading (DEC-110-5): the budget keeps its one reader, and the
 * consumption door only reads.
 */
export interface ConsumptionRow {
  at: string;
  /** attempt: one candidate's turn at a stage's run; reply: one answer of a conversation */
  unit: "attempt" | "reply";
  lane?: string;
  idd_id?: string;
  run?: string;
  role?: string;
  model?: string;
  /** the model definition the call target came from; absent for a Claude Code role or a named model */
  model_name?: string;
  harness?: string;
  /** claude | the model's provider name (ollama-cloud, openrouter, ...) */
  contract?: string;
  /** the provider the attempt was pinned to, when the role wrote a provider column */
  provider?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cost: number;
  status?: string;
  failure?: FailureKind;
}

/** <state>/pipeline/consumption.jsonl: appended by the supervisors, read by the consumption door */
export function consumptionPath(): string {
  return join(laneStateDir(), "..", "pipeline", "consumption.jsonl");
}

/** Append one row. One write, so rows from lanes ending at the same moment do not interleave. */
export function appendConsumption(row: ConsumptionRow): void {
  const p = consumptionPath();
  mkdirSync(join(p, ".."), { recursive: true });
  appendFileSync(p, `${JSON.stringify(row)}\n`, "utf8");
}

/** The rows as they are; a line that does not read is skipped, so one bad row does not lose the rest. */
export function readConsumption(): ConsumptionRow[] {
  const p = consumptionPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const parsed: unknown = JSON.parse(l) as unknown;
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as ConsumptionRow] : [];
      } catch {
        return [];
      }
    });
}

export interface ConsumptionFilter {
  /** rows at or after this day (YYYY-MM-DD, Japan time) */
  since?: string;
  lane?: string;
}

/** a contract (and provider, when the row names one) and what was spent there */
export interface ConsumptionBucket {
  contract: string;
  provider?: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  units: number;
  attempts: number;
  replies: number;
}

export interface ConsumptionSummary {
  cost: number;
  units: number;
  buckets: ConsumptionBucket[];
  /** how many units ended in each failure kind; a unit with no failure is not counted */
  failures: Record<string, number>;
}

/** The JST day an instant falls on, cut at 0:00 Japan time (the same cut the cost records use). */
export function jstDayOf(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function filterConsumption(rows: ConsumptionRow[], filter: ConsumptionFilter = {}): ConsumptionRow[] {
  return rows.filter((r) => {
    if (filter.lane && r.lane !== filter.lane) return false;
    if (filter.since) {
      const day = jstDayOf(r.at);
      if (!day || day < filter.since) return false;
    }
    return true;
  });
}

/** Sum the rows by contract and provider: what each contract used, and how its units ended. */
export function summarizeConsumption(rows: ConsumptionRow[]): ConsumptionSummary {
  const buckets = new Map<string, ConsumptionBucket>();
  const failures: Record<string, number> = {};
  let cost = 0;
  for (const r of rows) {
    const contract = r.contract || r.harness || "unknown";
    const key = `${contract}\u0000${r.provider ?? ""}`;
    const b = buckets.get(key) ?? { contract, ...(r.provider ? { provider: r.provider } : {}), cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, units: 0, attempts: 0, replies: 0 };
    const rowCost = Number(r.cost ?? 0) || 0;
    b.cost += rowCost;
    b.input += Number(r.input ?? 0) || 0;
    b.output += Number(r.output ?? 0) || 0;
    b.cacheRead += Number(r.cache_read ?? 0) || 0;
    b.cacheWrite += Number(r.cache_write ?? 0) || 0;
    b.units += 1;
    if (r.unit === "reply") b.replies += 1;
    else b.attempts += 1;
    buckets.set(key, b);
    cost += rowCost;
    if (r.failure) failures[r.failure] = (failures[r.failure] ?? 0) + 1;
  }
  const rounded = (v: number) => Math.round(v * 1_000_000) / 1_000_000;
  return {
    cost: rounded(cost),
    units: rows.length,
    buckets: [...buckets.values()].map((b) => ({ ...b, cost: rounded(b.cost) })).sort((a, b) => b.cost - a.cost || a.contract.localeCompare(b.contract)),
    failures,
  };
}

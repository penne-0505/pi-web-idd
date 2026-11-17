import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../paths.ts";

/**
 * What the question judge spent on a lane's batches, one row per run. It is its own file and not the conversation cost
 * ledger: that one is kept out of a lane's cost and its budget (DEC-1732), and the judge's run is a stage of the lane,
 * so `laneCost` reads this file and adds it to the lane's total.
 */
const FILE = "question-routing-cost.jsonl";

export interface RoutingCostRow {
  idd_id: string;
  batch_id: string;
  at: string;
  role: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** what the judge's run used, as pi reports it, and the row it becomes; null when the run reported nothing */
export function routingCostRow(
  batch: { idd_id: string; batch_id: string },
  reply: { role: string; model: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } | number } },
  at: string = new Date().toISOString(),
): RoutingCostRow | null {
  const u = reply.usage;
  if (!u) return null;
  const cost = num(typeof u.cost === "number" ? u.cost : u.cost?.total);
  const row = { input: num(u.input), output: num(u.output), cache_read: num(u.cacheRead), cache_write: num(u.cacheWrite), cost };
  if (!row.input && !row.output && !row.cache_read && !row.cache_write && !cost) return null;
  return { idd_id: batch.idd_id, batch_id: batch.batch_id, at, role: reply.role, model: reply.model, ...row };
}

/** append the row; a run whose usage is empty writes nothing */
export function recordRoutingCost(row: RoutingCostRow | null): void {
  if (!row) return;
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, FILE), `${JSON.stringify(row)}\n`, "utf8");
}

export function routingCostPath(): string {
  return join(stateDir(), FILE);
}

/** the rows of one lane */
export function readRoutingCost(iddId: string): RoutingCostRow[] {
  const path = routingCostPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((l) => {
    try {
      const row = l.trim() ? (JSON.parse(l) as RoutingCostRow) : null;
      return row && row.idd_id === iddId ? [row] : [];
    } catch {
      return [];
    }
  });
}

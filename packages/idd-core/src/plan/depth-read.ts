import { readLifecycle } from "../ledger/read.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { combineDepth, recordedDepth, type Depth } from "./depth.ts";
import { laneRisk } from "./review-scope.ts";

/**
 * The depth to run a lane at: the depth its plan declared, raised to deep when the lane's Risk reads high. This is
 * the one reader the plan review, the review loop, the auto GO and the forecast all share; a lane with no declared
 * depth reads as standard (deep when high), and a lane with one reads deeper only.
 *
 * Kept apart from `depth.ts` so the pure table and floor can be read from the ledger without pulling the review
 * scope (which reads the ledger back) into a cycle.
 */
export function laneDepth(rec: BacklogRecord, worktree: string, base?: string): Depth {
  const events = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
  return combineDepth(recordedDepth(events), laneRisk(rec, worktree, base).high);
}

import { readAreas, resolveAreaKey } from "../config/areas.ts";
import { laneBlockerWait, lifecycleByLane, type BlockerContext, type TrackerRead } from "../ledger/blockers.ts";
import { deriveStage, withoutNotes } from "../ledger/derive.ts";
import { stagePick } from "../ledger/pick.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { isReturnedResult } from "../ledger/review-loop.ts";
import { appendLifecycle, applyDecision } from "../ledger/write.ts";
import { LANE_STALL_DETECTED } from "./stall-watch.ts";

/**
 * The tick's stage for dependency waits (the read side is ledger/blockers.ts). A lane whose executor's first word
 * was a return (no change) waits on the blockers not landed yet (`blocked_by_dependency`, the record the stage view
 * and the Work screen already read as a dependency wait) instead of being reviewed; when none is left to wait for,
 * the return has another cause and the lane is handed to penne as the stall watch hands one. A waiting lane whose
 * blockers have all landed is sent back to its executor through the S4 revise door, so the same fix session, merge
 * and review loop follow.
 */

/** the work side's mainline of the lane's repo, when the repo names one */
function workBaseOf(area: string): string | null {
  const key = resolveAreaKey(area);
  if ("error" in key) return null;
  const base = readAreas().areas[key.key]?.work_base;
  return typeof base === "string" && base ? base : null;
}

/** the word to the executor once what it returned for has landed */
export function blockerResumeInstruction(area: string, refs: string[]): string {
  const base = workBaseOf(area);
  const mainline = base ? `本流（${base}）` : "本流";
  return `待っていた blocker（${refs.join(", ")}）が${mainline}に着地した。${mainline}を merge し（rebase 禁止）、計画どおり実装して commit し、結果を報告する。`;
}

export interface BlockerWaitsResult {
  /** lanes put to wait on this pass (their executor returned and a blocker has not landed) */
  waited: string[];
  /** lanes whose blockers have all landed: the executor was sent back to implement */
  released: string[];
  /** lanes whose executor returned with no blocker left to wait for: handed to penne */
  halted: string[];
  errors: { iddId: string; error: string }[];
}

/**
 * Lanes waiting at GO have their blockers' trackers read here too, so the card shows a fresh state without reading
 * the tracker itself. The stage never fails the tick: a lane it cannot read is left as it is.
 */
export async function runBlockerWaits(opts: { now?: number; tracker?: TrackerRead } = {}): Promise<BlockerWaitsResult> {
  const result: BlockerWaitsResult = { waited: [], released: [], halted: [], errors: [] };
  const backlog = readBacklog();
  const byLane = lifecycleByLane(readLifecycle());
  const ctx: BlockerContext = { backlog, byLane, refresh: true, ...opts };
  for (const rec of backlog) {
    const evs = byLane.get(rec.idd_id) ?? [];
    // the stage asks its own question, at the moment it asks it (C-199-2)
    if (!stagePick("blocker", evs, { hasBlockers: Boolean(rec.blockers?.length) }).pick) continue;
    try {
      const last = withoutNotes(evs).at(-1);
      if (isReturnedResult(last)) {
        const wait = laneBlockerWait(rec, ctx);
        if (wait) {
          await appendLifecycle("blocked_by_dependency", rec.idd_id, {
            depends_on: wait.items.map((i) => i.ref),
            waiting_for: wait.items.map((i) => `${i.ref} ${i.title}`.trim()),
            reason: wait.reason,
            by: "harness",
          });
          result.waited.push(rec.idd_id);
        } else {
          // the return has a cause the engine cannot read: penne decides (send back with a word, or close)
          const executor = readSessions("executor").filter((s) => s.idd_id === rec.idd_id).pop();
          await appendLifecycle(LANE_STALL_DETECTED, rec.idd_id, {
            stage: "S2",
            since: last!.at,
            last_event: { event: last!.event, at: last!.at },
            reason: "実装役が戻す条件で戻った（変更なし）が、待つ blocker が無い",
            causes: [],
            can_send_back: Boolean(executor?.worktree_path),
          });
          result.halted.push(rec.idd_id);
        }
        continue;
      }
      if (last?.event === "blocked_by_dependency") {
        if (laneBlockerWait(rec, ctx)) continue;
        const refs = Array.isArray(last.attrs?.depends_on) ? (last.attrs.depends_on as unknown[]).map(String) : [];
        const written = await applyDecision("s4_revise", { iddId: rec.idd_id, instruction: blockerResumeInstruction(rec.area, refs), by: "harness" });
        if (!written.ok) result.errors.push({ iddId: rec.idd_id, error: written.error ?? "差し戻しを記録できません" });
        else result.released.push(rec.idd_id);
        continue;
      }
      // a lane at GO with blockers: the tracker is read here, so the card does not have to
      if (rec.blockers?.length && deriveStage(evs).decision === "go") laneBlockerWait(rec, ctx);
    } catch (err) {
      result.errors.push({ iddId: rec.idd_id, error: String((err as Error).message ?? err) });
    }
  }
  return result;
}

import type { LifecycleRecord } from "../schema/records.ts";
import type { LaneEnds, PrWaiting } from "./ledger-reads.ts";

/**
 * The remaining readings as the TypeScript read them before the MoonBit fold took them over. They are not on the
 * running path (C-205-6): the cross-check (`packages/idd-fold/crosscheck.mjs`) holds them against the MoonBit answers
 * at every prefix of a real ledger, and the committed tests hold both against each other over the facts' variety.
 *
 * The ends are the copy's own answer, written here as the TypeScript had them before the fold took the list over. A
 * copy that read the running path's list would share its answer with the fold, and a fold that took the wrong end
 * for the lane's would agree with the copy: the comparison would show nothing (C-206-1).
 */

/** the ends after which a lane's worktree is retired, as `plan/close.ts` had them (a hold at S3 is not one) */
export const FINAL_ENDS_REFERENCE: readonly string[] = ["lane_close", "s1_defer"];

/** the events after which a lane no longer goes on, as `ledger/ends.ts` had them (the wider list intake reads) */
export const LANE_ENDED_EVENTS_REFERENCE: readonly string[] = ["lane_close", "s1_defer", "s3_defer"];

export function awaitingMergeReference(events: LifecycleRecord[]): PrWaiting {
  const created = events.filter((e) => e.event === "s4_pr_created").pop();
  if (!created || events.some((e) => e.event === "lane_close")) return { waiting: false };
  const names = events.map((e) => e.event);
  const since = Math.max(names.lastIndexOf("s4_submit_started"), names.lastIndexOf("s4_pushed"), names.lastIndexOf("s4_ship_failed"), names.lastIndexOf("s2_result"));
  if (names.lastIndexOf("s4_pr_created") < since && names.lastIndexOf("s4_merged") < since) return { waiting: false };
  const prNumber = Number(created.attrs?.pr_number);
  if (!Number.isFinite(prNumber)) return { waiting: false };
  return { waiting: true, prNumber, prUrl: String(created.attrs?.pr_url ?? "") };
}

export function laneEndsReference(events: LifecycleRecord[]): LaneEnds {
  return {
    finally: events.some((e) => FINAL_ENDS_REFERENCE.includes(e.event)),
    discarded: events.some((e) => e.event === "s1_defer" || (e.event === "lane_close" && ["aborted", "dropped", "redone"].includes(String(e.attrs?.outcome)))),
  };
}

export function retirePickReference(events: LifecycleRecord[], facts: Record<string, unknown>): boolean {
  return events.some((e) => FINAL_ENDS_REFERENCE.includes(e.event))
    && Boolean(facts.hasWorktreePath)
    && Boolean(facts.hasLocalPath)
    && Boolean(facts.hasWorkBase)
    && Boolean(facts.exists);
}

export function retireKeptReference(events: LifecycleRecord[], facts: Record<string, unknown>): boolean {
  const last = [...events].reverse().find((e) => e.event === "lane_worktree_kept");
  return last?.attrs?.reason !== facts.reason || last?.attrs?.path !== facts.path;
}

export function prDraftPickReference(events: LifecycleRecord[], facts: Record<string, unknown>): boolean {
  if (!facts.publishes || !facts.hasDraftRunner) return false;
  const names = events.map((e) => e.event);
  const submitted = names.lastIndexOf("s4_submit_started");
  if (facts.hasPrDraft || names.lastIndexOf("s4_pr_draft_failed") > submitted) return false;
  if (facts.openPr) return false;
  return Boolean(facts.hasView) && Boolean(facts.hasRepo);
}

export function closedLanesReference(events: LifecycleRecord[]): Map<string, number> {
  const closed = new Map<string, number>();
  for (const e of events) {
    if (!LANE_ENDED_EVENTS_REFERENCE.includes(e.event)) continue;
    const at = Date.parse(e.at);
    const prev = closed.get(e.idd_id);
    closed.set(e.idd_id, prev === undefined || Number.isNaN(prev) ? at : Number.isNaN(at) ? prev : Math.max(prev, at));
  }
  return closed;
}

export function landedLanesReference(events: LifecycleRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.event !== "lane_close" || !e.attrs?.merged_commit) continue;
    ids.add(e.idd_id);
  }
  return ids;
}

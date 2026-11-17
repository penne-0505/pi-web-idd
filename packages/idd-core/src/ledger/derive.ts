import type { LifecycleRecord } from "../schema/records.ts";
import { laneAnswer } from "../intent/moonbit-fold.ts";
import { quotaHoldOf, readQuotaWindows, type QuotaCut } from "../plan/quota-wait.ts";
import { returnsToPlan } from "./replan-view.ts";

export type LaneGroup = "judge" | "prep" | "impl" | "waiting" | "closed";
export type DecisionKind = "duplicate" | "granularity" | "question" | "go" | "review" | "ship" | "stuck" | "requeue";

export type PlanReviewPhase =
  | { phase: "none" }
  | { phase: "waiting" }
  /** one run per role of pipeline.plan_review; a review started before the runs were listed has its one run_id */
  | { phase: "running"; runIds: string[] }
  | { phase: "revising" }
  | { phase: "sent_back" }
  | { phase: "reviewed"; failed: boolean; actionable: number };

/**
 * Events that note something on a lane without moving it (the work branch moved into a waiting plan's places). The
 * stage, and whatever reads a lane's last event to know what it waits on, read past them. "s2_executor_wait_ended" is
 * the same literal as review-loop's EXECUTOR_WAIT_END_EVENT (written here as text so this file does not import the
 * loop): a record that lands after a Claude quota wait must not take the wait's place as the last event.
 */
export const LANE_NOTE_EVENTS: readonly string[] = ["s1_base_advanced", "lane_stall_instructed", "lane_wait_notified", "lane_start_skipped", "fix_plan_started", "fix_plan_done", "s2_executor_wait_ended", "s2_shape_started", "s2_shape_judged"];

export function withoutNotes<T extends { event: string }>(events: T[]): T[] {
  return events.some((e) => LANE_NOTE_EVENTS.includes(e.event)) ? events.filter((e) => !LANE_NOTE_EVENTS.includes(e.event)) : events;
}

/**
 * Labels of a prep lane whose planner owes a new ready; the watch stage keys on them, so they are shared.
 *
 * They are written once, in the MoonBit fold (`packages/idd-fold/stage.mbt`), and read from here: the stage that
 * puts the label on the lane and the turn that reads it are the same definition, so the screen's label and the
 * tick's reading cannot disagree (C-201-5).
 */
const PLANNER_WAITS = laneAnswer<string[]>("planner_waits", []);
export const PLANNER_REVISING = PLANNER_WAITS[0] ?? "";
export const PLANNER_SENT_BACK = PLANNER_WAITS[1] ?? "";

/**
 * Where a lane stands in the plan review, from its lifecycle alone — folded by the MoonBit stage derivation, so
 * the stage and this reader cannot disagree on what a proposal is (C-191-1).
 */
export function planReviewPhase(events: LifecycleRecord[]): PlanReviewPhase {
  return laneAnswer<PlanReviewPhase>("plan_review_phase", events);
}

export { replanView, returnsToPlan, lastReturnToPlan } from "./replan-view.ts";

/** one line of a lane's per-round trace */
export interface RoundTraceLine {
  /** how many times the lane went back to its plan before this round: a return numbers the rounds from 1 again */
  cycle: number;
  round: number;
  kind: string;
  accepted_must: number;
  accepted_should: number;
  named_files: string[];
  /** the files changed in this round's cycle (a result's `cycle_files` when it has them, else its `changed_files`) */
  changed_files: number;
  outside_scope: string[];
}

/**
 * The per-round lines of a lane, one for each round — a (cycle, round) pair — the review loop recorded a judgement
 * for, the judgements of one round (a feedback and a device judgement, say) folded into one line and a re-judgement
 * of the same round (`confirm`) left out. Read from the ledger's own fields by the MoonBit fold, the whole lane (a replan leaves nothing out):
 * the same ledger gives the same lines. A round's `outside_scope` is measured against the `plan_scope` of the last GO
 * before it (the plan's list of paths to touch as that GO recorded it), so a plan edited later moves no line; a GO
 * that recorded none puts no file outside.
 */
export function roundTrace(events: LifecycleRecord[]): RoundTraceLine[] {
  return laneAnswer<RoundTraceLine[]>("round_trace", events);
}

/**
 * Whether the review's answer leaves a must that nobody confirmed solved: the last review still raised one, or it
 * failed or was skipped after an earlier round of this count had raised one (a review that did not answer cannot
 * show the planner's fix solved it). Only a GO card that is open can have it.
 */
export function planReviewMustUnconfirmed(events: LifecycleRecord[]): boolean {
  const phase = planReviewPhase(events);
  if (phase.phase !== "reviewed") return false;
  if (phase.actionable > 0) return true;
  let from = 0;
  events.forEach((e, i) => {
    if (e.event === "s1_revise_requested" || returnsToPlan(e)) from = i + 1;
  });
  const rounds = events.slice(from).filter((e) => e.event === "s1_plan_review_done" || e.event === "s1_plan_review_skipped");
  const last = rounds[rounds.length - 1];
  if (!last || (last.event === "s1_plan_review_done" && !last.attrs?.failed)) return false;
  return rounds.slice(0, -1).some((e) => e.event === "s1_plan_review_done" && !e.attrs?.failed && e.attrs?.sent_back !== false && Number(e.attrs?.must ?? 0) > 0);
}

/** a lane's budget: the default, or what penne raised it to last */
export function laneBudget(events: LifecycleRecord[], base: number): number {
  return laneAnswer<number>("lane_budget", events, { base });
}

/**
 * A lane that only waits, on its PR or (merged) on the import, starts no work that spends, so its budget is not
 * judged. Answering the PR's feedback is work again.
 */
export function laneBudgetIdle(events: LifecycleRecord[]): boolean {
  return laneAnswer<boolean>("lane_budget_idle", events);
}

/**
 * A lane stopped for its spend and not given more budget since. A stop recorded while the lane only waited, or on
 * a lane that has come to only wait, does not hold it.
 */
export function laneOverBudget(events: LifecycleRecord[]): { cost: number; limit: number } | null {
  return laneAnswer<{ cost: number; limit: number } | null>("lane_over_budget", events);
}

/** a lane held for penne: no stage starts more work for it */
export function laneHeld(events: LifecycleRecord[]): boolean {
  return laneAnswer<boolean>("lane_held", events);
}

/**
 * The last halt the stall watch recorded for the lane, or null: a lane the engine found stuck and left for penne.
 */
export function laneHalt(events: LifecycleRecord[]): { stage: string; since: string; lastEvent: { event: string; at: string }; reason: string; causes: string[]; canSendBack: boolean } | null {
  return laneAnswer("lane_halt", events);
}

/** an executor / planner session that stopped without answering and was not resumed since */
export function laneStall(events: LifecycleRecord[]): { role: string; cause: string; reason: string } | null {
  return laneAnswer("lane_stall", events);
}

export type Stage = {
  group: LaneGroup;
  stageDone: number;
  stageCurrent: number | null;
  blockedBy?: string;
  decision?: DecisionKind;
};

/**
 * The lane's wait for Claude Code's windows, when its last word is one: whether it still holds now, and the reset
 * the display reads. `cut` says how the windows are read (a runtime reading, or the record alone); absent reads
 * the runtime now, as the stage's own start does (C-133-3).
 */
export function quotaWait(events: LifecycleRecord[], cut?: QuotaCut): { held: boolean; resetAt?: string; reason?: string } {
  const words = withoutNotes(events);
  return quotaHoldOf(words[words.length - 1], "claude_quota_wait", Date.now(), cut);
}

/**
 * The runtime's reading of Claude Code's windows, as the MoonBit fold is handed it. The wait is an observation and
 * not a record, so the caller reads it and passes it in; the fold judges the record and the reading together
 * (C-199-3).
 */
export interface QuotaFact {
  /** `none` puts no wait on top; `record` lets the record decide; the rest are the runtime's reading */
  mode: "none" | "record" | "free" | "busy" | "unknown";
  /** the clock the reading was taken at */
  now: number;
  /** the reading's reset, in UNIX seconds */
  resetsAt?: number;
  /** the runtime's reason */
  reason?: string;
}

/** the runtime's reading of the windows, in the way the caller was asked for it */
function quotaReadingOf(cut?: QuotaCut, now = Date.now()): QuotaFact {
  if (cut === "record") return { mode: "record", now };
  if (cut === undefined) {
    const reading = readQuotaWindows();
    if (reading === undefined) return { mode: "unknown", now };
    if (reading === null) return { mode: "free", now };
    return { mode: "busy", now, ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}), reason: reading.reason };
  }
  if (cut === null) return { mode: "free", now };
  return { mode: "busy", now, ...(cut.resetsAt !== undefined ? { resetsAt: cut.resetsAt } : {}), reason: cut.reason };
}

/**
 * The reading of the windows for a lane whose last word is the wait. A lane whose last word is something else
 * never has the wait put on top, so the reading is not taken for it.
 */
export function quotaFactOf(events: LifecycleRecord[], cut?: QuotaCut, now = Date.now()): QuotaFact {
  const words = withoutNotes(events);
  if (words[words.length - 1]?.event !== "claude_quota_wait") return { mode: "record", now };
  return quotaReadingOf(cut, now);
}

/**
 * The reading of the windows for a lane whose record holds a wait anywhere: a reading over the lane's prefixes
 * reads each prefix, and a prefix may end at the wait even when the lane's last word is something else.
 */
export function quotaFactOfAny(events: LifecycleRecord[], cut?: QuotaCut, now = Date.now()): QuotaFact {
  if (!events.some((e) => e.event === "claude_quota_wait")) return { mode: "record", now };
  return quotaReadingOf(cut, now);
}

/**
 * Where a lane stands. The record's own answer is folded by the MoonBit stage derivation, and the runtime's quota
 * wait is put on top of it there, because it is an observation and not a record and only the runtime can read it.
 */
export function deriveStage(all: LifecycleRecord[], cut?: QuotaCut): Stage {
  const events = withoutNotes(all);
  return laneAnswer<Stage>("stage", events, { quota: quotaFactOf(all, cut) });
}

/**
 * When the lane came to the decision it waits at: the time of the event its last stretch at that decision began
 * with. A later card of the same kind on the lane (a plan made again, a second stop) has a later time.
 */
export function decisionSince(events: LifecycleRecord[]): string | undefined {
  return laneAnswer<string | null>("decision_since", events, { quota: quotaFactOfAny(events) }) ?? undefined;
}

export function elapsedLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "昨日" : `${d}d`;
}

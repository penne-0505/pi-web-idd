import type { LifecycleRecord } from "../schema/records.ts";
import { lastReturnToPlan, replanKeptIndexes, returnsToPlan } from "./replan-view.ts";
import { deriveStageReference, oldestUnansweredReference, planReviewPhase, PLANNER_REVISING, PLANNER_SENT_BACK, PLANNER_WORK, withoutNotes, type Stage } from "./derive-reference.ts";
import { reviewLoopState } from "./review-loop-reference.ts";

/**
 * The lane's turn and the waits around it, as the TypeScript read them before the MoonBit fold took the
 * reading over. It is not on the running path: the cross-check (`packages/idd-fold/crosscheck.mjs`) holds it
 * against the MoonBit answer on every prefix of a real ledger and on the committed fixtures, and the gate's
 * fixture test holds both against each other (C-199-1).
 *
 * The wait for Claude Code's windows is an observation and not a record, so it comes in as a fact here too:
 * the same reading the MoonBit side is handed, so the two sides judge the same ledger and the same facts.
 */

/** the runtime's reading of Claude Code's windows, as the caller hands it in */
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

/** the facts a lane's turn needs that the record does not hold */
export interface LaneFacts {
  /** what the watch's reading answered for the lane: the role it waits on, or nothing */
  awaitedAgent?: { role: "executor" | "planner" } | null;
  /** an envelope is queued for the lane and not delivered */
  pendingEnvelope?: boolean;
  /** the lane's decision card can be built; only the ship card depends on the worktree, so only it reads this */
  cardBuildable?: boolean;
}

/** the review loop states that mean a run or a fix is working for the lane now */
const AGENT_LOOP_STATES = new Set(["running_map", "running_blind", "running_triage", "running_confirm", "running_device", "running_checks", "fixing", "awaiting_merge"]);

function lastIndex(events: { event: string }[], name: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return i;
  return -1;
}

/** whether a batch the agent asked after `since` has no answer yet */
export function awaitingAnswerReference(events: LifecycleRecord[], since: number): boolean {
  return oldestUnansweredReference(events, since) >= 0;
}

/** every batch asked after `since` with no answer after it, oldest first */
export function unansweredQuestionsReference(events: LifecycleRecord[], since = -1): { index: number; at: string }[] {
  const out: { index: number; at: string }[] = [];
  for (let i = Math.max(0, since + 1); i < events.length; i += 1) {
    if (events[i].event !== "question_batch_asked") continue;
    const asked = events[i].attrs?.batch_id;
    const answered = events.slice(i + 1).some((e) => e.event === "question_batch_answered" && (asked === undefined || e.attrs?.batch_id === asked));
    if (!answered) out.push({ index: i, at: String(events[i].at ?? "") });
  }
  return out;
}

/** the wait for Claude Code's windows a lane's last word is, as the reading decides it */
export function quotaHoldReference(last: LifecycleRecord | undefined, quota: QuotaFact): { held: boolean; resetAt?: string } {
  if (last?.event !== "claude_quota_wait") return { held: false };
  const at = last.attrs?.resets_at;
  const own = typeof at === "number" ? new Date(at * 1000).toISOString() : undefined;
  if (quota.mode === "record") return { held: true, ...(own ? { resetAt: own } : {}) };
  if (quota.mode === "unknown") {
    const passed = typeof at === "number" && at * 1000 <= quota.now;
    return { held: !passed, ...(own ? { resetAt: own } : {}) };
  }
  if (quota.mode === "free") return { held: false };
  return { held: true, ...(quota.resetsAt !== undefined ? { resetAt: new Date(quota.resetsAt * 1000).toISOString() } : {}) };
}

/** the stage of a lane, with the runtime's wait for Claude Code's windows put on top */
export function stageReference(all: LifecycleRecord[], quota: QuotaFact): Stage {
  const events = withoutNotes(all);
  const d = deriveStageReference(events);
  if (quota.mode === "none") return d;
  const last = events[events.length - 1];
  if (last?.event !== "claude_quota_wait" || d.decision || (d.group !== "prep" && d.group !== "impl")) return d;
  if (d.blockedBy === PLANNER_REVISING || d.blockedBy === PLANNER_SENT_BACK) return d;
  const hold = quotaHoldReference(last, quota);
  if (!hold.held) return d;
  const when = hold.resetAt ? `、リセット ${new Date(Date.parse(hold.resetAt) + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ")} JST` : "";
  return { ...d, blockedBy: `Claude の枠待ち（${String(last.attrs?.stage ?? "")}${when}）` };
}

/** the events that hand the executor work it must answer with a result */
const EXECUTOR_WORK = ["s2_start", "s2_fix_sent", "s4_verify_user_judgment_answered", "s3_reject", "s2_review_base_instructed", "s2_records_instructed"];

/** the index of the last row that hands the executor work: a rejection counts only when it goes back to the implementation */
function lastExecutorWork(events: LifecycleRecord[]): number {
  let found = -1;
  events.forEach((e, i) => {
    if (EXECUTOR_WORK.includes(e.event) && !(e.event === "s3_reject" && returnsToPlan(e))) found = i;
  });
  return found;
}

/** the index of the last of these events, or the last row that returns the lane to its plan, or -1 */
function lastPlannerWork(events: LifecycleRecord[], list: string[]): number {
  return Math.max(lastOf(events.map((e) => e.event), list), lastReturnToPlan(events));
}

/** the index of the last of these events, or -1 */
function lastOf(names: string[], list: string[]): number {
  return Math.max(...list.map((n) => names.lastIndexOf(n)));
}

/** the last answer after `since` (the current episode's work boundary), or -1 */
function lastAnswerAfter(names: string[], since: number): number {
  for (let i = names.length - 1; i > since; i -= 1) if (names[i] === "question_batch_answered") return i;
  return -1;
}

/**
 * The rows the waits and the turn are read from, and how to carry an index back: a lane that went back to its plan
 * is read without the era the return left out, as the MoonBit fold reads it, and the index a reading returns counts
 * in the ledger's rows (`back`), not in the view's.
 */
function viewOf(events: LifecycleRecord[]): { rows: LifecycleRecord[]; back: (index: number) => number } {
  const kept = replanKeptIndexes(events);
  if (kept.length === events.length) return { rows: events, back: (index) => index };
  return { rows: kept.map((i) => events[i]!), back: (index) => (index >= 0 && index < kept.length ? kept[index]! : index) };
}

/** the work handed to the agent whose question the lane is on now, with the role it was handed to, or null; `events` is the view and so is the index */
function questionBoundaryReference(events: LifecycleRecord[], quota: QuotaFact): { index: number; role: "executor" | "planner" } | null {
  const names = events.map((e) => e.event);
  if (names.includes("s2_start")) {
    const lastResult = names.lastIndexOf("s2_result");
    const askSince = lastExecutorWork(events);
    return askSince > lastResult ? { index: askSince, role: "executor" } : null;
  }
  const d = stageReference(events, quota);
  if (d.group !== "prep" || d.decision) return null;
  if (d.blockedBy !== undefined && d.blockedBy !== PLANNER_REVISING && d.blockedBy !== PLANNER_SENT_BACK) return null;
  return { index: lastPlannerWork(events, PLANNER_WORK), role: "planner" };
}

/** the batch a lane is waiting on penne for */
export function awaitingQuestionReference(all: LifecycleRecord[], quota: QuotaFact): { role: "executor" | "planner"; index: number } | null {
  const { rows: events, back } = viewOf(all);
  const boundary = questionBoundaryReference(events, quota);
  if (!boundary) return null;
  const index = oldestUnansweredReference(events, boundary.index);
  return index < 0 ? null : { role: boundary.role, index: back(index) };
}

/** the role a lane is waiting on and the index of the event that handed it the work, or null */
export function awaitedAgentReference(all: LifecycleRecord[], quota: QuotaFact): { role: "executor" | "planner"; since: number } | null {
  if (awaitingQuestionReference(all, quota)) return null;
  const { rows: events, back } = viewOf(all);
  const names = events.map((e) => e.event);
  if (names.includes("s2_start")) {
    const lastResult = names.lastIndexOf("s2_result");
    const askSince = lastExecutorWork(events);
    if (askSince <= lastResult) return null;
    const since = Math.max(askSince, lastAnswerAfter(names, askSince));
    return { role: "executor", since: back(since) };
  }
  const d = stageReference(events, quota);
  if (d.group !== "prep" || d.decision) return null;
  if (d.blockedBy !== undefined && d.blockedBy !== PLANNER_REVISING && d.blockedBy !== PLANNER_SENT_BACK) return null;
  const since = lastPlannerWork(events, [...PLANNER_WORK, "question_batch_answered"]);
  return { role: "planner", since: back(since) };
}

/** whose turn the lane is on, from its records and the facts a caller gathered */
export function laneTurnReference(events: LifecycleRecord[], facts: LaneFacts = {}, quota: QuotaFact = { mode: "record", now: 0 }): string | null {
  const stage = stageReference(events, quota);
  if (stage.group === "closed") return null;

  if (facts.awaitedAgent) return "agent";
  if (facts.pendingEnvelope) return "agent";
  if (awaitingQuestionReference(events, quota)) return "penne";

  // what has run, and the review's phase, are read over the lane's current plan, as the fold reads them
  const { rows: view } = viewOf(events);
  const phase = planReviewPhase(view);
  if (phase.phase === "running" || phase.phase === "revising" || phase.phase === "sent_back") return "agent";
  if (lastIndex(view, "s2_start") >= 0) {
    const loop = reviewLoopState(view);
    if (AGENT_LOOP_STATES.has(loop.state)) return "agent";
  }

  if (stage.decision) {
    if (stage.decision !== "ship" || facts.cardBuildable !== false) return "penne";
  }

  if (lastIndex(view, "s2_start") >= 0 && reviewLoopState(view).state === "awaiting_order") return "lane";
  if (stage.group === "waiting" && events[events.length - 1]?.event === "blocked_by_dependency") return "lane";

  if (stage.group === "waiting") return "outside";

  return "engine";
}

/** the step a lane stands on, as the text the two readings compare */
export function turnStepReference(events: LifecycleRecord[], facts: LaneFacts = {}, quota: QuotaFact = { mode: "record", now: 0 }): string {
  const d = stageReference(events, quota);
  return [laneTurnReference(events, facts, quota), d.group, d.stageDone, d.blockedBy ?? ""].join("\u0000");
}

/**
 * When the lane came to the step it is on now. `steps` holds the step of every prefix of the lane (the first
 * `k` rows), so a caller that walks a lane's prefixes pays for the steps once: the cross-check compares the
 * answer at every prefix, and the step of a prefix is the same whether it is read on its own or as part of the
 * lane.
 */
export function turnSinceReference(events: LifecycleRecord[], facts: LaneFacts = {}, quota: QuotaFact = { mode: "record", now: 0 }, steps?: string[]): string | undefined {
  if (!events.length) return undefined;
  const step = (evs: LifecycleRecord[]): string => (steps ? steps[evs.length] : turnStepReference(evs, facts, quota));
  const want = step(events);
  let i = events.length;
  while (i > 1 && step(events.slice(0, i - 1)) === want) i -= 1;
  let since = events[i - 1]?.at;
  const resumed = [...events].reverse().find((e) => e.event === "lane_stall_resumed");
  if (resumed && Date.parse(resumed.at) > Date.parse(since ?? "")) since = resumed.at;
  return since;
}

/** when the lane came to the decision it waits at */
export function decisionSinceReference(events: LifecycleRecord[], quota: QuotaFact = { mode: "record", now: 0 }): string | undefined {
  const decision = stageReference(events, quota).decision;
  if (!decision) return undefined;
  let i = events.length;
  while (i > 1 && stageReference(events.slice(0, i - 1), quota).decision === decision) i -= 1;
  return events[i - 1]?.at;
}

/** the rules of the write side: which stage may take which event, and what the caller is told when it may not */
const RULES: Record<string, { allows: (stage: Stage, events: LifecycleRecord[]) => boolean; refusal: string }> = {
  s1_go: { allows: (s) => s.decision === "go", refusal: "この lane は GO 待ちではありません（画面を更新してください）" },
  s1_revise_requested: { allows: (s) => s.decision === "go", refusal: "この lane は GO 待ちではありません（画面を更新してください）" },
  s1_replan_requested: { allows: (s, events) => s.decision === "stuck" && reviewLoopState(events).state === "escalated", refusal: "この lane は要判断で止まっていません（画面を更新してください）" },
  s1_granularity_answered: { allows: (s) => s.decision === "granularity", refusal: "この lane は粒度の案への答え待ちではありません（画面を更新してください）" },
  s1_defer: {
    allows: (s) => s.group === "prep" || (s.group === "judge" && (s.decision === "go" || s.decision === "question" || s.decision === "requeue")),
    refusal: "GO の前の lane だけ見送れます。GO の後は lane の中止を使ってください（画面を更新してください）",
  },
  lane_close: { allows: (s) => s.group !== "closed", refusal: "この lane は既に閉じています（画面を更新してください）" },
  s2_start: {
    allows: (s, evs) => s.group === "impl" && s.stageDone === 2 && !evs.some((e) => e.event === "s2_start"),
    refusal: "GO の後で executor をまだ起動していない lane ではありません",
  },
  s4_submit_started: {
    allows: (s) => s.group === "impl" && s.stageDone === 4,
    refusal: "S3 を通って提出前確認を待つ lane ではありません（画面を更新してください）",
  },
};

/** why the lane with these records may not take the event now, or null when it may */
export function transitionRefusalReference(event: string, events: LifecycleRecord[], quota: QuotaFact = { mode: "record", now: 0 }): string | null {
  if (!Object.hasOwn(RULES, event)) return null;
  const rule = RULES[event];
  return rule.allows(stageReference(events, quota), viewOf(events).rows) ? null : rule.refusal;
}

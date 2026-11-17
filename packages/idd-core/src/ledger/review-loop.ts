import type { RiskRoute } from "../agent/port.ts";
import { laneAnswer } from "../intent/moonbit-fold.ts";
import { lastReturnToPlan } from "./replan-view.ts";
import type { LifecycleRecord } from "../schema/records.ts";

import type {
  AcceptedItem,
  AnswerEnv,
  BoundaryDecision,
  BoundaryFix,
  ConflictSendBack,
  Correction,
  FixCap,
  FixSource,
  FollowupItem,
  LeftCount,
  Leftover,
  OrderOpponent,
  OscillationItem,
  RejectedItem,
  RefScope,
  ReviewKind,
  ReviewLoopState,
  ReviewRound,
  ShouldFixCounts,
  StuckOutcome,
  TriageKind,
  Unfixed,
} from "./review-loop-reference.ts";

/**
 * The S2 review loop, read from the lifecycle alone — the answer comes from the MoonBit derivation in
 * `packages/idd-fold/` and only from it. The loop's own reading of the record (its state, and the judgements
 * its readers share: the accepted reading, the pass's policy, the conflict send-backs, stagnation and the fix
 * caps) is one implementation, so the tick's next step, the write side's refusal and the submit card read the
 * same answer (C-191-1, C-191-2). A broken MoonBit derivation is a failure the caller sees, never a second
 * reading in TypeScript; the TypeScript reading is kept for the cross-check only (`review-loop-reference.ts`).
 *
 * What stays here is the ordering between lanes (`orderPositionOf` / `compareOrder` / `orderRankOf`), the
 * stuck card's destination (`answerOutcome`, which appends an answer and follows the same transition), and the
 * labels the screen shows. All of them read the answers above.
 */

/**
 * The record a round that read nothing is written under: the head since the last round is only the mainline merged in,
 * so no line of it is unreviewed. A name of its own, because `s2_review_skipped` is a blind nobody was there to run
 * (no `s2_review_started` at all), and a reader of rounds and stages has to tell a lane whose review never ran from a
 * lane whose review closed and then took the mainline in.
 */
export const MERGE_ONLY_SKIP_EVENT = "s2_review_merged_skipped";

export type {
  AcceptedItem,
  AnswerEnv,
  BoundaryDecision,
  BoundaryFix,
  ConflictSendBack,
  Correction,
  FixCap,
  FixSource,
  FollowupItem,
  LeftCount,
  Leftover,
  OrderOpponent,
  OscillationItem,
  RejectedItem,
  RefScope,
  ReviewKind,
  ReviewLoopState,
  ReviewRound,
  ShouldFixCounts,
  StuckOutcome,
  TriageKind,
  Unfixed,
};


export const REVIEW_EVENTS = [
  "s2_review_started", "s2_review_findings", "s2_triage_started", "s2_triage_done", "s2_fix_sent",
  "s2_confirm_started", "s2_confirm_done", "s2_review_converged", "s2_review_escalated", "s2_review_resumed",
  "s2_review_skipped", MERGE_ONLY_SKIP_EVENT, "s2_device_started", "s2_device_done", "s2_device_skipped", "s4_review_comment_received",
  "s2_map_started", "s2_map_done", "s2_map_dropped",
  // the routes were drawn at a head the lane has left: they are dropped and drawn again at the new head
  "s2_map_head_moved",
  // the hand turn: penne takes the code and the lane waits, then says it is done and one review round runs
  "s2_hand_fixed",
  // the first review's mainline merge conflicted and the executor was asked to resolve it
  "s2_review_base_conflict",
  // the order check before the first review: waiting on the lanes ahead, and the ways it ends
  "s2_order_waiting", "s2_order_passed", "s2_order_released", "s2_order_limit", "s2_order_unknown",
  // the records check between the review's convergence and S3: its own verdict, its send-back to the executor,
  // and the round reopened when the executor changed code outside the records place
  "s2_intent_checked", "s2_records_conflict", "s2_records_instructed", "s2_records_reopened",
  // the repo's required checks at the head before the loop converges (`checks_before_converge`): the run, and what it found
  "s2_checks_started", "s2_checks_done",
] as const;

/** accepted should at or below this ends the loop (one nit-like should is tolerated); an accepted must never is */
export const ACCEPTED_LIMIT = 1;
/** consecutive failures to start a stage before the loop asks penne */
export const START_FAILURE_LIMIT = 3;
/**
 * How long a lane whose stage could not start waits before the next try. Ticks now come on every finished stage,
 * seconds apart, and without a gap a passing failure (a full disk, a network blip) would use up the limit at once.
 */
export const START_RETRY_MS = 5 * 60 * 1000;
/** safety cap on fix rounds; reaching it escalates instead of looping on */
export const MAX_FIX_ROUNDS = 8;

type Attrs = Record<string, unknown>;

/** the routes of a map as a record holds them */
export function routesOf(v: unknown): RiskRoute[] {
  return laneAnswer<RiskRoute[]>("routes_of", [], { attrs: v ?? null });
}

export function acceptedOf(attrs: Attrs | undefined): AcceptedItem[] {
  return laneAnswer<AcceptedItem[]>("accepted_of", [], { attrs: attrs ?? null });
}

export function refKey(ref: string, scope?: RefScope): string {
  return laneAnswer<string>("ref_key", [], { ref, ...(scope ? { scope } : {}) });
}

export function acceptedAt(events: LifecycleRecord[], i: number): AcceptedItem[] {
  return laneAnswer<AcceptedItem[]>("accepted_at", events, { i });
}

export function correctionsOf(attrs: Attrs | undefined): Correction[] {
  return laneAnswer<Correction[]>("corrections_of", [], { attrs: attrs ?? null });
}

export function orderOpponentsOf(attrs: Attrs | undefined): OrderOpponent[] {
  return laneAnswer<OrderOpponent[]>("order_opponents_of", [], { attrs: attrs ?? null });
}

/** a lane's order position: when it first came to the order judgement, and the id that breaks a tie */
export interface LaneOrder { at: number; lane: string }

/** the events that record a lane's position when the check ends without a wait */
const ORDER_RECORDED = ["s2_order_passed", "s2_order_released", "s2_order_limit", "s2_order_unknown"] as const;

/** the number of an id like `IDD-086`: its trailing digits, or undefined when it has none */
function laneNumberOf(lane: string): number | undefined {
  const m = /(\d+)\s*$/.exec(lane);
  return m ? Number(m[1]) : undefined;
}

/**
 * The position a lane took when it first came to the order judgement. The ordering between lanes is not one of
 * the judgements the review loop shares (the ordering's own answer is read by the slot wait), so it stays here.
 */
export function orderPositionOf(events: LifecycleRecord[]): LaneOrder | undefined {
  const lane = events[0]?.idd_id ?? "";
  for (const e of events) {
    let at: number;
    if (e.event === "s2_order_waiting") at = Date.parse(String(e.attrs?.since ?? e.at));
    else if ((ORDER_RECORDED as readonly string[]).includes(e.event)) {
      const raw = e.attrs?.order_at;
      at = typeof raw === "number" ? raw : Date.parse(String(raw ?? e.at));
    } else if (e.event === "s2_review_started" || e.event === "s2_map_started") at = Date.parse(e.at);
    else continue;
    if (Number.isFinite(at)) return { at, lane };
  }
  return undefined;
}

/** the total order of positions: the earlier time first, and the smaller lane number when two arrive at once */
export function compareOrder(a: LaneOrder, b: LaneOrder): number {
  if (a.at !== b.at) return a.at - b.at;
  const an = laneNumberOf(a.lane);
  const bn = laneNumberOf(b.lane);
  if (an !== undefined && bn !== undefined && an !== bn) return an - bn;
  return a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0;
}

/** the lanes a lane recorded in its last wait: the edge the rank walks */
function lastOpponents(events: LifecycleRecord[]): string[] {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === "s2_order_waiting") return orderOpponentsOf(events[i].attrs).map((o) => o.lane);
  return [];
}

/**
 * The place this lane holds among the lanes it collides with: one plus the lanes still waiting that its opponents
 * (and their opponents) lead to.
 */
export function orderRankOf(iddId: string, byLane: Map<string, LifecycleRecord[]>): number {
  const seen = new Set<string>([iddId]);
  const queue = lastOpponents(byLane.get(iddId) ?? []);
  let waiting = 0;
  while (queue.length) {
    const lane = queue.shift()!;
    if (seen.has(lane)) continue;
    seen.add(lane);
    const evs = byLane.get(lane) ?? [];
    if (reviewLoopState(evs).state === "awaiting_order") waiting += 1;
    queue.push(...lastOpponents(evs));
  }
  return waiting + 1;
}

export function rejectedOf(attrs: Attrs | undefined): RejectedItem[] {
  return laneAnswer<RejectedItem[]>("rejected_of", [], { attrs: attrs ?? null });
}

export function oscillationsOf(attrs: Attrs | undefined): OscillationItem[] {
  return laneAnswer<OscillationItem[]>("oscillations_of", [], { attrs: attrs ?? null });
}

export function boundariesOf(attrs: Attrs | undefined): BoundaryDecision[] {
  return laneAnswer<BoundaryDecision[]>("boundaries_of", [], { attrs: attrs ?? null });
}

/** a question a judgement put to penne (`escalated_claims`), named `Q-<n>` by its place in that judgement's list */
export interface EscalatedQuestion { ref: string; question: string }
/** penne's answer to one such question, recorded with the continue or the accept of the stop that asked it */
export interface AnsweredQuestion extends EscalatedQuestion { text: string }

/** the questions a `s2_triage_done` put to penne, each named by its place in the list */
export function escalatedQuestionsOf(attrs: Attrs | undefined): EscalatedQuestion[] {
  const list = Array.isArray(attrs?.escalated_claims) ? (attrs.escalated_claims as unknown[]) : [];
  return list.flatMap((q, n) => (typeof q === "string" && q.trim() ? [{ ref: `Q-${n + 1}`, question: q.trim() }] : []));
}

/**
 * The question whose answer the note of the stop the lane stands at is recorded as, or none: the card says so above its
 * one line, the write records the note as that question's answer, and the readers take an answer only where this
 * named the question at the stop it answered. A stop asks one when the review loop stands escalated (not a retry of a
 * stage that failed) at a judgement of the plan as it stands (after the lane's last return to its plan), unanswered
 * since, that put exactly one question to penne and found no reversal. A judgement with two questions, or with a
 * reversal whose boundary the same note may be, has no line of the card that says which part answers what, so its
 * note stays the executor's (cadf31509) until the card asks each question on a line of its own.
 */
export function questionAnsweredByNote(events: LifecycleRecord[], state: ReviewLoopState = reviewLoopState(events)): EscalatedQuestion[] {
  if (state.state !== "escalated" || state.retry) return [];
  const from = lastReturnToPlan(events);
  let t = -1;
  for (let i = events.length - 1; i > from; i -= 1) {
    if (events[i].event === "s2_triage_done" && !events[i].attrs?.failed) {
      t = i;
      break;
    }
  }
  if (t < 0 || events.slice(t + 1).some((e) => e.event === "s2_review_resumed")) return [];
  const asked = escalatedQuestionsOf(events[t].attrs);
  return asked.length === 1 && !oscillationsOf(events[t].attrs).length ? asked : [];
}

/**
 * The answers a `s2_review_resumed` recorded to the questions of the judgement it answered. Only the review loop's
 * readers in TS read them (the fold has no step that turns on them). An entry without a ref, a question or an answer
 * is skipped, not trusted. A record written before answers were recorded has none: its note stays the executor's.
 */
export function answeredQuestionsOf(attrs: Attrs | undefined): AnsweredQuestion[] {
  const list = Array.isArray(attrs?.answers) ? (attrs.answers as unknown[]) : [];
  return list.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const { ref, question, text } = a as Record<string, unknown>;
    return typeof ref === "string" && ref && typeof question === "string" && question.trim() && typeof text === "string" && text.trim()
      ? [{ ref, question: question.trim(), text: text.trim() }]
      : [];
  });
}

export function blocking(items: { severity: string }[]): number {
  return laneAnswer<number>("blocking", [], { items });
}

export function fixesNow(i: { severity: string; action?: unknown }): boolean {
  return laneAnswer<boolean>("fixes_now", [], { item: i });
}

export function isFollowup(i: { severity: string; action?: unknown }): boolean {
  return laneAnswer<boolean>("is_followup", [], { item: i });
}

export function fixCounts(items: { severity: string; action?: unknown }[]): { must: number; should: number } {
  return laneAnswer<{ must: number; should: number }>("fix_counts", [], { items });
}

export function withinLimit(must: number, should: number): boolean {
  return laneAnswer<boolean>("within_limit", [], { must, should });
}

export function passPolicy(events: LifecycleRecord[], i = events.length - 1): { closeOnMust: boolean; closeOnFix: boolean; maxFixRounds?: number; maxShouldFix?: number; depth?: import("../plan/depth.ts").Depth; start: number } {
  return laneAnswer("pass_policy", events, { i });
}

export function closesAt(events: LifecycleRecord[], i: number, c: { must: number; should: number }): boolean {
  return laneAnswer<boolean>("closes_at", events, { i, must: c.must, should: c.should });
}

export function overCapStop(a: Attrs | undefined, p: { closeOnFix: boolean; maxShouldFix?: number }): string | undefined {
  const answer = laneAnswer<string | null>("over_cap_stop", [], { attrs: a ?? null, policy: p });
  return answer ?? undefined;
}

export function feedbackPassAt(events: LifecycleRecord[], i = events.length - 1): number {
  return laneAnswer<number>("feedback_pass_at", events, { i });
}

export function blindEverRan(events: LifecycleRecord[]): boolean {
  return laneAnswer<boolean>("blind_ever_ran", events);
}

export function conflictSendBacks(events: LifecycleRecord[]): ConflictSendBack[] {
  return laneAnswer<ConflictSendBack[]>("conflict_send_backs", events);
}

export function firstBlindOfPass(events: LifecycleRecord[]): boolean {
  return laneAnswer<boolean>("first_blind_of_pass", events);
}

export function feedbackTriageOf(events: LifecycleRecord[]): LifecycleRecord | undefined {
  const at = laneAnswer<number>("feedback_triage_at", events);
  return at >= 0 ? events[at] : undefined;
}

export function s4Triage(events: LifecycleRecord[], i: number): boolean {
  return laneAnswer<boolean>("s4_triage", events, { i });
}

export function beginsFixRound(e: LifecycleRecord): boolean {
  return laneAnswer<boolean>("begins_fix_round", [], { event: e.event, attrs: e.attrs ?? null });
}

export function fixCapReached(events: LifecycleRecord[], opts: { forForecast?: boolean } = {}): FixCap | null {
  return laneAnswer<FixCap | null>("fix_cap", events, { forForecast: !!opts.forForecast });
}

export function stagnation(events: LifecycleRecord[]): string | null {
  return laneAnswer<string | null>("stagnation", events);
}

export function isReturnedResult(e: LifecycleRecord | undefined): boolean {
  if (!e) return false;
  return laneAnswer<boolean>("is_returned_result", [], { event: e.event, attrs: e.attrs ?? null });
}

export function reviewLoopState(events: LifecycleRecord[]): ReviewLoopState {
  return laneAnswer<ReviewLoopState>("state", events);
}

export function roleChangedIn(fallbacks: unknown): boolean {
  return laneAnswer<boolean>("role_changed_in", [], { fallbacks: fallbacks ?? null });
}

/**
 * The reason a record written right after penne's continue with nothing left to fix carries (`reason`, `fix_targets: 0`):
 * the convergence that ends the review there, or the final review it starts. Undefined for every other record.
 */
export function zeroFixMarks(events: LifecycleRecord[]): { reason: string; fix_targets: number } | undefined {
  return laneAnswer<{ reason: string; fix_targets: number } | null>("zero_fix_marks", events) ?? undefined;
}

/**
 * The checks' record the lane's stop is over (the loop stopped at it), or undefined when the lane is not stopped over
 * the checks before the convergence: the stuck card shows what they found instead of the last judgement's findings.
 */
export function checksStopOf(events: LifecycleRecord[]): Record<string, unknown> | undefined {
  return laneAnswer<Record<string, unknown> | null>("checks_stop", events) ?? undefined;
}

export function settledHead(events: LifecycleRecord[]): string | undefined {
  const head = laneAnswer<string | null>("settled_head", events);
  return head ?? undefined;
}

export function fixScope(events: LifecycleRecord[]): { source: FixSource; all: boolean; accepted: AcceptedItem[]; note: string; boundaries: BoundaryFix[] } {
  return laneAnswer("fix_scope", events);
}

export function answeredJudgementAt(events: LifecycleRecord[], r: number): number {
  return laneAnswer<number>("answered_judgement_at", events, { r });
}

export function fixAfter(events: LifecycleRecord[], i: number): LifecycleRecord | undefined {
  const at = laneAnswer<number>("fix_after", events, { i });
  return at >= 0 ? events[at] : undefined;
}

export function unfixedOf(events: LifecycleRecord[], t: number, fix: LifecycleRecord | undefined, note: string, s4 = false): Unfixed {
  return laneAnswer<Unfixed>("unfixed_of", events, { t, fix: fix ? fix.attrs ?? null : null, note, s4 });
}

export function followupsOf(events: LifecycleRecord[]): FollowupItem[] {
  return laneAnswer<FollowupItem[]>("followups_of", events);
}

export function shouldFixCounts(events: LifecycleRecord[]): ShouldFixCounts {
  return laneAnswer<ShouldFixCounts>("should_fix_counts", events);
}

export function submitLeftovers(events: LifecycleRecord[]): Leftover[] {
  return laneAnswer<Leftover[]>("submit_leftovers", events);
}

export function reviewRounds(events: LifecycleRecord[]): ReviewRound[] {
  return laneAnswer<ReviewRound[]>("review_rounds", events);
}

export function closedByPenne(events: LifecycleRecord[]): boolean {
  return laneAnswer<boolean>("closed_by_penne", events);
}

/**
 * Where an answer takes a lane stopped in the loop, found by appending it to the record and following the same
 * transition the loop runs (through the steps that start nothing). The answer itself is the caller's, so this
 * stays here; every state it reads comes from the MoonBit loop.
 */
export function answerOutcome(events: LifecycleRecord[], answer: { decision: "continue" | "accept" | "hand_fix" | "replan"; note?: string }, env: AnswerEnv): StuckOutcome | undefined {
  const prior = reviewLoopState(events);
  if (prior.state !== "escalated") return undefined;
  if (answer.decision === "hand_fix") return { to: "hand" };
  // the lane goes back to its plan: no round is run, and the plan is reviewed and gone through the GO again
  if (answer.decision === "replan") return { to: "plan" };
  const mark = (event: string, attrs: Attrs = {}): LifecycleRecord => ({ event, idd_id: events[events.length - 1]?.idd_id ?? "", at: "", attrs });
  const evs = [...events, mark("s2_review_resumed", { decision: answer.decision, note: answer.note ?? "" })];
  const t = answeredJudgementAt(evs, evs.length - 1);
  const leftOf = (fix?: LifecycleRecord): LeftCount => {
    if (t < 0) return { accepted: 0, questions: 0, reversals: 0 };
    const u = unfixedOf(evs, t, fix, answer.decision === "accept" ? "" : answer.note ?? "", s4Triage(evs, t));
    return { accepted: u.accepted.length, questions: u.questions.length, reversals: u.reversals.length };
  };
  let s = reviewLoopState(evs);
  const retry = !!prior.retry && answer.decision === "continue";
  const retryOut = (): StuckOutcome => ({ to: "retry", ...(prior.quotaWait ? { highFallback: true } : {}) });
  // a stop over the checks before the convergence: a continue runs them again (a cap stop sends their failures, below),
  // an accept goes where the checks were taking the lane (the convergence, or a round the mainline's merge skipped)
  const overChecks = checksStopOf(evs) !== undefined;
  if (overChecks && answer.decision === "continue" && s.state !== "send_fix") return { to: "checks" };
  if (overChecks && answer.decision === "accept" && s.state === "start_blind") return { to: "close", device: "none", left: leftOf() };
  if (s.state === "send_fix") {
    if (retry) return retryOut();
    const scope = fixScope(evs);
    const refs = scope.accepted.map((a) => a.ref);
    const fix = mark("s2_fix_sent", { refs, boundary_refs: scope.boundaries.map((b) => b.ref) });
    return { to: "fix", all: scope.all, refs, boundaries: scope.boundaries.length, note: !!scope.note.trim(), left: leftOf(fix) };
  }
  if (s.state === "start_blind" && s.kind === "final") {
    if (!env.skipsFinal(evs)) return retry ? retryOut() : { to: "final", left: leftOf() };
    evs.push(mark("s2_review_converged"));
    s = reviewLoopState(evs);
  }
  if (s.state === "converge") {
    evs.push(mark("s2_review_converged"));
    s = reviewLoopState(evs);
  }
  if (s.state === "start_device" && !(retry && prior.retry?.state === "start_device")) {
    const device = !env.deviceOn ? "none" : events.some((e) => e.event === "s2_device_started") ? "again" : "first";
    return { to: "close", device, left: leftOf() };
  }
  if (s.state === "done" && !retry) return { to: "close", device: "none", left: leftOf() };
  return retryOut();
}

/**
 * What a judgement needs from outside the ledger: the kind of reading and the values it is asked about. The
 * judgement names the facts it cannot decide without, and the caller reads only those (C-200-1, C-200-2).
 */
export interface FactNeed {
  id: string;
  kind: string;
  a: string;
  b: string;
}

/** the answer a judgement gives: what it decided, and the facts it still wants */
export type JudgementAnswer = { needs?: FactNeed[] } & Record<string, unknown>;

/**
 * How many times a judgement is asked before the caller gives up. A judgement collects every fact it cannot answer
 * without in one round (the order check asks for all its trial merges at once), so one round per fact is all it
 * needs; the rounds left over are for a fact that itself uncovers another.
 */
const FACT_ROUNDS = 8;

/**
 * Ask a judgement and read the facts it asks for. The judgement answers what it can, names the facts it cannot
 * decide without, and the caller reads only those and asks again. A fact is a value: git's answer, the check's
 * output, the lane's Risk — never a decision. Nothing here falls back to a judgement written in TypeScript: a
 * fold that cannot be read is a failure the caller sees (C-186-2).
 */
export function judgeSync<T extends JudgementAnswer>(
  op: string,
  events: LifecycleRecord[],
  args: Record<string, unknown>,
  read: (need: FactNeed) => unknown,
): T {
  const facts: Record<string, unknown> = { ...((args.facts as Record<string, unknown> | undefined) ?? {}) };
  for (let round = 0; round < FACT_ROUNDS; round += 1) {
    const answer = laneAnswer<T>(op, events, { ...args, facts });
    const needs = answer.needs ?? [];
    if (!needs.length) return answer;
    for (const need of needs) {
      if (facts[need.id] !== undefined) continue;
      facts[need.id] = read(need);
    }
  }
  throw new Error(`MoonBit の畳み（${op}）が答えを返しませんでした`);
}

/** the same, for a judgement whose facts are read by a process (the records check) */
export async function judge<T extends JudgementAnswer>(
  op: string,
  events: LifecycleRecord[],
  args: Record<string, unknown>,
  read: (need: FactNeed) => unknown | Promise<unknown>,
): Promise<T> {
  const facts: Record<string, unknown> = { ...((args.facts as Record<string, unknown> | undefined) ?? {}) };
  for (let round = 0; round < FACT_ROUNDS; round += 1) {
    const answer = laneAnswer<T>(op, events, { ...args, facts });
    const needs = answer.needs ?? [];
    if (!needs.length) return answer;
    for (const need of needs) {
      if (facts[need.id] !== undefined) continue;
      facts[need.id] = await read(need);
    }
  }
  throw new Error(`MoonBit の畳み（${op}）が答えを返しませんでした`);
}

/** label for the lane list while the loop runs (a display of the answer, not a judgement) */
export function reviewLoopLabel(s: ReviewLoopState, rank?: number): string | undefined {
  switch (s.state) {
    case "start_blind":
      return s.kind === "final" ? "最後のレビュー待ち" : `レビュー待ち（${s.round} 巡目）`;
    case "running_blind": return s.kind === "final" ? "最後のレビュー中" : s.kind === "device" ? "絵の見比べ中" : `レビュー中（${s.round} 巡目）`;
    case "running_map": return "危ない経路の下調べ中";
    case "start_triage":
    case "running_triage": return s.kind === "feedback" ? "PR の指摘の判定中" : "指摘の判定中";
    case "send_fix":
    case "fixing": return `修正中（${s.round} 巡目）`;
    case "start_confirm":
    case "running_confirm": return "修正の確認中";
    case "awaiting_merge": return "衝突の解消中";
    case "awaiting_records_fix": return "記録の直し待ち";
    case "recheck_intent": return "記録の再検査中";
    case "awaiting_order": {
      const lanes = s.opponents.map((o) => o.lane).join("、") || "先の lane";
      const files = [...new Set(s.opponents.flatMap((o) => o.files))];
      const shown = `${files.slice(0, 3).join("、")}${files.length > 3 ? ` ほか ${files.length - 3} 件` : ""}`;
      const parts = [rank !== undefined ? `${rank} 番目` : "", files.length ? shown : ""].filter(Boolean);
      return `${lanes} の取り込みを待っている${parts.length ? `（${parts.join("・")}）` : ""}`;
    }
    case "start_device":
    case "running_device": return "絵の見比べ中";
    case "running_checks": return "検査中";
    default: return undefined;
  }
}

/** whether the lane's last failed start is too recent to try again (only while failures are counting) */
export function startRetryWaiting(events: LifecycleRecord[], now = Date.now()): boolean {
  return laneAnswer<boolean>("start_retry_waiting", events, { now });
}

/** consecutive start failures since the last loop event (they are recorded but do not move the state) */
export function startFailures(events: LifecycleRecord[]): number {
  return laneAnswer<number>("start_failures", events);
}

/** lanes that go through this loop (as opposed to lanes that reached S3 before it existed) */
export function isLoopLane(events: LifecycleRecord[]): boolean {
  return laneAnswer<boolean>("is_loop_lane", events);
}

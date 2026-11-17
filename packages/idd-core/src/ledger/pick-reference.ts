import type { LifecycleRecord } from "../schema/records.ts";
import { LANE_NOTE_EVENTS, laneBudget, laneBudgetIdle, laneHeld } from "./derive-reference.ts";
import { isLoopLane, isReturnedResult, reviewLoopState } from "./review-loop-reference.ts";
import { currentLandApprovalReference } from "../overlay/land-reads-reference.ts";
import { laneTurnReference, quotaHoldReference, stageReference, type LaneFacts, type QuotaFact } from "./turn-reference.ts";

/**
 * The stages' answer to "do you pick this lane up?", as the TypeScript read it before the MoonBit fold took
 * the reading over. It is not on the running path: the cross-check (`packages/idd-fold/crosscheck.mjs`) holds it
 * against the MoonBit answer on every prefix of a real ledger and on the committed fixtures, and the gate's
 * fixture test holds both against each other (C-199-2).
 *
 * The facts are the ones the ledger does not hold: whether a session exists, whether the repo publishes, what
 * the worktree's head is, what the lane has spent, how deep the lane is, and the readings of the outside world
 * (C-199-3).
 */

/** the answer of a stage: whether it picks the lane up, and why it leaves it when it does not */
export interface PickAnswerReference {
  pick: boolean;
  reason?: string;
  /** the step the stage takes, when the stage has more than one */
  branch?: string;
}

/** the facts a stage reads that the ledger does not hold */
export interface PickFactsReference {
  hasSession?: boolean;
  publishes?: boolean;
  hasWorktree?: boolean;
  hasHead?: boolean;
  hasLocation?: boolean;
  hasBlockers?: boolean;
  blocked?: boolean;
  depth?: string;
  cost?: number;
  base?: number;
  lane?: string;
  purposes?: { status: string; raisedBy: string | null }[];
  choices?: { id: string; places: { kind: string; file?: string }[] }[];
  laneRows?: { supersedes: string[] }[];
  lastBatchAnswered?: boolean;
  pendingFixEnvelope?: boolean;
  targetRole?: string | null;
  awaitedRole?: string | null;
  reloadHold?: boolean;
  waitingSlot?: boolean;
  worktreeBusy?: boolean;
  pendingEnvelope?: boolean;
  cardBuildable?: boolean;
  awaitedAgent?: { role: "executor" | "planner" } | null;
}

function lastIndex(events: { event: string }[], name: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return i;
  return -1;
}

function no(reason: string): PickAnswerReference {
  return { pick: false, reason };
}

function yes(branch?: string): PickAnswerReference {
  return branch ? { pick: true, branch } : { pick: true };
}

/** the planner's start */
export function pickPlannerReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (facts.hasSession) return no("planner の session がある");
  const stage = stageReference(events, quota);
  if (stage.group !== "prep") return no("段が prep ではない");
  if (stage.decision) return no("card が上がっている");
  return yes();
}

/** the executor's start */
export function pickExecutorReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (facts.hasSession) return no("executor の session がある");
  if (stageReference(events, quota).group !== "impl") return no("段が impl ではない");
  return yes();
}

/** the S3 check */
export function pickCheckReference(events: LifecycleRecord[]): PickAnswerReference {
  if (lastIndex(events, "s2_result") <= lastIndex(events, "s3_ready")) return no("S2 の結果が S3 の準備より前");
  if (reviewLoopState(events).state !== "done") return no("レビューが収束していない");
  if (laneHeld(events)) return no("保留されている");
  return yes();
}

/** the submit's preparation */
export function pickSubmitPrepReference(events: LifecycleRecord[], _facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  const stage = stageReference(events, quota);
  if (stage.group === "impl" && stage.stageDone === 4) return yes("reopen");
  if (!isLoopLane(events)) return no("ループの lane ではない");
  if (laneHeld(events)) return no("保留されている");
  if (events.some((e) => ["lane_close", "s1_defer", "s3_defer"].includes(e.event))) return no("lane が閉じている");
  if (reviewLoopState(events).state !== "done") return no("レビューが収束していない");
  const ready = lastIndex(events, "s3_ready");
  if (ready < 0) return no("S3 の準備がまだない");
  const latest = Math.max(lastIndex(events, "s3_ok"), lastIndex(events, "s4_submit_started"));
  if (ready < latest) return no("S3 はもう始まっている");
  if (lastIndex(events, "s4_verify_user_judgment_answered") > ready) return no("差し戻しの返答を待っている");
  return yes("prepare");
}

/** the push's preparation */
export function pickSubmitPushReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (!facts.publishes) return no("公開しない repo");
  if (laneHeld(events)) return no("保留されている");
  if (stageReference(events, quota).decision !== "ship") return no("提出前確認の段にない");
  if (facts.hasWorktree === false) return no("worktree がない");
  if (facts.hasHead === false) return no("head がない");
  return yes();
}

/** the landing's check */
export function pickLandReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (laneHeld(events)) return no("保留されている");
  if (events.some((e) => e.event === "lane_close")) return no("lane が閉じている");
  if (!facts.hasLocation) return no("置き場所がない");
  if (facts.publishes) return no("公開する repo は push を通す");
  if (currentLandApprovalReference(events)) return no("署名済みの承認がある");
  if (stageReference(events, quota).decision !== "ship") return no("提出前確認の段にない");
  return yes();
}

/** the landing's carried approval */
export function pickLandCarryReference(events: LifecycleRecord[], facts: PickFactsReference): PickAnswerReference {
  if (laneHeld(events)) return no("保留されている");
  if (events.some((e) => e.event === "lane_close")) return no("lane が閉じている");
  if (!facts.hasLocation) return no("置き場所がない");
  if (facts.publishes) return no("公開する repo は push を通す");
  if (!currentLandApprovalReference(events)) return no("署名済みの承認がない");
  return yes();
}

/** the premises a lane must not move alone: the root, and a dir's own Choice (a module with no file mark) */
function isRootOrDirPlace(place: { kind: string; file?: string }): boolean {
  if (place.kind === "root" || place.kind === "dir") return true;
  return place.kind === "module" && !place.file;
}

/** whether the choice the id names has a root or dir place among its places */
function choiceIsRootOrDir(choices: PickFactsReference["choices"], id: string): boolean {
  for (const choice of choices ?? []) {
    if (choice.id !== id) continue;
    if (choice.places.some(isRootOrDirPlace)) return true;
  }
  return false;
}

/** whether the lane's own rows supersede a choice that has a root or dir place */
function laneSupersedesRoot(facts: PickFactsReference): boolean {
  for (const row of facts.laneRows ?? []) {
    for (const id of row.supersedes) {
      if (choiceIsRootOrDir(facts.choices, id)) return true;
    }
  }
  return false;
}

/** whether the plan the lane shows now has a draft that supersedes a choice that has a root or dir place */
function draftSupersedesRoot(events: LifecycleRecord[], facts: PickFactsReference): boolean {
  const last = [...events].reverse().find((e) => e.event === "s1_ready");
  const raw = last?.attrs?.plan_records;
  if (!raw || typeof raw !== "object") return false;
  const body = raw as Record<string, unknown>;
  const drafts = Array.isArray(body.choices) ? (body.choices as { supersedes?: { ids?: string[] } }[]) : [];
  for (const draft of drafts) {
    for (const id of draft.supersedes?.ids ?? []) {
      if (choiceIsRootOrDir(facts.choices, id)) return true;
    }
  }
  return false;
}

/** whether the plan the lane shows now has a review that finished without failing */
function currentPlanReviewed(events: LifecycleRecord[]): boolean {
  let lastReady = -1;
  for (let i = 0; i < events.length; i += 1) if (events[i].event === "s1_ready") lastReady = i;
  if (lastReady < 0) return false;
  for (let i = lastReady + 1; i < events.length; i += 1) {
    if (events[i].event === "s1_plan_review_done" && !events[i].attrs?.failed) return true;
  }
  return false;
}

/** the automatic GO */
export function pickAutoGoReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (events.some((e) => e.event === "s1_go" || e.event === "lane_close" || e.event === "s1_defer")) return no("GO の記録がある");
  if (stageReference(events, quota).decision !== "go") return no("GO 待ちの lane ではない");
  if (facts.blocked) return no("blocker が着地するまで GO できない");
  if (facts.depth !== "shallow") return no("深さが浅くないので、GO は人が押す");
  if (events.some((e) => e.event === "question_batch_asked")) return no("計画役が計画の間に質問を出した");
  for (const purpose of facts.purposes ?? []) {
    if (purpose.status === "proposed" && purpose.raisedBy === facts.lane) return no("この lane が立てた未確認の Purpose の案がある");
    if (purpose.status === "withdrawn" && purpose.raisedBy === facts.lane) return no("取り下げた Purpose の案がある（GO は人が押す）");
  }
  if (laneSupersedesRoot(facts)) return no("root か dir の Choice を Supersede する案がある");
  if (draftSupersedesRoot(events, facts)) return no("root か dir の Choice を Supersede する案がある");
  if (!currentPlanReviewed(events)) return no("いまの計画の査読が済んでいない");
  return yes();
}

/** the budget's stop */
export function pickBudgetReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  const stage = stageReference(events, quota);
  if (stage.group === "closed") return no("lane が閉じている");
  if (stage.decision === "stuck") return no("止まっている");
  if (laneBudgetIdle(events)) return no("待つだけの lane");
  const cost = facts.cost ?? 0;
  const limit = laneBudget(events, facts.base ?? 0);
  if (cost <= limit) return no("予算之内");
  return yes();
}

/** the blocker's wait */
export function pickBlockerReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (!events.length) return no("記録がない");
  if (events.some((e) => e.event === "lane_close" || e.event === "s1_defer" || e.event === "s3_defer")) return no("lane が終わっている");
  const notes = events.filter((e) => !LANE_NOTE_EVENTS.includes(e.event));
  const last = notes[notes.length - 1];
  if (isReturnedResult(last)) return yes();
  if (last?.event === "blocked_by_dependency") return yes();
  if (facts.hasBlockers && stageReference(events, quota).decision === "go") return yes();
  return no("blocker を待つ lane ではない");
}

/** the PR's feedback */
export function pickPrFeedbackReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (events.some((e) => e.event === "lane_close" || e.event === "s3_defer")) return no("lane が閉じている");
  if (laneHeld(events)) return no("保留されている");
  const stage = stageReference(events, quota);
  if (stage.group !== "waiting" || stage.stageDone !== 5 || stage.stageCurrent !== null) return no("PR を待つ段ではない");
  if (lastIndex(events, "s4_pr_created") < 0) return no("PR がない");
  if (facts.lastBatchAnswered === false) return no("前の指摘への返信がまだ終わっていない");
  return yes();
}

/** the watch's resume */
export function pickWatchReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  const stage = stageReference(events, quota);
  if (stage.group === "closed") return no("lane が閉じている");
  if (stage.decision === "stuck") return no("止まっている");
  if (!facts.awaitedRole) return no("待っている agent がない");
  if (facts.pendingFixEnvelope) return no("修正の封筒がまだ配ってない");
  if (!facts.targetRole) return no("起こす session がない");
  if (facts.awaitedRole !== facts.targetRole) return no("起こす session の役が待ちの役と違う");
  return yes();
}

/** the stall watch */
export function pickStallReference(events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  if (!events.length) return no("記録がない");
  const stage = stageReference(events, quota);
  if (stage.group === "closed") return no("lane が閉じている");
  if (facts.reloadHold && stage.group === "prep") return no("入れ替えの待ち");
  if (laneHeld(events)) return no("保留されている");
  const turn = laneTurnReference(events, {
    pendingEnvelope: facts.pendingEnvelope,
    cardBuildable: facts.cardBuildable,
    awaitedAgent: facts.awaitedAgent,
  } as LaneFacts, quota);
  if (turn !== "engine") return no("engine の番ではない");
  if (facts.waitingSlot) return no("枠待ち");
  const notes = events.filter((e) => !LANE_NOTE_EVENTS.includes(e.event));
  if (quotaHoldReference(notes[notes.length - 1], quota).held) return no("Claude の枠待ち");
  if (facts.worktreeBusy) return no("worktree が動いている");
  return yes();
}

/** the landing's own question, read from the ledger alone (C-202-5) */
export function pickLandLedgerReference(events: LifecycleRecord[], quota: QuotaFact): PickAnswerReference {
  if (laneHeld(events)) return no("保留されている");
  if (events.some((e) => e.event === "lane_close")) return no("lane が閉じている");
  if (currentLandApprovalReference(events) !== null) return no("署名済みの承認がある");
  if (stageReference(events, quota).decision !== "ship") return no("提出前確認の段にない");
  return yes();
}

/** the landing's carried approval, read from the ledger alone (C-202-5) */
export function pickLandCarryLedgerReference(events: LifecycleRecord[]): PickAnswerReference {
  if (laneHeld(events)) return no("保留されている");
  if (events.some((e) => e.event === "lane_close")) return no("lane が閉じている");
  if (currentLandApprovalReference(events) === null) return no("署名済みの承認がない");
  return yes();
}

/** the answer of the stage a caller names */
export function pickReference(stage: string, events: LifecycleRecord[], facts: PickFactsReference, quota: QuotaFact): PickAnswerReference {
  switch (stage) {
    case "prep": return pickPlannerReference(events, facts, quota);
    case "exec": return pickExecutorReference(events, facts, quota);
    case "check": return pickCheckReference(events);
    case "submit_prep": return pickSubmitPrepReference(events, facts, quota);
    case "submit_push": return pickSubmitPushReference(events, facts, quota);
    case "land": return pickLandReference(events, facts, quota);
    case "land_ledger": return pickLandLedgerReference(events, quota);
    case "land_carry": return pickLandCarryReference(events, facts);
    case "land_carry_ledger": return pickLandCarryLedgerReference(events);
    case "auto_go": return pickAutoGoReference(events, facts, quota);
    case "budget": return pickBudgetReference(events, facts, quota);
    case "blocker": return pickBlockerReference(events, facts, quota);
    case "pr_feedback": return pickPrFeedbackReference(events, facts, quota);
    case "watch": return pickWatchReference(events, facts, quota);
    case "stall": return pickStallReference(events, facts, quota);
    default: return { pick: false, reason: `知らない段: ${stage}` };
  }
}

/**
 * The lanes whose signature is still in force, in the order the ledger records it: the last approval of each
 * lane, in the order the approvals were written.
 */
export function landOrderReference(events: LifecycleRecord[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event !== "s4_land_approved" || seen.has(e.idd_id)) continue;
    seen.add(e.idd_id);
    order.unshift(e.idd_id);
  }
  return order;
}

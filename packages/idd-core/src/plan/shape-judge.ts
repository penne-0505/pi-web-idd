import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../paths.ts";
import { pipelineConcurrency, pipelineSlotDeclared } from "../config/pipeline.ts";
import { getAgentRunner } from "../agent/port.ts";
import { laneHeld, roundTrace, type RoundTraceLine } from "../ledger/derive.ts";
import { reviewLoopState } from "../ledger/review-loop.ts";
import { lastReturnToPlan, returnsToPlan } from "../ledger/replan-view.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { inStartOrder } from "../ledger/start-order.ts";
import { appendLifecycle } from "../ledger/write.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { writeLaneChoicesFile } from "./lane-intent.ts";
import { lanePlanDoc } from "./plan-doc.ts";
import { planReviewInputs } from "./plan-review.ts";
import { laneRecordShape } from "./record-shape.ts";
import { laneRevs } from "./review-loop.ts";

/**
 * The shape judge of a stopped round (C-252-1, C-252-3). The same role the deep plan review runs beside its reviewers
 * reads the lane's per-round lines and recommends one of three answers for the card: keep fixing, accept and leave
 * the rest for later, or go back to the plan. The recommendation never answers for penne: a judge that did not run
 * leaves the card with the answers it always had, and the fact that it did not run is on record (C-252-6).
 *
 * Two triggers start it, both from the ledger alone:
 * - the loop stopped for its own reason (the rounds' cap, a stagnation): the card is up and the judge reads the rounds;
 * - a symptom shows in the rounds before the cap (the accepted count has not fallen for two rounds, the same file was
 *   named two rounds running, a round changed a file outside the plan's list, the plan was reviewed more than three
 *   times). The lane waits at the point the fix would be sent, the judge reads, and a recommendation other than
 *   "keep fixing" stops the lane at the card early.
 * A stop for the budget, a stall or a halt is a lane the loop does not hold at its card, and the judge is not started.
 */

/** the events the judge writes: neither moves the review loop (they are notes on the lane, like the fix plan's) */
export const SHAPE_STARTED = "s2_shape_started";
export const SHAPE_JUDGED = "s2_shape_judged";

export type ShapeChoice = "continue" | "accept" | "replan";
export type ShapeReasonKind = "round" | "accepted" | "file" | "outside" | "changed";

/** one line of the grounds: it names a value of the ledger's rounds, never a sentence of the judge's own */
export interface ShapeReason {
  kind: ShapeReasonKind;
  ref: string;
  text: string;
}

export interface ShapeRecommendation {
  choice: ShapeChoice;
  reasons: ShapeReason[];
  /** the shape the plan could be rebuilt in, when the judge recommends going back to the plan */
  shape?: string;
}

const CHOICES: readonly ShapeChoice[] = ["continue", "accept", "replan"];
const KINDS: readonly ShapeReasonKind[] = ["round", "accepted", "file", "outside", "changed"];

/** the plan reviews a lane went through before the judge is called a symptom */
const PLAN_REVIEWS_OVER = 3;

const accepted = (line: RoundTraceLine): number => line.accepted_must + line.accepted_should;

/** one symptom of the rounds: its kind, the files it names (none for a count), and the line the judge and the log read */
export interface ShapeSymptom {
  kind: "accepted" | "file" | "outside" | "reviews";
  files: string[];
  text: string;
}

/**
 * What the rounds show that Issue #293 named: the accepted count has not fallen over the last two rounds, the same
 * file was named in two rounds running, the newest round changed a file outside the plan's list, or the plan was
 * reviewed more than three times. Read from the lines and the review count only, so the same ledger gives the same list.
 */
export function shapeSymptomItems(lines: readonly RoundTraceLine[], planReviews: number): ShapeSymptom[] {
  const out: ShapeSymptom[] = [];
  const n = lines.length;
  if (n >= 3 && accepted(lines[n - 1]!) >= accepted(lines[n - 2]!) && accepted(lines[n - 2]!) >= accepted(lines[n - 3]!)) out.push({ kind: "accepted", files: [], text: "受理数が 2 巡続けて減っていない" });
  if (n >= 2) {
    const before = new Set(lines[n - 2]!.named_files);
    const again = lines[n - 1]!.named_files.filter((f) => before.has(f));
    if (again.length) out.push({ kind: "file", files: again, text: `同じ file の指摘が 2 巡続いた: ${again.join(", ")}` });
  }
  if (n >= 1 && lines[n - 1]!.outside_scope.length) out.push({ kind: "outside", files: lines[n - 1]!.outside_scope, text: `計画の範囲の外の file に実装が出た: ${lines[n - 1]!.outside_scope.join(", ")}` });
  if (planReviews > PLAN_REVIEWS_OVER) out.push({ kind: "reviews", files: [], text: `計画の査読が ${PLAN_REVIEWS_OVER} 回を超えた（${planReviews} 回）` });
  return out;
}

/** the symptoms as the lines the judge and the log read */
export function shapeSymptoms(lines: readonly RoundTraceLine[], planReviews: number): string[] {
  return shapeSymptomItems(lines, planReviews).map((s) => s.text);
}

/**
 * The symptoms as the things a person can have let through: a kind, and for a file symptom each file on its own. The
 * same kind with one more file is a new symptom, and the same kind on the next round with the same files is not; the
 * count a plan was reviewed (3 times, then 4) is one symptom whatever the count.
 */
function symptomAtoms(items: readonly ShapeSymptom[]): string[] {
  return items.flatMap((s) => (s.files.length ? s.files.map((f) => `${s.kind}:${f}`) : [s.kind]));
}

/**
 * The plan reviews of the plan the lane has now: a return to the plan, or a send-back of the plan from the GO card,
 * builds the plan anew, so the reviews before the last of them are not counted (the whole lane's count stays in the
 * rounds' lines). Counting them would make a plan that has been reviewed once since then a symptom, and the rebuild
 * would have changed nothing. The review that follows the resubmitted plan is counted.
 */
export function planReviewsOf(events: readonly LifecycleRecord[]): number {
  const names = events.map((e) => e.event);
  const from = Math.max(lastReturnToPlan(events), names.lastIndexOf("s1_revise_requested"));
  return events.slice(from + 1).filter((e) => e.event === "s1_plan_review_done").length;
}

/**
 * How many times the lane went back to its plan. The fold names a round by this count and its number, so the rounds a
 * return numbered again are not the rounds before it.
 */
export function replanCycleOf(events: readonly LifecycleRecord[]): number {
  return events.filter(returnsToPlan).length;
}

/**
 * The lines of the plan the lane has now. A return to the plan numbers the rounds from 1 again, so a round number alone
 * names two rounds; the judge reads, and a ground resolves against, only the cycle the lane is in. The cycle is counted
 * from the returns in the ledger, not read off the lines: right after a return no line of the new cycle exists yet, and
 * the newest line would be an old one.
 */
export function currentCycleLines(lines: readonly RoundTraceLine[], cycle: number): RoundTraceLine[] {
  return lines.filter((l) => l.cycle === cycle);
}

/** the lines the judge reads for a lane: the whole lane's lines cut to the cycle it is in, and how many rounds the cycles before it held */
function shapeLines(rec: BacklogRecord, evs: LifecycleRecord[]): { lines: RoundTraceLine[]; earlier: number } {
  const all = roundTrace(evs);
  const lines = currentCycleLines(all, replanCycleOf(evs));
  return { lines, earlier: all.length - lines.length };
}

/** the line a ground states: the ledger's own values, worded here, so the card never shows a number the judge made up */
function groundText(kind: ShapeReasonKind, ref: string, lines: readonly RoundTraceLine[]): string | undefined {
  if (kind === "file" || kind === "outside") {
    const rounds = lines.filter((l) => (kind === "file" ? l.named_files : l.outside_scope).includes(ref)).map((l) => l.round);
    if (!rounds.length) return undefined;
    return `${kind === "file" ? "指摘が名指した file" : "計画の範囲の外に出た file"}: ${ref}（巡 ${rounds.join(", ")}）`;
  }
  const at = lines.find((l) => String(l.round) === ref);
  if (!at) return undefined;
  if (kind === "accepted") return `巡 ${at.round} の受理数: must ${at.accepted_must} / should ${at.accepted_should}`;
  if (kind === "changed") return `巡 ${at.round} の変更 file の数: ${at.changed_files}`;
  return `巡 ${at.round}（${at.kind}）: 受理 must ${at.accepted_must} / should ${at.accepted_should}、変更 file ${at.changed_files} 件`;
}

/**
 * The recommendation with only the grounds the ledger backs: a reason names a round the lines hold, a file the rounds
 * named, or a file the rounds changed outside the plan, and the line it shows is written from those values — the
 * judge's own sentence is not kept, so a number that is not in the ledger cannot reach a card. Any other reason is
 * dropped before it reaches the record. A recommendation left with no ground is not one (undefined), nor is a
 * recommendation to go back to the plan with no shape to rebuild it in: a card must not show an answer nobody can count
 * back, or ask for a replan without saying what the plan becomes.
 */
export function groundRecommendation(raw: unknown, lines: readonly RoundTraceLine[]): ShapeRecommendation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!CHOICES.includes(r.choice as ShapeChoice)) return undefined;
  const reasons: ShapeReason[] = [];
  for (const item of Array.isArray(r.reasons) ? r.reasons : []) {
    if (!item || typeof item !== "object") continue;
    const x = item as Record<string, unknown>;
    const kind = x.kind as ShapeReasonKind;
    if (!KINDS.includes(kind)) continue;
    const raw = String(x.ref ?? "").trim();
    const ref = kind === "file" || kind === "outside" ? raw : raw.replace(/^R/i, "");
    const text = ref ? groundText(kind, ref, lines) : undefined;
    if (text) reasons.push({ kind, ref, text });
  }
  if (!reasons.length) return undefined;
  const shape = typeof r.shape === "string" ? r.shape.trim() : "";
  if (r.choice === "replan" && !shape) return undefined;
  return { choice: r.choice as ShapeChoice, reasons, ...(r.choice === "replan" ? { shape } : {}) };
}

/** the rounds file the judge reads: the lane's lines as the ledger gives them, and nothing the judge could mistake for its own */
export function shapeRoundsText(lines: readonly RoundTraceLine[], planReviews: number, symptoms: readonly string[], earlierRounds = 0): string {
  return [
    "# 巡ごとの行（台帳から機械で作った値）",
    "",
    // only the cycle the lane is in is listed, so every round a ground names resolves to it
    ...(earlierRounds ? [`- 計画へ戻る前の巡: ${earlierRounds} 巡（この一覧には載せない）`] : []),
    `- 今の計画の査読（最後に計画へ戻ってから）: ${planReviews} 回`,
    `- 症状: ${symptoms.length ? symptoms.join(" / ") : "なし（上限か停滞で止まった）"}`,
    "",
    ...lines.map((l) => `- 巡 ${l.round}（${l.kind}）: 受理 must ${l.accepted_must} / should ${l.accepted_should}。名指した file: ${l.named_files.join(", ") || "なし"}。計画の範囲の外の file: ${l.outside_scope.join(", ") || "なし"}。変更 file の数: ${l.changed_files}`),
    "",
  ].join("\n");
}

/** the events that answer a stop or move the lane to another one: a judgement started before them is not for what comes after */
const MOVES_ON = ["s2_fix_sent", "s2_review_resumed", "s2_review_escalated"];

/** whether the lane moved on (answered its card, or stopped again) after the run `runId` was started, within `events` */
function movedOnSince(events: readonly LifecycleRecord[], runId: string): boolean {
  const at = events.findIndex((e) => e.event === SHAPE_STARTED && String(e.attrs?.run_id ?? "") === runId);
  return at >= 0 && events.slice(at + 1).some((e) => MOVES_ON.includes(e.event) || returnsToPlan(e));
}

/**
 * The judgement the lane's card shows now: the newest one no fix or answer has come after, with a recommendation in it.
 * A judgement that came after an answer to the stop it was started for (a run that finished late) belongs to that
 * stop, not to the card now, so it is not shown even when it is the newest record.
 */
export function shapeRecommendationOf(events: readonly LifecycleRecord[]): ShapeRecommendation | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === "s2_fix_sent" || e.event === "s2_review_resumed" || returnsToPlan(e)) return undefined;
    if (e.event !== SHAPE_JUDGED) continue;
    const runId = String(e.attrs?.run_id ?? "");
    if (runId && movedOnSince(events.slice(0, i), runId)) return undefined;
    const r = e.attrs?.recommendation;
    return r && typeof r === "object" ? (r as ShapeRecommendation) : undefined;
  }
  return undefined;
}

/** a started run nobody has closed yet: its id and the round it was started for */
function pendingRun(events: readonly LifecycleRecord[]): { runId: string; round: number; trigger: string } | undefined {
  const closed = new Set<string>();
  let open: { runId: string; round: number; trigger: string } | undefined;
  for (const e of events) {
    const id = String(e.attrs?.run_id ?? "");
    if (e.event === SHAPE_JUDGED) closed.add(id);
    if (e.event === SHAPE_STARTED && id) open = { runId: id, round: Number(e.attrs?.round ?? 0), trigger: String(e.attrs?.trigger ?? "") };
  }
  return open && !closed.has(open.runId) ? open : undefined;
}

export interface ShapeJudgeResult {
  /** lanes the review loop leaves alone this tick: a judge is running for them, or about to be started */
  hold: Set<string>;
  started: string[];
  judged: string[];
  errors: { iddId: string; error: string }[];
}

/** what the judge is shown: the plan, the contract, the context document and the rounds file */
function shapeInputs(rec: BacklogRecord, events: LifecycleRecord[], worktree: string, roundsFile: string): string[] {
  const shape = laneRecordShape(rec.idd_id, events);
  const contract = planReviewInputs(rec);
  const plan = lanePlanDoc(rec, worktree);
  const choices = shape === "state" ? writeLaneChoicesFile(rec, `shape-${events.length}`) : undefined;
  const files = [
    ...(plan ? [join(worktree, plan.rel)] : []),
    ...(shape === "state" ? [...(choices ? [choices] : []), ...(contract[1] ? [join(worktree, contract[1])] : [])] : contract.slice(0, 2).map((p) => join(worktree, p))),
    ...(contract[3] ? [join(worktree, contract[3])] : []),
    roundsFile,
  ];
  return files.filter((p) => existsSync(p));
}

/** the closing record of a judgement that could not give a recommendation: the lane goes on with the answers it always had */
async function recordUnavailable(iddId: string, runId: string | undefined, round: number, trigger: string, reason: string): Promise<void> {
  await appendLifecycle(SHAPE_JUDGED, iddId, { round, trigger, ...(runId ? { run_id: runId } : {}), unavailable: true, reason: reason.slice(0, 300) });
}

/**
 * One pass over the lanes: close the judge runs that finished, and start one for a lane that is at a trigger. Run
 * before the review loop, so a lane that must wait for its judge is named in `hold` and the loop does not send its fix.
 */
export async function runShapeJudge(): Promise<ShapeJudgeResult> {
  const result: ShapeJudgeResult = { hold: new Set(), started: [], judged: [], errors: [] };
  const runner = getAgentRunner();
  const events = readLifecycle();
  const byLane = Map.groupBy(events, (e) => e.idd_id);
  const declared = pipelineSlotDeclared("shape_judge");
  const cap = pipelineConcurrency("shape_judge");
  // the slot is held by a run that is still going: a finished or failed run, and a lane that is closed, deferred or
  // held, hold none (the run of a lane nobody reads again would otherwise hold it for good)
  const occupies = (evs: LifecycleRecord[]): boolean => {
    if (evs.some((e) => e.event === "lane_close" || e.event === "s3_defer") || laneHeld(evs)) return false;
    const pending = pendingRun(evs);
    if (!pending) return false;
    const status = runner?.reviewRunStatus?.(pending.runId);
    return !status || status.state === "running";
  };
  let running = [...byLane.values()].filter(occupies).length;

  for (const rec of inStartOrder(readBacklog())) {
    const evs = byLane.get(rec.idd_id) ?? [];
    if (!evs.length || evs.some((e) => e.event === "lane_close" || e.event === "s3_defer") || laneHeld(evs)) continue;
    try {
      const pending = pendingRun(evs);
      if (pending) {
        const status = runner?.reviewRunStatus?.(pending.runId);
        if (!status || status.state === "running") {
          // only a run started at the point a fix would be sent holds the fix: a run for a card is a note on the card,
          // and once the card is answered the lane goes on without waiting for it
          if (pending.trigger === "symptom") result.hold.add(rec.idd_id);
          continue;
        }
        const { lines } = shapeLines(rec, evs);
        if (status.state === "failed") {
          await recordUnavailable(rec.idd_id, pending.runId, pending.round, pending.trigger, `判断の役が走り切れなかった: ${status.error}`);
          result.judged.push(rec.idd_id);
          await settle(rec.idd_id, pending.trigger, undefined, pending.round);
          continue;
        }
        // a run that finishes after its card was answered, or after the lane stopped again, speaks for a stop that is
        // gone: its recommendation would be shown on the next card, so it is dropped and the run closed
        if (movedOnSince(evs, pending.runId)) {
          await recordUnavailable(rec.idd_id, pending.runId, pending.round, pending.trigger, "card は回答済みで、遅れて届いた推奨を捨てた");
          result.judged.push(rec.idd_id);
          continue;
        }
        let recommendation: ShapeRecommendation | undefined;
        try {
          const report = JSON.parse(readFileSync(status.reportJson, "utf8")) as { recommendation?: unknown };
          recommendation = groundRecommendation(report.recommendation, lines);
        } catch (err) {
          await recordUnavailable(rec.idd_id, pending.runId, pending.round, pending.trigger, `判断の役の報告を読めなかった: ${String(err)}`);
          result.judged.push(rec.idd_id);
          await settle(rec.idd_id, pending.trigger, undefined, pending.round);
          continue;
        }
        if (!recommendation) await recordUnavailable(rec.idd_id, pending.runId, pending.round, pending.trigger, "推奨の根拠が台帳の巡の値に結べなかったか、計画へ戻す推奨に形の案が無かった");
        else await appendLifecycle(SHAPE_JUDGED, rec.idd_id, { round: pending.round, trigger: pending.trigger, run_id: pending.runId, recommendation });
        result.judged.push(rec.idd_id);
        await settle(rec.idd_id, pending.trigger, recommendation, pending.round);
        continue;
      }

      const state = reviewLoopState(evs);
      const { lines, earlier } = shapeLines(rec, evs);
      const trigger = triggerOf(evs, state, lines.length);
      if (!trigger) continue;
      const planReviews = planReviewsOf(evs);
      const items = shapeSymptomItems(lines, planReviews);
      const symptoms = items.map((s) => s.text);
      if (trigger.kind === "symptom" && !symptoms.length) continue;
      // penne answered "keep going" to these symptoms: the answer holds while they stand, so the judge is not asked for them
      // again. The note on record also closes the round for the rule of once for a round
      if (trigger.kind === "symptom" && letThrough(evs, items)) {
        await recordUnavailable(rec.idd_id, undefined, trigger.round, trigger.kind, "人が「続ける」と答えた症状が続いているだけなので、判断の役は走らせなかった");
        result.judged.push(rec.idd_id);
        continue;
      }
      if (!declared) {
        await recordUnavailable(rec.idd_id, undefined, trigger.round, trigger.kind, "config/roles.yaml の pipeline に shape_judge の宣言が無いので、判断の役は走らせなかった");
        result.judged.push(rec.idd_id);
        continue;
      }
      // a lane at its card loses nothing by one more tick for a full slot
      if (running >= cap) {
        if (trigger.kind !== "symptom") continue;
        // the lane waits at the point its fix would be sent only while a judge runs for it: with no slot there is none,
        // so the fact that it did not run is recorded and the fix goes (C-252-7)
        await recordUnavailable(rec.idd_id, undefined, trigger.round, trigger.kind, "判断の役の枠が他の lane で埋まっていて、走らせられなかった");
        result.judged.push(rec.idd_id);
        continue;
      }
      if (!runner?.startReviewRun) {
        await recordUnavailable(rec.idd_id, undefined, trigger.round, trigger.kind, "判断の役を起こす runner がありません");
        result.judged.push(rec.idd_id);
        continue;
      }
      try {
        const at = laneRevs(rec.idd_id, evs);
        const dir = join(stateDir(), "pipeline", "shape", rec.idd_id);
        mkdirSync(dir, { recursive: true });
        const roundsFile = join(dir, `rounds-${evs.length}.md`);
        writeFileSync(roundsFile, shapeRoundsText(lines, planReviews, symptoms, earlier), "utf8");
        const started = await runner.startReviewRun({
          iddId: rec.idd_id, stage: "shape", round: trigger.round, ...at,
          inputs: shapeInputs(rec, evs, at.worktree, roundsFile),
          recordsShape: laneRecordShape(rec.idd_id, evs),
        });
        const runId = started.runIds[0];
        if (!runId) throw new Error("判断の役の run が 1 本も起きませんでした");
        await appendLifecycle(SHAPE_STARTED, rec.idd_id, { round: trigger.round, trigger: trigger.kind, run_id: runId, symptoms });
        running += 1;
        result.started.push(rec.idd_id);
        // a lane at the point its fix would be sent waits for the judge; a lane already at its card does not need to
        if (trigger.kind === "symptom") result.hold.add(rec.idd_id);
      } catch (err) {
        // the judge helps the decision and is never its condition (C-252-6): the lane goes on without a recommendation
        await recordUnavailable(rec.idd_id, undefined, trigger.round, trigger.kind, `判断の役を起こせなかった: ${String(err)}`);
        result.judged.push(rec.idd_id);
      }
    } catch (err) {
      result.errors.push({ iddId: rec.idd_id, error: String((err as Error).message ?? err) });
    }
  }
  return result;
}

/**
 * Whether the answer at `events[i]` is an answer to the rounds: a "keep going" to a stop the loop made for its own
 * reasons (the rounds' cap, a swing back and forth, a stall in the count). A "keep going" to a stop for a stage that
 * would not start, or to a wait for the windows, said nothing of the rounds; nor did one to a stop over the judgement's
 * questions only (the loop goes on from it as if nothing was asked, and its answer is about the questions).
 */
function answersRounds(events: readonly LifecycleRecord[], i: number): boolean {
  const e = events[i]!;
  if (e.event !== "s2_review_resumed" || e.attrs?.decision === "accept" || e.attrs?.decision === "hand_fix") return false;
  const before = events.slice(0, i);
  const stop = reviewLoopState([...before]);
  if (stop.state !== "escalated" || stop.retry || stop.quotaWait) return false;
  // a note makes the loop send the fix even after a question stop, so the answer is read as if it had none
  return reviewLoopState([...before, { ...e, attrs: { ...e.attrs, note: "" } }]).state === "send_fix";
}

/**
 * Whether penne already let every one of these symptoms through. The newest answer to the rounds lets through the
 * symptoms the rounds showed at it, and each of them only while it stands without a break: a symptom that was gone from
 * a round after the answer is no longer let through, so when it comes back it is new. Read off the ledger alone, so the
 * same ledger gives the same answer. An answer from before the last return to the plan, or the last send-back of the
 * plan, was about another plan.
 */
function letThrough(events: readonly LifecycleRecord[], items: readonly ShapeSymptom[]): boolean {
  const from = Math.max(lastReturnToPlan(events), events.map((e) => e.event).lastIndexOf("s1_revise_requested"));
  for (let i = events.length - 1; i > from; i--) {
    if (!answersRounds(events, i)) continue;
    const before = events.slice(0, i);
    const cycle = replanCycleOf(before);
    // the reviews of one plan only grow, so the count now serves every round after the answer
    const reviews = planReviewsOf(events);
    const answeredLines = currentCycleLines(roundTrace(before), cycle);
    const lines = currentCycleLines(roundTrace([...events]), cycle);
    let standing = new Set(symptomAtoms(shapeSymptomItems(answeredLines, planReviewsOf(before))));
    // the rounds since the answer, but not the newest: it is the one being asked about
    for (let k = answeredLines.length + 1; k < lines.length; k++) {
      const shown = new Set(symptomAtoms(shapeSymptomItems(lines.slice(0, k), reviews)));
      standing = new Set([...standing].filter((a) => shown.has(a)));
    }
    return symptomAtoms(items).every((a) => standing.has(a));
  }
  return false;
}

/** whether the lane is at a point the judge reads: its card, or the point where a fix would be sent past a symptom */
function triggerOf(events: LifecycleRecord[], state: ReturnType<typeof reviewLoopState>, rounds: number): { kind: "escalated" | "symptom"; round: number } | undefined {
  const lastIndex = (name: string) => events.map((e) => e.event).lastIndexOf(name);
  if (state.state === "escalated") {
    // a stop that is the loop's own failure to start a stage, or a wait for the windows, is not a lane whose shape is in question
    if (state.retry || state.quotaWait) return undefined;
    // asked once for a stop: a judgement or a run since the stop, or a stop the judge itself raised
    const stop = lastIndex("s2_review_escalated");
    if (stop >= 0 && events[stop]!.attrs?.shape === true) return undefined;
    if (stop >= 0 && events.slice(stop).some((e) => e.event === SHAPE_STARTED || e.event === SHAPE_JUDGED)) return undefined;
    return { kind: "escalated", round: rounds };
  }
  if (state.state === "send_fix") {
    // once for the round: a judgement already made for it, whichever way it went, is not asked again. A lane sent back to
    // the plan numbers its rounds from the start, so a judgement from before the return is not one made for this round.
    const since = Math.max(lastIndex("s2_fix_sent"), lastReturnToPlan(events));
    if (events.some((e, i) => (e.event === SHAPE_STARTED || e.event === SHAPE_JUDGED) && Number(e.attrs?.round ?? -1) === state.round && i > since)) return undefined;
    return { kind: "symptom", round: state.round };
  }
  return undefined;
}

/**
 * What a finished judgement does to a lane that was held at the point its fix would be sent: a recommendation other
 * than "keep fixing" stops it at the card now, with the recommendation on it, without waiting for the rounds' cap.
 */
async function settle(iddId: string, trigger: string, recommendation: ShapeRecommendation | undefined, round: number): Promise<void> {
  if (trigger !== "symptom" || !recommendation || recommendation.choice === "continue") return;
  const label = recommendation.choice === "replan" ? "計画から考え直す" : "受け入れて後に回す";
  await appendLifecycle("s2_review_escalated", iddId, { reason: `形の崩れが巡に現れた（${round} 巡目）。判断の役は「${label}」を推奨している`, shape: true });
}

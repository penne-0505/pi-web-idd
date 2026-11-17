
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { stateDir } from "../paths.ts";
import { readAnswers, readBacklog, readLifecycle, readQuestionBatch, readQuestionBatches, requireReadableAnswerColumns, unreadableColumnOf } from "./read.ts";
import { laneSession } from "./lane-session.ts";
import { closedLanes } from "../plan/ledger-reads.ts";
import { acceptedAt, oscillationsOf, questionAnsweredByNote, reviewLoopState, s4Triage, type AnsweredQuestion, type BoundaryDecision, type Correction } from "./review-loop.ts";
import { goBlockedReason } from "./blockers.ts";
import { deriveStage, laneOverBudget, planReviewMustUnconfirmed, roundTrace, type RoundTraceLine } from "./derive.ts";
import { laneSessionRole } from "./replan-view.ts";
import { isStrictEvent, transitionRefusal } from "./allowed.ts";
import { executorOwesResult } from "./executor-work.ts";
import { isLaneGateBusy, LANE_GATE_BUSY_MESSAGE, withLaneGate } from "./gate.ts";
import { laneBudgetUsd } from "../config/pipeline.ts";
import { invalidateProposal } from "../overlay/export.ts";
import { CLI_NAME, esc, renderMessage, section } from "../agent/message.ts";
import { INTENT_IMPACT_RULE, readyPlanRecordsOf } from "../agent/intent-impact.ts";
import { resolveAreaKey } from "../config/areas.ts";
import { lastPurposeWithdrawalOfLane, proposedPurposesForLane, restatePurposeProposal, withdrawPurposeProposal } from "../intent/store.ts";
import { granularityProposalOf, granularityWaiting, type GranularityChild, type GranularityProposal } from "../plan/granularity.ts";
import { laneRecordShape } from "../plan/record-shape.ts";
import { laneTraceScope } from "../plan/lane-records.ts";
import { ROUTED_BY, type LifecycleRecord, type PendingAnswer, type PendingAnswerBasis, type PendingQuestionBatch } from "../schema/records.ts";

/**
 * The actor the person's judging door writes as. One name for every answer: an approved proposal and the row that
 * writes a harm example are both "a person answered this card", and they should not read as different people.
 */
export const INBOX_SESSION = "inbox";

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
  ensureDir(join(path, ".."));
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } });
  try {
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } finally {
    await release();
  }
}

/**
 * Take back a row just appended to a jsonl file: the last one that matches, under the file's own lock. For a record
 * written with a lifecycle event (the executor's session with its start, the backlog row with its lane_open) that
 * must not stay when the event could not be written. A row that is not there is left as it is.
 */
export async function withdrawJsonl(path: string, match: (row: Record<string, unknown>) => boolean): Promise<void> {
  if (!existsSync(path)) return;
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } });
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const at = lines.findLastIndex((l) => {
      try { return l.trim() !== "" && match(JSON.parse(l)); } catch { return false; }
    });
    if (at < 0) return;
    lines.splice(at, 1);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.join("\n"), "utf8");
    renameSync(tmp, path);
  } finally {
    await release();
  }
}

function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

function fileSafeArea(area: string): string {
  return area.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function laneArea(iddId: string): string {
  const area = readBacklog().find((b) => b.idd_id === iddId)?.area;
  return area ? fileSafeArea(area) : "default";
}

/**
 * The corrections a stuck card sends, checked against the findings the last judgement accepted. A correction names a
 * finding by the ref the card showed, and changes its weight, its handling, or both; one that changes neither is left
 * out. A must is the weight of what this change fixes, so a must put off (a follow-up, set aside) is refused: put
 * off a finding by lowering its weight.
 */
export function correctionsOfPayload(evs: LifecycleRecord[], raw: unknown): { corrections: Correction[] } | { error: string } {
  if (raw === undefined || raw === null) return { corrections: [] };
  if (!Array.isArray(raw)) return { error: "指摘の訂正（corrections）は配列で送ってください" };
  const t = evs.findLastIndex((e) => e.event === "s2_triage_done" && !e.attrs?.failed);
  const shown = new Map((t >= 0 ? acceptedAt(evs, t) : []).map((x) => [x.ref, x]));
  const out: Correction[] = [];
  for (const entry of raw as unknown[]) {
    const c = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const ref = String(c.ref ?? "");
    const found = shown.get(ref);
    if (!found) return { error: `訂正の対象の指摘が見つかりません: ${ref || "（ref なし）"}（画面を更新してください）` };
    const severity = c.severity === undefined ? found.severity : c.severity;
    if (severity !== "must" && severity !== "should" && severity !== "nit") return { error: `${ref} の重さが must / should / nit ではありません` };
    const action = c.action === undefined ? (found.action === "followup" || found.action === "skip" ? found.action : "fix") : c.action;
    if (action !== "fix" && action !== "followup" && action !== "skip") return { error: `${ref} の対応が fix / followup / skip ではありません` };
    if (severity === "must" && action !== "fix") return { error: `${ref} を must のまま後に回すことはできません（後に回すなら重さを下げてください）` };
    // putting a must off (lowering it and not fixing it) is a decision the record must explain; lowering it and still fixing it is not
    const reason = String(c.reason ?? "").trim();
    if (found.severity === "must" && severity !== "must" && action !== "fix" && !reason) return { error: `${ref} は must です。重さを下げて後に回すには理由が要ります（reason を書いてください）` };
    // a nit the judgement left as fix is still not sent by the review loop (only an S4 pass takes it): picking fix for it is
    // a decision to fix it, so it is recorded as the correction that puts it in the fix scope
    const sameHandling = severity === found.severity && action === (found.action === "followup" || found.action === "skip" ? found.action : "fix");
    if (sameHandling && !(severity === "nit" && action === "fix" && !found.corrected && !s4Triage(evs, t))) continue;
    out.push({ ref, severity, action, reason });
  }
  return { corrections: out };
}

/** the registry key of the lane's repo, or null when the lane or its area cannot be resolved */
function repoKeyOfLane(iddId: string): string | null {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  if (!rec) return null;
  const key = resolveAreaKey(rec.area);
  return "error" in key ? null : key.key;
}

/** the append itself; only this module calls it, so the events checked by the write gate have one way in */
async function writeLifecycle(event: string, iddId: string, attrs: Record<string, unknown>): Promise<string> {
  const path = join(stateDir(), `lifecycle-${laneArea(iddId)}.jsonl`);
  await appendJsonl(path, { event, idd_id: iddId, at: nowIso(), attrs });
  return path;
}

/**
 * A record inside a stage (a review round, a watch's note, a budget, a PR's feedback). The events that move a lane
 * from one stage to the next are refused here, however their name is passed: they are written only through
 * `transition`, which checks the lane's stage first.
 */
export async function appendLifecycle(event: string, iddId: string, attrs: Record<string, unknown> = {}): Promise<string> {
  if (isStrictEvent(event)) throw new Error(`${event} は段を確かめてから書くイベントなので、書き口（transition）を通して書いてください`);
  return writeLifecycle(event, iddId, attrs);
}

export type TransitionResult =
  | { ok: true; path: string }
  /** busy: the gate stayed held for the whole wait; nothing was checked or written */
  | { ok: false; reason: string; busy?: true };

export interface TransitionOptions {
  /**
   * a condition of the caller's own, asked inside the gate after the table allowed the event, on the lane's records as
   * they are then: a reason refuses the event as the table would (nothing is written)
   */
  require?: (lane: LifecycleRecord[]) => string | null;
  /** runs inside the gate once the event is allowed, before it is written; a throw from it writes nothing */
  before?: () => unknown;
  /**
   * takes back what `before` wrote when the event itself then could not be written (the lifecycle's lock, a disk
   * fault); the failure is thrown on after it, with the take-back's own failure when that fails too
   */
  undo?: () => unknown;
  /** written right after the event, in the same hold of the gate, without a check of their own */
  then?: { event: string; attrs?: Record<string, unknown> }[];
}

/**
 * The one way to write a record that moves a lane on. Inside the lane gate it reads the lane's records again,
 * finds where the lane stands, and writes only when the table lets a lane there take the event; otherwise it
 * answers why and writes nothing. When the gate stays busy it answers so instead of throwing, so a tick goes on
 * with its other lanes and a decision tells penne to press again.
 */
export async function transition(iddId: string, event: string, attrs: Record<string, unknown> = {}, opts: TransitionOptions = {}): Promise<TransitionResult> {
  const unchecked = (opts.then ?? []).find((next) => isStrictEvent(next.event));
  if (unchecked) throw new Error(`${unchecked.event} は確かめてから書くイベントなので、ほかの記録の後に続けて書けません`);
  try {
    return await withLaneGate(async (): Promise<TransitionResult> => {
      const lane = readLifecycle().filter((e) => e.idd_id === iddId);
      const refusal = transitionRefusal(event, lane) ?? opts.require?.(lane) ?? null;
      if (refusal) return { ok: false, reason: refusal };
      await opts.before?.();
      let path: string;
      try {
        path = await writeLifecycle(event, iddId, attrs);
      } catch (err) {
        if (opts.before && opts.undo) {
          try {
            await opts.undo();
          } catch (undoErr) {
            if (err instanceof Error) err.message = `${err.message}（先に書いた記録も取り消せませんでした: ${String(undoErr).slice(0, 300)}）`;
          }
        }
        throw err;
      }
      for (const next of opts.then ?? []) await writeLifecycle(next.event, iddId, next.attrs ?? {});
      return { ok: true, path };
    });
  } catch (err) {
    if (isLaneGateBusy(err)) return { ok: false, reason: LANE_GATE_BUSY_MESSAGE, busy: true };
    throw err;
  }
}

/**
 * Append a row to the answers' file unless the question already has an answer. The check and the append share the
 * file's lock, so an answer written first (a person's or the mechanism's) is never joined by a second one, whatever
 * the order they were decided in. Returns whether the row was written.
 */
async function appendAnswerOnce(iddId: string, batchId: string, questionId: string, row: Record<string, unknown>): Promise<boolean> {
  const path = join(stateDir(), "pending-answers.jsonl");
  ensureDir(join(path, ".."));
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } });
  try {
    const taken = readFileSync(path, "utf8").split("\n").some((l) => {
      try {
        const have = l.trim() ? JSON.parse(l) as { idd_id?: string; batch_id?: string; question_id?: string } : null;
        return have?.idd_id === iddId && have.batch_id === batchId && have.question_id === questionId;
      } catch { return false; }
    });
    if (taken) return false;
    appendFileSync(path, JSON.stringify({
      idd_id: iddId,
      batch_id: batchId,
      question_id: questionId,
      answered_at: nowIso(),
      ...row,
    }) + "\n", "utf8");
    return true;
  } finally {
    await release();
  }
}

/** a person's answer; null when the question already has an answer, which stays as it is */
export async function appendAnswer(rec: {
  iddId: string;
  batchId: string;
  questionId: string;
  selection: { index?: number; label: string };
  reason?: string;
  notes?: string;
}): Promise<string | null> {
  const written = await appendAnswerOnce(rec.iddId, rec.batchId, rec.questionId, {
    selection: rec.selection,
    reason: rec.reason ?? null,
    notes: rec.notes ?? null,
  });
  return written ? join(stateDir(), "pending-answers.jsonl") : null;
}

/** an answer the mechanism gives in a person's place: who gave it, and the quotes the engine found in the material */
export interface RoutedAnswer {
  questionId: string;
  selection: { index?: number; label: string };
  by: { role: string; model: string };
  basis: PendingAnswerBasis[];
  reason: string;
}

/** the mechanism's answer, appended unless the question already has one (a person's answer written first is never replaced) */
function appendRoutedAnswer(iddId: string, batchId: string, a: RoutedAnswer): Promise<boolean> {
  return appendAnswerOnce(iddId, batchId, a.questionId, {
    selection: a.selection,
    reason: a.reason,
    notes: null,
    answered_by: ROUTED_BY,
    router: a.by,
    basis: a.basis,
  });
}

/** the reason a planner reads for an answer the mechanism gave: that it was not the user, and what it rested on */
function routedReasonOf(a: { reason?: string | null; basis?: PendingAnswerBasis[] }): string {
  const basis = (a.basis ?? []).map((b) => (b.ref ? `${b.source} ${b.ref}` : b.source)).join(", ");
  return `ユーザーでなく仕組みが、記録で答えが決まるとして答えた${basis ? `（根拠: ${basis}）` : ""}。${a.reason ?? ""}`.trim();
}

/** the envelope that carries a closed batch's answers to the planner: one id per batch, so a retry names the same one */
function answerEnvelopeId(iddId: string, batchId: string): string {
  return `answered-${iddId}-${batchId}`.replace(/[^\w.-]/g, "_");
}

/**
 * The moment the answers' envelope began to carry the batch's id (the merge of #307 into the mainline). A batch closed
 * before it was sent its answers in an envelope that names no batch; a batch closed from it on is always sent in one
 * that does. The two are told apart by this time and not by what the outbox holds, because a close made after it whose
 * envelope never landed must not read as delivered by a row that belongs to a neighbour.
 */
export const NAMED_ANSWER_ENVELOPES_FROM = Date.parse("2026-11-02T21:21:28+09:00");

/**
 * whether the planner was sent the answers of this batch. Its own envelope is the only mark of a batch closed from
 * `NAMED_ANSWER_ENVELOPES_FROM` on: a neighbour's envelope, named or not, is never its mark. For a batch closed before
 * that, an envelope that names no batch is read too: one of the lane queued from `since` (the batch's close) and before
 * `until` (the lane's next close, whose envelope is another batch's). The close and the envelope are two writes with a
 * neighbour's close possible between them, so this window cannot tell whose it is; such a batch may be sent again.
 */
export function answerEnvelopeQueued(iddId: string, batchId: string, since: string, until?: string): boolean {
  if (envelopeQueued(answerEnvelopeId(iddId, batchId))) return true;
  const from = Date.parse(since);
  if (!(from < NAMED_ANSWER_ENVELOPES_FROM)) return false;
  const file = join(stateDir(), "outbox.jsonl");
  if (!existsSync(file)) return false;
  const to = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { envelope_id?: string; idd_id?: string; type?: string; queued_at?: string };
      // a row that names a batch is that batch's mark and no other's
      if (typeof row.envelope_id === "string" && row.envelope_id.startsWith("answered-")) continue;
      if (row.idd_id === iddId && row.type === "question_batch_answered" && !(Date.parse(row.queued_at ?? "") < from) && Date.parse(row.queued_at ?? "") < to) return true;
    } catch {
      // a broken row is not this envelope
    }
  }
  return false;
}

/** the batches a close is under way for in this process: a second close of one of them is refused rather than joined */
const closing = new Set<string>();

/**
 * Once every question of a batch has an answer: record that the batch was answered and queue the answers to the
 * planner, once. A person's answer and the mechanism's both end here, so both write the same record and the same
 * word. The record carries a mark when no person answered any question of the batch, so the day's count of a person's
 * answers can leave it out. Each half is skipped when it is already on record, so a close that failed between the
 * answers and the planner's word is finished by calling this again (the tick does, for a batch left that way).
 */
export async function closeAnsweredBatch(iddId: string, batchId: string, wrote: string[]): Promise<CloseResult> {
  const key = `${iddId}/${batchId}`;
  if (closing.has(key)) return { error: "この batch は閉じている最中です" };
  closing.add(key);
  try {
    return await closeAnsweredBatchOnce(iddId, batchId, wrote);
  } finally {
    closing.delete(key);
  }
}

/**
 * What a close came to. `unreadableColumn` rides on an error that is only a column that cannot be read now: nothing was
 * written by the close, and the next tick closes the batch, which is not a refusal of what was recorded before it.
 */
export type CloseResult = { remaining: number } | { error: string; unreadableColumn?: string } | { envelopeId: string };

async function closeAnsweredBatchOnce(iddId: string, batchId: string, wrote: string[]): Promise<CloseResult> {
  // both columns are read before any row is written: a column that cannot be read says nothing of what is answered, and
  // a close written on "no question left" would be a close with no questions, which no later row takes back
  let batch: PendingQuestionBatch | undefined;
  let answers: PendingAnswer[];
  try {
    batch = readQuestionBatch(iddId, batchId);
    answers = readAnswers().filter((a) => a.idd_id === iddId && a.batch_id === batchId);
  } catch (err) {
    const column = unreadableColumnOf(err);
    if (!column) throw err;
    return { error: `${column}を読めないので、この batch はまだ閉じません（読めるようになった次の回に閉じます）`, unreadableColumn: column };
  }
  const answeredIds = new Set(answers.map((a) => a.question_id));
  const remaining = (batch?.questions ?? []).filter((q) => !answeredIds.has(q.question_id));
  if (remaining.length > 0) return { remaining: remaining.length };
  const mechanismOnly = answers.length > 0 && answers.every((a) => a.answered_by === ROUTED_BY);
  const recorded = readLifecycle().some((e) => e.idd_id === iddId && e.event === "question_batch_answered" && e.attrs?.batch_id === batchId);
  if (!recorded) {
    const r = await transition(iddId, "question_batch_answered", { batch_id: batchId, ...(mechanismOnly ? { answered_by: ROUTED_BY } : {}) });
    if (!r.ok) return { error: r.reason };
    wrote.push(r.path);
  }
  const pairs = (batch?.questions ?? []).map((q) => {
    const a = answers.filter((x) => x.question_id === q.question_id).pop();
    return {
      questionId: q.question_id,
      question: q.question,
      selection: a?.selection ?? { label: "その他" },
      reason: (a?.answered_by === ROUTED_BY ? routedReasonOf(a) : a?.reason) ?? undefined,
      notes: a?.notes ?? undefined,
    };
  });
  const laneNow = readLifecycle().filter((e) => e.idd_id === iddId);
  // who asked is the role that holds the lane now: the one answer the watch and the turn read (C-275-1)
  const asker = laneSessionRole(laneNow);
  const id = await queueEnvelope(iddId, "question_batch_answered",
    questionAnsweredEnvelope(iddId, batchId, pairs, asker, laneRecordShape(iddId, laneNow),
      answers.some((a) => a.answered_by === ROUTED_BY)), { envelopeId: answerEnvelopeId(iddId, batchId), role: asker });
  return { envelopeId: id };
}

/**
 * A batch a planner asked, put on record: its row in the questions' file, then the lifecycle's `question_batch_asked`.
 * Both the plain ask and the routed commit write it here, so the two read the same shape.
 */
export async function recordAskedBatch(batch: PendingQuestionBatch): Promise<void> {
  // a column that cannot be read throws here, before a row is written: "no row of this batch" would write it twice, and
  // the answers' column is held to the same rule as the routed write's (a batch recorded over answers not known is not recorded)
  requireReadableAnswerColumns();
  // each half is skipped when it is on record, so a second call (a retry after one half failed) never doubles a row
  if (!readQuestionBatch(batch.idd_id, batch.batch_id)) await appendJsonl(join(stateDir(), "pending-questions.jsonl"), batch);
  await recordAskedEvent(batch);
}

async function recordAskedEvent(batch: PendingQuestionBatch): Promise<void> {
  const lifecycle = readLifecycle();
  if (lifecycle.some((e) => e.idd_id === batch.idd_id && e.event === "question_batch_asked" && e.attrs?.batch_id === batch.batch_id)) return;
  // a batch already closed is not followed by its asked event: that would read the answered batch as asked after its answer
  if (lifecycle.some((e) => e.idd_id === batch.idd_id && e.event === "question_batch_answered" && e.attrs?.batch_id === batch.batch_id)) return;
  await appendLifecycle("question_batch_asked", batch.idd_id, {
    batch_id: batch.batch_id,
    question_ids: batch.questions.map((q) => q.question_id),
  });
}

/**
 * The one write a routed batch makes, once the judge has finished: the answers the mechanism gives come first, then the
 * batch's questions and its asked event, then the close when every question has an answer. The answers go first so that
 * no reading of the records ever sees a question the mechanism was about to answer; a question that has an answer keeps
 * it (a second row is never written). A close that fails leaves the answers and the batch on record: the tick finishes
 * it (`finishAnsweredBatches`). The caller names the batch in its own `skip` for that tick while this runs.
 */
export async function recordRoutedBatch(batch: PendingQuestionBatch, answers: RoutedAnswer[]): Promise<{ written: string[]; closed: boolean }> {
  // the lane's end is read in the same hold of the gate as every write below: the ledger only grows, so a row written
  // after the lane closed cannot be taken back, and a read made before the gate would let a close come in between. The
  // judge is not run in here; its result is already in hand.
  return withLaneGate(async () => {
    if (closedLanes(readLifecycle()).has(batch.idd_id)) return { written: [], closed: false };
    // an answer written before the batch's row can be would stand alone on a column that cannot be read
    requireReadableAnswerColumns();
    const written: string[] = [];
    for (const a of answers) {
      try {
        if (await appendRoutedAnswer(batch.idd_id, batch.batch_id, a)) written.push(a.questionId);
      } catch (err) {
        // an answer that could not be written is the person's question: the batch is recorded below with it open
        console.warn(`[routing] 仕組みの答えを書けませんでした: ${batch.idd_id}/${batch.batch_id}/${a.questionId}: ${String(err).slice(0, 300)}`);
      }
    }
    await recordAskedBatch(batch);
    if (!written.length) return { written, closed: false };
    const closed = await closeAnsweredBatch(batch.idd_id, batch.batch_id, []).catch(() => null);
    return { written, closed: !!closed && "envelopeId" in closed };
  });
}

/** the reason the re-close last said it waits, so a column that stays unreadable is said once and not at every tick */
let skippedSaid: string | null = null;

function saySkipped(reason: string): void {
  if (skippedSaid === reason) return;
  skippedSaid = reason;
  console.warn(`[tick] 質問の batch を閉じ直せません。読めるようになるまで待ちます: ${reason.slice(0, 300)}`);
}

/**
 * Finish the close of a batch whose answers are all on record but whose close (the lane's move off the question stage,
 * or the word to the planner) did not land: the gate was busy, or a write failed. Such a batch has no question for the
 * card and no word for the planner, so nothing else would ever move it. Each batch is read on its own record, so a
 * later batch the lane asked does not hide this one's missing close. Each half of the close is skipped when it is
 * already on record, so this is safe to run every tick. `skip` names the batches (`<lane>/<batch>`) whose close another
 * path of this process is making now. Returns the batches it closed.
 */
export async function finishAnsweredBatches(skip: ReadonlySet<string> = new Set()): Promise<string[]> {
  let answered: Set<string>;
  let batchesOnRecord: PendingQuestionBatch[];
  try {
    answered = new Set(readAnswers().map((a) => `${a.idd_id}/${a.batch_id}/${a.question_id}`));
    batchesOnRecord = readQuestionBatches();
  } catch (err) {
    // which batches are answered is not known while a column cannot be read; nothing is closed until it can be
    if (!unreadableColumnOf(err)) throw err;
    saySkipped(String((err as Error).message));
    return [];
  }
  skippedSaid = null;
  const full = batchesOnRecord.filter((b) => b.questions.length > 0 && b.questions.every((q) => answered.has(`${b.idd_id}/${b.batch_id}/${q.question_id}`)));
  if (!full.length) return [];
  // a batch of a closed lane, and one whose close is on record in both halves, is left before the gate: every answered
  // batch of every lane ever closed is in the list above, and asking the gate for each of them on every tick kept it
  // busy for the writes that need it. No row these read is ever taken away (the lifecycle is only appended to, and an
  // outbox row may be rewritten in place but is never dropped), so what is dropped here would be dropped in the gate too
  const lifecycle = readLifecycle();
  const ended = closedLanes(lifecycle);
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of lifecycle) {
    const lane = byLane.get(e.idd_id);
    if (lane) lane.push(e);
    else byLane.set(e.idd_id, [e]);
  }
  const batches = full.filter((b) => !ended.has(b.idd_id) && batchCloseOf(b, byLane.get(b.idd_id) ?? []).open);
  const done: string[] = [];
  for (const b of batches) {
    if (skip.has(`${b.idd_id}/${b.batch_id}`)) continue;
    try {
      // the lane's end and the batch's close are read again in the hold that writes: a close that came in after the
      // list above was made is then seen, and an asked event is never written after it
      await withLaneGate(() => finishAnsweredBatch(b, done));
    } catch (err) {
      console.warn(`[tick] 質問の batch を閉じ直せませんでした: ${b.idd_id}/${b.batch_id}: ${String(err).slice(0, 300)}`);
    }
  }
  return done;
}

/**
 * A batch's close as the lane's records (`lane`, its events alone) hold it: the close event, if any, and whether a half
 * of the close is still missing. The transition is missing when every question has an answer and nothing closed the
 * batch (whether or not its asked event landed: a write that failed after the answers must not strand the planner);
 * the word to the planner is missing when the close is on record but no answers' envelope was queued for it.
 */
function batchCloseOf(b: PendingQuestionBatch, lane: LifecycleRecord[]): { closed?: LifecycleRecord; open: boolean } {
  const closes = lane.filter((e) => e.event === "question_batch_answered");
  const closedAt = closes.findIndex((e) => e.attrs?.batch_id === b.batch_id);
  if (closedAt < 0) return { open: true };
  const closed = closes[closedAt];
  return { closed, open: !answerEnvelopeQueued(b.idd_id, b.batch_id, closed.at, closes[closedAt + 1]?.at) };
}

/** one batch of `finishAnsweredBatches`, inside the gate */
async function finishAnsweredBatch(b: PendingQuestionBatch, done: string[]): Promise<void> {
  // the asked event below is written before the close reads the columns again: they are checked first, in this hold
  requireReadableAnswerColumns();
  const lifecycle = readLifecycle();
  if (closedLanes(lifecycle).has(b.idd_id)) return;
  const lane = lifecycle.filter((e) => e.idd_id === b.idd_id);
  const { closed, open } = batchCloseOf(b, lane);
  if (!open) return;
  const asked = lane.some((e) => e.event === "question_batch_asked" && e.attrs?.batch_id === b.batch_id);
  // the asked event goes first so the records read asked, then answered; a close already on record is not followed
  // by an asked event, which would read the answered batch as asked after its answer
  if (!asked && !closed) await recordAskedEvent(b);
  const r = await closeAnsweredBatch(b.idd_id, b.batch_id, []);
  if ("envelopeId" in r) done.push(`${b.idd_id}/${b.batch_id}`);
}

/**
 * The frame every follow-up is sent in: `<propter-system-message>`, the body's own sections in the order the
 * caller wrote them, the closing line. The kind of message is not in the body (it is kept beside the delivery);
 * the frame carries no lane's id, no time and no HTTP endpoint.
 */
export function buildEnvelope(_type: string, _iddId: string, body: string): string {
  return renderMessage([section("context", body)]);
}

/** the task a follow-up tells the agent, wrapped as its section */
export function followupTask(lines: string[]): string {
  return ["  <task>", ...lines.map((l) => `    ${l}`), "  </task>"].join("\n");
}

/** the callback of a follow-up: only the verbs that follow-up has */
export function followupCallback(items: { verb: string; text: string }[]): string {
  return ["  <callback>", ...items.map((i) => `    <${i.verb}>${i.text}</${i.verb}>`), "  </callback>"].join("\n");
}

/** one round of the lane's lines as the planner reads it: the ledger's values, no text of a finding */
function roundElement(r: RoundTraceLine): string {
  const attrs = `n="${r.round}" cycle="${r.cycle}" kind="${esc(r.kind)}" must="${r.accepted_must}" should="${r.accepted_should}" changed_files="${r.changed_files}" outside="${esc(r.outside_scope.join(" "))}"`;
  return `    <round ${attrs}>${r.named_files.map(esc).join(" ")}</round>`;
}

/** the envelope that sends the planner back to its plan: the task lines, the callback that sends the plan again, then the sections after it */
function planRedoEnvelope(task: string[], tail: string[]): string {
  const callback = `    <plan>終わったら\`${CLI_NAME} report plan\`を送り直す。plan が変わったならsummaryも直す。${INTENT_IMPACT_RULE}</plan>`;
  return buildEnvelope("plan_redo", "", ["  <task>", ...task, "  </task>", "  <callback>", callback, "  </callback>", ...tail].join("\n"));
}

/**
 * the one word that sends the planner back to its plan, from the card's "計画から考え直す" and from the review's "方針へ戻す":
 * the lead line says why, then the instruction (when penne wrote one) and the rounds so far
 */
async function sendPlannerBack(iddId: string, lead: string, instruction: string, rounds: RoundTraceLine[], lane: LifecycleRecord[]): Promise<string> {
  const shape = laneRecordShape(iddId, lane);
  const task = [
    `    ${lead}${shape === "state" ? "草案・処置・qa / reference と plan.md" : "decision / qa / reference と plan.md"}を直して報告を送り直す。`,
    "    - 実装の branch と前の巡の記録は残る。直した plan はもう一度査読され、GO を通ってから実装が入り直す。",
    `    - 直す必要がない or 理由が不明のいずれかに該当すると判断したら、直さずに \`${CLI_NAME} report questions\` で理由を添えて聞く。`,
  ];
  const tail = [
    ...(instruction ? [`  <instruction>${esc(instruction)}</instruction>`] : []),
    "  <rounds>",
    ...rounds.map(roundElement),
    "  </rounds>",
  ];
  return queueEnvelope(iddId, "s1_replan", planRedoEnvelope(task, tail));
}

export function questionAnsweredEnvelope(iddId: string, batchId: string, pairs: {
  questionId: string;
  question: string;
  selection: { index?: number; label: string };
  reason?: string;
  notes?: string;
}[], role?: "planner" | "executor", shape: "docs" | "state" = "docs", routed = false): string {
  // the options are the agent's own words: never shown back to it
  const body = [
    "  <task>",
    `    \`${CLI_NAME} report questions\` で聞いた 1 batch の全問に答えが付いた。${routed ? "ユーザーの答えのほか、記録で決まるとして仕組みが答えたものがあり、reason に出どころを書いてある。" : ""}selection と reason を判断の根拠として、止めていた作業の続きを進める。`,
    `    - ${shape === "state"
      ? (role === "executor"
        ? "答えが実装を変えるなら、該当する Choice を Supersede か Re-anchor するか、新しい Choice の why に因果を残す。出どころとして question 欄に質問の id を書く。"
        : "答えが計画を変えるなら、該当する草案の why に因果を残し、出どころとして question 欄に質問の id を書く。")
      : "答えが plan の内容を変えるなら、decision.md の該当する DEC の Why に因果を残す。"}reason が因果ならそれを使う。reason が空か出所だけのときは、因果を推測して「推測」と明示する（「質問 qN の回答」のような出典は見出しに混ぜない）。`,
    "  </task>",
    "  <callback>",
    ...(role === "planner"
      ? [`    <plan>下調べが終わったら ${CLI_NAME} report plan を送る。${INTENT_IMPACT_RULE}</plan>`]
      : role === "executor"
        ? [`    <result>実装が終わったら ${CLI_NAME} report result を送る。</result>`]
        : [
          `    <plan>planner のとき: 下調べが終わったら ${CLI_NAME} report plan を送る。${INTENT_IMPACT_RULE}</plan>`,
          `    <result>executor のとき: 実装が終わったら ${CLI_NAME} report result を送る。</result>`,
        ]),
    "  </callback>",
    `  <answers batch-id="${esc(batchId)}">`,
    ...pairs.map((p) => [
      `    <qa-pair question-id="${esc(p.questionId)}">`,
      `      <question>${esc(p.question)}</question>`,
      `      <selection${p.selection.index !== undefined ? ` index="${p.selection.index}"` : ""}>${esc(p.selection.label)}</selection>`,
      p.reason ? `      <reason>${esc(p.reason)}</reason>` : "",
      p.notes ? `      <notes>${esc(p.notes)}</notes>` : "",
      "    </qa-pair>",
    ].filter(Boolean).join("\n")),
    "  </answers>",
  ].filter(Boolean).join("\n");
  return renderMessage([section("context", body)]);
}

/** one line of a split child, for the word sent back with the answer */
function granularityChildLine(child: GranularityChild, i: number): string {
  return `      - 子 ${i + 1}: ${child.title} — ${child.whole}（触る Place: ${child.places.join(", ")}${child.after.length ? `、先に着地: ${child.after.map((n) => `子 ${n + 1}`).join(", ")}` : ""}）`;
}

/**
 * The word to the planner after a person answered its granularity proposal. "Approve" never comes here: an approved
 * split or merge closes the lane. "Single" says to write the request for one lane; "revise" carries the person's
 * instruction to slice it again. The proposal is written back in full, so the planner goes on with the judgement it
 * made, on the same lane (C-127-1, C-127-4).
 */
export function granularityAnsweredEnvelope(proposal: GranularityProposal, decision: "single" | "revise", instruction: string): string {
  const body = [
    "  <task>",
    ...(decision === "single"
      ? [
        "    ユーザーが粒度の案に「このまま 1 本」と答えた。1 本として依頼（plan.md）を書き進める。",
        `    1 本とした理由を 1 文で \`${CLI_NAME} report plan --granularity-reason \"...\"\` に添える。`,
      ]
      : [
        "    ユーザーが粒度の案に「直して返す」と答えた。instruction に沿って切り方を直す。",
        `    分け方 / 束ね方を変えるなら \`${CLI_NAME} report granularity\` で案を送り直し、その答えを待ってから依頼を書く。`,
        `    1 本で進めるなら、その理由を 1 文で \`${CLI_NAME} report plan --granularity-reason \"...\"\` に添える。`,
      ]),
    "  </task>",
    "  <callback>",
    `    <plan>下調べが終わったら ${CLI_NAME} report plan を送る。${INTENT_IMPACT_RULE}</plan>`,
    "  </callback>",
    `  <proposal kind="${esc(proposal.kind)}">`,
    `      - 理由: ${esc(proposal.reason)}`,
    ...(proposal.children ?? []).map((c, i) => granularityChildLine(c, i)),
    ...(proposal.mergeTarget ? [`      - 合流の先: ${esc(proposal.mergeTarget.ref)}${proposal.mergeTarget.title ? `（${esc(proposal.mergeTarget.title)}）` : ""}`] : []),
    "  </proposal>",
    ...(instruction ? [`  <instruction>${esc(instruction)}</instruction>`] : []),
  ].join("\n");
  return buildEnvelope("granularity_answered", "", body);
}

/** how a proposal's kind is named in the word sent back to the lane that raised it */
const PROPOSAL_KIND_WORDS: Record<string, string> = {
  overview: "概要",
  root_supersede: "root の Choice の置き換え",
  root_reanchor: "root の Choice の Re-anchor",
  harm_example: "害の例",
};

/**
 * The word to the lane that raised a proposal: what was asked, how it was answered, and where the approved record
 * can be read. Sent only to a lane that is still open, so the envelope names the proposal alone (the lane's own id
 * rides beside the delivery, as every follow-up's does).
 */
export function proposalAnsweredEnvelope(proposal: { id: string; kind: string }, approved: boolean, reason?: string, effect?: { id: string; shown: boolean }): string {
  const kind = PROPOSAL_KIND_WORDS[proposal.kind] ?? proposal.kind;
  const body = [
    "  <task>",
    `    あなたが出した案（${esc(proposal.id)} / ${esc(kind)}）に人が答えました: ${approved ? "承認" : "見送り"}。`,
    ...(approved ? [] : [`    見送りの理由: ${esc(reason ?? "")}`]),
    ...(approved
      ? [effect
        ? (effect.shown
          ? `    承認された記録は \`${CLI_NAME} intent show ${effect.id}\` で読める。`
          : `    承認された害の例は \`${CLI_NAME} intent risk\`、この案は \`${CLI_NAME} intent records\` で読める。`)
        : `    承認された記録は \`${CLI_NAME} intent show\` で読める。`]
      : []),
    "  </task>",
  ].join("\n");
  return buildEnvelope("proposal_answered", "", body);
}

/** the envelope that sends an executor back to fix: the S3 rejection, the submit confirmation and a land conflict */
export function laneRejectedEnvelope(iddId: string, instruction: string, subTodo: boolean): string {
  return buildEnvelope("lane_rejected", iddId, [
    "  <task>",
    "    ユーザーが提出前の確認で差し戻した。instruction に沿って直し、commit する。",
    "    - 直した後はレビューの巡がもう一度回る。",
    ...(subTodo ? ["    - instruction は今の lane の範囲を超える追加の作業である。契約に足りない判断があれば、先に契約（lane の記録の形に合わせて Choice か DEC と、AC）に足してから実装する。"] : []),
    `    - instruction が契約と矛盾する or 直す必要がない or 見直し理由が不明/不明瞭のいずれかに該当すると判断したら、直さずに \`${CLI_NAME} report questions\` で理由を添えて聞く。`,
    "  </task>",
    "  <callback>",
    `    <result>終わったら ${CLI_NAME} report result を送り直す。送り直すまでレビューは始まらない。</result>`,
    "  </callback>",
    `  <instruction>${esc(instruction)}</instruction>`,
  ].join("\n"));
}

/** whether an envelope with this id already has its row in the outbox */
function envelopeQueued(envelopeId: string): boolean {
  const file = join(stateDir(), "outbox.jsonl");
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      if ((JSON.parse(line) as { envelope_id?: unknown }).envelope_id === envelopeId) return true;
    } catch {
      // a broken row is not this envelope
    }
  }
  return false;
}

/**
 * Queue one instruction for an agent. The id comes from the clock unless the caller names it; a named envelope is
 * queued once, so a caller that can come back to the same instruction (a round's fix) finds the row it already wrote
 * and adds nothing.
 */
export async function queueEnvelope(iddId: string, type: string, xml: string, opts: { skipFixPlan?: boolean; envelopeId?: string; role?: "planner" | "executor" } = {}): Promise<string> {
  const dir = join(stateDir(), "outbox");
  ensureDir(dir);
  const id = opts.envelopeId ?? `${Date.now()}-${iddId}`;
  if (opts.envelopeId && envelopeQueued(id)) return id;
  // a body left from a tick whose row did not land is kept as it is; only the missing row is written
  if (!existsSync(join(dir, `${id}.xml`))) writeFileSync(join(dir, `${id}.xml`), xml, "utf8");
  await appendJsonl(join(stateDir(), "outbox.jsonl"), {
    envelope_id: id,
    idd_id: iddId,
    type,
    queued_at: nowIso(),
    delivered_at: null,
    // the mark only a conflict-merge instruction carries: the delivery skips the fix plan for it (DEC-121-1)
    ...(opts.skipFixPlan ? { skip_fix_plan: true } : {}),
    ...(opts.role ? { role: opts.role } : {}),
  });
  return id;
}

/** why a GO waits while the plan is with the planner after a Purpose proposal was taken back; the Choice is named only when a draft points at it */
const WITHDRAWAL_SENT_BACK = (id: string, pointing: boolean) =>
  pointing
    ? "取り下げた案を指す Choice があるので、計画を出し直しています。計画役が報告し直すまで GO はできません"
    : `Purpose の案（${id}）の取り下げで、計画を計画役に差し戻しています。計画役が報告し直すまで GO はできません`;

/** why a GO waits when a Purpose proposal was taken back and the send-back that goes with it was never recorded */
const WITHDRAWAL_NOT_SENT_BACK = (id: string) =>
  `Purpose の案（${id}）の取り下げは記録しましたが、計画の差し戻しが記録されていません。GO の card から計画役に直させてください`;

/** the proposal behind the last send-back to the planner when it came from a withdrawal and no ready has come since */
function sentBackByWithdrawal(events: LifecycleRecord[]): string | null {
  const names = events.map((e) => e.event);
  const revise = names.lastIndexOf("s1_revise_requested");
  if (revise < 0 || revise < names.lastIndexOf("s1_ready") || events[revise].attrs?.cause !== "purpose_withdrawn") return null;
  const id = events[revise].attrs?.purpose_id;
  return typeof id === "string" ? id : "";
}

export interface DecideResult {
  remaining?: number;
  ok: boolean;
  wrote: string[];
  envelopeId?: string;
  error?: string;
  /** the decision was recorded, but something that goes with it was not (shown as a notice on the inbox) */
  warning?: string;
}

/**
 * The plan's touch list as the lane's worktree holds the plan at the moment of its GO. The GO writes it into its own
 * row (`plan_scope`), and the rounds' "outside the plan" column is read from the rows only, so a plan edited after the
 * GO does not change a line read before.
 */
function goPlanScope(iddId: string): string[] {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  if (!rec) return [];
  return laneTraceScope(rec, laneSession(iddId)?.worktree);
}

/**
 * The result of a press on an answer, once its row is on record. A close that could not read a column is the answer
 * saved and the batch not yet closed, so it is a warning on a recorded decision: the press was not refused, and a
 * second press would be refused as already answered. Any other close error stays a failure of the press.
 */
export function answerResultOf(closed: CloseResult, wrote: string[]): DecideResult {
  if ("error" in closed) {
    if (closed.unreadableColumn) {
      return { ok: true, wrote, warning: `答えは記録しました。${closed.unreadableColumn}を読めないので batch はまだ閉じていません（読めるようになった次の tick で閉じます）` };
    }
    return { ok: false, wrote, error: closed.error };
  }
  if ("remaining" in closed) return { ok: true, wrote, remaining: closed.remaining };
  return { ok: true, wrote, envelopeId: closed.envelopeId };
}

/**
 * penne's decisions. Each is checked and written inside the lane gate, so a decision from an old screen or two pressed
 * together cannot record what the lane's stage no longer allows. When the gate stays busy nothing is written and
 * the decision is refused with the reason. Taking a lane out (`ignore`) and starting one over (`lane_redo`) are not
 * decisions of this table: they are called beside it and hold the gate only for their own writes.
 */
export async function applyDecision(action: string, payload: Record<string, unknown>): Promise<DecideResult> {
  try {
    return await withLaneGate(() => decide(action, payload));
  } catch (err) {
    if (isLaneGateBusy(err)) return { ok: false, wrote: [], error: LANE_GATE_BUSY_MESSAGE };
    throw err;
  }
}

async function decide(action: string, payload: Record<string, unknown>): Promise<DecideResult> {
  const iddId = String(payload.iddId ?? payload.reviewId ?? "");
  if (!iddId) return { ok: false, wrote: [], error: "iddId が空" };
  const wrote: string[] = [];
  /** write through the gate; a refusal becomes the decision's answer */
  const write = async (event: string, attrs: Record<string, unknown>, opts: TransitionOptions = {}): Promise<string | { error: string }> => {
    const r = await transition(iddId, event, attrs, opts);
    if (!r.ok) return { error: r.reason };
    wrote.push(r.path);
    return r.path;
  };
  const refused = (w: string | { error: string }): DecideResult | null => (typeof w === "string" ? null : { ok: false, wrote, error: w.error });
  const laneEvents = (): LifecycleRecord[] => readLifecycle().filter((e) => e.idd_id === iddId);
  /** an answer to a stop is refused unless the lane waits at one: a stale card or a direct POST must not abandon a stage that is running */
  const unlessStopped = (evs: LifecycleRecord[]): DecideResult | null => (reviewLoopState(evs).state === "escalated" ? null : { ok: false, wrote, error: "この lane は要判断ではありません（画面を更新してください）" });

  /** the GO card's revise: one `s1_revise_requested` row, and the planner's word through the outbox */
  const sendBackToPlanner = async (instruction: string, cause?: { cause: string; purpose: string }): Promise<DecideResult> => {
    const no = refused(await write("s1_revise_requested", { instruction, at_by: "user", ...(cause ? { cause: cause.cause, purpose_id: cause.purpose } : {}) }));
    if (no) return no;
    const reviseShape = laneRecordShape(iddId, laneEvents());
    const task = [
      `    ユーザーが GO の判定で plan の見直しを求めた。instruction に沿って${reviseShape === "state" ? "草案・処置・qa / reference を直し、報告を送り直す。plan の内容は plan.md を直す。" : "decision / qa / reference を直す。"}`,
      "    - 直した plan はもう一度査読される。",
      `    - instruction が契約と矛盾する or 直す必要がない or 見直し理由が不明/不明瞭のいずれかに該当すると判断したら、直さずに \`${CLI_NAME} report questions\` で理由を添えて聞く。`,
    ];
    const id = await queueEnvelope(iddId, "s1_revise", planRedoEnvelope(task, [`  <instruction>${esc(instruction)}</instruction>`]));
    return { ok: true, wrote, envelopeId: id };
  };

  switch (action) {
    case "s1_go": {
      // the engine records a shallow lane's GO itself: the same write door and gate, marked `auto` with its reason
      const atBy = payload.atBy === "auto" ? "auto" : "user";
      const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : undefined;
      // The confirmation of the lane's proposed Purposes rides on this one record (one press, one append). The
      // screen sends the ids it showed; the lane's current proposals must all be among them. A lane whose repo
      // cannot be resolved has no proposals to compare with, and goes through with the old attrs.
      const repo = repoKeyOfLane(iddId);
      const sent = Array.isArray(payload.purposes)
        ? (payload.purposes as unknown[]).flatMap((raw) => {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
          const id = (raw as Record<string, unknown>).id;
          if (typeof id !== "string" || !id.trim()) return [];
          const name = (raw as Record<string, unknown>).name;
          return [{ id: id.trim(), ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) }];
        })
        : [];
      // the sentence the screen showed for each id: a GO confirms the sentence on the record, so a screen that still
      // shows an older sentence, sends none, or shows a proposal since taken back is refused
      const shown = new Map<string, string>();
      if (Array.isArray(payload.purposes)) {
        for (const raw of payload.purposes as unknown[]) {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
          const { id, statement } = raw as Record<string, unknown>;
          if (typeof id === "string" && id.trim() && typeof statement === "string") shown.set(id.trim(), statement.trim());
        }
      }
      const sentIds = new Set(sent.map((s) => s.id));
      const current = repo ? proposedPurposesForLane(repo, iddId) : [];
      const currentIds = new Set(current.map((p) => p.id));
      const chosen = sent.filter((s) => currentIds.has(s.id));
      const planScope = goPlanScope(iddId);
      const attrs: Record<string, unknown> = { at_by: atBy, ...(reason ? { reason } : {}), ...(chosen.length ? { purposes: chosen } : {}), ...(planScope.length ? { plan_scope: planScope } : {}) };
      const purposesRequire = repo && (current.length || sent.length)
        ? () => {
          const now = proposedPurposesForLane(repo, iddId);
          const missing = now.filter((p) => !sentIds.has(p.id)).map((p) => p.id);
          if (missing.length) return `画面が見せていない Purpose の案（${missing.join(", ")}）があります。画面を更新してください`;
          if (now.some((p) => !currentIds.has(p.id))) return "Purpose の案が変わりました。画面を更新してください";
          const nowIds = new Set(now.map((p) => p.id));
          const gone = [...sentIds].filter((id) => !nowIds.has(id));
          if (gone.length) return `画面が見せた Purpose の案（${gone.join(", ")}）はもう案ではありません。画面を更新してください`;
          // a proposal the screen sent no sentence for is refused: the id alone would confirm a sentence it never showed
          const unshown = now.filter((p) => !shown.has(p.id)).map((p) => p.id);
          if (unshown.length) return `Purpose の案（${unshown.join(", ")}）の文が送られていません。画面を更新してください`;
          const changed = now.filter((p) => shown.has(p.id) && shown.get(p.id) !== p.statement.trim()).map((p) => p.id);
          if (changed.length) return `Purpose の案（${changed.join(", ")}）の文が画面と違います。画面を更新してください`;
          return null;
        }
        : null;
      // A withdrawal is written before its send-back; when the send-back did not land, the stage still takes a GO over
      // the old plan. The lane is refused here, whatever the proposals now are, unless a send-back that names the
      // withdrawn proposal followed it. The intent column and the lifecycle are stamped separately, so a time compare
      // cannot tell an earlier round's revise in the withdrawal's second from the one that answers it. The revise from
      // the card names the proposal still waiting for its send-back, so it stays the way out.
      const withdrawalNotSentBack = (lane: LifecycleRecord[]): string | null => {
        if (!repo) return null;
        const withdrawn = lastPurposeWithdrawalOfLane(repo, iddId);
        if (!withdrawn) return null;
        if (!lane.some((e) => e.event === "s1_ready")) return null;
        const sentBack = lane.some((e) => e.event === "s1_revise_requested" && e.attrs?.purpose_id === withdrawn.id);
        return sentBack ? null : WITHDRAWAL_NOT_SENT_BACK(withdrawn.id);
      };
      // a plan whose review still sent findings back after the rounds it may run on its own is penne's to pass, and the
      // record says why: the GO without a reason is refused, the send-back is not
      const findingsRequire = () => {
        if (reason) return null;
        return planReviewMustUnconfirmed(laneEvents())
          ? "査読を回しても must が残っています。読んだうえで通すなら、通す理由を書いてください（差し戻しなら理由は要りません）"
          : null;
      };
      // a lane whose recorded blocker has not landed takes no GO, whoever presses it (the card shows the wait instead)
      const require = (lane: LifecycleRecord[]) => goBlockedReason(iddId) ?? withdrawalNotSentBack(lane) ?? findingsRequire() ?? purposesRequire?.() ?? null;
      // a card still showing a plan that a withdrawal sent back is told why the GO waits, not only that it is not waiting
      const events = readLifecycle().filter((e) => e.idd_id === iddId);
      const withdrawnId = transitionRefusal("s1_go", events) ? sentBackByWithdrawal(events) : null;
      if (withdrawnId !== null) {
        const pointing = (readyPlanRecordsOf(events)?.choices ?? []).some((c) => c.purpose === withdrawnId);
        return { ok: false, wrote, error: WITHDRAWAL_SENT_BACK(withdrawnId, pointing) };
      }
      return refused(await write("s1_go", attrs, { require })) ?? { ok: true, wrote };
    }

    // A person's judgement on one Purpose proposal of the lane, made on the card that shows it. A rewrite adds one row
    // to the intent column and moves nothing. A withdrawal adds its row and then sends the plan back to the planner in
    // the same press: the plan's drafts were written for the proposal, and a GO that carried on over a Choice draft
    // pointing at a taken-back Purpose would leave the records at odds with what the lane did. The stage then refuses a
    // GO until the planner reports again. Only a lane that can take a GO now has a card to judge on.
    case "purpose_restate":
    case "purpose_withdraw": {
      const repo = repoKeyOfLane(iddId);
      if (!repo) return { ok: false, wrote, error: "lane の repo を解決できません" };
      const lane = readLifecycle().filter((e) => e.idd_id === iddId);
      const stage = transitionRefusal("s1_go", lane);
      if (stage) return { ok: false, wrote, error: stage };
      const by = { session: INBOX_SESSION };
      if (action === "purpose_restate") {
        const done = await restatePurposeProposal({ repo, lane: iddId, by, id: payload.id, statement: payload.statement });
        return done.ok ? { ok: true, wrote } : { ok: false, wrote, error: done.error };
      }
      const done = await withdrawPurposeProposal({ repo, lane: iddId, by, id: payload.id, grounds: payload.grounds });
      if (!done.ok) return { ok: false, wrote, error: done.error };
      const pointing = (readyPlanRecordsOf(lane)?.choices ?? []).some((c) => c.purpose === done.id);
      const instruction = [
        pointing
          ? `Purpose の案 ${done.id} を取り下げたが、草案の Choice がそれを指しているので、計画を出し直している。`
          : `Purpose の案 ${done.id} を取り下げたので、計画を出し直している。`,
        `取り下げの理由: ${String(payload.grounds ?? "").trim()}`,
        "取り下げた案は草案の purpose に使えない（報告が断られる）。新しい案を立てるか、active な Purpose を指して、報告を送り直す。",
      ].join("\n");
      const sent = await sendBackToPlanner(instruction, { cause: "purpose_withdrawn", purpose: done.id });
      return sent.ok ? sent : { ...sent, error: `${done.id} の取り下げは記録したが、計画の差し戻しは書けなかった（${sent.error}）。GO の card から直させてください` };
    }

    case "s1_revise": {
      const instruction = String(payload.instruction ?? "").trim();
      if (!instruction) return { ok: false, wrote, error: "直させる内容を書いてください" };
      // a withdrawal whose send-back never landed is answered by this revise: the row names it, so the GO's wait ends
      const repo = repoKeyOfLane(iddId);
      const withdrawn = repo ? lastPurposeWithdrawalOfLane(repo, iddId) : null;
      const lane = readLifecycle().filter((e) => e.idd_id === iddId);
      const pending = withdrawn && !lane.some((e) => e.event === "s1_revise_requested" && e.attrs?.purpose_id === withdrawn.id);
      return sendBackToPlanner(instruction, pending ? { cause: "purpose_withdrawn", purpose: withdrawn.id } : undefined);
    }

    case "lane_budget_extend": {
      const evs = laneEvents();
      const over = laneOverBudget(evs);
      if (!over) return { ok: false, wrote, error: "この lane は予算で止まっていません（画面を更新してください）" };
      // one more default budget on top of the limit it passed
      const limit = Math.round((over.limit + laneBudgetUsd()) * 100) / 100;
      return refused(await write("lane_budget_extended", { limit, at_by: "user" })) ?? { ok: true, wrote };
    }

    case "lane_stall_resume":
      // the watch stage resumes the session on its next pass
      return refused(await write("lane_stall_resumed", { at_by: "user", note: String(payload.note ?? "") })) ?? { ok: true, wrote };

    // A granularity proposal's answer. "Approve" is not here: it closes the lane and puts its Issue on the ignore
    // list, so the engine's decide route calls it beside this table (as `ignore` is). "Single" and "revise" only
    // write the answer and hand the planner its word back through the outbox: the lane stays open and the same
    // planner session goes on with the request (C-127-1, C-127-4).
    case "granularity_single":
    case "granularity_revise":
    case "granularity_reslice": {
      const evs = laneEvents();
      if (!granularityWaiting(evs)) return { ok: false, wrote, error: "この lane は粒度の案への答え待ちではありません（画面を更新してください）" };
      const proposal = granularityProposalOf(evs);
      if (!proposal) return { ok: false, wrote, error: "粒度の案を読めません（画面を更新してください）" };
      const decision = action === "granularity_single" ? "single" : "revise";
      const instruction = action === "granularity_reslice"
        ? String(payload.instruction ?? "").trim() || "子が 4 を超えています。起票の切り方から見直して、責務で分け直してください"
        : String(payload.instruction ?? "").trim();
      if (decision === "revise" && !instruction) return { ok: false, wrote, error: "直す内容（instruction）を書いてください" };
      const no = refused(await write("s1_granularity_answered", { decision, ...(instruction ? { instruction } : {}) }));
      if (no) return no;
      const id = await queueEnvelope(iddId, "granularity_answered", granularityAnsweredEnvelope(proposal, decision, instruction));
      return { ok: true, wrote, envelopeId: id };
    }

    case "s0_requeue_go":
      return refused(await write("s0_requeue_go", { at_by: "user" })) ?? { ok: true, wrote };

    case "merge":
    case "anyway_go":
      return refused(await write("pending_review_resolved", { review_id: iddId, outcome: action })) ?? { ok: true, wrote };

    case "answer": {
      const batchId = String(payload.batchId ?? "");
      // a press on a column that cannot be read is refused: the question's id and the option's words come from it, and an
      // answer written without them would keep a default in their place (the answer's row is never rewritten)
      let batch: PendingQuestionBatch | undefined;
      try {
        requireReadableAnswerColumns();
        batch = readQuestionBatch(iddId, batchId);
      } catch (err) {
        const column = unreadableColumnOf(err);
        if (!column) throw err;
        return { ok: false, wrote, error: `${column}を読めないので、答えを記録できません（読めるようになってからもう一度押してください）` };
      }
      const questionId = String(payload.questionId ?? batch?.questions?.[0]?.question_id ?? "Q-001");
      const asked = batch?.questions?.find((q) => q.question_id === questionId) ?? batch?.questions?.[0];
      const options = asked?.options ?? [];
      const raw = (payload.selection ?? {}) as { index?: number; label?: string };
      const selection = {
        index: raw.index,
        label: raw.label ?? options.find((o) => o.index === raw.index)?.label ?? "その他",
      };
      // a card opened before the question was answered (by the mechanism, or by a person elsewhere) must not add a
      // competing answer or a second word to the planner: the answer on record stands
      const appended = await appendAnswer({
        iddId, batchId, questionId, selection,
        reason: payload.reason as string | undefined,
        notes: payload.notes as string | undefined,
      });
      if (!appended) return { ok: false, wrote, error: "この質問にはすでに答えが付いています（画面を更新してください）" };
      wrote.push(appended);

      return answerResultOf(await closeAnsweredBatch(iddId, batchId, wrote), wrote);
    }


    case "s2_review_continue":
    case "s2_review_accept":
    case "s2_review_hand_fix": {
      // only a lane that is actually waiting for penne takes this decision: a stale card or a direct POST
      // must not abandon a stage that is running and send a second fix
      const evs = laneEvents();
      const notStopped = unlessStopped(evs);
      if (notStopped) return notStopped;
      const note = String(payload.note ?? "");
      // the reversals this stop is about: those of the last judgement, when penne has not answered since
      const t = evs.map((e) => e.event).lastIndexOf("s2_triage_done");
      const answered = evs.findIndex((e, i) => i > t && e.event === "s2_review_resumed") >= 0;
      // "go on as it is" keeps the code as it stands, so a side picked on the card is not recorded as the boundary
      const reversals = t >= 0 && !answered && action === "s2_review_continue" ? oscillationsOf(evs[t].attrs) : [];
      const picked = Array.isArray(payload.boundaries) ? (payload.boundaries as Record<string, unknown>[]) : [];
      const boundaries: BoundaryDecision[] = reversals.flatMap((o) => {
        const b = picked.find((x) => x && x.ref === o.ref);
        const text = b?.choice === "prior" ? o.prior : b?.choice === "current" ? o.current : b?.choice === "custom" ? String(b.text ?? "").trim() : "";
        // a note written in place of a side is the boundary of each reversal left open
        if (b && text) return [{ ref: o.ref, choice: b.choice as BoundaryDecision["choice"], text }];
        return note.trim() ? [{ ref: o.ref, choice: "custom" as const, text: note.trim() }] : [];
      });
      // a reversal goes back to the fix only with a boundary to fix toward: a side picked or written, or penne's note
      if (boundaries.length < reversals.length) {
        return { ok: false, wrote, error: "往復した指摘の境目が決まっていません（立場を選ぶか書くか、補足に書いてください）" };
      }
      // the one question the judgement of this stop put to penne: the note written on its card, which the card names its
      // answer, is recorded as that question's answer, so later judgements and spec checks know it was answered. The
      // same reading the card and the readers take decides it. A note on any other stop stays an instruction to the
      // executor (cadf31509); taking the code answers nothing
      const asked = action !== "s2_review_hand_fix" ? questionAnsweredByNote(evs) : [];
      const answers: AnsweredQuestion[] = note.trim() ? asked.map((q) => ({ ...q, text: note.trim() })) : [];
      // the weight and handling penne set on each finding of the card: the one record every later round reads them from.
      // "take the code" decides nothing about the findings, so it records none
      const corrected = action === "s2_review_hand_fix" ? { corrections: [] } : correctionsOfPayload(evs, payload.corrections);
      if ("error" in corrected) return { ok: false, wrote, error: corrected.error };
      return refused(await write("s2_review_resumed", {
        decision: action === "s2_review_accept" ? "accept" : action === "s2_review_hand_fix" ? "hand_fix" : "continue",
        note,
        ...(boundaries.length ? { boundaries } : {}),
        ...(answers.length ? { answers } : {}),
        ...(corrected.corrections.length ? { corrections: corrected.corrections } : {}),
        at_by: "user",
      })) ?? { ok: true, wrote };
    }

    case "s2_review_replan": {
      // the lane goes back to its plan, on the same branch and with its rounds kept: the planner is told, and the plan
      // goes through the review and the GO again before the executor starts anew. Only a lane that waits for penne
      // in the loop takes it; the gate refuses a stale card the same way (`s1_replan_requested`'s rule).
      const evs = laneEvents();
      const notStopped = unlessStopped(evs);
      if (notStopped) return notStopped;
      const note = String(payload.note ?? "").trim();
      const rounds = roundTrace(evs);
      const no = refused(await write("s1_replan_requested", { rounds: rounds.length, ...(note ? { note } : {}), at_by: "user" }));
      if (no) return no;
      const id = await sendPlannerBack(iddId, "実装の巡が収束しなかったので、ユーザーが計画から考え直すと決めた。巡の記録（rounds）を読み、同じ類の指摘が別の場所に出続けた原因が計画の形にないかを確かめ、", note, rounds, laneEvents());
      return { ok: true, wrote, envelopeId: id };
    }

    case "s2_hand_fixed": {
      // the hand turn's own answer: only a lane actually waiting at it takes it
      const evs = laneEvents();
      if (reviewLoopState(evs).state !== "awaiting_hand_fix") return { ok: false, wrote, error: "この lane は人の手番ではありません（画面を更新してください）" };
      return refused(await write("s2_hand_fixed", { at_by: "user" })) ?? { ok: true, wrote };
    }

    case "s3_ok":
      return refused(await write("s3_ok", {
        reviewer_notes: String(payload.notes ?? ""),
        side_findings_promoted: payload.promoted ?? [],
      })) ?? { ok: true, wrote };

    case "s3_reject": {
      const feedback = String(payload.feedback ?? "");
      // where the rejection sends the lane is part of the one row it writes: the plan ("方針へ戻す") or, as it always
      // went, the implementation. Anything else a card sends is read as the implementation too
      const toPlan = payload.nextStage === "s1_rethink";
      const rounds = toPlan ? roundTrace(laneEvents()) : [];
      // a press back to the plan is taken only while penne holds the lane's card and the executor owes it nothing: the
      // review card (a lane outside the review loop) or the loop's own stop. A stale card or a direct POST must not
      // reopen a closed lane, nor send back a lane already at the plan or at the GO, nor start the planner while a fix
      // the executor was sent is still being written into the same worktree
      const stoppedInLoop = (lane: LifecycleRecord[]) => deriveStage(lane).decision === "stuck" && reviewLoopState(lane).state === "escalated";
      const atCard = (lane: LifecycleRecord[]) => {
        if (deriveStage(lane).decision !== "review" && !stoppedInLoop(lane)) return "この lane は提出前の確認待ちではありません（画面を更新してください）";
        return executorOwesResult(lane) ? "実装役が作業中なので、終わってから方針へ戻してください（画面を更新してください）" : null;
      };
      // which of the two the press came from is read before the row moves the lane: the planner is told the reason that fits
      const fromLoop = stoppedInLoop(laneEvents());
      const no = refused(await write("s3_reject", { reason: feedback, next_stage: toPlan ? "s1_rethink" : "s2_retry", feedback }, toPlan ? { require: atCard } : undefined));
      if (no) return no;
      if (toPlan) {
        // the planner is told, as the card's "計画から考え直す" tells it: the plan goes through the review and the GO
        // again before the executor starts anew. The word is one envelope, with penne's instruction and the rounds so far
        const lead = fromLoop
          ? "実装の巡が収束しなかったので、ユーザーが方針（計画）へ戻すと決めた。巡の記録（rounds）を読み、同じ類の指摘が別の場所に出続けた原因が計画の形にないかを確かめ、"
          : "ユーザーが提出前の確認で、実装ではなく方針（計画）へ戻すと決めた。instruction と巡の記録（rounds）を読み、";
        const id = await sendPlannerBack(iddId, lead, feedback.trim(), rounds, laneEvents());
        return { ok: true, wrote, envelopeId: id };
      }
      const instruction = feedback;
      const id = await queueEnvelope(iddId, "lane_rejected", laneRejectedEnvelope(iddId, instruction, false));
      return { ok: true, wrote, envelopeId: id };
    }

    case "s4_verify_clean":
      return { ok: false, wrote, error: "承認 token を付けて提出処理を実行してください" };

    case "s4_revise":
    case "s4_sub_todo": {
      const no = refused(await write("s4_verify_user_judgment_answered", {
        outcome: action === "s4_revise" ? "revise" : "sub_todo",
        instruction: String(payload.instruction ?? ""),
        // the engine's own send-back (a landed blocker, plan/blockers.ts) is marked as the stall watch marks its own
        ...(payload.by === "harness" ? { by: "harness" } : {}),
      }));
      if (no) return no;
      invalidateProposal(iddId);
      const id = await queueEnvelope(iddId, "lane_rejected", laneRejectedEnvelope(iddId, String(payload.instruction ?? ""), action === "s4_sub_todo"));
      return { ok: true, wrote, envelopeId: id };
    }

    case "priority_elevated":
    case "priority_reset": {
      const no = refused(await write(action, { reason: String(payload.reason ?? ""), elevated_by: "user" }));
      if (no) return no;
      // the priority only orders the harness's slots; it changes nothing the agent does, so no message is sent
      return { ok: true, wrote };
    }

    case "speak": {
      const message = String(payload.message ?? "");
      const no = refused(await write("s2_interjection", { message }));
      if (no) return no;
      const id = await queueEnvelope(iddId, "info_update",
        buildEnvelope("info_update", iddId, [
          "  <task>",
          "    ユーザーからの伝言。指示として扱う。",
          "    - 今の作業に関わるなら反映し、関わらないなら覚えておく。",
          `    - 伝言が契約と矛盾するなら、\`${CLI_NAME} report questions\` で確かめてから進める。`,
          "  </task>",
          "  <callback>",
          `    <plan>planner のとき: 下調べが終わったら ${CLI_NAME} report plan を送る。${INTENT_IMPACT_RULE}</plan>`,
          `    <result>executor のとき: 実装が終わったら ${CLI_NAME} report result を送る。</result>`,
          "  </callback>",
          `  <message>${esc(message)}</message>`,
        ].join("\n")));
      return { ok: true, wrote, envelopeId: id };
    }

    default:
      return { ok: false, wrote: [], error: `未対応の action: ${action}` };
  }
}

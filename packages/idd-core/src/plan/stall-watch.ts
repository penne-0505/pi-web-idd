import { statSync } from "node:fs";

import { getAgentRunner } from "../agent/port.ts";
import { pendingEnvelopes } from "../agent/outbox.ts";
import { laneRejectedEnvelope, queueEnvelope, transition, appendLifecycle } from "../ledger/write.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { decisionSince, deriveStage, laneHeld, withoutNotes, LANE_NOTE_EVENTS, type Stage } from "../ledger/derive.ts";
import { laneTurn, turnSince, type LaneFacts } from "../ledger/turn.ts";
import { stagePick } from "../ledger/pick.ts";
import { awaitedAgent, awaitingQuestion } from "./watch.ts";
import { stallWatchPolicy, type StallWatchPolicy } from "../config/pipeline.ts";
import { clean } from "../overlay/git.ts";
import { invalidateProposal } from "../overlay/export.ts";
import { buildSubmit } from "./ship.ts";
import { headCommit } from "../worktree/ensure.ts";
import { EXECUTOR_WAIT_END_EVENT, EXECUTOR_WAIT_EVENT } from "./review-loop.ts";
import type { SlotWait } from "./slot-wait.ts";
import { LANE_START_SKIPPED, startSkipOf, type StartStage } from "./start-skip.ts";
import type { LifecycleRecord, SessionRecord } from "../schema/records.ts";

/** the halt record the stall watch writes for a lane it hands to penne */
export const LANE_STALL_DETECTED = "lane_stall_detected";
/** the record of an instruction the stall watch sent to a lane's executor */
export const LANE_STALL_INSTRUCTED = "lane_stall_instructed";
/** the record of a notice the stall watch wrote for a card that waited too long */
export const LANE_WAIT_NOTIFIED = "lane_wait_notified";

/** the known causes the stall watch can tell and instruct for */
export type StallCause = "dirty" | "conflict";

const CAUSE_LABEL: Record<StallCause, string> = {
  dirty: "worktree に未 commit の変更が残っている",
  conflict: "本流との衝突が解消されていない",
};

const START_STAGE_LABEL: Record<StartStage, string> = { planner: "計画役", executor: "実装役" };

/** what the tick's stages put on their own result for this pass, handed to the stall watch */
export interface StallWatchContext {
  submitPrep?: { iddId: string; error: string }[];
  reviewLoop?: { iddId: string; error: string }[];
  land?: { iddId: string; error: string }[];
  landHeld?: { iddId: string; reason: string }[];
  submitPush?: { iddId: string; error: string }[];
  slotWaits?: SlotWait[];
  /** a restart is on its way: a lane waiting for its planner is waiting on that, so it is no stop */
  reloadHold?: string;
}

export interface StallWatchResult {
  /** lanes an instruction was sent to */
  instructed: string[];
  /** lanes a halt record was written for */
  halted: string[];
  /** lanes whose card waited long enough for a notice */
  noticed: string[];
  errors: number;
}

function lastIndexOf(events: { event: string }[], name: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return i;
  return -1;
}

/** the stage's failures this pass for one lane, with the stage they came from */
function laneErrors(iddId: string, ctx: StallWatchContext): { source: string; error: string }[] {
  const out: { source: string; error: string }[] = [];
  const add = (list: { iddId: string; error: string }[] | undefined, source: string) => {
    for (const e of list ?? []) if (e.iddId === iddId) out.push({ source, error: e.error });
  };
  add(ctx.submitPrep, "提出の準備");
  add(ctx.reviewLoop, "レビュー");
  add(ctx.land, "取り込み");
  add(ctx.submitPush, "提出");
  for (const h of ctx.landHeld ?? []) if (h.iddId === iddId) out.push({ source: "取り込み", error: h.reason });
  return out;
}

/** the lane's executor session with a worktree, else its planner's; the place a running session would be */
function worktreeOf(executor: SessionRecord | undefined, planner: SessionRecord | undefined): string | undefined {
  return executor?.worktree_path ?? planner?.worktree_path;
}

/** the conflict files the last S3 recorded */
function conflictFiles(events: LifecycleRecord[]): string[] {
  const at = lastIndexOf(events, "s3_check_conflict");
  const raw = at >= 0 ? events[at].attrs?.conflict_files : undefined;
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** the causes a worktree read tells: uncommitted changes, and a conflict the S3 check left */
function worktreeCauses(events: LifecycleRecord[], worktree: string): StallCause[] {
  const out: StallCause[] = [];
  try {
    if (!clean(worktree)) out.push("dirty");
  } catch {
    // a git that cannot answer leaves the dirty cause unknown, not assumed
  }
  const ready = lastIndexOf(events, "s3_ready");
  const conflict = lastIndexOf(events, "s3_check_conflict");
  if (conflict > ready && conflict > lastIndexOf(events, "s3_check_clean")) out.push("conflict");
  return out;
}

/** the instruction for the causes found, as one message; the wording follows the send-back and the land conflict */
function instructionFor(causes: StallCause[], events: LifecycleRecord[], worktree: string): string {
  const lines: string[] = ["engine の番のまま進まなくなったので差し戻します。次の原因を直して commit してください。", ""];
  for (const cause of causes) {
    if (cause === "dirty") {
      lines.push("- worktree に未 commit の変更が残っています。`git status` で確かめ、この lane の成果なら commit してください。成果でないものは、確かめずに消さないでください。判断できなければ質問してください。");
    } else if (cause === "conflict") {
      const files = conflictFiles(events);
      lines.push(`- 本流を lane に merge して衝突を解き、commit してください。rebase は使わないでください。衝突したファイル: ${files.length ? files.join(", ") : "（本流の merge で確かめてください）"}`);
    }
  }
  lines.push("", `（worktree: ${worktree}）`);
  return lines.join("\n");
}

/** the causes a lane was already instructed about since its last resume */
function instructedCauses(events: LifecycleRecord[]): Set<string> {
  const from = lastIndexOf(events, "lane_stall_resumed");
  const out = new Set<string>();
  for (let i = from + 1; i < events.length; i += 1) {
    if (events[i].event !== LANE_STALL_INSTRUCTED) continue;
    const list = events[i].attrs?.causes;
    if (Array.isArray(list)) for (const c of list) out.add(String(c));
  }
  return out;
}

/**
 * Where the stall clock starts: the later of the step's start and the last record of the executor's own hold on the
 * lane within the step. The executor holds the lane while its conversation answers and its head moves (a wait mark
 * begins that, the end mark is the first look that found it stopped), and a result can reach the engine while the
 * conversation goes on. The step does not change across them (the turn's clock stays at the first record), so that
 * stretch is taken off here. The records that count are chosen, not the ones to skip: a result, a wait mark, a wait
 * end. The latest of their times is the start (a finished wait's own mark is earlier than its end, so the end wins; a
 * wait with no end yet counts from its own time, so a lane whose end could not be written does not stand silent).
 * Every other record (a merge of the mainline, a failed review start, a map, a base that moved, any note) says nothing
 * about the clock and is not listed anywhere.
 *
 * Only the executor's step reads them. A wait mark and its end are written by the review loop alone, inside a step, so
 * after the row at `since` they count whatever kind that row is (a step that a finished map begins holds them as well).
 * A result counts only while the rows from the step's first one (the row at `since`) are the executor's own records
 * and notes with nothing else between, and that first row is itself the executor's: a result that is appended late,
 * after another record (a merge, a failed review start) or after the lane has gone on into the middle of a review (or
 * to S3), belongs to a step that is over and starts nothing.
 */
const EXECUTOR_WAIT_EVENTS = [EXECUTOR_WAIT_END_EVENT, EXECUTOR_WAIT_EVENT];
const EXECUTOR_RESULT_EVENT = "s2_result";

function clockStart(events: LifecycleRecord[], since: string | undefined, stage: Stage): string | undefined {
  if (!since) return since;
  if (stage.group !== "impl" || stage.stageCurrent !== 2) return since;
  // rows that share the step's start time (a ledger written in one stroke) are read at the last of them
  const first = events.findLastIndex((e) => e.at === since);
  if (first < 0) return since;
  // a result counts while the rows from the step's first one are the executor's own records and notes, with nothing
  // else between: a result appended after another record (a merge, a failed review start) is a late one
  let joined = EXECUTOR_WAIT_EVENTS.includes(events[first].event) || events[first].event === EXECUTOR_RESULT_EVENT;
  let start = Date.parse(since);
  let at = since;
  for (let i = first; i < events.length; i += 1) {
    const e = events[i];
    const wait = EXECUTOR_WAIT_EVENTS.includes(e.event);
    const result = e.event === EXECUTOR_RESULT_EVENT;
    if (!wait && !result && !LANE_NOTE_EVENTS.includes(e.event)) joined = false;
    if (!wait && !(joined && result)) continue;
    const t = Date.parse(e.at);
    if (t > start) {
      start = t;
      at = e.at;
    }
  }
  return at;
}

/** the stage's name as the halt record and card show it */
function stageLabel(events: LifecycleRecord[]): string {
  const d = deriveStage(events);
  return d.blockedBy ?? `段 ${d.stageDone}`;
}

/**
 * The agent the lane is handed work for but could not be started: the lane's last word is a start note for the role it
 * awaits, and no session of that role began after the note. A start that worked adds no row of its own, so the note
 * stays the last word; the session's time is what makes it history. Such a lane has no agent to wait on, so the stall
 * watch reads it as the engine's turn (the note itself moves no clock; the step's start does).
 */
function unstartedAgent(
  awaited: { role: "executor" | "planner"; since: number } | null,
  skip: { stage: StartStage; reason: string; wait: boolean } | undefined,
  events: LifecycleRecord[],
  session: SessionRecord | undefined,
): boolean {
  if (!awaited || !skip || awaited.role !== skip.stage) return false;
  // a start the stage itself answered as a wait (the cap, the space, a replacement) ends by itself: the lane's row says
  // it, no card is owed. The stage's answer is read, not the words of its reason.
  if (skip.wait) return false;
  const note = events.findLast((e) => e.event === LANE_START_SKIPPED);
  if (!note) return false;
  return !(session && Date.parse(session.started_at) >= Date.parse(note.at));
}

/** whether the lane's worktree can be sent back to (an executor session with a worktree) */
function canSendBack(executor: SessionRecord | undefined): boolean {
  return Boolean(executor?.worktree_path);
}

/**
 * The stall watch: the lanes the engine owns and does not move are found here, told apart by the time they stood
 * on the same step. A known cause gets one instruction to the executor; anything else, and a cause already
 * instructed without a fix, becomes a halt record for penne. A card penne owes that waits too long gets one
 * notice record. The stage never fails the tick: a lane it cannot read is left as it is.
 */
export async function runStallWatch(ctx: StallWatchContext = {}, now = Date.now()): Promise<StallWatchResult> {
  const result: StallWatchResult = { instructed: [], halted: [], noticed: [], errors: 0 };
  const policy: StallWatchPolicy = stallWatchPolicy();
  const backlog = readBacklog();
  const events = readLifecycle();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of events) byLane.set(e.idd_id, [...(byLane.get(e.idd_id) ?? []), e]);
  const pending = new Set(pendingEnvelopes().map((e) => e.idd_id));
  // a lane the cap holds back waits on the cap: its time at the step is the queue's, not a stop. One a slot has just
  // freed for (the stage starts it on its next pass) waits on it too, unless the stage has just tried it and said it
  // could not start (its note is the last word): a slot that is free and a lane that is not started is no queue
  const waitingIds = new Set((ctx.slotWaits ?? []).flatMap((w) => w.lanes.map((l) => l.id)));
  const nextIds = new Set((ctx.slotWaits ?? []).flatMap((w) => w.next ?? []));
  const runner = getAgentRunner();
  const planners = readSessions("planner");
  const executors = readSessions("executor");
  const lastOf = <T extends { idd_id: string }>(list: T[], id: string): T | undefined => list.filter((r) => r.idd_id === id).pop();

  for (const rec of backlog) {
    const evs = byLane.get(rec.idd_id) ?? [];
    if (evs.length === 0) continue;
    const stage = deriveStage(evs);
    if (stage.group === "closed") continue;
    // the engine is being replaced: a lane waiting for its planner is waiting on that, not stopped (the wait has
    // an owner, the reload card, and the replacement takes it). Once the hold is over, it is counted as before.
    if (ctx.reloadHold && stage.group === "prep") continue;
    const executor = lastOf(executors, rec.idd_id);
    const planner = lastOf(planners, rec.idd_id);
    const worktree = worktreeOf(executor, planner);

    try {
      // the notice for a card that waited too long: a decision card, or a question the lane is waiting on
      const questionWait = awaitingQuestion(evs);
      if ((stage.decision || questionWait) && policy.cardNoticeHours > 0) {
        const since = stage.decision ? decisionSince(evs) : questionWait ? String(evs[questionWait.index]?.at ?? "") : undefined;
        if (since && now - Date.parse(since) >= policy.cardNoticeHours * 3600_000) {
          const notified = evs.some((e) => e.event === LANE_WAIT_NOTIFIED && Date.parse(e.at) > Date.parse(since));
          if (!notified) {
            await appendLifecycle(LANE_WAIT_NOTIFIED, rec.idd_id, { ...(stage.decision ? { decision: stage.decision } : {}), ...(questionWait ? { question: true } : {}), since });
            result.noticed.push(rec.idd_id);
          }
        }
      }

      if (policy.stallMinutes <= 0) continue;
      // a lane something is already holding for penne is not a stop candidate
      if (laneHeld(evs)) continue;

      // why the stage could not start the lane: the lane's own note says it, so the card and the timeline read one reason
      const skip = startSkipOf(evs);
      const awaited = awaitedAgent(evs);
      const unstarted = unstartedAgent(awaited, skip, evs, awaited?.role === "executor" ? executor : planner);
      const facts: LaneFacts = {
        awaitedAgent: unstarted ? null : awaited,
        pendingEnvelope: pending.has(rec.idd_id),
        cardBuildable: stage.decision === "ship" ? buildSubmitSafely(rec.idd_id) : undefined,
      };
      const turn = laneTurn(evs, facts);
      const since = clockStart(evs, turnSince(evs, facts), stage);
      const timedOut = Boolean(since && now - Date.parse(since) >= policy.stallMinutes * 60_000);
      const engineStop = turn === "engine" && timedOut;

      // the stage asks its own question, at the moment it asks it (C-199-2). The ledger's part is asked first:
      // the worktree's busyness is a process read, and only the lanes the stage keeps need it.
      const asked = {
        reloadHold: Boolean(ctx.reloadHold),
        waitingSlot: waitingIds.has(rec.idd_id) || (nextIds.has(rec.idd_id) && !unstarted),
        pendingEnvelope: facts.pendingEnvelope ?? false,
        cardBuildable: facts.cardBuildable ?? null,
        awaitedAgent: facts.awaitedAgent ?? null,
      };
      if (!stagePick("stall", evs, asked, now).pick) continue;

      // without a runner nothing can be checked in a worktree or sent to an agent; the one stop still readable from the
      // lane's rows is a start the stage could not make (its note is the reason), which becomes its card below
      if (!runner && !(unstarted && engineStop)) continue;

      // nothing may be running in the lane's worktree: a repair starts a new session and stops the old one. A lane whose
      // start note is still the last word is the exception for the card: what stays in its worktree (a session of the
      // failed delivery) does not hide the reason, but nothing is sent there, and no cause is read from it
      const startFailed = unstarted && engineStop;
      let busy = false;
      if (runner && worktree && existsDir(worktree)) {
        try {
          busy = runner.cwdBusy ? runner.cwdBusy(worktree) : true;
        } catch {
          busy = true;
        }
      }
      // the stage reads busyness as a stop; the failed start's card is asked as a lane with nothing running
      if (!stagePick("stall", evs, { ...asked, worktreeBusy: busy && !startFailed }, now).pick) continue;
      const noRepair = busy;

      // the causes, read from the worktree on an engine stop
      const causes: StallCause[] = !noRepair && runner && engineStop && executor?.worktree_path && existsDir(executor.worktree_path) ? worktreeCauses(evs, executor.worktree_path) : [];
      const instructed = instructedCauses(evs);
      const fresh = causes.filter((c) => !instructed.has(c));
      // where the instruction would go: a new executor session in the lane's worktree. Without one the envelope
      // would sit undelivered while the lane reads as the agent's, so the cause becomes a card instead.
      const canDeliver = canDeliverInstruction(executor);

      // a fresh cause is instructed for on the stop
      if (fresh.length && engineStop && canDeliver) {
        const instruction = instructionFor(fresh, evs, executor?.worktree_path ?? "");
        const head = executor?.worktree_path ? headCommit(executor.worktree_path) ?? "" : "";
        // the envelope is queued inside the gate: if it cannot be queued, nothing is recorded
        const written = await transition(rec.idd_id, "s4_verify_user_judgment_answered", { outcome: "revise", instruction, by: "harness", stall_causes: fresh }, {
          // the merge of the mainline is the one instruction with no design left to plan: only a conflict-only message skips the fix plan
          before: () => queueEnvelope(rec.idd_id, "lane_rejected", laneRejectedEnvelope(rec.idd_id, instruction, false), { ...(fresh.length === 1 && fresh[0] === "conflict" ? { skipFixPlan: true } : {}) }),
        });
        if (!written.ok) continue;
        invalidateProposal(rec.idd_id);
        await appendLifecycle(LANE_STALL_INSTRUCTED, rec.idd_id, { causes: fresh, head, instruction });
        result.instructed.push(rec.idd_id);
        continue;
      }

      // the halt: the engine's turn held on the same step past the setting, or a known cause with nowhere to send
      if (!engineStop && !(causes.length && !canDeliver)) continue;

      const errors = laneErrors(rec.idd_id, ctx);
      const reasonParts = [
        ...causes.map((c) => (instructed.has(c) ? `${CAUSE_LABEL[c]}（指示済み）` : `${CAUSE_LABEL[c]}（差し戻す先の executor session が無い）`)),
        ...errors.map((e) => `${e.source}: ${e.error}`),
        ...(skip ? [`${START_STAGE_LABEL[skip.stage]}を起こせない: ${skip.reason}`] : []),
      ].filter(Boolean);
      const last = withoutNotes(evs).at(-1);
      await appendLifecycle(LANE_STALL_DETECTED, rec.idd_id, {
        stage: stageLabel(evs),
        since: since ?? evs[evs.length - 1].at,
        last_event: { event: last?.event ?? "", at: last?.at ?? "" },
        reason: reasonParts.length ? reasonParts.join(" / ") : "engine の番のまま進んでいない",
        causes: causes.filter((c) => instructed.has(c)),
        can_send_back: canSendBack(executor),
      });
      result.halted.push(rec.idd_id);
    } catch (err) {
      result.errors += 1;
      console.warn(`[stall-watch] ${rec.idd_id} を見られませんでした: ${String(err).slice(0, 400)}`);
    }
  }
  return result;
}

/** whether a path is an existing directory (a missing worktree has no session running in it) */
function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether an instruction can reach an executor: it goes to a new session spawned in the lane's worktree, so a
 * record with a session id and a directory to work in has to be there. Without one the cause becomes a card.
 */
function canDeliverInstruction(executor: SessionRecord | undefined): boolean {
  return Boolean(executor?.executor_session_id && executor.worktree_path && existsDir(executor.worktree_path));
}

/** whether the lane's ship card can be built: a card that cannot is no turn of penne's */
function buildSubmitSafely(iddId: string): boolean {
  try {
    return buildSubmit(iddId) !== null;
  } catch {
    return false;
  }
}

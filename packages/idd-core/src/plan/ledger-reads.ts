import { laneAnswer } from "../intent/moonbit-fold.ts";
import { AnswerColumnUnreadable, readAnswerColumns, readLifecycle, unansweredOf, type AnswerColumns } from "../ledger/read.ts";
import type { FactNeed } from "../ledger/review-loop.ts";
import type { LifecycleRecord, PendingQuestionBatch } from "../schema/records.ts";

/**
 * The ledger's remaining readings: the PR a lane waits on, its end, the worktree a pass retires, the PR text it
 * drafts, and the lanes intake leaves out.
 *
 * Each is folded by the MoonBit module (`packages/idd-fold/ledger_reads.mbt`) from the lane's rows and the facts the
 * caller gathered, so the stage that acts on a lane and the screen that shows it read one answer (C-205-6). What the
 * rows do not hold — a session's worktree, a repo's local path, whether a file is on disk, whether a repo publishes,
 * whether a PR is open — crosses as a fact, and a reading that is only needed once the cheaper ones pass is asked for
 * when it is needed (C-200-2).
 *
 * A fold that cannot be read is a failure the caller sees, never a second reading in TypeScript.
 */

/** the PR a lane waits on, as its last `s4_pr_created` names it */
export interface PrWaiting {
  waiting: boolean;
  prNumber?: number;
  prUrl?: string;
}

/** a lane's end, as the retire stage and the stop of a discarded lane read it */
export interface LaneEnds {
  /** a final end closed the lane (the worktree is retired after it) */
  finally: boolean;
  /** penne took the lane out without its work (aborted, dropped, redone, or stopped at GO) */
  discarded: boolean;
}

/** how many times a reading is asked about before it gives up: a fold that asks more than this is broken */
const ASK_ROUNDS = 8;

interface Answer {
  needs?: FactNeed[];
}

/** ask a reading until the fold has every observation it needs; the caller reads only the facts it asked for */
export function askRead<T>(op: string, events: LifecycleRecord[], facts: Record<string, unknown>, observer: (need: FactNeed) => unknown): T {
  const given = { ...facts };
  for (let round = 0; round < ASK_ROUNDS; round += 1) {
    const answer = laneAnswer<T & Answer>(op, events, { facts: given });
    const needs = answer.needs ?? [];
    if (!needs.length) return answer as unknown as T;
    for (const need of needs) {
      if (need.id in given) continue;
      given[need.id] = observer(need) ?? null;
    }
  }
  throw new Error(`MoonBit の畳み（${op}）が答えを返しませんでした`);
}

/** the PR a lane waits on, or that it waits on none */
export function awaitingMerge(events: LifecycleRecord[]): PrWaiting {
  return laneAnswer<PrWaiting>("awaiting_merge", events);
}

/** whether a lane's own rows end it for good, and whether penne took it out without its work */
export function laneEnds(events: LifecycleRecord[]): LaneEnds {
  return laneAnswer<LaneEnds>("lane_ends", events);
}

/** whether a pass retires this lane's worktree, from the facts it gathered about it */
export function retirePick(events: LifecycleRecord[], facts: Record<string, unknown>): boolean {
  return laneAnswer<{ pick: boolean }>("retire_pick", events, { facts }).pick;
}

/** whether a pass writes this lane's kept record: the same path for the same reason is not written twice */
export function retireKept(events: LifecycleRecord[], facts: Record<string, unknown>): boolean {
  return laneAnswer<{ write: boolean }>("retire_kept", events, { facts }).write;
}

/**
 * The facts the PR draft's reading needs beyond the lane's rows: whether the runner drafts, whether a PR is open on
 * the record, and whether there is a submit view and linked repo to write from. The view is read only when the
 * cheaper readings have passed.
 */
export interface PrDraftFacts {
  publishes: boolean;
  hasDraftRunner: boolean;
  hasPrDraft: boolean;
  openPr: boolean;
}

export function prDraftPick(
  events: LifecycleRecord[],
  facts: PrDraftFacts,
  readings: () => { hasView: boolean; hasRepo: boolean },
): boolean {
  return askRead<{ pick: boolean }>("pr_draft_pick", events, { ...facts }, (need) => {
    if (need.kind !== "prDraftMaterial") return null;
    const read = readings();
    return { hasView: read.hasView, hasRepo: read.hasRepo };
  }).pick;
}

/** closed lanes, each with the time of its last close (ms; NaN when the event has no readable time) */
export function closedLanes(events: LifecycleRecord[]): Map<string, number> {
  const answers = laneAnswer<{ idd: string; at: number | null }[]>("closed_lanes", events);
  return new Map(answers.map((a) => [a.idd, a.at === null ? Number.NaN : a.at]));
}

/**
 * The batches still waiting for an answer: a question of it has none, and its lane has not ended. A lane that
 * ended has no planner to hear the answer (the outbox drops its envelope), so its questions stay in the record as
 * what the lane asked and are not waited on. The lane's end is the one `closedLanes` reads. Throws
 * `AnswerColumnUnreadable` when the answers' or the questions' column cannot be read: the list is not made on a column
 * read as empty, and a reader decides what it does without one. A caller that already read the columns passes what it
 * read, so the list and what it says about the columns come from one reading.
 */
export function readOpenQuestions(columns: AnswerColumns = readAnswerColumns()): PendingQuestionBatch[] {
  if (columns.unreadable.length) throw new AnswerColumnUnreadable(columns.unreadable.join("と"), new Error("読めない列があります"));
  const unanswered = unansweredOf(columns.batches, columns.answers);
  if (!unanswered.length) return unanswered;
  const ended = closedLanes(readLifecycle());
  return unanswered.filter((b) => !ended.has(b.idd_id));
}

/** the lanes whose Issue was landed into the work side's mainline (a close that names its merge commit) */
export function landedLanes(events: LifecycleRecord[]): Set<string> {
  return new Set(laneAnswer<string[]>("landed_lanes", events));
}

/** events after which a lane no longer goes on, as intake reads them */
export function laneEndedEvents(): readonly string[] {
  return laneAnswer<string[]>("lane_ended_events", []);
}

/** the ends after which a lane's worktree is retired */
export function finalEndEvents(): readonly string[] {
  return laneAnswer<string[]>("final_end_events", []);
}

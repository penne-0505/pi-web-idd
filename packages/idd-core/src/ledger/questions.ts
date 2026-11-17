import { laneAnswer } from "../intent/moonbit-fold.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The agent's questions and penne's answers, read from the records alone. The watch uses these to decide whether a
 * lane is waiting for penne (and must not be woken), and the stage split uses the same reading to cut the question
 * gate, so there is one interpretation of an unanswered batch.
 *
 * The reading is folded by the MoonBit module, so the watch, the turn and the card all read the same answer
 * (C-199-1). A batch is matched by its id, so an answer to one batch never counts for another.
 */

export const QUESTION_ASKED = "question_batch_asked";
export const QUESTION_ANSWERED = "question_batch_answered";

/** the shape the reading needs; a lifecycle record fits it */
export interface QuestionEvent {
  event: string;
  /** the record's time */
  at?: string;
  attrs?: Record<string, unknown>;
}

/**
 * The index of the oldest batch asked after `since` that penne has not answered, or -1. A batch that carries no
 * id needs any answer after it.
 */
export function oldestUnanswered(events: LifecycleRecord[], since = -1): number {
  return laneAnswer<number>("oldest_unanswered", events, { since });
}

/** Whether a batch the agent asked after `since` has no answer yet. */
export function awaitingAnswer(events: LifecycleRecord[], since: number): boolean {
  return laneAnswer<boolean>("awaiting_answer", events, { since });
}

/** every batch asked after `since` with no answer after it, oldest first (the question gate is open while it is not empty) */
export function unansweredQuestions(events: LifecycleRecord[], since = -1): { index: number; at: string }[] {
  return laneAnswer<{ index: number; at: string }[]>("unanswered_questions", events, { since });
}

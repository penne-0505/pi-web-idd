import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../paths.ts";
import { closedLanes } from "../plan/ledger-reads.ts";
import type { PendingQuestionBatch } from "../schema/records.ts";
import { readBacklog, readLifecycle, readQuestionBatches, unreadableAnswerColumns, unreadableColumnOf } from "./read.ts";
import { readJsonlCached } from "./read-cache.ts";

/**
 * The planner's batch the question judge holds, kept in a file of its own until the result is written. A batch is on no
 * question row, no lifecycle event and no card while the judge reads it (C-256-8), so the hold is the one durable mark
 * that it was asked. Two things read it. The GO's write side refuses while a lane holds a batch, a person's press and the
 * engine's automatic GO alike, because a GO that passed over a question the judge has not settled would leave it to be
 * asked after the GO. And a hold whose process died (the judge, the engine) is found on the next tick and written as
 * the person's, so the planner's questions and its answers are not lost.
 *
 * A hold is released by the batch landing in the records (its row and its asked event) or by its close, never by a row written to this
 * file, so there is nothing to forget to clear.
 */
const FILE = "question-routing-hold.jsonl";

export function routingHoldPath(): string {
  return join(stateDir(), FILE);
}

/** put a batch on hold; a batch already on hold is not written twice. Throws when the hold cannot be written. */
export function holdBatch(batch: PendingQuestionBatch): void {
  if (readHolds().some((b) => b.idd_id === batch.idd_id && b.batch_id === batch.batch_id)) return;
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(routingHoldPath(), `${JSON.stringify(batch)}\n`, "utf8");
}

function readHolds(): PendingQuestionBatch[] {
  return readJsonlCached<PendingQuestionBatch>(routingHoldPath());
}

/**
 * The batches on hold whose result is not on record: the batch has no row, or no asked event, and its lane is still
 * open. A lane that has ended or has no record has nobody to answer, so it holds nothing.
 *
 * While the questions' column cannot be read, no batch is known to have landed by its row, so a hold is not released by
 * it: a hold read as released would let a GO pass a question the judge has not settled, and the recovery write the batch
 * again. The close (the lifecycle) still releases it, and a column that can be read again releases it as before.
 */
export function heldBatches(iddId?: string): PendingQuestionBatch[] {
  const held = readHolds().filter((b) => !iddId || b.idd_id === iddId);
  if (!held.length) return [];
  // the holds only grow, so the landed ones are dropped by one pass over each column before anything costlier is read
  const lifecycle = readLifecycle();
  const batchKeysOf = (event: string): Set<string> =>
    new Set(lifecycle.filter((e) => e.event === event).map((e) => `${e.idd_id}/${String(e.attrs?.batch_id)}`));
  const asked = batchKeysOf("question_batch_asked");
  const rows = questionRowKeys();
  // a batch with its close is finished whatever else is missing: the close is the batch's last record, and a hold kept
  // on it would refuse the lane's GO for good (the asked event is never added after a close)
  const answered = batchKeysOf("question_batch_answered");
  const open = held.filter((b) => {
    const key = `${b.idd_id}/${b.batch_id}`;
    return !answered.has(key) && !(asked.has(key) && rows.has(key));
  });
  if (!open.length) return [];
  const ended = closedLanes(lifecycle);
  const lanes = new Set(readBacklog().map((b) => b.idd_id));
  return open.filter((b) => !ended.has(b.idd_id) && lanes.has(b.idd_id));
}

/** the batches the questions' column holds (`<lane>/<batch>`); empty while the column cannot be read, which releases no hold */
function questionRowKeys(): Set<string> {
  try {
    return new Set(readQuestionBatches().map((b) => `${b.idd_id}/${b.batch_id}`));
  } catch (err) {
    if (unreadableColumnOf(err)) return new Set();
    throw err;
  }
}

/**
 * why the lane takes no GO now, or null: the judge still holds a batch of its questions. While the questions' column
 * cannot be read, nobody is judging the batch that is held: the refusal names the column a person waits on instead.
 */
export function routingHoldReason(iddId: string): string | null {
  const held = heldBatches(iddId);
  if (!held.length) return null;
  const unreadable = unreadableAnswerColumns();
  if (unreadable.length) {
    return `${unreadable.join("と")}を読めないので GO できません（振り分け中の質問は${held.map((b) => b.batch_id).join(", ")}）。読めるようになってからもう一度押してください`;
  }
  return `計画役の質問を振り分けている最中なので GO できません（${held.map((b) => b.batch_id).join(", ")}）。結果が出て質問が出揃ってから GO してください`;
}

/**
 * The resumes under way, by lane. A resume delivers to a stopped session and then records its attempt; a hold made in
 * between would sit before a recovery attempt that was meant for a session nobody was judging for, and a delivery that
 * starts after the hold wakes the planner the judge is holding questions for. The two are ordered in one process by
 * turns with no await in them: the resume checks the hold and is marked as under way in one turn, and the hold's maker
 * checks `resumeUnderWay` and writes the hold in one turn inside the lane gate. So either the hold is there before the
 * resume starts (nothing is delivered), or the resume is under way when the hold would be made (no hold is made).
 * `settledResume` only spares a short resume from sending a batch to a person.
 */
const resuming = new Map<string, Set<Promise<unknown>>>();

/** run a lane's resume, marked as under way until it has been recorded; the mark is set in the turn this is called in */
export function resumingLane<T>(iddId: string, run: () => Promise<T>): Promise<T> {
  const p = run();
  const set = resuming.get(iddId) ?? new Set<Promise<unknown>>();
  resuming.set(iddId, set);
  set.add(p);
  const done = (): void => {
    set.delete(p);
    if (!set.size && resuming.get(iddId) === set) resuming.delete(iddId);
  };
  p.then(done, done);
  return p;
}

/** whether a resume of the lane is under way now; read in the turn the hold is written in */
export function resumeUnderWay(iddId: string): boolean {
  return (resuming.get(iddId)?.size ?? 0) > 0;
}

/** wait for the lane's resumes under way, for at most `waitMs`; a resume that outlasts it is not waited for further */
export async function settledResume(iddId: string, waitMs: number): Promise<void> {
  const set = resuming.get(iddId);
  if (!set?.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((r) => { timer = setTimeout(r, waitMs); });
  try {
    await Promise.race([Promise.allSettled([...set]), limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../paths.ts";
import { ColumnUnreadable, readJsonlCached, readJsonlColumn, reasonOf } from "./read-cache.ts";
import type {
  BacklogRecord, CronRunRecord, ExecutorProgress, LifecycleRecord,
  PendingAnswer, PendingQuestionBatch, PendingReview, SessionRecord,
} from "../schema/records.ts";

/** the small append-only files (backlog, sessions, the pending lists) share the ledger's incremental reader */
function readJsonl<T>(path: string): T[] {
  return readJsonlCached<T>(path);
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
export function readBacklog(): BacklogRecord[] {
  return readJsonl<BacklogRecord>(join(stateDir(), "backlog.jsonl"));
}

/** one directory's lifecycle reading: the files it held, their stats, and the rows they were folded into */
interface LifecycleCache {
  names: string[];
  stats: Map<string, { size: number; mtimeMs: number; ino: number }>;
  rows: LifecycleRecord[];
}

const lifecycles = new Map<string, LifecycleCache>();

/** what the columns are keyed on when a read asks whether anything moved since it last looked */
export { jsonlCacheRevision, resetJsonlCache } from "./read-cache.ts";

function statOf(path: string): { size: number; mtimeMs: number; ino: number } | null {
  const st = statSync(path, { throwIfNoEntry: false });
  return st ? { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } : null;
}

/**
 * The lifecycle read as one ledger: every `lifecycle-*.jsonl` of the state, joined, oldest first. The files are
 * appended by other processes too (the CLI writes its own), so each read lists the directory and looks at the
 * files' stats: while none of them, and no name, moved, the folded rows are handed back as they are. Only when
 * one moved is the ledger folded again — and then each file hands back what it already parsed, so the work is the
 * file that grew rather than every file. The `at` order is what the reader that read the whole ledger always made:
 * a stable sort over the rows in directory order, so a tie keeps the file's order and the line's order.
 */
export function readLifecycle(): LifecycleRecord[] {
  const dir = stateDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    lifecycles.delete(dir);
    return [];
  }
  const names = entries.filter((f) => f.startsWith("lifecycle-") && f.endsWith(".jsonl"));

  let fresh = false;
  const was = lifecycles.get(dir);
  if (was && was.names.length === names.length) {
    fresh = names.every((name, i) => was.names[i] === name);
    if (fresh) {
      for (const name of names) {
        const now = statOf(join(dir, name));
        const before = was.stats.get(name);
        if (!now || !before || now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ino !== before.ino) {
          fresh = false;
          break;
        }
      }
    }
  }
  if (fresh) return was!.rows.slice();

  const rows: LifecycleRecord[] = [];
  const stats = new Map<string, { size: number; mtimeMs: number; ino: number }>();
  for (const name of names) {
    const full = join(dir, name);
    // the mark is taken before the rows are read: a line appended in between is newer than the mark, so the next
    // read sees the file moved and picks the line up instead of calling the folded rows current
    const st = statOf(full);
    rows.push(...readJsonlCached<LifecycleRecord>(full));
    if (st) stats.set(name, st);
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  lifecycles.set(dir, { names, stats, rows });
  return rows.slice();
}

export function readPendingReviews(): PendingReview[] {
  return readJsonl<PendingReview>(join(stateDir(), "pending-reviews.jsonl"));
}

/** the answers' and the questions' columns, named as a refusal and a card name them */
export const COLUMN_NAMES = { answers: "答えの列", questions: "質問の列" } as const;

/**
 * An answers' or questions' column that is there and cannot be read. It is no empty list: a reader that would write on
 * "no answer" or "no question" waits on this, and a reader that lists what is open leaves the batch out. A column that
 * does not exist yet is the empty list those readers return.
 */
export class AnswerColumnUnreadable extends ColumnUnreadable {
  readonly column: string;
  constructor(column: string, why: unknown, path = "") {
    super(path, why, `${column}を読めません（${reasonOf(why)}）`);
    this.column = column;
  }
}

function readColumn<T>(file: string, column: string): T[] {
  try {
    return readJsonlColumn<T>(join(stateDir(), file));
  } catch (err) {
    if (err instanceof ColumnUnreadable) throw new AnswerColumnUnreadable(column, err.why, err.path);
    throw err;
  }
}

/** the name of the column an error says could not be read, or null when it says something else */
export function unreadableColumnOf(err: unknown): string | null {
  return err instanceof AnswerColumnUnreadable ? err.column : null;
}

/**
 * What the answers' and the questions' columns hold, read once. A column that cannot be read holds no rows here and is
 * named in `unreadable`: the rows of a column named there say nothing about the column, so a caller looks at
 * `unreadable` before it uses them. A column not there yet is readable and holds nothing.
 */
export interface AnswerColumns {
  answers: PendingAnswer[];
  batches: PendingQuestionBatch[];
  unreadable: string[];
}

export function readAnswerColumns(): AnswerColumns {
  const unreadable: string[] = [];
  const take = <T>(read: () => T[]): T[] => {
    try { return read(); } catch (err) {
      const name = unreadableColumnOf(err);
      if (!name) throw err;
      unreadable.push(name);
      return [];
    }
  };
  const answers = take(readAnswers);
  const batches = take(readQuestionBatches);
  return { answers, batches, unreadable };
}

/** the columns that cannot be read now, by name; empty when both can (a column not there yet can be read: it holds nothing) */
export function unreadableAnswerColumns(): string[] {
  return readAnswerColumns().unreadable;
}

/** throws `AnswerColumnUnreadable` unless both columns can be read: the check a writer makes before it writes a row that rests on "no answer" or "no question" */
export function requireReadableAnswerColumns(): void {
  readQuestionBatches();
  readAnswers();
}

/** one batch of the questions' column; undefined when the column holds none of it. Throws `AnswerColumnUnreadable` when the column cannot be read. */
export function readQuestionBatch(iddId: string, batchId: string): PendingQuestionBatch | undefined {
  return readQuestionBatches().find((b) => b.idd_id === iddId && b.batch_id === batchId);
}

/** every batch a planner asked, answered or not. Throws `AnswerColumnUnreadable` when the column cannot be read. */
export function readQuestionBatches(): PendingQuestionBatch[] {
  return readColumn<PendingQuestionBatch>("pending-questions.jsonl", COLUMN_NAMES.questions);
}

/** every answer on record. Throws `AnswerColumnUnreadable` when the column cannot be read. */
export function readAnswers(): PendingAnswer[] {
  return readColumn<PendingAnswer>("pending-answers.jsonl", COLUMN_NAMES.answers);
}

/**
 * The batches with a question no answer names, whatever has become of their lane. A reader that waits on the answer
 * reads `readOpenQuestions` (plan/ledger-reads.ts), which also leaves out the lanes that ended. The end is judged
 * there and not here because the TypeScript copies (overlay/land-failure-reference.ts, and plan/land-step-reference.ts
 * through it) import this file by value, through overlay/gate.ts and config/areas.ts, while plan/ledger-reads.ts
 * defines `closedLanes` on `laneAnswer`, which it imports from intent/moonbit-fold.ts. The "no TypeScript copy reaches
 * the MoonBit answers" test in no-reference-on-running-path.test.mjs fails any value path from a copy to the fold, so
 * this file reading the lanes' end through `closedLanes` would fail it.
 *
 * Throws `AnswerColumnUnreadable` when either column cannot be read: the answers' column read as empty would list a
 * batch whose questions were answered, and a person's press on it would be refused as a second answer.
 */
export function readUnansweredQuestions(): PendingQuestionBatch[] {
  const batches = readQuestionBatches();
  return unansweredOf(batches, readAnswers());
}

/** the batches of `batches` with a question no answer in `answers` names: the rule `readUnansweredQuestions` applies to rows already read */
export function unansweredOf(batches: PendingQuestionBatch[], answers: PendingAnswer[]): PendingQuestionBatch[] {
  const answered = new Set(answers.map((a) => `${a.idd_id}/${a.batch_id}/${a.question_id}`));
  return batches.filter((b) => b.questions.some((q) => !answered.has(`${b.idd_id}/${b.batch_id}/${q.question_id}`)));
}

export function readSessions(kind: "planner" | "executor"): SessionRecord[] {
  return readJsonl<SessionRecord>(join(stateDir(), `${kind}-sessions.jsonl`));
}

export function readProgress(iddId: string): ExecutorProgress | null {
  return readJson<ExecutorProgress>(join(stateDir(), `executor-progress-${iddId}.json`));
}

export function readLatestCronRun(): CronRunRecord | null {
  const dir = stateDir();
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith("cron-run-") && f.endsWith(".json"));
  if (!files.length) return null;
  const newest = files
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return readJson<CronRunRecord>(join(dir, newest.f));
}

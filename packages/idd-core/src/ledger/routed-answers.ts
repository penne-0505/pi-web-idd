import { ROUTED_BY, type PendingAnswerBasis, type PendingQuestionBatch } from "../schema/records.ts";
import { COLUMN_NAMES, readAnswers, readQuestionBatches, unreadableColumnOf } from "./read.ts";

/** a question the mechanism answered, read back from the answer's own row: what the GO card and the planner both show */
export interface RoutedDecision {
  batchId: string;
  questionId: string;
  question: string;
  answer: string;
  basis: PendingAnswerBasis[];
  reason: string;
  answeredBy: { role: string; model: string };
}

/** the columns the mechanism's answers are read from, named as a refusal and a card name them */
export const ROUTED_COLUMNS = COLUMN_NAMES;

export interface RoutedRead {
  decisions: RoutedDecision[];
  /** the columns that could not be read; empty when both were read (a column that does not exist yet is read: it holds nothing) */
  unreadable: string[];
}

/** one column read to its rows, or `none` with the column named in `unreadable` when it could not be read (a column not there yet reads as no rows) */
function readColumn<T>(name: string, read: () => T, none: T, unreadable: Set<string>): T {
  try {
    return read();
  } catch (err) {
    // only a column that cannot be read is named; any other failure is a real one and surfaces as itself
    if (!unreadableColumnOf(err)) throw err;
  }
  unreadable.add(name);
  return none;
}

/**
 * The questions of a lane (or of one batch) the mechanism answered, read from the answers' file and the questions' file,
 * and the columns that could not be read. An older row, which has no `answered_by`, is a person's answer and is left
 * out. A row of this lane that says it is the mechanism's (`answered_by`) but lacks its router or its basis, or cannot
 * be shaped into a decision (a quote of its basis that is not whole, or a question whose words are not on record), is
 * named as unreadable and kept out of the decisions, as a column that cannot be read is: it is neither dropped nor allowed to stop the card. A row that is not this lane's is none of this reading's
 * business, so one lane's bad row never stops another lane's GO. The GO card and the GO's refusal both take their word
 * of what is unconfirmed from this one reading, so "none" and "could not read" are never the same empty list.
 */
export function readRoutedDecisions(iddId: string, batchId?: string): RoutedRead {
  const unreadable = new Set<string>();
  const answers = readColumn(ROUTED_COLUMNS.answers, readAnswers, [], unreadable);
  const batches = readColumn(ROUTED_COLUMNS.questions, readQuestionBatches, [] as PendingQuestionBatch[], unreadable);
  const decisions: RoutedDecision[] = [];
  for (const a of answers) {
    if (!a || typeof a !== "object" || a.idd_id !== iddId || a.answered_by !== ROUTED_BY || (batchId && a.batch_id !== batchId)) continue;
    try {
      if (!a.router || typeof a.router !== "object" || !Array.isArray(a.basis) || !a.basis.length) {
        unreadable.add(`${ROUTED_COLUMNS.answers}（${String(a.batch_id)}/${String(a.question_id)} は仕組みの答えだが、router か basis が欠けている）`);
        continue;
      }
      const where = `${String(a.batch_id)}/${String(a.question_id)}`;
      if (!a.basis.every(basisReadable) || typeof a.selection?.label !== "string") {
        unreadable.add(`${ROUTED_COLUMNS.answers}（${where} の答えか引いた記録の形が不正）`);
        continue;
      }
      const question = textOfQuestion(batches.find((b) => b?.idd_id === iddId && b.batch_id === a.batch_id), a.question_id);
      // the question's own words are what a person confirms the answer against: an id in their place shows nothing to
      // check, so the answer is left unconfirmed until the questions' row can be read
      if (question === null) {
        unreadable.add(`${ROUTED_COLUMNS.questions}（${where} の質問の文が見つからない）`);
        continue;
      }
      decisions.push({
        batchId: a.batch_id,
        questionId: a.question_id,
        question,
        answer: a.selection.label,
        basis: a.basis,
        reason: a.reason ?? "",
        answeredBy: a.router,
      });
    } catch {
      unreadable.add(`${ROUTED_COLUMNS.answers}（${String(a.batch_id)}/${String(a.question_id)} の行の形が不正）`);
    }
  }
  return { decisions, unreadable: [...unreadable] };
}

/** whether a quote of an answer's basis is shaped as the card reads it: where it was found and what was quoted */
function basisReadable(b: unknown): b is PendingAnswerBasis {
  if (!b || typeof b !== "object") return false;
  const { source, ref, quote } = b as Record<string, unknown>;
  return (source === "choice" || source === "issue" || source === "norm") && typeof ref === "string" && typeof quote === "string";
}

/** a question's own words, or null when the batch, the question or its text cannot be found */
function textOfQuestion(batch: PendingQuestionBatch | undefined, questionId: string): string | null {
  try {
    const text = batch?.questions.find((q) => q?.question_id === questionId)?.question;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/** the card's line for answers that could not be confirmed */
export function routedUnconfirmedLine(unreadable: string[]): string {
  return `仕組みが代わりに答えた質問の確認が済んでいない: ${unreadable.join("・")}を読めなかったので、答えがあるかどうか分からない。読めるようになるまで GO は断られる`;
}

/** why a GO is refused while the mechanism's answers could not be read, or null when they were */
export function routedUnreadableReason(iddId: string): string | null {
  const { unreadable } = readRoutedDecisions(iddId);
  if (!unreadable.length) return null;
  return `仕組みが代わりに答えた質問の確認が済んでいないので GO できません（読めていない記録: ${unreadable.join("・")}）。読めるようになってからもう一度押してください`;
}

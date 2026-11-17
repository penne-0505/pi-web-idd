import { fold_records, lane_answer, lane_states, put_intent, put_lifecycle } from "../../../idd-fold/dist/idd-fold.js";

import type { LifecycleRecord } from "../schema/records.ts";
import type { FoldedRecords, IntentRow, LaneState } from "./store.ts";

/**
 * The fold itself lives in MoonBit (`packages/idd-fold`), and this is the one door every caller goes through:
 * the engine's screens, the write side's refusals and the CLI all read the same answer, because they all fold
 * through `laneStates` and `foldRows` in `store.ts` (P-4).
 *
 * The rows cross as JSON and are kept on the other side. A row is named by a number this side gives it, so a
 * row read once is handed over once: the state's answer folds the intent column for every card that shows a
 * Choice, and the columns are read again on every request. `readJsonlCached` hands the same row objects back
 * until the file is rewritten, so the number follows the reading: a row whose object this side has already
 * seen is not sent a second time, and a rewritten file's fresh objects are sent as new rows.
 *
 * A failure is a failure. Nothing here falls back to a fold written in TypeScript: two folds on the running
 * path would let the screen and the write side read different answers, and would hide a broken MoonBit fold
 * behind a silent second reading (C-186-2). The TypeScript fold stays for the cross-check only
 * (`fold-reference.ts`).
 */

/** what the MoonBit side answers with: a value, or the error it refused with */
type Exported<T> = { $tag: 1; _0: T } | { $tag: 0; _0: unknown };

function describe(error: unknown): string {
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** the value, or a failure the caller sees. */
function take<T>(answer: Exported<T>, step: string): T {
  if (answer.$tag !== 1) throw new Error(`MoonBit の畳み（${step}）が失敗しました: ${describe(answer._0)}`);
  return answer._0;
}

/** how many rows this process has handed over, per column: a row handed once is never handed again */
let lifecycleHanded = 0;
let intentHanded = 0;

/**
 * How many rows this process has handed to the fold, per column. A column that did not grow hands nothing more
 * over: the same reading answers again, and an append hands over what was appended.
 */
export function rowsHandedOver(): { lifecycle: number; intent: number } {
  return { lifecycle: lifecycleHanded, intent: intentHanded };
}

/** the numbers this side has given the row objects it read */
const lifecycleNumbers = new WeakMap<object, number>();
const intentNumbers = new WeakMap<object, number>();
/**
 * A column is a free JSONL file: a line may be a string, a number or an array (a hand edit, an older writer).
 * A primitive has no identity to number it by, so the number follows its value instead: the same line read
 * again is the same row, and a different line is a different one.
 */
const primitiveNumbers = new Map<string, number>();
/** the numbers the other side already holds */
const lifecycleSent = new Set<number>();
const intentSent = new Set<number>();
/** the names a reading was handed over under: the same array asked twice needs no renumbering or re-encoding */
const namedReadings = new WeakMap<object, { length: number; names: string }>();
let nextNumber = 1;

function numberOf(numbers: WeakMap<object, number>, row: unknown): number {
  const isObject = typeof row === "object" && row !== null;
  if (isObject) {
    const known = numbers.get(row as object);
    if (known !== undefined) return known;
  } else {
    const key = `${typeof row}:${JSON.stringify(row)}`;
    const known = primitiveNumbers.get(key);
    if (known !== undefined) return known;
  }
  const assigned = nextNumber;
  nextNumber += 1;
  if (isObject) numbers.set(row as object, assigned);
  else primitiveNumbers.set(`${typeof row}:${JSON.stringify(row)}`, assigned);
  return assigned;
}

/**
 * A lone UTF-16 surrogate — half of a pair, as a hand edit or an older writer can leave one — cannot be a MoonBit
 * string: its strings are UTF-8, and its JSON parser refuses the escape. Handing such a row over unchanged would
 * fail the whole column's transfer, where TypeScript folds the column. So the boundary replaces just that code
 * unit with U+FFFD; the row is still folded and only its own words differ, which is the exception C-191-4 records
 * (answer q-surrogate). The replacement is here, at the boundary, and never inside the fold.
 */
function boundaryValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  }
  if (Array.isArray(value)) return value.map(boundaryValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = boundaryValue(item);
    return out;
  }
  return value;
}

/**
 * The fixture's own replacement, for the cross-check: the TypeScript reading keeps the lone surrogate, the
 * MoonBit reading has U+FFFD, and the tests compare the two after the same replacement (C-191-4).
 */
export function boundaryText<T>(value: T): T {
  return boundaryValue(value) as T;
}

/** the numbers of the rows, in order, with the rows the other side does not hold yet handed over */
function namesOf(
  kind: "lifecycle" | "intent",
  rows: readonly unknown[],
): string {
  const kept = namedReadings.get(rows as object);
  if (kept && kept.length === rows.length) return kept.names;
  const numbers = kind === "lifecycle" ? lifecycleNumbers : intentNumbers;
  const sent = kind === "lifecycle" ? lifecycleSent : intentSent;
  const names: number[] = [];
  const fresh: [number, unknown][] = [];
  for (const row of rows) {
    const number = numberOf(numbers, row);
    names.push(number);
    if (!sent.has(number)) {
      fresh.push([number, row]);
      sent.add(number);
    }
  }
  if (fresh.length) {
    if (kind === "lifecycle") lifecycleHanded += fresh.length;
    else intentHanded += fresh.length;
    const text = JSON.stringify(boundaryValue(fresh));
    if (kind === "lifecycle") take(put_lifecycle(text), "lifecycle の行");
    else take(put_intent(text), "意図の列の行");
  }
  const encoded = names.join(" ");
  namedReadings.set(rows as object, { length: rows.length, names: encoded });
  return encoded;
}

/**
 * The same rows, folded once. The state's answer folds the intent column for every card that shows a Choice —
 * twenty lanes in one read — and the columns are read again every few seconds while they do not move. Folding
 * each of them again from the top is what takes the answer past the time the screens may wait (#179), so the
 * last answers are kept: the key holds the viewer, the row numbers and the lanes' states, and any of the three
 * moving makes it a different answer. An answer is handed out as its own arrays over the same records, so a
 * caller that appends to what it got does not change what the next reader sees.
 */
interface FoldedAnswer {
  records: FoldedRecords;
}
const foldedAnswers = new Map<string, FoldedAnswer>();
/** how many answers are kept: twenty lanes in a read, and the reads come back to the same lanes */
const FOLDED_KEPT = 24;

function shared(records: FoldedRecords): FoldedRecords {
  return {
    purposes: [...records.purposes],
    choices: [...records.choices],
    waives: [...records.waives],
    harmExamples: [...records.harmExamples],
  };
}

/** the answer to a reading, kept with the reading: the readings hand the same array back while nothing moved */
const statesKept = new WeakMap<object, { length: number; entries: [string, LaneState][] }>();

/** the lane states of the lifecycle rows, folded by the MoonBit fold */
export function moonbitLaneStates(events: LifecycleRecord[]): Map<string, LaneState> {
  // the readings hand the same array back while nothing moved, so the answer can be kept with it
  const kept = statesKept.get(events);
  if (kept && kept.length === events.length) return new Map(kept.entries);
  const folded = take(lane_states(namesOf("lifecycle", events)), "lane の状態") as string;
  const entries = Object.entries(JSON.parse(folded) as Record<string, LaneState>);
  statesKept.set(events, { length: events.length, entries });
  return new Map(entries);
}

/** the records one viewer sees, folded by the MoonBit fold */
export function moonbitFoldRows(rows: IntentRow[], viewer: string | null, states: Map<string, LaneState>): FoldedRecords {
  const numbers = namesOf("intent", rows);
  const lanes = JSON.stringify(Object.fromEntries(states));
  const key = `${viewer ?? "\u0000"}\u0001${numbers}\u0001${lanes}`;
  const kept = foldedAnswers.get(key);
  if (kept) {
    // the read moves it to the end: the lanes a screen keeps coming back to are the ones that stay
    foldedAnswers.delete(key);
    foldedAnswers.set(key, kept);
    return shared(kept.records);
  }
  const folded = take(fold_records(numbers, JSON.stringify(viewer), lanes), "意図の記録") as string;
  const records = JSON.parse(folded) as FoldedRecords;
  foldedAnswers.set(key, { records });
  if (foldedAnswers.size > FOLDED_KEPT) {
    const oldest = foldedAnswers.keys().next();
    if (!oldest.done) foldedAnswers.delete(oldest.value);
  }
  return shared(records);
}

/**
 * One answer of the lane derivations (the review loop, the stage, the lane's end and landing), folded by the
 * MoonBit module. The rows cross the same way the fold's do — a row handed once is named by its number — and the
 * answer comes back as JSON. A failure is a failure: nothing here falls back to the TypeScript derivation, which
 * stays off the running path (C-191-1).
 */
export function laneAnswer<T>(op: string, events: LifecycleRecord[], args: unknown = {}): T {
  const argsText = Object.keys(args as object).length ? JSON.stringify(boundaryValue(args)) : "";
  const answer = take(lane_answer(op, namesOf("lifecycle", events), argsText), `lane の答え（${op}）`) as string;
  return JSON.parse(answer) as T;
}

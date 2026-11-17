import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The mainline merge before a lane's first review, as the TypeScript read it. It is not on the running path: the
 * cross-check (`packages/idd-fold/crosscheck.mjs`) holds it against the MoonBit answer at every prefix of a real
 * ledger over a set of observations, and the committed fixture test (`packages/idd-core/test/pre-merge.test.mjs`)
 * holds both against each other.
 *
 * The answer is one step, or the facts it still wants, read from the lane's rows and the observations alone. A
 * helper's answer is read back under the fact the step named, so the answer is the same wherever it is asked.
 */

type Facts = Record<string, unknown>;

/** a reading the answer still wants: the name it is asked for under, and the kind of reading it is */
type Need = { id: string; kind: string; a: string; b: string };

const needOf = (kind: string): Need => ({ id: `${kind}||`, kind, a: "", b: "" });

/** the observations this answer reads, and the id each is asked for under */
const NEEDS = [
  "hasLocation",
  "publishes",
  "hasLocalPath",
  "hasWorkBase",
  "baseReadable",
  "hasReviewBase",
] as const;

function given(facts: Facts, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(facts, id);
}

/** the value of a fact, as the fold's own reading of a missing one (null) */
function valueOf(facts: Facts, id: string): unknown {
  return given(facts, id) ? facts[id] : null;
}

function jsString(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map(jsString).join(",");
  return "[object Object]";
}

/** the text of a fact, or the empty string where it holds nothing */
function textOf(value: unknown): string {
  return value === null || value === undefined ? "" : jsString(value);
}

/** whether a fact reads as a yes: the fold reads a false and a missing answer the same way */
function yesOf(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  return true;
}

const objOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const writeStep = (event: string, attrs: Record<string, unknown>) => ({ do: "write", event, attrs });
const writeEnd = (event: string, attrs: Record<string, unknown>, action: string) => ({ do: "write", event, attrs, action });
const callStep = (helper: string, site: string, keep: unknown, args: unknown) => ({
  do: "call",
  helper,
  site,
  fact: `call|${helper}|${site}`,
  keep,
  args,
  fatal: false,
  reread: false,
});
const action = (name: string) => ({ do: "action", action: name });
const actionError = (name: string, error: string) => ({ do: "action", action: name, error });
const pending = (needs: Need[]) => ({ needs });

/** a value the fold hands on as it read it: a missing one is the JSON null */
const held = (value: unknown): unknown => (value === undefined ? null : value);

/** the helper's answer, when the caller has already run it */
function answerOf(facts: Facts, helper: string, site: string): Record<string, unknown> {
  return objOf(objOf(valueOf(facts, `call|${helper}|${site}`)).result);
}

const called = (facts: Facts, helper: string, site: string): boolean => given(facts, `call|${helper}|${site}`);

const rowText = (row: LifecycleRecord, key: string): string => textOf((row.attrs ?? {})[key]);

const anyRow = (rows: LifecycleRecord[], event: string): boolean => rows.some((row) => row.event === event);

/** the same rebuild failure: the same side to blame for the same files; the reason's words carry a scratch path and the command's output, which differ between passes */
function sameFailure(a: unknown, b: unknown): boolean {
  const [x, y] = [objOf(a), objOf(b)];
  const paths = (value: unknown): string[] => (Array.isArray(value) ? value.map(jsString) : []);
  const [px, py] = [paths(x.paths), paths(y.paths)];
  return textOf(x.cause) === textOf(y.cause) && px.length === py.length && px.every((path, i) => path === py[i]);
}

/** a conflict that comes with a rebuild failure is on record only when a record of this head and mainline carries the same failure */
function conflictSeen(rows: LifecycleRecord[], head: string, mainTip: string, failure: unknown): boolean {
  return rows.some(
    (row) =>
      row.event === "s2_review_base_conflict" &&
      rowText(row, "head") === head &&
      rowText(row, "mainline") === mainTip &&
      (!yesOf(failure) || sameFailure((row.attrs ?? {}).rebuild_failure, failure)),
  );
}

function skipSeen(rows: LifecycleRecord[], head: string, mainTip: string, reason: string): boolean {
  return rows.some(
    (row) =>
      row.event === "s2_review_base_skipped" &&
      rowText(row, "head") === head &&
      rowText(row, "mainline") === mainTip &&
      rowText(row, "reason") === reason,
  );
}

/** the record a skip writes, and the pass it ends at: the review goes on after the skip */
function skipRecord(reason: string, head: string, mainTip: string) {
  const attrs: Record<string, unknown> = { reason };
  if (head !== "") attrs.head = head;
  if (mainTip !== "") attrs.mainline = mainTip;
  return writeEnd("s2_review_base_skipped", attrs, "proceed");
}

/** the review goes on without the merge: the origin moves first, then the skip is recorded once */
function skipOf(rows: LifecycleRecord[], facts: Facts, reason: string, head: string, mainTip: string): unknown {
  if (head !== "" && mainTip !== "" && !called(facts, "advance_origin", "skip")) {
    return callStep("advance_origin", "skip", null, { head, mainline: mainTip });
  }
  if (skipSeen(rows, head, mainTip, reason)) return action("proceed");
  return skipRecord(reason, head, mainTip);
}

/** the conflict's record: the commits and files it was read at, whether the lane waits, and why generated files could not be made again */
function conflictAttrs(head: string, mainTip: string, files: unknown, awaiting: boolean, failure: unknown): Record<string, unknown> {
  return { head, mainline: mainTip, files, awaiting, ...(yesOf(failure) ? { rebuild_failure: failure } : {}) };
}

/** a merge that conflicts: the executor is put to it once, and a later look lets the review begin */
function conflictOf(rows: LifecycleRecord[], facts: Facts, head: string, mainTip: string, tree: Record<string, unknown>, failure: unknown): unknown {
  const seen = conflictSeen(rows, head, mainTip, failure);
  const instructed = anyRow(rows, "s2_review_base_instructed");
  if (!instructed) {
    if (!seen) {
      return writeStep("s2_review_base_conflict", conflictAttrs(head, mainTip, held(tree.files), true, failure));
    }
    if (!called(facts, "conflict_envelope", "conflict")) {
      return callStep("conflict_envelope", "conflict", { head, mainline: mainTip }, { head, mainline: mainTip, files: held(tree.files) });
    }
    const sent = answerOf(facts, "conflict_envelope", "conflict");
    if (textOf(sent.error) !== "") {
      return actionError("awaiting", `解消の指示を積めませんでした: ${textOf(sent.error)}`);
    }
    return writeEnd("s2_review_base_instructed", { head, mainline: mainTip, files: held(tree.files) }, "awaiting");
  }
  if (!called(facts, "advance_origin", "conflict")) {
    return callStep("advance_origin", "conflict", null, { head, mainline: mainTip });
  }
  if (!seen) {
    return writeStep("s2_review_base_conflict", conflictAttrs(head, mainTip, held(tree.files), false, failure));
  }
  return action("proceed");
}

/** the lane's head and the mainline's tip, as one try read them: a pair, or nothing while a fact is missing */
function headAndTip(facts: Facts, needs: Need[]): [string, string] | null {
  if (!given(facts, "head||")) {
    needs.push(needOf("head"));
    return null;
  }
  if (!given(facts, "mainTip||")) {
    needs.push(needOf("mainTip"));
    return null;
  }
  const head = textOf(valueOf(facts, "head||"));
  const tip = textOf(valueOf(facts, "mainTip||"));
  return head === "" || tip === "" ? ["", ""] : [head, tip];
}

/** the merge before the first review, as a step or the facts it still wants */
export function preMergeReference(rows: LifecycleRecord[], facts: Facts): unknown {
  const needs: Need[] = [];
  for (const name of NEEDS) {
    if (!given(facts, `${name}||`)) needs.push(needOf(name));
  }
  if (needs.length) return pending(needs);
  if (
    !yesOf(valueOf(facts, "hasLocation||")) ||
    yesOf(valueOf(facts, "publishes||")) ||
    !yesOf(valueOf(facts, "hasLocalPath||")) ||
    !yesOf(valueOf(facts, "hasWorkBase||")) ||
    !yesOf(valueOf(facts, "baseReadable||")) ||
    !yesOf(valueOf(facts, "hasReviewBase||"))
  ) {
    return action("none");
  }
  const pair = headAndTip(facts, needs);
  if (pair === null) return pending(needs);
  const [head, mainTip] = pair;
  if (head === "" || mainTip === "") {
    return skipOf(rows, facts, `レビュー前の merge に要る commit を読めません: ${textOf(valueOf(facts, "readError||"))}`, head, mainTip);
  }
  if (!given(facts, "ancestor||")) {
    needs.push(needOf("ancestor"));
    return pending(needs);
  }
  const ancestor = valueOf(facts, "ancestor||");
  if (!yesOf(ancestor)) {
    return skipOf(rows, facts, `レビュー前の merge の要否を git が答えられません: ${textOf(valueOf(facts, "ancestorError||"))}`, head, mainTip);
  }
  const headHas = yesOf(objOf(ancestor).headHas);
  const baseHas = yesOf(objOf(ancestor).baseHas);
  if (headHas && baseHas) return action("none");
  if (headHas) {
    if (!called(facts, "review_base", "head_has")) return callStep("review_base", "head_has", null, null);
    const read = answerOf(facts, "review_base", "head_has");
    if (textOf(read.error) !== "") {
      return skipOf(rows, facts, `起点を進められません: ${textOf(read.error)}`, head, mainTip);
    }
    if (!called(facts, "record_executor_merge", "head_has")) {
      return callStep("record_executor_merge", "head_has", { head, mainline: mainTip }, { head, mainline: mainTip, reviewBase: held(read.reviewBase) });
    }
    const wrote = answerOf(facts, "record_executor_merge", "head_has");
    if (textOf(wrote.error) !== "") {
      return skipOf(rows, facts, `起点の記録を書けません: ${textOf(wrote.error)}`, head, mainTip);
    }
    return action("merged");
  }
  if (!given(facts, "runnerPresent||")) {
    needs.push(needOf("runnerPresent"));
    return pending(needs);
  }
  if (!yesOf(valueOf(facts, "runnerPresent||"))) {
    return skipOf(rows, facts, "agent の runtime が無いので、この worktree で session が動いていないか確かめられません", head, mainTip);
  }
  if (!given(facts, "busy||")) {
    needs.push(needOf("busy"));
    return pending(needs);
  }
  if (yesOf(valueOf(facts, "busyError||"))) {
    return skipOf(rows, facts, `worktree の session の有無を確かめられません: ${textOf(valueOf(facts, "busyError||"))}`, head, mainTip);
  }
  if (yesOf(valueOf(facts, "busy||"))) return action("busy");
  if (!called(facts, "lock_lane", "merge")) return callStep("lock_lane", "merge", null, null);
  const lock = answerOf(facts, "lock_lane", "merge");
  if (!yesOf(lock.held)) {
    return skipOf(rows, facts, `lane の lock を取れません: ${textOf(lock.error)}`, head, mainTip);
  }
  if (!called(facts, "read_merge_state", "merge")) return callStep("read_merge_state", "merge", null, null);
  const read = answerOf(facts, "read_merge_state", "merge");
  if (textOf(read.error) !== "") {
    return skipOf(rows, facts, `レビュー前の本流の merge に失敗しました: ${textOf(read.error)}`, head, mainTip);
  }
  if (!yesOf(read.clean)) return skipOf(rows, facts, "lane に未 commit の変更があります", head, mainTip);
  if (!yesOf(read.onBranch)) return skipOf(rows, facts, "lane の worktree が lane の branch にありません", head, mainTip);
  if (!yesOf(read.headStill)) return skipOf(rows, facts, "lane の head が変わりました", head, mainTip);
  if (yesOf(read.unreadable)) {
    return skipOf(rows, facts, `merge-tree が答えられません: ${textOf(read.mergeError)}`, head, mainTip);
  }
  // generated files are made again from the sources of the tree git wrote, whether git called them a conflict or not;
  // a conflict with a source in it goes to the executor as it always did (C-266-1)
  const conflicted = yesOf(read.conflict);
  const rebuild = conflicted ? yesOf(read.generatedOnly) : yesOf(read.rebuild);
  if (conflicted && !rebuild) return conflictOf(rows, facts, head, mainTip, read, null);
  let tree: unknown = read.tree;
  let failure: unknown = null;
  if (rebuild) {
    if (!called(facts, "rebuild_generated", "merge")) return callStep("rebuild_generated", "merge", null, { tree: held(read.tree), outputs: held(read.outputs) });
    const rebuilt = answerOf(facts, "rebuild_generated", "merge");
    if (yesOf(rebuilt.failure)) {
      failure = rebuilt.failure;
      if (conflicted) return conflictOf(rows, facts, head, mainTip, read, failure);
    } else if (yesOf(rebuilt.tree)) {
      tree = rebuilt.tree;
    }
  }
  if (!called(facts, "review_base", "merge")) return callStep("review_base", "merge", null, null);
  const origin = answerOf(facts, "review_base", "merge");
  if (textOf(origin.error) !== "") {
    return skipOf(rows, facts, `起点を進められません: ${textOf(origin.error)}`, head, mainTip);
  }
  if (!called(facts, "merge_mainline", "merge")) {
    return callStep(
      "merge_mainline",
      "merge",
      { head, mainline: mainTip },
      { head, mainline: mainTip, tree: held(tree), reviewBase: held(origin.reviewBase), ...(yesOf(failure) ? { rebuildFailure: failure } : {}) },
    );
  }
  const merged = answerOf(facts, "merge_mainline", "merge");
  if (textOf(merged.error) !== "") {
    return skipOf(rows, facts, `レビュー前の本流の merge に失敗しました: ${textOf(merged.error)}`, head, mainTip);
  }
  return action("merged");
}

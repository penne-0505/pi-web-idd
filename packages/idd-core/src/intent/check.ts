/**
 * The mechanical check of the v2 records: does the state hold the shapes the standard asks for? The rules are
 * split by what they need to see. The state rules read the column, the folded result for one viewer and that
 * lane's lifecycle, and decide everything that follows from the records alone. The tree rules read the caller's
 * worktree through two functions handed in, so the engine (which has no worktree) never reads a file and the CLI
 * (which does not read the column) never opens the state. Nothing here reads or writes a file, and no rule looks
 * at the quality of a Why: the number of items, the length of a line, the words a source uses and how many
 * rejected forms a record lists are the reviewer's business, not the machine's.
 */

import { isExecutorWork } from "../plan/watch.ts";
import { replanView } from "../ledger/replan-view.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { OVERVIEW_PURPOSE_ID, isMigratedChoiceId, isPurposeId, canonicalPlace, type ChoiceStatus, type Place } from "./records.ts";
import { isChoiceKey, markHits, movedPlaces, placeHits, type FoldedRecords, type IntentRow } from "./store.ts";
import { PROJECTION_MARK, type ProjectionFile } from "./projection.ts";
import { PROJECT_EVENTS, isProjectId, type ProjectView } from "./project.ts";
import { laneRecordShape, type RecordShape } from "../plan/record-shape.ts";

/** error decides the exit code; a note is shown but does not; a mark is the maintenance mark and does not either */
export type FindingWeight = "error" | "note" | "mark";

export interface CheckFinding {
  weight: FindingWeight;
  /** the name of the rule that found it */
  rule: string;
  /** the record it is about; a round finding names the lane, an id-less row names "" */
  id: string;
  reason: string;
}

/** one Choice the tree rules look at, with whether the lane that is asking wrote it */
export interface CheckChoice {
  id: string;
  status: ChoiceStatus;
  place: Place[];
  mine: boolean;
  /** the verification anchors: test names or AC ids, each a mark when it leaves the tree */
  verification?: string[];
}

export interface RoundView {
  /** the lane has an `s2_start`: it has entered the implementation round */
  enteredImplementation: boolean;
}

export interface StateCheckInput {
  /** every row of the column, effective or not: the id rules count them all */
  rows: IntentRow[];
  /** the column folded for the viewer: a lane sees its own records before they merge */
  folded: FoldedRecords;
  /** the lane asking, or null for the lane's outside */
  lane: string | null;
  /** that lane's lifecycle rows */
  events: LifecycleRecord[];
  /** the Projects the same viewer sees; absent checks none (a caller that holds no Project) */
  projects?: ProjectView[];
}

export interface StateCheckResult {
  findings: CheckFinding[];
  /** the active and unconfirmed Choices, with the lane's mark, for the tree rules */
  choices: CheckChoice[];
  rounds: RoundView;
  /** the lane's intent-record shape: the CLI reads it to weight its own tree rules the same way */
  records_shape: RecordShape;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** the lane a row was written by; a session row is the lane's outside */
function laneOf(row: IntentRow): string | null {
  const by = row.by;
  return by && "lane" in by && typeof by.lane === "string" ? by.lane : null;
}

/** the id a raise carries, in the shape the column's writers use: a Purpose, a Choice key with a number, or a migrated DEC */
function raisedIdShape(row: IntentRow, id: string): boolean {
  if (row.event === "purpose_raised") return isPurposeId(id);
  if (row.event === "choice_raised") {
    if (isMigratedChoiceId(id)) return true;
    const m = /^C-(.+)-(\d+)$/.exec(id);
    return Boolean(m && isChoiceKey(m[1]));
  }
  return true;
}

const ROUND_RECORDS = ["choice_raised", "choice_superseded", "choice_reanchored", "waive"];

/**
 * The rounds of a lane, from its lifecycle. A closed round is one per run of `s2_result`s that no record handing
 * the executor work falls between, running from the previous round (or the lane's beginning) to the run's last
 * result; its outcome is the last report's, so a failed last report closes the round but asks for no record. The
 * results are grouped this way because a lane may report again after continuing the same work, and the watch hands
 * the executor its next piece of work on the same records: one boundary means a resend cannot open a round nobody
 * was asked to speak in. A round still open is the one after the last result when some record handed the executor
 * work, or everything the lane did when no result has come yet. What counts as a record is the lane's own raise,
 * Re-anchor, Supersede or Waive inside the round. The list of records that hand work over is the watch's own: a
 * copy here would go stale the moment a new one is added, and the round it opens would read as silent.
 */
function roundFindings(rows: IntentRow[], lane: string | null, events: LifecycleRecord[], weight: FindingWeight): CheckFinding[] {
  if (!lane) return [];
  const findings: CheckFinding[] = [];
  const mine = rows.filter((r) => laneOf(r) === lane && ROUND_RECORDS.includes(r.event) && typeof r.at === "string");
  const ms = (at: string): number => Date.parse(at);
  const results = events
    .filter((e) => e.event === "s2_result" && typeof e.at === "string")
    .sort((a, b) => ms(a.at) - ms(b.at));
  const startAt = events.map((e) => e.at).filter((at): at is string => typeof at === "string").sort((a, b) => ms(a) - ms(b))[0];
  const start = startAt === undefined ? Number.NEGATIVE_INFINITY : ms(startAt);
  const within = (row: IntentRow, lower: number, upper: number, lowerInclusive: boolean): boolean => {
    const t = ms(row.at as string);
    if (Number.isNaN(t)) return false;
    return (lowerInclusive ? t >= lower : t > lower) && t <= upper;
  };
  const workTimes = events
    .filter((e) => isExecutorWork(e) && typeof e.at === "string")
    .map((e) => ms(e.at));
  const separated = (from: number, to: number): boolean => workTimes.some((t) => t > from && t < to);
  const closed: { result: LifecycleRecord; from: number }[] = [];
  let lower = start;
  let group: LifecycleRecord | null = null;
  for (const result of results) {
    if (group !== null) {
      if (!separated(ms(group.at), ms(result.at))) {
        // no work was handed over in between: the result only moves the end of the round already open
        group = result;
        continue;
      }
      closed.push({ result: group, from: lower });
      lower = ms(group.at);
    }
    group = result;
  }
  if (group !== null) closed.push({ result: group, from: lower });
  for (const { result, from } of closed) {
    const upper = ms(result.at);
    if (result.attrs?.outcome !== "failed" && !mine.some((row) => within(row, from, upper, false))) {
      findings.push({
        weight,
        rule: "round",
        id: lane,
        reason: `巡（${result.at} まで）に Choice の新設・Re-anchor・Supersede・Waive がありません`,
      });
    }
  }
  const lastResult = results.length ? ms(results[results.length - 1].at) : null;
  const workAfter = lastResult === null
    ? events.some((e) => isExecutorWork(e))
    : events.some((e) => isExecutorWork(e) && ms(e.at) > lastResult);
  if (workAfter) {
    const from = lastResult ?? start;
    if (!mine.some((row) => within(row, from, Number.POSITIVE_INFINITY, lastResult === null))) {
      findings.push({
        weight,
        rule: "round",
        id: lane,
        reason: "作業中の巡に Choice の新設・Re-anchor・Supersede・Waive がありません",
      });
    }
  }
  return findings;
}

/**
 * The rules that follow from the state alone. A finding about a record the lane wrote, or about an id the lane
 * wrote one of the overlapping rows for, is an error; everything else is a note, because a lane cannot fix
 * another lane's records before they merge and must not be stopped by them. A call that names no lane is the
 * lane's outside, which can fix the whole state, so every finding there is an error. A Choice the lane only
 * Re-anchored is the lane's for its Place alone: Re-anchor moves the Place without judging the body, so a gap in
 * the body that was already there when the lane took it over is not the lane's to answer for (C-145-1). The body
 * rules read the ids the lane raised; the Place rules read the ids the lane raised or Re-anchored.
 */
export function checkState(input: StateCheckInput): StateCheckResult {
  const { rows, folded, lane } = input;
  const findings: CheckFinding[] = [];
  // a v2 lane is held to the round and unconfirmed rules; a v1 lane is only told (INV-119-6)
  const shape: RecordShape = lane ? laneRecordShape(lane, input.events) : "docs";
  const weightFor = (mine: boolean): FindingWeight => (lane === null || mine ? "error" : "note");
  const add = (mine: boolean, rule: string, id: string, reason: string): void => {
    findings.push({ weight: weightFor(mine), rule, id, reason });
  };

  const mineChoices = new Set<string>();
  const mineBodies = new Set<string>();
  const minePurposes = new Set<string>();
  for (const row of rows) {
    if (laneOf(row) !== lane || lane === null) continue;
    const id = text(row.id);
    if (!id) continue;
    if (row.event === "choice_raised") { mineChoices.add(id); mineBodies.add(id); }
    else if (row.event === "choice_reanchored") mineChoices.add(id);
    else if (row.event === "purpose_raised") minePurposes.add(id);
  }
  const mineChoice = (id: string): boolean => lane !== null && mineChoices.has(id);
  const mineBody = (id: string): boolean => lane !== null && mineBodies.has(id);

  for (const p of folded.purposes) {
    if (!p.statement) add(minePurposes.has(p.id), "required", p.id, "必須の欄 statement が空です");
    if (!p.origin) add(minePurposes.has(p.id), "required", p.id, "必須の欄 origin が空です");
  }
  for (const c of folded.choices) {
    const mine = mineBody(c.id);
    if (!c.purpose) add(mine, "required", c.id, "必須の欄 purpose が空です");
    if (!c.forms?.chosen) add(mine, "required", c.id, "必須の欄 forms.chosen が空です");
    if (!c.place.length) add(mine, "required", c.id, "必須の欄 place が空です");
    if (!c.why) add(mine, "required", c.id, "必須の欄 why が空です");
    if (!c.anchored) add(mine, "required", c.id, "必須の欄 anchored が空です");
  }

  const purposes = new Map(folded.purposes.map((p) => [p.id, p]));
  const choiceIds = new Set(folded.choices.map((c) => c.id));
  for (const c of folded.choices) {
    if (c.status !== "active" && c.status !== "unconfirmed") continue;
    const mine = mineBody(c.id);
    const purpose = purposes.get(c.purpose);
    if (!purpose) add(mine, "purpose", c.id, `Purpose ${c.purpose || "(なし)"} がありません`);
    else if (purpose.status !== "active") add(mine, "purpose", c.id, `Purpose ${purpose.id} は active ではありません（${purpose.status}）`);
  }

  for (const c of folded.choices) {
    if (c.forms?.rejected?.length) continue;
    if (c.waives?.length) continue;
    add(mineBody(c.id), "rejected", c.id, "捨てた形も no-why-not の理由もありません");
  }

  for (const c of folded.choices) {
    if (c.status !== "superseded") continue;
    const mine = mineBody(c.id);
    const entry = [...c.history].reverse().find((h) => h.event === "superseded");
    if (!entry?.successor) {
      add(mine, "successor", c.id, "後継の ID がありません");
      continue;
    }
    if (!choiceIds.has(entry.successor)) add(mine, "successor", c.id, `後継 ${entry.successor} が実在しません`);
  }

  const raising = rows.filter((r) => r.event === "purpose_raised" || r.event === "choice_raised");
  const byId = new Map<string, IntentRow[]>();
  for (const row of raising) {
    const id = text(row.id);
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    // the overview's seat is the one id a person may raise again once it no longer holds (the store checks that); no other id is excused
    if (id === OVERVIEW_PURPOSE_ID && list.every((r) => r.event === "purpose_raised")) continue;
    add(list.some((r) => laneOf(r) === lane), "id-duplicate", id, `ID ${id} が ${list.length} 行で重なっています`);
  }
  for (const row of raising) {
    const id = text(row.id);
    const mine = laneOf(row) === lane;
    if (!id) add(mine, "id-shape", "", "ID がありません");
    else if (!raisedIdShape(row, id)) add(mine, "id-shape", id, `ID ${id} の形が違います`);
  }

  findings.push(...projectFindings(input, weightFor));

  const choices: CheckChoice[] = folded.choices
    .filter((c) => c.status === "active" || c.status === "unconfirmed")
    .map((c) => ({ id: c.id, status: c.status, place: c.place, mine: mineChoice(c.id), ...(c.verification?.length ? { verification: c.verification } : {}) }));

  findings.push(...roundFindings(rows, lane, input.events, lane === null || shape === "state" ? "error" : "note"));
  return {
    findings,
    choices,
    // the rows of a lane sent back to its plan are read through the view of that return: the earlier implementation is
    // not this plan's, so the plan stage's lenience is the lane's again until its next start
    rounds: { enteredImplementation: replanView(input.events).some((e) => e.event === "s2_start") },
    records_shape: shape,
  };
}

/**
 * The Project rules, which follow from the state alone like the Choice rules: the required fields, the Purpose the
 * Project points at, the Choice each moved decision points at, and the raise's id. A Project is the lane's when the
 * lane wrote any row of it, and only then is a finding an error to the lane; the lane's outside is held to all of them.
 * A moved decision whose Choice was superseded or dropped is always a note: nothing re-points a Project's decision at
 * another Choice, so an error could not be cleared.
 */
function projectFindings(input: StateCheckInput, weightFor: (mine: boolean) => FindingWeight): CheckFinding[] {
  const { rows, folded, lane } = input;
  const findings: CheckFinding[] = [];
  const add = (mine: boolean, rule: string, id: string, reason: string): void => {
    findings.push({ weight: weightFor(mine), rule, id, reason });
  };
  const mineProjects = new Set<string>();
  if (lane !== null) {
    for (const row of rows) {
      if (laneOf(row) !== lane) continue;
      const id = text(row.id);
      if (id && typeof row.event === "string" && row.event.startsWith("project_")) mineProjects.add(id);
      const from = row.from_decision && typeof row.from_decision === "object" ? text((row.from_decision as Record<string, unknown>).project) : null;
      if (from) mineProjects.add(from);
    }
  }
  const mine = (id: string): boolean => lane !== null && mineProjects.has(id);
  const purposes = new Map(folded.purposes.map((p) => [p.id, p]));
  const choices = new Map(folded.choices.map((c) => [c.id, c]));
  for (const p of input.projects ?? []) {
    if (!p.name) add(mine(p.id), "required", p.id, "必須の欄 name が空です");
    if (!p.doneWhen) add(mine(p.id), "required", p.id, "必須の欄 done_when が空です");
    const purpose = purposes.get(p.purpose);
    if (!p.purpose) add(mine(p.id), "project-purpose", p.id, "必須の欄 purpose が空です");
    else if (!purpose) add(mine(p.id), "project-purpose", p.id, `Purpose ${p.purpose} がありません`);
    else if (purpose.status !== "active") add(mine(p.id), "project-purpose", p.id, `Purpose ${purpose.id} は active ではありません（${purpose.status}）`);
    for (const d of p.decisions) {
      if (!d.movedTo) continue;
      const target = choices.get(d.movedTo);
      const where = `${p.id} の決定 ${d.id} の移し先 ${d.movedTo}`;
      if (!target) add(mine(p.id), "project-decision", d.id, `${where} が状態にありません`);
      else if (target.status === "superseded") {
        const successor = [...target.history].reverse().find((h) => h.event === "superseded")?.successor;
        findings.push({ weight: "note", rule: "project-decision", id: d.id, reason: `${where} は superseded です${successor ? `（後継 ${successor}）` : ""}。Project の決定が指す先の読み替えは別の操作が要ります` });
      } else if (target.status === "dropped") findings.push({ weight: "note", rule: "project-decision", id: d.id, reason: `${where} は dropped です。Project の決定が指す先がありません` });
    }
  }
  const raising = new Map<string, IntentRow[]>();
  for (const row of rows) {
    const id = row.event === PROJECT_EVENTS.raised ? text(row.id) : null;
    if (id) raising.set(id, [...(raising.get(id) ?? []), row]);
  }
  for (const [id, list] of raising) {
    if (!isProjectId(id)) add(list.some((r) => laneOf(r) === lane), "id-shape", id, `ID ${id} の形が違います`);
    if (list.length > 1) add(list.some((r) => laneOf(r) === lane), "id-duplicate", id, `ID ${id} が ${list.length} 行で重なっています`);
  }
  return findings;
}

/** how a repo-root relative path looks on the caller's disk */
export type TreePathKind = "file" | "dir" | "missing";

export interface TreeMove {
  /** the path the lane moved a file or a dir from; a dir keeps its trailing `/` */
  from: string;
  to: string;
}

export interface TreeCheckInput {
  choices: CheckChoice[];
  rounds: RoundView;
  /** the lane asking, or null for the lane's outside */
  lane: string | null;
  /** the files the lane touched, deleted ones included; null when no lane is named */
  changed: string[] | null;
  /** the lane's record shape, as the state check reported it; a v2 lane's unconfirmed rule is an error */
  recordsShape?: RecordShape;
  /** the renames the lane made, read the way the landing reads them: a Place on an old path is read at the new one */
  moves?: TreeMove[];
  /** whether a file of this name stands anywhere in the caller's tree (a verification anchor written as a bare name) */
  hasFileNamed?: (name: string) => boolean;
  kindOf: (path: string) => TreePathKind;
  readFile: (path: string) => string | null;
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

const INTENT_ROOT = "_docs/intent/";
const ARCHIVE_INTENT_ROOT = "_docs/archives/intent/";

/**
 * The archive path a file Place under `_docs/intent/` maps to, or null for any other path. A closed lane's
 * decision.md is moved to `_docs/archives/intent/` at the same relative path, so a Place that names the old path
 * still names the document. Only `_docs/intent/` file Places are rewritten: a directory Place and a path outside
 * the place keep their own reading.
 */
export function archivedIntentPath(path: string): string | null {
  return path.startsWith(INTENT_ROOT) ? `${ARCHIVE_INTENT_ROOT}${path.slice(INTENT_ROOT.length)}` : null;
}

/** true when the word stands in the text with no identifier character against either end */
function hasWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + word.length] ?? "";
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return true;
  }
  return false;
}

/**
 * Whether a Place's symbol still stands in the file. A plain word is looked for as one word. A symbol naming a path
 * or a member (`Conversation.remove`, `pipeline.review_loop`) is split on `.` and every segment has to stand as a
 * word of its own: the whole string never appears in the text, so looking for it as one word marked symbols that
 * were really there (C-145-3). The order and adjacency of the segments are not required, so the reading does not
 * depend on the language's own syntax; an empty segment (a leading or trailing dot) is not a word and is dropped.
 */
function hasSymbol(text: string, symbol: string): boolean {
  if (!symbol.includes(".")) return hasWord(text, symbol);
  const segments = symbol.split(".").filter((part) => part.length > 0);
  if (!segments.length) return hasWord(text, symbol);
  return segments.every((part) => hasWord(text, part));
}

/** whether the module a Place names stands in the tree: a dir, or the repo's own root */
function moduleInTree(path: string, kindOf: (path: string) => TreePathKind): boolean {
  if (path === "/") return true;
  return kindOf(path) === "dir";
}

/**
 * The archive path a file's module resolves to, or null. Only a Place written against a file is read this way: a
 * closed lane's decision.md moves to `_docs/archives/intent/` at the same relative path, so the Place that names the
 * old document still names it. A dir's own Choice is not this document's, and keeps its own reading (DEC-120-10).
 */
function archivedModulePath(place: Place): string | null {
  if (!place.file) return null;
  return archivedIntentPath(place.path);
}

/** an AC id: the lane's own records hold it, not the tree */
const CRITERION_ID = /^(?:AC|QA)-[\w.-]+$/;

/**
 * The rules that need the worktree. The module a Place names has to stand in the tree: a missing module is an error
 * for a record the lane wrote, or for one whose Place the lane's own changes hit (it deleted or moved it); another
 * lane's record is a note, because the lane cannot fix it and must not be stopped by it. Before the lane enters the
 * implementation round, a missing module of its own Choice is only a note: the planner writes the Choice before the
 * module exists. A file mark, a symbol and a verification anchor that no longer stand are maintenance marks and
 * never fail the check: the file a Choice was written against is a hint at where to inject and which file the
 * planner disposes of, and ordinary work (a rename, a split, a move) breaks it without breaking the Choice. A Place
 * the lane itself moved is read at its new path, with the same rename reading the landing uses, so a lane that moved
 * a file does not have to rewrite its Place by hand. An unconfirmed Choice left on a Place the lane touched is
 * always the lane's.
 */
export function checkTree(input: TreeCheckInput): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const changed = input.changed ?? [];
  const moves = input.moves ?? [];
  const touched = (place: Place): boolean => place.kind !== "root" && changed.some((path) => markHits(path, place));

  for (const c of input.choices) {
    // the lane's own renames are followed first: a Place it moved is looked at where the file went
    const followed = movedPlaces(c.place, moves);
    for (const [i, place] of c.place.entries()) {
      if (place.kind === "root") continue;
      const read = followed ? followed[i] : place;
      const at = canonicalPlace(read);
      const was = canonicalPlace(place);
      const owned = c.mine || touched(place);
      let weight: FindingWeight;
      if (input.lane === null) weight = "error";
      else if (!owned) weight = "note";
      else weight = !input.rounds.enteredImplementation && c.mine ? "note" : "error";
      const exists = moduleInTree(at.path, input.kindOf) || (() => {
        const archived = archivedModulePath(at);
        return archived !== null && input.kindOf(archived) === "dir";
      })();
      if (!exists) {
        findings.push({ weight, rule: "place", id: c.id, reason: `module ${at.path} が tree にありません` });
      } else if (followed && followed[i] !== place) {
        // the follow is the landing's: the lane can see that it will happen, and does not have to write it by hand
        findings.push({ weight: "mark", rule: "place", id: c.id, reason: `${was.path}${was.file ? was.file : ""} は ${at.path} に移りました（着地で追従します）` });
      }
      // the mark: the file this Place was written against. Gone, it is a maintenance mark, not a defect. A file
      // under `_docs/intent/` that moved to the archive is the same document at the same relative path
      if (exists && at.file) {
        const archivedMark = archivedIntentPath(at.file);
        const stands = input.kindOf(at.file) === "file" || (archivedMark !== null && input.kindOf(archivedMark) === "file");
        if (!stands) findings.push({ weight: "mark", rule: "mark", id: c.id, reason: `印の file ${at.file} が tree にありません（module ${at.path} は残っています）` });
      }
    }
  }

  for (const c of input.choices) {
    const followed = movedPlaces(c.place, moves);
    for (const [i, place] of c.place.entries()) {
      const read = canonicalPlace(followed ? followed[i] : place);
      if (!read.file || !read.symbols?.length) continue;
      if (input.kindOf(read.file) !== "file") continue;
      const content = input.readFile(read.file);
      if (content === null) continue;
      for (const symbol of read.symbols) {
        if (!hasSymbol(content, symbol)) findings.push({ weight: "mark", rule: "symbols", id: c.id, reason: `${read.file} に ${symbol} が見つかりません` });
      }
    }
  }

  // a verification anchor: the test that would go red is not in the tree any more, so nothing checks this Choice
  for (const c of input.choices) {
    for (const anchor of c.verification ?? []) {
      if (CRITERION_ID.test(anchor)) continue; // an AC is held by the lane's records, not by the tree
      if (verificationStands(anchor, input)) continue;
      findings.push({ weight: "mark", rule: "verification", id: c.id, reason: `検証物 ${anchor} が tree にありません` });
    }
  }

  if (input.lane !== null) {
    for (const c of input.choices) {
      if (c.status !== "unconfirmed") continue;
      for (const place of c.place) {
        if (place.kind === "root" || !touched(place)) continue;
        findings.push({ weight: input.recordsShape === "state" ? "error" : "note", rule: "touched", id: c.id, reason: `触った Place ${place.path} に unconfirmed の Choice が残っています` });
      }
    }
  }

  return findings;
}

/** whether a verification anchor still stands: a path in the tree, or a bare test name the tree holds somewhere */
function verificationStands(anchor: string, input: TreeCheckInput): boolean {
  const bare = anchor.replace(/^\.\//, "");
  if (!bare) return false;
  if (input.kindOf(bare) === "file") return true;
  const name = bare.split("/").pop() ?? bare;
  return input.hasFileNamed?.(name) === true;
}

/** how a name at the projection place looks, seen with `lstat`: a symlink is never followed */
export type ProjectionEntryKind = "file" | "symlink" | "other";

/** what the caller's worktree answers for the projection place; the function reads no file itself */
export interface ProjectionCheckInput {
  files: ProjectionFile[];
  /** the direct children of the place, by name and kind */
  list: () => { name: string; kind: ProjectionEntryKind }[];
  /** the body of a regular file at the place; never called for a symlink or a directory */
  read: (name: string) => string | null;
  /** set when the place itself cannot be looked at (a symlink on the way): one finding, and nothing is read */
  blocked?: string;
}

/** the one thing every projection finding tells the reader to do */
export const PROJECTION_FIX = "`idd intent draw` で描き直してください";

/**
 * The projection rules: the drawn text the door hands over against the tree at the caller's worktree. Four
 * defects, each an error named by the file: a missing projection, a projection whose text differs, a leftover file
 * that carries the mark, and a name to be drawn whose place holds something that is not a projection (a file
 * without the mark, a symlink or a directory). A file the drawing does not name, and that carries no mark, is not
 * a defect: the place may hold a person's own notes. Nothing here reads or writes a file.
 */
export function checkProjection(input: ProjectionCheckInput): CheckFinding[] {
  if (input.blocked) return [{ weight: "error", rule: "projection", id: "", reason: `${input.blocked}。${PROJECTION_FIX}` }];
  const findings: CheckFinding[] = [];
  const listing = input.list();
  const kindOf = new Map(listing.map((e) => [e.name, e.kind]));
  const expected = new Set(input.files.map((f) => f.name));
  for (const f of input.files) {
    const kind = kindOf.get(f.name);
    if (kind === undefined) {
      findings.push({ weight: "error", rule: "projection", id: f.name, reason: `写しがありません。${PROJECTION_FIX}` });
      continue;
    }
    if (kind !== "file") {
      findings.push({ weight: "error", rule: "projection", id: f.name, reason: `写しの場所に写しでないもの（${kind}）があります。${PROJECTION_FIX}` });
      continue;
    }
    const content = input.read(f.name);
    const first = content === null ? null : (content.split("\n")[0] ?? "");
    if (first !== PROJECTION_MARK) {
      findings.push({ weight: "error", rule: "projection", id: f.name, reason: `写しの場所に写しでないファイルがあります。${PROJECTION_FIX}` });
      continue;
    }
    if (content !== f.content) {
      findings.push({ weight: "error", rule: "projection", id: f.name, reason: `写しが直されています。${PROJECTION_FIX}` });
    }
  }
  for (const e of listing) {
    if (expected.has(e.name) || e.kind !== "file" || !e.name.endsWith(".md")) continue;
    const content = input.read(e.name);
    if (content !== null && (content.split("\n")[0] ?? "") === PROJECTION_MARK) {
      findings.push({ weight: "error", rule: "projection", id: e.name, reason: `描く一覧に無い写しが残っています。${PROJECTION_FIX}` });
    }
  }
  return findings;
}

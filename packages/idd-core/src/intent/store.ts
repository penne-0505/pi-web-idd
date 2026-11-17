import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";
import { projectionConfigOf, readAreas, type ProjectionKind } from "../config/areas.ts";
import { readJsonlCached } from "../ledger/read-cache.ts";
import { readLifecycle } from "../ledger/read.ts";
import { laneHasEnded } from "../ledger/ends.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { moonbitFoldRows, moonbitLaneStates } from "./moonbit-fold.ts";
import { foldProjects, type FoldedProjects } from "./project.ts";
import { projectRecords, type ProjectionFile } from "./projection.ts";
import {
  OVERVIEW_PURPOSE_ID, canonicalPlace, isMigratedChoiceId, isPurposeId, normalizeChoiceBody, normalizeProposalBody, normalizeReanchorBody,
  type ChoiceBody, type ChoiceForms, type ChoiceOrigin, type ChoiceStatus, type HarmLevel, type IntentActor, type Place,
  type PlaceKind, type ProposalBody, type ProposalKind, type PurposeStatus, type RaisedChoiceStatus, type Visibility,
} from "./records.ts";
import type { PlaceMove } from "./rename.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** one row of the repo's append-only column */
export interface IntentRow {
  event: string;
  at: string;
  repo: string;
  by: IntentActor;
  [key: string]: unknown;
}

export interface OpFailure {
  ok: false;
  error: string;
}
export type OpResult<T = Record<string, unknown>> = ({ ok: true } & T) | OpFailure;

/** the column for a repo: its own file, named so two keys can never flatten onto one */
export function intentColumnPath(repo: string): string {
  return join(stateDir(), `intent-${encodeURIComponent(repo)}.jsonl`);
}

/**
 * The repo's column, row by row in the order it was written. The column is appended from more than one process, so
 * the reading is the shared incremental one: the file itself decides whether anything was added, and the rows that
 * were already parsed are handed back untouched. A line that is not a JSON object is dropped, the same as before.
 */
export function readRows(path: string): IntentRow[] {
  return readJsonlCached<unknown>(path).flatMap((parsed) =>
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as IntentRow] : [],
  );
}

/** the lane's outside is null; a lane sees its own records before they are merged */
export function viewerLane(actor: IntentActor | null): string | null {
  return actor && "lane" in actor ? actor.lane : null;
}

/**
 * The lane a record's own raiser names, or null. A row written before `by` existed folds with `by` left out, so
 * the reading never assumes it is there: `"lane" in undefined` would stop the whole read (F-119-11).
 */
export function raisedByLane(by: unknown): string | null {
  return by && typeof by === "object" && "lane" in by && typeof (by as { lane?: unknown }).lane === "string"
    ? (by as { lane: string }).lane
    : null;
}

/** the ID key of an actor: IDD-099 counts as 099, anything else (a session id, another lane form) as it is */
export function actorKey(actor: IntentActor): string {
  if ("session" in actor) return actor.session;
  const lane = /^IDD-(\d+)$/.exec(actor.lane);
  return lane ? lane[1] : actor.lane;
}

/** a Choice key holds letters, digits, `_`, `.` and `-`, and starts with a letter or a digit */
export function isChoiceKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key);
}

export interface LaneState {
  /** the earliest merge into the mainline: rows at or before it are effective for everyone */
  mergedAt?: string;
  /** the earliest end of any kind: a row written after it by that lane is not effective even to the lane */
  endedAt?: string;
  /**
   * the proposed Purposes the lane's GO records named, in the order they were named. The confirmation rides on the
   * GO record itself (one append for one press), so the fold reads it from the lane's records rather than from a
   * second row in the intent column.
   */
  purposes?: { id: string; name?: string }[];
}

function isAfter(at: string, boundary: string): boolean {
  const a = Date.parse(at);
  const b = Date.parse(boundary);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a > b;
  return at > boundary;
}

/**
 * The lane states of the lifecycle rows. The fold itself is the MoonBit one (`packages/idd-fold`): every caller
 * — the engine's screens, the write side's refusals, the CLI — reads the same folding, so a screen cannot show a
 * state the write side disagrees with (P-4). A failing fold is a failure; it never falls back to a second
 * folding written here (C-186-2).
 */
export function laneStates(events: LifecycleRecord[]): Map<string, LaneState> {
  return moonbitLaneStates(events);
}

export interface Raised {
  by: IntentActor;
  at: string;
}

export interface PurposeView {
  id: string;
  statement: string;
  origin: string;
  /** the optional short handle; absent on a row written before names existed */
  name?: string;
  status: PurposeStatus;
  raised: Raised;
  grounds?: string;
  /** the statement the raise wrote, present once a person's restatement replaced `statement` */
  raised_statement?: string;
  /** who restated last and when; present with `raised_statement` */
  restated?: Raised;
}

export interface ChoiceHistoryEntry {
  at: string;
  event: "created" | "re-anchored" | "confirmed" | "superseded" | "dropped";
  by: IntentActor;
  grounds?: string;
  successor?: string;
}

export interface ChoiceWaive {
  reason: string;
  by: IntentActor;
  at: string;
}

export interface ChoiceView {
  id: string;
  purpose: string;
  forms: ChoiceForms;
  place: Place[];
  why: string;
  anchored: string;
  free: string;
  revisit?: string;
  /** the verification anchors (test names or AC ids); absent when the Choice names none */
  verification?: string[];
  visibility: Visibility;
  status: ChoiceStatus;
  origin: ChoiceOrigin;
  history: ChoiceHistoryEntry[];
  waives: ChoiceWaive[];
}

export interface WaiveView {
  kind: "applied" | "no-choice";
  choices?: string[];
  reason?: string;
  change?: string;
  at: string;
  by: IntentActor;
}

/** one approved harm example: the repo's own concrete case of harm, with its weight */
export interface HarmExampleView {
  id: string;
  statement: string;
  harm: HarmLevel;
  /** true when it is a must whatever its frequency */
  alwaysMust: boolean;
  at: string;
  by: IntentActor;
}

export interface FoldedRecords {
  purposes: PurposeView[];
  choices: ChoiceView[];
  waives: WaiveView[];
  harmExamples: HarmExampleView[];
}

// the rename type lives with the one reading of git's diff; the fold only carries it onto the Places
export type { PlaceMove } from "./rename.ts";

/** the Place a move carries, or null when the move does not touch it */
function movedPlace(place: Place, move: PlaceMove): Place | null {
  const dirMove = move.from.endsWith("/");
  if (place.kind === "root") return null;
  // a Place with a file mark follows the file, and its module follows the file's new parent
  if (place.file) {
    const file = place.file;
    const next = file === move.from
      ? move.to
      : dirMove && file.startsWith(move.from) ? move.to.replace(/\/$/, "/") + file.slice(move.from.length) : null;
    if (next === null) return null;
    return { ...place, path: canonicalPlace({ path: next, kind: "file" }).path, file: next };
  }
  // a module with no file mark is a dir's own Choice: only a dir that moved carries it
  if (!dirMove) return null;
  const to = move.to.endsWith("/") ? move.to : `${move.to}/`;
  if (place.path === move.from) return { ...place, path: to };
  if (place.path.startsWith(move.from)) return { ...place, path: `${to}${place.path.slice(move.from.length)}` };
  return null;
}

/** the Place list with every move that touches it applied; null when no move touches it */
export function movedPlaces(places: Place[], moves: PlaceMove[]): Place[] | null {
  let changed = false;
  const next = places.map((place) => {
    let current = place;
    for (const move of moves) {
      const moved = movedPlace(current, move);
      if (moved) {
        current = moved;
        changed = true;
      }
    }
    return current;
  });
  return changed ? next : null;
}

/**
 * The records one viewer sees, folded in the column's order into today's state. The fold is the MoonBit one, for
 * the same reason `laneStates` is: one folding answers the screen and the write side alike (P-4), and a broken
 * one is seen rather than hidden by a second folding in TypeScript (C-186-2).
 */
export function foldRows(rows: IntentRow[], viewer: string | null, states: Map<string, LaneState>): FoldedRecords {
  return moonbitFoldRows(rows, viewer, states);
}

/**
 * The rows one viewer sees: a session row at once, a lane's own rows to that lane until it ends, and a lane's rows to
 * everyone else from the moment it merges. This is the visibility the MoonBit fold applies to Purposes and Choices,
 * stated once more for the rows that fold does not read (the Projects), so a Project row reaches a reader on the
 * same terms a Choice row does (DEC-099-2).
 */
export function effectiveRows(rows: IntentRow[], viewer: string | null, states: Map<string, LaneState>): IntentRow[] {
  return rows.filter((row) => {
    const byLane = raisedByLane(row.by);
    if (!byLane) return true;
    const state = states.get(byLane);
    if (viewer && viewer === byLane) return !(state?.endedAt && isAfter(row.at, state.endedAt));
    return Boolean(state?.mergedAt && !isAfter(row.at, state.mergedAt));
  });
}

/**
 * The rows of everyone at once: the landed rows and the rows of the lanes still running. A lane that ended without
 * landing never takes effect, so its rows are left out. This is for a reader that must not put its value over a change
 * a lane has made and not yet landed (the sync); it is no viewer's own view.
 */
export function pendingRows(rows: IntentRow[], states: Map<string, LaneState>): IntentRow[] {
  return rows.filter((row) => {
    const byLane = raisedByLane(row.by);
    if (!byLane) return true;
    const state = states.get(byLane);
    if (state?.mergedAt) return !isAfter(row.at, state.mergedAt);
    return !state?.endedAt;
  });
}

/** the Projects with the running lanes' changes in them, folded from the same column and the same lane states */
export function foldPendingProjectRows(rows: IntentRow[], states: Map<string, LaneState>): FoldedProjects {
  return foldProjects(pendingRows(rows, states));
}

/** the Projects one viewer sees, folded from the same column and the same lane states as the records */
export function foldProjectRows(rows: IntentRow[], viewer: string | null, states: Map<string, LaneState>): FoldedProjects {
  return foldProjects(effectiveRows(rows, viewer, states));
}

function foldFor(repo: string, actor: IntentActor | null): { rows: IntentRow[]; folded: FoldedRecords } {
  const rows = readRows(intentColumnPath(repo));
  const folded = foldRows(rows, viewerLane(actor), laneStates(readLifecycle()));
  return { rows, folded };
}

/**
 * the next `P-<n>`: counted over the whole column, effective rows or not, and never `P-1`. The overview is the whole
 * repo's premise and one GO confirms a lane's proposals together, so a number the column hands out by itself must not
 * be able to put a lane's Purpose in that seat: only a raise that names `P-1` reaches it.
 */
function nextPurposeId(rows: IntentRow[]): string {
  let max = 1;
  for (const row of rows) {
    const id = text(row.id);
    const m = id ? /^P-(\d+)$/.exec(id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P-${max + 1}`;
}

/** the next `C-<key>-<n>`: counted over the whole column, so an id never overlaps one that is not effective yet */
function nextChoiceId(rows: IntentRow[], key: string): string {
  let max = 0;
  const prefix = `C-${key}-`;
  for (const row of rows) {
    const id = text(row.id);
    if (!id || !id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${max + 1}`;
}

/**
 * Why a person's raise that names the overview's id cannot take the seat, or null when it may. The seat is taken while a
 * `P-1` is in effect (active or proposed, read from the raiser's own side so a running lane's proposal counts), and it
 * is not rewritable while any Choice row points at `P-1`: the fold replaces a Purpose by id and a Choice names its
 * Purpose by id, so a new statement would move that Choice onto it unseen. Both refusals start with the same words, which
 * the registration reads as "already there".
 */
function overviewSeatRefusal(rows: IntentRow[], states: Map<string, LaneState>): string | null {
  const taken = `ID ${OVERVIEW_PURPOSE_ID} は既にあります`;
  const isSeat = (id: unknown) => text(id) === OVERVIEW_PURPOSE_ID;
  // only a running lane's own side adds a reader: an ended or merged lane is already in the outside's view, or never will be
  const readers = new Set<string | null>([null]);
  for (const r of rows) {
    const lane = r.event === "purpose_raised" && isSeat(r.id) ? raisedByLane(r.by) : null;
    if (lane && !states.get(lane)?.endedAt && !states.get(lane)?.mergedAt) readers.add(lane);
  }
  const inEffect = [...readers].some((viewer) => foldRows(rows, viewer, states).purposes.some((p) => isSeat(p.id) && (p.status === "active" || p.status === "proposed")));
  if (inEffect) return taken;
  const pointed = rows.some((r) => r.event === "choice_raised" && isSeat(r.purpose));
  return pointed ? `${taken}（効いていませんが、Choice が ${OVERVIEW_PURPOSE_ID} を purpose に持つので、書き直すとその結び付きが新しい文に移ります）` : null;
}

export function purposeRefusal(folded: FoldedRecords, purposeId: string): string | null {
  const p = folded.purposes.find((x) => x.id === purposeId);
  if (!p) return `Purpose ${purposeId} はありません`;
  if (p.status !== "active") return `Purpose ${purposeId} は active ではありません（${p.status}）`;
  return null;
}

/** the fields of a Choice raise, with the actor's rules on id and status applied */
export function prepareChoice(
  rows: IntentRow[],
  actor: IntentActor,
  body: ChoiceBody,
  visibilityDefault: Visibility,
): { ok: true; id: string; status: RaisedChoiceStatus; fields: Record<string, unknown> } | OpFailure {
  if ("lane" in actor) {
    if (body.id) return { ok: false, error: "lane の呼び出しでは Choice の ID を指定できません" };
    if (body.status) return { ok: false, error: "lane の呼び出しでは Choice の status を指定できません" };
    if (body.migration) return { ok: false, error: "lane の呼び出しでは Choice の移行の出どころを指定できません" };
  }
  let id: string;
  if (body.id) {
    if (!isMigratedChoiceId(body.id)) return { ok: false, error: `Choice の ID は DEC- か INV- で始まる移行の形にしてください: ${body.id}` };
    if (rows.some((r) => text(r.id) === body.id)) return { ok: false, error: `ID ${body.id} は既にあります` };
    id = body.id;
  } else {
    const key = actorKey(actor);
    if (!isChoiceKey(key)) return { ok: false, error: `Choice の ID に使えない鍵です: ${key}` };
    id = nextChoiceId(rows, key);
  }
  const status: RaisedChoiceStatus = body.status ?? "active";
  const origin: ChoiceOrigin = {
    ...(body.question ? { by: "human" as const, question: body.question } : { by: "agent" as const }),
    ...(body.migration ? { migrated: body.migration } : {}),
  };
  return {
    ok: true,
    id,
    status,
    fields: {
      id,
      purpose: body.purpose,
      forms: body.forms,
      place: body.place,
      why: body.why,
      anchored: body.anchored,
      // the body may carry no visibility: the repo's default fills it here, so every column row always has one
      visibility: body.visibility ?? visibilityDefault,
      status,
      origin,
      ...(body.free ? { free: body.free } : {}),
      ...(body.revisit ? { revisit: body.revisit } : {}),
      ...(body.no_why_not ? { no_why_not: body.no_why_not } : {}),
      ...(body.verification ? { verification: body.verification } : {}),
    },
  };
}

export function baseRow(repo: string, actor: IntentActor, event: string): IntentRow {
  return { event, at: nowIso(), repo, by: actor };
}

export interface WriteContext {
  rows: IntentRow[];
  events: LifecycleRecord[];
  states: Map<string, LaneState>;
}

/**
 * Every write runs here: the file's lock is taken, the column and the lifecycle are read again inside it, the
 * caller decides, and only an accepted operation appends. Numbering, the checks and the append are one critical
 * section, so two raises cannot take the same id.
 */
export async function runWrite<T extends Record<string, unknown>>(
  repo: string,
  actor: IntentActor,
  decide: (ctx: WriteContext) => { result: OpResult<T>; append?: IntentRow | IntentRow[] },
): Promise<OpResult<T>> {
  const path = intentColumnPath(repo);
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // proper-lockfile resolves the column's real path, so the column has to exist before its lock can be taken.
  // Create it through an append, never a truncating write: another process may have won the race and appended
  // its own rows between our existence check and our create, and an opening that truncates would erase them.
  appendFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 200, minTimeout: 5, maxTimeout: 100, factor: 1 } });
  try {
    const ctx: WriteContext = { rows: readRows(path), events: readLifecycle(), states: new Map() };
    ctx.states = laneStates(ctx.events);
    const { result, append } = decide(ctx);
    if (result.ok && append) {
      const rows = Array.isArray(append) ? append : [append];
      if (rows.length) appendFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
    }
    return result;
  } finally {
    await release();
  }
}

export function endRefusal(actor: IntentActor, events: LifecycleRecord[]): string | null {
  if ("lane" in actor && laneHasEnded(actor.lane, events)) {
    return `${actor.lane} は終わっているので、意図の記録を書きません`;
  }
  return null;
}

/**
 * Append a row the engine writes for the lane's own action (the landing's follow, the conversion of the older
 * Places), built from the column as it stands inside the lock. This is not a door: no action of the intent API
 * reaches it, and the caller names the row it writes. It answers whether a row was written.
 */
export async function appendLaneRows(input: {
  repo: string;
  actor: IntentActor;
  build: (folded: FoldedRecords, rows: IntentRow[]) => ({ event: string; [key: string]: unknown } | null);
}): Promise<OpResult<{ written: boolean }>> {
  return runWrite<{ written: boolean }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const folded = foldRows(rows, viewerLane(input.actor), states);
    const built = input.build(folded, rows);
    if (!built) return { result: { ok: true, written: false } };
    const { event, ...fields } = built;
    return { result: { ok: true, written: true }, append: { ...baseRow(input.repo, input.actor, event), ...fields } };
  });
}

/** the row that marks the conversion of the Places written before the module became the canonical form */
const PLACES_MODULE_EVENT = "places_module";
/** the row that carries a landing's renames onto every Place the lane landed on the old path */
const PLACES_MOVED_EVENT = "places_moved";

/**
 * Write the lane's conversion of the Places to modules, once: the fold already reads every Place as its module, so
 * the row changes no reading and no Choice's history. It stands in the column so the conversion is a row of the lane
 * that made it, and its landing carries it into every lane's view.
 */
export async function recordPlacesModule(repo: string, lane: string): Promise<OpResult<{ written: boolean }>> {
  return appendLaneRows({
    repo,
    actor: { lane },
    build: (_folded, rows) => (rows.some((r) => r.event === PLACES_MODULE_EVENT && raisedByLane(r.by) === lane) ? null : { event: PLACES_MODULE_EVENT }),
  });
}

/**
 * Write the lane's renames onto the column as one row: from here on every Place that still stands on an old path
 * names the new one. The row is a move, not a written Place list, so a Re-anchor another lane wrote earlier keeps
 * its own move (the column folds in the order it was written). Nothing is written when no Place stands on a moved
 * path, and a row repeating exactly the moves already recorded by this lane is not written again.
 */
export async function recordPlaceMoves(repo: string, lane: string, moves: PlaceMove[]): Promise<OpResult<{ written: boolean; moved: string[] }>> {
  const wanted = moves.filter((m) => m.from && m.to && m.from !== m.to);
  if (!wanted.length) return { ok: true, written: false, moved: [] };
  let moved: string[] = [];
  const result = await appendLaneRows({
    repo,
    actor: { lane },
    build: (folded, rows) => {
      moved = folded.choices
        .filter((c) => (c.status === "active" || c.status === "unconfirmed") && movedPlaces(c.place, wanted))
        .map((c) => c.id);
      if (!moved.length) return null;
      const already = rows.some((r) => r.event === PLACES_MOVED_EVENT && raisedByLane(r.by) === lane && JSON.stringify(r.moves ?? []) === JSON.stringify(wanted));
      return already ? null : { event: PLACES_MOVED_EVENT, moves: wanted };
    },
  });
  return result.ok ? { ...result, moved } : result;
}

export async function raisePurpose(input: {
  repo: string;
  actor: IntentActor;
  statement?: unknown;
  origin?: unknown;
  id?: unknown;
  name?: unknown;
}): Promise<OpResult<{ id: string; status: PurposeStatus }>> {
  return runWrite<{ id: string; status: PurposeStatus }>(input.repo, input.actor, (ctx) => {
    const { rows, events } = ctx;
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const statement = text(input.statement);
    if (!statement) return { result: { ok: false, error: "必須の欄 statement が空です" } };
    const origin = text(input.origin);
    if (!origin) return { result: { ok: false, error: "必須の欄 origin が空です" } };
    const name = text(input.name);
    const named = name ? { name } : {};
    const explicit = text(input.id);
    if ("lane" in input.actor) {
      if (explicit) return { result: { ok: false, error: "lane の呼び出しでは Purpose の ID を指定できません" } };
      const id = nextPurposeId(rows);
      return {
        result: { ok: true, id, status: "proposed" as PurposeStatus },
        append: { ...baseRow(input.repo, input.actor, "purpose_raised"), id, statement, origin, ...named, status: "proposed" },
      };
    }
    let id: string;
    if (explicit) {
      if (!isPurposeId(explicit)) return { result: { ok: false, error: `Purpose の ID は P-<数字> の形にしてください: ${explicit}` } };
      if (explicit === OVERVIEW_PURPOSE_ID) {
        // the overview's seat is the one id that may be raised again: a withdrawn or retired P-1 no Choice points at
        const taken = overviewSeatRefusal(rows, ctx.states);
        if (taken) return { result: { ok: false, error: taken } };
      } else if (rows.some((r) => text(r.id) === explicit)) return { result: { ok: false, error: `ID ${explicit} は既にあります` } };
      id = explicit;
    } else id = nextPurposeId(rows);
    return {
      result: { ok: true, id, status: "active" as PurposeStatus },
      append: { ...baseRow(input.repo, input.actor, "purpose_raised"), id, statement, origin, ...named, status: "active" },
    };
  });
}

export async function confirmPurpose(input: {
  repo: string;
  actor: IntentActor;
  id?: unknown;
  name?: unknown;
}): Promise<OpResult<{ id: string; status: "active" }>> {
  return runWrite<{ id: string; status: "active" }>(input.repo, input.actor, ({ rows, events, states }) => {
    if ("lane" in input.actor) return { result: { ok: false, error: "Purpose を確かめられるのは lane の外だけです" } };
    const id = text(input.id);
    if (!id) return { result: { ok: false, error: "id が空です" } };
    // the raise may be a lane's, and a lane's records are not visible outside until it merges: look the raising
    // row up in the whole column, then fold from the raiser's own side to see whether it is still a proposal
    const raised = rows.find((r) => r.event === "purpose_raised" && text(r.id) === id);
    if (!raised) return { result: { ok: false, error: `Purpose ${id} はありません` } };
    const raiserViewer = raised.by && "lane" in raised.by ? raised.by.lane : null;
    const p = foldRows(rows, raiserViewer, states).purposes.find((x) => x.id === id);
    if (!p || p.status !== "proposed") return { result: { ok: false, error: `Purpose ${id} は案ではありません（確かめ済みか、無効です）` } };
    const name = text(input.name);
    return {
      result: { ok: true, id, status: "active" },
      append: { ...baseRow(input.repo, input.actor, "purpose_confirmed"), id, ...(name ? { name } : {}) },
    };
  });
}

export async function retirePurpose(input: {
  repo: string;
  actor: IntentActor;
  id?: unknown;
  grounds?: unknown;
}): Promise<OpResult<{ id: string; status: "retired" }>> {
  return runWrite<{ id: string; status: "retired" }>(input.repo, input.actor, ({ rows, events, states }) => {
    if ("lane" in input.actor) return { result: { ok: false, error: "Purpose を retire できるのは lane の外だけです" } };
    const id = text(input.id);
    if (!id) return { result: { ok: false, error: "id が空です" } };
    const grounds = text(input.grounds);
    if (!grounds) return { result: { ok: false, error: "必須の欄 grounds が空です" } };
    const folded = foldRows(rows, viewerLane(input.actor), states);
    const p = folded.purposes.find((x) => x.id === id);
    if (!p || p.status !== "active") return { result: { ok: false, error: `Purpose ${id} は active ではありません` } };
    return {
      result: { ok: true, id, status: "retired" },
      append: { ...baseRow(input.repo, input.actor, "purpose_retired"), id, grounds },
    };
  });
}

/**
 * The lane's own proposal a person's judgement may touch, read from the lane's side inside the lock. An active
 * Purpose, the overview and a proposal another lane raised are not reached here: the first ends by a retire, the
 * others are not this lane's card to judge.
 */
function laneProposalRefusal(
  rows: IntentRow[],
  events: LifecycleRecord[],
  states: Map<string, LaneState>,
  lane: string,
  id: string,
): { purpose: PurposeView } | { error: string } {
  if (laneHasEnded(lane, events)) return { error: `${lane} は終わっているので、この案は直せません` };
  const p = foldRows(rows, lane, states).purposes.find((x) => x.id === id);
  if (!p) return { error: `Purpose ${id} はありません` };
  if (p.status !== "proposed") return { error: `Purpose ${id} は案ではありません（${p.status}）` };
  if (raisedByLane(p.raised.by) !== lane) return { error: `Purpose ${id} は ${lane} が立てた案ではありません` };
  return { purpose: p };
}

/**
 * A person's judgement on a lane's Purpose proposal before the GO: only a caller outside the lane writes it, the one
 * field it must carry is required, and the proposal is read from the lane's side. What differs between the judgements
 * is passed in: the refusal for a lane's own call, the field, the row's event, a refusal of its own, and the result.
 */
function judgeLaneProposal<T extends Record<string, unknown>>(
  input: { repo: string; lane: string; by: IntentActor; id?: unknown },
  judge: {
    outsider: string;
    field: "statement" | "grounds";
    value: unknown;
    event: string;
    refuse?: (p: PurposeView, value: string, id: string) => string | null;
    result: (id: string, value: string) => T;
  },
): Promise<OpResult<T>> {
  return runWrite<T>(input.repo, input.by, ({ rows, events, states }) => {
    if (!("session" in input.by)) return { result: { ok: false, error: judge.outsider } };
    const id = text(input.id);
    if (!id) return { result: { ok: false, error: "id が空です" } };
    const value = text(judge.value);
    if (!value) return { result: { ok: false, error: `必須の欄 ${judge.field} が空です` } };
    const found = laneProposalRefusal(rows, events, states, input.lane, id);
    if ("error" in found) return { result: { ok: false, error: found.error } };
    const refusal = judge.refuse?.(found.purpose, value, id);
    if (refusal) return { result: { ok: false, error: refusal } };
    return {
      result: { ok: true, ...judge.result(id, value) },
      append: { ...baseRow(input.repo, input.by, judge.event), id, [judge.field]: value },
    };
  });
}

/**
 * A person rewrites the sentence of a lane's Purpose proposal before the GO. The planner's raise row stays; this adds
 * a `purpose_restated` row by the person, so the fold reads the new sentence and keeps the first one beside it. The
 * status stays a proposal, and nothing here moves the lane's stage.
 */
export async function restatePurposeProposal(input: {
  repo: string;
  lane: string;
  by: IntentActor;
  id?: unknown;
  statement?: unknown;
}): Promise<OpResult<{ id: string; status: "proposed"; statement: string }>> {
  return judgeLaneProposal(input, {
    outsider: "案の文を直せるのは lane の外だけです",
    field: "statement",
    value: input.statement,
    event: "purpose_restated",
    refuse: (p, statement, id) => (p.statement === statement ? `Purpose ${id} の文は今と同じです` : null),
    result: (id, statement) => ({ id, status: "proposed" as const, statement }),
  });
}

/**
 * A person takes a lane's Purpose proposal back before the GO. The raise row stays and a `purpose_withdrawn` row with
 * the grounds follows: the proposal is neither a proposal nor active from then on, and no GO confirms it. This is not
 * a retire: a proposal that never took effect did not end.
 */
export async function withdrawPurposeProposal(input: {
  repo: string;
  lane: string;
  by: IntentActor;
  id?: unknown;
  grounds?: unknown;
}): Promise<OpResult<{ id: string; status: "withdrawn" }>> {
  return judgeLaneProposal(input, {
    outsider: "案を取り下げられるのは lane の外だけです",
    field: "grounds",
    value: input.grounds,
    event: "purpose_withdrawn",
    result: (id) => ({ id, status: "withdrawn" as const }),
  });
}

export async function raiseChoice(input: {
  repo: string;
  actor: IntentActor;
  body?: unknown;
}): Promise<OpResult<{ id: string; status: RaisedChoiceStatus }>> {
  return runWrite<{ id: string; status: RaisedChoiceStatus }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const body = normalizeChoiceBody(input.body);
    if (!body.ok) return { result: { ok: false, error: body.error } };
    const folded = foldRows(rows, viewerLane(input.actor), states);
    const refusal = purposeRefusal(folded, body.value.purpose);
    if (refusal) return { result: { ok: false, error: refusal } };
    const prep = prepareChoice(rows, input.actor, body.value, projectionConfigOf(input.repo).visibility_default);
    if (!prep.ok) return { result: prep };
    return {
      result: { ok: true, id: prep.id, status: prep.status },
      append: { ...baseRow(input.repo, input.actor, "choice_raised"), ...prep.fields },
    };
  });
}

/**
 * The Choices a successor chain walks through, the successor first. A replacement leaves the reader only the
 * successor once it lands, so the walk goes to the chain's end: the Choice closed two replacements later is the
 * one a one-step look would miss. A replaced Choice may have more than one successor standing at once (two lanes
 * closed the same Choice), and only one of them shows as the successor of the state; the walk follows every edge,
 * because a chain that closes through the edge the state does not show still leaves the reader nowhere.
 */
function successorChain(nextOf: Map<string, string[]>, from: string): string[] {
  const walked: string[] = [];
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length) {
    const cursor = pending.pop() as string;
    if (seen.has(cursor)) continue;
    seen.add(cursor);
    walked.push(cursor);
    pending.push(...(nextOf.get(cursor) ?? []));
  }
  return walked;
}

/** what a replacement refuses about the Choices it closes: both forms accept the same side */
function replacedRefusal(actor: IntentActor, folded: FoldedRecords, ids: string[]): string | null {
  for (const oldId of ids) {
    const old = folded.choices.find((c) => c.id === oldId);
    if (!old || (old.status !== "active" && old.status !== "unconfirmed")) {
      return `Choice ${oldId} は有効ではありません`;
    }
    if ("lane" in actor && old.place.some((p) => p.kind === "root")) {
      return `root の Choice ${oldId} は lane からは置き換えられません`;
    }
  }
  return null;
}

export async function supersede(input: {
  repo: string;
  actor: IntentActor;
  ids?: unknown;
  grounds?: unknown;
  body?: unknown;
  /** the id of a Choice already raised: the successor is that Choice, and no new one is written */
  by?: unknown;
}): Promise<OpResult<{ id: string; status: RaisedChoiceStatus }>> {
  return runWrite<{ id: string; status: RaisedChoiceStatus }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const grounds = text(input.grounds);
    if (!grounds) return { result: { ok: false, error: "必須の欄 grounds が空です" } };
    const ids = Array.isArray(input.ids) ? input.ids.map((v) => text(v)).filter((v): v is string => Boolean(v)) : [];
    if (!ids.length) return { result: { ok: false, error: "置き換える Choice の ID を 1 つ以上渡してください" } };
    // a --by that cannot name a Choice is not the same request as no --by at all: reading it as absent would fall
    // through to the --file form and raise a new Choice for someone who meant to point at one already standing
    const byGiven = input.by !== undefined && input.by !== null;
    const successorId = byGiven ? text(input.by) : null;
    if (byGiven && !successorId) {
      return { result: { ok: false, error: "後継の Choice の ID を --by で渡してください" } };
    }
    if (successorId !== null) {
      if (input.body !== undefined && input.body !== null) {
        return { result: { ok: false, error: "後継は新しい Choice の本文（--file）か、既にある Choice の ID（--by）のどちらか 1 つにしてください" } };
      }
      const folded = foldRows(rows, viewerLane(input.actor), states);
      const successor = folded.choices.find((c) => c.id === successorId);
      if (!successor) return { result: { ok: false, error: `後継 ${successorId} の Choice がありません` } };
      if (successor.status !== "active") {
        return { result: { ok: false, error: `後継 ${successorId} は active ではありません（${successor.status}）` } };
      }
      const refusal = replacedRefusal(input.actor, folded, ids);
      if (refusal) return { result: { ok: false, error: refusal } };
      // the successor is what the reader will have left, so it must lead somewhere still in effect: a chain back to
      // one of the Choices this row closes would leave the reader without a standing contract. Two lanes may each
      // replace the other's Choice and only find out once both rows have landed, so the walk reads every row that
      // can still land, not just the ones this writer's own window shows.
      const looped = successorChain(replacementSuccessors(rows, states), successorId).find((id) => ids.includes(id));
      if (looped) return { result: { ok: false, error: `後継 ${successorId} の鎖が置き換える Choice ${looped} に戻ります` } };
      return {
        result: { ok: true, id: successorId, status: "active" },
        append: {
          ...baseRow(input.repo, input.actor, "choice_superseded"),
          id: successorId,
          supersedes: ids.map((id) => ({ id, grounds })),
        },
      };
    }
    const body = normalizeChoiceBody(input.body);
    if (!body.ok) return { result: { ok: false, error: body.error } };
    const folded = foldRows(rows, viewerLane(input.actor), states);
    const refusal = purposeRefusal(folded, body.value.purpose);
    if (refusal) return { result: { ok: false, error: refusal } };
    const replaced = replacedRefusal(input.actor, folded, ids);
    if (replaced) return { result: { ok: false, error: replaced } };
    const prep = prepareChoice(rows, input.actor, body.value, projectionConfigOf(input.repo).visibility_default);
    if (!prep.ok) return { result: prep };
    return {
      result: { ok: true, id: prep.id, status: prep.status },
      append: {
        ...baseRow(input.repo, input.actor, "choice_raised"),
        ...prep.fields,
        supersedes: ids.map((id) => ({ id, grounds })),
      },
    };
  });
}

export async function reanchor(input: {
  repo: string;
  actor: IntentActor;
  id?: unknown;
  place?: unknown;
  anchored?: unknown;
}): Promise<OpResult<{ id: string }>> {
  return runWrite<{ id: string }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const id = text(input.id);
    if (!id) return { result: { ok: false, error: "id が空です" } };
    const body = normalizeReanchorBody({ place: input.place, anchored: input.anchored });
    if (!body.ok) return { result: { ok: false, error: body.error } };
    const folded = foldRows(rows, viewerLane(input.actor), states);
    const c = folded.choices.find((x) => x.id === id);
    if (!c || (c.status !== "active" && c.status !== "unconfirmed")) {
      return { result: { ok: false, error: `Choice ${id} は active でも unconfirmed でもありません（${c?.status ?? "なし"}）` } };
    }
    // an unconfirmed Choice is moved, not judged: the re-anchor keeps its body, so it takes the Place alone and
    // leaves the status unconfirmed (C-145-1)
    if (c.status === "unconfirmed" && body.value.anchored) {
      return { result: { ok: false, error: `Choice ${id} は unconfirmed なので、Re-anchor は place だけにしてください（anchored の変更は確認か Supersede で行います）` } };
    }
    if ("lane" in input.actor) {
      const hasRoot = c.place.some((p) => p.kind === "root") || Boolean(body.value.place?.some((p) => p.kind === "root"));
      if (hasRoot) return { result: { ok: false, error: `root の Choice ${id} は lane からは Re-anchor できません` } };
    }
    return {
      result: { ok: true, id },
      append: {
        ...baseRow(input.repo, input.actor, "choice_reanchored"),
        id,
        ...(body.value.place ? { place: body.value.place } : {}),
        ...(body.value.anchored ? { anchored: body.value.anchored } : {}),
      },
    };
  });
}

export async function confirmChoice(input: {
  repo: string;
  actor: IntentActor;
  id?: unknown;
}): Promise<OpResult<{ id: string }>> {
  return runWrite<{ id: string }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const id = text(input.id);
    if (!id) return { result: { ok: false, error: "id が空です" } };
    const folded = foldRows(rows, viewerLane(input.actor), states);
    const c = folded.choices.find((x) => x.id === id);
    if (!c || c.status !== "unconfirmed") return { result: { ok: false, error: `Choice ${id} は unconfirmed ではありません` } };
    return { result: { ok: true, id }, append: { ...baseRow(input.repo, input.actor, "choice_confirmed"), id } };
  });
}

export async function dropChoice(input: {
  repo: string;
  actor: IntentActor;
  id?: unknown;
  grounds?: unknown;
}): Promise<OpResult<{ id: string }>> {
  return runWrite<{ id: string }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const id = text(input.id);
    if (!id) return { result: { ok: false, error: "id が空です" } };
    const grounds = text(input.grounds);
    if (!grounds) return { result: { ok: false, error: "必須の欄 grounds が空です" } };
    const folded = foldRows(rows, viewerLane(input.actor), states);
    const c = folded.choices.find((x) => x.id === id);
    if (!c || c.status !== "unconfirmed") return { result: { ok: false, error: `Choice ${id} は unconfirmed ではありません` } };
    return { result: { ok: true, id }, append: { ...baseRow(input.repo, input.actor, "choice_dropped"), id, grounds } };
  });
}

export async function waive(input: {
  repo: string;
  actor: IntentActor;
  kind?: unknown;
  choices?: unknown;
  reason?: unknown;
  change?: unknown;
}): Promise<OpResult<{ kind: string }>> {
  return runWrite<{ kind: string }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const kind = input.kind === "applied" ? "applied" : input.kind === "no-choice" ? "no-choice" : null;
    if (!kind) return { result: { ok: false, error: "kind は applied か no-choice にしてください" } };
    const change = text(input.change);
    if (kind === "applied") {
      const ids = Array.isArray(input.choices) ? input.choices.map((v) => text(v)).filter((v): v is string => Boolean(v)) : [];
      if (!ids.length) return { result: { ok: false, error: "applied の Waive には Choice の ID を 1 つ以上渡してください" } };
      const folded = foldRows(rows, viewerLane(input.actor), states);
      for (const id of ids) {
        const c = folded.choices.find((x) => x.id === id);
        if (!c || (c.status !== "active" && c.status !== "unconfirmed")) {
          return { result: { ok: false, error: `Choice ${id} は有効ではありません` } };
        }
      }
      return {
        result: { ok: true, kind },
        append: { ...baseRow(input.repo, input.actor, "waive"), kind, choices: ids, ...(change ? { change } : {}) },
      };
    }
    const reason = text(input.reason);
    if (!reason) return { result: { ok: false, error: "no-choice の Waive には reason を渡してください" } };
    return {
      result: { ok: true, kind },
      append: { ...baseRow(input.repo, input.actor, "waive"), kind, reason, ...(change ? { change } : {}) },
    };
  });
}

export interface PlanWriteDraft {
  purpose: string;
  forms: ChoiceForms;
  place: Place[];
  why: string;
  anchored: string;
  free?: string;
  revisit?: string;
  no_why_not?: string;
  question?: string;
  /** the verification anchors the draft carries into the raise */
  verification?: string[];
  supersedes?: { ids: string[]; grounds: string };
}

export type PlanWriteEffect = "confirm" | "drop" | "supersede" | "keep" | "within_freedom" | "reanchor";

export interface PlanWriteExisting {
  id: string;
  effect: PlanWriteEffect;
  reason?: string;
  grounds?: string;
  place?: Place[];
  anchored?: string;
}

export type PlanWriteResult = {
  /** the operations a row was written for now (or was already written for) */
  written: string[];
  /**
   * the operations that could not be written, with the reason and the operation's own body: the draft a `choice:`
   * op would have raised, or the disposal an `existing:` op would have made. The lane is not stopped for them; the
   * body is kept so the executor can raise it itself (DEC-119-4).
   */
  skipped: { op: string; reason: string; draft?: PlanWriteDraft; existing?: PlanWriteExisting }[];
  /** every row-producing operation was written or its reason recorded */
  done: boolean;
};

/**
 * Write a v2 lane's plan records after its GO, inside the column's one lock: the disposals first (confirm / drop /
 * reanchor), then the drafts (a raise, with the Supersede row when the draft replaces a Choice). Every operation is
 * checked before any row is written, and each row carries `plan_ready_at` and `plan_op`, so a later call writes only
 * the operations that have no row yet and never writes one twice. An operation the state no longer allows is skipped
 * with its reason: the lane goes on, and the executor is handed what could not be written.
 */
export async function writePlanRecords(input: {
  repo: string;
  lane: string;
  readyAt: string;
  choices: PlanWriteDraft[];
  existing: PlanWriteExisting[];
}): Promise<OpResult<PlanWriteResult>> {
  const actor: IntentActor = { lane: input.lane };
  const laneOf = (row: IntentRow): string | null => (row.by && "lane" in row.by && typeof row.by.lane === "string" ? row.by.lane : null);
  const ops: string[] = [
    ...input.existing.filter((e) => e.effect === "confirm" || e.effect === "drop" || e.effect === "reanchor").map((e) => `existing:${e.id}`),
    ...input.choices.map((_, i) => `choice:${i}`),
  ];
  return runWrite<PlanWriteResult>(input.repo, actor, ({ rows, events, states }) => {
    // the operation's own body, kept with a skip so the executor can make the disposal or raise the draft itself
    const bodyOf = (op: string): { draft?: PlanWriteDraft; existing?: PlanWriteExisting } => {
      if (op.startsWith("existing:")) {
        const e = input.existing.find((x) => x.id === op.slice("existing:".length));
        return e ? { existing: e } : {};
      }
      const d = input.choices[Number(op.slice("choice:".length))];
      return d ? { draft: d } : {};
    };
    const ended = endRefusal(actor, events);
    if (ended) return { result: { ok: true, written: [], skipped: ops.map((op) => ({ op, reason: ended, ...bodyOf(op) })), done: true } };
    const folded = foldRows(rows, input.lane, states);
    const doneBefore = new Set(
      rows.filter((r) => laneOf(r) === input.lane && r.plan_ready_at === input.readyAt && typeof r.plan_op === "string")
        .map((r) => String(r.plan_op)),
    );
    const written: string[] = [];
    const skipped: { op: string; reason: string; draft?: PlanWriteDraft; existing?: PlanWriteExisting }[] = [];
    const append: IntentRow[] = [];
    // the numbering sees the rows assigned in this same call, so two drafts cannot take the same id
    const numbering = [...rows];
    const stamp = (row: IntentRow, op: string): IntentRow => ({ ...row, plan_ready_at: input.readyAt, plan_op: op });
    const decideOne = (op: string): { ok: true; row: IntentRow } | { ok: false; reason: string } => {
      if (op.startsWith("existing:")) {
        const id = op.slice("existing:".length);
        const e = input.existing.find((x) => x.id === id);
        if (!e) return { ok: false, reason: `${id} の処置がありません` };
        const c = folded.choices.find((x) => x.id === id);
        if (e.effect === "confirm") {
          if (!c || c.status !== "unconfirmed") return { ok: false, reason: `Choice ${id} は unconfirmed ではありません（${c?.status ?? "なし"}）` };
          return { ok: true, row: stamp({ ...baseRow(input.repo, actor, "choice_confirmed"), id }, op) };
        }
        if (e.effect === "drop") {
          if (!c || c.status !== "unconfirmed") return { ok: false, reason: `Choice ${id} は unconfirmed ではありません（${c?.status ?? "なし"}）` };
          if (!e.grounds) return { ok: false, reason: `Choice ${id} の drop に grounds がありません` };
          return { ok: true, row: stamp({ ...baseRow(input.repo, actor, "choice_dropped"), id, grounds: e.grounds }, op) };
        }
        if (e.effect === "reanchor") {
          if (!c || (c.status !== "active" && c.status !== "unconfirmed")) {
            return { ok: false, reason: `Choice ${id} は active でも unconfirmed でもありません（${c?.status ?? "なし"}）` };
          }
          const body = normalizeReanchorBody({ place: e.place, anchored: e.anchored });
          if (!body.ok) return { ok: false, reason: body.error };
          if (c.status === "unconfirmed" && body.value.anchored) {
            return { ok: false, reason: `Choice ${id} は unconfirmed なので、Re-anchor は place だけにしてください` };
          }
          // the same gate a direct reanchor keeps: a root Choice is every change's premise, so a lane moves
          // neither it nor a Choice onto the root (the root is changed only through a proposal)
          if (c.place.some((p) => p.kind === "root") || Boolean(body.value.place?.some((p) => p.kind === "root"))) {
            return { ok: false, reason: `root の Choice ${id} は lane からは Re-anchor できません` };
          }
          return {
            ok: true,
            row: stamp({
              ...baseRow(input.repo, actor, "choice_reanchored"), id,
              ...(body.value.place ? { place: body.value.place } : {}),
              ...(body.value.anchored ? { anchored: body.value.anchored } : {}),
            }, op),
          };
        }
        return { ok: false, reason: `${e.effect} は行を書きません` };
      }
      const index = Number(op.slice("choice:".length));
      const draft = input.choices[index];
      if (!draft) return { ok: false, reason: `草案 ${index} がありません` };
      const body = normalizeChoiceBody(draft);
      if (!body.ok) return { ok: false, reason: body.error };
      const refusal = purposeRefusal(folded, body.value.purpose);
      if (refusal) return { ok: false, reason: refusal };
      if (draft.supersedes) {
        for (const id of draft.supersedes.ids) {
          const old = folded.choices.find((x) => x.id === id);
          if (!old || (old.status !== "active" && old.status !== "unconfirmed")) return { ok: false, reason: `Choice ${id} は有効ではありません` };
          if (old.place.some((p) => p.kind === "root")) return { ok: false, reason: `root の Choice ${id} は lane からは置き換えられません` };
        }
      }
      const prep = prepareChoice(numbering, actor, body.value, projectionConfigOf(input.repo).visibility_default);
      if (!prep.ok) return { ok: false, reason: prep.error };
      return {
        ok: true,
        row: stamp({
          ...baseRow(input.repo, actor, "choice_raised"), ...prep.fields,
          ...(draft.supersedes ? { supersedes: draft.supersedes.ids.map((id) => ({ id, grounds: draft.supersedes!.grounds })) } : {}),
        }, op),
      };
    };
    for (const op of ops) {
      if (doneBefore.has(op)) {
        written.push(op);
        continue;
      }
      const built = decideOne(op);
      if (!built.ok) {
        skipped.push({ op, reason: built.reason, ...bodyOf(op) });
        continue;
      }
      written.push(op);
      append.push(built.row);
      numbering.push(built.row);
    }
    return { result: { ok: true, written, skipped, done: true }, append };
  });
}

export interface ProposalView {
  id: string;
  kind: ProposalKind;
  repo: string;
  reason: string;
  body: ProposalBody;
  by: IntentActor;
  at: string;
  origin: { lane?: string; session?: string };
}

function nextProposalId(rows: IntentRow[]): string {
  let max = 0;
  for (const row of rows) {
    const id = text(row.id);
    const m = id ? /^PROP-(\d+)$/.exec(id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `PROP-${max + 1}`;
}

function nextHarmId(rows: IntentRow[]): string {
  let max = 0;
  for (const row of rows) {
    const id = text(row.id);
    const m = id ? /^H-(\d+)$/.exec(id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `H-${max + 1}`;
}

function actorOrigin(by: IntentActor): { lane?: string; session?: string } {
  return "lane" in by ? { lane: by.lane } : { session: by.session };
}

/** the whole column's own rows, without folding: a proposal is read by name, not through a viewer's window */
function proposalRows(repo: string): IntentRow[] {
  return readRows(intentColumnPath(repo));
}

/** a row that answers a proposal: the approval's effect row, or the rejection */
function answeredIds(rows: IntentRow[]): Set<string> {
  const answered = new Set<string>();
  for (const row of rows) {
    const id = text(row.proposal);
    if (id) answered.add(id);
  }
  return answered;
}

/**
 * Whether an approved replacement still holds the Choice it replaced. The effect row carries the raising lane's
 * name, so the replacement can only become real while that lane can still merge it: a lane that is alive may yet
 * merge, and a merged one has made it real for everyone. A lane that ended without merging can never make it real,
 * so its approval does not stand in the way of another lane replacing the same Choice.
 */
function replacementStands(row: IntentRow, states: Map<string, LaneState>): boolean {
  const byLane = row.by && "lane" in row.by ? row.by.lane : null;
  if (!byLane) return true; // a session approval is effective at once
  const state = states.get(byLane);
  if (!state) return true;
  if (state.mergedAt && !isAfter(row.at, state.mergedAt)) return true;
  return !state.endedAt;
}

/**
 * The successors each replaced Choice points at, read from the column's own rows rather than from a viewer's fold.
 * Two lanes replacing each other's Choice each pass on their own fold, because neither sees the other's row yet;
 * the column is what they share, so a chain that would close on landing is walked here instead. Both kinds of row
 * carry the same pair (id = successor, supersedes = the Choices replaced), so this reads one shape.
 * One replaced Choice keeps every successor standing, not the last row's alone: two lanes may close the same Choice
 * with different successors, and the state shows one of them while the column carries both. Reading only the state's
 * pick would hide the edge a chain closes through.
 * A row that can never take effect is left out by the same rule an approved proposal's effect row is read by.
 */
function replacementSuccessors(rows: IntentRow[], states: Map<string, LaneState>): Map<string, string[]> {
  const nextOf = new Map<string, string[]>();
  for (const row of rows) {
    if (row.event !== "choice_raised" && row.event !== "choice_superseded") continue;
    if (!replacementStands(row, states)) continue;
    const successor = text(row.id);
    if (!successor) continue;
    const supersedes = Array.isArray(row.supersedes) ? (row.supersedes as Record<string, unknown>[]) : [];
    for (const s of supersedes) {
      const oldId = text(s.id);
      if (!oldId) continue;
      const standing = nextOf.get(oldId);
      if (!standing) nextOf.set(oldId, [successor]);
      else if (!standing.includes(successor)) standing.push(successor);
    }
  }
  return nextOf;
}

/**
 * The Choice an already-approved proposal replaced. An approval writes its effect row with the proposal and the
 * Choices it superseded, so the whole column shows it even when the raising lane has not merged. A second approval
 * that would replace the same Choice is refused, so a Choice never ends up with two active successors standing.
 * An approval whose lane ended without merging is not counted: that replacement can never take effect.
 */
function approvedReplacement(rows: IntentRow[], ids: string[], states: Map<string, LaneState>): string | null {
  for (const row of rows) {
    if (row.event !== "choice_raised" || !text(row.proposal)) continue;
    if (!replacementStands(row, states)) continue;
    const supersedes = Array.isArray(row.supersedes) ? (row.supersedes as Record<string, unknown>[]) : [];
    for (const s of supersedes) {
      const oldId = text(s.id);
      if (oldId && ids.includes(oldId)) return oldId;
    }
  }
  return null;
}

function proposalOf(row: IntentRow, repo: string): ProposalView | null {
  const id = text(row.id);
  if (!id || row.event !== "proposal_raised") return null;
  const body = normalizeProposalBody(String(row.kind ?? ""), row.body);
  if (!body.ok) return null;
  return {
    id,
    kind: body.value.kind,
    repo,
    reason: text(row.reason) ?? "",
    body: body.value.body,
    by: row.by,
    at: row.at,
    origin: actorOrigin(row.by),
  };
}

/**
 * The proposals still open: a raise that no row points at. A lane's proposal of the overview or a root Choice is
 * dropped from the list once the lane has ended (it can no longer be approved); a harm example stays, because what
 * a lane found about the repo is a fact about the repo, not about that lane's change.
 */
export function openProposals(repo: string): ProposalView[] {
  const rows = proposalRows(repo);
  const answered = answeredIds(rows);
  const states = laneStates(readLifecycle());
  const out: ProposalView[] = [];
  for (const row of rows) {
    const view = proposalOf(row, repo);
    if (!view || answered.has(view.id)) continue;
    const byLane = "lane" in view.by ? view.by.lane : null;
    if (byLane && view.kind !== "harm_example" && states.get(byLane)?.endedAt) continue;
    out.push(view);
  }
  return out;
}

/** the proposed Purposes a lane raised and has not had confirmed, folded from the lane's own side */
export function proposedPurposesForLane(repo: string, lane: string): PurposeView[] {
  const rows = proposalRows(repo);
  const folded = foldRows(rows, lane, laneStates(readLifecycle()));
  return folded.purposes.filter((p) => p.status === "proposed" && raisedByLane(p.raised.by) === lane);
}

/**
 * The latest taking-back of a Purpose proposal this lane raised, read from the column's own rows: the fold's view of a
 * withdrawn proposal does not carry when it was withdrawn. A GO reads it to see whether the plan has been reported
 * again since.
 */
export function lastPurposeWithdrawalOfLane(repo: string, lane: string): { id: string; at: string } | null {
  const rows = proposalRows(repo);
  const folded = foldRows(rows, lane, laneStates(readLifecycle()));
  const ids = new Set(folded.purposes.filter((p) => p.status === "withdrawn" && raisedByLane(p.raised.by) === lane).map((p) => p.id));
  let last: { id: string; at: string } | null = null;
  for (const row of rows) {
    const id = text(row.id);
    if (row.event !== "purpose_withdrawn" || !id || !ids.has(id)) continue;
    if (!last || Date.parse(row.at) >= Date.parse(last.at)) last = { id, at: row.at };
  }
  return last;
}

/** the approved harm examples effective for the given viewer, in the column's order */
export function harmExamplesFor(repo: string, actor: IntentActor | null): HarmExampleView[] {
  return foldFor(repo, actor).folded.harmExamples;
}

/** what one reader shows for what is dangerous in a repo: the declaration and the approved examples */
export interface RiskView {
  risk_paths: Record<string, string[]>;
  harm_examples: HarmExampleView[];
}

/** the risk read door's answer: the repo's declaration and its harm examples from one place, writing nothing */
export function riskView(repo: string, actor: IntentActor | null = null): RiskView {
  const declared = readAreas().riskPaths?.[repo];
  return { risk_paths: declared ? Object.fromEntries(Object.entries(declared).map(([k, v]) => [k, v ?? []])) : {}, harm_examples: harmExamplesFor(repo, actor) };
}

/**
 * Raise a proposal. The body is held whole: nothing of it is applied here. A lane may name the overview and a root
 * Choice (the approval decides), but the premise is checked from the raiser's own side now, so a proposal that can
 * never be approved is refused at the door.
 */
export async function raiseProposal(input: {
  repo: string;
  actor: IntentActor;
  kind?: unknown;
  reason?: unknown;
  body?: unknown;
}): Promise<OpResult<{ id: string; kind: ProposalKind }>> {
  return runWrite<{ id: string; kind: ProposalKind }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const reason = text(input.reason);
    if (!reason) return { result: { ok: false, error: "必須の欄 reason が空です" } };
    const normalized = normalizeProposalBody(String(input.kind ?? ""), input.body);
    if (!normalized.ok) return { result: normalized };
    const { kind, body } = normalized.value;
    const folded = foldRows(rows, viewerLane(input.actor), states);
    if (kind === "overview") {
      const top = folded.purposes.find((p) => p.id === OVERVIEW_PURPOSE_ID);
      if (!top || top.status !== "active") {
        return { result: { ok: false, error: `概要の Purpose（${OVERVIEW_PURPOSE_ID}）が active ではありません` } };
      }
    }
    if (kind === "root_supersede") {
      for (const id of body.ids ?? []) {
        const old = folded.choices.find((c) => c.id === id);
        if (!old || (old.status !== "active" && old.status !== "unconfirmed")) {
          return { result: { ok: false, error: `Choice ${id} は有効ではありません` } };
        }
      }
      if (!(body.ids ?? []).some((id) => folded.choices.find((c) => c.id === id)?.place.some((p) => p.kind === "root"))) {
        return { result: { ok: false, error: "置き換える Choice のどれも Place が root ではありません" } };
      }
      // the successor is checked by the same rules the approval applies: a proposal whose successor could never be
      // written must not become a card. The id and status rules are the raiser's own (a lane names neither), and
      // the successor's Purpose has to be active from the raiser's side.
      const refusal = purposeRefusal(folded, String(body.choice?.purpose ?? ""));
      if (refusal) return { result: { ok: false, error: refusal } };
      const prep = prepareChoice(rows, input.actor, body.choice as ChoiceBody, projectionConfigOf(input.repo).visibility_default);
      if (!prep.ok) return { result: prep };
    }
    if (kind === "root_reanchor") {
      const c = folded.choices.find((x) => x.id === body.id);
      if (!c || c.status !== "active") return { result: { ok: false, error: `Choice ${String(body.id)} は active ではありません` } };
      const hasRoot = c.place.some((p) => p.kind === "root") || Boolean(body.place?.some((p) => p.kind === "root"));
      if (!hasRoot) return { result: { ok: false, error: `Choice ${String(body.id)} の Place に root がありません` } };
    }
    const id = nextProposalId(rows);
    return {
      result: { ok: true, id, kind },
      append: { ...baseRow(input.repo, input.actor, "proposal_raised"), id, kind, reason, body },
    };
  });
}

/** the proposal as answered: what the caller of the decision door needs to send the word on */
export type ProposalAnswer = {
  id: string;
  kind: ProposalKind;
  origin: { lane?: string; session?: string };
  /** the record the approval wrote, when one was written: `shown` is false for a record `idd intent show` cannot pull */
  effect?: { id: string; shown: boolean };
};

/**
 * Answer a proposal. Both answers run inside the column's own lock, re-read the column there, and write exactly one
 * row. An approval writes the effect itself (the same row shapes the direct operations write, with the proposal and
 * who approved it); a rejection writes the proposal and the reason. No separate "answered" mark: a proposal with a
 * row pointing at it is answered.
 */
export async function approveProposal(input: {
  repo: string;
  proposal?: unknown;
  approver: IntentActor;
}): Promise<OpResult<ProposalAnswer>> {
  return runWrite<ProposalAnswer>(input.repo, input.approver, ({ rows, events, states }) => {
    const proposalId = text(input.proposal);
    if (!proposalId) return { result: { ok: false, error: "proposal が空です" } };
    const raise = rows.find((r) => r.event === "proposal_raised" && text(r.id) === proposalId);
    if (!raise) return { result: { ok: false, error: `案 ${proposalId} はありません` } };
    const view = proposalOf(raise, input.repo);
    if (!view) return { result: { ok: false, error: `案 ${proposalId} の本文を読めません` } };
    if (answeredIds(rows).has(proposalId)) return { result: { ok: false, error: `案 ${proposalId} はもう答え済みです` } };
    const raiser = raise.by;
    const raiserLane = "lane" in raiser ? raiser.lane : null;
    if (raiserLane && view.kind !== "harm_example" && laneHasEnded(raiserLane, events)) {
      return { result: { ok: false, error: `${raiserLane} は終わっているので、この案は承認できません` } };
    }
    const approved = { at: nowIso(), by: input.approver };
    const effect = { proposal: proposalId, approved };
    const result: ProposalAnswer = { id: proposalId, kind: view.kind, origin: actorOrigin(raiser) };
    // the premise is checked again from the raiser's own side: the proposal may have waited while things moved
    const folded = foldRows(rows, raiserLane, states);
    if (view.kind === "overview") {
      const top = folded.purposes.find((p) => p.id === OVERVIEW_PURPOSE_ID);
      if (!top || top.status !== "active") return { result: { ok: false, error: `概要の Purpose（${OVERVIEW_PURPOSE_ID}）が active ではありません` } };
      return {
        result: { ok: true, ...result, effect: { id: OVERVIEW_PURPOSE_ID, shown: true } },
        append: { ...baseRow(input.repo, raiser, "purpose_restated"), id: OVERVIEW_PURPOSE_ID, statement: view.body.statement, ...effect },
      };
    }
    if (view.kind === "harm_example") {
      const harmId = nextHarmId(rows);
      return {
        result: { ok: true, ...result, effect: { id: harmId, shown: false } },
        append: {
          ...baseRow(input.repo, input.approver, "harm_example_added"),
          id: harmId,
          statement: view.body.statement,
          harm: view.body.harm,
          ...(view.body.always_must ? { always_must: true } : {}),
          ...effect,
        },
      };
    }
    if (view.kind === "root_supersede") {
      const body = view.body;
      const replaced = approvedReplacement(rows, body.ids ?? [], states);
      if (replaced) return { result: { ok: false, error: `Choice ${replaced} は既に承認された案で置き換わっています` } };
      const refusal = purposeRefusal(folded, String(body.choice?.purpose ?? ""));
      if (refusal) return { result: { ok: false, error: refusal } };
      for (const id of body.ids ?? []) {
        const old = folded.choices.find((c) => c.id === id);
        if (!old || (old.status !== "active" && old.status !== "unconfirmed")) {
          return { result: { ok: false, error: `Choice ${id} は有効ではありません` } };
        }
      }
      const prep = prepareChoice(rows, raiser, body.choice as ChoiceBody, projectionConfigOf(input.repo).visibility_default);
      if (!prep.ok) return { result: prep };
      return {
        result: { ok: true, ...result, effect: { id: prep.id, shown: true } },
        append: {
          ...baseRow(input.repo, raiser, "choice_raised"),
          ...prep.fields,
          supersedes: (body.ids ?? []).map((id) => ({ id, grounds: body.grounds })),
          ...effect,
        },
      };
    }
    const c = folded.choices.find((x) => x.id === view.body.id);
    if (!c || c.status !== "active") return { result: { ok: false, error: `Choice ${String(view.body.id)} は active ではありません` } };
    return {
      result: { ok: true, ...result, effect: { id: String(view.body.id), shown: true } },
      append: {
        ...baseRow(input.repo, raiser, "choice_reanchored"),
        id: view.body.id,
        ...(view.body.place ? { place: view.body.place } : {}),
        ...(view.body.anchored ? { anchored: view.body.anchored } : {}),
        ...effect,
      },
    };
  });
}

/** send a proposal back: one row with the proposal and the reason; an empty reason is refused */
export async function rejectProposal(input: {
  repo: string;
  proposal?: unknown;
  reason?: unknown;
  approver: IntentActor;
}): Promise<OpResult<ProposalAnswer>> {
  return runWrite<ProposalAnswer>(input.repo, input.approver, ({ rows }) => {
    const proposalId = text(input.proposal);
    if (!proposalId) return { result: { ok: false, error: "proposal が空です" } };
    const reason = text(input.reason);
    if (!reason) return { result: { ok: false, error: "見送りの理由を書いてください" } };
    const raise = rows.find((r) => r.event === "proposal_raised" && text(r.id) === proposalId);
    if (!raise) return { result: { ok: false, error: `案 ${proposalId} はありません` } };
    const view = proposalOf(raise, input.repo);
    if (!view) return { result: { ok: false, error: `案 ${proposalId} の本文を読めません` } };
    if (answeredIds(rows).has(proposalId)) return { result: { ok: false, error: `案 ${proposalId} はもう答え済みです` } };
    // only the approval is refused once the raising lane has ended: a rejection writes nothing but the answer
    // itself, and leaving a finished lane's proposal open with no way to send it back serves nobody
    const raiser = raise.by;
    return {
      result: { ok: true, id: proposalId, kind: view.kind, origin: actorOrigin(raiser) },
      append: { ...baseRow(input.repo, input.approver, "proposal_rejected"), proposal: proposalId, reason },
    };
  });
}

export interface MatchedPlace {
  path: string;
  place: string;
  /**
   * how the path met the Place: `file` when the path is the file the Place was written against, `dir` when it is a
   * dir's own Choice, `module` when it is another file of the same module, `root` for the root Place. A `module` hit
   * is what the injection shows as a heading of the same module; the planner disposes of `file` and `dir` alone.
   */
  kind: PlaceKind;
  /** the file mark of the Place that was met, when it has one */
  file?: string;
}

/** how a path stands to a Place: its mark's file, a dir's own Choice, another file of its module, or the root */
function hitKind(path: string, place: Place): PlaceKind {
  if (place.kind === "root") return "root";
  if (place.kind === "file") return "file";
  if (place.kind === "module" && place.file) return path === place.file ? "file" : "module";
  return "dir";
}

/** the Choice ids a lane's next raises would take, without writing anything (the ids a ready's drafts are shown by) */
export function planChoiceIds(repo: string, lane: string, count: number): string[] {
  const rows = readRows(intentColumnPath(repo));
  const key = actorKey({ lane });
  const used: IntentRow[] = [...rows];
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = nextChoiceId(used, key);
    ids.push(id);
    used.push({ event: "choice_raised", at: "", repo, by: { lane }, id } as IntentRow);
  }
  return ids;
}
export interface LookupChoice extends ChoiceView {
  /** the statement of the Purpose this Choice serves */
  purpose_statement: string;
  matched: MatchedPlace[];
}

export function placeHits(path: string, place: Place): boolean {
  if (place.kind === "root") return true;
  if (place.kind === "file") return path === place.path;
  // the repo's own module holds every path of the tree
  if (place.path === "/") return true;
  return path === place.path.slice(0, -1) || path.startsWith(place.path);
}

/**
 * Whether a path meets a Place as its own subject: the file it was written against, a dir's own Choice, or the
 * root. A module reached only because the path sits somewhere under it is not a subject: that Choice belongs to
 * another file of the module, and asking a lane to dispose of every Choice of a module (51 a file on the median)
 * would turn the disposal into a list nobody reads. Used by the planner's targets and by the touched rule.
 */
export function markHits(path: string, place: Place): boolean {
  if (place.kind === "root") return true;
  if (place.kind === "file") return path === place.path;
  if (place.kind === "module" && place.file) return path === place.file;
  return placeHits(path, place);
}

function lookupTier(matched: MatchedPlace[]): { tier: number; depth: number } {
  // the file a Place marks first, then a dir's own Choice, then another file of the same module, then the root
  const tier = Math.min(...matched.map((m) => (m.kind === "file" ? 0 : m.kind === "dir" ? 1 : m.kind === "module" ? 2 : 3)));
  const depth = tier === 1 || tier === 2 ? Math.max(...matched.filter((m) => m.kind === (tier === 1 ? "dir" : "module")).map((m) => m.place.length)) : 0;
  return { tier, depth };
}

/**
 * The active and unconfirmed Choices whose Place holds one of the paths. A file Place matches its own path
 * exactly; a dir Place matches everything under it; a root Place matches any path. Nothing is capped or
 * estimated away: the reader decides which candidate matters.
 */
export function lookupChoices(input: { repo: string; actor: IntentActor | null; paths: string[] }): LookupChoice[] {
  const { folded } = foldFor(input.repo, input.actor);
  const paths = input.paths.map((p) => p.replace(/^\.\//, "")).filter(Boolean);
  const found: { choice: LookupChoice; tier: number; depth: number }[] = [];
  for (const choice of folded.choices) {
    if (choice.status !== "active" && choice.status !== "unconfirmed") continue;
    const matched: MatchedPlace[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      for (const place of choice.place) {
        if (!placeHits(path, place)) continue;
        const key = `${path}\u0000${place.path}\u0000${place.file ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matched.push({ path, place: place.path, kind: hitKind(path, place), ...(place.file ? { file: place.file } : {}) });
      }
    }
    if (!matched.length) continue;
    const purpose = folded.purposes.find((p) => p.id === choice.purpose);
    const { tier, depth } = lookupTier(matched);
    found.push({ choice: { ...choice, purpose_statement: purpose?.statement ?? "", matched }, tier, depth });
  }
  found.sort((a, b) => a.tier - b.tier || b.depth - a.depth || a.choice.id.localeCompare(b.choice.id, "en", { numeric: true }));
  return found.map((f) => f.choice);
}

/** one record by its id, including a superseded or dropped Choice */
export function showRecord(input: { repo: string; actor: IntentActor | null; id: string }): OpResult<{ kind: "purpose" | "choice"; record: PurposeView | ChoiceView }> {
  const id = text(input.id);
  if (!id) return { ok: false, error: "id が空です" };
  const { folded } = foldFor(input.repo, input.actor);
  const purpose = folded.purposes.find((p) => p.id === id);
  if (purpose) return { ok: true, kind: "purpose", record: purpose };
  const choice = folded.choices.find((c) => c.id === id);
  if (choice) return { ok: true, kind: "choice", record: choice };
  return { ok: false, error: `${id} の記録がありません` };
}

/** the three lists, each filterable; a superseded or dropped Choice is listed as well */
export function listRecords(input: { repo: string; actor: IntentActor | null; kind?: string; status?: string }): Record<string, unknown> {
  const { folded } = foldFor(input.repo, input.actor);
  const kind = text(input.kind) ?? "";
  const status = text(input.status) ?? "";
  const out: Record<string, unknown> = {};
  if (!kind || kind === "purposes") out.purposes = folded.purposes.filter((p) => !status || p.status === status);
  if (!kind || kind === "choices") out.choices = folded.choices.filter((c) => !status || c.status === status);
  if (!kind || kind === "waives") out.waives = folded.waives.filter((w) => !status || w.kind === status);
  return out;
}

/** the name a repo's drawn copy goes under in `_docs/intent/`: its registered name, else the last segment of its key */
export function intentProjectName(repo: string, file: ReturnType<typeof readAreas> = readAreas()): string {
  return file.names?.[repo] ?? repo.split("/").pop() ?? repo;
}

/** what one viewer sees a repo's A projection as: the files to draw and where they go */
export interface ProjectionView {
  repo: string;
  project: string;
  dir: string;
  projections: ProjectionKind[];
  files: ProjectionFile[];
}

/**
 * The A projection of a repo, drawn from the state one viewer sees. The read door answers with it and the landing
 * draws from it, so the same state can never draw two different texts. `lane` is the viewer: a lane's own records
 * are visible to it before they merge; `mergedLanes` are lanes taken as merged already. Nothing is written; the
 * drawing is a function of the state alone.
 */
export function projectionViewFor(repo: string, lane: string | null = null, opts: { mergedLanes?: string[] } = {}): ProjectionView {
  const rows = readRows(intentColumnPath(repo));
  const states = laneStates(readLifecycle());
  // lanes that go into the same mainline step before this viewer's own: their rows are visible as they are once they
  // merge, so a batch's drawing at a later step already holds the earlier lanes' records (C-247-8)
  const mergedAt = new Date().toISOString();
  for (const merged of opts.mergedLanes ?? []) states.set(merged, { ...states.get(merged), mergedAt: states.get(merged)?.mergedAt ?? mergedAt });
  const folded = foldRows(rows, lane, states);
  const { projects } = foldProjectRows(rows, lane, states);
  const file = readAreas();
  const project = intentProjectName(repo, file);
  return {
    repo,
    project,
    dir: `_docs/intent/${project}/`,
    projections: projectionConfigOf(repo, file).projections,
    files: projectRecords({ purposes: folded.purposes, choices: folded.choices, projects }),
  };
}

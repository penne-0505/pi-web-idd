import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isInstructionId } from "@idd/core";
import { SPACE_ID } from "./spaces.ts";
import { ConversationRefused } from "./refusal.ts";
import { clearWarn, warnOnce } from "./warn.ts";

/** a bookmark kind: an id and the label the UI shows */
export interface BookmarkKind {
  id: string;
  label: string;
}

/** one session's marks; every field is absent when it was never set */
export interface SessionMark {
  pinned?: boolean;
  archived?: boolean;
  bookmarks?: string[];
  space?: string;
  /** the conversation type the session is on; the mode's config decides whether it means anything */
  type?: string;
  /** instruction ids the user added to this session alone: they reach it whatever their scope says (C-208-8) */
  instructionAdd?: string[];
  /** instruction ids the user left out of this session alone, though their scope covers it */
  instructionExclude?: string[];
}

export interface MarksFile {
  bookmarks: BookmarkKind[];
  sessions: Record<string, SessionMark>;
}

export interface SessionMarkPatch {
  pinned?: boolean | null;
  archived?: boolean | null;
  bookmarks?: string[] | null;
  space?: string | null;
  type?: string | null;
  instructionAdd?: string[] | null;
  instructionExclude?: string[] | null;
}

/** how a write treats a marks file it cannot read: a person's request refuses, the engine's own write skips */
export type MarksWriteBehavior = "refuse" | "skip";

const BOOKMARK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** a fresh empty table every read: a shared one would be mutated by the first write and leak into later reads */
function emptyMarks(): MarksFile {
  return { bookmarks: [], sessions: {} };
}

/**
 * Where a workspace keeps its sessions' marks. It lives in the workspace, not the engine's state, so moving
 * the engine does not lose the marks (and the pi session records stay untouched).
 */
export function marksPath(workspace: string): string {
  return join(workspace, ".propter", "sessions.json");
}

function isBookmarkKind(value: unknown): value is BookmarkKind {
  if (!value || typeof value !== "object") return false;
  const kind = value as { id?: unknown; label?: unknown };
  return typeof kind.id === "string" && BOOKMARK_ID.test(kind.id) && typeof kind.label === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** a mark as stored, keeping only the fields the engine knows; anything else is dropped, never trusted as is */
function sanitizeMark(value: unknown): SessionMark | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const mark: SessionMark = {};
  if (typeof raw.pinned === "boolean") mark.pinned = raw.pinned;
  if (typeof raw.archived === "boolean") mark.archived = raw.archived;
  if (isStringArray(raw.bookmarks) && raw.bookmarks.length) mark.bookmarks = [...new Set(raw.bookmarks)];
  // a space whose id shape is wrong points nowhere, exactly like one whose dir is gone: the field is dropped,
  // never carried to a door that would throw on it. A mark made before the rename keeps the space under
  // `project`; it is read when `space` gives nothing, and the next write stores it under `space` only.
  if (typeof raw.space === "string" && SPACE_ID.test(raw.space)) mark.space = raw.space;
  else if (typeof raw.project === "string" && SPACE_ID.test(raw.project)) mark.space = raw.project;
  // a type name is the mode config's key: any non-empty string is kept, and a name the config no longer has
  // reads as the mode's default at the door that resolves it
  if (typeof raw.type === "string" && raw.type) mark.type = raw.type;
  // the session's own instruction exceptions: only well-formed ids are kept, and an id in both lists is an addition
  const add = isStringArray(raw.instructionAdd) ? [...new Set(raw.instructionAdd.filter(isInstructionId))] : [];
  const exclude = isStringArray(raw.instructionExclude) ? [...new Set(raw.instructionExclude.filter(isInstructionId))].filter((id) => !add.includes(id)) : [];
  if (add.length) mark.instructionAdd = add;
  if (exclude.length) mark.instructionExclude = exclude;
  return Object.keys(mark).length ? mark : null;
}

/**
 * What a marks file's read found: no file, a readable table, or a problem. The three are kept apart so a
 * write can refuse (and quarantine a broken file) while every read-only path proceeds with no marks.
 */
export type MarksProblem = "missing" | "io" | "broken";

export interface MarksState {
  problem: MarksProblem | null;
  marks: MarksFile;
  /** why the file could not be read; present when `problem` is `io` or `broken` */
  reason?: string;
}

function parseMarks(text: string): MarksFile {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("最上位が表ではありません");
  const source = raw as { bookmarks?: unknown; sessions?: unknown };
  const bookmarks = Array.isArray(source.bookmarks) ? source.bookmarks.filter(isBookmarkKind).map((kind) => ({ ...kind })) : [];
  const sessions: Record<string, SessionMark> = {};
  if (source.sessions && typeof source.sessions === "object" && !Array.isArray(source.sessions)) {
    for (const [id, value] of Object.entries(source.sessions as Record<string, unknown>)) {
      const mark = sanitizeMark(value);
      if (mark) sessions[id] = mark;
    }
  }
  return { bookmarks, sessions };
}

function marksScope(workspace: string): string {
  return `marks:${workspace}`;
}

export function loadMarksState(workspace: string): MarksState {
  let text: string;
  try {
    text = readFileSync(marksPath(workspace), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { problem: "missing", marks: emptyMarks() };
    return { problem: "io", marks: emptyMarks(), reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { problem: null, marks: parseMarks(text) };
  } catch (err) {
    return { problem: "broken", marks: emptyMarks(), reason: err instanceof Error ? err.message : String(err) };
  }
}

/** note a read problem once per state; a healthy read clears the scope so a later break is logged again */
function noteReadProblem(workspace: string, state: MarksState): void {
  if (!state.problem || state.problem === "missing") {
    clearWarn(marksScope(workspace));
    return;
  }
  warnOnce(marksScope(workspace), `${state.problem}:${state.reason ?? ""}`, `[idd marks] ${marksPath(workspace)}: 読めません: ${state.reason ?? ""}`);
}

/**
 * Read the workspace's marks. A missing, unreadable or broken file is no marks to every read-only path, so one
 * bad file never keeps a list from answering; nothing here is written back on read.
 */
export function readMarks(workspace: string): MarksFile {
  const state = loadMarksState(workspace);
  noteReadProblem(workspace, state);
  return state.marks;
}

/** rename a broken marks file aside, so its bytes survive and the next write starts from no file */
function quarantineMarks(workspace: string): string {
  const path = marksPath(workspace);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = `${path}.broken-${stamp}`;
  for (let n = 1; existsSync(dest); n += 1) dest = `${path}.broken-${stamp}-${n}`;
  renameSync(path, dest);
  return dest;
}

/**
 * The table a write may change, or null when the engine's own write must skip. A file that is broken as JSON
 * (or as a table) is moved aside and the caller is refused, so the requested change is never written on a
 * state that cannot be read and a retry starts clean; a read failure (permissions, a dir in the way) is refused
 * without touching the file, because its content is not known to be broken.
 */
function loadForWrite(workspace: string, behavior: MarksWriteBehavior): MarksFile | null {
  const state = loadMarksState(workspace);
  if (!state.problem || state.problem === "missing") return state.marks;
  if (behavior === "skip") {
    warnOnce(marksScope(workspace), `${state.problem}:${state.reason ?? ""}`, `[idd marks] ${marksPath(workspace)}: 読めないので書き込みを見送ります: ${state.reason ?? ""}`);
    return null;
  }
  if (state.problem === "io") {
    throw new ConversationRefused(`印のファイルを読めません: ${state.reason ?? ""}`, 409);
  }
  const dest = quarantineMarks(workspace);
  warnOnce(marksScope(workspace), `quarantine:${dest}`, `[idd marks] ${marksPath(workspace)}: 読めません: ${state.reason ?? ""}; ${dest} に退避しました`);
  throw new ConversationRefused(`印のファイルが壊れていたので ${dest} に退避しました`, 409);
}

/** refuse a write that could not land, before the caller does anything hard to undo (a pi start, a record) */
export function assertMarksWritable(workspace: string): void {
  loadForWrite(workspace, "refuse");
}

/** write the marks whole, by rename, so a reader never sees a half-written table */
export function writeMarks(workspace: string, data: MarksFile): void {
  const path = marksPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function markOf(workspace: string, sessionId: string): SessionMark {
  return readMarks(workspace).sessions[sessionId] ?? {};
}

function isEmptyMark(mark: SessionMark): boolean {
  return mark.pinned === undefined && mark.archived === undefined && !(mark.bookmarks?.length) && mark.space === undefined && mark.type === undefined
    && !(mark.instructionAdd?.length) && !(mark.instructionExclude?.length);
}

/**
 * Change the fields the caller named; a `null` clears the field. Bookmark ids must already be defined, so a
 * typo cannot make an unreachable kind, and a space id must have the space id's shape. Writing the
 * workspace's file is the only effect; pi is never woken.
 */
export function setSessionMark(
  workspace: string,
  sessionId: string,
  patch: SessionMarkPatch,
  opts: { onUnreadable?: MarksWriteBehavior } = {},
): SessionMark {
  const data = loadForWrite(workspace, opts.onUnreadable ?? "refuse");
  if (!data) return {};
  const mark: SessionMark = { ...(data.sessions[sessionId] ?? {}) };
  if (patch.pinned === null) delete mark.pinned;
  else if (typeof patch.pinned === "boolean") mark.pinned = patch.pinned;
  if (patch.archived === null) delete mark.archived;
  else if (typeof patch.archived === "boolean") mark.archived = patch.archived;
  if (patch.bookmarks === null) delete mark.bookmarks;
  else if (Array.isArray(patch.bookmarks)) {
    const unique = [...new Set(patch.bookmarks)];
    for (const id of unique) if (!data.bookmarks.some((kind) => kind.id === id)) throw new ConversationRefused(`ブックマークの種類がありません: ${id}`, 400);
    if (unique.length) mark.bookmarks = unique;
    else delete mark.bookmarks;
  }
  if (patch.space === null) delete mark.space;
  else if (typeof patch.space === "string") {
    if (!SPACE_ID.test(patch.space)) throw new ConversationRefused("スペースの id の形が不正です", 400);
    mark.space = patch.space;
  }
  if (patch.type === null) delete mark.type;
  else if (typeof patch.type === "string" && patch.type) mark.type = patch.type;
  // the two instruction lists stay apart: naming an id in one takes it out of the other
  for (const [field, other] of [["instructionAdd", "instructionExclude"], ["instructionExclude", "instructionAdd"]] as const) {
    const value = patch[field];
    if (value === null) delete mark[field];
    else if (Array.isArray(value)) {
      const ids = [...new Set(value)];
      for (const id of ids) if (!isInstructionId(id)) throw new ConversationRefused(`方針の id の形が不正です: ${id}`, 400);
      if (ids.length) {
        mark[field] = ids;
        const rest = (mark[other] ?? []).filter((id) => !ids.includes(id));
        if (rest.length) mark[other] = rest;
        else delete mark[other];
      } else delete mark[field];
    }
  }
  if (isEmptyMark(mark)) delete data.sessions[sessionId];
  else data.sessions[sessionId] = mark;
  writeMarks(workspace, data);
  return mark;
}

/** remove a session's marks; the file is left as it is when the session had none */
export function removeSessionMark(workspace: string, sessionId: string, opts: { onUnreadable?: MarksWriteBehavior } = {}): void {
  const data = loadForWrite(workspace, opts.onUnreadable ?? "refuse");
  if (!data) return;
  if (!(sessionId in data.sessions)) return;
  delete data.sessions[sessionId];
  writeMarks(workspace, data);
}

export function addBookmarkKind(workspace: string, id: string, label: string): BookmarkKind {
  const trimmed = id.trim();
  if (!BOOKMARK_ID.test(trimmed)) throw new ConversationRefused("ブックマークの id の形が不正です", 400);
  const data = loadForWrite(workspace, "refuse");
  if (!data) throw new ConversationRefused("印のファイルを読めません", 409);
  if (data.bookmarks.some((kind) => kind.id === trimmed)) throw new ConversationRefused(`ブックマークの種類が既にあります: ${trimmed}`, 409);
  const kind: BookmarkKind = { id: trimmed, label: label.trim() || trimmed };
  data.bookmarks.push(kind);
  writeMarks(workspace, data);
  return kind;
}

export function renameBookmarkKind(workspace: string, id: string, label: string): BookmarkKind {
  const data = loadForWrite(workspace, "refuse");
  if (!data) throw new ConversationRefused("印のファイルを読めません", 409);
  const kind = data.bookmarks.find((entry) => entry.id === id);
  if (!kind) throw new ConversationRefused(`ブックマークの種類がありません: ${id}`, 404);
  kind.label = label.trim() || kind.id;
  writeMarks(workspace, data);
  return kind;
}

/** remove a kind and the marks that used it, together in one write */
export function removeBookmarkKind(workspace: string, id: string): void {
  const data = loadForWrite(workspace, "refuse");
  if (!data) throw new ConversationRefused("印のファイルを読めません", 409);
  const before = data.bookmarks.length;
  data.bookmarks = data.bookmarks.filter((kind) => kind.id !== id);
  if (data.bookmarks.length === before) throw new ConversationRefused(`ブックマークの種類がありません: ${id}`, 404);
  for (const [sessionId, mark] of Object.entries(data.sessions)) {
    if (!mark.bookmarks?.includes(id)) continue;
    const rest = mark.bookmarks.filter((entry) => entry !== id);
    if (rest.length) mark.bookmarks = rest;
    else delete mark.bookmarks;
    if (isEmptyMark(mark)) delete data.sessions[sessionId];
  }
  writeMarks(workspace, data);
}

/** the labels for a set of bookmark ids, in the file's order */
export function bookmarkLabels(workspace: string): BookmarkKind[] {
  return readMarks(workspace).bookmarks;
}

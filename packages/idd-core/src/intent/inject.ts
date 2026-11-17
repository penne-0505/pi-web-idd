/**
 * What the injection adds when an agent opens or rewrites a file: the Choices whose Place holds that file, and
 * the rows that record what was handed over. One pure decision, called by the CLI verb only — the pi extension
 * and the Claude Code hook both go through that verb, so the rule cannot drift between the two harnesses.
 *
 * The record file is the only memory: a session's rows say what was already read, whose why was already handed
 * over, and which hits were already told. Everything here is derived from it, so a fresh process (the hook runs
 * one per tool call) sees exactly what the previous ones handed over.
 */

import { moduleOf } from "./records.ts";
import { placeHits } from "./store.ts";
import type { ChoiceForms, ChoiceStatus, Place } from "./records.ts";

/** the harness event the verb is judging; the Claude and pi bridges both map onto these */
export type InjectEvent = "read" | "edit" | "write" | "bash-read" | "bash-write" | "compact";

/** how a Choice was handed over: its body, one id-and-chosen line, or the notice of an edit/write hit */
export type InjectForm = "body" | "line" | "notice";

/** the Choice as the injection needs it: the lookup's fields, without the fold's superseded and dropped */
export interface InjectChoice {
  id: string;
  status: ChoiceStatus;
  forms: ChoiceForms;
  place: Place[];
  why: string;
  free: string;
  /** the Purpose this Choice belongs to, from the lookup; absent when the row names none */
  purpose?: string;
  /** the Purpose's whole statement, from the lookup; empty when the Purpose cannot be found */
  purpose_statement?: string;
}

export interface InjectChoiceRow {
  id: string;
  form: InjectForm;
  status: "active" | "unconfirmed";
  /** a notice that also carried the why and free */
  body?: boolean;
  /** an edit whose Place named a symbol that could not be found in the file before the edit */
  symbol_missing?: boolean;
}

/** one row of the injection record: the semantic part; the verb adds the time, session, lane, stage and role */
export interface InjectRow {
  event: InjectEvent;
  path?: string;
  choices?: InjectChoiceRow[];
  /** a Bash write that was stopped before it ran; such a row carries no Choice */
  blocked?: boolean;
}

export interface InjectInput {
  event: InjectEvent;
  /** repo-root relative; the verb makes it so before calling, and this normalizes the separators */
  path?: string;
  /** the Choices the lookup returned, in the lookup's order (file, then deeper dir, then root, then id) */
  choices?: InjectChoice[];
  /** edit: the replacements, each matched against the content as it was before the edit */
  edits?: { oldText: string }[];
  /** the file's content before the edit; null or absent when it could not be read */
  content?: string | null;
  /** the record's rows for this session, oldest first */
  rows: InjectRow[];
}

export interface InjectDecision {
  /** what to add to the context; null when nothing is added */
  text: string | null;
  /** the rows to append to the record, in order */
  rows: InjectRow[];
}

/** at most this many Choices carry their body in one injection; the rest keep id and chosen (DEC-107-4) */
export const BODY_LIMIT = 5;

/**
 * What the Harness hands a hook about the run it belongs to: the Issue lane to name when looking Choices up,
 * the stage, the role, and the file the injection record is appended to. Named here once so the CLI verb and
 * the lane that writes the environment cannot drift apart.
 */
export const INTENT_LANE_ENV = "IDD_INTENT_LANE";
export const INTENT_STAGE_ENV = "IDD_INTENT_STAGE";
export const INTENT_ROLE_ENV = "IDD_INTENT_ROLE";
export const INTENT_RECORD_ENV = "IDD_INTENT_RECORD";

/** the one place a path is made comparable: repo-root relative, `/` separators, no `./`, no doubled slash */
export function normalizeInjectPath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  const root = p.startsWith("/");
  p = p.replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (root) return `/${p.replace(/^\/+/, "")}`;
  return p.replace(/\/+$/, "");
}

/** the paths of a Choice's Places that hold this exact path as the file they were written against */
function filePlacesOf(choice: InjectChoice, path: string): Place[] {
  return choice.place.filter((place) => (place.kind === "file" ? place.path === path : place.kind === "module" && place.file === path));
}

/** the Choices of the opened file's own module: the ones whose Place names that module, the file's own excluded */
function moduleSiblings(choices: InjectChoice[], path: string): InjectChoice[] {
  const at = moduleOf(path);
  return choices.filter((choice) => choice.place.some((place) => place.kind !== "root" && place.path === at));
}

/** how many headings of the same module one injection carries; the rest are counted in one line (C-179-3) */
export const HEADING_LIMIT = 10;

function isOpen(status: ChoiceStatus): status is "active" | "unconfirmed" {
  return status === "active" || status === "unconfirmed";
}

/**
 * What the session has handed over since its last compaction: the files read, the Choices whose body was
 * handed over, the Choices whose edit/write hit was already told, and the Bash write paths already stopped once.
 */
export function handedOver(rows: InjectRow[]): { readPaths: Set<string>; bodies: Set<string>; notified: Set<string>; blockedPaths: Set<string> } {
  const state = { readPaths: new Set<string>(), bodies: new Set<string>(), notified: new Set<string>(), blockedPaths: new Set<string>() };
  for (const row of rows) {
    if (row.event === "compact") {
      state.readPaths.clear();
      state.bodies.clear();
      state.notified.clear();
      state.blockedPaths.clear();
      continue;
    }
    if ((row.event === "read" || row.event === "bash-read") && row.path) state.readPaths.add(row.path);
    if (row.event === "bash-write" && row.blocked && row.path) state.blockedPaths.add(row.path);
    for (const c of row.choices ?? []) {
      if (c.form === "body" || (c.form === "notice" && c.body)) state.bodies.add(c.id);
      if (c.form === "notice") state.notified.add(c.id);
    }
  }
  return state;
}

/**
 * The Purpose line a Choice's body carries: the Purpose's id and its want (the statement's first sentence), never
 * the whole statement. The brief hands the whole over once, and a body stays at a size an agent can read (C-159-2).
 */
function purposeLine(choice: InjectChoice): string | null {
  const id = choice.purpose?.trim();
  if (!id) return null;
  const statement = (choice.purpose_statement ?? "").trim();
  const want = /^[^。]*。/.exec(statement)?.[0] ?? statement;
  return want ? `${id} ${want}` : id;
}

function bodyBlock(choice: InjectChoice, indent: string): string[] {
  const lines = [`${indent}- ${choice.id}${mark(choice)} ${choice.forms.chosen}`];
  const purpose = purposeLine(choice);
  if (purpose) lines.push(`${indent}  purpose: ${purpose}`);
  lines.push(`${indent}  why: ${choice.why}`);
  lines.push(`${indent}  free: ${choice.free}`);
  return lines;
}

function lineBlock(choice: InjectChoice, indent: string): string[] {
  return [`${indent}- ${choice.id}${mark(choice)} ${choice.forms.chosen}（本文は渡し済み。\`idd intent show ${choice.id}\` で引ける）`];
}

/**
 * The heading lines of the opened file's own module: the id and chosen of the Choices that hold the same module but
 * not this file, so an agent sees what the module promises without having to read a body it did not ask for. Ten at
 * most, and the rest counted in one line that says how to pull them (C-179-3).
 */
function headingBlock(siblings: InjectChoice[], at: string, path: string): { lines: string[]; rows: InjectChoiceRow[] } {
  if (!siblings.length) return { lines: [], rows: [] };
  const lines = [`同じ module（${at}）の Choice`];
  const rows: InjectChoiceRow[] = [];
  for (const choice of siblings.slice(0, HEADING_LIMIT)) {
    lines.push(`- ${choice.id}${mark(choice)} ${choice.forms.chosen}`);
    rows.push({ id: choice.id, form: "line", status: choice.status as "active" | "unconfirmed" });
  }
  const rest = siblings.length - HEADING_LIMIT;
  if (rest > 0) lines.push(`（ほか ${rest} 件。\`idd intent lookup ${path}\` で引ける）`);
  return { lines, rows };
}

function mark(choice: InjectChoice): string {
  return choice.status === "unconfirmed" ? " [unconfirmed]" : "";
}

/** the one explanation of the unconfirmed mark, added once to an injection that holds such a Choice (DEC-107-8) */
const UNCONFIRMED_NOTE = "（[unconfirmed] は移行で機械が移したもの。触る lane の計画役が、確認・Supersede・捨てるのどれかにする）";

const EDIT_GUIDE = "（why を変えるなら Supersede か Re-anchor を、free の中なら Waive を）";

/** the guidance a new session gets: the tool that answers before a file is even opened */
export const SESSION_START_GUIDANCE = [
  "この lane には、ファイルに結び付いた Choice の why と free が、開いた・書き換えた瞬間に差し込まれる。",
  "先に引くときは `idd intent lookup <path>` を使う（複数の path を渡せる。`idd intent show <id>` で本文が読める）。",
].join("\n");

export interface SessionStartResult {
  text: string | null;
  rows: InjectRow[];
}

/**
 * A session's start: a new one is told how to look Choices up, a resumed one is told nothing, and one that
 * starts after a compaction first writes the compaction row, so the bodies handed over before it are handed
 * over again (DEC-107-4). `source` is Claude Code's SessionStart source; pi's own compaction maps to `compact`.
 */
export function sessionStartRows(source: string | undefined | null): SessionStartResult {
  if (source === "compact") return { text: SESSION_START_GUIDANCE, rows: [{ event: "compact" }] };
  if (source === "resume") return { text: null, rows: [] };
  // startup, clear, or a source nobody named: a session with no history is told how to look Choices up
  return { text: SESSION_START_GUIDANCE, rows: [] };
}

/**
 * The line numbers a symbol occupies in the content, from its first definition-like line to the line before the
 * next definition at the same or a shallower indent. Deliberately language-agnostic and deliberately wide: an
 * uncertain boundary takes in more lines, so a real hit is never dropped (DEC-107-6).
 */
function symbolRange(content: string, symbol: string, siblings: string[]): { start: number; end: number } | null {
  const lines = content.split("\n");
  // the declaration, not merely the first mention: an import or a call above it would otherwise become the range
  const at = lines.findIndex((line) => wordAt(line, symbol) && looksLikeDefinition(line));
  if (at < 0) return null;
  const base = indentOf(lines[at]);
  let end = lines.length - 1;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const shallower = indentOf(line) <= base;
    if (!shallower) continue;
    if (siblings.some((s) => s !== symbol && wordAt(line, s)) || looksLikeDefinition(line)) {
      end = i - 1;
      break;
    }
  }
  return { start: at, end };
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, "    ").length : 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** whether the line names the word on a boundary */
function wordAt(line: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(word)}(?![A-Za-z0-9_$])`).test(line);
}

/** a line that begins a declaration in some language; when in doubt it counts, so a range ends early and wide */
function looksLikeDefinition(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) return false;
  if (/^(export\s+|declare\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|async\s+|final\s+)*(function|class|interface|type|enum|struct|trait|impl|namespace|module|def|fn|func)\b/.test(t)) return true;
  if (/^[\w$#@]+\s*\(.*\)\s*(?::[^={]+)?\s*\{?\s*$/.test(t)) return true;
  if (/^(?:get|set)\s+[\w$#@]+/.test(t)) return true;
  if (/^[\w$#@]+\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$#@])/.test(t)) return true;
  return false;
}

/** the line span a replacement touches in the content, or null when the text is not there */
function editRange(content: string, oldText: string): { start: number; end: number } | null {
  if (!oldText) return null;
  const at = content.indexOf(oldText);
  if (at < 0) return null;
  const start = content.slice(0, at).split("\n").length - 1;
  const end = start + oldText.split("\n").length - 1;
  return { start, end };
}

interface FileHit {
  hit: boolean;
  symbolMissing: boolean;
}

/** whether an edit's replacements meet a file Place's symbols, and whether a symbol could not be found */
function editMeetsPlace(place: Place, path: string, input: InjectInput): FileHit {
  if (place.kind !== "file" || !placeHits(path, place)) return { hit: false, symbolMissing: false };
  const symbols = place.symbols ?? [];
  if (!symbols.length) return { hit: true, symbolMissing: false };
  const content = input.content;
  if (content === null || content === undefined) return { hit: true, symbolMissing: true };
  const edits = input.edits ?? [];
  // no replacement to place: the boundary cannot be decided, so the hit is taken rather than dropped
  if (!edits.length) return { hit: true, symbolMissing: false };
  let symbolMissing = false;
  let hit = false;
  for (const symbol of symbols) {
    const range = symbolRange(content, symbol, symbols);
    if (!range) {
      symbolMissing = true;
      hit = true;
      continue;
    }
    for (const edit of edits) {
      const span = editRange(content, edit.oldText);
      // a replacement whose text is not in the file is taken as a hit: the file may have changed under us
      if (!span || (span.start <= range.end && span.end >= range.start)) hit = true;
    }
  }
  return { hit, symbolMissing };
}

/** the Choice's own module and file marks, and whether the event meets them; a module with no mark is a dir's Choice */
function meets(choice: InjectChoice, event: "read" | "edit" | "write", path: string, input: InjectInput): { hit: boolean; symbolMissing: boolean } {
  if (event === "read") return { hit: filePlacesOf(choice, path).length > 0, symbolMissing: false };
  let hit = false;
  let symbolMissing = false;
  for (const place of choice.place) {
    if (place.kind === "root") continue;
    if (place.kind === "file") {
      if (!placeHits(path, place)) continue;
      if (event === "write") { hit = true; continue; }
      const met = editMeetsPlace(place, path, input);
      if (met.hit) hit = true;
      if (met.symbolMissing) symbolMissing = true;
      continue;
    }
    // a module Place: the file it marks is the fine target when it names one, the module itself otherwise
    if (place.file) {
      if (place.file !== path) continue;
      if (event === "write") { hit = true; continue; }
      const met = editMeetsPlace({ path: place.file, kind: "file", ...(place.symbols ? { symbols: place.symbols } : {}) }, path, input);
      if (met.hit) hit = true;
      if (met.symbolMissing) symbolMissing = true;
      continue;
    }
    if (placeHits(path, place)) hit = true;
  }
  return { hit, symbolMissing };
}

function openChoices(choices: InjectChoice[] | undefined): InjectChoice[] {
  return (choices ?? []).filter((c) => isOpen(c.status));
}

function hasUnconfirmed(choices: InjectChoice[]): boolean {
  return choices.some((c) => c.status === "unconfirmed");
}

/**
 * What to add for one event. A read hands over the file Places that hold the path, once per file; an edit or a
 * write hands over the Choices whose Place meets the change, once per Choice, with the why only while it has
 * not been handed over. A dir's Choice comes only with a change under it, never with a read; a root's Choice is
 * not handed over at all (DEC-107-7). Nothing is added when nothing hits, and no row is written then.
 */
export function decideInjection(input: InjectInput): InjectDecision {
  if (input.event === "compact") return { text: null, rows: [{ event: "compact" }] };
  // the Bash events have their own entry points: they judge several paths in one lookup, so they are not here
  if (input.event === "bash-read" || input.event === "bash-write") return { text: null, rows: [] };
  const path = input.path ? normalizeInjectPath(input.path) : "";
  if (!path) return { text: null, rows: [] };
  const state = handedOver(input.rows);

  if (input.event === "read") {
    if (state.readPaths.has(path)) return { text: null, rows: [] };
    const open = openChoices(input.choices);
    const hits = open.filter((c) => filePlacesOf(c, path).length > 0);
    const hitIds = new Set(hits.map((c) => c.id));
    // the rest of the module: not this file's own Choice, but its module's promise, so its id and chosen are shown
    const siblings = moduleSiblings(open, path).filter((c) => !hitIds.has(c.id));
    if (!hits.length && !siblings.length) return { text: null, rows: [] };
    const rows: InjectChoiceRow[] = [];
    const body: string[] = [];
    const line: string[] = [];
    let bodies = 0;
    for (const choice of hits) {
      if (!state.bodies.has(choice.id) && bodies < BODY_LIMIT) {
        bodies += 1;
        body.push(...bodyBlock(choice, ""));
        rows.push({ id: choice.id, form: "body", status: choice.status as "active" | "unconfirmed" });
      } else {
        line.push(...lineBlock(choice, ""));
        rows.push({ id: choice.id, form: "line", status: choice.status as "active" | "unconfirmed" });
      }
    }
    const heading = headingBlock(siblings, moduleOf(path), path);
    rows.push(...heading.rows);
    const header = `<propter-intent path="${path}">\nこのファイルに結び付いた Choice${hasUnconfirmed([...hits, ...siblings]) ? UNCONFIRMED_NOTE : ""}`;
    const text = [header, ...body, ...line, ...heading.lines, "</propter-intent>"].join("\n");
    return { text, rows: [{ event: "read", path, choices: rows }] };
  }

  const event = input.event;
  const hits: { choice: InjectChoice; symbolMissing: boolean }[] = [];
  for (const choice of openChoices(input.choices)) {
    // a hit already told is passed over once its body was handed over too: a notice shrunk by the body limit
    // told only the id, so its body still has to reach the agent at a later hit
    if (state.notified.has(choice.id) && state.bodies.has(choice.id)) continue;
    const met = meets(choice, event, path, input);
    if (met.hit) hits.push({ choice, symbolMissing: met.symbolMissing });
  }
  if (!hits.length) return { text: null, rows: [] };
  const rows: InjectChoiceRow[] = [];
  const blocks: string[] = [];
  let bodies = 0;
  for (const { choice, symbolMissing } of hits) {
    const withBody = !state.bodies.has(choice.id) && bodies < BODY_LIMIT;
    if (withBody) {
      bodies += 1;
      blocks.push(...bodyBlock(choice, ""));
    } else {
      blocks.push(...lineBlock(choice, ""));
    }
    rows.push({
      id: choice.id,
      form: "notice",
      status: choice.status as "active" | "unconfirmed",
      ...(withBody ? { body: true } : {}),
      ...(symbolMissing ? { symbol_missing: true } : {}),
    });
  }
  const unconfirmed = hits.some((h) => h.choice.status === "unconfirmed");
  const header = `<propter-intent path="${path}" event="${event}">\nこのファイルの Choice に当たった${unconfirmed ? UNCONFIRMED_NOTE : ""}${EDIT_GUIDE}`;
  return { text: [header, ...blocks, "</propter-intent>"].join("\n"), rows: [{ event, path, choices: rows }] };
}

export interface BashReadInput {
  /** repo-root relative; a Bash command can name several files at once */
  paths: string[];
  /** the Choices the lookup returned for all of the paths together */
  choices?: InjectChoice[];
  rows: InjectRow[];
}

/**
 * What a Bash read adds. It is the read rule over several paths in one call, with one shared body budget: a
 * single `cat a b c` must not hand over more bodies than one file would. A Choice already handed over stays a
 * line, and a file already opened adds nothing, whether it was opened by Bash or by Read. The rows carry
 * `bash-read`, so the record tells the two routes apart while the memory stays shared.
 */
export function decideBashRead(input: BashReadInput): InjectDecision {
  const state = handedOver(input.rows);
  const rows: InjectRow[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  const handed = new Set<string>();
  let bodies = 0;
  for (const raw of input.paths) {
    const path = normalizeInjectPath(raw);
    if (!path || seen.has(path) || state.readPaths.has(path)) continue;
    seen.add(path);
    const open = openChoices(input.choices);
    const hits = open.filter((c) => filePlacesOf(c, path).length > 0);
    const hitIds = new Set(hits.map((c) => c.id));
    // the same heading rule as a Read: the rest of the module is shown as id and chosen, so a Bash read hands
    // over exactly what the Read tool would have (DEC-115-2)
    const siblings = moduleSiblings(open, path).filter((c) => !hitIds.has(c.id));
    if (!hits.length && !siblings.length) continue;
    const body: string[] = [];
    const line: string[] = [];
    const choiceRows: InjectChoiceRow[] = [];
    for (const choice of hits) {
      if (!state.bodies.has(choice.id) && !handed.has(choice.id) && bodies < BODY_LIMIT) {
        bodies += 1;
        body.push(...bodyBlock(choice, ""));
        choiceRows.push({ id: choice.id, form: "body", status: choice.status as "active" | "unconfirmed" });
      } else {
        line.push(...lineBlock(choice, ""));
        choiceRows.push({ id: choice.id, form: "line", status: choice.status as "active" | "unconfirmed" });
      }
      handed.add(choice.id);
    }
    const heading = headingBlock(siblings, moduleOf(path), path);
    choiceRows.push(...heading.rows);
    const header = `<propter-intent path="${path}">\nこのファイルに結び付いた Choice${hasUnconfirmed([...hits, ...siblings]) ? UNCONFIRMED_NOTE : ""}`;
    blocks.push(header, ...body, ...line, ...heading.lines, "</propter-intent>");
    rows.push({ event: "bash-read", path, choices: choiceRows });
  }
  if (!blocks.length) return { text: null, rows: [] };
  return { text: blocks.join("\n"), rows };
}

export interface BashWriteInput {
  /** repo-root relative; only the tree's paths reach here */
  paths: string[];
  choices?: InjectChoice[];
  rows: InjectRow[];
}

/**
 * What a Bash write that is being let through adds. Every path gets a row even when no Choice meets it: the
 * record is how the count of Bash writes is kept. A hit is told like an edit's or a write's — the notice once,
 * with the body while it has not been handed over — and a dir's Choice comes with it, a root's does not. The row
 * says `bash-write`, so a path stopped once can be told from a path only written through.
 */
export function decideBashWrite(input: BashWriteInput): InjectDecision {
  const state = handedOver(input.rows);
  const rows: InjectRow[] = [];
  const blocks: string[] = [];
  const handed = new Set<string>();
  let bodies = 0;
  for (const raw of input.paths) {
    const path = normalizeInjectPath(raw);
    if (!path) continue;
    const hits: { choice: InjectChoice; symbolMissing: boolean }[] = [];
    for (const choice of openChoices(input.choices)) {
      if (state.notified.has(choice.id) && state.bodies.has(choice.id)) continue;
      if (handed.has(choice.id)) continue;
      // a Bash write names no symbols, so a file or dir Place on the path is the whole test; a root's is not
      if (choice.place.some((place) => place.kind !== "root" && placeHits(path, place))) hits.push({ choice, symbolMissing: false });
    }
    if (!hits.length) {
      rows.push({ event: "bash-write", path });
      continue;
    }
    const choiceRows: InjectChoiceRow[] = [];
    const pathBlocks: string[] = [];
    for (const { choice } of hits) {
      const withBody = !state.bodies.has(choice.id) && bodies < BODY_LIMIT;
      if (withBody) {
        bodies += 1;
        pathBlocks.push(...bodyBlock(choice, ""));
      } else {
        pathBlocks.push(...lineBlock(choice, ""));
      }
      handed.add(choice.id);
      choiceRows.push({ id: choice.id, form: "notice", status: choice.status as "active" | "unconfirmed", ...(withBody ? { body: true } : {}) });
    }
    const unconfirmed = hits.some((h) => h.choice.status === "unconfirmed");
    const header = `<propter-intent path="${path}" event="bash-write">\nこのファイルの Choice に当たった${unconfirmed ? UNCONFIRMED_NOTE : ""}${EDIT_GUIDE}`;
    blocks.push(header, ...pathBlocks, "</propter-intent>");
    rows.push({ event: "bash-write", path, choices: choiceRows });
  }
  return blocks.length ? { text: blocks.join("\n"), rows } : { text: null, rows };
}

/**
 * The user's instructions: one file in the user's own dir, and a readable copy beside it. The file is the only
 * source: the engine's state and a repo's `_docs/` hold none, so moving the engine or changing the repo leaves the
 * same instructions in force. A file that is missing, unreadable or broken means "no instructions" to every reader
 * (a lane and a conversation go on without them), and a write never replaces a file it could not read with an empty
 * one: a broken file is moved aside and the write is refused, so a retry starts from no file and the bytes survive.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readAreas } from "../config/areas.ts";
import { userConfigDir } from "../config/files.ts";
import { describeScope, normalizeScope, sceneOfStage, scopeMatches, type Scope, type Situation } from "./scope.ts";

/** the dir the instructions live in; `IDD_INSTRUCTIONS_DIR` replaces it (the tests never read the real one) */
export function instructionsDir(): string {
  return process.env.IDD_INSTRUCTIONS_DIR?.trim() || join(userConfigDir(), "instructions");
}

export const INSTRUCTIONS_FILE = "instructions.json";
export const INSTRUCTIONS_COPY = "instructions.md";

export function instructionsPath(): string {
  return join(instructionsDir(), INSTRUCTIONS_FILE);
}

export function instructionsCopyPath(): string {
  return join(instructionsDir(), INSTRUCTIONS_COPY);
}

/** the text of one instruction: one sentence, short enough to ride every brief of its scope */
export const TEXT_LIMIT = 200;
/** the reason: one line */
export const REASON_LIMIT = 120;
/** past this many instructions an add proposal asks the user to review the list */
export const REVIEW_THRESHOLD = 8;

export interface Instruction {
  id: string;
  /** the instruction itself: one sentence */
  text: string;
  /** why the user wants it: one line */
  reason: string;
  scope: Scope;
  created_at: string;
  updated_at: string;
}

/** a proposal the file already took in: a retry of its approval finds this and does not apply it twice */
export interface AppliedProposal {
  /** the proposal's own time, so a proposal that reuses the id after its file was lost is not taken for this one */
  proposed_at: string;
  /** the instruction the proposal made, changed or retired */
  instruction: string;
}

/** the applied proposals kept: older ones fall off, as a retry follows the failure by minutes */
const APPLIED_LIMIT = 200;

export interface InstructionsFile {
  version: 1;
  /** the number the next id takes; an id is never used twice, so a retired one is not handed out again */
  next: number;
  instructions: Instruction[];
  /** proposal id → what it did; written in the same file write as the change itself */
  applied?: Record<string, AppliedProposal>;
  /** entries of `instructions` that did not have the shape of one, as they were written: no reader applies them, a write keeps them, and the user can fix one and move it back */
  rejected?: unknown[];
}

const ID = /^INS-\d+$/;

export function isInstructionId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

const CLOSERS: Record<string, string> = { "「": "」", "『": "』", "（": "）", "(": ")", "[": "]", "［": "］", "【": "】", "〈": "〉", "《": "》", "“": "”", "‘": "’" };
const CLOSING = new Set(Object.values(CLOSERS));
const FULL_STOPS = new Set(["。", "！", "？"]);
const ASCII_STOPS = new Set([".", "!", "?"]);
const ABBREVIATION = /^(e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Fig|No)\.$/i;

/**
 * How many sentences end before the text does. A stop inside a quote or a bracket does not end the sentence that holds
 * the quote; an ASCII stop ends one only when a space follows it (`v1.2`, `3.5` are not stops) and `...` is not a stop.
 * The last sentence may leave its stop off, so only a stop with more text after it counts.
 */
function sentenceCount(text: string): number {
  const chars = [...text];
  const open: string[] = [];
  let count = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    if (c === '"') {
      if (open[open.length - 1] === '"') open.pop();
      else open.push('"');
      continue;
    }
    if (open.length) {
      if (c === open[open.length - 1]) open.pop();
      else if (CLOSERS[c]) open.push(CLOSERS[c] as string);
      continue;
    }
    if (CLOSERS[c]) { open.push(CLOSERS[c] as string); continue; }
    const full = FULL_STOPS.has(c);
    if (!full && !ASCII_STOPS.has(c)) continue;
    // a run of stops (`？！`, `?!`, `...`) is one stop, and a closer right after it belongs to it
    let j = i;
    while (j + 1 < chars.length && (FULL_STOPS.has(chars[j + 1] as string) || ASCII_STOPS.has(chars[j + 1] as string))) j += 1;
    const run = chars.slice(i, j + 1);
    const ellipsis = run.length > 1 && run.every((x) => x === ".");
    // the stop that ends a known abbreviation (`e.g.`, `etc.`) is part of the word, not the end of the sentence
    let from = i;
    while (from > 0 && !/\s/.test(chars[from - 1] as string)) from -= 1;
    const abbreviation = run.length === 1 && c === "." && ABBREVIATION.test(`${chars.slice(from, i).join("")}.`);
    while (j + 1 < chars.length && CLOSING.has(chars[j + 1] as string)) j += 1;
    const next = chars[j + 1];
    const asciiStop = !run.some((x) => FULL_STOPS.has(x));
    i = j;
    if (ellipsis || abbreviation || next === undefined) continue;
    if (asciiStop && !/\s/.test(next)) continue;
    if (chars.slice(j + 1).join("").trim()) count += 1;
  }
  return count;
}

/** the text of an instruction: one sentence on one line. Returns the trimmed text or the refusal */
export function checkText(value: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "方針の文（text）が必要です" };
  const text = value.trim();
  if (/[\r\n]/.test(text)) return { ok: false, error: "方針は 1 文で、改行を含められません" };
  if (sentenceCount(text) > 0) return { ok: false, error: "方針は 1 文です。文を分けて、別々の案にしてください" };
  if ([...text].length > TEXT_LIMIT) return { ok: false, error: `方針は ${TEXT_LIMIT} 文字までです` };
  return { ok: true, text };
}

/** the reason of an instruction: one line */
export function checkReason(value: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "理由（reason）が必要です" };
  const reason = value.trim();
  if (/[\r\n]/.test(reason)) return { ok: false, error: "理由は 1 行で、改行を含められません" };
  if ([...reason].length > REASON_LIMIT) return { ok: false, error: `理由は ${REASON_LIMIT} 文字までです` };
  return { ok: true, reason };
}

export class InstructionStoreError extends Error {}

/** what a read of one JSON file of this dir found */
export type JsonRead =
  | { state: "missing" }
  | { state: "unreadable"; reason: string }
  | { state: "broken"; reason: string }
  | { state: "ok"; value: unknown };

export function readJson(path: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch (err) {
    return { state: "broken", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** write by rename, so a reader never sees half a file */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** rename a broken file aside: its bytes survive and the next write starts from no file */
export function quarantine(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = `${path}.broken-${stamp}`;
  for (let n = 1; existsSync(dest); n += 1) dest = `${path}.broken-${stamp}-${n}`;
  renameSync(path, dest);
  return dest;
}

const warned = new Set<string>();

/** a read problem is said once per cause: a lane's brief reads the file many times a day */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`[idd instruction] ${message}\n`);
}

/** the instruction of one stored entry, or null when it is not one (the rest of the file still reads) */
function entryOf(raw: unknown): Instruction | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (!isInstructionId(e.id)) return null;
  const text = checkText(e.text);
  const reason = checkReason(e.reason);
  const scope = normalizeScope(e.scope);
  if (!text.ok || !reason.ok || !scope.ok) return null;
  const created = typeof e.created_at === "string" ? e.created_at : "";
  return { id: e.id, text: text.text, reason: reason.reason, scope: scope.scope, created_at: created, updated_at: typeof e.updated_at === "string" ? e.updated_at : created };
}

function appliedOf(raw: unknown): Record<string, AppliedProposal> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, AppliedProposal> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const e = entry as { proposed_at?: unknown; instruction?: unknown } | null;
    if (e && typeof e.proposed_at === "string" && typeof e.instruction === "string") out[id] = { proposed_at: e.proposed_at, instruction: e.instruction };
  }
  return Object.keys(out).length ? out : undefined;
}

/** note that a proposal was applied, in the file the change is being made to */
export function recordApplied(file: InstructionsFile, proposal: string, entry: AppliedProposal): void {
  const kept = Object.entries({ ...(file.applied ?? {}), [proposal]: entry });
  file.applied = Object.fromEntries(kept.slice(-APPLIED_LIMIT));
}

function parseFile(value: unknown): { file: InstructionsFile; dropped: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("最上位が表ではありません");
  const source = value as { instructions?: unknown; next?: unknown; rejected?: unknown };
  if (!Array.isArray(source.instructions)) throw new Error("instructions の一覧がありません");
  const instructions: Instruction[] = [];
  // an entry that does not read is set aside as it was written, so the write that follows does not lose it
  const rejected: unknown[] = Array.isArray(source.rejected) ? [...source.rejected] : [];
  let dropped = 0;
  for (const raw of source.instructions) {
    const entry = entryOf(raw);
    if (entry) instructions.push(entry);
    else { dropped += 1; rejected.push(raw); }
  }
  // the id a set-aside entry names is not handed out again: the user may fix it and move it back
  const idOf = (raw: unknown): number => {
    const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
    return isInstructionId(id) ? Number(id.slice(4)) : 0;
  };
  const highest = Math.max(0, ...instructions.map((i) => idOf(i)), ...rejected.map(idOf));
  const next = typeof source.next === "number" && Number.isInteger(source.next) ? Math.max(source.next, highest + 1) : highest + 1;
  const applied = appliedOf((source as { applied?: unknown }).applied);
  return { file: { version: 1, next, instructions, ...(applied ? { applied } : {}), ...(rejected.length ? { rejected } : {}) }, dropped };
}

export interface InstructionsRead {
  state: "ok" | "missing" | "unreadable" | "broken";
  file: InstructionsFile;
  reason?: string;
}

function emptyFile(): InstructionsFile {
  return { version: 1, next: 1, instructions: [] };
}

/** read the instructions. A problem reads as no instructions and is said once */
export function readInstructions(): InstructionsRead {
  const path = instructionsPath();
  const read = readJson(path);
  if (read.state === "missing") return { state: "missing", file: emptyFile() };
  if (read.state !== "ok") {
    warnOnce(`${read.state}:${read.reason}`, `${path} を読めないので、方針なしで進めます: ${read.reason}`);
    return { state: read.state, file: emptyFile(), reason: read.reason };
  }
  try {
    const { file, dropped } = parseFile(read.value);
    if (dropped) warnOnce(`dropped:${dropped}`, `${path} の ${dropped} 件は形が合わないので読み飛ばしました`);
    return { state: "ok", file };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnOnce(`broken:${reason}`, `${path} を読めないので、方針なしで進めます: ${reason}`);
    return { state: "broken", file: emptyFile(), reason };
  }
}

/** the instructions in force: none when the file cannot be read */
export function activeInstructions(): Instruction[] {
  return readInstructions().file.instructions;
}

/** the file a write may change; a file that cannot be read is never replaced by an empty one */
function loadForWrite(): InstructionsFile {
  const path = instructionsPath();
  const read = readJson(path);
  if (read.state === "missing") return emptyFile();
  if (read.state === "unreadable") throw new InstructionStoreError(`方針のファイルを読めません: ${read.reason}`);
  if (read.state === "broken") {
    const dest = quarantine(path);
    throw new InstructionStoreError(`方針のファイルが壊れていたので ${dest} に退避しました。直すか、案をもう一度承認してください`);
  }
  try {
    return parseFile(read.value).file;
  } catch (err) {
    const dest = quarantine(path);
    throw new InstructionStoreError(`方針のファイルの形が合わなかったので ${dest} に退避しました: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** the readable copy: what the file says, as text a person can check without a tool */
export function renderCopy(file: InstructionsFile): string {
  const lines = [
    "# 方針（instruction）",
    "",
    `<!-- この写しは ${INSTRUCTIONS_FILE} から作ります。直すときは写しではなく、Inbox の案から変えてください -->`,
    "",
  ];
  if (!file.instructions.length) lines.push("（方針はまだありません）", "");
  if (file.rejected?.length) lines.push(`形が合わず読み飛ばした項が ${file.rejected.length} 件あります。${INSTRUCTIONS_FILE} の rejected にそのまま残してあります。直して instructions に戻せば効きます`, "");
  for (const i of file.instructions) {
    lines.push(`## ${i.id}`, "", `- 方針: ${i.text}`, `- 理由: ${i.reason}`, `- 範囲: ${describeScope(i.scope)}`, "");
  }
  return lines.join("\n");
}

/**
 * Replace the instructions by what `change` makes of the current file, then rewrite the readable copy. The
 * canonical file lands first: a copy that fails to write is said and left, and the next write makes it again.
 */
export function writeInstructions<T>(change: (file: InstructionsFile) => T): T {
  const file = loadForWrite();
  const result = change(file);
  writeJsonAtomic(instructionsPath(), file);
  try {
    mkdirSync(instructionsDir(), { recursive: true });
    writeFileSync(instructionsCopyPath(), renderCopy(file), "utf8");
  } catch (err) {
    warnOnce(`copy:${String(err)}`, `読める写し ${instructionsCopyPath()} を書けませんでした: ${String(err)}`);
  }
  return result;
}

/** one instruction that applies somewhere, as the run or the conversation received it */
export interface Picked {
  id: string;
  text: string;
  reason: string;
  scope: Scope;
  /** how it reached this situation: the scope matched, or the user added it to this one session */
  via: "scope" | "session";
}

/** one session's own additions and exclusions (a conversation's marks) */
export interface SessionExceptions {
  add?: readonly string[];
  exclude?: readonly string[];
}

/**
 * The instructions one situation receives, in the file's order. An instruction the session excluded is out; one the
 * session added is in whatever its scope says (the user's exception, outside the scope test); every other one is in
 * only when all three ranges of its scope match.
 */
export function selectInstructions(all: readonly Instruction[], situation: Situation, session: SessionExceptions = {}): Picked[] {
  const added = new Set(session.add ?? []);
  const excluded = new Set(session.exclude ?? []);
  const out: Picked[] = [];
  for (const i of all) {
    if (excluded.has(i.id)) continue;
    const via = added.has(i.id) ? "session" : scopeMatches(i.scope, situation) ? "scope" : null;
    if (via) out.push({ id: i.id, text: i.text, reason: i.reason, scope: i.scope, via });
  }
  return out;
}

/** read the file and select for one situation */
export function pickInstructions(situation: Situation, session: SessionExceptions = {}): Picked[] {
  return selectInstructions(activeInstructions(), situation, session);
}

/**
 * The repo an Issue lane's area stands for in an instruction's scope: the GitHub `owner/name` the registry links it to.
 * An area the registry cannot be read for stands for itself, so a lane still starts.
 */
export function repoOfArea(area: string): string {
  try {
    return readAreas().areas[area]?.linked_repo ?? area;
  } catch {
    return area;
  }
}

/**
 * The instructions a lane's stage receives: the scene the stage belongs to, in a lane, for the repo. A stage with no
 * scene (an ad hoc run) receives none.
 */
export function pickForStage(stage: string | undefined, repo: string | undefined): Picked[] {
  const scene = sceneOfStage(stage);
  if (!scene) return [];
  return pickInstructions({ ...(repo ? { repo } : {}), scene, place: "lane" });
}

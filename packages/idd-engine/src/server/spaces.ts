import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConversationRefused } from "./refusal.ts";
import { clearWarn, warnOnce } from "./warn.ts";

/** how a space's memory is handled; the text the context carries is decided from this */
export type MemoryHandling = "none" | "space" | "shared";

export interface Space {
  id: string;
  /** the display name; absent means the id stands in for it */
  name?: string;
  memory: MemoryHandling;
  references: string[];
  instruction: string;
}

export interface SpaceInput {
  name?: string;
  memory?: MemoryHandling;
  references?: string[];
  instruction?: string;
}

export type SpacePatch = SpaceInput;

/** the one space id shape; the marks module keeps the same check so a stored value and a written one agree */
export const SPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function spacesDir(workspace: string): string {
  return join(workspace, "spaces");
}

export function spaceDir(workspace: string, id: string): string {
  return join(spacesDir(workspace), id);
}

export function spaceFile(workspace: string, id: string): string {
  return join(spaceDir(workspace, id), "space.md");
}

// The names a space had before the rename. They are read when the new place has nothing, and never written:
// a definition made under them moves to the new place only when its owner updates it.
function legacyDir(workspace: string, id: string): string {
  return join(workspace, "projects", id);
}

function legacyFile(workspace: string, id: string): string {
  return join(legacyDir(workspace, id), "project.md");
}

export function assertSpaceId(id: string): string {
  const trimmed = id.trim();
  if (!SPACE_ID.test(trimmed)) throw new ConversationRefused("スペースの id の形が不正です", 400);
  return trimmed;
}

/** note one space file's read problem once; a space that reads clears the scope */
function noteSpaceProblem(file: string, reason: string): void {
  warnOnce(`space:${file}`, reason, `[idd spaces] ${file}: 読めません: ${reason}`);
}

// ---- the frontmatter: a small block, read and written without a general YAML round trip so the fields
// this engine does not know survive an update untouched (another harness may have written them)

interface Frontmatter {
  front: string | null;
  body: string;
}

function splitFrontmatter(text: string): Frontmatter {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return { front: null, body: text };
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") return { front: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
  }
  return { front: null, body: text };
}

/** the line ranges of the top-level `key:` entries, so a known key can be replaced in place */
function keyRanges(front: string): { key: string; start: number; end: number }[] {
  const lines = front.split("\n");
  const out: { key: string; start: number; end: number }[] = [];
  let current: { key: string; start: number; end: number } | null = null;
  lines.forEach((line, index) => {
    const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (!match) return;
    if (current) out.push({ ...current, end: index });
    current = { key: match[1], start: index, end: lines.length };
  });
  if (current) out.push(current);
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return trimmed;
}

function formatScalar(value: string): string {
  if (value === "" || /[:#[\]{}"'\n]/.test(value) || value.trim() !== value || value.startsWith("-")) {
    return JSON.stringify(value);
  }
  return value;
}

function blockOf(front: string, key: string): string[] {
  const lines = front.split("\n");
  const range = keyRanges(front).find((entry) => entry.key === key);
  return range ? lines.slice(range.start, range.end) : [];
}

function scalarValue(front: string, key: string): string | undefined {
  const block = blockOf(front, key);
  if (!block.length) return undefined;
  const rest = block[0].slice(block[0].indexOf(":") + 1).trim();
  return rest ? unquote(rest) : undefined;
}

function listValue(front: string, key: string): string[] {
  const block = blockOf(front, key);
  if (block.length < 2) return [];
  const out: string[] = [];
  for (const line of block.slice(1)) {
    const match = /^\s*-\s*(.*)$/.exec(line);
    if (match) out.push(unquote(match[1]));
  }
  return out;
}

/** replace a known frontmatter key's block, or append it; the other keys are carried over as they were */
function setFrontValue(front: string, key: string, lines: string[]): string {
  const current = front ? front.split("\n") : [];
  const range = front ? keyRanges(front).find((entry) => entry.key === key) : undefined;
  if (range) {
    current.splice(range.start, range.end - range.start, ...lines);
  } else {
    while (current.length && !current[current.length - 1].trim()) current.pop();
    current.push(...lines);
  }
  return current.join("\n");
}

function serialize(front: string, body: string): string {
  const trimmed = front.replace(/^\n+|\n+$/g, "");
  const instruction = body.replace(/\n+$/, "");
  return `---\n${trimmed}${trimmed ? "\n" : ""}---\n${instruction ? `${instruction}\n` : ""}`;
}

/** the value `project` is what a definition made before the rename says for a space's own memory */
function normalizeMemory(value: string | undefined): MemoryHandling {
  return value === "space" || value === "project" ? "space" : value === "shared" ? "shared" : "none";
}

function toSpace(id: string, front: string | null, body: string): Space {
  const f = front ?? "";
  const name = scalarValue(f, "name");
  const memory = normalizeMemory(scalarValue(f, "memory"));
  const references = listValue(f, "references");
  return {
    id,
    ...(name ? { name } : {}),
    memory,
    references,
    instruction: body.replace(/\n+$/, ""),
  };
}

function assertInput(input: SpaceInput): void {
  if (input.memory !== undefined && !["none", "space", "shared"].includes(input.memory)) {
    throw new ConversationRefused(`memory の扱いが不正です: ${String(input.memory)}`, 400);
  }
  if (input.references !== undefined && (!Array.isArray(input.references) || input.references.some((entry) => typeof entry !== "string"))) {
    throw new ConversationRefused("参照パスは文字列の一覧にしてください", 400);
  }
}

/**
 * The file a space is read from: the new place when it has a definition, else the one the space had before the
 * rename. A new definition that is unreadable does not fall back, so the older one never shadows it.
 */
function definitionFile(workspace: string, id: string): { file: string; legacy: boolean } | null {
  const current = spaceFile(workspace, id);
  if (existsSync(current)) return { file: current, legacy: false };
  const old = legacyFile(workspace, id);
  if (existsSync(old)) return { file: old, legacy: true };
  return null;
}

export function hasSpace(workspace: string, id: string): boolean {
  try {
    return readSpace(workspace, id) !== null;
  } catch {
    return false;
  }
}

/**
 * A space's definition, or null when it is absent or unreadable. A file the engine cannot read is treated as
 * no space (and its reason is logged once), so one broken definition never fails the list or a conversation.
 * Reading never moves a file: only an update does.
 */
export function readSpace(workspace: string, id: string): Space | null {
  const safeId = assertSpaceId(id);
  const found = definitionFile(workspace, safeId);
  if (!found) { clearWarn(`space:${spaceFile(workspace, safeId)}`); return null; }
  let text: string;
  try {
    text = readFileSync(found.file, "utf8");
  } catch (err) {
    noteSpaceProblem(found.file, err instanceof Error ? err.message : String(err));
    return null;
  }
  clearWarn(`space:${found.file}`);
  const { front, body } = splitFrontmatter(text);
  return toSpace(safeId, front, body);
}

function dirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function listSpaces(workspace: string): Space[] {
  const names = new Set([...dirNames(spacesDir(workspace)), ...dirNames(join(workspace, "projects"))]);
  const out: Space[] = [];
  for (const id of [...names].sort()) {
    if (!SPACE_ID.test(id)) continue;
    const space = readSpace(workspace, id);
    if (space) out.push(space);
  }
  return out;
}

/** write a space's file: only `space.md` under `spaces/<id>/`; no memory dir and no record is made */
function writeSpace(workspace: string, id: string, front: string, body: string): void {
  mkdirSync(spaceDir(workspace, id), { recursive: true });
  writeFileSync(spaceFile(workspace, id), serialize(front, body), "utf8");
}

/** a name beside `name` in `dir` that nothing holds yet, for what cannot take its own name in the new place */
function freeAsideName(dir: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}.from-projects${n === 1 ? "" : `-${n}`}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/**
 * Fold the old dir `from` into the new dir `to`, entry by entry. What the new side lacks moves over; two dirs
 * merge inside; two files with the same bytes leave one copy. Anything else that collides (different bytes, or a
 * file against a dir) never replaces the new side: the old one moves to a free name beside it and the move is
 * logged. Nothing is left in the old dir except what `keep` names.
 */
function mergeLegacyInto(from: string, to: string, keep: string | null): void {
  mkdirSync(to, { recursive: true });
  for (const name of dirNames(from)) {
    if (name === keep) continue;
    const source = join(from, name);
    const target = join(to, name);
    if (!existsSync(target)) {
      renameSync(source, target);
      continue;
    }
    const sourceStat = lstatSync(source);
    const targetStat = lstatSync(target);
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      mergeLegacyInto(source, target, null);
      rmdirSync(source);
    } else if (sourceStat.isFile() && targetStat.isFile() && readFileSync(source).equals(readFileSync(target))) {
      rmSync(source);
    } else {
      const aside = join(to, freeAsideName(to, name));
      renameSync(source, aside);
      console.warn(`[idd spaces] ${source}: ${target} が既にあるので ${aside} に移しました`);
    }
  }
}

export function createSpace(workspace: string, id: string, input: SpaceInput = {}): Space {
  const safeId = assertSpaceId(id);
  assertInput(input);
  if (definitionFile(workspace, safeId)) throw new ConversationRefused(`スペースが既にあります: ${safeId}`, 409);
  let front = "";
  if (input.name !== undefined) front = setFrontValue(front, "name", [`name: ${formatScalar(input.name)}`]);
  if (input.memory !== undefined) front = setFrontValue(front, "memory", [`memory: ${input.memory}`]);
  if (input.references !== undefined) {
    front = setFrontValue(front, "references", input.references.length ? ["references:", ...input.references.map((entry) => `  - ${formatScalar(entry)}`)] : ["references: []"]);
  }
  writeSpace(workspace, safeId, front, input.instruction ?? "");
  return readSpace(workspace, safeId) as Space;
}

/**
 * Replace only the fields the caller sent; the frontmatter this engine does not know is left as it is. A
 * definition still in the old place is written to the new one, and what sits beside it (the memory dir) folds
 * into the new dir.
 */
export function updateSpace(workspace: string, id: string, patch: SpacePatch): Space {
  const safeId = assertSpaceId(id);
  assertInput(patch);
  const found = definitionFile(workspace, safeId);
  if (!found) throw new ConversationRefused(`スペースがありません: ${safeId}`, 404);
  let text: string;
  try {
    text = readFileSync(found.file, "utf8");
  } catch (err) {
    noteSpaceProblem(found.file, err instanceof Error ? err.message : String(err));
    throw new ConversationRefused(`スペースが読めません: ${safeId}`, 404);
  }
  const { front, body } = splitFrontmatter(text);
  let nextFront = front ?? "";
  let nextBody = body;
  // the old value for a space's own memory is spelled `project`; the new file says `space`
  if (found.legacy && scalarValue(nextFront, "memory") === "project") nextFront = setFrontValue(nextFront, "memory", ["memory: space"]);
  if (patch.name !== undefined) nextFront = setFrontValue(nextFront, "name", [`name: ${formatScalar(patch.name)}`]);
  if (patch.memory !== undefined) nextFront = setFrontValue(nextFront, "memory", [`memory: ${patch.memory}`]);
  if (patch.references !== undefined) {
    nextFront = setFrontValue(nextFront, "references", patch.references.length ? ["references:", ...patch.references.map((entry) => `  - ${formatScalar(entry)}`)] : ["references: []"]);
  }
  if (patch.instruction !== undefined) nextBody = patch.instruction;
  // the old place folds in first: if it fails, the old definition is still there and the update can run again
  if (found.legacy) mergeLegacyInto(legacyDir(workspace, safeId), spaceDir(workspace, safeId), "project.md");
  writeSpace(workspace, safeId, nextFront, nextBody);
  if (found.legacy) {
    rmSync(legacyFile(workspace, safeId), { force: true });
    rmdirSync(legacyDir(workspace, safeId));
  }
  return readSpace(workspace, safeId) as Space;
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the context tells the agent to keep a space's memory. A definition still read from the old place keeps
 * its memory dir there until an update folds it into the new one, so the agent is pointed at the dir that exists;
 * when both exist `alsoNew` says so. Nothing is created or moved.
 */
function memoryPlace(workspace: string, id: string): { dir: string; alsoNew: boolean } {
  const fresh = `spaces/${id}/memory/`;
  const found = definitionFile(workspace, id);
  if (found?.legacy && isDir(join(legacyDir(workspace, id), "memory"))) {
    return { dir: `projects/${id}/memory/`, alsoNew: isDir(join(spaceDir(workspace, id), "memory")) };
  }
  return { dir: fresh, alsoNew: false };
}

/**
 * The system-prompt appendix a space's conversation starts with. Reference paths ride as strings; the
 * engine never reads their contents. An unknown space (its dir gone) means no appendix at all.
 */
export function renderSpaceContext(workspace: string, spaceId: string): string | undefined {
  const space = readSpace(workspace, spaceId);
  if (!space) return undefined;
  const lines: string[] = [`# スペース: ${space.name ?? space.id}`, ""];
  if (space.instruction.trim()) {
    lines.push("## instruction", "", space.instruction.trim(), "");
  }
  if (space.references.length) {
    lines.push("## 参照パス", "", "以下は参照するパスである。中身は必要なときに自分で読む。");
    for (const reference of space.references) lines.push(`- ${reference}`);
    lines.push("");
  }
  if (space.memory !== "none") {
    const place = memoryPlace(workspace, space.id);
    const extra = place.alsoNew
      ? `\`spaces/${space.id}/memory/\` にも記憶がある。読むときは両方を見て、書くのは \`${place.dir}\` である。スペースの定義を更新すると \`spaces/${space.id}/memory/\` に合流する。`
      : "";
    if (space.memory === "space") {
      lines.push("## memory", "", `memory は \`${place.dir}\` に、領域と同じ形（自分の索引 \`MEMORY.md\` と 1 事実 1 ファイル）で置く。全体の索引には足さない。${extra}`.trimEnd(), "");
    } else {
      lines.push("## memory", "", `memory の本文は \`${place.dir}\` に、領域と同じ形（自分の索引 \`MEMORY.md\` と 1 事実 1 ファイル）で置く。全体の索引 \`memory/MEMORY.md\` に、\`${place.dir}MEMORY.md\` を指す領域の 1 行を足す。${extra}`.trimEnd(), "");
    }
  }
  return lines.join("\n").replace(/\n+$/, "");
}

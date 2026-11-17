import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { stateDir } from "@idd/core";

/**
 * An ephemeral branch: a pi session cut from a parent's record, kept out of the mode's own session place so
 * the existing GUI's `SessionManager.listAll()` (which reads `~/.pi/agent/sessions`) never shows it. The
 * branch's pi runs with `--session-dir <this dir>`, and a small config record (not `.jsonl`, so pi's
 * `--session-dir` discovery never reads it as a session) carries what the engine needs to open it again.
 */

/**
 * A consult branch's own mark. A consult is a parentless branch whose first context is the envelope, so it has
 * no parent session and is kept out of the conversation list like any branch. The mark is what tells the
 * opening and closing doors which card the branch belongs to and where its working copy lives.
 */
export interface ConsultMark {
  /** the card's kind; only the question card is supported today */
  kind: string;
  iddId: string;
  batchId: string;
  /** the working copy the branch runs in, so the sweeper can remove it when the branch goes */
  copyPath: string;
  /** set when the ledger says the card is done or the lane is closed; the branch is kept for the retention window */
  closedAt?: string;
}

export interface EphemeralRecord {
  sessionId: string;
  /** the parent session; absent for a consult, which has no parent */
  parentSessionId?: string;
  parentSessionFile?: string;
  /** the entry the caller asked to fork at; absent for a consult */
  at?: string;
  /** the last entry written from the parent's path (null when the branch has none) */
  lastEntryId: string | null;
  mode: string;
  role: string;
  cwd: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
  /** the space the branch was cut in; the branch has no mark of its own, so it rides on this record */
  space?: string;
  /** the workspace the space id belongs to, so the branch's context is rendered against the right spaces dir */
  spaceWorkspace?: string;
  /** the conversation type the branch was cut from; the branch has no mark, so its type rides here */
  type?: string;
  /**
   * a Claude branch: the parent session id it was forked from. Claude Code's `--resume <parent> --fork-session`
   * picks the branch's own id (reported at init), so the engine learns it rather than choosing it (C-163-13).
   */
  claudeForkOf?: string;
  /** set on a consult branch: the card it answers and the copy it runs in */
  consult?: ConsultMark;
}

export interface Entry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

/** the dir the engine keeps ephemeral branches in; created when the first branch is cut */
export function ephemeralDir(): string {
  return join(stateDir(), "pipeline", "ephemeral");
}

export function ephemeralRecordPath(sessionId: string): string {
  return join(ephemeralDir(), `${sessionId}.json`);
}

function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

export function readEphemeralRecord(sessionId: string): EphemeralRecord | null {
  if (!isSessionId(sessionId)) return null;
  try {
    const raw = JSON.parse(readFileSync(ephemeralRecordPath(sessionId), "utf8")) as EphemeralRecord & { project?: string; projectWorkspace?: string };
    if (!raw || typeof raw !== "object" || typeof raw.sessionId !== "string") return null;
    // a branch cut before the rename carries its space as `project`; it is read as the space, and the next write names it `space`
    const { project, projectWorkspace, ...rec } = raw;
    if (rec.space === undefined && typeof project === "string") {
      rec.space = project;
      if (rec.spaceWorkspace === undefined && typeof projectWorkspace === "string") rec.spaceWorkspace = projectWorkspace;
    }
    return rec;
  } catch {
    return null;
  }
}

export function listEphemeralRecords(): EphemeralRecord[] {
  let names: string[];
  try { names = readdirSync(ephemeralDir()); } catch { return []; }
  const out: EphemeralRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const rec = readEphemeralRecord(id);
    if (rec) out.push(rec);
  }
  return out;
}

export function writeEphemeralRecord(rec: EphemeralRecord): void {
  mkdirSync(ephemeralDir(), { recursive: true });
  writeFileSync(ephemeralRecordPath(rec.sessionId), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

/** the branch's own pi session file, when the branch dir holds one */
export function ephemeralSessionFile(sessionId: string): string | undefined {
  if (!isSessionId(sessionId)) return undefined;
  let names: string[];
  try { names = readdirSync(ephemeralDir()); } catch { return undefined; }
  const suffix = `_${sessionId}.jsonl`;
  const name = names.find((entry) => entry.endsWith(suffix));
  return name ? join(ephemeralDir(), name) : undefined;
}

export function removeEphemeralBranch(sessionId: string): void {
  const file = ephemeralSessionFile(sessionId);
  if (file) rmSync(file, { force: true });
  rmSync(ephemeralRecordPath(sessionId), { force: true });
}

/**
 * The asynchronous face of the helpers above, for the branch sweeper: it reads every branch in one turn
 * without holding the engine's event loop, so the sync helpers stay for the conversation doors.
 */
export async function readEphemeralRecordAsync(sessionId: string): Promise<EphemeralRecord | null> {
  if (!isSessionId(sessionId)) return null;
  try {
    const raw = JSON.parse(await readFile(ephemeralRecordPath(sessionId), "utf8")) as EphemeralRecord;
    return raw && typeof raw === "object" && typeof raw.sessionId === "string" ? raw : null;
  } catch {
    return null;
  }
}

export async function listEphemeralRecordsAsync(): Promise<EphemeralRecord[]> {
  let names: string[];
  try { names = await readdir(ephemeralDir()); } catch { return []; }
  const out: EphemeralRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = await readEphemeralRecordAsync(name.slice(0, -".json".length));
    if (rec) out.push(rec);
  }
  return out;
}

/** the branch's own pi session file, found without the sync helpers the doors use */
export async function ephemeralSessionFileNameAsync(sessionId: string): Promise<string | undefined> {
  if (!isSessionId(sessionId)) return undefined;
  let names: string[];
  try { names = await readdir(ephemeralDir()); } catch { return undefined; }
  const suffix = `_${sessionId}.jsonl`;
  const name = names.find((entry) => entry.endsWith(suffix));
  return name ? join(ephemeralDir(), name) : undefined;
}

export async function ephemeralSessionMtimeAsync(sessionId: string): Promise<number> {
  const file = await ephemeralSessionFileNameAsync(sessionId);
  if (!file) return 0;
  try { return (await stat(file)).mtimeMs; } catch { return 0; }
}

export async function removeEphemeralBranchAsync(sessionId: string): Promise<void> {
  const file = await ephemeralSessionFileNameAsync(sessionId);
  if (file) await rm(file, { force: true });
  await rm(ephemeralRecordPath(sessionId), { force: true });
}

/** how long an untouched, closed branch lives; a test shortens it through the environment */
export function ephemeralRetentionMs(): number {
  const raw = Number(process.env.IDD_EPHEMERAL_RETENTION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7 * 24 * 60 * 60 * 1000;
}

export function ephemeralSessionMtime(sessionId: string): number {
  const file = ephemeralSessionFile(sessionId);
  if (!file) return 0;
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

// ---- reading pi's record ----

export interface SessionRecord {
  header: Record<string, unknown> & { version?: number };
  entries: Entry[];
}

/**
 * Read pi's JSONL record. A write in progress can leave a half-written last line; it is skipped rather than
 * failing the read, the way the engine's own name and cost readers do. The header is the first parseable line.
 */
export function readSessionRecord(file: string): SessionRecord {
  const header: Record<string, unknown> = {};
  const entries: Entry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "session") { Object.assign(header, entry); continue; }
    entries.push(entry);
  }
  return { header, entries };
}

const ENTRY_ID = /^[A-Za-z0-9_-]+$/;

export function isEntryId(value: string): boolean {
  return ENTRY_ID.test(value);
}

/** the text of a user message, whether pi stored a plain string or content blocks */
export function userMessageText(entry: Entry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/** whether an assistant turn contains a tool call whose result would be outside the copied path */
export function assistantHasToolCall(entry: Entry): boolean {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall");
}

/** the entry ids from the root to `entry`, following `parentId` */
function pathTo(byId: Map<string, Entry>, start: string | null): Entry[] {
  const out: Entry[] = [];
  let current = start;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    out.push(entry);
    current = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  out.reverse();
  return out;
}

export interface ForkPlan {
  header: Record<string, unknown> & { version?: number };
  /** the entries to copy, root first */
  entries: Entry[];
  /** the text to answer with when the fork point was a user message */
  text?: string;
}

/**
 * What a fork at `at` copies. A user message is not copied (the caller fixes its wording and sends it in the
 * branch); an assistant turn is copied, unless it holds a tool call whose result would fall outside the path.
 * Every other entry kind is refused, and so is an id the record does not hold.
 */
export function planFork(record: SessionRecord, at: string): ForkPlan {
  const byId = new Map<string, Entry>();
  for (const entry of record.entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
  const point = byId.get(at);
  if (!point) throw new Error(`記録に ${at} がありません`);
  if (point.type !== "message") throw new Error(`枝の点にできるのは発言だけです: ${at}`);
  const role = point.message?.role;
  if (role === "user") {
    const parentId = typeof point.parentId === "string" ? point.parentId : null;
    return { header: record.header, entries: pathTo(byId, parentId), text: userMessageText(point) };
  }
  if (role === "assistant") {
    if (assistantHasToolCall(point)) throw new Error(`tool の呼び出しを含む発言では枝を切れません: ${at}`);
    return { header: record.header, entries: pathTo(byId, at) };
  }
  throw new Error(`枝の点にできるのはユーザー発言か agent の発言だけです: ${at}`);
}

/** pi's own `<timestamp>_<id>.jsonl` file name */
export function branchFileName(id: string, now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

export interface WriteBranchOptions {
  parentFile: string;
  plan: ForkPlan;
  cwd: string;
  id?: string;
  envelope?: string;
  /** a consult has no parent session, so the header carries no `parentSession` line */
  omitParent?: boolean;
  now?: Date;
}

export interface WrittenBranch {
  id: string;
  file: string;
  lastEntryId: string | null;
}

/**
 * Write the branch's record: the parent's header with a new id, the branch cwd and the parent's path, then the
 * copied entries, then the optional envelope as a hidden `custom_message`. The write happens before pi starts,
 * so a pi opened on it already has the envelope in context.
 */
export function writeBranch(options: WriteBranchOptions): WrittenBranch {
  const id = options.id ?? randomUUID();
  const now = options.now ?? new Date();
  const version = typeof options.plan.header.version === "number" ? options.plan.header.version : 3;
  const header = {
    type: "session",
    version,
    id,
    timestamp: now.toISOString(),
    cwd: options.cwd,
    ...(options.omitParent ? {} : { parentSession: options.parentFile }),
  };
  const lines = [JSON.stringify(header)];
  for (const entry of options.plan.entries) lines.push(JSON.stringify(entry));
  const lastEntryId = options.plan.entries.length
    ? (typeof options.plan.entries[options.plan.entries.length - 1].id === "string" ? options.plan.entries[options.plan.entries.length - 1].id as string : null)
    : null;
  if (options.envelope !== undefined) {
    lines.push(JSON.stringify({
      type: "custom_message",
      id: randomUUID(),
      parentId: lastEntryId,
      timestamp: now.toISOString(),
      customType: "idd.engine",
      content: options.envelope,
      display: false,
    }));
  }
  mkdirSync(ephemeralDir(), { recursive: true });
  const file = join(ephemeralDir(), branchFileName(id, now));
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { id, file, lastEntryId };
}

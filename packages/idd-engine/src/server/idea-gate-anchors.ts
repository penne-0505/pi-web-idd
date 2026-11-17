/**
 * Where each gate record first appeared in the conversation's own record: the notice the gate door left as an
 * utterance, or the `write` / `edit` call that first wrote the record's line into the document.
 *
 * The records only carry a date, so the position cannot be read from the document. The screen must not go looking
 * for the notice's wording: it has to work when penne approved by speaking, when the agent wrote the record, and
 * when the notice's wording changes. So the engine reads the conversation's branch here, once, and answers with
 * one entry id per record. Nothing here wakes pi: the record on disk is read line by line.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";

import { parseGateLine, type GateRecord } from "./idea-document.ts";
import { resolveSessionFile } from "./session-file.ts";
import { comparablePath } from "./workspace.ts";

/**
 * The message the gate door leaves in the conversation after writing a record. It is built from the record's own
 * gate, action and reason, so the same function both sends the notice and recognizes it later; the notice is never
 * matched by a copy of the wording kept somewhere else.
 */
export function gateNotice(gate: 1 | 2, action: "approve" | "redo", reason?: string): string {
  if (action === "approve") {
    return `ゲート ${gate} を承認しました。ゲート記録は記入済みです。この承認に沿って続きを進めてください。`;
  }
  return `ゲート ${gate} をやり直しにしました。ゲート記録は記入済みです。${reason ? `理由: ${reason}。` : ""}指摘に沿って詰め直してください。`;
}

interface RawEntry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  cwd?: unknown;
  message?: { role?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
}

/** the text of a user utterance, whether pi stored a plain string or text blocks */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text.trim();
}

/** one place a record could sit, in the order it appears on the branch */
interface Candidate {
  entryId: string;
  /** the utterance text when the candidate is a gate notice, null for a document write */
  notice: string | null;
  /** the new document lines a `write` / `edit` call left, trimmed */
  lines: string[];
}

/** the new document text of a `write` / `edit` call that points at the document, or null when it is not one */
function newDocumentLines(call: { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }, documentPath: string, cwd: string): string[] | null {
  if (call.type !== "toolCall" || (call.name !== "write" && call.name !== "edit")) return null;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const raw = typeof args.path === "string" ? args.path : "";
  if (!raw.trim()) return null;
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if (comparablePath(abs) !== comparablePath(documentPath)) return null;
  const out: string[] = [];
  if (call.name === "write") {
    if (typeof args.content === "string") out.push(...args.content.split("\n"));
  } else {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    for (const edit of edits) if (edit && typeof edit === "object" && typeof (edit as { newText?: unknown }).newText === "string") out.push(...(edit as { newText: string }).newText.split("\n"));
    // the older `edit` shape kept one `newText` beside the path
    if (typeof args.newText === "string") out.push(...args.newText.split("\n"));
  }
  return out.map((line) => line.trim());
}

/**
 * One entry id per gate record, in the document's own order: the entry where the record's line first appeared, or
 * null when it is not on the branch. The record's notice wins when it comes first on the branch; a record that was
 * approved by speaking has only the agent's document write. Each candidate is spent on one record, so a line that
 * was rewritten in the old shape several times still anchors at its first appearance.
 */
export async function gateEntryIds(sessionId: string, documentPath: string, fallbackCwd: string, gates: readonly GateRecord[]): Promise<(string | null)[]> {
  const empty = gates.map(() => null);
  if (!gates.length) return empty;
  const file = resolveSessionFile(sessionId);
  if (!file) return empty;

  const entries: RawEntry[] = [];
  const parentOf = new Map<string, string | null>();
  const errors = new Map<string, boolean>();
  let leafId: string | null = null;
  let cwd = fallbackCwd;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try { entry = JSON.parse(line) as RawEntry; } catch { continue; }
      if (entry.type === "session" && typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      if (typeof entry.id !== "string") continue;
      parentOf.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
      leafId = entry.id;
      entries.push(entry);
      const message = entry.message;
      if (entry.type === "message" && message?.role === "toolResult" && typeof message.toolCallId === "string") errors.set(message.toolCallId, message.isError === true);
    }
  } catch { /* a read failure keeps what was read so far, and the records without a position stay empty */ }
  finally { lines.close(); stream.destroy(); }
  if (!leafId) return empty;

  const byId = new Map<string, RawEntry>();
  for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
  const branch: RawEntry[] = [];
  const seen = new Set<string>();
  let current: string | null = leafId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    branch.push(entry);
    current = parentOf.get(current) ?? null;
  }
  branch.reverse();

  const candidates: Candidate[] = [];
  for (const entry of branch) {
    const message = entry.message;
    if (entry.type !== "message" || !message || typeof entry.id !== "string") continue;
    if (message.role === "user") {
      const text = userText(message.content);
      if (text) candidates.push({ entryId: entry.id, notice: text, lines: [] });
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      // a call the conversation refused or that failed never wrote the document
      if (typeof call.id === "string" && errors.get(call.id) === true) continue;
      const newLines = newDocumentLines(call, documentPath, cwd);
      if (!newLines) continue;
      candidates.push({ entryId: entry.id, notice: null, lines: newLines });
    }
  }

  const used = new Set<number>();
  return gates.map((record) => {
    const notice = gateNotice(record.gate, record.action, record.reason);
    const line = record.line.trim();
    for (let i = 0; i < candidates.length; i += 1) {
      if (used.has(i)) continue;
      const candidate = candidates[i];
      if (candidate.notice !== null) {
        if (candidate.notice === notice) { used.add(i); return candidate.entryId; }
        continue;
      }
      if (candidate.lines.includes(line)) { used.add(i); return candidate.entryId; }
    }
    return null;
  });
}

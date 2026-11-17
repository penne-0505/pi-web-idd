import { readFileSync, statSync } from "node:fs";

import { readModes, type SessionMode } from "@idd/lane";

import { collectSessionEntries } from "./session-index.ts";

/*
 * Full-text search over pi's own session records: the same files the conversation list reads, scanned on
 * every call. No index and no embeddings, and pi is never started. Only a mode's sessions are searched
 * (never a lane's, never an ephemeral branch), and only a person's or the assistant's own words plus the
 * session's name are matched.
 */

export interface SearchHit {
  entryId: string | null;
  role: "user" | "assistant" | "session";
  excerpt: string;
}

export interface SearchResult {
  sessionId: string;
  mode: string;
  name?: string;
  hits: SearchHit[];
  /** the session had more matching entries than the per-session cap */
  truncated: boolean;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** the scan hit the session cap and left some sessions unread */
  truncated: boolean;
  scannedSessions: number;
}

/** the most sessions returned in one answer */
const MAX_SESSIONS = 20;
/** the most hits returned for one session */
const MAX_HITS_PER_SESSION = 5;
/** how much text around a hit is shown on each side */
const EXCERPT_PAD = 60;

function readName(file: string): string | undefined {
  try {
    let name: string | undefined;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("session_info")) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; name?: unknown };
        if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) name = entry.name;
      } catch { /* a partial line */ }
    }
    return name;
  } catch {
    return undefined;
  }
}

/** the text of one message's content, taking only text blocks (never a tool call or a thinking block) */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const b = block as { type?: string; text?: unknown } | null;
    if (b && b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

function excerptAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - EXCERPT_PAD);
  const end = Math.min(text.length, at + length + EXCERPT_PAD);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/** the entries of a record that are a person's or the assistant's message, in file order */
function searchableEntries(file: string): { id: string | null; role: "user" | "assistant"; text: string }[] {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const out: { id: string | null; role: "user" | "assistant"; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; id?: unknown; message?: { role?: unknown; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(entry.message?.content);
    if (!text) continue;
    out.push({ id: typeof entry.id === "string" ? entry.id : null, role, text });
  }
  return out;
}

/**
 * Search the mode records for one literal substring, case-insensitively. Sessions are scanned newest first
 * and the per-session and overall caps are reported as `truncated` rather than silently dropping hits.
 */
export function searchConversations(query: string, opts: { mode?: string; now?: number } = {}): SearchResponse {
  const needle = query.trim().toLowerCase();
  let modes: Record<string, SessionMode> = {};
  try { modes = readModes(); } catch { modes = {}; }
  const chosen = new Set((opts.mode ? Object.values(modes).filter((m) => m.name === opts.mode) : Object.values(modes)).map((m) => m.name));

  // the same walk the conversation list reads, so a record the list shows is never missed by the search
  const files: { file: string; id: string; mode: SessionMode; mtime: number }[] = [];
  for (const entry of collectSessionEntries(modes)) {
    if (!chosen.has(entry.mode.name)) continue;
    let mtime = 0;
    try { mtime = statSync(entry.file).mtimeMs; } catch { /* keep 0 */ }
    files.push({ file: entry.file, id: entry.id, mode: entry.mode, mtime });
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const results: SearchResult[] = [];
  let scannedSessions = 0;
  let truncated = false;
  for (const { file, id, mode } of files) {
    if (results.length >= MAX_SESSIONS) { truncated = true; break; }
    scannedSessions += 1;
    const name = readName(file);
    const hits: SearchHit[] = [];
    let sessionTruncated = false;
    if (name && name.toLowerCase().includes(needle)) {
      hits.push({ entryId: null, role: "session", excerpt: name });
    }
    for (const entry of searchableEntries(file)) {
      if (hits.length >= MAX_HITS_PER_SESSION) { sessionTruncated = true; break; }
      const at = entry.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      hits.push({ entryId: entry.id, role: entry.role, excerpt: excerptAround(entry.text, at, needle.length) });
    }
    if (!hits.length) continue;
    results.push({ sessionId: id, mode: mode.name, ...(name ? { name } : {}), hits, truncated: sessionTruncated });
  }
  return { query, results, truncated, scannedSessions };
}

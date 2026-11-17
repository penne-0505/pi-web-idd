import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  isSupervisedPipelineSession, pipelineAgentDir, pipelineStateDir, readModes, readPipelineSession, resolveRole,
  type SessionMode,
} from "@idd/lane";

import { comparablePath, isWithin } from "./workspace.ts";

/**
 * The one place that decides which of pi's records belong to which mode. The conversation list and the
 * full-text search both build their session set here, so one of them cannot start reading a record the other
 * hides. A record's own header cwd is the fact; a mode is a workspace that contains it, and the deepest
 * workspace wins. When several modes share that deepest workspace, the spawn record's `mode:` slot decides,
 * and config order is the fallback for a record pi itself made.
 */

/** pi の session id として読める形か（記録のファイルの外を指させない） */
export const CONVERSATION_SESSION_ID = /^[A-Za-z0-9_.-]+$/;

export interface SessionHeader {
  id?: string;
  cwd?: string;
  timestamp?: string;
}

/** all modes, or an empty set when config cannot be read (the list still answers) */
export function safeModes(): Record<string, SessionMode> {
  try { return readModes(); } catch { return {}; }
}

/** the first line of a record, read from the file's head only (a header is one small line) */
export function readHeader(file: string): SessionHeader | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf8");
    const at = text.indexOf("\n");
    return JSON.parse(at >= 0 ? text.slice(0, at) : text) as SessionHeader;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** the session id a record carries, from its header or its pi file name */
export function sessionIdOf(file: string, header: SessionHeader | null): string {
  return header?.id ?? file.replace(/^.*_/, "").replace(/\.jsonl$/, "");
}

/** every `.jsonl` under a dir, shallow first; the sessions root holds one dir per cwd */
export function walkJsonl(root: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
      else if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: path, depth: depth + 1 });
    }
  }
  return out;
}

/** the sessions roots of the modes, one per distinct real dir: every role's place is usually one link target */
export function sessionRoots(modes: Record<string, SessionMode>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const byRole = new Map<string, string | null>();
  for (const mode of Object.values(modes)) {
    let agentDir = byRole.get(mode.role);
    if (agentDir === undefined) {
      try { agentDir = pipelineAgentDir(resolveRole(mode.role)); } catch { agentDir = null; }
      byRole.set(mode.role, agentDir);
    }
    if (!agentDir) continue;
    const root = join(agentDir, "sessions");
    const key = comparablePath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/** every record file under the modes' roots, once each even when two roles link to one place */
export function walkSessionFiles(modes: Record<string, SessionMode> = safeModes()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of sessionRoots(modes)) {
    for (const file of walkJsonl(root)) {
      const key = comparablePath(file);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

function comparableDepth(path: string): number {
  return resolve(path).split(/[/\\]/).filter(Boolean).length;
}

/** the modes whose workspace contains cwd, deepest first; equal depths keep config order */
export function candidateModes(cwd: string, modes: Record<string, SessionMode>): SessionMode[] {
  const found: { mode: SessionMode; depth: number }[] = [];
  for (const mode of Object.values(modes)) {
    if (!isWithin(mode.workspace, cwd)) continue;
    found.push({ mode, depth: comparableDepth(mode.workspace) });
  }
  found.sort((a, b) => b.depth - a.depth);
  return found.map((entry) => entry.mode);
}

/** the mode name a spawn record names, or undefined when there is no record (a pi CLI session) */
function spawnModeName(sessionId: string): string | undefined {
  if (!CONVERSATION_SESSION_ID.test(sessionId)) return undefined;
  const path = join(pipelineStateDir(), "sessions", `${sessionId}.json`);
  let stat;
  try { stat = statSync(path); } catch { return undefined; }
  const cached = spawnCache.get(sessionId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.mode;
  let mode: string | undefined;
  try {
    const rec = readPipelineSession(sessionId);
    if (rec && typeof rec.slot === "string" && rec.slot.startsWith("mode:")) {
      const name = rec.slot.slice("mode:".length);
      if (name) mode = name;
    }
  } catch { /* no record */ }
  spawnCache.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, mode });
  return mode;
}

interface SpawnCacheEntry {
  mtimeMs: number;
  size: number;
  mode: string | undefined;
}

const spawnCache = new Map<string, SpawnCacheEntry>();

/** the mode a session was spawned for, from the engine's own spawn record */
export function spawnModeForSession(sessionId: string): SessionMode | undefined {
  const name = spawnModeName(sessionId);
  if (!name) return undefined;
  return safeModes()[name];
}

/**
 * The one mode decision every door uses. The deepest workspace that contains the cwd wins; when several modes
 * share it, the spawn record's mode decides, and config order does when the record is absent or names a mode
 * outside the candidates. Nested workspaces therefore resolve to the inner mode even when the session was
 * created by an outer one.
 */
export function modeForCwd(cwd: string, modes: Record<string, SessionMode>, sessionId?: string): SessionMode | undefined {
  const candidates = candidateModes(cwd, modes);
  if (!candidates.length) return undefined;
  // the spawn record only breaks a tie at the deepest workspace: a record made by an outer mode with an inner
  // workdir still belongs to the inner mode, and the record's own cwd is what says so
  const maxDepth = comparableDepth(candidates[0].workspace);
  const deepest = candidates.filter((mode) => comparableDepth(mode.workspace) === maxDepth);
  if (deepest.length === 1) return deepest[0];
  if (sessionId) {
    const named = spawnModeName(sessionId);
    if (named) {
      const found = deepest.find((mode) => mode.name === named);
      if (found) return found;
    }
  }
  return deepest[0];
}

export interface SessionFileEntry {
  file: string;
  id: string;
  cwd: string;
  mode: SessionMode;
}

/** the session files with their mode, read synchronously: the full-text search's set, from the list's walk */
export function collectSessionEntries(modes: Record<string, SessionMode> = safeModes()): SessionFileEntry[] {
  const out: SessionFileEntry[] = [];
  for (const file of walkSessionFiles(modes)) {
    const header = readHeader(file);
    const id = sessionIdOf(file, header);
    if (!CONVERSATION_SESSION_ID.test(id)) continue;
    if (!header?.cwd) continue;
    if (isSupervisedPipelineSession(id)) continue;
    const mode = modeForCwd(header.cwd, modes, id);
    if (!mode) continue;
    out.push({ file, id, cwd: header.cwd, mode });
  }
  return out;
}

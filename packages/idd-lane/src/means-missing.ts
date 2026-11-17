import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { MissingMeansFinding, MissingMeansMarker } from "../../idd-core/src/agent/port.ts";
import { conversationLane } from "./conversation.ts";
import { laneDir, readLane } from "./runner.ts";

/**
 * The marks the harness knows with no configuration: pi's `read` handing back an image file to a model that cannot
 * see images. The words `does not support images` alone are also written in documents and in this change's own code,
 * so they are bound to the tool and to the start of its own result; a document that quotes them is no detection.
 */
export const BUILTIN_MISSING_MEANS: readonly MissingMeansMarker[] = [
  { id: "image", tool: "read", prefix: "Read image file [", note: "does not support images" },
];

/** what one record's tool call left, before it is told whose run it was and where the file sits */
interface RawMatch {
  call: string;
  tool: string;
  marker: string;
  note: string;
  /** the path text as the tool call wrote it (absolute or relative), when the call had one */
  path?: string;
}

/**
 * A file's matches are read again only when the file changed: a finished run's record never does, and the records
 * are large (a conversation's reply is 13–18MB, mostly `message_update` lines). Keyed by path, size and mtime.
 */
const fileCache = new Map<string, { size: number; mtimeMs: number; matches: RawMatch[] }>();

/** the lines of a record that can carry a tool call's name or its result, so the bulk of the file is never parsed */
function interesting(line: string): boolean {
  return line.includes('"tool_execution_start"') || line.includes('"tool_execution_end"')
    || line.includes('"tool_use"') || line.includes('"tool_result"');
}

/** the text blocks of a result content, whatever shape the harness wrote them in */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : String((c as { text?: unknown }).text ?? ""))).join("\n");
}

/** the file a tool call looked at, as the call wrote it */
function callPath(input: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["path", "file_path", "notebook_path"]) {
    const v = input?.[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** 1 文: the last non-empty line of the tool's answer, which is where these marks end */
function shortNote(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** the mark a tool's result matches, or none: the tool's own answer must start with the prefix */
function matchMarker(markers: readonly MissingMeansMarker[], tool: string, text: string): MissingMeansMarker | undefined {
  for (const m of markers) {
    if (m.tool.toLowerCase() !== tool.toLowerCase()) continue;
    if (!text.startsWith(m.prefix)) continue;
    if (m.note && !text.includes(m.note)) continue;
    return m;
  }
  return undefined;
}

/** the matches of one record file, read once and cached while the file is unchanged */
function scanFile(path: string, markers: readonly MissingMeansMarker[]): RawMatch[] {
  const key = `${path}\u0000${markers.map((m) => `${m.id}:${m.tool}:${m.prefix}:${m.note ?? ""}`).join("|")}`;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  const cached = fileCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.matches;
  const matches: RawMatch[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  // the name each tool call was made under, told from the call by its id (pi names it on the start, Claude on the use)
  const names = new Map<string, string>();
  const paths = new Map<string, string | undefined>();
  for (const line of text.split("\n")) {
    if (!line || !interesting(line)) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (ev.type === "tool_execution_start") {
      const id = ev.toolCallId;
      const name = ev.toolName;
      if (typeof id === "string" && typeof name === "string") {
        names.set(id, name);
        paths.set(id, callPath(ev.args as Record<string, unknown> | undefined));
      }
      continue;
    }
    if (ev.type === "tool_execution_end") {
      const id = ev.toolCallId;
      const name = typeof id === "string" ? names.get(id) : undefined;
      if (typeof id !== "string" || !name) continue;
      const result = ev.result as { content?: unknown } | undefined;
      const answer = contentText(result?.content);
      if (!answer) continue;
      const m = matchMarker(markers, name, answer);
      if (!m) continue;
      matches.push({ call: id, tool: name, marker: m.id, note: shortNote(answer), ...(paths.get(id) ? { path: paths.get(id)! } : {}) });
      continue;
    }
    // Claude Code: the tool use is on an assistant message, its result on the following user message
    const message = ev.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) continue;
    for (const c of message.content as Record<string, unknown>[]) {
      if (c.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string") {
        names.set(c.id, c.name);
        paths.set(c.id, callPath(c.input as Record<string, unknown> | undefined));
        continue;
      }
      if (c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
      const name = names.get(c.tool_use_id);
      if (!name) continue;
      const answer = contentText(c.content);
      if (!answer) continue;
      const m = matchMarker(markers, name, answer);
      if (!m) continue;
      matches.push({ call: c.tool_use_id, tool: name, marker: m.id, note: shortNote(answer), ...(paths.get(c.tool_use_id) ? { path: paths.get(c.tool_use_id)! } : {}) });
    }
  }
  fileCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, matches });
  return matches;
}

/** the record files of a lane: a conversation's replies, or a run's event stream */
function recordFiles(laneId: string): string[] {
  const dir = laneDir(laneId);
  const turns = join(dir, "turns");
  if (existsSync(turns)) {
    try {
      return readdirSync(turns).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(turns, f));
    } catch {
      return [];
    }
  }
  const events = join(dir, "events.jsonl");
  return existsSync(events) ? [events] : [];
}

/**
 * The file a tool call looked at as a path the repo knows: relative to the run's own work area, or nothing when the
 * call reached outside it (`/tmp`, a home directory). A run of a stage works in a copy, so its own absolute paths are
 * the copy's; making them relative to that work area turns them into the repository's paths either way.
 */
export function repoRelativePath(pathText: string, worktree: string): string | undefined {
  if (!pathText.trim()) return undefined;
  const root = resolve(worktree);
  const abs = isAbsolute(pathText) ? resolve(pathText) : resolve(root, pathText);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel;
}

export interface DetectMissingMeansOptions {
  /** a stage run's lane id, or a conversation's session id */
  ids: string[];
  /** the marks to look for next to the built-in ones (config/roles.yaml pipeline.missing_means.markers) */
  markers?: MissingMeansMarker[];
}

/**
 * What the named lanes' own records show of a tool refusing the agent the means. A stage run is named by its lane id
 * and a conversation by its session id (resolved to its lane here); an id that names neither is left alone, so a
 * record that cannot be read never stops the caller. The detections carry the run, its role, the file and the mark.
 */
export function detectMissingMeans(opts: DetectMissingMeansOptions): MissingMeansFinding[] {
  const markers = [...BUILTIN_MISSING_MEANS, ...(opts.markers ?? [])];
  const out: MissingMeansFinding[] = [];
  const seen = new Set<string>();
  for (const id of opts.ids) {
    let lane = id;
    try { lane = conversationLane(id) ?? id; } catch { /* not a conversation */ }
    if (seen.has(lane)) continue;
    seen.add(lane);
    let rec;
    try { rec = readLane(lane); } catch { continue; }
    for (const file of recordFiles(lane)) {
      for (const m of scanFile(file, markers)) {
        const path = m.path ? repoRelativePath(m.path, rec.worktree) : undefined;
        out.push({
          run: lane,
          ...(rec.role ? { role: rec.role } : {}),
          call: m.call,
          ...(path ? { path } : {}),
          marker: m.marker,
          tool: m.tool,
          note: m.note,
        });
      }
    }
  }
  return out;
}

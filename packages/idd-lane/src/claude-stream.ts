import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { laneStateDir } from "./paths.ts";

/*
 * A Claude Code stream (`claude -p --output-format stream-json`) read back as the moves a person follows:
 * the text Claude wrote, the tools it called and an error it ended on. Its thinking and the tools' results
 * are left out (the first is not for show, the second is the files themselves). The lane's brief carries the
 * callback token, which Claude puts on its curl command lines, so every line is redacted before it leaves.
 */

export interface ClaudeStreamEntry {
  kind: "text" | "tool" | "error";
  body: string;
  /** a tool call: the tool's name */
  tool?: string;
}

export interface StreamReadOptions {
  /** the lane's worktree: file paths under it are shown relative to it */
  cwd?: string;
  /** values to take out wherever they appear (the callback token) */
  secrets?: string[];
}

const TEXT_MAX = 240;
const TOOL_MAX = 160;
const HIDDEN = "…";

/**
 * The values to hide that this side can know without creating anything: the callback token, from the env or
 * the state's token file (the engine writes it; a reader never does).
 */
export function knownSecrets(): string[] {
  const out: string[] = [];
  const fromEnv = process.env.IDD_AGENT_TOKEN?.trim();
  if (fromEnv) out.push(fromEnv);
  try {
    const stored = readFileSync(join(laneStateDir(), "..", "agent-token"), "utf8").trim();
    if (stored && stored !== fromEnv) out.push(stored);
  } catch { /* no token written yet */ }
  return out;
}

/** the callback token in its brief tag and after Bearer, and any given value, wherever they appear */
export function redactSecrets(s: string, secrets: string[] = []): string {
  let out = s
    .replace(/(<token>)[^<]*(<\/token>)/g, `$1${HIDDEN}$2`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${HIDDEN}`);
  for (const v of secrets) if (v && v.length >= 6) out = out.split(v).join(HIDDEN);
  return out;
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

function shownPath(p: string, cwd?: string): string {
  if (!p || !cwd || !isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"]);

/** the one thing a tool call is about: a command, a file, a pattern */
function toolBody(name: string, input: Record<string, unknown>, cwd?: string): string {
  if (name === "Bash") return str(input.command) || str(input.description);
  if (FILE_TOOLS.has(name)) return shownPath(str(input.file_path) || str(input.notebook_path), cwd);
  if (name === "Grep") return [str(input.pattern), shownPath(str(input.path), cwd)].filter(Boolean).join(" · ");
  if (name === "Glob") return [str(input.pattern), shownPath(str(input.path), cwd)].filter(Boolean).join(" · ");
  if (name === "WebFetch") return str(input.url);
  if (name === "WebSearch") return str(input.query);
  if (name === "Task" || name === "Agent") return str(input.description);
  if (name === "TodoWrite") return Array.isArray(input.todos) ? `${input.todos.length} 件` : "";
  const raw = JSON.stringify(input);
  return raw === "{}" ? "" : raw;
}

/** the moves of one stream-json event */
export function claudeEventEntries(ev: Record<string, unknown>, opts: StreamReadOptions = {}): ClaudeStreamEntry[] {
  const clean = (s: string, max: number) => oneLine(redactSecrets(s, opts.secrets), max);
  if (ev.type === "assistant") {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    const out: ClaudeStreamEntry[] = [];
    for (const c of Array.isArray(content) ? content : []) {
      const block = c as { type?: string; text?: unknown; name?: unknown; input?: unknown };
      if (block.type === "text") {
        const body = clean(str(block.text), TEXT_MAX);
        if (body) out.push({ kind: "text", body });
      } else if (block.type === "tool_use") {
        const name = str(block.name) || "tool";
        const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
        out.push({ kind: "tool", tool: name, body: clean(toolBody(name, input, opts.cwd), TOOL_MAX) });
      }
    }
    return out;
  }
  if (ev.type === "result" && ev.is_error) {
    return [{ kind: "error", body: clean(str(ev.result) || str(ev.subtype) || "error", TEXT_MAX) }];
  }
  return [];
}

/** every move of a stream's text; a line that does not parse (the one being written) is skipped */
export function claudeStreamEntries(text: string, opts: StreamReadOptions = {}): ClaudeStreamEntry[] {
  const out: ClaudeStreamEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (ev && typeof ev === "object") out.push(...claudeEventEntries(ev, opts));
  }
  return out;
}

/** a finished reply's stream does not change, and the lane detail is read on every poll */
const cache = new Map<string, { size: number; mtime: number; key: string; read: StreamTail }>();
const CACHE_MAX = 400;
const KEEP_DEFAULT = 80;

/** the last moves of a stream and how many it had in all */
export interface StreamTail {
  entries: ClaudeStreamEntry[];
  total: number;
}

/** a stream's last `keep` moves and its total; only those are held, so a long reply does not stay in memory whole */
export function readClaudeStream(path: string, opts: StreamReadOptions & { keep?: number } = {}): StreamTail {
  const none = { entries: [], total: 0 };
  if (!existsSync(path)) return none;
  let st;
  try { st = statSync(path); } catch { return none; }
  const keep = opts.keep ?? KEEP_DEFAULT;
  const key = `${keep}\0${opts.cwd ?? ""}\0${(opts.secrets ?? []).join("\0")}`;
  const hit = cache.get(path);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.key === key) return hit.read;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return none; }
  const all = claudeStreamEntries(text, opts);
  const read = { entries: all.slice(-keep), total: all.length };
  cache.delete(path);
  cache.set(path, { size: st.size, mtime: st.mtimeMs, key, read });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return read;
}

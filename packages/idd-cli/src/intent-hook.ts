import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import {
  INTENT_LANE_ENV, INTENT_RECORD_ENV, INTENT_ROLE_ENV, INTENT_STAGE_ENV,
  decideBashRead, decideBashWrite, decideInjection, handedOver, normalizeInjectPath,
  sessionStartRows,
  type InjectChoice, type InjectEvent, type InjectRow,
} from "../../idd-core/src/intent/inject.ts";
import { parseBashCommand } from "../../idd-core/src/intent/bash.ts";
import { repoForPath } from "../../idd-lane/src/repos.ts";

/**
 * `idd intent hook`: the one place that judges what to add when an agent touches a file, and the one place that
 * writes the injection record. The pi extension and the Claude Code hook are both bridges to this verb: they
 * turn their harness's event into the JSON on standard input and add back whatever comes out. The verb ends with
 * exit code 0 and adds nothing when anything goes wrong — a failing injection must never stop a tool, and a hook
 * that returns 2 would stop it.
 *
 * One thing does stop a tool, and only one: a Claude Code Bash write into the repo tree, once per path. The
 * first time a path is written through Bash the verb answers with Claude Code's deny shape and records the
 * blocked row; the next Bash write to the same path is let through and told. The block is decided from the
 * record alone, so a record that cannot be written means no block. Read, Edit and Write never stop.
 *
 * Bash is read two ways: the post-tool event for the files a command opened, the pre-tool event for the ones it
 * writes. Both resolve their paths against the repo root found above the tool's cwd, the same root the Read and
 * Edit paths use, so one file is one path whichever route opened it.
 *
 * Three call shapes share the input:
 *   - the default (a Claude Code hook): judge, write the record, print `hookSpecificOutput.additionalContext`
 *   - `idd_mode: "plan"`: judge alone, print `{text, rows}` (the pi bridge's edit/write tool_call)
 *   - `idd_mode: "record"`: append the rows already judged, print nothing (the pi bridge's tool_result)
 */

/** how long the lookup may take before the hook gives up and adds nothing */
export const LOOKUP_TIMEOUT_MS = 3000;

/** the hook input, shaped after Claude Code's and carrying the pi bridge's own fields */
export interface HookInput {
  idd_mode?: string;
  idd_rows?: InjectRow[];
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
  source?: string;
}

interface HookEnv {
  lane?: string;
  stage?: string;
  role?: string;
  record: string;
}

function envOrNull(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** the lane, stage, role and record file the Harness handed this hook; the lane falls back to the report lane */
function hookEnv(session: string): HookEnv {
  const lane = envOrNull(INTENT_LANE_ENV) ?? envOrNull("IDD_ID");
  const stage = envOrNull(INTENT_STAGE_ENV);
  const role = envOrNull(INTENT_ROLE_ENV);
  // no record path from the Harness: a place of this run's own under the OS's temporary directory, keyed by
  // the session, so a hook process and the next one (a fresh process per tool call) read the same file
  const safe = session.replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
  const record = envOrNull(INTENT_RECORD_ENV) ?? join(tmpdir(), "idd-intent-inject", `${safe}.jsonl`);
  return { ...(lane ? { lane } : {}), ...(stage ? { stage } : {}), ...(role ? { role } : {}), record };
}

/** the input JSON: `--input <file>` for the pi bridge (pi.exec has no stdin), otherwise standard input */
function readInput(inputPath: string | undefined): HookInput | null {
  try {
    const raw = inputPath ? readFileSync(inputPath, "utf8") : readFileSync(0, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookInput) : null;
  } catch {
    return null;
  }
}

function eventOf(input: HookInput): InjectEvent | "session_start" | null {
  if (input.hook_event_name === "SessionStart") return "session_start";
  if (input.hook_event_name === "Compact") return "compact";
  const tool = (input.tool_name ?? "").toLowerCase();
  if (tool === "read") return "read";
  if (tool === "edit") return "edit";
  if (tool === "write") return "write";
  return null;
}

/** the repo root above a working directory: the nearest parent holding `.git` (a worktree's is a file), or the cwd */
function repoRootOf(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** the path a tool touched, made repo-root relative so Read, Edit, Write and Bash all name one file the same way */
function toRepoRelative(cwd: string, root: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return normalizeInjectPath(relative(root, abs));
}

function editsOf(raw: Record<string, unknown>): { oldText: string }[] {
  const out: { oldText: string }[] = [];
  if (Array.isArray(raw.edits)) {
    for (const e of raw.edits) {
      const o = e !== null && typeof e === "object" ? (e as Record<string, unknown>) : {};
      if (typeof o.oldText === "string") out.push({ oldText: o.oldText });
      else if (typeof o.old_string === "string") out.push({ oldText: o.old_string });
    }
  }
  if (typeof raw.old_string === "string") out.push({ oldText: raw.old_string });
  else if (typeof raw.oldText === "string") out.push({ oldText: raw.oldText });
  return out;
}

/** the file as it is before an edit; null when it cannot be read (the injection then takes the hit, DEC-107-6) */
function contentOf(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

/** the record's rows for this session, oldest first; a file that is not there yet is an empty history */
function readRecord(record: string): InjectRow[] {
  if (!existsSync(record)) return [];
  const out: InjectRow[] = [];
  for (const line of readFileSync(record, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as InjectRow;
      if (row && typeof row === "object" && typeof row.event === "string") out.push(row);
    } catch {
      /* a partial line from a hook that was cut short */
    }
  }
  return out;
}

function appendRows(record: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  mkdirSync(dirname(record), { recursive: true });
  appendFileSync(record, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

/** paths without repeats, empties dropped */
function unique(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

/** whether a repo-root relative path is inside the tree (an absolute or `..`-escaping path is not) */
function insideTree(path: string): boolean {
  if (!path || isAbsolute(path) || path === "..") return false;
  return !path.startsWith("../");
}

/** the place a Bash write may create anything: the scratch area has no Choices and is not the Harness's diff */
const SCRATCH = "_meta/scratch";

function isScratch(path: string): boolean {
  return path === SCRATCH || path.startsWith(`${SCRATCH}/`);
}

/**
 * The lookup answer for several paths in one call: one request carrying every `path`, so a Bash command that
 * opens five files still costs the engine one answer (the hook's own limit is per request).
 * A lane names itself and the engine resolves its area; with no lane the repo comes from the cwd, as an outside
 * call does. Anything but a readable answer is an empty list: the tool runs without the injection rather than
 * not at all.
 */
async function lookup(paths: string[], cwd: string, env: HookEnv): Promise<InjectChoice[]> {
  const url = new URL(`${agentBaseUrl()}/api/idd/intent`);
  url.searchParams.set("op", "lookup");
  if (env.lane) {
    url.searchParams.set("lane", env.lane);
  } else {
    let repo: string | undefined;
    try {
      repo = repoForPath(cwd)?.github;
    } catch {
      repo = undefined;
    }
    if (!repo) return [];
    url.searchParams.set("repo", repo);
  }
  for (const path of paths) url.searchParams.append("path", path);
  const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { ok?: boolean; choices?: unknown } | null;
  if (!data || data.ok === false || !Array.isArray(data.choices)) return [];
  return data.choices as InjectChoice[];
}

interface Judged {
  text: string | null;
  rows: InjectRow[];
}

/** the decision for one event; null when the event names nothing to judge */
async function judge(input: HookInput, env: HookEnv, cwd: string, root: string): Promise<Judged | null> {
  const event = eventOf(input);
  if (!event) return null;
  if (event === "session_start") return sessionStartRows(input.source);
  if (event === "compact") return decideInjection({ event: "compact", rows: [] });
  const raw = input.tool_input ?? {};
  const path = typeof raw.file_path === "string" ? raw.file_path : typeof raw.path === "string" ? raw.path : "";
  if (!path) return null;
  const rel = toRepoRelative(cwd, root, path);
  const choices = await lookup([rel], cwd, env);
  const content = event === "edit" ? contentOf(root, rel) : null;
  const edits = event === "edit" ? editsOf(raw) : undefined;
  return decideInjection({ event, path: rel, choices, edits, content, rows: readRecord(env.record) });
}

/** the reason a Bash write is stopped: it names the path, and the Edit / Write route that carries the notice */
function denyOutput(paths: string[]): string {
  const reason = `${paths.join("・")} は Edit / Write で書いてください。場所に付いた決まりの通知が Bash 経由では届かないためです。Edit / Write で書けない書きは、同じ命令をもう 1 度送ると通ります。`;
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`;
}

/**
 * Where a Bash command began, from where it ended. Claude Code keeps one shell, so a post-tool event reports the
 * cwd the command left behind: the end is the start moved by the command's own last `cd`. The parser names that
 * move, so stepping back that far recovers the start. When the move cannot be undone (an absolute `cd`, or one
 * with `..`), relative paths have no anchor and are left out; absolute paths never need one.
 */
function startDirOf(endCwd: string, base: string | null): string | null {
  if (base === null || isAbsolute(base)) return null;
  const segments = base.split("/").filter((s) => s && s !== ".");
  if (segments.includes("..")) return null;
  let dir = endCwd;
  for (let i = 0; i < segments.length; i += 1) dir = dirname(dir);
  return dir;
}

/**
 * A Bash command's files. The read side runs after the tool and adds the bodies, once per file, sharing the
 * body limit with Read. The write side runs before the tool: the tree's paths are stopped the first time each
 * is written through Bash, and once every path has been stopped the command is let through with its notice.
 */
async function handleBash(input: HookInput, env: HookEnv, session: string, cwd: string): Promise<number> {
  const raw = input.tool_input ?? {};
  const command = typeof raw.command === "string" ? raw.command : "";
  if (!command) return 0;
  const root = repoRootOf(cwd);
  const parsed = parseBashCommand(command);

  if ((input.hook_event_name ?? "") === "PostToolUse") {
    const start = startDirOf(cwd, parsed.base);
    const paths = unique(parsed.reads.filter((p) => isAbsolute(p) || start !== null).map((p) => toRepoRelative(start ?? cwd, root, p)).filter(insideTree));
    if (!paths.length) return 0;
    const choices = await lookup(paths, cwd, env);
    const decision = decideBashRead({ paths, choices, rows: readRecord(env.record) });
    if (decision.text === null && !decision.rows.length) return 0;
    appendRows(env.record, decision.rows.map((r) => stored(r, input, env, session)));
    if (decision.text === null) return 0;
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: decision.text },
      text: decision.text,
      rows: decision.rows,
    })}\n`);
    return 0;
  }

  const writes = unique(parsed.writes.map((p) => toRepoRelative(cwd, root, p)).filter(insideTree).filter((p) => !isScratch(p)));
  if (!writes.length) return 0;
  const state = handedOver(readRecord(env.record));
  const block = writes.filter((p) => !state.blockedPaths.has(p));
  if (block.length) {
    try {
      appendRows(env.record, block.map((path) => stored({ event: "bash-write", path, blocked: true }, input, env, session)));
    } catch {
      // the block rests on the record: if the row cannot be written the same path would be stopped every time
      return 0;
    }
    process.stdout.write(denyOutput(block));
    return 0;
  }
  const choices = await lookup(writes, cwd, env);
  const decision = decideBashWrite({ paths: writes, choices, rows: readRecord(env.record) });
  appendRows(env.record, decision.rows.map((r) => stored(r, input, env, session)));
  if (decision.text === null) return 0;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: decision.text },
    text: decision.text,
    rows: decision.rows,
  })}\n`);
  return 0;
}

/** the record row for one judged row: the harness's own fields, then the semantic row */
function stored(row: InjectRow, input: HookInput, env: HookEnv, session: string): Record<string, unknown> {
  const tool = input.tool_name?.trim();
  return {
    at: new Date().toISOString(),
    session,
    ...(env.lane ? { lane: env.lane } : {}),
    ...(env.stage ? { stage: env.stage } : {}),
    ...(env.role ? { role: env.role } : {}),
    event: row.event,
    ...(tool ? { tool } : {}),
    ...(row.path ? { path: row.path } : {}),
    ...(row.choices?.length ? { choices: row.choices } : {}),
    ...(row.blocked ? { blocked: true } : {}),
  };
}

/**
 * The verb. `inputPath` is `--input <file>` (the pi bridge), else the JSON comes on standard input. Nothing
 * here throws out: an unreadable input, an engine that does not answer, or an ill-shaped lookup all end as
 * "nothing to add" and exit code 0.
 */
export async function runIntentHook(inputPath?: string): Promise<number> {
  const input = readInput(inputPath);
  if (!input) return 0;
  const session = input.session_id?.trim() || "default";
  const env = hookEnv(session);
  try {
    if (input.idd_mode === "record") {
      const rows = Array.isArray(input.idd_rows) ? input.idd_rows : [];
      appendRows(env.record, rows.map((row) => stored(row, input, env, session)));
      return 0;
    }
    const cwd = input.cwd?.trim() || process.cwd();
    if ((input.tool_name ?? "").trim().toLowerCase() === "bash" && !input.idd_mode) {
      return await handleBash(input, env, session, cwd);
    }
    const judged = await judge(input, env, cwd, repoRootOf(cwd));
    if (!judged) return 0;
    if (input.idd_mode === "plan") {
      process.stdout.write(`${JSON.stringify({ text: judged.text, rows: judged.rows })}\n`);
      return 0;
    }
    // a Claude Code hook: nothing to add means nothing on standard output and nothing in the record
    if (judged.text === null && !judged.rows.length) return 0;
    appendRows(env.record, judged.rows.map((row) => stored(row, input, env, session)));
    if (judged.text === null) return 0;
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PostToolUse", additionalContext: judged.text },
      text: judged.text,
      rows: judged.rows,
    })}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`注入を判定できませんでした: ${err instanceof Error ? err.message : String(err)}\n`);
    return 0;
  }
}

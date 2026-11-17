import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "@idd/core";
import { agentEnv, claudeEnv, withoutHostRuntime, type RolePreset } from "@idd/lane";

import type { FoldedEvent } from "./conversation-events.ts";
import { withConversationIdentity } from "./conversation-env.ts";
import { isReadableFile } from "./memory-context.ts";
import { PiRpcCommandError, type PiRpcExit, type RpcChild, type RpcResponse } from "./pi-rpc.ts";

/*
 * A Claude Code child process in `-p --input-format stream-json --output-format stream-json`. One conversation
 * owns one child for its whole life: the stdin stays open between turns, so a stop and an interruption reach
 * the running reply (the interrupt control request) and a steer written mid-reply is read by Claude Code inside
 * that same reply. The engine never calls Claude's API directly and never takes the OAuth token out of the
 * config dir: the CLI is the only thing that talks to the subscription (Issue #165).
 *
 * `RpcChild` is pi's command vocabulary; this class translates the commands the conversation's machine issues
 * onto Claude Code's stream-json input, so `reduceConversation` stays one machine for both harnesses.
 */

export interface ClaudeRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  session_id?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown; id?: string; model?: string; [key: string]: unknown };
  event?: { type?: string; index?: number; delta?: { type?: string; text?: string; thinking?: string } };
  [key: string]: unknown;
}

export interface ClaudeRpcOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  configDir: string;
  /** the model alias the conversation starts on, so `get_state` can answer before Claude's init lands */
  model?: string;
  /** the effort the child was started with */
  effort?: string;
  /** every stdout record; the conversation folds them into its own vocabulary */
  onEvent?: (record: ClaudeRecord) => void;
  /** called once, when the process is gone (a spawn failure counts) */
  onExit?: (exit: PiRpcExit) => void;
}

const CLAUDE_TOOL_NAMES: Record<string, string[]> = {
  read: ["Read"], bash: ["Bash"], grep: ["Grep"], find: ["Glob"], ls: ["Glob"], edit: ["Edit"], write: ["Write"],
};
/** pi's thinking levels as Claude Code's `--effort` takes them */
const CLAUDE_EFFORT: Record<string, string> = { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** the dir name Claude Code gives a cwd: everything but ASCII letters, digits and `-` becomes `-` */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

/** the Claude Code record of a conversation: `<config dir>/projects/<slug>/<session id>.jsonl` */
export function claudeRecordPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

/** the engine's own title for a Claude conversation, kept outside Claude Code's record (the record is Claude Code's) */
export function claudeChatTitlePath(sessionId: string): string {
  return join(stateDir(), "pipeline", "claude-chat-titles", `${sessionId}.json`);
}

export function readClaudeChatTitle(sessionId: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(claudeChatTitlePath(sessionId), "utf8")) as { name?: unknown };
    return typeof raw?.name === "string" && raw.name ? raw.name : undefined;
  } catch {
    return undefined;
  }
}

export function writeClaudeChatTitle(sessionId: string, name: string): void {
  const path = claudeChatTitlePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
}

export function removeClaudeChatTitle(sessionId: string): void {
  try { writeFileSync(claudeChatTitlePath(sessionId), "", "utf8"); } catch { /* gone with the rest */ }
}

/** the environment a conversation's Claude Code runs with: no API credentials, no STT key, and the chat config dir */
export function claudeChatEnv(configDir: string, sessionId?: string): NodeJS.ProcessEnv {
  return withConversationIdentity(withoutHostRuntime(claudeEnv(agentEnv(process.env), configDir)), sessionId);
}

/** the args for a conversation's Claude Code; a resumed conversation keeps its record and model */
export function claudeChatArgs(role: RolePreset, sessionId: string, opts: { cwd: string; model?: string; effort?: string; resume?: boolean }, appendPrompts?: readonly string[]): string[] {
  return claudeChatBaseArgs(role, opts, opts.resume ? ["--resume", sessionId] : ["--session-id", sessionId], appendPrompts);
}

/**
 * A branch cut for a Claude conversation: `--resume <parent> --fork-session --session-id <id>` starts a new
 * independent session that carries the parent's history and uses the id the engine chose, so the branch is a
 * session of its own without moving any record (C-163-13). The real CLI accepts the id with `--fork-session`
 * (measured 2026-10-17).
 */
export function claudeChatForkArgs(role: RolePreset, parentSessionId: string, opts: { sessionId: string; cwd: string; model?: string; effort?: string }, appendPrompts?: readonly string[]): string[] {
  return claudeChatBaseArgs(role, opts, ["--resume", parentSessionId, "--fork-session", "--session-id", opts.sessionId], appendPrompts);
}

function claudeChatBaseArgs(role: RolePreset, opts: { model?: string; effort?: string }, sessionArgs: string[], appendPrompts?: readonly string[]): string[] {
  const tools = [...new Set(role.tools.flatMap((t) => CLAUDE_TOOL_NAMES[t] ?? []))];
  const model = opts.model ?? role.model;
  const effort = CLAUDE_EFFORT[opts.effort ?? role.thinking] ?? "high";
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    // a user message written to stdin is not echoed by default, so the body would show it only after a reload;
    // Claude Code re-emits it as its own `user` record, the same line it writes to the record, and the fold lands
    // it as the person's entry while the reply runs (measured 2026-10-17)
    "--replay-user-messages",
    "--verbose",
    "--model", model,
    "--effort", effort,
    "--tools", tools.length ? tools.join(",") : "",
    "--disallowedTools", "Agent,Task,WebFetch,WebSearch,NotebookEdit,SendUserMessage",
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "project",
    // the system prompt is drawn again at every request instead of being recorded on the first one: a
    // conversation reopened later reads the memory index the file holds now, not the one it had at its first
    // request (the reference's measurement of `--system-prompt-snapshot`)
    "--system-prompt-snapshot", "off",
    "--strict-mcp-config",
    "--disable-slash-commands",
    ...appendPromptArgs(appendPrompts),
    ...sessionArgs,
  ];
}

/**
 * The system-prompt appendices a conversation's Claude Code starts with. The same assembly that serves pi
 * (`memorySystemPrompts`) rides here unchanged: a value that names a readable file is handed as
 * `--append-system-prompt-file`, so Claude Code reads the file itself and the engine keeps no copy of it;
 * every other value is text. A file that exists but cannot be read is dropped, because Claude Code refuses
 * the whole launch over it and a broken index must not keep the conversation from opening.
 */
function appendPromptArgs(prompts: readonly string[] | undefined): string[] {
  const args: string[] = [];
  for (const prompt of prompts ?? []) {
    if (isReadableFile(prompt)) args.push("--append-system-prompt-file", prompt);
    else if (!existsSync(prompt)) args.push("--append-system-prompt", prompt);
  }
  return args;
}

/** a user message's content as Claude Code's stream-json input takes it (text plus image blocks) */
function userContent(text: string, images?: { data: string; mimeType: string }[]): unknown {
  if (!images?.length) return text;
  const content: unknown[] = images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }));
  if (text) content.push({ type: "text", text });
  return content;
}

export class ClaudeRpcProcess implements RpcChild {
  readonly bin: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, { command: string; resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private decoder = new TextDecoder("utf-8");
  private buffer = "";
  private seq = 0;
  private exited = false;
  private stderr = "";
  private lastExit: PiRpcExit | null = null;
  private exitWaiters: Array<(exit: PiRpcExit) => void> = [];
  private spawnWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private spawned = false;
  private spawnError: string | null = null;
  /** the model alias the conversation holds; init reports the resolved id, this keeps the name the picker uses */
  private model: string | undefined;
  private effort: string | undefined;
  /** the id Claude Code reports; a forked session's id is not the one the engine asked for */
  private resolvedSessionId: string | undefined;

  constructor(private readonly opts: ClaudeRpcOptions) {
    this.bin = opts.bin;
    this.model = opts.model;
    this.effort = opts.effort;
  }

  get pid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  get stderrTail(): string {
    return this.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  }

  /** the id Claude Code is using; a forked session reports its own, not the requested one */
  get sessionId(): string {
    return this.resolvedSessionId ?? this.opts.sessionId;
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.opts.bin, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("spawn", () => {
      this.spawned = true;
      for (const waiter of this.spawnWaiters.splice(0)) waiter.resolve();
    });
    child.on("error", (err) => {
      this.spawnError = String(err);
      for (const waiter of this.spawnWaiters.splice(0)) waiter.reject(new PiRpcCommandError("spawn", String(err)));
      this.finish({ code: null, signal: null, error: String(err) });
    });
    child.on("close", (code, signal) => this.finish({ code, signal }));
  }

  waitForExit(): Promise<PiRpcExit> {
    if (this.exited) return Promise.resolve(this.lastExit ?? { code: null, signal: null });
    return new Promise((resolve) => { this.exitWaiters.push(resolve); });
  }

  /** resolve once the OS has really started the child (a missing binary surfaces as a rejection) */
  private waitSpawn(): Promise<void> {
    if (this.spawned) return Promise.resolve();
    if (this.spawnError) return Promise.reject(new PiRpcCommandError("spawn", this.spawnError));
    return new Promise<void>((resolve, reject) => { this.spawnWaiters.push({ resolve, reject }); });
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      let line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let record: ClaudeRecord;
    try {
      record = JSON.parse(line) as ClaudeRecord;
    } catch {
      return;
    }
    if (record.type === "control_response") {
      const body = record.response as { request_id?: unknown; subtype?: unknown; response?: unknown } | undefined;
      const id = typeof body?.request_id === "string" ? body.request_id : undefined;
      const entry = id ? this.pending.get(id) : undefined;
      if (entry && id) {
        this.pending.delete(id);
        const success = body?.subtype === "success";
        entry.resolve({ success, ...(body?.response !== undefined ? { data: body.response } : {}), ...(success ? {} : { error: "control request が失敗しました" }) });
      }
      return;
    }
    // a forked session's own id lands here; the conversation re-registers under it
    if (record.type === "system" && record.subtype === "init" && typeof record.session_id === "string") {
      this.resolvedSessionId = record.session_id;
      if (typeof record.model === "string" && record.model) this.model = this.model ?? record.model;
    }
    this.opts.onEvent?.(record);
  }

  private write(payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.exited) return reject(new PiRpcCommandError("write", "claude の process が動いていません"));
      const line = `${JSON.stringify(payload)}\n`;
      try {
        this.child.stdin.write(line, (err) => (err ? reject(new PiRpcCommandError("write", String(err))) : resolve()));
      } catch (err) {
        reject(new PiRpcCommandError("write", String(err)));
      }
    });
  }

  /** one control request, resolved by its own `control_response` (correlated by request id, never by order) */
  private control(subtype: string, fields: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<RpcResponse> {
    if (!this.child || this.exited) return Promise.reject(new PiRpcCommandError(subtype, "claude の process が動いていません"));
    this.seq += 1;
    const id = `cr${this.seq}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcCommandError(subtype, "応答が待ち時間を超えました"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        command: subtype,
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.write({ type: "control_request", request_id: id, request: { subtype, ...fields } }).catch((err) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(err instanceof Error ? err : new PiRpcCommandError(subtype, String(err)));
      });
    });
  }

  /**
   * pi's command vocabulary, translated. `prompt` and `steer` both write a user message: the CLI decides whether
   * it starts a turn or is read inside the running one. `abort` and `set_model` are control requests.
   */
  async command(type: string, fields: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<RpcResponse> {
    if (!this.child || this.exited) return { success: false, error: "claude の process が動いていません" };
    switch (type) {
      case "prompt":
      case "steer": {
        const text = typeof fields.message === "string" ? fields.message : "";
        const images = Array.isArray(fields.images) ? (fields.images as { data: string; mimeType: string }[]) : undefined;
        try {
          await this.write({ type: "user", message: { role: "user", content: userContent(text, images) } });
          return { success: true, data: { disposition: "started" } };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "abort": {
        const res = await this.control("interrupt", {}, timeoutMs).catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }) as RpcResponse);
        return res;
      }
      case "set_model": {
        const model = typeof fields.model === "string" && fields.model
          ? fields.model
          : typeof fields.modelId === "string" ? fields.modelId : "";
        if (!model) return { success: false, error: "model が必要です" };
        const res = await this.control("set_model", { model }, timeoutMs).catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }) as RpcResponse);
        if (res.success) this.model = model;
        return res;
      }
      case "get_state": {
        // a fresh child has not written its init yet: readiness is the OS having started it, not a Claude record
        try { await this.waitSpawn(); } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
        return {
          success: true,
          data: {
            model: this.model ? { provider: "claude", id: this.model } : undefined,
            thinkingLevel: this.effort,
            sessionName: readClaudeChatTitle(this.sessionId),
            sessionId: this.sessionId,
          },
        };
      }
      case "get_entries": {
        const entries = readClaudeEntries(this.opts.configDir, this.opts.cwd, this.sessionId);
        return { success: true, data: entries };
      }
      case "get_session_stats":
        // Claude Code reports no context window over stream-json; the conversation shows no water mark rather than a guess
        return { success: true, data: {} };
      case "get_available_thinking_levels":
        return { success: true, data: {} };
      case "get_available_models":
        return { success: true, data: {} };
      case "set_session_name": {
        if (typeof fields.name === "string" && fields.name) writeClaudeChatTitle(this.sessionId, fields.name);
        return { success: true, data: {} };
      }
      case "get_last_assistant_text": {
        const entries = readClaudeEntries(this.opts.configDir, this.opts.cwd, this.sessionId);
        const last = [...entries.entries].reverse().find((entry) => entry.message?.role === "assistant");
        return { success: true, data: { text: textOfContent(last?.message?.content) } };
      }
      default:
        // `compact` / `fork` / `get_commands` / `get_fork_messages` have no stream-json port
        return { success: false, error: `この口は Claude の会話では使えません: ${type}` };
    }
  }

  async call<T = unknown>(type: string, fields: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const res = await this.command(type, fields, timeoutMs);
    if (!res.success) throw new PiRpcCommandError(type, res.error ?? "失敗しました");
    return res.data as T;
  }

  /** Claude Code has no extension dialogs; the conversation answers none */
  replyExtensionUi(): void { /* nothing to answer */ }

  private finish(exit: PiRpcExit): void {
    if (this.exited) return;
    this.exited = true;
    this.lastExit = exit;
    for (const [, entry] of this.pending) entry.reject(new PiRpcCommandError(entry.command, "claude の process が終わりました"));
    this.pending.clear();
    this.child = null;
    for (const waiter of this.exitWaiters) waiter(exit);
    this.exitWaiters = [];
    this.opts.onExit?.(exit);
  }

  close(graceMs = 2000): void {
    const child = this.child;
    if (!child || this.exited) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
    }, graceMs);
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (!this.child || this.exited) return;
    try { this.child.kill(signal); } catch { /* gone */ }
  }
}

// ---- reading and folding Claude Code's record ----

/** one pi-shaped entry, as the GUI's fold and the type-history reader expect it */
export interface ClaudePiEntry {
  id: string;
  parentId: string | null;
  type: "message";
  timestamp?: string;
  message: { role: string; content: unknown; timestamp?: string; toolCallId?: string; isError?: boolean; model?: string };
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const value = (block as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

function toolResultContent(content: unknown): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === "object");
  return [];
}

/** the assistant content blocks as pi's own block names */
function piBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Record<string, unknown>[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
    else if (block.type === "thinking") out.push({ type: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "", ...(typeof block.signature === "string" ? { signature: block.signature } : {}) });
    else if (block.type === "tool_use") out.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input ?? null });
  }
  return out;
}

/** Claude's own markers that are not a person's words: the interrupt note and the synthetic image note */
function isClaudeMarker(text: string): boolean {
  return /^\[Request interrupted by user/.test(text) || /^\[Image: source: /.test(text);
}

/**
 * Map one Claude Code record onto pi-shaped entries. A missing role, a sidechain (a subagent's traffic), and a
 * record kind the engine does not know contribute nothing; a tool result becomes its own entry (pi writes one
 * message per call). The shape is pi's so the GUI's fold, which reads pi's records, needs no Claude branch.
 * A live stdout record carries no `uuid` (only the file line does), so the id may be empty there; a reader that
 * needs the tree skips an entry with no id.
 */
export function mapClaudeRecord(record: ClaudeRecord, parentId: string | null = null): ClaudePiEntry[] {
  if (record.type !== "user" && record.type !== "assistant") return [];
  if (record.isSidechain === true) return [];
  const message = record.message;
  if (!message || typeof message !== "object") return [];
  const id = typeof record.uuid === "string" && record.uuid ? record.uuid : "";
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
  const role = record.type === "assistant" ? "assistant" : "user";

  if (role === "assistant") {
    const blocks = piBlocks(message.content);
    if (!blocks.length) return [];
    return [{
      id,
      parentId,
      type: "message",
      ...(timestamp ? { timestamp } : {}),
      message: { role: "assistant", content: blocks, ...(timestamp ? { timestamp } : {}), ...(typeof message.model === "string" ? { model: message.model } : {}) },
    }];
  }

  const content = message.content;
  if (typeof content === "string") {
    if (!content.trim() || isClaudeMarker(content)) return [];
    return [{ id, parentId, type: "message", ...(timestamp ? { timestamp } : {}), message: { role: "user", content, ...(timestamp ? { timestamp } : {}) } }];
  }
  if (!Array.isArray(content)) return [];
  const out: ClaudePiEntry[] = [];
  const textBlocks = piBlocks(content).filter((block) => block.type === "text");
  const text = textOfContent(textBlocks);
  if (text.trim() && !isClaudeMarker(text)) {
    out.push({ id, parentId, type: "message", ...(timestamp ? { timestamp } : {}), message: { role: "user", content: textBlocks, ...(timestamp ? { timestamp } : {}) } });
  }
  let index = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    // a distinct stamp per result: the GUI folds by role and time, and one line can carry several results
    const stamp = timestamp ? `${timestamp}#${index}` : undefined;
    index += 1;
    out.push({
      id: `${id}#${index}`,
      parentId,
      type: "message",
      ...(stamp ? { timestamp: stamp } : {}),
      message: {
        role: "toolResult",
        toolCallId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        content: toolResultContent(block.content),
        ...(block.is_error === true ? { isError: true } : {}),
        ...(stamp ? { timestamp: stamp } : {}),
      },
    });
  }
  return out;
}

const MESSAGE_LINE = /"type"\s*:\s*"(?:user|assistant)"/;

/**
 * Whether Claude Code's record holds a message yet. It is the fact that survives an engine restart, which the
 * conversation's in-memory queue counter cannot: a record with a message in it is one a person has sent to.
 * A line the engine cannot read is skipped, as everywhere else.
 */
export function claudeRecordHasMessage(file: string): boolean {
  if (!existsSync(file)) return false;
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return false; }
  for (const line of raw.split("\n")) {
    if (!line.trim() || !MESSAGE_LINE.test(line)) continue;
    try {
      const record = JSON.parse(line) as ClaudeRecord;
      if ((record.type === "user" || record.type === "assistant") && record.message && typeof record.message === "object") return true;
    } catch { /* the next line */ }
  }
  return false;
}

/**
 * The whole record as pi-shaped entries, in file order. The record's own uuid tree is not walked: a person's
 * conversation is read as the order Claude Code wrote it, and a line the engine cannot read is skipped rather
 * than failing the read (C-163-4). Consecutive assistant lines of one API message are joined into one entry, so
 * the fold does not see the same message twice.
 */
export function readClaudeEntries(configDir: string, cwd: string, sessionId: string): { entries: ClaudePiEntry[]; leafId: string | null } {
  const file = claudeRecordPath(configDir, cwd, sessionId);
  if (!existsSync(file)) return { entries: [], leafId: null };
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return { entries: [], leafId: null }; }
  const entries: ClaudePiEntry[] = [];
  let previousMessageId: string | undefined;
  let previous: ClaudePiEntry | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: ClaudeRecord;
    try { record = JSON.parse(line) as ClaudeRecord; } catch { continue; }
    const messageId = typeof record.message?.id === "string" ? record.message.id : undefined;
    const mapped = mapClaudeRecord(record, previous?.id ?? null).filter((entry) => entry.id);
    if (!mapped.length) continue;
    // one API message arrives as several assistant lines (thinking, text, each tool call); join them
    if (record.type === "assistant" && messageId && messageId === previousMessageId && previous) {
      const content = Array.isArray(previous.message.content) ? previous.message.content : [];
      previous.message.content = [...content, ...(mapped[0].message.content as unknown[])];
      previousMessageId = messageId;
      continue;
    }
    if (previous) previous.parentId = previous.parentId;
    if (previous) previous.parentId = previous.parentId;
    for (const entry of mapped) {
      entry.parentId = previous?.id ?? null;
      entries.push(entry);
      previous = entry;
    }
    previousMessageId = messageId;
  }
  return { entries, leafId: entries.length ? entries[entries.length - 1].id : null };
}

/**
 * Fold one live Claude Code record into the engine's events. pi's fold is the same shape so the conversation's
 * stream handling stays one path: text and thinking deltas grow the turn, a committed message lands as an
 * `entry`, and the turn's end comes from `result` (handled by the conversation, which knows the run's state).
 */
export function foldClaudeEvent(record: ClaudeRecord): FoldedEvent[] {
  switch (record.type) {
    case "system":
      return record.subtype === "init" ? [{ kind: "run_start", fields: {} }] : [];
    case "stream_event": {
      const event = record.event;
      if (!event) return [];
      const contentIndex = typeof event.index === "number" ? event.index : undefined;
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        return [{ kind: "text", fields: { delta: event.delta.text, ...(contentIndex !== undefined ? { contentIndex } : {}) } }];
      }
      if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
        return [{ kind: "thinking", fields: { delta: event.delta.thinking, ...(contentIndex !== undefined ? { contentIndex } : {}) } }];
      }
      return [];
    }
    case "assistant":
    case "user": {
      const out: FoldedEvent[] = [];
      for (const entry of mapClaudeRecord(record)) {
        out.push({ kind: "entry", fields: { role: entry.message.role, message: entry.message } });
      }
      return out;
    }
    default:
      return [];
  }
}

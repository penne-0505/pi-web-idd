import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { piSessionDir, pipelineAgentDir, readPipelineSession, recordPipelineSession, resolveRole } from "@idd/lane";

import { ephemeralSessionFile } from "../src/server/ephemeral.ts";
import { openConversations } from "../src/server/conversations.ts";
import { createFetchHandler } from "../src/server.ts";

/*
 * A stand-in for `claude -p --input-format stream-json --output-format stream-json`. It keeps stdin open between
 * turns, writes its record under `<CLAUDE_CONFIG_DIR>/projects/<slug>/<id>.jsonl`, answers `control_request`
 * with `control_response`, and forks a new session for `--resume <id> --fork-session`. Its shapes follow the
 * measurements in `_docs/reference/pi-web-idd/idd-163/reference.md`.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const log = process.env.FAKE_CLAUDE_LOG;
const rec = (o) => fs.appendFileSync(log, JSON.stringify({ ...o, at: Date.now() }) + "\\n");
const cfg = process.env.CLAUDE_CONFIG_DIR;
const cwd = process.cwd();
const slug = cwd.replace(/[^A-Za-z0-9-]/g, "-");
const dir = path.join(cfg, "projects", slug);
fs.mkdirSync(dir, { recursive: true });
const resumeId = at("--resume");
const forking = args.includes("--fork-session");
let sessionId = at("--session-id") || (forking ? (process.env.FAKE_CLAUDE_FORK_ID || crypto.randomUUID()) : (resumeId || crypto.randomUUID()));
const file = path.join(dir, sessionId + ".jsonl");
// a fork carries the parent's history into the branch's own record
const parentFile = resumeId ? path.join(dir, resumeId + ".jsonl") : null;
if (forking && parentFile && fs.existsSync(parentFile)) fs.copyFileSync(parentFile, file);
fs.appendFileSync(log + ".starts", JSON.stringify({
  session: sessionId, resume: resumeId, forking, argv: args.join(" "), argvList: args, cwd,
  configDir: cfg, anthropicKey: process.env.ANTHROPIC_API_KEY || null, sttKey: process.env.GEMINI_API_KEY || null,
  nested: process.env.CLAUDECODE || null, autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || null,
  iddId: process.env.IDD_ID || null, iddSession: process.env.IDD_SESSION_ID || null,
  pid: process.pid,
}) + "\\n");
let seq = 0;
const uuid = () => { seq += 1; return "e" + seq + "-0000-4000-8000-000000000000"; };
const writeLine = (o) => fs.appendFileSync(file, JSON.stringify(o) + "\\n");
let parentUuid = null;
let currentModel = at("--model") || "opus";
if (fs.existsSync(file)) for (const l of fs.readFileSync(file, "utf8").split("\\n")) {
  if (!l.trim()) continue;
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.uuid) parentUuid = e.uuid;
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const emitInit = () => out({ type: "system", subtype: "init", session_id: sessionId, cwd, model: currentModel, tools: at("--tools"), permissionMode: "bypassPermissions" });
let running = false;
let heldTurns = 0;
const text = process.env.FAKE_CLAUDE_TEXT || "answered";
const usage = () => ({ input_tokens: 10, output_tokens: 5 });
const finishTurn = (isError) => {
  out({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: Boolean(isError), session_id: sessionId, result: isError ? "" : text, total_cost_usd: Number(process.env.FAKE_CLAUDE_COST || "0.2"), usage: usage() });
  running = false;
};
const emitTurn = (content) => {
  running = true;
  const uUuid = uuid();
  writeLine({ parentUuid, type: "user", message: { role: "user", content }, uuid: uUuid, timestamp: new Date().toISOString(), sessionId });
  parentUuid = uUuid;
  emitInit();
  out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } });
  out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } } });
  const assistant = [{ type: "text", text }];
  if (process.env.FAKE_CLAUDE_TOOL === "1") assistant.push({ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } });
  out({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: assistant, id: "msg_1", model: currentModel, usage: usage() } });
  const aUuid = uuid();
  writeLine({ parentUuid, type: "assistant", message: { role: "assistant", content: assistant, id: "msg_1", model: currentModel, usage: usage() }, uuid: aUuid, timestamp: new Date().toISOString(), sessionId });
  parentUuid = aUuid;
  if (process.env.FAKE_CLAUDE_TOOL === "1") {
    const rBlocks = [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }];
    out({ type: "user", session_id: sessionId, message: { role: "user", content: rBlocks } });
    const rUuid = uuid();
    writeLine({ parentUuid, type: "user", message: { role: "user", content: rBlocks }, uuid: rUuid, timestamp: new Date().toISOString(), sessionId });
    parentUuid = rUuid;
  }
  const hold = Number(process.env.FAKE_CLAUDE_HOLD_MS || "0");
  if (hold > 0) setTimeout(() => finishTurn(false), hold); else finishTurn(false);
};
const respond = (requestId, ok, body) => out({ type: "control_response", response: { subtype: ok ? "success" : "error", request_id: requestId, response: body || {} } });
const handleUser = (content) => {
  // the acknowledgment the engine's --replay-user-messages turns on: the message comes back as Claude Code's own user record
  if (args.includes("--replay-user-messages")) out({ type: "user", session_id: sessionId, isReplay: true, message: { role: "user", content } });
  if (running) {
    heldTurns += 1;
    const uUuid = uuid();
    writeLine({ parentUuid, type: "user", message: { role: "user", content }, uuid: uUuid, timestamp: new Date().toISOString(), sessionId });
    parentUuid = uUuid;
    rec({ cmd: "steer", content });
    return;
  }
  rec({ cmd: "prompt", content });
  emitTurn(content);
};
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (;;) {
    const i = buf.indexOf("\\n");
    if (i < 0) break;
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd.type === "user") { handleUser(cmd.message && cmd.message.content); continue; }
    if (cmd.type === "control_request") {
      const subtype = cmd.request && cmd.request.subtype;
      if (subtype === "interrupt") {
        rec({ cmd: "interrupt" });
        if (running) {
          out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } } });
          writeLine({ parentUuid, type: "user", message: { role: "user", content: "[Request interrupted by user]" }, uuid: uuid(), timestamp: new Date().toISOString(), sessionId });
          finishTurn(true);
        }
        respond(cmd.request_id, true, { still_queued: [] });
        continue;
      }
      if (subtype === "set_model") { currentModel = cmd.request.model; rec({ cmd: "set_model", model: cmd.request.model }); respond(cmd.request_id, true, {}); continue; }
      respond(cmd.request_id, false, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** the smallest pi that answers a readiness round trip, so a pre-send harness switch can be observed */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const log = process.env.FAKE_PI_LOG;
if (args.includes("--list-models")) { process.stdout.write("openrouter z-ai/glm-5.3\\n"); process.exit(0); }
if (args.includes("-p") || args.includes("--print")) { process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "t" }] } }) + "\\n"); process.exit(0); }
const sessionId = at("--session-id");
fs.appendFileSync(log + ".starts", JSON.stringify({ session: sessionId, argv: args.join(" "), argvList: args, cwd: process.cwd(), pid: process.pid }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const respond = (id, command, success, data) => out({ id, type: "response", command, success, ...(data !== undefined ? { data } : {}) });
let model = at("--model") || "openrouter/z-ai/glm-5.3";
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (;;) {
    const i = buf.indexOf("\\n");
    if (i < 0) break;
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd.type === "get_state") respond(cmd.id, "get_state", true, { model: model ? { provider: model.split("/")[0], id: model.split("/").slice(1).join("/") } : undefined, thinkingLevel: at("--thinking"), sessionId });
    else if (cmd.type === "get_entries") respond(cmd.id, "get_entries", true, { entries: [], leafId: null });
    else if (cmd.type === "get_available_models") respond(cmd.id, "get_available_models", true, { models: [{ provider: "openrouter", id: "z-ai/glm-5.3", input: ["text"] }] });
    else if (cmd.type === "get_available_thinking_levels") respond(cmd.id, "get_available_thinking_levels", true, { levels: ["high"] });
    else if (cmd.type === "get_session_stats") respond(cmd.id, "get_session_stats", true, { contextUsage: null });
    else if (cmd.type === "prompt") respond(cmd.id, "prompt", true, { disposition: "handled" });
    else if (cmd.type === "set_model") { model = String(cmd.provider) + "/" + String(cmd.modelId); respond(cmd.id, "set_model", true, {}); }
    else respond(cmd.id, cmd.type, true, {});
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const ENV = [
  "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_MODES_FILE", "IDD_REPOS_FILE", "IDD_CLAUDE_BIN", "IDD_CLAUDE_CHAT_CONFIG_DIR",
  "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_CONVERSATION_IDLE_MS", "IDD_EPHEMERAL_RETENTION_MS", "IDD_PROMOTE_EXIT_TIMEOUT_MS",
  "IDD_CLOSE_EXIT_TIMEOUT_MS", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_TEXT", "FAKE_CLAUDE_TOOL", "FAKE_CLAUDE_HOLD_MS", "FAKE_CLAUDE_COST",
  "FAKE_CLAUDE_FORK_ID", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FAKE_PI_LOG", "IDD_INSTRUCTIONS_DIR", "IDD_ID",
] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(async () => {
  for (const conv of openConversations()) await conv.close();
  await new Promise((r) => setTimeout(r, 60));
  for (const key of ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fx {
  root: string; state: string; cwd: string; configDir: string; fake: string; log: string;
  handler: (req: Request) => Promise<Response>;
}

function fixture(opts: { login?: boolean; types?: boolean } = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), "idd-claude-"));
  roots.push(root);
  const state = join(root, "state");
  const cwd = join(root, "chat");
  const configDir = join(root, "claude-chat");
  const userAgent = join(root, "user-agent");
  for (const d of [state, cwd, configDir, userAgent]) mkdirSync(d, { recursive: true });
  if (opts.login !== false) writeFileSync(join(configDir, ".credentials.json"), "{}\n");
  const fake = join(root, "claude");
  writeFileSync(fake, FAKE_CLAUDE);
  chmodSync(fake, 0o755);
  const fakePi = join(root, "pi");
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  writeFileSync(join(root, "roles.yaml"), [
    "defaults:",
    `  claude_chat_config_dir: ${configDir}`,
    "models:",
    "  openrouter-z-ai-glm-5.3:",
    "    model: openrouter/z-ai/glm-5.3",
    "  openrouter-z-ai-glm-5.3-flash:",
    "    model: openrouter/z-ai/glm-5.3-flash",
    "roles:",
    "  chat-claude: { harness: claude, fallback: chat, model: opus, thinking: high, tools: [read, bash, edit, write] }",
    "  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read, bash, edit, write] }",
    "  titler: { model: openrouter-z-ai-glm-5.3-flash, thinking: low, tools: [read] }",
  ].join("\n") + "\n");
  writeFileSync(join(root, "modes.yaml"), opts.types
    ? `modes:\n  chat: { role: chat-claude, workspace: ${cwd}, types: { chat: { label: チャット } } }\n`
    : `modes:\n  chat: { role: chat-claude, workspace: ${cwd} }\n`);
  writeFileSync(join(root, "repos.yaml"), "repos: {}\n");
  for (const key of ENV) delete process.env[key];
  Object.assign(process.env, {
    IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_MODES_FILE: join(root, "modes.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_CLAUDE_BIN: fake, IDD_CLAUDE_CHAT_CONFIG_DIR: configDir, IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: userAgent,
    FAKE_CLAUDE_LOG: join(root, "claude.log"), FAKE_PI_LOG: join(root, "pi.log"),
  });
  return { root, state, cwd, configDir, fake, log: join(root, "claude.log"), handler: createFetchHandler() };
}

function api(fx: Fx, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", host: "127.0.0.1:30144" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fx.handler(new Request(`http://127.0.0.1:30144${path}`, init));
}
async function json<T = Record<string, unknown>>(res: Response): Promise<T> { return await res.json() as T; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) { if (Date.now() > deadline) throw new Error("timed out"); await sleep(20); }
}
const lines = (file: string): Record<string, unknown>[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const commands = (fx: Fx): Record<string, unknown>[] => lines(fx.log);
const starts = (fx: Fx): Record<string, unknown>[] => lines(`${fx.log}.starts`);
/** the values a start carried after one flag, in order */
const flagValues = (start: Record<string, unknown>, flag: string): string[] => {
  const list = (start.argvList ?? []) as string[];
  return list.flatMap((value, at) => (value === flag ? [list[at + 1]] : []));
};
/** the values after one flag without the appendix every conversation carries about the user's instructions (the tests below read the other appendices) */
const ownFlagValues = (start: Record<string, unknown>, flag: string): string[] => flagValues(start, flag).filter((value) => !value.includes("instruction propose"));
/** a start's argument list without that appendix */
const ownArgs = (start: Record<string, unknown>): string[] => {
  const list = [...((start.argvList ?? []) as string[])];
  const at = list.findIndex((value, k) => list[k - 1] === "--append-system-prompt" && value.includes("instruction propose"));
  if (at > 0) list.splice(at - 1, 2);
  return list;
};
const piStarts = (fx: Fx): Record<string, unknown>[] => lines(join(fx.root, "pi.log.starts"));
const recordPath = (fx: Fx, id: string, cwd = fx.cwd): string => join(fx.configDir, "projects", cwd.replace(/[^A-Za-z0-9-]/g, "-"), `${id}.jsonl`);
/** the text a `user` / `assistant` body carries, whether it is a string or pi's block list */
const textOfMessage = (message: unknown): string => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("");
};

class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buf = "";
  constructor(res: Response) { this.reader = (res.body as ReadableStream<Uint8Array>).getReader(); }
  private async next(timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.buf.indexOf("\n\n");
      if (at >= 0) {
        const chunk = this.buf.slice(0, at); this.buf = this.buf.slice(at + 2);
        for (const line of chunk.split("\n")) if (line.startsWith("data: ")) return JSON.parse(line.slice(6)) as Record<string, unknown>;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out reading SSE");
      const result = await Promise.race([this.reader.read(), new Promise<null>((r) => { const t = setTimeout(() => r(null), remaining); t.unref?.(); })]);
      if (result === null) throw new Error("timed out reading SSE");
      if (result.done) throw new Error("SSE closed");
      this.buf += this.decoder.decode(result.value, { stream: true });
    }
  }
  async until(pred: (e: Record<string, unknown>) => boolean, ms = 10_000): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (;;) {
      const event = await this.next(ms);
      out.push(event);
      if (pred(event)) return out;
    }
  }
}

async function create(fx: Fx): Promise<{ id: string; model?: string }> {
  const res = await api(fx, "POST", "/api/conversations", { mode: "chat" });
  const body = await json<{ id: string; model?: string }>(res);
  if (!body.id) throw new Error(`create failed: ${JSON.stringify(body)}`);
  return body;
}

describe("a Claude conversation", () => {
  test("AC-001 / AC-006: New chat starts Claude, is listed with marks, and pi is a pre-send choice", async () => {
    const fx = fixture();
    const created = await create(fx);
    expect(created.model).toBe("opus");
    await until(() => starts(fx).length > 0);
    // the child runs in the conversation's own config dir, with no API credentials and no STT key, and reads CLAUDE.md
    const start = starts(fx)[0];
    expect(start.configDir).toBe(fx.configDir);
    expect(start.anthropicKey).toBeNull();
    expect(start.sttKey).toBeNull();
    expect(start.autoMemory).toBe("1");
    expect(String(start.argv)).toContain("--setting-sources project");
    expect(String(start.argv)).toContain("--permission-mode bypassPermissions");
    // the list shows it with its mode, and a mark lands in the workspace's one file
    const list = await json<{ conversations: { id: string; mode: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations.find((c) => c.id === created.id)?.mode).toBe("chat");
    await api(fx, "PATCH", `/api/conversations/${created.id}/marks`, { pinned: true });
    const marked = await json<{ conversations: { id: string; pinned: boolean }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(marked.conversations.find((c) => c.id === created.id)?.pinned).toBe(true);
    // a type switch is refused for a Claude conversation
    const refused = await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "chat" });
    expect(refused.status).toBe(409);
    // before the first message the model list carries both harnesses, and the Claude models carry image
    const models = await json<{ models: { id: string; provider: string; capabilities: string[] }[] }>(await api(fx, "GET", `/api/conversations/${created.id}/models`));
    const ids = models.models.map((m) => m.id);
    expect(ids).toContain("opus");
    expect(ids).toContain("openrouter/z-ai/glm-5.3");
    expect(models.models.find((m) => m.id === "opus")?.capabilities).toContain("image");
    // choosing a pi model switches the harness; the conversation keeps its id
    const switched = await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.3" });
    expect(switched.status).toBe(200);
    await until(() => piStarts(fx).length > 0);
    const after = await json<{ models: { id: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}/models`));
    expect(after.models.map((m) => m.id)).not.toContain("opus");
  });

  test("AC-006: a config dir with no login refuses the create with the login steps", async () => {
    const fx = fixture({ login: false });
    const res = await api(fx, "POST", "/api/conversations", { mode: "chat" });
    expect(res.status).toBe(409);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain("ログイン");
    expect(starts(fx).length).toBe(0);
  });

  test("AC-002: the reply streams and reopening reads Claude Code's record unchanged", async () => {
    const fx = fixture();
    process.env.FAKE_CLAUDE_TOOL = "1";
    const created = await create(fx);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    const events = await reader.until((e) => e.type === "end");
    const kinds = new Set(events.map((e) => e.type));
    for (const kind of ["text", "thinking", "entry", "cost", "end"]) expect(kinds.has(kind), kind).toBe(true);
    const file = recordPath(fx, created.id);
    await until(() => existsSync(file));
    const before = readFileSync(file, "utf8");
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    // a broken line and an unknown kind are skipped, never failing the read
    writeFileSync(file, `${before}{ this is not json\n${JSON.stringify({ type: "queue-operation", uuid: "q-1" })}\n`);
    const opened = await json<{ entries: { id: string; type: string; message: { role: string } }[]; leafId: string }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    const roles = opened.entries.map((e) => e.message.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("toolResult");
    expect(opened.leafId).toBeTruthy();
    const assistant = opened.entries.find((e) => e.message.role === "assistant") as { message: { content: { type: string }[] } };
    expect(assistant.message.content.some((block) => block.type === "toolCall")).toBe(true);
    // the engine never writes into Claude Code's record: only the broken lines the test added differ
    const after = readFileSync(file, "utf8");
    expect(after.endsWith(before.slice(-1)) || after.length >= before.length).toBe(true);
    expect(after.startsWith(before)).toBe(true);
  });

  test("AC-003: queued items are editable and cancelable, a steer reaches the running reply, and a stop keeps the process", async () => {
    const fx = fixture();
    process.env.FAKE_CLAUDE_HOLD_MS = "3000";
    const created = await create(fx);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "first" });
    await until(() => commands(fx).some((c) => c.cmd === "prompt"));
    // two messages while the reply runs stay in the engine's queue, and neither reaches the child
    const a = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "second" }));
    const b = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "third" }));
    await json(await api(fx, "PATCH", `/api/conversations/${created.id}/queue/${a.item.id}`, { text: "second-edited" }));
    await json(await api(fx, "DELETE", `/api/conversations/${created.id}/queue/${b.item.id}`));
    expect(commands(fx).filter((c) => c.cmd === "prompt").length).toBe(1);
    // a steer goes to the running reply now
    await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "wait" });
    await until(() => commands(fx).some((c) => c.cmd === "steer"));
    expect(commands(fx).find((c) => c.cmd === "steer")?.content).toBe("wait");
    // stop reaches the child as an interrupt control request, and the process stays for the next message
    const stopped = await json<{ stopped: boolean }>(await api(fx, "POST", `/api/conversations/${created.id}/stop`));
    expect(stopped.stopped).toBe(true);
    await until(() => commands(fx).some((c) => c.cmd === "interrupt"));
    await until(() => starts(fx).length === 1);
    // the conversation continues on the same process
    process.env.FAKE_CLAUDE_HOLD_MS = "0";
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "again" });
    await until(() => commands(fx).filter((c) => c.cmd === "prompt").length >= 2);
    expect(starts(fx).length).toBe(1);
  });

  test("AC-004: an image rides the sent message to the child", async () => {
    const fx = fixture();
    const created = await create(fx);
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "look", images: [{ data, mimeType: "image/png" }] });
    await until(() => commands(fx).some((c) => c.cmd === "prompt"));
    const content = commands(fx).find((c) => c.cmd === "prompt")?.content as { type: string; source?: { data?: string } }[];
    expect(Array.isArray(content)).toBe(true);
    const image = content.find((block) => block.type === "image");
    expect(image?.source?.data).toBe(data);
  });

  test("AC-005: a branch leaves the parent's record alone, and promoting makes it a listed conversation", async () => {
    const fx = fixture();
    const created = await create(fx);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    await reader.until((e) => e.type === "end");
    await until(() => existsSync(recordPath(fx, created.id)));
    const parentBefore = readFileSync(recordPath(fx, created.id), "utf8");
    const opened = await json<{ entries: { id: string; message: { role: string } }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    const at = opened.entries.find((e) => e.message.role === "assistant")?.id as string;
    const branch = await json<{ id: string; parent: string }>(await api(fx, "POST", `/api/conversations/${created.id}/ephemeral`, { at }));
    expect(branch.id).not.toBe(created.id);
    expect(branch.parent).toBe(created.id);
    // the branch carries the parent's history and is not in the list, and the parent's record is untouched
    await until(() => existsSync(recordPath(fx, branch.id)));
    expect(readFileSync(recordPath(fx, branch.id), "utf8").startsWith(parentBefore)).toBe(true);
    const list = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations.map((c) => c.id)).not.toContain(branch.id);
    expect(readFileSync(recordPath(fx, created.id), "utf8")).toBe(parentBefore);
    // promote makes it a conversation of its own, under the same id
    const promoted = await json<{ id: string }>(await api(fx, "POST", `/api/conversations/${branch.id}/promote`, { mode: "chat" }));
    expect(promoted.id).toBe(branch.id);
    const list2 = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list2.conversations.map((c) => c.id)).toContain(branch.id);
    // deleting the promoted conversation removes its record
    await api(fx, "DELETE", `/api/conversations/${branch.id}`);
    await until(() => !existsSync(recordPath(fx, branch.id)));
    expect(existsSync(recordPath(fx, branch.id))).toBe(false);
  });

  test("3-final/F-1: promoting a pi branch under a Claude mode keeps its pi record and role", async () => {
    const fx = fixture();
    const parentId = "11111111-2222-4333-8444-555555555555";
    // a pi parent: the mode's role is Claude, but this session ran the pi role, so its record lives in the
    // pi role's agent dir and its spawn record names that role
    const piRole = resolveRole("chat");
    const piAgent = pipelineAgentDir(piRole);
    const dir = piSessionDir(fx.cwd, piAgent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-02-01T00-00-00-000Z_${parentId}.jsonl`), [
      JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: "2026-02-01T00:00:00.000Z", cwd: fx.cwd }),
      JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "one" }], stopReason: "stop" } }),
    ].join("\n") + "\n");
    recordPipelineSession(parentId, { slot: "mode:chat", role: piRole.name, model: piRole.model, agentDir: piAgent, thinkingLevel: "high", cwd: fx.cwd });

    const branch = await json<{ id: string; role: string }>(await api(fx, "POST", `/api/conversations/${parentId}/ephemeral`, { at: "a1" }));
    expect(branch.role).toBe("chat");
    await until(() => ephemeralSessionFile(branch.id) !== undefined);
    const from = ephemeralSessionFile(branch.id) as string;

    const promoted = await json<{ id: string; role: string; sessionFile: string }>(await api(fx, "POST", `/api/conversations/${branch.id}/promote`, { mode: "chat" }));
    expect(promoted.id).toBe(branch.id);
    expect(promoted.role).toBe("chat");
    // the record moved under the pi role's agent dir; the mode's Claude role has an empty agent dir, which
    // would have moved it into a relative sessions/ and lost it on the next open
    expect(promoted.sessionFile).toBe(join(dir, basename(from)));
    expect(existsSync(promoted.sessionFile)).toBe(true);
    expect(existsSync(from)).toBe(false);
    const rec = readPipelineSession(branch.id);
    expect(rec?.role).toBe("chat");
    expect(rec?.agent_dir).toBe(piAgent);
    // reopening keeps the pi route: the promoted session starts pi again and never offers the Claude models
    const before = piStarts(fx).length;
    await json(await api(fx, "GET", `/api/conversations/${branch.id}`));
    await until(() => piStarts(fx).length > before);
    const models = await json<{ models: { id: string }[] }>(await api(fx, "GET", `/api/conversations/${branch.id}/models`));
    expect(models.models.map((m) => m.id)).not.toContain("opus");
  });

  test("F-1: a type-bearing mode's Claude conversation still delivers the first message", async () => {
    const fx = fixture({ types: true });
    const created = await create(fx);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    const events = await reader.until((e) => e.type === "end");
    expect(events.some((e) => e.type === "text")).toBe(true);
    // the person's message is the only prompt: no type instruction arrives as a message nobody wrote
    await until(() => commands(fx).some((c) => c.cmd === "prompt"));
    const prompts = commands(fx).filter((c) => c.cmd === "prompt");
    expect(prompts.length).toBe(1);
    expect(prompts[0].content).toBe("hello");
  });

  test("2-final/F-1: a sent message and a steer reach the body as user entries before the reply ends", async () => {
    const fx = fixture();
    process.env.FAKE_CLAUDE_HOLD_MS = "4000";
    const created = await create(fx);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    const send = api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "first" });
    // the person's own message is in the body while the reply still runs, not only after a reload
    const seen = await reader.until((e) => e.type === "entry" && e.role === "user" && textOfMessage(e.message) === "first", 5000);
    expect(seen.some((e) => e.type === "end")).toBe(false);
    await send;
    await until(() => commands(fx).some((c) => c.cmd === "prompt"));
    // a steer written into the running reply lands as a user entry too, before the turn ends
    const steer = api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "wait" });
    const seenSteer = await reader.until((e) => e.type === "entry" && e.role === "user" && textOfMessage(e.message) === "wait", 5000);
    expect(seenSteer.some((e) => e.type === "end")).toBe(false);
    await steer;
    await until(() => commands(fx).some((c) => c.cmd === "steer"));
    // the body and the record agree: reopening shows the same person's utterances
    await reader.until((e) => e.type === "end", 8000);
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => existsSync(recordPath(fx, created.id)));
    const opened = await json<{ entries: { message: { role: string; content: unknown } }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    const fromRecord = opened.entries.filter((e) => e.message.role === "user").map((e) => textOfMessage(e.message));
    expect(fromRecord).toContain("first");
    expect(fromRecord).toContain("wait");
  });

  test("F-2: reopening a Claude branch resumes its own record instead of forking again", async () => {
    const fx = fixture();
    const created = await create(fx);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    await reader.until((e) => e.type === "end");
    await until(() => existsSync(recordPath(fx, created.id)));
    const opened = await json<{ entries: { id: string; message: { role: string } }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    const at = opened.entries.find((e) => e.message.role === "assistant")?.id as string;
    const branch = await json<{ id: string }>(await api(fx, "POST", `/api/conversations/${created.id}/ephemeral`, { at }));
    await until(() => existsSync(recordPath(fx, branch.id)));
    const branchReader = new SseReader(await api(fx, "GET", `/api/conversations/${branch.id}/events`));
    await api(fx, "POST", `/api/conversations/${branch.id}/messages`, { text: "branch talk" });
    await branchReader.until((e) => e.type === "end");
    const branchRecord = recordPath(fx, branch.id);
    const before = readFileSync(branchRecord, "utf8");
    await api(fx, "POST", `/api/conversations/${branch.id}/close`);
    // reopening resumes the branch's own record; forking again would replace it with the parent's copy
    const startsBefore = starts(fx).length;
    await json(await api(fx, "GET", `/api/conversations/${branch.id}`));
    await until(() => starts(fx).length > startsBefore);
    const last = starts(fx)[starts(fx).length - 1];
    expect(String(last.argv)).toContain(`--resume ${branch.id}`);
    expect(String(last.argv)).not.toContain("--fork-session");
    expect(readFileSync(branchRecord, "utf8")).toBe(before);
  });

  test("F-3: an opened Claude conversation reports the alias the picker offers", async () => {
    const fx = fixture();
    const created = await create(fx);
    const opened = await json<{ model?: string }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(opened.model).toBe("opus");
    const models = await json<{ models: { id: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}/models`));
    expect(models.models.map((m) => m.id)).toContain(opened.model as string);
  });

  test("F-4: after a message, reopening still refuses the pi harness", async () => {
    const fx = fixture();
    const created = await create(fx);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    await reader.until((e) => e.type === "end");
    await until(() => existsSync(recordPath(fx, created.id)));
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    // the in-memory queue counter is gone, but the record is not: the harness is fixed
    const models = await json<{ models: { id: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}/models`));
    expect(models.models.map((m) => m.id)).not.toContain("openrouter/z-ai/glm-5.3");
    const refused = await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.3" });
    expect(refused.status).toBe(409);
    expect(piStarts(fx).length).toBe(0);
  });
});

describe("the memory index of a Claude conversation", () => {
  test("AC-001: the top-level index rides at every start, and the system prompt is never fixed to the first request", async () => {
    const fx = fixture();
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "FIRST-INDEX\n");
    const created = await create(fx);
    await until(() => starts(fx).length === 1);
    const first = starts(fx)[0];
    // Claude Code reads the index itself: the engine hands over the path and keeps no copy of the text
    expect(flagValues(first, "--append-system-prompt-file")).toEqual([join(fx.cwd, "memory", "MEMORY.md")]);
    expect(flagValues(first, "--append-system-prompt").join("\n")).toContain(`記憶の置き場: ${join(fx.cwd, "memory")}`);
    expect(String(first.argv)).not.toContain("FIRST-INDEX");
    // the first request must not record the system prompt, or a reopened conversation would keep this index
    expect(first.argvList).toContain("--system-prompt-snapshot");
    expect(first.argvList).toContain("off");

    // a rewrite of the index reaches the next start, and the reopen is launched the same way
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "SECOND-INDEX\n");
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    await json(await api(fx, "GET", `/api/conversations/${created.id}`));
    await until(() => starts(fx).length === 2);
    const reopened = starts(fx)[1];
    expect(flagValues(reopened, "--append-system-prompt-file")).toEqual([join(fx.cwd, "memory", "MEMORY.md")]);
    expect(reopened.argvList).toContain("off");
    expect(String(reopened.argv)).not.toContain("FIRST-INDEX");
    expect(String(reopened.argv)).not.toContain("SECOND-INDEX");
  });

  test("AC-002: the same mode's pi conversation receives the same index text", async () => {
    const fx = fixture();
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "SHARED-INDEX\n");
    await create(fx);
    await until(() => starts(fx).length === 1);
    const claudeStart = starts(fx)[0];
    const claudeTexts = ownFlagValues(claudeStart, "--append-system-prompt");
    const claudeFiles = flagValues(claudeStart, "--append-system-prompt-file");

    // the same mode, run on its pi role: the appendix values pi receives are the same assembly
    const piConversation = await create(fx);
    await api(fx, "POST", `/api/conversations/${piConversation.id}/model`, { model: "openrouter/z-ai/glm-5.3" });
    await until(() => piStarts(fx).length > 0);
    const piTexts = ownFlagValues(piStarts(fx)[0], "--append-system-prompt");
    expect(claudeTexts.length).toBe(1);
    expect(claudeFiles).toEqual([join(fx.cwd, "memory", "MEMORY.md")]);
    expect(piTexts).toEqual([...claudeTexts, ...claudeFiles]);
    expect(claudeTexts[0]).toContain(`最上位の索引: ${join(fx.cwd, "memory", "MEMORY.md")}`);
  });

  test("AC-004: a mode with no index opens Claude with no memory appendix", async () => {
    const fx = fixture();
    expect(existsSync(join(fx.cwd, "memory"))).toBe(false);
    await create(fx);
    await until(() => starts(fx).length === 1);
    const start = starts(fx)[0];
    expect(ownArgs(start)).not.toContain("--append-system-prompt");
    expect(ownArgs(start)).not.toContain("--append-system-prompt-file");
    expect(String(start.argv)).not.toContain(join(fx.cwd, "memory"));
  });

  test("AC-004: an index that cannot be read still opens the conversation, and Claude Code is not handed it", async () => {
    const fx = fixture();
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    const index = join(fx.cwd, "memory", "MEMORY.md");
    writeFileSync(index, "UNREADABLE-INDEX\n");
    chmodSync(index, 0o000);
    try {
      const created = await create(fx);
      await until(() => starts(fx).length === 1);
      const start = starts(fx)[0];
      // Claude Code refuses a whole launch over an unreadable `--append-system-prompt-file`, so it is dropped
      expect(ownArgs(start)).not.toContain("--append-system-prompt-file");
      expect(ownArgs(start)).not.toContain("--append-system-prompt");
      // the conversation really starts: it answers a message
      const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
      await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
      const events = await reader.until((e) => e.type === "end");
      expect(events.some((e) => e.type === "text")).toBe(true);
    } finally {
      chmodSync(index, 0o644);
    }
  });

  test("AC-003: the automatic memory stays off, so the mode's dir is the only memory the child is pointed at", async () => {
    const fx = fixture();
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "index\n");
    await create(fx);
    await until(() => starts(fx).length === 1);
    const start = starts(fx)[0];
    // Claude Code's own memory is turned off for the child, and nothing points it at the config dir's copy
    expect(start.autoMemory).toBe("1");
    const autoMemory = join(fx.configDir, "projects", fx.cwd.replace(/[^A-Za-z0-9-]/g, "-"), "memory");
    expect(String(start.argv)).not.toContain(autoMemory);
    expect(String(start.argv)).toContain(join(fx.cwd, "memory"));
  });
});

describe("the user's instructions in a Claude conversation", () => {
  const RULE = { id: "INS-1", text: "会話では結論から答える。", reason: "前置きが長いと読まれないから", scope: { repos: "all", scenes: ["chat"], places: ["conversation"] } };
  const place = (fx: Fx, list: unknown[]): void => {
    const dir = join(fx.root, "instructions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "instructions.json"), JSON.stringify({ version: 1, next: 3, instructions: list.map((i) => ({ ...(i as object), created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" })) }));
    process.env.IDD_INSTRUCTIONS_DIR = dir;
  };

  test("Claude Code starts with the text and the reason in its system prompt, its own session as the identity, and a reopen reads the file again", async () => {
    const fx = fixture();
    place(fx, [RULE]);
    process.env.IDD_ID = "IDD-77";
    const created = await create(fx);
    await until(() => starts(fx).length === 1);
    const first = starts(fx)[0];
    expect(flagValues(first, "--append-system-prompt").join("\n")).toContain("会話では結論から答える。（理由: 前置きが長いと読まれないから）");
    expect(flagValues(first, "--append-system-prompt").join("\n")).toContain("instruction propose add");
    expect(first.iddId).toBeNull();
    expect(first.iddSession).toBe(created.id);

    // the instruction is rewritten: a conversation reopened afterwards carries the text of that moment
    place(fx, [{ ...RULE, text: "会話では要点を先に答える。" }]);
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await until(() => starts(fx).length === 2);
    const second = flagValues(starts(fx)[1], "--append-system-prompt").join("\n");
    expect(second).toContain("会話では要点を先に答える。");
    expect(second).not.toContain("会話では結論から答える。");
  });
});

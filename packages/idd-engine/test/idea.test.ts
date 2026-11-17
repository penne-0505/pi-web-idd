import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { addGateRecord, exitRowStatus, ideaFourPointHash, parseIdeaDocument, setExitState, writeIdeaText } from "../src/server/idea-document.ts";
import { gateNotice } from "../src/server/idea-gate-anchors.ts";
import { approvalTarget, buildIdeaExitContent, ideaExitLogPath, runIdeaExits, selectExitRows, validatePlaces, type ExitConversation } from "../src/server/idea-exits.ts";
import { openConversations } from "../src/server/conversations.ts";
import { resolveSessionFile } from "../src/server/session-file.ts";
import { createFetchHandler } from "../src/server.ts";
import { createRegistrationOptions, finishRegistration } from "@idd/core";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";
import { softwareAuthenticator } from "../../idd-core/test/passkey-fixture.mjs";

/**
 * A stand-in for `pi --mode rpc`: it answers the readiness round trip, streams a short run for a prompt, and
 * records every prompt, so a test can see what reached pi. Only what the idea doors need is here.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--list-models")) {
  const q = String(at("--list-models") || "openrouter/z-ai/glm-5.3");
  const parts = q.split("/");
  process.stdout.write(parts[0] + " " + parts.slice(1).join("/") + "\\n");
  process.exit(0);
}
if (args.includes("-p") || args.includes("--print")) {
  process.stdout.write(JSON.stringify({ type: "session", version: 3, id: "oneshot", timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "自動タイトル" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n");
  process.exit(0);
}
const sessionId = at("--session-id");
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = process.cwd();
const safe = "--" + cwd.replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
const dir = path.join(agentDir, "sessions", safe);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "2026-03-01T00-00-00-000Z_" + sessionId + ".jsonl");
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + "\\n");
const entries = [];
const reload = () => { entries.length = 0; if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, "utf8").split("\\n")) { if (!line.trim()) continue; let e; try { e = JSON.parse(line); } catch { continue; } if (e.id) entries.push(e); } };
reload();
let model = at("--model"), effort = at("--thinking");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const log = process.env.FAKE_PI_LOG;
const handle = (cmd) => {
  if (cmd.type === "prompt" || cmd.type === "get_entries") reload();
  if (cmd.type === "get_state") { out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { model: model ? { provider: model.split("/")[0], id: model.split("/").slice(1).join("/") } : undefined, thinkingLevel: effort, isStreaming: false, sessionId, sessionFile: file } }); return; }
  if (cmd.type === "get_entries") { out({ id: cmd.id, type: "response", command: "get_entries", success: true, data: { entries, leafId: entries.length ? entries[entries.length - 1].id : null } }); return; }
  if (cmd.type === "prompt") {
    if (log) fs.appendFileSync(log, JSON.stringify({ cmd: "prompt", message: cmd.message }) + "\\n");
    if (typeof cmd.message === "string" && cmd.message.startsWith("/idd-context ")) {
      let payload = {}; try { payload = JSON.parse(cmd.message.slice("/idd-context ".length)); } catch { payload = {}; }
      const tts = new Date().toISOString();
      const tpid = entries.length ? entries[entries.length - 1].id : null;
      const tid = "t" + (entries.length + 1);
      const entry = { type: "custom_message", customType: "idd.conversation-type", content: payload.content, display: false, details: { type: payload.type, kind: payload.kind }, id: tid, parentId: tpid, timestamp: tts };
      fs.appendFileSync(file, JSON.stringify(entry) + "\\n");
      entries.push(entry);
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
      return;
    }
    const ts = new Date().toISOString(), uid = "u" + (entries.length + 1), aid = "a" + (entries.length + 2);
    const pid = entries.length ? entries[entries.length - 1].id : null;
    fs.appendFileSync(file, JSON.stringify({ type: "message", id: uid, parentId: pid, timestamp: ts, message: { role: "user", content: cmd.message } }) + "\\n");
    fs.appendFileSync(file, JSON.stringify({ type: "message", id: aid, parentId: uid, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\\n");
    entries.push({ type: "message", id: uid, parentId: null, message: { role: "user", content: cmd.message } });
    entries.push({ type: "message", id: aid, parentId: uid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
    const promptMs = Number(process.env.FAKE_PI_PROMPT_MS || "0");
    const runMs = Number(process.env.FAKE_PI_MS || "10");
    const run = () => {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      setTimeout(() => {
        out({ type: "agent_start" });
        out({ type: "message_start", message: { role: "user", content: cmd.message } });
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" } });
        out({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" }, toolResults: [] });
        out({ type: "agent_end", messages: [], willRetry: false });
        out({ type: "agent_settled" });
      }, runMs);
    };
    if (promptMs > 0) setTimeout(run, promptMs); else run();
    return;
  }
  if (cmd.type === "set_model") { model = String(cmd.provider) + "/" + String(cmd.modelId); out({ id: cmd.id, type: "response", command: "set_model", success: true, data: { provider: cmd.provider, id: cmd.modelId } }); return; }
  if (cmd.type === "set_thinking_level") { effort = cmd.level; out({ id: cmd.id, type: "response", command: "set_thinking_level", success: true }); return; }
  if (cmd.type === "get_session_stats") { out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionId, contextUsage: { tokens: 1, contextWindow: 1000, percent: 0.1 } } }); return; }
  if (cmd.type === "abort") { out({ id: cmd.id, type: "response", command: "abort", success: true }); return; }
  out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} });
};
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  for (;;) {
    const i = buf.indexOf("\\n");
    if (i < 0) break;
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** a gh stand-in: records its argv and prints the URL the caller expects */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.GH_FAKE_LOG;
const before = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const count = before;
const run = () => {
  const failAt = Number(process.env.GH_FAKE_FAIL_AT || "0");
  if (failAt && count + 1 >= failAt) { process.stderr.write("gh failed\\n"); process.exit(1); }
  const owner = process.env.GH_FAKE_OWNER || "penne-0505";
  if (args[0] === "repo" && args[1] === "create") {
    const name = args[2];
    process.stdout.write("https://github.com/" + (name.includes("/") ? name : owner + "/" + name) + "\\n");
  } else if (args[0] === "issue" && args[1] === "create") {
    const at = args.indexOf("--repo");
    process.stdout.write("https://github.com/" + args[at + 1] + "/issues/" + (100 + count) + "\\n");
  } else {
    process.stdout.write("https://github.com/" + owner + "/x\\n");
  }
  if (process.env.GH_FAKE_CHMOD) { try { fs.chmodSync(process.env.GH_FAKE_CHMOD, 0o555); } catch { /* the test's dir */ } }
  process.exit(0);
};
const delay = Number(process.env.GH_FAKE_DELAY_MS || "0");
if (delay > 0) setTimeout(run, delay); else run();
`;

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_MODES_FILE", "IDD_REPOS_FILE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_GH_BIN", "IDD_CONVERSATION_IDLE_MS", "FAKE_PI_LOG", "FAKE_PI_MS", "FAKE_PI_PROMPT_MS", "GH_FAKE_LOG", "GH_FAKE_DELAY_MS", "GH_FAKE_FAIL_AT", "GH_FAKE_OWNER", "GH_FAKE_CHMOD"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const conv of openConversations()) await conv.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
});

interface Fixture {
  root: string; state: string; typed: string; bare: string; place: string; log: string; ghLog: string;
  handler: (req: Request) => Promise<Response>;
}

function fixture(): Fixture {
  for (const key of ENV_KEYS) delete process.env[key];
  const root = tmpDir("idd-idea-");
  const state = join(root, "state");
  const typed = join(root, "ideas-typed");
  const bare = join(root, "ideas-bare");
  const place = join(root, "place");
  const userAgent = join(root, "user-agent");
  for (const dir of [state, typed, bare, place, userAgent]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(typed, "AGENTS.md"), "# norms\n");
  writeFileSync(join(bare, "AGENTS.md"), "# norms\n");
  const pi = join(root, "pi");
  writeFileSync(pi, FAKE_PI); chmodSync(pi, 0o755);
  const gh = join(root, "gh");
  writeFileSync(gh, FAKE_GH); chmodSync(gh, 0o755);
  writeFileSync(join(root, "roles.yaml"), "models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  ideas: { model: openrouter-z-ai-glm-5.3, thinking: low, tools: [read, write, edit] }\n");
  writeFileSync(join(root, "modes.yaml"), `modes:\n  idea: { role: ideas, workspace: ${bare} }\n  chat: { role: ideas, workspace: ${typed}, types: { idea: { label: idea, dir: . } } }\n`);
  writeFileSync(join(root, "repos.yaml"), "repos: {}\n");
  Object.assign(process.env, {
    IDD_STATE_DIR: state,
    IDD_ROLES_FILE: join(root, "roles.yaml"),
    IDD_MODES_FILE: join(root, "modes.yaml"),
    IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_PI_BIN: pi,
    IDD_PI_USER_AGENT_DIR: userAgent,
    IDD_GH_BIN: gh,
    FAKE_PI_LOG: join(root, "pi.log"),
    GH_FAKE_LOG: join(root, "gh.log"),
  });
  return { root, state, typed, bare, place, log: join(root, "pi.log"), ghLog: join(root, "gh.log"), handler: createFetchHandler() };
}

function api(fx: Fixture, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", host: "127.0.0.1:30144" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fx.handler(new Request(`http://127.0.0.1:30144${path}`, init));
}

async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json() as T;
}

async function makeConversation(fx: Fixture, mode = "chat"): Promise<string> {
  const res = await api(fx, "POST", "/api/conversations", { mode });
  const body = await jsonOf(res);
  if (!body.id) throw new Error(`no conversation: ${JSON.stringify(body)}`);
  const id = String(body.id);
  // a typed mode delivers its type instruction right after the spawn: wait for the conversation to be stopped,
  // so a record write appended now is the branch's leaf and the type instruction is already in the record
  await waitIdle(fx, id);
  return id;
}

/** wait until the conversation is stopped: no run, no prompt on its way, nothing queued */
async function waitIdle(fx: Fixture, id: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const state = await jsonOf<{ streaming?: boolean; promptPending?: boolean; queue?: unknown[] }>(await api(fx, "GET", `/api/conversations/${id}`));
    if (!state.streaming && !state.promptPending && (state.queue?.length ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("conversation did not become idle");
}

/** append a successful `write` call for `docPath` to a conversation's record, so the document rule finds it */
function recordWrite(sessionId: string, docPath: string): void {
  const file = resolveSessionFile(sessionId);
  if (!file) throw new Error(`no session file for ${sessionId}`);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: string });
  const last = [...lines].reverse().find((entry) => entry.id)?.id ?? null;
  const stamp = new Date().toISOString();
  const callId = `c${Math.random().toString(36).slice(2)}`;
  const assistantId = `w${Math.random().toString(36).slice(2)}`;
  const resultId = `r${Math.random().toString(36).slice(2)}`;
  const appended = [
    { type: "message", id: assistantId, parentId: last, timestamp: stamp, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "write", arguments: { path: docPath, content: "" } }] } },
    { type: "message", id: resultId, parentId: assistantId, timestamp: stamp, message: { role: "toolResult", toolCallId: callId, isError: false, content: [{ type: "text", text: "ok" }] } },
  ];
  appendFileSync(file, `${appended.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

/** append a chain of entries to a conversation's record, returning the ids the test can look for */
function appendEntries(sessionId: string, entries: Record<string, unknown>[]): string[] {
  const file = resolveSessionFile(sessionId);
  if (!file) throw new Error(`no session file for ${sessionId}`);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: string });
  let parent = [...lines].reverse().find((entry) => entry.id)?.id ?? null;
  const stamp = new Date().toISOString();
  const ids: string[] = [];
  const out: string[] = [];
  for (const entry of entries) {
    const id = `x${Math.random().toString(36).slice(2)}`;
    ids.push(id);
    out.push(JSON.stringify({ timestamp: stamp, ...entry, id, parentId: parent }));
    parent = id;
  }
  appendFileSync(file, `${out.join("\n")}\n`);
  return ids;
}

function userEntry(text: string): Record<string, unknown> {
  return { type: "message", message: { role: "user", content: text } };
}

function userEntryBlocks(text: string): Record<string, unknown> {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function writeEntry(docPath: string, content: string, callId: string): Record<string, unknown> {
  return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "write", arguments: { path: docPath, content } }] } };
}

function editEntry(docPath: string, newText: string, callId: string, old = false): Record<string, unknown> {
  const arguments_ = old ? { path: docPath, oldText: "", newText } : { path: docPath, edits: [{ oldText: "", newText }] };
  return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "edit", arguments: arguments_ }] } };
}

function resultEntry(callId: string, isError = false): Record<string, unknown> {
  return { type: "message", message: { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text: isError ? "failed" : "ok" }] } };
}

// ---- document builders ----

const SECTION_NAMES = ["経緯", "既存の確認", "目的", "ゴール", "非ゴール", "想定作業内容サマリ", "未決", "ゲート記録", "出口"];

interface DocOpts {
  slug?: string;
  status?: string;
  frozenAt?: string;
  marks?: Record<string, string>;
  places?: string[];
  sections?: Partial<Record<string, string>>;
  gates?: string[];
  exits?: string[];
  oldExit?: string;
}

function makeDoc(opts: DocOpts = {}): string {
  const bodies: Record<string, string> = {
    経緯: "昔の話。",
    既存の確認: "",
    目的: "目的の文。",
    ゴール: "ゴールの文。",
    非ゴール: "",
    想定作業内容サマリ: "",
    未決: "- 一つ目。\n- 二つ目。",
    ゲート記録: "",
    出口: "",
    ...(opts.sections ?? {}),
  };
  const front = ["---", `slug: ${opts.slug ?? "t"}`, `status: ${opts.status ?? "探索中"}`, "created_at: 2026-10-05", `frozen_at: ${opts.frozenAt ?? ""}`];
  if (opts.oldExit) front.push(`exit: ${opts.oldExit}`);
  if (opts.marks) {
    front.push("sections:");
    for (const [name, mark] of Object.entries(opts.marks)) front.push(`  ${name}: ${mark}`);
  }
  if (opts.places) {
    front.push("places:");
    for (const place of opts.places) front.push(`  - "${place}"`);
  }
  front.push("---", "");
  const parts = [`# ${opts.slug ?? "t"}`, ""];
  for (const name of SECTION_NAMES) {
    parts.push(`## ${name}`, "");
    let body = bodies[name] ?? "";
    if (name === "ゲート記録" && opts.gates?.length) body = opts.gates.join("\n");
    if (name === "出口" && opts.exits?.length) body = opts.exits.join("\n\n");
    if (body) parts.push(body, "");
  }
  return front.join("\n") + parts.join("\n");
}

interface IssueSpec { id: string; title: string; depends?: string[]; labels?: string[]; body: string; result?: string }
interface RowSpec { id: string; title: string; state?: string; reversibility?: string; result?: string }

function issueRow(spec: RowSpec, issues: IssueSpec[]): string {
  const lines = [
    `### ${spec.id}: ${spec.title}`, "",
    "- 効果: 外へ出る", "- 操作: issues", "- どこに: penne-0505/pi-web",
    `- 戻し方: ${spec.reversibility ?? "戻せない"}`, `- 状態: ${spec.state ?? "下書き"}`, `- 結果: ${spec.result ?? ""}`,
  ];
  for (const issue of issues) {
    lines.push("", `#### ${issue.id}: ${issue.title}`, "", `- 依存: [${(issue.depends ?? []).join(", ")}]`, `- ラベル: [${(issue.labels ?? []).join(", ")}]`, `- 結果: ${issue.result ?? ""}`, "- 本文:", "````text", issue.body, "````");
  }
  return lines.join("\n");
}

function repoRow(spec: RowSpec, visibility: "public" | "private", description: string): string {
  return [
    `### ${spec.id}: ${spec.title}`, "",
    "- 効果: 外へ出る", "- 操作: repo", "- どこに: penne-0505/example-work",
    `- 戻し方: ${spec.reversibility ?? "戻せない"}`, `- 状態: ${spec.state ?? "下書き"}`, `- 結果: ${spec.result ?? ""}`,
    `- 公開: ${visibility}`, "- 説明:", "````text", description, "````",
  ].join("\n");
}

function fileRow(spec: RowSpec & { change: string; content?: string; before?: string; after?: string }, target: string): string {
  const lines = [
    `### ${spec.id}: ${spec.title}`, "",
    "- 効果: 手元を変える", "- 操作: file", `- どこに: ${target}`,
    `- 戻し方: ${spec.reversibility ?? "戻せば戻る"}`, `- 状態: ${spec.state ?? "下書き"}`, `- 結果: ${spec.result ?? ""}`,
    `- 変更: ${spec.change}`,
  ];
  if (spec.change === "置換") lines.push("- 前:", "````text", spec.before ?? "", "````", "- 後:", "````text", spec.after ?? "", "````");
  else lines.push("- 本文:", "````text", spec.content ?? "", "````");
  return lines.join("\n");
}

/** the four points' fingerprint over the same text a gate 2 approval would record */
function fingerprintOf(text: string): string {
  return ideaFourPointHash(parseIdeaDocument(text));
}

// ---- signing ----

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";

type Authenticator = ReturnType<typeof softwareAuthenticator>;

async function registerPasskey(): Promise<Authenticator> {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions(RP_ID);
  const response = auth.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID });
  const result = await finishRegistration({ nonce, response, name: "test", localScreen: true, requestHost: "127.0.0.1" });
  if (!result.ok) throw new Error(`register failed: ${result.error}`);
  return auth;
}

function assertionFor(auth: Authenticator, challenge: string): unknown {
  return auth.assertion({ challenge, origin: ORIGIN, rpId: RP_ID });
}

/** a conversation stand-in for the module-level run tests */
function fakeConversation(): ExitConversation & { began: number } {
  return {
    canWriteDocument: true,
    began: 0,
    beginExitRun() { this.began += 1; },
    endExitRun() { this.began -= 1; },
  };
}

// ---- tests ----

describe("the idea document contract", () => {
  test("AC-001/AC-002: the example template reads, with three operations and no old exit field", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "idea-template.example.md"), "utf8");
    const doc = parseIdeaDocument(text, "docs/idea-template.example.md");
    expect(doc.unreadable).toEqual([]);
    expect(doc.exits).toHaveLength(3);
    expect(doc.exits.map((row) => row.operation).sort()).toEqual(["file", "issues", "repo"]);
    expect(doc.exits.every((row) => row.readable)).toBe(true);
    expect(doc.frontmatter.exit).toBeUndefined();
    expect(doc.undecided).toHaveLength(2);
  });

  test("AC-004: every operation comes back with the same five fields, and a wrong effect is not readable", () => {
    const text = makeDoc({
      exits: [
        issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }]),
        repoRow({ id: "EXIT-2", title: "repo" }, "private", "desc"),
        fileRow({ id: "EXIT-3", title: "file", change: "作成", content: "x" }, "notes/x.md"),
      ],
    });
    const doc = parseIdeaDocument(text);
    const keys = doc.exits.map((row) => Object.keys(exitRowStatus(row)).filter((key) => ["effect", "operation", "target", "title", "reversibility", "state"].includes(key)).sort());
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[1]).toEqual(keys[2]);

    const mismatched = makeDoc({
      exits: [
        ["### EXIT-9: wrong", "", "- 効果: 手元を変える", "- 操作: issues", "- どこに: a/b", "- 戻し方: 戻せない", "- 状態: 下書き", "- 結果:"].join("\n"),
      ],
    });
    const bad = parseIdeaDocument(mismatched);
    expect(bad.exits[0].readable).toBe(false);
    expect(bad.exits[0].reason).toContain("効果が操作と違います");
  });

  test("AC-006/AC-009/AC-010: the stage, the freeze and the four points' fingerprint", () => {
    const base = makeDoc({});
    const g1 = addGateRecord(base, { gate: 1, action: "approve", date: "2026-10-05" });
    expect(parseIdeaDocument(g1).stage).toBe("ゲート1");
    const fp = fingerprintOf(g1);
    const g2 = addGateRecord(g1, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fp });
    const frozen = parseIdeaDocument(g2);
    expect(frozen.frozen).toBe(true);
    expect(frozen.frozenIntact).toBe(true);
    expect(frozen.stage).toBe("凍結");
    // moving one of the four points after the freeze is detected
    const moved = g2.replace("目的の文。", "目的の文を変えた。");
    const broken = parseIdeaDocument(moved);
    expect(broken.frozen).toBe(true);
    expect(broken.frozenIntact).toBe(false);
    // a gate 2 approval without a fingerprint cannot be confirmed
    const noFp = parseIdeaDocument(addGateRecord(g1, { gate: 2, action: "approve", date: "2026-10-05" }));
    expect(noFp.frozen).toBe(true);
    expect(noFp.frozenIntact).toBe(false);
  });

  test("AC-007: an old document reads what it can and says why the exit section does not", () => {
    const text = makeDoc({ oldExit: "{ kind: issue, state: 下書き, ref: x }", exits: ["### EXIT-2: 題", "", "- 効果: 外へ出る", "- 操作: repo", "- どこに: a/b", "- 戻し方: 戻せない", "- 状態: 下書き", "- 結果:", "- 公開: private", "- 説明:", "````text", "d", "````"] });
    const doc = parseIdeaDocument(text);
    expect(doc.exitsReadable).toBe(false);
    expect(doc.unreadable.some((entry) => entry.where === "節 出口")).toBe(true);
    expect(doc.sections.find((section) => section.name === "目的")?.state).toBe("詰めている");
  });

  test("AC-021: a replace is one place only, and create refuses an existing file", async () => {
    const fx = fixture();
    await registerPasskey();
    const docPath = join(fx.place, "note.md");
    writeFileSync(docPath, "AAA\nBBB\n");
    const text = makeDoc({ places: [fx.place], exits: [fileRow({ id: "EXIT-1", title: "replace", change: "置換", before: "BBB", after: "CCC" }, docPath)] });
    void text;
    // no signature: refused before anything is written
    await expect(runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce: undefined })).rejects.toThrow();
    expect(readFileSync(docPath, "utf8")).toBe("AAA\nBBB\n");
  });

  test("F-2: a heading inside a fenced body is not a section or row boundary", () => {
    const issueBody = ["導入。", "", "## これは本文の見出し", "", "### EXIT-9: 本文の中", "", "本文の終わり。"].join("\n");
    const text = makeDoc({
      exits: [
        issueRow({ id: "EXIT-1", title: "one" }, [{ id: "EXIT-1-1", title: "one", body: issueBody }]),
        issueRow({ id: "EXIT-2", title: "two" }, [{ id: "EXIT-2-1", title: "two", body: "second" }]),
      ],
    });
    const doc = parseIdeaDocument(text);
    expect(doc.exits.map((row) => row.id)).toEqual(["EXIT-1", "EXIT-2"]);
    expect(doc.exits[0].issues?.[0].body).toBe(issueBody);
    expect(doc.exits.every((row) => row.readable)).toBe(true);
  });

  test("F-3: an exit row or Issue without a 結果 field is unreadable and cannot be selected", () => {
    const noRowResult = makeDoc({
      exits: [[
        "### EXIT-1: no row result", "",
        "- 効果: 外へ出る", "- 操作: issues", "- どこに: a/b", "- 戻し方: 戻せない", "- 状態: 下書き", "",
        "#### EXIT-1-1: one", "", "- 依存: []", "- ラベル: []", "- 結果:", "- 本文:", "````text", "body", "````",
      ].join("\n")],
    });
    const rowDoc = parseIdeaDocument(noRowResult);
    expect(rowDoc.exits).toHaveLength(1);
    expect(rowDoc.exits[0].readable).toBe(false);
    expect(String(rowDoc.exits[0].reason)).toContain("結果");
    expect(rowDoc.unreadable.some((entry) => entry.reason.includes("結果"))).toBe(true);
    expect(selectExitRows(rowDoc)).toEqual([]);

    const noIssueResult = makeDoc({
      exits: [[
        "### EXIT-1: no issue result", "",
        "- 効果: 外へ出る", "- 操作: issues", "- どこに: a/b", "- 戻し方: 戻せない", "- 状態: 下書き", "- 結果:", "",
        "#### EXIT-1-1: one", "", "- 依存: []", "- ラベル: []", "- 本文:", "````text", "body", "````",
      ].join("\n")],
    });
    const issueDoc = parseIdeaDocument(noIssueResult);
    expect(issueDoc.exits[0].readable).toBe(false);
    expect(String(issueDoc.exits[0].reason)).toContain("結果");
    expect(selectExitRows(issueDoc)).toEqual([]);
  });

  test("F-5: duplicate exit row ids are unreadable and cannot be selected", () => {
    const text = makeDoc({
      exits: [
        issueRow({ id: "EXIT-1", title: "first" }, [{ id: "EXIT-1-1", title: "one", body: "a" }]),
        issueRow({ id: "EXIT-1", title: "second" }, [{ id: "EXIT-1-2", title: "two", body: "b" }]),
      ],
    });
    const doc = parseIdeaDocument(text);
    expect(doc.exits).toHaveLength(2);
    expect(doc.exits.every((row) => !row.readable)).toBe(true);
    expect(String(doc.exits[0].reason)).toContain("重複");
    expect(doc.unreadable.some((entry) => entry.reason.includes("重複"))).toBe(true);
    expect(selectExitRows(doc)).toEqual([]);
  });

  test("F-2: a two-word fence info string does not hide the sections and rows after it", () => {
    const text = makeDoc({
      sections: { 経緯: ["説明。", "", "```js title", "## 経緯の中の見出し", "```", ""].join("\n") },
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [issueRow({ id: "EXIT-1", title: "one" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])],
    });
    const doc = parseIdeaDocument(text);
    // the opening line's info string may hold more than one word; the fence still closes and the rest reads
    expect(doc.unreadable).toEqual([]);
    expect(doc.gates.map((gate) => `${gate.gate}:${gate.action}`)).toEqual(["1:approve"]);
    expect(doc.exits.map((row) => row.id)).toEqual(["EXIT-1"]);
    expect(doc.exitsReadable).toBe(true);
  });

  test("F-5: duplicate Issue ids in one row are unreadable and cannot be selected", () => {
    const text = makeDoc({
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [issueRow({ id: "EXIT-1", title: "one" }, [
        { id: "EXIT-1-1", title: "a", body: "a" },
        { id: "EXIT-1-1", title: "b", body: "b" },
      ])],
    });
    const doc = parseIdeaDocument(text);
    expect(doc.exits).toHaveLength(1);
    expect(doc.exits[0].readable).toBe(false);
    expect(String(doc.exits[0].reason)).toContain("重複");
    expect(doc.unreadable.some((entry) => entry.reason.includes("重複"))).toBe(true);
    expect(() => selectExitRows(doc, ["EXIT-1"])).toThrow();
  });

  test("F-2: a fenced sample field before the real field is not the write target", () => {
    const text = makeDoc({
      exits: [[
        "### EXIT-1: sample first", "",
        "- 効果: 外へ出る", "- 操作: issues", "- どこに: a/b", "- 戻し方: 戻せない", "",
        "````text", "- 状態: 見本", "- 結果: 見本", "````", "",
        "- 状態: 下書き", "- 結果:", "",
        "#### EXIT-1-1: one", "", "- 依存: []", "- ラベル: []", "- 結果:", "- 本文:", "````text", "body", "````",
      ].join("\n")],
    });
    const parsed = parseIdeaDocument(text);
    // the real fields read, not the fenced sample
    expect(parsed.exits[0].state).toBe("下書き");
    const written = setExitState(text, "EXIT-1", "実行済み", "#100");
    const after = parseIdeaDocument(written);
    expect(after.exits[0].state).toBe("実行済み");
    expect(after.exits[0].result).toBe("#100");
    // the fenced sample is left as body text
    expect(written).toContain("- 状態: 見本");
    expect(written).toContain("- 結果: 見本");
  });

  test("F-3: a bullet-less gate line reads, so a bullet-less redo voids the freeze", () => {
    const base = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"] });
    const fp = fingerprintOf(base);
    const frozen = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認", `- ゲート 2: 2026-10-05 承認 指紋 ${fp}`] });
    expect(parseIdeaDocument(frozen).stage).toBe("凍結");
    // the older shapes the contract accepts carry no bullet
    const template = makeDoc({ gates: ["ゲート 1 (2026-10-05): 承認"] });
    expect(parseIdeaDocument(template).gates.map((gate) => `${gate.gate}:${gate.action}`)).toEqual(["1:approve"]);
    const redone = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認", `- ゲート 2: 2026-10-05 承認 指紋 ${fp}`, "ゲート 1（やり直し）: 2026-10-06 目的が変わった"] });
    const doc = parseIdeaDocument(redone);
    expect(doc.gates.map((gate) => `${gate.gate}:${gate.action}`)).toEqual(["1:approve", "2:approve", "1:redo"]);
    expect(doc.stage).toBe("探索");
    expect(doc.frozenIntact).toBe(false);
    expect(() => approvalTarget(doc)).toThrow();
  });

  test("F-8: a redo reason with a newline stays one line and adds no approval", () => {
    const g1 = addGateRecord(makeDoc({}), { gate: 1, action: "approve", date: "2026-10-05" });
    const injected = "- ゲート 2: 2026-10-05 承認 指紋 deadbeef";
    const redone = addGateRecord(g1, { gate: 1, action: "redo", date: "2026-10-06", reason: `目的が変わった\n${injected}` });
    const doc = parseIdeaDocument(redone);
    expect(doc.gates.filter((gate) => gate.gate === 2)).toHaveLength(0);
    expect(doc.gates.filter((gate) => gate.gate === 1 && gate.action === "approve")).toHaveLength(1);
    expect(doc.gates.find((gate) => gate.action === "redo")?.reason).toContain("目的が変わった");
    // the parentheses in a reason are part of the reason, not stripped when read
    const paren = parseIdeaDocument(addGateRecord(g1, { gate: 1, action: "redo", date: "2026-10-06", reason: "補足（A）" })).gates.at(-1);
    expect(paren?.reason).toBe("補足（A）");
  });
});

describe("the idea exits", () => {
  test("AC-013/AC-016/AC-019/AC-005: one signature runs issues, repo and a local file, and writes results back", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const filePath = join(fx.place, "note.md");
    writeFileSync(filePath, "start\n");
    const text = makeDoc({
      places: [fx.place],
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [
        issueRow({ id: "EXIT-1", title: "issue" }, [
          { id: "EXIT-1-1", title: "one", body: "first" },
          { id: "EXIT-1-2", title: "two", depends: ["EXIT-1-1"], labels: ["follow-up"], body: "uses {{EXIT-1-1}}" },
        ]),
        repoRow({ id: "EXIT-2", title: "repo" }, "private", "desc"),
        fileRow({ id: "EXIT-3", title: "file", change: "追記", content: "added\n" }, filePath),
      ],
    });
    const fp = fingerprintOf(text);
    const frozen = addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fp });
    writeFileSync(docPath, frozen);
    const parsed = parseIdeaDocument(frozen, docPath);
    const content = buildIdeaExitContent(parsed, selectExitRows(parsed));
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(content);

    const conv = fakeConversation();
    const result = await runIdeaExits({
      conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: conv,
      nonce, assertion: assertionFor(auth, challenge),
    });
    expect(result.stopped).toBe(false);
    expect(result.outcomes.map((entry) => entry.state)).toEqual(["実行済み", "実行済み", "実行済み"]);
    expect(readFileSync(filePath, "utf8")).toBe("start\nadded");

    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    expect(after.stage).toBe("出口");
    const issueRowAfter = after.exits.find((row) => row.id === "EXIT-1")!;
    expect(issueRowAfter.state).toBe("実行済み");
    expect(issueRowAfter.issues?.map((issue) => issue.number)).toEqual([100, 101]);
    expect(after.exits.find((row) => row.id === "EXIT-2")?.result).toContain("github.com");

    // the label went out, the dependency notation was replaced, and no outbound record was made
    const ghLines = readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    const issues = ghLines.filter((args) => args[0] === "issue");
    expect(issues).toHaveLength(2);
    expect(issues[1]).toContain("--label");
    expect(issues[1].join(" ")).toContain("#100");
    expect(existsSync(join(fx.state, "outbound"))).toBe(false);
    expect(existsSync(ideaExitLogPath())).toBe(true);
    expect(conv.began).toBe(0);
  });

  test("AC-014/AC-015: a run without a signature, or after the document moved, does nothing", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const content = buildIdeaExitContent(parsed, selectExitRows(parsed));
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(content);

    // no nonce at all
    await expect(runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation() })).rejects.toThrow();
    // the row's text changed after the challenge
    writeIdeaText(docPath, readFileSync(docPath, "utf8").replace("### EXIT-1: issue", "### EXIT-1: issue changed"));
    const changed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const changedContent = buildIdeaExitContent(changed, selectExitRows(changed));
    await expect(runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) })).rejects.toThrow();
    expect(existsSync(fx.ghLog)).toBe(false);
    expect(changedContent).not.toEqual(content);
  });

  test("AC-017/AC-018: a failure stops the run, leaves the rest drafts, and a retry makes only the missing Issue", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [
        issueRow({ id: "EXIT-1", title: "issue" }, [
          { id: "EXIT-1-1", title: "one", body: "first" },
          { id: "EXIT-1-2", title: "two", body: "second" },
          { id: "EXIT-1-3", title: "three", body: "third" },
        ]),
        issueRow({ id: "EXIT-2", title: "later" }, [{ id: "EXIT-2-1", title: "later one", body: "body" }]),
      ],
    });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    // the third issue call fails
    process.env.GH_FAKE_FAIL_AT = "3";
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const content = buildIdeaExitContent(parsed, selectExitRows(parsed));
    const first = (await import("@idd/core")).createChallenge(content);
    const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce: first.nonce, assertion: assertionFor(auth, first.challenge) });
    expect(result.stopped).toBe(true);
    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    expect(after.exits.find((row) => row.id === "EXIT-1")?.state).toBe("失敗");
    expect(after.exits.find((row) => row.id === "EXIT-2")?.state).toBe("下書き");
    // only the row that failed can be retried; the two Issues already made are not made again
    const failedIds = after.exits.filter((row) => row.state === "失敗").map((row) => row.id);
    expect(failedIds).toEqual(["EXIT-1"]);
    delete process.env.GH_FAKE_FAIL_AT;
    const beforeRetry = readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean).length;
    const retryDoc = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { rows } = { rows: selectExitRows(retryDoc, ["EXIT-1"]) };
    const retryContent = buildIdeaExitContent(retryDoc, rows);
    const retry = (await import("@idd/core")).createChallenge(retryContent);
    const retryResult = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), rows: ["EXIT-1"], nonce: retry.nonce, assertion: assertionFor(auth, retry.challenge) });
    expect(retryResult.stopped).toBe(false);
    const ghCalls = readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean).length - beforeRetry;
    expect(ghCalls).toBe(1);
    expect(parseIdeaDocument(readFileSync(docPath, "utf8"), docPath).exits.find((row) => row.id === "EXIT-1")?.state).toBe("実行済み");
  });

  test("AC-020: a hand-side row cannot leave the workspace and the declared places, nor write the document", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const outside = join(fx.root, "outside.md");
    for (const target of [outside, docPath, join(fx.state, "x.md")]) {
      const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [fileRow({ id: "EXIT-1", title: "file", change: "作成", content: "x" }, target)] });
      writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
      const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
      const content = buildIdeaExitContent(parsed, selectExitRows(parsed));
      const { nonce, challenge } = (await import("@idd/core")).createChallenge(content);
      const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
      expect(result.outcomes[0].state).toBe("失敗");
      if (target === docPath) expect(readFileSync(docPath, "utf8")).toContain("### EXIT-1");
      else expect(existsSync(target)).toBe(false);
    }
  });

  test("AC-024: a second run of the same document is refused while the first is going", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    process.env.GH_FAKE_DELAY_MS = "150";
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
    const first = runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
    const second = runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
    await expect(second).rejects.toThrow();
    const result = await first;
    expect(result.stopped).toBe(false);
  });

  test("AC-013: naming the same row twice runs it once", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const rows = selectExitRows(parsed, ["EXIT-1", "EXIT-1"]);
    expect(rows.map((row) => row.id)).toEqual(["EXIT-1"]);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, rows));
    const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), rows: ["EXIT-1", "EXIT-1"], nonce, assertion: assertionFor(auth, challenge) });
    expect(result.stopped).toBe(false);
    expect(result.rows).toEqual(["EXIT-1"]);
    const issueCalls = readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((args) => args[0] === "issue");
    expect(issueCalls).toHaveLength(1);
  });

  test("AC-015/AC-019: a change to a signed Issue number during the run stops the next row", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const resultWith = (number: number): string => `#${number} https://github.com/penne-0505/pi-web/issues/${number}`;
    const text = makeDoc({
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [
        repoRow({ id: "EXIT-1", title: "repo" }, "private", "desc"),
        issueRow({ id: "EXIT-2", title: "issue" }, [{ id: "EXIT-2-1", title: "one", body: "body", result: resultWith(7) }]),
      ],
    });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
    // the repo call holds the run long enough to re-point a signed Issue number in the document
    process.env.GH_FAKE_DELAY_MS = "600";
    const running = runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeIdeaText(docPath, readFileSync(docPath, "utf8").replace(resultWith(7), resultWith(9)));
    const result = await running;
    expect(result.stopped).toBe(true);
    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    expect(after.exits.find((row) => row.id === "EXIT-2")?.state).toBe("下書き");
    const issueCalls = readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((args) => args[0] === "issue");
    expect(issueCalls).toHaveLength(0);
  });

  test("AC-026: a row left 承認済み is not run again, and is marked interrupted", () => {
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue", state: "承認済み" }, [{ id: "EXIT-1-1", title: "one", body: "body" }]), issueRow({ id: "EXIT-2", title: "later" }, [{ id: "EXIT-2-1", title: "one", body: "body" }])] });
    const doc = parseIdeaDocument(text);
    expect(selectExitRows(doc).map((row) => row.id)).toEqual(["EXIT-2"]);
    expect(() => selectExitRows(doc, ["EXIT-1"])).toThrow();
    expect(exitRowStatus(doc.exits[0]).interrupted).toBe(true);
  });

  test("AC-026: a side effect whose result cannot be written back stops the run and keeps the row 承認済み", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    // the document lives in a dir the gh stand-in turns read-only, so the result write-back fails after the Issue
    const runDir = join(fx.typed, "run");
    mkdirSync(runDir, { recursive: true });
    const docPath = join(runDir, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
    process.env.GH_FAKE_CHMOD = runDir;
    try {
      const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
      expect(result.stopped).toBe(true);
      expect(result.outcomes[0].state).toBe("承認済み");
      expect(result.outcomes[0].issues?.[0].number).toBe(100);
    } finally {
      chmodSync(runDir, 0o755);
    }
    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    expect(after.exits[0].state).toBe("承認済み");
    expect(exitRowStatus(after.exits[0]).interrupted).toBe(true);
    expect(() => selectExitRows(after, ["EXIT-1"])).toThrow();
  });

  test("F-2: an Issue body with headings reaches gh whole and the later row still runs", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const issueBody = ["導入。", "", "## これは本文の見出し", "", "### EXIT-9: 本文の中", "", "本文の終わり。"].join("\n");
    const text = makeDoc({
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [
        issueRow({ id: "EXIT-1", title: "one" }, [{ id: "EXIT-1-1", title: "one", body: issueBody }]),
        issueRow({ id: "EXIT-2", title: "two" }, [{ id: "EXIT-2-1", title: "two", body: "second" }]),
      ],
    });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
    const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
    expect(result.stopped).toBe(false);
    expect(result.outcomes.map((entry) => entry.state)).toEqual(["実行済み", "実行済み"]);
    const issues = readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((args) => args[0] === "issue");
    expect(issues).toHaveLength(2);
    const firstBody = issues[0][issues[0].indexOf("--body") + 1];
    expect(firstBody).toContain("## これは本文の見出し");
    expect(firstBody).toContain("### EXIT-9: 本文の中");
  });

  test("F-5: a duplicate id keeps both rows out of a run, so no Issue is made twice", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [
        issueRow({ id: "EXIT-1", title: "first" }, [{ id: "EXIT-1-1", title: "one", body: "a" }]),
        issueRow({ id: "EXIT-1", title: "second" }, [{ id: "EXIT-1-2", title: "two", body: "b" }]),
      ],
    });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, parsed.exits));
    await expect(runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) })).rejects.toThrow();
    expect(existsSync(fx.ghLog)).toBe(false);
  });

  test("F-1: a same-id heading outside the exit section does not take the write-back", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({
      sections: { 経緯: ["昔の話。", "", "### EXIT-1: 本文の中の見出し", "", "本文の続き。"].join("\n") },
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])],
    });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
    const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
    expect(result.stopped).toBe(false);
    expect(result.outcomes[0].state).toBe("実行済み");
    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const real = after.exits.find((row) => row.id === "EXIT-1")!;
    expect(real.state).toBe("実行済み");
    expect(real.issues?.[0].number).toBe(100);
    // the heading before the section is still the agent's body text, untouched
    expect(after.sections.find((section) => section.name === "経緯")?.body).toContain("### EXIT-1: 本文の中の見出し");
    expect(after.sections.find((section) => section.name === "経緯")?.body).toContain("本文の続き。");
  });
});

describe("the idea routes", () => {
  test("AC-006/AC-023: the status door answers from the record, and a type-less mode finds its workspace document", async () => {
    const fx = fixture();
    const typedDoc = join(fx.typed, "typed.md");
    writeFileSync(typedDoc, makeDoc({ marks: { 目的: "決まった", 非ゴール: "まだ" }, exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] }));
    const typed = await makeConversation(fx, "chat");
    recordWrite(typed, typedDoc);
    const first = await jsonOf<{ document: Record<string, unknown> }>(await api(fx, "GET", `/api/conversations/${typed}/idea`));
    expect(first.document.slug).toBe("t");
    expect(first.document.undecided).toHaveLength(2);
    expect((first.document.exits as unknown[]).length).toBe(1);
    expect((first.document.sections as { state: string }[]).find((section) => section.name === "非ゴール")?.state).toBe("まだ");

    // a rewrite between two calls is seen by the second
    writeFileSync(typedDoc, makeDoc({ slug: "changed", exits: [] }));
    const second = await jsonOf<{ document: Record<string, unknown> }>(await api(fx, "GET", `/api/conversations/${typed}/idea`));
    expect(second.document.slug).toBe("changed");

    // a type-less mode reads the workspace itself
    const bareDoc = join(fx.bare, "bare.md");
    writeFileSync(bareDoc, makeDoc({ slug: "bare-idea" }));
    const bare = await makeConversation(fx, "idea");
    recordWrite(bare, bareDoc);
    const bareBody = await jsonOf<{ document: Record<string, unknown> }>(await api(fx, "GET", `/api/conversations/${bare}/idea`));
    expect(bareBody.document.slug).toBe("bare-idea");
  });

  test("AC-007: a conversation with no document answers so", async () => {
    const fx = fixture();
    const conv = await makeConversation(fx, "chat");
    const body = await jsonOf<{ document: unknown; reason?: string }>(await api(fx, "GET", `/api/conversations/${conv}/idea`));
    expect(body.document).toBeNull();
    expect(String(body.reason)).toContain("文書");
  });

  test("AC-008/AC-011: the gate door records the approval and leaves one notice; a running conversation is refused", async () => {
    const fx = fixture();
    const docPath = join(fx.bare, "idea.md");
    writeFileSync(docPath, makeDoc({}));
    // the prompt is held so the conversation is still busy when the second gate call comes
    process.env.FAKE_PI_PROMPT_MS = "300";
    const conv = await makeConversation(fx, "idea");
    recordWrite(conv, docPath);
    const res = await api(fx, "POST", `/api/conversations/${conv}/idea/gates`, { gate: 1, action: "approve" });
    expect(res.status).toBe(200);
    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    expect(after.gates.some((gate) => gate.gate === 1 && gate.action === "approve")).toBe(true);
    expect(after.status).toBe("ゲート1");
    // the notice reached pi
    let notice: { cmd: string; message?: string } | undefined;
    for (let i = 0; i < 100 && !notice; i += 1) {
      const logged = existsSync(fx.log) ? readFileSync(fx.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { cmd: string; message?: string }) : [];
      notice = logged.find((entry) => entry.cmd === "prompt");
      if (!notice) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(String(notice?.message)).toContain("記入済み");

    // while a run is going, the gate door is refused and the document does not change
    await api(fx, "POST", `/api/conversations/${conv}/messages`, { text: "続き" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = readFileSync(docPath, "utf8");
    const refused = await api(fx, "POST", `/api/conversations/${conv}/idea/gates`, { gate: 1, action: "approve" });
    expect(refused.status).toBe(409);
    expect(readFileSync(docPath, "utf8")).toBe(before);
  });

  test("AC-012: the challenge door answers the target, and with no key asks for registration", async () => {
    const fx = fixture();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({
      places: [fx.place],
      gates: ["- ゲート 1: 2026-10-05 承認"],
      exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])],
    });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const conv = await makeConversation(fx, "chat");
    recordWrite(conv, docPath);
    const noKey = await jsonOf<{ registered: number; nonce?: string }>(await api(fx, "POST", `/api/conversations/${conv}/idea/exits/challenge`, {}));
    expect(noKey.registered).toBe(0);
    expect(noKey.nonce).toBeUndefined();

    await registerPasskey();
    const body = await jsonOf<{ nonce: string; challenge: string; summary: { total: number; outbound: number; local: number; irreversible: number }; rows: { id: string; target: string }[] }>(await api(fx, "POST", `/api/conversations/${conv}/idea/exits/challenge`, {}));
    expect(body.nonce).toBeTruthy();
    expect(body.challenge).toBeTruthy();
    expect(body.summary).toEqual({ total: 1, outbound: 1, local: 0, irreversible: 1, interrupted: 0 });
    expect(body.rows[0].id).toBe("EXIT-1");
  });

  test("AC-010: a broken freeze refuses the challenge", async () => {
    const fx = fixture();
    await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    writeFileSync(docPath, readFileSync(docPath, "utf8").replace("目的の文。", "目的の文を変えた。"));
    const conv = await makeConversation(fx, "chat");
    recordWrite(conv, docPath);
    const res = await api(fx, "POST", `/api/conversations/${conv}/idea/exits/challenge`, {});
    expect(res.status).toBe(409);
  });

  test("AC-020/AC-003: a home place is reported, and nothing outside the repo is touched", () => {
    const doc = parseIdeaDocument(makeDoc({ places: ["~", "/"] }));
    const checked = validatePlaces(doc);
    expect(checked.errors.length).toBeGreaterThan(0);
    expect(checked.safe).toEqual([]);
  });

  test("AC-020: a place is judged by its real path, and a link inside a place is not followed", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    // a declared place that resolves to home, an ancestor of home or the state is refused, however it reads
    const toHome = join(fx.root, "link-home");
    const toParent = join(fx.root, "link-parent");
    const toState = join(fx.root, "link-state");
    symlinkSync(homedir(), toHome);
    symlinkSync(dirname(homedir()), toParent);
    symlinkSync(fx.state, toState);
    for (const place of [toHome, toParent, toState]) {
      const checked = validatePlaces(parseIdeaDocument(makeDoc({ places: [place] })));
      expect(checked.safe).toEqual([]);
      expect(checked.errors.length).toBeGreaterThan(0);
    }
    // a link inside a valid place must not carry a write out of the workspace and the places
    const inside = join(fx.place, "inside");
    symlinkSync(fx.root, inside);
    const outside = join(inside, "outside.md");
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ places: [fx.place], gates: ["- ゲート 1: 2026-10-05 承認"], exits: [fileRow({ id: "EXIT-1", title: "file", change: "作成", content: "x" }, outside)] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
    const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
    expect(result.outcomes[0].state).toBe("失敗");
    expect(existsSync(join(fx.root, "outside.md"))).toBe(false);
  });
  test("AC-008/AC-009: gate 2 needs gate 1, a redo keeps the earlier line, and a hand-written freeze is not one", async () => {
    const fx = fixture();
    const docPath = join(fx.bare, "idea.md");
    writeFileSync(docPath, makeDoc({}));
    const conv = await makeConversation(fx, "idea");
    recordWrite(conv, docPath);
    // gate 2 before gate 1 is refused
    expect((await api(fx, "POST", `/api/conversations/${conv}/idea/gates`, { gate: 2, action: "approve" })).status).toBe(409);
    // gate 1 approve, then redo: both lines stay
    expect((await api(fx, "POST", `/api/conversations/${conv}/idea/gates`, { gate: 1, action: "approve" })).status).toBe(200);
    await waitIdle(fx, conv);
    expect((await api(fx, "POST", `/api/conversations/${conv}/idea/gates`, { gate: 1, action: "redo", reason: "目的が変わった" })).status).toBe(200);
    await waitIdle(fx, conv);
    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    expect(after.gates.map((gate) => gate.action)).toEqual(["approve", "redo"]);
    expect(after.gates[1].reason).toContain("目的が変わった");
    expect(after.status).toBe("探索");
    // a mark that says 凍結 does not freeze anything without the gate 2 record
    writeFileSync(docPath, makeDoc({ marks: { 出口: "決まった" } }));
    const marked = await jsonOf<{ document: { frozen: boolean; stage: string } | null }>(await api(fx, "GET", `/api/conversations/${conv}/idea`));
    expect(marked.document?.frozen).toBe(false);
    expect(marked.document?.stage).toBe("探索");
  });

  test("AC-009/AC-010: a gate 1 redo after gate 2 voids the freeze and re-approving gate 1 does not revive it", async () => {
    const fx = fixture();
    const base = makeDoc({ places: [fx.place], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    const fp = fingerprintOf(base);
    const frozen = addGateRecord(addGateRecord(base, { gate: 1, action: "approve", date: "2026-10-05" }), { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fp });
    expect(parseIdeaDocument(frozen).stage).toBe("凍結");
    // gate 1 redo reopens the exploration even though the four points did not move
    const redone = addGateRecord(frozen, { gate: 1, action: "redo", date: "2026-10-06", reason: "詰め直し" });
    const afterRedo = parseIdeaDocument(redone);
    expect(afterRedo.stage).toBe("探索");
    expect(afterRedo.frozen).toBe(false);
    expect(afterRedo.frozenIntact).toBe(false);
    expect(() => approvalTarget(afterRedo)).toThrow();
    // a hand-written gate 2 approval that sits on a gate 1 redo does not confirm the freeze either
    const onRedo = addGateRecord(redone, { gate: 2, action: "approve", date: "2026-10-07", fingerprint: fp });
    const afterOnRedo = parseIdeaDocument(onRedo);
    expect(afterOnRedo.stage).toBe("探索");
    expect(afterOnRedo.frozenIntact).toBe(false);
    expect(() => approvalTarget(afterOnRedo)).toThrow();
    // re-approving gate 1 does not bring the old gate 2 approval back: gate 2 has to be approved again
    const reapproved = addGateRecord(redone, { gate: 1, action: "approve", date: "2026-10-07" });
    const afterReapprove = parseIdeaDocument(reapproved);
    expect(afterReapprove.stage).toBe("ゲート1");
    expect(afterReapprove.frozen).toBe(false);
    expect(afterReapprove.frozenIntact).toBe(false);
    expect(() => approvalTarget(afterReapprove)).toThrow();
    // the run door is refused on the same reading, before any signature or Issue
    const docPath = join(fx.typed, "idea.md");
    writeFileSync(docPath, reapproved);
    await expect(runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce: "never" })).rejects.toThrow();
    expect(existsSync(fx.ghLog)).toBe(false);
    // a fresh gate 2 approval over the same four points freezes again
    const refrozen = addGateRecord(reapproved, { gate: 2, action: "approve", date: "2026-10-08", fingerprint: fp });
    const afterFreeze = parseIdeaDocument(refrozen);
    expect(afterFreeze.stage).toBe("凍結");
    expect(afterFreeze.frozen).toBe(true);
    expect(afterFreeze.frozenIntact).toBe(true);
  });

  test("AC-014: a challenge that was never verified cannot run", async () => {
    const fx = fixture();
    await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    const { nonce } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
    await expect(runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce })).rejects.toThrow();
    expect(existsSync(fx.ghLog)).toBe(false);
  });

  test("AC-021: replace needs exactly one place, and create refuses an existing file", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const filePath = join(fx.place, "note.md");
    const run = async (): Promise<string> => {
      const parsed = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
      const { nonce, challenge } = (await import("@idd/core")).createChallenge(buildIdeaExitContent(parsed, selectExitRows(parsed)));
      const result = await runIdeaExits({ conversationId: "c", documentPath: docPath, workspace: fx.typed, conversation: fakeConversation(), nonce, assertion: assertionFor(auth, challenge) });
      return result.outcomes[0]?.state ?? "none";
    };
    const install = (row: string): void => {
      const text = makeDoc({ places: [fx.place], gates: ["- ゲート 1: 2026-10-05 承認"], exits: [row] });
      writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    };
    // two matches: fails, file unchanged
    writeFileSync(filePath, "AAA\nBBB\nAAA\n");
    install(fileRow({ id: "EXIT-1", title: "replace", change: "置換", before: "AAA", after: "Z" }, filePath));
    expect(await run()).toBe("失敗");
    expect(readFileSync(filePath, "utf8")).toBe("AAA\nBBB\nAAA\n");
    // zero matches: fails, file unchanged
    install(fileRow({ id: "EXIT-1", title: "replace", change: "置換", before: "ZZZ", after: "Z" }, filePath));
    expect(await run()).toBe("失敗");
    expect(readFileSync(filePath, "utf8")).toBe("AAA\nBBB\nAAA\n");
    // exactly one: replaced
    install(fileRow({ id: "EXIT-1", title: "replace", change: "置換", before: "BBB", after: "CCC" }, filePath));
    expect(await run()).toBe("実行済み");
    expect(readFileSync(filePath, "utf8")).toBe("AAA\nCCC\nAAA\n");
    // create over an existing path fails
    install(fileRow({ id: "EXIT-1", title: "create", change: "作成", content: "x" }, filePath));
    expect(await run()).toBe("失敗");
    expect(readFileSync(filePath, "utf8")).toBe("AAA\nCCC\nAAA\n");
  });

  test("AC-025: talk and a type switch are refused while an exit run is going", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const conv = await makeConversation(fx, "chat");
    recordWrite(conv, docPath);
    const ch = await jsonOf<{ nonce: string; challenge: string }>(await api(fx, "POST", `/api/conversations/${conv}/idea/exits/challenge`, {}));
    expect(ch.nonce).toBeTruthy();
    process.env.GH_FAKE_DELAY_MS = "500";
    const running = api(fx, "POST", `/api/conversations/${conv}/idea/exits/run`, { nonce: ch.nonce, assertion: assertionFor(auth, ch.challenge) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await api(fx, "POST", `/api/conversations/${conv}/messages`, { text: "だめ" })).status).toBe(409);
    expect((await api(fx, "POST", `/api/conversations/${conv}/type`, { type: "idea" })).status).not.toBe(200);
    expect((await running).status).toBe(200);
  });

  test("F-1: the gate door refuses while an exit run is going and writes nothing", async () => {
    const fx = fixture();
    const auth = await registerPasskey();
    const docPath = join(fx.typed, "idea.md");
    const text = makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"], exits: [issueRow({ id: "EXIT-1", title: "issue" }, [{ id: "EXIT-1-1", title: "one", body: "body" }])] });
    writeFileSync(docPath, addGateRecord(text, { gate: 2, action: "approve", date: "2026-10-05", fingerprint: fingerprintOf(text) }));
    const conv = await makeConversation(fx, "chat");
    recordWrite(conv, docPath);
    const ch = await jsonOf<{ nonce: string; challenge: string }>(await api(fx, "POST", `/api/conversations/${conv}/idea/exits/challenge`, {}));
    expect(ch.nonce).toBeTruthy();
    process.env.GH_FAKE_DELAY_MS = "500";
    const running = api(fx, "POST", `/api/conversations/${conv}/idea/exits/run`, { nonce: ch.nonce, assertion: assertionFor(auth, ch.challenge) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const before = readFileSync(docPath, "utf8");
    const refused = await api(fx, "POST", `/api/conversations/${conv}/idea/gates`, { gate: 1, action: "approve" });
    expect(refused.status).toBe(409);
    expect(readFileSync(docPath, "utf8")).toBe(before);
    expect((await running).status).toBe(200);
    const after = parseIdeaDocument(readFileSync(docPath, "utf8"), docPath);
    expect(after.gates.filter((gate) => gate.gate === 1 && gate.action === "approve")).toHaveLength(1);
    expect(after.status).toBe("探索中");
  });

  test("AC-001/AC-002: a gate record's position comes from the notice or the write / edit that first wrote its line", async () => {
    const fx = fixture();
    const conv = await makeConversation(fx, "idea");
    const path1 = join(fx.bare, "idea1.md");
    const path2 = join(fx.bare, "idea2.md");
    const path3 = join(fx.bare, "idea3.md");
    const path4 = join(fx.bare, "idea4.md");
    const empty = makeDoc({});
    const gate = (date: string): string => `- ゲート 1: ${date} 承認`;
    const gate2 = (date: string, fingerprint: string): string => `- ゲート 2: ${date} 承認 指紋 ${fingerprint}`;
    const position = async (): Promise<{ entryId: string | null; stage: string }[]> =>
      (await jsonOf<{ document: { gates: { entryId: string | null; stage: string }[] } }>(await api(fx, "GET", `/api/conversations/${conv}/idea`))).document.gates;

    // (a) the notice: the document already holds the record, but the branch's own write did not write it
    writeFileSync(path1, makeDoc({ gates: [gate("2026-10-05")] }));
    appendEntries(conv, [writeEntry(path1, empty, "w1"), resultEntry("w1")]);
    const [notice] = appendEntries(conv, [userEntry(gateNotice(1, "approve"))]);
    expect((await position()).at(-1)?.entryId).toBe(notice);

    // (b) an edit: the record's line first appeared in the new text; a failed edit before it is not counted
    const record2 = makeDoc({ gates: [gate2("2026-10-07", "abcdef12")] });
    writeFileSync(path2, record2);
    appendEntries(conv, [writeEntry(path2, empty, "w2"), resultEntry("w2")]);
    appendEntries(conv, [editEntry(path2, record2, "ef1"), resultEntry("ef1", true)]);
    const [editNew] = appendEntries(conv, [editEntry(path2, record2, "e2"), resultEntry("e2")]);
    expect((await position()).at(-1)?.entryId).toBe(editNew);

    // (c) the older edit shape (one newText beside the path)
    const record3 = makeDoc({ gates: [gate2("2026-10-08", "abcdef13")] });
    writeFileSync(path3, record3);
    appendEntries(conv, [writeEntry(path3, empty, "w3"), resultEntry("w3")]);
    const [editOld] = appendEntries(conv, [editEntry(path3, record3, "e3", true), resultEntry("e3")]);
    expect((await position()).at(-1)?.entryId).toBe(editOld);

    // (d) a write whose content is the document itself
    const record4 = makeDoc({ gates: [gate2("2026-10-09", "abcdef14")] });
    writeFileSync(path4, record4);
    const [write4] = appendEntries(conv, [writeEntry(path4, record4, "w4"), resultEntry("w4")]);
    expect((await position()).at(-1)?.entryId).toBe(write4);

    // (e) a record no entry ever wrote: the position is empty
    const path5 = join(fx.bare, "idea5.md");
    writeFileSync(path5, makeDoc({ gates: [gate2("2026-10-10", "abcdef15")] }));
    appendEntries(conv, [writeEntry(path5, empty, "w5"), resultEntry("w5")]);
    expect((await position()).at(-1)?.entryId).toBeNull();

    // (f) the notice stored as text blocks instead of a plain string
    const path6 = join(fx.bare, "idea6.md");
    const gate6 = "- ゲート 1: 2026-10-11 やり直し — テスト印";
    writeFileSync(path6, makeDoc({ gates: [gate6] }));
    appendEntries(conv, [writeEntry(path6, empty, "w6"), resultEntry("w6")]);
    const blockNotice = gateNotice(1, "redo", "テスト印");
    const [noticeBlocks] = appendEntries(conv, [userEntryBlocks(blockNotice)]);
    expect((await position()).at(-1)?.entryId).toBe(noticeBlocks);
  });

  test("AC-003: the status door reports each record's own stage, read the same way the whole document's stage is", async () => {
    const fx = fixture();
    const base = makeDoc({});
    const fp = fingerprintOf(addGateRecord(base, { gate: 1, action: "approve", date: "2026-10-05" }));
    const text = makeDoc({
      gates: [
        "- ゲート 1: 2026-10-05 承認",
        `- ゲート 2: 2026-10-05 承認 指紋 ${fp}`,
        "- ゲート 1: 2026-10-06 やり直し — 詰め直し",
        `- ゲート 2: 2026-10-07 承認 指紋 ${fp}`,
      ],
    });
    const docPath = join(fx.bare, "stages.md");
    writeFileSync(docPath, text);
    const conv = await makeConversation(fx, "idea");
    recordWrite(conv, docPath);
    const doc = (await jsonOf<{ document: { stage: string; gates: { stage: string }[] } }>(await api(fx, "GET", `/api/conversations/${conv}/idea`))).document;
    expect(doc.gates.map((gate) => gate.stage)).toEqual(["ゲート1", "凍結", "探索", "探索"]);
    expect(doc.stage).toBe("探索");
  });

  test("AC-004: reading a record's position does not wake pi", async () => {
    const fx = fixture();
    const docPath = join(fx.bare, "quiet.md");
    writeFileSync(docPath, makeDoc({ gates: ["- ゲート 1: 2026-10-05 承認"] }));
    const conv = await makeConversation(fx, "idea");
    recordWrite(conv, docPath);
    const prompts = (): number => (existsSync(fx.log) ? readFileSync(fx.log, "utf8").split("\n").filter(Boolean).length : 0);
    const before = prompts();
    const first = await jsonOf<{ document: { gates: { entryId: string | null }[] } }>(await api(fx, "GET", `/api/conversations/${conv}/idea`));
    await api(fx, "GET", `/api/conversations/${conv}/idea`);
    expect(first.document.gates).toHaveLength(1);
    expect(prompts()).toBe(before);
  });
});

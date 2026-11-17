import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach } from "bun:test";

import { tmpDir } from "./tmp.ts";

/**
 * Run records written the way the harnesses write them, under a state dir of the test's own: a pi conversation
 * (system / user / assistant / toolResult messages), a Claude conversation (stream-json, the request only in
 * `sent/`) and a one-off run. The strings below are what the tests look for in a reading, so a leak is found by value.
 */
export const KEY_VALUE = "sk-live-AbCdEfGhIjKlMnOpQrStUv";
export const DOTENV_BODY = `API_KEY=${KEY_VALUE}\nDB_NAME=plain-name\n`;
export const THINKING = "思考の中身は渡った文ではない";
export const REPLY = "モデルが書いた本文は渡った文ではない";
export const PREAMBLE = "You are an expert coding assistant operating inside pi";
export const ADDENDUM_TEXT = "この run の規約。計画役は 6 欄で書く。";
export const ADDENDUM = `<addendum>\n${ADDENDUM_TEXT}\n</addendum>`;
export const AGENTS = "# AGENTS.md\n\nこの repo の規範。\n";
export const REQUEST_1 = "<propter-system-message>\n  <task>最初の依頼文。&lt;そのまま&gt; 出る。</task>\n</propter-system-message>";
export const REQUEST_2 = "<propter-system-message>\n  <task>2 回目の封筒。</task>\n</propter-system-message>";
export const INJECT = '<propter-intent path="src/a.ts">\nこのファイルの Choice の why。\n</propter-intent>';

const jsonl = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

export const msg = (role: string, rest: Record<string, unknown>, type = "message_start") => ({ type, message: { role, ...rest } });
export const text = (t: string) => [{ type: "text", text: t }];

/** a file of a run's record, its directory made on the way */
export function put(dir: string, name: string, body: string): void {
  const file = join(dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

/** a test file calls this once at its top: the state dir the tests point at is put back after each test */
export function restoreStateDir(): void {
  const before = process.env.IDD_STATE_DIR;
  afterEach(() => {
    if (before === undefined) delete process.env.IDD_STATE_DIR;
    else process.env.IDD_STATE_DIR = before;
  });
}

/** a fresh state dir that `IDD_STATE_DIR` points at */
export function stateRoot(): string {
  const root = tmpDir("idd-delivered-");
  process.env.IDD_STATE_DIR = root;
  return root;
}

/** a worktree directory of a run's own: the paths in a record are shown relative to it */
export function worktreeDir(root: string, name: string): string {
  const wt = join(root, "wt", name);
  mkdirSync(wt, { recursive: true });
  return wt;
}

export function runDir(root: string, id: string, lane: Record<string, unknown>): string {
  const dir = join(root, "lanes", id);
  put(dir, "lane.json", JSON.stringify({ id, role: "planner-x", model: "m", worktree: "/wt", spec: "", report: "", started_at: "2026-11-11T01:00:00.000Z", ...lane }));
  return dir;
}

export interface PiOptions {
  idd?: string;
  role?: string;
  request?: string;
  /** the second reply's envelope; none: one reply only */
  second?: string;
  /** the tool result that is not the `.env` one */
  fileResult?: string;
  /** the run's worktree (default: a directory of its own) */
  worktree?: string;
  /** the system prompt's one context file */
  contextPath?: string;
  contextBody?: string;
}

/** a pi conversation of one or two replies; reply 1 opens `.env` and `src/a.ts` (with a hook's block beside the second) */
export function piConversation(root: string, id: string, o: PiOptions = {}): string {
  const dir = runDir(root, id, { worktree: o.worktree ?? worktreeDir(root, id), mode: "conversation", slot: "planner", idd_id: o.idd ?? "IDD-9", role: o.role ?? "planner-x", role_preset: { name: o.role ?? "planner-x", harness: "pi" } });
  const turns = [{ n: 1, message: "m1.md", status: "done" }, ...(o.second ? [{ n: 2, message: "m2.md", status: "done" }] : [])];
  put(dir, "turns.jsonl", jsonl(turns));
  put(dir, "message-types.json", JSON.stringify({ "m1.md": "s1_prep_start", "m2.md": "plan_review_findings" }));
  put(dir, "sent/m1.md", o.request ?? REQUEST_1);
  if (o.second) put(dir, "sent/m2.md", o.second);
  put(dir, "turns/1.jsonl", jsonl([
    { id: "reply-1", type: "response" },
    msg("system", {
      content: "",
      sections: {
        preamble: PREAMBLE, tools: "<tools>read</tools>", rules: "<rules>r</rules>", docs: "<docs>d</docs>", addendum: ADDENDUM,
        project_context: `<project_context>\nProject-specific instructions:\n\n<project_instructions path="${o.contextPath ?? "/wt/AGENTS.md"}">\n${o.contextBody ?? AGENTS}</project_instructions>\n\n</project_context>`,
        skills: "<skills>s</skills>", cwd: "<cwd>/wt</cwd>",
      },
    }),
    msg("user", { content: text(o.request ?? REQUEST_1) }),
    msg("assistant", { content: [{ type: "thinking", thinking: "" }] }),
    { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: THINKING } },
    msg("assistant", { content: [{ type: "thinking", thinking: THINKING }, { type: "toolCall", id: "c1", name: "read", arguments: { path: ".env" } }, { type: "toolCall", id: "c2", name: "read", arguments: { path: "src/a.ts" } }] }, "message_end"),
    msg("toolResult", { toolCallId: "c1", toolName: "read", content: text(DOTENV_BODY) }),
    msg("toolResult", { toolCallId: "c2", toolName: "read", content: [...text(o.fileResult ?? "export const a = 1;\n"), ...text(INJECT)] }),
    msg("assistant", { content: text(REPLY) }),
  ]).trimEnd());
  if (o.second) put(dir, "turns/2.jsonl", jsonl([msg("user", { content: text(o.second) })]));
  return dir;
}

/** the two stream rows of a Claude `Read`: the call, and the result that comes back as a plain string */
const claudeRead = (id: string, path: string, body: string) => [
  { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: path } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: body }] } },
];

/** a Claude conversation: the request is only in `sent/`, the stream has the hook's answer and the tool results */
export function claudeConversation(root: string, id: string): string {
  const wt = worktreeDir(root, id);
  const dir = runDir(root, id, { worktree: wt, mode: "conversation", slot: "executor", idd_id: "IDD-9", role: "executor-claude", role_preset: { name: "executor-claude", harness: "claude" } });
  put(dir, "turns.jsonl", jsonl([{ n: 1, message: "c1.md", status: "done" }]));
  put(dir, "message-types.json", JSON.stringify({ "c1.md": "s2_start" }));
  put(dir, "sent/c1.md", REQUEST_1);
  put(dir, "turns/1.jsonl", jsonl([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "system", subtype: "hook_response", hook_event: "SessionStart", hook_name: "SessionStart:startup", output: JSON.stringify({ hookSpecificOutput: { additionalContext: "session 開始の案内の文" } }) },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: REPLY }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: join(wt, ".env") } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: DOTENV_BODY }] } },
    ...claudeRead("t2", join(wt, "src/a.ts"), "export const a = 1;"),
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]));
  return dir;
}

/** a one-off Claude run whose spec names the lane; the brief is the request */
export function claudeOneOff(root: string, id: string, lane: string): string {
  const spec = join(root, `${id}-spec.yaml`);
  writeFileSync(spec, `role: reviewer\nlane: ${lane}\n`);
  const dir = runDir(root, id, { role: "reviewer", spec, role_preset: { name: "reviewer", harness: "claude" } });
  put(dir, "brief.md", `brief of one run\ntoken: Bearer ${KEY_VALUE}\n`);
  put(dir, "events.jsonl", jsonl([{ type: "assistant", message: { content: [{ type: "text", text: REPLY }] } }]));
  return dir;
}

/** a one-off pi run made of the stream rows given: the request first, then whatever the test wants the stream to hold */
export function piOneOff(root: string, id: string, rows: unknown[], worktree = worktreeDir(root, id)): string {
  const dir = runDir(root, id, { worktree, role: "reviewer", role_preset: { name: "reviewer", harness: "pi" } });
  put(dir, "events.jsonl", jsonl([msg("user", { content: text("依頼") }), ...rows]));
  return dir;
}

/** an assistant message's end that calls one tool, and the result that comes back */
export function toolExchange(call: { id: string; name: string; arguments: Record<string, unknown> }, result: string): unknown[] {
  return [
    msg("assistant", { content: [{ type: "toolCall", ...call }] }, "message_end"),
    msg("toolResult", { toolCallId: call.id, toolName: call.name, content: text(result) }),
  ];
}

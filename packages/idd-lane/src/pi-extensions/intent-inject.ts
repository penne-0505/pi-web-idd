import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASK_ENV } from "../inject.ts";
import { askTitle } from "../pi-rpc-child.ts";

/**
 * The pi side of the injection. It holds no rule of its own: it turns pi's tool events into the `idd intent hook`
 * input, calls that verb, and adds back what it answers. Everything about which Choice comes up, how much of it
 * is handed over, and what is already handed over lives in the verb, so the pi and Claude Code sides cannot drift
 * (DEC-107-1).
 *
 * Nothing here throws out of a handler and nothing here ever asks pi to block a tool: a `tool_call` handler that
 * throws blocks the tool as a fail-safe, and a broken injection must never stop the agent's work. pi's Bash is
 * not a route into the injection either: this bridge sends only read and edit/write events.
 *
 * The CLI is named by `IDD_INTENT_CLI` (the environment the lane's own harness writes), so a test can put a
 * stand-in in its place.
 */

/** the slice of pi's extension API this file uses, declared here so it does not import pi's SDK */
interface PiToolCallEvent {
  type: "tool_call";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}
interface PiToolResultEvent {
  type: "tool_result";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: { type?: string; text?: string }[];
  isError: boolean;
}
interface PiExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute(toolCallId: string, args: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: PiToolContext): Promise<unknown>;
}
/** the tool context the `ask` tool needs: the dialog methods and whether the harness can answer them */
interface PiToolContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: { input(title: string, placeholder?: string): Promise<string | undefined> };
}
export interface PiIntentApi {
  on(event: string, handler: (event: never) => unknown): unknown;
  registerTool(tool: PiToolDefinition): void;
  exec(command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<PiExecResult>;
}

/** how long the bridge waits for the CLI before it goes on without the injection */
export const CLI_TIMEOUT_MS = 5000;

/**
 * How long `ask` waits for the questions CLI. The CLI retries a report through the engine's replacement window
 * (`IDD_REPORT_RETRY_MS`, 60s by default, with `IDD_REPORT_RETRY_INTERVAL_MS` between tries). Cutting the call before
 * that window ends would report the question as sent when it never was: the agent would end its turn and no card
 * would appear (C-123-2). So `ask` waits for the window plus the interval and a margin. The judging calls keep
 * `CLI_TIMEOUT_MS`.
 */
export const ASK_SEND_MARGIN_MS = 15_000;

export function askSendTimeoutMs(): number {
  const positive = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return positive(process.env.IDD_REPORT_RETRY_MS, 60_000) + positive(process.env.IDD_REPORT_RETRY_INTERVAL_MS, 3_000) + ASK_SEND_MARGIN_MS;
}

const TOOL_NAMES: Record<string, "Read" | "Edit" | "Write"> = { read: "Read", edit: "Edit", write: "Write" };

/** what `ask` returns when it cannot wait: the answer still arrives, as the next message */
export const ASK_NEXT_MESSAGE = "答えは次の伝言で届く。応答を終えよ";

/**
 * What `ask` returns when the send call was cut: whether the question was recorded is unknown, so it must not say
 * the answer will arrive; it tells the agent to ask again instead (C-123-2).
 */
export const ASK_SEND_UNKNOWN = "質問を送れたか確かめられなかった。もう一度 ask で尋ねるか、`idd report questions` で尋ねること。";

function cliPath(): string {
  return process.env.IDD_INTENT_CLI?.trim() || "idd";
}

function sessionId(): string {
  return process.env.PI_SESSION_ID?.trim() || "default";
}

/** `pi.exec` has no stdin, so the verb's JSON goes through a file of its own */
async function callHook(pi: PiIntentApi, payload: Record<string, unknown>, cwd: string): Promise<{ text: string | null; rows: unknown[] }> {
  const dir = mkdtempSync(join(tmpdir(), "idd-intent-"));
  const file = join(dir, "input.json");
  try {
    writeFileSync(file, JSON.stringify(payload));
    const r = await pi.exec(cliPath(), ["intent", "hook", "--input", file], { timeout: CLI_TIMEOUT_MS, cwd });
    const body = (r?.stdout ?? "").trim();
    if (!body) return { text: null, rows: [] };
    const parsed = JSON.parse(body) as { text?: unknown; rows?: unknown; hookSpecificOutput?: { additionalContext?: unknown } };
    const text = typeof parsed.text === "string" && parsed.text ? parsed.text : typeof parsed.hookSpecificOutput?.additionalContext === "string" && parsed.hookSpecificOutput.additionalContext ? parsed.hookSpecificOutput.additionalContext : null;
    return { text, rows: Array.isArray(parsed.rows) ? parsed.rows : [] };
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not worth failing over */ }
  }
}

/** append the injection to a tool result without touching what was already there */
function appendText(content: PiToolResultEvent["content"], text: string): PiToolResultEvent["content"] {
  const kept = Array.isArray(content) ? content : [];
  return [...kept, { type: "text", text }];
}

function textResult(text: string): unknown {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * The leading pretty-printed JSON the questions CLI writes on success, and the batch id in it. The whole stdout
 * is not JSON: a line telling the agent to end its turn follows the object, so only the first block is parsed.
 */
export function readBatchId(stdout: string): string | null {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.trim() === "{");
  if (start < 0) return null;
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "}") { end = i; break; }
  }
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(lines.slice(start, end + 1).join("\n")) as { batch_id?: unknown };
    return typeof parsed.batch_id === "string" && parsed.batch_id ? parsed.batch_id : null;
  } catch {
    return null;
  }
}

/** a placeholder for the harness's dialog: the first question's text, when the agent wrote one */
function firstQuestion(args: Record<string, unknown>): string | undefined {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const first = questions[0] as { question?: unknown } | undefined;
  return typeof first?.question === "string" ? first.question : undefined;
}

/**
 * The `ask` tool: send the questions through the harness's own questions verb, then ask the supervisor for the
 * answer as an extension dialog and wait. The supervisor finds the answer's message and hands its body back, so
 * the tool's result carries the batch and the question ids the agent names in the Choices it makes.
 *
 * Nothing here throws: a question that cannot be sent or waited for comes back as the result's text, and the
 * agent ends its turn with the answer arriving as the next message.
 */
function registerAsk(pi: PiIntentApi): void {
  pi.registerTool({
    name: "ask",
    label: "ask",
    description: "Purpose を決められない分岐でユーザーに尋ね、答えが来るまで待つ。入力は `idd report questions` が読む JSON と同じ形（`{questions:[...]}`）。質問は今の質問の口に送られ、答えは同じ応答の道具の結果として返る。答えが計画や実装を変えたら、その判断の記録の why に因果を残し、出どころとして質問の id（question_id）を名指すようにすること。",
    promptSnippet: "Purpose を決められない分岐では、推測で進まず ask で尋ね、答えを待って続ける",
    promptGuidelines: [
      "Purpose を決められない分岐、または契約が不明瞭な所では、推測で進まず `ask` で尋ね、答えを待って続ける。",
      "答えが Choice を変えたら、その Choice の Why に因果を残し、出どころとして質問の question_id を名指す。",
      "`ask` が無い場合は、応答を止めて `idd report questions` で尋ねる。",
    ],
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              question_id: { type: "string", description: "答えの出どころとして Choice が名指す id" },
              question: { type: "string" },
              context: { type: "string" },
              options: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: {
                  type: "object",
                  properties: {
                    index: { type: "number" },
                    label: { type: "string", description: "40 文字まで" },
                    description: { type: "string", description: "選ぶものの意味" },
                    recommendation: { type: "string", enum: ["recommended", "acceptable", "not_recommended"] },
                    rationale: { type: "string", description: "検証済み事実に基づく根拠" },
                  },
                  required: ["index", "label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question_id", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, args: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, ctx?: PiToolContext) {
      const dir = mkdtempSync(join(tmpdir(), "idd-ask-"));
      const file = join(dir, "questions.json");
      try {
        writeFileSync(file, JSON.stringify({ questions: Array.isArray(args.questions) ? args.questions : [] }));
        const r = await pi.exec(cliPath(), ["report", "questions", "--file", file], { timeout: askSendTimeoutMs(), cwd: ctx?.cwd ?? process.cwd() });
        if (!r) return textResult("質問を送れませんでした（CLI の応答がありません）");
        // a call cut at the timeout cannot say whether the question landed: the answer is not on its way for sure
        if (r.killed) return textResult(ASK_SEND_UNKNOWN);
        if (r.code !== 0) {
          // the shape check refused it: the CLI's own words, and no dialog goes out
          return textResult((r.stderr ?? "").trim() || `質問を送れませんでした（exit ${r.code}）`);
        }
        const batchId = readBatchId(r.stdout ?? "");
        if (!batchId) return textResult(ASK_NEXT_MESSAGE);
        if (!ctx?.hasUI || !ctx.ui) return textResult(ASK_NEXT_MESSAGE);
        const value = await ctx.ui.input(askTitle(batchId), firstQuestion(args));
        if (value === undefined) return textResult(ASK_NEXT_MESSAGE);
        return textResult(String(value));
      } catch (err) {
        return textResult(`質問を送れませんでした: ${String(err)}`);
      } finally {
        try { unlinkSync(file); } catch { /* already gone */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not worth failing over */ }
      }
    },
  });
}

export default function registerIntentInject(pi: PiIntentApi): void {
  // an edit / write hit is judged before the tool runs but recorded only after its result comes back: a hit whose
  // result never arrives must not count as told, or the Choice would never reach the agent (DEC-107-5)
  const pending = new Map<string, { text: string | null; rows: unknown[] }>();

  pi.on("tool_call", async (event: PiToolCallEvent) => {
    try {
      const tool = TOOL_NAMES[event.toolName];
      if (tool !== "Edit" && tool !== "Write") return;
      const cwd = process.cwd();
      const payload = {
        idd_mode: "plan",
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: event.input,
        cwd,
        session_id: sessionId(),
      };
      const judged = await callHook(pi, payload, cwd);
      if (judged.text === null && !judged.rows.length) return;
      pending.set(event.toolCallId, judged);
    } catch {
      /* an injection that cannot be judged leaves the tool exactly as it was */
    }
    return;
  });

  pi.on("tool_result", async (event: PiToolResultEvent) => {
    try {
      const tool = TOOL_NAMES[event.toolName];
      const cwd = process.cwd();
      if (tool === "Edit" || tool === "Write") {
        // the result, failed or not, gets the notice, and only then is the row written
        const judged = pending.get(event.toolCallId);
        if (!judged) return;
        pending.delete(event.toolCallId);
        const payload = {
          idd_mode: "record",
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: event.input,
          cwd,
          session_id: sessionId(),
          idd_rows: judged.rows,
        };
        await callHook(pi, payload, cwd);
        if (judged.text === null) return;
        return { content: appendText(event.content, judged.text) };
      }
      if (tool !== "Read" || event.isError) return;
      const payload = {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: event.input,
        cwd,
        session_id: sessionId(),
      };
      const judged = await callHook(pi, payload, cwd);
      if (!judged.text) return;
      return { content: appendText(event.content, judged.text) };
    } catch {
      return;
    }
  });

  pi.on("session_compact", async () => {
    try {
      await callHook(pi, { hook_event_name: "Compact", session_id: sessionId(), cwd: process.cwd() }, process.cwd());
    } catch {
      /* a compaction that cannot be noted only means the bodies are not handed over again */
    }
  });

  pi.registerTool({
    name: "intent_lookup",
    label: "intent_lookup",
    description: "Look the intent records (Choices) up by repo-relative path, before opening or changing the file. Returns, as text, every Choice whose file or dir Place is the path itself (id, the unconfirmed mark, chosen, Purpose, how it was met, why, free), the other Choices of the same module as one line each, and the root's Choices as a count. Pass --json (the CLI) for the whole records.",
    promptSnippet: "Look the intent records up with intent_lookup for a path before you open or change it",
    promptGuidelines: [
      "Use intent_lookup with the paths you are about to read or change, so the why and free of the Choices that govern them come to you first.",
    ],
    // a plain JSON Schema: the provider reads the same shape a TypeBox schema serializes to
    parameters: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, description: "repo-root relative paths" } },
      required: ["paths"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, args: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, ctx?: PiToolContext) {
      const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : [];
      if (!paths.length) throw new Error("paths を 1 つ以上渡してください");
      const r = await pi.exec(cliPath(), ["intent", "lookup", ...paths], { timeout: CLI_TIMEOUT_MS, cwd: ctx?.cwd ?? process.cwd() });
      const body = (r?.stdout ?? "").trim();
      if (!r || r.code !== 0 || !body) throw new Error(r?.stderr?.trim() || `intent lookup が exit ${r?.code ?? "?"} で終わりました`);
      return { content: [{ type: "text", text: body }], details: undefined };
    },
  });

  // only a reply whose supervisor can wait for an answer gets `ask`: the judging stages would wait out their budget
  if (process.env[ASK_ENV] === "1") registerAsk(pi);
}

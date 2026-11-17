import { readFileSync } from "node:fs";

import { pipelineAgentDir, readRoles, resolveRole, runPiOnce as runPiOneShot, type RolePreset } from "@idd/lane";

import { prepareAgentDirAsync } from "./agent-dir-prep.ts";
import { appendCostLine, costTotalOf, type CostLine, type PiUsage } from "./conversation-events.ts";

/*
 * A conversation's title. The engine asks a separate, cheap role (`titler`) in a one-shot `pi --mode json`
 * run that has no tools, no skills, no extensions, no context files and no session; the conversation's own
 * pi is never asked for it, so no title instruction or generated title can enter the conversation's record.
 * The run's usage is added to the conversation's cost ledger under a `title` mark.
 */

export interface TitleGenerationResult {
  title: string;
  model: string;
}

/** the most turns the material is cut from when roles.yaml does not say */
const DEFAULT_TITLE_TURNS = 3;
/** the longest single message handed to the titler */
const MAX_MESSAGE_CHARS = 2000;
/** the most characters a generated title keeps */
const MAX_TITLE_CHARS = 80;

/** how the title is asked for; the material follows it in the same one-shot prompt */
const TITLE_INSTRUCTION = [
  "次の会話のやりとりに、短いタイトルを付けてください。",
  "出力はタイトルだけにしてください。前置き・後書き・引用符・コードフェンスは書かない。",
  "題名は 30 文字程度までの 1 行。会話の話題が分かるように。",
].join("\n");

/** the number of trailing turns the material is cut from (roles.yaml `defaults.title_context_turns`) */
export function titleContextTurns(): number {
  try {
    const value = readRoles().defaults.titleContextTurns;
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_TITLE_TURNS;
  } catch {
    return DEFAULT_TITLE_TURNS;
  }
}

interface Turn {
  role: "user" | "assistant";
  text: string;
}

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

/** the user and assistant messages of a record's entries, in file order */
function turnsOf(entries: unknown[]): Turn[] {
  const turns: Turn[] = [];
  for (const raw of entries) {
    const entry = raw as { type?: string; message?: { role?: unknown; content?: unknown } } | null;
    if (!entry || entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(entry.message?.content).trim();
    if (!text) continue;
    turns.push({ role, text: text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text });
  }
  return turns;
}

/**
 * The last `turns` turns as one prompt: a turn is a person's message plus the assistant messages that
 * follow it, up to the next person's message. Only text is carried; tool calls, tool results, thinking and
 * compaction are left out.
 */
export function titleMaterial(entries: unknown[], turns = titleContextTurns()): string {
  const all = turnsOf(entries);
  const groups: Turn[][] = [];
  for (const turn of all) {
    if (turn.role === "user" || groups.length === 0) groups.push([turn]);
    else groups[groups.length - 1].push(turn);
  }
  const chosen = groups.slice(-Math.max(1, turns));
  const lines: string[] = [];
  for (const group of chosen) {
    for (const turn of group) lines.push(`${turn.role === "user" ? "利用者" : "assistant"}: ${turn.text}`);
  }
  return lines.join("\n\n");
}

/** the material read from a session record file, without going through pi */
export function readTitleMaterial(file: string, turns = titleContextTurns()): string {
  const entries: unknown[] = [];
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return ""; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a partial line */ }
  }
  return titleMaterial(entries, turns);
}

/** the one-shot arguments for a pi run with as few moving parts as pi can run with */
export function buildOneShotArgs(role: RolePreset, prompt: string): string[] {
  return [
    "-p", "--mode", "json", "--model", role.model, "--thinking", role.thinking,
    "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--no-session", "--no-approve",
    "--system-prompt", "",
    prompt,
  ];
}

/** the one-shot arguments for the titler */
export function buildTitleArgs(role: RolePreset, material: string): string[] {
  return buildOneShotArgs(role, `${TITLE_INSTRUCTION}\n\n${material}`);
}

/** the assistant text and usage of a `--mode json` run, read from its JSONL stdout */
export function parseTitleOutput(stdout: string): { text: string; usage?: PiUsage } {
  let text = "";
  let usage: PiUsage | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let record: { type?: string; message?: { role?: unknown; content?: unknown; usage?: PiUsage } };
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== "message_end") continue;
    const message = record.message;
    if (!message || message.role !== "assistant") continue;
    const block = messageText(message.content);
    if (block) text = block;
    if (message.usage) usage = message.usage;
  }
  return { text, usage };
}

/** the first line of the titler's answer, stripped of quotes and fences, and capped */
export function cleanTitle(text: string): string {
  const first = text.trim().split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const unquoted = first
    .replace(/^```[^\n]*\n?/, "").replace(/```$/, "")
    .replace(/^[「『"']+|[」』"']+$/g, "")
    .replace(/^(title|タイトル)\s*[:：]\s*/i, "")
    .trim();
  return unquoted.length > MAX_TITLE_CHARS ? unquoted.slice(0, MAX_TITLE_CHARS).trim() : unquoted;
}

/** the clocks of a one-shot run, replaced by a test that cannot wait out a role's minutes */
export interface OneShotLimits {
  timeoutMs?: number;
  graceMs?: number;
  drainMs?: number;
}

let limits: OneShotLimits | null = null;

/** swap the clocks every title and card-text run uses (a test); null puts the role's budget back */
export function setOneShotLimits(next: OneShotLimits | null): void {
  limits = next;
}

/**
 * Run pi once with these args and resolve its stdout; `what` names the run in a failure message. The run is the
 * lane package's one-shot, so a child that outlives its role's budget is stopped there and this rejects: a title or
 * a card sentence never holds its in-flight mark past the limit.
 */
export async function runPiOnce(role: RolePreset, args: string[], agentDir: string, what: string): Promise<string> {
  const run = await runPiOneShot(args, {
    agentDir,
    timeoutMs: limits?.timeoutMs ?? Math.max(1, role.budgetMinutes) * 60_000,
    ...(limits?.graceMs === undefined ? {} : { graceMs: limits.graceMs }),
    ...(limits?.drainMs === undefined ? {} : { drainMs: limits.drainMs }),
  });
  if (run.timedOut) throw new Error(`${what}が時間切れで ${run.signal ?? `exit ${run.code}`} になりました${run.stderr ? `: ${run.stderr.slice(-300)}` : ""}`);
  if (run.code !== 0) throw new Error(`${what}が ${run.signal ?? `exit ${run.code}`} で終わりました${run.stderr ? `: ${run.stderr.slice(-300)}` : ""}`);
  return run.stdout;
}

/** append one run's usage to the conversation cost ledger; a run that used nothing writes no line */
export function recordUsageCost(role: RolePreset, usage: PiUsage | undefined, line: { sessionId: string; mode: string } & Partial<CostLine>): void {
  if (!usage) return;
  const cost = costTotalOf(usage);
  if (cost === 0 && !usage.input && !usage.output) return;
  appendCostLine({
    at: new Date().toISOString(),
    role: role.name,
    model: role.model,
    tokens: {
      input: Number(usage.input ?? 0) || 0,
      output: Number(usage.output ?? 0) || 0,
      cacheRead: Number(usage.cacheRead ?? 0) || 0,
      cacheWrite: Number(usage.cacheWrite ?? 0) || 0,
    },
    cost,
    ...line,
  });
}

/**
 * Generate one title for a conversation. The role's agent dir is prepared in a child (never in the engine's
 * loop), the run carries its own `PI_CODING_AGENT_DIR`, and the run's usage is appended to the conversation's
 * cost ledger with the `title` mark. A failure simply produces no title.
 */
export async function generateConversationTitle(opts: { sessionId: string; mode: string; material: string }): Promise<TitleGenerationResult> {
  const role = resolveRole("titler");
  await prepareAgentDirAsync(role.name);
  const stdout = await runPiOnce(role, buildTitleArgs(role, opts.material), pipelineAgentDir(role), "タイトルの生成");
  const parsed = parseTitleOutput(stdout);
  recordUsageCost(role, parsed.usage, { sessionId: opts.sessionId, mode: opts.mode, title: true });
  const title = cleanTitle(parsed.text);
  if (!title) throw new Error("タイトルが空でした");
  return { title, model: role.model };
}

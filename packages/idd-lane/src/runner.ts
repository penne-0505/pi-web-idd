import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync, appendFileSync, createWriteStream, renameSync, lstatSync, readlinkSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { checkClaudeQuota, checkClaudeConfigDir, isClaudeQuotaBlocked, quotaFromEvent, recordClaudeQuota, type ClaudeQuota, type ClaudeQuotaObservation, type QuotaFallback } from "./claude-quota.ts";
import { claudeBinary, laneStateDir, piBinary, repoRoot, systemctlBinary, systemdRunBinary } from "./paths.ts";
import { DEFAULT_LANE_CPU, DEFAULT_RUN_CACHE_TTL, DEFAULT_TOOL_TIMEOUT_MINUTES, FAILURE_KINDS, readRoles, resolveRole, resolveRoleModel, type CacheTtl, type FailureKind, type Harness, type LaneCpu, type RolePreset, type RolesFile } from "./roles.ts";
import { candidatesFor, checkCandidateStartable, contractOf, failureKindOf, providerOf, resolveRoute, type Candidate } from "./route.ts";
import { resolveCacheTtl } from "./cache-ttl.ts";
import { renderBrief, readSpec, specInstructions, type LaneSpec } from "./spec.ts";
import { recordInjection } from "../../idd-core/src/instruction/ledger.ts";
import { sceneOfStage } from "../../idd-core/src/instruction/scope.ts";
import type { Picked } from "../../idd-core/src/instruction/store.ts";
import { shimEnv } from "./shim.ts";
import { git, gitBytes, headOf, runShell, tail } from "./git.ts";
import { repoForPath, riskPathsEnvForPath } from "./repos.ts";
import { removeRunTmp, runTmpEnv } from "./run-tmp.ts";
import { checkPiRoleStartable, prepareAgentDir } from "./agent-dir.ts";
import { recordContextFiles } from "./context-files.ts";
import { liveLockOwner, markStoppedByUser } from "./conversation-lock.ts";
import { landChecks, landCheckSummary, type LandCheckSummary } from "../../idd-core/src/overlay/land-run.ts";
import { claudeEventEntries, knownSecrets, redactSecrets } from "./claude-stream.ts";
import { agentEnv, withoutRiskPaths } from "./agent-env.ts";
import { appendConsumption } from "./consumption.ts";
import { injectionEnv, injectionRecordPath, injectionStageOf, HOLD_TOKEN_ENV, intentInjectExtensionPath, RUN_LANE_ENV, runLaneEnv, stageGetsInjection, writeClaudeInjectSettings } from "./inject.ts";
import { assertReportWriter, needsReportTool, reportEnv, reportWriterExtensionPath, REPORT_TOOL_NAME } from "./pi-extensions/report-writer.ts";
import { TOOL_TIMEOUT_LOG } from "./lane-shell.ts";

/** idle: a conversation lane (Issue lane planner / executor) between two messages */
export type LaneStatus = "running" | "done" | "failed" | "timeout" | "stopped" | "idle";

/** one attempt of a run: a candidate's turn at the stage's work. A run may make several when a route fails */
export interface LaneAttempt {
  role: string;
  model: string;
  /** the model definition the call target came from; absent for a Claude Code role or a named model */
  model_name?: string;
  harness: Harness;
  /** claude | the model's provider name (ollama-cloud, openrouter, ...) */
  contract: string;
  /** the provider this attempt was pinned to, when the role wrote a provider column */
  provider?: string;
  started_at: string;
  ended_at?: string;
  status: LaneStatus;
  /** the kind of failure that ended it, when it has one */
  failure?: FailureKind;
  error?: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number };
  session_file?: string;
}

export interface LaneRecord {
  id: string;
  /** why the harness binary could not be started, when it could not */
  spawn_error?: string;
  role: string;
  model: string;
  /** the model definition the call target came from; absent for a Claude Code role or a named model */
  model_name?: string;
  worktree: string;
  title?: string;
  spec: string;
  report: string;
  status: LaneStatus;
  pid?: number;
  started_at: string;
  ended_at?: string;
  exit?: number;
  duration_ms?: number;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number };
  tool_calls?: number;
  turns?: number;
  final_text?: string;
  /** a require_clean role: the worktree ended as it began (see worktreeSnapshot); absent for a role that may write */
  clean?: boolean;
  /**
   * a require_clean role that changed a worktree it began on clean: what was kept aside after it ended (a commit on a
   * ref of the lane's own, so it can be taken back), whether the worktree then read as it began, and why it was not
   * taken back when it was not
   */
  worktree_restore?: { paths: string[]; ok: boolean; ref?: string; commit?: string; error?: string; skipped?: string };
  /** a require_clean role: the worktree as the attempt began, and as it ended */
  state_before_at?: string;
  state_before?: WorktreeSnapshot;
  state_after?: WorktreeSnapshot;
  head_before?: string;
  head_after?: string;
  report_md?: boolean;
  report_json?: boolean;
  session_file?: string;
  error?: string;
  /** snapshot of the role used, so the detached supervisor needs no roles.yaml */
  role_preset?: RolePreset;
  budget_minutes?: number;
  supervisor_pid?: number;
  /** times the supervisor resumed the session after an exit-0-without-report */
  resumes?: number;
  /** conversation: an Issue lane's planner / executor, one Claude Code conversation fed message by message */
  mode?: "conversation";
  /** conversation: the pipeline slot it was spawned for */
  slot?: string;
  /** conversation: the Issue lane (IDD-035) the agent reports as; absent for a lane with no Issue lane behind it */
  idd_id?: string;
  /** conversation: a message has reached Claude, so the next one resumes instead of creating the session */
  conversation_started?: boolean;
  /** conversation: the question batch a reply is waiting on, and when the wait began (a person's answer must reach it) */
  question_wait?: { batch_id: string; since: string };
  /** conversation: what the last supervisor saw in the queue when it let go (messages Claude never started on) */
  left_queued?: string[];
  /** a Claude Code lane: the subscription's windows as its run last reported them */
  claude_quota?: ClaudeQuotaObservation;
  /** the spec's Claude Code role was refused for the windows, and this lane runs its fallback (role / model are the fallback's) */
  quota_fallback?: QuotaFallback;
  /** the candidates left to try when the current attempt fails; each is one way the run may continue */
  pending?: Candidate[];
  /** every attempt this run made, in order; role / model / role_preset are the last one's */
  attempts?: LaneAttempt[];
  /** the switches this run made (the start-time one and any mid-run ones), each in the engine's shape */
  fallbacks?: QuotaFallback[];
  /** this run may not change roles (a model was named for it, or the stage forbade it) */
  no_fallback?: boolean;
  /** how long one shell tool call of the agent may run (roles.yaml defaults.tool_timeout_minutes when the lane was prepared); null: no limit */
  tool_timeout_minutes?: number | null;
  /** the prompt cache hold resolved when the lane was prepared; absent (a conversation, a lane from before the setting) is resolved when the env is built */
  cache_ttl?: CacheTtl;
  /** shell tool calls the harness cut at that limit */
  tool_timeouts?: number;
  /** roles.yaml defaults.shared_daemons when the lane was prepared: what its supervisor moves out of the scope instead of stopping */
  shared_daemons?: string[];
}

export function laneDir(id: string): string {
  return join(laneStateDir(), id);
}

function recordPath(id: string): string {
  return join(laneDir(id), "lane.json");
}

export function readLane(id: string): LaneRecord {
  const p = recordPath(id);
  if (!existsSync(p)) throw new Error(`lane がありません: ${id}`);
  return JSON.parse(readFileSync(p, "utf8")) as LaneRecord;
}

export function writeLane(rec: LaneRecord): void {
  writeFileSync(recordPath(rec.id), `${JSON.stringify(rec, null, 2)}\n`);
}

export function listLanes(): LaneRecord[] {
  const root = laneStateDir();
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "lane.json")))
    .map((d) => JSON.parse(readFileSync(join(root, d.name, "lane.json"), "utf8")) as LaneRecord)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/**
 * A lane id, with its directory created: the id is claimed by the mkdir itself, so two lanes of the same
 * role started in the same second (parallel reviews) never share a directory.
 */
export function claimLaneId(role: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const base = `${ts}-${role}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}-${n}`;
    try {
      mkdirSync(laneDir(id));
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface StreamSummary {
  usage?: LaneRecord["usage"];
  toolCalls: number;
  turns: number;
  finalText: string;
  sessionFile?: string;
  /** Claude Code only: the last rate_limit_event of the stream */
  quota?: ClaudeQuota;
  /** Claude Code only: Bash calls Claude Code cut at its timeout */
  toolTimeouts?: number;
}

export function summarizeEvents(eventsPath: string): StreamSummary {
  const out: StreamSummary = { toolCalls: 0, turns: 0, finalText: "" };
  if (!existsSync(eventsPath)) return out;
  let lastAssistant: Record<string, unknown> | null = null;
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let sawUsage = false;
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    switch (ev.type) {
      case "session": if (typeof ev.path === "string") out.sessionFile = ev.path; break;
      case "turn_end": out.turns += 1; break;
      case "tool_execution_start": out.toolCalls += 1; break;
      case "message_end": {
        const m = ev.message as Record<string, unknown> | undefined;
        if (m?.role !== "assistant") break;
        lastAssistant = m;
        // usage is per assistant message; the lane total is the sum over all of them
        const u = m.usage as Record<string, unknown> | undefined;
        if (u) {
          sawUsage = true;
          total.input += Number(u.input ?? 0);
          total.output += Number(u.output ?? 0);
          total.cacheRead += Number(u.cacheRead ?? 0);
          total.cacheWrite += Number(u.cacheWrite ?? 0);
          const c = u.cost;
          total.cost += typeof c === "number" ? c : typeof c === "object" && c ? Number((c as { total?: number }).total ?? 0) : 0;
        }
        break;
      }
      default: break;
    }
  }
  if (lastAssistant) {
    const content = lastAssistant.content;
    if (Array.isArray(content)) {
      out.finalText = content.filter((c) => (c as { type?: string }).type === "text").map((c) => String((c as { text?: string }).text ?? "")).join("\n").trim();
    }
  }
  if (sawUsage) out.usage = { input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, cost: Number(total.cost.toFixed(6)) };
  return out;
}

const CLAUDE_TOOL_NAMES: Record<string, string[]> = { read: ["Read"], bash: ["Bash"], grep: ["Grep"], find: ["Glob"], ls: ["Glob"], edit: ["Edit"], write: ["Write"] };
const CLAUDE_EFFORT: Record<string, string> = { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** claude -p の引数。brief は引数として渡す。設定・MCP・skill は読まない（--setting-sources "" / --strict-mcp-config / --disable-slash-commands）。settings は注入を付ける run だけが渡す。appendPrompts は system prompt に足す文で、計画役の run だけが規約の束を渡す */
export function buildClaudeArgs(role: RolePreset, sessionId: string, briefText: string, resume = false, settings?: string, appendPrompts?: readonly string[]): string[] {
  const tools = [...new Set(role.tools.flatMap((t) => CLAUDE_TOOL_NAMES[t] ?? []))];
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", role.model,
    "--effort", CLAUDE_EFFORT[role.thinking] ?? "high",
    "--tools", tools.length ? tools.join(",") : "",
    "--disallowedTools", "Agent,Task,WebFetch,WebSearch,NotebookEdit,SendUserMessage",
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    ...(settings ? ["--settings", settings] : []),
    // a run that carries a system prompt appendix (the planner's norms bundle) gets it by text: the bundle is built
    // from the originals at every start, so there is no file of its own to point at
    ...(appendPrompts ?? []).flatMap((prompt) => ["--append-system-prompt", prompt]),
    // --bare は credential の読み込みまで飛ばして "Not logged in" になるので使わない（2026-09-21 実測）
    resume ? "--resume" : "--session-id", sessionId,
    "--",
    briefText,
  ];
  return args;
}

/**
 * The env a lane's Claude Code runs with: the parent session's plumbing stripped (so a nested headless run is
 * allowed), the lane's own config dir, and no auto memory, so nothing of penne's is read or written and no lane
 * carries memory into the next.
 */
export function claudeEnv(base: NodeJS.ProcessEnv, configDir = readRoles().defaults.claudeConfigDir): NodeJS.ProcessEnv {
  const keep = Object.fromEntries(Object.entries(base).filter(([k]) => !CLAUDE_ENV_STRIP.has(k))) as NodeJS.ProcessEnv;
  return { ...keep, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

/**
 * Everything that keeps a Claude Code lane from starting now: the login (a failure) and the subscription's
 * windows (a wait, thrown as ClaudeQuotaBlocked). A stage that starts several roles checks all of them before
 * it starts any, so a refusal never leaves a run started and unrecorded.
 */
export function checkClaudeRoles(roles: RolePreset[], file: RolesFile = readRoles()): void {
  if (!roles.some((r) => r.harness === "claude")) return;
  checkClaudeConfigDir(file.defaults.claudeConfigDir);
  checkClaudeQuota(file.defaults.claudeConfigDir, file.defaults.claudeQuotaStop);
}

/**
 * The roles a stage starts with, given the windows. While they allow it, the roles as written. Over them, each
 * Claude Code role is swapped for its fallback (roles.yaml `fallback`, an API role) and the stage's other roles
 * stay as they are; a Claude Code role with no fallback holds the whole stage, so the refusal is thrown as by
 * checkClaudeRoles and nothing starts. So does a fallback that could not start (checked here, before any run,
 * as preparing its agent dir would: a model with no price), so a stage never starts half its runs and then
 * fails. A lapsed login is a failure, not the windows: no fallback stands in for it.
 */
export function rolesForStart(roles: RolePreset[], file: RolesFile = readRoles(), checkStartable: (role: RolePreset) => void = checkPiRoleStartable, noFallback: ReadonlySet<string> = new Set()): { role: RolePreset; fallback?: QuotaFallback }[] {
  return roles.map((role) => {
    const { candidate, fallback } = resolveRoute(role, file, { checkStartable, noFallback: noFallback.has(role.name) });
    return { role: candidate.role, ...(fallback ? { fallback } : {}) };
  });
}

/** Refuse penne's own config dirs, and a lane config dir nobody has logged in to (with the command that does). */
export { checkClaudeConfigDir };

/**
 * The nested-session guard, per-session plumbing, and every credential that bills through the API (a key, a
 * gateway, a cloud provider) are stripped, so a lane's Claude Code runs on the subscription login and its
 * cost is never real money outside the lane's budget. The subscription's own token (CLAUDE_CODE_OAUTH_TOKEN) stays.
 */
const CLAUDE_ENV_STRIP = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_LAUNCHER", "CLAUDE_EFFORT", "CLAUDE_CODE_REPORT_FINDINGS", "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL"]);

/** the words Claude Code puts in the error result of a Bash call it cut at its timeout, and the time it ran */
const CLAUDE_TIMEOUT_RESULT = /Command timed out after ([0-9][^\n]*)/;

/** "15m 0.3s", "2m 0.0s", "45.0s", "1h 0m 0s" as milliseconds; null when it reads no time */
export function claudeDurationMs(text: string): number | null {
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  let any = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\b/g)) {
    total += Number(m[1]) * unit[m[2]];
    any = true;
  }
  return any ? total : null;
}

/** a cut is the lane's when Claude Code ran the call for the lane's limit (a timeout the model asked for is shorter) */
function atLimit(ms: number, limitMs: number): boolean {
  return Math.abs(ms - limitMs) <= Math.max(2000, limitMs * 0.02);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : String((c as { text?: unknown }).text ?? ""))).join("\n");
  return "";
}

/**
 * toolTimeoutMinutes: the lane's limit of one call; only a Bash call Claude Code cut after about that long counts as
 * the lane's cut (as a pi lane counts only what its shell stopped). null (no limit) counts none.
 */
export function summarizeClaudeEvents(eventsPath: string, toolTimeoutMinutes: number | null = null): StreamSummary {
  const out: StreamSummary = { toolCalls: 0, turns: 0, finalText: "", toolTimeouts: 0 };
  if (!existsSync(eventsPath)) return out;
  let cost = 0;
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawResult = false;
  const bashCalls = new Set<string>();
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (ev.type === "assistant") {
      const m = ev.message as { content?: { type?: string; text?: string; id?: string; name?: string }[]; usage?: Record<string, number> } | undefined;
      out.turns += 1;
      for (const c of m?.content ?? []) {
        if (c.type === "tool_use") out.toolCalls += 1;
        if (c.type === "tool_use" && c.name === "Bash" && c.id) bashCalls.add(c.id);
      }
      const text = (m?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
      if (text) out.finalText = text;
    } else if (ev.type === "result") {
      sawResult = true;
      const u = ev.usage as Record<string, number> | undefined;
      if (u) {
        total.input = Number(u.input_tokens ?? 0);
        total.output = Number(u.output_tokens ?? 0);
        total.cacheRead = Number(u.cache_read_input_tokens ?? 0);
        total.cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
      }
      cost = Number(ev.total_cost_usd ?? 0);
      if (typeof ev.session_id === "string") out.sessionFile = ev.session_id;
      if (typeof ev.result === "string" && ev.result.trim()) out.finalText = ev.result.trim();
    } else if (ev.type === "user") {
      const m = ev.message as { content?: unknown } | undefined;
      // only a Bash call's error result: the same words in a file read, or in a command's ordinary output, are no cut
      for (const c of Array.isArray(m?.content) ? m.content as { type?: string; content?: unknown; is_error?: boolean; tool_use_id?: string }[] : []) {
        if (c.type !== "tool_result" || c.is_error !== true || !c.tool_use_id || !bashCalls.has(c.tool_use_id)) continue;
        const ran = CLAUDE_TIMEOUT_RESULT.exec(toolResultText(c.content));
        const ms = ran ? claudeDurationMs(ran[1]) : null;
        if (ms !== null && toolTimeoutMinutes !== null && atLimit(ms, toolTimeoutMs(toolTimeoutMinutes))) out.toolTimeouts = (out.toolTimeouts ?? 0) + 1;
      }
    } else if (ev.type === "rate_limit_event") {
      const q = quotaFromEvent(ev);
      if (q) out.quota = q;
    }
  }
  if (sawResult) out.usage = { ...total, cost: Number(cost.toFixed(6)) };
  return out;
}

/**
 * The `--tools` value of a pi role. A role written with `tools: []` is the read-only role: it keeps `read` (pi would
 * otherwise get only the bridge tools named next to it, and could not read the worktree), and so has nothing that
 * changes it. The injection's and the deliverable's tools come after.
 */
function piToolList(role: RolePreset, inject: boolean, reportTool: boolean): string {
  return [...(role.tools.length ? role.tools : ["read"]), ...(inject ? ["intent_lookup"] : []), ...(reportTool ? [REPORT_TOOL_NAME] : [])].join(",");
}

export function buildPiArgs(role: RolePreset, spec: LaneSpec, sessionDir: string, sessionId: string, briefPath: string, extra: string[] = []): string[] {
  const args = [
    "-p",
    "--mode", "json",
    "--model", role.model,
    "--thinking", role.thinking,
    "--session-dir", sessionDir,
    "--session-id", sessionId,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
  ];
  if (!role.contextFiles) args.push("--no-context-files");
  // the injection's extension is named on top of the disabled discovery: the user's extensions stay off, the
  // Harness's one bridge comes in by its path (DEC-107-10), and its tool is named in the allow-list. A role with
  // neither write nor bash gets the deliverable's own extension the same way, decided by the role's tools and not
  // by the stage
  const inject = stageGetsInjection(spec);
  if (inject) args.push("--extension", intentInjectExtensionPath());
  const reportTool = needsReportTool(role);
  if (reportTool) args.push("--extension", reportWriterExtensionPath());
  args.push("--tools", piToolList(role, inject, reportTool));
  args.push(...extra);
  args.push(`@${briefPath}`);
  return args;
}

export interface RunOptions {
  wait?: boolean;
  /** override the role's model for this run (provider/modelId) */
  model?: string;
  dryRun?: boolean;
  /** the spec's role is already the fallback of a Claude Code role the caller found refused for the windows */
  quotaFallback?: QuotaFallback;
  /** the run may not change roles, even when a candidate fails mid-run (a High lane's final) */
  noFallback?: boolean;
}

interface PreparedLane {
  rec: LaneRecord;
  dir: string;
}

interface AttemptPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  budgetMs: number;
  toolTimeout: number | null;
  cacheTtl: CacheTtl;
  /** the instructions the attempt's brief carries */
  instructions: Picked[];
  claudeSessionId?: string;
}

/**
 * Everything one attempt runs with, built again for each candidate: the brief, the agent dir, the arguments, the
 * environment (its own tool-call limit and cache hold), and the budget it starts with. A run that moves to
 * another candidate writes the lane's own files again, so nothing of the failed attempt carries over.
 */
function planAttempt(id: string, dir: string, spec: LaneSpec, role: RolePreset, roles: RolesFile, start: { instructions?: Picked[]; claudeSessionId?: string } = {}): AttemptPlan {
  const briefPath = join(dir, "brief.md");
  const cacheTtl = resolveCacheTtl(role, spec.worktree);
  // the instructions this attempt's brief carries are picked once: the brief and the ledger line written when the run
  // starts name the same list. They are kept in the lane's dir for the supervisor, which is the one that starts the run
  const instructions = start.instructions ?? specInstructions(spec);
  writeFileSync(join(dir, INSTRUCTIONS_FILE), `${JSON.stringify(instructions, null, 2)}\n`);
  writeFileSync(briefPath, renderBrief(spec, role, { cacheTtl, instructions }));
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(spec.report, ".."), { recursive: true });
  const toolTimeout = resolveToolTimeout(role, spec.worktree, roles);
  const claudeSessionId = role.harness === "claude" ? (start.claudeSessionId ?? randomUUID()) : undefined;
  const claudeSettings = claudeSettingsFor(role, spec, dir);
  const args = role.harness === "claude"
    ? buildClaudeArgs(role, claudeSessionId as string, renderBrief(spec, role, { cacheTtl, instructions }), false, claudeSettings)
    : buildPiArgs(role, spec, sessionDir, id, briefPath);
  const bin = role.harness === "claude" ? claudeBinary() : piBinary();
  if (role.harness === "pi") prepareAgentDir(dir, role, { toolTimeoutSeconds: toolTimeoutSeconds(toolTimeout) });
  // the context files pi will load are copied into the record (the attempt's own copy replaces a failed one's)
  if (role.harness === "pi" && role.contextFiles) recordContextFiles(dir, spec.worktree);
  const env = laneEnv(role, id, dir, toolTimeout, { ...riskPathsEnvForPath(spec.worktree), ...runTmpEnvOf(id, spec.worktree), ...injectionEnvFor(role.name, dir, spec), ...runLaneEnv(spec), ...reportEnv(role, spec.report) }, cacheTtl);
  writeFileSync(join(dir, "pi-args.json"), `${JSON.stringify([bin, ...args], null, 2)}\n`);
  return { bin, args, env, budgetMs: (spec.budgetMinutes ?? role.budgetMinutes) * 60 * 1000, toolTimeout, cacheTtl, instructions, ...(claudeSessionId ? { claudeSessionId } : {}) };
}

/** the file in a lane's dir that holds the instructions its brief carries */
const INSTRUCTIONS_FILE = "instructions.json";

/** the instructions a prepared lane's brief carries, as the preparing process wrote them; none when the file cannot be read */
function preparedInstructions(dir: string): Picked[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, INSTRUCTIONS_FILE), "utf8"));
    return Array.isArray(parsed) ? (parsed as Picked[]) : [];
  } catch {
    return [];
  }
}

/**
 * Write the instruction ledger line for a run that has started: the harness's process exists. Called from the
 * process's own `spawn` event, so a run that never started (a binary that cannot be found) leaves no line.
 */
function recordStartedRun(rec: LaneRecord, spec: LaneSpec | null, instructions: readonly Picked[]): void {
  const stage = spec?.injectStage ?? spec?.stage;
  const scene = sceneOfStage(stage);
  if (!stage || !scene) return;
  recordInjection(instructions, { kind: "lane", stage, scene, ...(spec?.lane ? { lane: spec.lane } : {}), run: rec.id });
}

/**
 * Everything up to (not including) starting the harness: brief, agent dir, args, lane.json with status=running.
 * The role's whole candidate order is drawn here (DEC-110-1): the first candidate that can start runs, and the
 * rest stay on the record so a mid-run failure can move to the next one without resolving the roles file again.
 */
export function prepareLane(specPath: string, opts: RunOptions = {}): PreparedLane {
  const spec = readSpec(specPath);
  const roles = readRoles();
  const preset = roles.roles[spec.role];
  if (!preset) throw new Error(`未知の role "${spec.role}"`);
  const written: RolePreset = opts.model
    ? { ...preset, model: opts.model }
    : spec.model ? resolveRoleModel(spec.role, spec.model, roles, spec.thinking) : resolveRole(spec.role, roles);
  if (opts.model && !/^[^/\s]+\/\S+$/.test(opts.model)) throw new Error("--model は provider/modelId");
  // a model named for this run is the point of the run, so it is never swapped; a stage may also forbid the
  // switch (a High lane's final), and then only the role's own routes are drawn
  const noFallback = Boolean(opts.model || opts.noFallback);
  const route = resolveRoute(written, roles, noFallback ? { noFallback: true } : {});
  const role = route.candidate.role;
  // pi gets the deliverable's extension, but a Claude Code role of the same shape has no way to carry it
  assertReportWriter(role);
  const quotaFallback = route.fallback ?? opts.quotaFallback;
  const pending = candidatesFor(written, roles).slice(route.index + 1);

  const id = claimLaneId(role.name);
  const dir = laneDir(id);
  const plan = planAttempt(id, dir, spec, role, roles);
  const rec: LaneRecord = {
    id, role: role.name, model: role.model, ...(role.modelName ? { model_name: role.modelName } : {}), worktree: spec.worktree, ...(spec.title ? { title: spec.title } : {}), spec: specPath, report: spec.report,
    status: "running", started_at: new Date().toISOString(), head_before: headOf(spec.worktree),
    role_preset: role, budget_minutes: spec.budgetMinutes ?? role.budgetMinutes,
    ...(plan.claudeSessionId ? { session_file: plan.claudeSessionId } : {}),
    ...(quotaFallback ? { quota_fallback: quotaFallback, fallbacks: [quotaFallback] } : {}),
    ...(pending.length ? { pending } : {}),
    ...(noFallback ? { no_fallback: true } : {}),
    tool_timeout_minutes: plan.toolTimeout,
    cache_ttl: plan.cacheTtl,
    shared_daemons: [...roles.defaults.sharedDaemons],
  };
  if (quotaFallback) appendFileSync(join(dir, "supervisor.log"), `[quota] ${quotaFallback.role} は Claude の枠で断られたので ${quotaFallback.fallback} で実行します: ${quotaFallback.reason}\n`);
  if (opts.dryRun) rec.status = "stopped";
  writeLane(rec);
  return { rec, dir };
}

/**
 * The deliverable is report.md and a report.json that parses. A report.md alone is not: an agent may
 * write a progress note there and then stop on a provider error (a 429), which would read as done.
 */
export function reportComplete(report: string): boolean {
  if (!existsSync(`${report}.md`) || !existsSync(`${report}.json`)) return false;
  try {
    JSON.parse(readFileSync(`${report}.json`, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/** The lane process ended "successfully" but left no deliverable: worth one nudge in the same session. */
export function needsResume(r: { exit?: number; report_md?: boolean; status: LaneStatus; resumes?: number }, maxResumes: number): boolean {
  return r.status === "running" && r.exit === 0 && !r.report_md && (r.resumes ?? 0) < maxResumes;
}

/** the provider error of the session's last reply, or null when that reply did not fail */
export function lastProviderError(sessionJsonl: string): string | null {
  const lines = sessionJsonl.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry: { type?: string; message?: { role?: string; stopReason?: string; errorMessage?: string } };
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    return entry.message.stopReason === "error" ? (entry.message.errorMessage ?? "").slice(0, 300) : null;
  }
  return null;
}

export function isRateLimited(error: string): boolean {
  return /\b429\b|rate.?limit/i.test(error);
}

/** waits before resuming after a rate limit; the provider usually recovers within a few minutes */
const RATE_LIMIT_WAITS_MS = [30_000, 60_000, 120_000];

export function resumeNudge(report: string, tool?: string): string {
  if (tool) {
    return `成果物（\`${report}.md\` と \`${report}.json\`）がまだ書かれていません。作業の続きから再開し、brief の \`<deliverables>\` どおりに \`${tool}\` 道具を 1 回呼んで 2 ファイルを書いてから終了してください。`;
  }
  return `成果物（\`${report}.md\` と \`${report}.json\`）がまだ書かれていません。作業の続きから再開し、brief の \`<deliverables>\` どおりに 2 ファイルを書いてから終了してください。書けない場合は理由を \`${report}.md\` に書いてください。`;
}

/**
 * The pi arguments for resuming a lane's own session with a follow-up. One shape for the supervisor's resume and a
 * `send`, so the injection and the deliverable's tool reach either path exactly as they reach the start.
 */
export function piSessionArgs(role: RolePreset, sessionFile: string, msgPath: string, spec: LaneSpec | null): string[] {
  const inject = spec !== null && stageGetsInjection(spec);
  const reportTool = needsReportTool(role);
  return [
    "-p", "--mode", "json", "--model", role.model, "--thinking", role.thinking,
    "--session", sessionFile, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve",
    ...(inject ? ["--extension", intentInjectExtensionPath()] : []),
    ...(reportTool ? ["--extension", reportWriterExtensionPath()] : []),
    "--tools", piToolList(role, inject, reportTool), `@${msgPath}`,
  ];
}

function resumeArgs(role: RolePreset, rec: LaneRecord, msgPath: string, text: string, spec: LaneSpec | null = null): string[] {
  if (role.harness === "claude") return buildClaudeArgs(role, rec.session_file as string, text, true, claudeSettingsFor(role, spec, laneDir(rec.id)));
  return piSessionArgs(role, rec.session_file as string, msgPath, spec);
}

/**
 * The env a lane's agent runs with. A pi lane's tool call limit is in its agent dir (the lane's shell); a Claude Code
 * lane's is Claude Code's own timeout of its Bash tool, capped at the limit, with the move of a long call to the
 * background turned off, so a call that does not end is cut rather than left running.
 *
 * IDD_RISK_PATHS is never inherited from the engine's own environment: the engine handles several repos, and one
 * repo's declaration must not reach another repo's checks. The caller passes the worktree's own declaration in
 * `extra` (riskPathsEnvForPath), and a repo that declares none carries no value at all.
 */
export function laneEnv(role: RolePreset, id: string, dir: string, toolTimeoutMinutes: number | null = null, extra: Record<string, string | undefined> = {}, cacheTtl: CacheTtl = DEFAULT_RUN_CACHE_TTL): NodeJS.ProcessEnv {
  // a stage run names its lane from its own spec; one inherited from the engine's shell would name another lane,
  // and a hold credential inherited the same way would be another lane's
  const base = withoutRiskPaths(process.env);
  delete base[RUN_LANE_ENV];
  delete base[HOLD_TOKEN_ENV];
  if (role.harness !== "claude") {
    return shimEnv(agentEnv(base, { IDD_LANE_ID: id, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_DISABLE_UPDATE_CHECK: "1", ...extra }));
  }
  const env = { ...claudeEnv(agentEnv(base, { IDD_LANE_ID: id, ...extra })), ...claudeToolLimitEnv(toolTimeoutMinutes) };
  return shimEnv(claudeCacheEnv(env, cacheTtl));
}

/**
 * A run's temp dir (config/repos.yaml `tmp_dir`) as the variables its agent gets, with the dirs of the repo's runs
 * that are gone taken down first; {} for a repo that names none. Whether a dir's run is alive is read from its record:
 * a conversation by its supervisor's lock, any other run as the reading doors read it.
 */
export function runTmpEnvOf(id: string, worktree: string | undefined): Record<string, string> {
  return runTmpEnv(id, worktree, runTmpOwnerAlive);
}

function runTmpOwnerAlive(runId: string): boolean {
  if (!existsSync(recordPath(runId))) return false;
  let rec: LaneRecord;
  try {
    rec = readLane(runId);
  } catch {
    // a record being rewritten is a run being worked on
    return true;
  }
  if (rec.mode === "conversation") return liveLockOwner(laneDir(runId)) !== null;
  return laneRunAlive(rec);
}

/**
 * Claude Code's own prompt cache hold: a 5m run carries the switch, and every other run has it taken out of what
 * it inherited. The engine's environment reaches the run, so a variable left in the shell that started the engine
 * would otherwise hold a conversation's run to 5 minutes and make the measured holds unreadable.
 */
export function claudeCacheEnv(base: NodeJS.ProcessEnv, cacheTtl: CacheTtl): NodeJS.ProcessEnv {
  const env = { ...base };
  if (cacheTtl === "5m") env.FORCE_PROMPT_CACHING_5M = "1";
  else delete env.FORCE_PROMPT_CACHING_5M;
  return env;
}

/**
 * A call that names no timeout runs up to the limit as well, not Claude Code's own default of 2 minutes: with the
 * move to the background off, that default would cut what used to go on in the background. Off leaves Claude Code
 * as it is.
 */
export function claudeToolLimitEnv(toolTimeoutMinutes: number | null): Record<string, string> {
  if (toolTimeoutMinutes === null) return {};
  const ms = String(toolTimeoutMs(toolTimeoutMinutes));
  return { BASH_MAX_TIMEOUT_MS: ms, BASH_DEFAULT_TIMEOUT_MS: ms, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
}

function toolTimeoutMs(minutes: number): number {
  return Math.max(1000, Math.round(minutes * 60_000));
}

export function toolTimeoutSeconds(minutes: number | null): number | null {
  return minutes === null ? null : Math.max(1, Math.ceil(minutes * 60));
}

/**
 * The limit of one shell tool call for a lane of this role on this worktree: the role's own, else the repo's
 * (config/repos.yaml, the repo the worktree belongs to), else roles.yaml's default. null is off.
 */
export function resolveToolTimeout(role: RolePreset | undefined, worktree: string | undefined, file?: RolesFile): number | null {
  if (role?.toolTimeoutMinutes !== undefined) return role.toolTimeoutMinutes;
  if (worktree) {
    try {
      const repo = repoForPath(worktree);
      if (repo?.toolTimeoutMinutes !== undefined) return repo.toolTimeoutMinutes;
    } catch { /* no registry: the default */ }
  }
  try {
    return (file ?? readRoles()).defaults.toolTimeoutMinutes;
  } catch {
    return DEFAULT_TOOL_TIMEOUT_MINUTES;
  }
}

/** a lane's tool call limit: what it was prepared with, or (a conversation, a lane from before the setting) resolved now */
export function toolTimeoutOf(rec: Pick<LaneRecord, "tool_timeout_minutes" | "role_preset" | "worktree">): number | null {
  if (rec.tool_timeout_minutes !== undefined) return rec.tool_timeout_minutes;
  return resolveToolTimeout(rec.role_preset, rec.worktree);
}

/**
 * What a run's hooks read: nothing at all unless the spec's stage is one the injection is attached to. The lane
 * it names is the Issue lane the run belongs to (spec.injectLane), which the caller wrote when it made the spec.
 */
function injectionEnvFor(role: string, dir: string, spec: LaneSpec | null): Record<string, string> {
  const stage = spec ? injectionStageOf(spec) : null;
  if (!spec || !stage) return {};
  return injectionEnv({ lane: spec.injectLane, stage, role, record: injectionRecordPath(dir) });
}

/** the settings a Claude Code run reads, or undefined when the run gets no injection */
function claudeSettingsFor(role: RolePreset, spec: LaneSpec | null, dir: string): string | undefined {
  if (role.harness !== "claude" || !spec || !stageGetsInjection(spec)) return undefined;
  return writeClaudeInjectSettings(dir);
}

/** a spec, read only when it is there; a lane started from a path that is gone keeps running as it is */
function specOf(path: string): LaneSpec | null {
  try {
    return path && existsSync(path) ? readSpec(path) : null;
  } catch {
    return null;
  }
}

/**
 * The prompt cache hold of a run, and a lane's hold (what it was prepared with, or resolved now). The order is
 * written once in cache-ttl.ts; this re-exports it so callers of the runner keep one import.
 */
export { resolveCacheTtl };

/** a lane's cache hold: what it was prepared with, or (a conversation, a lane from before the setting) resolved now */
export function cacheTtlOf(rec: Pick<LaneRecord, "cache_ttl" | "role_preset" | "worktree" | "mode">): CacheTtl {
  if (rec.cache_ttl !== undefined) return rec.cache_ttl;
  return resolveCacheTtl(rec.role_preset, rec.worktree, rec.mode === "conversation");
}

/** the calls a lane's harness cut: a pi lane's shell writes each to tool-timeouts.log; Claude Code's are in its stream */
export function countToolTimeouts(role: RolePreset, dir: string, summary: StreamSummary): number {
  if (role.harness === "claude") return summary.toolTimeouts ?? 0;
  const p = join(dir, TOOL_TIMEOUT_LOG);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length : 0;
}

/** how long a harness's output may trail its exit (a process it left behind holding the pipe) before the file is closed without it */
const OUTPUT_DRAIN_MS = 5000;

/**
 * Append a child's stdout to a file. `closed` resolves once what the child printed is in the file: its exit can
 * come before its output is read from the pipe, and the file's writes land after that, so a caller that reads
 * the file on exit (the run's cost, session and windows) waits for this first. Output still trailing after
 * `graceMs` is cut off, so a process left holding the pipe cannot hold the lane.
 */
export function streamToFile(out: Readable | null | undefined, path: string): { closed: (graceMs?: number) => Promise<void> } {
  const file = createWriteStream(path, { flags: "a" });
  const done = new Promise<void>((resolveDone) => {
    file.once("close", () => resolveDone());
    file.once("error", () => resolveDone());
  });
  if (out) out.pipe(file);
  else file.end();
  return {
    closed: (graceMs = OUTPUT_DRAIN_MS) => {
      const cut = setTimeout(() => { out?.unpipe(file); file.end(); }, graceMs);
      return done.finally(() => clearTimeout(cut));
    },
  };
}

/** Run one process for the lane, streaming stdout to events.jsonl. Resolves with the exit code; sets rec.status on timeout / stop. */
export function spawnLaneProcess(rec: LaneRecord, bin: string, args: string[], env: NodeJS.ProcessEnv, dir: string, budgetMs: number, onSpawn?: () => void): Promise<number> {
  // a harness binary that cannot be started (not on the PATH, say) fails the lane with the reason; bun throws
  // right away where node emits an error event, and neither may take the supervisor down with the lane still "running"
  const failStart = (err: unknown): Promise<number> => {
    rec.spawn_error = `${bin} を起動できない: ${err instanceof Error ? err.message : String(err)}`;
    appendFileSync(join(dir, "stderr.log"), `${rec.spawn_error}\n`);
    return Promise.resolve(127);
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, args, { cwd: rec.worktree, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return failStart(err);
  }
  const events = streamToFile(child.stdout, join(dir, "events.jsonl"));
  rec.pid = child.pid;
  writeLane(rec);
  // the process exists: the run has started (a binary that cannot be found fires `error` instead)
  if (onSpawn) child.once("spawn", () => { try { onSpawn(); } catch { /* a record of the start never fails the run */ } });
  child.stderr?.on("data", (d: Buffer) => appendFileSync(join(dir, "stderr.log"), d));
  const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* already gone */ } rec.status = "timeout"; }, Math.max(budgetMs, 60 * 1000));
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } rec.status = "stopped"; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return new Promise<number>((resolveExit) => {
    let settled = false;
    const settle = (code: number, graceMs?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      void events.closed(graceMs).then(() => resolveExit(code));
    };
    // a harness that never started printed nothing to wait for
    child.on("error", (err) => { void failStart(err); settle(127, 0); });
    child.on("exit", (code, signal) => settle(code ?? (signal ? 128 : 1)));
  });
}

/**
 * Keep the windows a Claude Code run reported, on the lane and as the account's last observation. A run that
 * reported nothing new keeps the earlier observation's time.
 */
export function keepQuota(rec: LaneRecord, quota: ClaudeQuota | undefined, configDir: string | undefined): void {
  if (!quota) return;
  if (rec.claude_quota && JSON.stringify({ ...rec.claude_quota, observed_at: undefined, lane: undefined, config_dir: undefined }) === JSON.stringify(quota)) return;
  // the lane's own record names the config dir, so a reader of the windows can tell the lane side's from the conversation's
  rec.claude_quota = configDir ? { ...recordClaudeQuota(configDir, quota, rec.id), config_dir: resolve(configDir) } : { ...quota, observed_at: new Date().toISOString(), lane: rec.id };
}

function collectRun(rec: LaneRecord, role: RolePreset, dir: string, configDir?: string): void {
  const eventsPath = join(dir, "events.jsonl");
  const sessionDir = join(dir, "session");
  const summary = role.harness === "claude" ? summarizeClaudeEvents(eventsPath, toolTimeoutOf(rec)) : summarizeEvents(eventsPath);
  keepQuota(rec, summary.quota, configDir);
  rec.usage = summary.usage;
  rec.tool_calls = summary.toolCalls;
  rec.turns = summary.turns;
  rec.final_text = summary.finalText;
  rec.tool_timeouts = countToolTimeouts(role, dir, summary);
  // report_md stands for "the deliverable is there": both files, the JSON readable
  rec.report_md = reportComplete(rec.report);
  rec.report_json = existsSync(`${rec.report}.json`);
  const sessions = existsSync(sessionDir) ? readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")) : [];
  if (role.harness === "pi" && sessions[0]) rec.session_file = join(sessionDir, sessions[0]);
}

/**
 * Start pi for a prepared lane and finalize lane.json when it ends. Runs inside the detached
 * supervisor process so the lane survives the caller (orchestrator session) going away.
 * A lane that exits 0 without report.md (the "empty answer" failure seen 2026-09-21) is resumed
 * in the same session with a nudge, up to role.maxResumes times, within the remaining budget.
 */
/**
 * Run a lane's setup commands in order, stopping at the first failure. It runs in the supervisor, so a
 * minutes-long pub get or npm ci no longer holds the tick that started the lane.
 */
export function runSetup(commands: string[], cwd: string, log: string, env?: NodeJS.ProcessEnv): { ok: true } | { ok: false; failed: string; output: string } {
  for (const cmd of commands) {
    const r = runShell(cwd, cmd, { timeoutMs: 15 * 60 * 1000, ...(env ? { env } : {}) });
    appendFileSync(log, `$ ${cmd}\n${r.stdout}${r.stderr}[exit ${r.exit}]\n`);
    if (r.exit !== 0) return { ok: false, failed: cmd, output: tail(r.stderr || r.stdout) };
  }
  return { ok: true };
}

function finishWithoutAgent(rec: LaneRecord, startedAt: number, error: string): LaneRecord {
  rec.status = "failed";
  rec.error = error;
  rec.ended_at = new Date().toISOString();
  rec.duration_ms = Date.now() - startedAt;
  delete rec.pid;
  writeLane(rec);
  return rec;
}

/**
 * four marks of a worktree: HEAD, the index against HEAD (staged), the files against the index (unstaged), and the
 * untracked files with their content. Staged and unstaged are kept apart: a change staged and then undone in the files
 * cancels in their sum against HEAD while the index still differs.
 */
export interface WorktreeSnapshot {
  head: string;
  staged: string;
  tracked: string;
  untracked: string;
}

const SNAPSHOT_MAX_BUFFER = 1 << 30;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read a worktree's state without moving its index or its files. The staged mark is the index's diff against HEAD and
 * the tracked mark the files' diff against the index; the untracked mark is the list of paths with a hash of each file's
 * content, so rewriting an untracked record changes it where `git status` would read the same. Files the repo ignores
 * are left out: a test or a build writes them as a matter of course, and they never reach a commit or the upstream. A
 * file whose content cannot be read throws, so the state is never taken as unchanged for what was not read.
 */
export function worktreeSnapshot(cwd: string): WorktreeSnapshot {
  const head = headOf(cwd);
  const diff = (...args: string[]) => sha256(git(cwd, ["diff", ...args, "--binary", "--no-ext-diff", "--no-textconv"], { maxBuffer: SNAPSHOT_MAX_BUFFER }));
  const staged = diff("--cached");
  const tracked = diff();
  const listed = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: SNAPSHOT_MAX_BUFFER });
  const untracked = createHash("sha256");
  for (const path of listed.split("\0").filter(Boolean).sort()) untracked.update(`${path}\0${untrackedMark(join(cwd, path))}\n`);
  return { head, staged, tracked, untracked: untracked.digest("hex") };
}

const SNAPSHOT_CHUNK = 1 << 20;

/** a file's content hashed in chunks, so a large file is never held whole in memory */
function fileHash(path: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(SNAPSHOT_CHUNK);
  const fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function untrackedMark(path: string): string {
  let st;
  try { st = lstatSync(path); } catch (err) {
    // listed, then gone: the list of the other snapshot decides whether that is a change
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
  if (st.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (st.isFile()) return `file:${fileHash(path)}`;
  return "other";
}

/** which marks differ between two snapshots, named for the failure's reason; empty when the states are the same */
export function snapshotDiff(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  const out: string[] = [];
  if (before.head !== after.head) out.push("HEAD");
  if (before.staged !== after.staged) out.push("stage した追跡ファイルの中身");
  if (before.tracked !== after.tracked) out.push("追跡ファイルの中身");
  if (before.untracked !== after.untracked) out.push("未追跡ファイルの一覧か中身");
  return out;
}

/** the end of a require_clean attempt: read the worktree again and set `clean` by comparing with how the attempt began */
function sealWorktree(rec: LaneRecord): void {
  if (!rec.state_before) return;
  try {
    rec.state_after = worktreeSnapshot(rec.worktree);
    rec.clean = snapshotDiff(rec.state_before, rec.state_after).length === 0;
  } catch {
    rec.clean = false;
  }
}

/** why a require_clean run is failed on its worktree, or null when it ended as it began */
function worktreeChange(rec: LaneRecord): string | null {
  if (rec.clean !== false) return null;
  const parts = rec.state_before && rec.state_after ? snapshotDiff(rec.state_before, rec.state_after) : [];
  return `worktree が開始時から変わっている${parts.length ? `（${parts.join("・")}）` : "（終了時の状態を読めない）"}`;
}

/** a snapshot of a worktree with nothing staged, nothing changed and nothing untracked (the ignored files aside) */
function cleanSnapshot(state: WorktreeSnapshot): boolean {
  const empty = sha256("");
  return state.staged === empty && state.tracked === empty && state.untracked === empty;
}

/** a line on the run's log; a log that cannot be written never stops the run's end */
function logLine(dir: string, line: string): void {
  try { appendFileSync(join(dir, "supervisor.log"), `${line}\n`); } catch { /* the record still says it */ }
}

/**
 * Why another process may have written in this worktree while the attempt ran, or null: another lane or conversation
 * on the same worktree that is running now, or whose record moved after the attempt began (a conversation's
 * supervisor lets go of its lock once its queue is empty, so a turn that ended during the attempt is read here).
 */
function worktreeInUse(rec: LaneRecord): string | null {
  const target = resolve(rec.worktree);
  const since = Date.parse(rec.state_before_at ?? "");
  let lanes: LaneRecord[];
  try { lanes = listLanes(); } catch { return "lane の一覧を読めない"; }
  for (const other of lanes) {
    if (other.id === rec.id || !other.worktree || resolve(other.worktree) !== target) continue;
    if (laneRunAlive(other)) return `lane ${other.id} が同じ worktree で走っている`;
    if (other.mode === "conversation" && liveLockOwner(laneDir(other.id))) return `会話 ${other.id} が同じ worktree を使っている`;
    let moved = NaN;
    try { moved = statSync(recordPath(other.id)).mtimeMs; } catch { /* gone */ }
    if (Number.isNaN(since) || moved >= since) return `${other.mode === "conversation" ? "会話" : "lane"} ${other.id} が試行の間に同じ worktree で動いた`;
  }
  return null;
}

/**
 * The end of a require_clean attempt that left the worktree changed, whatever way it ended (a time budget or a stop
 * as well as an answer): the reason goes on the record, and when the attempt began on a clean worktree, HEAD did not
 * move and no other lane or conversation used the worktree during the attempt, what it wrote is kept on a ref of the
 * lane's own and taken back, so a role that may not write never hands its scratch to the lane's next step and nothing
 * is lost for good. The paths are
 * recorded before anything moves, and the worktree is read again after: a worktree that still differs from its start
 * is recorded as not taken back. A worktree that began changed is left as it is: what was the role's cannot be told
 * from what was there.
 */
export function settleDirtyWorktree(rec: LaneRecord, dir: string, seams: { afterKeep?: () => void } = {}): void {
  if (rec.clean !== false || !rec.state_before) return;
  const addError = (text: string) => { if (!(rec.error ?? "").includes(text)) rec.error = [rec.error, text].filter(Boolean).join(", "); };
  const reason = worktreeChange(rec);
  if (reason) addError(reason);
  const before = rec.state_before;
  const after = rec.state_after;
  if (!after || after.head !== before.head || !cleanSnapshot(before)) return;
  let paths: string[];
  try {
    paths = git(rec.worktree, ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"])
      .split("\0").filter(Boolean).map((line) => line.slice(3)).sort();
  } catch (err) {
    rec.worktree_restore = { paths: [], ok: false, error: `worktree の変更を読めない: ${err instanceof Error ? err.message : String(err)}` };
    addError("worktree を戻せなかった");
    return;
  }
  const busy = worktreeInUse(rec);
  if (busy) {
    rec.worktree_restore = { paths, ok: false, skipped: busy };
    logLine(dir, `[require-clean] worktree を戻さない（${busy}）: ${paths.join(", ")}`);
    return;
  }
  // a ref of the lane's own, not refs/stash: the stash is shared by every worktree of the repo, so another agent's
  // `git stash pop` could take this scratch into its own tree (the same reason consult-copy.ts keeps clear of it)
  const ref = `refs/idd/require-clean/${rec.id}-${Date.now()}`;
  logLine(dir, `[require-clean] 開始時に clean だった worktree の変更を ${ref} に退避して戻す（${paths.length} 件）: ${paths.join(", ")}`);
  const restore: NonNullable<LaneRecord["worktree_restore"]> = { paths, ok: false };
  rec.worktree_restore = restore;
  const index = join(dir, `require-clean-${process.pid}-${Date.now()}.index`);
  try {
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "idd", GIT_AUTHOR_EMAIL: "idd@localhost", GIT_COMMITTER_NAME: "idd", GIT_COMMITTER_EMAIL: "idd@localhost" };
    const run = (args: string[]) => gitBytes(rec.worktree, args, { env }).toString("utf8").trim();
    // the real index copied, so `add -A` reads only what changed and the window before the restore stays short
    const real = resolve(rec.worktree, git(rec.worktree, ["rev-parse", "--git-path", "index"]).trim());
    if (existsSync(real)) copyFileSync(real, index); else run(["read-tree", before.head]);
    run(["add", "-A"]);
    const tree = run(["write-tree"]);
    const commit = run(["commit-tree", tree, "-p", before.head, "-m", `idd require-clean ${rec.id}`]);
    run(["update-ref", ref, commit]);
    restore.ref = ref;
    restore.commit = commit;
    seams.afterKeep?.();
    // only what the kept commit holds is taken back, and only while HEAD is where the attempt began: a commit made
    // since, or a file written after the commit was taken, is left as it is and read below as not taken back
    if (git(rec.worktree, ["rev-parse", "HEAD"]).trim() !== before.head) throw new Error("退避の後に HEAD が動いたので戻さない");
    const changed = (filter: string) => git(rec.worktree, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", `--diff-filter=${filter}`, before.head, commit]).split("\0").filter(Boolean);
    // a path written again after the commit was taken is not the commit's to take back: read the worktree once more
    // into the same index and leave alone every path that moved since, so a later write is never overwritten or removed
    run(["add", "-A"]);
    const now = run(["write-tree"]);
    const moved = new Set(git(rec.worktree, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", tree, now]).split("\0").filter(Boolean));
    if (moved.size) restore.error = `退避の後に書かれた path は戻さない（${[...moved].sort().join(", ")}）`;
    const added = changed("A").filter((path) => !moved.has(path));
    const touched = changed("MDT").filter((path) => !moved.has(path));
    // the paths are names, not patterns: a directory named like `[id]` must not match its neighbours
    if (touched.length) git(rec.worktree, ["--literal-pathspecs", "restore", `--source=${before.head}`, "--staged", "--worktree", "--", ...touched]);
    if (added.length) {
      git(rec.worktree, ["--literal-pathspecs", "rm", "-rq", "--cached", "--ignore-unmatch", "--", ...added]);
      git(rec.worktree, ["--literal-pathspecs", "clean", "-fdq", "--", ...added]);
    }
    const left = snapshotDiff(before, worktreeSnapshot(rec.worktree));
    restore.ok = left.length === 0;
    if (!restore.ok) restore.error = [restore.error, `戻した後も開始時と違う（${left.join("・")}）`].filter(Boolean).join("。");
  } catch (err) {
    restore.error = err instanceof Error ? err.message : String(err);
  } finally {
    try { rmSync(index, { force: true }); } catch { /* a leftover index is harmless */ }
  }
  if (!restore.ok) {
    addError("worktree を戻しきれなかった");
    logLine(dir, `[require-clean] worktree を戻しきれなかった: ${restore.error ?? ""}`);
  }
}

/** what a worktree looks like across an attempt: HEAD plus the uncommitted changes, so a switch never builds on a half-written tree */
function worktreeState(worktree: string): string {
  try {
    return `${headOf(worktree)}\n${runShell(worktree, "git status --porcelain").stdout}`;
  } catch {
    return "";
  }
}

/** move a failed attempt's output and session aside, so the next attempt's summary reads only its own */
function stashAttemptOutput(dir: string, attemptNo: number): void {
  const events = join(dir, "events.jsonl");
  if (existsSync(events)) renameSync(events, join(dir, `events-${attemptNo}.jsonl`));
  const session = join(dir, "session");
  if (existsSync(session)) renameSync(session, join(dir, `session-${attemptNo}`));
}

/** move a failed attempt's deliverable aside (never delete it: it is evidence for the failure) */
function stashArtifacts(report: string, attemptNo: number): void {
  for (const ext of ["md", "json"]) {
    const p = `${report}.${ext}`;
    if (existsSync(p)) renameSync(p, `${report}.attempt-${attemptNo}.${ext}`);
  }
}

/** the run's cost, tokens and holds as the sum of its attempts' */
function sumUsage(attempts: LaneAttempt[]): LaneRecord["usage"] | undefined {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let saw = false;
  for (const a of attempts) {
    if (!a.usage) continue;
    saw = true;
    total.input += a.usage.input;
    total.output += a.usage.output;
    total.cacheRead += a.usage.cacheRead ?? 0;
    total.cacheWrite += a.usage.cacheWrite ?? 0;
    total.cost += a.usage.cost ?? 0;
  }
  return saw ? { ...total, cost: Number(total.cost.toFixed(6)) } : undefined;
}

/** drop what one attempt left on the record, so the next attempt's summary stands on its own */
function clearAttemptState(rec: LaneRecord): void {
  delete rec.exit;
  delete rec.usage;
  delete rec.final_text;
  delete rec.tool_calls;
  delete rec.turns;
  delete rec.tool_timeouts;
  delete rec.clean;
  delete rec.state_before;
  delete rec.state_after;
  delete rec.error;
  delete rec.spawn_error;
  delete rec.resumes;
  rec.report_md = reportComplete(rec.report);
  rec.report_json = existsSync(`${rec.report}.json`);
}

/** the roles file, or null when it cannot be read (then no mid-run switch is drawn) */
function readRolesOrNull(): RolesFile | null {
  try { return readRoles(); } catch { return null; }
}

/** the first of the run's remaining candidates that can start now, taking it off the record; null when none can */
function takeStartable(rec: LaneRecord, roles: RolesFile | null): Candidate | null {
  const pending = [...(rec.pending ?? [])];
  while (pending.length) {
    const next = pending.shift() as Candidate;
    if (!roles) break;
    try { checkCandidateStartable(next, roles); assertReportWriter(next.role); } catch { continue; }
    rec.pending = pending;
    return next;
  }
  rec.pending = pending;
  return null;
}

export async function executeLane(id: string): Promise<LaneRecord> {
  const rec = readLane(id);
  const dir = laneDir(id);
  // a record that already ended is not started: a late supervisor must not put "running" back over a failure a
  // reading door has already acted on
  if (rec.status !== "running") {
    try { appendFileSync(join(dir, "supervisor.log"), `[skip] the record is already ${rec.status}; the run was not started\n`); } catch { /* the log is not why the run does not start */ }
    return rec;
  }
  // name this supervisor before anything slow runs, so a reading door that sees the record sees a live process
  rec.supervisor_pid = process.pid;
  writeLane(rec);
  const first = rec.role_preset;
  if (!first) throw new Error(`lane ${id} に role_preset がありません`);
  let role: RolePreset = first;
  const spec = specOf(rec.spec);
  const saved = JSON.parse(readFileSync(join(dir, "pi-args.json"), "utf8")) as string[];
  let bin = saved[0];
  let args = saved.slice(1);
  const tmpEnv = runTmpEnvOf(id, rec.worktree);
  let env = laneEnv(role, id, dir, toolTimeoutOf(rec), { ...riskPathsEnvForPath(rec.worktree), ...tmpEnv, ...injectionEnvFor(role.name, dir, spec), ...runLaneEnv(spec), ...reportEnv(role, rec.report) }, cacheTtlOf(rec));
  let budgetMs = (rec.budget_minutes ?? role.budgetMinutes) * 60 * 1000;
  const startedAt = Date.parse(rec.started_at);
  const setup = spec?.setup ?? [];
  if (setup.length) {
    // the setup writes its temp files to the run's dir too; a repo with no tmp_dir runs it as before
    const r = runSetup(setup, rec.worktree, join(dir, "setup.log"), Object.keys(tmpEnv).length ? agentEnv(process.env, tmpEnv) : undefined);
    if (!r.ok) return finishWithoutAgent(rec, startedAt, `setup に失敗: ${r.failed}\n${r.output}`);
  }
  const roles = readRolesOrNull();
  // the instructions the brief carries: the preparing process wrote them beside the brief, but an instruction approved
  // between the preparing and this start must reach the run, so the first attempt picks again and rebuilds the brief
  // and the arguments when the list changed. A candidate switch picks again as well
  let instructions = preparedInstructions(dir);
  if (spec && roles) {
    const current = specInstructions(spec);
    if (JSON.stringify(current) !== JSON.stringify(instructions)) {
      const plan = planAttempt(id, dir, spec, role, roles, { instructions: current, ...(role.harness === "claude" && rec.session_file ? { claudeSessionId: rec.session_file } : {}) });
      bin = plan.bin;
      args = plan.args;
      instructions = plan.instructions;
    }
  }
  let attemptNo = 0;
  for (;;) {
    attemptNo += 1;
    rec.status = "running";
    rec.role = role.name;
    rec.model = role.model;
    if (role.modelName) rec.model_name = role.modelName;
    rec.role_preset = role;
    rec.budget_minutes = Math.round(budgetMs / 60_000);
    const before = worktreeState(rec.worktree);
    // a require_clean role is held to ending as it began, so the start is read here, after setup, where the agent starts
    if (role.requireClean) {
      rec.state_before_at = new Date().toISOString();
      try { rec.state_before = worktreeSnapshot(rec.worktree); } catch (err) {
        return finishWithoutAgent(rec, startedAt, `開始時の worktree の状態を読めません: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else delete rec.state_before;
    const attempt: LaneAttempt = { role: role.name, model: role.model, ...(role.modelName ? { model_name: role.modelName } : {}), harness: role.harness, contract: contractOf(role), ...(providerOf(role) ? { provider: providerOf(role) } : {}), started_at: new Date().toISOString(), status: "running" };
    // the attempt's budget starts once it can run; setup has its own timeout
    const agentStart = Date.now();
    const remaining = () => budgetMs - (Date.now() - agentStart);

    rec.exit = await spawnLaneProcess(rec, bin, args, env, dir, budgetMs, () => recordStartedRun(rec, spec, instructions));
    collectRun(rec, role, dir, env.CLAUDE_CONFIG_DIR);
    const maxResumes = role.maxResumes ?? 0;
    const lastError = () => (rec.session_file && existsSync(rec.session_file) ? lastProviderError(readFileSync(rec.session_file, "utf8")) : null);
    let waits = 0;
    while (rec.session_file && rec.status === "running" && rec.exit === 0 && !rec.report_md && remaining() > 60 * 1000) {
      // a rate limit is waited out without using up the resumes meant for an agent that stopped short
      const error = lastError();
      const rateLimited = error !== null && isRateLimited(error) && waits < RATE_LIMIT_WAITS_MS.length;
      if (!rateLimited && !needsResume(rec, maxResumes)) break;
      if (rateLimited) {
        const wait = Math.min(RATE_LIMIT_WAITS_MS[waits], remaining() - 60 * 1000);
        waits += 1;
        appendFileSync(join(dir, "supervisor.log"), `[rate limit ${waits}] ${error}; waiting ${Math.round(wait / 1000)}s\n`);
        await sleep(wait);
      } else rec.resumes = (rec.resumes ?? 0) + 1;
      const text = resumeNudge(rec.report, needsReportTool(role) ? REPORT_TOOL_NAME : undefined);
      const msgPath = join(dir, `resume-${(rec.resumes ?? 0) + waits}.md`);
      writeFileSync(msgPath, text);
      appendFileSync(join(dir, "supervisor.log"), `[resume ${rec.resumes ?? 0}+${waits}] exit 0 without report.md; resuming session\n`);
      rec.exit = await spawnLaneProcess(rec, bin, resumeArgs(role, rec, msgPath, text, spec), env, dir, remaining());
      collectRun(rec, role, dir, env.CLAUDE_CONFIG_DIR);
    }

    rec.ended_at = new Date().toISOString();
    rec.duration_ms = Date.now() - startedAt;
    rec.head_after = headOf(rec.worktree);
    if (rec.tool_timeouts) appendFileSync(join(dir, "supervisor.log"), `[tool-timeout] 道具の呼び出しを ${rec.tool_timeouts} 回、上限の ${toolTimeoutOf(rec) ?? "?"} 分で打ち切った（${role.harness === "claude" ? "Claude Code の Bash の timeout。events.jsonl" : TOOL_TIMEOUT_LOG}）\n`);
    sealWorktree(rec);
    const providerError = lastError();
    if (rec.status === "running") {
      const ok = rec.exit === 0 && rec.report_md && (!role.requireClean || rec.clean);
      rec.status = ok ? "done" : "failed";
      if (!ok) {
        const emptyAnswer = rec.exit === 0 && !rec.report_md;
        rec.error = [
          rec.spawn_error ?? null,
          rec.exit !== 0 ? `exit ${rec.exit}` : null,
          emptyAnswer ? `成果物なし（report.md と読める report.json がそろわない${rec.resumes ? `、${rec.resumes} 回再開しても未作成` : ""}${waits ? `、混雑で ${waits} 回待った` : ""}）` : (!rec.report_md ? "成果物なし（report.md と読める report.json がそろわない）" : null),
          providerError ? `最後の応答がエラー: ${providerError}` : null,
          role.requireClean ? worktreeChange(rec) : null,
          rec.tool_timeouts ? `道具の呼び出しを ${rec.tool_timeouts} 回、上限の時間で打ち切った` : null,
        ].filter(Boolean).join(", ");
      }
    }
    if (role.requireClean) settleDirtyWorktree(rec, dir);
    attempt.ended_at = rec.ended_at;
    attempt.status = rec.status;
    attempt.usage = rec.usage;
    attempt.session_file = rec.session_file;
    const kind = failureKindOf({ status: attempt.status, spawnError: rec.spawn_error, providerError });
    if (kind) attempt.failure = kind;
    if (rec.error) attempt.error = rec.error;
    rec.attempts = [...(rec.attempts ?? []), attempt];
    rec.usage = sumUsage(rec.attempts);
    // one consumption row per attempt, appended whether it finished or not: a failed attempt is real spend too.
    // A row that cannot be written is noted and the run goes on
    try {
      appendConsumption({
        at: attempt.ended_at ?? new Date().toISOString(),
        unit: "attempt",
        lane: rec.id,
        ...(rec.idd_id ? { idd_id: rec.idd_id } : {}),
        role: attempt.role,
        model: attempt.model,
        ...(attempt.model_name ? { model_name: attempt.model_name } : {}),
        harness: attempt.harness,
        contract: attempt.contract,
        ...(attempt.provider ? { provider: attempt.provider } : {}),
        input: attempt.usage?.input ?? 0,
        output: attempt.usage?.output ?? 0,
        cache_read: attempt.usage?.cacheRead ?? 0,
        cache_write: attempt.usage?.cacheWrite ?? 0,
        cost: attempt.usage?.cost ?? 0,
        status: attempt.status,
        ...(attempt.failure ? { failure: attempt.failure } : {}),
      });
    } catch (err) {
      appendFileSync(join(dir, "supervisor.log"), `[consumption] 試行の行を書けませんでした: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // a run moves on only when the failure is one the role allows, the worktree is exactly as the attempt left it,
    // it may change roles, and one of its remaining candidates can start now
    const allowed = (role.fallbackOn ?? [...FAILURE_KINDS]).includes(kind as FailureKind);
    // a require_clean role's own check is the stricter one: `git status` reads the same when an untracked record is
    // rewritten, and a change carried to the next candidate would be read there as how the worktree began
    const changed = worktreeState(rec.worktree) !== before || (role.requireClean === true && rec.clean !== true);
    const next = kind && allowed && !changed && !rec.no_fallback && spec ? takeStartable(rec, roles) : null;
    if (!next) {
      if (kind && allowed && changed && (rec.pending?.length ?? 0) > 0 && !rec.no_fallback) {
        rec.error = [rec.error, "試行が worktree を変えたので次の候補へ進まない"].filter(Boolean).join(", ");
      }
      delete rec.pid;
      writeLane(rec);
      return rec;
    }
    const fallback: QuotaFallback = {
      role: role.name,
      fallback: next.role.name,
      reason: attempt.error ?? `失敗の種類: ${kind}`,
      ...(kind ? { kind } : {}),
      ...(next.provider ? { provider: next.provider } : {}),
    };
    rec.fallbacks = [...(rec.fallbacks ?? []), fallback];
    appendFileSync(join(dir, "supervisor.log"), `[fallback] ${role.name} は ${kind} で失敗したので ${next.role.name} で起こし直します: ${attempt.error ?? ""}\n`);
    // the failed attempt's output, session and deliverable are moved aside before the next attempt writes its own,
    // so the next summary and cost read only that attempt and a leftover report is not read as its completion
    stashAttemptOutput(dir, attemptNo);
    stashArtifacts(rec.report, attemptNo);
    clearAttemptState(rec);
    role = next.role;
    if (!spec) { delete rec.pid; writeLane(rec); return rec; }
    const plan = planAttempt(id, dir, spec, role, roles as RolesFile);
    bin = plan.bin;
    args = plan.args;
    env = plan.env;
    budgetMs = plan.budgetMs;
    instructions = plan.instructions;
    rec.tool_timeout_minutes = plan.toolTimeout;
    rec.cache_ttl = plan.cacheTtl;
    if (plan.claudeSessionId) rec.session_file = plan.claudeSessionId;
    else delete rec.session_file;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How a lane's supervisor is started. Under systemd it runs in its own transient scope, so that
 * restarting the service that started it (idd-web) does not kill the lane with the service's cgroup.
 * With a slice, the scope goes into it, so every lane shares the slice's CPU limit.
 */
export function supervisorLaunch(id: string, supervisor: string, scoped: boolean, unit = id, slice?: string): { cmd: string; args: string[] } {
  const direct = ["run", supervisor, id];
  if (!scoped) return { cmd: "bun", args: direct };
  return { cmd: systemdRunBinary(), args: ["--user", "--scope", "--quiet", "--collect", `--unit=idd-lane-${unit.replace(/[^A-Za-z0-9_.-]/g, "_")}`, ...(slice ? [`--slice=${slice}`] : []), "bun", ...direct] };
}

/**
 * The systemctl arguments that give the lanes' slice its limit. --runtime writes only a runtime drop-in, which a
 * reboot forgets. With no quota, the empty CPUQuota= clears one an earlier start may have left.
 */
export function sliceProperties(cpu: LaneCpu): string[] {
  return ["--user", "set-property", "--runtime", cpu.slice, `CPUQuota=${cpu.cpuQuota ?? ""}`, `CPUWeight=${cpu.cpuWeight}`];
}

export type CommandRunner = (cmd: string, args: string[]) => { status: number | null; stderr?: string; error?: Error };

const runCommand: CommandRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
  return { status: r.status, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
};

/**
 * Give the lanes' slice its limit, before every start (the runtime drop-in is gone after a reboot).
 * A failure does not stop the lane, and the returned warning says the limit was not set again.
 */
export function applyLaneSlice(cpu: LaneCpu, run: CommandRunner = runCommand): string | null {
  const args = sliceProperties(cpu);
  const bin = systemctlBinary();
  const r = run(bin, args);
  if (r.status === 0 && !r.error) return null;
  const why = r.error ? String(r.error) : `exit ${r.status}${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ""}`;
  return `[slice] ${bin} ${args.join(" ")} に失敗（${why}）。CPU の上限を付け直せなかった（前の起動の上限が残っていればそれが効く）`;
}

/** the launch of a lane's supervisor: in the lanes' slice when scoped, with the slice given its limit first */
export function planSupervisorLaunch(id: string, supervisor: string, opts: { scoped: boolean; unit?: string; cpu?: LaneCpu; run?: CommandRunner }): { cmd: string; args: string[]; warning?: string } {
  if (!opts.scoped) return supervisorLaunch(id, supervisor, false);
  const cpu = opts.cpu ?? laneCpuSetting();
  const warning = applyLaneSlice(cpu, opts.run);
  return { ...supervisorLaunch(id, supervisor, true, opts.unit ?? id, cpu.slice), ...(warning ? { warning } : {}) };
}

/** the lanes' slice from config/roles.yaml; its defaults when the file cannot be read (the start itself reports that) */
function laneCpuSetting(): LaneCpu {
  try {
    return readRoles().defaults.laneCpu;
  } catch {
    return { ...DEFAULT_LANE_CPU };
  }
}

/** per systemd-run binary, whether it works here (asked once per process for each) */
const scopeUsable = new Map<string, boolean>();

/** systemd-run --user --scope works here; IDD_LANE_SCOPE=off turns it off */
export function canScope(): boolean {
  if (process.env.IDD_LANE_SCOPE === "off") return false;
  const bin = systemdRunBinary();
  let usable = scopeUsable.get(bin);
  if (usable === undefined) {
    const r = spawnSync(bin, ["--user", "--scope", "--quiet", "--collect", "true"], { stdio: "ignore", timeout: 10_000 });
    usable = r.status === 0;
    scopeUsable.set(bin, usable);
  }
  return usable;
}

/**
 * Start a lane under a detached supervisor (survives the caller). With wait=true (default) polls
 * lane.json until the lane leaves "running".
 */
export async function runLane(specPath: string, opts: RunOptions = {}): Promise<LaneRecord> {
  const { rec, dir } = prepareLane(specPath, opts);
  if (opts.dryRun) return rec;
  const supervisor = join(repoRoot(), "packages", "idd-lane", "bin", "supervise.ts");
  const launch = planSupervisorLaunch(rec.id, supervisor, { scoped: canScope() });
  if (launch.warning) appendFileSync(join(dir, "supervisor.log"), `${launch.warning}\n`);
  const child = spawn(launch.cmd, launch.args, {
    cwd: repoRoot(),
    env: agentEnv(),
    detached: true,
    stdio: ["ignore", openSync(join(dir, "supervisor.log"), "a"), openSync(join(dir, "supervisor.log"), "a")],
  });
  child.unref();
  if (opts.wait === false) return rec;
  const deadline = Date.now() + ((rec.budget_minutes ?? 40) + 2) * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const cur = readLane(rec.id);
    if (cur.status !== "running") return cur;
    if (cur.supervisor_pid && !isAlive(cur.supervisor_pid)) { cur.status = "failed"; cur.error = "supervisor ended before the lane finished"; writeLane(cur); return cur; }
  }
  return readLane(rec.id);
}

/** Deliver a follow-up message into an existing lane session (resumes pi headlessly). */
export async function sendLane(id: string, text: string, opts: { wait?: boolean } = {}): Promise<LaneRecord> {
  const rec = readLane(id);
  // a conversation is fed by its supervisor only, so a message never lands on a running reply
  if (rec.mode === "conversation") throw new Error(`lane ${id} は Issue lane の会話です。追信は engine の配信（outbox の envelope）が監督の待ち行列に積みます`);
  if (rec.pid && isAlive(rec.pid)) throw new Error(`lane ${id} はまだ実行中です（pid ${rec.pid}）。stop してから send してください`);
  // the run's supervisor may still be settling what the run left (and its temp dir goes after that): wait for it to end.
  // A supervisor that is this very process has finished the run it is sending to
  if (rec.supervisor_pid && rec.supervisor_pid !== process.pid && isAlive(rec.supervisor_pid)) throw new Error(`lane ${id} の監督がまだ動いています（pid ${rec.supervisor_pid}）。終わってから send してください`);
  if (!rec.session_file) throw new Error(`lane ${id} に session がありません`);
  const dir = laneDir(id);
  const spec = readSpec(rec.spec);
  const roles = readRoles();
  const preset = roles.roles[rec.role];
  if (!preset) throw new Error(`未知の role "${rec.role}"`);
  const role: RolePreset = rec.model_name && roles.models?.[rec.model_name]
    ? resolveRoleModel(rec.role, rec.model_name, roles, spec.thinking)
    : { ...preset, model: rec.model };
  // a follow-up is a new start; the supervisor's own resume of an unfinished lane is not held
  checkClaudeRoles([role], roles);
  assertReportWriter(role);
  const msgPath = join(dir, `send-${Date.now()}.md`);
  writeFileSync(msgPath, text);
  const settings = claudeSettingsFor(role, spec, dir);
  const args = role.harness === "claude" ? buildClaudeArgs(role, rec.session_file, text, true, settings) : piSessionArgs(role, rec.session_file, msgPath, spec);
  const toolTimeout = toolTimeoutOf(rec);
  if (role.harness === "pi") prepareAgentDir(dir, role, { toolTimeoutSeconds: toolTimeoutSeconds(toolTimeout) });
  const env = laneEnv(role, id, dir, toolTimeout, { ...riskPathsEnvForPath(rec.worktree), ...runTmpEnvOf(id, rec.worktree), ...injectionEnvFor(rec.role, dir, spec), ...runLaneEnv(spec), ...reportEnv(role, spec.report) }, cacheTtlOf(rec));
  const bin = role.harness === "claude" ? claudeBinary() : piBinary();
  // as in spawnLaneProcess: a harness that cannot be started fails the lane with the reason; bun throws right
  // away where node emits an error event, and neither may reach the caller with the lane left "running"
  const failStart = (err: unknown): LaneRecord => {
    rec.spawn_error = `${bin} を起動できない: ${err instanceof Error ? err.message : String(err)}`;
    appendFileSync(join(dir, "stderr.log"), `${rec.spawn_error}\n`);
    rec.ended_at = new Date().toISOString();
    rec.exit = 127;
    rec.status = "failed";
    rec.error = rec.spawn_error;
    delete rec.pid;
    writeLane(rec);
    removeRunTmp(id, rec.worktree);
    return rec;
  };
  // a follow-up is held to the same rule from its own start, not from the run's first one
  delete rec.state_before;
  delete rec.state_after;
  delete rec.clean;
  delete rec.worktree_restore;
  if (role.requireClean) {
    // without the start there is nothing to compare the end with, so the follow-up does not run
    rec.state_before_at = new Date().toISOString();
    try { rec.state_before = worktreeSnapshot(spec.worktree); } catch (err) {
      rec.error = `開始時の worktree の状態を読めません: ${err instanceof Error ? err.message : String(err)}`;
      rec.status = "failed";
      rec.ended_at = new Date().toISOString();
      delete rec.pid;
      writeLane(rec);
      removeRunTmp(id, rec.worktree);
      return rec;
    }
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, args, { cwd: spec.worktree, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return failStart(err);
  }
  rec.status = "running"; rec.pid = child.pid; delete rec.ended_at; writeLane(rec);
  const events = streamToFile(child.stdout, join(dir, "events.jsonl"));
  child.stderr?.on("data", (d: Buffer) => appendFileSync(join(dir, "stderr.log"), d));
  const done = new Promise<LaneRecord>((resolveDone) => {
    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      void events.closed(0).then(() => resolveDone(failStart(err)));
    });
    child.on("exit", async (code) => {
      if (settled) return;
      settled = true;
      await events.closed();
      const summary = role.harness === "claude" ? summarizeClaudeEvents(join(dir, "events.jsonl"), toolTimeout) : summarizeEvents(join(dir, "events.jsonl"));
      rec.ended_at = new Date().toISOString();
      rec.exit = code ?? 1;
      rec.final_text = summary.finalText;
      rec.tool_calls = summary.toolCalls;
      rec.turns = summary.turns;
      rec.usage = summary.usage;
      rec.tool_timeouts = countToolTimeouts(role, dir, summary);
      if (role.harness === "claude") keepQuota(rec, summary.quota, env.CLAUDE_CONFIG_DIR);
      sealWorktree(rec);
      rec.report_md = reportComplete(spec.report);
      rec.report_json = existsSync(`${spec.report}.json`);
      // a require_clean follow-up is a success only when the worktree is confirmed the same as at its start
      const unchanged = !role.requireClean || rec.clean === true;
      rec.status = rec.exit === 0 && unchanged ? "done" : "failed";
      if (rec.exit === 0 && !unchanged) rec.error = worktreeChange(rec) ?? "worktree が開始時から変わっている（終了時の状態を読めない）";
      if (role.requireClean) settleDirtyWorktree(rec, dir);
      writeLane(rec);
      removeRunTmp(id, rec.worktree);
      resolveDone(rec);
    });
  });
  if (opts.wait === false) { child.unref(); return rec; }
  return done;
}

export function stopLane(id: string): LaneRecord {
  const rec = readLane(id);
  if (rec.mode === "conversation") {
    // a person stopped it: the watch must not take this for an interruption and start it again
    markStoppedByUser(laneDir(id));
    const owner = liveLockOwner(laneDir(id));
    // the supervisor records its own end; writing the record here too would put back what it has cleared
    if (owner) { process.kill(owner.pid, "SIGTERM"); return rec; }
    rec.status = "stopped";
    rec.ended_at = new Date().toISOString();
    writeLane(rec);
    return rec;
  }
  if (rec.supervisor_pid && isAlive(rec.supervisor_pid)) process.kill(rec.supervisor_pid, "SIGTERM");
  else if (rec.pid && isAlive(rec.pid)) process.kill(rec.pid, "SIGTERM");
  rec.status = "stopped";
  rec.ended_at = new Date().toISOString();
  writeLane(rec);
  return rec;
}

/**
 * A record that says running but names no process yet counts as starting for this long. Measured over the 1,453
 * stage runs in state/lanes (2026-10-14): the supervisor's start (the creation of supervisor.log) to the agent's
 * pid write (the creation of events.jsonl) was 35ms–5.5s (p50 138ms, p95 338ms), and from the record's
 * `started_at` — where the door's clock starts — the longest was 9.4s (p99 4.7s); a run with no setup stayed
 * under 1.7s. 30s leaves about 3x the slowest observed start and still closes a run the machine lost sooner.
 */
export const RUN_START_GRACE_MS = 30_000;

/** what a reading door may swap: the process check, and the moment a record naming no process is judged by */
export interface LaneReadOptions {
  /** how a process number is checked; signal 0 by default */
  alive?: (pid: number) => boolean;
  /** the moment a record naming no process is judged by; now by default */
  now?: number;
}

/**
 * Whether a lane the record says is running still has a process behind it: its supervisor or its agent is
 * alive (the same judgment as laneStatus, without writing the record). One that names no process yet is
 * taken as starting for a short while. Only reads.
 */
export function laneRunAlive(rec: Pick<LaneRecord, "status" | "pid" | "supervisor_pid" | "started_at">, now = Date.now(), alive = isAlive): boolean {
  if (rec.status !== "running") return false;
  if (rec.supervisor_pid || rec.pid) return Boolean((rec.supervisor_pid && alive(rec.supervisor_pid)) || (rec.pid && alive(rec.pid)));
  const started = Date.parse(rec.started_at ?? "");
  return !Number.isNaN(started) && now - started < RUN_START_GRACE_MS;
}

/**
 * Settle a record a reading door has read: one that says running with no process behind it is closed, so a door
 * never answers "running" for a run the machine lost. The record is read once more before the write, because the
 * supervisor writes the end of the run and only then ends; closing on the first read would rewrite a run that just
 * finished as a failure. A record still inside the start grace is not closed, since the record is written before a
 * process can be named. Only reads, and writes the one record it closes.
 */
export function closeDeadRun(rec: LaneRecord, opts: LaneReadOptions = {}): LaneRecord {
  const alive = opts.alive ?? isAlive;
  const now = opts.now ?? Date.now();
  if (rec.status !== "running") return rec;
  // a conversation lane (an Issue lane's planner / executor) is not a one-shot stage run: its state is read
  // from the in-flight mark and the queue, so a reading door never closes it
  if (rec.mode === "conversation") return rec;
  if (laneRunAlive(rec, now, alive)) return rec;
  let fresh: LaneRecord;
  try {
    fresh = readLane(rec.id);
  } catch {
    // another reader is rewriting the record; the next read decides, and this door answers what it has
    return rec;
  }
  if (fresh.status !== "running") return fresh;
  if (laneRunAlive(fresh, now, alive)) return fresh;
  fresh.status = fresh.report_md ? "done" : "failed";
  fresh.error ??= "runner process ended before the lane finished";
  try {
    const named = [fresh.supervisor_pid ? `supervisor ${fresh.supervisor_pid}` : null, fresh.pid ? `agent ${fresh.pid}` : null].filter(Boolean).join(", ");
    appendFileSync(join(laneDir(fresh.id), "supervisor.log"), `[gone] the run's process is gone (${named || "none named"}); closed as ${fresh.status}\n`);
  } catch { /* the log is not why the record closes */ }
  writeLane(fresh);
  return fresh;
}

/** the landing checks of a lane or of the whole state, as `idd lane status` shows them beside the lane runs */
export type LaneStatusRow = LaneRecord | LandCheckSummary;

/**
 * The runs a person reads: the lane runs, and the landing checks of the same lanes (C-144-1: the CLI reads a
 * running check and where it ended from the run's own record). A lane id with only a landing check still answers;
 * an id with neither is not a lane.
 */
export function laneStatus(id?: string, opts: LaneReadOptions = {}): LaneStatusRow[] {
  const land = landChecks(id).map(landCheckSummary);
  if (id) {
    const rec = existsSync(join(laneDir(id), "lane.json")) ? closeDeadRun(readLane(id), opts) : null;
    if (!rec && !land.length) throw new Error(`lane がありません: ${id}`);
    return [...(rec ? [rec] : []), ...land];
  }
  return [...listLanes().map((r) => closeDeadRun(r, opts)), ...land];
}

/** the stream lines a lane wrote: a run's events.jsonl, or a conversation's replies in order */
function laneStreamLines(id: string): string[] {
  const dir = laneDir(id);
  const turns = join(dir, "turns");
  let rec: LaneRecord | null = null;
  try { rec = readLane(id); } catch { /* no record */ }
  if (rec?.mode === "conversation" && existsSync(turns)) {
    return readdirSync(turns)
      .filter((f) => /^\d+\.jsonl$/.test(f))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
      .flatMap((f) => readFileSync(join(turns, f), "utf8").split("\n").filter(Boolean));
  }
  const p = join(dir, "events.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}

/** a lane's last moves, pi's or Claude Code's, one line each */
export function laneTail(id: string, lines = 20): string {
  const evs = laneStreamLines(id).slice(-200);
  // the brief's callback token ends up on command lines; the tail is read in a terminal and by agents
  const secrets = knownSecrets();
  const hide = (s: string) => redactSecrets(s, secrets);
  const out: string[] = [];
  for (const line of evs) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type === "tool_execution_start") out.push(`[tool] ${String(ev.toolName)} ${hide(JSON.stringify(ev.args)).slice(0, 160)}`);
      else if (ev.type === "message_end") {
        const m = ev.message as { role?: string; content?: unknown };
        if (m.role === "assistant" && Array.isArray(m.content)) {
          const text = m.content.filter((c) => (c as { type?: string }).type === "text").map((c) => String((c as { text?: string }).text)).join(" ").replace(/\s+/g, " ").slice(0, 200);
          if (text) out.push(`[assistant] ${hide(text)}`);
        }
      } else {
        for (const e of claudeEventEntries(ev, { secrets })) out.push(e.kind === "tool" ? `[tool] ${e.tool} ${e.body}` : `[${e.kind === "text" ? "assistant" : "error"}] ${e.body}`);
      }
    } catch { /* skip */ }
  }
  return out.slice(-lines).join("\n");
}

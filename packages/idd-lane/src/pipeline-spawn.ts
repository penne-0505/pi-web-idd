import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkPiRoleStartable, preparePipelineAgentDir } from "./agent-dir.ts";
import { fallbackCannotStart, isClaudeQuotaBlocked, quotaFallbackOf, type QuotaFallback } from "./claude-quota.ts";
import { laneStateDir } from "./paths.ts";
import { fallbackNames, resolvePipelineRole, resolveRole, type RolePreset } from "./roles.ts";

/** pi's thinking levels. roles.yaml values outside this set are a typo, not a preference: fail loudly */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PipelineSpawnPlan {
  harness: "pi";
  slot: string;
  role: string;
  model: string;
  initialModel: { provider: string; modelId: string };
  thinkingLevel: PiThinkingLevel;
  /** where the role's shared agent dir lives; created by the engine at delivery, never here */
  agentDir: string;
  /** the resolved role, for the lane record the conversation is opened with */
  preset: RolePreset;
  /** the slot's Claude Code role was refused for the windows at spawn, and this is its fallback */
  quotaFallback?: QuotaFallback;
}

/** a claude slot runs as a conversation lane under the lane supervisor: no pi agent dir, the model is a claude alias / id */
export interface ClaudePipelineSpawnPlan {
  harness: "claude";
  slot: string;
  role: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
  preset: RolePreset;
  /** the slot's own role was refused for the windows and this claude role stands in for it */
  quotaFallback?: QuotaFallback;
}

/** where the runtime keeps per-role agent dirs and per-session spawn records: state/pipeline/ */
export function pipelineStateDir(): string {
  return join(laneStateDir(), "..", "pipeline");
}

export function splitModel(model: string): { provider: string; modelId: string } {
  const at = model.indexOf("/");
  if (at <= 0) throw new Error(`model は provider/modelId の形にしてください: ${model}`);
  return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}

/**
 * Everything the runtime needs to open a conversation for a pipeline slot: a pi or a claude lane. Pure
 * apart from the startability check (a model with no price), so the refusals can be unit-tested without
 * Next.js. The role's agent dir is not written here: the engine prepares it at delivery.
 */
export function planPipelineSpawn(slotName: string, opts: { checkStartable?: (role: RolePreset) => void } = {}): PipelineSpawnPlan | ClaudePipelineSpawnPlan {
  const { role } = resolvePipelineRole(slotName);
  return pipelinePlanFor(slotName, role, opts);
}

/** the same plan for a role the caller already resolved (the candidate of the slot's route) */
export function pipelinePlanFor(slotName: string, role: RolePreset, opts: { checkStartable?: (role: RolePreset) => void } = {}): PipelineSpawnPlan | ClaudePipelineSpawnPlan {
  checkThinking(slotName, role);
  if (role.harness === "claude") return { harness: "claude", slot: slotName, role: role.name, model: role.model, thinkingLevel: role.thinking as PiThinkingLevel, preset: role };
  return piPlan(slotName, role, opts);
}

function checkThinking(slotName: string, role: RolePreset): void {
  // claude maps the same levels to --effort, so a value outside them is a typo there too
  if (!(PI_THINKING_LEVELS as readonly string[]).includes(role.thinking)) throw new Error(`pipeline.${slotName}: thinking "${role.thinking}" は pi の値ではありません（${PI_THINKING_LEVELS.join(" | ")}）`);
}

function piPlan(slotName: string, role: RolePreset, opts: { checkStartable?: (role: RolePreset) => void }): PipelineSpawnPlan {
  (opts.checkStartable ?? checkPiRoleStartable)(role);
  return {
    harness: "pi",
    slot: slotName,
    role: role.name,
    model: role.model,
    initialModel: splitModel(role.model),
    thinkingLevel: role.thinking as PiThinkingLevel,
    agentDir: pipelineAgentDir(role),
    preset: role,
  };
}

/** the shared, per-role agent dir the pipeline's pi roles run and keep their sessions in */
export function pipelineAgentDir(role: RolePreset): string {
  return join(pipelineStateDir(), "agent", role.name);
}

/**
 * A claude slot's conversation refused for the windows at spawn: the plan of its fallback (an API role, so a pi
 * RPC session), carrying what it stands in for. Any other error, or a role with no fallback, is thrown on as it
 * came, so the slot waits for the windows as before; a fallback that cannot start (its agent dir, its price)
 * waits the same way. The fallback decides the whole conversation: a later reply refused for the windows cannot
 * change harness in the middle of it and waits.
 */
export function pipelineQuotaFallback(plan: ClaudePipelineSpawnPlan, err: unknown, opts: { checkStartable?: (role: RolePreset) => void } = {}): PipelineSpawnPlan {
  const names = fallbackNames(plan.preset);
  if (!isClaudeQuotaBlocked(err) || !names.length) throw err;
  const fallback = resolveRole(names[0]);
  checkThinking(plan.slot, fallback);
  let next: PipelineSpawnPlan;
  try {
    next = piPlan(plan.slot, fallback, opts);
  } catch (cause) {
    throw fallbackCannotStart(err, fallback.name, cause);
  }
  return { ...next, quotaFallback: quotaFallbackOf(plan.role, fallback.name, err, { kind: "quota" }) };
}

export interface PipelineSessionRecord {
  session_id: string;
  slot: string;
  role: string;
  model: string;
  /** pi only; empty for a claude conversation */
  agent_dir: string;
  thinking: string;
  spawned_at: string;
  /** the cwd a mode conversation started in, so a conversation nobody has sent to yet reopens in the same place; absent for a lane session */
  cwd?: string;
  /** the Issue lane (IDD-035) the agent reports as; absent for a mode session, which has no lane */
  idd_id?: string;
  /** how the session runs: a conversation lane under the supervisor. Absent for an in-process pi RPC session (a mode) */
  harness?: "pi" | "claude";
  /** a conversation: the lane whose supervisor runs it */
  lane_id?: string;
  /** claude: the Claude Code conversation (--session-id / --resume); the engine's session id is the same value */
  claude_session_id?: string;
  /** pi: the slot's Claude Code role was refused for the windows at spawn and `role` runs in its place */
  quota_fallback?: QuotaFallback;
}

/** the fields a spawn record needs, from a conversation plan or an in-process mode start */
export type PipelineSessionRecordPlan = Pick<PipelineSpawnPlan, "slot" | "role" | "model" | "agentDir" | "thinkingLevel"> & {
  /** an in-process mode start names the model this way; only model / thinking are recorded */
  initialModel?: { provider: string; modelId: string };
  quotaFallback?: QuotaFallback;
  /** a mode conversation's cwd; lane sessions leave it out */
  cwd?: string;
};

/**
 * Remember which role a session was spawned for, so a resume after the idle shutdown (deliver on a
 * dead wrapper) starts pi with the same agent dir — otherwise routing falls back to the user's dir.
 */
export function recordPipelineSession(sessionId: string, plan: PipelineSessionRecordPlan, iddId?: string): string {
  return writePipelineSession({
    session_id: sessionId, slot: plan.slot, role: plan.role, model: plan.model, agent_dir: plan.agentDir, thinking: plan.thinkingLevel, spawned_at: new Date().toISOString(),
    ...(plan.cwd ? { cwd: plan.cwd } : {}),
    ...(iddId ? { idd_id: iddId } : {}),
    ...(plan.quotaFallback ? { quota_fallback: plan.quotaFallback } : {}),
  });
}

export function writePipelineSession(rec: PipelineSessionRecord): string {
  const dir = join(pipelineStateDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${rec.session_id}.json`);
  writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
  return p;
}

/** forget a session's record (a session taken back before it was ever started); none is not a failure */
export function removePipelineSession(sessionId: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) throw new Error(`session id として読めません: ${sessionId}`);
  rmSync(join(pipelineStateDir(), "sessions", `${sessionId}.json`), { force: true });
}

export function readPipelineSession(sessionId: string): PipelineSessionRecord | null {
  const p = join(pipelineStateDir(), "sessions", `${sessionId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as PipelineSessionRecord;
}

/**
 * Options for every startRpcSession call that may revive an existing session (prompt, events, auto-name):
 * a role session must come back with its own agent dir, whichever route wakes it first. A conversation
 * lane runs under the supervisor and has no in-process pi session to revive.
 */
export function pipelineResumeOptions(sessionId: string, opts: { prepareAgentDir?: (role: RolePreset) => string } = {}): { agentDir?: string; iddLaneId?: string } {
  const rec = readPipelineSession(sessionId);
  // a conversation lane (pi or claude) has no in-process pi session to revive
  if (!rec || rec.harness) return {};
  // the lane id survives the idle shutdown: the revived session's bash keeps the report environment
  const lane = rec.idd_id ? { iddLaneId: rec.idd_id } : {};
  // the role's routing may have changed since the spawn; the model stays the one the session recorded
  try {
    const prepare = opts.prepareAgentDir ?? ((r: RolePreset) => preparePipelineAgentDir(join(pipelineStateDir(), "agent"), r));
    return { agentDir: prepare(resolveRole(rec.role)), ...lane };
  } catch {
    return { agentDir: rec.agent_dir, ...lane };
  }
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { laneHoldToken } from "../../idd-core/src/agent/token.ts";
import { jstDay } from "../../idd-core/src/time.ts";
import { plannerRulesBundle } from "../../idd-core/src/rules/rules.ts";

import { preparePipelineAgentDir } from "./agent-dir.ts";
import { recordContextFiles } from "./context-files.ts";
import { agentEnv, withoutHostRuntime, withoutRiskPaths } from "./agent-env.ts";
import { injectionEnv, injectionRecordPath, intentInjectExtensionPath, writeClaudeInjectSettings, ASK_ENV } from "./inject.ts";
import { LANE_SHELL_PASS_ENV, TOOL_TIMEOUT_LOG, TOOL_TIMEOUT_LOG_ENV, TOOL_TIMEOUT_SECONDS_ENV } from "./lane-shell.ts";
import { runPiRpcReply, type PiRpcAsk } from "./pi-rpc-child.ts";
import { isClaudeQuotaBlocked, type ClaudeQuota } from "./claude-quota.ts";
import { acquireLock, holdsLock, liveLockOwner, readLockOwner, releaseLock, stoppedByUserAt } from "./conversation-lock.ts";
import { appendConsumption } from "./consumption.ts";
import { readAgentToken } from "./agent-token.ts";
import { claudeBinary, piBinary, repoRoot } from "./paths.ts";
import { pipelineAgentDir, pipelineStateDir, planPipelineSpawn, readPipelineSession, removePipelineSession, splitModel, writePipelineSession, type ClaudePipelineSpawnPlan, type PipelineSpawnPlan } from "./pipeline-spawn.ts";
import { riskPathsEnvForPath } from "./repos.ts";
import { readRoles, resolveRole, type RolePreset } from "./roles.ts";
import { contractOf, providerOf } from "./route.ts";
import { buildClaudeArgs, cacheTtlOf, canScope, checkClaudeRoles, claimLaneId, keepQuota, laneDir, laneEnv, lastProviderError, planSupervisorLaunch, readLane, runTmpEnvOf, streamToFile, summarizeClaudeEvents, summarizeEvents, toolTimeoutOf, toolTimeoutSeconds, writeLane, type LaneRecord } from "./runner.ts";
import { removeRunTmp } from "./run-tmp.ts";
import { shimEnv } from "./shim.ts";
import { projectTrustFlag } from "./trust.ts";

/*
 * An Issue lane's planner / executor: one long conversation per session, run outside the UI's service.
 * The engine talks to one session, but the harness answers one message per process, so the conversation
 * lives in a lane: messages wait in the lane's queue, and the lane supervisor feeds them one at a time.
 * A message is never sent while a reply is still running. A reply ends when its process exits; there is
 * no deliverable to wait for or to nudge about.
 *
 * Claude Code: the first reply carries --session-id and every later one --resume; the message goes on
 * stdin, so neither its size nor the callback token it carries is on the command line.
 * pi: every reply is `pi -p --mode json --session-id <id>` with the message as a `@file`, so the session
 * picks up where the last reply left it and the engine's session file stays the one it recorded.
 *
 * A pi role's shared agent dir is prepared by the supervisor just before each reply (never by the engine's
 * delivery), and its writes never leave a reader without a link or with a half-written models.json. The engine's
 * delivery only writes the queue: reading a model catalog there would stop its event loop for every message.
 */

const QUEUE = "queue";
const INFLIGHT = "inflight";
const INFLIGHT_RECORD = "inflight.json";
const SENT = "sent";
const TURNS = "turns";
/**
 * What kind of message each queued file carries, kept beside the body (the envelope itself no longer names it).
 * The transcript and the lane's detail read the kind from here; a file without an entry is shown by its body alone.
 */
const MESSAGE_TYPES = "message-types.json";

function readMessageTypes(laneId: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(laneDir(laneId), MESSAGE_TYPES), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function recordMessageType(laneId: string, name: string, type: string): void {
  try {
    const map = readMessageTypes(laneId);
    map[name] = type;
    const names = Object.keys(map).sort();
    // the map is display-only: keep the last 200 names so it does not grow without end
    for (const old of names.slice(0, Math.max(0, names.length - 200))) delete map[old];
    writeFileSync(join(laneDir(laneId), MESSAGE_TYPES), JSON.stringify(map), "utf8");
  } catch { /* the kind is display-only */ }
}

/** the kind recorded for a message file, or undefined when none was */
export function messageType(laneId: string, name: string): string | undefined {
  const type = readMessageTypes(laneId)[name];
  return typeof type === "string" && type ? type : undefined;
}
const TURN_LOG = "turns.jsonl";
const INDEX = "conversations";
const QUOTA_WAIT = "quota-wait.json";
/**
 * What the role's shared shell writes one byte to per call it starts. A pi reply that used the bash tool and left
 * no byte there never reached the shell: an empty tool-timeouts.log cannot tell a cut call from one that ran
 * somewhere else, and a shellPath that pi stopped honoring would leave both logs silent.
 */
const SHELL_PASSES = "shell-passes.log";
/** a message younger than this, with no supervisor yet, counts as one being started */
export const LAUNCH_GRACE_MS = 60_000;

export interface ConversationTurn {
  n: number;
  /** the queue file the message came from */
  message: string;
  resume: boolean;
  started_at: string;
  ended_at: string;
  exit?: number;
  status: "done" | "failed" | "timeout" | "stopped";
  /** the message got into the conversation (Claude started on it); one that did not goes back to the queue */
  reached: boolean;
  /** the question waits this reply did, when it waited for a person's answer */
  question_waits?: { batch_id: string; ms: number }[];
  /** total_cost_usd as Claude reported it: with --resume that is the conversation's total so far */
  reported_cost?: number;
  usage?: LaneRecord["usage"];
  /** the windows this Claude reply reported and the config dir it ran in: one measurement point per reply, which the lane's record (the last one) cannot keep */
  claude_quota?: ClaudeQuota & { config_dir?: string };
  /** Bash calls Claude Code cut at the lane's tool call limit in this reply */
  tool_timeouts?: number;
  /** a pi reply that used the bash tool but left no mark in the lane's shell (the role's shellPath did not reach it) */
  tool_shell_missing?: boolean;
  error?: string;
}

/** how the conversation stands, in the shape of the engine's SessionStatus */
export type ConversationStatus =
  | { state: "running" }
  | { state: "stopped"; cause: "error" | "interrupted" | "finished" | "stopped"; error?: string; at: string }
  /** messages wait for the subscription's windows (not a failure); resetsAt is UNIX seconds */
  | { state: "quota_wait"; reason: string; resetsAt?: number; at: string }
  | { state: "unknown" };

export interface OpenedConversation {
  sessionId: string;
  laneId: string;
}

function indexDir(): string {
  return join(pipelineStateDir(), INDEX);
}

export type ConversationPlan = PipelineSpawnPlan | ClaudePipelineSpawnPlan;

/** which harness feeds a conversation lane (the lane records the role it was opened as) */
export type ConversationHarness = "pi" | "claude";

function harnessOf(rec: LaneRecord): ConversationHarness {
  return rec.role_preset?.harness === "pi" ? "pi" : "claude";
}

/**
 * Spawn for a pipeline slot: no harness can start a conversation without a message, so this only claims
 * the lane and the session id and records them; the first deliver starts the supervisor. A claude slot
 * is gated before anything is claimed (the login is a failure, the windows a wait). `opts.sessionId`
 * takes over a session that already exists (the switch-over adoption).
 */
export function openConversation(plan: ConversationPlan, cwd: string, opts: { sessionId?: string; iddId?: string } = {}): OpenedConversation {
  // the login (a failure) and the windows (a wait, ClaudeQuotaBlocked) as for any Claude Code lane, before anything is claimed
  if (plan.harness === "claude") checkClaudeRoles([plan.preset]);
  const laneId = claimLaneId(plan.role);
  const sessionId = opts.sessionId ?? randomUUID();
  const role = plan.preset;
  let sharedDaemons: string[] | undefined;
  try { sharedDaemons = [...readRoles().defaults.sharedDaemons]; } catch { /* the supervisor reads the setting when it settles */ }
  const rec: LaneRecord = {
    id: laneId, role: role.name, model: plan.model, worktree: cwd, title: `Issue lane ${plan.slot}`, spec: "", report: "",
    status: "idle", started_at: new Date().toISOString(), role_preset: role, budget_minutes: role.budgetMinutes,
    session_file: sessionId, mode: "conversation", slot: plan.slot,
    ...(opts.iddId ? { idd_id: opts.iddId } : {}),
    ...(sharedDaemons ? { shared_daemons: sharedDaemons } : {}),
  };
  mkdirSync(join(laneDir(laneId), QUEUE), { recursive: true });
  writeLane(rec);
  writePipelineSession({
    session_id: sessionId, slot: plan.slot, role: plan.role, model: plan.model,
    agent_dir: plan.harness === "pi" ? plan.agentDir : "", thinking: plan.thinkingLevel,
    spawned_at: rec.started_at, ...(opts.iddId ? { idd_id: opts.iddId } : {}), harness: plan.harness, lane_id: laneId,
    ...(plan.harness === "claude" ? { claude_session_id: sessionId } : {}),
    ...("quotaFallback" in plan && plan.quotaFallback ? { quota_fallback: plan.quotaFallback } : {}),
  });
  // the conversations alone, so the UI's poll need not read every pipeline session's record
  mkdirSync(indexDir(), { recursive: true });
  writeFileSync(join(indexDir(), sessionId), laneId);
  return { sessionId, laneId };
}

/**
 * Prepare the shared agent dir of a pi conversation's role, in the caller's process (the supervisor's, just before
 * the reply it is about to start). The dir is rebuilt from the current roles.yaml, so a routing change is picked up
 * by the next reply, and the write is safe to run beside replies that are already starting. A claude conversation
 * has no pi agent dir.
 */
export function prepareConversationAgentDir(laneId: string): void {
  const rec = readLane(laneId);
  if (harnessOf(rec) !== "pi") return;
  // the record's own preset is the role the lane was pinned to at spawn (a provider column fixed to one provider);
  // re-reading roles.yaml here would let a routing change unfix a conversation that has already run
  const role = rec.role_preset;
  if (!role) return;
  preparePipelineAgentDir(join(pipelineStateDir(), "agent"), role);
}

/**
 * Take back a conversation that was claimed and never given a message (the engine refused the start it was claimed
 * for): its lane is marked stopped, and the session is no longer a conversation, so nothing feeds it, resumes it or
 * lists it as waiting. One that was given a message has started and is left as it is.
 */
export function discardConversation(sessionId: string): void {
  const laneId = conversationLane(sessionId);
  if (!laneId) return;
  const rec = readLane(laneId);
  if (rec.conversation_started || queuedMessages(laneId).length || inflightMessages(laneId).length || conversationTurns(laneId).length) {
    throw new Error(`Claude の会話 ${sessionId} は既に始まっているので取り消せません`);
  }
  writeLane({ ...rec, status: "stopped", ended_at: new Date().toISOString(), error: "engine が起動を取り消しました（lane の段が起動を受け付けませんでした）" });
  rmSync(join(indexDir(), sessionId), { force: true });
  removePipelineSession(sessionId);
}

/** the lane of a conversation (pi or claude), or null when the session is not one */
export function conversationLane(sessionId: string): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) return null;
  try {
    const lane = readFileSync(join(indexDir(), sessionId), "utf8").trim();
    if (lane) return lane;
  } catch { /* not indexed */ }
  let rec;
  try { rec = readPipelineSession(sessionId); } catch { return null; }
  return rec?.lane_id ? rec.lane_id : null;
}

export function isConversation(sessionId: string): boolean {
  return conversationLane(sessionId) !== null;
}

/**
 * The env one reply of a conversation runs with: the lane's own, plus the report CLI's lane id and the
 * callback token read from `<state>/agent-token` at each reply. The token is never written to the lane record.
 * IDD_RISK_PATHS is the lane's worktree repo's own declaration, never the engine's inherited one. The reply's temp dir
 * is the lane's own under the repo's tmp_dir (made here, taken down when the supervisor lets go of the conversation).
 */
export function conversationReplyEnv(rec: LaneRecord, role: RolePreset, dir: string, toolTimeoutMinutes: number | null): NodeJS.ProcessEnv {
  return laneEnv(role, rec.id, dir, toolTimeoutMinutes, { ...reportEnv(rec), ...riskPathsEnvForPath(rec.worktree), ...runTmpEnvOf(rec.id, rec.worktree), ...conversationInjection(rec, role) }, cacheTtlOf(rec));
}

/**
 * What a conversation's hooks read: the injection only for an Issue lane's own conversation (planner / executor).
 * A conversation the engine never gave an Issue lane to gets nothing (DEC-107-3).
 */
function conversationInjection(rec: LaneRecord, role: RolePreset): Record<string, string> {
  if (!rec.idd_id) return {};
  return injectionEnv({ lane: rec.idd_id, stage: rec.slot ?? "conversation", role: role.name, record: injectionRecordPath(laneDir(rec.id)) });
}

/** whether a conversation is one the injection is attached to */
function conversationInjects(rec: LaneRecord): boolean {
  return Boolean(rec.idd_id);
}

/** what the report CLI needs of a reply: the lane it belongs to, the callback token read per reply, and the credential of this lane alone that `idd hold` presents */
function reportEnv(rec: LaneRecord): Record<string, string | undefined> {
  if (!rec.idd_id) return {};
  const token = readAgentToken();
  return { IDD_ID: rec.idd_id, ...(token ? { IDD_AGENT_TOKEN: token, IDD_HOLD_TOKEN: laneHoldToken(rec.idd_id, token) } : {}) };
}

function laneOf(sessionId: string): string {
  const lane = conversationLane(sessionId);
  if (!lane) throw new Error(`会話の記録がありません: ${sessionId}`);
  return lane;
}

let seq = 0;

/** put a message at the end of the lane's queue; written aside and renamed, so a supervisor never reads half of it */
export function queueMessage(laneId: string, text: string, now = Date.now(), type?: string): string {
  const dir = join(laneDir(laneId), QUEUE);
  mkdirSync(dir, { recursive: true });
  seq += 1;
  const name = `${String(now).padStart(15, "0")}-${process.pid}-${String(seq).padStart(6, "0")}.md`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, join(dir, name));
  if (type) recordMessageType(laneId, name, type);
  return name;
}

export function queuedMessages(laneId: string): string[] {
  const dir = join(laneDir(laneId), QUEUE);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort() : [];
}

function queuedAt(name: string): number {
  return Number(name.split("-")[0]) || 0;
}

/**
 * Deliver: queue the message and return at once (the engine's tick does not wait for a reply). A lane
 * whose supervisor is not holding the conversation gets one started; a running one takes the message
 * after its current reply.
 */
/**
 * A reply after roles.yaml moved the slot to another pi model runs on the slot's model now, not the one the
 * conversation was opened with: a model its provider retired (opencode-go's minimax-m3.1-flash-free answered 410
 * on 2026-10-23) would otherwise hold the lane's session through every resume. A Claude Code conversation, one whose
 * model was named for the run, a slot that now plans Claude Code, and a slot that cannot be planned keep the record.
 * So does a conversation whose supervisor is another process's: it holds its own copy of the record and writes it
 * back, so a change here would be overwritten; that supervisor picks the slot's model up itself, before its next
 * reply. The lock's own holder may refresh (`byLockHolder`): it reads the record again after the plan and lays only
 * the model on it, then takes the new model into the copy its reply starts from.
 *
 * What a refresh never moves is the role the conversation was opened as: its name is the agent dir the reply reads
 * its models.json and settings from, and a route that picked a fallback at spawn decided the whole conversation. A
 * slot that now plans another role leaves the record as it is. The provider a `providers` column fixed at spawn stays
 * too, so the reply, the models.json it reads and the consumption row keep naming the provider the conversation
 * started on; a model target on another gateway cannot carry that routing and is left for the next conversation.
 *
 * Reading the plan can take seconds (a model catalog is read): the record is read again after it, so what a
 * supervisor wrote meanwhile (status, pid, a question's wait) is not put back by an older picture.
 */
export function refreshConversationModel(
  laneId: string,
  planFor: (slot: string, checkStartable?: boolean) => PipelineSpawnPlan | ClaudePipelineSpawnPlan = (slot, checkStartable) => planPipelineSpawn(slot, checkStartable ? {} : { checkStartable: () => {} }),
  opts: { byLockHolder?: boolean } = {},
): boolean {
  if (!opts.byLockHolder && conversationLockHeld(laneId)) return false;
  const rec = readLane(laneId);
  const opened = rec.role_preset;
  if (!rec.slot || rec.no_fallback || !opened || opened.harness === "claude") return false;
  // the slot is read without asking pi whether its role can start: that check looks the model up in pi's catalog
  // synchronously, and every delivery would hold the engine for it. It runs only when the model actually moved.
  let plan: PipelineSpawnPlan | ClaudePipelineSpawnPlan;
  try { plan = planFor(rec.slot, false); } catch { return false; }
  if (plan.harness !== "pi" || plan.model === rec.model) return false;
  try { plan = planFor(rec.slot, true); } catch { return false; }
  if (plan.harness !== "pi" || plan.model === rec.model) return false;
  const role = refreshedRole(opened, plan.preset);
  if (!role) return false;
  writeLane({ ...readLane(laneId), model: plan.model, role_preset: role });
  return true;
}

/** the part of a model target that names the gateway the call goes through */
function gatewayOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}

/**
 * The role a conversation's next reply runs as: the one it was opened as, with the model the slot plans now laid on
 * it. Null when the record stays as it is. The opened role's name is the agent dir the reply reads, so another role
 * there is a move the conversation may not make after spawn. A provider the record pinned at spawn (a `providers`
 * column) is kept as it is, and a model on another gateway, which that routing cannot describe, is left for the next
 * conversation rather than re-routed here.
 */
function refreshedRole(opened: RolePreset, planned: RolePreset): RolePreset | null {
  if (planned.name !== opened.name) return null;
  if (providerOf(opened) === undefined) return planned;
  if (gatewayOf(planned.model) !== gatewayOf(opened.model)) return null;
  return { ...planned, provider: opened.provider, routingField: opened.routingField };
}

export function deliverToConversation(sessionId: string, text: string, type?: string): { laneId: string; queued: string; launched: boolean } {
  const laneId = laneOf(sessionId);
  // the slot's model and the role's agent dir are settled by the supervisor just before each reply, in its own
  // process: the delivery writes the queue and wakes the lane, and the engine's event loop is not stopped by a
  // catalog read here (a message every few seconds would stall every other conversation and the tick)
  const queued = queueMessage(laneId, text, Date.now(), type);
  // queue first, then look: a supervisor letting go of the lock looks at the queue again after it has
  if (conversationLockHeld(laneId)) return { laneId, queued, launched: false };
  // over the windows the message waits in the queue, and the watch wakes the lane once they allow it
  if (!gateOpen(laneId)) return { laneId, queued, launched: false };
  startSupervisor(laneId);
  return { laneId, queued, launched: true };
}

interface QuotaWaitRecord {
  reason: string;
  resets_at?: number;
  at: string;
}

function readQuotaWait(laneId: string): QuotaWaitRecord | null {
  try { return JSON.parse(readFileSync(join(laneDir(laneId), QUOTA_WAIT), "utf8")) as QuotaWaitRecord; } catch { return null; }
}

function writeQuotaWait(laneId: string, reason: string, resetsAt?: number): void {
  const p = join(laneDir(laneId), QUOTA_WAIT);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ reason, ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}), at: new Date().toISOString() } satisfies QuotaWaitRecord)}\n`);
  renameSync(tmp, p);
}

function clearQuotaWait(laneId: string): void {
  rmSync(join(laneDir(laneId), QUOTA_WAIT), { force: true });
}

/**
 * Whether the windows let the conversation's Claude Code start now; a refusal is written down as the lane's
 * wait. A lapsed login is left to the supervisor, which records it as the reply's failure.
 */
function gateOpen(laneId: string): boolean {
  const role = readLane(laneId).role_preset;
  if (!role) return true;
  try {
    checkClaudeRoles([role]);
  } catch (err) {
    if (isClaudeQuotaBlocked(err)) {
      writeQuotaWait(laneId, err.message, err.resetsAt);
      return false;
    }
  }
  clearQuotaWait(laneId);
  return true;
}

/**
 * The next chance for a conversation waiting on the windows (the watch asks on every tick): start its
 * supervisor when they allow it. True when one was started.
 */
export async function wakeConversation(sessionId: string): Promise<boolean> {
  const laneId = laneOf(sessionId);
  if (conversationLockHeld(laneId) || !queuedMessages(laneId).length) return false;
  if (!gateOpen(laneId)) return false;
  startSupervisor(laneId);
  return true;
}

/** start a supervisor for a lane; each gets its own scope, since the one letting go may still be exiting */
export function startSupervisor(laneId: string): void {
  const dir = laneDir(laneId);
  const supervisor = join(repoRoot(), "packages", "idd-lane", "bin", "supervise.ts");
  const launch = planSupervisorLaunch(laneId, supervisor, { scoped: canScope(), unit: `${laneId}-${Date.now()}-${process.pid}` });
  const log = openSync(join(dir, "supervisor.log"), "a");
  try {
    if (launch.warning) appendFileSync(join(dir, "supervisor.log"), `${launch.warning}\n`);
    const child = spawn(launch.cmd, launch.args, { cwd: repoRoot(), env: agentEnv(), detached: true, stdio: ["ignore", log, log] });
    child.on("error", (err) => appendFileSync(join(dir, "supervisor.log"), `[launch] ${String(err)}\n`));
    child.unref();
  } finally {
    // the child has its own copy; the long-lived caller (the UI's server) must not keep one per deliver
    closeSync(log);
  }
}

// ---- the lock: one supervisor feeds a conversation at a time ----

/** a live supervisor holds the conversation (its pid is alive and is still the process that took the lock) */
export function conversationLockHeld(laneId: string): boolean {
  return liveLockOwner(laneDir(laneId)) !== null;
}

export function acquireConversationLock(laneId: string): boolean {
  return acquireLock(laneDir(laneId));
}

export function releaseConversationLock(laneId: string): void {
  releaseLock(laneDir(laneId));
}

// ---- the record of replies ----

export function conversationTurns(laneId: string): ConversationTurn[] {
  const p = join(laneDir(laneId), TURN_LOG);
  if (!existsSync(p)) return [];
  const out: ConversationTurn[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ConversationTurn); } catch { /* a partial line */ }
  }
  return out;
}

interface Inflight {
  n: number;
  message: string;
  resume: boolean;
  started_at: string;
}

function readInflight(laneId: string): Inflight | null {
  try { return JSON.parse(readFileSync(join(laneDir(laneId), INFLIGHT_RECORD), "utf8")) as Inflight; } catch { return null; }
}

/**
 * Messages waiting for a supervisor that nobody has picked up: the queue, less what the last supervisor
 * saw there and left (a message Claude never started on waits for the next deliver).
 */
function pendingMessages(laneId: string): string[] {
  let left: string[] = [];
  try { left = readLane(laneId).left_queued ?? []; } catch { /* no record */ }
  return queuedMessages(laneId).filter((m) => !left.includes(m));
}

/** messages wait for the windows: a wait was written down and the queue still holds something */
function quotaWaiting(laneId: string): QuotaWaitRecord | null {
  const wait = readQuotaWait(laneId);
  return wait && queuedMessages(laneId).length && Date.parse(wait.at) > stoppedByUserAt(laneDir(laneId)) ? wait : null;
}

/** a supervisor is feeding the conversation, or a message came that one is being started for */
export function conversationRunning(laneId: string, now = Date.now()): boolean {
  if (conversationLockHeld(laneId)) return true;
  if (quotaWaiting(laneId)) return false;
  const pending = pendingMessages(laneId);
  if (!pending.length) return false;
  const newest = queuedAt(pending[pending.length - 1]);
  return newest > stoppedByUserAt(laneDir(laneId)) && now - newest < LAUNCH_GRACE_MS;
}

export function conversationStatus(sessionId: string, now = Date.now()): ConversationStatus {
  const laneId = laneOf(sessionId);
  const dir = laneDir(laneId);
  if (conversationRunning(laneId, now)) return { state: "running" };
  const wait = quotaWaiting(laneId);
  if (wait) return { state: "quota_wait", reason: wait.reason.slice(0, 400), ...(wait.resets_at !== undefined ? { resetsAt: wait.resets_at } : {}), at: wait.at };
  const turns = conversationTurns(laneId);
  const last = turns[turns.length - 1];
  const stoppedAt = stoppedByUserAt(dir);
  // a supervisor that died in the middle of a reply
  const inflight = readInflight(laneId);
  if (inflight && Date.parse(inflight.started_at) > stoppedAt) return { state: "stopped", cause: "interrupted", at: inflight.started_at };
  const stray = inflightMessages(laneId);
  if (!inflight && stray.length) return { state: "stopped", cause: "interrupted", at: new Date(queuedAt(stray[stray.length - 1])).toISOString() };
  // messages nobody picked up (a supervisor killed, or one that never started)
  const pending = pendingMessages(laneId);
  const newest = pending.length ? queuedAt(pending[pending.length - 1]) : 0;
  if (newest > stoppedAt) return { state: "stopped", cause: "interrupted", at: new Date(newest).toISOString() };
  // a person stopped it, and nothing has been sent since
  if (stoppedAt && (!last || stoppedAt >= Date.parse(last.started_at))) return { state: "stopped", cause: "stopped", at: new Date(stoppedAt).toISOString() };
  // the supervisor itself failed outside a reply
  let rec: LaneRecord | null = null;
  try { rec = readLane(laneId); } catch { /* no record */ }
  if (rec?.status === "failed" && rec.error && rec.ended_at && (!last || rec.ended_at > last.ended_at)) return { state: "stopped", cause: "error", error: rec.error.slice(0, 300), at: rec.ended_at };
  if (!last) return { state: "unknown" };
  if (last.status === "done") return { state: "stopped", cause: "finished", at: last.ended_at };
  if (last.status === "failed") return { state: "stopped", cause: "error", error: (last.error ?? "").slice(0, 300), at: last.ended_at };
  return { state: "stopped", cause: "interrupted", at: last.ended_at };
}

/**
 * The API-equivalent cost of the conversation. Claude reports, for a --resume, the conversation's total so
 * far (checked with haiku, 2026-09-24: 0.0044 → 0.0084 → 0.0125), so the total is the last report; a report
 * lower than the one before it starts a new count (the cost state lost) and is added on.
 */
export function costFromReports(reports: number[]): number {
  let total = 0;
  let prev = 0;
  for (const c of reports) {
    total += c >= prev ? c - prev : c;
    prev = c;
  }
  return Number(total.toFixed(6));
}

function turnsCost(turns: ConversationTurn[]): number {
  return costFromReports(turns.map((t) => t.reported_cost).filter((c): c is number => typeof c === "number" && Number.isFinite(c)));
}

/**
 * A pi conversation's cost is its session record: the sum of what each assistant message reported. The file
 * is found where pi keeps a cwd's sessions under the role's agent dir. A session taken over from before the
 * switch whose own records were written under another cwd has no file there; the cost then falls back to what
 * the replies read, which counts only the turns after the switch-over. The same holds before the first reply.
 */
function piConversationCost(rec: LaneRecord, sessionId: string): number {
  const file = piSessionFile(rec, sessionId);
  if (file) {
    let total = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"assistant"')) continue;
      try {
        const e = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
        if (e.type === "message" && e.message?.role === "assistant") total += Number(e.message.usage?.cost?.total ?? 0) || 0;
      } catch { /* a partial line */ }
    }
    return Number(total.toFixed(6));
  }
  let total = 0;
  for (const t of conversationTurns(rec.id)) total += t.usage?.cost ?? 0;
  return Number(total.toFixed(6));
}

export function conversationCost(sessionId: string): number {
  const laneId = laneOf(sessionId);
  const rec = readLane(laneId);
  return harnessOf(rec) === "pi" ? piConversationCost(rec, sessionId) : turnsCost(conversationTurns(laneId));
}

export interface ConversationCostReading {
  /** the conversation's total, the same value `conversationCost` returns */
  cost: number;
  daily: { day: string; cost: number }[];
  /** the size and update time of the record the reading came from; null when it has no file (a taken-over session) */
  fingerprint: string | null;
}

/** the size-and-update-time fingerprint of a record file, or null when it is gone */
function fingerprintOf(file: string): string | null {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

function byDay(defs: { day: string; cost: number }[]): { day: string; cost: number }[] {
  return defs.map((d) => ({ day: d.day, cost: Number(d.cost.toFixed(6)) })).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * The record a conversation's cost is read from: the pi session file, or the turn log a Claude conversation's
 * reported totals live in. Null when there is no file (a taken-over session whose record stayed elsewhere).
 */
export function conversationCostFingerprint(sessionId: string): string | null {
  let laneId: string;
  try { laneId = laneOf(sessionId); } catch { return null; }
  let rec: LaneRecord;
  try { rec = readLane(laneId); } catch { return null; }
  if (harnessOf(rec) === "pi") {
    const file = piSessionFile(rec, sessionId);
    if (file) return fingerprintOf(file);
    // no session file (a session taken over from before the switch): the cost falls back to the replies' own usage
    return fingerprintOf(join(laneDir(rec.id), TURN_LOG));
  }
  return fingerprintOf(join(laneDir(rec.id), TURN_LOG));
}

/**
 * A conversation's spend split by the JST day each reply was written, with a cheap fingerprint of the record it came
 * from. The total is the one `conversationCost` reads: a pi conversation from its session file (or, with no file, the
 * replies' own usage), a Claude one from the reported totals, each reply's increment on the day it ended.
 */
export function conversationCostReading(sessionId: string): ConversationCostReading {
  let laneId: string;
  try { laneId = laneOf(sessionId); } catch { return { cost: 0, daily: [], fingerprint: null }; }
  let rec: LaneRecord;
  try { rec = readLane(laneId); } catch { return { cost: 0, daily: [], fingerprint: null }; }
  if (harnessOf(rec) === "pi") {
    const file = piSessionFile(rec, sessionId);
    if (file) {
      const daily = new Map<string, number>();
      let total = 0;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes('"assistant"')) continue;
        try {
          const e = JSON.parse(line) as { type?: string; timestamp?: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
          if (e.type !== "message" || e.message?.role !== "assistant") continue;
          const cost = Number(e.message.usage?.cost?.total ?? 0) || 0;
          total += cost;
          const day = jstDay(e.timestamp ?? "");
          if (cost && day) daily.set(day, (daily.get(day) ?? 0) + cost);
        } catch { /* a partial line */ }
      }
      return { cost: Number(total.toFixed(6)), daily: byDay([...daily].map(([day, cost]) => ({ day, cost }))), fingerprint: fingerprintOf(file) };
    }
    const daily = new Map<string, number>();
    let total = 0;
    for (const t of conversationTurns(rec.id)) {
      const cost = t.usage?.cost ?? 0;
      total += cost;
      const day = jstDay(t.ended_at || t.started_at);
      if (cost && day) daily.set(day, (daily.get(day) ?? 0) + cost);
    }
    return { cost: Number(total.toFixed(6)), daily: byDay([...daily].map(([day, cost]) => ({ day, cost }))), fingerprint: null };
  }
  // a Claude report is the conversation's total so far: each reply's increment is its own spend, on the day it ended
  const daily = new Map<string, number>();
  let total = 0;
  let prev = 0;
  for (const t of conversationTurns(rec.id)) {
    const reported = t.reported_cost;
    if (typeof reported !== "number" || !Number.isFinite(reported)) continue;
    const increment = reported >= prev ? reported - prev : reported;
    prev = reported;
    total += increment;
    const day = jstDay(t.ended_at || t.started_at);
    if (increment && day) daily.set(day, (daily.get(day) ?? 0) + increment);
  }
  return { cost: Number(total.toFixed(6)), daily: byDay([...daily].map(([day, cost]) => ({ day, cost }))), fingerprint: fingerprintOf(join(laneDir(rec.id), TURN_LOG)) };
}

/** the worktrees a conversation is running in now (the engine's own sessions included, the UI's aside) */
export function conversationBusyAt(cwd: string, now = Date.now()): boolean {
  const target = resolve(cwd);
  for (const id of liveConversationIds(now)) {
    const lane = conversationLane(id);
    if (!lane) continue;
    try { if (resolve(readLane(lane).worktree) === target) return true; } catch { /* no record */ }
  }
  return false;
}

/** the conversations (pi and claude) a supervisor is feeding now, with their lanes */
function runningConversations(now: number): { sessionId: string; laneId: string }[] {
  const dir = indexDir();
  if (!existsSync(dir)) return [];
  const out: { sessionId: string; laneId: string }[] = [];
  for (const id of readdirSync(dir)) {
    try {
      const lane = readFileSync(join(dir, id), "utf8").trim();
      if (lane && conversationRunning(lane, now)) out.push({ sessionId: id, laneId: lane });
    } catch { /* a lane removed by hand */ }
  }
  return out;
}

/** the engine's session ids of the conversations (pi and claude) a supervisor is feeding now */
export function liveConversationIds(now = Date.now()): string[] {
  return runningConversations(now).map((c) => c.sessionId);
}

/**
 * The pi conversations running now. The sidebar lists pi sessions, so only these belong in its running list:
 * a claude conversation is not in that list, and counting it would make the sidebar read the session list
 * again for an unknown id and sound the completion tone when its reply ends. The UI's own screens and the
 * busy-worktree check count both harnesses, so they keep using `liveConversationIds`.
 */
export function livePiConversationIds(now = Date.now()): string[] {
  return runningConversations(now)
    .filter((c) => {
      try { return harnessOf(readLane(c.laneId)) === "pi"; } catch { return false; }
    })
    .map((c) => c.sessionId);
}

// ---- the supervisor ----

/** claude -p's arguments for a conversation reply, without the message (that goes on stdin) */
export function conversationArgs(role: RolePreset, sessionId: string, resume: boolean, settings?: string, systemPrompts: readonly string[] = []): string[] {
  const args = buildClaudeArgs(role, sessionId, "", resume, settings, systemPrompts);
  if (args[args.length - 2] !== "--" || args[args.length - 1] !== "") throw new Error("buildClaudeArgs の末尾が `-- <本文>` ではありません");
  return args.slice(0, -2);
}

/**
 * The system prompt appendix a stage's replies start with: the planner's norms bundle, and nothing for any other
 * stage. The bundle is built from the package's standards at every start and says nothing about the lane, the Issue
 * or the worktree, so every lane's planner gets the same words. A blind or a confirm gets none: the records' reading
 * must not be pulled toward the norms that judge them. A standards place that cannot be read leaves the
 * appendix out rather than keeping the planner from starting; only the acceptance-criteria section is required, and
 * its absence throws so the planner does not start without the conditions of an AC.
 */
export function stageSystemPrompts(slot: string | undefined): string[] {
  if (slot !== "planner") return [];
  const bundle = plannerRulesBundle();
  return bundle ? [bundle] : [];
}

/**
 * What a pi reply's stream says: whether pi started on the message (the header alone is written before the
 * prompt), and how it ended (the session record's last assistant reply is where a provider error shows).
 */
function piReplyOutcome(eventsPath: string, sessionFile: string | undefined, finalText: string): { reached: boolean; isError: boolean; resultText: string; bashCalls: number } {
  const out = { reached: false, isError: false, resultText: finalText.slice(0, 300), bashCalls: 0 };
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev: { type?: string; toolName?: string };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type && PI_REACHED_EVENTS.has(ev.type)) out.reached = true;
      // the model's own bash tool (the rpc bash command is not in the stream), used to tell a reply that hid its shell
      if (ev.type === "tool_execution_start" && ev.toolName === "bash") out.bashCalls += 1;
    }
  }
  if (sessionFile && existsSync(sessionFile)) {
    const error = lastProviderError(readFileSync(sessionFile, "utf8"));
    if (error) { out.isError = true; out.resultText = error.slice(0, 300); }
  }
  return out;
}

/** events (after the session header) that mean pi took the message up */
const PI_REACHED_EVENTS = new Set(["agent_start", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);

/** what a claude reply's stream says: whether Claude started on the message, and how it ended */
function replyOutcome(eventsPath: string): { reached: boolean; isError: boolean; resultText: string; bashCalls: number } {
  const out = { reached: false, isError: false, resultText: "", bashCalls: 0 };
  if (!existsSync(eventsPath)) return out;
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { type?: string; is_error?: boolean; result?: unknown; subtype?: string };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "system" || ev.type === "assistant" || ev.type === "user") out.reached = true;
    if (ev.type === "result") {
      out.reached = true;
      out.isError = Boolean(ev.is_error);
      out.resultText = typeof ev.result === "string" ? ev.result : String(ev.subtype ?? "");
    }
  }
  return out;
}

function sumUsage(turns: ConversationTurn[], harness: ConversationHarness): LaneRecord["usage"] | undefined {
  const withUsage = turns.filter((t) => t.usage);
  if (!withUsage.length) return undefined;
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of withUsage) {
    u.input += t.usage?.input ?? 0;
    u.output += t.usage?.output ?? 0;
    u.cacheRead += t.usage?.cacheRead ?? 0;
    u.cacheWrite += t.usage?.cacheWrite ?? 0;
  }
  // claude reports a cumulative total (the diff is the reply's own); pi reports each reply's own
  const cost = harness === "pi" ? withUsage.reduce((sum, t) => sum + (t.usage?.cost ?? 0), 0) : turnsCost(turns);
  return { ...u, cost: Number(cost.toFixed(6)) };
}

/** the dir pi keeps a cwd's sessions in, under an agent dir (the same encoding pi's session manager uses) */
export function piSessionDir(cwd: string, agentDir: string): string {
  const resolved = resolve(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

/** the pi session file of a conversation, when it is where pi would have written it */
function piSessionFile(rec: LaneRecord, sessionId: string): string | undefined {
  const role = rec.role_preset;
  if (!role) return undefined;
  const dir = piSessionDir(rec.worktree, pipelineAgentDir(role));
  if (!existsSync(dir)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  const name = readdirSync(dir).find((f) => f.endsWith(suffix));
  return name ? join(dir, name) : undefined;
}

/**
 * The environment a pi conversation's reply runs with: the supervisor's environment with the UI server's own
 * runtime variables dropped, the lane's id, the role's agent dir, and the shim in front of PATH. IDD_RISK_PATHS
 * is the lane's worktree repo's own declaration; an inherited value never reaches a repo that declares none.
 */
export function piConversationEnv(rec: LaneRecord, role: RolePreset): NodeJS.ProcessEnv {
  const timeoutSeconds = toolTimeoutSeconds(toolTimeoutOf(rec));
  return shimEnv(withoutHostRuntime(agentEnv(withoutRiskPaths(process.env), {
    IDD_LANE_ID: rec.id,
    PI_CODING_AGENT_DIR: pipelineAgentDir(role),
    PI_DISABLE_UPDATE_CHECK: "1",
    // the shared role shell reads these per reply: the limit and the log belong to this lane, and the marker in the
    // lane dir says whether the shell ran at all. An empty limit is no limit (the engine's chat carries the same keys).
    [TOOL_TIMEOUT_SECONDS_ENV]: timeoutSeconds === null ? "" : String(timeoutSeconds),
    [TOOL_TIMEOUT_LOG_ENV]: join(laneDir(rec.id), TOOL_TIMEOUT_LOG),
    [LANE_SHELL_PASS_ENV]: join(laneDir(rec.id), SHELL_PASSES),
    ...reportEnv(rec),
    ...riskPathsEnvForPath(rec.worktree),
    ...runTmpEnvOf(rec.id, rec.worktree),
    ...conversationInjection(rec, role),
    // only the Issue lane's own conversation can ask: the supervisor is there to wait and answer
    ...(conversationInjects(rec) ? { [ASK_ENV]: "1" } : {}),
  })));
}

/**
 * pi's arguments for a conversation reply: the engine's session id every time, the record's model and thinking,
 * the trust flag the record's own trust.json implies, and the message as a file. No tool allow-list and no
 * disabling flags: the reply runs with the role's agent dir exactly as the server-internal start did.
 */
export function piConversationArgs(rec: LaneRecord, sessionId: string, systemPrompts: readonly string[]): string[] {
  const role = rec.role_preset;
  if (!role) throw new Error(`lane ${rec.id} に role_preset がありません`);
  const args = [
    "--mode", "rpc",
    "--model", rec.model,
    "--thinking", role.thinking,
    "--session-id", sessionId,
    projectTrustFlag(pipelineAgentDir(role), rec.worktree),
  ];
  // the injection's extension comes in by its path, on top of the tools and extensions the server-inside start
  // had; nothing is taken away (DEC-107-10 / INV-107-5)
  if (conversationInjects(rec)) args.push("--extension", intentInjectExtensionPath());
  // the planner's norms ride the same way whichever harness runs the stage: as pi's system prompt appendix.
  // A reply passes the ones it read before the message left the queue and never reads them again here: a read that
  // failed after the dequeue would fail the reply with its message left in flight.
  for (const prompt of systemPrompts) args.push("--append-system-prompt", prompt);
  return args;
}

function tailOf(p: string, offset: number): string {
  if (!existsSync(p)) return "";
  return readFileSync(p).subarray(offset).toString("utf8").trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

function sizeOf(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

/** the non-empty lines a lane's log holds now; a per-reply count is the difference across that reply */
function lineCount(p: string): number {
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
}

interface ReplyExit {
  exit: number;
  ended: "exit" | "timeout" | "stopped";
  spawnError?: string;
}

/** one reply process: claude reads the message on stdin, pi takes it as a `@file` argument */
function runReply(rec: LaneRecord, bin: string, args: string[], text: string | null, env: NodeJS.ProcessEnv, eventsPath: string, stderrPath: string, budgetMs: number, stopping: () => boolean, floorMs: number): Promise<ReplyExit> {
  return new Promise<ReplyExit>((resolveExit) => {
    let events: ReturnType<typeof streamToFile> | undefined;
    let ended: ReplyExit["ended"] = "exit";
    let spawnError: string | undefined;
    let done = false;
    const timers: { budget?: ReturnType<typeof setTimeout>; stop?: ReturnType<typeof setInterval> } = {};
    const finish = (exit: number) => {
      if (done) return;
      done = true;
      clearTimeout(timers.budget);
      clearInterval(timers.stop);
      // the caller reads the reply's stream right after: wait until what Claude printed is in the file
      const written = events ? events.closed(exit < 0 ? 0 : undefined) : Promise.resolve();
      void written.then(() => resolveExit({ exit, ended, ...(spawnError ? { spawnError } : {}) }));
    };
    let child;
    try {
      child = spawn(bin, args, { cwd: rec.worktree, env, stdio: [text === null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (err) {
      spawnError = String(err);
      // the reply's stream file exists whether or not the harness started, as before
      events = streamToFile(undefined, eventsPath);
      finish(-1);
      return;
    }
    const kill = (why: ReplyExit["ended"]) => { ended = why; try { child.kill("SIGTERM"); } catch { /* gone */ } };
    child.on("error", (err) => {
      spawnError = String(err);
      if (child.pid === undefined) finish(-1);
    });
    if (text !== null && child.stdin) {
      child.stdin.on("error", () => { /* Claude exited before reading it all; its exit says why */ });
      child.stdin.end(text);
    }
    events = streamToFile(child.stdout, eventsPath);
    child.stderr?.on("data", (d: Buffer) => appendFileSync(stderrPath, d));
    if (child.pid !== undefined) {
      rec.pid = child.pid;
      writeLane(rec);
    }
    timers.budget = setTimeout(() => kill("timeout"), Math.max(budgetMs, floorMs));
    timers.stop = setInterval(() => { if (stopping()) kill("stopped"); }, 200);
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

function inflightMessages(laneId: string): string[] {
  const dir = join(laneDir(laneId), INFLIGHT);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort() : [];
}

/**
 * What a supervisor that was killed left half done. The record of what it was sending is written before the
 * message leaves the queue and removed only after the reply's turn is recorded and the message settled, so:
 * a turn already recorded for it is kept as it is; a message still in the queue was never sent; a message in
 * inflight/ is told from the reply's stream whether it reached Claude. A message in inflight/ that nothing
 * records never had a reply started (the order above), so it goes back to the queue.
 */
function recoverInflight(laneId: string, rec: LaneRecord, turns: ConversationTurn[]): void {
  const dir = laneDir(laneId);
  const harness = harnessOf(rec);
  const inflight = readInflight(laneId);
  if (inflight) {
    const recorded = turns.find((t) => t.n === inflight.n && t.message === inflight.message);
    if (recorded) {
      settleMessage(dir, inflight.message, recorded.reached);
      if (recorded.reached) rec.conversation_started = true;
    } else if (existsSync(join(dir, INFLIGHT, inflight.message))) {
      const eventsPath = join(dir, TURNS, `${inflight.n}.jsonl`);
      const summary = harness === "pi" ? summarizeEvents(eventsPath) : summarizeClaudeEvents(eventsPath);
      const outcome = harness === "pi"
        ? piReplyOutcome(eventsPath, piSessionFile(rec, rec.session_file as string), summary.finalText)
        : replyOutcome(eventsPath);
      const turn: ConversationTurn = {
        n: inflight.n, message: inflight.message, resume: inflight.resume, started_at: inflight.started_at, ended_at: new Date().toISOString(),
        status: "failed", reached: outcome.reached, error: "前の監督が応答の途中で終わった",
        ...(typeof summary.usage?.cost === "number" && outcome.isError === false && summary.usage ? { reported_cost: summary.usage.cost, usage: summary.usage } : {}),
      };
      appendFileSync(join(dir, TURN_LOG), `${JSON.stringify(turn)}\n`);
      turns.push(turn);
      settleMessage(dir, inflight.message, outcome.reached);
      if (outcome.reached) rec.conversation_started = true;
    }
    rmSync(join(dir, INFLIGHT_RECORD), { force: true });
  }
  for (const m of inflightMessages(laneId)) {
    const turn = [...turns].reverse().find((t) => t.message === m);
    settleMessage(dir, m, turn?.reached ?? false);
  }
}

/** a message Claude started on is sent; one it never saw goes back to the queue, at its place */
function settleMessage(dir: string, message: string, reached: boolean): void {
  const from = join(dir, INFLIGHT, message);
  if (!existsSync(from)) return;
  renameSync(from, join(dir, reached ? SENT : QUEUE, message));
}

/** the batch an answer message carries, read from the body alone (the kind record is display-only and can be gone) */
const ANSWER_BATCH = /<answers\s+batch-id="([^"]*)"/;

/** the queued message that answers a batch, found by the id in the body */
function answerMessage(laneId: string, batchId: string): { message: string; body: string } | undefined {
  const dir = join(laneDir(laneId), QUEUE);
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort()) {
    let body: string;
    try { body = readFileSync(join(dir, name), "utf8"); } catch { continue; }
    const m = ANSWER_BATCH.exec(body);
    if (m && m[1] === batchId) return { message: name, body };
  }
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for the answer to one `ask` batch and hand it to pi, then move the message to sent and clear the wait.
 * The wait is outside the reply's budget: the rpc child's clock is stopped while the question is pending. The
 * message moves only after pi has it, so a supervisor that dies between the two leaves the answer queued and the
 * next reply passes it again: a duplicate is the smaller harm, a lost answer returns the agent to guessing.
 */
async function answerQuestion(laneId: string, rec: LaneRecord, dir: string, ask: PiRpcAsk, replyEnded: () => boolean, stopping: () => boolean, afterAnswer?: () => void): Promise<void> {
  // the wait this loop owns: another reply's ask writes its own, and this loop must not clear that one
  const wait = { batch_id: ask.batchId, since: new Date().toISOString() };
  try {
    rec.question_wait = wait;
    writeLane(rec);
    for (;;) {
      // the reply that asked is gone: its question ends here and the answer stays queued for the next reply
      if (stopping() || replyEnded()) return void ask.finish(null);
      const found = answerMessage(laneId, ask.batchId);
      if (found) {
        ask.finish(found.body);
        afterAnswer?.();
        const from = join(dir, QUEUE, found.message);
        if (existsSync(from)) renameSync(from, join(dir, SENT, found.message));
        return;
      }
      await sleep(50);
    }
  } catch {
    ask.finish(null);
  } finally {
    // clear only this question's wait: a later reply's ask may already have written its own
    if (rec.question_wait === wait) {
      delete rec.question_wait;
      try { writeLane(rec); } catch { /* the lane dir is gone */ }
    }
  }
}

/**
 * A person stopped the lane and nothing has been queued since: what waits in the queue stays there. The stop
 * signals only a supervisor holding the lock, so one that takes it later (started just before the stop, or
 * taking it back after letting go) must see the stop itself. A message queued after the stop is sent as ever.
 */
function heldByStop(laneId: string): boolean {
  const stoppedAt = stoppedByUserAt(laneDir(laneId));
  return stoppedAt > 0 && !queuedMessages(laneId).some((m) => queuedAt(m) > stoppedAt);
}

/** feed the queued messages one by one while holding the lock; returns what it left in the queue */
async function drain(laneId: string, stopping: () => boolean, replyFloorMs: number, afterAnswer?: () => void): Promise<string[]> {
  const dir = laneDir(laneId);
  const rec = readLane(laneId);
  // the reply's own process may move this to the role the slot plans now; the record's role is what it starts on
  const opening = rec.role_preset;
  if (!opening) throw new Error(`lane ${laneId} に role_preset がありません`);
  let role = opening;
  const harness = harnessOf(rec);
  const sessionId = rec.session_file as string;
  const budgetMs = (rec.budget_minutes ?? role.budgetMinutes) * 60 * 1000;
  for (const d of [QUEUE, INFLIGHT, SENT, TURNS]) mkdirSync(join(dir, d), { recursive: true });
  rec.status = "running";
  rec.supervisor_pid = process.pid;
  delete rec.ended_at;
  delete rec.error;
  // a question wait left by a supervisor that went away is not this reply's; the answer itself is still queued
  delete rec.question_wait;
  writeLane(rec);

  const turns = conversationTurns(laneId);
  recoverInflight(laneId, rec, turns);
  let lastFailed = false;
  let stoppedByReply = false;
  let stoppedByPerson = false;
  try {
    while (!stopping()) {
      const next = queuedMessages(laneId)[0];
      if (!next) break;
      // a supervisor that lost the lock (taken as dead by mistake) must not feed alongside the new owner
      if (!holdsLock(dir)) {
        appendFileSync(join(dir, "supervisor.log"), `[conversation] pid ${process.pid}: the lock is no longer ours; stopping\n`);
        break;
      }
      if (heldByStop(laneId)) {
        appendFileSync(join(dir, "supervisor.log"), `[conversation] pid ${process.pid}: stopped by a person, nothing queued since; stopping\n`);
        stoppedByPerson = true;
        break;
      }
      const n = turns.length + 1;
      const resume = harness === "pi" ? true : Boolean(rec.conversation_started);
      const startedAt = new Date().toISOString();
      const record = (t: Omit<ConversationTurn, "n" | "message" | "resume" | "started_at" | "ended_at">): ConversationTurn => {
        const turn: ConversationTurn = { n, message: next, resume, started_at: startedAt, ended_at: new Date().toISOString(), ...t };
        appendFileSync(join(dir, TURN_LOG), `${JSON.stringify(turn)}\n`);
        // one consumption row per reply: a Claude reply's cost is the rise in the cumulative total it reported,
        // a pi reply's is its own usage. A row that cannot be written is noted and the reply stands
        const numbers = turns.map((x) => x.reported_cost).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
        const replyCost = harness === "claude"
          ? Math.max(0, costFromReports([...numbers, ...(typeof turn.reported_cost === "number" ? [turn.reported_cost] : [])]) - costFromReports(numbers))
          : turn.usage?.cost ?? 0;
        try {
          appendConsumption({
            at: turn.ended_at,
            unit: "reply",
            lane: rec.id,
            ...(rec.idd_id ? { idd_id: rec.idd_id } : {}),
            role: role.name,
            model: role.model,
            harness,
            contract: contractOf(role),
            ...(providerOf(role) ? { provider: providerOf(role) } : {}),
            input: turn.usage?.input ?? 0,
            output: turn.usage?.output ?? 0,
            cache_read: turn.usage?.cacheRead ?? 0,
            cache_write: turn.usage?.cacheWrite ?? 0,
            cost: replyCost,
            status: turn.status,
          });
        } catch (err) {
          appendFileSync(join(dir, "supervisor.log"), `[consumption] 応答の行を書けませんでした: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        turns.push(turn);
        return turn;
      };

      // the gate of every Claude Code lane, before each reply: the windows are a wait (the message stays queued,
      // no reply is recorded, the watch wakes the lane later); a login that lapsed is the reply's failure.
      // A pi lane has no subscription windows to wait for.
      if (harness === "claude") {
        try {
          checkClaudeRoles([role]);
          clearQuotaWait(laneId);
        } catch (err) {
          if (isClaudeQuotaBlocked(err)) {
            writeQuotaWait(laneId, err.message, err.resetsAt);
            appendFileSync(join(dir, "supervisor.log"), `[conversation] waiting for the windows: ${err.message}\n`);
            break;
          }
          clearQuotaWait(laneId);
          record({ status: "failed", reached: false, error: String(err instanceof Error ? err.message : err) });
          lastFailed = true;
          break;
        }
      }

      // the planner's norms are built before the message leaves the queue: a bundle that cannot carry the
      // acceptance-criteria section stops the reply here, naming the file and the heading, and the message stays queued.
      // The bundle read here is the one the reply is sent with: it is not read again after the message has moved.
      let systemPrompts: string[];
      try {
        systemPrompts = stageSystemPrompts(rec.slot);
      } catch (err) {
        record({ status: "failed", reached: false, error: String(err instanceof Error ? err.message : err) });
        lastFailed = true;
        break;
      }

      // the slot's model and the role's agent dir are settled here, in the supervisor's own process, just before
      // the reply: the engine's delivery writes only the queue. The record is read again after the refresh, so
      // what this supervisor wrote meanwhile (status, pid) is not put back, and the reply below runs on the role
      // the dir was prepared for.
      if (harness === "pi") {
        refreshConversationModel(laneId, undefined, { byLockHolder: true });
        prepareConversationAgentDir(laneId);
        const fresh = readLane(laneId);
        rec.model = fresh.model;
        if (fresh.role_preset) {
          rec.role_preset = fresh.role_preset;
          role = fresh.role_preset;
        }
      }

      const text = readFileSync(join(dir, QUEUE, next), "utf8");
      // the record first, whole (written aside and renamed), then the message leaves the queue: a supervisor
      // killed between the two leaves the message where the next one takes it
      const recordTmp = join(dir, `.${INFLIGHT_RECORD}.tmp`);
      writeFileSync(recordTmp, `${JSON.stringify({ n, message: next, resume, started_at: startedAt } satisfies Inflight)}\n`);
      renameSync(recordTmp, join(dir, INFLIGHT_RECORD));
      renameSync(join(dir, QUEUE, next), join(dir, INFLIGHT, next));
      const eventsPath = join(dir, TURNS, `${n}.jsonl`);
      // the context files pi is about to load are copied into the record, for a reader whose stream has no system prompt
      // (the norms are the ones read before the dequeue, so the copy holds the very text pi is given)
      if (harness === "pi") recordContextFiles(dir, rec.worktree, n, systemPrompts.join("\n\n"));
      const timeoutLog = join(dir, TOOL_TIMEOUT_LOG);
      const passLog = join(dir, SHELL_PASSES);
      // a pi reply's cuts are the shell log's lines added during it, and its reach of the shell is a byte marked in it
      const cutsBefore = harness === "pi" ? lineCount(timeoutLog) : 0;
      const passesBefore = harness === "pi" ? sizeOf(passLog) : 0;
      const toolTimeout = toolTimeoutOf(rec);
      const env = harness === "pi" ? piConversationEnv(rec, role) : conversationReplyEnv(rec, role, dir, toolTimeout);
      const args = harness === "pi" ? piConversationArgs(rec, sessionId, systemPrompts) : conversationArgs(role, sessionId, resume, conversationInjects(rec) ? writeClaudeInjectSettings(dir) : undefined, systemPrompts);
      const bin = harness === "pi" ? piBinary() : claudeBinary();
      const stderrPath = join(dir, "stderr.log");
      const stderrOffset = sizeOf(stderrPath);
      let reply: ReplyExit;
      let piReached: boolean | undefined;
      let waits: { batchId: string; ms: number }[] = [];
      // ends the reply's question wait: pi dying must not leave the wait loop polling and swallowing a later answer
      let replyEnded = false;
      try {
        if (harness === "pi") {
          const pi = await runPiRpcReply({
            bin, args, cwd: rec.worktree, env, message: text, eventsPath, stderrPath, budgetMs, floorMs: replyFloorMs, stopping,
            onPid: (pid) => { rec.pid = pid; writeLane(rec); },
            onAsk: (ask) => { void answerQuestion(laneId, rec, dir, ask, () => replyEnded, stopping, afterAnswer); },
          });
          piReached = pi.reached;
          waits = pi.waits;
          reply = { exit: pi.exit, ended: pi.ended, ...(pi.spawnError ? { spawnError: pi.spawnError } : {}) };
        } else {
          reply = await runReply(rec, bin, args, text, env, eventsPath, stderrPath, budgetMs, stopping, replyFloorMs);
        }
      } catch (err) {
        reply = { exit: -1, ended: "exit", spawnError: String(err) };
      } finally {
        replyEnded = true;
      }
      const summary = harness === "pi" ? summarizeEvents(eventsPath) : summarizeClaudeEvents(eventsPath, toolTimeout);
      const baseOutcome = harness === "pi"
        ? piReplyOutcome(eventsPath, piSessionFile(rec, sessionId), summary.finalText)
        : replyOutcome(eventsPath);
      // pi's own response is the word on whether it took the message: a reply that never started goes back to the queue
      const outcome = harness === "pi" && piReached === false ? { ...baseOutcome, reached: false } : baseOutcome;
      // the windows this reply reported become the account's last observation, which the gate reads
      if (harness === "claude") keepQuota(rec, summary.quota, env.CLAUDE_CONFIG_DIR);
      // a pi reply's cuts are what the shared shell wrote to this lane's log during the reply; Claude reports its own
      const toolTimeouts = harness === "claude" ? (summary.toolTimeouts ?? 0) : Math.max(0, lineCount(timeoutLog) - cutsBefore);
      const shellMissing = harness === "pi" && baseOutcome.bashCalls > 0 && sizeOf(passLog) === passesBefore;
      const status: ConversationTurn["status"] = reply.ended === "stopped" ? "stopped" : reply.ended === "timeout" ? "timeout"
        : !reply.spawnError && reply.exit === 0 && !outcome.isError ? "done" : "failed";
      const error = status === "done" ? undefined
        : status === "timeout" ? `応答が予算の ${rec.budget_minutes ?? role.budgetMinutes} 分を超えた`
          : status === "stopped" ? "監督が止められた"
            : [reply.spawnError ?? null, reply.exit !== 0 ? `exit ${reply.exit}` : null, harness === "pi" && !outcome.reached ? "pi が発言を受け付けなかった" : null, outcome.isError ? outcome.resultText : null, tailOf(stderrPath, stderrOffset) || null].filter(Boolean).join(": ");
      record({
        exit: reply.exit, status, reached: outcome.reached,
        ...(summary.usage && typeof summary.usage.cost === "number" ? { reported_cost: summary.usage.cost, usage: summary.usage } : {}),
        ...(harness === "claude" && summary.quota ? { claude_quota: { ...summary.quota, ...(env.CLAUDE_CONFIG_DIR ? { config_dir: resolve(env.CLAUDE_CONFIG_DIR) } : {}) } } : {}),
        ...(toolTimeouts ? { tool_timeouts: toolTimeouts } : {}),
        ...(shellMissing ? { tool_shell_missing: true } : {}),
        ...(waits.length ? { question_waits: waits.map((w) => ({ batch_id: w.batchId, ms: w.ms })) } : {}),
        ...(error ? { error } : {}),
      });
      if (toolTimeouts) {
        rec.tool_timeouts = (rec.tool_timeouts ?? 0) + toolTimeouts;
        appendFileSync(join(dir, "supervisor.log"), `[tool-timeout] 応答 ${n} で道具の呼び出しを ${toolTimeouts} 回、上限の時間で打ち切った（turns/${n}.jsonl）\n`);
      }
      if (shellMissing) {
        appendFileSync(join(dir, "supervisor.log"), `[tool-shell] 応答 ${n} は bash の道具を ${baseOutcome.bashCalls} 回使ったが、包みのシェルを一度も通らなかった（turns/${n}.jsonl）\n`);
      }
      settleMessage(dir, next, outcome.reached);
      rmSync(join(dir, INFLIGHT_RECORD), { force: true });
      lastFailed = status !== "done";
      if (outcome.reached) rec.conversation_started = true;
      rec.exit = reply.exit;
      rec.usage = sumUsage(turns, harness);
      rec.turns = (rec.turns ?? 0) + summary.turns;
      rec.tool_calls = (rec.tool_calls ?? 0) + summary.toolCalls;
      if (summary.finalText) rec.final_text = summary.finalText;
      delete rec.pid;
      writeLane(rec);
      if (status === "stopped") { stoppedByReply = true; break; }
      // Claude already has this conversation (a first reply cut short before the record caught up): resume it
      if (harness === "claude" && !outcome.reached && !resume && /already in use/i.test(error ?? "")) {
        rec.conversation_started = true;
        continue;
      }
      // the harness never started on it (the process failed at once): leave it for the resume rather than spin on it
      if (!outcome.reached) break;
    }
  } finally {
    const left = queuedMessages(laneId);
    rec.status = stopping() || stoppedByReply || stoppedByPerson ? "stopped" : lastFailed ? "failed" : "idle";
    rec.ended_at = new Date().toISOString();
    rec.left_queued = left;
    delete rec.pid;
    delete rec.supervisor_pid;
    // no reply is running now: a question's wait is over, and its answer waits in the queue for the next reply
    delete rec.question_wait;
    writeLane(rec);
  }
  return rec.left_queued ?? [];
}

/** the supervisor failed outside a reply: put the cause where the engine and the UI read the lane */
function recordSupervisorFailure(laneId: string, err: unknown): string[] {
  const error = `監督が異常終了した: ${String(err instanceof Error ? err.message : err)}`.slice(0, 500);
  try { appendFileSync(join(laneDir(laneId), "supervisor.log"), `[conversation] ${error}\n`); } catch { /* lane dir gone */ }
  const left = queuedMessages(laneId);
  try {
    const rec = readLane(laneId);
    rec.status = "failed";
    rec.error = error;
    rec.ended_at = new Date().toISOString();
    rec.left_queued = left;
    delete rec.pid;
    delete rec.supervisor_pid;
    writeLane(rec);
  } catch { /* no record */ }
  return left;
}

export interface RunConversationOptions {
  /** called after the queue is drained, before the lock is let go (tests use it to queue at that moment) */
  beforeRelease?: () => void;
  /** called after an answer is handed to pi and before its message leaves the queue (tests use it) */
  afterAnswer?: () => void;
  /** how soon a reply may be cut for its budget; the role's minutes are the real bound (tests shorten this) */
  replyFloorMs?: number;
}

/**
 * The supervisor of a conversation lane. It holds the lock while it feeds the queue, lets go when the
 * queue is empty, and looks at the queue once more after letting go: a deliver that saw the lock still
 * held left its message for this supervisor. What counts is the queue's contents, not times: a message
 * that was not there when it let go is fed; one it left there itself waits for the next deliver.
 */
export async function runConversation(laneId: string, opts: RunConversationOptions = {}): Promise<LaneRecord> {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const dir = laneDir(laneId);
  try {
    for (;;) {
      if (!acquireConversationLock(laneId)) {
        appendFileSync(join(dir, "supervisor.log"), `[conversation] pid ${process.pid}: supervisor ${readLockOwner(dir)?.pid ?? "?"} holds the conversation; leaving it the queue\n`);
        break;
      }
      let left: string[];
      try {
        left = await drain(laneId, () => stopping, opts.replyFloorMs ?? 60_000, opts.afterAnswer);
      } catch (err) {
        left = recordSupervisorFailure(laneId, err);
      } finally {
        opts.beforeRelease?.();
        // the conversation's temp dir lives while this supervisor feeds it (what a reply's Claude Code or a process it
        // started keeps there may be read by the next reply) and goes before the lock does, so it is never taken from
        // under the next supervisor's reply
        try { removeRunTmp(laneId, readLane(laneId).worktree); } catch { /* an unreadable record: the next run's sweep takes it */ }
        releaseConversationLock(laneId);
      }
      if (stopping || !queuedMessages(laneId).some((m) => !left.includes(m))) break;
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  return readLane(laneId);
}

// ---- the engine's own sessions: taking one over, and telling them from the UI's ----

/** the pipeline slots the engine runs as conversations (spawn records for these are the engine's) */
export const SUPERVISED_SLOTS: readonly string[] = Object.freeze(["planner", "executor"]);

/**
 * Whether the engine's own supervisor owns this session: a conversation lane (pi or claude) now, or a spawn
 * record for a planner / executor slot from before the switch-over. The UI must not start one in-process:
 * that would put a second writer on the session's record.
 */
export function isSupervisedPipelineSession(sessionId: string): boolean {
  if (conversationLane(sessionId)) return true;
  try {
    const rec = readPipelineSession(sessionId);
    return rec !== null && SUPERVISED_SLOTS.includes(rec.slot);
  } catch {
    return false;
  }
}

/**
 * Take over a planner / executor pi session that was started in the UI's process before the switch-over: open
 * the conversation lane for it (keeping its session id) and give it the lane's worktree, so its next delivery
 * runs outside the server. The worktree is the delivery's cwd, else the session record's own cwd; neither means
 * there is nowhere to run it and the delivery fails. A session that is already a conversation comes back as it is.
 */
export function adoptPipelineConversation(sessionId: string, opts: { cwd?: string; sessionFile?: string } = {}): OpenedConversation {
  const existing = conversationLane(sessionId);
  if (existing) return { sessionId, laneId: existing };
  const rec = readPipelineSession(sessionId);
  if (!rec || !SUPERVISED_SLOTS.includes(rec.slot)) throw new Error(`引き取れる pipeline の記録がありません: ${sessionId}`);
  const role = resolveRole(rec.role);
  const worktree = opts.cwd ?? sessionCwd(opts.sessionFile);
  if (!worktree) throw new Error(`session ${sessionId} の worktree が分かりません（配信の cwd も session の記録の cwd もありません）`);
  return openConversation({
    harness: "pi", slot: rec.slot, role: rec.role, model: rec.model,
    initialModel: splitModel(rec.model), thinkingLevel: rec.thinking as PipelineSpawnPlan["thinkingLevel"],
    agentDir: rec.agent_dir || pipelineAgentDir(role),
    // the lane snapshot carries the spawn record's thinking, so every reply of the adopted session runs with
    // what it was started with (the role's current routing still shapes the agent dir)
    preset: { ...role, thinking: rec.thinking },
    // the lane the session belongs to rides along, so every reply keeps the report CLI's environment (and the
    // spawn record keeps it too, for a start taken back and revived in-process)
  }, worktree, { sessionId, ...(rec.idd_id ? { iddId: rec.idd_id } : {}) });
}

/** the cwd a pi session file's header carries, when the file can be read */
function sessionCwd(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]) as { cwd?: unknown };
    return typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

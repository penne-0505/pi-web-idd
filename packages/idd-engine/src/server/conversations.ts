import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentEnv, checkClaudeConfigDir, effectiveModeType, isSupervisedPipelineSession, piBinary, piSessionDir, pipelineAgentDir, pipelineStateDir, planModeStart,
  projectTrustFlag, quotaFromEvent, readModes, readPipelineSession, readRoles, recordClaudeQuota, recordPipelineSession, removePipelineSession, repoForPath, resolveRole,
  splitModel, userAgentDir, withoutHostRuntime, writePipelineSession, type ModeStartPlan, type RolePreset, type SessionMode, type SessionType,
} from "@idd/lane";
import { conversationInstructionPrompt, pickInstructions, recordInjection, type Picked } from "@idd/core";

import {
  appendCostLine, ConversationLog, conversationCostOf, costTotalOf, foldPiEvent, readCostLines,
  type ConversationEventType, type PiUsage,
} from "./conversation-events.ts";
import { prepareAgentDirAsync } from "./agent-dir-prep.ts";
import { withConversationIdentity } from "./conversation-env.ts";
import { enabledSkillPaths, featureTools, readConversationSettings } from "./conversation-settings.ts";
import { generateConversationTitle, readTitleMaterial, titleMaterial } from "./conversation-title.ts";
import {
  ephemeralDir, ephemeralRecordPath, ephemeralSessionFile, ephemeralSessionMtimeAsync, isEntryId, listEphemeralRecordsAsync, planFork, readEphemeralRecord,
  readSessionRecord, removeEphemeralBranch, removeEphemeralBranchAsync, writeBranch, writeEphemeralRecord, ephemeralRetentionMs,
  type ConsultMark, type EphemeralRecord,
} from "./ephemeral.ts";
import { removeConsultCopyPath, sweepConsultCopies } from "./consult-copy.ts";
import { claudeQuotaView } from "./claude-view.ts";
import { PiRpcProcess, type PiRpcRecord, type RpcChild } from "./pi-rpc.ts";
import {
  ClaudeRpcProcess, claudeChatArgs, claudeChatEnv, claudeChatForkArgs, claudeRecordHasMessage, claudeRecordPath, foldClaudeEvent, readClaudeChatTitle, readClaudeEntries, removeClaudeChatTitle,
  type ClaudeRecord,
} from "./claude-rpc.ts";
import { CONVERSATION_TYPE_COMMAND_TEXT, CONVERSATION_TYPE_CUSTOM_TYPE } from "./pi-extensions/conversation-type.ts";
import { PROPTER_READ_TOOL_NAME } from "./pi-extensions/propter-read.ts";
import { ConversationRefused } from "./refusal.ts";
import { assertMarksWritable, readMarks, removeSessionMark, setSessionMark, type MarksFile, type SessionMark } from "./marks.ts";
import { memorySystemPrompts } from "./memory-context.ts";
import { hasSpace, readSpace, renderSpaceContext } from "./spaces.ts";
import {
  CONVERSATION_SESSION_ID, candidateModes, modeForCwd, readHeader, safeModes, sessionIdOf, spawnModeForSession,
  walkSessionFiles, type SessionHeader,
} from "./session-index.ts";
import { resolveSessionFile } from "./session-file.ts";
import { isWithin, comparablePath, resolveWorkdir, workdirOf } from "./workspace.ts";

// kept as this module's export: the conversation doors and the modules they rest on refuse the same way
export { ConversationRefused };

/** the session id shape lives with the record index, so every door checks it the same way */
export { CONVERSATION_SESSION_ID };

/** one image attached to a message, in pi's own `prompt` / `steer` shape */
export interface PiImage {
  type?: "image";
  data: string;
  mimeType: string;
}

export interface QueueItem {
  id: string;
  text: string;
  model?: string;
  effort?: string;
  images?: PiImage[];
}

export interface QueueItemPatch {
  text?: string;
  model?: string | null;
  effort?: string | null;
  images?: PiImage[] | null;
}

export interface ConversationSummary {
  id: string;
  mode: string;
  cwd: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  cost: number;
  open: boolean;
  running: boolean;
  /** the mode's pi tool allow-list, for a client that must show the tools without starting pi */
  tools: string[];
  /** the session's marks, read from the workspace's one marks file */
  pinned: boolean;
  archived: boolean;
  bookmarks: string[];
  space?: string;
  /** the cwd as a path under the mode's workspace; the workspace itself is the empty string */
  workdir: string;
  /** the conversation's current type, for a mode that defines types */
  type?: string;
  /** the document the current type's dir holds for this conversation, when the history names one */
  document?: ConversationDocument;
}

/** the document a conversation's type points at, as the list and open doors report it */
export interface ConversationDocument {
  /** the absolute path of the last document the branch wrote into the type's dir */
  path: string;
  /** the document's frontmatter `status`, or null when it has none or cannot be read */
  status: string | null;
}

export interface ConversationOpenState {
  id: string;
  mode: string;
  cwd: string;
  model?: string;
  effort?: string;
  streaming: boolean;
  promptPending: boolean;
  compacting: boolean;
  runStartSeq?: number;
  queue: QueueItem[];
  entries: unknown[];
  leafId: string | null;
  cost: number;
  /** pi's own context figures; null when pi does not answer or reports none */
  contextUsage: ContextUsage | null;
  /** the warnings the input's top edge shows; the engine decides them, the screen never does (DEC-118-4) */
  notices: ConversationNotice[];
  /** the thinking levels the current model accepts, as pi reports them (DEC-118-3) */
  efforts?: string[];
  /**
   * the harness this conversation's start arguments are built for; a screen reads it to tell whether the
   * settings' skill and tool switches reach this conversation's next start at all
   */
  harness: "pi" | "claude";
  /** the features the running pi was started with, so a screen can show a switch's real effect */
  features: ConversationFeatures;
  /** the conversation's current type, for a mode that defines types */
  type?: string;
  /** the document the current type's dir holds for this conversation, when the history names one */
  document?: ConversationDocument;
}

/**
 * The features one pi was started with, held for as long as that pi runs: the skill directories it was handed
 * and the two tool switches. A change to the settings reaches only the next pi, so the screen reads these to
 * tell what the open conversation's pi is really running with.
 */
export interface ConversationFeatures {
  webSearch: boolean;
  mcp: boolean;
  /** the skill directories this pi was handed at start; a branch is handed the same ones as its parent */
  skills: string[];
}

/** what pi reports of a session's context use (any field may be null right after a compaction) */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

/**
 * One warning the composer's top edge shows. The engine decides whether a warning is owed; the screen only
 * draws the list it was handed and never compares a number to a threshold of its own (DEC-118-4).
 */
export type ConversationNotice =
  | { kind: "context"; percent: number }
  | { kind: "quota"; provider: string; window: string; label: string; utilization: number; resets?: string; rejected?: boolean };

/**
 * One model this conversation's pi will accept, with the capabilities pi's own definition names (DEC-118-1,
 * DEC-118-2). `id` is `provider/modelId`, the name pi's `set_model` and `--model` take.
 */
export interface ConversationModelOption {
  id: string;
  name: string;
  provider: string;
  contextWindow: number | null;
  capabilities: ("image" | "reasoning")[];
}

/** the percentage at which pi's own figures earn a context notice (DEC-118-4) */
export const CONTEXT_NOTICE_PERCENT = 90;

/** one session's marks, in the shape the list and the marks door carry */
export interface ConversationMarks {
  pinned: boolean;
  archived: boolean;
  bookmarks: string[];
  space?: string;
}

/** what raising an ephemeral branch to a mode's session reports back */
export interface PromotionResult {
  id: string;
  mode: string;
  cwd: string;
  role: string;
  tools: string[];
  /** the queued items the close threw away, so the caller knows what was not sent */
  droppedQueue: QueueItem[];
  sessionFile: string;
}

/** the engine's answer for a conversation that is not one the engine may open */

/** the bridging door's commands a Claude conversation can answer; the rest have no stream-json meaning */
const CLAUDE_BRIDGED_COMMANDS = new Set(["set_session_name", "get_session_stats", "get_last_assistant_text"]);

const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** how long a conversation with no reader and no queue lives (a test shortens it through the environment) */
export function conversationIdleMs(): number {
  const raw = Number(process.env.IDD_CONVERSATION_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

/** how long a promotion waits for pi's process to be gone before it refuses (a test shortens it) */
function promoteExitTimeoutMs(): number {
  const raw = Number(process.env.IDD_PROMOTE_EXIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : PROMOTE_EXIT_TIMEOUT_MS;
}

/** how long a close waits for pi's process to be gone before it forces it down (a test shortens it) */
function closeExitTimeoutMs(): number {
  const raw = Number(process.env.IDD_CLOSE_EXIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLOSE_EXIT_TIMEOUT_MS;
}

/**
 * Prepare a role's agent dir in a child, not in the engine's own process: the preparation runs pi's catalog
 * synchronously (and can fetch a gateway's price list) and would freeze the engine's event loop and every
 * other conversation while it does. Shared with the one-shot title generation in `agent-dir-prep.ts`.
 */

/** the environment a conversation's pi runs with: the engine's, less its credentials and server runtime */
export function conversationPiEnv(agentDir: string, sessionId?: string): NodeJS.ProcessEnv {
  return withConversationIdentity(withoutHostRuntime(agentEnv(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_UPDATE_CHECK: "1" })), sessionId);
}

/** the extension that carries a type instruction; every conversation's pi loads it, so the switch never respawns */
const CONVERSATION_TYPE_EXTENSION = fileURLToPath(new URL("./pi-extensions/conversation-type.ts", import.meta.url));

/** the extension that carries the read-only door onto propter's records; a chat mode's own conversation loads it */
const PROPTER_READ_EXTENSION = fileURLToPath(new URL("./pi-extensions/propter-read.ts", import.meta.url));

/**
 * Whether a conversation is given the read-only door onto propter's records: a chat mode's own conversation,
 * never an ephemeral branch. A consultation and a BTW branch are ephemeral, so neither carries it (C-167-2,
 * DEC-9021); the mode's role tools and the list's tools stay untouched (DEC-2010).
 */
export function usesPropterRead(modeName: string, ephemeral: boolean): boolean {
  return !ephemeral && modeName === "chat";
}

/**
 * The engine's arguments for a conversation's pi, in `--mode rpc`. When pi has no record of the session yet,
 * it starts on the model and effort the conversation holds (or the mode's role defaults); when it has a
 * record, no model rides along and pi resumes the last values its own record holds. The mode's tools and the
 * project trust the role's record implies ride along; the cwd's AGENTS.md is pi's to load (no
 * `--no-context-files`). An ephemeral branch's pi gets its own `--session-dir`. A conversation that belongs to
 * a space gets the space's context as one `--append-system-prompt`; reference paths stay strings, and a
 * space whose dir is gone adds nothing. The mode's memory rides in the same way: a text that names the dir
 * and its top-level index, and the index path itself, which pi reads as a file at start.
 *
 * Skill discovery is off (`--no-skills`); `features.skills` names the enabled skill dirs explicitly, so a
 * skill that is off is never in pi's prompt. `features.extraTools` appends the web-search / MCP tool names to
 * the role's own allow-list; it is empty for an ephemeral branch. `features.propterRead` attaches the read-only
 * door onto propter's records and names its tool for the allow-list; only a chat mode's own conversation asks.
 */
export function conversationPiArgs(
  plan: ModeStartPlan,
  sessionId: string,
  startFresh: { model?: string; effort?: string } | null,
  sessionDir?: string,
  appendPrompts?: readonly string[],
  features: { skills?: readonly string[]; extraTools?: readonly string[]; propterRead?: boolean } = {},
): string[] {
  const args = ["--mode", "rpc", "--session-id", sessionId];
  if (sessionDir) args.push("--session-dir", sessionDir);
  if (startFresh) args.push("--model", startFresh.model ?? plan.role.model, "--thinking", startFresh.effort ?? plan.thinkingLevel);
  args.push("--no-skills");
  for (const skill of features.skills ?? []) args.push("--skill", skill);
  // the type instruction travels as an extension command; it is attached for every conversation so a switch
  // never has to change the launch arguments or respawn pi
  args.push("--extension", CONVERSATION_TYPE_EXTENSION);
  const extraTools = [...(features.extraTools ?? [])];
  if (features.propterRead) {
    args.push("--extension", PROPTER_READ_EXTENSION);
    extraTools.push(PROPTER_READ_TOOL_NAME);
  }
  args.push("--tools", [...plan.toolNames, ...extraTools].join(","));
  args.push(projectTrustFlag(plan.agentDir, plan.cwd));
  for (const prompt of appendPrompts ?? []) args.push("--append-system-prompt", prompt);
  return args;
}

interface OpenReply {
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface CloseReply {
  /** true when pi's process was gone before the close had to force it */
  resolve: (exited: boolean) => void;
}

interface ModelReply {
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface SteerReply {
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface RequestResult {
  item?: QueueItem;
  error?: unknown;
}

/** an interrupt that arrived while a prompt was on its way to pi; the window owner answers it later */
interface HeldMessage {
  text: string;
  images?: PiImage[];
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface Deferred {
  model?: string;
  effort?: string;
}

/** how much of a type's instruction the retained history already holds */
export type InstructionKind = "full" | "short";

/** an instruction the conversation still owes pi: the type to establish and how much to say */
export interface TypeInstruction {
  type: string;
  kind: InstructionKind;
}

/** the type instructions the currently retained context holds, in order */
export interface TypeHistory {
  /** the type of the last instruction in the retained context; null when it holds none */
  lastType: string | null;
  /** every type that already has a full instruction in the retained context */
  full: string[];
}

/** one waiter on a type door: answered when its instruction lands, or refused when it cannot */
interface TypeReply {
  resolve: (delivered: boolean) => void;
  reject: (err: unknown) => void;
}

interface SwitchState {
  want: Deferred;
  awaiting: "model" | "effort";
  waiters: ModelReply[];
  /** a send or steer landed while the switch was in flight: the queue runs once it settles */
  asked: boolean;
}

/** the one value that says where a conversation is; every attached value rides inside it */
export type ConversationPhase = "closed" | "opening" | "idle" | "sending" | "running" | "stopping" | "delivering" | "closing";

/** the phases a transition must cover; the completeness test walks this list */
export const CONVERSATION_PHASES: readonly ConversationPhase[] = Object.freeze([
  "closed", "opening", "idle", "sending", "running", "stopping", "delivering", "closing",
]);

type ConversationState =
  | { phase: "closed" }
  | { phase: "opening"; asked: boolean; waiters: OpenReply[] }
  | { phase: "idle"; switching: SwitchState | null }
  | { phase: "sending"; item: QueueItem; held: HeldMessage[]; awaiting: "model" | "effort" | "prompt"; deferredBefore: Deferred; pendingRunEnd: { stopReason: string | null } | null }
  | { phase: "running"; switching: SwitchState | null }
  | { phase: "stopping"; item: QueueItem | null; held: HeldMessage[]; awaiting: "model" | "effort" | "prompt" | null; abortSent: boolean; deferredBefore: Deferred; pendingRunEnd: { stopReason: string | null } | null }
  | { phase: "delivering"; instruction: TypeInstruction; waiters: TypeReply[] }
  | { phase: "closing"; graceMs: number; forced: boolean; pendingOpen: boolean; openWaiters: OpenReply[]; closeWaiters: CloseReply[] };

/** the mail a conversation processes: the callers' requests and pi's reports, in arrival order */
export type ConversationMailEvent =
  | { type: "open"; reply: OpenReply }
  | { type: "send"; text: string; model?: string; effort?: string; images?: PiImage[]; result: RequestResult }
  | { type: "steer"; text: string; images?: PiImage[]; reply: SteerReply }
  | { type: "stop"; reply: { resolve: (r: { stopped: boolean }) => void; reject: (err: unknown) => void } }
  | { type: "model"; model: string | null; effort: string | null; reply: ModelReply }
  | { type: "edit"; id: string; patch: QueueItemPatch; result: RequestResult }
  | { type: "cancel"; id: string; result: RequestResult }
  | { type: "close"; graceMs: number; reply: CloseReply }
  | { type: "spawned"; generation: number }
  | { type: "spawnFailed"; generation: number; error?: string }
  | { type: "promptSettled"; generation: number; itemId: string; disposition: "started" | "queued" | "handled" | "failed"; error?: string }
  | { type: "modelSettled"; generation: number; step: "model" | "effort"; ok: boolean; error?: string }
  | { type: "runStarted"; generation: number }
  | { type: "runEnded"; generation: number; stopReason: string | null }
  | { type: "exited"; generation: number; error?: string }
  | { type: "hardKill"; generation: number }
  | { type: "typeRequest"; wantType: string; reply: TypeReply }
  | { type: "historyRead"; generation: number; lastType: string | null; full: string[] }
  | { type: "compactionEnded"; generation: number };

/** the event names a transition must cover; the completeness test walks this list */
export const CONVERSATION_EVENT_TYPES: readonly ConversationMailEvent["type"][] = Object.freeze([
  "open", "send", "steer", "stop", "model", "edit", "cancel", "close",
  "spawned", "spawnFailed", "promptSettled", "modelSettled", "runStarted", "runEnded", "exited", "hardKill",
  "typeRequest", "historyRead", "compactionEnded",
]);

/** what the transition asks the conversation's process layer to do; the results come back as mail */
export type ConversationDirective =
  | { kind: "spawn"; generation: number }
  | { kind: "prompt"; generation: number; item: QueueItem }
  | { kind: "typePrompt"; generation: number; instruction: TypeInstruction }
  | { kind: "steer"; generation: number; text: string; images?: PiImage[]; reply: SteerReply }
  | { kind: "abort"; generation: number }
  | { kind: "setModel"; generation: number; model: string }
  | { kind: "setEffort"; generation: number; effort: string }
  | { kind: "kill"; generation: number; graceMs: number; hard?: boolean }
  | { kind: "retire" }
  | { kind: "emit"; eventType: ConversationEventType; fields: Record<string, unknown> };

/** the conversation's whole memory: the state value, the not-yet-passed queue and the pi generation */
export interface ConversationMachine {
  state: ConversationState;
  deferred: Deferred;
  queue: QueueItem[];
  itemSeq: number;
  generation: number;
  /** the type this conversation is on; null for a mode without types */
  wantType: string | null;
  /** what the retained context holds, known once the history is read; null before that */
  history: TypeHistory | null;
  /** an instruction that is not yet in pi's history */
  instruction: TypeInstruction | null;
  /** a queue left by a stop, a failure or a lost pi: it runs again only when a person speaks */
  paused: boolean;
}

export function emptyConversationMachine(): ConversationMachine {
  return { state: { phase: "closed" }, deferred: {}, queue: [], itemSeq: 0, generation: 0, wantType: null, history: null, instruction: null, paused: false };
}

function cloneState(state: ConversationState): ConversationState {
  switch (state.phase) {
    case "closed":
      return state;
    case "running":
      return {
        phase: "running",
        switching: state.switching
          ? { ...state.switching, want: { ...state.switching.want }, waiters: [...state.switching.waiters] }
          : null,
      };
    case "opening":
      return { ...state, waiters: [...state.waiters] };
    case "idle":
      return {
        phase: "idle",
        switching: state.switching
          ? { ...state.switching, want: { ...state.switching.want }, waiters: [...state.switching.waiters] }
          : null,
      };
    case "sending":
      return { ...state, item: { ...state.item }, held: [...state.held], deferredBefore: { ...state.deferredBefore }, pendingRunEnd: state.pendingRunEnd ? { ...state.pendingRunEnd } : null };
    case "stopping":
      return { ...state, held: [...state.held], deferredBefore: { ...state.deferredBefore }, pendingRunEnd: state.pendingRunEnd ? { ...state.pendingRunEnd } : null };
    case "delivering":
      return { phase: "delivering", instruction: { ...state.instruction }, waiters: [...state.waiters] };
    case "closing":
      return { ...state, openWaiters: [...state.openWaiters], closeWaiters: [...state.closeWaiters] };
  }
}

/** the item pi has been handed but has not answered for yet; it is shown in the queue until the answer */
function inFlightItem(state: ConversationState): QueueItem | null {
  if (state.phase === "sending") return state.item;
  if (state.phase === "stopping" && !state.abortSent) return state.item;
  return null;
}

/** the queue a reader sees, the item whose prompt answer is pending riding at the head */
export function queueSnapshot(machine: ConversationMachine): QueueItem[] {
  const inFlight = inFlightItem(machine.state);
  const out = inFlight ? [{ ...inFlight }] : [];
  for (const item of machine.queue) out.push({ ...item });
  return out;
}

/** the visible queue as one value, so a transition can tell whether a reader would see a change */
function queueKey(items: QueueItem[]): string {
  return JSON.stringify(items.map((item) => [item.id, item.text, item.model ?? "", item.effort ?? ""]));
}

/**
 * The items a promotion drops: the items not yet written to pi. The state value alone decides, so the
 * matching can read it without pi running. An item still waiting for its model or effort switch has not
 * been written, so it belongs here.
 */
export function droppedQueue(machine: ConversationMachine): QueueItem[] {
  const state = machine.state;
  const head: QueueItem[] = [];
  if (state.phase === "sending" && (state.awaiting === "model" || state.awaiting === "effort")) head.push({ ...state.item });
  if (state.phase === "stopping" && (state.awaiting === "model" || state.awaiting === "effort") && state.item) head.push({ ...state.item });
  return [...head, ...machine.queue.map((item) => ({ ...item }))];
}

/**
 * The one transition. It reads the state and the event and returns the next state and the instructions to the
 * process layer; it never waits, so two callers can never interleave their reads and writes. A report from an
 * older pi is dropped by its generation.
 */
export function reduceConversation(machine: ConversationMachine, event: ConversationMailEvent): { machine: ConversationMachine; directives: ConversationDirective[] } {
  const m: ConversationMachine = {
    state: cloneState(machine.state),
    deferred: { ...machine.deferred },
    queue: [...machine.queue],
    itemSeq: machine.itemSeq,
    generation: machine.generation,
    wantType: machine.wantType,
    history: machine.history ? { lastType: machine.history.lastType, full: [...machine.history.full] } : null,
    instruction: machine.instruction ? { ...machine.instruction } : null,
    paused: machine.paused,
  };
  const dirs: ConversationDirective[] = [];
  const visibleBefore = queueKey(queueSnapshot(machine));

  const emit = (eventType: ConversationEventType, fields: Record<string, unknown> = {}): void => {
    dirs.push({ kind: "emit", eventType, fields });
  };
  const errorEvent = (message: string, extra: Record<string, unknown> = {}): void => {
    emit("error", { message, ...extra });
  };
  const queueEvent = (): void => {
    emit("queue", { queue: queueSnapshot(m) });
  };
  const newItem = (text: string, model?: string, effort?: string, images?: PiImage[]): QueueItem => {
    m.itemSeq += 1;
    return {
      id: `q${m.itemSeq}`,
      text,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(images?.length ? { images: images.map((image) => ({ ...image })) } : {}),
    };
  };
  const issuePrompt = (item: QueueItem): void => {
    const status = m.state;
    if (status.phase === "sending" || status.phase === "stopping") {
      // the item is the session's values now: the deferred values it met are spent, a later change stays
      if (m.deferred.model === status.deferredBefore.model) delete m.deferred.model;
      if (m.deferred.effort === status.deferredBefore.effort) delete m.deferred.effort;
    }
    dirs.push({ kind: "prompt", generation: m.generation, item: { ...item } });
  };
  const beginSend = (item: QueueItem): void => {
    const deferredBefore = { ...m.deferred };
    const model = item.model ?? deferredBefore.model;
    const effort = item.effort ?? deferredBefore.effort;
    if (model) {
      m.state = { phase: "sending", item: { ...item }, held: [], awaiting: "model", deferredBefore, pendingRunEnd: null };
      dirs.push({ kind: "setModel", generation: m.generation, model });
    } else if (effort) {
      m.state = { phase: "sending", item: { ...item }, held: [], awaiting: "effort", deferredBefore, pendingRunEnd: null };
      dirs.push({ kind: "setEffort", generation: m.generation, effort });
    } else {
      m.state = { phase: "sending", item: { ...item }, held: [], awaiting: "prompt", deferredBefore, pendingRunEnd: null };
      issuePrompt(item);
    }
  };
  /** the instruction the retained history is missing, or null when the wanted instruction is already there */
  const computeInstruction = (): TypeInstruction | null => {
    const want = m.wantType;
    if (!want || m.history === null) return null;
    if (m.history.lastType === want) return null;
    return m.history.full.includes(want) ? { type: want, kind: "short" } : { type: want, kind: "full" };
  };
  /** hand a pending type instruction to pi; it travels the prompt window but not the user's queue */
  const deliverInstruction = (reply?: TypeReply): void => {
    const instruction = m.instruction;
    if (!instruction) return;
    m.instruction = null;
    m.state = { phase: "delivering", instruction: { ...instruction }, waiters: reply ? [reply] : [] };
    dirs.push({ kind: "typePrompt", generation: m.generation, instruction: { ...instruction } });
  };
  /** hand the queue's head to pi; the only place a new prompt leaves. A queue stopped by a stop, a
   * failure or a lost pi waits for a person to speak again; a type instruction is not a queue item and
   * still goes out. */
  const advance = (): void => {
    // a model switch in flight owns pi until it settles: the queue waits for its answer
    if (m.state.phase !== "idle" || m.state.switching !== null) return;
    // a type-bearing conversation must not hand a prompt over before its own instruction is in history
    if (m.wantType !== null && m.history === null) return;
    if (m.instruction) { deliverInstruction(); return; }
    if (m.paused) return;
    if (!m.queue.length) return;
    const item = m.queue.shift() as QueueItem;
    beginSend(item);
    queueEvent();
  };
  const appendHeldList = (held: HeldMessage[]): void => {
    if (!held.length) return;
    for (const message of held.splice(0)) {
      m.queue.push(newItem(message.text, undefined, undefined, message.images));
      message.resolve();
    }
    queueEvent();
  };
  const steerHeldList = (held: HeldMessage[]): void => {
    for (const message of held.splice(0)) {
      dirs.push({ kind: "steer", generation: m.generation, text: message.text, images: message.images, reply: { resolve: message.resolve, reject: message.reject } });
    }
  };
  /** the send or model switch was refused: the item goes back to the head, the queue does not run */
  const refuseItem = (message: string, itemId?: string): void => {
    const status = m.state;
    const item = status.phase === "sending" || status.phase === "stopping" ? status.item : null;
    const held = status.phase === "sending" || status.phase === "stopping" ? status.held : [];
    if (item) m.queue.unshift({ ...item });
    appendHeldList(held);
    errorEvent(message, itemId ? { itemId } : {});
    m.state = { phase: "idle", switching: null };
    m.paused = true;
    queueEvent();
  };
  /**
   * A run ended with nobody waiting to stop it: the reason pi reported decides completion, stop or failure.
   * A switch still in flight keeps its waiters and owns the queue until it answers; a natural end then asks
   * the settled switch to start the queue.
   */
  const finishRun = (stopReason: string | null, switching: SwitchState | null = null): void => {
    const natural = stopReason === "stop" || stopReason === "length";
    const reason = natural ? "completed" : stopReason === "aborted" ? "stopped" : "failed";
    if (!natural) m.paused = true;
    if (switching) {
      if (natural) switching.asked = true;
      m.state = { phase: "idle", switching };
      emit("end", { reason });
      return;
    }
    m.state = { phase: "idle", switching: null };
    emit("end", { reason });
    if (natural) advance();
  };

  const status = m.state;
  switch (event.type) {
    case "open": {
      if (status.phase === "closed") {
        m.generation += 1;
        m.state = { phase: "opening", asked: false, waiters: [event.reply] };
        dirs.push({ kind: "spawn", generation: m.generation });
      } else if (status.phase === "opening") {
        status.waiters.push(event.reply);
      } else if (status.phase === "closing") {
        status.pendingOpen = true;
        status.openWaiters.push(event.reply);
      } else {
        event.reply.resolve();
      }
      break;
    }
    case "send": {
      if (status.phase === "closing") {
        event.result.error = new ConversationRefused("会話は閉じられています", 410);
        break;
      }
      // a person spoke: a queue a stop or a failure had stopped runs again
      m.paused = false;
      const item = newItem(event.text, event.model, event.effort, event.images);
      event.result.item = { ...item };
      m.queue.push(item);
      if (status.phase === "closed") {
        m.generation += 1;
        m.state = { phase: "opening", asked: true, waiters: [] };
        dirs.push({ kind: "spawn", generation: m.generation });
      } else if (status.phase === "opening") {
        status.asked = true;
      } else if (status.phase === "idle") {
        // a switch in flight: park the item and let its answer start the queue
        if (status.switching) status.switching.asked = true;
        else advance();
      }
      queueEvent();
      break;
    }
    case "steer": {
      if (status.phase === "closing") {
        event.reply.reject(new ConversationRefused("会話は閉じられています", 410));
        break;
      }
      // an interrupt must never overtake a type instruction that is still owed to pi: it joins the queue
      if (m.instruction !== null || status.phase === "delivering") {
        const queued = newItem(event.text, undefined, undefined, event.images);
        m.queue.push(queued);
        m.paused = false;
        if (status.phase === "closed") {
          m.generation += 1;
          m.state = { phase: "opening", asked: true, waiters: [] };
          dirs.push({ kind: "spawn", generation: m.generation });
        } else if (status.phase === "opening") {
          status.asked = true;
        }
        queueEvent();
        event.reply.resolve();
        break;
      }
      if (status.phase === "running") {
        dirs.push({ kind: "steer", generation: m.generation, text: event.text, images: event.images, reply: event.reply });
        break;
      }
      if (status.phase === "sending" || status.phase === "stopping") {
        status.held.push({ text: event.text, images: event.images, resolve: event.reply.resolve, reject: event.reply.reject });
        break;
      }
      // nothing is running: an interrupt is a send
      const item = newItem(event.text, undefined, undefined, event.images);
      m.queue.push(item);
      m.paused = false;
      if (status.phase === "closed") {
        m.generation += 1;
        m.state = { phase: "opening", asked: true, waiters: [] };
        dirs.push({ kind: "spawn", generation: m.generation });
      } else if (status.phase === "opening") {
        status.asked = true;
      } else if (status.phase === "idle") {
        // a switch in flight: park the item and let its answer start the queue
        if (status.switching) status.switching.asked = true;
        else advance();
      }
      queueEvent();
      event.reply.resolve();
      break;
    }
    case "stop": {
      if (status.phase === "closing") {
        event.reply.reject(new ConversationRefused("会話は閉じられています", 410));
        break;
      }
      if (status.phase === "running") {
        if (status.switching) {
          for (const waiter of status.switching.waiters) waiter.reject(new ConversationRefused("停止のため model の切替を中断しました", 409));
        }
        m.state = { phase: "stopping", item: null, held: [], awaiting: null, abortSent: true, deferredBefore: {}, pendingRunEnd: null };
        dirs.push({ kind: "abort", generation: m.generation });
        event.reply.resolve({ stopped: true });
        break;
      }
      if (status.phase === "sending") {
        // the item's model or effort is still on its way: it has not been written to pi, so it goes back to
        // the queue and never becomes a prompt. The interrupts it met join the tail and wait there.
        if (status.awaiting === "model" || status.awaiting === "effort") {
          m.queue.unshift({ ...status.item });
          appendHeldList(status.held);
          m.state = { phase: "idle", switching: null };
          m.paused = true;
          event.reply.resolve({ stopped: true });
          break;
        }
        // the prompt is already with pi: wait for its answer, then abort
        m.state = { phase: "stopping", item: status.item, held: status.held, awaiting: status.awaiting, abortSent: false, deferredBefore: status.deferredBefore, pendingRunEnd: status.pendingRunEnd };
        event.reply.resolve({ stopped: true });
        break;
      }
      if (status.phase === "stopping") {
        event.reply.resolve({ stopped: true });
        break;
      }
      if (status.phase === "idle" && status.switching) {
        // the change the person asked for is still on its way; its answer comes, but the parked queue waits
        status.switching.asked = false;
        m.paused = true;
        event.reply.resolve({ stopped: true });
        break;
      }
      event.reply.resolve({ stopped: false });
      break;
    }
    case "model": {
      if (status.phase === "closing") {
        event.reply.reject(new ConversationRefused("会話は閉じられています", 410));
        break;
      }
      const want: Deferred = {};
      if (event.model) want.model = event.model;
      if (event.effort) want.effort = event.effort;
      if (status.phase === "idle" && status.switching === null && (want.model || want.effort)) {
        const awaiting: "model" | "effort" = want.model ? "model" : "effort";
        m.state = { phase: "idle", switching: { want, awaiting, waiters: [event.reply], asked: false } };
        if (want.model) dirs.push({ kind: "setModel", generation: m.generation, model: want.model });
        else dirs.push({ kind: "setEffort", generation: m.generation, effort: want.effort as string });
        break;
      }
      // every other state holds the value for the next prompt
      if (want.model) m.deferred.model = want.model;
      if (want.effort) m.deferred.effort = want.effort;
      event.reply.resolve();
      break;
    }
    case "edit": {
      if (status.phase === "closing") {
        event.result.error = new ConversationRefused("会話は閉じられています", 410);
        break;
      }
      const inFlight = inFlightItem(status);
      const item = m.queue.find((entry) => entry.id === event.id);
      if (!item) {
        event.result.error = inFlight?.id === event.id
          ? new ConversationRefused(`送信中の項目は編集できません: ${event.id}`, 409)
          : new ConversationRefused(`キューの項目がありません: ${event.id}`, 404);
        break;
      }
      if (typeof event.patch.text === "string" && event.patch.text.trim()) item.text = event.patch.text;
      if (event.patch.model === null) delete item.model;
      else if (typeof event.patch.model === "string" && event.patch.model) item.model = event.patch.model;
      if (event.patch.effort === null) delete item.effort;
      else if (typeof event.patch.effort === "string" && event.patch.effort) item.effort = event.patch.effort;
      if (event.patch.images === null) delete item.images;
      else if (Array.isArray(event.patch.images)) item.images = event.patch.images.map((image) => ({ ...image }));
      event.result.item = { ...item };
      queueEvent();
      break;
    }
    case "cancel": {
      if (status.phase === "closing") {
        event.result.error = new ConversationRefused("会話は閉じられています", 410);
        break;
      }
      const at = m.queue.findIndex((entry) => entry.id === event.id);
      if (at < 0) {
        event.result.error = inFlightItem(status)?.id === event.id
          ? new ConversationRefused(`送信中の項目は取り消せません: ${event.id}`, 409)
          : new ConversationRefused(`キューの項目がありません: ${event.id}`, 404);
        break;
      }
      const [item] = m.queue.splice(at, 1);
      event.result.item = { ...item };
      queueEvent();
      break;
    }
    case "close": {
      if (status.phase === "closed") {
        event.reply.resolve(true);
        dirs.push({ kind: "retire" });
        break;
      }
      if (status.phase === "closing") {
        status.closeWaiters.push(event.reply);
        break;
      }
      const openWaiters: OpenReply[] = status.phase === "opening" ? [...status.waiters] : [];
      if (status.phase === "sending" || status.phase === "stopping") {
        for (const message of status.held) message.reject(new ConversationRefused("会話は閉じられています", 410));
      }
      if ((status.phase === "idle" || status.phase === "running") && status.switching) {
        for (const waiter of status.switching.waiters) waiter.reject(new ConversationRefused("会話は閉じられています", 410));
      }
      if (status.phase === "delivering") {
        for (const waiter of status.waiters) waiter.reject(new ConversationRefused("会話は閉じられています", 410));
      }
      m.state = { phase: "closing", graceMs: event.graceMs, forced: false, pendingOpen: false, openWaiters, closeWaiters: [event.reply] };
      dirs.push({ kind: "kill", generation: m.generation, graceMs: event.graceMs });
      break;
    }
    case "spawned": {
      if (status.phase !== "opening" || event.generation !== m.generation) break;
      const waiters = status.waiters;
      const asked = status.asked;
      m.state = { phase: "idle", switching: null };
      if (asked) advance();
      // a reopened or freshly made type-bearing conversation adds its missing instruction now
      else if (m.instruction && !m.queue.length) advance();
      for (const waiter of waiters) waiter.resolve();
      break;
    }
    case "spawnFailed": {
      if (status.phase !== "opening" || event.generation !== m.generation) break;
      const waiters = status.waiters;
      const message = event.error ?? "unknown";
      m.state = { phase: "closed" };
      errorEvent(`pi を起こせません: ${message}`);
      for (const waiter of waiters) waiter.reject(new ConversationRefused(`pi を起こせません: ${message}`, 500));
      break;
    }
    case "promptSettled": {
      if (event.generation !== m.generation) break;
      if (status.phase === "sending") {
        if (event.disposition === "started" || event.disposition === "queued") {
          m.state = { phase: "running", switching: null };
          queueEvent();
          if (status.pendingRunEnd) {
            // pi reported the run's end before it answered for the prompt (they shared one chunk):
            // the run is already over, so the interrupts it met join the queue rather than a steer
            appendHeldList(status.held);
            finishRun(status.pendingRunEnd.stopReason);
          } else {
            steerHeldList(status.held);
          }
        } else if (event.disposition === "handled") {
          const held = status.held;
          m.state = { phase: "idle", switching: null };
          appendHeldList(held);
          advance();
        } else {
          refuseItem(event.error ?? "prompt が失敗しました", event.itemId);
        }
        break;
      }
      if (status.phase === "delivering") {
        const instruction = status.instruction;
        if (event.disposition === "handled") {
          // the instruction is the retained context's last one from here on
          const prior = m.history ?? { lastType: null, full: [] };
          const full = instruction.kind === "full" ? [...prior.full.filter((t) => t !== instruction.type), instruction.type] : [...prior.full];
          m.history = { lastType: instruction.type, full };
          m.state = { phase: "idle", switching: null };
          for (const waiter of status.waiters) waiter.resolve(true);
          advance();
        } else {
          // the instruction did not land: keep it owed and leave the queue at its head
          m.instruction = instruction;
          m.state = { phase: "idle", switching: null };
          const message = event.error ?? "型の指示を渡せませんでした";
          errorEvent(message);
          for (const waiter of status.waiters) waiter.reject(new ConversationRefused(message, 503));
        }
        break;
      }
      if (status.phase === "stopping") {
        if (event.disposition === "started" || event.disposition === "queued") {
          const remembered = status.pendingRunEnd;
          status.abortSent = true;
          status.awaiting = null;
          status.item = null;
          if (remembered) {
            // the run the person stopped had already ended before pi answered: no abort, end as stopped
            const held = status.held;
            m.state = { phase: "idle", switching: null };
            m.paused = true;
            appendHeldList(held);
            emit("end", { reason: "stopped" });
          } else {
            dirs.push({ kind: "abort", generation: m.generation });
            appendHeldList(status.held);
            queueEvent();
          }
        } else if (event.disposition === "handled") {
          const held = status.held;
          m.state = { phase: "idle", switching: null };
          m.paused = true;
          appendHeldList(held);
        } else {
          refuseItem(event.error ?? "prompt が失敗しました", event.itemId);
        }
        break;
      }
      break;
    }
    case "modelSettled": {
      if (event.generation !== m.generation) break;
      if ((status.phase === "idle" || status.phase === "running") && status.switching && status.switching.awaiting === event.step) {
        const switching = status.switching;
        if (!event.ok) {
          const message = event.error ?? "model の切替が失敗しました";
          status.switching = null;
          errorEvent(message);
          for (const waiter of switching.waiters) waiter.reject(new ConversationRefused(message, 400));
          // a send that arrived while the switch was out parked its item: the failed switch must still move it
          if (status.phase === "idle" && switching.asked) advance();
          break;
        }
        if (event.step === "model" && switching.want.effort) {
          switching.awaiting = "effort";
          dirs.push({ kind: "setEffort", generation: m.generation, effort: switching.want.effort });
          break;
        }
        status.switching = null;
        if (status.phase === "idle" && switching.asked) advance();
        for (const waiter of switching.waiters) waiter.resolve();
        break;
      }
      if (status.phase === "stopping" && status.awaiting === event.step && (status.awaiting === "model" || status.awaiting === "effort")) {
        // the item was never written to pi: it goes back to the queue and the conversation waits
        if (status.item) m.queue.unshift({ ...status.item });
        appendHeldList(status.held);
        m.state = { phase: "idle", switching: null };
        m.paused = true;
        break;
      }
      if (status.phase === "sending" && status.awaiting === event.step) {
        if (!event.ok) {
          refuseItem(event.error ?? "model の切替が失敗しました");
          break;
        }
        const nextEffort = status.item?.effort ?? status.deferredBefore.effort;
        if (event.step === "model" && nextEffort) {
          status.awaiting = "effort";
          dirs.push({ kind: "setEffort", generation: m.generation, effort: nextEffort });
          break;
        }
        status.awaiting = "prompt";
        if (status.item) issuePrompt(status.item);
        break;
      }
      break;
    }
    case "runStarted": {
      if (event.generation !== m.generation) break;
      // a run nobody asked for (an extension started it): do not stack the next item on it. A model
      // switch still in flight keeps its waiters, so its answer still owns the door and the queue
      if (status.phase === "idle") m.state = { phase: "running", switching: status.switching };
      break;
    }
    case "runEnded": {
      if (event.generation !== m.generation) break;
      if (status.phase === "sending") {
        // pi can report the run's end before its answer for the prompt lands (one chunk): remember it,
        // and let the prompt's answer end the run instead of leaving the conversation Running
        if (status.awaiting === "prompt") status.pendingRunEnd = { stopReason: event.stopReason };
        break;
      }
      if (status.phase === "stopping") {
        // a run we asked to stop counts as stopped whatever pi reported; an abort that pi never
        // answered here means no promptSettled will come, so the interrupts held for it must drain now
        const held = status.held;
        // an item already handed to pi is spent: returning it to the queue would send it a second time
        const item = status.awaiting === "prompt" ? null : status.item;
        m.state = { phase: "idle", switching: null };
        m.paused = true;
        if (item) m.queue.unshift({ ...item });
        if (held.length) appendHeldList(held);
        else if (item) queueEvent();
        emit("end", { reason: "stopped" });
        break;
      }
      if (status.phase === "running") {
        finishRun(event.stopReason, status.switching);
        break;
      }
      break;
    }
    case "exited": {
      if (event.generation !== m.generation) break;
      const message = event.error ?? "pi の process が終わりました";
      switch (status.phase) {
        case "closed":
          break;
        case "opening":
          m.state = { phase: "closed" };
          errorEvent(`pi を起こせません: ${message}`);
          for (const waiter of status.waiters) waiter.reject(new ConversationRefused(`pi を起こせません: ${message}`, 500));
          break;
        case "idle":
          if (status.switching) for (const waiter of status.switching.waiters) waiter.reject(new ConversationRefused(message, 503));
          m.state = { phase: "closed" };
          errorEvent(message);
          break;
        case "sending":
          m.queue.unshift({ ...status.item });
          appendHeldList(status.held);
          m.state = { phase: "closed" };
          m.paused = true;
          errorEvent(message);
          queueEvent();
          break;
        case "running":
          if (status.switching) for (const waiter of status.switching.waiters) waiter.reject(new ConversationRefused(message, 503));
          m.state = { phase: "closed" };
          m.paused = true;
          errorEvent(message);
          emit("end", { reason: "failed" });
          break;
        case "delivering":
          // the instruction was on its way to pi; keep it owed for whatever opens next
          m.instruction = { ...status.instruction };
          m.state = { phase: "closed" };
          errorEvent(message);
          for (const waiter of status.waiters) waiter.reject(new ConversationRefused(message, 503));
          break;
        case "stopping":
          if (status.item) m.queue.unshift({ ...status.item });
          appendHeldList(status.held);
          if (status.abortSent) emit("end", { reason: "stopped" });
          m.state = { phase: "closed" };
          m.paused = true;
          errorEvent(message);
          queueEvent();
          break;
        case "closing":
          for (const waiter of status.closeWaiters) waiter.resolve(!status.forced);
          if (status.pendingOpen) {
            m.generation += 1;
            // a reopened pi runs what the person asks from here on; the queue it kept waits for a send
            m.state = { phase: "opening", asked: false, waiters: status.openWaiters };
            dirs.push({ kind: "spawn", generation: m.generation });
          } else {
            for (const waiter of status.openWaiters) waiter.reject(new ConversationRefused("会話は閉じられています", 410));
            m.queue = [];
            m.state = { phase: "closed" };
            dirs.push({ kind: "retire" });
          }
          break;
      }
      break;
    }
    case "hardKill": {
      if (status.phase !== "closing" || event.generation !== m.generation || status.forced) break;
      status.forced = true;
      dirs.push({ kind: "kill", generation: m.generation, graceMs: status.graceMs, hard: true });
      break;
    }
    case "typeRequest": {
      if (status.phase === "closing") {
        event.reply.reject(new ConversationRefused("会話は閉じられています", 410));
        break;
      }
      m.wantType = event.wantType;
      if (m.history !== null) m.instruction = computeInstruction();
      if (!m.instruction) {
        // the retained history already holds the wanted instruction
        event.reply.resolve(true);
        break;
      }
      // idle with an empty queue takes the instruction now; anything else owes it to the next prompt
      if (status.phase === "idle" && status.switching === null && !m.queue.length && m.history !== null) {
        deliverInstruction(event.reply);
        break;
      }
      event.reply.resolve(false);
      break;
    }
    case "historyRead": {
      if (event.generation !== m.generation) break;
      m.history = { lastType: event.lastType, full: [...event.full] };
      // a delivery already in flight answers for itself; recomputing here would double-add its instruction
      if (m.state.phase !== "delivering" && m.wantType !== null) m.instruction = computeInstruction();
      if (m.state.phase === "idle" && m.state.switching === null && m.wantType !== null) advance();
      break;
    }
    case "compactionEnded": {
      if (event.generation !== m.generation) break;
      // the retained range changed: the instruction may have been summarized away
      m.history = null;
      if (m.state.phase !== "delivering") m.instruction = null;
      break;
    }
    default: {
      const unreachable: never = event;
      void unreachable;
      break;
    }
  }
  // a transition that changes what a reader sees always tells that reader, however it changed it
  const visibleAfter = queueSnapshot(m);
  if (visibleBefore !== queueKey(visibleAfter)) dirs.push({ kind: "emit", eventType: "queue", fields: { queue: visibleAfter } });
  return { machine: m, directives: dirs };
}

/**
 * One open conversation: pi's child process, the engine's queue, and the numbered event stream. The queue
 * and the events live in memory only; the history is pi's own session record.
 *
 * Every change of where the conversation is goes through `reduceConversation`; the process layer only
 * carries out the returned directives and feeds their results back as mail.
 */
// ---- reading pi's record for the type instruction and the document rule ----

interface RawEntry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  customType?: unknown;
  details?: unknown;
  firstKeptEntryId?: unknown;
  message?: { role?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
  [key: string]: unknown;
}

/** the entry ids from the leaf up to the root; an id the record does not hold stops the walk */
function branchOf(entries: unknown[], leafId: string | null): { onBranch: Set<string>; parentOf: Map<string, string | null> } {
  const parentOf = new Map<string, string | null>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as RawEntry;
    if (typeof entry.id === "string") parentOf.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
  }
  const onBranch = new Set<string>();
  let current = leafId;
  while (current && !onBranch.has(current)) {
    onBranch.add(current);
    current = parentOf.get(current) ?? null;
  }
  return { onBranch, parentOf };
}

/**
 * The type instructions the retained context holds. The branch is walked from pi's leaf through parent ids, and
 * the range is what pi keeps after its last compaction, so an instruction the compaction summarized away counts
 * as missing. Reading pi's own rule here is what keeps the API's answer and the agent's context in step.
 */
export function typeHistoryFromEntries(entries: unknown[], leafId: string | null): TypeHistory {
  const { parentOf } = branchOf(entries, leafId);
  const byId = new Map<string, RawEntry>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as RawEntry;
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const path: RawEntry[] = [];
  const seen = new Set<string>();
  let current = leafId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    path.push(entry);
    current = parentOf.get(current) ?? null;
  }
  path.reverse();
  let retained: RawEntry[];
  let compactionIdx = -1;
  for (let i = 0; i < path.length; i += 1) if (path[i].type === "compaction") compactionIdx = i;
  if (compactionIdx < 0) {
    retained = path;
  } else {
    const compaction = path[compactionIdx];
    const firstKept = typeof compaction.firstKeptEntryId === "string" ? compaction.firstKeptEntryId : null;
    const kept: RawEntry[] = [];
    let found = firstKept === null;
    for (let i = 0; i < compactionIdx; i += 1) {
      if (path[i].id === firstKept) found = true;
      if (found && !(path[i].type === "message" && path[i].message?.role === "system")) kept.push(path[i]);
    }
    retained = [compaction, ...kept, ...path.slice(compactionIdx + 1)];
  }
  let lastType: string | null = null;
  const full: string[] = [];
  for (const entry of retained) {
    if (entry.type !== "custom_message" || entry.customType !== CONVERSATION_TYPE_CUSTOM_TYPE) continue;
    const details = entry.details as { type?: unknown; kind?: unknown } | undefined;
    if (!details || typeof details.type !== "string") continue;
    lastType = details.type;
    if (details.kind === "full" && !full.includes(details.type)) full.push(details.type);
  }
  return { lastType, full };
}

interface DocumentWrite { path: string }

/** the `write` / `edit` calls the branch made, newest last, with failed calls and off-branch calls dropped */
export function documentWritesOnBranch(entries: unknown[], leafId: string | null): DocumentWrite[] {
  const { onBranch } = branchOf(entries, leafId);
  const errors = new Map<string, boolean>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as RawEntry;
    if (entry.type !== "message" || typeof entry.id !== "string" || !onBranch.has(entry.id)) continue;
    const message = entry.message;
    if (!message || message.role !== "toolResult") continue;
    if (typeof message.toolCallId === "string") errors.set(message.toolCallId, message.isError === true);
  }
  const out: DocumentWrite[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as RawEntry;
    if (entry.type !== "message" || typeof entry.id !== "string" || !onBranch.has(entry.id)) continue;
    const message = entry.message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as unknown[]) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall" || (call.name !== "write" && call.name !== "edit")) continue;
      if (typeof call.id === "string" && errors.get(call.id) === true) continue;
      const args = call.arguments as { path?: unknown } | undefined;
      if (!args || typeof args.path !== "string" || !args.path.trim()) continue;
      out.push({ path: args.path });
    }
  }
  return out;
}

/** the document's frontmatter `status`, or null when the file has none or cannot be read */
export function documentStatus(path: string): string | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!front) return null;
  const line = /^status:\s*(.+?)\s*$/m.exec(front[1]);
  if (!line) return null;
  const value = line[1].replace(/^["']|["']$/g, "").trim();
  return value || null;
}

/**
 * The document the type points at: the last successful write directly under the type's own dir. A relative
 * path is resolved from the conversation's cwd, the template and the operations file are excluded, and a type
 * that wrote no `dir` has no document of its own.
 */
export function documentFromWrites(writes: DocumentWrite[], cwd: string, target: SessionType | undefined): ConversationDocument | undefined {
  if (!target?.hasDir) return undefined;
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    const raw = writes[i].path;
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (comparablePath(dirname(abs)) !== comparablePath(target.dir)) continue;
    if (!abs.toLowerCase().endsWith(".md")) continue;
    if (target.template && comparablePath(abs) === comparablePath(target.template)) continue;
    if (target.operations && comparablePath(abs) === comparablePath(target.operations)) continue;
    return { path: abs, status: documentStatus(abs) };
  }
  return undefined;
}

/** the document rule against a live `get_entries` answer, for the open door */
export function documentFromEntries(entries: unknown[], leafId: string | null, cwd: string, target: SessionType | undefined): ConversationDocument | undefined {
  return documentFromWrites(documentWritesOnBranch(entries, leafId), cwd, target);
}

/**
 * The document of a mode without types: its workspace itself is the idea's place, and the same last-write rule
 * applies straight under it. The norms the workspace keeps for every harness (`AGENTS.md`, `CLAUDE.md`) and the
 * working files (`_...`) are never the idea document.
 */
export function documentFromTypelessWrites(writes: DocumentWrite[], workspace: string): ConversationDocument | undefined {
  const root = comparablePath(workspace);
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    const raw = writes[i].path;
    const abs = isAbsolute(raw) ? raw : resolve(workspace, raw);
    if (comparablePath(dirname(abs)) !== root) continue;
    if (!abs.toLowerCase().endsWith(".md")) continue;
    const name = basename(abs);
    if (name === "AGENTS.md" || name === "CLAUDE.md" || name.startsWith("_")) continue;
    return { path: abs, status: documentStatus(abs) };
  }
  return undefined;
}

/** what the idea doors read: the conversation's document target, resolved without waking pi */
export interface IdeaDocumentTarget {
  sessionId: string;
  mode: SessionMode;
  workspace: string;
  cwd: string;
  /** the current type's name, when the mode has types */
  type?: string;
  /** the dir the document lives in; absent when the current type wrote no dir */
  dir?: string;
  /** whether the mode has no types: the workspace itself is the place */
  typeless: boolean;
}

/**
 * The document target a conversation's idea doors act on. A mode with types uses the type's dir, and a type that
 * wrote none has no document. A mode without types uses the workspace itself. Nothing here wakes pi: a document
 * door answers from the records on disk.
 */
export function ideaDocumentTarget(sessionId: string): IdeaDocumentTarget {
  if (!CONVERSATION_SESSION_ID.test(sessionId)) throw new ConversationRefused("session id の形が不正です", 400);
  if (isSupervisedPipelineSession(sessionId)) throw new ConversationRefused("engine の lane の session は会話の口から開けません", 409);
  const file = resolveSessionFile(sessionId);
  const mode = modeForSession(sessionId) ?? modeFromRecord(sessionId);
  if (!mode) throw new ConversationRefused("mode の session ではありません", 404);
  const cwd = conversationCwd(mode, sessionId, file);
  if (!mode.types) {
    return { sessionId, mode, workspace: mode.workspace, cwd, dir: mode.workspace, typeless: true };
  }
  const mark = readMarks(placeWorkspaceFor(sessionId, cwd, mode, safeModes())).sessions[sessionId] ?? {};
  const typeName = effectiveModeType(mode, mark.type);
  const target = typeName ? mode.types[typeName] : undefined;
  return {
    sessionId, mode, workspace: mode.workspace, cwd,
    ...(typeName ? { type: typeName } : {}),
    ...(target?.hasDir ? { dir: target.dir } : {}),
    typeless: false,
  };
}

/** the absolute document path the target points at, or undefined when the conversation has no document yet */
export async function ideaDocumentPath(target: IdeaDocumentTarget): Promise<string | undefined> {
  const file = resolveSessionFile(target.sessionId);
  if (!file) return undefined;
  const facts = await readFacts(file);
  if (!facts) return undefined;
  const cwd = facts.cwd ?? target.cwd;
  if (target.typeless) return documentFromTypelessWrites(facts.documentWrites, cwd)?.path;
  const type = target.type ? target.mode.types?.[target.type] : undefined;
  if (!type?.hasDir) return undefined;
  return documentFromWrites(facts.documentWrites, cwd, type)?.path;
}

export class Conversation {
  sessionId: string;
  readonly mode: SessionMode;
  readonly cwd: string;
  /** the cwd as a path under the mode's workspace (empty for the workspace itself) */
  readonly workdir: string;
  agentDir: string;
  role: RolePreset;
  /** which headless CLI this conversation runs: pi's rpc or Claude Code's stream-json */
  harness: "pi" | "claude";
  /** the config dir this conversation's Claude Code runs in; undefined for a pi conversation */
  claudeConfigDir: string | undefined;
  /** the pi tool allow-list this conversation runs with (a branch may differ from its role's list) */
  tools: string[];
  isNew: boolean;
  /** set when this conversation is an ephemeral branch (kept out of the conversation list) */
  readonly ephemeral?: EphemeralRecord;
  readonly log = new ConversationLog();
  readonly createdAt: Date;

  private machine: ConversationMachine = emptyConversationMachine();
  /** the child behind this conversation: a pi rpc process or a Claude Code stream-json process */
  private piProc: RpcChild | null = null;
  private piGeneration = 0;
  private mailbox: ConversationMailEvent[] = [];
  private pumping = false;
  private compacting = false;
  private lastStopReason: string | null = null;
  private runStartSeq: number | null = null;
  private currentModel?: string;
  private currentEffort?: string;
  /** the last `total_cost_usd` Claude Code reported, so a turn's own cost is the increase (C-163-1) */
  private claudeCostSeen = 0;
  /** the thinking levels the current model accepts; read back from pi, never assumed (DEC-118-3) */
  private availableEfforts?: string[];
  private lastActivity: number;
  private closeWatchers = new Set<() => void>();
  private removePromise: Promise<void> | null = null;
  /** the space set on a fresh conversation before its mark exists; a reopen reads the mark instead */
  private spaceOverride?: string;
  /** the type this conversation is on; null for a mode without types */
  wantType: string | null;
  /**
   * The features the running pi was started with. An ephemeral branch gets the skills its parent's cwd
   * resolves (DEC-2008) but never the web-search or MCP tool names, so those two stay false for it.
   */
  private startedFeatures: ConversationFeatures = { webSearch: false, mcp: false, skills: [] };
  /** one title generation at a time for this session, however it was started */
  private titleGenerating = false;
  /** set while an idea's exits run: the agent must not start on the same document, so talk is refused */
  private exitRun = false;

  constructor(opts: {
    sessionId: string;
    mode: SessionMode;
    plan: ModeStartPlan;
    isNew: boolean;
    createdAt?: Date;
    tools?: string[];
    ephemeral?: EphemeralRecord;
    workdir?: string;
    space?: string;
    /** the type a fresh conversation starts on; a reopen resolves the mark and the mode's default instead */
    type?: string;
  }) {
    this.sessionId = opts.sessionId;
    this.mode = opts.mode;
    this.cwd = opts.plan.cwd;
    this.workdir = opts.workdir ?? workdirOf(opts.mode.workspace, opts.plan.cwd);
    this.agentDir = opts.plan.agentDir;
    this.role = opts.plan.role;
    this.harness = opts.plan.role.harness;
    this.claudeConfigDir = this.harness === "claude" ? conversationClaudeConfigDir() : undefined;
    this.tools = opts.tools ?? opts.plan.toolNames;
    this.isNew = opts.isNew;
    this.ephemeral = opts.ephemeral;
    if (opts.ephemeral?.space) this.spaceOverride = opts.ephemeral.space;
    else if (opts.space !== undefined) this.spaceOverride = opts.space || undefined;
    this.createdAt = opts.createdAt ?? new Date();
    const marked = opts.ephemeral ? opts.ephemeral.type : this.sessionMark().type;
    // a consult carries no type instruction: the mode's default would tell it to work in the chat workspace and
    // read and write the chat memory, which is not where it is and not what it is for. A Claude conversation
    // carries none either: the instruction rides pi's extension, and stream-json has no port to add context
    // without a turn, so it could only arrive as a message a person did not write.
    this.wantType = opts.ephemeral?.consult || this.harness === "claude"
      ? null
      : opts.mode.types
        ? (opts.type && opts.mode.types[opts.type] ? opts.type : effectiveModeType(opts.mode, marked) ?? opts.mode.defaultType ?? null)
        : null;
    this.machine = { ...emptyConversationMachine(), wantType: this.wantType };
    this.currentModel = opts.isNew ? opts.plan.role.model : undefined;
    this.currentEffort = opts.isNew ? opts.plan.thinkingLevel : undefined;
    this.lastActivity = Date.now();
  }

  /** the space this conversation belongs to now: an ephemeral branch's own, else the workspace's mark */
  spaceId(): string | undefined {
    if (this.ephemeral) return this.ephemeral.consult ? undefined : this.ephemeral.space;
    return this.spaceOverride ?? this.sessionMark().space;
  }

  /** this session's marks, read from the one workspace the place rule decides for it */
  private sessionMark(): SessionMark {
    return readMarks(placeWorkspaceFor(this.sessionId, this.cwd, this.mode, safeModes())).sessions[this.sessionId] ?? {};
  }

  /** the workspace whose spaces dir this conversation's space id was minted in */
  private spaceContextWorkspace(): string {
    if (this.ephemeral) return this.ephemeral.spaceWorkspace ?? this.mode.workspace;
    return placeWorkspaceFor(this.sessionId, this.cwd, this.mode, safeModes());
  }

  /**
   * The space handed to the constructor is now the session's own mark: drop the in-memory copy, so a later
   * change through the marks door (another space, or none) is what the next pi start and branch use.
   */
  acceptSpaceMark(): void {
    this.spaceOverride = undefined;
  }

  get phase(): ConversationPhase {
    return this.machine.state.phase;
  }

  /** whether this conversation is on its way out of the ledger; a crashed pi is not "closed" here */
  get isClosed(): boolean {
    return this.machine.state.phase === "closing";
  }

  get isEphemeral(): boolean {
    return this.ephemeral !== undefined;
  }

  /** a run is going, or it started before a stop was asked for */
  get isStreaming(): boolean {
    const state = this.machine.state;
    return state.phase === "running" || (state.phase === "stopping" && state.abortSent);
  }

  /** a prompt is on its way to pi, or a stop is waiting for the run it started */
  get isPromptPending(): boolean {
    const state = this.machine.state;
    return state.phase === "sending" || (state.phase === "stopping" && !state.abortSent);
  }

  get isCompacting(): boolean {
    return this.compacting;
  }

  /**
   * Whether the engine may write the idea document now: only while the conversation is stopped (no prompt on its
   * way, no run, no stop waiting, no type delivery). `isStreaming` is narrower: it is false while a prompt is
   * being handed to pi, which is exactly when the agent begins writing the same document.
   */
  get canWriteDocument(): boolean {
    const phase = this.machine.state.phase;
    return phase === "idle" || phase === "closed";
  }

  get isExitRunning(): boolean {
    return this.exitRun;
  }

  /** hold the conversation while an idea's exits run, so its agent cannot write the same document */
  beginExitRun(): void {
    this.exitRun = true;
  }

  endExitRun(): void {
    this.exitRun = false;
  }

  private refuseWhileExitRun(): void {
    if (this.exitRun) throw new ConversationRefused("出口を実行しています。終わるまで発言できません", 409);
  }

  /** whether this conversation's pi process is running right now (a settings change does not reach it) */
  get isPiRunning(): boolean {
    return Boolean(this.piProc?.isRunning);
  }

  get queueItems(): QueueItem[] {
    return queueSnapshot(this.machine);
  }

  get hasQueue(): boolean {
    return this.queueItems.length > 0;
  }

  get readerCount(): number {
    return this.log.subscriberCount;
  }

  get lastActivityAt(): number {
    return this.lastActivity;
  }

  modelString(): string | undefined {
    return this.currentModel;
  }

  effortString(): string | undefined {
    return this.currentEffort;
  }

  /**
   * Whether a person has sent into this Claude conversation. The queue counter resets when the engine restarts
   * or the conversation is reopened, so the record Claude Code wrote is the fact that survives: a record with a
   * message in it has been sent to.
   */
  private claudeSentTo(): boolean {
    if (this.harness !== "claude") return false;
    if (this.machine.itemSeq > 0) return true;
    const file = claudeRecordPath(this.claudeConfigDir ?? conversationClaudeConfigDir(), this.cwd, this.sessionId);
    return claudeRecordHasMessage(file);
  }

  watchClose(fn: () => void): () => void {
    this.closeWatchers.add(fn);
    return () => { this.closeWatchers.delete(fn); };
  }

  // ---- the mailbox: one event at a time, transitions only here ----

  private enqueue(event: ConversationMailEvent): void {
    this.mailbox.push(event);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.mailbox.length) {
        const event = this.mailbox.shift() as ConversationMailEvent;
        const { machine, directives } = reduceConversation(this.machine, event);
        this.machine = machine;
        for (const directive of directives) this.perform(directive);
      }
    } finally {
      this.pumping = false;
    }
  }

  private perform(directive: ConversationDirective): void {
    switch (directive.kind) {
      case "emit": {
        this.log.emit(directive.eventType, directive.fields);
        if (directive.eventType === "end") {
          this.runStartSeq = null;
          // pi's own context figures change with every response, so they ride the stream right after the end
          void this.emitContextUsage();
          if (directive.fields.reason === "completed") {
            const material = !this.ephemeral ? this.captureTitleMaterial() : undefined;
            if (material !== undefined) void this.maybeAutoTitle(material);
          }
        }
        return;
      }
      case "spawn":
        void this.runSpawn(directive.generation);
        return;
      case "prompt":
        void this.runPrompt(directive);
        return;
      case "typePrompt":
        void this.runTypePrompt(directive);
        return;
      case "steer":
        void this.runSteer(directive);
        return;
      case "abort":
        void this.runAbort(directive.generation);
        return;
      case "setModel":
        void this.runSetModel(directive);
        return;
      case "setEffort":
        void this.runSetEffort(directive);
        return;
      case "kill": {
        if (directive.generation !== this.machine.generation) return;
        if (directive.hard) {
          this.piProc?.kill("SIGKILL");
          return;
        }
        this.piProc?.close();
        const timer = setTimeout(() => this.enqueue({ type: "hardKill", generation: directive.generation }), directive.graceMs);
        timer.unref?.();
        return;
      }
      case "retire":
        this.retire();
        return;
    }
  }

  // ---- the process layer: carry out one directive and feed the result back as mail ----

  /**
   * The user's instructions this conversation starts with, and the system-prompt text that carries them (with how a
   * conversation puts a proposal down). Picked by the conversation's repo (the registered repo its cwd belongs to, when
   * it belongs to one), its scene and place, and this session's own additions and exclusions. An ephemeral branch is for
   * consulting and asides, not a place the user's standing instructions are aimed at, so it gets none.
   */
  private instructionStart(): { picked: Picked[]; prompt: string } | null {
    if (this.ephemeral) return null;
    let repo: string | undefined;
    try { repo = repoForPath(this.cwd)?.github; } catch { /* a registry that cannot be read names no repo */ }
    const mark = this.sessionMark();
    const picked = pickInstructions(
      { ...(repo ? { repo } : {}), scene: "chat", place: "conversation" },
      { add: mark.instructionAdd ?? [], exclude: mark.instructionExclude ?? [] },
    );
    return { picked, prompt: conversationInstructionPrompt(picked) };
  }

  private async runSpawn(generation: number): Promise<void> {
    if (this.harness === "claude") return this.runSpawnClaude(generation);
    return this.runSpawnPi(generation);
  }

  private async runSpawnPi(generation: number): Promise<void> {
    let proc: PiRpcProcess | null = null;
    try {
      await prepareAgentDirAsync(this.role.name);
      if (this.machine.generation !== generation) return;
      // the settings are read now, at start time: a change takes effect on the next pi, never on a running one
      const settings = readConversationSettings();
      const skills = enabledSkillPaths(settings, this.cwd);
      const extraTools = this.ephemeral ? [] : featureTools(settings);
      this.startedFeatures = this.ephemeral
        ? { webSearch: false, mcp: false, skills: [...skills] }
        : { webSearch: settings.webSearch, mcp: settings.mcp, skills: [...skills] };
      const plan = {
        mode: this.mode, role: this.role, cwd: this.cwd,
        toolNames: this.tools.length ? [...this.tools] : ["read"],
        initialModel: splitModel(this.role.model), thinkingLevel: this.role.thinking as ModeStartPlan["thinkingLevel"],
        agentDir: this.agentDir,
      } satisfies ModeStartPlan;
      // decide from pi's own record, not from how the conversation was made: once pi has written a session
      // file it is the source of the model and effort, and passing `--model` would overwrite the user's choice.
      // An ephemeral branch keeps its record in its own dir; a branch cut onto a new role is the exception,
      // because its record still holds the parent's model and must start on the role it was cut with.
      const record = this.ephemeral ? ephemeralSessionFile(this.sessionId) : resolveSessionFile(this.sessionId);
      const startFresh = (this.ephemeral && this.isNew) || !record
        ? { model: this.currentModel, effort: this.currentEffort }
        : null;
      // a space's context is added at every start, so a membership or definition change holds from the next
      // time pi is woken; a space whose dir is gone adds nothing. The mode's memory index rides along the
      // same way, read fresh each start, so an index the agent rewrites holds from the next pi. A consult
      // carries neither the type nor the memory: its first context is only the envelope (INV-2126).
      const spaceId = this.spaceId();
      const spacePrompt = spaceId ? renderSpaceContext(this.spaceContextWorkspace(), spaceId) : undefined;
      const memoryPrompts = this.ephemeral?.consult ? [] : memorySystemPrompts(this.mode.memory);
      // the user's instructions that apply to this conversation ride the same assembly, read fresh at every start, so
      // an approval or a session's own exception holds from the next pi and never reaches a running one (C-208-6)
      const instructions = this.instructionStart();
      const basePrompts = spacePrompt ? [spacePrompt, ...memoryPrompts] : memoryPrompts;
      const appendPrompts = instructions ? [...basePrompts, instructions.prompt] : basePrompts;
      proc = new PiRpcProcess({
        bin: piBinary(),
        args: conversationPiArgs(plan, this.sessionId, startFresh, this.ephemeral ? ephemeralDir() : undefined, appendPrompts, { skills, extraTools, propterRead: usesPropterRead(this.mode.name, this.ephemeral !== undefined) }),
        cwd: this.cwd,
        env: conversationPiEnv(this.agentDir, this.sessionId),
        onEvent: (record) => this.onPiRecord(generation, record),
        onExit: (exit) => this.onPiExit(generation, exit),
      });
      this.piProc = proc;
      this.piGeneration = generation;
      proc.start();
      // a readiness round trip: a spawn failure (a missing binary) surfaces here and fails the call
      const state = await proc.call<{ model?: { provider?: string; id?: string }; thinkingLevel?: string }>("get_state");
      if (this.machine.generation !== generation) { proc.close(); return; }
      if (this.machine.state.phase !== "opening") { proc.close(); return; }
      if (state.model?.provider && state.model.id) this.currentModel = `${state.model.provider}/${state.model.id}`;
      if (typeof state.thinkingLevel === "string") this.currentEffort = state.thinkingLevel;
      // the history is read before the spawn is reported: an open resolves with the retained context known,
      // so a prompt can never go before the instruction the type owes it. A consult carries no type at all
      if (this.mode.types && !this.ephemeral?.consult) {
        const history = await this.readHistoryFrom(proc, generation);
        if (this.machine.generation !== generation) { proc.close(); return; }
        if (this.machine.state.phase !== "opening") { proc.close(); return; }
        this.enqueue({ type: "historyRead", generation, lastType: history.lastType, full: history.full });
      }
      this.enqueue({ type: "spawned", generation });
      // the pi is up with its instructions: the ledger is written only now, never for a start that failed
      if (instructions) recordInjection(instructions.picked, { kind: "conversation", session: this.sessionId, scene: "chat" });
    } catch (err) {
      // a readiness round trip that fails must not leave this generation's pi alive: the conversation
      // moves on without it, and an orphan here would be a second writer on the next open (INV-1521)
      if (proc) {
        const dying = proc;
        dying.close();
        const timer = setTimeout(() => { if (dying.isRunning) dying.kill("SIGKILL"); }, 2500);
        timer.unref?.();
      }
      if (this.machine.generation !== generation) return;
      if (this.machine.state.phase === "closing") { this.enqueue({ type: "exited", generation }); return; }
      this.enqueue({ type: "spawnFailed", generation, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Start this conversation's Claude Code. The child keeps its stdin open between turns, so a stop, an
   * interruption and a mid-reply steer reach the running reply (C-163-1). The record is Claude Code's own file
   * in the conversation's config dir: the engine never writes an entry into it and keeps no history copy
   * (C-163-4, C-163-5). A conversation that already has a record is reopened with `--resume`.
   */
  private async runSpawnClaude(generation: number): Promise<void> {
    let proc: ClaudeRpcProcess | null = null;
    try {
      const configDir = this.claudeConfigDir ?? conversationClaudeConfigDir();
      this.claudeConfigDir = configDir;
      const record = claudeRecordPath(configDir, this.cwd, this.sessionId);
      // a branch forks from its parent once: after that the branch's own record is its history, and forking
      // again would replace what the branch said with the parent's copy
      const forking = this.ephemeral?.claudeForkOf && !existsSync(record) ? this.ephemeral.claudeForkOf : undefined;
      const model = this.currentModel ?? this.role.model;
      const effort = this.currentEffort ?? this.role.thinking;
      // Claude Code is given no skill directories, so the open state reports none rather than the settings' list
      this.startedFeatures = { webSearch: false, mcp: false, skills: [] };
      // the mode's memory rides the same assembly pi gets, read fresh at every start: a conversation reopened
      // after the index grew reads it now, not the text it first started with (C-169-2, C-169-3). A consult
      // gets none, as its pi does, so the branch's first context stays the envelope alone.
      const instructions = this.instructionStart();
      const memoryPrompts = [
        ...(this.ephemeral?.consult ? [] : memorySystemPrompts(this.mode.memory)),
        ...(instructions ? [instructions.prompt] : []),
      ];
      const args = forking
        ? claudeChatForkArgs(this.role, forking, { sessionId: this.sessionId, cwd: this.cwd, model, effort }, memoryPrompts)
        : claudeChatArgs(this.role, this.sessionId, { cwd: this.cwd, model, effort, resume: existsSync(record) }, memoryPrompts);
      proc = new ClaudeRpcProcess({
        bin: claudeBinary(),
        args,
        cwd: this.cwd,
        env: claudeChatEnv(configDir, this.sessionId),
        sessionId: this.sessionId,
        configDir,
        model,
        effort,
        onEvent: (record) => this.onClaudeRecord(generation, record),
        onExit: (exit) => this.onPiExit(generation, exit),
      });
      this.piProc = proc;
      this.piGeneration = generation;
      proc.start();
      // readiness is the child having really started, not a Claude record: init comes only with the first turn
      const state = await proc.call<{ model?: { id?: string }; thinkingLevel?: string; sessionId?: string }>("get_state");
      if (this.machine.generation !== generation) { proc.close(); return; }
      if (this.machine.state.phase !== "opening") { proc.close(); return; }
      if (state.model?.id) this.currentModel = state.model.id;
      if (typeof state.thinkingLevel === "string" && state.thinkingLevel) this.currentEffort = state.thinkingLevel;
      // a forked session reports its own id; re-register so both the engine's records and the screen agree on it
      if (state.sessionId && state.sessionId !== this.sessionId) this.rebindClaude(state.sessionId);
      // the retained context is read before the spawn is reported, so a prompt can never go before the
      // instruction the type owes it. pi's spawn keeps the same promise
      if (this.mode.types && !this.ephemeral?.consult) {
        const history = await this.readHistoryFrom(proc, generation);
        if (this.machine.generation !== generation) { proc.close(); return; }
        if (this.machine.state.phase !== "opening") { proc.close(); return; }
        this.enqueue({ type: "historyRead", generation, lastType: history.lastType, full: history.full });
      }
      this.enqueue({ type: "spawned", generation });
      // the Claude Code is up with its instructions: the ledger is written only now, never for a start that failed
      if (instructions) recordInjection(instructions.picked, { kind: "conversation", session: this.sessionId, scene: "chat" });
    } catch (err) {
      if (proc) {
        const dying = proc;
        dying.close();
        const timer = setTimeout(() => { if (dying.isRunning) dying.kill("SIGKILL"); }, 2500);
        timer.unref?.();
      }
      if (this.machine.generation !== generation) return;
      if (this.machine.state.phase === "closing") { this.enqueue({ type: "exited", generation }); return; }
      this.enqueue({ type: "spawnFailed", generation, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Fold one live Claude Code record. The turn's end and its cost come from `result` (Claude's own boundary);
   * everything else is the same vocabulary `foldPiEvent` produces, so the machine and the screen stay one path.
   */
  private onClaudeRecord(generation: number, record: ClaudeRecord): void {
    if (generation !== this.machine.generation) return;
    this.touch();
    if (record.type === "rate_limit_event") {
      try {
        const quota = quotaFromEvent(record);
        if (quota && this.claudeConfigDir) recordClaudeQuota(this.claudeConfigDir, quota);
      } catch { /* an observation the engine cannot read never fails the conversation */ }
      return;
    }
    if (record.type === "result") {
      const subtype = typeof record.subtype === "string" ? record.subtype : "";
      const isError = record.is_error === true;
      this.recordClaudeCost(record);
      this.enqueue({ type: "runEnded", generation, stopReason: subtype === "success" && !isError ? "stop" : "error" });
      return;
    }
    for (const folded of foldClaudeEvent(record)) {
      if (folded.kind === "entry") { this.log.emit("entry", { role: folded.fields.role, message: folded.fields.message }); continue; }
      if (folded.kind === "run_start") {
        this.runStartSeq = this.log.emit("run_start", folded.fields).seq;
        this.enqueue({ type: "runStarted", generation });
        continue;
      }
      if (folded.kind === "text" || folded.kind === "thinking") this.log.emit(folded.kind, folded.fields);
    }
  }

  /**
   * Record one Claude turn's cost. `result.total_cost_usd` is the process's running total, not the turn's own
   * (the reference's measurement), so only the increase since the last result is written and shown.
   */
  private recordClaudeCost(record: ClaudeRecord): void {
    const total = typeof record.total_cost_usd === "number" && Number.isFinite(record.total_cost_usd) ? record.total_cost_usd : undefined;
    const usage = record.usage as { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } | undefined;
    const tokens = {
      input: Number(usage?.input_tokens ?? 0) || 0,
      output: Number(usage?.output_tokens ?? 0) || 0,
      cacheRead: Number(usage?.cache_read_input_tokens ?? 0) || 0,
      cacheWrite: Number(usage?.cache_creation_input_tokens ?? 0) || 0,
    };
    // a process restart resets the running total: a smaller figure than the last one is this turn's own
    const delta = total === undefined ? 0 : total < this.claudeCostSeen ? total : total - this.claudeCostSeen;
    if (total !== undefined) this.claudeCostSeen = total;
    if (delta === 0 && !tokens.input && !tokens.output) return;
    appendCostLine({
      at: new Date().toISOString(),
      sessionId: this.sessionId,
      mode: this.mode.name,
      role: this.role.name,
      model: this.currentModel ?? "",
      tokens,
      cost: Number(delta.toFixed(6)),
      ...(this.ephemeral ? { ephemeral: true as const, parentSessionId: this.ephemeral.parentSessionId } : {}),
      ...(this.ephemeral?.consult ? {
        consult: true as const,
        consultKind: this.ephemeral.consult.kind,
        iddId: this.ephemeral.consult.iddId,
        batchId: this.ephemeral.consult.batchId,
      } : {}),
    });
    this.log.emit("cost", {
      model: this.currentModel,
      tokens,
      cost: Number(delta.toFixed(6)),
      sessionCost: conversationCostOf(this.sessionId),
    });
  }

  private async runPrompt(directive: { generation: number; item: QueueItem }): Promise<void> {
    const proc = this.piProc;
    if (!proc || !proc.isRunning || directive.generation !== this.machine.generation) {
      this.enqueue({ type: "promptSettled", generation: directive.generation, itemId: directive.item.id, disposition: "failed", error: "pi の process が動いていません" });
      return;
    }
    try {
      const data = await proc.call<{ disposition?: string }>("prompt", {
        message: directive.item.text,
        ...(directive.item.images?.length ? { images: directive.item.images } : {}),
      });
      const disposition = data?.disposition === "handled" ? "handled" : data?.disposition === "queued" ? "queued" : "started";
      this.enqueue({ type: "promptSettled", generation: directive.generation, itemId: directive.item.id, disposition });
    } catch (err) {
      this.enqueue({ type: "promptSettled", generation: directive.generation, itemId: directive.item.id, disposition: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async runSteer(directive: { generation: number; text: string; images?: PiImage[]; reply: SteerReply }): Promise<void> {
    const proc = this.piProc;
    if (!proc || !proc.isRunning || directive.generation !== this.machine.generation) {
      directive.reply.reject(new ConversationRefused("pi の process が動いていません", 503));
      return;
    }
    try {
      await proc.call("steer", { message: directive.text, ...(directive.images?.length ? { images: directive.images } : {}) });
      this.log.emit("queue", { queue: queueSnapshot(this.machine), steered: true });
      directive.reply.resolve();
    } catch (err) {
      directive.reply.reject(err);
    }
  }

  private async runAbort(generation: number): Promise<void> {
    const proc = this.piProc;
    if (!proc || !proc.isRunning || generation !== this.machine.generation) return;
    try { await proc.call("abort"); } catch { /* the run is over either way */ }
  }

  /** the fields of a `model` event: what pi holds now, and the levels the model accepts (DEC-118-3) */
  private modelEventFields(): Record<string, unknown> {
    return {
      model: this.currentModel,
      effort: this.currentEffort,
      ...(this.availableEfforts ? { efforts: this.availableEfforts } : {}),
    };
  }

  /**
   * Read back what pi actually holds after a switch. pi clamps an effort the model does not accept, so the
   * requested value is never taken as the answer (DEC-118-3). A `get_state` that fails leaves the value pi's
   * own `thinking_level_changed` event folded, never the requested one.
   */
  private async readPiModelState(proc: RpcChild): Promise<void> {
    try {
      const state = await proc.call<{ model?: { provider?: string; id?: string }; thinkingLevel?: string }>("get_state");
      if (state.model?.provider && state.model.id) this.currentModel = `${state.model.provider}/${state.model.id}`;
      if (typeof state.thinkingLevel === "string") this.currentEffort = state.thinkingLevel;
    } catch { /* keep what pi's events folded */ }
  }

  /** the levels the current model accepts, as pi reports them; an older pi without the rpc changes nothing */
  private async readAvailableEfforts(proc: RpcChild): Promise<void> {
    try {
      const res = await proc.call<{ levels?: unknown }>("get_available_thinking_levels");
      if (!Array.isArray(res.levels)) return;
      const levels = res.levels.filter((level): level is string => typeof level === "string");
      if (levels.length) this.availableEfforts = levels;
    } catch { /* an older pi has no such rpc; the last known levels stay */ }
  }

  private async runSetModel(directive: { generation: number; model: string }): Promise<void> {
    const proc = this.piProc;
    if (!proc || !proc.isRunning || directive.generation !== this.machine.generation) {
      this.enqueue({ type: "modelSettled", generation: directive.generation, step: "model", ok: false, error: "pi の process が動いていません" });
      return;
    }
    try {
      if (this.harness === "claude") {
        // Claude Code takes the model's alias; there is no provider / modelId pair to split
        await proc.call("set_model", { model: directive.model });
        this.currentModel = directive.model;
      } else {
        const { provider, modelId } = splitModel(directive.model);
        await proc.call("set_model", { provider, modelId });
        await this.readPiModelState(proc);
      }
      await this.readAvailableEfforts(proc);
      this.log.emit("model", this.modelEventFields());
      this.enqueue({ type: "modelSettled", generation: directive.generation, step: "model", ok: true });
      // the model carries the context window, so the figures are read again for the screen's water mark
      void this.emitContextUsage();
    } catch (err) {
      this.enqueue({ type: "modelSettled", generation: directive.generation, step: "model", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async runSetEffort(directive: { generation: number; effort: string }): Promise<void> {
    // Claude Code fixes its effort at launch (`--effort`); stream-json has no port to change it mid-session
    if (this.harness === "claude") {
      this.enqueue({ type: "modelSettled", generation: directive.generation, step: "effort", ok: false, error: "Claude の会話では thinking を切り替えられません" });
      return;
    }
    const proc = this.piProc;
    if (!proc || !proc.isRunning || directive.generation !== this.machine.generation) {
      this.enqueue({ type: "modelSettled", generation: directive.generation, step: "effort", ok: false, error: "pi の process が動いていません" });
      return;
    }
    try {
      await proc.call("set_thinking_level", { level: directive.effort });
      await this.readPiModelState(proc);
      await this.readAvailableEfforts(proc);
      this.log.emit("model", this.modelEventFields());
      this.enqueue({ type: "modelSettled", generation: directive.generation, step: "effort", ok: true });
    } catch (err) {
      this.enqueue({ type: "modelSettled", generation: directive.generation, step: "effort", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** the id the transition uses to tell this instruction's settlement apart from a user item's */
  private instructionId(instruction: TypeInstruction): string {
    return `type:${instruction.type}`;
  }

  /**
   * The instruction text, read now from the type's own files: the operations body for a full instruction, or
   * one line that names the type to return to. The engine keeps no copy of the operations body anywhere.
   */
  private buildTypeInstruction(instruction: TypeInstruction): string {
    const target = this.mode.types?.[instruction.type];
    if (!target) throw new Error(`知らない型です: ${instruction.type}`);
    if (instruction.kind === "short") {
      const line = target.operations
        ? `会話の型を「${target.label}」に戻します。運用のファイル（${target.operations}）の進め方に従ってください。`
        : `会話の型を「${target.label}」に戻します。ここからは通常の対話として進めてください。`;
      return `<propter-system-message>\n${line}\n</propter-system-message>`;
    }
    const lines = ["<propter-system-message>", `会話の型: ${target.label}`, `作業対象の dir: ${target.dir}`];
    if (target.template) lines.push(`テンプレ: ${target.template}`);
    lines.push("");
    if (target.operations) {
      lines.push("運用:", readFileSync(target.operations, "utf8").replace(/\n+$/, ""));
    } else {
      lines.push("ここからは通常の対話として進めてください。");
    }
    lines.push("", "</propter-system-message>");
    return lines.join("\n");
  }

  private async runTypePrompt(directive: { generation: number; instruction: TypeInstruction }): Promise<void> {
    const proc = this.piProc;
    const itemId = this.instructionId(directive.instruction);
    if (!proc || !proc.isRunning || directive.generation !== this.machine.generation) {
      this.enqueue({ type: "promptSettled", generation: directive.generation, itemId, disposition: "failed", error: "pi の process が動いていません" });
      return;
    }
    let text: string;
    try {
      text = this.buildTypeInstruction(directive.instruction);
    } catch (err) {
      this.enqueue({ type: "promptSettled", generation: directive.generation, itemId, disposition: "failed", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const payload = JSON.stringify({ content: text, type: directive.instruction.type, kind: directive.instruction.kind });
    try {
      const data = await proc.call<{ disposition?: string }>("prompt", { message: `${CONVERSATION_TYPE_COMMAND_TEXT} ${payload}` });
      if (data?.disposition === "handled") {
        this.enqueue({ type: "promptSettled", generation: directive.generation, itemId, disposition: "handled" });
      } else {
        this.enqueue({ type: "promptSettled", generation: directive.generation, itemId, disposition: "failed", error: "型の指示が処理されませんでした" });
      }
    } catch (err) {
      this.enqueue({ type: "promptSettled", generation: directive.generation, itemId, disposition: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** the retained type instructions from pi; an unreadable history reads empty so prompts are never stuck */
  private async readHistoryFrom(proc: RpcChild, generation: number): Promise<TypeHistory> {
    try {
      const res = await proc.call<{ entries?: unknown[]; leafId?: string | null }>("get_entries");
      if (generation !== this.machine.generation) return { lastType: null, full: [] };
      return typeHistoryFromEntries(res.entries ?? [], res.leafId ?? null);
    } catch {
      return { lastType: null, full: [] };
    }
  }

  /** re-read the history after pi changed it under us (a fork, or a compaction) */
  private async refreshHistory(): Promise<void> {
    if (!this.mode.types) return;
    const proc = this.piProc;
    if (!proc || !proc.isRunning) return;
    const generation = this.machine.generation;
    const history = await this.readHistoryFrom(proc, generation);
    if (generation !== this.machine.generation) return;
    this.enqueue({ type: "historyRead", generation, lastType: history.lastType, full: history.full });
  }

  private onPiRecord(generation: number, record: PiRpcRecord): void {
    this.touch();
    switch (record.type) {
      case "extension_ui_request": {
        this.onExtensionUi(record);
        return;
      }
      case "agent_settled": {
        const stopReason = this.lastStopReason;
        this.lastStopReason = null;
        this.enqueue({ type: "runEnded", generation, stopReason });
        return;
      }
      case "message_end": {
        const message = record.message as { role?: string; stopReason?: string } | undefined;
        if (message?.role === "assistant" && typeof message.stopReason === "string") this.lastStopReason = message.stopReason;
        break;
      }
      default:
        break;
    }
    for (const folded of foldPiEvent(record)) {
      if (folded.kind === "entry") {
        this.log.emit("entry", { role: folded.fields.role, message: folded.fields.message });
        continue;
      }
      if (folded.kind === "cost") {
        this.recordCost(folded.usage, folded.fields.compaction === true);
        continue;
      }
      if (folded.kind === "effort") {
        this.currentEffort = String(folded.fields.effort);
        this.log.emit("model", this.modelEventFields());
        continue;
      }
      if (folded.kind === "compaction_start") this.compacting = true;
      if (folded.kind === "compaction_end") {
        this.compacting = false;
        // the retained range changed under us: forget the old history and read what pi kept
        this.enqueue({ type: "compactionEnded", generation });
        void this.refreshHistory();
      }
      if (folded.kind === "run_start") {
        this.runStartSeq = this.log.emit("run_start", folded.fields).seq;
        this.enqueue({ type: "runStarted", generation });
        continue;
      }
      this.log.emit(folded.kind, folded.fields);
    }
  }

  private onPiExit(generation: number, exit: { code: number | null; signal: NodeJS.Signals | null; error?: string }): void {
    if (this.piProc && this.piGeneration === generation) this.piProc = null;
    const message = [exit.error ?? null, exit.code !== null && exit.code !== 0 ? `exit ${exit.code}` : null, exit.signal].filter(Boolean).join(": ");
    this.enqueue({ type: "exited", generation, ...(message ? { error: message } : {}) });
  }

  /** pi asked a person something; the engine has no way to put the question, so it cancels at once */
  private onExtensionUi(record: PiRpcRecord): void {
    const id = typeof record.id === "string" ? record.id : "";
    const method = typeof record.method === "string" ? record.method : "";
    const dialog = ["select", "confirm", "input", "editor"].includes(method);
    if (dialog && id) this.piProc?.replyExtensionUi(id, { cancelled: true });
    if (id || method) this.log.emit("extension", { id, method, ...(typeof record.title === "string" ? { title: record.title } : {}), cancelled: dialog });
  }

  private recordCost(usage: PiUsage | undefined, compaction: boolean): void {
    if (!usage) return;
    const cost = costTotalOf(usage);
    if (cost === 0 && !usage.input && !usage.output) return;
    appendCostLine({
      at: new Date().toISOString(),
      sessionId: this.sessionId,
      mode: this.mode.name,
      role: this.role.name,
      model: this.currentModel ?? "",
      tokens: {
        input: Number(usage.input ?? 0) || 0,
        output: Number(usage.output ?? 0) || 0,
        cacheRead: Number(usage.cacheRead ?? 0) || 0,
        cacheWrite: Number(usage.cacheWrite ?? 0) || 0,
      },
      cost,
      ...(compaction ? { compaction: true as const } : {}),
      ...(this.ephemeral ? { ephemeral: true as const, parentSessionId: this.ephemeral.parentSessionId } : {}),
      ...(this.ephemeral?.consult ? {
        consult: true as const,
        consultKind: this.ephemeral.consult.kind,
        iddId: this.ephemeral.consult.iddId,
        batchId: this.ephemeral.consult.batchId,
      } : {}),
    });
    this.log.emit("cost", {
      model: this.currentModel,
      tokens: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 },
      cost,
      sessionCost: conversationCostOf(this.sessionId),
      ...(compaction ? { compaction: true } : {}),
    });
  }

  /** pi's context figures, or null when pi is not running, does not answer, or has none */
  async contextUsage(): Promise<ContextUsage | null> {
    const pi = this.piProc;
    if (!pi || !pi.isRunning) return null;
    try {
      const data = await withTimeout(pi.call<{ contextUsage?: { tokens?: unknown; contextWindow?: unknown; percent?: unknown } }>("get_session_stats"), CONTEXT_STATS_TIMEOUT_MS);
      const usage = data?.contextUsage;
      if (!usage || typeof usage !== "object") return null;
      return {
        tokens: typeof usage.tokens === "number" ? usage.tokens : null,
        contextWindow: typeof usage.contextWindow === "number" ? usage.contextWindow : null,
        percent: typeof usage.percent === "number" ? usage.percent : null,
      };
    } catch {
      return null;
    }
  }

  private async emitContextUsage(): Promise<void> {
    const usage = await this.contextUsage();
    if (usage) this.log.emit("context", { contextUsage: usage, notices: safeNotices(usage, this.currentModel, this.harness) });
  }

  /** the title material of the record as it stands right now; undefined when the record is not there yet */
  private captureTitleMaterial(): string | undefined {
    const file = this.sessionFile();
    if (!file) return undefined;
    try {
      if (this.harness === "claude") return titleMaterial(readClaudeEntries(this.claudeConfigDir ?? conversationClaudeConfigDir(), this.cwd, this.sessionId).entries);
      return readTitleMaterial(file);
    } catch { return undefined; }
  }

  /**
   * Write a title for a session that has none. The name is asked of pi at the completion and again right
   * before writing, so a name a person set in the meantime is never overwritten. Nothing is ever sent to the
   * conversation's pi for the title itself: a separate one-shot run writes it, and only `set_session_name`
   * carries the result back.
   */
  private async maybeAutoTitle(material: string): Promise<void> {
    if (this.titleGenerating || this.isClosed) return;
    this.titleGenerating = true;
    try {
      const before = await this.piProc?.call<{ sessionName?: string }>("get_state");
      if (!before || before.sessionName) return;
      const result = await generateConversationTitle({ sessionId: this.sessionId, mode: this.mode.name, material });
      if (this.isClosed) return;
      const pi = this.piProc;
      if (!pi || !pi.isRunning) return;
      // the last look before the write: a name that appeared during the generation wins
      const now = await pi.call<{ sessionName?: string }>("get_state");
      if (now.sessionName) return;
      await pi.call("set_session_name", { name: result.title });
      this.log.emit("name", { name: result.title });
    } catch {
      // a title is a convenience: its failure never changes how the conversation ended
    } finally {
      this.titleGenerating = false;
    }
  }

  /**
   * Replace the session's name with one generated from the current branch's last turns. Refused with 409
   * while any title generation is running. Nothing is sent to the conversation's pi beyond `get_entries`
   * (to read the material) and `set_session_name` (to write the result).
   */
  async retitle(): Promise<{ name: string; model: string }> {
    if (this.titleGenerating) throw new ConversationRefused("タイトルの生成中です", 409);
    this.touch();
    this.titleGenerating = true;
    try {
      await this.open();
      const pi = this.requirePi();
      const entriesRes = await pi.call<{ entries?: unknown[] }>("get_entries");
      const material = titleMaterial(entriesRes.entries ?? []);
      if (!material.trim()) throw new ConversationRefused("タイトルの材料がありません", 409);
      const result = await generateConversationTitle({ sessionId: this.sessionId, mode: this.mode.name, material });
      if (this.isClosed) throw new ConversationRefused("会話は閉じられています", 410);
      await this.requirePi().call("set_session_name", { name: result.title });
      this.log.emit("name", { name: result.title });
      return { name: result.title, model: result.model };
    } finally {
      this.titleGenerating = false;
    }
  }

  // ---- the callers' doors: each one puts its request in the mailbox ----

  /** wake pi if it is not up; a query door that needs pi waits here and then calls pi directly */
  open(): Promise<void> {
    if (this.machine.state.phase === "closing") return Promise.reject(new ConversationRefused("会話は閉じられています", 410));
    return new Promise<void>((resolve, reject) => this.enqueue({ type: "open", reply: { resolve, reject } }));
  }

  /**
   * Change the conversation's type. pi is not respawned and no run starts: the instruction goes in as an
   * invisible context message. Idle with an empty queue delivers it now and answers when pi has it; anything
   * else answers undelivered and owes the instruction to the next prompt. The mark is written first, so the
   * choice survives an engine restart.
   */
  async setType(typeName: string): Promise<{ type: string; delivered: boolean; queue: QueueItem[] }> {
    this.refuseWhileExitRun();
    if (this.harness === "claude") throw new ConversationRefused("Claude の会話は型を切り替えられません", 409);
    if (this.ephemeral) throw new ConversationRefused("枝の会話は型を切り替えられません", 409);
    if (!this.mode.types) throw new ConversationRefused("この mode は型を持ちません", 409);
    const target = this.mode.types[typeName];
    if (!target) throw new ConversationRefused(`知らない型です: ${typeName}`, 400);
    // the engine reads the operations body at delivery time, but the type is refused now if it points nowhere
    if (!existsSync(target.dir) || !statSync(target.dir).isDirectory()) throw new ConversationRefused(`型の置き場がありません: ${target.dir}`, 409);
    if (target.operations && (!existsSync(target.operations) || !statSync(target.operations).isFile())) throw new ConversationRefused(`運用のファイルがありません: ${target.operations}`, 409);
    this.touch();
    await this.open();
    const workspace = placeWorkspaceFor(this.sessionId, this.cwd, this.mode, safeModes());
    setSessionMark(workspace, this.sessionId, { type: typeName });
    this.wantType = typeName;
    const delivered = await new Promise<boolean>((resolve, reject) => this.enqueue({ type: "typeRequest", wantType: typeName, reply: { resolve, reject } }));
    return { type: typeName, delivered, queue: this.queueItems };
  }

  /** add an item and, when nothing is running, start feeding the queue from its head */
  send(text: string, opts: { model?: string; effort?: string; images?: PiImage[] } = {}): QueueItem {
    this.refuseWhileExitRun();
    const result: RequestResult = {};
    this.enqueue({ type: "send", text, ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), ...(opts.images?.length ? { images: opts.images } : {}), result });
    if (result.error) throw result.error;
    return result.item as QueueItem;
  }

  async steer(text: string, images?: PiImage[]): Promise<void> {
    this.refuseWhileExitRun();
    this.touch();
    await new Promise<void>((resolve, reject) => this.enqueue({ type: "steer", text, ...(images?.length ? { images } : {}), reply: { resolve, reject } }));
  }

  /**
   * Stop the run. A run going is aborted now; a prompt still on its way is stopped after pi answers for it,
   * because a command sent before the prompt's answer could land in the wrong order. The queue stays and
   * runs again only when the person sends something.
   */
  stop(): Promise<{ stopped: boolean }> {
    this.touch();
    return new Promise((resolve, reject) => this.enqueue({ type: "stop", reply: { resolve, reject } }));
  }

  /**
   * Change the session's model / effort without sending. Idle applies it to pi and answers when pi replies;
   * every other state holds the value for the next prompt.
   */
  async setModelEffort(opts: { model?: string | null; effort?: string | null }): Promise<{ model?: string; effort?: string; efforts?: string[] }> {
    this.touch();
    const model = typeof opts.model === "string" && opts.model ? opts.model : null;
    const effort = typeof opts.effort === "string" && opts.effort ? opts.effort : null;
    // a Claude conversation that has not been sent to yet may still be pointed at a pi model instead;
    // once the record holds a message, the harness is fixed and the pi route is refused rather than started
    if (this.harness === "claude" && model && !this.ephemeral && isPiModelName(model)) {
      if (this.claudeSentTo()) throw new ConversationRefused("送信済みの会話は別の harness の model に替えられません", 409);
      await this.switchHarnessToPi(model);
      return { model: this.currentModel, effort: this.currentEffort, ...(this.availableEfforts ? { efforts: this.availableEfforts } : {}) };
    }
    await new Promise<void>((resolve, reject) => this.enqueue({ type: "model", model, effort, reply: { resolve, reject } }));
    return { model: this.currentModel, effort: this.currentEffort, ...(this.availableEfforts ? { efforts: this.availableEfforts } : {}) };
  }

  /**
   * Point a not-yet-sent Claude conversation at a pi model. The harness is a property of the route, and the
   * record's place follows the harness (C-163-11); from the first message on, the harness is fixed. The
   * Claude child is stopped and the pi role's process is started in its place, keeping one process per session.
   */
  private async switchHarnessToPi(model: string): Promise<void> {
    const fallback = typeof this.role.fallback === "string" ? this.role.fallback : this.role.fallback?.[0];
    if (!fallback) throw new ConversationRefused(`role ${this.role.name} には pi の代わりの role がありません`, 409);
    const role = resolveRole(fallback);
    if (role.harness !== "pi") throw new ConversationRefused(`代わりの role ${role.name} は pi ではありません`, 409);
    if (this.machine.state.phase !== "idle" && this.machine.state.phase !== "closed") throw new ConversationRefused("応答中は harness を替えられません", 409);
    // stop the Claude child without retiring the conversation; its exit is dropped by the generation below
    this.piProc?.close();
    this.piProc = null;
    this.harness = "pi";
    this.role = role;
    this.agentDir = pipelineAgentDir(role);
    this.tools = role.tools.length ? [...role.tools] : ["read"];
    this.currentModel = model;
    this.currentEffort = undefined;
    this.availableEfforts = undefined;
    // the new machine keeps the last generation so the old child's exit cannot be taken for the new one's
    this.machine = { ...emptyConversationMachine(), generation: this.piGeneration, wantType: this.wantType };
    recordConversationSession(this.sessionId, this.mode, planForRole(this.mode, role, this.cwd));
    await this.open();
  }

  editQueueItem(id: string, patch: QueueItemPatch): QueueItem {
    const result: RequestResult = {};
    this.enqueue({ type: "edit", id, patch, result });
    if (result.error) throw result.error;
    return result.item as QueueItem;
  }

  cancelQueueItem(id: string): QueueItem {
    const result: RequestResult = {};
    this.enqueue({ type: "cancel", id, result });
    if (result.error) throw result.error;
    return result.item as QueueItem;
  }

  /** take an item out of the queue and send it as a steering message */
  async steerQueueItem(id: string): Promise<QueueItem> {
    this.refuseWhileExitRun();
    // a type instruction still owed to pi must land before any user text: a steer would overtake it
    if (this.hasUndeliveredInstruction()) throw new ConversationRefused("型の指示が未達のため割り込みに替えられません", 409);
    const item = this.cancelQueueItem(id);
    await this.steer(item.text, item.images);
    return item;
  }

  /** whether a type instruction is waiting or on its way to pi right now */
  hasUndeliveredInstruction(): boolean {
    if (this.machine.instruction) return true;
    return this.machine.state.phase === "delivering";
  }

  /**
   * Pass one of the commands the bridging door allows straight to this conversation's pi, and return pi's
   * answer. `fork` is special: pi 1.0.0's fork switches the same process to a new session id, so the
   * conversation re-registers itself under that id and answers with it, leaving one writer on the new record.
   */
  async runCommand(type: string, fields: Record<string, unknown>): Promise<{ data?: unknown; newSessionId?: string }> {
    this.touch();
    await this.open();
    if (this.harness === "claude") {
      // only the commands with a stream-json meaning are bridged; `fork` and `compact` have none (C-163-11)
      if (!CLAUDE_BRIDGED_COMMANDS.has(type)) throw new ConversationRefused(`この口は Claude の会話では使えません: ${type}`, 400);
      return { data: await this.requirePi().call(type, fields) };
    }
    const data = await this.requirePi().call<Record<string, unknown>>(type, fields);
    if (type !== "fork") return { data };
    const state = await this.requirePi().call<{ sessionId?: string }>("get_state");
    const newSessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
    if (!newSessionId || newSessionId === this.sessionId) return { data };
    this.rebindTo(newSessionId);
    return { data, newSessionId };
  }

  private rebindTo(newSessionId: string): void {
    const previous = this.sessionId;
    this.sessionId = newSessionId;
    registry.delete(previous);
    registry.set(newSessionId, this);
    // the fork's record has no spawn record of its own: copy the original mode's, or the open door cannot
    // find the mode for it (a fork from a record-less conversation is left to the record it forks from)
    recordPipelineSession(newSessionId, {
      slot: `mode:${this.mode.name}`,
      role: this.role.name,
      model: this.role.model,
      agentDir: this.agentDir,
      thinkingLevel: this.role.thinking as ModeStartPlan["thinkingLevel"],
      cwd: this.cwd,
    });
    // a fork is a new session id: the space membership has to follow it, or the new record opens without one.
    // The parent's place is kept, not the current mode's workspace, so a nested layout does not split the mark
    // across two files. A marks file the engine cannot read is the engine's own write: skip it and let the fork
    // it rides on succeed.
    const place = placeWorkspaceFor(previous, this.cwd, this.mode, safeModes());
    const previousMark = readMarks(place).sessions[previous];
    const membership = previousMark?.space;
    if (membership) setSessionMark(place, newSessionId, { space: membership }, { onUnreadable: "skip" });
    // the type rides the same way: a fork copies the history's instructions, so the API's answer must follow
    if (previousMark?.type) setSessionMark(place, newSessionId, { type: previousMark.type }, { onUnreadable: "skip" });
    // the mark is the membership from here on: a change through the marks door must win over this copy
    this.acceptSpaceMark();
    this.log.emit("state", { sessionId: newSessionId, reboundFrom: previous });
    // pi's fork switched the same process to another leaf; read what the new branch actually retains
    void this.refreshHistory();
  }

  /**
   * Re-register a Claude conversation under the id Claude Code actually used. `--fork-session` picks its own
   * id, so a branch cut with it must follow that id or the engine's records would point at a session nobody
   * writes (C-163-13). The Claude record itself is never touched: only the engine's own records move.
   */
  private rebindClaude(newSessionId: string): void {
    const previous = this.sessionId;
    if (newSessionId === previous) return;
    this.sessionId = newSessionId;
    registry.delete(previous);
    registry.set(newSessionId, this);
    if (this.ephemeral) {
      this.ephemeral.sessionId = newSessionId;
      this.ephemeral.updatedAt = new Date().toISOString();
      writeEphemeralRecord(this.ephemeral);
      try { rmSync(ephemeralRecordPath(previous), { force: true }); } catch { /* the old record is gone with the id */ }
    }
    if (!this.ephemeral) {
      writePipelineSession({
        session_id: newSessionId,
        slot: `mode:${this.mode.name}`,
        role: this.role.name,
        model: this.role.model,
        agent_dir: "",
        thinking: this.role.thinking,
        spawned_at: new Date().toISOString(),
        cwd: this.cwd,
        harness: "claude",
        claude_session_id: newSessionId,
      });
      removePipelineSession(previous);
    }
    this.log.emit("state", { sessionId: newSessionId, reboundFrom: previous });
  }

  /** the history stays pi's; the engine adds only the live state it holds in memory */
  async openState(): Promise<ConversationOpenState> {
    await this.open();
    const pi = this.requirePi();
    const entriesRes = await pi.call<{ entries?: unknown[]; leafId?: string | null }>("get_entries");
    const stateRes = await pi.call<{ model?: { provider?: string; id?: string }; thinkingLevel?: string }>("get_state");
    // a Claude model is the alias the picker offers, never a provider / id pair: the pair would not match a
    // candidate and the screen could not read the model's capabilities
    if (this.harness === "claude") {
      if (stateRes.model?.id) this.currentModel = stateRes.model.id;
    } else if (stateRes.model?.provider && stateRes.model.id) {
      this.currentModel = `${stateRes.model.provider}/${stateRes.model.id}`;
    }
    if (typeof stateRes.thinkingLevel === "string") this.currentEffort = stateRes.thinkingLevel;
    // the effort slider's stops are pi's own answer, so they are read here too (DEC-118-3)
    await this.readAvailableEfforts(pi);
    // stats are asked apart from the two calls above: a pi that does not answer them still opens
    const contextUsage = await this.contextUsage();
    const typeName = this.wantType ?? undefined;
    const document = typeName ? documentFromEntries(entriesRes.entries ?? [], entriesRes.leafId ?? null, this.cwd, this.mode.types?.[typeName]) : undefined;
    return {
      id: this.sessionId,
      mode: this.mode.name,
      cwd: this.cwd,
      model: this.currentModel,
      effort: this.currentEffort,
      streaming: this.isStreaming,
      promptPending: this.isPromptPending,
      compacting: this.compacting,
      ...(this.runStartSeq !== null ? { runStartSeq: this.runStartSeq } : {}),
      queue: this.queueItems,
      entries: entriesRes.entries ?? [],
      leafId: entriesRes.leafId ?? null,
      cost: conversationCostOf(this.sessionId),
      contextUsage,
      notices: safeNotices(contextUsage, this.currentModel, this.harness),
      ...(this.availableEfforts ? { efforts: this.availableEfforts } : {}),
      harness: this.harness,
      features: { ...this.startedFeatures, skills: [...this.startedFeatures.skills] },
      ...(typeName ? { type: typeName } : {}),
      ...(document ? { document } : {}),
    };
  }

  /**
   * The models a Claude conversation can be switched to. Its own candidates are the config's Claude roles'
   * models (the aliases Claude Code takes) plus the one it holds; before the first message the pi candidates
   * ride alongside, because the harness is still choosable then (C-163-11, C-163-12). The Claude candidates
   * carry the image capability, which is what the screen reads to allow an attachment (AC-004).
   */
  private async claudeModelCandidates(): Promise<{ models: ConversationModelOption[]; current: { model?: string; effort?: string; efforts?: string[] } }> {
    await this.open();
    const proc = this.requirePi();
    const state = await proc.call<{ model?: { id?: string }; thinkingLevel?: string }>("get_state");
    if (state.model?.id) this.currentModel = state.model.id;
    if (typeof state.thinkingLevel === "string" && state.thinkingLevel) this.currentEffort = state.thinkingLevel;
    const names = new Set<string>();
    try {
      for (const role of Object.values(readRoles().roles)) if (role.harness === "claude" && role.model) names.add(role.model);
    } catch { /* an unreadable config still offers the model the conversation holds */ }
    if (this.currentModel) names.add(this.currentModel);
    const models: ConversationModelOption[] = [];
    for (const name of names) models.push({ id: name, name, provider: "claude", contextWindow: null, capabilities: ["image"] });
    if (!this.ephemeral && !this.claudeSentTo()) {
      for (const name of configuredModelNames()) {
        if (names.has(name)) continue;
        const { provider, modelId } = splitModel(name);
        models.push({ id: name, name: modelId, provider, contextWindow: null, capabilities: [] });
      }
    }
    models.sort(compareModels);
    return { models, current: { model: this.currentModel, effort: this.currentEffort } };
  }

  /**
   * The models this conversation's pi will accept, as the picker offers them: the names the config knows
   * (every role's model and every model the user's `models.json` defines) kept to pi's own list, with the
   * current model always included so the picker can mark it (DEC-118-1).
   */
  async modelCandidates(): Promise<{ models: ConversationModelOption[]; current: { model?: string; effort?: string; efforts?: string[] } }> {
    if (this.harness === "claude") return this.claudeModelCandidates();
    await this.open();
    const pi = this.requirePi();
    const stateRes = await pi.call<{ model?: { provider?: string; id?: string }; thinkingLevel?: string }>("get_state");
    if (stateRes.model?.provider && stateRes.model.id) this.currentModel = `${stateRes.model.provider}/${stateRes.model.id}`;
    if (typeof stateRes.thinkingLevel === "string") this.currentEffort = stateRes.thinkingLevel;
    await this.readAvailableEfforts(pi);
    const available = await piAvailableModels(pi);
    const names = new Set(configuredModelNames());
    if (this.currentModel) names.add(this.currentModel);
    // a pi that will not answer its own list can only be offered the model it holds now
    if (available.size === 0) {
      names.clear();
      if (this.currentModel) names.add(this.currentModel);
    }
    const models: ConversationModelOption[] = [];
    for (const name of names) {
      const info = available.get(name);
      if (available.size > 0 && !info && name !== this.currentModel) continue;
      const { provider, modelId } = splitModel(name);
      models.push({
        id: name,
        name: typeof info?.name === "string" && info.name ? info.name : modelId,
        provider,
        contextWindow: typeof info?.contextWindow === "number" ? info.contextWindow : null,
        capabilities: capabilitiesOf(info),
      });
    }
    models.sort(compareModels);
    return {
      models,
      current: { model: this.currentModel, effort: this.currentEffort, ...(this.availableEfforts ? { efforts: this.availableEfforts } : {}) },
    };
  }

  /** the pi session file this conversation writes, when pi has made it */
  sessionFile(): string | undefined {
    if (this.harness === "claude" || this.ephemeral?.claudeForkOf) {
      const file = claudeRecordPath(this.claudeConfigDir ?? conversationClaudeConfigDir(), this.cwd, this.sessionId);
      return existsSync(file) ? file : undefined;
    }
    if (this.ephemeral) return ephemeralSessionFile(this.sessionId);
    const dir = piSessionDir(this.cwd, this.agentDir);
    if (!existsSync(dir)) return undefined;
    const suffix = `_${this.sessionId}.jsonl`;
    const name = readdirSync(dir).find((entry) => entry.endsWith(suffix));
    return name ? join(dir, name) : undefined;
  }

  /** the last turns of the record as title material, whichever harness wrote the record */
  titleMaterialText(): string {
    const file = this.sessionFile();
    if (!file) return "";
    try {
      if (this.harness === "claude") return titleMaterial(readClaudeEntries(this.claudeConfigDir ?? conversationClaudeConfigDir(), this.cwd, this.sessionId).entries);
      return readTitleMaterial(file);
    } catch {
      return "";
    }
  }

  private requirePi(): RpcChild {
    const pi = this.piProc;
    if (!pi || !pi.isRunning) throw new ConversationRefused("pi の process が動いていません", 503);
    return pi;
  }

  /** close pi, keeping the session's record; resolves once pi's process is really gone */
  close(): Promise<void> {
    // the close or delete in flight is the one gate per session; a second caller waits on the same one
    const inflight = closing.get(this.sessionId);
    if (inflight) return inflight;
    const done = this.requestClose(closeExitTimeoutMs()).then(() => undefined);
    closing.set(this.sessionId, done);
    const settle = () => { if (closing.get(this.sessionId) === done) closing.delete(this.sessionId); };
    done.then(settle, settle);
    return done;
  }

  /** ask for the close and learn whether pi was gone before the grace ran out */
  private requestClose(graceMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => this.enqueue({ type: "close", graceMs, reply: { resolve } }));
  }

  /** the queue as the person sees it, without the item pi has already been handed */
  private droppedQueue(): QueueItem[] {
    return droppedQueue(this.machine);
  }

  private retire(): void {
    if (registry.get(this.sessionId) === this) registry.delete(this.sessionId);
    for (const watcher of this.closeWatchers) {
      try { watcher(); } catch { /* the stream's own closing */ }
    }
    this.closeWatchers.clear();
    this.log.clear();
  }

  /**
   * Close and remove pi's session record and the spawn record. The record removal rides in the same gate as the
   * close, so an open that waits out the close cannot start pi on a record that is about to disappear, and no
   * conversation for this id is left open. An ephemeral branch also removes its config record.
   */
  async remove(): Promise<void> {
    if (this.removePromise) return this.removePromise;
    const file = this.sessionFile();
    const branch = this.ephemeral !== undefined;
    const sessionId = this.sessionId;
    const workspace = placeWorkspaceFor(sessionId, this.cwd, this.mode, safeModes());
    const done = (async () => {
      await this.close();
      // the workspace mark goes before the records: the mode is read from the record and the spawn record,
      // so a mark left behind after both are gone could never be placed again. A marks file the engine cannot
      // read must not stop the delete the person asked for, so its failure is logged and skipped.
      if (!branch) {
        try { removeSessionMark(workspace, sessionId, { onUnreadable: "skip" }); } catch { /* the mark is gone with the rest */ }
      }
      if (branch) {
        removeEphemeralBranch(sessionId);
        // a Claude branch's own record lives in the chat config dir; deleting the branch deletes that record
        if (this.harness === "claude") {
          if (file) rmSync(file, { force: true });
          removeClaudeChatTitle(sessionId);
        }
        // a consult's working copy goes with its record, so nothing under the consult store outlives the branch
        if (this.ephemeral?.consult?.copyPath) removeConsultCopyPath(this.ephemeral.consult.copyPath);
      } else if (file) rmSync(file, { force: true });
      // a Claude conversation's engine-side title has no home left once the conversation is gone
      if (this.harness === "claude") removeClaudeChatTitle(sessionId);
      removePipelineSession(sessionId);
      if (registry.get(sessionId) === this) registry.delete(sessionId);
    })();
    this.removePromise = done;
    closing.set(this.sessionId, done);
    const settle = () => { if (closing.get(this.sessionId) === done) closing.delete(this.sessionId); };
    done.then(settle, settle);
    await done;
  }

  /**
   * Raise an ephemeral branch to a mode's own session. The close waits for pi's process to be really gone: a
   * pi that will not exit inside the grace is forced down and the promotion is refused, so the record is never
   * moved out from under a live writer. The branch's cwd falls back to the target workspace when it is gone.
   */
  async promote(opts: { mode?: string } = {}): Promise<PromotionResult> {
    const rec = this.ephemeral;
    if (!rec) throw new ConversationRefused("エフェメラルな枝ではありません", 409);
    const modeName = opts.mode ?? rec.mode;
    let modes: Record<string, SessionMode> = {};
    try { modes = readModes(); } catch (err) { throw new ConversationRefused(err instanceof Error ? err.message : String(err), 400); }
    const mode = modes[modeName];
    if (!mode) throw new ConversationRefused(`config/modes.yaml に "${modeName}" がありません`, 404);
    let plan: ModeStartPlan;
    try { plan = modePlan(mode); } catch (err) { throw new ConversationRefused(err instanceof Error ? err.message : String(err), 400); }
    // the branch's own role, not the mode's: the mode's role may have become Claude Code since the branch was
    // cut, and a pi branch promoted with a Claude role's plan would move its record into that role's empty agent
    // dir (a relative sessions/) and remember the wrong role, losing the history on the next open
    let branchRole: RolePreset;
    try { branchRole = resolveRole(rec.role); } catch { branchRole = plan.role; }
    const droppedQueue = this.droppedQueue();
    promoting.add(this.sessionId);
    try {
      const exited = await this.requestClose(promoteExitTimeoutMs());
      if (!exited) throw new ConversationRefused("pi が終わらなかったので格上げできません", 409, { droppedQueue });
      if (this.harness === "claude" || rec.claudeForkOf !== undefined) {
        // the Claude record already lives in the chat config dir; the promoted session keeps its id and place
        const cwd = isWithin(mode.workspace, this.cwd) && existsSync(this.cwd) ? this.cwd : mode.workspace;
        if (cwd !== this.cwd) throw new ConversationRefused("Claude の枝の記録を移せない場所です", 409);
        const branch = planForRole(mode, branchRole, cwd);
        removeEphemeralBranch(this.sessionId);
        recordConversationSession(this.sessionId, mode, branch);
        const place = rec.spaceWorkspace && isWithin(rec.spaceWorkspace, cwd) ? rec.spaceWorkspace : mode.workspace;
        if (rec.space) setSessionMark(place, this.sessionId, { space: rec.space }, { onUnreadable: "skip" });
        return {
          id: this.sessionId, mode: mode.name, cwd, role: branchRole.name, tools: branch.toolNames, droppedQueue,
          sessionFile: claudeRecordPath(conversationClaudeConfigDir(), cwd, this.sessionId),
        };
      }
      const from = ephemeralSessionFile(this.sessionId);
      if (!from) throw new ConversationRefused("枝の記録がありません", 409);
      // a branch's cwd is kept when it already sits under the target workspace; a cwd outside it falls back to
      // the workspace, so a promoted record's place and its header cwd always agree
      const cwd = isWithin(mode.workspace, this.cwd) && existsSync(this.cwd) ? this.cwd : mode.workspace;
      // the branch's own pi role decides where the record lands and what the spawn record says; the mode's role
      // may be Claude Code now, so fall back to the branch's held role, which is always this pi branch's role
      const piPlan = planForRole(mode, branchRole.harness === "pi" ? branchRole : this.role, cwd);
      const targetDir = piSessionDir(cwd, piPlan.agentDir);
      mkdirSync(targetDir, { recursive: true });
      const to = join(targetDir, basename(from));
      const lines = readFileSync(from, "utf8").split("\n");
      const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      lines[0] = JSON.stringify({ ...header, cwd });
      writeFileSync(to, lines.join("\n"), "utf8");
      rmSync(from, { force: true });
      removeEphemeralBranch(this.sessionId);
      // the consult mark is gone with the branch record, so its working copy has no owner left
      if (rec.consult?.copyPath) removeConsultCopyPath(rec.consult.copyPath);
      recordPipelineSession(this.sessionId, {
        slot: `mode:${mode.name}`,
        role: piPlan.role.name,
        model: piPlan.role.model,
        agentDir: piPlan.agentDir,
        thinkingLevel: piPlan.thinkingLevel,
        cwd,
      });
      // the branch carried its space on its own record; the promoted session's mark is where it lives now.
      // The branch's own workspace is kept when the promoted cwd is still under it, so the id keeps referring to
      // the spaces dir it was minted in; otherwise it falls back to the target mode's workspace.
      const place = rec.spaceWorkspace && isWithin(rec.spaceWorkspace, cwd) ? rec.spaceWorkspace : mode.workspace;
      if (rec.space) setSessionMark(place, this.sessionId, { space: rec.space }, { onUnreadable: "skip" });
      // the copied history carries the branch's instructions: the new session's mark must answer with that type
      if (rec.type && mode.types?.[rec.type]) setSessionMark(place, this.sessionId, { type: rec.type }, { onUnreadable: "skip" });
      return { id: this.sessionId, mode: mode.name, cwd, role: piPlan.role.name, tools: piPlan.toolNames, droppedQueue, sessionFile: to };
    } finally {
      promoting.delete(this.sessionId);
    }
  }

  /** an unread, idle conversation with no queue is closed after the idle window */
  maybeAutoClose(now = Date.now()): boolean {
    const phase = this.machine.state.phase;
    if (this.exitRun) return false;
    if (phase !== "idle" && phase !== "closed") return false;
    if (this.readerCount > 0 || this.hasQueue || this.isStreaming) return false;
    if (now - this.lastActivity < conversationIdleMs()) return false;
    void this.close();
    return true;
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }
}

// ---- the model candidates, the notices, and the registry ----

/** pi's own model definition, as far as the engine reads it */
interface PiModelInfo {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  input?: unknown;
  reasoning?: unknown;
}

/** pi's accepted models keyed by `provider/modelId`; an empty map when pi will not answer its own list */
async function piAvailableModels(proc: RpcChild): Promise<Map<string, PiModelInfo>> {
  const out = new Map<string, PiModelInfo>();
  try {
    const res = await proc.call<{ models?: unknown }>("get_available_models");
    if (!Array.isArray(res.models)) return out;
    for (const raw of res.models) {
      if (!raw || typeof raw !== "object") continue;
      const info = raw as PiModelInfo;
      if (typeof info.provider !== "string" || typeof info.id !== "string") continue;
      out.set(`${info.provider}/${info.id}`, info);
    }
  } catch { /* an older pi has no such rpc: only the current model can be offered */ }
  return out;
}

/** only the capabilities pi's definition names: image input and reasoning (DEC-118-2) */
function capabilitiesOf(info: PiModelInfo | undefined): ("image" | "reasoning")[] {
  const out: ("image" | "reasoning")[] = [];
  if (Array.isArray(info?.input) && info.input.includes("image")) out.push("image");
  if (info?.reasoning === true) out.push("reasoning");
  return out;
}

function compareModels(a: ConversationModelOption, b: ConversationModelOption): number {
  return a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
}

/**
 * Every model name the config holds: each role's model after the gateway's read, and every model the user's
 * `models.json` defines. Either source may be unreadable; that source simply contributes no names (DEC-118-1).
 */
export function configuredModelNames(): string[] {
  const names = new Set<string>();
  try {
    for (const role of Object.values(readRoles().roles)) {
      // a Claude role's model is a Claude Code alias, not a pi model (C-163-12)
      if (role.harness !== "pi") continue;
      if (typeof role.model === "string" && role.model) names.add(role.model);
    }
  } catch { /* the roles file is unreadable; the user's models may still be read */ }
  try {
    const path = join(userAgentDir(), "models.json");
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { providers?: Record<string, { models?: { id?: unknown }[] }> };
      for (const [provider, value] of Object.entries(parsed.providers ?? {})) {
        for (const model of value?.models ?? []) {
          if (typeof model?.id === "string" && model.id) names.add(`${provider}/${model.id}`);
        }
      }
    }
  } catch { /* a models.json the engine cannot read contributes no names */ }
  return [...names];
}

/** whether a model name is one a pi conversation can run: a `provider/modelId` the config knows */
function isPiModelName(model: string): boolean {
  if (!model.includes("/")) return false;
  try { return configuredModelNames().includes(model); } catch { return false; }
}

/** the notices, with their decision walled off: a failure to decide never fails a door (DEC-118-4) */
function safeNotices(usage: ContextUsage | null | undefined, model: string | undefined, harness: "pi" | "claude" = "pi"): ConversationNotice[] {
  try { return conversationNotices(usage, model, harness); } catch { return []; }
}

/**
 * The warnings the input's top edge shows. A context notice comes from pi's own percentage past the engine's
 * threshold; a quota notice from the Claude windows at or past the lane's stop line, for a Claude conversation
 * or one whose model is Claude's (DEC-118-4, C-163-14).
 */
export function conversationNotices(usage: ContextUsage | null | undefined, model: string | undefined, harness: "pi" | "claude" = "pi"): ConversationNotice[] {
  const notices: ConversationNotice[] = [];
  if (usage && typeof usage.percent === "number" && usage.percent >= CONTEXT_NOTICE_PERCENT) {
    notices.push({ kind: "context", percent: usage.percent });
  }
  const claude = harness === "claude" || (model ? splitModel(model).provider === "anthropic" : false);
  if (claude) {
    let configDir: string | undefined;
    try { configDir = harness === "claude" ? conversationClaudeConfigDir() : undefined; } catch { configDir = undefined; }
    notices.push(...claudeQuotaNotices(configDir));
  }
  return notices;
}

/** the Claude windows a new lane would not start on, as the composer's notices */
function claudeQuotaNotices(configDir?: string): ConversationNotice[] {
  let stop: Record<string, number>;
  try { stop = readRoles().defaults.claudeQuotaStop; } catch { return []; }
  const view = claudeQuotaView(Date.now(), configDir);
  if (!view) return [];
  const notices: ConversationNotice[] = [];
  if (view.rejected) {
    notices.push({ kind: "quota", provider: "claude", window: "five_hour", label: "枠が断られています", utilization: 1, rejected: true });
  }
  for (const window of view.windows) {
    const line = stop[window.name];
    if (line === undefined || window.utilization < line) continue;
    notices.push({
      kind: "quota", provider: "claude", window: window.name, label: window.label, utilization: window.utilization,
      ...(window.resets ? { resets: window.resets } : {}),
    });
  }
  return notices;
}

// ---- the registry: one pi per session, in memory only ----

const registry = new Map<string, Conversation>();
const starting = new Map<string, Promise<Conversation>>();
/** the close or delete in flight for a session id; an open for that id waits on it before starting pi */
const closing = new Map<string, Promise<void>>();
/** a promotion in flight for a session id: an open for that id is refused rather than racing the record move */
const promoting = new Set<string>();
let sweeper: ReturnType<typeof setInterval> | null = null;

const CLOSE_EXIT_TIMEOUT_MS = 5000;
/** the branch sweeper's default interval; branches are kept for days, so an hour is often enough */
const DEFAULT_EPHEMERAL_SWEEP_MS = 60 * 60 * 1000;
/** promotion needs to know pi is really gone before moving its record, so it waits longer than a close */
const PROMOTE_EXIT_TIMEOUT_MS = 20_000;
/** how long a context-stats question may take before the open door gives up and reports no figures */
const CONTEXT_STATS_TIMEOUT_MS = 1500;

/** `promise`, but rejected once `ms` has passed; the timer never keeps the process alive */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function ensureSweeper(): void {
  if (sweeper) return;
  // a fixed, short tick: the idle window itself is read per conversation, so a test that shortens it does not
  // have to wait for a tick set up by an earlier conversation
  sweeper = setInterval(() => {
    for (const conv of [...registry.values()]) conv.maybeAutoClose();
    if (registry.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 250);
  sweeper.unref?.();
}

// ---- ephemeral branches: old ones are swept while the engine runs, never at module load ----

let ephemeralSweeper: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/** how often the branch sweeper runs; a test shortens it through the environment */
export function ephemeralSweepMs(): number {
  const raw = Number(process.env.IDD_EPHEMERAL_SWEEP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EPHEMERAL_SWEEP_MS;
}

/**
 * Start the branch sweeper from the engine's start, independent of whether any conversation is open. It runs
 * once right away without holding the start up, then every interval. A run that has not finished yet is
 * never overlapped, and one branch's read failure never stops the others.
 */
export function startEphemeralSweeper(onSweep?: () => unknown | Promise<unknown>): void {
  if (ephemeralSweeper) return;
  const run = (): void => {
    if (sweeping) return;
    sweeping = true;
    void sweepEphemeralBranches()
      .catch(() => { /* keep sweeping */ })
      // the consult reconciler rides the same pass: the branch store and the ledger are read together
      .then(() => (onSweep ? Promise.resolve(onSweep()).catch(() => { /* keep sweeping */ }) : undefined))
      .finally(() => { sweeping = false; });
  };
  run();
  ephemeralSweeper = setInterval(run, ephemeralSweepMs());
  ephemeralSweeper.unref?.();
}

/** stop the branch sweeper (a test that shortened the interval uses it) */
export function stopEphemeralSweeper(): void {
  if (!ephemeralSweeper) return;
  clearInterval(ephemeralSweeper);
  ephemeralSweeper = null;
}

/** a branch the engine is opening, holding open or promoting is not swept */
function branchBusy(sessionId: string): boolean {
  return registry.has(sessionId) || starting.has(sessionId) || promoting.has(sessionId);
}

/**
 * delete branches untouched past the retention window; a branch that is open, opening or being promoted is
 * never deleted, and a branch that opens after the age check is skipped too. The removal rides the same gate
 * a close uses, so an open that arrives while it runs waits it out and is refused with no record left.
 */
export async function sweepEphemeralBranches(now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  const retention = ephemeralRetentionMs();
  const records = await listEphemeralRecordsAsync();
  for (const rec of records) {
    if (branchBusy(rec.sessionId)) continue;
    const last = Math.max(Date.parse(rec.updatedAt) || 0, await ephemeralSessionMtimeAsync(rec.sessionId));
    if (now - last < retention) continue;
    // the branch may have opened while its record and mtime were read
    if (branchBusy(rec.sessionId)) continue;
    const inflight = closing.get(rec.sessionId);
    if (inflight) { await inflight; continue; }
    const removal = removeEphemeralBranchAsync(rec.sessionId).then(() => {
      if (rec.consult?.copyPath) removeConsultCopyPath(rec.consult.copyPath);
    });
    closing.set(rec.sessionId, removal);
    const settle = (): void => { if (closing.get(rec.sessionId) === removal) closing.delete(rec.sessionId); };
    removal.then(settle, settle);
    await removal;
    removed.push(rec.sessionId);
  }
  // a copy no consult record points at is an orphan from a refused open or a half-done close
  sweepConsultCopies(new Set(records.filter((rec) => rec.consult).map((rec) => rec.sessionId)));
  return removed;
}

/** the conversations the engine holds open, for the ownership question and the tests */
export function openConversations(): Conversation[] {
  return [...registry.values()];
}

/** one conversation the engine holds or is working on, as the reload card lists it */
export interface OpenConversationSummary {
  sessionId: string;
  title: string;
  mode?: string;
}

/** the last thing penne said in a session's record, or its id when the record cannot be read yet */
function conversationTitleOf(conv: Conversation): string {
  try {
    const material = conv.titleMaterialText();
    const said = material.split("\n").filter((line) => line.startsWith("利用者: ")).pop();
    const text = said?.slice("利用者: ".length).replace(/\s+/g, " ").trim();
    if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  } catch {
    // fall back to the id below
  }
  return conv.sessionId;
}

/**
 * Every conversation the engine holds or is working on: open, opening, closing, or being promoted. The reload's
 * judgment and its card read this; the list is what penne sees before deciding to close them.
 */
export function openConversationSummaries(): OpenConversationSummary[] {
  const out = new Map<string, OpenConversationSummary>();
  for (const conv of registry.values()) {
    out.set(conv.sessionId, { sessionId: conv.sessionId, title: conversationTitleOf(conv), mode: conv.mode.name });
  }
  for (const id of [...starting.keys(), ...closing.keys(), ...promoting]) {
    if (out.has(id)) continue;
    const mode = conversationModeOf(id);
    out.set(id, { sessionId: id, title: id, ...(mode ? { mode: mode.name } : {}) });
  }
  return [...out.values()];
}

/** how many conversations the engine holds or is working on (the reload waits for this to be 0) */
export function openConversationCount(): number {
  return new Set<string>([...registry.keys(), ...starting.keys(), ...closing.keys(), ...promoting]).size;
}

/**
 * Close every conversation the engine holds, with the same close a person's click uses, and wait for each pi to be
 * gone. A conversation the close refuses is skipped so the rest still close. The record is kept, so nothing said is
 * lost; the queued items and the half-answered prompt are (DEC-1728).
 */
export async function closeAllConversations(): Promise<string[]> {
  const closed: string[] = [];
  for (const conv of [...registry.values()]) {
    closed.push(conv.sessionId);
    try {
      await conv.close();
    } catch {
      // one close's failure never stops the others; the reload's check sees whatever remains
    }
  }
  return closed;
}

/** whether the engine itself is running this session's pi right now */
export function isEngineConversationOpen(sessionId: string): boolean {
  return registry.has(sessionId) || starting.has(sessionId);
}

export function conversationIfOpen(sessionId: string): Conversation | undefined {
  return registry.get(sessionId);
}

/** the mode whose workspace holds this session's cwd, read from pi's record; undefined when it is not a mode's session */
export function modeForSession(sessionId: string): SessionMode | undefined {
  if (!CONVERSATION_SESSION_ID.test(sessionId)) return undefined;
  const file = resolveSessionFile(sessionId);
  if (!file) return undefined;
  const header = readHeader(file);
  if (!header?.cwd) return undefined;
  return modeForCwd(header.cwd, safeModes(), sessionId);
}

/** the mode a session was made for, from the spawn record (a conversation not yet sent to has no record file) */
function modeFromRecord(sessionId: string): SessionMode | undefined {
  return spawnModeForSession(sessionId);
}

/** the mode behind a session id: its record's cwd first, then the spawn record; the marks door uses this */
export function conversationModeOf(sessionId: string): SessionMode | undefined {
  return modeForSession(sessionId) ?? modeFromRecord(sessionId);
}

/**
 * The workspace whose marks file holds a session's marks, resolved by the one place rule. The marks door and the
 * engine's own writes both use this, so a pin, a bookmark and a space membership land in the same file.
 */
export function conversationMarksWorkspace(sessionId: string): string | undefined {
  const mode = conversationModeOf(sessionId);
  if (!mode) return undefined;
  const file = resolveSessionFile(sessionId);
  const cwd = conversationCwd(mode, sessionId, file);
  return placeWorkspaceFor(sessionId, cwd, mode, safeModes());
}

/**
 * The one workspace whose marks file holds a session's marks. The workspaces that contain the session's cwd are
 * walked deep to shallow and the first file that holds this session wins; a session with no mark yet goes to the
 * mode it was spawned in, and to its own mode when the spawn record is absent or its workspace does not contain
 * the cwd. Every read and write of a session's marks goes through this, so one session's marks never split
 * across two files and a nested layout does not read the outer mark from the wrong place.
 */
function placeWorkspaceFor(
  sessionId: string,
  cwd: string,
  mode: SessionMode,
  modes: Record<string, SessionMode>,
  readMarksAt: (workspace: string) => MarksFile = readMarks,
): string {
  const seen = new Set<string>();
  for (const candidate of candidateModes(cwd, modes)) {
    const key = comparablePath(candidate.workspace);
    if (seen.has(key)) continue;
    seen.add(key);
    if (readMarksAt(candidate.workspace).sessions[sessionId]) return candidate.workspace;
  }
  const created = spawnModeForSession(sessionId);
  if (created && isWithin(created.workspace, cwd)) return created.workspace;
  return mode.workspace;
}

/**
 * The cwd a conversation opens with: the record's own cwd, then the spawn record's (a conversation made but
 * never sent to has no pi record), then the mode's workspace. The order is what keeps an unspent workdir
 * across an engine restart.
 */
function conversationCwd(mode: SessionMode, sessionId: string, file: string | null): string {
  if (file) {
    const header = readHeader(file);
    if (header?.cwd) return header.cwd;
  }
  try {
    const rec = readPipelineSession(sessionId);
    if (rec?.cwd) return rec.cwd;
  } catch { /* no record */ }
  return mode.workspace;
}

/** the config dir a conversation's Claude Code runs in: its own place, never the lane's and never penne's own */
export function conversationClaudeConfigDir(): string {
  return readRoles().defaults.claudeChatConfigDir;
}

/** the Claude Code binary a conversation runs; a test points it at a stand-in */
function claudeBinary(): string {
  const raw = process.env.IDD_CLAUDE_BIN?.trim();
  return raw || "claude";
}

/** the plan values a mode starts with, without preparing the agent dir (that runs in a child) */
function modePlan(mode: SessionMode): ModeStartPlan {
  const role = resolveRole(mode.role);
  if (role.harness === "claude") {
    if (!existsSync(mode.workspace)) throw new Error(`modes.${mode.name}: workspace がありません: ${mode.workspace}`);
    return planForRole(mode, role, mode.workspace);
  }
  return planModeStart(mode.name, { prepareAgentDir: (role) => pipelineAgentDir(role) });
}

/** the start plan for one role, whether it runs pi or Claude Code; a Claude role carries no pi agent dir */
function planForRole(mode: SessionMode, role: RolePreset, cwd: string): ModeStartPlan {
  const pi = role.harness === "pi";
  return {
    mode, role, cwd,
    toolNames: role.tools.length ? [...role.tools] : ["read"],
    initialModel: pi ? splitModel(role.model) : { provider: "", modelId: "" },
    thinkingLevel: role.thinking as ModeStartPlan["thinkingLevel"],
    agentDir: pi ? pipelineAgentDir(role) : "",
  };
}

/**
 * The role a session actually started on. A conversation that switched harness before its first message keeps
 * its record and opens on the same route; the mode's own role is the fallback when the record is absent or names
 * a role the config no longer holds.
 */
function roleForSession(sessionId: string, mode: SessionMode): RolePreset {
  try {
    const rec = readPipelineSession(sessionId);
    if (rec?.role) return resolveRole(rec.role);
  } catch { /* the mode's role answers */ }
  return resolveRole(mode.role);
}

/** a Claude conversation refuses to start without a login in its own config dir, with the login steps */
function requireClaudeChatLogin(role: RolePreset): void {
  if (role.harness !== "claude") return;
  try {
    checkClaudeConfigDir(conversationClaudeConfigDir());
  } catch (err) {
    throw new ConversationRefused(err instanceof Error ? err.message : String(err), 409);
  }
}

/** remember the route a conversation started on, so a reopen runs the same harness (C-163-9) */
function recordConversationSession(sessionId: string, mode: SessionMode, plan: ModeStartPlan): void {
  if (plan.role.harness === "claude") {
    // a Claude conversation has no pi agent dir; its record lives in the chat config dir, which Claude Code owns
    writePipelineSession({
      session_id: sessionId,
      slot: `mode:${mode.name}`,
      role: plan.role.name,
      model: plan.role.model,
      agent_dir: "",
      thinking: plan.role.thinking,
      spawned_at: new Date().toISOString(),
      cwd: plan.cwd,
      harness: "claude",
      claude_session_id: sessionId,
    });
    return;
  }
  recordPipelineSession(sessionId, {
    slot: `mode:${mode.name}`,
    role: plan.role.name,
    model: plan.role.model,
    agentDir: plan.agentDir,
    thinkingLevel: plan.thinkingLevel,
    cwd: plan.cwd,
  });
}

/** a branch's plan: the mode's identity, but the branch's own role, cwd and tools */
function branchPlan(mode: SessionMode, role: RolePreset, cwd: string, tools: string[]): ModeStartPlan {
  const plan = planForRole(mode, role, cwd);
  return { ...plan, toolNames: tools.length ? [...tools] : ["read"] };
}

export interface CreateConversationOptions {
  /** a path under the mode's workspace to run in; made when missing, refused when it would leave the workspace */
  workdir?: string;
  /** the id of a space in the mode's workspace to put the session in (the cwd is not changed) */
  space?: string;
  /** the type to start on; omitted means the mode's default, and refused for a mode without types */
  type?: string;
}

/** create a conversation for a mode; pi is started at once and the session id is ours */
export async function createConversation(modeName: string, opts: CreateConversationOptions = {}): Promise<Conversation> {
  let mode: SessionMode | undefined;
  try {
    mode = readModes()[modeName];
  } catch (err) {
    throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400);
  }
  if (!mode) throw new ConversationRefused(`config/modes.yaml に "${modeName}" がありません`, 404);
  // the space is checked before pi starts: an unknown one is the caller's refusal, not a half-made session
  if (opts.space !== undefined && !readSpace(mode.workspace, opts.space)) {
    throw new ConversationRefused(`スペースがありません: ${opts.space}`, 400);
  }
  // the type is checked before pi starts too: an unknown one, a type for a type-less mode, or one whose files are
  // missing must not leave a running pi and an empty conversation behind
  if (opts.type !== undefined) {
    if (!mode.types) throw new ConversationRefused(`mode "${modeName}" は型を持ちません`, 400);
    const target = mode.types[opts.type];
    if (!target) throw new ConversationRefused(`知らない型です: ${opts.type}`, 400);
    if (!existsSync(target.dir) || !statSync(target.dir).isDirectory()) throw new ConversationRefused(`型の置き場がありません: ${target.dir}`, 409);
    if (target.operations && (!existsSync(target.operations) || !statSync(target.operations).isFile())) throw new ConversationRefused(`運用のファイルがありません: ${target.operations}`, 409);
  }
  // a membership or a type has to be writable before pi starts: a marks file the engine cannot read would
  // otherwise leave a running pi and no mark. The check refuses the create (and moves a broken file aside)
  if (opts.space || opts.type !== undefined) assertMarksWritable(mode.workspace);
  let plan: ModeStartPlan;
  try {
    plan = modePlan(mode);
  } catch (err) {
    throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400);
  }
  // a type instruction rides pi's extension; a Claude conversation has no port to add it without a turn,
  // and `setType` is refused for it, so a type must not be chosen when the mode's role is Claude
  if (opts.type !== undefined && plan.role.harness === "claude") throw new ConversationRefused("Claude の会話は型を持ちません", 409);
  requireClaudeChatLogin(plan.role);
  let workdir = "";
  if (opts.workdir !== undefined) {
    const resolved = resolveWorkdir(mode.workspace, opts.workdir);
    workdir = resolved.workdir;
    plan = { ...plan, cwd: resolved.cwd };
  }
  const sessionId = randomUUID();
  const conv = new Conversation({ sessionId, mode, plan, isNew: true, workdir, ...(opts.space !== undefined ? { space: opts.space } : {}), ...(opts.type !== undefined ? { type: opts.type } : {}) });
  registry.set(sessionId, conv);
  ensureSweeper();
  try {
    await conv.open();
  } catch (err) {
    // a pi that never started leaves no conversation behind
    registry.delete(sessionId);
    await conv.close();
    throw new ConversationRefused(`pi を起こせません: ${String(err instanceof Error ? err.message : err)}`, 500);
  }
  // the record is written only once pi is up: the existing GUI reads it to find the role's agent dir. The cwd
  // rides along so a conversation nobody has sent to yet opens in the same place after a restart.
  recordConversationSession(sessionId, mode, plan);
  // the membership is written after pi is up, so a start that failed leaves no mark behind. The writability was
  // checked before the start; a file that breaks in between is the engine's own write and is skipped, not fatal
  if (opts.space) setSessionMark(mode.workspace, sessionId, { space: opts.space }, { onUnreadable: "skip" });
  // the type's mark is written the same way; the instruction itself is added through the one delivery path
  if (opts.type !== undefined) setSessionMark(mode.workspace, sessionId, { type: opts.type }, { onUnreadable: "skip" });
  conv.acceptSpaceMark();
  return conv;
}

/** open a conversation the engine may hold: a mode's session, never a lane's */
export function openConversation(sessionId: string): Promise<Conversation> {
  const existing = registry.get(sessionId);
  if (existing && !existing.isClosed) return Promise.resolve(existing);
  const pending = starting.get(sessionId);
  if (pending) return pending;
  const promise = openConversationInternal(sessionId).finally(() => { starting.delete(sessionId); });
  starting.set(sessionId, promise);
  return promise;
}

async function openConversationInternal(sessionId: string): Promise<Conversation> {
  if (!CONVERSATION_SESSION_ID.test(sessionId)) throw new ConversationRefused("session id の形が不正です", 400);
  // a close or a delete for this id may still be stopping an older pi: wait it out, so one session never has
  // two engine pi writers (a delete that wins leaves no record, and the open below is refused)
  const inflight = closing.get(sessionId);
  if (inflight) await inflight;
  if (promoting.has(sessionId)) throw new ConversationRefused("格上げ中です", 409);
  const reopened = registry.get(sessionId);
  if (reopened && !reopened.isClosed) return reopened;
  if (isSupervisedPipelineSession(sessionId)) throw new ConversationRefused("engine の lane の session は会話の口から開けません", 409);
  // a branch's record lives outside the mode's place, so it is checked before any mode's session lookup
  const ephemeral = readEphemeralRecord(sessionId);
  if (ephemeral) return openEphemeralConversation(ephemeral);
  const file = resolveSessionFile(sessionId);
  // a mode's session is found by its record's cwd; one made but never sent to has no file, so its spawn record names the mode
  const mode = modeForSession(sessionId) ?? modeFromRecord(sessionId);
  if (!mode) throw new ConversationRefused("mode の session ではありません", 404);
  const cwd = conversationCwd(mode, sessionId, file);
  // the cwd decides where pi runs and where its record lives; a workdir that is gone is refused rather than
  // silently moved to the workspace, and one outside the workspace is not a conversation this engine may hold
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ConversationRefused(`cwd がありません: ${cwd}`, 409);
  if (!isWithin(mode.workspace, cwd)) throw new ConversationRefused("cwd が workspace の外です", 409);
  const plan = planForRole(mode, roleForSession(sessionId, mode), cwd);
  requireClaudeChatLogin(plan.role);
  const createdAt = file ? statSync(file).mtime : new Date();
  const conv = new Conversation({ sessionId, mode, plan, isNew: !file, createdAt });
  registry.set(sessionId, conv);
  ensureSweeper();
  try {
    await conv.open();
  } catch (err) {
    registry.delete(sessionId);
    await conv.close();
    throw new ConversationRefused(`pi を起こせません: ${String(err instanceof Error ? err.message : err)}`, 500);
  }
  return conv;
}

/** open a previously cut branch from its config record; no model is passed, so pi resumes the record's own values */
async function openEphemeralConversation(rec: EphemeralRecord): Promise<Conversation> {
  // a reconciled consult is spent: it still promotes and deletes, but no talk goes on in it
  if (rec.consult?.closedAt) throw new ConversationRefused("この相談は閉じています", 409);
  let modes: Record<string, SessionMode> = {};
  try { modes = readModes(); } catch (err) { throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400); }
  const mode = modes[rec.mode];
  if (!mode) throw new ConversationRefused(`枝の mode "${rec.mode}" が config/modes.yaml にありません`, 404);
  let role: RolePreset;
  try { role = resolveRole(rec.role); } catch (err) { throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400); }
  if (!existsSync(rec.cwd)) throw new ConversationRefused(`枝の cwd がありません: ${rec.cwd}`, 409);
  const tools = rec.tools.length ? [...rec.tools] : ["read"];
  const conv = new Conversation({
    sessionId: rec.sessionId, mode, plan: branchPlan(mode, role, rec.cwd, tools), isNew: false,
    createdAt: new Date(rec.createdAt), tools, ephemeral: rec,
  });
  registry.set(rec.sessionId, conv);
  ensureSweeper();
  try {
    await conv.open();
  } catch (err) {
    registry.delete(rec.sessionId);
    await conv.close();
    throw new ConversationRefused(`pi を起こせません: ${String(err instanceof Error ? err.message : err)}`, 500);
  }
  return conv;
}

/**
 * Build a branch's conversation without waking pi. A branch whose cwd is gone still promotes and deletes,
 * so the plan keeps the record's cwd and lets the promotion fall back to the target workspace.
 */
function branchConversationFromRecord(rec: EphemeralRecord): Conversation | undefined {
  const mode = safeModes()[rec.mode];
  if (!mode) return undefined;
  let role: RolePreset;
  try { role = resolveRole(rec.role); } catch { return undefined; }
  const tools = rec.tools.length ? [...rec.tools] : ["read"];
  return new Conversation({
    sessionId: rec.sessionId, mode, plan: branchPlan(mode, role, rec.cwd, tools), isNew: false,
    createdAt: new Date(rec.createdAt), tools, ephemeral: rec,
  });
}

/**
 * The conversation a record change acts on. An open one is used as is; a closed branch is built from its
 * record so the delete or the promotion neither wakes pi nor needs the branch's cwd to exist.
 */
function conversationForRecordChange(sessionId: string): Conversation | undefined {
  const existing = registry.get(sessionId);
  if (existing && !existing.isClosed) return existing;
  const rec = readEphemeralRecord(sessionId);
  if (!rec) return undefined;
  return existing ?? branchConversationFromRecord(rec);
}

/** delete a conversation's records; a branch that is not held is removed without waking pi */
export async function removeConversationById(sessionId: string): Promise<void> {
  const held = conversationForRecordChange(sessionId);
  if (held) {
    await held.remove();
    return;
  }
  if (readEphemeralRecord(sessionId)) {
    removeEphemeralBranch(sessionId);
    removePipelineSession(sessionId);
    if (registry.get(sessionId)) registry.delete(sessionId);
    return;
  }
  const conv = await openConversation(sessionId);
  await conv.remove();
}

/** raise a branch; a branch that is not held is promoted without waking pi */
export async function promoteConversationById(sessionId: string, opts: { mode?: string } = {}): Promise<PromotionResult> {
  const held = conversationForRecordChange(sessionId);
  if (held) return held.promote(opts);
  return (await openConversation(sessionId)).promote(opts);
}
interface ForkParent {
  /** the parent's own record file; a pi record for a pi parent, a Claude Code record for a Claude parent */
  file: string;
  /** which harness the parent runs, decided by its role: the branch follows it */
  harness: "pi" | "claude";
  mode: string;
  modeObject: SessionMode;
  role: string;
  cwd: string;
  tools: string[];
  /** the parent's space, so a branch can carry the same context without a mark of its own */
  space?: string;
  /** the workspace the parent's space id belongs to, so the branch reads the right spaces dir */
  spaceWorkspace?: string;
  /** the parent's conversation type, carried onto the branch's record because a branch has no mark */
  type?: string;
}

function resolveForkParent(parentId: string): ForkParent {
  const open = registry.get(parentId);
  if (open && !open.isClosed) {
    const file = open.sessionFile();
    if (!file) throw new ConversationRefused("親の記録がまだありません", 409);
    const space = open.spaceId();
    const spaceWorkspace = space ? placeWorkspaceFor(parentId, open.cwd, open.mode, safeModes()) : undefined;
    return {
      file, harness: open.harness, mode: open.mode.name, modeObject: open.mode, role: open.role.name, cwd: open.cwd, tools: [...open.tools],
      ...(space ? { space, ...(spaceWorkspace ? { spaceWorkspace } : {}) } : {}),
      ...(open.wantType ? { type: open.wantType } : {}),
    };
  }
  const ephemeral = readEphemeralRecord(parentId);
  if (ephemeral) {
    let role: RolePreset;
    try { role = resolveRole(ephemeral.role); } catch (err) { throw new ConversationRefused(String(err instanceof Error ? err.message : err), 404); }
    const modeObject = safeModes()[ephemeral.mode];
    if (!modeObject) throw new ConversationRefused(`親の mode "${ephemeral.mode}" がありません`, 404);
    const claude = role.harness === "claude" || ephemeral.claudeForkOf !== undefined;
    const file = claude ? claudeRecordPath(conversationClaudeConfigDir(), ephemeral.cwd, parentId) : ephemeralSessionFile(parentId);
    if (!file || !existsSync(file)) throw new ConversationRefused("親の枝の記録がありません", 409);
    return {
      file, harness: claude ? "claude" : "pi", mode: ephemeral.mode, modeObject, role: ephemeral.role, cwd: ephemeral.cwd,
      tools: ephemeral.tools.length ? ephemeral.tools : ["read"],
      ...(ephemeral.space ? { space: ephemeral.space, ...(ephemeral.spaceWorkspace ? { spaceWorkspace: ephemeral.spaceWorkspace } : {}) } : {}),
      ...(ephemeral.type ? { type: ephemeral.type } : {}),
    };
  }
  const mode = modeForSession(parentId) ?? modeFromRecord(parentId);
  if (!mode) throw new ConversationRefused("mode の session ではありません", 404);
  let sessionRole: RolePreset;
  try {
    const rec = readPipelineSession(parentId);
    sessionRole = resolveRole(rec?.role ?? mode.role);
  } catch (err) {
    throw new ConversationRefused(String(err instanceof Error ? err.message : err), 404);
  }
  // the parent's cwd uses the same order as an open, so a workdir parent's branch runs in that workdir
  const piFile = resolveSessionFile(parentId);
  const cwd = conversationCwd(mode, parentId, piFile);
  const file = sessionRole.harness === "claude" ? claudeRecordPath(conversationClaudeConfigDir(), cwd, parentId) : piFile;
  if (!file || !existsSync(file)) throw new ConversationRefused("親の記録がありません", 409);
  const place = placeWorkspaceFor(parentId, cwd, mode, safeModes());
  const parentMark = readMarks(place).sessions[parentId];
  const membership = parentMark?.space;
  const parentType = effectiveModeType(mode, parentMark?.type);
  return {
    file, harness: sessionRole.harness, mode: mode.name, modeObject: mode, role: sessionRole.name, cwd,
    tools: sessionRole.tools.length ? [...sessionRole.tools] : ["read"],
    ...(membership ? { space: membership, spaceWorkspace: place } : {}),
    ...(parentType ? { type: parentType } : {}),
  };
}

export interface EphemeralForkOptions {
  at: string;
  envelope?: string;
  role?: string;
  cwd?: string;
  tools?: string[];
}

export interface EphemeralForkResult {
  id: string;
  mode: string;
  cwd: string;
  role: string;
  tools: string[];
  parent: string;
  at: string;
  /** the text of the user message the fork point was, when the caller should reword and send it */
  text?: string;
}

/**
 * Cut an ephemeral branch from a parent's record and start its pi. The parent's record is read from the file
 * and never written; the parent's pi is never opened or started. Role, cwd and tools default to the parent's
 * and may be overridden; a role change starts the branch on the new role's model and effort.
 */
export async function createEphemeralFork(parentId: string, opts: EphemeralForkOptions): Promise<EphemeralForkResult> {
  if (!CONVERSATION_SESSION_ID.test(parentId)) throw new ConversationRefused("session id の形が不正です", 400);
  if (!isEntryId(opts.at)) throw new ConversationRefused("entry id の形が不正です", 400);
  if (isSupervisedPipelineSession(parentId)) throw new ConversationRefused("engine の lane の session からは枝を切れません", 409);
  const parent = resolveForkParent(parentId);
  let role: RolePreset;
  try { role = resolveRole(opts.role ?? parent.role); } catch (err) { throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400); }
  const cwd = opts.cwd ?? parent.cwd;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ConversationRefused(`cwd がありません: ${cwd}`, 400);
  const tools = opts.tools !== undefined ? (opts.tools.length ? [...opts.tools] : ["read"]) : [...parent.tools];
  const id = randomUUID();
  const now = new Date().toISOString();

  if (parent.harness === "claude") {
    // Claude Code forks the parent itself (`--resume <parent> --fork-session`) and picks the branch's id
    if (role.harness !== "claude") throw new ConversationRefused(`Claude の会話の枝は Claude の role で切ってください: ${role.name}`, 400);
    const rec: EphemeralRecord = {
      sessionId: id, parentSessionId: parentId, at: opts.at, lastEntryId: null,
      mode: parent.mode, role: role.name, cwd, tools, createdAt: now, updatedAt: now, claudeForkOf: parentId,
      ...(parent.space ? { space: parent.space, ...(parent.spaceWorkspace ? { spaceWorkspace: parent.spaceWorkspace } : {}) } : {}),
    };
    writeEphemeralRecord(rec);
    const conv = new Conversation({
      sessionId: id, mode: parent.modeObject, plan: branchPlan(parent.modeObject, role, cwd, tools),
      isNew: false, tools, ephemeral: rec,
    });
    registry.set(id, conv);
    ensureSweeper();
    try {
      await conv.open();
    } catch (err) {
      registry.delete(conv.sessionId);
      await conv.close();
      removeEphemeralBranch(conv.sessionId);
      throw new ConversationRefused(`Claude を起こせません: ${String(err instanceof Error ? err.message : err)}`, 500);
    }
    // Claude Code's own id is the branch's id from here on; the caller gets the id it can reopen
    return { id: conv.sessionId, mode: parent.mode, cwd, role: role.name, tools, parent: parentId, at: opts.at };
  }

  if (role.harness !== "pi") throw new ConversationRefused(`role ${role.name} は pi ではありません`, 400);
  const record = readSessionRecord(parent.file);
  let plan: ReturnType<typeof planFork>;
  try { plan = planFork(record, opts.at); } catch (err) { throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400); }
  const written = writeBranch({ parentFile: parent.file, plan, cwd, id, ...(opts.envelope !== undefined ? { envelope: opts.envelope } : {}) });
  const rec: EphemeralRecord = {
    sessionId: id, parentSessionId: parentId, parentSessionFile: parent.file, at: opts.at, lastEntryId: written.lastEntryId,
    mode: parent.mode, role: role.name, cwd, tools, createdAt: now, updatedAt: now,
    ...(parent.space ? { space: parent.space, ...(parent.spaceWorkspace ? { spaceWorkspace: parent.spaceWorkspace } : {}) } : {}),
    ...(parent.type ? { type: parent.type } : {}),
  };
  writeEphemeralRecord(rec);
  const conv = new Conversation({
    sessionId: id, mode: parent.modeObject, plan: branchPlan(parent.modeObject, role, cwd, tools),
    isNew: role.name !== parent.role, tools, ephemeral: rec,
  });
  registry.set(id, conv);
  ensureSweeper();
  try {
    await conv.open();
  } catch (err) {
    registry.delete(id);
    await conv.close();
    removeEphemeralBranch(id);
    throw new ConversationRefused(`pi を起こせません: ${String(err instanceof Error ? err.message : err)}`, 500);
  }
  return { id, mode: parent.mode, cwd, role: role.name, tools, parent: parentId, at: opts.at, ...(plan.text !== undefined ? { text: plan.text } : {}) };
}

/**
 * Start a consult branch from the envelope the consult module built. A consult is an ephemeral branch with no
 * parent: the record copies no entry and the header carries no `parentSession`, so the lane agent's own words
 * can never reach the consultant. The branch's mode is chat and its role is chat, but its cwd is the consultant's
 * own working copy and its tools are read-only ones chosen by the caller.
 */
export interface ConsultConversationInput {
  id: string;
  envelope: string;
  cwd: string;
  tools: string[];
  consult: ConsultMark;
}

export async function createConsultConversation(input: ConsultConversationInput): Promise<Conversation> {
  let mode: SessionMode | undefined;
  try { mode = readModes()["chat"]; } catch (err) { throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400); }
  if (!mode) throw new ConversationRefused('config/modes.yaml に "chat" がありません', 404);
  let role: RolePreset;
  try { role = resolveRole("chat"); } catch (err) { throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400); }
  if (role.harness !== "pi") throw new ConversationRefused("role chat は pi ではありません", 400);
  const now = new Date().toISOString();
  const written = writeBranch({
    parentFile: "", plan: { header: {}, entries: [] }, cwd: input.cwd, id: input.id,
    envelope: input.envelope, omitParent: true,
  });
  const rec: EphemeralRecord = {
    sessionId: input.id, lastEntryId: written.lastEntryId, mode: mode.name, role: role.name,
    cwd: input.cwd, tools: [...input.tools], createdAt: now, updatedAt: now, consult: input.consult,
  };
  writeEphemeralRecord(rec);
  const conv = new Conversation({
    sessionId: input.id, mode, plan: branchPlan(mode, role, input.cwd, input.tools),
    isNew: true, tools: [...input.tools], ephemeral: rec,
  });
  registry.set(input.id, conv);
  ensureSweeper();
  try {
    await conv.open();
  } catch (err) {
    registry.delete(input.id);
    await conv.close();
    removeEphemeralBranch(input.id);
    throw new ConversationRefused(`pi を起こせません: ${String(err instanceof Error ? err.message : err)}`, 500);
  }
  return conv;
}

// ---- listing: pi's own records, read without starting pi ----

/** the facts a list entry needs from one record; the rest of a large record is never read again */
interface SessionFacts {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  /** the `.md` writes the record's current branch made, newest last, failed ones dropped */
  documentWrites: DocumentWrite[];
  /** pi's own leaf, kept so the open door and the list agree on what a branch is */
  leafId: string | null;
  mtimeMs: number;
  size: number;
}

interface CachedFacts {
  mtimeMs: number;
  size: number;
  facts: SessionFacts | null;
}

/** the summary cache: a record whose mtime and size are unchanged is answered without opening it again */
const factCache = new Map<string, CachedFacts>();

/** read the first line only: a header is small, so the rest of a large record is left on disk */
async function readHeaderAsync(file: string): Promise<SessionHeader | null> {
  let fh;
  try { fh = await open(file, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const at = text.indexOf("\n");
    try { return JSON.parse(at >= 0 ? text.slice(0, at) : text) as SessionHeader; } catch { return null; }
  } finally { await fh.close(); }
}

/**
 * One streaming pass over a record: its name, the write and edit calls the current branch made, and pi's leaf.
 * The parent links are held only for this pass, so the cache keeps a small summary instead of the whole tree.
 * The file is read as a stream, so the event loop returns between lines and a 14 MB record never blocks the engine.
 */
async function readRecordInfoAsync(file: string): Promise<{ name?: string; writes: DocumentWrite[]; leafId: string | null }> {
  let name: string | undefined;
  const parentOf = new Map<string, string | null>();
  const calls: { entryId: string; toolCallId: string; path: string }[] = [];
  const errors = new Map<string, boolean>();
  let leafId: string | null = null;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try { entry = JSON.parse(line) as RawEntry; } catch { continue; }
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) name = entry.name;
      if (typeof entry.id !== "string") continue;
      parentOf.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
      leafId = entry.id;
      const message = entry.message;
      if (entry.type !== "message" || !message) continue;
      if (message.role === "toolResult" && typeof message.toolCallId === "string") errors.set(message.toolCallId, message.isError === true);
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content as unknown[]) {
        if (!block || typeof block !== "object") continue;
        const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (call.type !== "toolCall" || (call.name !== "write" && call.name !== "edit")) continue;
        const args = call.arguments as { path?: unknown } | undefined;
        if (!args || typeof args.path !== "string" || !args.path.trim()) continue;
        calls.push({ entryId: entry.id, toolCallId: typeof call.id === "string" ? call.id : "", path: args.path });
      }
    }
  } catch { /* a read failure keeps what was read so far */ }
  finally { lines.close(); stream.destroy(); }
  const onBranch = new Set<string>();
  let current = leafId;
  while (current && !onBranch.has(current)) { onBranch.add(current); current = parentOf.get(current) ?? null; }
  const writes: DocumentWrite[] = [];
  for (const call of calls) {
    if (!onBranch.has(call.entryId)) continue;
    if (call.toolCallId && errors.get(call.toolCallId) === true) continue;
    writes.push({ path: call.path });
  }
  return { ...(name ? { name } : {}), writes, leafId };
}

/** one record's facts, from what the file's mtime and size say has not changed since the last list */
async function readFacts(file: string): Promise<SessionFacts | null> {
  const key = comparablePath(file);
  let info;
  try { info = await stat(file); } catch { factCache.delete(key); return null; }
  const cached = factCache.get(key);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.facts;
  const header = await readHeaderAsync(file);
  const id = sessionIdOf(file, header);
  let facts: SessionFacts | null = null;
  if (CONVERSATION_SESSION_ID.test(id) && header?.cwd) {
    const recordInfo = await readRecordInfoAsync(file);
    facts = {
      id, cwd: header.cwd,
      createdAt: typeof header.timestamp === "string" ? header.timestamp : info.mtime.toISOString(),
      updatedAt: info.mtime.toISOString(),
      ...(recordInfo.name ? { name: recordInfo.name } : {}),
      documentWrites: recordInfo.writes,
      leafId: recordInfo.leafId,
      mtimeMs: info.mtimeMs, size: info.size,
    };
  }
  factCache.set(key, { mtimeMs: info.mtimeMs, size: info.size, facts });
  return facts;
}

let factsInFlight: Promise<Map<string, SessionFacts>> | null = null;

/**
 * Read every record the walk found, sharing one run when the polled door is called again while it is still
 * going. A record whose mtime and size are unchanged is answered from the cache, so a steady list only stats
 * the files; entries for files that are gone are dropped.
 */
function refreshFacts(files: string[]): Promise<Map<string, SessionFacts>> {
  if (factsInFlight) return factsInFlight;
  const run = (async () => {
    const alive = new Set<string>();
    const facts = new Map<string, SessionFacts>();
    for (const file of files) {
      const key = comparablePath(file);
      alive.add(key);
      const entry = await readFacts(file);
      if (entry) facts.set(key, entry);
    }
    for (const key of [...factCache.keys()]) if (!alive.has(key)) factCache.delete(key);
    return facts;
  })();
  factsInFlight = run.finally(() => { factsInFlight = null; });
  return factsInFlight;
}

/** one Claude conversation's engine-side record: which mode it runs and where its record is */
interface ClaudeConversationRecord {
  id: string;
  mode: string;
  cwd: string;
  role: string;
  spawnedAt: string;
}

/**
 * Every conversation the engine spawned on Claude Code, read from the spawn records. Claude Code's record is
 * the history, but its place in the list comes from here: the engine owns no copy of the history, yet the list
 * must still show a closed Claude conversation (C-163-4). A record without a mode slot is a lane's and is left
 * out. A conversation whose record file is gone is left out too.
 */
function claudeConversationRecords(): ClaudeConversationRecord[] {
  const dir = join(pipelineStateDir(), "sessions");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: ClaudeConversationRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let rec: { session_id?: unknown; slot?: unknown; role?: unknown; cwd?: unknown; spawned_at?: unknown; harness?: unknown } | null = null;
    try { rec = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
    if (!rec || rec.harness !== "claude") continue;
    if (typeof rec.session_id !== "string" || !CONVERSATION_SESSION_ID.test(rec.session_id)) continue;
    if (typeof rec.slot !== "string" || !rec.slot.startsWith("mode:")) continue;
    if (typeof rec.cwd !== "string" || !rec.cwd) continue;
    out.push({
      id: rec.session_id,
      mode: rec.slot.slice("mode:".length),
      cwd: rec.cwd,
      role: typeof rec.role === "string" ? rec.role : "",
      spawnedAt: typeof rec.spawned_at === "string" ? rec.spawned_at : new Date().toISOString(),
    });
  }
  return out;
}

/** the name a Claude conversation shows in the list: its engine-side title, else its last spoken line */
function claudeConversationName(rec: ClaudeConversationRecord, file: string | undefined): string | undefined {
  const title = readClaudeChatTitle(rec.id);
  if (title) return title;
  if (!file) return undefined;
  try {
    const material = titleMaterial(readClaudeEntries(conversationClaudeConfigDir(), rec.cwd, rec.id).entries);
    const said = material.split("\n").filter((line) => line.startsWith("利用者: ")).pop();
    const text = said?.slice("利用者: ".length).replace(/\s+/g, " ").trim();
    if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  } catch { /* a record the engine cannot read simply has no name */ }
  return undefined;
}

/** the cost of every session, read once per list instead of once per entry */
function costBySession(): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of readCostLines()) out.set(line.sessionId, (out.get(line.sessionId) ?? 0) + (Number(line.cost) || 0));
  for (const [id, total] of out) out.set(id, Number(total.toFixed(6)));
  return out;
}

/** the fields a list entry is built from, before the mark is folded in */
interface SummaryBase {
  id: string;
  mode: SessionMode;
  cwd: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  open: boolean;
  running: boolean;
  tools: string[];
  /** the branch's `.md` writes, newest last, for the document rule */
  documentWrites: DocumentWrite[];
}

/** one list entry: the session's own facts plus its mark and its cwd relative to the workspace */
function summaryOf(
  base: SummaryBase,
  mark: SessionMark,
  marksWorkspace: string,
  cost: number,
  hasSpaceAt: (workspace: string, id: string) => boolean,
): ConversationSummary {
  // a mark that names a space whose dir is gone is no membership, so the list, ?space= and group=space
  // all see the same thing the pi start sees (no context). The space id is resolved against the marks
  // workspace (the place rule), never the session's mode, so a nested layout does not look in the wrong dir
  const space = mark.space && hasSpaceAt(marksWorkspace, mark.space) ? mark.space : undefined;
  // the type is the mark's when the mode still defines it, else the mode's default; a type-less mode has none
  const typeName = effectiveModeType(base.mode, mark.type);
  const document = typeName ? documentFromWrites(base.documentWrites, base.cwd, base.mode.types?.[typeName]) : undefined;
  return {
    id: base.id,
    mode: base.mode.name,
    cwd: base.cwd,
    ...(base.name ? { name: base.name } : {}),
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    cost,
    open: base.open,
    running: base.running,
    tools: base.tools,
    pinned: mark.pinned === true,
    archived: mark.archived === true,
    bookmarks: mark.bookmarks ? [...mark.bookmarks] : [],
    ...(space ? { space } : {}),
    workdir: workdirOf(base.mode.workspace, base.cwd),
    ...(typeName ? { type: typeName } : {}),
    ...(document ? { document } : {}),
  };
}

/** the query the list door takes; every value is validated before it is used */
export interface ConversationListQuery {
  sort?: string;
  direction?: string;
  group?: string;
  archive?: string;
  mode?: string;
  space?: string;
}

export interface ConversationGroup {
  key: string;
  label: string;
  conversations: ConversationSummary[];
}

export interface ConversationListResult {
  conversations: ConversationSummary[];
  groups?: ConversationGroup[];
  group?: string;
}

const SORT_KEYS = ["updated", "created", "name"] as const;
const GROUP_KEYS = ["date", "bookmark", "space"] as const;
const ARCHIVE_KEYS = ["include", "exclude", "only"] as const;

/**
 * Every mode's pi records (across the cwds under each workspace), plus the conversations made but not yet sent
 * to, with the place's marks folded in. The walk is shared with the full-text search's set, and each record is
 * read asynchronously so the engine's event loop is never blocked for the length of one file. The query is
 * applied in one place so the flat list and the groups cannot disagree.
 */
export async function listConversations(query: ConversationListQuery = {}): Promise<ConversationListResult> {
  const sort = query.sort ?? "updated";
  const group = query.group ?? "none";
  const archive = query.archive ?? "include";
  if (!(SORT_KEYS as readonly string[]).includes(sort)) throw new ConversationRefused(`並びのキーが不正です: ${sort}`, 400);
  if (query.direction !== undefined && query.direction !== "asc" && query.direction !== "desc") throw new ConversationRefused(`並びの向きが不正です: ${query.direction}`, 400);
  if (group !== "none" && !(GROUP_KEYS as readonly string[]).includes(group)) throw new ConversationRefused(`グルーピングが不正です: ${group}`, 400);
  if (!(ARCHIVE_KEYS as readonly string[]).includes(archive)) throw new ConversationRefused(`アーカイブの扱いが不正です: ${archive}`, 400);
  const direction = query.direction ?? (sort === "name" ? "asc" : "desc");

  const modes = safeModes();
  const files = walkSessionFiles(modes);
  const facts = await refreshFacts(files);

  // one read per workspace and one space check per id, however many entries they feed
  const marksCache = new Map<string, MarksFile>();
  const readMarksAt = (workspace: string): MarksFile => {
    let found = marksCache.get(workspace);
    if (!found) { found = readMarks(workspace); marksCache.set(workspace, found); }
    return found;
  };
  const spaceCache = new Map<string, boolean>();
  const hasSpaceAt = (workspace: string, id: string): boolean => {
    const key = `${comparablePath(workspace)}\0${id}`;
    let found = spaceCache.get(key);
    if (found === undefined) { found = hasSpace(workspace, id); spaceCache.set(key, found); }
    return found;
  };
  const toolsCache = new Map<string, string[]>();
  const toolsOf = (mode: SessionMode): string[] => {
    let found = toolsCache.get(mode.role);
    if (found === undefined) {
      try { found = [...resolveRole(mode.role).tools]; } catch { found = []; }
      toolsCache.set(mode.role, found);
    }
    return found;
  };
  const cost = costBySession();

  const byId = new Map<string, ConversationSummary>();
  const marksWorkspaceById = new Map<string, string>();
  for (const file of files) {
    const entry = facts.get(comparablePath(file));
    if (!entry) continue;
    if (isSupervisedPipelineSession(entry.id)) continue;
    const mode = modeForCwd(entry.cwd, modes, entry.id);
    if (!mode) continue;
    const workspace = placeWorkspaceFor(entry.id, entry.cwd, mode, modes, readMarksAt);
    marksWorkspaceById.set(entry.id, workspace);
    const open = registry.get(entry.id);
    byId.set(entry.id, summaryOf({
      id: entry.id, mode, cwd: entry.cwd,
      ...(entry.name ? { name: entry.name } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      open: Boolean(open && !open.isClosed),
      running: Boolean(open && !open.isClosed && open.isStreaming),
      tools: toolsOf(mode),
      documentWrites: entry.documentWrites,
    }, readMarksAt(workspace).sessions[entry.id] ?? {}, workspace, cost.get(entry.id) ?? 0, hasSpaceAt));
  }
  for (const rec of claudeConversationRecords()) {
    if (byId.has(rec.id)) continue;
    const mode = modes[rec.mode] ?? modeForCwd(rec.cwd, modes, rec.id);
    if (!mode) continue;
    const file = claudeRecordPath(conversationClaudeConfigDir(), rec.cwd, rec.id);
    const present = existsSync(file);
    const open = registry.get(rec.id);
    const workspace = placeWorkspaceFor(rec.id, rec.cwd, mode, modes, readMarksAt);
    marksWorkspaceById.set(rec.id, workspace);
    const name = claudeConversationName(rec, present ? file : undefined);
    // Claude Code's record is the history; its file time is the conversation's last activity
    const updatedAt = present ? statSync(file).mtime.toISOString() : rec.spawnedAt;
    byId.set(rec.id, summaryOf({
      id: rec.id, mode, cwd: rec.cwd,
      ...(name ? { name } : {}),
      createdAt: rec.spawnedAt,
      updatedAt,
      open: Boolean(open && !open.isClosed),
      running: Boolean(open && !open.isClosed && open.isStreaming),
      tools: toolsOf(mode),
      documentWrites: [],
    }, readMarksAt(workspace).sessions[rec.id] ?? {}, workspace, cost.get(rec.id) ?? 0, hasSpaceAt));
  }

  for (const conv of registry.values()) {
    if (conv.isClosed) continue;
    // an ephemeral branch never appears in the conversation list, open or closed
    if (conv.isEphemeral) continue;
    // an open conversation that already has a record-derived row keeps that row's name and createdAt, and
    // only the live flags overlap; opening one never renames it nor moves it in a createdAt order
    const existing = byId.get(conv.sessionId);
    if (existing) {
      byId.set(conv.sessionId, { ...existing, open: true, running: conv.isStreaming });
      continue;
    }
    const file = conv.sessionFile();
    const workspace = placeWorkspaceFor(conv.sessionId, conv.cwd, conv.mode, modes, readMarksAt);
    marksWorkspaceById.set(conv.sessionId, workspace);
    byId.set(conv.sessionId, summaryOf({
      id: conv.sessionId,
      mode: conv.mode,
      cwd: conv.cwd,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: file ? statSync(file).mtime.toISOString() : conv.createdAt.toISOString(),
      open: true,
      running: conv.isStreaming,
      tools: [...conv.role.tools],
      documentWrites: [],
    }, readMarksAt(workspace).sessions[conv.sessionId] ?? {}, workspace, cost.get(conv.sessionId) ?? 0, hasSpaceAt));
  }

  let list = [...byId.values()];
  if (query.mode) list = list.filter((summary) => summary.mode === query.mode);
  if (query.space !== undefined) list = list.filter((summary) => (summary.space ?? "") === query.space);
  if (archive === "exclude") list = list.filter((summary) => !summary.archived);
  else if (archive === "only") list = list.filter((summary) => summary.archived);

  list.sort((a, b) => compareSummaries(a, b, sort, direction));
  const result: ConversationListResult = { conversations: list };
  if (group !== "none") {
    result.groups = buildGroups(list, group, sort, marksWorkspaceById, readMarksAt);
    result.group = group;
  }
  return result;
}

function compareSummaries(a: ConversationSummary, b: ConversationSummary, sort: string, direction: "asc" | "desc"): number {
  if (sort === "name") {
    const an = a.name;
    const bn = b.name;
    // a session with no name cannot be placed by it: the unnamed ones go last whichever way the list is read
    if (!an && !bn) return a.id.localeCompare(b.id) * (direction === "asc" ? 1 : -1);
    if (!an) return 1;
    if (!bn) return -1;
    return an.localeCompare(bn) * (direction === "asc" ? 1 : -1);
  }
  const key = sort === "created" ? "createdAt" : "updatedAt";
  return a[key].localeCompare(b[key]) * (direction === "asc" ? 1 : -1);
}

function dateBucket(iso: string, now = new Date()): { key: string; label: string } {
  const at = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / (24 * 60 * 60 * 1000));
  if (days <= 0) return { key: "today", label: "今日" };
  if (days === 1) return { key: "yesterday", label: "昨日" };
  if (days <= 7) return { key: "last7", label: "過去 7 日" };
  if (days <= 30) return { key: "last30", label: "過去 30 日" };
  return { key: "older", label: "それ以前" };
}

/**
 * The groups for a grouping query. Pinned sessions lead their own group and appear nowhere else; a bookmark
 * or space grouping puts a session in each group it belongs to, and the ones without one in a trailing
 * `none` group. Every group keeps the flat list's order.
 */
function buildGroups(
  list: ConversationSummary[],
  group: string,
  sort: string,
  marksWorkspaceById: Map<string, string>,
  readMarksAt: (workspace: string) => MarksFile,
): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();
  const ensure = (key: string, label: string): ConversationGroup => {
    let found = groups.get(key);
    if (!found) { found = { key, label, conversations: [] }; groups.set(key, found); }
    return found;
  };
  const pinned = ensure("pinned", "ピン留め");
  const none = ensure("none", "なし");
  for (const summary of list) {
    if (summary.pinned) { pinned.conversations.push(summary); continue; }
    if (group === "date") {
      const at = sort === "created" ? summary.createdAt : summary.updatedAt;
      const bucket = dateBucket(at);
      ensure(bucket.key, bucket.label).conversations.push(summary);
      continue;
    }
    if (group === "bookmark") {
      if (!summary.bookmarks.length) { none.conversations.push(summary); continue; }
      // the bookmark labels come from the workspace that holds this session's marks, not its mode's
      const workspace = marksWorkspaceById.get(summary.id);
      const kinds = workspace ? readMarksAt(workspace).bookmarks : [];
      for (const id of summary.bookmarks) {
        const kind = kinds.find((entry) => entry.id === id);
        ensure(id, kind?.label ?? id).conversations.push(summary);
      }
      continue;
    }
    // space grouping
    if (summary.space) ensure(summary.space, summary.space).conversations.push(summary);
    else none.conversations.push(summary);
  }
  const ordered: ConversationGroup[] = [];
  if (pinned.conversations.length) ordered.push(pinned);
  for (const entry of groups.values()) {
    if (entry.key === "pinned" || entry.key === "none") continue;
    ordered.push(entry);
  }
  if (none.conversations.length) ordered.push(none);
  return ordered;
}

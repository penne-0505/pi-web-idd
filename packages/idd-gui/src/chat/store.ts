/**
 * The conversation screen's reads and operations. The store owns nothing the engine owns: the record is pi's, the
 * queue is the engine's, and this only holds what the screen needs between reads (the selected conversation, the
 * text typed for each conversation, the attached images, the last picture). It is created by `App` so the selection
 * and the typed text survive moving to the Inbox and back.
 *
 * Two rules shape the reads. Every response that is not a success is left unused, so the last picture stays and
 * the band or the row shows why. And a read that the screen asked for is never applied over a newer one.
 */

import type {
  ContextUsage, ConversationEvent, ConversationGroup, ConversationModelOption, ConversationNotice, ConversationSummary,
  IdeaDocumentStatus, IdeaExitRowStatus, IdeaExitSummary, IdeaGateStatus, IdeaRunOutcome, IdeaStatusResponse, QueueItem,
} from "../engine/contract";
import { MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "../engine/contract";
import { pageHostname, signChallenge, type ChallengeAnswer, type PasskeyDeps } from "../engine/passkey";
import { WORDS } from "../strings";
import { applyEvent, foldEntries, type ChatItem, type GateAnchor, type StreamEvent } from "./fold";

export interface FetchResult {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

/** the body may be a string or the recorded audio itself (the transcription door takes the audio as its body) */
export type FetchLike = (path: string, init?: { method?: string; body?: string | Blob; headers?: Record<string, string> }) => Promise<FetchResult>;
export type Listener = () => void;

/**
 * What a box keeps after the engine took a send: only the words that send carried leave it. A person can keep
 * writing while the words are with the engine, and that text sits after the sent words, so dropping the whole
 * box would throw away a line they typed for the next send. A box that no longer begins with the sent words is
 * the person's own text, and is left as it is: the screen cannot tell which part of it was sent.
 */
export function draftAfterSend(current: string, sent: string): string {
  if (!sent) return current;
  return current.startsWith(sent) ? current.slice(sent.length) : current;
}

/** the stream the store opens: a path and a starting number in, events and a gone-callback back */
export interface EventStreamHandle {
  close(): void;
}
export type EventStreamOpen = (
  path: string,
  lastEventId: number | null,
  onEvent: (event: StreamEvent) => void,
  onGone: () => void,
  onId?: (id: number) => void,
) => EventStreamHandle;

export interface WorkspaceOption {
  mode: string;
  label: string;
  workspace: string;
}

export interface BookmarkOption {
  id: string;
  label: string;
}

/** one picture waiting to be sent, in the shape the engine's doors take */
export interface AttachedImage {
  data: string;
  mimeType: string;
}

/** a recording under way: stopping it resolves with the audio and the content type that names it */
export interface Recording {
  stop(): Promise<{ audio: Blob; contentType: string }>;
  cancel(): void;
}
export interface Recorder {
  start(): Promise<Recording>;
}

/**
 * What the open conversation's pi was started with, as the open door reported it. A change through the settings
 * door reaches only the next pi, so these are read to tell the two values apart; `skills` is null when the door
 * answered without them, which the screen draws as unknown rather than as none.
 */
export interface ChatFeatures {
  webSearch: boolean;
  mcp: boolean;
  skills: string[] | null;
}

/** one skill the settings door says this cwd may turn on, in the engine's own words */
export interface SkillCandidateView {
  path: string;
  name: string;
  description: string;
  origin: "user" | "workspace" | "repo";
}

/** the settings file's three values, one file shared by every conversation (DEC-2007) */
export interface ChatSettingsValues {
  skills: string[];
  webSearch: boolean;
  mcp: boolean;
}

/** the engine's settings for the open conversation's cwd, and the last refusal */
export interface ChatSettings {
  values: ChatSettingsValues;
  candidates: SkillCandidateView[];
  /** the settings file the engine read */
  path: string;
  loading: boolean;
  /** a change is on its way; the rows still show the engine's last answer */
  busy: boolean;
  /** the engine's refusal of the last read or change; the values never move before it takes them */
  error: string | null;
}

function emptySettings(): ChatSettings {
  return { values: { skills: [], webSearch: false, mcp: false }, candidates: [], path: "", loading: true, busy: false, error: null };
}
export interface QuotaProvider {
  provider: string;
  windows: { name: string; label: string; utilization: number; resets?: string }[];
  observed?: string;
  rejected?: boolean;
}

/** a mode's type as `/api/idd/modes` names it, in the config's order */
export interface TypeOption {
  name: string;
  label: string;
}

/** what the open conversation shows; `error` stands where the body would, and the list stays */
export interface ChatOpen {
  id: string;
  /** the conversation's mode, for reading the mode's types without a second door */
  mode: string;
  /** the conversation's cwd, the query the settings door takes so its candidates are this conversation's */
  cwd: string;
  error: string | null;
  items: ChatItem[];
  queue: QueueItem[];
  streaming: boolean;
  /** the run's beginning was lost, so the body starts mid-response (the plan's partial mark) */
  partial: boolean;
  /** why the last operation was refused, shown above the composer */
  notice: string | null;
  loading: boolean;
  /** the branch's head in pi's record: the entry a side branch is cut at (DEC-1842) */
  leafId: string | null;
  /** the engine's own model and effort; the screen never invents them (DEC-103-1) */
  model?: string;
  effort?: string;
  /** the levels the current model accepts, straight from the engine (DEC-118-3) */
  efforts?: string[];
  contextUsage: ContextUsage | null;
  cost: number;
  /** the warnings the engine decided on; an empty list means the screen draws none (DEC-118-4) */
  notices: ConversationNotice[];
  /** the conversation's current type, when its mode defines types (DEC-118-8) */
  type?: string;
  /** what the running pi was started with, straight from the open door; null when the door did not say */
  features: ChatFeatures | null;
  /**
   * the harness this conversation's start arguments are built for, straight from the open door; null when the
   * door did not say. The settings' switches reach a pi's start only, so a Claude Code conversation never
   * receives them, and the screen reads this one fact instead of guessing from a mode's name (DEC-103-1).
   */
  harness: "pi" | "claude" | null;
  /** the model candidates the picker searches (DEC-118-1) */
  models: ConversationModelOption[];
  /** a send is on its way; a second send in that window is refused (F-116-6) */
  sending: boolean;
  recording: boolean;
  /** the idea document's own view: the gate lines and bands, the next gate, and the exits block */
  idea: IdeaOpen;
}

/**
 * The idea part of one open conversation. Every value comes from the engine: the document's status (the gate
 * records' positions and stages, the sections, the exits) and the answers of the gate and exit doors. The screen
 * adds only what happened after the door answered: a gate that was just approved (drawn as 受けた until the run's
 * end rereads the record), the rows a challenge returned, and the outcomes of the last run.
 */
export interface IdeaOpen {
  document: IdeaDocumentStatus | null;
  /** why the conversation has no idea document */
  reason: string | null;
  /** the gate the user just approved; its line is not drawn from the record until the run's end */
  received: { gate: 1 | 2 } | null;
  /** whether a gate approval is in flight, so a second press does not send again */
  gateBusy: boolean;
  /** why the gate door refused, shown on the dotted line */
  gateError: string | null;
  /** the rows and breakdown the exit challenge returned, so the screen shows exactly what is being signed */
  challenge: { rows: IdeaExitRowStatus[]; summary: IdeaExitSummary } | null;
  /** why the challenge or the run was refused, shown on the exits block */
  exitError: string | null;
  /** whether a challenge or a run is in flight, so a second press does not send again */
  exitBusy: boolean;
  /** the last run's per-row outcomes, kept on the block after the status is reread */
  outcomes: IdeaRunOutcome[] | null;
}

function emptyIdea(reason: string | null = null): IdeaOpen {
  return { document: null, reason, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null };
}

/** the engine's gate records as the fold's anchors: position and stage come only from the engine's answer */
function anchorsOf(gates: readonly IdeaGateStatus[]): GateAnchor[] {
  return gates.map((gate) => ({ entryId: gate.entryId, mark: { gate: gate.gate, action: gate.action, stage: gate.stage } }));
}

/** the most mentions one send may carry; the engine refuses a sixth too (C-167-4) */
export const MAX_MENTIONS = 5;

/** one lane or card the composer may point at, built from the engine's own state */
export interface MentionCandidate {
  /** the identity: `lane:<id>` or `card:<kind>:<id>:<batchId>` */
  key: string;
  lane: string;
  /** the card's kind; absent for a lane itself */
  kind?: string;
  batchId?: string;
  label: string;
  hint: string;
}

/** what has been pointed at: the same identity, sent to the engine on the send */
export interface ChosenMention {
  key: string;
  lane: string;
  kind?: string;
  batchId?: string;
  label: string;
}

export interface MentionsState {
  candidates: MentionCandidate[];
  chosen: ChosenMention[];
  open: boolean;
  query: string;
  loading: boolean;
  error: string | null;
}

function emptyMentions(): MentionsState {
  return { candidates: [], chosen: [], open: false, query: '', loading: false, error: null };
}

function laneHint(row: Record<string, unknown>): string {
  const stage = typeof row.blockedBy === 'string' && row.blockedBy ? row.blockedBy : String(row.group ?? '');
  const source = row.source && typeof row.source === 'object' ? String((row.source as Record<string, unknown>).label ?? '') : '';
  return [stage, source].filter(Boolean).join(' · ');
}

function cardHint(item: Record<string, unknown>): string {
  if (item.kind === 'question') {
    const open = Array.isArray(item.open) ? (item.open as Record<string, unknown>[]) : [];
    return open.map((q) => String(q.question ?? '')).filter(Boolean).join(' / ');
  }
  if (item.kind === 'go') {
    const s = (item.summary ?? {}) as Record<string, unknown>;
    return String(s.situation ?? '');
  }
  return String(item.laneTitle ?? item.title ?? '');
}

/** the picker's candidates, from the engine's lanes and cards only (C-167-5) */
export function mentionCandidatesOf(body: unknown): MentionCandidate[] {
  const state = (body ?? {}) as { lanes?: unknown; items?: unknown };
  const out: MentionCandidate[] = [];
  for (const raw of Array.isArray(state.lanes) ? (state.lanes as Record<string, unknown>[]) : []) {
    const lane = String(raw.iddId ?? '');
    if (!lane) continue;
    out.push({ key: `lane:${lane}`, lane, label: `${lane} ${String(raw.title ?? '')}`.trim(), hint: laneHint(raw) });
  }
  for (const raw of Array.isArray(state.items) ? (state.items as Record<string, unknown>[]) : []) {
    const lane = String(raw.iddId ?? '');
    const kind = String(raw.kind ?? '');
    if (!lane || !kind) continue;
    const batchId = typeof raw.batchId === 'string' ? raw.batchId : undefined;
    out.push({
      key: `card:${kind}:${lane}:${batchId ?? ''}`,
      lane,
      kind,
      ...(batchId ? { batchId } : {}),
      label: `card ${kind} ${lane}`,
      hint: cardHint(raw),
    });
  }
  return out;
}

/** the picker's list for one search word: the label and the hint both count */
export function filterMentions(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return candidates;
  return candidates.filter((c) => c.label.toLowerCase().includes(needle) || c.hint.toLowerCase().includes(needle));
}

export interface ChatStoreState {
  workspaces: WorkspaceOption[];
  mode: string | null;
  spaces: { id: string; label: string }[];
  bookmarks: BookmarkOption[];
  groups: ConversationGroup[];
  archive: "exclude" | "only";
  connection: "ok" | "down";
  attempt: number;
  selectedId: string | null;
  drafts: Record<string, string>;
  attachments: Record<string, AttachedImage[]>;
  /** the types each mode defines, read once from `/api/idd/modes` */
  types: Record<string, TypeOption[]>;
  /** the last quota reading, read when the Context popover opens */
  quota: QuotaProvider[] | null;
  /** the engine's conversation settings for the open conversation's cwd, or null before the first read */
  settings: ChatSettings | null;
  /** the composer's mention picker: the engine's candidates and what has been pointed at */
  mentions: MentionsState;
  open: ChatOpen | null;
  /** the line left after a conversation was removed */
  receipt: string | null;
  /** why a mark change failed, keyed by conversation id, shown on that row */
  markErrors: Record<string, string>;
  /** why a delete failed, keyed by conversation id */
  deleteErrors: Record<string, string>;
  /**
   * the names the screen was given for open conversations, keyed by id. The open door does not carry a
   * conversation's name, so a conversation opened from the find field (another workspace, or an archived one)
   * is not in the list this screen reads: its name is kept here from the field's own candidate value (C-173-4).
   * A conversation the list does hold is still drawn from the list's own summary first.
   */
  knownNames: Record<string, string>;
  now: number;
}

const RECONNECT_MS = 1000;

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** the queue the engine returned, read as the door's shape and never invented */
function queueOf(value: unknown): QueueItem[] {
  const out: QueueItem[] = [];
  for (const raw of list<Record<string, unknown>>(value)) {
    if (!raw || typeof raw.id !== "string") continue;
    out.push({
      id: raw.id,
      text: typeof raw.text === "string" ? raw.text : "",
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
      ...(typeof raw.effort === "string" ? { effort: raw.effort } : {}),
    });
  }
  return out;
}

function groupsOf(value: unknown): ConversationGroup[] {
  const out: ConversationGroup[] = [];
  for (const raw of list<Record<string, unknown>>(value)) {
    if (!raw || typeof raw.key !== "string") continue;
    out.push({
      key: raw.key,
      label: typeof raw.label === "string" ? raw.label : raw.key,
      conversations: list<ConversationSummary>(raw.conversations),
    });
  }
  return out;
}

/** the model candidates the engine returned, kept to the fields the picker draws */
export function modelsOf(value: unknown): ConversationModelOption[] {
  const out: ConversationModelOption[] = [];
  for (const raw of list<Record<string, unknown>>(value)) {
    if (!raw || typeof raw.id !== "string") continue;
    out.push({
      id: raw.id,
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
      provider: typeof raw.provider === "string" ? raw.provider : raw.id.split("/")[0] ?? "",
      contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : null,
      capabilities: list<string>(raw.capabilities).filter((capability): capability is "image" | "reasoning" => capability === "image" || capability === "reasoning"),
    });
  }
  return out;
}

/** the notices the engine returned; nothing is invented when the field is missing */
export function noticesOf(value: unknown): ConversationNotice[] {
  const out: ConversationNotice[] = [];
  for (const raw of list<Record<string, unknown>>(value)) {
    if (!raw || typeof raw.kind !== "string") continue;
    if (raw.kind === "context" && typeof raw.percent === "number") out.push({ kind: "context", percent: raw.percent });
    else if (raw.kind === "quota" && typeof raw.provider === "string" && typeof raw.label === "string" && typeof raw.utilization === "number") {
      out.push({
        kind: "quota", provider: raw.provider,
        window: typeof raw.window === "string" ? raw.window : "",
        label: raw.label, utilization: raw.utilization,
        ...(typeof raw.resets === "string" ? { resets: raw.resets } : {}),
        ...(raw.rejected === true ? { rejected: true } : {}),
      });
    }
  }
  return out;
}

/** pi's own figures, or null when the door carried none */
export function contextUsageOf(value: unknown): ContextUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    tokens: typeof raw.tokens === "number" ? raw.tokens : null,
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : null,
    percent: typeof raw.percent === "number" ? raw.percent : null,
  };
}

/** each mode's types in the config's order, from `/api/idd/modes` */
export function typesOf(value: unknown): Record<string, TypeOption[]> {
  const out: Record<string, TypeOption[]> = {};
  for (const raw of list<Record<string, unknown>>(value)) {
    if (!raw || typeof raw.name !== "string") continue;
    const types = raw.types;
    if (!types || typeof types !== "object" || Array.isArray(types)) continue;
    out[raw.name] = Object.entries(types as Record<string, { label?: unknown } | null>).map(([name, def]) => ({
      name,
      label: def && typeof def.label === "string" ? def.label : name,
    }));
  }
  return out;
}

/** the rows the picker's search keeps: the name or the id may match (DEC-118-1) */
export function filterModels(models: ConversationModelOption[], query: string): ConversationModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) => model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle) || model.provider.toLowerCase().includes(needle));
}

/** whether the pictures may be attached at all: the count, then one by one */
export function attachError(images: AttachedImage[]): string | null {
  if (images.length > MAX_ATTACHED_IMAGES) return WORDS.chat.attach.tooMany;
  for (const image of images) if (!isBase64ImageWithinLimits(image)) return WORDS.chat.attach.tooLarge;
  return null;
}

/** the fresh picture of an open conversation; every field the engine owns starts empty */
function emptyOpen(id: string): ChatOpen {
  return {
    id, mode: "", cwd: "", error: null, items: [], queue: [], streaming: false, partial: false, notice: null, loading: true,
    leafId: null, features: null, harness: null,
    contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false, idea: emptyIdea(),
  };
}

/** the harness the open door named; an unknown or missing value is not a guess about which one it is */
function harnessOf(value: unknown): "pi" | "claude" | null {
  return value === "pi" || value === "claude" ? value : null;
}

/** the features the open door reported; null when it carried none at all, and skills null when it carried none */
function featuresOf(value: unknown): ChatFeatures | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return { webSearch: raw.webSearch === true, mcp: raw.mcp === true, skills: Array.isArray(raw.skills) ? strings(raw.skills) : null };
}

/** the skills the settings door says this cwd may turn on; a candidate the engine did not name is not invented */
function candidatesOf(value: unknown): SkillCandidateView[] {
  const out: SkillCandidateView[] = [];
  for (const raw of list<Record<string, unknown>>(value)) {
    if (!raw || typeof raw.path !== "string" || !raw.path) continue;
    const origin = raw.origin;
    out.push({
      path: raw.path,
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.path,
      description: typeof raw.description === "string" ? raw.description : "",
      origin: origin === "workspace" || origin === "repo" ? origin : "user",
    });
  }
  return out;
}

/** one settings answer (GET or PATCH) as the screen holds it, or null when the door's shape was not there */
function settingsOf(value: unknown): ChatSettings | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const settings = body.settings;
  if (!settings || typeof settings !== "object") return null;
  const raw = settings as Record<string, unknown>;
  return {
    values: { skills: strings(raw.skills), webSearch: raw.webSearch === true, mcp: raw.mcp === true },
    candidates: candidatesOf(body.candidates),
    path: typeof body.path === "string" ? body.path : "",
    loading: false,
    busy: false,
    error: null,
  };
}

function errorOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const message = (body as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return `${WORDS.chat.refused} (${status})`;
}

function eventsPath(id: string): string {
  return `/api/conversations/${encodeURIComponent(id)}/events`;
}

export class ChatStore {
  private listeners = new Set<Listener>();
  private openGen = 0;
  private listSeq = 0;
  private listApplied = 0;
  private modelsSeq = 0;
  /** the settings reads and changes, so a late answer never lands on another conversation */
  private settingsSeq = 0;
  private stream: EventStreamHandle | null = null;
  private streamGen = -1;
  private lastSeq: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streamBuffer: StreamEvent[] = [];
  private streamBuffering = false;
  /** the events held before the run-beginning reconnect, kept until a reset says the gap is lost */
  private replayBuffer: StreamEvent[] = [];
  private replayAttempt = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** the record the open view was folded from, so an idea answer that arrives first folds nothing stale */
  private recordEntries: unknown[] = [];
  private recordLeaf: string | null = null;
  private recordFor: string | null = null;
  /** the generation of the idea status reads, so a late answer for an older read is dropped */
  private ideaGen = 0;
  /**
   * the selection the in-flight gate approval and exit signature belong to. It moves only when the conversation
   * is left, reselected or removed, so a status reread of the same conversation (the run's end rereads it while an
   * answer is still coming) never throws a pending approval away and leaves the button busy forever.
   */
  private ideaConv = 0;
  private ideaFor: string | null = null;
  private anchors: GateAnchor[] = [];
  /** the gate just approved: the status's record is not folded until the run's end rereads it */
  private ideaReceived: { gate: 1 | 2 } | null = null;
  /** the recording in flight and the conversation it was started in, so the text lands in the right box (DEC-118-7) */
  private recording: { id: string; handle: Recording } | null = null;

  state: ChatStoreState = {
    workspaces: [],
    mode: null,
    spaces: [],
    bookmarks: [],
    groups: [],
    archive: "exclude",
    connection: "ok",
    attempt: 0,
    selectedId: null,
    drafts: {},
    attachments: {},
    types: {},
    quota: null,
    settings: null,
    mentions: emptyMentions(),
    open: null,
    receipt: null,
    markErrors: {},
    deleteErrors: {},
    knownNames: {},
    now: 0,
  };

  private readonly fetchFn: FetchLike;
  private readonly streams: EventStreamOpen;
  private readonly clock: () => number;
  private readonly passkeyDeps: PasskeyDeps;
  private readonly recorder: Recorder | null;

  constructor(fetchFn: FetchLike, streams: EventStreamOpen, clock: () => number = () => Date.now(), recorder: Recorder | null = null, passkeyDeps: PasskeyDeps = {}) {
    this.fetchFn = fetchFn;
    this.streams = streams;
    this.clock = clock;
    this.recorder = recorder;
    this.passkeyDeps = passkeyDeps;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<ChatStoreState>): void {
    this.state = { ...this.state, ...next, now: this.clock() };
    this.emit();
  }

  private patchOpen(next: Partial<ChatOpen>): void {
    if (!this.state.open) return;
    this.state = { ...this.state, open: { ...this.state.open, ...next }, now: this.clock() };
    this.emit();
  }

  /**
   * Write onto the open conversation only while it is still the one on screen: an answer that comes back after the
   * screen moved to another conversation says nothing about the one now shown, so it is dropped rather than written.
   */
  private patchOpenFor(id: string, next: Partial<ChatOpen>): void {
    if (this.state.selectedId !== id) return;
    this.patchOpen(next);
  }

  private patchIdea(next: Partial<IdeaOpen>): void {
    const open = this.state.open;
    if (!open) return;
    this.patchOpen({ idea: { ...open.idea, ...next } });
  }

  /** the fold's anchors for one conversation, or none when the latest idea answer was for another */
  private anchorsFor(id: string): GateAnchor[] {
    return this.ideaFor === id ? this.anchors : [];
  }

  /**
   * Fold the record again with whatever the screen now holds. The record and the anchors arrive from two doors, so
   * whichever lands second is the one that puts the gate lines in: an answer that arrives first folds with no
   * position, and the other side re-folds once both are there. The re-fold is skipped while a run is going, so a
   * live delta is never thrown away (the run's end reloads and rereads anyway).
   */
  private refold(): void {
    const open = this.state.open;
    if (!open || open.streaming) return;
    if (this.recordFor !== open.id) return;
    this.patchOpen({ items: foldEntries(this.recordEntries, this.recordLeaf, this.anchorsFor(open.id)) });
  }

  private patchSettings(next: Partial<ChatSettings>): void {
    const base = this.state.settings ?? emptySettings();
    this.patch({ settings: { ...base, ...next } });
  }

  private patchDraft(id: string, text: string): void {
    this.patch({ drafts: { ...this.state.drafts, [id]: text } });
  }

  private patchAttachments(id: string, images: AttachedImage[]): void {
    this.patch({ attachments: { ...this.state.attachments, [id]: images } });
  }

  /** the typed text for one conversation, kept across leaving the screen */
  draftFor(id: string | null): string {
    return id ? this.state.drafts[id] ?? "" : "";
  }

  setDraft(id: string, text: string): void {
    this.patchDraft(id, text);
  }

  // ---- the composer's mention picker: candidates from the engine's state, and what has been pointed at

  private patchMentions(next: Partial<MentionsState>): void {
    this.patch({ mentions: { ...this.state.mentions, ...next } });
  }

  /** read the lanes and cards the picker points at; the engine's `/api/idd/state` is the only source (C-167-5) */
  async readMentions(): Promise<void> {
    this.patchMentions({ loading: true });
    try {
      const res = await this.fetchFn("/api/idd/state");
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok || !body) {
        this.patchMentions({ loading: false, error: WORDS.errors.unreachable });
        return;
      }
      this.applyMentions(mentionCandidatesOf(body));
    } catch {
      this.patchMentions({ loading: false, error: WORDS.errors.unreachable });
    }
  }

  /**
   * the answer that landed: the candidates are the engine's current lanes and cards, so a card that was answered
   * since the last read leaves the list, and a point the state no longer holds is taken back here instead of on the
   * send, where the engine would refuse the whole message (F-1 of the fourth review)
   */
  private applyMentions(candidates: MentionCandidate[]): void {
    const keys = new Set(candidates.map((c) => c.key));
    const held = this.state.mentions.chosen;
    const gone = held.filter((c) => !keys.has(c.key));
    this.patchMentions({
      candidates,
      loading: false,
      error: gone.length ? WORDS.chat.mentions.gone(gone.map((c) => c.label).join(" / ")) : null,
      ...(gone.length ? { chosen: held.filter((c) => keys.has(c.key)) } : {}),
    });
  }

  /** the picker was opened: read the engine's current lanes and cards again, keeping what is held until it answers */
  openMentions(): void {
    this.patchMentions({ open: true, error: null });
    if (!this.state.mentions.loading) void this.readMentions();
  }

  closeMentions(): void {
    this.patchMentions({ open: false, error: null });
  }

  setMentionQuery(query: string): void {
    this.patchMentions({ query });
  }

  /** point at one candidate, or take it back; a sixth press is refused, never silently dropped */
  toggleMention(key: string): void {
    const current = this.state.mentions;
    if (current.chosen.some((c) => c.key === key)) {
      this.patchMentions({ chosen: current.chosen.filter((c) => c.key !== key), error: null });
      return;
    }
    if (current.chosen.length >= MAX_MENTIONS) {
      this.patchMentions({ error: WORDS.chat.mentionsTooMany });
      return;
    }
    const candidate = current.candidates.find((c) => c.key === key);
    if (!candidate) return;
    this.patchMentions({
      chosen: [...current.chosen, {
        key: candidate.key,
        lane: candidate.lane,
        ...(candidate.kind ? { kind: candidate.kind } : {}),
        ...(candidate.batchId ? { batchId: candidate.batchId } : {}),
        label: candidate.label,
      }],
      error: null,
    });
  }

  removeMention(key: string): void {
    this.toggleMention(key);
  }

  /** the mentions as the send body names them: the identity alone, never the point (the engine reads that back) */
  mentionPayload(): { lane: string; kind?: string; batchId?: string }[] {
    return this.state.mentions.chosen.map((c) => ({
      lane: c.lane,
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.batchId ? { batchId: c.batchId } : {}),
    }));
  }

  /** the pictures waiting for one conversation */
  attachmentsFor(id: string | null): AttachedImage[] {
    return id ? this.state.attachments[id] ?? [] : [];
  }

  /** whether the open conversation's model takes images, from the engine's own candidates (DEC-118-5) */
  currentModelHasImage(): boolean {
    const open = this.state.open;
    if (!open?.model) return false;
    const model = open.models.find((candidate) => candidate.id === open.model);
    return Boolean(model?.capabilities.includes("image"));
  }

  /** take one picture if the engine says the current model takes images and the limits allow it (DEC-118-5/6) */
  attachImage(image: AttachedImage): boolean {
    const id = this.state.selectedId;
    if (!id) return false;
    if (!this.currentModelHasImage()) {
      this.patchOpen({ notice: WORDS.chat.attach.notAllowed });
      return false;
    }
    const next = [...this.attachmentsFor(id), image];
    const error = attachError(next);
    if (error) {
      this.patchOpen({ notice: error });
      return false;
    }
    this.patchAttachments(id, next);
    return true;
  }

  removeAttachment(index: number): void {
    const id = this.state.selectedId;
    if (!id) return;
    const next = this.attachmentsFor(id).filter((_, at) => at !== index);
    this.patchAttachments(id, next);
  }

  /** the selected conversation's summary, from the list's own value */
  summaryFor(id: string | null): ConversationSummary | null {
    if (!id) return null;
    for (const group of this.state.groups) for (const summary of group.conversations) if (summary.id === id) return summary;
    return null;
  }

  // ---- the list ----

  readWorkspaces(): Promise<void> {
    return this.fetchFn("/api/conversations/workspaces")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return;
        const body = (await res.json()) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return;
        const workspaces = list<Record<string, unknown>>(body.workspaces)
          .filter((entry) => entry && typeof entry.mode === "string")
          .map((entry) => ({
            mode: entry.mode as string,
            label: typeof entry.label === "string" ? entry.label : (entry.mode as string),
            workspace: typeof entry.workspace === "string" ? entry.workspace : "",
          }));
        this.patch({ workspaces });
        if (!this.state.mode && workspaces.length) void this.selectWorkspace(workspaces[0].mode);
      })
      .catch(() => undefined);
  }

  selectWorkspace(mode: string): Promise<void> {
    this.patch({ mode, spaces: [], bookmarks: [] });
    void this.readSpaces(mode);
    void this.readBookmarks(mode);
    return this.readList();
  }

  /** a workspace's spaces; an answer that belongs to a workspace the screen has left is dropped (F-116-3) */
  private readSpaces(mode: string): Promise<void> {
    return this.fetchFn(`/api/conversations/workspaces/${encodeURIComponent(mode)}/spaces`)
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return;
        const body = (await res.json()) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return;
        if (this.state.mode !== mode) return;
        const spaces = list<Record<string, unknown>>(body.spaces)
          .filter((entry) => entry && typeof entry.id === "string")
          .map((entry) => ({ id: entry.id as string, label: typeof entry.name === "string" ? entry.name : (entry.id as string) }));
        this.patch({ spaces });
      })
      .catch(() => undefined);
  }

  /** a workspace's bookmarks, with the same guard as the spaces */
  private readBookmarks(mode: string): Promise<void> {
    return this.fetchFn(`/api/conversations/workspaces/${encodeURIComponent(mode)}/bookmarks`)
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return;
        const body = (await res.json()) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return;
        if (this.state.mode !== mode) return;
        const bookmarks = list<Record<string, unknown>>(body.bookmarks)
          .filter((entry) => entry && typeof entry.id === "string")
          .map((entry) => ({ id: entry.id as string, label: typeof entry.label === "string" ? entry.label : (entry.id as string) }));
        this.patch({ bookmarks });
      })
      .catch(() => undefined);
  }

  /** read the list; an older answer never replaces a newer one and a failure keeps the last picture */
  readList(): Promise<void> {
    const mine = ++this.listSeq;
    const mode = this.state.mode;
    const archive = this.state.archive;
    const query = `/api/conversations?group=date&archive=${archive}${mode ? `&mode=${encodeURIComponent(mode)}` : ""}`;
    return this.fetchFn(query)
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return this.listFail(mine);
        let body: Record<string, unknown>;
        try {
          const parsed = await res.json();
          if (!parsed || typeof parsed !== "object") throw new Error("not an object");
          body = parsed as Record<string, unknown>;
        } catch {
          return this.listFail(mine);
        }
        if (mine <= this.listApplied) return;
        this.listApplied = mine;
        this.patch({ groups: groupsOf(body.groups), connection: "ok", attempt: 0 });
      })
      .catch(() => this.listFail(mine));
  }

  private listFail(mine: number): void {
    if (mine <= this.listApplied) return;
    this.patch({ connection: "down", attempt: this.state.attempt + 1 });
  }

  setArchive(archive: "exclude" | "only"): Promise<void> {
    this.patch({ archive });
    return this.readList();
  }

  /** the mode's types, read once; a failure leaves the switch out rather than inventing one (DEC-118-8) */
  readModes(): Promise<void> {
    return this.fetchFn("/api/idd/modes")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return;
        const body = (await res.json()) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return;
        this.patch({ types: typesOf(body.modes) });
      })
      .catch(() => undefined);
  }

  /** the quota reading, read only while the Context popover is open */
  readQuota(): Promise<void> {
    return this.fetchFn("/api/quota")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return;
        const body = (await res.json()) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return;
        const providers: QuotaProvider[] = [];
        for (const raw of list<Record<string, unknown>>(body.providers)) {
          if (!raw || typeof raw.provider !== "string") continue;
          providers.push({
            provider: raw.provider,
            windows: list<Record<string, unknown>>(raw.windows)
              .filter((window) => window && typeof window.name === "string" && typeof window.utilization === "number")
              .map((window) => ({
                name: window.name as string,
                label: typeof window.label === "string" ? window.label : window.name as string,
                utilization: window.utilization as number,
                ...(typeof window.resets === "string" ? { resets: window.resets } : {}),
              })),
            ...(typeof raw.observed === "string" ? { observed: raw.observed } : {}),
            ...(raw.rejected === true ? { rejected: true } : {}),
          });
        }
        this.patch({ quota: providers });
      })
      .catch(() => undefined);
  }

  // ---- the conversation settings (one file shared by every conversation) ----

  /**
   * Read the settings for one conversation's cwd, with the skills that cwd may turn on. The conversation's cwd is
   * the query's argument: without it the repo's own skills would not be among the candidates. A late answer for a
   * conversation the screen has left is dropped, so it can never move the next conversation's rows.
   */
  readSettings(id: string, cwd: string): Promise<void> {
    const mine = ++this.settingsSeq;
    this.patchSettings({ loading: true, error: null });
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return this.fetchFn(`/api/conversation-settings${query}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (mine !== this.settingsSeq || this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          this.patchSettings({ loading: false, error: errorOf(body, res.status) });
          return;
        }
        const next = settingsOf(body);
        if (!next) {
          this.patchSettings({ loading: false, error: WORDS.errors.rejectedPrefix });
          return;
        }
        this.patch({ settings: next });
      })
      .catch(() => {
        if (mine === this.settingsSeq && this.state.selectedId === id) this.patchSettings({ loading: false, error: WORDS.errors.unreachable });
      });
  }

  /** turn one skill on or off; the whole list goes, because the door holds one list for every conversation */
  setSkill(path: string, on: boolean): Promise<void> {
    const current = this.state.settings;
    if (!current) return Promise.resolve();
    const skills = on
      ? [...current.values.skills.filter((skill) => skill !== path), path]
      : current.values.skills.filter((skill) => skill !== path);
    return this.changeSettings({ skills });
  }

  /** turn web search or MCP on or off; the same door and the same answer-first rule as the skills */
  setFeature(key: "webSearch" | "mcp", on: boolean): Promise<void> {
    return this.changeSettings({ [key]: on });
  }

  /**
   * Change the settings. The rows move only to what the engine answered, so a refusal leaves them on the engine's
   * own values and shows its reason. A change is never applied over a newer one, and an answer that arrives after
   * the screen moved to another conversation changes nothing there.
   */
  private changeSettings(patch: { skills?: string[]; webSearch?: boolean; mcp?: boolean }): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    const cwd = this.state.open?.cwd ?? "";
    const mine = ++this.settingsSeq;
    this.patchSettings({ busy: true, error: null });
    const body = JSON.stringify(cwd ? { ...patch, cwd } : patch);
    return this.fetchFn("/api/conversation-settings", { method: "PATCH", body })
      .then(async (res) => {
        const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (mine !== this.settingsSeq || this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !answer || answer.ok === false) {
          this.patchSettings({ busy: false, error: errorOf(answer, res.status) });
          return;
        }
        const next = settingsOf(answer);
        if (!next) {
          this.patchSettings({ busy: false, error: WORDS.errors.rejectedPrefix });
          return;
        }
        this.patch({ settings: next });
      })
      .catch(() => {
        if (mine === this.settingsSeq && this.state.selectedId === id) this.patchSettings({ busy: false, error: WORDS.errors.unreachable });
      });
  }

  // ---- the open conversation and its stream ----

  private closeStream(): void {
    this.stream?.close();
    this.stream = null;
  }

  /** stop the reconnect loop as well: a closed stream with a timer would dial a failed conversation forever (F-116-2) */
  private stopReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private openStream(id: string, lastEventId: number | null, gen: number): void {
    this.closeStream();
    this.streamGen = gen;
    this.stream = this.streams(
      eventsPath(id),
      lastEventId,
      (event) => this.onStreamEvent(gen, event),
      () => this.onStreamGone(gen),
      (seq) => this.onStreamId(gen, seq),
    );
  }

  /**
   * An `id:`-only frame's number: the engine hands the client the number it now holds after the replay, so a
   * connection that drops before the first live event still resumes from there instead of dropping the gap.
   */
  private onStreamId(gen: number, id: number): void {
    if (gen !== this.openGen) return;
    if (Number.isFinite(id)) this.lastSeq = id;
  }

  private onStreamEvent(gen: number, event: StreamEvent): void {
    if (gen !== this.openGen) return;
    if (typeof event.seq === "number") this.lastSeq = event.seq;

    if (this.replayAttempt) {
      if (event.type === "reset") {
        // the engine cannot fill the run's beginning: continue unnumbered with the events held before, and say so
        this.replayAttempt = false;
        this.streamBuffering = false;
        const held = this.replayBuffer;
        this.replayBuffer = [];
        this.streamBuffer = [];
        for (const entry of held) this.applyStream(gen, entry);
        this.patchOpen({ partial: true });
        this.openStream(this.state.selectedId ?? "", null, gen);
        return;
      }
      // the beginning came back: the reconnect replays from the run's start, so every event held before
      // it arrives again from the replay itself. Drawing the held ones on top of the replay would show a
      // text delta twice, so they are dropped and the stream goes live.
      this.replayAttempt = false;
      this.streamBuffering = false;
      this.replayBuffer = [];
      this.streamBuffer = [];
      this.applyStream(gen, event);
      return;
    }

    if (this.streamBuffering) {
      this.streamBuffer.push(event);
      return;
    }
    this.applyStream(gen, event);
  }

  private applyStream(gen: number, event: ConversationEvent | StreamEvent): void {
    if (gen !== this.openGen) return;
    if (event.type === "reset") {
      // the engine no longer holds the events after the last number: read the record again
      const id = this.state.selectedId;
      if (id) void this.reload(id, { lastEventId: null });
      return;
    }
    if (event.type === "queue") {
      this.patchOpen({ queue: queueOf((event as Record<string, unknown>).queue) });
      return;
    }
    if (event.type === "model") {
      // the engine reports what pi holds now, never the requested value (DEC-118-3)
      const fields = event as Record<string, unknown>;
      this.patchOpen({
        ...(typeof fields.model === "string" ? { model: fields.model } : {}),
        ...(typeof fields.effort === "string" ? { effort: fields.effort } : {}),
        ...(Array.isArray(fields.efforts) ? { efforts: strings(fields.efforts) } : {}),
      });
      return;
    }
    if (event.type === "context") {
      const fields = event as Record<string, unknown>;
      this.patchOpen({
        ...(fields.contextUsage ? { contextUsage: contextUsageOf(fields.contextUsage) } : {}),
        ...(Array.isArray(fields.notices) ? { notices: noticesOf(fields.notices) } : {}),
      });
      return;
    }
    if (event.type === "cost") {
      const sessionCost = (event as Record<string, unknown>).sessionCost;
      if (typeof sessionCost === "number") this.patchOpen({ cost: sessionCost });
      return;
    }
    if (event.type === "end") {
      this.patchOpen({ streaming: false });
      const id = this.state.selectedId;
      // the run is over: replace the streamed layer with the record it left behind. The stream is re-bound to
      // the new generation by reopening at the last number, so the events after it are replayed and none is lost.
      if (id) {
        // the run's end is what turns a just-approved gate into a record line: reread the status now, so the
        // notice the gate door left is on the branch and its position is no longer empty
        this.ideaReceived = null;
        this.patchIdea({ received: null });
        void this.readIdea(id);
        void this.reload(id, { lastEventId: this.lastSeq });
      }
      return;
    }
    if (event.type === "error") {
      const message = (event as Record<string, unknown>).message;
      this.patchOpen({ notice: typeof message === "string" ? message : null });
      return;
    }
    if (event.type === "run_start" || event.type === "text" || event.type === "thinking" || event.type.startsWith("tool_") || event.type === "entry" || event.type === "compaction_end") {
      this.patchOpen({ streaming: true, items: applyEvent(this.state.open?.items ?? [], event), notice: null });
      return;
    }
    if (event.type === "compaction_start") {
      this.patchOpen({ streaming: true });
    }
  }

  private onStreamGone(gen: number): void {
    if (gen !== this.openGen) return;
    this.stream = null;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen !== this.openGen) return;
      const id = this.state.selectedId;
      if (!id) return;
      // resume with the number last seen, so the engine replays the gap instead of dropping it
      this.openStream(id, this.lastSeq, gen);
    }, RECONNECT_MS);
  }

  /** select a conversation: open the door and read its record, with the stream already listening */
  select(id: string, name?: string): Promise<void> {
    this.closeStream();
    this.stopReconnect();
    this.streamBuffering = true;
    this.streamBuffer = [];
    this.replayBuffer = [];
    this.replayAttempt = false;
    this.ideaGen += 1;
    this.ideaConv += 1;
    this.ideaFor = null;
    this.ideaReceived = null;
    this.anchors = [];
    this.recordFor = null;
    this.modelsSeq += 1;
    this.settingsSeq += 1;
    this.patch({
      selectedId: id,
      // the name the find field held for this conversation, so its header is never blank (C-173-4)
      ...(name ? { knownNames: { ...this.state.knownNames, [id]: name } } : {}),
      // a recording already under way stays: its text belongs to the conversation it began in, and the button can
      // still stop it from wherever the person is now (DEC-118-7)
      open: { ...emptyOpen(id), recording: this.recording !== null },
      settings: null,
    });
    void this.readIdea(id);
    // the settings read needs the conversation's cwd, which only the open door answers; it is read once per
    // selection, never on the run-end reread, so a change in flight is not overtaken by a fresh read
    return this.reload(id, { lastEventId: null }).then(() => {
      const open = this.state.open;
      if (open && open.id === id && !open.error) void this.readSettings(id, open.cwd);
    });
  }

  /**
   * Read the open door and put its record under the stream. The stream is connected first, and events that arrive
   * before the read answers are held and applied in order afterwards, so the gap between reading and listening is
   * never lost. A streaming conversation with a run-beginning number is reconnected from one before it, so the
   * body appears from the run's start; if that number is gone, the held events continue and the mark shows.
   */
  private async reload(id: string, opts: { lastEventId: number | null }): Promise<void> {
    const gen = ++this.openGen;
    this.streamBuffering = true;
    this.streamBuffer = [];
    this.replayBuffer = [];
    this.replayAttempt = false;
    this.lastSeq = opts.lastEventId;
    this.openStream(id, opts.lastEventId, gen);

    let body: Record<string, unknown> | null = null;
    try {
      const res = await this.fetchFn(`/api/conversations/${encodeURIComponent(id)}`);
      if (gen !== this.openGen) return;
      if (res.status < 200 || res.status >= 300) {
        const parsed = await res.json().catch(() => null);
        if (gen !== this.openGen) return;
        this.streamBuffering = false;
        this.streamBuffer = [];
        this.closeStream();
        this.stopReconnect();
        this.patchSettings({ loading: false, error: errorOf(parsed, res.status) });
        this.patchOpen({ error: errorOf(parsed, res.status), loading: false, items: [], queue: [], streaming: false, partial: false });
        return;
      }
      const parsed = await res.json();
      if (gen !== this.openGen) return;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      if (gen !== this.openGen) return;
      this.streamBuffering = false;
      this.streamBuffer = [];
      this.closeStream();
      this.stopReconnect();
      this.patchSettings({ loading: false, error: WORDS.errors.unreachable });
      this.patchOpen({ error: WORDS.errors.unreachable, loading: false, items: [], queue: [], streaming: false, partial: false });
      return;
    }

    const entries = Array.isArray(body.entries) ? body.entries : [];
    const leafId = typeof body.leafId === "string" ? body.leafId : null;
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const queue = queueOf(body.queue);
    const streaming = body.streaming === true;
    const runStartSeq = typeof body.runStartSeq === "number" ? body.runStartSeq : null;
    // the events held while the read was in flight, applied in arrival order once the record is on screen
    const held = this.streamBuffer;
    this.streamBuffer = [];
    this.recordEntries = entries;
    this.recordLeaf = leafId;
    this.recordFor = id;
    this.patchOpen({
      error: null,
      mode: typeof body.mode === "string" ? body.mode : "",
      cwd,
      features: featuresOf(body.features),
      harness: harnessOf(body.harness),
      items: foldEntries(entries, leafId, this.anchorsFor(id)),
      leafId,
      queue,
      streaming,
      partial: false,
      loading: false,
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
      ...(Array.isArray(body.efforts) ? { efforts: strings(body.efforts) } : {}),
      contextUsage: contextUsageOf(body.contextUsage),
      cost: typeof body.cost === "number" ? body.cost : 0,
      notices: noticesOf(body.notices),
      ...(typeof body.type === "string" ? { type: body.type } : {}),
    });
    void this.readModels();

    if (streaming && runStartSeq !== null && runStartSeq > 0) {
      // read the run from its beginning, so what flowed before the open is not missing. The held events are kept
      // until a reset says the engine cannot fill that number; they are inside the replay when it can.
      this.replayBuffer = held;
      this.replayAttempt = true;
      this.streamBuffering = true;
      this.streamBuffer = [];
      this.lastSeq = runStartSeq - 1;
      this.openStream(id, runStartSeq - 1, gen);
      return;
    }

    // no replay: the events held while the read was in flight are applied in arrival order
    this.streamBuffering = false;
    this.streamBuffer = [];
    for (const event of held) this.applyStream(gen, event);
  }

  /**
   * Leave a conversation and forget it: the selection, the body and the typed text all go. A side conversation
   * (a BTW branch or a card's consultation) uses this when the thing it belongs to is gone, so the frame never
   * shows one card's talk under the next card's name.
   */
  clear(): void {
    this.openGen += 1;
    this.ideaGen += 1;
    this.ideaConv += 1;
    this.ideaFor = null;
    this.ideaReceived = null;
    this.anchors = [];
    this.recordEntries = [];
    this.recordLeaf = null;
    this.recordFor = null;
    this.settingsSeq += 1;
    this.closeStream();
    this.stopReconnect();
    this.patch({ selectedId: null, open: null, settings: null });
  }

  /** leave the conversation screen: stop listening, keep the selection and the typed text */
  detach(): void {
    this.openGen += 1;
    this.ideaGen += 1;
    this.ideaConv += 1;
    this.ideaFor = null;
    this.ideaReceived = null;
    this.anchors = [];
    this.recordFor = null;
    this.settingsSeq += 1;
    this.closeStream();
    this.stopReconnect();
    if (this.state.open) this.patchOpen({ idea: emptyIdea() });
  }

  // ---- the idea doors ----

  /** read the idea document's status; a late answer for another conversation or generation is dropped */
  readIdea(id: string): Promise<void> {
    const gen = ++this.ideaGen;
    this.ideaFor = id;
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/idea`)
      .then(async (res) => {
        if (gen !== this.ideaGen || this.state.selectedId !== id) return;
        let body: IdeaStatusResponse | null = null;
        try { body = (await res.json()) as IdeaStatusResponse; } catch { return; }
        if (gen !== this.ideaGen || this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) return;
        // a gate was just approved and the run has not ended: the status's record line has no position yet, so
        // drawing it would jump the line to the head. The run's end rereads this and clears the mark (DEC-117-2).
        if (this.ideaReceived !== null) return;
        const document = body.document ?? null;
        this.anchors = document ? anchorsOf(document.gates) : [];
        this.ideaFor = id;
        this.patchIdea({ document, reason: typeof body.reason === "string" ? body.reason : null });
        this.refold();
      })
      .catch(() => undefined);
  }

  /**
   * Send one gate approval; a second press while it is in flight, or after it was received, sends nothing. The
   * answer belongs to the conversation, not to a status read: the run's end rereads the status while this answer
   * is still coming, and that reread must not drop the approval (the busy flag would never return). Only leaving,
   * reselecting or removing the conversation moves `ideaConv` and discards it.
   */
  approveGate(gate: 1 | 2): Promise<void> {
    const id = this.state.selectedId;
    const idea = this.state.open?.idea;
    if (!id || !idea || idea.gateBusy || idea.received) return Promise.resolve();
    const conv = this.ideaConv;
    this.patchIdea({ gateBusy: true, gateError: null });
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/idea/gates`, { method: "POST", body: JSON.stringify({ gate, action: "approve" }) })
      .then(async (res) => {
        if (conv !== this.ideaConv || this.state.selectedId !== id) return;
        const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (conv !== this.ideaConv || this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          this.patchIdea({ gateBusy: false, gateError: errorOf(body, res.status) });
          return;
        }
        // the notice the gate door sent is not on the branch yet: mark it received and wait for the run's end.
        // The read generation moves so a status read that began before the approval cannot undo the mark.
        this.ideaGen += 1;
        this.ideaReceived = { gate };
        this.patchIdea({ gateBusy: false, gateError: null, received: { gate } });
      })
      .catch(() => {
        if (conv === this.ideaConv && this.state.selectedId === id) this.patchIdea({ gateBusy: false, gateError: WORDS.errors.unreachable });
      });
  }

  /**
   * Ask the exit challenge, show the rows it returned, sign, and run those rows. The challenge's own answer is
   * placed on screen before the browser's prompt, so what penne sees is what the engine put in the signature
   * (INV-117-2). A conversation change after the request was sent drops its answer and never runs (AC-036/037).
   * A status reread of the same conversation while the browser's prompt is open (the run's end) must not: the
   * signature still runs, or the button would stay busy with nothing said.
   */
  signExits(): Promise<void> {
    const id = this.state.selectedId;
    const idea = this.state.open?.idea;
    if (!id || !idea || idea.exitBusy || !idea.document) return Promise.resolve();
    const conv = this.ideaConv;
    this.patchIdea({ exitBusy: true, exitError: null, outcomes: null, challenge: null });
    return signChallenge(
      { path: `/api/conversations/${encodeURIComponent(id)}/idea/exits/challenge`, body: { rpId: pageHostname(this.passkeyDeps) } },
      this.passkeyDeps,
      (answer: ChallengeAnswer) => {
        if (conv !== this.ideaConv || this.state.selectedId !== id) return;
        const rows = Array.isArray(answer.rows) ? (answer.rows as IdeaExitRowStatus[]) : [];
        const summary = answer.summary as IdeaExitSummary | undefined;
        if (summary) this.patchIdea({ challenge: { rows, summary } });
      },
    )
      .then((result) => {
        if (conv !== this.ideaConv || this.state.selectedId !== id) return;
        if (!result.ok) {
          this.patchIdea({ exitBusy: false, exitError: result.needsRegistration ? WORDS.sign.notRegistered : (result.error ?? WORDS.sign.cannot) });
          return;
        }
        const approval = result.approval;
        if (!approval) { this.patchIdea({ exitBusy: false }); return; }
        const answerRows = Array.isArray(result.answer?.rows) ? (result.answer?.rows as IdeaExitRowStatus[]) : (this.state.open?.idea?.challenge?.rows ?? []);
        const rows = answerRows.map((row) => row.id);
        return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/idea/exits/run`, { method: "POST", body: JSON.stringify({ nonce: approval.nonce, assertion: approval.assertion, rows }) })
          .then(async (res) => {
            if (conv !== this.ideaConv || this.state.selectedId !== id) return;
            const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; outcomes?: IdeaRunOutcome[] } | null;
            if (conv !== this.ideaConv || this.state.selectedId !== id) return;
            if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
              this.patchIdea({ exitBusy: false, exitError: errorOf(body, res.status) });
              return;
            }
            // the outcomes stay on the block; the status is reread so each row's own result lands too
            this.patchIdea({ exitBusy: false, exitError: null, outcomes: Array.isArray(body.outcomes) ? body.outcomes : null });
            void this.readIdea(id);
          })
          .catch(() => {
            if (conv === this.ideaConv && this.state.selectedId === id) this.patchIdea({ exitBusy: false, exitError: WORDS.errors.unreachable });
          });
      })
      .catch(() => {
        if (conv === this.ideaConv && this.state.selectedId === id) this.patchIdea({ exitBusy: false, exitError: WORDS.errors.unreachable });
      });
  }

  // ---- polling ----

  startPolling(): void {
    if (this.pollTimer) return;
    void this.readList();
    this.pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void this.readList();
    }, WORDS.chat.pollMs);
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // ---- operations ----

  newChat(draft = ""): Promise<void> {
    // the find field sits over every screen, so a New chat from it may be the first read of the conversation
    // store: the workspace is read first, because a conversation is made in a workspace's mode
    return this.ensureMode().then(() => {
      const mode = this.state.mode;
      if (!mode) return Promise.resolve();
      return this.fetchFn("/api/conversations", { method: "POST", body: JSON.stringify({ mode }) })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          if (res.status < 200 || res.status >= 300 || !body || typeof body.id !== "string") {
            this.patch({ receipt: errorOf(body, res.status) });
            return;
          }
          void this.readList();
          await this.select(body.id as string);
          // the word from the find field is left in the box, never sent: a search word is not a request (C-173-3)
          if (draft) this.patchDraft(body.id as string, draft);
        })
        .catch(() => this.patch({ receipt: WORDS.errors.unreachable }));
    });
  }

  /** read the workspaces when none is chosen yet, so a screen other than the conversation screen can make one */
  private ensureMode(): Promise<void> {
    if (this.state.mode) return Promise.resolve();
    return this.readWorkspaces();
  }

  /** read the candidate list for the open conversation; a failure keeps the open door's own model name */
  readModels(): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    const mine = ++this.modelsSeq;
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/models`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (mine !== this.modelsSeq) return;
        if (res.status < 200 || res.status >= 300 || !body) {
          this.patchOpen({ notice: errorOf(body, res.status) });
          return;
        }
        this.patchOpen({ models: modelsOf(body.models) });
      })
      .catch(() => undefined);
  }

  /** change the model; the display moves only to what the engine answered (INV-118-2) */
  setModel(model: string): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/model`, { method: "POST", body: JSON.stringify({ model }) })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          this.patchOpen({ notice: errorOf(body, res.status) });
          return;
        }
        this.patchOpen({
          notice: null,
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
          ...(Array.isArray(body.efforts) ? { efforts: strings(body.efforts) } : {}),
        });
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable }));
  }

  /** change the effort; the same answer-first rule as the model */
  setEffort(effort: string): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/model`, { method: "POST", body: JSON.stringify({ effort }) })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          this.patchOpen({ notice: errorOf(body, res.status) });
          return;
        }
        this.patchOpen({
          notice: null,
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
          ...(Array.isArray(body.efforts) ? { efforts: strings(body.efforts) } : {}),
        });
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable }));
  }

  /** change the conversation's type; the mode is never swapped (DEC-118-8) */
  setType(type: string): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/type`, { method: "POST", body: JSON.stringify({ type }) })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          this.patchOpen({ notice: errorOf(body, res.status) });
          return;
        }
        this.patchOpen({ notice: null, ...(typeof body.type === "string" ? { type: body.type } : {}) });
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable }));
  }

  send(text: string): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    const open = this.state.open;
    // a send already on its way owns the door: a second press in that window is dropped (F-116-6)
    if (!open || open.sending) return Promise.resolve();
    const images = this.attachmentsFor(id);
    if (images.length && !this.currentModelHasImage()) {
      this.patchOpen({ notice: WORDS.chat.attach.notAllowed });
      return Promise.resolve();
    }
    const mentions = this.mentionPayload();
    if (!text.trim() && !images.length && !mentions.length) return Promise.resolve();
    this.patchOpen({ notice: null, sending: true });
    // the body carries the text (and the pictures), with the identity of any pointed lane or card; the engine
    // reads the points back from its own state (C-167-4/5)
    const payload = { text, ...(images.length ? { images } : {}), ...(mentions.length ? { mentions } : {}) };
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify(payload) })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const here = this.state.selectedId === id;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          if (here) this.patchOpen({ notice: errorOf(body, res.status), sending: false });
          return;
        }
        // the door's own values are this conversation's: they are written only while it is the one on screen.
        // The accepted words leave the box in the conversation they were sent from either way, so returning to it
        // does not show the words that already went to pi; only the words this send carried leave it.
        if (here) {
          if (body.queue !== undefined) this.patchOpen({ queue: queueOf(body.queue) });
          if (typeof body.streaming === "boolean") this.patchOpen({ streaming: body.streaming });
          this.patchOpen({ sending: false });
        }
        this.patchDraft(id, draftAfterSend(this.draftFor(id), text));
        if (images.length) this.patchAttachments(id, []);
        // the pointed lanes and cards belong to the text that just went, so they are cleared with it
        if (mentions.length) this.patchMentions({ chosen: [], open: false, query: "" });
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable, sending: false }));
  }

  stop(): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/stop`, { method: "POST" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          this.patchOpen({ notice: errorOf(body, res.status) });
          return;
        }
        if (body.queue !== undefined) this.patchOpen({ queue: queueOf(body.queue) });
        this.patchOpen({ streaming: false });
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable }));
  }

  editQueue(itemId: string, text: string): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify({ text }) })
      .then(async (res) => {
        if (this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300) {
          const body = await res.json().catch(() => null);
          this.patchOpen({ notice: errorOf(body, res.status) });
        }
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable }));
  }

  cancelQueue(itemId: string): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`, { method: "DELETE" })
      .then(async (res) => {
        if (this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300) {
          const body = await res.json().catch(() => null);
          this.patchOpen({ notice: errorOf(body, res.status) });
        }
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable }));
  }

  steerQueue(itemId: string): Promise<void> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve();
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}/steer`, { method: "POST" })
      .then(async (res) => {
        if (this.state.selectedId !== id) return;
        if (res.status < 200 || res.status >= 300) {
          const body = await res.json().catch(() => null);
          this.patchOpen({ notice: errorOf(body, res.status) });
        }
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.errors.unreachable }));
  }

  // ---- a side branch: raise one into a conversation of the mode's own list (the cut itself is `side.ts`) ----

  /**
   * Raise this conversation into its mode's own conversation: the same id, and from then on it is in the list
   * (DEC-1846). Only a press asks for it; a branch that is never raised leaves nothing in the list.
   */
  promote(): Promise<{ ok: boolean; error: string | null }> {
    const id = this.state.selectedId;
    if (!id) return Promise.resolve({ ok: false, error: null });
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/promote`, { method: "POST" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          return { ok: false, error: errorOf(body, res.status) };
        }
        return { ok: true, error: null };
      })
      .catch(() => ({ ok: false, error: WORDS.errors.unreachable }));
  }

  // ---- the voice input: record once, transcribe once, add to the box it started in (DEC-118-7) ----

  startRecording(): Promise<void> {
    const id = this.state.selectedId;
    if (!id || !this.recorder || this.recording) return Promise.resolve();
    return this.recorder.start()
      .then((handle) => {
        this.recording = { id, handle };
        this.patchOpen({ recording: true });
      })
      .catch(() => this.patchOpenFor(id, { notice: WORDS.chat.voice.failed }));
  }

  /** stop, transcribe once, and append the text to the box of the conversation the recording began in */
  async stopRecording(): Promise<void> {
    const active = this.recording;
    if (!active) return;
    this.recording = null;
    this.patchOpen({ recording: false });
    let audio: { audio: Blob; contentType: string };
    try {
      audio = await active.handle.stop();
    } catch {
      this.patchOpenFor(active.id, { notice: WORDS.chat.voice.failed });
      return;
    }
    try {
      const res = await this.fetchFn("/api/transcriptions", { method: "POST", body: audio.audio, headers: { "Content-Type": audio.contentType } });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status < 200 || res.status >= 300 || !body || typeof body.text !== "string") {
        this.patchOpenFor(active.id, { notice: errorOf(body, res.status) });
        return;
      }
      // the text goes into the draft and nowhere else: the send door is never called (INV-118-6)
      this.patchDraft(active.id, this.draftFor(active.id) + body.text);
    } catch {
      this.patchOpenFor(active.id, { notice: WORDS.errors.unreachable });
    }
  }

  /** change one mark field; the list is read again only after the engine took it */
  setMark(id: string, patch: { pinned?: boolean; archived?: boolean; bookmarks?: string[] }): Promise<void> {
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}/marks`, { method: "PATCH", body: JSON.stringify(patch) })
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) {
          const body = await res.json().catch(() => null);
          this.patch({ markErrors: { ...this.state.markErrors, [id]: errorOf(body, res.status) } });
          return;
        }
        const clear = { ...this.state.markErrors };
        delete clear[id];
        this.patch({ markErrors: clear });
        void this.readList();
      })
      .catch(() => this.patch({ markErrors: { ...this.state.markErrors, [id]: WORDS.errors.unreachable } }));
  }

  /**
   * The bookmark menu has no kind the workspace defines to send. Nothing is sent to the marks door (a kind that
   * cannot exist would only be refused), and the row carries why so the press is not a silent failure.
   */
  refuseBookmarkMark(id: string): void {
    this.patch({ markErrors: { ...this.state.markErrors, [id]: WORDS.chat.row.noBookmarkKind } });
  }

  /** remove a conversation; the engine takes it first, and only then does the row leave the list */
  remove(id: string): Promise<void> {
    const summary = this.summaryFor(id);
    const title = summary?.name || WORDS.chat.untitled;
    return this.fetchFn(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) {
          const body = await res.json().catch(() => null);
          this.patch({ deleteErrors: { ...this.state.deleteErrors, [id]: errorOf(body, res.status) } });
          return;
        }
        const clear = { ...this.state.deleteErrors };
        delete clear[id];
        const wasSelected = this.state.selectedId === id;
        if (wasSelected) {
          this.closeStream();
          this.stopReconnect();
          this.openGen += 1;
          this.ideaGen += 1;
          this.ideaConv += 1;
          this.ideaFor = null;
          this.ideaReceived = null;
          this.anchors = [];
          this.recordFor = null;
        }
        this.patch({
          deleteErrors: clear,
          receipt: WORDS.chat.receipt.deleted(title),
          ...(wasSelected ? { selectedId: null, open: null } : {}),
        });
        void this.readList();
      })
      .catch(() => this.patch({ deleteErrors: { ...this.state.deleteErrors, [id]: WORDS.errors.unreachable } }));
  }

  clearReceipt(): void {
    if (this.state.receipt) this.patch({ receipt: null });
  }
}

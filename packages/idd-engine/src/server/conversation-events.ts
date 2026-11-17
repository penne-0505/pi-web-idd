import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "@idd/core";

/**
 * The engine's own vocabulary for a conversation's stream. pi's events are folded here so a client never
 * reads pi's shapes and the GUI is not bound to a pi version. The six kinds a client must be able to tell
 * apart are `text`, `thinking`, `tool_call`, `tool_result`, `cost` and `end`; the rest carry a committed
 * entry, a queue change, a model change, a failure, an extension request, or the request to reopen.
 */
export type ConversationEventType =
  | "text" | "thinking" | "tool_call" | "tool_result" | "cost" | "end"
  | "entry" | "queue" | "model" | "error" | "extension" | "reset" | "state" | "name" | "context"
  | "run_start" | "tool_call_delta" | "tool_progress"
  | "compaction_start" | "compaction_end" | "retry_start" | "retry_end";

export interface ConversationEvent {
  seq: number;
  type: ConversationEventType;
  [key: string]: unknown;
}

/** the six kinds an SSE client must be able to tell apart */
export const CONVERSATION_EVENT_KINDS: readonly ConversationEventType[] = Object.freeze(["text", "thinking", "tool_call", "tool_result", "cost", "end"]);

const BUFFER_LIMIT = 2000;

/**
 * The highest number any log in this process has handed out. A conversation opened again gets a fresh log, and
 * its first number must be beyond everything the same session's earlier log could have emitted, or an
 * EventSource still carrying an old id would take the new events for a continuation of the old ones. The time
 * gives most of that distance; this is the floor for two logs made in the same millisecond.
 */
let processMaxSeq = 0;

/**
 * A conversation's numbered event stream, held in memory only: the history stays in pi's own records, so
 * this buffer is a reconnect window, not a store. A reconnect with an id the buffer no longer holds is
 * answered with a `reset` first (the client must reopen), never with a silent gap.
 */
export class ConversationLog {
  private readonly start: number;
  private next: number;
  private buffer: ConversationEvent[] = [];
  private listeners = new Set<(event: ConversationEvent) => void>();

  constructor(seed = Date.now()) {
    // never below a number an earlier log in this process already used, and never below the time, so the
    // number a fresh connection is handed is distinguishable from "no number" (0)
    this.start = Math.max(seed, processMaxSeq + 1);
    this.next = this.start;
  }

  emit(type: ConversationEventType, fields: Record<string, unknown> = {}): ConversationEvent {
    const event: ConversationEvent = { seq: this.next, type, ...fields };
    this.next += 1;
    if (event.seq > processMaxSeq) processMaxSeq = event.seq;
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_LIMIT) this.buffer = this.buffer.slice(-BUFFER_LIMIT);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one slow client must not stop the others */ }
    }
    return event;
  }

  /** the events after `lastId`, and whether the client must reopen because the gap cannot be filled */
  since(lastId: number): { reset: boolean; events: ConversationEvent[] } {
    // a fresh connection (no id) starts live: the history is pi's, read through `open`, and replaying the
    // buffer here would re-show events a client already has
    if (lastId <= 0) return { reset: false, events: [] };
    // the id is older than the first number this log can hand out (an earlier log's window, even one that
    // emitted nothing), from a later number than this log has reached, or before the buffer's first kept
    // event: the gap is lost
    if (lastId >= this.next || lastId < this.start - 1 || (this.buffer.length > 0 && lastId < this.buffer[0].seq - 1)) {
      return { reset: true, events: [...this.buffer] };
    }
    return { reset: false, events: this.buffer.filter((e) => e.seq > lastId) };
  }

  /** the number a fresh connection is handed: the last event's, or the one just before the first event */
  get lastSeq(): number {
    return this.next - 1;
  }

  subscribe(listener: (event: ConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.buffer = [];
    this.listeners.clear();
  }
}

/** one assistant turn's token use and cost, as pi reports it */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number } | number;
}

export function costTotalOf(usage: PiUsage | undefined): number {
  if (!usage) return 0;
  if (typeof usage.cost === "number") return usage.cost;
  const total = usage.cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

export interface FoldedEvent {
  kind: "text" | "thinking" | "tool_call" | "tool_call_delta" | "tool_result" | "tool_progress"
    | "entry" | "cost" | "effort"
    | "run_start" | "compaction_start" | "compaction_end" | "retry_start" | "retry_end";
  fields: Record<string, unknown>;
  usage?: PiUsage;
}

/** the id and name of a tool call being streamed, read from pi's partial message */
function streamedToolCall(update: Record<string, unknown>): { id?: string; name?: string } {
  const partial = update.partial as { content?: unknown } | undefined;
  const content = partial?.content;
  const contentIndex = update.contentIndex;
  if (!Array.isArray(content) || typeof contentIndex !== "number") return {};
  const block = content[contentIndex] as Record<string, unknown> | undefined;
  if (!block || block.type !== "toolCall") return {};
  const id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : undefined;
  const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : undefined;
  return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
}

function contentIndexOf(update: Record<string, unknown>): number | undefined {
  return typeof update.contentIndex === "number" ? update.contentIndex : undefined;
}

/**
 * Fold one pi record into the engine's events. Anything the engine does not know is dropped; the run's end
 * is not folded here, because it is pi's `agent_settled` and only the conversation knows whether a run was
 * ours and how it ended.
 */
export function foldPiEvent(record: { type?: string; [key: string]: unknown }): FoldedEvent[] {
  switch (record.type) {
    case "agent_start":
      return [{ kind: "run_start", fields: {} }];
    case "message_update": {
      const update = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!update) return [];
      const contentIndex = contentIndexOf(update);
      if (update.type === "text_delta" && typeof update.delta === "string") {
        return [{ kind: "text", fields: { delta: update.delta, ...(contentIndex !== undefined ? { contentIndex } : {}) } }];
      }
      if (update.type === "thinking_delta" && typeof update.delta === "string") {
        return [{ kind: "thinking", fields: { delta: update.delta, ...(contentIndex !== undefined ? { contentIndex } : {}) } }];
      }
      if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
        const { id, name } = streamedToolCall(update);
        return [{
          kind: "tool_call_delta",
          fields: {
            phase: update.type === "toolcall_start" ? "start" : "delta",
            ...(contentIndex !== undefined ? { contentIndex } : {}),
            ...(id ? { toolCallId: id } : {}),
            ...(name ? { name } : {}),
            ...(typeof update.delta === "string" ? { delta: update.delta } : {}),
          },
        }];
      }
      return [];
    }
    case "tool_execution_start":
      return [{ kind: "tool_call", fields: { toolCallId: record.toolCallId, name: record.toolName, args: record.args ?? null } }];
    case "tool_execution_update":
      return [{ kind: "tool_progress", fields: { toolCallId: record.toolCallId, name: record.toolName, partialResult: record.partialResult ?? null } }];
    case "tool_execution_end":
      return [{ kind: "tool_result", fields: { toolCallId: record.toolCallId, name: record.toolName, result: record.result ?? null, isError: record.isError === true } }];
    case "message_end": {
      const message = record.message as { role?: string; stopReason?: string; usage?: PiUsage } | undefined;
      if (!message) return [];
      const events: FoldedEvent[] = [{ kind: "entry", fields: { role: message.role, message } }];
      if (message.role === "assistant" && message.usage) events.push({ kind: "cost", fields: {}, usage: message.usage });
      return events;
    }
    case "compaction_start":
      return [{ kind: "compaction_start", fields: { reason: record.reason ?? null } }];
    case "auto_compaction_start":
      return [{ kind: "compaction_start", fields: { reason: record.reason ?? "threshold" } }];
    case "compaction_end":
    case "auto_compaction_end": {
      const result = record.result as { usage?: PiUsage; tokensBefore?: unknown; estimatedTokensAfter?: unknown } | undefined;
      const events: FoldedEvent[] = [{
        kind: "compaction_end",
        fields: {
          reason: record.reason ?? "threshold",
          ...(result ? { result: { ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}), ...(result.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}) } } : {}),
          aborted: record.aborted === true,
          willRetry: record.willRetry === true,
          ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
        },
      }];
      if (result?.usage) events.push({ kind: "cost", fields: { compaction: true }, usage: result.usage });
      return events;
    }
    case "auto_retry_start":
      return [{ kind: "retry_start", fields: { attempt: record.attempt, maxAttempts: record.maxAttempts, delayMs: record.delayMs, errorMessage: record.errorMessage } }];
    case "auto_retry_end":
      return [{ kind: "retry_end", fields: { success: record.success === true, attempt: record.attempt, ...(typeof record.finalError === "string" ? { finalError: record.finalError } : {}) } }];
    case "thinking_level_changed":
      return typeof record.level === "string" ? [{ kind: "effort", fields: { effort: record.level } }] : [];
    default:
      return [];
  }
}

// ---- the cost ledger ----

export interface CostLine {
  at: string;
  sessionId: string;
  mode: string;
  role: string;
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  compaction?: true;
  /** the one-shot title generation, marked apart from what the conversation's own pi spent */
  title?: true;
  /** an ephemeral branch's own response, kept apart so the parent's copied responses are never counted twice */
  ephemeral?: true;
  /** the parent session the branch was cut from */
  parentSessionId?: string;
  /** a consult branch's own response: marked so the lane's cost never counts it, and traceable to its card */
  consult?: true;
  consultKind?: string;
  iddId?: string;
  batchId?: string;
}

/** <state>/pipeline/conversation-cost.jsonl: append-only, never read by the lane's cost or budget */
export function conversationCostPath(): string {
  return join(stateDir(), "pipeline", "conversation-cost.jsonl");
}

export function appendCostLine(line: CostLine): void {
  const path = conversationCostPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
}

export function readCostLines(): CostLine[] {
  const path = conversationCostPath();
  if (!existsSync(path)) return [];
  const out: CostLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw) as CostLine); } catch { /* a partial line */ }
  }
  return out;
}

/** what one conversation has cost in total, across responses and across an engine restart */
export function conversationCostOf(sessionId: string): number {
  let total = 0;
  for (const line of readCostLines()) if (line.sessionId === sessionId) total += Number(line.cost) || 0;
  return Number(total.toFixed(6));
}

/**
 * One way of turning a conversation into the list on screen. The record the open door returns and the events the
 * stream carries are folded by the same functions into the same display shape, so what is read and what is
 * streamed cannot disagree (the plan's record fold and its stream fold). Nothing here sends anything: the store
 * does that, and calls these when a value arrives.
 *
 * The narrow entry shapes below describe only the fields this fold reads. They are deliberately not the engine's
 * conversation types: pi records pi's own shapes, and this file is not a second copy of the door's contract.
 */

/** one event from the numbered stream, as the engine's vocabulary names it */
export interface StreamEvent {
  seq?: number;
  type: string;
  [key: string]: unknown;
}

/** one tool call, with its result once the result lands */
export interface ChatToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
  result?: unknown;
  isError: boolean;
  done: boolean;
}

export type ChatItemKind = "user" | "assistant" | "thinking" | "tools" | "compaction" | "context" | "gate";

/**
 * One gate record as the body draws it: the gate, whether it was an approval or a redo, and the stage the engine
 * read for that record. The screen never derives the stage from the records: it is the value the engine answered.
 */
export interface GateMark {
  gate: 1 | 2;
  action: "approve" | "redo";
  /** the stage the engine read up to this record (探索 · ゲート1 · 凍結) */
  stage: string;
}

/** where one gate record sits: the branch entry it first appeared at, or null when it is not on this branch */
export interface GateAnchor {
  entryId: string | null;
  mark: GateMark;
}

/** one displayed piece of the conversation */
export interface ChatItem {
  key: string;
  kind: ChatItemKind;
  text: string;
  /** a tool bundle's calls, in the order they were made */
  calls?: ChatToolCall[];
  /** the message role the item was committed from, used to fold a stream entry onto the record without repeating it */
  role?: string;
  /** the message's own time as pi wrote it (a number) or a sample record wrote it (a string) */
  timestamp?: string | number;
  /** the block an assistant text or thinking delta belongs to */
  contentIndex?: number;
  /** a gate record's line, drawn where the engine said the record first appeared */
  gate?: GateMark;
  /** true while the item came from the live stream and no committed entry has replaced it */
  live?: boolean;
}

interface RawMessage {
  role?: unknown;
  timestamp?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}

interface RawEntry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  timestamp?: unknown;
  summary?: unknown;
  customType?: unknown;
  display?: unknown;
  content?: unknown;
  message?: RawMessage;
  [key: string]: unknown;
}

let keySeq = 0;

function nextKey(kind: string): string {
  keySeq += 1;
  return `${kind}-${keySeq}`;
}

/** the text of a message content, whether it is a string or pi's block list */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  const out: Record<string, unknown>[] = [];
  for (const raw of content) if (raw && typeof raw === "object") out.push(raw as Record<string, unknown>);
  return out;
}

function findCall(items: ChatItem[], toolCallId: string): ChatToolCall | null {
  for (const item of items) {
    if (!item.calls) continue;
    const call = item.calls.find((entry) => entry.toolCallId === toolCallId);
    if (call) return call;
  }
  return null;
}

/**
 * Fold a call onto the list: an id that already has a call is updated in place, a new one joins the last bundle.
 * A bundle the stream grows is live, a bundle the record's committed entry spells out is not, so a following entry
 * does not drop the record's own calls as if they were a preview (the plan's record fold).
 */
function addCall(items: ChatItem[], call: ChatToolCall, live: boolean): ChatItem[] {
  let found = false;
  const next = items.map((item) => {
    if (!item.calls) return item;
    const at = item.calls.findIndex((entry) => entry.toolCallId === call.toolCallId);
    if (at < 0) return item;
    found = true;
    const calls = item.calls.slice();
    calls[at] = { ...calls[at], ...call };
    return { ...item, calls };
  });
  if (found) return next;
  const last = next[next.length - 1];
  if (last && last.kind === "tools" && last.calls) {
    const calls = [...last.calls, call];
    return [...next.slice(0, -1), { ...last, calls }];
  }
  return [...next, { key: nextKey("tools"), kind: "tools", text: "", calls: [call], ...(live ? { live: true } : {}) }];
}

/** a message time as a comparable key: pi writes numbers, the sample records write strings, and either meets the same one */
function stampKey(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** the record entry ids from the leaf up to the root, in display order */
export function branchEntries(entries: unknown[], leafId: string | null): RawEntry[] {
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
    current = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  return path.reverse();
}

function compactionItem(summary: unknown): ChatItem {
  return { key: nextKey("compaction"), kind: "compaction", text: typeof summary === "string" ? summary : "" };
}

function gateItem(mark: GateMark): ChatItem {
  return { key: nextKey("gate"), kind: "gate", text: "", gate: mark };
}

/**
 * Fold one committed message onto the list. A message whose role and time are already on the list is not added
 * again, so the record and a stream entry that carries the same utterance meet as one (the plan's overlap rule).
 * An assistant entry replaces the live items of the turn it commits, because the deltas and the entry are two
 * views of one message and keeping both would show the text twice.
 */
function commitMessage(items: ChatItem[], role: string, message: RawMessage): ChatItem[] {
  const timestamp = typeof message.timestamp === "string" ? message.timestamp : typeof message.timestamp === "number" ? message.timestamp : undefined;
  const stamp = stampKey(message.timestamp);
  const already = stamp !== null && items.some((item) => item.role === role && stampKey(item.timestamp) === stamp);

  let next = items;
  const liveCalls: ChatToolCall[] = [];
  if (role === "assistant") {
    // the trailing live text, thinking and tool stubs are the preview of the message this entry commits. The
    // preview's calls are kept so a call the entry does not spell out is not lost; the entry's own calls meet
    // the preview's by id (the plan's overlap rule).
    let at = next.length;
    while (at > 0 && next[at - 1].live) at -= 1;
    if (at < next.length) {
      for (const item of next.slice(at)) if (item.calls) liveCalls.push(...item.calls);
      next = next.slice(0, at);
    }
  }

  if (!already) {
    if (role === "assistant") {
      const blocks = blocksOf(message.content);
      if (blocks.length === 0) {
        const text = textOf(message.content);
        if (text) next = [...next, { key: nextKey("assistant"), kind: "assistant", text, role, timestamp }];
      } else {
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            next = [...next, { key: nextKey("assistant"), kind: "assistant", text: block.text, role, timestamp }];
            continue;
          }
          if (block.type === "thinking" && typeof block.thinking === "string") {
            next = [...next, { key: nextKey("thinking"), kind: "thinking", text: block.thinking, role, timestamp }];
            continue;
          }
          if (block.type === "toolCall") {
            const id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : "";
            const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : "";
            const existing = id ? findCall(next, id) : null;
            next = addCall(next, {
              toolCallId: id,
              name: name || existing?.name || "",
              input: block.arguments ?? existing?.input ?? null,
              ...(existing?.result !== undefined ? { result: existing.result } : {}),
              isError: existing?.isError ?? false,
              done: existing?.done ?? false,
            }, false);
          }
        }
      }
    } else if (role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const existing = id ? findCall(next, id) : null;
      next = addCall(next, {
        toolCallId: id,
        name: (typeof message.toolName === "string" ? message.toolName : "") || existing?.name || "",
        input: existing?.input ?? null,
        result: message.content ?? null,
        isError: message.isError === true,
        done: true,
      }, false);
    } else if (role === "user") {
      const text = textOf(message.content);
      if (text) next = [...next, { key: nextKey("user"), kind: "user", text, role, timestamp }];
    }
  }

  // keep a live call the committed entry did not describe, so no call disappears when an entry lands over a preview
  for (const call of liveCalls) if (!findCall(next, call.toolCallId)) next = addCall(next, call, false);
  return next;
}

/** fold one record entry; the displayable kinds are messages, compaction marks and shown context utterances */
function commitEntry(items: ChatItem[], entry: RawEntry): ChatItem[] {
  if (entry.type === "message" && entry.message) {
    const role = typeof entry.message.role === "string" ? entry.message.role : "";
    if (!role || role === "system") return items;
    return commitMessage(items, role, entry.message);
  }
  if (entry.type === "compaction") return [...items, compactionItem(entry.summary)];
  if (entry.type === "custom_message" && entry.display === true) {
    const text = textOf(entry.content);
    if (!text) return items;
    return [...items, { key: nextKey("context"), kind: "context", text, live: false }];
  }
  return items;
}

/**
 * The list the open door's record describes: the branch from its leaf to the root, folded in order. A null leaf
 * names no branch, so the list is empty. A record header (`type: "session"`) never arrives here; if one did, it
 * is not one of the kinds this fold draws.
 *
 * The gate lines come from `anchors`, the engine's own answer for where each record first appeared. A line is
 * added after every item of its entry, so a tool bundle the following entry grew is cut by the line (the gate is
 * the boundary between what came before and after the approval: the fold must not carry a call across it). A
 * record with no position, or one whose entry is not on this branch, is drawn at the head. With no anchors the
 * column is exactly what the record alone describes.
 */
export function foldEntries(entries: unknown[], leafId: string | null, anchors: readonly GateAnchor[] = []): ChatItem[] {
  if (!leafId) return [];
  const branch = branchEntries(entries, leafId);
  const onBranch = new Set(branch.map((entry) => String(entry.id)));
  const at = new Map<string, GateMark[]>();
  const head: GateMark[] = [];
  for (const anchor of anchors) {
    if (anchor.entryId && onBranch.has(anchor.entryId)) {
      const list = at.get(anchor.entryId) ?? [];
      list.push(anchor.mark);
      at.set(anchor.entryId, list);
    } else {
      head.push(anchor.mark);
    }
  }
  let items: ChatItem[] = head.map(gateItem);
  for (const entry of branch) {
    items = commitEntry(items, entry);
    const marks = typeof entry.id === "string" ? at.get(entry.id) : undefined;
    if (marks) items = [...items, ...marks.map(gateItem)];
  }
  return items;
}

function appendDelta(items: ChatItem[], kind: "assistant" | "thinking", delta: string, contentIndex: number | undefined): ChatItem[] {
  let at = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === kind && item.live && item.contentIndex === contentIndex) {
      at = i;
      break;
    }
  }
  if (at >= 0) {
    const next = items.slice();
    next[at] = { ...next[at], text: next[at].text + delta };
    return next;
  }
  return [...items, { key: nextKey(kind), kind, text: delta, ...(contentIndex !== undefined ? { contentIndex } : {}), live: true }];
}

/**
 * Fold one stream event onto the list. The deltas grow the turn's blocks by `contentIndex`; a tool call's start,
 * progress and result land in the trailing bundle; a committed entry replaces the live turn it belongs to; a
 * compaction end leaves its mark. Unknown events change nothing, so the engine may add vocabulary without this
 * fold showing it wrongly.
 */
export function applyEvent(items: ChatItem[], event: StreamEvent): ChatItem[] {
  switch (event.type) {
    case "text": {
      if (typeof event.delta !== "string") return items;
      return appendDelta(items, "assistant", event.delta, typeof event.contentIndex === "number" ? event.contentIndex : undefined);
    }
    case "thinking": {
      if (typeof event.delta !== "string") return items;
      return appendDelta(items, "thinking", event.delta, typeof event.contentIndex === "number" ? event.contentIndex : undefined);
    }
    case "tool_call_delta": {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) return items;
      const existing = findCall(items, id);
      return addCall(items, {
        toolCallId: id,
        name: (typeof event.name === "string" ? event.name : "") || existing?.name || "",
        input: existing?.input ?? null,
        ...(existing?.result !== undefined ? { result: existing.result } : {}),
        isError: existing?.isError ?? false,
        done: existing?.done ?? false,
      }, true);
    }
    case "tool_call": {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) return items;
      const existing = findCall(items, id);
      return addCall(items, {
        toolCallId: id,
        name: (typeof event.name === "string" ? event.name : "") || existing?.name || "",
        input: event.args ?? existing?.input ?? null,
        ...(existing?.result !== undefined ? { result: existing.result } : {}),
        isError: existing?.isError ?? false,
        done: existing?.done ?? false,
      }, true);
    }
    case "tool_result": {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) return items;
      const existing = findCall(items, id);
      return addCall(items, {
        toolCallId: id,
        name: (typeof event.name === "string" ? event.name : "") || existing?.name || "",
        input: existing?.input ?? null,
        result: event.result ?? null,
        isError: event.isError === true,
        done: true,
      }, true);
    }
    case "entry": {
      const role = typeof event.role === "string" ? event.role : "";
      if (!role) return items;
      const message = (event.message && typeof event.message === "object" ? event.message : {}) as RawMessage;
      return commitMessage(items, role, message);
    }
    case "compaction_end": {
      return [...items, compactionItem(undefined)];
    }
    default:
      return items;
  }
}

/** true when any call in any bundle failed, so the folded row shows the attention mark */
export function bundleFailed(calls: ChatToolCall[]): boolean {
  return calls.some((call) => call.isError);
}

/** the tool names in a bundle, without repeats, in the order they first appear */
export function bundleNames(calls: ChatToolCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) if (call.name && !out.includes(call.name)) out.push(call.name);
  return out;
}

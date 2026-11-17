/**
 * The conversation screen's values, built from the engine's answers alone. `ChatStore` holds what the engine
 * returned; this turns it into the rows, the body and the input the ported components read, and pairs every
 * operation with the door that carries it. Nothing here invents a value: a field the engine did not return is
 * empty and a refusal is drawn as it came (DEC-103-1, DEC-103-2).
 *
 * The list and the body are the engine's own shapes: the groups carry the engine's headings and order (DEC-116-1),
 * and a row's marks are read from the summary's own fields. The delete waits here as a value — one press opens the
 * confirm, only the second press on the same row carries the id the door may be called with (DEC-116-7).
 */

import type { ConversationModelOption, ConversationNotice, ConversationSummary } from "../engine/contract";
import { WORDS } from "../strings";
import type { ChatItem, ChatToolCall } from "./fold";
import { bundleFailed, bundleNames } from "./fold";
import { parseMarkdown, type Inline, type MdBlock } from "./markdown";
import type { SideState } from "./side";
import type { AttachedImage, BookmarkOption, ChatOpen, ChatStoreState, QuotaProvider } from "./store";
import { filterMentions } from "./store";
import { filterModels } from "./store";
import { listIntent, toggleArchived, toggleBookmark, togglePinned, type ListPress, type MarkToggle } from "./intents";

// ------------------------------------------------------------------ the list

export interface ChatRowView {
  id: string;
  /** the engine's name for the conversation; an unnamed one is drawn as the screen's own 無題 */
  title: string;
  /** this row is the open conversation */
  active: boolean;
  /** pi is answering it now */
  running: boolean;
  /** the conversation's type, when its mode defines one: the idea mark */
  idea: boolean;
  pinned: boolean;
  bookmarked: boolean;
  archived: boolean;
  /** the engine's refusal of this row's last mark or delete */
  error: string | null;
  /** this row's delete waits for a second press (DEC-116-7) */
  confirming: boolean;
  menuOpen: boolean;
  select: () => void;
  toggleMenu: () => void;
  mark: (kind: "pin" | "archive" | "bookmark") => void;
  remove: () => void;
}

export interface ChatGroupView {
  key: string;
  /** the engine's own heading for the group (今日 / 昨日 / ピン留め …) */
  label: string;
  rows: ChatRowView[];
}

export interface ChatListView {
  /** the open conversation's name, or the screen's own line when none is open */
  title: string;
  groups: ChatGroupView[];
  /** the engine cannot be reached: the last picture stays and the band says so */
  down: boolean;
  attempt: number;
  retry: () => void;
  /** the line left after a conversation was removed */
  receipt: string | null;
  clearReceipt: () => void;
  newChat: () => void;
  empty: boolean;
}

/** the list's own presses: the menu, the waiting delete and the marks, as values a test can drive (DEC-116-7) */
export interface ChatListUi {
  /** the row whose menu is open, or null */
  menu: string | null;
  /** the row whose delete waits for a second press, or null */
  confirming: string | null;
}

export const EMPTY_LIST_UI: ChatListUi = { menu: null, confirming: null };

export function listAction(ui: ChatListUi, press: ListPress): { ui: ChatListUi; remove: string | null } {
  const decision = listIntent({ menu: ui.menu, confirming: ui.confirming }, press);
  return { ui: { menu: decision.next.menu, confirming: decision.next.confirming }, remove: decision.remove };
}

/**
 * The mark one row's menu item toggles, from the value that row shows. A bookmark's menu item names an operation,
 * not a kind: the marks door only takes a kind the workspace itself defines, so the kind is read from the engine's
 * own list (the one the row already carries first) and the menu's own name is never sent as a kind. With no kind
 * defined there is nothing to send, and the screen says why instead of the engine refusing a kind that cannot be.
 */
export function markAction(
  summary: ConversationSummary,
  kind: "pin" | "archive" | "bookmark",
  bookmarkKinds: readonly BookmarkOption[] = [],
): MarkToggle | null {
  if (kind === "pin") return togglePinned(summary.id, summary.pinned);
  if (kind === "archive") return toggleArchived(summary.id, summary.archived);
  const chosen = bookmarkKinds.find((entry) => summary.bookmarks.includes(entry.id)) ?? bookmarkKinds[0];
  if (!chosen) return null;
  return toggleBookmark(summary.id, summary.bookmarks, chosen.id);
}

// ------------------------------------------------------------------ the body

export interface ChatBlockView {
  kind: "paragraph" | "code";
  /** a code block's language, as the fence named it */
  lang: string;
  inlines: Inline[];
  text: string;
}

export interface ChatToolRowView {
  /** 道具 3 回 · read · grep */
  label: string;
  /** a call that failed, so the row carries the attention mark (DEC-116-9) */
  failed: boolean;
  /** a call that has not come back yet */
  running: boolean;
}

export interface ChatBodyItemView {
  key: string;
  kind: ChatItem["kind"];
  text: string;
  /** an assistant message's blocks, drawn as React children and never as markup (DEC-116-8) */
  blocks: ChatBlockView[];
  /** a tool bundle's one folded row */
  tool?: ChatToolRowView;
  /** a gate record's line, from the engine's own anchor (the gate and the stage it read) */
  gate?: string;
  /** the body is still coming: the caret sits after this item */
  caret: boolean;
  /** a live delta the record has not committed yet */
  live: boolean;
}

export interface ChatBodyView {
  items: ChatBodyItemView[];
  streaming: boolean;
  /** the run's beginning was lost, so the body starts mid-response */
  partial: string | null;
  /** why the conversation could not be opened, in place of the body */
  error: string | null;
  loading: boolean;
  /** why the last operation was refused, above the input */
  notice: string | null;
  /** no conversation is open: the screen asks for one (the prototype has no body of its own for it) */
  pick: string | null;
  /** the conversation is open and holds nothing yet */
  empty: string | null;
}

function blocksOf(text: string): ChatBlockView[] {
  return (parseMarkdown(text) as MdBlock[]).map((block) =>
    block.kind === "code"
      ? { kind: "code", lang: block.lang, inlines: [], text: block.text }
      : { kind: "paragraph", lang: "", inlines: block.inlines, text: "" },
  );
}

function toolRow(calls: ChatToolCall[]): ChatToolRowView {
  const names = bundleNames(calls).join(" · ");
  return {
    label: WORDS.chat.toolRow(calls.length, names),
    failed: bundleFailed(calls),
    running: calls.some((call) => !call.done),
  };
}

function gateLine(mark: NonNullable<ChatItem["gate"]>): string {
  const label = mark.action === "approve" ? WORDS.chat.idea.gateApproved(mark.gate) : WORDS.chat.idea.gateRedo(mark.gate);
  return mark.stage ? `${label} · ${mark.stage}` : label;
}

/** one folded item, with the values of its kind filled and the others left empty */
export function bodyItemView(item: ChatItem, streaming: boolean, last: boolean): ChatBodyItemView {
  const caret = streaming && last;
  const base: ChatBodyItemView = { key: item.key, kind: item.kind, text: item.text, blocks: [], caret, live: item.live === true };
  if (item.kind === "assistant") return { ...base, blocks: blocksOf(item.text) };
  if (item.kind === "tools") return { ...base, tool: toolRow(item.calls ?? []), text: "" };
  if (item.kind === "thinking") return { ...base, text: item.text };
  if (item.kind === "compaction") return { ...base, text: WORDS.chat.compactionRow };
  if (item.kind === "context") return { ...base, text: `${WORDS.chat.contextRow} · ${item.text}` };
  if (item.kind === "gate") return { ...base, text: item.gate ? gateLine(item.gate) : "", blocks: [] };
  return base;
}

export function bodyOf(open: ChatOpen | null, pick: boolean): ChatBodyView {
  const partial = open?.partial ? WORDS.chat.partial : null;
  if (!open) {
    return {
      items: [], streaming: false, partial: null, error: null, loading: false, notice: null,
      pick: pick ? WORDS.chat.pickTitle : null, empty: pick ? WORDS.chat.pickReason : null,
    };
  }
  const streaming = open.streaming && !open.error;
  const last = open.items.length - 1;
  return {
    items: open.items.map((item, index) => bodyItemView(item, streaming, index === last)),
    streaming,
    partial,
    error: open.error,
    loading: open.loading,
    notice: open.notice,
    pick: null,
    empty: !open.error && !open.items.length && !open.loading ? WORDS.chat.bodyEmpty : null,
  };
}

// ------------------------------------------------------------------ the input

export interface ChatQueueView {
  id: string;
  /** Queued 1 — the engine's queue holds the order, so the number is the position in it */
  number: number;
  label: string;
  text: string;
  editing: boolean;
  edited: string;
  startEdit: () => void;
  setEdited: (text: string) => void;
  confirmEdit: () => void;
  cancelEdit: () => void;
  cancel: () => void;
  steer: () => void;
}

export interface ChatTypeOptionView {
  name: string;
  label: string;
  active: boolean;
  go: () => void;
}

export interface ChatModelOptionView {
  id: string;
  name: string;
  /** the window's size, as the engine named it; empty when it did not */
  window: string;
  /** only the capabilities pi's own definition names (DEC-118-2) */
  capabilities: ("image" | "reasoning")[];
  active: boolean;
  go: () => void;
}

export interface ChatContextView {
  /** the control opened: the quota reading is read while it shows (the engine owns the figures) */
  open: () => void;
  /** the rounded percentage pi reported, or null when it reported none */
  percent: number | null;
  tokens: number | null;
  contextWindow: number | null;
  /** this conversation's cost, in the engine's own figure */
  cost: number;
  quota: QuotaProvider[];
}

export interface ChatMentionOptionView {
  key: string;
  label: string;
  hint: string;
  active: boolean;
  choose: () => void;
}

export interface ChatMentionChipView {
  key: string;
  label: string;
  remove: () => void;
}

export interface ChatMentionsView {
  /** the picker is showing */
  open: boolean;
  query: string;
  loading: boolean;
  error: string | null;
  options: ChatMentionOptionView[];
  chosen: ChatMentionChipView[];
  openPicker: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  hint: string;
  labels: { title: string; open: string; search: string; empty: string; chosen: (n: number) => string };
}

export interface ChatComposerView {
  draft: string;
  setDraft: (text: string) => void;
  placeholder: string;
  send: () => void;
  stop: () => void;
  /** a run is with the engine: the one button stops it */
  streaming: boolean;
  /** a send is on its way; the door is not called again in that window */
  sending: boolean;
  canSend: boolean;
  /** the engine's refusal of the last operation */
  notice: string | null;
  /** the warnings the engine decided on, along the input's top edge (DEC-118-4) */
  notices: string[];
  queue: ChatQueueView[];
  types: ChatTypeOptionView[];
  /** the conversation's current type, when its mode defines types */
  type: string;
  model: {
    /** the engine's model id, or the empty string */
    current: string;
    /** the name the open door reported, so a failed candidates read never blanks the button */
    label: string;
    query: string;
    setQuery: (query: string) => void;
    options: ChatModelOptionView[];
    empty: string;
  };
  effort: {
    current: string;
    label: string;
    levels: { name: string; label: string; active: boolean; go: () => void }[];
  };
  context: ChatContextView;
  attach: {
    /** the current model takes images: only then is ＋ a way in (DEC-118-5) */
    allowed: boolean;
    images: AttachedImage[];
    hint: string;
    add: (images: AttachedImage[]) => void;
    remove: (index: number) => void;
  };
  mentions: ChatMentionsView;
}

/** the display name of an effort level; a level the table does not name is drawn as the engine named it */
export function effortLabel(level: string): string {
  return (WORDS.chat.effortLevels as Record<string, string>)[level] ?? level;
}

function noticeLabel(notice: ConversationNotice): string {
  if (notice.kind === "context") return WORDS.chat.notices.context(notice.percent);
  return WORDS.chat.notices.quota(notice.label, notice.utilization);
}

function windowLabel(option: ConversationModelOption): string {
  return option.contextWindow === null ? "" : String(option.contextWindow);
}

export interface ChatUi {
  list: ChatListUi;
  /** the queue chip being edited, or null */
  queueEdit: { id: string; text: string } | null;
  /** what the model popover's search holds */
  modelQuery: string;
}

export const EMPTY_CHAT_UI: ChatUi = { list: EMPTY_LIST_UI, queueEdit: null, modelQuery: "" };

export interface ChatHandlers {
  // the list
  listSelect: (id: string) => void;
  listMenu: (id: string) => void;
  listMark: (id: string, kind: "pin" | "archive" | "bookmark") => void;
  listDelete: (id: string) => void;
  listRetry: () => void;
  listClearReceipt: () => void;
  newChat: () => void;
  // the input
  send: () => void;
  stop: () => void;
  setDraft: (text: string) => void;
  queueEdit: (id: string | null, text?: string) => void;
  queueConfirm: (id: string, text: string) => void;
  queueCancel: (id: string) => void;
  queueSteer: (id: string) => void;
  pickModel: (model: string) => void;
  pickEffort: (effort: string) => void;
  pickType: (type: string) => void;
  modelQuery: (query: string) => void;
  /** the Context control opened: the quota reading is read while it shows (the engine owns the figures) */
  readQuota: () => void;
  attach: (images: AttachedImage[]) => void;
  removeAttachment: (index: number) => void;
  mentionOpen: () => void;
  mentionClose: () => void;
  mentionQuery: (query: string) => void;
  mentionToggle: (key: string) => void;
  mentionRemove: (key: string) => void;
  // the right panel (BTW)
  btwDraft: (text: string) => void;
  btwSend: () => void;
  btwStop: () => void;
  btwPromote: () => void;
  btwClose: () => void;
}

/** the open conversation's summary, from the list answer the snapshot holds */
export function summaryOf(state: ChatStoreState, id: string | null): ConversationSummary | null {
  if (!id) return null;
  for (const group of state.groups) for (const summary of group.conversations) if (summary.id === id) return summary;
  return null;
}

/**
 * The open conversation's title. The list's own name comes first; a conversation the list does not hold (another
 * workspace, or an archived one, opened from the find field) is drawn from the name that field carried, so the
 * header is never blank (C-173-4). A conversation with no name at all is the screen's own 無題, as before.
 */
export function openTitle(state: ChatStoreState): string {
  const summary = summaryOf(state, state.selectedId);
  if (summary?.name) return summary.name;
  const known = state.selectedId ? state.knownNames[state.selectedId] : undefined;
  return known || WORDS.chat.untitled;
}

function composerOf(chat: ChatStoreState, ui: ChatUi, on: ChatHandlers): ChatComposerView {
  const open = chat.open;
  const id = chat.selectedId;
  const draft = id ? chat.drafts[id] ?? "" : "";
  const models = open?.models ?? [];
  const current = open?.model ?? "";
  const shown = filterModels(models, ui.modelQuery);
  const efforts = open?.efforts ?? [];
  const usage = open?.contextUsage ?? null;
  const percent = usage?.percent ?? null;
  const types = chat.types[open?.mode ?? ""] ?? [];
  const images = id ? chat.attachments[id] ?? [] : [];
  const streaming = open?.streaming === true;
  const currentOption = models.find((model) => model.id === current);
  return {
    draft,
    setDraft: on.setDraft,
    placeholder: WORDS.chat.composerPlaceholder,
    send: on.send,
    stop: on.stop,
    streaming,
    sending: open?.sending === true,
    canSend: Boolean((draft.trim() || images.length) && !open?.sending),
    notice: open?.notice ?? null,
    notices: (open?.notices ?? []).map(noticeLabel),
    queue: (open?.queue ?? []).map((item, index) => ({
      id: item.id,
      number: index + 1,
      label: WORDS.chat.queued(index + 1),
      text: item.text,
      editing: ui.queueEdit?.id === item.id,
      edited: ui.queueEdit?.id === item.id ? ui.queueEdit.text : item.text,
      startEdit: () => on.queueEdit(item.id, item.text),
      setEdited: (text: string) => on.queueEdit(item.id, text),
      confirmEdit: () => {
        on.queueConfirm(item.id, ui.queueEdit?.id === item.id ? ui.queueEdit.text : item.text);
        on.queueEdit(null);
      },
      cancelEdit: () => on.queueEdit(null),
      cancel: () => on.queueCancel(item.id),
      steer: () => on.queueSteer(item.id),
    })),
    types: types.map((option) => ({ name: option.name, label: option.label, active: option.name === open?.type, go: () => on.pickType(option.name) })),
    type: open?.type ?? "",
    model: {
      current,
      label: currentOption?.name ?? current ?? WORDS.chat.meta.model,
      query: ui.modelQuery,
      setQuery: on.modelQuery,
      options: shown.map((option) => ({
        id: option.id,
        name: option.name,
        window: windowLabel(option),
        capabilities: option.capabilities,
        active: option.id === current,
        go: () => on.pickModel(option.id),
      })),
      empty: WORDS.chat.modelEmpty,
    },
    effort: {
      current: open?.effort ?? "",
      label: effortLabel(open?.effort ?? ""),
      levels: efforts.map((level) => ({ name: level, label: effortLabel(level), active: level === open?.effort, go: () => on.pickEffort(level) })),
    },
    context: {
      open: on.readQuota,
      percent: percent === null ? null : Math.round(percent),
      tokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      cost: open?.cost ?? 0,
      quota: chat.quota ?? [],
    },
    attach: {
      allowed: Boolean(open) && models.some((model) => model.id === current && model.capabilities.includes("image")),
      images,
      hint: WORDS.chat.attach.notAllowed,
      add: on.attach,
      remove: on.removeAttachment,
    },
    mentions: {
      open: chat.mentions.open,
      query: chat.mentions.query,
      loading: chat.mentions.loading,
      error: chat.mentions.error,
      options: filterMentions(chat.mentions.candidates, chat.mentions.query).map((candidate) => ({
        key: candidate.key,
        label: candidate.label,
        hint: candidate.hint,
        active: chat.mentions.chosen.some((c) => c.key === candidate.key),
        choose: () => on.mentionToggle(candidate.key),
      })),
      chosen: chat.mentions.chosen.map((c) => ({ key: c.key, label: c.label, remove: () => on.mentionRemove(c.key) })),
      openPicker: on.mentionOpen,
      close: on.mentionClose,
      setQuery: on.mentionQuery,
      hint: WORDS.chat.mentions.hint,
      labels: {
        title: WORDS.chat.mentions.title,
        open: WORDS.chat.mentions.open,
        search: WORDS.chat.mentions.search,
        empty: chat.mentions.error ?? WORDS.chat.mentions.empty,
        chosen: WORDS.chat.mentions.chosen,
      },
    },
  };
}

// ------------------------------------------------------------------ the right panel (BTW)

export interface ChatPanelView {
  /** the branch is open on screen: the right panel is showing it */
  open: boolean;
  /** a conversation is open, so there is something to cut a branch off and a writer to write in */
  hasParent: boolean;
  title: string;
  /** the parent conversation's name, so the frame says which talk the branch came off */
  from: string;
  items: ChatBodyItemView[];
  draft: string;
  setDraft: (text: string) => void;
  /** Enter in the branch's box: the first send is what cuts the branch */
  ask: () => void;
  /** the send position pressed while the branch is answering: it stops the branch and sends nothing */
  stop: () => void;
  sending: boolean;
  streaming: boolean;
  /** why the branch could not be opened, or why its last send was refused */
  error: string | null;
  /** the promotion's own refusal */
  promoteError: string | null;
  promoting: boolean;
  /** the branch was kept as a conversation, so a second promote is not offered */
  promoted: boolean;
  canPromote: boolean;
  promote: () => void;
  close: () => void;
  labels: { keep: string; ask: string; close: string; empty: string; kept: string };
}

function panelOf(chat: ChatStoreState, btw: SideState, btwDraft: string, rightOpen: boolean, on: ChatHandlers): ChatPanelView {
  const open = btw.open;
  const hasParent = Boolean(chat.selectedId);
  const title = openTitle(chat);
  const items = open && !open.error ? open.items.map((item, index) => bodyItemView(item, open.streaming, index === open.items.length - 1)) : [];
  return {
    open: rightOpen,
    hasParent,
    title: WORDS.chat.branch.title,
    from: title,
    items,
    draft: btwDraft,
    setDraft: on.btwDraft,
    ask: on.btwSend,
    stop: on.btwStop,
    sending: open?.sending === true,
    streaming: open?.streaming === true,
    // a refusal is kept on the side or on the open state; the store's own notice (why the last send was not taken)
    // is the same kind of value and belongs on the frame too
    error: btw.error ?? open?.error ?? open?.notice ?? null,
    promoteError: btw.promoteError,
    promoting: btw.promoting,
    promoted: btw.promoted,
    canPromote: Boolean(btw.id) && !btw.promoting && !btw.promoted,
    promote: on.btwPromote,
    close: on.btwClose,
    labels: {
      keep: WORDS.chat.branch.keep,
      ask: WORDS.chat.branch.ask,
      close: WORDS.chat.branch.close,
      empty: hasParent ? WORDS.chat.branch.empty : WORDS.chat.branch.noParent,
      kept: WORDS.chat.branch.kept,
    },
  };
}

// ------------------------------------------------------------------ the whole screen

export interface ChatScreenView {
  list: ChatListView;
  body: ChatBodyView;
  input: ChatComposerView;
  panel: ChatPanelView;
}

// ------------------------------------------------------------------ the card's consultation (the Inbox panel)

/** one utterance of a consultation, as the prototype's 相談 section draws them */
export interface ConsultLineView {
  role: "you" | "ai";
  text: string;
}

export interface ConsultView {
  /** the consultation is the thing the panel's input is talking to now (聞く opened it) */
  active: boolean;
  heading: string;
  count: number;
  lines: ConsultLineView[];
  empty: string | null;
  /** why the consultation could not be opened, or the last refusal, in the section */
  error: string | null;
  /** the consultation's answer is still coming */
  busy: boolean;
  promoting: boolean;
  promoteError: string | null;
  /** there is a consultation to raise into a conversation */
  canPromote: boolean;
  /** the consultation was kept as a conversation, so a second promote is not offered */
  promoted: boolean;
  labels: { keep: string; back: string; open: string; kept: string };
  /** 聞く opened the consultation: the one-line input is the consultation's, not the answer's */
  openAsk: () => void;
  /** back to the answer's own one-line input */
  backToAnswer: () => void;
  /** send the input's text into the consultation; never the answer's door */
  ask: () => void;
  /** 相談を会話に残す: the promote door, and only a press does it */
  keep: () => void;
}

/** the card's own key says which consultation this is: a second ask for the same card continues it (DEC-9022) */
export function consultKey(item: { kind: string; iddId?: string; batchId?: string } | null): string | null {
  if (!item || item.kind !== "question" || !item.iddId || !item.batchId) return null;
  return `${item.kind}\0${item.iddId}\0${item.batchId}`;
}

/** the operations the Inbox panel's consultation calls; every one is a door of its own */
export interface ConsultHandlers {
  openAsk: () => void;
  backToAnswer: () => void;
  ask: () => void;
  keep: () => void;
}

export function consultVals(side: SideState, active: boolean, on: ConsultHandlers): ConsultView {
  const open = side.open;
  const lines: ConsultLineView[] = [];
  for (const item of open?.items ?? []) {
    if (item.kind === "user" && item.text) lines.push({ role: "you", text: item.text });
    else if (item.kind === "assistant" && item.text) lines.push({ role: "ai", text: item.text });
  }
  const error = side.error ?? (open?.error ?? null) ?? open?.notice ?? null;
  return {
    active,
    heading: WORDS.chat.consult.heading,
    count: lines.length,
    lines,
    empty: active && !lines.length && !error && !side.opening ? WORDS.chat.consult.empty : null,
    error,
    busy: side.opening || open?.sending === true || open?.streaming === true,
    promoting: side.promoting,
    promoteError: side.promoteError,
    canPromote: Boolean(side.id) && !side.promoting && !side.promoted,
    promoted: side.promoted,
    // after the promote went through the same control says the conversation was kept and is no longer a way in
    labels: { keep: side.promoted ? WORDS.chat.consult.kept : WORDS.chat.consult.keep, back: WORDS.chat.consult.back, open: WORDS.chat.consult.open, kept: WORDS.chat.consult.kept },
    openAsk: on.openAsk,
    backToAnswer: on.backToAnswer,
    ask: on.ask,
    keep: on.keep,
  };
}

/**
 * The whole screen's values, built from one snapshot the screen passes in. `state` is the answer to draw, not
 * whatever the store holds by the time this runs: the screen memoizes this call, and a memo that read the store
 * itself would keep drawing the answer it was built with. The typed text, the attached images and the selected
 * conversation's summary all ride in the snapshot, so nothing here outlives the answer it was built from.
 */
export function chatVals(
  state: ChatStoreState,
  btw: SideState,
  btwDraft: string,
  rightOpen: boolean,
  ui: ChatUi,
  on: ChatHandlers,
): ChatScreenView {
  const chat = state;
  const selected = chat.selectedId;
  const groups: ChatGroupView[] = chat.groups.map((group) => ({
    key: group.key,
    label: group.label,
    rows: group.conversations.map((summary) => ({
      id: summary.id,
      title: summary.name || WORDS.chat.untitled,
      active: summary.id === selected,
      running: summary.running,
      idea: summary.type === "idea",
      pinned: summary.pinned,
      bookmarked: summary.bookmarks.length > 0,
      archived: summary.archived,
      error: chat.markErrors[summary.id] ?? chat.deleteErrors[summary.id] ?? null,
      confirming: ui.list.confirming === summary.id,
      menuOpen: ui.list.menu === summary.id,
      select: () => on.listSelect(summary.id),
      toggleMenu: () => on.listMenu(summary.id),
      mark: (kind) => on.listMark(summary.id, kind),
      remove: () => on.listDelete(summary.id),
    })),
  }));
  return {
    list: {
      title: openTitle(chat),
      groups,
      down: chat.connection === "down",
      attempt: chat.attempt,
      retry: on.listRetry,
      receipt: chat.receipt,
      clearReceipt: on.listClearReceipt,
      newChat: on.newChat,
      empty: !chat.groups.length,
    },
    body: bodyOf(chat.open, !selected),
    input: composerOf(chat, ui, on),
    panel: panelOf(chat, btw, btwDraft, rightOpen, on),
  };
}

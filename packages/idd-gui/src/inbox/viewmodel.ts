/**
 * The Inbox's view model, filled from the engine's one state door (`/api/idd/state`) and from the judgement
 * helpers the screen already owns (`keymap`, `requests`, `approval`, `drafts`). The ported components draw whatever
 * this hands them: every lane name, title, count, list row and action label comes from the engine's answer, and a
 * value the engine did not return stays empty rather than being invented (DEC-103-1, DEC-103-2). The deck, the
 * draft merging and the key meanings are the same pure functions the current GUI uses, so a card means the same
 * thing in both screens (DEC-9505, DEC-9191).
 */
import type {
  CardText,
  HeldIssue,
  IgnoredIssueView,
  GoItem,
  InboxItem,
  LandBatchItem,
  LaneRow,
  OutboundItem,
  ProposalItem,
  QuestionItem,
  ShipItem,
  StuckItem,
  SyncConflictItem,
} from "../engine/contract";
import { blockingPhrase, commitConventionCheck, inboxLaneId, shipCardKey } from "../engine/contract";
import { WORDS } from "../strings";
import { batchDraftFor, buildBatchApproval, buildOutboundApproval, buildShipApproval, outboundDraftFor, shipDraftFor, type ConfirmRow, type OutboundDraft, type OutboundReplyDraft, type ShipDraft } from "./approval";
import { deck, itemKey } from "./deck";
import { batchDraftOf, goNamesOf, goReasonOf, stuckPicksOf, type DraftState } from "./drafts";
import { goesToFix, pickedHandling, sentRefs, stuckFindingsOf, type FindingAction, type StuckPicks } from "./stuck-findings";
import { confirmedIntent, goHeldReason, goNeedsReason, isInstructionProposal, notePlaceholder, openQuestionIndex, pendingOperation, screenCardActions, type ActionSlot, type Intent, type KeyContext } from "./keymap";
import { confirmedPurposes, operationOf } from "./operations";
import type { StoreState } from "./useDecide";

// ------------------------------------------------------------------ shapes

export interface InboxHeader {
  lane: string;
  source: string;
  sourceUrl: string | null;
  age: string;
}

export interface ChoiceView {
  index: number;
  label: string;
  badge: string;
  badgeBg: string;
  badgeC: string;
  selected: boolean;
  dim: boolean;
  description: string;
}

export interface RowView {
  label: string;
  value: string;
  /** the words are what an agent wrote about its own work, so the screen marks the row */
  selfReported?: boolean;
}

/** one cell under a submit card: the shape is the prototype's, the value is the engine's (empty when it has none) */
export type StatView =
  | { label: string; kind: "rounds"; rounds: number | null }
  | { label: string; kind: "leftovers"; leftovers: number; rejected: number }
  | { label: string; kind: "acceptance" };

export interface CardActionView {
  label: string;
  /** the key shown on the button, or null when the button shows none */
  key: string | null;
  /** the operation sends nothing of its own: it opens the confirm or an input */
  disabled: boolean;
  /** the operation reaches a signature: the right-end button wears 藍の地と輪 (C-154-1) */
  sign: boolean;
  go: () => void;
}

export interface ActionRow {
  /** the left end: the operations that turn a card down or take the lane out */
  left: CardActionView[];
  /** the middle: reading, before the later key */
  middle: CardActionView[];
  /** put it off */
  later: CardActionView | null;
  /** the right end: the operation the card is for; the second is a split of the same key */
  right: CardActionView[];
}

export interface ConfirmView {
  rows: { label: string; value: string }[];
  sign: boolean;
  approve: CardActionView;
  cancel: CardActionView;
  /** the engine said no key is registered for this host */
  needsRegister: boolean;
  /** registration is a step of the local screen: another page shows where it has to be done instead */
  registerHere: boolean;
  /**
   * The PIN as the other way to sign this one card (C-182-2, C-182-6). The field is drawn only when the engine says a
   * PIN is set; a record that cannot be read is drawn as its reason rather than as a PIN that can be used.
   */
  pin: { configured: boolean; digits: number; error: string | null; approve: (pin: string) => void };
}

export interface ErrorView {
  text: string;
}

/** one line of a card's field: its words, and where they come from when the field says */
export interface CardFieldLine {
  text: string;
  /** the record the words rest on, as the card names it */
  source?: string;
  /** the words rest on what an agent wrote about its own work, so the screen marks them */
  selfReported: boolean;
  /** a place to read more (the sixth field's lines) */
  link?: string;
}

/** one of the card's six fields: always all six, in this order, none empty */
export interface CardFieldView {
  key: "decide" | "recommend" | "outcomes" | "facts" | "settled" | "links";
  heading: string;
  lines: CardFieldLine[];
}

/** one Purpose the GO press confirms, as the card shows it: the sentence the press will confirm, and the two judgments the engine allows on it */
export interface PurposeView {
  id: string;
  statement: string;
  name?: string;
  /** the line under the sentence: that it is the planner's own again, or what the planner first wrote */
  history?: string;
  origin?: string;
  /** the engine's operations on this Purpose; false when the engine does not offer it (or holds it) */
  canRestate: boolean;
  canWithdraw: boolean;
}

/** one changed file of a review's material: its name and the two sides of its diff */
export interface DiffFileView {
  file: string;
  before: string;
  after: string;
}

export type InboxCardKind = "question" | "go" | "submit" | "post" | "review" | "stuck" | "duplicate" | "requeue" | "proposal" | "sync_conflict" | "generic";

/** one finding of a card: what the judgement weighed it, what it stands at, and the handlings penne may pick for it */
export interface FindingRowView {
  severity: string;
  claim: string;
  where: string;
  /** the weight the judgement gave, when penne set another (a must put off) */
  judged?: string;
  /** what the finding stands at now, worded: the handling, or why it is not sent */
  state?: string;
  /** the fix takes it as it stands now */
  fixes?: boolean;
  options?: { action: FindingAction; label: string; selected: boolean; goes: boolean; pick: () => void }[];
}

export interface InboxCardView extends InboxHeader {
  cardKind: InboxCardKind;
  chip: string;
  chipBg: string;
  chipC: string;
  /** the chip wears the signing mark (submit / post) */
  sign: boolean;
  ask: string;
  /** a GO card that waits on a landing says so apart from its question: the wait is why there is no GO to press, the question is still what the card decides */
  waiting?: string;
  rows: RowView[];
  choices: ChoiceView[];
  /** the Purposes the GO press confirms: exactly the ones the engine's answer names, with the sentence it will confirm */
  purposes?: PurposeView[];
  /** the six fields of a card that carries them (the GO card), in the order they are read */
  fields?: CardFieldView[];
  /** the fields' words were put together from the raw material, not written by the translator */
  fieldsRaw?: boolean;
  /** the destination pill of a submit card */
  destination?: { from: string; to: string; line: string; repo: string; label: string; dots: number };
  /** the failed non-blocking checks the engine folded, with why: the submit card warns with them near the heading */
  checkWarnings?: { name: string; reason: string }[];
  checks?: { label: string; ok: boolean; reason?: string }[];
  /** the three cells under a submit card; a cell draws the prototype's own shape from the engine's values */
  stats?: StatView[];
  /** the lanes of a batch card, each with the switch that takes it off the signature (C-247-1) */
  batch?: BatchCardView;
  /** the replies of an outbound card */
  parts?: { ref: string; label: string; quote: string; body: string; resolve: boolean; posted: boolean }[];
  /** a post card that posts one body */
  body?: { title: string; text: string };
  /** the progress bars of a stuck card */
  bars?: { kind: "ok" | "attn" | "line"; flex: number }[];
  counts?: { fixed: number; remaining: number; rejected: number };
  /** open findings / rejected claims; a stopped review card lists every accepted finding, each with its handlings (C-272-1) */
  findings?: FindingRowView[];
  /** the refs the press sends to the fix, read from the engine's declaration before the press (C-272-3) */
  sends?: { heading: string; refs: string[]; empty: string };
  rejected?: { claim: string; reason: string }[];
  /** the two boxes of a duplicate card */
  boxes?: { label: string; id: string; title: string }[];
  /** the previous outcome of a requeue card */
  previous?: { outcome: string; reason: string; at: string };
  /** a line under the card: what the card needs to be read by, or why it has nothing to press */
  note?: string;
  /** the rows of the engine's materials, for a card drawn from its judgment alone */
  material?: RowView[];
  /** the files of a diff the engine's material carries, read one at a time inside the card (DEC-703) */
  diffs?: DiffFileView[];
  /** why the engine holds the card's main operation now; the card says it and promises no key (C-265-4) */
  heldReason?: string;
  /** the one-line input the card opens */
  noteOpen: boolean;
  /** the open one-line input is 聞く's consultation, not the answer */
  asking: boolean;
  noteValue: string;
  notePlaceholder: string | null;
  noteLabel: string;
  noteHint: string;
  /** a GO the engine takes only with a reason says so on the card; absent on every other card */
  reasonNeeded?: string;
  /** the GO's reason line, apart from the revise's: absent unless the GO needs a reason */
  reason?: { open: boolean; value: string; placeholder: string };
}

export interface BatchLaneRowView {
  iddId: string;
  title: string;
  head: string;
  /** the lane stays in the signature */
  on: boolean;
  close: string | null;
  /** the trial merges that met a conflict, as a line */
  forecast: string | null;
  toggle: () => void;
}

export interface BatchCardView {
  lanes: BatchLaneRowView[];
  /** a signed batch of this mainline is under way: the card offers no signature */
  running: string | null;
  /** what the signed batch before this card did: lanes left out with why, changes made after the signature */
  dropped: { iddId: string; reason: string }[];
  converted: { iddId: string; kind: string; files: string[]; rationale: string; diff: string }[];
  /** generated files the batch could not make again: the lane, what to mend, and the command's own words */
  rebuildFailed: { iddId: string; what: string; reason: string }[];
  stopped: string | null;
}

export interface SidebarNext {
  ref: string;
  /** the short identity the row shows beside the mark (C-154-8) */
  num: string;
  title: string;
  mark: string;
  markBg: string;
  markC: string;
  /** the wait the engine's own notice tells: 1 once its time has come, 0 while it returned none */
  progress: number;
  go: () => void;
}

export interface SidebarAnswered {
  mark: string;
  num: string;
  title: string;
  kind: string;
}

export interface SidebarLater {
  key: string;
  num: string;
  title: string;
  kind: string;
  wake: () => void;
}

export interface SidebarHold {
  ref: string;
  title: string;
}

export interface SidebarIgnore {
  ref: string;
  title: string;
  unignore: () => void;
}

export interface SidebarRunning {
  id: string;
  num: string;
  title: string;
  activity: string;
  note: string;
}

export interface InboxSidebarView {
  next: SidebarNext[];
  answered: SidebarAnswered[];
  later: SidebarLater[];
  holds: SidebarHold[];
  ignores: SidebarIgnore[];
  running: SidebarRunning[];
}

export interface ProgressView {
  segments: ("ink" | "attn" | "line")[];
  label: string;
  /** the engine could not be reached: the last picture stays */
  down: boolean;
  attempt: number;
}

export interface PanelTabView {
  label: string;
  count: string;
  active: boolean;
  go: () => void;
  /** the line a question's own tab shows under its number (the question itself) */
  note?: string;
}

export interface PanelSectionView {
  heading: string;
  rows: RowView[];
  /** the tab this section belongs to; the panel shows one tab's sections at a time (DEC-9186) */
  tab: string;
  /** the count the tab shows beside its label */
  count?: string;
  /** the reply parts an outbound card's section draws, edited in one place with the card (DEC-9506) */
  parts?: PanelReplyView[];
  /** the round bands a stuck card's 経過 draws */
  rounds?: PanelRoundView[];
  /** the checks a submit card's 検査 draws, with the command line the prototype shows */
  checks?: PanelCheckView[];
}

export interface PanelChoiceView {
  index: number;
  label: string;
  description: string;
  /** why the agent recommends it: the panel shows it apart from the option's own line */
  rationale: string;
  badge: string;
  badgeBg: string;
  badgeC: string;
}

/** one reply of an outbound card in the panel: the same draft the card reads */
export interface PanelReplyView {
  ref: string;
  label: string;
  quote: string;
  body: string;
  resolve: boolean;
  posted: boolean;
}

/** one round band of a stuck card's 経過: the label the engine's round count gives, and the values it carries */
export interface PanelRoundView {
  label: string;
  findings: string;
  detail: string;
  /** the proportions the band draws; empty when the engine returned no per-round values */
  segments: { label: string; kind: "ok" | "attn" | "line"; flex: number }[];
}

/** one check of a submit card: whether it passed, and the command the engine checked with */
export interface PanelCheckView {
  label: string;
  ok: boolean;
  detail: string;
}

export interface InboxPanelView {
  open: boolean;
  cardKind: InboxCardKind;
  chip: string;
  chipBg: string;
  chipC: string;
  sign: boolean;
  lane: string;
  source: string;
  sourceUrl: string | null;
  state: string;
  tabs: PanelTabView[];
  sections: PanelSectionView[];
  choices?: PanelChoiceView[];
  /** the card's one-line input, drawn on the question panel as the prototype does (the same value as the card) */
  noteInput?: { label: string; value: string; placeholder: string; hint: string };
  /** the review / post body the panel shows full */
  body?: string;
  note: string;
}

export interface InboxHandlers {
  note: (value: string) => void;
  openNote: () => void;
  closeNote: () => void;
  /** the GO's reason line: write into it, open it, close it (what was written stays) */
  reason: (value: string) => void;
  openReason: () => void;
  closeReason: () => void;
  /** send the consultation 聞く opened: the card's one line and the panel's reach the same talk (C-154-3) */
  ask: () => void;
  select: (index: number) => void;
  setTab: (tab: string | null) => void;
  /** show another of the item's open questions */
  setQuestion: (index: number) => void;
  shipField: (field: keyof ShipDraft, value: string) => void;
  /** take a lane off the batch card, or put it back */
  batchLane: (iddId: string, off: boolean) => void;
  /** pick a handling for one finding of the stopped review card, or take the pick off */
  pickFinding: (ref: string, action: FindingAction) => void;
  outboundField: (patch: Partial<OutboundDraft>) => void;
  outboundReply: (ref: string, patch: Partial<OutboundReplyDraft>) => void;
  goName: (proposalId: string, value: string) => void;
  /** rewrite the sentence of one proposed Purpose, or take it back with the reason; both leave the card where it is */
  purposeRestate: (id: string, statement: string) => void;
  purposeWithdraw: (id: string, grounds: string) => void;
  wake: (item: InboxItem) => void;
  /** bring a card in the deck to the front (the screen's own order) */
  focus: (item: InboxItem) => void;
  unignore: (ref: string) => void;
  retry: () => void;
  clearReceipt: () => void;
  /** open the settings sheet on the passkeys section, where a key is registered (C-172-1) */
  openSettingsKey: () => void;
  /** sign the card the confirm stage is showing with the PIN typed there (C-182-6) */
  approvePin: (pin: string) => void;
}

export interface InboxUi {
  noteOpen: boolean;
  /** the operation that opened the one-line input, if one did: Enter sends that one and no other that takes a line */
  noteOp?: string | null;
  /** the GO's reason line is open (absent counts as closed) */
  reasonOpen?: boolean;
  /** the open one-line input is 聞く's consultation, not the answer */
  askOpen: boolean;
  note: string;
  /** undefined means penne has not touched the choice: the one recommendation opens chosen (C-154-2) */
  selection: number | null | undefined;
  /** which of the item's open questions the card and the panel show */
  question: number;
  /** the confirm key of the open confirm stage, or null when it is closed */
  confirm: string | null;
  drafts: DraftState;
  tab: string | null;
}

export interface InboxModel {
  /** the front item's own name, or null when the deck is empty */
  kind: InboxCardKind | null;
  card: InboxCardView | null;
  panel: InboxPanelView | null;
  actions: ActionRow;
  sidebar: InboxSidebarView;
  progress: ProgressView;
  badge: number;
  /** the engine said no key is registered for this host: a signing card cannot be approved */
  needsRegister: boolean;
  /** the page is on the machine that runs the engine, so the settings sheet's passkeys section can register */
  registerHere: boolean;
  /** the engine's refusal over the front card */
  error: ErrorView | null;
  receipt: string | null;
  confirming: ConfirmView | null;
  /** whether the card can be acted on now */
  busy: boolean;
  /** the engine cannot be reached: no decision is sent and the band is shown */
  down: boolean;
  handlers: InboxHandlers;
}

// ------------------------------------------------------------------ helpers

const CHIP = {
  question: { text: WORDS.card.chips.question, bg: "var(--line-soft)", c: "var(--ink)", sign: false },
  go: { text: WORDS.card.chips.go, bg: "var(--attention-bg)", c: "var(--attention-text)", sign: false },
  submit: { text: WORDS.card.chips.ship, bg: "var(--sign-bg)", c: "var(--sign-text)", sign: true },
  post: { text: WORDS.card.chips.outbound, bg: "var(--external-bg)", c: "var(--external)", sign: true },
  review: { text: WORDS.card.chips.outboundReview, bg: "var(--external-bg)", c: "var(--external)", sign: true },
  stuck: { text: WORDS.card.chips.stuck, bg: "var(--line-soft)", c: "var(--ink)", sign: false },
  duplicate: { text: WORDS.card.chips.duplicate, bg: "var(--line-soft)", c: "var(--ink)", sign: false },
  requeue: { text: WORDS.card.chips.requeue, bg: "var(--line-soft)", c: "var(--ink)", sign: false },
  proposal: { text: WORDS.card.chips.proposal, bg: "var(--line-soft)", c: "var(--ink)", sign: false },
  sync_conflict: { text: WORDS.card.chips.syncConflict, bg: "var(--line-soft)", c: "var(--ink)", sign: false },
  generic: { text: WORDS.card.chips.generic, bg: "var(--line-soft)", c: "var(--ink)", sign: false },
} as const;

export function cardKindOf(item: InboxItem): InboxCardKind {
  if (item.kind === "question") return "question";
  if (item.kind === "go") return "go";
  if (item.kind === "ship" || item.kind === "land-batch") return "submit";
  if (item.kind === "outbound") return item.outKind === "gh-pr-review" ? "review" : "post";
  if (item.kind === "stuck") return "stuck";
  if (item.kind === "duplicate") return "duplicate";
  if (item.kind === "requeue") return "requeue";
  if (item.kind === "proposal") return "proposal";
  if (item.kind === "sync_conflict") return "sync_conflict";
  // every other card (a check of the review, a split, an engine replacement, low space, a kind added since) is drawn from
  // the engine's judgment, its operations and its materials, so it needs no change here to be answered (C-265-3)
  return "generic";
}

function relativeAge(now: number, iso: string | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

function laneLabel(item: InboxItem): string {
  // a conflict is tied to no lane; the repo and the unit's label are what tell one row from another
  if (item.kind === "sync_conflict") return [item.repo, item.label].filter(Boolean).join(" ");
  const id = inboxLaneId(item) ?? "";
  const title = item.laneTitle ?? (item.kind === "duplicate" || item.kind === "storage" || item.kind === "reload" ? "" : (item as { title?: string }).title ?? "");
  return [id, title].filter(Boolean).join(" ");
}

/** the short identity a left-sidebar row shows beside its mark: the source's issue number, else the lane's own id */
function laneNumber(item: InboxItem): string {
  if (item.kind === "sync_conflict") return item.subject || item.repo;
  const match = /#(\d+)/.exec(item.source?.label ?? "");
  if (match) return `#${match[1]}`;
  return inboxLaneId(item) ?? item.kind;
}

/** the wait a row's bar shows: the engine's own notice time once it has come, otherwise no value to draw */
function waitProgress(item: InboxItem, due: boolean, now: number): number {
  // a card whose sleep has come asks to be woken, so its wait is up; the deck's own split says so, and the screen
  // never reads the sleep fields themselves (the engines' guard forbids the screen reading them)
  if (due) return 1;
  const at = item.waitNoticeAt;
  if (!at) return 0;
  const t = Date.parse(at);
  return Number.isNaN(t) || t > now ? 0 : 1;
}

function headerOf(item: InboxItem, now: number): InboxHeader {
  const src = item.source;
  return {
    lane: laneLabel(item),
    source: src ? `${src.label} ↗` : "",
    sourceUrl: src?.url ?? null,
    age: relativeAge(now, item.appearedAt),
  };
}

/** the page's own host name, without a port (DEC-9504) */
function pageHost(): string {
  const loc = (globalThis as { location?: { hostname?: string } }).location;
  return loc?.hostname ?? "localhost";
}

function isLoopback(host: string): boolean {
  // a browser reports an IPv6 loopback as `[::1]`; the bare `::1` is kept for a stand-in that has no brackets
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function questionChoices(open: QuestionItem["open"][number] | undefined, selection: number | null): ChoiceView[] {
  if (!open) return [];
  return open.options.map((o) => {
    const rec = o.recommendation;
    const badge = rec === "recommended" ? "推奨" : rec === "acceptable" ? "可" : rec === "not_recommended" ? "非推奨" : "";
    return {
      index: o.index,
      label: o.label,
      badge,
      badgeBg: rec === "recommended" ? "var(--ink)" : rec === "not_recommended" ? "var(--line-soft)" : "var(--surface)",
      badgeC: rec === "recommended" ? "var(--surface)" : rec === "not_recommended" ? "var(--ink-3)" : "var(--ink-2)",
      selected: selection === o.index,
      dim: rec === "not_recommended",
      description: o.description ?? "",
    };
  });
}

/**
 * The option a question opens with: its one recommendation, or null when it has none or more than one. The screen
 * never picks for penne where the engine left the choice open (C-154-2).
 */
export function recommendedSelection(item: InboxItem | null, questionIndex: number | null | undefined): number | null {
  if (!item || item.kind !== "question") return null;
  const open = item.open[openQuestionIndex(item.open.length, questionIndex)];
  if (!open) return null;
  const recommended = open.options.filter((o) => o.recommendation === "recommended");
  return recommended.length === 1 ? recommended[0].index : null;
}

/**
 * Whether a key press in the card's or the panel's one line sends into the consultation 聞く opened: while it is
 * open, Enter reaches the talk and never the card's answer, and an IME conversion's Enter sends nothing (C-154-3).
 */
export function sendsConsultation(
  asking: boolean,
  press: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number },
): boolean {
  return asking && press.key === "Enter" && !press.shiftKey && !press.isComposing && press.keyCode !== 229;
}

/**
 * How many findings the card says were put off: those the judgement accepted and nobody fixed, and those it sent to a
 * follow-up. Both are decided not to be fixed now and both are on the record, so a count without the second says
 * zero while a finding is waiting for the next change. A rejected claim is counted apart, as rejected.
 */
export function postponedCount(review: { leftovers: readonly unknown[]; followups: readonly unknown[] } | undefined): number {
  return review ? review.leftovers.length + review.followups.length : 0;
}

/** how many checks that hold the signature the card names, one row each, before it counts the rest */
const BLOCKING_ROWS = 5;

const two = (n: number) => String(n).padStart(2, "0");

/** a time of the checks as the card says it: month/day hour:minute, in the screen's own zone */
function clockOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The card's line on when the submit was checked and, for a check run again at the same head, whether it found
 * anything new. A check run again that finds the same is the case this exists for: without the line the card draws the
 * same picture as before and the press looks like it did nothing. Null before any check, and for a record that
 * predates the time.
 */
export function checkedLine(proposal: { checkedAt?: string; sinceLast?: { at?: string; changed: boolean; changes: string[] } } | null | undefined): string | null {
  if (!proposal?.checkedAt) return null;
  const at = clockOf(proposal.checkedAt);
  if (!at) return null;
  const since = proposal.sinceLast;
  const detail = !since ? WORDS.ship.checkedFirst
    : since.changed ? WORDS.ship.checkedChanged(since.at ? clockOf(since.at) : "", since.changes)
      : WORDS.ship.checkedSame(since.at ? clockOf(since.at) : "");
  return `${WORDS.ship.checkedAt(at)}。${detail}`;
}

function shipRows(view: ReturnType<typeof buildShipApproval>, item: ShipItem): RowView[] {
  const rows: RowView[] = [];
  // the one line of a records-only card: the mark and the refusal, in place of the reason row it would repeat
  if (item.recordsOnly) rows.push({ label: WORDS.ship.recordsOnly, value: item.recordsOnly.reason });
  else if (view.blocking.length) {
    // the checks that hold the signature, one row each with its name and why: a count alone says nothing to fix
    for (const b of view.blocking.slice(0, BLOCKING_ROWS)) rows.push({ label: WORDS.ship.blocking, value: blockingPhrase(b) });
    if (view.blocking.length > BLOCKING_ROWS) rows.push({ label: WORDS.ship.blocking, value: WORDS.ship.blockingMore(view.blocking.length - BLOCKING_ROWS) });
  } else if (view.why) rows.push({ label: "理由", value: view.why });
  if (view.commitText) rows.push({ label: WORDS.ship.label.commit, value: view.commitText });
  if (item.commit?.failed && !item.commit.draft) rows.push({ label: WORDS.ship.label.commitDraft, value: WORDS.ship.commitFailed(item.commit.failed) });
  // a submit's record or a landing's: both carry the time and what moved since the last check of the same head
  const checked = checkedLine(item.proposal ?? item.land);
  if (checked) rows.push({ label: WORDS.ship.checked, value: checked });
  // a landing that could not make the generated files again is neither checked nor approved: it says whether the environment or the sources failed, and what happens next
  const failure = item.land?.rebuildFailure;
  if (failure) rows.push({ label: WORDS.ship.rebuildFailed, value: `${WORDS.ship.rebuildUnbuilt(failure.cause, failure.paths)}\n${failure.reason}` });
  return rows;
}

/**
 * The card's acceptance lines. The line on the commit message's form is judged again on the message penne has now,
 * by the same function the engine made it with, so editing the message moves the line; every other line is the
 * engine's own.
 */
function shipChecks(item: ShipItem, view: ReturnType<typeof buildShipApproval>, draft: ShipDraft): NonNullable<InboxCardView["checks"]> {
  const sends = view.kind === "new-pr" || view.kind === "push-to-pr";
  return item.checks.map((c) => {
    if (c.key !== "commit-convention" || !item.commitConvention || !sends) return c;
    const verdict = commitConventionCheck(item.commitConvention.convention, draft.commitMessage, item.commitConvention.precedents);
    return { label: verdict.label, ok: verdict.ok, reason: verdict.reason };
  });
}

/** a finding's weight, with the weight the judgement gave beside it when a person lowered it (C-272-2) */
function weightLabel(f: { severity: string; judgedSeverity?: string }): string {
  return f.judgedSeverity && f.judgedSeverity !== f.severity ? WORDS.stuck.judged(f.judgedSeverity, f.severity) : f.severity;
}

/** how a finding standing at a handling is worded: the handling, or why the fix does not take it */
function findingState(at: { action: FindingAction; inFix: boolean }): string {
  if (at.inFix) return WORDS.stuck.handling.fix;
  return at.action === "fix" ? WORDS.stuck.notSent : WORDS.stuck.handling[at.action];
}

/**
 * The findings of a stopped review card. The engine's declaration lists every accepted finding with its handlings and
 * whether each goes to the fix; the rows only show it. A card whose answer declares none lists none: the narrower `open`
 * is the old screen's list and is never read in its place, since it would show part of the findings as if it were all.
 */
function stuckFindings(item: StuckItem, picks: StuckPicks, pick: (ref: string, action: FindingAction) => void): FindingRowView[] {
  return stuckFindingsOf(item).map((f) => {
    const picked = pickedHandling(f, picks);
    return {
      severity: f.severity,
      claim: f.claim,
      where: f.path ?? "",
      ...(f.judgedSeverity ? { judged: f.judgedSeverity } : {}),
      // the handling penne picked when she picked one, else the one the finding stands at, so the row never contradicts the choice shown
      state: findingState(picked ?? f),
      fixes: goesToFix(f, picks),
      options: f.handlings.map((h) => ({
        action: h.action,
        label: h.severity !== f.severity ? `${WORDS.stuck.handling[h.action]}（${h.severity}）` : WORDS.stuck.handling[h.action],
        selected: picked ? picked.action === h.action : h.current,
        goes: h.inFix,
        pick: () => pick(f.ref, h.action),
      })),
    };
  });
}

/**
 * The refs a press of "続ける" sends to the fix, looked up in the engine's declaration and never worked out here. That
 * a press sends no fix at all is the engine's count (`continueFixes`) while penne has picked nothing, and the picked
 * handlings once she has; a note penne wrote may answer the judgement's question and go as the fix, so with a note the
 * card does not say none goes
 */
function stuckSends(item: StuckItem, picks: StuckPicks, note: string): InboxCardView["sends"] {
  const declared = stuckFindingsOf(item);
  if (!declared.length) return undefined;
  const refs = sentRefs(declared, picks);
  const picked = Object.keys(picks).length > 0;
  const none = item.continueFixes !== undefined && !note.trim()
    && (picked ? refs.length === 0 && !item.oscillations?.length : item.continueFixes === 0);
  return { heading: WORDS.stuck.sendsHeading, refs, empty: none ? WORDS.stuck.sendsNoneNoFix : WORDS.stuck.sendsNone };
}

/** the outbound draft the screen shows: what penne has edited for this card, or the engine's own starting text */
function outboundDraftOf(item: OutboundItem, drafts: DraftState): OutboundDraft {
  return drafts.outbound[itemKey(item)]?.draft ?? outboundDraftFor(item);
}

// ------------------------------------------------------------------ cards

/** the lanes of a batch card with their switches, and what the signed batch before it did */
function batchCardOf(item: LandBatchItem, draft: { off: ReadonlySet<string> }, handlers: { batchLane: (iddId: string, off: boolean) => void }): BatchCardView {
  return {
    lanes: item.lanes.map((l) => {
      const on = !draft.off.has(l.iddId);
      const met = [...(l.conflictForecast?.mainline.conflict ? l.conflictForecast.mainline.files : []), ...(l.conflictForecast?.others.filter((o) => o.conflict).flatMap((o) => o.files) ?? [])];
      return {
        iddId: l.iddId, title: l.title, head: l.head.slice(0, 9), on,
        close: l.close ? `Issue #${l.close.issue}（${l.close.repo}）` : null,
        forecast: met.length ? WORDS.batch.conflicts([...new Set(met)]) : null,
        toggle: () => handlers.batchLane(l.iddId, on),
      };
    }),
    running: item.running ? WORDS.batch.running(WORDS.batch.phase[item.running.phase] ?? item.running.phase) : null,
    dropped: item.last?.dropped.map((d) => ({ iddId: d.iddId, reason: d.reason })) ?? [],
    converted: item.last?.conversions.map((c) => ({ iddId: c.iddId, kind: WORDS.batch.conversion(c.kind), files: c.files.map((f) => f.path), rationale: c.rationale, diff: c.files.map((f) => f.diff).join("\n") })) ?? [],
    rebuildFailed: item.last?.rebuildFailures?.map((f) => ({ iddId: f.iddId, what: WORDS.ship.rebuildFailure(f.cause, f.paths), reason: f.reason })) ?? [],
    stopped: item.last?.reason ?? item.running?.reason ?? null,
  };
}

/** the engine's words laid out as the six fields, in order; the marks for self-reported words come from the engine */
export function cardFields(text: CardText): CardFieldView[] {
  const w = WORDS.go;
  const field = (key: CardFieldView["key"], lines: CardFieldLine[]): CardFieldView => ({ key, heading: w.fields[key], lines });
  const recorded = (line: Omit<CardFieldLine, "selfReported">): CardFieldLine => ({ ...line, selfReported: false });
  return [
    field("decide", [recorded({ text: text.decide })]),
    field("recommend", [{ text: text.recommend.text, source: w.basis(text.recommend.basis), selfReported: text.recommend.selfReported }]),
    field("outcomes", text.outcomes.map((o) => recorded({ text: `${o.option}: ${o.changes}（${w.reaches(o.reaches)}・${w.reversible(o.reversible)}）` }))),
    field("facts", text.facts.map((f) => ({ text: f.text, source: w.source(f.source), selfReported: f.selfReported }))),
    field("settled", text.settled.map((s) => recorded({ text: s.text, source: w.source(s.source) }))),
    field("links", text.links.map((l) => recorded({ text: l.label, link: l.path }))),
  ];
}

/** the Purposes the GO press confirms, read from the engine's answer alone, with the judgments it allows on each */
export function purposeViews(item: GoItem): PurposeView[] {
  const open = (id: string) => {
    const op = operationOf(item, id);
    return Boolean(op) && !op!.hold;
  };
  const canRestate = open("purpose_restate");
  const canWithdraw = open("purpose_withdraw");
  return confirmedPurposes(operationOf(item, "go")).map((p) => ({
    id: p.id,
    statement: p.statement,
    ...(p.name ? { name: p.name } : {}),
    ...(p.raisedStatement ? { history: p.raisedStatement.trim() === p.statement.trim() ? WORDS.go.purpose.restored : WORDS.go.purpose.before(p.raisedStatement) } : {}),
    ...(p.origin ? { origin: p.origin } : {}),
    canRestate,
    canWithdraw,
  }));
}

/** the GO card's rows after the wait: the planner's summary and risk table, then what the engine decided */
function goRows(item: GoItem, marked: boolean): RowView[] {
  const rows: RowView[] = [];
  const self = marked ? { selfReported: true } : {};
  const { summary } = item;
  const account: [string, string][] = summary
    ? [[WORDS.go.situation, summary.situation], [WORDS.go.action, summary.action], [WORDS.go.outcome, summary.outcome]]
    : [];
  for (const r of item.riskTable ?? []) account.push([`${WORDS.go.risk} · ${r.label}`, r.reason]);
  for (const [label, value] of account) rows.push({ label, value, ...self });
  if (item.depth) rows.push({ label: WORDS.go.depth, value: WORDS.go.depthWord[item.depth] });
  if (item.notAuto) rows.push({ label: WORDS.go.notAuto, value: item.notAuto });
  return rows;
}

function cardView(item: InboxItem, ui: InboxUi, source: StoreState, handlers: { batchLane: (iddId: string, off: boolean) => void; pickFinding: (ref: string, action: FindingAction) => void }): InboxCardView {
  const cardKind = cardKindOf(item);
  const chip = CHIP[cardKind];
  const base: InboxCardView = {
    ...headerOf(item, source.now),
    cardKind,
    chip: chip.text,
    chipBg: chip.bg,
    chipC: chip.c,
    sign: chip.sign,
    ask: "",
    rows: [],
    choices: [],
    noteOpen: ui.noteOpen,
    asking: ui.askOpen,
    noteValue: ui.note,
    notePlaceholder: notePlaceholder(item, ui.noteOpen ? ui.noteOp : null),
    // a card other than the question draws no label or help beside its one line (AC-007); the question sets them
    noteLabel: "",
    noteHint: "",
  };

  if (item.kind === "question") {
    const open = item.open[openQuestionIndex(item.open.length, ui.question)];
    return {
      ...base,
      ask: open?.question ?? "",
      choices: questionChoices(open, ui.selection ?? null),
      rows: open?.facts.map((f) => ({ label: f.label, value: f.value })) ?? [],
      lane: `${base.lane}`,
      // 聞く's consultation input is shown apart from the answer's: it names itself and reaches no judgement
      notePlaceholder: ui.askOpen ? WORDS.card.note.askPlaceholder : notePlaceholder(item),
      noteLabel: ui.askOpen ? WORDS.card.note.askLabel : typeof ui.selection === "number" ? WORDS.question.reasonFor(ui.selection) : WORDS.question.freeAnswer,
      // the answer's hint tells how to make an answer; it would be wrong over the consultation
      noteHint: ui.askOpen ? "" : WORDS.question.inputHint,
    };
  }
  if (item.kind === "go") {
    const rows: RowView[] = [];
    // the wait comes first: it is why there is no GO to press
    if (item.blockedBy) {
      for (const b of item.blockedBy.items) rows.push({ label: WORDS.go.waitingFor, value: `${b.ref} ${b.title}${b.state === "unknown" ? WORDS.go.waitingUnknown : ""}`.trim() });
    }
    // the planner's summary and risk table are its own account, so beside the six fields they wear the mark; the
    // depth and the reason for no auto-GO are what the engine decided, so they do not (DEC-103-1)
    rows.push(...goRows(item, item.text !== undefined));
    const ask = item.blockedBy ? WORDS.go.waitingAsk(item.blockedBy.items.map((b) => b.ref)) : WORDS.go.ask;
    // a GO the engine takes only with a reason names that on the card and carries its own line, apart from the revise's
    const skippedReview = goNeedsReason(item) && !item.blockedBy && item.planReview?.state === "skipped";
    // a review nobody declared cannot be asked again: the card says so and lists the must the last answering round left
    if (skippedReview) {
      const answered = [...(item.planReview?.rounds ?? [])].reverse().find((r) => r.state === "reviewed");
      for (const f of answered?.findings ?? []) if (f.severity === "must") rows.push({ label: WORDS.go.mustLeft, value: f.path ? `${f.claim}（${f.path}）` : f.claim });
    }
    // a GO the engine holds has no reason line to open and promises no key: the card says why it cannot be pressed now (C-265-4)
    const held = goHeldReason(item);
    const reasonFields: Partial<InboxCardView> = held
      ? { heldReason: held }
      : goNeedsReason(item) && !item.blockedBy
      ? {
        // the words follow the line: closed, → opens it; open, Enter sends the GO with what is written
        reasonNeeded: skippedReview
          ? (ui.reasonOpen === true ? WORDS.go.needsReasonSkippedOpen : WORDS.go.needsReasonSkipped)
          : (ui.reasonOpen === true ? WORDS.go.needsReasonOpen : WORDS.go.needsReason),
        reason: { open: ui.reasonOpen === true, value: goReasonOf(ui.drafts, item.iddId), placeholder: WORDS.card.note.goReasonPlaceholder },
      }
      : {};
    const purposes = purposeViews(item);
    const shown: Partial<InboxCardView> = purposes.length ? { purposes } : {};
    if (item.text) {
      return {
        ...base,
        ...reasonFields,
        ...shown,
        ask: item.text.decide,
        ...(item.blockedBy ? { waiting: WORDS.go.waitingAsk(item.blockedBy.items.map((b) => b.ref)) } : {}),
        rows,
        fields: cardFields(item.text),
        fieldsRaw: item.text.by === "raw",
      };
    }
    return { ...base, ...reasonFields, ...shown, ask, rows };
  }
  if (item.kind === "land-batch") {
    const draft = batchDraftOf(ui.drafts, item);
    const view = buildBatchApproval(item, draft);
    return {
      ...base,
      ask: item.running || item.settled ? view.why ?? "" : WORDS.batch.ask(view.kept.length, item.lanes.length),
      destination: { from: item.workBase, to: item.workBase, line: WORDS.batch.destination, repo: item.repoName || item.repo, label: WORDS.batch.destination, dots: 0 },
      batch: batchCardOf(item, draft, handlers),
    };
  }
  if (item.kind === "ship") {
    const draft = ui.drafts.ship[shipCardKey(item)]?.draft ?? shipDraftFor(item);
    const view = buildShipApproval(item, draft, source.now);
    return {
      ...base,
      ask: view.ask,
      destination: {
        from: item.branch.from,
        to: item.branch.to,
        line: view.destination.line,
        repo: view.destination.repo,
        label: view.destination.label,
        dots: 6,
      },
      checks: shipChecks(item, view, draft),
      ...(item.checkWarnings?.length ? { checkWarnings: item.checkWarnings } : {}),
      stats: [
        { label: WORDS.card.stats.rounds, kind: "rounds", rounds: item.review ? item.review.fixRounds : null },
        { label: WORDS.card.stats.leftovers, kind: "leftovers", leftovers: postponedCount(item.review), rejected: item.review?.rejected.length ?? 0 },
        { label: WORDS.card.stats.acceptance, kind: "acceptance" },
      ],
      rows: shipRows(view, item),
    };
  }
  if (item.kind === "outbound") {
    const draft = outboundDraftOf(item, ui.drafts);
    const view = buildOutboundApproval(item, draft);
    if (item.outKind === "gh-pr-replies") {
      return {
        ...base,
        ask: view.ask,
        destination: { from: "", to: "", line: item.targetLabel, repo: "", label: view.destination.label, dots: 0 },
        parts: (item.replies ?? []).map((r, i) => ({ ref: r.ref, label: r.label, quote: r.quote, body: draft.replies[i]?.body ?? r.proposed, resolve: (draft.replies[i]?.resolve ?? r.resolve) === true, posted: r.posted })),
      };
    }
    return {
      ...base,
      ask: view.ask,
      body: { title: draft.title, text: draft.body },
      destination: { from: "", to: "", line: item.targetLabel, repo: "", label: view.destination.label, dots: 0 },
    };
  }
  if (item.kind === "stuck") {
    const fixed = item.fixRounds;
    const remaining = item.open.length;
    const rejected = item.rejected.length;
    const total = fixed + remaining + rejected || 1;
    return {
      ...base,
      ask: item.reason,
      bars: [
        { kind: "ok", flex: fixed / total },
        { kind: "attn", flex: remaining / total },
        { kind: "line", flex: rejected / total },
      ],
      counts: { fixed, remaining, rejected },
      findings: stuckFindings(item, stuckPicksOf(ui.drafts, item.iddId), handlers.pickFinding),
      sends: stuckSends(item, stuckPicksOf(ui.drafts, item.iddId), ui.note ?? ""),
      rejected: item.rejected.slice(0, 4).map((r) => ({ claim: r.claim, reason: r.reason ?? "" })),
    };
  }
  if (item.kind === "duplicate") {
    return {
      ...base,
      lane: item.incoming.ref.label,
      ask: WORDS.duplicate.ask(item.incoming.title, item.existing.ref.label),
      boxes: [
        { label: WORDS.duplicate.incoming, id: item.incoming.ref.label, title: item.incoming.title },
        { label: WORDS.duplicate.existing, id: item.existing.ref.label, title: item.existing.title },
      ],
      rows: [{ label: WORDS.duplicate.reason, value: item.reason }, ...(item.shared ?? []).map((s) => ({ label: "同じ点", value: s }))],
    };
  }
  if (item.kind === "requeue") {
    return {
      ...base,
      ask: WORDS.requeue.ask(item.from),
      previous: item.closed ? { outcome: item.closed.outcome, reason: item.closed.reason ?? "", at: relativeAge(source.now, item.closed.at) } : undefined,
      rows: item.context ? [{ label: WORDS.requeue.reason, value: item.context }] : [],
    };
  }
  if (item.kind === "proposal") {
    return { ...base, lane: proposalLane(item), ask: item.handle, rows: proposalRows(item) };
  }
  if (item.kind === "sync_conflict") {
    return { ...base, lane: item.repo, ask: WORDS.syncConflict.ask(item.label), rows: syncConflictRows(item), note: WORDS.syncConflict.note };
  }
  // any other card: drawn from the engine's judgment, its materials and its operations alone (C-265-3)
  const operations = item.decision?.operations ?? [];
  return {
    ...base,
    ask: WORDS.card.kinds[item.kind as keyof typeof WORDS.card.kinds] ?? item.kind,
    material: genericRows(item),
    ...(diffFilesOf(item).length ? { diffs: diffFilesOf(item) } : {}),
    ...(operations.some((op) => op.id !== "later") ? {} : { note: WORDS.card.generic.noOperation }),
  };
}

/** whether the engine's operation takes a line the person writes */
function takesLine(op: { input: { kind: string } }): boolean {
  return op.input.kind === "text";
}

const DIFF_KEY = /^diff_(file|before|after)_(\d+)$/;

/** the rows of the engine's materials, worded by the screen; the files of a diff are not rows, the card reads them one at a time */
function genericRows(item: InboxItem): RowView[] {
  return (item.decision?.material ?? []).filter((m) => !DIFF_KEY.test(m.key)).map((m) => ({ label: WORDS.card.generic.material(m.key), value: m.value }));
}

/** the diff of each changed file the engine's material names, in its order: `diff_file_N`, `diff_before_N`, `diff_after_N` */
function diffFilesOf(item: InboxItem): DiffFileView[] {
  const material = item.decision?.material ?? [];
  const valueOf = (key: string) => material.find((m) => m.key === key)?.value ?? "";
  const numbers = [...new Set(material.flatMap((m) => DIFF_KEY.exec(m.key)?.[2] ?? []).map(Number))].sort((x, y) => x - y);
  return numbers.map((n) => ({ file: valueOf(`diff_file_${n}`), before: valueOf(`diff_before_${n}`), after: valueOf(`diff_after_${n}`) }));
}

/** the three values of a conflict, side by side: the outside's now, the value both last agreed on, and propter's now */
function syncConflictRows(item: SyncConflictItem): RowView[] {
  const shown = (v: string) => (v === "" ? WORDS.syncConflict.empty : v);
  return [
    { label: WORDS.syncConflict.external, value: shown(item.external) },
    { label: WORDS.syncConflict.base, value: shown(item.base) },
    { label: WORDS.syncConflict.propter, value: shown(item.propter) },
  ];
}

/** the one line of a proposal card's header: an instruction proposal has no repo, the others name theirs */
function proposalLane(item: ProposalItem): string {
  return isInstructionProposal(item.proposalKind) ? WORDS.proposal.instructionLane : item.repo;
}

/** the rows a proposal shows: what is now, what is proposed, why, where it came from and when it takes effect */
function proposalRows(item: ProposalItem): RowView[] {
  const instruction = isInstructionProposal(item.proposalKind);
  return [
    ...item.before.map((r) => ({ label: r.label, value: r.value })),
    ...item.after.map((r) => ({ label: r.label, value: r.value })),
    ...(item.reason ? [{ label: WORDS.proposal.reason, value: item.reason }] : []),
    { label: WORDS.proposal.effect, value: instruction ? WORDS.proposal.effectNextStart : item.effect === "on_merge" ? WORDS.proposal.effectOnMerge : WORDS.proposal.effectNow },
    ...(item.notice ? [{ label: WORDS.proposal.review, value: item.notice }] : []),
  ];
}

// ------------------------------------------------------------------ panels

function panelRows(rows: RowView[], tab: string, count?: string): PanelSectionView[] {
  return rows.length ? [{ heading: "", rows, tab, count }] : [];
}

/** the tabs a panel shows: one per tab its sections carry, so a tab the API cannot fill is never drawn (DEC-9186) */
function panelTabs(sections: PanelSectionView[], active: string | null, setTab: (tab: string | null) => void): PanelTabView[] {
  const seen: PanelSectionView[] = [];
  for (const s of sections) if (!seen.some((x) => x.tab === s.tab)) seen.push(s);
  const current = active && seen.some((x) => x.tab === active) ? active : seen[0]?.tab ?? "";
  return seen.map((s) => ({ label: s.tab, count: s.count ?? "", active: s.tab === current, go: () => setTab(s.tab) }));
}

/** the panel of a card whose approval has confirm rows: its sections as tabs, and the rows as the body */
function withSections(base: InboxPanelView, sections: PanelSectionView[], ui: InboxUi, handlers: InboxHandlers, rows: ConfirmRow[]): InboxPanelView {
  return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections, body: rows.map((r) => `${r.label}: ${r.value}`).join("\n") };
}

function panelView(item: InboxItem, cardKind: InboxCardKind, ui: InboxUi, source: StoreState, handlers: InboxHandlers): InboxPanelView {
  const chip = CHIP[cardKind];
  const base: InboxPanelView = {
    open: true,
    cardKind,
    chip: chip.text,
    chipBg: chip.bg,
    chipC: chip.c,
    sign: chip.sign,
    lane: laneLabel(item),
    source: item.source ? `${item.source.label} ↗` : "",
    sourceUrl: item.source?.url ?? null,
    state: "",
    tabs: [],
    sections: [],
    note: "",
  };
  if (item.kind === "question") {
    // the prototype's stepper: one tab per open question, the selected one carrying its body and options
    const at = openQuestionIndex(item.open.length, ui.question);
    const open = item.open[at] ?? item.open[0];
    const qtab = `Q${item.answeredCount + 1 + at}`;
    const sections: PanelSectionView[] = [];
    if (open) {
      sections.push({ heading: WORDS.panels.heading.question, rows: [{ label: WORDS.panels.heading.question, value: open.question }], tab: qtab });
      if (open.facts.length) sections.push({ heading: WORDS.panels.heading.checked, rows: open.facts.map((f) => ({ label: f.label, value: f.value })), tab: qtab });
    }
    return {
      ...base,
      state: `${item.answeredCount} / ${item.askedTotal}`,
      noteInput: {
        label: ui.askOpen ? WORDS.card.note.askLabel : typeof ui.selection === "number" ? WORDS.question.reasonFor(ui.selection) : WORDS.question.freeAnswer,
        value: ui.note,
        placeholder: ui.askOpen ? WORDS.card.note.askPlaceholder : WORDS.card.note.questionPlaceholder,
        hint: ui.askOpen ? "" : WORDS.question.inputHint,
      },
      tabs: item.open.map((q, i) => ({ label: `Q${item.answeredCount + 1 + i}`, count: "", active: i === at, note: q.question, go: () => handlers.setQuestion(i) })),
      sections,
      choices: open?.options.map((o) => ({
        index: o.index,
        label: o.label,
        description: o.description ?? "",
        rationale: o.rationale ?? "",
        badge: o.recommendation === "recommended" ? "推奨" : o.recommendation === "acceptable" ? "可" : o.recommendation === "not_recommended" ? "非推奨" : "",
        badgeBg: o.recommendation === "recommended" ? "var(--ink)" : o.recommendation === "not_recommended" ? "var(--line-soft)" : "var(--surface)",
        badgeC: o.recommendation === "recommended" ? "var(--surface)" : o.recommendation === "not_recommended" ? "var(--ink-3)" : "var(--ink-2)",
      })),
    };
  }
  if (item.kind === "go") {
    const sections: PanelSectionView[] = [];
    if (item.summary) sections.push({ heading: WORDS.panels.heading.plan, rows: [{ label: WORDS.go.situation, value: item.summary.situation }, { label: WORDS.go.action, value: item.summary.action }, { label: WORDS.go.outcome, value: item.summary.outcome }], tab: WORDS.panels.heading.plan });
    if (item.riskTable?.length) sections.push({ heading: WORDS.go.risk, rows: item.riskTable.map((r) => ({ label: r.label, value: r.reason })), tab: WORDS.panels.heading.plan });
    if (item.decisions.length) sections.push({ heading: WORDS.panels.heading.decisions, rows: item.decisions.map((d) => ({ label: d.id, value: [d.text, d.why ? `Why: ${d.why}` : "", d.source ? `出どころ: ${d.source}` : ""].filter(Boolean).join(" / ") })), tab: WORDS.panels.heading.decisions, count: String(item.decisions.length) });
    if (item.criteria.length) sections.push({ heading: WORDS.panels.heading.criteria, rows: item.criteria.map((c) => ({ label: c.id, value: c.text })), tab: WORDS.panels.heading.criteria, count: String(item.criteria.length) });
    if (item.planReview) sections.push({ heading: WORDS.panels.heading.planReview, rows: item.planReview.findings.map((f) => ({ label: `${f.severity} ${f.path}`, value: f.claim })), tab: WORDS.panels.heading.planReview, count: String(item.planReview.findings.length) });
    // what the GO press confirms, the same sentences the card shows (judged on the card, which holds the inputs)
    const confirmed = purposeViews(item);
    if (confirmed.length) sections.unshift({ heading: WORDS.go.purposes, rows: confirmed.map((p) => ({ label: p.id, value: p.statement })), tab: WORDS.panels.heading.purposes, count: String(confirmed.length) });
    return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
  }
  if (item.kind === "ship") {
    const draft = ui.drafts.ship[shipCardKey(item)]?.draft ?? shipDraftFor(item);
    const view = buildShipApproval(item, draft, source.now);
    const sections: PanelSectionView[] = [];
    // the 検査 tab is the engine's own run of the repo's checks: each row carries the check's name and the line the
    // engine ran, which the card's own acceptance lines do not (F-2). The two lists are different, so a detail is
    // never looked up across them. Before any proposal (nothing checked yet, or a landing) the card's own lines stand,
    // with no command to show.
    const ran = item.proposal?.checks ?? item.land?.checks ?? [];
    if (ran.length) {
      sections.push({
        heading: WORDS.panels.heading.checks,
        rows: ran.map((c) => ({ label: c.name, value: c.status === "pass" || c.status === "not-applicable" ? "pass" : "fail" })),
        tab: WORDS.panels.heading.checks,
        count: String(ran.length),
        checks: ran.map((c) => ({ label: c.name, ok: c.status === "pass" || c.status === "not-applicable", detail: c.detail ?? "" })),
      });
    } else if (item.checks.length) {
      sections.push({
        heading: WORDS.panels.heading.checks,
        rows: item.checks.map((c) => ({ label: c.label, value: c.ok ? "pass" : "fail" })),
        tab: WORDS.panels.heading.checks,
        count: String(item.checks.length),
        checks: shipChecks(item, view, draft).map((c) => ({ label: c.label, ok: c.ok, detail: c.reason ?? "" })),
      });
    }
    if (item.review) {
      if (item.review.leftovers.length) sections.push({ heading: WORDS.panels.heading.findings, rows: item.review.leftovers.map((f) => ({ label: `${weightLabel(f)} ${f.path}`, value: f.claim })), tab: WORDS.panels.heading.review, count: String(item.review.fixRounds) });
      if (item.review.followups.length) {
        sections.push({
          heading: WORDS.panels.heading.followups,
          rows: item.review.followups.map((f) => ({ label: `${weightLabel(f)} ${f.path ?? ""}`.trim(), value: `${f.claim}${f.task ? ` — TODO ${f.task} に記録` : f.failed ? ` — TODO に書けなかった: ${f.failed}` : ""}` })),
          tab: WORDS.panels.heading.review,
          count: String(item.review.followups.length),
        });
      }
      if (item.review.rejected.length) sections.push({ heading: WORDS.panels.heading.rejected, rows: item.review.rejected.map((r) => ({ label: r.claim, value: r.reason ?? "" })), tab: WORDS.panels.heading.review });
    }
    return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections, body: view.confirmRows.map((r) => `${r.label}: ${r.value}`).join("\n") };
  }
  if (item.kind === "land-batch") {
    const draft = batchDraftOf(ui.drafts, item);
    const view = buildBatchApproval(item, draft);
    const sections: PanelSectionView[] = [
      { heading: WORDS.batch.confirm.destination, rows: [{ label: WORDS.batch.confirm.destination, value: view.confirmRows[0]?.value ?? "" }], tab: WORDS.panels.heading.destination },
      {
        heading: WORDS.batch.confirm.lanes,
        rows: item.lanes.map((l) => ({ label: `${draft.off.has(l.iddId) ? WORDS.batch.off : WORDS.batch.on} · ${l.iddId}`, value: `${l.title} · ${l.head.slice(0, 9)}${l.close ? ` · Issue #${l.close.issue}` : ""}` })),
        tab: WORDS.panels.heading.destination,
        count: String(view.kept.length),
      },
    ];
    if (item.last?.dropped.length) sections.push({ heading: WORDS.batch.rows.dropped, rows: item.last.dropped.map((d) => ({ label: d.iddId, value: d.reason })), tab: WORDS.panels.heading.review });
    if (item.last?.conversions.length) sections.push({ heading: WORDS.batch.rows.converted, rows: item.last.conversions.map((c) => ({ label: `${c.iddId} · ${WORDS.batch.conversion(c.kind)}`, value: `${c.files.map((f) => f.path).join(", ")}\n${c.rationale}\n${c.files.map((f) => f.diff).join("\n")}` })), tab: WORDS.panels.heading.review });
    if (item.last?.rebuildFailures?.length) sections.push({ heading: WORDS.batch.rows.rebuildFailed, rows: item.last.rebuildFailures.map((f) => ({ label: f.iddId, value: `${WORDS.ship.rebuildFailure(f.cause, f.paths)}\n${f.reason}` })), tab: WORDS.panels.heading.review });
    if (item.last?.reason) sections.push({ heading: WORDS.batch.rows.stopped, rows: [{ label: WORDS.batch.rows.stopped, value: item.last.reason }], tab: WORDS.panels.heading.review });
    return withSections(base, sections, ui, handlers, view.confirmRows);
  }
  if (item.kind === "outbound") {
    const draft = outboundDraftOf(item, ui.drafts);
    const view = buildOutboundApproval(item, draft);
    const sections: PanelSectionView[] = [{ heading: WORDS.outbound.label.destination, rows: [{ label: WORDS.outbound.label.destination, value: item.targetLabel }], tab: WORDS.panels.heading.destination }];
    if (item.outKind === "gh-pr-replies") {
      sections.push({
        heading: WORDS.panels.heading.replies,
        rows: (item.replies ?? []).map((r, i) => ({ label: r.ref, value: draft.replies[i]?.body ?? r.proposed })),
        tab: WORDS.panels.heading.replies,
        count: String(item.replies?.length ?? 0),
        parts: (item.replies ?? []).map((r, i) => ({ ref: r.ref, label: r.label, quote: r.quote, body: draft.replies[i]?.body ?? r.proposed, resolve: (draft.replies[i]?.resolve ?? r.resolve) === true, posted: r.posted })),
      });
    } else {
      sections.push({ heading: WORDS.outbound.label.body, rows: [{ label: WORDS.outbound.label.body, value: draft.body }], tab: WORDS.panels.heading.pr });
      if (item.event) sections.push({ heading: WORDS.outbound.label.event, rows: [{ label: WORDS.outbound.label.event, value: WORDS.outbound.events[item.event] }], tab: WORDS.panels.heading.pr });
      if (view.labelLine) sections.push({ heading: WORDS.outbound.label.labels, rows: [{ label: WORDS.outbound.label.labels, value: view.labelLine }], tab: WORDS.panels.heading.pr });
    }
    return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
  }
  if (item.kind === "stuck") {
    const sections: PanelSectionView[] = [
      {
        heading: WORDS.panels.heading.progress,
        tab: WORDS.panels.heading.progress,
        count: String(item.fixRounds),
        rows: [
          { label: WORDS.stuck.limit, value: item.reason },
          { label: WORDS.stuck.fixed, value: String(item.fixRounds) },
          { label: WORDS.stuck.remaining, value: String(item.open.length) },
          { label: WORDS.stuck.rejected, value: String(item.rejected.length) },
        ],
        // the prototype's round bands: one per fix the engine counted, carrying the totals the engine returned
        rounds: Array.from({ length: item.fixRounds }, (_, i) => {
          const last = i === item.fixRounds - 1;
          const segments: PanelRoundView["segments"] = last
            ? [
              { label: `${WORDS.stuck.fixed} ${item.fixRounds}`, kind: "ok" as const, flex: item.fixRounds },
              { label: `${WORDS.stuck.remaining} ${item.open.length}`, kind: "attn" as const, flex: item.open.length },
              { label: `${WORDS.stuck.rejected} ${item.rejected.length}`, kind: "line" as const, flex: item.rejected.length },
            ].filter((s) => s.flex > 0)
            : [];
          return { label: `R${i + 1}`, findings: "", detail: last ? `${WORDS.stuck.fixed} ${item.fixRounds} · ${WORDS.stuck.remaining} ${item.open.length} · ${WORDS.stuck.rejected} ${item.rejected.length}` : "", segments };
        }),
      },
    ];
    // the judge's recommendation sits on the card it is about: its choice, then the grounds, each naming a value of the rounds
    if (item.recommendation) {
      const rec = item.recommendation;
      sections.unshift({
        heading: WORDS.stuck.recommend,
        tab: WORDS.stuck.recommend,
        rows: [
          { label: WORDS.stuck.recommend, value: WORDS.stuck.recommendChoice[rec.choice] },
          ...rec.reasons.map((r) => ({ label: r.kind === "file" || r.kind === "outside" ? r.ref : `R${r.ref}`, value: r.text })),
          ...(rec.shape ? [{ label: WORDS.stuck.recommendShape, value: rec.shape }] : []),
        ],
      });
    }
    if (item.open.length) sections.push({ heading: WORDS.panels.heading.remaining, rows: item.open.map((f) => ({ label: `${f.severity} ${f.path ?? ""}`.trim(), value: f.claim })), tab: WORDS.panels.heading.remaining, count: String(item.open.length) });
    if (item.rejected.length) sections.push({ heading: WORDS.panels.heading.rejected, rows: item.rejected.map((f) => ({ label: f.claim, value: f.reason ?? "" })), tab: WORDS.panels.heading.rejected, count: String(item.rejected.length) });
    return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
  }
  if (item.kind === "duplicate") {
    const sections = panelRows([
      { label: WORDS.panels.heading.reason, value: item.reason },
      { label: WORDS.duplicate.similarity(""), value: String(item.similarity) },
      ...(item.shared ?? []).map((s) => ({ label: "同じ点", value: s })),
      { label: WORDS.duplicate.incoming, value: item.incoming.title },
      { label: WORDS.duplicate.existing, value: item.existing.title },
    ], WORDS.panels.heading.reason);
    return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
  }
  if (item.kind === "requeue") {
    const rows: RowView[] = [];
    if (item.closed) {
      rows.push({ label: WORDS.panels.previousOutcome, value: item.closed.outcome });
      if (item.closed.reason) rows.push({ label: WORDS.requeue.reason, value: item.closed.reason });
      rows.push({ label: "時刻", value: item.closed.at });
    }
    const sections = panelRows(rows, WORDS.panels.heading.previous);
    if (item.context) sections.push({ heading: WORDS.panels.heading.requeueReason, rows: [{ label: WORDS.panels.heading.requeueReason, value: item.context }], tab: WORDS.panels.heading.requeueReason });
    return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
  }
  if (item.kind === "sync_conflict") {
    const sections = panelRows(syncConflictRows(item), WORDS.syncConflict.external);
    return { ...base, lane: item.repo, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
  }
  if (item.kind === "proposal") {
    const sections = panelRows(proposalRows(item), WORDS.proposal.after);
    return { ...base, lane: proposalLane(item), tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
  }
  // any other card: the engine's materials, one section
  const sections = panelRows(genericRows(item), WORDS.panels.heading.generic);
  return { ...base, tabs: panelTabs(sections, ui.tab, handlers.setTab), sections };
}

// ------------------------------------------------------------------ actions

function buttonFrom(slot: ActionSlot, index: number, handlers: { dispatch: (intent: Intent) => void }, disabled: boolean, showKey: boolean, sign = false): CardActionView | null {
  const b = slot.buttons[index];
  if (!b) return null;
  return {
    label: b.label,
    key: showKey ? b.key : null,
    disabled: disabled || b.intent === null,
    sign,
    go: () => {
      if (b.intent) handlers.dispatch(b.intent);
    },
  };
}

/** whether the card's right-end operation is the one that reaches a signature (C-154-1) */
function signingPrimary(item: InboxItem, ctx: KeyContext): boolean {
  if (item.kind === "ship") return buildShipApproval(item, ctx.ship ?? shipDraftFor(item)).sign;
  if (item.kind === "outbound") {
    const view = buildOutboundApproval(item, ctx.outbound ?? outboundDraftFor(item));
    return view.ready && view.sign;
  }
  if (item.kind === "land-batch") {
    const view = buildBatchApproval(item, ctx.batch ?? batchDraftFor());
    return view.ready && view.sign;
  }
  return false;
}

function actionRow(item: InboxItem, ctx: KeyContext, handlers: { dispatch: (intent: Intent) => void }, busy: boolean): ActionRow {
  const slots = screenCardActions(item, ctx);
  const find = (p: ActionSlot["position"]) => slots.find((s) => s.position === p) ?? { position: p, buttons: [] };
  const back = find("back");
  const read = find("read");
  const later = find("later");
  const primary = find("primary");
  const signs = signingPrimary(item, ctx);
  const left: CardActionView[] = [];
  const splitRight: CardActionView[] = [];
  const right: CardActionView[] = [];
  for (const [i, b] of back.buttons.entries()) {
    const v = buttonFrom(back, i, handlers, busy, i === 0);
    if (!v) continue;
    // the second operation of a split shows no key of its own: the ⇧→ of 自分で直す, and the ⇧← of 今のまま受け入れる
    // the replan sits with 自分で直す on the right: sending the lane back to its plan is the other way out of the stop
    if (b.key === "⇧→" || b.intent?.kind === "stuck_replan") splitRight.push(v);
    else left.push(v);
  }
  const middle: CardActionView[] = [];
  for (const [i] of read.buttons.entries()) {
    const v = buttonFrom(read, i, handlers, busy, false);
    if (v) middle.push(v);
  }
  // the main operation comes first (the side with the key); the split's key-less side follows (AC-007)
  for (const [i] of primary.buttons.entries()) {
    const v = buttonFrom(primary, i, handlers, busy, true, signs);
    if (v) right.push(v);
  }
  right.push(...splitRight);
  return { left, middle, later: buttonFrom(later, 0, handlers, busy, true), right };
}

// ------------------------------------------------------------------ the whole thing

export function inboxVals(ui: InboxUi, source: StoreState, handlers: InboxHandlers & { dispatch: (intent: Intent) => void }): InboxModel {
  const snapshot = source.snapshot;
  const items = snapshot?.items ?? [];
  const view = deck(items, source.now, source.hidden, source.focused);
  const front = view.front[0] ?? null;
  const now = source.now || Date.now();

  const frontKey = front ? itemKey(front) : null;
  const drafts = ui.drafts;
  // a question the engine marked with exactly one recommendation opens with it chosen; once penne has touched the
  // choice the stored one stands, and a read of the state never restores the recommendation (C-154-2)
  const selection = ui.selection === undefined ? recommendedSelection(front, ui.question) : ui.selection;
  const shown = { ...ui, selection };
  let ctx: KeyContext = { noteOpen: shown.noteOpen, noteOp: shown.noteOpen ? shown.noteOp ?? null : null, confirm: ui.confirm, askOpen: shown.askOpen, note: shown.note, selection: shown.selection, question: shown.question, focusInInput: false, focusInEditor: false, confirmOpen: false, keyCount: source.sign.count };
  if (front) {
    if (front.kind === "ship") ctx = { ...ctx, ship: drafts.ship[shipCardKey(front)]?.draft ?? shipDraftFor(front) };
    else if (front.kind === "outbound") ctx = { ...ctx, outbound: outboundDraftOf(front, drafts) };
    else if (front.kind === "land-batch") ctx = { ...ctx, batch: batchDraftOf(drafts, front) };
    else if (front.kind === "go") ctx = { ...ctx, goNames: goNamesOf(drafts, front.iddId, front.purposeProposals), reasonOpen: shown.reasonOpen === true, reason: goReasonOf(drafts, front.iddId) };
    else if (front.kind === "stuck") ctx = { ...ctx, picks: stuckPicksOf(drafts, front.iddId) };
  }

  // the confirm stage: its key closes it when any of the signed content changes (DEC-9503). Only the content the
  // stage showed may sign: while the key no longer matches, the primary opens the stage again instead (AC-002).
  // The stage is read before the actions are built, so the card's right-end operation and the stage's own approve
  // both send the frozen approval while it is open (F-1).
  let confirmKey: string | null = null;
  if (front && front.kind === "ship") confirmKey = buildShipApproval(front, ctx.ship ?? shipDraftFor(front), now).confirmKey;
  else if (front && front.kind === "outbound") confirmKey = buildOutboundApproval(front, ctx.outbound ?? outboundDraftFor(front)).confirmKey;
  else if (front && front.kind === "land-batch") confirmKey = buildBatchApproval(front, ctx.batch ?? batchDraftFor()).confirmKey;
  // an operation the engine cannot take back, on a card drawn from its answer alone, goes through a confirm of its own: the
  // stage is open while the key it holds is the key of one of the card's operations over the answer and the line now
  const pending = front ? pendingOperation(front, ctx) : undefined;
  const confirmOpen = (ui.confirm !== null && ui.confirm === confirmKey) || pending !== undefined;
  ctx = { ...ctx, confirmOpen };

  // an operation the engine holds is shown as held, with its reason, and promises no key (C-265-4)
  const heldReason = front ? screenCardActions(front, ctx).flatMap((slot) => slot.buttons).find((b) => b.held)?.held : undefined;
  const built = front ? cardView(front, shown, source, handlers) : null;
  const card = built && heldReason && !built.heldReason ? { ...built, heldReason } : built;
  const panel = front ? panelView(front, cardKindOf(front), shown, source, handlers) : null;
  const actions = front ? actionRow(front, ctx, handlers, source.deciding) : { left: [], middle: [], later: null, right: [] };

  // the registration note is for the card whose primary reaches a signature (C-154-1)
  const needsRegister = source.sign.count === 0 && (front ? signingPrimary(front, ctx) : false);
  let confirming: ConfirmView | null = null;
  if (front && pending) {
    const sent = confirmedIntent(front, pending, ctx);
    confirming = {
      rows: [
        { label: WORDS.card.generic.confirmOp, value: WORDS.card.generic.op(pending.id) },
        ...(takesLine(pending) && ctx.note.trim() ? [{ label: WORDS.card.generic.confirmLine, value: ctx.note.trim() }] : []),
        ...genericRows(front),
      ],
      sign: false,
      approve: { label: WORDS.card.generic.confirmGo, key: "→", disabled: sent === null, sign: false, go: () => { if (sent) handlers.dispatch(sent); } },
      cancel: { label: WORDS.sign.cancel, key: "Esc", disabled: false, sign: false, go: () => handlers.dispatch({ kind: "confirm_close" }) },
      needsRegister: false,
      registerHere: false,
      pin: { configured: false, digits: source.sign.digits || 6, error: null, approve: () => {} },
    };
  } else if (front && confirmOpen) {
    const rows = front.kind === "land-batch"
      ? buildBatchApproval(front, ctx.batch ?? batchDraftFor()).confirmRows
      : cardKindOf(front) === "submit"
        ? buildShipApproval(front as ShipItem, ctx.ship ?? shipDraftFor(front as ShipItem), now).confirmRows
        : buildOutboundApproval(front as OutboundItem, ctx.outbound ?? outboundDraftFor(front as OutboundItem)).confirmRows;
    confirming = {
      rows,
      sign: true,
      // the second → presses the primary operation, which is the frozen approval while the confirm is open
      approve: { label: WORDS.sign.confirm, key: "→", disabled: !actions.right.length, sign: false, go: () => actions.right[0]?.go() },
      cancel: { label: WORDS.sign.cancel, key: "Esc", disabled: false, sign: false, go: () => handlers.dispatch({ kind: "confirm_close" }) },
      needsRegister,
      registerHere: isLoopback(pageHost()),
      // the PIN signs this card's own challenge, made over the rows above; it is offered only once the engine says
      // a PIN is set, and an unreadable record is its reason, never a PIN the screen pretends to have (C-182-5)
      pin: {
        // a PIN is offered only for an approval the engine says a PIN may sign (an instruction is signed by a passkey alone)
        configured: source.sign.pin === true && (front ? operationOf(front, "approve")?.signature === "passkey_or_pin" : false),
        digits: source.sign.digits || 6,
        error: source.sign.pin === null ? source.sign.pinError : null,
        approve: (value: string) => handlers.approvePin(value),
      },
    };
  }

  // the left sidebar: the deck's put-off cards, the holds, the ignore list and the running lanes
  const running: SidebarRunning[] = (snapshot?.lanes ?? [])
    .filter((l: LaneRow) => l.group === "prep" || l.group === "impl")
    .map((l) => ({ id: l.iddId, num: l.iddId, title: l.title, activity: l.activity ?? "unstarted", note: l.activity === "stalled" ? WORDS.running.stalled : l.activity === "live" ? WORDS.running.live : WORDS.running.unstarted }));
  const dueKeys = new Set(view.due.map(itemKey));
  const sidebar: InboxSidebarView = {
    next: [...view.due, ...view.front.slice(1)].map((item) => {
      // only a slept card whose ask has come is brought back here; a row that is a picture of a card already in the
      // deck must send no wake, which would hide a card the engine was never asked to sleep (F-3)
      const due = dueKeys.has(itemKey(item));
      return {
        ref: inboxLaneId(item) ?? item.kind,
        num: laneNumber(item),
        title: laneLabel(item),
        mark: CHIP[cardKindOf(item)].text,
        markBg: CHIP[cardKindOf(item)].bg,
        markC: CHIP[cardKindOf(item)].c,
        progress: waitProgress(item, due, now),
        go: () => {
          if (due) handlers.wake(item);
          else handlers.focus(item);
        },
      };
    }),
    answered: (snapshot?.answered ?? []).map((a) => ({ mark: a.kind === "question" ? "?" : a.kind === "outbound" ? "↗" : a.kind === "ship" ? "提出" : a.kind === "go" ? "GO" : "!", num: a.iddId ?? "", title: a.title ?? a.iddId ?? WORDS.sidebar.none, kind: a.kind })),
    later: [...view.later, ...view.sleeping].map((item) => ({ key: itemKey(item), num: laneNumber(item), title: laneLabel(item) || item.kind, kind: item.kind, wake: () => handlers.wake(item) })),
    holds: (snapshot?.holds ?? []).map((h: HeldIssue) => ({ ref: h.ref, title: h.title })),
    ignores: (snapshot?.ignores ?? []).map((g: IgnoredIssueView) => ({ ref: g.ref, title: g.title, unignore: () => handlers.unignore(g.ref) })),
    running,
  };

  const progress = snapshot?.progress ?? { done: 0, open: items.length };
  const total = progress.done + progress.open;
  const filled = total ? Math.round((progress.done / total) * 5) : 0;
  const segments: ("ink" | "attn" | "line")[] = Array.from({ length: 5 }, (_, i) => (i < filled ? "ink" : i === filled && progress.open > 0 ? "attn" : "line"));
  const progressView: ProgressView = { segments, label: total ? `${progress.done} / ${total}` : "", down: source.connection === "down", attempt: source.attempt };

  const error = frontKey && source.errors[frontKey] ? { text: source.errors[frontKey] } : null;

  return {
    kind: card ? card.cardKind : null,
    card,
    panel,
    actions,
    sidebar,
    progress: progressView,
    badge: view.count,
    needsRegister,
    registerHere: isLoopback(pageHost()),
    error,
    receipt: source.receipt,
    confirming,
    busy: source.deciding,
    down: source.connection === "down",
    handlers,
  };
}

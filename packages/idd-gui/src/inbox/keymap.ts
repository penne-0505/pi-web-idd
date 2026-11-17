import type { CardOperation, InboxItem, ShipItem } from "../engine/contract";
import type { ViewName } from "../view";
import { WORDS } from "../strings";
import { batchDraftFor, buildBatchApproval, buildOutboundApproval, buildShipApproval, outboundDraftFor, shipDraftFor, type BatchDraft, type OutboundDraft, type ShipDraft } from "./approval";
import { confirmedPurposes, operationOf, operationsOf } from "./operations";
import { pressedBy } from "./requests";
import { correctionsFor, declaredFindings, pickedHandling, type SentCorrection, type StuckPicks } from "./stuck-findings";

/**
 * What a key or a button means. Keeping the meaning apart from the request is what lets the screen be fixed
 * without a DOM: a test maps a key to an intent, and an intent to the engine's request, with no browser.
 *
 * What a card can be asked to do is the engine's answer on the card (`decision`): an operation it does not name has no
 * button and no key, and one it holds has a button that cannot be pressed and promises no key. The screen decides the
 * words, the place and the key of each operation it knows; an operation it does not know is drawn generically.
 */
export type Intent =
  | { kind: "read" }
  | { kind: "later" }
  | { kind: "wake" }
  | { kind: "select"; index: number }
  /** the question being answered, so the card and the panel can move between the open ones */
  | { kind: "answer"; questionId: string; selection: { index: number } | { label: "その他" }; reason?: string; notes?: string }
  | { kind: "question_prev" }
  /** opens the card's one line; `op` is the operation that opened it, which Enter sends and no other (a card with two operations that take a line) */
  | { kind: "note_open"; op?: string }
  /** 聞く opens the consultation input; nothing written in it reaches a card's judgement */
  | { kind: "ask_open" }
  | { kind: "note_close" }
  | { kind: "go_revise"; instruction: string }
  | { kind: "go_go"; purposes?: { id: string; statement: string; name?: string }[]; reason?: string }
  /** a GO that needs a reason opens its own one line (apart from the revise's), and closes it again without losing what was written */
  | { kind: "reason_open" }
  | { kind: "reason_close" }
  /** the two answers a proposal card takes: an approval, and a rejection that carries its reason */
  | { kind: "proposal_approve" }
  | { kind: "proposal_reject"; reason: string }
  /** the two judgments on one proposed Purpose of a GO card, named by the Purpose's id; the card stays where it is */
  | { kind: "purpose_restate"; id: string; statement: string }
  | { kind: "purpose_withdraw"; id: string; grounds: string }
  /** an operation the screen has no shape for, pressed by its id with the line the person wrote, if it takes one */
  | { kind: "operate"; op: string; text?: string }
  | { kind: "stuck_ignore" }
  | { kind: "stuck_accept"; note: string; corrections?: SentCorrection[] }
  | { kind: "stuck_hand_fix" }
  | { kind: "stuck_replan" }
  | { kind: "stuck_hand_fixed" }
  | { kind: "stuck_continue"; note: string; corrections?: SentCorrection[] }
  | { kind: "stuck_budget" }
  | { kind: "stuck_resume"; note: string }
  | { kind: "stuck_send_back"; instruction: string }
  | { kind: "duplicate_merge" }
  | { kind: "duplicate_anyway" }
  | { kind: "requeue_ignore" }
  | { kind: "requeue_go" }
  /** the confirm stage is open: the next -> signs what it showed, and this carries that exact content */
  | { kind: "confirm_open"; confirmKey: string }
  | { kind: "confirm_close" }
  | { kind: "ship_check"; payload: Record<string, unknown> }
  | { kind: "ship_revise"; instruction: string }
  /** the approval's action and payload, frozen when the confirm opened; the signing path sends exactly this */
  | { kind: "ship_approve"; action: string; payload: Record<string, unknown> }
  | { kind: "outbound_approve"; action: string; payload: Record<string, unknown> }
  | { kind: "outbound_discard" };

export interface KeyContext {
  /** the one-line input under the card is open */
  noteOpen: boolean;
  /** what is written in it now */
  note: string;
  /** the open one-line input is the consultation 聞く opened, not the answer, so it must send nothing */
  askOpen?: boolean;
  /** the question option picked with 1–4, if any */
  selection: number | null;
  /** which of the item's open questions the card shows; absent means the first */
  question?: number;
  /** focus is inside the one-line input, so letters and arrows must not move the card */
  focusInInput: boolean;
  /** focus is inside any other editing field (a PR's text, a commit message, a reply, a review's body):
   * while it is, no key reaches the card at all, so writing an approval's content never moves it */
  focusInEditor?: boolean;
  /** the confirm stage of a signing card is open */
  confirmOpen?: boolean;
  /** the key of the confirm stage that is open now, if any: an operation the engine cannot take back is sent only when this is its own key */
  confirm?: string | null;
  /** the operation that opened the one-line input, if one did: Enter sends this one and never another that also takes a line */
  noteOp?: string | null;
  /** how many keys this page's host has: 0 blocks the approval, null or undefined lets the engine's challenge decide */
  keyCount?: number | null;
  /** the handling penne picked for each finding of a stopped review card (C-272-1) */
  picks?: StuckPicks;
  /** the values penne has edited on this submit card */
  ship?: ShipDraft;
  /** the values penne has edited on this outbound card */
  outbound?: OutboundDraft;
  /** the names penne typed for a GO card's proposed Purposes, by proposal id */
  goNames?: Record<string, string>;
  /** the GO's reason line is open (it takes the one-line input's place; the revise's line is closed while it is) */
  reasonOpen?: boolean;
  /** what penne wrote as the reason for this GO */
  reason?: string;
  /** the lanes penne took off a batch card */
  batch?: BatchDraft;
}

export const EMPTY_CONTEXT: KeyContext = { noteOpen: false, note: "", selection: null, focusInInput: false, focusInEditor: false, confirmOpen: false };

export interface ActionButton {
  label: string;
  intent: Intent | null;
  /** the key shown on the button; empty when the button promises none (a held or key-less operation) */
  key: string;
  /** the engine's reason the operation cannot be given now, when it holds it: the button shows it and promises no key */
  held?: string;
}

export interface ActionSlot {
  position: "back" | "read" | "later" | "primary";
  buttons: ActionButton[];
}

/** whether a proposal is about the user's instructions: only a label for the card, never what its answer may do */
export function isInstructionProposal(proposalKind: string): boolean {
  return proposalKind.startsWith("instruction_");
}

/** the engine's operation that takes a line of text, if the card has one that needs a reason or a note */
function takesText(op: CardOperation | undefined): op is CardOperation & { input: { kind: "text"; field: string; required: boolean } } {
  return op?.input.kind === "text";
}

/** an operation the engine holds is drawn but cannot be pressed, and promises no key */
function button(label: string, intent: Intent | null, key: string, op: CardOperation | undefined): ActionButton {
  if (op?.hold) return { label, intent: null, key: "", held: op.hold.reason };
  return { label, intent, key };
}

/** the button of an engine operation, or none when the engine named none */
function opButton(item: InboxItem, ids: string | string[], label: string | ((op: CardOperation) => string), key: string, make: (op: CardOperation) => Intent | null): ActionButton[] {
  const op = operationOf(item, ...(Array.isArray(ids) ? ids : [ids]));
  if (!op) return [];
  return [button(typeof label === "function" ? label(op) : label, make(op), key, op)];
}

/**
 * Whether the engine takes this GO only with a reason: the plan review left a must nobody confirmed. The screen reads
 * the engine's own answer and decides nothing of its own.
 */
export function goNeedsReason(item: InboxItem): boolean {
  return operationOf(item, "go")?.needsReason === true;
}

/** why the engine holds the GO now (a dependency not landed, an empty contract), or null when it does not */
export function goHeldReason(item: InboxItem): string | null {
  return operationOf(item, "go")?.hold?.reason ?? null;
}

/** the GO's right end: the press that sends it, or that opens the reason line first and sends once a reason is written */
function goPrimary(op: CardOperation, ctx: KeyContext): Intent | null {
  // the GO press confirms exactly the Purposes the engine's answer named, with the sentence it showed and the names penne typed
  const purposes = confirmedPurposes(op).map((p) => {
    const name = ctx.goNames?.[p.id]?.trim();
    return { id: p.id, statement: p.statement, ...(name ? { name } : {}) };
  });
  const base = purposes.length ? { purposes } : {};
  if (!op.needsReason) return { kind: "go_go", ...base };
  // a reason is required: the press opens its line, and an empty line sends nothing
  if (!ctx.reasonOpen) return { kind: "reason_open" };
  const reason = ctx.reason?.trim();
  return reason ? { kind: "go_go", ...base, reason } : null;
}

/**
 * The index of the open question a stored index means, clamped into the item's own range. The card, the right panel
 * and the answer all read their question through this, so the question the panel shows is the question an answer is
 * sent to, even when a state read shrinks the open list under an index that was picked for a longer one.
 */
export function openQuestionIndex(count: number, index: number | null | undefined): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, index ?? 0), count - 1);
}

function questionAnswer(item: Extract<InboxItem, { kind: "question" }>, ctx: KeyContext): Intent | null {
  // 聞く's input is a consultation: what is written there is not the answer, so neither the key nor the button
  // may send it. The consultation's own channel is not wired yet, so the input carries it nowhere for now.
  if (ctx.askOpen) return null;
  const open = item.open[openQuestionIndex(item.open.length, ctx.question)];
  if (!open) return null;
  if (ctx.selection !== null) {
    const reason = ctx.note.trim();
    return { kind: "answer", questionId: open.questionId, selection: { index: ctx.selection }, ...(reason ? { reason } : {}) };
  }
  const free = ctx.note.trim();
  // the free answer is the answer itself, so it goes to the engine as the answer's notes, not as a reason
  return free ? { kind: "answer", questionId: open.questionId, selection: { label: "その他" }, notes: free } : null;
}

/**
 * Whether the open confirm is the signing stage of an approval. A confirm opened for an operation the engine cannot take back
 * (its key starts with `op:`) is another stage: it must not make the card's approval read as already confirmed.
 */
function signConfirmOpen(ctx: KeyContext): boolean {
  return ctx.confirmOpen === true && !ctx.confirm?.startsWith("op:");
}

/**
 * The frozen approval an open confirm's primary carries: the same action and payload the → sends. The confirm
 * stage's PIN press signs this, so the PIN and the passkey sign the one approval the stage showed (C-182-6).
 */
export function approvalIntentOf<K extends "ship_approve" | "outbound_approve">(
  view: { action: string | null; payload: Record<string, unknown> },
  kind: K,
): { kind: K; action: string; payload: Record<string, unknown> } | null {
  return view.action ? { kind, action: view.action, payload: view.payload } : null;
}

/**
 * The one operation at the right end of a submit card: the approval, the check, or none. The approval's kind, whether it
 * is held and the conditions on the text come from the engine's answer; the view shows whether the text now meets them.
 */
function shipPrimary(item: ShipItem, ctx: KeyContext): { view: ReturnType<typeof buildShipApproval>; intent: Intent | null } {
  const view = buildShipApproval(item, ctx.ship ?? shipDraftFor(item));
  // no key is registered for this host: a signed approval cannot be given, so the right end does not open the confirm
  if (view.primary === "approve" && view.action) {
    if (ctx.keyCount === 0) return { view, intent: null };
    return { view, intent: signConfirmOpen(ctx) ? { kind: "ship_approve", action: view.action, payload: view.payload } : { kind: "confirm_open", confirmKey: view.confirmKey } };
  }
  if (view.primary === "check") return { view, intent: { kind: "ship_check", payload: view.payload } };
  return { view, intent: null };
}

/**
 * The one operation at the right end of a card whose approval is built ahead of the press: the approval when it is
 * ready and a key is registered (the confirm stage shows the rows first), none otherwise.
 */
function readyPrimary<V extends { ready: boolean; action: string; payload: Record<string, unknown>; confirmKey: string }>(view: V, kind: "ship_approve" | "outbound_approve", ctx: KeyContext): { view: V; intent: Intent | null } {
  if (!view.ready || ctx.keyCount === 0) return { view, intent: null };
  return { view, intent: signConfirmOpen(ctx) ? { kind, action: view.action, payload: view.payload } : { kind: "confirm_open", confirmKey: view.confirmKey } };
}

/** the signature over the lanes left on a batch card: the same intent a submit card's approval is */
const batchPrimary = (item: Extract<InboxItem, { kind: "land-batch" }>, ctx: KeyContext) => readyPrimary(buildBatchApproval(item, ctx.batch ?? batchDraftFor()), "ship_approve", ctx);

/** the one operation at the right end of an outbound card */
const outboundPrimary = (item: Extract<InboxItem, { kind: "outbound" }>, ctx: KeyContext) => readyPrimary(buildOutboundApproval(item, ctx.outbound ?? outboundDraftFor(item)), "outbound_approve", ctx);

/** the operation a one-line input belongs to: what Enter sends when the line is open */
function submitNote(item: InboxItem, ctx: KeyContext): Intent | null {
  const note = ctx.note.trim();
  if (item.kind === "question") return questionAnswer(item, ctx);
  const sendBack = operationOf(item, "send_back");
  if (sendBack) return note ? { kind: "stuck_send_back", instruction: note } : null;
  // a submit card has two operations that take a line (直させる and 切り出す): Enter sends the one that opened it
  if (item.kind === "ship" && ctx.noteOp && ctx.noteOp !== "revise") {
    const opened = operationOf(item, ctx.noteOp);
    if (opened && takesText(opened)) return operateWith(opened, note);
  }
  if (operationOf(item, "revise") && (item.kind === "go" || item.kind === "ship")) return note ? (item.kind === "go" ? { kind: "go_revise", instruction: note } : { kind: "ship_revise", instruction: note }) : null;
  // a proposal's one-line note is the rejection's reason; without one the rejection is refused by the engine
  if (operationOf(item, "reject") && item.kind === "proposal") return note ? { kind: "proposal_reject", reason: note } : null;
  if (item.kind === "stuck") {
    const resume = operationOf(item, "resume");
    if (resume) return { kind: "stuck_resume", note };
    // the line the accept opened is the accept's: Enter sends that, never the continue the card also offers
    if (ctx.noteOp === "accept") {
      const accept = operationOf(item, "accept");
      return accept ? confirmedIntent(item, accept, ctx) : null;
    }
    const go = operationOf(item, "continue");
    if (!go) return null;
    if (takesText(go) && go.input.required && !note) return null;
    if (lowersMustWithoutReason(go, ctx)) return null;
    return { kind: "stuck_continue", note, ...withCorrections(go, ctx) };
  }
  // a card the screen has no shape for: its one line goes to the operation that opened it
  if (isShaped(item)) return null;
  const taking = lineOperation(item, ctx);
  return taking ? pressGeneric(taking, ctx) : null;
}

/**
 * The operation the card's one line belongs to: the one that opened it, or the only one that takes a line. When two take
 * one and none opened it, the line belongs to neither, so Enter sends nothing rather than choosing one for the person.
 */
function lineOperation(item: InboxItem, ctx: KeyContext): CardOperation | undefined {
  const taking = operationsOf(item).filter((op) => takesText(op));
  const opened = ctx.noteOp ? taking.find((op) => op.id === ctx.noteOp) : undefined;
  if (opened) return opened;
  return taking.length === 1 ? taking[0] : undefined;
}

/** the kinds the screen has a shape of its own for; the rest are drawn from the engine's operations alone */
function isShaped(item: InboxItem): boolean {
  return ["question", "go", "proposal", "ship", "outbound", "land-batch", "stuck", "duplicate", "requeue"].includes(item.kind);
}

/**
 * The key of the confirm an operation the engine cannot take back goes through: the key the engine gave it, which covers the
 * operation, the card's material and the lines the confirm shows, and the line the person wrote for it. Any of them changing
 * makes a different key, so a confirm opened over one answer never sends another. The screen composes no part of the engine's.
 */
export function operationConfirmKey(op: CardOperation, text: string): string {
  return `op:${op.id}:${op.confirmKey}:${text.trim()}`;
}

/** the corrections a press of this operation sends, once penne has picked handlings (none when she picked none) */
function withCorrections(op: CardOperation, ctx: KeyContext): { corrections?: SentCorrection[] } {
  const corrections = correctionsFor(declaredFindings(op), ctx.picks ?? {}, ctx.note);
  return corrections.length ? { corrections } : {};
}

/** whether the picks put off a must (lower it and do not fix it) with no written reason: the ground it is put off on is recorded, and a must lowered but still fixed needs none */
function lowersMustWithoutReason(op: CardOperation, ctx: KeyContext): boolean {
  if (ctx.note.trim()) return false;
  const declared = declaredFindings(op);
  return correctionsFor(declared, ctx.picks ?? {}, ctx.note).some((c) => c.severity !== "must" && c.action !== "fix" && declared.find((f) => f.ref === c.ref)?.severity === "must");
}

/** whether penne has picked fix for any finding: an accept ends the loop without fixing, so it is not offered beside a fix she chose */
function picksFix(op: CardOperation | undefined, ctx: KeyContext): boolean {
  return declaredFindings(op).some((f) => pickedHandling(f, ctx.picks ?? {})?.action === "fix");
}

/**
 * The intent a confirmed press of this operation sends. A stopped card's continue and accept carry the picked corrections
 * with the line, as the press that opened the confirm did, so the answer the confirm showed is the answer that is sent.
 */
export function confirmedIntent(item: InboxItem, op: CardOperation, ctx: KeyContext): Intent | null {
  if (item.kind === "stuck" && (op.id === "continue" || op.id === "accept")) {
    if (op.hold) return null;
    if (op.id === "accept" && picksFix(op, ctx)) return null;
    if (takesText(op) && op.input.required && !ctx.note.trim()) return null;
    if (lowersMustWithoutReason(op, ctx)) return null;
    return { kind: op.id === "continue" ? "stuck_continue" : "stuck_accept", note: ctx.note, ...withCorrections(op, ctx) };
  }
  return operateWith(op, ctx.note);
}

/** the line a confirm of this operation is keyed by: the written line, and the handlings picked, so a changed pick opens a new confirm */
function confirmLine(op: CardOperation, ctx: KeyContext): string {
  const corrections = withCorrections(op, ctx).corrections;
  return corrections ? `${ctx.note}\n${JSON.stringify(corrections)}` : ctx.note;
}

/** the operation a generic card's open confirm is for, if the key it holds is the key of one of the card's operations */
export function pendingOperation(item: InboxItem, ctx: KeyContext): CardOperation | undefined {
  if (!ctx.confirm || !ctx.confirm.startsWith("op:")) return undefined;
  return operationsOf(item).find((op) => op.irreversible && !op.hold && operationConfirmKey(op, confirmLine(op, ctx)) === ctx.confirm);
}

/**
 * The press of an operation of a card drawn from the engine's answer alone. One that takes a line opens it first, and the
 * line belongs to this operation from then on; one the engine says cannot be taken back opens a confirm first and is sent
 * only by a press made while the confirm for exactly this answer and this line is open (DEC-9188).
 */
function pressGeneric(op: CardOperation, ctx: KeyContext): Intent | null {
  if (op.hold) return null;
  if (takesText(op) && (!ctx.noteOpen || (ctx.noteOp && ctx.noteOp !== op.id))) return { kind: "note_open", op: op.id };
  const send = operateWith(op, ctx.note);
  if (!send || !op.irreversible) return send;
  const key = operationConfirmKey(op, confirmLine(op, ctx));
  return ctx.confirm === key ? send : { kind: "confirm_open", confirmKey: key };
}

/**
 * An intent that presses an operation the engine says cannot be taken back, and that needs no signature, goes through the
 * confirm of that operation first: the press opens it, and only a press made while the confirm for exactly this answer and
 * this line is open sends. This reads the operation's own `irreversible` and `signature`, never a list of intents or kinds
 * (C-265-8); a signed approval has the signing stage of its own, and an intent that sends nothing passes unchanged.
 */
function gateIrreversible(item: InboxItem, intent: Intent | null, ctx: KeyContext): Intent | null {
  if (!intent) return intent;
  const op = pressedBy(intent, item)?.op;
  if (!op || op.hold || !op.irreversible || op.signature !== "none") return intent;
  const key = operationConfirmKey(op, confirmLine(op, ctx));
  return ctx.confirm === key ? intent : { kind: "confirm_open", confirmKey: key };
}

/** the intent that presses an operation by its id with the line written for it; a required line that is empty sends nothing */
export function operateWith(op: CardOperation, text: string): Intent | null {
  if (op.hold) return null;
  if (takesText(op)) {
    const line = text.trim();
    if (op.input.required && !line) return null;
    return { kind: "operate", op: op.id, ...(line ? { text: line } : {}) };
  }
  return { kind: "operate", op: op.id };
}

/** the same four positions the prototype fixes; a slot with no buttons is left empty */
export function cardActions(item: InboxItem, ctx: KeyContext = EMPTY_CONTEXT): ActionSlot[] {
  return shapedActions(item, ctx).map((slot) => ({ ...slot, buttons: slot.buttons.map((b) => (b.intent ? { ...b, intent: gateIrreversible(item, b.intent, ctx) } : b)) }));
}

function shapedActions(item: InboxItem, ctx: KeyContext): ActionSlot[] {
  const B = (label: string, intent: Intent | null, key: string): ActionButton => ({ label, intent, key });
  const laterButtons = opButton(item, "later", WORDS.card.later, "↓", () => ({ kind: "later" }));
  const slots = (...all: ActionSlot[]): ActionSlot[] => {
    const byPosition = new Map(all.map((slot) => [slot.position, slot]));
    return (["back", "read", "later", "primary"] as const).map((position) => byPosition.get(position) ?? { position, buttons: [] });
  };
  const later: ActionSlot = { position: "later", buttons: laterButtons };

  if (item.kind === "question") {
    // the prototype's four operations: 前の質問 | 背景を読む · 聞く | 後で | 次の質問. 聞く opens the consultation
    // input, not the answer's; it has no key of its own, like the second side of any split.
    return slots(
      { position: "back", buttons: [B(WORDS.card.back.prevQuestion, { kind: "question_prev" }, "←")] },
      { position: "read", buttons: [B(WORDS.card.back.questionRead, { kind: "read" }, "␣"), B(WORDS.card.back.ask, { kind: "ask_open" }, "")] },
      later,
      { position: "primary", buttons: opButton(item, "answer", WORDS.card.primary.question, "→", () => questionAnswer(item, ctx)) },
    );
  }
  if (item.kind === "go") {
    const revise: Intent | null = ctx.noteOpen
      ? (ctx.note.trim() ? { kind: "go_revise", instruction: ctx.note.trim() } : null)
      : { kind: "note_open" };
    return slots(
      {
        position: "back",
        buttons: [
          ...opButton(item, "revise", WORDS.card.back.revise, "←", () => revise),
          // no line of its own: the engine names it, and it sits on the shifted key like the other lane-stopping answers
          ...opButton(item, "ignore", WORDS.card.back.ignore, "⇧←", (op) => operateWith(op, "")),
        ],
      },
      { position: "read", buttons: [B(WORDS.card.readPlan, { kind: "read" }, "␣")] },
      later,
      { position: "primary", buttons: opButton(item, "go", WORDS.card.primary.go, "→", (op) => goPrimary(op, ctx)) },
    );
  }
  if (item.kind === "proposal") {
    // → approves, ← rejects (opening the one-line input first, and sending only when it is written), ↓ puts it off
    const reject: Intent | null = ctx.noteOpen
      ? (ctx.note.trim() ? { kind: "proposal_reject", reason: ctx.note.trim() } : null)
      : { kind: "note_open" };
    return slots(
      { position: "back", buttons: opButton(item, "reject", WORDS.card.back.reject, "←", () => reject) },
      { position: "read", buttons: [B(WORDS.card.readDetail, { kind: "read" }, "␣")] },
      later,
      { position: "primary", buttons: opButton(item, "approve", WORDS.card.primary.approve, "→", () => ({ kind: "proposal_approve" })) },
    );
  }
  if (item.kind === "ship") {
    const { view, intent } = shipPrimary(item, ctx);
    // the line is shared by the two operations that take one; ← sends 直させる, ⇧← sends 切り出す, and a press of the one
    // the line is not open for turns the line to it first, so a line written for one is never sent as the other
    const revise: Intent | null = !ctx.noteOpen
      ? { kind: "note_open" }
      : ctx.noteOp && ctx.noteOp !== "revise"
        ? { kind: "note_open", op: "revise" }
        : ctx.note.trim() ? { kind: "ship_revise", instruction: ctx.note.trim() } : null;
    return slots(
      { position: "back", buttons: [
        ...opButton(item, "revise", WORDS.card.back.revise, "←", () => revise),
        ...opButton(item, "sub_todo", WORDS.card.back.subTodo, "⇧←", (op) => (ctx.noteOpen && ctx.noteOp === op.id ? operateWith(op, ctx.note) : op.hold ? null : { kind: "note_open", op: op.id })),
      ] },
      { position: "read", buttons: [B(WORDS.card.readDetail, { kind: "read" }, "␣")] },
      later,
      { position: "primary", buttons: [{ label: view.primaryLabel ?? WORDS.card.primary.advance, intent, key: "→" }] },
    );
  }
  if (item.kind === "outbound" || item.kind === "land-batch") {
    // a batch card's lanes are taken off on the card itself; the keys only read, put off, or sign what is left
    const { view, intent } = item.kind === "outbound" ? outboundPrimary(item, ctx) : batchPrimary(item, ctx);
    const first: ActionSlot = item.kind === "outbound"
      ? { position: "back", buttons: opButton(item, "discard", WORDS.card.back.discard, "←", () => ({ kind: "outbound_discard" })) }
      : { position: "read", buttons: [B(WORDS.card.readDetail, { kind: "read" }, "␣")] };
    return slots(first, later, { position: "primary", buttons: [B(view.primaryLabel, intent, "→")] });
  }
  if (item.kind === "stuck") {
    const back: ActionButton[] = [
      ...opButton(item, ["ignore", "close"], (op) => (op.id === "close" ? WORDS.card.back.close : WORDS.card.back.ignore), "←", () => ({ kind: "stuck_ignore" })),
      ...(picksFix(operationOf(item, "accept"), ctx) ? [] : opButton(item, "accept", WORDS.card.back.accept, "⇧←", (op) => (lowersMustWithoutReason(op, ctx) ? (ctx.noteOpen ? null : { kind: "note_open", op: op.id }) : { kind: "stuck_accept", note: ctx.note, ...withCorrections(op, ctx) }))),
      ...opButton(item, "send_back", WORDS.card.back.sendBack, "⇧←", () => (ctx.noteOpen ? (ctx.note.trim() ? { kind: "stuck_send_back", instruction: ctx.note.trim() } : null) : { kind: "note_open" })),
      ...opButton(item, "hand_fix", WORDS.card.back.handFix, "⇧→", () => ({ kind: "stuck_hand_fix" })),
      // no key of its own: sending the lane back to its plan is pressed, not slipped into
      ...opButton(item, "replan", WORDS.card.back.replan, "", () => ({ kind: "stuck_replan" })),
    ];
    const cont = operationOf(item, "continue");
    const needsNote = takesText(cont) && cont.input.required;
    const primary: ActionButton[] = [
      ...opButton(item, "hand_fixed", WORDS.card.primary.handFixed, "→", () => ({ kind: "stuck_hand_fixed" })),
      ...opButton(item, "budget_extend", WORDS.card.primary.budget, "→", () => ({ kind: "stuck_budget" })),
      ...opButton(item, "resume", WORDS.card.primary.resume, "→", () => ({ kind: "stuck_resume", note: ctx.note })),
      ...opButton(item, "retry", WORDS.card.primary.retry, "→", () => ({ kind: "stuck_resume", note: "" })),
      ...opButton(item, "continue", WORDS.card.primary.continue, "→", (op) => (needsNote || lowersMustWithoutReason(op, ctx) ? (ctx.noteOpen ? (ctx.note.trim() ? { kind: "stuck_continue", note: ctx.note, ...withCorrections(op, ctx) } : null) : { kind: "note_open" }) : { kind: "stuck_continue", note: ctx.note, ...withCorrections(op, ctx) })),
    ];
    return slots(
      { position: "back", buttons: back },
      { position: "read", buttons: [B(WORDS.card.readProgress, { kind: "read" }, "␣")] },
      later,
      { position: "primary", buttons: primary },
    );
  }
  if (item.kind === "duplicate") {
    return slots(
      { position: "back", buttons: opButton(item, "merge", WORDS.card.back.merge, "←", () => ({ kind: "duplicate_merge" })) },
      { position: "read", buttons: [B(WORDS.card.readReason, { kind: "read" }, "␣")] },
      later,
      { position: "primary", buttons: opButton(item, "anyway", WORDS.card.primary.anyway, "→", () => ({ kind: "duplicate_anyway" })) },
    );
  }
  if (item.kind === "requeue") {
    return slots(
      { position: "back", buttons: opButton(item, "ignore", WORDS.card.back.requeueDrop, "←", () => ({ kind: "requeue_ignore" })) },
      { position: "read", buttons: [B(WORDS.card.readPrevious, { kind: "read" }, "␣")] },
      later,
      { position: "primary", buttons: opButton(item, "requeue", WORDS.card.primary.requeue, "→", () => ({ kind: "requeue_go" })) },
    );
  }
  if (item.kind === "storage" || item.kind === "sync_conflict") {
    // these cards carry no judgement: only "あとで" is offered. The low-space card is switched by the settings; a sync
    // conflict closes at the next sync once either side is back to the same value, so there is nothing to answer
    return slots(later);
  }
  // every other card is drawn from the engine's operations alone: the first is the main one (→), the rest sit with the
  // other answers, and one that takes a line of text takes the card's one line
  const ops = operationsOf(item).filter((op) => op.id !== "later");
  const [main, ...rest] = ops;
  const generic = (op: CardOperation, key: string): ActionButton => button(WORDS.card.generic.op(op.id), pressGeneric(op, ctx), key, op);
  return slots(
    { position: "back", buttons: rest.map((op, i) => generic(op, i === 0 ? "←" : "")) },
    { position: "read", buttons: [B(WORDS.card.readDetail, { kind: "read" }, "␣")] },
    later,
    { position: "primary", buttons: main ? [generic(main, "→")] : [] },
  );
}

/** the operations the screen offers for an item: the card's own meanings, read from the engine's answer */
export function screenCardActions(item: InboxItem, ctx: KeyContext = EMPTY_CONTEXT): ActionSlot[] {
  return cardActions(item, ctx);
}

/**
 * A key press as the screen reads it. `shift` is part of a card's own spelling (⇧← / ⇧→), while alt / ctrl / meta
 * are the browser's shortcuts: the screen must read them so a press it does not own never becomes a judgement.
 */
export interface KeyPress {
  key: string;
  shift?: boolean;
  repeat?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  /** the browser says an IME composition is in flight while this keydown fired */
  isComposing?: boolean;
  /** the older signal for the same thing: 229 is the Enter that ends an IME conversion */
  keyCode?: number;
}

export type KeyName = "left" | "right" | "down" | "space" | "enter" | "escape" | "digit";

export function keyName(key: string): KeyName | null {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowDown") return "down";
  if (key === " " || key === "Spacebar" || key === "Space") return "space";
  if (key === "Enter") return "enter";
  if (key === "Escape") return "escape";
  if (/^[1-4]$/.test(key)) return "digit";
  return null;
}

/** the notation each arrow key is shown with on a button; a press is matched against the display, not a position */
const KEY_HINT: Partial<Record<KeyName, string>> = {
  left: "←",
  right: "→",
  down: "↓",
  space: "␣",
};

/**
 * The intent a key press means for a card, or null when it means nothing. A held key counts once: only the first
 * keydown of a press (`repeat` false) is read, so a long press cannot run a decision per repeat. A press with alt /
 * ctrl / meta means nothing here: those keys are the browser's own shortcuts (alt+← is back, cmd+→ is forward), and
 * reading one as a card's decision would send a judgement the person never meant to press. While focus is in
 * any editing field no key reaches the card, so writing the text a signature will cover cannot move it; the
 * one-line input keeps its own behavior (Esc closes it, Enter sends it, arrows stay in it). An Enter that belongs to
 * an IME composition is the input's own keypress, so it decides nothing anywhere: converting Japanese ends with
 * Enter, and reading it as a card's decision would hand an unfinished sentence to the engine with nothing left to
 * take it back. What this returns is what the `slots` it is given puts on the buttons, so a key and its button
 * cannot drift apart: an open input does not make a key send a decision the button does not show. Where a card's ←
 * button is the note's own send (the GO's revise, a proposal's rejection, a submit's send-back, a halt's send-back
 * on ⇧←), that button still sends it.
 */
function intentFor(item: InboxItem, press: KeyPress, ctx: KeyContext, slots: (item: InboxItem, ctx: KeyContext) => ActionSlot[]): Intent | null {
  if (press.repeat) return null;
  // an IME conversion's own Enter (or any keydown the browser marks as composing) is not a card's judgement; the
  // chat composer gates the same press the same way (`chat/keys.ts`)
  if (press.isComposing === true || press.keyCode === 229) return null;
  if (press.alt || press.ctrl || press.meta) return null;
  const name = keyName(press.key);
  if (name === null) return null;
  if (ctx.focusInEditor) return null;
  if (ctx.noteOpen && name === "escape") return { kind: "note_close" };
  if (ctx.noteOpen && name === "enter") return gateIrreversible(item, submitNote(item, ctx), ctx);
  // the GO's reason line: Esc closes it (the words stay), Enter sends the GO with them, and an empty line sends nothing; while focus is in it → stays the input's cursor, like any arrow in a text input
  const goOp = item.kind === "go" ? operationOf(item, "go") : undefined;
  if (ctx.reasonOpen && goOp?.needsReason && !goOp.hold) {
    if (name === "escape") return { kind: "reason_close" };
    if (name === "enter") return gateIrreversible(item, goPrimary(goOp, ctx), ctx);
  }
  if (ctx.confirmOpen && name === "escape") return { kind: "confirm_close" };
  if (ctx.focusInInput) return null;
  if (item.kind === "question" && name === "digit") return { kind: "select", index: Number(press.key) };
  // the confirm of an operation the engine cannot take back is open: its → is the one the confirm shows, sending that operation
  const pending = pendingOperation(item, ctx);
  if (pending && name === "right" && !press.shift) return confirmedIntent(item, pending, ctx);
  const hint = KEY_HINT[name];
  if (!hint) return null;
  // a shifted arrow is its own key only where a button shows one (⇧← / ⇧→)
  const shown = (name === "left" || name === "right") && press.shift ? `⇧${hint}` : hint;
  // a press means what the button showing that key means, so the display and the key cannot drift apart
  for (const slot of slots(item, ctx)) {
    for (const button of slot.buttons) {
      if (button.key === shown) return button.intent;
    }
  }
  return null;
}

/** the intent a card's own key means, card by card, without the screen's own gate */
export function intentForKey(item: InboxItem, press: KeyPress, ctx: KeyContext = EMPTY_CONTEXT): Intent | null {
  return intentFor(item, press, ctx, cardActions);
}

/**
 * The intent a key press means at the screen as a whole, not only at a card. A card's keys belong to the Inbox:
 * while another screen is up, the card is not in front of the user, so no key may become a decision that was never
 * seen and cannot be taken back. With the Inbox up this is `screenCardActions`, so an item the screen draws no card
 * for takes only the screen's own skip.
 */
export function intentForScreen(
  view: ViewName,
  item: InboxItem | null,
  press: KeyPress,
  ctx: KeyContext = EMPTY_CONTEXT,
): Intent | null {
  if (view !== "inbox" || !item) return null;
  return intentFor(item, press, ctx, screenCardActions);
}

/**
 * Whether the intent presses an operation the engine says cannot be taken back (so the screen keeps a line of what it did).
 * The operation's own `irreversible` decides, never a list of intents here (DEC-9188).
 */
export function isIrreversible(intent: Intent, item: InboxItem): boolean {
  return pressedBy(intent, item)?.op?.irreversible === true;
}

/** the placeholder of the one-line input a card opens, or null when the card opens none */
export function notePlaceholder(item: InboxItem, noteOp?: string | null): string | null {
  if (item.kind === "question") return WORDS.card.note.questionPlaceholder;
  if (operationOf(item, "send_back")) return WORDS.card.note.sendBackPlaceholder;
  if (item.kind === "ship" && noteOp === "sub_todo") return WORDS.card.note.subTodoPlaceholder;
  if (item.kind === "go" || item.kind === "ship") return operationOf(item, "revise") ? WORDS.card.note.revisePlaceholder : null;
  if (item.kind === "proposal") return operationOf(item, "reject") ? WORDS.card.note.rejectPlaceholder : null;
  // a stop whose note the engine records as the answer to the judgement's one question names its line the answer
  if (item.kind === "stuck" && item.noteAnswersQuestion && operationsOf(item).some((op) => takesText(op))) return WORDS.card.note.answerPlaceholder;
  // any other card that has an operation taking a line of text opens the one line
  return operationsOf(item).some((op) => takesText(op)) ? WORDS.card.note.placeholder : null;
}

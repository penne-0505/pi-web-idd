import type { CardOperation, InboxItem, OperationSignature } from "../engine/contract";
import { snoozeKey } from "../engine/contract";
import type { Intent } from "./keymap";
import { confirmedPurposes, operationOf } from "./operations";

/** a call the screen makes; the engine's API only, and with the same path, action and payload the current GUI sends */
export interface EngineRequest {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  /** how the engine says this call is signed; the sending path asks for the signature only when it is not "none" */
  signature: OperationSignature;
  /** the engine says the card stays after the press (a check, a rewrite of one Purpose): it is not hidden */
  keepsCard?: boolean;
}

export interface DecidePayload {
  action: string;
  payload: Record<string, unknown>;
}

const DOORS = { decide: "/api/idd/decide", snooze: "/api/idd/snooze", reload: "/api/idd/reload" } as const;

/** the request of an engine operation with the input the person gave; a held operation sends nothing */
function requestOf(op: CardOperation | undefined, item: InboxItem, extra: Record<string, unknown> = {}): EngineRequest | null {
  if (!op || op.hold) return null;
  if (op.door === "snooze") return { method: "POST", path: DOORS.snooze, body: { key: snoozeKey(item) }, signature: "none" };
  if (op.door === "reload") return { method: "POST", path: DOORS.reload, body: {}, signature: op.signature };
  return { method: "POST", path: DOORS.decide, body: { action: op.action, payload: { ...op.payload, ...extra } }, signature: op.signature, ...(op.keepsCard ? { keepsCard: true } : {}) };
}

/**
 * The corrections ride the field the operation's answer declares for them and no other: an operation that declares none
 * sends none, so the request is never more than the engine said the press may carry (C-265-9).
 */
function withCorrections(found: CardOperation | undefined, extra: Record<string, unknown>, corrections: readonly unknown[] | undefined): Record<string, unknown> {
  const field = found?.input.kind === "text" ? found.input.corrections?.field : undefined;
  return field && corrections?.length ? { ...extra, [field]: corrections } : extra;
}

/** the operation an intent presses and the person's input it carries; the request and the "cannot be taken back" line both read it */
export interface Pressed {
  op: CardOperation | undefined;
  extra: Record<string, unknown>;
}

/**
 * The operation of the engine's answer an intent presses, or null when the intent stays on the screen (reading a panel,
 * opening the one-line input, picking an option) or is not an operation (waking a card). Whether a press cannot be taken
 * back is read from this operation's `irreversible`, not from a list of intents (DEC-9188).
 */
export function pressedBy(intent: Intent, item: InboxItem): Pressed | null {
  const op = (...ids: string[]) => operationOf(item, ...ids);
  const press = (found: CardOperation | undefined, extra: Record<string, unknown> = {}): Pressed => ({ op: found, extra });
  switch (intent.kind) {
    case "read":
    case "select":
    case "question_prev":
    case "note_open":
    case "ask_open":
    case "note_close":
    case "reason_open":
    case "reason_close":
    case "confirm_open":
    case "confirm_close":
    case "wake":
      return null;
    case "later":
      return press(op("later"));
    case "operate": {
      const found = op(intent.op);
      const field = found?.input.kind === "text" ? found.input.field : null;
      return press(found, field && intent.text ? { [field]: intent.text } : {});
    }
    // a judgment on one proposed Purpose names it by id, and only one the GO card's answer shows: the screen sends no other
    case "purpose_restate":
    case "purpose_withdraw": {
      const go = op("go");
      if (!confirmedPurposes(go).some((p) => p.id === intent.id)) return null;
      return intent.kind === "purpose_restate"
        ? press(op("purpose_restate"), { id: intent.id, statement: intent.statement })
        : press(op("purpose_withdraw"), { id: intent.id, grounds: intent.grounds });
    }
    // the approvals carry the content frozen when the confirm opened: the engine's operation says where it goes and how it is signed
    case "ship_check":
      return press(op("check"), intent.payload);
    case "ship_approve":
    case "outbound_approve":
      return press(op("approve"), intent.payload);
    case "ship_revise":
    case "go_revise":
      return press(op("revise"), { instruction: intent.instruction });
    case "stuck_send_back":
      return press(op("send_back"), { instruction: intent.instruction });
    case "outbound_discard":
      return press(op("discard"));
    case "answer": {
      if (item.kind !== "question") return null;
      const open = item.open.find((q) => q.questionId === intent.questionId) ?? item.open[0];
      if (!open) return null;
      return press(op("answer"), {
        questionId: open.questionId,
        selection: intent.selection,
        ...(intent.reason ? { reason: intent.reason } : {}),
        ...(intent.notes ? { notes: intent.notes } : {}),
      });
    }
    case "go_go": {
      const go = op("go");
      // the press confirms only the Purposes the engine's answer named, never ones the card gained since (DEC-112-1)
      const named = new Set(confirmedPurposes(go).map((p) => p.id));
      const purposes = (intent.purposes ?? []).filter((p) => named.has(p.id));
      return press(go, { ...(purposes.length ? { purposes } : {}), ...(intent.reason ? { reason: intent.reason } : {}) });
    }
    case "proposal_approve":
      return press(op("approve"));
    case "proposal_reject":
      return press(op("reject"), { reason: intent.reason });
    case "stuck_ignore":
      return press(op("ignore", "close"));
    case "stuck_accept":
      return press(op("accept"), withCorrections(op("accept"), { note: intent.note }, intent.corrections));
    case "stuck_continue":
      return press(op("continue"), withCorrections(op("continue"), { note: intent.note }, intent.corrections));
    case "stuck_hand_fix":
      return press(op("hand_fix"));
    case "stuck_replan":
      return press(op("replan"));
    case "stuck_hand_fixed":
      return press(op("hand_fixed"));
    case "stuck_budget":
      return press(op("budget_extend"));
    case "stuck_resume":
      return press(op("resume", "retry"), op("resume") ? { note: intent.note } : {});
    case "duplicate_merge":
      return press(op("merge"));
    case "duplicate_anyway":
      return press(op("anyway"));
    case "requeue_ignore":
      return press(op("ignore"));
    case "requeue_go":
      return press(op("requeue"));
  }
}

/**
 * The engine's request for an intent, or null when the intent stays on the screen or the engine's answer names no
 * operation for it, or holds it. The action, the fixed part of the payload and whether it is signed all come from the
 * operation the engine named (C-265-1, C-265-2).
 */
export function requestFor(intent: Intent, item: InboxItem): EngineRequest | null {
  if (intent.kind === "wake") return { method: "POST", path: DOORS.snooze, body: { key: snoozeKey(item), wake: true }, signature: "none" };
  const pressed = pressedBy(intent, item);
  return pressed ? requestOf(pressed.op, item, pressed.extra) : null;
}

/** the request that takes an ignored Issue off the ignore list and back to intake */
export function unignoreRequest(ref: string): EngineRequest {
  return { method: "POST", path: "/api/idd/intake/ignore", body: { action: "unignore", ref }, signature: "none" };
}

/**
 * The settings sheet's passkeys section, as values the component draws. Every row is the engine's own answer: the
 * keys it listed and the registrations that wait for approval (DEC-103-1). A list the engine could not be read from
 * is drawn as its reason, never as an empty list: an unreadable state is not a state with nothing in it, and zero
 * keys is exactly the sentence that sends penne to register one (C-172-1).
 *
 * The section carries no list of the operations that ask for a signature (C-172-3): the engine decides per approval,
 * so a list on the screen would be a second source of truth. It carries no press that removes a key either: the
 * engine has no door for it.
 */
import type { PendingRegistration } from "../engine/passkey";
import { WORDS } from "../strings";

export interface PasskeyKeyRow {
  id: string;
  name: string;
  createdAt: string;
}

/** what the last registration, approval, or PIN operation answered, kept as the shape of the answer, not a sentence */
export type PasskeyResultKind = "registered" | "pending" | "approved" | "pin-set" | "pin-cleared" | "failed";

export interface PasskeyResult {
  kind: PasskeyResultKind;
  /** the engine's own words for a refusal, or what the browser reported when the signature was cancelled */
  detail?: string;
  /** the key an approval moved into the registered set */
  name?: string;
}

/** the PIN beside the keys (C-182-7): whether one is set, and the operation the section is signing right now */
export interface PinSettingsState {
  /** the engine's answer; null before the first read */
  configured: boolean | null;
  error: string | null;
  /** the moment a run of wrong PINs stopped it, or null while it is not stopped */
  lockedUntil: string | null;
  digits: number;
  /** a PIN operation is being signed right now */
  setting: boolean;
}

export interface PasskeysState {
  /** the keys the engine listed; null means the list was not read or could not be read */
  keys: PasskeyKeyRow[] | null;
  keysError: string | null;
  /** the registrations that wait for the local screen's approval; null means the list was not read */
  pending: PendingRegistration[] | null;
  pendingError: string | null;
  registering: boolean;
  /** the pending id whose approval is being signed right now */
  approving: string | null;
  /** the PIN the setting and the confirm stage offer */
  pin: PinSettingsState;
  result: PasskeyResult | null;
}

export const EMPTY_PASSKEYS: PasskeysState = {
  keys: null,
  keysError: null,
  pending: null,
  pendingError: null,
  registering: false,
  approving: null,
  pin: { configured: null, error: null, lockedUntil: null, digits: 6, setting: false },
  result: null,
};

export interface PasskeyRowView {
  key: string;
  title: string;
  note: string;
}

export interface PasskeyPendingRowView {
  key: string;
  title: string;
  host: string;
  /** when the key was added, and the last moment it can still be approved */
  note: string;
  approveLabel: string;
  /** an approval is in flight: this row is waiting for its signature, or another row holds the screen */
  approveDisabled: boolean;
  approve: () => void;
}

export interface PasskeysView {
  /** the key list was read, so no rows really means nothing is registered */
  loaded: boolean;
  error: string | null;
  rows: PasskeyRowView[];
  /** the one line the prototype keeps for a screen with no key yet */
  firstKeyNote: string | null;
  pendingLoaded: boolean;
  pendingError: string | null;
  pending: PasskeyPendingRowView[];
  /** the PIN row, beside the keys (C-182-7) */
  pin: PinRowView;
  /** one press at a time: while a key is being registered or approved, the other presses wait */
  busy: boolean;
  addLabel: string;
  notice: { text: string; failed: boolean; detail: string | null } | null;
  add: () => void;
}

export interface PinRowView {
  /** the engine answered: `configured: false` then really means no PIN */
  loaded: boolean;
  error: string | null;
  configured: boolean;
  /** whether the PIN is set, with when it was set, or the line for a screen that has none */
  note: string;
  /** a run of wrong PINs stopped it until this moment */
  lockedNote: string | null;
  digits: number;
  setLabel: string;
  /** turning the PIN off is only offered once one is set */
  clearLabel: string | null;
  /** either PIN operation is in flight: both presses wait */
  busy: boolean;
  set: (pin: string) => void;
  clear: () => void;
}

export interface PasskeysHandlers {
  registerPasskey(): void;
  approvePending(id: string): void;
  /** set or change the PIN; the section signs it with a registered key */
  setPin(pin: string): void;
  /** turn the PIN off, on a registered key's signature */
  disablePin(): void;
}

/**
 * Whether the sheet is showing the passkeys section right now. The section asks the engine again every time this turns
 * true, and not only when the section changes: a pending key a tailnet page adds while the sheet is shut is the one
 * penne has to approve, and reopening the sheet on the same section must not keep the list read before it arrived.
 */
export function passkeysShown(open: boolean | undefined, sec: string | undefined): boolean {
  return open === true && sec === "key";
}

/** the engine's timestamp as it stands, without the browser's own idea of the local zone */
function stamp(iso: string | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function noticeOf(result: PasskeyResult | null): PasskeysView["notice"] {
  if (!result) return null;
  if (result.kind === "registered") return { text: WORDS.settings.passkeys.registered, failed: false, detail: null };
  if (result.kind === "approved") return { text: WORDS.settings.passkeys.approved(result.name ?? ""), failed: false, detail: null };
  if (result.kind === "pending") return { text: WORDS.settings.passkeys.pendingNotice, failed: false, detail: result.detail ?? null };
  if (result.kind === "pin-set") return { text: WORDS.settings.passkeys.pinSet, failed: false, detail: result.detail ?? null };
  if (result.kind === "pin-cleared") return { text: WORDS.settings.passkeys.pinCleared, failed: false, detail: result.detail ?? null };
  return { text: result.detail || WORDS.settings.passkeys.failed, failed: true, detail: null };
}

function pinRowOf(state: PasskeysState | undefined, handlers: PasskeysHandlers, busy: boolean): PinRowView {
  const pin = state?.pin;
  const configured = pin?.configured === true;
  // an unreadable record has no note of its own: the error above the row is its reason, and "not set" would be a lie
  const unreadable = pin?.configured === null || pin === undefined;
  return {
    loaded: !unreadable,
    error: pin?.error ?? null,
    configured,
    note: unreadable ? "" : configured ? WORDS.settings.passkeys.pinOn : WORDS.settings.passkeys.pinOff,
    lockedNote: pin?.lockedUntil ? WORDS.settings.passkeys.pinLocked(stamp(pin.lockedUntil)) : null,
    digits: pin?.digits ?? 6,
    setLabel: configured ? WORDS.settings.passkeys.pinChange : WORDS.settings.passkeys.pinSetUp,
    clearLabel: configured ? WORDS.settings.passkeys.pinClear : null,
    busy: busy || (pin?.setting ?? false),
    set: (value: string) => handlers.setPin(value),
    clear: () => handlers.disablePin(),
  };
}

export function passkeysVals(state: PasskeysState | undefined, handlers: PasskeysHandlers): PasskeysView {
  const keys = state?.keys ?? null;
  const pending = state?.pending ?? null;
  const registering = state?.registering ?? false;
  const approving = state?.approving ?? null;
  const busy = registering || approving !== null;
  return {
    loaded: keys !== null,
    error: state?.keysError ?? null,
    rows: (keys ?? []).map((key) => ({
      key: key.id,
      title: key.name,
      note: WORDS.settings.passkeys.keyNote(stamp(key.createdAt)),
    })),
    firstKeyNote: keys !== null && keys.length === 0 ? WORDS.settings.passkeys.firstKey : null,
    pendingLoaded: pending !== null,
    pendingError: state?.pendingError ?? null,
    pending: (pending ?? []).map((entry) => ({
      key: entry.id,
      title: entry.name,
      host: WORDS.settings.passkeys.host(entry.rpId),
      note: WORDS.settings.passkeys.pendingNote(stamp(entry.createdAt), stamp(entry.expiresAt)),
      approveLabel: approving === entry.id ? WORDS.settings.passkeys.approving : WORDS.settings.passkeys.approve,
      approveDisabled: busy,
      // the press carries this row's own id, and the store signs this row's own challenge: a row that left the
      // list between the read and the press signs nothing (C-172-2)
      approve: () => handlers.approvePending(entry.id),
    })),
    pin: pinRowOf(state, handlers, busy),
    busy,
    addLabel: registering ? WORDS.settings.passkeys.registering : WORDS.settings.passkeys.add,
    notice: noticeOf(state?.result ?? null),
    add: () => handlers.registerPasskey(),
  };
}

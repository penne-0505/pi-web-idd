/**
 * The PIN: the daily way to sign one card's approval, under the passkey. The engine keeps only what a verifier
 * needs — the public half of the key the PIN derives, the salt and the strength the PIN is stretched with, and the
 * ledger of what the PIN was used for. The PIN itself never leaves the screen that typed it.
 *
 * A PIN is a few digits, so the same OS user who can read the state can grind the public key from the salt. #183
 * takes that grind as a deliberate attack and does not defend against it; what it defends is the loss when a PIN
 * is guessed. So a PIN proof signs only the card kinds whose approvals go out or change the work side's mainline
 * (never the passkey's own keys, another key's registration, or an idea's exits), and a run of wrong PINs stops
 * the PIN for a while. The stop is kept here rather than at the engine's door so every door shares it.
 *
 * The state is a file only the owner can read (mode 600) and the ledger is appended, never rewritten: a guessed
 * PIN must be traceable afterwards, and a rewrite must not be able to erase the trace of an approval.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./paths.ts";

/** how long the PIN stays stopped after a run of wrong ones */
export const PIN_LOCK_MS = 5 * 60_000;
/** how many wrong PINs in a row stop it */
export const PIN_MAX_FAILURES = 5;
/** the derivation the screen stretches the PIN with: standard, dependency-free, and slow by its count */
export const PIN_KDF_ITERATIONS = 600_000;
/** the salt the screen makes for the derivation, in bytes */
export const PIN_SALT_BYTES = 16;
/** how many digits the screen asks for */
export const PIN_DIGITS = 6;

/**
 * The content kinds a PIN may sign. These are the cards whose approvals leave this machine or change the work
 * side's mainline; an idea's exits run several rows on one signature and are left to the passkey (C-182-2).
 */
export const PIN_CARD_KINDS = ["ship", "land", "land-batch", "local-complete", "outbound"] as const;

export interface PinKdf {
  name: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
}

export interface PinFailure {
  /** wrong PINs since the last right one */
  count: number;
  lastFailedAt: string | null;
  /** while this is in the future the PIN is stopped */
  lockedUntil: string | null;
}

/** what the engine keeps: the public half of the derived key and the material the screen derives it from */
export interface PinRecord {
  /** the Ed25519 public key the PIN derives, raw 32 bytes, base64url */
  publicKey: string;
  /** the salt the PIN is stretched with, base64url */
  salt: string;
  kdf: PinKdf;
  createdAt: string;
  updatedAt: string;
  failures: PinFailure;
}

/** what the screen may read: whether a PIN is set, when it was set, and whether it is stopped. Never the PIN */
export interface PinStatus {
  configured: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lockedUntil: string | null;
  failures: number;
}

/** the derivation material a screen needs to make the same key from the same PIN */
export interface PinMaterial {
  publicKey: string;
  salt: string;
  kdf: PinKdf;
}

/** The PIN state exists but cannot be read. It is not the same as no PIN yet: taking it as unset would let a
 * guessed PIN be replaced without the passkey and would hide why the approvals stopped. */
export class PinStateUnreadableError extends Error {}

function pinDir(): string {
  const dir = join(stateDir(), "pin");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function statePath(): string {
  return join(pinDir(), "state.json");
}

function ledgerPath(): string {
  return join(pinDir(), "ledger.jsonl");
}

function load(): PinRecord | null {
  let text: string;
  try {
    text = readFileSync(statePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PinStateUnreadableError(`PIN の記録を読めません（${statePath()}）。中身を確かめて直してください`);
  }
  try {
    const parsed = JSON.parse(text) as PinRecord;
    if (!parsed || typeof parsed.publicKey !== "string" || typeof parsed.salt !== "string") throw new Error("shape");
    return parsed;
  } catch {
    throw new PinStateUnreadableError(`PIN の記録を解析できません（${statePath()}）。中身を確かめて直してください`);
  }
}

/** the state, or why it cannot be used: each reader refuses on a broken file instead of taking it as unset */
export function readPinState(): { ok: true; pin: PinRecord | null } | { ok: false; error: string } {
  try {
    return { ok: true, pin: load() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** whether a PIN is set; a broken record is an error, never `false` */
export function pinIsSet(): { ok: true; configured: boolean } | { ok: false; error: string } {
  const read = readPinState();
  if (!read.ok) return read;
  return { ok: true, configured: read.pin !== null };
}

/** what the settings section and the confirm stage read; never the PIN and never the derived secret */
export function readPinStatus(): { ok: true; status: PinStatus } | { ok: false; error: string } {
  const read = readPinState();
  if (!read.ok) return read;
  const pin = read.pin;
  return {
    ok: true,
    status: {
      configured: pin !== null,
      createdAt: pin?.createdAt ?? null,
      updatedAt: pin?.updatedAt ?? null,
      lockedUntil: pin?.failures.lockedUntil ?? null,
      failures: pin?.failures.count ?? 0,
    },
  };
}

/** the material a screen derives the same key from; a PIN that is not set has none */
export function readPinMaterial(): { ok: true; material: PinMaterial | null } | { ok: false; error: string } {
  const read = readPinState();
  if (!read.ok) return read;
  const pin = read.pin;
  if (!pin) return { ok: true, material: null };
  return { ok: true, material: { publicKey: pin.publicKey, salt: pin.salt, kdf: pin.kdf } };
}

/** the moment the PIN is stopped until, or null while it is not; a broken record is an error, never "not stopped" */
export function pinLockedUntil(now = Date.now()): { ok: true; until: string | null } | { ok: false; error: string } {
  const read = readPinState();
  if (!read.ok) return read;
  const until = read.pin?.failures.lockedUntil ?? null;
  if (!until) return { ok: true, until: null };
  return { ok: true, until: Date.parse(until) > now ? until : null };
}

function save(pin: PinRecord): void {
  const path = statePath();
  const temp = `${path}.${process.pid}.tmp`;
  // written with mode 600 before it is moved into place: only the owner may read the salt and the public key
  writeFileSync(temp, JSON.stringify(pin, null, 2), { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // a filesystem that does not carry the mode is no reason to refuse the record
  }
  renameSync(temp, path);
}

/**
 * Keep a PIN's public key and the material it is derived from. Called only after a registered passkey signed over
 * the same content: setting or changing a PIN is the root's decision, never the PIN's own.
 */
export function savePin(input: { publicKey: string; salt: string; iterations: number }): void {
  const now = new Date().toISOString();
  const before = readPinState();
  // a record that cannot be read is replaced here, since the passkey has already signed over this one: the
  // unreadable file is kept beside it instead of being lost without a trace
  if (!before.ok) {
    try {
      renameSync(statePath(), `${statePath()}.unreadable-${Date.now()}`);
    } catch {
      // nothing to keep
    }
  }
  save({
    publicKey: input.publicKey,
    salt: input.salt,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: input.iterations },
    createdAt: before.ok && before.pin ? before.pin.createdAt : now,
    updatedAt: now,
    failures: { count: 0, lastFailedAt: null, lockedUntil: null },
  });
}

/** remove the PIN: after this no card can be signed with one, and the passkey is the only way in */
export function clearPin(): void {
  const path = statePath();
  try {
    renameSync(path, `${path}.disabled-${Date.now()}`);
  } catch {
    // no PIN was set: nothing to remove
  }
}

/** what the passkey signs when a PIN is set or changed: the key the PIN derives, its salt and its strength */
export function pinSetContent(input: { publicKey: string; salt: string; iterations: number }): Record<string, unknown> {
  return {
    kind: "pin-set",
    publicKey: input.publicKey,
    salt: input.salt,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: input.iterations },
  };
}

/** what the passkey signs when the PIN is turned off */
export function pinDisableContent(): Record<string, unknown> {
  return { kind: "pin-disable" };
}

/** the `kind` of an approval's content, when it has one */
export function contentKind(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const kind = (content as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

/** whether a PIN may sign this content: the cards only, never an idea's exits or a key's registration */
export function pinMaySign(content: unknown): boolean {
  const kind = contentKind(content);
  return kind !== null && (PIN_CARD_KINDS as readonly string[]).includes(kind);
}

export interface PinLedgerEntry {
  at: string;
  outcome: "ok" | "refused";
  /** the one-time nonce the attempt was for, so the approval it answered can be found */
  nonce: string;
  /** the kind of approval the attempt was for */
  kind: string;
  /** the hash of the content the attempt was over */
  hash: string | null;
  /** why it was refused; never the PIN */
  reason?: string;
}

/** append one attempt to the ledger. Appended, never rewritten: an accepted and a refused PIN both have to remain */
export function appendPinLedger(entry: Omit<PinLedgerEntry, "at">): void {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  try {
    appendFileSync(ledgerPath(), line, { mode: 0o600 });
  } catch {
    // the ledger must not turn a decision into a failure: the attempt happened either way
  }
}

/** the append-only record of what the PIN was used for, for a person looking at an approval they did not make */
export function readPinLedger(): PinLedgerEntry[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath(), "utf8");
  } catch {
    return [];
  }
  const entries: PinLedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PinLedgerEntry;
      if (parsed && (parsed.outcome === "ok" || parsed.outcome === "refused")) entries.push(parsed);
    } catch {
      // a line that cannot be read is left out of the answer, not taken as an attempt
    }
  }
  return entries;
}

function updateFailures(next: (failure: PinFailure, now: number) => PinFailure): void {
  const read = readPinState();
  // a broken record is not rewritten here: the failure is on the ledger, and the next reader says why
  if (!read.ok || !read.pin) return;
  const pin = read.pin;
  save({ ...pin, failures: next(pin.failures, Date.now()) });
}

/** a wrong PIN: counted, and a full run of them stops the PIN for a while */
export function notePinFailure(): string | null {
  let until: string | null = null;
  updateFailures((failure, now) => {
    const count = failure.count + 1;
    if (count >= PIN_MAX_FAILURES) {
      until = new Date(now + PIN_LOCK_MS).toISOString();
      return { count: 0, lastFailedAt: new Date(now).toISOString(), lockedUntil: until };
    }
    return { ...failure, count, lastFailedAt: new Date(now).toISOString() };
  });
  return until;
}

/** a right PIN: the run of wrong ones is over */
export function notePinSuccess(): void {
  updateFailures((failure) => ({ ...failure, count: 0, lockedUntil: null }));
}

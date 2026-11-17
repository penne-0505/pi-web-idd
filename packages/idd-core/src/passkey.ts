/**
 * The passkey that lets penne approve what leaves this machine: the signature over what an approval sends, the
 * nonce that makes one approval's signature good once, the gate each outbound write checks just before it writes,
 * and the keys penne registers from the inbox page.
 *
 * A signature is over a challenge the server makes from the approval's own content (the fields that go out, and
 * where): the challenge is `SHA-256(contentHash + nonce)`, the nonce is good for one approval and a few minutes,
 * and the gate rebuilds the content from what it is about to write, so a signature cannot carry another lane, an
 * edited commit message, or an edited PR text.
 *
 * Only the state directory (keys and nonces) and the standard library and `@simplewebauthn/server` are used here,
 * so the posting gate in idd-lane reads this one module for the same verification and the same content building.
 */
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { stateDir } from "./paths.ts";
import { appendPinLedger, notePinFailure, notePinSuccess, pinMaySign, readPinState } from "./pin.ts";

/**
 * A refusal the signature caused (missing, expired, used up, or over different content). An approval refused this
 * way is not a failed push: the caller answers it the way it answers a lane that is no longer at the submit card,
 * and leaves no record of a failure.
 */
export class SignatureRefusedError extends Error {}

/** how long a challenge stays good: one approval, and the card's confirm step is short */
const NONCE_TTL_MS = 5 * 60_000;
/** how long a registration challenge stays good */
const REGISTRATION_TTL_MS = 10 * 60_000;

export interface StoredPasskey {
  /** the credential ID, base64url */
  id: string;
  /** the credential public key in COSE form, base64url */
  publicKey: string;
  counter: number;
  name: string;
  createdAt: string;
  /**
   * The relying party ID the key was registered under. Absent on keys from before this field existed: those are
   * read as the local RP ID, which is what they were registered with.
   */
  rpId?: string;
}

/** a verified registration that waited for an already registered key's word: not usable for a signature yet */
export interface PendingRegistration {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  rpId: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  /** the one challenge an already registered key signs to approve this key (its ID, public key and RP ID) */
  proof: { nonce: string; challenge: string };
}

export interface PendingListing {
  id: string;
  name: string;
  rpId: string;
  createdAt: string;
  expiresAt: string;
  challenge: string;
}

export interface PasskeyListing {
  id: string;
  name: string;
  createdAt: string;
}

interface NonceRecord {
  /** the hash of the approval content the challenge was made for (empty for a registration challenge) */
  hash: string;
  expiresAt: string;
  purpose: "approval" | "register" | "register-proof";
  /** a passkey's signature over this nonce was checked: only the verification writes it */
  verified?: boolean;
  /** a PIN's proof over this nonce was checked: only the PIN's verification writes it, and only for a card */
  pinVerified?: boolean;
  /** the approval this nonce was made for finished (whatever its outcome) */
  consumed?: boolean;
}

interface PasskeyState {
  credentials?: StoredPasskey[];
  nonces?: Record<string, NonceRecord>;
  /** registrations that verified but still wait for a registered key's approval */
  pending?: PendingRegistration[];
}

/** how long a pending registration waits for an approval, and how many may pile up */
const PENDING_TTL_MS = 15 * 60_000;
const PENDING_LIMIT = 5;

/** the local RP ID (the WebAuthn `localhost`): an environment override moves it when the domain does */
export function passkeyRpId(): string {
  return process.env.IDD_PASSKEY_RP_ID?.trim() || "localhost";
}

/**
 * Whether two hostnames are the page the passkey is used from. `localhost` and the loopback addresses are the
 * same page for this purpose: the GUI's proxy reaches the engine on `127.0.0.1` while the page shows `localhost`,
 * so the declared RP ID cannot be compared byte-for-byte with the request's Host.
 */
export function pageHostsMatch(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (a === b) return true;
  return isLoopbackPageHost(a) && isLoopbackPageHost(b);
}

function isLoopbackPageHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare.endsWith(".localhost") || bare === "::1") return true;
  return bare.startsWith("127.") && /^[\d.]+$/.test(bare);
}

/**
 * The tailnet origins the settings name: the passkey takes their host as a second RP ID, but only for the exact
 * origin, since the same host on another port is another app `tailscale serve` may be serving.
 */
export function passkeyTailnetOrigins(): string[] {
  const raw = process.env.IDD_TAILNET_ORIGINS?.trim();
  if (!raw) return [];
  const origins: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "https:") origins.push(parsed.origin);
    } catch {
      // a value the engine's own settings reader already refused; it is not an origin to take here
    }
  }
  return origins;
}

/** every RP ID the passkey accepts: the local one, and the host of each configured tailnet origin */
export function passkeyRpIds(): string[] {
  return [passkeyRpId(), ...passkeyTailnetOrigins().map((origin) => new URL(origin).hostname.toLowerCase())];
}

/** the RP ID a page names is usable only when it is one the settings accept */
export function isPasskeyRpId(value: string | undefined): boolean {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) return false;
  return passkeyRpIds().some((known) => known.toLowerCase() === wanted);
}

function passkeyDir(): string {
  const dir = join(stateDir(), "passkey");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath(): string {
  return join(passkeyDir(), "state.json");
}

/**
 * The state file is there but cannot be read or parsed. It is not the same as no keys yet (a first run): taking it
 * for an empty state would let a signature-less first registration in and would let the next save drop the keys.
 */
export class PasskeyStateUnreadableError extends Error {}

function load(): PasskeyState {
  let text: string;
  try {
    text = readFileSync(statePath(), "utf8");
  } catch (error) {
    // no file yet is the first run; any other failure is a state that must not be taken as empty
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new PasskeyStateUnreadableError(`passkey の記録を読めません（${statePath()}）。中身を確かめて直してください`);
  }
  try {
    return JSON.parse(text) as PasskeyState;
  } catch {
    throw new PasskeyStateUnreadableError(`passkey の記録を解析できません（${statePath()}）。中身を確かめて直してください`);
  }
}

/** the state, or why it cannot be used: the writers refuse on a broken file instead of overwriting it */
function readState(): { ok: true; state: PasskeyState } | { ok: false; error: string } {
  try {
    return { ok: true, state: load() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function save(state: PasskeyState): void {
  const path = statePath();
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, path);
}

export function listPasskeys(): PasskeyListing[] {
  return (load().credentials ?? []).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt }));
}

export function passkeyCount(): number {
  return (load().credentials ?? []).length;
}

/** the keys the page may offer for a signature: their IDs, and nothing else. A named RP ID takes only its own keys */
export function passkeyCredentialIds(rpId = passkeyRpId()): string[] {
  const wanted = rpId.toLowerCase();
  return (load().credentials ?? [])
    .filter((credential) => (credential.rpId ?? passkeyRpId()).toLowerCase() === wanted)
    .map((credential) => credential.id);
}

/** a stable order for a JSON value, so the same content always hashes the same */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** what a signature is over: the content's hash, then the one-time nonce */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function challengeOf(hash: string, nonce: string): string {
  return createHash("sha256").update(`${hash}.${nonce}`).digest("base64url");
}

/**
 * How long a challenge stays good. A pending key's proof lives exactly as long as the pending record it
 * approves, so every pending in the list can still be approved: the two deadlines are the same instant.
 */
function nonceTtlMs(purpose: NonceRecord["purpose"]): number {
  if (purpose === "approval") return NONCE_TTL_MS;
  if (purpose === "register-proof") return PENDING_TTL_MS;
  return REGISTRATION_TTL_MS;
}

/** the page signs this for the approval's content; the nonce makes it good for this one approval, for a few minutes */
export function createChallenge(content: unknown, purpose: NonceRecord["purpose"] = "approval"): { nonce: string; challenge: string; expiresAt: string } {
  const nonce = randomBytes(24).toString("base64url");
  const hash = contentHash(content);
  const expiresAt = new Date(Date.now() + nonceTtlMs(purpose)).toISOString();
  const state = load();
  state.nonces = { ...(state.nonces ?? {}), [nonce]: { hash, expiresAt, purpose } };
  save(state);
  return { nonce, challenge: challengeOf(hash, nonce), expiresAt };
}

function refusal(record: NonceRecord | undefined, content: unknown, now = Date.now(), allowed: NonceRecord["purpose"][] = ["approval", "register-proof"], compareContent = true): string | null {
  if (!record) return "署名の確認が見つかりません。承認をやり直してください";
  if (!allowed.includes(record.purpose)) return "署名の確認が見つかりません。承認をやり直してください";
  if (Date.parse(record.expiresAt) < now) return "署名の期限が切れています。承認をやり直してください";
  if (record.consumed) return "この署名は使い終えています。承認をやり直してください";
  if (compareContent && record.hash !== contentHash(content)) return "署名した中身と承認の中身が違います。承認をやり直してください";
  return null;
}

/**
 * The gate each outbound write passes just before it writes: the nonce was verified for exactly this content,
 * within its time and for this one approval. Synchronous, so the gate can stand inside the export.
 */
export function approvalGateOpen(nonce: string | undefined, content: unknown): { ok: true } | { ok: false; reason: string } {
  if (!nonce) return { ok: false, reason: "署名がありません。画面の承認からやり直してください" };
  const read = readState();
  if (!read.ok) return { ok: false, reason: read.error };
  const record = read.state.nonces?.[nonce];
  const why = refusal(record, content, Date.now(), ["approval"]);
  if (why) return { ok: false, reason: why };
  // the mark of either means the approval may write: the passkey's, or the PIN's (which its verification wrote only
  // for a card, and which is checked here again so a mark can never carry an idea's exit)
  if (!record?.verified && !(record?.pinVerified && pinMaySign(content))) return { ok: false, reason: "署名が確かめられていません。承認をやり直してください" };
  return { ok: true };
}

/** the approval finished (whatever its outcome): the signature cannot be used again */
export function consumeNonce(nonce: string | undefined): void {
  if (!nonce) return;
  const read = readState();
  // a broken state is not overwritten: there is nothing to consume, and the file must not lose its keys
  if (!read.ok) return;
  const state = read.state;
  const record = state.nonces?.[nonce];
  if (!record) return;
  state.nonces = { ...(state.nonces ?? {}), [nonce]: { ...record, consumed: true } };
  save(state);
}

function originOf(clientDataJSON: string | undefined): string | null {
  if (!clientDataJSON) return null;
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { origin?: unknown };
    return typeof data.origin === "string" ? data.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origin the page ran on. The local RP ID takes any port (the resident UI and a dev server share it). A
 * tailnet RP ID takes only the exact configured origin: the same host on another port is another app, and the
 * https the page shows is terminated by `tailscale serve`, so the engine cannot rebuild it from the request.
 */
export function pageOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname.toLowerCase() === passkeyRpId().toLowerCase()) return true;
    const canonical = parsed.origin;
    return passkeyTailnetOrigins().some((configured) => configured === canonical);
  } catch {
    return false;
  }
}

/** the origin the passkey accepts, for a refusal's guidance */
export function acceptedOriginsHint(): string {
  const local = passkeyRpId();
  const tailnet = passkeyTailnetOrigins();
  return [`http://${local}:<port>`, ...tailnet].join(" または ");
}

/**
 * Check the signature and mark the nonce verified. The one place a nonce's verified mark is written, so the gates
 * can trust it. `compareContent` (default true) also checks that the content rebuilt from this approval is the one
 * the challenge was made for; where the content comparison is left to the gate that is about to write (a posting,
 * a PR-only approval), the signature is still bound to the challenge's own content by the challenge itself. A
 * refusal is a value, not a throw: a refused approval is not a failed push and must leave no record of one.
 */
export async function verifyApprovalSignature(input: { nonce?: string; assertion?: unknown; content: unknown; compareContent?: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { nonce, assertion, content } = input;
  if (!nonce) return { ok: false, reason: "署名がありません。画面の承認からやり直してください" };
  const read = readState();
  if (!read.ok) return { ok: false, reason: read.error };
  const state = read.state;
  const record = state.nonces?.[nonce];
  const why = refusal(record, content, Date.now(), ["approval", "register-proof"], input.compareContent !== false);
  if (why) return { ok: false, reason: why };
  // the same nonce was already verified (the head of the approval, then its gates): nothing to check twice
  if (record?.verified) return { ok: true };
  if (!assertion || typeof assertion !== "object") return { ok: false, reason: "署名がありません。画面の承認からやり直してください" };
  const checked = await verifyAssertion(nonce, assertion as AuthenticationResponseJSON);
  if (!checked.ok) return checked;
  const after = readState();
  if (!after.ok) return { ok: false, reason: after.error };
  const again = after.state.nonces?.[nonce];
  if (again) {
    after.state.nonces = { ...(after.state.nonces ?? {}), [nonce]: { ...again, verified: true } };
    save(after.state);
  }
  return { ok: true };
}

async function verifyAssertion(nonce: string, assertion: AuthenticationResponseJSON): Promise<{ ok: true } | { ok: false; reason: string }> {
  const read = readState();
  if (!read.ok) return { ok: false, reason: read.error };
  const state = read.state;
  const credential = (state.credentials ?? []).find((c) => c.id === assertion.id);
  if (!credential) return { ok: false, reason: "登録されていない鍵です。登録済みの passkey で署名してください" };
  const credentialRpId = credential.rpId ?? passkeyRpId();
  const origin = originOf(assertion.response?.clientDataJSON);
  if (!pageOriginAllowed(origin)) return { ok: false, reason: `署名の origin が受けられません。${acceptedOriginsHint()} で画面を開き直してください` };
  // a key can sign only under the RP ID it was registered with: a localhost key cannot sign the tailnet origin
  // (and a tailnet key cannot sign localhost), even though both origins are accepted
  const originHost = new URL(origin as string).hostname.toLowerCase();
  if (originHost !== credentialRpId.toLowerCase()) {
    return { ok: false, reason: `この鍵は ${credentialRpId} で登録されています。${credentialRpId} の画面で署名してください` };
  }
  try {
    const result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challengeOf(state.nonces?.[nonce]?.hash ?? "", nonce),
      expectedOrigin: origin as string,
      expectedRPID: credentialRpId,
      requireUserVerification: false,
      credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, "base64url"), counter: credential.counter },
    });
    if (!result.verified) return { ok: false, reason: "署名を確かめられませんでした。承認をやり直してください" };
    const after = readState();
    if (after.ok) {
      const stored = (after.state.credentials ?? []).find((c) => c.id === credential.id);
      if (stored) {
        stored.counter = result.authenticationInfo.newCounter;
        save(after.state);
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `署名を確かめられませんでした: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** the challenge a nonce was made for, as the bytes a PIN signs; null when the nonce is gone */
export function nonceChallenge(nonce: string): string | null {
  const read = readState();
  if (!read.ok) return null;
  const record = read.state.nonces?.[nonce];
  return record ? challengeOf(record.hash, nonce) : null;
}

/** the hash of the content a nonce was made for, for a ledger line that names the approval */
export function nonceHash(nonce: string): string | null {
  const read = readState();
  if (!read.ok) return null;
  return read.state.nonces?.[nonce]?.hash ?? null;
}

/** whether this nonce may still be signed at all: its purpose, deadline, use, and (optionally) its content */
export function nonceRefusal(nonce: string | undefined, content: unknown, compareContent = true): string | null {
  if (!nonce) return "署名がありません。画面の承認からやり直してください";
  const read = readState();
  if (!read.ok) return read.error;
  return refusal(read.state.nonces?.[nonce], content, Date.now(), ["approval", "register-proof"], compareContent);
}

/** mark this nonce's proof as a PIN's: written only by the PIN's verification, the way `verified` is the passkey's */
export function markNoncePinVerified(nonce: string): void {
  const read = readState();
  if (!read.ok) return;
  const record = read.state.nonces?.[nonce];
  if (!record) return;
  read.state.nonces = { ...(read.state.nonces ?? {}), [nonce]: { ...record, pinVerified: true } };
  save(read.state);
}

/** the signature a PIN proof carries: an Ed25519 signature over the challenge, base64url */
function pinSignatureOf(proof: unknown): string | null {
  if (!proof || typeof proof !== "object") return null;
  const signature = (proof as { signature?: unknown }).signature;
  return typeof signature === "string" && signature ? signature : null;
}

/** the DER prefix of an Ed25519 public key, so the raw 32 bytes the PIN derives can be verified with node's crypto */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, "base64url")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/**
 * Check a PIN's proof over this nonce and mark it. The PIN derives its key on the screen and sends only the
 * signature, so this verifies the mark against the public half the state keeps; the nonce is the passkey's own,
 * so a PIN signs exactly the content the passkey would have signed, once, and within the same minutes.
 *
 * A PIN may sign only the cards (C-182-2): an idea's exit, the passkey's keys, another key's registration, and the
 * PIN's own setting all answer here with a refusal, so a guessed PIN cannot become the root. A wrong signature is
 * counted, and a run of them stops the PIN for a while (C-182-4); a state that cannot be read is refused with its
 * reason, never taken as a PIN that is not set (C-182-5). Every attempt that reached this check is on the ledger.
 */
export async function verifyPinProof(input: { nonce?: string; proof?: unknown; content: unknown; compareContent?: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { nonce, content } = input;
  const kind = content && typeof content === "object" ? String((content as { kind?: unknown }).kind ?? "") : "";
  if (!pinMaySign(content)) return { ok: false, reason: "PIN で通せる承認ではありません。passkey で署名してください" };
  if (!nonce) return { ok: false, reason: "署名がありません。画面の承認からやり直してください" };
  const read = readPinState();
  if (!read.ok) {
    appendPinLedger({ outcome: "refused", nonce, kind, hash: null, reason: read.error });
    return { ok: false, reason: read.error };
  }
  if (!read.pin) return { ok: false, reason: "PIN が設定されていません。設定の Passkeys で設定してください" };
  const lockedUntil = read.pin.failures.lockedUntil;
  if (lockedUntil && Date.parse(lockedUntil) > Date.now()) {
    appendPinLedger({ outcome: "refused", nonce, kind, hash: null, reason: "PIN は止まっています" });
    return { ok: false, reason: `PIN の失敗が続いたため止まっています。${lockedUntil} まで待つか、passkey で署名してください` };
  }
  const why = nonceRefusal(nonce, content, input.compareContent !== false);
  if (why) {
    appendPinLedger({ outcome: "refused", nonce, kind, hash: nonceHash(nonce), reason: why });
    return { ok: false, reason: why };
  }
  const signature = pinSignatureOf(input.proof);
  if (!signature) return { ok: false, reason: "PIN の証明がありません。PIN を入れ直してください" };
  const challenge = nonceChallenge(nonce);
  if (!challenge) return { ok: false, reason: "署名の確認が見つかりません。承認をやり直してください" };
  const hash = nonceHash(nonce);
  if (!verifyEd25519(read.pin.publicKey, challenge, signature)) {
    const until = notePinFailure();
    appendPinLedger({ outcome: "refused", nonce, kind, hash, reason: until ? "PIN が止まりました" : "PIN が違います" });
    return {
      ok: false,
      reason: until
        ? `PIN が違います。続けて失敗したので ${until} まで止まりました。passkey で署名してください`
        : "PIN が違います。入れ直してください",
    };
  }
  markNoncePinVerified(nonce);
  notePinSuccess();
  appendPinLedger({ outcome: "ok", nonce, kind, hash });
  return { ok: true };
}

/**
 * The one check the three card gates and an approval's head make: a passkey's assertion when one came, a PIN's proof
 * when that came instead. An approval carries one of them, and an approval that carries neither is refused. The
 * idea's exits do not come through here: they call `verifyApprovalSignature`, so a PIN can never run one.
 */
export function verifyApproval(input: { nonce?: string; assertion?: unknown; pinProof?: unknown; content: unknown; compareContent?: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.assertion) return verifyApprovalSignature({ nonce: input.nonce, assertion: input.assertion, content: input.content, compareContent: input.compareContent });
  if (input.pinProof) return verifyPinProof({ nonce: input.nonce, proof: input.pinProof, content: input.content, compareContent: input.compareContent });
  // neither proof came: the passkey's own check answers, which is what an approval with only a nonce (already
  // verified by the head, answered again) has always been
  return verifyApprovalSignature({ nonce: input.nonce, content: input.content, compareContent: input.compareContent });
}

/** the page's registration options: a challenge, the relying party it names, and one user */
export function createRegistrationOptions(rpId = passkeyRpId()): { nonce: string; options: Record<string, unknown> } {
  const { nonce, challenge } = createChallenge("", "register");
  return {
    nonce,
    options: {
      challenge,
      rp: { id: rpId, name: "pi-web" },
      user: { id: randomBytes(16).toString("base64url"), name: "penne", displayName: "penne" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
      attestation: "none",
      timeout: REGISTRATION_TTL_MS,
    },
  };
}

/** what the caller of an additional registration must sign: the key it is about to add, and the RP ID it names */
export function registrationProofContent(credentialId: string, publicKey: string, rpId = passkeyRpId()): Record<string, unknown> {
  return { kind: "register", credentialId, publicKey, rpId };
}

/** the challenge an existing key signs before another one is added: over the new key's ID, public key and RP ID */
export function createRegistrationProof(credentialId: string, publicKey: string, rpId = passkeyRpId()): { nonce: string; challenge: string; expiresAt: string } {
  const content = registrationProofContent(credentialId, publicKey, rpId);
  return createChallenge(content, "register-proof");
}

/** the pending registrations still inside their window; expired ones are dropped from the state */
function livePending(state: PasskeyState, now = Date.now()): PendingRegistration[] {
  const all = state.pending ?? [];
  const live = all.filter((pending) => Date.parse(pending.expiresAt) >= now);
  if (live.length !== all.length) {
    state.pending = live;
    save(state);
  }
  return live;
}

/** the pending registrations, for the screen that approves them: what to sign, not the key itself */
export function listPendingRegistrations(): PendingListing[] {
  return livePending(load()).map((pending) => ({
    id: pending.id,
    name: pending.name,
    rpId: pending.rpId,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
    challenge: pending.proof.challenge,
  }));
}

/**
 * Move a pending key to the registered keys, on an already registered key's signature over the pending key's ID,
 * public key and RP ID. A key that is still pending is not a registered key, so it cannot approve another.
 */
export async function approvePendingRegistration(id: string, assertion: unknown, localScreen: boolean): Promise<{ ok: true; credential: PasskeyListing } | { ok: false; error: string }> {
  // the approval is a step of the local screen only: a tailnet listener or a request naming another host cannot
  // move a key into the registered set, however good its signature is
  if (localScreen !== true) return { ok: false, error: "保留の承認は手元の画面からだけ行えます" };
  const before = readState();
  if (!before.ok) return { ok: false, error: before.error };
  const pending = livePending(before.state).find((entry) => entry.id === id);
  if (!pending) return { ok: false, error: "保留の鍵が見つかりません（期限が切れているかもしれません）" };
  const content = registrationProofContent(pending.credentialId, pending.publicKey, pending.rpId);
  const checked = await verifyApprovalSignature({ nonce: pending.proof.nonce, assertion, content });
  if (!checked.ok) return { ok: false, error: checked.reason };
  const after = readState();
  if (!after.ok) return { ok: false, error: after.error };
  const target = livePending(after.state).find((entry) => entry.id === id);
  if (!target) return { ok: false, error: "保留の鍵が見つかりません（期限が切れているかもしれません）" };
  const listing: StoredPasskey = {
    id: target.credentialId,
    publicKey: target.publicKey,
    counter: target.counter,
    name: target.name,
    createdAt: new Date().toISOString(),
    rpId: target.rpId,
  };
  after.state.credentials = [...(after.state.credentials ?? []), listing];
  after.state.pending = (after.state.pending ?? []).filter((entry) => entry.id !== id);
  save(after.state);
  consumeNonce(target.proof.nonce);
  return { ok: true, credential: { id: listing.id, name: listing.name, createdAt: listing.createdAt } };
}

export interface FinishRegistrationInput {
  nonce?: string;
  response?: unknown;
  name?: string;
  /**
   * Whether the request reached the engine on a loopback connection (the local screen). Required: the module does
   * not read this out of the response's own origin, since a tailnet client can claim `localhost` there.
   */
  localScreen: boolean;
  /** the hostname the request's Host header names, when the caller has one */
  requestHost?: string;
  /** the hostname the request's Origin header names, when the request carries one */
  requestOriginHost?: string;
  /** the proof from an already registered key; required once one is registered */
  proof?: { nonce?: string; assertion?: unknown };
}

export interface FinishRegistrationResult {
  ok: boolean;
  error?: string;
  needsProof?: boolean;
  /** with `needsProof`: the key was recorded as pending, to be approved later */
  pending?: boolean;
  /** with `needsProof`: the challenge an already registered key signs over the new key (its ID, public key and RP ID) */
  proof?: { nonce: string; challenge: string; rpId?: string };
  credential?: PasskeyListing;
}

/**
 * Verify a registration and store the key. The first one is taken on its own; once one is registered, another is
 * recorded as pending until an already registered key signs over its ID, public key and RP ID. The same screen can
 * carry that proof back in the second call; a screen that cannot (the tailnet page has no key of its own) leaves
 * the pending record for the localhost screen to approve. Removing a key is not offered: penne edits the state file.
 */
export async function finishRegistration(input: FinishRegistrationInput): Promise<FinishRegistrationResult> {
  const { nonce, response } = input;
  if (!nonce || !response || typeof response !== "object") return { ok: false, error: "登録の応答がありません" };
  const read = readState();
  // a state file that cannot be read is not an empty state: refuse rather than overwrite the keys it may hold
  if (!read.ok) return { ok: false, error: read.error };
  const state = read.state;
  const record = state.nonces?.[nonce];
  if (!record || record.purpose !== "register") return { ok: false, error: "登録の確認が見つかりません。登録をやり直してください" };
  if (record.consumed) return { ok: false, error: "この登録は使い終えています。登録をやり直してください" };
  if (Date.parse(record.expiresAt) < Date.now()) return { ok: false, error: "登録の期限が切れています。登録をやり直してください" };
  const reg = response as RegistrationResponseJSON;
  const origin = originOf(reg.response?.clientDataJSON);
  if (!pageOriginAllowed(origin)) return { ok: false, error: `登録の origin が受けられません。${acceptedOriginsHint()} で画面を開き直してください` };
  const rpId = new URL(origin as string).hostname.toLowerCase();
  // the RP ID the page declares has to be the host the request itself names: a page at one host must not register
  // a key under another host's RP ID (the tailnet listener with a forged `localhost` Host is kept as pending below)
  const requestOriginHost = input.requestOriginHost?.trim().toLowerCase();
  const requestHost = input.requestHost?.trim().toLowerCase();
  if (requestOriginHost && !pageHostsMatch(requestOriginHost, rpId)) {
    return { ok: false, error: `登録の RP ID が要求の Origin と合いません。${acceptedOriginsHint()} で画面を開き直してください` };
  }
  if (!requestOriginHost && requestHost && !pageHostsMatch(requestHost, rpId)) {
    return { ok: false, error: `登録の RP ID が要求の Host と合いません。${acceptedOriginsHint()} で画面を開き直してください` };
  }
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: reg,
      expectedChallenge: challengeOf(record.hash, nonce),
      expectedOrigin: origin as string,
      expectedRPID: rpId,
      requireUserVerification: false,
    });
  } catch (error) {
    return { ok: false, error: `登録を確かめられませんでした: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!verified.verified || !verified.registrationInfo) return { ok: false, error: "登録を確かめられませんでした" };
  const credential = verified.registrationInfo.credential;
  const id = credential.id;
  const publicKey = Buffer.from(credential.publicKey).toString("base64url");

  // a verified registration that cannot be taken on its own becomes pending; its proof nonce is the one an
  // already registered key signs, whether the same screen carries it back or the loopback screen approves later
  const dropPendingFor = (target: PasskeyState): boolean => {
    const before = (target.pending ?? []).length;
    target.pending = (target.pending ?? []).filter((entry) => entry.credentialId !== id);
    return target.pending.length !== before;
  };

  // The first key is taken on its own only from a loopback request (the local screen). The judgment is the
  // connection the request arrived on, not the origin the response declares: a registration from a tailnet
  // listener waits as pending even when its own clientDataJSON says `localhost`, and even when no key exists yet.
  // Nothing could approve it before a local key is registered, and the tailnet side must never become the first
  // key on its own.
  const localScreen = input.localScreen === true;
  const needsProofToStore = (current: PasskeyState): boolean => !localScreen || (current.credentials ?? []).length > 0;

  const markPending = (): FinishRegistrationResult => {
    const before = readState();
    if (!before.ok) return { ok: false, error: before.error };
    // a replayed registration for a key that is already registered adds nothing and starts no pending
    const already = (before.state.credentials ?? []).find((c) => c.id === id);
    if (already) {
      if (dropPendingFor(before.state)) save(before.state);
      consumeNonce(nonce);
      return { ok: true, credential: { id: already.id, name: already.name, createdAt: already.createdAt } };
    }
    const kept = (before.state.pending ?? []).filter((entry) => entry.credentialId !== id && Date.parse(entry.expiresAt) >= Date.now());
    if (kept.length >= PENDING_LIMIT) return { ok: false, error: `保留の登録が上限（${PENDING_LIMIT} 件）に達しています。時間をおいてやり直してください` };
    const { nonce: proofNonce, challenge, expiresAt } = createRegistrationProof(id, publicKey, rpId);
    // the challenge above wrote its nonce to the state: read it back before appending the pending record
    const current = readState();
    if (!current.ok) return { ok: false, error: current.error };
    current.state.pending = [...kept, {
      id: randomBytes(12).toString("base64url"),
      credentialId: id,
      publicKey,
      counter: credential.counter,
      rpId,
      name: input.name?.trim() || `passkey ${(current.state.credentials ?? []).length + 1}`,
      createdAt: new Date().toISOString(),
      // exactly the proof nonce's own deadline: every pending in the list can still be approved
      expiresAt,
      proof: { nonce: proofNonce, challenge },
    }];
    save(current.state);
    return { ok: false, error: "登録済みの passkey で署名してください", needsProof: true, pending: true, proof: { nonce: proofNonce, challenge, rpId } };
  };

  if (needsProofToStore(state)) {
    const proof = input.proof;
    if (!proof?.nonce) return markPending();
    const checked = await verifyApprovalSignature({ nonce: proof.nonce, assertion: proof.assertion, content: registrationProofContent(id, publicKey, rpId) });
    if (!checked.ok) return { ok: false, error: checked.reason, needsProof: true };
    consumeNonce(proof.nonce);
  }
  // the save reads and writes without an await in between, so a registration that arrived while the proof above
  // was checked is appended to, and the first-key decision is made against the state at this very moment
  const after = readState();
  if (!after.ok) return { ok: false, error: after.error };
  if (needsProofToStore(after.state) && !input.proof?.nonce) return markPending();
  const duplicate = (after.state.credentials ?? []).find((c) => c.id === id);
  if (duplicate) {
    // the registration is already confirmed: its pending record (if any) goes with it, so a replay cannot add a second
    if (dropPendingFor(after.state)) save(after.state);
    consumeNonce(nonce);
    return { ok: true, credential: { id: duplicate.id, name: duplicate.name, createdAt: duplicate.createdAt } };
  }
  const listing: StoredPasskey = {
    id,
    publicKey,
    counter: credential.counter,
    name: input.name?.trim() || `passkey ${(after.state.credentials ?? []).length + 1}`,
    createdAt: new Date().toISOString(),
    rpId,
  };
  after.state.credentials = [...(after.state.credentials ?? []), listing];
  after.state.pending = (after.state.pending ?? []).filter((entry) => entry.credentialId !== id);
  save(after.state);
  consumeNonce(nonce);
  return { ok: true, credential: { id: listing.id, name: listing.name, createdAt: listing.createdAt } };
}

// ---- the content a signature is over ----

/** the fields of a push, a PR and where they go: what a submit card's approval sends */
export interface ShipContentInput {
  iddId: string;
  /** the repo the push and the PR go to (owner/name) */
  repo: string;
  /** the branch pushed to, and the base a new PR opens against */
  branch: string;
  base: string;
  /** the tree the push publishes (the checked public tree) */
  publicTree: string;
  /** the commit message as the exported commit carries it (approvedCommitMessage already applied) */
  commitMessage: string;
  /** a new PR's title and body, null when the approval makes no PR */
  pr: { title: string; body: string } | null;
}

export function shipContent(input: ShipContentInput): Record<string, unknown> {
  return {
    kind: "ship",
    iddId: input.iddId,
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    publicTree: input.publicTree,
    commitMessage: input.commitMessage,
    pr: input.pr ? { title: input.pr.title, body: input.pr.body } : null,
  };
}

/**
 * The fields of a posting and where it goes: what an outbound card's approval sends. Everything the poster reads
 * to write is here, so the signature covers it: the gh-issue labels, and a reply's destination thread, its
 * quoted text and its label as well as its body.
 */
export interface OutboundContentInput {
  id: string;
  outKind: string;
  target: {
    repo: string | null;
    issue: number | null;
    pr: number | null;
    expectHead: string | null;
    visibility: string | null;
    event: string | null;
    /** gh-issue: the labels the poster adds with `--label` */
    labels: string[] | null;
  };
  title: string;
  body: string;
  parts: { ref: string; body: string; resolve: boolean; thread_id: string | null; comment_id?: string | null; quote: string | null; label: string | null }[] | null;
  labels: { remove: string[]; add: string[] } | null;
}

/**
 * The fields of a landing into the work side's mainline and where it goes: what a submit card's approval sends
 * for a repo that does not publish. The checked merge commit and the mainline tip are left out on purpose: the
 * approval stays good while the mainline moves (the tick checks the merge again at the new tip), so binding the
 * signature to them would make penne sign again on every mainline move.
 */
export interface LandContentInput {
  iddId: string;
  /** the repo the merge goes to (owner/name) */
  repo: string;
  /** the work side's mainline branch the lane is merged into */
  workBase: string;
  /** the lane head the merge was checked for */
  head: string;
  /**
   * the GitHub Issue the same approval closes: its repo, its number and the one-liner posted with the close, or null
   * when the landing carries no close. The destination and the one-liner go out, so both are under the signature.
   */
  close: { repo: string; issue: number; comment: string } | null;
}

export function landContent(input: LandContentInput): Record<string, unknown> {
  return {
    kind: "land",
    iddId: input.iddId,
    repo: input.repo,
    workBase: input.workBase,
    head: input.head,
    close: input.close ? { repo: input.close.repo, issue: input.close.issue, comment: input.close.comment } : null,
  };
}

/**
 * The fields of a batch of landings into the work side's mainline: what one signature over the batch card covers. It is
 * the lanes in the order they are laid on the mainline, each with the head penne saw and the Issue close it carries,
 * and the destination the batch goes to (the repo and the mainline branch). Neither the mainline tip nor any merge
 * commit is in it, as in a single landing: the tip moves after the signature and is met by checking again at the new
 * tip, and a conversion that keeps the meaning (a conflict resolved, a drawing redrawn) is inside the signature rather
 * than part of what it covers (C-247-2). The signature allows any part of the lanes it names to land, in this order.
 */
export interface LandBatchContentInput {
  /** the repo the merges go to (owner/name) */
  repo: string;
  /** the work side's mainline branch the lanes are merged into */
  workBase: string;
  /** the lanes in the order they are laid on the mainline */
  lanes: { iddId: string; head: string; close: { repo: string; issue: number; comment: string } | null }[];
}

export function landBatchContent(input: LandBatchContentInput): Record<string, unknown> {
  return {
    kind: "land-batch",
    repo: input.repo,
    workBase: input.workBase,
    lanes: input.lanes.map((lane) => ({
      iddId: lane.iddId,
      head: lane.head,
      close: lane.close ? { repo: lane.close.repo, issue: lane.close.issue, comment: lane.close.comment } : null,
    })),
  };
}

/**
 * The fields of a local completion: what a submit card's approval sends when the lane has no public change. The
 * lane's records are committed to the work side's mainline, so the signature names the lane head and that branch.
 */
export interface LocalCompleteContentInput {
  iddId: string;
  /** the repo whose work side mainline the records are committed to (owner/name) */
  repo: string;
  /** the work side's mainline branch the records are committed to */
  workBase: string;
  /** the lane head the completion was checked for */
  head: string;
}

export function localCompleteContent(input: LocalCompleteContentInput): Record<string, unknown> {
  return {
    kind: "local-complete",
    iddId: input.iddId,
    repo: input.repo,
    workBase: input.workBase,
    head: input.head,
  };
}

/**
 * The fields of one idea document's exit rows and where they go: what one signature over an idea's exits covers.
 * The document path, the frozen four points' fingerprint and the declared places are in it, so a document whose
 * freeze broke or whose declared places grew after the challenge cannot be run. Each row carries what it will do
 * (its effect, operation, destination, one-line what and how to undo it) and the operation's own content. A row's
 * state and result are left out: the engine writes them between rows, and they must not move the signature. An
 * Issue that was already made is carried by its number, so re-pointing a result is caught at the gate.
 */
export interface IdeaExitContentInput {
  document: string;
  fingerprint: string;
  places: string[];
  rows: Record<string, unknown>[];
}

export function ideaExitContent(input: IdeaExitContentInput): Record<string, unknown> {
  return {
    kind: "idea-exit",
    document: input.document,
    fingerprint: input.fingerprint,
    places: [...input.places],
    rows: input.rows.map((row) => ({ ...row })),
  };
}

/**
 * What one signature over an instruction proposal's approval covers: the proposal itself, field by field. The text,
 * the reason and the scope are what will reach the roles and conversations, so a proposal that changed after the
 * challenge cannot be approved on the old signature. A PIN is not offered for it: the instructions steer every later
 * run, which is not a card of the four a PIN may sign.
 */
export interface InstructionApprovalContentInput {
  proposal: string;
  proposalKind: string;
  target?: string;
  text?: string;
  reason?: string;
  scope?: unknown;
  session: string;
  /** a session exception: what is done to which conversation's own list */
  op?: string;
  forSession?: string;
  /** a rejection is signed over the same proposal and the reason it is put away with; an approval's signature never passes for it */
  answer?: "approve" | "reject";
  rejectReason?: string;
}

export function instructionApprovalContent(input: InstructionApprovalContentInput): Record<string, unknown> {
  return {
    kind: "instruction-approval",
    answer: input.answer ?? "approve",
    rejectReason: input.rejectReason ?? null,
    proposal: input.proposal,
    proposalKind: input.proposalKind,
    target: input.target ?? null,
    text: input.text ?? null,
    reason: input.reason ?? null,
    scope: input.scope ?? null,
    session: input.session,
    op: input.op ?? null,
    forSession: input.forSession ?? null,
  };
}

export function outboundContent(input: OutboundContentInput): Record<string, unknown> {
  return {
    kind: "outbound",
    id: input.id,
    outKind: input.outKind,
    target: {
      repo: input.target.repo,
      issue: input.target.issue,
      pr: input.target.pr,
      expectHead: input.target.expectHead,
      visibility: input.target.visibility,
      event: input.target.event,
      labels: input.target.labels ? [...input.target.labels] : null,
    },
    title: input.title,
    body: input.body,
    parts: input.parts ? input.parts.map((p) => ({ ref: p.ref, body: p.body, resolve: p.resolve, thread_id: p.thread_id, comment_id: p.comment_id ?? null, quote: p.quote, label: p.label })) : null,
    labels: input.labels ? { remove: [...input.labels.remove], add: [...input.labels.add] } : null,
  };
}

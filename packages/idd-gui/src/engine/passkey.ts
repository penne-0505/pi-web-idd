/**
 * The screen's signing door: the one path an approval that can leave this machine takes. It asks the engine for a
 * challenge over the approval's own content, signs it with the registered passkey, and hands back the signature.
 *
 * The screen never verifies a signature, never decides by itself whether one is needed, and never writes one down:
 * the engine's answer alone says whether the approval needs a signature (`required`) and whether any key is
 * registered (`registered`). The RP ID is the page's own host name, without a port: keys are bound to the host they
 * were registered with, and the engine refuses a value that is not a configured host.
 */

/** the signature an approval carries: the engine's one-time nonce and the assertion the page made over its challenge */
export interface PasskeyApproval {
  nonce: string;
  assertion: unknown;
}

export interface SignResult {
  ok: boolean;
  /** present when the engine said a signature is needed and one was made */
  approval?: PasskeyApproval;
  /** the engine said no key is registered: the screen offers the current GUI instead of signing */
  needsRegistration?: boolean;
  /** the engine answered `required: false`: the approval writes nothing and goes without a signature */
  notRequired?: boolean;
  error?: string;
  /** the challenge door's own answer, so a caller can show the rows and the breakdown it signed */
  answer?: ChallengeAnswer;
}

export interface PasskeyDeps {
  fetcher?: PasskeyFetch;
  /** the browser's credential store; injectable so the order (challenge, signature, approve) can be checked without a browser */
  credentials?: {
    get?: (options: CredentialRequestOptions) => Promise<Credential | null>;
    create?: (options: CredentialCreationOptions) => Promise<Credential | null>;
  };
  /** the page's host name, without a port; read from `location` when not given */
  hostname?: string;
}

/** the shape the engine's routes are called with; the inbox's own fetch and the browser's `fetch` both fit it */
export type PasskeyFetch = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export interface PasskeyList {
  /** the list was read: zero entries then really means none is registered */
  readable: boolean;
  registered?: { id: string; name?: string; createdAt?: string }[];
  rpId?: string;
  error?: string;
}

/**
 * One registration that verified but waits for an already registered key's signature: the local screen shows the
 * key that would be added (its name, the host it belongs to and its deadline) and signs this row's own challenge.
 */
export interface PendingRegistration {
  id: string;
  name: string;
  /** the host the key to be added belongs to; the signature itself is made under the approving page's own host */
  rpId: string;
  createdAt: string;
  expiresAt: string;
  /** the challenge of this pending record alone: what the approving key signs */
  challenge: string;
}

export interface PendingList {
  /** the list was read: zero entries then really means nothing waits */
  readable: boolean;
  pending?: PendingRegistration[];
  error?: string;
}

export interface RegisterResult {
  ok: boolean;
  /** the engine kept the verified key as pending: the local screen approves it later */
  pending?: boolean;
  error?: string;
}

export interface ApproveResult {
  ok: boolean;
  error?: string;
}

interface ChallengeBody {
  ok?: boolean;
  error?: string;
  required?: boolean;
  registered?: number;
  nonce?: string;
  challenge?: string;
  rpId?: string;
  allowCredentials?: { id: string }[];
}

/**
 * A challenge door's own answer, as both the passkey door and an idea's exit door return it. The rows and the
 * summary are carried through so a caller can show exactly what was signed; they are read from the one place the
 * door answered, never from a copy the screen kept.
 */
export interface ChallengeAnswer extends ChallengeBody {
  rows?: unknown;
  summary?: unknown;
  expiresAt?: string;
  [key: string]: unknown;
}

/** one challenge door to call: the path and the body the door expects (the RP ID is already in the body) */
export interface ChallengeRequest {
  path: string;
  body: unknown;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** the page's host name with the port taken off; `location.host` is never used, since the engine matches the host exactly */
export function pageHostname(deps: PasskeyDeps = {}): string {
  if (typeof deps.hostname === "string") return deps.hostname;
  const loc = (globalThis as { location?: { hostname?: string } }).location;
  return loc?.hostname ?? "localhost";
}

function bytesFromBase64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

function credentialJson(value: unknown): unknown {
  const maybe = value as { toJSON?: () => unknown } | null;
  return maybe && typeof maybe.toJSON === "function" ? maybe.toJSON() : value;
}

function jsonPost(fetcher: PasskeyFetch, url: string, body: unknown) {
  return fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * Ask one challenge door, sign its challenge with the registered passkey, and return the signature. The door's
 * answer is handed to `onChallenge` before the browser is asked to sign, so a caller can put the rows it signed
 * on screen first (the exits block shows the challenge's rows, not the status door's copy). The RP ID the page
 * names is its own host, so a screen opened over a tailnet address is refused by the engine with the host to
 * open instead, rather than failing inside the browser with no reason.
 */
export async function signChallenge(request: ChallengeRequest, deps: PasskeyDeps = {}, onChallenge?: (answer: ChallengeAnswer) => void): Promise<SignResult> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  const credentials = deps.credentials ?? (globalThis as { navigator?: { credentials?: PasskeyDeps["credentials"] } }).navigator?.credentials;
  let challenge: ChallengeAnswer;
  try {
    const res = await jsonPost(fetcher, request.path, request.body);
    challenge = (await res.json().catch(() => ({}))) as ChallengeAnswer;
    if (!res.ok || !challenge?.ok) return { ok: false, error: String(challenge?.error ?? `HTTP ${res.status}`), answer: challenge };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  // the answer is shown before the browser's own prompt: the rows must be the ones penne sees when signing
  onChallenge?.(challenge);
  // an approval that writes nothing asks for no signature: it goes out as it is
  if (!challenge.required) return { ok: true, notRequired: true, answer: challenge };
  if (!challenge.registered) return { ok: false, needsRegistration: true, error: "passkey がまだ登録されていません", answer: challenge };
  if (!credentials?.get) return { ok: false, error: "このブラウザでは passkey を使えません", answer: challenge };
  let assertion: Credential | null;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: bytesFromBase64url(String(challenge.challenge ?? "")),
        rpId: challenge.rpId,
        allowCredentials: (challenge.allowCredentials ?? []).map((c) => ({ id: bytesFromBase64url(c.id), type: "public-key" as const })),
        userVerification: "preferred",
        timeout: 60_000,
      },
    });
  } catch (error) {
    return { ok: false, error: `署名できませんでした: ${message(error)}`, answer: challenge };
  }
  if (!assertion) return { ok: false, error: "署名が取り消されました", answer: challenge };
  return { ok: true, approval: { nonce: String(challenge.nonce ?? ""), assertion: credentialJson(assertion) }, answer: challenge };
}

/**
 * Ask for this approval's challenge, sign it with the registered passkey, and return the signature. This is the
 * Inbox's own door; the exits block calls `signChallenge` with its own path. The behavior is unchanged: the
 * same passkey door, the same body, and the same answer for a missing key.
 */
export async function signApproval(action: string, payload: Record<string, unknown> | undefined, deps: PasskeyDeps = {}): Promise<SignResult> {
  const rpId = pageHostname(deps);
  return signChallenge({ path: "/api/idd/passkey/challenge", body: { action, payload, rpId } }, deps);
}

/**
 * Read the keys registered for this page's host. A failed read is reported as unreadable, never as zero keys: a
 * state that cannot be read is not a state with nothing in it.
 */
export async function listPasskeys(deps: PasskeyDeps = {}): Promise<PasskeyList> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  const rpId = pageHostname(deps);
  try {
    const res = await fetcher(`/api/idd/passkey/register?rpId=${encodeURIComponent(rpId)}`);
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; registered?: PasskeyList["registered"]; rpId?: string } | null;
    if (!res.ok || !body?.ok) return { readable: false, error: String(body?.error ?? `HTTP ${res.status}`) };
    return { readable: true, registered: body.registered ?? [], rpId: body.rpId };
  } catch (error) {
    return { readable: false, error: message(error) };
  }
}

function pendingEntry(value: unknown): PendingRegistration | null {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o.id !== "string" || typeof o.challenge !== "string") return null;
  return {
    id: o.id,
    name: typeof o.name === "string" ? o.name : o.id,
    rpId: typeof o.rpId === "string" ? o.rpId : "",
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    expiresAt: typeof o.expiresAt === "string" ? o.expiresAt : "",
    challenge: o.challenge,
  };
}

/**
 * Read the registrations that verified but wait for a registered key's approval. Only the local screen may read
 * them: the engine answers 403 to a request the tailnet listener accepted, and that refusal is reported as an
 * unreadable list with its reason, never as an empty one.
 */
export async function listPending(deps: PasskeyDeps = {}): Promise<PendingList> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  try {
    const res = await fetcher("/api/idd/passkey/pending");
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; pending?: unknown } | null;
    if (!res.ok || !body?.ok || !Array.isArray(body.pending)) return { readable: false, error: String(body?.error ?? `HTTP ${res.status}`) };
    return { readable: true, pending: body.pending.map(pendingEntry).filter((entry): entry is PendingRegistration => entry !== null) };
  } catch (error) {
    return { readable: false, error: message(error) };
  }
}

/** the creation options the engine made for this page: its challenge and user id are base64url strings */
interface RegistrationOptions {
  ok?: boolean;
  error?: string;
  nonce?: string;
  options?: Record<string, unknown> & { challenge?: string; user?: { id?: string } };
}

/** the `finish` answer: `needsProof` carries the challenge an already registered key signs over the new one */
interface FinishAnswer {
  ok?: boolean;
  error?: string;
  needsProof?: boolean;
  pending?: boolean;
  proof?: { nonce?: string; challenge?: string; rpId?: string; allowCredentials?: { id: string }[] };
}

/**
 * Register a passkey in steps: the creation options for this page's own host, the browser's `create`, and the
 * engine's answer. The first key on the local screen is stored on its own. Once one is registered the engine asks
 * for a signature by an already registered key, over the key just created; this page makes it when the engine
 * names keys it can use. A page that has no such key (the tailnet screen: its keys belong to another host) leaves
 * the verified key pending, and the local screen approves it from the list. Which of the two happens is the
 * engine's answer alone; the screen only decides whether it can make the signature the engine asked for.
 */
export async function registerPasskey(name?: string, deps: PasskeyDeps = {}): Promise<RegisterResult> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  const credentials = deps.credentials ?? (globalThis as { navigator?: { credentials?: PasskeyDeps["credentials"] } }).navigator?.credentials;
  const rpId = pageHostname(deps);
  if (!credentials?.create) return { ok: false, error: "このブラウザでは passkey を登録できません" };
  let optionsAnswer: RegistrationOptions;
  try {
    const res = await jsonPost(fetcher, "/api/idd/passkey/register", { step: "options", rpId });
    optionsAnswer = (await res.json().catch(() => ({}))) as RegistrationOptions;
    if (!res.ok || !optionsAnswer.ok || !optionsAnswer.options?.challenge) return { ok: false, error: String(optionsAnswer.error ?? `HTTP ${res.status}`) };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  const options = optionsAnswer.options;
  const userId = options.user?.id;
  let creation: Credential | null;
  try {
    creation = await credentials.create({
      publicKey: {
        ...options,
        challenge: bytesFromBase64url(String(options.challenge)),
        ...(userId ? { user: { ...options.user, id: bytesFromBase64url(userId) } } : {}),
      } as unknown as PublicKeyCredentialCreationOptions,
    });
  } catch (error) {
    return { ok: false, error: `登録できませんでした: ${message(error)}` };
  }
  if (!creation) return { ok: false, error: "登録が取り消されました" };
  const response = credentialJson(creation);
  const finishBody = (proof?: { nonce: string; assertion: unknown }) => ({
    step: "finish",
    nonce: optionsAnswer.nonce,
    response,
    ...(name ? { name } : {}),
    ...(proof ? { proof } : {}),
  });
  let finish: FinishAnswer;
  try {
    const res = await jsonPost(fetcher, "/api/idd/passkey/register", finishBody());
    finish = (await res.json().catch(() => ({}))) as FinishAnswer;
    if (finish.ok) return { ok: true };
    if (!finish.needsProof) return { ok: false, error: String(finish.error ?? `HTTP ${res.status}`) };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  // the verified key waits as pending already; without a key this page can use there is nothing left to sign here
  const proof = finish.proof;
  const allowCredentials = proof?.allowCredentials ?? [];
  if (!proof?.challenge || !allowCredentials.length || !credentials.get) return { ok: false, pending: true, error: String(finish.error ?? "") };
  let assertion: Credential | null;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: bytesFromBase64url(proof.challenge),
        rpId: proof.rpId,
        allowCredentials: allowCredentials.map((c) => ({ id: bytesFromBase64url(c.id), type: "public-key" as const })),
        userVerification: "preferred",
        timeout: 60_000,
      },
    });
  } catch (error) {
    return { ok: false, pending: true, error: `署名できませんでした: ${message(error)}` };
  }
  // a cancelled signature leaves the engine's pending record alone: the local screen can still approve it
  if (!assertion) return { ok: false, pending: true, error: "署名が取り消されました" };
  try {
    const res = await jsonPost(fetcher, "/api/idd/passkey/register", finishBody({ nonce: String(proof.nonce ?? ""), assertion: credentialJson(assertion) }));
    const stored = (await res.json().catch(() => ({}))) as FinishAnswer;
    return stored.ok ? { ok: true } : { ok: false, pending: true, error: String(stored.error ?? `HTTP ${res.status}`) };
  } catch (error) {
    return { ok: false, pending: true, error: message(error) };
  }
}

/**
 * Approve one pending registration with a key this page has registered. The signature is made over the row's own
 * challenge, under this page's own host, and the same row's id is sent with it: the engine checks the pending key's
 * ID, public key and RP ID against what was shown, so no key penne did not see is added. The engine hands the
 * screen no list of the keys that can sign here, so the page names every key it knows as the candidates: the
 * browser only offers the ones bound to this host, and a key it cannot offer by discovery can still be chosen.
 */
export async function approvePending(id: string, challenge: string, credentialIds: string[] = [], deps: PasskeyDeps = {}): Promise<ApproveResult> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  const credentials = deps.credentials ?? (globalThis as { navigator?: { credentials?: PasskeyDeps["credentials"] } }).navigator?.credentials;
  if (!credentials?.get) return { ok: false, error: "このブラウザでは passkey を使えません" };
  let assertion: Credential | null;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: bytesFromBase64url(challenge),
        rpId: pageHostname(deps),
        ...(credentialIds.length ? { allowCredentials: credentialIds.map((key) => ({ id: bytesFromBase64url(key), type: "public-key" as const })) } : {}),
        userVerification: "preferred",
        timeout: 60_000,
      },
    });
  } catch (error) {
    return { ok: false, error: `署名できませんでした: ${message(error)}` };
  }
  if (!assertion) return { ok: false, error: "署名が取り消されました" };
  try {
    const res = await jsonPost(fetcher, "/api/idd/passkey/pending/approve", { id, assertion: credentialJson(assertion) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return body.ok ? { ok: true } : { ok: false, error: String(body.error ?? `HTTP ${res.status}`) };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** whether the page is opened on the machine that runs the engine, so the current GUI's registration can be linked */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

// ---- the PIN: the second, daily way to sign one card's approval (C-182-1..7) ----

/** how many digits the screen asks for; the engine never sees the PIN */
export const PIN_DIGITS = 6;
const PIN_PATH = "/api/idd/passkey/pin";
/** the strength a PIN is stretched with unless the engine keeps another: PBKDF2-SHA-256, counted for slowness */
const PIN_ITERATIONS = 600_000;
/** the DER prefix of an Ed25519 private key, so the seed the PIN derives can be imported as PKCS#8 */
const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** a fresh ArrayBuffer copy of bytes, the form WebCrypto's parameters take */
function arrayBufferOf(value: string | Uint8Array): ArrayBuffer {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export interface PinKdf {
  name: string;
  hash: string;
  iterations: number;
}

/**
 * The PIN's state, as the engine answers it. The salt and the public key are material, not secrets: the screen
 * needs them to derive the same key from the same PIN. The PIN and the key derived from it are never here.
 */
export interface PinStatusAnswer {
  /** the engine's state was read: `configured: false` then really means no PIN is set */
  readable: boolean;
  configured: boolean;
  /** the moment the PIN is stopped until, null while it is not */
  lockedUntil: string | null;
  digits: number;
  salt?: string;
  kdf?: PinKdf;
  error?: string;
}

export async function readPin(deps: PasskeyDeps = {}): Promise<PinStatusAnswer> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  try {
    const res = await fetcher(PIN_PATH);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !body || body.ok !== true) {
      return { readable: false, configured: false, lockedUntil: null, digits: PIN_DIGITS, error: String((body && body.error) ?? `HTTP ${res.status}`) };
    }
    const kdf = body.kdf && typeof body.kdf === "object" ? (body.kdf as Record<string, unknown>) : null;
    const parsedKdf: PinKdf | undefined = kdf && Number.isFinite(Number(kdf.iterations))
      ? { name: String(kdf.name ?? "PBKDF2"), hash: String(kdf.hash ?? "SHA-256"), iterations: Number(kdf.iterations) }
      : undefined;
    return {
      readable: true,
      configured: body.configured === true,
      lockedUntil: typeof body.lockedUntil === "string" ? body.lockedUntil : null,
      digits: Number.isInteger(body.digits) ? Number(body.digits) : PIN_DIGITS,
      ...(typeof body.salt === "string" ? { salt: body.salt } : {}),
      ...(parsedKdf ? { kdf: parsedKdf } : {}),
    };
  } catch (error) {
    return { readable: false, configured: false, lockedUntil: null, digits: PIN_DIGITS, error: message(error) };
  }
}

/** base64url of bytes, the encoding the engine's salt, public key and signature use */
function base64urlOf(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  const source = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!source?.getRandomValues) throw new Error("このブラウザでは salt を作れません");
  source.getRandomValues(salt);
  return salt;
}

/**
 * The key the PIN derives, made where the PIN was typed. WebCrypto's PBKDF2 stretches the digits and its Ed25519
 * signs the challenge; both are standard, so a terminal (the later device approval) can make the same key from the
 * same PIN and salt without a dependency of its own (C-182-3). The key never leaves this function's caller.
 */
async function derivePinKey(pin: string, salt: Uint8Array, iterations: number): Promise<{ key: CryptoKey; publicKey: string }> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error("このブラウザでは PIN から鍵を作れません（WebCrypto が使えません。localhost か https で開いてください）");
  const base = await subtle.importKey("raw", arrayBufferOf(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: arrayBufferOf(salt), iterations }, base, 256);
  const seed = new Uint8Array(bits);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  const key = await subtle.importKey("pkcs8", arrayBufferOf(pkcs8), { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await subtle.exportKey("jwk", key)) as { x?: string };
  if (!jwk.x) throw new Error("PIN から公開鍵を取り出せません");
  return { key, publicKey: jwk.x };
}

/** the signature over the challenge's own text, the value the engine verifies with the PIN's public key */
async function signChallengeWith(pin: string, salt: string, iterations: number, challenge: string): Promise<{ signature: string; publicKey: string }> {
  const { key, publicKey } = await derivePinKey(pin, new Uint8Array(bytesFromBase64url(salt)), iterations);
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle as SubtleCrypto;
  const signature = await subtle.sign({ name: "Ed25519" }, key, arrayBufferOf(challenge));
  return { signature: base64urlOf(signature), publicKey };
}

function pinDigits(digits: number, pin: string): string | null {
  if (!new RegExp(`^\\d{${digits}}$`).test(pin)) return `PIN は ${digits} 桁の数字です`;
  return null;
}

function lockedMessage(until: string | null): string | null {
  if (!until) return null;
  return Date.parse(until) > Date.now() ? `PIN は失敗が続いたため ${until} まで止まっています。passkey で署名してください` : null;
}

export interface PinSignResult {
  ok: boolean;
  /** the proof an approval carries instead of a passkey's assertion: the nonce and the PIN's signature */
  approval?: { nonce: string; pinProof: { signature: string } };
  needsRegistration?: boolean;
  /** the engine said this approval writes nothing: it goes without a signature */
  notRequired?: boolean;
  error?: string;
  answer?: ChallengeAnswer;
}

/**
 * Ask for this approval's challenge, sign it with the key the PIN derives, and return the proof. The challenge is
 * the passkey's own, made over the approval's content, so a PIN signs exactly what the confirm stage showed and
 * once (C-182-6). The PIN goes no further than this call: it is stretched into a key here, the signature is what
 * leaves, and nothing is written down.
 */
export async function signWithPin(action: string, payload: Record<string, unknown> | undefined, pin: string, deps: PasskeyDeps = {}): Promise<PinSignResult> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  const status = await readPin(deps);
  if (!status.readable) return { ok: false, error: `PIN の記録を読めません: ${status.error ?? ""}` };
  if (!status.configured || !status.salt || !status.kdf) return { ok: false, error: "PIN が設定されていません。設定の Passkeys で設定してください" };
  const locked = lockedMessage(status.lockedUntil);
  if (locked) return { ok: false, error: locked };
  const bad = pinDigits(status.digits, pin);
  if (bad) return { ok: false, error: bad };
  let challenge: ChallengeAnswer;
  try {
    const res = await jsonPost(fetcher, "/api/idd/passkey/challenge", { action, payload, rpId: pageHostname(deps) });
    challenge = (await res.json().catch(() => ({}))) as ChallengeAnswer;
    if (!res.ok || !challenge?.ok) return { ok: false, error: String(challenge?.error ?? `HTTP ${res.status}`), answer: challenge };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  if (!challenge.required) return { ok: true, notRequired: true, answer: challenge };
  if (!challenge.registered) return { ok: false, needsRegistration: true, error: "passkey がまだ登録されていません", answer: challenge };
  try {
    const signed = await signChallengeWith(pin, status.salt, status.kdf.iterations, String(challenge.challenge ?? ""));
    return { ok: true, approval: { nonce: String(challenge.nonce ?? ""), pinProof: { signature: signed.signature } }, answer: challenge };
  } catch (error) {
    return { ok: false, error: `PIN の鍵を作れませんでした: ${message(error)}`, answer: challenge };
  }
}

export interface PinChangeResult {
  ok: boolean;
  error?: string;
}

interface PinChallengeAnswer {
  ok?: boolean;
  error?: string;
  nonce?: string;
  challenge?: string;
  rpId?: string;
  allowCredentials?: { id: string }[];
}

/** the assertion a registered passkey makes over the PIN operation's own challenge */
async function assertForPin(answer: PinChallengeAnswer, deps: PasskeyDeps): Promise<unknown> {
  const credentials = deps.credentials ?? (globalThis as { navigator?: { credentials?: PasskeyDeps["credentials"] } }).navigator?.credentials;
  if (!credentials?.get) throw new Error("このブラウザでは passkey を使えません");
  const assertion = await credentials.get({
    publicKey: {
      challenge: bytesFromBase64url(String(answer.challenge ?? "")),
      rpId: answer.rpId,
      allowCredentials: (answer.allowCredentials ?? []).map((c) => ({ id: bytesFromBase64url(c.id), type: "public-key" as const })),
      userVerification: "preferred",
      timeout: 60_000,
    },
  });
  if (!assertion) throw new Error("署名が取り消されました");
  return credentialJson(assertion);
}

async function pinOptions(op: "set" | "disable", body: Record<string, unknown>, deps: PasskeyDeps): Promise<PinChallengeAnswer> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  const res = await jsonPost(fetcher, PIN_PATH, { step: "options", op, ...body, rpId: pageHostname(deps) });
  const answer = (await res.json().catch(() => ({}))) as PinChallengeAnswer;
  if (!res.ok || !answer.ok) throw new Error(String(answer.error ?? `HTTP ${res.status}`));
  return answer;
}

async function pinFinish(op: "set" | "disable", body: Record<string, unknown>, nonce: string, assertion: unknown, deps: PasskeyDeps): Promise<PinChangeResult> {
  const fetcher = deps.fetcher ?? (fetch as unknown as PasskeyFetch);
  const res = await jsonPost(fetcher, PIN_PATH, { step: "finish", op, ...body, nonce, assertion, rpId: pageHostname(deps) });
  const answer = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return answer.ok ? { ok: true } : { ok: false, error: String(answer.error ?? `HTTP ${res.status}`) };
}

/**
 * Set or change the PIN. The PIN is stretched here into a key, only its public half is sent, and the engine keeps
 * it only once a registered passkey has signed over exactly that key, its salt and its strength: a PIN can never
 * replace the root that authorizes it (C-182-1).
 */
export async function setPin(pin: string, deps: PasskeyDeps = {}): Promise<PinChangeResult> {
  const status = await readPin(deps);
  if (!status.readable) return { ok: false, error: `PIN の記録を読めません: ${status.error ?? ""}` };
  const bad = pinDigits(status.digits, pin);
  if (bad) return { ok: false, error: bad };
  const iterations = status.kdf?.iterations ?? PIN_ITERATIONS;
  let publicKey: string;
  let salt: Uint8Array;
  try {
    salt = randomSalt();
    const derived = await derivePinKey(pin, salt, iterations);
    publicKey = derived.publicKey;
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  const material = { publicKey, salt: base64urlOf(salt), iterations };
  try {
    const options = await pinOptions("set", material, deps);
    const assertion = await assertForPin(options, deps);
    return await pinFinish("set", material, String(options.nonce ?? ""), assertion, deps);
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** turn the PIN off: a registered passkey signs over the decision, and after it no card can be signed with a PIN */
export async function disablePin(deps: PasskeyDeps = {}): Promise<PinChangeResult> {
  try {
    const options = await pinOptions("disable", {}, deps);
    const assertion = await assertForPin(options, deps);
    return await pinFinish("disable", {}, String(options.nonce ?? ""), assertion, deps);
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

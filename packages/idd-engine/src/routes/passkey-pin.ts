/**
 * The PIN's own door: whether one is set, the material a screen derives the key from, and the two operations that
 * change it. The PIN itself never reaches the engine: the screen stretches it with the salt the engine answers,
 * and sends the public half when it is set. Changing the PIN is the root's decision, so the record moves only on a
 * registered passkey's signature over the operation's own content (C-182-1) — a PIN's proof can never set, change,
 * or clear a PIN, the same way it can never register a key or approve a pending one (those doors verify a
 * passkey's assertion and nothing else).
 */
import {
  PIN_DIGITS,
  PIN_KDF_ITERATIONS,
  PIN_MAX_FAILURES,
  PIN_SALT_BYTES,
  clearPin,
  consumeNonce,
  createChallenge,
  passkeyCount,
  passkeyCredentialIds,
  pinDisableContent,
  pinSetContent,
  readPinMaterial,
  readPinStatus,
  savePin,
  verifyApprovalSignature,
} from "@idd/core";
import { json } from "../http.ts";
import { resolveRequestedRpId } from "./passkey-challenge.ts";

/** the strength the screen may ask for: wide enough for a slower KDF later, narrow enough to refuse noise */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 4_000_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function publicKeyOf(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !BASE64URL.test(text)) return null;
  // a raw Ed25519 public key is 32 bytes
  return Buffer.from(text, "base64url").length === 32 ? text : null;
}

function saltOf(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !BASE64URL.test(text)) return null;
  return Buffer.from(text, "base64url").length === PIN_SALT_BYTES ? text : null;
}

function iterationsOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) return null;
  return n;
}

/** the content a PIN operation's passkey signature is over, built the same way by `options` and `finish` */
function contentOf(op: "set" | "disable", body: Record<string, unknown>): { ok: true; content: Record<string, unknown> } | { ok: false; error: string } {
  if (op === "disable") return { ok: true, content: pinDisableContent() };
  const publicKey = publicKeyOf(body.publicKey);
  const salt = saltOf(body.salt);
  const iterations = iterationsOf(body.iterations);
  if (!publicKey) return { ok: false, error: "PIN の鍵（公開鍵）が読めません" };
  if (!salt) return { ok: false, error: `PIN の salt は ${PIN_SALT_BYTES} byte の base64url で送ってください` };
  if (iterations === null) return { ok: false, error: `PIN の導出の回数は ${MIN_ITERATIONS}〜${MAX_ITERATIONS} で送ってください` };
  return { ok: true, content: pinSetContent({ publicKey, salt, iterations }) };
}

/**
 * The PIN's state and the material its key is derived from. The salt and the public key are not secrets: the
 * record holds them, the screen needs them to derive the same key, and #183 takes the grind they allow as a
 * deliberate attack. What is never answered here is the PIN and the key derived from it — the engine does not
 * have either. A record that cannot be read is its reason, never "not set" (C-182-5).
 */
export async function GET() {
  try {
    const status = readPinStatus();
    if (!status.ok) return json({ ok: false, error: status.error }, { status: 500 });
    const material = readPinMaterial();
    if (!material.ok) return json({ ok: false, error: material.error }, { status: 500 });
    return json({
      ok: true,
      ...status.status,
      digits: PIN_DIGITS,
      maxFailures: PIN_MAX_FAILURES,
      defaultKdf: { name: "PBKDF2", hash: "SHA-256", iterations: PIN_KDF_ITERATIONS },
      ...(material.material ? { publicKey: material.material.publicKey, salt: material.material.salt, kdf: material.material.kdf } : {}),
    });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}

/**
 * `options` asks for the challenge a registered passkey signs, over the key the PIN would derive (or over clearing
 * it); `finish` carries that signature back with the same material, and only then does the record move. The RP ID
 * is checked the way the inbox's challenge door checks it, so a page at one host cannot sign for another.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  const op = body.op === "set" ? "set" : body.op === "disable" ? "disable" : null;
  if (!op) return json({ ok: false, error: "PIN の操作ではありません" }, { status: 400 });
  const step = String(body.step ?? "");
  try {
    const rp = resolveRequestedRpId(req, body.rpId);
    if (!rp.ok) return json({ ok: false, error: rp.error }, { status: 400 });
    const built = contentOf(op, body);
    if (!built.ok) return json({ ok: false, error: built.error }, { status: 400 });
    if (step === "options") {
      // a PIN sits under the passkey: without a registered key there is nothing that could sign its setting
      const registered = passkeyCount();
      if (!registered) return json({ ok: false, error: "PIN の設定には登録済みの passkey が要ります" }, { status: 400 });
      const { nonce, challenge, expiresAt } = createChallenge(built.content);
      return json({
        ok: true,
        nonce,
        challenge,
        expiresAt,
        rpId: rp.rpId,
        allowCredentials: passkeyCredentialIds(rp.rpId).map((id) => ({ id, type: "public-key" })),
      });
    }
    if (step === "finish") {
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      const checked = await verifyApprovalSignature({ nonce, assertion: body.assertion, content: built.content });
      if (!checked.ok) return json({ ok: false, error: checked.reason }, { status: 400 });
      if (op === "disable") clearPin();
      else {
        savePin({ publicKey: publicKeyOf(body.publicKey) as string, salt: saltOf(body.salt) as string, iterations: iterationsOf(body.iterations) as number });
      }
      consumeNonce(nonce);
      const status = readPinStatus();
      return json({ ok: true, ...(status.ok ? status.status : {}) });
    }
    return json({ ok: false, error: "PIN の操作の段がありません" }, { status: 400 });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}

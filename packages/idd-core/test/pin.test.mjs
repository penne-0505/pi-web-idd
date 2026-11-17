/**
 * The PIN under the passkey: what the engine keeps, what a PIN's proof may sign, the gate that opens only for the
 * content it signed, and the ledger and stop that make a guessed PIN visible. The PIN itself never reaches the
 * module: the tests derive the same key a screen would, and only the signature is handed over.
 */
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, pbkdf2Sync, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { approvalGateOpen, consumeNonce, createChallenge, createRegistrationProof, verifyApproval, verifyApprovalSignature, verifyPinProof } from "../src/passkey.ts";
import { createRegistrationOptions, finishRegistration } from "../src/passkey.ts";
import {
  PIN_CARD_KINDS,
  PIN_MAX_FAILURES,
  appendPinLedger,
  clearPin,
  pinDisableContent,
  pinIsSet,
  pinLockedUntil,
  pinMaySign,
  pinSetContent,
  readPinLedger,
  readPinMaterial,
  readPinState,
  readPinStatus,
  savePin,
} from "../src/pin.ts";
import { softwareAuthenticator } from "./passkey-fixture.mjs";

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";
const ITERATIONS = 600_000;
const PIN = "123456";

beforeEach(() => {
  process.env.IDD_STATE_DIR = mkdtempSync(join(tmpdir(), "idd-pin-"));
  delete process.env.IDD_PASSKEY_RP_ID;
});

/** a key registered through the module's own flow, so the gates see a real passkey */
async function registered() {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID }), name: "test key", localScreen: true });
  assert.equal(done.ok, true, done.error);
  return auth;
}

/** the key a screen derives from the PIN: PBKDF2 stretches the digits, Ed25519 signs the challenge (C-182-3) */
function derived(pin = PIN, salt = Buffer.alloc(16, 7)) {
  const seed = pbkdf2Sync(pin, salt, ITERATIONS, 32, "sha256");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return { key, publicKey: spki.subarray(spki.length - 32).toString("base64url"), salt: salt.toString("base64url") };
}

/** set the PIN the way the route does: a registered passkey signs over the key the PIN derives (C-182-1) */
async function setPin(auth, pin = PIN) {
  const material = derived(pin);
  const content = pinSetContent({ publicKey: material.publicKey, salt: material.salt, iterations: ITERATIONS });
  const ch = createChallenge(content);
  const checked = await verifyApprovalSignature({ nonce: ch.nonce, assertion: auth.assertion({ challenge: ch.challenge, origin: ORIGIN, rpId: RP_ID }), content });
  assert.equal(checked.ok, true, checked.reason);
  savePin({ publicKey: material.publicKey, salt: material.salt, iterations: ITERATIONS });
  return material;
}

const shipContent = (n) => ({ kind: "ship", iddId: "IDD-1", repo: "test/project", branch: "idd/IDD-1", base: "main", publicTree: `tree-${n}`, commitMessage: `feat: ${n}`, pr: null });

/** the PIN's proof over a challenge: the signature over the challenge's own text */
function pinProof(material, challenge) {
  return { signature: edSign(null, Buffer.from(String(challenge), "utf8"), material.key).toString("base64url") };
}

test("a PIN signs a card's challenge, opens the gate for that content alone, and uses the nonce once", async () => {
  const auth = await registered();
  const material = await setPin(auth);
  const content = shipContent(1);
  const ch = createChallenge(content);
  const checked = await verifyPinProof({ nonce: ch.nonce, proof: pinProof(material, ch.challenge), content });
  assert.equal(checked.ok, true, checked.reason);
  // the gate the outbound writes pass opens for exactly the content the PIN signed
  assert.equal(approvalGateOpen(ch.nonce, content).ok, true);
  assert.equal(approvalGateOpen(ch.nonce, shipContent(2)).ok, false);
  // the same signature over another nonce is another challenge, and is refused
  const other = createChallenge(content);
  const reused = await verifyPinProof({ nonce: other.nonce, proof: pinProof(material, ch.challenge), content });
  assert.equal(reused.ok, false);
  // an approval the PIN signed is spent once the approval is over
  consumeNonce(ch.nonce);
  assert.equal(approvalGateOpen(ch.nonce, content).ok, false);
});

test("a PIN signs only the cards; an idea's exit, a key's registration and the PIN itself are refused", async () => {
  const auth = await registered();
  const material = await setPin(auth);
  const idea = { kind: "idea-exit", document: "d", fingerprint: "f", places: [], rows: [] };
  const pinSet = pinSetContent({ publicKey: material.publicKey, salt: material.salt, iterations: ITERATIONS });
  const proofContent = { kind: "register", credentialId: "c", publicKey: "p", rpId: "localhost" };
  for (const content of [idea, pinSet, pinDisableContent(), proofContent]) {
    assert.equal(pinMaySign(content), false, `${content.kind} must not be a PIN's`);
    const ch = createChallenge(content);
    const checked = await verifyPinProof({ nonce: ch.nonce, proof: pinProof(material, ch.challenge), content });
    assert.equal(checked.ok, false, content.kind);
    assert.match(checked.reason, /passkey/);
    assert.equal(approvalGateOpen(ch.nonce, content).ok, false);
  }
  // the one function the head of a card approval goes through takes the PIN for a card and nothing else
  const card = shipContent(3);
  const ch = createChallenge(card);
  const viaApproval = await verifyApproval({ nonce: ch.nonce, pinProof: pinProof(material, ch.challenge), content: card });
  assert.equal(viaApproval.ok, true, viaApproval.reason);
  // an approval with neither proof is refused
  const bare = createChallenge(card);
  const nothing = await verifyApproval({ nonce: bare.nonce, content: card });
  assert.equal(nothing.ok, false);
});

test("a wrong PIN is refused and written down; a run of them stops the PIN while the passkey still signs", async () => {
  const auth = await registered();
  await setPin(auth);
  const wrong = derived("999999");
  const content = shipContent(4);
  for (let i = 0; i < PIN_MAX_FAILURES; i += 1) {
    const ch = createChallenge(content);
    const refused = await verifyPinProof({ nonce: ch.nonce, proof: pinProof(wrong, ch.challenge), content });
    assert.equal(refused.ok, false, `wrong PIN ${i + 1}`);
    assert.match(refused.reason, /PIN が違います/);
  }
  // the run stopped it: even the right PIN is refused for a while
  const locked = await pinLockedUntil();
  assert.equal(locked.ok, true);
  assert.ok(locked.until, "the PIN is stopped");
  const blocked = createChallenge(content);
  const right = await verifyPinProof({ nonce: blocked.nonce, proof: pinProof(derived(), blocked.challenge), content });
  assert.equal(right.ok, false);
  assert.match(right.reason, /止まっています/);
  // the passkey is not stopped by the PIN's trouble: the same card still goes through it
  const signed = createChallenge(content);
  const passkey = await verifyApprovalSignature({ nonce: signed.nonce, assertion: auth.assertion({ challenge: signed.challenge, origin: ORIGIN, rpId: RP_ID }), content });
  assert.equal(passkey.ok, true, passkey.reason);
  // every attempt is on the ledger: the wrong ones and the refused right one
  const ledger = readPinLedger();
  assert.equal(ledger.filter((entry) => entry.outcome === "refused").length >= PIN_MAX_FAILURES + 1, true);
  assert.equal(ledger.at(-1).kind, "ship");
  assert.equal(ledger.at(-1).nonce, blocked.nonce);
});

test("a right PIN clears the run of wrong ones and is written down as taken", async () => {
  const auth = await registered();
  const material = await setPin(auth);
  const wrong = derived("000000");
  const content = shipContent(5);
  for (let i = 0; i < 2; i += 1) {
    const ch = createChallenge(content);
    await verifyPinProof({ nonce: ch.nonce, proof: pinProof(wrong, ch.challenge), content });
  }
  const ok = createChallenge(content);
  const taken = await verifyPinProof({ nonce: ok.nonce, proof: pinProof(material, ok.challenge), content });
  assert.equal(taken.ok, true, taken.reason);
  const status = readPinStatus();
  assert.equal(status.ok, true);
  assert.equal(status.status.failures, 0);
  const ledger = readPinLedger();
  assert.equal(ledger.at(-1).outcome, "ok");
  assert.equal(ledger.at(-1).nonce, ok.nonce);
  assert.equal(ledger.some((entry) => entry.outcome === "ok"), true);
});

test("the PIN record holds the public key and the material only, in a file only its owner reads", async () => {
  const auth = await registered();
  const material = await setPin(auth);
  const statePath = join(process.env.IDD_STATE_DIR, "pin", "state.json");
  const text = readFileSync(statePath, "utf8");
  // neither the PIN nor the seed it derives is anywhere in what the engine keeps
  assert.doesNotMatch(text, new RegExp(PIN));
  assert.doesNotMatch(text, new RegExp(Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), pbkdf2Sync(PIN, Buffer.alloc(16, 7), ITERATIONS, 32, "sha256")]).toString("base64").slice(0, 24)));
  const saved = JSON.parse(text);
  assert.equal(saved.publicKey, material.publicKey);
  assert.equal(saved.salt, material.salt);
  assert.deepEqual(saved.kdf, { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS });
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  // the material the screen derives from is the same, and the PIN's status never carries the PIN
  const readMaterial = readPinMaterial();
  assert.equal(readMaterial.ok, true);
  assert.deepEqual(readMaterial.material, { publicKey: material.publicKey, salt: material.salt, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS } });
  const status = readPinStatus();
  assert.equal(status.ok, true);
  assert.equal(status.status.configured, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(PIN));
});

test("a PIN record that cannot be read is its reason, never a PIN that is not set", async () => {
  const auth = await registered();
  await setPin(auth);
  writeFileSync(join(process.env.IDD_STATE_DIR, "pin", "state.json"), "{ broken");
  const read = readPinState();
  assert.equal(read.ok, false);
  assert.match(read.error, /PIN の記録を解析できません/);
  assert.equal(pinIsSet().ok, false);
  // a proof against a broken record is refused with the reason: taking it as unset would open a way around the passkey
  const content = shipContent(6);
  const ch = createChallenge(content);
  const refused = await verifyPinProof({ nonce: ch.nonce, proof: { signature: "AAAA" }, content });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /PIN の記録を解析できません/);
  assert.equal(approvalGateOpen(ch.nonce, content).ok, false);
  // turning the PIN off is the passkey's decision, and after it the record is gone
  clearPin();
  assert.equal(readPinState().ok, true);
  assert.equal(readPinState().pin, null);
});

test("the ledger is appended in a file only its owner reads", () => {
  appendPinLedger({ outcome: "refused", nonce: "n1", kind: "ship", hash: "h1", reason: "PIN が違います" });
  appendPinLedger({ outcome: "ok", nonce: "n2", kind: "outbound", hash: "h2" });
  const path = join(process.env.IDD_STATE_DIR, "pin", "ledger.jsonl");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const entries = readPinLedger();
  assert.deepEqual(entries.map((entry) => entry.nonce), ["n1", "n2"]);
  assert.equal(entries[0].reason, "PIN が違います");
  assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(PIN));
});

test("the card kinds a PIN may sign are the five the confirm stage offers it for", () => {
  // the batch card's one signature over several landings is a landing card too, and shares the card's reason for a PIN
  assert.deepEqual([...PIN_CARD_KINDS].sort(), ["land", "land-batch", "local-complete", "outbound", "ship"]);
  for (const kind of PIN_CARD_KINDS) assert.equal(pinMaySign({ kind }), true, kind);
  assert.equal(pinMaySign({ kind: "idea-exit" }), false);
  assert.equal(pinMaySign({ kind: "register-proof" }), false);
  assert.equal(pinMaySign({ kind: "pin-set" }), false);
  assert.equal(pinMaySign(null), false);
});

test("a key's registration proof can never be completed with a PIN's signature", async () => {
  const auth = await registered();
  const material = await setPin(auth);
  const proof = createRegistrationProof("new-key", "cHVibGlj", "localhost");
  const content = { kind: "register", credentialId: "new-key", publicKey: "cHVibGlj", rpId: "localhost" };
  const refused = await verifyPinProof({ nonce: proof.nonce, proof: { signature: edSign(null, Buffer.from(proof.challenge, "utf8"), material.key).toString("base64url") }, content });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /passkey/);
});

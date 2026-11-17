/**
 * The PIN's door: the state a screen reads (never the PIN), and the two operations that change it. Setting or
 * clearing a PIN moves only on a registered passkey's signature over the operation's own content, so the tests
 * sign with the same software authenticator the passkey tests use, and try the PIN's own proof where it must fail.
 */
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const ROOT = resolve(process.cwd());
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { GET, POST } = await jiti.import("./passkey-pin.ts");
const { createRegistrationOptions, finishRegistration } = await jiti.import("../../../idd-core/src/passkey.ts");
const { softwareAuthenticator } = await import("../../../idd-core/test/passkey-fixture.mjs");

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";
const ITERATIONS = 600_000;
const PIN = "246810";

beforeEach(() => {
  process.env.IDD_STATE_DIR = mkdtempSync(join(tmpdir(), "idd-pin-route-"));
});

const json = (body) => new Request("http://localhost/api/idd/passkey/pin", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const ask = async (body) => { const res = await POST(json(body)); return { status: res.status, body: await res.json() }; };
const status = async () => { const res = await GET(); return { status: res.status, body: await res.json() }; };

async function registerKey() {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID }), name: "test", localScreen: true });
  assert.equal(done.ok, true, done.error);
  return auth;
}

/** the key a screen derives from the PIN; the engine never sees the PIN itself */
function derived(pin = PIN) {
  const salt = Buffer.alloc(16, 3);
  const seed = pbkdf2Sync(pin, salt, ITERATIONS, 32, "sha256");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return { publicKey: spki.subarray(spki.length - 32).toString("base64url"), salt: salt.toString("base64url"), iterations: ITERATIONS };
}

const setMaterial = () => derived();

async function setPin(auth) {
  const material = setMaterial();
  const started = await ask({ step: "options", op: "set", ...material });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const assertion = auth.assertion({ challenge: String(started.body.challenge), origin: ORIGIN, rpId: RP_ID });
  const done = await ask({ step: "finish", op: "set", ...material, nonce: started.body.nonce, assertion });
  return { started, done, material };
}

test("no PIN is set on a fresh state, and the answer names the material a screen derives from", async () => {
  const answer = await status();
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.configured, false);
  assert.equal(answer.body.digits, 6);
  assert.equal(answer.body.defaultKdf.iterations, ITERATIONS);
  assert.equal(answer.body.publicKey, undefined);
  assert.equal(answer.body.salt, undefined);
});

test("setting a PIN needs a registered passkey: without one the options are refused", async () => {
  const refused = await ask({ step: "options", op: "set", ...setMaterial() });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /passkey/);
});

test("a registered passkey's signature sets the PIN, and the engine then answers its material", async () => {
  const auth = await registerKey();
  const { done, material } = await setPin(auth);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ok, true);
  assert.equal(done.body.configured, true);
  const answer = await status();
  assert.equal(answer.body.configured, true);
  // the material the screen derives from, and never the PIN
  assert.equal(answer.body.publicKey, material.publicKey);
  assert.equal(answer.body.salt, material.salt);
  assert.deepEqual(answer.body.kdf, { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS });
  assert.doesNotMatch(JSON.stringify(answer.body), new RegExp(PIN));
});

test("the PIN's own proof cannot set or clear the PIN: only the passkey's signature does", async () => {
  const auth = await registerKey();
  await setPin(auth);
  const material = derived("111111");
  const started = await ask({ step: "options", op: "set", ...material });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  // the PIN's signature (no assertion) over the PIN operation's own challenge is refused
  const seed = pbkdf2Sync("111111", Buffer.from(material.salt, "base64url"), ITERATIONS, 32, "sha256");
  const { sign } = await import("node:crypto");
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(String(started.body.challenge), "utf8"), key).toString("base64url");
  const refused = await ask({ step: "finish", op: "set", ...material, nonce: started.body.nonce, pinProof: { signature } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /署名/);
  // and clearing it is refused the same way
  const disable = await ask({ step: "options", op: "disable" });
  assert.equal(disable.status, 200);
  const clearTry = await ask({ step: "finish", op: "disable", nonce: disable.body.nonce, pinProof: { signature } });
  assert.equal(clearTry.status, 400);
  const answer = await status();
  assert.equal(answer.body.configured, true, "the PIN was not touched");
});

test("a signature over one PIN's material does not set another", async () => {
  const auth = await registerKey();
  const material = setMaterial();
  const started = await ask({ step: "options", op: "set", ...material });
  const assertion = auth.assertion({ challenge: String(started.body.challenge), origin: ORIGIN, rpId: RP_ID });
  const other = derived("135791");
  const refused = await ask({ step: "finish", op: "set", publicKey: other.publicKey, salt: other.salt, iterations: ITERATIONS, nonce: started.body.nonce, assertion });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /中身/);
});

test("the passkey's signature clears the PIN, and after it no card can be signed with one", async () => {
  const auth = await registerKey();
  await setPin(auth);
  const started = await ask({ step: "options", op: "disable" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const assertion = auth.assertion({ challenge: String(started.body.challenge), origin: ORIGIN, rpId: RP_ID });
  const done = await ask({ step: "finish", op: "disable", nonce: started.body.nonce, assertion });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const answer = await status();
  assert.equal(answer.body.configured, false);
});

test("a PIN record that cannot be read is an error, not an unset PIN", async () => {
  mkdirSync(join(process.env.IDD_STATE_DIR, "pin"), { recursive: true });
  writeFileSync(join(process.env.IDD_STATE_DIR, "pin", "state.json"), "{ broken");
  const answer = await status();
  assert.equal(answer.status, 500);
  assert.equal(answer.body.ok, false);
  assert.match(answer.body.error, /PIN の記録を解析できません/);
});

test("the material the screen sends is checked before any challenge is made", async () => {
  const auth = await registerKey();
  assert.ok(auth.credentialId);
  const shortKey = await ask({ step: "options", op: "set", publicKey: "AAAA", salt: setMaterial().salt, iterations: ITERATIONS });
  assert.equal(shortKey.status, 400);
  assert.match(shortKey.body.error, /公開鍵/);
  const shortSalt = await ask({ step: "options", op: "set", publicKey: setMaterial().publicKey, salt: "AAAA", iterations: ITERATIONS });
  assert.equal(shortSalt.status, 400);
  assert.match(shortSalt.body.error, /salt/);
  const weak = await ask({ step: "options", op: "set", publicKey: setMaterial().publicKey, salt: setMaterial().salt, iterations: 10 });
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /回数/);
});

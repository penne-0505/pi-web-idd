import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const ROOT = resolve(process.cwd());
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { GET, POST } = await jiti.import("./passkey-register.ts");
const { softwareAuthenticator } = await import("../../../idd-core/test/passkey-fixture.mjs");

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";

beforeEach(() => {
  process.env.IDD_STATE_DIR = mkdtempSync(join(tmpdir(), "idd-register-"));
});

const json = (body) => new Request("http://localhost/api/idd/passkey/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const list = async () => (await (await GET()).json()).registered;
const options = async () => (await (await POST(json({ step: "options" }))).json());
const finish = async (body) => POST(json({ step: "finish", ...body }));
const responseOf = (auth, challenge) => auth.registration({ challenge, origin: ORIGIN, rpId: RP_ID });

test("the first passkey registers on its own", async () => {
  assert.deepEqual(await list(), []);
  const auth = softwareAuthenticator();
  const started = await options();
  const done = await finish({ nonce: started.nonce, response: responseOf(auth, String(started.options.challenge)), name: "penne の鍵" });
  assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
  const body = await done.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.registered.map((p) => p.name), ["penne の鍵"]);
  assert.deepEqual((await list()).map((p) => p.name), ["penne の鍵"]);
});

test("a state file that cannot be read is an error, not an empty list of keys", async () => {
  const auth = softwareAuthenticator();
  const started = await options();
  assert.equal((await finish({ nonce: started.nonce, response: responseOf(auth, String(started.options.challenge)), name: "first" })).status, 200);
  writeFileSync(join(process.env.IDD_STATE_DIR, "passkey", "state.json"), "{ broken");
  const res = await GET();
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(String(body.error), /passkey の記録/);
});

test("a second passkey without a signature is refused and stores nothing; with the first key's word it is stored", async () => {
  const first = softwareAuthenticator();
  const start1 = await options();
  assert.equal((await finish({ nonce: start1.nonce, response: responseOf(first, String(start1.options.challenge)), name: "first" })).status, 200);

  const second = softwareAuthenticator();
  const start2 = await options();
  const reg2 = responseOf(second, String(start2.options.challenge));
  const refused = await finish({ nonce: start2.nonce, response: reg2, name: "second" });
  assert.equal(refused.status, 400);
  const refusedBody = await refused.json();
  assert.equal(refusedBody.needsProof, true);
  assert.deepEqual((await list()).map((p) => p.name), ["first"], "the key was not added");
  // the answer carries the challenge the already registered key signs over the new key
  const assertion = first.assertion({ challenge: String(refusedBody.proof.challenge), origin: ORIGIN, rpId: RP_ID });
  const added = await finish({ nonce: start2.nonce, response: reg2, name: "second", proof: { nonce: refusedBody.proof.nonce, assertion } });
  assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
  assert.deepEqual((await list()).map((p) => p.name), ["first", "second"]);
});

test("the options step refuses an RP ID the request's host does not name", async () => {
  process.env.IDD_TAILNET_ORIGINS = "https://pc.example.ts.net:8443";
  // the tailnet RP ID is configured, but this request comes from localhost
  const res = await POST(json({ step: "options", rpId: "pc.example.ts.net" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(String(body.error), /合いません/);
});

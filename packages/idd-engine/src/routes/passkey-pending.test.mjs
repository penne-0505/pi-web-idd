import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const ROOT = resolve(process.cwd());
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { GET, POST } = await jiti.import("./passkey-pending.ts");
const { POST: challengePOST } = await jiti.import("./passkey-challenge.ts");
const { rememberRequestConnection } = await jiti.import("../request-connection.ts");
const { SERVE_FORGED_LOCALHOST_HOST, SERVE_TAILNET_HOST } = await jiti.import("../../test/fixtures/serve-request.ts");
const { createRegistrationOptions, finishRegistration, passkeyCount } = await jiti.import("../../../idd-core/src/passkey.ts");
const { softwareAuthenticator } = await import("../../../idd-core/test/passkey-fixture.mjs");

const TAILNET_ORIGIN = "https://pc.example.ts.net:8443";
const TAILNET_RP_ID = "pc.example.ts.net";
const LOCAL_ORIGIN = "http://localhost:30142";
const LOCAL_RP_ID = "localhost";

beforeEach(() => {
  process.env.IDD_STATE_DIR = mkdtempSync(join(tmpdir(), "idd-pending-route-"));
  process.env.IDD_TAILNET_ORIGINS = TAILNET_ORIGIN;
  delete process.env.IDD_PASSKEY_RP_ID;
});

const localRequest = (path = "/api/idd/passkey/pending") => {
  const req = new Request(`http://localhost${path}`, { headers: { host: "localhost" } });
  rememberRequestConnection(req, "127.0.0.1");
  return req;
};
const listPending = async () => (await (await GET(localRequest())).json()).pending;
const json = (path, body) => new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** a request built from a recorded serve shape, delivered to the loopback listener */
const serveRequest = (fixture, init = {}) => {
  const headers = new Headers({ host: fixture.host });
  for (const [name, value] of Object.entries(fixture.headers)) headers.set(name, value);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const req = new Request("http://localhost/api/idd/passkey/register", {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  rememberRequestConnection(req, "127.0.0.1");
  return req;
};

/** a localhost key registered through the module's own flow */
async function registerLocal() {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions(LOCAL_RP_ID);
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }), name: "penne の鍵", localScreen: true });
  assert.equal(done.ok, true, done.error);
  return auth;
}

/** a tailnet key verified but held pending: its answer carries the challenge a registered key signs */
async function startPending(auth) {
  const { nonce, options } = createRegistrationOptions(TAILNET_RP_ID);
  const response = auth.registration({ challenge: String(options.challenge), origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID });
  const refused = await finishRegistration({ nonce, response, name: "phone", localScreen: false });
  assert.equal(refused.pending, true, refused.error);
  return refused;
}

test("the pending list is empty with no pending registration", async () => {
  assert.deepEqual(await listPending(), []);
});

test("the list door requires a request and does not treat a missing one as local", () => {
  const source = readFileSync(new URL("./passkey-pending.ts", import.meta.url), "utf8");
  assert.match(source, /export async function GET\(req: Request\)/);
  assert.doesNotMatch(source, /export async function GET\(\s*\)/);
});

test("the pending list is refused to a relayed request and leaks no id or challenge", async () => {
  await registerLocal();
  await startPending(softwareAuthenticator());
  const pending = await listPending();
  assert.equal(pending.length, 1);

  for (const fixture of [SERVE_FORGED_LOCALHOST_HOST, SERVE_TAILNET_HOST]) {
    const res = await GET(serveRequest(fixture, { method: "GET" }));
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.equal(text.includes(pending[0].id), false, "the pending id must not leak");
    assert.equal(text.includes(pending[0].challenge), false, "the challenge must not leak");
  }

  // a request a tailnet listener accepted is refused even when its Host names localhost
  const onTailnet = new Request("http://localhost/api/idd/passkey/pending", { headers: { host: "localhost" } });
  rememberRequestConnection(onTailnet, "100.64.0.5");
  assert.equal((await GET(onTailnet)).status, 403);

  const local = await GET(localRequest());
  assert.equal(local.status, 200);
  assert.equal((await local.json()).pending.length, 1);
});

test("the approval door refuses relayed requests, and the local screen approves", async () => {
  const local = await registerLocal();
  const refused = await startPending(softwareAuthenticator());
  const pending = await listPending();
  const assertion = local.assertion({ challenge: refused.proof.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  const body = JSON.stringify({ id: pending[0].id, assertion });

  for (const fixture of [SERVE_FORGED_LOCALHOST_HOST, SERVE_TAILNET_HOST]) {
    const res = await POST(serveRequest(fixture, { body }));
    assert.equal(res.status, 403);
  }
  assert.equal(passkeyCount(), 1);
  assert.equal((await listPending()).length, 1);

  const approved = await POST(json("/api/idd/passkey/pending/approve", { id: pending[0].id, assertion }));
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal(passkeyCount(), 2);
  assert.equal((await listPending()).length, 0);
});

test("a pending key lists its challenge and the approval door registers it", async () => {
  const local = await registerLocal();
  const refused = await startPending(softwareAuthenticator());
  const pending = await listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rpId, TAILNET_RP_ID);
  assert.equal(pending[0].challenge, refused.proof.challenge);
  const assertion = local.assertion({ challenge: refused.proof.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  const res = await POST(json("/api/idd/passkey/pending/approve", { id: pending[0].id, assertion }));
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.credential.name, "phone");
  assert.deepEqual(body.pending, []);
});

test("an approval with the wrong key is refused and leaves the pending list alone", async () => {
  await registerLocal();
  await startPending(softwareAuthenticator());
  const pending = await listPending();
  const stranger = softwareAuthenticator();
  const res = await POST(json("/api/idd/passkey/pending/approve", { id: pending[0].id, assertion: stranger.assertion({ challenge: pending[0].challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }) }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
  assert.equal((await listPending()).length, 1);
});

test("the challenge door refuses an RP ID the settings do not name", async () => {
  const res = await challengePOST(json("/api/idd/passkey/challenge", { action: "s4_verify_clean", rpId: "evil.example", payload: {} }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(String(body.error), /localhost/);
});

test("the challenge door refuses an RP ID the request's host does not name", async () => {
  // the tailnet RP ID is configured, but this request comes from localhost
  const res = await challengePOST(json("/api/idd/passkey/challenge", { action: "s4_verify_clean", rpId: TAILNET_RP_ID, payload: {} }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(String(body.error), /合いません/);
});

test("the approval door refuses a request the tailnet listener accepted", async () => {
  const local = await registerLocal();
  const refused = await startPending(softwareAuthenticator());
  const pending = await listPending();
  const assertion = local.assertion({ challenge: refused.proof.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  // the same approval, carried by a request whose Host is the tailnet: the key stays pending
  const res = await POST(new Request("http://pc.example.ts.net/api/idd/passkey/pending/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "pc.example.ts.net" },
    body: JSON.stringify({ id: pending[0].id, assertion }),
  }));
  assert.equal(res.status, 403);
  assert.equal((await listPending()).length, 1);
});

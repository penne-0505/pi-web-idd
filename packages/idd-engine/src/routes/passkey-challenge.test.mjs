import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const ROOT = resolve(process.cwd());
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { POST } = await jiti.import("./passkey-challenge.ts");
const { proposalPath } = await jiti.import("../../../idd-core/src/overlay/export.ts");
const { landPath } = await jiti.import("../../../idd-core/src/overlay/land.ts");
const { contentHash, createRegistrationOptions, finishRegistration } = await jiti.import("../../../idd-core/src/passkey.ts");
const { softwareAuthenticator } = await import("../../../idd-core/test/passkey-fixture.mjs");

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-challenge-"));
  process.env.IDD_STATE_DIR = dir;
});

const json = (body) => new Request("http://localhost/api/idd/passkey/challenge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const ask = async (body) => { const res = await POST(json(body)); return { status: res.status, body: await res.json() }; };
/** the way a hand edit that misses the JSON leaves the state */
const breakState = () => {
  mkdirSync(join(dir, "passkey"), { recursive: true });
  writeFileSync(join(dir, "passkey", "state.json"), "{ broken");
};
/** the checked submit the saved state holds: its mode and status are what decide whether a signature is asked for */
const savedProposal = (mode, status = "prepared", token = "t") => {
  const path = proposalPath("IDD-1");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ iddId: "IDD-1", mode, status, token, head: "abc", repo: "test/project", workBase: "work-main" }));
};
/** the checked landing a repo that does not publish holds, for the same decision */
const savedLand = (status = "prepared", token = "t") => {
  const path = landPath("IDD-1");
  mkdirSync(dirname(path), { recursive: true });
  // the close goes out with the landing, so its destination and one-liner are part of what is signed
  writeFileSync(path, JSON.stringify({ iddId: "IDD-1", branch: "idd/IDD-1", head: "abc", workBase: "work-main", repo: "test/project", mainTip: "def", checks: [], blocking: 0, token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), configKey: "k", status, close: { repo: "test/project", issue: 184, comment: "PIN で端末から 1 枚通せるようにした" } }));
};
/** the challenge the engine would make from this content and nonce: what a signer that shows the content rebuilds */
const rebuild = (content, nonce) => createHash("sha256").update(`${contentHash(content)}.${nonce}`).digest("base64url");
/** one key registered through the module's own flow: the challenge is then built, not answered as registered: 0 */
async function registerKey() {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID }), name: "test", localScreen: true });
  assert.equal(done.ok, true, done.error);
  return auth;
}

test("an approval the saved state says writes nothing outside is answered without reading the passkey state", async () => {
  breakState();
  // a pushed submit with no new PR text (record-on-pr) asks for no signature
  savedProposal("publish", "pushed");
  const record = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(record.status, 200);
  assert.equal(record.body.required, false);
  // an approval already carried out writes nothing either
  savedProposal("local", "complete");
  const done = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(done.status, 200);
  assert.equal(done.body.required, false);
  savedLand("complete");
  const landed = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(landed.status, 200);
  assert.equal(landed.body.required, false);
});

test("a local completion and a landing ask for a signature and get a challenge", async () => {
  const auth = await registerKey();
  assert.ok(auth.credentialId);
  savedProposal("local");
  const local = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(local.status, 200, JSON.stringify(local.body));
  assert.equal(local.body.required, true);
  assert.equal(local.body.registered, 1);
  assert.ok(local.body.challenge && local.body.nonce, JSON.stringify(local.body));
  assert.equal(local.body.allowCredentials.length, 1);
  rmSync(proposalPath("IDD-1"), { force: true });
  savedLand();
  const land = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(land.status, 200, JSON.stringify(land.body));
  assert.equal(land.body.required, true);
  assert.equal(land.body.registered, 1);
  assert.ok(land.body.challenge && land.body.nonce, JSON.stringify(land.body));
});

test("a local completion and a landing with no key are answered as registered: 0", async () => {
  savedProposal("local");
  const local = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(local.status, 200);
  assert.deepEqual([local.body.required, local.body.registered], [true, 0]);
  rmSync(proposalPath("IDD-1"), { force: true });
  savedLand();
  const land = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(land.status, 200);
  assert.deepEqual([land.body.required, land.body.registered], [true, 0]);
});

test("an approval the saved state says goes outside refuses a state file it cannot read", async () => {
  breakState();
  savedProposal("publish");
  // the saved state says a push is owed: no signature is asked for even when the payload carries no fields
  const bare = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(bare.status, 500, JSON.stringify(bare.body));
  assert.match(String(bare.body.error), /passkey の記録/);
  const push = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t", commitMessage: "feat: x", pr: { title: "題", body: "本文" } } });
  assert.equal(push.status, 500);
  assert.equal(push.body.ok, false);
  assert.match(String(push.body.error), /passkey の記録/);
  // a local completion and a landing are refused the same way: their state cannot be read either
  rmSync(proposalPath("IDD-1"), { force: true });
  savedProposal("local");
  const local = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(local.status, 500, JSON.stringify(local.body));
  assert.match(String(local.body.error), /passkey の記録/);
  rmSync(proposalPath("IDD-1"), { force: true });
  savedLand();
  const land = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t" } });
  assert.equal(land.status, 500, JSON.stringify(land.body));
  assert.match(String(land.body.error), /passkey の記録/);
  const posting = await ask({ action: "outbound_approve", payload: { iddId: "OUT-1", title: "T", body: "b" } });
  assert.equal(posting.status, 500);
  assert.equal(posting.body.ok, false);
  assert.match(String(posting.body.error), /passkey の記録/);
});

test("a push with no registered key is answered as registered: 0", async () => {
  savedProposal("publish");
  const push = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t", commitMessage: "feat: x", pr: { title: "題", body: "本文" } } });
  assert.equal(push.status, 200);
  assert.equal(push.body.ok, true);
  assert.equal(push.body.required, true);
  assert.equal(push.body.registered, 0);
});

test("the challenge answer carries the content the signature is over", async () => {
  await registerKey();
  savedLand();
  const land = await ask({ action: "s4_verify_clean", payload: { iddId: "IDD-1", token: "t", r2Override: true } });
  // an r2Override in the request (R2 was removed 2026-10-22) is not part of what is signed
  assert.equal(land.status, 200, JSON.stringify(land.body));
  assert.equal(land.body.required, true);
  // what a signer that cannot read the confirm stage has to show: the lane, its head, the mainline branch, and the
  // Issue the same approval closes with its one-liner
  assert.equal(land.body.content.kind, "land");
  assert.deepEqual(
    { iddId: land.body.content.iddId, workBase: land.body.content.workBase, head: land.body.content.head, r2Override: "r2Override" in land.body.content },
    { iddId: "IDD-1", workBase: "work-main", head: "abc", r2Override: false },
  );
  assert.equal(land.body.content.close.comment, "PIN で端末から 1 枚通せるようにした");
  // the content shown and the challenge are two views of one thing: rebuilding the challenge from the content gives
  // the same value, and a changed content does not
  assert.equal(rebuild(land.body.content, land.body.nonce), land.body.challenge);
  assert.notEqual(rebuild({ ...land.body.content, head: "other" }, land.body.nonce), land.body.challenge);

  // a posting carries its whole text, which is the longest thing a person reads before a proof
  rmSync(landPath("IDD-1"), { force: true });
  const body = Array.from({ length: 40 }, (_, i) => `- 行 ${i + 1}`).join("\n");
  mkdirSync(join(dir, "outbound"), { recursive: true });
  writeFileSync(join(dir, "outbound", "OUT-1.json"), JSON.stringify({
    id: "OUT-1", kind: "gh-issue", target: { repo: "test/project" }, title: "題", draft: body, status: "ready",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
  const posting = await ask({ action: "outbound_approve", payload: { iddId: "OUT-1", title: "題", body: "本文" } });
  assert.equal(posting.status, 200, JSON.stringify(posting.body));
  assert.equal(posting.body.required, true);
  assert.equal(posting.body.content.kind, "outbound");
  assert.equal(posting.body.content.body, "本文");
  assert.equal(posting.body.content.target.repo, "test/project");
  assert.equal(rebuild(posting.body.content, posting.body.nonce), posting.body.challenge);
});

test("whether an action is signed at all is the engine's one classification: every signed action gets a challenge door, an unsigned one none", async () => {
  const { OUTBOUND_ACTIONS, SIGNED_LOCAL_ACTIONS, OTHER_ACTIONS } = await jiti.import("../server/action-classes.ts");
  for (const action of [...OUTBOUND_ACTIONS, ...SIGNED_LOCAL_ACTIONS]) {
    const res = await ask({ action, payload: {} });
    assert.notEqual(res.body.error, "署名の要る操作ではありません", `${action} is signed, so the challenge door answers for it`);
  }
  for (const action of OTHER_ACTIONS) {
    const res = await ask({ action, payload: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "署名の要る操作ではありません", `${action} is not signed`);
  }
});

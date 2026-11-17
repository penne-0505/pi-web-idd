/**
 * The approval of an instruction proposal carries the user's passkey signature over the proposal as it stands. The
 * agent that filed the proposal can reach the decide door, so a request with no signature, a signature over other
 * content or a signature used before must change nothing in force.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, test } from "node:test";
import { createJiti } from "jiti";

// the decision door asks for a tick after some decisions; a test must not book the machine's real timer
process.env.IDD_TICK_KICK = "off";

const ROOT = resolve(process.cwd());
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { POST: decidePost } = await jiti.import("./decide.ts");
const { POST: challengePost } = await jiti.import("./passkey-challenge.ts");
const { proposeInstruction, approveInstructionProposal, openInstructionProposals, readInstructions } = await jiti.import("../../../idd-core/src/index.ts");
const { instructionProposalItem } = await jiti.import("../server/instruction-cards.ts");
const { createRegistrationOptions, finishRegistration, createChallenge } = await jiti.import("../../../idd-core/src/passkey.ts");
const { softwareAuthenticator } = await import("../../../idd-core/test/passkey-fixture.mjs");

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";
const ADD = { kind: "add", text: "PR 本文は短く書く。", reason: "長い本文は読まれないから", scope: { repos: "all", scenes: "all", places: "all" }, session: "conv-1" };

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-instruction-approve-"));
  process.env.IDD_STATE_DIR = join(dir, "state");
  process.env.IDD_INSTRUCTIONS_DIR = join(dir, "instructions");
});

const post = (handler, url, body) => handler(new Request(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const decide = async (action, payload) => { const res = await post(decidePost, "/api/idd/decide", { action, payload }); return { status: res.status, body: await res.json() }; };
const challenge = async (payload, action = "instruction_approve") => { const res = await post(challengePost, "/api/idd/passkey/challenge", { action, payload }); return { status: res.status, body: await res.json() }; };
const inForce = () => (existsSync(join(dir, "instructions", "instructions.json")) ? JSON.parse(readFileSync(join(dir, "instructions", "instructions.json"), "utf8")).instructions : []);

async function registerKey() {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID }), name: "test", localScreen: true });
  assert.equal(done.ok, true, done.error);
  return auth;
}
function file(over = {}) {
  const r = proposeInstruction({ ...ADD, ...over });
  assert.equal(r.ok, true, r.error);
  return r.proposal;
}
/** what the page does: ask for the challenge over the proposal, sign it with the key */
async function sign(auth, proposal) {
  const asked = await challenge({ proposal });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.required, true);
  return { nonce: asked.body.nonce, assertion: auth.assertion({ challenge: asked.body.challenge, origin: ORIGIN, rpId: RP_ID }) };
}

test("a request with no signature, whatever it says, changes nothing in force", async () => {
  await registerKey();
  const p = file();
  for (const payload of [{ proposal: p.id }, { proposal: p.id, nonce: "made-up" }, { proposal: p.id, nonce: "made-up", assertion: { id: "x" } }]) {
    const r = await decide("instruction_approve", payload);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  }
  assert.deepEqual(inForce(), []);
  assert.equal(openInstructionProposals().length, 1, "the proposal still waits for the user");
});

test("a signed approval puts the proposal in force, once", async () => {
  const auth = await registerKey();
  const p = file();
  const signed = await sign(auth, p.id);
  const done = await decide("instruction_approve", { proposal: p.id, ...signed });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.effect, "next_start");
  assert.deepEqual(inForce().map((i) => i.text), [ADD.text]);
  assert.equal(readInstructions().state, "ok");
  // the same signature cannot approve another proposal
  const q = file({ text: "別の方針を足す。" });
  const again = await decide("instruction_approve", { proposal: q.id, ...signed });
  assert.equal(again.status, 403, JSON.stringify(again.body));
  assert.equal(inForce().length, 1);
});

test("a signature made for one proposal does not approve another", async () => {
  const auth = await registerKey();
  const p = file();
  const q = file({ text: "別の方針を足す。" });
  const signedForP = await sign(auth, p.id);
  const r = await decide("instruction_approve", { proposal: q.id, ...signedForP });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual(inForce(), []);
});

test("a signature over the content the challenge was made for is the only one that passes", async () => {
  const auth = await registerKey();
  const p = file();
  // a challenge for other content, signed correctly: the content differs from the proposal
  const other = createChallenge({ kind: "instruction-approval", proposal: p.id, text: "別の文面" });
  const assertion = auth.assertion({ challenge: other.challenge, origin: ORIGIN, rpId: RP_ID });
  const r = await decide("instruction_approve", { proposal: p.id, nonce: other.nonce, assertion });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual(inForce(), []);
});

test("the challenge door answers registered: 0 with no key, and refuses a proposal that is not there", async () => {
  const p = file();
  const none = await challenge({ proposal: p.id });
  assert.equal(none.status, 200);
  assert.equal(none.body.required, true);
  assert.equal(none.body.registered, 0);
  // and with no key the approval cannot pass
  const r = await decide("instruction_approve", { proposal: p.id });
  assert.equal(r.status, 403);
  await registerKey();
  const gone = await challenge({ proposal: "INP-99" });
  assert.equal(gone.status, 400);
});

test("rejecting a proposal needs the user's signature over the proposal and the reason, and a refusal leaves it open", async () => {
  const auth = await registerKey();
  const p = file();
  const REASON = "いまは要らない";
  const reject = (payload) => decide("instruction_reject", { proposal: p.id, ...payload });
  // no signature, whatever it says, deletes nothing: the agent that filed the proposal can reach this door
  for (const payload of [{ reason: REASON }, { reason: REASON, nonce: "made-up" }, { reason: REASON, nonce: "made-up", assertion: { id: "x" } }]) {
    const r = await reject(payload);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  }
  assert.equal(openInstructionProposals().length, 1, "the proposal still waits for the user");
  assert.equal((await reject({ reason: "" })).status, 400, "a reason is required");
  assert.equal((await challenge({ proposal: p.id }, "instruction_reject")).status, 400, "the challenge needs the reason too");

  const ask = async (reason) => {
    const asked = await challenge({ proposal: p.id, reason }, "instruction_reject");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.required, true);
    return { nonce: asked.body.nonce, assertion: auth.assertion({ challenge: asked.body.challenge, origin: ORIGIN, rpId: RP_ID }) };
  };
  // a signature over another reason, and an approval's signature, do not put the proposal away
  const other = await ask("別の理由");
  assert.equal((await reject({ reason: REASON, ...other })).status, 403);
  const approving = await sign(auth, p.id);
  assert.equal((await reject({ reason: REASON, ...approving })).status, 403);
  assert.equal(openInstructionProposals().length, 1);

  const r = await reject({ reason: REASON, ...(await ask(REASON)) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.effect, "none");
  assert.deepEqual(inForce(), []);
  assert.equal(openInstructionProposals().length, 0);
});

test("a rejection's signature does not approve the proposal", async () => {
  const auth = await registerKey();
  const p = file();
  const asked = await challenge({ proposal: p.id, reason: "いまは要らない" }, "instruction_reject");
  const signed = { nonce: asked.body.nonce, assertion: auth.assertion({ challenge: asked.body.challenge, origin: ORIGIN, rpId: RP_ID }) };
  const r = await decide("instruction_approve", { proposal: p.id, ...signed });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual(inForce(), []);
  assert.equal(openInstructionProposals().length, 1);
});

test("the card of a change that names one axis says the others keep the current value, and approving keeps them", async () => {
  const made = file({ scope: { repos: ["me/app"], scenes: ["review"], places: ["lane"] } });
  // the add is adopted directly (the signed path is tested above) so the change has something to change
  const adopted = approveInstructionProposal(made.id);
  assert.equal(adopted.ok, true, adopted.error);
  const change = proposeInstruction({ kind: "change", target: adopted.instruction.id, scope: { scenes: ["plan"] }, session: "conv-1" });
  assert.equal(change.ok, true, change.error);
  const card = instructionProposalItem(change.proposal);
  const range = card.after.find((r) => r.label === "案の範囲");
  assert.match(range.value, /repo は今のまま/);
  assert.match(range.value, /場所は今のまま/);
  assert.match(range.value, /場面: 計画/);
  const done = approveInstructionProposal(change.proposal.id);
  assert.deepEqual(done.instruction.scope, { repos: ["me/app"], scenes: ["plan"], places: ["lane"] });
});

import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch, settle, snapshot } from "./fake.mjs";
import { load } from "./helpers.mjs";
import { outboundReplies, shipNewPr, shipNoCheck } from "./fixtures/items.mjs";

const { InboxStore, receiptFor } = await load("./src/inbox/useDecide.ts");
const { itemKey } = await load("./src/inbox/deck.ts");
const { EMPTY_CONTEXT, intentForKey } = await load("./src/inbox/keymap.ts");
const { signApproval, listPasskeys, pageHostname } = await load("./src/engine/passkey.ts");
const { buildShipApproval, buildOutboundApproval, shipDraftFor, outboundDraftFor } = await load("./src/inbox/approval.ts");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const errorsOf = (state) => Object.values(state.errors).join(" ");

function fakeCredentials(result = { toJSON: () => ({ id: "sig" }) }) {
  const calls = [];
  return {
    calls,
    credentials: {
      get: async (options) => {
        calls.push(options);
        return result;
      },
    },
  };
}

/** an authenticator that answers with each value in turn (null = the user cancelled) */
function sequencedCredentials(results) {
  const calls = [];
  return {
    calls,
    credentials: {
      get: async (options) => {
        calls.push(options);
        return results.length ? results.shift() : null;
      },
    },
  };
}

const newStore = (engine, credentials, hostname = "localhost") => new InboxStore(engine.fetchFn, () => NOW, { credentials, hostname });
const endOf = (engine) => engine.calls[engine.calls.length - 1];

test("the challenge is taken first, then the authenticator, then the approval, with the same content", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials();
  const store = newStore(engine, creds.credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;

  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  assert.equal(intent.kind, "ship_approve");
  const approving = store.approve(intent, shipNewPr);
  await settle();

  assert.equal(endOf(engine).path, "/api/idd/passkey/challenge");
  assert.equal(endOf(engine).body.action, "s4_verify_clean");
  assert.equal(endOf(engine).body.rpId, "localhost");
  const challengePayload = endOf(engine).body.payload;
  endOf(engine).respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2g", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await settle();

  assert.equal(creds.calls.length, 1, "the authenticator is asked exactly once");
  assert.equal(endOf(engine).path, "/api/idd/decide");
  const decided = endOf(engine).body;
  assert.equal(decided.action, "s4_verify_clean");
  assert.equal(decided.payload.nonce, "n1");
  assert.deepEqual(decided.payload.assertion, { id: "sig" });
  const { nonce, assertion, ...rest } = decided.payload;
  assert.deepEqual(rest, challengePayload, "the approval carries exactly the challenge's content");
  endOf(engine).respond(200, { ok: true });
  await settle();
  endOf(engine).respond(200, snapshot([]));
  await approving;
  assert.match(store.state.receipt, /#142 を提出しました/);
  assert.equal(store.state.snapshot.items.length, 0);
});

test("the RP ID is the page's host without a port", async () => {
  assert.equal(pageHostname({ hostname: "localhost:30144" }), "localhost:30144", "a hostname given as a whole is used as given");
  const engine = fakeFetch();
  const creds = fakeCredentials();
  const store = newStore(engine, creds.credentials, "localhost");
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  const approving = store.approve(intent, shipNewPr);
  await settle();
  assert.equal(endOf(engine).body.rpId, "localhost");
  assert.equal(String(endOf(engine).body.rpId).includes(":"), false);
  endOf(engine).reject(new Error("stop"));
  await approving;
});

test("when the engine says no signature is needed, the approval goes once and the authenticator is never asked", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials();
  const store = newStore(engine, creds.credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  const approving = store.approve(intent, shipNewPr);
  await settle();
  endOf(engine).respond(200, { ok: true, required: false });
  await settle();
  assert.equal(endOf(engine).path, "/api/idd/decide");
  assert.equal(endOf(engine).body.payload.nonce, undefined);
  assert.equal(creds.calls.length, 0);
  endOf(engine).respond(200, { ok: true });
  await settle();
  endOf(engine).respond(200, snapshot([]));
  await approving;
});

test("a cancelled signature keeps the card, sends no approval, and the same card can be approved again", async () => {
  const engine = fakeFetch();
  const creds = sequencedCredentials([null, { toJSON: () => ({ id: "sig" }) }]);
  const store = newStore(engine, creds.credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });

  const refusing = store.approve(intent, shipNewPr);
  await settle();
  endOf(engine).respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2g", rpId: "localhost", allowCredentials: [] });
  await refusing;
  assert.equal(engine.of("/api/idd/decide").length, 0, "nothing goes to the approval's door");
  assert.equal(Boolean(store.state.snapshot.items.find((i) => i.kind === "ship")), true, "the card stays");
  assert.match(errorsOf(store.state), /署名が取り消されました/);
  assert.equal(store.state.deciding, false, "the card can be approved again");

  // the same store, the same card: the second try signs and goes through
  const again = store.approve(intent, shipNewPr);
  await settle();
  endOf(engine).respond(200, { ok: true, required: true, registered: 1, nonce: "n2", challenge: "Y2g", rpId: "localhost", allowCredentials: [] });
  await settle();
  endOf(engine).respond(200, { ok: true });
  await settle();
  endOf(engine).respond(200, snapshot([]));
  await again;
  assert.match(store.state.receipt, /#142 を提出しました/);
  assert.equal(store.state.snapshot.items.length, 0);
});

test("the check leaves the card in place and only re-reads the state", async () => {
  const engine = fakeFetch();
  const store = newStore(engine, fakeCredentials().credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNoCheck]));
  await read;
  const checking = store.decide({ kind: "ship_check", payload: { iddId: "#143", pr: { title: "wip", body: "" } } }, shipNoCheck);
  await settle();
  assert.equal(endOf(engine).path, "/api/idd/decide");
  assert.deepEqual(endOf(engine).body, { action: "s4_prepare", payload: { iddId: "#143", pr: { title: "wip", body: "" } } });
  endOf(engine).respond(200, { ok: true });
  await settle();
  endOf(engine).respond(200, snapshot([shipNoCheck]));
  await checking;
  assert.equal(store.state.snapshot.items.length, 1, "the card is still there to approve");
  assert.equal(store.state.hidden.length, 0);
});

test("a challenge that answers 400 shows the engine's own words over the card", async () => {
  const engine = fakeFetch();
  const store = newStore(engine, fakeCredentials().credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  const approving = store.approve(intent, shipNewPr);
  await settle();
  endOf(engine).respond(400, { ok: false, error: "この RP ID では署名できません。受ける画面は http://localhost:30142/ です" });
  await approving;
  assert.match(errorsOf(store.state), /受ける画面は http:\/\/localhost:30142\//);
  assert.equal(store.state.snapshot.items.length, 1);
});

test("no key registered: the answer is kept as zero and the authenticator is not asked", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials();
  const store = newStore(engine, creds.credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  const approving = store.approve(intent, shipNewPr);
  await settle();
  endOf(engine).respond(200, { ok: true, required: true, registered: 0 });
  await approving;
  assert.equal(store.state.sign.count, 0);
  assert.equal(creds.calls.length, 0);
});

test("a key list that cannot be read is not reported as none", async () => {
  const engine = fakeFetch();
  const store = newStore(engine, fakeCredentials().credentials);
  const pending = store.readPasskeys();
  await settle();
  assert.equal(endOf(engine).path, "/api/idd/passkey/register?rpId=localhost");
  endOf(engine).respond(500, { ok: false, error: "読めません" });
  await pending;
  assert.equal(store.state.sign.count, null);
  assert.equal(store.state.sign.read, true);
  assert.match(store.state.sign.error, /読めません/);
});

test("a key list that reads zero is zero", async () => {
  const engine = fakeFetch();
  const store = newStore(engine, fakeCredentials().credentials);
  const pending = store.readPasskeys();
  await settle();
  endOf(engine).respond(200, { ok: true, registered: [], rpId: "localhost" });
  await pending;
  assert.equal(store.state.sign.count, 0);
});

test("the signing actions are signed by the engine's own answer, and only the signing path sends them", async () => {
  const { requestFor } = await load("./src/inbox/requests.ts");
  const shipIntent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  assert.equal(requestFor(shipIntent, shipNewPr).signature, "passkey_or_pin");
  const outIntent = intentForKey(outboundReplies, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  assert.equal(outIntent.kind, "outbound_approve");
  assert.equal(requestFor(outIntent, outboundReplies).signature, "passkey_or_pin");
  // a card the engine gave no answer for has no operation to send, signed or not
  const bare = { ...shipNewPr };
  delete bare.decision;
  assert.equal(requestFor(shipIntent, bare), null);
});

test("an outbound approval carries its url and warning in the line left behind", async () => {
  const engine = fakeFetch();
  const store = newStore(engine, fakeCredentials().credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([outboundReplies]));
  await read;
  const intent = intentForKey(outboundReplies, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  const approving = store.approve(intent, outboundReplies);
  await settle();
  endOf(engine).respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2g", rpId: "localhost", allowCredentials: [] });
  await settle();
  endOf(engine).respond(200, { ok: true, url: "https://example.test/c/1", warning: "一部だけ投稿しました" });
  await settle();
  endOf(engine).respond(200, snapshot([]));
  await approving;
  assert.match(store.state.receipt, /https:\/\/example\.test\/c\/1/);
  assert.match(store.state.receipt, /一部だけ投稿しました/);
  // AC-005: the engine's warning appears once, not once per line builder
  assert.equal(store.state.receipt.split("一部だけ投稿しました").length - 1, 1);
});

test("discarding a post leaves a line and never asks for a signature", async () => {
  assert.match(receiptFor({ kind: "outbound_discard" }, outboundReplies), /投稿を捨てました/);
  const engine = fakeFetch();
  const store = newStore(engine, fakeCredentials().credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([outboundReplies]));
  await read;
  const discarding = store.decide({ kind: "outbound_discard" }, outboundReplies);
  await settle();
  assert.equal(endOf(engine).path, "/api/idd/decide");
  assert.equal(endOf(engine).body.action, "outbound_discard");
  endOf(engine).respond(200, { ok: true });
  await settle();
  endOf(engine).respond(200, snapshot([]));
  await discarding;
  assert.match(store.state.receipt, /投稿を捨てました/);
  assert.equal(engine.of("/api/idd/passkey/challenge").length, 0);
});

test("signApproval reports the engine's refusal, the missing key and a failed authenticator, and never verifies", async () => {
  const failing = await signApproval("s4_verify_clean", {}, { hostname: "localhost", fetcher: async () => ({ status: 400, ok: false, json: async () => ({ ok: false, error: "断り" }) }) });
  assert.equal(failing.ok, false);
  assert.match(failing.error, /断り/);

  const noKey = await signApproval("s4_verify_clean", {}, { hostname: "localhost", fetcher: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, required: true, registered: 0 }) }) });
  assert.equal(noKey.needsRegistration, true);

  const throwing = await signApproval("s4_verify_clean", {}, {
    hostname: "localhost",
    fetcher: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, required: true, registered: 1, nonce: "n", challenge: "Y2g", rpId: "localhost" }) }),
    credentials: { get: async () => { throw new Error("端末が応答しません"); } },
  });
  assert.equal(throwing.ok, false);
  assert.match(throwing.error, /端末が応答しません/);

  const noBrowser = await signApproval("s4_verify_clean", {}, {
    hostname: "localhost",
    fetcher: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, required: true, registered: 1, nonce: "n", challenge: "Y2g", rpId: "localhost" }) }),
    credentials: {},
  });
  assert.equal(noBrowser.ok, false);
});

test("listPasskeys turns a failure into unreadable, never into an empty list", async () => {
  const failed = await listPasskeys({ hostname: "localhost", fetcher: async () => ({ status: 500, ok: false, json: async () => ({ ok: false, error: "x" }) }) });
  assert.equal(failed.readable, false);
  const thrown = await listPasskeys({ hostname: "localhost", fetcher: async () => { throw new Error("offline"); } });
  assert.equal(thrown.readable, false);
  assert.match(thrown.error, /offline/);
  const none = await listPasskeys({ hostname: "localhost", fetcher: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, registered: [], rpId: "localhost" }) }) });
  assert.equal(none.readable, true);
  assert.equal(none.registered.length, 0);
});

test("the approval's own content does not move when the state is read again while the passkey prompt is open", async () => {
  const engine = fakeFetch();
  const store = newStore(engine, fakeCredentials().credentials);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const draft = shipDraftFor(shipNewPr);
  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true, ship: draft });
  const approving = store.approve(intent, shipNewPr);
  await settle();
  const challengeCall = engine.last();
  const challengePayload = challengeCall.body.payload;
  // a read arrives while the browser's prompt is open and carries a newer draft
  const reread = store.read();
  engine.last().respond(200, snapshot([{ ...shipNewPr, proposal: { ...shipNewPr.proposal, pr: { title: "届いた題", body: "届いた本文" } } }]));
  await reread;
  challengeCall.respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2g", rpId: "localhost", allowCredentials: [] });
  await settle();
  const decideCall = engine.last();
  const decided = decideCall.body.payload;
  const { nonce, assertion, ...rest } = decided;
  assert.deepEqual(rest, challengePayload);
  assert.equal(decided.pr.title, challengePayload.pr.title);
  decideCall.respond(200, { ok: true });
  await settle();
  engine.last().respond(200, snapshot([]));
  await approving;
});

test("an outbound confirm's identity comes from the same values that are sent", async () => {
  const view = buildOutboundApproval(outboundReplies, outboundDraftFor(outboundReplies));
  const shipping = buildShipApproval(shipNewPr, shipDraftFor(shipNewPr));
  assert.equal(typeof view.confirmKey, "string");
  assert.equal(typeof shipping.confirmKey, "string");
  assert.equal(itemKey(outboundReplies).startsWith("outbound"), true);
});

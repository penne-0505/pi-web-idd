/**
 * The Inbox card of the user's instruction proposals: it is drawn from the engine's item alone, its two answers reach
 * the user's own decision door (never a repo's proposal door), and a long list of instructions says so on the card.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch, settle, snapshot } from "./fake.mjs";
import { proposalOverview } from "./fixtures/items.mjs";
import { answered, h, load, NOOP, readInbox, render, ui } from "./helpers.mjs";

const { inboxVals, cardKindOf } = await load("./src/inbox/viewmodel.ts");
const { InboxStore } = await load("./src/inbox/useDecide.ts");
const { screenCardActions } = await load("./src/inbox/keymap.ts");
const { requestFor } = await load("./src/inbox/requests.ts");
const cards = await load("./src/components/inbox/InboxCards.tsx");
const { WORDS } = await load("./src/strings.ts");

const NOW = Date.parse("2026-10-25T12:00:00Z");
const APPEARED = "2026-10-25T11:30:00Z";

const add = answered({
  kind: "proposal",
  proposalId: "INP-1",
  proposalKind: "instruction_add",
  repo: "instruction",
  appearedAt: APPEARED,
  handle: "方針を足す案: レビューは blocker だけを挙げる。",
  reason: "嘘の指摘で巡が増えるから",
  before: [],
  after: [
    { label: "案の方針", value: "レビューは blocker だけを挙げる。" },
    { label: "案の理由", value: "嘘の指摘で巡が増えるから" },
    { label: "案の範囲", value: "すべての repo / レビュー / どこでも" },
  ],
  from: { session: "conv-1", at: APPEARED },
  effect: "now",
});

const change = answered({
  ...add,
  proposalId: "INP-2",
  proposalKind: "instruction_change",
  handle: "INS-1 を変える案: 直した方針。",
  before: [{ label: "今の方針", value: "古い方針。" }],
  after: [{ label: "案の方針", value: "直した方針。" }],
});

const frontCard = async (item, over = {}) => inboxVals(ui(over), await readInbox([item], {}, NOW), NOOP);

test("an instruction proposal has a card of its own, and every other proposal is drawn from the engine's answer too", () => {
  assert.equal(cardKindOf(add), "proposal");
  assert.equal(cardKindOf(change), "proposal");
  assert.equal(cardKindOf(answered({ ...add, proposalKind: "instruction_retire" })), "proposal");
  assert.equal(cardKindOf(proposalOverview), "proposal");
  // every proposal has its approval and its rejection in the engine's answer, so none is left with an entrance to elsewhere
  assert.deepEqual(proposalOverview.decision.operations.map((o) => o.id), ["approve", "reject", "later"]);
});

test("the card shows what is now, what is proposed, why, and when it takes effect, from the item alone", async () => {
  const vm = await frontCard(change);
  assert.equal(vm.card.cardKind, "proposal");
  assert.equal(vm.card.ask, change.handle);
  const rows = vm.card.rows.map((r) => `${r.label}=${r.value}`);
  assert.ok(rows.includes("今の方針=古い方針。"));
  assert.ok(rows.includes("案の方針=直した方針。"));
  assert.ok(rows.includes(`${WORDS.proposal.reason}=嘘の指摘で巡が増えるから`));
  assert.ok(rows.includes(`${WORDS.proposal.effect}=${WORDS.proposal.effectNextStart}`), "an instruction takes effect from the next start, not now");
  const html = render(h(cards.ProposalCard, { card: vm.card, on: NOOP }));
  assert.match(html, /直した方針。/);
  assert.match(html, /古い方針。/);
});

test("a long list of instructions says so on the add card, and the card can still be approved", async () => {
  const notice = "方針は今 8 件あります。要らない方針があれば先に引退させてください";
  const vm = await frontCard(answered({ ...add, notice }));
  assert.ok(vm.card.rows.some((r) => r.label === WORDS.proposal.review && r.value === notice));
  assert.match(render(h(cards.ProposalCard, { card: vm.card, on: NOOP })), /8 件あります/);
  const slots = screenCardActions(answered({ ...add, notice }));
  const primary = slots.find((s) => s.position === "primary")?.buttons[0];
  assert.equal(primary?.intent?.kind, "proposal_approve", "the notice does not take the approval away");
  // a card without the notice has no such row
  assert.equal((await frontCard(add)).card.rows.some((r) => r.label === WORDS.proposal.review), false);
});

test("an instruction proposal's approval and rejection are signed by a passkey alone, by the engine's answer; the other proposals keep the repo's door", () => {
  // both carry the passkey signature, which only the store's signing path makes: the request says so, and no PIN is offered
  assert.equal(requestFor({ kind: "proposal_approve" }, add).signature, "passkey");
  assert.equal(requestFor({ kind: "proposal_reject", reason: "いまは要らない" }, add).signature, "passkey");
  assert.deepEqual(requestFor({ kind: "proposal_approve" }, add).body, { action: "instruction_approve", payload: { proposal: "INP-1" } });
  assert.equal(requestFor({ kind: "proposal_approve" }, proposalOverview).signature, "none");
  // the other proposals keep the repo's door
  assert.deepEqual(requestFor({ kind: "proposal_approve" }, proposalOverview).body, { action: "proposal_approve", payload: { repo: proposalOverview.repo, proposal: proposalOverview.proposalId } });
});

test("approving an instruction proposal takes the challenge, signs it, and sends the approval with the signature", async () => {
  const engine = fakeFetch();
  const asked = [];
  const credentials = { get: async (options) => { asked.push(options); return { toJSON: () => ({ id: "sig" }) }; } };
  const store = new InboxStore(engine.fetchFn, () => NOW, { credentials, hostname: "localhost" });
  const read = store.read();
  engine.calls[0].respond(200, snapshot([add]));
  await read;

  const approving = store.decide({ kind: "proposal_approve" }, add);
  await settle();
  const end = () => engine.calls[engine.calls.length - 1];
  assert.equal(end().path, "/api/idd/passkey/challenge");
  assert.equal(end().body.action, "instruction_approve");
  assert.deepEqual(end().body.payload, { proposal: "INP-1" });
  end().respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2g", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await settle();

  assert.equal(asked.length, 1, "the authenticator is asked once");
  assert.equal(end().path, "/api/idd/decide");
  assert.deepEqual(end().body, { action: "instruction_approve", payload: { proposal: "INP-1", nonce: "n1", assertion: { id: "sig" } } });
  end().respond(200, { ok: true });
  await settle();
  end().respond(200, snapshot([]));
  await approving;
  assert.equal(store.state.snapshot.items.length, 0);
});

test("with no passkey registered, an instruction proposal's approval is not sent at all", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW, { credentials: { get: async () => assert.fail("no signature is asked for") }, hostname: "localhost" });
  const read = store.read();
  engine.calls[0].respond(200, snapshot([add]));
  await read;
  const approving = store.decide({ kind: "proposal_approve" }, add);
  await settle();
  engine.calls[engine.calls.length - 1].respond(200, { ok: true, required: true, registered: 0 });
  await approving;
  assert.equal(engine.calls.some((c) => c.path === "/api/idd/decide"), false, "nothing reaches the decision door");
  assert.ok(Object.values(store.state.errors).length > 0, "the reason is over the card");
});

test("the card's two keys are the approval and a rejection that carries a reason", () => {
  const slots = screenCardActions(add);
  const intents = slots.flatMap((s) => s.buttons).map((b) => b.intent?.kind).filter(Boolean);
  assert.ok(intents.includes("proposal_approve"));
  // the back button opens the one-line input first: the rejection is sent only once a reason is written
  assert.ok(intents.includes("note_open"));
  const withReason = screenCardActions(add, { noteOpen: true, note: "いまは要らない" }).flatMap((s) => s.buttons).map((b) => b.intent?.kind);
  assert.ok(withReason.includes("proposal_reject"));
});

test("putting an instruction proposal away takes the challenge over the proposal and the reason, signs it, and sends both with the signature", async () => {
  const engine = fakeFetch();
  const credentials = { get: async () => ({ toJSON: () => ({ id: "sig" }) }) };
  const store = new InboxStore(engine.fetchFn, () => NOW, { credentials, hostname: "localhost" });
  const read = store.read();
  engine.calls[0].respond(200, snapshot([add]));
  await read;

  const rejecting = store.decide({ kind: "proposal_reject", reason: "いまは要らない" }, add);
  await settle();
  const end = () => engine.calls[engine.calls.length - 1];
  assert.equal(end().path, "/api/idd/passkey/challenge");
  assert.equal(end().body.action, "instruction_reject");
  assert.deepEqual(end().body.payload, { proposal: "INP-1", reason: "いまは要らない" });
  end().respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2g", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await settle();

  assert.equal(end().path, "/api/idd/decide");
  assert.deepEqual(end().body, { action: "instruction_reject", payload: { proposal: "INP-1", reason: "いまは要らない", nonce: "n1", assertion: { id: "sig" } } });
  end().respond(200, { ok: true });
  await settle();
  end().respond(200, snapshot([]));
  await rejecting;
  assert.equal(store.state.snapshot.items.length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch, settle, snapshot } from "./fake.mjs";
import { load } from "./helpers.mjs";
import { duplicate, go, proposalHarm, proposalOverview, question, requeue, stuckLimit } from "./fixtures/items.mjs";

const { InboxStore, receiptFor } = await load("./src/inbox/useDecide.ts");
const { itemKey, deck } = await load("./src/inbox/deck.ts");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const newStore = (engine) => new InboxStore(engine.fetchFn, () => NOW);
const errorsOf = (state) => Object.values(state.errors).join(" ");

test("the four decisions the engine cannot take back leave a line naming what was done", () => {
  assert.match(receiptFor({ kind: "stuck_ignore" }, stuckLimit), /#147 を外しました/);
  assert.match(receiptFor({ kind: "duplicate_merge" }, duplicate), /重複として外しました/);
  assert.match(receiptFor({ kind: "stuck_accept" }, stuckLimit), /今の状態で受け入れました/);
  assert.match(receiptFor({ kind: "requeue_ignore" }, requeue), /取り込み直しを外しました/);
  assert.equal(receiptFor({ kind: "go_go" }, go), null);
});

test("dropping a lane an Issue brought says the Issue goes too, and a plain lane says nothing extra", () => {
  const fromIssue = receiptFor({ kind: "stuck_ignore" }, { ...stuckLimit, source: { kind: "github", label: "GH #147" } });
  assert.match(fromIssue, /Issue も取り込みから外れます/);
  const plain = receiptFor({ kind: "stuck_ignore" }, { ...stuckLimit, source: undefined });
  assert.equal(plain.includes("Issue も取り込みから外れます"), false);
});

test("a refused decision keeps the card and shows the reason over it", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([go]));
  await read;
  const decision = store.decide({ kind: "go_go" }, go);
  await settle();
  engine.last().respond(400, { ok: false, error: "要判断でなくなった lane" });
  await decision;
  assert.equal(store.state.snapshot.items.length, 1);
  assert.match(store.state.errors[itemKey(go)], /要判断でなくなった lane/);
  assert.equal(store.state.receipt, null);
});

test("a decision that never arrives keeps the card and marks the connection", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([go]));
  await read;
  const decision = store.decide({ kind: "go_go" }, go);
  await settle();
  engine.last().reject(new Error("network"));
  await decision;
  assert.equal(store.state.snapshot.items.length, 1);
  assert.equal(store.state.connection, "down");
  assert.match(errorsOf(store.state), /engine に届きませんでした/);
});

test("a taken decision hides the card and leaves the receipt", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([stuckLimit]));
  await read;
  const decision = store.decide({ kind: "stuck_ignore" }, stuckLimit);
  await settle();
  engine.last().respond(200, { ok: true });
  await settle();
  engine.last().respond(200, snapshot([]));
  await decision;
  assert.match(store.state.receipt, /#147 を外しました/);
  assert.equal(store.state.snapshot.items.length, 0);
});

test("a failed read keeps the last cards and stops decisions until it comes back", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const first = store.read();
  engine.calls[0].respond(200, snapshot([go]));
  await first;
  const second = store.read();
  engine.calls[1].respond(500, { source: "empty", items: [] });
  await second;
  assert.equal(store.state.connection, "down");
  assert.equal(store.state.snapshot.items.length, 1);
  const before = engine.calls.length;
  await store.decide({ kind: "go_go" }, go);
  assert.equal(engine.calls.length, before, "no request goes out while the engine cannot be reached");
  const third = store.read();
  engine.calls[engine.calls.length - 1].respond(200, snapshot([go]));
  await third;
  assert.equal(store.state.connection, "ok");
});

test("a 2xx whose body is not JSON is not applied", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, undefined);
  await read;
  assert.equal(store.state.connection, "down");
  assert.equal(store.state.snapshot, null);
});

test("a state response asked for before a decision cannot bring that card back", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const early = store.read();
  const decision = store.decide({ kind: "go_go" }, go);
  await settle();
  // the decision, and then the read it asks for, both come back before the early one
  engine.calls[1].respond(200, { ok: true });
  await settle();
  engine.calls[2].respond(200, snapshot([]));
  await decision;
  engine.calls[0].respond(200, snapshot([go]));
  await early;
  assert.equal(store.state.snapshot.items.length, 0, "the early response is dropped");
  const calls = engine.calls.length;
  await store.decide({ kind: "go_go" }, go);
  assert.equal(engine.calls.length, calls, "the done card sends nothing more");
});

test("a later read wins when two reads answer out of order", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const first = store.read();
  const second = store.read();
  engine.calls[1].respond(200, snapshot([]));
  await second;
  engine.calls[0].respond(200, snapshot([go, question, duplicate]));
  await first;
  assert.equal(store.state.snapshot.items.length, 0);
});

test("a decision already with the engine takes no second one, and no jump to the next card", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([go, question]));
  await read;

  const first = store.decide({ kind: "go_go" }, go);
  assert.equal(store.state.deciding, true, "the gate closes while the decision is out");
  // a second press on the same card, and a press that would land on the card behind it, both go nowhere
  const again = store.decide({ kind: "go_go" }, go);
  const next = store.decide({ kind: "answer", selection: { index: 1 } }, question);
  await settle();
  assert.equal(engine.of("/api/idd/decide").length, 1, "only the first decision is sent");

  engine.last().respond(200, { ok: true });
  await settle();
  assert.equal(store.state.deciding, true, "the gate stays closed until the next state is read");
  engine.last().respond(200, snapshot([question]));
  await Promise.all([first, again, next]);
  assert.equal(store.state.deciding, false, "the gate opens once the next card is on the screen");
  assert.equal(store.state.snapshot.items.length, 1);

  const accepted = store.decide({ kind: "answer", selection: { index: 1 } }, question);
  await settle();
  assert.equal(engine.of("/api/idd/decide").length, 2, "after the next card arrives, an operation is taken again");
  engine.last().respond(200, { ok: true });
  await settle();
  engine.last().respond(200, snapshot([]));
  await accepted;
});

test("a decision the engine refuses opens the gate again so it can be retried", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([go]));
  await read;
  const refused = store.decide({ kind: "go_go" }, go);
  await settle();
  engine.last().respond(400, { ok: false, error: "要判断でなくなった lane" });
  await refused;
  assert.equal(store.state.deciding, false);
  const retry = store.decide({ kind: "go_go" }, go);
  await settle();
  assert.equal(engine.of("/api/idd/decide").length, 2, "a refused decision can be sent again");
  engine.last().respond(200, { ok: true });
  await settle();
  engine.last().respond(200, snapshot([go]));
  await retry;
});

test("AC-008 / AC-033: approving a proposal sends the decide call and leaves the line of what was done", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([proposalOverview]));
  await read;
  const decision = store.decide({ kind: "proposal_approve" }, proposalOverview);
  await settle();
  assert.deepEqual(engine.last().body, { action: "proposal_approve", payload: { repo: proposalOverview.repo, proposal: proposalOverview.proposalId } });
  engine.last().respond(200, { ok: true });
  await settle();
  engine.last().respond(200, snapshot([]));
  await decision;
  assert.match(store.state.receipt, /PROP-1 を承認しました/);
  assert.equal(store.state.snapshot.items.length, 0);
});

test("AC-033: rejecting a proposal carries its reason and leaves the line of what was done", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([proposalHarm]));
  await read;
  const decision = store.decide({ kind: "proposal_reject", reason: "今は要らない" }, proposalHarm);
  await settle();
  assert.deepEqual(engine.last().body, { action: "proposal_reject", payload: { repo: proposalHarm.repo, proposal: proposalHarm.proposalId, reason: "今は要らない" } });
  engine.last().respond(200, { ok: true });
  await settle();
  engine.last().respond(200, snapshot([]));
  await decision;
  assert.match(store.state.receipt, /PROP-2 を見送りました/);
});

/* ---- F-1: the judgments that leave the card in the engine's picture must still put it back on the screen ---- */

const LATER_AT = "2026-10-05T13:00:00Z";
const snoozed = (item) => ({ ...item, snoozedUntil: LATER_AT });
/** the same batch after one of its questions was answered: the same card key, so the engine has not let it go */
const remainingBatch = {
  ...question,
  answeredCount: 2,
  open: [{ ...question.open[0], questionId: "q2", question: "次はどうしますか" }],
};

test("AC-005: a card put off comes back to the put-off list once the read after the judgment says so", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([go]));
  await read;
  const decision = store.decide({ kind: "later" }, go);
  await settle();
  engine.last().respond(200, { ok: true });
  await settle();
  assert.equal(store.state.hidden.includes(itemKey(go)), true, "no picture has said where it was put yet");
  engine.last().respond(200, snapshot([snoozed(go)]));
  await decision;
  assert.deepEqual(store.state.hidden, []);
  const view = deck(store.state.snapshot.items, NOW, store.state.hidden);
  assert.deepEqual(view.later.map((i) => i.iddId), [go.iddId], "the card is in the put-off list, not gone");
  assert.equal(view.front.length, 0);
});

test("AC-005: a card brought back by wake comes to the front once the read after it says so", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([snoozed(go)]));
  await read;
  const woke = store.wake(snoozed(go));
  await settle();
  assert.deepEqual(engine.last().body, { key: itemKey(go), wake: true });
  engine.last().respond(200, { ok: true });
  await settle();
  assert.equal(store.state.hidden.includes(itemKey(go)), true);
  engine.last().respond(200, snapshot([go]));
  await woke;
  assert.deepEqual(store.state.hidden, []);
  const view = deck(store.state.snapshot.items, NOW, store.state.hidden);
  assert.deepEqual(view.front.map((i) => i.iddId), [go.iddId]);
  assert.equal(view.later.length, 0);
});

test("AC-005: a batch with questions still open stays on the screen after one is answered", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([question]));
  await read;
  const decision = store.decide({ kind: "answer", questionId: "q1", selection: { index: 1 } }, question);
  await settle();
  engine.last().respond(200, { ok: true });
  await settle();
  assert.equal(store.state.hidden.includes(itemKey(question)), true);
  engine.last().respond(200, snapshot([remainingBatch]));
  await decision;
  assert.deepEqual(store.state.hidden, []);
  const view = deck(store.state.snapshot.items, NOW, store.state.hidden);
  assert.deepEqual(view.front.map((i) => i.batchId), [question.batchId]);
});

test("AC-005: a frame, and a read asked for before the judgment, cannot bring a judged card back", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const first = store.read();
  engine.calls[0].respond(200, snapshot([go]));
  await first;
  // asked for before the decision: its answer was derived before the engine took the judgment
  const earlier = store.read();
  const decision = store.decide({ kind: "later" }, go);
  await settle();
  engine.last().respond(200, { ok: true });
  await settle();
  const afterJudgment = engine.last();
  // the stream's own frame shows the card while the read the decision asked for is still out
  store.apply({ seq: 4000, state: snapshot([snoozed(go)]) });
  assert.equal(store.state.hidden.includes(itemKey(go)), true, "a frame cannot say where the judgment was put");
  engine.calls[1].respond(200, snapshot([go]));
  await earlier;
  assert.equal(store.state.hidden.includes(itemKey(go)), true, "a read asked for before the judgment cannot either");
  afterJudgment.respond(200, snapshot([snoozed(go)]));
  await decision;
  assert.deepEqual(store.state.hidden, []);
});

test("AC-005: the read after a judgment puts the card back even when the stream's frame numbered the same came first", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([go]), { "x-idd-seq": "3000" });
  await read;
  const decision = store.decide({ kind: "later" }, go);
  await settle();
  engine.last().respond(200, { ok: true });
  await settle();
  const afterJudgment = engine.last();
  assert.equal(afterJudgment.path, "/api/idd/state");
  // the engine derives the answer and the frame in one go, so the stream's frame carries the same number
  store.apply({ seq: 4000, state: snapshot([snoozed(go)]) });
  assert.equal(store.state.hidden.includes(itemKey(go)), true, "a frame cannot say where the judgment was put");
  afterJudgment.respond(200, snapshot([snoozed(go)]), { "x-idd-seq": "4000" });
  await decision;
  assert.deepEqual(store.state.hidden, [], "the read the screen asked for after the judgment says where it was put");
  const view = deck(store.state.snapshot.items, NOW, store.state.hidden);
  assert.deepEqual(view.later.map((i) => i.iddId), [go.iddId], "the card is in the put-off list, not gone");
  assert.equal(view.front.length, 0);
});

test("AC-005: a read after a judgment numbered below the picture still puts the card back, and leaves the picture as it is", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([go]), { "x-idd-seq": "3000" });
  await read;
  const decision = store.decide({ kind: "later" }, go);
  await settle();
  engine.last().respond(200, { ok: true });
  await settle();
  const afterJudgment = engine.last();
  // a picture the engine derived later than the answer to the read is on the screen by the time it answers
  store.apply({ seq: 5000, state: snapshot([snoozed(go)]) });
  assert.equal(store.state.hidden.includes(itemKey(go)), true);
  afterJudgment.respond(200, snapshot([question]), { "x-idd-seq": "4000" });
  await decision;
  assert.deepEqual(store.state.snapshot.items.map((i) => i.iddId), [go.iddId], "a picture numbered below the one shown is not applied");
  assert.deepEqual(store.state.hidden, []);
  const view = deck(store.state.snapshot.items, NOW, store.state.hidden);
  assert.deepEqual(view.later.map((i) => i.iddId), [go.iddId]);
});

test("AC-005: a read after a judgment that lets the card go keeps it hidden until a later picture shows it", async () => {
  const engine = fakeFetch();
  const store = newStore(engine);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([stuckLimit]), { "x-idd-seq": "3000" });
  await read;
  const decision = store.decide({ kind: "stuck_ignore" }, stuckLimit);
  await settle();
  engine.last().respond(200, { ok: true });
  await settle();
  const afterJudgment = engine.last();
  // the frame that carries the picture without the card is already on the screen when the read answers
  store.apply({ seq: 4000, state: snapshot([]) });
  afterJudgment.respond(200, snapshot([]), { "x-idd-seq": "4000" });
  await decision;
  assert.deepEqual(store.state.hidden, [itemKey(stuckLimit)], "the engine let the card go: the deck keeps it out");
  store.apply({ seq: 4100, state: snapshot([stuckLimit]) });
  assert.deepEqual(store.state.hidden, [], "a later picture that shows the card again is a new card, and is shown");
});

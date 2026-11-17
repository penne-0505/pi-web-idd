import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";
import { fakeFetch, fakeStreams } from "./fake.mjs";

const { ChatStore } = await load("./src/chat/store.ts");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** one idea document status with only the fields the store reads; every value is the engine's */
function document(over = {}) {
  return {
    path: "/i/idea.md",
    slug: "t",
    status: "探索",
    target: null,
    createdAt: null,
    frozenAt: null,
    stage: "探索",
    frozen: false,
    frozenIntact: false,
    sections: [],
    undecided: [],
    gates: [],
    exits: [],
    places: [],
    exitsReadable: true,
    unreadable: [],
    ...over,
  };
}

function row(over = {}) {
  return {
    id: "EXIT-1",
    title: "Issue を起票する",
    effect: "外へ出る",
    operation: "issues",
    target: "penne-0505/pi-web",
    reversibility: "戻せない",
    state: "下書き",
    result: "",
    readable: true,
    issues: [{ id: "EXIT-1-1", title: "本文", depends: [], labels: [], body: "本文", number: null, result: "" }],
    ...over,
  };
}

const SUMMARY = { total: 1, outbound: 1, local: 0, irreversible: 1, interrupted: 0 };
const OK_CREDENTIALS = { get: async () => ({ toJSON: () => ({ id: "sig" }) }) };

function manualCredentials() {
  let settleFn;
  const creds = { get: () => new Promise((resolve) => { settleFn = resolve; }) };
  return { creds, answer: () => settleFn({ toJSON: () => ({ id: "sig" }) }) };
}

function makeStore(passkeyDeps = {}) {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open, () => 0, null, { fetcher: f.fetchFn, hostname: "localhost", ...passkeyDeps });
  return { f, s, store };
}

function openBody(over = {}) {
  return { ok: true, entries: [], leafId: null, queue: [], streaming: false, ...over };
}

/** select a conversation and answer both doors with the given document */
async function open(store, f, id, doc = document()) {
  const pending = store.select(id);
  f.of(`/api/conversations/${id}/idea`)[0].respond(200, { ok: true, document: doc, ...(doc === null ? { reason: "アイデア文書がありません" } : {}) });
  f.of(`/api/conversations/${id}`)[0].respond(200, openBody());
  await pending;
  await settle();
}

const gatesPath = (id) => `/api/conversations/${id}/idea/gates`;
const challengePath = (id) => `/api/conversations/${id}/idea/exits/challenge`;
const runPath = (id) => `/api/conversations/${id}/idea/exits/run`;
const ideaPath = (id) => `/api/conversations/${id}/idea`;

const challengeOk = (rows = [row()]) => ({ ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2g", rpId: "localhost", allowCredentials: [], summary: SUMMARY, rows });

test("AC-006: opening reads the document, and a null document leaves the idea view empty", async () => {
  const { f, store } = makeStore();
  await open(store, f, "c1", document({ stage: "ゲート1" }));
  assert.equal(store.state.open.idea.document.stage, "ゲート1");
  await open(store, f, "c2", null);
  assert.equal(store.state.open.idea.document, null);
  assert.match(store.state.open.idea.reason ?? "", /文書/);
});

test("AC-013: two presses send one gate approval", async () => {
  const { f, store } = makeStore();
  await open(store, f, "c1");
  void store.approveGate(1);
  void store.approveGate(1);
  assert.equal(f.of(gatesPath("c1")).length, 1);
  f.of(gatesPath("c1"))[0].respond(200, { ok: true, gate: 1, action: "approve", document: document() });
  await settle();
  assert.deepEqual(store.state.open.idea.received, { gate: 1 });
  void store.approveGate(1);
  assert.equal(f.of(gatesPath("c1")).length, 1, "after receiving, no further approval goes");
});

test("AC-014: a refused gate keeps the document and shows the engine's reason", async () => {
  const { f, store } = makeStore();
  await open(store, f, "c1");
  void store.approveGate(1);
  f.of(gatesPath("c1"))[0].respond(409, { ok: false, error: "ゲート 1 の承認がありません" });
  await settle();
  assert.equal(store.state.open.idea.gateError, "ゲート 1 の承認がありません");
  assert.equal(store.state.open.idea.received, null);
  assert.equal(store.state.open.idea.document.gates.length, 0);
});

test("AC-015: a received gate is not drawn as a line until the run's end rereads the record", async () => {
  const { f, s, store } = makeStore();
  await open(store, f, "c1");
  void store.approveGate(1);
  const record = { gate: 1, date: "2026-10-05", action: "approve", entryId: null, stage: "ゲート1" };
  f.of(gatesPath("c1"))[0].respond(200, { ok: true, gate: 1, action: "approve", document: document({ gates: [record], stage: "ゲート1" }) });
  await settle();
  assert.deepEqual(store.state.open.idea.received, { gate: 1 });
  assert.equal(store.state.open.items.some((item) => item.kind === "gate"), false, "the empty position is not drawn at the head");
  assert.equal(store.state.open.idea.document.gates.length, 0, "the status's record is kept out until the run's end");

  const ideaBefore = f.of(ideaPath("c1")).length;
  const openBefore = f.of("/api/conversations/c1").length;
  s.last().emit({ type: "end", reason: "completed" });
  await settle();
  assert.ok(f.of(ideaPath("c1")).length > ideaBefore, "the run's end rereads the status");
  const notice = "ゲート 1 を承認しました。ゲート記録は記入済みです。この承認に沿って続きを進めてください。";
  f.of(ideaPath("c1"))[ideaBefore].respond(200, { ok: true, document: document({ gates: [{ ...record, entryId: "u9" }], stage: "ゲート1" }) });
  f.of("/api/conversations/c1")[openBefore].respond(200, openBody({ entries: [{ id: "u9", parentId: null, type: "message", message: { role: "user", timestamp: "t9", content: notice } }], leafId: "u9" }));
  await settle();
  assert.equal(store.state.open.idea.received, null);
  const line = store.state.open.items.find((item) => item.kind === "gate");
  assert.ok(line, "the record's line is drawn once its position is back");
  assert.equal(line.gate.stage, "ゲート1");
});

test("AC-021/AC-023/AC-024: the challenge takes the page's host, shows its rows, and the run names them", async () => {
  const { f, store } = makeStore({ credentials: OK_CREDENTIALS });
  await open(store, f, "c1", document({ exits: [row()] }));
  const signing = store.signExits();
  await settle();
  const challenge = f.of(challengePath("c1"))[0];
  assert.equal(challenge.body.rpId, "localhost");
  challenge.respond(200, challengeOk([row({ id: "EXIT-CHALLENGE", title: "署名の行" })]));
  await settle();
  assert.equal(store.state.open.idea.challenge.rows[0].id, "EXIT-CHALLENGE");

  const run = f.of(runPath("c1"))[0];
  assert.deepEqual(run.body.rows, ["EXIT-CHALLENGE"], "the run names exactly the challenge's rows");
  assert.equal(run.body.nonce, "n1");
  run.respond(200, { ok: true, outcomes: [{ id: "EXIT-CHALLENGE", state: "実行済み", result: "#101" }], rows: ["EXIT-CHALLENGE"] });
  await settle();
  assert.equal(store.state.open.idea.outcomes[0].result, "#101");
  // the status is reread; the outcomes stay on the block
  f.of(ideaPath("c1"))[1].respond(200, { ok: true, document: document() });
  await signing;
  await settle();
  assert.equal(store.state.open.idea.outcomes[0].result, "#101");
});

test("AC-022: no registered key means the registration note and no run", async () => {
  let asked = false;
  const { f, store } = makeStore({ credentials: { get: async () => { asked = true; return null; } } });
  await open(store, f, "c1", document({ exits: [row()] }));
  const signing = store.signExits();
  await settle();
  f.of(challengePath("c1"))[0].respond(200, { ok: true, required: true, registered: 0, summary: SUMMARY, rows: [row()] });
  await signing;
  await settle();
  assert.match(store.state.open.idea.exitError, /Passkey が未登録/);
  assert.equal(asked, false, "the authenticator is never asked");
  assert.equal(f.of(runPath("c1")).length, 0);
});

test("AC-025: a refused challenge and a refused run show the engine's reason", async () => {
  const { f, store } = makeStore({ credentials: OK_CREDENTIALS });
  await open(store, f, "c1", document({ exits: [row()] }));
  const refused = store.signExits();
  await settle();
  f.of(challengePath("c1"))[0].respond(409, { ok: false, error: "ゲート 2 の凍結を確かめられません" });
  await refused;
  assert.equal(store.state.open.idea.exitError, "ゲート 2 の凍結を確かめられません");
  assert.equal(store.state.open.idea.challenge, null);

  const running = store.signExits();
  await settle();
  f.of(challengePath("c1"))[1].respond(200, challengeOk());
  await settle();
  f.of(runPath("c1"))[0].respond(403, { ok: false, error: "署名を確かめられません" });
  await running;
  assert.equal(store.state.open.idea.exitError, "署名を確かめられません");
});

test("AC-026: while the run's answer is pending a second press sends nothing", async () => {
  const { f, store } = makeStore({ credentials: OK_CREDENTIALS });
  await open(store, f, "c1", document({ exits: [row()] }));
  const running = store.signExits();
  await settle();
  f.of(challengePath("c1"))[0].respond(200, challengeOk());
  await settle();
  assert.equal(f.of(runPath("c1")).length, 1);
  void store.signExits();
  assert.equal(f.of(challengePath("c1")).length, 1, "a second press takes no challenge");
  assert.equal(f.of(runPath("c1")).length, 1, "and sends no second run");
  f.of(runPath("c1"))[0].respond(200, { ok: true, outcomes: [], rows: [] });
  await settle();
  f.of(ideaPath("c1"))[1].respond(200, { ok: true, document: document() });
  await running;
});

test("AC-028: the idea doors never touch the Inbox's own doors", async () => {
  const { f, store } = makeStore({ credentials: OK_CREDENTIALS });
  await open(store, f, "c1", document({ exits: [row()] }));
  const signing = store.signExits();
  await settle();
  f.of(challengePath("c1"))[0].respond(200, challengeOk());
  await settle();
  f.of(runPath("c1"))[0].respond(200, { ok: true, outcomes: [], rows: [] });
  await settle();
  f.of(ideaPath("c1"))[1].respond(200, { ok: true, document: document() });
  await signing;
  await settle();
  assert.equal(f.calls.some((call) => call.path.includes("/api/idd/")), false);
});

test("AC-036: an idea answer for another conversation lands nowhere", async () => {
  const { f, store } = makeStore();
  await open(store, f, "A", document({ slug: "A" }));
  void store.approveGate(1);
  const lateGate = f.of(gatesPath("A"))[0];
  const switching = store.select("B");
  assert.equal(store.state.open.idea.document, null, "selecting clears the idea view");
  f.of(ideaPath("B"))[0].respond(200, { ok: true, document: document({ slug: "B" }) });
  f.of("/api/conversations/B")[0].respond(200, openBody());
  await switching;
  await settle();
  lateGate.respond(200, { ok: true, gate: 1, action: "approve", document: document({ slug: "A2" }) });
  await settle();
  assert.equal(store.state.open.idea.document.slug, "B");
  assert.equal(store.state.open.idea.received, null);
});

test("AC-037: a signature answered after the conversation changed does not run", async () => {
  const manual = manualCredentials();
  const { f, store } = makeStore({ credentials: manual.creds });
  await open(store, f, "A", document({ exits: [row()] }));
  const signing = store.signExits();
  await settle();
  f.of(challengePath("A"))[0].respond(200, challengeOk());
  await settle();
  // the browser's prompt is open: the conversation is changed before it answers
  const switching = store.select("B");
  f.of(ideaPath("B"))[0].respond(200, { ok: true, document: document({ slug: "B" }) });
  f.of("/api/conversations/B")[0].respond(200, openBody());
  await switching;
  await settle();
  manual.answer();
  await signing;
  await settle();
  assert.equal(f.of(runPath("A")).length, 0, "the run of the conversation that is no longer on screen is never sent");
  assert.equal(store.state.open.idea.exitError, null);
});

test("AC-037: a run's answer after the conversation changed does not land on the other conversation", async () => {
  const { f, store } = makeStore({ credentials: OK_CREDENTIALS });
  await open(store, f, "A", document({ exits: [row()] }));
  const signing = store.signExits();
  await settle();
  f.of(challengePath("A"))[0].respond(200, challengeOk());
  await settle();
  const run = f.of(runPath("A"))[0];
  const switching = store.select("B");
  f.of(ideaPath("B"))[0].respond(200, { ok: true, document: document({ slug: "B" }) });
  f.of("/api/conversations/B")[0].respond(200, openBody());
  await switching;
  await settle();
  run.respond(200, { ok: true, outcomes: [{ id: "EXIT-1", state: "実行済み", result: "#1" }], rows: ["EXIT-1"] });
  await signing;
  await settle();
  assert.equal(store.state.open.idea.outcomes, null);
  assert.equal(store.state.open.idea.document.slug, "B");
});

test("F-1: a run's end while a gate approval is in flight keeps the approval and returns busy", async () => {
  const { f, s, store } = makeStore();
  await open(store, f, "c1");
  const approving = store.approveGate(1);
  assert.equal(store.state.open.idea.gateBusy, true);
  // the run that was going ends while the gate door's answer is still on its way: its reread of the status must
  // not be read as a reason to throw the approval away
  s.last().emit({ type: "end", reason: "completed" });
  await settle();
  assert.equal(f.of(ideaPath("c1")).length, 2, "the run's end rereads the status");
  f.of(ideaPath("c1"))[1].respond(200, { ok: true, document: document() });
  f.of("/api/conversations/c1")[1].respond(200, openBody());
  await settle();
  f.of(gatesPath("c1"))[0].respond(200, { ok: true, gate: 1, action: "approve", document: document() });
  await approving;
  await settle();
  assert.deepEqual(store.state.open.idea.received, { gate: 1 }, "the answer that arrived after the run's end is applied");
  assert.equal(store.state.open.idea.gateBusy, false, "the button leaves the busy state");
});

test("F-1: a run's end while the browser's passkey prompt is open keeps the signature and runs", async () => {
  const manual = manualCredentials();
  const { f, s, store } = makeStore({ credentials: manual.creds });
  await open(store, f, "c1", document({ exits: [row()] }));
  const signing = store.signExits();
  await settle();
  f.of(challengePath("c1"))[0].respond(200, challengeOk());
  await settle();
  assert.equal(store.state.open.idea.challenge.rows[0].id, "EXIT-1");
  // the run that was going ends while the browser's own prompt is open
  s.last().emit({ type: "end", reason: "completed" });
  await settle();
  f.of(ideaPath("c1"))[1].respond(200, { ok: true, document: document({ exits: [row()] }) });
  f.of("/api/conversations/c1")[1].respond(200, openBody());
  await settle();
  manual.answer();
  await settle();
  const run = f.of(runPath("c1"))[0];
  assert.ok(run, "the signature still runs: the conversation never changed");
  run.respond(200, { ok: true, outcomes: [{ id: "EXIT-1", state: "実行済み", result: "#7" }], rows: ["EXIT-1"] });
  await signing;
  await settle();
  assert.equal(store.state.open.idea.exitBusy, false, "the block leaves the busy state");
  assert.equal(store.state.open.idea.outcomes[0].result, "#7");
});

/**
 * The side conversations — the BTW branch and the card's consultation — driven the way the screen drives them.
 * The send flow lives in `SideChat.ask` (open when it must, send, and say whether the engine took the words), so
 * these tests call the same code the screen's press calls and never rebuild the flow around `ensure`/`send`. The
 * frame's own values are built with `chatVals` / `consultVals` and rendered, so a reason the engine refused with
 * is checked where it is drawn and the box's words are checked where the screen keeps them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { h, load, render } from "./helpers.mjs";
import { chatGroups, conversation, fakeFetch, fakeStreams, settle } from "./fake.mjs";

const { SideChat, openBranchAt, openConsult } = await load("./src/chat/side.ts");
const { chatVals, consultKey, consultVals, EMPTY_CHAT_UI } = await load("./src/chat/viewmodel.ts");
const { ChatPanel } = await load("./src/components/panels/ChatPanel.tsx");
const { InboxPanel } = await load("./src/components/panels/InboxPanel.tsx");

const noop = () => {};
const NOOP = new Proxy({}, { get: () => noop });

/** a fetch that answers at once from a route table and records what was asked */
function recordingFetch(route) {
  const calls = [];
  const fetchFn = (path, init) => {
    const call = { path, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    const answer = route(path, init) ?? {};
    const status = answer.status ?? 200;
    return Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => answer.body });
  };
  return { fetchFn, calls, of: (path) => calls.filter((call) => call.path === path) };
}

/** the record door's own answer, with the fields the store reads */
function openBody(extra = {}) {
  return { ok: true, mode: "chat", entries: [], leafId: null, queue: [], streaming: false, cost: 0, contextUsage: null, notices: [], models: [], features: { webSearch: false, mcp: false }, ...extra };
}

function openWith(extra = {}) {
  return { id: "b1", mode: "chat", error: null, items: [], queue: [], streaming: false, partial: false, notice: null, loading: false, leafId: null, contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false, idea: { document: null, reason: null, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null }, ...extra };
}

/** the main conversation's store state, only as much as building the chat view reads */
function mainState(selectedId = "c1") {
  return {
    workspaces: [], mode: "chat", spaces: [], bookmarks: [], archive: "exclude", connection: "ok", attempt: 0,
    selectedId, drafts: {}, attachments: {}, types: {}, quota: null, open: null, receipt: null, markErrors: {}, deleteErrors: {}, now: 0,
    mentions: { candidates: [], chosen: [], open: false, query: "", loading: false, error: null },
    groups: selectedId ? chatGroups([conversation(selectedId, { name: "話し中" })]) : [],
  };
}

/** the side's own state as the store reports it */
function sideState(extra = {}) {
  return { id: null, open: null, error: null, opening: false, promoting: false, promoteError: null, promoted: false, ...extra };
}

const model = (chat, extra = {}) => ({ chat, keepStream: true, keepBranch: false, ...extra });

/** a spy for every operation the view hands out */
function spy(chat, btw, draft) {
  const calls = [];
  const on = new Proxy({}, { get: (_t, key) => (...args) => calls.push({ key: String(key), args }) });
  return {
    on,
    calls,
    read: (key) => calls.filter((call) => call.key === key).map((call) => call.args),
    get vm() {
      return chatVals(chat, btw, draft, true, EMPTY_CHAT_UI, on);
    },
  };
}

// ---- AC-001: the box is cleared only after the engine took the words ----

test("AC-001: the BTW box keeps its words until the engine takes them, and a refusal stays with its reason", async () => {
  const f = fakeFetch();
  const side = new SideChat(f.fetchFn, fakeStreams().open);
  let box = "trigram とは";
  // the screen's own press: the flow is `SideChat.ask`, and the box is cleared only when it came back ok
  const send = () => side.ask("c1", () => openBranchAt(f.fetchFn, "c1", "e2"), box).then((result) => {
    if (result.ok) box = "";
    return result;
  });

  const accepted = send();
  assert.equal(box, "trigram とは", "nothing is cleared before the branch is even cut");
  f.of("/api/conversations/c1/ephemeral")[0].respond(200, { ok: true, id: "b1" });
  await settle();
  f.of("/api/conversations/b1")[0].respond(200, openBody({ id: "b1" }));
  await settle();
  assert.equal(f.of("/api/conversations/b1/messages").length, 1, "the words are with the engine");
  assert.equal(box, "trigram とは", "the words stay while the engine is deciding");
  f.of("/api/conversations/b1/messages")[0].respond(200, { ok: true, streaming: true, queue: [] });
  assert.deepEqual(await accepted, { ok: true, error: null });
  assert.equal(box, "", "the box is cleared only after the engine took the words");

  box = "もう一度";
  const refused = send();
  await settle();
  f.of("/api/conversations/b1/messages")[1].respond(409, { ok: false, error: "枝は閉じました" });
  assert.deepEqual(await refused, { ok: false, error: "枝は閉じました" });
  assert.equal(box, "もう一度", "a refused send stays in the box");

  const vm = chatVals(mainState("c1"), side.state, box, true, EMPTY_CHAT_UI, NOOP);
  const panel = render(h(ChatPanel, { m: model(vm) }));
  assert.match(panel, /枝は閉じました/, "the reason stands on the frame");
  assert.match(panel, /value="もう一度"/, "the refused words are still in the input");
});

const QUESTION = { kind: "question", iddId: "IDD-042", batchId: "batch-1" };

const consultPanel = {
  open: true, cardKind: "question", chip: "?", chipBg: "var(--line-soft)", chipC: "var(--ink)", sign: false,
  lane: "IDD-042", source: "", sourceUrl: null, state: "0 / 1", tabs: [], sections: [],
  noteInput: { label: "相談", value: "", placeholder: "この card について聞く", hint: "" },
};

test("AC-001: the consultation keeps its words until the engine takes them, and a refusal stands in the section", async () => {
  const f = fakeFetch();
  const side = new SideChat(f.fetchFn, fakeStreams().open);
  const key = consultKey(QUESTION);
  let box = "警告はどこに出る？";
  const send = () => side.ask(key, () => openConsult(f.fetchFn, QUESTION), box).then((result) => {
    if (result.ok) box = "";
    return result;
  });

  const refused = send();
  f.of("/api/idd/consult")[0].respond(200, { ok: true, id: "s1" });
  await settle();
  f.of("/api/conversations/s1")[0].respond(200, openBody({ id: "s1" }));
  await settle();
  assert.equal(box, "警告はどこに出る？");
  f.of("/api/conversations/s1/messages")[0].respond(500, { ok: false, error: "相談を閉じました" });
  assert.deepEqual(await refused, { ok: false, error: "相談を閉じました" });
  assert.equal(box, "警告はどこに出る？", "a refused consult send stays in the box");

  const view = consultVals(side.state, true, NOOP);
  assert.equal(view.error, "相談を閉じました");
  const panel = render(h(InboxPanel, { panel: { ...consultPanel, noteInput: { ...consultPanel.noteInput, value: box } }, consult: view }));
  assert.match(panel, /相談を閉じました/, "the reason stands in the consultation section");
});

// ---- AC-002: the send belongs to the thing it began in ----

test("AC-002: a send whose conversation changes under it reaches nothing and marks no other frame", async () => {
  const f = fakeFetch();
  const side = new SideChat(f.fetchFn, fakeStreams().open);
  const first = side.ask("c1", () => openBranchAt(f.fetchFn, "c1", "e2"), "前の会話への問い");
  f.of("/api/conversations/c1/ephemeral")[0].respond(200, { ok: true, id: "b1" });
  await settle();
  f.of("/api/conversations/b1")[0].respond(200, openBody({ id: "b1" }));
  await settle();
  assert.equal(f.of("/api/conversations/b1/messages").length, 1, "the first send is with the engine");

  // the open conversation changes while that send is still with the engine
  side.clear();
  const second = side.ask("c2", () => openBranchAt(f.fetchFn, "c2", "e5"), "次の会話への問い");
  f.of("/api/conversations/c2/ephemeral")[0].respond(200, { ok: true, id: "b2" });
  await settle();
  f.of("/api/conversations/b2")[0].respond(200, openBody({ id: "b2" }));
  await settle();
  f.of("/api/conversations/b2/messages")[0].respond(200, { ok: true, streaming: true, queue: [] });
  await second;

  // the first send's answer arrives late and is refused: it belongs to the thing that is gone
  f.of("/api/conversations/b1/messages")[0].respond(409, { ok: false, error: "前の枝の断り" });
  assert.deepEqual(await first, { ok: false, error: null }, "the gone thing's answer is not reported as a send");

  const vm = chatVals(mainState("c2"), side.state, "次の会話への問い", true, EMPTY_CHAT_UI, NOOP);
  assert.equal(side.state.id, "b2", "the frame follows the new branch");
  assert.equal(vm.panel.error, null, "the old send's reason is not on the new frame");
  const panel = render(h(ChatPanel, { m: model(vm) }));
  assert.equal(panel.includes("前の枝の断り"), false);
  assert.equal(f.of("/api/conversations/c1/messages").length, 0, "the old words never reach the new conversation");
});

test("AC-002: a consult send whose card changes under it reaches nothing and leaves the next card alone", async () => {
  const f = fakeFetch();
  const side = new SideChat(f.fetchFn, fakeStreams().open);
  const cardA = { kind: "question", iddId: "IDD-042", batchId: "batch-1" };
  const cardB = { kind: "question", iddId: "IDD-057", batchId: "batch-2" };
  const first = side.ask(consultKey(cardA), () => openConsult(f.fetchFn, cardA), "前の card への問い");
  f.of("/api/idd/consult")[0].respond(200, { ok: true, id: "s1" });
  await settle();
  f.of("/api/conversations/s1")[0].respond(200, openBody({ id: "s1" }));
  await settle();
  assert.equal(f.of("/api/conversations/s1/messages").length, 1);

  // the front card changes while the send is still with the engine
  side.clear();
  const second = side.ask(consultKey(cardB), () => openConsult(f.fetchFn, cardB), "次の card への問い");
  f.of("/api/idd/consult")[1].respond(200, { ok: true, id: "s2" });
  await settle();
  f.of("/api/conversations/s2")[0].respond(200, openBody({ id: "s2" }));
  await settle();
  f.of("/api/conversations/s2/messages")[0].respond(200, { ok: true, streaming: true, queue: [] });
  await second;

  f.of("/api/conversations/s1/messages")[0].respond(409, { ok: false, error: "前の相談の断り" });
  assert.deepEqual(await first, { ok: false, error: null });
  const view = consultVals(side.state, true, NOOP);
  assert.equal(side.state.id, "s2");
  assert.equal(view.error, null, "the old card's refusal is not shown on the new card's consult");
});

// ---- AC-003: one batch of presses reaches the doors once ----

test("AC-003: presses while the side opens reach the open door and the send door once", async () => {
  const f = fakeFetch();
  const btw = new SideChat(f.fetchFn, fakeStreams().open);
  const press = () => btw.ask("c1", () => openBranchAt(f.fetchFn, "c1", "e2"), "一度だけ");
  const btwPresses = [press(), press(), press()];
  assert.equal(f.of("/api/conversations/c1/ephemeral").length, 1, "the branch is cut once");
  f.of("/api/conversations/c1/ephemeral")[0].respond(200, { ok: true, id: "b1" });
  await settle();
  f.of("/api/conversations/b1")[0].respond(200, openBody({ id: "b1" }));
  await settle();
  assert.equal(f.of("/api/conversations/b1/messages").length, 1, "the words reach the send door once");
  f.of("/api/conversations/b1/messages")[0].respond(200, { ok: true, streaming: true, queue: [] });
  assert.deepEqual(await Promise.all(btwPresses), [{ ok: true, error: null }, { ok: true, error: null }, { ok: true, error: null }]);

  const g = fakeFetch();
  const consult = new SideChat(g.fetchFn, fakeStreams().open);
  const key = consultKey(QUESTION);
  const ask = () => consult.ask(key, () => openConsult(g.fetchFn, QUESTION), "一度だけ");
  const consultPresses = [ask(), ask(), ask()];
  assert.equal(g.of("/api/idd/consult").length, 1, "the consult door is opened once");
  g.of("/api/idd/consult")[0].respond(200, { ok: true, id: "s1" });
  await settle();
  g.of("/api/conversations/s1")[0].respond(200, openBody({ id: "s1" }));
  await settle();
  assert.equal(g.of("/api/conversations/s1/messages").length, 1, "the consult's words are sent once");
  g.of("/api/conversations/s1/messages")[0].respond(200, { ok: true, streaming: true, queue: [] });
  await Promise.all(consultPresses);
});

// ---- AC-004: the flow is followed only while its screen shows ----

test("AC-004: leaving the screen stops the flow and the reconnect, and returning reads the same branch again", async () => {
  const f = fakeFetch();
  const streams = fakeStreams();
  const side = new SideChat(f.fetchFn, streams.open);
  const opened = side.ask("c1", () => openBranchAt(f.fetchFn, "c1", "e2"), "trigram とは");
  f.of("/api/conversations/c1/ephemeral")[0].respond(200, { ok: true, id: "b1" });
  await settle();
  f.of("/api/conversations/b1")[0].respond(200, openBody({ id: "b1" }));
  await settle();
  f.of("/api/conversations/b1/messages")[0].respond(200, { ok: true, streaming: true, queue: [] });
  await opened;
  assert.equal(side.state.id, "b1");
  const before = streams.calls.length;

  // the flow drops; without leaving, the store would dial the conversation again in a second
  streams.last().gone();
  side.detach();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(streams.calls.length, before, "a stopped side never reconnects");
  assert.equal(side.state.id, "b1", "the selection stays");

  // returning reads the same branch's record again and follows its flow
  side.resume();
  await settle();
  assert.equal(streams.calls.length, before + 1, "returning follows the side again");
  assert.equal(streams.last().path, "/api/conversations/b1/events");
  assert.equal(f.of("/api/conversations/b1").length, 2, "the record of the same branch is read again");
});

// ---- AC-005: the send position stops the branch while it answers ----

test("AC-005: the BTW send position stops the branch while it answers and sends nothing", async () => {
  const { fetchFn, calls } = recordingFetch((path) => (path.endsWith("/stop") ? { body: { ok: true } } : { body: {} }));
  const side = new SideChat(fetchFn, fakeStreams().open);
  side.chat.state = { ...side.chat.state, selectedId: "b1", open: openWith({ streaming: true }) };

  // the frame's send position offers the stop while the branch answers, and the box keeps the words
  const s = spy(mainState("c1"), side.state, "送るつもりの無かった文面");
  assert.equal(s.vm.panel.streaming, true);
  s.vm.panel.stop();
  assert.deepEqual(s.read("btwStop"), [[]]);
  assert.deepEqual(s.read("btwSend"), [], "the send position never calls the send while answering");
  const panel = render(h(ChatPanel, { m: model(s.vm) }));
  assert.match(panel, /data-mode="stop"/);
  assert.match(panel, /■/);
  assert.match(panel, /value="送るつもりの無かった文面"/);

  await side.stop();
  assert.equal(calls.filter((call) => call.path === "/api/conversations/b1/stop").length, 1);
  assert.equal(calls.filter((call) => call.path.endsWith("/messages")).length, 0, "stopping sends no words");
});

// ---- AC-006: the BTW frame tells its states apart ----

test("AC-006: the BTW frame draws a tool bundle as the body's folded row", () => {
  const open = openWith({ items: [{ key: "t1", kind: "tools", text: "", calls: [{ toolCallId: "c1", name: "grep", input: {}, isError: true, done: true }] }] });
  const vm = chatVals(mainState("c1"), sideState({ id: "b1", open }), "", true, EMPTY_CHAT_UI, NOOP);
  const panel = render(h(ChatPanel, { m: model(vm) }));
  assert.match(panel, /data-part="btw-tools"/);
  assert.match(panel, /道具 1 回 · grep/, "the folded row carries the count and the name");
  assert.match(panel, /失敗した道具があります/, "the failed call shows on the row");
});

test("AC-006: the BTW frame says its own empty line, and with no conversation open it offers no writer", () => {
  const empty = chatVals(mainState("c1"), sideState({ id: "b1", open: openWith() }), "", true, EMPTY_CHAT_UI, NOOP);
  const emptyPanel = render(h(ChatPanel, { m: model(empty) }));
  assert.match(emptyPanel, /この枝にはまだ発言がありません。/);
  assert.equal(emptyPanel.includes("左の一覧から会話を選ぶと"), false, "the body's own pick line is never drawn in the frame");

  const none = chatVals(mainState(null), sideState(), "", true, EMPTY_CHAT_UI, NOOP);
  assert.equal(none.panel.hasParent, false);
  const nonePanel = render(h(ChatPanel, { m: model(none) }));
  assert.equal(nonePanel.includes('data-part="btw-input"'), false, "no conversation open means no writer");
  assert.equal(nonePanel.includes('data-part="btw-send"'), false);
  assert.match(nonePanel, /会話を選ぶと、ここで枝を切って聞けます。/);
});

test("AC-006: after a promote neither frame offers a second one and both say the thing was kept", async () => {
  const { fetchFn } = recordingFetch((path) => (path.endsWith("/promote") ? { body: { ok: true } } : { body: {} }));

  const btw = new SideChat(fetchFn, fakeStreams().open);
  btw.chat.state = { ...btw.chat.state, selectedId: "b1", open: openWith() };
  assert.equal(await btw.promote(), true);
  assert.equal(btw.state.promoted, true);
  const btwVm = chatVals(mainState("c1"), btw.state, "", true, EMPTY_CHAT_UI, NOOP);
  assert.equal(btwVm.panel.canPromote, false, "a kept branch is not offered again");
  assert.match(render(h(ChatPanel, { m: model(btwVm) })), /会話として残しました/);

  const consult = new SideChat(fetchFn, fakeStreams().open);
  consult.chat.state = { ...consult.chat.state, selectedId: "s1", open: openWith() };
  assert.equal(await consult.promote(), true);
  const view = consultVals(consult.state, true, NOOP);
  assert.equal(view.canPromote, false, "a kept consult is not offered again");
  const panel = render(h(InboxPanel, { panel: consultPanel, consult: view }));
  assert.match(panel, /data-consult-keep="off"/);
  assert.match(panel, /会話に残しました/);
});

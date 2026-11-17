/**
 * The conversation screen's own wiring: the list, the body, the input's row, the queue chips and the BTW frame
 * are filled from the engine's conversation doors alone. The tests drive the same store the screen drives
 * (`ChatStore` and `SideChat` with a fetch stand-in), build the view model the components read, and render the
 * components to static markup, so the printed words can be checked: a value the engine did not return must not
 * appear, and the ported prototype's sample words must not either.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { h, load, render } from "./helpers.mjs";
import { chatGroups, conversation, fakeFetch, fakeStreams, settle } from "./fake.mjs";

const { ChatStore } = await load("./src/chat/store.ts");
const { SideChat, openBranchAt, openConsult } = await load("./src/chat/side.ts");
const { chatVals, consultKey, consultVals, listAction, markAction, EMPTY_CHAT_UI, EMPTY_LIST_UI } = await load("./src/chat/viewmodel.ts");
const { ChatSidebar } = await load("./src/components/shell/ChatSidebar.tsx");
const { ChatHeader } = await load("./src/components/chat/ChatHeader.tsx");
const { ChatConversation } = await load("./src/components/chat/ChatConversation.tsx");
const { Composer } = await load("./src/components/chat/Composer.tsx");
const { ChatPanel } = await load("./src/components/panels/ChatPanel.tsx");
const { InboxPanel } = await load("./src/components/panels/InboxPanel.tsx");
const { intentForScreen } = await load("./src/inbox/keymap.ts");
const { rightPanelShown } = await load("./src/model/model.ts");

const noop = () => {};

/** every operation the screen's view hands out, so a render needs none of them */
const NOOP = new Proxy({}, { get: () => noop });

/** a fetch that answers immediately from a route table, and records what it was asked */
function recordingFetch(route) {
  const calls = [];
  const fetchFn = (path, init) => {
    const call = { path, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null };
    calls.push(call);
    const answer = route(path, init) ?? {};
    const status = answer.status ?? 200;
    return Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => answer.body });
  };
  return { fetchFn, calls, of: (path) => calls.filter((call) => call.path === path) };
}

/** the side a frame draws while nothing is open */
const NO_SIDE = { id: null, open: null, error: null, opening: false, promoting: false, promoteError: null };

/** the find field's own view; a chat part only presses its open control */
const NO_SEARCH = { shown: false, open: noop, query: "", labels: {} };

/** the model the one conversation's view model reads; the chat half is the only one a chat part touches */
const model = (chat, extra = {}) => ({ chat, keepStream: true, keepBranch: false, search: NO_SEARCH, ...extra });

function openBody(extra = {}) {
  return { ok: true, mode: "chat", entries: [], leafId: null, queue: [], streaming: false, cost: 0, contextUsage: null, notices: [], models: [], features: { webSearch: false, mcp: false }, ...extra };
}

const ENTRY_USER = { id: "e1", parentId: null, type: "message", message: { role: "user", content: "FTS5 で日本語はどこまで引ける？", timestamp: "2026-10-14T01:00:00Z" } };
const ENTRY_ASSISTANT = {
  id: "e2", parentId: "e1", type: "message",
  message: {
    role: "assistant", timestamp: "2026-10-14T01:01:00Z",
    content: [
      { type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "fts5" } },
      { type: "text", text: "2,300 件なら実用です。\n\n```sql\nSELECT 1;\n```\n" },
    ],
  },
};
const ENTRY_TOOL_RESULT = { id: "e3", parentId: "e2", type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "grep", content: "hit", isError: true } };

// ---- AC-001: every value comes from the engine, and no sample word is drawn ----

test("AC-001: the list, the body, the chips and the input's row are the engine's own values", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path.endsWith("/idea")) return { body: { ok: false, reason: "idea の文書ではありません" } };
    if (path.endsWith("/models")) return { body: { ok: true, models: [{ id: "acme/orion", name: "Orion", provider: "acme", contextWindow: 128000, capabilities: ["image", "reasoning"] }] } };
    if (path === "/api/idd/modes") return { body: { ok: true, modes: [{ name: "chat", types: { chat: { label: "chat" }, idea: { label: "idea" } } }] } };
    if (path.includes("/conversations/c1")) {
      return { body: openBody({
        entries: [ENTRY_USER, ENTRY_ASSISTANT, ENTRY_TOOL_RESULT],
        leafId: "e3",
        queue: [{ id: "q1", text: "表にまとめて" }],
        model: "acme/orion", effort: "high", efforts: ["low", "high", "max"], type: "idea",
        contextUsage: { tokens: 40000, contextWindow: 128000, percent: 31.25 },
        notices: [{ kind: "context", percent: 91 }],
      }) };
    }
    if (path.startsWith("/api/conversations?")) {
      return { body: { groups: chatGroups([conversation("c1", { name: "日本語の検索", running: true, type: "idea", pinned: true }), conversation("c2")]) } };
    }
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  await store.selectWorkspace("chat");
  await store.readModes();
  await store.select("c1");
  await settle();
  assert.equal(store.state.groups.length, 1, "the list door was read");

  const vm = chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP);
  const sidebar = render(h(ChatSidebar, { m: model(vm) }));
  const body = render(h(ChatConversation, { m: model(vm) }));
  const composer = render(h(Composer, { m: model(vm) }));
  const header = render(h(ChatHeader, { m: model(vm) }));

  // the list: the engine's groups, names and marks
  assert.match(sidebar, /日本語の検索/, "the conversation's own name");
  assert.match(sidebar, /無題/, "an unnamed conversation is the screen's own 無題, never a sample title");
  assert.match(sidebar, /data-row="c1"/);
  assert.match(sidebar, /data-row="c2"/);
  assert.match(sidebar, /今日/, "the engine's own group heading");
  assert.match(sidebar, /応答中/, "the running mark comes from the summary's own field");
  assert.equal(vm.list.groups[0].rows.find((row) => row.id === "c1").idea, true, "the conversation's own type is the idea mark");

  // the header: the engine's name for the open conversation
  assert.match(header, /日本語の検索/);

  // the body: the record's own utterances, the folded tool row and the code block
  assert.match(body, /FTS5 で日本語はどこまで引ける？/);
  assert.match(body, /2,300 件なら実用です/);
  assert.match(body, /道具 1 回 · grep/, "the bundle is one folded row");
  assert.match(body, /失敗した道具があります/, "the failed call shows on the row");
  assert.match(body, /SELECT 1;/);
  assert.match(body, /コピー/);

  // the queue chip and the input's row: the engine's own figures
  assert.match(composer, /Queued 1/);
  assert.match(composer, /表にまとめて/);
  assert.match(composer, /Orion/, "the model's name from the engine's candidate list");
  assert.match(composer, /High/, "the effort level the engine reported");
  assert.match(composer, /31%/, "the context percentage from pi");
  assert.match(composer, /data-type-option="idea"/);
  assert.match(composer, /data-part="composer-attach"/);

  // the ported screens' sample words appear nowhere: no part of the prototype's own conversation is drawn
  const all = `${sidebar}\n${body}\n${composer}\n${header}`;
  const SAMPLE = [
    "SQLite FTS5 の制約", "出先で card に答える", "Opus 4.5", "Sonnet 4.5", "GPT-5", "136k", "200k", "$0.84",
    "schema.sql", "trigram の誤検出", "最後に表にまとめて", "内蔵ブラウザ", "#138 の記録", "68%", "41%", "72%",
    "Compact", "New session", "Files · 4", "System · Skills · Tools", "会話 72k", "外す", "Anthropic · 契約",
    "This session", "Today (incl. lanes)", "5h limit", "Weekly", "内蔵ブラウザ",
  ];
  for (const word of SAMPLE) assert.equal(all.includes(word), false, `${word} is not the engine's value`);

  // the warnings the engine decided on, along the input's top edge (DEC-118-4)
  assert.match(composer, /Context 91%/);
});

test("AC-001: a field the engine did not return is empty, and a refusal stands where the body would be", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path.endsWith("/idea")) return { body: { ok: false, reason: "none" } };
    if (path.endsWith("/models")) return { status: 500, body: { ok: false, error: "候補を読めません" } };
    if (path.includes("/conversations/c9")) return { status: 409, body: { ok: false, error: "cwd がありません" } };
    if (path.includes("/conversations/c1")) return { body: openBody() };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };

  // an open the engine refused: the reason stands where the body would, and nothing else is drawn there
  await store.select("c9");
  await settle();
  const refused = render(h(ChatConversation, { m: model(chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP)) }));
  assert.match(refused, /cwd がありません/);

  // an open with no usage, no efforts and no model: those fields stay empty and no value is guessed
  await store.select("c1");
  await settle();
  const vm = chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP);
  const composer = render(h(Composer, { m: model(vm) }));
  assert.match(composer, /—/, "an absent context reading is the dash, never a number");
  assert.equal(/Effort/.test(composer), false, "no effort control without the engine's levels");
  assert.equal(vm.input.attach.allowed, false, "no model means no image to attach");
  assert.equal(vm.body.empty, "まだ発言がありません。", "an open conversation with nothing in it says so and nothing more");
});

// ---- AC-002: the operations reach their own doors ----

function spyScreen(store, ui = { ...EMPTY_CHAT_UI }) {
  const calls = [];
  const on = new Proxy({}, {
    get: (_t, key) => (...args) => {
      calls.push({ key: String(key), args });
    },
  });
  const state = { ui };
  return {
    on,
    calls,
    state,
    get vm() {
      return chatVals(store.state, NO_SIDE, "下書き", true, state.ui, on);
    },
  };
}

test("AC-002: every control the input's row and the list draw calls its own operation with that row's own id", async () => {
  const { fetchFn } = recordingFetch(() => ({ body: {} }));
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    mode: "chat",
    selectedId: "c1",
    drafts: { c1: "下書き" },
    types: { chat: [{ name: "chat", label: "chat" }, { name: "idea", label: "idea" }] },
    open: {
      id: "c1", mode: "chat", error: null, items: [], leafId: "e9", queue: [{ id: "q1", text: "待っている文" }],
      streaming: true, partial: false, notice: null, loading: false, model: "acme/orion", effort: "low",
      efforts: ["low", "high"], contextUsage: null, cost: 0, notices: [], type: "chat", sending: false, recording: false,
      models: [{ id: "acme/orion", name: "Orion", provider: "acme", contextWindow: 128000, capabilities: ["image"] }],
      idea: { document: null, reason: null, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null },
    },
    groups: chatGroups([conversation("c1", { name: "one" }), conversation("c2", { name: "two" })]),
  };
  const s = spyScreen(store);
  const vm = s.vm;

  vm.list.groups[0].rows[0].select();
  vm.list.groups[0].rows[1].toggleMenu();
  vm.list.groups[0].rows[0].mark("pin");
  vm.list.groups[0].rows[0].remove();
  vm.list.newChat();
  vm.list.retry();
  vm.input.send();
  vm.input.stop();
  vm.input.setDraft("続き");
  vm.input.queue[0].startEdit();
  vm.input.queue[0].setEdited("直した");
  vm.input.queue[0].cancel();
  vm.input.queue[0].steer();
  vm.input.model.options[0].go();
  vm.input.model.setQuery("ori");
  vm.input.effort.levels[1].go();
  vm.input.types[1].go();
  vm.input.attach.remove(0);
  vm.input.context.open();

  // the confirm sends the box's own text: the screen rebuilds the view with the editor's value on every keystroke
  s.state.ui = { ...s.state.ui, queueEdit: { id: "q1", text: "直した" } };
  const editing = s.vm.input.queue[0];
  assert.equal(editing.editing, true);
  editing.confirmEdit();

  const read = (key) => s.calls.filter((call) => call.key === key).map((call) => call.args);
  assert.deepEqual(read("listSelect"), [["c1"]]);
  assert.deepEqual(read("listMenu"), [["c2"]]);
  assert.deepEqual(read("listMark"), [["c1", "pin"]]);
  assert.deepEqual(read("listDelete"), [["c1"]]);
  assert.deepEqual(read("newChat"), [[]]);
  assert.deepEqual(read("listRetry"), [[]]);
  assert.deepEqual(read("send"), [[]]);
  assert.deepEqual(read("stop"), [[]]);
  assert.deepEqual(read("queueConfirm"), [["q1", "直した"]]);
  assert.deepEqual(read("queueCancel"), [["q1"]]);
  assert.deepEqual(read("queueSteer"), [["q1"]]);
  assert.deepEqual(read("pickModel"), [["acme/orion"]]);
  assert.deepEqual(read("modelQuery"), [["ori"]]);
  assert.deepEqual(read("pickEffort"), [["high"]]);
  assert.deepEqual(read("pickType"), [["idea"]]);
  assert.deepEqual(read("removeAttachment"), [[0]]);
  assert.deepEqual(read("readQuota"), [[]], "the Context control reads the quota when it opens");

  // the mark a row's menu sends is the new value of exactly one field, from what the row shows (the screen's own
  // handler composes the same two pieces: `listAction` for the menu and `markAction` for the value)
  assert.deepEqual(markAction(conversation("c1", { pinned: false }), "pin").patch, { pinned: true });
  assert.deepEqual(markAction(conversation("c1", { pinned: true }), "pin").patch, { pinned: false });
  // a bookmark's menu item names an operation, not a kind: the kind comes from the engine's own list, and with
  // no kind defined there is nothing to send (the screen says why instead of the door refusing the name)
  assert.deepEqual(markAction(conversation("c1", {}), "bookmark", [{ id: "plan", label: "plan" }]).patch, { bookmarks: ["plan"] });
  assert.deepEqual(markAction(conversation("c1", { bookmarks: ["plan"] }), "bookmark", [{ id: "plan", label: "plan" }]).patch, { bookmarks: [] });
  assert.deepEqual(markAction(conversation("c1", { bookmarks: ["home"] }), "bookmark", [{ id: "plan", label: "plan" }, { id: "home", label: "home" }]).patch, { bookmarks: [] });
  assert.equal(markAction(conversation("c1", {}), "bookmark", []), null);

  // the stop control is the one drawn while the engine says a run is on
  assert.equal(vm.input.streaming, true);
});

test("a bookmark reaches the marks door with a kind the workspace defines, and with none the row says why", async () => {
  const rows = [conversation("c1", { name: "one" })];
  const { fetchFn, calls } = recordingFetch((path, init) => {
    if (path === "/api/conversations/c1/marks" && init?.method === "PATCH") return { body: { ok: true, mark: {} } };
    if (path.startsWith("/api/conversations?")) return { body: { groups: chatGroups(rows) } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat", groups: chatGroups(rows), bookmarks: [{ id: "plan", label: "plan" }] };

  // the menu's own name is never sent as a kind: the kind is one the workspace defines, and the whole list rides along
  const toggle = markAction(store.summaryFor("c1"), "bookmark", store.state.bookmarks);
  await store.setMark(toggle.id, toggle.patch);
  assert.deepEqual(calls.find((call) => call.path === "/api/conversations/c1/marks").body, { bookmarks: ["plan"] });

  // with no kind defined there is nothing to send, and the row carries the reason instead of a refusal of a kind that cannot exist
  const noKinds = new ChatStore(fetchFn, fakeStreams().open);
  noKinds.state = { ...noKinds.state, mode: "chat", groups: chatGroups(rows), bookmarks: [] };
  assert.equal(markAction(noKinds.summaryFor("c1"), "bookmark", noKinds.state.bookmarks), null);
  noKinds.refuseBookmarkMark("c1");
  assert.equal(noKinds.state.markErrors.c1, "ブックマークの種類がありません");
});

test("AC-002: the doors carry what the store composes, and the command door is never called", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.endsWith("/messages")) return { body: { ok: true, streaming: true, queue: [{ id: "q1", text: "次の文" }] } };
    if (path.endsWith("/model")) return { body: { ok: true, model: "acme/vega", effort: "max", efforts: ["low", "max"] } };
    if (path.endsWith("/type")) return { body: { ok: true, type: "idea" } };
    return { body: { ok: true } };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state, mode: "chat", selectedId: "c1", drafts: { c1: "送る文" },
    open: { id: "c1", mode: "chat", error: null, items: [], leafId: null, queue: [], streaming: false, partial: false, notice: null, loading: false, contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false, idea: { document: null, reason: null, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null } },
  };

  await store.send("送る文");
  await store.editQueue("q1", "直した文");
  await store.cancelQueue("q1");
  await store.steerQueue("q1");
  await store.setModel("acme/vega");
  await store.setEffort("max");
  await store.setType("idea");

  assert.deepEqual(calls.find((call) => call.path === "/api/conversations/c1/messages").body, { text: "送る文" });
  assert.equal(calls.find((call) => call.path === "/api/conversations/c1/queue/q1").init.method, "PATCH");
  assert.deepEqual(calls.find((call) => call.path === "/api/conversations/c1/queue/q1").body, { text: "直した文" });
  assert.equal(calls.filter((call) => call.path === "/api/conversations/c1/queue/q1" && call.init.method === "DELETE").length, 1);
  assert.equal(calls.filter((call) => call.path === "/api/conversations/c1/queue/q1/steer" && call.init.method === "POST").length, 1);
  assert.deepEqual(calls.find((call) => call.path === "/api/conversations/c1/model").body, { model: "acme/vega" });
  assert.deepEqual(calls.find((call) => call.path === "/api/conversations/c1/type").body, { type: "idea" });
  assert.equal(calls.some((call) => call.path.endsWith("/command")), false, "the command door is never used");
});

test("AC-002: words sent while a run is on become a chip only once the engine took them", async () => {
  const f = fakeFetch();
  const store = new ChatStore(f.fetchFn, fakeStreams().open);
  store.state = {
    ...store.state, mode: "chat", selectedId: "c1", drafts: { c1: "次の文" },
    open: { id: "c1", mode: "chat", error: null, items: [], leafId: "e1", queue: [], streaming: true, partial: false, notice: null, loading: false, contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false, idea: { document: null, reason: null, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null } },
  };
  const pending = store.send("次の文");
  assert.equal(chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP).input.queue.length, 0, "nothing is drawn before the engine answers");
  f.last().respond(200, { ok: true, streaming: true, queue: [{ id: "q1", text: "次の文" }] });
  await pending;
  const vm = chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP);
  assert.equal(vm.input.queue.length, 1);
  assert.equal(vm.input.queue[0].text, "次の文");
  assert.match(render(h(Composer, { m: model(vm) })), /Queued 1/);
});

test("AC-002: an image goes in only when the engine says the model takes one", async () => {
  const { fetchFn, calls } = recordingFetch(() => ({ body: { ok: true } }));
  const store = new ChatStore(fetchFn, fakeStreams().open);
  const plain = { id: "acme/plain", name: "Plain", provider: "acme", contextWindow: null, capabilities: [] };
  const eyes = { id: "acme/eyes", name: "Eyes", provider: "acme", contextWindow: null, capabilities: ["image"] };
  store.state = {
    ...store.state, mode: "chat", selectedId: "c1",
    open: { id: "c1", mode: "chat", error: null, items: [], leafId: null, queue: [], streaming: false, partial: false, notice: null, loading: false, model: plain.id, models: [plain, eyes], contextUsage: null, cost: 0, notices: [], sending: false, recording: false, idea: { document: null, reason: null, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null } },
  };
  const handed = [];
  const on = { ...NOOP, attach: (images) => handed.push(...images) };
  const vm = chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, on);
  assert.equal(vm.input.attach.allowed, false, "the ＋ is not a way in while the model takes no images");
  // the door's own rule: the store takes an image only for a model the engine says takes one (DEC-118-5)
  assert.equal(store.attachImage({ data: "AAAA", mimeType: "image/png" }), false);
  assert.equal(store.attachmentsFor("c1").length, 0);
  assert.match(render(h(Composer, { m: model(vm) })), /この model は画像を受け取りません/);

  store.state = { ...store.state, open: { ...store.state.open, model: eyes.id } };
  const allowed = chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, on);
  assert.equal(allowed.input.attach.allowed, true);
  allowed.input.attach.add([{ data: "AAAA", mimeType: "image/png" }]);
  assert.equal(handed.length, 1, "the ＋ hands the image to the screen's own attach operation");
  assert.equal(store.attachImage(handed[0]), true);
  assert.equal(store.attachmentsFor("c1").length, 1);
  assert.deepEqual(calls.filter((call) => call.path.endsWith("/messages")).length, 0, "attaching sends nothing");
});

test("the view is built from the snapshot it is handed, so the screen's own memo cannot go stale", () => {
  const { fetchFn } = recordingFetch(() => ({ body: {} }));
  const store = new ChatStore(fetchFn, fakeStreams().open);
  const openWith = (queue) => ({ id: "c1", mode: "chat", error: null, items: [], leafId: null, queue, streaming: false, partial: false, notice: null, loading: false, contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false, idea: { document: null, reason: null, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null } });
  store.state = { ...store.state, mode: "chat", selectedId: "c1", open: openWith([{ id: "q1", text: "前の答え" }]) };
  const drawn = store.state;
  // the engine answers once more, and the store moves on under the snapshot the screen is still drawing
  store.state = { ...store.state, open: openWith([{ id: "q2", text: "次の答え" }]) };

  const vm = chatVals(drawn, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP);
  assert.equal(vm.input.queue.length, 1);
  assert.equal(vm.input.queue[0].text, "前の答え", "the snapshot handed in is the one drawn");
});

// ---- AC-003: the delete waits for a second press on the same row ----

test("AC-004: the toggle closes the conversation's right panel, and nothing is drawn in that gate", () => {
  // the model's own predicate: the toggle's value (`right`) decides, and the Work screen keeps its own columns
  assert.equal(rightPanelShown("chat", true), true);
  assert.equal(rightPanelShown("chat", false), false, "the toggle closes the conversation's panel");
  assert.equal(rightPanelShown("work", true), false);
  assert.equal(rightPanelShown("inbox", true), true);
});

test("AC-004 / C-153-3: the right panel draws the BTW frame alone, and an idea conversation draws no sample gate or document", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path === "/api/idd/modes") return { body: { ok: true, modes: [{ name: "chat", types: { chat: { label: "chat" }, idea: { label: "idea" } } }] } };
    if (path.endsWith("/idea")) return { body: { ok: false, reason: "idea の文書ではありません" } };
    if (path.endsWith("/models")) return { body: { ok: true, models: [{ id: "acme/orion", name: "Orion", provider: "acme", contextWindow: 128000, capabilities: ["image"] }] } };
    if (path.includes("/conversations/c1")) return { body: openBody({ entries: [ENTRY_USER, ENTRY_ASSISTANT], leafId: "e2", type: "idea" }) };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };
  await store.readModes();
  await store.select("c1");
  await settle();
  const vm = chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP);

  // the right panel is the BTW frame and nothing else: the three frames with no door are not drawn
  const panel = render(h(ChatPanel, { m: model(vm) }));
  assert.match(panel, /BTW/);
  for (const frame of ["内蔵ブラウザ", ">MD<", "LOG"]) assert.equal(panel.includes(frame), false, `${frame} has no door behind it`);

  // the right panel's own gate: with the panel closed, the frame is not drawn at all
  assert.equal(render(h(ChatPanel, { m: model(chatVals(store.state, NO_SIDE, "", false, EMPTY_CHAT_UI, NOOP)) })), "");

  // an idea conversation draws the same body: no sample Exits, no gate line, no document panel
  const body = render(h(ChatConversation, { m: model(vm) }));
  assert.match(body, /2,300 件なら実用です/);
  for (const word of ["Exits", "IDEA", "ゲート", "Background", "Prior art", "Work breakdown"]) {
    assert.equal(body.includes(word), false, `${word} is a sample of the prototype's idea screen`);
  }
  assert.equal(vm.input.type, "idea", "the engine's own type is what the switch shows");
  assert.equal(vm.input.types.find((option) => option.name === "idea").active, true);
});

test("AC-003: the first press only shows the confirm, the second calls the delete door and leaves a line", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path === "/api/conversations/c1" && init0(calls, path)) return { body: { ok: true } };
    return { body: { ok: true } };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat", groups: chatGroups([conversation("c1", { name: "消す会話" }), conversation("c2", { name: "残る会話" })]) };

  // the presses, exactly as the screen's own handler composes them
  let ui = EMPTY_LIST_UI;
  const press = (p) => {
    const decision = listAction(ui, p);
    ui = decision.ui;
    if (decision.remove) void store.remove(decision.remove);
  };

  press({ kind: "delete", id: "c1" });
  await settle();
  assert.equal(calls.filter((call) => call.path === "/api/conversations/c1" && call.init?.method === "DELETE").length, 0, "one press never reaches the door");
  assert.equal(ui.confirming, "c1");
  const confirming = render(h(ChatSidebar, { m: model(chatVals(store.state, NO_SIDE, "", true, { ...EMPTY_CHAT_UI, list: ui }, NOOP)) }));
  assert.match(confirming, /もう一度押すと消えます/);
  assert.match(confirming, /消す会話/);

  // another row's press drops the confirm
  press({ kind: "select", id: "c2" });
  assert.equal(ui.confirming, null);

  press({ kind: "delete", id: "c1" });
  press({ kind: "escape" });
  assert.equal(ui.confirming, null, "Esc drops the confirm");
  press({ kind: "delete", id: "c1" });
  press({ kind: "delete", id: "c2" });
  assert.equal(ui.confirming, "c2", "a different row's press moves the confirm, it does not remove");

  press({ kind: "delete", id: "c1" });
  press({ kind: "delete", id: "c1" });
  await settle();
  assert.equal(calls.filter((call) => call.path === "/api/conversations/c1" && call.init?.method === "DELETE").length, 1, "the second press on the same row calls the door once");
  assert.match(store.state.receipt, /消す会話 を消しました/);
  const after = render(h(ChatSidebar, { m: model(chatVals(store.state, NO_SIDE, "", true, { ...EMPTY_CHAT_UI, list: ui }, NOOP)) }));
  assert.match(after, /消す会話 を消しました/, "the line stays on the screen");
});

/** the first call to a path is not a delete: used by the route above so a delete is answered as a delete */
function init0(calls, path) {
  return calls.filter((call) => call.path === path && call.init?.method === "DELETE").length > 0;
}

test("AC-003: a refused delete leaves the reason on the row and the row in the list", async () => {
  const { fetchFn } = recordingFetch((path) => (path === "/api/conversations/c1" ? { status: 409, body: { ok: false, error: "開いている会話は消せません" } } : { body: {} }));
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat", groups: chatGroups([conversation("c1", { name: "残る会話" })]) };
  await store.remove("c1");
  const vm = chatVals(store.state, NO_SIDE, "", true, EMPTY_CHAT_UI, NOOP);
  assert.equal(vm.list.groups[0].rows.length, 1, "the row stays");
  const html = render(h(ChatSidebar, { m: model(vm) }));
  assert.match(html, /残る会話/);
  assert.match(html, /開いている会話は消せません/, "the engine's own reason is on the row");
  assert.equal(store.state.receipt, null, "a refused delete leaves no 消しました line");
});

// ---- AC-004: the BTW frame cuts a branch off the open conversation and promotes only on a press ----

test("AC-004: BTW sends into a branch cut at the head, and the main conversation does not move", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path === "/api/conversations/c1/ephemeral") return { body: { ok: true, id: "b1", mode: "chat", parent: "c1", at: "e2", tools: ["read"] } };
    if (path === "/api/conversations/b1") return { body: openBody({ id: "b1", leafId: "e0" }) };
    if (path.endsWith("/b1/idea")) return { body: { ok: false, reason: "none" } };
    if (path.includes("/conversations/c1")) return { body: openBody({ entries: [ENTRY_USER, ENTRY_ASSISTANT], leafId: "e2" }) };
    return { body: { ok: true, streaming: true, queue: [] } };
  });
  const streams = fakeStreams();
  const main = new ChatStore(fetchFn, streams.open);
  main.state = { ...main.state, mode: "chat" };
  await main.select("c1");
  await settle();
  const mainItems = main.state.open.items.length;

  const btw = new SideChat(fetchFn, streams.open);
  // the screen's own BTW send: the flow lives in `SideChat.ask`, which cuts the branch when it must and says
  // whether the engine took the words
  const sendBtw = (text) => btw.ask("c1", () => openBranchAt(fetchFn, "c1", main.state.open.leafId), text);

  await sendBtw("trigram とは");
  const cut = calls.find((call) => call.path === "/api/conversations/c1/ephemeral");
  assert.deepEqual(cut.body, { at: "e2" }, "the branch is cut at the head the engine reported (DEC-1842)");
  assert.equal(btw.state.id, "b1");
  const sent = calls.find((call) => call.path === "/api/conversations/b1/messages");
  assert.deepEqual(sent.body, { text: "trigram とは" }, "the words go to the branch, not to the main conversation");
  assert.equal(calls.filter((call) => call.path === "/api/conversations/c1/messages").length, 0, "the main conversation is never sent to");
  assert.equal(main.state.open.items.length, mainItems, "the main body does not move");

  // the branch's answer flows into the BTW frame
  streams.calls[streams.calls.length - 1].emit({ type: "text", delta: "3 文字ずつ", contentIndex: 0, seq: 1 });
  const vm = chatVals(main.state, btw.state, "", true, EMPTY_CHAT_UI, NOOP);
  const panel = render(h(ChatPanel, { m: model(vm) }));
  assert.match(panel, /3 文字ずつ/);
  assert.match(panel, /会話として残す/);
  assert.match(panel, /続けて聞く/);
  assert.equal(panel.includes("内蔵ブラウザ"), false, "the three frames with no door are not drawn");
  assert.equal(panel.includes(">MD<"), false);
  assert.equal(panel.includes("LOG"), false);

  // only 会話として残す asks for the promotion, and the list is read again afterwards
  assert.equal(calls.filter((call) => call.path === "/api/conversations/b1/promote").length, 0);
  const ok = await btw.promote();
  assert.equal(ok, true);
  assert.equal(calls.filter((call) => call.path === "/api/conversations/b1/promote").length, 1);

  // the same conversation's BTW is not cut twice: a second send continues the same branch
  await sendBtw("もう一度");
  assert.equal(calls.filter((call) => call.path === "/api/conversations/c1/ephemeral").length, 1);
  assert.equal(calls.filter((call) => call.path === "/api/conversations/b1/messages").length, 2);
});

test("AC-004: a branch the engine refused shows its reason, and the frame's × leaves nothing behind", async () => {
  const { fetchFn } = recordingFetch((path) => (path.endsWith("/ephemeral") ? { status: 409, body: { ok: false, error: "この位置では枝を切れません" } } : { body: { ok: true } }));
  const main = new ChatStore(fetchFn, fakeStreams().open);
  main.state = {
    ...main.state, mode: "chat", selectedId: "c1",
    open: { id: "c1", mode: "chat", error: null, items: [], leafId: "e5", queue: [], streaming: true, partial: false, notice: null, loading: false, contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false, idea: { document: null, reason: null, received: null, gateBusy: false, gateError: null, challenge: null, exitError: null, exitBusy: false, outcomes: null } },
    groups: chatGroups([conversation("c1", { name: "話し中" })]),
  };
  const btw = new SideChat(fetchFn, fakeStreams().open);
  await btw.ensure("c1", () => openBranchAt(fetchFn, "c1", main.state.open.leafId));
  assert.equal(btw.state.error, "この位置では枝を切れません");
  const vm = chatVals(main.state, btw.state, "", true, EMPTY_CHAT_UI, NOOP);
  assert.match(render(h(ChatPanel, { m: model(vm) })), /この位置では枝を切れません/);

  btw.clear();
  assert.equal(btw.state.id, null);
  assert.equal(chatVals(main.state, btw.state, "", true, EMPTY_CHAT_UI, NOOP).panel.items.length, 0);
});

test("AC-004: an open that comes back after the frame moved does not select, and the request that replaced it opens", async () => {
  const f = fakeFetch();
  const btw = new SideChat(f.fetchFn, fakeStreams().open);

  // the frame leaves while the branch is still being cut: the open in flight belongs to the thing that is gone
  const first = btw.ensure("c1", () => openBranchAt(f.fetchFn, "c1", "e2"));
  btw.clear();
  assert.equal(btw.state.opening, false, "nothing is opening for the thing the frame left");
  f.of("/api/conversations/c1/ephemeral")[0].respond(200, { ok: true, id: "b1" });
  await first;
  assert.equal(btw.state.id, null, "the late open does not select the side the frame left");
  assert.equal(f.of("/api/conversations/b1").length, 0, "the stale branch's record is never opened");

  // a request that arrives while an open is with the engine is not dropped: its own key opens
  const branchA = btw.ensure("c1", () => openBranchAt(f.fetchFn, "c1", "e2"));
  const branchB = btw.ensure("c2", () => openBranchAt(f.fetchFn, "c2", "e5"));
  f.of("/api/conversations/c1/ephemeral")[1].respond(200, { ok: true, id: "b1" });
  await branchA;
  assert.equal(btw.state.id, null, "the replaced open does not select");
  assert.equal(btw.state.opening, true, "the newer key is still opening");
  f.of("/api/conversations/c2/ephemeral")[0].respond(200, { ok: true, id: "b2" });
  await settle();
  f.of("/api/conversations/b2")[0].respond(200, openBody({ id: "b2" }));
  await branchB;
  assert.equal(btw.state.id, "b2", "the key asked for while the first opened is the one that opens");
});

test("AC-004: the same key asked twice while it opens cuts one branch", async () => {
  const f = fakeFetch();
  const btw = new SideChat(f.fetchFn, fakeStreams().open);
  const first = btw.ensure("c1", () => openBranchAt(f.fetchFn, "c1", "e2"));
  const second = btw.ensure("c1", () => openBranchAt(f.fetchFn, "c1", "e2"));
  assert.equal(f.of("/api/conversations/c1/ephemeral").length, 1, "the second ask waits for the open under way");
  f.of("/api/conversations/c1/ephemeral")[0].respond(200, { ok: true, id: "b1" });
  await settle();
  f.of("/api/conversations/b1")[0].respond(200, openBody({ id: "b1" }));
  await Promise.all([first, second]);
  assert.equal(btw.state.id, "b1");
});

// ---- AC-005: the card's consultation stays in the Inbox panel ----

const QUESTION = {
  kind: "question", iddId: "IDD-042", batchId: "batch-1", laneTitle: "設定の検証",
  open: [{ questionId: "q1", question: "未知のキーは止めますか", facts: [], options: [{ index: 1, label: "警告して続ける", description: "古い設定でも起動できる", rationale: "設定の互換", recommendation: "recommended" }] }],
  askedTotal: 1, answeredCount: 0,
};

/** a consultation's own side, driven the way the screen's handlers drive it */
function consultSide(fetchFn, streams) {
  const side = new SideChat(fetchFn, streams.open);
  const key = consultKey(QUESTION);
  return {
    side,
    open: () => side.ensure(key, () => openConsult(fetchFn, { kind: QUESTION.kind, iddId: QUESTION.iddId, batchId: QUESTION.batchId })),
    ask: (text) => side.ask(key, () => openConsult(fetchFn, { kind: QUESTION.kind, iddId: QUESTION.iddId, batchId: QUESTION.batchId }), text),
    keep: () => side.promote(),
  };
}

test("AC-005: 聞く opens the card's consultation, and its answer flows into the panel without leaving the Inbox", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path === "/api/idd/consult") return { body: { ok: true, id: "s1", created: true, mode: "chat", role: "chat", cwd: "/tmp", tools: ["read"] } };
    if (path === "/api/conversations/s1") return { body: openBody({ id: "s1" }) };
    if (path.endsWith("/s1/idea")) return { body: { ok: false, reason: "none" } };
    return { body: { ok: true, streaming: true, queue: [] } };
  });
  const streams = fakeStreams();
  const consult = consultSide(fetchFn, streams);
  await consult.open();
  await consult.ask("警告はどこに出る？");

  assert.deepEqual(calls.find((call) => call.path === "/api/idd/consult").body, { kind: "question", iddId: "IDD-042", batchId: "batch-1" });
  assert.deepEqual(calls.find((call) => call.path === "/api/conversations/s1/messages").body, { text: "警告はどこに出る？" });
  assert.equal(calls.some((call) => call.path === "/api/idd/decide"), false, "the consultation's words never become the card's answer (C-143-3)");

  // the answer flows into the panel's own section
  streams.calls[streams.calls.length - 1].emit({ type: "text", delta: "起動ログと右上の通知に 1 回だけ", contentIndex: 0, seq: 1 });
  const view = consultVals(consult.side.state, true, { openAsk: noop, backToAnswer: noop, ask: noop, keep: noop });
  assert.equal(view.count, 1);
  const panel = render(h(InboxPanel, { panel: { open: true, cardKind: "question", chip: "?", chipBg: "var(--line-soft)", chipC: "var(--ink)", sign: false, lane: "IDD-042", source: "", sourceUrl: null, state: "0 / 1", tabs: [], sections: [], noteInput: { label: "相談", value: "警告はどこに出る？", placeholder: "この card について聞く", hint: "" } }, consult: view }));
  assert.match(panel, /相談/);
  assert.match(panel, /警告はどこに出る？/);
  assert.match(panel, /起動ログと右上の通知に 1 回だけ/);
  assert.match(panel, /相談を会話に残す/);
  assert.match(panel, /data-consult-back/);

  // asking the same card again continues the same consultation: the open door is not called a second time
  await consult.open();
  await consult.ask("もう一度聞く");
  assert.equal(calls.filter((call) => call.path === "/api/idd/consult").length, 1, "one card has one consultation (DEC-9022)");
  assert.equal(calls.filter((call) => call.path === "/api/conversations/s1/messages").length, 2);

  // only 相談を会話に残す asks for the promotion
  assert.equal(calls.filter((call) => call.path === "/api/conversations/s1/promote").length, 0);
  await consult.keep();
  assert.equal(calls.filter((call) => call.path === "/api/conversations/s1/promote").length, 1);
});

test("AC-005: a card the screen cannot consult sends nothing, and the answer's door stays shut while 聞く is open", () => {
  // only a question card has the two-part key the consult door needs
  assert.equal(consultKey({ kind: "go", iddId: "IDD-042" }), null);
  assert.equal(consultKey({ kind: "question", iddId: "IDD-042" }), null, "a question without its batch has no consultation");
  assert.equal(consultKey(QUESTION), "question\u0000IDD-042\u0000batch-1");

  // the panel's ask row for another kind is text: no consultation control is drawn and nothing is sent
  const plain = render(h(InboxPanel, { panel: { open: true, cardKind: "go", chip: "GO", chipBg: "var(--attention-bg)", chipC: "var(--attention-text)", sign: false, lane: "IDD-042", source: "", sourceUrl: null, state: "", tabs: [], sections: [], note: "" } }));
  assert.match(plain, /この card について聞く/);
  assert.equal(plain.includes("data-consult-keep"), false);
  assert.equal(plain.includes("data-panel-note-input"), false);

  // with 聞く open, no key turns the input's text into the card's answer: the door to 判断 stays shut
  const ctx = { noteOpen: true, askOpen: true, note: "警告はどこに出る？", selection: null, focusInInput: true, confirmOpen: false, keyCount: 1 };
  assert.equal(intentForScreen("inbox", QUESTION, { key: "Enter" }, ctx), null);
  assert.equal(intentForScreen("inbox", QUESTION, { key: "ArrowRight" }, ctx), null);
  const answering = { ...ctx, askOpen: false, note: "警告して続ける" };
  assert.equal(intentForScreen("inbox", QUESTION, { key: "Enter" }, answering).kind, "answer", "without 聞く the same box is the answer's");
});

// ---- the screen's own wiring: the model the components read is built without a browser

test("the conversation screen's own wiring builds a model the parts draw, with the engine's stores behind it", async () => {
  const { PropterApp } = await load("./src/PropterApp.tsx");
  // a render (no effects: the stores are not read, so nothing reaches the engine) must not throw and must carry
  // the conversation half the parts read: this is the wiring the page runs, not a stand-in for it
  const html = render(h(PropterApp, { startView: "chat" }));
  assert.match(html, /data-part="new-chat"/, "the list's own control is drawn");
  assert.match(html, /data-part="composer-input"/, "the input is drawn");
  assert.match(html, /BTW/, "the right panel's BTW frame is drawn");
});

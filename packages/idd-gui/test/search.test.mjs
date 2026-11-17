/**
 * The find field over every screen (IDD-173). The tests drive the same stores the shell drives — `ChatSearch`
 * for the field and `ChatStore` for the conversation it opens — with a fetch stand-in, build the view the
 * components read, and render the parts to static markup, so the prototype's words and the engine's values can
 * be checked without a browser.
 *
 * The two promises that shape the field are pinned here: typing never calls the engine's full-text door (it
 * stops the engine while it reads every record, C-173-1), and while the field is open no press can become an
 * Inbox card's decision (the card's listener is not installed behind it).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { h, load, render } from "./helpers.mjs";
import { fakeStreams, settle } from "./fake.mjs";

const { ChatSearch, titleRows, notFound } = await load("./src/search/store.ts");
const { searchVals } = await load("./src/search/view.ts");
const { isSearchOpenPress, searchKeyAction } = await load("./src/search/keys.ts");
const { installScreenKeys } = await load("./src/model/screenKeys.ts");
const { SearchPalette } = await load("./src/components/shell/SearchPalette.tsx");
const { ChatStore } = await load("./src/chat/store.ts");
const { chatVals, EMPTY_CHAT_UI } = await load("./src/chat/viewmodel.ts");
const { ChatHeader } = await load("./src/components/chat/ChatHeader.tsx");

const noop = () => {};
/** every operation the field's view hands out, so a render needs none of them */
const NOOP_HANDLERS = new Proxy({}, { get: () => noop });

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

/** a window that records the keydown listeners a screen installs, and presses a key at the ones it has now */
function keyWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, fn) {
      if (type === "keydown") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "keydown") listeners.delete(fn);
    },
    press(key, extra = {}) {
      for (const fn of [...listeners]) fn({ key, shiftKey: false, repeat: false, preventDefault() {}, ...extra });
    },
  };
}

const CANDIDATES = [
  { id: "c1", name: "新 GUI の上部の探す欄から全文検索で会話を開く — #166 の子 1", mode: "chat" },
  { id: "c2", name: "electron の自動更新が止まったときに、配布の版をどう戻すかを決める", mode: "idea" },
];

/** the list door's all-workspace, archive-included answer */
function titleList() {
  return { ok: true, conversations: CANDIDATES, groups: [] };
}

function openBody(extra = {}) {
  return { ok: true, mode: "chat", entries: [], leafId: null, queue: [], streaming: false, cost: 0, contextUsage: null, notices: [], models: [], features: { webSearch: false, mcp: false }, ...extra };
}

const NO_SIDE = { id: null, open: null, error: null, opening: false, promoting: false, promoteError: null };

// ------------------------------------------------------------------ keys

test("AC-001: ⌘K and Ctrl+K open the field; a repeat, an IME press and alt+K do not", () => {
  assert.equal(isSearchOpenPress({ key: "k", metaKey: true }), true);
  assert.equal(isSearchOpenPress({ key: "K", ctrlKey: true }), true);
  assert.equal(isSearchOpenPress({ key: "k" }), false, "a bare k types a k");
  assert.equal(isSearchOpenPress({ key: "k", metaKey: true, repeat: true }), false);
  assert.equal(isSearchOpenPress({ key: "k", metaKey: true, isComposing: true }), false);
  assert.equal(isSearchOpenPress({ key: "k", metaKey: true, altKey: true }), false);
});

test("AC-003: Enter asks for the body only when the title stage offers no row", () => {
  assert.equal(searchKeyAction({ key: "Enter" }, { body: false, rows: 2 }), "select");
  assert.equal(searchKeyAction({ key: "Enter" }, { body: false, rows: 0 }), "body");
  assert.equal(searchKeyAction({ key: "Enter" }, { body: true, rows: 0 }), "select");
  assert.equal(searchKeyAction({ key: "Escape" }, { body: false, rows: 0 }), "close");
  assert.equal(searchKeyAction({ key: "ArrowDown" }, { body: false, rows: 0 }), "next");
  assert.equal(searchKeyAction({ key: "ArrowUp" }, { body: false, rows: 0 }), "prev");
  assert.equal(searchKeyAction({ key: "1" }, { body: false, rows: 3 }), null, "a digit belongs to the input");
  assert.equal(searchKeyAction({ key: "Enter", isComposing: true }, { body: false, rows: 0 }), null);
});

test("AC-001: while the field is open only its keys are installed, so no press becomes a card's decision", () => {
  const win = keyWindow();
  const search = [];
  const card = [];
  const remove = installScreenKeys(win, {
    view: "inbox", settings: false, wopen: false,
    onInboxKey: (event) => card.push(event.key),
    searchOpen: true,
    onSearchKey: (event) => search.push(event.key),
  });
  assert.equal(win.listeners.size, 1, "the field installs its own listener, not the card's");
  win.press("Enter");
  win.press("ArrowDown");
  win.press("1");
  win.press("Escape");
  assert.deepEqual(card, [], "nothing behind the field becomes a card decision");
  assert.deepEqual(search, ["Enter", "ArrowDown", "1", "Escape"]);
  remove();
  assert.equal(win.listeners.size, 0);
});

test("AC-001: the settings sheet keeps the field's keys out, and Esc closes the sheet first", () => {
  const win = keyWindow();
  const search = [];
  let closed = 0;
  installScreenKeys(win, {
    view: "inbox", settings: true, wopen: false,
    onInboxKey: () => { throw new Error("the card's keys must not be installed"); },
    closeSettings: () => { closed += 1; },
    searchOpen: true,
    onSearchKey: (event) => search.push(event.key),
  });
  win.press("Enter");
  assert.deepEqual(search, [], "the field answers nothing while the sheet is up");
  win.press("Escape");
  assert.equal(closed, 1);
});

// ------------------------------------------------------------------ the title stage

test("AC-002: the title stage reads the all-workspace, archive-included list and never calls the search door while typing", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?")) return { body: titleList() };
    if (path.startsWith("/api/conversation-search")) return { body: { ok: true, query: "x", results: [], truncated: false, scannedSessions: 1 } };
    return { body: {} };
  });
  const field = new ChatSearch(fetchFn);
  field.open();
  await settle();

  const list = calls.filter((call) => call.path.startsWith("/api/conversations?")).map((call) => call.path);
  assert.deepEqual(list, ["/api/conversations?group=none&archive=include"], "the title stage covers the search's own set");
  assert.equal(field.state.candidates.length, 2);

  field.setQuery("全文検索");
  assert.deepEqual(titleRows(field.state).map((candidate) => candidate.id), ["c1"]);
  field.setQuery("TRIGRAM");
  assert.deepEqual(titleRows(field.state), [], "the match is case-insensitive, so an absent word finds nothing");
  assert.equal(calls.filter((call) => call.path.startsWith("/api/conversation-search")).length, 0, "typing never calls the search door");
});

test("AC-002: selecting a candidate carries the field's own name for it", async () => {
  const field = new ChatSearch(recordingFetch(() => ({ body: titleList() })).fetchFn);
  field.open();
  await settle();
  assert.equal(field.nameFor("c2"), CANDIDATES[1].name);
  assert.equal(field.nameFor("nope"), null);
});

// ------------------------------------------------------------------ the body stage

test("AC-003: the body stage is asked once, shows the title with its excerpts, and a cut answer says so", async () => {
  const answer = {
    ok: true, query: "trigram", truncated: true, scannedSessions: 42,
    results: [{ sessionId: "c9", mode: "chat", name: "SQLite の全文検索をどこまで速くできるか試した記録", hits: [{ entryId: "e1", role: "user", excerpt: "…trigram tokenizer なら辞書が要らない…" }], truncated: false }],
  };
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?")) return { body: titleList() };
    if (path.startsWith("/api/conversation-search")) return { body: answer };
    return { body: {} };
  });
  const field = new ChatSearch(fetchFn);
  field.open();
  await settle();
  field.setQuery("trigram");
  assert.equal(notFound(field.state), true, "no title holds the word: the A4 empty state stands");

  await field.searchBody();
  assert.equal(calls.filter((call) => call.path.startsWith("/api/conversation-search")).length, 1, "the door is called once");
  assert.equal(notFound(field.state), false);

  const view = searchVals(field.state, NOOP_HANDLERS);
  assert.equal(view.bodyShown, true);
  assert.equal(view.bodyTruncated, true);
  assert.equal(view.hits[0].title, answer.results[0].name);
  assert.equal(view.hits[0].hits[0].excerpt, answer.results[0].hits[0].excerpt);
  assert.equal(field.nameFor("c9"), answer.results[0].name, "a body row carries the name of the conversation it opens");
  const html = render(h(SearchPalette, { m: { search: view } }));
  assert.match(html, /SQLite の全文検索をどこまで速くできるか試した記録/);
  assert.match(html, /trigram tokenizer なら辞書が要らない/);
});

test("AC-003: a refused search door shows why and never draws a result", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?")) return { body: titleList() };
    if (path.startsWith("/api/conversation-search")) return { status: 500, body: { ok: false, error: "記録を読めません" } };
    return { body: {} };
  });
  const field = new ChatSearch(fetchFn);
  field.open();
  await settle();
  field.setQuery("trigram");
  await field.searchBody();
  const view = searchVals(field.state, NOOP_HANDLERS);
  assert.equal(view.bodyError, "記録を読めません");
  assert.equal(view.bodyShown, false);
  const html = render(h(SearchPalette, { m: { search: view } }));
  assert.match(html, /記録を読めません/);
});

test("AC-006: the empty title stage draws the prototype A4's words and its two buttons", async () => {
  const field = new ChatSearch(recordingFetch(() => ({ body: titleList() })).fetchFn);
  field.open();
  await settle();
  field.setQuery("どこにも無い語");
  assert.equal(notFound(field.state), true);
  const html = render(h(SearchPalette, { m: { search: searchVals(field.state, NOOP_HANDLERS) } }));
  assert.match(html, /一致する会話・lane・操作はありません/);
  assert.match(html, /タイトルだけを探しました。/);
  assert.match(html, /本文まで探す（FTS）/);
  assert.match(html, /この言葉で New chat/);
  assert.match(html, /data-part="search-body-button"/);
  assert.match(html, /data-part="search-new-chat"/);
});

test("AC-003: a list read that failed says so instead of claiming the title stage found nothing", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?")) return { status: 500, body: { ok: false, error: "一覧を読めません" } };
    return { body: {} };
  });
  const field = new ChatSearch(fetchFn);
  field.open();
  await settle();
  field.setQuery("どこにも無い語");
  assert.equal(field.state.candidatesDown, true);
  assert.equal(notFound(field.state), false, "a failed read is not a title stage that found nothing");
  const html = render(h(SearchPalette, { m: { search: searchVals(field.state, NOOP_HANDLERS) } }));
  assert.match(html, /一覧を読めません/);
});

// ------------------------------------------------------------------ the conversation it opens

test("AC-004: New chat leaves the word in the new conversation's box and never sends it", async () => {
  const WORKSPACES = [{ mode: "chat", label: "chat", workspace: "/c" }];
  const { fetchFn, calls } = recordingFetch((path, init) => {
    if (path === "/api/conversations/workspaces") return { body: { workspaces: WORKSPACES } };
    if (path.startsWith("/api/conversations/workspaces/")) return { body: { ok: true, spaces: [], bookmarks: [] } };
    if (path.startsWith("/api/conversations?group=")) return { body: { conversations: [], groups: [] } };
    if (path === "/api/conversations" && init?.method === "POST") return { body: { ok: true, id: "new1" } };
    if (path === "/api/conversations/new1") return { body: openBody() };
    if (path === "/api/conversations/new1/idea") return { body: { ok: false, reason: "idea の型ではありません" } };
    if (path.endsWith("/models")) return { body: { ok: true, models: [] } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  await store.newChat("trigram tokenizer");
  assert.equal(store.state.selectedId, "new1");
  assert.equal(store.draftFor("new1"), "trigram tokenizer", "the word is in the box");
  assert.equal(calls.filter((call) => call.path.endsWith("/messages")).length, 0, "the send door is never called");
});

test("AC-005: a conversation the list does not hold shows its own name in the header", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?group=")) return { body: { conversations: [], groups: [] } };
    if (path === "/api/conversations/other") return { body: openBody() };
    if (path === "/api/conversations/other2") return { body: openBody() };
    if (path.endsWith("/idea")) return { body: { ok: false, reason: "idea の型ではありません" } };
    if (path.endsWith("/models")) return { body: { ok: true, models: [] } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };

  await store.select("other", "別の workspace の会話の題");
  const named = chatVals(store.state, NO_SIDE, "", false, EMPTY_CHAT_UI, new Proxy({}, { get: () => noop }));
  assert.equal(named.list.title, "別の workspace の会話の題");
  const html = render(h(ChatHeader, { m: { chat: named } }));
  assert.match(html, /別の workspace の会話の題/);

  await store.select("other2");
  const unnamed = chatVals(store.state, NO_SIDE, "", false, EMPTY_CHAT_UI, new Proxy({}, { get: () => noop }));
  assert.equal(unnamed.list.title, "無題", "an unnamed conversation keeps the screen's own 無題");
});

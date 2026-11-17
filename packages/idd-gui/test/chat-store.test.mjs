import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";
import { chatGroups, conversation, fakeFetch, fakeStreams, settle } from "./fake.mjs";

const { ChatStore, draftAfterSend } = await load("./src/chat/store.ts");

/** a fetch that answers immediately from a route table, and records what it was asked */
function recordingFetch(route) {
  const calls = [];
  const fetchFn = (path, init) => {
    const call = { path, init, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const answer = route(path, init) ?? {};
    const status = answer.status ?? 200;
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: async () => answer.body,
    });
  };
  return { fetchFn, calls, of: (path) => calls.filter((call) => call.path === path) };
}

const WORKSPACES = [
  { mode: "chat", label: "chat", workspace: "/c" },
  { mode: "idea", label: "idea", workspace: "/i" },
];

/** the list door's query path for a mode and archive setting */
function listPath(mode, archive = "exclude") {
  return `/api/conversations?group=date&archive=${archive}${mode ? `&mode=${mode}` : ""}`;
}

function openBody(extra = {}) {
  return { ok: true, entries: [], leafId: null, queue: [], streaming: false, ...extra };
}

test("AC-002: the workspace picker decides the mode the list is read with", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path === "/api/conversations/workspaces") return { body: { workspaces: WORKSPACES } };
    if (path.startsWith("/api/conversations/workspaces/")) return { body: { ok: true, spaces: [], bookmarks: [] } };
    if (path.startsWith("/api/conversations?")) return { body: { conversations: [], groups: [] } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);

  await store.readWorkspaces();
  await settle();
  assert.equal(store.state.mode, "chat", "the first workspace is chosen when none is");

  await store.selectWorkspace("idea");
  await settle();
  const paths = calls.filter((call) => call.path.startsWith("/api/conversations?")).map((call) => call.path);
  assert.ok(paths.includes(listPath("chat")), "the list is read for the first workspace");
  assert.ok(paths.includes(listPath("idea")), "and again for the one chosen");
});

test("AC-006: archived conversations are left out by default and shown on the switch", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?")) return { body: { conversations: [], groups: [] } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };

  await store.readList();
  assert.ok(calls.some((call) => call.path === listPath("chat", "exclude")));

  await store.setArchive("only");
  assert.equal(store.state.archive, "only");
  assert.ok(calls.some((call) => call.path === listPath("chat", "only")));
});

test("AC-007: the screen never reads the lane sessions, and rows come only from the list", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?")) return { body: { groups: chatGroups([conversation("c1")]) } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };
  await store.readList();
  assert.equal(calls.some((call) => call.path.includes("live-sessions")), false);
  assert.deepEqual(store.state.groups[0].conversations.map((row) => row.id), ["c1"]);
});

test("AC-008: New chat creates in the chosen workspace and opens what it made", async () => {
  const { fetchFn, calls } = recordingFetch((path, init) => {
    if (path === "/api/conversations" && init?.method === "POST") return { body: { ok: true, id: "new1", mode: "chat" } };
    if (path === "/api/conversations/new1") return { body: openBody() };
    if (path.startsWith("/api/conversations?")) return { body: { groups: [] } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };
  await store.newChat();
  await settle();
  const create = calls.find((call) => call.path === "/api/conversations" && call.init?.method === "POST");
  assert.deepEqual(create.body, { mode: "chat" });
  assert.equal(store.state.selectedId, "new1");
});

test("AC-009 / AC-010: a mark change reaches the door, and a refusal leaves the list as it was", async () => {
  const rows = [conversation("c1")];
  const { fetchFn, calls } = recordingFetch((path, init) => {
    if (path === "/api/conversations/c1/marks" && init?.method === "PATCH") return { body: { ok: true, mark: { pinned: true } } };
    if (path.startsWith("/api/conversations?")) return { body: { groups: chatGroups(rows) } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat", groups: chatGroups(rows) };

  await store.setMark("c1", { pinned: true });
  await settle();
  const patch = calls.find((call) => call.path === "/api/conversations/c1/marks");
  assert.deepEqual(patch.body, { pinned: true });
  assert.equal(Object.keys(patch.body).length, 1, "one field per request");

  const refuseFetch = recordingFetch((path) => {
    if (path === "/api/conversations/c1/marks") return { status: 400, body: { ok: false, error: "印を書けません" } };
    return { body: {} };
  });
  const refusing = new ChatStore(refuseFetch.fetchFn, fakeStreams().open);
  refusing.state = { ...refusing.state, mode: "chat", groups: chatGroups(rows) };
  await refusing.setMark("c1", { pinned: true });
  assert.deepEqual(refusing.state.groups, chatGroups(rows), "the list does not move before the engine took it");
  assert.equal(refusing.state.markErrors.c1, "印を書けません");
});

test("AC-030 / AC-036: a send carries only the text, and while a run is on it becomes a queued chip", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.endsWith("/messages")) return { body: { ok: true, item: { id: "q1", text: "hello" }, streaming: true, queue: [{ id: "q1", text: "hello" }] } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    selectedId: "c1",
    open: { id: "c1", error: null, items: [], queue: [], streaming: true, partial: false, notice: null, loading: false },
  };
  await store.send("hello");
  const send = calls.find((call) => call.path.endsWith("/messages"));
  assert.deepEqual(send.body, { text: "hello" });
  assert.equal("model" in send.body, false);
  assert.equal("effort" in send.body, false);
  assert.equal(calls.some((call) => call.path.endsWith("/steer")), false, "a send never becomes an interrupt");
  assert.deepEqual(store.state.open.queue.map((item) => item.id), ["q1"]);
  assert.equal(store.state.open.streaming, true);
});

test("AC-034: a refused send keeps the text and shows the reason", async () => {  const { fetchFn } = recordingFetch((path) => {
    if (path.endsWith("/messages")) return { status: 400, body: { ok: false, error: "送れません" } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    selectedId: "c1",
    drafts: { c1: "書きかけ" },
    open: { id: "c1", error: null, items: [], queue: [], streaming: false, partial: false, notice: null, loading: false },
  };
  await store.send("書きかけ");
  assert.equal(store.draftFor("c1"), "書きかけ");
  assert.equal(store.state.open.notice, "送れません");
});

test("F-158-4: a send the engine took drops only the words it carried, and leaves the line typed meanwhile", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path.endsWith("/messages")) return { body: { ok: true, streaming: true } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    selectedId: "c1",
    drafts: { c1: "送る文" },
    open: { id: "c1", error: null, items: [], queue: [], streaming: false, partial: false, notice: null, loading: false },
  };
  const pending = store.send("送る文");
  // the person keeps writing while the words are with the engine
  store.setDraft("c1", "送る文。書き足した文");
  await pending;
  assert.equal(store.draftFor("c1"), "。書き足した文", "the sent words leave the box and the line typed meanwhile stays");
});

test("F-158-4: the box's remainder is one rule for the main send, the BTW frame and the card's consult", () => {
  assert.equal(draftAfterSend("送る文", "送る文"), "");
  assert.equal(draftAfterSend("送る文。書き足した文", "送る文"), "。書き足した文");
  // the box no longer begins with what was sent: it is the person's own text, and is left as it is
  assert.equal(draftAfterSend("書き直した", "送る文"), "書き直した");
});

test("AC-032 / INV-116-1: the chip actions map to their own doors, and a refusal leaves the queue untouched", async () => {
  const calls = [];
  const fetchFn = (path, init) => {
    calls.push({ path, method: init?.method ?? "GET" });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }) });
  };
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    selectedId: "c1",
    open: { id: "c1", error: null, items: [], queue: [{ id: "q1", text: "a" }], streaming: true, partial: false, notice: null, loading: false },
  };
  await store.editQueue("q1", "直した");
  await store.cancelQueue("q1");
  await store.steerQueue("q1");
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["PATCH /api/conversations/c1/queue/q1", "DELETE /api/conversations/c1/queue/q1", "POST /api/conversations/c1/queue/q1/steer"],
  );

  const refuse = new ChatStore(() => Promise.resolve({ status: 409, ok: false, json: async () => ({ ok: false, error: "送信中の項目は取り消せません" }) }), fakeStreams().open);
  refuse.state = {
    ...refuse.state,
    selectedId: "c1",
    open: { id: "c1", error: null, items: [], queue: [{ id: "q1", text: "a" }], streaming: true, partial: false, notice: null, loading: false },
  };
  await refuse.cancelQueue("q1");
  assert.deepEqual(refuse.state.open.queue.map((item) => item.id), ["q1"]);
  assert.equal(refuse.state.open.notice, "送信中の項目は取り消せません");
});

test("AC-033: while a run is on, stop calls its own door and the queue comes back from the answer", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.endsWith("/stop")) return { body: { ok: true, streaming: false, queue: [{ id: "q2", text: "残り" }] } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    selectedId: "c1",
    open: { id: "c1", error: null, items: [], queue: [], streaming: true, partial: false, notice: null, loading: false },
  };
  await store.stop();
  assert.ok(calls.some((call) => call.path.endsWith("/stop")));
  assert.equal(store.state.open.streaming, false);
  assert.deepEqual(store.state.open.queue.map((item) => item.id), ["q2"]);
});

test("AC-037: a failing list keeps the last picture and turns the band on", async () => {
  const rows = [conversation("c1")];
  let fail = false;
  const { fetchFn } = recordingFetch((path) => {
    if (path.startsWith("/api/conversations?")) return fail ? { status: 500, body: { ok: false } } : { body: { groups: chatGroups(rows) } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };
  await store.readList();
  assert.deepEqual(store.state.groups, chatGroups(rows));
  fail = true;
  await store.readList();
  assert.equal(store.state.connection, "down");
  assert.deepEqual(store.state.groups, chatGroups(rows), "the last list stays under the band");
});

test("AC-038: every conversation operation uses a dedicated door, never the command door", async () => {
  const calls = [];
  const { fetchFn } = recordingFetch((path, init) => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (path.startsWith("/api/conversations?")) return { body: { groups: chatGroups([conversation("c1")]) } };
    if (path === "/api/conversations/c1") return { body: openBody() };
    if (path.endsWith("/messages")) return { body: { ok: true, streaming: true, queue: [] } };
    if (path.endsWith("/stop")) return { body: { ok: true, streaming: false, queue: [] } };
    if (path === "/api/conversations/c1/marks") return { body: { ok: true, mark: {} } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat" };
  await store.readList();
  await store.select("c1");
  await settle();
  await store.send("x");
  await store.stop();
  await store.setMark("c1", { archived: true });
  await store.editQueue("q1", "y");
  await store.cancelQueue("q1");
  await store.steerQueue("q1");
  assert.equal(calls.some((call) => call.path.endsWith("/command")), false);
});

test("AC-027: an open the engine refused puts its reason where the body would stand and keeps the list", async () => {
  const rows = [conversation("c1")];
  const { fetchFn } = recordingFetch((path) => {
    if (path === "/api/conversations/c1") return { status: 409, body: { ok: false, error: "cwd がありません" } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat", groups: chatGroups(rows) };
  await store.select("c1");
  assert.equal(store.state.open.error, "cwd がありません");
  assert.deepEqual(store.state.groups, chatGroups(rows));
});

test("INV-116-3: events that arrive while the open door is answering are not dropped", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);

  const p = store.select("c1");
  assert.equal(s.calls.length, 1, "the stream is opened before the open door is asked");
  assert.ok(s.calls[0].path.endsWith("/events"));
  assert.equal(s.calls[0].lastEventId, null);

  s.last().emit({ type: "text", delta: "流れた", contentIndex: 0 });
  s.last().emit({ type: "queue", queue: [{ id: "q9", text: "待ち" }] });

  const entries = [{ id: "a", parentId: null, type: "message", message: { role: "user", timestamp: "t1", content: "u" } }];
  f.last().respond(200, openBody({ entries, leafId: "a" }));
  await p;
  await settle();

  assert.equal(store.state.open.items.some((item) => item.kind === "assistant" && item.text === "流れた"), true);
  assert.deepEqual(store.state.open.queue.map((item) => item.id), ["q9"]);
});

test("INV-116-1: the chips change only through a queue the engine returned", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody({ queue: [{ id: "q1", text: "a" }] }));
  await p;
  await settle();
  assert.deepEqual(store.state.open.queue.map((item) => item.id), ["q1"]);

  // a send's answer arrives before any chip changes: nothing is predicted
  assert.equal(s.last().closed, false);
  s.last().emit({ type: "queue", queue: [{ id: "q1", text: "a" }, { id: "q2", text: "b" }] });
  assert.deepEqual(store.state.open.queue.map((item) => item.id), ["q1", "q2"]);
});

test("AC-025: a streaming conversation is reconnected from the run's beginning, and the held delta is drawn once", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const entries = [{ id: "a", parentId: null, type: "message", message: { role: "user", timestamp: "t1", content: "u" } }];
  const p = store.select("c1");
  // a delta that flowed before the open door answered; the reconnect's replay carries it too
  s.last().emit({ type: "text", delta: "前", contentIndex: 0 });
  f.last().respond(200, openBody({ entries, leafId: "a", streaming: true, runStartSeq: 100 }));
  await p;
  await settle();

  const replay = s.calls[s.calls.length - 1];
  assert.equal(replay.lastEventId, 99, "the stream is read from one before the run began");

  // the run flows again from its number: the held delta must not be drawn on top of the replayed one
  replay.emit({ type: "run_start" });
  replay.emit({ type: "text", delta: "前", contentIndex: 0 });
  replay.emit({ type: "text", delta: "半", contentIndex: 0 });
  // the replayed entry describes a message the record already holds: it is folded once
  replay.emit({ type: "entry", role: "user", message: { role: "user", timestamp: "t1", content: "u" } });
  const bodies = store.state.open.items.filter((item) => item.kind === "assistant");
  assert.equal(bodies.length, 1, "the held delta is not drawn a second time");
  assert.equal(bodies[0].text, "前半");
  assert.equal(store.state.open.items.filter((item) => item.kind === "user").length, 1);
  assert.equal(store.state.open.partial, false);
});

test("AC-025: a run beginning the engine cannot fill falls back, keeps the held events and marks the body", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  s.last().emit({ type: "text", delta: "途中", contentIndex: 0 });
  f.last().respond(200, openBody({ streaming: true, runStartSeq: 100 }));
  await p;
  await settle();
  assert.equal(s.calls[s.calls.length - 1].lastEventId, 99);

  // the engine answers the number with a reset first: the beginning is gone
  s.calls[s.calls.length - 1].reset();
  await settle();
  const fallback = s.calls[s.calls.length - 1];
  assert.equal(fallback.lastEventId, null, "the fallback continues without a number");
  assert.equal(store.state.open.partial, true);
  assert.equal(store.state.open.items.some((item) => item.kind === "assistant" && item.text === "途中"), true, "the held event is not lost");
});

test("AC-012: a removed conversation leaves a line of what went, and a refusal leaves the row", async () => {
  const rows = [conversation("c1", { name: "SQLite FTS5" })];
  const { fetchFn, calls } = recordingFetch((path, init) => {
    if (path === "/api/conversations/c1" && init?.method === "DELETE") return { body: { ok: true } };
    if (path.startsWith("/api/conversations?")) return { body: { groups: chatGroups(rows) } };
    return { body: {} };
  });
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    mode: "chat",
    groups: chatGroups(rows),
    selectedId: "c1",
    open: { id: "c1", error: null, items: [], queue: [], streaming: false, partial: false, notice: null, loading: false },
  };
  await store.remove("c1");
  await settle();
  assert.ok(calls.some((call) => call.path === "/api/conversations/c1" && call.init?.method === "DELETE"));
  assert.match(store.state.receipt, /SQLite FTS5/);
  assert.equal(store.state.selectedId, null, "the removed conversation is not the selection any more");

  const refused = new ChatStore(
    (path, init) => Promise.resolve({ status: init?.method === "DELETE" ? 409 : 200, ok: init?.method !== "DELETE", json: async () => (init?.method === "DELETE" ? { ok: false, error: "消せません" } : { groups: chatGroups(rows) }) }),
    fakeStreams().open,
  );
  refused.state = { ...refused.state, mode: "chat", groups: chatGroups(rows), selectedId: "c1" };
  await refused.remove("c1");
  assert.deepEqual(refused.state.groups, chatGroups(rows), "the row stays when the engine refused");
  assert.equal(refused.state.deleteErrors.c1, "消せません");
  assert.equal(refused.state.receipt, null);
});

test("AC-041: the selection and the typed text live in the store, so leaving the screen keeps them", () => {
  const store = new ChatStore(() => Promise.resolve({ status: 200, ok: true, json: async () => ({}) }), fakeStreams().open);
  store.state = { ...store.state, selectedId: "c1", drafts: { c1: "書きかけ" } };
  store.detach();
  assert.equal(store.state.selectedId, "c1");
  assert.equal(store.draftFor("c1"), "書きかけ");
});

test("INV-116-2: a run's end reads the record again, and the column becomes the record", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody());
  await p;
  await settle();

  s.last().emit({ type: "text", delta: "流れていた", contentIndex: 0 });
  const opensBefore = f.calls.length;
  s.last().emit({ type: "end", reason: "completed" });
  await settle();
  assert.ok(f.calls.length > opensBefore, "the open door is read again after the run");

  const entries = [{ id: "a", parentId: null, type: "message", message: { role: "assistant", timestamp: "t9", content: [{ type: "text", text: "確定した本文" }] } }];
  f.last().respond(200, openBody({ entries, leafId: "a" }));
  await settle();
  assert.deepEqual(store.state.open.items.map((item) => item.text), ["確定した本文"]);
  assert.equal(store.state.open.streaming, false);
});

test("AC-026: a broken stream reconnects with the last number, and a reset reopens the record", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody());
  await p;
  await settle();

  s.last().emit({ type: "text", delta: "a", contentIndex: 0 });
  s.last().gone();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const reconnected = s.calls[s.calls.length - 1];
  assert.equal(reconnected.lastEventId, 1, "the reconnect carries the number last seen");

  const opensBefore = f.calls.length;
  reconnected.reset();
  await settle();
  assert.ok(f.calls.length > opensBefore, "a reset reads the record again");
  assert.equal(s.calls[s.calls.length - 1].lastEventId, null);
});

test("AC-026: an id-only frame's number is the reconnect's number, so a break before the first event loses nothing", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody());
  await p;
  await settle();

  // the engine hands the client the number it now holds, then the connection drops before any live event
  s.last().idOnly(42);
  s.last().gone();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const reconnected = s.calls[s.calls.length - 1];
  assert.equal(reconnected.lastEventId, 42, "the reconnect resumes from the id-only frame's number");
});

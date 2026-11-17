import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";
import { fakeFetch, fakeStreams, settle } from "./fake.mjs";

const { ChatStore } = await load("./src/chat/store.ts");

const OPEN = { id: "c1", mode: "chat", error: null, items: [{ key: "1", kind: "assistant", text: "本文" }], queue: [], streaming: false, partial: false, notice: null, loading: false, contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false };

test("F-116-2: an open that fails leaves no reconnect loop behind", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const pending = store.select("c1");
  s.last().gone();
  f.last().respond(409, { ok: false, error: "cwd がありません" });
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(store.state.open.error, "cwd がありません");
  assert.equal(s.calls.length, 1, "a failed conversation is never dialed again");
});

test("F-116-3: a workspace's spaces answer never lands under another workspace", async () => {
  const deferred = {};
  const fetchFn = (path) => {
    if (path.endsWith("/workspaces/chat/spaces")) return new Promise((resolve) => { deferred.chat = resolve; });
    if (path.endsWith("/workspaces/idea/spaces")) return Promise.resolve({ status: 200, ok: true, json: async () => ({ spaces: [{ id: "idea-p", name: "Idea" }] }) });
    if (path.includes("/bookmarks")) return Promise.resolve({ status: 200, ok: true, json: async () => ({ bookmarks: [] }) });
    if (path.startsWith("/api/conversations?")) return Promise.resolve({ status: 200, ok: true, json: async () => ({ groups: [] }) });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({}) });
  };
  const store = new ChatStore(fetchFn, fakeStreams().open);
  const first = store.selectWorkspace("chat");
  const second = store.selectWorkspace("idea");
  await second;
  deferred.chat({ status: 200, ok: true, json: async () => ({ spaces: [{ id: "chat-p", name: "Chat" }] }) });
  await first;
  await settle();
  assert.equal(store.state.mode, "idea");
  assert.deepEqual(store.state.spaces, [{ id: "idea-p", label: "Idea" }], "the older workspace's answer is dropped");
});

test("F-116-6: a second send while the first is on its way does not post again", async () => {
  const f = fakeFetch();
  const store = new ChatStore(f.fetchFn, fakeStreams().open);
  store.state = { ...store.state, mode: "chat", selectedId: "c1", open: { ...OPEN } };
  const one = store.send("one");
  const two = store.send("two");
  assert.equal(f.calls.length, 1, "the second press never reaches the door");
  f.last().respond(200, { ok: true, streaming: true, queue: [] });
  await Promise.all([one, two]);
  assert.equal(f.calls.length, 1);
  assert.equal(store.state.open.sending, false, "the guard is released when the answer comes");
});

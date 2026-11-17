import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";
import { fakeFetch, fakeStreams, settle } from "./fake.mjs";

const { ChatStore, attachError, contextUsageOf, filterModels, modelsOf, noticesOf, typesOf } = await load("./src/chat/store.ts");

const CONFIG_B = { id: "openrouter/config-b", name: "Config B", provider: "openrouter", contextWindow: 1000, capabilities: ["image", "reasoning"] };
const CONFIG_C = { id: "openrouter/config-c", name: "Config C", provider: "openrouter", contextWindow: 2000, capabilities: [] };

function openState(extra = {}) {
  return { id: "c1", mode: "chat", error: null, items: [], queue: [], streaming: false, partial: false, notice: null, loading: false, contextUsage: null, cost: 0, notices: [], models: [], sending: false, recording: false, ...extra };
}

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

function storeWith(fetchFn, streams = fakeStreams().open, recorder = null) {
  const store = new ChatStore(fetchFn, streams, () => 0, recorder);
  store.state = { ...store.state, mode: "chat", selectedId: "c1", open: openState() };
  return store;
}

// ---- the model picker ----

test("AC-009: the search narrows the rows and a choice goes to the model door alone", async () => {
  assert.deepEqual(filterModels([CONFIG_B, CONFIG_C], "config c").map((m) => m.id), ["openrouter/config-c"]);
  assert.deepEqual(filterModels([CONFIG_B, CONFIG_C], "config b").map((m) => m.id), ["openrouter/config-b"]);
  assert.deepEqual(filterModels([CONFIG_B, CONFIG_C], "").map((m) => m.id), ["openrouter/config-b", "openrouter/config-c"]);

  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.endsWith("/model")) return { body: { ok: true, model: "openrouter/config-c", effort: "high", efforts: ["low", "high"] } };
    return { body: {} };
  });
  const store = storeWith(fetchFn);
  await store.setModel("openrouter/config-c");
  const posts = calls.filter((call) => call.path === "/api/conversations/c1/model");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { model: "openrouter/config-c" });
  assert.equal(store.state.open.model, "openrouter/config-c");
  assert.equal(store.state.open.effort, "high");
  assert.deepEqual(store.state.open.efforts, ["low", "high"]);
});

test("AC-009 / AC-025: a refused choice leaves the display and shows the engine's reason", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path.endsWith("/model")) return { status: 409, body: { ok: false, error: "Model not found" } };
    return { body: {} };
  });
  const store = storeWith(fetchFn);
  store.state = { ...store.state, open: openState({ model: "openrouter/config-b" }) };
  await store.setModel("openrouter/config-c");
  assert.equal(store.state.open.model, "openrouter/config-b", "the display does not move on a refusal");
  assert.equal(store.state.open.notice, "Model not found");
});

// ---- the effort slider ----

test("AC-011 / AC-012: one release is one effort door call, and the display moves only to the answer", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.endsWith("/model")) return { body: { ok: true, model: "openrouter/config-b", effort: "high", efforts: ["low", "high"] } };
    return { body: {} };
  });
  const store = storeWith(fetchFn);
  store.state = { ...store.state, open: openState({ model: "openrouter/config-b", effort: "low", efforts: ["low", "high"] }) };
  await store.setEffort("high");
  const posts = calls.filter((call) => call.path === "/api/conversations/c1/model");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { effort: "high" });
  assert.equal(store.state.open.effort, "high");
});

test("INV-118-2: the screen never draws the requested level before the engine answers", async () => {
  const f = fakeFetch();
  const store = storeWith(f.fetchFn);
  store.state = { ...store.state, open: openState({ model: "openrouter/config-b", effort: "low", efforts: ["low", "high"] }) };
  const pending = store.setEffort("high");
  assert.equal(store.state.open.effort, "low", "the display does not move before the answer");
  f.last().respond(200, { ok: true, model: "openrouter/config-b", effort: "high", efforts: ["low", "high"] });
  await pending;
  assert.equal(store.state.open.effort, "high");
});

// ---- the Context control ----

test("AC-014: the quota door's answer is kept, and the engine's model, context and cost events move the fields", async () => {
  const { fetchFn } = recordingFetch((path) => {
    if (path === "/api/quota") return { body: { ok: true, providers: [{ provider: "claude", windows: [{ name: "five_hour", label: "5 時間の枠", utilization: 0.41 }], observed: "10/15 12:00" }] } };
    if (path === "/api/conversations/c1") return { body: { ok: true, mode: "chat", entries: [], leafId: null, queue: [], streaming: false } };
    return { body: {} };
  });
  const streams = fakeStreams();
  const store = new ChatStore(fetchFn, streams.open);
  store.state = { ...store.state, mode: "chat" };
  await store.select("c1");
  await store.readQuota();
  assert.equal(store.state.quota[0].provider, "claude");
  assert.equal(store.state.quota[0].windows[0].utilization, 0.41);

  const handle = streams.calls[streams.calls.length - 1];
  handle.emit({ type: "model", model: "openrouter/config-c", effort: "max", efforts: ["low", "max"] });
  assert.equal(store.state.open.effort, "max");
  assert.deepEqual(store.state.open.efforts, ["low", "max"]);
  handle.emit({ type: "context", contextUsage: { tokens: 900, contextWindow: 1000, percent: 90 }, notices: [{ kind: "context", percent: 90 }] });
  assert.equal(store.state.open.contextUsage.percent, 90);
  assert.equal(store.state.open.notices.length, 1);
  handle.emit({ type: "cost", sessionCost: 0.5 });
  assert.equal(store.state.open.cost, 0.5);
});

// ---- the type switch ----

test("AC-025: a refused candidate read keeps the open door's model and shows the reason", async () => {
  const { fetchFn } = recordingFetch((path) => (path.endsWith("/models") ? { status: 500, body: { ok: false, error: "候補を読めません" } } : { body: {} }));
  const store = storeWith(fetchFn);
  store.state = { ...store.state, open: openState({ model: "openrouter/config-b" }) };
  await store.readModels();
  assert.equal(store.state.open.model, "openrouter/config-b");
  assert.equal(store.state.open.notice, "候補を読めません");
});

test("AC-017 / AC-018: the switch sends only the type door, and the modes' types are read as the door returns them", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.endsWith("/type")) return { body: { ok: true, type: "idea", delivered: true, queue: [] } };
    return { body: {} };
  });
  const store = storeWith(fetchFn);
  await store.setType("idea");
  const posts = calls.filter((call) => call.path === "/api/conversations/c1/type");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { type: "idea" });
  assert.equal(store.state.open.type, "idea");
  assert.equal(calls.some((call) => call.path.endsWith("/command")), false);
  assert.equal(calls.some((call) => call.path === "/api/conversations" && call.init?.method === "POST"), false, "the mode's create door is never called");

  const refused = recordingFetch((path) => (path.endsWith("/type") ? { status: 409, body: { ok: false, error: "型の置き場がありません" } } : { body: {} }));
  const refusing = storeWith(refused.fetchFn);
  refusing.state = { ...refusing.state, open: openState({ type: "chat" }) };
  await refusing.setType("idea");
  assert.equal(refusing.state.open.type, "chat");
  assert.equal(refusing.state.open.notice, "型の置き場がありません");

  assert.deepEqual(typesOf([{ name: "chat", types: { chat: { label: "チャット" }, idea: { label: "アイデア" } } }, { name: "plain" }]), {
    chat: [{ name: "chat", label: "チャット" }, { name: "idea", label: "アイデア" }],
  });
});

// ---- attachments ----

test("AC-019: an image goes into the send body and is cleared once the engine took it", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path.endsWith("/messages")) return { body: { ok: true, streaming: true, queue: [] } };
    return { body: {} };
  });
  const store = storeWith(fetchFn);
  store.state = { ...store.state, open: openState({ model: CONFIG_B.id, models: [CONFIG_B] }) };
  assert.equal(store.attachImage({ data: "BBBB", mimeType: "image/png" }), true);
  assert.equal(store.attachmentsFor("c1").length, 1);
  await store.send("look");
  const send = calls.find((call) => call.path === "/api/conversations/c1/messages");
  assert.deepEqual(send.body, { text: "look", images: [{ data: "BBBB", mimeType: "image/png" }] });
  assert.deepEqual(store.attachmentsFor("c1"), []);
});

test("AC-020 / INV-118-4: a model without the image capability neither takes nor sends one", async () => {
  const { fetchFn, calls } = recordingFetch(() => ({ body: {} }));
  const store = storeWith(fetchFn);
  store.state = { ...store.state, open: openState({ model: CONFIG_C.id, models: [CONFIG_C] }) };
  assert.equal(store.attachImage({ data: "BBBB", mimeType: "image/png" }), false);
  assert.deepEqual(store.attachmentsFor("c1"), []);
  assert.equal(store.state.open.notice, "この model は画像を受け取りません");

  // attach while the model takes images, then switch to one that does not: the send is refused and never posted
  store.state = { ...store.state, open: openState({ model: CONFIG_B.id, models: [CONFIG_B, CONFIG_C] }) };
  assert.equal(store.attachImage({ data: "BBBB", mimeType: "image/png" }), true);
  store.state = { ...store.state, open: { ...store.state.open, model: CONFIG_C.id } };
  await store.send("look");
  assert.equal(calls.some((call) => call.path.endsWith("/messages")), false);
  assert.equal(store.state.open.notice, "この model は画像を受け取りません");
});

test("AC-021: the limit is the engine's own function, applied before an image is taken", () => {
  const tiny = { data: "AAAA", mimeType: "image/png" };
  assert.equal(attachError(Array.from({ length: 10 }, () => tiny)), null);
  assert.equal(attachError(Array.from({ length: 11 }, () => tiny)), "画像は 10 枚までです");
  assert.equal(attachError([{ data: "A".repeat(14 * 1024 * 1024), mimeType: "image/png" }]), "画像が大きすぎます（1 枚 10MB まで）");
  assert.equal(attachError([{ data: "AAAA", mimeType: "text/plain" }]), "画像が大きすぎます（1 枚 10MB まで）");

  const store = storeWith(() => Promise.resolve({ status: 200, ok: true, json: async () => ({}) }));
  store.state = { ...store.state, open: openState({ model: CONFIG_B.id, models: [CONFIG_B] }) };
  for (let i = 0; i < 10; i += 1) assert.equal(store.attachImage(tiny), true);
  assert.equal(store.attachImage(tiny), false);
  assert.equal(store.attachmentsFor("c1").length, 10);
  assert.equal(store.state.open.notice, "画像は 10 枚までです");
});

// ---- the voice input ----

function fakeRecorder(audio, contentType) {
  const calls = { start: 0, stop: 0, cancel: 0 };
  return {
    calls,
    recorder: {
      async start() {
        calls.start += 1;
        return {
          async stop() {
            calls.stop += 1;
            return { audio, contentType };
          },
          cancel() {
            calls.cancel += 1;
          },
        };
      },
    },
  };
}

test("AC-022 / AC-024 / INV-118-6: stopping sends the audio to the transcription door once and never sends a message", async () => {
  const audio = new Blob(["voice"], { type: "audio/webm" });
  const { calls, recorder } = fakeRecorder(audio, "audio/webm");
  const fetchCalls = [];
  const fetchFn = (path, init) => {
    fetchCalls.push({ path, init });
    if (path === "/api/transcriptions") return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, text: "こんにちは" }) });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({}) });
  };
  const store = storeWith(fetchFn, fakeStreams().open, recorder);
  await store.startRecording();
  assert.equal(store.state.open.recording, true);
  await store.stopRecording();
  const transcriptions = fetchCalls.filter((call) => call.path === "/api/transcriptions");
  assert.equal(transcriptions.length, 1, "the transcription door is called once");
  assert.equal(transcriptions[0].init.method, "POST");
  assert.ok(transcriptions[0].init.body instanceof Blob, "the body is the audio itself");
  assert.equal(transcriptions[0].init.headers["Content-Type"], "audio/webm");
  assert.equal(fetchCalls.some((call) => call.path.endsWith("/messages")), false, "the send door is never called");
  assert.equal(store.draftFor("c1"), "こんにちは");
  assert.equal(calls.stop, 1);
});

test("AC-023: the text lands in the box of the conversation the recording began in", async () => {
  const audio = new Blob(["voice"], { type: "audio/webm" });
  const { recorder } = fakeRecorder(audio, "audio/webm");
  const { fetchFn } = recordingFetch((path) => {
    if (path === "/api/transcriptions") return { body: { ok: true, text: "足す文字" } };
    if (path === "/api/conversations/c2") return { body: { ok: true, mode: "chat", entries: [], leafId: null, queue: [], streaming: false } };
    return { body: {} };
  });
  const store = storeWith(fetchFn, fakeStreams().open, recorder);
  store.state = { ...store.state, drafts: { c1: "前の文" } };
  await store.startRecording();
  await store.select("c2");
  await settle();
  assert.equal(store.state.selectedId, "c2");
  await store.stopRecording();
  assert.equal(store.draftFor("c1"), "前の文足す文字");
  assert.equal(store.draftFor("c2"), "");
});

test("AC-025: a refused transcription shows the engine's reason and leaves the draft alone", async () => {
  const audio = new Blob(["voice"], { type: "audio/webm" });
  const { recorder } = fakeRecorder(audio, "audio/webm");
  const { fetchFn } = recordingFetch((path) => {
    if (path === "/api/transcriptions") return { status: 503, body: { ok: false, error: "文字起こしは設定されていません（roles.yaml の stt）" } };
    return { body: {} };
  });
  const store = storeWith(fetchFn, fakeStreams().open, recorder);
  store.state = { ...store.state, drafts: { c1: "前の文" } };
  await store.startRecording();
  await store.stopRecording();
  assert.equal(store.draftFor("c1"), "前の文");
  assert.equal(store.state.open.notice, "文字起こしは設定されていません（roles.yaml の stt）");
});

test("AC-025: a slow refused transcription does not write into the conversation moved to", async () => {
  const audio = new Blob(["voice"], { type: "audio/webm" });
  const { recorder } = fakeRecorder(audio, "audio/webm");
  let answer = () => assert.fail("the transcription door was not asked");
  const fetchFn = (path) => {
    if (path === "/api/transcriptions") {
      return new Promise((resolve) => {
        answer = () => resolve({ status: 503, ok: false, json: async () => ({ ok: false, error: "文字起こしは設定されていません（roles.yaml の stt）" }) });
      });
    }
    if (path.startsWith("/api/conversations/")) {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, mode: "chat", entries: [], leafId: null, queue: [], streaming: false }) });
    }
    return Promise.resolve({ status: 200, ok: true, json: async () => ({}) });
  };
  const store = storeWith(fetchFn, fakeStreams().open, recorder);
  await store.startRecording();
  const stopping = store.stopRecording();
  await settle();
  // the answer is still on its way while the person moves to another conversation
  await store.select("c2");
  assert.equal(store.state.selectedId, "c2");
  const before = { model: store.state.open.model, streaming: store.state.open.streaming };
  answer();
  await stopping;
  assert.equal(store.state.selectedId, "c2");
  assert.equal(store.state.open.notice, null, "c1's recording failure does not land on c2");
  assert.equal(store.state.open.model, before.model);
  assert.equal(store.state.open.streaming, before.streaming);

  // the same conversation still gets the reason: the refusal is dropped only when the selection moved away
  await store.startRecording();
  const sameStopping = store.stopRecording();
  await settle();
  answer();
  await sameStopping;
  assert.equal(store.state.open.notice, "文字起こしは設定されていません（roles.yaml の stt）");
});

// ---- the row never uses the command door, and New session creates the mode's conversation ----

test("AC-016 / AC-027: the row's operations go to their own doors, and New session creates in the workspace's mode", async () => {
  const { fetchFn, calls } = recordingFetch((path) => {
    if (path === "/api/conversations" && true) return { body: { ok: true, id: "new1", mode: "chat" } };
    if (path === "/api/conversations/new1") return { body: { ok: true, mode: "chat", entries: [], leafId: null, queue: [], streaming: false } };
    if (path.endsWith("/model")) return { body: { ok: true, model: "openrouter/config-c", effort: "high", efforts: ["low", "high"] } };
    if (path.endsWith("/type")) return { body: { ok: true, type: "idea" } };
    return { body: {} };
  });
  const store = storeWith(fetchFn);
  await store.setModel("openrouter/config-c");
  await store.setEffort("high");
  await store.setType("idea");
  assert.equal(calls.some((call) => call.path.endsWith("/command")), false);

  await store.newChat();
  const create = calls.find((call) => call.path === "/api/conversations" && call.init?.method === "POST");
  assert.deepEqual(create.body, { mode: "chat" });
  assert.equal(store.state.selectedId, "new1");
});

// ---- the readers ----

test("the door's shapes are read as they come, and nothing is invented", () => {
  assert.deepEqual(modelsOf([{ id: "openrouter/config-b", name: "B", provider: "openrouter", contextWindow: 10, capabilities: ["image", "video"] }]), [
    { id: "openrouter/config-b", name: "B", provider: "openrouter", contextWindow: 10, capabilities: ["image"] },
  ]);
  assert.deepEqual(noticesOf([{ kind: "context", percent: 97 }, { kind: "quota", provider: "claude", window: "five_hour", label: "5h", utilization: 0.95 }, { kind: "budget" }]), [
    { kind: "context", percent: 97 },
    { kind: "quota", provider: "claude", window: "five_hour", label: "5h", utilization: 0.95 },
  ]);
  assert.deepEqual(contextUsageOf(null), null);
  assert.deepEqual(contextUsageOf({ tokens: 5, contextWindow: 10, percent: 50 }), { tokens: 5, contextWindow: 10, percent: 50 });
});

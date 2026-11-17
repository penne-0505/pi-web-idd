/**
 * AC-001: the composer points at a lane or a card and the send carries it. The candidates are the engine's own
 * lanes and cards (`/api/idd/state`), nothing else; the send body carries the identity alone and the engine
 * reads the point back (C-167-4/5). The sixth pick is refused by the screen before the engine sees it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";
import { fakeFetch, fakeStreams, settle } from "./fake.mjs";

const { ChatStore, mentionCandidatesOf, filterMentions } = await load("./src/chat/store.ts");
const { composerDraftChange } = await load("./src/chat/keys.ts");

function recordingFetch(route) {
  const calls = [];
  const fetchFn = (path, init) => {
    const call = { path, init, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const answer = route(path, init) ?? {};
    const status = answer.status ?? 200;
    return Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => answer.body });
  };
  return { fetchFn, calls, of: (path) => calls.filter((call) => call.path === path) };
}

const STATE = {
  lanes: [
    { iddId: "IDD-167", title: "通常の会話から指す", group: "impl", blockedBy: "実装中", source: { label: "penne-0505/pi-web-idd#169" } },
    { iddId: "IDD-165", title: "card の相談", group: "judge" },
  ],
  items: [
    { kind: "question", iddId: "IDD-165", batchId: "b1", laneTitle: "card の相談", open: [{ question: "どこに置くか" }] },
    { kind: "go", iddId: "IDD-167", laneTitle: "通常の会話から指す", summary: { situation: "状況" } },
  ],
};

function openStore(fetchFn) {
  const store = new ChatStore(fetchFn, fakeStreams().open);
  store.state = {
    ...store.state,
    selectedId: "c1",
    open: { id: "c1", mode: "chat", error: null, items: [], queue: [], streaming: false, partial: false, notice: null, loading: false, models: [], contextUsage: null, cost: 0, notices: [], sending: false, recording: false },
  };
  return store;
}

test("AC-001 / F-3: a `@` written into a sentence stays in the draft, and an address opens no picker", () => {
  // a `@` typed where a word starts opens the picker, and the character itself still goes into the draft
  assert.deepEqual(composerDraftChange("", "@"), { draft: "@", openPicker: true });
  assert.deepEqual(composerDraftChange("これを見て ", "これを見て @"), { draft: "これを見て @", openPicker: true });

  // an address or a handle keeps its `@` and opens nothing
  assert.deepEqual(composerDraftChange("penne", "penne@"), { draft: "penne@", openPicker: false });
  assert.deepEqual(composerDraftChange("これ @", "これ @@"), { draft: "これ @@", openPicker: false });
  assert.deepEqual(composerDraftChange("", "a b@"), { draft: "a b@", openPicker: false }, "a read-in value is not a keystroke");

  // what is typed is what the draft holds, keystroke by keystroke, whatever `@` is written for
  const typed = (text) => {
    let draft = "";
    let opened = 0;
    for (const character of text) {
      const change = composerDraftChange(draft, draft + character);
      draft = change.draft;
      if (change.openPicker) opened += 1;
    }
    return { draft, opened };
  };
  assert.deepEqual(typed("penne@example.com と @user に送る"), { draft: "penne@example.com と @user に送る", opened: 1 });
  assert.deepEqual(typed("mail@host.jp"), { draft: "mail@host.jp", opened: 0 });
});

test("AC-001 / C-167-5: candidates come only from the engine's lanes and cards", () => {
  const candidates = mentionCandidatesOf(STATE);
  assert.deepEqual(candidates.map((c) => c.key), ["lane:IDD-167", "lane:IDD-165", "card:question:IDD-165:b1", "card:go:IDD-167:"]);
  assert.equal(candidates[0].label, "IDD-167 通常の会話から指す");
  assert.ok(candidates[0].hint.includes("実装中"));
  assert.ok(candidates[2].hint.includes("どこに置くか"));
  const filtered = filterMentions(candidates, "どこに置くか");
  assert.deepEqual(filtered.map((c) => c.key), ["card:question:IDD-165:b1"]);
  assert.deepEqual(mentionCandidatesOf({ lanes: [], items: [] }), [], "nothing is invented when the state holds none");
});

test("AC-001: the picker reads the state when it opens", async () => {
  const { fetchFn, of } = recordingFetch((path) => (path === "/api/idd/state" ? { body: STATE } : { body: {} }));
  const store = openStore(fetchFn);
  store.openMentions();
  assert.equal(store.state.mentions.open, true);
  await settle();
  assert.equal(of("/api/idd/state").length, 1, "the state is read when the picker opens");
  assert.equal(store.state.mentions.candidates.length, 4);
  store.toggleMention("lane:IDD-167");
  assert.ok(store.state.mentions.chosen.some((c) => c.key === "lane:IDD-167"));
  store.toggleMention("lane:IDD-167");
  assert.equal(store.state.mentions.chosen.some((c) => c.key === "lane:IDD-167"), false, "pressing again takes it back");
});

test("AC-001 / F-1: every open reads the current lanes and cards, so a new lane can be pointed at", async () => {
  let state = STATE;
  const { fetchFn, of } = recordingFetch((path) => (path === "/api/idd/state" ? { body: state } : { body: {} }));
  const store = openStore(fetchFn);
  store.openMentions();
  await settle();
  const first = store.state.mentions.candidates.map((c) => c.key);
  assert.equal(first.includes("lane:IDD-170"), false);

  // a lane started after the first read
  state = {
    lanes: [...STATE.lanes, { iddId: "IDD-170", title: "新しく立った lane", group: "judge" }],
    items: STATE.items,
  };
  store.closeMentions();
  store.openMentions();
  await settle();
  assert.equal(of("/api/idd/state").length, 2, "the picker reads again each time it opens");
  assert.ok(store.state.mentions.candidates.some((c) => c.key === "lane:IDD-170"), "the lane that started is now a candidate");
  store.toggleMention("lane:IDD-170");
  assert.ok(store.state.mentions.chosen.some((c) => c.key === "lane:IDD-170"));
});

test("AC-001 / F-1: a card that is gone leaves the list and is taken back from the picks", async () => {
  let state = STATE;
  const { fetchFn, of } = recordingFetch((path) => (path === "/api/idd/state" ? { body: state } : { body: { ok: true } }));
  const store = openStore(fetchFn);
  store.openMentions();
  await settle();
  store.toggleMention("lane:IDD-167");
  store.toggleMention("card:question:IDD-165:b1");

  // the question was answered: the engine's state no longer holds that card
  state = { lanes: STATE.lanes, items: STATE.items.filter((item) => item.kind !== "question") };
  store.closeMentions();
  store.openMentions();
  await settle();
  assert.equal(of("/api/idd/state").length, 2);
  assert.equal(
    store.state.mentions.candidates.some((c) => c.key === "card:question:IDD-165:b1"),
    false,
    "the answered card is no longer offered",
  );
  assert.deepEqual(store.state.mentions.chosen.map((c) => c.key), ["lane:IDD-167"], "the point the state lost is taken back");
  assert.match(store.state.mentions.error ?? "", /なくなりました/, "and the screen says which one went");

  // the send no longer names the card the engine would refuse
  await store.send("これを見て");
  const send = of("/api/conversations/c1/messages").at(-1);
  assert.deepEqual(send.body, { text: "これを見て", mentions: [{ lane: "IDD-167" }] });
});

test("AC-001 / F-1: a second open while the read is in flight keeps the held list and does not stack reads", async () => {
  const { fetchFn, calls } = fakeFetch();
  const store = openStore(fetchFn);
  store.openMentions();
  calls[0].respond(200, STATE);
  await settle();
  assert.equal(store.state.mentions.candidates.length, 4);

  store.closeMentions();
  store.openMentions();
  assert.equal(store.state.mentions.loading, true);
  assert.equal(store.state.mentions.candidates.length, 4, "the held candidates stay while the refresh is in flight");
  store.closeMentions();
  store.openMentions();
  assert.equal(calls.filter((call) => call.path === "/api/idd/state").length, 2, "the second open does not start another read");
  calls[1].respond(200, STATE);
  await settle();
  assert.equal(store.state.mentions.loading, false);
  assert.equal(store.state.mentions.candidates.length, 4);
});

test("AC-002: five picks pass and a sixth is refused by the screen", () => {
  const { fetchFn } = recordingFetch(() => ({ body: {} }));
  const store = openStore(fetchFn);
  store.state = {
    ...store.state,
    mentions: {
      candidates: Array.from({ length: 6 }, (_, i) => ({ key: `lane:IDD-${i}`, lane: `IDD-${i}`, label: `IDD-${i}`, hint: "" })),
      chosen: [], open: false, query: "", loading: false, error: null,
    },
  };
  for (let i = 0; i < 5; i += 1) store.toggleMention(`lane:IDD-${i}`);
  assert.equal(store.state.mentions.chosen.length, 5);
  store.toggleMention("lane:IDD-5");
  assert.equal(store.state.mentions.chosen.length, 5, "the sixth is not added");
  assert.ok(store.state.mentions.error, "and the screen says why");
});

test("AC-001 / AC-002: the send carries only the identity, and clears what was pointed at", async () => {
  const { fetchFn, of } = recordingFetch((path) => (path === "/api/idd/state" ? { body: STATE } : { body: { ok: true, streaming: false } }));
  const store = openStore(fetchFn);
  store.openMentions();
  await settle();
  store.toggleMention("lane:IDD-167");
  store.toggleMention("card:question:IDD-165:b1");

  await store.send("これを見て");
  const send = of("/api/conversations/c1/messages")[0];
  assert.deepEqual(send.body, {
    text: "これを見て",
    mentions: [{ lane: "IDD-167" }, { lane: "IDD-165", kind: "question", batchId: "b1" }],
  });
  assert.deepEqual(store.state.mentions.chosen, [], "the picks are cleared after the engine took the send");

  // a send with no mention keeps the body the same as before
  await store.send("次");
  assert.deepEqual(of("/api/conversations/c1/messages").at(-1).body, { text: "次" });
});

test("AC-001: a mention-only send is allowed, because the engine builds the block from it", async () => {
  const { fetchFn, of } = recordingFetch((path) => (path === "/api/idd/state" ? { body: STATE } : { body: { ok: true } }));
  const store = openStore(fetchFn);
  store.openMentions();
  await settle();
  store.toggleMention("lane:IDD-167");
  await store.send("");
  assert.deepEqual(of("/api/conversations/c1/messages")[0].body, { text: "", mentions: [{ lane: "IDD-167" }] });
});

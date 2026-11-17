import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch, settle } from "./fake.mjs";
import { load } from "./helpers.mjs";
import { go, question } from "./fixtures/items.mjs";

const { InboxStore } = await load("./src/inbox/useDecide.ts");
const { WorkStore } = await load("./src/work/store.ts");
const { StateStream } = await load("./src/engine/state-stream.ts");
const { openSse, readSseFrame } = await load("./src/engine/sse.ts");
const { itemKey, deck } = await load("./src/inbox/deck.ts");

/**
 * The engine's state now arrives as one numbered stream, and nothing in the screen reads the state or Work doors on a
 * clock (#172, #180). These tests hold the screen's half of that: a frame that changed nothing reads nothing, a card
 * the engine has taken a judgment for does not come back from a picture built before it, a cut connection reconnects
 * and takes the whole picture as it stands, and the Work doors are read only when their own picture moved.
 */

const NOW = Date.parse("2026-10-05T12:00:00Z");
const settleN = async (n = 3) => {
  for (let i = 0; i < n; i += 1) await settle();
};

/** the state door's answer, as a frame carries it */
function bodyOf(items, extra = {}) {
  return { source: "state", stateDir: "/tmp", cron: null, sections: [], lanes: [], items, undelivered: { total: 0, failed: 0 }, ignores: [], holds: [], ...extra };
}

/** a stream opener the test drives: every open is recorded, and the test delivers frames and cuts */
function fakeStateStream() {
  const opened = [];
  const open = (path, lastEventId, onFrame, onGone) => {
    const handle = {
      path,
      lastEventId,
      closed: false,
      frame(frame) {
        if (!this.closed) onFrame(frame);
      },
      gone() {
        if (!this.closed) onGone();
      },
      close() {
        this.closed = true;
      },
    };
    opened.push(handle);
    return handle;
  };
  return { open, calls: opened, last: () => opened[opened.length - 1] };
}

/** a timer the test fires by hand, so a reconnect does not wait a real second */
function manualTimers() {
  const pending = [];
  return {
    set(fn) {
      const handle = { fn };
      pending.push(handle);
      return handle;
    },
    clear(handle) {
      const at = pending.indexOf(handle);
      if (at >= 0) pending.splice(at, 1);
    },
    runAll() {
      for (const handle of pending.splice(0)) handle.fn();
    },
    get count() {
      return pending.length;
    },
  };
}

test("AC-001: a frame that changed nothing reads neither the state door nor the Work doors", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const work = new WorkStore(engine.fetchFn, () => NOW);

  store.apply({ seq: 100, workSeq: 50, state: bodyOf([go]) }, { resync: true });
  work.followPicture(50);
  assert.equal(engine.calls.length, 3, "the first Work picture is read once: the column, the forecast and today's spend");
  const reads = engine.calls.length;

  // the same picture again, however often: the store shows it, and asks the engine for nothing
  store.apply({ seq: 100, workSeq: 50, state: bodyOf([go]) });
  work.followPicture(50);
  await settleN();
  assert.equal(engine.calls.length, reads, "a still picture sends the screen to no door");
  assert.equal(store.state.snapshot.items.length, 1);
});

test("AC-002: the Work doors are read when the Work picture moves, and only then", async () => {
  const engine = fakeFetch();
  const work = new WorkStore(engine.fetchFn, () => NOW);
  work.followPicture(50);
  assert.equal(engine.calls.length, 3);

  work.followPicture(51);
  assert.equal(engine.calls.length, 6, "the Work column, the forecast and today's spend once more");
  work.followPicture(51);
  assert.equal(engine.calls.length, 6);
});

test("AC-005: a picture built before the judgment does not bring the card back", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const stale = bodyOf([go]); // built before the judgment: the card is still in it
  store.apply({ seq: 100, workSeq: 10, state: stale }, { resync: true });

  // the person sends a judgment the engine takes; the read after it is numbered later and no longer has the card
  const decision = store.decide({ kind: "go_go" }, go);
  await settleN();
  const send = engine.calls[engine.calls.length - 1];
  assert.equal(send.path, "/api/idd/decide");
  send.respond(200, { ok: true });
  await settleN();
  const read = engine.calls[engine.calls.length - 1];
  assert.equal(read.path, "/api/idd/state");
  read.respond(200, bodyOf([]), { "x-idd-seq": "120" });
  await decision;
  assert.deepEqual(store.state.snapshot.items, [], "the picture after the judgment has no card");

  // the engine's picture from before the judgment lands late, whatever the order: the card must not come back
  store.apply({ seq: 99, workSeq: 10, state: stale });
  assert.deepEqual(store.state.snapshot.items, [], "a picture numbered below the one shown is not applied");

  // and a frame that reached the screen before the read answered is one the hidden set keeps out of the deck
  const store2 = new InboxStore(engine.fetchFn, () => NOW);
  store2.apply({ seq: 100, workSeq: 10, state: stale }, { resync: true });
  const decision2 = store2.decide({ kind: "go_go" }, go);
  await settleN();
  engine.calls[engine.calls.length - 1].respond(200, { ok: true });
  await settleN();
  store2.apply({ seq: 110, workSeq: 10, state: stale }, { resync: false });
  assert.deepEqual(frontOf(store2), [], "the decided card stays out of the deck while the post-judgment read is out");
  engine.calls[engine.calls.length - 1].respond(200, bodyOf([]), { "x-idd-seq": "120" });
  await decision2;
  assert.deepEqual(frontOf(store2), []);

  // a card the engine lets back in (a new batch, a card that came again) is shown again, at a later number
  store2.apply({ seq: 130, workSeq: 10, state: stale }, { resync: false });
  assert.equal(frontOf(store2).length, 1, "a picture read after the one that left it out shows the card again");
});

/** the cards the inbox puts in front, the same call the screen makes: the hidden set is what a judgment leaves behind */
function frontOf(store) {
  return deck(store.state.snapshot.items, store.state.now, store.state.hidden, store.state.focused).front;
}

test("AC-004: a cut stream reconnects from the last number and takes the whole picture as it stands", async () => {
  const streams = fakeStateStream();
  const timers = manualTimers();
  const stream = new StateStream(streams.open, 1000, timers);
  const seen = [];
  const stop = stream.start((delivery) => seen.push(delivery));

  streams.last().frame({ seq: 100, workSeq: 10, state: bodyOf([go]) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].resync, true, "the first frame of a connection is the whole picture");
  streams.last().frame({ seq: 101, workSeq: 10, state: bodyOf([go]) });
  assert.equal(seen[1].resync, false);

  // the connection ends: the retry is scheduled, and it resumes from the number last seen
  streams.last().gone();
  assert.equal(timers.count, 1);
  assert.equal(stream.connected, false);
  timers.runAll();
  assert.equal(streams.calls.length, 2);
  assert.equal(streams.last().lastEventId, 101);

  // the engine was replaced while the screen was away: its picture is numbered its own way, and is still taken
  streams.last().frame({ seq: 5, workSeq: 2, state: bodyOf([question]) });
  assert.equal(seen.length, 3);
  assert.equal(seen[2].resync, true, "a reconnect's first frame is not compared with the number held before the cut");
  assert.equal(seen[2].frame.state.items[0].kind, "question", "the whole picture, as the new engine holds it");

  // a tab that comes back tries at once rather than at the retry's hour
  streams.last().gone();
  timers.clear(timers);
  stream.reconnectIfGone();
  assert.equal(streams.calls.length, 3);
  stop();
  assert.equal(streams.last().closed, true, "stopping the screen closes the stream");
});

test("AC-004: a refused connection (the engine is being replaced) is retried until it answers", async () => {
  const streams = fakeStateStream();
  const timers = manualTimers();
  const stream = new StateStream(streams.open, 1000, timers);
  const seen = [];
  stream.start((delivery) => seen.push(delivery));
  // the refusal is the opener's `onGone` with no frame at all
  for (let i = 0; i < 3; i += 1) {
    streams.last().gone();
    timers.runAll();
  }
  assert.equal(streams.calls.length, 4, "the screen keeps trying while the engine is away");
  streams.last().frame({ seq: 200, workSeq: 20, state: bodyOf([go]) });
  assert.equal(seen.length, 1, "the picture arrives as soon as the new engine answers");
  stream.stop();
});

test("AC-002: the selected lane's detail is read again when its row moves or its read failed", async () => {
  const engine = fakeFetch();
  const work = new WorkStore(engine.fetchFn, () => NOW);
  const lane = (over = {}) => ({ kind: "issue", id: "IDD-1", repo: "p", title: "t", bundle: "running", spans: [], waitsFor: [], ...over });
  const snapshot = (row) => ({ now: new Date(NOW).toISOString(), repos: [], lanes: [row], done: [], holds: [] });
  const answerDetail = () => {
    for (const call of engine.calls.filter((c) => c.path.startsWith("/api/idd/lane/") || c.path.startsWith("/api/idd/work/lanes/"))) {
      call.respond(call.path.endsWith("/decisions")
        ? 200
        : call.path.endsWith("/record")
          ? 200
          : 200, call.path.endsWith("/decisions")
        ? { lane: "IDD-1", own: [], existing: [], dropped: 0, paths: [] }
        : call.path.endsWith("/record")
          ? { lane: "IDD-1", acceptance: [], log: [], findings: { placed: [], delivered: [], disposals: [] } }
          : { iddId: "IDD-1" });
    }
  };

  work.followSelection(snapshot(lane()), "IDD-1");
  answerDetail();
  await settleN();
  assert.equal(engine.calls.filter((c) => c.path === "/api/idd/lane/IDD-1").length, 1);

  // the same picture and the same row: nothing is read again
  work.followSelection(snapshot(lane()), "IDD-1");
  await settleN();
  assert.equal(engine.calls.filter((c) => c.path === "/api/idd/lane/IDD-1").length, 1);

  // the lane moved (a stage, a mark): its own views are read again without the person selecting it anew
  work.followSelection(snapshot(lane({ note: "段が進んだ" })), "IDD-1");
  answerDetail();
  await settleN();
  assert.equal(engine.calls.filter((c) => c.path === "/api/idd/lane/IDD-1").length, 2);

  // a read that failed is tried again at the next picture, not only when the selection changes
  const from = engine.calls.length;
  work.followSelection(snapshot(lane({ note: "また進んだ" })), "IDD-1");
  for (const call of engine.calls.slice(from)) call.reject(new Error("network"));
  await settleN();
  assert.equal(work.state.detail?.error, "unreachable", "the failure is kept beside the detail, not as a whole-screen failure");
  work.followSelection(snapshot(lane({ note: "また進んだ" })), "IDD-1");
  assert.equal(engine.calls.filter((c) => c.path === "/api/idd/lane/IDD-1").length, 4, "the failed detail is read again");
});

test("the shared reader cuts frames the way the engine writes them", async () => {
  // an engine's body as it arrives in pieces: an id-only frame, a data frame, and a comment line
  const chunks = ["id: 7\n\n", 'id: 8\ndata: {"seq":8}\n\n', ": ping\n\n", 'data: {"seq":9}\n\n'];
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const frames = [];
  let gone = 0;
  const handle = openSse("/api/idd/events", 6, (frame) => frames.push(frame), () => { gone += 1; }, async () => ({ ok: true, body }));
  for (let i = 0; i < 20 && gone === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  handle.close();
  assert.deepEqual(frames, [
    { id: 7, data: "" },
    { id: 8, data: '{"seq":8}' },
    { id: null, data: '{"seq":9}' },
  ]);
  assert.equal(gone, 1, "the end of the body is the gone signal, once");
  assert.deepEqual(readSseFrame("id: 3"), { id: 3, data: "" });
  assert.deepEqual(readSseFrame("id:"), { id: null, data: "" });
  assert.equal(itemKey(go), itemKey(go));
});

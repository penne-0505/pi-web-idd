import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

import {
  columnStamp, inputStamp, lastStateNumber, memoryStamp, startStateEvents, stateAnswer, stopStateEvents,
  subscribeStateFrames, type StateFrameView,
} from "../src/server/state-events.ts";
import { beginTrackedRequest, requestCount, resetReload, trackResponse } from "../src/server/reload.ts";
import { emptyOverlay } from "../src/server/derived.ts";
import { startDerivedService, stopDerivedService } from "../src/server/derived-service.ts";
import { resetStaleness, setGuiStale } from "../src/server/staleness.ts";
import { EVENTS } from "../src/routes/state-events.ts";
import { snoozeKey } from "../../../lib/idd-ui/snooze.ts";

/**
 * The state picture used to be asked for on an interval, which made the number of requests a function of how many
 * screens are open and how long they stay open (#172). These tests hold the engine to the other shape: the change is
 * found here — whichever process wrote it, and whether the clock or this process's memory moved a value — and the
 * whole picture is handed to whoever listens. Three things are checked beside the change itself: a picture that did
 * not move sends nothing, a sleeping card's hour passing is a change on its own, and a screen that reconnects is
 * handed the whole picture whatever number it carries.
 */

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_REPOS_FILE", "IDD_INTENT_DIR", "IDD_TICK_KICK"] as const;
const DAY_MS = 86_400_000;
let saved: Record<string, string | undefined> = {};

const jsonl = (rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const ev = (event: string, at: string) => ({ idd_id: "IDD-1", event, at, attrs: {} });
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  stopStateEvents();
  stopDerivedService();
  resetStaleness();
  resetReload();
});

/** a lane a planner has picked up, with one question waiting: an Inbox with a card, and a column another process can append to */
function fixture(events = ["lane_open"], derived = true): { state: string } {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const root = tmpDir("idd-state-events-");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  put(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-28T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "demo" }]));
  put(join(state, "planner-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", planner_session_id: "P1", started_at: "2026-09-28T00:00:00Z" }]));
  put(join(state, "lifecycle-demo.jsonl"), jsonl(events.map((e, i) => ev(e, `2026-09-28T00:0${i}:00Z`))));
  put(join(state, "pending-questions.jsonl"), jsonl([questionBatch("b1")]));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, "intent") });
  // the watch starts once a derivation has landed: before that the doors answer from the readers themselves, and a
  // watch that derived first would do that cold reading on the engine's own thread (the stall #172 fixed)
  if (derived) {
    startDerivedService({
      runner: {
        start(handlers) {
          handlers.onOverlay({ ...emptyOverlay(), at: new Date().toISOString() });
        },
        request() {
          // the fixture never asks for a new derivation
        },
        stop() {
          // nothing to stop
        },
      },
    });
  }
  return { state };
}

/** one question the lane's agent is waiting on: the card the tests below watch come and go */
function questionBatch(batchId: string) {
  return {
    idd_id: "IDD-1",
    batch_id: batchId,
    asked_at: "2026-09-28T00:00:00Z",
    questions: [{ question_id: "q1", question: "どちらにしますか", context: "", options: [{ index: 1, label: "A", recommendation: "recommended", rationale: "README と一致する。" }] }],
  };
}

/** the next frame that satisfies `want`, or null after a few seconds */
function waitFor(want: (frame: StateFrameView) => unknown, ms = 8_000): Promise<StateFrameView | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeStateFrames((frame) => {
      if (!want(frame)) return;
      if (timer) clearTimeout(timer);
      off();
      resolve(frame);
    });
    timer = setTimeout(() => {
      off();
      resolve(null);
    }, ms);
  });
}

test("a change another process writes reaches a listener, and a still picture sends nothing", async () => {
  const f = fixture();
  startStateEvents({ intervalMs: 20 });
  const first = await waitFor((frame) => frame.state.items.some((i) => i.kind === "question"));
  expect(first).not.toBeNull();
  expect(first!.state.items.filter((i) => i.kind === "question").length).toBe(1);

  // another process (the idd CLI, the agent's report) appends a row: the engine hears it without being asked
  const waiting = waitFor((frame) => frame.state.items.some((i) => i.kind === "question" && i.batchId === "b2"));
  appendFileSync(join(f.state, "pending-questions.jsonl"), jsonl([questionBatch("b2")]));
  const moved = await waiting;
  expect(moved).not.toBeNull();
  expect(moved!.state.items.filter((i) => i.kind === "question").length).toBe(2);

  // nothing moves: a picture derived again from the same inputs is not handed out again, however often it is asked for.
  // The low-space card is left out of the comparison: it carries the free space measured at that moment, so a machine
  // that writes while the test runs moves it by a few KB between two derivations, and that is a picture that did move.
  const frames: StateFrameView[] = [];
  const off = subscribeStateFrames((frame) => frames.push(frame));
  await stateAnswer();
  await stateAnswer();
  off();
  const withoutStorage = frames.map((frame) =>
    JSON.stringify({ ...frame.state, items: frame.state.items.filter((item) => item.kind !== "storage") }),
  );
  expect([...new Set(withoutStorage)].length).toBeLessThanOrEqual(1);
});

test("a watch with no derivation yet sends nothing, so the engine's own thread is not spent on git at startup", async () => {
  const f = fixture(["lane_open"], false);
  startStateEvents({ intervalMs: 20 });
  const frames: StateFrameView[] = [];
  const off = subscribeStateFrames((frame) => frames.push(frame));
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), `${JSON.stringify(ev("s2_ready", "2026-09-28T00:10:00Z"))}\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  off();
  expect(frames).toEqual([]);
  // the door still answers, from the readers themselves, as it did before the watch existed
  expect((await stateAnswer()).state.lanes.length).toBeGreaterThan(0);
});

test("this process's memory moves the picture without a column moving", async () => {
  fixture();
  startStateEvents({ intervalMs: 20 });
  const waiting = waitFor((frame) => frame.state.gui?.stale === true);
  setGuiStale(true);
  const moved = await waiting;
  expect(moved).not.toBeNull();
  expect(moved!.state.gui.stale).toBe(true);
  setGuiStale(false);
});

test("a sleeping card's hour passing brings it back without a column being written (AC-003)", async () => {
  const f = fixture();
  startStateEvents({ intervalMs: 20 });
  const first = await waitFor((frame) => frame.state.items.find((i) => i.kind === "question"));
  expect(first).not.toBeNull();
  const key = snoozeKey(first!.state.items.find((i) => i.kind === "question")!);

  // put off for a moment: the answer marks the card until the hour passes, then the card is back
  put(join(f.state, "inbox-snooze.json"), JSON.stringify({ entries: { [key]: { until: new Date(Date.now() + 1_500).toISOString(), at: new Date().toISOString() } }, sleeps: {} }));
  const marked = await waitFor((frame) => frame.state.items.find((i) => i.kind === "question")?.snoozedUntil);
  expect(marked).not.toBeNull();

  const back = await waitFor((frame) => {
    const item = frame.state.items.find((i) => i.kind === "question");
    return Boolean(item) && !item.snoozedUntil;
  });
  expect(back).not.toBeNull();
});

test("the tick compares the columns, the memory and the derivation; a still set of them is one string", () => {
  const f = fixture();
  const now = Date.now();
  const stamp = columnStamp();
  expect(columnStamp()).toBe(stamp);
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), `${JSON.stringify(ev("s2_ready", "2026-09-28T00:10:00Z"))}\n`);
  expect(columnStamp()).not.toBe(stamp);

  // the day's cut is part of what the answer reads from the clock, so a new day is a change on its own
  expect(memoryStamp(now)).not.toBe(memoryStamp(now + DAY_MS));
  expect(inputStamp()).toBe(inputStamp());
});

test("a connecting screen is handed the whole picture whatever number it carries", async () => {
  fixture();
  startStateEvents({ intervalMs: 20 });
  await stateAnswer();
  // a number a replaced process handed out: nothing this process could continue from
  const carried = lastStateNumber() + 100_000;
  const res = await EVENTS(new Request(`http://localhost/api/idd/events?lastEventId=${carried}`, { headers: { "last-event-id": String(carried) } }));
  expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const frame = await firstFrameOf(res);
  expect(frame.state).toBeTruthy();
  expect(frame.state.items.some((i) => i.kind === "question")).toBe(true);
  expect(frame.seq).not.toBe(carried);
  expect(frame.workSeq).toBeGreaterThan(0);
});

test("a stream a screen holds open is not counted against the engine's replacement (AC-006)", async () => {
  fixture();
  resetReload();
  const req = new Request("http://localhost/api/idd/events");
  const record = beginTrackedRequest(req);
  expect(record).not.toBeNull();
  const counted = requestCount();
  const res = await EVENTS(req);
  trackResponse(res, record!);
  expect(requestCount()).toBe(counted - 1);
  expect((await firstFrameOf(res)).state).toBeTruthy();
});

/** the first frame the stream sends: its data line, read off the body the way a screen reads it */
async function firstFrameOf(res: Response): Promise<StateFrameView> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const at = buffer.indexOf("\n\n");
    if (at < 0) continue;
    const frame = buffer.slice(0, at);
    await reader.cancel().catch(() => undefined);
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return JSON.parse(data) as StateFrameView;
  }
  throw new Error("the stream ended before a frame");
}

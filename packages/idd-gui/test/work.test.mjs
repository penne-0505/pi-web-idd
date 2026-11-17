import assert from "node:assert/strict";
import test from "node:test";

import { hashOfWork, workStateFromHash } from "../src/work/hash.ts";
import { allIntent, escapeIntent, inboxIntent, laneIntent, repoIntent, timelineRowIntent, workIntentForKey } from "../src/work/intents.ts";
import { axisTicks, clockLabel, spanPosition, timePosition, timeWindow } from "../src/work/time.ts";

test("AC-045: a hash names the screen, the selected lane and the full band; anything else is the Inbox", () => {
  assert.deepEqual(workStateFromHash("#work"), { view: "work", lane: null, all: false });
  assert.deepEqual(workStateFromHash("#work/IDD-42"), { view: "work", lane: "IDD-42", all: false });
  assert.deepEqual(workStateFromHash("#work/all"), { view: "work", lane: null, all: true });
  assert.deepEqual(workStateFromHash(""), { view: "inbox", lane: null, all: false });
  assert.deepEqual(workStateFromHash("#nonsense"), { view: "inbox", lane: null, all: false });
  assert.equal(hashOfWork({ lane: "IDD-42", all: false }), "#work/IDD-42");
  assert.equal(hashOfWork({ lane: null, all: true }), "#work/all");
});

test("AC-018: the minimap and the “すべて” control write the same open-all intent", () => {
  assert.deepEqual(allIntent(), { kind: "open_all" });
});

test("AC-020: a band row selects and closes, and Esc closes", () => {
  assert.deepEqual(timelineRowIntent("IDD-7"), { kind: "select_and_close", lane: "IDD-7" });
  assert.deepEqual(escapeIntent(), { kind: "close_all" });
  assert.deepEqual(workIntentForKey("Escape", { selection: null, all: true }), { kind: "close_all" });
  assert.equal(workIntentForKey("Escape", { selection: null, all: false }), null);
});

test("AC-027: pressing the selected row again lets it go", () => {
  assert.deepEqual(laneIntent("IDD-1", "IDD-1"), { kind: "clear_selection" });
  assert.deepEqual(laneIntent("IDD-2", "IDD-1"), { kind: "select_lane", lane: "IDD-2" });
});

test("AC-016 / AC-035: a repo row and a lane's Inbox door write their own intents", () => {
  assert.deepEqual(repoIntent(null), { kind: "select_repo", repo: null });
  assert.deepEqual(repoIntent("p"), { kind: "select_repo", repo: "p" });
  assert.deepEqual(inboxIntent("IDD-9"), { kind: "open_inbox", lane: "IDD-9" });
});

test("the time window holds the earliest span, the position is clamped, and the axis ticks span it", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const w = timeWindow(["2026-10-05T03:00:00Z"], now);
  assert.equal(w.from, Date.parse("2026-10-05T03:00:00Z"));
  assert.ok(timePosition(now, w) > 0 && timePosition(now, w) < 1, "now sits inside the window, a little ahead of it");
  assert.equal(timePosition(w.to, w), 1);
  assert.equal(timePosition(w.from, w), 0);
  assert.equal(timePosition(w.from - 10_000, w), 0);
  const span = { start: "2026-10-05T04:00:00Z" };
  assert.equal(spanPosition(span, w).to, 1, "an open span runs to the window's right edge");
  const ticks = axisTicks(w, 5);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0].pos, 0);
  assert.equal(ticks[4].pos, 1);
  assert.match(clockLabel(w.from), /^\d\d:\d\d$/);
});

test("AC-036: the Work screen shows no proposal mark and sends no proposal's action", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/work");
  const text = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  // a proposal is decided in the Inbox alone: Work neither marks a lane for one nor sends its answer
  assert.doesNotMatch(text, /proposal/i);
});

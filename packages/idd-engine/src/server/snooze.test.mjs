import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import lockfile from "proper-lockfile";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { applySnoozes, keepSleeping, readSnoozes, sleep, snooze, snoozePath, wake } = await import("./snooze.ts");
const snoozeView = await import("../../../../lib/idd-ui/snooze.ts");
const { SLEEP_NOTICE_DAYS, SNOOZE_DEFAULT_MINUTES, inboxView, nextWake, snoozeKey, splitSnoozed, wakeLabel } = snoozeView;

let dir;
const T0 = Date.parse("2026-09-24T03:00:00Z");

const go = (iddId) => ({ kind: "go", iddId, title: iddId, decisions: [], criteria: [] });
const question = (iddId, batchId) => ({ kind: "question", iddId, batchId, open: [], askedTotal: 1, answeredCount: 0 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-snooze-"));
  process.env.IDD_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("snooze keys", () => {
  it("tell a new question batch on the same lane from the one put off", () => {
    assert.notEqual(snoozeKey(question("IDD-1", "b1")), snoozeKey(question("IDD-1", "b2")));
    assert.equal(snoozeKey(go("IDD-1")), "go:IDD-1");
  });
});

describe("a card that comes again", () => {
  it("is a new decision: it does not take over the sleep or the put-off of the card before it on the same lane", async () => {
    const first = { ...go("IDD-1"), appearedAt: "2026-09-24T01:00:00Z" };
    const again = { ...go("IDD-1"), appearedAt: "2026-09-25T01:00:00Z" };
    assert.notEqual(snoozeKey(first), snoozeKey(again));
    await sleep(snoozeKey(first), T0);
    const slept = await applySnoozes([again], T0 + 1);
    assert.equal(slept[0].sleptAt, undefined);
    assert.deepEqual(readSnoozes().sleeps, {});

    await snooze(snoozeKey(first), undefined, T0);
    const put = await applySnoozes([again], T0 + 1);
    assert.equal(put[0].snoozedUntil, undefined);
    assert.deepEqual(readSnoozes().entries, {});
  });
});

describe("the deck switch", () => {
  it("closes a deck left with no card, so the next card put there does not open it by itself", () => {
    const card = go("IDD-1");
    assert.deepEqual(snoozeView.openDecksAfter({ laterOpen: false, sleepOpen: true }, { later: [], sleeping: [] }), { laterOpen: false, sleepOpen: false });
    assert.deepEqual(snoozeView.openDecksAfter({ laterOpen: true, sleepOpen: false }, { later: [], sleeping: [card] }), { laterOpen: false, sleepOpen: false });
    assert.deepEqual(snoozeView.openDecksAfter({ laterOpen: false, sleepOpen: true }, { later: [], sleeping: [card] }), { laterOpen: false, sleepOpen: true });
    assert.deepEqual(snoozeView.openDecksAfter({ laterOpen: true, sleepOpen: false }, { later: [card], sleeping: [] }), { laterOpen: true, sleepOpen: false });
  });
});

describe("putting a card off", () => {
  it("keeps it out of the front for the default six hours, then brings it back", async () => {
    assert.equal(SNOOZE_DEFAULT_MINUTES, 360);
    const until = await snooze("go:IDD-1", undefined, T0);
    assert.equal(until, new Date(T0 + 6 * 3600_000).toISOString());

    const items = await applySnoozes([go("IDD-1"), go("IDD-2")], T0 + 60_000);
    assert.equal(items[0].snoozedUntil, until);
    assert.equal(items[1].snoozedUntil, undefined);
    const { front, later } = splitSnoozed(items, T0 + 60_000);
    assert.deepEqual(front.map((i) => i.iddId), ["IDD-2"]);
    assert.deepEqual(later.map((i) => i.iddId), ["IDD-1"]);
    assert.equal(nextWake(items, T0 + 60_000), 6 * 3600_000 - 60_000);

    // the time passes on the page without a new read
    assert.deepEqual(splitSnoozed(items, T0 + 6 * 3600_000 + 1).front.map((i) => i.iddId), ["IDD-1", "IDD-2"]);
    // and a later read drops the spent entry
    const after = await applySnoozes([go("IDD-1"), go("IDD-2")], T0 + 6 * 3600_000 + 1);
    assert.equal(after[0].snoozedUntil, undefined);
    assert.deepEqual(readSnoozes().entries, {});
  });

  it("can bring a card back to the front before its time", async () => {
    await snooze("go:IDD-1", 180, T0);
    await wake("go:IDD-1");
    const items = await applySnoozes([go("IDD-1")], T0 + 1);
    assert.equal(items[0].snoozedUntil, undefined);
  });

  it("drops the entry once the card is decided (gone from the inbox)", async () => {
    await snooze("go:IDD-1", 180, T0);
    await snooze("go:IDD-2", 180, T0);
    await applySnoozes([go("IDD-2")], T0 + 1);
    assert.deepEqual(Object.keys(readSnoozes().entries), ["go:IDD-2"]);
  });

  it("lives only in its own file, not in the lane records", async () => {
    await snooze("go:IDD-1", 180, T0);
    assert.equal(snoozePath(), join(dir, "inbox-snooze.json"));
    assert.ok(existsSync(snoozePath()));
    assert.deepEqual(readdirSync(dir).filter((f) => !f.startsWith(".")).sort(), ["inbox-snooze.json"]);
    assert.ok(JSON.parse(readFileSync(snoozePath(), "utf8")).entries["go:IDD-1"]);
  });

  it("reads a broken file as nothing put off", async () => {
    writeFileSync(snoozePath(), "{not json", "utf8");
    const items = await applySnoozes([go("IDD-1")], T0);
    assert.equal(items[0].snoozedUntil, undefined);
  });
});

describe("a damaged or busy snooze file", () => {
  it("does not fail the inbox read when an entry is not an object", async () => {
    writeFileSync(snoozePath(), JSON.stringify({ entries: { "go:IDD-1": null, "go:IDD-2": { until: 5 }, "go:IDD-3": "x" } }), "utf8");
    const items = await applySnoozes([go("IDD-1"), go("IDD-2"), go("IDD-3")], T0);
    assert.deepEqual(items.map((i) => i.snoozedUntil), [undefined, undefined, undefined]);
  });

  it("takes an entries array as nothing put off, and a later snooze is kept", async () => {
    writeFileSync(snoozePath(), JSON.stringify({ entries: [] }), "utf8");
    await snooze("go:IDD-1", 180, T0);
    assert.ok(readSnoozes().entries["go:IDD-1"]);
  });

  it("keeps a card put off while the tidy-up waited for the lock", async () => {
    // an expired entry makes the read want to tidy; the card is put off again before it gets the lock
    await snooze("go:IDD-1", 1, T0 - 3600_000);
    const release = await lockfile.lock(snoozePath());
    const reading = applySnoozes([go("IDD-1")], T0);
    const file = JSON.parse(readFileSync(snoozePath(), "utf8"));
    file.entries["go:IDD-1"] = { until: new Date(T0 + 3600_000).toISOString(), at: new Date(T0).toISOString() };
    writeFileSync(snoozePath(), JSON.stringify(file), "utf8");
    await release();
    await reading;
    assert.equal(readSnoozes().entries["go:IDD-1"]?.until, new Date(T0 + 3600_000).toISOString());
  });

  it("takes many cards put off at once without losing any", async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `go:IDD-${i}`);
    const results = await Promise.allSettled(keys.map((k) => snooze(k, 180, T0)));
    assert.deepEqual(results.filter((r) => r.status === "rejected"), []);
    assert.equal(Object.keys(readSnoozes().entries).length, 30);
  });
});

const DAY = 86400_000;

describe("putting a card to sleep", () => {
  it("keeps it out of both decks and the count, never brings it back by itself, and asks a day later", async () => {
    assert.deepEqual(SLEEP_NOTICE_DAYS, [1, 3, 7]);
    await sleep("go:IDD-1", T0);
    const items = await applySnoozes([go("IDD-1"), go("IDD-2")], T0 + 60_000);
    assert.equal(items[0].sleptAt, new Date(T0).toISOString());
    assert.equal(items[0].sleepNoticeAt, new Date(T0 + DAY).toISOString());
    const view = inboxView(items, T0 + 60_000);
    assert.deepEqual(view.front.map((i) => i.iddId), ["IDD-2"]);
    assert.deepEqual(view.later, []);
    assert.deepEqual(view.sleeping.map((i) => i.iddId), ["IDD-1"]);
    assert.deepEqual(view.due, []);
    assert.equal(view.count, 1);
    // the page wakes up for the notice
    assert.equal(nextWake(items, T0 + 60_000), DAY - 60_000);

    // a day later the notice is due: it counts, and the card still sleeps
    const due = inboxView(items, T0 + DAY);
    assert.deepEqual(due.due.map((i) => i.iddId), ["IDD-1"]);
    assert.deepEqual(due.sleeping.map((i) => i.iddId), ["IDD-1"]);
    assert.deepEqual(due.front.map((i) => i.iddId), ["IDD-2"]);
    assert.equal(due.count, 2);

    // a month later it is still asleep: nothing brings it back but penne
    const month = await applySnoozes([go("IDD-1")], T0 + 30 * DAY);
    assert.deepEqual(inboxView(month, T0 + 30 * DAY).sleeping.map((i) => i.iddId), ["IDD-1"]);
  });

  it("asks again after three days, then a week, each time it is kept asleep, and then no more", async () => {
    await sleep("go:IDD-1", T0);
    const noticeAt = async (now) => (await applySnoozes([go("IDD-1")], now))[0].sleepNoticeAt;
    let now = T0 + DAY;
    await keepSleeping("go:IDD-1", now);
    assert.equal(await noticeAt(now), new Date(now + 3 * DAY).toISOString());
    now += 3 * DAY;
    await keepSleeping("go:IDD-1", now);
    assert.equal(await noticeAt(now), new Date(now + 7 * DAY).toISOString());
    now += 7 * DAY;
    await keepSleeping("go:IDD-1", now);
    const last = (await applySnoozes([go("IDD-1")], now))[0];
    assert.equal(last.sleepNoticeAt, undefined);
    assert.equal(last.sleptAt, new Date(T0).toISOString());
    const view = inboxView([last], now + 365 * DAY);
    assert.deepEqual(view.due, []);
    assert.deepEqual(view.sleeping.map((i) => i.iddId), ["IDD-1"]);
    assert.equal(nextWake([last], now), null);
  });

  it("is brought back by penne only, and replaces a put-off time", async () => {
    await snooze("go:IDD-1", 60, T0);
    await sleep("go:IDD-1", T0);
    assert.deepEqual(readSnoozes().entries, {});
    await wake("go:IDD-1");
    const items = await applySnoozes([go("IDD-1")], T0 + 1);
    assert.equal(items[0].sleptAt, undefined);
    assert.deepEqual(inboxView(items, T0 + 1).front.map((i) => i.iddId), ["IDD-1"]);
  });

  it("is dropped once the card is gone, and a damaged entry is read as awake", async () => {
    await sleep("go:IDD-1", T0);
    await sleep("go:IDD-2", T0);
    await applySnoozes([go("IDD-2")], T0 + 1);
    assert.deepEqual(Object.keys(readSnoozes().sleeps), ["go:IDD-2"]);
    writeFileSync(snoozePath(), JSON.stringify({ entries: {}, sleeps: { "go:IDD-3": null, "go:IDD-4": { at: 5 } } }), "utf8");
    const items = await applySnoozes([go("IDD-3"), go("IDD-4")], T0);
    assert.deepEqual(items.map((i) => i.sleptAt), [undefined, undefined]);
  });

  it("reads a notice time that is not a date as the ask its step would have, so the page does not wake at once again and again", async () => {
    writeFileSync(snoozePath(), JSON.stringify({ entries: {}, sleeps: {
      "go:IDD-1": { at: new Date(T0).toISOString(), step: 1, notice_at: "not a date" },
      "go:IDD-2": { at: new Date(T0).toISOString(), step: 3, notice_at: "" },
      "go:IDD-3": { at: new Date(T0).toISOString(), step: 0, notice_at: null },
    } }), "utf8");
    const sleeps = readSnoozes().sleeps;
    assert.equal(sleeps["go:IDD-1"].notice_at, new Date(T0 + 3 * DAY).toISOString());
    // past the last interval it asks no more, as when kept asleep
    assert.equal(sleeps["go:IDD-2"].notice_at, null);
    assert.equal(sleeps["go:IDD-3"].notice_at, null);
    const items = await applySnoozes([go("IDD-1"), go("IDD-2"), go("IDD-3")], T0 + 60_000);
    assert.equal(nextWake(items, T0 + 60_000), 3 * DAY - 60_000);
  });

  it("keeping asleep what is not asleep changes nothing", async () => {
    assert.equal(await keepSleeping("go:IDD-9", T0), false);
    assert.deepEqual(readSnoozes().sleeps, {});
  });
});

describe("what drives a lane", () => {
  it("never reads the inbox's put-off or sleeping state (tick, budget and the watch run in the engines)", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const hits = readdirSync(root, { recursive: true })
      // the engines' code (tick, budget and the watch) and the CLI; the engine's own server module is the
      // reader that moved here with the inbox's server
      .filter((f) => /\.(ts|mjs)$/.test(f) && !f.includes("node_modules") && !/(^|\/)test\//.test(f) && !f.startsWith("idd-engine/"))
      .filter((f) => /inbox-snooze|snoozedUntil|applySnoozes|sleptAt|sleepNoticeAt|keepSleeping/.test(readFileSync(join(root, f), "utf8")));
    assert.deepEqual(hits, []);
  });
});

describe("the time a card comes back", () => {
  it("shows the hour today and the date on another day", () => {
    const now = new Date(2026, 8, 24, 10, 0).getTime();
    assert.equal(wakeLabel(new Date(2026, 8, 24, 13, 5).toISOString(), now), "13:05");
    assert.equal(wakeLabel(new Date(2026, 8, 25, 1, 30).toISOString(), now), "9/25 1:30");
  });
});

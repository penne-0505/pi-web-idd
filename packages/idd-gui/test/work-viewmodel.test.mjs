import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";
import { fakeFetch, settle } from "./fake.mjs";

const { workVals } = await load("./src/work/viewmodel.ts");
const { WorkStore } = await load("./src/work/store.ts");
const { initialScreen, hashOfScreen, viewFromQuery, cardFromQuery } = await load("./src/screenHash.ts");
const { initialState } = await load("./src/model/model.ts");

const BASE = "2026-10-16T04:00:00+09:00";
const at = (minutes) => new Date(Date.parse(BASE) + minutes * 60_000).toISOString();

const ref = (label) => ({ kind: "github", label, url: `https://example.test/${label}` });

const L1 = {
  kind: "issue",
  id: "L1",
  repo: "p1",
  ref: ref("a#1"),
  title: "first lane",
  bundle: "running",
  turn: "go",
  spans: [
    { key: "plan", label: "計画", start: at(-60), end: at(-30), owner: "machine" },
    { key: "impl", label: "実装", start: at(-30), owner: "machine" },
  ],
  waitsFor: [],
};
const L2 = {
  kind: "issue",
  id: "L2",
  repo: "p1",
  ref: ref("a#2"),
  title: "waiting lane",
  bundle: "next",
  spans: [],
  waitsFor: [{ ref: { kind: "lane", label: "L1" }, lane: "L1" }],
};
const L3 = { kind: "issue", id: "L3", repo: "p2", ref: ref("b#3"), title: "beta lane", bundle: "running", spans: [], waitsFor: [] };
const D1 = { id: "D1", repo: "p1", ref: ref("a#0"), title: "closed lane", closedAt: at(-120), outcome: "local", decisions: 2 };

const snapshot = {
  now: at(0),
  repos: [
    { id: "p1", name: "alpha", running: 1, waiting: 1, attention: true },
    { id: "p2", name: "beta", running: 1, waiting: 0, attention: false },
  ],
  lanes: [L1, L2, L3],
  done: [D1],
  holds: [],
};
const forecast = {
  ok: true,
  generatedAt: at(0),
  usual: [
    {
      area: "p1",
      lanes: 3,
      stages: {
        plan: { median: 10, p75: 15, threshold: 30, samples: 5, basis: "repo" },
        impl: { median: 40, p75: 60, threshold: 120, samples: 5, basis: "repo" },
      },
    },
  ],
  lanes: [
    {
      iddId: "L1",
      area: "p1",
      now: { kind: "stage", stage: "impl", since: at(-30), elapsedMin: 30 },
      anomaly: true,
      eta: { at: at(120), stopsAt: "sign", remaining: [{ stage: "impl", minutes: 10 }] },
    },
  ],
};

const LANE_DETAIL = {
  iddId: "L1",
  title: "first lane",
  group: "impl",
  phaseLabel: "実装中",
  branch: "b",
  area: "p1",
  since: "now",
  undelivered: { total: 0, failed: 0 },
  contract: { decisions: [], criteria: [] },
  timeline: [],
  agents: [],
  cost: { total: 1.234, parts: [], subscription: [] },
  reviewRounds: [
    { round: 1, kind: "blind", must: 1, should: 2, nit: 1, open: 2 },
    { round: 2, kind: "blind", must: 0, should: 1, nit: 0, open: 1 },
  ],
};
const DECISIONS = {
  lane: "L1",
  own: [{ id: "C-1", title: "決めごと", place: "file a.ts, dir src", why: "理由", whyNot: [], anchored: [], free: "自由", hasPlace: true }],
  existing: [],
  dropped: 0,
  paths: [],
};
const RECORD = {
  lane: "L1",
  acceptance: [
    { id: "AC-001", statement: "s", status: "verified" },
    { id: "AC-002", statement: "s2", status: "planned" },
  ],
  log: [],
  findings: {
    placed: [
      { id: "F-1", lane: "L1", round: 2, path: "a.ts", lines: [4, 9], commit: "c", severity: "must", claim: "直す", status: "open" },
      { id: "F-2", lane: "L1", round: 1, path: "b.ts", lines: [1, 9], commit: "c", severity: "should", claim: "却下された", status: "dropped" },
      { id: "F-3", lane: "L1", round: 1, path: "c.ts", lines: [8, 20], commit: "c", severity: "should", claim: "次の lane へ渡す", status: "open" },
    ],
    // the engine's other per-finding list: what was handed to this lane. F-1 is its own, so it stays on the place side
    delivered: [
      { id: "F-1", lane: "L1", round: 2, path: "a.ts", lines: [4, 9], commit: "c", severity: "must", claim: "直す", status: "open" },
      { id: "F-4", lane: "L0", round: 1, path: "d.ts", lines: [3, 3], commit: "c", severity: "should", claim: "渡された未処置の指摘", status: "open" },
    ],
    disposals: [],
  },
};
const DETAIL = { lane: LANE_DETAIL, decisions: DECISIONS, record: RECORD, error: null };

const SPEND = { cost: 8.76, units: 3, buckets: [], failures: {} };
const build = (state, detail = null, consumption = SPEND) => workVals(state, () => {}, { snapshot, forecast, consumption, detail });

// ------------------------------------------------------------------ AC-001
test("AC-001: the lane rows, bundles, order and repos come from the engine's answer alone", () => {
  const m = build({});
  assert.deepEqual(
    m.W.list.map((r) => [r.ref, r.t]),
    [
      ["a#1", "first lane"],
      ["a#2", "waiting lane"],
    ],
    "the running lane first, then the next one, in the engine's order",
  );
  assert.equal(m.W.list[1].hasDiv, true);
  assert.equal(m.W.list[1].div, "次に入る");
  assert.equal(m.W.list[1].tc, "var(--ink-2)");
  assert.deepEqual(m.W.projs.map((p) => p.t), ["すべて", "alpha", "beta"]);
  assert.deepEqual(m.W.doneRows.map((r) => [r.ref, r.n]), [["a#0", "2"]]);
  assert.equal(m.W.nDone, "1");
  assert.equal(m.W.sum.line, "動いている 1 · 待ち 1 · 済み 1");
  assert.deepEqual(m.W.groups.map((g) => g.p), ["alpha", "beta"]);
  assert.ok(!JSON.stringify(m.W).includes("#138"), "no sample lane is drawn");
  assert.ok(!JSON.stringify(m.WOv).includes("#138"));
});

test("AC-001: no selection draws no detail, and no engine answer draws nothing at all", () => {
  const none = build({});
  assert.equal(none.W.hasSel, false);
  assert.equal(none.W.noSel, true);
  assert.equal(none.W.d.ref, "");
  assert.deepEqual(none.W.d.decs, []);

  const empty = workVals({}, () => {}, { snapshot: null, forecast: null, consumption: null, detail: null });
  assert.deepEqual(empty.W.list, []);
  assert.deepEqual(empty.W.groups, []);
  assert.deepEqual(empty.W.projs.map((p) => p.t), ["すべて"]);
  assert.equal(empty.W.d.ref, "");
});

test("AC-001: the repo's own rows are what the engine sent for it", () => {
  const m = build({ wproj: "p2" });
  assert.deepEqual(m.W.list.map((r) => r.ref), ["b#3"]);
  assert.equal(m.W.d.p, "beta");
  assert.equal(m.W.askT, "beta について聞く");
  assert.equal(m.W.projs[2].bg, "var(--surface)", "the selected repo's row carries the mark");
  assert.equal(m.W.projs[2].f, false);
  assert.equal(m.W.projs[1].f, true, "the attention dot comes from the repo's own answer");
});

// ------------------------------------------------------------------ AC-002
test("AC-002: selecting a lane draws the three tabs from the detail, the decisions and the record", () => {
  const m = build({ wsel: "L1", wtab: "dec" }, DETAIL);
  assert.equal(m.W.hasSel, true);
  assert.equal(m.W.noSel, false);
  assert.equal(m.W.d.ref, "a#1");
  assert.equal(m.W.d.t, "first lane");
  assert.equal(m.W.d.live, true);
  assert.equal(m.W.tDec, true);
  assert.equal(m.W.tabs[1].n, "1");

  const dec = m.W.d.decs[0];
  assert.equal(dec.id, "C-1");
  assert.deepEqual(dec.anchors.map((a) => a.x), ["file a.ts", "dir src"]);
  assert.equal(dec.why, "理由");
  assert.equal(dec.hasRep, false, "the replaced-by has no engine value");
  assert.deepEqual([dec.f1, dec.f2, dec.f3], ["var(--line-strong)", "var(--line-strong)", "var(--line-strong)"], "the Change freedom level is empty");
  assert.equal(dec.fl, "");

  assert.equal(m.W.d.acN, "1 / 2");
  assert.equal(m.W.d.acs.filter((a) => a.bg === "var(--ok)").length, 1);
  assert.equal(m.W.d.cost, "$1.23");
  // the judgement's accepted count is must + should + nit: the open part is already inside it (C-151-4)
  assert.deepEqual(m.W.d.rounds.map((r) => [r.r, r.n]), [["R1", "4"], ["R2", "1"]]);

  const open = m.W.d.open;
  assert.equal(open.length, 1);
  assert.equal(open[0].sev, "should");
  assert.equal(open[0].loc, "d.ts:3");
  assert.equal(open[0].r, "R1");
  assert.equal(open[0].text, "渡された未処置の指摘");
  assert.equal(m.W.d.nOpen, "1");

  // every open finding the lane placed is one a later lane is handed, round or no round (C-151-5)
  assert.equal(m.W.d.hasPin, true);
  assert.equal(m.W.d.pins.length, 2);
  assert.equal(m.W.d.pins[0].loc, "a.ts L4–9");
  assert.equal(m.W.d.pins[1].loc, "c.ts L8–20");
  assert.equal(m.W.d.pins.every((f) => f.r === ""), true, "a place finding carries no round on the place side");
  assert.equal(m.W.d.fixed, "2", "R1 fixed 4-2, R2 fixed 1-1: the dropped finding is not a fix (C-151-4)");
  assert.equal(m.W.d.nFd, "3", "the two place findings and the handed one, and the dropped finding nowhere (C-151-5)");
  assert.equal(m.W.tabs[2].n, "3");
});

test("AC-002: a lane with no detail reads shows the places empty", () => {
  const m = build({ wsel: "L1" }, null);
  assert.equal(m.W.hasSel, true);
  assert.deepEqual(m.W.d.decs, []);
  assert.equal(m.W.d.noDec, true);
  assert.equal(m.W.d.acN, "");
  assert.equal(m.W.d.pr, undefined);
  assert.equal(m.W.d.noFd, true);
  assert.equal(m.W.d.hasPin, false);
});

test("AC-002: a done lane's detail comes from the same doors and keeps its own finish", () => {
  const m = build({ wsel: "D1" }, DETAIL);
  assert.equal(m.W.hasSel, true);
  assert.equal(m.W.d.isDone, true);
  assert.equal(m.W.d.live, false);
  assert.equal(m.W.d.eta, "済み 10/16");
  assert.equal(m.W.d.at, "10/16 02:00");
  // the three tabs carry the same engine values a running lane shows: DECs, ACs, findings and cost
  assert.equal(m.W.tabs[1].n, "1");
  assert.equal(m.W.d.decs[0].id, "C-1");
  assert.equal(m.W.d.acN, "1 / 2");
  assert.equal(m.W.d.cost, "$1.23");
  assert.equal(m.W.d.nFd, "3");
  assert.equal(m.W.d.nOpen, "1");
});

// ------------------------------------------------------------------ AC-003
test("AC-003: the finish, the usual length and the anomaly appear only for the lane the forecast returned", () => {
  const m = build({});
  const l1 = m.W.list.find((r) => r.ref === "a#1");
  const l2 = m.W.list.find((r) => r.ref === "a#2");

  assert.match(l1.eta, /^≈ \d\d:\d\d$/);
  assert.equal(l1.etaT, l1.eta.replace("≈ ", ""));
  assert.equal(l1.ec, "var(--attention-text)", "the anomaly turns the finish red");
  assert.equal(l1.rowBg, "var(--attention-bg-soft)");
  assert.equal(l1.hasUsual, true, "the usual length of the running stage is drawn");
  assert.notEqual(l1.u0, l1.u1);

  assert.equal(l2.eta, "", "no forecast entry, no finish");
  assert.equal(l2.etaT, "");
  assert.equal(l2.ec, "var(--ink)", "no forecast entry, no red");
  assert.equal(l2.rowBg, "transparent");
  assert.equal(l2.hasUsual, false);
  assert.equal(l2.hasFail, false, "the engine returns no failure time");
});

test("AC-003: the anomaly also names the lane in the repo summary", () => {
  const m = build({});
  assert.deepEqual(m.W.sum.attn.map((a) => a.ref), ["a#1", "a#2"]);
  assert.equal(m.W.sum.attn[0].gGo, true, "the engine's person turn is GO");
  assert.match(m.W.sum.attn[0].why, /GO/);
  assert.equal(m.W.sum.attn[1].gBlock, true, "the wait the engine reported is drawn");
  assert.match(m.W.sum.attn[1].why, /L1/);
});

test("DEC-103-5: a person's turn without a shape of its own still carries the common mark", () => {
  const stuck = { ...L2, id: "L4", ref: ref("a#4"), title: "stuck lane", turn: "stuck", waitsFor: [] };
  const m = workVals({}, () => {}, { snapshot: { ...snapshot, lanes: [...snapshot.lanes, stuck] }, forecast: null, consumption: null, detail: null });
  const row = m.W.sum.attn.find((a) => a.ref === "a#4");
  assert.ok(row, "the lane at a person's turn is listed");
  assert.equal(row.gBlock, true, "the common mark says something waits");
  assert.equal(row.gQuestion, false, "only an answer it waits on takes the question mark");
  assert.match(row.why, /行き詰まり/);
});

test("AC-003: a stalled lane never takes the anomaly's red mark", () => {
  const stalledTurn = { ...L2, id: "L4", ref: ref("a#4"), title: "stalled at a person's turn", turn: "stuck", activity: "stalled", waitsFor: [] };
  const stalledAlone = { ...L2, id: "L5", ref: ref("a#5"), title: "stalled machine", activity: "stalled", waitsFor: [] };
  const stalledLong = { ...L2, id: "L6", ref: ref("a#6"), title: "stalled and over its usual", activity: "stalled", waitsFor: [] };
  const m = workVals({}, () => {}, {
    snapshot: { ...snapshot, lanes: [...snapshot.lanes, stalledTurn, stalledAlone, stalledLong] },
    forecast: { ...forecast, lanes: [...forecast.lanes, { iddId: "L6", area: "p1", anomaly: true, eta: { at: at(60), stopsAt: "sign", remaining: [] } }] },
    consumption: null,
    detail: null,
  });

  const turnRow = m.W.sum.attn.find((a) => a.ref === "a#4");
  assert.ok(turnRow, "the stalled lane at a person's turn is listed");
  assert.equal(turnRow.gLong, false, "a stalled lane never takes the anomaly's red mark");
  assert.equal(turnRow.gBlock, true, "the common mark says something waits");
  assert.match(turnRow.why, /行き詰まり/);

  const aloneRow = m.W.sum.attn.find((a) => a.ref === "a#5");
  assert.ok(aloneRow, "a stopped machine is still something to mind");
  assert.equal(aloneRow.gLong, false, "the stall alone is not the engine's anomaly");
  assert.equal(aloneRow.gBlock, true, "it takes the common mark instead");
  assert.match(aloneRow.why, /止まっている/);

  const longRow = m.W.sum.attn.find((a) => a.ref === "a#6");
  assert.equal(longRow.gLong, true, "the red mark comes from the engine's own anomaly, not from the stall");
});

// ------------------------------------------------------------------ AC-001 (the usual mark reads the forecast's own stage)
const stat = (median, p75, threshold) => ({ median, p75, threshold, samples: 5, basis: "repo" });
const USUAL = {
  plan: stat(10, 15, 30),
  plan_review: stat(20, 30, 60),
  impl: stat(30, 45, 90),
  review: stat(60, 90, 180),
  fix: stat(50, 75, 150),
  checks: stat(70, 105, 210),
  land: stat(40, 60, 120),
};

/** one running lane whose open band row carries a key the usual table does not (`review_round`) */
const KEYED = {
  kind: "issue",
  id: "LK",
  repo: "p1",
  ref: ref("a#9"),
  title: "keyed lane",
  bundle: "running",
  spans: [
    { key: "impl", label: "実装", start: at(-300), end: at(-200), owner: "machine" },
    { key: "review_round", label: "レビューの巡", start: at(-200), owner: "machine" },
  ],
  waitsFor: [],
};
const STAGE_AT = { kind: "stage", stage: "review", since: at(-200), elapsedMin: 200 };

/** the one-lane world the usual-mark tests read: `now: null` leaves the forecast with no lane at all */
const keyed = (state, { now = STAGE_AT, anomaly = false, usual = USUAL, lane = KEYED } = {}) =>
  workVals(state, () => {}, {
    snapshot: { now: at(0), repos: [{ id: "p1", name: "alpha", running: 1, waiting: 0, attention: false }], lanes: [lane], done: [], holds: [] },
    forecast: {
      ok: true,
      generatedAt: at(0),
      usual: usual === null ? [] : [{ area: "p1", lanes: 1, stages: usual }],
      lanes: now === null ? [] : [{ iddId: lane.id, area: "p1", now, anomaly, eta: { at: at(100), stopsAt: "sign", remaining: [] } }],
    },
    consumption: null,
    detail: null,
  });

test("AC-001: the usual mark is the forecast's own stage, drawn on the band's open row", () => {
  const m = keyed({ wsel: "LK" });
  const row = m.W.list.find((r) => r.ref === "a#9");
  assert.equal(row.hasUsual, true, "the running stage's usual length is drawn on the lane's row");
  assert.notEqual(row.u0, row.u1);

  const rows = m.W.d.stages;
  assert.deepEqual(rows.map((s) => s.n), ["実装", "レビューの巡"], "the band's stage names are not rewritten");
  assert.equal(rows[0].hasUs, false, "a past row carries no usual mark");
  assert.equal(rows[1].hasUs, true, "the row the lane stands on carries it");
  assert.equal(rows[1].ux, Math.round(60 * 1.7), "the value is the forecast's `review` median, not the band key's");
});

test("AC-001: every stage the forecast can name draws the mark, and the row keeps the band's name", () => {
  for (const [stage, s] of Object.entries(USUAL)) {
    const m = keyed({ wsel: "LK" }, { now: { kind: "stage", stage, since: at(-200), elapsedMin: 20 } });
    assert.equal(m.W.list[0].hasUsual, true, `${stage}: the strip draws the mark`);
    assert.equal(m.W.d.stages[1].n, "レビューの巡", `${stage}: the row is not renamed`);
    assert.equal(m.W.d.stages[1].hasUs, true, `${stage}: the row the lane stands on carries the mark`);
    assert.equal(m.W.d.stages[1].ux, Math.round(s.median * 1.7), `${stage}: the value follows the forecast's stage`);
  }
});

test("AC-001: a lane at a gate or a wait, and a lane the forecast did not return, get no usual mark", () => {
  const nowhere = [
    { kind: "gate", gate: "go", since: at(-200), elapsedMin: 200 },
    { kind: "gate", gate: "question", since: at(-200), elapsedMin: 200 },
    { kind: "wait", wait: "order", since: at(-200), elapsedMin: 200 },
    { kind: "wait", wait: "outside", since: at(-200), elapsedMin: 200 },
  ];
  for (const now of nowhere) {
    const what = now.gate ?? now.wait;
    const m = keyed({ wsel: "LK" }, { now });
    assert.equal(m.W.list[0].hasUsual, false, `${what}: no mark on the lane's row`);
    assert.ok(m.W.d.stages.every((s) => !s.hasUs), `${what}: no mark in the stage table`);
  }

  const unreturned = keyed({ wsel: "LK" }, { now: null });
  assert.equal(unreturned.W.list[0].hasUsual, false, "no forecast entry, no mark");
  assert.ok(unreturned.W.d.stages.every((s) => !s.hasUs));

  const noTable = keyed({ wsel: "LK" }, { usual: null });
  assert.equal(noTable.W.list[0].hasUsual, false, "no usual table for the area, no mark");
  assert.ok(noTable.W.d.stages.every((s) => !s.hasUs));
});

test("AC-001: the over-red is the engine's anomaly and sits on the running row alone", () => {
  const over = keyed({ wsel: "LK" }, { now: { kind: "stage", stage: "review", since: at(-200), elapsedMin: 400 }, anomaly: true });
  assert.equal(over.W.d.stages[1].c, "var(--attention)", "the engine's anomaly colours the running row");
  assert.equal(over.W.d.stages[0].c, "var(--mute-1)", "a past row never takes it");
  assert.equal(over.W.list[0].rowBg, "var(--attention-bg-soft)", "the lane's row shows the anomaly");
  assert.equal(over.W.list[0].ec, "var(--attention-text)");

  const plain = keyed({ wsel: "LK" }, { now: { kind: "stage", stage: "review", since: at(-200), elapsedMin: 400 }, anomaly: false });
  assert.equal(plain.W.d.stages[1].c, "var(--mute-1)", "no anomaly, no red, however long the stage runs");
  assert.equal(plain.W.list[0].rowBg, "transparent");
});

// ------------------------------------------------------------------ AC-002 (a missing field empties its own place alone)
test("AC-002: a forecast answer that carried no usual table and no lanes is read as empty", () => {
  const m = workVals({ wsel: "L1", wtab: "fd" }, () => {}, { snapshot, forecast: { ok: true }, consumption: SPEND, detail: DETAIL });
  assert.deepEqual(m.W.list.map((r) => r.ref), ["a#1", "a#2"], "the lanes are still drawn");
  assert.equal(m.W.list[0].hasUsual, false);
  assert.equal(m.W.list[0].eta, "", "no forecast entry, no finish");
  assert.equal(m.W.list[1].ec, "var(--ink)", "no forecast entry, no red");
  assert.equal(m.W.d.eta, "", "the detail's finish is empty too");
  assert.equal(m.W.d.nFd, "3", "the record is still read");
  assert.equal(m.W.d.rounds.length, 2);
  assert.ok(m.W.d.stages.every((s) => !s.hasUs));
});

test("AC-002: a lane's own fields can be missing and only their places go empty", () => {
  const bare = { kind: "issue", id: "B1", repo: "p1", title: "bare lane", bundle: "running" };
  const m = workVals({ wsel: "B1" }, () => {}, {
    snapshot: { now: at(0), repos: snapshot.repos, lanes: [bare], done: [], holds: [] },
    forecast: { ok: true, generatedAt: at(0), usual: [], lanes: [{ iddId: "B1", area: "p1", anomaly: false }] },
    consumption: null,
    detail: { lane: {}, decisions: {}, record: {}, error: null },
  });

  assert.equal(m.W.list[0].ref, "B1", "no ref label: the id stands in");
  assert.deepEqual(m.W.list[0].bars, [], "no spans: no bars");
  assert.equal(m.W.list[0].hasUsual, false, "no now: no usual mark");
  assert.equal(m.W.sum.attn.length, 0, "no waits, no turn, no activity: nothing to mind");
  assert.deepEqual(m.W.d.stages, []);
  assert.equal(m.W.d.hasStages, false);
  assert.equal(m.W.d.decs.length, 0, "a decisions answer with no lists is empty");
  assert.equal(m.W.d.nDec, "0");
  assert.equal(m.W.d.noFd, true, "a record answer with no findings draws the empty tab");
  assert.equal(m.W.d.nFd, "0");
  assert.equal(m.W.d.fixed, "0");
  assert.deepEqual(m.W.d.rounds, [], "a detail with no rounds draws no round row");
});

test("AC-002: one lane's missing forecast field leaves the other lanes' values in place", () => {
  const m = workVals({}, () => {}, {
    snapshot: { now: at(0), repos: snapshot.repos, lanes: snapshot.lanes, done: [], holds: [] },
    forecast: {
      ok: true,
      generatedAt: at(0),
      usual: forecast.usual,
      // L1's entry carries no eta and no now; L2's carries what the engine would send
      lanes: [
        { iddId: "L1", area: "p1", anomaly: false },
        { iddId: "L2", area: "p1", now: { kind: "stage", stage: "impl", since: at(-10), elapsedMin: 10 }, anomaly: true, eta: { at: at(60), stopsAt: "sign", remaining: [] } },
      ],
    },
    consumption: null,
    detail: null,
  });

  const l1 = m.W.list.find((r) => r.ref === "a#1");
  const l2 = m.W.list.find((r) => r.ref === "a#2");
  assert.equal(l1.eta, "", "L1's finish is empty");
  assert.equal(l1.ec, "var(--ink)", "L1's entry says nothing about an anomaly");
  assert.match(l2.eta, /^≈ \d\d:\d\d$/, "L2's finish is still drawn");
  assert.equal(l2.ec, "var(--attention-text)", "L2's anomaly is still drawn red");
  assert.equal(l2.hasUsual, true, "L2's usual length is still drawn");
});

// ------------------------------------------------------------------ AC-003 (two lanes may share one ref label)
test("AC-003: two lanes with the same ref label are drawn as their own rows", () => {
  const twin = { ...L1, id: "L9", title: "twin lane", spans: [{ key: "plan", label: "計画", start: at(-90), end: at(-60), owner: "machine" }] };
  const m = workVals({}, () => {}, {
    snapshot: { now: at(0), repos: snapshot.repos, lanes: [L1, twin], done: [], holds: [] },
    forecast: null,
    consumption: null,
    detail: null,
  });

  assert.deepEqual(m.W.list.map((r) => r.ref), ["a#1", "a#1"], "both rows really do carry the same label");
  assert.deepEqual(m.W.list.map((r) => r.t), ["first lane", "twin lane"], "each row shows its own lane's title");
  assert.notDeepEqual(m.W.list[0].bars, m.W.list[1].bars, "each row shows its own lane's bars");

  const picked = workVals({ wsel: "L9" }, () => {}, {
    snapshot: { now: at(0), repos: snapshot.repos, lanes: [L1, twin], done: [], holds: [] },
    forecast: null,
    consumption: null,
    detail: null,
  });
  assert.deepEqual(picked.W.list.map((r) => r.fw), [400, 600], "the selected twin alone takes the weight");
  assert.deepEqual(picked.W.list.map((r) => r.selSh), ["none", "0 0 0 1.5px var(--ink)"]);
});

// ------------------------------------------------------------------ AC-004 (the findings tab counts what the engine said)
test("AC-004: the round's count is its accepted findings and the open part is not counted twice", () => {
  const m = workVals({ wsel: "L1", wtab: "fd" }, () => {}, {
    snapshot,
    forecast,
    consumption: null,
    detail: { lane: { ...LANE_DETAIL, reviewRounds: [{ round: 1, kind: "blind", must: 1, should: 2, nit: 1, open: 2 }] }, decisions: null, record: RECORD, error: null },
  });
  assert.deepEqual(m.W.d.rounds.map((r) => r.n), ["4"], "1+2+1 accepted, with the 2 open already inside it");
  assert.equal(m.W.d.rounds[0].segs.length, 6, "the bar still paints the 4 accepted and the 2 open");
  assert.equal(m.W.d.fixed, "2", "4 accepted less 2 open");
});

test("AC-004: a dropped finding shows in no section and is counted in no total", () => {
  const m = workVals({ wsel: "L1", wtab: "fd" }, () => {}, {
    snapshot,
    forecast,
    consumption: null,
    detail: { lane: LANE_DETAIL, decisions: null, record: RECORD, error: null },
  });
  const drawn = [...m.W.d.open, ...m.W.d.pins].map((f) => f.text);
  assert.deepEqual(drawn, ["渡された未処置の指摘", "直す", "次の lane へ渡す"], "only the open findings are drawn");
  assert.ok(!drawn.includes("却下された"), "the dropped finding is drawn nowhere");
  assert.equal(m.W.d.nOpen, "1");
  assert.equal(m.W.d.pins.length, 2);
  assert.equal(m.W.d.nFd, "3");
  assert.equal(m.W.tabs[2].n, "3", "the tab counts the findings it draws");
  assert.equal(m.W.d.fixed, "2");
});

test("AC-004: an open place finding is the one handed to the next lane, whatever round it came from", () => {
  // the engine writes every place finding with the round it came from, so a round never separates the sections:
  // every open finding the lane placed is place-attached (C-151-5)
  const record = { lane: "L1", acceptance: [], log: [], findings: { placed: [{ id: "F-7", lane: "L1", round: 3, path: "a.ts", lines: [2, 8], commit: "c", severity: "should", claim: "次の lane へ", status: "open" }], delivered: [], disposals: [] } };
  const m = workVals({ wsel: "L1", wtab: "fd" }, () => {}, { snapshot, forecast, consumption: null, detail: { lane: LANE_DETAIL, decisions: null, record, error: null } });
  assert.deepEqual(m.W.d.pins.map((f) => f.text), ["次の lane へ"]);
  assert.deepEqual(m.W.d.open, [], "a place-attached finding is never also drawn as remaining");
});

test("AC-004: the findings handed to the lane are the remaining ones, and none is drawn on both sides", () => {
  const own = { id: "F-1", lane: "L1", round: 2, path: "a.ts", lines: [4, 9], commit: "c", severity: "must", claim: "直す", status: "open" };
  const handed = { id: "F-9", lane: "L0", round: 1, path: "e.ts", lines: [5, 5], commit: "c", severity: "should", claim: "渡された指摘", status: "open" };
  const record = { lane: "L1", acceptance: [], log: [], findings: { placed: [own], delivered: [own, handed], disposals: [] } };
  const m = workVals({ wsel: "L1", wtab: "fd" }, () => {}, { snapshot, forecast, consumption: null, detail: { lane: LANE_DETAIL, decisions: null, record, error: null } });
  assert.deepEqual(m.W.d.open.map((f) => f.text), ["渡された指摘"], "the handed finding is the remaining one");
  assert.deepEqual(m.W.d.pins.map((f) => f.text), ["直す"], "the lane's own finding stays on the place side");
  assert.equal(new Set([...m.W.d.open, ...m.W.d.pins].map((f) => f.text)).size, 2, "no finding is drawn on both sides");
});

test("AC-004: a lane with only dropped findings draws them nowhere and counts no fix", () => {
  const record = { lane: "L1", acceptance: [], log: [], findings: { placed: [{ id: "F-9", lane: "L1", path: "a.ts", lines: null, commit: "c", severity: "should", claim: "消えた", status: "dropped" }], delivered: [], disposals: [] } };
  const m = workVals({ wsel: "L1", wtab: "fd" }, () => {}, {
    snapshot: { ...snapshot, lanes: [L1], repos: snapshot.repos },
    forecast: { ok: true, generatedAt: at(0), usual: [], lanes: [] },
    consumption: null,
    detail: { lane: { ...LANE_DETAIL, reviewRounds: [] }, decisions: null, record, error: null },
  });
  assert.equal(m.W.d.nFd, "0");
  assert.equal(m.W.d.nOpen, "0");
  assert.deepEqual(m.W.d.pins, []);
  assert.equal(m.W.d.noFd, true, "nothing is left to draw on the tab");
  assert.equal(m.W.d.fixed, "0");
});

// ------------------------------------------------------------------ AC-005 (a lane waiting on an answer)
test("AC-005: a lane waiting on an answer takes the question mark, not the common one", () => {
  const question = { ...L2, id: "LQ", ref: ref("a#7"), title: "question lane", turn: "question", waitsFor: [] };
  const m = workVals({}, () => {}, { snapshot: { ...snapshot, lanes: [L1, question], done: [], holds: [] }, forecast: null, consumption: null, detail: null });
  const row = m.W.sum.attn.find((a) => a.ref === "a#7");
  assert.ok(row, "the lane waiting on an answer is listed");
  assert.equal(row.gQuestion, true, "the question mark is the one it takes");
  assert.equal(row.gBlock, false);
  assert.match(row.why, /質問/);

  // the other marks are untouched: GO, the signature, the long lane and the other person's turns
  const marks = { ...L1, id: "LG", ref: ref("a#8"), title: "go lane", turn: "go", waitsFor: [] };
  const g = workVals({}, () => {}, { snapshot: { ...snapshot, lanes: [marks], done: [], holds: [] }, forecast: { ok: true, generatedAt: at(0), usual: [], lanes: [{ iddId: "LG", area: "p1", anomaly: true, eta: { at: null, stopsAt: null, remaining: [] } }] }, consumption: null, detail: null });
  assert.equal(g.W.sum.attn[0].gGo, true);
  assert.equal(g.W.sum.attn[0].gQuestion, false, "GO keeps its own mark");
});

// ------------------------------------------------------------------ the mini map (the names and the rows)
const repo = (id, name, lanes = 0) => ({ id, name, running: lanes, waiting: 0, attention: false });

/** one snapshot of the mini map alone: no forecast, no selection, no consumption */
const mini = (repos, lanes) => workVals({}, () => {}, { snapshot: { now: at(0), repos, lanes, done: [], holds: [] }, forecast: null, consumption: null, detail: null });

const laneIn = (id, repoId, n) => ({ ...L1, id, repo: repoId, ref: ref(`${repoId}#${n}`), waitsFor: [] });

test("AC-001: a repo with no lane keeps a name row, so the mini map's names never come closer than 12px", () => {
  const repos = [repo("p1", "pi-web-idd", 1), repo("e0", "daysai-flutter"), repo("e1", "daysai-web"), repo("e2", "daysai-management"), repo("e3", "waydroid_mpris")];
  const m = mini(repos, [laneIn("L1", "p1", 1)]);

  assert.equal(m.W.mLabels.length, 5, "every repo keeps its name, lanes or none");
  assert.deepEqual(m.W.mLabels.map((l) => l.full), ["pi-web-idd", "daysai-flutter", "daysai-web", "daysai-management", "waydroid_mpris"], "the whole name is on the label, for hover");
  assert.ok(m.W.mLabels.every((l) => l.t.length > 0), "every repo draws a name");
  assert.deepEqual(m.W.mLabels.map((l) => l.y), [0, 12, 24, 36, 48], "an empty repo takes one row plus the 6px gap");
  for (let i = 1; i < m.W.mLabels.length; i += 1) {
    assert.ok(m.W.mLabels[i].y - m.W.mLabels[i - 1].y >= 12, `${m.W.mLabels[i].t} keeps at least a lane row below ${m.W.mLabels[i - 1].t}`);
  }
  assert.equal(m.W.mH, 54, "the last empty repo's row is counted in the height");
});

// ------------------------------------------------------------------ the names that share a head
test("the mini map's drawn names stay apart when every repo shares a long prefix", () => {
  const repos = [repo("p1", "pi-web-idd", 1), repo("e0", "daysai-flutter"), repo("e1", "daysai-web"), repo("e2", "daysai-management"), repo("e3", "waydroid_mpris")];
  const m = mini(repos, [laneIn("L1", "p1", 1)]);
  const drawn = m.W.mLabels.map((l) => l.t);

  assert.equal(new Set(drawn).size, drawn.length, `no two names read the same: ${JSON.stringify(drawn)}`);
  assert.deepEqual(drawn, ["pi-w…idd", "days…ter", "days…web", "days…ent", "wayd…ris"], "a long name keeps both its head and its tail");
  // the 47px column holds eight glyphs of the 9px mono face: a ninth glyph would be the mark's place
  assert.ok(m.W.mLabels.every((l) => l.t.length <= 8), "every drawn name fits the column's eight 9px glyphs");
  assert.ok(m.W.mLabels.every((l) => l.t.length <= l.full.length), "a name is never made longer");
});

test("AC-001: more empty repos stretch the strip by a row each, never squeezing the names", () => {
  const one = mini([repo("p1", "a", 1), repo("e0", "b")], [laneIn("L1", "p1", 1)]);
  const many = mini([repo("p1", "a", 1), repo("e0", "b"), repo("e1", "c"), repo("e2", "d")], [laneIn("L1", "p1", 1)]);
  const gaps = (m) => m.W.mLabels.slice(1).map((l, i) => l.y - m.W.mLabels[i].y);
  assert.deepEqual(gaps(one), [12]);
  assert.deepEqual(gaps(many), [12, 12, 12], "the gap a name keeps does not shrink as the count grows");
  assert.ok(many.W.mH > one.W.mH, "each extra empty repo takes its own row");
});

test("AC-002: every repo holding lanes keeps the prototype's 6px rows and 6px gaps", () => {
  const lanes = [
    ...Array.from({ length: 6 }, (_, i) => laneIn(`A${i}`, "p1", i)),
    ...Array.from({ length: 2 }, (_, i) => laneIn(`B${i}`, "p2", i)),
    ...Array.from({ length: 2 }, (_, i) => laneIn(`C${i}`, "p3", i)),
  ];
  const m = mini([repo("p1", "propter", 6), repo("p2", "medo", 2), repo("p3", "meltly", 2)], lanes);

  assert.deepEqual(m.W.mLabels.map((l) => l.y), [0, 42, 60], "6 lanes then a gap, 2 lanes then a gap");
  assert.equal(m.W.mH, 72);
  assert.deepEqual([...new Set(m.W.mBars.map((b) => b.y))], [0, 6, 12, 18, 24, 30, 42, 48, 60, 66], "one row every 6px");
  assert.ok(m.W.mBars.every((b) => b.l >= 52), "every band starts at the prototype's 52px");
  assert.ok(m.W.mBars.every((b) => b.l + b.w <= 304), "every band ends inside the prototype's 252px");
});

test("AC-002: the selected lane's frame sits on its own row, 49px from the left", () => {
  const m = mini([repo("p1", "a", 2), repo("p2", "b", 1)], [laneIn("L1", "p1", 1), laneIn("L2", "p1", 2), laneIn("L3", "p2", 3)]);
  const none = m.W.mSel;
  assert.deepEqual(none, [], "no selection draws no frame");
  const picked = workVals({ wsel: "L2" }, () => {}, { snapshot: { now: at(0), repos: [repo("p1", "a", 2), repo("p2", "b", 1)], lanes: [laneIn("L1", "p1", 1), laneIn("L2", "p1", 2), laneIn("L3", "p2", 3)], done: [], holds: [] }, forecast: null, consumption: null, detail: null });
  assert.deepEqual(picked.W.mSel, [{ y: 6 }], "the frame is on the selected lane's row");
});

// ------------------------------------------------------------------ AC-004
test("AC-004: every operation stays in the screen and the detail has no action button", async () => {
  const f = fakeFetch();
  const store = new WorkStore(f.fetchFn, () => Date.parse(BASE));
  const read = store.read();
  f.of("/api/idd/work").at(-1).respond(200, snapshot);
  f.of("/api/idd/forecast").at(-1).respond(200, forecast);
  f.calls.filter((c) => c.path.startsWith("/api/idd/work/consumption")).at(-1).respond(200, { rows: [], summary: SPEND });
  await read;
  await settle();

  const before = f.calls.length;
  const ops = [];
  const m = workVals({ wsel: "L1", wopen: false, wdone: false, wtab: "st" }, (u) => ops.push(u), { snapshot, forecast, consumption: SPEND, detail: DETAIL });
  m.W.projs.forEach((p) => p.go());
  m.W.tabs.forEach((t) => t.go());
  m.W.list.forEach((r) => r.go?.());
  m.W.doneRows.forEach((r) => r.go());
  m.W.sum.attn.forEach((r) => r.go());
  m.W.sum.next.forEach((r) => r.go());
  m.W.sum.done.forEach((r) => r.go());
  m.W.ctx.forEach((r) => r.go?.());
  m.WOv.groups.forEach((g) => g.rows.forEach((r) => r.go?.()));
  m.W.togDone();
  m.W.openOv();
  m.W.closeOv();

  assert.ok(ops.length > 0, "the screen's operations change its own state");
  assert.equal(f.calls.length, before, "no operation calls the engine");
  for (const call of f.calls) assert.equal(call.init?.method, undefined, `${call.path} must stay a GET`);

  assert.equal(m.W.d.aStop, undefined);
  assert.equal(m.W.d.aGo, undefined);
  assert.equal(m.W.d.aSign, undefined);
  assert.equal(m.W.d.aRetry, undefined);
});

// ------------------------------------------------------------------ C-130-3
test("C-130-3: the sidebar's 今日 is the consumption door's total, empty when the door returned none", () => {
  assert.equal(build({}).W.todayCost, "$8.76");
  assert.equal(build({}, null, { cost: 0, units: 0, buckets: [], failures: {} }).W.todayCost, "$0.00", "the engine's zero is a value");
  assert.equal(build({}, null, null).W.todayCost, "", "no engine answer, no number (DEC-103-2)");
  assert.ok(!JSON.stringify(build({}, null, null).W).includes("8.76"), "the port's sample is never drawn");
});

// ------------------------------------------------------------------ AC-005
test("AC-005: the query and the hash open the Work screen on the lane they name", () => {
  assert.equal(viewFromQuery("?view=lanes"), "work", "the port's spelling means the Work screen");
  assert.equal(viewFromQuery("?view=work"), "work");
  assert.equal(viewFromQuery("?view=chat"), "chat");
  assert.equal(viewFromQuery("?view=nope"), null, "an unknown value opens nothing on its own");
  assert.equal(viewFromQuery(""), null);
  assert.equal(cardFromQuery("?card=IDD-246"), "IDD-246", "a card is named by the id a CLI answer carries");
  assert.equal(cardFromQuery("?card=OUT-20260928T010203-ab12"), "OUT-20260928T010203-ab12");
  assert.equal(cardFromQuery("?card="), null);
  assert.equal(cardFromQuery("?view=inbox"), null);

  assert.deepEqual(initialScreen("?view=lanes", "#work/L1"), { view: "work", lane: "L1", all: false, chat: null });
  assert.deepEqual(initialScreen("?view=lanes", "#work/all"), { view: "work", lane: null, all: true, chat: null });
  assert.deepEqual(initialScreen("", "#work/L1"), { view: "work", lane: "L1", all: false, chat: null });
  assert.deepEqual(initialScreen("?view=inbox", "#work/L1"), { view: "inbox", lane: null, all: false, chat: null });
  assert.deepEqual(initialScreen("?view=nope", "#nonsense"), { view: "inbox", lane: null, all: false, chat: null });
});

test("AC-005: the Work state is written back to the hash and the selection survives a screen change", () => {
  assert.equal(hashOfScreen({ view: "work", lane: "L1", all: false, chat: null }), "#work/L1");
  assert.equal(hashOfScreen({ view: "work", lane: null, all: true, chat: null }), "#work/all");
  assert.equal(hashOfScreen({ view: "work", lane: null, all: false, chat: null }), "#work");
  assert.equal(hashOfScreen({ view: "inbox", lane: "L1", all: false, chat: null }), "#inbox");
  assert.deepEqual(initialScreen("?view=lanes", hashOfScreen({ view: "work", lane: "L1", all: false, chat: null })), {
    view: "work",
    lane: "L1",
    all: false,
    chat: null,
  });

  const s = initialState({ startView: "work", startLane: "L1" });
  assert.equal(s.view, "work");
  assert.equal(s.wsel, "L1");
  // the screen moves away and comes back: the state machine keeps the lane, so the Work screen opens it again
  const away = { ...s, view: "inbox" };
  const m = workVals(away, () => {}, { snapshot, forecast, consumption: SPEND, detail: DETAIL });
  assert.equal(m.W.hasSel, true);
  assert.equal(m.W.d.ref, "a#1");
  assert.equal(hashOfScreen({ view: away.view, lane: away.wsel, all: away.wopen ?? false, chat: null }), "#inbox");
  assert.equal(hashOfScreen({ view: "work", lane: away.wsel, all: false, chat: null }), "#work/L1");
});

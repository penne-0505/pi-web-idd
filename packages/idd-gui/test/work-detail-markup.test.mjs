import assert from "node:assert/strict";
import test from "node:test";
import { h, load, render } from "./helpers.mjs";

const { workVals } = await load("./src/work/viewmodel.ts");
const { RepoSummary } = await load("./src/components/work/RepoSummary.tsx");
const { WorkDetailSelected } = await load("./src/components/work/WorkDetailSelected.tsx");

const NOW = "2026-10-16T04:00:00+09:00";
const at = (minutes) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const ref = (label) => ({ kind: "github", label, url: `https://example.test/${label}` });

const lane = (over) => ({
  kind: "issue",
  id: "L1",
  repo: "p1",
  ref: ref("a#1"),
  title: "lane",
  bundle: "running",
  spans: [],
  waitsFor: [],
  ...over,
});
const source = (lanes, over = {}) => ({
  snapshot: { now: at(0), repos: [{ id: "p1", name: "alpha", running: lanes.length, waiting: 0, attention: true }], lanes, done: [], holds: [] },
  forecast: null,
  consumption: null,
  detail: null,
  ...over,
});

// ------------------------------------------------------------------ AC-005 (the question mark on the part)
test("AC-005: the question mark is drawn for a lane waiting on an answer", () => {
  const question = lane({ id: "LQ", ref: ref("a#7"), title: "question lane", turn: "question" });
  const html = render(h(RepoSummary, { m: workVals({}, () => {}, source([question])) }));

  assert.match(html, />\?</, "the ? mark is on the row");
  assert.match(
    html,
    /padding:1px 7px;border-radius:4px;background:var\(--line-soft\);color:var\(--ink\);font:600 10px var\(--font-mono\)/,
    "it keeps the prototype's shape",
  );
});

test("AC-005: the common mark's lane draws no question mark", () => {
  const stuck = lane({ id: "LS", ref: ref("a#8"), title: "stuck lane", turn: "stuck" });
  const html = render(h(RepoSummary, { m: workVals({}, () => {}, source([stuck])) }));

  assert.doesNotMatch(html, />\?</, "the common mark's lane draws no question mark");
  assert.match(html, /border-left:1.5px solid var\(--ink\)/, "the common mark is still drawn");
});

// ------------------------------------------------------------------ AC-006 (the stage table's band and usual mark)
test("AC-006: a very long band and its usual mark are held inside the stage table's column", () => {
  const long = lane({
    id: "LL",
    ref: ref("a#9"),
    title: "long lane",
    spans: [
      { key: "impl", label: "実装", start: at(-5200), end: at(-5000), owner: "machine" },
      { key: "review_round", label: "レビューの巡", start: at(-470), owner: "machine" },
    ],
  });
  const forecast = {
    ok: true,
    generatedAt: at(0),
    usual: [{ area: "p1", lanes: 1, stages: { review: { median: 500, p75: 600, threshold: 1200, samples: 5, basis: "repo" } } }],
    lanes: [
      { iddId: "LL", area: "p1", now: { kind: "stage", stage: "review", since: at(-470), elapsedMin: 470 }, anomaly: false, eta: { at: null, stopsAt: null, remaining: [] } },
    ],
  };
  const m = workVals({ wsel: "LL", wtab: "st" }, () => {}, source([long], { forecast }));
  const html = render(h(WorkDetailSelected, { m }));

  // 470 minutes at 1.7px a minute is 799px, and the forecast's 500-minute usual sits at 850px: both are past any column
  assert.match(html, /width:min\(799px, 100%\)/, "the bar stops at the column's right edge");
  assert.match(html, /left:min\(850px, calc\(100% - 2px\)\)/, "the usual tick stops before it");
  assert.match(html, /left:min\(850px, calc\(100% - 36px\)\)/, "the usual label stops before it too");
  assert.match(html, />ふだん</, "the usual mark is still drawn");
  assert.match(html, />7h50m</, "the time text still shows the row's real length");
});

test("AC-006: a band that fits the column keeps its 1.7px a minute", () => {
  const short = lane({
    id: "LH",
    ref: ref("a#4"),
    title: "short lane",
    spans: [{ key: "impl", label: "実装", start: at(-30), owner: "machine" }],
  });
  const forecast = {
    ok: true,
    generatedAt: at(0),
    usual: [{ area: "p1", lanes: 1, stages: { impl: { median: 40, p75: 60, threshold: 120, samples: 5, basis: "repo" } } }],
    lanes: [{ iddId: "LH", area: "p1", now: { kind: "stage", stage: "impl", since: at(-30), elapsedMin: 30 }, anomaly: false, eta: { at: null, stopsAt: null, remaining: [] } }],
  };
  const m = workVals({ wsel: "LH", wtab: "st" }, () => {}, source([short], { forecast }));
  const html = render(h(WorkDetailSelected, { m }));

  assert.match(html, /width:min\(51px, 100%\)/, "30 minutes is drawn at 1.7px a minute");
  assert.match(html, /left:min\(68px, calc\(100% - 2px\)\)/, "the usual's 40 minutes keep the same scale");
  assert.equal(m.W.d.stages[0].w, 51);
  assert.equal(m.W.d.stages[0].ux, 68);
});

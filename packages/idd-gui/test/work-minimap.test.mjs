import assert from "node:assert/strict";
import test from "node:test";
import { h, load, render } from "./helpers.mjs";

const { WorkMiniMap } = await load("./src/components/work/WorkMiniMap.tsx");

/** the mini map's own values, as `workVals` hands them to the part: nothing else is read */
const mini = (over = {}) => ({
  openOv: () => {},
  mH: 18,
  mLabels: [
    { y: 0, t: "pi-web-idd", full: "pi-web-idd", c: "var(--ink)" },
    { y: 12, t: "days…ent", full: "daysai-management", c: "var(--ink-3)" },
  ],
  mNowX: 100,
  mBars: [{ l: 52, w: 40, y: 0, bg: "var(--ink)", bd: "none" }],
  mMarks: [],
  mSel: [{ y: 0 }],
  mTicks: [{ x: 52, t: "09:00" }],
  ...over,
});

const markupOf = (W) => render(h(WorkMiniMap, { m: { W } }));

// ------------------------------------------------------------------ AC-003
test("AC-003: a name is cut at the column and its full text waits on hover", () => {
  const html = markupOf(mini());

  assert.match(html, /title="pi-web-idd"/, "the full name is on the label");
  assert.match(html, /title="daysai-management"/, "a name wider than the column keeps its full text on hover");
  assert.match(html, />days…ent</, "the drawn text is the cut name, not the whole one");
  assert.match(html, /max-width:47px/, "the label stops before the selected lane's 49px frame");
  assert.match(html, /overflow:hidden/);
  assert.match(html, /text-overflow:ellipsis/, "the tail is cut with a mark, not wrapped over the band");
  assert.match(html, /white-space:nowrap/);
});

test("AC-003: a name that fits the column keeps every letter", () => {
  const html = markupOf(mini({ mLabels: [{ y: 0, t: "propter", full: "propter", c: "var(--ink)" }] }));
  assert.match(html, />propter</, "the short name is drawn whole");
  assert.doesNotMatch(html, /propter…/, "no mark is added to a fitting name");
});

// ------------------------------------------------------------------ AC-004
test("AC-004: the name column and the band keep the prototype's sizes", () => {
  const html = markupOf(mini());

  assert.match(html, /font:500 9px var\(--font-mono\)/, "the name keeps its face and size");
  assert.match(html, /left:49px/, "the selected lane's frame starts where the prototype put it");
  assert.match(html, /height:8px/, "the frame keeps its height");
  assert.match(html, /height:4px/, "the band keeps its height");
  assert.match(html, /margin-left:52px/, "the axis keeps the prototype's 52px");
  assert.match(html, /border-radius:1px/, "the band keeps its radius");
});

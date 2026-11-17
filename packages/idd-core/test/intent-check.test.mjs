import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import * as store from "../src/intent/store.ts";
import { checkState, checkTree } from "../src/intent/check.ts";
import { readLifecycle } from "../src/ledger/read.ts";
import { EXECUTOR_WORK } from "../src/plan/watch.ts";

let savedState;
beforeEach(() => { savedState = process.env.IDD_STATE_DIR; });
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
});

const REPO = "me/app";

function setup() {
  const root = scratchDir("intent-check-");
  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  return { root, state };
}

/** instants every fixture is placed on: minutes from 2026-10-13T00:00:00Z */
const BASE = Date.UTC(2026, 9, 13, 0, 0, 0);
/** the column's shape (`Z`) */
const colAt = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
/** the lifecycle's shape (`+09:00`), so the two are mixed on purpose */
const lifeAt = (minutes) => new Date(BASE + minutes * 60_000 + 9 * 3_600_000).toISOString().replace("Z", "+09:00");

function seedLifecycle(state, iddId, event, minutes, attrs = {}) {
  appendFileSync(join(state, "lifecycle-test.jsonl"), `${JSON.stringify({ event, idd_id: iddId, at: lifeAt(minutes), attrs })}\n`);
}

function appendRow(row, repo = REPO) {
  appendFileSync(store.intentColumnPath(repo), `${JSON.stringify(row)}\n`);
}

/** the column and the lifecycle as they are now, folded for a viewer, ready for checkState */
function stateFor(lane = null) {
  const rows = store.readRows(store.intentColumnPath(REPO));
  const all = readLifecycle();
  const folded = store.foldRows(rows, lane, store.laneStates(all));
  const events = lane ? all.filter((e) => e.idd_id === lane) : [];
  return { rows, folded, events };
}

function runState(lane = null) {
  const { rows, folded, events } = stateFor(lane);
  return checkState({ rows, folded, lane, events });
}

const rules = (result, rule) => result.findings.filter((f) => f.rule === rule);

const choice = (over = {}) => ({
  event: "choice_raised", at: colAt(0), repo: REPO, by: { session: "s9" }, id: "C-s9-1", purpose: "P-1",
  forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] },
  place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x",
  visibility: "private", status: "active", origin: { by: "agent" },
  ...over,
});

/** a lane's raise at a chosen instant, written straight to the column */
const laneRaise = (id, minutes, over = {}) => appendRow(choice({ id, at: colAt(minutes), by: { lane: "IDD-A" }, ...over }));

async function activePurpose() {
  const r = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "S", origin: "O" });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

const tree = (root) => ({
  kindOf: (p) => {
    try {
      const st = statSync(join(root, p));
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : "missing";
    } catch { return "missing"; }
  },
  readFile: (p) => {
    try { return readFileSync(join(root, p), "utf8"); } catch { return null; }
  },
});

function put(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// ---- state rules ----

test("AC-001: a record missing a required field is a finding named by that field", async () => {
  setup();
  await activePurpose();
  const fields = ["purpose", "forms", "place", "why", "anchored"];
  fields.forEach((field, i) => appendRow(choice({ id: `C-s9-${i + 1}`, ...{ [field]: undefined } })));
  appendRow({ event: "purpose_raised", at: colAt(0), repo: REPO, by: { session: "s9" }, id: "P-90", origin: "O", status: "active" });
  appendRow({ event: "purpose_raised", at: colAt(0), repo: REPO, by: { session: "s9" }, id: "P-91", statement: "S", status: "active" });

  const r = runState();
  fields.forEach((field, i) => {
    const found = rules(r, "required").find((f) => f.id === `C-s9-${i + 1}`);
    assert.ok(found, field);
    assert.equal(found.weight, "error", field);
    assert.ok(found.reason.length > 0, field);
  });
  assert.match(rules(r, "required").find((f) => f.id === "P-90").reason, /statement/);
  assert.match(rules(r, "required").find((f) => f.id === "P-91").reason, /origin/);

  // a record with every field is not a finding
  appendRow(choice({ id: "C-s9-9" }));
  assert.equal(rules(runState(), "required").some((f) => f.id === "C-s9-9"), false);
});

test("AC-002: an absent, retired or proposed Purpose is a finding; a superseded or dropped Choice is not looked at", async () => {
  setup();
  const active = await activePurpose();
  const retired = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O" });
  await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: retired.id, grounds: "g" });
  appendRow({ event: "purpose_raised", at: colAt(0), repo: REPO, by: { session: "s9" }, id: "P-92", statement: "S", origin: "O", status: "proposed" });

  appendRow(choice({ id: "C-s9-1", purpose: "P-404" }));
  appendRow(choice({ id: "C-s9-2", purpose: retired.id }));
  appendRow(choice({ id: "C-s9-3", purpose: "P-92", status: "unconfirmed" }));

  const r = runState();
  assert.equal(rules(r, "purpose").find((f) => f.id === "C-s9-1").weight, "error");
  assert.match(rules(r, "purpose").find((f) => f.id === "C-s9-2").reason, /active ではありません/);
  assert.equal(rules(r, "purpose").find((f) => f.id === "C-s9-3").weight, "error");

  // a superseded and a dropped Choice against a retired Purpose are not the rule's business
  appendRow(choice({ id: "C-s9-4", purpose: retired.id }));
  appendRow(choice({ id: "C-s9-5", purpose: active, supersedes: [{ id: "C-s9-4", grounds: "g" }] }));
  appendRow(choice({ id: "C-s9-6", purpose: retired.id, status: "unconfirmed" }));
  appendRow({ event: "choice_dropped", at: colAt(1), repo: REPO, by: { session: "s9" }, id: "C-s9-6", grounds: "g" });

  const after = runState();
  assert.equal(rules(after, "purpose").some((f) => f.id === "C-s9-4"), false);
  assert.equal(rules(after, "purpose").some((f) => f.id === "C-s9-6"), false);
});

test("AC-003: a Choice with no rejected form and no reason is a finding", async () => {
  setup();
  await activePurpose();
  appendRow(choice({ id: "C-s9-1", forms: { chosen: "A", rejected: [] } }));
  appendRow(choice({ id: "C-s9-2", forms: { chosen: "A", rejected: [] }, no_why_not: "理由" }));
  appendRow(choice({ id: "C-s9-3", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] } }));

  const found = rules(runState(), "rejected");
  assert.deepEqual(found.map((f) => f.id), ["C-s9-1"]);
  assert.equal(found[0].weight, "error");
});

test("AC-004: a superseded Choice with no successor, or one that is not in the state, is a finding", () => {
  setup();
  const view = (over) => ({
    purpose: "P-1", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] },
    place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x", free: "", visibility: "private",
    origin: { by: "agent" }, waives: [], ...over,
  });
  const folded = {
    purposes: [{ id: "P-1", statement: "S", origin: "O", status: "active", raised: { by: { session: "s1" }, at: colAt(0) } }],
    choices: [
      view({ id: "C-a-1", status: "superseded", history: [{ at: colAt(1), event: "superseded", by: { session: "s1" } }] }),
      view({ id: "C-a-2", status: "superseded", history: [{ at: colAt(1), event: "superseded", by: { session: "s1" }, successor: "C-a-9" }] }),
      view({ id: "C-a-3", status: "active", history: [{ at: colAt(1), event: "created", by: { session: "s1" } }] }),
    ],
    waives: [],
  };
  const r = checkState({ rows: [], folded, lane: null, events: [] });
  const found = rules(r, "successor");
  assert.deepEqual(found.map((f) => f.id).sort(), ["C-a-1", "C-a-2"]);
  assert.equal(found.every((f) => f.weight === "error"), true);
  assert.match(found.find((f) => f.id === "C-a-2").reason, /C-a-9/);
  assert.deepEqual(r.choices.map((c) => c.id), ["C-a-3"]);
});

test("AC-003: the overview's seat written again after it ended is not a duplicate; no other id's repeat is excused", async () => {
  setup();
  const raise = (id, extra) => appendRow({ event: "purpose_raised", at: colAt(0), repo: REPO, by: { session: "s9" }, id, statement: "S", origin: "O", status: "active", ...extra });
  raise("P-1", { by: { lane: "IDD-A" }, status: "proposed" });
  appendRow({ event: "purpose_withdrawn", at: colAt(1), repo: REPO, by: { session: "inbox" }, id: "P-1", grounds: "g" });
  raise("P-1");
  raise("P-2");
  raise("P-2");
  const dup = rules(runState(), "id-duplicate").map((f) => f.id);
  assert.deepEqual(dup, ["P-2"], "the seat's rewrite is not an overlap, another id's repeat is");
  appendRow(choice({ id: "P-1" }));
  assert.equal(rules(runState(), "id-duplicate").some((f) => f.id === "P-1"), true, "a Choice that takes the seat's id is still an overlap");
});

test("AC-005: overlapping ids and ids of another shape are findings, including a row not yet merged", async () => {
  setup();
  await activePurpose();
  appendRow(choice({ id: "C-dup-1", by: { session: "s9" } }));
  appendRow(choice({ id: "C-dup-1", by: { lane: "IDD-B" } }));
  appendRow({ event: "purpose_raised", at: colAt(0), repo: REPO, by: { session: "s9" }, id: "P-94", statement: "S", origin: "O", status: "active" });
  appendRow(choice({ id: "P-94" }));
  appendRow(choice({ id: "X-1" }));
  for (const id of ["C-099-1", "C-s1-1", "DEC-123", "DEC-088-1", "DEC-IddCore-12"]) appendRow(choice({ id }));

  const r = runState();
  const dup = rules(r, "id-duplicate");
  assert.equal(dup.find((f) => f.id === "C-dup-1").weight, "error");
  assert.match(dup.find((f) => f.id === "C-dup-1").reason, /2 行/);
  assert.equal(dup.some((f) => f.id === "P-94"), true);
  assert.equal(rules(r, "id-shape").find((f) => f.id === "X-1").weight, "error");

  for (const id of ["P-1", "C-099-1", "C-s1-1", "DEC-123", "DEC-088-1", "DEC-IddCore-12"]) {
    assert.equal(rules(r, "id-shape").some((f) => f.id === id), false, id);
  }
});

test("AC-010 / INV-101-1 / INV-101-2: another lane's defects are notes, the lane's own are errors", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  const retired = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O" });
  await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: retired.id, grounds: "g" });

  // lane A is in the implementation round, so its own missing Place is an error and its raise is a round record
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-A", "lane_open", 0);
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-A", "s2_start", 1);
  const mine = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-A" }, body: { purpose, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "nope/mine.ts", kind: "file" }], why: "w", anchored: "x" } });
  assert.equal(mine.ok, true, mine.error);

  // the lane's outside owns defective Choices: a Place that is not there, a retired Purpose and a missing field
  appendRow(choice({ id: "C-s9-1", place: [{ path: "nope/out.ts", kind: "file" }] }));
  appendRow(choice({ id: "C-s9-2", purpose: retired.id }));
  appendRow(choice({ id: "C-s9-3", why: "" }));
  // and one whose Place lane A deletes
  appendRow(choice({ id: "C-s9-4", place: [{ path: "gone/moved.ts", kind: "file" }] }));
  // lane A re-anchors a fifth onto a path that is on no disk
  appendRow(choice({ id: "C-s9-5", place: [{ path: "kept/out.ts", kind: "file" }] }));
  const re = await store.reanchor({ repo: REPO, actor: { lane: "IDD-A" }, id: "C-s9-5", place: [{ path: "nope/re.ts", kind: "file" }] });
  assert.equal(re.ok, true, re.error);

  const { rows, folded, events } = stateFor("IDD-A");
  const state = checkState({ rows, folded, lane: "IDD-A", events });
  const found = [...state.findings, ...checkTree({ choices: state.choices, rounds: state.rounds, lane: "IDD-A", changed: ["gone/moved.ts"], ...tree(root) })];

  for (const id of ["C-s9-1", "C-s9-2", "C-s9-3"]) {
    const f = found.filter((x) => x.id === id);
    assert.ok(f.length > 0, id);
    assert.equal(f.every((x) => x.weight === "note"), true, `${id}: ${JSON.stringify(f)}`);
  }
  assert.equal(found.some((f) => f.weight === "error" && f.id === mine.id), true, "the lane's own missing Place is an error");
  assert.equal(found.some((f) => f.weight === "error" && f.id === "C-s9-5" && f.rule === "place"), true, "the re-anchored Place is the lane's");
  assert.equal(found.some((f) => f.weight === "error" && f.id === "C-s9-4" && f.rule === "place"), true, "a Place the lane deleted is the lane's");
});

test("AC-004: a Choice the lane only re-anchored is a note under the body rules, and its Place is still the lane's", async () => {
  const { root } = setup();
  await activePurpose();
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-A", "lane_open", 0);
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-A", "s2_start", 1);
  // the lane's outside raises two Choices whose bodies have gaps the lane did not make
  appendRow(choice({ id: "C-s9-1", forms: { chosen: "A", rejected: [] }, why: "" }));
  appendRow(choice({ id: "C-s9-2", forms: { chosen: "A", rejected: [] } }));
  put(join(root, "a/b.ts"), "x\n");
  // the lane only moves their Places: one onto a path that is there, one onto a path that is not
  const re1 = await store.reanchor({ repo: REPO, actor: { lane: "IDD-A" }, id: "C-s9-1", place: [{ path: "a/b.ts", kind: "file" }] });
  assert.equal(re1.ok, true, re1.error);
  const re2 = await store.reanchor({ repo: REPO, actor: { lane: "IDD-A" }, id: "C-s9-2", place: [{ path: "nope/x.ts", kind: "file" }] });
  assert.equal(re2.ok, true, re2.error);
  // and raises one of its own with the same gap
  laneRaise("C-A-1", 0, { forms: { chosen: "A", rejected: [] } });

  const state = runState("IDD-A");
  const rejected = state.findings.filter((f) => f.rule === "rejected" && f.id === "C-s9-1");
  assert.equal(rejected.length, 1, JSON.stringify(state.findings));
  assert.equal(rejected[0].weight, "note");
  const required = state.findings.filter((f) => f.rule === "required" && f.id === "C-s9-1");
  assert.equal(required.length, 1, JSON.stringify(state.findings));
  assert.equal(required[0].weight, "note");
  assert.equal(state.findings.filter((f) => f.rule === "rejected" && f.id === "C-A-1")[0].weight, "error");

  // the re-anchored Place is the lane's: one that is not on disk is still an error
  const found = checkTree({ choices: state.choices, rounds: state.rounds, lane: "IDD-A", changed: [], ...tree(root) });
  assert.equal(found.some((f) => f.rule === "place" && f.id === "C-s9-2" && f.weight === "error"), true, JSON.stringify(found));
});

test("AC-011: a check that names no lane fails the whole state", async () => {
  setup();
  await activePurpose();
  appendRow(choice({ id: "C-s9-1", place: [{ path: "nope/out.ts", kind: "file" }] }));
  appendRow(choice({ id: "C-s9-2", why: "" }));

  const r = runState();
  assert.equal(r.findings.filter((f) => f.id === "C-s9-1").every((f) => f.weight === "error"), true);
  assert.equal(r.findings.filter((f) => f.id === "C-s9-2").every((f) => f.weight === "error"), true);
  assert.equal(r.findings.some((f) => f.weight === "note"), false);
});

/** the lane's own Choice, whose Place is on no disk */
async function raiseMissingPlace(purpose) {
  const raised = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-A" }, body: { purpose, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "nope/a.ts", kind: "file" }], why: "w", anchored: "x" } });
  assert.equal(raised.ok, true, raised.error);
}

/** lane A's state check and the tree check over the rows as they are */
function laneTreeCheck(root) {
  const state = checkState({ ...stateFor("IDD-A"), lane: "IDD-A" });
  return { entered: state.rounds.enteredImplementation, found: checkTree({ choices: state.choices, rounds: state.rounds, lane: "IDD-A", changed: [], ...tree(root) }) };
}

test("AC-012 / INV-101-6: before the implementation round a lane's missing Place is a note, after it is an error", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-A", "lane_open", 0);
  await raiseMissingPlace(purpose);

  const before = laneTreeCheck(root).found;
  assert.equal(before.some((f) => f.weight === "error"), false, JSON.stringify(before));
  assert.equal(before.some((f) => f.weight === "note" && f.rule === "place"), true);

  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-A", "s2_start", 1);
  assert.equal(laneTreeCheck(root).found.some((f) => f.weight === "error" && f.rule === "place"), true);
});

test("a lane sent back to its plan is in the plan stage again until its next start: a missing Place is a note, and an error after the start", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  const state = process.env.IDD_STATE_DIR;
  for (const [event, minutes] of [["lane_open", 0], ["s1_go", 1], ["s2_start", 2], ["s1_replan_requested", 3], ["s1_ready", 4]]) seedLifecycle(state, "IDD-A", event, minutes);
  await raiseMissingPlace(purpose);

  const before = laneTreeCheck(root);
  assert.equal(before.entered, false);
  assert.equal(before.found.some((f) => f.weight === "error"), false, JSON.stringify(before.found));
  assert.equal(before.found.some((f) => f.weight === "note" && f.rule === "place"), true);

  seedLifecycle(state, "IDD-A", "s1_go", 5);
  seedLifecycle(state, "IDD-A", "s2_start", 6);
  const after = laneTreeCheck(root);
  assert.equal(after.entered, true);
  assert.equal(after.found.some((f) => f.weight === "error" && f.rule === "place"), true);
});

test("AC-016: the number of items, the length of a line and the words a source uses are not findings", async () => {
  setup();
  await activePurpose();
  appendRow(choice({ id: "C-s9-1", why: "w" }));
  appendRow(choice({ id: "C-s9-2", why: "AC にある" }));
  appendRow(choice({ id: "C-s9-3", forms: { chosen: "A", rejected: [] }, no_why_not: "理由" }));

  assert.deepEqual(runState().findings, []);
});

// ---- tree rules ----

test("AC-006: a Place that is not the kind it claims is a finding; root is not looked at", async () => {
  const { root } = setup();
  put(join(root, "a/b.ts"), "x");
  mkdirSync(join(root, "dirx"));
  const choices = [
    { id: "C-1", status: "active", place: [{ path: "a/b.ts", kind: "file" }], mine: false },
    { id: "C-2", status: "active", place: [{ path: "dirx/", kind: "dir" }], mine: false },
    { id: "C-3", status: "active", place: [{ path: "/", kind: "root" }], mine: false },
    { id: "C-4", status: "active", place: [{ path: "no/where.ts", kind: "file" }], mine: false },
    { id: "C-5", status: "active", place: [{ path: "dirx", kind: "file" }], mine: false },
    { id: "C-6", status: "active", place: [{ path: "a/b.ts/", kind: "dir" }], mine: false },
  ];
  const found = checkTree({ choices, rounds: { enteredImplementation: true }, lane: null, changed: null, ...tree(root) });
  // a missing module is the defect; a file mark naming a dir is a maintenance mark, because its module (the repo's
  // own root here) still stands and the Choice still reaches the code of that module
  assert.deepEqual(found.filter((f) => f.weight === "error" && f.rule === "place").map((f) => f.id).sort(), ["C-4", "C-6"]);
  assert.deepEqual(found.filter((f) => f.weight === "mark").map((f) => f.id).sort(), ["C-5"]);
});

test("AC-006: a superseded or dropped Choice's Place is not looked at", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "nope/sup.ts", kind: "file" }], why: "w", anchored: "x" } });
  await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: ["C-s1-1"], grounds: "g", body: { purpose, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "nope/next.ts", kind: "file" }], why: "w", anchored: "x" } });
  await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, id: "DEC-9", status: "unconfirmed", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "nope/drop.ts", kind: "file" }], why: "w", anchored: "x" } });
  await store.dropChoice({ repo: REPO, actor: { session: "s1" }, id: "DEC-9", grounds: "g" });

  const state = runState();
  assert.deepEqual(state.choices.map((c) => c.id).sort(), ["C-s1-2"]);
  const found = checkTree({ choices: state.choices, rounds: state.rounds, lane: null, changed: null, ...tree(root) });
  assert.equal(found.some((f) => ["C-s1-1", "DEC-9"].includes(f.id)), false);
});

test("AC-007: a symbol that is no longer in the file gets one mark, and a mark does not fail the check", async () => {
  const { root } = setup();
  put(join(root, "src/one.ts"), "export const fooBar = 1;\n");
  put(join(root, "src/two.ts"), "export const fooBarBaz = 1;\n");
  const choices = [
    { id: "C-1", status: "active", place: [{ path: "src/one.ts", kind: "file", symbols: ["fooBar", "gone"] }], mine: false },
    { id: "C-2", status: "active", place: [{ path: "src/two.ts", kind: "file", symbols: ["fooBar"] }], mine: false },
    { id: "C-3", status: "active", place: [{ path: "src/none.ts", kind: "file", symbols: ["gone"] }], mine: false },
  ];
  const found = checkTree({ choices, rounds: { enteredImplementation: true }, lane: null, changed: null, ...tree(root) });
  const marks = found.filter((f) => f.weight === "mark");
  assert.deepEqual(marks.filter((f) => f.rule === "symbols").map((f) => [f.id, /gone/.test(f.reason) ? "gone" : "fooBar"]).sort(), [["C-1", "gone"], ["C-2", "fooBar"]]);
  // a file mark whose file left the tree is a mark too: the module still stands, so the Choice still holds
  assert.deepEqual(marks.filter((f) => f.rule === "mark").map((f) => f.id), ["C-3"]);
  assert.deepEqual(found.filter((f) => f.weight === "error"), []);
});

test("AC-004: a symbol with dots is found when every one of its segments stands as a word", async () => {
  const { root } = setup();
  put(join(root, "src/conv.ts"), "class Conversation {\n  remove() {}\n}\n");
  put(join(root, "src/pipeline.ts"), "pipeline:\n  review_loop: 1\n");
  put(join(root, "src/none.ts"), "class Conversation {}\n");
  const choices = [
    { id: "C-1", status: "active", place: [{ path: "src/conv.ts", kind: "file", symbols: ["Conversation.remove"] }], mine: false },
    { id: "C-2", status: "active", place: [{ path: "src/pipeline.ts", kind: "file", symbols: ["pipeline.review_loop"] }], mine: false },
    { id: "C-3", status: "active", place: [{ path: "src/none.ts", kind: "file", symbols: ["Conversation.remove"] }], mine: false },
    { id: "C-4", status: "active", place: [{ path: "src/conv.ts", kind: "file", symbols: ["Conversation"] }], mine: false },
    { id: "C-5", status: "active", place: [{ path: "src/conv.ts", kind: "file", symbols: ["Conversation.gone"] }], mine: false },
  ];
  const marks = checkTree({ choices, rounds: { enteredImplementation: true }, lane: null, changed: null, ...tree(root) }).filter((f) => f.weight === "mark");
  // C-1 and C-2 are really there even though the whole string never appears; C-3 and C-5 each miss a segment
  assert.deepEqual(marks.map((f) => f.id).sort(), ["C-3", "C-5"]);
});

test("AC-009: an unconfirmed Choice left on a Place the lane touched is an error, and confirming, dropping or replacing it clears it", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  const raw = (id, path, kind = "file") => appendRow(choice({ id, purpose, status: "unconfirmed", place: [{ path, kind }] }));

  raw("C-s9-1", "a/b.ts");
  raw("C-s9-2", "a/", "dir");
  raw("C-s9-3", "/", "root");
  raw("C-s9-4", "c/d.ts");
  raw("C-s9-5", "gone/x.ts");

  const state = runState("IDD-A");
  const found = checkTree({ choices: state.choices, rounds: state.rounds, lane: "IDD-A", changed: ["a/b.ts", "gone/x.ts"], ...tree(root) }).filter((f) => f.rule === "touched");
  assert.deepEqual(found.map((f) => f.id).sort(), ["C-s9-1", "C-s9-2", "C-s9-5"]);
  // a lane with no v2 mark is only told (AC-032); the v2 case is covered in intent-check-v2
  assert.equal(found.every((f) => f.weight === "note"), true);

  // confirming turns it active, so the touched rule no longer sees it
  await store.confirmChoice({ repo: REPO, actor: { session: "s1" }, id: "C-s9-1" });
  const confirmed = runState("IDD-A");
  assert.equal(checkTree({ choices: confirmed.choices, rounds: confirmed.rounds, lane: "IDD-A", changed: ["a/b.ts"], ...tree(root) }).filter((f) => f.rule === "touched").some((f) => f.id === "C-s9-1"), false);

  // dropping and replacing leave the Choice out of the valid list entirely
  await store.dropChoice({ repo: REPO, actor: { session: "s1" }, id: "C-s9-2", grounds: "g" });
  await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: ["C-s9-5"], grounds: "g", body: { purpose, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "gone/y.ts", kind: "file" }], why: "w", anchored: "x" } });
  const after = runState("IDD-A");
  assert.equal(after.choices.some((c) => c.id === "C-s9-2" || c.id === "C-s9-5"), false);
});

test("AC-002: a round with no record is a note, in a closed round and in an open one", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  const open = rules(runState("IDD-A"), "round");
  assert.equal(open.length, 1, JSON.stringify(open));
  assert.match(open[0].reason, /作業中/);
  assert.equal(open[0].weight, "note");

  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  const closed = rules(runState("IDD-A"), "round");
  assert.equal(closed.length, 1, JSON.stringify(closed));
  assert.equal(closed[0].weight, "note");
});

test("AC-003: an unconfirmed Choice on a touched Place is a note, and the rule still reports it", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  appendRow(choice({ id: "C-s9-1", purpose, status: "unconfirmed", place: [{ path: "a/b.ts", kind: "file" }] }));
  put(join(root, "a/b.ts"), "x\n");
  const state = runState("IDD-A");
  const found = checkTree({ choices: state.choices, rounds: state.rounds, lane: "IDD-A", changed: ["a/b.ts"], ...tree(root) });
  const touched = found.filter((f) => f.rule === "touched");
  assert.equal(touched.length, 1, JSON.stringify(found));
  assert.equal(touched[0].weight, "note");
  assert.equal(found.some((f) => f.weight === "error"), false, JSON.stringify(found));
});

test("AC-017 / INV-120-6: a file Place moved into the archive is not a defect; other missing paths still are", () => {
  const { root } = setup();
  put(join(root, "_docs/archives/intent/A/s/decision.md"), "# moved\n");
  mkdirSync(join(root, "_docs/archives/intent/A/dir-only"), { recursive: true });
  const choices = [
    { id: "C-1", status: "active", place: [{ path: "_docs/intent/A/s/decision.md", kind: "file" }], mine: false },
    { id: "C-2", status: "active", place: [{ path: "_docs/intent/A/none/decision.md", kind: "file" }], mine: false },
    { id: "C-3", status: "active", place: [{ path: "_docs/qa/A/s/qa.md", kind: "file" }], mine: false },
    { id: "C-4", status: "active", place: [{ path: "_docs/intent/A/dir-only/", kind: "dir" }], mine: false },
  ];
  const found = checkTree({ choices, rounds: { enteredImplementation: true }, lane: null, changed: null, ...tree(root) });
  assert.deepEqual(found.filter((f) => f.rule === "place").map((f) => f.id).sort(), ["C-2", "C-3", "C-4"]);
});

test("INV-101-4: the state rules and the tree rules write neither the column nor the tree", async () => {
  const { root } = setup();
  await activePurpose();
  put(join(root, "a/b.ts"), "before\n");
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-A", "lane_open", 0);
  appendRow(choice({ id: "C-s9-1", place: [{ path: "nope/x.ts", kind: "file" }] }));
  const column = readFileSync(store.intentColumnPath(REPO), "utf8");
  const lifecycle = readFileSync(join(process.env.IDD_STATE_DIR, "lifecycle-test.jsonl"), "utf8");

  const r = runState("IDD-A");
  checkTree({ choices: r.choices, rounds: r.rounds, lane: "IDD-A", changed: ["a/b.ts"], ...tree(root) });

  assert.equal(readFileSync(store.intentColumnPath(REPO), "utf8"), column);
  assert.equal(readFileSync(join(process.env.IDD_STATE_DIR, "lifecycle-test.jsonl"), "utf8"), lifecycle);
  assert.equal(readFileSync(join(root, "a/b.ts"), "utf8"), "before\n");
});

// ---- rounds ----

test("AC-008 / INV-101-3: a round with no record is a finding, and a record of any kind closes it", async () => {
  const rounds = (state, extra = () => {}) => {
    seedLifecycle(state, "IDD-A", "lane_open", 0);
    seedLifecycle(state, "IDD-A", "s2_start", 10);
    seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
    seedLifecycle(state, "IDD-A", "s2_fix_sent", 30);
    seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "success" });
    laneRaise("C-A-1", 5);
    extra();
  };

  const { state } = setup();
  await activePurpose();
  rounds(state);
  const found = rules(runState("IDD-A"), "round");
  assert.equal(found.length, 1, JSON.stringify(found));
  // a lane with no v2 mark is only told (AC-032); the v2 case is covered in intent-check-v2
  assert.equal(found[0].weight, "note");
  assert.match(found[0].reason, /40/);

  // a record of each kind closes the second round
  for (const record of [
    { event: "waive", kind: "no-choice", reason: "r" },
    { event: "waive", kind: "applied", choices: ["C-A-1"] },
    { event: "choice_reanchored", id: "C-A-1", place: [{ path: "a/b.ts", kind: "file" }] },
    { event: "choice_raised", id: "C-A-2", supersedes: [{ id: "C-A-1", grounds: "g" }] },
  ]) {
    const { state: s } = setup();
    await activePurpose();
    rounds(s, () => appendRow({ at: colAt(35), repo: REPO, by: { lane: "IDD-A" }, purpose: "P-1", ...record }));
    assert.equal(rules(runState("IDD-A"), "round").length, 0, JSON.stringify(record));
  }

  // confirm and drop are not records
  const { state: s } = setup();
  await activePurpose();
  rounds(s, () => {
    appendRow({ event: "choice_confirmed", at: colAt(35), repo: REPO, by: { lane: "IDD-A" }, id: "C-A-1" });
    appendRow({ event: "choice_dropped", at: colAt(35), repo: REPO, by: { lane: "IDD-A" }, id: "C-A-1", grounds: "g" });
  });
  assert.equal(rules(runState("IDD-A"), "round").length, 1);
});

test("AC-004: a row that points at a standing successor counts as the round's record", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(state, "IDD-A", "s2_fix_sent", 30);
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "success" });
  laneRaise("C-A-1", 5);
  laneRaise("C-A-2", 35);
  appendRow({ event: "choice_superseded", at: colAt(35), repo: REPO, by: { lane: "IDD-A" }, id: "C-A-2", supersedes: [{ id: "C-A-1", grounds: "g" }] });
  assert.deepEqual(rules(runState("IDD-A"), "round"), []);
});

test("AC-008: a failed round, a planning-only lane and another lane's records", async () => {
  // a failed result closes a round without asking for a record
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(state, "IDD-A", "s2_fix_sent", 30);
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "failed" });
  laneRaise("C-A-1", 5);
  assert.equal(rules(runState("IDD-A"), "round").length, 0);

  // a lane with no s2_start has no round at all
  const { state: s2 } = setup();
  await activePurpose();
  seedLifecycle(s2, "IDD-A", "lane_open", 0);
  laneRaise("C-A-1", 5);
  assert.equal(rules(runState("IDD-A"), "round").length, 0);

  // another lane's raise inside the round does not count for this lane
  const { state: s3 } = setup();
  await activePurpose();
  seedLifecycle(s3, "IDD-A", "lane_open", 0);
  seedLifecycle(s3, "IDD-A", "s2_start", 10);
  seedLifecycle(s3, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(s3, "IDD-A", "s2_fix_sent", 30);
  seedLifecycle(s3, "IDD-A", "s2_result", 40, { outcome: "success" });
  laneRaise("C-A-1", 5);
  appendRow(choice({ id: "C-B-1", at: colAt(35), by: { lane: "IDD-B" } }));
  assert.equal(rules(runState("IDD-A"), "round").length, 1);
});

test("AC-008: the working round follows the last result, and the watch's list of work events is the one used", async () => {
  // s2_start opens the round when no result has come yet
  {
    const { state } = setup();
    await activePurpose();
    seedLifecycle(state, "IDD-A", "lane_open", 0);
    seedLifecycle(state, "IDD-A", "s2_start", 10);
    const open = rules(runState("IDD-A"), "round");
    assert.equal(open.length, 1, JSON.stringify(open));
    assert.match(open[0].reason, /作業中/);
    appendRow({ event: "waive", at: colAt(15), repo: REPO, by: { lane: "IDD-A" }, kind: "no-choice", reason: "r" });
    assert.equal(rules(runState("IDD-A"), "round").length, 0);
  }

  for (const work of ["s2_fix_sent", "s4_verify_user_judgment_answered", "s3_reject", "s2_review_base_instructed"]) {
    const { state } = setup();
    await activePurpose();
    seedLifecycle(state, "IDD-A", "lane_open", 0);
    seedLifecycle(state, "IDD-A", "s2_start", 5);
    seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
    laneRaise("C-A-1", 6);
    seedLifecycle(state, "IDD-A", work, 30);

    const open = rules(runState("IDD-A"), "round");
    assert.equal(open.length, 1, `${work}: ${JSON.stringify(open)}`);
    assert.match(open[0].reason, /作業中/);

    appendRow({ event: "waive", at: colAt(25), repo: REPO, by: { lane: "IDD-A" }, kind: "no-choice", reason: "r" });
    assert.equal(rules(runState("IDD-A"), "round").length, 0, work);

    // closing the round without a record still leaves the finding
    const { state: s2 } = setup();
    await activePurpose();
    seedLifecycle(s2, "IDD-A", "lane_open", 0);
    seedLifecycle(s2, "IDD-A", "s2_start", 5);
    seedLifecycle(s2, "IDD-A", "s2_result", 20, { outcome: "success" });
    laneRaise("C-A-1", 6);
    seedLifecycle(s2, "IDD-A", work, 30);
    seedLifecycle(s2, "IDD-A", "s2_result", 40, { outcome: "success" });
    assert.equal(rules(runState("IDD-A"), "round").length, 1, work);
  }

  // the list is the watch's own
  assert.deepEqual([...EXECUTOR_WORK].sort(), ["s2_fix_sent", "s2_records_instructed", "s2_review_base_instructed", "s2_start", "s3_reject", "s4_verify_user_judgment_answered"]);
});

test("AC-001: results with no work record between them are one round", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "partial" });
  // the path planner's records sit between the two reports and are not work handed to the executor
  seedLifecycle(state, "IDD-A", "s2_map_started", 25);
  seedLifecycle(state, "IDD-A", "s2_map_done", 30);
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "partial" });
  // a declaration before both reports belongs to the merged round
  laneRaise("C-A-1", 5);
  assert.deepEqual(rules(runState("IDD-A"), "round"), []);
});

test("AC-001: a merged round with no record gives one finding, named by the last report", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "partial" });
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "partial" });
  const found = rules(runState("IDD-A"), "round");
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].reason, /40/);
});

test("AC-002: a merged round counts a declaration after the first report", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "success" });
  laneRaise("C-A-1", 35);
  assert.deepEqual(rules(runState("IDD-A"), "round"), []);
});

test("AC-002: a merged round reads its outcome off the last report", async () => {
  // the first report succeeded and the last failed: the round asks for no record
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "failed" });
  assert.deepEqual(rules(runState("IDD-A"), "round"), []);

  // the first failed and the last succeeded: the round is the last report's, and it asks
  const { state: s2 } = setup();
  await activePurpose();
  seedLifecycle(s2, "IDD-A", "lane_open", 0);
  seedLifecycle(s2, "IDD-A", "s2_start", 10);
  seedLifecycle(s2, "IDD-A", "s2_result", 20, { outcome: "failed" });
  seedLifecycle(s2, "IDD-A", "s2_result", 40, { outcome: "success" });
  const found = rules(runState("IDD-A"), "round");
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].reason, /40/);
});

test("AC-003: a work record between two reports keeps them two rounds", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(state, "IDD-A", "s2_fix_sent", 30);
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "success" });
  // the declaration sits after the fix was sent, so it closes the second round alone
  laneRaise("C-A-1", 35);
  const found = rules(runState("IDD-A"), "round");
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].reason, /20/);
});

test("AC-003: the working round after the last report is read on its own", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(state, "IDD-A", "s2_fix_sent", 30);
  seedLifecycle(state, "IDD-A", "s2_result", 40, { outcome: "success" });
  laneRaise("C-A-1", 35);
  seedLifecycle(state, "IDD-A", "s2_fix_sent", 50);
  const found = rules(runState("IDD-A"), "round");
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.equal(found.some((f) => f.reason.includes("作業中")), true, JSON.stringify(found));
});

test("AC-042: the rows a proposal writes give no finding of their own", async () => {
  const { state } = setup();
  const p = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "S", origin: "O" });
  assert.equal(p.id, "P-1");
  const c = await store.raiseChoice({
    repo: REPO,
    actor: { session: "s1" },
    body: { purpose: "P-1", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x" },
  });
  assert.equal(c.ok, true, c.error);
  const before = runState();
  const at = new Date().toISOString();
  const by = { session: "s1" };
  appendRow({ event: "proposal_raised", at, repo: REPO, by, id: "PROP-1", kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
  appendRow({ event: "purpose_restated", at, repo: REPO, by, id: "P-1", statement: "言い直した概要" });
  appendRow({ event: "harm_example_added", at, repo: REPO, by: { session: "inbox" }, id: "H-1", statement: "戻せない", harm: 2 });
  const after = runState();
  assert.deepEqual(after.findings, before.findings);
  assert.equal(state.length > 0, true);
});

// ---- Issue #181: the module is the Place, and a lane's own rename is read where the file went ----

test("AC-002: a module that stands keeps the check green, and a missing file or symbol is only a mark", () => {
  const { root } = setup();
  put(join(root, "src/a/save.ts"), "export function save() {}\n");
  const choices = [
    { id: "C-1", status: "active", place: [{ path: "src/a/", kind: "module", file: "src/a/save.ts", symbols: ["save"] }], mine: false },
    // the mark left the tree, the module did not: the Choice still reaches its module
    { id: "C-2", status: "active", place: [{ path: "src/a/", kind: "module", file: "src/a/gone.ts" }], mine: false },
    // a symbol that left the file is a mark too
    { id: "C-3", status: "active", place: [{ path: "src/a/", kind: "module", file: "src/a/save.ts", symbols: ["removed"] }], mine: false },
    // the module itself is not there: this is the defect
    { id: "C-4", status: "active", place: [{ path: "src/none/", kind: "module", file: "src/none/x.ts" }], mine: false },
  ];
  const found = checkTree({ choices, rounds: { enteredImplementation: true }, lane: null, changed: null, ...tree(root) });
  assert.deepEqual(found.filter((f) => f.weight === "error").map((f) => f.id), ["C-4"]);
  assert.deepEqual(found.filter((f) => f.weight === "mark").map((f) => [f.id, f.rule]).sort(), [["C-2", "mark"], ["C-3", "symbols"]]);
});

test("AC-002: a Place on a file the lane moved is read at the new path, and never fails for the old one", () => {
  const { root } = setup();
  put(join(root, "src/new/save.ts"), "x\n");
  const choices = [
    { id: "C-1", status: "active", place: [{ path: "src/old/", kind: "module", file: "src/old/save.ts" }], mine: true },
  ];
  const moved = checkTree({
    choices, rounds: { enteredImplementation: true }, lane: "IDD-A", changed: ["src/old/save.ts", "src/new/save.ts"],
    moves: [{ from: "src/old/", to: "src/new/" }], ...tree(root),
  });
  assert.deepEqual(moved.filter((f) => f.weight === "error"), []);
  assert.equal(moved.some((f) => f.rule === "place" && f.weight === "mark" && /src\/new\//.test(f.reason)), true, JSON.stringify(moved));
  // without the lane's rename reading the old module is not there and the lane's own Place is an error
  const without = checkTree({ choices, rounds: { enteredImplementation: true }, lane: "IDD-A", changed: ["src/old/save.ts"], ...tree(root) });
  assert.deepEqual(without.filter((f) => f.weight === "error").map((f) => f.id), ["C-1"]);
});

test("AC-006: a verification anchor whose test left the tree is a mark; the check still passes", () => {
  const { root } = setup();
  mkdirSync(join(root, "src"), { recursive: true });
  put(join(root, "src/intent-check.test.mjs"), "x\n");
  const choices = [
    { id: "C-1", status: "active", place: [{ path: "src/", kind: "module" }], mine: false, verification: ["src/intent-check.test.mjs", "AC-001"] },
    { id: "C-2", status: "active", place: [{ path: "src/", kind: "module" }], mine: false, verification: ["src/gone.test.mjs"] },
    // a bare test name is found anywhere in the tree
    { id: "C-3", status: "active", place: [{ path: "src/", kind: "module" }], mine: false, verification: ["intent-check.test.mjs"] },
  ];
  const found = checkTree({
    choices, rounds: { enteredImplementation: true }, lane: null, changed: null,
    hasFileNamed: (name) => name === "intent-check.test.mjs", ...tree(root),
  });
  const marks = found.filter((f) => f.rule === "verification");
  assert.deepEqual(marks.map((f) => [f.id, f.weight]), [["C-2", "mark"]], JSON.stringify(found));
  assert.deepEqual(found.filter((f) => f.weight === "error"), []);
});

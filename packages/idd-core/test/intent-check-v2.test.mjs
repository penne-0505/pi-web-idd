/**
 * The two rules whose weight follows the lane's record shape: the round rule (a round with no record) and the
 * unconfirmed rule (a touched Place still holding an unconfirmed Choice). A v2 lane is held to them; a v1 lane is
 * only told (DEC-119-7 / AC-031 / AC-032).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import * as store from "../src/intent/store.ts";
import { checkState, checkTree } from "../src/intent/check.ts";
import { readLifecycle } from "../src/ledger/read.ts";
import { laneRecordShape } from "../src/plan/record-shape.ts";

let savedState;
beforeEach(() => { savedState = process.env.IDD_STATE_DIR; });
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
});

const REPO = "me/app";
const BASE = Date.UTC(2026, 9, 13, 0, 0, 0);
const colAt = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
const lifeAt = (minutes) => new Date(BASE + minutes * 60_000 + 9 * 3_600_000).toISOString().replace("Z", "+09:00");

function setup() {
  const root = scratchDir("intent-check-v2-");
  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  return { state };
}

function seedLifecycle(state, iddId, event, minutes, attrs = {}) {
  appendFileSync(join(state, "lifecycle-test.jsonl"), `${JSON.stringify({ event, idd_id: iddId, at: lifeAt(minutes), attrs })}\n`);
}
const appendRow = (row) => appendFileSync(store.intentColumnPath(REPO), `${JSON.stringify(row)}\n`);

const choice = (over = {}) => ({
  event: "choice_raised", at: colAt(0), repo: REPO, by: { session: "s9" }, id: "C-s9-1", purpose: "P-1",
  forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] },
  place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x",
  visibility: "private", status: "unconfirmed", origin: { by: "agent" },
  ...over,
});

function runState(lane) {
  const rows = store.readRows(store.intentColumnPath(REPO));
  const all = readLifecycle();
  const folded = store.foldRows(rows, lane, store.laneStates(all));
  return checkState({ rows, folded, lane, events: all.filter((e) => e.idd_id === lane) });
}

async function activePurpose() {
  const r = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "S", origin: "O" });
  assert.equal(r.ok, true);
}

test("AC-001 / AC-031: a ready marked state makes the lane v2, and its round and touched rules are errors", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  seedLifecycle(state, "IDD-A", "s1_ready", 25, { records_shape: "state" });
  appendRow(choice({ id: "C-A-1", at: colAt(9 * 60 + 10), by: { lane: "IDD-A" }, place: [{ path: "a/b.ts", kind: "file" }] }));

  assert.equal(laneRecordShape("IDD-A", readLifecycle().filter((e) => e.idd_id === "IDD-A")), "state");
  const result = runState("IDD-A");
  assert.equal(result.records_shape, "state");
  const round = result.findings.filter((f) => f.rule === "round");
  assert.equal(round.length, 1, JSON.stringify(result.findings));
  assert.equal(round[0].weight, "error");

  const touched = checkTree({
    choices: result.choices, rounds: result.rounds, lane: "IDD-A", changed: ["a/b.ts"], recordsShape: result.records_shape,
    kindOf: () => "file",
    readFile: () => null,
  }).filter((f) => f.rule === "touched");
  assert.equal(touched.length, 1, JSON.stringify(touched));
  assert.equal(touched[0].weight, "error");
});

test("AC-032 / INV-119-6: a lane with no mark keeps the same rules as notes and does not fail the check", async () => {
  const { state } = setup();
  await activePurpose();
  seedLifecycle(state, "IDD-A", "lane_open", 0);
  seedLifecycle(state, "IDD-A", "s2_start", 10);
  seedLifecycle(state, "IDD-A", "s2_result", 20, { outcome: "success" });
  appendRow(choice({ id: "C-A-1", at: colAt(9 * 60 + 10), by: { lane: "IDD-A" }, place: [{ path: "a/b.ts", kind: "file" }] }));

  const result = runState("IDD-A");
  assert.equal(result.records_shape, "docs");
  const round = result.findings.filter((f) => f.rule === "round");
  assert.equal(round.length, 1);
  assert.equal(round[0].weight, "note");
  const touched = checkTree({
    choices: result.choices, rounds: result.rounds, lane: "IDD-A", changed: ["a/b.ts"], recordsShape: result.records_shape,
    kindOf: () => "file",
    readFile: () => null,
  }).filter((f) => f.rule === "touched");
  assert.equal(touched.length, 1);
  assert.equal(touched[0].weight, "note");
});

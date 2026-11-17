import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import * as store from "../src/intent/store.ts";
import { FREE_WHILE_WHY, normalizePlace, normalizePlaces } from "../src/intent/records.ts";

let savedState;
beforeEach(() => { savedState = process.env.IDD_STATE_DIR; });
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
});

const REPO = "me/app";

function setup() {
  const root = scratchDir("intent-store-");
  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  return { root, state };
}

function seedLifecycle(state, iddId, event, attrs = {}, at = new Date().toISOString()) {
  appendFileSync(join(state, "lifecycle-test.jsonl"), `${JSON.stringify({ event, idd_id: iddId, at, attrs })}\n`);
}

function columnFile(repo = REPO) {
  return store.intentColumnPath(repo);
}

function rows(repo = REPO) {
  const path = columnFile(repo);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const choiceBody = (over = {}) => ({
  purpose: "P-1",
  forms: { chosen: "A", rejected: [{ form: "B", fails_because: "壊れる" }] },
  place: [{ path: "a/b/c.ts", kind: "file" }],
  why: "w",
  anchored: "x",
  ...over,
});

/**
 * an active Purpose raised by the outside, for the tests that need a Choice. The first one a column gets names the
 * overview's seat (the seat the default `choiceBody` points at); later ones take the next number by themselves.
 */
async function activePurpose(repo = REPO, id) {
  const seated = rows(repo).some((r) => r.event === "purpose_raised" && r.id === "P-1");
  const named = id ?? (seated ? undefined : "P-1");
  const r = await store.raisePurpose({ repo, actor: { session: "s1" }, statement: "S", origin: "O", ...(named ? { id: named } : {}) });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

// ---- Purpose and Choice ids, status ----

test("AC-001 / AC-002: ids are assigned in sequence from P-2 and a lane's Purpose is a proposal", async () => {
  const { state } = setup();
  const a = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S1", origin: "O1" });
  assert.equal(a.ok, true, a.error);
  assert.equal(a.id, "P-2", "an id nobody named never takes the overview's seat");
  assert.equal(a.status, "active");
  const b = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S2", origin: "O2" });
  assert.equal(b.id, "P-3");
  const lane = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-099" }, statement: "SL", origin: "OL" });
  assert.equal(lane.status, "proposed");
  assert.equal(lane.id, "P-4");

  const list = store.listRecords({ repo: REPO, actor: null });
  assert.deepEqual(list.purposes.map((p) => p.id), ["P-2", "P-3"]);
  const laneView = store.listRecords({ repo: REPO, actor: { lane: "IDD-099" } });
  assert.deepEqual(laneView.purposes.map((p) => p.id), ["P-2", "P-3", "P-4"]);
  assert.equal(laneView.purposes[2].status, "proposed");
  const p2 = list.purposes[0];
  assert.equal(p2.statement, "S1");
  assert.equal(p2.origin, "O1");
  assert.equal(p2.status, "active");
  assert.deepEqual(p2.raised.by, { session: "s1" });
  assert.ok(p2.raised.at);
  assert.equal(readdirSync(state).filter((f) => f.startsWith("intent-")).length, 1);
  assert.equal(rows().some((r) => r.id === "P-1"), false, "no row of the column holds the overview's seat");
});

/** a person's raise, outside any lane, with the statement and origin every raise needs; `over` names an id or changes a field */
const humanRaise = (over = {}) => store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O", ...over });

/** a row written straight to the column, for the states a door cannot make (a lane's proposal the outside cannot see) */
function seedRow(event, over) {
  appendFileSync(columnFile(), `${JSON.stringify({ event, at: new Date().toISOString(), repo: REPO, id: "P-1", ...over })}\n`);
}

const p1Rows = () => rows().filter((r) => r.id === "P-1");

test("AC-001 / AC-002: on an empty column a lane's proposal takes P-2, and the seat stays free for a person who names it", async () => {
  setup();
  const lane = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-099" }, statement: "Issue 1 件の目的", origin: "lane" });
  assert.equal(lane.id, "P-2");
  assert.equal(p1Rows().length, 0);
  const overview = await humanRaise({ id: "P-1", statement: "repo の概要" });
  assert.equal(overview.ok, true, overview.error);
  assert.equal(overview.status, "active");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "P-1" }).record.statement, "repo の概要");
});

test("AC-004: a lane cannot name an id, and an active P-1 is refused without a row", async () => {
  setup();
  assert.equal((await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-099" }, id: "P-1", statement: "S", origin: "O" })).ok, false);
  assert.equal(rows().length, 0);
  assert.equal((await humanRaise({ id: "P-1" })).ok, true);
  const again = await humanRaise({ id: "P-1", statement: "S2" });
  assert.equal(again.ok, false);
  assert.ok(again.error.startsWith("ID P-1 は既にあります"), again.error);
  assert.equal(p1Rows().length, 1);
});

test("AC-004: a proposed P-1 a running lane holds is a seat in effect; once the lane ends unmerged the seat is free", async () => {
  setup();
  seedRow("purpose_raised", { by: { lane: "IDD-099" }, statement: "案", origin: "O", status: "proposed" });
  const refused = await humanRaise({ id: "P-1" });
  assert.equal(refused.ok, false);
  assert.ok(refused.error.startsWith("ID P-1 は既にあります"), refused.error);
  assert.equal(p1Rows().length, 1);
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-099", "lane_close", { outcome: "aborted" });
  assert.equal((await humanRaise({ id: "P-1" })).ok, true);
});

test("AC-003: a withdrawn P-1 nobody points at is written again by name, and the column keeps both rows", async () => {
  setup();
  seedRow("purpose_raised", { by: { lane: "IDD-099" }, statement: "古い案", origin: "O", status: "proposed" });
  seedRow("purpose_withdrawn", { by: { session: "inbox" }, grounds: "g" });
  const r = await humanRaise({ id: "P-1", statement: "新しい概要" });
  assert.equal(r.ok, true, r.error);
  assert.equal(p1Rows().filter((row) => row.event === "purpose_raised").length, 2);
  const shown = store.showRecord({ repo: REPO, actor: null, id: "P-1" }).record;
  assert.deepEqual([shown.status, shown.statement], ["active", "新しい概要"]);
  assert.equal((await humanRaise({ id: "P-1", statement: "三つ目" })).ok, false, "the new statement holds the seat now");
});

test("AC-003 / AC-004: a retired P-1 is rewritable only while no Choice row points at it, and no other id is reusable", async () => {
  setup();
  assert.equal((await humanRaise({ id: "P-1" })).ok, true);
  const choice = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-1" }) });
  assert.equal(choice.ok, true, choice.error);
  assert.equal((await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", grounds: "g" })).ok, true);
  const before = rows().length;
  const refused = await humanRaise({ id: "P-1", statement: "S2" });
  assert.equal(refused.ok, false);
  assert.ok(refused.error.startsWith("ID P-1 は既にあります"), refused.error);
  assert.equal(rows().length, before, "a refused raise adds no row");

  const other = await activePurpose();
  await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: other, grounds: "g" });
  assert.equal((await humanRaise({ id: other })).ok, false);
});

test("AC-003 / INV-099-4: only the outside confirms and retires; a lane's own call is refused and writes nothing", async () => {
  setup();
  const lane = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-099" }, statement: "S", origin: "O" });
  const refusedConfirm = await store.confirmPurpose({ repo: REPO, actor: { lane: "IDD-099" }, id: lane.id });
  assert.equal(refusedConfirm.ok, false);
  const refusedRetire = await store.retirePurpose({ repo: REPO, actor: { lane: "IDD-099" }, id: lane.id, grounds: "g" });
  assert.equal(refusedRetire.ok, false);
  assert.equal(rows().length, 1, "a refused call adds no row");

  // the outside still sees a proposal only from the lane's own side, and confirming turns that side's view active
  const outside = store.listRecords({ repo: REPO, actor: null });
  assert.deepEqual(outside.purposes, []);
  const confirmed = await store.confirmPurpose({ repo: REPO, actor: { session: "s1" }, id: lane.id });
  assert.equal(confirmed.ok, true, confirmed.error);
  const laneView = store.listRecords({ repo: REPO, actor: { lane: "IDD-099" } });
  assert.equal(laneView.purposes.find((p) => p.id === lane.id).status, "active");
  // a confirmed Purpose cannot be confirmed twice
  assert.equal((await store.confirmPurpose({ repo: REPO, actor: { session: "s1" }, id: lane.id })).ok, false);

  // retire needs Grounds, and works on a Purpose the outside itself raised
  const global = await activePurpose();
  assert.equal((await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: global })).ok, false);
  const retired = await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: global, grounds: "不要" });
  assert.equal(retired.ok, true, retired.error);
  const after = store.listRecords({ repo: REPO, actor: null }).purposes.find((p) => p.id === global);
  assert.equal(after.status, "retired");
  assert.equal(after.grounds, "不要");
});

test("AC-004 / INV-099-5: a Choice is refused against a proposed, retired or absent Purpose, and stands after the confirm", async () => {
  setup();
  const proposed = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-099" }, statement: "S", origin: "O" });
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: proposed.id }) })).ok, false);
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: "P-404" }) })).ok, false);
  await store.confirmPurpose({ repo: REPO, actor: { session: "s1" }, id: proposed.id });
  const ok = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: proposed.id }) });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.id, "C-099-1");

  // a retired Purpose takes no new Choice
  const global = await activePurpose();
  await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: global, grounds: "g" });
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: global }) })).ok, false);
});

test("AC-005: each required field is refused by name; visibility defaults private and free defaults to the constant", async () => {
  setup();
  await activePurpose();
  for (const field of ["purpose", "forms", "place", "why", "anchored"]) {
    const body = choiceBody();
    delete body[field];
    const r = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body });
    assert.equal(r.ok, false, field);
    assert.match(r.error, new RegExp(field), field);
  }
  const def = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody() });
  assert.equal(def.ok, true, def.error);
  const rec = store.showRecord({ repo: REPO, actor: null, id: def.id });
  assert.equal(rec.record.visibility, "private");
  assert.equal(rec.record.free, FREE_WHILE_WHY);

  const pub = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ visibility: "public" }) });
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: pub.id }).record.visibility, "public");
  const freed = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ free: "自由", revisit: "あとで" }) });
  const freedRec = store.showRecord({ repo: REPO, actor: null, id: freed.id }).record;
  assert.equal(freedRec.free, "自由");
  assert.equal(freedRec.revisit, "あとで");
});

test("AC-001 / AC-006: the module is the canonical Place, and its marks carry the file and symbols", () => {
  // the module is accepted as it stands, and a file or a dir Place is read as the module it names
  assert.deepEqual(normalizePlace({ path: "a/b/", kind: "module" }).value, { path: "a/b/", kind: "module" });
  assert.deepEqual(normalizePlace({ path: "a/b.ts", kind: "file" }).value, { path: "a/", kind: "module", file: "a/b.ts" });
  assert.deepEqual(normalizePlace({ path: "a/b/", kind: "dir" }).value, { path: "a/b/", kind: "module" });
  assert.deepEqual(normalizePlace({ path: "/", kind: "root" }).value, { path: "/", kind: "root" });
  // a file at the top of the tree belongs to the repo's own module
  assert.deepEqual(normalizePlace({ path: "README.md", kind: "file" }).value, { path: "/", kind: "module", file: "README.md" });
  // and a Place already in that form keeps its file mark, so the record stays on that one file
  assert.deepEqual(normalizePlace({ path: "/", kind: "module", file: "package.json" }).value, { path: "/", kind: "module", file: "package.json" });
  assert.deepEqual(normalizePlace({ path: "./", kind: "module", file: "README.md", symbols: ["install"] }).value, { path: "/", kind: "module", file: "README.md", symbols: ["install"] });
  assert.equal(normalizePlace({ path: "/", kind: "module", file: "docs/x.md" }).ok, false, "a file outside the repo's own module is refused");
  assert.equal(normalizePlace({ path: "/", kind: "file" }).ok, false);
  assert.equal(normalizePlace({ path: "./a/b.ts", kind: "file" }).value.file, "a/b.ts");
  // the marks ride inside the module's Place, and a file outside the module is refused
  assert.deepEqual(normalizePlace({ path: "a/", kind: "module", file: "a/b.ts", symbols: ["runTick"] }).value, { path: "a/", kind: "module", file: "a/b.ts", symbols: ["runTick"] });
  for (const p of [
    { path: "a/b/", kind: "file" },
    { path: "a/b", kind: "dir" },
    { path: "a/b", kind: "module" },
    { path: "/a", kind: "file" },
    { path: "a/../b.ts", kind: "file" },
    { path: "a b.ts", kind: "file" },
    { path: "a", kind: "wat" },
    { path: "", kind: "file" },
    { path: "a/", kind: "module", file: "b/c.ts" },
    { path: "a/", kind: "module", file: "a/b/" },
    { path: "a/" , kind: "file", file: "a/b.ts" },
  ]) assert.equal(normalizePlace(p).ok, false, JSON.stringify(p));
  assert.equal(normalizePlaces([]).ok, false);
  assert.equal(normalizePlace({ path: "a.ts", kind: "file", symbols: [1] }).ok, false);
  assert.equal(normalizePlace({ path: "a.ts", kind: "file", symbols: ["runTick"] }).ok, true);
});

test("AC-007: a Place that is on no disk still stands", async () => {
  setup();
  await activePurpose();
  const r = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ place: [{ path: "not/here/yet.ts", kind: "file" }] }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(store.lookupChoices({ repo: REPO, actor: null, paths: ["not/here/yet.ts"] }).length, 1);
});

test("AC-008 / INV-099-6: a Choice with no rejected form and no reason is refused; with a reason it is one row", async () => {
  setup();
  await activePurpose();
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ forms: { chosen: "A", rejected: [] } }) })).ok, false);
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ forms: { chosen: "A", rejected: [{ form: "B" }] } }) })).ok, false);
  const before = rows().length;
  const r = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ forms: { chosen: "A", rejected: [] }, no_why_not: "理由" }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(rows().length, before + 1);
  const rec = store.showRecord({ repo: REPO, actor: null, id: r.id }).record;
  assert.deepEqual(rec.waives.map((w) => w.reason), ["理由"]);
});

test("AC-009: a lane's id is C-<digits>-<n> and a session's is C-<session>-<n>", async () => {
  setup();
  const p = await activePurpose();
  const c1 = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: p }) });
  const c2 = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: p }) });
  assert.equal(c1.id, "C-099-1");
  assert.equal(c2.id, "C-099-2");
  const s1 = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p }) });
  assert.equal(s1.id, "C-s1-1");
});

test("AC-010: the outside may name a migrated id and status; a lane may not", async () => {
  setup();
  const p = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O", id: "P-7" });
  assert.equal(p.id, "P-7");
  assert.equal((await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O", id: "P-7" })).ok, false);
  for (const id of ["DEC-123", "DEC-088-1", "DEC-IddCore-12"]) {
    const r = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-7", id, status: "unconfirmed" }) });
    assert.equal(r.ok, true, `${id}: ${r.error}`);
    assert.equal(r.status, "unconfirmed");
  }
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-7", id: "DEC-123", status: "unconfirmed" }) })).ok, false);
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-7", id: "C-x-1" }) })).ok, false);
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: "P-7", id: "DEC-999" }) })).ok, false);
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: "P-7", status: "unconfirmed" }) })).ok, false);
});

test("AC-011: re-anchor keeps the id and rewrites place and anchored", async () => {
  setup();
  const p = await activePurpose();
  const c = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p }) });
  const r = await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: c.id, place: [{ path: "x/y/", kind: "dir" }], anchored: "new" });
  assert.equal(r.ok, true, r.error);
  const rec = store.showRecord({ repo: REPO, actor: null, id: c.id }).record;
  assert.equal(rec.id, c.id);
  assert.equal(rec.anchored, "new");
  assert.deepEqual(rec.place, [{ path: "x/y/", kind: "module" }]);
  assert.equal(rec.history.at(-1).event, "re-anchored");
  assert.equal((await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: c.id })).ok, false);

  const u = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, id: "DEC-50", status: "unconfirmed" }) });
  await store.dropChoice({ repo: REPO, actor: { session: "s1" }, id: u.id, grounds: "g" });
  assert.equal((await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: u.id, anchored: "z" })).ok, false);
});

test("AC-001 / AC-002: an unconfirmed Choice is re-anchored by its Place alone and stays unconfirmed", async () => {
  setup();
  const p = await activePurpose();
  const u = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, id: "DEC-50", status: "unconfirmed", place: [{ path: "old/a.ts", kind: "file" }], anchored: "old-anchored" }) });
  assert.equal(u.ok, true, u.error);
  // anchored says what the body must hold: an unconfirmed Choice has not been read against the code, so it cannot be judged
  const refused = await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: u.id, anchored: "new" });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(refused.error, /place だけ/);
  assert.equal(rows().filter((r) => r.event === "choice_reanchored").length, 0, "the refusal writes no row");
  // a lane too may move it: the Choice is not on a touched file, so a move is not a judgement of the body
  const moved = await store.reanchor({ repo: REPO, actor: { lane: "IDD-099" }, id: u.id, place: [{ path: "new/a.ts", kind: "file" }] });
  assert.equal(moved.ok, true, moved.error);
  const rec = store.showRecord({ repo: REPO, actor: { lane: "IDD-099" }, id: u.id }).record;
  assert.equal(rec.status, "unconfirmed");
  assert.deepEqual(rec.place, [{ path: "new/", kind: "module", file: "new/a.ts" }]);
  assert.equal(rec.anchored, "old-anchored");
  assert.equal(rec.history.at(-1).event, "re-anchored");
  // the root gate is the same for an unconfirmed Choice
  const rootU = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, id: "DEC-51", status: "unconfirmed", place: [{ path: "/", kind: "root" }] }) });
  assert.equal((await store.reanchor({ repo: REPO, actor: { lane: "IDD-099" }, id: rootU.id, place: [{ path: "a/b/c.ts", kind: "file" }] })).ok, false);
  // an active Choice still takes the anchored with the place
  const active = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "old/b.ts", kind: "file" }] }) });
  assert.equal((await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: active.id, place: [{ path: "new/b.ts", kind: "file" }], anchored: "new" })).ok, true);
  const arec = store.showRecord({ repo: REPO, actor: null, id: active.id }).record;
  assert.equal(arec.status, "active");
  assert.equal(arec.anchored, "new");
});

test("AC-012: Supersede raises the successor and keeps the old body in one row", async () => {
  setup();
  const p = await activePurpose();
  const old = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, why: "old-why" }) });
  const before = rows().length;
  const s = await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [old.id], grounds: "g", body: choiceBody({ purpose: p }) });
  assert.equal(s.ok, true, s.error);
  assert.equal(rows().length, before + 1);
  const rec = store.showRecord({ repo: REPO, actor: null, id: old.id }).record;
  assert.equal(rec.status, "superseded");
  assert.equal(rec.why, "old-why");
  assert.equal(rec.history.at(-1).successor, s.id);
  assert.equal(rec.history.at(-1).grounds, "g");
  assert.equal((await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [s.id], grounds: "", body: choiceBody({ purpose: p }) })).ok, false);
  assert.equal((await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [old.id], grounds: "g", body: choiceBody({ purpose: p }) })).ok, false);
});

test("AC-001 / AC-002: Supersede may point at a Choice already standing, and closes several in one row", async () => {
  setup();
  const p = await activePurpose();
  const successor = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, why: "successor-why", place: [{ path: "a/live.ts", kind: "file" }] }) });
  const old1 = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, why: "old-1", place: [{ path: "a/one.ts", kind: "file" }] }) });
  const old2 = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, why: "old-2", place: [{ path: "a/two.ts", kind: "file" }] }) });
  const successorBefore = store.showRecord({ repo: REPO, actor: null, id: successor.id }).record;
  const before = rows().length;
  const s = await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [old1.id, old2.id], grounds: "R2 を外した", by: successor.id });
  assert.equal(s.ok, true, s.error);
  assert.deepEqual({ id: s.id, status: s.status }, { id: successor.id, status: "active" });
  assert.equal(rows().length, before + 1, "one row closes every Choice at once");
  assert.equal(rows().at(-1).event, "choice_superseded");
  for (const [old, why] of [[old1, "old-1"], [old2, "old-2"]]) {
    const rec = store.showRecord({ repo: REPO, actor: null, id: old.id }).record;
    assert.equal(rec.status, "superseded");
    assert.equal(rec.why, why);
    assert.deepEqual(rec.forms, choiceBody().forms);
    assert.equal(rec.anchored, "x");
    assert.equal(rec.history.at(-1).event, "superseded");
    assert.equal(rec.history.at(-1).successor, successor.id);
    assert.equal(rec.history.at(-1).grounds, "R2 を外した");
  }
  // the successor's own body and status are what they were
  assert.deepEqual(store.showRecord({ repo: REPO, actor: null, id: successor.id }).record, successorBefore);
  // a replaced Choice leaves a lookup; the successor stays
  const got = store.lookupChoices({ repo: REPO, actor: null, paths: ["a/one.ts", "a/live.ts"] }).map((c) => c.id);
  assert.equal(got.includes(old1.id), false);
  assert.equal(got.includes(successor.id), true);
  // the same side is accepted as before: a closed Choice is not re-anchored
  assert.equal((await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: old1.id, place: [{ path: "a/new.ts", kind: "file" }] })).ok, false);
});

test("AC-003: a closed, absent, self or doubled successor is refused and writes no row", async () => {
  setup();
  const p = await activePurpose();
  const live = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/live.ts", kind: "file" }] }) });
  const old = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/old.ts", kind: "file" }] }) });
  const closed = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/closed.ts", kind: "file" }] }) });
  await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [closed.id], grounds: "g", by: live.id });
  const gone = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, id: "DEC-77", status: "unconfirmed", place: [{ path: "a/gone.ts", kind: "file" }] }) });
  await store.dropChoice({ repo: REPO, actor: { session: "s1" }, id: gone.id, grounds: "g" });

  const before = rows().length;
  const refused = [
    { name: "superseded successor", ids: [old.id], by: closed.id },
    { name: "dropped successor", ids: [old.id], by: gone.id },
    { name: "the Choice the row replaces", ids: [live.id], by: live.id },
    { name: "no successor", ids: [old.id] },
    { name: "two successors", ids: [old.id], by: live.id, body: choiceBody({ purpose: p }) },
    { name: "a successor that is not in the state", ids: [old.id], by: "C-404-1" },
    // an unusable --by is not a missing one: reading it as missing would raise a new Choice from the body
    { name: "a successor id that is not a string, with a body", ids: [old.id], by: 42, body: choiceBody({ purpose: p }) },
    { name: "an empty successor id, with a body", ids: [old.id], by: "  ", body: choiceBody({ purpose: p }) },
    { name: "a successor id that is not a string, without a body", ids: [old.id], by: { id: live.id } },
  ];
  for (const c of refused) {
    const r = await store.supersede({ repo: REPO, actor: { session: "s1" }, grounds: "g", ids: c.ids, by: c.by, body: c.body });
    assert.equal(r.ok, false, c.name);
  }
  assert.equal(rows().length, before, "a refused replacement writes no row");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: old.id }).record.status, "active");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: live.id }).record.status, "active");
});

test("AC-003: two lanes replacing each other's Choice cannot both land", async () => {
  setup();
  const p = await activePurpose();
  const a = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/a.ts", kind: "file" }] }) });
  const b = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/b.ts", kind: "file" }] }) });
  const first = await store.supersede({ repo: REPO, actor: { lane: "IDD-A" }, ids: [a.id], grounds: "g", by: b.id });
  assert.equal(first.ok, true, first.error);
  const before = rows().length;
  // lane B's own window still shows a as standing, so only the column can tell it the chain would close
  assert.equal(store.showRecord({ repo: REPO, actor: { lane: "IDD-B" }, id: a.id }).record.status, "active");
  const back = await store.supersede({ repo: REPO, actor: { lane: "IDD-B" }, ids: [b.id], grounds: "g", by: a.id });
  assert.equal(back.ok, false);
  assert.equal(rows().length, before, "the refused replacement writes no row");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: a.id }).record.status, "active");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: b.id }).record.status, "active");
});

test("AC-003: a Choice closed twice by two lanes still closes nothing through either successor", async () => {
  setup();
  const p = await activePurpose();
  const x = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/x.ts", kind: "file" }] }) });
  const y = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/y.ts", kind: "file" }] }) });
  const z = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/z.ts", kind: "file" }] }) });
  // two lanes close the same Choice with different successors; neither sees the other's row
  assert.equal((await store.supersede({ repo: REPO, actor: { lane: "IDD-A" }, ids: [x.id], grounds: "g", by: y.id })).ok, true);
  assert.equal((await store.supersede({ repo: REPO, actor: { lane: "IDD-B" }, ids: [x.id], grounds: "g", by: z.id })).ok, true);
  const before = rows().length;
  // the state shows one of the two successors for x; the other edge is only in the column, and a third lane
  // pointing y back at x would close the chain through it
  const back = await store.supersede({ repo: REPO, actor: { lane: "IDD-C" }, ids: [y.id], grounds: "g", by: x.id });
  assert.equal(back.ok, false);
  assert.equal(rows().length, before, "the refused replacement writes no row");
});

test("AC-003: a three-lane chain is refused at the row that would close it", async () => {
  setup();
  const p = await activePurpose();
  const raised = [];
  for (const name of ["a", "b", "c"]) {
    raised.push(await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: `a/${name}.ts`, kind: "file" }] }) }));
  }
  const [a, b, c] = raised;
  assert.equal((await store.supersede({ repo: REPO, actor: { lane: "IDD-A" }, ids: [a.id], grounds: "g", by: b.id })).ok, true);
  assert.equal((await store.supersede({ repo: REPO, actor: { lane: "IDD-B" }, ids: [b.id], grounds: "g", by: c.id })).ok, true);
  const before = rows().length;
  const closing = await store.supersede({ repo: REPO, actor: { lane: "IDD-C" }, ids: [c.id], grounds: "g", by: a.id });
  assert.equal(closing.ok, false);
  assert.equal(rows().length, before);
});

test("AC-003: a lane that ended without landing leaves no row to close a chain", async () => {
  const { state } = setup();
  const p = await activePurpose();
  const a = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/a.ts", kind: "file" }] }) });
  const b = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/b.ts", kind: "file" }] }) });
  assert.equal((await store.supersede({ repo: REPO, actor: { lane: "IDD-A" }, ids: [a.id], grounds: "g", by: b.id })).ok, true);
  seedLifecycle(state, "IDD-A", "lane_close", { outcome: "aborted" });
  const back = await store.supersede({ repo: REPO, actor: { lane: "IDD-B" }, ids: [b.id], grounds: "g", by: a.id });
  assert.equal(back.ok, true, back.error);
});

test("AC-013: an unconfirmed Choice leaves through confirm or drop", async () => {
  setup();
  const p = await activePurpose();
  const u = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, id: "DEC-1", status: "unconfirmed" }) });
  assert.equal((await store.confirmChoice({ repo: REPO, actor: { session: "s1" }, id: u.id })).ok, true);
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: u.id }).record.status, "active");

  const u2 = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, id: "DEC-2", status: "unconfirmed" }) });
  assert.equal((await store.dropChoice({ repo: REPO, actor: { session: "s1" }, id: u2.id })).ok, false);
  assert.equal((await store.dropChoice({ repo: REPO, actor: { session: "s1" }, id: u2.id, grounds: "現物と違う" })).ok, true);
  const dropped = store.showRecord({ repo: REPO, actor: null, id: u2.id }).record;
  assert.equal(dropped.status, "dropped");
  assert.equal(dropped.why, "w");
  assert.equal(dropped.history.at(-1).grounds, "現物と違う");
  assert.equal((await store.dropChoice({ repo: REPO, actor: { session: "s1" }, id: u.id, grounds: "g" })).ok, false);
});

test("AC-014: a root Choice is not replaced from a lane, but a lane may raise its own root Choice", async () => {
  setup();
  const p = await activePurpose();
  const root = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "/", kind: "root" }] }) });
  assert.equal((await store.supersede({ repo: REPO, actor: { lane: "IDD-099" }, ids: [root.id], grounds: "g", body: choiceBody({ purpose: p }) })).ok, false);
  // the same side is refused when the successor already stands
  const standing = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p }) });
  assert.equal((await store.supersede({ repo: REPO, actor: { lane: "IDD-099" }, ids: [root.id], grounds: "g", by: standing.id })).ok, false);
  assert.equal((await store.reanchor({ repo: REPO, actor: { lane: "IDD-099" }, id: root.id, anchored: "x" })).ok, false);
  assert.equal((await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [root.id], grounds: "g", body: choiceBody({ purpose: p }) })).ok, true);
  assert.equal((await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: p, place: [{ path: "/", kind: "root" }] }) })).ok, true);
});

test("AC-015: a Waive takes the fields its kind needs, and records who declared it", async () => {
  setup();
  const p = await activePurpose();
  const c = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p }) });
  assert.equal((await store.waive({ repo: REPO, actor: { session: "s1" }, kind: "applied", choices: [c.id] })).ok, true);
  assert.equal((await store.waive({ repo: REPO, actor: { session: "s1" }, kind: "no-choice", reason: "新しい判断" })).ok, true);
  assert.equal((await store.waive({ repo: REPO, actor: { session: "s1" }, kind: "bogus" })).ok, false);
  assert.equal((await store.waive({ repo: REPO, actor: { session: "s1" }, kind: "applied", choices: [] })).ok, false);
  assert.equal((await store.waive({ repo: REPO, actor: { session: "s1" }, kind: "applied", choices: ["C-nope-1"] })).ok, false);
  assert.equal((await store.waive({ repo: REPO, actor: { session: "s1" }, kind: "no-choice", reason: "" })).ok, false);
  const waives = store.listRecords({ repo: REPO, actor: null, kind: "waives" }).waives;
  assert.equal(waives.length, 2);
  assert.deepEqual(waives[0].by, { session: "s1" });
  assert.ok(waives[0].at);
});

test("AC-016: a Place lookup returns the file's mark, a dir's Choice, the module's other files, then root", async () => {
  setup();
  const p = await activePurpose();
  const actor = { session: "s1" };
  await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "a/b/", kind: "dir" }] }) });
  await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "a/", kind: "dir" }] }) });
  await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "/", kind: "root" }] }) });
  await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "a/b/d.ts", kind: "file" }] }) });
  await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "a/x/", kind: "dir" }] }) });
  // an unconfirmed Choice is returned as well
  await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, id: "DEC-77", status: "unconfirmed", place: [{ path: "a/b/c.ts", kind: "file" }] }) });

  const got = store.lookupChoices({ repo: REPO, actor: null, paths: ["a/b/c.ts"] });
  // the file's own Choice first, then the dir's, then the same module's other file (module), then root
  assert.deepEqual(got.map((c) => c.matched[0].kind), ["file", "file", "dir", "dir", "module", "root"]);
  assert.deepEqual(got[0].matched, [{ path: "a/b/c.ts", place: "a/b/", kind: "file", file: "a/b/c.ts" }]);
  assert.ok(got[0].purpose_statement);
  // the sibling of the same module is reached as a heading, never as the file's own Choice
  assert.deepEqual(got[4].matched, [{ path: "a/b/c.ts", place: "a/b/", kind: "module", file: "a/b/d.ts" }]);

  // another module's dir and the root still match a path outside the file's module
  const none = store.lookupChoices({ repo: REPO, actor: null, paths: ["a/b/c.ts.bak"] });
  assert.deepEqual(none.map((c) => c.matched[0].kind), ["dir", "dir", "module", "module", "module", "root"]);
});

test("AC-017: superseded and dropped Choices are out of a lookup but readable by id", async () => {
  setup();
  const p = await activePurpose();
  const actor = { session: "s1" };
  const live = await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  const old = await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  await store.supersede({ repo: REPO, actor, ids: [old.id], grounds: "g", body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  const dead = await store.raiseChoice({ repo: REPO, actor, body: choiceBody({ purpose: p, id: "DEC-9", status: "unconfirmed", place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  await store.dropChoice({ repo: REPO, actor, id: dead.id, grounds: "g" });

  const got = store.lookupChoices({ repo: REPO, actor: null, paths: ["a/b/c.ts"] });
  assert.equal(got.some((c) => c.id === old.id), false);
  assert.equal(got.some((c) => c.id === dead.id), false);
  assert.equal(got.some((c) => c.id === live.id), true);
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: old.id }).record.status, "superseded");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: dead.id }).record.status, "dropped");
});

test("AC-018 / AC-019 / INV-099-2: a lane's records apply inside until it merges, then to everyone", async () => {
  setup();
  const p = await activePurpose();
  const old = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  const neu = await store.supersede({ repo: REPO, actor: { lane: "IDD-A" }, ids: [old.id], grounds: "g", body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  assert.equal(neu.ok, true, neu.error);

  const ids = (actor) => store.lookupChoices({ repo: REPO, actor, paths: ["a/b/c.ts"] }).map((c) => c.id);
  assert.deepEqual(ids({ lane: "IDD-A" }), [neu.id]);
  assert.deepEqual(ids({ lane: "IDD-B" }), [old.id]);
  assert.deepEqual(ids(null), [old.id]);

  for (const outcome of ["local", "merged"]) {
    const { state: s2 } = setup();
    const p2 = await activePurpose();
    const o2 = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p2, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
    const n2 = await store.supersede({ repo: REPO, actor: { lane: "IDD-A" }, ids: [o2.id], grounds: "g", body: choiceBody({ purpose: p2, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
    seedLifecycle(s2, "IDD-A", "lane_close", { outcome });
    assert.deepEqual(store.lookupChoices({ repo: REPO, actor: { lane: "IDD-B" }, paths: ["a/b/c.ts"] }).map((c) => c.id), [n2.id]);
    assert.deepEqual(store.lookupChoices({ repo: REPO, actor: null, paths: ["a/b/c.ts"] }).map((c) => c.id), [n2.id]);
  }
});

test("AC-020 / INV-099-1: an aborted lane's records stay out, and no operation rewrites an earlier line", async () => {
  const { state } = setup();
  const p = await activePurpose();
  const old = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  const before = readFileSync(columnFile(), "utf8");
  await store.supersede({ repo: REPO, actor: { lane: "IDD-A" }, ids: [old.id], grounds: "g", body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  seedLifecycle(state, "IDD-A", "lane_close", { outcome: "aborted" });
  assert.deepEqual(store.lookupChoices({ repo: REPO, actor: { lane: "IDD-B" }, paths: ["a/b/c.ts"] }).map((c) => c.id), [old.id]);
  assert.deepEqual(store.lookupChoices({ repo: REPO, actor: null, paths: ["a/b/c.ts"] }).map((c) => c.id), [old.id]);
  const after = readFileSync(columnFile(), "utf8");
  assert.equal(after.startsWith(before), true, "the earlier lines stay as they were");
  assert.ok(after.length > before.length, "the aborted lane's row remains in the column");
});

test("AC-021 / INV-099-3: twenty parallel raises take twenty different ids; an ineffective row still takes its number", async () => {
  setup();
  const p = await activePurpose();
  const results = await Promise.all(Array.from({ length: 20 }, () => store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: p }) })));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  assert.equal(new Set(results.map((r) => r.id)).size, 20);
  assert.deepEqual(results.map((r) => r.id).sort(), Array.from({ length: 20 }, (_, i) => `C-099-${i + 1}`).sort());

  // a Purpose a lane raised and that never became effective still occupies P-1
  const lane = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-AB" }, statement: "S", origin: "O" });
  assert.equal(lane.id, "P-2");
  seedLifecycle(process.env.IDD_STATE_DIR, "IDD-AB", "lane_close", { outcome: "aborted" });
  const outside = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O" });
  assert.equal(outside.id, "P-3");
});

test("AC-021 / INV-099-1: processes that write the first rows at once keep every row and every id", async () => {
  const { root } = setup();
  // each child writes the very first row of a column that does not exist yet, so the create and the lock race
  const runner = join(root, "raise-first.mjs");
  const storeUrl = new URL("../src/intent/store.ts", import.meta.url).href;
  writeFileSync(runner, `import * as store from ${JSON.stringify(storeUrl)};\n`
    + "const [repo, statement] = process.argv.slice(2);\n"
    + "const r = await store.raisePurpose({ repo, actor: { session: 's1' }, statement, origin: 'O' });\n"
    + "if (!r.ok) { console.error(r.error); process.exit(1); }\n"
    + "console.log(r.id);\n");
  const run = () => new Promise((done) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", runner, REPO, "S"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => done({ code, id: out.trim(), err }));
  });
  const runs = await Promise.all(Array.from({ length: 8 }, run));
  assert.ok(runs.every((r) => r.code === 0), JSON.stringify(runs.filter((r) => r.code !== 0)));
  assert.equal(rows().length, 8, "no process may truncate another's first rows");
  assert.equal(new Set(runs.map((r) => r.id)).size, 8);
  assert.deepEqual(runs.map((r) => r.id).sort(), Array.from({ length: 8 }, (_, i) => `P-${i + 2}`).sort());
});

test("AC-027 / INV-099-8: an ended lane cannot write, and a row written after its close never applies", async () => {
  for (const end of [
    { event: "lane_close", attrs: { outcome: "local" } },
    { event: "lane_close", attrs: { outcome: "aborted" } },
    { event: "s1_defer", attrs: {} },
    { event: "s3_defer", attrs: {} },
  ]) {
    const { state } = setup();
    const p = await activePurpose();
    seedLifecycle(state, "IDD-A", end.event, end.attrs);
    const refused = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-A" }, body: choiceBody({ purpose: p }) });
    assert.equal(refused.ok, false, JSON.stringify(end));
    assert.equal(rows().filter((r) => r.by?.lane === "IDD-A").length, 0);
  }

  const { state } = setup();
  const p = await activePurpose();
  const old = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/b/c.ts", kind: "file" }] }) });
  const closedAt = "2026-10-12T10:00:00.000Z";
  seedLifecycle(state, "IDD-A", "lane_close", { outcome: "local" }, closedAt);
  // a row by the merged lane at a time after its close: written straight to the column, past the door
  const late = {
    event: "choice_raised", at: "2026-10-12T11:00:00.000Z", repo: REPO, by: { lane: "IDD-A" },
    id: "C-IDD-A-9", purpose: p, forms: { chosen: "x", rejected: [{ form: "y", fails_because: "z" }] },
    place: [{ path: "a/b/c.ts", kind: "file" }], why: "w", anchored: "a", visibility: "private", status: "active",
    origin: { by: "agent" }, supersedes: [{ id: old.id, grounds: "g" }],
  };
  appendFileSync(columnFile(), `${JSON.stringify(late)}\n`);
  for (const actor of [{ lane: "IDD-B" }, { lane: "IDD-A" }, null]) {
    assert.deepEqual(store.lookupChoices({ repo: REPO, actor, paths: ["a/b/c.ts"] }).map((c) => c.id), [old.id], JSON.stringify(actor));
  }
  // a row by the same lane before the close does apply
  const early = { ...late, at: "2026-10-12T09:00:00.000Z", id: "C-IDD-A-8", supersedes: [{ id: old.id, grounds: "g" }] };
  appendFileSync(columnFile(), `${JSON.stringify(early)}\n`);
  assert.deepEqual(store.lookupChoices({ repo: REPO, actor: null, paths: ["a/b/c.ts"] }).map((c) => c.id), ["C-IDD-A-8"]);
});

test("AC-028: two repo keys that a flat file name would collide stay in separate columns and ids", async () => {
  const { state } = setup();
  for (const [repo, statement] of [["a/b-c", "SA"], ["a-b/c", "SB"]]) {
    const r = await store.raisePurpose({ repo, actor: { session: "s1" }, statement, origin: "O" });
    assert.equal(r.id, "P-2");
  }
  assert.equal(store.listRecords({ repo: "a/b-c", actor: null }).purposes[0].statement, "SA");
  assert.equal(store.listRecords({ repo: "a-b/c", actor: null }).purposes[0].statement, "SB");
  assert.equal(readdirSync(state).filter((f) => f.startsWith("intent-")).length, 2);
});

// ---- Issue IDD-100: the migration entrance and the Purpose name ----

test("AC-016 / INV-100-4: the outside may carry the migration mark, a lane may not, and the INV id forms are taken", async () => {
  setup();
  const p = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O", id: "P-1" });
  assert.equal(p.ok, true, p.error);
  const migration = { doc: "_docs/intent/demo/idd-001/decision.md", purpose_from: "人の見直し", source: "質問 Q-1", created: "2026-01-02" };
  const r = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-1", id: "DEC-123", status: "unconfirmed", migration }) });
  assert.equal(r.ok, true, r.error);
  const rec = store.showRecord({ repo: REPO, actor: null, id: "DEC-123" }).record;
  assert.deepEqual(rec.origin.migrated, migration);
  assert.equal(rec.history[0].at, "2026-01-02", "the created history entry carries the document's date");
  assert.equal(rec.status, "unconfirmed");
  const raised = rows().find((row) => row.id === "DEC-123");
  assert.notEqual(raised.at, "2026-01-02", "the row's own at stays its own time");

  // a lane cannot pass the migration mark, and the refusal writes no row
  const before = rows().length;
  const refused = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-099" }, body: choiceBody({ purpose: "P-1", migration }) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /移行の出どころ/);
  assert.equal(rows().length, before);

  // the parentless-INV id forms are taken; a C- id is not, and the refusal names both heads
  for (const id of ["INV-12", "INV-088-1", "INV-IddCore-3"]) {
    const ok = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-1", id, status: "unconfirmed" }) });
    assert.equal(ok.ok, true, `${id}: ${ok.error}`);
    assert.equal(ok.id, id);
  }
  const badId = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-1", id: "C-x-1" }) });
  assert.equal(badId.ok, false);
  assert.match(badId.error, /DEC-/);
  assert.match(badId.error, /INV-/);

  // the migration field's shape is checked
  for (const bad of [
    { doc: "", purpose_from: "人の見直し" },
    { doc: "d", purpose_from: "推定" },
    { doc: "d", purpose_from: "人の見直し", created: "2026/01/02" },
  ]) {
    const one = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-1", migration: bad }) });
    assert.equal(one.ok, false, JSON.stringify(bad));
  }
});

test("AC-017 / DEC-100-4: a Purpose may carry a short name, and the outside may give it one when it confirms", async () => {
  setup();
  const named = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O", name: "名前" });
  assert.equal(named.ok, true, named.error);
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: named.id }).record.name, "名前");

  // a row written without a name still reads, and reads without one
  const unnamed = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "S", origin: "O" });
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: unnamed.id }).record.name, undefined);

  // a lane raises a proposal, without or with a name; only the outside confirms
  const lane = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-099" }, statement: "S", origin: "O" });
  assert.equal((await store.confirmPurpose({ repo: REPO, actor: { lane: "IDD-099" }, id: lane.id, name: "だめ" })).ok, false);
  const confirmed = await store.confirmPurpose({ repo: REPO, actor: { session: "s1" }, id: lane.id, name: "確かめた名前" });
  assert.equal(confirmed.ok, true, confirmed.error);
  const view = store.listRecords({ repo: REPO, actor: { lane: "IDD-099" } }).purposes.find((p) => p.id === lane.id);
  assert.equal(view.status, "active");
  assert.equal(view.name, "確かめた名前", "the confirming row's name wins over the raise's");

  const laneNamed = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-099" }, statement: "S", origin: "O", name: "案の名前" });
  const laneView = store.listRecords({ repo: REPO, actor: { lane: "IDD-099" } }).purposes.find((p) => p.id === laneNamed.id);
  assert.equal(laneView.status, "proposed");
  assert.equal(laneView.name, "案の名前");
});

// ---- Issue IDD-106: the repo's visibility default ----

test("AC-022: a body without a visibility takes the repo's default, and the row always carries one", async () => {
  const { root } = setup();
  const repos = join(root, "repos.yaml");
  writeFileSync(repos, JSON.stringify({
    repos: { [REPO]: { name: "app", upstream: root, work: root, public_base: "main", intent: { visibility_default: "public" } } },
  }));
  const saved = process.env.IDD_REPOS_FILE;
  process.env.IDD_REPOS_FILE = repos;
  try {
    const p = await activePurpose();
    const pub = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p }) });
    assert.equal(pub.ok, true, pub.error);
    assert.equal(store.showRecord({ repo: REPO, actor: null, id: pub.id }).record.visibility, "public");

    // a body that names private keeps private
    const priv = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, visibility: "private" }) });
    assert.equal(store.showRecord({ repo: REPO, actor: null, id: priv.id }).record.visibility, "private");

    // the successor of a Supersede takes the default too, and the row itself always carries a value
    const next = await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [pub.id], grounds: "g", body: choiceBody({ purpose: p }) });
    assert.equal(next.ok, true, next.error);
    assert.equal(store.showRecord({ repo: REPO, actor: null, id: next.id }).record.visibility, "public");
    assert.equal(rows().filter((r) => r.event === "choice_raised").every((r) => r.visibility === "public" || r.visibility === "private"), true);
  } finally {
    if (saved === undefined) delete process.env.IDD_REPOS_FILE;
    else process.env.IDD_REPOS_FILE = saved;
  }
});

// ---- Issue #181: the module is the Place, and the landing follows the lane's renames ----

test("AC-001: the conversion is one row of the lane, and every Place of an older row reads as its module", async () => {
  const { state } = setup();
  const p = await activePurpose();
  // a row written before the module was the canonical form: the file it names is read as the module plus its mark
  appendFileSync(columnFile(), `${JSON.stringify({
    event: "choice_raised", at: "2026-10-01T00:00:00Z", repo: REPO, by: { session: "s1" }, id: "C-old-1", purpose: p,
    forms: { chosen: "A", rejected: [{ form: "B", fails_because: "fails" }] }, place: [{ path: "src/a/save.ts", kind: "file", symbols: ["save"] }],
    why: "w", anchored: "x", visibility: "private", status: "active", origin: { by: "agent" },
  })}\n`);
  const before = rows().length;
  const folded = store.showRecord({ repo: REPO, actor: null, id: "C-old-1" }).record;
  assert.deepEqual(folded.place, [{ path: "src/a/", kind: "module", file: "src/a/save.ts", symbols: ["save"] }]);

  // the lane writes the conversion once; a second call adds nothing
  const first = await store.recordPlacesModule(REPO, "IDD-9");
  assert.equal(first.ok, true, first.error);
  assert.equal(first.written, true);
  assert.equal(rows().length, before + 1);
  assert.equal(rows().at(-1).event, "places_module");
  assert.deepEqual(rows().at(-1).by, { lane: "IDD-9" });
  const again = await store.recordPlacesModule(REPO, "IDD-9");
  assert.equal(again.ok, true, again.error);
  assert.equal(again.written, false, "the conversion is a row of the lane, not one per call");
  assert.equal(rows().length, before + 1);
  // the old row is untouched: the column is append-only
  assert.deepEqual(rows()[before - 1].place, [{ path: "src/a/save.ts", kind: "file", symbols: ["save"] }]);
  // after the conversion the Choice reads as the module again, with the file mark, and its body is unchanged
  const after = store.showRecord({ repo: REPO, actor: { lane: "IDD-9" }, id: "C-old-1" }).record;
  assert.deepEqual(after.place, folded.place);
  assert.equal(after.why, "w");
  // the conversion names no Choice: a record this lane did not raise or move is not read as its own re-anchor
  assert.deepEqual(after.history.map((h) => h.event), ["created"]);
});

test("AC-001: a Choice raised in today's form after the conversion reads as the same module", async () => {
  setup();
  const p = await activePurpose();
  await store.recordPlacesModule(REPO, "IDD-9");
  const raised = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "src/a/save.ts", kind: "file" }] }) });
  assert.equal(raised.ok, true, raised.error);
  const rec = store.showRecord({ repo: REPO, actor: null, id: raised.id }).record;
  assert.deepEqual(rec.place, [{ path: "src/a/", kind: "module", file: "src/a/save.ts" }]);
});

test("AC-003: the landing's follow keeps another lane's own re-anchor, not overwriting it", async () => {
  const { state } = setup();
  const p = await activePurpose();
  const at = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
  const raised = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/x.ts", kind: "file" }] }) });
  assert.equal(raised.ok, true, raised.error);
  // lane B moves the Choice by hand before either lane lands
  appendFileSync(columnFile(), `${JSON.stringify({ event: "choice_reanchored", at: at(1), repo: REPO, by: { lane: "IDD-B" }, id: raised.id, place: [{ path: "b/x.ts", kind: "file" }] })}\n`);
  // lane A lands its own rename of the old file; the row carries the move, not a whole Place list
  const followed = await store.recordPlaceMoves(REPO, "IDD-A", [{ from: "a/x.ts", to: "a/y.ts" }]);
  assert.equal(followed.ok, true, followed.error);
  assert.equal(followed.written, true);
  assert.deepEqual(followed.moved, [raised.id]);
  const row = rows().at(-1);
  assert.equal(row.event, "places_moved");
  assert.deepEqual(row.moves, [{ from: "a/x.ts", to: "a/y.ts" }]);
  assert.equal("place" in row, false, "a follow carries the move, so an earlier Re-anchor is not overwritten");

  // both lanes land: B's own move stands, and lane A's move leaves it alone because it is no longer on the old path
  seedLifecycle(state, "IDD-A", "lane_open", {}, at(0));
  seedLifecycle(state, "IDD-B", "lane_open", {}, at(0));
  seedLifecycle(state, "IDD-A", "lane_close", { outcome: "merged" }, at(2));
  seedLifecycle(state, "IDD-B", "lane_close", { outcome: "merged" }, at(3));
  const rec = store.showRecord({ repo: REPO, actor: null, id: raised.id }).record;
  assert.deepEqual(rec.place, [{ path: "b/", kind: "module", file: "b/x.ts" }]);
  assert.deepEqual(rec.history.filter((h) => h.event === "re-anchored").map((h) => h.by), [{ lane: "IDD-B" }]);
});

test("AC-003: an earlier follow does not cancel a lane's later Re-anchor", async () => {
  const { state } = setup();
  const p = await activePurpose();
  const at = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
  const raised = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/x.ts", kind: "file" }] }) });
  assert.equal(raised.ok, true, raised.error);
  // lane A's follow is written first, and lane B's own Re-anchor lands after it
  const followed = await store.recordPlaceMoves(REPO, "IDD-A", [{ from: "a/x.ts", to: "a/z.ts" }]);
  assert.equal(followed.ok, true, followed.error);
  assert.deepEqual(store.showRecord({ repo: REPO, actor: { lane: "IDD-A" }, id: raised.id }).record.place, [{ path: "a/", kind: "module", file: "a/z.ts" }]);
  appendFileSync(columnFile(), `${JSON.stringify({ event: "choice_reanchored", at: at(4), repo: REPO, by: { lane: "IDD-B" }, id: raised.id, place: [{ path: "b/x.ts", kind: "file" }] })}\n`);
  seedLifecycle(state, "IDD-A", "lane_open", {}, at(0));
  seedLifecycle(state, "IDD-B", "lane_open", {}, at(0));
  seedLifecycle(state, "IDD-A", "lane_close", { outcome: "merged" }, at(5));
  seedLifecycle(state, "IDD-B", "lane_close", { outcome: "merged" }, at(6));
  const landed = store.showRecord({ repo: REPO, actor: null, id: raised.id }).record;
  assert.deepEqual(landed.place, [{ path: "b/", kind: "module", file: "b/x.ts" }], "B's own move is not cancelled by an earlier follow");
});

test("AC-003: a follow rewrites the Place that still stands on the moved path, and nothing else", async () => {
  const { state } = setup();
  const p = await activePurpose();
  const other = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/keep.ts", kind: "file" }] }) });
  const moved = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/x.ts", kind: "file" }] }) });
  const wholeDir = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: p, place: [{ path: "a/sub/", kind: "dir" }] }) });
  assert.equal(other.ok && moved.ok && wholeDir.ok, true);
  seedLifecycle(state, "IDD-A", "lane_open", {}, "2026-10-01T00:00:00Z");
  // a file move inside the dir, and the dir itself moving under a new name
  const r = await store.recordPlaceMoves(REPO, "IDD-A", [{ from: "a/", to: "c/" }, { from: "a/x.ts", to: "c/x.ts" }]);
  assert.equal(r.ok, true, r.error);
  const at = { repo: REPO, actor: { lane: "IDD-A" } };
  const x = store.showRecord({ ...at, id: moved.id }).record;
  assert.deepEqual(x.place, [{ path: "c/", kind: "module", file: "c/x.ts" }]);
  const keep = store.showRecord({ ...at, id: other.id }).record;
  assert.deepEqual(keep.place, [{ path: "c/", kind: "module", file: "c/keep.ts" }], "a file of the moved dir follows too");
  const dir = store.showRecord({ ...at, id: wholeDir.id }).record;
  assert.deepEqual(dir.place, [{ path: "c/sub/", kind: "module" }], "a dir's own Choice follows the dir");
  // a row of the same lane repeating the same moves is not written twice
  const again = await store.recordPlaceMoves(REPO, "IDD-A", [{ from: "a/", to: "c/" }, { from: "a/x.ts", to: "c/x.ts" }]);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.written, false);
  assert.equal(rows().filter((r) => r.event === "places_moved").length, 1);
  // no Place stands on the moved path: no row at all
  const none = await store.recordPlaceMoves(REPO, "IDD-A", [{ from: "z/none.ts", to: "z/there.ts" }]);
  assert.equal(none.ok, true, none.error);
  assert.equal(none.written, false);
});

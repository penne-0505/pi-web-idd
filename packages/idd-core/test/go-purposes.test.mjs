import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import { applyDecision } from "../src/ledger/write.ts";
import { readLifecycle } from "../src/ledger/read.ts";
import * as store from "../src/intent/store.ts";
import { runAutoGo } from "../src/plan/auto-go.ts";

const REPO = "demo";
const LANE = "IDD-001";

let savedState;
let savedRepos;
beforeEach(() => {
  savedState = process.env.IDD_STATE_DIR;
  savedRepos = process.env.IDD_REPOS_FILE;
});
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
  if (savedRepos === undefined) delete process.env.IDD_REPOS_FILE;
  else process.env.IDD_REPOS_FILE = savedRepos;
  delete process.env.IDD_LANE_GATE_WAIT_MS;
});

const at = (n = 0) => new Date(Date.now() + n).toISOString();
const ev = (event, attrs = {}, time = at()) => ({ event, idd_id: LANE, at: time, attrs });

function setup(events = [ev("lane_open"), ev("s1_ready"), ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 })]) {
  const root = scratchDir("go-purposes-");
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: { demo: { github: "t/p", upstream: join(root, "up"), work: join(root, "work") } } }));
  writeFileSync(join(state, "backlog.jsonl"), `${JSON.stringify({ idd_id: LANE, area: REPO, title: "T", context: "" })}\n`);
  writeFileSync(join(state, "lifecycle-demo.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") });
  return { root, state };
}

/** a lane the planner has been sent back, so no GO is taken */
const setupSentBack = () => setup([ev("lane_open"), ev("s1_ready"), ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }), ev("s1_revise_requested")]);
const goRows = () => readLifecycle().filter((e) => e.event === "s1_go");
const columnRows = () => {
  const path = store.intentColumnPath(REPO);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const lanePurposes = (actor = { lane: LANE }) => store.listRecords({ repo: REPO, actor }).purposes;
const byId = (purposes, id) => purposes.find((p) => p.id === id);

async function propose(lane, statement) {
  const r = await store.raisePurpose({ repo: REPO, actor: { lane }, statement, origin: "O" });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

async function proposeEach(...statements) {
  const ids = [];
  for (const statement of statements) ids.push(await propose(LANE, statement));
  return ids;
}

const lifecycleCount = () => readLifecycle().length;
const decide = (action, body) => applyDecision(action, { iddId: LANE, ...body });
const go = (purposes) => decide("s1_go", purposes ? { purposes } : {});
const restate = (id, statement) => decide("purpose_restate", { id, statement });
const withdraw = (id, grounds) => decide("purpose_withdraw", { id, grounds });
const done = (r) => {
  assert.equal(r.ok, true, r.error);
  return r;
};
const refused = (r, pattern, label) => {
  assert.equal(r.ok, false, label);
  if (pattern) assert.match(r.error, pattern, label);
};
const snapshot = () => ({ column: columnRows(), lifecycle: lifecycleCount(), go: goRows().length });
const assertUnchanged = (before, label) => {
  assert.deepEqual(columnRows(), before.column, label);
  assert.equal(lifecycleCount(), before.lifecycle, label);
  assert.equal(goRows().length, before.go, label);
};
/** the column rows after one more press: exactly `n` added, none changed or removed */
const grown = (before, n = 1) => {
  const after = columnRows();
  assert.equal(after.length, before.column.length + n);
  assert.deepEqual(after.slice(0, before.column.length), before.column, "no row is changed or removed");
  return after;
};
/** the planner reports again, stamped with the very second of the row it answers: a new ready and its review done */
const replan = () => {
  const stamp = readLifecycle().at(-1).at;
  appendFileSync(
    join(process.env.IDD_STATE_DIR, "lifecycle-demo.jsonl"),
    [ev("s1_ready", {}, stamp), ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }, stamp)].map((e) => `${JSON.stringify(e)}\n`).join(""),
  );
};

test("AC-002: a lane with no proposals goes through with the same payload it always did", async () => {
  setup();
  const before = snapshot();
  done(await go());
  assert.equal(goRows().length, 1);
  assert.deepEqual(goRows()[0].attrs, { at_by: "user" });
  assert.equal("purposes" in goRows()[0].attrs, false);
  assert.deepEqual(columnRows(), before.column, "the intent column is not written");
});

test("AC-003 / AC-004: a GO naming every proposal activates them, names and all, in one record", async () => {
  setup();
  const [p1, p2] = await proposeEach("S1", "S2");
  const before = snapshot();
  done(await go([{ id: p1, statement: "S1", name: "取っ手" }, { id: p2, statement: "S2" }]));
  assert.equal(goRows().length, 1, "the confirmation is the GO's one record");
  assert.deepEqual(goRows()[0].attrs.purposes, [{ id: p1, name: "取っ手" }, { id: p2 }]);
  assert.deepEqual(columnRows(), before.column, "no row is added to the intent column");
  const shown = lanePurposes();
  assert.equal(byId(shown, p1).status, "active");
  assert.equal(byId(shown, p1).name, "取っ手");
  assert.equal(byId(shown, p2).status, "active");
  assert.equal(byId(shown, p2).name, undefined);
  // an active Purpose can carry a Choice now
  const choice = await store.raiseChoice({
    repo: REPO,
    actor: { lane: LANE },
    body: { purpose: p1, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a.ts", kind: "file" }], why: "w", anchored: "x" },
  });
  assert.equal(choice.ok, true, choice.error);
});

test("AC-005 / AC-006 / INV-112-1: a GO that leaves a proposal out is refused and changes nothing", async () => {
  setup();
  const [p1, p2] = await proposeEach("S1", "S2");
  const before = snapshot();
  const refusal = await go([{ id: p1 }]);
  refused(refusal, new RegExp(p2));
  assert.match(refusal.error, /更新/);
  refused(await go(), undefined, "a GO with no purposes list is refused while proposals stand");
  assertUnchanged(before, "nothing was written");
  for (const p of lanePurposes()) assert.equal(p.status, "proposed");
});

test("AC-007 / INV-112-7: a GO the stage refuses leaves the proposals alone", async () => {
  setupSentBack();
  const p1 = await propose(LANE, "S1");
  refused(await go([{ id: p1 }]));
  assert.equal(goRows().length, 0);
  assert.equal(lanePurposes()[0].status, "proposed");
});

test("AC-045 / INV-112-7: a GO whose record cannot be written activates nothing", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes into a read-only directory");
  const { state } = setup();
  const p1 = await propose(LANE, "S1");
  const before = snapshot();
  process.env.IDD_LANE_GATE_WAIT_MS = "300";
  chmodSync(state, 0o555);
  try {
    await assert.rejects(go([{ id: p1 }]));
  } finally {
    chmodSync(state, 0o755);
  }
  assert.equal(goRows().length, 0);
  assert.deepEqual(columnRows(), before.column);
  assert.equal(lanePurposes()[0].status, "proposed");
});

/** the planner raised "S1" under `name`; a GO sending `named` for it leaves the Purpose active under `expected` */
async function goNamed(raisedName, named, expected, why) {
  setup();
  const r = await store.raisePurpose({ repo: REPO, actor: { lane: LANE }, statement: "S1", origin: "O", name: raisedName });
  assert.equal(r.ok, true, r.error);
  done(await go([{ id: r.id, statement: "S1", ...(named ? { name: named } : {}) }]));
  assert.equal(lanePurposes()[0].status, "active");
  assert.equal(lanePurposes()[0].name, expected, why);
}

test("F-1: the name the GO card carries wins over the name on the raising row", async () => {
  await goNamed("agent-name", "人の名前", "人の名前", "the person's name is not dropped in favour of the raising row's");
});

test("F-1: a GO that names nothing keeps the raising row's name", async () => {
  await goNamed("agent-name", undefined, "agent-name");
});

test("AC-045: the proposals of two GO records are all active", async () => {
  const { state } = setup();
  const p1 = await propose(LANE, "S1");
  done(await go([{ id: p1, statement: "S1" }]));
  // the lane went round again and its second GO named one more
  const p2 = await propose(LANE, "S2");
  appendFileSync(join(state, "lifecycle-demo.jsonl"), `${JSON.stringify(ev("s1_go", { at_by: "user", purposes: [{ id: p2 }] }, at(10)))}\n`);
  const shown = lanePurposes();
  assert.equal(goRows().length, 2);
  assert.equal(byId(shown, p1).status, "active");
  assert.equal(byId(shown, p2).status, "active");
});

test("AC-001 / AC-002: a rewrite adds one column row and no lifecycle row, and keeps the planner's sentence", async () => {
  setup();
  const p1 = await propose(LANE, "計画役の文");
  const before = snapshot();
  done(await restate(p1, "人の文"));
  assert.equal(lifecycleCount(), before.lifecycle, "the lane does not move");
  assert.equal(grown(before).at(-1).event, "purpose_restated");
  const shown = byId(lanePurposes(), p1);
  assert.equal(shown.status, "proposed");
  assert.equal(shown.statement, "人の文");
  assert.equal(shown.raised_statement, "計画役の文");
  assert.deepEqual(store.showRecord({ repo: REPO, actor: { lane: LANE }, id: p1 }).record.raised_statement, "計画役の文");
  assert.deepEqual(store.proposedPurposesForLane(REPO, LANE).map((p) => p.statement), ["人の文"]);
});

/** a GO whose card shows another sentence for `id` than the record's is refused whole, and the proposal stays a proposal */
async function refusedGo(id, purposes) {
  const before = snapshot();
  refused(await go(purposes), new RegExp(id));
  assertUnchanged(before, "nothing was confirmed");
  assert.equal(lanePurposes()[0].status, "proposed");
}

/** the withdrawal row alone lands: the send-back that should follow it is not written */
async function withdrawLanded(id) {
  const w = await store.withdrawPurposeProposal({ repo: REPO, lane: LANE, by: { session: "inbox" }, id, grounds: "要らない" });
  assert.equal(w.ok, true, w.error);
}

test("AC-004: a GO after a rewrite confirms the rewritten sentence; a GO from the old sentence is refused and writes nothing", async () => {
  setup();
  const p1 = await propose(LANE, "計画役の文");
  done(await restate(p1, "人の文"));
  await refusedGo(p1, [{ id: p1, statement: "計画役の文" }]);
  done(await go([{ id: p1, statement: "人の文" }]));
  assert.deepEqual(goRows()[0].attrs.purposes, [{ id: p1 }], "the GO carries ids, and the sentence is the one on the record");
  const active = byId(lanePurposes(), p1);
  assert.equal(active.status, "active");
  assert.equal(active.statement, "人の文");
  assert.equal(active.raised_statement, "計画役の文");
});

test("AC-004: a GO that sends no sentence for a proposal is refused and confirms nothing", async () => {
  setup();
  const p1 = await propose(LANE, "S1");
  done(await restate(p1, "S1 を直した"));
  await refusedGo(p1, [{ id: p1 }]);
  done(await go([{ id: p1, statement: "S1 を直した" }]));
  assert.equal(lanePurposes()[0].statement, "S1 を直した");
});

test("AC-003: a withdrawal adds one column row with its grounds, and no GO confirms the proposal after it", async () => {
  setup();
  const [p1, p2] = await proposeEach("S1", "S2");
  const before = snapshot();
  done(await withdraw(p1, "出典に無い動機が入っている"));
  assert.equal(grown(before).at(-1).event, "purpose_withdrawn");
  const withdrawn = byId(lanePurposes(), p1);
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.grounds, "出典に無い動機が入っている");
  assert.deepEqual(store.proposedPurposesForLane(REPO, LANE).map((p) => p.id), [p2], "the list of proposals no longer has it");
  // the planner has reported again: the screen that still shows the withdrawn proposal is refused as a whole
  replan();
  refused(await go([{ id: p1, statement: "S1" }, { id: p2, statement: "S2" }]), new RegExp(p1));
  assert.equal(goRows().length, 0);
  done(await go([{ id: p2, statement: "S2" }]));
  assert.deepEqual(goRows()[0].attrs.purposes, [{ id: p2 }]);
  const shown = lanePurposes();
  assert.equal(byId(shown, p1).status, "withdrawn", "the GO did not make it active");
  assert.equal(byId(shown, p2).status, "active");
});

test("AC-003: a lane whose only proposal was withdrawn goes through with a GO that names nothing once the planner reports again", async () => {
  setup();
  done(await withdraw(await propose(LANE, "S1"), "要らない"));
  replan();
  done(await go());
  assert.equal("purposes" in goRows()[0].attrs, false);
});

test("AC-001 / AC-006: a withdrawal sends the plan back to the planner in the same press, and a GO is refused until it reports again", async () => {
  setup();
  const p1 = await propose(LANE, "S1");
  const lifecycleBefore = lifecycleCount();
  const r = done(await withdraw(p1, "出典に無い動機が入っている"));
  assert.ok(r.envelopeId, "the planner is woken through the outbox");
  const rows = readLifecycle();
  assert.equal(rows.length, lifecycleBefore + 1, "one lifecycle row: the send-back");
  assert.equal(rows.at(-1).event, "s1_revise_requested");
  assert.match(rows.at(-1).attrs.instruction, new RegExp(p1));
  assert.match(rows.at(-1).attrs.instruction, /出典に無い動機が入っている/);
  refused(await go(), new RegExp(`${p1}）の取り下げで、計画を計画役に差し戻しています`), "no GO while the planner has not reported again");
  assert.doesNotMatch(readLifecycle().at(-1).attrs.instruction, /草案の Choice/);
  assert.equal(goRows().length, 0);
  replan();
  done(await go());
});

test("AC-001: a withdrawal says which Choice drafts point at the taken-back proposal", async () => {
  setup([
    ev("lane_open"),
    ev("s1_ready", { plan_records: { choices: [{ purpose: "P-1", chosen: "x" }], existing: [] } }),
    ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }),
  ]);
  const p1 = await propose(LANE, "S1");
  // the draft names the proposal the planner raised
  const file = join(process.env.IDD_STATE_DIR, "lifecycle-demo.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").replace('"P-1"', JSON.stringify(p1)));
  done(await withdraw(p1, "要らない"));
  assert.match(readLifecycle().at(-1).attrs.instruction, /草案の Choice がそれを指している/);
  refused(await go(), /取り下げた案を指す Choice があるので、計画を出し直しています/, "a GO from the old card is told about the Choice that points at it");
});

test("AC-001: a rewrite leaves the lane where it is and does not wake the planner", async () => {
  setup();
  const p1 = await propose(LANE, "S1");
  const lifecycleBefore = lifecycleCount();
  assert.equal(done(await restate(p1, "人の文")).envelopeId, undefined);
  assert.equal(lifecycleCount(), lifecycleBefore);
});

test("AC-005: the two judgements reach only this lane's proposals, and a refused press writes nothing", async () => {
  setup();
  const mine = await propose(LANE, "S1");
  const theirs = await propose("IDD-002", "他の lane の案");
  const overview = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "既にある目的", origin: "O" });
  assert.equal(overview.ok, true, overview.error);
  const before = snapshot();
  const tries = [
    ["purpose_restate", { id: theirs, statement: "x" }, /ありません/],
    ["purpose_withdraw", { id: theirs, grounds: "x" }, /ありません/],
    ["purpose_restate", { id: overview.id, statement: "x" }, /案ではありません/],
    ["purpose_withdraw", { id: overview.id, grounds: "x" }, /案ではありません/],
    ["purpose_restate", { id: "P-99", statement: "x" }, /ありません/],
    ["purpose_restate", { id: mine, statement: "S1" }, /同じ/],
    ["purpose_restate", { id: mine, statement: "  " }, /statement/],
    ["purpose_withdraw", { id: mine, grounds: "  " }, /grounds/],
    ["purpose_restate", { id: "", statement: "x" }, /id/],
  ];
  for (const [action, body, pattern] of tries) refused(await decide(action, body), pattern, `${action} ${JSON.stringify(body)}`);
  assertUnchanged(before);
  assert.equal(byId(lanePurposes(), mine).status, "proposed");
});

/** both judgements on `id` are refused */
async function bothRefused(id) {
  for (const [name, press] of [["restate", restate], ["withdraw", withdraw]]) refused(await press(id, "x"), undefined, name);
}

test("AC-005: a proposal already confirmed by a GO is no longer a proposal to rewrite or take back", async () => {
  setup();
  const p1 = await propose(LANE, "S1");
  done(await go([{ id: p1, statement: "S1" }]));
  // the GO moved the lane past its waiting stage, so the stage refuses first
  await bothRefused(p1);
  assert.equal(lanePurposes()[0].status, "active");
  assert.equal(lanePurposes()[0].statement, "S1");
});

test("AC-005: a lane that cannot take a GO now takes neither judgement", async () => {
  setupSentBack();
  const p1 = await propose(LANE, "S1");
  const before = snapshot();
  await bothRefused(p1);
  assertUnchanged(before);
});

test("AC-005: a lane's own call cannot rewrite or take back a proposal (the store takes a person's actor only)", async () => {
  setup();
  const p1 = await propose(LANE, "S1");
  const before = snapshot();
  const base = { repo: REPO, lane: LANE, by: { lane: LANE }, id: p1 };
  refused(await store.restatePurposeProposal({ ...base, statement: "x" }));
  refused(await store.withdrawPurposeProposal({ ...base, grounds: "x" }));
  assertUnchanged(before);
});

test("AC-006: after a withdrawal the engine's auto GO does not run ahead of the planner's new report", async () => {
  setup([
    ev("lane_open"), ev("s1_ready", { depth: "shallow" }),
    ev("s1_plan_review_started", { run_ids: ["r"] }), ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }),
  ]);
  done(await withdraw(await propose(LANE, "S1"), "出典に無い動機が入っている"));
  const before = snapshot();
  const auto = await runAutoGo();
  assert.deepEqual(auto.recorded, [], "the lane is with the planner, so no GO is recorded");
  assert.deepEqual(auto.errors, []);
  assertUnchanged(before);
});

test("AC-001 / AC-006: a lane whose withdrawal landed without its send-back takes no GO over the old plan, and the planner can still be sent back", async () => {
  setup();
  const [p1, p2] = await proposeEach("S1", "S2");
  await withdrawLanded(p1);
  const before = snapshot();
  for (const purposes of [undefined, [{ id: p2, statement: "S2" }]]) refused(await go(purposes), /差し戻しが記録されていません/);
  assertUnchanged(before, "a refused GO writes nothing");
  assert.equal(byId(lanePurposes(), p2).status, "proposed");
  done(await decide("s1_revise", { instruction: "案を立て直して" }));
  replan();
  done(await go([{ id: p2, statement: "S2" }]));
});

test("AC-006: a revise from an earlier round in the withdrawal's second is not read as the withdrawal's send-back", async () => {
  const stamp = at();
  setup([
    ev("lane_open", {}, at(-9000)), ev("s1_ready", {}, at(-8000)), ev("s1_revise_requested", { instruction: "前の巡" }, stamp),
    ev("s1_ready", {}, stamp), ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }, stamp),
  ]);
  const [p1, p2] = await proposeEach("S1", "S2");
  await withdrawLanded(p1);
  const before = snapshot();
  refused(await go([{ id: p2, statement: "S2" }]), /差し戻しが記録されていません/);
  assertUnchanged(before, "a refused GO writes nothing");
  done(await decide("s1_revise", { instruction: "案を立て直して" }));
  assert.equal(readLifecycle().at(-1).attrs.purpose_id, p1, "the card's revise names the withdrawal it answers");
  replan();
  done(await go([{ id: p2, statement: "S2" }]));
});

test("AC-006: a planner that reports again within the withdrawal's own second is not read as the old plan", async () => {
  // the first plan is older by whole seconds: the ledger's own stamps and these fixtures differ in form inside one second
  setup([ev("lane_open", {}, at(-9000)), ev("s1_ready", {}, at(-8000)), ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }, at(-7000))]);
  const [p1, p2] = await proposeEach("S1", "S2");
  done(await withdraw(p1, "要らない"));
  assert.equal(readLifecycle().at(-1).attrs.purpose_id, p1, "the send-back names the proposal it came from");
  // the ready carries the very stamp of the send-back: the same second as the withdrawal, in the lifecycle's own order
  replan();
  done(await go([{ id: p2, statement: "S2" }]));
});

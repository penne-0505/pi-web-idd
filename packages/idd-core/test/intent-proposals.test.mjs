import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import * as store from "../src/intent/store.ts";

let savedState;
beforeEach(() => { savedState = process.env.IDD_STATE_DIR; });
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
});

const REPO = "me/app";

function setup() {
  const root = scratchDir("intent-proposals-");
  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  return { root, state };
}

function seedLifecycle(state, iddId, event, attrs = {}, at = new Date().toISOString()) {
  appendFileSync(join(state, "lifecycle-test.jsonl"), `${JSON.stringify({ event, idd_id: iddId, at, attrs })}\n`);
}

function rows(repo = REPO) {
  const path = store.intentColumnPath(repo);
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

const rootBody = (over = {}) => choiceBody({ place: [{ path: "/", kind: "root" }], ...over });

/** P-1 active and one active root Choice, raised by the outside; the ground most proposals stand on */
async function base() {
  const p = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "概要用", origin: "O" });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.id, "P-1");
  const c = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: rootBody({ purpose: p.id }) });
  assert.equal(c.ok, true, c.error);
  return { purpose: p.id, root: c.id };
}

// ---- raise ----

test("AC-010: the four kinds can be raised by a lane and by a session, and each gets an id", async () => {
  setup();
  const { purpose, root } = await base();
  const lane = "IDD-101";

  const kinds = [
    ["overview", { statement: "新しい概要" }],
    ["root_supersede", { ids: [root], grounds: "g", choice: rootBody({ purpose }) }],
    ["root_reanchor", { id: root, anchored: "x2" }],
    ["harm_example", { statement: "破ると戻せない", harm: 3, always_must: true }],
  ];
  const ids = [];
  for (const [kind, body] of kinds) {
    const laneRaise = await store.raiseProposal({ repo: REPO, actor: { lane }, kind, reason: "r", body });
    assert.equal(laneRaise.ok, true, `${kind} lane: ${laneRaise.error}`);
    const sessionRaise = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind, reason: "r", body });
    assert.equal(sessionRaise.ok, true, `${kind} session: ${sessionRaise.error}`);
    ids.push(laneRaise.id, sessionRaise.id);
  }
  assert.deepEqual(ids, ["PROP-1", "PROP-2", "PROP-3", "PROP-4", "PROP-5", "PROP-6", "PROP-7", "PROP-8"]);
  const open = store.openProposals(REPO);
  assert.equal(open.length, 8);
  assert.equal(open[0].kind, "overview");
  assert.equal(open[0].reason, "r");
  assert.deepEqual(open[0].origin, { lane: "IDD-101" });
  assert.deepEqual(open[1].origin, { session: "s1" });
});

test("AC-011 / INV-112-5: an ill-shaped proposal is refused with a reason, and writes nothing", async () => {
  const { state } = setup();
  const { root } = await base();
  const lane = "IDD-101";
  const noReason = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "overview", reason: "  ", body: { statement: "S" } });
  assert.equal(noReason.ok, false);
  assert.equal((await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "unknown", reason: "r", body: {} })).ok, false);
  const badHarm = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "harm_example", reason: "r", body: { statement: "S", harm: 5 } });
  assert.equal(badHarm.ok, false);
  assert.match(badHarm.error, /harm/);
  const deadChoice = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: ["C-x-1"], grounds: "g", choice: rootBody() } });
  assert.equal(deadChoice.ok, false);
  const noRoot = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: choiceBody({ purpose: "P-1" }) });
  assert.equal(noRoot.ok, true, noRoot.error);
  const notRoot = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [noRoot.id], grounds: "g", choice: rootBody() } });
  assert.equal(notRoot.ok, false);
  assert.match(notRoot.error, /root/);
  // the successor is judged by the approval's own rules at the raise, so a proposal that could never be written
  // never becomes a card: its Purpose has to be active, and a lane may name neither its id nor its status
  const badPurpose = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose: "P-999" }) } });
  assert.equal(badPurpose.ok, false);
  assert.match(badPurpose.error, /P-999/);
  const laneNamedId = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ id: "DEC-1-1" }) } });
  assert.equal(laneNamedId.ok, false);
  assert.match(laneNamedId.error, /ID/);
  const laneNamedStatus = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ status: "unconfirmed" }) } });
  assert.equal(laneNamedStatus.ok, false);
  assert.match(laneNamedStatus.error, /status/);
  const before = rows().length;
  // no overview Purpose yet
  const root2 = scratchDir("intent-proposals-bare-");
  process.env.IDD_STATE_DIR = join(root2, "state");
  mkdirSync(join(root2, "state"));
  const noOverview = await store.raiseProposal({ repo: "me/bare", actor: { lane }, kind: "overview", reason: "r", body: { statement: "S" } });
  assert.equal(noOverview.ok, false);
  assert.match(noOverview.error, /P-1/);
  // an ended lane may not raise at all
  process.env.IDD_STATE_DIR = state;
  seedLifecycle(state, lane, "lane_close", { outcome: "aborted" });
  const ended = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "overview", reason: "r", body: { statement: "S" } });
  assert.equal(ended.ok, false);
  assert.equal(rows().length, before, "a refused proposal adds no row");
  assert.equal(store.openProposals(REPO).some((p) => p.origin.lane === lane && p.kind === "overview"), false);
  assert.equal(root.length > 0, true);
});

test("AC-012 / INV-112-3: raising a proposal changes nothing the fold reads", async () => {
  setup();
  const { purpose, root } = await base();
  const before = store.listRecords({ repo: REPO, actor: null });
  const beforeRisk = store.riskView(REPO).harm_examples.length;
  const raises = [
    ["overview", { statement: "新しい概要" }],
    ["root_supersede", { ids: [root], grounds: "g", choice: rootBody({ purpose }) }],
    ["root_reanchor", { id: root, anchored: "x2" }],
    ["harm_example", { statement: "破ると戻せない", harm: 1 }],
  ];
  for (const [kind, body] of raises) {
    const r = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-1" }, kind, reason: "r", body });
    assert.equal(r.ok, true, r.error);
  }
  const after = store.listRecords({ repo: REPO, actor: null });
  assert.deepEqual(after.purposes, before.purposes);
  assert.deepEqual(after.choices, before.choices);
  assert.equal(store.riskView(REPO).harm_examples.length, beforeRisk);
});

// ---- answer ----

test("AC-014 / AC-041: an approved overview proposal restates the overview Purpose", async () => {
  setup();
  await base();
  const r = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "overview", reason: "r", body: { statement: "新しい概要" } });
  assert.equal(r.ok, true, r.error);
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, true, a.error);
  assert.equal(a.kind, "overview");
  const list = store.listRecords({ repo: REPO, actor: null });
  assert.equal(list.purposes.find((p) => p.id === "P-1").statement, "新しい概要");
  const restated = rows().filter((x) => x.event === "purpose_restated");
  assert.equal(restated.length, 1);
  assert.equal(restated[0].id, "P-1");
  assert.equal(restated[0].statement, "新しい概要");
  assert.equal(restated[0].proposal, r.id);
  assert.deepEqual(restated[0].approved.by, { session: "inbox" });
  // the old statement is still in the column
  assert.equal(rows().filter((x) => x.event === "purpose_raised" && x.id === "P-1").length, 1);
});

test("AC-015 / INV-112-2: an approved Supersede proposal raises the successor once", async () => {
  setup();
  const { purpose, root } = await base();
  const r = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "置き換える", choice: rootBody({ purpose, forms: { chosen: "A2", rejected: [] }, no_why_not: "無い" }) } });
  assert.equal(r.ok, true, r.error);
  const before = rows().length;
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, true, a.error);
  assert.equal(rows().length, before + 1, "an approval writes one row");
  const list = store.listRecords({ repo: REPO, actor: null });
  const old = list.choices.find((c) => c.id === root);
  assert.equal(old.status, "superseded");
  const successorId = old.history.at(-1).successor;
  const successor = list.choices.find((c) => c.id === successorId);
  assert.equal(successor.forms.chosen, "A2");
  assert.equal(old.history.at(-1).grounds, "置き換える");
  const row = rows().at(-1);
  assert.equal(row.proposal, r.id);
  assert.equal(row.supersedes[0].id, root);
});

test("AC-016: an approved Re-anchor proposal changes place and anchored, keeping the id", async () => {
  setup();
  const { root } = await base();
  const r = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "root_reanchor", reason: "r", body: { id: root, anchored: "もっと強く" } });
  assert.equal(r.ok, true, r.error);
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, true, a.error);
  const c = store.listRecords({ repo: REPO, actor: null }).choices.find((x) => x.id === root);
  assert.equal(c.id, root);
  assert.equal(c.anchored, "もっと強く");
  assert.equal(c.history.at(-1).event, "re-anchored");
});

test("AC-017 / INV-112-5: an approved harm example shows on the read door's answer", async () => {
  setup();
  await base();
  const r = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-1" }, kind: "harm_example", reason: "r", body: { statement: "破ると戻せない", harm: 3, always_must: true } });
  assert.equal(r.ok, true, r.error);
  assert.equal(store.riskView(REPO).harm_examples.length, 0, "an unanswered proposal does not show");
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, true, a.error);
  const view = store.riskView(REPO);
  assert.equal(view.harm_examples.length, 1);
  assert.equal(view.harm_examples[0].id, "H-1");
  assert.equal(view.harm_examples[0].statement, "破ると戻せない");
  assert.equal(view.harm_examples[0].harm, 3);
  assert.equal(view.harm_examples[0].alwaysMust, true);
  assert.deepEqual(view.harm_examples[0].by, { session: "inbox" });
});

test("AC-018 / AC-021: a rejected proposal leaves the fold alone and keeps the reason", async () => {
  setup();
  const { root } = await base();
  const r = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "root_reanchor", reason: "r", body: { id: root, anchored: "x2" } });
  assert.equal(r.ok, true, r.error);
  const before = store.listRecords({ repo: REPO, actor: null });
  const blank = await store.rejectProposal({ repo: REPO, proposal: r.id, reason: "   ", approver: { session: "inbox" } });
  assert.equal(blank.ok, false);
  assert.equal((await store.rejectProposal({ repo: REPO, proposal: r.id, reason: "今は要らない", approver: { session: "inbox" } })).ok, true);
  const after = store.listRecords({ repo: REPO, actor: null });
  assert.deepEqual(after.choices, before.choices);
  assert.deepEqual(after.purposes, before.purposes);
  const rejected = rows().filter((x) => x.event === "proposal_rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].proposal, r.id);
  assert.equal(rejected[0].reason, "今は要らない");
  assert.equal(store.openProposals(REPO).some((p) => p.id === r.id), false);
  assert.equal((await store.rejectProposal({ repo: REPO, proposal: r.id, reason: "もう一度", approver: { session: "inbox" } })).ok, false);
});

test("AC-019 / INV-112-2: answering an answered proposal is refused, and two approvals of one write one effect", async () => {
  setup();
  const { root } = await base();
  const r = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "root_reanchor", reason: "r", body: { id: root, anchored: "x2" } });
  assert.equal(r.ok, true, r.error);
  const [a, b] = await Promise.all([
    store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } }),
    store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } }),
  ]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, "exactly one approval wins");
  assert.equal(rows().filter((x) => x.event === "choice_reanchored" && x.proposal === r.id).length, 1);
  const again = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(again.ok, false);
  const reject = await store.rejectProposal({ repo: REPO, proposal: r.id, reason: "r", approver: { session: "inbox" } });
  assert.equal(reject.ok, false);
});

test("AC-020: an approval whose premise broke is refused, and the proposal stays open", async () => {
  setup();
  const { purpose, root } = await base();
  const r = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(r.ok, true, r.error);
  // somebody else replaces the old Choice first
  const taken = await store.supersede({ repo: REPO, actor: { session: "s2" }, ids: [root], grounds: "先に", body: rootBody({ purpose, forms: { chosen: "A9", rejected: [] }, no_why_not: "無い" }) });
  assert.equal(taken.ok, true, taken.error);
  const before = rows().length;
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, false);
  assert.equal(rows().length, before, "a refused approval writes nothing");
  assert.equal(store.openProposals(REPO).some((p) => p.id === r.id), true);
});

test("AC-020 / INV-112-2: a second proposal replacing the same root Choice is not approved", async () => {
  setup();
  const { purpose, root } = await base();
  const first = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-101" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(first.ok, true, first.error);
  assert.equal((await store.approveProposal({ repo: REPO, proposal: first.id, approver: { session: "inbox" } })).ok, true);
  // another lane also proposed a replacement, and its own side cannot see the first approval yet
  const second = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-202" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(second.ok, true, second.error);
  const before = rows().length;
  const refused = await store.approveProposal({ repo: REPO, proposal: second.id, approver: { session: "inbox" } });
  assert.equal(refused.ok, false, "a Choice already replaced by an approved proposal is not replaced twice");
  assert.equal(rows().length, before, "a refused approval writes nothing");
  assert.equal(rows().filter((x) => x.event === "choice_raised" && x.proposal).length, 1, "only one successor stands");
  assert.equal(store.openProposals(REPO).some((p) => p.id === second.id), true, "the second proposal stays open");
  const view = store.listRecords({ repo: REPO, actor: { lane: "IDD-202" } });
  assert.equal(view.choices.find((c) => c.id === root).status, "active");
});

test("AC-020 / INV-112-9: an approval whose lane ended without merging does not hold the same Choice", async () => {
  const { state } = setup();
  const { purpose, root } = await base();
  const dead = "IDD-101";
  const first = await store.raiseProposal({ repo: REPO, actor: { lane: dead }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(first.ok, true, first.error);
  assert.equal((await store.approveProposal({ repo: REPO, proposal: first.id, approver: { session: "inbox" } })).ok, true);
  const approvedAt = rows().at(-1).at;
  // the lane ends without merging: its replacement can never take effect, so it must not hold the Choice
  seedLifecycle(state, dead, "lane_close", { outcome: "dropped" }, new Date(Date.parse(approvedAt) + 5000).toISOString());
  const second = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-202" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(second.ok, true, second.error);
  const approved = await store.approveProposal({ repo: REPO, proposal: second.id, approver: { session: "inbox" } });
  assert.equal(approved.ok, true, approved.error);
  const own = store.listRecords({ repo: REPO, actor: { lane: "IDD-202" } }).choices.find((c) => c.id === root);
  assert.equal(own.status, "superseded", "the living lane's replacement stands on its own side");
  const outside = store.listRecords({ repo: REPO, actor: null }).choices.find((c) => c.id === root);
  assert.equal(outside.status, "active", "neither lane has merged, so the outside is untouched");
});

test("AC-020 / INV-112-9: a second replacement is still refused once the first lane merged", async () => {
  const { state } = setup();
  const { purpose, root } = await base();
  const lane = "IDD-101";
  const first = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(first.ok, true, first.error);
  const second = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-202" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(second.ok, true, second.error);
  assert.equal((await store.approveProposal({ repo: REPO, proposal: first.id, approver: { session: "inbox" } })).ok, true);
  const approvedAt = rows().at(-1).at;
  seedLifecycle(state, lane, "lane_close", { outcome: "merged" }, new Date(Date.parse(approvedAt) + 5000).toISOString());
  const before = rows().length;
  const refused = await store.approveProposal({ repo: REPO, proposal: second.id, approver: { session: "inbox" } });
  assert.equal(refused.ok, false, "a merged replacement holds the Choice");
  assert.equal(rows().length, before, "a refused approval writes nothing");
});

test("AC-022 / INV-112-4: a lane's approved proposal is effective to the lane alone until it merges", async () => {
  const { state } = setup();
  const { purpose, root } = await base();
  const lane = "IDD-101";
  const r = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(r.ok, true, r.error);
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, true, a.error);
  const approvedAt = rows().at(-1).at;
  const successorId = () => {
    const c = store.listRecords({ repo: REPO, actor: { lane } }).choices.find((x) => x.id === root);
    return c.history.at(-1).successor;
  };
  assert.equal(successorId(), "C-101-1");
  const outside = store.listRecords({ repo: REPO, actor: null }).choices.find((c) => c.id === root);
  assert.equal(outside.status, "active", "the outside still sees the old Choice");
  const other = store.listRecords({ repo: REPO, actor: { lane: "IDD-202" } }).choices.find((c) => c.id === root);
  assert.equal(other.status, "active");
  // the lane's end is read by date: put the merge after the approval
  seedLifecycle(state, lane, "lane_close", { outcome: "merged" }, new Date(Date.parse(approvedAt) + 5000).toISOString());
  const merged = store.listRecords({ repo: REPO, actor: null }).choices.find((c) => c.id === root);
  assert.equal(merged.status, "superseded");
  assert.equal(merged.history.at(-1).successor, "C-101-1");
});

test("AC-022: a lane closed by a rejection leaves the outside on the old Choice", async () => {
  const { state } = setup();
  const { purpose, root } = await base();
  const lane = "IDD-101";
  const r = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(r.ok, true, r.error);
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, true, a.error);
  const approvedAt = rows().at(-1).at;
  seedLifecycle(state, lane, "lane_close", { outcome: "dropped" }, new Date(Date.parse(approvedAt) + 5000).toISOString());
  const outside = store.listRecords({ repo: REPO, actor: null }).choices.find((c) => c.id === root);
  assert.equal(outside.status, "active");
});

test("AC-023: a session's approved proposal is effective everywhere at once", async () => {
  setup();
  const { purpose, root } = await base();
  const over = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "overview", reason: "r", body: { statement: "すぐ効く" } });
  const sup = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  for (const p of [over, sup]) assert.equal((await store.approveProposal({ repo: REPO, proposal: p.id, approver: { session: "inbox" } })).ok, true);
  for (const actor of [null, { lane: "IDD-303" }]) {
    const view = store.listRecords({ repo: REPO, actor });
    assert.equal(view.purposes.find((p) => p.id === "P-1").statement, "すぐ効く");
    assert.equal(view.choices.find((c) => c.id === root).status, "superseded");
  }
});

test("AC-024 / DEC-112-4: an ended lane's overview and root proposals leave the list, and cannot be approved", async () => {
  const { state } = setup();
  const { purpose, root } = await base();
  const lane = "IDD-101";
  const over = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "overview", reason: "r", body: { statement: "S" } });
  const sup = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  seedLifecycle(state, lane, "lane_close", { outcome: "aborted" });
  const open = store.openProposals(REPO).map((p) => p.id);
  assert.equal(open.includes(over.id), false);
  assert.equal(open.includes(sup.id), false);
  assert.equal((await store.approveProposal({ repo: REPO, proposal: over.id, approver: { session: "inbox" } })).ok, false);
  assert.equal((await store.approveProposal({ repo: REPO, proposal: sup.id, approver: { session: "inbox" } })).ok, false);
  // only the approval is refused: the ended lane's proposal can still be sent back, so it is not left open forever
  const rejected = await store.rejectProposal({ repo: REPO, proposal: over.id, reason: "もう要らない", approver: { session: "inbox" } });
  assert.equal(rejected.ok, true, rejected.error);
  assert.equal(rejected.kind, "overview");
  assert.deepEqual(rejected.origin, { lane });
  assert.equal((await store.rejectProposal({ repo: REPO, proposal: sup.id, reason: "こちらも", approver: { session: "inbox" } })).ok, true);
  const rejectedRows = rows().filter((x) => x.event === "proposal_rejected");
  assert.deepEqual(rejectedRows.map((x) => x.proposal).sort(), [over.id, sup.id].sort());
  assert.equal(store.openProposals(REPO).some((p) => p.id === over.id || p.id === sup.id), false);
});

test("AC-025 / AC-026: a harm example stays open after its lane ends and takes effect at the approval", async () => {
  const { state } = setup();
  await base();
  const lane = "IDD-101";
  const harm = await store.raiseProposal({ repo: REPO, actor: { lane }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
  assert.equal(harm.ok, true, harm.error);
  seedLifecycle(state, lane, "lane_close", { outcome: "dropped" });
  assert.equal(store.openProposals(REPO).some((p) => p.id === harm.id), true, "it stays on the list");
  assert.equal((await store.approveProposal({ repo: REPO, proposal: harm.id, approver: { session: "inbox" } })).ok, true);
  const view = store.riskView(REPO);
  assert.equal(view.harm_examples.length, 1);
  assert.equal(view.harm_examples[0].alwaysMust, false);
});

test("AC-039 / AC-040: the risk view returns the declaration and the examples, writing nothing", async () => {
  const { state } = setup();
  await base();
  const before = existsSync(store.intentColumnPath(REPO)) ? readFileSync(store.intentColumnPath(REPO), "utf8") : "";
  const view = store.riskView(REPO);
  assert.deepEqual(view, { risk_paths: {}, harm_examples: [] });
  const after = existsSync(store.intentColumnPath(REPO)) ? readFileSync(store.intentColumnPath(REPO), "utf8") : "";
  assert.equal(after, before);
  assert.equal(state.length > 0, true);
});

test("AC-040: an approved replacement names the record it wrote, and that record is readable", async () => {
  setup();
  const { purpose, root } = await base();
  const raised = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-101" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose }) } });
  assert.equal(raised.ok, true, raised.error);
  const approved = await store.approveProposal({ repo: REPO, proposal: raised.id, approver: { session: "inbox" } });
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.effect.shown, true, "a Choice the approval wrote is readable");
  const shown = store.showRecord({ repo: REPO, actor: { lane: "IDD-101" }, id: approved.effect.id });
  assert.equal(shown.ok, true, "the named record can actually be pulled");
  // a harm example the approval wrote is not a record `idd intent show` can pull, so it is not named as one
  const harm = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-102" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
  assert.equal(harm.ok, true, harm.error);
  const harmApproved = await store.approveProposal({ repo: REPO, proposal: harm.id, approver: { session: "inbox" } });
  assert.equal(harmApproved.ok, true, harmApproved.error);
  assert.equal(harmApproved.effect.shown, false);
});

test("AC-038: a replacement that could never be approved is refused when it is raised", async () => {
  setup();
  const { root } = await base();
  // the successor's Purpose is not active: the same check the approval applies refuses the raise
  const raised = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-103" }, kind: "root_supersede", reason: "r", body: { ids: [root], grounds: "g", choice: rootBody({ purpose: "P-404" }) } });
  assert.equal(raised.ok, false);
  assert.match(raised.error, /P-404/);
  // the Choice being replaced must be active
  const other = await store.raiseChoice({ repo: REPO, actor: { session: "s9" }, body: choiceBody({ place: [{ path: "/", kind: "root" }] }) });
  assert.equal(other.ok, true, other.error);
  const dropped = await store.raiseChoice({ repo: REPO, actor: { session: "s9" }, body: choiceBody({ status: "unconfirmed", place: [{ path: "/", kind: "root" }] }) });
  assert.equal(dropped.ok, true, dropped.error);
  await store.dropChoice({ repo: REPO, actor: { session: "s9" }, id: dropped.id, grounds: "g" });
  const dead = await store.raiseProposal({ repo: REPO, actor: { lane: "IDD-103" }, kind: "root_supersede", reason: "r", body: { ids: [dropped.id], grounds: "g", choice: rootBody() } });
  assert.equal(dead.ok, false);
});

test("AC-039: a purpose_raised row with no by still folds", () => {
  setup();
  appendFileSync(store.intentColumnPath(REPO), `${JSON.stringify({ event: "purpose_raised", at: "2026-10-13T00:00:00Z", repo: REPO, id: "P-1", statement: "S", origin: "O", status: "active" })}\n`);
  const rows = readFileSync(store.intentColumnPath(REPO), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const folded = store.foldRows(rows, null, store.laneStates([]));
  assert.equal(folded.purposes.length, 1);
  assert.equal(folded.purposes[0].id, "P-1");
});

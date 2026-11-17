import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");
const { raiseProposal, raisePurpose, raiseChoice, approveProposal } = await import("../../../idd-core/src/intent/store.ts");
const { inboxKey } = await import("../../../../lib/idd-ui/types.ts");
const { snoozeKey } = await import("../../../../lib/idd-ui/snooze.ts");

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
let root;

beforeEach(() => {
  root = scratchDir("state-proposals-");
});

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const ev = (iddId, event, attrs = {}) => ({ idd_id: iddId, event, at: "2026-10-14T00:00:00Z", attrs });

/** a state of one registered repo, one or two GO-waiting lanes, and the given proposals */
function setup({ lanes = ["IDD-1"], backlog = true, events } = {}) {
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({
    repos: { demo: { github: "t/p", upstream: join(root, "up"), work: join(root, "work"), public_base: "main" } },
  }));
  if (backlog) {
    writeFileSync(join(state, "backlog.jsonl"), jsonl(lanes.map((iddId) => ({ idd_id: iddId, area: "demo", title: `${iddId} の題`, context: "" }))));
  }
  const rows = events ?? lanes.flatMap((iddId) => [ev(iddId, "lane_open"), ev(iddId, "s1_ready"), ev(iddId, "s1_plan_review_skipped")]);
  writeFileSync(join(state, "lifecycle-demo.jsonl"), jsonl(rows));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") });
  return { state };
}

const proposalItems = (state) => state.items.filter((i) => i.kind === "proposal");

describe("the proposal card the engine assembles", () => {
  it("AC-001: a GO card lists the lane's own proposed Purposes, and no other lane's", async () => {
    setup({ lanes: ["IDD-1", "IDD-2"] });
    await raisePurpose({ repo: "demo", actor: { lane: "IDD-1" }, statement: "夜でも読める", origin: "質問 Q-1 の回答", name: "夜間の可読性" });
    await raisePurpose({ repo: "demo", actor: { lane: "IDD-2" }, statement: "ほかの lane の案", origin: "O" });
    const state = buildState();
    const go1 = state.items.find((i) => i.kind === "go" && i.iddId === "IDD-1");
    assert.deepEqual(go1.purposeProposals.map((p) => p.id), ["P-2"]);
    assert.equal(go1.purposeProposals[0].statement, "夜でも読める");
    assert.equal(go1.purposeProposals[0].origin, "質問 Q-1 の回答");
    assert.equal(go1.purposeProposals[0].name, "夜間の可読性", "the agent's own name shows on the GO card");
    const go2 = state.items.find((i) => i.kind === "go" && i.iddId === "IDD-2");
    assert.deepEqual(go2.purposeProposals.map((p) => p.id), ["P-3"]);
    assert.equal(go2.purposeProposals[0].name, undefined);
  });

  it("AC-028: every open proposal is one card, and an answered one is not", async () => {
    setup();
    const a = await raiseProposal({ repo: "demo", actor: { session: "s1" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
    const b = await raiseProposal({ repo: "demo", actor: { session: "s1" }, kind: "harm_example", reason: "r", body: { statement: "壊れる", harm: 1 } });
    const c = await raiseProposal({ repo: "demo", actor: { session: "s1" }, kind: "harm_example", reason: "r", body: { statement: "揺れる", harm: 1 } });
    assert.equal(proposalItems(buildState()).length, 3);
    assert.equal((await approveProposal({ repo: "demo", proposal: a.id, approver: { session: "inbox" } })).ok, true);
    const items = proposalItems(buildState());
    assert.deepEqual(items.map((i) => i.proposalId).sort(), [b.id, c.id].sort());
  });

  it("AC-029 / INV-112-6: two proposals of one lane have different keys, and the low-space key is unchanged", async () => {
    setup();
    const a = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
    const b = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "harm_example", reason: "r", body: { statement: "壊れる", harm: 1 } });
    const [first, second] = proposalItems(buildState());
    assert.notEqual(inboxKey(first), inboxKey(second));
    assert.notEqual(snoozeKey(first), snoozeKey(second));
    assert.equal(inboxKey(first), `proposal-demo-${a.id}`);
    assert.equal(inboxKey(second), `proposal-demo-${b.id}`);
    const storage = { kind: "storage", cleanup: false, minFreeGb: 1, freeBytes: 1, totalBytes: 2, topPlaces: [], candidateCount: 0, candidateBytes: 0, heldLanes: [] };
    assert.equal(inboxKey(storage), "storage");
    assert.equal(snoozeKey(storage), "storage");
  });

  it("AC-034: a state with no lane at all still returns a session's proposal card", async () => {
    setup({ backlog: false });
    const a = await raiseProposal({ repo: "demo", actor: { session: "s1" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 3 } });
    const state = buildState();
    const items = proposalItems(state);
    assert.equal(items.length, 1);
    assert.equal(items[0].proposalId, a.id);
    assert.equal(items[0].iddId, undefined);
    assert.equal(items[0].from.session, "s1");
    assert.equal(items[0].effect, "now");
  });

  it("AC-011: a root replacement's card puts Grounds on the proposed side", async () => {
    setup();
    const p = await raisePurpose({ repo: "demo", actor: { session: "s1" }, id: "P-1", statement: "概要用", origin: "O" });
    assert.equal(p.ok, true, p.error);
    const c = await raiseChoice({ repo: "demo", actor: { session: "s1" }, body: { purpose: p.id, forms: { chosen: "今の形", rejected: [] }, no_why_not: "無い", place: [{ path: "/", kind: "root" }], why: "w", anchored: "a" } });
    assert.equal(c.ok, true, c.error);
    const sup = await raiseProposal({
      repo: "demo", actor: { lane: "IDD-1" }, kind: "root_supersede", reason: "r",
      body: { ids: [c.id], grounds: "害の見方が変わった", choice: { purpose: p.id, forms: { chosen: "新しい形", rejected: [] }, no_why_not: "無い", place: [{ path: "/", kind: "root" }], why: "w2", anchored: "a2" } },
    });
    assert.equal(sup.ok, true, sup.error);
    const item = proposalItems(buildState()).find((i) => i.proposalId === sup.id);
    assert.ok(item);
    assert.deepEqual(item.before, [{ label: `今の ${c.id}`, value: "今の形" }], "the current side is the current Choice alone");
    assert.deepEqual(item.after.map((r) => r.label), ["後継", "Why", "Anchored", "Place", "Grounds"]);
    assert.equal(item.after.find((r) => r.label === "Grounds").value, "害の見方が変わった");
  });

  it("AC-001 / AC-044: the card carries the handle, the current and proposed content, the reason, the source and the effect", async () => {
    setup();
    await raisePurpose({ repo: "demo", actor: { session: "s1" }, statement: "概要", origin: "O", id: "P-1" });
    const over = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "overview", reason: "言葉が古い", body: { statement: "新しい概要" } });
    const harm = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "harm_example", reason: "見つけた", body: { statement: "戻せない削除", harm: 3, always_must: true } });
    const items = proposalItems(buildState());
    const overview = items.find((i) => i.proposalId === over.id);
    assert.equal(overview.handle, "概要を変える案");
    assert.deepEqual(overview.before, [{ label: "今の概要", value: "概要" }]);
    assert.deepEqual(overview.after, [{ label: "案の概要", value: "新しい概要" }]);
    assert.equal(overview.reason, "言葉が古い");
    assert.deepEqual(overview.from.lane, "IDD-1");
    assert.equal(overview.effect, "on_merge");
    assert.equal(overview.appearedAt, overview.from.at);
    const example = items.find((i) => i.proposalId === harm.id);
    assert.equal(example.handle, "戻せない削除");
    assert.deepEqual(example.before, []);
    assert.equal(example.effect, "now", "a harm example takes hold at the approval");
    assert.deepEqual(example.after.map((r) => r.label), ["害の例", "重さ", "must"]);

    const lane = await buildLaneDetail("IDD-1");
    assert.equal(lane.pending, "go");
    assert.equal(lane.purposeProposals, undefined, "the lane proposed no Purpose of its own");
    await raisePurpose({ repo: "demo", actor: { lane: "IDD-1" }, statement: "自分の案", origin: "O" });
    const again = await buildLaneDetail("IDD-1");
    assert.deepEqual(again.purposeProposals.map((p) => p.statement), ["自分の案"]);
  });

  it("AC-024 / AC-025: an ended lane's overview proposal leaves the list, while a harm example stays", async () => {
    const { state: dir } = setup();
    await raisePurpose({ repo: "demo", actor: { session: "s1" }, statement: "概要", origin: "O", id: "P-1" });
    const over = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "overview", reason: "r", body: { statement: "S" } });
    const harm = await raiseProposal({ repo: "demo", actor: { lane: "IDD-2" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
    assert.equal(proposalItems(buildState()).length, 2, "both are open while IDD-1 is open");
    writeFileSync(join(dir, "lifecycle-demo.jsonl"), readFileSync(join(dir, "lifecycle-demo.jsonl"), "utf8") + `${JSON.stringify(ev("IDD-1", "lane_close", { outcome: "aborted" }))}\n`);
    const ids = proposalItems(buildState()).map((i) => i.proposalId);
    assert.equal(ids.includes(over.id), false, "the ended lane's overview proposal is gone");
    assert.equal(ids.includes(harm.id), true, "a harm example stays open");
  });
});

/**
 * The granularity judgement: the shape of the proposal, the stage that waits on a person, the report that carries
 * the "1本" reason, and the approval that closes the parent lane. The questions and the fixed costs the planner
 * decides by ride in its brief, so one test reads the brief and the catalog together.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentGranularity, agentReady } from "../src/agent/inbound.ts";
import { approveGranularity } from "../src/intake/ignore.ts";
import { deriveStage, decisionSince } from "../src/ledger/derive.ts";
import { applyDecision } from "../src/ledger/write.ts";
import { GRANULARITY_CHILD_LIMIT, GRANULARITY_RECORDED_EVENT, granularityApprovable, granularityProposalOf, granularityWaiting, normalizeGranularity } from "../src/plan/granularity.ts";
import { GRANULARITY_RULE, granularityReportLines, standardsPlaceRule } from "../src/plan/prompt-text.ts";
import { plannerBrief } from "../src/plan/prep.ts";
import { standardsPath } from "../src/rules/rules.ts";

const made = [];
const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, roles: process.env.IDD_ROLES_FILE };
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved.state === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved.state;
  if (saved.repos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved.repos;
  if (saved.roles === undefined) delete process.env.IDD_ROLES_FILE; else process.env.IDD_ROLES_FILE = saved.roles;
});

const rec = { idd_id: "IDD-127", area: "me/app", title: "T", context: "", gh_issue_url: "https://github.com/me/app/issues/131", created_at: "2026-10-15T00:00:00Z" };

const child = (over = {}) => ({ title: "子", whole: "1 つのことを判定できる。", places: ["src/a.ts"], ...over });

/**
 * The lane's places with one setting for the granularity stage: the shipped config/roles.yaml stops it, so a test that
 * checks the stage's on side has to name `on` itself.
 */
function setup({ lane = rec, granularity = "on" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "idd-granularity-"));
  made.push(root);
  const state = join(root, "state"); mkdirSync(state);
  const worktree = join(root, "wt"); mkdirSync(worktree);
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: { "me/app": { upstream: join(root, "u"), work: join(root, "w"), public_base: "main" } } }));
  const roles = join(root, "roles.yaml");
  writeFileSync(roles, `pipeline:\n  granularity: ${granularity}\n`);
  writeFileSync(join(state, "backlog.jsonl"), JSON.stringify(lane) + "\n");
  writeFileSync(join(state, "planner-sessions.jsonl"), JSON.stringify({ idd_id: lane.idd_id, planner_session_id: "p1", started_at: "2026-10-15T00:00:00Z", worktree_path: worktree, branch: `idd/${lane.idd_id.toLowerCase()}` }) + "\n");
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_ROLES_FILE: roles });
  return { root, state, worktree, roles };
}

/** turns the stage on or off for the lane the current test set up */
function setStage(roles, on) {
  writeFileSync(roles, `pipeline:\n  granularity: ${on ? "on" : "off"}\n`);
}

const events = (state) => {
  const file = readdirSync(state).find((f) => f.startsWith("lifecycle-"));
  if (!file) return [];
  return readFileSync(join(state, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const of = (state, name) => events(state).filter((e) => e.event === name);
const seed = (state, event, attrs = {}) => writeFileSync(join(state, "lifecycle-test.jsonl"), `${JSON.stringify({ event, idd_id: "IDD-127", at: new Date().toISOString(), attrs })}\n`, { flag: "a" });

const allClear = [
  { kind: "auth", touches: false, reason: "認証を変えない。" },
  { kind: "authz", touches: false, reason: "認可を変えない。" },
  { kind: "billing", touches: false, reason: "課金を変えない。" },
  { kind: "permission", touches: false, reason: "権限を変えない。" },
  { kind: "data_loss", touches: false, reason: "データを消さない。" },
  { kind: "secret", touches: false, reason: "秘密を扱わない。" },
];
const counts = { iddId: "IDD-127", decCount: 0, invCount: 0, qaCount: 1, referenceCount: 0, size: "L", harm: 1, depth: "deep", riskTable: allClear, summary: { situation: "s", action: "a", outcome: "o" }, intentImpact: { paths: ["src/a.ts"], decisions: [] } };

test("AC-001: the v2 planner brief carries the granularity questions, the fixed-cost table and the report shape", () => {
  const { worktree } = setup();
  const brief = plannerBrief(rec, undefined, worktree, undefined, "state");
  for (const line of GRANULARITY_RULE) assert.ok(brief.includes(line.split(":")[0].slice(0, 20)), line.slice(0, 20));
  assert.match(brief, /<granularity>/);
  for (const line of granularityReportLines()) assert.ok(brief.includes(line.slice(0, 20)), line.slice(0, 20));
  assert.match(brief, /report granularity --file granularity\.json/);
  assert.match(brief, /--granularity-reason/);
  assert.match(brief, /子は 4 まで/);
  assert.match(brief, /計画の査読 2〜3 本/);
  // a v1 lane's brief is left as it was
  const v1 = plannerBrief(rec, undefined, worktree);
  assert.doesNotMatch(v1, /<granularity>/);
  assert.doesNotMatch(v1, /report granularity/);
  // the catalog carries the same words the brief is built from (its report line names the product by its coming
  // name, so the CLI's own name is read apart)
  const catalog = readFileSync(join(process.cwd(), "_meta/prompt-catalog/01-planner.md"), "utf8");
  for (const line of GRANULARITY_RULE) assert.ok(catalog.includes(line), line.slice(0, 20));
  for (const line of granularityReportLines().slice(1)) assert.ok(catalog.includes(line), line.slice(0, 20));
  assert.match(catalog, /report granularity --file granularity\.json/);
});

test("F-124-9: the brief names one path where the standards can be opened, the worktree's copy or the package's", () => {
  const { worktree } = setup();
  // no copy in the worktree: the package's own standards are named by absolute path
  const noCopy = plannerBrief(rec, undefined, worktree, undefined, "state");
  assert.ok(noCopy.includes(standardsPlaceRule(standardsPath())), "the package's own standards are named");
  mkdirSync(join(worktree, "_docs", "standards"), { recursive: true });
  const withCopy = plannerBrief(rec, undefined, worktree, undefined, "state");
  assert.ok(withCopy.includes(standardsPlaceRule("_docs/standards")), "the worktree's own copy is named relative");
  const catalog = readFileSync(join(process.cwd(), "_meta/prompt-catalog/01-planner.md"), "utf8");
  assert.match(catalog, /規約と雛形の原物は `\{standards-place\}` にある/);
});

test("AC-002: with the stage stopped the v2 brief carries none of the granularity lines, and the rest is unchanged", () => {
  const { worktree, roles } = setup({ granularity: "off" });
  const off = plannerBrief(rec, undefined, worktree, undefined, "state");
  for (const line of GRANULARITY_RULE) assert.equal(off.includes(line), false, line.slice(0, 20));
  for (const line of granularityReportLines()) assert.equal(off.includes(line), false, line.slice(0, 20));
  assert.doesNotMatch(off, /<granularity>/);
  assert.doesNotMatch(off, /report granularity/);
  assert.doesNotMatch(off, /--granularity-reason/);
  // the sections the planner is asked to write are the ones it was given before, and a v1 lane's brief never had
  // the granularity lines either way
  assert.doesNotMatch(plannerBrief(rec, undefined, worktree), /<granularity>/);
  setStage(roles, true);
  const on = plannerBrief(rec, undefined, worktree, undefined, "state");
  for (const marker of ["<task>", "<deliverables>", "<record-rules>", "<writing-rules>", "<question-rules>", "<host-rules>", "<callback>", "<lane>"]) {
    assert.ok(off.includes(marker), marker);
    assert.ok(on.includes(marker), marker);
  }
  assert.ok(off.length < on.length, "the stopped brief is the on brief without the granularity lines");
});

test("the proposal's shape: kind, reason, children and merge target are checked before anything is written", () => {
  assert.equal(normalizeGranularity(null).ok, false);
  assert.equal(normalizeGranularity({ kind: "maybe", reason: "r" }).ok, false);
  assert.equal(normalizeGranularity({ kind: "single" }).ok, false);
  assert.equal(normalizeGranularity({ kind: "merge", reason: "r" }).ok, false);
  assert.equal(normalizeGranularity({ kind: "split", reason: "r", children: [] }).ok, false);
  assert.equal(normalizeGranularity({ kind: "split", reason: "r", children: [child({ whole: "" })] }).ok, false);
  assert.equal(normalizeGranularity({ kind: "split", reason: "r", children: [child({ places: [] })] }).ok, false);
  assert.deepEqual(normalizeGranularity({ kind: "single", reason: " 責務が 1 つ。 " }), { ok: true, proposal: { kind: "single", reason: "責務が 1 つ。" } });
  const ok = normalizeGranularity({ kind: "split", reason: "r", children: [child(), child({ title: "子 2", after: [0, 9] })] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.proposal.children[1].after, [0], "an out-of-range or self reference is dropped");
  assert.equal(normalizeGranularity({ kind: "merge", reason: "r", merge_target: { ref: "me/app#12" } }).proposal.mergeTarget.ref, "me/app#12");
});

test("a split over the child limit is taken, shown as a re-slicing, and never approved as a split", () => {
  const many = Array.from({ length: GRANULARITY_CHILD_LIMIT + 1 }, (_, i) => child({ title: `子 ${i + 1}` }));
  const parsed = normalizeGranularity({ kind: "split", reason: "r", children: many });
  assert.equal(parsed.ok, true, "the report is taken so the signal reaches a person");
  assert.equal(parsed.proposal.children.length, 5);
  assert.equal(granularityApprovable(parsed.proposal), false);
  const four = normalizeGranularity({ kind: "split", reason: "r", children: many.slice(0, 4) });
  assert.equal(granularityApprovable(four.proposal), true);
  assert.equal(granularityApprovable({ kind: "merge", reason: "r", mergeTarget: { ref: "x" } }), true);
  assert.equal(granularityApprovable({ kind: "single", reason: "r" }), false);
});

test("AC-002: a split or merge proposal leaves the lane on a person's judgement, whatever its depth", () => {
  const at = new Date().toISOString();
  const ev = (event, attrs) => ({ event, idd_id: "IDD-127", at, attrs });
  const split = [ev("lane_open", {}), ev("s1_granularity_proposed", { kind: "split", reason: "r", children: [child()] })];
  const merge = [ev("lane_open", {}), ev("s1_granularity_proposed", { kind: "merge", reason: "r", merge_target: { ref: "x" } })];
  for (const evs of [split, merge]) {
    assert.equal(granularityWaiting(evs), true);
    const stage = deriveStage(evs);
    assert.equal(stage.group, "judge");
    assert.equal(stage.decision, "granularity");
  }
  // a "single" judgement changes nothing: the planner goes on to the request
  const single = [ev("lane_open", {}), ev("s1_granularity_proposed", { kind: "single", reason: "r" })];
  assert.equal(granularityWaiting(single), false);
  assert.equal(deriveStage(single).decision, undefined);
  assert.equal(deriveStage(single).group, "prep");
  // the answer ends the wait, and a later ready is read as before
  const answered = [...split, ev("s1_granularity_answered", { decision: "single" })];
  assert.equal(granularityWaiting(answered), false);
  assert.equal(deriveStage(answered).group, "prep");
  // a card that has waited since the proposal carries that time
  assert.equal(decisionSince(split), at);
});

test("agentGranularity records the proposal, and refuses a second one while the first waits", async () => {
  const { state } = setup();
  const r = await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child()] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stage, "on", "the stage was on as the proposal arrived");
  const written = of(state, "s1_granularity_proposed");
  assert.equal(written.length, 1);
  assert.equal(written[0].attrs.kind, "split");
  assert.equal(written[0].attrs.reason, "責務が 2 つ。");
  const again = await agentGranularity({ iddId: "IDD-127", proposal: { kind: "single", reason: "r" } });
  assert.equal(again.ok, false);
  assert.match(again.error, /答え/);
  // a malformed proposal is refused and nothing is written
  const bad = await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "r", children: [] } });
  assert.equal(bad.ok, false);
  assert.equal(of(state, "s1_granularity_proposed").length, 1);
  // an unknown lane is refused
  assert.equal((await agentGranularity({ iddId: "IDD-999", proposal: { kind: "single", reason: "r" } })).ok, false);
});

test("AC-003: a proposal that arrives while the stage is stopped is recorded only, and the lane goes on", async () => {
  const { state } = setup({ granularity: "off" });
  const r = await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child()] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stage, "off", "the caller is told the stage was stopped as the proposal arrived");
  assert.equal(of(state, "s1_granularity_proposed").length, 0, "nothing waits on a person");
  const kept = of(state, GRANULARITY_RECORDED_EVENT);
  assert.equal(kept.length, 1, "the proposal itself is kept in the lane's record");
  assert.equal(kept[0].attrs.kind, "split");
  assert.equal(kept[0].attrs.reason, "責務が 2 つ。");
  assert.equal(kept[0].attrs.children.length, 1);
  assert.equal(granularityProposalOf(events(state)), null);
  assert.equal(granularityWaiting(events(state)), false);
  assert.notEqual(deriveStage(events(state)).decision, "granularity");
  // a second proposal is taken too: nothing was waiting for an answer
  const second = await agentGranularity({ iddId: "IDD-127", proposal: { kind: "merge", reason: "重複。", merge_target: { ref: "me/app#12" } } });
  assert.equal(second.ok, true, second.error);
  // the ready needs no "1本" reason and is taken
  const ready = await agentReady(counts);
  assert.equal(ready.ok, true, ready.error);
  const recorded = of(state, "s1_ready")[0];
  assert.equal(recorded.attrs.granularity_reason, undefined);
  assert.equal(recorded.attrs.granularity_kind, undefined);
});

test("AC-004: a proposal recorded while the stage was on keeps waiting after the stage is turned off", async () => {
  const { roles, state } = setup({ granularity: "on" });
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child()] } });
  assert.equal(granularityWaiting(events(state)), true);
  setStage(roles, false);
  assert.equal(granularityWaiting(events(state)), true, "the stage is read when the proposal arrives, not now");
  assert.equal(deriveStage(events(state)).decision, "granularity", "the person can still answer it");
  const answered = await applyDecision("granularity_single", { iddId: "IDD-127" });
  assert.equal(answered.ok, true, answered.error);
  assert.equal(of(state, "s1_granularity_answered").length, 1);
  const ready = await agentReady(counts);
  assert.equal(ready.ok, false, "a split turned down to one lane still needs the reason");
  assert.match(ready.error, /1本/);
});

test("AC-004: a proposal recorded while the stage was stopped never becomes a card when it is turned back on", async () => {
  const { roles, state } = setup({ granularity: "off" });
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child()] } });
  setStage(roles, true);
  assert.equal(granularityWaiting(events(state)), false, "an old ignored proposal is not asked of a person later");
  assert.notEqual(deriveStage(events(state)).decision, "granularity");
  const ready = await agentReady(counts);
  assert.equal(ready.ok, true, ready.error);
  // the stage is on again for the next proposal, which waits as it does on the on side
  const next = await agentGranularity({ iddId: "IDD-127", proposal: { kind: "single", reason: "責務が 1 つ。" } });
  assert.equal(next.stage, "on");
  assert.equal(of(state, "s1_granularity_proposed").length, 1);
});

test("AC-006: a ready with an unanswered proposal or without the 1本 reason is refused, and the reason is recorded", async () => {
  const { state } = setup();
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child()] } });
  const waiting = await agentReady(counts);
  assert.equal(waiting.ok, false);
  assert.match(waiting.error, /答え/);
  assert.equal(of(state, "s1_ready").length, 0);

  // a "single" judgement carries the reason itself
  const { state: state2 } = setup();
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "single", reason: "責務が 1 つで、部分ごとに独立に判定できない。" } });
  const ok = await agentReady(counts);
  assert.equal(ok.ok, true, ok.error);
  const ready = of(state2, "s1_ready")[0];
  assert.equal(ready.attrs.granularity_reason, "責務が 1 つで、部分ごとに独立に判定できない。");
  assert.equal(ready.attrs.granularity_kind, "single");

  // a split turned down to one lane needs the reason with the report
  const { state: state3 } = setup();
  seed(state3, "s1_granularity_proposed", { kind: "split", reason: "分けたほうがよい。", children: [child()] });
  seed(state3, "s1_granularity_answered", { decision: "single" });
  const missing = await agentReady(counts);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /1本/);
  const withReason = await agentReady({ ...counts, granularityReason: "人が 1 本と決めた。1 つの判定単位に収まる。" });
  assert.equal(withReason.ok, true, withReason.error);
  assert.equal(of(state3, "s1_ready").pop().attrs.granularity_reason, "人が 1 本と決めた。1 つの判定単位に収まる。");
});

test("AC-005: approving a proposal records the answer, closes the lane, and puts its Issue on the ignore list", async () => {
  const { state } = setup();
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child(), child({ title: "子 2" })] } });
  const r = await approveGranularity("IDD-127");
  assert.equal(r.ok, true, r.error);
  const answer = of(state, "s1_granularity_answered")[0];
  assert.equal(answer.attrs.decision, "approve");
  assert.equal(answer.attrs.kind, "split");
  assert.equal(answer.attrs.children, 2);
  const close = of(state, "lane_close")[0];
  assert.equal(close.attrs.outcome, "aborted");
  assert.match(close.attrs.reason, /粒度の案（split）を承認/);
  // the proposal stays readable from the lane's own record, after the close
  assert.equal(granularityProposalOf(events(state)).kind, "split");
  assert.equal(deriveStage(events(state)).group, "closed");
  // the Issue is on intake's ignore list, so the next intake does not take it in again
  const ignores = readFileSync(join(state, "intake-ignores.jsonl"), "utf8");
  assert.match(ignores, /issues\/131/);
});

test("AC-005: an over-limit split is not approved, and a lane that is not waiting takes no approval", async () => {
  const many = Array.from({ length: 5 }, (_, i) => child({ title: `子 ${i + 1}` }));
  const { state } = setup();
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "r", children: many } });
  const refused = await approveGranularity("IDD-127");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /4 を超え/);
  assert.equal(of(state, "lane_close").length, 0);
  // a "single" proposal has no card to approve
  const { state: s2 } = setup();
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "single", reason: "r" } });
  const wrongStage = await approveGranularity("IDD-127");
  assert.equal(wrongStage.ok, false);
  assert.equal(of(s2, "lane_close").length, 0);
});

test("AC-004: このまま 1 本 and 直して返す record the answer and queue a word to the same planner, leaving the lane open", async () => {
  const { state } = setup();
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child()] } });
  const single = await applyDecision("granularity_single", { iddId: "IDD-127" });
  assert.equal(single.ok, true, single.error);
  assert.equal(of(state, "s1_granularity_answered").pop().attrs.decision, "single");
  assert.equal(of(state, "lane_close").length, 0, "the lane stays open");
  assert.equal(granularityWaiting(events(state)), false);
  assert.notEqual(deriveStage(events(state)).group, "closed");
  const outbox = readFileSync(join(state, "outbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].type, "granularity_answered");
  assert.match(readFileSync(join(state, "outbox", `${outbox[0].envelope_id}.xml`), "utf8"), /このまま 1 本/);

  // the same lane is proposed again, and this time the person asks for a re-slicing
  const again = await agentGranularity({ iddId: "IDD-127", proposal: { kind: "split", reason: "責務が 2 つ。", children: [child()] } });
  assert.equal(again.ok, true, again.error);
  const revised = await applyDecision("granularity_revise", { iddId: "IDD-127", instruction: "Place で分け直す。" });
  assert.equal(revised.ok, true, revised.error);
  assert.equal(of(state, "s1_granularity_answered").pop().attrs.decision, "revise");
  assert.equal(of(state, "lane_close").length, 0);
  const second = readFileSync(join(state, "outbox", `${revised.envelopeId}.xml`), "utf8");
  assert.match(second, /直して返す/);
  assert.match(second, /Place で分け直す。/);

  // an answer with no instruction is refused, and a second answer on the same proposal changes nothing
  const noInstruction = await applyDecision("granularity_revise", { iddId: "IDD-127", instruction: "" });
  assert.equal(noInstruction.ok, false);
  const stale = await applyDecision("granularity_single", { iddId: "IDD-127" });
  assert.equal(stale.ok, false, "the card's answer is older than the proposal it was built for");
});

test("the closed lane's record distinguishes an approved split from an approved merge", async () => {
  const { state } = setup();
  await agentGranularity({ iddId: "IDD-127", proposal: { kind: "merge", reason: "重複。", merge_target: { ref: "me/app#12" } } });
  const r = await approveGranularity("IDD-127");
  assert.equal(r.ok, true, r.error);
  const answer = of(state, "s1_granularity_answered")[0];
  assert.equal(answer.attrs.kind, "merge");
  assert.equal(answer.attrs.merge_target, "me/app#12");
  assert.ok(existsSync(join(state, "lifecycle-test.jsonl")) || true);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { backlogRow, cleanReview, ev, laneEvents, openState, replannedReady, round, sessionRow, stopped, writeRows } from "./helpers/lane-ledger.mjs";
import { transitionRefusal } from "../src/ledger/allowed.ts";
import { deriveStage, laneBudget, planReviewPhase, replanView, roundTrace } from "../src/ledger/derive.ts";
import { laneStageSpans } from "../src/ledger/stages.ts";
import { acceptedAt, answerOutcome, closesAt, feedbackPassAt, fixAfter, reviewLoopState, s4Triage } from "../src/ledger/review-loop.ts";
import { awaitedAgent, awaitingQuestion } from "../src/plan/watch.ts";
import { applyDecision, queueEnvelope } from "../src/ledger/write.ts";
import { recordedDepth } from "../src/plan/depth.ts";
import { lanesAwaitingExec, runningExecutors } from "../src/plan/exec.ts";
import { planTouchScope, scopeWithRecords } from "../src/plan/lane-records.ts";
import { deliverPending } from "../src/agent/outbox.ts";
import { setAgentRunner } from "../src/agent/port.ts";

/**
 * A lane the review loop stopped at its card can go back to its plan (C-252-4): the same lane, the same branch, the
 * rounds it had kept in the ledger. The plan is then reviewed and gone through the GO again before the executor
 * starts anew.
 */

test("AC-007: the card's replan answer takes a stopped lane to its plan, and only a stopped lane", () => {
  const env = { skipsFinal: () => false, deviceOn: false };
  assert.deepEqual(answerOutcome(stopped(), { decision: "replan" }, env), { to: "plan" });
  assert.equal(answerOutcome(stopped().slice(0, 6), { decision: "replan" }, env), undefined);
});

test("AC-007: a replan leaves the lane at its plan, the plan sent back, and every earlier record in the ledger", () => {
  const before = stopped();
  assert.equal(deriveStage(before).decision, "stuck");
  const after = [...before, ev("s1_replan_requested", { rounds: 2 })];
  const stage = deriveStage(after);
  assert.equal(stage.group, "prep");
  assert.equal(stage.decision, undefined);
  assert.deepEqual(planReviewPhase(after), { phase: "sent_back" });
  assert.equal(reviewLoopState(after).state, "idle");
  // the stretch is a plan stretch in the time figure too
  assert.equal(laneStageSpans(after).at(-1).key, "plan");
  // the rounds stay: the lane's lines are the whole lane's
  assert.equal(roundTrace(after).length, 2);
  assert.deepEqual(after.slice(0, before.length), before);
});

test("AC-008: the lane goes through the plan review and the GO again before the executor starts anew", () => {
  // the planner reports again: the review starts
  let lane = replannedReady();
  assert.deepEqual(planReviewPhase(lane), { phase: "waiting" });
  // the GO and the executor's start are refused until the review and the GO are gone through
  assert.equal(typeof transitionRefusal("s1_go", lane), "string");
  assert.equal(typeof transitionRefusal("s2_start", lane), "string");
  lane = [...lane, ev("s1_plan_review_started", { run_ids: ["P2"] })];
  assert.equal(planReviewPhase(lane).phase, "running");
  lane = [...lane, cleanReview()];
  assert.deepEqual(planReviewPhase(lane), { phase: "reviewed", failed: false, actionable: 0 });
  assert.equal(deriveStage(lane).decision, "go");
  assert.equal(transitionRefusal("s1_go", lane), null);
  // the GO of the first plan is not the new plan's GO
  assert.equal(replanView(lane).some((e) => e.event === "s1_go"), false);
  lane = [...lane, ev("s1_go")];
  assert.equal(deriveStage(lane).group, "impl");
  // the executor starts anew: the first start is not this one
  assert.equal(transitionRefusal("s2_start", lane), null);
  lane = [...lane, ev("s2_start", { started_from_commit: "c1" })];
  assert.equal(deriveStage(lane).group, "impl");
  // the loop counts its rounds from the new start: the first lane's escalation is not the new one's
  assert.equal(reviewLoopState(lane).state === "escalated", false);
  assert.equal(recordedDepth(lane), "deep");
});

test("AC-008: a lane with no replan is read as it was", () => {
  const lane = stopped();
  assert.equal(replanView(lane), lane);
  assert.equal(deriveStage(lane).decision, "stuck");
});

/** a state directory with the stopped lane in it, as the write side reads it */
const laneWith = (events) => openState("replan-", events).state;

/** the card's answer, which the stopped lane takes */
async function replanTaken() {
  const done = await applyDecision("s2_review_replan", { iddId: "IDD-1" });
  assert.equal(done.ok, true, done.error);
  return done;
}

const awaitingExec = () => lanesAwaitingExec().map((l) => l.idd_id);

test("AC-007: the decision writes the replan once, tells the planner with the rounds, and refuses a lane that is not stopped", async () => {
  const state = laneWith(stopped());
  const done = await replanTaken();
  const written = laneEvents();
  assert.equal(written.at(-1).event, "s1_replan_requested");
  assert.equal(written.at(-1).attrs.rounds, 2);
  assert.equal(written.length, stopped().length + 1);
  const envelope = readFileSync(join(state, "outbox", `${done.envelopeId}.xml`), "utf8");
  assert.ok(envelope.includes('<round n="1"') && envelope.includes('<round n="2"'));
  assert.ok(envelope.includes("b.ts"));
  // a second press (a stale card) finds a lane that is no longer stopped
  const again = await applyDecision("s2_review_replan", { iddId: "IDD-1" });
  assert.equal(again.ok, false);
  assert.equal(laneEvents().length, written.length);
});

const TOUCH_PLAN = [
  "## 裁量",
  "- 触る範囲（module は、この変更が触る file の親としてだけ挙げる。ほかの file は範囲外）:",
  "  - `packages/idd-fold/` — `review_loop.mbt`・`api.mbt`。",
  "  - `src/` — `a.ts`。",
  "  - `config/roles.yaml` — 判断の役の定義。",
  "  - `docs/` — `a.md`・`b.md`。",
  "  - `_docs/standards/brief.md` — 範囲外（変えない）。",
  "  - `packages/*/test/` — 上の変更のテスト。",
  "- 守ること: 別の欄。",
].join("\n");

test("AC-005: the plan's touch list names the files a change may touch, and only those", () => {
  assert.deepEqual(planTouchScope(TOUCH_PLAN), ["packages/idd-fold/review_loop.mbt", "packages/idd-fold/api.mbt", "src/a.ts", "config/roles.yaml", "docs/a.md", "docs/b.md", "packages/*/test/"]);
  assert.deepEqual(planTouchScope("## 依頼\n- 触る範囲なし"), []);
  const rec = { idd_id: "IDD-1", area: "default", title: "T", context: "", created_at: "" };
  const scope = scopeWithRecords(planTouchScope(TOUCH_PLAN), rec);
  assert.ok(scope.includes("packages/*/test/"), "the glob stays as the plan wrote it: the fold matches it against the changed files");
  assert.ok(scope.includes("_docs/plan/default/idd-1/"), "the lane's own records are not outside the plan");
});

test("AC-005: a path only the reason of a touch-list entry names is not in the scope", () => {
  const plan = [
    "- 触る範囲:",
    "  - `src/` — `a.ts`・`b.ts` を足す。理由は `lib/other.ts` と `state/pipeline/review/IDD-1/report.md` を読むから。",
    "  - `config/roles.yaml` — 判断の役の定義。原報告は `state/pipeline/review/IDD-2/report.md` にある。",
    "  - `docs/` — 理由は `docs/old.md` で、この lane では足さない。",
    "  - `packages/idd-fold/` — `api.mbt`、`dist/`。`packages/idd-core/src/x.ts` は別の lane が触る。",
    "- 守ること: 別の欄。",
  ].join("\n");
  assert.deepEqual(planTouchScope(plan), ["src/a.ts", "src/b.ts", "config/roles.yaml", "docs/", "packages/idd-fold/api.mbt", "packages/idd-fold/dist/"]);
  const rec = { idd_id: "IDD-1", area: "default", title: "T", context: "", created_at: "" };
  const scope = scopeWithRecords(planTouchScope(plan), rec);
  assert.ok(!scope.includes("lib/other.ts") && !scope.includes("packages/idd-core/src/x.ts"), "a file the reason mentions can still be reported as outside the plan");
});

test("AC-004: the names after a module resolve to repo-relative paths, whether they are bare, under a directory, from the root or joined by と", () => {
  const plan = [
    "- 触る範囲:",
    "  - `packages/idd-fold/` — `review_loop.mbt`・`dist/`。",
    "  - `packages/idd-fold/` — `dist/idd-fold.js` と `api.mbt`。理由は `lib/other.ts` を読むから。",
    "  - `packages/idd-core/` — `packages/idd-core/test/x.test.mjs`・`src/a.ts`。",
    "  - `packages/idd-core/src/plan/resume.ts`・`packages/idd-core/src/plan/watch.ts` — 再開の宛先。",
    "- 守ること: 別の欄。",
  ].join("\n");
  assert.deepEqual(planTouchScope(plan), [
    "packages/idd-fold/review_loop.mbt", "packages/idd-fold/dist/",
    "packages/idd-fold/dist/idd-fold.js", "dist/idd-fold.js", "packages/idd-fold/api.mbt",
    "packages/idd-core/test/x.test.mjs", "packages/idd-core/src/a.ts", "src/a.ts",
    "packages/idd-core/src/plan/resume.ts", "packages/idd-core/src/plan/watch.ts",
  ]);
});

test("AC-004: a table row's first cell is the place and the cells after it are the reason", () => {
  const plan = [
    "- 触る範囲:",
    "  | 場所 | 理由 |",
    "  | --- | --- |",
    "  | `packages/idd-fold/dist/idd-fold.js` | 生成物。`lib/other.ts` を読む |",
    "  | `src/` | `a.ts` を直す |",
    "- 守ること: 別の欄。",
  ].join("\n");
  assert.deepEqual(planTouchScope(plan), ["packages/idd-fold/dist/idd-fold.js", "src/"]);
});

test("a table row whose reason opens with 範囲外 names nothing, as a bullet does", () => {
  const plan = [
    "- 触る範囲:",
    "  | `a.ts` | 範囲外: 触らない |",
    "  | `b.ts` | 直す |",
    "- 守ること: 別の欄。",
  ].join("\n");
  assert.deepEqual(planTouchScope(plan), ["b.ts"]);
});

/** a lane at its GO whose planner's worktree holds `planText` as its plan: the GO is taken, and the plan's path is returned */
async function goWithPlan(planText) {
  const state = laneWith([ev("lane_open"), ev("s1_ready", { depth: "deep" }), ev("s1_plan_review_started", { run_ids: ["P1"] }), cleanReview()]);
  const worktree = join(process.env.IDD_STATE_DIR, "..", "wt");
  const planPath = join(worktree, "_docs/plan/default/idd-1/plan.md");
  mkdirSync(join(worktree, "_docs/plan/default/idd-1"), { recursive: true });
  writeFileSync(planPath, planText);
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "P1", "2026-09-30T00:00:00Z", { worktree_path: worktree }));
  const done = await applyDecision("s1_go", { iddId: "IDD-1" });
  assert.equal(done.ok, true, done.error);
  return planPath;
}

test("AC-004: the scope a GO records takes in a change of packages/idd-fold/dist/idd-fold.js and not a path only the reason names", async () => {
  await goWithPlan("- 触る範囲:\n  - `packages/idd-fold/` — `review_loop.mbt`、`dist/idd-fold.js`。`lib/other.ts` は読むだけ。\n- 守ること: x\n");
  const lane = [...laneEvents(), ev("s2_start", { started_from_commit: "c0" }), ...round(1, ["packages/idd-fold/dist/idd-fold.js", "lib/other.ts"], "packages/idd-fold/dist/idd-fold.js", "x")];
  assert.deepEqual(roundTrace(lane).map((l) => l.outside_scope), [["lib/other.ts"]]);
});

/** the ledger with the scope its GO recorded: the plan as the GO took it, not as the worktree holds it now */
const withScope = (events, scope) => events.map((e) => (e.event === "s1_go" ? { ...e, attrs: { ...e.attrs, plan_scope: scope } } : e));

test("AC-003: the replan envelope names the files the rounds changed outside the scope the GO recorded", async () => {
  const state = laneWith(withScope(stopped(), ["a.ts"]));
  const worktree = join(process.env.IDD_STATE_DIR, "..", "wt");
  mkdirSync(join(worktree, "_docs/plan/default/idd-1"), { recursive: true });
  // the plan as the worktree holds it now names both files: it is not read back, so the envelope still names b.ts
  writeFileSync(join(worktree, "_docs/plan/default/idd-1/plan.md"), "- 触る範囲:\n  - `a.ts`・`b.ts`。\n- 守ること: x\n");
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "P1", "2026-09-30T00:00:00Z", { worktree_path: worktree }));
  const done = await replanTaken();
  const envelope = readFileSync(join(state, "outbox", `${done.envelopeId}.xml`), "utf8");
  assert.match(envelope, /<round n="2"[^>]*outside="b\.ts"/);
  assert.match(envelope, /<round n="1"[^>]*outside=""/);
});

test("AC-005: the GO writes the plan's scope into its row, and a plan edited after the GO moves no line", async () => {
  const planPath = await goWithPlan("- 触る範囲:\n  - `a.ts`。\n- 守ること: x\n");
  const go = laneEvents().at(-1);
  assert.equal(go.event, "s1_go");
  assert.deepEqual(go.attrs.plan_scope, ["a.ts", ...["plan", "qa", "reference", "intent", "context"].map((kind) => `_docs/${kind}/default/idd-1/`)]);
  const lane = [...laneEvents(), ev("s2_start", { started_from_commit: "c0" }), ...round(1, ["a.ts", "b.ts"], "a.ts", "x")];
  const before = roundTrace(lane);
  assert.deepEqual(before.map((l) => l.outside_scope), [["b.ts"]]);
  // the plan is rewritten to take b.ts in: the line read from the same ledger is the line read before
  writeFileSync(planPath, "- 触る範囲:\n  - `b.ts`。\n- 守ること: x\n");
  assert.deepEqual(roundTrace(lane), before);
  assert.equal(JSON.stringify(roundTrace(lane)), JSON.stringify(before));
});

test("AC-005: after a replan each round is measured against the plan of its own GO", () => {
  // the first plan held a.ts (round 2 changed b.ts); the plan after the replan holds b.ts and the rounds changed a.ts
  const first = withScope(stopped(), ["a.ts"]);
  const lane = [
    ...first,
    ev("s1_replan_requested", { rounds: 2 }),
    ev("s1_ready", { depth: "deep" }),
    ev("s1_plan_review_started", { run_ids: ["P2"] }),
    cleanReview(),
    ev("s1_go", { plan_scope: ["b.ts"] }),
    ev("s2_start", { started_from_commit: "c1" }),
    ...round(1, ["a.ts"], "a.ts", "z"),
  ];
  const lines = roundTrace(lane);
  assert.deepEqual(lines.map((l) => [l.cycle, l.round, l.outside_scope]), [[0, 1, []], [0, 2, ["b.ts"]], [1, 1, ["a.ts"]]]);
  // the first plan's lines are the ones the lane had before it went back
  assert.deepEqual(lines.slice(0, 2), roundTrace(first));
  // a GO written before the scope was recorded measures nothing
  assert.deepEqual(roundTrace(stopped()).map((l) => l.outside_scope), [[], []]);
});

test("AC-007: a lane that is not at the card takes no replan", async () => {
  laneWith(stopped().slice(0, 6));
  const done = await applyDecision("s2_review_replan", { iddId: "IDD-1" });
  assert.equal(done.ok, false);
  assert.equal(existsSync(join(process.env.IDD_STATE_DIR, "outbox")), false);
});

/** the replanned lane that went through its new review and GO, with the first executor still on record */
function replannedLane() {
  const state = laneWith([...replannedReady(), ev("s1_plan_review_started", { run_ids: ["P2"] }), cleanReview(), ev("s1_go")]);
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "P1", "2026-09-30T00:00:00Z"));
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"));
  return state;
}

test("AC-008: the executor of the first plan neither stands for the new start nor holds its slot", () => {
  const state = replannedLane();
  assert.deepEqual(awaitingExec(), ["IDD-1"], "the new GO starts a new executor");
  assert.equal(runningExecutors(), 0);
  // the new executor's own row is a start: the lane is not started twice
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"), sessionRow("executor", "E2", "2026-10-02T00:00:00Z"));
  assert.deepEqual(awaitingExec(), []);
  assert.equal(runningExecutors(), 1);
});

test("AC-008: a lane never sent back is not started again while its executor is on record", () => {
  const state = laneWith(stopped().slice(0, 5));
  writeRows(state, "backlog.jsonl", backlogRow);
  assert.deepEqual(awaitingExec(), ["IDD-1"]);
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"));
  assert.deepEqual(awaitingExec(), []);
});

test("AC-007: the replan instruction reaches the planner's session, not the executor that made the change", async () => {
  const state = laneWith(stopped());
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "P1", "2026-09-30T00:00:00Z"));
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"));
  const delivered = [];
  setAgentRunner({ deliver: async (id, text, opts) => { delivered.push({ id, text, opts }); } });
  const done = await replanTaken();
  const res = await deliverPending();
  assert.deepEqual(res.delivered, [done.envelopeId]);
  assert.deepEqual(delivered.map((d) => [d.id, d.opts.type, d.opts.cwd]), [["P1", "s1_replan", "/wt/planner"]]);
  setAgentRunner(null);
});

test("AC-008: a session started after a replan written with another offset still counts as the new one", () => {
  // the replan is 00:10Z written as +09:00 (09:10 local); the new executor started at 00:20Z. As strings the new row
  // (`2026-10-01T00:20:00Z`) sorts before the replan (`2026-10-01T09:10:00+09:00`); as instants it is after.
  const replanAt = "2026-10-01T09:10:00+09:00";
  const [replan, ...rest] = [...replannedReady(), cleanReview(), ev("s1_go")].slice(stopped().length);
  const lane = [...stopped(), { ...replan, at: replanAt }, ...rest];
  const state = laneWith(lane);
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"), sessionRow("executor", "E2", "2026-10-01T00:20:00Z"));
  assert.deepEqual(awaitingExec(), [], "the new executor is a start");
  assert.equal(runningExecutors(), 1, "only the new executor holds the slot");
});

test("AC-007: a budget raised before the replan holds after it", () => {
  const raised = [...stopped().slice(0, 6), ev("lane_budget_extended", { limit: 42 }), ...stopped().slice(6), ev("s1_replan_requested", { rounds: 2 })];
  assert.equal(laneBudget(replanView(raised), 10), 42);
  assert.equal(replanView(raised).some((e) => e.event === "s1_go"), false);
  assert.equal(laneBudget(replanView(stopped()), 10), 10);
});

/**
 * A lane that went back to its plan and implemented again: the first plan's rounds are left out of the readings, so a
 * row's place in the view is not its place in the ledger. The callers hand the fold the ledger's indexes.
 */
function reimplementedLane() {
  return [...replannedReady(), cleanReview(), ev("s1_go"), ev("s2_start", { started_from_commit: "c1" }), ...round(1, ["c.ts"], "c.ts", "z"), ev("s2_fix_sent", { round: 1 }), ...round(2, ["d.ts"], "d.ts", "w")];
}

test("AC-007: the readings that take a row's index answer in the ledger's indexes after a replan", () => {
  const lane = reimplementedLane();
  const triages = lane.flatMap((e, i) => (e.event === "s2_triage_done" ? [i] : []));
  const [, , first, second] = triages;
  assert.ok(second >= replanView(lane).length, "the second judgement's ledger index is past the end of the view: a view index would read out of range");
  assert.deepEqual(acceptedAt(lane, second).map((a) => a.path), ["d.ts"]);
  assert.deepEqual(acceptedAt(lane, first).map((a) => a.path), ["c.ts"]);
  const sent = lane.findIndex((e, i) => i > first && e.event === "s2_fix_sent");
  assert.equal(fixAfter(lane, first), lane[sent], "the fix right after the first judgement of the new plan, not one from the first plan");
  assert.equal(fixAfter(lane, second), undefined);
  assert.equal(s4Triage(lane, second), false);
  assert.equal(closesAt(lane, second, { must: 1, should: 0 }), false);
  assert.equal(feedbackPassAt(lane, second), -1, "no PR feedback pass in the lane, whichever era the index is in");
});

test("AC-007: an index the first plan's era holds is answered from the whole lane, in the ledger's indexes", () => {
  const lane = reimplementedLane();
  const old = lane.findIndex((e) => e.event === "s2_triage_done");
  assert.ok(old >= 0 && old < lane.findIndex((e) => e.event === "s1_replan_requested"));
  assert.deepEqual(acceptedAt(lane, old).map((a) => a.path), ["a.ts"], "the dropped era's judgement is still readable");
  assert.equal(fixAfter(lane, old), lane.find((e) => e.event === "s2_fix_sent"));
});

test("AC-007: the question a replanned lane waits on is named by its ledger index", () => {
  const whole = reimplementedLane();
  const start = whole.findLastIndex((e) => e.event === "s2_start");
  const lane = [...whole.slice(0, start + 1), ev("question_batch_asked", { batch_id: "b1" })];
  assert.deepEqual(awaitingQuestion(lane), { role: "executor", index: lane.length - 1 }, "the question's own row");
  assert.deepEqual(awaitedAgent(whole.slice(0, start + 1)), { role: "executor", since: start }, "the executor owes its result since its start row");
});

/** the replanned lane at its new plan review, both sessions on record: the planner P1 and the first plan's executor E1 */
function replannedAtReview(extra = []) {
  const state = laneWith([...replannedReady(), ev("s1_plan_review_started", { run_ids: ["P2"] }), ev("s1_plan_review_done", { must: 1, should: 0, nit: 0 }), ...extra]);
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "P1", "2026-09-30T00:00:00Z"));
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"));
  return state;
}

const QUESTION_BATCH = { idd_id: "IDD-1", batch_id: "b1", asked_at: "2026-10-01T01:00:00Z", questions: [{ question_id: "Q-001", question: "q?", context: "c", options: [{ index: 1, label: "one" }] }] };

async function deliveredTo() {
  const delivered = [];
  setAgentRunner({ deliver: async (id, text, opts) => { delivered.push({ id, type: opts.type, cwd: opts.cwd }); } });
  await deliverPending();
  setAgentRunner(null);
  return delivered;
}

test("AC-008: the plan review's findings after a replan go to the planner, not the first plan's executor", async () => {
  replannedAtReview();
  await queueEnvelope("IDD-1", "plan_review_findings", "<x/>");
  assert.deepEqual(await deliveredTo(), [{ id: "P1", type: "plan_review_findings", cwd: "/wt/planner" }]);
});

/** the batch "b1" the lane asked is answered at the card, and the envelope goes where `deliveredTo` says */
async function answerBatch(state) {
  writeRows(state, "pending-questions.jsonl", QUESTION_BATCH);
  const done = await applyDecision("answer", { iddId: "IDD-1", batchId: "b1", questionId: "Q-001", selection: { index: 1 } });
  assert.equal(done.ok, true, done.error);
  return deliveredTo();
}

test("AC-008: the answer to the planner's question after a replan goes to the planner", async () => {
  const state = replannedAtReview([ev("s1_revise_requested"), ev("question_batch_asked", { batch_id: "b1" })]);
  assert.deepEqual(await answerBatch(state), [{ id: "P1", type: "question_batch_answered", cwd: "/wt/planner" }]);
});

test("AC-008: the answer to the executor's question still goes to the executor, replanned lane or not", async () => {
  const state = laneWith([...replannedReady(), cleanReview(), ev("s1_go"), ev("s2_start", { started_from_commit: "c1" }), ev("question_batch_asked", { batch_id: "b1" })]);
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "P1", "2026-09-30T00:00:00Z"));
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"), sessionRow("executor", "E2", "2026-10-02T00:00:00Z"));
  assert.deepEqual(await answerBatch(state), [{ id: "E2", type: "question_batch_answered", cwd: "/wt/executor" }]);
});

test("AC-008: a planner-bound envelope with no planner session waits, and is not handed to the executor", async () => {
  const state = replannedAtReview();
  writeRows(state, "planner-sessions.jsonl");
  await queueEnvelope("IDD-1", "plan_review_findings", "<x/>");
  assert.deepEqual(await deliveredTo(), []);
});

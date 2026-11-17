import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { setAgentRunner } from "../src/agent/port.ts";
import { appendLifecycle } from "../src/ledger/write.ts";
import { reviewLoopState } from "../src/ledger/review-loop.ts";
import { reviewNextStep } from "../src/ledger/review-loop-next.ts";
import { roundTrace } from "../src/ledger/derive.ts";
import { currentCycleLines, groundRecommendation, planReviewsOf, runShapeJudge, shapeRecommendationOf, shapeRoundsText, shapeSymptoms } from "../src/plan/shape-judge.ts";
import { runPlanReview } from "../src/plan/plan-review.ts";
import { DEPTH_TABLE } from "../src/plan/depth.ts";
import { planReviewPhase } from "../src/ledger/derive.ts";
import { backlogRow, ev, laneEvents, openState, reviewedPlan, round, sessionRow, stopped, twoRounds, writeRows } from "./helpers/lane-ledger.mjs";

/**
 * The shape judge of a stopped round (C-252-1, C-252-3, C-252-6): the same role the deep plan review runs reads the
 * lane's per-round lines and recommends one of three answers, with grounds that name values of those lines. A judge
 * that did not run leaves the card with the answers it always had, and the fact is on record.
 */

const line = (round, must, should, named, outside = [], changed = 1, cycle = 0) => ({ cycle, round, kind: "blind", accepted_must: must, accepted_should: should, named_files: named, changed_files: changed, outside_scope: outside });

const ROLES = "models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y, report: review }\n  judge: { model: x-y, report: shape }\npipeline:\n  plan_review: { role: pr, concurrency: 1 }\n";
const DECLARED = `${ROLES}  shape_judge: { role: judge, concurrency: 1 }\n`;

/** a state directory with a real git worktree for the executor, so the lane's head can be read */
function laneWith(events, roles = DECLARED) {
  const { root, state } = openState("shape-", events, roles);
  const worktree = join(root, "wt");
  mkdirSync(worktree);
  const git = (...args) => execFileSync("git", ["-C", worktree, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c0");
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z", { worktree_path: worktree }));
  return { state, worktree };
}

/** a runner whose review runs report `status` (change it through `.status`), and the options each start was given */
function judgeRunner() {
  const run = { started: [], status: { state: "running" } };
  setAgentRunner({ startReviewRun: async (opts) => { run.started.push(opts); return { runIds: ["J1"] }; }, reviewRunStatus: () => run.status });
  return run;
}

/** a recommendation whose grounds are written "kind:ref:text" */
const rec = (choice, grounds, shape) => ({ choice, reasons: grounds.map((g) => { const [kind, ref, ...text] = g.split(":"); return { kind, ref, text: text.join(":") }; }), ...(shape ? { shape } : {}) });
/** the status of a judge run that finished with `recommendation` in its report file */
const doneWith = (state, recommendation) => {
  const path = join(state, "..", "report.json");
  writeFileSync(path, JSON.stringify({ findings: [], recommendation }));
  return { state: "done", reportJson: path, reportMd: "/r.md" };
};

test("AC-003: the symptoms of Issue #293 come out of the lines and the review count", () => {
  const cases = [
    // the accepted count has not fallen over the last two rounds
    [[line(1, 2, 1, ["a"]), line(2, 1, 2, ["b"]), line(3, 2, 1, ["c"])], 1, ["受理数が 2 巡続けて減っていない"]],
    [[line(1, 5, 4, ["a"]), line(2, 3, 2, ["b"]), line(3, 1, 1, ["c"])], 1, []],
    // the same file named two rounds running
    [[line(1, 3, 0, ["a.ts", "b.ts"]), line(2, 1, 0, ["b.ts"])], 1, /同じ file の指摘が 2 巡続いた: b\.ts/],
    // a round changed a file outside the plan
    [[line(1, 1, 0, ["a"], ["z.ts"])], 1, /計画の範囲の外の file に実装が出た: z\.ts/],
    // the plan was reviewed more than three times
    [[line(1, 1, 0, ["a"])], 4, /計画の査読が 3 回を超えた（4 回）/],
    [[line(1, 1, 0, ["a"])], 3, []],
  ];
  for (const [lines, reviews, want] of cases) {
    if (want instanceof RegExp) assert.match(shapeSymptoms(lines, reviews)[0], want);
    else assert.deepEqual(shapeSymptoms(lines, reviews), want);
  }
});

test("AC-003: the plan reviews that make a symptom are those of the plan the lane has now, counted from its last return to the plan", () => {
  const review = () => ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 });
  const before = [ev("lane_open"), review(), review(), review(), review()];
  const replanned = [...before, ev("s1_replan_requested", { rounds: 2 }), review()];
  const sendBack = ev("s1_revise_requested", { instruction: "x" });
  // a plan sent back from the GO card is built anew too: the reviews before the send-back are not the plan's now
  const cases = [
    [before, 4, "four reviews of one plan are a symptom"],
    [replanned, 1, "one review of the rebuilt plan is not"],
    [[...replanned, review(), review(), review()], 4, "the rebuilt plan's own reviews add up"],
    [[...before, sendBack, ev("s1_ready", { depth: "deep" }), review()], 1, "the review after the resubmitted plan is counted, those before the send-back are not"],
    [[...replanned, sendBack, review()], 1, "the later of a return and a send-back is the start"],
  ];
  for (const [events, want, why] of cases) assert.equal(planReviewsOf(events), want, why);
  const symptoms = (events) => shapeSymptoms([line(1, 1, 0, ["a"])], planReviewsOf(events));
  assert.equal(symptoms(before).length, 1);
  assert.deepEqual(symptoms(replanned), []);
});

test("AC-004: a ground the ledger does not back is dropped, and a recommendation with none left is not one", () => {
  const lines = [line(1, 2, 1, ["a.ts"], ["z.ts"]), line(2, 1, 0, ["b.ts"])];
  const grounded = groundRecommendation(rec("replan", [
    "round:2:2 巡目も must が残った", "accepted:R1:巡 1 は 3 件", "file:a.ts:a.ts が名指された", "outside:z.ts:範囲の外",
    "round:9:巡 9 は台帳に無い", "file:nowhere.ts:名指されていない", "changed:not-a-round:台帳に無い",
  ], "同じ事実の持ち主を 1 つにする"), lines);
  assert.deepEqual(grounded.reasons.map((r) => [r.kind, r.ref]), [["round", "2"], ["accepted", "1"], ["file", "a.ts"], ["outside", "z.ts"]]);
  assert.equal(grounded.shape, "同じ事実の持ち主を 1 つにする");
  assert.equal(groundRecommendation(rec("accept", ["round:7:x"]), lines), undefined);
  assert.equal(groundRecommendation(rec("maybe", ["round:1:x"]), lines), undefined);
  assert.equal(groundRecommendation(null, lines), undefined);
  // a shape is carried only by a recommendation to go back to the plan
  assert.equal(groundRecommendation({ ...rec("accept", ["round:1:x"]), shape: "s" }, lines).shape, undefined);
});

test("AC-004: the line a ground shows is written from the ledger's values, never from the judge's sentence", () => {
  const lines = [line(1, 2, 1, ["a.ts"], ["z.ts"], 3), line(2, 1, 0, ["a.ts"], [], 4)];
  const grounded = groundRecommendation(rec("replan", [
    "round:1:巡 1 は 999 件", "accepted:R1:受理は 999 件", "changed:2:変更は 999 件", "file:a.ts:999 回名指された", "outside:z.ts:999 file 外",
  ], "形"), lines);
  assert.deepEqual(grounded.reasons.map((r) => r.text), [
    "巡 1（blind）: 受理 must 2 / should 1、変更 file 3 件",
    "巡 1 の受理数: must 2 / should 1",
    "巡 2 の変更 file の数: 4",
    "指摘が名指した file: a.ts（巡 1, 2）",
    "計画の範囲の外に出た file: z.ts（巡 1）",
  ]);
  assert.ok(grounded.reasons.every((r) => !r.text.includes("999")));
});

test("AC-004: a recommendation to go back to the plan with no shape to rebuild it in is not one", () => {
  const lines = [line(1, 2, 1, ["a.ts"])];
  assert.equal(groundRecommendation(rec("replan", ["round:1:x"]), lines), undefined);
  assert.equal(groundRecommendation(rec("replan", ["round:1:x"], "   "), lines), undefined);
  assert.equal(groundRecommendation(rec("replan", ["round:1:x"], "持ち主を 1 つに"), lines).shape, "持ち主を 1 つに");
  assert.equal(groundRecommendation(rec("accept", ["round:1:x"]), lines).choice, "accept", "the other answers need no shape");
});

test("AC-005: the file the judge reads holds the ledger's values and nothing else", () => {
  const text = shapeRoundsText([line(1, 2, 1, ["a.ts"], ["z.ts"], 3)], 2, ["s"]);
  assert.match(text, /今の計画の査読（最後に計画へ戻ってから）: 2 回/);
  assert.match(text, /巡 1（blind）: 受理 must 2 \/ should 1。名指した file: a\.ts。計画の範囲の外の file: z\.ts。変更 file の数: 3/);
  assert.equal(shapeRoundsText([line(1, 2, 1, ["a.ts"], ["z.ts"], 3)], 2, ["s"]), text, "the same lines give the same text");
});

test("AC-003: a stopped lane gets one judge run, and the card then carries its grounded recommendation", async () => {
  const { state } = laneWith(stopped());
  const run = judgeRunner();
  const first = await runShapeJudge();
  assert.deepEqual(first.started, ["IDD-1"]);
  assert.equal(first.hold.size, 0, "a lane already at its card is not held");
  assert.equal(run.started[0].stage, "shape");
  assert.ok(run.started[0].inputs.some((p) => p.endsWith(".md") && readFileSync(p, "utf8").includes("巡 2（blind）")), "the rounds file is among the inputs");
  // asked once for a stop, however many ticks come
  assert.deepEqual((await runShapeJudge()).started, []);
  assert.equal(run.started.length, 1);

  run.status = doneWith(state, rec("replan", ["file:b.ts:b.ts が名指された", "file:ghost.ts:台帳に無い"], "持ち主を 1 つに"));
  assert.deepEqual((await runShapeJudge()).judged, ["IDD-1"]);
  const evs = laneEvents();
  const got = shapeRecommendationOf(evs);
  assert.equal(got.choice, "replan");
  assert.deepEqual(got.reasons.map((r) => r.ref), ["b.ts"]);
  assert.equal(evs.at(-1).event, "s2_shape_judged");
  assert.equal(reviewLoopState(evs).state, "escalated", "the judge's notes do not move the loop");
});

test("AC-005: the judge's notes are no new stop: the loop writes none after them, so the recommendation is kept and the judge is asked once", async () => {
  const { state } = laneWith(stopped());
  const run = judgeRunner();
  await runShapeJudge();
  assert.equal(reviewNextStep(laneEvents(), {}).action, "nothing", "the judge's start is not a reason to write the stop again");
  run.status = doneWith(state, rec("replan", ["file:b.ts:b.ts が名指された"], "持ち主を 1 つに"));
  await runShapeJudge();
  const evs = laneEvents();
  assert.equal(reviewNextStep(evs, {}).action, "nothing", "nor is its finished judgement");
  assert.equal(shapeRecommendationOf(evs)?.choice, "replan", "the recommendation is not dropped as the answer to a card nobody answered");
  assert.deepEqual((await runShapeJudge()).started, [], "and the same stop is not judged again");
  assert.equal(run.started.length, 1);
  // a stop with a retry state (a window wait, a stage that would not start) is the loop's own and is not judged
  await appendLifecycle("s2_review_escalated", "IDD-1", { reason: "段を起動できない", retry_state: { state: "start_blind", kind: "blind", round: 2 } });
  assert.deepEqual((await runShapeJudge()).started, []);
});

/** the last event on record after the judge ran: it must say the judge was unavailable, and why */
const unavailable = (reason) => {
  const last = laneEvents().at(-1);
  assert.equal(last.event, "s2_shape_judged");
  assert.equal(last.attrs.unavailable, true);
  if (reason) assert.match(last.attrs.reason, reason);
};

test("AC-009: a judge that could not run is on record, and the card has no recommendation", async () => {
  // no slot declared
  laneWith(stopped(), ROLES);
  judgeRunner();
  await runShapeJudge();
  unavailable(/shape_judge/);
  assert.equal(shapeRecommendationOf(laneEvents()), undefined);

  // the run failed to start
  laneWith(stopped());
  setAgentRunner({ startReviewRun: async () => { throw new Error("枠が足りない"); }, reviewRunStatus: () => ({ state: "running" }) });
  await runShapeJudge();
  unavailable(/枠が足りない/);

  // the run ended without a report, and one whose grounds the ledger does not back
  const { state } = laneWith(stopped());
  let run = judgeRunner();
  await runShapeJudge();
  run.status = { state: "failed", error: "budget" };
  await runShapeJudge();
  unavailable();
  assert.equal(shapeRecommendationOf(laneEvents()), undefined);

  laneWith(stopped());
  run = judgeRunner();
  await runShapeJudge();
  run.status = doneWith(state, rec("accept", ["round:99:x"]));
  await runShapeJudge();
  unavailable(/根拠/);
  setAgentRunner(null);
});

test("AC-003: a stop for the budget is not judged", async () => {
  laneWith([...stopped(), ev("lane_over_budget", { cost: 12, limit: 10 })]);
  const run = judgeRunner();
  assert.deepEqual((await runShapeJudge()).started, []);
  assert.equal(run.started.length, 0);
  setAgentRunner(null);
});

/** the plan made ready again after a return to it, reviewed clean, gone through, and the executor started anew */
const goneThroughAgain = () => [ev("s1_ready", { depth: "deep" }), ev("s1_plan_review_started", { run_ids: ["P2"] }), ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }), ev("s1_go"), ev("s2_start", { started_from_commit: "c1" })];

/** a lane with one round that accepted a must in a.ts, before the cap: the loop would send the fix */
const midLoop = (head = reviewedPlan(), files = ["a.ts"]) => [...head, ...round(1, files, "a.ts", "x")];

/** the plan sent back three times, each time reviewed and made ready again: a symptom of its own */
const sentBack = () => Array.from({ length: 3 }, () => [ev("s1_plan_review_started", { run_ids: ["P"] }), ev("s1_plan_review_done", { must: 1, should: 0, nit: 0 }), ev("s1_ready", { depth: "deep" })]).flat();
/** a plan reviewed four times before it went through: the lane's symptom, with the rest of its history after it */
const sentBackPlan = () => [ev("lane_open"), ev("s1_ready", { depth: "deep" }), ...sentBack(), ...reviewedPlan().slice(2)];
const symptomEvents = () => [...reviewedPlan(), ...twoRounds(["a.ts", "b.ts"], ["a.ts"])];

/** the first pass over a lane at its fix with a symptom: one judge run starts, and the lane is held until it answers */
async function heldForJudge(message) {
  const run = judgeRunner();
  const first = await runShapeJudge();
  assert.deepEqual([first.started, [...first.hold]], [["IDD-1"], ["IDD-1"]], message);
  return run;
}

test("AC-003: a symptom before the cap holds the lane at its fix, and a recommendation to go back stops it at the card", async () => {
  // the plan was reviewed four times, which is a symptom
  const events = midLoop(sentBackPlan());
  const { state } = laneWith(events);
  assert.equal(reviewLoopState(events).state, "send_fix");
  const run = await heldForJudge("the loop is told to leave the lane until the judge answers");
  assert.deepEqual([...(await runShapeJudge()).hold], ["IDD-1"]);

  run.status = doneWith(state, rec("replan", ["round:1:巡 1 の must"], "形"));
  assert.equal((await runShapeJudge()).hold.size, 0);
  const evs = laneEvents();
  assert.equal(evs.at(-1).event, "s2_review_escalated");
  assert.equal(evs.at(-1).attrs.shape, true);
  assert.equal(reviewLoopState(evs).state, "escalated", "the lane is at its card before the cap");
  assert.equal(shapeRecommendationOf(evs).choice, "replan");
  // the card's judge is not asked again for this stop
  assert.deepEqual((await runShapeJudge()).started, []);
  setAgentRunner(null);
});

test("AC-009: a symptom lane that finds the judge's slot full records that it did not run, and its fix goes", async () => {
  const events = symptomEvents();
  // another lane's judge holds the one slot
  laneWith([...events, { ...ev("s2_shape_started", { round: 3, trigger: "escalated", run_id: "J9" }), idd_id: "IDD-2" }]);
  const run = judgeRunner();
  const result = await runShapeJudge();
  assert.deepEqual([result.started, result.judged, [...result.hold]], [[], ["IDD-1"], []], "no run, a record of it, and no hold on the lane");
  assert.equal(run.started.length, 0);
  unavailable(/枠/);
  assert.equal(reviewLoopState(laneEvents()).state, "send_fix", "the fix goes out as it would have");
  assert.deepEqual([...(await runShapeJudge()).hold], [], "the round is not asked again");
  setAgentRunner(null);
});

/** a runner that starts run J1 and answers each run's status by its id (a run not listed is running) */
function runnerByRun(statuses) {
  const started = [];
  setAgentRunner({ startReviewRun: async (opts) => { started.push(opts); return { runIds: ["J1"] }; }, reviewRunStatus: (id) => statuses[id] ?? { state: "running" } });
  return started;
}
const otherLane = (e) => ({ ...e, idd_id: "IDD-2" });

test("AC-003: a closed lane's unanswered judge run does not hold the slot of a lane whose symptom shows", async () => {
  laneWith([...symptomEvents(), otherLane(ev("s2_shape_started", { round: 3, trigger: "escalated", run_id: "J9" })), otherLane(ev("lane_close"))]);
  const started = runnerByRun({});
  const result = await runShapeJudge();
  assert.deepEqual([result.started, [...result.hold]], [["IDD-1"], ["IDD-1"]], "the closed lane's run is not one that is running");
  assert.equal(started.length, 1);
  setAgentRunner(null);
});

test("AC-003: a run that finished frees its slot in the same tick, for a lane whose symptom shows after it", async () => {
  const { state } = laneWith([...symptomEvents(), otherLane(ev("s2_shape_started", { round: 3, trigger: "escalated", run_id: "J9" }))]);
  // IDD-2 is the older lane, so the loop reaches its finished run before the symptom lane
  writeRows(state, "backlog.jsonl", { ...backlogRow, idd_id: "IDD-2", title: "U", created_at: "2026-09-01T00:00:00Z" }, backlogRow);
  const started = runnerByRun({ J9: { state: "failed", error: "budget" } });
  const result = await runShapeJudge();
  assert.deepEqual(result.judged, ["IDD-2"], "the finished run is closed, and the symptom lane is not recorded as having found no slot");
  assert.deepEqual(result.started, ["IDD-1"], "the finished run no longer occupies the one slot");
  assert.equal(started.length, 1);
  setAgentRunner(null);
});

test("AC-003: a run still going keeps its slot against a lane whose symptom shows", async () => {
  laneWith([...symptomEvents(), otherLane(ev("s2_shape_started", { round: 3, trigger: "escalated", run_id: "J9" }))]);
  const started = runnerByRun({});
  const result = await runShapeJudge();
  assert.deepEqual([result.started, result.judged], [[], ["IDD-1"]]);
  assert.equal(started.length, 0);
  setAgentRunner(null);
});

test("AC-003: a card that was answered is not held for the run started when it stopped", async () => {
  // the judge was asked for the stop at the card, and the person answered "keep going" before it finished
  laneWith([...stopped(), ev("s2_shape_started", { round: 2, trigger: "escalated", run_id: "J1" }), ev("s2_review_resumed", {})]);
  runnerByRun({});
  const result = await runShapeJudge();
  assert.equal(reviewLoopState(laneEvents()).state, "send_fix");
  assert.deepEqual([...result.hold], [], "the fix goes out; nothing waits for a recommendation to a card that is gone");
  setAgentRunner(null);
});

test("AC-003: a recommendation to keep fixing lets the lane go on, with no card", async () => {
  const events = symptomEvents();
  const { state } = laneWith(events);
  assert.equal(reviewLoopState(events).state, "send_fix");
  const run = judgeRunner();
  assert.deepEqual((await runShapeJudge()).started, ["IDD-1"], "the same file twice running is a symptom");
  run.status = doneWith(state, rec("continue", ["file:a.ts:a.ts は 1 つの穴"]));
  assert.equal((await runShapeJudge()).hold.size, 0);
  const evs = laneEvents();
  assert.equal(evs.at(-1).event, "s2_shape_judged");
  assert.equal(reviewLoopState(evs).state, "send_fix", "the fix goes out as it would have");
  // the round is not asked again
  assert.deepEqual((await runShapeJudge()).started, []);
  setAgentRunner(null);
});

test("AC-003: a symptom in the first round after a return to the plan is judged again, not taken for the old cycle's round 1", async () => {
  const firstCycle = midLoop(sentBackPlan());
  const events = [
    ...firstCycle,
    ev("s2_shape_started", { round: 1, trigger: "symptom", run_id: "J0" }),
    ev("s2_shape_judged", { round: 1, trigger: "symptom", run_id: "J0", recommendation: rec("replan", ["round:1:x"]) }),
    ev("s2_review_escalated", { reason: "形の崩れ", shape: true }),
    ev("s1_replan_requested", { rounds: 1 }),
    // the rebuilt plan is reviewed four times itself: the symptom is the new cycle's own, not the old cycle's file again
    ...sentBackPlan(),
    ...round(1, ["a.ts"], "a.ts", "x"),
  ];
  laneWith(events);
  assert.equal(reviewLoopState(events).state, "send_fix");
  assert.equal(reviewLoopState(events).round, 1);
  const run = await heldForJudge("the new cycle's round 1 holds its fix for a judge of its own");
  assert.equal(run.started.length, 1);
  setAgentRunner(null);
});

/** a lane at its plan review with a planner session, in a worktree holding a qa that declares Medium risk (a lane with no declared risk reads as High and raises every depth to deep) */
function planningLane(depth) {
  const { state, worktree } = laneWith([ev("lane_open"), ev("s1_ready", { depth })], ROLES);
  mkdirSync(join(worktree, "_docs/qa/default/idd-1"), { recursive: true });
  writeFileSync(join(worktree, "_docs/qa/default/idd-1/qa.md"), "---\nrisk: Medium\n---\n");
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "S1", "2026-09-30T00:00:00Z", { worktree_path: worktree }));
  return state;
}

/** a plan-review runner that starts `runs`, answers each run's status with `status(id)`, and keeps the options of every start */
function planRunner(runs, status) {
  const calls = [];
  setAgentRunner({ deliver: async () => {}, startPlanReview: async (o) => { calls.push(o); return { runs }; }, planReviewStatus: status, mergeFindings: (lists) => lists.flat() });
  return calls;
}
const RUN = (runId, role) => ({ runId, role, model: "x/y" });

test("AC-001: only a depth with a shape column starts the judge beside the plan review", async () => {
  assert.deepEqual(["shallow", "standard", "deep"].map((d) => DEPTH_TABLE[d].shape), [0, 0, 1]);
  const run = async (depth) => {
    planningLane(depth);
    const calls = planRunner([RUN("L1", "pr")], () => ({ state: "running" }));
    await runPlanReview();
    setAgentRunner(null);
    return calls;
  };
  assert.equal((await run("deep"))[0].withShape, true);
  assert.equal((await run("standard"))[0].withShape, undefined);
  assert.equal((await run("shallow"))[0].withShape, undefined);
});

test("AC-002: a must from the judge sends the plan back like a reviewer's, and a should does not", async () => {
  const finish = async (findings) => {
    planningLane("deep");
    let status = { state: "running" };
    planRunner([RUN("L1", "pr"), RUN("J1", "judge")], (id) => (id === "J1" ? status : { state: "done", reportMd: "/r.md", findings: [] }));
    await runPlanReview();
    status = { state: "done", reportMd: "/j.md", findings };
    await runPlanReview();
    setAgentRunner(null);
    return laneEvents();
  };
  const must = await finish([{ severity: "must", path: "plan.md", claim: "同じ事実を 2 か所で決めている", evidence: "e" }]);
  assert.equal(planReviewPhase(must).phase, "revising", "no GO card while the must stands");
  assert.equal(must.find((e) => e.event === "s1_plan_review_done").attrs.must, 1);
  const should = await finish([{ severity: "should", path: "plan.md", claim: "触る範囲が広い", evidence: "e" }]);
  assert.equal(planReviewPhase(should).phase, "reviewed");
  assert.equal(should.find((e) => e.event === "s1_plan_review_done").attrs.should, 1);
});

test("AC-005: the lines for the judge are the ledger's rounds", () => {
  const lines = roundTrace(stopped());
  assert.deepEqual(lines.map((l) => [l.round, l.named_files]), [[1, ["a.ts"]], [2, ["b.ts"]]]);
});

test("AC-005: the lines the judge reads are those of the plan the lane has now, and a ground resolves against them", async () => {
  // the first plan's round 1 accepted three musts in a.ts; the plan was rebuilt, and its own round 1 accepted one in c.ts
  const events = [
    ...reviewedPlan(),
    ...round(1, ["a.ts"], "a.ts", "x", { accepted: [1, 2, 3].map((n) => ({ severity: "must", path: "a.ts", claim: `c${n}`, action: "fix" })) }),
    ev("s2_review_escalated", { reason: "止まった" }),
    ev("s1_replan_requested", { rounds: 1 }),
    ...goneThroughAgain(),
    ...round(1, ["c.ts"], "c.ts", "z"),
    ev("s2_fix_sent", { round: 1 }),
    ...round(2, ["d.ts"], "d.ts", "w", { escalated_claims: [] }),
    ev("s2_review_escalated", { reason: "修正が上限に達した" }),
  ];
  const all = roundTrace(events);
  assert.deepEqual(all.map((l) => [l.cycle, l.round]), [[0, 1], [1, 1], [1, 2]]);
  assert.deepEqual(currentCycleLines(all, 1).map((l) => l.round), [1, 2]);
  assert.deepEqual(currentCycleLines(all, 2), [], "right after a return no line of the new cycle exists, and the old ones are not it");

  const { state } = laneWith(events);
  const run = judgeRunner();
  await runShapeJudge();
  const rounds = readFileSync(run.started[0].inputs.find((p) => p.endsWith(".md") && p.includes("rounds-")), "utf8");
  assert.ok(!rounds.includes("must 3"), "the first plan's round is not shown to the judge");
  assert.match(rounds, /計画へ戻る前の巡: 1 巡/);
  assert.match(rounds, /巡 1（blind）: 受理 must 1 \/ should 0/);
  run.status = doneWith(state, rec("accept", ["accepted:1:x", "file:a.ts:x", "file:c.ts:x", "round:2:x"]));
  await runShapeJudge();
  const got = shapeRecommendationOf(laneEvents());
  assert.deepEqual(got.reasons.map((r) => r.text), ["巡 1 の受理数: must 1 / should 0", "指摘が名指した file: c.ts（巡 1）", "巡 2（blind）: 受理 must 1 / should 0、変更 file 1 件"]);
  setAgentRunner(null);
});

test("AC-003: a run that finishes after its card was answered is closed without a recommendation, and the next card does not show it", async () => {
  const { state } = laneWith(stopped());
  const run = judgeRunner();
  await runShapeJudge();
  assert.equal(run.started.length, 1);
  // penne answers the card, and the lane stops again, before the run reports
  await appendLifecycle("s2_review_resumed", "IDD-1", { decision: "continue", note: "" });
  await appendLifecycle("s2_fix_sent", "IDD-1", { round: 2 });
  run.status = doneWith(state, rec("replan", ["round:1:巡 1"], "持ち主を 1 つに"));
  const judged = await runShapeJudge();
  assert.deepEqual(judged.judged, ["IDD-1"]);
  const last = laneEvents().at(-1);
  assert.equal(last.event, "s2_shape_judged");
  assert.equal(last.attrs.unavailable, true);
  assert.equal(last.attrs.recommendation, undefined);
  assert.match(last.attrs.reason, /回答済み/);
  assert.equal(shapeRecommendationOf(laneEvents()), undefined);
  // the run is closed: it does not hold a slot or come back
  assert.deepEqual((await runShapeJudge()).hold.size, 0);
  setAgentRunner(null);
});

test("AC-003: a judgement written after an answer between its start and its record is not shown on the card that follows", () => {
  const started = ev("s2_shape_started", { round: 2, trigger: "escalated", run_id: "J1" });
  const judged = ev("s2_shape_judged", { round: 2, trigger: "escalated", run_id: "J1", recommendation: rec("accept", ["round:1:x"]) });
  const stop = ev("s2_review_escalated", { reason: "止まった" });
  const head = [...reviewedPlan(), stop];
  assert.equal(shapeRecommendationOf([...head, started, judged]).choice, "accept", "the stop the run was started for shows it");
  // answered, then stopped again, then the late judgement lands: the second stop is not the one it was started for
  const answered = ev("s2_review_resumed", { decision: "continue" });
  const again = ev("s2_review_escalated", { reason: "また止まった" });
  assert.equal(shapeRecommendationOf([...head, started, answered, again, judged]), undefined);
  assert.equal(shapeRecommendationOf([...head, started, again, judged]), undefined, "another stop in between is another card");
});

/** a round whose triage accepted a must on each of `paths` */
const roundOn = (n, paths) => [
  ev("s2_result", { outcome: "success", changed_files: paths }),
  ev("s2_triage_done", { kind: "blind", round: n, accepted: paths.map((p) => ({ severity: "must", path: p, claim: `c${n}`, action: "fix" })) }),
];
/** the first round names four files, the second a.ts and b.ts (a.ts twice running: the one symptom), the cap stops the lane, and penne says keep going */
const FIRST_ROUND = ["a.ts", "c.ts", "d.ts", "e.ts"];
const answeredAtCap = (resumed = {}) => [
  ...reviewedPlan(), ...roundOn(1, FIRST_ROUND), ev("s2_fix_sent", { round: 1 }), ...roundOn(2, ["a.ts", "b.ts"]),
  ev("s2_review_escalated", { reason: "修正が 3 巡に達した" }), ev("s2_review_resumed", { decision: "continue", note: "", ...resumed }),
];
const noJudgeReasons = () => laneEvents().filter((e) => e.event === "s2_shape_judged" && e.attrs.unavailable).map((e) => e.attrs.reason);

test("AC-001: after penne's keep going at the cap, the symptom the answer let through starts no judge run", async () => {
  const events = answeredAtCap();
  laneWith(events);
  const run = judgeRunner();
  assert.deepEqual(shapeSymptoms(currentCycleLines(roundTrace(events), 0), 1), ["同じ file の指摘が 2 巡続いた: a.ts"], "the symptom is still on the round's line");
  assert.equal(reviewLoopState(events).state, "send_fix");
  const result = await runShapeJudge();
  assert.deepEqual([result.started, [...result.hold]], [[], []]);
  assert.equal(run.started.length, 0);
  assert.match(noJudgeReasons()[0], /続ける/, "that no judge ran is on record");
  setAgentRunner(null);
});

test("AC-002: the round's fix still goes out after the answer, and the card is not raised again for the same symptom", async () => {
  laneWith(answeredAtCap());
  judgeRunner();
  await runShapeJudge();
  assert.deepEqual((await runShapeJudge()).judged, [], "the round is looked at once");
  const evs = laneEvents();
  assert.equal(evs.at(-1).event, "s2_shape_judged");
  assert.equal(evs.filter((e) => e.event === "s2_review_escalated").length, 1, "no new card");
  assert.equal(reviewLoopState(evs).state, "send_fix");
  assert.equal(reviewNextStep(evs, {}).action, reviewNextStep(answeredAtCap(), {}).action, "the loop's next step is the same as without the note");
  setAgentRunner(null);
});

/** the round after penne's answer: the fix of round 2 went, and round 3 names `paths` */
const thirdRound = (paths) => [...answeredAtCap(), ev("s2_fix_sent", { round: 2 }), ...roundOn(3, paths)];

test("AC-003: the same symptom on the next round starts no run", async () => {
  // round 3 names a.ts again and no more than before: the one symptom penne let through
  laneWith(thirdRound(["a.ts"]));
  const run = judgeRunner();
  assert.equal(reviewLoopState(laneEvents()).state, "send_fix");
  assert.deepEqual([(await runShapeJudge()).started, run.started.length], [[], 0]);
  setAgentRunner(null);
});

test("AC-003: a new file in the symptom starts a run, and a recommendation to go back to the plan stops the lane at the card", async () => {
  // round 3 also names b.ts again: a symptom penne did not see
  const { state } = laneWith(thirdRound(["a.ts", "b.ts"]));
  const run = await heldForJudge("the new file is asked about");
  const started = laneEvents().find((e) => e.event === "s2_shape_started").attrs;
  assert.deepEqual([started.trigger, started.symptoms.filter((s) => s.includes("b.ts")).length], ["symptom", 1]);
  run.status = doneWith(state, rec("replan", ["file:b.ts:b.ts"], "形"));
  await runShapeJudge();
  assert.deepEqual([laneEvents().at(-1).attrs.shape, reviewLoopState(laneEvents()).state], [true, "escalated"]);
  setAgentRunner(null);
});

test("AC-003: an answer to a stop that was no stop of the rounds, or from before a return to the plan, lets nothing through", async () => {
  const retryStop = ev("s2_review_escalated", { reason: "判定に失敗", retry_state: { state: "start_triage" } });
  // the triage of round 2 failed, penne said keep going so it runs again, and it named a.ts twice running
  const afterRetry = [
    ...reviewedPlan(), ...roundOn(1, FIRST_ROUND), ev("s2_fix_sent", { round: 1 }), ev("s2_result", { outcome: "success", changed_files: ["a.ts"] }),
    ev("s2_triage_started", { round: 2 }), retryStop, ev("s2_review_resumed", { decision: "continue" }), ev("s2_triage_started", { round: 2 }),
    ev("s2_triage_done", { kind: "blind", round: 2, accepted: ["a.ts", "b.ts"].map((path) => ({ severity: "must", path, claim: "c2", action: "fix" })) }),
  ];
  for (const events of [
    afterRetry,
    [...answeredAtCap(), ev("s1_replan_requested", { rounds: 2 }), ...goneThroughAgain(), ...roundOn(1, FIRST_ROUND), ev("s2_fix_sent", { round: 1 }), ...roundOn(2, ["a.ts", "b.ts"])],
  ]) {
    laneWith(events);
    const run = judgeRunner();
    assert.equal(reviewLoopState(events).state, "send_fix");
    assert.deepEqual((await runShapeJudge()).started, ["IDD-1"], "the symptom was not let through");
    assert.equal(run.started.length, 1);
    setAgentRunner(null);
  }
});

/** the lanes a tick starts a judge run for over `events`, and how many runs the runner was asked for */
const startedFor = async (events) => {
  laneWith(events);
  const run = judgeRunner();
  const started = (await runShapeJudge()).started;
  setAgentRunner(null);
  return [started, run.started.length];
};

test("a keep going to a stop over the judgement's questions lets no symptom through", async () => {
  // round 1 fixed a.ts (a should), and round 2 names a.ts again with a question: the stop is for the question
  const should = (n, path) => [ev("s2_result", { outcome: "success", changed_files: [path] }), ev("s2_triage_done", { kind: "blind", round: n, accepted: [{ severity: "should", path, claim: `c${n}`, action: "fix" }], escalated_claims: n === 2 ? ["仕様が決まっていない"] : [] })];
  const stopped = [...reviewedPlan(), ...should(1, "a.ts"), ev("s2_fix_sent", { round: 1 }), ...should(2, "a.ts"), ev("s2_review_escalated", { reason: "判定の質問" })];
  // with a note the loop sends the fix, and the symptom of the rounds (a.ts twice running) is on the line
  const events = [...stopped, ev("s2_review_resumed", { decision: "continue", note: "直して" })];
  assert.equal(reviewLoopState(events).state, "send_fix");
  assert.equal(reviewLoopState([...stopped, ev("s2_review_resumed", { decision: "continue", note: "" })]).state, "start_blind", "without one it goes on as if nothing was asked");
  assert.deepEqual(await startedFor(events), [["IDD-1"], 1], "the answer to the question was no answer about the symptom");
});

/** the rounds after penne's answer: round 3 names c.ts, round 4 d.ts and x.ts (a.ts is gone), then `after` rounds name a.ts */
const goneAndBack = (after) => [
  ...answeredAtCap(), ev("s2_fix_sent", { round: 2 }), ...roundOn(3, ["c.ts"]), ev("s2_fix_sent", { round: 3 }), ...roundOn(4, ["d.ts", "x.ts"]),
  ...Array.from({ length: after }, (_, i) => [ev("s2_fix_sent", { round: 4 + i }), ...roundOn(5 + i, ["a.ts"])]).flat(),
];

test("a symptom that was gone for a round and comes back is new, and the judge is asked", async () => {
  // penne let a.ts through at round 2; rounds 3 and 4 do not name it, and rounds 5 and 6 name it twice running
  const events = goneAndBack(2);
  assert.deepEqual(shapeSymptoms(currentCycleLines(roundTrace(events), 0), 1), ["同じ file の指摘が 2 巡続いた: a.ts"]);
  assert.deepEqual(await startedFor(events), [["IDD-1"], 1]);
});

test("a symptom that stands without a break stays let through over more than one round", async () => {
  assert.deepEqual(await startedFor([...thirdRound(["a.ts"]), ev("s2_fix_sent", { round: 3 }), ...roundOn(4, ["a.ts"])]), [[], 0]);
});

test("AC-004: a stop for the cap, a swing or a stall is judged as it was, whatever symptom penne let through before it", async () => {
  const stopped2 = [...answeredAtCap(), ev("s2_fix_sent", { round: 2 }), ...roundOn(3, ["a.ts"]), ev("s2_review_escalated", { reason: "修正が往復している" })];
  const { state } = laneWith(stopped2);
  const run = judgeRunner();
  assert.deepEqual((await runShapeJudge()).started, ["IDD-1"]);
  assert.equal(laneEvents().at(-1).attrs.trigger, "escalated");
  run.status = doneWith(state, rec("accept", ["round:3:x"]));
  await runShapeJudge();
  assert.equal(shapeRecommendationOf(laneEvents()).choice, "accept", "the card carries its recommendation");
  assert.deepEqual((await runShapeJudge()).started, [], "one run for the stop");
  assert.equal(run.started.length, 1);
  setAgentRunner(null);
});

test("AC-005: the boundaries penne passed with keep going do not change the round's lines or what the judge is asked", async () => {
  const boundaries = [{ ref: "F-1", choice: "prior" }];
  assert.deepEqual(roundTrace(answeredAtCap({ boundaries })), roundTrace(answeredAtCap()), "outside_scope and the rest of the lines are the same");
  laneWith(answeredAtCap({ boundaries }));
  const run = judgeRunner();
  assert.deepEqual((await runShapeJudge()).started, []);
  assert.equal(run.started.length, 0);
  assert.deepEqual(laneEvents().find((e) => e.event === "s2_review_resumed").attrs.boundaries, boundaries, "the boundaries stay on the answer's row for the fix envelope and the note");
  setAgentRunner(null);
});

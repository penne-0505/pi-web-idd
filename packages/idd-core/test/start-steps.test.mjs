import assert from "node:assert/strict";
import { test } from "node:test";

import { laneAnswer } from "../src/intent/moonbit-fold.ts";
import {
  startCountsReference,
  startExecReference,
  startPlanReviewReference,
  startPrepReference,
} from "../src/plan/start-step-reference.ts";

// The startup stages' next step, as the running tick asks for it. The answer is the MoonBit fold's; these tests pin
// the steps the tick's readers already depend on, and hold the fold against the TypeScript reading over the same rows
// and the same observations. That is the committed part of what the cross-check does against a real ledger
// (`packages/idd-fold/crosscheck.mjs`, C-205-1). The wall-clock behaviour of the stages is in `prep-start` /
// `exec-start` / `plan-review`.

const LANE = "IDD-1";
const row = (event, attrs = {}) => ({ idd_id: LANE, event, at: "2026-10-23T10:00:00.000Z", attrs });

/** the rows of a lane whose plan is ready for its review */
const atPlanReview = () => [
  row("lane_open"), row("s1_ready", { records_shape: "state", plan_records: { choices: 2 } }),
  row("s1_plan_review_started", { run_ids: ["R1", "R2"], runs: [{ run_id: "R1", role: "pa" }, { run_id: "R2", model: "m" }] }),
];

/** the observations of a stage whose lane has nothing in the way */
function factsOf(extra = {}) {
  return {
    lane: LANE,
    limit: 2,
    started: 0,
    runner: true,
    sessions: [],
    hold: "",
    sessionShape: "",
    declared: true,
    runnerStart: true,
    runnerStatus: true,
    ...extra,
  };
}

/**
 * The observations split as the driver keeps them: the readings the caller hands in, and the answers of the helpers
 * the fold calls. A helper's answer is not handed in before it is called, so the steps stay the fold's to name.
 */
function split(facts) {
  const plain = {};
  const answers = {};
  for (const [id, value] of Object.entries(facts)) (id.startsWith("call|") ? answers : plain)[id] = value;
  return { plain, answers };
}

/** one answer's steps run: a write joins the rows, a call's answer is kept under the fact it named */
function drive(ask, rows, facts) {
  const { plain, answers } = split(facts);
  const read = [...rows];
  const given = { ...plain };
  const trail = [];
  for (let round = 0; round < 24; round += 1) {
    const answer = ask(read, { ...given });
    const list = answer.steps ?? [answer];
    for (const step of list) {
      trail.push(step);
      if (step.do === "action") return { trail, action: step.action, ...(step.reason ? { reason: step.reason } : {}), ...(step.error ? { error: step.error } : {}), ...(step.wait ? { wait: true } : {}) };
      if (step.do === "write") {
        read.push(row(step.event, step.attrs ?? {}));
        if (step.action) return { trail, action: step.action };
        continue;
      }
      given[step.fact] = { result: answers[step.fact] ?? {}, keep: step.keep ?? {} };
    }
  }
  throw new Error("起動の一歩が終わりませんでした");
}

/** the answer of a stage and of the TypeScript reading, over the same rows and the same observations */
function both(op, reference, rows, facts) {
  const mine = drive((read, f) => laneAnswer(op, read, { facts: f }), rows, facts);
  const theirs = drive((read, f) => reference(read, f), rows, facts);
  assert.deepEqual(mine, theirs, `${op}: 畳みと TS の読みが食い違いました`);
  return mine;
}

const helpers = (trail) => trail.filter((step) => step.do === "call").map((step) => `${step.helper}|${step.site}`);
const writes = (trail) => trail.filter((step) => step.do === "write").map((step) => step.event);

test("AC-001/AC-002: the planner's start spawns once and hands the brief, in the fold's order", () => {
  const facts = factsOf({
    "call|ensure_worktree|prep": { path: "/w", branch: "b" },
    "call|spawn|prep": { sessionId: "S" },
    "call|record_session|prep": {},
    "call|record_quota_fallbacks|prep": {},
    "call|deliver|prep": {},
  });
  const answer = both("start_prep", startPrepReference, [row("lane_open")], facts);
  assert.equal(answer.action, "started");
  assert.deepEqual(helpers(answer.trail), [
    "ensure_worktree|prep", "spawn|prep", "record_session|prep", "record_quota_fallbacks|prep", "deliver|prep",
  ]);
  assert.deepEqual(writes(answer.trail), []);
});

test("AC-005: a session that still holds the planner's slot leaves the lane waiting", () => {
  const rows = [row("lane_open")];
  const held = both("start_prep", startPrepReference, rows, factsOf({ limit: 1, sessions: [{ idd_id: LANE }] }));
  assert.deepEqual(held, { trail: [{ do: "action", action: "skipped", reason: "concurrency cap", wait: true }], action: "skipped", reason: "concurrency cap", wait: true });
  assert.equal(laneAnswer("start_counts", rows, { facts: { stage: "planner", sessions: [{ idd_id: LANE }] } }).running, 1);
  assert.deepEqual(startCountsReference(rows, { stage: "planner", sessions: [{ idd_id: LANE }] }), { running: 1 });
  // the lane's own s1_ready ends the planner's session: its slot is free again
  const freed = [row("lane_open"), row("s1_ready")];
  assert.equal(laneAnswer("start_counts", freed, { facts: { stage: "planner", sessions: [{ idd_id: LANE }] } }).running, 0);
  assert.deepEqual(startCountsReference(freed, { stage: "planner", sessions: [{ idd_id: LANE }] }), { running: 0 });
});

test("AC-002: a session the record does not carry is no slot at all", () => {
  const rows = [row("lane_open")];
  const facts = { stage: "planner", sessions: [{ idd_id: "" }, { kind: "" }] };
  assert.deepEqual(laneAnswer("start_counts", rows, { facts }), { running: 0 });
  assert.deepEqual(startCountsReference(rows, facts), { running: 0 });
});

test("AC-002: a worktree that cannot be made holds the lane back, and the place's reason is the skip's", () => {
  const facts = factsOf({
    "call|ensure_worktree|prep": { error: "容量が足りません", hold: "storage が埋まっています" },
  });
  const answer = both("start_prep", startPrepReference, [row("lane_open")], facts);
  assert.equal(answer.action, "skipped");
  assert.equal(answer.reason, "storage が埋まっています");
  assert.equal(answer.wait, true, "the stage itself answers that a held place is a wait");
  const plain = both("start_prep", startPrepReference, [row("lane_open")], factsOf({ "call|ensure_worktree|prep": { error: "boom" } }));
  assert.equal(plain.reason, "worktree: boom");
  assert.equal(plain.wait, undefined, "a worktree that failed is a failure, not a wait");
});

test("AC-003: the executor's start spawns, writes the start, and takes the session back when it is refused", () => {
  const facts = factsOf({
    "call|transition_refusal|s2_start": {},
    "call|ensure_worktree|exec": { path: "/w" },
    "call|read_contract|exec": {},
    "call|commit_records|exec": {},
    "call|spawn|exec": { sessionId: "S" },
    "call|write_start|exec": { reason: "lane が中断されました" },
    "call|discard_session|exec": { left: "（session を畳みました）" },
  });
  const answer = both("start_exec", startExecReference, [row("lane_open")], facts);
  assert.deepEqual(helpers(answer.trail), [
    "transition_refusal|s2_start", "ensure_worktree|exec", "read_contract|exec", "commit_records|exec",
    "spawn|exec", "write_start|exec", "discard_session|exec",
  ]);
  assert.deepEqual(writes(answer.trail), []);
  assert.equal(answer.action, "skipped");
  assert.equal(answer.reason, "s2_start: lane が中断されました（session を畳みました）");
  // nothing of the lane's is left behind: no record of a start the ledger does not hold
  assert.deepEqual(answer.trail.filter((step) => step.do === "write"), []);
});

test("AC-003: a start the lane's own gate refused is skipped before anything is made", () => {
  const answer = both("start_exec", startExecReference, [row("lane_open")], factsOf({
    "call|transition_refusal|s2_start": { reason: "差し戻しの指示が届いています" },
  }));
  assert.deepEqual(helpers(answer.trail), ["transition_refusal|s2_start"]);
  assert.equal(answer.reason, "s2_start: 差し戻しの指示が届いています");
});

test("AC-002: a v2 lane writes its plan records before the executor starts", () => {
  const rows = [row("lane_open"), row("s1_ready", { records_shape: "state", plan_records: { choices: 1 } })];
  const answer = both("start_exec", startExecReference, rows, factsOf({
    "call|transition_refusal|s2_start": {},
    "call|ensure_worktree|exec": { path: "/w" },
    "call|write_plan_records|exec": { ok: true, done: true, attrs: { choices: 1 } },
  }));
  assert.deepEqual(writes(answer.trail), ["s2_plan_written"]);
  assert.deepEqual(answer.trail.find((step) => step.do === "write").attrs, { choices: 1 });
});

test("AC-002: a contract that is empty skips the executor before any session", () => {
  const answer = both("start_exec", startExecReference, [row("lane_open")], factsOf({
    "call|transition_refusal|s2_start": {},
    "call|ensure_worktree|exec": { path: "/w" },
    "call|read_contract|exec": { empty: true },
  }));
  assert.deepEqual(helpers(answer.trail), ["transition_refusal|s2_start", "ensure_worktree|exec", "read_contract|exec"]);
  assert.equal(answer.reason, "contract is empty");
});

test("AC-005: a lane whose removing was asked for is left alone by its plan review", () => {
  const answer = both("start_plan_review", startPlanReviewReference, [...atPlanReview(), row("lane_close")], factsOf());
  assert.deepEqual(answer, { trail: [{ do: "action", action: "none" }], action: "none" });
});

test("AC-002: a plan review whose runs all failed writes the runs and finishes, never blocking the GO", () => {
  const facts = factsOf({
    "call|run_status|R1": { state: "failed", error: "boom" },
    "call|run_status|R2": { state: "failed", error: "bang" },
  });
  const answer = both("start_plan_review", startPlanReviewReference, atPlanReview(), facts);
  assert.deepEqual(helpers(answer.trail), ["run_status|R1", "run_status|R2"]);
  assert.deepEqual(writes(answer.trail), ["s1_plan_review_done"]);
  assert.deepEqual(answer.trail[2].attrs, {
    run_ids: ["R1", "R2"], failed: true, error: "pa: boom / m: bang",
    runs: [
      { run_id: "R1", role: "pa", failed: true, error: "boom" },
      { run_id: "R2", model: "m", failed: true, error: "bang" },
    ],
  });
  assert.equal(answer.action, "finished");
});

test("AC-002: the finished runs' findings are counted, named by their run, and a must opens the send-back", () => {
  const rows = [row("lane_open"), row("s1_ready", { records_shape: "state" }), row("s1_plan_review_started", {
    run_ids: ["R1", "R2"],
    runs: [{ run_id: "R1", role: "pa" }, { run_id: "R2", role: "pa" }],
  })];
  const facts = factsOf({
    "call|run_status|R1": { state: "done", findings: [{ severity: "must", claim: "c", path: "a.ts" }, { severity: "nit", claim: "d" }], reportMd: "/r1.md", fallbacks: [{ role: "pa" }] },
    "call|run_status|R2": { state: "done", findings: [{ severity: "should", claim: "e", source: "自分の名" }], reportMd: "/r2.md" },
    "call|merge_findings|review": { findings: [
      { severity: "must", claim: "c", path: "a.ts" },
      { severity: "nit", claim: "d" },
      { severity: "should", claim: "e", source: "自分の名" },
    ] },
    "call|has_plan|review": { hasPlan: true },
  });
  const answer = both("start_plan_review", startPlanReviewReference, rows, facts);
  assert.deepEqual(helpers(answer.trail), ["run_status|R1", "run_status|R2", "merge_findings|review", "has_plan|review", "queue_envelope|review"]);
  // a role run by more than one model is named by both, so a finding is traceable to its run
  assert.deepEqual(answer.trail[2].args.lists, [[
    { severity: "must", claim: "c", path: "a.ts", source: "pa" },
    { severity: "nit", claim: "d", source: "pa" },
  ], [{ severity: "should", claim: "e", source: "自分の名" }]]);
  const done = answer.trail.find((step) => step.do === "write");
  assert.equal(done.attrs.must, 1);
  assert.equal(done.attrs.should, 1);
  assert.equal(done.attrs.nit, 1);
  assert.equal(done.attrs.sent_back, true);
  assert.deepEqual(done.attrs.reports, [{ role: "pa", report_md: "/r1.md" }, { role: "pa", report_md: "/r2.md" }]);
  assert.deepEqual(done.attrs.runs.map((run) => [run.run_id, run.must, run.should, run.nit]), [["R1", 1, 0, 1], ["R2", 0, 1, 0]]);
  assert.deepEqual(done.attrs.findings, [
    { severity: "must", path: "a.ts", claim: "c" },
    { severity: "nit", path: null, claim: "d" },
    { severity: "should", path: null, claim: "e", source: "自分の名" },
  ]);
  assert.equal(done.attrs.fallbacks.length, 1);
  const sent = answer.trail.find((step) => step.helper === "queue_envelope");
  assert.equal(sent.args.hasPlan, true);
  assert.equal(answer.action, "finished");
});

/** a deep lane's review: one reviewer and the shape judge, each its own run */
const withShapeJudge = (extra = {}) => [
  row("lane_open"), row("s1_ready", { records_shape: "state" }),
  row("s1_plan_review_started", {
    run_ids: ["R1", "S1"],
    runs: [{ run_id: "R1", role: "pa" }, { run_id: "S1", role: "shape-judge", model: "k", shape: true }],
    ...extra,
  }),
];

/** the review's single write, over the runs' statuses and the findings the merge answers (none: the merge is never reached) */
function shapeReview(rows, runs, merged) {
  const facts = { "call|merge_findings|review": { findings: merged }, "call|has_plan|review": { hasPlan: true } };
  const answer = both("start_plan_review", startPlanReviewReference, rows, factsOf({
    ...Object.fromEntries(Object.entries(runs).map(([id, status]) => [`call|run_status|${id}`, status])),
    ...(merged ? facts : {}),
  }));
  return { answer, done: answer.trail.find((step) => step.do === "write") };
}

const MUST = { severity: "must", claim: "c", path: "a.ts" };
const reviewed = (findings) => ({ state: "done", findings, reportMd: "/r1.md" });
const NO_SLOT = { state: "failed", error: "枠が無い" };

test("AC-001: a shape judge that failed is not covered by the reviewer that finished", () => {
  const should = { severity: "should", claim: "e", path: "a.ts" };
  const { done } = shapeReview(withShapeJudge(), { R1: reviewed([should]), S1: NO_SLOT }, [{ ...should, source: "pa" }]);
  assert.equal(done.attrs.failed, true);
  assert.equal(done.attrs.error, "形の判断が走り切れなかった: shape-judge: 枠が無い");
  assert.equal(done.attrs.failed_runs, 1);
  assert.equal(done.attrs.should, 1);
  assert.deepEqual(done.attrs.runs.map((run) => [run.run_id, run.shape === true]), [["R1", false], ["S1", true]]);
});

test("AC-001: a shape judge that never started counts as a shape judge that failed", () => {
  const rows = withShapeJudge({
    run_ids: ["R1"], runs: [{ run_id: "R1", role: "pa" }],
    start_failed: [{ role: "shape-judge", model: "k", error: "起動できない", shape: true }],
  });
  const { done } = shapeReview(rows, { R1: reviewed([]) }, []);
  assert.equal(done.attrs.failed, true);
  assert.equal(done.attrs.error, "形の判断が走り切れなかった: shape-judge: 起動できない");
});

test("AC-001: a plan sent back is reviewed again, so a shape judge that failed beside a must is not recorded as the review's failure", () => {
  const { done } = shapeReview(withShapeJudge(), { R1: reviewed([MUST]), S1: NO_SLOT }, [{ ...MUST, source: "pa" }]);
  assert.equal(done.attrs.failed, undefined);
  assert.equal(done.attrs.sent_back, true);
  assert.equal(done.attrs.failed_runs, 1);
});

test("AC-001: a reviewer that failed is not covered by the shape judge that finished", () => {
  const { answer, done } = shapeReview(withShapeJudge(), { R1: { state: "failed", error: "boom" }, S1: { ...reviewed([MUST]), reportMd: "/s1.md" } });
  assert.deepEqual(writes(answer.trail), ["s1_plan_review_done"]);
  assert.equal(done.attrs.failed, true);
  assert.equal(done.attrs.error, "pa: boom");
  assert.equal(answer.action, "finished");
});

test("AC-002: a run still answering leaves the lane where it is", () => {
  const answer = both("start_plan_review", startPlanReviewReference, atPlanReview(), factsOf({
    "call|run_status|R1": { state: "running" },
  }));
  assert.deepEqual(helpers(answer.trail), ["run_status|R1"]);
  assert.deepEqual(answer, { trail: [{ do: "call", helper: "run_status", site: "R1", fact: "call|run_status|R1", keep: null, args: { runId: "R1" }, fatal: false }, { do: "action", action: "waiting" }], action: "waiting" });
});

test("AC-002: a plan review that cannot start leaves a failure that never blocks the GO", () => {
  const rows = [row("lane_open"), row("s1_ready", { records_shape: "state" })];
  const answer = both("start_plan_review", startPlanReviewReference, rows, factsOf({
    "call|planner_worktree|start": { path: "/w" },
    "call|start_runs|start": { error: "runner が落ちた" },
  }));
  assert.deepEqual(writes(answer.trail), ["s1_plan_review_done"]);
  assert.deepEqual(answer.trail.at(-2).attrs, { failed: true, error: "runner が落ちた" });
  assert.equal(answer.action, "error");
  assert.equal(answer.error, "runner が落ちた");
});

test("AC-002: a plan review waits for its slot, and one the pipeline never declared is skipped", () => {
  const rows = [row("lane_open"), row("s1_ready", { records_shape: "state" })];
  assert.deepEqual(both("start_plan_review", startPlanReviewReference, rows, factsOf({ runnerStart: false })), { trail: [{ do: "action", action: "waiting" }], action: "waiting" });
  const skipped = both("start_plan_review", startPlanReviewReference, rows, factsOf({ declared: false }));
  assert.deepEqual(writes(skipped.trail), ["s1_plan_review_skipped"]);
  assert.equal(skipped.action, "skipped");
});

test("AC-006: the skip of a review nobody declared is written once for the ready a must's fix came back under, and ends the review", () => {
  const ready = row("s1_ready", { records_shape: "state" });
  const done = row("s1_plan_review_done", { must: 1, should: 0, nit: 0, sent_back: true });
  const afterMust = [row("lane_open"), ready, row("s1_plan_review_started", { run_ids: ["R1"] }), done, ready];
  const atMust = (rows) => both("start_plan_review", startPlanReviewReference, rows, factsOf({ declared: false }));
  assert.deepEqual(writes(atMust(afterMust).trail), ["s1_plan_review_skipped"]);
  // the skip ends the review (the card opens for a reason), so no tick waits on the slot or writes it again
  const afterSkip = atMust([...afterMust, row("s1_plan_review_skipped", { reason: "r" })]);
  assert.equal(afterSkip.action, "none");
  assert.deepEqual(writes(afterSkip.trail), []);
});

test("AC-004/AC-006: only the waits (a replacement, the cap) carry the stage's own wait answer; a refusal does not", () => {
  const go = [row("lane_open"), row("s1_ready"), row("s1_go")];
  const full = { limit: 1, sessions: [{ idd_id: "IDD-X", kind: "executor" }], sessionShape: "state" };
  const cases = [
    ["start_prep", startPrepReference, factsOf({ hold: "engine を入れ替えています" }), "engine を入れ替えています", true],
    ["start_exec", startExecReference, factsOf(full), "concurrency cap", true],
    ["start_prep", startPrepReference, factsOf({ runner: false }), "no runner", undefined],
  ];
  for (const [op, reference, facts, reason, wait] of cases) {
    const answer = both(op, reference, go, facts);
    assert.deepEqual([answer.reason, answer.wait], [reason, wait]);
  }
});

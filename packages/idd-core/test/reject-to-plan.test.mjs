import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { backlogRow, cleanReview, ev, laneEvents, openState, reviewedPlan, round, sessionRow, stopped, writeRows } from "./helpers/lane-ledger.mjs";
import { transitionRefusal } from "../src/ledger/allowed.ts";
import { deriveStage, planReviewMustUnconfirmed, planReviewPhase, replanView, returnsToPlan, roundTrace } from "../src/ledger/derive.ts";
import { deriveStageReference } from "../src/ledger/derive-reference.ts";
import { laneAnswer } from "../src/intent/moonbit-fold.ts";
import { reviewLoopState } from "../src/ledger/review-loop.ts";
import { fixRoundStarts } from "../src/ledger/stage-spans.ts";
import { laneStageSpans } from "../src/ledger/stages.ts";
import { awaitedAgent, isExecutorWork } from "../src/plan/watch.ts";
import { applyDecision } from "../src/ledger/write.ts";
import { fixEnvelopeId } from "../src/plan/review-loop.ts";
import { planReviewsOf, replanCycleOf } from "../src/plan/shape-judge.ts";
import { currentExecutorSessions, lanesAwaitingExec, runningExecutors } from "../src/plan/exec.ts";
import { agentHold } from "../src/agent/inbound.ts";
import * as reference from "../src/ledger/turn-reference.ts";
import { replannedReady } from "./helpers/lane-ledger.mjs";

/**
 * The review card's "方針へ戻す" is a `s3_reject` that records the plan as where the lane goes (`next_stage` is
 * `s1_rethink`): the stage, the turn, the envelope and the rounds' count all read that one field. A rejection that
 * records the implementation (`s2_retry`), or no place at all (an old row), reads as it always did.
 */

/** a lane whose review loop converged and whose S3 card is up: one fix round behind it */
const atReview = () => [
  ...reviewedPlan(),
  ...round(1, ["a.ts"], "a.ts", "x"),
  ev("s2_fix_sent", { round: 1 }),
  ev("s2_result", { outcome: "success", changed_files: ["a.ts"] }),
  ev("s2_review_converged"),
  ev("s3_ready"),
];

/** a lane outside the review loop (no review event), whose S3 card is the review's own: the card that asks for a decision */
const answeredAt = () => [ev("s2_result", { outcome: "success", changed_files: ["a.ts"] }), ev("s3_ready")];
const atLegacyReview = () => [...reviewedPlan(), ...answeredAt()];

/** the lane after the card's rejection; `nextStage` is what the row records, none for an old row that names no place */
const rejectedFrom = (base, nextStage) => [...base, ev("s3_reject", { reason: "r", feedback: "r", ...(nextStage ? { next_stage: nextStage } : {}) })];
const rejected = (nextStage, at = atReview) => rejectedFrom(at(), nextStage);

const toPlan = (at = atReview) => rejected("s1_rethink", at);

/** the plan sent again and its review begun */
const resent = () => [ev("s1_ready", { depth: "deep" }), ev("s1_plan_review_started", { run_ids: ["P2"] })];

/** the plan sent again, reviewed clean, GO'd and started: the way back to the executor's work */
const reviewedGoStart = () => [...resent(), cleanReview(), ev("s1_go"), ev("s2_start", { started_from_commit: "c1" })];

/** both shapes of a lane that can be rejected at S3: inside the review loop and outside it */
const SHAPES = [["in the review loop", atReview], ["outside the review loop", atLegacyReview]];

/** the stage a lane stands at, without the fields a test has no use for */
const standing = (events) => {
  const d = deriveStage(events);
  return { group: d.group, stageDone: d.stageDone, decision: d.decision, blockedBy: d.blockedBy };
};

test("AC-001: the card outside the review loop asks for a decision, and a lane in the loop is preparing its submit", () => {
  assert.equal(standing(atLegacyReview()).decision, "review");
  assert.equal(standing(atReview()).stageDone, 3);
});

for (const [shape, at] of SHAPES) test(`AC-001: a rejection that records the plan takes the lane (${shape}) to its first stage, and waits on the planner`, () => {
  const base = at();
  const lane = rejectedFrom(base, "s1_rethink");
  const stage = deriveStage(lane);
  assert.deepEqual([stage.group, stage.stageDone, stage.decision], ["prep", 1, undefined]);
  // the plan is sent back and the loop idle; the planner owes the plan and the executor nothing; the time figure reads the
  // plan's stretch again; the rejection hands the executor no work
  assert.deepEqual(
    [planReviewPhase(lane), reviewLoopState(lane).state, awaitedAgent(lane)?.role, laneStageSpans(lane).at(-1).key, isExecutorWork(lane.at(-1))],
    [{ phase: "sent_back" }, "idle", "planner", "plan", false],
  );
  // it begins no fix round, and the ledger keeps every earlier row
  assert.deepEqual(fixRoundStarts(lane), fixRoundStarts(base));
  // the ledger keeps every earlier row
  assert.deepEqual(lane.slice(0, -1), base);
});

test("AC-001: the lane's stage is the same answer from the fold and from the reference at every prefix", () => {
  const lane = [...toPlan(), ...reviewedGoStart()];
  for (let n = 1; n <= lane.length; n += 1) {
    const prefix = lane.slice(0, n);
    assert.deepEqual(JSON.parse(JSON.stringify(laneAnswer("stage", prefix))), JSON.parse(JSON.stringify(deriveStageReference(prefix))), `${n} 行目までで段が食い違いました`);
  }
});

/** the card's "計画から考え直す", for a lane that stands at the same review */
const replanned = (at = atReview) => [...at(), ev("s1_replan_requested", { rounds: 1 })];

/** the plan sent again, asked about, reviewed, GO'd and started, after each way back to the plan */
const SENT_AGAIN = [
  ev("question_batch_asked", { batch_id: "q-a" }),
  ev("question_batch_answered", { batch_id: "q-a" }),
  ...reviewedGoStart(),
  ev("question_batch_asked", { batch_id: "q-b" }),
];

const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

for (const [way, back] of [["a rejection to the plan", toPlan], ["the card's replan", replanned]]) {
  for (const [shape, at] of SHAPES) test(`AC-001 / AC-003: the turn and the waits are the same answer from the fold and from the reference at every prefix (${way}, ${shape})`, () => {
    const lane = [...back(at), ...SENT_AGAIN];
    for (let n = 1; n <= lane.length; n += 1) {
      const prefix = lane.slice(0, n);
      const where = `${n} 行目までで`;
      for (const facts of [{}, { pendingEnvelope: false, cardBuildable: true, awaitedAgent: null }]) {
        assert.deepEqual(plain(laneAnswer("lane_turn", prefix, facts)), plain(reference.laneTurnReference(prefix, facts)), `${where}番が食い違いました`);
      }
      assert.deepEqual(plain(laneAnswer("awaited_agent", prefix)), plain(reference.awaitedAgentReference(prefix, { mode: "record", now: 0 })), `${where}待つ agent が食い違いました`);
      assert.deepEqual(plain(laneAnswer("awaiting_question", prefix)), plain(reference.awaitingQuestionReference(prefix, { mode: "record", now: 0 })), `${where}答えの無い質問が食い違いました`);
      for (const event of ["s1_go", "s2_start", "s1_revise_requested", "s1_replan_requested", "s4_submit_started"]) {
        assert.equal(laneAnswer("transition_refusal", prefix, { event }), reference.transitionRefusalReference(event, prefix), `${where}${event} の断りが食い違いました`);
      }
    }
  });
}

test("AC-001: after a rejection to the plan the reference waits on the planner, and the executor's old start does not turn the wait to the executor", () => {
  const lane = toPlan();
  const quota = { mode: "record", now: 0 };
  assert.deepEqual(reference.awaitedAgentReference(lane, quota), { role: "planner", since: lane.length - 1 });
  assert.equal(reference.laneTurnReference([...lane, ev("s1_ready", { depth: "deep" }), ev("s1_plan_review_started", { run_ids: ["P2"] })]), "agent");
});

for (const [shape, at] of SHAPES) test(`AC-005: a rejection that records the implementation, or no place, keeps the lane in its implementation (${shape})`, () => {
  const base = at();
  for (const nextStage of ["s2_retry", undefined, "something-else"]) {
    const lane = rejectedFrom(base, nextStage);
    assert.equal(returnsToPlan(lane.at(-1)), false);
    assert.equal(replanView(lane), lane);
    assert.equal(awaitedAgent(lane)?.role, "executor", String(nextStage));
    assert.equal(isExecutorWork(lane.at(-1)), true);
    assert.equal(planReviewPhase(lane).phase, "none");
    assert.equal(laneStageSpans(lane).at(-1).key, "impl");
    // the rejection begins a fix round, and the rounds keep their cycle
    assert.equal(fixRoundStarts(lane).length, fixRoundStarts(base).length + 1);
    assert.equal(replanCycleOf(lane), 0);
    assert.equal(fixEnvelopeId("IDD-1", 1, lane.filter(returnsToPlan).length), "fix-IDD-1-r1");
  }
  // an old row (no `attrs` at all) reads the same
  const bare = [...base, { event: "s3_reject", idd_id: "IDD-1", at: "2026-10-01T09:00:00Z" }];
  assert.equal(returnsToPlan(bare.at(-1)), false);
  assert.equal(awaitedAgent(bare)?.role, "executor");
});

test("AC-003: the plan sent again goes through the review and the GO before the executor starts anew", () => {
  const [ready, started] = resent();
  // [rows the planner and the review add, the phase they leave, whether the GO card is up]
  const steps = [[[ready], "waiting", false], [[ready, started], "running", false], [[ready, started, cleanReview()], "reviewed", true]];
  for (const [rows, phase, goUp] of steps) {
    const lane = [...toPlan(), ...rows];
    assert.equal(planReviewPhase(lane).phase, phase);
    assert.equal(deriveStage(lane).decision === "go", goUp);
    // the GO is taken only at the card, and the executor's start only after the GO
    assert.equal(transitionRefusal("s1_go", lane) === null, goUp);
    assert.equal(typeof transitionRefusal("s2_start", lane), "string");
  }
  // the first plan's GO is not this plan's: the start is taken only after the GO of the plan sent again
  const goneThrough = [...toPlan(), ready, started, cleanReview(), ev("s1_go")];
  assert.equal(replanView(goneThrough).filter((e) => e.event === "s1_go").length, 1);
  assert.equal(transitionRefusal("s2_start", goneThrough), null);
});

test("AC-003: the review and the GO read the same after a rejection to the plan as after the card's replan", () => {
  // the two returns differ in the row that sends the lane back, and in nothing the readings decide with
  const tail = [...resent(), ev("s1_plan_review_done", { must: 1, should: 0, nit: 0 })];
  const viaReject = [...toPlan(), ...tail];
  const viaReplan = [...atReview(), ev("s1_replan_requested", { rounds: 1 }), ...tail];
  for (const read of [planReviewPhase, standing, planReviewMustUnconfirmed, planReviewsOf]) assert.deepEqual(read(viaReject), read(viaReplan));
  // a review before the return is not counted for the plan sent again
  assert.equal(planReviewsOf(viaReject), 1);
  assert.equal(planReviewsOf([...replannedReady(), cleanReview()]), 1);
});

test("AC-004: the rounds after a rejection to the plan are numbered from 1 again", () => {
  // the lines before the return are the lane's own (the loop's stop holds two); the new plan's first round is cycle 1, round 1
  const lanes = [toPlan(), rejectedFrom(stopped(), "s1_rethink")].map((base) => [base, [...base, ...reviewedGoStart(), ...round(1, ["b.ts"], "b.ts", "z")]]);
  for (const [base, after] of lanes) assert.deepEqual(roundTrace(after).map((l) => [l.cycle, l.round]), [...roundTrace(base).map((l) => [l.cycle, l.round]), [1, 1]]);
  const lane = lanes[0][1];
  assert.deepEqual(roundTrace(lane).slice(0, 1), roundTrace(atReview()));
  assert.equal(replanCycleOf(lane), 1);
  // a second return numbers the next cycle, and the fix envelope of the new round 1 names neither earlier one
  const again = [...lane, ev("s2_review_converged"), ev("s3_ready"), ev("s3_reject", { next_stage: "s1_rethink" }), ev("s1_ready", { depth: "deep" })];
  assert.equal(replanCycleOf(again), 2);
  assert.notEqual(fixEnvelopeId("IDD-1", 1, again.filter(returnsToPlan).length), fixEnvelopeId("IDD-1", 1, lane.filter(returnsToPlan).length));
  // a rejection to the implementation moves no cycle
  const same = [...atReview(), ev("s3_reject", { next_stage: "s2_retry" }), ...round(2, ["a.ts"], "a.ts", "w")];
  assert.deepEqual(roundTrace(same).map((l) => l.cycle), [0, 0]);
});

test("AC-001: the executor sessions of the implementation the lane left do not stand for a start", () => {
  const state = openState("reject-to-plan-", [...toPlan(), ...reviewedGoStart().slice(0, -1)]).state;
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"));
  assert.deepEqual(lanesAwaitingExec().map((l) => l.idd_id), ["IDD-1"], "the new GO starts a new executor");
  assert.equal(runningExecutors(), 0);
  assert.deepEqual(currentExecutorSessions(laneEvents()).map((r) => r.idd_id), []);
});

/** a state directory holding the lane at its S3 card, with the sessions of both roles on record */
function cardUp(events = atReview()) {
  const state = openState("reject-to-plan-", events).state;
  writeRows(state, "backlog.jsonl", backlogRow);
  writeRows(state, "planner-sessions.jsonl", sessionRow("planner", "P1", "2026-09-30T00:00:00Z"));
  writeRows(state, "executor-sessions.jsonl", sessionRow("executor", "E1", "2026-10-01T00:05:00Z"));
  return state;
}

/** the text of a queued envelope */
const envelopeOf = (state, id) => readFileSync(join(state, "outbox", `${id}.xml`), "utf8");

/** the outbox rows the card's press queued */
function queued(state) {
  const file = join(state, "outbox.jsonl");
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("AC-001 / AC-002: the press that records the plan writes one row, and one envelope reaches the planner with the instruction and the rounds", async () => {
  // the card that offers the press is the one a lane outside the review loop stands at (a loop lane has no round once it is
  // at a card: it prepares its submit, and the press is refused there)
  const { state, done, before } = await pressedAt(atLegacyReview(), "review", "方針が違う: <別の形>");
  const written = laneEvents();
  assert.equal(written.length, before + 1);
  const { event, attrs } = written.at(-1);
  assert.deepEqual([event, attrs.next_stage, attrs.feedback], ["s3_reject", "s1_rethink", "方針が違う: <別の形>"]);
  // the lane's stage, the turn and the card's reading all follow that row
  assert.equal(deriveStage(written).group, "prep");
  assert.equal(awaitedAgent(written)?.role, "planner");
  // one envelope, for the planner, with the instruction and the lane's rounds
  const rows = queued(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "s1_replan");
  assert.equal(rows[0].envelope_id, done.envelopeId);
  const envelope = envelopeOf(state, done.envelopeId);
  assert.ok(envelope.includes("<instruction>方針が違う: &lt;別の形&gt;</instruction>"), envelope);
  assert.ok(envelope.includes("<rounds>"), envelope);
  // the planner's type: the delivery of an `s1_replan` envelope to the planner's session is held by replan.test.mjs
});

test("AC-005: the press that records the implementation, or none, writes the row and the envelope it always did", async () => {
  for (const payload of [{ nextStage: "s2_retry" }, {}, { nextStage: "unheard-of" }]) {
    const state = cardUp();
    const done = await applyDecision("s3_reject", { iddId: "IDD-1", feedback: "直す", ...payload });
    assert.equal(done.ok, true, done.error);
    const row = laneEvents().at(-1);
    assert.deepEqual([row.event, row.attrs], ["s3_reject", { reason: "直す", next_stage: "s2_retry", feedback: "直す" }]);
    assert.deepEqual(queued(state).map((r) => r.type), ["lane_rejected"]);
    assert.ok(envelopeOf(state, done.envelopeId).includes("<instruction>直す</instruction>"));
    assert.deepEqual([deriveStage(laneEvents()).group, awaitedAgent(laneEvents())?.role], ["impl", "executor"]);
  }
});

/** the card's "方針へ戻す" press */
const pressToPlan = (feedback) => applyDecision("s3_reject", { iddId: "IDD-1", nextStage: "s1_rethink", feedback });

/** a state with the lane at a card of the `decision` kind, and the press back to the plan taken there */
async function pressedAt(events, decision, feedback) {
  const state = cardUp(events);
  assert.equal(deriveStage(laneEvents()).decision, decision);
  const before = laneEvents().length;
  const done = await pressToPlan(feedback);
  assert.equal(done.ok, true, done.error);
  return { state, done, before };
}

/** the outbox rows a refused press left: none, with or without the file */
const queuedRows = (state) => { try { return queued(state); } catch { return []; } };

/** the lanes a press back to the plan must not reach: closed, already back at the plan, waiting at the GO */
const NOT_AT_REVIEW = [
  ["a closed lane", () => [...atReview(), ev("s3_reject", { reason: "r", feedback: "r", next_stage: "s2_retry" }), ev("lane_close", { reason: "done" })]],
  ["a lane already back at its plan", () => toPlan()],
  ["a loop lane preparing its submit, where no card is up", () => atReview()],
  ["a lane whose executor was sent back to fix and has not answered", () => rejectedFrom(atLegacyReview(), "s2_retry")],
  ["a lane waiting at the GO", () => [...reviewedPlan().slice(0, -1), ev("s1_ready", { depth: "deep" }), ev("s1_plan_review_started", { run_ids: ["P2"] }), cleanReview()]],
];

for (const [name, at] of NOT_AT_REVIEW) test(`AC-001: a press back to the plan on ${name} refuses, and writes no row and no envelope`, async () => {
  const state = cardUp(at());
  const before = laneEvents();
  const refusal = await pressToPlan("方針が違う");
  assert.deepEqual([refusal.ok, typeof refusal.error], [false, "string"]);
  // nothing moved: the same rows, no envelope, the same group
  assert.deepEqual([laneEvents().length, queuedRows(state).length, deriveStage(laneEvents()).group], [before.length, 0, deriveStage(before).group]);
});

test("AC-001: the executor's hold on a lane back at its plan does not write a result for the executor", async () => {
  const lane = toPlan();
  cardUp(lane);
  const before = laneEvents().length;
  const held = await agentHold({ iddId: "IDD-1", kind: "push" });
  assert.equal(held.ok, true, JSON.stringify(held));
  // a rejection that sent the lane to the plan hands the executor no work, so no result is owed and none is written for it
  assert.equal(laneEvents().length, before);
  assert.equal(laneEvents().some((e, i) => i >= before && e.event === "s2_result"), false);
});

test("AC-001: the lane takes the press back to the plan again once the executor has answered the fix it was sent", async () => {
  // the card stays up while the executor works; it takes the press only after the result and a new request for the decision
  const state = cardUp([...rejectedFrom(atLegacyReview(), "s2_retry"), ...answeredAt()]);
  const done = await pressToPlan("方針が違う");
  assert.deepEqual([done.ok, queued(state).map((r) => r.type)], [true, ["s1_replan"]]);
});

test("AC-001 / AC-002: the loop's stop takes the press back to the plan, with the rounds it recorded, and a stale press refuses", async () => {
  const { state, done, before } = await pressedAt(stopped(), "stuck", "割り方が違う");
  assert.deepEqual([deriveStage(laneEvents()).group, awaitedAgent(laneEvents())?.role, queued(state).map((r) => r.type)], ["prep", "planner", ["s1_replan"]]);
  // the instruction, the loop's own reason for the return, and the rounds the loop recorded: each one's number and the file it named
  const envelope = envelopeOf(state, done.envelopeId);
  assert.ok(envelope.includes("<instruction>割り方が違う</instruction>") && envelope.includes("実装の巡が収束しなかった"), envelope);
  assert.deepEqual([...envelope.matchAll(/<round n="(\d+)" cycle="0"[^>]*>([^<]*)<\/round>/g)].map((m) => m.slice(1)), [["1", "a.ts"], ["2", "b.ts"]]);
  // a stale press finds the lane no longer stopped, and writes nothing
  assert.equal((await pressToPlan("割り方が違う")).ok, false);
  assert.deepEqual([laneEvents().length, queued(state).length], [before + 1, 1]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { laneTurn, turnSince } from '../src/ledger/turn.ts';
import { deriveStage } from '../src/ledger/derive.ts';

const AT = (m) => new Date(Date.UTC(2026, 8, 26, 3, 0, 0) + m * 60_000).toISOString();
const ev = (event, m = 0, attrs = {}) => ({ event, idd_id: 'IDD-1', at: AT(m), attrs });

// lanes that reached the review loop: from here every row starts
const reachedLoop = [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), ev('s2_result', 3), ev('s2_review_converged', 4), ev('s2_device_skipped', 5), ev('s3_ready', 6)];
const preShip = [...reachedLoop, ev('s3_ok', 7), ev('s4_submit_started', 8)];

test('every place a lane can stand maps to one turn', () => {
  const rows = [
    ['下調べ中（planner が動いている）', [ev('lane_open', 0)], { awaitedAgent: { role: 'planner' } }, 'agent'],
    ['質問待ち', [ev('lane_open', 0), ev('question_batch_asked', 1)], {}, 'penne'],
    ['plan の査読中', [ev('lane_open', 0), ev('s1_ready', 1), ev('s1_plan_review_started', 2)], {}, 'agent'],
    ['plan の査読待ち', [ev('lane_open', 0), ev('s1_ready', 1)], { awaitedAgent: { role: 'planner' } }, 'agent'],
    ['GO 待ち', [ev('lane_open', 0), ev('s1_ready', 1), ev('s1_plan_review_done', 2, { must: 0, should: 0 })], {}, 'penne'],
    ['実装中（executor が動いている）', [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2)], { awaitedAgent: { role: 'executor' } }, 'agent'],
    ['レビュー中', [...reachedLoop.slice(0, 4), ev('s2_review_started', 4, { kind: 'blind', round: 1, run_ids: ['b'] })], {}, 'agent'],
    ['順番待ち', [...reachedLoop.slice(0, 4), ev('s2_order_waiting', 4, { opponents: [] })], {}, 'lane'],
    ['依存待ち', [ev('lane_open', 0), ev('blocked_by_dependency', 1)], {}, 'lane'],
    ['提出の準備中', reachedLoop, {}, 'engine'],
    // an R2 start left by a lane from before R2 was removed (2026-10-22): no run answers it, so the engine prepares the submit
    ['R2 の始まりだけが残った', [...reachedLoop, ev('s3_r2_started', 7, { run_id: 'r' })], {}, 'engine'],
    ['提出の card', preShip, {}, 'penne'],
    ['PR 待ち', [...preShip, ev('s4_pr_created', 9, { pr_number: 3 })], {}, 'outside'],
    ['回収待ち', [...preShip, ev('s4_pr_created', 9, { pr_number: 3 }), ev('s4_merged', 10)], {}, 'outside'],
    ['要判断（判定に失敗）', [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), ev('s2_result', 3), ev('s2_review_started', 4, { kind: 'blind', round: 1, run_ids: ['b'] }), ev('s2_review_findings', 5), ev('s2_triage_started', 6, { kind: 'blind', round: 1, run_id: 't' }), ev('s2_triage_done', 7, { failed: true })], {}, 'penne'],
    ['予算の停止', [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), ev('lane_over_budget', 3, { cost: 6, limit: 5 })], {}, 'penne'],
    ['届いていない封筒', [ev('lane_open', 0)], { pendingEnvelope: true }, 'agent'],
    ['知らない名前で終わる', [ev('lane_open', 0), ev('something_new', 1)], {}, 'engine'],
  ];
  for (const [label, events, facts, want] of rows) assert.equal(laneTurn(events, facts), want, label);
});

test('an unanswered question is penne turn in any stage, and an answer hands the lane back (AC-010)', () => {
  const q = (m, batch = 'b1') => ev('question_batch_asked', m, { batch_id: batch });
  const a = (m, batch = 'b1') => ev('question_batch_answered', m, { batch_id: batch });
  // executor: the question comes after the work was handed to it
  const exec = [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), q(3)];
  assert.equal(laneTurn(exec), 'penne');
  assert.equal(laneTurn([...exec, a(4)]), 'engine');
  // a fix round after the first result still counts
  const fix = [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), ev('s2_result', 3), ev('s2_fix_sent', 4), q(5)];
  assert.equal(laneTurn(fix), 'penne');
  // planner: a question after the plan review sent the plan back
  const planner = [ev('lane_open', 0), ev('s1_ready', 1), ev('s1_plan_review_done', 2, { must: 1, should: 0 }), q(3)];
  assert.equal(deriveStage(planner).group, 'prep');
  assert.equal(laneTurn(planner), 'penne');
  // a batch left over from a stage the lane has left does not change the turn
  const stale = [ev('lane_open', 0), q(1), ev('s1_go', 2), ev('s2_start', 3), ev('s2_result', 4)];
  assert.notEqual(laneTurn(stale), 'penne');
  // a question after the executor's result does not revive the episode: the work boundary is the work handed out
  const late = [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), ev('s2_result', 3), q(4)];
  assert.notEqual(laneTurn(late), 'penne');
  assert.notEqual(laneTurn([ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), ev('s2_result', 3), a(4)]), 'penne');
});

test('a planning lane whose batch was answered is the planner turn; one that asked again or answered one of two is still penne turn', () => {
  const q = (m, batch) => ev('question_batch_asked', m, { batch_id: batch });
  const a = (m, batch) => ev('question_batch_answered', m, { batch_id: batch });
  const answered = [ev('lane_open', 0), q(1, 'b1'), a(2, 'b1')];
  assert.equal(deriveStage(answered).group, 'prep');
  assert.equal(deriveStage(answered).decision, undefined);
  assert.equal(laneTurn(answered, { awaitedAgent: { role: 'planner' } }), 'agent');
  assert.equal(laneTurn(answered), 'engine', 'nobody is on it when the planner is not running');
  const askedAgain = [...answered, q(3, 'b2')];
  assert.equal(deriveStage(askedAgain).decision, 'question');
  assert.equal(laneTurn(askedAgain), 'penne');
  const oneOfTwo = [ev('lane_open', 0), q(1, 'b1'), q(2, 'b2'), a(3, 'b2')];
  assert.equal(deriveStage(oneOfTwo).decision, 'question');
  assert.equal(laneTurn(oneOfTwo), 'penne');
});

test('a closed lane is on nobody turn', () => {
  assert.equal(laneTurn([ev('lane_open', 0), ev('lane_close', 1)]), null);
  assert.equal(laneTurn([ev('lane_open', 0), ev('s1_defer', 1)]), null);
});

test('a ship card that cannot be built is not penne turn', () => {
  assert.equal(laneTurn(preShip, {}), 'penne');
  assert.equal(laneTurn(preShip, { cardBuildable: false }), 'engine');
});

test('every review event as the last record still maps to one turn', async () => {
  const { REVIEW_EVENTS } = await import('../src/ledger/review-loop.ts');
  const base = [ev('lane_open', 0), ev('s1_go', 1), ev('s2_start', 2), ev('s2_result', 3)];
  for (const event of REVIEW_EVENTS) {
    const turn = laneTurn([...base, ev(event, 4)]);
    assert.ok(turn === null || ['agent', 'penne', 'lane', 'outside', 'engine'].includes(turn), `${event} -> ${turn}`);
  }
});

test('a note does not restart the clock; a resume does', () => {
  // the lane stands on the same step since s3_ready (6); the order records do not move it
  const events = [...reachedLoop, ev('s2_order_waiting', 8, { opponents: [] }), ev('s2_order_limit', 9)];
  assert.equal(deriveStage(events).blockedBy, '提出の準備中');
  assert.equal(turnSince(events), AT(6));
  const resumed = [...events, ev('lane_stall_resumed', 10)];
  assert.equal(turnSince(resumed), AT(10));
});

test('the plan records of a delivery do not move the lane or restart its clock (AC-017)', () => {
  const base = [...reachedLoop];
  const plan = [ev('fix_plan_started', 7, { envelope_id: 'E-1', run_id: 'P-1' }), ev('fix_plan_done', 8, { envelope_id: 'E-1', run_id: 'P-1', plan_path: '/tmp/p.md' })];
  const withPlan = [...base, ...plan];
  assert.deepEqual(deriveStage(withPlan), deriveStage(base), 'the stage is the same with the plan records');
  assert.equal(laneTurn(withPlan), laneTurn(base), 'the turn is the same');
  assert.equal(turnSince(withPlan), turnSince(base), 'the plan records do not restart the clock');
  // and a plan record as the very last word still leaves the lane where it stood
  assert.deepEqual(deriveStage([...base, plan[0]]), deriveStage(base));
});

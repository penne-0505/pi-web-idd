import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, laneDurations, stageSpans, STAGE_RULE_VERSION } from '../src/ledger/stage-spans.ts';
import { setAgentRunner } from '../src/agent/port.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (id) => JSON.parse(readFileSync(join(HERE, 'fixtures', `lifecycle-${id}.json`), 'utf8'));

/** the landing approval the overlay reads, stood in for here so the ledger never imports it */
const ctx = { landApproved: (evs) => evs.some((e) => e.event === 's4_land_approved' && e.attrs?.signed === true) };
const round = (n) => Math.round(n * 10) / 10;
const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
const at = (h, m) => `2026-10-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;
const ev = (event, when, attrs = {}) => ({ idd_id: 'IDD-1', event, at: when, attrs });

test("a closed lane's stage lengths follow the split table (AC-001)", () => {
  // IDD-097: one question, one plan review, no fix. The split's values, from the record written out.
  const d = laneDurations(fixture('IDD-097'), ctx);
  assert.equal(round(d.stages.plan), 7.7);
  // 27.3 under rule 3: this lane's planner re-readied after the review's must and the GO followed, with no second review
  assert.equal(round(d.stages.plan_review), 27.8);
  assert.equal(round(d.stages.impl), 16.1);
  assert.equal(round(d.stages.checks), 2.3);
  assert.equal(round(d.stages.land), 0);
  assert.equal(d.fixRounds.length, 0, 'no fix round was sent');
  assert.equal(round(d.stages.review), 25);
  // IDD-092: three fixes sent and two send-backs, five rounds of their own
  const d92 = laneDurations(fixture('IDD-092'), ctx);
  assert.equal(d92.fixRounds.length, 5);
});

test('a question wait is taken out of the plan, once or twice (AC-002)', () => {
  const one = [
    ev('lane_open', at(9, 0)),
    ev('question_batch_asked', at(9, 3), { batch_id: 'b1' }),
    ev('question_batch_answered', at(9, 23), { batch_id: 'b1' }),
    ev('s1_ready', at(9, 28)),
  ];
  assert.equal(round(laneDurations(one, {}).stages.plan), 8, '3 before the question + 5 after the answer');

  const two = [
    ev('lane_open', at(10, 0)),
    ev('question_batch_asked', at(10, 2), { batch_id: 'b1' }),
    ev('question_batch_answered', at(10, 12), { batch_id: 'b1' }),
    ev('question_batch_asked', at(10, 14), { batch_id: 'b2' }),
    ev('question_batch_answered', at(10, 24), { batch_id: 'b2' }),
    ev('s1_ready', at(10, 30)),
  ];
  assert.equal(round(laneDurations(two, {}).stages.plan), 10, 'both waits are out, both work stretches are in');
});

test("the order wait and the cap wait enter no stage's length (AC-003)", () => {
  const events = fixture('IDD-092');
  const d = laneDurations(events, ctx);
  // GO 00:48:59 -> s2_start 01:43:02 is 54 minutes of cap wait: the implementation is 51 minutes, not 105
  assert.equal(round(d.stages.impl), 51);
  // the order wait 02:35:35 -> 05:26:12 is 171 minutes: the first review is 34.7, not 205
  assert.equal(round(d.stages.review), 34.7);
  const order = stageSpans(events, ctx, Date.parse('2026-10-06T15:00:00+09:00')).find((s) => s.kind === 'wait' && s.wait === 'order');
  assert.ok(order, 'the order wait is a span of its own');
  assert.ok(minutes(order.from, order.to) > 165);
});

test('each fix round is its own sample and the first review is one (AC-004)', () => {
  const events = fixture('IDD-092');
  const d = laneDurations(events, ctx);
  assert.equal(d.fixRounds.length, 5, '3 s2_fix_sent + 2 send-backs');
  const spans = stageSpans(events, ctx, Date.parse('2026-10-06T15:00:00+09:00'));
  const review = spans.filter((s) => s.kind === 'stage' && s.stage === 'review');
  assert.equal(review.length, 2, 'the review before convergence and the one after a base-conflict result');
  const rounds = new Set(spans.filter((s) => s.kind === 'stage' && s.stage === 'fix').map((s) => s.fixRound));
  assert.deepEqual([...rounds].sort(), [1, 2, 3, 4, 5]);
});

test("an open lane's elapsed is the same split as the closed lane's sample (AC-005)", () => {
  const events = fixture('IDD-097');
  const full = laneDurations(events, ctx);
  const cut = (iso) => events.filter((e) => Date.parse(e.at) <= Date.parse(iso));

  const planAt = Date.parse('2026-10-06T15:23:19+09:00');
  const plan = laneDurations(cut('2026-10-06T15:23:19+09:00'), ctx, planAt);
  assert.equal(plan.point.kind === 'stage' && plan.point.stage, 'plan_review', 'the plan is done, the review waits');
  assert.equal(round(plan.stages.plan), round(full.stages.plan));

  const implAt = Date.parse('2026-10-06T16:07:10+09:00');
  const impl = laneDurations(cut('2026-10-06T16:07:10+09:00'), ctx, implAt);
  assert.equal(impl.point.kind === 'stage' && impl.point.stage, 'review');
  assert.equal(round(impl.stages.impl), round(full.stages.impl));
  assert.ok(impl.stages.impl <= full.stages.impl + 0.001, 'an open stretch never exceeds the closed one');

  const fix = fixture('IDD-092');
  const fullFix = laneDurations(fix, ctx);
  const fixAt = Date.parse('2026-10-06T06:35:19+09:00');
  const open = laneDurations(fix.filter((e) => Date.parse(e.at) <= fixAt), ctx, fixAt);
  assert.deepEqual(open.point, { kind: 'stage', stage: 'fix', fixRound: 2 });
  assert.equal(round(open.fixRounds[0]), round(fullFix.fixRounds[0]), 'the round measures the same both ways');
});

test('the plan returns after the answer, and a different batch does not close the gate (AC-034)', () => {
  const events = [
    ev('lane_open', at(12, 0)),
    ev('question_batch_asked', at(12, 5), { batch_id: 'b1' }),
    ev('question_batch_answered', at(12, 25), { batch_id: 'b1' }),
  ];
  const now = Date.parse(at(12, 40));
  const d = laneDurations(events, {}, now);
  assert.deepEqual(d.point, { kind: 'stage', stage: 'plan' }, 'the answered lane is back in the plan');
  assert.equal(round(d.stages.plan), 20, '5 before the question + 15 after the answer');
  const other = [
    ...events,
    ev('question_batch_answered', at(12, 30), { batch_id: 'b2' }),
    ev('question_batch_asked', at(12, 32), { batch_id: 'b3' }),
  ];
  assert.deepEqual(classify(other, {}), { kind: 'gate', gate: 'question' }, 'b3 is still unanswered');
});

test('a question in the implementation or a fix round is a gate whose wait enters no stage (AC-035)', () => {
  const asked = [
    ev('lane_open', at(14, 0)),
    ev('s1_go', at(14, 1)),
    ev('s2_start', at(14, 2)),
    ev('question_batch_asked', at(14, 12), { batch_id: 'b1' }),
  ];
  const during = laneDurations(asked, {}, Date.parse(at(14, 20)));
  assert.deepEqual(during.point, { kind: 'gate', gate: 'question' });
  assert.equal(round(during.stages.impl), 10, '2 -> 12, the 30 minute wait is out');
  const answered = [...asked, ev('question_batch_answered', at(14, 42), { batch_id: 'b1' })];
  const after = laneDurations(answered, {}, Date.parse(at(14, 50)));
  assert.deepEqual(after.point, { kind: 'stage', stage: 'impl' });
  assert.equal(round(after.stages.impl), 18, 'the elapsed goes on after the answer');

  const fix = [
    ...answered,
    ev('s2_result', at(14, 45)),
    ev('s2_review_started', at(14, 46), { kind: 'blind', round: 1 }),
    ev('s2_triage_done', at(14, 47), { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_fix_sent', at(14, 48), { round: 1 }),
    ev('question_batch_asked', at(14, 50), { batch_id: 'b2' }),
  ];
  const mid = laneDurations(fix, {}, Date.parse(at(14, 55)));
  assert.deepEqual(mid.point, { kind: 'gate', gate: 'question' });
  assert.equal(round(mid.fixRounds[0]), 2, '48 -> 50, the wait is out of the round');
});

test('a lane back for PR feedback is the first review again, and R2 keeps its length (AC-008)', () => {
  const base = [
    ev('lane_open', at(9, 0)),
    ev('s2_start', at(9, 2)),
    ev('s2_result', at(9, 30)),
    ev('s2_review_started', at(9, 31), { kind: 'blind', round: 1, max_fix_rounds: 2 }),
    ev('s2_triage_done', at(9, 39), { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_review_converged', at(9, 40)),
    ev('s2_device_skipped', at(9, 41)),
    ev('s3_check_in_progress', at(9, 42)),
    ev('s3_ready', at(9, 42)),
    ev('s3_check_clean', at(9, 42)),
    ev('s3_r2_started', at(9, 42)),
    ev('s3_r2_done', at(9, 43)),
  ];
  assert.deepEqual(classify(base, ctx), { kind: 'stage', stage: 'checks' }, 'convergence puts the lane on R2 and the checks');
  const before = laneDurations(base, ctx, Date.parse(at(9, 45)));
  const feedback = [
    ...base,
    ev('s4_review_comment_received', at(9, 45), { files: ['/f.md'] }),
    ev('s2_triage_started', at(9, 46), { kind: 'feedback', round: 2 }),
  ];
  assert.deepEqual(classify(feedback, ctx), { kind: 'stage', stage: 'review' }, 'the judgement on the comments is the first review again');
  const after = laneDurations(feedback, ctx, Date.parse(at(9, 56)));
  assert.equal(round(after.stages.review), round(before.stages.review) + 11, 'the judgement adds to the first review, a 30 -> 40 stretch and a 45 -> 56 one');
  assert.equal(round(after.stages.checks), round(before.stages.checks), 'the judgement time is not added to R2 and the checks');

  const fixed = [...feedback, ev('s2_triage_done', at(9, 56), { kind: 'feedback', round: 2, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c' }] }), ev('s2_fix_sent', at(9, 57), { round: 2 })];
  assert.deepEqual(classify(fixed, ctx), { kind: 'stage', stage: 'fix', fixRound: 1 }, 'its fix is a fix round as before');
  const convergedAgain = [
    ...fixed,
    ev('s2_result', at(9, 58)),
    ev('s2_confirm_started', at(9, 59), { round: 2 }),
    ev('s2_confirm_done', at(10, 0), { round: 2, unresolved_must: 0, unresolved_should: 0, new_blocking: 0 }),
    ev('s2_review_started', at(10, 1), { kind: 'final', round: 3 }),
    ev('s2_triage_done', at(10, 2), { kind: 'final', round: 3, accepted: [] }),
    ev('s2_review_converged', at(10, 3)),
  ];
  assert.deepEqual(classify(convergedAgain, ctx), { kind: 'stage', stage: 'checks' }, 'the next convergence puts it on R2 and the checks again');
});

test('the split version moved, so the old rows are measured again (AC-010)', () => {
  assert.equal(STAGE_RULE_VERSION, 4);
  // a round skipped because the head was only the mainline merged in ends the round: the submit after it is no fix
  const skipped = [
    ev('s1_go', at(9, 0)), ev('s2_start', at(9, 1)), ev('s2_result', at(9, 2)),
    ev('s2_review_started', at(9, 3), { kind: 'blind', round: 1 }), ev('s2_review_converged', at(9, 4)),
    ev('s3_ready', at(9, 5)),
    ev('s4_verify_user_judgment_answered', at(9, 6), { outcome: 'revise', by: 'harness' }),
    ev('s2_result', at(9, 7)),
    ev('s2_review_merged_skipped', at(9, 8), { head: 'a', merge: 'b' }),
  ];
  assert.deepEqual(classify(skipped), { kind: 'stage', stage: 'checks' });
});

// ---- IDD-133: the windows observation reaches the current point and no past cut ----

/** the runner's reading of the windows: a block while they hold, null when they let a lane start */
const windows = (block) => ({ deliver: async () => {}, quotaBlock: () => block });

test("an open lane's current point feels the observation, and its past cuts do not (AC-003, AC-004)", () => {
  const now = Date.parse(at(9, 40));
  const open = [
    ev('lane_open', at(9, 0)),
    ev('s1_go', at(9, 5)),
    ev('s2_start', at(9, 6)),
    ev('claude_quota_wait', at(9, 30), { stage: 'executor', resets_at: 1 }),
  ];
  setAgentRunner(windows({ reason: 'windows', resetsAt: 1 }));
  assert.deepEqual(classify(open, {}), { kind: 'wait', wait: 'quota' });
  assert.deepEqual(laneDurations(open, {}, now).point, { kind: 'wait', wait: 'quota' });
  setAgentRunner(windows(null));
  assert.deepEqual(classify(open, {}), { kind: 'stage', stage: 'impl' }, 'the windows let it start');
  assert.deepEqual(laneDurations(open, {}, now).point, { kind: 'stage', stage: 'impl' }, 'the current point is not a quota wait');

  // a wait with a later record is a past cut: the split is the same however the windows are read now
  const middle = [
    ev('lane_open', at(9, 0)),
    ev('s2_start', at(9, 2)),
    ev('claude_quota_wait', at(9, 10), { stage: 'blind', resets_at: 1 }),
    ev('s2_result', at(9, 20)),
  ];
  setAgentRunner(windows({ reason: 'windows', resetsAt: 1 }));
  const heldSpans = stageSpans(middle, {}, now);
  const heldDur = laneDurations(middle, {}, now);
  setAgentRunner(windows(null));
  assert.deepEqual(stageSpans(middle, {}, now), heldSpans, 'the past cut does not move with the observation');
  assert.deepEqual(laneDurations(middle, {}, now).stages, heldDur.stages);

  // a closed lane's whole sample is the record alone
  const closed = [
    ev('lane_open', at(9, 0)), ev('s2_start', at(9, 2)), ev('s2_result', at(9, 12)),
    ev('claude_quota_wait', at(9, 20), { stage: 'blind', resets_at: 1 }),
    ev('s2_review_started', at(9, 30), { kind: 'blind', round: 1 }),
    ev('s2_review_converged', at(9, 40)), ev('lane_close', at(9, 50), { outcome: 'merged' }),
  ];
  setAgentRunner(windows({ reason: 'windows', resetsAt: 1 }));
  const closedHeld = laneDurations(closed, {}, now);
  setAgentRunner(windows(null));
  assert.deepEqual(laneDurations(closed, {}, now), closedHeld, 'a closed lane is the record alone');
  setAgentRunner(null);
});

test("an unreadable observation leaves the record's own reset to the current point too (AC-006)", () => {
  const now = Date.parse(at(9, 40));
  const quota = (resetsAt) => [
    ev('lane_open', at(9, 0)),
    ev('s2_start', at(9, 2)),
    ev('claude_quota_wait', at(9, 30), { stage: 'executor', ...(resetsAt === undefined ? {} : { resets_at: resetsAt }) }),
  ];
  for (const runner of [{ deliver: async () => {} }, { deliver: async () => {}, quotaBlock: () => { throw new Error('観測を読めない'); } }]) {
    setAgentRunner(runner);
    assert.deepEqual(laneDurations(quota(4102444800), {}, now).point, { kind: 'wait', wait: 'quota' }, 'a reset ahead holds');
    assert.deepEqual(laneDurations(quota(1), {}, now).point, { kind: 'stage', stage: 'impl' }, 'a reset past does not hold');
    assert.deepEqual(laneDurations(quota(), {}, now).point, { kind: 'wait', wait: 'quota' }, 'no reset holds');
  }
  setAgentRunner(null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { laneStageSpans, reviewLaneStageSpans } from '../src/ledger/stages.ts';

const at = (min) => new Date(Date.UTC(2026, 9, 5, 12, min, 0)).toISOString();
const ev = (event, min, attrs = {}) => ({ event, idd_id: '#1', at: at(min), attrs });

/** INV-103-3: spans run in time order, never overlap, and at most the last is open */
function assertSpans(spans) {
  for (let i = 0; i < spans.length; i += 1) {
    assert.ok(spans[i].start);
    if (spans[i].end !== undefined) {
      assert.ok(spans[i].end >= spans[i].start, `span ${i} ends before it starts`);
    } else {
      assert.equal(i, spans.length - 1, 'an open span is not the last');
    }
    if (i > 0) {
      const prev = spans[i - 1];
      assert.ok(prev.end !== undefined, `span ${i - 1} is open before span ${i}`);
      assert.ok(prev.end <= spans[i].start, `span ${i} starts before span ${i - 1} ends`);
    }
  }
}

test('AC-004: a lane with a question exchange is cut into stages with ISO ends', () => {
  const spans = laneStageSpans([
    ev('lane_open', 0),
    ev('question_batch_asked', 5),
    ev('question_batch_answered', 12),
    ev('s1_ready', 20),
    ev('s1_go', 30),
    ev('s2_start', 31),
    ev('s2_result', 50),
  ]);
  assertSpans(spans);
  assert.deepEqual(spans.map((s) => s.key), ['plan', 'question', 'plan', 'go', 'impl', 'review_round']);
  assert.deepEqual(spans.map((s) => s.owner), ['machine', 'person', 'machine', 'person', 'machine', 'machine']);
  assert.equal(spans[1].start, at(5));
  assert.equal(spans[1].end, at(12));
  assert.equal(spans[spans.length - 1].end, undefined, 'the lane is still at its last stage');
});

test('AC-005: question / GO / sign waits are a person’s time', () => {
  const spans = laneStageSpans([
    ev('lane_open', 0),
    ev('s1_ready', 2),
    ev('s1_go', 3),
    ev('s2_start', 4),
    ev('s2_result', 10),
    ev('s2_review_converged', 11),
    ev('s3_ready', 12),
    ev('s3_ok', 13),
    ev('s4_land_approved', 20),
  ]);
  const by = Object.fromEntries(spans.filter((s) => s.owner === 'person').map((s) => [s.key, s.start]));
  assert.deepEqual(Object.keys(by).sort(), ['go', 'sign']);
  assert.equal(spans.find((s) => s.key === 'sign').owner, 'person');
});

test('INV-103-3: a plan review redone, fix rounds and a send-back all stay inside the spans', () => {
  const spans = laneStageSpans([
    ev('lane_open', 0),
    ev('s1_ready', 5),
    ev('s1_revise_requested', 7),
    ev('s1_ready', 9),
    ev('s1_plan_review_started', 10),
    ev('s1_plan_review_done', 12),
    ev('s1_go', 14),
    ev('s2_start', 15),
    ev('s2_result', 20),
    ev('s2_fix_sent', 21),
    ev('s2_result', 25),
    ev('s2_review_converged', 26),
    ev('s3_ready', 27),
    ev('s3_r2_done', 28),
    ev('s3_ok', 29),
    ev('s4_submit_started', 30),
    ev('s4_land_approved', 40),
    ev('s4_land_merged', 45),
  ]);
  assertSpans(spans);
  const keys = spans.map((s) => s.key);
  assert.ok(keys.includes('plan_review'));
  assert.ok(keys.includes('impl'));
  assert.ok(keys.includes('sign'));
  assert.ok(keys.includes('merge'));
  assert.equal(spans[spans.length - 1].key, 'merge');
  assert.equal(spans[spans.length - 1].end, at(45), 'a closed lane has no open span');
});

test('a note the engine wrote without moving the lane does not cut a span', () => {
  const withNote = laneStageSpans([ev('lane_open', 0), ev('s1_base_advanced', 3), ev('s1_ready', 5)]);
  const without = laneStageSpans([ev('lane_open', 0), ev('s1_ready', 5)]);
  assert.deepEqual(withNote, without);
});

test('a closed lane has no open span, and a deferred lane ends where it stopped', () => {
  for (const close of ['lane_close', 's1_defer', 's3_defer']) {
    const spans = laneStageSpans([ev('lane_open', 0), ev('s1_ready', 4), ev('s1_go', 5), ev('s2_start', 6), ev(close, 9)]);
    assertSpans(spans);
    assert.equal(spans[spans.length - 1].end, at(9));
  }
});

test('a lane with no records reads no spans', () => {
  assert.deepEqual(laneStageSpans([]), []);
});

const rev = (id, repo, pr, history) => ({ id, repo, pr, title: `${repo}#${pr}`, url: '', created_at: history[0].at, history });
const re = (event, min, attrs = {}) => ({ event, at: at(min), attrs });

test('AC-010 / INV-103-3: a review lane’s spans carry a machine time, a person wait and a gap', () => {
  const running = rev('REV-1', 'o/n', 1, [re('r_opened', 0), re('r_wt_ready', 1), re('r_blind_started', 2), re('r_findings', 6)]);
  const spans = reviewLaneStageSpans(running);
  assertSpans(spans);
  assert.ok(spans.length >= 1);
  assert.equal(spans[spans.length - 1].end, undefined, 'a running review lane has an open span');

  const draft = rev('REV-2', 'o/n', 2, [re('r_opened', 0), re('r_wt_ready', 1), re('r_blind_started', 2), re('r_findings', 6), re('r_triage_done', 7), re('r_drafted', 8)]);
  const draftSpans = reviewLaneStageSpans(draft);
  assertSpans(draftSpans);
  const last = draftSpans[draftSpans.length - 1];
  assert.equal(last.owner, 'person', 'waiting for the approval card is a person’s time');
});

test('AC-010: waiting for the author is a gap, and a closed review lane has no open span', () => {
  const author = rev('REV-3', 'o/n', 3, [re('r_opened', 0), re('r_wt_ready', 1), re('r_blind_started', 2), re('r_findings', 5), re('r_triage_done', 6), re('r_drafted', 7), re('r_posted', 8, { event: 'request-changes' })]);
  const spans = reviewLaneStageSpans(author);
  assertSpans(spans);
  assert.equal(spans[spans.length - 1].owner, 'person');
  assert.equal(spans[spans.length - 1].end, at(8), 'the wait for the author closes the span and leaves a gap after it');

  const closed = rev('REV-4', 'o/n', 4, [re('r_opened', 0), re('r_wt_ready', 1), re('r_blind_started', 2), re('r_findings', 3), re('r_triage_done', 4), re('r_drafted', 5), re('r_posted', 6, { event: 'approve' })]);
  const closedSpans = reviewLaneStageSpans(closed);
  assertSpans(closedSpans);
  assert.equal(closedSpans[closedSpans.length - 1].end, at(6));
});

test('AC-010: a stuck review lane is a machine stage with the reason in its name', () => {
  const stuck = rev('REV-5', 'o/n', 5, [re('r_opened', 0), re('r_wt_ready', 1), re('r_failed', 2, { error: 'timeout' })]);
  const spans = reviewLaneStageSpans(stuck);
  assertSpans(spans);
  assert.equal(spans[spans.length - 1].key, 'pr_review_stuck');
});

test('AC-049: the hand turn is a person\'s span, and the kept round stays the machine\'s', () => {
  const spans = laneStageSpans([
    ev('s1_go', 0), ev('s2_start', 1), ev('s2_result', 2),
    ev('s2_review_started', 3, { kind: 'blind', round: 1 }),
    ev('s2_review_converged', 4),
    ev('s2_review_started', 5, { kind: 'kept', round: 1 }),
    ev('s2_triage_done', 6, { kind: 'kept', accepted: [] }),
    ev('s2_review_escalated', 7, { reason: 'r' }),
    ev('s2_review_resumed', 8, { decision: 'hand_fix' }),
    ev('s2_hand_fixed', 20),
  ]);
  assertSpans(spans);
  const hand = spans.find((s) => s.key === 'hand_fix');
  assert.ok(hand, 'the hand turn is its own span');
  assert.equal(hand.owner, 'person');
  assert.equal(hand.start, at(8));
  assert.equal(hand.end, at(20));
  // the kept round reads as a machine's review round
  assert.ok(spans.some((s) => s.key === 'review_round' && s.owner === 'machine'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answerOutcome, fixScope, reviewLoopState, unfixedOf, s4Triage, submitLeftovers } from '../src/ledger/review-loop.ts';
import { confirmedFixes, lastDecisions, replyDrafts } from '../src/plan/pr-feedback.ts';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-01-01T00:00:00Z', attrs });

const accepted = [
  { ref: 'C-1', severity: 'should', claim: 'fix の should', action: 'fix' },
  { ref: 'C-2', severity: 'should', claim: 'followup の should', action: 'followup', reason: '外の話' },
  { ref: 'C-3', severity: 'nit', claim: 'skip の nit', action: 'skip', reason: '好み' },
  { ref: 'C-4', severity: 'nit', claim: 'fix の nit', action: 'fix' },
  { ref: 'C-5', severity: 'must', claim: 'action が followup の must', action: 'followup' },
  { ref: 'C-6', severity: 'should', claim: 'action の無い should' },
];

const s4Events = () => [
  ev('s2_start'), ev('s2_result'),
  ev('s4_review_comment_received', { files: ['/f/feedback.md'] }),
  ev('s2_triage_done', { kind: 'feedback', round: 1, accepted }),
];
const s2Events = () => [
  ev('s2_start'), ev('s2_result'),
  ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b1'] }),
  ev('s2_review_findings', { kind: 'blind', round: 1, files: [] }),
  ev('s2_triage_done', { kind: 'blind', round: 1, accepted }),
];

test('an S4 judgement sends only the accepted items whose action is fix, nits included', () => {
  const scope = fixScope(s4Events());
  assert.equal(scope.source, 'pr');
  assert.deepEqual(scope.accepted.map((a) => a.ref), ['C-1', 'C-4', 'C-5', 'C-6'], 'fix items, the must whatever its action, and an unreadable action');
});

test('the review loop sends the accepted must / should whose action is fix, and never a nit', () => {
  const scope = fixScope(s2Events());
  assert.equal(scope.source, 'review');
  assert.deepEqual(scope.accepted.map((a) => a.ref), ['C-1', 'C-5', 'C-6'], 'no nit reaches the review loop, whatever its action');
});

test('only an S4 judgement is read as one', () => {
  assert.equal(s4Triage(s4Events(), 3), true);
  assert.equal(s4Triage(s2Events(), 4), false);
});

test('an S4 leftover does not count a skipped accepted item, the review loop still does', () => {
  const three = [
    { ref: 'C-1', severity: 'must', claim: '直す must', action: 'fix' },
    { ref: 'C-2', severity: 'should', claim: '外の should', action: 'followup', reason: '外の話' },
    { ref: 'C-3', severity: 'nit', claim: '見送る nit', action: 'skip', reason: '好み' },
  ];
  const triage = ev('s2_triage_done', { kind: 'feedback', round: 1, accepted: three });
  const fix = ev('s2_fix_sent', { refs: ['C-1'] });
  assert.deepEqual(unfixedOf([triage], 0, fix, '', true).accepted.map((a) => a.ref), [], 'followup and skip are answered by their replies');
  const loop = { ...triage, attrs: { ...triage.attrs, kind: 'blind' } };
  assert.deepEqual(unfixedOf([loop], 0, fix, '', false).accepted.map((a) => a.ref), ['C-3'], 'in the loop a skipped item stays on record');
});

test('the replies come in the four forms, from the last judgement of each ref', () => {
  const events = [
    ...s4Events(),
    ev('s2_fix_sent', { refs: ['C-1'] }),
    ev('s2_confirm_done', { round: 1, unresolved_refs: [] }),
    ev('s2_triage_done', { kind: 'confirm', round: 1, accepted: [
      { ref: 'C-1', severity: 'should', claim: 'fix の should', action: 'fix' },
      { ref: 'C-2', severity: 'should', claim: '追随の should', action: 'followup', reason: '外の話' },
      { ref: 'C-3', severity: 'nit', claim: '見送る nit', action: 'skip', reason: '好み' },
      { ref: 'C-5', severity: 'nit', claim: '直っていない nit', action: 'fix' },
    ], rejected: [{ ref: 'C-6', severity: 'should', claim: '棄却', reason: '誤り' }, { ref: 'C-7', severity: 'nit', claim: '別 Issue', reason: '責務の外', followup: true }] }),
  ];
  const decisions = lastDecisions(events, 2);
  assert.equal(decisions.get('C-1').action, 'fix');
  assert.equal(decisions.get('C-2').action, 'followup', "the leftovers judgement replaces the feedback's decision");
  const resolved = confirmedFixes(events, 2);
  assert.ok(resolved.has('C-1'), 'the confirm after the fix found it resolved');
  const items = ['C-1', 'C-2', 'C-3', 'C-5', 'C-6', 'C-7', 'CI-1', 'C-8'].map((ref, i) => ({
    ref, id: `id-${i}`, kind: ref === 'CI-1' ? 'ci' : 'thread', author: 'rev', url: `u#${ref}`, quote: 'q', thread_id: `t-${ref}`,
  }));
  decisions.set('C-8', { ref: 'C-8', verdict: 'reject', claim: '要望なし', no_request: true });
  const parts = replyDrafts(items, decisions, 'abcdef1234567', resolved);
  const by = Object.fromEntries(parts.map((p) => [p.ref, p]));
  assert.equal(parts.length, 6, 'the CI item and the one asking for nothing get no reply');
  assert.equal(by['C-1'].draft, 'fix の should を直しました（abcdef1）。');
  assert.equal(by['C-1'].resolve, true, 'a confirmed fix closes its thread');
  assert.equal(by['C-2'].draft, 'この PR では直さず、別の Issue で扱います。外の話');
  assert.equal(by['C-3'].draft, '対応していません。好み');
  assert.equal(by['C-5'].draft, '', 'a fix no confirm found resolved is penne\'s reply to write');
  assert.equal(by['C-5'].resolve, false);
  assert.equal(by['C-6'].draft, '直していません。誤り');
  assert.equal(by['C-7'].draft, 'この PR では直さず、別の Issue で扱います。責務の外');
  assert.equal(by['C-7'].resolve, false);
});

test('a reply says fixed for a fix the confirm resolved, and stays empty for one it did not', () => {
  const events = [
    ...s4Events(),
    ev('s2_fix_sent', { refs: ['C-1', 'C-6'] }),
    ev('s2_confirm_done', { round: 1, unresolved_refs: ['C-6'] }),
  ];
  const decisions = lastDecisions(events, 2);
  const resolved = confirmedFixes(events, 2);
  assert.deepEqual([...resolved], ['C-1']);
  const items = [{ ref: 'C-1', id: '1', kind: 'thread', author: 'r', url: 'u', quote: 'q', thread_id: 't1' }];
  const parts = replyDrafts(items, decisions, 'abcdef1234567', resolved);
  assert.match(parts[0].draft, /直しました（abcdef1）/);
  assert.equal(parts[0].resolve, true);
});

test('a skipped or followed-up accepted item is not listed as an unfixed leftover on the submit card', () => {
  const three = [
    { ref: 'C-1', severity: 'must', claim: '直す must', action: 'fix' },
    { ref: 'C-2', severity: 'should', claim: '外の should', action: 'followup', reason: '外の話' },
    { ref: 'C-3', severity: 'nit', claim: '見送る nit', action: 'skip', reason: '好み' },
  ];
  const events = [
    ev('s2_start'), ev('s2_result'),
    ev('s4_review_comment_received', { files: ['/f/feedback.md'] }),
    ev('s2_triage_done', { kind: 'feedback', round: 1, accepted: three }),
    ev('s2_fix_sent', { refs: ['C-1'] }),
    ev('s2_confirm_done', { round: 1, unresolved_refs: [] }),
    ev('s2_review_converged', {}),
  ];
  assert.deepEqual(submitLeftovers(events), []);
});

test('an S4 confirm with an unresolved should goes back to the leftovers, never on to the final blind', () => {
  const s4 = [
    ev('s2_start'), ev('s2_result'),
    ev('s4_review_comment_received', { files: [] }),
    ev('s2_triage_done', { kind: 'feedback', round: 1, accepted: [{ ref: 'C-1', severity: 'should', claim: 'a', action: 'fix' }] }),
    ev('s2_fix_sent', { refs: ['C-1'] }),
    ev('s2_result'),
    ev('s2_confirm_started', { round: 1, run_id: 'c' }),
    // the confirm carries no kind of its own: whether it belongs to an S4 pass is read from where the pass began
    ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 1, unresolved_requests: 1, unresolved_boundaries: 0, new_blocking: 0, unresolved_refs: ['C-1'], files: [] }),
  ];
  const st = reviewLoopState(s4);
  assert.equal(st.state, 'start_triage');
  assert.equal(st.kind, 'confirm');
  // the one-should tolerance is the review loop's: an S2 confirm may still go on to the final blind
  const s2 = [
    ev('s2_start'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }), ev('s2_review_findings', { kind: 'blind', round: 1, files: [] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: 'a', action: 'fix' }] }),
    ev('s2_fix_sent', { refs: ['F-1'] }),
    ev('s2_result'),
    ev('s2_confirm_started', { round: 1, run_id: 'c' }),
    ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 1, new_blocking: 0, unresolved_refs: ['F-1'], files: [] }),
  ];
  assert.equal(reviewLoopState(s2).state, 'start_blind');
  assert.equal(reviewLoopState(s2).kind, 'final');
});

test('continuing an S4 stop counts only the requests it sends to the fix as left over', () => {
  const events = [
    ev('s2_start'), ev('s2_result'),
    ev('s4_review_comment_received', { files: ['/f/feedback.md'] }),
    ev('s2_triage_done', { kind: 'feedback', round: 1, escalated_claims: ['仕様が決まらない'], accepted: [
      { ref: 'C-1', severity: 'must', claim: '直す must', action: 'fix' },
      { ref: 'C-2', severity: 'should', claim: '外の should', action: 'followup', reason: '外の話' },
      { ref: 'C-3', severity: 'nit', claim: '見送る nit', action: 'skip', reason: '好み' },
    ] }),
    ev('s2_review_escalated', { reason: '仕様が決まらない' }),
  ];
  const out = answerOutcome(events, { decision: 'continue', note: '' }, { skipsFinal: () => true, deviceOn: false });
  assert.equal(out.to, 'fix');
  assert.deepEqual(out.refs, ['C-1'], 'only the fix request goes to the new session');
  assert.equal(out.left.accepted, 0, 'the follow-up and the skip are not counted as unfixed leftovers');
});

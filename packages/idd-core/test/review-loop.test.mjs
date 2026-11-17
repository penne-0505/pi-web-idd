import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answerOutcome, compareOrder, conflictSendBacks, feedbackPassAt, fixCapReached, fixesNow, fixCounts, followupsOf, orderOpponentsOf, orderPositionOf, orderRankOf, passPolicy, reviewLoopLabel, reviewLoopState, settledHead, shouldFixCounts, stagnation, submitLeftovers, MAX_FIX_ROUNDS } from '../src/ledger/review-loop.ts';
import { deriveStage } from '../src/ledger/derive.ts';

// where penne's continue (without a note) takes the lane, with the final review skipped on a settled head as the loop does
// when the worktree is still at it
const continueOutcome = (e) => answerOutcome(e, { decision: 'continue', note: '' }, { skipsFinal: (x) => !!settledHead(x), deviceOn: false })?.to;
const acceptDevice = (e) => answerOutcome(e, { decision: 'accept', note: '' }, { skipsFinal: () => false, deviceOn: true })?.device;

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });
const acc = (...sev) => sev.map((s, i) => ({ ref: `F-${i + 1}`, severity: s, claim: `c${i}`, path: 'a.ts', fix: 'f' }));
const st = (events) => reviewLoopState(events).state;

test('walks blind → triage → fix → confirm → final blind → converge → device → done', () => {
  const e = [ev('s1_go'), ev('s2_start'), ev('s2_result', { outcome: 'success' })];
  assert.deepEqual(reviewLoopState(e), { state: 'start_blind', kind: 'blind', round: 1 });
  e.push(ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['A', 'B'] }));
  assert.equal(st(e), 'running_blind');
  e.push(ev('s2_review_findings', { kind: 'blind', round: 1, files: ['a.json', 'b.json'] }));
  assert.equal(st(e), 'start_triage');
  e.push(ev('s2_triage_started', { kind: 'blind', round: 1, run_id: 'T' }));
  e.push(ev('s2_triage_done', { kind: 'blind', round: 1, accepted: acc('must', 'should', 'nit') }));
  assert.equal(st(e), 'send_fix');
  e.push(ev('s2_fix_sent', { round: 1 }));
  assert.equal(st(e), 'fixing');
  e.push(ev('s2_result', { outcome: 'success' }));
  assert.equal(st(e), 'start_confirm');
  e.push(ev('s2_confirm_started', { round: 1, run_id: 'C' }));
  e.push(ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0, files: ['c.json'] }));
  assert.deepEqual(reviewLoopState(e), { state: 'start_blind', kind: 'final', round: 2 });
  e.push(ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['D'] }));
  e.push(ev('s2_review_findings', { kind: 'final', round: 2, files: ['d.json'] }));
  e.push(ev('s2_triage_done', { kind: 'final', round: 2, accepted: acc('should', 'nit') }));
  assert.equal(st(e), 'converge', 'one accepted should is tolerated');
  e.push(ev('s2_review_converged'));
  assert.equal(st(e), 'start_device');
  e.push(ev('s2_device_skipped', { reason: 'UI に関わらない' }));
  assert.equal(st(e), 'done');
});

test('an open confirm goes back to triage; escalations and failures stop the loop', () => {
  const base = [ev('s2_result'), ev('s2_fix_sent', { round: 1 }), ev('s2_result')];
  const open = [...base, ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 2, new_blocking: 0, files: ['c.json'] })];
  assert.deepEqual(reviewLoopState(open), { state: 'start_triage', kind: 'confirm', round: 1, inputs: ['c.json'] });
  const fresh = [...base, ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 1, files: ['c.json'] })];
  assert.equal(st(fresh), 'start_triage', 'a new must / should from confirm is judged before closing');
  assert.equal(st([ev('s2_result'), ev('s2_triage_done', { kind: 'blind', escalated_claims: ['x'], accepted: [] })]), 'escalated');
  assert.equal(st([ev('s2_result'), ev('s2_triage_done', { failed: true, error: 'x' })]), 'escalated');
  const esc = [ev('s2_result'), ev('s2_review_escalated', { reason: 'r' })];
  assert.equal(st([...esc, ev('s2_review_resumed', { decision: 'continue' })]), 'send_fix');
  assert.equal(st([...esc, ev('s2_review_resumed', { decision: 'accept' })]), 'converge');
});

test('stops on stagnation, not on a round count', () => {
  const tri = (n, tag) => ev('s2_triage_done', { kind: 'blind', accepted: Array.from({ length: n }, (_, i) => ({ ref: `F-${i}`, severity: 'should', claim: `${tag}-${i}`, path: 'a.ts' })) });
  const shrinking = [ev('s2_result'), tri(5, 'r1'), ev('s2_fix_sent'), tri(4, 'r2'), ev('s2_fix_sent'), tri(3, 'r3')];
  assert.equal(stagnation(shrinking), null);
  assert.equal(st(shrinking), 'send_fix');
  const flat = [ev('s2_result'), tri(3, 'r1'), ev('s2_fix_sent'), tri(3, 'r2'), ev('s2_fix_sent'), tri(3, 'r3')];
  assert.equal(stagnation(flat), '受理済みの must / should が減らない（3 → 3 → 3）');
  assert.equal(st(flat), 'escalated');
  const same = [ev('s2_result'), tri(2, 'x'), ev('s2_fix_sent'), tri(2, 'x'), ev('s2_fix_sent'), tri(2, 'x')];
  assert.match(stagnation(same) ?? '', /戻ってくる/);
  const many = [ev('s2_result'), ...Array.from({ length: MAX_FIX_ROUNDS }, () => ev('s2_fix_sent')), ev('s2_result'), ev('s2_confirm_done', { unresolved_must: 0, unresolved_should: 3, files: [] }), tri(2, 'm')];
  assert.match(stagnation(many) ?? '', /上限/);
});

test('only what the judgement sent to this change\'s fix counts: a follow-up does not hold the loop', () => {
  const t = (items) => [ev('s2_result'), ev('s2_triage_done', { kind: 'blind', accepted: items })],
    item = (ref, severity, action) => ({ ref, severity, claim: ref, path: 'a.ts', fix: 'f', ...(action ? { action } : {}) });
  // a should sent to a follow-up or skipped does not count; the same should with no readable action does
  assert.equal(st(t([item('F-1', 'should', 'followup')])), 'start_blind', 'a follow-up alone is within the limit');
  assert.equal(st(t([item('F-1', 'should', 'skip'), item('F-2', 'should', 'followup')])), 'start_blind');
  assert.equal(st(t([item('F-1', 'should', 'later')])), 'start_blind');
  assert.equal(st(t([item('F-1', 'should', 'later'), item('F-2', 'should')])), 'send_fix', 'an unreadable action is fixed');
  // an accepted must is fixed whatever its recommended handling says
  assert.equal(st(t([item('F-1', 'must', 'followup')])), 'send_fix');
  assert.equal(st(t([item('F-1', 'must', 'skip')])), 'send_fix');
  assert.deepEqual(fixCounts([item('F-1', 'must', 'skip'), item('F-2', 'should', 'followup'), item('F-3', 'should', 'fix')]), { must: 1, should: 1 });
  assert.equal(fixesNow({ severity: 'must', action: 'skip' }), true);
  assert.equal(fixesNow({ severity: 'should', action: 'followup' }), false);
});

test('the follow-ups of a pass are the accepted `followup` and the rejected marked followup, and never the PR feedback\'s', () => {
  const accepted = (ref, action) => ({ ref, severity: 'should', claim: ref, path: 'a.ts', ...(action ? { action } : {}) });
  const base = [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [accepted('F-1', 'followup'), accepted('F-2', 'fix')], rejected: [{ ref: 'F-3', severity: 'should', claim: '範囲の外', followup: true }, { ref: 'F-4', severity: 'should', claim: '誤り' }] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-2'] }),
  ];
  assert.deepEqual(followupsOf(base).map((f) => f.claim), ['F-1', '範囲の外']);
  // the same words on the same file are one item
  const dup = [...base.slice(0, 1), ev('s2_triage_done', { kind: 'confirm', round: 1, accepted: [accepted('F-5', 'followup')] }), ...base.slice(1)];
  assert.equal(followupsOf(dup).filter((f) => f.claim === 'F-1').length, 1);
  // a judgement on PR feedback goes to an Issue draft, not to the TODO
  const feedback = [ev('s4_review_comment_received', { files: ['/f.md'] }), ev('s2_triage_done', { kind: 'feedback', round: 1, accepted: [accepted('F-1', 'followup')], rejected: [] })];
  assert.deepEqual(followupsOf(feedback), []);
  // the leftovers list what was not fixed, but a follow-up was decided not to be fixed here
  const leftovers = [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [accepted('F-1', 'followup'), accepted('F-2', 'fix')] }),
    ev('s2_fix_sent', { refs: ['F-2'] }),
  ];
  const listed = submitLeftovers(leftovers).map((l) => l.claim);
  assert.ok(!listed.includes('F-1'), 'a follow-up was decided not to be fixed here, so it is not a leftover');
  assert.ok(listed.some((c) => c.startsWith('F-2')), 'what was sent to the fix but not confirmed is still listed');
  // an accepted must is fixed whatever its action says, so it is not a follow-up: the two decisions agree
  const mustFollow = [ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: '直す must', path: 'a.ts', action: 'followup' }] }), ev('s2_fix_sent', { round: 1, refs: ['F-1'] })];
  assert.deepEqual(followupsOf(mustFollow), []);
  // a skipped item is neither fixed nor a follow-up, but it must not vanish from the submit card
  const skipped = [ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: '見送る', path: 'a.ts', action: 'skip' }] })];
  assert.deepEqual(followupsOf(skipped), []);
  assert.deepEqual(submitLeftovers(skipped).map((l) => [l.claim, l.action]), [['見送る', 'skip']]);
  // an accepted must that was not sent to the fix is a leftover, whatever its action says, and it is written to the
  // follow-ups as unsent: nothing accepted leaves without a trace
  const mustNotFixed = [ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: '直す must', path: 'a.ts', action: 'followup' }] })];
  assert.deepEqual(followupsOf(mustNotFixed).map((f) => [f.claim, f.source]), [['直す must', 'unsent']]);
  assert.ok(submitLeftovers(mustNotFixed).some((l) => l.claim === '直す must'), 'an accepted must not fixed is a leftover even when its action says followup');
  // in an S4 pass only the judgement on the PR feedback, and that pass's confirm, go to an Issue draft;
  // the final review and the device check still leave their follow-ups for the TODO and the card
  const s4 = [
    ev('s4_review_comment_received', { files: ['/f.md'] }),
    ev('s2_triage_done', { kind: 'feedback', round: 1, accepted: [accepted('C-1', 'followup')], rejected: [] }),
    ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['B'] }),
    ev('s2_triage_done', { kind: 'final', round: 2, accepted: [accepted('F-1', 'followup')], rejected: [{ ref: 'F-2', severity: 'should', claim: '最終で見送り', followup: true }] }),
    ev('s2_confirm_started', { round: 2, run_id: 'C' }),
    ev('s2_confirm_done', { kind: 'confirm', round: 2, accepted: [accepted('F-3', 'followup')] }),
  ];
  assert.deepEqual(followupsOf(s4).map((f) => f.claim), ['F-1', '最終で見送り']);
  // a later judgement of the same pass whose fix carries the same finding takes it out of the follow-ups
  const changedMind = [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: '同じ指摘', path: 'a.ts', action: 'followup' }] }),
    ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['B2'] }),
    ev('s2_triage_done', { kind: 'final', round: 2, accepted: [{ ref: 'F-1', severity: 'should', claim: '同じ指摘', path: 'a.ts', action: 'fix' }, { ref: 'F-2', severity: 'must', claim: '別の must', path: 'b.ts', action: 'fix' }] }),
    ev('s2_fix_sent', { round: 2, refs: ['F-1', 'F-2'] }),
  ];
  assert.deepEqual(followupsOf(changedMind), []);
  // the same judgement without the fix (the loop closed on it): the finding was never fixed, so it stays a follow-up
  assert.deepEqual(followupsOf(changedMind.slice(0, 4)).map((f) => f.claim), ['同じ指摘', '別の must']);
  // what a fix carried is open until a confirm says otherwise, whatever the recommended action says
  const s4Sent = [
    ev('s4_review_comment_received', { files: ['/f.md'] }),
    ev('s2_triage_done', { kind: 'feedback', round: 1, accepted: [{ ref: 'C-1', severity: 'should', claim: 'レビュアーの依頼', path: 'a.ts', action: 'followup' }] }),
    ev('s2_fix_sent', { refs: ['C-1'] }),
  ];
  assert.ok(submitLeftovers(s4Sent).some((l) => l.claim.startsWith('レビュアーの依頼')), 'a request sent to the fix is a leftover until a confirm says otherwise, whatever its action');
});

test('lanes that already reached S3 are left alone', () => {
  assert.equal(st([ev('s2_result'), ev('s3_ready')]), 'done');
  assert.equal(st([ev('s1_go')]), 'idle');
});

test('a single accepted must is always fixed; only one should is tolerated', () => {
  const t = (...sev) => [ev('s2_result'), ev('s2_triage_done', { kind: 'blind', accepted: acc(...sev) })];
  assert.equal(st(t('must')), 'send_fix');
  assert.equal(st(t('should')), 'start_blind');
  assert.equal(st(t('should', 'should')), 'send_fix');
  assert.equal(st([ev('s2_result'), ev('s2_triage_done', { kind: 'final', accepted: acc('must') })]), 'send_fix');
  const confirm = (m, sh) => [ev('s2_result'), ev('s2_fix_sent'), ev('s2_result'), ev('s2_confirm_done', { unresolved_must: m, unresolved_should: sh, new_blocking: 0, files: ['c.json'] })];
  assert.equal(st(confirm(1, 0)), 'start_triage', 'an unresolved must goes back to triage');
  assert.equal(st(confirm(0, 1)), 'start_blind');
});

test('a duplicate result while a stage runs does not restart the loop; new work after it finished does', () => {
  const running = [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['a'] }), ev('s2_result')];
  assert.equal(st(running), 'running_blind');
  const after = [ev('s2_result'), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s4_verify_user_judgment_answered'), ev('s2_result')];
  assert.equal(st(after), 'start_blind', 'new work comes from a send-back');
  assert.equal(st([ev('s2_result'), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s2_result')]), 'done', 'a stray result after the loop is a duplicate');
});

test('continuing after repeated start failures retries the stage that failed', () => {
  const e = [ev('s2_result'), ev('s2_review_findings', { kind: 'blind', round: 1, files: ['a.json'] }),
    ev('s2_review_run_failed'), ev('s2_review_run_failed'), ev('s2_review_run_failed'),
    ev('s2_review_escalated', { reason: 'r', retry_state: { state: 'start_triage', kind: 'blind', round: 1, inputs: ['a.json'] } })];
  assert.equal(st(e), 'escalated');
  assert.equal(st([...e, ev('s2_review_resumed', { decision: 'continue' })]), 'start_triage');
});

test('continuing after a failed triage or confirm retries that stage instead of sending an empty fix', () => {
  const tri = [ev('s2_result'), ev('s2_review_findings', { kind: 'blind', round: 1, files: ['a.json'] }),
    ev('s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }), ev('s2_triage_done', { kind: 'blind', round: 1, failed: true, error: 'x' })];
  const esc = reviewLoopState(tri);
  assert.equal(esc.state, 'escalated');
  assert.equal(esc.retry.state, 'start_triage');
  const resumed = [...tri, ev('s2_review_escalated', { reason: 'r', retry_state: esc.retry }), ev('s2_review_resumed', { decision: 'continue' })];
  assert.deepEqual(reviewLoopState(resumed), { state: 'start_triage', kind: 'blind', round: 1, inputs: ['a.json'] });
  const conf = [ev('s2_result'), ev('s2_fix_sent', { round: 1 }), ev('s2_result'), ev('s2_confirm_started', { round: 1, run_id: 'c' }), ev('s2_confirm_done', { round: 1, failed: true, error: 'x' })];
  assert.equal(reviewLoopState(conf).retry.state, 'start_confirm');
});

test('a final-blind must that keeps coming back is stagnation; continue before the escalation is recorded still retries', () => {
  const fin = (tag) => ev('s2_triage_done', { kind: 'final', accepted: [{ ref: 'F-1', severity: 'must', claim: tag, path: 'a.ts' }] });
  const e = [ev('s2_result'), fin('same'), ev('s2_fix_sent'), fin('same'), ev('s2_fix_sent'), fin('same')];
  assert.match(stagnation(e) ?? '', /戻ってくる/);
  const failed = [ev('s2_result'), ev('s2_review_findings', { kind: 'blind', round: 1, files: ['a.json'] }),
    ev('s2_triage_started', { run_id: 't', kind: 'blind', round: 1 }), ev('s2_triage_done', { failed: true, error: 'x', kind: 'blind', round: 1 }),
    ev('s2_review_resumed', { decision: 'continue' })];
  assert.equal(st(failed), 'start_triage', 'no s2_review_escalated event yet, but the derived escalation carries the retry');
});

// an S2 pass that closed, then feedback on the PR
const s4 = () => [
  ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1 }), ev('s2_triage_done', { kind: 'blind', accepted: [] }),
  ev('s2_review_started', { kind: 'final', round: 1 }), ev('s2_triage_done', { kind: 'final', accepted: [] }),
  ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'), ev('s4_review_comment_received', { files: ['fb.md'] }),
];

test('feedback that accepts several requests after a closed pass is fixed, not taken for stagnation', () => {
  const e = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: acc('must', 'must') })];
  assert.equal(stagnation(e), null);
  assert.equal(st(e), 'send_fix');
});

test('in an S4 pass an unresolved request goes back to the fix whatever its severity; in S2 an unresolved nit is not counted', () => {
  const fixed = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: acc('nit') }), ev('s2_fix_sent', { round: 1, refs: ['F-1'] }), ev('s2_result')];
  const open = [...fixed, ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, unresolved_requests: 1, unresolved_nit: 1, new_blocking: 0, files: ['c.json'] })];
  assert.equal(st(open), 'start_triage');
  const clean = [...fixed, ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, unresolved_requests: 0, new_blocking: 0, files: ['c.json'] })];
  assert.deepEqual(reviewLoopState(clean), { state: 'start_blind', kind: 'final', round: 2 });
  // the leftover the triage accepts again is fixed, nit or not; with nothing accepted the pass goes on to the final blind
  assert.equal(st([...open, ev('s2_triage_done', { kind: 'confirm', accepted: acc('nit') })]), 'send_fix');
  assert.deepEqual(reviewLoopState([...open, ev('s2_triage_done', { kind: 'confirm', accepted: [] })]), { state: 'start_blind', kind: 'final', round: 2 });
  // an S2 pass: a confirm's leftover nit is on record only
  const s2 = [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1 }), ev('s2_triage_done', { kind: 'blind', accepted: acc('must', 'nit') }), ev('s2_fix_sent', { round: 1 }), ev('s2_result'),
    ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 2, new_blocking: 0, files: ['c.json'] })];
  assert.equal(st(s2), 'start_triage');
  assert.equal(st([...s2, ev('s2_triage_done', { kind: 'confirm', accepted: acc('nit') })]), 'start_blind', 'an S2 leftover nit is not fixed');
});

test('an S4 request that keeps coming back is stagnation even as a nit', () => {
  const nit = (tag) => ev('s2_triage_done', { kind: 'confirm', accepted: [{ ref: 'F-1', severity: 'nit', claim: tag, path: 'a.ts' }] });
  const e = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: [{ ref: 'C-1', severity: 'nit', claim: 'x', path: 'a.ts' }] }), ev('s2_fix_sent'), nit('x'), ev('s2_fix_sent'), nit('x')];
  assert.match(stagnation(e) ?? '', /戻ってくる/);
  const flat = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: [{ ref: 'C-1', severity: 'nit', claim: 'a', path: 'a.ts' }] }), ev('s2_fix_sent'), nit('b'), ev('s2_fix_sent'), nit('c')];
  assert.match(stagnation(flat) ?? '', /受理済みの指摘が減らない/);
});

test('a reversal of an earlier fix goes to penne, whatever else the triage accepted', () => {
  const osc = { ref: 'F-1', severity: 'should', path: 't.py', claim: '語彙で文言を縛る', prior_ref: '2-final/F-1', prior: '通過が判別できること', current: '特定の語で合否を決めない' };
  for (const accepted of [[], acc('should'), acc('must', 'should')]) {
    const s = reviewLoopState([ev('s2_result'), ev('s2_triage_done', { kind: 'final', round: 3, accepted, oscillations: [osc] })]);
    assert.equal(s.state, 'escalated');
    assert.match(s.reason, /往復/);
  }
  // penne's continue sends the fix as after any question
  const esc = [ev('s2_result'), ev('s2_triage_done', { kind: 'final', round: 3, accepted: [], oscillations: [osc] }), ev('s2_review_escalated', { reason: 'r' })];
  assert.equal(st([...esc, ev('s2_review_resumed', { decision: 'continue', boundaries: [{ ref: 'F-1', choice: 'prior' }] })]), 'send_fix');
});

test('what is not a reversal is judged and stalls as before', () => {
  const tri = (n, tag, extra = {}) => ev('s2_triage_done', { kind: 'blind', accepted: Array.from({ length: n }, (_, i) => ({ ref: `F-${i}`, severity: 'should', claim: `${tag}-${i}`, path: 'a.ts' })), ...extra });
  const flat = [ev('s2_result'), tri(3, 'r1'), ev('s2_fix_sent'), tri(3, 'r2'), ev('s2_fix_sent'), tri(3, 'r3')];
  assert.equal(stagnation(flat), '受理済みの must / should が減らない（3 → 3 → 3）');
  // an empty mark leaves the triage as it was
  assert.equal(st([ev('s2_result'), tri(1, 'x', { oscillations: [] })]), 'start_blind');
  assert.equal(st([ev('s2_result'), tri(2, 'x', { oscillations: [] })]), 'send_fix');
});

// a stop over the judgement's questions: penne's continue does not send nits to the fix
const question = (kind, accepted, extra = {}) => [
  ev('s2_result'), ev('s2_review_started', { kind: kind === 'final' ? 'final' : 'blind', round: 1 }),
  ev('s2_triage_done', { kind, round: 1, accepted, escalated_claims: ['仕様が決まっていない'], ...extra }),
  ev('s2_review_escalated', { reason: '判定が penne の判断を求めた指摘がある' }),
];
const cont = (note = '') => ev('s2_review_resumed', { decision: 'continue', note });

test('continuing after the final review\'s question with only nits accepted converges instead of another fix round', () => {
  const e = question('final', acc('nit', 'nit', 'nit', 'nit', 'nit'));
  assert.equal(st(e), 'escalated');
  assert.equal(st([...e, cont()]), 'converge');
  assert.equal(st([...question('final', acc('should', 'nit')), cont()]), 'converge', 'one should is tolerated as when no question was asked');
  assert.equal(continueOutcome(e), 'close');
});

test('continuing after a blind or confirm judgement\'s question within the limit goes on to the final review', () => {
  assert.deepEqual(reviewLoopState([...question('blind', acc('nit', 'nit')), cont()]), { state: 'start_blind', kind: 'final', round: 1 });
  assert.deepEqual(reviewLoopState([...question('blind', []), cont()]), { state: 'start_blind', kind: 'final', round: 1 });
  assert.deepEqual(reviewLoopState([...question('confirm', acc('nit')), cont()]), { state: 'start_blind', kind: 'final', round: 1 });
  assert.equal(st([...question('device', acc('nit')), cont()]), 'done', 'a device check within the limit ends the loop as without a question');
  assert.equal(continueOutcome(question('blind', acc('nit'))), 'final');
  // the continue pressed before the escalation event was written reads the same
  assert.equal(st([...question('final', acc('nit')).slice(0, -1), cont()]), 'converge');
});

test('continuing after a question still sends the fix when must / should are over the limit, or penne wrote an instruction', () => {
  assert.equal(st([...question('final', acc('must', 'nit')), cont()]), 'send_fix');
  assert.equal(st([...question('blind', acc('should', 'should', 'nit')), cont()]), 'send_fix');
  assert.equal(continueOutcome(question('blind', acc('must'))), 'fix');
  // a note is an instruction to the executor: it goes with a fix rather than being dropped
  assert.equal(st([...question('final', acc('nit')), cont('A 案で直す')]), 'send_fix');
});

test('stagnation, reversals, failures and S4 feedback are resumed as before', () => {
  const esc = [ev('s2_result'), ev('s2_review_escalated', { reason: 'r' })];
  assert.equal(st([...esc, cont()]), 'send_fix');
  const osc = { ref: 'F-9', severity: 'should', path: 't.py', claim: 'x', prior_ref: '1-blind/F-1', prior: 'a', current: 'b' };
  assert.equal(st([...question('final', acc('nit'), { oscillations: [osc] }), ev('s2_review_resumed', { decision: 'continue', boundaries: [{ ref: 'F-9', choice: 'prior' }] })]), 'send_fix');
  const fb = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: acc('nit'), escalated_claims: ['q'] }), ev('s2_review_escalated', { reason: 'r' })];
  assert.equal(st([...fb, cont()]), 'send_fix', 'a reviewer\'s nit on the PR is still fixed');
  assert.equal(continueOutcome(fb), 'fix');
  const failed = [ev('s2_result'), ev('s2_review_findings', { kind: 'blind', round: 1, files: ['a.json'] }), ev('s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }), ev('s2_triage_done', { kind: 'blind', round: 1, failed: true, error: 'x' })];
  assert.equal(continueOutcome(failed), 'retry');
  assert.equal(continueOutcome([ev('s2_result')]), undefined, 'a lane not waiting for penne has no continue');
});

// a review of the same code as a judgement already within the limit is not run again
test('the head a whole-diff blind saw is settled only when its judgement is within the limit and nothing was mapped', () => {
  const round1 = (started, accepted, extra = {}) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], ...started }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: [] }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted, ...extra })];
  assert.equal(settledHead(round1({ head: 'H1' }, acc('should', 'nit'))), 'H1');
  assert.equal(settledHead(round1({ head: 'H1', mapped_routes: 2, whole_run_ids: ['B'] }, acc('nit'))), undefined, 'a mapped round did not read the whole diff');
  assert.equal(settledHead(round1({ head: 'H1' }, acc('must'))), undefined);
  assert.equal(settledHead(round1({}, acc('nit'))), undefined, 'a record without the head settles nothing');
  const osc = { ref: 'F-9', severity: 'should', claim: 'x', prior_ref: 'p', prior: 'a', current: 'b' };
  assert.equal(settledHead(round1({ head: 'H1' }, [], { oscillations: [osc] })), undefined);
  // the last whole-diff blind decides: a final that has not been judged yet settles nothing
  assert.equal(settledHead([...round1({ head: 'H1' }, []), ev('s2_review_started', { kind: 'final', round: 1, run_ids: ['F'], head: 'H1' })]), undefined);
  const fin = [...round1({ head: 'H1' }, acc('must')), ev('s2_fix_sent', { round: 1 }), ev('s2_result'), ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['F'], head: 'H2' }), ev('s2_triage_done', { kind: 'final', round: 2, accepted: acc('nit') })];
  assert.equal(settledHead(fin), 'H2');
});

test('continuing after a blind\'s question on a head already settled says it converges, as the final review is skipped', () => {
  const e = [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, head: 'H1' }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: acc('nit'), escalated_claims: ['q'] }), ev('s2_review_escalated', { reason: 'q' })];
  assert.equal(continueOutcome(e), 'close');
  assert.equal(continueOutcome(question('blind', acc('nit'))), 'final', 'without a head on record the final review runs');
});

test('a head a blind read is no longer settled once a fix was sent after it', () => {
  // round 1: a nit and a question; penne continues with a note, the fix moves the code, the confirm's leftovers ask again
  const e = [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, head: 'H1' }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: acc('nit'), escalated_claims: ['q1'] }), ev('s2_review_escalated', { reason: 'q' }), cont('A 案で直す'),
    ev('s2_fix_sent', { round: 1, refs: [] }), ev('s2_result'), ev('s2_confirm_started', { round: 1, run_id: 'C' }),
    ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 1, files: ['c.json'] }),
    ev('s2_triage_done', { kind: 'confirm', round: 1, accepted: acc('nit'), escalated_claims: ['q2'] }), ev('s2_review_escalated', { reason: 'q' })];
  assert.equal(settledHead(e), undefined);
  assert.equal(continueOutcome(e), 'final', 'the card says the final review runs, as it will');
  assert.deepEqual(reviewLoopState([...e, cont()]), { state: 'start_blind', kind: 'final', round: 2 });
});

test('a blind round some of whose roles failed did not read the whole diff with every role: its head is not settled', () => {
  const round1 = (findings) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['A', 'B', 'C'], head: 'H1' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['c.json'], ...findings }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: acc('nit') })];
  assert.equal(settledHead(round1({ failed_runs: 2 })), undefined);
  assert.equal(settledHead(round1({ failed_runs: 0 })), 'H1');
  assert.equal(settledHead(round1({})), 'H1', 'a record without the count is taken as complete, as it always was');
  const q = [...round1({ failed_runs: 1 })];
  q[3] = ev('s2_triage_done', { kind: 'blind', round: 1, accepted: acc('nit'), escalated_claims: ['q'] });
  assert.equal(continueOutcome([...q, ev('s2_review_escalated', { reason: 'q' })]), 'final', 'the card says the final review runs');
});

test('continuing after a question on PR feedback that accepted nothing leaves the code as it is, as without the question', () => {
  const fb = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: [], escalated_claims: ['返信の要否'] }), ev('s2_review_escalated', { reason: 'q' })];
  assert.equal(st(fb), 'escalated');
  assert.equal(st([...fb, cont()]), 'done', 'no empty fix is sent to the executor');
  assert.equal(continueOutcome(fb), 'close');
  assert.equal(st([...fb, cont('この方針で直す')]), 'send_fix', 'a note is still an instruction to fix');
  const left = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: acc('nit') }), ev('s2_fix_sent', { round: 1, refs: ['F-1'] }), ev('s2_result'),
    ev('s2_confirm_done', { round: 1, unresolved_requests: 1, files: [] }), ev('s2_triage_done', { kind: 'confirm', accepted: [], escalated_claims: ['q'] }), ev('s2_review_escalated', { reason: 'q' })];
  assert.deepEqual(reviewLoopState([...left, cont()]), { state: 'start_blind', kind: 'final', round: 2 });
  assert.equal(st([...fb.slice(0, -2), ev('s2_triage_done', { kind: 'feedback', accepted: acc('nit'), escalated_claims: ['q'] }), ev('s2_review_escalated', { reason: 'q' }), cont()]), 'send_fix', 'a reviewer\'s nit is still fixed');
});

test('going on from a stop at the device check or its judgement runs the device check again', () => {
  const dev = [ev('s2_result'), ev('s2_review_converged'), ev('s2_device_started', { round: 1, run_id: 'D' })];
  assert.equal(acceptDevice([...dev, ev('s2_device_done', { round: 1, failed: true, error: 'x' })]), 'again');
  assert.equal(acceptDevice([...dev, ev('s2_device_done', { round: 1, blocking: 2, files: [] }), ev('s2_triage_done', { kind: 'device', accepted: acc('must', 'must'), escalated_claims: ['q'] }), ev('s2_review_escalated', { reason: 'q' })]), 'again');
  assert.equal(acceptDevice(question('final', acc('nit'))), 'first');
});

test('work sent back from S4 after a loop that ended at a judgement or a continue is reviewed again', () => {
  const back = [ev('s3_ready'), ev('s3_ok'), ev('s4_submit_started'), ev('s4_verify_user_judgment_answered', { decision: 'revise' }), ev('s2_result')];
  const dev = [ev('s2_result'), ev('s2_review_converged'), ev('s2_device_started', { round: 1, run_id: 'D' }), ev('s2_device_done', { round: 1, blocking: 1, files: [] })];
  const judged = [...dev, ev('s2_triage_done', { kind: 'device', round: 1, accepted: acc('nit') })];
  assert.equal(st(judged), 'done');
  const asked = [...dev, ev('s2_triage_done', { kind: 'device', round: 1, accepted: acc('nit'), escalated_claims: ['q'] }), ev('s2_review_escalated', { reason: 'q' }), cont()];
  assert.equal(st(asked), 'done');
  const fb = [...s4(), ev('s2_triage_done', { kind: 'feedback', accepted: [], escalated_claims: ['q'] }), ev('s2_review_escalated', { reason: 'q' }), cont()];
  assert.equal(st(fb), 'done');
  for (const [name, e] of [['device judgement', judged], ['device question', asked], ['feedback question', fb]]) {
    assert.deepEqual(reviewLoopState([...e, ...back]), { state: 'start_blind', kind: 'blind', round: e.filter((x) => x.event === 's2_fix_sent').length + 1 }, name);
    assert.equal(st([...e, ev('s2_result')]), 'done', `${name}: a stray result is a duplicate`);
  }
});

// IDD-029: a should the confirm's judgement and the next final's judgement both accepted with action fix, never sent
// to a fix (one should is tolerated), and the loop converged. It must not leave the lane without a trace.
test('an accepted fix that no fix carried before the loop converged is written to the follow-ups (IDD-029)', () => {
  const regress = { ref: 'F-1', severity: 'should', claim: 'root commit で足した survey も除かれる', path: 'scripts/validate-survey.ts', fix: '最初の commit の追加も検査に通す', action: 'fix' };
  const e = [
    ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h1' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: '書き換え検査の穴', path: 'scripts/validate-survey.ts', fix: 'f', action: 'fix' }] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1'] }),
    ev('s2_result'),
    ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 1, unresolved_refs: [], files: ['/c.json'] }),
    ev('s2_triage_done', { kind: 'confirm', round: 1, accepted: [regress] }),
  ];
  assert.deepEqual(reviewLoopState(e), { state: 'start_blind', kind: 'final', round: 2 }, 'one should is tolerated, so no fix is sent');
  e.push(ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['F'], head: 'h2' }));
  e.push(ev('s2_review_findings', { kind: 'final', round: 2, files: ['/f.json'] }));
  e.push(ev('s2_triage_done', { kind: 'final', round: 2, accepted: [regress] }));
  assert.equal(st(e), 'converge');
  e.push(ev('s2_review_converged'));
  assert.equal(e.filter((x) => x.event === 's2_fix_sent').length, 1, 'no fix carried the regression');
  const f = followupsOf(e);
  assert.deepEqual(f.map((x) => [x.claim, x.severity, x.source]), [[regress.claim, 'should', 'unsent']], 'accepted twice, written once');
  // the must the fix carried is not a follow-up
  assert.ok(!f.some((x) => x.claim === '書き換え検査の穴'));
});

test('a pass whose blind recorded close_on must closes on no accepted must; one without it tolerates one should', () => {
  const two = [{ ref: 'F-1', severity: 'should', claim: 'a', path: 'a.ts', fix: 'f', action: 'fix' }, { ref: 'F-2', severity: 'should', claim: 'b', path: 'b.ts', fix: 'f', action: 'fix' }];
  const pass = (attrs, accepted) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', ...attrs }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted })];
  assert.deepEqual(reviewLoopState(pass({ close_on: 'must' }, two)), { state: 'start_blind', kind: 'final', round: 1 });
  assert.equal(st(pass({}, two)), 'send_fix', 'the old close condition tolerates one should only');
  assert.equal(st(pass({ close_on: 'must' }, [...two, { ref: 'F-3', severity: 'must', claim: 'm', path: 'a.ts', fix: 'f' }])), 'send_fix', 'an accepted must is always fixed');
  // what the close left unsent goes to the follow-ups
  assert.deepEqual(followupsOf(pass({ close_on: 'must' }, two)).map((x) => x.source), ['unsent', 'unsent']);
  // a final that closes on musts converges with shoulds accepted
  const fin = [...pass({ close_on: 'must' }, []), ev('s2_review_started', { kind: 'final', round: 1, run_ids: ['F'], head: 'h' }), ev('s2_triage_done', { kind: 'final', round: 1, accepted: two })];
  assert.equal(st(fin), 'converge');
  // the settled head of such a judgement is settled too, so the final of the same code is skipped
  assert.equal(settledHead(pass({ close_on: 'must' }, two)), 'h');
  assert.equal(settledHead(pass({}, two)), undefined);
});

test('a pass capped at max_fix_rounds asks penne for the boundary before its next fix; the old passes and S4 are not capped', () => {
  const must = (tag) => [{ ref: 'F-1', severity: 'must', claim: `must-${tag}`, path: 'a.ts', fix: 'f' }, { ref: 'F-2', severity: 'nit', claim: `nit-${tag}`, path: 'a.ts' }];
  const lap = (tag) => [ev('s2_triage_done', { kind: 'blind', round: 1, accepted: must(tag) }), ev('s2_fix_sent', { refs: ['F-1'] }), ev('s2_result'), ev('s2_confirm_done', { unresolved_must: 1, unresolved_should: 0, new_blocking: 0, files: [] })];
  const pass = (attrs) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', ...attrs }), ...lap('a'), ...lap('b'), ev('s2_triage_done', { kind: 'confirm', round: 2, accepted: must('c') })];
  const capped = reviewLoopState(pass({ max_fix_rounds: 2 }));
  assert.equal(capped.state, 'escalated');
  assert.match(capped.reason, /修正が 2 巡に達した（この回の上限 2 巡）。境目を決めてください: F-1（must）must-c/);
  assert.doesNotMatch(capped.reason, /nit-c/, 'the boundary lists what the fix would carry');
  assert.equal(st(pass({})), 'send_fix', 'without the cap on record the pass goes on to its lane-wide limit');
  assert.equal(st(pass({ max_fix_rounds: 3 })), 'send_fix');
  // penne's continue sends the third fix, and the next judgement stops again
  const resumed = [...pass({ max_fix_rounds: 2 }), ev('s2_review_escalated', { reason: capped.reason }), ev('s2_review_resumed', { decision: 'continue', note: '' })];
  assert.equal(st(resumed), 'send_fix');
  // a pass on PR feedback is never capped by a blind's record
  const s4 = [...pass({ max_fix_rounds: 1 }), ev('s2_review_converged'), ev('s3_ready'), ev('s4_review_comment_received', { files: ['/f.md'] }), ev('s2_triage_done', { kind: 'feedback', round: 3, accepted: must('d') }), ev('s2_fix_sent', { refs: ['F-1'] }), ev('s2_result'), ev('s2_confirm_done', { unresolved_must: 1, unresolved_should: 0, new_blocking: 0, files: [] }), ev('s2_triage_done', { kind: 'confirm', round: 3, accepted: must('e') })];
  assert.equal(st(s4), 'send_fix');
});

// ---- the `triage` value: a should the judgement recommended fixing keeps the pass open (IDD-093) ----

const basisShould = (ref, claim, extra = {}) => ({ ref, severity: 'should', claim, path: 'a.ts', fix: 'f', action: 'fix', fix_basis: 'halt', impact: 'engine が止まる', ...extra });
const triagePass = (attrs, accepted) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', close_on: 'must_and_fix', ...attrs }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted })];

test('the triage value closes only with no accepted must and no should the judgement recommended fixing', () => {
  assert.deepEqual(reviewLoopState(triagePass({}, [basisShould('F-1', '害のある should')])), { state: 'send_fix', round: 1 }, 'a fix-recommended should keeps the pass open');
  assert.equal(st(triagePass({}, [{ ref: 'F-1', severity: 'should', claim: 'a', path: 'a.ts', action: 'followup' }])), 'start_blind', 'a follow-up should closes as before');
  assert.equal(st(triagePass({}, [{ ref: 'F-1', severity: 'should', claim: 'a', path: 'a.ts', action: 'skip' }])), 'start_blind');
  assert.equal(st(triagePass({}, [{ ref: 'F-1', severity: 'should', claim: 'a', path: 'a.ts', action: 'later' }])), 'send_fix', 'an unreadable action is still fixed');
  assert.equal(st(triagePass({}, [{ ref: 'F-1', severity: 'must', claim: 'm', path: 'a.ts', action: 'followup' }])), 'send_fix', 'an accepted must is always fixed');
  assert.equal(st([...triagePass({}, []), ev('s2_review_started', { kind: 'final', round: 1, run_ids: ['F'], head: 'h' }), ev('s2_triage_done', { kind: 'final', round: 1, accepted: [basisShould('F-1', 'x')] })]), 'send_fix', 'a final does not close either');
  // the other values keep their own closures
  assert.equal(st([ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', close_on: 'must' }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [basisShould('F-1', 'x')] })]), 'start_blind');
  assert.equal(st([ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h' }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [basisShould('F-1', 'x')] })]), 'start_blind', 'the old close condition tolerates one should');
  assert.equal(st([ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h' }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [basisShould('F-1', 'x'), basisShould('F-2', 'y')] })]), 'send_fix', 'two shoulds are over the old condition');
});

test('the triage value removes the confirm\'s one-should tolerance; the other values keep it', () => {
  const confirm = (closeOn, unresolvedShould) => [
    ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', ...(closeOn ? { close_on: closeOn } : {}) }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_fix_sent', { round: 1 }), ev('s2_result'),
    ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: unresolvedShould, new_blocking: 0, files: ['c.json'] }),
  ];
  assert.equal(st(confirm('must_and_fix', 1)), 'start_triage', 'one unresolved should goes back to the judgement');
  assert.deepEqual(reviewLoopState(confirm('must_and_fix', 0)), { state: 'start_blind', kind: 'final', round: 2 });
  assert.equal(st(confirm('must', 1)), 'start_blind', 'the follow-up value tolerates one should');
  assert.equal(st(confirm(undefined, 1)), 'start_blind');
});

test('the triage value compares stagnation from zero, not from the one-should tolerance', () => {
  const tri = (n, tag) => ev('s2_triage_done', { kind: 'blind', accepted: Array.from({ length: n }, (_, i) => ({ ref: `F-${i}`, severity: 'should', claim: `${tag}-${i}`, path: 'a.ts' })) });
  const flat = (head) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', ...(head ? { close_on: head } : {}) }), tri(1, 'r1'), ev('s2_fix_sent'), tri(1, 'r2'), ev('s2_fix_sent'), tri(1, 'r3')];
  assert.match(stagnation(flat('must_and_fix')) ?? '', /減らない（1 → 1 → 1）/);
  assert.equal(stagnation(flat('must')), null, 'the follow-up value tolerates one should');
  assert.equal(stagnation(flat(undefined)), null);
});

test('the triage value stops for penne only when one judgement recommends more fixes than the cap', () => {
  const fixes = (n) => Array.from({ length: n }, (_, i) => basisShould(`F-${i}`, `c${i}`));
  const pass = (n, max) => triagePass(max === undefined ? {} : { max_should_fix: max }, fixes(n));
  assert.equal(st(pass(2, 2)), 'send_fix', 'exactly the cap goes on to the fix');
  assert.equal(st(pass(2, undefined)), 'send_fix', 'with no cap recorded the default of 2 applies');
  const over = reviewLoopState(pass(3, 2));
  assert.equal(over.state, 'escalated');
  assert.match(over.reason, /1 回の判定で fix を勧めた should が 3 件（この回の上限 2 件）。境目を決めてください: F-0（should）c0/);
  assert.equal(st(pass(3, 3)), 'send_fix', 'a larger cap lets the judgement through');
  assert.equal(st(pass(3, undefined)), 'escalated', '3 over the default of 2 stops');
  // penne's answer sends the fix and does not stop again on the same judgement
  const resumed = [...pass(3, 2), ev('s2_review_escalated', { reason: over.reason }), ev('s2_review_resumed', { decision: 'continue', note: '' })];
  assert.equal(st(resumed), 'send_fix');
  assert.equal(st([...pass(3, 2), ev('s2_review_escalated', { reason: over.reason }), ev('s2_review_resumed', { decision: 'accept', note: '' })]), 'converge');
  // the next judgement over the cap stops again: the answer does not carry over
  const next = [...resumed, ev('s2_fix_sent', { refs: ['F-0', 'F-1', 'F-2'] }), ev('s2_result'), ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 1, files: ['c.json'] }), ev('s2_triage_done', { kind: 'confirm', round: 1, accepted: fixes(3) })];
  assert.equal(st(next), 'escalated');
});

test('a judgement over the should-fix cap reports the cap whatever else it stops for', () => {
  const fixes = (n) => Array.from({ length: n }, (_, i) => basisShould(`F-${i}`, `c${i}`));
  const pass = (accepted, extra) => [
    ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', close_on: 'must_and_fix', max_should_fix: 2 }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted, ...extra }),
  ];
  const osc = { ref: 'F-9', severity: 'should', claim: '戻す', path: 'a.ts', prior_ref: '1-blind/F-1', prior: 'a', current: 'b' };
  // the question and the reversal branches no longer return before the cap: the shoulds the cap names stay on the card
  const question = reviewLoopState(pass(fixes(3), { escalated_claims: ['仕様が決まっていない'] }));
  assert.equal(question.state, 'escalated');
  assert.match(question.reason, /1 回の判定で fix を勧めた should が 3 件（この回の上限 2 件）。境目を決めてください: F-0（should）c0/);
  assert.match(question.reason, /判定が penne の判断を求めた指摘がある/, 'the question is not dropped');
  const reversal = reviewLoopState(pass(fixes(3), { oscillations: [osc] }));
  assert.equal(reversal.state, 'escalated');
  assert.match(reversal.reason, /1 回の判定で fix を勧めた should が 3 件（この回の上限 2 件）/);
  assert.match(reversal.reason, /往復/, 'the reversal is not dropped');
  // within the cap the question is the only stop, so the cap is not read where it does not apply
  assert.doesNotMatch(reviewLoopState(pass(fixes(2), { escalated_claims: ['仕様が決まっていない'] })).reason, /上限/);
  // penne's continue still sends all of them, the cap only says so before the fix goes
  const stop = reviewLoopState(pass(fixes(3), { escalated_claims: ['仕様が決まっていない'] }));
  assert.equal(st([...pass(fixes(3), { escalated_claims: ['仕様が決まっていない'] }), ev('s2_review_escalated', { reason: stop.reason }), ev('s2_review_resumed', { decision: 'continue', note: '' })]), 'send_fix');
});

test('a fix the confirm found unresolved does not vanish when a later judgement reads it back as a follow-up', () => {
  const confirm = (unresolved) => ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: unresolved.length, unresolved_refs: unresolved, new_blocking: 0, files: ['c.json'] });
  const readback = ev('s2_triage_done', { kind: 'confirm', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: '黙って欠ける', path: 'a.ts', action: 'followup', claimed_action: 'fix' }] });
  const pass = (c) => [
    ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', close_on: 'must_and_fix', max_should_fix: 2 }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [basisShould('F-1', '黙って欠ける')] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1'] }),
    ev('s2_result'),
    c,
    readback,
  ];
  const unresolved = followupsOf(pass(confirm(['F-1'])));
  assert.equal(unresolved.length, 1, 'the finding stays somewhere instead of disappearing');
  assert.equal(unresolved[0].claim, '黙って欠ける');
  // it was read back as a follow-up, so it is not a leftover again
  assert.deepEqual(submitLeftovers(pass(confirm(['F-1']))), []);
  // a finding the confirm showed fixed is not listed: the fix carried it and the confirm agreed
  assert.deepEqual(followupsOf(pass(confirm([]))), []);
});

test('the should-fix count reads one judgement set, dedupes by path|claim, and lets a basis-shown fix win', () => {
  const run = (accepted) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h', close_on: 'must_and_fix' }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted })];
  assert.deepEqual(shouldFixCounts(run([basisShould('F-1', '同じ指摘'), { ref: 'F-2', severity: 'should', claim: '後続', path: 'b.ts', action: 'followup' }])), { accepted: 2, fix: 1, fixWithoutBasis: 0 });
  // the read-back mark counts apart: the judgement wrote fix but the basis was missing
  assert.deepEqual(shouldFixCounts(run([{ ref: 'F-1', severity: 'should', claim: 'x', path: 'a.ts', action: 'followup', claimed_action: 'fix' }])), { accepted: 1, fix: 0, fixWithoutBasis: 1 });
  // the same finding in a later judgement is one item, and any judgement that showed a basis wins
  const two = [...run([basisShould('F-1', '同じ指摘'), { ref: 'F-2', severity: 'should', claim: '後続', path: 'b.ts', action: 'followup' }]), ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['F'], head: 'h' }), ev('s2_triage_done', { kind: 'final', round: 2, accepted: [{ ref: 'F-3', severity: 'should', claim: '同じ指摘', path: 'a.ts', action: 'followup', claimed_action: 'fix' }] })];
  assert.deepEqual(shouldFixCounts(two), { accepted: 2, fix: 1, fixWithoutBasis: 0 });
  // a legacy action fix with no basis and no read-back mark counts as neither fix nor basis-less
  assert.deepEqual(shouldFixCounts(run([{ ref: 'F-1', severity: 'should', claim: 'x', path: 'a.ts', action: 'fix' }])), { accepted: 1, fix: 0, fixWithoutBasis: 0 });
});

// ---- IDD-057: the conflict send-back moves the round number on, and its round continues the pass before it ----

const closedPass = [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h1' }), ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [] }), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready')];
const harnessSendBack = (head) => [ev('s4_verify_user_judgment_answered', { outcome: 'revise', by: 'harness' }), ev('s4_land_conflict', { head })];

test('a conflict send-back advances the round number, whatever its path', () => {
  const first = [...closedPass, ...harnessSendBack('h2'), ev('s2_result')];
  assert.deepEqual(reviewLoopState(first), { state: 'start_blind', kind: 'blind', round: 2 });
  const twice = [...first, ...harnessSendBack('h3'), ev('s2_result')];
  assert.equal(reviewLoopState(twice).round, 3);
  // the pair the harness writes is one send-back, not two
  assert.equal(conflictSendBacks([...first]).length, 1);
  // the S3 check's conflict, sent back by penne from the card, counts too
  const card = [...closedPass, ev('s3_check_conflict', { conflict_files: ['a.ts'] }), ev('s4_submit_started', { head: 'h2' }), ev('s4_verify_user_judgment_answered', { outcome: 'revise' }), ev('s2_result')];
  assert.equal(conflictSendBacks(card).length, 1);
  assert.equal(reviewLoopState(card).round, 2);
  // a check penne passed, and one whose later check came back clean, are not conflict send-backs
  const passed = [...closedPass, ev('s3_check_conflict', { conflict_files: ['a.ts'] }), ev('s4_submit_started', { head: 'h2' }), ev('s4_verify_user_judgment_answered', { outcome: 'revise' })];
  assert.equal(conflictSendBacks(passed).length, 1);
  const cleaned = [...closedPass, ev('s3_check_conflict', { conflict_files: ['a.ts'] }), ev('s3_check_clean', {}), ev('s4_submit_started', { head: 'h2' }), ev('s4_verify_user_judgment_answered', { outcome: 'revise' }), ev('s2_result')];
  assert.equal(conflictSendBacks(cleaned).length, 0);
  assert.equal(reviewLoopState(cleaned).round, 1, 'a send-back over a clean check is not a conflict send-back');
  // a send-back for another reason does not count either
  const other = [...closedPass, ev('s4_verify_user_judgment_answered', { outcome: 'revise' }), ev('s2_result')];
  assert.equal(conflictSendBacks(other).length, 0);
  assert.equal(reviewLoopState(other).round, 1);
});

test('a fix sent in a conflict scope round keeps that round number', () => {
  const must = [{ ref: 'F-1', severity: 'must', claim: 'x', path: 'a.ts', fix: 'f' }];
  const e = [...closedPass, ...harnessSendBack('h2'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 2, run_ids: ['B2'], head: 'h2', diff_scope: 'conflict' }),
    ev('s2_review_findings', { kind: 'blind', round: 2, files: ['/b2.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 2, accepted: must })];
  assert.equal(reviewLoopState(e).state, 'send_fix');
  assert.equal(reviewLoopState(e).round, 2);
  e.push(ev('s2_fix_sent', { round: 2 }));
  assert.deepEqual(reviewLoopState(e), { state: 'fixing', round: 2 });
});

test('a conflict scope round spends the fix rounds sent before the send-back, not a fresh cap', () => {
  const must = (tag) => [{ ref: 'F-1', severity: 'must', claim: `must-${tag}`, path: 'a.ts', fix: 'f' }];
  const lap = (tag) => [ev('s2_triage_done', { kind: 'blind', round: 1, accepted: must(tag) }), ev('s2_fix_sent', { refs: ['F-1'] }), ev('s2_result'), ev('s2_confirm_done', { unresolved_must: 1, unresolved_should: 0, new_blocking: 0, files: [] })];
  const history = (laps, { conflict = true } = {}) => [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h1', max_fix_rounds: 2 }), ...laps.flatMap((t) => lap(t)), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'), ...harnessSendBack('h2'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 2, run_ids: ['B2'], head: 'h2', ...(conflict ? { diff_scope: 'conflict' } : {}) }),
    ev('s2_review_findings', { kind: 'blind', round: 2, files: ['/b2.json'] }), ev('s2_triage_done', { kind: 'blind', round: 2, accepted: must('c') })];
  const spent = reviewLoopState(history(['a', 'b']));
  assert.equal(spent.state, 'escalated');
  assert.match(spent.reason, /上限 2 巡/);
  assert.equal(reviewLoopState(history(['a'])).state, 'send_fix', 'one fix before the send-back leaves room');
  // a whole-diff round after the send-back starts a new pass and a fresh cap
  assert.equal(reviewLoopState(history(['a', 'b'], { conflict: false })).state, 'send_fix');
});

test('the stagnation count compares only the judgements after the conflict send-back', () => {
  const tri = (n, tag) => ev('s2_triage_done', { kind: 'blind', accepted: Array.from({ length: n }, (_, i) => ({ ref: `F-${i}`, severity: 'should', claim: `${tag}-${i}`, path: 'a.ts' })) });
  const e = [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h1' }), tri(1, 'a'), ev('s2_fix_sent'), tri(1, 'b'), ev('s2_fix_sent'), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'), ...harnessSendBack('h2'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 2, run_ids: ['B2'], head: 'h2', diff_scope: 'conflict' }), tri(2, 'c')];
  assert.equal(stagnation(e), null);
  assert.equal(reviewLoopState(e).state, 'send_fix');
});

test('a conflict scope round continues the pass before it: the earlier follow-ups and unfixed items stay on record', () => {
  const e = [
    ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head: 'h1', close_on: 'must' }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [
      { ref: 'F-1', severity: 'should', claim: '前の回の follow-up', path: 'a.ts', action: 'followup' },
      { ref: 'F-2', severity: 'must', claim: '前の回の未修正 must', path: 'b.ts', action: 'fix' },
    ], escalated_claims: ['q'] }),
    ev('s2_review_escalated', { reason: 'q' }), ev('s2_review_resumed', { decision: 'accept', note: '' }),
    ev('s2_review_converged'), ev('s2_device_skipped'), ...harnessSendBack('h2'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 2, run_ids: ['B2'], head: 'h2', diff_scope: 'conflict' }),
    ev('s2_review_findings', { kind: 'blind', round: 2, files: ['/b2.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 2, accepted: [] }),
  ];
  assert.ok(followupsOf(e).some((f) => f.claim === '前の回の follow-up'));
  assert.ok(submitLeftovers(e).some((l) => l.claim === '前の回の未修正 must'));
  // the round's close condition is the one the pass's first blind recorded
  assert.equal(passPolicy(e).closeOnMust, true);
});

test('a conflict scope round after a PR feedback pass is a new pass of its own', () => {
  const e = [ev('s2_result'), ev('s4_review_comment_received', { files: ['/f.md'] }), ev('s2_triage_done', { kind: 'feedback', accepted: [] }), ev('s2_review_converged'), ev('s2_device_skipped'), ...harnessSendBack('h2'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 2, run_ids: ['B2'], head: 'h2', diff_scope: 'conflict', close_on: 'must', max_fix_rounds: 2 })];
  assert.equal(feedbackPassAt(e), -1);
  assert.deepEqual(passPolicy(e), { closeOnMust: true, closeOnFix: false, maxFixRounds: 2, start: 8 });
});

test('an order wait reads as a wait on the recorded lanes, and every order record after it lets the first review start', () => {
  const head = 'aaaa';
  const waiting = [ev('s2_start'), ev('s2_result'), ev('s2_order_waiting', { head, since: '2026-09-01T10:00:00+09:00', opponents: [{ lane: 'IDD-2', head: 'bbbb', files: ['app.txt'] }] })];
  assert.deepEqual(reviewLoopState(waiting), { state: 'awaiting_order', round: 1, opponents: [{ lane: 'IDD-2', head: 'bbbb', files: ['app.txt'] }] });
  assert.deepEqual(orderOpponentsOf(waiting.at(-1).attrs), [{ lane: 'IDD-2', head: 'bbbb', files: ['app.txt'] }]);
  assert.equal(reviewLoopLabel(reviewLoopState(waiting)), 'IDD-2 の取り込みを待っている（app.txt）');
  // the wait is shown in the waiting section, not as the executor's work
  assert.deepEqual(deriveStage(waiting).group, 'waiting');
  assert.equal(deriveStage(waiting).blockedBy, 'IDD-2 の取り込みを待っている（app.txt）');
  // every record that ends the wait or passes the check maps to the state before the first review
  for (const [event, attrs] of [['s2_order_passed', { head }], ['s2_order_released', { since: 'x', head }], ['s2_order_limit', { since: 'x', head }], ['s2_order_unknown', { head }]]) {
    const list = [...waiting, ev(event, attrs)];
    assert.deepEqual(reviewLoopState(list), { state: 'start_blind', kind: 'blind', round: 1 }, event);
    assert.equal(reviewLoopLabel(reviewLoopState(list)), 'レビュー待ち（1 巡目）', event);
  }
});

test('an order record that carries a position does not leave the lane idle', () => {
  for (const [event, attrs] of [['s2_order_passed', { head: 'h', order_at: 1700000000000 }], ['s2_order_released', { since: 'x', head: 'h', order_at: 1 }], ['s2_order_limit', { since: 'x', head: 'h', order_at: 1 }], ['s2_order_unknown', { head: 'h', order_at: 1 }]]) {
    const list = [ev('s2_result'), ev(event, attrs)];
    assert.deepEqual(reviewLoopState(list), { state: 'start_blind', kind: 'blind', round: 1 }, event);
  }
});

test('the label shows the place when one is given, and reads the same without it', () => {
  const waiting = reviewLoopState([ev('s2_result'), ev('s2_order_waiting', { head: 'h', since: '2026-09-01T10:00:00+09:00', opponents: [{ lane: 'IDD-2', files: ['app.txt'] }] })]);
  assert.equal(reviewLoopLabel(waiting), 'IDD-2 の取り込みを待っている（app.txt）');
  assert.equal(reviewLoopLabel(waiting, 2), 'IDD-2 の取り込みを待っている（2 番目・app.txt）');
});

test('a position comes from the first wait or the first review, and the rank counts the waiting chain', () => {
  const first = reviewLoopState([ev('s2_result'), ev('s2_order_waiting', { head: 'h', since: '2026-09-01T10:00:00+09:00', opponents: [] })]);
  assert.ok(first.state === 'awaiting_order');
  assert.deepEqual(orderPositionOf([ev('s2_result'), ev('s2_order_waiting', { head: 'h', since: '2026-09-01T10:00:00+09:00', opponents: [] }), ev('s2_order_released', { since: '2026-09-01T10:00:00+09:00', order_at: 1700000000000 })]), { at: Date.parse('2026-09-01T10:00:00+09:00'), lane: 'IDD-001' });
  // a determined record without a position time reads its own second-resolution time; a first review reads its own
  assert.equal(orderPositionOf([ev('s2_order_passed', { head: 'h' })]).at, Date.parse('2026-09-01T10:00:00+09:00'));
  assert.equal(orderPositionOf([ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] })]).at, Date.parse('2026-09-01T10:00:00+09:00'));
  assert.equal(orderPositionOf([ev('s2_result')]), undefined, 'a lane still implementing has no position');
  // the earlier time first, and the smaller number when two arrive at once
  assert.ok(compareOrder({ at: 1, lane: 'IDD-2' }, { at: 2, lane: 'IDD-1' }) < 0);
  assert.ok(compareOrder({ at: 1, lane: 'IDD-2' }, { at: 1, lane: 'IDD-10' }) < 0);
  // the rank counts the waiting lanes the opponents lead to, and a cycle stops
  const byLane = new Map([
    ['IDD-1', [ev('s2_result'), ev('s2_order_waiting', { head: 'h', since: 'x', opponents: [{ lane: 'IDD-2', files: ['app.txt'] }] })]],
    ['IDD-2', [ev('s2_result'), ev('s2_order_waiting', { head: 'h', since: 'x', opponents: [{ lane: 'IDD-1', files: ['app.txt'] }] })]],
    ['IDD-3', [ev('s2_result'), ev('s2_order_passed', { head: 'h' })]],
  ]);
  assert.equal(orderRankOf('IDD-1', byLane), 2, 'the other waiting lane is counted, and the cycle stops');
  assert.equal(orderRankOf('IDD-3', byLane), 1, 'an advanced lane is not counted');
});

test('the plan records of a delivery do not move the loop, its rounds or its fix count (AC-017)', () => {
  const e = [ev('s1_go'), ev('s2_start'), ev('s2_result', { outcome: 'success' }), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['A'] }), ev('s2_review_findings', { kind: 'blind', round: 1, files: ['a.json'] }), ev('s2_triage_started', { kind: 'blind', round: 1, run_id: 'T' }), ev('s2_triage_done', { kind: 'blind', round: 1, accepted: acc('must') })];
  const plan = [ev('fix_plan_started', { envelope_id: 'E-1', run_id: 'P-1' }), ev('fix_plan_done', { envelope_id: 'E-1', run_id: 'P-1', plan_path: '/tmp/p.md' })];
  const withPlan = [...e, ...plan];
  assert.deepEqual(reviewLoopState(withPlan), reviewLoopState(e), 'the state is the same as without the plan records');
  assert.equal(reviewLoopState(withPlan).state, 'send_fix');
  // the fix goes out as one round, exactly as it did without the plan records
  const sent = [...withPlan, ev('s2_fix_sent', { round: 1 })];
  const sentNoPlan = [...e, ev('s2_fix_sent', { round: 1 })];
  assert.deepEqual(reviewLoopState(sent), reviewLoopState(sentNoPlan));
  assert.deepEqual(fixCapReached(sent), fixCapReached(sentNoPlan), 'the plan records do not move the fix round count');
  assert.equal(stagnation(sent), stagnation(sentNoPlan));
  assert.deepEqual(fixCounts(readLifecycleOf(sent)), fixCounts(readLifecycleOf(sentNoPlan)));
});

/** the accepted items of the last judgement, as fixCounts reads them */
function readLifecycleOf(events) {
  const triage = [...events].reverse().find((x) => x.event === 's2_triage_done');
  return triage?.attrs?.accepted ?? [];
}

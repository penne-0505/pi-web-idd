import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptedAt, firstBlindOfPass, fixCapReached, followupsOf, reviewLoopState, reviewRounds, shouldFixCounts, stagnation } from '../src/ledger/review-loop.ts';

// The depth-bearing round (DEC-113-3): review → judgement → fix, with no confirm between the fix and the next
// review; when the judgement sends nothing to the fix the round goes on to the last review (deep), the kept check
// (standard and deep) or convergence (shallow). These tests read the state machine alone, from synthetic records.

const ID = 'IDD-001';
const ev = (event, attrs = {}) => ({ event, idd_id: ID, at: '2026-10-01T00:00:00Z', attrs });
const budget = { shallow: 1, standard: 2, deep: 3 };
const must = (ref) => ({ ref, severity: 'must', claim: `must ${ref}`, action: 'fix' });
const should = (ref) => ({ ref, severity: 'should', claim: `should ${ref}`, action: 'followup' });
/** the pass's first blind, which records its depth, budget and close condition */
const firstBlind = (depth, round = 1) => ev('s2_review_started', { kind: 'blind', round, run_ids: ['r'], depth, max_fix_rounds: budget[depth], close_on: 'must' });
const blind = (round) => ev('s2_review_started', { kind: 'blind', round, run_ids: ['r'] });
const findings = (kind, round) => ev('s2_review_findings', { kind, round, files: [] });
const triage = (kind, round, accepted = [], extra = {}) => ev('s2_triage_done', { kind, round, accepted, ...extra });
const fix = (round, refs) => ev('s2_fix_sent', { round, refs });
const result = () => ev('s2_result', { outcome: 'success' });

/** a pass up to (and including) the judgement that follows `fixes` fix rounds: the last judgement accepts `accepted` */
function passThrough(depth, fixes, accepted, extra = {}) {
  const events = [result(), ev('s2_start'), firstBlind(depth, 1), findings('blind', 1)];
  for (let n = 0; n <= fixes; n += 1) {
    if (n > 0) {
      events.push(fix(n, ['F-1']), result(), blind(n + 1), findings('blind', n + 1));
    }
    // every judgement before the last one sends its own must to the fix
    events.push(triage('blind', n + 1, n < fixes ? [must(`P-${n + 1}`)] : accepted, n < fixes ? {} : extra));
  }
  return events;
}

test('a depth-bearing round goes from the fix result to the next review, not to a confirm (AC-009)', () => {
  for (const depth of ['shallow', 'standard', 'deep']) {
    const events = [result(), ev('s2_start'), firstBlind(depth, 1), findings('blind', 1), triage('blind', 1, [must('F-1')]), fix(1, ['F-1'])];
    assert.equal(reviewLoopState(events).state, 'fixing', depth);
    // the result after the fix opens a review of the next round, not a confirm
    events.push(result());
    assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'blind', round: 2 }, depth);
    assert.notEqual(reviewLoopState(events).state, 'start_confirm');
  }
});

test('the round sends a fix while its depth budget holds, and asks penne once it is spent (AC-011)', () => {
  // shallow: one fix; a second judgement asking for a fix is the cap
  assert.equal(reviewLoopState(passThrough('shallow', 1, [must('F-1')])).state, 'escalated');
  // standard: two fixes hold, the third asks
  assert.deepEqual(reviewLoopState(passThrough('standard', 1, [must('F-1')])), { state: 'send_fix', round: 2 });
  assert.equal(reviewLoopState(passThrough('standard', 2, [must('F-1')])).state, 'escalated');
  // deep: three hold, the fourth asks
  assert.deepEqual(reviewLoopState(passThrough('deep', 2, [must('F-1')])), { state: 'send_fix', round: 3 });
  assert.equal(reviewLoopState(passThrough('deep', 3, [must('F-1')])).state, 'escalated');
});

test('the same finding coming back three times asks penne with the budget left (AC-012)', () => {
  const events = [
    result(), ev('s2_start'), firstBlind('deep', 1), findings('blind', 1), triage('blind', 1, [must('F-1')]),
    fix(1, ['F-1']), result(), blind(2), findings('blind', 2), triage('blind', 2, [must('F-1')]),
    fix(2, ['F-1']), result(), blind(3), findings('blind', 3), triage('blind', 3, [must('F-1')]),
  ];
  const st = reviewLoopState(events);
  assert.equal(st.state, 'escalated');
  assert.match(st.reason, /戻ってくる/);
});

test('what a fix sent is not added back to the next judgement: a fix that did not hold is found by the next blind (AC-004)', () => {
  // the judgement after a fix accepts nothing, so the round goes on to the last review: no ref of the fix is read back
  // as an unresolved must, whatever the record carries beside it
  const events = passThrough('deep', 1, []);
  assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'final', round: 2 });
  // a record from before `prior` was dropped still carries it: it is not read
  const old = passThrough('deep', 1, [], { prior: [{ ref: 'F-1' }, { ref: '1-blind/P-1' }] });
  assert.deepEqual(reviewLoopState(old), { state: 'start_blind', kind: 'final', round: 2 });
  assert.deepEqual(acceptedAt(old, old.length - 1).map((a) => a.ref), []);
});

test('acceptedAt scopes a depth-bearing round\'s refs by its round and kind, and reads only what the judgement accepted (AC-003, AC-004)', () => {
  const items = [must('F-1'), must('F-2')];
  const deep = [
    firstBlind('deep', 1),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: items }),
    fix(1, ['F-1', 'F-2']),
    ev('s2_triage_done', { kind: 'blind', round: 2, accepted: [must('F-3')], prior: [{ ref: 'F-1' }, { ref: 'F-2', resolved: true }, { ref: 'F-9' }] }),
  ];
  assert.deepEqual(acceptedAt(deep, 1).map((a) => a.ref), ['1-blind/F-1', '1-blind/F-2']);
  assert.deepEqual(acceptedAt(deep, 3).map((a) => a.ref), ['2-blind/F-3']);
  // a round with no depth keeps the bare name
  const legacy = [
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: items }),
    ev('s2_triage_done', { kind: 'blind', round: 2, accepted: [must('F-3')] }),
  ];
  assert.deepEqual(acceptedAt(legacy, 1).map((a) => a.ref), ['F-3']);
});

test('the map before a pass\'s first blind is not the blind done (AC-001)', () => {
  const map = ev('s2_map_started', { kind: 'blind', round: 1, run_id: 'm' });
  // the map does not end the wait for the pass's first blind
  assert.equal(firstBlindOfPass([result(), ev('s2_start'), map]), true);
  assert.equal(firstBlindOfPass([result(), ev('s2_start'), map, blind(1)]), false);
  // a converge still starts a new pass even with a map on record
  assert.equal(firstBlindOfPass([firstBlind('deep', 1), ev('s2_review_converged'), map]), true);
});

test('a depth-bearing round\'s device check with no fix ends the lane (AC-008)', () => {
  const events = [
    ...passThrough('deep', 0, []),
    findings('final', 1), triage('final', 1, []),
    findings('kept', 1), triage('kept', 1, []),
    ev('s2_review_converged'), ev('s2_device_started', { round: 1, run_id: 'd' }),
    ev('s2_device_done', { round: 1, blocking: 1, files: ['/d.json'] }), triage('device', 1, []),
  ];
  assert.deepEqual(reviewLoopState(events), { state: 'done' });
  // a device finding sent to the fix still sends the fix
  const withFix = events.slice(0, -1).concat([triage('device', 1, [must('D-1')])]);
  assert.deepEqual(reviewLoopState(withFix), { state: 'send_fix', round: 1 });
});

test('the same bare number in two rounds is not the same finding (AC-015)', () => {
  // round 1 sent a must as F-1; round 2 numbers a different problem F-1 again
  const events = [
    result(), ev('s2_start'), firstBlind('deep', 1), findings('blind', 1),
    triage('blind', 1, [must('F-1')]),
    fix(1, ['F-1']), result(), blind(2), findings('blind', 2),
    triage('blind', 2, [should('F-1'), { ref: 'F-2', severity: 'nit', claim: '別の nits', action: 'skip' }]),
  ];
  const out = acceptedAt(events, events.length - 1);
  assert.deepEqual(out.map((a) => [a.ref, a.severity, a.claim]), [
    ['2-blind/F-1', 'should', 'should F-1'],
    ['2-blind/F-2', 'nit', '別の nits'],
  ]);
  // the round-1 must was sent to the fix; nothing of it is an unresolved must now, so the round goes on
  assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'final', round: 2 });
});

test('a round closes toward the last review, then convergence, at every depth (AC-029, AC-030, AC-037, AC-038)', () => {
  // 2026-10-19: every depth runs the last review first (shallow and standard ran none before)
  // 2026-10-22: the kept check went with R2, so no depth starts one after the last review
  for (const depth of ['shallow', 'standard', 'deep']) {
    const events = passThrough(depth, 0, depth === 'shallow' ? [should('S-1')] : []);
    assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'final', round: 1 }, depth);
    events.push(findings('final', 1), triage('final', 1, []));
    assert.deepEqual(reviewLoopState(events), { state: 'converge' }, depth);
    assert.ok(!events.some((e) => e.event === 's2_review_started' && e.attrs?.kind === 'kept'), depth);
  }
  // a lane from before the removal whose kept check already ran still reads its judgement and converges
  const kept = passThrough('deep', 0, []);
  kept.push(findings('final', 1), triage('final', 1, []), findings('kept', 1), triage('kept', 1, []));
  assert.deepEqual(reviewLoopState(kept), { state: 'converge' });
});

test('a must the kept check accepts goes to penne when the budget is spent (AC-032)', () => {
  const events = passThrough('standard', 2, []);
  events.push(findings('kept', 2), triage('kept', 2, [must('K-1')]));
  assert.equal(reviewLoopState(events).state, 'escalated');
});

test('penne can add one round ("もう 1 巡"), and only one, past the budget (AC-044)', () => {
  const events = passThrough('shallow', 1, [must('F-1')]);
  assert.equal(reviewLoopState(events).state, 'escalated');
  events.push(ev('s2_review_resumed', { decision: 'continue', note: '' }));
  assert.deepEqual(reviewLoopState(events), { state: 'send_fix', round: 2 });
  // the raised budget lets the fix go, and the next judgement must asks again
  events.push(fix(2, ['F-1']), result(), blind(3), findings('blind', 3), triage('blind', 3, [must('F-1')]));
  assert.equal(reviewLoopState(events).state, 'escalated');
});

test('"見送り" closes the round with the musts left (AC-045)', () => {
  const events = passThrough('shallow', 1, [must('F-1')]);
  events.push(ev('s2_review_resumed', { decision: 'accept', note: '' }));
  assert.deepEqual(reviewLoopState(events), { state: 'converge' });
});

test('"自分で直す" waits for the hand work, then runs one review round (AC-046, AC-047)', () => {
  const events = passThrough('shallow', 1, [must('F-1')]);
  events.push(ev('s2_review_resumed', { decision: 'hand_fix', note: '' }));
  assert.deepEqual(reviewLoopState(events), { state: 'awaiting_hand_fix', round: 2 });
  events.push(ev('s2_hand_fixed'));
  assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'blind', round: 2 });
  // the hand-fix review sends no fix of its own: a must goes to penne, and no fix is sent
  events.push(blind(2), findings('blind', 2), triage('blind', 2, [must('F-2')]));
  assert.equal(reviewLoopState(events).state, 'escalated');
  assert.equal(events.filter((e) => e.event === 's2_fix_sent').length, 1);
});

test('the kept check\'s accepted shoulds are follow-ups and count in the round (AC-051)', () => {
  const events = [
    result(), ev('s2_start'), firstBlind('standard', 1), findings('blind', 1), triage('blind', 1, []),
    findings('kept', 1), triage('kept', 1, [{ ref: 'K-1', severity: 'should', claim: '記録のずれ', action: 'followup', path: 'a.ts' }]),
  ];
  const followups = followupsOf(events);
  assert.deepEqual(followups.map((f) => [f.severity, f.claim, f.path]), [['should', '記録のずれ', 'a.ts']]);
  const counts = shouldFixCounts(events);
  assert.equal(counts.accepted, 1);
  const rounds = reviewRounds(events);
  assert.deepEqual(rounds.map((r) => [r.kind, r.should]), [['blind', 0], ['kept', 1]]);
});

test('the plan records of a delivery do not change a depth-bearing pass (AC-017)', () => {
  const events = passThrough('standard', 1, [must('F-1')]);
  const plan = [ev('fix_plan_started', { envelope_id: 'E-1', run_id: 'P-1' }), ev('fix_plan_done', { envelope_id: 'E-1', run_id: 'P-1', plan_path: '/tmp/p.md' })];
  const i = events.findIndex((e) => e.event === 's2_fix_sent');
  // the plan records arrive between the fix and the result that follows it
  const withPlan = [...events.slice(0, i + 1), ...plan, ...events.slice(i + 1)];
  assert.deepEqual(reviewLoopState(withPlan), reviewLoopState(events), 'the pass stands where it stood');
  assert.equal(reviewRounds(withPlan).length, reviewRounds(events).length, 'the round count is unchanged');
  assert.deepEqual(fixCapReached(withPlan), fixCapReached(events), 'the depth budget reads the same');
  assert.equal(stagnation(withPlan), stagnation(events));
});

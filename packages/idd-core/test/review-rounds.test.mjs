import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewRounds } from '../src/ledger/review-loop.ts';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-10-05T10:00:00+09:00', attrs });
const acc = (ref, severity, action) => ({ ref, severity, claim: ref, path: 'a.ts', fix: 'f', ...(action ? { action } : {}) });

test('AC-003: a row per finished judgement, counts from what it accepted', () => {
  const rows = reviewRounds([
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [acc('F-1', 'must'), acc('F-2', 'should'), acc('F-3', 'nit')], rejected: [{ claim: 'r', severity: 'must' }] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1'] }),
    ev('s2_confirm_done', { round: 1, unresolved_refs: ['F-1'] }),
    ev('s2_triage_done', { kind: 'confirm', round: 1, accepted: [acc('F-4', 'should')] }),
    ev('s2_triage_done', { kind: 'final', round: 2, accepted: [] }),
  ]);
  assert.deepEqual(rows.map((r) => [r.round, r.kind, r.must, r.should, r.nit, r.open]), [
    [1, 'blind', 1, 1, 1, 3],
    [1, 'confirm', 0, 1, 0, 1],
    [2, 'final', 0, 0, 0, 0],
  ]);
});

test('AC-003: a failed judgement is no row, and a lane with no review records is an empty list', () => {
  assert.deepEqual(reviewRounds([ev('s1_go'), ev('s2_result')]), []);
  assert.deepEqual(reviewRounds([ev('s2_triage_done', { kind: 'blind', round: 1, failed: true, error: 'x', accepted: [acc('F-1', 'must')] })]), []);
});

test('AC-004 / INV-2241: the remaining count is accepted minus what a finished confirm showed fixed', () => {
  // (1) no fix yet: every accepted item remains
  const noFix = reviewRounds([ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [acc('F-1', 'must'), acc('F-2', 'should')] })]);
  assert.equal(noFix[0].open, 2);

  // (2) a fix carried F-1 / F-2, no confirm finished: both remain
  const sent = [
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [acc('F-1', 'must'), acc('F-2', 'should'), acc('F-3', 'nit')] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1', 'F-2'] }),
  ];
  assert.equal(reviewRounds(sent)[0].open, 3);

  // (3) the confirm lists only F-2 unresolved: F-1 is fixed, F-2 and the unsent F-3 remain
  const confirmed = [...sent, ev('s2_confirm_done', { round: 1, unresolved_refs: ['F-2'] })];
  const row = reviewRounds(confirmed)[0];
  assert.equal(row.open, 2);
  assert.equal(row.must + row.should + row.nit, 3);
  assert.equal(row.must + row.should + row.nit, 3 - row.open + row.open, 'accepted = fixed + remaining');

  // a failed confirm shows nothing fixed
  const failed = [...sent, ev('s2_confirm_done', { round: 1, failed: true, error: 'x', unresolved_refs: [] })];
  assert.equal(reviewRounds(failed)[0].open, 3);

  // (4) a follow-up / skipped item is never in the fix's refs, so it remains though the confirm resolved everything
  const followup = [
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [acc('F-1', 'should', 'followup'), acc('F-2', 'should', 'skip'), acc('F-3', 'should')] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-3'] }),
    ev('s2_confirm_done', { round: 1, unresolved_refs: [] }),
  ];
  assert.equal(reviewRounds(followup)[0].open, 2);

  // the invariant holds for every row built here
  for (const r of [...noFix, ...reviewRounds(sent), ...reviewRounds(confirmed), ...reviewRounds(followup)]) {
    assert.ok(r.open <= r.must + r.should + r.nit);
  }
});

test('AC-004: a confirm after the next fix does not take the earlier fix\'s items', () => {
  const rows = reviewRounds([
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [acc('F-1', 'must')] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1'] }),
    ev('s2_fix_sent', { round: 2, refs: ['F-1'] }),
    ev('s2_confirm_done', { round: 2, unresolved_refs: [] }),
  ]);
  assert.equal(rows[0].open, 1, 'the first judgement has no confirm before the next fix');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptedFindings } from '../src/ledger/finding-handlings.ts';
import { correctionsOfPayload } from '../src/ledger/write.ts';
import { acceptedAt, fixCounts, fixScope, followupsOf, submitLeftovers, unfixedOf } from '../src/ledger/review-loop.ts';
import * as reference from '../src/ledger/review-loop-reference.ts';
import { reviewFixEnvelope } from '../src/plan/review-loop.ts';
import { rowsHandedOver } from '../src/intent/moonbit-fold.ts';

// What a stopped card offers a person for every finding the last judgement accepted, and what each choice then does.
//
// The lane is the shape of IDD-265's seventh round: the judgement accepted a must it wants fixed, a should it left for a
// follow-up, a should to fix and a nit. A person decides each of them on the card; the engine declares, for every handling,
// whether the fix would then take the finding, reading the answer of the fold and no rule of its own.

const ev = (event, attrs = {}) => ({ idd_id: 'IDD-1', event, at: '2026-11-01T00:00:00Z', attrs });
const finding = (n, severity, action) => ({ ref: `F-${n}`, severity, claim: `claim ${n}`, action, path: `${n}.ts` });
const ACCEPTED = [finding(1, 'must', 'fix'), finding(2, 'should', 'followup'), finding(3, 'should', 'fix'), finding(4, 'nit', 'fix')];
const stopped = () => [
  ...['lane_open', 's1_go', 's2_start', 's2_result'].map((name) => ev(name)),
  ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b1'], depth: 'deep', max_fix_rounds: 3, close_on: 'must' }),
  ev('s2_triage_done', { kind: 'blind', round: 1, accepted: ACCEPTED }),
  ev('s2_review_escalated', { reason: '修正が 3 巡に達した' }),
];
const answered = (events, corrections, note = '') => [...events, ev('s2_review_resumed', { decision: 'continue', note, ...(corrections.length ? { corrections } : {}) })];
const find = (list, n) => list.find((f) => f.ref === `1-blind/F-${n}`);
const handling = (f, action) => f.handlings.find((h) => h.action === action);
const plain = (v) => JSON.parse(JSON.stringify(v));
const refsOf = (events) => fixScope(events).accepted.map((a) => a.ref).join(' ');
/** each handling as `action/weight/in|out`, a star on the one the finding stands at */
const handlingsLine = (f) => f.handlings.map((h) => `${h.action}/${h.severity}/${h.inFix ? 'in' : 'out'}${h.current ? '*' : ''}`).join(' ');

test('every accepted finding is listed with its weight, its handling and whether the fix takes it as it stands (AC-001)', () => {
  // the review loop never sends a nit the judgement left, whatever its handling says
  const lines = acceptedFindings(stopped()).map((f) => `${f.ref} ${f.severity} ${f.action} ${f.inFix}`).join(', ');
  assert.equal(lines, '1-blind/F-1 must fix true, 1-blind/F-2 should followup false, 1-blind/F-3 should fix true, 1-blind/F-4 nit fix false');
  // the judgement's own fix scope is the two that are sent: the old list (`open`) was this and no more
  assert.equal(refsOf(stopped()), '1-blind/F-1 1-blind/F-3');
});

test('a finding the judgement left for later can be fixed now, and a must can only be fixed or lowered and put off (AC-001, AC-004)', () => {
  const listed = acceptedFindings(stopped());
  assert.equal(handlingsLine(find(listed, 2)), 'fix/should/in followup/should/out* skip/should/out');
  // putting a must off lowers it: a must is the weight of what this change fixes
  assert.equal(handlingsLine(find(listed, 1)), 'fix/must/in* followup/should/out skip/should/out');
  // a nit is fixed only when a person chooses to, and left alone it is none of the three handlings
  assert.equal(handlingsLine(find(listed, 4)), 'fix/nit/in followup/nit/out skip/nit/out');
});

test('the refs the declaration says a press sends are the refs the fix is sent for (AC-003)', () => {
  const listed = acceptedFindings(stopped());
  // penne: fix F-2 now, put F-1 (a must) off, fix the nit, leave F-3 as it stands
  const picks = { 1: 'followup', 2: 'fix', 4: 'fix' };
  const pickOf = (f) => picks[f.ref.slice(-1)];
  const raw = listed.flatMap((f) => {
    const h = pickOf(f) && handling(f, pickOf(f));
    return h && !h.current ? [{ ref: f.ref, severity: h.severity, action: h.action, ...(f.severity === 'must' ? { reason: 'この変更では直さない' } : {}) }] : [];
  });
  const checked = correctionsOfPayload(stopped(), raw);
  assert.ok(!('error' in checked), checked.error);
  const declared = listed.filter((f) => (pickOf(f) ? handling(f, pickOf(f)).inFix : f.inFix)).map((f) => f.ref).join(' ');
  assert.equal(declared, '1-blind/F-2 1-blind/F-3 1-blind/F-4');
  assert.equal(refsOf(answered(stopped(), checked.corrections)), declared);
});

test('a must put off is recorded lowered and still reads as a must beside it, and leaves every count (AC-002)', () => {
  const evs = answered(stopped(), [{ ref: '1-blind/F-1', severity: 'should', action: 'followup', reason: 'この変更では直さない' }]);
  const t = evs.findLastIndex((e) => e.event === 's2_triage_done');
  const read = acceptedAt(evs, t).find((a) => a.ref === '1-blind/F-1');
  assert.equal([read.severity, read.action, read.judged_severity, read.correction_reason].join(' '), 'should followup must この変更では直さない');
  // not fixed, not counted, not unresolved: it waits as a follow-up
  assert.ok(!refsOf(evs).includes('F-1'));
  assert.equal(fixCounts(acceptedAt(evs, t)).must, 0);
  assert.ok(!unfixedOf(evs, t, undefined, '', false).accepted.some((a) => a.ref === '1-blind/F-1'));
  const followup = followupsOf(evs).find((f) => f.path === '1.ts');
  assert.equal(`${followup.severity} ${followup.judgedSeverity}`, 'should must');
  // a must set aside is listed on the submit card with both weights
  const aside = submitLeftovers(answered(stopped(), [{ ref: '1-blind/F-1', severity: 'should', action: 'skip' }])).find((l) => l.path === '1.ts');
  assert.equal(`${aside.severity} ${aside.judgedSeverity}`, 'should must');
  // the written reference reads the same record the same way
  assert.deepEqual(plain(reference.followupsOf(evs)), plain(followupsOf(evs)));
  assert.deepEqual(plain(reference.acceptedAt(evs, t)), plain(acceptedAt(evs, t)));
});

test('a must put off without a reason is refused, and the reason given is read back from the answer (AC-002)', () => {
  for (const reason of [undefined, '', '  ']) {
    const refused = correctionsOfPayload(stopped(), [{ ref: '1-blind/F-1', severity: 'should', action: 'followup', ...(reason === undefined ? {} : { reason }) }]);
    assert.ok('error' in refused && refused.error.includes('理由'), JSON.stringify(refused));
  }
  const given = correctionsOfPayload(stopped(), [{ ref: '1-blind/F-1', severity: 'nit', action: 'skip', reason: ' 後の変更で扱う ' }]);
  assert.ok(!('error' in given), given.error);
  const evs = answered(stopped(), given.corrections);
  const t = evs.findLastIndex((e) => e.event === 's2_triage_done');
  assert.equal(acceptedAt(evs, t).find((a) => a.ref === '1-blind/F-1').correction_reason, '後の変更で扱う');
  // a must lowered but still fixed is no decision to put it off, so it needs no reason and is recorded lowered
  assert.equal(correctionsOfPayload(stopped(), [{ ref: '1-blind/F-1', severity: 'should', action: 'fix' }]).corrections?.[0]?.severity, 'should');
  // a should needs no reason to be put off, and a must kept as a fix needs none either
  assert.ok(!('error' in correctionsOfPayload(stopped(), [{ ref: '1-blind/F-2', severity: 'nit', action: 'skip' }])));
  assert.deepEqual(correctionsOfPayload(stopped(), [{ ref: '1-blind/F-1', severity: 'must', action: 'fix' }]).corrections, []);
});

test('a finding no one corrected carries no judged weight, and an answer without corrections reads as the judgement did (AC-005)', () => {
  const evs = answered(stopped(), []);
  const t = evs.findLastIndex((e) => e.event === 's2_triage_done');
  assert.ok(acceptedAt(evs, t).every((a) => !('judged_severity' in a) && !a.corrected));
  assert.equal(refsOf(evs), '1-blind/F-1 1-blind/F-3');
  assert.ok(followupsOf(evs).every((f) => !('judgedSeverity' in f)));
  assert.ok(submitLeftovers(evs).every((l) => !('judgedSeverity' in l)));
});

test('a nit a person picks fix for is recorded, though the judgement already said fix (AC-004)', () => {
  const checked = correctionsOfPayload(stopped(), [{ ref: '1-blind/F-4', severity: 'nit', action: 'fix' }]);
  assert.ok(!('error' in checked), checked.error);
  assert.deepEqual(plain(checked.corrections), [{ ref: '1-blind/F-4', severity: 'nit', action: 'fix', reason: '' }]);
  // a should picked as it stands is still no correction
  assert.deepEqual(correctionsOfPayload(stopped(), [{ ref: '1-blind/F-3', severity: 'should', action: 'fix' }]).corrections, []);
});

test('the envelope names the list as the scope and the note as penne\'s addition (AC-006)', () => {
  const accepted = fixScope(stopped()).accepted;
  const withNote = reviewFixEnvelope('IDD-1', 1, accepted, 'F-2 は今直したい', 'review');
  assert.match(withNote, /accepted がこの変更で直す範囲/);
  assert.match(withNote, /user-note は penne の補足・理由で、範囲は決めない/);
  assert.match(withNote, /<user-note>F-2 は今直したい<\/user-note>/);
  assert.doesNotMatch(reviewFixEnvelope('IDD-1', 1, accepted, '', 'review'), /user-note は penne の補足/);
});

test('the answers asked of the fold are handed over once, however often the card is read (3-blind/F-2)', () => {
  const events = stopped();
  const first = plain(acceptedFindings(events));
  const handed = rowsHandedOver().lifecycle;
  // the same rows in another array: the answers it asks about are the same rows, so nothing more is handed over
  assert.deepEqual(plain(acceptedFindings([...events])), first);
  assert.equal(rowsHandedOver().lifecycle, handed);
});

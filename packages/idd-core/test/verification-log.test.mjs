import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildVerificationLog } from '../src/plan/verification-log.ts';

const criteria = [{ id: 'AC-001' }, { id: 'AC-002' }];
const ev = (event, at, attrs = {}) => ({ idd_id: 'IDD-1', event, at, attrs });

const T = (n) => `2026-10-13T0${n}:00:00Z`;

function log(events, rows = []) {
  return buildVerificationLog({ lane: 'IDD-1', criteria, events, rows });
}

test('AC-013: one entry per stage milestone, in time order, each with its own fields', () => {
  const entries = log([
    ev('s1_ready', T(1), { planner_session_id: 'p1' }),
    ev('s2_result', T(2), { outcome: 'success' }),
    ev('s2_triage_done', T(3), { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_triage_done', T(4), { kind: 'final', round: 2, accepted: [] }),
    ev('s3_check_clean', T(5)),
    ev('lane_close', T(6), { outcome: 'merged' }),
  ]);
  assert.equal(entries.length, 6);
  assert.deepEqual(entries.map((e) => e.stage), ['計画', '実装', 'レビュー', 'レビュー', '検査', '取り込み']);
  assert.deepEqual(entries.map((e) => e.at), [T(1), T(2), T(3), T(4), T(5), T(6)]);
  for (const e of entries) {
    assert.equal(typeof e.at, 'string');
    assert.ok(Array.isArray(e.commands));
    assert.equal(typeof e.acceptance.done, 'number');
    assert.equal(e.acceptance.total, 2);
    assert.ok(['PASS', 'PARTIAL', 'FAIL', 'BLOCKED'].includes(e.verdict));
    assert.ok(e.who);
  }
  assert.equal(entries[0].who, 'planner (p1)');
  assert.match(entries[2].commands[0], /blind 1 巡目/);
});

test('AC-013 (one per milestone): a landing and the lane_close it writes make one entry', () => {
  const entries = log([
    ev('s2_result', T(1), { outcome: 'success' }),
    ev('s4_land_merged', T(2), { branch: 'work-main', merge_commit: 'abcdef1234567890' }),
    ev('lane_close', T(2), { outcome: 'local' }),
    ev('s4_land_conflict', T(3), { conflict_files: ['a.ts'] }),
  ]);
  const landings = entries.filter((e) => e.stage === '取り込み');
  assert.equal(landings.length, 2, 'the merged landing is one entry, the later conflict another');
  assert.equal(landings[0].verdict, 'PASS');
  assert.match(landings[0].commands.join('\n'), /git merge: work-main → 本流 @ abcdef123/);
  assert.equal(landings[1].verdict, 'FAIL');
  assert.match(landings[1].commands.join('\n'), /衝突/);
  assert.ok(landings[1].next);
});

test('AC-013 (commands): a check entry carries the command that ran, not the event name', () => {
  const entries = log([
    ev('s3_check_conflict', T(1), { conflict_files: ['a.ts', 'b.ts'] }),
    ev('s4_push_held', T(2), { reason: 'R2 の指摘' }),
  ]);
  assert.match(entries[0].commands.join('\n'), /git merge-tree --write-tree: 衝突 2 件（a\.ts, b\.ts）/);
  assert.ok(!entries[0].commands.includes('s3_check_conflict'));
  assert.match(entries[1].commands.join('\n'), /git push: 保留（R2 の指摘）/);
  const close = log([ev('lane_close', T(1), { outcome: 'merged', final_qa_verified: ['AC-001'] })]);
  assert.match(close[0].commands.join('\n'), /lane_close: merged（確認済み 1 件）/);
});

test('AC-013 (evidence): the implementation commands are the evidence of its reports, and a check carries the command that ran', () => {
  const rows = [{ event: 'ac_reported', at: T(3), repo: 'demo', lane: 'IDD-1', source: 'result', items: [{ id: 'AC-001', status: 'verified', evidence: 'npm run test:core -- x: 12 passed' }] }];
  const entries = log([
    ev('s1_ready', T(1)),
    ev('s2_result', T(2), { outcome: 'success' }),
    ev('s2_result', T(3), { outcome: 'success' }),
    ev('s3_check_clean', T(4)),
  ], rows);
  const implementation = entries.find((e) => e.stage === '実装' && e.at === T(2));
  assert.deepEqual(implementation.commands, [], 'the evidence written after this moment is not read back into it');
  const later = entries.find((e) => e.stage === '実装' && e.at === T(3));
  assert.match(later.commands.join('\n'), /AC-001: npm run test:core -- x: 12 passed/);
  assert.match(entries.find((e) => e.stage === '検査').commands.join('\n'), /git merge-tree --write-tree: 衝突なし/);
});

test('AC-014: the verdict follows the record it came from', () => {
  const byEvent = (event, attrs) => log([ev(event, T(1), attrs)])[0].verdict;
  assert.equal(byEvent('s2_result', { outcome: 'success' }), 'PASS');
  assert.equal(byEvent('s2_result', { outcome: 'partial' }), 'PARTIAL');
  assert.equal(byEvent('s2_result', { outcome: 'failed' }), 'FAIL');
  assert.equal(byEvent('s2_triage_done', { failed: true, error: 'x' }), 'BLOCKED');
  assert.equal(byEvent('s2_triage_done', { accepted: [{ ref: 'F-1', severity: 'must', claim: 'c' }] }), 'FAIL');
  assert.equal(byEvent('s2_triage_done', { accepted: [{ ref: 'F-1', severity: 'should', claim: 'c', action: 'fix' }] }), 'FAIL');
  assert.equal(byEvent('s2_triage_done', { accepted: [{ ref: 'F-1', severity: 'should', claim: 'c', action: 'followup' }] }), 'PASS');
  assert.equal(byEvent('s2_triage_done', { accepted: [] }), 'PASS');
  assert.equal(byEvent('s3_check_clean', {}), 'PASS');
  assert.equal(byEvent('s3_check_conflict', { conflict_files: ['a.ts'] }), 'FAIL');
  assert.equal(byEvent('s4_push_held', { reason: 'r' }), 'BLOCKED');
  assert.equal(byEvent('lane_close', { outcome: 'merged' }), 'PASS');
  assert.equal(byEvent('s4_land_check_failed', { reason: 'r' }), 'FAIL');
});

test('AC-015: PARTIAL, FAIL and BLOCKED carry a next step; PASS does not', () => {
  const entries = log([
    ev('s1_ready', T(1)),
    ev('s2_result', T(2), { outcome: 'partial', qa_unverified: ['AC-002'] }),
    ev('s2_result', T(3), { outcome: 'success' }),
    ev('s2_triage_done', T(4), { failed: true, error: 'x' }),
    ev('lane_close', T(5), { outcome: 'merged' }),
  ]);
  for (const e of entries) {
    if (e.verdict === 'PASS') assert.equal(e.next, undefined, `${e.stage} PASS has no next`);
    else assert.ok(e.next && e.next.length > 0, `${e.stage} ${e.verdict} has a next`);
  }
  assert.match(entries.find((e) => e.verdict === 'PARTIAL').next, /AC-002/);
});

test('AC-016: a later record never changes an earlier entry', () => {
  const events = [
    ev('s1_ready', T(1)),
    ev('s2_result', T(2), { outcome: 'success' }),
    ev('s2_triage_done', T(3), { kind: 'blind', round: 1, accepted: [] }),
    ev('s3_check_clean', T(4)),
    ev('lane_close', T(5), { outcome: 'merged' }),
  ];
  const full = log(events);
  const cut = log(events.slice(0, 4));
  assert.deepEqual(cut, full.slice(0, 4));
  // a report written after the implementation does not change the implementation entry's AC progress
  const rows = [{ event: 'ac_reported', at: T(9), repo: 'demo', lane: 'IDD-1', source: 'result', items: [{ id: 'AC-001', status: 'verified', evidence: 'ran it' }] }];
  const withRows = log(events, rows);
  assert.deepEqual(withRows.slice(0, 4), full.slice(0, 4));
  // and a later event added past the end leaves the earlier ones as they were
  const longer = log([...events, ev('s2_result', T(6), { outcome: 'partial', qa_unverified: ['AC-001'] })]);
  assert.deepEqual(longer.slice(0, 5), full);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { followupsOf } from '../src/ledger/review-loop.ts';
import { findingsForPaths, foldPlaceFindings, placeFindingsFrom } from '../src/plan/place-findings.ts';

const T = (n) => `2026-10-13T${String(n).padStart(2, '0')}:00:00Z`;
const ev = (idd, event, at, attrs = {}) => ({ idd_id: idd, event, at, attrs });

/** a lane whose one blind round accepted a should-with-line and an unsent nit without one */
function laneEvents(idd, { head = 'H1', extra = [] } = {}) {
  return [
    ev(idd, 's2_review_started', T(1), { kind: 'blind', round: 1, head }),
    ev(idd, 's2_triage_done', T(2), {
      kind: 'blind',
      round: 1,
      accepted: [
        { ref: 'F-1', severity: 'should', claim: 'c with a line', path: 'lib/a.ts', action: 'followup', line: 12 },
        { ref: 'F-2', severity: 'nit', claim: 'c without a line', path: 'lib/b.ts', action: 'followup' },
      ],
    }),
    ...extra,
  ];
}

const placed = (over = {}) => ({
  event: 'finding_placed', at: T(3), repo: 'Demo', lane: 'IDD-001', id: 'F-1-1', round: 1,
  path: 'lib/a.ts', lines: [3, 3], commit: 'H1', severity: 'should', claim: 'c',
  ...over,
});

test('AC-017: a should/nit with a path becomes a finding, with a range when its judgement had a line', () => {
  const events = laneEvents('IDD-001');
  const followups = followupsOf(events);
  const pending = placeFindingsFrom({ lane: 'IDD-001', events, followups, rows: [] }).pending;
  assert.equal(pending.length, 2);
  const withLine = pending.find((p) => p.claim === 'c with a line');
  assert.deepEqual(withLine, { lane: 'IDD-001', round: 1, path: 'lib/a.ts', lines: [12, 12], commit: 'H1', severity: 'should', claim: 'c with a line' });
  const without = pending.find((p) => p.claim === 'c without a line');
  assert.equal(without.lines, null);
  assert.equal(without.commit, 'H1');
});

test('AC-018: a must, a finding with no path and an R2 item never become findings', () => {
  const events = [
    ev('IDD-001', 's2_review_started', T(1), { kind: 'blind', round: 1, head: 'H1' }),
    ev('IDD-001', 's2_triage_done', T(2), {
      kind: 'blind', round: 1,
      accepted: [
        { ref: 'F-1', severity: 'must', claim: 'a must', path: 'lib/a.ts', action: 'followup' },
        { ref: 'F-2', severity: 'should', claim: 'no path', action: 'followup' },
      ],
    }),
  ];
  const pending = placeFindingsFrom({ lane: 'IDD-001', events, followups: followupsOf(events), rows: [] }).pending;
  assert.deepEqual(pending, []);
  const r2 = placeFindingsFrom({ lane: 'IDD-001', events, followups: [{ severity: 'should', claim: 'from r2', path: 'lib/a.ts', source: 'r2' }], rows: [] }).pending;
  assert.deepEqual(r2, []);
});

test('AC-020: the same lane, path and claim is one finding, however often it is collected', () => {
  const events = laneEvents('IDD-001');
  const followups = followupsOf(events);
  const first = placeFindingsFrom({ lane: 'IDD-001', events, followups, rows: [] }).pending;
  assert.equal(first.length, 2);
  const rows = first.map((p, i) => ({ ...placed({ id: `F-1-${i + 1}`, path: p.path, claim: p.claim, lines: p.lines, commit: p.commit, severity: p.severity }) }));
  assert.deepEqual(placeFindingsFrom({ lane: 'IDD-001', events, followups, rows }).pending, []);
  // a second judgement with the same words does not add one
  const again = [...events, ev('IDD-001', 's2_triage_done', T(4), { kind: 'final', round: 2, accepted: [{ ref: 'F-1', severity: 'should', claim: 'c with a line', path: 'lib/a.ts', action: 'followup', line: 12 }] })];
  assert.deepEqual(placeFindingsFrom({ lane: 'IDD-001', events: again, followups: followupsOf(again), rows }).pending, []);
});

test('AC-022 (commit): a follow-up whose round names no head is held, not placed with no commit', () => {
  const { pending, held } = placeFindingsFrom({
    lane: 'IDD-001',
    events: [],
    followups: [
      { severity: 'should', claim: 'no round', path: 'lib/a.ts' },
      { severity: 'nit', claim: 'a round with no review start', path: 'lib/b.ts', round: 3 },
    ],
    rows: [],
  });
  assert.deepEqual(pending, [], 'a finding without a commit is not created');
  assert.equal(held.length, 2);
  assert.equal(held[0].path, 'lib/a.ts');
  assert.ok(held[0].reason, 'the reason it stayed a follow-up is told');
});

test('AC-021: a finding does not reach another lane before its lane merged, and its own lane sees it', () => {
  const rows = [placed()];
  const open = [ev('IDD-001', 'lane_open', T(1))];
  assert.deepEqual(findingsForPaths({ rows, events: open, paths: ['lib/a.ts'], viewLane: 'IDD-002' }), []);
  assert.equal(findingsForPaths({ rows, events: open, paths: ['lib/a.ts'], viewLane: 'IDD-001' }).length, 1);
  const merged = [...open, ev('IDD-001', 'lane_close', T(5), { outcome: 'merged' })];
  assert.equal(findingsForPaths({ rows, events: merged, paths: ['lib/a.ts'], viewLane: 'IDD-002' }).length, 1);
  const local = [...open, ev('IDD-001', 'lane_close', T(5), { outcome: 'local' })];
  assert.equal(findingsForPaths({ rows, events: local, paths: ['lib/a.ts'], viewLane: 'IDD-002' }).length, 1);
  const aborted = [...open, ev('IDD-001', 'lane_close', T(5), { outcome: 'aborted' })];
  assert.deepEqual(findingsForPaths({ rows, events: aborted, paths: ['lib/a.ts'], viewLane: 'IDD-002' }), []);
  // a path that does not match is not delivered either
  assert.deepEqual(findingsForPaths({ rows, events: merged, paths: ['lib/z.ts'], viewLane: 'IDD-002' }), []);
});

test('AC-031: a "drop" takes effect once the writing lane merged, and not before', () => {
  const rows = [placed(), { event: 'finding_disposed', at: T(4), repo: 'Demo', lane: 'IDD-001', id: 'F-1-1', action: 'drop', reason: '範囲の外' }];
  const open = [ev('IDD-001', 'lane_open', T(1))];
  // the writing lane sees it disposed at once
  assert.equal(foldPlaceFindings(rows, open, 'IDD-001')[0].status, 'dropped');
  // another lane does not, until the lane merges
  assert.equal(foldPlaceFindings(rows, open, 'IDD-002')[0].status, 'open');
  const merged = [...open, ev('IDD-001', 'lane_close', T(5), { outcome: 'merged' })];
  const other = foldPlaceFindings(rows, merged, 'IDD-002')[0];
  assert.equal(other.status, 'dropped');
  assert.equal(other.reason, '範囲の外');
  assert.equal(other.disposedBy, 'IDD-001');
  assert.deepEqual(findingsForPaths({ rows, events: merged, paths: ['lib/a.ts'], viewLane: 'IDD-002' }), []);
});

test('AC-032: a "fix" declaration does not close the finding and names the declaring lane', () => {
  const rows = [placed(), { event: 'finding_disposed', at: T(4), repo: 'Demo', lane: 'IDD-001', id: 'F-1-1', action: 'fix' }];
  const merged = [ev('IDD-001', 'lane_close', T(5), { outcome: 'merged' })];
  const delivered = findingsForPaths({ rows, events: merged, paths: ['lib/a.ts'], viewLane: 'IDD-002' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].status, 'open');
  assert.equal(delivered[0].fixLane, 'IDD-001');
});

test('AC-033: a "drop" by a lane that ended without merging leaves the finding open to others', () => {
  const rows = [placed(), { event: 'finding_disposed', at: T(4), repo: 'Demo', lane: 'IDD-001', id: 'F-1-1', action: 'drop', reason: 'r' }];
  const aborted = [ev('IDD-001', 'lane_close', T(5), { outcome: 'aborted' })];
  assert.equal(foldPlaceFindings(rows, aborted, 'IDD-002')[0].status, 'open');
});

test('AC-032 (fix F-2): a lane\'s later disposition overrides its own earlier one', () => {
  const merged = [ev('IDD-001', 'lane_close', T(9), { outcome: 'merged' })];
  const disposed = (at, action, reason) => ({ event: 'finding_disposed', at: T(at), repo: 'Demo', lane: 'IDD-001', id: 'F-1-1', action, ...(reason ? { reason } : {}) });

  // "drop" then the same lane's "fix": the finding is open again and names the lane
  const reopened = foldPlaceFindings([placed(), disposed(4, 'drop', '範囲の外'), disposed(6, 'fix')], merged, 'IDD-002')[0];
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.fixLane, 'IDD-001');
  assert.equal(reopened.disposedBy, undefined);
  assert.equal(reopened.reason, undefined);
  assert.equal(findingsForPaths({ rows: [placed(), disposed(4, 'drop', '範囲の外'), disposed(6, 'fix')], events: merged, paths: ['lib/a.ts'], viewLane: 'IDD-002' }).length, 1);

  // "fix" then the same lane's "drop": the drop wins and the declaration is cleared
  const closed = foldPlaceFindings([placed(), disposed(4, 'fix'), disposed(6, 'drop', '範囲の外')], merged, 'IDD-002')[0];
  assert.equal(closed.status, 'dropped');
  assert.equal(closed.disposedBy, 'IDD-001');
  assert.equal(closed.fixLane, undefined);

  // another lane's "fix" does not reopen what this lane dropped
  const other = foldPlaceFindings([placed(), disposed(4, 'drop', '範囲の外'), { event: 'finding_disposed', at: T(6), repo: 'Demo', lane: 'IDD-002', id: 'F-1-1', action: 'fix' }], merged, 'IDD-002')[0];
  assert.equal(other.status, 'dropped');
  assert.equal(other.fixLane, 'IDD-002');
});

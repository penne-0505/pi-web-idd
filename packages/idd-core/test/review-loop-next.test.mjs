import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewNextStep } from '../src/ledger/review-loop-next.ts';
import { nextStepReference } from '../src/ledger/review-loop-next-reference.ts';

// The review loop's next step, as the running tick asks for it. The answer is the MoonBit fold's; these tests pin
// the answers whose fields the ledger's readers already depend on, so a field that comes back or goes away shows up
// here rather than in a lane's records. The last test holds the fold against the TypeScript reading over the same
// rows and the same facts: the committed part of what the cross-check does against a real ledger (C-201-1).

const row = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-10-19T10:00:00.000Z', attrs });

/** the rows of a lane whose map run is out */
const mappedLane = () => [
  row('lane_open'),
  row('s1_go'),
  row('s2_start'),
  row('s2_result'),
  row('s2_map_started', { kind: 'blind', round: 1, run_id: 'M1', head: 'abc123' }),
];

test('a finished map writes no fallbacks and no report the runner did not tell of', () => {
  const plain = reviewNextStep(mappedLane(), { runs: [{ state: 'done', routes: [{ id: 'r1' }] }] });
  assert.deepEqual(plain, {
    leg: 'map',
    action: 'write',
    event: 's2_map_done',
    attrs: { kind: 'blind', round: 1, routes: [{ id: 'r1' }], head: 'abc123' },
  });
  assert.ok(!('fallbacks' in plain.attrs), 'a round every wanted role ran leaves the field out');
  assert.ok(!('report_md' in plain.attrs), 'a report nobody told of is not recorded as an empty path');
  assert.ok(!('report_json' in plain.attrs));
});

test('a finished map writes the fallbacks and both reports the runner told of', () => {
  const changed = reviewNextStep(mappedLane(), {
    runs: [{ state: 'done', routes: [], reportMd: '/m.md', reportJson: '/m.json', fallbacks: [{ role: 'r', fallback: 'q', reason: 'x' }] }],
  });
  assert.deepEqual(changed.attrs, {
    kind: 'blind',
    round: 1,
    routes: [],
    report_md: '/m.md',
    report_json: '/m.json',
    head: 'abc123',
    fallbacks: [{ role: 'r', fallback: 'q', reason: 'x' }],
  });
});

test('a finished map records an empty report the runner did tell of', () => {
  const empty = reviewNextStep(mappedLane(), { runs: [{ state: 'done', routes: [], reportMd: '', reportJson: '' }] });
  assert.equal(empty.attrs.report_md, '', 'an empty text the runner gave is kept, not read as absent');
  assert.equal(empty.attrs.report_json, '');
});

test('a lane that resumed a stored blind start is sent to the blind, not stopped', () => {
  const events = [
    row('lane_open'),
    row('s1_go'),
    row('s2_start'),
    row('s2_result', { outcome: 'success' }),
    row('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f' }] }),
    row('s2_review_escalated', { reason: 'レビューの段を起動できない', retry_state: { state: 'start_blind', kind: 'blind', round: 2 } }),
    row('s2_review_resumed', { decision: 'continue', note: '続けて' }),
  ];
  assert.deepEqual(reviewNextStep(events, { reviewOn: true, blindFits: true }), { leg: 'blind', action: 'start', attrs: {}, stage: 'blind' });
  assert.deepEqual(
    reviewNextStep([...events.slice(0, 5), row('s2_review_escalated', { reason: 'r', retry_state: { state: 'start_blind', kind: 'final', round: 3 } }), events[6]], { reviewOn: true, blindFits: true }),
    { leg: 'blind', action: 'start', attrs: {}, stage: 'final' },
  );
});

/** the lanes whose next step the two readings are held against, with the facts the step reads that the rows do not hold */
const prefixes = [
  ['the map is out', mappedLane(), { runs: [{ state: 'done', routes: [], reportJson: '/m.json', reportMd: '/m.md', fallbacks: [{ role: 'r' }], findings: [{ severity: 'must', claim: 'c' }], skipped: 'why', runIds: ['R1'] }] }],
  ['the map still runs', mappedLane(), { runs: [{ state: 'running' }] }],
  ['the map failed', mappedLane(), { runs: [{ state: 'failed', error: 'boom' }] }],
  [
    'the blind was sent out and all its runs failed',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_started', { kind: 'kept', round: 1, run_ids: ['B1'] })],
    { runs: [{ state: 'failed', error: 'boom' }] },
  ],
  [
    'the blind finished',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'] })],
    { runs: [{ state: 'done', reportJson: '/b.json', runIds: ['B1'], fallbacks: [{ role: 'r' }] }] },
  ],
  [
    'the judgement is out',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_findings', { kind: 'blind', round: 1, files: ['/r1.json'] })],
    { triageFits: true, runs: [{ state: 'done', runIds: ['T1'], fallbacks: [{ role: 'r' }] }], means: [{ rule: 'r' }] },
  ],
  [
    'the judgement finished',
    [
      row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'),
      row('s2_review_findings', { kind: 'blind', round: 1, files: ['/r1.json'] }),
      row('s2_triage_started', { kind: 'blind', round: 1, run_id: 'T1' }),
    ],
    {
      runs: [{ state: 'done', reportJson: '/t.json', reportMd: '/t.md', fallbacks: [{ role: 'r' }] }],
      accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f' }],
      rejected: [{ ref: 'F-2', severity: 'nit', claim: 'n', reason: 'r' }],
      escalatedClaims: ['claim'],
    },
  ],
  [
    'the fix is out',
    [
      row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'),
      row('s2_review_findings', { kind: 'blind', round: 1, files: ['/r1.json'] }),
      row('s2_triage_started', { kind: 'blind', round: 1, run_id: 'T1' }),
      row('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f' }] }),
    ],
    { envelopeId: 'E-1', acceptedRefs: ['F-1'], hows: ['F-1'], boundaryRefs: ['F-2'], boundaryItems: [{ ref: 'F-2', severity: 'must', claim: 'c' }] },
  ],
  [
    'the confirm finished',
    [
      row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'),
      row('s2_review_findings', { kind: 'blind', round: 1, files: ['/r1.json'] }),
      row('s2_triage_started', { kind: 'blind', round: 1, run_id: 'T1' }),
      row('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f' }] }),
      row('s2_fix_sent', { round: 1, refs: ['F-1'], envelope_id: 'E-1' }),
      row('s2_confirm_started', { round: 1, run_id: 'C1' }),
    ],
    {
      runs: [{ state: 'done', reportJson: '/c.json', reportMd: '/c.md', fallbacks: [{ role: 'r' }], findings: [{ severity: 'must', claim: 'c' }] }],
      severities: [{ ref: 'F-1', severity: 'must' }, { ref: 'F-2', severity: 'nit' }],
      unresolved: ['F-1'],
      missing: ['F-3'],
    },
  ],
  [
    'the converged review waits for the device check',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_converged')],
    { deviceOn: true, verdict: { action: 'must', reason: 'r' }, pictures: 3 },
  ],
  [
    'the device check finished',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_converged'), row('s2_device_started', { round: 1, run_id: 'D1', judge: 'viewer' })],
    { runs: [{ state: 'done', reportJson: '/d.json', reportMd: '/d.md', skipped: 'why' }], judge: 'viewer' },
  ],
  [
    'the records check sent the lane back',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_records_conflict', { head: 'abc', errors: [{ rule: 'r', message: 'm' }] })],
    { queued: true, recordsHead: 'abc', recordsErrors: [{ rule: 'r', message: 'm' }] },
  ],
  [
    'a lane that stopped in the loop',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_escalated', { reason: '止まった', retry_state: { state: 'send_fix', round: 1 } })],
    {},
  ],
  [
    'a stop the judge noted on',
    [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_escalated', { reason: '止まった' }), row('s2_shape_started', { run_id: 'J1' }), row('s2_shape_judged', { run_id: 'J1' })],
    {},
  ],
];

test('the fold answers the next step the TypeScript reading gives, over the same rows and facts', () => {
  for (const [where, events, facts] of prefixes) {
    assert.deepEqual(JSON.parse(JSON.stringify(reviewNextStep(events, facts))), JSON.parse(JSON.stringify(nextStepReference(events, facts))), where);
  }
});

/** the head, origin and worktree every start of a round reads */
const AT = { worktree: '/wt', base: 'base-1', head: 'head-1' };

/** the policy a repo with the loop's own keys answers with */
const POLICY = { closeOnMust: false, closeOnFix: false, maxFixRounds: 8, maxShouldFix: 2, shouldDefault: 'fix', highRiskWhen: 'first', finalScope: 'whole', afterMerge: 'whole', finalWhen: 'always', extras: { first_round: 0, high_risk: 0 }, extraRoles: { first_round: [], high_risk: [] } };

/** the facts a round's start reads, with the round's copies and the map's slot free */
const startFacts = (extra = {}) => ({ reviewOn: true, mapOn: true, mapFits: true, blindFits: true, routeBlindFits: true, at: AT, policy: POLICY, ...extra });

/** a lane whose executor has reported and no round has begun */
const freshLane = () => [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result')];

/** a lane whose map drew one route at the head it reads */
const mappedRound = () => [
  ...freshLane(),
  row('s2_map_started', { kind: 'blind', round: 1, run_id: 'M1', head: AT.head }),
  row('s2_map_done', { kind: 'blind', round: 1, routes: [{ id: 'r1', paths: ['a.ts'], question: 'q', harms: [] }], head: AT.head }),
];

test('AC-004: a first review whose diff is mapped runs the map before the blind', () => {
  assert.deepEqual(reviewNextStep(freshLane(), startFacts()), { leg: 'blind', action: 'start', attrs: {}, stage: 'map' });
  // the runner says the diff needs no map: the blind runs without one and the record says why
  assert.deepEqual(reviewNextStep(freshLane(), startFacts({ mapSkipped: '差分 12 行（閾値 1000 行未満）' })), { leg: 'blind', action: 'start', attrs: {}, stage: 'blind' });
  // a map slot that cannot take it starts nothing
  assert.deepEqual(reviewNextStep(freshLane(), startFacts({ mapFits: false })), { leg: 'blind', action: 'nothing', attrs: {} });
  // no blind copy fits either
  assert.deepEqual(reviewNextStep(freshLane(), startFacts({ blindFits: false })), { leg: 'blind', action: 'nothing', attrs: {} });
});

test('AC-004: a slot nobody declared skips the round, and the record says it', () => {
  assert.deepEqual(reviewNextStep(freshLane(), { reviewOn: false, blindFits: true }), {
    leg: 'blind', action: 'write', event: 's2_review_skipped', attrs: { reason: 'pipeline.review_blind が未宣言' },
  });
});

test('AC-004: a head the map was drawn at moved is drawn again before the round reads it', () => {
  const moved = { ...AT, head: 'head-2' };
  assert.deepEqual(reviewNextStep(mappedRound(), startFacts({ at: moved })), {
    leg: 'blind', action: 'write', event: 's2_map_head_moved', attrs: { kind: 'blind', round: 1, map_head: AT.head, head: 'head-2' },
  });
});

test('AC-004: the map run the step started answers the map record', () => {
  assert.deepEqual(reviewNextStep(freshLane(), startFacts({ mapRun: { state: 'done', runIds: ['M1'], fallbacks: [{ role: 'r' }] } })), {
    leg: 'blind', action: 'write', event: 's2_map_started', attrs: { kind: 'blind', round: 1, run_id: 'M1', head: AT.head, fallbacks: [{ role: 'r' }] },
  });
  assert.deepEqual(reviewNextStep(freshLane(), startFacts({ mapRun: { state: 'failed', error: 'boom' } })), {
    leg: 'blind', action: 'write', event: 's2_map_done', attrs: { kind: 'blind', round: 1, failed: true, error: 'boom', routes: [] },
  });
});

test('AC-004: the round start records the runs, the routes and the pass it begins', () => {
  const step = reviewNextStep(mappedRound(), startFacts({
    mapSkipped: '差分 12 行（閾値 1000 行未満）',
    extras: ['first_round'],
    roundDepth: 'standard',
    depthFixRounds: 3,
    risk: { risk: 'High', high: true, hits: [{ kind: 'permission', paths: ['scripts/x.sh'], total: 1 }] },
    runs: [{ state: 'started', runIds: ['B1', 'B2'], runRoles: ['r', 'r'], runLabels: ['r1', 'r2'], wholeDiff: ['B1'], routeCount: 1, fallbacks: [{ role: 'r' }] }],
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(step)), {
    leg: 'blind', action: 'write', event: 's2_review_started',
    attrs: {
      kind: 'blind', round: 1, run_ids: ['B1', 'B2'], head: AT.head,
      run_roles: ['r', 'r'], run_labels: ['r1', 'r2'],
      mapped_routes: 2, route_count: 1, whole_run_ids: ['B1'],
      map_skipped: '差分 12 行（閾値 1000 行未満）',
      extras: ['first_round'],
      risk: 'High', risk_match: { hits: [{ kind: 'permission', paths: ['scripts/x.sh'], total: 1 }] },
      fallbacks: [{ role: 'r' }],
    },
  });
});

test('AC-003: a run the runner told nothing of does not stop the fold, and reads as running', () => {
  // a state the runner did not tell of is a run that has not finished: no record is written for it
  const blind = [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'] })];
  assert.deepEqual(reviewNextStep(blind, { runs: [{ reportJson: '/b.json', runIds: ['B1'] }] }), { leg: 'blind', action: 'nothing', attrs: {} });
});

test('AC-003: a start whose run names no id records the empty id, and a done run without a report is judged', () => {
  const triage = [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_findings', { kind: 'blind', round: 1, files: ['/r1.json'] })];
  assert.deepEqual(reviewNextStep(triage, { triageFits: true, runs: [{ state: 'done' }] }), {
    leg: 'triage', action: 'write', event: 's2_triage_started', attrs: { kind: 'blind', round: 1, run_id: '' },
  });
  // a done run that wrote no report is a run that finished: the round goes to its judgement, not to penne
  const blind = [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1', 'B2'] })];
  assert.deepEqual(reviewNextStep(blind, { runs: [{ state: 'done', runIds: ['B1'] }, { state: 'done', reportJson: '/b.json', runIds: ['B2'] }] }), {
    leg: 'blind', action: 'write', event: 's2_review_findings',
    attrs: { kind: 'blind', round: 1, files: ['/b.json'], failed_runs: 0 },
  });
});

test("AC-005: a stop is on record once: the judge's notes after it are no new stop, and a row that moves the loop is", () => {
  const stopped = [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_escalated', { reason: '収束しない' })];
  const notes = [row('s2_shape_started', { run_id: 'J1' }), row('s2_shape_judged', { run_id: 'J1', recommendation: { choice: 'replan' } })];
  for (const [events, where] of [[stopped, 'the stop'], [[...stopped, ...notes], 'the judge\'s notes'], [[...stopped, row('claude_quota_wait', {}), ...notes], 'a window wait and the notes']]) {
    assert.deepEqual(reviewNextStep(events, {}), { leg: 'escalate', action: 'nothing', attrs: {} }, `fold: ${where}`);
    assert.deepEqual(nextStepReference(events, {}), { leg: 'escalate', action: 'nothing', attrs: {} }, `reference: ${where}`);
  }
});

test('AC-003: a High final whose High role did not finish is put to penne, not judged', () => {
  const events = [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'),
    row('s2_review_started', { kind: 'final', round: 2, run_ids: ['F1'], run_roles: ['high'] })];
  const policy = { ...POLICY, highRiskWhen: 'last', extras: { first_round: 1, high_risk: 1 }, extraRoles: { first_round: [], high_risk: ['high'] } };
  const step = reviewNextStep(events, { policy, runs: [{ state: 'failed', error: 'x', runIds: ['F1'] }] });
  assert.equal(step.event, 's2_review_escalated');
  assert.deepEqual(step.attrs.retry_state, { state: 'start_blind', kind: 'final', round: 2 });
});

test('the fold answers the TypeScript reading over every start fact, and the same rows give the same step', () => {
  const moved = { ...AT, head: 'head-2' };
  const policyHigh = { ...POLICY, highRiskWhen: 'last', extras: { first_round: 1, high_risk: 1 }, extraRoles: { first_round: [], high_risk: ['high'] } };
  const lanes = [
    ['fresh', freshLane()],
    ['mapped', mappedRound()],
    ['stopped at final', [row('lane_open'), row('s1_go'), row('s2_start'), row('s2_result'), row('s2_review_started', { kind: 'final', round: 2, run_ids: ['F1'], run_roles: ['high'] })]],
  ];
  const factSets = [
    ['the map', startFacts()],
    ['the map skipped', startFacts({ mapSkipped: '差分 12 行' })],
    ['no map slot', startFacts({ mapFits: false })],
    ['no blind copy', startFacts({ blindFits: false })],
    ['the head moved', startFacts({ at: moved })],
    ['the map started', startFacts({ mapRun: { state: 'done', runIds: ['M1'] } })],
    ['the map failed', startFacts({ mapRun: { state: 'failed', error: 'boom' } })],
    ['the round started', startFacts({ runs: [{ state: 'started', runIds: ['B1'], runRoles: ['r'], runLabels: ['r1'], wholeDiff: ['B1'], routeCount: 1 }] })],
    ['the round started, no ids', startFacts({ runs: [{ state: 'started' }] })],
    ['the round started, no labels', startFacts({ runs: [{ state: 'started', runIds: ['B1'], wholeDiff: [] }] })],
    ['the High final', startFacts({ policy: policyHigh, extras: ['high_risk'], runs: [{ state: 'started', runIds: ['F1'], runRoles: ['high'] }] })],
    ['the confirm started', startFacts({ runs: [{ state: 'started', runIds: ['C1'] }], scopeRefs: [], scopeRefsGiven: true })],
    ['the undeclared slot', { reviewOn: false, blindFits: true }],
    ['no revs', startFacts({ at: undefined, runs: [{ state: 'started', runIds: ['B1'] }] })],
  ];
  for (const [where, events] of lanes) {
    for (const [what, facts] of factSets) {
      const mine = reviewNextStep(events, facts);
      const theirs = nextStepReference(events, facts);
      assert.deepEqual(JSON.parse(JSON.stringify(mine)), JSON.parse(JSON.stringify(theirs)), `${where} / ${what}`);
    }
  }
});

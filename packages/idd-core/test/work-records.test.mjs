import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentProgress, agentResult } from '../src/agent/inbound.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import {
  acStatesForLane, allCriteriaVerified, criterionStateOf, criteriaStates, foldResultEvents, isVerified,
  normalizeReportedItems, readWorkRows, workColumnPath,
} from '../src/plan/work-records.ts';
import { tmpDir } from './helpers/tmp.mjs';

function stateFor(area = 'Demo') {
  const dir = tmpDir('idd-work-');
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, 'backlog.jsonl'), `${JSON.stringify({
    idd_id: 'IDD-001', parent_id: null, created_at: '2026-10-13T00:00:00Z', linear_issue_url: null,
    gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 't', area,
  })}\n`);
  return dir;
}

function statesOf(lane = 'IDD-001', area = 'Demo') {
  return acStatesForLane({ lane, rows: readWorkRows( workColumnPath(area)), events: readLifecycle().filter((e) => e.idd_id === lane) });
}

function find(states, id) {
  return states.find((s) => s.id === id);
}

test('AC-001: progress and result append a work row with the lane, source and each AC state', async () => {
  stateFor();
  const progress = await agentProgress({ iddId: 'IDD-001', currentStep: 'doing', qaStatus: [{ qa_id: 'AC-001', status: 'in_progress' }], recentActivity: [] });
  assert.equal(progress.ok, true);
  const result = await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: ['a.ts'], commitCount: 1, qaVerified: ['AC-001'], qaUnverified: [], qaEvidence: { 'AC-001': 'npm run test:core -- work-records' } });
  assert.equal(result.ok, true);
  const rows = readWorkRows(workColumnPath('Demo'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'ac_reported');
  assert.equal(rows[0].lane, 'IDD-001');
  assert.equal(rows[0].source, 'progress');
  assert.deepEqual(rows[0].items, [{ id: 'AC-001', status: 'covered' }]);
  assert.equal(rows[1].source, 'result');
  assert.deepEqual(rows[1].items, [{ id: 'AC-001', status: 'verified', evidence: 'npm run test:core -- work-records' }]);
});

test('AC-002: an AC a report did not name keeps the state the report before it left', async () => {
  stateFor();
  await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: [], commitCount: 1, qaVerified: ['AC-001', 'AC-002', 'AC-003'], qaUnverified: [], qaEvidence: { 'AC-001': 'a', 'AC-002': 'b', 'AC-003': 'c' } });
  await agentProgress({ iddId: 'IDD-001', currentStep: 'fixing', qaStatus: [{ qa_id: 'AC-002', status: 'in_progress' }], recentActivity: [] });
  let states = statesOf();
  assert.equal(find(states, 'AC-001').status, 'verified');
  assert.equal(find(states, 'AC-002').status, 'covered');
  assert.equal(find(states, 'AC-003').status, 'verified');
  // a fix round's result that names only AC-003 leaves the others as they were
  await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: [], commitCount: 2, qaVerified: ['AC-003'], qaUnverified: [], qaEvidence: { 'AC-003': 'c2' } });
  states = statesOf();
  assert.equal(find(states, 'AC-001').status, 'verified');
  assert.equal(find(states, 'AC-003').evidence, 'c2');
});

test('AC-003: an AC named unverified again is no longer confirmed', async () => {
  stateFor();
  await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: [], commitCount: 1, qaVerified: ['AC-001'], qaUnverified: [], qaEvidence: { 'AC-001': 'a' } });
  await agentResult({ iddId: 'IDD-001', outcome: 'partial', changedFiles: [], commitCount: 2, qaVerified: [], qaUnverified: ['AC-001'] });
  const states = statesOf();
  assert.equal(find(states, 'AC-001').status, 'planned');
  assert.equal(isVerified(find(states, 'AC-001')), false);
});

test('AC-004: a verified with evidence is confirmed and keeps its evidence text', async () => {
  stateFor();
  await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: [], commitCount: 1, qaVerified: ['AC-004'], qaUnverified: [], qaEvidence: { 'AC-004': 'node --test x.test.mjs: 12 passed' } });
  const state = find(statesOf(), 'AC-004');
  assert.equal(state.status, 'verified');
  assert.equal(state.evidence, 'node --test x.test.mjs: 12 passed');
  assert.equal(criterionStateOf(state), 'done');
});

test('AC-005: a verified without evidence is recorded as covered, blank evidence too', async () => {
  stateFor();
  const result = await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: [], commitCount: 1, qaVerified: ['AC-005', 'AC-006'], qaUnverified: [], qaEvidence: { 'AC-006': '   ' } });
  assert.equal(result.ok, true);
  assert.match(result.warning, /AC-005/);
  assert.match(result.warning, /AC-006/);
  const rows = readWorkRows(workColumnPath('Demo'));
  assert.deepEqual(rows[0].items, [{ id: 'AC-005', status: 'covered', downgraded: true }, { id: 'AC-006', status: 'covered', downgraded: true }]);
  const states = statesOf();
  assert.equal(find(states, 'AC-005').status, 'covered');
  assert.equal(isVerified(find(states, 'AC-005')), false);
  assert.equal(criterionStateOf(find(states, 'AC-005')), 'doing');
});

test('AC-005 (fix): an evidence-less verified re-report does not take back an evidenced confirmation', async () => {
  stateFor();
  await agentProgress({ iddId: 'IDD-001', currentStep: 'doing', qaStatus: [{ qa_id: 'AC-001', status: 'verified', evidence: 'ran it' }], recentActivity: [] });
  assert.equal(isVerified(find(statesOf(), 'AC-001')), true);
  const result = await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: [], commitCount: 1, qaVerified: ['AC-001'], qaUnverified: [] });
  assert.equal(result.ok, true);
  assert.match(result.warning, /AC-001/);
  const state = find(statesOf(), 'AC-001');
  assert.equal(state.status, 'verified');
  assert.equal(state.evidence, 'ran it');
  assert.equal(isVerified(state), true);
  assert.equal(allCriteriaVerified([{ id: 'AC-001' }], statesOf()), true);
});

test('AC-001 (key): a two-digit report id names the plan criterion of the same number in every reader', async () => {
  stateFor();
  await agentResult({ iddId: 'IDD-001', outcome: 'success', changedFiles: [], commitCount: 1, qaVerified: ['AC-01', 'AC-02'], qaUnverified: [], qaEvidence: { 'AC-01': 'ran it', 'AC-02': 'ran it too' } });
  const states = statesOf();
  assert.equal(find(states, 'AC-01').status, 'verified');
  assert.equal(allCriteriaVerified([{ id: 'AC-001' }, { id: 'AC-002' }], states), true);
  assert.equal(allCriteriaVerified([{ id: 'AC-010' }], states), false, 'a different number stays a different criterion');
  assert.deepEqual(
    criteriaStates([{ id: 'AC-001', text: 'a' }, { id: 'AC-002', text: 'b' }], states).map((c) => [c.id, c.state]),
    [['AC-001', 'done'], ['AC-002', 'done']],
  );
});

test('AC-005 (unit): normalizeReportedItems drops an evidence-less verified and keeps the report', () => {
  const { items, dropped } = normalizeReportedItems([
    { id: 'AC-1', status: 'verified' },
    { id: 'AC-2', status: 'verified', evidence: ' ' },
    { id: 'AC-3', status: 'verified', evidence: 'ran it' },
  ]);
  assert.deepEqual(dropped, ['AC-1', 'AC-2']);
  assert.deepEqual(items, [{ id: 'AC-1', status: 'covered', downgraded: true }, { id: 'AC-2', status: 'covered', downgraded: true }, { id: 'AC-3', status: 'verified', evidence: 'ran it' }]);
});

test('AC-008: a lane with no work row is read from its s2_result records', async () => {
  const dir = stateFor();
  writeFileSync(join(dir, 'lifecycle-Demo.jsonl'), [
    JSON.stringify({ event: 's2_result', idd_id: 'IDD-001', at: '2026-10-13T01:00:00Z', attrs: { outcome: 'success', qa_verified: ['AC-001', 'AC-002'], qa_unverified: ['AC-003'] } }),
    JSON.stringify({ event: 's2_result', idd_id: 'IDD-001', at: '2026-10-13T02:00:00Z', attrs: { outcome: 'partial', qa_verified: ['AC-002'], qa_unverified: [] } }),
  ].join('\n') + '\n');
  const states = statesOf();
  assert.equal(find(states, 'AC-001').status, 'verified');
  assert.equal(isVerified(find(states, 'AC-001')), true, 'an older result read as the confirmation it always was');
  assert.equal(find(states, 'AC-002').status, 'verified');
  assert.equal(criterionStateOf(find(states, 'AC-001')), 'done');
  // the second result named only AC-002: AC-001 stays confirmed and AC-003 stays unconfirmed
  assert.equal(find(states, 'AC-003').status, 'planned');
  assert.deepEqual(allCriteriaVerified([{ id: 'AC-001' }, { id: 'AC-002' }], states), true);
});

test('AC-008 (unit): result records before a time are read without the later ones', () => {
  const events = [
    { event: 's2_result', idd_id: 'IDD-001', at: '2026-10-13T01:00:00Z', attrs: { qa_verified: ['AC-001'], qa_unverified: [] } },
    { event: 's2_result', idd_id: 'IDD-001', at: '2026-10-13T03:00:00Z', attrs: { qa_verified: [], qa_unverified: ['AC-001'] } },
  ];
  const cut = foldResultEvents(events, '2026-10-13T02:00:00Z');
  assert.equal(find(cut, 'AC-001').status, 'verified');
});

test('AC-038: three progress reports do not add a lifecycle record', async () => {
  const dir = stateFor();
  for (let i = 0; i < 3; i += 1) {
    await agentProgress({ iddId: 'IDD-001', currentStep: `step ${i}`, qaStatus: [{ qa_id: 'AC-001', status: 'in_progress' }], recentActivity: [] });
  }
  const lifecycle = join(dir, 'lifecycle-Demo.jsonl');
  const lines = existsSync(lifecycle) ? readFileSync(lifecycle, 'utf8').split('\n').filter(Boolean).length : 0;
  assert.equal(lines, 0, 'the work records live in their own column, not in lifecycle');
  assert.equal(readWorkRows(workColumnPath('Demo')).length, 3);
});

test('allCriteriaVerified: covered is not confirmed, not-applicable is, and no AC is not "all confirmed"', () => {
  const criteria = [{ id: 'AC-1' }, { id: 'AC-2' }];
  assert.equal(allCriteriaVerified(criteria, [{ id: 'AC-1', status: 'verified', evidence: 'x' }, { id: 'AC-2', status: 'not-applicable' }]), true);
  assert.equal(allCriteriaVerified(criteria, [{ id: 'AC-1', status: 'verified', evidence: 'x' }, { id: 'AC-2', status: 'covered' }]), false);
  assert.equal(allCriteriaVerified(criteria, [{ id: 'AC-1', status: 'verified', evidence: 'x' }]), false);
  assert.equal(allCriteriaVerified([], []), false);
});

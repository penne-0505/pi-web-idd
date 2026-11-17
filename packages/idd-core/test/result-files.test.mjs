import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';

import { agentResult } from '../src/agent/inbound.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { laneForkPoint } from '../src/plan/review.ts';
import { roundTrace } from '../src/ledger/derive.ts';
import { shapeSymptoms } from '../src/plan/shape-judge.ts';
import { changedFiles } from '../src/worktree/changed-files.ts';
import { git, put, commit, event, setup } from './stacked-fixture.mjs';

/**
 * The files a result record names as the lane's own are measured by the harness from the lane's fork point to HEAD,
 * so a mainline the executor merged in is not counted; the executor's list stands in only when it cannot be measured.
 */

const result = (iddId, changedFilesList) => agentResult({ iddId, outcome: 'success', changedFiles: changedFilesList, commitCount: 1, qaVerified: [], qaUnverified: [] });
const lastResult = (iddId) => readLifecycle().filter((e) => e.idd_id === iddId && e.event === 's2_result').pop();

/** the fixture's lane with one commit of its own adding `files` (name → text); the lane's worktree is `lane` */
function laneCommitting(files) {
  const f = setup();
  const lane = f.parent.path;
  for (const [name, text] of Object.entries(files)) put(join(lane, name), text);
  commit(lane);
  return { ...f, lane };
}

/** the mainline adds `names` (one commit on the work branch the lane was cut from) */
function mainlineAdds(f, ...names) {
  for (const name of names) put(join(f.work, name), `${name}\n`);
  commit(f.work);
}

/** the lane changed app.txt and own.txt; the mainline added main.txt and overlap/deep.txt and the executor merged them in */
function mergedLane() {
  const f = laneCommitting({ 'app.txt': 'ONE\ntwo\nthree\n', 'own.txt': 'own\n' });
  mainlineAdds(f, 'main.txt', 'overlap/deep.txt');
  git(f.lane, 'merge', '--no-edit', 'work-main');
  return f;
}

const reportedAll = ['app.txt', 'own.txt', 'main.txt', 'overlap/deep.txt'];
const recordOf = (iddId) => lastResult(iddId).attrs;

test('AC-001: a mainline merged into the lane is not in the result record, and what the lane changed is', async () => {
  const f = mergedLane();
  assert.equal((await result('IDD-1', reportedAll)).ok, true);
  const attrs = recordOf('IDD-1');
  assert.deepEqual([...attrs.changed_files].sort(), ['app.txt', 'own.txt']);
  assert.equal(attrs.changed_files_source, 'fork_point');
  assert.equal(attrs.changed_files_unmeasured, undefined);
  assert.ok(git(f.lane, 'rev-list', '--merges', '-n', '1', 'HEAD'), 'the lane really holds a merge of the mainline');
});

test('AC-002: the round line that folds the row has nothing outside the plan, and the shape symptoms say nothing of it', async () => {
  const f = mergedLane();
  event(f, 'IDD-1', 's1_go', { plan_scope: ['app.txt', 'own.txt'] });
  // the rows below go through the writer, so they share the stamp format of a real ledger (the ledger is read in stamp order)
  await result('IDD-1', reportedAll);
  await appendLifecycle('s2_triage_done', 'IDD-1', { kind: 'blind', round: 1, accepted: [{ severity: 'must', path: 'app.txt', claim: 'x', action: 'fix' }] });
  const lines = roundTrace(readLifecycle().filter((e) => e.idd_id === 'IDD-1'));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].outside_scope, []);
  assert.equal(lines[0].changed_files, 2);
  assert.ok(!shapeSymptoms(lines, 0).some((s) => s.includes('計画の範囲の外')));
});

test('AC-003: a lane that took no mainline in is measured from the same fork point as the screen', async () => {
  const f = laneCommitting({ 'app.txt': 'ONE\ntwo\nthree\n', 'deep/new.txt': 'new\n' });
  // the mainline moves on and the lane has not taken it in: its changes still start at the merge-base
  mainlineAdds(f, 'main.txt');
  await result('IDD-1', ['whatever.txt']);
  const fork = laneForkPoint('IDD-1', f.lane);
  assert.equal(fork, git(f.lane, 'merge-base', 'HEAD', 'work-main'));
  const screen = changedFiles(f.lane, fork).map((c) => c.path).sort();
  assert.deepEqual([...recordOf('IDD-1').changed_files].sort(), screen);
  assert.deepEqual(screen, ['app.txt', 'deep/new.txt']);
  assert.equal(recordOf('IDD-1').changed_files_source, 'fork_point');
});

test('the record is as of HEAD: an edit not yet committed is not in it', async () => {
  const f = laneCommitting({ 'app.txt': 'ONE\ntwo\nthree\n' });
  put(join(f.lane, 'other.txt'), 'edited\n');
  await result('IDD-1', ['app.txt', 'other.txt']);
  assert.deepEqual(recordOf('IDD-1').changed_files, ['app.txt']);
});

test('AC-004: a lane whose fork point cannot be read keeps the executor\'s list and says it was not measured', async () => {
  setup();
  // IDD-3 has no session at all, so there is no worktree to measure in
  assert.equal((await result('IDD-3', ['a.ts', 'b.ts'])).ok, true);
  const attrs = recordOf('IDD-3');
  assert.deepEqual(attrs.changed_files, ['a.ts', 'b.ts']);
  assert.equal(attrs.changed_files_source, 'reported');
  assert.match(attrs.changed_files_unmeasured, /worktree/);
});

test('AC-004: an executor that reported nothing still leaves the field, an empty list, when nothing could be measured', async () => {
  setup();
  await result('IDD-3', []);
  assert.deepEqual(recordOf('IDD-3').changed_files, []);
  assert.equal(recordOf('IDD-3').changed_files_source, 'reported');
});

test('AC-005: a list the executor reported that differs from the lane\'s diff does not reach the record', async () => {
  laneCommitting({ 'real.txt': 'real\n' });
  await result('IDD-1', ['invented.txt', 'other.txt']);
  assert.deepEqual(recordOf('IDD-1').changed_files, ['real.txt']);
});

test('a lane that changed nothing is measured as empty, not as a list the executor made up', async () => {
  setup();
  await result('IDD-1', ['invented.txt']);
  assert.deepEqual(recordOf('IDD-1').changed_files, []);
  assert.equal(recordOf('IDD-1').changed_files_source, 'fork_point');
});

const ROUND_ONE = { round: 1, accepted: [], kind: 'blind' };

/**
 * A lane that went back to its plan: the first plan's cycle changed `a.txt` and `shared.txt`; the second plan's cycle
 * (started at the HEAD the first one ended on) changes `b.txt`, `z.txt` (outside the second plan) and `shared.txt`
 * again, and the executor takes a mainline in during that cycle.
 */
async function replannedLane() {
  const f = laneCommitting({ 'a.txt': 'a\n', 'shared.txt': 'one\n' });
  const first = git(f.lane, 'rev-parse', 'HEAD~1');
  const firstCycle = [
    ['s1_go', { plan_scope: ['a.txt', 'shared.txt'] }],
    ['s2_start', { started_from_commit: first }],
    ['s2_result', { outcome: 'success', changed_files: ['a.txt', 'shared.txt'] }],
    ['s2_triage_done', ROUND_ONE],
    ['s1_replan_requested', {}],
    ['s1_go', { plan_scope: ['b.txt', 'shared.txt'] }],
    ['s2_start', { started_from_commit: git(f.lane, 'rev-parse', 'HEAD') }],
  ];
  for (const [name, attrs] of firstCycle) event(f, 'IDD-1', name, attrs);
  put(join(f.lane, 'b.txt'), 'b\n');
  put(join(f.lane, 'z.txt'), 'z\n');
  put(join(f.lane, 'shared.txt'), 'two\n');
  commit(f.lane);
  mainlineAdds(f, 'main.txt');
  git(f.lane, 'merge', '--no-edit', 'work-main');
  return f;
}

test('a lane that went back to its plan names the files of its current cycle beside the whole list', async () => {
  await replannedLane();
  await result('IDD-1', []);
  const attrs = recordOf('IDD-1');
  assert.deepEqual([...attrs.changed_files].sort(), ['a.txt', 'b.txt', 'shared.txt', 'z.txt']);
  assert.deepEqual([...attrs.cycle_files].sort(), ['b.txt', 'shared.txt', 'z.txt']);
  assert.equal(attrs.changed_files_source, 'fork_point');
});

test('the round lines of the second plan count the cycle\'s files: the first plan\'s file is not outside it', async () => {
  await replannedLane();
  await result('IDD-1', []);
  await appendLifecycle('s2_triage_done', 'IDD-1', ROUND_ONE);
  const lines = roundTrace(readLifecycle().filter((e) => e.idd_id === 'IDD-1'));
  const counted = lines.map((l) => [l.cycle, l.round, l.changed_files, l.outside_scope]);
  assert.deepEqual(counted, [[0, 1, 2, []], [1, 1, 3, ['z.txt']]]);
  assert.ok(shapeSymptoms(lines, 1).some((s) => s.includes('z.txt')));
  assert.ok(!shapeSymptoms(lines, 1).some((s) => s.includes('a.txt')));
});

test('a lane that never went back to its plan carries no cycle list', async () => {
  mergedLane();
  await result('IDD-1', []);
  assert.equal('cycle_files' in recordOf('IDD-1'), false);
});

test('a cycle start git cannot read leaves the whole list: no cycle list is written', async () => {
  const f = laneCommitting({ 'a.txt': 'a\n' });
  event(f, 'IDD-1', 's1_replan_requested');
  event(f, 'IDD-1', 's2_start', { started_from_commit: '0'.repeat(40) });
  await result('IDD-1', []);
  assert.equal('cycle_files' in recordOf('IDD-1'), false);
  assert.deepEqual(recordOf('IDD-1').changed_files, ['a.txt']);
});

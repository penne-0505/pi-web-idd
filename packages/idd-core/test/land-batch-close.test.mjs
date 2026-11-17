import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertLanded, carry, countOf, closeRunner, eventsOf, git, laneTip, mainTip, press, pressAndCarry, shipLanes, waitFor } from './helpers/batch-fixture.mjs';
import { approveBatch, batchGroups } from '../src/overlay/batch.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { currentLandApproval, readLand } from '../src/overlay/land.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { driveBatch } from '../src/overlay/batch.ts';
import { runLand } from '../src/plan/land.ts';
import { runningLandRuns } from '../src/overlay/land-run.ts';
import { readBatch, saveBatchForTests } from '../src/overlay/batch.ts';

const rows = eventsOf;
const twoLanes = () => shipLanes({ 'IDD-1': { 'app.txt': 'from one\n' }, 'IDD-2': { 'other.txt': 'from two\n' } });

async function landTwo() {
  const f = await twoLanes();
  const posted = closeRunner();
  const { b } = await pressAndCarry();
  assertLanded(b);
  return { f, posted, b };
}

test('AC-006: every landed lane is closed as a local landing at its own step, and each Issue close is posted once', async () => {
  const { f, posted, b } = await landTwo();
  for (const step of b.chain) {
    const evs = rows(step.iddId);
    const close = evs.filter((e) => e.event === 'lane_close');
    assert.equal(close.length, 1, step.iddId);
    assert.equal(close[0].attrs.outcome, 'local');
    assert.equal(close[0].attrs.merged_commit, step.commit);
    assert.equal(evs.filter((e) => e.event === 's4_land_merged').length, 1);
    // the record that says the head went in, read the way a single landing's is
    const land = readLand(step.iddId);
    assert.equal(land.status, 'complete');
    assert.equal(land.head, step.head);
    assert.equal(land.mergeCommit, step.commit);
    assert.equal(land.batch.id, b.id);
    git(f.work, 'merge-base', '--is-ancestor', step.head, mainTip(f));
  }
  // the Issue closes the signature carried: one post per lane, to the Issue of that lane, with the one-liner it signed
  assert.deepEqual(posted.map((p) => [p.kind, p.target.repo, p.target.issue, p.source]).sort(), [
    ['gh-issue-close', 'test/demo', 1, 'IDD-1'],
    ['gh-issue-close', 'test/demo', 2, 'IDD-2'],
  ]);
  assert.match(posted[0].body, /merge しました/);
  for (const id of f.ids) assert.equal(rows(id).filter((e) => e.event === 's4_land_issue_close_posted').length, 1);
});

test('AC-006: the approval is a per-lane event for each lane, and no event stands for the whole batch', async () => {
  const { f, b } = await landTwo();
  for (const step of b.chain) {
    const approved = rows(step.iddId).filter((e) => e.event === 's4_land_approved');
    assert.equal(approved.length, 1);
    assert.equal(approved[0].attrs.head, step.head);
    assert.equal(approved[0].attrs.signed, true);
    assert.equal(approved[0].attrs.batch, b.id);
    assert.equal(approved[0].attrs.close.issue, step.iddId === 'IDD-1' ? 1 : 2);
  }
  // an event is a lane's: nothing in the lifecycle is written for the batch itself
  const known = new Set(f.ids);
  assert.deepEqual(readLifecycle().filter((e) => !known.has(e.idd_id)), []);
  // the approval is the lane's own: the reading the gates use sees it for the head it names
  for (const step of b.chain) {
    const before = rows(step.iddId).filter((e) => e.event !== 'lane_close');
    assert.equal(currentLandApproval(before)?.head, step.head);
  }
});

test('a lane landed in a batch is not prepared or landed again by the tick, and the tick carries on past it', async () => {
  const { f } = await landTwo();
  const tip = mainTip(f);
  const res = await runLand();
  assert.deepEqual(res.errors, []);
  assert.equal(mainTip(f), tip);
  assert.equal(runningLandRuns().length, 0);
  for (const id of f.ids) assert.equal(deriveStage(rows(id)).decision === 'ship', false, 'a closed lane is not at the submit card');
});

test('the tick carries a signed batch to its end', async () => {
  const f = await twoLanes();
  closeRunner();
  const [group] = batchGroups();
  await press(approveBatch, group);
  // the press started the check; the tick's landing stage is what finishes the batch
  const end = Date.now() + 60_000;
  while (Date.now() < end && readBatch(group.id).phase !== 'landed') {
    await new Promise((r) => setTimeout(r, 100));
    await runLand();
  }
  assert.equal(readBatch(group.id).phase, 'landed');
  for (const id of f.ids) assert.equal(rows(id).some((e) => e.event === 'lane_close'), true, id);
  for (const id of f.ids) git(f.work, 'merge-base', '--is-ancestor', laneTip(f, id), mainTip(f));
});

test('a closing cut before it saved its progress closes nothing twice: closed lanes count as done and no Issue close is posted again', async () => {
  const { f, posted, b } = await landTwo();
  assert.equal(posted.length, 2);
  // the engine stopped after both lanes were closed and before the batch record said so
  saveBatchForTests({ ...b, phase: 'closing', landed: { ...b.landed, done: [] } });
  const pass = await driveBatch(b.id);
  assert.equal(pass.held, undefined, JSON.stringify(pass));
  const after = readBatch(b.id);
  assert.equal(after.phase, 'landed');
  assert.deepEqual(after.landed.done.sort(), ['IDD-1', 'IDD-2']);
  for (const id of f.ids) {
    for (const event of ['lane_close', 's4_land_batch_landed', 's4_land_issue_close_posted']) assert.equal(countOf(id, event), 1, `${id} ${event}`);
    assert.equal(readLand(id).status, 'complete');
  }
  assert.equal(posted.length, 2, 'no Issue close was posted again');
});

test('a closing cut between one lane and the next goes on from the lane that is still open', async () => {
  const { f, posted, b } = await landTwo();
  // IDD-1 is recorded as done; IDD-2 was closed but not recorded: it is not closed again
  saveBatchForTests({ ...b, phase: 'closing', landed: { ...b.landed, done: ['IDD-1'] } });
  await driveBatch(b.id);
  assert.equal(readBatch(b.id).phase, 'landed');
  assert.equal(rows('IDD-2').filter((e) => e.event === 'lane_close').length, 1);
  assert.equal(posted.length, 2);
  void f;
});

test('a pass cut after the batch was recorded as landing and before the fast-forward lands it: the record is put back and the chain is not left out as already landed', async () => {
  const f = await twoLanes();
  closeRunner();
  const [group] = batchGroups();
  assert.equal((await press(approveBatch, group)).ok, true);
  // the first pass makes the chain and starts its one check; the second would land it
  await driveBatch(group.id);
  await waitFor(() => runningLandRuns().length === 0);
  const checked = readBatch(group.id);
  assert.equal(checked.phase, 'checking', JSON.stringify(checked));
  const tip = mainTip(f);
  // the engine stopped after the record said "landing" and before the mainline moved
  saveBatchForTests({ ...checked, phase: 'closing', landed: { at: new Date().toISOString(), mergeCommit: checked.mergeCommit, lanes: checked.lanes, done: [] } });
  const b = await carry(group.id);
  assertLanded(b);
  assert.notEqual(mainTip(f), tip);
  for (const id of f.ids) git(f.work, 'merge-base', '--is-ancestor', laneTip(f, id), mainTip(f));
  for (const id of f.ids) assert.equal(rows(id).filter((e) => e.event === 's4_land_batch_landed').length, 1, id);
});

test('a pass cut after the fast-forward, with the record already saying landing, closes the lanes without building the chain again', async () => {
  const { f, b } = await landTwo();
  const tip = mainTip(f);
  saveBatchForTests({ ...b, phase: 'closing', landed: { ...b.landed, done: [] } });
  await driveBatch(b.id);
  assert.equal(readBatch(b.id).phase, 'landed');
  assert.equal(mainTip(f), tip);
  assert.deepEqual(readBatch(b.id).dropped, []);
});

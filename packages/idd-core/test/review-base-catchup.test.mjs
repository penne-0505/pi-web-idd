import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewBaseOf } from '../src/ledger/base.ts';
import { laneBaseWorkRef } from '../src/overlay/base.ts';
import { recordPath } from '../src/overlay/git.ts';
import { git, put, commit, event, setup, publishParent, child } from './stacked-fixture.mjs';

const PIPELINE = '  review_blind: { roles: [v] }\n  triage: { role: v }\n  confirm: { role: v }\n';

/** the stacked fixture's project with a review pipeline, and a runner that records what each start was handed */
function laneSetup() {
  const f = setup();
  put(join(f.state, 'roles.yaml'), `models:\n  x-v:\n    model: x/v\nroles:\n  v: { model: x-v }\npipeline:\n${PIPELINE}`);
  process.env.IDD_ROLES_FILE = join(f.state, 'roles.yaml');
  const calls = [];
  let n = 0;
  setAgentRunner({
    deliver: async () => {},
    cwdBusy: () => false,
    startReviewRun: async (o) => { calls.push(o); n += 1; return { runIds: [`${o.stage}-${n}`] }; },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  return { ...f, calls };
}

const eventsOf = (id) => readLifecycle().filter((e) => e.idd_id === id);
const advancedOf = (id) => eventsOf(id).filter((e) => e.event === 's2_review_base_advanced');
const head = (wt) => git(wt, 'rev-parse', 'HEAD');
const parentsOf = (wt, rev) => git(wt, 'rev-list', '--parents', '-n', '1', rev).split(' ').slice(1);
const changed = (wt, a, b) => git(wt, 'diff', '--name-only', a, b).split('\n').filter(Boolean).sort();

/** the lane has been reviewed once, penne sent it back, and the executor has answered: the next round is a blind */
function afterFirstReview(f, iddId, start, reviewed) {
  event(f, iddId, 's2_start', { started_from_commit: start });
  event(f, iddId, 's2_result', { outcome: 'success' });
  event(f, iddId, 's2_review_started', { kind: 'blind', round: 1, head: reviewed, run_ids: ['b'] });
  event(f, iddId, 's2_review_converged');
  event(f, iddId, 's2_device_skipped');
  event(f, iddId, 's3_ready');
  event(f, iddId, 's4_verify_user_judgment_answered', { outcome: 'revise', instruction: 'x', by: 'penne' });
}

test('a mainline the executor merged between rounds moves the origin to the commit the head took in, not the mainline tip', async () => {
  const f = laneSetup();
  const lane = f.parent.path;
  const start = head(lane);
  // the lane and the mainline both change other.txt's first line; the mainline adds its own file
  put(join(lane, 'app.txt'), 'ONE\ntwo\nthree\n');
  put(join(lane, 'other.txt'), 'lane\nb\nc\n');
  commit(lane);
  const reviewed = head(lane);
  put(join(f.work, 'other.txt'), 'main\nb\nc\n');
  put(join(f.work, 'main.txt'), 'main\n');
  const taken = commit(f.work);
  afterFirstReview(f, 'IDD-1', start, reviewed);
  // the executor merges the mainline, resolves the conflict by hand, and adds a change of its own in the same round
  assert.throws(() => git(lane, 'merge', '--no-edit', 'work-main'));
  put(join(lane, 'other.txt'), 'resolved\nb\nc\n');
  git(lane, 'add', '.');
  git(lane, 'commit', '--no-edit');
  put(join(lane, 'own.txt'), 'own\n');
  commit(lane);
  // the mainline moves again, and the lane has not taken that in
  put(join(f.work, 'late.txt'), 'late\n');
  const tip = commit(f.work);
  event(f, 'IDD-1', 's2_result', { outcome: 'success' });
  assert.equal(reviewBaseOf(eventsOf('IDD-1')), start, 'the record still names the origin the first review set');

  await runReviewLoop();

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].stage, 'blind');
  const base = f.calls[0].base;
  assert.notEqual(base, start);
  assert.deepEqual(parentsOf(lane, base), [start, taken], 'the origin is the start with the commit the head took in, not the mainline tip');
  assert.notEqual(tip, taken);
  // the record keeps where the origin came from and what it took in, and every reader of the ledger gets the same origin
  const rec = advancedOf('IDD-1').at(-1);
  assert.deepEqual([rec.attrs.head, rec.attrs.mainline, rec.attrs.merge_base, rec.attrs.review_base, rec.attrs.by], [head(lane), taken, start, base, 'executor']);
  assert.equal(reviewBaseOf(eventsOf('IDD-1')), base);
  assert.equal(eventsOf('IDD-1').some((e) => e.event === 's2_review_base_merged'), false, 'the name before the first review is not used');
  // what the mainline brought is not the lane's; the lane's change, the hand-resolved file and the same round's own file are
  assert.deepEqual(changed(lane, base, head(lane)), ['app.txt', 'other.txt', 'own.txt']);
  setAgentRunner(null);
});

test('the origin is moved once: the next look, and a round that has started, write no second record', async () => {
  const f = laneSetup();
  const lane = f.parent.path;
  const start = head(lane);
  put(join(lane, 'app.txt'), 'ONE\ntwo\nthree\n');
  commit(lane);
  const reviewed = head(lane);
  put(join(f.work, 'main.txt'), 'main\n');
  commit(f.work);
  afterFirstReview(f, 'IDD-1', start, reviewed);
  git(lane, 'merge', '--no-edit', 'work-main');
  event(f, 'IDD-1', 's2_result', { outcome: 'success' });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(advancedOf('IDD-1').length, 1);
  assert.equal(f.calls.length, 1);
  setAgentRunner(null);
});

test('a lane that took in no mainline since the origin was set keeps the origin and writes nothing', async () => {
  const f = laneSetup();
  const lane = f.parent.path;
  const start = head(lane);
  put(join(lane, 'app.txt'), 'ONE\ntwo\nthree\n');
  commit(lane);
  const reviewed = head(lane);
  afterFirstReview(f, 'IDD-1', start, reviewed);
  // the mainline moves, but the lane never merges it
  put(join(f.work, 'main.txt'), 'main\n');
  commit(f.work);
  put(join(lane, 'fix.txt'), 'fix\n');
  commit(lane);
  event(f, 'IDD-1', 's2_result', { outcome: 'success' });
  await runReviewLoop();
  assert.equal(advancedOf('IDD-1').length, 0);
  assert.equal(f.calls[0].base, start);
  setAgentRunner(null);
});

test('a lane stacked on a parent lane has its origin caught up to the parent\'s branch it took in', async () => {
  const f = laneSetup();
  put(join(f.parent.path, 'app.txt'), 'parent\ntwo\nthree\n');
  commit(f.parent.path);
  await publishParent(f);
  const lane = await child(f);
  const start = head(lane.path);
  put(join(lane.path, 'child.txt'), 'child\n');
  commit(lane.path);
  const reviewed = head(lane.path);
  // the parent moves on, and the work branch moves beyond it: only the parent's branch is this lane's mainline
  put(join(f.parent.path, 'parent2.txt'), 'parent 2\n');
  const taken = commit(f.parent.path);
  put(join(f.work, 'trunk.txt'), 'trunk\n');
  commit(f.work);
  afterFirstReview(f, 'IDD-2', start, reviewed);
  git(lane.path, 'merge', '--no-edit', lane.parentBranch ?? 'idd/IDD-1');
  put(join(lane.path, 'child2.txt'), 'child 2\n');
  commit(lane.path);
  put(join(f.parent.path, 'parent3.txt'), 'parent 3\n');
  commit(f.parent.path);
  event(f, 'IDD-2', 's2_result', { outcome: 'success' });

  await runReviewLoop();

  const call = f.calls.find((c) => c.iddId === 'IDD-2');
  assert.equal(call.stage, 'blind');
  assert.deepEqual(parentsOf(lane.path, call.base), [start, taken], 'the origin takes in the parent\'s commit the head carries');
  assert.equal(reviewBaseOf(eventsOf('IDD-2')), call.base);
  assert.deepEqual(changed(lane.path, call.base, head(lane.path)), ['child.txt', 'child2.txt']);
  assert.equal(advancedOf('IDD-2').length, 1);
  setAgentRunner(null);
});

test('a head that took in the mainline by a fast-forward has its origin caught up to that commit', async () => {
  const f = laneSetup();
  const lane = f.parent.path;
  const start = head(lane);
  afterFirstReview(f, 'IDD-1', start, start);
  put(join(f.work, 'main.txt'), 'main\n');
  const taken = commit(f.work);
  git(lane, 'merge', '--ff-only', 'work-main');
  assert.equal(head(lane), taken);
  event(f, 'IDD-1', 's2_result', { outcome: 'success' });

  await runReviewLoop();

  assert.equal(f.calls.length, 1);
  assert.deepEqual(parentsOf(lane, f.calls[0].base), [start, taken]);
  assert.equal(reviewBaseOf(eventsOf('IDD-1')), f.calls[0].base);
  assert.deepEqual(changed(lane, f.calls[0].base, head(lane)), []);
  setAgentRunner(null);
});

test('a round does not start on an origin that cannot be told to carry what the head took in, and is tried again', async () => {
  const f = laneSetup();
  const lane = f.parent.path;
  const start = head(lane);
  put(join(lane, 'app.txt'), 'ONE\ntwo\nthree\n');
  commit(lane);
  const reviewed = head(lane);
  put(join(f.work, 'main.txt'), 'main\n');
  commit(f.work);
  afterFirstReview(f, 'IDD-1', start, reviewed);
  git(lane, 'merge', '--no-edit', 'work-main');
  event(f, 'IDD-1', 's2_result', { outcome: 'success' });
  // the lane's mainline cannot be read from the worktree or from the clone it was cut from
  const kept = git(f.work, 'rev-parse', 'work-main');
  git(f.work, 'update-ref', '-d', 'refs/heads/work-main');
  const inLane = attemptRef(lane, 'work-main');
  if (inLane) git(lane, 'update-ref', '-d', 'refs/heads/work-main');

  await runReviewLoop();
  assert.equal(f.calls.length, 0, 'no stage starts on the old origin');
  assert.equal(advancedOf('IDD-1').length, 0);

  git(f.work, 'update-ref', 'refs/heads/work-main', kept);
  if (inLane) git(lane, 'update-ref', 'refs/heads/work-main', kept);
  await runReviewLoop();
  assert.equal(f.calls.length, 1, 'the next look catches the origin up and starts the round');
  assert.equal(advancedOf('IDD-1').length, 1);
  assert.equal(f.calls[0].base, reviewBaseOf(eventsOf('IDD-1')));
  setAgentRunner(null);
});

function attemptRef(cwd, name) {
  try { return git(cwd, 'rev-parse', '--verify', `refs/heads/${name}`); } catch { return ''; }
}

test('a stacked lane whose parent branch cannot be read does not start a round on the old origin', async () => {
  const f = laneSetup();
  put(join(f.parent.path, 'app.txt'), 'parent\ntwo\nthree\n');
  commit(f.parent.path);
  await publishParent(f);
  const lane = await child(f);
  const start = head(lane.path);
  put(join(lane.path, 'child.txt'), 'child\n');
  commit(lane.path);
  const reviewed = head(lane.path);
  put(join(f.parent.path, 'parent2.txt'), 'parent 2\n');
  commit(f.parent.path);
  afterFirstReview(f, 'IDD-2', start, reviewed);
  git(lane.path, 'merge', '--no-edit', 'idd/IDD-1');
  event(f, 'IDD-2', 's2_result', { outcome: 'success' });
  // the parent's branch name is recorded nowhere any more: the lane's mainline exists and cannot be read
  const sessions = join(f.state, 'executor-sessions.jsonl');
  const rows = readFileSync(sessions, 'utf8').split('\n').filter(Boolean).filter((r) => JSON.parse(r).idd_id !== 'IDD-1');
  writeFileSync(sessions, rows.join('\n') + '\n');
  rmSync(recordPath('lane-branches', 'IDD-1'), { force: true });
  assert.equal(laneBaseWorkRef('IDD-2'), null);

  await runReviewLoop();
  assert.equal(f.calls.length, 0, 'no stage starts on an origin that may lack what the head took in');
  assert.equal(advancedOf('IDD-2').length, 0);
  setAgentRunner(null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProposal, proposalPath } from '../src/overlay/export.ts';
import { proposeImport, reviewImport, importUpstream } from '../src/overlay/import.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { receiveBase, readBaseReceipt, baseCounterpart } from '../src/overlay/base.ts';
import { reviewBaseOf } from '../src/ledger/base.ts';
import { git, put, commit, event, setup, session, publishParent, child, atGo, baseEvents } from './stacked-fixture.mjs';

// ---------- 段 3: base の取り込み ----------

test('the parent\'s next publication is merged into the child as a real merge, without approval, and a prepared submit is voided', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f);
  put(join(lane.path, 'child.txt'), 'child\n'); const before = commit(lane.path);
  event(f, 'IDD-2', 's2_start', { started_from_commit: git(lane.path, 'rev-parse', 'HEAD~1') });
  event(f, 'IDD-2', 's4_submit_started');
  put(join(f.parent.path, 'other.txt'), 'parent v2\n'); commit(f.parent.path); const custody = await publishParent(f);
  const prepared = { status: 'prepared', expiresAt: new Date(Date.now() + 600_000).toISOString(), token: 't' };
  writeFileSync(proposalPath('IDD-2'), JSON.stringify(prepared));
  const r = await receiveBase('IDD-2'); assert.equal(r.ok, true, r.error); assert.equal(r.changed, true);
  const head = git(lane.path, 'rev-parse', 'HEAD');
  assert.deepEqual(git(lane.path, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1), [before, custody.workHead]);
  assert.equal(readFileSync(join(lane.path, 'other.txt'), 'utf8'), 'parent v2\n');
  assert.equal(readFileSync(join(lane.path, 'child.txt'), 'utf8'), 'child\n');
  assert.equal(git(lane.path, 'status', '--porcelain'), '');
  const ev = readLifecycle().filter((e) => e.idd_id === 'IDD-2' && e.event === 'lane_base_received').pop();
  assert.equal(ev.attrs.branch, 'idd/IDD-1'); assert.equal(ev.attrs.tip, custody.publicTip); assert.equal(ev.attrs.result, head); assert.equal(ev.attrs.work_commit, custody.workHead);
  assert.equal(readBaseReceipt('IDD-2').result, head);
  assert.ok(Date.parse(readProposal('IDD-2').expiresAt) < Date.now());
  // the review range after the receive is still the child's own work
  const base = reviewBaseOf(readLifecycle().filter((e) => e.idd_id === 'IDD-2'));
  assert.deepEqual(git(lane.path, 'diff', '--name-only', base, 'HEAD').split('\n'), ['child.txt']);
  // a second receive has nothing to take
  const again = await receiveBase('IDD-2'); assert.equal(again.ok, true); assert.equal(again.changed, false);
});

test('only the parent\'s published state is taken; its unpublished commits stay out', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f);
  put(join(f.parent.path, 'other.txt'), 'parent unpublished\n'); commit(f.parent.path);
  const r = await receiveBase('IDD-2'); assert.equal(r.ok, true, r.error); assert.equal(r.changed, false);
  assert.equal(readFileSync(join(lane.path, 'other.txt'), 'utf8'), 'a\nb\nc\n');
});

test('a conflict with the parent stops without moving the child, and is recorded', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f);
  put(join(lane.path, 'app.txt'), 'child edit\n'); const before = commit(lane.path);
  put(join(f.parent.path, 'app.txt'), 'parent v2\n'); commit(f.parent.path); await publishParent(f);
  const r = await receiveBase('IDD-2'); assert.equal(r.ok, false); assert.deepEqual(r.conflict, ['app.txt']);
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), before); assert.equal(git(lane.path, 'status', '--porcelain'), '');
  assert.ok(readLifecycle().some((e) => e.idd_id === 'IDD-2' && e.event === 'lane_base_conflict'));
});

test('the receive stops while the parent has not taken in its own public branch, while the lane may be at work, and with uncommitted changes', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f); const before = git(lane.path, 'rev-parse', 'HEAD');
  // someone pushes to the parent's public branch
  git(f.upstream, 'fetch', 'origin'); git(f.upstream, 'checkout', '-b', 'tmp', 'origin/idd/IDD-1'); put(join(f.upstream, 'x.txt'), 'x\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'tmp:idd/IDD-1');
  assert.match((await receiveBase('IDD-2')).error, /receive/);
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), before);
  event(f, 'IDD-2', 's1_go');
  assert.match((await receiveBase('IDD-2')).error, /段/);
  // back at a card (S3 review): the stage is quiet, and a lane with no PR yet may receive
  event(f, 'IDD-2', 's3_ready');
  put(join(lane.path, 'dirty.txt'), 'x');
  assert.match((await receiveBase('IDD-2')).error, /未 commit/);
});

// S4: a lane on the public base is refused the receive until the submit side carries the base (stacked-cut.test.mjs);
// the counterpart of the public base, which 段 2 will take, is still the work branch's import of it
test('the counterpart of the public base is the work branch\'s import of it, after the import', async () => {
  const f = setup();
  // the public base moves
  git(f.upstream, 'checkout', 'main'); git(f.upstream, 'pull', '--ff-only', 'origin', 'main'); put(join(f.upstream, 'other.txt'), 'upstream\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
  assert.match(baseCounterpart('IDD-1').error ?? '', /sync/);
  const p = proposeImport('demo'); assert.ok(!p.error, p.error); const rv = await reviewImport('demo'); assert.ok(!rv.error, rv.error); assert.equal(importUpstream('demo', rv.token).ok, true);
  const c = baseCounterpart('IDD-1'); assert.ok(!c.error, c.error);
  assert.equal(c.parent, null); assert.equal(c.workCommit, git(f.work, 'rev-parse', 'work-main')); assert.equal(c.publicTip, git(f.remote, 'rev-parse', 'main'));
});

test('the review base is where S2 started until a base is received, then the latest received review base', async () => {
  const ev = (event, attrs = {}) => ({ idd_id: 'IDD-9', event, at: '2026-09-26T00:00:00Z', attrs });
  assert.equal(reviewBaseOf([ev('lane_open')]), '');
  assert.equal(reviewBaseOf([ev('s2_start', { started_from_commit: 'a' })]), 'a');
  // a receive before S2 started does not count
  assert.equal(reviewBaseOf([ev('lane_base_received', { review_base: 'x' }), ev('s2_start', { started_from_commit: 'a' })]), 'a');
  assert.equal(reviewBaseOf([ev('s2_start', { started_from_commit: 'a' }), ev('lane_base_received', { review_base: 'b' }), ev('lane_base_received', { review_base: 'c' })]), 'c');
});

test('a lane sent back to its plan is reviewed from where its first implementation started, with the mainline merges moving it on', () => {
  const ev = (event, attrs = {}) => ({ idd_id: 'IDD-9', event, at: '2026-09-26T00:00:00Z', attrs });
  const back = [ev('s1_go'), ev('s2_start', { started_from_commit: 'a' }), ev('s2_result'), ev('s1_replan_requested'), ev('s1_go')];
  assert.equal(reviewBaseOf([...back, ev('s2_start', { started_from_commit: 'z' })]), 'a', 'the second start is the head the first cycle left, not where the lane began');
  assert.equal(
    reviewBaseOf([...back, ev('s2_start', { started_from_commit: 'z' }), ev('s2_review_base_merged', { review_base: 'm1' })]),
    'm1',
    'a mainline merge after the return moves the origin',
  );
  assert.equal(
    reviewBaseOf([ev('s2_start', { started_from_commit: 'a' }), ev('s2_review_started', { review_base: 'm0' }), ev('s2_result'), ev('s1_replan_requested'), ev('s1_go'), ev('s2_start', { started_from_commit: 'z' })]),
    'm0',
    'a merge taken in during the first implementation stays out of the lane\'s change',
  );
});

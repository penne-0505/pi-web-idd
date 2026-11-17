import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLifecycle } from '../src/ledger/read.ts';
import { laneBase, laneForkPoint } from '../src/plan/review.ts';
import { laneBaseOf, setLaneBase, adoptBaseFromPr, laneBaseWorkRef } from '../src/overlay/base.ts';
import { git, put, commit, event, setup, session, publishParent, child, atGo, baseEvents } from './stacked-fixture.mjs';
import { GEN, TOP, TOP_OTHER, BOTTOM, builds, seedGenerated } from './helpers/generated-fixture.mjs';

// ---------- 段 1: base の記録と読み口 ----------

test('a lane with no base recorded keeps the area public base and its fork point on the work branch', () => {
  const f = setup();
  const b = laneBaseOf('IDD-1'); assert.ok(!('error' in b), b.error);
  assert.deepEqual({ branch: b.branch, parent: b.parent, source: b.source }, { branch: 'main', parent: null, source: 'default' });
  assert.equal(laneBaseWorkRef('IDD-1'), 'refs/heads/work-main');
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path);
  assert.equal(laneBase(f.parent.path), git(f.parent.path, 'merge-base', 'HEAD', 'refs/heads/work-main'));
});

test('stacking records the parent lane by its public branch, and refuses itself, a cycle, an ended lane and a branch no lane owns', async () => {
  const f = setup();
  const set = await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  const ev = baseEvents('IDD-2'); assert.equal(ev.length, 1);
  assert.equal(ev[0].attrs.branch, 'idd/IDD-1'); assert.equal(ev[0].attrs.parent, 'IDD-1'); assert.equal(ev[0].attrs.source, 'manual'); assert.equal(ev[0].attrs.previous, 'main');
  const b = laneBaseOf('IDD-2'); assert.deepEqual({ branch: b.branch, parent: b.parent }, { branch: 'idd/IDD-1', parent: 'IDD-1' });
  assert.equal((await setLaneBase('IDD-1', { lane: 'IDD-1' }, 'manual')).error !== undefined, true);
  assert.match((await setLaneBase('IDD-1', { lane: 'IDD-2' }, 'manual')).error, /循環/);
  assert.match((await setLaneBase('IDD-2', { branch: 'someone/else' }, 'manual')).error, /lane/);
  event(f, 'IDD-3', 'lane_close', { outcome: 'aborted' });
  assert.ok((await setLaneBase('IDD-2', { lane: 'IDD-3' }, 'manual')).error);
  assert.ok((await setLaneBase('IDD-3', { lane: 'IDD-1' }, 'manual')).error);
  // back to the public base by name
  const back = await setLaneBase('IDD-2', { branch: 'main' }, 'manual'); assert.ok(!('error' in back), back.error);
  assert.equal(laneBaseOf('IDD-2').parent, null);
});

test('the parent is found again by branch after the lane that published it is replaced', async () => {
  const f = setup();
  await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual');
  // IDD-1 is closed and IDD-3 takes over the same public branch (a lane taken in again)
  event(f, 'IDD-1', 'lane_close', { outcome: 'aborted' });
  appendFileSync(join(f.state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-3', worktree_path: f.parent.path, branch: 'idd/IDD-1', executor_session_id: 's-3' }) + '\n');
  assert.equal(laneBaseOf('IDD-2').parent, 'IDD-3');
});

test('a manual change of base is refused once the lane has published', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  assert.match((await setLaneBase('IDD-1', { lane: 'IDD-2' }, 'manual')).error ?? '', /提出/);
});

test('the child worktree is cut from the parent published state, not from its unpublished commits', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent published\n'); commit(f.parent.path);
  const custody = await publishParent(f);
  put(join(f.parent.path, 'other.txt'), 'parent unpublished\n'); commit(f.parent.path);
  const lane = await child(f);
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), custody.workHead);
  assert.equal(readFileSync(join(lane.path, 'app.txt'), 'utf8'), 'parent published\n');
  assert.equal(readFileSync(join(lane.path, 'other.txt'), 'utf8'), 'a\nb\nc\n');
});

test('a child of a parent that has not published yet starts from the parent branch', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent draft\n'); const head = commit(f.parent.path);
  const lane = await child(f);
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), head);
});

test('the child fork point is on the parent branch, so the parent changes are not counted as the child\'s', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); const custody = await publishParent(f);
  const lane = await child(f);
  put(join(lane.path, 'child.txt'), 'child\n'); commit(lane.path);
  assert.equal(laneBaseWorkRef('IDD-2'), 'refs/heads/idd/IDD-1');
  assert.equal(laneBase(lane.path), custody.workHead);
  assert.deepEqual(git(lane.path, 'diff', '--name-only', laneBase(lane.path), 'HEAD').split('\n'), ['child.txt']);
});

// should 2: the parent ending must not move the child's own changes onto the work branch, where the parent's are counted
test('once the parent ends, the child\'s own changes are still measured from the parent\'s last published state', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); const custody = await publishParent(f);
  const lane = await child(f);
  put(join(lane.path, 'child.txt'), 'child\n'); commit(lane.path);
  event(f, 'IDD-1', 'lane_close', { outcome: 'aborted' });
  assert.equal(laneForkPoint('IDD-2', lane.path), custody.workHead);
  assert.deepEqual(git(lane.path, 'diff', '--name-only', laneBase(lane.path), 'HEAD').split('\n'), ['child.txt']);
});

test('once the parent ends unpublished, the child is measured from the parent\'s branch, and without it from nothing, saying the parent ended', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent draft\n'); commit(f.parent.path);
  const lane = await child(f);
  put(join(lane.path, 'child.txt'), 'child\n'); commit(lane.path);
  event(f, 'IDD-1', 'lane_close', { outcome: 'aborted' });
  assert.deepEqual(git(lane.path, 'diff', '--name-only', laneForkPoint('IDD-2', lane.path), 'HEAD').split('\n'), ['child.txt']);
  git(f.work, 'worktree', 'remove', '--force', f.parent.path); git(f.work, 'branch', '-D', 'idd/IDD-1');
  assert.equal(laneForkPoint('IDD-2', lane.path), null);
  assert.equal(laneBase(lane.path), null);
  const base = await import('../src/overlay/base.ts');
  assert.match(base.laneBaseMissing?.('IDD-2') ?? '', /IDD-1.*終わ/);
});

function ghStub(f, prs) {
  const bin = join(f.root, 'bin'); mkdirSync(bin, { recursive: true });
  put(join(bin, 'gh'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(prs))});`); chmodSync(join(bin, 'gh'), 0o755);
  const old = process.env.PATH; process.env.PATH = bin + ':' + old; return () => { process.env.PATH = old; };
}

test('adopt reads the base of the open PR: a lane branch makes a parent, the public base keeps the default, other branches stop', async () => {
  const f = setup();
  let restore = ghStub(f, [{ number: 7, baseRefName: 'idd/IDD-1', url: 'https://github.com/test/project/pull/7' }]);
  try {
    const r = await adoptBaseFromPr('IDD-2', 'someone/child'); assert.ok(!('error' in r), r.error);
    assert.equal(r.base.parent, 'IDD-1'); assert.equal(r.pr, 7);
    assert.equal(baseEvents('IDD-2').pop().attrs.source, 'adopt');
  } finally { restore(); }
  restore = ghStub(f, [{ number: 8, baseRefName: 'main', url: 'u' }]);
  try { const r = await adoptBaseFromPr('IDD-3', 'someone/plain'); assert.ok(!('error' in r), r.error); assert.equal(laneBaseOf('IDD-3').branch, 'main'); } finally { restore(); }
  restore = ghStub(f, [{ number: 9, baseRefName: 'feature/not-a-lane', url: 'u' }]);
  try { assert.match((await adoptBaseFromPr('IDD-3', 'someone/other')).error, /lane/); } finally { restore(); }
  restore = ghStub(f, []);
  try { const r = await adoptBaseFromPr('IDD-3', 'someone/nopr'); assert.ok(!('error' in r), r.error); assert.equal(r.pr, null); } finally { restore(); }
});


/** the lane's executor has finished and both reviews are skipped, so the next check is its S3 */
function readyForS3(f, iddId, path) {
  event(f, iddId, 's2_start', { started_from_commit: git(path, 'rev-parse', 'HEAD~1') }); event(f, iddId, 's2_result'); event(f, iddId, 's2_review_skipped', { reason: 'no slot' }); event(f, iddId, 's2_device_skipped', { reason: 'no device' });
}

test('the S3 check of a stacked lane looks for conflicts with its parent, not with the work branch', async () => {
  const f = setup();
  const { runCheck } = await import('../src/plan/review.ts');
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f);
  put(join(lane.path, 'child.txt'), 'child\n'); commit(lane.path);
  // the work branch changes the same lines the parent did: the parent's matter, not the child's
  put(join(f.work, 'app.txt'), 'work main\n'); commit(f.work);
  readyForS3(f, 'IDD-2', lane.path);
  const r = (await runCheck()).find((x) => x.iddId === 'IDD-2');
  assert.equal(r?.outcome, 'clean', JSON.stringify(r));
});

// ---------- 生成物だけの衝突は S3 の記録で衝突にならない（C-266-3） ----------

/** the parent lane IDD-1 and the work branch both hold src.txt and the gen.txt built from it; the lane is ready for S3 */
function s3Ready(extra, gen = 'gen.txt') {
  const f = setup(extra);
  seedGenerated(f.work, [f.parent.path], gen);
  return f;
}
async function s3Of(f) {
  const { runCheck } = await import('../src/plan/review.ts');
  readyForS3(f, 'IDD-1', f.parent.path);
  const r = (await runCheck()).find((x) => x.iddId === 'IDD-1');
  const records = readLifecycle().filter((e) => e.idd_id === 'IDD-1');
  return { r, names: records.map((e) => e.event), conflict: records.filter((e) => e.event === 's3_check_conflict').pop() };
}
/** the parent and the work branch each build from a source line: BOTTOM and TOP text-merge, so only gen.txt conflicts */
const bothBuilt = (f, gen = 'gen.txt', parentText = BOTTOM) => { builds(f.parent.path, parentText, undefined, gen); builds(f.work, TOP, undefined, gen); };

test('AC-004: a conflict on declared generated files alone is recorded as clean, not as a conflict', async () => {
  const f = s3Ready({ generated_files: [GEN], publish: false });
  bothBuilt(f);
  const { r, names } = await s3Of(f);
  assert.equal(r?.outcome, 'clean', JSON.stringify(r));
  assert.equal(names.includes('s3_check_clean'), true);
  assert.equal(names.includes('s3_check_conflict'), false);
});

test('AC-004: a conflict with a source in it is still recorded, with every file of it', async () => {
  const f = s3Ready({ generated_files: [GEN], publish: false });
  bothBuilt(f, 'gen.txt', TOP_OTHER);
  const { r, conflict } = await s3Of(f);
  assert.equal(r?.outcome, 'conflict', JSON.stringify(r));
  assert.deepEqual([...conflict.attrs.conflict_files].sort(), ['gen.txt', 'src.txt']);
  assert.equal(conflict.attrs.conflict_type, 'vs_work_base');
});

test('AC-004: a generated file with a non-ASCII path is matched with its declaration', async () => {
  const name = '生成物.txt';
  const f = s3Ready({ generated_files: [{ ...GEN, paths: [name], command: `tr '\\n' ' ' < src.txt | tr a-z A-Z > ${name}` }], publish: false }, name);
  bothBuilt(f, name);
  const { r } = await s3Of(f);
  assert.equal(r?.outcome, 'clean', JSON.stringify(r));
});

test('AC-004: a publishing repo keeps a generated-only conflict as a conflict', async () => {
  const f = s3Ready({ generated_files: [GEN], publish: true });
  bothBuilt(f);
  const { r, names, conflict } = await s3Of(f);
  assert.equal(r?.outcome, 'conflict', JSON.stringify(r));
  assert.deepEqual(r?.conflictFiles, ['gen.txt']);
  assert.equal(names.includes('s3_check_conflict'), true);
  assert.deepEqual(conflict.attrs.conflict_files, ['gen.txt']);
});

test('AC-006: a repo that declares nothing records a generated-only conflict, as before', async () => {
  const f = s3Ready();
  bothBuilt(f);
  const { r, conflict } = await s3Of(f);
  assert.equal(r?.outcome, 'conflict', JSON.stringify(r));
  assert.deepEqual(conflict.attrs.conflict_files, ['gen.txt']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { commitManifest, GOOD_MANIFEST as GOOD, gitIn as git, registerRepos, workClone } from './helpers/work-clone.mjs';
import { setLaneBase } from '../src/overlay/base.ts';
import { setup as stackedSetup } from './stacked-fixture.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { LaneStartHeldError } from '../src/storage/hold.ts';

/** a work clone on `work-main` that holds `manifest` (null: none), registered as the repo `demo` */
function setup(manifest) {
  const root = scratchDir('worktree-manifest-');
  const work = workClone(root, 'work', manifest);
  const lanes = join(root, 'lanes');
  registerRepos(root, { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: lanes, checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } }, { IDD_INTENT_DIR: join(root, 'unused') });
  const branches = () => git(work, 'branch', '--format=%(refname:short)').split('\n');
  return { work, lanes, branches };
}

/** the message ensureLaneWorktree throws for the lane (not a wait for room) */
function thrownBy(iddId) {
  try { ensureLaneWorktree('demo', iddId); } catch (err) {
    assert.ok(!(err instanceof LaneStartHeldError), 'it is a failure with a reason, not a wait for room');
    return err.message;
  }
  assert.fail('the worktree step stops');
}

/** what ensureLaneWorktree throws for the lane IDD-9: nothing left behind */
function refusedWith(env) {
  const message = thrownBy('IDD-9');
  assert.ok(!existsSync(join(env.lanes, 'IDD-9')), 'no worktree');
  assert.deepEqual(env.branches(), ['work-main'], 'no branch');
  return message;
}

test('no worktree and no branch are made when the work base has no manifest; a commit of it lets the lane go on', () => {
  const env = setup(null);
  const reason = refusedWith(env);
  assert.match(reason, /work-main/);
  assert.match(reason, /overlay\.manifest/);
  commitManifest(env.work, GOOD);
  const made = ensureLaneWorktree('demo', 'IDD-9');
  assert.equal(made.path, join(env.lanes, 'IDD-9'));
  assert.ok(existsSync(join(made.path, 'overlay.manifest')));
});

test('a manifest that cannot be used stops before the worktree and the branch, with the line and its reason', () => {
  const env = setup('_docs/\n/etc/passwd\noverlay.manifest\n');
  assert.match(refusedWith(env), /2 行目 \/etc\/passwd/);
});

test('a manifest that is a symlink to itself stops before the worktree and the branch, naming what it is', () => {
  const env = setup(null);
  symlinkSync('overlay.manifest', join(env.work, 'overlay.manifest'));
  git(env.work, 'add', '.');
  git(env.work, 'commit', '-qm', 'link');
  assert.match(refusedWith(env), /overlay\.manifest.*symlink/);
  rmSync(join(env.work, 'overlay.manifest'));
  commitManifest(env.work, GOOD);
  assert.ok(existsSync(ensureLaneWorktree('demo', 'IDD-9').path));
});

test('a manifest whose blob git cannot read stops before the worktree and the branch, naming the file', () => {
  const env = setup(GOOD);
  const sha = git(env.work, 'rev-parse', 'work-main:overlay.manifest').trim();
  const loose = join(env.work, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  assert.ok(existsSync(loose), 'the blob is a loose object the test can remove');
  const saved = readFileSync(loose);
  rmSync(loose);
  assert.match(refusedWith(env), /overlay\.manifest.*blob/);
  writeFileSync(loose, saved);
  assert.ok(existsSync(ensureLaneWorktree('demo', 'IDD-9').path));
});

test('the branch a lane already has is what is checked: a bad manifest on it stops the worktree even when the work base is fine', () => {
  const env = setup(GOOD);
  git(env.work, 'checkout', '-q', '-b', 'feature/idd-9');
  commitManifest(env.work, '_docs/\n/etc/passwd\n');
  git(env.work, 'checkout', '-q', 'work-main');
  assert.match(thrownBy('IDD-9'), /2 行目 \/etc\/passwd/);
  assert.ok(!existsSync(join(env.lanes, 'IDD-9')), 'no worktree');
});

test('a lane stacked on a parent is checked at the parent work it is cut from, not at the work base', async () => {
  const f = stackedSetup();
  commitManifest(f.parent.path, '_docs/\n/etc/passwd\n');
  assert.ok(!('error' in await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual')));
  assert.match(thrownBy('IDD-2'), /2 行目 \/etc\/passwd/);
  assert.ok(!existsSync(join(f.root, 'lanes', 'IDD-2')), 'no worktree');
  assert.ok(!git(f.work, 'branch', '--format=%(refname:short)').includes('idd/IDD-2'), 'no branch');
  commitManifest(f.parent.path, GOOD);
  assert.ok(existsSync(ensureLaneWorktree('demo', 'IDD-2').path));
});

test('a repo with no work clone on this machine still has no lane worktree to cut', () => {
  const env = setup(GOOD);
  writeFileSync(join(env.lanes, '..', 'repos.yaml'), JSON.stringify({ repos: { demo: { github: 't/p', upstream: env.work, work: join(env.lanes, '..', 'absent'), work_base: 'work-main', public_base: 'main', checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  assert.equal(ensureLaneWorktree('demo', 'IDD-9'), null);
});

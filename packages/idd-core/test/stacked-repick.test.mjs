import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { setLaneBase, validateStackTarget } from '../src/overlay/base.ts';
import { git, put, commit, event, setup, session, baseEvents } from './stacked-fixture.mjs';

// A lane taken in again for the same Issue (IDD-4 after the ended IDD-3) is named like the ended one, and is cut on a
// suffixed branch (-2) when its worktree is made. Until then it has no branch of its own: the ended lane's branch,
// which is kept, is not the new lane's.

const LINEAR = { source_type: 'linear', linear_issue_url: 'https://linear.app/org/issue/APP-2240', gh_issue_url: null };

function repick() {
  const f = setup();
  // Linear lanes are named by their Issue; IDD-1 keeps the branch its session recorded (idd/IDD-1)
  put(f.areas, JSON.stringify({ repos: { demo: { ...f.config, issue_lane: { ...f.config.issue_lane, branch_name_pattern: { linear: 'feature/{linear_id}', github: 'idd/{idd_id}' } } } } }));
  put(join(f.state, 'backlog.jsonl'), [
    { idd_id: 'IDD-1', area: 'demo', title: 'feat: IDD-1' },
    { idd_id: 'IDD-2', area: 'demo', title: 'feat: IDD-2' },
    { idd_id: 'IDD-3', area: 'demo', title: 'feat: change', ...LINEAR },
    { idd_id: 'IDD-4', area: 'demo', title: 'feat: change', ...LINEAR },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  event(f, 'IDD-4', 'lane_open');
  return f;
}

/** the Issue's earlier lane (IDD-3): cut, with a commit of its own, then ended and its worktree retired (the branch stays) */
function endedEarlier(f) {
  const old = ensureLaneWorktree('demo', 'IDD-3'); session(f.state, 'IDD-3', old);
  assert.equal(old.branch, 'feature/app-2240');
  put(join(old.path, 'old.txt'), 'the earlier lane\n'); const tip = commit(old.path);
  event(f, 'IDD-3', 'lane_close', { outcome: 'aborted' });
  git(f.work, 'worktree', 'remove', old.path);
  return tip;
}

test('a: a child is not put on a lane taken in again before its branch is cut, and once cut the child starts from its branch, not the ended lane\'s', async () => {
  const f = repick(); const earlier = endedEarlier(f);
  const early = await setLaneBase('IDD-2', { lane: 'IDD-4' }, 'manual');
  assert.ok('error' in early, JSON.stringify(early));
  assert.equal(baseEvents('IDD-2').length, 0);
  assert.ok(validateStackTarget({ lane: 'IDD-4' }).error);
  const parent = ensureLaneWorktree('demo', 'IDD-4'); session(f.state, 'IDD-4', parent);
  assert.equal(parent.branch, 'feature/app-2240-2');
  put(join(parent.path, 'app.txt'), 'the lane taken in again\n'); const head = commit(parent.path);
  const set = await setLaneBase('IDD-2', { lane: 'IDD-4' }, 'manual'); assert.ok(!('error' in set), set.error);
  assert.equal(set.branch, 'feature/app-2240-2'); assert.equal(set.parent, 'IDD-4');
  const lane = ensureLaneWorktree('demo', 'IDD-2');
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), head);
  assert.notEqual(git(lane.path, 'merge-base', 'HEAD', earlier), earlier);
});

test('b: a lane taken in again, put on a parent before its branch is cut, goes back to the default base once the parent ends', async () => {
  const f = repick(); endedEarlier(f);
  const set = await setLaneBase('IDD-4', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  event(f, 'IDD-1', 'lane_close', { outcome: 'aborted' });
  const back = await setLaneBase('IDD-4', { branch: 'main' }, 'manual');
  assert.ok(!('error' in back), back.error); assert.equal(back.parent, null);
  const lane = ensureLaneWorktree('demo', 'IDD-4');
  assert.equal(lane.branch, 'feature/app-2240-2');
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), git(f.work, 'rev-parse', 'work-main'));
});

test('c: stacking a lane taken in again is not refused for the commits on the ended lane\'s branch', async () => {
  const f = repick();
  // the work branch moves on after the parent was cut, and the earlier lane is cut from there
  put(join(f.work, 'other.txt'), 'work main moved\n'); commit(f.work);
  endedEarlier(f);
  const set = await setLaneBase('IDD-4', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  const lane = ensureLaneWorktree('demo', 'IDD-4');
  assert.equal(lane.branch, 'feature/app-2240-2');
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), git(f.parent.path, 'rev-parse', 'HEAD'));
});

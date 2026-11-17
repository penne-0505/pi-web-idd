import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { proposeForTests as propose } from '../src/overlay/export.ts';
import { proposeImport, reviewImport, importUpstream } from '../src/overlay/import.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { setLaneBase, receiveBase, laneBaseOf, lanePublicBranch } from '../src/overlay/base.ts';
import { runPrep } from '../src/plan/prep.ts';
import { git, put, commit, event, setup, session, publishParent, atGo } from './stacked-fixture.mjs';

// Whether a lane's branch is cut is read from the record made when its worktree is cut, not from its session: the
// session is recorded only once the spawn goes through, and a lane whose spawn failed has its branch all the same.

const LINEAR = { source_type: 'linear', linear_issue_url: 'https://linear.app/org/issue/APP-2240', gh_issue_url: null };

test('a lane cut from its parent whose planner failed to spawn is not moved back to the public base', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  const set = await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  // the tick takes the lanes awaiting their planner in the order they came in
  put(join(f.state, 'backlog.jsonl'), ['IDD-1', 'IDD-2', 'IDD-3'].map((id, i) => JSON.stringify({ idd_id: id, area: 'demo', title: `feat: ${id}`, created_at: `2026-09-26T00:00:0${i}Z` })).join('\n') + '\n');
  setAgentRunner({ cwdBusy: () => false, spawn: async () => { throw new Error('spawn failed'); }, deliver: async () => {} });
  try {
    const r = await runPrep();
    assert.ok(r.skipped.some((s) => s.iddId === 'IDD-2' && /spawn failed/.test(s.reason)), JSON.stringify(r));
  } finally { setAgentRunner({ cwdBusy: () => false }); }
  // the worktree and branch were cut from the parent, with no session recorded
  assert.equal(git(f.work, 'rev-parse', 'refs/heads/idd/IDD-2'), git(f.parent.path, 'rev-parse', 'HEAD'));
  const back = await setLaneBase('IDD-2', { branch: 'main' }, 'manual');
  assert.match(back.error ?? '', /idd\/IDD-2/, JSON.stringify(back));
  assert.equal(laneBaseOf('IDD-2').parent, 'IDD-1');
});

function repick() {
  const f = setup();
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

test('a lane taken in again, cut on its suffixed branch with no session, is known by that branch', async () => {
  const f = repick();
  const old = ensureLaneWorktree('demo', 'IDD-3'); session(f.state, 'IDD-3', old);
  event(f, 'IDD-3', 'lane_close', { outcome: 'aborted' }); git(f.work, 'worktree', 'remove', old.path);
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  const set = await setLaneBase('IDD-4', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  // the executor path (or the planner's) cuts the worktree, and the spawn after it fails: no session
  const lane = ensureLaneWorktree('demo', 'IDD-4');
  assert.equal(lane.branch, 'feature/app-2240-2');
  assert.equal(lanePublicBranch('IDD-4'), 'feature/app-2240-2');
  const back = await setLaneBase('IDD-4', { branch: 'main' }, 'manual');
  assert.match(back.error ?? '', /feature\/app-2240-2/, JSON.stringify(back));
  assert.equal(laneBaseOf('IDD-4').parent, 'IDD-1');
});

test('an ended lane cut without a session keeps its branch from the lane taken in again for the same Issue', async () => {
  const f = repick();
  const old = ensureLaneWorktree('demo', 'IDD-3');
  put(join(old.path, 'old.txt'), 'the earlier lane\n'); const earlier = commit(old.path);
  event(f, 'IDD-3', 'lane_close', { outcome: 'aborted' }); git(f.work, 'worktree', 'remove', old.path);
  const lane = ensureLaneWorktree('demo', 'IDD-4');
  assert.equal(lane.branch, 'feature/app-2240-2');
  assert.notEqual(git(lane.path, 'rev-parse', 'HEAD'), earlier);
});

// S4: until the submit side carries the base (段 2), a receive stops the lane's submit, and a lane on the public base
// has nothing to wait for from its base: its receive is refused, and its submit stays open
test('S4: a lane on the public base is refused receive-base and can still be proposed', async () => {
  const f = setup(); atGo(f, 'IDD-1');
  put(join(f.parent.path, 'mine.txt'), 'mine\n'); const before = commit(f.parent.path);
  git(f.upstream, 'checkout', 'main'); git(f.upstream, 'pull', '--ff-only', 'origin', 'main'); put(join(f.upstream, 'other.txt'), 'upstream\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
  const p = proposeImport('demo'); assert.ok(!p.error, p.error); const rv = await reviewImport('demo'); assert.equal(importUpstream('demo', rv.token).ok, true);
  const r = await receiveBase('IDD-1');
  assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, /公開本流/);
  assert.equal(git(f.parent.path, 'rev-parse', 'HEAD'), before);
  assert.ok(!readLifecycle().some((e) => e.idd_id === 'IDD-1' && e.event === 'lane_base_received'));
  const next = await propose('IDD-1', { title: 'feat: mine', body: '' });
  assert.ok(!next.error, next.error);
});

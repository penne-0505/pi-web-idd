import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { judge } from '../src/storage/judge.ts';
import { sweepStorage } from '../src/storage/sweep.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { storageState, writeRepos, writeLifecycle, backlog, sessions, writeLaneJson, gitRepo } from './helpers/storage-fixture.mjs';

const DAY = 24 * 60 * 60 * 1000;
const at = (s) => `2026-09-20T${s}:00+09:00`;

test('a run record of a closed lane comes due at the lane close plus the keep period, and the setting moves it (AC-003, AC-018)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 7 } } } });
  writeLifecycle(state, 'Demo', [
    { event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} },
    { event: 'lane_close', idd_id: 'IDD-1', at: at('12:00'), attrs: { outcome: 'merged' } },
  ]);
  writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });

  const v = await judge({ now: Date.parse(at('00:00')), measure: false });
  const c = v.candidates.find((x) => x.place === 'run_records');
  assert.ok(c, 'the run record is a candidate');
  assert.equal(c.lane, 'IDD-1');
  assert.equal(c.usedUpAt, at('12:00'));
  assert.equal(c.dueAt, new Date(Date.parse(at('12:00')) + 7 * DAY).toISOString());

  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 14 } } } });
  const v14 = await judge({ measure: false });
  assert.equal(v14.candidates.find((x) => x.place === 'run_records').dueAt, new Date(Date.parse(at('12:00')) + 14 * DAY).toISOString());
});

test('a run record of an open lane is kept, whatever the period (AC-007)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  writeLifecycle(state, 'Demo', [{ event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} }]);
  writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  const v = await judge({ measure: false });
  assert.equal(v.candidates.filter((x) => x.place === 'run_records').length, 0);
  assert.ok(v.kept.some((k) => k.place === 'run_records' && k.reason.includes('閉じていません')));
});

test('an ad-hoc run is used up when it ends, and one whose lane cannot be decided is kept', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  writeLaneJson(state, '2026-09-18-000000-planner', { status: 'done', ended_at: at('10:00') });
  // a lane whose spec the sweep cannot read: no idd_id and no pipeline path
  writeLaneJson(state, '2026-09-18-000000-odd', { status: 'done', spec: '/state/pipeline/review/not-a-lane/spec.yaml' });
  const v = await judge({ measure: false });
  const adHoc = v.candidates.find((c) => c.path.endsWith('2026-09-18-000000-planner'));
  assert.ok(adHoc, 'a finished ad-hoc run is a candidate');
  assert.equal(adHoc.usedUpAt, at('10:00'));
  assert.ok(v.kept.some((k) => k.path.endsWith('2026-09-18-000000-odd') && k.reason.includes('決められません')));
});

test('an ad-hoc run whose record only says it stopped is kept: a conversation resumes (DEC-10041)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 0 } } } });
  // a chat / idea conversation is resumed from where it stopped: even a failed one is not closed by its ended_at
  const conversation = writeLaneJson(state, '2026-09-18-000000-chat', { status: 'failed', mode: 'conversation', ended_at: at('09:00') });
  // a run a person stopped, without a conversation marker: its ended_at alone is not closure either
  const stopped = writeLaneJson(state, '2026-09-18-000002-pause', { status: 'stopped', ended_at: at('10:00') });
  // a run that ended for good is still a candidate
  const done = writeLaneJson(state, '2026-09-18-000001-job', { status: 'done', ended_at: at('11:00') });
  const v = await judge({ now: Date.parse(at('23:00')), measure: false });
  assert.ok(v.kept.some((k) => k.path === conversation && k.reason.includes('記録にありません')), 'the conversation is kept');
  assert.ok(v.kept.some((k) => k.path === stopped && k.reason.includes('記録にありません')), 'the stopped run is kept');
  assert.ok(v.candidates.some((c) => c.path === done), 'the finished run is a candidate');
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(conversation), true);
  assert.equal(existsSync(stopped), true);
  assert.equal(existsSync(done), false);
  assert.ok(!r.removed.some((x) => x.path === conversation || x.path === stopped));
});

test('the wait time of a declared build output does not move when notes are added during the wait (AC-003)', async () => {
  const { clone, worktree } = gitRepo();
  const state = storageState();
  mkdirSync(join(worktree, 'build'), { recursive: true });
  writeFileSync(join(worktree, 'build', 'out.bin'), 'x'.repeat(64));
  writeRepos(state, {
    storage: { cleanup: true, places: { build_outputs: { cleanup: true, keep_hours: 6 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone, build_outputs: ['build'] } },
  });
  const lane = { idd_id: 'IDD-1', parent_id: null, created_at: at('00:00'), linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 't', area: 'Demo' };
  backlog(state, [lane]);
  const head = [
    { event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} },
    { event: 's1_ready', idd_id: 'IDD-1', at: at('01:00'), attrs: {} },
    { event: 's1_go', idd_id: 'IDD-1', at: at('02:00'), attrs: {} },
    { event: 's2_start', idd_id: 'IDD-1', at: at('03:00'), attrs: {} },
    { event: 's2_result', idd_id: 'IDD-1', at: at('04:00'), attrs: {} },
    { event: 's3_ready', idd_id: 'IDD-1', at: at('05:00'), attrs: {} },
    { event: 's3_ok', idd_id: 'IDD-1', at: at('06:00'), attrs: {} },
    { event: 's4_submit_started', idd_id: 'IDD-1', at: at('07:00'), attrs: {} },
  ];
  writeLifecycle(state, 'Demo', head);
  sessions(state, 'executor', [{ idd_id: 'IDD-1', executor_session_id: 'E-1', started_at: at('03:00'), worktree_path: worktree, branch: 'idd/idd-1' }]);
  setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'stopped', cause: 'finished', at: at('04:00') }), cwdBusy: () => false });
  try {
    const before = await judge({ measure: false });
    const c1 = before.candidates.find((x) => x.place === 'build_outputs');
    assert.ok(c1, 'the declared build output is a candidate');
    assert.equal(c1.usedUpAt, at('07:00'));
    // a note the base advance adds while the lane waits must not move the clock
    writeLifecycle(state, 'Demo', [...head, { event: 's1_base_advanced', idd_id: 'IDD-1', at: at('09:00'), attrs: {} }]);
    const after = await judge({ measure: false });
    assert.equal(after.candidates.find((x) => x.place === 'build_outputs').dueAt, c1.dueAt);
  } finally {
    setAgentRunner(null);
  }
});

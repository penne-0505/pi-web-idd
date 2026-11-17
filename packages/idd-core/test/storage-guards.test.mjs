import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOutputStillFree, judge } from '../src/storage/judge.ts';
import { stillDeletable, sweepStorage } from '../src/storage/sweep.ts';
import { lock } from '../src/overlay/git.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { storageState, writeRepos, writeLifecycle, backlog, sessions, writeLaneJson, gitRepo } from './helpers/storage-fixture.mjs';

const at = (s) => `2026-09-20T${s}:00+09:00`;
const closed = (id, closeAt) => [
  { event: 'lane_open', idd_id: id, at: at('00:00'), attrs: {} },
  { event: 'lane_close', idd_id: id, at: closeAt, attrs: { outcome: 'merged' } },
];

function reviewCopy(state, clone, name) {
  const copy = join(state, 'review-wt', name);
  mkdirSync(join(state, 'review-wt'), { recursive: true });
  execFileSync('git', ['-C', clone, 'worktree', 'add', '-q', '--detach', copy, 'HEAD']);
  writeFileSync(join(state, 'review-wt', `${name}.json`), JSON.stringify({ path: copy, repo: 'r', head: 'h', base: 'b', merge_base: 'm', created_at: at('00:00'), setup: [] }));
  return copy;
}

function gitRepoWithReviewRoot(prefix) {
  const r = gitRepo(prefix);
  // the clone doubles as the repo the review copies belong to
  return r;
}

test('a review copy named by a record outside the review root is kept (AC-004, INV-2722)', async () => {
  const { clone } = gitRepoWithReviewRoot('idd-guard-outside-');
  const state = storageState();
  const root = join(state, 'review-wt');
  mkdirSync(root, { recursive: true });
  writeRepos(state, { storage: { cleanup: true }, repos: { Demo: { github: 'o/r', upstream: clone, work: clone, review_root: root } } });
  // a review lane whose recorded copy lies outside today's root
  const outside = join(state, 'elsewhere-copy');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(state, 'reviews'), { recursive: true });
  writeFileSync(join(state, 'reviews', 'REV-1.json'), JSON.stringify({ id: 'REV-1', repo: 'o/r', pr: 1, title: 't', url: 'u', created_at: at('00:00'), history: [
    { event: 'r_opened', at: at('00:00'), attrs: {} },
    { event: 'r_wt_ready', at: at('01:00'), attrs: { path: outside } },
    { event: 'r_closed', at: at('02:00'), attrs: { reason: 'closed' } },
  ] }));
  const v = await judge({ measure: false });
  assert.equal(v.candidates.filter((c) => c.place === 'review_lane_copies').length, 0);
  assert.ok(v.kept.some((k) => k.place === 'review_lane_copies' && k.reason.includes('置き場の外')));
  assert.equal(existsSync(outside), true);
});

test('a directory the record does not name stays: a run without a lane.json is not a candidate (AC-005, INV-2721)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  mkdirSync(join(state, 'lanes', 'hand-made'), { recursive: true });
  writeFileSync(join(state, 'lanes', 'hand-made', 'notes.txt'), 'mine');
  const v = await judge({ measure: false });
  assert.equal(v.candidates.length, 0);
  assert.equal(existsSync(join(state, 'lanes', 'hand-made')), true);
});

test('a symlink under a place is not deleted, and its target stays (AC-006, INV-2722)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  writeLifecycle(state, 'Demo', closed('IDD-1', at('12:00')));
  const realDir = join(state, 'lanes', '2026-09-18-000000-executor');
  mkdirSync(realDir, { recursive: true });
  const target = join(state, 'precious');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'secret.txt'), 'keep me');
  // lane.json is a symlink to a real file: the directory is not a real dir and is left alone
  symlinkSync(join(target, 'secret.txt'), join(realDir, 'lane.json'));
  const v = await judge({ measure: false });
  assert.equal(v.candidates.filter((c) => c.place === 'run_records').length, 0);
  assert.equal(existsSync(join(target, 'secret.txt')), true);
});

test('an open lane keeps its runs and stage files, with the reason named (AC-007)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  writeLifecycle(state, 'Demo', [{ event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} }]);
  writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  mkdirSync(join(state, 'pipeline', 'review', 'IDD-1'), { recursive: true });
  const v = await judge({ measure: false });
  assert.equal(v.candidates.filter((c) => c.place === 'run_records' || c.place === 'stage_files').length, 0);
  assert.ok(v.kept.some((k) => k.place === 'run_records' && k.reason.includes('閉じていません')));
  assert.ok(v.kept.some((k) => k.place === 'stage_files' && k.reason.includes('閉じていません')));
});

test('a closed lane\'s fix-plan input is a candidate, and an open lane\'s stays (AC-030)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  writeLifecycle(state, 'Demo', [
    ...closed('IDD-1', at('12:00')),
    { event: 'lane_open', idd_id: 'IDD-2', at: at('00:00'), attrs: {} },
  ]);
  mkdirSync(join(state, 'pipeline', 'fix-plan', 'IDD-1'), { recursive: true });
  mkdirSync(join(state, 'pipeline', 'fix-plan', 'IDD-2'), { recursive: true });
  const v = await judge({ measure: false });
  const candidates = v.candidates.filter((c) => c.place === 'stage_files');
  assert.deepEqual(candidates.map((c) => c.lane), ['IDD-1']);
  assert.ok(candidates[0].path.includes(join('pipeline', 'fix-plan', 'IDD-1')));
  assert.ok(v.kept.some((k) => k.place === 'stage_files' && k.lane === 'IDD-2' && k.reason.includes('閉じていません')));
  assert.equal(existsSync(join(state, 'pipeline', 'fix-plan', 'IDD-2')), true);
});

test('a running session and an unknown session state both keep the declared build output (AC-008)', async () => {
  const { clone, worktree } = gitRepoWithReviewRoot('idd-guard-session-');
  const state = storageState();
  mkdirSync(join(worktree, 'build'), { recursive: true });
  writeFileSync(join(worktree, 'build', 'out.bin'), 'x');
  writeRepos(state, {
    storage: { cleanup: true, min_free_gb: 999999, places: { build_outputs: { cleanup: true, keep_hours: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone, build_outputs: ['build'] } },
  });
  backlog(state, [{ idd_id: 'IDD-1', parent_id: null, created_at: at('00:00'), linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 't', area: 'Demo' }]);
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
  sessions(state, 'executor', [{ idd_id: 'IDD-1', executor_session_id: 'E-1', started_at: at('03:00'), worktree_path: worktree, branch: 'b' }]);
  try {
    setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'running' }), cwdBusy: () => false });
    let v = await judge({ measure: false });
    assert.ok(v.kept.some((k) => k.place === 'build_outputs' && k.reason.includes('動いています')));
    setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'unknown' }), cwdBusy: () => false });
    v = await judge({ measure: false });
    assert.ok(v.kept.some((k) => k.place === 'build_outputs' && k.reason.includes('確かめられません')));
    assert.equal(existsSync(join(worktree, 'build')), true);
  } finally {
    setAgentRunner(null);
  }
});

test('an outbox body whose id climbs out of the place is kept, and the outer file stays (AC-004, INV-2722)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { outbox: { cleanup: true, keep_days: 0 } } } });
  writeLifecycle(state, 'Demo', closed('IDD-1', at('12:00')));
  mkdirSync(join(state, 'outbox'), { recursive: true });
  // the record names a body outside the place: the id climbs out with .., as a corrupt outbox.jsonl could
  const outside = join(state, 'precious.xml');
  writeFileSync(outside, '<secret/>');
  writeFileSync(join(state, 'outbox.jsonl'), `${JSON.stringify({ envelope_id: '../precious', idd_id: 'IDD-1' })}\n`);
  const v = await judge({ now: Date.parse(at('23:00')), measure: false });
  assert.equal(v.candidates.filter((c) => c.place === 'outbox').length, 0);
  assert.ok(v.kept.some((k) => k.place === 'outbox' && k.path === outside && k.reason.includes('置き場の外')));
  // the guard just before the delete asks the same containment
  const forged = { place: 'outbox', path: outside, bytes: 0, usedUpAt: at('12:00'), dueAt: at('00:00'), lane: 'IDD-1', removal: 'file', evidence: { kind: 'ledger' } };
  const g = await stillDeletable(forged);
  assert.equal(g.ok, false);
  assert.match(g.reason, /置き場の外/);
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(outside), true);
  assert.ok(!r.removed.some((x) => x.path === outside));
});

test('a run record swapped for a symlink just before the delete is not emptied (AC-006, INV-2722)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 0 } } } });
  writeLifecycle(state, 'Demo', closed('IDD-1', at('12:00')));
  const dir = writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  // the record is swapped for a symlink to somewhere else after the listing: the delete must refuse it
  const target = join(state, 'precious-run');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'secret.txt'), 'keep me');
  rmSync(dir, { recursive: true, force: true });
  symlinkSync(target, dir);
  const forged = { place: 'run_records', path: dir, bytes: 0, usedUpAt: at('12:00'), dueAt: at('00:00'), lane: 'IDD-1', removal: 'contents-then-evidence', evidence: { kind: 'lane-json', path: join(dir, 'lane.json') } };
  const g = await stillDeletable(forged);
  assert.equal(g.ok, false);
  assert.match(g.reason, /symlink|dir/);
  assert.equal(existsSync(join(target, 'secret.txt')), true);
});

test('a review lane waiting on penne\'s card keeps its copy, and a tracked file keeps a declared output (AC-009, AC-011)', async () => {
  const { clone, worktree } = gitRepoWithReviewRoot('idd-guard-card-');
  const state = storageState();
  const root = join(state, 'review-wt');
  mkdirSync(root, { recursive: true });
  // a tracked file under a declared output
  mkdirSync(join(worktree, 'dist'), { recursive: true });
  writeFileSync(join(worktree, 'dist', 'index.html'), 'x');
  execFileSync('git', ['-C', worktree, '-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '-A']);
  execFileSync('git', ['-C', worktree, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'build']);
  writeRepos(state, {
    storage: { cleanup: true, min_free_gb: 999999, places: { build_outputs: { cleanup: true, keep_hours: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone, review_root: root, build_outputs: ['dist'] } },
  });
  backlog(state, [{ idd_id: 'IDD-1', parent_id: null, created_at: at('00:00'), linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 't', area: 'Demo' }]);
  writeLifecycle(state, 'Demo', [
    { event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} },
    { event: 's1_ready', idd_id: 'IDD-1', at: at('01:00'), attrs: {} },
    { event: 's1_go', idd_id: 'IDD-1', at: at('02:00'), attrs: {} },
    { event: 's2_start', idd_id: 'IDD-1', at: at('03:00'), attrs: {} },
    { event: 's2_result', idd_id: 'IDD-1', at: at('04:00'), attrs: {} },
    { event: 's3_ready', idd_id: 'IDD-1', at: at('05:00'), attrs: {} },
    { event: 's3_ok', idd_id: 'IDD-1', at: at('06:00'), attrs: {} },
    { event: 's4_submit_started', idd_id: 'IDD-1', at: at('07:00'), attrs: {} },
  ]);
  sessions(state, 'executor', [{ idd_id: 'IDD-1', executor_session_id: 'E-1', started_at: at('03:00'), worktree_path: worktree, branch: 'b' }]);
  // a review lane whose card waits for penne
  const copy = reviewCopy(state, clone, 'pr-9');
  mkdirSync(join(state, 'reviews'), { recursive: true });
  writeFileSync(join(state, 'reviews', 'REV-2.json'), JSON.stringify({ id: 'REV-2', repo: 'o/r', pr: 9, title: 't', url: 'u', created_at: at('00:00'), history: [
    { event: 'r_wt_ready', at: at('01:00'), attrs: { path: copy, base: 'b', head: 'h' } },
    { event: 'r_drafted', at: at('02:00'), attrs: { outbound_id: 'OB-1' } },
  ] }));
  setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'stopped', cause: 'finished', at: at('04:00') }), cwdBusy: () => false });
  try {
    const v = await judge({ measure: false });
    assert.ok(v.kept.some((k) => k.place === 'build_outputs' && k.reason.includes('追跡するファイル')));
    assert.ok(v.kept.some((k) => k.place === 'review_lane_copies' && k.reason.includes('閉じていません')));
    assert.equal(existsSync(copy), true);
  } finally {
    setAgentRunner(null);
  }
});

test('a manual copy is listed with a size and stays ON and short of space (AC-012)', async () => {
  const { clone } = gitRepoWithReviewRoot('idd-guard-manual-');
  const state = storageState();
  const root = join(state, 'review-wt');
  mkdirSync(root, { recursive: true });
  writeRepos(state, { storage: { cleanup: true, min_free_gb: 999999 }, repos: { Demo: { github: 'o/r', upstream: clone, work: clone, review_root: root } } });
  const copy = join(root, 'my-copy');
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'f'), 'x'.repeat(10));
  writeFileSync(join(root, 'my-copy.json'), JSON.stringify({ path: copy, repo: 'r', head: 'h', base: 'b', merge_base: 'm', created_at: at('00:00'), setup: [] }));
  const v = await judge({ measure: false });
  const manual = v.places.find((p) => p.place === 'manual_copies');
  assert.equal(manual.count, 1);
  assert.equal(v.candidates.filter((c) => c.place === 'manual_copies').length, 0);
  assert.ok(v.kept.some((k) => k.place === 'manual_copies'));
  const s = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(copy), true);
});

test('the branches and their heads do not move: the sweep only removes review copies (AC-010, INV-2725)', async () => {
  const { clone, worktree } = gitRepoWithReviewRoot('idd-guard-branch-');
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  writeLifecycle(state, 'Demo', closed('IDD-1', at('12:00')));
  // a lane worktree with an unpushed commit
  writeFileSync(join(worktree, 'work.txt'), 'unpushed');
  execFileSync('git', ['-C', worktree, '-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '-A']);
  execFileSync('git', ['-C', worktree, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'work']);
  writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  const branches = execFileSync('git', ['-C', clone, 'branch', '-v', '--format=%(refname:short) %(objectname)'], { encoding: 'utf8' });
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(execFileSync('git', ['-C', clone, 'branch', '-v', '--format=%(refname:short) %(objectname)'], { encoding: 'utf8' }), branches);
  assert.equal(existsSync(worktree), true);
  assert.equal(existsSync(join(worktree, 'work.txt')), true);
});

/** a declared build output under a lane waiting on a person, with a stopped executor session */
function buildOutputFixture(prefix) {
  const { clone, worktree } = gitRepo(prefix);
  const state = storageState();
  const build = join(worktree, 'build');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'out.bin'), 'x'.repeat(64));
  writeRepos(state, {
    storage: { cleanup: true, min_free_gb: 999999, places: { build_outputs: { cleanup: true, keep_hours: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone, build_outputs: ['build'] } },
  });
  backlog(state, [{ idd_id: 'IDD-1', parent_id: null, created_at: at('00:00'), linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 't', area: 'Demo' }]);
  writeLifecycle(state, 'Demo', [
    { event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} },
    { event: 's1_ready', idd_id: 'IDD-1', at: at('01:00'), attrs: {} },
    { event: 's1_go', idd_id: 'IDD-1', at: at('02:00'), attrs: {} },
    { event: 's2_start', idd_id: 'IDD-1', at: at('03:00'), attrs: {} },
    { event: 's2_result', idd_id: 'IDD-1', at: at('04:00'), attrs: {} },
    { event: 's3_ready', idd_id: 'IDD-1', at: at('05:00'), attrs: {} },
    { event: 's3_ok', idd_id: 'IDD-1', at: at('06:00'), attrs: {} },
    { event: 's4_submit_started', idd_id: 'IDD-1', at: at('07:00'), attrs: {} },
  ]);
  sessions(state, 'executor', [{ idd_id: 'IDD-1', executor_session_id: 'E-1', started_at: at('03:00'), worktree_path: worktree, branch: 'idd/idd-1' }]);
  return { state, clone, worktree, build };
}

test('a runtime that cannot tell a worktree busy keeps the declared build output (DEC-10046)', async () => {
  const { build } = buildOutputFixture('idd-guard-nocwdbusy-');
  try {
    // a runtime with sessionStatus but no cwdBusy: the worktree's own busy state cannot be told, so nothing goes
    setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'stopped', cause: 'finished', at: at('04:00') }) });
    const v = await judge({ measure: false });
    assert.equal(v.candidates.filter((c) => c.place === 'build_outputs').length, 0);
    const p = v.places.find((x) => x.place === 'build_outputs');
    assert.equal(p.sweepable, false);
    assert.match(p.note, /確かめられません/);
    const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
    assert.equal(existsSync(build), true);
    assert.ok(!r.removed.some((x) => x.place === 'build_outputs'));
  } finally {
    setAgentRunner(null);
  }
});

test('a check running in the worktree keeps the declared build output (DEC-10046)', async () => {
  const { worktree, build } = buildOutputFixture('idd-guard-check-');
  let release;
  try {
    setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'stopped', cause: 'finished', at: at('04:00') }), cwdBusy: () => false });
    // the repo's checks are running: the overlay lock says so, as it does for a submit or a landing check
    release = lock(worktree, { checks: true });
    const v = await judge({ measure: false });
    assert.ok(v.kept.some((k) => k.place === 'build_outputs' && k.reason.includes('検査')), 'the check keeps it');
    const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
    assert.equal(existsSync(build), true);
    assert.ok(!r.removed.some((x) => x.place === 'build_outputs'));
  } finally {
    try { release?.(); } catch { /* already gone */ }
    setAgentRunner(null);
  }
});

test('a build output is checked again just before the delete (DEC-10042)', async () => {
  const { state, worktree, build } = buildOutputFixture('idd-guard-recheck-');
  try {
    setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'stopped', cause: 'finished', at: at('04:00') }), cwdBusy: () => false });
    const v = await judge({ measure: false });
    const c = v.candidates.find((x) => x.place === 'build_outputs');
    assert.ok(c, 'the declared build output is a candidate');
    assert.equal((await buildOutputStillFree(c)).ok, true);

    // the session started since the listing
    setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'running' }), cwdBusy: () => false });
    let g = await buildOutputStillFree(c);
    assert.equal(g.ok, false);
    assert.match(g.reason, /動いています/);

    // a tracked file appeared in the output
    setAgentRunner({ deliver: async () => {}, sessionStatus: async () => ({ state: 'stopped', cause: 'finished', at: at('04:00') }), cwdBusy: () => false });
    writeFileSync(join(build, 'index.html'), 'x');
    execFileSync('git', ['-C', worktree, '-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '-A']);
    execFileSync('git', ['-C', worktree, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'build']);
    g = await buildOutputStillFree(c);
    assert.equal(g.ok, false);
    assert.match(g.reason, /追跡するファイル/);

    // the target became a symlink
    rmSync(build, { recursive: true, force: true });
    mkdirSync(join(worktree, 'elsewhere'), { recursive: true });
    symlinkSync(join(worktree, 'elsewhere'), build);
    g = await buildOutputStillFree(c);
    assert.equal(g.ok, false);
    assert.match(g.reason, /symlink/);
    void state;
  } finally {
    setAgentRunner(null);
  }
});

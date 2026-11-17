import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { isStartHoldError, laneStartHold } from '../src/storage/hold.ts';
import { runPrep } from '../src/plan/prep.ts';
import { runExec } from '../src/plan/exec.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { tmpDir } from './helpers/tmp.mjs';

const at = (s) => `2026-09-20T${s}:00+09:00`;

/** a work clone with an overlay manifest and a work base, the shape ensureLaneWorktree needs */
function holdRepo(minFreeGb) {
  const root = tmpDir('idd-hold-');
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', work, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'app.txt'), 'a\n');
  writeFileSync(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'work-main');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_REPOS_FILE = join(root, 'repos.yaml');
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({
    storage: { cleanup: false, min_free_gb: minFreeGb },
    repos: { demo: { github: 'o/r', upstream: work, work, public_base: 'main', work_base: 'work-main', lanes_root: join(root, 'lanes'), checks: [] } },
  }));
  process.env.IDD_ROLES_FILE = join(root, 'roles.yaml');
  writeFileSync(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r, concurrency: 1 }\n  executor: { role: r, concurrency: 1 }\n');
  return { root, work, state, lanes: join(root, 'lanes') };
}

function backlogRec(state, iddId) {
  writeFileSync(join(state, 'backlog.jsonl'), `${JSON.stringify({ idd_id: iddId, parent_id: null, created_at: at('00:00'), linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 't', area: 'demo' })}\n`);
}

function lifecycle(state, events) {
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

test('a lane place short of space holds a new worktree back, without recording a failure (AC-030)', () => {
  const { state, lanes } = holdRepo(999999);
  backlogRec(state, 'IDD-1');
  lifecycle(state, [{ event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} }]);
  const before = readFileSync(join(state, 'lifecycle-demo.jsonl'), 'utf8');
  const hold = laneStartHold('demo');
  assert.ok(hold, 'the place is below the threshold');
  assert.match(hold.reason, /空きが足りない/);
  let held = false;
  try {
    ensureLaneWorktree('demo', 'IDD-1');
  } catch (err) {
    held = isStartHoldError(err);
    assert.match(err.message, /空きが足りない/);
  }
  assert.equal(held, true, 'a typed hold error, not a failure');
  assert.equal(existsSync(join(lanes, 'IDD-1')), false);
  assert.equal(readFileSync(join(state, 'lifecycle-demo.jsonl'), 'utf8'), before);
});

test('with space available the worktree is cut, and an existing one is not held (AC-030, AC-032)', () => {
  const { lanes } = holdRepo(0);
  const made = ensureLaneWorktree('demo', 'IDD-1');
  assert.equal(existsSync(join(lanes, 'IDD-1')), true);
  assert.ok(made.branch);
  // an existing worktree is returned even when the place is below the threshold
  process.env.IDD_REPOS_FILE = process.env.IDD_REPOS_FILE;
  writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify({
    storage: { cleanup: false, min_free_gb: 999999 },
    repos: { demo: { github: 'o/r', upstream: made.path, work: made.path, public_base: 'main', work_base: 'work-main', lanes_root: lanes, checks: [] } },
  }));
  const again = ensureLaneWorktree('demo', 'IDD-1');
  assert.equal(again.path, made.path);
});

test('the survey and the implementation both report the hold as the reason (AC-031)', async () => {
  const { state } = holdRepo(999999);
  backlogRec(state, 'IDD-1');
  // a survey lane: opened, no planner session yet
  lifecycle(state, [{ event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} }]);
  const spawned = [];
  setAgentRunner({ deliver: async () => {}, spawn: async (o) => { spawned.push(o); return { sessionId: 'S' }; } });
  try {
    const prep = await runPrep();
    assert.equal(spawned.length, 0);
    assert.ok(prep.skipped.some((s) => s.reason.includes('空きが足りない')), prep.skipped.map((s) => s.reason).join(', '));
    // nothing was recorded as a start
    assert.equal(readFileSync(join(state, 'lifecycle-demo.jsonl'), 'utf8').includes('s1_prep_start'), false);
  } finally {
    setAgentRunner(null);
  }

  const impl = holdRepo(999999);
  backlogRec(impl.state, 'IDD-1');
  lifecycle(impl.state, [
    { event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} },
    { event: 's1_ready', idd_id: 'IDD-1', at: at('01:00'), attrs: {} },
    { event: 's1_go', idd_id: 'IDD-1', at: at('02:00'), attrs: {} },
  ]);
  const execs = [];
  setAgentRunner({ deliver: async () => {}, spawn: async (o) => { execs.push(o); return { sessionId: 'S' }; } });
  try {
    const exec = await runExec();
    assert.equal(execs.length, 0);
    assert.ok(exec.skipped.some((s) => s.reason.includes('空きが足りない')));
    assert.equal(readFileSync(join(impl.state, 'lifecycle-demo.jsonl'), 'utf8').includes('s2_start'), false);
  } finally {
    setAgentRunner(null);
  }
});

test('with space back, the same start cuts the worktree (AC-032)', async () => {
  const f = holdRepo(999999);
  backlogRec(f.state, 'IDD-1');
  lifecycle(f.state, [{ event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} }]);
  setAgentRunner({ deliver: async () => {}, spawn: async () => ({ sessionId: 'S' }) });
  try {
    const held = await runPrep();
    assert.ok(held.skipped.some((s) => s.reason.includes('空きが足りない')));
  } finally {
    setAgentRunner(null);
  }
  // the threshold moves back: the same start now cuts the worktree
  writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify({
    storage: { cleanup: false, min_free_gb: 0 },
    repos: { demo: { github: 'o/r', upstream: f.work, work: f.work, public_base: 'main', work_base: 'work-main', lanes_root: f.lanes, checks: [] } },
  }));
  const made = ensureLaneWorktree('demo', 'IDD-1');
  assert.equal(existsSync(made.path), true);
});

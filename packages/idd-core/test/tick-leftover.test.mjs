import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAfterDecision, runTick } from '../src/plan/tick.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { queueEnvelope } from '../src/ledger/write.ts';
import lockfile from 'proper-lockfile';
import { tmpDir } from './helpers/tmp.mjs';

const TICK_AGAIN_FILE = 'tick.again';
const ev = (event, attrs = {}, at = '2026-09-01T10:00:00+09:00') => ({ event, idd_id: 'IDD-001', at, attrs });

/** a lane past its executor's result; no repo is registered, so an intake scans nothing and reaches no network */
function setup(extra = []) {
  const state = tmpDir('idd-tick-left-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(join(state, 'repos.yaml'), 'repos: {}\n');
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = tmpDir('idd-tick-left-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' }), ...extra].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

const runs = (state) => readdirSync(state).filter((f) => f.startsWith('cron-run-'));
const gated = () => {
  let enter; const entered = new Promise((r) => { enter = r; });
  let open; const gate = new Promise((r) => { open = r; });
  return { entered, enter, gate, open };
};

test('a request still there when the tick lets the lock go (past its last pass) is handed back as pending, so the caller books another tick', { timeout: 20_000 }, async () => {
  const state = setup([ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] })]);
  setAgentRunner({ deliver: async () => {}, reviewRunStatus: () => { writeFileSync(join(state, TICK_AGAIN_FILE), 'x'); return { state: 'running' }; } });
  const r = await runTick({ intake: false });
  assert.equal(r.again.length, 5);
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), true);
  assert.equal(r.pending, true);
  setAgentRunner(null);
});

test('a tick with nothing left behind hands back no pending', { timeout: 20_000 }, async () => {
  setup();
  setAgentRunner({ deliver: async () => {} });
  const r = await runTick({ intake: false });
  assert.equal(r.pending, undefined);
  setAgentRunner(null);
});

test('a request left while the GO held the lock is handed back as pending by the GO', { timeout: 20_000 }, async () => {
  setup();
  const g = gated();
  await queueEnvelope('IDD-001', 'info_update', '<x/>');
  // the GO's delivery is slow: a tick comes in meanwhile and is skipped
  setAgentRunner({ deliver: async () => { g.enter(); await g.gate; } });
  const go = runAfterDecision({ exec: false });
  await g.entered;
  assert.deepEqual(await runTick({ intake: false }), { skipped: 'another tick is running' });
  g.open();
  const after = await go;
  assert.equal(after.pending, true);
  setAgentRunner(null);
});

test('a GO that finds the lock held leaves a request and says a later tick does it, not only the running one', { timeout: 20_000 }, async () => {
  const state = setup();
  setAgentRunner({ deliver: async () => {} });
  writeFileSync(join(state, 'tick.lock'), '');
  const release = await lockfile.lock(join(state, 'tick.lock'));
  const r = await runAfterDecision({ exec: true });
  await release();
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), true);
  assert.match(r.deferred, /後の tick/);
  setAgentRunner(null);
});

test('an intake tick that finds the lock held is not lost: the holder runs a pass with the intake', { timeout: 20_000 }, async () => {
  const state = setup([ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] })]);
  const g = gated();
  await queueEnvelope('IDD-001', 'info_update', '<x/>');
  // the tick is held in its first pass by a hook it awaits (the delivery); the run's status is read without waiting
  setAgentRunner({
    deliver: async () => { g.enter(); await g.gate; },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  const kick = runTick({ intake: false });
  await g.entered;
  assert.deepEqual(await runTick({ intake: true }), { skipped: 'another tick is running' });
  assert.deepEqual(runs(state), []);
  g.open();
  const r = await kick;
  assert.equal(runs(state).length, 1, 'the holder took Issues in once for the timer tick');
  assert.equal(r.again?.length, 1);
  assert.equal(r.pending, undefined);
  setAgentRunner(null);
});

test('an intake asked for while a GO held the lock is run by the next tick, even one booked without the intake', { timeout: 20_000 }, async () => {
  const state = setup();
  const g = gated();
  await queueEnvelope('IDD-001', 'info_update', '<x/>');
  setAgentRunner({ deliver: async () => { g.enter(); await g.gate; } });
  const go = runAfterDecision({ exec: false });
  await g.entered;
  assert.deepEqual(await runTick({ intake: true }), { skipped: 'another tick is running' });
  g.open();
  assert.equal((await go).pending, true);
  setAgentRunner({ deliver: async () => {} });
  assert.deepEqual(runs(state), []);
  const r = await runTick({ intake: false });
  assert.equal(runs(state).length, 1, 'the booked tick took Issues in for the timer tick it stood in for');
  assert.equal(r.pending, undefined);
  setAgentRunner(null);
});

test('a lane whose stage could not start is not tried again in the same tick, nor within minutes of its failure', { timeout: 20_000 }, async () => {
  const state = setup([
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/B.json'] }),
  ]);
  let tried = 0;
  setAgentRunner({
    deliver: async () => {},
    // each failed start also leaves a request, as a finished lane elsewhere would
    startReviewRun: async () => { tried += 1; writeFileSync(join(state, TICK_AGAIN_FILE), 'x'); throw new Error('ENOSPC'); },
  });
  const failures = () => readLifecycle().filter((e) => e.event === 's2_review_run_failed');
  await runTick({ intake: false });
  assert.equal(tried, 1, 'one try in the tick');
  assert.equal(failures().length, 1);
  await runTick({ intake: false });
  assert.equal(tried, 1, 'a tick right after waits');
  assert.equal(readLifecycle().some((e) => e.event === 's2_review_escalated'), false);
  // minutes later the next tick tries again
  const file = join(state, 'lifecycle-Demo.jsonl');
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const e = JSON.parse(l); if (e.event === 's2_review_run_failed') e.at = old; return JSON.stringify(e); }).join('\n') + '\n');
  await runTick({ intake: false });
  assert.equal(tried, 2);
  setAgentRunner(null);
});

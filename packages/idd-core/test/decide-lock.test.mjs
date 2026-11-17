import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runAfterDecision, runTick } from '../src/plan/tick.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { tmpDir } from './helpers/tmp.mjs';

const TICK_AGAIN_FILE = 'tick.again';
const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-26T10:00:00+09:00', attrs });

/** a registered repo and a lane that penne just sent past GO, with a contract the executor can start on */
function goneLane() {
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const root = tmpDir('idd-decide-lock-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main'); put(join(work, 'app.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'rules'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'overlay');
  const repos = join(root, 'repos.yaml');
  put(repos, JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n  executor: { role: r, concurrency: 3 }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: repos, IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'unused') });
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', area: 'demo', title: 'T', context: '' }) + '\n');
  put(join(state, 'lifecycle-demo.jsonl'), [ev('lane_open'), ev('s1_ready'), ev('s1_go')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const lanePath = ensureLaneWorktree('demo', 'IDD-001').path;
  put(join(lanePath, '_docs', 'intent', 'demo', 'idd-001', 'decision.md'), '### DEC-1: 何かを決める\n');
  return { state };
}

/** an executor spawn that holds until the test lets it go, so the other caller comes in meanwhile */
function slowSpawn() {
  const spawned = [];
  let enter; const entered = new Promise((r) => { enter = r; });
  let open; const gate = new Promise((r) => { open = r; });
  setAgentRunner({
    spawn: async () => { spawned.push(Date.now()); enter(); await gate; return { sessionId: `E${spawned.length}`, model: 'x/y', harness: 'pi' }; },
    deliver: async () => {},
  });
  return { spawned, entered, open };
}

const starts = () => readLifecycle().filter((e) => e.event === 's2_start').length;

test('a GO that lands while a tick is starting the executor does not start a second one: the tick takes it on its next pass', { timeout: 30_000 }, async () => {
  const { state } = goneLane();
  const s = slowSpawn();
  const tick = runTick({ intake: false });
  await s.entered;
  const go = runAfterDecision({ exec: true });
  // a GO that spawned alongside would wait on the same gate: give it the time to reach the spawn
  await Promise.race([go, new Promise((r) => setTimeout(r, 500))]);
  assert.equal(s.spawned.length, 1, 'the GO did not spawn alongside the tick');
  s.open();
  const after = await go;
  assert.ok(after.deferred, 'the GO says the start was left to the running tick');
  const r = await tick;
  assert.equal(s.spawned.length, 1);
  assert.equal(starts(), 1);
  assert.ok(r.again?.length >= 1, 'the tick made another pass for the GO');
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), false);
  setAgentRunner(null);
});

test('a tick that comes while a GO is starting the executor is skipped and leaves a request, and the executor starts once', { timeout: 30_000 }, async () => {
  const { state } = goneLane();
  const s = slowSpawn();
  const go = runAfterDecision({ exec: true });
  await s.entered;
  const tick = runTick({ intake: false });
  // a tick that went on would wait on the same gate in its executor start
  const early = await Promise.race([tick, new Promise((r) => setTimeout(() => r('still running'), 500))]);
  s.open();
  await tick;
  assert.deepEqual(early, { skipped: 'another tick is running' });
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), true);
  const after = await go;
  assert.deepEqual(after.started.started.map((x) => x.sessionId), ['E1']);
  assert.equal(s.spawned.length, 1);
  assert.equal(starts(), 1);
  // the next tick finds the executor started and starts nothing
  const r = await runTick({ intake: false });
  assert.deepEqual(r.exec.started, []);
  assert.equal(s.spawned.length, 1);
  setAgentRunner(null);
});

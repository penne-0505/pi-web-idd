import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runTick, TICK_HOLD_FILE } from '../src/plan/tick.ts';
import { runPrep } from '../src/plan/prep.ts';
import { setStaleHoldProvider } from '../src/plan/stale-hold.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { scratchDir } from './helpers/scratch.mjs';
import { tmpDir } from './helpers/tmp.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const runs = (state) => readdirSync(state).filter((f) => f.startsWith('cron-run-'));

/** a state with one lane still waiting for its planner; no repo is registered, so an intake scans nothing */
function stateSetup() {
  const state = tmpDir('idd-tick-hold-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(join(state, 'repos.yaml'), 'repos: {}\n');
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), JSON.stringify({ event: 'lane_open', idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs: {} }) + '\n');
  return state;
}

/** a project the planner can be cut a worktree in, for the one lane given */
function areaSetup(id) {
  const root = scratchDir('idd-tick-hold-area-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main');
  put(join(work, 'app.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n');
  put(join(work, 'AGENTS.override.md'), 'rules');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'overlay');
  put(join(root, 'repos.yaml'), JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r, concurrency: 1 }\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml') });
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: id, parent_id: null, created_at: '2026-09-25T01:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/t/p/issues/1', pull_req_url: null, source_type: 'github', context: '', title: id, area: 'demo' }) + '\n');
  put(join(state, 'lifecycle-demo.jsonl'), JSON.stringify({ event: 'lane_open', idd_id: id, at: '2026-09-25T01:00:00+09:00', attrs: {} }) + '\n');
  return state;
}

test('AC-001: a pass that holds takes nothing in and leaves the ask for the replacement', { timeout: 30_000 }, async () => {
  const state = stateSetup();
  setAgentRunner({ deliver: async () => {} });
  setStaleHoldProvider(() => ({ hold: true, reason: 'engine を入れ替えています' }));
  const r = await runTick({ intake: true });
  assert.equal(r.hold?.intake, true, 'the intake was held');
  assert.equal(r.hold?.prep, true, 'the planner starts were held');
  assert.equal(r.hold?.reason, 'engine を入れ替えています', 'the reason is on the result');
  assert.deepEqual(r.intake.added, []);
  assert.deepEqual(runs(state), [], 'no intake ran');
  assert.equal(r.pending, undefined, 'the held ask does not ask this engine for another tick');
  assert.equal(existsSync(join(state, 'tick.again')), false, 'no pass was asked for');
  const held = JSON.parse(readFileSync(join(state, TICK_HOLD_FILE), 'utf8'));
  assert.equal(held.reason, 'engine を入れ替えています');
  setStaleHoldProvider(null);
  setAgentRunner(null);
});

test('AC-005: a pass with no hold takes in as before and leaves nothing held', { timeout: 30_000 }, async () => {
  const state = stateSetup();
  setAgentRunner({ deliver: async () => {} });
  setStaleHoldProvider(() => ({ hold: false }));
  const r = await runTick({ intake: true });
  assert.equal(r.hold, undefined, 'nothing was held');
  assert.equal(runs(state).length, 1, 'the intake ran');
  assert.equal(existsSync(join(state, TICK_HOLD_FILE)), false);
  setStaleHoldProvider(null);
  setAgentRunner(null);
});

test('AC-003: the tick after the hold runs the held intake and clears the marker', { timeout: 30_000 }, async () => {
  const state = stateSetup();
  setAgentRunner({ deliver: async () => {} });
  setStaleHoldProvider(() => ({ hold: true, reason: 'engine を入れ替えています' }));
  await runTick({ intake: true });
  assert.equal(runs(state).length, 0, 'the held tick took nothing in');
  // the replacement starts: the hold is over, and the tick it booked at its start runs without the intake
  setStaleHoldProvider(() => ({ hold: false }));
  const r = await runTick({ intake: false });
  assert.equal(runs(state).length, 1, 'the held ask ran on the no-intake tick');
  assert.equal(existsSync(join(state, TICK_HOLD_FILE)), false, 'the request was used up');
  assert.equal(r.pending, undefined);
  setStaleHoldProvider(null);
  setAgentRunner(null);
});

test('AC-003: the held request keeps a named ask', { timeout: 30_000 }, async () => {
  const state = stateSetup();
  setAgentRunner({ deliver: async () => {} });
  setStaleHoldProvider(() => ({ hold: true, reason: 'engine を入れ替えています' }));
  await runTick({ intake: true, issueRefs: [{ number: 7 }] });
  const held = JSON.parse(readFileSync(join(state, TICK_HOLD_FILE), 'utf8'));
  assert.deepEqual(held.ask.issueRefs, [{ number: 7 }], 'the named Issue stays in the ask');
  setStaleHoldProvider(null);
  setAgentRunner(null);
});

test('AC-002: a held prep starts no planner and says why; the same start without the hold does', { timeout: 30_000 }, async () => {
  areaSetup('IDD-001');
  const spawned = [];
  setAgentRunner({ spawn: async (o) => { spawned.push(o.laneId); return { sessionId: `S-${o.laneId}` }; }, deliver: async () => {} });
  const held = await runPrep({ hold: 'engine を入れ替えています' });
  assert.deepEqual(held.started, [], 'no planner started');
  assert.equal(spawned.length, 0, 'the runner was not asked to start one');
  assert.equal(held.skipped.length, 1);
  assert.equal(held.skipped[0].reason, 'engine を入れ替えています', 'the reason is on the result');
  const ran = await runPrep();
  assert.deepEqual(ran.started.map((s) => s.iddId), ['IDD-001'], 'without the hold the planner starts');
  assert.equal(spawned.length, 1);
  setAgentRunner(null);
});

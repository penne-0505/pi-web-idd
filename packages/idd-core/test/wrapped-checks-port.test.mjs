import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runPrep } from '../src/plan/prep.ts';
import { runExec } from '../src/plan/exec.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-10-05T10:00:00+09:00', attrs });

/**
 * An area whose lane worktree the engine can cut, with one public and one records check. The checks are what a
 * 5-minute run should wrap; the spawn port is the only place the hold reaches idd-core.
 */
function areaSetup(events) {
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const root = scratchDir('wrapped-checks-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main'); put(join(work, 'app.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'rules'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'overlay');
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: {
    github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'),
    checks: [
      { name: 'typecheck', command: 'tsc', required: true, scope: 'public', timeout_minutes: 10 },
      { name: 'docs', command: 'check-docs', required: false, scope: 'records' },
    ],
    issue_lane: { context: 'personal', source_type_priority: 'github' },
  } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'unused') });
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', area: 'demo', title: 'T', context: '' }) + '\n');
  put(join(state, 'lifecycle-demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { root, state, work };
}

test('the planner brief wraps its records checks when the spawn port reports a 5-minute claude run', async () => {
  areaSetup([ev('lane_open')]);
  const delivered = [];
  setAgentRunner({ spawn: async () => ({ sessionId: 'P9', model: 'm', harness: 'claude', cacheTtl: '5m' }), deliver: async (_id, text) => { delivered.push(text); } });
  const r = await runPrep();
  assert.deepEqual(r.started.map((s) => s.sessionId), ['P9'], JSON.stringify(r.skipped));
  assert.match(delivered[0], /idd wait-run --check docs/);
  assert.doesNotMatch(delivered[0], /idd wait-run --check typecheck/);
  assert.doesNotMatch(delivered[0], /<configured-checks>/);
  setAgentRunner(null);
});

test('the planner brief keeps the command JSON for a 1-hour or pi run', async () => {
  for (const spawn of [
    { sessionId: 'P9', model: 'm', harness: 'claude', cacheTtl: '1h' },
    { sessionId: 'P9', model: 'm', harness: 'pi', cacheTtl: '5m' },
  ]) {
    areaSetup([ev('lane_open')]);
    const delivered = [];
    setAgentRunner({ spawn: async () => spawn, deliver: async (_id, text) => { delivered.push(text); } });
    await runPrep();
    assert.match(delivered[0], /<configured-checks>/, `${JSON.stringify(spawn)}: the JSON stays`);
    assert.doesNotMatch(delivered[0], /<checks>/);
    setAgentRunner(null);
  }
});

test('the executor brief wraps all the repo checks when the spawn port reports a 5-minute claude run', async () => {
  areaSetup([ev('lane_open'), ev('s1_ready'), ev('s1_go')]);
  const lanePath = ensureLaneWorktree('demo', 'IDD-001').path;
  mkdirSync(join(lanePath, '_docs', 'intent', 'demo', 'idd-001'), { recursive: true });
  writeFileSync(join(lanePath, '_docs', 'intent', 'demo', 'idd-001', 'decision.md'), '### DEC-1: 何かを決める\n');
  const delivered = [];
  setAgentRunner({ spawn: async () => ({ sessionId: 'E9', model: 'm', harness: 'claude', cacheTtl: '5m' }), deliver: async (_id, text) => { delivered.push(text); } });
  const r = await runExec();
  assert.deepEqual(r.started.map((s) => s.sessionId), ['E9'], JSON.stringify(r.skipped));
  assert.match(delivered[0], /idd wait-run --check typecheck/);
  assert.match(delivered[0], /idd wait-run --check docs/);
  assert.doesNotMatch(delivered[0], /<configured-checks>/);
  setAgentRunner(null);
});

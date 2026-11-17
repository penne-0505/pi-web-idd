import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runPrep, plannerBrief } from '../src/plan/prep.ts';
import { executorBrief, fixBrief } from '../src/plan/exec.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLedger } from '../src/instruction/ledger.ts';

const ALL = { repos: 'all', scenes: 'all', places: 'all' };

function writeInstructions(dir, list) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'instructions.json'), JSON.stringify({
    version: 1, next: list.length + 1,
    instructions: list.map((i) => ({ ...i, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' })),
  }));
}

/** an area `demo` linked to `t/p`, one lane in its backlog, and an instruction dir of its own */
function setup(list) {
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' };
  Object.assign(process.env, env);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const root = scratchDir('instruction-delivery-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main'); put(join(work, 'app.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'rules'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'overlay');
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n  executor: { role: r }\n');
  const instructions = join(root, 'instructions');
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'unused'), IDD_INSTRUCTIONS_DIR: instructions });
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', area: 'demo', title: 'T', context: '' }) + '\n');
  put(join(state, 'lifecycle-demo.jsonl'), `${JSON.stringify({ event: 'lane_open', idd_id: 'IDD-001', at: '2026-09-24T10:00:00+09:00', attrs: {} })}\n`);
  writeInstructions(instructions, list);
  return { root, state, work };
}

const rec = { idd_id: 'IDD-001', area: 'demo', title: 'T', context: '' };

const PLAN = { id: 'INS-1', text: '計画は短く書く。', reason: '長い計画は読まれないから', scope: { repos: ['t/p'], scenes: ['plan'], places: ['lane'] } };
const IMPLEMENT = { id: 'INS-2', text: '実装は小さく commit する。', reason: '差分が読みやすいから', scope: { repos: ['t/p'], scenes: ['implement'], places: 'all' } };
const OTHER_REPO = { id: 'INS-3', text: '別の repo の計画は長く書く。', reason: '別の事情', scope: { repos: ['x/y'], scenes: ['plan', 'implement'], places: 'all' } };
const REVIEW = { id: 'INS-4', text: 'レビューは短く書く。', reason: '読まれないから', scope: { repos: 'all', scenes: ['review'], places: 'all' } };

test('the planner receives the plan scene of its repo, and the implementer and the fix session the implement scene', () => {
  const { work } = setup([PLAN, IMPLEMENT, OTHER_REPO, REVIEW]);
  const planner = plannerBrief(rec, undefined, work);
  assert.match(planner, /<instructions>/);
  assert.match(planner, /計画は短く書く。（理由: 長い計画は読まれないから）/);
  for (const absent of [IMPLEMENT, OTHER_REPO, REVIEW]) assert.doesNotMatch(planner, new RegExp(absent.text), absent.id);

  const executor = executorBrief(rec, work);
  assert.match(executor, /実装は小さく commit する。（理由: 差分が読みやすいから）/);
  for (const absent of [PLAN, OTHER_REPO, REVIEW]) assert.doesNotMatch(executor, new RegExp(absent.text), absent.id);

  const fix = fixBrief(rec, work, '<propter-system-message>\n  <task>\n    直す。\n  </task>\n  <callback>\n  </callback>\n</propter-system-message>');
  assert.match(fix, /実装は小さく commit する。/);
  assert.doesNotMatch(fix, /計画は短く書く。/);
});

test('with no instruction in scope the planner brief carries no section', () => {
  const { work } = setup([IMPLEMENT, REVIEW]);
  assert.doesNotMatch(plannerBrief(rec, undefined, work), /<instructions>/);
});

test('the planner delivery writes its ledger line once the run has started, and none when the delivery failed', async () => {
  const { state } = setup([PLAN, IMPLEMENT]);
  const delivered = [];
  setAgentRunner({ spawn: async () => ({ sessionId: 'P9', model: 'x/y', harness: 'pi' }), deliver: async (id, brief) => { delivered.push({ id, brief }); } });
  const r = await runPrep();
  assert.deepEqual(r.started.map((s) => s.sessionId), ['P9'], JSON.stringify(r.skipped));
  assert.match(delivered[0].brief, /計画は短く書く。/);
  const lines = readLedger({ lane: 'IDD-001' });
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].instruction, lines[0].text, lines[0].via], ['INS-1', '計画は短く書く。', 'scope']);
  assert.deepEqual(lines[0].to, { kind: 'lane', stage: 'plan', scene: 'plan', lane: 'IDD-001', run: 'P9' });
  setAgentRunner(null);
  assert.ok(state);
});

test('a planner whose delivery failed leaves nothing in the ledger', async () => {
  setup([PLAN]);
  setAgentRunner({ spawn: async () => ({ sessionId: 'P8', model: 'x/y', harness: 'pi' }), deliver: async () => { throw new Error('the harness is gone'); } });
  await runPrep();
  assert.deepEqual(readLedger(), []);
  setAgentRunner(null);
});

test('an instruction file no one can read is no instruction: the brief is the same and the lane starts', async () => {
  const { root, work } = setup([PLAN]);
  writeFileSync(join(root, 'instructions', 'instructions.json'), '{ broken');
  assert.doesNotMatch(plannerBrief(rec, undefined, work), /<instructions>/);
  setAgentRunner({ spawn: async () => ({ sessionId: 'P7', model: 'x/y', harness: 'pi' }), deliver: async () => {} });
  const r = await runPrep();
  assert.deepEqual(r.started.map((s) => s.sessionId), ['P7'], JSON.stringify(r.skipped));
  assert.deepEqual(readLedger(), []);
  setAgentRunner(null);
});

test('the brief of a repo-scoped instruction is the same for the same input', () => {
  const { work } = setup([PLAN, IMPLEMENT]);
  assert.equal(plannerBrief(rec, undefined, work), plannerBrief(rec, undefined, work));
  assert.equal(ALL.repos, 'all');
});

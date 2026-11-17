import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runPlanReview } from '../src/plan/plan-review.ts';
import { runReviewLoop } from '../src/plan/review-loop.ts';
import { runPrep } from '../src/plan/prep.ts';
import { runExec } from '../src/plan/exec.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { laneCost } from '../src/plan/budget.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { tmpDir } from './helpers/tmp.mjs';

// what the runner reports when a Claude Code role was refused for the windows and its fallback ran instead
const RESETS = Date.parse('2026-09-24T07:00:00Z') / 1000;
const fallback = { role: 'escalation', fallback: 'blind-reviewer-deep', reason: 'Claude の枠が止める閾値に達しているので lane を起動しません: 5 時間の枠 95%', resets_at: RESETS };

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-24T10:00:00+09:00', attrs });
const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-001');
const fallbacks = () => lane().filter((e) => e.event === 'claude_quota_fallback');

function setup(pipeline, events) {
  const state = tmpDir('idd-quota-fallback-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipeline}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-quota-fallback-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', title: 'T', area: 'Demo', context: '' }) + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', planner_session_id: 'P1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events(head).map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state, wt, head };
}

test('a review stage run on a fallback for the windows says so on the event that records its start', async () => {
  setup('  executor: { role: r }\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n', (head) => [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })]);
  setAgentRunner({ deliver: async () => {}, startReviewRun: async () => ({ runIds: ['R1', 'R2'], fallbacks: [fallback] }), reviewRunStatus: () => ({ state: 'running' }) });
  await runReviewLoop();
  const started = lane().at(-1);
  assert.equal(started.event, 's2_review_started');
  assert.deepEqual(started.attrs.fallbacks, [fallback]);
  assert.deepEqual(started.attrs.run_ids, ['R1', 'R2']);
  assert.equal(fallbacks().length, 0, 'no line of its own ahead of the start');
  setAgentRunner(null);
});

test('a role that switched while the run was going says so, with its kind, on the record that closes the round', async () => {
  setup('  executor: { role: r }\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n', (head) => [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })]);
  const midRun = { role: 'r', fallback: 'api', kind: 'timeout', reason: '時間切れ', provider: 'together' };
  setAgentRunner({ deliver: async () => {}, startReviewRun: async () => ({ runIds: ['R1'] }), reviewRunStatus: () => ({ state: 'done', reportJson: 'r1.json', reportMd: 'r1.md', findings: [], fallbacks: [midRun] }) });
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_review_started');
  await runReviewLoop();
  const closing = lane().find((e) => e.event === 's2_review_findings');
  assert.deepEqual(closing.attrs.fallbacks, [midRun]);
  setAgentRunner(null);
});

test('a stage with no fallback run adds nothing', async () => {
  setup('  executor: { role: r }\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n', (head) => [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })]);
  setAgentRunner({ deliver: async () => {}, startReviewRun: async () => ({ runIds: ['R1'] }), reviewRunStatus: () => ({ state: 'running' }) });
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_review_started');
  assert.equal('fallbacks' in lane().at(-1).attrs, false);
  setAgentRunner(null);
});

test('a plan review on a fallback says so on its start, which keeps the model that ran', async () => {
  setup('  plan_review: { role: r }\n', () => [ev('lane_open'), ev('s1_ready')]);
  setAgentRunner({ deliver: async () => {}, startPlanReview: async () => ({ runs: [{ runId: 'R1', role: 'blind-reviewer-deep', model: 'openrouter/z-ai/glm-5.3' }], fallbacks: [fallback] }) });
  await runPlanReview();
  const started = lane().find((e) => e.event === 's1_plan_review_started');
  assert.deepEqual(started.attrs.runs, [{ run_id: 'R1', role: 'blind-reviewer-deep', model: 'openrouter/z-ai/glm-5.3' }]);
  assert.deepEqual(started.attrs.fallbacks, [fallback]);
  assert.equal(fallbacks().length, 0);
  setAgentRunner(null);
});

/** an area whose lane worktree the engine can cut (the overlay test's shape), and one lane in its backlog */
function areaSetup(events) {
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' };
  Object.assign(process.env, env);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const root = scratchDir('quota-fallback-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main'); put(join(work, 'app.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'rules'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'overlay');
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'unused') });
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', area: 'demo', title: 'T', context: '' }) + '\n');
  put(join(state, 'lifecycle-demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { root, state };
}

test('a planner spawned on a fallback is on its session record, and on the lane after the session is recorded', async () => {
  const { state } = areaSetup([ev('lane_open')]);
  const delivered = [];
  setAgentRunner({ spawn: async () => ({ sessionId: 'P9', model: 'x/y', harness: 'pi', fallbacks: [fallback] }), deliver: async (id) => { delivered.push(id); } });
  const r = await runPrep();
  assert.deepEqual(r.started.map((s) => s.sessionId), ['P9'], JSON.stringify(r.skipped));
  const session = JSON.parse(readFileSync(join(state, 'planner-sessions.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(session.harness, 'pi');
  assert.deepEqual(session.fallbacks, [fallback]);
  assert.deepEqual(fallbacks().map((e) => [e.attrs.stage, e.attrs.fallback]), [['planner', 'blind-reviewer-deep']]);
  assert.deepEqual(delivered, ['P9']);
  setAgentRunner(null);
});

test('an executor spawned on a fallback says so on s2_start and its session record', async () => {
  const { root, state } = areaSetup([ev('lane_open'), ev('s1_ready'), ev('s1_go')]);
  const lanePath = ensureLaneWorktree('demo', 'IDD-001').path;
  mkdirSync(join(lanePath, '_docs', 'intent', 'demo', 'idd-001'), { recursive: true });
  writeFileSync(join(lanePath, '_docs', 'intent', 'demo', 'idd-001', 'decision.md'), '### DEC-1: 何かを決める\n');
  setAgentRunner({ spawn: async () => ({ sessionId: 'E9', model: 'x/y', harness: 'pi', fallbacks: [fallback] }), deliver: async () => {} });
  const r = await runExec();
  assert.deepEqual(r.started.map((s) => s.sessionId), ['E9'], JSON.stringify(r.skipped));
  const start = lane().find((e) => e.event === 's2_start');
  assert.deepEqual(start.attrs.fallbacks, [fallback]);
  assert.equal(start.attrs.harness, 'pi');
  const session = JSON.parse(readFileSync(join(state, 'executor-sessions.jsonl'), 'utf8').trim().split('\n').pop());
  assert.deepEqual(session.fallbacks, [fallback]);
  assert.equal(fallbacks().length, 0);
  assert.ok(root);
  setAgentRunner(null);
});

test("a fallback run is API spend: it counts toward the lane's budget, unlike the Claude Code role it stood in for", async () => {
  const { state } = setup('', () => [ev('lane_open'), ev('s2_review_started', { run_ids: ['F1', 'C1'] })]);
  for (const [id, cost, harness, extra] of [['F1', 0.4, 'pi', { quota_fallback: fallback }], ['C1', 3, 'claude', {}]]) {
    mkdirSync(join(state, 'lanes', id), { recursive: true });
    writeFileSync(join(state, 'lanes', id, 'lane.json'), JSON.stringify({ id, status: 'done', usage: { cost }, role_preset: { harness }, ...extra }));
  }
  // the planner fell back at spawn: the runtime reports it as a pi session, and its cost counts
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', planner_session_id: 'P1', worktree_path: state, harness: 'pi' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), '');
  setAgentRunner({ deliver: async () => {}, sessionCost: async () => 0.5 });
  const c = await laneCost('IDD-001', lane());
  assert.equal(Math.round(c.total * 100) / 100, 0.9);
  assert.deepEqual(c.parts.map((p) => p.label), ['planner', 'F1']);
  assert.deepEqual(c.subscription.map((p) => p.label), ['C1']);
  setAgentRunner(null);
});

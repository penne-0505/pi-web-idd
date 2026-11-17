import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runPrep } from '../src/plan/prep.ts';
import { runExec } from '../src/plan/exec.ts';
import { runPlanReview } from '../src/plan/plan-review.ts';
import { runReviewLoop } from '../src/plan/review-loop.ts';
import { runSubmitPrep } from '../src/plan/submit-prep.ts';
import { slotWaits } from '../src/plan/slot-wait.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { moveInStartOrder, setUrgent } from '../src/ledger/start-order.ts';
import { scratchDir } from './helpers/scratch.mjs';
import { tmpDir } from './helpers/tmp.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const NOW = Date.parse('2026-09-25T12:00:00+09:00');

/**
 * A project the engine can cut lane worktrees in, with the lanes' events and sessions on record. The intake times
 * follow the order the ids are given in, so a test can say which lane the order starts with.
 */
function areaSetup(pipeline, lanes, { planners = [], executors = [] } = {}) {
  const root = scratchDir('start-order-stage-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main');
  put(join(work, 'app.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n');
  put(join(work, 'AGENTS.override.md'), 'rules');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'overlay');
  put(join(root, 'repos.yaml'), JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipeline}`);
  Object.assign(process.env, { IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'unused') });
  const ids = Object.keys(lanes);
  put(join(state, 'backlog.jsonl'), ids.map((id, i) => JSON.stringify({
    idd_id: id, parent_id: null, created_at: `2026-09-25T0${i}:00:00+09:00`, linear_issue_url: null,
    gh_issue_url: `https://github.com/t/p/issues/${i + 1}`, pull_req_url: null, source_type: 'github', context: '', title: id, area: 'demo',
  })).join('\n') + '\n');
  put(join(state, 'lifecycle-demo.jsonl'), ids.flatMap((id) => lanes[id].map(([event, t, attrs = {}]) => ({ event, idd_id: id, at: `2026-09-25T${t}:00+09:00`, attrs }))).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const paths = {};
  for (const id of ids) paths[id] = ensureLaneWorktree('demo', id).path;
  put(join(state, 'planner-sessions.jsonl'), planners.map((id) => JSON.stringify({ idd_id: id, planner_session_id: `P-${id}`, worktree_path: paths[id] })).join('\n') + (planners.length ? '\n' : ''));
  put(join(state, 'executor-sessions.jsonl'), executors.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: paths[id] })).join('\n') + (executors.length ? '\n' : ''));
  return { root, state, paths };
}

/** the decision record an executor's lane needs before it may start (its contract is not empty) */
const needsDecision = (paths, id) => put(join(paths[id], '_docs', 'intent', 'demo', id.toLowerCase(), 'decision.md'), '### DEC-1: x\n\n- **Anchors**: `app.txt`\n');

/** a state with one worktree shared by the lanes, for the stages that need a readable head but no repo */
function loopSetup(pipeline, ids, eventsFor) {
  const state = tmpDir('idd-start-order-loop-');
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  writeFileSync(process.env.IDD_ROLES_FILE, `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipeline}`);
  writeFileSync(process.env.IDD_REPOS_FILE, 'repos: {}\n');
  const wt = tmpDir('idd-start-order-loop-wt-');
  git(wt, 'init', '-q');
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'init');
  const head = git(wt, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'backlog.jsonl'), ids.map((id, i) => JSON.stringify({
    idd_id: id, parent_id: null, created_at: `2026-09-25T00:00:0${i}Z`, linear_issue_url: null, gh_issue_url: null,
    pull_req_url: null, source_type: 'github', context: '', title: id, area: 'demo',
  })).join('\n') + '\n');
  const events = ids.flatMap((id) => eventsFor(id, head).map(([event, t, attrs = {}]) => ({ event, idd_id: id, at: `2026-09-25T${t}:00+09:00`, attrs })));
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), ids.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
  return { state, wt, head };
}

const awaitingPrep = (id) => [['lane_open', '07:00']];
const awaitPrepAt = (hhmm) => [['lane_open', hhmm]];
const awaitExecAt = (hhmm) => [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', hhmm]];
const blindEvents = (id, head) => [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: head }], ['s2_result', '08:00']];
const s3Events = (id, head) => [...blindEvents(id, head), ['s2_review_converged', '08:10'], ['s2_device_skipped', '08:11'], ['s3_ready', '08:12']];

test('AC-006: the planner starts the lane at the head of the start order', async () => {
  const pipeline = '  planner: { role: r, concurrency: 1 }\n';
  const lanes = { 'IDD-001': awaitingPrep(), 'IDD-002': awaitPrepAt('07:10'), 'IDD-003': awaitPrepAt('07:20') };
  const spawned = [];
  setAgentRunner({ spawn: async (o) => { spawned.push(o.laneId); return { sessionId: `S-${o.laneId}` }; }, deliver: async () => {} });
  areaSetup(pipeline, lanes);
  await runPrep();
  assert.deepEqual(spawned, ['IDD-001'], 'the oldest intake time, since nothing is placed');

  areaSetup(pipeline, lanes);
  await moveInStartOrder({ idd_id: 'IDD-003', position: 1 });
  spawned.length = 0;
  await runPrep();
  assert.deepEqual(spawned, ['IDD-003'], 'the order decides, not the intake time');
  setAgentRunner(null);
});

test('AC-007: the executor starts the lane at the head of the start order', async () => {
  const pipeline = '  executor: { role: r, concurrency: 1 }\n';
  const lanes = { 'IDD-001': awaitExecAt('07:20'), 'IDD-002': awaitExecAt('07:30'), 'IDD-003': awaitExecAt('07:40') };
  const spawned = [];
  setAgentRunner({ spawn: async (o) => { spawned.push(o.laneId); return { sessionId: `S-${o.laneId}` }; }, deliver: async () => {} });

  const first = areaSetup(pipeline, lanes, { planners: Object.keys(lanes) });
  for (const id of Object.keys(lanes)) needsDecision(first.paths, id);
  await runExec();
  assert.deepEqual(spawned, ['IDD-001']);

  const second = areaSetup(pipeline, lanes, { planners: Object.keys(lanes) });
  for (const id of Object.keys(lanes)) needsDecision(second.paths, id);
  await moveInStartOrder({ idd_id: 'IDD-003', position: 1 });
  spawned.length = 0;
  await runExec();
  assert.deepEqual(spawned, ['IDD-003']);
  setAgentRunner(null);
});

test('AC-008: the plan review starts the lane at the head of the start order', async () => {
  const pipeline = '  plan_review: { role: r, concurrency: 1 }\n';
  const lanes = { 'IDD-001': [['lane_open', '07:00'], ['s1_ready', '07:10']], 'IDD-002': [['lane_open', '07:20'], ['s1_ready', '07:30']] };
  const started = [];
  setAgentRunner({ deliver: async () => {}, startPlanReview: async (o) => { started.push(o.iddId); return { runs: [{ runId: `R-${o.iddId}` }] }; } });

  areaSetup(pipeline, lanes, { planners: Object.keys(lanes) });
  await runPlanReview();
  assert.deepEqual(started, ['IDD-001']);

  areaSetup(pipeline, lanes, { planners: Object.keys(lanes) });
  await moveInStartOrder({ idd_id: 'IDD-002', position: 1 });
  started.length = 0;
  await runPlanReview();
  assert.deepEqual(started, ['IDD-002']);
  setAgentRunner(null);
});

test('AC-008: the review loop starts the blind for the lane at the head of the start order', async () => {
  const pipeline = '  review_blind: { roles: [r], concurrency: 1 }\n  triage: { role: r }\n  confirm: { role: r }\n';
  const started = [];
  setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { started.push(o.iddId); return { runIds: [`R-${o.iddId}`] }; }, reviewRunStatus: () => ({ state: 'running' }) });

  loopSetup(pipeline, ['IDD-001', 'IDD-002'], blindEvents);
  await runReviewLoop();
  assert.deepEqual(started, ['IDD-001']);

  loopSetup(pipeline, ['IDD-001', 'IDD-002'], blindEvents);
  await moveInStartOrder({ idd_id: 'IDD-002', position: 1 });
  started.length = 0;
  await runReviewLoop();
  assert.deepEqual(started, ['IDD-002']);
  setAgentRunner(null);
});

test('AC-008: the submit prep passes S3 for the lanes in the start order', async () => {
  const pipeline = '  executor: { role: r }\n';
  setAgentRunner({ deliver: async () => {} });
  const passed = () => readLifecycle().filter((e) => e.event === 's3_ok').map((e) => e.idd_id);

  loopSetup(pipeline, ['IDD-001', 'IDD-002'], s3Events);
  await runSubmitPrep();
  assert.deepEqual(passed(), ['IDD-001', 'IDD-002']);

  loopSetup(pipeline, ['IDD-001', 'IDD-002'], s3Events);
  await moveInStartOrder({ idd_id: 'IDD-002', position: 1 });
  await runSubmitPrep();
  assert.deepEqual(passed(), ['IDD-002', 'IDD-001']);
  setAgentRunner(null);
});

test('AC-009: an urgent lane does not start past the cap, and no running lane is stopped', async () => {
  const pipeline = '  planner: { role: r, concurrency: 1 }\n';
  const lanes = { 'IDD-001': awaitingPrep(), 'IDD-002': awaitPrepAt('07:10') };
  areaSetup(pipeline, lanes, { planners: ['IDD-001'] });
  const urgent = await setUrgent({ idd_id: 'IDD-002', urgent: true });
  assert.equal(urgent.ok, true);
  const spawned = [];
  let stopped = 0;
  setAgentRunner({
    spawn: async (o) => { spawned.push(o.laneId); return { sessionId: `S-${o.laneId}` }; },
    deliver: async () => {},
    discard: async () => { stopped += 1; },
    stop: async () => { stopped += 1; },
  });
  const r = await runPrep();
  assert.deepEqual(spawned, [], 'the cap is full; the urgent mark does not make a slot');
  assert.equal(stopped, 0, 'the lane that holds the slot is not stopped');
  assert.ok(r.skipped.some((s) => s.iddId === 'IDD-002'));
  setAgentRunner(null);
});

test('AC-011: the cap-wait list is in the order the stage would start them', async () => {
  const pipeline = '  planner: { role: r, concurrency: 1 }\n';
  const lanes = { 'IDD-001': awaitingPrep(), 'IDD-002': awaitPrepAt('07:10'), 'IDD-003': awaitPrepAt('07:20') };
  const { state } = areaSetup(pipeline, lanes, { planners: ['IDD-001'] });
  const waitIds = () => slotWaits({ now: NOW }).find((w) => w.slot === 'planner').lanes.map((l) => l.id);
  assert.deepEqual(waitIds(), ['IDD-002', 'IDD-003']);

  await moveInStartOrder({ idd_id: 'IDD-003', position: 1 });
  assert.deepEqual(waitIds(), ['IDD-003', 'IDD-002'], 'the wait list follows the moved order');

  // the head of the wait list is the lane the next tick starts once the slot is free
  writeFileSync(join(state, 'planner-sessions.jsonl'), '');
  const spawned = [];
  setAgentRunner({ spawn: async (o) => { spawned.push(o.laneId); return { sessionId: `S-${o.laneId}` }; }, deliver: async () => {} });
  await runPrep();
  assert.deepEqual(spawned, ['IDD-003']);
  setAgentRunner(null);
});

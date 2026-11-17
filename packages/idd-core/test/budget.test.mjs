import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { clearCostCache, laneCost, laneRunIds, parseLaneBudget, runBudget } from '../src/plan/budget.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { deriveStage, laneHeld, laneOverBudget } from '../src/ledger/derive.ts';
import { lanesAwaitingMerge } from '../src/plan/close.ts';
import { runReviewLoop } from '../src/plan/review-loop.ts';
import { applyDecision } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';

function setup(planner = 2.0) {
  const root = scratchDir('budget-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  writeFileSync(join(root, 'roles.yaml'), 'defaults:\n  lane_budget_usd: 3\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 't', context: '' }) + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'P1', worktree_path: root }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: root }) + '\n');
  for (const [id, cost] of [['R1', 0.5], ['R2', 0.25]]) {
    mkdirSync(join(state, 'lanes', id), { recursive: true });
    writeFileSync(join(state, 'lanes', id, 'lane.json'), JSON.stringify({ id, status: 'done', usage: { cost } }));
  }
  const at = new Date(Date.now() - 60_000).toISOString();
  const events = [['lane_open', {}], ['s1_ready', {}], ['s1_plan_review_started', { run_id: 'R1' }], ['s1_go', {}], ['s2_start', {}], ['s2_review_started', { run_ids: ['R2'] }]];
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map(([event, attrs]) => JSON.stringify({ idd_id: 'IDD-1', event, at, attrs })).join('\n') + '\n');
  setAgentRunner({ deliver: async () => {}, sessionCost: async (id) => (id === 'P1' ? planner : 0.1) });
}

const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1');

test('the budget comes from roles.yaml defaults, and is $5 when unset', () => {
  assert.equal(parseLaneBudget('defaults:\n  lane_budget_usd: 3\n'), 3);
  assert.equal(parseLaneBudget('defaults:\n  thinking: high\n'), 5);
  assert.equal(parseLaneBudget(''), 5);
});

test("a lane's cost is its runs recorded in the lifecycle and its planner / executor sessions", async () => {
  setup();
  const c = await laneCost('IDD-1', lane());
  assert.equal(Math.round(c.total * 100) / 100, 2.85);
  assert.deepEqual(c.parts.map((p) => p.label), ['planner', 'executor', 'R1', 'R2']);
});

test('a lane over its budget stops for penne, and adding to the budget lets it go on', async () => {
  setup(2.5);
  const r = await runBudget();
  assert.deepEqual(r.stopped, ['IDD-1']);
  assert.deepEqual([deriveStage(lane()).group, deriveStage(lane()).decision], ['judge', 'stuck']);
  assert.match(deriveStage(lane()).blockedBy, /予算/);
  assert.equal((await runBudget()).stopped.length, 0, 'recorded once');
  assert.equal((await applyDecision('lane_budget_extend', { iddId: 'IDD-1' })).ok, true);
  assert.equal(deriveStage(lane()).group, 'impl');
  assert.equal((await runBudget()).stopped.length, 0, 'the same cost is within the raised budget');
});

test('a lane within its budget is left alone', async () => {
  setup(1.0);
  assert.equal((await runBudget()).stopped.length, 0);
  assert.equal(deriveStage(lane()).group, 'impl');
});

test('a lane stopped for its budget gets no new review runs until penne adds to the budget', async () => {
  setup(2.5);
  const { execFileSync } = await import('node:child_process');
  const { runReviewLoop } = await import('../src/plan/review-loop.ts');
  const state = process.env.IDD_STATE_DIR;
  const wt = join(state, '..', 'wt'); mkdirSync(wt);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd: wt, encoding: 'utf8' }).trim();
  git('init', '-q'); writeFileSync(join(wt, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(wt, 'a.txt'), 'b\n'); git('commit', '-qam', 'change');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  const at = new Date(Date.now() - 60_000).toISOString();
  const events = [['lane_open', {}], ['s1_ready', {}], ['s1_plan_review_started', { run_id: 'R1' }], ['s1_go', {}], ['s2_start', { started_from_commit: base }], ['s2_result', { outcome: 'success' }]];
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map(([event, attrs]) => JSON.stringify({ idd_id: 'IDD-1', event, at, attrs })).join('\n') + '\n');
  writeFileSync(process.env.IDD_ROLES_FILE, 'defaults:\n  lane_budget_usd: 3\npipeline:\n  review_blind: { role: blind }\n');
  const started = [];
  setAgentRunner({ deliver: async () => {}, sessionCost: async (id) => (id === 'P1' ? 2.5 : 0.1), startReviewRun: async (o) => { started.push(o.stage); return { runIds: ['X'] }; }, reviewRunStatus: () => ({ state: 'running' }) });
  assert.deepEqual((await runBudget()).stopped, ['IDD-1']);
  await runReviewLoop();
  assert.deepEqual(started, [], 'the loop does not spend on a lane over its budget');
  await applyDecision('lane_budget_extend', { iddId: 'IDD-1' });
  await runReviewLoop();
  assert.deepEqual(started, ['blind']);
});

/** the planner session and the plan review run on Claude Code (subscription); the executor and the blind on pi */
function claudeSetup(planner) {
  setup(planner);
  const state = process.env.IDD_STATE_DIR;
  const root = join(state, '..');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'P1', worktree_path: root, harness: 'claude' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: root, harness: 'pi' }) + '\n');
  writeFileSync(join(state, 'lanes', 'R1', 'lane.json'), JSON.stringify({ id: 'R1', status: 'done', usage: { cost: 0.5 }, role_preset: { harness: 'claude' } }));
  writeFileSync(join(state, 'lanes', 'R2', 'lane.json'), JSON.stringify({ id: 'R2', status: 'done', usage: { cost: 0.25 }, role_preset: { harness: 'pi' } }));
}

test("Claude Code's spend (subscription, API equivalent) is kept out of the total and listed on its own", async () => {
  claudeSetup(2.0);
  const c = await laneCost('IDD-1', lane());
  assert.equal(Math.round(c.total * 100) / 100, 0.35, 'executor 0.1 + R2 0.25');
  assert.deepEqual(c.parts.map((p) => p.label), ['executor', 'R2']);
  assert.deepEqual(c.subscription, [{ label: 'planner', cost: 2.0 }, { label: 'R1', cost: 0.5 }]);
});

test('a lane whose spend passes its budget only through Claude Code is not stopped', async () => {
  claudeSetup(3.5);
  assert.equal((await runBudget()).stopped.length, 0);
  assert.equal(deriveStage(lane()).group, 'impl');
});

test('a lane over its budget on API spend records the Claude Code spend apart, for the card to show', async () => {
  claudeSetup(2.0);
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lanes', 'R2', 'lane.json'), JSON.stringify({ id: 'R2', status: 'done', usage: { cost: 3.25 }, role_preset: { harness: 'pi' } }));
  assert.deepEqual((await runBudget()).stopped, ['IDD-1']);
  const over = lane().find((e) => e.event === 'lane_over_budget');
  assert.equal(over.attrs.cost, 3.35);
  assert.deepEqual(over.attrs.parts.map((p) => p.label), ['executor', 'R2']);
  assert.deepEqual(over.attrs.subscription_parts, [{ label: 'planner', cost: 2 }, { label: 'R1', cost: 0.5 }]);
});

test('a run that changed harness mid-way is split by attempt: the API attempt is budget, the Claude one is not', async () => {
  claudeSetup(2.0);
  const at = new Date().toISOString();
  // R1: a Claude attempt that failed, then an API attempt that finished — either order reads the same
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lanes', 'R1', 'lane.json'), JSON.stringify({
    id: 'R1', status: 'done', role_preset: { harness: 'pi' }, usage: { cost: 0.5 },
    attempts: [
      { role: 'deep', harness: 'claude', status: 'failed', failure: 'provider', usage: { cost: 0.4 }, started_at: at },
      { role: 'api', harness: 'pi', status: 'done', usage: { cost: 0.1 }, started_at: at },
    ],
  }));
  const c = await laneCost('IDD-1', lane());
  assert.equal(Math.round(c.total * 100) / 100, 0.45, 'executor 0.1 + R1 API attempt 0.1 + R2 0.25');
  assert.deepEqual(c.parts.map((p) => p.label), ['executor', 'R1 #2', 'R2']);
  assert.deepEqual(c.subscription, [{ label: 'planner', cost: 2.0 }, { label: 'R1 #1', cost: 0.4 }]);
  clearCostCache();

  // a failed API attempt is still real spend, and the order of the attempts does not change the split
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lanes', 'R1', 'lane.json'), JSON.stringify({
    id: 'R1', status: 'failed', role_preset: { harness: 'claude' }, usage: { cost: 0.5 },
    attempts: [
      { role: 'api', harness: 'pi', status: 'failed', failure: 'provider', usage: { cost: 0.2 }, started_at: at },
      { role: 'api2', harness: 'pi', status: 'failed', failure: 'timeout', usage: { cost: 0.3 }, started_at: at },
    ],
  }));
  const c2 = await laneCost('IDD-1', lane());
  assert.equal(Math.round(c2.total * 100) / 100, 0.85, 'executor 0.1 + both failed API attempts 0.5 + R2 0.25');
  assert.deepEqual(c2.parts.map((p) => p.label), ['executor', 'R1 #1', 'R1 #2', 'R2']);
});

test('a run with no attempt list reads by its one harness as it always did', async () => {
  claudeSetup(2.0);
  clearCostCache();
  const c = await laneCost('IDD-1', lane());
  assert.deepEqual(c.parts.map((p) => p.label), ['executor', 'R2']);
  assert.deepEqual(c.subscription, [{ label: 'planner', cost: 2.0 }, { label: 'R1', cost: 0.5 }]);
});

const PR = 'https://github.com/o/r/pull/7';

/** a loop lane that went through the review loop and pushed its PR; its spend ($4) is over its budget ($3) */
function shippedSetup(extra = []) {
  const root = scratchDir('budget-pr-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  writeFileSync(join(root, 'roles.yaml'), 'defaults:\n  lane_budget_usd: 3\nmodels:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 't', context: '' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: root }) + '\n');
  const events = [
    ['lane_open', {}], ['s1_ready', {}], ['s1_go', {}], ['s2_start', { started_from_commit: 'base' }], ['s2_result', { outcome: 'success' }],
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'] }], ['s2_review_findings', { kind: 'blind', round: 1, files: [] }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 'T0' }], ['s2_triage_done', { kind: 'blind', round: 1, accepted: [], rejected: [] }],
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['B2'] }], ['s2_review_findings', { kind: 'final', round: 1, files: [] }],
    ['s2_triage_started', { kind: 'final', round: 1, run_id: 'T1' }], ['s2_triage_done', { kind: 'final', round: 1, accepted: [], rejected: [] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}], ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }],
    ['s4_submit_started', {}], ['s4_pr_created', { pr_url: PR, pr_number: 7, commit: 'aaaaaaa1111' }],
    ...extra,
  ];
  const at = (i) => new Date(Date.now() - (60 - i) * 60_000).toISOString();
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map(([event, attrs], i) => JSON.stringify({ idd_id: 'IDD-1', event, at: at(i), attrs })).join('\n') + '\n');
  const started = [];
  setAgentRunner({ deliver: async () => {}, sessionCost: async () => 4.0, startReviewRun: async (o) => { started.push(o.stage); return { runIds: ['X'] }; }, reviewRunStatus: () => ({ state: 'running' }) });
  return { started };
}

const feedback = ['s4_review_comment_received', { repo: 'o/r', pr: 7, head: 'bbbb2222', files: [], items: [{ ref: 'C-1', id: 'C1', kind: 'thread', author: 'rev', url: `${PR}#C1`, quote: 'ここが壊れる' }] }];

test('a lane waiting on its PR spends nothing, so its budget does not stop it', async () => {
  shippedSetup();
  assert.equal((await runBudget()).stopped.length, 0);
  assert.deepEqual([deriveStage(lane()).group, deriveStage(lane()).blockedBy], ['waiting', 'PR #7']);
  assert.equal(laneHeld(lane()), false);
});

test('a merged lane waiting for the import is not stopped by its budget, and is still one the close picks up', async () => {
  shippedSetup([['s4_merged', { merged_at: 'x' }]]);
  assert.equal((await runBudget()).stopped.length, 0);
  assert.equal(deriveStage(lane()).group, 'waiting');
  assert.equal(laneHeld(lane()), false);
  assert.deepEqual(lanesAwaitingMerge().map((l) => l.rec.idd_id), ['IDD-1']);
});

test('a budget stop recorded while the lane only waited on its PR does not hold it', async () => {
  shippedSetup([['lane_over_budget', { cost: 4, limit: 3, parts: [] }]]);
  assert.equal(laneOverBudget(lane()), null);
  assert.equal(laneHeld(lane()), false);
  assert.equal(deriveStage(lane()).group, 'waiting');
  assert.deepEqual(lanesAwaitingMerge().map((l) => l.rec.idd_id), ['IDD-1']);
});

test("once the PR's feedback is being answered, the budget stops the lane as before", async () => {
  const { started } = shippedSetup([feedback]);
  assert.deepEqual((await runBudget()).stopped, ['IDD-1']);
  assert.deepEqual([deriveStage(lane()).group, deriveStage(lane()).decision], ['judge', 'stuck']);
  assert.match(deriveStage(lane()).blockedBy, /予算/);
  await runReviewLoop();
  assert.deepEqual(started, [], 'no triage of the feedback starts on a lane over its budget');
});

test('a stale stop from the PR wait gives way to a fresh one when the feedback work begins', async () => {
  shippedSetup([['lane_over_budget', { cost: 1, limit: 3, parts: [] }], feedback]);
  assert.equal(laneOverBudget(lane()), null, 'the stop recorded while waiting is not honored');
  assert.deepEqual((await runBudget()).stopped, ['IDD-1']);
  assert.deepEqual(laneOverBudget(lane()), { cost: 4, limit: 3 });
});

test('a lane stopped for its budget while answering feedback is released once its PR is merged', async () => {
  shippedSetup([feedback, ['lane_over_budget', { cost: 4, limit: 3, parts: [] }], ['s4_merged', { merged_at: 'x' }]]);
  assert.equal(laneHeld(lane()), false);
  assert.equal(deriveStage(lane()).group, 'waiting');
});

test('in one tick, feedback on the PR of a lane over its budget is taken in and the lane stops before its triage starts', async () => {
  shippedSetup();
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    sessionCost: async () => 4.0,
    fetchPrFeedback: () => ({ author: 'penne', head: 'bbbb2222', items: [{ id: 'C1', kind: 'thread', author: 'rev', body: 'ここが壊れる', url: `${PR}#C1`, created_at: '', thread_id: 'T1', path: 'a.ts', line: 3 }] }),
    outboundStatus: () => ({ status: 'posted' }),
    startReviewRun: async (o) => { started.push(o.stage); return { runIds: ['X'] }; },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  const { runTick } = await import('../src/plan/tick.ts');
  const r = await runTick({ intake: false });
  assert.deepEqual(r.prFeedback.recorded, [{ iddId: 'IDD-1', items: 1 }]);
  assert.deepEqual(r.budget.stopped, ['IDD-1']);
  assert.deepEqual(started, [], 'the triage of the feedback waits for penne to add to the budget');
  setAgentRunner(null);
});

test('laneRunIds collects the plan run of a delivery like every ad-hoc run (AC-013)', () => {
  const events = [
    { event: 's2_review_started', attrs: { run_ids: ['R-1'] } },
    { event: 'fix_plan_started', attrs: { envelope_id: 'E-1', run_id: 'P-1' } },
  ];
  assert.deepEqual(laneRunIds(events).sort(), ['P-1', 'R-1']);
});

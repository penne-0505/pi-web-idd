import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { slotWaits } from '../src/plan/slot-wait.ts';
import { runPlanReview } from '../src/plan/plan-review.ts';
import { runReviewLoop } from '../src/plan/review-loop.ts';
import { runTick } from '../src/plan/tick.ts';
import { recordCronRunSlotWaits } from '../src/intake/run.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { runReviewLanes } from '../src/review-lane/run.ts';
import { maxRoutesOf, specRunPlans, stageRunPlans } from '../../idd-lane/src/review-runs.ts';
import { parseRoles } from '../../idd-lane/src/roles.ts';

/** every directory a test made, removed once the file's tests are done */
const made = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-09-25T12:00:00+09:00');
const at = (hhmm) => `2026-09-25T${hhmm}:00+09:00`;

/** a state with lanes IDD-1.. whose lifecycles are given as [event, time, attrs?] */
function setup(pipeline, lanes, { planners = [], executors = [], riskPaths } = {}) {
  const state = tempDir('idd-slot-wait-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipeline}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  // no repo: the tick's other stages find nothing to do (a declaration only when the test gives one)
  writeFileSync(join(state, 'repos.yaml'), riskPaths
    ? JSON.stringify({ repos: { Demo: { github: 'o/r', upstream: '/tmp/u', work: '/tmp/w', risk_paths: riskPaths } } })
    : 'repos: {}\n');
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const ids = Object.keys(lanes);
  writeFileSync(join(state, 'backlog.jsonl'), ids.map((id, i) => JSON.stringify({
    idd_id: id, parent_id: null, created_at: `2026-09-25T0${i}:00:00+09:00`, linear_issue_url: null,
    gh_issue_url: `https://github.com/o/r/issues/${i + 1}`, pull_req_url: null, source_type: 'github', context: '', title: id, area: 'Demo',
  })).join('\n') + '\n');
  const events = ids.flatMap((id) => lanes[id].map(([event, t, attrs = {}]) => ({ event, idd_id: id, at: at(t), attrs })));
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), planners.map((id) => JSON.stringify({ idd_id: id, planner_session_id: `P-${id}`, worktree_path: '/x' })).join('\n') + (planners.length ? '\n' : ''));
  writeFileSync(join(state, 'executor-sessions.jsonl'), executors.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: '/x' })).join('\n') + (executors.length ? '\n' : ''));
  return state;
}

const slot = (name) => slotWaits({ now: NOW }).find((w) => w.slot === name);
const waiting = (name) => slot(name)?.lanes.map((l) => l.id);

test('the planner: lanes beyond the free slots wait, oldest first, from the time they were taken in', () => {
  setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '09:00']],
    'IDD-2': [['lane_open', '10:00']],
    'IDD-3': [['lane_open', '11:30']],
  }, { planners: ['IDD-1'] });
  const s = slot('planner');
  assert.equal(s.cap, 1);
  assert.equal(s.running, 1);
  assert.deepEqual(s.lanes, [
    { id: 'IDD-2', since: at('10:00'), waitedMinutes: 120 },
    { id: 'IDD-3', since: at('11:30'), waitedMinutes: 30 },
  ]);
});

test('a free slot is not a wait: only the lanes the tick would leave over are counted', () => {
  setup('  planner: { role: r, concurrency: 2 }\n', {
    'IDD-1': [['lane_open', '09:00']],
    'IDD-2': [['lane_open', '10:00']],
    'IDD-3': [['lane_open', '11:00']],
  });
  assert.deepEqual(waiting('planner'), ['IDD-3']);
  setup('  planner: { role: r, concurrency: 3 }\n', { 'IDD-1': [['lane_open', '09:00']] });
  assert.deepEqual(waiting('planner'), []);
});

test('a lane waiting on something else than the cap is not counted: Claude windows, a question, its budget, a requeue', () => {
  setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '09:00']],
    'IDD-2': [['lane_open', '09:10'], ['claude_quota_wait', '09:20', { stage: 'planner', reason: 'five_hour' }]],
    'IDD-3': [['lane_open', '09:20'], ['question_batch_asked', '09:30']],
    'IDD-4': [['lane_open', '09:30', { requeued_from: 'IDD-0' }]],
    'IDD-5': [['lane_open', '09:40']],
  }, { planners: ['IDD-1'] });
  assert.deepEqual(waiting('planner'), ['IDD-5']);
});

test('a requeued lane waits from the go of its requeue, not from its intake', () => {
  setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '09:00']],
    'IDD-2': [['lane_open', '09:00', { requeued_from: 'IDD-0' }], ['s0_requeue_go', '11:00']],
  }, { planners: ['IDD-1'] });
  assert.deepEqual(slot('planner').lanes, [{ id: 'IDD-2', since: at('11:00'), waitedMinutes: 60 }]);
});

test('the executor: lanes past GO wait from their GO; a lane blocked by a dependency or held for its budget does not', () => {
  setup('  executor: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '08:00'], ['s1_ready', '08:30'], ['s1_go', '09:00'], ['s2_start', '09:01']],
    'IDD-2': [['lane_open', '08:00'], ['s1_ready', '08:30'], ['s1_go', '10:00']],
    'IDD-3': [['lane_open', '08:00'], ['s1_ready', '08:30'], ['s1_go', '10:00'], ['blocked_by_dependency', '10:05', { depends_on: ['IDD-2'] }]],
    'IDD-4': [['lane_open', '08:00'], ['s1_ready', '08:30'], ['s1_go', '10:00'], ['lane_over_budget', '10:10', { cost: 6, limit: 5 }]],
  }, { planners: ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4'], executors: ['IDD-1'] });
  const s = slot('executor');
  assert.equal(s.running, 1);
  assert.deepEqual(s.lanes, [{ id: 'IDD-2', since: at('10:00'), waitedMinutes: 120 }]);
});

test('the plan review: a ready plan waits from its ready while the reviews in flight fill the cap', () => {
  setup('  plan_review: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '08:00'], ['s1_ready', '09:00'], ['s1_plan_review_started', '09:01', { run_ids: ['a'] }]],
    'IDD-2': [['lane_open', '08:00'], ['s1_ready', '11:15']],
    'IDD-3': [['lane_open', '08:00'], ['s1_ready', '11:20'], ['claude_quota_wait', '11:21', { stage: 'plan_review', reason: 'x' }]],
  }, { planners: ['IDD-1', 'IDD-2', 'IDD-3'] });
  const s = slot('plan_review');
  assert.equal(s.running, 1);
  assert.deepEqual(s.lanes, [{ id: 'IDD-2', since: at('11:15'), waitedMinutes: 45 }]);
});

test('an undeclared stage is not reported', () => {
  setup('  planner: { role: r }\n', { 'IDD-1': [['lane_open', '09:00']] });
  assert.deepEqual(slotWaits({ now: NOW }).map((w) => w.slot), ['planner', 'executor']);
});

const loopHead = [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: 'abc' }]];

test('the review loop: blind, triage and confirm each count their own cap, from the event that made the lane ready', () => {
  setup('  review_blind: { roles: [r, r], concurrency: 1 }\n  triage: { role: r, concurrency: 1 }\n  confirm: { role: r, concurrency: 1 }\n', {
    'IDD-1': [...loopHead, ['s2_result', '08:00'], ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['a', 'b'] }]],
    'IDD-2': [...loopHead, ['s2_result', '11:00']],
    'IDD-3': [...loopHead, ['s2_result', '08:00'], ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['c', 'd'] }], ['s2_review_findings', '09:00', { kind: 'blind', round: 1, files: ['/f'] }], ['s2_triage_started', '09:05', { kind: 'blind', round: 1, run_id: 't' }]],
    'IDD-4': [...loopHead, ['s2_result', '08:00'], ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['e', 'f'] }], ['s2_review_findings', '11:40', { kind: 'blind', round: 1, files: ['/g'] }]],
    'IDD-5': [...loopHead, ['s2_result', '08:00'], ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['g', 'h'] }], ['s2_review_findings', '11:40', { kind: 'blind', round: 1, files: ['/g'] }], ['lane_over_budget', '11:45', { cost: 6, limit: 5 }]],
  }, { executors: ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4', 'IDD-5'] });
  const blind = slot('review_blind');
  // IDD-1 still holds its copies; IDD-3/4/5 have moved on past theirs in the record
  assert.equal(blind.running, 1);
  assert.deepEqual(blind.lanes, [{ id: 'IDD-2', since: at('11:00'), waitedMinutes: 60 }]);
  const triage = slot('triage');
  assert.equal(triage.running, 1);
  assert.deepEqual(triage.lanes, [{ id: 'IDD-4', since: at('11:40'), waitedMinutes: 20 }], 'the lane held for its budget is not counted');
  assert.deepEqual(waiting('confirm'), []);
});

test('a lane a slot has just freed for is next, not waiting, so the stall watch reads its queue time as the queue', () => {
  setup('  review_blind: { roles: [r, r], concurrency: 2 }\n  triage: { role: r, concurrency: 1 }\n', {
    'IDD-1': [...loopHead, ['s2_result', '08:00'], ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['a', 'b'] }]],
    'IDD-2': [...loopHead, ['s2_result', '10:00']],
    'IDD-3': [...loopHead, ['s2_result', '11:00']],
    'IDD-4': [...loopHead, ['s2_result', '08:00'], ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['e', 'f'] }], ['s2_review_findings', '11:40', { kind: 'blind', round: 1, files: ['/g'] }]],
    'IDD-5': [...loopHead, ['s2_result', '08:00'], ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['g', 'h'] }], ['s2_review_findings', '11:45', { kind: 'blind', round: 1, files: ['/g'] }]],
  }, { executors: ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4', 'IDD-5'] });
  const blind = slot('review_blind');
  // one round runs: the first lane in the order fits the free copies, the second waits for them
  assert.deepEqual(blind.next, ['IDD-2']);
  assert.deepEqual(blind.lanes.map((l) => l.id), ['IDD-3']);
  const triage = slot('triage');
  assert.deepEqual(triage.next, ['IDD-4']);
  assert.deepEqual(triage.lanes.map((l) => l.id), ['IDD-5']);
});

test('the counts agree with what the stage does: the lanes the plan review leaves for its cap are the ones counted', async () => {
  setup('  plan_review: { role: r, concurrency: 2 }\n', {
    'IDD-1': [['lane_open', '08:00'], ['s1_ready', '09:00']],
    'IDD-2': [['lane_open', '08:00'], ['s1_ready', '10:00']],
    'IDD-3': [['lane_open', '08:00'], ['s1_ready', '11:00']],
  }, { planners: ['IDD-1', 'IDD-2', 'IDD-3'] });
  // nothing runs yet: the stage has room for two, so only the third waits
  assert.deepEqual(waiting('plan_review'), ['IDD-3']);
  const started = [];
  setAgentRunner({ deliver: async () => {}, startPlanReview: async (o) => { started.push(o.iddId); return { runs: [{ runId: `R-${o.iddId}` }] }; } });
  const r = await runPlanReview();
  setAgentRunner(null);
  assert.deepEqual(r.started, ['IDD-1', 'IDD-2']);
  assert.deepEqual(started, ['IDD-1', 'IDD-2']);
  const s = slot('plan_review');
  assert.equal(s.running, 2);
  assert.deepEqual(s.lanes, [{ id: 'IDD-3', since: at('11:00'), waitedMinutes: 60 }]);
});

test('the counts agree with the review loop: the lane it leaves for the blind cap is the one counted', async () => {
  const wt = tempDir('idd-slot-wait-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const lane = (t) => [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: head }], ['s2_result', t]];
  const state = setup('  review_blind: { roles: [r, r], concurrency: 1 }\n', { 'IDD-1': lane('08:00'), 'IDD-2': lane('09:00') });
  writeFileSync(join(state, 'executor-sessions.jsonl'), ['IDD-1', 'IDD-2'].map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
  assert.deepEqual(waiting('review_blind'), ['IDD-2']);
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o.iddId); return { runIds: [`${o.iddId}-a`, `${o.iddId}-b`] }; },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  await runReviewLoop();
  setAgentRunner(null);
  assert.deepEqual(started, ['IDD-1']);
  const s = slot('review_blind');
  assert.equal(s.running, 1);
  assert.deepEqual(s.lanes, [{ id: 'IDD-2', since: at('09:00'), waitedMinutes: 180 }]);
});

test('R2 has no slot any more: a pipeline that still names r2 and a lane whose past R2 run never finished report no wait for it', () => {
  const done = [...loopHead, ['s2_result', '08:00'], ['s2_review_skipped', '08:01'], ['s2_device_skipped', '08:02']];
  setup('  r2: { role: r, concurrency: 1 }\n', {
    'IDD-1': [...done, ['s3_ready', '09:00'], ['s3_r2_started', '09:01', { run_id: 'r' }]],
    'IDD-2': [...done, ['s3_ready', '11:30']],
  }, { executors: ['IDD-1', 'IDD-2'] });
  assert.equal(slot('r2'), undefined);
});

function reviewLane(state, id, history, created = at('08:00')) {
  mkdirSync(join(state, 'reviews'), { recursive: true });
  writeFileSync(join(state, 'reviews', `${id}.json`), JSON.stringify({
    id, repo: 'o/r', pr: 1, title: 't', url: 'u', created_at: created,
    history: history.map(([event, t, attrs = {}]) => ({ event, at: at(t), attrs })),
  }));
}

test('the review lanes count the copies of the blind cap on their own; a lane waiting on the windows is not counted', () => {
  const state = setup('  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r, concurrency: 1 }\n', {});
  const wt = ['r_wt_ready', '08:10', { path: '/p', base: 'b', head: 'h' }];
  reviewLane(state, 'REV-1', [['r_opened', '08:00'], wt, ['r_map_done', '08:20', { routes: [] }], ['r_blind_started', '08:30', { round: 1, run_ids: ['a', 'b'] }]], at('08:00'));
  reviewLane(state, 'REV-2', [['r_opened', '09:00'], wt, ['r_map_started', '10:00', { round: 1, run_id: 'm' }], ['r_map_done', '10:30', { routes: [] }]], at('09:00'));
  reviewLane(state, 'REV-3', [['r_opened', '09:30'], wt, ['r_quota_wait', '10:40', { stage: 'map', reason: 'x' }]], at('09:30'));
  const lanes = slot('review_lane');
  assert.equal(lanes.running, 1);
  assert.deepEqual(lanes.lanes, [{ id: 'REV-2', since: at('10:30'), waitedMinutes: 90 }]);
  assert.deepEqual(waiting('review_lane_map'), []);
});

test('a lane whose map check throws is left out of the list, and the other lanes keep their waits', () => {
  const state = setup('  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r, concurrency: 1 }\n', {});
  const wtAt = (path) => ['r_wt_ready', '08:10', { path, base: 'b', head: 'h' }];
  reviewLane(state, 'REV-1', [['r_opened', '08:00'], wtAt('/ok'), ['r_map_done', '08:20', { routes: [] }], ['r_blind_started', '08:30', { round: 1, run_ids: ['a', 'b'] }]]);
  reviewLane(state, 'REV-2', [['r_opened', '09:00'], wtAt('/bad')], at('09:00'));
  reviewLane(state, 'REV-3', [['r_opened', '09:30'], wtAt('/ok')], at('09:30'));
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async () => ({ runIds: [] }),
    riskMapSkipReason: ({ worktree }) => { if (worktree === '/bad') throw new Error('roles.yaml が読めません'); return 'small'; },
  });
  try {
    const lanes = slot('review_lane');
    assert.deepEqual(lanes.lanes.map((l) => l.id), ['REV-3']);
    assert.deepEqual(lanes.next, []);
  } finally {
    setAgentRunner(null);
  }
});

test('the tick returns the waits, and the record of a run that took Issues in keeps them', async () => {
  const state = setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '09:00']],
    'IDD-2': [['lane_open', '10:00']],
  }, { planners: ['IDD-1'] });
  const r = await runTick({ intake: true });
  assert.deepEqual(r.slotWaits.find((w) => w.slot === 'planner').lanes.map((l) => l.id), ['IDD-2']);
  const runs = readdirSync(state).filter((f) => f.startsWith('cron-run-'));
  assert.equal(runs.length, 1);
  const rec = JSON.parse(readFileSync(join(state, runs[0]), 'utf8'));
  const planner = rec.slot_waits.find((w) => w.slot === 'planner');
  assert.equal(planner.cap, 1);
  assert.equal(planner.running, 1);
  assert.equal(planner.lanes[0].id, 'IDD-2');
  assert.equal(planner.lanes[0].since, at('10:00'));
  assert.equal(typeof planner.lanes[0].waited_min, 'number');
  // the intake's own fields stay as they were
  assert.equal(rec.intake_count, 0);
});

test('a tick without the intake writes no run record, and adding waits to a missing record does nothing', async () => {
  const state = setup('  planner: { role: r, concurrency: 1 }\n', { 'IDD-1': [['lane_open', '09:00']] });
  const r = await runTick({ intake: false });
  assert.ok(Array.isArray(r.slotWaits));
  assert.deepEqual(readdirSync(state).filter((f) => f.startsWith('cron-run-')), []);
  recordCronRunSlotWaits('2026-09-25T12:00:00+09:00', []);
  assert.deepEqual(readdirSync(state).filter((f) => f.startsWith('cron-run-')), []);
});

test('the record of the waits is written once per run and adds no lifecycle events', async () => {
  const state = setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '09:00']],
    'IDD-2': [['lane_open', '10:00']],
  }, { planners: ['IDD-1'] });
  const before = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8');
  slotWaits({ now: NOW });
  await runTick({ intake: false });
  await runTick({ intake: false });
  // the waits' record adds no row of its own. The stage that could not start the waiting lane puts its reason on the
  // lane (one row however many ticks run); that row is the start's, not the waits' record's
  const rows = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.event !== 'lane_start_skipped').map((r) => JSON.stringify(r)).join('\n') + '\n', before);
  assert.equal(rows.filter((r) => r.event === 'lane_start_skipped').length, 1, 'two ticks leave one reason');
});

test('a lane whose Claude windows have reset since its wait is back to waiting for the cap, from the later of its ready and the reset', () => {
  const past = Date.parse(at('11:00')) / 1000;
  const future = Date.parse(at('13:00')) / 1000;
  setup('  planner: { role: r, concurrency: 1 }\n  executor: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '08:00']],
    'IDD-2': [['lane_open', '09:00'], ['claude_quota_wait', '09:30', { stage: 'planner', reason: 'five_hour', resets_at: past }]],
    'IDD-3': [['lane_open', '09:10'], ['claude_quota_wait', '09:40', { stage: 'planner', reason: 'five_hour', resets_at: future }]],
    'IDD-4': [['lane_open', '09:20'], ['claude_quota_wait', '09:50', { stage: 'planner', reason: 'rejected' }]],
    'IDD-5': [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '11:30'], ['claude_quota_wait', '11:31', { stage: 'executor', reason: 'x', resets_at: past }]],
    'IDD-6': [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30']],
  }, { planners: ['IDD-1', 'IDD-5', 'IDD-6'], executors: ['IDD-6'] });
  // the reset is past: the windows no longer hold it, the cap does; a reset still ahead, or none known, is the windows' wait
  assert.deepEqual(slot('planner').lanes, [{ id: 'IDD-2', since: new Date(past * 1000).toISOString(), waitedMinutes: 60 }]);
  // a reset before the lane was ready does not move its start
  assert.deepEqual(slot('executor').lanes, [{ id: 'IDD-5', since: at('11:30'), waitedMinutes: 30 }]);
});

test('with a free slot, a lane whose windows have reset is expected to start, not left out of the count', () => {
  const past = Date.parse(at('11:00')) / 1000;
  setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '09:00'], ['claude_quota_wait', '09:30', { stage: 'planner', reason: 'x', resets_at: past }]],
    'IDD-2': [['lane_open', '10:00']],
  });
  assert.deepEqual(waiting('planner'), ['IDD-2']);
});

test('the first blind of a lane whose diff size is not known is counted as a blind start, not against the map cap', () => {
  setup('  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r, concurrency: 1 }\n', {
    'IDD-1': [...loopHead, ['s2_result', '08:00'], ['s2_map_started', '08:05', { kind: 'blind', round: 1, run_id: 'm' }]],
    'IDD-2': [...loopHead, ['s2_result', '09:00']],
    'IDD-3': [...loopHead, ['s2_result', '10:00']],
  }, { executors: ['IDD-1', 'IDD-2', 'IDD-3'] });
  // IDD-2 may have a small diff and start its blind at once; IDD-3 then waits for the blind's copies
  assert.deepEqual(waiting('risk_map'), []);
  assert.deepEqual(waiting('review_blind'), ['IDD-3']);
});

// ---- IDD-057: a conflict scope round holds one blind copy ----

/** a repo whose lane merged the mainline and resolved app.ts by hand; HEAD is the merge */
function conflictRepo({ main = {}, lane = {} } = {}) {
  const wt = tempDir('idd-slot-conflict-');
  execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
  const git = (...a) => execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { encoding: 'utf8' }).trim();
  const commit = (files) => {
    for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(wt, p)), { recursive: true }); writeFileSync(join(wt, p), t); }
    git('add', '-A'); git('commit', '-q', '-m', 'c'); return git('rev-parse', 'HEAD');
  };
  const init = commit({ 'app.ts': 'init\n' });
  const reviewed = commit({ 'app.ts': 'lane\n', ...lane });
  const records = commit({ '_docs/qa/Demo/x/qa.md': '# qa\n' });
  git('checkout', '-q', '-b', 'trunk', init);
  commit({ 'app.ts': 'trunk\n', ...main });
  git('checkout', '-q', 'lane');
  try { git('merge', '--no-edit', 'trunk'); } catch { /* resolved by hand below */ }
  const merge = commit({ 'app.ts': 'merged\n' });
  return { wt, init, reviewed, records, merge };
}

/** the events of a lane that converged, was sent back from the S3 check's conflict, and merged it in */
const conflictSentBack = (init, reviewed, records, at) => [
  ['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'],
  ['s2_start', '07:30', { started_from_commit: init }], ['s2_result', '08:00'],
  ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['a', 'b'], head: reviewed }],
  ['s2_review_findings', '08:06', { kind: 'blind', round: 1, files: ['/b'] }],
  ['s2_triage_done', '08:07', { kind: 'blind', round: 1, accepted: [] }],
  ['s2_review_converged', '08:10'], ['s2_device_skipped', '08:11'],
  ['s3_ready', '08:12'], ['s3_check_conflict', '08:12', { conflict_files: ['app.ts'] }],
  ['s4_submit_started', '08:13', { head: records }], ['s4_verify_user_judgment_answered', '08:14', { outcome: 'revise' }],
  ['s2_result', at],
];

test('a conflict scope blind holds one copy, not the whole slot', () => {
  const { wt, init, reviewed, records } = conflictRepo();
  const state = setup('  review_blind: { roles: [r, r], concurrency: 1 }\n  review_loop: { after_merge: conflict }\n  triage: { role: r }\n  confirm: { role: r }\n', {
    'IDD-1': conflictSentBack(init, reviewed, records, '09:00'),
    'IDD-2': conflictSentBack(init, reviewed, records, '09:10'),
  }, { executors: ['IDD-1', 'IDD-2'] });
  writeFileSync(join(state, 'executor-sessions.jsonl'), ['IDD-1', 'IDD-2'].map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
  // the cap is one lane's worth of two roles; two conflict rounds (one copy each) both fit, so no lane waits
  assert.deepEqual(waiting('review_blind'), []);
});

/** the six-kind table, every row saying the same thing */
const RISK_ROWS = (touches) => ['auth', 'authz', 'billing', 'permission', 'data_loss', 'secret'].map((kind) => ({ kind, touches, reason: 'x' }));

/** the lane's first ready given a six-kind table */
const withTable = (events, rows) => events.map(([e, t, a = {}]) => (e === 's1_ready' ? [e, t, { ...a, risk_table: rows }] : [e, t, a]));

test('a ready table that touches a kind makes a conflict scope blind hold the high-risk copy too', () => {
  const pipeline = '  review_blind: { roles: [r, r], high_risk_extra: [o], concurrency: 1 }\n  review_loop: { after_merge: conflict }\n  triage: { role: r }\n  confirm: { role: r }\n';
  const run = (rows) => {
    const { wt, init, reviewed, records } = conflictRepo();
    // a readable Medium qa: the table is then the only thing that can raise the lane
    mkdirSync(join(wt, '_docs/qa/Demo/idd-1'), { recursive: true });
    writeFileSync(join(wt, '_docs/qa/Demo/idd-1/qa.md'), '---\nqa_schema: 5\nrisk: Medium\n---\n');
    const state = setup(pipeline, {
      'IDD-1': withTable(conflictSentBack(init, reviewed, records, '09:00'), rows),
      'IDD-2': withTable(conflictSentBack(init, reviewed, records, '09:10'), rows),
    }, { executors: ['IDD-1', 'IDD-2'] });
    writeFileSync(join(state, 'executor-sessions.jsonl'), ['IDD-1', 'IDD-2'].map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
    return waiting('review_blind');
  };
  assert.deepEqual(run(RISK_ROWS(false)), [], 'two one-copy rounds both fit the cap of two');
  assert.deepEqual(run(RISK_ROWS(true)), ['IDD-2'], 'each round holds two copies, so only the first fits');
});

// ---- IDD-072: the conflict scope count reads the lane's own change against the repo's declaration ----

const RISKY_PIPE = '  review_blind: { roles: [r, r], high_risk_extra: [o], concurrency: 1 }\n  review_loop: { after_merge: conflict }\n  triage: { role: r }\n  confirm: { role: r }\n';

/** two conflict scope lanes on one worktree with `auth: [guard/]` declared; `main` and `lane` are the files each side changed */
function twoConflictLanes({ main = {}, lane = {} } = {}) {
  const { wt, init, reviewed, records } = conflictRepo({ main, lane });
  mkdirSync(join(wt, '_docs/qa/Demo/idd-1'), { recursive: true });
  writeFileSync(join(wt, '_docs/qa/Demo/idd-1/qa.md'), '---\nqa_schema: 5\nrisk: Medium\n---\n');
  const state = setup(RISKY_PIPE, {
    'IDD-1': conflictSentBack(init, reviewed, records, '09:00'),
    'IDD-2': conflictSentBack(init, reviewed, records, '09:10'),
  }, { executors: ['IDD-1', 'IDD-2'], riskPaths: { auth: ['guard/'] } });
  writeFileSync(join(state, 'executor-sessions.jsonl'), ['IDD-1', 'IDD-2'].map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
  return { state, wt };
}

test('a conflict scope blind holds the high-risk copy for the lane\'s own declared path, not for the mainline\'s', () => {
  // the lane's own change touched the declared path: each round holds two copies, so only the first fits the cap of two
  twoConflictLanes({ lane: { 'guard/lane.ts': 'lane\n' } });
  assert.deepEqual(waiting('review_blind'), ['IDD-2']);
  // only the mainline's commit touched it: one copy each, so both fit
  twoConflictLanes({ main: { 'guard/main.ts': 'main\n' } });
  assert.deepEqual(waiting('review_blind'), []);
});

test('the count the wait uses is the blind runs the round actually starts', async () => {
  for (const [name, files, runs] of [
    ['the lane touched the declared path', { lane: { 'guard/lane.ts': 'lane\n' } }, 2],
    ['only the mainline touched it', { main: { 'guard/main.ts': 'main\n' } }, 1],
  ]) {
    twoConflictLanes(files);
    const started = [];
    setAgentRunner({
      deliver: async () => {},
      startReviewRun: async (o) => {
        const n = o.stage === 'blind' || o.stage === 'final' ? 1 + (o.extras?.length ? 1 : 0) : 1;
        const runIds = Array.from({ length: n }, (_, i) => `${o.stage}-${started.length}-${i}`);
        started.push({ ...o, runIds });
        return { runIds };
      },
      reviewRunStatus: () => ({ state: 'running' }),
    });
    await runReviewLoop();
    setAgentRunner(null);
    const first = started.filter((c) => c.iddId === 'IDD-1' && c.stage === 'blind');
    assert.equal(first.length, 1, name);
    assert.equal(first[0].runIds.length, runs, name);
  }
});

test('a conflict scope round is let in by its own run, in the stage as in the wait list', async () => {
  // the slot is 3 copies wide with one lane at once: a usual round of the second lane would not fit beside the first's one run
  twoConflictLanes({ main: { 'guard/main.ts': 'main\n' } });
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      const runIds = [`${o.stage}-${started.length}`];
      started.push({ ...o, runIds });
      return { runIds };
    },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  assert.deepEqual(waiting('review_blind'), []);
  await runReviewLoop();
  setAgentRunner(null);
  assert.deepEqual(started.filter((c) => c.stage === 'blind').map((c) => c.iddId), ['IDD-1', 'IDD-2']);
});

test('a repos file that cannot be read does not make the slot wait throw', () => {
  const { state } = twoConflictLanes({ lane: { 'guard/lane.ts': 'lane\n' } });
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { Demo: { github: 'o/r', upstream: '/tmp/u', work: '/tmp/w', risk_paths: { nonsense: ['x'] } } } }));
  assert.doesNotThrow(() => slotWaits({ now: NOW }));
});

// ---- IDD-133: the cap wait list reads Claude's windows the way the stage's start does ----

const FUTURE = Date.parse('2030-01-01T00:00:00Z') / 1000;

/** the runner's reading of the windows: a block while they hold, null when they let a lane start */
const windows = (block) => ({ deliver: async () => {}, quotaBlock: () => block });

/** a lane waiting for Claude's windows: the reset is the one fact the record carries */
const quotaLane = (hour, resetsAt) => [['lane_open', hour], ['claude_quota_wait', hour, { stage: 'planner', reason: 'five_hour', ...(resetsAt === undefined ? {} : { resets_at: resetsAt }) }]];

test('the observation decides whether a lane waits for the windows or for the cap (AC-001)', () => {
  const hold = { reason: 'Claude の枠が止める閾値に達している', resetsAt: FUTURE };
  setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '08:00']],
    'IDD-2': quotaLane('09:00', FUTURE),
    'IDD-3': quotaLane('09:10'),
    'IDD-4': quotaLane('09:20', Date.parse('2026-09-25T11:00:00+09:00') / 1000),
  }, { planners: ['IDD-1'] });
  // the windows hold: a reset ahead, a reset nobody reported, and a reset already past all stay the windows' wait
  setAgentRunner(windows(hold));
  assert.deepEqual(waiting('planner'), []);
  // below the threshold (or no observation at all): the windows let them start, so the cap is what holds them
  setAgentRunner(windows(null));
  assert.deepEqual(waiting('planner'), ['IDD-2', 'IDD-3', 'IDD-4']);
  setAgentRunner(null);
});

test('a review lane waiting for the windows is read the same way (AC-001)', () => {
  const state = setup('  review_blind: { roles: [r], concurrency: 1 }\n  risk_map: { role: r }\n', {});
  const wt = ['r_wt_ready', '08:10', { path: '/p', base: 'b', head: 'h' }];
  reviewLane(state, 'REV-1', [['r_opened', '08:00'], wt], at('08:00'));
  reviewLane(state, 'REV-2', [['r_opened', '08:10'], wt, ['r_quota_wait', '08:20', { stage: 'blind', reason: 'x', resets_at: FUTURE }]], at('08:10'));
  setAgentRunner(windows({ reason: 'x', resetsAt: FUTURE }));
  assert.deepEqual(waiting('review_lane'), [], 'the windows hold REV-2');
  setAgentRunner(windows(null));
  assert.deepEqual(waiting('review_lane'), ['REV-2'], 'the windows let it start, so the blind cap holds it behind REV-1');
  setAgentRunner(null);
});

test('an unreadable observation leaves the record\'s own reset to decide, in the cap wait list too (AC-006)', () => {
  const past = Date.parse('2026-09-25T11:00:00+09:00') / 1000;
  setup('  planner: { role: r, concurrency: 1 }\n', {
    'IDD-1': [['lane_open', '08:00']],
    'IDD-2': quotaLane('09:00', FUTURE),
    'IDD-3': quotaLane('09:10'),
    'IDD-4': quotaLane('09:20', past),
  }, { planners: ['IDD-1'] });
  for (const runner of [
    { deliver: async () => {} },
    { deliver: async () => {}, quotaBlock: () => { throw new Error('観測を読めない'); } },
  ]) {
    setAgentRunner(runner);
    assert.deepEqual(waiting('planner'), ['IDD-4'], 'a reset ahead or none reported holds; a reset past does not');
    assert.doesNotThrow(() => slotWaits({ now: NOW }), 'a failed read never reaches the caller');
  }
  setAgentRunner(null);
  assert.deepEqual(waiting('planner'), ['IDD-4']);
});

// ---- IDD-231: the wait list counts a round the way the stage that starts it does ----

const COUNT_PIPELINE = '  review_blind: { role: r, models: [x-y, x-z], high_risk_extra: [o], concurrency: 2 }\n  spec_check: { role: r }\n  triage: { role: r }\n  confirm: { role: r }\n';
const COUNT_ROLES = (pipeline) => `models:\n  x-y:\n    model: x/y\n  x-z:\n    model: x/z\nroles:\n  r: { model: x-y, report: review }\n  o: { model: x-z, report: review }\npipeline:\n${pipeline}`;

/** a runner whose runs are the ones the real runner lists for the stage's options */
function countingRunner(started) {
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      const roles = parseRoles(readFileSync(process.env.IDD_ROLES_FILE, 'utf8'));
      const slot = roles.pipeline.review_blind;
      const blinds = o.stage === 'blind' || o.stage === 'final'
        ? stageRunPlans(o.stage, slot, { routes: o.routes ?? [], maxRoutes: maxRoutesOf(roles), leftovers: [], ...(o.extras?.length ? { extras: o.extras } : {}), ...(o.scope === 'conflict' ? { conflict: true } : {}), ...(typeof o.roleCount === 'number' ? { roleCount: o.roleCount } : {}), ...(o.onlyHighRisk ? { onlyHighRisk: true } : {}) }).length
        : 1;
      const spec = o.spec?.count ? specRunPlans(roles.pipeline.spec_check, o.spec.count).length : 0;
      const runIds = Array.from({ length: blinds + spec }, (_, i) => `${o.stage}-${started.length}-${i}`);
      started.push({ ...o, runIds });
      return { runIds };
    },
    reviewRunStatus: () => ({ state: 'running' }),
  });
}

/** four Issue lanes about to start their first blind on one worktree, each declaring `depth` (none when undefined) and reading `risk` in its qa */
function fourIssueLanes({ depth, risk }) {
  const wt = tempDir('idd-count-wt-');
  execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const ids = ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4'];
  const lane = [['lane_open', '07:00'], ['s1_ready', '07:10', depth ? { depth } : {}], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: head }], ['s2_result', '08:00']];
  const state = setup(COUNT_PIPELINE, Object.fromEntries(ids.map((id) => [id, lane])), { executors: ids });
  writeFileSync(join(state, 'roles.yaml'), COUNT_ROLES(COUNT_PIPELINE));
  writeFileSync(join(state, 'executor-sessions.jsonl'), ids.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
  for (const id of ids) {
    mkdirSync(join(wt, `_docs/qa/Demo/${id.toLowerCase()}`), { recursive: true });
    writeFileSync(join(wt, `_docs/qa/Demo/${id.toLowerCase()}/qa.md`), `---\nqa_schema: 5\nrisk: ${risk}\n---\n`);
  }
  return ids;
}

test('the lanes the wait list holds back are the ones the stage does not start, and the copies it counts are the runs it starts', async () => {
  // the cap is two lanes of (two models and the high-risk extra, and the spec check) = 8 copies; a lane is let in while 4 more
  // fit and fewer than two lanes run, so a round that adds fewer copies than the slot's size does not let a third lane in
  for (const [name, shape, runs, held] of [
    ['a shallow round: one blind and the spec check', { depth: 'shallow', risk: 'Low' }, 2, ['IDD-3', 'IDD-4']],
    ['a deep round: two blinds and the spec check', { depth: 'deep', risk: 'Low' }, 3, ['IDD-3', 'IDD-4']],
    ['a lane with no depth: the slot\'s two runs, no spec check', { risk: 'Low' }, 2, ['IDD-3', 'IDD-4']],
    ['a lane with no depth and a High Risk: the high-risk extra too', { risk: 'High' }, 3, ['IDD-3', 'IDD-4']],
  ]) {
    const ids = fourIssueLanes(shape);
    const started = [];
    countingRunner(started);
    const waits = waiting('review_blind');
    await runReviewLoop();
    setAgentRunner(null);
    const blinds = started.filter((c) => c.stage === 'blind');
    assert.deepEqual(waits, held, name);
    assert.deepEqual(ids.filter((id) => !blinds.some((c) => c.iddId === id)), held, `${name}: the stage starts the others`);
    assert.ok(blinds.every((c) => c.runIds.length === runs), `${name}: ${blinds.map((c) => c.runIds.length)}`);
  }
});

test('a review lane\'s wait counts the runs of its blind, not the slot\'s size', async () => {
  // size 3 (one role with two models, and the high-risk extra a review lane never adds), 2 runs, cap of 3 lanes = 9 copies:
  // the copies would hold four lanes of 2, the lane cap holds three
  const pipeline = '  review_blind: { role: r, models: [x-y, x-z], high_risk_extra: [o], concurrency: 3 }\n';
  const state = setup(pipeline, {});
  writeFileSync(join(state, 'roles.yaml'), COUNT_ROLES(pipeline));
  const ids = ['REV-1', 'REV-2', 'REV-3', 'REV-4', 'REV-5'];
  ids.forEach((id, i) => reviewLane(state, id, [['r_opened', `08:0${i}`], ['r_wt_ready', `08:1${i}`, { path: '/p', base: 'b', head: 'h' }]], at(`08:0${i}`)));
  const started = [];
  countingRunner(started);
  const waits = waiting('review_lane');
  await runReviewLanes();
  setAgentRunner(null);
  assert.deepEqual(waits, ['REV-4', 'REV-5']);
  assert.deepEqual(ids.filter((id) => !started.some((c) => c.iddId === id)), ['REV-4', 'REV-5']);
  assert.ok(started.every((c) => c.runIds.length === 2));
});

test('a lane whose map was drawn at a head it has left is not a blind wait: the stage draws the map again, whatever the cap holds', async () => {
  const wt = tempDir('idd-moved-wt-');
  execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const ready = [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: head }], ['s2_result', '08:00']];
  const ids = ['IDD-1', 'IDD-2', 'IDD-3'];
  const pipeline = '  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r }\n';
  const state = setup(pipeline, {
    // IDD-1 holds both copies of the cap
    'IDD-1': [...ready, ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['a', 'b'], head }]],
    'IDD-2': [...ready, ['s2_map_started', '08:05', { kind: 'blind', round: 1, run_id: 'm', head: 'old' }], ['s2_map_done', '08:06', { kind: 'blind', round: 1, routes: [{ id: 'R-1', paths: ['a.ts'], question: 'q', harms: [] }], head: 'old' }]],
    'IDD-3': ready,
  }, { executors: ids });
  writeFileSync(join(state, 'executor-sessions.jsonl'), ids.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    // a small diff: IDD-3 draws no map, so it is the blind's cap that holds it
    riskMapSkipReason: () => '差分 12 行（閾値 1000 行未満）',
    startReviewRun: async (o) => { started.push(o); return { runIds: [`${o.stage}-${started.length}`] }; },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  // IDD-3 waits behind IDD-1; IDD-2 is not held by the cap, so it is not listed
  assert.deepEqual(waiting('review_blind'), ['IDD-3']);
  const before = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8');
  await runReviewLoop();
  setAgentRunner(null);
  const added = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8').slice(before.length).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(added.filter((e) => e.event === 's2_map_head_moved').map((e) => e.idd_id), ['IDD-2']);
  assert.equal(started.length, 0, 'the stage starts nothing: IDD-3 waits for the copies, IDD-2 only draws its map again');
});

// ---- IDD-231 review: the wait list reads the Risk of a conflict scope round on the stage's own base ----

test('under high_risk_when last a conflict scope round is counted on the lane\'s own origin, as the stage reads its Risk', async () => {
  const last = RISKY_PIPE.replace('review_blind: { roles: [r, r], high_risk_extra: [o], concurrency: 1 }', 'review_blind: { roles: [r, r], high_risk_extra: [o], high_risk_when: last, concurrency: 1 }');
  assert.notEqual(last, RISKY_PIPE);
  // the mainline's commit alone touched the declared path: the lane's own origin sees it in the merge, the merged base does not
  for (const files of [{ main: { 'guard/main.ts': 'main\n' } }, { lane: { 'guard/lane.ts': 'lane\n' } }, {}]) {
    const { wt, init, reviewed, records } = conflictRepo(files);
    mkdirSync(join(wt, '_docs/qa/Demo/idd-1'), { recursive: true });
    writeFileSync(join(wt, '_docs/qa/Demo/idd-1/qa.md'), '---\nqa_schema: 5\nrisk: Medium\n---\n');
    const state = setup(last, {
      'IDD-1': conflictSentBack(init, reviewed, records, '09:00'),
      'IDD-2': conflictSentBack(init, reviewed, records, '09:10'),
    }, { executors: ['IDD-1', 'IDD-2'], riskPaths: { auth: ['guard/'] } });
    writeFileSync(join(state, 'executor-sessions.jsonl'), ['IDD-1', 'IDD-2'].map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
    const started = [];
    setAgentRunner({
      deliver: async () => {},
      startReviewRun: async (o) => {
        const n = o.stage === 'blind' || o.stage === 'final' ? 1 + (o.extras?.length ? 1 : 0) : 1;
        const runIds = Array.from({ length: n }, (_, i) => `${o.stage}-${started.length}-${i}`);
        started.push({ ...o, runIds });
        return { runIds };
      },
      reviewRunStatus: () => ({ state: 'running' }),
    });
    const waits = waiting('review_blind');
    await runReviewLoop();
    setAgentRunner(null);
    const blinds = started.filter((c) => c.stage === 'blind');
    assert.deepEqual(['IDD-1', 'IDD-2'].filter((id) => !blinds.some((c) => c.iddId === id)), waits, JSON.stringify(files));
  }
});

// ---- IDD-231 review: a lane the stage draws the map for first holds none of the blind's copies ----

/** three Issue lanes about to start their first blind on one worktree */
function mapFirstLanes(pipeline) {
  const wt = tempDir('idd-mapfirst-wt-');
  execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const ids = ['IDD-1', 'IDD-2', 'IDD-3'];
  const lane = [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: head }], ['s2_result', '08:00']];
  const state = setup(pipeline, Object.fromEntries(ids.map((id) => [id, lane])), { executors: ids });
  writeFileSync(join(state, 'executor-sessions.jsonl'), ids.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
}

/** a runner that answers whether the diff is large enough to map, and names one run per start (two for a blind) */
function mappingRunner(started, skipReason) {
  setAgentRunner({
    deliver: async () => {},
    riskMapSkipReason: () => skipReason,
    startReviewRun: async (o) => {
      const runIds = Array.from({ length: o.stage === 'blind' ? 2 : 1 }, (_, i) => `${o.stage}-${started.length}-${i}`);
      started.push({ ...o, runIds });
      return { runIds };
    },
    reviewRunStatus: () => ({ state: 'running' }),
  });
}

test('the Issue lanes the stage draws a map for first are not blind waits; the others are', async () => {
  const pipeline = '  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r, concurrency: 2 }\n';
  // a large diff: the first two lanes start a map each, and the third waits for the map's cap, holding no blind copy
  mapFirstLanes(pipeline);
  let started = [];
  mappingRunner(started, null);
  assert.deepEqual(waiting('review_blind'), []);
  assert.deepEqual(waiting('risk_map'), ['IDD-3']);
  await runReviewLoop();
  setAgentRunner(null);
  assert.deepEqual(started.map((c) => [c.iddId, c.stage]), [['IDD-1', 'map'], ['IDD-2', 'map']]);
  // a small diff: no map, so the first lane's blind holds the cap and the others wait for it
  mapFirstLanes(pipeline);
  started = [];
  mappingRunner(started, '差分 12 行（閾値 1000 行未満）');
  assert.deepEqual(waiting('review_blind'), ['IDD-2', 'IDD-3']);
  assert.deepEqual(waiting('risk_map'), []);
  await runReviewLoop();
  setAgentRunner(null);
  assert.deepEqual(started.map((c) => [c.iddId, c.stage]), [['IDD-1', 'blind']]);
});

test('the review lanes the stage draws a map for first are not blind waits; the others are', async () => {
  const pipeline = '  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r, concurrency: 1 }\n';
  const lanes = (state) => ['REV-1', 'REV-2', 'REV-3'].forEach((id, i) => reviewLane(state, id, [['r_opened', `08:0${i}`], ['r_wt_ready', `08:1${i}`, { path: '/p', base: 'b', head: 'h' }]], at(`08:0${i}`)));
  let started = [];
  lanes(setup(pipeline, {}));
  mappingRunner(started, null);
  assert.deepEqual(waiting('review_lane'), []);
  assert.deepEqual(waiting('review_lane_map'), ['REV-2', 'REV-3']);
  await runReviewLanes();
  setAgentRunner(null);
  assert.deepEqual(started.map((c) => [c.iddId, c.stage]), [['REV-1', 'map']]);
  started = [];
  lanes(setup(pipeline, {}));
  mappingRunner(started, '差分 12 行（閾値 1000 行未満）');
  assert.deepEqual(waiting('review_lane'), ['REV-2', 'REV-3']);
  assert.deepEqual(waiting('review_lane_map'), []);
  await runReviewLanes();
  setAgentRunner(null);
  assert.deepEqual(started.map((c) => [c.iddId, c.stage]), [['REV-1', 'blind']]);
});

test('a lane the stage draws a map for first is no blind wait while the blind cap is full: the map cap alone holds it', async () => {
  const pipeline = '  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r, concurrency: 1 }\n';
  const wt = tempDir('idd-mapfirst-full-wt-');
  execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const ids = ['IDD-1', 'IDD-2', 'IDD-3'];
  const lane = [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: head }], ['s2_result', '08:00']];
  // IDD-1 holds both copies of the blind cap
  const state = setup(pipeline, {
    'IDD-1': [...lane, ['s2_review_started', '08:05', { kind: 'blind', round: 1, run_ids: ['a', 'b'], head }]],
    'IDD-2': lane,
    'IDD-3': lane,
  }, { executors: ids });
  writeFileSync(join(state, 'executor-sessions.jsonl'), ids.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: wt })).join('\n') + '\n');
  const started = [];
  mappingRunner(started, null);
  // a large diff: IDD-2 takes the map slot, IDD-3 waits for it, and neither is a blind wait
  assert.deepEqual(waiting('review_blind'), []);
  assert.deepEqual(waiting('risk_map'), ['IDD-3']);
  await runReviewLoop();
  assert.deepEqual(started.map((c) => [c.iddId, c.stage]), [['IDD-2', 'map']]);
  setAgentRunner(null);
});

test('a review lane the stage draws a map for first is no blind wait while the blind cap is full', async () => {
  const pipeline = '  review_blind: { roles: [r, r], concurrency: 1 }\n  risk_map: { role: r, concurrency: 1 }\n';
  const state = setup(pipeline, {});
  // REV-1 holds both copies of the blind cap; REV-2 and REV-3 are about to start
  reviewLane(state, 'REV-1', [['r_opened', '08:00'], ['r_wt_ready', '08:10', { path: '/p', base: 'b', head: 'h' }], ['r_blind_started', '08:20', { round: 1, run_ids: ['a', 'b'], head: 'h' }]], at('08:00'));
  ['REV-2', 'REV-3'].forEach((id, i) => reviewLane(state, id, [['r_opened', `08:0${i + 1}`], ['r_wt_ready', `08:1${i + 1}`, { path: '/p', base: 'b', head: 'h' }]], at(`08:0${i + 1}`)));
  const started = [];
  mappingRunner(started, null);
  assert.deepEqual(waiting('review_lane'), []);
  assert.deepEqual(waiting('review_lane_map'), ['REV-3']);
  await runReviewLanes();
  setAgentRunner(null);
  assert.deepEqual(started.map((c) => [c.iddId, c.stage]), [['REV-2', 'map']]);
});

// ---- IDD-231 review: a lane the stage holds for its executor is not a blind wait ----

test('a lane whose executor has not stopped is not a blind wait and takes no slot: the stage starts the next lane, as the list reads', async () => {
  const repo = (name) => {
    const wt = tempDir(`idd-executor-wait-${name}-`);
    execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
    // the head's own change is older than the wait's length on both clocks (the list's NOW and the stage's), so only a busy conversation holds a lane
    execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'], { env: { ...process.env, GIT_COMMITTER_DATE: at('07:00') } });
    return { wt, head: execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  };
  const busy = repo('busy');
  const idle = repo('idle');
  const ids = ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4'];
  const lane = (head) => [['lane_open', '07:00'], ['s1_ready', '07:10'], ['s1_go', '07:20'], ['s2_start', '07:30', { started_from_commit: head }], ['s2_result', '08:00']];
  // one lane at a time fits the blind cap (two copies of a lane of two roles); the first lane's executor is still answering
  const state = setup('  review_blind: { roles: [r, r], concurrency: 1 }\n  review_loop: { executor_still_seconds: 1 }\n', {
    'IDD-1': lane(busy.head), 'IDD-2': lane(idle.head), 'IDD-3': lane(idle.head), 'IDD-4': lane(idle.head),
  }, { executors: ids });
  const worktrees = { 'IDD-1': busy.wt, 'IDD-2': idle.wt, 'IDD-3': idle.wt, 'IDD-4': idle.wt };
  writeFileSync(join(state, 'executor-sessions.jsonl'), ids.map((id) => JSON.stringify({ idd_id: id, executor_session_id: `E-${id}`, worktree_path: worktrees[id] })).join('\n') + '\n');
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    cwdBusy: (wt) => wt === busy.wt,
    startReviewRun: async (o) => { started.push(o); return { runIds: [`${o.stage}-${started.length}-a`, `${o.stage}-${started.length}-b`] }; },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  // IDD-1 is held for its executor, not for the cap; IDD-2 takes the copies; IDD-3 and IDD-4 wait for them
  assert.deepEqual(waiting('review_blind'), ['IDD-3', 'IDD-4']);
  assert.deepEqual(slot('review_blind').next, ['IDD-2'], 'the lane held for its executor is not one the stage starts next');
  const before = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8');
  await runReviewLoop();
  setAgentRunner(null);
  const added = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8').slice(before.length).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(added.filter((e) => e.event === 's2_executor_waiting').map((e) => e.idd_id), ['IDD-1']);
  assert.deepEqual(started.filter((c) => c.stage === 'blind').map((c) => c.iddId), ['IDD-2']);
});

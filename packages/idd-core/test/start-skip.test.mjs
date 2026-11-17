import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { LANE_START_SKIPPED, recordStartSkips, startSkipOf } from '../src/plan/start-skip.ts';
import { runStallWatch, LANE_STALL_DETECTED } from '../src/plan/stall-watch.ts';
import { runAfterDecision, runTick } from '../src/plan/tick.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { setStaleHoldProvider } from '../src/plan/stale-hold.ts';
import { deriveStage, laneHalt, withoutNotes } from '../src/ledger/derive.ts';
import { laneTurn, turnSince } from '../src/ledger/turn.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { recordQuotaWait } from '../src/plan/quota-wait.ts';
import { readLifecycle } from '../src/ledger/read.ts';

const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const rowsOf = (events) => events.map((e) => ({ event: e[0], idd_id: 'IDD-1', at: ago(e[1]), attrs: e[2] || {} }));
const laneRows = (id = 'IDD-1') => readLifecycle().filter((e) => e.idd_id === id);
const reasons = (id = 'IDD-1') => laneRows(id).filter((e) => e.event === LANE_START_SKIPPED).map((e) => e.attrs.reason);

/** a state whose lanes are opened (and, unless `only` is set, plan-ready) 200 minutes ago; no repo is registered */
function setup(ids, { stallMinutes = 45, only = false } = {}) {
  const root = scratchDir('start-skip-');
  const state = join(root, 'state');
  mkdirSync(state);
  const files = {
    'repos.yaml': 'repos: {}\n',
    'roles.yaml': `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n  stall_watch: { stall_minutes: ${stallMinutes} }\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_REPOS_FILE = join(root, 'repos.yaml');
  process.env.IDD_ROLES_FILE = join(root, 'roles.yaml');
  const lines = (list) => list.map((o) => JSON.stringify(o)).join('\n') + '\n';
  writeFileSync(join(state, 'backlog.jsonl'), lines(ids.map((idd_id) => ({ idd_id, area: 'demo', title: 't', context: '', created_at: ago(200) }))));
  const events = only ? ['lane_open'] : ['lane_open', 's1_ready'];
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), lines(ids.flatMap((idd_id) => events.map((event) => ({ idd_id, event, at: ago(199), attrs: {} })))));
}

/** the stage's skips, one pass per reason in order, for the lane given */
async function skipThrough(stage, list, iddId = 'IDD-1', wait = false) {
  for (const reason of list) await recordStartSkips(stage, [{ iddId, reason, ...(wait ? { wait: true } : {}) }]);
}

test('AC-001, AC-002, AC-003: one row per stage and reason; a changed reason adds a row, an earlier row stays as written', async () => {
  setup(['IDD-1'], { only: true });
  await skipThrough('planner', ['worktree: disk full']);
  const first = laneRows().find((e) => e.event === LANE_START_SKIPPED);
  assert.deepEqual(first.attrs, { stage: 'planner', reason: 'worktree: disk full' });
  const steps = [
    ['planner', ['worktree: disk full', 'worktree: disk full'], ['worktree: disk full']],
    ['planner', ['concurrency cap'], ['worktree: disk full', 'concurrency cap']],
    ['planner', ['worktree: disk full'], ['worktree: disk full', 'concurrency cap', 'worktree: disk full']],
    ['executor', ['worktree: disk full'], ['worktree: disk full', 'concurrency cap', 'worktree: disk full', 'worktree: disk full']],
  ];
  for (const [stage, list, expected] of steps) {
    await skipThrough(stage, list);
    assert.deepEqual(reasons(), expected);
  }
  assert.deepEqual(laneRows().find((e) => e.event === LANE_START_SKIPPED), first, 'the first row is not rewritten');
  assert.deepEqual(startSkipOf(laneRows()), { stage: 'executor', reason: 'worktree: disk full', wait: false });
});

test('AC-001: an empty reason writes nothing, and a long one is cut', async () => {
  setup(['IDD-1'], { only: true });
  await skipThrough('planner', ['  ', 'x'.repeat(900)]);
  assert.deepEqual(reasons().map((r) => r.length), [400]);
});

test('AC-006: the windows wait already has its row, so its reason is not written a second time', async () => {
  setup(['IDD-1'], { only: true });
  await recordQuotaWait('IDD-1', laneRows(), 'planner', { reason: 'five_hour window is full' });
  await skipThrough('planner', Array(2).fill('claude quota: five_hour window is full'));
  assert.deepEqual(reasons(), []);
  assert.equal(laneRows().filter((e) => e.event === 'claude_quota_wait').length, 1, 'the wait is the one line');
});

test('AC-006: a cap wait and an engine replacement hold each read as one line on their lane', async () => {
  setup(['IDD-1', 'IDD-2'], { only: true });
  for (let pass = 0; pass < 2; pass += 1) {
    await recordStartSkips('planner', [{ iddId: 'IDD-1', reason: 'concurrency cap' }, { iddId: 'IDD-2', reason: 'engine を入れ替えています' }]);
  }
  assert.deepEqual([reasons('IDD-1'), reasons('IDD-2')], [['concurrency cap'], ['engine を入れ替えています']]);
});

test('AC-005: the note moves neither the stage, nor the turn, nor the review state, nor a quota wait', () => {
  const skip = [LANE_START_SKIPPED, 1, { stage: 'planner', reason: 'no runner' }];
  const quota = ['claude_quota_wait', 10, { stage: 'planner', reason: 'windows' }];
  for (const base of [[['lane_open', 200], ['s1_ready', 199]], [['lane_open', 200], ['s1_ready', 199], quota]]) {
    const plain = rowsOf(base);
    const noted = [...plain, ...rowsOf([skip])];
    assert.deepEqual(deriveStage(noted), deriveStage(plain));
    assert.deepEqual([laneTurn(noted, {}), turnSince(noted, {})], [laneTurn(plain, {}), turnSince(plain, {})]);
    assert.deepEqual(reviewLoopState(noted), reviewLoopState(plain));
    assert.deepEqual(withoutNotes(noted).map((e) => e.event), withoutNotes(plain).map((e) => e.event));
  }
  const quotaOnly = rowsOf([['lane_open', 200], quota]);
  assert.match(deriveStage([...quotaOnly, ...rowsOf([skip])]).blockedBy, /Claude の枠待ち/);
});

test('AC-004: a planner that cannot be started reaches penne as one halt card with the reason, ticks after ticks', { timeout: 60_000 }, async () => {
  setup(['IDD-1'], { only: true });
  setStaleHoldProvider(() => ({ hold: false }));
  setAgentRunner({ deliver: async () => {} });
  for (let tick = 0; tick < 2; tick += 1) await runTick({ intake: false });
  setStaleHoldProvider(null);
  setAgentRunner(null);
  assert.equal(laneRows().filter((e) => e.event === LANE_STALL_DETECTED).length, 1);
  const halt = laneHalt(laneRows());
  assert.match(halt.reason, /計画役を起こせない: no runner/);
  assert.ok(Math.abs(Date.parse(halt.since) - Date.parse(ago(199))) < 5_000, `the clock starts at the step, not at the note: ${halt.since}`);
});

test('AC-004: a planner started after the note is not read as one that cannot start', async () => {
  setup(['IDD-1'], { only: true });
  setAgentRunner({ deliver: async () => {}, cwdBusy: () => false });
  await skipThrough('planner', ['no runner']);
  const session = { idd_id: 'IDD-1', planner_session_id: 'p1', started_at: new Date(Date.now() + 1000).toISOString(), worktree_path: '/nonexistent', branch: 'b' };
  writeFileSync(join(process.env.IDD_STATE_DIR, 'planner-sessions.jsonl'), JSON.stringify(session) + '\n');
  await runStallWatch({});
  setAgentRunner(null);
  assert.equal(laneRows().filter((e) => e.event === LANE_STALL_DETECTED).length, 0);
});

test('AC-004: a planner held for space or for the cap is a wait with its reason as a row, never a halt card', async () => {
  for (const reason of ['空きが足りないので始めていません（3.0G / しきい値 10.0G）', 'concurrency cap']) {
    setup(['IDD-1'], { only: true });
    setAgentRunner({ deliver: async () => {}, cwdBusy: () => false });
    await skipThrough('planner', [reason], 'IDD-1', true);
    // the stage has just said it could not start, and a slot is free for the lane on its next pass
    await runStallWatch({ slotWaits: [{ lanes: [], next: ['IDD-1'] }] });
    await runStallWatch({});
    setAgentRunner(null);
    assert.equal(laneRows().filter((e) => e.event === LANE_STALL_DETECTED).length, 0, reason);
    assert.deepEqual(reasons(), [reason]);
  }
});

test('AC-004: the stage answers that it waits; the words of its reason are not read', async () => {
  // a wait in words no reader knows is still a wait; a refusal in the words of a wait is still a failure
  const cases = [['別の言葉で待っています', true, 0], ['concurrency cap', false, 1], ['空きが足りないので始めていません（3.0G / しきい値 10.0G）', false, 1]];
  for (const [reason, wait, cards] of cases) {
    setup(['IDD-1'], { only: true });
    setAgentRunner({ deliver: async () => {}, cwdBusy: () => false });
    await skipThrough('planner', [reason], 'IDD-1', wait);
    await runStallWatch({});
    await runStallWatch({});
    setAgentRunner(null);
    assert.equal(laneRows().filter((e) => e.event === LANE_STALL_DETECTED).length, cards, `${reason} wait=${wait}`);
    assert.equal(laneRows().find((e) => e.event === LANE_START_SKIPPED).attrs.wait, wait ? true : undefined);
  }
});

test('AC-004: with no runner set, a planner that cannot be started still reaches penne as one halt card with the reason', async () => {
  setup(['IDD-1'], { only: true });
  setAgentRunner(null);
  await skipThrough('planner', ['no runner']);
  await runStallWatch({});
  await runStallWatch({});
  assert.equal(laneRows().filter((e) => e.event === LANE_STALL_DETECTED).length, 1);
  assert.match(laneHalt(laneRows()).reason, /計画役を起こせない: no runner/);
});

test('AC-004: with no runner set, a lane whose planner is only waited for is not halted', async () => {
  setup(['IDD-1'], { only: true });
  setAgentRunner(null);
  await runStallWatch({});
  assert.equal(laneRows().filter((e) => e.event === LANE_STALL_DETECTED).length, 0);
});

test('AC-004: a reason from before the lane moved on is history, not the reason now', async () => {
  setup(['IDD-1']);
  await skipThrough('planner', ['worktree: disk full']);
  await appendLifecycle('s1_plan_review_started', 'IDD-1', {});
  assert.equal(startSkipOf(laneRows()), undefined);
});

test('AC-001, AC-002: a tick that cannot start the planner leaves its reason as one row however many ticks run', { timeout: 60_000 }, async () => {
  setup(['IDD-1'], { stallMinutes: 0, only: true });
  // a runner with no spawn answers "no runner"; then a replacement hold is a new reason, and it too is one row
  const passes = [[{ hold: false }, 'no runner'], [{ hold: true, reason: 'engine を入れ替えています' }, 'engine を入れ替えています']];
  const seen = [];
  for (const [hold, reason] of passes) {
    setStaleHoldProvider(() => hold);
    setAgentRunner({ deliver: async () => {} });
    for (let tick = 0; tick < 3; tick += 1) await runTick({ intake: false });
    seen.push(reason);
    assert.deepEqual(reasons(), seen, 'three ticks add one row for the reason');
  }
  setStaleHoldProvider(null);
  setAgentRunner(null);
});

/** a lane whose GO was given 199 minutes ago: its executor is the agent the stage owes a start */
function goneLane() {
  setup(['IDD-1'], { stallMinutes: 45 });
  appendFileSync(join(process.env.IDD_STATE_DIR, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 's1_go', at: ago(199), attrs: {} }) + '\n');
}

test('AC-001, AC-002: a GO that cannot start its executor leaves the reason as one row, and the next tick adds none', { timeout: 60_000 }, async () => {
  goneLane();
  setStaleHoldProvider(() => ({ hold: false }));
  setAgentRunner({ deliver: async () => {} });
  const seen = [];
  for (const pass of [() => runAfterDecision({ exec: true }), () => runAfterDecision({ exec: true }), () => runTick({ intake: false })]) {
    await pass();
    seen.push(reasons());
  }
  setStaleHoldProvider(null);
  setAgentRunner(null);
  assert.deepEqual(seen, [['no runner'], ['no runner'], ['no runner']]);
  assert.equal(laneRows().find((e) => e.event === LANE_START_SKIPPED).attrs.stage, 'executor');
});

test('AC-004: a session left in the worktree by the failed delivery does not hide the card; no repair is sent there', async () => {
  // the planner's brief failed to reach it, and the session it started stays in the worktree: busy, and older than the note
  const cases = [[true, 1], [false, 0]];
  for (const [noted, cards] of cases) {
    setup(['IDD-1'], { only: true });
    const wt = join(process.env.IDD_STATE_DIR, 'wt');
    mkdirSync(wt);
    setAgentRunner({ deliver: async () => {}, cwdBusy: () => true });
    writeFileSync(join(process.env.IDD_STATE_DIR, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'p1', started_at: ago(100), worktree_path: wt, branch: 'b' }) + '\n');
    if (noted) await skipThrough('planner', ['worktree: boom']);
    const done = await runStallWatch({});
    await runStallWatch({});
    setAgentRunner(null);
    assert.equal(laneRows().filter((e) => e.event === LANE_STALL_DETECTED).length, cards, `noted=${noted}`);
    assert.deepEqual(done.instructed, []);
    if (noted) assert.match(laneHalt(laneRows()).reason, /計画役を起こせない: worktree: boom/);
  }
});

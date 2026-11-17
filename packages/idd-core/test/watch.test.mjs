import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runWatch } from '../src/plan/watch.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { applyDecision, appendLifecycle, queueEnvelope } from '../src/ledger/write.ts';
import { holdBatch, settledResume } from '../src/ledger/routing-hold.ts';
import { runResume } from '../src/plan/resume.ts';
import { readLifecycle } from '../src/ledger/read.ts';

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function setup(events) {
  const root = scratchDir('watch-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 't', context: '' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'S1', worktree_path: root }) + '\n');
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map((e) => {
    const [event, m, attrs] = Array.isArray(e) ? e : [e.event, e.m, e.attrs];
    return JSON.stringify({ idd_id: 'IDD-1', event, at: minutesAgo(m), attrs: attrs ?? {} });
  }).join('\n') + '\n');
}

function runnerWith(status) {
  const delivered = [];
  setAgentRunner({ deliver: async (id, text, opts) => { delivered.push({ id, text, type: opts?.type }); }, sessionStatus: async () => status() });
  return delivered;
}

const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1');

test('an executor that stopped on an error is resumed once, then goes to penne; penne can let it try again', async () => {
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20]]);
  let status = { state: 'stopped', cause: 'error', error: '400: provider', at: minutesAgo(1) };
  const delivered = runnerWith(() => status);
  await runWatch();
  assert.equal(delivered.length, 0, 'a stop younger than the grace period is left alone');
  status = { ...status, at: minutesAgo(5) };
  await runWatch();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 's2_resume');
  await runWatch();
  assert.equal(delivered.length, 1, 'one automatic resume per stop');
  assert.deepEqual([deriveStage(lane()).group, deriveStage(lane()).decision], ['judge', 'stuck']);
  assert.match(deriveStage(lane()).blockedBy, /executor/);
  assert.equal((await applyDecision('lane_stall_resume', { iddId: 'IDD-1' })).ok, true);
  assert.equal(deriveStage(lane()).group, 'impl');
  await runWatch();
  assert.equal(delivered.length, 2, "penne's resume allows one more automatic attempt");
});

test('a running session, or a lane that already has its result, is not touched', async () => {
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20]]);
  const delivered = runnerWith(() => ({ state: 'running' }));
  await runWatch();
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20], ['s2_result', 10]]);
  const after = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(9) }));
  await runWatch();
  assert.equal(delivered.length + after.length, 0);
});

test('a planner revising after the plan review, or after penne sent the plan back, is watched too', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  const reviewed = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 1, should: 0 })];
  assert.equal(awaitedAgent(reviewed)?.role, 'planner');
  const sentBack = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 0, should: 0 }), ev('s1_revise_requested')];
  assert.equal(awaitedAgent(sentBack)?.role, 'planner');
  assert.equal(awaitedAgent([...sentBack, ev('s1_ready')]), null, 'waiting for the review, not for the planner');
});

test('a session a person stopped is not resumed on its own; it goes to penne, and penne\'s resume lets the watch resume it', async () => {
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20]]);
  const status = { state: 'stopped', cause: 'stopped', at: minutesAgo(5) };
  const delivered = runnerWith(() => status);
  await runWatch();
  assert.equal(delivered.length, 0, 'a stop by a person is not an interruption to recover from');
  assert.equal(deriveStage(lane()).decision, 'stuck');
  assert.match(String(lane().at(-1).attrs.reason), /止め/);
  await runWatch();
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 1, 'raised once');
  assert.equal((await applyDecision('lane_stall_resume', { iddId: 'IDD-1' })).ok, true);
  await runWatch();
  assert.equal(delivered.length, 1, 'resumed after penne chose to');
  assert.equal(delivered[0].type, 's2_resume');
});

test('a session waiting for Claude\'s windows is neither resumed nor raised to penne; the runtime is asked to wake it, and the wait is recorded once', async () => {
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20]]);
  const delivered = [];
  const woken = [];
  let wakes = false;
  setAgentRunner({
    deliver: async (id, text) => { delivered.push({ id, text }); },
    sessionStatus: async () => ({ state: 'quota_wait', reason: 'Claude の枠が止める閾値に達している', resetsAt: 1790000000, at: minutesAgo(10) }),
    wakeSession: async (id) => { woken.push(id); return wakes; },
  });
  await runWatch();
  await runWatch();
  assert.equal(delivered.length, 0, 'a wait is not an interruption to recover from');
  assert.deepEqual(woken, ['S1', 'S1']);
  assert.notEqual(deriveStage(lane()).decision, 'stuck');
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 0);
  const waits = lane().filter((e) => e.event === 'claude_quota_wait');
  assert.equal(waits.length, 1, 'the same wait is recorded once');
  assert.equal(waits[0].attrs.resets_at, 1790000000);
  wakes = true;
  await runWatch();
  assert.equal(lane().filter((e) => e.event === 'claude_quota_wait').length, 1, 'a woken session adds no wait');
});

test("a resume the windows refuse is a wait, not a stop: recorded once, tried again when the windows are back; any other refusal still goes to penne", async () => {
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20]]);
  const delivered = [];
  let refusal = Object.assign(new Error('Claude の枠が止める閾値に達している'), { code: 'claude_quota', resetsAt: 1790000000 });
  setAgentRunner({
    deliver: async (id, text, opts) => { if (refusal) throw refusal; delivered.push({ id, type: opts?.type }); },
    sessionStatus: async () => ({ state: 'stopped', cause: 'error', error: 'x', at: minutesAgo(5) }),
  });
  await runWatch();
  await runWatch();
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 0, 'a refusal for the windows is not a stop');
  assert.equal(lane().filter((e) => e.event === 'claude_quota_wait').length, 1, 'the same wait is recorded once');
  refusal = null;
  const back = await runWatch();
  assert.deepEqual(delivered.map((d) => d.type), ['s2_resume'], 'the windows are back: the resume is tried again');
  assert.equal(back.errors.length, 0);
  // any other refusal is still a stop
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20]]);
  refusal = new Error('boom');
  const other = await runWatch();
  assert.equal(other.errors.length, 1);
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 1);
});

test('a lane that asked and has no answer yet is not awaited; the answer hands the work back', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  const executorAsked = [ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('question_batch_asked', { batch_id: 'b1' })];
  assert.equal(awaitedAgent(executorAsked), null);
  assert.equal(awaitedAgent([...executorAsked, ev('question_batch_answered', { batch_id: 'b1' })])?.role, 'executor');
  const reviewAsked = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 1, should: 0 }), ev('question_batch_asked', { batch_id: 'b2' })];
  assert.equal(awaitedAgent(reviewAsked), null);
  assert.equal(awaitedAgent([...reviewAsked, ev('question_batch_answered', { batch_id: 'b2' })])?.role, 'planner');
  const sentBackAsked = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 0, should: 0 }), ev('s1_revise_requested'), ev('question_batch_asked', { batch_id: 'b3' })];
  assert.equal(awaitedAgent(sentBackAsked), null);
  assert.equal(awaitedAgent([...sentBackAsked, ev('question_batch_answered', { batch_id: 'b3' })])?.role, 'planner');
});

test('an answer to one batch never counts for another: a lane with any unanswered batch is not awaited', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  const twoBatches = [ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('question_batch_asked', { batch_id: 'b1' }), ev('question_batch_asked', { batch_id: 'b2' }), ev('question_batch_answered', { batch_id: 'b2' })];
  assert.equal(awaitedAgent(twoBatches), null, 'b1 is still unanswered');
  assert.equal(awaitedAgent([...twoBatches, ev('question_batch_answered', { batch_id: 'b1' })])?.role, 'executor');
});

test('an executor resumed once before a question still gets its automatic resume after the answer', async () => {
  setup([
    ['lane_open', 40], ['s1_go', 35], ['s2_start', 30],
    ['s2_recovery_attempt', 25],
    // the answer is a work boundary too: the earlier recovery attempt must not count against a resume after it
    ['question_batch_asked', 20, { batch_id: 'b1' }],
    ['question_batch_answered', 15, { batch_id: 'b1' }],
  ]);
  const delivered = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(10) }));
  await runWatch();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 's2_resume');
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 0);
});

test('runWatch writes neither a resume nor a stall while the lane waits for an answer, and watches again once it comes', async () => {
  setup([['lane_open', 30], ['s1_go', 20], ['s2_start', 20], ['question_batch_asked', 10]]);
  const delivered = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(9) }));
  await runWatch();
  assert.equal(delivered.length, 0);
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 0);
  const { appendLifecycle } = await import('../src/ledger/write.ts');
  await appendLifecycle('question_batch_answered', 'IDD-1', { batch_id: 'b1' });
  await runWatch();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 's2_resume');
});

test('a planner that stopped without a plan after penne answered is resumed once, then raised to penne, and penne\'s resume lets it try again', async () => {
  setup([['lane_open', 60], ['question_batch_asked', 50, { batch_id: 'b1' }], ['question_batch_answered', 40, { batch_id: 'b1' }]]);
  const state = process.env.IDD_STATE_DIR;
  rmSync(join(state, 'executor-sessions.jsonl'));
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'P1', started_at: minutesAgo(60), worktree_path: state }) + '\n');
  const delivered = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(30) }));
  assert.deepEqual([deriveStage(lane()).group, deriveStage(lane()).decision], ['prep', undefined], 'the answer hands the lane back to the planner');
  const { laneActivity } = await import('../src/plan/prep.ts');
  assert.equal(laneActivity('IDD-1', deriveStage(lane()).group, new Set()), 'stalled', 'a session the runtime does not run is not shown as live');
  assert.equal(laneActivity('IDD-1', deriveStage(lane()).group, new Set(['P1'])), 'live');
  await runWatch();
  assert.equal(delivered.length, 1, 'a planner that finished without a plan is woken once');
  assert.equal(delivered[0].type, 's1_resume');
  await runWatch();
  assert.equal(delivered.length, 1, 'one automatic resume per stop');
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 1);
  assert.deepEqual([deriveStage(lane()).group, deriveStage(lane()).decision], ['judge', 'stuck']);
  assert.equal((await applyDecision('lane_stall_resume', { iddId: 'IDD-1' })).ok, true);
  await runWatch();
  assert.equal(delivered.length, 2, "penne's resume reaches the planner on the next pass");
});

test('a planner with a batch still open is not woken, whether it asked again or answered one of two', async () => {
  const stopped = () => ({ state: 'stopped', cause: 'finished', at: minutesAgo(30) });
  for (const rows of [
    [['lane_open', 60], ['question_batch_asked', 50, { batch_id: 'b1' }], ['question_batch_answered', 40, { batch_id: 'b1' }], ['question_batch_asked', 35, { batch_id: 'b2' }]],
    [['lane_open', 60], ['question_batch_asked', 50, { batch_id: 'b1' }], ['question_batch_asked', 45, { batch_id: 'b2' }], ['question_batch_answered', 40, { batch_id: 'b2' }]],
  ]) {
    setup(rows);
    const state = process.env.IDD_STATE_DIR;
    rmSync(join(state, 'executor-sessions.jsonl'));
    writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'P1', started_at: minutesAgo(60), worktree_path: state }) + '\n');
    const delivered = runnerWith(stopped);
    await runWatch();
    assert.equal(delivered.length, 0);
    assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 0);
    assert.equal(deriveStage(lane()).decision, 'question');
  }
});

test('an unanswered batch left over from an earlier stage does not stop the watch in a later one', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  // penne went on without answering b0; the executor now has work of its own
  const executor = [ev('lane_open'), ev('question_batch_asked', { batch_id: 'b0' }), ev('s1_go'), ev('s2_start')];
  assert.equal(awaitedAgent(executor)?.role, 'executor');
  const planner = [ev('lane_open'), ev('question_batch_asked', { batch_id: 'b0' }), ev('s1_ready'), ev('s1_plan_review_done', { must: 1, should: 0 })];
  assert.equal(awaitedAgent(planner)?.role, 'planner');
});

test('runWatch still resumes a lane whose only unanswered batch is from an earlier stage', async () => {
  setup([
    ['lane_open', 40], ['question_batch_asked', 35, { batch_id: 'b0' }], ['s1_go', 30], ['s2_start', 25],
  ]);
  const delivered = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(10) }));
  await runWatch();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 's2_resume');
});

test('an answer that arrives after the executor result does not revive it', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  const afterResult = [ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('question_batch_asked', { batch_id: 'b1' }), ev('s2_result'), ev('question_batch_answered', { batch_id: 'b1' })];
  assert.equal(awaitedAgent(afterResult), null);
});

test('runWatch writes no resume and no stall when an answer arrives after the executor result', async () => {
  setup([
    ['lane_open', 40], ['s1_go', 35], ['s2_start', 30],
    ['question_batch_asked', 25, { batch_id: 'b1' }],
    ['s2_result', 20],
    ['question_batch_answered', 15, { batch_id: 'b1' }],
  ]);
  const delivered = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(10) }));
  await runWatch();
  assert.equal(delivered.length, 0);
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 0);
});

test('a fix round after the first result treats the answer as the work boundary', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  const fixRound = [
    ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_fix_sent'),
    ev('s2_recovery_attempt'),
    ev('question_batch_asked', { batch_id: 'b1' }), ev('question_batch_answered', { batch_id: 'b1' }),
  ];
  const awaited = awaitedAgent(fixRound);
  assert.equal(awaited?.role, 'executor');
  assert.equal(awaited.since, 7, 'the answer (7), not s2_fix_sent (4)');
});

test('runWatch resumes a fix-round executor after the answer even when it was resumed once before the question', async () => {
  setup([
    ['lane_open', 50], ['s1_go', 45], ['s2_start', 40],
    ['s2_result', 35], ['s2_fix_sent', 32],
    ['s2_recovery_attempt', 30],
    ['question_batch_asked', 25, { batch_id: 'b1' }],
    ['question_batch_answered', 20, { batch_id: 'b1' }],
  ]);
  const delivered = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(10) }));
  await runWatch();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 's2_resume');
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 0);
});

test('only a conflict whose instruction went out is counted as executor work', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  const base = [ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('s2_result')];
  // a conflict on record without an instruction is neither executor work nor a wait the watch wakes
  const resolved = [...base, ev('s2_review_base_conflict', { awaiting: false })];
  assert.equal(awaitedAgent(resolved), null);
  assert.equal(awaitedAgent([...resolved, ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] })]), null);
  // a wait whose instruction is not on record is not executor work
  const waiting = [...base, ev('s2_review_base_conflict', { awaiting: true })];
  assert.equal(awaitedAgent(waiting), null);
  // once the instruction is on record, the executor is awaited from there
  const instructed = [...waiting, ev('s2_review_base_instructed', { head: 'h', mainline: 'm', files: ['app.txt'] })];
  assert.deepEqual(awaitedAgent(instructed), { role: 'executor', since: instructed.length - 1 });
  // an instructed conflict that has a result after it is not awaited again
  assert.equal(awaitedAgent([...instructed, ev('s2_result')]), null);
  // a lane waiting for the lanes ahead of it before its first review is not executor work either
  const ordered = [...base, ev('s2_order_waiting', { head: 'h', since: '2026-09-01T09:00:00+09:00', opponents: [{ lane: 'IDD-2', head: 'h2', files: ['app.txt'] }] })];
  assert.equal(awaitedAgent(ordered), null);
  assert.equal(awaitedAgent([...ordered, ev('s2_order_released', { since: 'x', head: 'h' })]), null);
});

test('a records send-back is executor work: the lane reads as the executor turn, and a stopped session is resumed once', async () => {
  const { awaitedAgent } = await import('../src/plan/watch.ts');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });
  const base = [ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_review_converged'), ev('s2_device_skipped')];
  // the wait is recorded but the instruction did not go out: not the executor's yet
  const waiting = [...base, ev('s2_records_conflict', { awaiting: true })];
  assert.equal(awaitedAgent(waiting), null);
  const instructed = [...waiting, ev('s2_records_instructed', { head: 'h' })];
  assert.deepEqual(awaitedAgent(instructed), { role: 'executor', since: instructed.length - 1 });
  assert.equal(awaitedAgent([...instructed, ev('s2_result')]), null, 'the result ends the episode');
  assert.equal(deriveStage(instructed).group, 'impl');

  setup([
    ['lane_open', 40], ['s1_go', 35], ['s2_start', 30], ['s2_result', 25],
    ['s2_review_converged', 24], ['s2_device_skipped', 23], ['s2_records_conflict', 22, { awaiting: true }], ['s2_records_instructed', 21, { head: 'h' }],
  ]);
  const delivered = runnerWith(() => ({ state: 'stopped', cause: 'finished', at: minutesAgo(10) }));
  await runWatch();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 's2_resume');
  await runWatch();
  assert.equal(delivered.length, 1, 'one automatic resume per stop');
});

const heldBatch = { idd_id: 'IDD-1', batch_id: 'B1', asked_at: new Date().toISOString(), questions: [] };

const setupOpenLane = () => setup([['lane_open', 60], ['s1_go', 50], ['s2_start', 40]]);
const stoppedFor30m = () => ({ state: 'stopped', cause: 'finished', at: minutesAgo(30) });
const noRecoveryWritten = () => !lane().some((e) => ['lane_stalled', 'lane_stall_resumed', 's1_recovery_attempt', 's2_recovery_attempt'].includes(e.event));

test('a lane whose batch the judge still holds is neither resumed nor stopped, however long the stop lasts', async () => {
  setupOpenLane();
  const delivered = runnerWith(stoppedFor30m);
  holdBatch(heldBatch);
  await runWatch();
  await runWatch();
  await runWatch();
  assert.equal(delivered.length, 0, 'no automatic resume while the judge holds the batch');
  assert.equal(lane().some((e) => e.event === 'lane_stalled'), false, 'and no stop is written');
  assert.notEqual(deriveStage(lane()).decision, 'stuck');
});

test('once the judge\'s result is on record the lane is watched as before: one resume, then a stop', async () => {
  setup([
    ['lane_open', 60], ['s1_go', 50], ['s2_start', 45],
    ['question_batch_asked', 40, { batch_id: 'B1' }], ['question_batch_answered', 35, { batch_id: 'B1' }], ['s4_verify_user_judgment_answered', 34],
  ]);
  writeFileSync(join(process.env.IDD_STATE_DIR, 'pending-questions.jsonl'), JSON.stringify(heldBatch) + '\n');
  holdBatch(heldBatch);
  const delivered = runnerWith(stoppedFor30m);
  await runWatch();
  assert.equal(delivered.length, 1, 'the hold is released by the batch landing, so the stop is resumed once');
  await runWatch();
  assert.equal(delivered.length, 1);
  assert.equal(lane().filter((e) => e.event === 'lane_stalled').length, 1, 'and the second stop is recorded');
});

/** `act` runs while the session status is being read; the stopped session must then be neither resumed nor stopped */
async function assertNotRecoveredWhenStatusRaces(act, whyNotResumed) {
  setupOpenLane();
  const delivered = runnerWith(async () => { await act(); return stoppedFor30m(); });
  await runWatch();
  assert.equal(delivered.length, 0, whyNotResumed);
  assert.equal(noRecoveryWritten(), true, 'and neither a recovery record nor a stop is written');
}

test('a batch the judge takes while the session status is being read is neither resumed nor stopped', () =>
  assertNotRecoveredWhenStatusRaces(() => holdBatch(heldBatch), 'the hold written during the wait stops the resume'));

test('a question that lands in the ledger while the session status is being read is neither resumed nor stopped', () =>
  assertNotRecoveredWhenStatusRaces(() => appendLifecycle('question_batch_asked', 'IDD-1', { batch_id: 'B1' }), 'the lane waits for an answer by the time the status comes back'));

test('a fix or a send-back queued while the session status is being read keeps the stopped old session from being resumed', () =>
  assertNotRecoveredWhenStatusRaces(() => queueEnvelope('IDD-1', 'review_fix', '<x/>'), 'the fix starts a new session, so the old one is not resumed'));

test('a lane the judge takes a batch of while its resume is being delivered gets no recovery attempt', async () => {
  setupOpenLane();
  setAgentRunner({ deliver: async () => { holdBatch(heldBatch); }, sessionStatus: async () => stoppedFor30m() });
  const r = await runWatch();
  assert.equal(lane().some((e) => e.event === 's2_recovery_attempt'), false, 'the hold came first, so the resume is not recorded after it');
  assert.deepEqual(r.errors, [], 'and the held lane is no error of the watch');
});

test('a resume under way finishes and is recorded before a hold that is waiting on it is made', async () => {
  setupOpenLane();
  let release;
  const gate = new Promise((r) => { release = r; });
  setAgentRunner({ deliver: async () => { await gate; }, sessionStatus: async () => stoppedFor30m() });
  const resumed = runResume('IDD-1', 'r', { unlessHeld: true });
  const order = [];
  const holder = settledResume('IDD-1', 5_000).then(() => { holdBatch(heldBatch); order.push('hold'); });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, [], 'the hold waits while the resume is delivering');
  release();
  assert.equal((await resumed).ok, true);
  await holder;
  assert.deepEqual(order, ['hold']);
  assert.equal(lane().filter((e) => e.event === 's2_recovery_attempt').length, 1, 'the attempt was recorded before the hold was made');
});

test('a resume that finishes while the session status is being read makes that status too old to stop the lane', async () => {
  setupOpenLane();
  const delivered = [];
  let manual = true;
  setAgentRunner({
    deliver: async (id, text, opts) => { delivered.push({ id, type: opts?.type }); },
    sessionStatus: async () => {
      if (manual) { manual = false; await runResume('IDD-1', 'manual'); }
      return stoppedFor30m();
    },
  });
  const r = await runWatch();
  assert.equal(lane().some((e) => e.event === 'lane_stalled'), false, 'the stopped status predates the resume, so no stop is written');
  assert.deepEqual(r.stalled, []);
  assert.equal(delivered.length, 1, 'only the manual resume was delivered; the watch delivers nothing on the old status');
  assert.equal(lane().filter((e) => e.event === 's2_recovery_attempt').length, 1);
});

test('a resume of a lane the judge already holds delivers nothing and records nothing', async () => {
  setupOpenLane();
  const delivered = runnerWith(stoppedFor30m);
  holdBatch(heldBatch);
  const r = await runResume('IDD-1', 'r', { unlessHeld: true });
  assert.equal(r.ok, false);
  assert.equal(delivered.length, 0);
  assert.equal(noRecoveryWritten(), true);
});

// a lane sent back to its plan: the executor's session is still on record, and the planner is the one the lane waits on
const replanned = [['lane_open', 90], ['s1_ready', 80], ['s1_go', 70], ['s2_start', 60], ['s1_replan_requested', 40]];
const withSessions = ({ planner = true, executor = true } = {}) => {
  const state = process.env.IDD_STATE_DIR;
  const row = (kind, id) => JSON.stringify({ idd_id: 'IDD-1', [`${kind}_session_id`]: id, worktree_path: state, branch: 'b', started_at: minutesAgo(100) }) + '\n';
  writeFileSync(join(state, 'executor-sessions.jsonl'), executor ? row('executor', 'S1') : '');
  writeFileSync(join(state, 'planner-sessions.jsonl'), planner ? row('planner', 'P1') : '');
};
const stalls = () => lane().filter((e) => e.event === 'lane_stalled');

test('a lane sent back to its plan has its planner resumed, not the executor whose session is still on record', async () => {
  setup(replanned);
  withSessions();
  const delivered = runnerWith(stoppedFor30m);
  await runWatch();
  assert.deepEqual(delivered.map((d) => [d.id, d.type]), [['P1', 's1_resume']]);
  assert.equal(stalls().length, 0);
});

test('the executor is resumed again once the lane has started its implementation after the return to the plan', async () => {
  setup([...replanned, ['s1_ready', 35], ['s1_go', 30], ['s2_start', 20]]);
  withSessions();
  const delivered = runnerWith(stoppedFor30m);
  await runWatch();
  assert.deepEqual(delivered.map((d) => [d.id, d.type]), [['S1', 's2_resume']]);
});

test('a lane sent back to its plan with no planner session on record is stopped with its role and the reason, once', async () => {
  setup(replanned);
  withSessions({ planner: false });
  const delivered = runnerWith(stoppedFor30m);
  const r = await runWatch();
  await runWatch();
  assert.equal(delivered.length, 0, 'the executor session is not woken in its place');
  assert.equal(stalls().length, 1, 'the stop is written once, not on every tick');
  assert.equal(stalls()[0].attrs.role, 'planner');
  assert.match(String(stalls()[0].attrs.reason), /planner/);
  assert.deepEqual(r.stalled, ['IDD-1']);
  assert.equal(deriveStage(lane()).decision, 'stuck');
});

test('a lane sent back to its plan while another lane\'s session status is being read is not stopped on the lifecycle from before the wait', async () => {
  setupOpenLane();
  const state = process.env.IDD_STATE_DIR;
  const append = (file, row) => writeFileSync(join(state, file), JSON.stringify(row) + '\n', { flag: 'a' });
  append('backlog.jsonl', { idd_id: 'IDD-2', area: 'demo', title: 't2', context: '' });
  append('executor-sessions.jsonl', { idd_id: 'IDD-2', executor_session_id: 'S2', worktree_path: state, branch: 'b', started_at: minutesAgo(100) });
  // the guarded events cannot be written through the write port for a lane set up by hand: the rows go in as they are
  const record = (event, m) => append('lifecycle-demo.jsonl', { idd_id: 'IDD-2', event, at: minutesAgo(m), attrs: {} });
  [['lane_open', 90], ['s1_ready', 80], ['s1_go', 70], ['s2_start', 60]].forEach(([event, m]) => record(event, m));
  let raced = false;
  const delivered = [];
  setAgentRunner({
    deliver: async (id, text, opts) => { delivered.push({ id, type: opts?.type }); },
    sessionStatus: async () => {
      if (!raced) {
        raced = true;
        // IDD-2 goes back to its plan while IDD-1's status is read: its planner session is the one to wake
        append('planner-sessions.jsonl', { idd_id: 'IDD-2', planner_session_id: 'P2', worktree_path: state, branch: 'b', started_at: minutesAgo(100) });
        record('s1_replan_requested', 0);
      }
      return stoppedFor30m();
    },
  });
  const r = await runWatch();
  assert.equal(readLifecycle().some((e) => e.idd_id === 'IDD-2' && e.event === 'lane_stalled'), false, 'the lane is judged on the lifecycle it has at its turn');
  assert.equal(r.stalled.includes('IDD-2'), false);
  assert.deepEqual(delivered.filter((d) => d.id === 'P2').map((d) => d.type), ['s1_resume']);
});

test('an executor the lane waits on with no session on record is stopped with its role', async () => {
  setupOpenLane();
  withSessions({ executor: false });
  runnerWith(stoppedFor30m);
  await runWatch();
  assert.equal(stalls().length, 1);
  assert.equal(stalls()[0].attrs.role, 'executor');
});

test('a lane whose planner has not been started yet is not a stop', async () => {
  setup([['lane_open', 30]]);
  withSessions({ planner: false, executor: false });
  runnerWith(stoppedFor30m);
  await runWatch();
  assert.equal(stalls().length, 0, 'the prep stage starts it');
});

test('a fix still waiting for its new session is a wait, not a stop, even when no executor session is on record', async () => {
  setupOpenLane();
  withSessions({ executor: false });
  runnerWith(stoppedFor30m);
  await queueEnvelope('IDD-1', 'review_fix', '<x/>');
  await runWatch();
  assert.equal(stalls().length, 0);
});

test('a resume the runner refuses is a stop with its reason, written once', async () => {
  setupOpenLane();
  setAgentRunner({ deliver: async () => { throw new Error('session file is gone'); }, sessionStatus: async () => stoppedFor30m() });
  const r = await runWatch();
  await runWatch();
  assert.equal(stalls().length, 1);
  assert.equal(stalls()[0].attrs.role, 'executor');
  assert.match(String(stalls()[0].attrs.reason), /session file is gone/);
  assert.equal(r.errors.length, 1);
  assert.equal(lane().some((e) => e.event === 's2_recovery_attempt'), false, 'a refused resume is no attempt');
});

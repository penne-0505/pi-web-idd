import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';

import { runStallWatch, LANE_STALL_DETECTED, LANE_STALL_INSTRUCTED, LANE_WAIT_NOTIFIED } from '../src/plan/stall-watch.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { deriveStage, laneHalt, laneHeld, withoutNotes } from '../src/ledger/derive.ts';
import { laneTurn, turnSince } from '../src/ledger/turn.ts';
import { applyDecision, queueEnvelope } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { pendingEnvelopes } from '../src/agent/outbox.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
/** an events table as the records deriveStage reads */
const mk = (events) => events.map(([event, m, attrs]) => ({ event, idd_id: 'IDD-1', at: minutesAgo(m), attrs: attrs ?? {} }));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1');

/**
 * A state with one lane, a real git worktree (clean unless a seed dirties it), and the events given. The session
 * is written unless `session: false`; `sessions` can point the executor's worktree elsewhere (a missing directory).
 */
function setup(events, opts = {}) {
  const root = scratchDir('stall-');
  const state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos: {}\n');
  writeFileSync(join(root, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n  stall_watch: { stall_minutes: ${opts.stallMinutes ?? 45}, card_notice_hours: ${opts.cardNoticeHours ?? 4} }\n`);
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml') });
  const wt = join(root, 'wt');
  mkdirSync(wt);
  git(wt, 'init', '-q');
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'init');
  if (opts.dirty) writeFileSync(join(wt, 'left.txt'), 'left\n');
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 't', context: '', created_at: minutesAgo(120) }) + '\n');
  if (opts.session !== false) {
    const path = opts.sessions ?? wt;
    writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'S1', worktree_path: path }) + '\n');
  }
  writeEvents(state, events);
  return { root, state, wt };
}

function writeEvents(state, events) {
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map((e) => JSON.stringify({ idd_id: 'IDD-1', event: e[0], at: minutesAgo(e[1]), attrs: e[2] ?? {} })).join('\n') + '\n');
}

/** the events a loop lane has when its review converged and S3 is ready; the times are relative to `at` */
const atS3Ready = (at) => [
  ['lane_open', at + 10], ['s1_go', at + 9], ['s2_start', at + 8], ['s2_result', at + 7],
  ['s2_review_converged', at + 6], ['s2_device_skipped', at + 5], ['s3_ready', at],
];

function fakeRunner(overrides = {}) {
  const calls = { cwdBusy: [] };
  setAgentRunner({
    deliver: async () => {},
    cwdBusy: (cwd) => { calls.cwdBusy.push(cwd); return false; },
    ...overrides,
  });
  return calls;
}

const envelopes = () => pendingEnvelopes();
const count = (event) => lane().filter((e) => e.event === event).length;

test('a lane the engine owns and does not move is halted after the configured time, and left alone before it', async () => {
  const { state } = setup(atS3Ready(50));
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 1, '50 minutes on the same step is a stop');
  const halt = laneHalt(lane());
  assert.equal(halt.stage, '提出の準備中');
  assert.equal(halt.canSendBack, true);
  assert.match(halt.reason, /engine の番のまま進んでいない/);
  assert.equal(deriveStage(lane()).decision, 'stuck');
  assert.equal(laneTurn(lane()), 'penne');

  // the same records again: the halt holds the lane, so nothing more is written
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 1);

  // a lane on the same step for 10 minutes is not stopped
  const { state: s2 } = setup(atS3Ready(10));
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 0);
});

test('a record added after the stop does not move the clock back', async () => {
  const { state } = setup([...atS3Ready(50), ['s2_order_limit', 1, {}]]);
  assert.equal(deriveStage(mk([...atS3Ready(50), ['s2_order_limit', 1, {}]])).blockedBy, '提出の準備中');
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 1);
  const t = Date.parse(laneHalt(lane()).since);
  assert.ok(Math.abs(t - (Date.now() - 50 * 60_000)) < 5_000, `since is the s3_ready time: ${laneHalt(lane()).since}`);
});

test('an unknown cause halts the lane with the stage failure as its reason', async () => {
  const { state } = setup(atS3Ready(50));
  fakeRunner();
  await runStallWatch({ submitPrep: [{ iddId: 'IDD-1', error: '未 commit の変更があるので archive へ移せません' }] });
  const halt = laneHalt(lane());
  assert.equal(count(LANE_STALL_DETECTED), 1);
  assert.match(halt.reason, /archive へ移せません/);
  assert.equal(halt.causes.length, 0);
});

test('a dirty worktree gets one instruction, the worktree is left as it is, and the same cause halts the second time', async () => {
  const { state, wt } = setup(atS3Ready(50), { dirty: true });
  fakeRunner();
  const before = git(wt, 'status', '--porcelain', '--untracked-files=all');
  await runStallWatch({ submitPrep: [{ iddId: 'IDD-1', error: '未 commit の変更があるので archive へ移せません' }] });
  assert.equal(count(LANE_STALL_INSTRUCTED), 1);
  assert.equal(count('s4_verify_user_judgment_answered'), 1);
  const sent = envelopes().filter((e) => e.idd_id === 'IDD-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'lane_rejected');
  const body = readFileSync(join(state, 'outbox', `${sent[0].envelope_id}.xml`), 'utf8');
  assert.match(body, /未 commit の変更/);
  assert.match(body, /確かめずに消さない/);
  assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=all'), before, 'the engine does not touch the worktree');

  // called again on the same records: the queued envelope makes the lane the agent's turn, so nothing more is written
  await runStallWatch({});
  assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, 1, 'one envelope');
});

test('the same cause after an instruction halts instead of instructing again', async () => {
  // the cause is already instructed and no envelope is pending: the lane is the engine's again
  setup([...atS3Ready(100), [LANE_STALL_INSTRUCTED, 90, { causes: ['dirty'] }]], { dirty: true });
  fakeRunner();
  const res = await runStallWatch({});
  assert.deepEqual(res.instructed, [], 'no second instruction');
  assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, 0);
  assert.equal(count(LANE_STALL_DETECTED), 1);
  assert.match(laneHalt(lane()).reason, /未 commit の変更.*指示済み/);
});

test('a conflict and a dirty worktree together get one instruction that names both', async () => {
  const { state } = setup([...atS3Ready(50), ['s3_check_conflict', 49, { conflict_files: ['src/a.ts'] }]], { dirty: true });
  fakeRunner();
  await runStallWatch({});
  assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, 1);
  assert.equal(envelopes()[0].skip_fix_plan, undefined, 'a message that names more than the conflict does not skip the plan');
  const body = readFileSync(join(state, 'outbox', `${envelopes()[0].envelope_id}.xml`), 'utf8');
  assert.match(body, /未 commit の変更/);
  assert.match(body, /merge/);
  assert.match(body, /src\/a\.ts/);
  assert.match(body, /rebase は使わない/);
});

test('a conflict alone gets the merge instruction', async () => {
  const { state } = setup([...atS3Ready(50), ['s3_check_conflict', 49, { conflict_files: ['x.ts', 'y.ts'] }]]);
  fakeRunner();
  await runStallWatch({});
  assert.equal(envelopes()[0].skip_fix_plan, true, 'a conflict-only instruction skips the plan');
  const body = readFileSync(join(state, 'outbox', `${envelopes()[0].envelope_id}.xml`), 'utf8');
  assert.match(body, /x\.ts, y\.ts/);
});

test('a ship card whose past R2 record stopped on the record check is neither instructed nor raised: R2 was removed (2026-10-22)', async () => {
  for (const session of [true, false]) {
    setup([
      ['lane_open', 20], ['s1_go', 19], ['s2_start', 18], ['s2_result', 17],
      ['s2_review_converged', 16], ['s2_device_skipped', 15], ['s3_ready', 14],
      ['s3_r2_started', 13, { run_id: 'r' }], ['s3_r2_done', 12, { run_id: 'r', must: 0, should: 0 }],
      ['s3_r2_not_recorded', 11, { run_id: 'r', reason: '記録の検査が通らないので commit していません', detail: 'docs: DEC-1 が無い' }],
      ['s3_ok', 10, { at_by: 'auto' }], ['s4_submit_started', 9],
    ], { session });
    fakeRunner();
    const res = await runStallWatch({});
    assert.deepEqual(res.instructed, [], `session ${session}`);
    assert.equal(count(LANE_STALL_INSTRUCTED), 0, `session ${session}`);
    assert.equal(count(LANE_STALL_DETECTED), 0, `session ${session}: the card is penne's turn, not a stop`);
    assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, 0, `session ${session}`);
  }
});

/** penne resumes the stopped lane: the halt and the hold are gone */
async function resumeLane() {
  assert.equal((await applyDecision('lane_stall_resume', { iddId: 'IDD-1' })).ok, true);
  assert.equal(laneHalt(lane()), null);
  assert.equal(laneHeld(lane()), false);
}

test('penne resume clears the halt, and a fresh stop after it is instructed again', async () => {
  const { state } = setup(atS3Ready(50));
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 1);
  assert.ok(laneHalt(lane()));
  assert.ok(laneHeld(lane()));
  await resumeLane();

  // a lane stopped again after a resume 50 minutes ago: the clock runs from the resume, and the cause is instructed again
  setup([...atS3Ready(110), ['lane_stall_resumed', 50]], { dirty: true });
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_INSTRUCTED), 1);
  assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, 1);
});

test('a card that waited long enough is noticed once; a younger one is not; a new card is counted apart', async () => {
  // a GO card 5 hours old
  const goEvents = [['lane_open', 310], ['s1_ready', 300], ['s1_plan_review_done', 300, { must: 0, should: 0 }]];
  const { state } = setup(goEvents);
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_WAIT_NOTIFIED), 1);
  await runStallWatch({});
  assert.equal(count(LANE_WAIT_NOTIFIED), 1, 'the same card is noticed once');

  // a GO card one hour old
  const { state: s2 } = setup([['lane_open', 70], ['s1_ready', 60], ['s1_plan_review_done', 60, { must: 0, should: 0 }]]);
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_WAIT_NOTIFIED), 0);

  // a new card after the plan was sent back: the notice of the earlier card does not cover it
  const { state: s3 } = setup([
    ['lane_open', 600], ['s1_ready', 600], ['s1_plan_review_done', 600, { must: 0, should: 0 }],
    [LANE_WAIT_NOTIFIED, 550, { decision: 'go', since: minutesAgo(600) }],
    ['s1_revise_requested', 540], ['s1_ready', 520], ['s1_plan_review_done', 500, { must: 0, should: 0 }],
  ]);
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_WAIT_NOTIFIED), 2, 'the new card has its own notice');
});

test('a lane waiting on an answer is not stopped, and its question card is noticed once (AC-011)', async () => {
  // executor asked 5 hours ago and penne has not answered
  const asked = [['lane_open', 320], ['s1_go', 319], ['s2_start', 318], ['question_batch_asked', 300, { batch_id: 'b1' }]];
  const { state } = setup(asked);
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 0, 'a question wait is not a stop');
  assert.equal(count(LANE_STALL_INSTRUCTED), 0, 'no instruction is sent');
  assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, 0, 'nothing is queued');
  assert.equal(count(LANE_WAIT_NOTIFIED), 1, 'the question card is noticed once');
  const notice = lane().filter((e) => e.event === LANE_WAIT_NOTIFIED).pop();
  assert.equal(notice.attrs.question, true);
  assert.ok(Math.abs(Date.parse(notice.attrs.since) - (Date.now() - 300 * 60_000)) < 5_000, 'the notice is counted from the question');
  await runStallWatch({});
  assert.equal(count(LANE_WAIT_NOTIFIED), 1, 'once only');

  // an answer hands the lane back: the same records plus the answer stop being a wait
  const answered = [...asked, ['question_batch_answered', 290, { batch_id: 'b1' }]];
  setup(answered);
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_WAIT_NOTIFIED), 0, 'an answered question is not a card');
});

test('a lane that is working or waiting is not stopped, even after hours', async () => {
  const cases = [
    ['executor result wait', [['lane_open', 200], ['s1_go', 199], ['s2_start', 198]], {}],
    ['blind run', [['lane_open', 200], ['s1_go', 199], ['s2_start', 198], ['s2_result', 197], ['s2_review_started', 196, { kind: 'blind', round: 1, run_ids: ['b'] }]], {}],
    ['order wait', [['lane_open', 200], ['s1_go', 199], ['s2_start', 198], ['s2_result', 197], ['s2_order_waiting', 196, { opponents: [] }]], {}],
    ['slot wait', atS3Ready(200), { ctx: { slotWaits: [{ slot: 'executor', cap: 1, running: 1, lanes: [{ id: 'IDD-1', since: minutesAgo(200), waitedMinutes: 200 }] }] } }],
    ['slot just freed', atS3Ready(200), { ctx: { slotWaits: [{ slot: 'review_blind', cap: 3, running: 2, lanes: [], next: ['IDD-1'] }] } }],
    ['claude quota wait', [...atS3Ready(200), ['claude_quota_wait', 199, { stage: 'r2', reason: 'windows' }]], {}],
    ['ship card penne holds', [...atS3Ready(200), ['s3_ok', 199, { at_by: 'auto' }], ['s4_submit_started', 198]], {}],
    ['worktree busy', atS3Ready(200), { cwdBusy: () => true }],
    ['pending envelope', [['lane_open', 200], ['s1_go', 199], ['s2_start', 198]], { envelope: true }],
    ['no runner', atS3Ready(200), { runner: null }],
  ];
  for (const [label, events, opts] of cases) {
    setup(events);
    if (opts.envelope) await queueEnvelope('IDD-1', 'info_update', '<x/>');
    if (opts.runner === null) setAgentRunner(null);
    else fakeRunner(opts.cwdBusy ? { cwdBusy: opts.cwdBusy } : {});
    await runStallWatch(opts.ctx ?? {});
    assert.equal(count(LANE_STALL_DETECTED), 0, `${label}: no halt`);
    assert.equal(count(LANE_STALL_INSTRUCTED), 0, `${label}: no instruction`);
    assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, opts.envelope ? 1 : 0, `${label}: no envelope`);
  }
  setAgentRunner(null);
});

test('a lane without a readable worktree or without a session still gets its card, and no session is asked about', async () => {
  for (const opts of [{}, { session: false }, { sessions: join(scratchDir('gone-'), 'does-not-exist') }]) {
    const { state } = setup(atS3Ready(50), opts);
    const calls = fakeRunner();
    await runStallWatch({});
    assert.equal(count(LANE_STALL_DETECTED), 1, JSON.stringify(opts));
    assert.equal(calls.cwdBusy.length, opts.session === false || opts.sessions !== undefined ? 0 : 1, 'a session is only asked about when there is a directory to check');
    assert.equal(laneHalt(lane()).canSendBack, opts.session !== false);
  }
});

test('turning the setting to 0 stops the detection and the notice', async () => {
  const { state } = setup([...atS3Ready(500)]);
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 1);
  const { state: s2 } = setup(atS3Ready(500), { stallMinutes: 0, cardNoticeHours: 0 });
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 0);
  assert.equal(count(LANE_WAIT_NOTIFIED), 0);
  // a GO card, too
  const { state: s3 } = setup([['lane_open', 500], ['s1_ready', 500], ['s1_plan_review_done', 500, { must: 0, should: 0 }]], { stallMinutes: 0, cardNoticeHours: 0 });
  fakeRunner();
  await runStallWatch({});
  assert.equal(count(LANE_WAIT_NOTIFIED), 0);
});

test('the notice record moves neither the stage, nor the turn, nor the review loop', async () => {
  const base = mk(atS3Ready(50));
  const notified = mk([...atS3Ready(50), [LANE_WAIT_NOTIFIED, 1, { decision: 'ship', since: minutesAgo(50) }]]);
  assert.deepEqual(deriveStage(notified), deriveStage(base));
  assert.equal(laneTurn(notified), laneTurn(base));
  assert.deepEqual(reviewLoopState(notified), reviewLoopState(base));
  // a quota wait stays the wait it was
  const quota = [...atS3Ready(50), ['claude_quota_wait', 40, { stage: 'r2', reason: 'windows' }]];
  assert.match(deriveStage(mk([...quota, [LANE_WAIT_NOTIFIED, 1, {}]])).blockedBy, /Claude の枠待ち/);
});

// ---- IDD-133: the windows observation decides whether a waited lane is a stop ----

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const waited = (resetsAt) => [...atS3Ready(200), ['claude_quota_wait', 199, { stage: 'r2', reason: 'windows', ...(resetsAt === undefined ? {} : { resets_at: resetsAt }) }]];

test('the observation decides whether a waited lane is a stop (AC-005)', async () => {
  setup(waited(FUTURE));
  fakeRunner({ quotaBlock: () => ({ reason: 'windows', resetsAt: FUTURE }) });
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 0, 'the windows hold it, so it is not a stop');
  setup(waited(FUTURE));
  fakeRunner({ quotaBlock: () => null });
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 1, 'the windows let it start, so the engine\'s step is a stop');
  setAgentRunner(null);
});

test('an unreadable observation leaves the record\'s own reset to the stall watch too (AC-006)', async () => {
  const runners = [{}, { quotaBlock: () => { throw new Error('観測を読めない'); } }];
  for (const overrides of runners) {
    setup(waited(FUTURE));
    fakeRunner(overrides);
    await runStallWatch({});
    assert.equal(count(LANE_STALL_DETECTED), 0, 'a reset ahead holds');
    setup(waited(1));
    fakeRunner(overrides);
    await runStallWatch({});
    assert.equal(count(LANE_STALL_DETECTED), 1, 'a reset past does not hold');
    setup(waited());
    fakeRunner(overrides);
    await runStallWatch({});
    assert.equal(count(LANE_STALL_DETECTED), 0, 'no reset holds');
  }
  setAgentRunner(null);
});

test('AC-006: a lane waiting at prep is not stopped while a replacement is on its way, and is after it', async () => {
  // a prep lane the engine owns and does not move: its planner is not awake, and the plan review has not started
  setup([['lane_open', 200], ['s1_ready', 199]], { session: false });
  fakeRunner();
  await runStallWatch({ reloadHold: 'engine を入れ替えています' });
  assert.equal(count(LANE_STALL_DETECTED), 0, 'held: no stop record');
  assert.equal(count(LANE_STALL_INSTRUCTED), 0, 'held: no instruction');
  assert.equal(envelopes().filter((e) => e.idd_id === 'IDD-1').length, 0, 'held: no envelope');
  // the hold is over and the planner still has not started: it is counted as before
  await runStallWatch({});
  assert.equal(count(LANE_STALL_DETECTED), 1, 'after the hold it is a real stop');
  setAgentRunner(null);
});

// ---- IDD-258: the executor's wait is not counted by the stall clock ----

/** the stops a pass over `ledger` writes; the lane is set up fresh, with the runner's overrides and the setup's options */
async function stopsOf(ledger, overrides = {}, opts = {}) {
  setup(ledger, opts);
  fakeRunner(overrides);
  await runStallWatch({});
  return count(LANE_STALL_DETECTED);
}
const sinceOf = () => Date.parse(laneHalt(lane()).since);
const near = (t, m) => Math.abs(t - (Date.now() - m * 60_000)) < 5_000;

/** a pass over `ledger` writes `stops` stops; a stop's clock starts `sinceMin` minutes ago, and no stop leaves no halt */
async function expectClock(ledger, { stops, sinceMin }, label) {
  assert.equal(await stopsOf(ledger), stops, label);
  if (stops) assert.ok(near(sinceOf(), sinceMin), `${label}: since starts ${sinceMin} minutes ago: ${laneHalt(lane()).since}`);
  else assert.equal(laneHalt(lane()), null, label);
}

/** the end record (or any record that only joins the step) moves neither the turn, the step nor the review state */
function expectNoMove(withEnd, base) {
  assert.equal(laneTurn(mk(withEnd), {}), laneTurn(mk(base), {}), 'it moves no turn');
  assert.deepEqual(deriveStage(mk(withEnd)), deriveStage(mk(base)), 'nor the step');
  assert.deepEqual(reviewLoopState(mk(withEnd)), reviewLoopState(mk(base)), 'nor the review state');
}

/** a lane at its first review, with a second result that came while the executor's conversation went on */
const afterSecondResult = (resultAt, extra = []) => [
  ['lane_open', 130], ['s1_go', 129], ['s2_start', 128], ['s2_result', 120],
  ['s2_executor_waiting', 119, { reason: '実装役の会話が応答中', head: 'a' }],
  ...extra,
  ['s2_result', resultAt],
];
const stillMoving = (m) => ['s2_executor_waiting', m, { reason: '実装役の head がまだ動いている', head: 'b' }];

test('a result that reaches the engine after a long executor wait is not a stop in the next pass (IDD-258)', async () => {
  // the first result is 120 minutes old; the conversation answered until the second result 1 minute ago
  await expectClock(afterSecondResult(1), { stops: 0 }, 'the clock does not run over the executor\'s answering');
  assert.equal(count(LANE_STALL_INSTRUCTED), 0);
});

test('a result that is the last executor record moves the clock on, and 45 minutes after it is a stop as before (IDD-258)', async () => {
  await expectClock(afterSecondResult(40, [stillMoving(55)]), { stops: 0 }, '40 minutes after the last result');
  await expectClock(afterSecondResult(50, [stillMoving(55)]), { stops: 1, sinceMin: 50 }, '50 minutes after the last executor record');
});

/**
 * a lane whose only result is 120 minutes old and whose executor was waited on from 100 minutes ago; after a map, the
 * step begins at the finished map and the wait is written inside that step
 */
const stepWith = (map) => (tail) => [
  ['lane_open', 130], ['s1_go', 129], ['s2_start', 128], ['s2_result', 120],
  ...(map ? [['s2_map_started', 110, { round: 1 }], ['s2_map_done', 100, { round: 1 }]] : []),
  ['s2_executor_waiting', map ? 99 : 100, { reason: '実装役の会話が応答中', head: 'a' }],
  ...tail,
];
const waitThen = stepWith(false);
const afterMap = stepWith(true);
const ended = (m) => ['s2_executor_wait_ended', m, { head: 'a' }];
// the records that can follow a wait's end within the same step; none of them starts the clock, whatever the kind
const merged = (m, by = 'harness') => ['s2_review_base_merged', m, { by }];
const accessories = {
  'a mainline merge by the harness': (m) => merged(m),
  'a mainline merge by the executor': (m) => merged(m, 'executor'),
  'a failed review start': (m) => ['s2_review_run_failed', m, { state: 'start', error: 'x' }],
  'a finished map': (m) => ['s2_map_done', m, { round: 1 }],
  'a base that moved': (m) => ['s2_review_base_advanced', m, { round: 1 }],
};
const show = (tail) => tail.map((e) => `${e[0]} ${e[1]}`).join(', ');

// name, the tails that are not a stop, the tail that is, and where the stop's clock starts (minutes ago)
const clockRows = [
  ['a wait that ended just now, or 30 minutes ago, is not a stop though it began over 45 minutes ago; 50 minutes after the end is, from the end', [[ended(1)], [ended(30)]], [ended(50)], 50],
  ['a wait that has no end yet is counted from its own time, so a lane the end could not be written for is not left silent', [[stillMoving(30)]], [stillMoving(50)], 50],
  ['a wait that ended is not where the clock starts, whatever time it began', [], [stillMoving(50), ended(49)], 49],
  ['a mainline merge after a wait that has no end counts from the wait', [[stillMoving(30), merged(29)]], [stillMoving(50), merged(49)], 50],
  ...Object.entries(accessories).map(([name, rec]) => [`${name} after a wait's end leaves the clock at the end`, [[ended(1), rec(0)]], [ended(50), rec(49)], 50]),
];

test('a finished map is the first row of the step the wait is written in (IDD-258)', () => {
  const rows = mk(afterMap([ended(50)]));
  assert.equal(turnSince(rows, {}), rows.find((r) => r.event === 's2_map_done').at, 'the step begins at the map\'s end');
});

// every row for the plain step; the first two again for a step that a finished map begins
const stepRows = [
  ...clockRows.map((row) => [waitThen, ...row]),
  ...clockRows.slice(0, 2).map(([name, ...row]) => [afterMap, `in a step a finished map begins, ${name}`, ...row]),
];
for (const [build, name, calm, stop, sinceMin] of stepRows) {
  test(`${name} (IDD-258)`, async () => {
    for (const tail of calm) await expectClock(build(tail), { stops: 0 }, `the wait is not counted: ${show(tail)}`);
    await expectClock(build(stop), { stops: 1, sinceMin }, `a stop: ${show(stop)}`);
  });
}

for (const [name, rec] of Object.entries(accessories)) {
  test(`${name} leaves the step and its start where they were (IDD-258)`, () => {
    // the rows above hold only for records that leave the step and its start where they were
    const rows = mk(waitThen([ended(50), rec(49)]));
    assert.deepEqual(deriveStage(rows), deriveStage(rows.slice(0, -1)), `${name} leaves the step`);
    assert.equal(turnSince(rows, {}), turnSince(rows.slice(0, -1), {}), `${name} leaves the step's start`);
  });
}

test('a result added late to a lane that has gone on to S3 does not restart its clock (IDD-258)', async () => {
  const ledger = [...atS3Ready(50), ['s2_result', 1]];
  assert.equal(deriveStage(mk(ledger)).blockedBy, '提出の準備中', 'the late result leaves the step at S3');
  await expectClock(ledger, { stops: 1, sinceMin: 50 }, 'the S3 step has stood 50 minutes');
  // the wait marks of the executor's step do not start an S3 clock either
  await expectClock([...atS3Ready(50), ['s2_executor_waiting', 3, { reason: '実装役の会話が応答中', head: 'a' }], ended(2)], { stops: 1, sinceMin: 50 }, 'the wait marks');
});

test('a result added late after a record that is not the executor\'s does not move the clock back from the wait\'s end (IDD-258)', async () => {
  // result, wait, its end, a mainline merge, then a late result: the stop counts from the end, not from the late result
  await expectClock(waitThen([ended(50), merged(49), ['s2_result', 1]]), { stops: 1, sinceMin: 50 }, 'the late result after a merge');
  // a result that came inside the wait, with only notes between, still moves the clock on
  await expectClock(waitThen([stillMoving(60), ['s2_result', 1]]), { stops: 0 }, 'a result that came during the wait');
  await expectClock(waitThen([ended(50), ['s2_result', 40]]), { stops: 0 }, 'a result right after the end');
});

test('the end record moves neither the turn, the step nor the review state (IDD-258)', () => {
  const ledger = waitThen([ended(60)]);
  expectNoMove(ledger, ledger.slice(0, -1));
});

test('a stop after the executor\'s wait still gets its instruction or its card, and a resume lets the lane go on (IDD-258)', async () => {
  await stopsOf(afterSecondResult(50), {}, { dirty: true });
  assert.equal(count(LANE_STALL_INSTRUCTED), 1, 'a known cause is instructed');
  assert.equal(await stopsOf(afterSecondResult(50)), 1, 'an unknown cause is a card');
  assert.ok(laneHeld(lane()));
  await resumeLane();
});

test('a wait end written after a Claude quota wait does not take the wait\'s place, so the lane is held and not a stop (IDD-258)', async () => {
  const ledger = [...waited(FUTURE), ended(5)];
  assert.equal(withoutNotes(mk(ledger)).at(-1).event, 'claude_quota_wait', 'the end is read past, as a note');
  expectNoMove(ledger, waited(FUTURE));
  for (const overrides of [{ quotaBlock: () => ({ reason: 'windows', resetsAt: FUTURE }) }, {}]) {
    assert.equal(await stopsOf(ledger, overrides), 0, 'the quota wait still holds the lane');
  }
  setAgentRunner(null);
});

test('a result added late in the middle of a review does not restart the clock of the step it joins (IDD-258)', async () => {
  const base = [['lane_open', 130], ['s1_go', 129], ['s2_start', 128], ['s2_result', 120], ['s2_review_started', 100, { round: 1 }], ['s2_review_findings', 90, { round: 1 }]];
  const late = [...base, ['s2_result', 1]];
  assert.equal(laneTurn(mk(late), {}), 'engine', 'the triage step is the engine\'s');
  const rows = mk(late);
  assert.equal(turnSince(rows, {}), turnSince(rows.slice(0, -1), {}), 'the late result leaves the step\'s own clock where it was');
  await expectClock(late, { stops: 1, sinceMin: 90 }, 'the step stood 90 minutes');
});

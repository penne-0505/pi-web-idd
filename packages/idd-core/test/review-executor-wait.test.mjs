import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop, setRecordsCheckRunner } from '../src/plan/review-loop.ts';
import { runStallWatch, LANE_STALL_DETECTED } from '../src/plan/stall-watch.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { laneTurn, turnSince } from '../src/ledger/turn.ts';
import { tmpDir } from './helpers/tmp.mjs';

// Issue #159: a review stage the executor's result began has to read a head the executor stopped on. The executor
// often commits minutes after its first report (IDD-153), so the stage waits for the conversation to stop answering
// and for the head to hold still. The wait is the repo's `review_loop.executor_still_seconds`; tests here turn it on
// and move the head and the report's own time to make one tick long enough.

const OLD = '2026-01-01T00:00:00+09:00';
const OLD2 = '2026-01-02T00:00:00+09:00';
const NOW = () => new Date().toISOString();
const WAIT = 's2_executor_waiting';
const WAIT_END = 's2_executor_wait_ended';
const ROUTES = [{ id: 'R-1', paths: ['lib/a.dart'], question: '見せている値と送る値が同じ', harms: ['shown_vs_sent'] }];

const PLAIN = '  review_blind: { roles: [r, r] }\n  triage: { role: r }\n  confirm: { role: r }\n  review_loop: { executor_still_seconds: 90 }\n';
const MAPPED = '  review_blind: { roles: [r] }\n  risk_map: { role: r }\n  triage: { role: r }\n  confirm: { role: r }\n  review_loop: { executor_still_seconds: 90 }\n';

// a test of this file points the process at its own state; none of that may outlive the test, or the next file that
// runs in the same process reads a ledger and a repo list that are gone
const envBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('IDD_')));
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('IDD_') && !(k in envBefore)) delete process.env[k];
  Object.assign(process.env, envBefore);
  setRecordsCheckRunner(null);
  setAgentRunner(null);
});

const ev = (event, attrs = {}, at = OLD) => ({ event, idd_id: 'IDD-001', at, attrs });

/** a commit whose committer time the wait reads (an old one is a head that has stopped moving) */
function commitFile(wt, name, iso) {
  writeFileSync(join(wt, name), `${iso}-${Math.random()}`);
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'x'], { env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
}

/** move the last commit's own time: the same head, made to look like it stopped moving long ago */
function amendDate(wt, iso) {
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--amend', '--no-edit'], { env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
}

const headOf = (wt) => execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

function putLifecycle(state, entries) {
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const readRows = (state) => readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const appendRows = (state, ...rows) => putLifecycle(state, [...readRows(state), ...rows]);

/** put every `s2_result` on record at the given time: the wait's clock reads the newest one */
function setResultAt(state, iso) {
  const lines = readRows(state);
  for (const line of lines) if (line.event === 's2_result') line.at = iso;
  putLifecycle(state, lines);
}

/** a lane whose first fix was sent and answered with a result that is `NOW()` old: the confirm is the next stage */
const fixAnswered = (f) => [
  ev('s1_go'), ev('s2_start', { started_from_commit: f.head }), ev('s2_result'),
  ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }),
  ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
  ev('s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }),
  ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'x' }] }),
  ev('s2_fix_sent', { round: 1, refs: ['F-1'] }),
  ev('s2_result', { outcome: 'success' }, NOW()),
];

function setup({ pipeline = PLAIN, resultAt = OLD, headIso = OLD } = {}) {
  const state = tmpDir('idd-exwait-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipeline}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-exwait-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'], { env: { ...process.env, GIT_AUTHOR_DATE: headIso, GIT_COMMITTER_DATE: headIso } });
  const head = headOf(wt);
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: OLD, linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  putLifecycle(state, [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' }, resultAt)]);
  return { state, wt, head };
}

/** a fake runner whose conversation-busy answer the test moves, and whose map answers with the routes */
function fakeRunner({ cwdBusy = true, busy = false } = {}) {
  const state = { busy, absent: !cwdBusy, failStart: false };
  const calls = [];
  const status = {};
  const runner = {
    deliver: async () => {},
    startReviewRun: async (o) => {
      if (state.failStart) throw new Error('start failed');
      calls.push(o);
      const n = o.stage === 'blind' ? (o.routes?.length ?? 0) + 1 : 1;
      const ids = Array.from({ length: n }, (_, i) => `${o.stage}-${calls.length}-${i}`);
      for (const id of ids) status[id] = { state: 'running' };
      if (!o.routes?.length) return { runIds: ids };
      const labels = [...o.routes.map((_, i) => `r${i + 1}`), 'rest'];
      return { runIds: ids, runLabels: labels, wholeDiff: [ids[ids.length - 1]], routeCount: o.routes.length, routesOverCap: false };
    },
    reviewRunStatus: (id) => status[id],
  };
  if (cwdBusy) runner.cwdBusy = () => state.busy;
  setAgentRunner(runner);
  return { calls, status, state };
}

const events = () => readLifecycle();
const names = () => events().map((e) => e.event);

/** a record that only joins the step moves neither the step, the turn, the turn clock nor the review state */
function expectNoMove(withEnd, base) {
  assert.deepEqual(deriveStage(withEnd), deriveStage(base));
  assert.equal(laneTurn(withEnd), laneTurn(base));
  assert.equal(turnSince(withEnd), turnSince(base));
  assert.deepEqual(reviewLoopState(withEnd), reviewLoopState(base));
}

test('AC-001: the blind does not start while the executor conversation is answering', async () => {
  setup();
  const r = fakeRunner({ busy: true });
  await runReviewLoop();
  assert.equal(names().includes('s2_review_started'), false);
  assert.equal(events().at(-1).event, WAIT);
  assert.equal(events().at(-1).attrs.reason, '実装役の会話が応答中');
  assert.deepEqual(r.calls, []);
  // the answer stops: the stage starts on the next tick
  r.state.busy = false;
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_review_started');
  setAgentRunner(null);
});

test('IDD-258: the first look that finds the executor stopped after a wait records its end, once', async () => {
  setup();
  const r = fakeRunner({ busy: true });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(events().filter((e) => e.event === WAIT).length, 1, 'a wait held across ticks is one mark');
  assert.equal(names().includes(WAIT_END), false, 'no end while the conversation answers');
  r.state.busy = false;
  await runReviewLoop();
  const ends = events().filter((e) => e.event === WAIT_END);
  assert.equal(ends.length, 1, 'the end is written when the executor is first seen stopped');
  assert.ok(names().indexOf(WAIT_END) > names().indexOf(WAIT));
  assert.equal(ends[0].attrs.head, events().find((e) => e.event === WAIT).attrs.head);
  await runReviewLoop();
  assert.equal(events().filter((e) => e.event === WAIT_END).length, 1, 'a later pass does not write it again');
  setAgentRunner(null);
});

test('IDD-258: a lane with no wait on record gets no end', async () => {
  setup();
  fakeRunner({ busy: false });
  await runReviewLoop();
  assert.equal(names().includes(WAIT_END), false);
  setAgentRunner(null);
});

test('IDD-258: a wait that follows an end is marked again, so the end is not the last word on a working lane', async () => {
  const f = setup();
  const r = fakeRunner({ busy: true });
  await runReviewLoop();
  r.state.busy = false;
  // the end is on record; the lane is held again before the stage starts (a new report), the same reason and head
  const base = readRows(f.state);
  base.at(-1).at = OLD2;
  putLifecycle(f.state, [...base, ev(WAIT_END, { head: base.at(-1).attrs.head }, '2026-01-03T00:00:00+09:00')]);
  r.state.busy = true;
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  assert.equal(events().filter((e) => e.event === WAIT).length, 2);
  setAgentRunner(null);
});

test('IDD-258: the end record moves neither the lane\'s turn, step, review state nor the turn clock', async () => {
  setup();
  fakeRunner({ busy: true });
  await runReviewLoop();
  const before = readLifecycle();
  // write only the end, without the stage that starts the review after it
  expectNoMove([...before, ev(WAIT_END, { head: before.at(-1).attrs.head }, new Date(Date.now() + 1000).toISOString())], before);
  setAgentRunner(null);
});

test('IDD-258: an end that lands after a Claude quota wait moves neither the turn, step nor review state', async () => {
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const base = [
    ev('lane_open', {}, at(400)), ev('s1_go', {}, at(399)), ev('s2_start', {}, at(398)), ev('s2_result', {}, at(397)),
    ev('s2_review_converged', {}, at(396)), ev('s2_device_skipped', {}, at(395)), ev('s3_ready', {}, at(300)),
    ev('claude_quota_wait', { stage: 'r2', reason: 'windows', resets_at: Math.floor(Date.now() / 1000) + 3600 }, at(299)),
  ];
  expectNoMove([...base, ev(WAIT_END, { head: 'a' }, at(10))], base);
});

test('AC-001: a runtime that cannot tell whether the conversation answers waits on the head alone', async () => {
  const f = setup({ headIso: OLD, resultAt: NOW() });
  const r = fakeRunner({ cwdBusy: false });
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  assert.equal(events().at(-1).attrs.reason, '実装役の head がまだ動いている');
  assert.deepEqual(r.calls, []);
  // an old report means the clock ran out even with no answer to the busy question
  setResultAt(f.state, OLD);
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_review_started');
  setAgentRunner(null);
});

test('AC-002: the stage does not start until the head has held still', async () => {
  const f = setup({ headIso: OLD, resultAt: NOW() });
  fakeRunner({ busy: false });
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  // the report's own time moves to the past: the wait is over and the stage starts
  setResultAt(f.state, OLD);
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_review_started');
  setAgentRunner(null);
});

test('AC-002: a new commit while waiting starts the wait over', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  fakeRunner({ busy: false });
  commitFile(f.wt, 'lane.txt', NOW());
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  assert.equal(events().at(-1).attrs.reason, '実装役の head がまだ動いている');
  // the head is the same commit with an old time: the clock ran out
  amendDate(f.wt, OLD2);
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_review_started');
  setAgentRunner(null);
});

test('AC-002: a fresh result while waiting starts the wait over', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  const r = fakeRunner({ busy: true });
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  // the executor reports again and then stops answering: the new report restarts the clock
  appendRows(f.state, ev('s2_result', { outcome: 'success' }, NOW()));
  r.state.busy = false;
  await runReviewLoop();
  assert.equal(names().includes('s2_review_started'), false);
  assert.equal(events().at(-1).event, WAIT);
  assert.equal(events().at(-1).attrs.reason, '実装役の head がまだ動いている');
  setAgentRunner(null);
});

test('AC-002: the harness\'s own pre-review merge does not start the wait over', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  // the head is a fresh commit, but the harness's record says it made it from the lane's old head
  commitFile(f.wt, 'merged.txt', NOW());
  const merged = headOf(f.wt);
  appendRows(f.state, ev('s2_review_base_merged', { by: 'harness', head: f.head, merge_commit: merged, review_base: f.head }, NOW()));
  fakeRunner({ busy: false });
  await runReviewLoop();
  // reading the harness's own commit would have held the stage; the lane's old head does not
  assert.equal(events().at(-1).event, 's2_review_started');
  setAgentRunner(null);
});

test('AC-003: the confirm a fix\'s result began goes through the same wait', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  putLifecycle(f.state, fixAnswered(f));
  fakeRunner({ busy: false });
  await runReviewLoop();
  assert.equal(names().includes('s2_confirm_started'), false);
  assert.equal(events().at(-1).event, WAIT);
  setResultAt(f.state, OLD);
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_confirm_started');
  setAgentRunner(null);
});

test('AC-003: the blind after a fix in a depth-bearing pass goes through the same wait', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  putLifecycle(f.state, [
    ev('s1_go'), ev('s2_start', { started_from_commit: f.head }), ev('s2_result'),
    // the round read the head before the fix; the fix moved it to the head the worktree is at now
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'], head: 'head-before-the-fix', depth: 'deep', max_fix_rounds: 3, close_on: 'must' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'x' }] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1'] }),
    ev('s2_result', { outcome: 'success' }, NOW()),
  ]);
  fakeRunner({ busy: false });
  await runReviewLoop();
  assert.equal(names().at(-1), WAIT);
  setResultAt(f.state, OLD);
  await runReviewLoop();
  assert.equal(names().at(-1), 's2_review_started');
  assert.equal(events().at(-1).attrs.kind, 'blind');
  setAgentRunner(null);
});

test('AC-004: routes drawn at a head the lane has left are dropped and drawn again', async () => {
  const f = setup({ pipeline: MAPPED, headIso: OLD, resultAt: OLD });
  const r = fakeRunner({ busy: false });
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_map_started');
  assert.equal(events().at(-1).attrs.head, f.head, 'the map records the head it draws the routes at');
  r.status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_map_done');
  assert.equal(events().at(-1).attrs.head, f.head, 'the map carries its head to the blind');
  // the head moves before the blind reads the routes
  commitFile(f.wt, 'lane.txt', OLD2);
  const moved = headOf(f.wt);
  await runReviewLoop();
  const drop = events().at(-1);
  assert.equal(drop.event, 's2_map_head_moved');
  assert.equal(drop.attrs.map_head, f.head, 'the record names the head the routes were drawn at');
  assert.equal(drop.attrs.head, moved, 'and the head the lane is at');
  assert.deepEqual(reviewLoopState(events()), { state: 'start_blind', kind: 'blind', round: 1 }, 'the round waits for a fresh map');
  assert.equal(r.calls.filter((c) => c.stage === 'blind').length, 0, 'the stale routes never reach a blind');
  // the map is drawn again, at the new head
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_map_started');
  assert.equal(events().at(-1).attrs.head, moved);
  assert.equal(r.calls.filter((c) => c.stage === 'map').length, 2);
  setAgentRunner(null);
});

test('AC-004: routes drawn at the same head go to the blind without a redraw', async () => {
  const f = setup({ pipeline: MAPPED, headIso: OLD, resultAt: OLD });
  const r = fakeRunner({ busy: false });
  await runReviewLoop();
  r.status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_review_started');
  assert.deepEqual(r.calls.filter((c) => c.stage === 'map').length, 1);
  assert.deepEqual(r.calls.at(-1).routes, ROUTES);
  assert.equal(f.head, events().find((e) => e.event === 's2_map_started').attrs.head);
  setAgentRunner(null);
});

test('the whole of IDD-153: the wait outlives the extra commit and the second report, and the map and the blind read the last commit', async () => {
  // report -> extra commit -> report again -> the conversation ends; the map and the blind must read the head the
  // executor stopped on, not the head its first report happened to leave behind
  const f = setup({ pipeline: MAPPED, headIso: OLD, resultAt: NOW() });
  const r = fakeRunner({ busy: true });
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT, 'the first report does not begin the map');
  // the executor adds a commit while still answering
  commitFile(f.wt, 'later.txt', NOW());
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  assert.deepEqual(r.calls, [], 'nothing started while the extra commit landed');
  // the executor reports again and then its conversation ends
  appendRows(f.state, ev('s2_result', { outcome: 'success' }, NOW()));
  r.state.busy = false;
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT, 'the second report starts the wait over');
  // the response is over and the head has held still: the two old times are the clock running out
  setResultAt(f.state, OLD);
  amendDate(f.wt, OLD2);
  const last = headOf(f.wt);
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_map_started');
  assert.equal(r.calls.find((c) => c.stage === 'map').head, last);
  r.status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(events().at(-1).event, 's2_review_started');
  assert.equal(events().at(-1).attrs.head, last, 'the blind reads the head the executor stopped on');
  assert.equal(events().find((e) => e.event === 's2_map_started').attrs.head, last, 'and so did the map');
  assert.equal(r.calls.find((c) => c.stage === 'blind').head, last);
  setAgentRunner(null);
});

// the stall clock counts from the end mark, so every stage that is gated by the wait has to write it once the wait is over

const endsOf = () => events().filter((e) => e.event === WAIT_END);

/** the end is on record once, after the wait and before the stage's own record `before`; a later pass does not write it again */
async function expectEndOnce(before) {
  assert.equal(endsOf().length, 1, 'the first look that finds the executor stopped writes the end');
  assert.ok(names().lastIndexOf(WAIT) < names().indexOf(WAIT_END), 'after the wait');
  assert.ok(names().indexOf(WAIT_END) < names().lastIndexOf(before), `and before ${before}`);
  await runReviewLoop();
  assert.equal(endsOf().length, 1, 'a later pass does not write it again');
}

test('IDD-258: the records recheck writes the wait\'s end once, after the wait and before the check', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  // the repo declares a records check; the lane has converged and was sent back with a records error
  writeFileSync(join(f.state, 'repos.yaml'), ['repos:', '  Demo:', `    upstream: ${f.wt}`, `    work: ${f.wt}`, '    work_base: main', '    public_base: main', '    checks:', '      - { name: intent, command: "true", scope: records }', ''].join('\n'));
  process.env.IDD_REPOS_FILE = join(f.state, 'repos.yaml');
  putLifecycle(f.state, [
    ev('s1_go'), ev('s2_start', { started_from_commit: f.head }), ev('s2_result', { outcome: 'success' }),
    ev('s2_review_converged', {}),
    ev('s2_intent_checked', { outcome: 'errors', sent_back: true, head: f.head }),
    ev('s2_records_conflict', { head: f.head, errors: [] }),
    ev('s2_records_instructed', { head: f.head }),
    ev('s2_result', { outcome: 'success' }, NOW()),
  ]);
  setRecordsCheckRunner(async () => ({ outcome: 'clean' }));
  try {
    const r = fakeRunner({ busy: true });
    await runReviewLoop();
    assert.equal(events().at(-1).event, WAIT, 'the recheck waits while the executor answers');
    assert.equal(endsOf().length, 0);
    setResultAt(f.state, OLD);
    r.state.busy = false;
    await runReviewLoop();
    await expectEndOnce('s2_intent_checked');
  } finally { setRecordsCheckRunner(null); setAgentRunner(null); }
});

test('IDD-258: the confirm\'s start writes the wait\'s end once, after the wait and before the confirm', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  putLifecycle(f.state, fixAnswered(f));
  fakeRunner({ busy: false });
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  assert.equal(endsOf().length, 0, 'no end while the wait is open');
  setResultAt(f.state, OLD);
  await runReviewLoop();
  await expectEndOnce('s2_confirm_started');
  setAgentRunner(null);
});

test('IDD-258: a review start that fails after the wait\'s end does not bring the clock back to the result before the wait', async () => {
  const f = setup({ headIso: OLD, resultAt: OLD });
  const r = fakeRunner({ busy: true });
  await runReviewLoop();
  assert.equal(events().at(-1).event, WAIT);
  // the executor stops; the stage ends the wait in this tick and its start fails in the same tick
  setResultAt(f.state, OLD);
  r.state.busy = false;
  r.state.failStart = true;
  await runReviewLoop();
  assert.equal(endsOf().length, 1, 'the end is on record');
  assert.equal(events().at(-1).event, 's2_review_run_failed', 'and the failed start follows it');
  const end = endsOf()[0];
  const count = () => events().filter((e) => e.event === LANE_STALL_DETECTED).length;
  // right after the end, the lane is not a stop (the result before the wait is 10 months old)
  await runStallWatch({});
  assert.equal(count(), 0, 'the clock counts from the end, not from the result before the wait');
  // 46 minutes after the end it is a stop that counts from the end
  await runStallWatch({}, Date.parse(end.at) + 46 * 60_000);
  assert.equal(count(), 1);
  assert.equal(events().find((e) => e.event === LANE_STALL_DETECTED).attrs.since, end.at);
  setAgentRunner(null);
});

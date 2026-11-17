import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { awaitedAgent } from '../src/plan/watch.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { moveInStartOrder, setUrgent } from '../src/ledger/start-order.ts';
import { tmpDir } from './helpers/tmp.mjs';

const original = process.cwd();
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_ALLOW_PROTOCOL: 'file',
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

const PLAIN = '  review_blind: { roles: [v], concurrency: 2 }\n  triage: { role: v }\n  confirm: { role: v }\n';
const PLAIN1 = '  review_blind: { roles: [v], concurrency: 1 }\n  triage: { role: v }\n  confirm: { role: v }\n';
const ORDER1 = `${PLAIN}  review_loop: { order_wait_hours: 1 }\n`;
const ORDER0 = `${PLAIN}  review_loop: { order_wait_hours: 0 }\n`;
const EXCLUDE_NOTES = `${PLAIN}  review_loop: { order_exclude_files: [notes.md] }\n`;
const NO_REVIEW = '  triage: { role: v }\n';

/** a project with a work clone and one worktree per lane on the work branch */
function setup({ pipeline = PLAIN, publish = false, lanes = ['IDD-1', 'IDD-2'] } = {}) {
  process.chdir(original);
  const root = mkdtempSync(join(tmpDir('idd-order-'), 'run-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const upstream = join(root, 'upstream');
  const state = join(root, 'state');
  mkdirSync(work);
  mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n');
  put(join(work, 'app.txt'), 'one\ntwo\nthree\n');
  commit(work);
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', 'origin', 'main');
  git(root, 'clone', remote, upstream);
  git(upstream, 'config', 'user.name', 'test');
  git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n');
  put(join(work, 'AGENTS.override.md'), 'private rules');
  commit(work);
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], ...(publish ? { publish: true } : { publish: false }), issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(state, 'roles.yaml'), `models:\n  x-v:\n    model: x/v\nroles:\n  v: { model: x-v }\npipeline:\n${pipeline}`);
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_ROLES_FILE: join(state, 'roles.yaml'), IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const made = {};
  const backlog = [];
  const sessions = [];
  for (const iddId of lanes) {
    const lane = ensureLaneWorktree('demo', iddId);
    made[iddId] = lane;
    backlog.push({ idd_id: iddId, area: 'demo', title: `feat: ${iddId}`, source_type: 'github', gh_issue_url: `https://github.com/test/project/issues/${iddId.slice(-1)}` });
    sessions.push({ idd_id: iddId, worktree_path: lane.path, branch: lane.branch, executor_session_id: `s-${iddId}` });
  }
  put(join(state, 'backlog.jsonl'), backlog.map((r) => JSON.stringify(r)).join('\n') + '\n');
  put(join(state, 'executor-sessions.jsonl'), sessions.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane: made['IDD-1'], lanes: made };
}

/** a runner that records the starts and answers a run's status as the test sets */
function fakeRunner(status = {}) {
  const calls = [];
  let n = 0;
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { calls.push(o); const id = `${o.stage}-${(n += 1)}`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
    cwdBusy: () => false,
  });
  return { calls, status };
}

const eventsOf = (id) => readLifecycle().filter((e) => e.idd_id === id);
const eventNames = (id) => eventsOf(id).map((e) => e.event);
const countOf = (id, name) => eventNames(id).filter((n) => n === name).length;
const lastOf = (name, id) => [...eventsOf(id)].reverse().find((e) => e.event === name);
const laneTip = (f, id) => git(f.lanes[id].path, 'rev-parse', 'HEAD');
const change = (f, id, files, message = 'feat: lane') => {
  for (const [name, text] of Object.entries(files)) put(join(f.lanes[id].path, name), text);
  commit(f.lanes[id].path, message);
  return laneTip(f, id);
};
const outboxLines = (f) => existsSync(join(f.state, 'outbox.jsonl'))
  ? readFileSync(join(f.state, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

/** put the lane at the first review: S2 started at the work branch's tip, and the executor has answered */
async function atFirstReview(f, iddId) {
  const start = git(f.lanes[iddId].path, 'rev-parse', 'HEAD');
  await seedLifecycle('lane_open', iddId, {});
  await seedLifecycle('s2_start', iddId, { started_from_commit: start });
  await seedLifecycle('s2_result', iddId, { outcome: 'success' });
  return start;
}
/** the lane has passed the order check and waits for its blind slot */
const passedAhead = (f, iddId) => appendLifecycle('s2_order_passed', iddId, { head: laneTip(f, iddId) });
/** a lane that passed the check at a chosen position (ms), so a wait's order can be controlled exactly */
const passedAheadAt = (f, iddId, orderAt) => appendLifecycle('s2_order_passed', iddId, { head: laneTip(f, iddId), order_at: orderAt });
/** a lane seeded as waiting from `since`, on the given opponents */
const waitOn = (f, iddId, since, opponents) => appendLifecycle('s2_order_waiting', iddId, { head: laneTip(f, iddId), since, opponents });
const waitRecord = (f, iddId, since, opponent) => appendLifecycle('s2_order_waiting', iddId, { head: laneTip(f, iddId), since, opponents: [{ lane: opponent, head: laneTip(f, opponent), files: ['app.txt'] }] });

test('two lanes that change distant places of one file both go on to their first review', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one\ntwo\nthree-b\n' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0, 'a distant change does not wait');
  assert.equal(countOf('IDD-2', 's2_order_passed'), 1);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  assert.equal(r.calls.some((c) => c.iddId === 'IDD-2'), true);
  setAgentRunner(null);
});

test('a lane that changes the same place waits for the lane ahead, once, and does not move', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  const head = change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  const r = fakeRunner();
  await runReviewLoop();
  const w = lastOf('s2_order_waiting', 'IDD-2');
  assert.deepEqual(w.attrs.opponents.map((o) => o.lane), ['IDD-1']);
  assert.deepEqual(w.attrs.opponents[0].files, ['app.txt']);
  assert.equal(w.attrs.opponents[0].head, laneTip(f, 'IDD-1'));
  assert.equal(typeof w.attrs.head, 'string');
  assert.equal(typeof w.attrs.since, 'string');
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), false, 'the blind did not start');
  assert.equal(r.calls.filter((c) => c.iddId === 'IDD-2').length, 0, 'nothing started for the waiting lane');
  assert.equal(countOf('IDD-2', 's2_review_run_failed'), 0);
  // the lane's own state is untouched: no instruction, no merge, no session work
  assert.equal(outboxLines(f).length, 0);
  assert.equal(laneTip(f, 'IDD-2'), head);
  assert.equal(awaitedAgent(eventsOf('IDD-2')), null);
  // running again with nothing changed writes no second wait
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), false);
  setAgentRunner(null);
});

test('the start order does not release an order wait: an urgent lane moved to the head still waits', async () => {
  const f = setup({ pipeline: PLAIN1 });
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1']);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), false);

  // the user marks the waiting lane urgent and moves it to the head of the start order
  const marked = await setUrgent({ idd_id: 'IDD-2', urgent: true });
  assert.equal(marked.ok, true);
  const moved = await moveInStartOrder({ idd_id: 'IDD-2', position: 1 });
  assert.equal(moved.ok, true);
  assert.equal(moved.lanes[0].idd_id, 'IDD-2');

  r.calls.length = 0;
  await runReviewLoop();
  // the dependency wait is not released: the lane waits on the same opponent, and no blind starts for it
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1']);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), false);
  assert.equal(r.calls.filter((c) => c.iddId === 'IDD-2').length, 0);
  setAgentRunner(null);
});

test('the wait is released when the lane ahead lands: the first review then takes the mainline in', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1);
  setAgentRunner(null);
  // IDD-1's work goes into the mainline and the lane closes
  git(f.work, 'merge', '--ff-only', f.lanes['IDD-1'].branch);
  await seedLifecycle('lane_close', 'IDD-1', {});
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_released'), 1);
  assert.equal(countOf('IDD-2', 's2_order_passed'), 1);
  // the pre-review merge conflicts, so the executor is asked to resolve it (the existing path)
  assert.equal(countOf('IDD-2', 's2_review_base_conflict'), 1);
  assert.equal(lastOf('s2_review_base_conflict', 'IDD-2').attrs.awaiting, true);
  assert.equal(outboxLines(f).length, 1);
  assert.equal(r.calls.length, 0);
  setAgentRunner(null);
});

test('the wait is released when the lane ahead is closed without landing, and the first review begins', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  fakeRunner();
  await runReviewLoop();
  setAgentRunner(null);
  await seedLifecycle('lane_close', 'IDD-1', {});
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_released'), 1);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  assert.equal(r.calls.some((c) => c.iddId === 'IDD-2'), true);
  setAgentRunner(null);
});

test('the wait is released when the lane ahead moves to a commit that does not conflict', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1);
  setAgentRunner(null);
  // IDD-1 changes a different file: the trial merge no longer conflicts
  git(f.lanes['IDD-1'].path, 'checkout', 'work-main', '--', 'app.txt');
  change(f, 'IDD-1', { 'other.txt': 'other\n' }, 'feat: other');
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_released'), 1);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  assert.equal(r.calls.some((c) => c.iddId === 'IDD-2'), true);
  setAgentRunner(null);
});

test('a trial merge git cannot answer does not hold the lane, and the reason is kept once', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  // IDD-1's branch shares no ancestor with the mainline: the trial merge returns no answer
  git(f.lanes['IDD-1'].path, 'checkout', '--orphan', 'orphan');
  commit(f.lanes['IDD-1'].path, 'feat: orphan');
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0, 'no answer is not a conflict');
  assert.equal(countOf('IDD-2', 's2_order_unknown'), 1);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  assert.equal(r.calls.some((c) => c.iddId === 'IDD-2'), true);
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_unknown'), 1, 'the reason is not written every tick');
  setAgentRunner(null);
});

test('the wait limit releases the lane and leaves the reason, counting from the first wait', async () => {
  const f = setup({ pipeline: ORDER1 });
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  await waitRecord(f, 'IDD-2', old, 'IDD-1');
  fakeRunner();
  await runReviewLoop();
  const limit = lastOf('s2_order_limit', 'IDD-2');
  assert.equal(limit.attrs.since, old);
  assert.deepEqual(limit.attrs.opponents.map((o) => o.lane), ['IDD-1']);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
});

test('an exceeded wait still records its limit when the blind slot is full, and never waits again', async () => {
  const f = setup({ pipeline: `${PLAIN1}  review_loop: { order_wait_hours: 1 }\n`, lanes: ['IDD-1', 'IDD-2', 'IDD-3'] });
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  // IDD-3 holds the only blind copy
  await atFirstReview(f, 'IDD-3');
  await appendLifecycle('s2_review_started', 'IDD-3', { kind: 'blind', round: 1, head: laneTip(f, 'IDD-3'), run_ids: ['held'] });
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  await waitRecord(f, 'IDD-2', old, 'IDD-1');
  const r = fakeRunner({ held: { state: 'running' } });
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_limit'), 1);
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1, 'only the seeded wait');
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), false, 'the slot is full');
  // the lane ahead moves, and a conflicting commit would draw a new wait if the check ran again
  change(f, 'IDD-1', { 'app.txt': 'one-c\ntwo\nthree\n' });
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1, 'an exceeded wait is not taken again');
  assert.equal(countOf('IDD-2', 's2_order_limit'), 1);
  setAgentRunner(null);
  assert.ok(r);
});

test('a wait kept for a moved opponent counts from the first wait', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  fakeRunner();
  await runReviewLoop();
  const since0 = lastOf('s2_order_waiting', 'IDD-2').attrs.since;
  setAgentRunner(null);
  // the opponent moves to another conflicting commit
  change(f, 'IDD-1', { 'app.txt': 'one-c\ntwo\nthree\n' }, 'feat: move');
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 2);
  assert.equal(lastOf('s2_order_waiting', 'IDD-2').attrs.since, since0, 'the clock is not reset');
});

test('order_wait_hours: 0 turns the check off', async () => {
  const f = setup({ pipeline: ORDER0 });
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
  assert.ok(r);
});

test('a waiting lane is an opponent: a later lane that collides with it waits behind it', async () => {
  const f = setup({ lanes: ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4'] });
  for (const id of ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4']) await atFirstReview(f, id);
  const t0 = Date.now() - 3600_000;
  // X=IDD-1 is ahead; A=IDD-2 waits on it from t0+1min
  await passedAheadAt(f, 'IDD-1', t0);
  change(f, 'IDD-1', { 'x.txt': 'x\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-3', { 'app.txt': 'one-b\ntwo\nthree\n', 'b.txt': 'b-two\n' });
  change(f, 'IDD-4', { 'b.txt': 'b-three\n' });
  await waitOn(f, 'IDD-2', new Date(t0 + 60_000).toISOString(), [{ lane: 'IDD-1', head: laneTip(f, 'IDD-1'), files: ['x.txt'] }]);
  const r = fakeRunner();
  await runReviewLoop();
  // A keeps its first opponent only: the later lane is not named
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1']);
  // B waits behind the waiting A, and its blind does not start
  const bWait = lastOf('s2_order_waiting', 'IDD-3');
  assert.ok(bWait, 'B waits');
  assert.deepEqual(bWait.attrs.opponents.map((o) => o.lane), ['IDD-2']);
  assert.equal(eventNames('IDD-3').includes('s2_review_started'), false, 'B does not start its blind');
  assert.equal(r.calls.some((c) => c.iddId === 'IDD-3'), false);
  // C collides only with B, and waits behind it too
  const cWait = lastOf('s2_order_waiting', 'IDD-4');
  assert.ok(cWait, 'C waits');
  assert.deepEqual(cWait.attrs.opponents.map((o) => o.lane), ['IDD-3']);
  assert.equal(eventNames('IDD-4').includes('s2_review_started'), false, 'C does not start its blind');
  setAgentRunner(null);
  assert.ok(r);
});

test('a waiting lane does not wait on a lane that passed the check after its wait began', async () => {
  const f = setup({ lanes: ['IDD-1', 'IDD-2', 'IDD-3'] });
  for (const id of ['IDD-1', 'IDD-2', 'IDD-3']) await atFirstReview(f, id);
  const t0 = Date.now() - 3600_000;
  change(f, 'IDD-1', { 'x.txt': 'x\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-3', { 'app.txt': 'one-b\ntwo\nthree\n' });
  await passedAheadAt(f, 'IDD-1', t0);
  await waitOn(f, 'IDD-2', new Date(t0 + 60_000).toISOString(), [{ lane: 'IDD-1', head: laneTip(f, 'IDD-1'), files: ['x.txt'] }]);
  // B passed at t0+2min, after A's wait began, and collides with A
  await passedAheadAt(f, 'IDD-3', t0 + 120_000);
  fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1, 'the wait is not rewritten');
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1']);
  setAgentRunner(null);
  // the first opponent lands and closes: the wait is released, and no wait on the later lane is written
  await seedLifecycle('lane_close', 'IDD-1', {});
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_released'), 1);
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1, 'no new wait');
  assert.equal(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane).includes('IDD-3'), false);
  setAgentRunner(null);
  assert.ok(r);
});

test('two lanes that began waiting at the same moment are ordered by lane number, and neither waits on the later one', async () => {
  const f = setup({ lanes: ['IDD-1', 'IDD-2', 'IDD-3'] });
  for (const id of ['IDD-1', 'IDD-2', 'IDD-3']) await atFirstReview(f, id);
  const since = new Date(Date.now() - 3600_000).toISOString();
  // both lanes collide on the same line, and both were waiting on a lane that is already closed
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  await waitOn(f, 'IDD-1', since, [{ lane: 'IDD-3', head: 'closed', files: ['app.txt'] }]);
  await waitOn(f, 'IDD-2', since, [{ lane: 'IDD-3', head: 'closed', files: ['app.txt'] }]);
  await seedLifecycle('lane_close', 'IDD-3', {});
  fakeRunner();
  await runReviewLoop();
  // the smaller number goes first; the larger waits behind it
  assert.equal(countOf('IDD-1', 's2_order_released'), 1);
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-1').attrs.opponents.map((o) => o.lane), ['IDD-3']);
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1']);
  setAgentRunner(null);
  // running again does not make the two wait on each other
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-1', 's2_order_released'), 1, 'the first lane is not judged again');
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1']);
  setAgentRunner(null);
  assert.ok(r);
});

test('a legacy record without a position time reads from its own time, and an unwaiting lane from its first review', async () => {
  // the waiting lane began before the legacy records: it does not wait on them
  const before = setup({ lanes: ['IDD-1', 'IDD-2', 'IDD-3'] });
  for (const id of ['IDD-1', 'IDD-2', 'IDD-3']) await atFirstReview(before, id);
  change(before, 'IDD-1', { 'app.txt': 'one-r\ntwo\nthree\n' });
  change(before, 'IDD-2', { 'app.txt': 'one-p\ntwo\nthree\n' });
  change(before, 'IDD-3', { 'app.txt': 'one-q\ntwo\nthree\n' });
  await appendLifecycle('s2_order_passed', 'IDD-2', { head: laneTip(before, 'IDD-2') });
  await appendLifecycle('s2_review_started', 'IDD-3', { kind: 'blind', round: 1, head: laneTip(before, 'IDD-3'), run_ids: ['q'] });
  await waitOn(before, 'IDD-1', new Date(Date.now() - 60_000).toISOString(), [{ lane: 'IDD-2', head: laneTip(before, 'IDD-2'), files: ['app.txt'] }]);
  fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-1', 's2_order_released'), 1, 'the older wait does not extend to the legacy records');
  assert.equal(countOf('IDD-1', 's2_order_waiting'), 1);
  setAgentRunner(null);
  // the waiting lane began after them: it waits on both
  const after = setup({ lanes: ['IDD-2', 'IDD-3', 'IDD-4'] });
  for (const id of ['IDD-2', 'IDD-3', 'IDD-4']) await atFirstReview(after, id);
  change(after, 'IDD-2', { 'app.txt': 'one-p\ntwo\nthree\n' });
  change(after, 'IDD-3', { 'app.txt': 'one-q\ntwo\nthree\n' });
  change(after, 'IDD-4', { 'app.txt': 'one-s\ntwo\nthree\n' });
  await appendLifecycle('s2_order_passed', 'IDD-2', { head: laneTip(after, 'IDD-2') });
  await appendLifecycle('s2_review_started', 'IDD-3', { kind: 'blind', round: 1, head: laneTip(after, 'IDD-3'), run_ids: ['q'] });
  await waitOn(after, 'IDD-4', new Date(Date.now()).toISOString(), [{ lane: 'IDD-2', head: laneTip(after, 'IDD-2'), files: ['app.txt'] }]);
  fakeRunner();
  await runReviewLoop();
  const opponents = lastOf('s2_order_waiting', 'IDD-4').attrs.opponents.map((o) => o.lane);
  assert.deepEqual(opponents, ['IDD-2', 'IDD-3']);
  setAgentRunner(null);
});

test('a lane goes to its first review after its own opponent lands, while the lanes behind it keep waiting on it', async () => {
  const f = setup({ lanes: ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4'] });
  const t0 = Date.now() - 3600_000;
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  change(f, 'IDD-1', { 'app.txt': 'one-x\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-3', { 'app.txt': 'one-b\ntwo\nthree\n' });
  change(f, 'IDD-4', { 'app.txt': 'one-c\ntwo\nthree\n' });
  await passedAheadAt(f, 'IDD-1', t0);
  fakeRunner();
  await runReviewLoop();
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1'], 'A waits on X');
  setAgentRunner(null);
  // B and C answer in turn, and each waits behind A rather than starting its blind
  for (const id of ['IDD-3', 'IDD-4']) {
    await atFirstReview(f, id);
    const r = fakeRunner();
    await runReviewLoop();
    assert.equal(eventNames(id).includes('s2_review_started'), false, `${id} does not start its blind`);
    assert.ok(lastOf('s2_order_waiting', id).attrs.opponents.map((o) => o.lane).includes('IDD-2'), `${id} waits on A`);
    setAgentRunner(null);
    assert.ok(r);
  }
  // X lands and closes: A is released into its first review, and B and C still wait on A
  await seedLifecycle('lane_close', 'IDD-1', {});
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_released'), 1);
  assert.equal(countOf('IDD-2', 's2_order_passed'), 1);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true, 'A enters its first review');
  for (const w of eventsOf('IDD-2').filter((e) => e.event === 's2_order_waiting')) {
    assert.deepEqual(w.attrs.opponents.map((o) => o.lane), ['IDD-1'], 'A never waited on B or C');
  }
  for (const id of ['IDD-3', 'IDD-4']) {
    assert.equal(eventNames(id).includes('s2_review_started'), false, `${id} still does not start its blind`);
    assert.ok(lastOf('s2_order_waiting', id).attrs.opponents.map((o) => o.lane).includes('IDD-2'), `${id} still waits on A`);
  }
  setAgentRunner(null);
  assert.ok(r);
});

test('the same place in the same tick lets one lane through and makes the other wait (one wait per lane)', async () => {
  const f = setup({ pipeline: PLAIN1, lanes: ['IDD-1', 'IDD-2', 'IDD-3'] });
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  // IDD-3 holds the only blind copy, so the first lane cannot start either
  await atFirstReview(f, 'IDD-3');
  await appendLifecycle('s2_review_started', 'IDD-3', { kind: 'blind', round: 1, head: laneTip(f, 'IDD-3'), run_ids: ['held'] });
  const r = fakeRunner({ held: { state: 'running' } });
  await runReviewLoop();
  assert.equal(countOf('IDD-1', 's2_order_passed'), 1);
  assert.equal(countOf('IDD-1', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-1').includes('s2_review_started'), false, 'the slot is full');
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1, 'the later lane waits on the one that passed');
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents.map((o) => o.lane), ['IDD-1']);
  // the passed lane is not judged again while the slot stays full
  await runReviewLoop();
  assert.equal(countOf('IDD-1', 's2_order_passed'), 1, 'no second pass record');
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1, 'no second wait record');
  setAgentRunner(null);
  assert.ok(r);
});

test('a conflict only on the excluded files never waits, nor does one on a file the repo adds', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'TODO.md': 'a\n' });
  change(f, 'IDD-2', { 'TODO.md': 'b\n' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
  assert.ok(r);
  // TODO.md and another conflicting file: the lane waits
  const g = setup();
  await atFirstReview(g, 'IDD-1');
  await atFirstReview(g, 'IDD-2');
  await passedAhead(g, 'IDD-1');
  change(g, 'IDD-1', { 'TODO.md': 'a\n', 'app.txt': 'one-a\ntwo\nthree\n' });
  change(g, 'IDD-2', { 'TODO.md': 'b\n', 'app.txt': 'one-b\ntwo\nthree\n' });
  fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 1);
  assert.deepEqual(lastOf('s2_order_waiting', 'IDD-2').attrs.opponents[0].files, ['app.txt']);
  setAgentRunner(null);
  // a file the repo adds is excluded too
  const h = setup({ pipeline: EXCLUDE_NOTES });
  await atFirstReview(h, 'IDD-1');
  await atFirstReview(h, 'IDD-2');
  await passedAhead(h, 'IDD-1');
  change(h, 'IDD-1', { 'notes.md': 'a\n' });
  change(h, 'IDD-2', { 'notes.md': 'b\n' });
  fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
});

test('out of scope lanes neither wait nor are opponents', async () => {
  // a repo that publishes
  const pub = setup({ publish: true });
  await atFirstReview(pub, 'IDD-1');
  await atFirstReview(pub, 'IDD-2');
  await passedAhead(pub, 'IDD-1');
  change(pub, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(pub, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  let r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
  assert.ok(r);
  // a lane stacked on another lane does not wait
  const st = setup({ lanes: ['IDD-1', 'IDD-2'] });
  await atFirstReview(st, 'IDD-1');
  await atFirstReview(st, 'IDD-2');
  await appendLifecycle('lane_base_set', 'IDD-2', { branch: st.lanes['IDD-1'].branch, parent: 'IDD-1', source: 'manual' });
  await passedAhead(st, 'IDD-1');
  change(st, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(st, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
  // a stacked lane ahead is not an opponent for a lane on the work branch
  const op = setup({ lanes: ['IDD-1', 'IDD-2', 'IDD-3'] });
  await atFirstReview(op, 'IDD-1');
  await atFirstReview(op, 'IDD-2');
  await appendLifecycle('lane_base_set', 'IDD-1', { branch: op.lanes['IDD-3'].branch, parent: 'IDD-3', source: 'manual' });
  await passedAhead(op, 'IDD-1');
  change(op, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(op, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
  // a config that declares no review slot does not check the order either
  const nr = setup({ pipeline: NO_REVIEW });
  await atFirstReview(nr, 'IDD-1');
  await atFirstReview(nr, 'IDD-2');
  await passedAhead(nr, 'IDD-1');
  change(nr, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  change(nr, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(eventNames('IDD-2').includes('s2_review_skipped'), true);
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), false);
  setAgentRunner(null);
  assert.ok(r);
});

test('the order check runs only before the first review: a final round does not wait', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  change(f, 'IDD-1', { 'app.txt': 'one-a\ntwo\nthree\n' });
  const fixedHead = change(f, 'IDD-2', { 'app.txt': 'one-b\ntwo\nthree\n' });
  // IDD-2 has already had its first blind, a fix round and a clean confirm: the next round is the final review
  await appendLifecycle('s2_review_started', 'IDD-2', { kind: 'blind', round: 1, head: fixedHead, run_ids: ['b'] });
  await appendLifecycle('s2_review_findings', 'IDD-2', { kind: 'blind', round: 1, files: ['/b.json'] });
  await appendLifecycle('s2_triage_done', 'IDD-2', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'x' }] });
  await appendLifecycle('s2_fix_sent', 'IDD-2', { round: 1, refs: ['F-1'] });
  await appendLifecycle('s2_result', 'IDD-2', { outcome: 'success' });
  await appendLifecycle('s2_confirm_started', 'IDD-2', { round: 1, run_id: 'c' });
  await appendLifecycle('s2_confirm_done', 'IDD-2', { round: 1, new_blocking: 0, unresolved_must: 0, unresolved_should: 0 });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(countOf('IDD-2', 's2_order_passed'), 0);
  const started = r.calls.find((c) => c.iddId === 'IDD-2');
  assert.equal(started.stage, 'final');
  setAgentRunner(null);
});

test('a lane that cannot be read for its order check is left as it was', async () => {
  const f = setup();
  await atFirstReview(f, 'IDD-1');
  await atFirstReview(f, 'IDD-2');
  await passedAhead(f, 'IDD-1');
  // IDD-1's worktree is gone: the head cannot be read, so it is not an opponent
  rmSync(f.lanes['IDD-1'].path, { recursive: true, force: true });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(countOf('IDD-2', 's2_order_waiting'), 0);
  assert.equal(countOf('IDD-2', 's2_order_unknown'), 1, 'the unreadable head is left once');
  assert.equal(eventNames('IDD-2').includes('s2_review_started'), true);
  setAgentRunner(null);
  assert.ok(r);
});

// more lanes ahead than the caller's fact rounds: the judgement asks for every trial merge in one round, so a lane
// with many opponents still gets an answer, and a lane that collides with one of them does not start its review
const MANY_LANES = Array.from({ length: 13 }, (_, i) => `IDD-${i + 1}`);
const ORDER_MANY = '  review_blind: { roles: [v], concurrency: 13 }\n  triage: { role: v }\n  confirm: { role: v }\n  review_loop: { order_wait_hours: 1 }\n';

test('twelve lanes ahead still let the order check answer: the colliding lane waits, the colliding lane does not start', async () => {
  const f = setup({ pipeline: ORDER_MANY, lanes: MANY_LANES });
  const ahead = MANY_LANES.slice(0, 12);
  for (const [i, id] of ahead.entries()) {
    await atFirstReview(f, id);
    await passedAheadAt(f, id, 1000 + i);
    change(f, id, { [`lane-${i}.txt`]: `${id}\n` });
  }
  await atFirstReview(f, 'IDD-13');
  // one lane ahead changes the same line of app.txt as the lane under test, the other eleven change files of their own
  change(f, ahead[4], { 'app.txt': 'one-a\ntwo\nthree\n' });
  const head = change(f, 'IDD-13', { 'app.txt': 'one-b\ntwo\nthree\n' });
  const r = fakeRunner();
  const result = await runReviewLoop();
  assert.deepEqual(result.errors.filter((e) => e.iddId === 'IDD-13'), [], 'the judgement answers, it does not fail');
  const w = lastOf('s2_order_waiting', 'IDD-13');
  assert.ok(w, 'the lane waits');
  assert.deepEqual(w.attrs.opponents.map((o) => o.lane), [ahead[4]]);
  assert.deepEqual(w.attrs.opponents[0].files, ['app.txt']);
  assert.equal(eventNames('IDD-13').includes('s2_review_started'), false, 'the blind did not start');
  assert.equal(r.calls.filter((c) => c.iddId === 'IDD-13').length, 0);
  assert.equal(countOf('IDD-13', 's2_review_run_failed'), 0);
  assert.equal(laneTip(f, 'IDD-13'), head);
  setAgentRunner(null);
});

test('twelve lanes ahead with no collision pass the order check and go to their first review', async () => {
  const f = setup({ pipeline: ORDER_MANY, lanes: MANY_LANES });
  const ahead = MANY_LANES.slice(0, 12);
  for (const [i, id] of ahead.entries()) {
    await atFirstReview(f, id);
    await passedAheadAt(f, id, 1000 + i);
    change(f, id, { [`lane-${i}.txt`]: `${id}\n` });
  }
  await atFirstReview(f, 'IDD-13');
  change(f, 'IDD-13', { 'app.txt': 'one\ntwo\nthree-b\n' });
  fakeRunner();
  const result = await runReviewLoop();
  assert.deepEqual(result.errors.filter((e) => e.iddId === 'IDD-13'), []);
  assert.equal(countOf('IDD-13', 's2_order_waiting'), 0, 'a distant change does not wait');
  assert.equal(countOf('IDD-13', 's2_order_passed'), 1);
  assert.equal(eventNames('IDD-13').includes('s2_review_started'), true);
  setAgentRunner(null);
});

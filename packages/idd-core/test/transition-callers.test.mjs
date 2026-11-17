import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import lockfile from 'proper-lockfile';

import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { exportLane, proposeForTests as propose, readProposal, proposalPath } from '../src/overlay/export.ts';
import { importUpstream, proposeImport, reviewImport } from '../src/overlay/import.ts';
import { lanesAwaitingExec, runExec, runningExecutors } from '../src/plan/exec.ts';
import * as ship from '../src/plan/ship.ts';
import { runClose } from '../src/plan/close.ts';
import { runSubmitPrep } from '../src/plan/submit-prep.ts';
import { LANE_GATE_BUSY_MESSAGE, LANE_GATE_FILE, LANE_GATE_STALE_MS } from '../src/ledger/gate.ts';
import { reviewBaseOf } from '../src/ledger/base.ts';
import { ignoreLane } from '../src/intake/ignore.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { pushApproval, shipApproved } from './passkey-approval.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const approveExport = (token, approval) => exportLane('IDD-1', token, pushApproval('IDD-1', approval));
const approveShip = (token, approval) => ship.runShip('IDD-1', token, shipApproved('IDD-1', approval));
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const commit = (cwd, message = 'chore: fixture') => { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// each fixture holds a few git repos: they go when the test is done
const roots = [];
const oldPath = process.env.PATH;
afterEach(() => {
  setAgentRunner(null); process.chdir(original); process.env.PATH = oldPath;
  delete process.env.IDD_LANE_GATE_WAIT_MS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** a work branch, its public remote and an output clone, with one lane (IDD-1) cut from the work branch */
function setup() {
  process.chdir(original);
  const root = scratchDir('run-'); roots.push(root);
  const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n'); put(join(work, 'app.txt'), 'one\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'test'); git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', context: '', created_at: '2026-09-26T00:00:00Z' }) + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane };
}

const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1');
const count = (name) => lane().filter((e) => e.event === name).length;
function record(f, ...events) {
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), events.map(([event, attrs = {}]) => JSON.stringify({ idd_id: 'IDD-1', event, at: new Date().toISOString(), attrs })).join('\n') + '\n');
}
function executorSession(f) {
  put(join(f.state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: f.lane.path, branch: f.lane.branch, executor_session_id: 'E1' }) + '\n');
}

/** another process holds the lane gate; the callers wait for it only briefly */
async function holdGate(f, wait = '300') {
  process.env.IDD_LANE_GATE_WAIT_MS = wait;
  const path = join(f.state, LANE_GATE_FILE);
  if (!existsSync(path)) writeFileSync(path, '');
  return lockfile.lock(path, { stale: LANE_GATE_STALE_MS });
}

// ---- the executor's start ----

/** a lane after its GO, with a contract for the executor */
function goneLane() {
  const f = setup();
  record(f, ['lane_open'], ['s1_ready'], ['s1_go']);
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-1: 何かを決める\n');
  return f;
}

/** a runner that spawns sessions and says which it was asked to discard */
function spawner({ onSpawn, discard = true } = {}) {
  const spawned = [], discarded = [], delivered = [];
  setAgentRunner({
    spawn: async () => { const sessionId = `E${spawned.length + 9}`; spawned.push(sessionId); await onSpawn?.(); return { sessionId, model: 'x/y', harness: 'pi' }; },
    deliver: async (id) => { delivered.push(id); },
    ...(discard ? { discard: async (id) => { discarded.push(id); } } : {}),
  });
  return { spawned, discarded, delivered };
}

const executorSessions = (f) => (existsSync(join(f.state, 'executor-sessions.jsonl')) ? readFileSync(join(f.state, 'executor-sessions.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []);

test('an executor whose start finds the gate busy is discarded: nothing is recorded, and the next tick spawns one again', async () => {
  const f = goneLane();
  const r = spawner();
  const release = await holdGate(f);
  let first;
  try {
    first = await runExec();
  } finally {
    await release();
  }
  assert.deepEqual(first.started, []);
  assert.match(first.skipped[0].reason, new RegExp(LANE_GATE_BUSY_MESSAGE));
  assert.deepEqual(r.discarded, ['E9'], 'the session spawned for the start that did not go through is discarded');
  assert.deepEqual(r.delivered, []);
  assert.equal(count('s2_start'), 0);
  assert.deepEqual(executorSessions(f), []);
  // the gate is free again: the lane starts once, with the session of this tick
  const next = await runExec();
  assert.deepEqual(next.started.map((s) => s.sessionId), ['E10']);
  assert.deepEqual(r.discarded, ['E9']);
  assert.equal(count('s2_start'), 1);
  assert.equal(executorSessions(f).length, 1);
});

test('an executor spawned while penne aborted the lane is discarded, and the lane stays closed once', async () => {
  const f = goneLane();
  const r = spawner({ onSpawn: async () => { assert.equal((await ignoreLane('IDD-1')).ok, true); } });
  const res = await runExec();
  assert.deepEqual(res.started, []);
  assert.match(res.skipped[0].reason, /s2_start/);
  assert.deepEqual(r.discarded, ['E9']);
  assert.deepEqual(r.delivered, []);
  assert.equal(count('s2_start'), 0);
  assert.equal(count('lane_close'), 1);
  assert.deepEqual(executorSessions(f), []);
});

test('a runner that cannot discard a session says the session is left, instead of saying nothing', async () => {
  goneLane();
  spawner({ discard: false, onSpawn: async () => { await ignoreLane('IDD-1'); } });
  const res = await runExec();
  assert.match(res.skipped[0].reason, /E9/);
  assert.match(res.skipped[0].reason, /残っています/);
});

test('an executor whose start cannot be written after its session was recorded takes the record back: it holds no slot and the next tick starts the lane', async () => {
  const f = goneLane();
  const r = spawner();
  // the lane's lifecycle file is held past the append's retries: the session is recorded, the start is not
  const release = await lockfile.lock(join(f.state, 'lifecycle-demo.jsonl'));
  let first;
  try {
    first = await runExec();
  } finally {
    await release();
  }
  assert.deepEqual(first.started, []);
  assert.match(first.skipped[0].reason, /s2_start/);
  assert.deepEqual(r.discarded, ['E9']);
  assert.equal(count('s2_start'), 0);
  assert.deepEqual(executorSessions(f), [], 'the session record is taken back with the start');
  assert.equal(runningExecutors(), 0, 'no executor slot is held by the discarded session');
  assert.deepEqual(lanesAwaitingExec().map((l) => l.idd_id), ['IDD-1'], 'the lane waits for its executor again');
  const next = await runExec();
  assert.deepEqual(next.started.map((s) => s.sessionId), ['E10']);
  assert.equal(count('s2_start'), 1);
  assert.equal(executorSessions(f).length, 1);
});

test('a lane whose start would be refused gets no worktree made for it', async () => {
  const f = setup();
  // IDD-2 started already but its session record is gone: it is listed, and its start is refused
  appendFileSync(join(f.state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-2', area: 'demo', title: 'feat: other', context: '', created_at: '2026-09-26T00:00:01Z' }) + '\n');
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), ['lane_open', 's1_ready', 's1_go', 's2_start'].map((event) => JSON.stringify({ idd_id: 'IDD-2', event, at: new Date().toISOString(), attrs: {} })).join('\n') + '\n');
  const r = spawner();
  const res = await runExec();
  const skipped = res.skipped.find((s) => s.iddId === 'IDD-2');
  assert.match(skipped?.reason ?? '', /s2_start/);
  assert.equal(existsSync(join(f.root, 'lanes', 'IDD-2')), false, 'no worktree is made for a lane that is not started');
  assert.deepEqual(r.spawned, []);
});

// ---- the planner records the harness commits before the executor starts ----

test('AC-001: the planner records are committed before the executor starts, from the head before that commit', async () => {
  const f = goneLane();
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), 'qa\n');
  put(join(f.lane.path, '_docs/reference/demo/idd-1/reference.md'), 'ref\n');
  const start = git(f.lane.path, 'rev-parse', 'HEAD');
  spawner();
  const res = await runExec();
  assert.deepEqual(res.started.map((s) => s.iddId), ['IDD-1']);
  assert.equal(git(f.lane.path, 'status', '--porcelain', '--untracked-files=all'), '', 'the records no longer show as uncommitted');
  assert.equal(git(f.lane.path, 'rev-list', '--count', `${start}..HEAD`), '1', 'the records are one commit');
  const files = git(f.lane.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ['_docs/intent/demo/idd-1/decision.md', '_docs/qa/demo/idd-1/qa.md', '_docs/reference/demo/idd-1/reference.md']);
  assert.equal(lane().find((e) => e.event === 's2_start').attrs.started_from_commit, start, 'the base is the head before the record commit');
});

test('AC-002: the records are inside the review diff, and a start stopped after the commit keeps the same base', async () => {
  const f = goneLane();
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), 'qa\n');
  const start = git(f.lane.path, 'rev-parse', 'HEAD');
  spawner();
  const release = await holdGate(f);
  try { await runExec(); } finally { await release(); }
  assert.equal(count('s2_start'), 0, 'the busy lane gate stops the start');
  assert.notEqual(git(f.lane.path, 'rev-parse', 'HEAD'), start, 'the records were committed before the stop');
  const next = await runExec();
  assert.deepEqual(next.started.map((s) => s.iddId), ['IDD-1']);
  assert.equal(reviewBaseOf(lane()), start, 'the base is the head before the record commit, on the retried start too');
  const changed = git(f.lane.path, 'diff', '--name-only', `${start}..HEAD`).split('\n').filter(Boolean);
  assert.ok(changed.includes('_docs/qa/demo/idd-1/qa.md'), changed.join(', '));
});

test('AC-003: the record commit leaves changes outside the records uncommitted', async () => {
  const f = goneLane();
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), 'qa\n');
  put(join(f.lane.path, 'TODO.md'), 'todo\n');
  spawner();
  await runExec();
  const files = git(f.lane.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.ok(files.length > 0, 'the records were committed');
  assert.ok(files.every((p) => p.startsWith('_docs/')), files.join(', '));
  assert.match(git(f.lane.path, 'status', '--porcelain', '--untracked-files=all'), /TODO[.]md/, 'the change outside the records stays uncommitted');
});

test('AC-004: while the repo lock is held the executor does not start, and the next tick commits and starts', async () => {
  const f = goneLane();
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), 'qa\n');
  const start = git(f.lane.path, 'rev-parse', 'HEAD');
  const r = spawner();
  const lockPath = join(git(f.lane.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'idd-overlay.lock');
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const first = await runExec();
    assert.deepEqual(first.started, []);
    assert.match(first.skipped[0].reason, /lock/);
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
  assert.deepEqual(r.spawned, [], 'no executor was spawned');
  assert.equal(count('s2_start'), 0);
  assert.equal(git(f.lane.path, 'rev-parse', 'HEAD'), start, 'nothing was committed');
  const next = await runExec();
  assert.deepEqual(next.started.map((s) => s.iddId), ['IDD-1']);
  assert.equal(count('s2_start'), 1);
  assert.notEqual(git(f.lane.path, 'rev-parse', 'HEAD'), start, 'the records were committed on the next tick');
});

// ---- the submit card's start ----

/** a lane at the S3 card (its diff for penne), or past it */
function s3Lane(passed) {
  const f = setup();
  executorSession(f);
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path, 'feat: change');
  record(f, ['lane_open'], ['s1_ready'], ['s1_go'], ['s2_start'], ['s2_result', { outcome: 'success' }], ['s3_ready'], ...(passed ? [['s3_ok', passed]] : []));
  return f;
}

test('a submit card whose start finds the gate busy opens nothing, and the decision that passed S3 says so on the screen', async () => {
  const f = s3Lane({ reviewer_notes: '' });
  const release = await holdGate(f);
  try {
    assert.equal(await ship.startSubmit('IDD-1'), null);
    const after = await ship.openSubmitAfterS3('IDD-1');
    assert.equal('view' in after, false);
    assert.match(after.warning, /提出前確認を開けませんでした/);
    assert.match(after.warning, new RegExp(LANE_GATE_BUSY_MESSAGE));
    assert.match(after.warning, /次の tick で開き直します/);
  } finally {
    await release();
  }
  assert.equal(count('s4_submit_started'), 0);
  assert.equal(count('s4_verify_started'), 0);
  const opened = await ship.openSubmitAfterS3('IDD-1');
  assert.ok(opened.view, JSON.stringify(opened));
  assert.equal(count('s4_submit_started'), 1);
});

test('a submit card that did not open says what opens it: the next tick only when the tick will', async () => {
  // a lane stopped for its budget: the tick does not open it until penne gives more
  const f = s3Lane({ reviewer_notes: '' });
  record(f, ['lane_over_budget', { cost: 6, limit: 5 }]);
  const held = await ship.openSubmitAfterS3('IDD-1');
  assert.match(held.warning, /予算/);
  assert.doesNotMatch(held.warning, /次の tick で開き直します/);
  assert.equal(count('s4_submit_started'), 0);
});

test('a submit card that cannot be built says so, instead of promising the next tick', async () => {
  const f = s3Lane({ reviewer_notes: '' });
  // the executor's worktree is gone: the card cannot be built on any tick until it is back
  put(join(f.state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: join(f.root, 'gone'), branch: f.lane.branch, executor_session_id: 'E1' }) + '\n');
  const after = await ship.openSubmitAfterS3('IDD-1');
  assert.match(after.warning, /worktree/);
  assert.doesNotMatch(after.warning, /次の tick で開き直します/);
  assert.equal(count('s4_submit_started'), 0);
});

/** the gate's lock cannot be made: an old leftover in the place of its lock that is not a lock directory */
function breakGate(f) {
  writeFileSync(join(f.state, LANE_GATE_FILE), '');
  const leftover = join(f.state, `${LANE_GATE_FILE}.lock`);
  writeFileSync(leftover, 'x');
  const old = new Date(Date.now() - 2 * LANE_GATE_STALE_MS);
  utimesSync(leftover, old, old);
  return () => rmSync(leftover, { force: true });
}

test('a submit card whose reopen throws is put on the lane once, and the tick goes on with the other lanes', async () => {
  const f = s3Lane({ reviewer_notes: '' });
  const repair = breakGate(f);
  const first = await runSubmitPrep();
  assert.deepEqual(first.submitted, []);
  assert.equal(first.errors.length, 1);
  assert.equal(first.errors[0].iddId, 'IDD-1');
  assert.match(first.errors[0].error, /ENOTDIR/);
  assert.equal(count('s4_submit_open_failed'), 1, 'the reason is recorded on the lane');
  // the same failure on the next tick is said again, but not recorded twice
  const second = await runSubmitPrep();
  assert.equal(second.errors.length, 1);
  assert.equal(count('s4_submit_open_failed'), 1);
  assert.equal(count('s4_submit_started'), 0);
  // once the fault is gone, the next tick opens the card
  repair();
  assert.deepEqual((await runSubmitPrep()).submitted, ['IDD-1']);
  assert.equal(count('s4_submit_started'), 1);
});

test('a submit card that finds the gate busy on a tick is not recorded on the lane: the next tick opens it', async () => {
  const f = s3Lane({ reviewer_notes: '' });
  const release = await holdGate(f);
  let busy;
  try {
    busy = await runSubmitPrep();
  } finally {
    await release();
  }
  assert.match(busy.errors[0].error, new RegExp(LANE_GATE_BUSY_MESSAGE));
  assert.equal(count('s4_submit_open_failed'), 0);
});

test('a submit card for a lane whose stage does not take it opens nothing and writes nothing', async () => {
  s3Lane(null);
  assert.equal(await ship.startSubmit('IDD-1'), null);
  const after = await ship.openSubmitAfterS3('IDD-1');
  assert.match(after.warning, /S3 を通って提出前確認を待つ lane ではありません/);
  assert.equal(count('s4_submit_started'), 0);
  assert.equal(count('s4_verify_started'), 0);
});

test('a lane penne passed on the S3 card whose submit did not open is opened by the next tick', async () => {
  const f = s3Lane({ reviewer_notes: '', side_findings_promoted: [] });
  const release = await holdGate(f);
  try {
    assert.equal(await ship.startSubmit('IDD-1'), null);
  } finally {
    await release();
  }
  const tick = await runSubmitPrep();
  assert.deepEqual(tick.submitted, ['IDD-1'], JSON.stringify(tick.errors));
  assert.equal(count('s4_submit_started'), 1);
  // opened once: the next tick finds the card up
  assert.deepEqual((await runSubmitPrep()).submitted, []);
  assert.equal(count('s4_submit_started'), 1);
});

// ---- the local completion ----

/** a lane at its submit card whose change is records only: its submit completes locally */
async function localLane() {
  const f = setup();
  executorSession(f);
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: private decision\n'); commit(f.lane.path);
  record(f, ['lane_open'], ['s1_ready'], ['s1_go'], ['s2_start'], ['s2_result'], ['s3_ready'], ['s3_ok'], ['s4_submit_started']);
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'exact body\n' });
  assert.ok(!p.error, p.error); assert.equal(p.mode, 'local');
  return { f, p };
}

test('a local completion that finds the gate busy closes nothing and can be pressed again', async () => {
  const { f, p } = await localLane();
  const release = await holdGate(f);
  let busy;
  try {
    busy = await approveShip(p.token);
  } finally {
    await release();
  }
  assert.equal(busy.ok, false);
  assert.equal(busy.error, LANE_GATE_BUSY_MESSAGE);
  assert.equal(count('lane_close'), 0);
  assert.equal(count('s4_local_completed'), 0);
  assert.notEqual(readProposal('IDD-1').status, 'complete', 'the submit is not marked complete');
  const again = await approveShip(p.token);
  assert.equal(again.ok, true, again.error);
  assert.equal(count('s4_local_completed'), 1);
  assert.equal(count('lane_close'), 1);
  assert.equal(lane().find((e) => e.event === 'lane_close').attrs.outcome, 'local');
});

test('a local completion that reaches a lane closed meanwhile does not close it again', async () => {
  const { f, p } = await localLane();
  // the gate is held while the completion brings the records back; the holder closes the lane before letting go
  const release = await holdGate(f, '20000');
  const shipping = approveShip(p.token);
  const reclaimed = join(f.work, '_docs/intent/demo/idd-1/decision.md');
  for (let i = 0; i < 200 && !existsSync(reclaimed); i += 1) await sleep(50);
  assert.ok(existsSync(reclaimed), 'the records came back before the close');
  record(f, ['lane_close', { outcome: 'aborted' }]);
  await release();
  const r = await shipping;
  assert.equal(r.ok, false);
  assert.match(r.error, /既に閉じています/);
  assert.equal(count('lane_close'), 1);
  assert.equal(count('s4_local_completed'), 0);
  assert.notEqual(readProposal('IDD-1').status, 'complete');
});

// ---- the stage asked again inside the gate (`require: notAtSubmit`) ----

/** penne's send-back from the submit card, as `s4_revise` records it */
const SENT_BACK = ['s4_verify_user_judgment_answered', { outcome: 'revise', instruction: '直す' }];

test('a local completion that waits for the gate while penne sends the lane back does not close it', async () => {
  const { f, p } = await localLane();
  const release = await holdGate(f, '20000');
  // the completion looked at the stage (at the submit card) and brought the records back; it waits for the gate
  const shipping = approveShip(p.token);
  const reclaimed = join(f.work, '_docs/intent/demo/idd-1/decision.md');
  for (let i = 0; i < 200 && !existsSync(reclaimed); i += 1) await sleep(50);
  assert.ok(existsSync(reclaimed), 'the completion got past its first look at the stage');
  // the holder is the send-back: it records the lane's return to S2 before letting go
  record(f, SENT_BACK);
  await release();
  const r = await shipping;
  assert.equal(r.ok, false);
  assert.match(r.error, /提出前確認の段にない/);
  assert.equal(count('lane_close'), 0, 'the lane sent back is not closed');
  assert.equal(count('s4_local_completed'), 0);
  assert.equal(count('s4_ship_failed'), 0, 'a refusal is not a failed submit');
  assert.notEqual(readProposal('IDD-1').status, 'complete');
});

/** a lane at its submit card with a public change: its approval pushes. The gh on PATH logs what it was asked */
async function publishLane() {
  const f = setup();
  executorSession(f);
  put(join(f.lane.path, 'app.txt'), 'published\n'); commit(f.lane.path, 'feat: change');
  record(f, ['lane_open'], ['s1_ready'], ['s1_go'], ['s2_start'], ['s2_result'], ['s3_ready'], ['s3_ok'], ['s4_submit_started']);
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'exact body\n' });
  assert.ok(!p.error, p.error); assert.equal(p.mode, 'publish');
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const log = join(bin, 'calls.jsonl');
  put(join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'list') console.log('[]');
if (args[1] === 'create') console.log('https://github.com/test/project/pull/1');`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  const gh = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { f, p, gh };
}

test('a push approval that waits for the gate while penne sends the lane back records no approval and pushes nothing', async () => {
  const { f, p, gh } = await publishLane();
  const release = await holdGate(f, '20000');
  // the approval looked at the stage (at the submit card) and holds the lane's overlay lock; it waits for the gate
  const shipping = approveShip(p.token, { commitMessage: 'feat: 承認した commit', pr: { title: 'feat: exact title', body: 'exact body\n' } });
  const held = join(f.work, '.git', 'idd-overlay.lock');
  for (let i = 0; i < 200 && !existsSync(held); i += 1) await sleep(50);
  assert.ok(existsSync(held), 'the approval got past its first look at the stage');
  record(f, SENT_BACK);
  await release();
  const r = await shipping;
  assert.equal(r.ok, false);
  assert.match(r.error, /提出前確認の段にない/);
  assert.equal(count('s4_push_approved'), 0, 'no approval recorded for the lane sent back');
  assert.equal(count('s4_pushed'), 0);
  assert.equal(count('s4_ship_failed'), 0, 'a refusal is not a failed push');
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing pushed');
  assert.deepEqual(gh().filter((a) => a[1] === 'create'), [], 'no PR');
});

test('an approval on a lane stopped over its budget or by its stalled session says the lane is stopped, not sent back', async () => {
  for (const stop of [['lane_stalled', { role: 'executor', cause: 'error', reason: 'session が落ちた' }], ['lane_over_budget', { cost: 6, limit: 5 }]]) {
    const { f, p } = await localLane();
    record(f, stop);
    const r = await approveShip(p.token);
    assert.equal(r.ok, false, stop[0]);
    assert.match(r.error, /止まって/, stop[0]);
    assert.doesNotMatch(r.error, /差し戻し/, stop[0]);
    assert.equal(count('lane_close'), 0, stop[0]);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

// ---- the close after a merge ----

/** a lane whose PR was merged and taken in: the next close pass closes it (`gh` answers MERGED) */
async function mergedLane() {
  const f = setup();
  executorSession(f);
  put(join(f.lane.path, 'app.txt'), 'published\n'); commit(f.lane.path, 'feat: change');
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'exact body\n' });
  assert.ok(!p.error, p.error);
  const e = approveExport(p.token, { message: 'feat: merged change' }); assert.equal(e.ok, true, e.error);
  const saved = readProposal('IDD-1'); saved.status = 'complete'; writeFileSync(proposalPath('IDD-1'), JSON.stringify(saved));
  // the PR is merged on the public side and taken in by the work branch
  git(f.upstream, 'fetch', 'origin'); git(f.upstream, 'checkout', 'main'); git(f.upstream, 'merge', '--ff-only', `origin/${f.lane.branch}`); git(f.upstream, 'push', 'origin', 'main');
  const proposed = proposeImport('demo'); assert.ok(!proposed.error, proposed.error);
  const reviewed = await reviewImport('demo', {}); assert.ok(!reviewed.error, reviewed.error);
  const imported = importUpstream('demo', reviewed.token); assert.equal(imported.ok, true, imported.error);
  record(f, ['lane_open'], ['s1_ready'], ['s1_go'], ['s2_start'], ['s2_result'], ['s3_ready'], ['s3_ok'], ['s4_submit_started'], ['s4_pushed'], ['s4_pr_created', { pr_number: 2, pr_url: 'https://github.com/test/project/pull/2' }]);
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  put(join(bin, 'gh'), `#!${process.execPath}\nconsole.log(JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-26T00:00:00Z', mergedBy: { login: 'someone' } }));`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  // every session of the fixture has stopped
  setAgentRunner({ deliver: async () => {}, cwdBusy: () => false, sessionStatus: async () => ({ state: 'stopped', cause: 'finished', at: new Date(0).toISOString() }) });
  return f;
}

test('a merged lane whose close finds the gate busy stays open with its worktree, and the next pass closes it', async () => {
  const f = await mergedLane();
  const release = await holdGate(f);
  let busy;
  try {
    busy = await runClose();
  } finally {
    await release();
  }
  assert.equal(busy[0].worktreeKept, LANE_GATE_BUSY_MESSAGE);
  assert.equal(count('lane_close'), 0);
  assert.ok(existsSync(f.lane.path), 'the worktree is kept');
  const next = await runClose();
  assert.equal(next[0].outcome, 'merged');
  assert.equal(count('lane_close'), 1);
  assert.equal(lane().find((e) => e.event === 'lane_close').attrs.outcome, 'merged');
});

test('a merged lane penne closed while the close pass asked GitHub is not closed a second time', async () => {
  const f = await mergedLane();
  const abort = `require('node:fs').appendFileSync(${JSON.stringify(join(f.state, 'lifecycle-demo.jsonl'))}, JSON.stringify({ idd_id: 'IDD-1', event: 'lane_close', at: new Date().toISOString(), attrs: { outcome: 'aborted' } }) + '\\n');`;
  put(join(f.root, 'bin', 'gh'), `#!${process.execPath}\n${abort}\nconsole.log(JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-26T00:00:00Z', mergedBy: { login: 'someone' } }));`);
  const r = await runClose();
  assert.match(String(r[0].worktreeKept), /既に閉じています/);
  assert.equal(count('lane_close'), 1);
  assert.equal(lane().find((e) => e.event === 'lane_close').attrs.outcome, 'aborted');
});

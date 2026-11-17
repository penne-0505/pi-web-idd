import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { exportLane, proposeForTests as propose } from '../src/overlay/export.ts';
import { reclaimLane } from '../src/overlay/reclaim.ts';
import { runShip } from '../src/plan/ship.ts';
import { runClose } from '../src/plan/close.ts';
import { ignoreLane } from '../src/intake/ignore.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { parseIntent } from '../src/intent/parse.ts';
import { changedFiles } from '../src/worktree/changed-files.ts';
import { laneBranchSource } from '../src/worktree/ensure.ts';
import { pushApproval, shipApproved } from './passkey-approval.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const approveExport = (token, approval) => exportLane('IDD-1', token, pushApproval('IDD-1', approval));
const approveShip = (token, approval) => runShip('IDD-1', token, shipApproved('IDD-1', approval));
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); }

/** the runner the server registers: every session of the fixture has stopped unless a test says otherwise */
function runner(status = {}, busy = () => false) {
  setAgentRunner({ deliver: async () => {}, cwdBusy: busy, sessionStatus: async (id) => status[id] ?? { state: 'stopped', cause: 'finished', at: new Date(0).toISOString() } });
}
// each fixture holds a few git repos: they go when the test is done
const roots = [];
afterEach(() => {
  setAgentRunner(null); process.chdir(original);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
  const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change' }) + '\n');
  put(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, planner_session_id: 'planner-session' }) + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, executor_session_id: 'executor-session' }) + '\n');
  process.chdir(work);
  return { root, work, state, lane, areas, config };
}

const events = (name) => readLifecycle().filter((e) => e.idd_id === 'IDD-1' && e.event === name);
const branchExists = (f) => git(f.work, 'branch', '--list', f.lane.branch) !== '';
function record(f, ...names) {
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), names.map((event) => JSON.stringify({ idd_id: 'IDD-1', event, at: new Date().toISOString(), attrs: {} })).join('\n') + '\n');
}

test('an aborted lane with nothing left to lose gives up its worktree on the next close pass, and keeps its branch', async () => {
  const f = setup(); runner();
  assert.equal((await ignoreLane('IDD-1')).ok, true);
  await runClose();
  assert.equal(existsSync(f.lane.path), false, 'the worktree is removed');
  assert.ok(branchExists(f), 'the branch stays');
  assert.equal(events('lane_worktree_retired').length, 1);
  await runClose();
  assert.equal(events('lane_worktree_retired').length, 1, 'retired once');
});

test('a lane stopped at GO, whose records were brought to the work branch, gives up its worktree too', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: plan\n'); commit(f.lane.path);
  record(f, 'lane_open', 's1_ready');
  assert.equal((await ignoreLane('IDD-1', { reason: 'not now' })).ok, true);
  assert.equal(reclaimLane('IDD-1').ok, true);
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
  assert.ok(branchExists(f));
});

test('a lane completed without a PR gives up its worktree once it is closed', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: private decision\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'exact body\n' });
  assert.ok(!p.error, p.error); assert.equal(p.mode, 'local');
  // the approval is taken only at the submit card
  record(f, 's4_submit_started');
  assert.equal((await approveShip(p.token)).ok, true);
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
});

test('a dirty worktree of an aborted lane is kept, and the reason is recorded once', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, 'scratch.txt'), 'not committed');
  await ignoreLane('IDD-1');
  const first = await runClose();
  assert.ok(existsSync(join(f.lane.path, 'scratch.txt')));
  const kept = events('lane_worktree_kept');
  assert.equal(kept.length, 1);
  assert.match(String(kept[0].attrs.reason), /commit していない/);
  assert.match(String(first.find((r) => r.iddId === 'IDD-1')?.worktreeKept), /commit していない/);
  await runClose();
  assert.equal(events('lane_worktree_kept').length, 1, 'the same reason is not recorded again');
  assert.equal(events('lane_worktree_retired').length, 0);
});

test('records committed on an aborted lane and not brought to the work branch do not keep the worktree', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: plan\n'); commit(f.lane.path);
  await ignoreLane('IDD-1');
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
  assert.ok(branchExists(f), 'the records stay on the branch');
});

test('a fix committed on a dropped lane and never pushed does not keep the worktree', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  await ignoreLane('IDD-1', { reason: 'not now' });
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
  assert.ok(git(f.work, 'log', '--format=%H', '-1', f.lane.branch), 'the fix stays on the branch');
});

test('a lane stopped at GO with records not brought back gives up its worktree', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: plan\n'); commit(f.lane.path);
  record(f, 'lane_open', 's1_ready');
  await ignoreLane('IDD-1', { reason: 'not now' });
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
});

test('a merged lane with a fix never pushed keeps its worktree', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 'lane_close', at: new Date().toISOString(), attrs: { outcome: 'merged' } }) + '\n');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.match(String(events('lane_worktree_kept')[0]?.attrs.reason), /push していない/);
});

test('a lane completed locally with records committed after its reclaim keeps its worktree', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: private decision\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'exact body\n' });
  assert.ok(!p.error, p.error);
  // the approval is taken only at the submit card
  record(f, 's4_submit_started');
  assert.equal((await approveShip(p.token)).ok, true);
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: private decision\n\nlater note\n'); commit(f.lane.path);
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.match(String(events('lane_worktree_kept')[0]?.attrs.reason), /記録/);
});

test('an aborted lane whose fixes were all pushed gives up its worktree', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'exact body\n' });
  assert.ok(!p.error, p.error);
  assert.equal(approveExport(p.token, { message: 'feat: exact title' }).ok, true);
  await ignoreLane('IDD-1');
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
});

test('a lane only paused (stopped agent, over its budget) keeps its worktree without a record', async () => {
  const f = setup(); runner();
  record(f, 'lane_open', 's1_ready', 's1_go', 's2_start', 'lane_stalled');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 'lane_over_budget', at: new Date().toISOString(), attrs: { cost: 6, limit: 5 } }) + '\n');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.equal(events('lane_worktree_kept').length + events('lane_worktree_retired').length, 0);
});

test('a lane put on hold at S3 is left alone', async () => {
  const f = setup(); runner();
  record(f, 'lane_open', 's3_defer');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.equal(events('lane_worktree_kept').length + events('lane_worktree_retired').length, 0);
});

test('an aborted lane whose session still runs keeps its worktree', async () => {
  const f = setup(); runner({ 'executor-session': { state: 'running' } });
  await ignoreLane('IDD-1');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.match(String(events('lane_worktree_kept')[0]?.attrs.reason), /session/);
});

test('without the agent runtime nothing is retired, since a running session cannot be told apart', async () => {
  const f = setup();
  await ignoreLane('IDD-1');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.equal(events('lane_worktree_kept').length + events('lane_worktree_retired').length, 0);
});

test('a pushed merged lane is not held by a path the work branch later adds to its manifest', async () => {
  const f = setup(); runner();
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'exact body\n' });
  assert.ok(!p.error, p.error);
  assert.equal(approveExport(p.token, { message: 'feat: exact title' }).ok, true);
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 'lane_close', at: new Date().toISOString(), attrs: { outcome: 'merged' } }) + '\n');
  put(join(f.work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n.gitignore\n'); commit(f.work);
  await runClose();
  assert.equal(existsSync(f.lane.path), false, String(events('lane_worktree_kept')[0]?.attrs.reason));
});

test('an aborted lane whose HEAD left its branch keeps its worktree', async () => {
  const f = setup(); runner();
  git(f.lane.path, 'checkout', '-q', '--detach');
  put(join(f.lane.path, 'app.txt'), 'on no branch\n'); commit(f.lane.path);
  await ignoreLane('IDD-1');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.match(String(events('lane_worktree_kept')[0]?.attrs.reason), /HEAD が lane の branch/);
});

test('a worktree outside the lanes root is never removed', async () => {
  const f = setup(); runner();
  put(f.areas, JSON.stringify({ repos: { demo: { ...f.config, lanes_root: join(f.root, 'elsewhere') } } }));
  await ignoreLane('IDD-1');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.match(String(events('lane_worktree_kept')[0]?.attrs.reason), /置き場の外/);
});

test('an overlay step holding the repo defers the retirement to the next pass, without a record', async () => {
  const f = setup(); runner();
  const held = join(f.work, '.git', 'idd-overlay.lock'); mkdirSync(held);
  await ignoreLane('IDD-1');
  const first = await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.equal(first.find((r) => r.iddId === 'IDD-1')?.worktreeKept, 'overlay の処理中です');
  assert.equal(events('lane_worktree_kept').length, 0);
  rmdirSync(held);
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
});

test('a session not known to have stopped keeps the worktree', async () => {
  for (const state of ['unknown', 'quota_wait']) {
    const f = setup(); runner({ 'planner-session': { state, reason: 'windows', at: new Date().toISOString() } });
    await ignoreLane('IDD-1');
    await runClose();
    assert.ok(existsSync(f.lane.path), state);
    assert.match(String(events('lane_worktree_kept')[0]?.attrs.reason), new RegExp(`確かめられません（${state}）`));
  }
});

test('another session working in the checkout keeps the worktree', async () => {
  const f = setup(); runner({}, (cwd) => cwd === f.lane.path);
  await ignoreLane('IDD-1');
  await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.match(String(events('lane_worktree_kept')[0]?.attrs.reason), /動いている session/);
});

test('a retired lane is still read from its branch: its plan and the files it changed', async () => {
  const f = setup(); runner();
  const start = git(f.lane.path, 'rev-parse', 'HEAD');
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: plan on the branch\n');
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), '- AC-001: it works\n');
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  assert.equal(laneBranchSource('demo', f.lane.path, f.lane.branch), undefined, 'not while the worktree is there');
  await ignoreLane('IDD-1');
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
  const branch = laneBranchSource('demo', f.lane.path, f.lane.branch);
  assert.ok(branch);
  const intent = parseIntent('demo', 'idd-1', { root: f.lane.path, branch });
  assert.deepEqual(intent.decisions.map((d) => d.id), ['DEC-900']);
  assert.deepEqual(intent.criteria.map((c) => c.id), ['AC-001']);
  assert.deepEqual(changedFiles(f.lane.path, start, branch).map((c) => c.path).sort(), ['_docs/intent/demo/idd-1/decision.md', '_docs/qa/demo/idd-1/qa.md', 'app.txt']);
  assert.deepEqual(parseIntent('demo', 'idd-1', { root: f.lane.path }).decisions, [], 'without the branch the plan is gone');
});

test('a lane penne took out — aborted, dropped, started over, or stopped at GO — gives up its worktree', async () => {
  // every form `discarded` reads: an ignore's close, the drop at the re-take card, a redo's close, and the stop
  // at GO. One form left out of `discarded` means that lane's worktree is never retired.
  const forms = {
    'lane_close outcome aborted（ignore）': ['lane_close', { outcome: 'aborted', via: 'ignore' }],
    'lane_close outcome dropped（取り込み直しの見送り）': ['lane_close', { outcome: 'dropped' }],
    'lane_close outcome redone（lane redo）': ['lane_close', { outcome: 'redone', redo_to: 'IDD-2' }],
    's1_defer（GO の前の中止。古い記録）': ['s1_defer', { reason: 'not now' }],
  };
  for (const [name, [event, attrs]] of Object.entries(forms)) {
    const f = setup(); runner();
    appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event, at: new Date().toISOString(), attrs }) + '\n');
    await runClose();
    assert.equal(existsSync(f.lane.path), false, `${name}: the worktree is removed`);
    assert.ok(branchExists(f), `${name}: the branch stays`);
    assert.equal(events('lane_worktree_retired').length, 1, `${name}: retired once`);
  }
});

test('AC-013: a lock held for the checks defers the retirement too, and the next pass retires it', async () => {
  const f = setup(); runner();
  const held = join(f.work, '.git', 'idd-overlay.lock'); mkdirSync(held);
  writeFileSync(join(held, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), checks: true }));
  await ignoreLane('IDD-1');
  const first = await runClose();
  assert.ok(existsSync(f.lane.path));
  assert.equal(first.find((r) => r.iddId === 'IDD-1')?.worktreeKept, 'overlay の処理中です');
  rmSync(held, { recursive: true, force: true });
  await runClose();
  assert.equal(existsSync(f.lane.path), false);
});

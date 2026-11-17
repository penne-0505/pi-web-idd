import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { runPrep } from '../src/plan/prep.ts';
import { runExec } from '../src/plan/exec.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { startLaneWorktree } from '../src/worktree/prepare.ts';
import { batchSetup, git, put } from './helpers/batch-fixture.mjs';

const SECRET = 'sekret-value-1234567';
const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const clean = (p) => git(p.lane(), 'status', '--porcelain', '--untracked-files=all');

/**
 * A project whose work clone holds an ignored `.env` and declares `copy` and `setup`, with the lane IDD-1 open and no
 * worktree cut for it yet. `tracked` adds files the clone tracks, `untracked` files it holds untracked.
 */
function project({ copy = [], setup = [], ignore = '.env\ncount.txt\nnode_modules\n', tracked = {}, untracked = { '.env': `TOKEN=${SECRET}\n` } } = {}) {
  const f = batchSetup({ ids: [], files: { '.gitignore': ignore, 'app.txt': 'a\n', ...tracked }, extra: { copy, setup } });
  for (const [path, text] of Object.entries(untracked)) put(join(f.work, path), text);
  const repos = join(f.root, 'repos.yaml');
  const declare = (c, s) => { const file = JSON.parse(readFileSync(repos, 'utf8')); Object.assign(file.repos.demo, { copy: c, setup: s }); put(repos, JSON.stringify(file)); };
  const roles = join(f.root, 'roles.json');
  put(roles, JSON.stringify({ models: { 'x-y': { model: 'x/y' } }, roles: { r: { model: 'x-y' } }, pipeline: { planner: { role: 'r', concurrency: 1 }, executor: { role: 'r', concurrency: 1 } } }));
  process.env.IDD_ROLES_FILE = roles;
  put(join(f.state, 'backlog.jsonl'), lines([{ idd_id: 'IDD-1', area: 'demo', title: 'feat: IDD-1', source_type: 'github', gh_issue_url: 'https://github.com/test/demo/issues/1' }]));
  const open = (names) => put(join(f.state, 'lifecycle-demo.jsonl'), lines(names.map((event, i) => ({ event, idd_id: 'IDD-1', at: `2026-09-25T07:0${i}:00+09:00`, attrs: {} }))));
  open(['lane_open']);
  return { ...f, declare, open, lane: () => join(f.root, 'lanes', 'IDD-1') };
}

/** the runner that records where each spawn happened and what `look` found there */
function watching(look) {
  const seen = [];
  setAgentRunner({ spawn: async (o) => { seen.push({ lane: o.laneId, ...look(o.cwd) }); return { sessionId: 'S-1' }; }, deliver: async () => {} });
  return seen;
}

test('AC-001: a new lane worktree holds the declared file before the planner starts', async () => {
  const p = project({ copy: ['.env'] });
  const seen = watching((cwd) => ({ env: existsSync(join(cwd, '.env')) }));
  const r = await runPrep();
  setAgentRunner(null);
  assert.deepEqual(seen, [{ lane: 'IDD-1', env: true }], JSON.stringify(r.skipped));
  assert.equal(readFileSync(join(p.lane(), '.env'), 'utf8'), `TOKEN=${SECRET}\n`);
  assert.equal(clean(p), '', 'the copied file is ignored, so the lane starts clean');
});

test('AC-001: a worktree that exists, and one whose file went missing, are made good by the next start step', async () => {
  const p = project({ copy: ['.env'] });
  const cut = ensureLaneWorktree('demo', 'IDD-1');
  assert.equal(existsSync(join(cut.path, '.env')), false, 'cut before the declaration was honoured: nothing there');
  await startLaneWorktree('demo', 'IDD-1');
  assert.equal(existsSync(join(p.lane(), '.env')), true);
  rmSync(join(p.lane(), '.env'));
  await startLaneWorktree('demo', 'IDD-1');
  assert.equal(readFileSync(join(p.lane(), '.env'), 'utf8'), `TOKEN=${SECRET}\n`);
});

test('AC-001: the executor start step fills the file too', async () => {
  const p = project({ copy: ['.env'] });
  p.open(['lane_open', 's1_ready', 's1_go']);
  const cut = ensureLaneWorktree('demo', 'IDD-1');
  put(join(p.state, 'planner-sessions.jsonl'), lines([{ idd_id: 'IDD-1', planner_session_id: 'P-1', worktree_path: cut.path }]));
  put(join(cut.path, '_docs', 'intent', 'demo', 'idd-1', 'decision.md'), '### DEC-1: x\n\n- **Anchors**: `app.txt`\n');
  const seen = watching((cwd) => ({ env: existsSync(join(cwd, '.env')) }));
  await runExec();
  setAgentRunner(null);
  assert.deepEqual(seen, [{ lane: 'IDD-1', env: true }]);
});

test('AC-001: a repo that declares nothing is left alone', async () => {
  const p = project({ untracked: {} });
  const lane = await startLaneWorktree('demo', 'IDD-1');
  assert.equal(lane.path, p.lane());
  assert.equal(existsSync(join(lane.path, '.env')), false);
});

test('AC-002/003: setup runs once per worktree, again only when the declaration changed, and leaves no trace in the lane', async () => {
  const p = project({ setup: ['echo run >> count.txt; ln -sfn "$PWD" node_modules'] });
  const runs = () => readFileSync(join(p.lane(), 'count.txt'), 'utf8').trim().split('\n').length;
  await startLaneWorktree('demo', 'IDD-1');
  assert.equal(runs(), 1);
  assert.equal(existsSync(join(p.lane(), 'node_modules')), true, 'what setup made is there for the planner');
  await startLaneWorktree('demo', 'IDD-1');
  await startLaneWorktree('demo', 'IDD-1');
  assert.equal(runs(), 1, 'a later stage does not run it again');
  assert.equal(clean(p), '', 'the marker is not in the lane\'s diff');
  p.declare([], ['echo run >> count.txt; echo second >> count.txt']);
  await startLaneWorktree('demo', 'IDD-1');
  assert.equal(runs(), 3, 'a changed declaration runs again');
});

test('AC-004: a path that is missing, tracked, or not ignored is not copied and the step does not start', async () => {
  const cases = [
    ['missing', { copy: ['.env'], untracked: {} }, '.env'],
    ['tracked', { copy: ['conf.txt'], tracked: { 'conf.txt': `K=${SECRET}\n` }, untracked: {} }, 'conf.txt'],
    ['not ignored', { copy: ['local.txt'], untracked: { 'local.txt': `K=${SECRET}\n` } }, 'local.txt'],
  ];
  for (const [name, config, path] of cases) {
    const p = project(config);
    const seen = watching(() => ({}));
    const r = await runPrep();
    setAgentRunner(null);
    assert.deepEqual(seen, [], name);
    const why = JSON.stringify(r.skipped);
    assert.ok(why.includes(path), `${name}: names the path: ${why}`);
    assert.ok(!why.includes(SECRET), `${name}: no value in the reason`);
    // the tracked file is the clone's own, and is what the worktree holds; the others are not written
    assert.equal(existsSync(join(p.lane(), path)), name === 'tracked', name);
    if (name === 'not ignored') assert.equal(clean(p), '', 'the lane did not start dirty');
  }
});

test('AC-004: every unmet path is named at once', async () => {
  project({ copy: ['.env', 'a.txt', '../out.txt'], untracked: {} });
  await assert.rejects(() => startLaneWorktree('demo', 'IDD-1'), (e) => /\.env/.test(e.message) && /a\.txt/.test(e.message) && /out\.txt/.test(e.message));
});

test('AC-001/004: a declared path that is a broken link or a directory in the worktree stops the step, and nothing is written through it', async () => {
  for (const [name, make] of [
    ['broken link', (dst, out) => symlinkSync(out, dst)],
    ['directory', (dst) => mkdirSync(dst)],
  ]) {
    const p = project({ copy: ['.env'] });
    const cut = ensureLaneWorktree('demo', 'IDD-1');
    const out = join(p.root, `outside-${name.replace(' ', '-')}.txt`);
    make(join(cut.path, '.env'), out);
    await assert.rejects(() => startLaneWorktree('demo', 'IDD-1'), (e) => /\.env/.test(e.message) && !e.message.includes(SECRET), name);
    assert.equal(existsSync(out), false, `${name}: nothing was written through the link`);
    // once the stand-in is removed the next step fills the file
    rmSync(join(cut.path, '.env'), { recursive: true, force: true });
    await startLaneWorktree('demo', 'IDD-1');
    assert.equal(readFileSync(join(cut.path, '.env'), 'utf8'), `TOKEN=${SECRET}\n`, name);
  }
});

test('AC-005: a failing setup stops the step with the command and the tail of its output, without the copied value', async () => {
  project({ copy: ['.env'], setup: [`echo "token ${SECRET}" ; echo boom >&2; exit 3`] });
  await assert.rejects(() => startLaneWorktree('demo', 'IDD-1'), (e) => {
    assert.match(e.message, /準備のコマンドが失敗しました/);
    assert.match(e.message, /exit 3|boom/);
    assert.ok(!e.message.includes(SECRET));
    return true;
  });
  const seen = watching(() => ({}));
  const r = await runPrep();
  setAgentRunner(null);
  assert.deepEqual(seen, [], 'the step did not go on to the spawn');
  assert.equal(r.skipped.length > 0, true);
});

test('AC-005: a failing setup does not print a value only the lane\'s own copied file holds', async () => {
  const OWN = 'lane-only-value-7654321';
  const p = project({ copy: ['.env'], setup: [`echo "token ${OWN}"; exit 3`] });
  ensureLaneWorktree('demo', 'IDD-1');
  put(join(p.lane(), '.env'), `TOKEN=${OWN}\n`);
  await assert.rejects(() => startLaneWorktree('demo', 'IDD-1'), (e) => /準備のコマンドが失敗しました/.test(e.message) && !e.message.includes(OWN) && !e.message.includes(SECRET));
});

test('AC-003: preparations of one worktree that overlap run the setup once', async () => {
  const p = project({ setup: ['echo x >> count.txt; sleep 1'] });
  ensureLaneWorktree('demo', 'IDD-1');
  const results = await Promise.all([startLaneWorktree('demo', 'IDD-1'), startLaneWorktree('demo', 'IDD-1'), startLaneWorktree('demo', 'IDD-1')]);
  assert.equal(results.length, 3);
  assert.equal(readFileSync(join(p.lane(), 'count.txt'), 'utf8'), 'x\n');
});

test('AC-005: a setup past its limit is stopped and the step does not start', async () => {
  project({ setup: ['echo started; sleep 60'] });
  const began = Date.now();
  await assert.rejects(() => startLaneWorktree('demo', 'IDD-1', { minutes: 0.01 }), (e) => /準備のコマンドが失敗しました/.test(e.message));
  assert.ok(Date.now() - began < 20000, 'killed at the limit, not waited out');
});

test('AC-005: a setup that changes a tracked file stops the step, and the next run is judged against the state before it', async () => {
  const p = project({ setup: ['echo changed >> app.txt'] });
  const stops = () => assert.rejects(() => startLaneWorktree('demo', 'IDD-1'), (e) => /app\.txt/.test(e.message) && /準備が/.test(e.message));
  await stops();
  assert.match(git(p.lane(), 'status', '--porcelain'), /app\.txt/, 'the change is left for a person to see');
  await stops();
});

/** the step stops, its reason matches `pattern`, and it never holds the copied or written secret */
const stopsOn = (pattern) => assert.rejects(() => startLaneWorktree('demo', 'IDD-1'), (e) => pattern.test(e.message) && !e.message.includes(SECRET));
const failsToRun = () => assert.rejects(() => startLaneWorktree('demo', 'IDD-1'), (e) => /準備のコマンドが失敗しました/.test(e.message));

test('AC-005: a setup that failed after changing a tracked file does not let the next run take the residue as the start', async () => {
  const p = project({ setup: ['echo changed >> app.txt; exit 1'] });
  await failsToRun();
  p.declare([], ['true']);
  await stopsOn(/app\.txt/);
  await stopsOn(/app\.txt/);
});

test('AC-005: a declaration changed again after a failed setup still answers to the state before the first run', async () => {
  const p = project({ setup: ['echo changed >> app.txt; exit 1'] });
  await failsToRun();
  p.declare([], ['true']);
  await stopsOn(/app\.txt/);
  p.declare([], ['true; true']);
  await stopsOn(/app\.txt/);
});

test('AC-005: a setup that overwrites an untracked file in place stops the step, naming the path and not the content', async () => {
  const p = project({ untracked: {} });
  await startLaneWorktree('demo', 'IDD-1');
  put(join(p.lane(), 'note.txt'), 'mine\n');
  p.declare([], [`echo "${SECRET}" > note.txt`]);
  await stopsOn(/note\.txt/);
  assert.equal(readFileSync(join(p.lane(), 'note.txt'), 'utf8').trim(), SECRET, 'the damage is left for a person to see');
});

test('AC-005: a setup that commits a tracked change moves HEAD and stops the step, from a clean worktree and from a dirty one', async () => {
  const commit = 'echo changed >> app.txt; git -c user.name=t -c user.email=t@t commit -qam setup';
  const p = project({ untracked: {} });
  await startLaneWorktree('demo', 'IDD-1');
  p.declare([], [commit]);
  await stopsOn(/HEAD が動きました/);

  const q = project({ untracked: {} });
  await startLaneWorktree('demo', 'IDD-1');
  put(join(q.lane(), 'note.txt'), 'mine\n');
  q.declare([], [commit]);
  await stopsOn(/HEAD が動きました/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runLand, computeLandForecasts } from '../src/plan/land.ts';
import { buildSubmit } from '../src/plan/ship.ts';
import { readLandForecast, pairKey, landForecastCounts, readLand, approveLand, landForecastFor } from '../src/overlay/land.ts';
import { runningLandRuns } from '../src/overlay/land-run.ts';
import { landApproved } from './passkey-approval.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { GEN, TOP, TOP_OTHER, BOTTOM, builds, seedGenerated } from './helpers/generated-fixture.mjs';

const original = process.cwd();
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_ALLOW_PROTOCOL: 'file', IDD_LANE_SCOPE: 'off',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(20); }
  throw new Error('待ちが timeout しました');
}
/**
 * The tick's landing pass, with the checks it started waited for: the checks run in a process of their own now
 * (C-144-1), and this suite reads the records right after the pass.
 */
async function runLandAndSettle() {
  const res = await runLand();
  await waitFor(() => runningLandRuns().length === 0);
  return res;
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

/** a project with one or more work clones, each with a lane per Issue; every repo does not publish by default */
function setup({ repos = { demo: {} }, lanes = { demo: ['IDD-1'] } } = {}) {
  process.chdir(original);
  const root = scratchDir('idd-forecast-');
  const state = join(root, 'state');
  mkdirSync(state);
  const config = {};
  for (const [area, extra] of Object.entries(repos)) {
    const work = join(root, `${area}-work`);
    const remote = join(root, `${area}-remote.git`);
    const upstream = join(root, `${area}-upstream`);
    mkdirSync(work);
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(work, 'init', '--initial-branch=main');
    put(join(work, '.gitignore'), 'node_modules/\n');
    put(join(work, 'app.txt'), 'one\n');
    put(join(work, 'other.txt'), 'one\n');
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
    config[area] = {
      github: `test/${area}`, upstream, work, work_base: 'work-main', public_base: 'main',
      lanes_root: join(root, `${area}-lanes`), checks: [],
      ...(extra.publish === true ? { publish: true } : { publish: false }),
      ...(extra.generated_files ? { generated_files: extra.generated_files } : {}),
      issue_lane: { context: 'personal', source_type_priority: 'github' },
    };
  }
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: config }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const made = {};
  const backlog = [];
  const sessions = [];
  for (const [area, ids] of Object.entries(lanes)) {
    for (const iddId of ids) {
      const lane = ensureLaneWorktree(area, iddId);
      made[iddId] = lane;
      backlog.push({ idd_id: iddId, area, title: `feat: ${iddId}`, source_type: 'github', gh_issue_url: `https://github.com/test/${area}/issues/1` });
      sessions.push({ idd_id: iddId, worktree_path: lane.path, branch: lane.branch, executor_session_id: `s-${iddId}` });
    }
  }
  put(join(state, 'backlog.jsonl'), backlog.map((r) => JSON.stringify(r)).join('\n') + '\n');
  put(join(state, 'executor-sessions.jsonl'), sessions.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.chdir(config.demo.work);
  return { root, work: config.demo.work, remote: config.demo.remote, upstream: config.demo.upstream, state, lanes: made, repos: config, areas };
}

const laneTip = (f, id) => git(f.lanes[id].path, 'rev-parse', 'HEAD');
const mainTip = (f, area = 'demo') => git(f.repos[area].work, 'rev-parse', 'refs/heads/work-main');
const change = (f, id, files) => { for (const [name, text] of Object.entries(files)) put(join(f.lanes[id].path, name), text); commit(f.lanes[id].path, `feat: ${id}`); };

/** put a lane at the submit confirmation with its landing card, so `runLand` counts it */
async function atShip(id) {
  await seedLifecycle('lane_open', id, {});
  await seedLifecycle('s2_start', id, {});
  await seedLifecycle('s2_result', id, {});
  await seedLifecycle('s3_ready', id, {});
  await seedLifecycle('s3_ok', id, {});
  await seedLifecycle('s4_submit_started', id, {});
}

const resetCounts = () => { landForecastCounts.merges = 0; landForecastCounts.files = 0; };

test('two cards that change the same line get a forecast naming the other lane and the file', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  resetCounts();
  await runLandAndSettle();
  const group = readLandForecast(f.work);
  assert.ok(group, 'the forecast is saved for a repo with two cards');
  assert.equal(group.mainTip, mainTip(f));
  assert.deepEqual(group.heads, { 'IDD-1': laneTip(f, 'IDD-1'), 'IDD-2': laneTip(f, 'IDD-2') });
  assert.deepEqual(group.mainline['IDD-1'], { conflict: false, files: [] }, 'the mainline has not moved');
  const pair = group.pairs[pairKey('IDD-1', 'IDD-2')];
  assert.equal(pair.conflict, true);
  assert.deepEqual(pair.files, ['app.txt']);
  // both cards carry it, the other lane's id and the file name
  for (const [id, other] of [['IDD-1', 'IDD-2'], ['IDD-2', 'IDD-1']]) {
    const forecast = buildSubmit(id).conflictForecast;
    assert.deepEqual(forecast.mainline, { conflict: false, files: [] });
    assert.deepEqual(forecast.others, [{ lane: other, conflict: true, files: ['app.txt'] }]);
  }
});

test('a repo with one card saves no forecast, and lanes of another repo are never paired', async () => {
  const one = setup();
  change(one, 'IDD-1', { 'app.txt': 'from one\n' });
  await atShip('IDD-1');
  await runLandAndSettle();
  assert.equal(readLandForecast(one.work), null);
  // two repos, one card each: neither gets a forecast
  const two = setup({ repos: { demo: {}, other: {} }, lanes: { demo: ['IDD-1'], other: ['IDD-9'] } });
  change(two, 'IDD-1', { 'app.txt': 'from one\n' });
  change(two, 'IDD-9', { 'app.txt': 'from nine\n' });
  await atShip('IDD-1');
  await atShip('IDD-9');
  await runLandAndSettle();
  assert.equal(readLandForecast(two.repos.demo.work), null);
  assert.equal(readLandForecast(two.repos.other.work), null);
});

test('a third card changing another file conflicts with no one', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2', 'IDD-3'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  change(f, 'IDD-3', { 'other.txt': 'from three\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await atShip('IDD-3');
  await runLandAndSettle();
  const group = readLandForecast(f.work);
  assert.equal(group.pairs[pairKey('IDD-1', 'IDD-3')], undefined, 'a pair that shares no file is not trial-merged');
  const forecast = buildSubmit('IDD-3').conflictForecast;
  assert.deepEqual(forecast.mainline, { conflict: false, files: [] });
  assert.equal(forecast.others.length, 2);
  assert.deepEqual(forecast.others.map((o) => [o.lane, o.conflict]), [['IDD-1', false], ['IDD-2', false]]);
});

test('the forecast is read-only: no ref, no worktree and no lifecycle record moves', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'other.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  const before = {
    refs: git(f.work, 'for-each-ref'),
    worktrees: git(f.work, 'worktree', 'list'),
    workStatus: git(f.work, 'status', '--porcelain', '--untracked-files=all'),
    laneStatus: git(f.lanes['IDD-1'].path, 'status', '--porcelain', '--untracked-files=all'),
    events: readLifecycle().length,
  };
  computeLandForecasts();
  assert.equal(git(f.work, 'for-each-ref'), before.refs);
  assert.equal(git(f.work, 'worktree', 'list'), before.worktrees);
  assert.equal(git(f.work, 'status', '--porcelain', '--untracked-files=all'), before.workStatus);
  assert.equal(git(f.lanes['IDD-1'].path, 'status', '--porcelain', '--untracked-files=all'), before.laneStatus);
  assert.equal(readLifecycle().length, before.events);
});

test('pairs are trial-merged only where the changed files overlap', async () => {
  const disjoint = setup({ lanes: { demo: ['IDD-1', 'IDD-2', 'IDD-3'] } });
  change(disjoint, 'IDD-1', { 'a.txt': 'a\n' });
  change(disjoint, 'IDD-2', { 'b.txt': 'b\n' });
  change(disjoint, 'IDD-3', { 'c.txt': 'c\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await atShip('IDD-3');
  resetCounts();
  computeLandForecasts();
  const group = readLandForecast(disjoint.work);
  assert.deepEqual(Object.keys(group.pairs), [], 'no overlapping pair is trial-merged');
  assert.equal(landForecastCounts.merges, 3, 'one trial merge per lane against the mainline');
  assert.equal(landForecastCounts.files, 3, 'one changed-file read per lane');
  // two of three overlap on one file
  const mixed = setup({ lanes: { demo: ['IDD-1', 'IDD-2', 'IDD-3'] } });
  change(mixed, 'IDD-1', { 'app.txt': 'from one\n' });
  change(mixed, 'IDD-2', { 'app.txt': 'from two\n' });
  change(mixed, 'IDD-3', { 'c.txt': 'c\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await atShip('IDD-3');
  resetCounts();
  computeLandForecasts();
  const mixedGroup = readLandForecast(mixed.work);
  assert.deepEqual(Object.keys(mixedGroup.pairs), [pairKey('IDD-1', 'IDD-2')]);
  assert.equal(landForecastCounts.merges, 4);
});

test('a forecast is not taken again while the mainline and every head stay put', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  computeLandForecasts();
  resetCounts();
  computeLandForecasts();
  assert.equal(landForecastCounts.merges, 0, 'no trial merge on the same pair');
  assert.equal(landForecastCounts.files, 0, 'no changed-file read on the same pair');
  // one head moves: the forecast is taken again
  change(f, 'IDD-2', { 'app.txt': 'from two again\n' });
  resetCounts();
  computeLandForecasts();
  assert.ok(landForecastCounts.merges > 0);
  assert.ok(landForecastCounts.files > 0);
  assert.equal(readLandForecast(f.work).heads['IDD-2'], laneTip(f, 'IDD-2'));
});

test('the forecast changes no landing: the checked merge commit and its approval stay as they were', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await runLandAndSettle();
  const before = readLand('IDD-1');
  assert.ok(before.mergeCommit);
  computeLandForecasts();
  const after = readLand('IDD-1');
  assert.deepEqual([after.token, after.mergeCommit, after.blocking, after.mainTip, after.head], [before.token, before.mergeCommit, before.blocking, before.mainTip, before.head]);
  // the approval still carries it out
  const landed = await approveLand('IDD-1', before.token, landApproved('IDD-1'));
  assert.equal(landed.ok, true, landed.error);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), before.mergeCommit);
});

test('a stale forecast is not shown: the card asks for the mainline as it is now', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await runLandAndSettle();
  assert.ok(buildSubmit('IDD-1').conflictForecast);
  put(join(f.work, 'main.txt'), 'main\n');
  commit(f.work, 'chore: mainline move');
  assert.equal(buildSubmit('IDD-1').conflictForecast, undefined, 'the saved forecast is for another tip');
  computeLandForecasts();
  assert.equal(buildSubmit('IDD-1').conflictForecast.mainline.conflict, false);
});

test('the cards a settled landing already checked count as partners, and the mainline is read by ref', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  // both checked on the first pass; the second pass still counts both cards
  await runLandAndSettle();
  await runLandAndSettle();
  const forecast = buildSubmit('IDD-1').conflictForecast;
  assert.deepEqual(forecast.others, [{ lane: 'IDD-2', conflict: true, files: ['app.txt'] }]);
  // the checkout sits on another branch ahead of the work branch: the forecast is still the work branch's tip
  const tip = mainTip(f);
  git(f.work, 'checkout', '-b', 'side');
  put(join(f.work, 'side.txt'), 'side\n');
  commit(f.work, 'chore: side move');
  computeLandForecasts();
  const group = readLandForecast(f.work);
  assert.equal(group.mainTip, tip, 'the work branch ref, not the checkout');
  assert.ok(buildSubmit('IDD-1').conflictForecast, 'the card still reads that ref');
});

test('an approved card and a held card are still partners in the forecast', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await runLandAndSettle();
  // IDD-2 is approved and the work checkout is dirty, so its merge waits and the lane stays at the card
  const land = readLand('IDD-2');
  await appendLifecycle('s4_land_approved', 'IDD-2', { head: land.head, merge_commit: land.mergeCommit, signed: true });
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const forecast = buildSubmit('IDD-1').conflictForecast;
  assert.deepEqual(forecast.others, [{ lane: 'IDD-2', conflict: true, files: ['app.txt'] }]);
  git(f.work, 'checkout', '--', 'app.txt');
  const res = await runLandAndSettle();
  assert.ok(res.merged.includes('IDD-2'), JSON.stringify(res));
});

test('a git read that fails saves no forecast and drops the one before', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await runLandAndSettle();
  assert.ok(readLandForecast(f.work), 'the first forecast is saved');
  // IDD-2's branch shares no ancestor with the mainline: neither the diff nor the trial merge can be answered
  const original = laneTip(f, 'IDD-2');
  git(f.lanes['IDD-2'].path, 'checkout', '--orphan', 'orphan');
  commit(f.lanes['IDD-2'].path, 'feat: orphan');
  const res = await runLandAndSettle();
  assert.equal(readLandForecast(f.work), null, 'the saved forecast is dropped');
  assert.equal(buildSubmit('IDD-1').conflictForecast, undefined);
  assert.equal(buildSubmit('IDD-2').conflictForecast, undefined);
  assert.equal(Array.isArray(res.errors), true, 'the landing stage did not fail');
  // the cause is removed: git can answer again and the forecast is saved
  git(f.lanes['IDD-2'].path, 'checkout', '-f', original);
  await runLandAndSettle();
  assert.ok(readLandForecast(f.work), 'the forecast is saved once git can answer');
});

test('a pair trial merge git cannot answer saves no forecast either', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  const a = laneTip(f, 'IDD-1');
  const b = laneTip(f, 'IDD-2');
  const realGit = execFileSync('bash', ['-c', 'type -P git'], { encoding: 'utf8' }).trim();
  const bin = join(f.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'git');
  put(shim, `#!/bin/sh\nhas_a=0; has_b=0\nfor arg in "$@"; do [ "$arg" = "${a}" ] && has_a=1; [ "$arg" = "${b}" ] && has_b=1; done\nif [ "$has_a" = 1 ] && [ "$has_b" = 1 ]; then echo 'fatal: pair merge refused' >&2; exit 128; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(shim, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    await runLandAndSettle();
  } finally {
    process.env.PATH = old;
  }
  assert.equal(readLandForecast(f.work), null);
  assert.equal(buildSubmit('IDD-1').conflictForecast, undefined);
  assert.equal(buildSubmit('IDD-2').conflictForecast, undefined);
});

test('a saved forecast without a lane mainline result is not handed to that lane', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  change(f, 'IDD-2', { 'app.txt': 'from two\n' });
  await atShip('IDD-1');
  await atShip('IDD-2');
  await runLandAndSettle();
  const group = readLandForecast(f.work);
  const tip = mainTip(f);
  delete group.pairs[pairKey('IDD-1', 'IDD-2')];
  delete group.mainline['IDD-2'];
  assert.equal(landForecastFor(group, 'IDD-2', laneTip(f, 'IDD-2'), tip), undefined, 'no mainline result, no forecast');
  // the other lane still gets its forecast, and the missing pair is a not-conflicting partner
  const one = landForecastFor(group, 'IDD-1', laneTip(f, 'IDD-1'), tip);
  assert.deepEqual(one, { mainline: { conflict: false, files: [] }, others: [{ lane: 'IDD-2', conflict: false, files: [] }] });
});

// ---- a conflict on declared generated files alone is not a conflict on the card (C-266-3) ----

const NONE = { conflict: false, files: [] };
const declared = (lanes = ['IDD-1', 'IDD-2']) => setup({ repos: { demo: { generated_files: [GEN] } }, lanes: { demo: lanes } });
/** two cards that each build gen.txt from a source line they changed: src.txt merges (or conflicts, as `second` says), gen.txt conflicts between them */
function twoBuilders(f, second = BOTTOM) {
  seedGenerated(f.work, ['IDD-1', 'IDD-2'].map((id) => f.lanes[id].path));
  builds(f.lanes['IDD-1'].path, TOP, 'feat: IDD-1');
  builds(f.lanes['IDD-2'].path, second, 'feat: IDD-2');
}
async function shipBoth() {
  await atShip('IDD-1');
  await atShip('IDD-2');
  await runLandAndSettle();
}

test('AC-005: a pair that conflicts on declared generated files alone shows no conflict, and the mainline too', async () => {
  const f = declared();
  twoBuilders(f);
  // the mainline moves on the generated file only, so each lane also conflicts with it on that file alone
  put(join(f.work, 'gen.txt'), 'MAINLINE BUILD\n'); commit(f.work, 'chore: mainline builds');
  await shipBoth();
  const group = readLandForecast(f.work);
  assert.equal(group.pairs[pairKey('IDD-1', 'IDD-2')].conflict, true, 'git itself called it a conflict');
  assert.deepEqual(group.mainline['IDD-1'], { conflict: true, files: ['gen.txt'] });
  for (const [id, other] of [['IDD-1', 'IDD-2'], ['IDD-2', 'IDD-1']]) {
    const forecast = buildSubmit(id).conflictForecast;
    assert.deepEqual(forecast.mainline, NONE);
    assert.deepEqual(forecast.others, [{ lane: other, ...NONE }]);
  }
});

test('AC-005: a forecast saved before the declaration was read this way shows the same', async () => {
  const f = declared();
  twoBuilders(f);
  await shipBoth();
  // a record as an earlier version saved it: the conflict is in it, whatever the declaration says now
  const saved = readLandForecast(f.work);
  saved.pairs[pairKey('IDD-1', 'IDD-2')] = { conflict: true, files: ['gen.txt'] };
  saved.mainline['IDD-1'] = { conflict: true, files: ['gen.txt'] };
  const tip = mainTip(f);
  assert.deepEqual(landForecastFor(saved, 'IDD-1', laneTip(f, 'IDD-1'), tip), { mainline: NONE, others: [{ lane: 'IDD-2', ...NONE }] });
  // a source among the files keeps the conflict, with all of its files
  saved.pairs[pairKey('IDD-1', 'IDD-2')] = { conflict: true, files: ['gen.txt', 'src.txt'] };
  assert.deepEqual(landForecastFor(saved, 'IDD-1', laneTip(f, 'IDD-1'), tip).others, [{ lane: 'IDD-2', conflict: true, files: ['gen.txt', 'src.txt'] }]);
});

test('AC-005: a pair that conflicts on a source as well as a generated file still shows the conflict', async () => {
  const f = declared();
  twoBuilders(f, TOP_OTHER);
  await shipBoth();
  const forecast = buildSubmit('IDD-1').conflictForecast;
  assert.equal(forecast.others[0].conflict, true);
  assert.deepEqual([...forecast.others[0].files].sort(), ['gen.txt', 'src.txt']);
});

test('AC-006: a repo that declares nothing shows a generated-only conflict, as before', async () => {
  const f = setup({ lanes: { demo: ['IDD-1', 'IDD-2'] } });
  twoBuilders(f);
  await shipBoth();
  assert.deepEqual(buildSubmit('IDD-1').conflictForecast.others, [{ lane: 'IDD-2', conflict: true, files: ['gen.txt'] }]);
});

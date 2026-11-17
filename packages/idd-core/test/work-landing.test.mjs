import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { parseRepos, publishes, closesOnLand } from '../src/config/areas.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { baseReceiptPath, custodyPath, laneLocations, proposalPath, readProposal, stackedSubmitBlocker } from '../src/overlay/export.ts';
import { readLand, prepareLand as prepareLandNow, approveLand, landBlocker, readLand as readLandRecord, recheckApprovedLand, currentLandApproval, landContentFor, landPath, landReadyAt, landCheckedAt, landBehindAt, RECORDS_ONLY_REASON } from '../src/overlay/land.ts';
import { rebuildGenerated } from '../src/overlay/generated.ts';
import { GEN, SRC, generating, genOf, mainlineBuildsLaneEditsSource, writeIn } from './helpers/generated-fixture.mjs';
import { landRunChecking, runningLandRuns, readLandRun, landChecksRunning, saveLandRun } from '../src/overlay/land-run.ts';
import { PROJECTION_MARK, projectRecords } from '../src/intent/projection.ts';
import { foldRows, intentColumnPath, laneStates, readRows } from '../src/intent/store.ts';
import { proposeForTests } from '../src/overlay/export.ts';
import { buildSubmit, completeLocal, prepareSubmit, runShip } from '../src/plan/ship.ts';
import { consumeNonce } from '../src/passkey.ts';
import { LAND_RECHECK_MAX, runLand } from '../src/plan/land.ts';
import { runReviewLoop } from '../src/plan/review-loop.ts';
import { runSubmitPush } from '../src/plan/submit-push.ts';
import { runPrDrafts } from '../src/plan/pr-draft.ts';
import { retireEndedLanes } from '../src/plan/close.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { landApproved, verifiedNonceFor } from './passkey-approval.mjs';
import { readLifecycle as readLifecycleAll } from '../src/ledger/read.ts';
import { key, lock, save } from '../src/overlay/git.ts';
import { readLifecycle } from '../src/ledger/read.ts';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file', IDD_LANE_SCOPE: 'off' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

/** a project with the work clone, its remote and an upstream clone, plus one lane; `extra` goes into the repos.yaml entry */
function setup(extra = {}) {
  process.chdir(original);
  const root = scratchDir('run-');
  const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n'); put(join(work, 'app.txt'), 'one\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'test'); git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  const areas = join(root, 'repos.yaml');
  const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], publish: false, issue_lane: { context: 'personal', source_type_priority: 'github' }, ...extra };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', source_type: 'github', gh_issue_url: 'https://github.com/test/project/issues/7' }) + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, executor_session_id: 'test-session' }) + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane };
}
const change = (f) => { put(join(f.lane.path, 'app.txt'), 'two\n'); commit(f.lane.path, 'feat: change'); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(20); }
  throw new Error('待ちが timeout しました');
}
/** wait for the lane's landing check to end and answer the record it wrote (null when it wrote none) */
async function landSettled(id) {
  await waitFor(() => !landRunChecking(id));
  return readLand(id);
}
/**
 * The landing preparation as the older tests read it: start the check and wait for the record it wrote. When no run
 * was started (the limit is full) the answer is passed through, so a test sees what the entry answered.
 */
async function prepareLand(id) {
  const res = await prepareLandNow(id);
  if (typeof res !== 'object' || res === null || !('checking' in res) || res.waiting) return res;
  return await landSettled(id);
}
const mainTip = (f) => git(f.work, 'rev-parse', 'HEAD');
const laneTip = (f) => git(f.lane.path, 'rev-parse', 'HEAD');
/** the head of one lane, whichever worktree it has (f.lane is the first lane's) */
const laneHead = (id) => git(laneLocations(id).work, 'rev-parse', 'HEAD');
const eventsOf = (id) => readLifecycle().filter((e) => e.idd_id === id).map((e) => e.event);
/** penne's approval on the landing card: the verified nonce for exactly the content `approveLand` will check */
const approveLandSigned = (token, extra = {}) => approveLand('IDD-1', token, landApproved('IDD-1', extra));

test('a repo that writes publish: false carries the field; one that does not keeps the settings as they were', async () => {
  const text = JSON.stringify({ repos: { 'test/a': { github: 'test/a', upstream: '/x', work: '/y', publish: false }, 'test/b': { github: 'test/b', upstream: '/x', work: '/y' } } });
  const file = parseRepos(text);
  assert.equal(file.areas['test/a'].publish, false);
  assert.equal(publishes(file.areas['test/a']), false);
  assert.equal('publish' in file.areas['test/b'], false, 'a repo without the field keeps its shape');
  assert.equal(publishes(file.areas['test/b']), true);
  // the hash of a repo that does not write the field does not move when another repo turns publishing off
  const before = parseRepos(JSON.stringify({ repos: { 'test/b': { github: 'test/b', upstream: '/x', work: '/y' } } }));
  assert.equal(key(before.areas['test/b']), key(file.areas['test/b']));
});

test('a broken publish value is refused, not silently ignored', async () => {
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'test/a': { github: 'test/a', upstream: '/x', work: '/y', publish: 'no' } } })), /publish/);
});

test('the landing makes a merge commit with the mainline and the lane as parents, and checks it without moving the mainline', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  const tip = mainTip(f);
  const prepared = await prepareLand('IDD-1');
  assert.ok(!('error' in prepared), JSON.stringify(prepared));
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.blocking, 0, JSON.stringify(prepared.checks));
  assert.equal(prepared.head, laneTip(f));
  assert.equal(prepared.mainTip, tip);
  assert.ok(prepared.mergeCommit, 'the merge commit is checked');
  // two parents: the mainline tip and the lane head
  assert.equal(git(f.work, 'rev-parse', `${prepared.mergeCommit}^1`), tip);
  assert.equal(git(f.work, 'rev-parse', `${prepared.mergeCommit}^2`), laneTip(f));
  // the checks ran on the merge result, not in the work checkout
  assert.equal(prepared.checks.find((c) => c.name === 'ok')?.status, 'pass');
  // nothing moved yet: penne's approval is what advances the mainline
  assert.equal(mainTip(f), tip);
});

test('a landing check records when it ran, and a second check of the same head says whether the result moved', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  const first = await prepareLand('IDD-1');
  assert.match(first.checkedAt, /^\d{4}-\d\d-\d\dT/);
  // nothing before it to compare with
  assert.equal(first.sinceLast, undefined);
  const again = await prepareLand('IDD-1');
  assert.ok(Date.parse(again.checkedAt) >= Date.parse(first.checkedAt));
  assert.deepEqual(again.sinceLast, { at: first.checkedAt, changed: false, changes: [] });
  // the approval's token and window are the check's own: the time and the comparison add nothing to them
  assert.equal(typeof again.token, 'string');
  // another head is a first check again
  writeFileSync(join(f.lane.path, 'app.txt'), 'one\ntwo\nthree\nfour\n');
  commit(f.lane.path, 'more');
  const moved = await prepareLand('IDD-1');
  assert.equal(moved.sinceLast, undefined);
  assert.ok(moved.checkedAt);
});

test('AC-008 / AC-009: the landing runs its records check as the lane and its public check with no lane', async () => {
  const recordsOut = join(scratchDir('land-env-records-'), 'out');
  const publicOut = join(scratchDir('land-env-public-'), 'out');
  const f = setup({ checks: [
    { name: 'records', command: `printf %s "\${IDD_ID-unset}" > ${JSON.stringify(recordsOut)}`, required: true, scope: 'records' },
    { name: 'public', command: `printf %s "\${IDD_ID-unset}" > ${JSON.stringify(publicOut)}`, required: true },
  ] });
  change(f);
  const savedId = process.env.IDD_ID;
  process.env.IDD_ID = 'IDD-999';
  let prepared;
  try { prepared = await prepareLand('IDD-1'); } finally {
    if (savedId === undefined) delete process.env.IDD_ID; else process.env.IDD_ID = savedId;
  }
  assert.ok(!('error' in prepared), JSON.stringify(prepared));
  assert.equal(prepared.checks.find((c) => c.name === 'records').status, 'pass', JSON.stringify(prepared.checks));
  assert.equal(prepared.checks.find((c) => c.name === 'public').status, 'pass', JSON.stringify(prepared.checks));
  assert.equal(readFileSync(recordsOut, 'utf8'), 'IDD-1');
  assert.equal(readFileSync(publicOut, 'utf8'), 'unset');
});

test('the approval advances the mainline to the merge commit and closes the lane as a local landing', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, true, res.error);
  assert.equal(mainTip(f), prepared.mergeCommit);
  const evs = eventsOf('IDD-1');
  assert.ok(evs.includes('s4_land_merged'));
  assert.ok(evs.includes('lane_close'));
  const close = readLifecycle().filter((e) => e.idd_id === 'IDD-1' && e.event === 'lane_close')[0];
  assert.equal(close.attrs.outcome, 'local');
  assert.equal(close.attrs.merged_commit, prepared.mergeCommit);
  // the mainline carries the lane's change
  assert.equal(git(f.work, 'show', 'HEAD:app.txt'), 'two');
});

test('a failing required check leaves the mainline where it was and the approval is refused', async () => {
  const f = setup({ checks: [{ name: 'boom', command: 'exit 1', required: true }] });
  change(f);
  const tip = mainTip(f);
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.blocking, 1);
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, false);
  assert.equal(mainTip(f), tip);
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
});

test('a dirty work checkout holds the approval and the mainline does not move', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  const tip = mainTip(f);
  const prepared = await prepareLand('IDD-1');
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, true, res.error);
  assert.ok(res.held, 'the approval is kept for the next tick');
  assert.equal(mainTip(f), tip);
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
});

test('a lane whose head and the mainline conflict is not landed', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  put(join(f.work, 'app.txt'), 'mainline\n'); commit(f.work, 'chore: mainline move');
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.conflict?.length, 1, JSON.stringify(prepared));
  assert.equal(prepared.reason, 'work 側の本流と衝突します');
  assert.equal(prepared.mergeCommit, undefined);
});

// ---- the A projection is drawn again into the landing's merge commit (C-129-1 / C-129-2 / C-129-3) ----

/** a blob's bytes from a commit, without the test helper's trim */
const showFile = (cwd, ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8' });

/** the projection the state draws for one viewer, from the primitives: the same text the read door hands over */
function drawnFor(repo, lane) {
  const rows = readRows(intentColumnPath(repo));
  const folded = foldRows(rows, lane, laneStates(readLifecycle()));
  return Object.fromEntries(projectRecords({ purposes: folded.purposes, choices: folded.choices }).map((f) => [f.name, f.content]));
}

/** one active Purpose and one Choice raised by the lane, so the drawing names the lane's own record */
function seedIntent(state) {
  const at = new Date().toISOString();
  const purpose = { event: 'purpose_raised', at, repo: 'demo', by: { session: 's1' }, id: 'P-1', statement: '目的', origin: '常設', status: 'active' };
  const choice = {
    event: 'choice_raised', at, repo: 'demo', by: { lane: 'IDD-1' }, id: 'C-1-1', purpose: 'P-1',
    forms: { chosen: '形', rejected: [] }, place: [{ path: 'app.txt', kind: 'file' }], why: 'なぜ', anchored: '錨',
    visibility: 'private', status: 'active', origin: { by: 'agent' }, no_why_not: '捨てた形は無い',
  };
  put(join(state, 'intent-demo.jsonl'), `${JSON.stringify(purpose)}\n${JSON.stringify(choice)}\n`);
}

test('AC-001: the landing draws the lane\'s A projection into the merge commit from the state the lane sees', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  seedIntent(f.state);
  const prepared = await prepareLand('IDD-1');
  assert.ok(!('error' in prepared), JSON.stringify(prepared));
  assert.ok(prepared.mergeCommit);
  const expected = drawnFor('demo', 'IDD-1');
  assert.deepEqual(Object.keys(expected).sort(), ['P-1.md', 'index.md', 'overview.md']);
  assert.match(expected['P-1.md'], /C-1-1/, "the lane's own Choice is in the drawing");
  for (const [name, content] of Object.entries(expected)) {
    assert.equal(showFile(f.work, prepared.mergeCommit, `_docs/intent/demo/${name}`), content, name);
  }
  // the mainline is not moved before the approval
  assert.equal(mainTip(f), prepared.mainTip);
});

test('AC-003: a lane that moves a file has its Place followed at the landing, and the drawn copy names the new module', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  seedIntent(f.state);
  // the lane moves the file its Choice was written against with git's own rename
  mkdirSync(join(f.lane.path, 'moved'), { recursive: true });
  git(f.lane.path, 'mv', 'app.txt', 'moved/app.txt');
  commit(f.lane.path, 'refactor: move the app');
  const prepared = await prepareLand('IDD-1');
  assert.ok(!('error' in prepared), JSON.stringify(prepared));
  assert.ok(prepared.mergeCommit, JSON.stringify(prepared));
  // the follow is a row of this lane, carrying the move rather than a written Place list
  const moves = readRows(intentColumnPath('demo')).filter((r) => r.event === 'places_moved');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].by, { lane: 'IDD-1' });
  assert.deepEqual(moves[0].moves, [{ from: 'app.txt', to: 'moved/app.txt' }]);
  // the Choice now names the new module, with the moved file as its mark, and the history says why
  const folded = foldRows(readRows(intentColumnPath('demo')), 'IDD-1', laneStates(readLifecycle()));
  const choice = folded.choices.find((c) => c.id === 'C-1-1');
  assert.deepEqual(choice.place, [{ path: 'moved/', kind: 'module', file: 'moved/app.txt' }]);
  assert.equal(choice.history.at(-1).event, 're-anchored');
  // the conversion of the older Places is written once as a row of the lane as well
  assert.equal(readRows(intentColumnPath('demo')).filter((r) => r.event === 'places_module').length, 1);
  // the copy drawn into the merge commit is drawn after the follow
  const drawn = showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/P-1.md');
  assert.match(drawn, /`moved\/` \(module, file: `moved\/app\.txt`\)/);
});

test('AC-001: a repo that draws no projection keeps its place as the merge left it', async () => {
  const f = setup({ checks: [], intent: { projections: [] } });
  change(f);
  seedIntent(f.state);
  put(join(f.work, '_docs/intent/demo/P-1.md'), `${PROJECTION_MARK}\n人が置いた古い写し\n`);
  commit(f.work, 'chore: an old projection');
  const prepared = await prepareLand('IDD-1');
  assert.ok(!('error' in prepared), JSON.stringify(prepared));
  assert.ok(prepared.mergeCommit);
  assert.equal(showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/P-1.md'), `${PROJECTION_MARK}\n人が置いた古い写し\n`);
  assert.throws(() => showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/overview.md'));
});

test('AC-002: a conflict that is all projection files is resolved by redrawing, not sent back', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  seedIntent(f.state);
  put(join(f.work, '_docs/intent/demo/P-1.md'), `${PROJECTION_MARK}\nmainline\n`);
  commit(f.work, 'chore: mainline projection');
  put(join(f.lane.path, '_docs/intent/demo/P-1.md'), `${PROJECTION_MARK}\nlane\n`);
  commit(f.lane.path, 'chore: lane projection');
  const prepared = await prepareLand('IDD-1');
  assert.ok(!('error' in prepared), JSON.stringify(prepared));
  assert.equal(prepared.reason, undefined, JSON.stringify(prepared));
  assert.equal(prepared.conflict, undefined, JSON.stringify(prepared));
  assert.ok(prepared.mergeCommit);
  assert.equal(showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/P-1.md'), drawnFor('demo', 'IDD-1')['P-1.md']);
});

test('AC-002: a conflict that includes a file other than a projection is still sent back', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  seedIntent(f.state);
  change(f);
  put(join(f.work, 'app.txt'), 'mainline\n');
  put(join(f.work, '_docs/intent/demo/P-1.md'), `${PROJECTION_MARK}\nmainline\n`);
  commit(f.work, 'chore: mainline moves');
  put(join(f.lane.path, '_docs/intent/demo/P-1.md'), `${PROJECTION_MARK}\nlane\n`);
  commit(f.lane.path, 'chore: lane projection');
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, 'work 側の本流と衝突します');
  assert.ok(prepared.conflict.includes('app.txt'), JSON.stringify(prepared.conflict));
  assert.equal(prepared.mergeCommit, undefined);
});

test('AC-003: an unmarked file at a name to be drawn stops the landing, and the reason is on the record', async () => {
  const f = setup({ checks: [] });
  change(f);
  seedIntent(f.state);
  put(join(f.work, '_docs/intent/demo/P-1.md'), '人が書いた\n');
  commit(f.work, 'chore: a person wrote this name');
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.mergeCommit, undefined);
  assert.match(String(prepared.reason), /印の無いファイル/);
  assert.equal(readLand('IDD-1').reason, prepared.reason);
});

test('AC-003: an unmarked symlink at a name to be drawn stops the landing', async () => {
  const f = setup({ checks: [] });
  change(f);
  seedIntent(f.state);
  put(join(f.work, 'target.md'), 'elsewhere\n');
  mkdirSync(join(f.work, '_docs', 'intent', 'demo'), { recursive: true });
  execFileSync('ln', ['-s', '../target.md', join(f.work, '_docs', 'intent', 'demo', 'P-1.md')]);
  commit(f.work, 'chore: a symlink at a name');
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.mergeCommit, undefined);
  assert.match(String(prepared.reason), /symlink/);
});

test('AC-003: an unmarked file the drawing does not name stays in the merge commit tree', async () => {
  const f = setup({ checks: [] });
  change(f);
  seedIntent(f.state);
  put(join(f.work, '_docs/intent/demo/notes.md'), '人のメモ\n');
  commit(f.work, 'chore: a person\'s note');
  const prepared = await prepareLand('IDD-1');
  assert.ok(prepared.mergeCommit, JSON.stringify(prepared));
  assert.equal(showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/notes.md'), '人のメモ\n');
  assert.equal(showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/P-1.md'), drawnFor('demo', 'IDD-1')['P-1.md']);
});

test('AC-001: a leftover marked projection is removed by the landing', async () => {
  const f = setup({ checks: [] });
  change(f);
  seedIntent(f.state);
  put(join(f.work, '_docs/intent/demo/P-99.md'), `${PROJECTION_MARK}\n古い写し\n`);
  commit(f.work, 'chore: an old projection');
  const prepared = await prepareLand('IDD-1');
  assert.ok(prepared.mergeCommit, JSON.stringify(prepared));
  assert.throws(() => showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/P-99.md'));
  assert.equal(showFile(f.work, prepared.mergeCommit, '_docs/intent/demo/P-1.md'), drawnFor('demo', 'IDD-1')['P-1.md']);
});

test('a lane with a custody (public branch) or a publish proposal is not landed', async () => {
  const f = setup();
  change(f);
  assert.equal(landBlocker('IDD-1', { work: f.lane.path, upstream: f.upstream, branch: f.lane.branch, area: 'demo', config: parseRepos(execFileSync('cat', [process.env.IDD_REPOS_FILE], { encoding: 'utf8' })).areas.demo }), null);
  save(custodyPath('IDD-1'), { branch: f.lane.branch, publicTip: 'x', workTree: 'y', workHead: 'z' });
  const loc = { work: f.lane.path, upstream: f.upstream, branch: f.lane.branch, area: 'demo', config: parseRepos(execFileSync('cat', [process.env.IDD_REPOS_FILE], { encoding: 'utf8' })).areas.demo };
  assert.match(String(landBlocker('IDD-1', loc)), /公開 branch/);
});

test('a repo that publishes is not landed (the entry is left out)', async () => {
  const f = setup({ publish: true });
  change(f);
  const cfg = parseRepos(execFileSync('cat', [process.env.IDD_REPOS_FILE], { encoding: 'utf8' })).areas.demo;
  const loc = { work: f.lane.path, upstream: f.upstream, branch: f.lane.branch, area: 'demo', config: cfg };
  assert.match(String(landBlocker('IDD-1', loc)), /公開する repo/);
});

test('an approval whose mainline moved is re-checked and the land goes in on the next pass', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  // the approval was recorded for the checked head, and the mainline moved before the merge went in
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  put(join(f.work, 'other.txt'), 'x\n'); commit(f.work, 'chore: mainline move');
  const started = await recheckApprovedLand('IDD-1');
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok(started.checking, 'the re-check runs detached (C-144-1)');
  await landSettled('IDD-1');
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res.ok, true, res.error);
  assert.ok(eventsOf('IDD-1').includes('lane_close'));
  assert.equal(git(f.work, 'show', 'HEAD:app.txt'), 'two');
});

test('an approved land that conflicts after the mainline moved is dropped and the lane is sent back', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  put(join(f.work, 'app.txt'), 'mainline\n'); commit(f.work, 'chore: mainline move');
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res.ok, false);
  const evs = eventsOf('IDD-1');
  assert.ok(evs.includes('s4_verify_user_judgment_answered'), 'the send-back is recorded');
  assert.ok(evs.includes('s4_land_conflict'));
  const rows = readFileSync(join(f.state, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).skip_fix_plan, true, 'the land conflict instruction skips the delivery plan');
  assert.equal(evs.includes('lane_close'), false, 'a conflicting lane is not closed');
  assert.equal(git(f.work, 'show', 'HEAD:app.txt'), 'mainline', 'the mainline is not advanced');
});

test('an approval penne took back does not land, and the mainline stays where it was', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const tip = mainTip(f);
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  // penne pressed the send-back: the approval is no longer in force
  await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-1', { outcome: 'revise', instruction: 'x' });
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res, null, 'no approval is carried out');
  assert.equal(mainTip(f), tip, 'the mainline does not move');
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
});

test('a conflict with an approval sends the lane back once, however often the tick looks', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  put(join(f.work, 'app.txt'), 'mainline\n'); commit(f.work, 'chore: mainline move');
  await recheckApprovedLand('IDD-1');
  const after = await recheckApprovedLand('IDD-1');
  assert.equal(after, null, 'the dropped approval is not looked at again');
  const evs = eventsOf('IDD-1');
  assert.equal(evs.filter((e) => e === 's4_verify_user_judgment_answered').length, 1);
  assert.equal(evs.filter((e) => e === 's4_land_conflict').length, 1);
  assert.equal(evs.filter((e) => e === 's4_land_approval_dropped').length, 1);
});

test('the conflict files are only the files the merge could not take', async () => {
  const f = setup();
  put(join(f.lane.path, 'app.txt'), 'two\n'); put(join(f.lane.path, 'lane-only.txt'), 'mine\n');
  commit(f.lane.path, 'feat: change');
  put(join(f.work, 'app.txt'), 'mainline\n'); commit(f.work, 'chore: mainline move');
  const prepared = await prepareLand('IDD-1');
  assert.deepEqual(prepared.conflict, ['app.txt']);
});

test('a broken overlay.manifest blocks the landing', async () => {
  const f = setup();
  change(f);
  rmSync(join(f.lane.path, 'overlay.manifest'));
  commit(f.lane.path, 'chore: drop manifest');
  const prepared = await prepareLand('IDD-1');
  assert.match(String(prepared.reason), /overlay\.manifest/);
  assert.equal(prepared.mergeCommit, undefined);
});

/** put the fixture lane at the submit card, with any extra records in between (a past R2's, say) */
async function atShip(extra = []) {
  await seedLifecycle('lane_open', 'IDD-1', {});
  await seedLifecycle('s2_start', 'IDD-1', {});
  await seedLifecycle('s2_result', 'IDD-1', {});
  await seedLifecycle('s3_ready', 'IDD-1', {});
  for (const [event, attrs] of extra) await seedLifecycle(event, 'IDD-1', attrs);
  await seedLifecycle('s3_ok', 'IDD-1', {});
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
}

/** put a lane at the submit card with the R2 records a lane from before R2 was removed (2026-10-22) carries */
async function atShipWithR2(r2) {
  await atShip(r2);
}

test('a past R2 record that stopped, or R2 findings over the old limit, no longer stop the landing', async () => {
  for (const r2 of [
    [['s3_r2_done', { must: 0, should: 0 }], ['s3_r2_not_recorded', { reason: '記録の検査（scripts/check-docs.sh）が通らないので commit していません' }]],
    [['s3_r2_done', { must: 1, should: 2 }]],
  ]) {
    const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
    change(f);
    await atShipWithR2(r2);
    const prepared = await prepareLand('IDD-1');
    assert.ok(prepared.mergeCommit, JSON.stringify(prepared));
    assert.equal(prepared.reason, undefined);
    const landed = await approveLandSigned(prepared.token);
    assert.equal(landed.ok, true, landed.error);
    assert.equal(mainTip(f), prepared.mergeCommit);
    assert.equal(eventsOf('IDD-1').includes('s4_r2_overridden'), false);
  }
});

test('a lane of a repo that does not publish never becomes a push and a PR, whatever entry', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  // the card's check and the API route through the landing
  const view = await prepareSubmit('IDD-1');
  assert.ok(!('error' in view), JSON.stringify(view));
  assert.ok(view.checking, 'the entry starts the check and returns (C-144-1)');
  const record = await landSettled('IDD-1');
  assert.equal(record.iddId, 'IDD-1');
  assert.ok(record.token, 'the landing record carries its approval token');
  // the check at the bottom refuses a public submit for the same lane (the CLI's propose reaches it too)
  const refused = await proposeForTests('IDD-1');
  assert.ok('error' in refused && /公開しない repo/.test(refused.error), JSON.stringify(refused));
  // the CLI's local completion goes through the landing too, and pushes nothing
  const done = await completeLocal('IDD-1', 'no-such-token');
  assert.equal(done.ok, false);
});

test('an approval is not closed as landed while the checkout is off the work_base branch', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  // the checkout is moved to a branch that carries the lane's head: work_base itself does not
  git(f.work, 'checkout', '-b', 'side', prepared.head);
  try {
    const res = await recheckApprovedLand('IDD-1');
    assert.ok(res && res.held, JSON.stringify(res));
    assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
    assert.ok(eventsOf('IDD-1').includes('s4_land_hold'));
    assert.equal(git(f.work, 'rev-parse', 'refs/heads/work-main'), prepared.mainTip, 'work_base did not move');
  } finally { git(f.work, 'checkout', 'work-main'); git(f.work, 'branch', '-D', 'side'); }
});

test('a send-back while the merge was being made keeps the lane from being closed as landed', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  git(f.work, 'merge', '--ff-only', prepared.mergeCommit);
  await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-1', { outcome: 'revise', instruction: 'x' });
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res, null, 'the approval is not in force any more');
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
});

test('a busy overlay lock is a wait, not a failed approval', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const common = resolve(f.work, git(f.work, 'rev-parse', '--git-common-dir'));
  mkdirSync(join(common, 'idd-overlay.lock'), { recursive: true });
  writeFileSync(join(common, 'idd-overlay.lock', 'owner.json'), '{}');
  try {
    const res = await approveLandSigned(prepared.token);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.held, 'the approval waits for the next tick');
    assert.equal(mainTip(f), prepared.mainTip);
    assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
    assert.ok(eventsOf('IDD-1').includes('s4_land_hold'));
  } finally { rmSync(join(common, 'idd-overlay.lock'), { recursive: true, force: true }); }
});

test('the card says the landing waits and carries the reason the tick gave', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  await approveLandSigned(prepared.token);
  const view = buildSubmit('IDD-1');
  assert.ok(view?.landPending, JSON.stringify(view?.landPending));
  assert.match(String(view.landPending.hold), /clean/);
});

test('AC-001 / AC-003 / AC-004: the card carries the land record only while the lane still stands at the checked head', async () => {
  const f = setup({ checks: [{ name: 'boom', command: 'exit 1', required: true }] });
  change(f);
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.blocking, 1, JSON.stringify(prepared.checks));
  // AC-003: a record checked at the lane's own head is on the card as before, with its checks and its count
  const here = buildSubmit('IDD-1');
  assert.ok(here.land, 'the record checked at this head is on the card');
  assert.equal(here.land.head, laneTip(f));
  assert.equal(here.land.blocking, 1);
  assert.equal(here.land.checks.length, 1);
  assert.equal(here.head, prepared.head);
  // the lane moves on after the check, without a send-back: the record now answers for another head
  put(join(f.lane.path, 'app.txt'), 'three\n'); commit(f.lane.path, 'feat: more');
  const moved = buildSubmit('IDD-1');
  // AC-001: no result, merge commit, expiry, blocking count or token of the other head reaches the view (a null
  // land is the same shape a lane nothing was checked for gets)
  assert.equal(moved.land, null, 'a record checked at another head is handed on as no check');
  assert.equal(moved.head, laneTip(f));
  assert.notEqual(moved.head, prepared.head);
  // AC-004: the engine builds "止める検査が N 件あります" from view.land.blocking alone, so the old head's failed
  // check cannot become the card's stop reason
  assert.equal(moved.land, null);
  assert.equal(moved.landBlocked, undefined);
  // the record on disk is left alone: only the view drops it, so the tick and the signature still read it
  assert.equal(readLand('IDD-1').head, prepared.head);
  assert.equal(readLand('IDD-1').blocking, 1);
});

test('the refusal of a landing with a blocking check names the check and why, not only how many', async () => {
  const f = setup({ checks: [
    { name: 'boom', command: 'echo "boom: the thing broke"; exit 1', required: true },
    { name: 'fine', command: 'true', required: true },
    { name: 'noisy', command: 'exit 1', required: false },
  ] });
  change(f);
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.blocking, 1);
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^止めている検査: boom（boom: the thing broke）$/);
  assert.doesNotMatch(String(res.error), /noisy|fine|止める検査が/);
});

test('a close that could not be written is not reported as landed, and nothing after it is queued', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  // no submit card: the close's own check refuses, though the mainline already carries the head
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  git(f.work, 'merge', '--ff-only', prepared.mergeCommit);
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /提出前確認/);
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
  assert.equal(readLand('IDD-1')?.status !== 'complete', true, 'the record does not say it landed');
  assert.equal(eventsOf('IDD-1').includes('s4_land_issue_close_queued'), false);
});

test('no PR text and no commit message is drafted for a lane of a repo that does not publish', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  let called = 0;
  setAgentRunner({
    draftPrText: async () => { called += 1; return { title: 't', body: 'b' }; },
    draftCommitMessage: async () => { called += 1; return { message: 'm' }; },
  });
  try {
    const drafts = await runPrDrafts();
    assert.deepEqual(drafts.drafted, []);
    const push = await runSubmitPush();
    assert.deepEqual(push.ready, []);
    assert.deepEqual(push.held, []);
  } finally { setAgentRunner(null); }
  assert.equal(called, 0, 'the drafting roles were never asked');
});

test('a lane sent back goes through the review loop again rather than straight back to the card', async () => {
  const f = setup();
  change(f);
  await atShip();
  await seedLifecycle('s4_verify_user_judgment_answered', 'IDD-1', { outcome: 'revise', instruction: 'x' });
  const stage = deriveStage(readLifecycleAll().filter((e) => e.idd_id === 'IDD-1'));
  assert.equal(stage.decision, undefined, 'not at the submit card');
  assert.equal(stage.group, 'impl');
  assert.equal(stage.stageDone, 2, 'back at the review loop');
});

test('the worktree of a landed lane is retired on the next sweep', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const landed = await approveLandSigned(prepared.token);
  assert.equal(landed.ok, true, landed.error);
  setAgentRunner({ sessionStatus: async () => ({ state: 'stopped' }) });
  try {
    const retired = await retireEndedLanes();
    assert.equal(retired.some((r) => r.iddId === 'IDD-1' && r.worktreeRemoved), true, JSON.stringify(retired));
  } finally { setAgentRunner(null); }
  assert.equal(existsSync(f.lane.path), false);
});

test('an approval held by a dirty checkout lands once the checkout is clean', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const held = await approveLandSigned(prepared.token);
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.ok(held.held);
  assert.equal(mainTip(f), prepared.mainTip);
  git(f.work, 'checkout', '--', 'app.txt');
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res.ok, true, res.error);
  assert.equal(eventsOf('IDD-1').includes('lane_close'), true);
});

test('a lane whose head is already in the mainline is closed without a second merge', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  git(f.work, 'merge', '--ff-only', prepared.mergeCommit);
  const tip = mainTip(f);
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res.ok, true, res.error);
  assert.equal(mainTip(f), tip, 'no second merge commit');
  assert.equal(eventsOf('IDD-1').includes('lane_close'), true);
});

test('a landed lane does not make a proposal record (no push and no PR)', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await prepareLand('IDD-1');
  assert.equal(readLandRecord('IDD-1')?.status, 'prepared');
  assert.ok(readLand('IDD-1')?.mergeCommit, 'the checked merge commit is recorded');
  // nothing put a proposal (a push and a PR) in the overlay state
  assert.equal(readProposal('IDD-1'), null);
});

// ---- the passkey signature on the landing ----

const passkeyStatePath = () => join(process.env.IDD_STATE_DIR, 'passkey', 'state.json');
const nonceRecord = (nonce) => JSON.parse(readFileSync(passkeyStatePath(), 'utf8')).nonces?.[nonce];

async function preparedLand() {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  return { f, prepared: await prepareLand('IDD-1') };
}

test('a landing approval with no signature is refused, leaves no approval record, and does not move the mainline', async () => {
  const { f, prepared } = await preparedLand();
  const tip = mainTip(f);
  const res = await approveLand('IDD-1', prepared.token);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /署名/);
  assert.equal(mainTip(f), tip);
  for (const e of ['s4_land_approved', 's4_land_hold', 'lane_close']) assert.equal(eventsOf('IDD-1').includes(e), false, e);
  // the shape that records only the approval and waits (a dirty checkout) is refused the same way
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const held = await approveLand('IDD-1', prepared.token);
  assert.equal(held.ok, false);
  assert.equal(eventsOf('IDD-1').includes('s4_land_approved'), false);
  assert.equal(mainTip(f), tip);
});

test('a signed landing approval advances the mainline, marks the approval signed, and uses the nonce up', async () => {
  const { f, prepared } = await preparedLand();
  const approval = landApproved('IDD-1');
  const res = await approveLand('IDD-1', prepared.token, approval);
  assert.equal(res.ok, true, res.error);
  assert.equal(mainTip(f), prepared.mergeCommit);
  const mark = readLifecycle().find((e) => e.idd_id === 'IDD-1' && e.event === 's4_land_approved');
  assert.equal(mark?.attrs?.signed, true);
  assert.equal(mark?.attrs?.head, prepared.head);
  assert.equal(nonceRecord(approval.nonce)?.consumed, true, 'the nonce is used up');
});

test('an early refusal of the landing still uses the nonce up', async () => {
  const { prepared } = await preparedLand();
  const nonce = verifiedNonceFor(landContentFor(readLand('IDD-1')));
  const res = await approveLand('IDD-1', 'another-token', { nonce });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /token/);
  assert.equal(nonceRecord(nonce)?.consumed, true);
});

test('a signature over other content does not land', async () => {
  const { f, prepared } = await preparedLand();
  const saved = readLand('IDD-1');
  const tip = mainTip(f);
  const cases = [
    ['another head', verifiedNonceFor(landContentFor({ ...saved, head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }))],
    ['the head before the lane advanced', verifiedNonceFor(landContentFor({ ...saved, head: 'cafebabecafebabecafebabecafebabecafebabe' }))],
    ['an R2 override (no longer part of what is signed)', verifiedNonceFor({ ...landContentFor(saved), r2Override: true })],
    ['a push', verifiedNonceFor({ kind: 'ship', iddId: 'IDD-1' })],
  ];
  for (const [name, nonce] of cases) {
    const res = await approveLand('IDD-1', prepared.token, { nonce });
    assert.equal(res.ok, false, name);
    assert.equal(mainTip(f), tip, name);
    assert.equal(eventsOf('IDD-1').includes('s4_land_approved'), false, name);
  }
});

test('an expired or used up signature does not land', async () => {
  const { f, prepared } = await preparedLand();
  const saved = readLand('IDD-1');
  const tip = mainTip(f);
  const expired = verifiedNonceFor(landContentFor(saved));
  const state = JSON.parse(readFileSync(passkeyStatePath(), 'utf8'));
  state.nonces[expired].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(passkeyStatePath(), JSON.stringify(state));
  const first = await approveLand('IDD-1', prepared.token, { nonce: expired });
  assert.equal(first.ok, false);
  assert.match(String(first.error), /期限/);
  const used = verifiedNonceFor(landContentFor(saved));
  consumeNonce(used);
  const second = await approveLand('IDD-1', prepared.token, { nonce: used });
  assert.equal(second.ok, false);
  assert.match(String(second.error), /使い終え/);
  assert.equal(mainTip(f), tip);
  assert.equal(eventsOf('IDD-1').includes('s4_land_approved'), false);
});

test('a signed approval held for a dirty checkout is carried out by the tick without a second signature', async () => {
  const { f, prepared } = await preparedLand();
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const held = await approveLandSigned(prepared.token);
  assert.ok(held.held, JSON.stringify(held));
  assert.equal(mainTip(f), prepared.mainTip);
  git(f.work, 'checkout', '--', 'app.txt');
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res.ok, true, res.error);
  assert.equal(eventsOf('IDD-1').includes('lane_close'), true);
});

test('an approval written before the signature was required is not carried out by the tick', async () => {
  const { f, prepared } = await preparedLand();
  const tip = mainTip(f);
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit });
  assert.equal(currentLandApproval(readLifecycle().filter((e) => e.idd_id === 'IDD-1')), null);
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res, null, 'the tick prepares a fresh land instead');
  assert.equal(mainTip(f), tip);
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
  const view = buildSubmit('IDD-1');
  assert.equal(view.landPending, undefined, 'the card does not say the merge is waiting');
  assert.ok(view.land, 'the card asks for the approval again');
});

test('a broken passkey state refuses the landing and leaves the mainline', async () => {
  const { f, prepared } = await preparedLand();
  const tip = mainTip(f);
  const approval = landApproved('IDD-1');
  mkdirSync(join(process.env.IDD_STATE_DIR, 'passkey'), { recursive: true });
  writeFileSync(passkeyStatePath(), '{ broken');
  const res = await approveLand('IDD-1', prepared.token, approval);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /passkey の記録/);
  assert.equal(mainTip(f), tip);
  assert.equal(eventsOf('IDD-1').includes('s4_land_approved'), false);
});

test('an approval already carried out is answered without a signature', async () => {
  const { prepared } = await preparedLand();
  assert.equal((await approveLandSigned(prepared.token)).ok, true);
  const again = await runShip('IDD-1', prepared.token);
  assert.equal(again.ok, true, again.error);
  const done = await completeLocal('IDD-1', prepared.token);
  assert.equal(done.ok, true, done.error);
});

// ---- the close of the lane's Issue with the landing (DEC-2041..2049) ----

/** the one-liner the landing posts with the close, the same text the outbound card always carried */
const closeBody = (issue) => `work 側の本流へ merge しました（merge で lane を閉じました）。\n#${issue} を完了として閉じます。`;

/**
 * A runner with both doors: the immediate close records what it was asked to post and what the landing looked like
 * at that moment, and the card queue records what it was asked to queue (which a close the approval signed uses not).
 */
function closeDoor(respond) {
  const calls = [];
  const queued = [];
  const runner = {
    async postOutbound(opts) {
      const land = readLand('IDD-1');
      calls.push({
        opts,
        laneClosed: readLifecycle().some((e) => e.idd_id === 'IDD-1' && e.event === 'lane_close'),
        status: land?.status,
        head: git(process.cwd(), 'rev-parse', 'HEAD'),
        mergeCommit: land?.mergeCommit,
      });
      return { id: `OUT-${calls.length}`, ...respond() };
    },
    async queueOutbound(opts) { queued.push(opts); return { id: `OUT-q${queued.length}` }; },
  };
  return { calls, queued, runner };
}

/** a runner with only the outbound card queue: an older runtime that has no immediate-close door */
function queueDoor() {
  const queued = [];
  return { queued, runner: { async queueOutbound(opts) { queued.push(opts); return { id: `OUT-q${queued.length}` }; } } };
}

/** put a Linear lane in place of the GitHub fixture (no gh_issue_url to read) */
function makeLinear(f) {
  put(join(f.state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', source_type: 'linear', linear_issue_url: 'https://linear.app/x/issue/APP-1' }) + '\n');
}

/** rewrite the repo's settings (the tick reads repos.yaml afresh on every call) */
function reconfigure(f, extra) {
  const config = { github: 'test/project', upstream: f.upstream, work: f.work, work_base: 'work-main', public_base: 'main', lanes_root: join(f.root, 'lanes'), checks: [], publish: false, issue_lane: { context: 'personal', source_type_priority: 'github' }, ...extra };
  put(join(f.root, 'repos.yaml'), JSON.stringify({ repos: { demo: config } }));
}

test('a repo that writes no land setting closes on the landing; only land.close_issue: false is carried', async () => {
  const base = { github: 'test/a', upstream: '/x', work: '/y' };
  const none = parseRepos(JSON.stringify({ repos: { 'test/a': base } }));
  const on = parseRepos(JSON.stringify({ repos: { 'test/a': { ...base, land: { close_issue: true } } } }));
  const off = parseRepos(JSON.stringify({ repos: { 'test/a': { ...base, land: { close_issue: false } } } }));
  assert.equal(closesOnLand(none.areas['test/a']), true, 'the default is ON');
  assert.equal('land' in none.areas['test/a'], false);
  assert.equal('land' in on.areas['test/a'], false, 'true is the default and is not carried');
  // a repo that writes nothing keeps the settings hash it had, so its saved submits and landings stay valid
  assert.equal(key(none.areas['test/a']), key(on.areas['test/a']));
  assert.equal(closesOnLand(off.areas['test/a']), false);
  assert.deepEqual(off.areas['test/a'].land, { close_issue: false });
  // a value that is not a boolean is a config error, and a misspelt field is not dropped
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'test/a': { ...base, land: { close_issue: 'no' } } } })), /close_issue/);
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'test/a': { ...base, land: { close: false } } } })), /知らない欄/);
});

test('a GitHub lane of a repo that leaves the close ON carries the Issue and the one-liner in the checked record', async () => {
  const f = setup();
  change(f);
  const prepared = await prepareLand('IDD-1');
  assert.deepEqual(prepared.close, { repo: 'test/project', issue: 7, url: 'https://github.com/test/project/issues/7', comment: closeBody(7) });
  assert.equal(prepared.closeCard, undefined);
});

test('one signed approval merges and closes the Issue through the close door, with no outbound card', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const { calls, queued, runner } = closeDoor(() => ({ status: 'posted', url: 'https://github.com/test/project/issues/7' }));
  setAgentRunner(runner);
  try {
    const res = await approveLandSigned(prepared.token);
    assert.equal(res.ok, true, res.error);
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { kind: 'gh-issue-close', target: { repo: 'test/project', issue: 7 }, title: 'Issue #7 を閉じる', body: closeBody(7), source: 'IDD-1' });
  assert.equal(queued.length, 0, 'no outbound card is stacked for a close the approval signed');
  const evs = eventsOf('IDD-1');
  assert.ok(evs.includes('s4_land_issue_close_posted'));
  assert.equal(evs.includes('s4_land_issue_close_queued'), false);
  const posted = readLifecycle().find((e) => e.idd_id === 'IDD-1' && e.event === 's4_land_issue_close_posted');
  assert.equal(posted.attrs.issue, 'https://github.com/test/project/issues/7');
  assert.equal(posted.attrs.outbound_id, 'OUT-1');
});

test('a signature over other content does not land an ON repo and never closes the Issue', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const saved = readLand('IDD-1');
  const tip = mainTip(f);
  const cases = [
    ['no close', verifiedNonceFor(landContentFor({ ...saved, close: undefined }))],
    ['another Issue', verifiedNonceFor(landContentFor({ ...saved, close: { ...saved.close, issue: 8 } }))],
    ['another one-liner', verifiedNonceFor(landContentFor({ ...saved, close: { ...saved.close, comment: 'x' } }))],
  ];
  const { calls, runner } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(runner);
  try {
    for (const [name, nonce] of cases) {
      const res = await approveLand('IDD-1', prepared.token, { nonce });
      assert.equal(res.ok, false, name);
      assert.equal(mainTip(f), tip, name);
      assert.equal(eventsOf('IDD-1').includes('s4_land_approved'), false, name);
    }
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 0);
});

test('a repo that turns the close off keeps the outbound card and does not post it', async () => {
  const f = setup({ land: { close_issue: false }, checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.close, undefined);
  assert.deepEqual(prepared.closeCard, { repo: 'test/project', issue: 7, url: 'https://github.com/test/project/issues/7' });
  const { calls, queued, runner } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(runner);
  try {
    const res = await approveLandSigned(prepared.token);
    assert.equal(res.ok, true, res.error);
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 0, 'the immediate door is not used when the close is off');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'gh-issue-close');
  assert.deepEqual(queued[0].target, { repo: 'test/project', issue: 7 });
  const evs = eventsOf('IDD-1');
  assert.ok(evs.includes('s4_land_issue_close_queued'));
  assert.equal(evs.includes('s4_land_issue_close_posted'), false);
});

test('the Issue close runs after the merge, the lane close and the record', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const { calls, runner } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(runner);
  try { await approveLandSigned(prepared.token); } finally { setAgentRunner(null); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].laneClosed, true);
  assert.equal(calls[0].status, 'complete');
  assert.equal(calls[0].head, calls[0].mergeCommit, 'the mainline is at the merge commit when the close runs');
  // a lane that could not be closed as landed is not closed at all
  const g = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(g);
  const p2 = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: p2.head, merge_commit: p2.mergeCommit, signed: true });
  git(g.work, 'merge', '--ff-only', p2.mergeCommit);
  const { calls: c2, runner: r2 } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(r2);
  try {
    const res = await recheckApprovedLand('IDD-1');
    assert.equal(res.ok, false, 'no submit card: the lane close refuses');
  } finally { setAgentRunner(null); }
  assert.equal(c2.length, 0);
});

test('a close that failed is recorded with its reason and does not take the merge back', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const { runner } = closeDoor(() => ({ status: 'failed', error: 'HTTP 422' }));
  setAgentRunner(runner);
  let res;
  try { res = await approveLandSigned(prepared.token); } finally { setAgentRunner(null); }
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(mainTip(f), prepared.mergeCommit);
  const evs = eventsOf('IDD-1');
  assert.ok(evs.includes('lane_close'));
  assert.equal(readLand('IDD-1')?.status, 'complete');
  const failed = readLifecycle().find((e) => e.idd_id === 'IDD-1' && e.event === 's4_land_issue_close_failed');
  assert.ok(failed, 'the failure is on the timeline');
  assert.equal(failed.attrs.outbound_id, 'OUT-1');
  assert.match(String(failed.attrs.reason), /422/);
});

test('a close door that throws is caught: the approval stays a success and the failure is recorded', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const { runner } = closeDoor(() => { throw new Error('gh を起動できません'); });
  setAgentRunner(runner);
  let res;
  try { res = await approveLandSigned(prepared.token); } finally { setAgentRunner(null); }
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(mainTip(f), prepared.mergeCommit);
  assert.ok(eventsOf('IDD-1').includes('lane_close'));
  const failed = readLifecycle().find((e) => e.idd_id === 'IDD-1' && e.event === 's4_land_issue_close_failed');
  assert.ok(failed);
  assert.equal(failed.attrs.outbound_id, undefined);
  assert.match(String(failed.attrs.reason), /gh を起動できません/);
});

test('a held approval keeps the signed close and the tick posts it with the recorded values', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const { calls, runner } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(runner);
  try {
    const held = await approveLandSigned(prepared.token);
    assert.ok(held.held, JSON.stringify(held));
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 0, 'nothing is closed while the merge waits');
  const mark = readLifecycle().find((e) => e.idd_id === 'IDD-1' && e.event === 's4_land_approved');
  assert.deepEqual(mark.attrs.close, { repo: 'test/project', issue: 7, url: 'https://github.com/test/project/issues/7', comment: closeBody(7) });
  // the setting is turned off after the approval: the recorded close still runs
  git(f.work, 'checkout', '--', 'app.txt');
  reconfigure(f, { land: { close_issue: false } });
  setAgentRunner(runner);
  try {
    const res = await recheckApprovedLand('IDD-1');
    assert.equal(res.ok, true, res.error);
    assert.ok(res.checking, 'the changed settings ask for a check, and it runs detached');
    await landSettled('IDD-1');
    const merged = await runLand();
    assert.ok(merged.merged.includes('IDD-1'), JSON.stringify(merged));
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts.target, { repo: 'test/project', issue: 7 });
  assert.equal(calls[0].opts.body, closeBody(7));
});

test('a Linear lane closes nothing and queues nothing', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  makeLinear(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.close, undefined);
  assert.equal(prepared.closeCard, undefined);
  const { calls, queued, runner } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(runner);
  try {
    const res = await approveLandSigned(prepared.token);
    assert.equal(res.ok, true, res.error);
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 0);
  assert.equal(queued.length, 0);
  const evs = eventsOf('IDD-1');
  assert.equal(evs.includes('s4_land_issue_close_posted'), false);
  assert.equal(evs.includes('s4_land_issue_close_queued'), false);
});

test('an approval recorded without a close does not auto-close: the outbound card is queued', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  // an approval from before the close was signed: it carries no close
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  const { calls, queued, runner } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(runner);
  try {
    const res = await recheckApprovedLand('IDD-1');
    assert.equal(res.ok, true, res.error);
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 0, 'no auto close without a recorded close');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'gh-issue-close');
  assert.deepEqual(queued[0].target, { repo: 'test/project', issue: 7 });
  assert.ok(eventsOf('IDD-1').includes('s4_land_issue_close_queued'));
});

test('a runner without the close door queues the card; no runner at all is a success with nothing written', async () => {
  // no runner: nothing is written out, and the landing still succeeds
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  setAgentRunner(null);
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, true, res.error);
  assert.equal(mainTip(f), prepared.mergeCommit);
  assert.ok(eventsOf('IDD-1').includes('lane_close'));
  assert.equal(eventsOf('IDD-1').includes('s4_land_issue_close_posted'), false);
  // a runtime with only the card queue (no immediate door): the card, as before
  const g = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(g);
  await atShip();
  const p2 = await prepareLand('IDD-1');
  const { queued, runner } = queueDoor();
  setAgentRunner(runner);
  try {
    const res2 = await approveLandSigned(p2.token);
    assert.equal(res2.ok, true, res2.error);
  } finally { setAgentRunner(null); }
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'gh-issue-close');
  assert.deepEqual(queued[0].target, { repo: 'test/project', issue: 7 });
});

test('a closed landing does not close the Issue twice on another tick', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  const { calls, queued, runner } = closeDoor(() => ({ status: 'posted' }));
  setAgentRunner(runner);
  try {
    assert.equal((await approveLandSigned(prepared.token)).ok, true);
    assert.equal((await recheckApprovedLand('IDD-1')).ok, true);
    await runLand();
  } finally { setAgentRunner(null); }
  assert.equal(calls.length, 1, 'the close is tried once');
  assert.equal(queued.length, 0);
});

test('a lane the harness merged the mainline into before its review lands without being held', async () => {
  const f = setup();
  const start = laneTip(f);
  await seedLifecycle('lane_open', 'IDD-1', {});
  await seedLifecycle('s2_start', 'IDD-1', { started_from_commit: start });
  await seedLifecycle('s2_result', 'IDD-1', {});
  change(f);
  put(join(f.work, 'main.txt'), 'mainline\n'); commit(f.work, 'chore: mainline move');
  setAgentRunner({ deliver: async () => {}, cwdBusy: () => false });
  try {
    await runReviewLoop();
  } finally { setAgentRunner(null); }
  assert.ok(eventsOf('IDD-1').includes('s2_review_base_merged'));
  await seedLifecycle('s3_ready', 'IDD-1', {});
  await seedLifecycle('s3_ok', 'IDD-1', {});
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const loc = laneLocations('IDD-1');
  assert.equal(stackedSubmitBlocker('IDD-1', loc), null);
  assert.equal(eventsOf('IDD-1').includes('lane_base_received'), false);
  assert.equal(existsSync(baseReceiptPath('IDD-1')), false);
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  assert.equal(res.held.some((h) => h.iddId === 'IDD-1'), false);
  const checked = await landSettled('IDD-1');
  assert.equal(checked.blocking, 0, JSON.stringify(checked.checks));
});

// --- a check that waits for a signal, so a test can watch the engine keep working (DEC-2330) ---

// --- the checks run in a process of their own (C-144-1) ---

/** a check that marks that it started and then waits for the signal file to appear */
const gateCheck = (started, signal) => [{ name: 'wait', command: ['bash', '-c', `touch ${JSON.stringify(started)}; while [ ! -f ${JSON.stringify(signal)} ]; do sleep 0.1; done`], required: true }];

/** start the lane's landing check and wait until the check itself is running (the copy is cut and the check began) */
async function startChecking(id, started) {
  const res = await prepareLandNow(id);
  assert.ok(res?.checking, JSON.stringify(res));
  assert.equal(res.waiting, undefined, JSON.stringify(res));
  await waitFor(() => existsSync(started));
  assert.equal(landRunChecking(id)?.id, res.runId, 'the run the entry answered with is the one reading it');
  return res;
}

test('AC-001: the landing preparation starts a check run of its own and returns at once', async () => {
  const dir = scratchDir('ac001-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  const running = await startChecking('IDD-1', started);
  // the entry returned while the check waits, the state can be read, and a timer callback runs
  let ran = false;
  await new Promise((r) => setTimeout(() => { ran = true; r(); }, 30));
  assert.equal(ran, true, 'the caller is not held by the check');
  assert.equal(readLand('IDD-1'), null, 'nothing is checked while the run reads it');
  assert.ok(Array.isArray(readLifecycle()));
  assert.equal(laneLocations('IDD-1')?.work, f.lane.path);
  assert.equal(running.head, laneTip(f));
  assert.ok(running.mergeCommit, 'the merge commit the run checks is already made');
  writeFileSync(signal, 'go');
  const prepared = await landSettled('IDD-1');
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.mergeCommit, running.mergeCommit);
  assert.equal(prepared.checks.find((c) => c.name === 'wait')?.status, 'pass');
});

test('AC-002: the re-check of an approved landing starts a run of its own and returns at once', async () => {
  const dir = scratchDir('ac002-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  // the first check passes at once, and the approval is held by a mainline move so the tick re-checks
  writeFileSync(signal, 'go');
  const prepared = await prepareLand('IDD-1');
  put(join(f.work, 'main.txt'), 'mainline\n'); commit(f.work, 'chore: mainline move');
  const held = await approveLandSigned(prepared.token);
  assert.ok(held.held, JSON.stringify(held));
  rmSync(started, { force: true }); rmSync(signal, { force: true });
  const res = await recheckApprovedLand('IDD-1');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.checking, 'the re-check runs detached, so the pass returns while it runs');
  await waitFor(() => existsSync(started));
  writeFileSync(signal, 'go');
  const record = await landSettled('IDD-1');
  assert.equal(record.checks.find((c) => c.name === 'wait')?.status, 'pass');
  const merged = await runLand();
  assert.ok(merged.merged.includes('IDD-1'), JSON.stringify(merged));
  assert.ok(eventsOf('IDD-1').includes('lane_close'));
  assert.equal(git(f.work, 'show', 'HEAD:app.txt'), 'two');
});

test('AC-010: a lane sent back while its landing checks run is not merged', async () => {
  const dir = scratchDir('ac010-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  writeFileSync(signal, 'go');
  const prepared = await prepareLand('IDD-1');
  put(join(f.work, 'main.txt'), 'mainline\n'); commit(f.work, 'chore: mainline move');
  const held = await approveLandSigned(prepared.token);
  assert.ok(held.held, JSON.stringify(held));
  rmSync(started, { force: true }); rmSync(signal, { force: true });
  const pending = recheckApprovedLand('IDD-1');
  await waitFor(() => existsSync(started));
  // penne sends the lane back while the check runs
  await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-1', { outcome: 'revise', instruction: 'fix' });
  writeFileSync(signal, 'go');
  const res = await pending;
  assert.ok(res.checking, JSON.stringify(res));
  await landSettled('IDD-1');
  const after = await runLand();
  assert.equal(after.merged.includes('IDD-1'), false, JSON.stringify(after));
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
  assert.notEqual(mainTip(f), prepared.mergeCommit);
});

test('AC-010: a lane commit during the preparation checks refuses the token at the approval', async () => {
  const dir = scratchDir('ac010b-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  await startChecking('IDD-1', started);
  put(join(f.lane.path, 'app.txt'), 'three\n'); commit(f.lane.path, 'feat: more');
  writeFileSync(signal, 'go');
  const prepared = await landSettled('IDD-1');
  assert.equal(prepared.status, 'prepared');
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /検査の後に lane の commit が進みました/);
});

test('AC-003 / C-144-3: an ask that meets a running check is answered as checking, and starts no second run', async () => {
  const dir = scratchDir('ac011-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  const first = await startChecking('IDD-1', started);
  const second = await prepareLandNow('IDD-1');
  assert.ok(second.checking, JSON.stringify(second));
  assert.equal(second.runId, first.runId, 'the same run reads the group');
  assert.equal(second.error, undefined, JSON.stringify(second));
  assert.equal(runningLandRuns().filter((r) => r.lane === 'IDD-1').length, 1, 'one run per group');
  writeFileSync(signal, 'go');
  const prepared = await landSettled('IDD-1');
  assert.equal(prepared.checks.find((c) => c.name === 'wait')?.status, 'pass');
  // the repo's lock, while the merge commit and the copy are made, keeps its own messages
  const common = resolve(f.work, git(f.work, 'rev-parse', '--git-common-dir'));
  const path = join(common, 'idd-overlay.lock');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: 999999, at: new Date().toISOString(), checks: true }));
  try {
    const stale = await prepareLandNow('IDD-1');
    assert.ok('error' in stale);
    assert.match(stale.error, /owner\.json/);
    assert.doesNotMatch(stale.error, /検査が走っています/);
  } finally { rmSync(path, { recursive: true, force: true }); }
  // a holder that is not running the checks keeps the old message too
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const busy = await prepareLandNow('IDD-1');
    assert.ok('error' in busy);
    assert.match(busy.error, /owner\.json/);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('AC-013: the tick does not record a lock refusal of the landing preparation as a failure, and takes the lane up once it ends', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  // the repo's lock is held for its checks: prepareLand is refused
  const release = lock(laneLocations('IDD-1').work, { checks: true });
  let refused;
  try { refused = await runLand(); } finally { release(); }
  assert.deepEqual(refused.errors, [], JSON.stringify(refused));
  assert.equal(refused.held.length, 0, JSON.stringify(refused));
  assert.equal(refused.checking.includes('IDD-1'), false);
  assert.equal(eventsOf('IDD-1').includes('s4_land_held'), false, 'the lock refusal holds nothing');
  // once the checks end, the next tick starts the landing check
  const after = await runLand();
  assert.ok(after.checking.includes('IDD-1'), JSON.stringify(after));
  assert.deepEqual(after.errors, [], JSON.stringify(after));
  const settled = await landSettled('IDD-1');
  assert.equal(settled.status, 'prepared');
  assert.equal(settled.blocking, 0, JSON.stringify(settled.checks));
});

/** add a second lane of the same repo, at the submit card, with a change of its own */
async function secondLane(f, id = 'IDD-2') {
  put(join(f.state, 'backlog.jsonl'), readFileSync(join(f.state, 'backlog.jsonl'), 'utf8') + JSON.stringify({ idd_id: id, area: 'demo', title: 'feat: second', source_type: 'github', gh_issue_url: 'https://github.com/test/project/issues/8' }) + '\n');
  const lane = ensureLaneWorktree('demo', id);
  put(join(f.state, 'executor-sessions.jsonl'), readFileSync(join(f.state, 'executor-sessions.jsonl'), 'utf8') + JSON.stringify({ idd_id: id, worktree_path: lane.path, branch: lane.branch, executor_session_id: 'test-session-2' }) + '\n');
  put(join(lane.path, 'second.txt'), 'second\n'); commit(lane.path, 'feat: second');
  for (const [event, attrs] of [['lane_open', {}], ['s2_start', {}], ['s2_result', {}], ['s3_ready', {}]]) await seedLifecycle(event, id, attrs);
  await seedLifecycle('s3_ok', id, {});
  await seedLifecycle('s4_submit_started', id, {});
  return lane;
}

test('C-144-2 / C-144-5: a signed landing goes in while another lane’s check runs, and that check’s result is not used', async () => {
  const dir = scratchDir('ac012-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  // lane 2 is checked while the signal is there, so its check passes at once
  writeFileSync(signal, 'go');
  await secondLane(f);
  const prepared2 = await prepareLand('IDD-2');
  assert.equal(prepared2.status, 'prepared');
  // lane 1's check is running, and it does not hold the repo's lock (C-144-2)
  rmSync(started, { force: true }); rmSync(signal, { force: true });
  const running1 = await startChecking('IDD-1', started);
  const signed = await approveLand('IDD-2', prepared2.token, landApproved('IDD-2'));
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.held, undefined, 'the signed merge did not wait for the other lane’s check');
  assert.equal(mainTip(f), prepared2.mergeCommit, 'the signed merge went in at once');
  assert.ok(eventsOf('IDD-2').includes('lane_close'));
  // the running check read the mainline as it was before that merge: its result is not the one the lane now needs
  writeFileSync(signal, 'go');
  const settled = await landSettled('IDD-1');
  assert.equal(settled.mainTip, running1.mainTip, 'the record is for the group the run read');
  assert.notEqual(settled.mainTip, mainTip(f));
  assert.equal(landReadyAt('IDD-1', laneLocations('IDD-1')), null, 'a record of another tip is not an approval’s to use');
  const next = await runLand();
  assert.ok(next.checking.includes('IDD-1'), JSON.stringify(next));
  const again = await landSettled('IDD-1');
  assert.equal(again.mainTip, mainTip(f), 'the lane is checked again at the moved mainline');
});

// --- a signed landing goes ahead of the other lanes' checks (IDD-094) ---

/** a check that records one run per execution, so a test can count how often it was run */
const countingCheck = (file) => [{ name: 'count', command: ['bash', '-c', `echo run >> ${JSON.stringify(file)}`], required: true }];
const checkRuns = (file) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
/** the second-precision stamp the engine writes, so a test can put two approvals in the same second */
function isoSec(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
/** append the fixture's lifecycle record with a chosen `at`, so two approvals can share a second */
function appendLifecycleAt(at, event, iddId, attrs = {}) {
  appendFileSync(join(process.env.IDD_STATE_DIR, 'lifecycle-demo.jsonl'), JSON.stringify({ event, idd_id: iddId, at, attrs }) + '\n', 'utf8');
}

test('AC-001: a signed landing goes in before an earlier backlog lane is checked, and that lane is checked at the new tip', async () => {
  const dir = scratchDir('idd094-ac001-');
  const count = join(dir, 'count');
  const f = setup({ checks: countingCheck(count) });
  change(f);
  await atShip();
  await secondLane(f);
  const prepared2 = await prepareLand('IDD-2');
  assert.ok(prepared2.mergeCommit, JSON.stringify(prepared2));
  await appendLifecycle('s4_land_approved', 'IDD-2', { head: prepared2.head, merge_commit: prepared2.mergeCommit, signed: true });
  const before = checkRuns(count);
  const res = await runLand();
  assert.ok(res.merged.includes('IDD-2'), JSON.stringify(res));
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  assert.equal(mainTip(f), prepared2.mergeCommit, 'the signed lane went in first');
  const checked = await landSettled('IDD-1');
  assert.equal(checked.mainTip, prepared2.mergeCommit, 'the earlier lane was checked at the new tip');
  assert.equal(checkRuns(count), before + 1, 'the signed lane was not checked again, only the earlier lane was');
});

test('AC-002: a signature that arrives while a check runs is carried out without waiting for it', async () => {
  const dir = scratchDir('idd094-ac002-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  await secondLane(f, 'IDD-2');
  // the second lane's check passes at once, so its landing is the one the signature names
  writeFileSync(signal, 'go');
  const prepared2 = await prepareLand('IDD-2');
  assert.ok(prepared2.mergeCommit, JSON.stringify(prepared2));
  rmSync(started, { force: true }); rmSync(signal, { force: true });
  // the first lane's check runs
  await startChecking('IDD-1', started);
  const signed = await approveLand('IDD-2', prepared2.token, landApproved('IDD-2'));
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.held, undefined, 'the signature did not wait for the other lane’s check (C-144-2)');
  assert.equal(mainTip(f), prepared2.mergeCommit, 'the signed lane went in while the check ran');
  // the check that was running read the old tip: the first lane is checked again at the new one
  writeFileSync(signal, 'go');
  await landSettled('IDD-1');
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  const checked = await landSettled('IDD-1');
  assert.equal(checked.mainTip, prepared2.mergeCommit, 'the first lane was checked after the signed lane merged');
});

test('AC-003: a signature that arrives while the last lane is checked goes in before the pass ends', async () => {
  const dir = scratchDir('idd094-ac003-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  await secondLane(f);
  writeFileSync(signal, 'go');
  const prepared1 = await prepareLand('IDD-1');
  assert.ok(prepared1.mergeCommit, JSON.stringify(prepared1));
  rmSync(started, { force: true }); rmSync(signal, { force: true });
  // the second (last) lane's check runs
  await startChecking('IDD-2', started);
  // the first lane is signed while it runs: the signature goes in without waiting for it
  const signed = await approveLand('IDD-1', prepared1.token, landApproved('IDD-1'));
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(mainTip(f), prepared1.mergeCommit, 'the signature went in while the check ran');
  writeFileSync(signal, 'go');
  await landSettled('IDD-2');
  // the check read the old tip, so the last lane is checked again at the merged one
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-2'), JSON.stringify(res));
});

test('C-202-5: a held or a closed approved lane is left before its state file is read', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  // the signature meets the checks' lock, so the approval waits for the next tick
  const release = lock(laneLocations('IDD-1').work, { checks: true });
  let held;
  try { held = await approveLandSigned(prepared.token); } finally { release(); }
  assert.ok(held.held, JSON.stringify(held));
  // two approved lanes the carried approvals leave: one closed, one held. Their state file is not JSON, so a
  // read of it would throw, and the only reason runLand can finish is that neither lane's file was read
  const atCard = [['lane_open', {}], ['s2_start', {}], ['s2_result', {}], ['s3_ready', {}], ['s3_ok', {}], ['s4_submit_started', {}]];
  const approved = ['s4_land_approved', { head: 'a'.repeat(40), merge_commit: 'b'.repeat(40), signed: true }];
  await outOfScopeLane(f, 'IDD-8', [...atCard, approved, ['lane_close', { outcome: 'local' }]]);
  await outOfScopeLane(f, 'IDD-9', [...atCard, approved, ['lane_stalled', { role: 'executor', cause: 'error', reason: 'session が落ちた' }]]);
  const res = await runLand();
  assert.ok(res.merged.includes('IDD-1'), JSON.stringify(res));
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.equal(eventsOf('IDD-8').includes('s4_land_merged'), false);
  assert.equal(eventsOf('IDD-9').includes('s4_land_merged'), false);
});

/**
 * An approved lane the carried approvals must leave, whose state file (the custody record) is not JSON: a reader
 * of it throws, so a run that finishes did not read it. The session row is there, so the lane's location would be
 * readable up to that file.
 */
async function outOfScopeLane(f, id, rows) {
  put(join(f.state, 'backlog.jsonl'), readFileSync(join(f.state, 'backlog.jsonl'), 'utf8') + JSON.stringify({ idd_id: id, area: 'demo', title: 'feat: out of scope', source_type: 'github', gh_issue_url: 'https://github.com/test/project/issues/9' }) + '\n');
  put(join(f.state, 'executor-sessions.jsonl'), readFileSync(join(f.state, 'executor-sessions.jsonl'), 'utf8') + JSON.stringify({ idd_id: id, worktree_path: f.lane.path, branch: f.lane.branch, executor_session_id: `test-session-${id}` }) + '\n');
  put(custodyPath(id), 'この lane は対象外なので、置き場所を読んではいけない\n');
  for (const [event, attrs] of rows) await seedLifecycle(event, id, attrs);
}

test('AC-004: a signed landing whose head and mainline are unchanged goes in without the checks running again', async () => {
  const dir = scratchDir('idd094-ac004-');
  const count = join(dir, 'count');
  const f = setup({ checks: countingCheck(count) });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  // the signature meets the checks' lock, so the approval waits
  const release = lock(laneLocations('IDD-1').work, { checks: true });
  let held;
  try { held = await approveLandSigned(prepared.token); } finally { release(); }
  assert.ok(held.held, JSON.stringify(held));
  const before = checkRuns(count);
  const res = await runLand();
  assert.ok(res.merged.includes('IDD-1'), JSON.stringify(res));
  assert.equal(mainTip(f), prepared.mergeCommit, 'the mainline is the card merge commit');
  assert.equal(checkRuns(count), before, 'the checks did not run after the signature');
});

test('AC-005: an expired record and a changed config re-check before the landing goes in', async () => {
  // an expired record
  const a = scratchDir('idd094-ac005a-');
  const countA = join(a, 'count');
  const fa = setup({ checks: countingCheck(countA) });
  change(fa);
  await atShip();
  const pa = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: pa.head, merge_commit: pa.mergeCommit, signed: true });
  save(landPath('IDD-1'), { ...readLand('IDD-1'), expiresAt: new Date(0).toISOString() });
  const beforeA = checkRuns(countA);
  const ra = await recheckApprovedLand('IDD-1');
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.ok(ra.checking, 'the expired record asks for a check, and it runs detached');
  await landSettled('IDD-1');
  const mergedA = await runLand();
  assert.ok(mergedA.merged.includes('IDD-1'), JSON.stringify(mergedA));
  assert.ok(eventsOf('IDD-1').includes('lane_close'));
  assert.equal(checkRuns(countA), beforeA + 1, 'the checks ran once for the expired record');
  // a changed config (the repo's checks and the close setting both move the key)
  const b = scratchDir('idd094-ac005b-');
  const countB = join(b, 'count');
  const fb = setup({ checks: countingCheck(countB) });
  change(fb);
  await atShip();
  const pb = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: pb.head, merge_commit: pb.mergeCommit, signed: true });
  reconfigure(fb, { checks: countingCheck(countB), land: { close_issue: false } });
  const beforeB = checkRuns(countB);
  const rb = await recheckApprovedLand('IDD-1');
  assert.equal(rb.ok, true, JSON.stringify(rb));
  assert.ok(rb.checking, 'the changed settings ask for a check, and it runs detached');
  await landSettled('IDD-1');
  const mergedB = await runLand();
  assert.ok(mergedB.merged.includes('IDD-1'), JSON.stringify(mergedB));
  assert.ok(eventsOf('IDD-1').includes('lane_close'));
  assert.equal(checkRuns(countB), beforeB + 1, 'the checks ran once after the config changed');
});

test('AC-006: a signed landing whose check is saved lands though the lane carries past R2 results (R2 removed 2026-10-22)', async () => {
  for (const r2 of [
    [['s3_r2_done', { must: 1, should: 0 }]],
    [['s3_r2_done', { must: 0, should: 0 }], ['s3_r2_not_recorded', { reason: '記録の検査（scripts/check-docs.sh）が通らないので commit していません' }]],
  ]) {
    const dir = scratchDir('idd094-ac006a-');
    const count = join(dir, 'count');
    const f = setup({ checks: countingCheck(count) });
    change(f);
    await atShipWithR2(r2);
    const prepared = await prepareLand('IDD-1');
    assert.ok(prepared.mergeCommit, JSON.stringify(prepared));
    await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
    const before = checkRuns(count);
    const res = await runLand();
    assert.ok(res.merged.includes('IDD-1'), JSON.stringify(res));
    assert.equal(mainTip(f), prepared.mergeCommit);
    assert.equal(checkRuns(count), before, 'the saved check is used, not run again');
  }
});

test('AC-006: a broken overlay.manifest stops a signed landing whose check is saved', async () => {
  const dir = scratchDir('idd094-ac006c-');
  const count = join(dir, 'count');
  const f = setup({ checks: countingCheck(count) });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  // break the manifest without dirtying the checkout: the saved check is still usable, so the skip path's guard
  // read is what has to stop it
  git(f.lane.path, 'update-index', '--skip-worktree', 'overlay.manifest');
  put(join(f.lane.path, 'overlay.manifest'), 'app.txt\n');
  assert.equal(git(f.lane.path, 'status', '--porcelain', '--untracked-files=all'), '', 'the checkout is not dirty');
  const before = checkRuns(count);
  const tip = mainTip(f);
  const res = await runLand();
  assert.equal(mainTip(f), tip, 'the mainline did not move');
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
  assert.ok(res.errors.some((e) => e.iddId === 'IDD-1' && /overlay\.manifest/.test(e.error)), JSON.stringify(res));
  assert.equal(checkRuns(count), before, 'the checks did not run');
});

test('AC-006: a dirty checkout holds a signed landing, and it lands once clean without new checks', async () => {
  const dir = scratchDir('idd094-ac006d-');
  const count = join(dir, 'count');
  const f = setup({ checks: countingCheck(count) });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const before = checkRuns(count);
  const held = await runLand();
  assert.ok(held.held.some((h) => h.iddId === 'IDD-1'), JSON.stringify(held));
  assert.equal(mainTip(f), prepared.mainTip);
  assert.equal(checkRuns(count), before, 'nothing was checked while the checkout was dirty');
  git(f.work, 'checkout', '--', 'app.txt');
  const res = await runLand();
  assert.ok(res.merged.includes('IDD-1'), JSON.stringify(res));
  assert.equal(mainTip(f), prepared.mergeCommit);
  assert.equal(checkRuns(count), before, 'the saved check was used, not run again');
});

test('AC-007: two signed landings go in in signature order, also in the same second', async () => {
  const dir = scratchDir('idd094-ac007-');
  const count = join(dir, 'count');
  const f = setup({ checks: countingCheck(count) });
  change(f);
  await atShip();
  await secondLane(f);
  const prepared1 = await prepareLand('IDD-1');
  const prepared2 = await prepareLand('IDD-2');
  assert.ok(prepared1.mergeCommit && prepared2.mergeCommit, JSON.stringify([prepared1, prepared2]));
  // the later backlog lane is signed first, and both approvals carry the same second
  const at = isoSec();
  appendLifecycleAt(at, 's4_land_approved', 'IDD-2', { head: prepared2.head, merge_commit: prepared2.mergeCommit, signed: true });
  appendLifecycleAt(at, 's4_land_approved', 'IDD-1', { head: prepared1.head, merge_commit: prepared1.mergeCommit, signed: true });
  const approvals = readLifecycle().filter((e) => e.event === 's4_land_approved');
  assert.equal(approvals.length, 2, JSON.stringify(approvals));
  assert.equal(approvals[0].at, approvals[1].at, 'the two signatures share a second');
  const res = await runLand();
  assert.deepEqual(res.merged, ['IDD-2'], JSON.stringify(res));
  assert.doesNotThrow(() => git(f.work, 'merge-base', '--is-ancestor', prepared2.mergeCommit, mainTip(f)), 'the first-signed lane merged first');
  // the second-signed lane's check is for the tip before that merge, so it is checked again and merged by a later pass
  const checked = await landSettled('IDD-1');
  assert.notEqual(checked.mergeCommit, prepared1.mergeCommit, 'the second-signed lane was re-checked at the new tip');
  assert.equal(checked.mainTip, mainTip(f));
  const after = await runLand();
  assert.ok(after.merged.includes('IDD-1'), JSON.stringify(after));
  assert.doesNotThrow(() => git(f.work, 'merge-base', '--is-ancestor', readLand('IDD-1').mergeCommit, mainTip(f)));
});

test('AC-008: an un-landable signed lane is tried once and does not stop another lane from being checked', async () => {
  const dir = scratchDir('idd094-ac008-');
  const count = join(dir, 'count');
  const f = setup({ checks: countingCheck(count) });
  change(f);
  await atShip();
  await secondLane(f);
  const prepared1 = await prepareLand('IDD-1');
  assert.ok(prepared1.mergeCommit, JSON.stringify(prepared1));
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared1.head, merge_commit: prepared1.mergeCommit, signed: true });
  // a manifest broken without dirtying the checkout makes the signed lane un-landable at its guard read
  git(f.lane.path, 'update-index', '--skip-worktree', 'overlay.manifest');
  put(join(f.lane.path, 'overlay.manifest'), 'app.txt\n');
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-2'), JSON.stringify(res));
  const other = await landSettled('IDD-2');
  assert.ok(other?.mergeCommit, 'the other lane was checked and its record saved');
  const tried = [...res.errors, ...res.held].filter((e) => e.iddId === 'IDD-1');
  assert.equal(tried.length, 1, JSON.stringify(tried));
});

test('AC-011: a lane whose head moved after the approval is not merged, drops the approval, and is not checked in that pass', async () => {
  const dir = scratchDir('idd094-ac011-');
  const count = join(dir, 'count');
  const f = setup({ checks: countingCheck(count) });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  // a new commit lands on the lane after the approval
  put(join(f.lane.path, 'more.txt'), 'more\n'); commit(f.lane.path, 'feat: more');
  const before = checkRuns(count);
  const tip = mainTip(f);
  const res = await runLand();
  assert.equal(mainTip(f), tip, 'the mainline did not move');
  assert.ok(eventsOf('IDD-1').includes('s4_land_approval_dropped'));
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
  assert.equal(checkRuns(count), before, 'the checks did not run in the pass that dropped the approval');
  // the next pass starts the check for the new head, and does not merge it without a signature
  const after = await runLand();
  assert.ok(after.checking.includes('IDD-1'), JSON.stringify(after));
  const checked = await landSettled('IDD-1');
  assert.equal(checked.head, laneTip(f), 'the new head was checked');
  assert.equal(checked.mainTip, mainTip(f));
  assert.equal(checkRuns(count), before + 1, 'the new head was checked once');
  assert.equal(after.merged.length, 0, JSON.stringify(after));
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
});

test('AC-010: the close record confirms what the results confirm, not the last progress note', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  // the plan's criteria: the last progress note touched one, the result the executor sent confirmed all three
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), ['# QA', '', '- AC-001: one', '- AC-002: two', '- AC-003: three'].join('\n') + '\n');
  put(join(f.state, 'executor-progress-IDD-1.json'), JSON.stringify({
    idd_id: 'IDD-1', updated_at: '2026-09-25T00:00:00Z', current_step: '', qa_status: [{ qa_id: 'AC-001', status: 'verified' }], recent_activity: [],
  }));
  commit(f.lane.path, 'docs: criteria');
  await seedLifecycle('lane_open', 'IDD-1', {});
  await seedLifecycle('s2_start', 'IDD-1', {});
  await seedLifecycle('s2_result', 'IDD-1', { outcome: 'success', qa_verified: ['AC-001', 'AC-002', 'AC-003'], qa_unverified: [] });
  await seedLifecycle('s3_ready', 'IDD-1', {});
  await seedLifecycle('s3_ok', 'IDD-1', {});
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const prepared = await prepareLand('IDD-1');
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, true, res.error);
  const close = readLifecycle().filter((e) => e.idd_id === 'IDD-1' && e.event === 'lane_close')[0];
  assert.deepEqual(close.attrs.final_qa_verified, ['AC-1', 'AC-2', 'AC-3']);
});

// --- the landing checks as runs of their own (IDD-144) ---

/** the copy a run reads, or null when it has not cut one yet */
const copyOf = (lane) => readLandRun(lane)?.copy ?? null;
/** whether a process number still has a process behind it */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function pidGone(pid) { await waitFor(() => !pidAlive(pid)); }

test('AC-004: the checks running at once stay within the limit, and a lane over it is taken up by a later tick', async () => {
  const dir = scratchDir('ac004-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  await secondLane(f, 'IDD-2');
  await secondLane(f, 'IDD-3');
  const saved = process.env.IDD_LAND_CHECK_LIMIT;
  process.env.IDD_LAND_CHECK_LIMIT = '2';
  try {
    const first = await runLand();
    assert.deepEqual([...first.checking].sort(), ['IDD-1', 'IDD-2'], JSON.stringify(first));
    assert.equal(runningLandRuns().length, 2);
    // both runs have cut their copies: the checks are reading them, not holding the repo's lock. Asking before
    // that is answered with the lock refusal, not with the slot the two hold (the signed re-check test waits so)
    await waitFor(() => ['IDD-1', 'IDD-2'].every((id) => existsSync(readLandRun(id)?.copy ?? '')));
    // the third lane asks again and again: no run is started while the two hold the slots
    const third = await prepareLandNow('IDD-3');
    assert.ok(third.checking, JSON.stringify(third));
    assert.ok(third.waiting, JSON.stringify(third));
    assert.equal(readLandRun('IDD-3'), null, 'the lane over the limit holds no run');
    assert.equal(runningLandRuns().length, 2);
    assert.equal(eventsOf('IDD-3').includes('s4_land_held'), false, 'waiting for a slot is not a hold on record');
    // a slot frees, and a later tick starts it. A tick that meets the overlay lock is skipped silently,
    // so the tick is asked again a finite number of times, and the limit is read after every one of them
    writeFileSync(signal, 'go');
    await waitFor(() => runningLandRuns().length === 0);
    let after;
    for (let tick = 0; tick < 20 && !after?.checking.includes('IDD-3'); tick += 1) {
      if (tick) await sleep(50);
      after = await runLand();
      assert.ok(runningLandRuns().length <= 2, 'the checks never run over the limit');
    }
    assert.deepEqual(after.checking, ['IDD-3'], JSON.stringify(after));
    const record = await landSettled('IDD-3');
    assert.equal(record.blocking, 0, JSON.stringify(record.checks));
  } finally {
    if (saved === undefined) delete process.env.IDD_LAND_CHECK_LIMIT;
    else process.env.IDD_LAND_CHECK_LIMIT = saved;
  }
});

test('AC-005: a signed re-check stops an unsigned check when the limit is full', async () => {
  const dir = scratchDir('ac005-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  await secondLane(f, 'IDD-2');
  await secondLane(f, 'IDD-3');
  const saved = process.env.IDD_LAND_CHECK_LIMIT;
  process.env.IDD_LAND_CHECK_LIMIT = '2';
  try {
    const first = await runLand();
    assert.deepEqual([...first.checking].sort(), ['IDD-1', 'IDD-2'], JSON.stringify(first));
    // both runs have cut their copies: the checks are reading them
    await waitFor(() => ['IDD-1', 'IDD-2'].every((id) => existsSync(readLandRun(id)?.copy ?? '')));
    const victim = { ...readLandRun('IDD-1') };
    assert.ok(victim.copy, 'the running check holds a copy');
    // penne signs the third lane: its check has no slot, so one unsigned check is stopped for it
    await appendLifecycle('s4_land_approved', 'IDD-3', { head: laneHead('IDD-3'), signed: true });
    await runLand();
    const signed = readLandRun('IDD-3');
    assert.equal(signed.status, 'running');
    assert.equal(signed.signed, true, 'the run of the signed check is marked');
    assert.equal(readLandRun('IDD-1').status, 'stopped', 'the unsigned check of the full limit was stopped');
    assert.equal(runningLandRuns().length, 2, 'the signed check took a slot, not one more');
    // the stopped check left no result of its own, and its copy is gone with it
    await pidGone(victim.pid);
    assert.equal(existsSync(victim.copy), false, 'the stopped check removed its copy');
    assert.equal(readLand('IDD-1'), null, 'the stopped check wrote no result');
    // the stopped lane is checked again by a later tick
    writeFileSync(signal, 'go');
    await landSettled('IDD-3');
    await waitFor(() => runningLandRuns().length === 0);
    const again = await runLand();
    assert.ok(again.checking.includes('IDD-1'), JSON.stringify(again));
    const record = await landSettled('IDD-1');
    assert.equal(record.blocking, 0, JSON.stringify(record.checks));
  } finally {
    if (saved === undefined) delete process.env.IDD_LAND_CHECK_LIMIT;
    else process.env.IDD_LAND_CHECK_LIMIT = saved;
  }
});

test('AC-006: a check whose group was replaced never writes over the newer run’s record', async () => {
  const dir = scratchDir('ac006-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  const first = await startChecking('IDD-1', started);
  const firstRun = { ...readLandRun('IDD-1') };
  // the lane moves on: the ask for the new head stops the run of the old group and starts one for the new
  put(join(f.lane.path, 'more.txt'), 'more\n'); commit(f.lane.path, 'feat: more');
  const second = await prepareLandNow('IDD-1');
  assert.ok(second.checking, JSON.stringify(second));
  assert.notEqual(second.runId, first.runId, 'a run of its own reads the new group');
  await pidGone(firstRun.pid);
  assert.equal(existsSync(firstRun.copy), false, 'the stopped run of the old group took its copy');
  // both checks pass: only the newer run’s result is the lane’s record
  writeFileSync(signal, 'go');
  const record = await landSettled('IDD-1');
  assert.equal(record.head, laneTip(f), 'the record is the new head’s');
  assert.equal(record.mergeCommit, second.mergeCommit);
  assert.equal(record.mainTip, second.mainTip);
});

test('AC-007: a check whose process is gone leaves no copy and is not read as running', async () => {
  const dir = scratchDir('ac007-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  await startChecking('IDD-1', started);
  const run = { ...readLandRun('IDD-1') };
  assert.ok(run.copy && existsSync(run.copy));
  // the run is killed from outside: it cannot close its own record or remove its copy (IDD-114’s shape)
  process.kill(run.pid, 'SIGKILL');
  await pidGone(run.pid);
  assert.equal(landRunChecking('IDD-1'), null, 'a check with no process is not read as running');
  assert.equal(existsSync(run.copy), false, 'the reader removed the copy of the dead run');
  assert.equal(readLandRun('IDD-1').status, 'failed');
  assert.equal(readLand('IDD-1'), null, 'the dead run wrote no result');
  assert.equal(buildSubmit('IDD-1').landChecking, undefined, 'the card does not read it as running');
  // the lane is checked again by a later tick
  writeFileSync(signal, 'go');
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  const record = await landSettled('IDD-1');
  assert.equal(record.blocking, 0, JSON.stringify(record.checks));
});

/**
 * A running check stopped from outside (systemd stopping its scope, a person's Ctrl-C): the run is asked to end
 * while its checks read the copy. It keeps no result of a read it did not finish, closes no done record, removes its
 * copy, and leaves no running mark (C-144-5, AC-007). The lane is checked again by a later tick.
 */
async function stoppedFromOutside(signal) {
  const dir = scratchDir('ac007-stop-');
  const started = join(dir, 'started'), gate = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, gate) });
  change(f);
  await atShip();
  await startChecking('IDD-1', started);
  const run = { ...readLandRun('IDD-1') };
  assert.ok(run.copy && existsSync(run.copy), 'the run cut its copy');
  assert.ok(run.pid, 'the run named its process');
  process.kill(run.pid, signal);
  await pidGone(run.pid);
  // a check that was stopped mid-read is not a check that ran: the lane is not shown as checked
  assert.equal(readLand('IDD-1'), null, 'a check stopped from outside wrote no result');
  assert.equal(existsSync(run.copy), false, 'its copy went with it');
  assert.equal(readLandRun('IDD-1').status, 'stopped', 'the run is closed as stopped, not as done');
  assert.equal(readLandRun('IDD-1').result, undefined, 'no result is kept on the run either');
  assert.equal(landRunChecking('IDD-1'), null, 'it is not read as running');
  assert.equal(runningLandRuns().length, 0, 'the state holds no running check');
  assert.equal(buildSubmit('IDD-1').landChecking, undefined, 'the card does not read it as running either');
  // the lane is taken up by a later tick, and the check that runs is the lane's
  writeFileSync(gate, 'go');
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  const record = await landSettled('IDD-1');
  assert.equal(record.blocking, 0, JSON.stringify(record.checks));
}

test('AC-007 / F-1: a check stopped with SIGTERM keeps no result, no done record, and no copy', async () => {
  await stoppedFromOutside('SIGTERM');
});

test('AC-007 / F-1: a check stopped with SIGINT keeps no result, no done record, and no copy', async () => {
  await stoppedFromOutside('SIGINT');
});

test('AC-003: the card says a check is running and offers no second one, and the cleanup reads the repo as busy', async () => {
  const dir = scratchDir('ac003-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  await startChecking('IDD-1', started);
  const card = buildSubmit('IDD-1');
  assert.match(String(card.landChecking), /検査中/);
  assert.equal(card.land, null, 'nothing is checked yet, so no result is shown');
  // the cleanup that deletes a lane’s build output must not while a check of the repo reads it
  assert.equal(landChecksRunning(f.lane.path), true);
  assert.equal(landChecksRunning(f.work), true);
  writeFileSync(signal, 'go');
  await landSettled('IDD-1');
  assert.equal(landChecksRunning(f.lane.path), false, 'no check reads the repo once they ended');
  assert.equal(buildSubmit('IDD-1').landChecking, undefined);
  assert.ok(buildSubmit('IDD-1').land?.mergeCommit, 'the card shows the result the run wrote');
});

test('AC-002: the CLI reads a running check and where it ended from the run itself', async () => {
  const dir = scratchDir('ac002cli-');
  const started = join(dir, 'started'), signal = join(dir, 'signal');
  const f = setup({ checks: gateCheck(started, signal) });
  change(f);
  await atShip();
  const run = await startChecking('IDD-1', started);
  const cli = (args) => JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', join(original, 'packages/idd-cli/bin/idd.ts'), ...args], {
    cwd: f.work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, IDD_LANE_SCOPE: 'off', IDD_NO_TICK_KICK: '1' },
  }));
  const rows = cli(['lane', 'status', 'IDD-1']);
  const running = rows.find((r) => r.role === 'land-check');
  assert.ok(running, JSON.stringify(rows));
  assert.equal(running.status, 'running');
  assert.equal(running.head, run.head);
  assert.equal(running.mergeCommit, run.mergeCommit);
  assert.ok(running.worktree, 'the copy the check reads');
  // where it ended, from the same door
  writeFileSync(signal, 'go');
  await landSettled('IDD-1');
  const ended = cli(['lane', 'status', 'IDD-1']).find((r) => r.role === 'land-check');
  assert.equal(ended.status, 'done');
  assert.equal(ended.result.blocking, 0, JSON.stringify(ended.result));
  assert.ok(ended.ended_at, 'the end of the check is on the row');
});

/** a lane that came back with records alone: the plan under `_docs/`, which the fixture's manifest keeps private */
const recordsOnly = (f) => { put(join(f.lane.path, '_docs', 'plan.md'), '# plan\n'); commit(f.lane.path, 'docs: plan'); };

test('a lane that adds nothing public (records alone) is refused at the preparation, and the card is marked', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  recordsOnly(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, RECORDS_ONLY_REASON);
  assert.equal(prepared.mergeCommit, undefined, 'no merge commit is made for a records-only lane');
  assert.deepEqual(prepared.checks, []);
  // the card is marked before any check, from the same reading the guard makes
  const card = buildSubmit('IDD-1');
  assert.deepEqual(card.recordsOnly, { reason: RECORDS_ONLY_REASON });
  assert.equal(card.landBlocked, undefined, 'the mark is its own field, not a landBlocker reason');
});

test('a records-only lane is refused at the approval too, and the mainline stays where it was', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  assert.ok(prepared.mergeCommit, 'the public change was checked');
  const tip = mainTip(f);
  // the lane takes its public change back after the check, keeping a record: the token still names the checked
  // record, and the guards are read before the head is compared, so the refusal is the records-only one
  put(join(f.lane.path, 'app.txt'), 'one\n');
  recordsOnly(f);
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, false);
  assert.equal(res.error, RECORDS_ONLY_REASON);
  assert.equal(mainTip(f), tip);
  assert.ok(!eventsOf('IDD-1').includes('s4_land_approved'), 'no approval is recorded');
});

/** a survey lane: its report and its plan's two criteria are records, so its public side is the mainline's */
const surveyLane = (f) => {
  put(join(f.lane.path, '_docs/survey/demo/idd-1/survey.md'), '# survey\n');
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), ['# QA', '', '- AC-001: one', '- AC-002: two'].join('\n') + '\n');
  commit(f.lane.path, 'docs: survey');
};

/** put a lane at the submit card after the executor's `results`, oldest first (atShip's own result carries nothing) */
async function atShipAfter(...results) {
  await seedLifecycle('lane_open', 'IDD-1', {});
  await seedLifecycle('s2_start', 'IDD-1', {});
  for (const result of results) await seedLifecycle('s2_result', 'IDD-1', result);
  await seedLifecycle('s3_ready', 'IDD-1', {});
  await seedLifecycle('s3_ok', 'IDD-1', {});
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
}

test('a records-only lane whose executor finished with every criterion of the plan verified (a survey) is landed', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  surveyLane(f);
  await atShipAfter({ outcome: 'success', qa_verified: ['AC-001', 'AC-002'], qa_unverified: [] });
  assert.equal(buildSubmit('IDD-1').recordsOnly, undefined, 'the card offers the signature');
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, undefined);
  assert.ok(prepared.mergeCommit, 'a merge commit is checked');
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, true, res.error);
  assert.equal(mainTip(f), prepared.mergeCommit);
});

test('a records-only lane is still refused while the executor came back unfinished, at the card, the preparation and the approval', async () => {
  for (const [label, results] of [
    ['failed', [{ outcome: 'failed', qa_verified: [], qa_unverified: ['AC-001', 'AC-002'] }]],
    ['partial', [{ outcome: 'partial', qa_verified: ['AC-001', 'AC-002'], qa_unverified: [] }]],
    ['a success that names only part of the plan, with no unverified list', [{ outcome: 'success', qa_verified: ['AC-001'] }]],
    ['a fix round that reports one criterion after a result that left the other open', [
      { outcome: 'partial', qa_verified: ['AC-001'], qa_unverified: ['AC-002'] },
      { outcome: 'success', qa_verified: ['AC-001'], qa_unverified: [] },
    ]],
    ['a later failure after a success', [
      { outcome: 'success', qa_verified: ['AC-001', 'AC-002'], qa_unverified: [] },
      { outcome: 'failed', qa_verified: [], qa_unverified: [] },
    ]],
    ['no result at all', []],
  ]) {
    const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
    surveyLane(f);
    await atShipAfter(...results);
    assert.deepEqual(buildSubmit('IDD-1').recordsOnly, { reason: RECORDS_ONLY_REASON }, label);
    const prepared = await prepareLand('IDD-1');
    assert.equal(prepared.reason, RECORDS_ONLY_REASON, label);
    assert.equal(prepared.mergeCommit, undefined, label);
  }
});

test('a records-only lane whose plan has no criteria is refused even after a success', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  recordsOnly(f);
  await atShipAfter({ outcome: 'success', qa_verified: ['AC-001'], qa_unverified: [] });
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, RECORDS_ONLY_REASON);
});

test('a lane with one public line beside its records is landed as before', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  recordsOnly(f);
  change(f);
  await atShip();
  const card = buildSubmit('IDD-1');
  assert.equal(card.recordsOnly, undefined);
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, undefined);
  assert.ok(prepared.mergeCommit, 'a merge commit is checked');
  const res = await approveLandSigned(prepared.token);
  assert.equal(res.ok, true, res.error);
  assert.equal(mainTip(f), prepared.mergeCommit);
});

test('a records-only lane stays records-only after the mainline moved on (the merge base is compared, not the tip)', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  recordsOnly(f);
  await atShip();
  // other work lands on the mainline after the lane branched: the lane still adds nothing of its own
  put(join(f.work, 'app.txt'), 'from mainline\n'); commit(f.work, 'feat: other lane');
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, RECORDS_ONLY_REASON);
  assert.equal(prepared.mergeCommit, undefined);
  assert.deepEqual(buildSubmit('IDD-1').recordsOnly, { reason: RECORDS_ONLY_REASON });
});

test('a lane that only deletes a public file is not records-only', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  rmSync(join(f.lane.path, 'app.txt')); commit(f.lane.path, 'chore: drop app');
  await atShip();
  assert.equal(buildSubmit('IDD-1').recordsOnly, undefined);
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, undefined);
  assert.ok(prepared.mergeCommit);
});

test('a records-only lane the landBlocker refuses keeps the landBlocker reason, as the approval does', async () => {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }] });
  recordsOnly(f);
  await atShip();
  save(custodyPath('IDD-1'), { branch: f.lane.branch, publicTip: 'x', workTree: 'y', workHead: 'z' });
  const card = buildSubmit('IDD-1');
  assert.match(String(card.landBlocked), /公開 branch/);
  assert.equal(card.recordsOnly, undefined, 'the card says what the approval would say first');
  const prepared = await prepareLand('IDD-1');
  assert.match(String(prepared.reason), /公開 branch/);
});

test('a reading that fails for one lane is that lane\'s error, and the lanes after it still go through the stage', async () => {
  const f = setup({ publish: true, checks: [{ name: 'ok', command: 'true', required: true }] });
  change(f);
  // a second lane beside the first, so the first lane's failure has a lane after it to leave running
  const second = ensureLaneWorktree('demo', 'IDD-2');
  appendFileSync(join(f.state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-2', area: 'demo', title: 'feat: another change', source_type: 'github', gh_issue_url: 'https://github.com/test/project/issues/8' }) + '\n');
  put(join(second.path, 'app.txt'), 'two\n');
  commit(second.path, 'feat: another change');
  appendFileSync(join(f.state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-2', worktree_path: second.path, branch: second.branch, executor_session_id: 'test-session-2' }) + '\n');
  for (const id of ['IDD-1', 'IDD-2']) {
    await seedLifecycle('lane_open', id, {});
    await seedLifecycle('s2_start', id, {});
    await seedLifecycle('s2_result', id, {});
    await seedLifecycle('s3_ready', id, {});
    await seedLifecycle('s3_ok', id, {});
    await seedLifecycle('s4_submit_started', id, {});
  }
  // the first lane's saved submit cannot be read at all: a directory where its record would be
  mkdirSync(proposalPath('IDD-1'), { recursive: true });
  const push = await runSubmitPush();
  assert.equal(push.errors.length, 1, JSON.stringify(push));
  assert.equal(push.errors[0].iddId, 'IDD-1');
  assert.ok(push.errors[0].error.length > 0, 'the lane carries what the reading answered');
  assert.equal(push.errors[0].error.length <= 300, true, 'the lane error is cut, as the landing stage cuts it');
  // the lane after it was still read and run: it reached the card of its own submit
  assert.deepEqual(push.ready, ['IDD-2'], JSON.stringify(push));
  assert.equal(push.errors.some((e) => e.iddId === 'IDD-2'), false);
});

// ---- a generated file is made again in the landing's merge commit (C-261-1 / C-261-4 / C-261-7) ----

/** a lane and a mainline that both hold src.txt and the gen.txt built from it; `extra` goes into the repos.yaml entry */
function setupGen(extra = {}, seeded = { 'src.txt': SRC, 'gen.txt': genOf(SRC) }) {
  const f = setup({ checks: [{ name: 'ok', command: 'true', required: true }], generated_files: [GEN], ...extra });
  for (const [name, text] of Object.entries(seeded)) put(join(f.work, name), text);
  commit(f.work, 'chore: seed generated');
  git(f.lane.path, 'merge', '--ff-only', 'work-main');
  return f;
}
/** the mainline changes line 1 of src.txt and builds gen.txt; the lane changes line 3 and builds its own: src.txt merges, gen.txt conflicts */
function bothBuild(f) {
  const main = 'alpha2\nbeta\ngamma\n', lane = 'alpha\nbeta\ngamma2\n';
  writeIn(f.work, { 'src.txt': main, 'gen.txt': genOf(main) }, 'chore: mainline builds');
  writeIn(f.lane.path, { 'src.txt': lane, 'gen.txt': genOf(lane) }, 'feat: lane builds');
  return 'alpha2\nbeta\ngamma2\n';
}

/** the landing of IDD-1 that goes in: no reason holds it */
async function landsIn() {
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, undefined, JSON.stringify(prepared));
  return prepared;
}
/** the landing of IDD-1 that goes back over a conflict, with no merge commit made */
async function goesBack(label = '') {
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.reason, 'work 側の本流と衝突します', label);
  assert.equal(prepared.mergeCommit, undefined, label);
  return prepared;
}

test('AC-001 / AC-003: a conflict on a generated file alone is not sent back, and the merge commit holds the file built from its sources', async () => {
  const f = setupGen();
  const merged = bothBuild(f);
  const mainBefore = mainTip(f), laneBefore = laneTip(f);
  const prepared = await landsIn();
  assert.equal(prepared.conflict, undefined);
  assert.ok(prepared.mergeCommit);
  assert.equal(git(f.work, 'rev-parse', `${prepared.mergeCommit}^1`), mainBefore);
  assert.equal(git(f.work, 'rev-parse', `${prepared.mergeCommit}^2`), laneBefore);
  assert.equal(showFile(f.work, prepared.mergeCommit, 'src.txt'), merged);
  assert.equal(showFile(f.work, prepared.mergeCommit, 'gen.txt'), genOf(merged));
  // the checks ran on the commit that goes in
  assert.equal(prepared.blocking, 0, JSON.stringify(prepared.checks));
  assert.equal(mainTip(f), mainBefore, 'the mainline is not moved by the preparation');
});

test('AC-001: a generated file with a non-ASCII path that conflicts is matched with its declaration, not sent back as a source', async () => {
  const name = '生成物.txt';
  const f = setupGen({ generated_files: [{ ...GEN, paths: [name], command: `tr '\\n' ' ' < src.txt | tr a-z A-Z > ${name}` }] }, { 'src.txt': SRC, [name]: genOf(SRC) });
  const [main, lane] = ['alpha2\nbeta\ngamma\n', 'alpha\nbeta\ngamma2\n'];
  writeIn(f.work, { 'src.txt': main, [name]: genOf(main) }, 'chore: mainline builds');
  writeIn(f.lane.path, { 'src.txt': lane, [name]: genOf(lane) }, 'feat: lane builds');
  const prepared = await landsIn();
  assert.equal(showFile(f.work, prepared.mergeCommit, name), genOf('alpha2\nbeta\ngamma2\n'));
});

test('AC-003: a generated file git merged without a conflict is still made again from the merged sources', async () => {
  const f = setupGen();
  // the mainline builds; the lane changes the source and leaves the old build: git takes the mainline's gen.txt as is
  mainlineBuildsLaneEditsSource(f);
  const textual = execFileSync('git', ['merge-tree', '--write-tree', 'work-main', laneTip(f)], { cwd: f.work, encoding: 'utf8' }).trim();
  assert.equal(showFile(f.work, textual, 'gen.txt'), genOf('alpha2\nbeta\ngamma\n'), 'git alone would have landed a stale file');
  assert.equal(showFile(f.work, (await landsIn()).mergeCommit, 'gen.txt'), genOf('alpha2\nbeta\ngamma2\n'));
});

test('AC-003: a landing that touches no generated file keeps the tree as the merge made it', async () => {
  // the base holds a gen.txt that is not what its sources build; nothing in this landing touches it
  const f = setupGen({}, { 'src.txt': SRC, 'gen.txt': 'NOT BUILT FROM SRC\n' });
  writeIn(f.work, { 'other.txt': 'mainline\n' }, 'chore: mainline moves');
  writeIn(f.lane.path, { 'app.txt': 'two\n' }, 'feat: lane changes app');
  assert.equal(showFile(f.work, (await landsIn()).mergeCommit, 'gen.txt'), 'NOT BUILT FROM SRC\n');
});

test('AC-002: a source that conflicts goes back with its file, whatever the generated file does, and no merge commit is made', async () => {
  const f = setupGen();
  for (const [side, text] of [[f.work, 'alpha2'], [f.lane.path, 'alpha3']]) writeIn(side, { 'src.txt': `${text}\nbeta\ngamma\n`, 'gen.txt': genOf(`${text}\nbeta\ngamma\n`) }, 'chore: builds');
  assert.ok((await goesBack()).conflict.includes('src.txt'));
});

test('AC-006: a repo that declares nothing sends a generated-only conflict back, as before', async () => {
  const f = setupGen({ generated_files: undefined });
  bothBuild(f);
  assert.deepEqual((await goesBack()).conflict, ['gen.txt']);
});

/** the failure to rebuild on the record, taken `msAgo` ago: the tick waits from it before it tries the same group again */
function rebuiltAgo(id, msAgo) {
  const saved = readLand(id);
  save(landPath(id), { ...saved, rebuildFailure: { ...saved.rebuildFailure, at: new Date(Date.now() - msAgo).toISOString() } });
}
const rowsOf = (event) => readLifecycle().filter((e) => e.idd_id === 'IDD-1' && (event === undefined || e.event === event));
const recheckRows = () => rowsOf('s4_land_recheck');
const sentBackRows = () => rowsOf('s4_land_check_sent_back');
/** the checks' limit of tries, written as the rows the tick counts */
async function seedRechecks(prepared, from = 1) {
  for (let attempt = from; attempt <= LAND_RECHECK_MAX; attempt += 1) await seedLifecycle('s4_land_recheck', 'IDD-1', { head: prepared.head, main_tip: prepared.mainTip, reason: 'x', cause: 'environment', attempt });
}
/** a pass that dropped the approval, held the lane for the environment and put nothing in: not an error, not a merge, not a send-back */
function expectHeldNotErrored(res, f, tip) {
  assert.equal(mainTip(f), tip, 'nothing went in');
  assert.deepEqual([res.held.map((h) => h.iddId), res.merged, res.errors, res.sentBack], [['IDD-1'], [], [], []], JSON.stringify(res));
  assert.equal(currentLandApproval(rowsOf(undefined)), null, 'the approval is dropped');
  assert.equal(sentBackRows().length, 0, 'the environment never sends the lane back');
}
/** the tool-269 the build command calls by name, running `body`, with the PATH to find it set for `run` only */
async function withTool(f, body, run) {
  const dir = join(f.root, 'tools');
  put(join(dir, 'tool-269'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'tool-269'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try { return await run(); } finally { process.env.PATH = path; }
}

/** the landing of IDD-1 whose generated files could not be made again: no merge commit, no run, the failure and why on the record */
async function unbuiltLanding(label = '') {
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.mergeCommit, undefined, label);
  assert.equal(prepared.conflict, undefined, `${label}: a generated file that cannot be made again is no conflict`);
  assert.equal(prepared.checking, undefined, label);
  assert.equal(prepared.blocking, 0, label);
  assert.match(String(prepared.reason), /生成物（gen\.txt）を作り直せない/, label);
  assert.equal(landRunChecking('IDD-1'), null, `${label}: no check starts on a tree that was not rebuilt`);
  assert.equal(readLandRun('IDD-1'), null, label);
  return prepared;
}

const BUILD_FAILS = 'echo "build-output-269 marker" >&2; exit 3';
/** a lane at ship whose generated files cannot be made again by `command`, and the record of that landing */
async function unbuiltFixture(command, arrange = mainlineBuildsLaneEditsSource, extra = {}) {
  const f = setupGen({ ...generating(command), ...extra });
  arrange(f);
  await atShip();
  return { f, prepared: await unbuiltLanding() };
}
/** a pass that told the executor of the change's failure, held nothing, and checked nothing */
function expectSentInTick(res) {
  assert.ok(res.sentBack.includes('IDD-1'), JSON.stringify(res));
  assert.equal(res.held.length, 0, JSON.stringify(res));
  assert.equal(landRunChecking('IDD-1'), null);
}
/** the one line a check again left, counted as the environment's first try */
function expectFirstTry(prepared) {
  const rows = recheckRows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].attrs.attempt, rows[0].attrs.cause, rows[0].attrs.head, rows[0].attrs.main_tip], [1, 'environment', prepared.head, prepared.mainTip]);
}
const heldWithWhy = (res) => res.held.some((h) => h.iddId === 'IDD-1' && /3 回/.test(h.reason) && /gen\.txt/.test(h.reason));

test('a rebuild that cannot be made is neither checked nor approved, for a generated-only conflict and a clean merge alike, and says which side failed', async () => {
  // `true` and a write elsewhere succeed without writing the declared file: the gen.txt git left in the tree (a text merge, once with conflict marks) is never taken for a rebuilt one
  const cases = [
    ['exit 1', 'build'],
    ['true', 'build'],
    ['echo stray > elsewhere.txt', 'build'],
    ['definitely-not-an-installed-tool-261 build', 'environment'],
    ['exit 127', 'environment'],
    ['sleep 5', 'environment', 0.01],
  ];
  for (const [command, cause, limit] of cases) {
    for (const [shape, arrange] of [['conflict', bothBuild], ['clean merge', mainlineBuildsLaneEditsSource]]) {
      if (shape === 'clean merge' && (command === 'exit 127' || limit)) continue;
      const f = setupGen(generating(command, limit));
      arrange(f);
      const before = mainTip(f);
      const label = `${shape}: ${command}`;
      const prepared = await unbuiltLanding(label);
      assert.equal(prepared.rebuildFailure?.cause, cause, label);
      assert.deepEqual(prepared.rebuildFailure?.paths, ['gen.txt'], label);
      assert.ok(prepared.rebuildFailure?.reason, label);
      assert.ok(Date.parse(prepared.rebuildFailure?.at ?? ''), `${label}: the time of the failure is on the record`);
      assert.deepEqual(readLand('IDD-1'), prepared, 'the record on disk is the answer');
      // an approval finds nothing to take, and the mainline stays where it was
      assert.equal(landReadyAt('IDD-1', laneLocations('IDD-1')), null, label);
      const approved = await approveLandSigned(prepared.token);
      assert.equal(approved.ok, false, label);
      assert.equal(approved.error, prepared.reason, label);
      assert.equal(mainTip(f), before, label);
    }
  }
  // a command that wrote the declared file said nothing wrong: the landing is rebuilt and checked, with no failure on it
  bothBuild(setupGen());
  const rebuilt = await landsIn();
  assert.equal(rebuilt.rebuildFailure, undefined);
  assert.ok(rebuilt.mergeCommit);
});

test('a command that succeeds without writing the declared path is the change\'s failure and says so', async () => {
  for (const command of ['true', 'echo stray > elsewhere.txt']) {
    mainlineBuildsLaneEditsSource(setupGen(generating(command)));
    const prepared = await unbuiltLanding(command);
    assert.equal(prepared.rebuildFailure?.cause, 'build', command);
    assert.match(prepared.rebuildFailure?.reason ?? '', /通常の file として書きませんでした/, command);
    assert.match(String(prepared.reason), /宣言した path を書きませんでした/, 'the card says what to mend');
  }
});

test('an environment failure is tried again on the same group by the tick, to the checks\' own limit, then waits for a person', async () => {
  const { prepared } = await unbuiltFixture('tool-269');
  assert.equal(prepared.rebuildFailure?.cause, 'environment');
  // the failure is fresh: the tick waits the checks' interval, and writes nothing
  const quiet = await runLand();
  assert.deepEqual([quiet.checking, quiet.held, quiet.sentBack], [[], [], []], JSON.stringify(quiet));
  assert.equal(recheckRows().length, 0);
  // a try that meets the failure again is counted like a check again, on the same head and mainline tip, and the wait
  // starts over from it
  rebuiltAgo('IDD-1', 3 * 60_000);
  const first = await runLand();
  assert.equal(first.checking.length, 0, JSON.stringify(first));
  assert.ok(first.held.some((h) => h.iddId === 'IDD-1'), JSON.stringify(first));
  expectFirstTry(prepared);
  assert.equal(landRunChecking('IDD-1'), null, 'still no check on a tree that was not rebuilt');
  await runLand();
  assert.equal(recheckRows().length, 1, 'the wait starts again from the try that failed');
  await seedRechecks(prepared, 2);
  // past the limit a person is asked, with why, and nothing is tried again; the hold is noted once
  const limit = await runLand();
  assert.ok(heldWithWhy(limit), JSON.stringify(limit.held));
  assert.equal(recheckRows().length, LAND_RECHECK_MAX, 'no further try');
  await runLand();
  assert.equal(rowsOf('s4_land_held').length, 1);
  assert.equal(sentBackRows().length, 0, 'an environment failure never sends the lane back');
});

test('an approval whose group cannot be built for the environment is dropped, waits as any lane waits, and is handed to a person past the limit', async () => {
  const { f, prepared } = await unbuiltFixture('tool-269');
  const before = mainTip(f);
  // the record of the approved group is the unbuilt one: the approval does not stand for it, whatever the wait
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, signed: true });
  expectHeldNotErrored(await runLand(), f, before);
  // past the checks' own limit the approval is dropped again and a person is asked with why; nothing is tried
  await seedRechecks(prepared);
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, signed: true });
  const limit = await runLand();
  assert.ok(heldWithWhy(limit), JSON.stringify(limit));
  assert.equal(currentLandApproval(readLifecycle().filter((e) => e.idd_id === 'IDD-1')), null);
  assert.equal(recheckRows().length, LAND_RECHECK_MAX, 'no further try');
  assert.equal(mainTip(f), before);
});

test('an approval whose group cannot be built for the environment after the mainline moved is dropped and held, not an error', async () => {
  const { f, prepared } = await unbuiltFixture('tool-269');
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, signed: true });
  // the mainline moves: the record is of an earlier tip, so the approved group is built again and cannot be
  writeIn(f.work, { 'other.txt': 'mainline moves\n' }, 'chore: mainline moves');
  expectHeldNotErrored(await runLand(), f, mainTip(f));
  assert.ok(eventsOf('IDD-1').includes('s4_land_approval_dropped'), 'the approval is dropped');
  assert.equal(readLandRun('IDD-1'), null, 'no check starts on a tree that was not rebuilt');
});

test('an environment that is mended is tried again on the same group, and the checks start on the tree that was rebuilt', async () => {
  const { f, prepared } = await unbuiltFixture('tool-269', mainlineBuildsLaneEditsSource, { checks: [{ name: 'ok', command: 'true', required: true }] });
  await withTool(f, GEN.command, async () => {
    rebuiltAgo('IDD-1', 3 * 60_000);
    const res = await runLand();
    assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
    expectFirstTry(prepared);
    const checked = await landSettled('IDD-1');
    assert.equal(checked.rebuildFailure, undefined);
    assert.equal(checked.blocking, 0, JSON.stringify(checked.checks));
    assert.equal(checked.head, prepared.head);
    assert.equal(checked.mainTip, prepared.mainTip);
    assert.equal(showFile(f.work, checked.mergeCommit, 'gen.txt'), genOf('alpha2\nbeta\ngamma2\n'), 'the tree the checks read is the rebuilt one');
    assert.ok(landReadyAt('IDD-1', laneLocations('IDD-1')), 'the landing waits for the approval as any checked one does');
  });
});

/** the answers of the one send-back of IDD-1 and what it told the executor */
function oneSendBack(label, prepared) {
  const sent = sentBackRows();
  assert.equal(sent.length, 1, label);
  assert.equal(sent[0].attrs.rebuild_cause, 'build', label);
  assert.deepEqual(sent[0].attrs.rebuild_paths, ['gen.txt'], label);
  if (prepared) assert.equal(sent[0].attrs.head, prepared.head, label);
  const answered = rowsOf('s4_verify_user_judgment_answered').at(-1);
  assert.equal(answered.attrs.outcome, 'revise', label);
  assert.match(answered.attrs.instruction, /gen\.txt/, label);
  assert.match(answered.attrs.instruction, /build-output-269 marker/, `${label}: the build's own output is in the instruction`);
}

test('a build failure is sent back once with the declared paths and the build\'s output, and is not tried again on the same group', async () => {
  for (const [shape, arrange] of [['conflict', bothBuild], ['clean merge', mainlineBuildsLaneEditsSource]]) {
    const { prepared } = await unbuiltFixture(BUILD_FAILS, arrange);
    assert.equal(prepared.rebuildFailure?.cause, 'build', shape);
    // no wait and no second try: the same sources build the same way
    const res = await runLand();
    assert.ok(res.sentBack.includes('IDD-1'), `${shape}: ${JSON.stringify(res)}`);
    assert.equal(recheckRows().length, 0, shape);
    assert.equal(landRunChecking('IDD-1'), null, shape);
    oneSendBack(shape, prepared);
    assert.match(rowsOf('s4_verify_user_judgment_answered').at(-1).attrs.instruction, /work-main/, 'the lane merges the mainline and mends the sources');
    assert.equal(landReadyAt('IDD-1', laneLocations('IDD-1')), null, shape);
    // the lane is the executor's now: the tick does not tell it again
    await runLand();
    assert.equal(sentBackRows().length, 1, shape);
  }
});

test('a build failure met at the first check of a lane is sent back in that tick, not held until the next one', async () => {
  bothBuild(setupGen(generating(BUILD_FAILS)));
  await atShip();
  // no record yet: the tick checks afresh, meets the failure, and tells the executor in the same tick
  expectSentInTick(await runLand());
  oneSendBack('first check', readLand('IDD-1'));
  // the lane is the executor's now: the tick does not tell it again
  await runLand();
  assert.equal(sentBackRows().length, 1);
});

test('a build failure met after the mainline moved past an earlier record is sent back, not held', async () => {
  const { f, prepared: earlier } = await unbuiltFixture(BUILD_FAILS, bothBuild);
  assert.equal(earlier.rebuildFailure?.cause, 'build');
  // the record belongs to the tip it was taken at: a tip it does not fit is checked afresh, which meets the failure
  writeIn(f.work, { 'other.txt': 'mainline moves\n' }, 'chore: mainline moves');
  expectSentInTick(await runLand());
  oneSendBack('after the mainline moved', null);
  assert.notEqual(sentBackRows().at(-1).attrs.main_tip, earlier.mainTip, 'sent for the group the mainline moved to');
});

test('a run that died before the failure to rebuild was taken does not turn the change\'s failure into the environment\'s', async () => {
  const { f, prepared } = await unbuiltFixture(BUILD_FAILS, bothBuild);
  // an earlier try of the same group left a run that ended without a result, and the record was taken after it began
  const at = Date.parse(prepared.rebuildFailure.at);
  saveLandRun({ id: 'run-old-269', lane: 'IDD-1', status: 'failed', started_at: new Date(at - 60_000).toISOString(), ended_at: new Date(at - 30_000).toISOString(), repo: f.work, common: f.work, head: prepared.head, mainTip: prepared.mainTip, mergeCommit: 'x'.repeat(40), signed: false, spec: {}, log: '', error: '' });
  const res = await runLand();
  assert.ok(res.sentBack.includes('IDD-1'), JSON.stringify(res));
  assert.equal(recheckRows().length, 0, 'the same sources build the same way: no second try');
  oneSendBack('a stale run', prepared);
});

test('a try that meets the build failure after the environment failure is sent back in that tick, not held until the next', async () => {
  const { f, prepared } = await unbuiltFixture('tool-269');
  assert.equal(prepared.rebuildFailure?.cause, 'environment');
  // the tool is found now, and the merged sources do not build with it
  await withTool(f, 'echo "build-output-269 marker" >&2\nexit 3', async () => {
    rebuiltAgo('IDD-1', 3 * 60_000);
    expectSentInTick(await runLand());
    assert.equal(recheckRows().length, 0, 'the change\'s failure is not counted as a wait for the environment');
    oneSendBack('environment, then build', prepared);
  });
});

test('an approved landing whose rebuild fails after the mainline moved drops the approval and sends the lane back once', async () => {
  const flag = join(scratchDir('idd269-flag-'), 'broken');
  const f = setupGen(generating(`if [ -e ${flag} ]; then echo "build-output-269 marker" >&2; exit 3; fi; ${GEN.command}`));
  mainlineBuildsLaneEditsSource(f);
  await atShip();
  const prepared = await landsIn();
  await appendLifecycle('s4_land_approved', 'IDD-1', { head: prepared.head, merge_commit: prepared.mergeCommit, signed: true });
  // the mainline moves and the sources no longer build: the approved group is built again and cannot be
  writeIn(f.work, { 'other.txt': 'mainline moves\n' }, 'chore: mainline moves');
  put(flag, 'broken\n');
  const tip = mainTip(f);
  const res = await runLand();
  assert.equal(mainTip(f), tip, 'nothing went in');
  assert.ok(res.sentBack.includes('IDD-1') || res.errors.some((e) => e.iddId === 'IDD-1'), JSON.stringify(res));
  assert.ok(eventsOf('IDD-1').includes('s4_land_approval_dropped'), 'the approval is dropped');
  assert.equal(eventsOf('IDD-1').includes('lane_close'), false);
  oneSendBack('an approved landing', null);
  // the lane is the executor's now: the next passes neither tell it again nor repeat an error
  const again = await runLand();
  assert.equal(again.errors.length, 0, JSON.stringify(again));
  assert.equal(sentBackRows().length, 1);
});

test('a record from before the failure was kept apart, with a merge commit and the failure, is not approved or handed over, and is planned again', async () => {
  const f = setupGen();
  mainlineBuildsLaneEditsSource(f);
  await atShip();
  const prepared = await landsIn();
  assert.equal(prepared.rebuildFailure, undefined);
  // the shape an older version wrote: checked as it was, with the failure to rebuild beside the merge commit
  const old = { ...prepared, rebuildFailure: { cause: 'build', reason: 'old output', paths: ['gen.txt'], at: new Date().toISOString() } };
  save(landPath('IDD-1'), old);
  const loc = laneLocations('IDD-1');
  assert.equal(landReadyAt('IDD-1', loc), null, 'it is not a landing that waits for an approval');
  assert.equal(landCheckedAt('IDD-1', loc), null, 'it stands for no check of this group');
  assert.equal(landBehindAt('IDD-1', loc), null);
  const before = mainTip(f);
  const approved = await approveLandSigned(prepared.token);
  assert.equal(approved.ok, false, JSON.stringify(approved));
  assert.equal(mainTip(f), before, 'nothing went in');
  // the tick plans the group again with the current code: the record that replaces it is a checked one
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1') || res.prepared.includes('IDD-1'), JSON.stringify(res));
  const checked = await landSettled('IDD-1');
  assert.equal(checked.rebuildFailure, undefined);
  assert.equal(checked.blocking, 0, JSON.stringify(checked.checks));
  assert.ok(landReadyAt('IDD-1', laneLocations('IDD-1')));
});

test('a temp area that cannot be made is an environment failure, not a thrown error', async () => {
  const f = setupGen();
  const tree = git(f.work, 'rev-parse', 'HEAD^{tree}');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = join(f.work, 'no-such-tmp-dir-261');
  try {
    const rebuilt = await rebuildGenerated({ cwd: f.work, tree, outputs: [{ paths: ['gen.txt'], command: GEN.command, timeoutMinutes: 1 }] });
    assert.equal(rebuilt.failure?.cause, 'environment', JSON.stringify(rebuilt));
    assert.deepEqual(rebuilt.failure?.paths, ['gen.txt']);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
});

test('only the declared files are taken from the build: what the command writes elsewhere is dropped', async () => {
  const stray = `${GEN.command}; echo stray > extra.txt; echo changed > app.txt; echo changed > src.txt`;
  const f = setupGen(generating(stray));
  const merged = bothBuild(f);
  const prepared = await landsIn();
  assert.equal(showFile(f.work, prepared.mergeCommit, 'gen.txt'), genOf(merged));
  assert.equal(showFile(f.work, prepared.mergeCommit, 'src.txt'), merged);
  assert.equal(showFile(f.work, prepared.mergeCommit, 'app.txt'), 'one\n');
  assert.throws(() => showFile(f.work, prepared.mergeCommit, 'extra.txt'));
  assert.equal(git(f.work, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).some((l) => l.includes('idd-land-generated-')), false, 'the build worktree is removed');
});

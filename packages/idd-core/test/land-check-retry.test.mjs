import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { laneLocations } from '../src/overlay/export.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { checkouts, failLines, landBehindAt, landCheckedAt, landCheckFailureInstruction, landFailureCause, landPath, prepareLand as prepareLandNow, readLand } from '../src/overlay/land.ts';
import { landRunChecking, readLandRun, saveLandRun } from '../src/overlay/land-run.ts';
import { CUT_BY_OUTPUT, CUT_BY_TIME } from '../src/overlay/gate.ts';
import { LOCK_CHECKING, save } from '../src/overlay/git.ts';
import { LAND_RECHECK_MAX, runLand } from '../src/plan/land.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file', IDD_LANE_SCOPE: 'off' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

/** a project with the work clone, its remote and an upstream clone, plus one lane of a repo that does not publish */
function setup(extra = {}) {
  process.chdir(original);
  const root = scratchDir('land-retry-');
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
/** wait for the lane's landing check to end and answer the record it wrote */
async function landSettled(id) {
  await waitFor(() => !landRunChecking(id));
  return readLand(id);
}
/** start the check and wait for the record it wrote (or the answer when no run started) */
async function prepareLand(id) {
  const res = await prepareLandNow(id);
  if (typeof res !== 'object' || res === null || !('checking' in res) || res.waiting) return res;
  return await landSettled(id);
}
const laneEvents = (id) => readLifecycle().filter((e) => e.idd_id === id);
const eventsOf = (id) => laneEvents(id).map((e) => e.event);

/** put the lane at the submit card, as the engine's own records would */
async function atShip() {
  await seedLifecycle('lane_open', 'IDD-1', {});
  await seedLifecycle('s2_start', 'IDD-1', {});
  await seedLifecycle('s2_result', 'IDD-1', {});
  await seedLifecycle('s3_ready', 'IDD-1', {});
  await seedLifecycle('s3_ok', 'IDD-1', {});
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
}

const fail = (name, detail) => ({ name, status: 'fail', severity: 'blocking', detail });
const pass = (name) => ({ name, status: 'pass', severity: 'blocking' });

/** a checked record (the check passed) rewritten as a failure with the given checks, as the run would have written it */
function failRecord(id, checks) {
  const saved = readLand(id);
  save(landPath(id), { ...saved, checks, blocking: checks.filter((c) => c.severity === 'blocking' && c.status !== 'pass').length });
  return readLand(id);
}

/** the run record's end moved to `msAgo` before now, so the interval since the last failure can be set by a test */
function endedAgo(id, msAgo) {
  const run = readLandRun(id);
  saveLandRun({ ...run, ended_at: new Date(Date.now() - msAgo).toISOString() });
}

// ---- the cause of a failed check: the environment's, or the change's ----

test('a check cut by the time limit, by the output limit, or by the overlay lock is the environment\'s failure', () => {
  const rec = { head: 'h', mainTip: 'm', blocking: 1, checks: [] };
  const cut = landFailureCause({ ...rec, checks: [pass('typecheck'), fail('test', `${CUT_BY_TIME(5)}\n[test-entry] 組 test が時間で止められました`)] }, null);
  assert.equal(cut.kind, 'environment');
  assert.match(cut.reason, /test が時間の上限/);
  const overflow = landFailureCause({ ...rec, checks: [fail('test', `${CUT_BY_OUTPUT}\n...`)] }, null);
  assert.equal(overflow.kind, 'environment');
  const locked = landFailureCause({ ...rec, checks: [fail('test', `✖ x\n  error: ${LOCK_CHECKING}\n`)] }, null);
  assert.equal(locked.kind, 'environment');
  assert.match(locked.reason, /lock/);
  const refused = landFailureCause({ ...rec, checks: [fail('test:lane', '{ error: "...", lockRefused: true }')] }, null);
  assert.equal(refused.kind, 'environment');
});

test('a check that ran and failed is the change\'s failure, even beside one the environment stopped', () => {
  const rec = { head: 'h', mainTip: 'm', blocking: 2, checks: [] };
  const real = landFailureCause({ ...rec, checks: [fail('typecheck', 'src/a.ts(1,2): error TS2304: Cannot find name')] }, null);
  assert.equal(real.kind, 'real');
  assert.deepEqual(real.checks.map((c) => c.name), ['typecheck']);
  const mixed = landFailureCause({ ...rec, checks: [fail('test', CUT_BY_TIME(5)), fail('lint', '1 error')] }, null);
  assert.equal(mixed.kind, 'real', 'one real failure makes the record the executor\'s');
  assert.deepEqual(mixed.checks.map((c) => c.name), ['test', 'lint']);
  assert.equal(landFailureCause({ ...rec, blocking: 0, checks: [pass('test')] }, null), null, 'a passing record has no cause');
});

test('a setup cut by the time limit, with the checks skipped after it, is the environment\'s failure', () => {
  const skipped = { name: 'test', status: 'skipped', severity: 'blocking', detail: '準備に失敗したので回していません' };
  const cause = landFailureCause({ head: 'h', mainTip: 'm', blocking: 2, checks: [fail('setup', `準備のコマンドが失敗しました: npm ci\n${CUT_BY_TIME(15)}\n...`), skipped] }, null);
  assert.equal(cause.kind, 'environment');
  const broken = landFailureCause({ head: 'h', mainTip: 'm', blocking: 2, checks: [fail('setup', '準備のコマンドが失敗しました: npm ci\nnpm ERR! ...'), skipped] }, null);
  assert.equal(broken.kind, 'real', 'a setup that failed on its own is read as the change\'s');
});

test('a run of the same group that ended without a result is the environment\'s failure; one of another group is not read', () => {
  const dead = { head: 'h', mainTip: 'm', status: 'failed', error: '検査の run の process が消えました' };
  const noRecord = landFailureCause(null, dead);
  assert.equal(noRecord.kind, 'environment');
  assert.equal(noRecord.noResult, true, 'no check was read: the tick does not wait the interval');
  assert.match(noRecord.reason, /process が消えました/);
  const realRecord = { head: 'h', mainTip: 'm', blocking: 1, checks: [fail('lint', '1 error')] };
  assert.equal(landFailureCause(realRecord, dead).kind, 'environment', 'the dead run is newer than the record it did not overwrite');
  assert.equal(landFailureCause(realRecord, { ...dead, mainTip: 'older' }).kind, 'real', 'a run of another group says nothing about this one');
  assert.equal(landFailureCause(null, { ...dead, status: 'done' }), null, 'a done run without a record is nothing to settle');
});

test('the fail lines of a detail are the lines that name a failure, at most 10, else the detail\'s last lines', () => {
  const detail = ['ℹ tests 3', '✔ a passes', '✖ b fails (1ms)', '  AssertionError', '(fail) c fails [2ms]', 'src/x.ts(3,1): error TS2322: Type', 'ℹ fail 2'].join('\n');
  assert.deepEqual(failLines(detail), ['✖ b fails (1ms)', '(fail) c fails [2ms]', 'src/x.ts(3,1): error TS2322: Type']);
  const many = Array.from({ length: 15 }, (_, i) => `✖ test ${i}`).join('\n');
  assert.equal(failLines(many).length, 10);
  assert.deepEqual(failLines('a\nb\nc'), ['a', 'b', 'c'], 'a detail without a fail line hands its lines over');
  const instruction = landCheckFailureInstruction('work-main', [fail('test', detail), fail('lint', '1 error')]);
  assert.match(instruction, /落ちた検査: test, lint/);
  assert.match(instruction, /本流（work-main）を lane に merge/);
  assert.match(instruction, /rebase は使わない/);
  assert.match(instruction, /\[test\] 出力の fail 行/);
  assert.match(instruction, /✖ b fails/);
});

// ---- the tick: the environment's failure is checked again, the change's is sent back ----

test('a failure of the environment is checked again by the tick, with the ask on the lifecycle', async () => {
  const f = setup({ checks: [{ name: 'test', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.blocking, 0);
  // the run's record is rewritten as the time limit cut the test, three minutes ago
  failRecord('IDD-1', [fail('test', `${CUT_BY_TIME(5)}\n[test-entry] 組 test が時間で止められました`)]);
  endedAgo('IDD-1', 3 * 60_000);
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  assert.equal(res.held.length, 0);
  const asks = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].attrs.attempt, 1);
  assert.equal(asks[0].attrs.head, prepared.head);
  assert.equal(asks[0].attrs.main_tip, prepared.mainTip);
  assert.match(String(asks[0].attrs.reason), /時間の上限/);
  const again = await landSettled('IDD-1');
  assert.equal(again.blocking, 0, 'the check ran again and passed');
  assert.equal(eventsOf('IDD-1').includes('s4_verify_user_judgment_answered'), false, 'nothing was sent back');
});

test('the tick waits two minutes after the last failure before it checks the same group again', async () => {
  const f = setup({ checks: [{ name: 'test', command: 'true', required: true }] });
  change(f);
  await atShip();
  await prepareLand('IDD-1');
  failRecord('IDD-1', [fail('test', CUT_BY_TIME(5))]);
  endedAgo('IDD-1', 30_000);
  const res = await runLand();
  assert.equal(res.checking.includes('IDD-1'), false, JSON.stringify(res));
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_recheck').length, 0);
  assert.equal(readLand('IDD-1').blocking, 1, 'the failed record stands until the interval has passed');
  // past the interval the same pass checks it again
  endedAgo('IDD-1', 2 * 60_000 + 1);
  const later = await runLand();
  assert.ok(later.checking.includes('IDD-1'), JSON.stringify(later));
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_recheck').length, 1);
  await landSettled('IDD-1');
});

test('the same group is checked again at most three times; past that the record waits for a person, noted once', async () => {
  const f = setup({ checks: [{ name: 'test', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  failRecord('IDD-1', [fail('test', CUT_BY_TIME(5))]);
  endedAgo('IDD-1', 10 * 60_000);
  for (let i = 1; i <= LAND_RECHECK_MAX; i += 1) await seedLifecycle('s4_land_recheck', 'IDD-1', { head: prepared.head, main_tip: prepared.mainTip, reason: 'x', attempt: i });
  const res = await runLand();
  assert.equal(res.checking.includes('IDD-1'), false, JSON.stringify(res));
  assert.ok(res.held.some((h) => h.iddId === 'IDD-1' && /3 回/.test(h.reason)), JSON.stringify(res.held));
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_recheck').length, LAND_RECHECK_MAX, 'no fourth ask');
  assert.equal(readLand('IDD-1').blocking, 1, 'the failed record stays on the card');
  await runLand();
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_held').length, 1, 'the hold is noted once for the head and reason');
  // another mainline tip is another group: the count starts over
  put(join(f.work, 'other.txt'), 'x\n'); commit(f.work, 'chore: mainline move');
  const moved = await runLand();
  assert.ok(moved.checking.includes('IDD-1'), JSON.stringify(moved));
  await landSettled('IDD-1');
});

test('a run that died without a result is started again by the next tick at once, as a check again', async () => {
  const f = setup({ checks: [{ name: 'test', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  // the run died before it wrote: the reader closed it as failed just now, and the record of the group was never written
  rmSync(landPath('IDD-1'), { force: true });
  saveLandRun({ ...readLandRun('IDD-1'), status: 'failed', error: '検査の run の process が消えました', ended_at: new Date().toISOString() });
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  const asks = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
  assert.equal(asks.length, 1);
  assert.match(String(asks[0].attrs.reason), /process が消えました/);
  assert.equal(asks[0].attrs.head, prepared.head);
  const again = await landSettled('IDD-1');
  assert.equal(again.blocking, 0);
});

/** the check that fails and keeps failing: the change itself is wrong */
const BOOM = { name: 'boom', command: ['bash', '-c', 'echo "✖ the test (2ms)"; echo "  AssertionError: no"; exit 1'], required: true };

test('a failure of the change is checked again once on the same group, and sent back only when it fails again, once per head', async () => {
  const f = setup({ checks: [BOOM] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.blocking, 1, JSON.stringify(prepared.checks));
  endedAgo('IDD-1', 3 * 60_000);
  const first = await runLand();
  assert.equal(first.sentBack.includes('IDD-1'), false, `one failed run is not the executor's yet: ${JSON.stringify(first)}`);
  assert.ok(first.checking.includes('IDD-1'), JSON.stringify(first));
  assert.equal(eventsOf('IDD-1').includes('s4_land_check_sent_back'), false);
  const asks = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].attrs.cause, 'real');
  assert.equal(asks[0].attrs.attempt, 1);
  assert.equal(asks[0].attrs.head, prepared.head);
  assert.equal(asks[0].attrs.main_tip, prepared.mainTip);
  assert.match(String(asks[0].attrs.reason), /boom/, 'the check that failed is named on the card');
  const again = await landSettled('IDD-1');
  assert.equal(again.blocking, 1, 'the same group failed again');
  const res = await runLand();
  assert.ok(res.sentBack.includes('IDD-1'), JSON.stringify(res));
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_recheck').length, 1, 'no second check again for the change\'s failure');
  const evs = laneEvents('IDD-1');
  const revise = evs.find((e) => e.event === 's4_verify_user_judgment_answered');
  assert.equal(revise?.attrs?.outcome, 'revise');
  assert.equal(revise?.attrs?.by, 'harness');
  assert.deepEqual(revise?.attrs?.failed_checks, ['boom']);
  assert.match(String(revise?.attrs?.instruction), /落ちた検査: boom/);
  assert.match(String(revise?.attrs?.instruction), /本流（work-main）を lane に merge/);
  assert.match(String(revise?.attrs?.instruction), /✖ the test/);
  const sent = evs.find((e) => e.event === 's4_land_check_sent_back');
  assert.deepEqual(sent?.attrs?.checks, ['boom']);
  assert.equal(sent?.attrs?.head, prepared.head);
  const rows = readFileSync(join(f.state, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).type, 'lane_rejected');
  assert.equal(rows.at(-1).skip_fix_plan, undefined, 'a check failure needs the fix plan, unlike a conflict-only merge');
  assert.match(readFileSync(join(f.state, 'outbox', `${rows.at(-1).envelope_id}.xml`), 'utf8'), /落ちた検査: boom/);
  assert.equal(deriveStage(laneEvents('IDD-1')).group, 'impl', 'the lane is back at the review loop');
  // the executor comes back with the same head and the lane returns to the card: the same failure is a person's now
  await seedLifecycle('s2_result', 'IDD-1', {});
  await seedLifecycle('s3_ready', 'IDD-1', {});
  await seedLifecycle('s3_ok', 'IDD-1', {});
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const second = await runLand();
  assert.equal(second.sentBack.includes('IDD-1'), false, JSON.stringify(second));
  assert.ok(second.held.some((h) => h.iddId === 'IDD-1' && /2 回落ちた/.test(h.reason)), JSON.stringify(second.held));
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_check_sent_back').length, 1);
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_verify_user_judgment_answered').length, 1);
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_recheck').length, 1, 'the same head is not checked again after the send-back');
  assert.equal(readLand('IDD-1').blocking, 1, 'the failed record stays on the card');
});

// ---- a structure row: the kind is the row's own field, and a count that grew is sent back at once ----

const COUNT = ['bash', '-c', 'node scripts/count.mjs --root "$IDD_STRUCTURE_ROOT"'];
const grew = (prepared) => ({ name: 'structure/duplicate-tokens', status: 'fail', severity: 'blocking', detail: '本流 10 / 取り込み 12（+2）: この取り込みで本流の duplicate-tokens が増えます', counts: { mainline: 10, merged: 12, at: prepared.mainTip }, structure: { kind: 'increase', command: COUNT } });
const untaken = (sides, detail) => ({ name: 'structure/duplicate-tokens', status: 'fail', severity: 'blocking', detail, structure: { kind: 'unmeasured', sides, command: COUNT } });

/** a lane at ship with its change made and its group prepared; `rows` (of the prepared group) are the checks its record failed on */
async function structured(rows) {
  const f = setup({ checks: [{ name: 'test', command: 'true', required: true }] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  if (rows) failRecord('IDD-1', [pass('test'), ...rows(prepared)]);
  return { f, prepared };
}
const moveMainline = (f) => { put(join(f.work, 'other.txt'), 'x\n'); commit(f.work, 'chore: mainline move'); };
const reviseOf = () => laneEvents('IDD-1').find((e) => e.event === 's4_verify_user_judgment_answered');
/** one pass of the land step, which sends the lane back without a check again of the group or of a new tip */
async function sentBackAtOnce() {
  const res = await runLand();
  assert.ok(res.sentBack.includes('IDD-1'), JSON.stringify(res));
  assert.equal(res.checking.includes('IDD-1'), false, JSON.stringify(res));
}
const instructionOfRevise = () => String(reviseOf()?.attrs?.instruction);
const sentOf = () => laneEvents('IDD-1').find((e) => e.event === 's4_land_check_sent_back');

test('a count that grew is sent back at once, with both sides\' numbers, the increase, the count\'s name and the command that graded it', async () => {
  const { prepared } = await structured((at) => [grew(at)]);
  endedAgo('IDD-1', 0);
  await sentBackAtOnce();
  assert.equal(eventsOf('IDD-1').includes('s4_land_recheck'), false);
  const revise = reviseOf();
  assert.deepEqual([revise?.attrs?.outcome, revise?.attrs?.by, revise?.attrs?.failed_checks], ['revise', 'harness', ['structure/duplicate-tokens']]);
  const instruction = instructionOfRevise();
  assert.match(instruction, /落ちた検査: structure\/duplicate-tokens/);
  assert.match(instruction, /本流 10 \/ 取り込み 12（\+2）/, 'both numbers and the increase');
  assert.match(instruction, /数えた数: duplicate-tokens \/ 本流の先端 [0-9a-f]{7} の数 10 \/ 取り込みの数 12（\+2）/);
  assert.ok(instruction.includes(`node scripts/count.mjs --root "$IDD_STRUCTURE_ROOT"`), 'the command that graded');
  assert.match(instruction, /IDD_STRUCTURE_ROOT/);
  const sent = sentOf();
  assert.deepEqual([sent?.attrs?.checks, sent?.attrs?.head, sent?.attrs?.main_tip], [['structure/duplicate-tokens'], prepared.head, prepared.mainTip]);
  assert.equal(deriveStage(laneEvents('IDD-1')).group, 'impl');
});

test('a row whose command the record left out names where the declaration is, and a value of a copied file is in neither the instruction nor the ledger', async () => {
  // a repo whose copied file's values cannot be told apart from the command: the row has no command
  await structured((at) => [{ ...grew(at), structure: { kind: 'increase' } }]);
  endedAgo('IDD-1', 0);
  const res = await runLand();
  assert.ok(res.sentBack.includes('IDD-1'), JSON.stringify(res));
  const revise = reviseOf();
  for (const text of [String(revise?.attrs?.instruction), JSON.stringify(laneEvents('IDD-1'))]) {
    assert.doesNotMatch(text, /hunter2-secret-value|count\.mjs|IDD_STRUCTURE_ROOT"/);
  }
  const instruction = instructionOfRevise();
  assert.match(instruction, /採点した宣言の場所: config\/repos\.yaml の demo（repo）、本流の先端の config\/structure\.yaml の command 欄/);
  assert.doesNotMatch(instruction, /採点した宣言の command:/);
  assert.match(instruction, /数えた数: duplicate-tokens \/ 本流の先端 [0-9a-f]{7} の数 10 \/ 取り込みの数 12（\+2）/);
});

test('an instruction asks for the fix of the row\'s kind: only a count that grew is asked to come down', () => {
  const where = /採点した宣言の場所: config\/repos\.yaml の demo（repo）、本流の先端の config\/structure\.yaml の command 欄/;
  const row = (structure, extra = {}) => ({ name: 'structure/duplicate-tokens', status: 'fail', severity: 'blocking', detail: '行の理由', structure, ...extra });
  const instructionOf = (check) => landCheckFailureInstruction('work-main', [check], 'demo');
  const asksToCome = /本流の数以下|本流以下/;
  const increase = instructionOf(row({ kind: 'increase', command: COUNT }, { counts: { mainline: 10, merged: 12, at: 'abcdef0123' } }));
  assert.match(increase, where);
  assert.ok(increase.includes('採点した宣言の command: bash -c'), increase);
  assert.match(increase, asksToCome);
  assert.match(increase, /同じ command で本流の先端と lane の tree を数え直し|本流の先端と lane の tree を同じ command で数え直し/);
  const mended = /数えるコマンドが取り込む側の tree で数を出すように/;
  const mainlineSide = /本流の先端の tree で数を測れませんでした。.*取り込む側の command を直さないでください/s;
  for (const [kind, extra, fix, not] of [
    ['unmeasured', { sides: ['merged'] }, mended],
    ['unmeasured', { sides: ['mainline'] }, mainlineSide, mended],
    ['unmeasured', { sides: ['mainline', 'merged'] }, /取り込む側でも測れていません/, mended],
    ['weakened', {}, /本流の先端の宣言に戻して/],
  ]) {
    for (const withCommand of [true, false]) {
      const text = instructionOf(row({ kind, ...extra, ...(withCommand ? { command: COUNT } : {}) }));
      assert.match(text, where, `${kind}: the place is told ${withCommand ? 'with' : 'without'} the command`);
      assert.match(text, fix, kind);
      if (not) assert.doesNotMatch(text, not, `${kind} ${extra.sides}: not asked to mend the merged side's command`);
      assert.match(text, /止める数は下げないでください/, kind);
      assert.doesNotMatch(text, asksToCome, `${kind} is not asked to bring a number down`);
      assert.equal(text.includes('採点した宣言の command:'), withCommand, kind);
    }
  }
  // beside a failure of the change, a row the mainline could not count still does not send the executor to mend the merged side's command
  const mixed = landCheckFailureInstruction('work-main', [row({ kind: 'unmeasured', sides: ['mainline'], command: COUNT }), { name: 'lint', status: 'fail', severity: 'blocking', detail: '✖ 1 error' }], 'demo');
  assert.match(mixed, mainlineSide);
  assert.doesNotMatch(mixed, mended);
  assert.match(mixed, /\[lint\] 出力の fail 行/);
  // no area to read: only the declaration's place in the mainline is told
  assert.match(landCheckFailureInstruction('work-main', [row({ kind: 'weakened' })]), /採点した宣言の場所: 本流の先端の config\/structure\.yaml の command 欄/);
});

test('a count that grew at a head is sent back although the mainline moved since the record, with no check of the new tip in front', async () => {
  const { f, prepared } = await structured((at) => [grew(at)]);
  endedAgo('IDD-1', 0);
  moveMainline(f);
  await sentBackAtOnce();
  assert.ok(!landRunChecking('IDD-1'), 'no run of the new tip was started');
  assert.equal(eventsOf('IDD-1').includes('s4_land_recheck'), false);
  const sent = sentOf();
  assert.equal(sent?.attrs?.head, prepared.head);
  assert.equal(sent?.attrs?.main_tip, prepared.mainTip, 'the group the record failed on');
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_verify_user_judgment_answered').length, 1);
  assert.ok(Date.parse(readLand('IDD-1').expiresAt) < Date.now(), 'the old record is no longer one a signature can stand on');
  // the same head is not sent back twice, however many ticks come
  await runLand();
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_check_sent_back').length, 1);
});

test('a record is behind only when the work_base ref moved ahead of its tip, wherever the work checkout is', async () => {
  const { f, prepared } = await structured();
  const at = () => { const loc = laneLocations('IDD-1'); return [Boolean(landCheckedAt('IDD-1', loc)), Boolean(landBehindAt('IDD-1', loc))]; };
  assert.deepEqual(at(), [true, false]);
  // the checkout stands on another branch while the work_base ref has not moved: the record is still the tip's
  git(f.work, 'checkout', '-b', 'elsewhere'); put(join(f.work, 'side.txt'), 'x\n'); commit(f.work, 'chore: elsewhere');
  assert.deepEqual(at(), [true, false], 'a checkout on another branch is not the mainline moving');
  // the ref moves ahead: the record is behind, and fits no tip
  git(f.work, 'checkout', 'work-main'); put(join(f.work, 'other.txt'), 'x\n'); commit(f.work, 'chore: mainline move');
  assert.deepEqual(at(), [false, true]);
  // the ref wound back behind the record's tip is no tip the record fell behind
  git(f.work, 'update-ref', 'refs/heads/work-main', `${prepared.mainTip}~1`);
  assert.deepEqual(at(), [false, false]);
});

test('a count that grew at a head is sent back while a check of the new tip is under way', async () => {
  const { f, prepared } = await structured((at) => [grew(at)]);
  moveMainline(f);
  const newTip = git(f.work, 'rev-parse', 'work-main');
  saveLandRun({ ...readLandRun('IDD-1'), status: 'running', ended_at: undefined, head: prepared.head, mainTip: newTip, pid: process.pid, started_at: new Date().toISOString() });
  assert.ok(landRunChecking('IDD-1'), 'a check of the new tip is under way');
  await sentBackAtOnce();
  assert.equal(sentOf()?.attrs?.main_tip, prepared.mainTip);
});

test('a record of the head at an earlier tip that did not fail on a count is checked at the new tip, as before', async () => {
  const { f, prepared } = await structured(() => [untaken(['merged'], '取り込む側の数を測れませんでした')]);
  moveMainline(f);
  const res = await runLand();
  assert.deepEqual([res.sentBack.includes('IDD-1'), res.checking.includes('IDD-1'), sentOf()], [false, true, undefined], JSON.stringify(res));
  assert.notEqual(prepared.mainTip, readLandRun('IDD-1').mainTip, 'the new tip is what is checked');
  await landSettled('IDD-1');
});

test('a count the mainline could not give is checked again as the environment\'s, one only the merge commit could not give as the change\'s', async () => {
  for (const [sides, cause] of [[['mainline'], 'environment'], [['merged'], 'real']]) {
    // the words of the detail are those of a failure of the change either way: the sides decide
    const { prepared } = await structured(() => [untaken(sides, '数えるコマンドが失敗しました（exit 3）')]);
    endedAgo('IDD-1', 10 * 60_000);
    const res = await runLand();
    assert.equal(res.sentBack.includes('IDD-1'), false, `${sides}: ${JSON.stringify(res)}`);
    assert.ok(res.checking.includes('IDD-1'), `${sides}: ${JSON.stringify(res)}`);
    const asks = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
    assert.deepEqual(asks.map((e) => [e.attrs.cause, e.attrs.head, e.attrs.main_tip]), [[cause, prepared.head, prepared.mainTip]], String(sides));
    await landSettled('IDD-1');
  }
});

test('a failure of the change that is a count only the merge commit could not give is sent back when it fails again', async () => {
  const { prepared } = await structured(() => [untaken(['merged'], '取り込む側の数を測れませんでした')]);
  endedAgo('IDD-1', 10 * 60_000);
  await seedLifecycle('s4_land_recheck', 'IDD-1', { head: prepared.head, main_tip: prepared.mainTip, reason: 'x', cause: 'real', attempt: 1 });
  const res = await runLand();
  assert.ok(res.sentBack.includes('IDD-1'), JSON.stringify(res));
  assert.match(instructionOfRevise(), /落ちた検査: structure\/duplicate-tokens/);
});

test('a failure of the change that passes when checked again is not sent back, and the card returns to the checked one', async () => {
  // the marker's dir has a space in its name, and the path reaches the command as one argument, as a checkout path with a space would
  const marker = join(scratchDir('flaky with space-'), 'ran');
  const flaky = { name: 'flaky', command: ['bash', '-c', 'if [ -f "$1" ]; then exit 0; fi; touch "$1"; echo "✖ the test (2ms)"; exit 1', 'bash', marker], required: true };
  const f = setup({ checks: [flaky] });
  change(f);
  await atShip();
  const cardGroup = deriveStage(laneEvents('IDD-1')).group;
  const prepared = await prepareLand('IDD-1');
  assert.equal(prepared.blocking, 1, JSON.stringify(prepared.checks));
  // right after the failure the same group is not run again: the wait is the environment's too
  endedAgo('IDD-1', 30_000);
  const early = await runLand();
  assert.equal(early.checking.includes('IDD-1'), false, JSON.stringify(early));
  assert.equal(early.sentBack.includes('IDD-1'), false, JSON.stringify(early));
  assert.equal(eventsOf('IDD-1').filter((e) => e === 's4_land_recheck').length, 0);
  endedAgo('IDD-1', 2 * 60_000 + 1);
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  const asks = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].attrs.cause, 'real');
  assert.match(String(asks[0].attrs.reason), /flaky/);
  const passed = await landSettled('IDD-1');
  assert.equal(passed.blocking, 0, 'the check again passed');
  assert.equal(passed.head, prepared.head, 'the same head');
  assert.equal(passed.mainTip, prepared.mainTip, 'the same mainline tip');
  const later = await runLand();
  assert.equal(later.sentBack.includes('IDD-1'), false, JSON.stringify(later));
  assert.equal(eventsOf('IDD-1').includes('s4_verify_user_judgment_answered'), false, 'nothing was sent back');
  assert.equal(eventsOf('IDD-1').includes('s4_land_check_sent_back'), false);
  assert.equal(deriveStage(laneEvents('IDD-1')).group, cardGroup, 'the lane stays at the submit card');
});

test('a check again written without the mark is the environment\'s: it does not use up the change\'s one', async () => {
  const f = setup({ checks: [BOOM] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  endedAgo('IDD-1', 10 * 60_000);
  await seedLifecycle('s4_land_recheck', 'IDD-1', { head: prepared.head, main_tip: prepared.mainTip, reason: 'x', attempt: 1 });
  const res = await runLand();
  assert.equal(res.sentBack.includes('IDD-1'), false, JSON.stringify(res));
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  const asks = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
  assert.deepEqual(asks.map((e) => [e.attrs.cause, e.attrs.attempt]), [[undefined, 1], ['real', 1]]);
  await landSettled('IDD-1');
});

test('the change\'s failure is checked again once for each mainline tip, and the environment\'s count stays apart', async () => {
  const f = setup({ checks: [BOOM] });
  change(f);
  await atShip();
  const prepared = await prepareLand('IDD-1');
  endedAgo('IDD-1', 3 * 60_000);
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  await landSettled('IDD-1');
  // another mainline tip is another group: the failure is checked again there before it is sent back
  put(join(f.work, 'other.txt'), 'x\n'); commit(f.work, 'chore: mainline move');
  const moved = await prepareLand('IDD-1');
  assert.notEqual(moved.mainTip, prepared.mainTip);
  endedAgo('IDD-1', 3 * 60_000);
  const next = await runLand();
  assert.equal(next.sentBack.includes('IDD-1'), false, JSON.stringify(next));
  assert.ok(next.checking.includes('IDD-1'), JSON.stringify(next));
  const asks = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
  assert.deepEqual(asks.map((e) => e.attrs.main_tip), [prepared.mainTip, moved.mainTip]);
  assert.deepEqual(asks.map((e) => e.attrs.attempt), [1, 1], 'each group counts its own');
  await landSettled('IDD-1');
  // the check again failed there too: now it is the executor's
  const g = await runLand();
  assert.ok(g.sentBack.includes('IDD-1'), JSON.stringify(g));
});

test('a landing blocked by a dirty work checkout is checked once the checkout is clean, without a person', async () => {
  const f = setup({ checks: [{ name: 'test', command: 'true', required: true }] });
  change(f);
  await atShip();
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  const blocked = await runLand();
  assert.ok(blocked.held.some((h) => h.iddId === 'IDD-1' && /clean/.test(h.reason)), JSON.stringify(blocked));
  assert.match(String(readLand('IDD-1')?.reason), /commit していない変更/);
  git(f.work, 'checkout', '--', 'app.txt');
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  const checked = await landSettled('IDD-1');
  assert.equal(checked.blocking, 0);
  assert.equal(checked.reason, undefined);
});

// ---- the tests a failed check names: a failure that moved to other tests is not the change's ----

/**
 * a check that fails with the summary test-entry ends with. `names` is a bash expression for the one test it names; the
 * round counter lives outside the lane's copies, so a run can tell which round it is
 */
function summarising(names) {
  const counter = join(scratchDir('land-rounds-'), 'rounds');
  const script = `n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo $n > "${counter}"; echo "ℹ fail 1"; echo "[test-entry] 組 test:lane が落ちました: 落ちたテスト 1 件"; echo "  - ${names}"; exit 1`;
  return { name: 'test:lane', command: ['bash', '-c', script], required: true };
}

/** a lane at the ship stage whose one check names the tests it fails on */
async function shippedWith(names) {
  const f = setup({ checks: [summarising(names)] });
  change(f);
  await atShip();
  return f;
}
const testsOf = (landed) => landed.checks.find((c) => c.name === 'test:lane').failedTests;
const recheckAsks = () => laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck');
const sentBackCount = () => eventsOf('IDD-1').filter((e) => e === 's4_land_check_sent_back').length;
/** the tick after the check ended three minutes ago: the tick's answer, with the check being run again */
async function tickChecking() {
  endedAgo('IDD-1', 3 * 60_000);
  const res = await runLand();
  assert.ok(res.checking.includes('IDD-1'), JSON.stringify(res));
  return res;
}

/** the tick checks the group again, and writes the ask with this cause */
async function recheckedAs(cause) {
  await tickChecking();
  assert.equal(recheckAsks().at(-1).attrs.cause, cause);
}
/** the group's first round, which names `test 1`: no round is before it to compare with */
async function firstRound() {
  const f = await shippedWith('test $n');
  const first = await prepareLand('IDD-1');
  assert.deepEqual(testsOf(first), ['test 1'], 'the names are read once, when the run writes the record');
  assert.equal(first.earlierFailed, undefined, 'the first round of the group has no round before it');
  return f;
}

test('a failure that moved to other tests is the environment\'s: it is not sent back, and it is checked again up to the limit', async () => {
  await firstRound();
  // the first failure of the group is the change's: checked again once on the same group
  await recheckedAs('real');
  const second = await landSettled('IDD-1');
  assert.deepEqual(testsOf(second), ['test 2']);
  assert.deepEqual(second.earlierFailed, [{ name: 'test:lane', tests: ['test 1'] }]);
  // the second round failed on another test: the environment's, so it is checked again, not sent back
  await recheckedAs('environment');
  assert.equal(sentBackCount(), 0);
  assert.match(String(recheckAsks().at(-1).attrs.reason), /今回: test 2 \/ 前の回: test 1/, 'the tests that did not repeat are named');
  // it keeps moving: three checks again of the environment's, then a person
  // the tick waits two minutes after the ask it wrote, which a test cannot age: the clock it reads runs ahead instead
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    for (let i = 0; i < LAND_RECHECK_MAX; i += 1) {
      await landSettled('IDD-1');
      skew += 3 * 60_000;
      const res = await runLand();
      if (i < LAND_RECHECK_MAX - 1) assert.ok(res.checking.includes('IDD-1'), `${i}: ${JSON.stringify(res)}`);
      else assert.ok(res.held.some((h) => h.iddId === 'IDD-1' && /3 回/.test(h.reason) && /重なりません/.test(h.reason)), JSON.stringify(res));
    }
  } finally { Date.now = realNow; }
  assert.equal(recheckAsks().filter((e) => e.attrs.cause === 'environment').length, LAND_RECHECK_MAX);
  assert.equal(sentBackCount(), 0, 'never sent back');
});

test('a failure on the same test again is the change\'s: checked again once, then sent back once', async () => {
  await shippedWith('the same test');
  await prepareLand('IDD-1');
  await tickChecking();
  assert.deepEqual((await landSettled('IDD-1')).earlierFailed, [{ name: 'test:lane', tests: ['the same test'] }]);
  assert.ok((await runLand()).sentBack.includes('IDD-1'));
  assert.equal(recheckAsks().length, 1);
  assert.equal(sentBackCount(), 1);
});

/** the round before is not this group's: it was of another tip or checked under another declaration, so its failed tests are not compared with */
const recordedAs = (patch) => () => save(landPath('IDD-1'), { ...readLand('IDD-1'), ...patch });
const otherGroups = [
  ['another mainline tip', moveMainline],
  ['another configKey', recordedAs({ configKey: 'config-of-before' })],
  ['another declaredKey', recordedAs({ declaredKey: 'declaration-of-before' })],
  ['a declaration that was not recorded', recordedAs({ declaredKey: undefined })],
];
for (const [what, change_] of otherGroups) {
  test(`a round before made under ${what} is not compared with: its failure is the change's`, async () => {
    change_(await firstRound());
    const second = await prepareLand('IDD-1');
    assert.deepEqual(testsOf(second), ['test 2'], 'the group was checked again');
    assert.equal(second.earlierFailed, undefined, 'the tests of another group say nothing of this one');
    await recheckedAs('real');
  });
}

test('a stop on uncommitted work names the paths: an untracked dir is one, five are named, the rest is a count', () => {
  const f = setup();
  const loc = laneLocations('IDD-1');
  assert.equal(checkouts('IDD-1', loc), null);
  // a changed tracked file, a whole untracked dir (its files are not named) and an untracked file
  put(join(f.work, 'app.txt'), 'uncommitted\n');
  put(join(f.work, '.next', 'server', 'index.js'), 'x\n');
  put(join(f.work, '.next', 'b.txt'), 'x\n');
  put(join(f.work, 'next-env.d.ts'), 'x\n');
  const few = String(checkouts('IDD-1', loc));
  assert.match(few, /^work 側の checkout に commit していない変更があります（.*）。clean にしてから merge します$/);
  assert.deepEqual(few.slice(few.indexOf('（') + 1, few.indexOf('）')).split('、'), ['app.txt', '.next/', 'next-env.d.ts']);
  assert.equal(few.includes('index.js') || few.includes('b.txt'), false, 'the files in an untracked dir are not named');
  for (const name of ['c.txt', 'd.txt', 'e.txt', 'f.txt']) put(join(f.work, name), 'x\n');
  const many = String(checkouts('IDD-1', loc));
  assert.match(many, /（app\.txt、\.next\/、c\.txt、d\.txt、e\.txt、ほか 2 件）/);
});

test('an untracked dir is one path whatever the user\'s status.showUntrackedFiles is', () => {
  const f = setup();
  const loc = laneLocations('IDD-1');
  put(join(f.work, '.next', 'server', 'index.js'), 'x\n');
  put(join(f.work, '.next', 'b.txt'), 'x\n');
  for (const value of ['all', 'no']) {
    git(f.work, 'config', 'status.showUntrackedFiles', value);
    const stop = String(checkouts('IDD-1', loc));
    assert.ok(stop.includes('（.next/）'), `${value}: ${stop}`);
    assert.equal(stop.includes('index.js'), false, `${value}: the files of the dir are not named`);
  }
});

test('a stop on uncommitted work stays whole within what the timeline shows, whatever the length of the paths', () => {
  const f = setup();
  const loc = laneLocations('IDD-1');
  // five ordinary long paths would push the next step past the 120 characters the timeline shows
  const long = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((n) => `generated-report-of-the-${n}-module-run.json`);
  for (const name of long) put(join(f.work, name), 'x\n');
  const stop = String(checkouts('IDD-1', loc));
  assert.ok(stop.length <= 120, `${stop.length}: ${stop}`);
  assert.ok(stop.endsWith('。clean にしてから merge します'), stop);
  assert.ok(stop.includes('generated-report-of-the-alpha'), 'a path is named');
  assert.match(stop, /、ほか [1-9]\d* 件）/, 'what is not named is counted');
  // one path longer than the sentence has room for keeps its end and the next step
  for (const name of long) rmSync(join(f.work, name));
  const deep = join(f.lane.path, ...Array.from({ length: 8 }, (_, i) => `very-long-directory-name-${i}`), 'file-with-a-long-name.txt');
  put(deep, 'x\n');
  const lane = String(checkouts('IDD-1', laneLocations('IDD-1')));
  assert.ok(lane.length <= 120, `${lane.length}: ${lane}`);
  assert.match(lane, /^lane に commit していない変更があります（/);
});

test('a stop on the lane\'s uncommitted work names its paths in the same form', () => {
  const f = setup();
  const loc = laneLocations('IDD-1');
  put(join(f.lane.path, 'app.txt'), 'lane edit\n');
  put(join(f.lane.path, 'scratch', 'a.txt'), 'x\n');
  assert.equal(checkouts('IDD-1', loc), 'lane に commit していない変更があります（app.txt、scratch/）');
  // a renamed file is named by its new path, once
  commit(f.lane.path, 'chore: lane work');
  git(f.lane.path, 'mv', 'app.txt', 'renamed.txt');
  assert.equal(checkouts('IDD-1', loc), 'lane に commit していない変更があります（renamed.txt）');
});

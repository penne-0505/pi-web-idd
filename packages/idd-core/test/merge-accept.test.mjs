import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { proposeForTests as propose, exportLane, readProposal, proposalPath } from '../src/overlay/export.ts';
import { proposeImport, importedCurrent } from '../src/overlay/import.ts';
import { syncArea } from '../src/overlay/sync.ts';
import { runClose } from '../src/plan/close.ts';
import { acceptWorstMinutes, runMergeAccept } from '../src/plan/merge-accept.ts';
import { deriveStage, laneHalt } from '../src/ledger/derive.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { applyDecision } from '../src/ledger/write.ts';
import { pushApproval } from './passkey-approval.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); }

/** one repo ("demo") with a lane IDD-1 whose change was published; its PR is merged on the public side */
async function setup(checks = []) {
  process.chdir(original);
  const root = scratchDir('accept-');
  const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n'); put(join(work, 'app.txt'), 'one\ntwo\nthree\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream);
  git(upstream, 'config', 'user.name', 'test'); git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  const areas = join(root, 'repos.yaml');
  const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks, issue_lane: { context: 'personal', source_type_priority: 'github' } };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change' }) + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, executor_session_id: 'test-session' }) + '\n');
  process.chdir(work);

  // the lane publishes its change; the PR is merged on the public side (the branch lands on main)
  put(join(lane.path, 'lane.txt'), 'from the lane\n'); commit(lane.path);
  const p = await propose('IDD-1', { title: 'feat: change', body: 'body\n' });
  assert.ok(!p.error, p.error);
  appendFileSync(join(state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 's4_submit_started', at: new Date(Date.now() - 120_000).toISOString() }) + '\n');
  const pushed = exportLane('IDD-1', p.token, pushApproval('IDD-1', { message: 'feat: change' }));
  assert.equal(pushed.ok, true, pushed.error);
  const done = readProposal('IDD-1'); done.status = 'complete'; writeFileSync(proposalPath('IDD-1'), JSON.stringify(done));
  git(upstream, 'fetch', 'origin'); git(upstream, 'merge', '--ff-only', `origin/${lane.branch}`); git(upstream, 'push', 'origin', 'main');
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const event of ['s4_pushed', 's4_pr_created']) {
    appendFileSync(join(state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event, at, attrs: { pr_number: 2, pr_url: 'https://github.com/test/project/pull/2' } }) + '\n');
  }
  return { root, work, remote, upstream, state, lane, config, areas, ledger: join(state, 'lifecycle-demo.jsonl') };
}

/** a `gh` that answers every `pr view` with this state; `onCall` is node source run first, in the stub */
function stubGh(f, state = 'MERGED', onCall = '') {
  const bin = join(f.root, 'bin'); mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'gh');
  put(stub, `#!${process.execPath}\n${onCall}\nconsole.log(JSON.stringify({state:${JSON.stringify(state)},mergedAt:'2026-10-25T10:00:00Z',mergedBy:{login:'someone'}}));`);
  chmodSync(stub, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH.split(':').filter((p) => p !== bin).join(':')}`;
}

/** one pass of what the tick does for a merged lane: the close pass, then the acceptance stage */
async function pass() {
  const close = await runClose({ keepHeld: true });
  return runMergeAccept(close);
}
const events = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1');
const closed = () => events().some((e) => e.event === 'lane_close');
const halts = () => events().filter((e) => e.event === 'lane_stall_detected');
const recoveries = (f) => git(f.work, 'worktree', 'list').split('\n').filter((l) => l.includes('recovery')).length;

/** the work branch and the public branch both change app.txt: the receive conflicts */
function conflict(f) {
  put(join(f.work, 'app.txt'), 'ours\n'); commit(f.work);
  put(join(f.upstream, 'app.txt'), 'theirs\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
}

test('a merged lane is received, its records reclaimed and the lane closed by the pass, without a sync', async () => {
  const f = await setup(); stubGh(f);
  assert.equal(importedCurrent('demo'), false);
  const r = await pass();
  assert.deepEqual(r.tried, ['demo']);
  assert.deepEqual(r.closed, ['IDD-1']);
  assert.deepEqual(r.stopped, []);
  assert.equal(closed(), true);
  assert.equal(importedCurrent('demo'), true);
  assert.equal(readFileSync(join(f.work, 'lane.txt'), 'utf8'), 'from the lane\n');
  assert.equal(events().filter((e) => e.event === 's4_merged').length, 1);
});

test('a work branch that already holds the public tip is marked as received by the pass, and the lane closes', async () => {
  const f = await setup(); stubGh(f);
  // someone merged the public branch by hand: the receive has nothing to take in, and no mark was ever written
  git(f.work, 'fetch', 'origin'); git(f.work, 'merge', '--no-edit', 'origin/main');
  assert.equal(importedCurrent('demo'), false);
  const r = await pass();
  assert.deepEqual(r.tried, ['demo']);
  assert.deepEqual(r.closed, ['IDD-1']);
  assert.deepEqual(r.stopped, []);
  assert.equal(importedCurrent('demo'), true);
  assert.equal(closed(), true);
  assert.equal(recoveries(f), 0);
});

test('a public tip the work branch holds is marked only after the receive read it is an ancestor', async () => {
  const f = await setup(); stubGh(f, 'OPEN');
  const first = await syncArea('demo');
  assert.equal(first.ok, true, first.error);
  // the public branch is reset behind what was taken in: nothing to take, and that tip is in the work branch
  git(f.upstream, 'push', '--force', 'origin', `${git(f.upstream, 'rev-parse', 'HEAD~1')}:main`);
  assert.equal(importedCurrent('demo'), false);
  const second = await syncArea('demo');
  assert.equal(second.ok, true, second.error);
  assert.equal(importedCurrent('demo'), true);
});

test('records that cannot be reclaimed because the work branch is not clean send a person to the work branch', async () => {
  const f = await setup(); stubGh(f, 'OPEN');
  const received = await syncArea('demo');
  assert.equal(received.ok, true, received.error);
  stubGh(f);
  put(join(f.work, 'unfinished.txt'), 'half done\n');
  const first = await pass();
  assert.equal(closed(), false);
  assert.equal(first.stopped.length, 1);
  const reason = first.stopped[0].reason;
  assert.match(reason, /記録を作業本流へ回収できません/);
  assert.ok(reason.includes(f.work), reason);
  assert.ok(!reason.includes(f.lane.path), reason);
  const second = await pass();
  assert.deepEqual(second.stopped, []);
  assert.equal(halts().length, 1);
});

test('a repo that waits for no merged lane is left alone, however far the public branch moved', async () => {
  const f = await setup(); stubGh(f, 'OPEN');
  put(join(f.upstream, 'later.txt'), 'later\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
  const head = git(f.work, 'rev-parse', 'HEAD');
  const open = await pass();
  assert.deepEqual(open.tried, []);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  assert.equal(closed(), false);
  stubGh(f);
  // the lane is closed by a person meanwhile: nothing waits, and the public branch moves again
  appendFileSync(f.ledger, JSON.stringify({ idd_id: 'IDD-1', event: 'lane_close', at: new Date().toISOString(), attrs: { outcome: 'aborted' } }) + '\n');
  put(join(f.upstream, 'again.txt'), 'again\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
  const none = await pass();
  assert.deepEqual(none.tried, []);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
});

test('a conflict leaves the lane open with a card that names the reason and the recovery, and the card stays one', async () => {
  const f = await setup(); stubGh(f);
  conflict(f);
  const head = git(f.work, 'rev-parse', 'HEAD');
  const first = await pass();
  assert.deepEqual(first.tried, ['demo']);
  assert.equal(first.stopped.length, 1);
  assert.equal(closed(), false);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  const stage = deriveStage(events());
  assert.equal(stage.decision, 'stuck');
  const halt = laneHalt(events());
  const recovery = proposeImport('demo').recovery;
  assert.match(halt.reason, /衝突/);
  assert.ok(halt.reason.includes(recovery), halt.reason);
  assert.match(stage.blockedBy, /engine が進められない/);

  // the same cause across later passes: no new record, no new attempt, no new recovery
  const count = recoveries(f);
  for (let i = 0; i < 3; i += 1) {
    const again = await pass();
    assert.deepEqual(again.tried, []);
    assert.deepEqual(again.stopped, []);
  }
  assert.equal(halts().length, 1);
  assert.equal(recoveries(f), count);
  assert.equal(closed(), false);
});

test('a resolution committed in the recovery is read again by the next pass, which receives it and closes the lane', async () => {
  const f = await setup(); stubGh(f);
  conflict(f);
  await pass();
  assert.equal(closed(), false);
  const recovery = proposeImport('demo').recovery;
  put(join(recovery, 'app.txt'), 'resolved\n'); commit(recovery, 'chore: resolve');
  const r = await pass();
  assert.deepEqual(r.closed, ['IDD-1']);
  assert.equal(closed(), true);
  assert.equal(readFileSync(join(f.work, 'app.txt'), 'utf8'), 'resolved\n');
  assert.equal(importedCurrent('demo'), true);
});

test('a conflict that is only abandoned in the recovery is not read as resolved', async () => {
  const f = await setup(); stubGh(f);
  conflict(f);
  await pass();
  const recovery = proposeImport('demo').recovery;
  git(recovery, 'merge', '--abort');
  const r = await pass();
  assert.equal(closed(), false);
  assert.equal(deriveStage(events()).decision, 'stuck');
  assert.equal(r.closed.length, 0);
});

test('an empty commit after the merge is abandoned moves the recovery head without taking the public side in, and is not read as resolved', async () => {
  const f = await setup(); stubGh(f);
  conflict(f);
  await pass();
  const head = git(f.work, 'rev-parse', 'HEAD');
  const recovery = proposeImport('demo').recovery;
  git(recovery, 'merge', '--abort');
  git(recovery, 'commit', '--allow-empty', '-m', 'chore: nothing taken in');
  for (let i = 0; i < 2; i += 1) {
    const r = await pass();
    assert.equal(r.closed.length, 0);
    assert.equal(closed(), false);
    assert.equal(deriveStage(events()).decision, 'stuck');
  }
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  assert.equal(importedCurrent('demo'), false);
});

test('a failing required check leaves the lane open with a card, is not run again under it, and a fix in the recovery is read again', async () => {
  const counter = join(scratchDir('accept-count-'), 'runs');
  const f = await setup();
  // the lane's own submit passed before; the check is set for the receive
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'ready', command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)},'x');require('node:fs').readFileSync('ready.txt')`], required: true }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  const head = git(f.work, 'rev-parse', 'HEAD');
  const first = await pass();
  assert.equal(first.stopped.length, 1);
  assert.equal(closed(), false);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  const halt = laneHalt(events());
  assert.match(halt.reason, /必須の検査が通りません: ready/);
  assert.match(halt.reason, /直す場所: /);
  assert.equal(deriveStage(events()).decision, 'stuck');

  for (let i = 0; i < 3; i += 1) assert.deepEqual((await pass()).tried, []);
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'the check ran once');
  assert.equal(halts().length, 1);

  const recovery = proposeImport('demo').recovery;
  put(join(recovery, 'ready.txt'), 'ok\n'); commit(recovery, 'chore: make the check pass');
  const fixed = await pass();
  assert.deepEqual(fixed.closed, ['IDD-1']);
  assert.equal(closed(), true);
});

test('records that conflict on reclaim leave the lane open with a card at the recovery worktree, and are not tried again under it', async () => {
  const f = await setup(); stubGh(f);
  // the work branch and the lane both write the same record file, differently
  put(join(f.work, '_docs/shared.md'), 'base'); commit(f.work);
  git(f.lane.path, 'merge', 'work-main');
  put(join(f.lane.path, '_docs/shared.md'), 'lane'); commit(f.lane.path);
  put(join(f.work, '_docs/shared.md'), 'main'); commit(f.work);
  const first = await pass();
  assert.equal(closed(), false);
  assert.equal(first.stopped.length, 1);
  assert.match(first.stopped[0].reason, /記録を作業本流へ回収できません/);
  // the conflict is resolved in the recovery the reclaim cut, so that is where the card sends a person, not the lane checkout
  const where = /直す場所: (\S+?)（/.exec(first.stopped[0].reason)?.[1];
  assert.ok(where?.includes('record-conflicts'), first.stopped[0].reason);
  assert.ok(existsSync(where));
  assert.ok(!first.stopped[0].reason.includes(f.lane.path));
  assert.equal(deriveStage(events()).decision, 'stuck');
  const second = await pass();
  assert.deepEqual(second.stopped, []);
  assert.equal(halts().length, 1);
});

test('penne answering the card lets the next pass try again, and a pass that read the lane before her answer closes nothing', async () => {
  const f = await setup();
  // `gh` is run after the close pass read the lane: it plays penne answering in between
  const answer = JSON.stringify({ idd_id: 'IDD-1', event: 'lane_stall_resumed', at: new Date().toISOString(), attrs: { at_by: 'user' } }) + '\n';
  const flag = join(f.root, 'answered');
  stubGh(f, 'MERGED', `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(flag)})){fs.appendFileSync(${JSON.stringify(f.ledger)},${JSON.stringify(answer)});fs.unlinkSync(${JSON.stringify(flag)})}`);
  writeFileSync(flag, '');
  const r = await runClose({ keepHeld: true });
  assert.equal(r.find((c) => c.iddId === 'IDD-1').outcome, 'merged');
  assert.equal(closed(), false, 'her answer came first: the close waits for the next pass');
  const next = await pass();
  assert.deepEqual(next.closed, ['IDD-1']);
});

test('a stop is not written over an answer that came while the receive was being tried', async () => {
  const f = await setup();
  // the check plays penne answering the lane while the receive's checks run
  const answer = JSON.stringify({ idd_id: 'IDD-1', event: 'lane_stall_resumed', at: new Date().toISOString(), attrs: { at_by: 'user' } }) + '\n';
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'answer-then-fail', command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(f.ledger)},${JSON.stringify(answer)});process.exit(1)`], required: true }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  const r = await pass();
  assert.deepEqual(r.stopped, [], 'no card is written on a read that her answer has passed');
  assert.equal(halts().length, 0);
  assert.equal(closed(), false);
});

test('after her answer a cause that is still there raises the card again, and a card answered with "retry" is a plain merged lane', async () => {
  const f = await setup(); stubGh(f);
  conflict(f);
  await pass();
  assert.equal(halts().length, 1);
  assert.equal((await applyDecision('lane_stall_resume', { iddId: 'IDD-1' })).ok, true);
  assert.notEqual(deriveStage(events()).decision, 'stuck');
  const again = await pass();
  assert.deepEqual(again.tried, ['demo']);
  assert.equal(halts().length, 2);
  assert.equal(deriveStage(events()).decision, 'stuck');
});

test('a repo whose checks cannot end inside a tick gets a card that says where to receive, and is not run', async () => {
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'slow', command: ['true'], required: true, timeout_minutes: 30 }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  const head = git(f.work, 'rev-parse', 'HEAD');
  const r = await pass();
  assert.deepEqual(r.tried, []);
  assert.equal(r.stopped.length, 1);
  assert.match(r.stopped[0].reason, /idd sync demo/);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
});

test('the longest a receive can run counts every command with the grace past its limit', async () => {
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'a', command: ['true'], required: true, timeout_minutes: 5 }, { name: 'b', command: ['true'], required: false, timeout_minutes: 10 }, { name: 'c', command: ['true'] }];
  areas.repos.demo.setup = ['true'];
  writeFileSync(f.areas, JSON.stringify(areas));
  // 5 + 10 + 5 (the default) + 15 (one setup command), and a minute of grace for each of the four commands
  assert.equal(acceptWorstMinutes('demo'), 5 + 10 + 5 + 15 + 4);
});

test('a receive whose longest run with the grace passes 17 minutes is not started, and a card sends it to a person', async () => {
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  // 17 minutes of limit and a minute of grace: 18, past the 17 one receive may run
  areas.repos.demo.checks = [{ name: 'slow', command: ['true'], required: true, timeout_minutes: 17 }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  const head = git(f.work, 'rev-parse', 'HEAD');
  const r = await pass();
  assert.deepEqual(r.tried, []);
  assert.deepEqual(r.waiting, []);
  assert.equal(r.stopped.length, 1);
  assert.match(r.stopped[0].reason, /idd sync demo/);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  // the card stands and nothing it stopped on changed: neither the receive nor another card
  const long = await runMergeAccept(await runClose({ keepHeld: true }), Date.now());
  assert.deepEqual(long.tried, []);
  assert.deepEqual(long.stopped, []);
  assert.equal(halts().length, 1);
});

test('a receive of 17 minutes at most starts early in a tick and waits for the next one when the tick has run on', async () => {
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  // 16 minutes of limit and a minute of grace: 17, which one receive may run
  areas.repos.demo.checks = [{ name: 'fits', command: ['true'], required: true, timeout_minutes: 16 }];
  writeFileSync(f.areas, JSON.stringify(areas));
  assert.equal(acceptWorstMinutes('demo'), 17);
  stubGh(f);
  const head = git(f.work, 'rev-parse', 'HEAD');
  const late = await runMergeAccept(await runClose({ keepHeld: true }), Date.now() - 2 * 60_000);
  assert.deepEqual(late.tried, []);
  assert.deepEqual(late.waiting, ['demo']);
  assert.deepEqual(late.stopped, []);
  assert.equal(halts().length, 0);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  const early = await runMergeAccept(await runClose({ keepHeld: true }), Date.now());
  assert.deepEqual(early.tried, ['demo']);
  assert.deepEqual(early.closed, ['IDD-1']);
});

test('a commit on the public branch alone does not read a failing check again, and no stop record is added under the card', async () => {
  const counter = join(scratchDir('accept-count-'), 'runs');
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'ready', command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)},'x');require('node:fs').readFileSync('ready.txt')`], required: true }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  assert.equal((await pass()).stopped.length, 1);
  for (let i = 0; i < 3; i += 1) {
    put(join(f.upstream, `unrelated-${i}.txt`), 'x\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
    const again = await pass();
    assert.deepEqual(again.tried, []);
    assert.deepEqual(again.stopped, []);
  }
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'the check ran once');
  assert.equal(halts().length, 1);
  assert.equal(closed(), false);
});

test('a commit on the work branch alone (another lane receiving) does not run a failing check again, and no stop record is added under the card', async () => {
  const counter = join(scratchDir('accept-count-'), 'runs');
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'ready', command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)},'x');require('node:fs').readFileSync('ready.txt')`], required: true }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  assert.equal((await pass()).stopped.length, 1);
  for (let i = 0; i < 3; i += 1) {
    put(join(f.work, `unrelated-${i}.txt`), 'x\n'); commit(f.work);
    const again = await pass();
    assert.deepEqual(again.tried, []);
    assert.deepEqual(again.stopped, []);
  }
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'the check ran once');
  assert.equal(halts().length, 1);
  assert.equal(closed(), false);
});

test('a commit on the public branch alone does not read a conflict again', async () => {
  const f = await setup(); stubGh(f);
  conflict(f);
  assert.equal((await pass()).stopped.length, 1);
  const count = recoveries(f);
  for (let i = 0; i < 2; i += 1) {
    put(join(f.upstream, `unrelated-${i}.txt`), 'x\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
    const again = await pass();
    assert.deepEqual(again.tried, []);
    assert.deepEqual(again.stopped, []);
  }
  assert.equal(halts().length, 1);
  assert.equal(recoveries(f), count);
  assert.equal(closed(), false);
});

test('putting the work checkout back on its branch at the same commit reads the stopped receive again', async () => {
  const f = await setup(); stubGh(f);
  git(f.work, 'checkout', '-b', 'elsewhere');
  assert.equal((await pass()).stopped.length, 1);
  assert.equal((await pass()).stopped.length, 0);
  assert.equal(halts().length, 1);
  git(f.work, 'checkout', 'work-main');
  const again = await pass();
  assert.deepEqual(again.tried, ['demo']);
  assert.deepEqual(again.closed, ['IDD-1']);
});

test('a receipt the public branch has moved past is cut again from the new tip, and the lane closes without a card', async () => {
  const f = await setup(); stubGh(f);
  assert.ok(!proposeImport('demo').error);
  put(join(f.upstream, 'later.txt'), 'later\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
  const r = await pass();
  assert.deepEqual(r.closed, ['IDD-1']);
  assert.equal(halts().length, 0);
  assert.equal(readFileSync(join(f.work, 'later.txt'), 'utf8'), 'later\n');
  assert.equal(recoveries(f), 0);
});

test('a public branch that moves while the checks run is not a stop: the next pass reads it again from the new tip', async () => {
  const f = await setup();
  const flag = join(scratchDir('accept-flag-'), 'moved');
  const script = `const fs=require('node:fs'),cp=require('node:child_process'),up=${JSON.stringify(f.upstream)};`
    + `if(!fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(flag)},'');fs.writeFileSync(up+'/moved.txt','x');`
    + `const g=(...a)=>cp.execFileSync('git',['-C',up,...a]);g('add','.');g('commit','-m','moved');g('push','origin','main')}`;
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'moves-public', command: [process.execPath, '-e', script], required: true }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  const first = await pass();
  assert.deepEqual(first.waiting, ['demo']);
  assert.deepEqual(first.stopped, []);
  assert.equal(halts().length, 0);
  assert.equal(closed(), false);
  const second = await pass();
  assert.deepEqual(second.closed, ['IDD-1']);
  assert.equal(halts().length, 0);
  assert.equal(readFileSync(join(f.work, 'moved.txt'), 'utf8'), 'x');
});

test('fixing only the check settings after a failing check is read by the next pass under the new settings', async () => {
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'ready', command: [process.execPath, '-e', "require('node:fs').readFileSync('ready.txt')"], required: true }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  assert.equal((await pass()).stopped.length, 1);
  assert.deepEqual((await pass()).tried, [], 'nothing changed: not read again');
  // the check is fixed in the settings alone: no commit, no answer
  areas.repos.demo.checks = [{ name: 'ready', command: [process.execPath, '-e', 'process.exit(0)'], required: true }];
  writeFileSync(f.areas, JSON.stringify(areas));
  const again = await pass();
  assert.deepEqual(again.tried, ['demo']);
  assert.deepEqual(again.closed, ['IDD-1']);
  assert.equal(halts().length, 1);
});

test('changing only the check preparation (a limit kept beside the area) after a card is read by the next pass', async () => {
  const f = await setup();
  const areas = JSON.parse(readFileSync(f.areas, 'utf8'));
  areas.repos.demo.checks = [{ name: 'slow', command: ['true'], required: true, timeout_minutes: 17 }];
  writeFileSync(f.areas, JSON.stringify(areas));
  stubGh(f);
  assert.equal((await pass()).stopped.length, 1);
  assert.deepEqual((await pass()).stopped, []);
  areas.repos.demo.checks = [{ name: 'slow', command: ['true'], required: true, timeout_minutes: 2 }];
  writeFileSync(f.areas, JSON.stringify(areas));
  const again = await pass();
  assert.deepEqual(again.closed, ['IDD-1']);
  assert.equal(halts().length, 1);
});

test('a resolution in the recovery survives the public branch moving on, and the card names the way out', async () => {
  const f = await setup(); stubGh(f);
  conflict(f);
  await pass();
  const recovery = proposeImport('demo').recovery;
  put(join(recovery, 'app.txt'), 'resolved\n'); commit(recovery, 'chore: resolve');
  const resolved = git(recovery, 'rev-parse', 'HEAD');
  put(join(f.upstream, 'later.txt'), 'later\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
  const r = await pass();
  assert.equal(closed(), false);
  assert.equal(r.stopped.length, 1);
  assert.match(r.stopped[0].reason, /cancel-import demo/);
  assert.ok(existsSync(recovery));
  assert.equal(git(recovery, 'rev-parse', 'HEAD'), resolved);
  assert.deepEqual((await pass()).stopped, []);
  assert.equal(halts().length, 2);
});

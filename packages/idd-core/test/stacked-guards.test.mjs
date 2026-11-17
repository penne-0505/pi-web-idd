import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { proposeForTests as propose, readProposal, proposalPath, baseReceiptPath, custodyPath } from '../src/overlay/export.ts';
import { proposeImport, reviewImport, importUpstream } from '../src/overlay/import.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { setLaneBase, receiveBase, adoptLane, validateStackTarget, laneBaseOf } from '../src/overlay/base.ts';
import { laneHasUnpublished } from '../src/plan/close.ts';
import { git, put, commit, event, setup, session, publishParent, child, atGo } from './stacked-fixture.mjs';
import { shipApproved } from './passkey-approval.mjs';

const waitingOnPr = (f, id) => { event(f, id, 's4_submit_started'); event(f, id, 's4_pushed'); event(f, id, 's4_pr_created', { pr_number: 3, pr_url: 'u' }); };
function ghStub(f, script) {
  const bin = join(f.root, 'bin'); mkdirSync(bin, { recursive: true });
  put(join(bin, 'gh'), `#!${process.execPath}\n${script}`); chmodSync(join(bin, 'gh'), 0o755);
  const old = process.env.PATH; process.env.PATH = bin + ':' + old; return () => { process.env.PATH = old; };
}

// R1: until the submit side knows a lane's base, a stacked lane must not be proposed toward the public base
test('R1: a stacked lane cannot be proposed until the submit side handles its base', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f);
  put(join(lane.path, 'child.txt'), 'child\n'); commit(lane.path);
  const p = await propose('IDD-2', { title: 'feat: child', body: '' });
  assert.match(p.error ?? '', /段 2/, JSON.stringify(p.publish ?? p));
});

// R4: a lane with a PR that took in its public base cannot publish that base's changes as its own. The receive
// itself is refused once the lane has published (M1); a receive on record reaches such a lane through an adopt
test('R4: a lane with a published branch and a base receive on record cannot be proposed until the submit side carries the base', async () => {
  const f = setup();
  put(join(f.parent.path, 'mine.txt'), 'mine\n'); commit(f.parent.path); await publishParent(f);
  waitingOnPr(f, 'IDD-1');
  event(f, 'IDD-1', 'lane_base_received', { branch: 'main', parent: null });
  put(join(f.parent.path, 'mine.txt'), 'mine 2\n'); commit(f.parent.path);
  const next = await propose('IDD-1', { title: 'feat: more', body: '' });
  assert.match(next.error ?? '', /段 2/, JSON.stringify(next.publish ?? next));
});

// a receive on record before the first submit (the receive of a lane on the public base itself is refused: S4)
test('until the submit side carries the base, a lane that received its base before its first submit is stopped too', async () => {
  const f = setup(); atGo(f, 'IDD-1');
  put(join(f.parent.path, 'mine.txt'), 'mine\n'); commit(f.parent.path);
  event(f, 'IDD-1', 'lane_base_received', { branch: 'main', parent: null });
  const next = await propose('IDD-1', { title: 'feat: mine', body: '' });
  assert.match(next.error ?? '', /段 2/, JSON.stringify(next.publish ?? next));
});

// A: a receive of the lane's own public branch rewrites custody; the stop must not be lifted by it
test('A: after a base receive, taking in a push to the PR branch does not lift the stop on the submit', async () => {
  const f = setup();
  put(join(f.parent.path, 'mine.txt'), 'mine\n'); commit(f.parent.path); await publishParent(f);
  waitingOnPr(f, 'IDD-1');
  // a receive on record (the receive itself is refused once the lane has published: M1)
  event(f, 'IDD-1', 'lane_base_received', { branch: 'main', parent: null });
  // someone pushes to the PR branch, and the lane takes it in
  git(f.upstream, 'fetch', 'origin'); git(f.upstream, 'checkout', '-b', 'pr', 'origin/idd/IDD-1'); put(join(f.upstream, 'review.txt'), 'review fix\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'pr:idd/IDD-1');
  const r = proposeImport('demo', { laneId: 'IDD-1' }); assert.ok(!r.error, r.error); assert.equal(r.conflict, false);
  const rr = await reviewImport('demo', { laneId: 'IDD-1' }); assert.ok(!rr.error, rr.error); assert.equal(importUpstream('demo', rr.token, { laneId: 'IDD-1' }).ok, true);
  const next = await propose('IDD-1', { title: 'feat: more', body: '' });
  assert.match(next.error ?? '', /段 2/, JSON.stringify(next.publish ?? next));
});

// B: a receive whose records were cut short leaves its receipt at applying
test('B: a receipt left at applying stops the submit as a finished one does', async () => {
  const f = setup(); atGo(f, 'IDD-1');
  put(join(f.parent.path, 'mine.txt'), 'mine\n'); const head = commit(f.parent.path);
  writeFileSync(baseReceiptPath('IDD-1'), JSON.stringify({ branch: 'main', parent: null, publicTip: head, workCommit: head, from: head, result: head, status: 'applying', at: new Date().toISOString() }));
  const next = await propose('IDD-1', { title: 'feat: mine', body: '' });
  assert.match(next.error ?? '', /段 2/, JSON.stringify(next.publish ?? next));
});

test('a manual change of base is refused while the parent lane has ended', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  await child(f);
  event(f, 'IDD-1', 'lane_close', { outcome: 'aborted' });
  const r = await setLaneBase('IDD-2', { branch: 'main' }, 'manual');
  assert.match(r.error ?? '', /終わ/, JSON.stringify(r));
  assert.equal(laneBaseOf('IDD-2').branch, 'idd/IDD-1');
});

test('a lane whose branch exists takes its worktree again without looking for a start point', async () => {
  const f = setup();
  const lane = ensureLaneWorktree('demo', 'IDD-2'); session(f.state, 'IDD-2', lane);
  git(f.work, 'worktree', 'remove', lane.path);
  // its recorded base now names a parent that has no branch yet
  event(f, 'IDD-2', 'lane_base_set', { branch: 'idd/IDD-3', parent: 'IDD-3', source: 'manual' });
  const again = ensureLaneWorktree('demo', 'IDD-2');
  assert.equal(again.branch, lane.branch); assert.ok(existsSync(again.path));
});

test('a receive is refused while a pushed submit still waits for its PR', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f); const before = git(lane.path, 'rev-parse', 'HEAD');
  put(join(f.parent.path, 'other.txt'), 'parent v2\n'); commit(f.parent.path); await publishParent(f);
  writeFileSync(proposalPath('IDD-2'), JSON.stringify({ status: 'pushed', expiresAt: new Date().toISOString(), token: 't' }));
  const r = await receiveBase('IDD-2');
  assert.equal(r.ok, false); assert.match(r.error, /push/);
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), before);
});

// R2: a lane cut from a work branch that moved past the parent's fork cannot be put on the parent afterwards
test('R2: stacking a lane whose branch already holds work-branch commits the parent lacks is refused', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  put(join(f.work, 'other.txt'), 'work main moved\n'); commit(f.work);
  const lane = ensureLaneWorktree('demo', 'IDD-2'); session(f.state, 'IDD-2', lane); atGo(f, 'IDD-2');
  const r = await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual');
  assert.match(r.error ?? '', /branch/, JSON.stringify(r));
  assert.equal(laneBaseOf('IDD-2').parent, null);
});

test('stacking a lane cut from the same point as its parent is allowed', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  const lane = ensureLaneWorktree('demo', 'IDD-2'); session(f.state, 'IDD-2', lane); atGo(f, 'IDD-2');
  const r = await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in r), r.error);
});

// R3: a lane cut from its parent cannot be moved back to the public base: its branch holds the parent's commits
test('R3: moving a lane cut from its parent back to the public base is refused', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  await child(f);
  const r = await setLaneBase('IDD-2', { branch: 'main' }, 'manual');
  assert.match(r.error ?? '', /branch/, JSON.stringify(r));
  assert.equal(laneBaseOf('IDD-2').parent, 'IDD-1');
});

test('adopt records the base only after the receive is prepared, and adopts without a base when gh cannot tell', async () => {
  const f = setup();
  // the lane has uncommitted changes: the receive is not prepared, and the base stays as it was
  let restore = ghStub(f, `console.log(JSON.stringify([{number:7,baseRefName:'idd/IDD-3',url:'u'}]));`);
  const third = ensureLaneWorktree('demo', 'IDD-3'); session(f.state, 'IDD-3', third);
  git(f.upstream, 'checkout', '-b', 'someone/child', 'main'); put(join(f.upstream, 'x.txt'), 'x\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'someone/child');
  put(join(f.parent.path, 'dirty.txt'), 'dirty');
  try {
    const r = await adoptLane('IDD-1', 'someone/child');
    assert.ok(r.error); assert.equal(readLifecycle().filter((e) => e.idd_id === 'IDD-1' && e.event === 'lane_base_set').length, 0);
  } finally { restore(); }
  git(f.parent.path, 'clean', '-fdq');
  // gh is not there at all: the adopt goes on as before, on the default base
  restore = ghStub(f, `process.stderr.write('gh: not logged in'); process.exit(1);`);
  try {
    const r = await adoptLane('IDD-1', 'someone/child');
    assert.ok(!r.error, r.error); assert.equal(laneBaseOf('IDD-1').branch, 'main'); assert.match(r.baseNote ?? '', /gh/);
  } finally { restore(); }
});

test('intake --on checks its target before anything is taken in', async () => {
  const f = setup();
  assert.ok(!validateStackTarget({ lane: 'IDD-1' }).error);
  assert.match(validateStackTarget({ lane: 'IDD-99' }).error, /IDD-99/);
  event(f, 'IDD-3', 'lane_close', { outcome: 'aborted' });
  assert.ok(validateStackTarget({ lane: 'IDD-3' }).error);
  assert.ok(validateStackTarget({ branch: 'nobody/branch' }).error);
  assert.ok(!validateStackTarget({ branch: 'main' }).error);
});

test('a child on a parent that has no worktree yet waits, without cutting a branch', async () => {
  const f = setup();
  const set = await setLaneBase('IDD-2', { lane: 'IDD-3' }, 'manual'); assert.ok(!('error' in set), set.error);
  assert.throws(() => ensureLaneWorktree('demo', 'IDD-2'), /親の lane IDD-3/);
  assert.throws(() => git(f.work, 'rev-parse', '--verify', 'refs/heads/idd/IDD-2'));
});

// R5: the stage and the checkout's sessions are read again right before the branch moves
test('R5: a session that starts in the checkout while the merge is made stops the receive before the branch moves', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f); const before = git(lane.path, 'rev-parse', 'HEAD');
  put(join(f.parent.path, 'other.txt'), 'parent v2\n'); commit(f.parent.path); await publishParent(f);
  let calls = 0;
  setAgentRunner({ cwdBusy: () => { calls += 1; return calls > 1; } });
  try {
    const r = await receiveBase('IDD-2');
    assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, /session/);
    assert.equal(git(lane.path, 'rev-parse', 'HEAD'), before);
    assert.ok(!readLifecycle().some((e) => e.idd_id === 'IDD-2' && e.event === 'lane_base_received'));
  } finally { setAgentRunner(null); }
});

// ---------- blind 3 巡目 ----------

// M1: a receive moves HEAD off custody.workTree; with the submit stopped, the merged PR could neither close nor retire
test('M1: a lane waiting on its PR does not receive its base until the submit side is in, so the merged PR still closes', async () => {
  const f = setup();
  put(join(f.parent.path, 'mine.txt'), 'mine\n'); commit(f.parent.path); await publishParent(f);
  waitingOnPr(f, 'IDD-1');
  git(f.upstream, 'checkout', 'main'); git(f.upstream, 'pull', '--ff-only', 'origin', 'main'); put(join(f.upstream, 'other.txt'), 'upstream\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'main');
  const p = proposeImport('demo'); assert.ok(!p.error, p.error); const rv = await reviewImport('demo'); assert.equal(importUpstream('demo', rv.token).ok, true);
  const before = git(f.parent.path, 'rev-parse', 'HEAD');
  const r = await receiveBase('IDD-1');
  assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, /段 2/);
  assert.equal(git(f.parent.path, 'rev-parse', 'HEAD'), before);
  assert.equal(laneHasUnpublished('IDD-1'), false);
  assert.ok(!readLifecycle().some((e) => e.idd_id === 'IDD-1' && e.event === 'lane_base_received'));
});

test('M1: a lane that has published is refused a receive at any quiet stage, PR or not', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f);
  put(join(f.parent.path, 'other.txt'), 'parent v2\n'); commit(f.parent.path); await publishParent(f);
  // the child has taken on a public branch (custody) but is back at a card, with no PR on the ledger
  writeFileSync(custodyPath('IDD-2'), JSON.stringify({ branch: 'idd/IDD-2', publicTip: 'x', workTree: 'y', workHead: git(lane.path, 'rev-parse', 'HEAD') }));
  const r = await receiveBase('IDD-2');
  assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, /段 2/);
});

// S1: the CLI has no agent runtime, so a session at work in the checkout cannot be seen
test('S1: without the agent runtime the receive is refused, as the retire is', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f); const before = git(lane.path, 'rev-parse', 'HEAD');
  put(join(f.parent.path, 'other.txt'), 'parent v2\n'); commit(f.parent.path); await publishParent(f);
  setAgentRunner(null);
  const r = await receiveBase('IDD-2');
  assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, /session/);
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), before);
});

// S2: a prepared submit with its output commit made may have pushed; its retry must find the lane as approved
test('S2: a prepared submit whose output commit is made stops the receive and the stack as one in progress', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f); const before = git(lane.path, 'rev-parse', 'HEAD');
  put(join(f.parent.path, 'other.txt'), 'parent v2\n'); commit(f.parent.path); await publishParent(f);
  const inFlight = { status: 'prepared', outputCommit: before, expiresAt: new Date(Date.now() + 600_000).toISOString(), token: 't' };
  writeFileSync(proposalPath('IDD-2'), JSON.stringify(inFlight));
  const r = await receiveBase('IDD-2');
  assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, /push/);
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), before);
  // idd stack on a lane with such a submit (its worktree not cut, so nothing else stops it)
  writeFileSync(proposalPath('IDD-3'), JSON.stringify(inFlight));
  const s = await setLaneBase('IDD-3', { lane: 'IDD-1' }, 'manual');
  assert.match(s.error ?? '', /push/, JSON.stringify(s));
  assert.equal(laneBaseOf('IDD-3').parent, null);
});

// S3: a lane stacked before its worktree was cut cannot be cut once its parent ends; going back by hand is its way out
test('S3: a lane not cut yet goes back to the default base by hand after its parent ends, and is cut from the work branch', async () => {
  const f = setup();
  const set = await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  event(f, 'IDD-1', 'lane_close', { outcome: 'aborted' });
  assert.throws(() => ensureLaneWorktree('demo', 'IDD-2'), /stack/);
  // onto another lane it is still refused: only the way back is open
  assert.match((await setLaneBase('IDD-2', { lane: 'IDD-3' }, 'manual')).error ?? '', /終わ/);
  const back = await setLaneBase('IDD-2', { branch: 'main' }, 'manual');
  assert.ok(!('error' in back), back.error); assert.equal(back.parent, null); assert.equal(back.external, false);
  const lane = ensureLaneWorktree('demo', 'IDD-2');
  assert.equal(git(lane.path, 'rev-parse', 'HEAD'), git(f.work, 'rev-parse', 'work-main'));
});

// a receive prepared by an earlier adopt of another branch is what proposeImport hands back: the new PR's base
// must not be recorded against it, or custody (the earlier branch) and the base (the new PR's) disagree
test('an adopt of another branch while an earlier adopt is prepared is refused without recording the base', async () => {
  const f = setup();
  const third = ensureLaneWorktree('demo', 'IDD-3'); session(f.state, 'IDD-3', third);
  for (const name of ['someone/x', 'someone/y']) {
    git(f.upstream, 'checkout', '-b', name, 'main'); put(join(f.upstream, `${name.slice(8)}.txt`), `${name}\n`); commit(f.upstream); git(f.upstream, 'push', 'origin', name);
  }
  const restore = ghStub(f, `const head = process.argv[process.argv.indexOf('--head') + 1];
console.log(JSON.stringify(head === 'someone/y' ? [{number:8,baseRefName:'idd/IDD-3',url:'u'}] : []));`);
  try {
    const first = await adoptLane('IDD-1', 'someone/x');
    assert.ok(!first.error, first.error); assert.equal(first.remoteBranch, 'someone/x');
    const second = await adoptLane('IDD-1', 'someone/y');
    assert.match(second.error ?? '', /someone\/x/, JSON.stringify(second));
    assert.match(second.error ?? '', /cancel-receive IDD-1/);
    assert.equal(readLifecycle().filter((e) => e.idd_id === 'IDD-1' && e.event === 'lane_base_set').length, 0);
    assert.equal(laneBaseOf('IDD-1').branch, 'main');
  } finally { restore(); }
});

// ---------- 本線の取り込みの後の blind ----------

// must 1: an adopt that takes the PR's base (the public base) must not leave the parent's commits in a lane on it
test('adopting a branch whose PR goes to the public base is refused for a lane cut from its parent, and the base stays', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f);
  put(join(lane.path, 'child.txt'), 'child\n'); commit(lane.path);
  git(f.upstream, 'checkout', '-b', 'someone/child', 'main'); put(join(f.upstream, 'x.txt'), 'x\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'someone/child');
  const restore = ghStub(f, `console.log(JSON.stringify([{number:7,baseRefName:'main',url:'u'}]));`);
  try {
    const r = await adoptLane('IDD-2', 'someone/child');
    assert.match(r.error ?? '', /idd\/IDD-2/, JSON.stringify(r));
    assert.equal(laneBaseOf('IDD-2').parent, 'IDD-1');
  } finally { restore(); }
  // the base read from a PR and recorded straight away (adoptBaseFromPr) is refused the same way
  const set = await setLaneBase('IDD-2', { branch: 'main' }, 'adopt');
  assert.ok('error' in set, JSON.stringify(set));
  assert.equal(laneBaseOf('IDD-2').parent, 'IDD-1');
  assert.match((await propose('IDD-2', { title: 'feat: child', body: '' })).error ?? '', /段 2/);
});

// should 1: a submit that may have pushed is retried with its token; an adopt meanwhile would leave the lane stuck
test('an adopt is refused while a submit that may have pushed is in flight, and nothing is prepared for it', async () => {
  const f = setup();
  git(f.upstream, 'checkout', '-b', 'someone/x', 'main'); put(join(f.upstream, 'x.txt'), 'x\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'someone/x');
  writeFileSync(proposalPath('IDD-1'), JSON.stringify({ status: 'prepared', outputCommit: git(f.parent.path, 'rev-parse', 'HEAD'), expiresAt: new Date(Date.now() + 600_000).toISOString(), token: 't' }));
  const restore = ghStub(f, `console.log('[]');`);
  try {
    const r = await adoptLane('IDD-1', 'someone/x');
    assert.match(r.error ?? '', /push/, JSON.stringify(r));
    // nothing was prepared: once the submit is settled, an adopt of another branch is not refused for an earlier one
    writeFileSync(proposalPath('IDD-1'), JSON.stringify({ status: 'complete', token: 't' }));
    git(f.upstream, 'checkout', '-b', 'someone/y', 'main'); put(join(f.upstream, 'y.txt'), 'y\n'); commit(f.upstream); git(f.upstream, 'push', 'origin', 'someone/y');
    const again = await adoptLane('IDD-1', 'someone/y');
    assert.ok(!again.error, again.error); assert.equal(again.remoteBranch, 'someone/y');
  } finally { restore(); }
});

// the merge of Enhance-61: the card's approval (runShip) is the way a push goes out, and it is stopped for a stacked lane
test('a submit checked before the lane was stacked is not pushed by the card\'s approval', async () => {
  const f = setup();
  const lane = ensureLaneWorktree('demo', 'IDD-2'); session(f.state, 'IDD-2', lane); atGo(f, 'IDD-2');
  put(join(lane.path, 'child.txt'), 'child\n'); commit(lane.path);
  const p = await propose('IDD-2', { title: 'feat: child', body: '' }); assert.ok(!p.error, p.error);
  const set = await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  // the approval is taken only at the submit card, so the lane is there when its card is approved
  for (const e of ['s2_start', 's2_result', 's3_ready', 's3_ok', 's4_submit_started']) event(f, 'IDD-2', e);
  const { runShip } = await import('../src/plan/ship.ts');
  const r = await runShip('IDD-2', p.token, shipApproved('IDD-2', { commitMessage: 'feat: child', pr: { title: 'feat: child', body: 'body' } }));
  assert.equal(r.ok, false); assert.match(r.error ?? '', /段 2/);
  assert.ok(!readLifecycle().some((e) => e.idd_id === 'IDD-2' && e.event === 's4_push_approved'));
  assert.equal(git(f.remote, 'branch', '--list', 'idd/IDD-2'), '');
});

// nit: the stage and the checkout are checked and the branch moved while the lane gate is held, so a stage change
// (an executor started by the tick goes through the gate) comes before the check or after the move, never between
test('the receive checks the lane and moves its branch inside the lane gate', async () => {
  const f = setup();
  put(join(f.parent.path, 'app.txt'), 'parent v1\n'); commit(f.parent.path); await publishParent(f);
  const lane = await child(f); const before = git(lane.path, 'rev-parse', 'HEAD');
  put(join(f.parent.path, 'other.txt'), 'parent v2\n'); commit(f.parent.path); await publishParent(f);
  const { default: lockfile } = await import('proper-lockfile');
  const gate = join(f.state, 'lane-gate.lock'); writeFileSync(gate, '');
  const release = await lockfile.lock(gate, { stale: 5 * 60 * 1000 });
  process.env.IDD_LANE_GATE_WAIT_MS = '300';
  try {
    const r = await receiveBase('IDD-2');
    assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, /更新中/);
    assert.equal(git(lane.path, 'rev-parse', 'HEAD'), before);
    assert.ok(!readLifecycle().some((e) => e.idd_id === 'IDD-2' && e.event === 'lane_base_received'));
  } finally { await release(); delete process.env.IDD_LANE_GATE_WAIT_MS; }
  const again = await receiveBase('IDD-2'); assert.equal(again.ok, true, again.error); assert.equal(again.changed, true);
});

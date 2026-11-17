import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { assertLanded, assertReach, assertStays, atShip, batchSetup, carry, change, closeRunner, eventNames, git, laneTip, mainTip, moveMainline, OK, press, pressAndCarry, pressOk, put, reachable, shipLanes, waiting, waitFor } from './helpers/batch-fixture.mjs';
import { approveBatch, batchGroups, batchIdOf, batchOffers, batchPressLanes, landBatchContentFor, pressedGroup, readBatch, readBatchOffers } from '../src/overlay/batch.ts';
import { landBatchContent } from '../src/passkey.ts';
import { readLand } from '../src/overlay/land.ts';
import { readLandRounds, runningLandRuns } from '../src/overlay/land-run.ts';
import { driveBatch } from '../src/overlay/batch.ts';
import { join } from 'node:path';
import { runLand } from '../src/plan/land.ts';

/** three lanes at the submit confirmation, the batch card pressed for `keep` */
async function signedThree(keep) {
  const f = await threeLanes();
  closeRunner();
  const [group] = batchGroups();
  await pressOk(group, keep);
  return { f, group };
}
/** lanes under one required check of the repo's own, pressed and carried to the end */
async function failingCheck(changes, [name, command]) {
  const f = await shipLanes(changes, { checks: [{ name, command, required: true }] });
  closeRunner();
  return { f, ...(await pressAndCarry({ ms: 180_000 })) };
}
const threeLanes = (checks = OK) => shipLanes({ 'IDD-1': { 'app.txt': 'from one\n' }, 'IDD-2': { 'other.txt': 'from two\n' }, 'IDD-3': { 'third.txt': 'from three\n' } }, { checks });

test('AC-001: lanes waiting on one mainline are offered as one batch with each head, and a single lane is not', async () => {
  const f = batchSetup({ ids: ['IDD-1', 'IDD-2'] });
  change(f, 'IDD-1', { 'app.txt': 'from one\n' });
  await atShip('IDD-1');
  assert.deepEqual(batchOffers(), [], 'one lane is no batch');
  change(f, 'IDD-2', { 'other.txt': 'from two\n' });
  await atShip('IDD-2');
  const [group] = batchOffers();
  assert.equal(group.id, batchIdOf(group.repo, 'work-main', 'demo'));
  assert.deepEqual(group.lanes.map((l) => [l.iddId, l.head]), [['IDD-1', laneTip(f, 'IDD-1')], ['IDD-2', laneTip(f, 'IDD-2')]]);
  assert.equal(group.lanes[0].close.issue, 1);
});

test('the tick reads the groups for the cards, with the mainline tip of that moment', async () => {
  const f = await threeLanes();
  assert.deepEqual(readBatchOffers(), [], 'nothing before the tick reads');
  await runLand();
  const [group] = readBatchOffers();
  assert.deepEqual(group.lanes.map((l) => l.iddId), ['IDD-1', 'IDD-2', 'IDD-3']);
  assert.equal(group.mainTip, mainTip(f));
});

test('the signed content is the lanes left on the card, in order, with heads and closes, and no tip or merge commit', async () => {
  const f = await threeLanes();
  const [group] = batchGroups();
  const content = landBatchContentFor(group, ['IDD-1', 'IDD-3']);
  assert.equal(content.kind, 'land-batch');
  assert.deepEqual(content.lanes.map((l) => l.iddId), ['IDD-1', 'IDD-3']);
  assert.deepEqual(Object.keys(content).sort(), ['kind', 'lanes', 'repo', 'workBase']);
  assert.deepEqual(content, landBatchContent({
    repo: 'test/demo', workBase: 'work-main',
    lanes: [1, 3].map((n) => ({ iddId: `IDD-${n}`, head: laneTip(f, `IDD-${n}`), close: { repo: 'test/demo', issue: n, comment: group.lanes[n - 1].close.comment } })),
  }));
});

test('a press with a signature over other content is refused and starts nothing', async () => {
  await threeLanes();
  const [group] = batchGroups();
  const refused = await approveBatch({ batch: group.id, lanes: group.lanes.map((l) => ({ iddId: l.iddId, head: l.head, close: null })), nonce: 'nothing' });
  assert.equal(refused.ok, false);
  assert.equal(readBatch(group.id), null);
});

test('AC-002 / AC-003: leaving one lane off, the rest go in under one check of the last tree and the one left off stays', async () => {
  const f = await threeLanes();
  closeRunner();
  const tip = mainTip(f);
  const { group, b } = await pressAndCarry({ keep: ['IDD-1', 'IDD-3'] });
  assertLanded(b);
  const now = mainTip(f);
  assert.notEqual(now, tip);
  assertReach(f, ['IDD-1', 'IDD-3'], ['IDD-2']);
  assert.equal(git(f.work, 'show', 'work-main:app.txt'), 'from one');
  assert.equal(git(f.work, 'show', 'work-main:third.txt'), 'from three');
  assert.equal(git(f.work, 'show', 'work-main:other.txt'), 'one');
  // the mainline went to the one tree the one check read: the last commit of the chain, laid on the earlier step
  assert.equal(now, b.mergeCommit);
  assert.equal(git(f.work, 'rev-parse', `${now}^2`), laneTip(f, 'IDD-3'));
  assert.equal(git(f.work, 'rev-parse', `${now}^1`), b.chain[0].commit);
  assert.equal(git(f.work, 'rev-parse', `${b.chain[0].commit}^1`), tip);
  // the check ran once, on that tree, and the records say so
  const rounds = readLandRounds(group.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].mergeCommit, now);
  assert.equal(rounds[0].status, 'done');
  assert.equal(readLand('IDD-1').batch.runId, b.checked.runId);
  assert.equal(readLand('IDD-3').batch.mergeCommit, now);
  // the lane left off is still waiting, with no approval written for it
  assert.equal(eventNames('IDD-2').includes('s4_land_approved'), false);
  assert.equal(eventNames('IDD-2').includes('lane_close'), false);
  assert.deepEqual(waiting(), ['IDD-2']);
});

test('a mainline tip that moved after the signature is met by checking again at the new tip, with no second signature', async () => {
  const { f, group } = await signedThree();
  const first = readBatch(group.id);
  moveMainline(f, { 'moved.txt': 'main moved\n' });
  const moved = mainTip(f);
  assert.notEqual(moved, first.mainTip);
  const b = await carry(group.id);
  assertLanded(b);
  assert.equal(b.mainTip, moved);
  assert.equal(b.mergeCommit, mainTip(f));
  assertReach(f, f.ids);
  assert.equal(git(f.work, 'show', 'work-main:moved.txt'), 'main moved');
});

test('a lane whose head moved after the signature is left out of the batch and stays on its own card', async () => {
  const { f, group } = await signedThree();
  change(f, 'IDD-2', { 'other.txt': 'from two again\n' }, 'feat: more');
  assertLanded(await carry(group.id), [['IDD-2', 'moved']]);
  assert.equal(eventNames('IDD-2').includes('s4_land_batch_dropped'), true);
  assertStays(f, 'IDD-2');
  assert.deepEqual(waiting(), ['IDD-2']);
});

test('a failing check names the lane it fails at by narrowing the prefixes; the rest land and the failing lane stays', async () => {
  // the check fails whenever bad.txt is in the tree
  const { f, group, b } = await failingCheck({ 'IDD-1': { 'a.txt': 'a\n' }, 'IDD-2': { 'bad.txt': 'bad\n' }, 'IDD-3': { 'c.txt': 'c\n' } }, ['no-bad', 'test ! -e bad.txt']);
  assertLanded(b, [['IDD-2', 'check']]);
  assert.match(b.dropped[0].reason, /no-bad/);
  assertReach(f, ['IDD-1', 'IDD-3'], ['IDD-2']);
  assert.throws(() => git(f.work, 'show', 'work-main:bad.txt'));
  // the last check ran on the chain without the failing lane, and that is the tree that went in
  assert.equal(readLandRounds(group.id).at(-1).mergeCommit, mainTip(f));
  assertStays(f, 'IDD-2');
});

test('a lane a later lane repairs is not left out for the failure of another: the failure is traced from the end of the chain', async () => {
  // bad.txt fails unless fix.txt is there too; c-bad.txt fails always
  const { f, b } = await failingCheck({ 'IDD-1': { 'bad.txt': 'bad\n' }, 'IDD-2': { 'fix.txt': 'fix\n' }, 'IDD-3': { 'c-bad.txt': 'bad\n' } }, ['repairable', '(test ! -e bad.txt || test -e fix.txt) && test ! -e c-bad.txt']);
  assertLanded(b, [['IDD-3', 'check']]);
  // the lane the prefix check blamed is kept: the next lane repairs it
  assertReach(f, ['IDD-1', 'IDD-2'], ['IDD-3']);
  assert.equal(b.suspect, undefined);
});

test('a press signs the heads the card showed: a lane that moved since the card is signed at the shown head and dropped, never landed', async () => {
  const f = await threeLanes();
  closeRunner();
  const [card] = batchGroups();
  const shown = laneTip(f, 'IDD-2');
  // the lane moves after the card was drawn and before the press
  change(f, 'IDD-2', { 'other.txt': 'from two again\n' }, 'feat: unseen');
  const unseen = laneTip(f, 'IDD-2');
  assert.notEqual(shown, unseen);
  await pressOk(card);
  assert.equal(readBatch(card.id).approved.find((l) => l.iddId === 'IDD-2').head, shown, 'the signature is over the head the card showed');
  const b = await carry(card.id);
  assertLanded(b, [['IDD-2', 'moved']]);
  assertReach(f, ['IDD-1', 'IDD-3'], ['IDD-2']);
  assert.throws(() => git(f.work, 'merge-base', '--is-ancestor', unseen, mainTip(f)), 'the head nobody saw is not on the mainline');
  assert.equal(eventNames('IDD-2').includes('s4_land_approved'), false);
});

test('a press that carries no heads, or only lanes that moved since the card, is refused and records nothing', async () => {
  const f = await threeLanes();
  const [card] = batchGroups();
  assert.equal(batchPressLanes(['IDD-1']), null, 'a bare id carries no head');
  assert.equal(pressedGroup(card, batchPressLanes(['IDD-1'])).ok, false);
  assert.equal(batchPressLanes([{ iddId: 'IDD-1', head: card.lanes[0].head }]), null, 'a lane that leaves its close out is not one a card made');
  const bare = await approveBatch({ batch: card.id, lanes: batchPressLanes(['IDD-1']), nonce: 'nothing' });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /head/);
  // every lane the card showed has moved: the card is read again
  for (const id of f.ids) change(f, id, { [`${id}.txt`]: 'more\n' }, 'feat: more');
  const stale = await press(approveBatch, card);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /読み直して/);
  assert.equal(readBatch(card.id), null);
});

test('a check that began before the repo\'s checks changed is not the result for the tree: it is checked again under the new ones', async () => {
  const { f, group } = await signedThree();
  await waitFor(() => runningLandRuns().length === 0);
  assert.equal(readBatch(group.id).phase, 'checking');
  // a required check is added while the first check's result waits to be read
  const areas = join(f.root, 'repos.yaml');
  const config = JSON.parse(readFileSync(areas, 'utf8'));
  config.repos.demo.checks = [...config.repos.demo.checks, { name: 'added', command: 'true', required: true }];
  put(areas, JSON.stringify(config));
  const tip = mainTip(f);
  await driveBatch(group.id);
  assert.equal(mainTip(f), tip, 'the old result moved nothing');
  const b = await carry(group.id);
  assert.equal(b.phase, 'landed', JSON.stringify(b));
  assert.equal(readLandRounds(group.id).length, 2, 'the tree was checked again');
  assert.ok(readLand(group.id).checks.some((c) => c.name === 'added'), 'the check added is in the result the landing rests on');
});

test('a press signs the Issue close the card showed: a lane whose close changed since is dropped, and the close read now is never posted', async () => {
  const f = await threeLanes();
  const posted = closeRunner();
  const [card] = batchGroups();
  // IDD-2 is tied to another Issue by the time the press is made
  const backlog = join(f.state, 'backlog.jsonl');
  put(backlog, readFileSync(backlog, 'utf8').replace('issues/2', 'issues/99'));
  const [now] = batchGroups();
  assert.equal(now.lanes[1].close.issue, 99);
  const shown = batchPressLanes(card.lanes.map((l) => ({ iddId: l.iddId, head: l.head, close: { repo: l.close.repo, issue: l.close.issue, comment: l.close.comment } })));
  const pressedNow = pressedGroup(now, shown);
  assert.equal(pressedNow.ok, true);
  assert.deepEqual(landBatchContentFor(pressedNow.group), landBatchContentFor(card), 'the challenge is over the close the card showed, not the one read now');
  await pressOk(card);
  assert.equal(readBatch(card.id).approved.find((l) => l.iddId === 'IDD-2').close.issue, 2, 'the record keeps the close that was signed');
  const b = await carry(card.id);
  assertLanded(b, [['IDD-2', 'moved']]);
  assert.match(b.dropped[0].reason, /close/);
  assert.equal(reachable(f, 'IDD-2'), false);
  assert.deepEqual(posted.map((p) => p.target.issue).sort(), [1, 3], 'no Issue the card did not show is closed');
});

test('a close the card did not show is not signed when the repo turns the signed close on afterwards', async () => {
  const f = await shipLanes({ 'IDD-1': { 'app.txt': 'from one\n' }, 'IDD-2': { 'other.txt': 'from two\n' } }, { extra: { land: { close_issue: false } } });
  const [card] = batchGroups();
  assert.equal(card.lanes[0].close, undefined, 'the card shows no close');
  const areas = join(f.root, 'repos.yaml');
  const config = JSON.parse(readFileSync(areas, 'utf8'));
  config.repos.demo.land = { close_issue: true };
  put(areas, JSON.stringify(config));
  const [now] = batchGroups();
  assert.ok(now.lanes[0].close, 'the close is on now');
  const pressedNow = pressedGroup(now, batchPressLanes(card.lanes.map((l) => ({ iddId: l.iddId, head: l.head, close: null }))));
  assert.equal(pressedNow.ok, false, 'every lane changed since the card: the card is read again');
  assert.match(pressedNow.error, /読み直して/);
  assert.equal(landBatchContentFor(card).lanes.every((l) => l.close === null), true);
});

test('lanes of two areas on one mainline are two batches, each checked under its own area', async () => {
  const f = batchSetup({ ids: ['IDD-1', 'IDD-2', 'IDD-3', 'IDD-4'], checks: [{ name: 'ok', command: 'true', required: true }] });
  // IDD-3 and IDD-4 belong to a second area that shares the work clone and its mainline, and requires a check that fails
  const areas = join(f.root, 'repos.yaml');
  const config = JSON.parse(readFileSync(areas, 'utf8'));
  config.repos.other = { ...config.repos.demo, checks: [{ name: 'strict', command: 'false', required: true }] };
  put(areas, JSON.stringify(config));
  const backlog = join(f.state, 'backlog.jsonl');
  put(backlog, readFileSync(backlog, 'utf8').split('\n').filter(Boolean).map((line) => {
    const r = JSON.parse(line);
    return JSON.stringify(r.idd_id === 'IDD-3' || r.idd_id === 'IDD-4' ? { ...r, area: 'other' } : r);
  }).join('\n') + '\n');
  for (const id of f.ids) {
    change(f, id, { [`${id}.txt`]: `${id}\n` });
    await atShip(id);
  }
  const groups = batchGroups();
  assert.equal(groups.length, 2, 'the same repo and branch, two areas: two batches');
  assert.notEqual(groups[0].id, groups[1].id);
  assert.deepEqual(groups.map((g) => [g.area, g.lanes.map((l) => l.iddId)]), [['demo', ['IDD-1', 'IDD-2']], ['other', ['IDD-3', 'IDD-4']]]);
  closeRunner();
  const strict = groups.find((g) => g.area === 'other');
  const tip = mainTip(f);
  const pressed = await press(approveBatch, strict);
  assert.equal(pressed.ok, true, pressed.error);
  const b = await carry(strict.id, 120_000);
  assert.equal(mainTip(f), tip, 'the area\'s required check failed, so nothing of it went in');
  assert.equal(b.phase, 'stopped', JSON.stringify(b));
  assert.equal(reachable(f, 'IDD-3'), false);
  assert.equal(reachable(f, 'IDD-4'), false);
});

const recordsCheck = (name, command) => ({ name, command, required: true, scope: 'records' });

test('a records check of the batch is run for each lane with that lane\'s id, and a public check is told no lane', async () => {
  const f = await shipLanes({ 'IDD-1': { 'app.txt': 'from one\n' }, 'IDD-2': { 'other.txt': 'from two\n' } }, {
    checks: [
      { name: 'ok', command: 'test -z "${IDD_ID:-}"', required: true },
      recordsCheck('recs', 'case "$IDD_ID" in IDD-1|IDD-2) exit 0;; *) echo "not a lane: $IDD_ID" >&2; exit 1;; esac'),
    ],
  });
  closeRunner();
  const { group, b } = await pressAndCarry();
  assertLanded(b);
  // the public check ran once; the records check ran once for each lane, and each lane's record keeps its own
  assert.equal(readLandRounds(group.id).length, 1);
  const names = readLandRounds(group.id)[0].checks.map((c) => c.name);
  assert.deepEqual(names.filter((n) => n === 'ok'), ['ok']);
  assert.deepEqual(names.filter((n) => n.startsWith('recs')).sort(), ['recs（IDD-1）', 'recs（IDD-2）']);
  assert.deepEqual(readLand('IDD-1').checks.map((c) => c.name), ['ok', 'recs（IDD-1）']);
  assert.deepEqual(readLand('IDD-2').checks.map((c) => c.name), ['ok', 'recs（IDD-2）']);
  assertReach(f, f.ids);
});

test('a required records check that fails for one lane\'s records leaves that lane out without a search, and the rest land', async () => {
  const f = await threeLanes([...OK, recordsCheck('recs', 'test "$IDD_ID" != IDD-2 || { echo "IDD-2 の記録が通りません" >&2; exit 1; }')]);
  closeRunner();
  const { group, b } = await pressAndCarry();
  assertLanded(b, [['IDD-2', 'check']]);
  assert.match(b.dropped[0].reason, /IDD-2 の記録が通りません/);
  assertReach(f, ['IDD-1', 'IDD-3'], ['IDD-2']);
  // the failing run and the one over the lanes that stand: two checks, not a bisection
  assert.equal(readLandRounds(group.id).length, 2);
});

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { it } from 'node:test';

import { batchSetup, change, git, laneTip, put } from '../../../idd-core/test/helpers/batch-fixture.mjs';
register('./idd-core-alias.loader.mjs', import.meta.url);

const { buildState } = await import('./state.ts');
const { batchGroups, landBatchContentFor, refreshBatchOffers, saveBatchForTests } = await import('../../../idd-core/src/overlay/batch.ts');
const { snoozeKey } = await import('../../../../lib/idd-ui/snooze.ts');

/** the tick's reading of the groups, then the state: the state reads what the tick took and does no git reading of its own */
const fresh = () => { refreshBatchOffers(); return buildState(); };

/** the batch cards of a built state */
const batchCards = (state) => state.items.filter((i) => i.kind === 'land-batch');

const ev = (iddId, event, attrs = {}) => ({ idd_id: iddId, event, at: '2026-09-25T00:00:00Z', attrs });

/** the lanes named are closed in the ledger, the others stay at the submit confirmation */
function closeLanes(closed, open) {
  const rows = [...closed, ...open].flatMap((id) => [
    ev(id, 'lane_open'), ev(id, 's2_start'), ev(id, 's2_result'), ev(id, 's3_ready'), ev(id, 's3_ok'), ev(id, 's4_submit_started'), ...(closed.includes(id) ? [ev(id, 'lane_close')] : []),
  ]);
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lifecycle-demo.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** lanes of one work clone, each at the submit confirmation with a change of its own */
function cards(ids) {
  const f = batchSetup({ ids });
  for (const id of ids) change(f, id, { [`${id}.txt`]: `from ${id}\n` });
  closeLanes([], ids);
  return { work: f.work, lanes: Object.fromEntries(ids.map((id) => [id, f.lanes[id].path])), heads: Object.fromEntries(ids.map((id) => [id, laneTip(f, id)])) };
}

it('AC-001: two or more lanes waiting on one mainline get one batch card beside their own cards, with each head', () => {
  const f = cards(['IDD-1', 'IDD-2', 'IDD-3']);
  const items = fresh().items;
  const batch = items.filter((i) => i.kind === 'land-batch');
  assert.equal(batch.length, 1, 'one card for the mainline');
  assert.deepEqual(batch[0].lanes.map((l) => [l.iddId, l.head]), [['IDD-1', f.heads['IDD-1']], ['IDD-2', f.heads['IDD-2']], ['IDD-3', f.heads['IDD-3']]]);
  assert.equal(batch[0].workBase, 'work-main');
  assert.equal(batch[0].repo, f.work);
  assert.equal(batch[0].lanes[0].close.issue, 1);
  assert.equal(batch[0].running, undefined);
  // the lanes keep their own cards: a lane can still be signed alone
  assert.deepEqual(items.filter((i) => i.kind === 'ship').map((i) => i.iddId), ['IDD-1', 'IDD-2', 'IDD-3']);
  // the card's key does not collide with any lane's
  assert.equal(new Set(items.map((i) => `${i.kind}:${i.iddId}`)).size, items.length);
});

it('AC-001: one lane alone gets no batch card', () => {
  cards(['IDD-1']);
  assert.deepEqual(batchCards(fresh()), []);
});

it('the batch card offers exactly the lanes the signature is built over', () => {
  const f = cards(['IDD-1', 'IDD-2']);
  const [item] = batchCards(fresh());
  const [group] = batchGroups();
  assert.deepEqual(group.lanes.map((l) => l.iddId), item.lanes.map((l) => l.iddId));
  const content = landBatchContentFor(group, ['IDD-2']);
  assert.deepEqual(content.lanes.map((l) => [l.iddId, l.head]), [['IDD-2', f.heads['IDD-2']]]);
});

it('a signed batch under way is shown as running and offers no signature; one that ended shows what it left out', () => {
  const f = cards(['IDD-1', 'IDD-2']);
  const [group] = batchGroups();
  const base = { landed: undefined, conversions: [] };
  saveBatchForTests(endedBatch(group, { ...base, phase: 'checking' }));
  const running = fresh().items.find((i) => i.kind === 'land-batch');
  assert.equal(running.running.phase, 'checking');
  assert.deepEqual(running.lanes.map((l) => l.iddId), ['IDD-1', 'IDD-2']);
  saveBatchForTests(endedBatch(group, {
    ...base, phase: 'landed', lanes: ['IDD-1'],
    dropped: [{ iddId: 'IDD-2', kind: 'conflict', reason: '本流と衝突します（app.txt）', at: '2026-10-27T00:00:00Z' }],
    conversions: [{ iddId: 'IDD-1', kind: 'resolved', files: [{ path: 'app.txt', diff: '+x' }], rationale: '両方残す', at: '2026-10-27T00:00:00Z' }],
  }));
  const after = fresh().items.find((i) => i.kind === 'land-batch');
  assert.equal(after.running, undefined);
  assert.deepEqual(after.last.dropped, [{ iddId: 'IDD-2', kind: 'conflict', reason: '本流と衝突します（app.txt）' }]);
  assert.equal(after.last.conversions[0].files[0].path, 'app.txt');
  void f;
});

/** a signed batch as a pass would leave it once it ended */
function endedBatch(group, over) {
  return {
    id: group.id, repo: group.repo, workBase: group.workBase, area: group.area,
    approved: group.lanes.map((l) => ({ iddId: l.iddId, head: l.head, branch: l.branch, title: l.title })),
    approvedAt: '2026-10-27T00:00:00Z', lanes: group.lanes.map((l) => l.iddId), dropped: [], mainTip: '', chain: [], retries: 0,
    phase: 'landed', landed: { at: '2026-10-27T01:00:00Z', mergeCommit: 'abc', lanes: group.lanes.map((l) => l.iddId), done: group.lanes.map((l) => l.iddId) },
    conversions: [{ iddId: 'IDD-2', kind: 'resolved', files: [{ path: 'app.txt', diff: '-<<<<<<<\n+from two' }], rationale: 'app.txt: 足す行が別', at: '2026-10-27T01:00:00Z' }],
    ...over,
  };
}

/** two lanes at the confirmation and the record a signed batch left; the lanes in `closed` are closed in the ledger by now */
function afterBatch(over, closed = ['IDD-1', 'IDD-2']) {
  cards(['IDD-1', 'IDD-2']);
  const [group] = batchGroups();
  closeLanes(closed, ['IDD-1', 'IDD-2'].filter((id) => !closed.includes(id)));
  saveBatchForTests(endedBatch(group, over));
  return group;
}

it('a snooze is tied to the batch it was made on: the card carries when its lanes last changed, so a later batch has another key', () => {
  cards(['IDD-1', 'IDD-2']);
  const [first] = batchCards(fresh());
  assert.equal(first.appearedAt, '2026-09-25T00:00:00Z', 'the latest of the lanes to come to the confirmation');
  const [group] = batchGroups();
  // a signed batch ended, and its outcome rides on the card of the lanes that wait again: the card is a new one
  saveBatchForTests(endedBatch(group, {}));
  const [second] = batchCards(fresh());
  assert.equal(second.appearedAt, '2026-10-27T01:00:00Z');
  assert.notEqual(snoozeKey(first), snoozeKey(second));
});

it('after the last lane landed the batch card stays for a day with the diff and the grounds of what was converted, and offers no signature', () => {
  const group = afterBatch({});
  const near = new Date('2026-10-27T12:00:00Z');
  const [card] = batchCards(buildState({ now: near }));
  assert.ok(card, 'the card is still there');
  assert.equal(card.settled, true);
  assert.deepEqual(card.lanes, []);
  assert.equal(card.appearedAt, '2026-10-27T01:00:00Z');
  assert.equal(card.last.conversions[0].files[0].diff, '-<<<<<<<\n+from two');
  assert.equal(card.last.conversions[0].rationale, 'app.txt: 足す行が別');
  assert.deepEqual(card.last.landed, ['IDD-1', 'IDD-2']);
  const later = new Date('2026-10-29T00:00:00Z');
  assert.deepEqual(batchCards(buildState({ now: later })), [], 'a day later it is gone');
  // a batch that converted and dropped nothing leaves no card
  saveBatchForTests(endedBatch(group, { conversions: [] }));
  assert.deepEqual(batchCards(buildState({ now: near })), []);
});

it('a batch that stopped with nothing landed says it stopped, not that lanes were taken in', () => {
  const group = afterBatch({
    phase: 'stopped', landed: undefined, reason: '取り込める lane が残りませんでした', conversions: [],
    dropped: [{ iddId: 'IDD-1', kind: 'conflict', reason: '本流と衝突します', at: '2026-10-27T01:00:00Z' }],
  });
  const [card] = batchCards(buildState({ now: new Date('2026-10-27T12:00:00Z') }));
  assert.equal(card.settled, true);
  assert.match(card.title, /止めた/);
  assert.doesNotMatch(card.title, /取り込んだ|0 本/);
  assert.equal(card.last.reason, '取り込める lane が残りませんでした');
  // one that did land keeps saying how many went in
  saveBatchForTests(endedBatch(group, {}));
  const [landed] = batchCards(buildState({ now: new Date('2026-10-27T12:00:00Z') }));
  assert.match(landed.title, /取り込んだ（2 本）/);
});

it('with one lane left waiting, the lane the last batch left out and its reason are still on a card, and that card offers no signature', () => {
  afterBatch({
    conversions: [],
    dropped: [{ iddId: 'IDD-2', kind: 'conflict', reason: '本流と衝突します（app.txt）', at: '2026-10-27T01:00:00Z' }],
    landed: { at: '2026-10-27T01:00:00Z', mergeCommit: 'abc', lanes: ['IDD-1'], done: ['IDD-1'] },
  }, ['IDD-1']);
  const cardsOf = batchCards(buildState({ now: new Date('2026-10-27T12:00:00Z') }));
  assert.equal(cardsOf.length, 1);
  assert.equal(cardsOf[0].settled, true);
  assert.deepEqual(cardsOf[0].lanes, []);
  assert.deepEqual(cardsOf[0].last.dropped.map((d) => [d.iddId, d.reason]), [['IDD-2', '本流と衝突します（app.txt）']]);
  assert.deepEqual(cardsOf[0].last.landed, ['IDD-1']);
});

it('a signed batch under way is on a card while no lane of it waits any more, with the lanes it left out so far', () => {
  afterBatch({
    phase: 'closing', conversions: [], lanes: ['IDD-1'],
    dropped: [{ iddId: 'IDD-2', kind: 'check', reason: '検査が落ちました', at: '2026-10-27T01:00:00Z' }],
    landed: { at: '2026-10-27T01:00:00Z', mergeCommit: 'abc', lanes: ['IDD-1'], done: [] },
  });
  const found = batchCards(fresh());
  assert.equal(found.length, 1);
  assert.equal(found[0].running.phase, 'closing');
  assert.deepEqual(found[0].lanes.map((l) => l.iddId), ['IDD-1']);
  assert.deepEqual(found[0].last.dropped.map((d) => d.iddId), ['IDD-2']);
});

it('the state reads the groups the tick took and reads no checkout: a lane that moved is told by the next tick, not by the state', () => {
  const f = cards(['IDD-1', 'IDD-2']);
  assert.deepEqual(batchCards(buildState()), [], 'before the tick has read anything, no card');
  const [first] = batchCards(fresh());
  put(join(f.lanes['IDD-1'], 'later.txt'), 'later\n');
  git(f.lanes['IDD-1'], 'add', '.');
  git(f.lanes['IDD-1'], 'commit', '-qm', 'feat: later');
  const [again] = batchCards(buildState());
  assert.deepEqual(again.lanes.map((l) => l.head), first.lanes.map((l) => l.head), 'the state did not read the moved head');
  const [after] = batchCards(fresh());
  assert.notEqual(after.lanes[0].head, first.lanes[0].head, 'the tick reads it again');
});

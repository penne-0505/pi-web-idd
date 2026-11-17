import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  moveInStartOrder, orderStartLanes, readStartOrder, setUrgent, startOrderPath, startOrderView,
} from '../src/ledger/start-order.ts';
import { tmpDir } from './helpers/tmp.mjs';

const IDS = ['IDD-001', 'IDD-002', 'IDD-003', 'IDD-004'];

/** the row of a lane in the state's backlog, with the intake time the test gives it (undefined leaves the key out) */
function backlogRow(id, i, created = `2026-09-25T0${i}:00:00+09:00`) {
  return {
    idd_id: id, parent_id: null, ...(created === undefined ? {} : { created_at: created }),
    linear_issue_url: null, gh_issue_url: `https://github.com/o/r/issues/${i + 1}`, pull_req_url: null,
    source_type: 'github', context: '', title: `T ${id}`, area: 'demo',
  };
}

/** a state with the four open lanes, whose intake times follow their order unless the test says otherwise */
function setup({ ids = IDS, created = {}, rows } = {}) {
  const dir = tmpDir('idd-start-order-');
  process.env.IDD_STATE_DIR = dir;
  const list = rows ?? ids.map((id, i) => backlogRow(id, i, id in created ? created[id] : `2026-09-25T0${i}:00:00+09:00`));
  writeFileSync(join(dir, 'backlog.jsonl'), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'lifecycle-demo.jsonl'), '');
  return dir;
}

/** an event on the demo lifecycle, appended the way the harness appends */
function at(dir, iddId, event, attrs = {}) {
  appendFileSync(join(dir, 'lifecycle-demo.jsonl'), `${JSON.stringify({ event, idd_id: iddId, at: '2026-09-25T10:00:00+09:00', attrs })}\n`, 'utf8');
}

const viewIds = () => {
  const res = startOrderView();
  assert.equal(res.ok, true);
  return res.lanes.map((l) => l.idd_id);
};

/** the appended lines, read straight off the state's file */
function orderLines() {
  const path = startOrderPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

test('AC-001: moving a lane makes the reader return that order', async () => {
  setup();
  assert.deepEqual(viewIds(), IDS);

  // before
  let res = await moveInStartOrder({ idd_id: 'IDD-004', before: 'IDD-002' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.lanes.map((l) => l.idd_id), ['IDD-001', 'IDD-004', 'IDD-002', 'IDD-003']);
  // read back from the file, as a restarted engine would
  assert.deepEqual(viewIds(), ['IDD-001', 'IDD-004', 'IDD-002', 'IDD-003']);
  assert.deepEqual(readStartOrder().order, ['IDD-001', 'IDD-004', 'IDD-002', 'IDD-003']);

  // after
  await moveInStartOrder({ idd_id: 'IDD-001', after: 'IDD-003' });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-002', 'IDD-003', 'IDD-001']);

  // position: the head, the middle, the tail, and past the tail (all appended to the tail)
  await moveInStartOrder({ idd_id: 'IDD-001', position: 1 });
  assert.deepEqual(viewIds(), ['IDD-001', 'IDD-004', 'IDD-002', 'IDD-003']);
  await moveInStartOrder({ idd_id: 'IDD-001', position: 3 });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-002', 'IDD-001', 'IDD-003']);
  await moveInStartOrder({ idd_id: 'IDD-001', position: 4 });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-002', 'IDD-003', 'IDD-001']);
  await moveInStartOrder({ idd_id: 'IDD-001', position: 99 });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-002', 'IDD-003', 'IDD-001']);
  assert.deepEqual(readStartOrder().order, ['IDD-004', 'IDD-002', 'IDD-003', 'IDD-001']);
});

test('AC-002: an unplaced lane follows by when it was taken in, and a later lane goes to the tail', async () => {
  setup({ created: { 'IDD-001': '2026-09-25T03:00:00+09:00', 'IDD-002': '2026-09-25T01:00:00+09:00', 'IDD-003': '2026-09-25T02:00:00+09:00', 'IDD-004': '2026-09-25T00:00:00+09:00' } });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-002', 'IDD-003', 'IDD-001']);

  await moveInStartOrder({ idd_id: 'IDD-003', before: 'IDD-001' });
  // a lane taken in later, but with the earliest time of all: it is not placed, so it follows the placed ones
  appendFileSync(join(process.env.IDD_STATE_DIR, 'backlog.jsonl'), `${JSON.stringify(backlogRow('IDD-005', 4, '2026-09-24T00:00:00+09:00'))}\n`, 'utf8');
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-002', 'IDD-003', 'IDD-001', 'IDD-005']);
});

test('AC-002: equal intake times and rows without one both keep the backlog row order, without throwing', () => {
  const rows = [
    backlogRow('IDD-001', 0, '2026-09-25T01:00:00+09:00'),
    backlogRow('IDD-002', 1, '2026-09-25T01:00:00+09:00'),
    backlogRow('IDD-003', 2, undefined),
    backlogRow('IDD-004', 3, undefined),
  ];
  setup({ rows });
  assert.doesNotThrow(() => startOrderView());
  assert.deepEqual(viewIds(), ['IDD-001', 'IDD-002', 'IDD-003', 'IDD-004']);
  // the pure function is stable the same way
  const sorted = orderStartLanes(rows, { order: [], urgent: [] });
  assert.deepEqual(sorted.map((r) => r.idd_id), ['IDD-001', 'IDD-002', 'IDD-003', 'IDD-004']);
});

test('AC-003: an urgent lane comes before the lanes that are not urgent', async () => {
  setup();
  const res = await setUrgent({ idd_id: 'IDD-004', urgent: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.lanes.map((l) => l.idd_id), ['IDD-004', 'IDD-001', 'IDD-002', 'IDD-003']);
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-001', 'IDD-002', 'IDD-003']);
  assert.equal(res.lanes[0].urgent, true);
  assert.equal(res.lanes[1].urgent, false);
});

test('AC-004: urgent lanes are ordered by the one order, and can be swapped there', async () => {
  setup();
  await setUrgent({ idd_id: 'IDD-004', urgent: true });
  await setUrgent({ idd_id: 'IDD-002', urgent: true });
  assert.deepEqual(viewIds(), ['IDD-002', 'IDD-004', 'IDD-001', 'IDD-003']);

  // swapped by before
  await moveInStartOrder({ idd_id: 'IDD-004', before: 'IDD-002' });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-002', 'IDD-001', 'IDD-003']);

  // swapped by position: A, B, C, D with C and D urgent; C to position 2 gives D, C, A, B
  setup();
  await setUrgent({ idd_id: 'IDD-003', urgent: true });
  await setUrgent({ idd_id: 'IDD-004', urgent: true });
  assert.deepEqual(viewIds(), ['IDD-003', 'IDD-004', 'IDD-001', 'IDD-002']);
  await moveInStartOrder({ idd_id: 'IDD-003', position: 2 });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-003', 'IDD-001', 'IDD-002']);

  // a lane that is not urgent moved to position 1 stays just after the urgent lanes
  await moveInStartOrder({ idd_id: 'IDD-001', position: 1 });
  assert.deepEqual(viewIds(), ['IDD-004', 'IDD-003', 'IDD-001', 'IDD-002']);
});

test('AC-005: clearing the mark returns the lane to its placed position', async () => {
  setup();
  await moveInStartOrder({ idd_id: 'IDD-003', position: 3 });
  await setUrgent({ idd_id: 'IDD-003', urgent: true });
  assert.deepEqual(viewIds(), ['IDD-003', 'IDD-001', 'IDD-002', 'IDD-004']);
  await setUrgent({ idd_id: 'IDD-003', urgent: false });
  assert.deepEqual(viewIds(), ['IDD-001', 'IDD-002', 'IDD-003', 'IDD-004']);
});

test('AC-012: a closed lane, an unknown lane, a self reference or a bad position is refused, and nothing is written', async () => {
  const dir = setup();
  at(dir, 'IDD-004', 'lane_close', { outcome: 'aborted' });
  const before = orderLines().length;

  for (const [label, res] of [
    ['unknown lane', await moveInStartOrder({ idd_id: 'IDD-999', position: 1 })],
    ['closed lane', await moveInStartOrder({ idd_id: 'IDD-004', position: 1 })],
    ['self as before', await moveInStartOrder({ idd_id: 'IDD-001', before: 'IDD-001' })],
    ['self as after', await moveInStartOrder({ idd_id: 'IDD-001', after: 'IDD-001' })],
    ['closed reference', await moveInStartOrder({ idd_id: 'IDD-001', before: 'IDD-004' })],
    ['position zero', await moveInStartOrder({ idd_id: 'IDD-001', position: 0 })],
    ['position not an integer', await moveInStartOrder({ idd_id: 'IDD-001', position: 1.5 })],
    ['two bases', await moveInStartOrder({ idd_id: 'IDD-001', before: 'IDD-002', position: 1 })],
    ['no base', await moveInStartOrder({ idd_id: 'IDD-001' })],
    ['urgent on unknown', await setUrgent({ idd_id: 'IDD-999', urgent: true })],
    ['urgent on closed', await setUrgent({ idd_id: 'IDD-004', urgent: true })],
  ]) {
    assert.equal(res.ok, false, label);
    assert.equal(typeof res.error, 'string', label);
    assert.ok(res.error.length > 0, label);
  }
  assert.equal(orderLines().length, before, 'a refusal writes nothing');

  for (const end of ['lane_close', 's1_defer', 's3_defer']) {
    const closed = setup();
    at(closed, 'IDD-002', end, {});
    const refused = await setUrgent({ idd_id: 'IDD-002', urgent: true });
    assert.equal(refused.ok, false, end);
    assert.equal(orderLines().length, 0, end);
  }
});

test('AC-013: a closed lane leaves the reader, and closing an urgent lane leaves the others as they were', async () => {
  const dir = setup();
  await moveInStartOrder({ idd_id: 'IDD-002', before: 'IDD-001' });
  await setUrgent({ idd_id: 'IDD-003', urgent: true });
  assert.deepEqual(viewIds(), ['IDD-003', 'IDD-002', 'IDD-001', 'IDD-004']);
  at(dir, 'IDD-003', 'lane_close', { outcome: 'aborted' });
  assert.deepEqual(viewIds(), ['IDD-002', 'IDD-001', 'IDD-004']);
  assert.ok(!viewIds().includes('IDD-003'));
  // the lines still carry the closed lane; the reader derives it away, the next write drops it
  assert.deepEqual(readStartOrder().order, ['IDD-002', 'IDD-001', 'IDD-003', 'IDD-004']);
});

test('AC-014: twenty moves at once leave every line readable and every open lane in the order once', async () => {
  setup();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => moveInStartOrder({
    idd_id: i % 2 ? 'IDD-002' : 'IDD-003',
    position: (i % 4) + 1,
  })));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  const lines = orderLines();
  assert.equal(lines.length, 20, 'one line per operation');
  for (const line of lines) JSON.parse(line);
  const last = readStartOrder();
  assert.equal(new Set(last.order).size, last.order.length, 'no id is listed twice');
  const open = IDS;
  for (const id of open) assert.ok(last.order.includes(id), id);
});

test('AC-017: the start order writes nothing to the lifecycle or the backlog', async () => {
  const dir = setup();
  const backlog = readFileSync(join(dir, 'backlog.jsonl'), 'utf8');
  const lifecycle = readFileSync(join(dir, 'lifecycle-demo.jsonl'), 'utf8');
  await moveInStartOrder({ idd_id: 'IDD-002', position: 1 });
  await setUrgent({ idd_id: 'IDD-003', urgent: true });
  await setUrgent({ idd_id: 'IDD-003', urgent: false });
  assert.equal(readFileSync(join(dir, 'backlog.jsonl'), 'utf8'), backlog);
  assert.equal(readFileSync(join(dir, 'lifecycle-demo.jsonl'), 'utf8'), lifecycle);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('lifecycle-')), ['lifecycle-demo.jsonl']);
});

test('INV-102-6: every open lane appears exactly once, placed, unplaced or urgent', async () => {
  setup();
  // before any move nothing is placed: the reader sorts the lanes but writes no order
  assert.ok(startOrderView().lanes.every((l) => l.placed === false));
  await moveInStartOrder({ idd_id: 'IDD-002', position: 1 });
  await setUrgent({ idd_id: 'IDD-004', urgent: true });
  const view = startOrderView().lanes;
  assert.deepEqual([...view.map((l) => l.idd_id)].sort(), [...IDS].sort());
  assert.equal(new Set(view.map((l) => l.idd_id)).size, view.length);
  assert.deepEqual(view.map((l) => l.position), [1, 2, 3, 4]);
  // a move writes the whole open order, so every open lane is placed afterwards; the mark is the urgent lane's
  assert.ok(view.every((l) => l.placed === true));
  assert.equal(view.find((l) => l.idd_id === 'IDD-004').urgent, true);
});

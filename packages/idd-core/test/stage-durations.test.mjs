import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';

import { readStageDurations, recordStageDurations, usualFor, INITIAL_STAGE_STATS } from '../src/plan/stage-durations.ts';
import { STAGE_RULE_VERSION } from '../src/ledger/stage-spans.ts';

const BASE = Date.parse('2026-10-01T00:00:00Z');
const at = (m) => new Date(BASE + m * 60_000).toISOString();
const ev = (idd, event, m, attrs = {}) => ({ idd_id: idd, event, at: at(m), attrs });

/** a landed lane's record: implementation 10 → 30, review 30 → 46, R2 46 → 47, land 60 → 61 */
function landed(id, { area = 'a', risk = 'Medium', changed = [], outcome = 'local', from = 0 } = {}) {
  return {
    id,
    area,
    start: at(from),
    events: [
      ev(id, 'lane_open', from),
      ev(id, 's2_start', from + 10),
      ev(id, 's2_result', from + 30, { changed_files: changed }),
      ev(id, 's2_review_started', from + 31, { kind: 'blind', round: 1, risk }),
      ev(id, 's2_triage_done', from + 45, { kind: 'blind', round: 1, accepted: [] }),
      ev(id, 's2_review_converged', from + 46),
      ev(id, 's2_device_skipped', from + 47),
      ev(id, 's4_submit_started', from + 48),
      ev(id, 's4_land_approved', from + 60, { signed: true, head: 'h' }),
      ev(id, 'lane_close', from + 61, { outcome }),
    ],
  };
}

function setup(lanes) {
  const root = scratchDir('durations-');
  const state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos: {}\n');
  writeFileSync(join(root, 'roles.yaml'), '');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), lanes.map((l) => JSON.stringify({ idd_id: l.id, area: l.area, title: 't', context: '', created_at: l.start })).join('\n') + '\n');
  const byArea = new Map();
  for (const lane of lanes) {
    const list = byArea.get(lane.area) ?? [];
    list.push(...lane.events);
    byArea.set(lane.area, list);
  }
  for (const [area, events] of byArea) writeFileSync(join(state, `lifecycle-${area}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { root, state };
}

function row(idd, area, closedAt, stages = {}, fix_rounds = [], rule = STAGE_RULE_VERSION) {
  return { rule, idd_id: idd, area, closed_at: at(closedAt), stages, fix_rounds, changed_files: 0, risk: null, est: null };
}

test('the recording stage measures each landed lane once and writes one row each (AC-006)', async () => {
  setup([landed('IDD-1', { from: 0 }), landed('IDD-2', { from: 120 })]);
  const r = await recordStageDurations();
  assert.deepEqual([...r.recorded].sort(), ['IDD-1', 'IDD-2']);
  const rows = readStageDurations();
  assert.equal(rows.length, 2);
  for (const written of rows) {
    assert.equal(written.rule, STAGE_RULE_VERSION);
    assert.equal(written.area, 'a');
    assert.ok(written.closed_at);
    assert.equal(written.stages.impl, 20);
    assert.equal(written.stages.review, 16);
    assert.equal(written.stages.checks, 2);
    assert.equal(written.stages.land, 1);
  }
});

test('a row written while the stage after convergence was keyed r2 reads that length as checks', () => {
  const { state } = setup([]);
  const row = (stages) => JSON.stringify({ rule: STAGE_RULE_VERSION, idd_id: 'IDD-9', area: 'a', closed_at: '2026-10-01T00:00:00+09:00', stages, fix_rounds: [], changed_files: 1, risk: null, est: null });
  writeFileSync(join(state, 'stage-durations.jsonl'), `${row({ impl: 20, r2: 3 })}\n${row({ impl: 20, checks: 4, r2: 3 })}\n`);
  const [old, both] = readStageDurations();
  assert.deepEqual(old.stages, { impl: 20, checks: 3 });
  assert.deepEqual(both.stages, { impl: 20, checks: 4 }, 'a row that already carries checks keeps it');
});

test('a second pass adds no row, and a lane closed later adds exactly one (AC-007)', async () => {
  const first = landed('IDD-1', { from: 0 });
  const { state } = setup([first]);
  await recordStageDurations();
  const n = readStageDurations().length;
  await recordStageDurations();
  assert.equal(readStageDurations().length, n, 'the same lane is not written twice');
  const third = landed('IDD-3', { from: 240 });
  appendFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: third.id, area: third.area, title: 't', context: '', created_at: third.start }) + '\n');
  appendFileSync(join(state, 'lifecycle-a.jsonl'), third.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = await recordStageDurations();
  assert.deepEqual(r.recorded, ['IDD-3']);
  assert.equal(readStageDurations().length, n + 1);
});

test('a row of an older split is measured again, and the aggregate reads no old row (AC-008)', async () => {
  const { state } = setup([landed('IDD-1', { from: 0 })]);
  const old = row('IDD-1', 'a', 0, { plan: 999 }, [999], 1);
  writeFileSync(join(state, 'stage-durations.jsonl'), JSON.stringify(old) + '\n');
  await recordStageDurations();
  const rows = readStageDurations();
  assert.equal(rows.filter((r) => r.idd_id === 'IDD-1' && r.rule === STAGE_RULE_VERSION).length, 1);
  assert.equal(rows.filter((r) => r.rule === 1).length, 0, 'the old row was dropped when the file was written again');
  assert.equal(rows[0].rule, STAGE_RULE_VERSION, 'the row carries the split it was measured with');
  assert.equal(rows[0].stages.plan, 10, 'the plan is measured again from the record, 0 -> 10');
  assert.notEqual(rows[0].stages.plan, 999, 'the old row\'s value is gone');
  const usual = usualFor('a', [old]);
  assert.equal(usual.stages.plan.basis, 'initial', 'an old row is no sample');
  assert.equal(usual.stages.plan.median, INITIAL_STAGE_STATS.plan.median);
});

test('a lane penne took out is no sample (AC-009)', async () => {
  setup([
    landed('IDD-1', { from: 0, outcome: 'local' }),
    landed('IDD-2', { from: 120, outcome: 'merged' }),
    landed('IDD-3', { from: 240, outcome: 'dropped' }),
    landed('IDD-4', { from: 360, outcome: 'aborted' }),
    landed('IDD-5', { from: 480, outcome: 'redone' }),
    { id: 'IDD-6', area: 'a', start: at(600), events: [ev('IDD-6', 'lane_open', 600), ev('IDD-6', 's1_defer', 610)] },
  ]);
  await recordStageDurations();
  assert.deepEqual(readStageDurations().map((r) => r.idd_id).sort(), ['IDD-1', 'IDD-2']);
});

test('a row carries the risk, the changed-file count and an empty est (AC-010)', async () => {
  setup([landed('IDD-1', { from: 0, risk: 'High', changed: ['a.ts', 'b.ts', 'a.ts'] })]);
  await recordStageDurations();
  const written = readStageDurations()[0];
  assert.equal(written.risk, 'High');
  assert.equal(written.changed_files, 2, 'the file names are a set');
  assert.equal(written.est, null);
});

test('the sample is the same repo\'s newest 20 rows (AC-011)', () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(`IDD-${i}`, 'r', 1000 - i, { plan: i }));
  const usual = usualFor('r', rows);
  assert.equal(usual.lanes, 20);
  assert.equal(usual.stages.plan.basis, 'repo');
  assert.equal(usual.stages.plan.samples, 20);
  // the newest 20 are closed_at 1000..981; the plan values 0..19 give the median of that window
  assert.equal(usual.stages.plan.median, 9.5);
});

test('a repo short of 20 rows is filled from other repos and says so (AC-012)', () => {
  const mine = Array.from({ length: 12 }, (_, i) => row(`IDD-${i}`, 'r', 1000 - i, { plan: 10 }));
  const others = Array.from({ length: 30 }, (_, i) => row(`OTH-${i}`, 'other', 5000 - i, { plan: 20 }));
  const usual = usualFor('r', [...mine, ...others]);
  assert.equal(usual.lanes, 20);
  assert.equal(usual.stages.plan.samples, 20);
  assert.equal(usual.stages.plan.basis, 'mixed');
});

test('a stage under eight samples takes the initial value, alone (AC-013)', () => {
  const few = Array.from({ length: 5 }, (_, i) => row(`IDD-${i}`, 'r', 100 - i, { plan: 10, impl: 20 }, [30]));
  const small = usualFor('r', few);
  for (const stage of ['plan', 'plan_review', 'impl', 'review', 'fix', 'checks', 'land']) {
    assert.equal(small.stages[stage].basis, 'initial');
    assert.equal(small.stages[stage].median, INITIAL_STAGE_STATS[stage].median);
  }
  const many = Array.from({ length: 20 }, (_, i) => row(`IDD-${i}`, 'r', 100 - i, { plan: 10, impl: 20 }, i < 3 ? [30] : []));
  const usual = usualFor('r', many);
  assert.equal(usual.stages.plan.basis, 'repo');
  assert.equal(usual.stages.plan.samples, 20);
  assert.equal(usual.stages.fix.basis, 'initial', 'only three fix rounds are on record');
  assert.equal(usual.stages.fix.samples, 3);
  assert.equal(usual.stages.plan_review.basis, 'initial', 'no lane took the plan review');
});

test('a state that cannot be written does not throw, and the failure is reported (AC-030)', async () => {
  const { state } = setup([landed('IDD-1', { from: 0 })]);
  mkdirSync(join(state, 'stage-durations.jsonl'));
  let result;
  result = await recordStageDurations();
  assert.ok(result);
  assert.deepEqual(result.recorded, []);
  assert.ok(result.errors.length >= 1, 'the failure is on the result the tick carries');
});

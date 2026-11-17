import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { clearCostCache, laneCost, runReading, subscriptionTotal } from '../src/plan/budget.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { jstDay } from '../src/time.ts';


let state;
const run = (id, rec) => {
  mkdirSync(join(state, 'lanes', id), { recursive: true });
  writeFileSync(join(state, 'lanes', id, 'lane.json'), JSON.stringify({ id, status: 'done', started_at: '2026-10-05T00:00:00Z', ...rec }));
};
const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-10-05T00:00:00Z', attrs });

beforeEach(() => {
  clearCostCache();
  const root = scratchDir('cost-daily-');
  state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  writeFileSync(join(root, 'roles.yaml'), 'defaults:\n  lane_budget_usd: 5\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 't', context: '' }) + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'P1', worktree_path: root }) + '\n');
});

afterEach(() => setAgentRunner(null));

test('the JST day of an instant is cut at 0:00 Japan time', () => {
  assert.equal(jstDay('2026-10-05T14:59:00Z'), '2026-10-05');
  assert.equal(jstDay('2026-10-05T15:00:00Z'), '2026-10-06');
  assert.equal(jstDay('not a time'), '');
});

test('AC-007: a run is split by the JST day it ended, or by when it started when the end was cleared', async () => {
  setAgentRunner({});
  run('R1', { usage: { cost: 1 }, ended_at: '2026-10-05T14:59:00Z' });
  run('R2', { usage: { cost: 2 }, ended_at: '2026-10-05T15:00:00Z' });
  run('R3', { usage: { cost: 3 } }); // no end (a resume): the start decides
  const c = await laneCost('IDD-1', [ev('s2_review_started', { run_ids: ['R1', 'R2', 'R3'] })]);
  assert.equal(c.total, 6);
  assert.deepEqual(c.daily, [
    { day: '2026-10-05', budget: 4, subscription: 0 },
    { day: '2026-10-06', budget: 2, subscription: 0 },
  ]);
});

test('AC-007: a run that is still going has no cost and no day', async () => {
  setAgentRunner({});
  run('RUN-1', { status: 'running', usage: undefined, started_at: '2026-10-05T01:00:00Z' });
  const c = await laneCost('IDD-1', [ev('s2_review_started', { run_ids: ['RUN-1'] })]);
  assert.equal(c.total, 0);
  assert.deepEqual(c.daily, []);
});

test('AC-005 / AC-007: a Claude Code run is the subscription part, kept out of the budget', async () => {
  setAgentRunner({});
  run('C1', { usage: { cost: 0.5 }, ended_at: '2026-10-05T10:00:00Z', role_preset: { harness: 'claude' } });
  const c = await laneCost('IDD-1', [ev('s2_review_started', { run_ids: ['C1'] })]);
  assert.equal(c.total, 0);
  assert.equal(subscriptionTotal(c), 0.5);
  assert.deepEqual(c.daily, [{ day: '2026-10-05', budget: 0, subscription: 0.5 }]);
});

test('AC-008: a session record is read once while it is unchanged, and read again when it changes', async () => {
  let calls = 0;
  const fingerprints = { P1: 'v1' };
  setAgentRunner({
    sessionDailyCost: () => {
      calls += 1;
      return { cost: 3, daily: [{ day: '2026-10-05', cost: 3 }] };
    },
    sessionRecordFingerprint: (id) => fingerprints[id] ?? null,
  });
  const first = await laneCost('IDD-1', []);
  assert.equal(calls, 1);
  assert.equal(first.total, 3);
  assert.deepEqual(first.daily, [{ day: '2026-10-05', budget: 3, subscription: 0 }]);

  const second = await laneCost('IDD-1', []);
  assert.equal(calls, 1, 'an unchanged record is not read again');
  assert.deepEqual(second.daily, first.daily);

  fingerprints.P1 = 'v2';
  await laneCost('IDD-1', []);
  assert.equal(calls, 2, 'a changed record is read again');
});

test('AC-008: a run record is read again only after it changed, and the new value is used', async () => {
  setAgentRunner({});
  run('R1', { usage: { cost: 1 }, ended_at: '2026-10-05T10:00:00Z' });
  assert.equal(runReading('R1').cost, 1);
  assert.equal(runReading('R1').cost, 1, 'an unchanged record gives the same value');
  run('R1', { usage: { cost: 2.5 }, ended_at: '2026-10-05T10:00:00Z', note: 'changed' });
  assert.equal(runReading('R1').cost, 2.5);
});

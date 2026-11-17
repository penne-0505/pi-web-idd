import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { deriveStage } from '../src/ledger/derive.ts';
import { applyDecision } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-002', at: '2026-09-01T10:00:00+09:00', attrs });

test('a lane taken in again waits for penne before the planner spends anything; a fresh one goes straight to prep', () => {
  assert.deepEqual([deriveStage([ev('lane_open')]).group, deriveStage([ev('lane_open')]).decision], ['prep', undefined]);
  const again = [ev('lane_open', { requeued_from: 'IDD-001' })];
  assert.deepEqual([deriveStage(again).group, deriveStage(again).decision], ['judge', 'requeue']);
  const resumed = [...again, ev('s0_requeue_go')];
  assert.deepEqual([deriveStage(resumed).group, deriveStage(resumed).decision], ['prep', undefined]);
});

test('resuming a requeued lane is recorded, and dropping it closes it again', async () => {
  const root = scratchDir('requeue-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), JSON.stringify(ev('lane_open', { requeued_from: 'IDD-001' })) + '\n');
  assert.equal((await applyDecision('s0_requeue_go', { iddId: 'IDD-002' })).ok, true);
  assert.equal(deriveStage(readLifecycle().filter((e) => e.idd_id === 'IDD-002')).group, 'prep');
});

test('sending the plan back from the GO card records it and queues the instruction for the planner', async () => {
  const { readFileSync } = await import('node:fs');
  const root = scratchDir('revise-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const go = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 0, should: 0, nit: 0 })];
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), go.map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.equal((await applyDecision('s1_revise', { iddId: 'IDD-002', instruction: '' })).ok, false, 'an empty instruction is refused');
  const sent = await applyDecision('s1_revise', { iddId: 'IDD-002', instruction: 'DEC を 2 つに分けて' });
  assert.equal(sent.ok, true, sent.error);
  assert.ok(sent.envelopeId);
  assert.equal(deriveStage(readLifecycle().filter((e) => e.idd_id === 'IDD-002')).blockedBy, 'penne の指示を反映中');
  assert.match(readFileSync(join(state, 'outbox', `${sent.envelopeId}.xml`), 'utf8'), /DEC を 2 つに分けて/);
  assert.equal((await applyDecision('s1_revise', { iddId: 'IDD-002', instruction: 'again' })).ok, false, 'only a lane waiting at GO takes it');
});

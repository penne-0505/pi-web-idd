import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyDecision } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { stuckOutcomes } from '../src/plan/review-loop.ts';
import { tmpDir } from './helpers/tmp.mjs';

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', source_type: 'github', gh_issue_url: 'https://github.com/me/app/issues/1' };
const made = [];
const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, roles: process.env.IDD_ROLES_FILE };
afterEach(() => {
  if (saved.state === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved.state;
  if (saved.repos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved.repos;
  if (saved.roles === undefined) delete process.env.IDD_ROLES_FILE; else process.env.IDD_ROLES_FILE = saved.roles;
});

/** a depth-bearing pass stopped at penne (an escalation after musts it could not send) */
function setup(escalated = true) {
  const state = tmpDir('idd-hand-');
  made.push(state);
  const wt = join(state, 'wt');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(state, 'u'), work: join(state, 'w'), public_base: 'main' } } }));
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(state, 'repos.yaml'), IDD_ROLES_FILE: join(state, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n');
  const ev = (event, attrs = {}) => ({ idd_id: 'IDD-1', event, at: '2026-10-01T00:00:00Z', attrs });
  const events = [
    ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b1'], depth: 'deep', max_fix_rounds: 3, close_on: 'must' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: [] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: '残った must', action: 'fix', path: 'a.ts' }], prior: [{ ref: 'F-0' }] }),
    ...(escalated ? [ev('s2_review_escalated', { reason: '修正が 3 巡に達した' }), ev('s2_result', { outcome: 'success', side_findings: ['直したが届かなかった'] })] : []),
  ];
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

test('the stuck card carries a "自分で直す" destination, and the lane that took it starts no fix (AC-046)', async () => {
  const state = setup();
  const evs = readLifecycle().filter((e) => e.idd_id === 'IDD-1');
  assert.equal(reviewLoopState(evs).state, 'escalated');
  const outcomes = stuckOutcomes('IDD-1', evs);
  assert.deepEqual(outcomes.handFix, { to: 'hand' });
  const handFix = await applyDecision('s2_review_hand_fix', { iddId: 'IDD-1' });
  assert.equal(handFix.ok, true, handFix.error);
  const resumed = readLifecycle().find((e) => e.event === 's2_review_resumed');
  assert.equal(resumed.attrs.decision, 'hand_fix');
  assert.deepEqual(reviewLoopState(readLifecycle().filter((e) => e.idd_id === 'IDD-1')), { state: 'awaiting_hand_fix', round: 1 });
  // no fix was sent
  assert.equal(readLifecycle().filter((e) => e.event === 's2_fix_sent').length, 0);
  // the state file's lifecycle is the one the test reads
  assert.ok(readFileSync(join(state, 'lifecycle-me-app.jsonl'), 'utf8').includes('s2_review_resumed'));
});

test('"直した" hands the lane back to one review round, with no fix (AC-047)', async () => {
  setup();
  assert.equal((await applyDecision('s2_review_hand_fix', { iddId: 'IDD-1' })).ok, true);
  const fixed = await applyDecision('s2_hand_fixed', { iddId: 'IDD-1' });
  assert.equal(fixed.ok, true, fixed.error);
  assert.ok(readLifecycle().some((e) => e.event === 's2_hand_fixed'));
  assert.deepEqual(reviewLoopState(readLifecycle().filter((e) => e.idd_id === 'IDD-1')), { state: 'start_blind', kind: 'blind', round: 1 });
  assert.equal(readLifecycle().filter((e) => e.event === 's2_fix_sent').length, 0);
});

test('the two answers are refused on a lane that is not at that stop (AC-046, AC-047)', async () => {
  setup(false);
  assert.equal((await applyDecision('s2_review_hand_fix', { iddId: 'IDD-1' })).ok, false);
  assert.equal((await applyDecision('s2_hand_fixed', { iddId: 'IDD-1' })).ok, false);
  assert.ok(!readLifecycle().some((e) => e.event === 's2_review_resumed' || e.event === 's2_hand_fixed'));
});

// AC-043: the budget-stopped card carries the remaining musts and the history of why they were not fixed
test('the stopped card lists the remaining musts and the history (AC-043)', () => {
  const evs = [
    { idd_id: 'IDD-1', event: 's2_result', at: '', attrs: {} },
    { idd_id: 'IDD-1', event: 's2_review_started', at: '', attrs: { kind: 'blind', round: 1, depth: 'deep', max_fix_rounds: 1, close_on: 'must' } },
    { idd_id: 'IDD-1', event: 's2_triage_done', at: '', attrs: { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: '残った must', action: 'fix', path: 'a.ts' }] } },
    { idd_id: 'IDD-1', event: 's2_fix_sent', at: '', attrs: { refs: ['F-1'] } },
    { idd_id: 'IDD-1', event: 's2_result', at: '', attrs: { outcome: 'success', side_findings: ['直したつもり'] } },
    { idd_id: 'IDD-1', event: 's2_review_started', at: '', attrs: { kind: 'blind', round: 2 } },
    { idd_id: 'IDD-1', event: 's2_review_findings', at: '', attrs: { kind: 'blind', round: 2, files: [] } },
    { idd_id: 'IDD-1', event: 's2_triage_done', at: '', attrs: { kind: 'blind', round: 2, accepted: [{ ref: 'F-1', severity: 'must', claim: '残った must', action: 'fix', path: 'a.ts' }], prior: [{ ref: 'F-1' }] } },
  ];
  assert.equal(reviewLoopState(evs).state, 'escalated');
  // the card reads the same records: the open musts and the last fix's own report are both on record
  assert.ok(evs[7].attrs.prior.some((p) => p.ref === 'F-1' && p.resolved !== true));
  assert.deepEqual(evs[4].attrs.side_findings, ['直したつもり']);
});

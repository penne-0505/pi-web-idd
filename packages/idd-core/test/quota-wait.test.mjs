import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveStage, planReviewPhase } from '../src/ledger/derive.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { runPlanReview } from '../src/plan/plan-review.ts';
import { runReviewLoop } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { tmpDir } from './helpers/tmp.mjs';

// what the runner throws when a Claude Code role waits for the subscription's windows (ClaudeQuotaBlocked of @idd/lane)
const RESETS = Date.parse('2026-09-24T07:00:00Z') / 1000;
const quotaError = () => Object.assign(new Error('Claude の枠が止める閾値に達しているので lane を起動しません: 5 時間の枠 95%'), { code: 'claude_quota', resetsAt: RESETS });
// the windows as the same runner reads them for the display: the observation it refused on is still on record
const quotaBlock = () => ({ reason: 'Claude の枠が止める閾値に達しているので lane を起動しません: 5 時間の枠 95%', resetsAt: RESETS });

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-24T10:00:00+09:00', attrs });
const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-001');
const waits = () => lane().filter((e) => e.event === 'claude_quota_wait');

function setup(pipeline, events, sessions = {}) {
  const state = tmpDir('idd-quota-wait-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipeline}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-quota-wait-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', title: 'T', area: 'Demo', context: '' }) + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', planner_session_id: 'P1', worktree_path: sessions.planner ?? wt }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events(head).map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state, wt, head };
}

test('a plan review that waits for the Claude window is not skipped: the lane waits, and the wait is on record once', async () => {
  setup('  plan_review: { role: r }\n', () => [ev('lane_open'), ev('s1_ready')]);
  let tries = 0;
  setAgentRunner({ deliver: async () => {}, quotaBlock, startPlanReview: async () => { tries += 1; throw quotaError(); } });
  for (let i = 0; i < 4; i += 1) await runPlanReview();
  assert.equal(tries, 4, 'tried again on every tick');
  assert.equal(lane().some((e) => e.event === 's1_plan_review_done'), false);
  assert.equal(planReviewPhase(lane()).phase, 'waiting');
  assert.equal(waits().length, 1);
  assert.deepEqual([waits()[0].attrs.stage, waits()[0].attrs.resets_at], ['plan_review', RESETS]);
  assert.match(deriveStage(lane()).blockedBy, /Claude の枠待ち.*2026-09-24 16:00 JST/);
  setAgentRunner(null);
});

test('a review stage that waits for the Claude window is not a start failure: no escalation however many ticks pass', async () => {
  setup('  executor: { role: r }\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n', (head) => [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })]);
  let tries = 0;
  setAgentRunner({ deliver: async () => {}, quotaBlock, startReviewRun: async () => { tries += 1; throw quotaError(); }, reviewRunStatus: () => ({ state: 'running' }) });
  for (let i = 0; i < 5; i += 1) await runReviewLoop();
  assert.equal(tries, 5);
  assert.equal(lane().some((e) => e.event === 's2_review_run_failed' || e.event === 's2_review_escalated'), false);
  assert.equal(reviewLoopState(lane()).state, 'start_blind');
  assert.equal(waits().length, 1);
  assert.equal(waits()[0].attrs.stage, 'blind');
  assert.equal(deriveStage(lane()).decision, undefined);
  assert.match(deriveStage(lane()).blockedBy, /Claude の枠待ち/);
  setAgentRunner(null);
});

test('a start that fails for another reason is still a failure', async () => {
  setup('  plan_review: { role: r }\n', () => [ev('lane_open'), ev('s1_ready')]);
  setAgentRunner({ deliver: async () => {}, startPlanReview: async () => { throw new Error('boom'); } });
  await runPlanReview();
  assert.equal(lane().find((e) => e.event === 's1_plan_review_done')?.attrs.failed, true);
  assert.equal(waits().length, 0);
  setAgentRunner(null);
});

// ---- IDD-133: the display reads the same windows the stage's start does ----

const waited = (iso) => ({ event: 'claude_quota_wait', idd_id: 'IDD-001', at: '2026-09-24T10:01:00+09:00', attrs: iso });
const opened = () => ({ event: 'lane_open', idd_id: 'IDD-001', at: '2026-09-24T10:00:00+09:00', attrs: {} });
/** the runner's reading of the windows: a block while they hold, null when they let a lane start */
const windows = (block) => ({ deliver: async () => {}, quotaBlock: () => block });

test('the observation decides whether the display says the lane waits for the windows (AC-002)', () => {
  const past = Date.parse('2026-09-24T07:00:00Z') / 1000;
  const events = [opened(), waited({ stage: 'planner', resets_at: past })];
  // the observation holds it even though the recorded reset has passed: the reading wins over the record
  setAgentRunner(windows({ reason: 'windows', resetsAt: past }));
  assert.match(deriveStage(events).blockedBy, /Claude の枠待ち/);
  // the windows let it start: the display no longer says it waits
  setAgentRunner(windows(null));
  assert.doesNotMatch(deriveStage(events).blockedBy ?? '', /Claude の枠待ち/);
  setAgentRunner(null);
});

test('an unreadable observation leaves the record\'s own reset to the display too (AC-006)', () => {
  const future = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000);
  const held = [opened(), waited({ stage: 'planner', resets_at: future })];
  const passed = [opened(), waited({ stage: 'planner', resets_at: 1 })];
  const none = [opened(), waited({ stage: 'planner' })];
  for (const runner of [{ deliver: async () => {} }, { deliver: async () => {}, quotaBlock: () => { throw new Error('観測を読めない'); } }]) {
    setAgentRunner(runner);
    assert.match(deriveStage(held).blockedBy, /Claude の枠待ち/, 'a reset ahead holds');
    assert.doesNotMatch(deriveStage(passed).blockedBy ?? '', /Claude の枠待ち/, 'a reset past does not hold');
    assert.match(deriveStage(none).blockedBy, /Claude の枠待ち/, 'no reset holds');
  }
  setAgentRunner(null);
});

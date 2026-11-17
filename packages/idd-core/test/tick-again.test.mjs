import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runTick } from '../src/plan/tick.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { tmpDir } from './helpers/tmp.mjs';

// what a finished lane (or a tick that found the lock busy) leaves in the state to ask for another pass
const TICK_AGAIN_FILE = 'tick.again';
const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });

/** a lane past its executor's result, with a blind round started on run B */
function setup(extra = []) {
  const state = tmpDir('idd-tick-again-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-tick-again-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' }), ...extra].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

const events = () => readLifecycle().map((e) => e.event);
const done = (id) => ({ state: 'done', reportJson: `/${id}.json`, reportMd: `/${id}.md`, findings: [] });

test('a stage that finishes while a tick runs is taken up by the same tick, without waiting for the next', { timeout: 20_000 }, async () => {
  const state = setup([ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] })]);
  const status = { B: { state: 'running' }, T: { state: 'running' } };
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    reviewRunStatus: (id) => {
      const now = status[id];
      // the tick has looked at B and seen it running; its lane finishes right after and asks for a tick
      if (id === 'B' && now.state === 'running') {
        status.B = done('B');
        writeFileSync(join(state, TICK_AGAIN_FILE), new Date().toISOString());
      }
      return now;
    },
    startReviewRun: async (o) => { started.push(o.stage); return { runIds: ['T'] }; },
  });
  const r = await runTick({ intake: false });
  // the pass that saw the finished blind recorded its findings, and a pass after it started the triage
  assert.deepEqual(events().slice(-2), ['s2_review_findings', 's2_triage_started']);
  assert.deepEqual(started, ['triage']);
  assert.ok(Array.isArray(r.again) && r.again.length >= 1, 'the tick ran again after the first pass');
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), false, 'the request was used up');
  setAgentRunner(null);
});

test('a tick that moves a lane on runs again until nothing moves, so one stage finishing is not one step', { timeout: 20_000 }, async () => {
  setup([ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] })]);
  const status = { B: done('B'), T: { state: 'running' } };
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    reviewRunStatus: (id) => status[id],
    startReviewRun: async (o) => { started.push(o.stage); return { runIds: ['T'] }; },
  });
  const r = await runTick({ intake: false });
  assert.deepEqual(events().slice(-2), ['s2_review_findings', 's2_triage_started']);
  // findings → triage started → nothing left to move: two passes after the first
  assert.equal(r.again.length, 2);
  assert.deepEqual(r.again.at(-1).reviewLoop.advanced, []);
  assert.deepEqual(r.intake.added, []);
  setAgentRunner(null);
});

test('ticks that meet do not start the same stage twice: the one that finds the lock busy leaves a request, and the running tick takes it', { timeout: 20_000 }, async () => {
  // the blind's findings are in: the first pass starts the triage
  const state = setup([
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/B.json'] }),
  ]);
  const status = { B: done('B'), T: { state: 'running' } };
  const started = [];
  let enter;
  const entered = new Promise((r) => { enter = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  setAgentRunner({
    deliver: async () => {},
    reviewRunStatus: (id) => status[id],
    // the triage start is slow: a second tick comes in while the first is inside it
    startReviewRun: async (o) => { started.push(o.stage); enter(); await gate; return { runIds: ['T'] }; },
  });
  const first = runTick({ intake: false });
  await entered;
  const second = await runTick({ intake: false });
  assert.deepEqual(second, { skipped: 'another tick is running' });
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), true, 'the skipped tick asked for another pass');
  open();
  const r = await first;
  assert.deepEqual(started, ['triage'], 'the triage started once');
  assert.equal(events().filter((e) => e === 's2_triage_started').length, 1);
  assert.ok(r.again.length >= 1, 'the running tick ran again for the request');
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), false);
  setAgentRunner(null);
});

test('the passes after the first are bounded, even when every pass leaves a request behind it', { timeout: 20_000 }, async () => {
  const state = setup([ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] })]);
  let looked = 0;
  setAgentRunner({
    deliver: async () => {},
    reviewRunStatus: () => { looked += 1; writeFileSync(join(state, TICK_AGAIN_FILE), 'x'); return { state: 'running' }; },
  });
  const r = await runTick({ intake: false });
  assert.equal(r.again.length, 5);
  assert.equal(looked, 6);
  setAgentRunner(null);
});

test('a tick asked for another state does nothing and leaves no request', { timeout: 20_000 }, async () => {
  const state = setup([ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] })]);
  const status = { B: done('B') };
  setAgentRunner({ deliver: async () => {}, reviewRunStatus: (id) => status[id] });
  const other = tmpDir('idd-tick-other-');
  assert.deepEqual(await runTick({ intake: false, forState: other }), { skipped: 'the tick was asked for another state' });
  assert.equal(events().at(-1), 's2_review_started');
  assert.equal(existsSync(join(state, TICK_AGAIN_FILE)), false);
  assert.equal(existsSync(join(other, TICK_AGAIN_FILE)), false);
  // the state it names is this one: the tick runs
  const r = await runTick({ intake: false, forState: `${state}/` });
  assert.ok(!('skipped' in r));
  assert.equal(events().includes('s2_review_findings'), true);
  setAgentRunner(null);
});

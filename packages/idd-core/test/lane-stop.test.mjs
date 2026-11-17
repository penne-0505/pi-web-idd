import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { runTick } from '../src/plan/tick.ts';
import { tmpDir } from './helpers/tmp.mjs';

const line = (rec) => JSON.stringify(rec) + '\n';

/**
 * A state with two lanes and no registered repo: the tick's other stages scan nothing and reach no network. IDD-001
 * was taken out by penne (`ignore`), IDD-002 was closed by its merged PR. Both have a planner and an executor
 * session and one ad-hoc run, and the runtime says every one of them is still running.
 */
function setup(end = ['lane_close', { outcome: 'aborted', via: 'ignore' }]) {
  const state = tmpDir('idd-lane-stop-');
  Object.assign(process.env, { IDD_STATE_DIR: state });
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n  executor: { role: r }\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(join(state, 'repos.yaml'), 'repos: {}\n');
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const row = (idd, title) => ({ idd_id: idd, parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: `https://github.com/o/r/issues/${idd.slice(-1)}`, pull_req_url: null, source_type: 'github', context: '', title, area: 'Demo' });
  writeFileSync(join(state, 'backlog.jsonl'), line(row('IDD-001', 'ignored')) + line(row('IDD-002', 'merged')));
  writeFileSync(join(state, 'planner-sessions.jsonl'), line({ idd_id: 'IDD-001', planner_session_id: 'P-1', worktree_path: '/w1', branch: 'b1' }) + line({ idd_id: 'IDD-002', planner_session_id: 'P-2', worktree_path: '/w2', branch: 'b2' }));
  writeFileSync(join(state, 'executor-sessions.jsonl'), line({ idd_id: 'IDD-001', executor_session_id: 'E-1', worktree_path: '/w1', branch: 'b1' }) + line({ idd_id: 'IDD-002', executor_session_id: 'E-2', worktree_path: '/w2', branch: 'b2' }));
  const ev = (idd, event, attrs = {}) => ({ event, idd_id: idd, at: '2026-09-24T09:00:00+09:00', attrs });
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [
    ev('IDD-001', 'lane_open'), ev('IDD-001', 's2_start'), ev('IDD-001', 's2_review_started', { run_ids: ['R-1'], whole_run_ids: ['R-2'] }),
    ev('IDD-001', end[0], end[1]),
    ev('IDD-002', 'lane_open'), ev('IDD-002', 's2_start'), ev('IDD-002', 's2_review_started', { run_ids: ['R-9'] }),
    ev('IDD-002', 'lane_close', { outcome: 'merged' }),
  ].map(line).join(''));
  return { state };
}

/** a runtime that says every session and run of the fixture is working now */
function runningRunner() {
  const stopped = [];
  setAgentRunner({
    deliver: async () => {},
    sessionStatus: async () => ({ state: 'running' }),
    reviewRunStatus: () => ({ state: 'running' }),
    stopSession: async (id) => { stopped.push(`session:${id}`); },
    stopRun: async (id) => { stopped.push(`run:${id}`); },
    sessionCost: async () => 0,
  });
  return stopped;
}

test('the tick stops what still runs for a lane penne took out, and leaves a merge-closed lane alone', { timeout: 30_000 }, async () => {
  setup();
  const stopped = runningRunner();
  try {
    const r = await runTick({ intake: false });
    assert.deepEqual(stopped.sort(), ['run:R-1', 'run:R-2', 'session:E-1', 'session:P-1']);
    assert.deepEqual(r.stoppedWork, [{ iddId: 'IDD-001', sessions: ['P-1', 'E-1'], runs: ['R-1', 'R-2'] }], 'the pass says which lane it caught up with');
    const note = readLifecycle().filter((e) => e.idd_id === 'IDD-001' && e.event === 'lane_work_stopped').pop();
    assert.equal(note.attrs.via, 'tick');
    assert.deepEqual([note.attrs.sessions, note.attrs.runs], [['P-1', 'E-1'], ['R-1', 'R-2']]);
    assert.equal(readLifecycle().filter((e) => e.idd_id === 'IDD-002' && e.event === 'lane_work_stopped').length, 0, 'a merged lane is not touched');
  } finally {
    setAgentRunner(null);
  }
});

test('the tick stops neither a session nor a run the runtime says has stopped, and records nothing', { timeout: 30_000 }, async () => {
  setup();
  const stopped = [];
  setAgentRunner({
    deliver: async () => {},
    sessionStatus: async (id) => (id === 'P-1' ? { state: 'running' } : { state: 'stopped', cause: 'finished', at: '2026-09-24T10:00:00+09:00' }),
    reviewRunStatus: (id) => (id === 'R-1' ? { state: 'running' } : { state: 'failed', error: 'lane stopped' }),
    stopSession: async (id) => { stopped.push(`session:${id}`); },
    stopRun: async (id) => { stopped.push(`run:${id}`); },
    sessionCost: async () => 0,
  });
  try {
    const r = await runTick({ intake: false });
    assert.deepEqual(stopped, ['session:P-1', 'run:R-1']);
    assert.deepEqual(r.stoppedWork, [{ iddId: 'IDD-001', sessions: ['P-1'], runs: ['R-1'] }]);
  } finally {
    setAgentRunner(null);
  }
});

test('a tick with no runtime leaves everything as it is: the stop is the runtime\'s to do', { timeout: 30_000 }, async () => {
  const { state } = setup();
  setAgentRunner({ deliver: async () => {}, sessionCost: async () => 0 });
  try {
    const r = await runTick({ intake: false });
    assert.deepEqual(r.stoppedWork, []);
    assert.equal(readLifecycle().some((e) => e.event === 'lane_work_stopped'), false);
    assert.equal(readFileSync(join(state, 'planner-sessions.jsonl'), 'utf8').includes('P-1'), true);
  } finally {
    setAgentRunner(null);
  }
});

test('a lane penne took out also stops the plan run its delivery had going (AC-014)', { timeout: 30_000 }, async () => {
  const { state } = setup();
  appendFileSync(join(state, 'lifecycle-Demo.jsonl'), JSON.stringify({ event: 'fix_plan_started', idd_id: 'IDD-001', at: '2026-09-24T09:30:00+09:00', attrs: { envelope_id: 'X-1', run_id: 'R-3' } }) + '\n');
  const stopped = runningRunner();
  try {
    await runTick({ intake: false });
    assert.ok(stopped.includes('run:R-3'), 'the plan run is stopped with the lane\'s other runs');
    const note = readLifecycle().filter((e) => e.idd_id === 'IDD-001' && e.event === 'lane_work_stopped').pop();
    assert.ok(note.attrs.runs.includes('R-3'));
  } finally {
    setAgentRunner(null);
  }
});

test('the tick stops what runs for a lane penne took out, whichever way it was taken out', { timeout: 30_000 }, async () => {
  // every form `discarded` reads: the ignore's close, the drop at the re-take card, a redo's close, and the stop
  // at GO. The CLI's `idd lane redo` and `idd ignore` leave the stop to this pass, so one form left out of
  // `discarded` means that lane's work keeps running beside the new one.
  const forms = {
    'lane_close outcome aborted（ignore）': ['lane_close', { outcome: 'aborted', via: 'ignore' }],
    'lane_close outcome dropped（取り込み直しの見送り）': ['lane_close', { outcome: 'dropped' }],
    'lane_close outcome redone（lane redo）': ['lane_close', { outcome: 'redone', redo_to: 'IDD-002' }],
    's1_defer（GO の前の中止。古い記録）': ['s1_defer', { reason: 'not now' }],
  };
  for (const [name, end] of Object.entries(forms)) {
    setup(end);
    const stopped = runningRunner();
    try {
      const r = await runTick({ intake: false });
      assert.deepEqual(stopped.sort(), ['run:R-1', 'run:R-2', 'session:E-1', 'session:P-1'], name);
      assert.deepEqual(r.stoppedWork, [{ iddId: 'IDD-001', sessions: ['P-1', 'E-1'], runs: ['R-1', 'R-2'] }], name);
      assert.equal(readLifecycle().filter((e) => e.idd_id === 'IDD-002' && e.event === 'lane_work_stopped').length, 0, `${name}: the merge-closed lane is left alone`);
    } finally {
      setAgentRunner(null);
    }
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { deriveStage } from '../src/ledger/derive.ts';
import { setIgnored } from '../src/intake/ignore.ts';
import { laneGateHeld } from '../src/ledger/gate.ts';
import { readBacklog, readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { redoLane } from '../src/intake/redo.ts';
import { lanesAwaitingPrep } from '../src/plan/prep.ts';
import { setAgentRunner } from '../src/agent/port.ts';

const KEY = 'lin_api_TESTSECRET_redo';

function node(identifier, extra = {}) {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `title of ${identifier}`,
    description: `body of ${identifier}`,
    url: `https://linear.app/org/issue/${identifier}/title-of-${identifier.toLowerCase()}`,
    createdAt: '2026-09-25T00:00:00Z',
    updatedAt: '2026-09-25T00:00:00Z',
    team: { key: identifier.split('-')[0] },
    state: { name: 'Todo' },
    labels: { nodes: [] },
    ...extra,
  };
}

/** a Linear that answers `getIssue` with the one node it was given (null: Linear has no such Issue) */
function fakeLinear(found, { onAsk } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.variables.id === undefined) return { ok: true, status: 200, json: async () => ({ data: { viewer: { assignedIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }) };
    onAsk?.(body.variables.id);
    return { ok: true, status: 200, json: async () => (found ? { data: { issue: found } } : { data: null, errors: [{ message: 'Entity not found: Issue' }] }) };
  };
}

const line = (rec) => JSON.stringify(rec);

/** a state with one Linear lane (IDD-001) already past its GO, in a repo that takes team APP in */
function setup(opts = {}) {
  const root = scratchDir('redo-');
  const state = join(root, 'state'); mkdirSync(state);
  const repos = join(root, 'repos.yaml');
  writeFileSync(repos, JSON.stringify({ repos: { 'a/app': { upstream: join(root, 'u'), work: join(root, 'w'), issue_lane: { context: 'meltly', source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'] } } } } }));
  Object.assign(process.env, { IDD_REPOS_FILE: repos, IDD_STATE_DIR: state, IDD_LINEAR_KEY_FILE: join(root, 'no-such-key'), LINEAR_API_KEY: KEY });
  const url = 'https://linear.app/org/issue/APP-1/title-of-app-1';
  writeFileSync(join(state, 'backlog.jsonl'), line({
    idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: url, linear_issue_id: 'uuid-APP-1',
    gh_issue_url: null, pull_req_url: null, source_type: 'linear', context: 'body of APP-1', title: 'title of APP-1', area: 'a/app',
  }) + '\n');
  const events = [['lane_open', {}], ['s1_ready', {}], ['s1_plan_review_skipped', {}], ['s1_go', {}]];
  if (opts.closed) events.push(['lane_close', { outcome: 'merged' }]);
  writeFileSync(join(state, 'lifecycle-a-app.jsonl'), events.map(([event, attrs]) => line({ event, idd_id: 'IDD-001', at: '2026-09-25T00:00:00Z', attrs })).join('\n') + '\n');
  if (opts.sessions) {
    writeFileSync(join(state, 'planner-sessions.jsonl'), line({ idd_id: 'IDD-001', worktree_path: '/w', branch: 'b', planner_session_id: 'P-1' }) + '\n');
    writeFileSync(join(state, 'executor-sessions.jsonl'), line({ idd_id: 'IDD-001', worktree_path: '/w', branch: 'b', executor_session_id: 'E-1' }) + '\n');
    appendFileSyncLifecycle(state, 's2_review_started', 'IDD-001', { run_ids: ['R-1'], whole_run_ids: ['R-2'] });
  }
  return { root, state };
}

function appendFileSyncLifecycle(state, event, iddId, attrs) {
  const path = join(state, 'lifecycle-a-app.jsonl');
  writeFileSync(path, readFileSync(path, 'utf8') + line({ event, idd_id: iddId, at: '2026-09-25T00:10:00Z', attrs }) + '\n');
}

const eventsOf = (id) => readLifecycle().filter((e) => e.idd_id === id).map((e) => e.event);
const attrOf = (id, event) => readLifecycle().filter((e) => e.idd_id === id && e.event === event).pop()?.attrs;

test('a redo closes the lane (outcome redone, redo_to) and opens a new one from the same Issue with redo_of', async () => {
  const { state } = setup();
  // the list is left as it is: keep a line there and compare the file before and after
  writeFileSync(join(state, 'intake-ignores.jsonl'), line({ action: 'ignore', source: 'github', url: 'https://github.com/o/r/issues/3', ref: '#3', title: 'other', at: '2026-09-26T00:00:00Z', at_by: 'user' }) + '\n');
  const before = readFileSync(join(state, 'intake-ignores.jsonl'), 'utf8');

  const res = await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1')) });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.from, 'IDD-001');
  assert.equal(res.iddId, 'IDD-002');

  const close = attrOf('IDD-001', 'lane_close');
  assert.deepEqual([close.outcome, close.redo_to], ['redone', 'IDD-002']);
  const open = readLifecycle().filter((e) => e.idd_id === 'IDD-002' && e.event === 'lane_open').pop();
  assert.equal(open.attrs.redo_of, 'IDD-001');
  assert.equal(open.attrs.requeued_from, undefined, 'the new lane does not wait for the re-take card');
  const row = readBacklog().find((r) => r.idd_id === 'IDD-002');
  assert.equal(row.parent_id, 'IDD-001');
  assert.equal(row.linear_issue_url, 'https://linear.app/org/issue/APP-1');
  assert.equal(row.linear_issue_id, 'uuid-APP-1');
  assert.equal(row.title, 'title of APP-1');
  assert.equal(readFileSync(join(state, 'intake-ignores.jsonl'), 'utf8'), before, 'the ignore list is left as it was');
});

test("a lane opened by a redo goes to prep: the stage derivation reads requeued_from, and redo_of is not it", async () => {
  const { } = setup();
  await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1')) });
  const stage = deriveStage(readLifecycle().filter((e) => e.idd_id === 'IDD-002'));
  assert.equal(stage.group, 'prep');
  assert.equal(stage.decision, undefined);
  const events = readLifecycle().filter((e) => e.idd_id === 'IDD-002');
  assert.equal(deriveStage([...events].map((e) => (e.event === 'lane_open' ? { ...e, attrs: { ...e.attrs, requeued_from: 'IDD-001' } } : e))).decision, 'requeue', 'the old attribute still asks for the card');
  // the tick's own selector picks the new lane up and starts its planner: no card stands in between
  assert.deepEqual(lanesAwaitingPrep().map((r) => r.idd_id), ['IDD-002']);
});

test('a redo stops the old lane\'s sessions and runs right here, and writes the stop on that lane', async () => {
  const { } = setup({ sessions: true });
  const stopped = [];
  const gates = [];
  setAgentRunner({
    deliver: async () => {},
    stopSession: async (id) => { gates.push(laneGateHeld()); stopped.push(`session:${id}`); },
    stopRun: async (id) => { gates.push(laneGateHeld()); stopped.push(`run:${id}`); },
  });
  try {
    const res = await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1')) });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(stopped.sort(), ['run:R-1', 'run:R-2', 'session:E-1', 'session:P-1']);
    assert.deepEqual(res.stopped.sessions, ['P-1', 'E-1']);
    assert.deepEqual(res.stopped.runs, ['R-1', 'R-2']);
    const note = attrOf('IDD-001', 'lane_work_stopped');
    assert.equal(note.via, 'redo');
    assert.equal(eventsOf('IDD-002').includes('lane_work_stopped'), false, 'the new lane is left alone');
  } finally {
    setAgentRunner(null);
  }
});

test('a redo reads the Issue and waits on the runtime with the lane gate free', async () => {
  const { } = setup({ sessions: true });
  const held = [];
  const stopHeld = [];
  setAgentRunner({
    deliver: async () => {},
    stopSession: async () => { stopHeld.push(laneGateHeld()); },
    stopRun: async () => { stopHeld.push(laneGateHeld()); },
  });
  try {
    // the write of the new lane is on another lane: the gate is held only around it, never around the read or the stop
    const res = await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1'), { onAsk: () => held.push(laneGateHeld()) }) });
    assert.equal(res.ok, true, res.error);
  } finally {
    setAgentRunner(null);
  }
  assert.deepEqual(held, [false], 'the Issue is read with the gate free');
  assert.deepEqual([...new Set(stopHeld)], [false], 'the sessions and runs are stopped with the gate free');
});

test('a closed Issue, an ignored Issue and a read that fails each leave the lane open and open nothing', async () => {
  // closed (Linear has no such Issue) and a read that throws
  for (const [what, fetch] of [
    ['Linear に無い', fakeLinear(null)],
    ['読み込みの失敗', async () => { throw new Error('Linear API: HTTP 503'); }],
  ]) {
    const { state } = setup();
    const res = await redoLane('IDD-001', { linearFetch: fetch });
    assert.equal(res.ok, false, what);
    assert.match(res.error, /読み直せません/, what);
    assert.equal(eventsOf('IDD-001').includes('lane_close'), false, `${what}: the lane stays open`);
    assert.equal(readBacklog().length, 1, `${what}: no lane is opened`);
    assert.equal(readLifecycle().filter((e) => e.event === 'lane_open').length, 1, what);
    assert.equal(existsSync(join(state, 'intake-ignores.jsonl')), false, what);
  }

  // on the ignore list: intake leaves it out, so a redo does not start from it (the lane itself is still open:
  // an ignore pressed on it would close it first, and then the close is what refuses the redo)
  const { state } = setup();
  const on = await setIgnored('ignore', { source: 'linear', url: 'https://linear.app/org/issue/APP-1', linearId: 'uuid-APP-1', ref: 'APP-1', title: 'title of APP-1', area: 'a/app' });
  assert.equal(on.ok, true, on.error);
  const res = await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1')) });
  assert.equal(res.ok, false);
  assert.match(res.error, /無視リスト/);
  assert.equal(eventsOf('IDD-001').includes('lane_close'), false);
  assert.equal(readBacklog().length, 1);
  assert.equal(existsSync(join(state, 'intake-ignores.jsonl')), true);
});

test('a lane already closed, and a lane taken in from no Issue, are refused without touching anything', async () => {
  setup({ closed: true });
  const r = await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1')) });
  assert.equal(r.ok, false);
  assert.match(r.error, /既に閉じています/);
  assert.equal(readBacklog().length, 1);

  setup();
  writeFileSync(join(process.env.IDD_STATE_DIR, 'backlog.jsonl'), readFileSync(join(process.env.IDD_STATE_DIR, 'backlog.jsonl'), 'utf8') + line({ idd_id: 'IDD-900', parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'no issue', area: 'a/app' }) + '\n');
  await appendLifecycle('lane_open', 'IDD-900', {});
  const noIssue = await redoLane('IDD-900', { linearFetch: fakeLinear(node('APP-1')) });
  assert.equal(noIssue.ok, false);
  assert.match(noIssue.error, /起票の無い lane/);
  assert.equal(readBacklog().length, 2);
});

test('a redo whose new lane cannot be written tells the caller with the way out, instead of throwing with the lane closed', async () => {
  const { state } = setup();
  // the backlog row of the new lane cannot be appended (a read-only file): the open fails after the close
  chmodSync(join(state, 'backlog.jsonl'), 0o444);
  let res;
  try {
    res = await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1')) });
  } finally {
    chmodSync(join(state, 'backlog.jsonl'), 0o644);
  }
  assert.equal(res.ok, false, 'the caller gets a reason, not an exception');
  assert.equal(res.from, 'IDD-001');
  assert.match(res.error, /新しい lane を開けませんでした/);
  assert.match(res.error, /取り込み直してください/, 'the way out is told');
  // the close stands (taking it back could be read by a tick as a lane that never ended), and the failure is kept on the lane
  assert.equal(attrOf('IDD-001', 'lane_close').outcome, 'redone');
  assert.equal(readBacklog().length, 1, 'no new lane');
  const failure = attrOf('IDD-001', 'lane_redo_failed');
  assert.match(String(failure.reason), /backlog|EACCES|permission/i);
  assert.equal(failure.redo_to, 'IDD-002');
});

test('a redo reads the GitHub Issue of the lane\'s own repo, not another repo\'s Issue of the same number', async () => {
  const root = scratchDir('redo-gh-repo-');
  const state = join(root, 'state'); mkdirSync(state);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const asked = join(root, 'asked.txt');
  const stub = join(bin, 'gh');
  // only a/gh has #12 open; b/gh answers 404. The requested path is recorded, so the test can read which repo was asked
  writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(asked)}, args.join(' ') + "\\n");
const url = args[args.length - 1];
if (!url.startsWith('repos/a/gh/')) { process.stderr.write('HTTP 404'); process.exit(1); }
process.stdout.write(JSON.stringify({ number: 12, title: 'gh twelve', html_url: 'https://github.com/a/gh/issues/12', body: 'body', created_at: '2026-09-23T00:00:00Z', state: 'open', labels: [] }));
`);
  chmodSync(stub, 0o755);
  const repos = join(root, 'repos.yaml');
  const area = (repo) => ({ upstream: join(root, `u-${repo}`), work: join(root, `w-${repo}`), issue_lane: { context: 'personal', source_type_priority: 'github', intake_filter: { github_labels: ['idd-ready'] } } });
  writeFileSync(repos, JSON.stringify({ repos: { 'a/gh': area('a-gh'), 'b/gh': area('b-gh') } }));
  Object.assign(process.env, { IDD_REPOS_FILE: repos, IDD_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` });
  writeFileSync(join(state, 'backlog.jsonl'), line({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: 'https://github.com/a/gh/issues/12', pull_req_url: null, source_type: 'github', context: '', title: 'gh twelve', area: 'a/gh' }) + '\n');
  writeFileSync(join(state, 'lifecycle-a-gh.jsonl'), line({ event: 'lane_open', idd_id: 'IDD-001', at: '2026-09-25T00:00:00Z', attrs: {} }) + '\n');

  const res = await redoLane('IDD-001');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.iddId, 'IDD-002');
  assert.match(readFileSync(asked, 'utf8'), /repos\/a\/gh\/issues\/12/, 'the lane\'s own repo was asked');
  assert.equal(readBacklog().find((r) => r.idd_id === 'IDD-002').gh_issue_url, 'https://github.com/a/gh/issues/12');
});

test('a redo is refused before the close when another lane already holds the Issue', async () => {
  const { state } = setup();
  // a second lane of the same Issue, still open (the state intake would keep from writing, but a redo must not close anything on it)
  writeFileSync(join(state, 'backlog.jsonl'), readFileSync(join(state, 'backlog.jsonl'), 'utf8') + line({ idd_id: 'IDD-009', parent_id: 'IDD-001', created_at: '2026-09-26T00:00:00Z', linear_issue_url: 'https://linear.app/org/issue/APP-1', linear_issue_id: 'uuid-APP-1', gh_issue_url: null, pull_req_url: null, source_type: 'linear', context: '', title: 'title of APP-1', area: 'a/app' }) + '\n');
  writeFileSync(join(state, 'lifecycle-a-app.jsonl'), readFileSync(join(state, 'lifecycle-a-app.jsonl'), 'utf8') + line({ event: 'lane_open', idd_id: 'IDD-009', at: '2026-09-26T00:00:00Z', attrs: {} }) + '\n');
  const res = await redoLane('IDD-001', { linearFetch: fakeLinear(node('APP-1')) });
  assert.equal(res.ok, false);
  assert.match(res.error, /同じ起票の lane が既に開いています: IDD-009/);
  assert.equal(eventsOf('IDD-001').includes('lane_close'), false, 'the lane stays open');
  assert.equal(readBacklog().length, 2, 'no new lane');
});

test('a closed GitHub Issue cannot be redone either: the named read finds nothing and the lane stays open', async () => {
  const root = scratchDir('redo-gh-');
  const state = join(root, 'state'); mkdirSync(state);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const stub = join(bin, 'gh');
  writeFileSync(stub, `#!${process.execPath}
process.stderr.write(process.env.GH_FAIL === '1' ? 'boom' : 'HTTP 404');
process.exit(1);
`);
  chmodSync(stub, 0o755);
  const repos = join(root, 'repos.yaml');
  writeFileSync(repos, JSON.stringify({ repos: { 'a/gh': { upstream: join(root, 'u'), work: join(root, 'w'), issue_lane: { context: 'personal', source_type_priority: 'github', intake_filter: { github_labels: ['idd-ready'] } } } } }));
  Object.assign(process.env, { IDD_REPOS_FILE: repos, IDD_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` });
  writeFileSync(join(state, 'backlog.jsonl'), line({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: 'https://github.com/a/gh/issues/12', pull_req_url: null, source_type: 'github', context: '', title: 'gh twelve', area: 'a/gh' }) + '\n');
  writeFileSync(join(state, 'lifecycle-a-gh.jsonl'), line({ event: 'lane_open', idd_id: 'IDD-001', at: '2026-09-25T00:00:00Z', attrs: {} }) + '\n');

  for (const [fail, what] of [['0', 'closed'], ['1', 'a read that fails']]) {
    process.env.GH_FAIL = fail;
    const res = await redoLane('IDD-001');
    assert.equal(res.ok, false, what);
    assert.equal(eventsOf('IDD-001').includes('lane_close'), false, what);
    assert.equal(readBacklog().length, 1, what);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { listIntakeCandidates, runIntake } from '../src/intake/run.ts';
import { ignoreLane, ignorePendingReview, intakeIgnoresPath, isIgnored, listIgnored, readIgnores, setIgnored } from '../src/intake/ignore.ts';
import { ignorePreview } from '../src/intake/ignore-resolve.ts';
import { ignoreByRef } from '../src/intake/ignore-resolve.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readBacklog, readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { LANE_GATE_FILE, LANE_GATE_STALE_MS, laneGateHeld } from '../src/ledger/gate.ts';
import lockfile from 'proper-lockfile';
import { seedLifecycle } from './seed-lifecycle.mjs';

const KEY = 'lin_api_TESTSECRET_0123456789';

/** every GraphQL body sent to the fake Linear */
const sentBodies = [];

function node(identifier, state, extra = {}) {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `title of ${identifier}`,
    description: `body of ${identifier}`,
    url: `https://linear.app/org/issue/${identifier}/title-of-${identifier.toLowerCase()}`,
    createdAt: '2026-09-25T00:00:00Z',
    updatedAt: '2026-09-25T00:00:00Z',
    team: { key: identifier.split('-')[0] },
    state: { name: state },
    labels: { nodes: [] },
    ...extra,
  };
}

function fakeLinear(nodes) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    sentBodies.push(body);
    if (body.variables.id !== undefined) {
      const found = nodes.find((n) => n.identifier === body.variables.id);
      return { ok: true, status: 200, json: async () => (found ? { data: { issue: found } } : { data: null, errors: [{ message: 'Entity not found: Issue' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { viewer: { assignedIssues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } }) };
  };
}

/** a GitHub repo a/gh with open Issues #1 and #2 (both labelled for intake), a Linear repo for team APP */
function setup() {
  const root = scratchDir('ignore-');
  const state = join(root, 'state'); mkdirSync(state);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const stub = join(bin, 'gh');
  const issues = [1, 2].map((n) => ({ number: n, title: `gh ${n}`, url: `https://github.com/a/gh/issues/${n}`, body: '', createdAt: '2026-09-23T00:00:00Z', labels: [{ name: 'idd-ready' }] }));
  writeFileSync(stub, `#!${process.execPath}
const a = process.argv.slice(2);
const issues = ${JSON.stringify(issues)};
if (a[0] === 'issue') { console.log(JSON.stringify(issues)); process.exit(0); }
const m = /issues\\/(\\d+)$/.exec(a[a.length - 1]);
const it = m && issues.find((i) => i.number === Number(m[1]));
if (!it) { process.stderr.write('HTTP 404'); process.exit(1); }
console.log(JSON.stringify({ number: it.number, title: it.title, html_url: it.url, body: '', created_at: it.createdAt, state: 'open', labels: it.labels }));
`);
  chmodSync(stub, 0o755);
  const clone = (n) => ({ upstream: join(root, `u-${n}`), work: join(root, `w-${n}`) });
  const reposFile = join(root, 'repos.yaml');
  writeFileSync(reposFile, JSON.stringify({
    repos: {
      'a/gh': { ...clone('gh'), issue_lane: { context: 'personal', source_type_priority: 'github', intake_filter: { github_labels: ['idd-ready'] } } },
      'a/app': { ...clone('app'), issue_lane: { context: 'meltly', source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'] } } },
    },
  }));
  Object.assign(process.env, { IDD_REPOS_FILE: reposFile, IDD_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}`, IDD_LINEAR_KEY_FILE: join(root, 'no-such-key'), LINEAR_API_KEY: KEY });
  return { root, state };
}

const gh1 = { source: 'github', url: 'https://github.com/a/gh/issues/1', ref: '#1', title: 'gh 1', area: 'a/gh' };
// named by its URL without the title part and without Linear's own id: the same Issue as the one Linear lists
const app1 = { source: 'linear', url: 'https://linear.app/org/issue/APP-1', ref: 'APP-1', title: 'title of APP-1', area: 'a/app' };

test('an ignored Issue is left out of intake on both sources, named or not, and shows as skipped with the reason', async () => {
  setup();
  const linear = [node('APP-1', 'Todo'), node('APP-2', 'Todo')];
  assert.equal((await setIgnored('ignore', gh1)).ok, true);
  assert.equal((await setIgnored('ignore', app1)).ok, true);

  const list = await listIntakeCandidates({ linearFetch: fakeLinear(linear) });
  assert.deepEqual(list.candidates.map((c) => c.ref).sort(), ['#2', 'APP-2']);
  const skipped = Object.fromEntries(list.skipped.map((s) => [s.ref, s.reason]));
  assert.match(skipped['#1'], /無視リスト/);
  assert.match(skipped['APP-1'], /無視リスト/);

  const run = await runIntake({ linearFetch: fakeLinear(linear) });
  assert.equal(run.added.length, 2);
  assert.deepEqual(readBacklog().map((r) => r.gh_issue_url ?? r.linear_issue_url).sort(), ['https://github.com/a/gh/issues/2', 'https://linear.app/org/issue/APP-2']);

  // an Issue named on the command line is not taken in either
  const named = await runIntake({ issueRefs: [{ repo: 'a/gh', number: 1 }, { identifier: 'APP-1' }], linearFetch: fakeLinear(linear) });
  assert.deepEqual(named.added, []);
  assert.deepEqual(named.skipped.map((s) => s.ref).sort(), ['#1', 'APP-1']);

  // nothing was asked of Linear but reads
  assert.ok(sentBodies.length > 0);
  assert.equal(sentBodies.some((b) => /mutation/i.test(b.query)), false);
});

test('the last line for an Issue decides, and the list shows each Issue once', async () => {
  setup();
  await setIgnored('ignore', gh1);
  await setIgnored('ignore', app1);
  // ignoring an Issue already on the list writes nothing
  const again = await setIgnored('ignore', { ...app1, url: 'https://linear.app/org/issue/APP-1/title-of-app-1', linearId: 'uuid-APP-1' });
  assert.deepEqual(again, { ok: true, changed: false, target: again.target });
  assert.equal(readIgnores().length, 2);

  assert.equal((await setIgnored('unignore', gh1)).ok, true);
  assert.equal(isIgnored({ url: gh1.url }), false);
  assert.equal(isIgnored({ url: 'https://linear.app/org/issue/APP-1/other-title', linearId: 'uuid-APP-1' }), true);
  assert.deepEqual(listIgnored().map((i) => i.ref), ['APP-1']);
  // taking off what is not on the list is refused
  const off = await setIgnored('unignore', gh1);
  assert.equal(off.ok, false);
  assert.match(off.error, /無視リストにありません/);
  assert.equal(readIgnores().length, 3);
  assert.equal(intakeIgnoresPath(), join(process.env.IDD_STATE_DIR, 'intake-ignores.jsonl'));
});

test('an ignore closes an open lane first, puts its Issue on the list with the lane, and stops its sessions and runs right here', async () => {
  const { state } = setup();
  const linear = () => [node('APP-1', 'Todo')];
  await runIntake({ linearFetch: fakeLinear(linear()) });
  const lane = readBacklog().find((r) => r.source_type === 'linear').idd_id;
  const gh = readBacklog().find((r) => r.gh_issue_url === gh1.url).idd_id;
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: lane, worktree_path: '/w', branch: 'b', planner_session_id: 'P-1' }) + '\n');
  await appendLifecycle('s1_plan_review_started', lane, { run_ids: ['R-1', 'R-2'] });
  await appendLifecycle('s2_review_findings', lane, { run_id: 'R-3', whole_run_ids: ['R-4'] });
  const stopped = [];
  const held = [];
  setAgentRunner({
    deliver: async () => {},
    stopSession: async (id) => { held.push(laneGateHeld()); stopped.push(`session:${id}`); },
    stopRun: async (id) => { held.push(laneGateHeld()); stopped.push(`run:${id}`); },
  });
  try {
    // the ref is the lane's own ID: it is read as a lane before it is read as a Linear identifier
    const res = await ignoreByRef('ignore', lane);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.lane, lane);
    assert.equal(res.target.ref, 'APP-1');
    assert.equal(res.changed, true);
    assert.deepEqual(readLifecycle().filter((e) => e.idd_id === lane).map((e) => e.event).slice(-2), ['lane_close', 'lane_work_stopped']);
    const close = readLifecycle().filter((e) => e.idd_id === lane && e.event === 'lane_close').pop();
    assert.equal(close.attrs.outcome, 'aborted');
    assert.equal(close.attrs.via, 'ignore');
    const [line] = readIgnores();
    assert.deepEqual([line.action, line.ref, line.lane, line.at_by], ['ignore', 'APP-1', lane, 'ignore']);
    // the stop happens right here, and is kept on the lane as a note (an event that moves no stage)
    assert.deepEqual(stopped.sort(), ['run:R-1', 'run:R-2', 'run:R-3', 'run:R-4', 'session:P-1']);
    const note = readLifecycle().filter((e) => e.idd_id === lane && e.event === 'lane_work_stopped').pop();
    assert.deepEqual([note.attrs.via, note.attrs.sessions, note.attrs.runs], ['ignore', ['P-1'], ['R-1', 'R-2', 'R-3', 'R-4']]);
    // the stop waits on the runtime with the lane gate free: another lane's writes are not held up by it
    assert.deepEqual([...new Set(held)], [false]);
  } finally {
    setAgentRunner(null);
  }

  // an ignore of the other lane's Issue by its ref closes that lane too: what is named by an Issue reaches it
  assert.equal((await ignoreByRef('ignore', '#1')).ok, true);
  assert.deepEqual(readIgnores().map((l) => l.ref), ['APP-1', '#1']);
  assert.equal(readLifecycle().filter((e) => e.idd_id === gh && e.event === 'lane_close').length, 1);
  // past its GO there is no separate stop any more: the same ignore closes the lane
  for (const event of ['s1_ready', 's1_plan_review_skipped', 's1_go']) await seedLifecycle(event, gh, {});
  assert.equal((await ignoreLane(gh)).ok, false, 'the lane is already closed');
});

test('an ignore of an Issue with no lane only puts it on the list, and one already on the list adds no line', async () => {
  const { state } = setup();
  const linear = [node('APP-1', 'Todo'), node('APP-7', 'Todo')];
  await runIntake({ linearFetch: fakeLinear([node('APP-1', 'Todo')]) });
  const laneWithoutIssue = 'IDD-900';
  writeFileSync(join(state, 'backlog.jsonl'), readFileSync(join(state, 'backlog.jsonl'), 'utf8') + JSON.stringify({ idd_id: laneWithoutIssue, parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'no issue', area: 'a/gh' }) + '\n');
  await appendLifecycle('lane_open', laneWithoutIssue, {});

  // APP-7 is only a candidate of intake: no lane changes, one line is added
  const before = readLifecycle().length;
  const candidate = await ignoreByRef('ignore', 'APP-7', { linearFetch: fakeLinear(linear) });
  assert.equal(candidate.ok, true, candidate.error);
  assert.equal(candidate.lane, undefined);
  assert.deepEqual(listIgnored().map((i) => i.ref), ['APP-7']);
  assert.equal(readLifecycle().length, before, 'nothing is recorded on any lane');

  // a lane taken in from no Issue is closed, and has nothing to put on the list
  const res = await ignoreByRef('ignore', laneWithoutIssue);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.target, undefined);
  assert.equal(res.changed, false);
  assert.equal(readIgnores().length, 1);
  assert.equal(readLifecycle().filter((e) => e.idd_id === laneWithoutIssue && e.event === 'lane_close').length, 1);

  // an Issue already on the list is not added again, and its open lane is still closed
  await setIgnored('ignore', gh1);
  const lane = readBacklog().find((r) => r.gh_issue_url === gh1.url).idd_id;
  const again = await ignoreByRef('ignore', lane);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.changed, false);
  assert.equal(readIgnores().length, 2);
});

test('an ignore the close refuses, or that finds the gate busy, puts nothing on the list', async () => {
  const { state } = setup();
  await runIntake({ linearFetch: fakeLinear([]) });
  const closed = readBacklog().find((r) => r.gh_issue_url === gh1.url).idd_id;
  const open = readBacklog().find((r) => r.gh_issue_url === 'https://github.com/a/gh/issues/2').idd_id;
  // a lane closed already (merged, say): the close is refused, and its Issue stays off the list
  await seedLifecycle('lane_close', closed, { outcome: 'merged' });
  const refused = await ignoreLane(closed);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /既に閉じています/);
  assert.deepEqual(readIgnores(), []);

  // another process holds the gate for the whole wait: nothing is written, and nothing goes on the list
  process.env.IDD_LANE_GATE_WAIT_MS = '300';
  const path = join(state, LANE_GATE_FILE);
  if (!existsSync(path)) writeFileSync(path, '');
  const release = await lockfile.lock(path, { stale: LANE_GATE_STALE_MS });
  try {
    const busy = await ignoreByRef('ignore', open);
    assert.equal(busy.ok, false);
    assert.match(busy.error, /ほかの処理が lane を更新中/);
  } finally {
    await release();
    delete process.env.IDD_LANE_GATE_WAIT_MS;
  }
  assert.equal(readLifecycle().filter((e) => e.idd_id === open && e.event === 'lane_close').length, 0);
  assert.deepEqual(readIgnores(), []);

  // once the gate is free the same ignore goes through and puts the Issue on the list
  assert.equal((await ignoreByRef('ignore', open)).ok, true);
  assert.deepEqual(readIgnores().map((l) => [l.ref, l.lane, l.at_by]), [['#2', open, 'ignore']]);
});

test('a ref puts an Issue whose lane is already closed on the list: the lane is not written again, and the lane ID is still refused', async () => {
  const { state } = setup();
  await runIntake({ linearFetch: fakeLinear([node('APP-1', 'Todo')]) });
  const gh = readBacklog().find((r) => r.gh_issue_url === gh1.url).idd_id;
  const app = readBacklog().find((r) => r.source_type === 'linear').idd_id;
  // both lanes are closed: merged, and aborted by an ignore whose list write failed (so nothing is on the list)
  await seedLifecycle('lane_close', gh, { outcome: 'merged' });
  await seedLifecycle('lane_close', app, { outcome: 'aborted', via: 'ignore' });
  const before = readLifecycle().length;

  // the ref puts the Issue on the list without touching a lane: the lane's close was what penne asked for, not the list
  const byRef = await ignoreByRef('ignore', '#1');
  assert.equal(byRef.ok, true, byRef.error);
  assert.equal(byRef.lane, undefined, 'no lane is closed by a ref whose lanes are all closed');
  assert.equal(byRef.changed, true);
  assert.deepEqual(listIgnored().map((i) => i.ref), ['#1']);
  assert.equal(readLifecycle().length, before, 'nothing is written on the lane');
  assert.equal(readLifecycle().filter((e) => e.idd_id === gh && e.event === 'lane_close').length, 1, 'the close is not written twice');

  // the lane's own ID is the form that closes that lane: an already closed one is refused, and writes nothing
  const byId = await ignoreByRef('ignore', app);
  assert.equal(byId.ok, false);
  assert.match(byId.error, /既に閉じています/);
  assert.deepEqual(listIgnored().map((i) => i.ref), ['#1'], 'the refused ID ignore puts nothing on the list');
  // and the same ref puts that Issue on too
  const byRef2 = await ignoreByRef('ignore', 'APP-1', { linearFetch: fakeLinear([node('APP-1', 'Todo')]) });
  assert.equal(byRef2.ok, true, byRef2.error);
  assert.deepEqual(listIgnored().map((i) => i.ref).sort(), ['#1', 'APP-1']);
  assert.ok(existsSync(join(state, 'intake-ignores.jsonl')));
});

test('an ignore stops what is running now: an ended session or run is neither stopped nor written to the lane note', async () => {
  const { state } = setup();
  await runIntake({ linearFetch: fakeLinear([node('APP-1', 'Todo')]) });
  const lane = readBacklog().find((r) => r.source_type === 'linear').idd_id;
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: lane, worktree_path: '/w', branch: 'b', planner_session_id: 'P-run' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: lane, worktree_path: '/w', branch: 'b', executor_session_id: 'E-done' }) + '\n');
  await appendLifecycle('s2_review_started', lane, { run_ids: ['R-run', 'R-done'] });
  const stopped = [];
  const asked = [];
  setAgentRunner({
    deliver: async () => {},
    sessionStatus: async (id) => { asked.push(id); return id === 'P-run' ? { state: 'running' } : { state: 'stopped', cause: 'finished', at: '2026-09-27T00:00:00Z' }; },
    reviewRunStatus: (id) => (id === 'R-run' ? { state: 'running' } : { state: 'failed', error: 'lane stopped' }),
    stopSession: async (id) => { stopped.push(`session:${id}`); },
    stopRun: async (id) => { stopped.push(`run:${id}`); },
  });
  try {
    const res = await ignoreLane(lane);
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(asked.sort(), ['E-done', 'P-run'], 'every session is asked about first');
    assert.deepEqual(stopped, ['session:P-run', 'run:R-run'], 'only what was running is stopped');
    assert.deepEqual([res.stopped.sessions, res.stopped.runs], [['P-run'], ['R-run']]);
    const note = readLifecycle().filter((e) => e.idd_id === lane && e.event === 'lane_work_stopped').pop();
    assert.deepEqual([note.attrs.sessions, note.attrs.runs], [['P-run'], ['R-run']], 'what was not stopped is not on the note');
  } finally {
    setAgentRunner(null);
  }
});

test('the duplicate card cancel puts the incoming Issue on the list from either shape of the judgement line, and writes nothing outside', async () => {
  const { state } = setup();
  const written = `https://github.com/a/gh/issues/9`;
  const before = sentBodies.length;
  // the shape intake writes (incoming) and the shape the reader's own type names (candidate)
  writeFileSync(join(state, 'pending-reviews.jsonl'), [
    JSON.stringify({ review_id: 'REV-001', opened_at: '2026-09-26T09:00:00+09:00', incoming: { title: 'gh nine', url: written }, existing_idd_id: 'IDD-001', similarity: 0.9, detection_method: 'semantic' }),
    JSON.stringify({ review_id: 'REV-002', detected_at: '2026-09-26T09:01:00+09:00', candidate: { source_type: 'github', gh_issue_url: written, title: 'gh nine', context: '', area: 'a/gh' }, suspected_duplicate_of: ['IDD-001'], detection_method: 'semantic', detection_reason: 'same ask' }),
  ].join('\n') + '\n');
  const first = await ignorePendingReview('REV-001');
  assert.equal(first.ok, true, first.error);
  assert.equal(first.target.ref, '#9');
  assert.equal(first.target.source, 'github');
  assert.equal(readIgnores().length, 1);
  const resolved = readLifecycle().filter((e) => e.event === 'pending_review_resolved');
  assert.deepEqual(resolved.map((e) => [e.idd_id, e.attrs.review_id, e.attrs.outcome]), [['REV-001', 'REV-001', 'ignore']]);

  // the same Issue from the other shape: the line is already there, and the judgement is recorded all the same
  const second = await ignorePendingReview('REV-002');
  assert.equal(second.ok, true, second.error);
  assert.equal(second.target.url, written);
  assert.equal(readIgnores().length, 1, 'the same Issue is not put on twice');
  assert.equal(readLifecycle().filter((e) => e.event === 'pending_review_resolved').length, 2);
  assert.equal(sentBodies.length, before, 'nothing is asked of Linear');
  assert.deepEqual(listIgnored().map((i) => i.ref), ['#9']);

  const unknown = await ignorePendingReview('REV-999');
  assert.equal(unknown.ok, false);
});

test('a ref is resolved from the lanes, then the list, then what intake reads now', async () => {
  setup();
  const linear = [node('APP-1', 'Todo'), node('APP-7', 'Todo')];
  await runIntake({ linearFetch: fakeLinear([node('APP-1', 'Todo')]) });

  // #1 is a lane's Issue; APP-7 is only a candidate of intake
  const byLane = await ignoreByRef('ignore', '#1', { linearFetch: fakeLinear(linear) });
  assert.equal(byLane.ok, true);
  assert.equal(byLane.target.url, gh1.url);
  const byCandidate = await ignoreByRef('ignore', 'APP-7', { linearFetch: fakeLinear(linear) });
  assert.equal(byCandidate.ok, true);
  assert.equal(byCandidate.target.title, 'title of APP-7');
  assert.deepEqual(listIgnored().map((i) => i.ref), ['#1', 'APP-7']);

  const unknown = await ignoreByRef('ignore', 'APP-99', { linearFetch: fakeLinear(linear) });
  assert.equal(unknown.ok, false);
  const bad = await ignoreByRef('ignore', 'not a ref');
  assert.equal(bad.ok, false);

  // taking off is looked up on the list alone
  assert.equal((await ignoreByRef('unignore', 'APP-7')).ok, true);
  assert.equal((await ignoreByRef('unignore', 'APP-7')).ok, false);
});

test('an Issue put on by hand from what intake reads keeps Linear\'s id, so a move to another team does not bring it back', async () => {
  const { root } = setup();
  // the Linear repo takes both teams in
  const reposFile = join(root, 'repos.yaml');
  const repos = JSON.parse(readFileSync(reposFile, 'utf8'));
  repos.repos['a/app'].issue_lane.intake_filter.linear_teams = ['APP', 'WEB'];
  writeFileSync(reposFile, JSON.stringify(repos));

  const before = [node('APP-7', 'Todo')];
  const listed = await listIntakeCandidates({ linearFetch: fakeLinear(before) });
  assert.equal(listed.candidates.find((c) => c.ref === 'APP-7').linearId, 'uuid-APP-7');
  const on = await ignoreByRef('ignore', 'APP-7', { linearFetch: fakeLinear(before) });
  assert.equal(on.ok, true);
  assert.equal(on.target.linearId, 'uuid-APP-7');
  assert.equal(readIgnores()[0].linear_id, 'uuid-APP-7');

  // moved to team WEB on Linear: a new identifier and URL, the same id
  const moved = [{ ...node('WEB-3', 'Todo'), id: 'uuid-APP-7' }];
  const after = await listIntakeCandidates({ linearFetch: fakeLinear(moved) });
  assert.deepEqual(after.candidates.filter((c) => c.source === 'linear').map((c) => c.ref), []);
  const skipped = after.skipped.find((s) => s.ref === 'WEB-3');
  assert.match(skipped.reason, /無視リスト/);
  // the way to take it off names it as the list does
  assert.match(skipped.reason, /idd unignore APP-7/);
  assert.equal((await ignoreByRef('unignore', 'APP-7')).ok, true);
});

test('creating the list does not cut a line another writer appended between the check and the create', async () => {
  setup();
  const path = intakeIgnoresPath();
  const other = { action: 'ignore', source: 'github', url: 'https://github.com/a/gh/issues/2', ref: '#2', title: 'gh 2', area: 'a/gh', at: '2026-09-26T09:00:00+09:00', at_by: 'user' };
  const real = fs.existsSync;
  let raced = false;
  // another process creates the list and appends its line right after this one found no file
  fs.existsSync = (p) => {
    const found = real(p);
    if (p === path && !raced) {
      raced = true;
      fs.appendFileSync(path, `${JSON.stringify(other)}\n`);
    }
    return found;
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await setIgnored('ignore', gh1)).ok, true);
  } finally {
    fs.existsSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(raced, true);
  assert.deepEqual(listIgnored().map((i) => i.ref), ['#2', '#1']);
});

test('the read the screen shows matches what the press does: a closed lane ID is refused and says so, an Issue ref only writes the list', async () => {
  setup();
  await runIntake({ linearFetch: fakeLinear([node('APP-1', 'Todo')]) });
  const gh = readBacklog().find((r) => r.gh_issue_url === gh1.url).idd_id;
  await seedLifecycle('lane_close', gh, { outcome: 'merged' });
  const before = readLifecycle().length;

  // the lane's own ID: the read says the close will be refused, and the write does exactly that without writing anything
  const byId = ignorePreview(gh);
  assert.deepEqual([byId.via, byId.lane, byId.closed], ['lane', undefined, gh]);
  const refused = await ignoreByRef('ignore', gh, { confirmedLane: null });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /既に閉じています/, 'the press is told what the read said');
  assert.equal(readIgnores().length, 0);
  assert.equal(readLifecycle().length, before);

  // an Issue's ref of the same lane: the read says only the list is written, and the write does that
  const byRef = ignorePreview('#1');
  assert.deepEqual([byRef.via, byRef.lane, byRef.closed], ['issue', undefined, gh]);
  const written = await ignoreByRef('ignore', '#1', { confirmedLane: null });
  assert.equal(written.ok, true, written.error);
  assert.deepEqual(listIgnored().map((i) => i.ref), ['#1']);
  assert.equal(readLifecycle().length, before, 'the lane is not written');
  // and the read now says the lane is closed, with the Issue on the list
  assert.equal(ignorePreview('#1').closed, gh);
});

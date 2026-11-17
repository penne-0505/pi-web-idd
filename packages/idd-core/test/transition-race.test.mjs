import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { deriveStage, PLANNER_SENT_BACK } from '../src/ledger/derive.ts';
import { applyDecision } from '../src/ledger/write.ts';
import { ignoreLane } from '../src/intake/ignore.ts';
import { readBacklog, readLifecycle } from '../src/ledger/read.ts';
import { runIntake } from '../src/intake/run.ts';

const ev = (event, attrs = {}, id = 'IDD-1') => ({ event, idd_id: id, at: '2026-09-01T10:00:00+09:00', attrs });

/** a state holding one lane with the given records: its backlog row names the area its lifecycle file belongs to */
function laneWith(events) {
  const root = scratchDir('lane-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', parent_id: null, created_at: '2026-09-01T00:00:00+09:00', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'demo' }) + '\n');
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { root, state };
}

/** a lane whose plan passed its review: the GO card is up */
const atGo = () => [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 0, should: 0, nit: 0 })];

const laneEvents = (id = 'IDD-1') => readLifecycle().filter((e) => e.idd_id === id);
const count = (name, id = 'IDD-1') => laneEvents(id).filter((e) => e.event === name).length;

test('a GO that reaches a lane penne sent back from an old screen is refused, and the plan being fixed does not go to the executor', async () => {
  laneWith([...atGo(), ev('s1_revise_requested', { instruction: 'AC を分ける', at_by: 'user' })]);
  assert.equal(deriveStage(laneEvents()).blockedBy, PLANNER_SENT_BACK);
  const go = await applyDecision('s1_go', { iddId: 'IDD-1' });
  assert.equal(go.ok, false, 'the GO is refused');
  assert.match(go.error ?? '', /GO 待ちではありません/);
  assert.equal(count('s1_go'), 0, 'nothing is recorded');
  assert.equal(deriveStage(laneEvents()).group, 'prep', 'the lane still waits for the planner');
});

test('a GO and a send-back pressed together: exactly one goes through, in either order', async () => {
  for (let round = 0; round < 5; round += 1) {
    for (const order of ['go-first', 'revise-first']) {
      laneWith(atGo());
      const go = () => applyDecision('s1_go', { iddId: 'IDD-1' });
      const revise = () => applyDecision('s1_revise', { iddId: 'IDD-1', instruction: 'DEC を 2 つに分けて' });
      const results = order === 'go-first' ? await Promise.all([go(), revise()]) : (await Promise.all([revise(), go()])).reverse();
      const passed = results.filter((r) => r.ok).length;
      assert.equal(passed, 1, `${order} (round ${round}): ${JSON.stringify(results)}`);
      assert.equal(count('s1_go') + count('s1_revise_requested'), 1, 'one of the two is recorded');
      const refused = results.find((r) => !r.ok);
      assert.match(refused.error ?? '', /GO 待ちではありません/);
    }
  }
});

test('a GO from an old screen is refused once the lane was ignored: a closed lane is not sent on', async () => {
  laneWith(atGo());
  assert.equal((await ignoreLane('IDD-1', { reason: 'not now' })).ok, true);
  const go = await applyDecision('s1_go', { iddId: 'IDD-1' });
  assert.equal(go.ok, false, 'the GO of a card left open is refused');
  assert.match(go.error ?? '', /GO 待ちではありません/);
  assert.equal(count('s1_go'), 0, 'nothing is recorded');
  assert.equal(count('lane_close'), 1, 'the lane stays closed');
});

test('an ignore after a GO still closes the lane: GO and then a stop is the same two presses as before', async () => {
  laneWith(atGo());
  assert.equal((await applyDecision('s1_go', { iddId: 'IDD-1' })).ok, true);
  const ignored = await ignoreLane('IDD-1', { reason: 'changed my mind' });
  assert.equal(ignored.ok, true, ignored.error);
  assert.equal(count('lane_close'), 1);
  assert.equal(deriveStage(laneEvents()).group, 'closed');
});

test('a lane is closed once: a second ignore pressed alongside is refused', async () => {
  laneWith([...atGo(), ev('s1_go')]);
  const results = await Promise.all([ignoreLane('IDD-1'), ignoreLane('IDD-1')]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(count('lane_close'), 1);
});

const KEY = 'lin_api_TESTSECRET_transition';

/** a Linear that returns the same assigned Issue to every run */
function linearWith(identifier) {
  const node = {
    id: `uuid-${identifier}`, identifier, title: `title of ${identifier}`, description: '',
    url: `https://linear.app/org/issue/${identifier}/title`, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
    team: { key: identifier.split('-')[0] }, state: { name: 'Todo' }, labels: { nodes: [] },
  };
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.variables.id !== undefined) return { ok: true, status: 200, json: async () => ({ data: { issue: node } }) };
    // both runs are past the read before either writes
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: 200, json: async () => ({ data: { viewer: { assignedIssues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: '1' } } } } }) };
  };
}

function linearRepo() {
  const root = scratchDir('intake-');
  const state = join(root, 'state'); mkdirSync(state);
  const repos = join(root, 'repos.yaml');
  writeFileSync(repos, JSON.stringify({ repos: { 'a/app': { upstream: join(root, 'u'), work: join(root, 'w'), issue_lane: { context: 'meltly', source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'] } } } } }));
  Object.assign(process.env, { IDD_REPOS_FILE: repos, IDD_STATE_DIR: state, IDD_LINEAR_KEY_FILE: join(root, 'no-such-key'), LINEAR_API_KEY: KEY });
  return { root, state };
}

test('two intakes that read the same Issue at once open one lane, under one number', async () => {
  linearRepo();
  const [a, b] = await Promise.all([runIntake({ linearFetch: linearWith('APP-7') }), runIntake({ linearFetch: linearWith('APP-7') })]);
  assert.equal(a.added.length + b.added.length, 1, JSON.stringify({ a: a.added, b: b.added }));
  assert.equal(a.duplicates.length + b.duplicates.length, 1, 'the second run finds the lane the first opened');
  assert.equal(readBacklog().length, 1);
  assert.equal(readLifecycle().filter((e) => e.event === 'lane_open').length, 1);
});

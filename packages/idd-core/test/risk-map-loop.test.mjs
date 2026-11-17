import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { slotWaits } from '../src/plan/slot-wait.ts';
import { getAgentRunner as getRunner, setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle, readSessions } from '../src/ledger/read.ts';
import { reviewLoopLabel, reviewLoopState } from '../src/ledger/review-loop.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { appendReviewEvent, openReviewLane, readReviewLane } from '../src/review-lane/store.ts';
import { reviewLaneLabel, reviewLaneState } from '../src/review-lane/state.ts';
import { runReviewLanes } from '../src/review-lane/run.ts';
import { tmpDir } from './helpers/tmp.mjs';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });
const ROUTES = [{ id: 'R-1', paths: ['lib/pay.dart', 'lib/view.dart'], question: '見せている値と送る値が同じ', harms: ['shown_vs_sent'] }];

function setup(pipelineYaml) {
  const state = tmpDir('idd-map-loop-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipelineYaml}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-map-loop-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

const MAPPED = '  review_blind: { roles: [r, r] }\n  risk_map: { role: r }\n  triage: { role: r }\n  confirm: { role: r }\n';

/** a fake runner: the map answers with `map` (a run, a skip, or a throw); every run's status is set by the test */
function fakeRunner({ map = 'run' } = {}) {
  const calls = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls.push(o);
      if (o.stage === 'map') {
        if (map === 'skip') return { runIds: [], skipped: '差分 12 行（閾値 1000 行未満）' };
        if (map === 'throw') throw new Error('map の role がない');
      }
      const n = o.stage === 'blind' ? (o.routes?.length ?? 0) + 1 : 1;
      const ids = Array.from({ length: n }, (_, i) => `${o.stage}-${calls.length}-${i}`);
      for (const id of ids) status[id] = { state: 'running' };
      if (!o.routes?.length) return { runIds: ids };
      const labels = [...o.routes.map((_, i) => `r${i + 1}`), 'rest'];
      return { runIds: ids, runLabels: labels, wholeDiff: [ids[ids.length - 1]], routeCount: o.routes.length, routesOverCap: false };
    },
    reviewRunStatus: (id) => status[id],
  });
  return { calls, status };
}

const last = () => readLifecycle().at(-1);

test('the loop reads the map from the lifecycle: running while it runs, then the blind round with its routes', () => {
  const base = [ev('s1_go'), ev('s2_start'), ev('s2_result')];
  const running = [...base, ev('s2_map_started', { kind: 'blind', round: 1, run_id: 'm' })];
  assert.deepEqual(reviewLoopState(running), { state: 'running_map', kind: 'blind', round: 1, runId: 'm' });
  assert.equal(reviewLoopLabel(reviewLoopState(running)), '危ない経路の下調べ中');
  assert.equal(deriveStage(running).blockedBy, '危ない経路の下調べ中');
  const done = [...running, ev('s2_map_done', { kind: 'blind', round: 1, routes: ROUTES })];
  assert.deepEqual(reviewLoopState(done), { state: 'start_blind', kind: 'blind', round: 1, map: { routes: ROUTES } });
  // a map that failed leaves the round to the blind as it always ran
  const failed = [...running, ev('s2_map_done', { kind: 'final', round: 2, failed: true, error: 'x' })];
  assert.deepEqual(reviewLoopState(failed), { state: 'start_blind', kind: 'final', round: 2, map: { routes: [] } });
  // a stray result while the map runs does not restart the loop
  assert.equal(reviewLoopState([...running, ev('s2_result')]).state, 'running_map');
});

test('a large diff: the map runs first, and its routes go to the blind round', async () => {
  setup(MAPPED);
  const { calls, status } = fakeRunner();
  await runReviewLoop();
  assert.equal(last().event, 's2_map_started');
  assert.deepEqual(calls.map((c) => c.stage), ['map']);
  await runReviewLoop();
  assert.equal(last().event, 's2_map_started', 'waits for the map');
  status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLoop();
  assert.equal(last().event, 's2_map_done');
  assert.deepEqual(last().attrs.routes, ROUTES);
  assert.equal(last().attrs.report_md, '/m.md');
  await runReviewLoop();
  assert.equal(last().event, 's2_review_started');
  assert.deepEqual(calls.at(-1).routes, ROUTES);
  assert.equal(last().attrs.run_ids.length, 2, 'one blind for the route and one for the leftovers');
  // the findings of every blind go to the one triage, as before
  for (const id of last().attrs.run_ids) status[id] = { state: 'done', reportJson: `/${id}.json`, reportMd: `/${id}.md`, findings: [] };
  await runReviewLoop();
  assert.equal(last().event, 's2_review_findings');
  assert.equal(last().attrs.files.length, 2);
  setAgentRunner(null);
});

test('a diff below the threshold starts the blind round in the same tick, with no map on record', async () => {
  setup(MAPPED);
  const { calls } = fakeRunner({ map: 'skip' });
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => c.stage), ['map', 'blind']);
  assert.equal(calls[1].routes, undefined);
  assert.equal(last().event, 's2_review_started');
  assert.equal(last().attrs.map_skipped, '差分 12 行（閾値 1000 行未満）');
  assert.ok(!readLifecycle().some((e) => e.event.startsWith('s2_map_')));
  setAgentRunner(null);
});

test('a map that cannot start is recorded and the blind round goes on without it', async () => {
  setup(MAPPED);
  const { calls } = fakeRunner({ map: 'throw' });
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => c.stage), ['map', 'blind']);
  const events = readLifecycle().map((e) => e.event);
  assert.deepEqual(events.slice(-2), ['s2_map_done', 's2_review_started']);
  assert.equal(readLifecycle().at(-2).attrs.failed, true);
  assert.ok(!events.includes('s2_review_run_failed'), 'the map failing is not a failure to start the review');
  setAgentRunner(null);
});

test('a map that fails leaves the round to the blind as it always ran', async () => {
  setup(MAPPED);
  const { calls, status } = fakeRunner();
  await runReviewLoop();
  status['map-1-0'] = { state: 'failed', error: 'timeout' };
  await runReviewLoop();
  assert.equal(last().event, 's2_map_done');
  assert.equal(last().attrs.failed, true);
  await runReviewLoop();
  assert.equal(last().event, 's2_review_started');
  assert.equal(calls.at(-1).routes, undefined);
  setAgentRunner(null);
});

test('without pipeline.risk_map the blind round runs as it always did', async () => {
  setup('  review_blind: { roles: [r, r] }\n  triage: { role: r }\n');
  const { calls } = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => c.stage), ['blind']);
  assert.equal(last().attrs.map_skipped, undefined);
  setAgentRunner(null);
});

/** a lane whose first blind round is judged with nothing to fix: the next state is the final blind */
function atFinal(state, extra = []) {
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [
    ev('s1_go'), ev('s2_start', { started_from_commit: readLifecycle()[1].attrs.started_from_commit }), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [] }),
    ...extra,
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('the final blind reads the whole diff with every role: it is never routed', async () => {
  const state = setup(MAPPED);
  atFinal(state);
  const { calls } = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => c.stage), ['final']);
  assert.equal(calls[0].routes, undefined);
  assert.equal(last().event, 's2_review_started');
  assert.equal(last().attrs.kind, 'final');
  setAgentRunner(null);
});

test('a map of a final blind left on record does not route it either', async () => {
  const state = setup(MAPPED);
  atFinal(state, [ev('s2_map_started', { kind: 'final', round: 1, run_id: 'm' }), ev('s2_map_done', { kind: 'final', round: 1, routes: ROUTES })]);
  const { calls } = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => c.stage), ['final']);
  assert.equal(calls[0].routes, undefined);
  setAgentRunner(null);
});

test('a second blind of the same pass is not routed: the map runs only before the pass\'s first blind (AC-005)', async () => {
  const state = setup(MAPPED);
  const head = readLifecycle().find((e) => e.event === 's2_start').attrs.started_from_commit;
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [
    ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result'),
    // a depth-bearing pass: its first blind recorded the depth, then a fix and a new result put the round back at a blind
    // (the round read the head before the fix; the fix moved it to the head the worktree is at now)
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'], head: 'head-before-the-fix', depth: 'deep', max_fix_rounds: 3, close_on: 'must' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'x' }] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1'] }),
    ev('s2_result', { outcome: 'success' }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const { calls } = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => c.stage), ['blind']);
  assert.equal(calls[0].routes, undefined);
  setAgentRunner(null);
});

test("the map role is handed the lane's request: the work instruction and the qa (AC-004)", async () => {
  setup(MAPPED);
  const wt = readSessions('executor').find((r) => r.idd_id === 'IDD-001').worktree_path;
  mkdirSync(join(wt, '_docs', 'plan', 'Demo', 'idd-001'), { recursive: true });
  writeFileSync(join(wt, '_docs', 'plan', 'Demo', 'idd-001', 'plan.md'), '# 作業指示\n');
  mkdirSync(join(wt, '_docs', 'qa', 'Demo', 'idd-001'), { recursive: true });
  writeFileSync(join(wt, '_docs', 'qa', 'Demo', 'idd-001', 'qa.md'), '- AC-001: x\n');
  const { calls } = fakeRunner();
  await runReviewLoop();
  const map = calls.find((c) => c.stage === 'map');
  assert.ok(map.inputs.some((p) => p.endsWith('_docs/plan/Demo/idd-001/plan.md')));
  assert.ok(map.inputs.some((p) => p.endsWith('_docs/qa/Demo/idd-001/qa.md')));
  setAgentRunner(null);
});

/** a lane whose round-1 route blinds of a map run now: the route blinds first, then the leftovers one */
async function routedRoundRunning() {
  setup(MAPPED);
  const runner = fakeRunner();
  await runReviewLoop();
  runner.status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLoop(); await runReviewLoop();
  assert.equal(last().event, 's2_review_started');
  return runner;
}

test('a routed round records which of its blinds reads the whole diff', async () => {
  await routedRoundRunning();
  const started = last().attrs;
  assert.equal(started.mapped_routes, 1);
  assert.equal(started.route_count, 1);
  assert.deepEqual(started.whole_run_ids, [started.run_ids[1]]);
  setAgentRunner(null);
});

test('a routed round whose leftovers blind fails runs the round again over the whole diff, without the map', async () => {
  const { calls, status } = await routedRoundRunning();
  const [route, rest] = last().attrs.run_ids;
  status[rest] = { state: 'failed', error: 'timeout' };
  status[route] = { state: 'done', reportJson: '/r1.json', reportMd: '/r1.md', findings: [] };
  await runReviewLoop();
  // the route blind alone does not stand for the whole face, so its findings are not judged on their own
  assert.ok(!readLifecycle().some((e) => e.event === 's2_review_findings'));
  assert.equal(last().event, 's2_map_dropped');
  assert.equal(last().attrs.kind, 'blind');
  assert.equal(last().attrs.round, 1);
  assert.ok(last().attrs.reason);
  assert.deepEqual(reviewLoopState(readLifecycle()), { state: 'start_blind', kind: 'blind', round: 1, map: { routes: [] } });
  await runReviewLoop();
  assert.equal(last().event, 's2_review_started');
  assert.equal(calls.at(-1).stage, 'blind');
  assert.equal(calls.at(-1).routes, undefined);
  assert.equal(calls.filter((c) => c.stage === 'map').length, 1, 'the map is not drawn again');
  // the map only says where to look: the harness's rules over the repo's go to the blinds, not to it
  assert.equal(calls.find((c) => c.stage === 'map').norms, undefined);
  assert.equal(calls.find((c) => c.stage === 'map').iddNorms, undefined);
  assert.ok(calls.at(-1).norms?.length, 'the blind after the map is told them');
  assert.equal(calls.at(-1).iddNorms, undefined, 'the folded line is the one place it is told');
  assert.equal(last().attrs.whole_run_ids, undefined);
  setAgentRunner(null);
});

test('a routed round goes on to the triage when the leftovers blind finished, even if a route blind failed', async () => {
  const { status } = await routedRoundRunning();
  const [route, rest] = last().attrs.run_ids;
  status[rest] = { state: 'done', reportJson: '/rest.json', reportMd: '/rest.md', findings: [] };
  status[route] = { state: 'failed', error: 'timeout' };
  await runReviewLoop();
  assert.equal(last().event, 's2_review_findings');
  assert.deepEqual(last().attrs.files, ['/rest.json']);
  // the route that was not read is left on the record, so the judgement and a person can see it
  assert.deepEqual(last().attrs.unread_routes, ['r1']);
  setAgentRunner(null);
});

test('a map starts while the blind cap is full: the map holds none of the blind copies, and the blind waits for its own cap', async () => {
  const state = setup('  review_blind: { roles: [r], concurrency: 1 }\n  risk_map: { role: r }\n');
  writeFileSync(join(state, 'backlog.jsonl'), [
    JSON.stringify({ idd_id: 'IDD-000', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/0', pull_req_url: null, source_type: 'github', context: '', title: 'T0', area: 'Demo' }),
    JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }),
  ].join('\n') + '\n');
  const other = (e, a) => ({ ...ev(e, a), idd_id: 'IDD-000' });
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), readLifecycle().map((e) => JSON.stringify(e)).concat([other('s1_go'), other('s2_start'), other('s2_result'), other('s2_review_started', { kind: 'blind', round: 1, run_ids: ['busy'] })].map((e) => JSON.stringify(e))).join('\n') + '\n');
  const { calls, status } = fakeRunner();
  status.busy = { state: 'running' };
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => `${c.iddId}:${c.stage}`), ['IDD-001:map']);
  // the map done, the blind is judged by the blind cap, which the other lane still holds
  const mapId = calls[0] && Object.keys(status).find((id) => id.startsWith('map-'));
  status[mapId] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLoop();
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => `${c.iddId}:${c.stage}`), ['IDD-001:map']);
  status.busy = { state: 'done', findings: [] };
  setAgentRunner(null);
});

function setupReview(pipelineYaml) {
  const state = tmpDir('idd-map-rev-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipelineYaml}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
}

function reviewRunner({ map = 'run', ctx = [] } = {}) {
  const calls = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    prStatus: () => ({ head: 'h1', state: 'OPEN', title: 'PR', url: 'u' }),
    preparePrWorktree: async () => ({ path: '/wt/rev', head: 'h1', base: 'b0' }),
    fetchPrContext: () => ({ files: ctx }),
    startReviewRun: async (o) => {
      calls.push(o);
      if (o.stage === 'map' && map === 'skip') return { runIds: [], skipped: '差分 5 行（閾値 1000 行未満）' };
      if (o.stage === 'map' && map === 'throw') throw new Error('boom');
      const n = o.stage === 'blind' ? (o.routes?.length ?? 0) + 1 : 1;
      const ids = Array.from({ length: n }, (_, i) => `${o.stage}-${calls.length}-${i}`);
      for (const id of ids) status[id] = { state: 'running' };
      if (!o.routes?.length) return { runIds: ids };
      const labels = [...o.routes.map((_, i) => `r${i + 1}`), 'rest'];
      return { runIds: ids, runLabels: labels, wholeDiff: [ids[ids.length - 1]], routeCount: o.routes.length, routesOverCap: false };
    },
    reviewRunStatus: (id) => status[id],
  });
  return { calls, status };
}

test('a review lane hands its map role the PR body, comments and existing reviews (AC-004)', async () => {
  setupReview(MAPPED);
  openReviewLane({ repo: 'o/r', pr: 50 });
  const { calls } = reviewRunner({ ctx: ['/ctx/pr-body.md'] });
  await runReviewLanes(); await runReviewLanes();
  const map = calls.find((c) => c.stage === 'map');
  assert.deepEqual(map.inputs, ['/ctx/pr-body.md']);
  setAgentRunner(null);
});

test('a review lane maps a large PR first, then runs the blinds of its routes', async () => {
  setupReview(MAPPED);
  const rec = openReviewLane({ repo: 'o/r', pr: 7 });
  const { calls, status } = reviewRunner();
  const st = () => reviewLaneState(readReviewLane(rec.id));
  await runReviewLanes(); assert.equal(st().state, 'start_blind');
  await runReviewLanes(); assert.equal(st().state, 'running_map');
  assert.equal(reviewLaneLabel(st()), '危ない経路の下調べ中');
  assert.deepEqual(calls.map((c) => `${c.stage}:${c.base}..${c.head}`), ['map:b0..h1']);
  status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLanes();
  assert.deepEqual(st(), { state: 'start_blind', round: 1, base: 'b0', head: 'h1', map: { routes: ROUTES } });
  await runReviewLanes(); assert.equal(st().state, 'running_blind');
  assert.deepEqual(calls.at(-1).routes, ROUTES);
  assert.equal(st().runIds.length, 2);
  setAgentRunner(null);
});

test('a review lane goes straight to the blind when the map is skipped or cannot start', async () => {
  for (const map of ['skip', 'throw']) {
    setupReview(MAPPED);
    const rec = openReviewLane({ repo: 'o/r', pr: 8 });
    const { calls } = reviewRunner({ map });
    await runReviewLanes();
    await runReviewLanes();
    assert.equal(reviewLaneState(readReviewLane(rec.id)).state, 'running_blind', map);
    assert.deepEqual(calls.map((c) => c.stage), ['map', 'blind'], map);
    assert.equal(calls[1].routes, undefined);
  }
  setAgentRunner(null);
});

test('a review lane whose map fails runs the blind as it always did', async () => {
  setupReview(MAPPED);
  const rec = openReviewLane({ repo: 'o/r', pr: 9 });
  const { calls, status } = reviewRunner();
  await runReviewLanes(); await runReviewLanes();
  status['map-1-0'] = { state: 'failed', error: 'timeout' };
  await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(rec.id)).state, 'start_blind');
  await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(rec.id)).state, 'running_blind');
  assert.equal(calls.at(-1).routes, undefined);
  setAgentRunner(null);
});

test('a review lane whose leftovers blind fails runs the round again over the whole diff, without the map', async () => {
  setupReview(MAPPED);
  const rec = openReviewLane({ repo: 'o/r', pr: 10 });
  const { calls, status } = reviewRunner();
  const st = () => reviewLaneState(readReviewLane(rec.id));
  await runReviewLanes(); await runReviewLanes();
  status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLanes(); await runReviewLanes();
  assert.equal(st().state, 'running_blind');
  const [route, rest] = st().runIds;
  status[rest] = { state: 'failed', error: 'timeout' };
  status[route] = { state: 'done', reportJson: '/r1.json', reportMd: '/r1.md', findings: [] };
  await runReviewLanes();
  // the route blind alone does not stand for the whole face, so its findings are not judged on their own
  assert.deepEqual(st(), { state: 'start_blind', round: 1, base: 'b0', head: 'h1', map: { routes: [] } });
  await runReviewLanes();
  assert.equal(st().state, 'running_blind');
  assert.equal(calls.at(-1).stage, 'blind');
  assert.equal(calls.at(-1).routes, undefined);
  setAgentRunner(null);
});

test('a review lane goes on to the triage when the leftovers blind finished, even if a route blind failed', async () => {
  setupReview(MAPPED);
  const rec = openReviewLane({ repo: 'o/r', pr: 11 });
  const { status } = reviewRunner();
  const st = () => reviewLaneState(readReviewLane(rec.id));
  await runReviewLanes(); await runReviewLanes();
  status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLanes(); await runReviewLanes();
  const [route, rest] = st().runIds;
  status[rest] = { state: 'done', reportJson: '/rest.json', reportMd: '/rest.md', findings: [] };
  status[route] = { state: 'failed', error: 'timeout' };
  await runReviewLanes();
  assert.equal(st().state, 'start_triage');
  assert.deepEqual(st().inputs, ['/rest.json']);
  // the route that was not read is left on the record
  assert.deepEqual(readReviewLane(rec.id).history.at(-1).attrs.unread_routes, ['r1']);
  setAgentRunner(null);
});

test('a review lane whose runner narrowed none of the blinds judges the round when any of them finished', async () => {
  setupReview(MAPPED);
  const rec = openReviewLane({ repo: 'o/r', pr: 12 });
  const { status } = reviewRunner();
  // every route fell outside the diff: the runner reads the whole diff in each run and names none as whole-diff
  const base = getRunner();
  setAgentRunner({ ...base, startReviewRun: async (o) => { const { wholeDiff, ...rest } = await base.startReviewRun(o); return rest; } });
  const st = () => reviewLaneState(readReviewLane(rec.id));
  await runReviewLanes(); await runReviewLanes();
  status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLanes(); await runReviewLanes();
  assert.equal(st().state, 'running_blind');
  const [first, second] = st().runIds;
  status[first] = { state: 'failed', error: 'timeout' };
  status[second] = { state: 'done', reportJson: '/s.json', reportMd: '/s.md', findings: [] };
  await runReviewLanes();
  assert.ok(!readReviewLane(rec.id).history.some((e) => e.event === 'r_map_dropped'));
  assert.equal(st().state, 'start_triage');
  assert.deepEqual(st().inputs, ['/s.json']);
  setAgentRunner(null);
});

/** IDD-000 is mapping (its run still running); IDD-001 is where setup left it, about to start its blind round */
function withOtherLaneMapping(state, extra = []) {
  const row = (id, n) => JSON.stringify({ idd_id: id, parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: `https://github.com/o/r/issues/${n}`, pull_req_url: null, source_type: 'github', context: '', title: id, area: 'Demo' });
  writeFileSync(join(state, 'backlog.jsonl'), [row('IDD-000', 0), row('IDD-001', 1)].join('\n') + '\n');
  const other = (e, a) => ({ ...ev(e, a), idd_id: 'IDD-000' });
  const mine = readLifecycle().map((e) => JSON.stringify(e));
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [...mine, ...[other('s1_go'), other('s2_start'), other('s2_result'), other('s2_map_started', { kind: 'blind', round: 1, run_id: 'busy-map' }), ...extra.map((e) => ({ ...e, idd_id: 'IDD-000' }))].map((e) => JSON.stringify(e))].join('\n') + '\n');
}

const ONE_MAP = '  review_blind: { roles: [r], concurrency: 2 }\n  risk_map: { role: r, concurrency: 1 }\n';

test('a diff too small to map starts its blind round while another lane holds the only map slot', async () => {
  const state = setup(ONE_MAP);
  withOtherLaneMapping(state);
  const { calls, status } = fakeRunner();
  status['busy-map'] = { state: 'running' };
  setAgentRunner({ ...getRunner(), riskMapSkipReason: () => '差分 12 行（閾値 1000 行未満）' });
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => `${c.iddId}:${c.stage}`), ['IDD-001:blind']);
  assert.equal(readLifecycle().filter((e) => e.idd_id === 'IDD-001').at(-1).attrs.map_skipped, '差分 12 行（閾値 1000 行未満）');
  setAgentRunner(null);
});

test('a large diff still waits for the map slot', async () => {
  const state = setup(ONE_MAP);
  withOtherLaneMapping(state);
  const { calls, status } = fakeRunner();
  status['busy-map'] = { state: 'running' };
  setAgentRunner({ ...getRunner(), riskMapSkipReason: () => null });
  await runReviewLoop();
  assert.deepEqual(calls, []);
  setAgentRunner(null);
});

test('a lane stopped for its budget while mapping does not hold the map slot', async () => {
  const state = setup(ONE_MAP);
  withOtherLaneMapping(state, [ev('lane_over_budget', { cost: 5.2, limit: 5, parts: [] })]);
  const { calls, status } = fakeRunner();
  status['busy-map'] = { state: 'running' };
  setAgentRunner({ ...getRunner(), riskMapSkipReason: () => null });
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => `${c.iddId}:${c.stage}`), ['IDD-001:map']);
  setAgentRunner(null);
});

test('a review lane maps a large PR while the blind cap is full, and its blind waits for the cap afterwards', async () => {
  setupReview('  review_blind: { roles: [r], concurrency: 1 }\n  risk_map: { role: r }\n');
  const busy = openReviewLane({ repo: 'o/r', pr: 30 });
  const { calls, status } = reviewRunner();
  setAgentRunner({ ...getRunner(), riskMapSkipReason: () => '差分 5 行（閾値 1000 行未満）' });
  await runReviewLanes(); await runReviewLanes(); await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(busy.id)).state, 'running_blind');
  setAgentRunner({ ...getRunner(), riskMapSkipReason: () => null });
  const large = openReviewLane({ repo: 'o/r', pr: 31 });
  await runReviewLanes(); await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(large.id)).state, 'running_map');
  assert.deepEqual(calls.map((c) => c.stage), ['blind', 'map']);
  status['map-2-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: [] };
  await runReviewLanes();
  await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(large.id)).state, 'start_blind');
  assert.deepEqual(calls.map((c) => c.stage), ['blind', 'map']);
  setAgentRunner(null);
});

test('a review lane with a small diff starts its blind while another review lane holds the only map slot', async () => {
  setupReview(ONE_MAP);
  const busy = openReviewLane({ repo: 'o/r', pr: 20 });
  const { calls } = reviewRunner();
  await runReviewLanes(); await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(busy.id)).state, 'running_map');
  const small = openReviewLane({ repo: 'o/r', pr: 21 });
  setAgentRunner({ ...getRunner(), riskMapSkipReason: () => '差分 5 行（閾値 1000 行未満）' });
  await runReviewLanes(); await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(small.id)).state, 'running_blind');
  assert.equal(calls.filter((c) => c.stage === 'map').length, 1);
  setAgentRunner(null);
});

test('a routed round counts its runs against the blind cap: it waits while the copies it would cut do not fit', async () => {
  // one role, two lanes at once: at most two copies. IDD-000 runs one; the routed round of IDD-001 needs two
  const state = setup('  review_blind: { roles: [r], concurrency: 2 }\n  risk_map: { role: r, concurrency: 2 }\n');
  const row = (id, n) => JSON.stringify({ idd_id: id, parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: `https://github.com/o/r/issues/${n}`, pull_req_url: null, source_type: 'github', context: '', title: id, area: 'Demo' });
  writeFileSync(join(state, 'backlog.jsonl'), [row('IDD-000', 0), row('IDD-001', 1)].join('\n') + '\n');
  const other = (e, a) => ({ ...ev(e, a), idd_id: 'IDD-000' });
  const mine = [...readLifecycle(), ev('s2_map_started', { kind: 'blind', round: 1, run_id: 'm' }), ev('s2_map_done', { kind: 'blind', round: 1, routes: ROUTES })];
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [...mine, other('s1_go'), other('s2_start'), other('s2_result'), other('s2_review_started', { kind: 'blind', round: 1, run_ids: ['busy'] })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const { calls, status } = fakeRunner();
  status.busy = { state: 'running' };
  await runReviewLoop();
  assert.deepEqual(calls, [], 'one copy in use plus two would pass the cap of two');
  status.busy = { state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [] };
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => `${c.iddId}:${c.stage}`), ['IDD-001:blind']);
  setAgentRunner(null);
});

test('a routed round of a depth-bearing lane also reserves the copy of the spec check that starts beside its blinds', async () => {
  // cap 3 of (1 role + 1 spec) = 6 copies, and at most two routes (the cap less the whole-diff blind). IDD-000 holds three;
  // the two routes and the rest need three, the spec check a fourth. Without the check the round would just fit
  const state = setup('  review_blind: { roles: [r], concurrency: 3 }\n  spec_check: { role: r }\n  risk_map: { role: r, concurrency: 2 }\n');
  const row = (id, n) => JSON.stringify({ idd_id: id, parent_id: null, created_at: `2026-09-23T0${n}:00:00+09:00`, linear_issue_url: null, gh_issue_url: `https://github.com/o/r/issues/${n}`, pull_req_url: null, source_type: 'github', context: '', title: id, area: 'Demo' });
  writeFileSync(join(state, 'backlog.jsonl'), [row('IDD-000', 0), row('IDD-001', 1)].join('\n') + '\n');
  const other = (e, a) => ({ ...ev(e, a), idd_id: 'IDD-000' });
  const two = [...ROUTES, { id: 'R-2', paths: ['lib/a.dart'], question: 'q', harms: ['shown_vs_sent'] }];
  const mine = [ev('s1_ready', { depth: 'standard' }), ...readLifecycle(), ev('s2_map_started', { kind: 'blind', round: 1, run_id: 'm' }), ev('s2_map_done', { kind: 'blind', round: 1, routes: two })];
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [...mine, other('s1_go'), other('s2_start'), other('s2_result'), other('s2_review_started', { kind: 'blind', round: 1, run_ids: ['busy', 'busy2', 'busy3'] })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const { calls, status } = fakeRunner();
  for (const id of ['busy', 'busy2', 'busy3']) status[id] = { state: 'running' };
  const waits = () => slotWaits({ now: Date.parse('2026-09-01T11:00:00+09:00') }).find((w) => w.slot === 'review_blind')?.lanes.map((l) => l.id);
  assert.deepEqual(waits(), ['IDD-001'], 'the list of waits counts the spec check too');
  await runReviewLoop();
  assert.deepEqual(calls, [], 'three copies in use plus the routes, the rest and the spec check would pass the cap of six');
  for (const id of ['busy', 'busy2', 'busy3']) status[id] = { state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [] };
  await runReviewLoop();
  assert.deepEqual(calls.map((c) => `${c.iddId}:${c.stage}`), ['IDD-001:blind']);
  setAgentRunner(null);
});

test('a review lane counts the runs of the blind rounds against the cap too', async () => {
  setupReview('  review_blind: { roles: [r], concurrency: 2 }\n  risk_map: { role: r, concurrency: 2 }\n  triage: { role: r }\n');
  const busy = openReviewLane({ repo: 'o/r', pr: 30 });
  const { calls } = reviewRunner({ map: 'skip' });
  await runReviewLanes(); await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(busy.id)).state, 'running_blind');
  const mapped = openReviewLane({ repo: 'o/r', pr: 31 });
  appendReviewEvent(mapped.id, 'r_wt_ready', { path: '/wt/rev', head: 'h1', base: 'b0', title: 'PR' });
  appendReviewEvent(mapped.id, 'r_map_done', { round: 1, base: 'b0', head: 'h1', routes: ROUTES });
  const before = calls.length;
  await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(mapped.id)).state, 'start_blind', 'one copy in use plus two would pass the cap of two');
  assert.equal(calls.length, before);
  setAgentRunner(null);
});

test('a review lane whose map is refused for Claude Code windows waits for them instead of dropping the map', async () => {
  setupReview(MAPPED);
  const rec = openReviewLane({ repo: 'o/r', pr: 40 });
  const { calls } = reviewRunner();
  const base = getRunner();
  let refuse = true;
  setAgentRunner({
    ...base,
    startReviewRun: async (o) => {
      if (o.stage === 'map' && refuse) throw Object.assign(new Error('five_hour 92% ≥ 90%'), { code: 'claude_quota', resetsAt: 1790000000 });
      return base.startReviewRun(o);
    },
  });
  const st = () => reviewLaneState(readReviewLane(rec.id));
  await runReviewLanes(); await runReviewLanes(); await runReviewLanes();
  const events = readReviewLane(rec.id).history.map((e) => e.event);
  assert.ok(!events.includes('r_map_done'), 'the map is not given up');
  assert.ok(!events.includes('r_blind_started'), 'no blind goes ahead without it');
  assert.equal(events.filter((e) => e === 'r_quota_wait').length, 1, 'the same wait is recorded once');
  assert.deepEqual({ state: st().state, map: st().map }, { state: 'start_blind', map: undefined });
  refuse = false;
  await runReviewLanes();
  assert.equal(st().state, 'running_map');
  assert.equal(calls.filter((c) => c.stage === 'map').length, 1);
  setAgentRunner(null);
});

test('routes read back from a record are checked: a hand-edited or broken one never reaches a blind as it is', () => {
  const broken = [
    { id: 'R-9', paths: ['lib/a.dart'], question: '問い', harms: ['authority'] },
    { paths: ['lib/b.dart', 3, ''], question: 'r', harms: ['weird'] },
    { paths: ['lib/c.dart'] },
    { question: 'no path', harms: ['authority'] },
    'not a route',
  ];
  const want = [
    { id: 'R-9', paths: ['lib/a.dart'], question: '問い', harms: ['authority'] },
    { id: 'R-2', paths: ['lib/b.dart'], question: 'r', harms: [] },
  ];
  const issue = reviewLoopState([ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_map_done', { kind: 'blind', round: 1, routes: broken })]);
  assert.deepEqual(issue.map.routes, want);
  const at = '2026-09-25T10:00:00Z';
  const review = reviewLaneState({ id: 'REV-1', repo: 'o/r', pr: 1, created_at: at, history: [
    { event: 'r_wt_ready', at, attrs: { path: '/wt', head: 'h', base: 'b' } },
    { event: 'r_map_done', at, attrs: { round: 1, base: 'b', head: 'h', routes: broken } },
  ] });
  assert.deepEqual(review.map.routes, want);
  assert.deepEqual(reviewLoopState([ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_map_done', { kind: 'blind', round: 1, routes: 'x' })]).map.routes, []);
});

/** the fake runner, with every stage it starts reporting a role that ran on its fallback */
function withFallbacks() {
  const base = getRunner();
  setAgentRunner({
    ...base,
    startReviewRun: async (o) => ({ ...(await base.startReviewRun(o)), fallbacks: [{ role: `${o.stage}-opus`, fallback: 'api', reason: 'five_hour 95%' }] }),
  });
}

test('a map and a routed round that ran on a fallback record it, and the round still names its whole-diff blind', async () => {
  setup(MAPPED);
  const { status } = fakeRunner();
  withFallbacks();
  await runReviewLoop();
  assert.equal(last().event, 's2_map_started');
  assert.deepEqual(last().attrs.fallbacks.map((f) => [f.role, f.fallback]), [['map-opus', 'api']]);
  status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLoop(); await runReviewLoop();
  const started = last();
  assert.equal(started.event, 's2_review_started');
  assert.deepEqual(started.attrs.whole_run_ids, [started.attrs.run_ids[1]]);
  assert.deepEqual(started.attrs.fallbacks.map((f) => [f.role, f.fallback]), [['blind-opus', 'api']]);
  setAgentRunner(null);
});

test('a review lane records the fallback of its map and of its routed round', async () => {
  setupReview(MAPPED);
  const rec = openReviewLane({ repo: 'o/r', pr: 13 });
  const { status } = reviewRunner();
  withFallbacks();
  const hist = () => readReviewLane(rec.id).history;
  await runReviewLanes(); await runReviewLanes();
  assert.equal(hist().at(-1).event, 'r_map_started');
  assert.deepEqual(hist().at(-1).attrs.fallbacks.map((f) => f.role), ['map-opus']);
  status['map-1-0'] = { state: 'done', reportJson: '/m.json', reportMd: '/m.md', findings: [], routes: ROUTES };
  await runReviewLanes(); await runReviewLanes();
  const started = hist().at(-1);
  assert.equal(started.event, 'r_blind_started');
  assert.deepEqual(started.attrs.whole_run_ids, [started.attrs.run_ids[1]]);
  assert.deepEqual(started.attrs.fallbacks.map((f) => f.role), ['blind-opus']);
  setAgentRunner(null);
});

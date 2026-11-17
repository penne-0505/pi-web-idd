import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import lockfile from 'proper-lockfile';

import { STRICT_EVENTS, isStrictEvent, transitionRefusal } from '../src/ledger/allowed.ts';
import { LANE_GATE_BUSY_MESSAGE, LANE_GATE_FILE, LANE_GATE_STALE_MS, withLaneGate } from '../src/ledger/gate.ts';
import { appendLifecycle, applyDecision, transition } from '../src/ledger/write.ts';
import { readBacklog, readLifecycle } from '../src/ledger/read.ts';
import { runIntake } from '../src/intake/run.ts';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-09-01T10:00:00+09:00', attrs });

afterEach(() => { delete process.env.IDD_LANE_GATE_WAIT_MS; });

function laneWith(events) {
  const root = scratchDir('lane-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  writeFileSync(join(state, 'lifecycle-default.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  return { root, state };
}

const names = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1').map((e) => e.event);

// the lanes of each stage, as the records put them
const STAGES = {
  fresh: [ev('lane_open')],
  planReview: [ev('lane_open'), ev('s1_ready')],
  question: [ev('lane_open'), ev('question_batch_asked')],
  granularity: [ev('lane_open'), ev('s1_granularity_proposed', { kind: 'split', reason: '責務が 2 つ。', children: [{ title: 'a', whole: 'w', places: ['src/x.ts'], after: [] }] })],
  requeue: [ev('lane_open', { requeued_from: 'IDD-0' })],
  atGo: [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 0, should: 0, nit: 0 })],
  sentBack: [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 0, should: 0, nit: 0 }), ev('s1_revise_requested')],
  gone: [ev('lane_open'), ev('s1_ready'), ev('s1_go')],
  stuckBeforeStart: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('lane_over_budget', { cost: 6, limit: 5 })],
  started: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('s2_start')],
  s3Card: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s3_ready')],
  s3Passed: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s3_ready'), ev('s3_ok')],
  submitting: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s3_ready'), ev('s3_ok'), ev('s4_submit_started')],
  // penne sent the submit back: an old submit card must not put the lane back at the card while the executor fixes it
  sentBackFromSubmit: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s3_ready'), ev('s3_ok'), ev('s4_submit_started'), ev('s4_verify_user_judgment_answered', { outcome: 'revise' })],
  // the review loop stopped at penne's card: the one place a lane may be sent back to its plan from
  stuckAtCard: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_review_escalated', { reason: '修正が上限に達した' })],
  deferred: [ev('lane_open'), ev('s1_ready'), ev('s1_defer')],
  closed: [ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('lane_close', { outcome: 'aborted' })],
};

// which stage each strict event is written in; every other stage refuses it
const ALLOWED = {
  s1_go: ['atGo'],
  s1_revise_requested: ['atGo'],
  s1_replan_requested: ['stuckAtCard'],
  s1_defer: ['fresh', 'planReview', 'question', 'requeue', 'atGo', 'sentBack'],
  // a split / merge proposal waits on a person, so the lane may be closed (an approved proposal) or answered
  s1_granularity_answered: ['granularity'],
  lane_close: ['fresh', 'planReview', 'question', 'granularity', 'requeue', 'atGo', 'sentBack', 'gone', 'stuckBeforeStart', 'started', 'stuckAtCard', 's3Card', 's3Passed', 'submitting', 'sentBackFromSubmit'],
  s2_start: ['gone'],
  s4_submit_started: ['s3Passed'],
};

test('the strict events are the eight that raced, and the table answers for each of them in every stage', () => {
  assert.deepEqual([...STRICT_EVENTS].sort(), Object.keys(ALLOWED).sort());
  for (const [event, allowed] of Object.entries(ALLOWED)) {
    for (const [stage, events] of Object.entries(STAGES)) {
      const refusal = transitionRefusal(event, events);
      if (allowed.includes(stage)) assert.equal(refusal, null, `${event} in ${stage}`);
      else assert.equal(typeof refusal, 'string', `${event} is refused in ${stage}`);
    }
  }
});

test('the gate asks the fold\'s closed type about a name, so a list that missed one decides nothing', () => {
  for (const event of Object.keys(ALLOWED)) assert.equal(isStrictEvent(event), true, event);
  for (const event of ['priority_elevated', 's3_ok', 's4_push_held', 's4_land_held', '']) assert.equal(isStrictEvent(event), false, event);
});

test('an event outside the table goes through in any stage, as before', () => {
  for (const events of Object.values(STAGES)) {
    assert.equal(transitionRefusal('priority_elevated', events), null);
    assert.equal(transitionRefusal('s3_ok', events), null);
  }
});

test('the write gate checks inside the lock and writes; a refusal writes nothing and says why', async () => {
  laneWith(STAGES.sentBack);
  const go = await transition('IDD-1', 's1_go', { at_by: 'user' });
  assert.equal(go.ok, false);
  assert.match(go.reason, /GO 待ちではありません/);
  assert.equal(go.busy, undefined);
  assert.equal(names().includes('s1_go'), false);

  laneWith(STAGES.atGo);
  const ok = await transition('IDD-1', 's1_go', { at_by: 'user' });
  assert.equal(ok.ok, true);
  assert.equal(names().at(-1), 's1_go');
  assert.equal(readLifecycle().at(-1).attrs.at_by, 'user');
});

test('an executor starts once: a second start is refused', async () => {
  laneWith(STAGES.gone);
  assert.equal((await transition('IDD-1', 's2_start', { executor_session_id: 'E1' })).ok, true);
  const again = await transition('IDD-1', 's2_start', { executor_session_id: 'E2' });
  assert.equal(again.ok, false);
  assert.equal(names().filter((n) => n === 's2_start').length, 1);
});

test('what runs before the write runs only when the event is allowed, and a throw from it writes nothing', async () => {
  laneWith(STAGES.started);
  let ran = 0;
  const refused = await transition('IDD-1', 's2_start', {}, { before: () => { ran += 1; } });
  assert.equal(refused.ok, false);
  assert.equal(ran, 0, 'a refused start records no session');

  laneWith(STAGES.gone);
  await assert.rejects(transition('IDD-1', 's2_start', {}, { before: () => { throw new Error('session record failed'); } }), /session record failed/);
  assert.equal(names().includes('s2_start'), false);
});

test('the records that follow an event are written in the same gate, right after it', async () => {
  laneWith(STAGES.s3Passed);
  const r = await transition('IDD-1', 's4_submit_started', {}, { then: [{ event: 's4_verify_started', attrs: { verifier_session_id: null } }] });
  assert.equal(r.ok, true);
  assert.deepEqual(names().slice(-2), ['s4_submit_started', 's4_verify_started']);
  // the submit is not started twice: the card is already up
  assert.equal((await transition('IDD-1', 's4_submit_started', {}, { then: [{ event: 's4_verify_started' }] })).ok, false);
  assert.equal(names().filter((n) => n === 's4_verify_started').length, 1);
});

/** another process holds the gate for the whole wait */
async function holdGate(state) {
  const path = join(state, LANE_GATE_FILE);
  writeFileSync(path, '');
  return lockfile.lock(path, { stale: LANE_GATE_STALE_MS });
}

test('when the gate stays busy, the write gate says so and writes nothing; a decision answers with the reason', async () => {
  const { state } = laneWith(STAGES.atGo);
  process.env.IDD_LANE_GATE_WAIT_MS = '300';
  const release = await holdGate(state);
  try {
    const r = await transition('IDD-1', 's1_go', {});
    assert.equal(r.ok, false);
    assert.equal(r.busy, true);
    assert.match(r.reason, /ほかの処理が lane を更新中/);
    const decided = await applyDecision('s1_go', { iddId: 'IDD-1' });
    assert.equal(decided.ok, false);
    assert.match(decided.error, /ほかの処理が lane を更新中/);
    assert.equal(names().includes('s1_go'), false);
  } finally {
    await release();
  }
  assert.equal((await applyDecision('s1_go', { iddId: 'IDD-1' })).ok, true, 'once the gate is free the GO goes through');
});

test('an intake that finds the gate busy puts the Issue on its failures and goes on, without opening a lane', async () => {
  const root = scratchDir('intake-');
  const state = join(root, 'state'); mkdirSync(state);
  const repos = join(root, 'repos.yaml');
  writeFileSync(repos, JSON.stringify({ repos: { 'a/app': { upstream: join(root, 'u'), work: join(root, 'w'), issue_lane: { context: 'meltly', source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'] } } } } }));
  Object.assign(process.env, { IDD_REPOS_FILE: repos, IDD_STATE_DIR: state, IDD_LINEAR_KEY_FILE: join(root, 'no-such-key'), LINEAR_API_KEY: 'lin_api_TESTSECRET_busy' });
  const node = (identifier) => ({
    id: `uuid-${identifier}`, identifier, title: identifier, description: '', url: `https://linear.app/org/issue/${identifier}/t`,
    createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', team: { key: 'APP' }, state: { name: 'Todo' }, labels: { nodes: [] },
  });
  const linearFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { viewer: { assignedIssues: { nodes: [node('APP-1'), node('APP-2')], pageInfo: { hasNextPage: false, endCursor: '2' } } } } }) });
  process.env.IDD_LANE_GATE_WAIT_MS = '200';
  const release = await holdGate(state);
  let result;
  try {
    result = await runIntake({ linearFetch });
  } finally {
    await release();
  }
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.failures.map((f) => f.area), ['APP-1', 'APP-2']);
  // the reason goes on to the cron's record: the words penne is told, and nothing of the lock's file or the state's place
  for (const f of result.failures) assert.equal(f.reason, LANE_GATE_BUSY_MESSAGE);
  assert.equal(readBacklog().length, 0);
  // the next run takes them in
  const next = await runIntake({ linearFetch });
  assert.deepEqual(next.added, ['IDD-001', 'IDD-002']);
});

test('inside the gate, the write gate does not wait on itself; after the gate is let go, a late write takes the lock again', async () => {
  const { state } = laneWith(STAGES.atGo);
  process.env.IDD_LANE_GATE_WAIT_MS = '300';
  let late;
  await withLaneGate(async () => {
    const r = await transition('IDD-1', 's1_go', {});
    assert.equal(r.ok, true, 'a nested write goes through at once');
    // started inside, run after the gate is let go: it must not take the outer hold for its own
    late = new Promise((r2) => setTimeout(r2, 50)).then(async () => {
      const release = await holdGate(state).catch(() => null);
      try {
        return await transition('IDD-1', 'priority_elevated', {});
      } finally {
        await release?.();
      }
    });
  });
  const r = await late;
  assert.equal(r.ok, false, 'the late write waited on the lock another holder took');
  assert.equal(r.busy, true);
});

test('a checked event cannot ride along after another one unchecked', async () => {
  laneWith(STAGES.atGo);
  await assert.rejects(transition('IDD-1', 'priority_elevated', {}, { then: [{ event: 's1_go' }] }), /確かめてから書く/);
  assert.equal(names().includes('s1_go'), false);
});

test('no source writes a checked event around the write gate', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'test' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.mjs$/.test(name)) files.push(p);
    }
  };
  for (const dir of ['packages/idd-core/src', 'packages/idd-lane/src', 'packages/idd-cli', 'packages/idd-engine/src', 'lib']) walk(resolve(dir));
  const raw = new RegExp(`appendLifecycle\\(\\s*["'\`](${STRICT_EVENTS.join('|')})["'\`]`);
  const hits = files.filter((f) => raw.test(readFileSync(f, 'utf8'))).map((f) => f.slice(resolve('.').length + 1));
  assert.deepEqual(hits, []);
});

test('a lock that fails for a reason other than another holder is thrown as it is, not taken for busy', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root writes into a read-only directory');
  const { state } = laneWith(STAGES.atGo);
  process.env.IDD_LANE_GATE_WAIT_MS = '300';
  // the lock's file is there, but its lock cannot be made next to it
  writeFileSync(join(state, LANE_GATE_FILE), '');
  chmodSync(state, 0o555);
  try {
    await assert.rejects(transition('IDD-1', 's1_go', {}), (err) => err.code === 'EACCES');
    await assert.rejects(applyDecision('s1_go', { iddId: 'IDD-1' }), (err) => err.code === 'EACCES');
  } finally {
    chmodSync(state, 0o755);
  }
  assert.equal(names().includes('s1_go'), false);
});

test('the six checked events are refused outside the write gate, however their name is passed', async () => {
  laneWith(STAGES.atGo);
  for (const event of STRICT_EVENTS) {
    await assert.rejects(appendLifecycle(event, 'IDD-1', {}), /書き口/, event);
    // a name picked at run time is refused the same (the source scan only sees a name written in the call)
    const picked = [event][0];
    await assert.rejects(appendLifecycle(picked, 'IDD-1', {}), /書き口/, event);
  }
  // inside the lock but outside the write gate, too
  await withLaneGate(async () => {
    await assert.rejects(appendLifecycle('s1_go', 'IDD-1', {}), /書き口/);
  });
  assert.deepEqual(names(), ['lane_open', 's1_ready', 's1_plan_review_done']);
  // the write gate still writes them, and any other event still goes through appendLifecycle
  assert.equal((await transition('IDD-1', 's1_go', {})).ok, true);
  await appendLifecycle('priority_elevated', 'IDD-1', {});
  assert.deepEqual(names().slice(-2), ['s1_go', 'priority_elevated']);
});

test('what ran before an event that could not be written is taken back, and the failure is thrown as it is', async () => {
  const { state } = laneWith(STAGES.gone);
  const lifecycle = join(state, 'lifecycle-default.jsonl');
  let undone = 0;
  // another process holds the lifecycle's own lock past the append's retries: the event cannot be written
  const release = await lockfile.lock(lifecycle);
  try {
    await assert.rejects(transition('IDD-1', 's2_start', {}, { before: () => {}, undo: () => { undone += 1; } }), (err) => err.code === 'ELOCKED');
  } finally {
    await release();
  }
  assert.equal(undone, 1, 'the session recorded before the start is taken back');
  assert.equal(names().includes('s2_start'), false);

  // a before that threw did not finish: there is nothing of it to take back
  await assert.rejects(transition('IDD-1', 's2_start', {}, { before: () => { throw new Error('no record'); }, undo: () => { undone += 1; } }), /no record/);
  assert.equal(undone, 1);

  // a take-back that fails too is said with the failure, not in its place
  const again = await lockfile.lock(lifecycle);
  try {
    await assert.rejects(
      transition('IDD-1', 's2_start', {}, { before: () => {}, undo: () => { throw new Error('undo failed'); } }),
      (err) => err.code === 'ELOCKED' && /undo failed/.test(err.message),
    );
  } finally {
    await again();
  }
});

test('an event named like a property every object has is not taken for a checked one', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    for (const events of Object.values(STAGES)) assert.equal(transitionRefusal(name, events), null, name);
  }
});

test('an intake whose lane_open cannot be written leaves no backlog row without its lane', async () => {
  const root = scratchDir('intake-');
  const state = join(root, 'state'); mkdirSync(state);
  const repos = join(root, 'repos.yaml');
  writeFileSync(repos, JSON.stringify({ repos: { 'a/app': { upstream: join(root, 'u'), work: join(root, 'w'), issue_lane: { context: 'meltly', source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'] } } } } }));
  Object.assign(process.env, { IDD_REPOS_FILE: repos, IDD_STATE_DIR: state, IDD_LINEAR_KEY_FILE: join(root, 'no-such-key'), LINEAR_API_KEY: 'lin_api_TESTSECRET_lock' });
  const node = { id: 'uuid-APP-1', identifier: 'APP-1', title: 'APP-1', description: '', url: 'https://linear.app/org/issue/APP-1/t', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', team: { key: 'APP' }, state: { name: 'Todo' }, labels: { nodes: [] } };
  const linearFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { viewer: { assignedIssues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: '1' } } } } }) });
  // the lane's lifecycle file is held by another process past the append's retries
  const lifecycle = join(state, 'lifecycle-a-app.jsonl');
  writeFileSync(lifecycle, '');
  const release = await lockfile.lock(lifecycle);
  try {
    await assert.rejects(runIntake({ linearFetch }), (err) => err.code === 'ELOCKED');
  } finally {
    await release();
  }
  assert.deepEqual(readBacklog(), [], 'the backlog row written before the lane_open is taken back');
  // the next run takes the Issue in as a fresh lane
  const next = await runIntake({ linearFetch });
  assert.deepEqual(next.added, ['IDD-001']);
  assert.deepEqual(readBacklog().map((r) => r.idd_id), ['IDD-001']);
  assert.deepEqual(readLifecycle().map((e) => [e.idd_id, e.event]), [['IDD-001', 'lane_open']]);
});

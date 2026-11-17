import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { deriveStage } from '../src/ledger/derive.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle, queueEnvelope } from '../src/ledger/write.ts';
import { pendingEnvelopes } from '../src/agent/outbox.ts';
import { awaitedAgent } from '../src/plan/watch.ts';
import { slotWaits } from '../src/plan/slot-wait.ts';
import { lanesAwaitingPrep, runningPlanners } from '../src/plan/prep.ts';
import { runningExecutors } from '../src/plan/exec.ts';
import { recordQuotaWait } from '../src/plan/quota-wait.ts';
import { BASE_ADVANCED, runBaseAdvance } from '../src/plan/base-advance.ts';
import { setIgnored } from '../src/intake/ignore.ts';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

const IDS = ['IDD-001', 'IDD-002', 'IDD-003', 'IDD-004', 'IDD-005', 'IDD-006'];
const NOW = Date.parse('2026-09-26T12:00:00+09:00');
const RESET = Math.floor(NOW / 1000) + 3600;
const url = (id) => `https://github.com/t/p/issues/${Number(id.slice(-3))}`;
const rec = (id) => ({ idd_id: id, parent_id: null, created_at: `2026-09-20T0${id.slice(-1)}:00:00+09:00`, linear_issue_url: null, gh_issue_url: url(id), pull_req_url: null, source_type: 'github', context: '', title: `T${id}`, area: 'demo' });
const ev = (id, event, attrs = {}) => ({ event, idd_id: id, at: '2026-09-20T10:00:00+09:00', attrs });
const planned = (id) => [ev(id, 'lane_open'), ev(id, 's1_ready'), ev(id, 's1_plan_review_skipped')];

/**
 * Lanes in every place the three additions could reach: IDD-001 waits at GO (its plan's place moves on the work
 * branch), IDD-002 holds the one planner slot, IDD-003 waits for Claude's windows, IDD-004 waits for the planner
 * slot, IDD-005 holds the one executor slot, IDD-006 waits for it. IDD-002 has an envelope waiting to be delivered.
 */
function setup() {
  const root = scratchDir('neutral-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=work-main');
  put(join(work, 'src/a.ts'), 'a\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  const wt = join(root, 'lanes', 'IDD-001');
  git(work, 'worktree', 'add', '-q', '-b', 'idd/IDD-001', wt, 'work-main');
  put(join(wt, '_docs/intent/demo/idd-001/decision.md'), '### DEC-1: x\n\n- **Anchors**: `src/a.ts`\n');
  put(join(root, 'repos.yaml'), JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r, concurrency: 1 }\n  executor: { role: r, concurrency: 1 }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml') });
  put(join(state, 'backlog.jsonl'), IDS.map((id) => JSON.stringify(rec(id))).join('\n') + '\n');
  const events = [
    ...planned('IDD-001'),
    ev('IDD-002', 'lane_open'),
    ev('IDD-003', 'lane_open'), ev('IDD-003', 'claude_quota_wait', { stage: 'planner', reason: 'windows', resets_at: RESET }),
    ev('IDD-004', 'lane_open'),
    ...planned('IDD-005'), ev('IDD-005', 's1_go'), ev('IDD-005', 's2_start'),
    ...planned('IDD-006'), ev('IDD-006', 's1_go'),
  ];
  put(join(state, 'lifecycle-demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  put(join(state, 'planner-sessions.jsonl'), [
    { idd_id: 'IDD-001', planner_session_id: 'P1', worktree_path: wt, branch: 'idd/IDD-001' },
    { idd_id: 'IDD-002', planner_session_id: 'P2', worktree_path: join(root, 'lanes', 'IDD-002'), branch: 'idd/IDD-002' },
    { idd_id: 'IDD-005', planner_session_id: 'P5', worktree_path: join(root, 'lanes', 'IDD-005'), branch: 'idd/IDD-005' },
    { idd_id: 'IDD-006', planner_session_id: 'P6', worktree_path: join(root, 'lanes', 'IDD-006'), branch: 'idd/IDD-006' },
  ].map((s) => JSON.stringify(s)).join('\n') + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-005', executor_session_id: 'E5', worktree_path: join(root, 'lanes', 'IDD-005') }) + '\n');
  return { work, state };
}

/** what drives the lanes: their stage, whom they wait on, the capped stages' slots and waits, and the delivery */
function snapshot() {
  const events = readLifecycle();
  const of = (id) => events.filter((e) => e.idd_id === id);
  return {
    stages: Object.fromEntries(IDS.map((id) => [id, deriveStage(of(id))])),
    awaited: Object.fromEntries(IDS.map((id) => [id, awaitedAgent(of(id))?.role ?? null])),
    waits: slotWaits({ now: NOW }).map((w) => ({ slot: w.slot, cap: w.cap, running: w.running, lanes: w.lanes.map((l) => [l.id, l.since]) })),
    planners: runningPlanners(),
    executors: runningExecutors(),
    awaitingPrep: lanesAwaitingPrep().map((r) => r.idd_id),
    pending: pendingEnvelopes().map((e) => [e.envelope_id, e.idd_id, e.type]),
  };
}

test('the ignore list, the sleeping cards and the record of the work branch move leave every lane, slot and delivery as they were', async () => {
  const { work, state } = setup();
  await queueEnvelope('IDD-002', 'info_update', '<idd-system-message/>');
  const before = snapshot();
  // the fixture has the shapes it is meant to have
  assert.equal(before.stages['IDD-001'].decision, 'go');
  assert.equal(before.awaited['IDD-002'], 'planner');
  assert.deepEqual(before.waits.find((w) => w.slot === 'planner').lanes.map(([id]) => id), ['IDD-004']);
  assert.deepEqual(before.waits.find((w) => w.slot === 'executor').lanes.map(([id]) => id), ['IDD-006']);
  assert.equal(before.pending.length, 1);

  // every lane's Issue on the ignore list
  for (const id of IDS) assert.equal((await setIgnored('ignore', { source: 'github', url: url(id), ref: `#${Number(id.slice(-3))}`, title: `T${id}`, area: 'demo' })).ok, true);
  // every card put to sleep, and one put off
  writeFileSync(join(state, 'inbox-snooze.json'), JSON.stringify({
    entries: { 'question:IDD-002:b1': { until: new Date(NOW + 3600_000).toISOString(), at: new Date(NOW).toISOString() } },
    sleeps: Object.fromEntries(IDS.map((id) => [`go:${id}`, { at: new Date(NOW).toISOString(), step: 0, notice_at: new Date(NOW + 86400_000).toISOString() }])),
  }));
  // the work branch moves into IDD-001's plan, and the tick's stage records it
  put(join(work, 'src/a.ts'), 'moved\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'move');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  // the same record lands on lanes that moved on meanwhile (a GO, a send-back pressed while the stage ran)
  for (const id of IDS.slice(1)) await appendLifecycle(BASE_ADVANCED, id, { from: 'x', to: 'y', files: ['src/a.ts'], files_total: 1, known: true });

  assert.deepEqual(snapshot(), before);

  // a wait for Claude's windows met again is still the same wait, past the record
  const evs3 = readLifecycle().filter((e) => e.idd_id === 'IDD-003');
  await recordQuotaWait('IDD-003', evs3, 'planner', { reason: 'windows', resetsAt: RESET });
  assert.equal(readLifecycle().filter((e) => e.idd_id === 'IDD-003' && e.event === 'claude_quota_wait').length, 1);
});

/** the source files of the packages that name any of the given words, relative to packages/ */
function readers(words) {
  const root = resolve('packages');
  return readdirSync(root, { recursive: true })
    .filter((f) => !f.includes('node_modules') && (/\/src\/.*\.ts$/.test(f) || /\/bin\/.*\.ts$/.test(f)))
    .filter((f) => words.test(readFileSync(join(root, f), 'utf8')))
    .map((f) => relative(root, join(root, f)))
    .sort();
}

test('only intake, the stop of a lane and the CLI read or write the ignore list', () => {
  assert.deepEqual(readers(/intake-ignores|INTAKE_IGNORES_FILE|readIgnores|isIgnored|listIgnored|setIgnored|ignoreLaneIssue|ignoreByRef|from "\.\/ignore\.ts"|from "\.\.\/intake\/ignore/), [
    'idd-cli/src/ignore.ts',
    'idd-core/src/index.ts',
    'idd-core/src/intake/ignore-resolve.ts',
    'idd-core/src/intake/ignore.ts',
    'idd-core/src/intake/redo.ts',
    'idd-core/src/intake/run.ts',
    // the inbox's server (the ignore list's screen) lives in the engine's package now
    'idd-engine/src/routes/intake-ignore.ts',
    'idd-engine/src/server/state.ts',
  ]);
});

test('the record of the work branch move is written by its stage alone, and read only by what shows it and what reads past it', () => {
  assert.deepEqual(readers(/s1_base_advanced|BASE_ADVANCED|currentBaseAdvance|runBaseAdvance/), [
    'idd-core/src/index.ts',
    // the TypeScript reading the cross-check holds against the MoonBit derivation (off the running path)
    'idd-core/src/ledger/derive-reference.ts',
    'idd-core/src/ledger/derive.ts',
    'idd-core/src/plan/base-advance.ts',
    'idd-core/src/plan/tick.ts',
    // the inbox's server (the timeline that shows the move) lives in the engine's package now
    'idd-engine/src/server/events-display.ts',
    'idd-engine/src/server/state.ts',
  ]);
});

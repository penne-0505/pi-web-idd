import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { runStallWatch, LANE_STALL_DETECTED } from '../src/plan/stall-watch.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { reviewBaseOf } from '../src/ledger/base.ts';
import { conflictSendBacks, reviewLoopState, startRetryWaiting } from '../src/ledger/review-loop.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { planReviewInputs } from '../src/plan/plan-review.ts';
import { awaitedAgent } from '../src/plan/watch.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { tmpDir } from './helpers/tmp.mjs';
import { GEN, SRC, TOP, BOTTOM, TOP_OTHER, TOP_AND_BOTTOM, builds, genOf, mainlineBuildsLaneEditsSource, seedGenerated, writeIn } from './helpers/generated-fixture.mjs';

const original = process.cwd();
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_ALLOW_PROTOCOL: 'file',
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

const PLAIN = '  review_blind: { roles: [v] }\n  triage: { role: v }\n  confirm: { role: v }\n';
const EXTRAS = '  review_blind: { roles: [v], first_round_extra: [o] }\n  triage: { role: v }\n  confirm: { role: v }\n';
const WITH_MAP = '  review_blind: { roles: [v], first_round_extra: [o] }\n  risk_map: { role: v }\n  triage: { role: v }\n  confirm: { role: v }\n';

/** a project with a work clone, its remote, an upstream clone, and one lane worktree on the work branch */
function setup({ pipeline = PLAIN, publish = false, lanes = ['IDD-1'], riskPaths, generated } = {}) {
  process.chdir(original);
  const root = mkdtempSync(join(tmpDir('idd-premerge-'), 'run-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const upstream = join(root, 'upstream');
  const state = join(root, 'state');
  mkdirSync(work);
  mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n');
  put(join(work, 'app.txt'), 'one\n');
  commit(work);
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', 'origin', 'main');
  git(root, 'clone', remote, upstream);
  git(upstream, 'config', 'user.name', 'test');
  git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n');
  put(join(work, 'AGENTS.override.md'), 'private rules');
  commit(work);
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], ...(publish ? { publish: true } : { publish: false }), issue_lane: { context: 'personal', source_type_priority: 'github' }, ...(riskPaths ? { risk_paths: riskPaths } : {}), ...(generated ? { generated_files: generated } : {}) } } }));
  put(join(state, 'roles.yaml'), `models:\n  x-v:\n    model: x/v\n  x-o:\n    model: x/o\nroles:\n  v: { model: x-v }\n  o: { model: x-o }\npipeline:\n${pipeline}`);
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_ROLES_FILE: join(state, 'roles.yaml'), IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const made = {};
  const backlog = [];
  const sessions = [];
  for (const iddId of lanes) {
    const lane = ensureLaneWorktree('demo', iddId);
    made[iddId] = lane;
    backlog.push({ idd_id: iddId, area: 'demo', title: `feat: ${iddId}`, source_type: 'github', gh_issue_url: `https://github.com/test/project/issues/${iddId.slice(-1)}` });
    sessions.push({ idd_id: iddId, worktree_path: lane.path, branch: lane.branch, executor_session_id: `s-${iddId}` });
  }
  put(join(state, 'backlog.jsonl'), backlog.map((r) => JSON.stringify(r)).join('\n') + '\n');
  put(join(state, 'executor-sessions.jsonl'), sessions.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane: made['IDD-1'], lanes: made };
}

/** a runner that records what each start asked for and answers session presence as the test sets */
function fakeRunner({ cwdBusy = true, busy = false } = {}) {
  const state = { busy, absent: !cwdBusy };
  const calls = [];
  const status = {};
  let n = 0;
  const runner = {
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls.push(o);
      const ids = o.stage === 'blind' || o.stage === 'final' ? [1 + (o.extras?.length ? 1 : 0)].map(() => `${o.stage}-${(n += 1)}`) : [`${o.stage}-${(n += 1)}`];
      for (const id of ids) status[id] = { state: 'running' };
      return { runIds: ids };
    },
    reviewRunStatus: (id) => status[id],
  };
  if (cwdBusy) runner.cwdBusy = () => state.busy;
  setAgentRunner(runner);
  return { calls, status, state, finish: (st) => { for (const [id, s] of Object.entries(status)) if (s.state === 'running') status[id] = st(id); } };
}

const eventsOf = (id = 'IDD-1') => readLifecycle().filter((e) => e.idd_id === id);
const eventNames = (id) => eventsOf(id).map((e) => e.event);
const lastOf = (name, id = 'IDD-1') => [...eventsOf(id)].reverse().find((e) => e.event === name);
const laneTip = (f) => git(f.lane.path, 'rev-parse', 'HEAD');
const mainTip = (f) => git(f.work, 'rev-parse', 'HEAD');
const clean = (wt) => git(wt, 'status', '--porcelain', '--untracked-files=all') === '';

/** put the lane at the first review: S2 started at the work branch's tip, and the executor has answered */
async function atFirstReview(f, iddId = 'IDD-1') {
  const start = git(f.lanes[iddId].path, 'rev-parse', 'HEAD');
  await seedLifecycle('lane_open', iddId, {});
  await seedLifecycle('s2_start', iddId, { started_from_commit: start });
  await seedLifecycle('s2_result', iddId, { outcome: 'success' });
  return start;
}

/** the lane changes a file and the mainline moves on elsewhere: a clean merge is possible */
async function diverge(f, { lane = { 'lane.txt': 'lane\n' }, main = { 'main.txt': 'main\n' } } = {}) {
  for (const [name, text] of Object.entries(lane)) put(join(f.lane.path, name), text);
  commit(f.lane.path, 'feat: lane');
  for (const [name, text] of Object.entries(main)) put(join(f.work, name), text);
  commit(f.work, 'chore: mainline move');
  const laneHead = laneTip(f);
  return { laneHead, mainTip: mainTip(f) };
}

test('the work mainline is merged into the lane before its first blind, without a checkout, and the review reads the new base', async () => {
  const f = setup();
  const start = await atFirstReview(f);
  const { laneHead, mainTip: tip } = await diverge(f);
  const r = fakeRunner();
  await runReviewLoop();
  // the branch moved to a merge commit with the lane's head and the mainline tip as parents
  const merged = laneTip(f);
  assert.deepEqual(git(f.lane.path, 'rev-list', '--parents', '-n', '1', merged).split(' ').slice(1), [laneHead, tip]);
  assert.equal(clean(f.lane.path), true);
  assert.equal(readFileSync(join(f.lane.path, 'main.txt'), 'utf8'), 'main\n');
  // the record holds the prior head, the mainline, the merge commit and the new origin
  const rec = lastOf('s2_review_base_merged');
  assert.deepEqual([rec.attrs.head, rec.attrs.mainline, rec.attrs.merge_commit, rec.attrs.by], [laneHead, tip, merged, 'harness']);
  assert.equal(rec.attrs.review_base, reviewBaseOf(readLifecycle()));
  // the blind started on the advanced base: the mainline's file is not the lane's
  const blind = r.calls[0];
  assert.equal(blind.stage, 'blind');
  assert.equal(blind.base, reviewBaseOf(readLifecycle()));
  assert.deepEqual(git(f.lane.path, 'diff', '--name-only', blind.base, merged).split('\n').sort(), ['lane.txt']);
  setAgentRunner(null);
  assert.ok(start);
});

test('a lane whose review slot is undeclared is merged before the round is skipped', async () => {
  const f = setup({ pipeline: '  triage: { role: v }\n' });
  await atFirstReview(f);
  await diverge(f);
  fakeRunner();
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_merged'), true);
  assert.equal(eventNames().at(-1), 's2_review_skipped');
  setAgentRunner(null);
});

test('a session at work in the lane is waited out, but only while a merge is needed', async () => {
  const f = setup();
  await atFirstReview(f);
  await diverge(f);
  const r = fakeRunner();
  const head = laneTip(f);
  r.state.busy = true;
  await runReviewLoop();
  assert.equal(laneTip(f), head, 'the head did not move');
  assert.equal(eventNames().includes('s2_review_base_merged'), false);
  assert.equal(eventNames().includes('s2_review_started'), false);
  assert.equal(r.calls.length, 0, 'the blind did not start while the session ran');
  r.state.busy = false;
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_merged'), true);
  assert.equal(r.calls[0].stage, 'blind');
  setAgentRunner(null);
  // a lane with nothing to take in starts its blind even while a session is at work
  const g = setup();
  await atFirstReview(g);
  const q = fakeRunner();
  q.state.busy = true;
  await runReviewLoop();
  assert.equal(q.calls[0].stage, 'blind');
  assert.equal(eventNames().includes('s2_review_base_merged'), false);
  setAgentRunner(null);
});

test('a merge held back by the session at work marks the wait, and the stall clock counts from the mark and then from its end', async () => {
  const f = setup();
  await atFirstReview(f);
  await diverge(f);
  // the lane's records are a day old: without a mark the lane would read as stopped for far longer than 45 minutes
  const ledger = join(f.state, readdirSync(f.state).find((n) => /^lifecycle-.*\.jsonl$/.test(n)));
  const rows = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const row of rows) row.at = new Date(Date.parse(row.at) - 24 * 3600_000).toISOString();
  writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = fakeRunner();
  r.state.busy = true;
  await runReviewLoop();
  const waits = () => eventsOf().filter((e) => e.event === 's2_executor_waiting');
  const ends = () => eventsOf().filter((e) => e.event === 's2_executor_wait_ended');
  assert.equal(waits().length, 1, 'the held merge is marked as a wait');
  await runReviewLoop();
  assert.equal(waits().length, 1, 'a lane held across ticks leaves one mark');
  assert.equal(ends().length, 0);
  // the session is gone but the review has not started: the clock counts from the wait, not from the old result
  r.state.busy = false;
  const count = () => eventsOf().filter((e) => e.event === LANE_STALL_DETECTED).length;
  const mark = Date.parse(waits()[0].at);
  await runStallWatch({}, mark + 60_000);
  assert.equal(count(), 0, 'the wait is not counted');
  await runStallWatch({}, mark + 46 * 60_000);
  assert.equal(count(), 1, 'a lane that stays 45 minutes past the mark is a stop');
  assert.equal(eventsOf().find((e) => e.event === LANE_STALL_DETECTED).attrs.since, waits()[0].at);
  setAgentRunner(null);
});

test('the first look that finds the held merge free writes the wait\'s end once', async () => {
  const f = setup();
  await atFirstReview(f);
  await diverge(f);
  const r = fakeRunner();
  r.state.busy = true;
  await runReviewLoop();
  const names = () => eventNames();
  assert.equal(names().filter((n) => n === 's2_executor_wait_ended').length, 0, 'no end while the session works');
  r.state.busy = false;
  await runReviewLoop();
  assert.equal(names().filter((n) => n === 's2_executor_wait_ended').length, 1);
  assert.ok(names().indexOf('s2_executor_waiting') < names().indexOf('s2_executor_wait_ended'), 'after the wait');
  assert.equal(r.calls[0].stage, 'blind', 'the review went on');
  await runReviewLoop();
  assert.equal(names().filter((n) => n === 's2_executor_wait_ended').length, 1, 'a later pass does not write it again');
  assert.equal(names().filter((n) => n === 's2_executor_waiting').length, 1, 'and no wait follows it');
  setAgentRunner(null);
});

test('a runner that cannot tell whether a session is at work records why and starts the blind without the merge', async () => {
  const f = setup();
  await atFirstReview(f);
  await diverge(f);
  const r = fakeRunner({ cwdBusy: false });
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_merged'), false);
  assert.match(String(lastOf('s2_review_base_skipped').attrs.reason), /runtime/);
  assert.equal(r.calls[0].stage, 'blind');
  setAgentRunner(null);
});

test('a lane that already carries the mainline gets no commit and no record twice', async () => {
  const f = setup();
  await atFirstReview(f);
  fakeRunner();
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_merged'), false);
  assert.equal(eventNames().includes('s2_review_base_conflict'), false);
  // after the harness merges, a second pass leaves the head alone
  const before = laneTip(f);
  await appendLifecycle('s2_review_base_merged', 'IDD-1', { head: before, mainline: mainTip(f), review_base: before, by: 'harness' });
  await runReviewLoop();
  assert.equal(laneTip(f), before);
  assert.equal(eventsOf().filter((e) => e.event === 's2_review_base_merged').length, 1);
  setAgentRunner(null);
});

test('a lane that cannot be merged (a dirty worktree or another branch) records why and starts the blind', async () => {
  const f = setup();
  await atFirstReview(f);
  await diverge(f);
  put(join(f.lane.path, 'app.txt'), 'uncommitted\n');
  let r = fakeRunner();
  await runReviewLoop();
  assert.equal(laneTip(f), git(f.lane.path, 'rev-parse', 'HEAD'));
  assert.match(String(lastOf('s2_review_base_skipped').attrs.reason), /未 commit/);
  assert.equal(r.calls[0].stage, 'blind');
  setAgentRunner(null);
  // the worktree on another branch
  const g = setup();
  await atFirstReview(g);
  await diverge(g);
  git(g.lane.path, 'checkout', '-b', 'side');
  const q = fakeRunner();
  await runReviewLoop();
  assert.match(String(lastOf('s2_review_base_skipped').attrs.reason), /branch/);
  assert.equal(q.calls[0].stage, 'blind');
  setAgentRunner(null);
});

test('a repo that publishes, a stacked base, and a base whose lane is gone are left alone', async () => {
  // a repo that publishes
  const pub = setup({ publish: true });
  await atFirstReview(pub);
  await diverge(pub);
  let r = fakeRunner();
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_merged'), false);
  assert.equal(r.calls[0].stage, 'blind');
  setAgentRunner(null);
  // a base no lane publishes (the parent ended, or it never was a lane): external
  const gone = setup();
  await atFirstReview(gone);
  await appendLifecycle('lane_base_set', 'IDD-1', { branch: 'other', parent: null, source: 'manual' });
  await diverge(gone);
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_merged'), false);
  assert.equal(r.calls[0].stage, 'blind');
  setAgentRunner(null);
});

test('a conflict puts the merge to the executor once, waits, and shows the resolution on the card', async () => {
  const f = setup({ pipeline: EXTRAS });
  await atFirstReview(f);
  // the lane and the mainline change the same line, and the mainline adds its own file
  put(join(f.lane.path, 'app.txt'), 'lane\n');
  commit(f.lane.path, 'feat: lane');
  const laneHead = laneTip(f);
  put(join(f.work, 'app.txt'), 'main\n');
  put(join(f.work, 'other.txt'), 'other\n');
  commit(f.work, 'chore: mainline move');
  const tip = mainTip(f);
  const r = fakeRunner();
  await runReviewLoop();
  // the branch did not move and the worktree is clean
  assert.equal(laneTip(f), laneHead);
  assert.equal(clean(f.lane.path), true);
  const rec = lastOf('s2_review_base_conflict');
  assert.deepEqual([rec.attrs.head, rec.attrs.mainline, rec.attrs.awaiting], [laneHead, tip, true]);
  assert.deepEqual(rec.attrs.files, ['app.txt']);
  // the executor was handed the same instruction the landing's send-back uses
  const outbox = readFileSync(join(f.state, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].type, 'lane_rejected');
  assert.equal(outbox[0].skip_fix_plan, true, 'the conflict instruction carries the mark that skips the plan');
  const body = readFileSync(join(f.state, 'outbox', `${outbox[0].envelope_id}.xml`), 'utf8');
  assert.match(body, /work-main/);
  assert.match(body, /app\.txt/);
  // no blind yet, and none of the existing send-back records
  assert.equal(r.calls.length, 0);
  for (const name of ['s4_verify_user_judgment_answered', 's4_land_conflict', 'lane_base_conflict']) assert.equal(eventNames().includes(name), false, name);
  // the state says the conflict is being resolved, and the executor is the awaited agent
  assert.deepEqual(reviewLoopState(eventsOf()), { state: 'awaiting_merge', round: 1 });
  const stage = deriveStage(eventsOf());
  assert.deepEqual([stage.group, stage.blockedBy], ['impl', '衝突の解消中']);
  assert.deepEqual(awaitedAgent(eventsOf()), { role: 'executor', since: eventsOf().findIndex((e) => e.event === 's2_review_base_instructed') });
  setAgentRunner(null);
});

test('after the executor resolves the conflict the first round reads every file and adds the first round\'s roles', async () => {
  const f = setup({ pipeline: EXTRAS });
  await atFirstReview(f);
  put(join(f.lane.path, 'app.txt'), 'lane\n');
  commit(f.lane.path, 'feat: lane');
  put(join(f.work, 'app.txt'), 'main\n');
  put(join(f.work, 'other.txt'), 'other\n');
  commit(f.work, 'chore: mainline move');
  fakeRunner();
  await runReviewLoop();
  assert.equal(reviewLoopState(eventsOf()).state, 'awaiting_merge');
  setAgentRunner(null);
  // the executor merges the mainline and resolves the conflict its way
  git(f.lane.path, 'merge', '--no-edit', '-X', 'ours', 'work-main');
  const resolved = laneTip(f);
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  const r = fakeRunner();
  await runReviewLoop();
  const blind = r.calls[0];
  assert.equal(blind.stage, 'blind');
  assert.equal(blind.round, 1);
  assert.deepEqual(blind.extras, ['first_round']);
  assert.equal(blind.scope, undefined);
  const started = lastOf('s2_review_started');
  assert.equal(started.attrs.round, 1);
  assert.equal(started.attrs.diff_scope, undefined);
  assert.deepEqual(conflictSendBacks(eventsOf()), []);
  assert.equal(blind.base, reviewBaseOf(readLifecycle()));
  // the mainline's own file is not the lane's; the resolved file is
  assert.deepEqual(git(f.lane.path, 'diff', '--name-only', blind.base, resolved).split('\n').sort(), ['app.txt']);
  const rec = lastOf('s2_review_base_merged');
  assert.equal(rec.attrs.by, 'executor');
  setAgentRunner(null);
});

test('a second conflict is not put to the executor again: the reason is recorded and the blind starts', async () => {
  const f = setup({ pipeline: EXTRAS });
  await atFirstReview(f);
  put(join(f.lane.path, 'app.txt'), 'lane\n');
  commit(f.lane.path, 'feat: lane');
  put(join(f.work, 'app.txt'), 'main\n');
  commit(f.work, 'chore: mainline move');
  fakeRunner();
  await runReviewLoop();
  setAgentRunner(null);
  // the executor answers without merging the mainline
  put(join(f.lane.path, 'more.txt'), 'more\n');
  commit(f.lane.path, 'feat: more');
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  const r = fakeRunner();
  await runReviewLoop();
  const outbox = readFileSync(join(f.state, 'outbox.jsonl'), 'utf8').trim().split('\n');
  assert.equal(outbox.length, 1, 'no second instruction');
  const conflicts = eventsOf().filter((e) => e.event === 's2_review_base_conflict');
  assert.equal(conflicts.at(-1).attrs.awaiting, false);
  assert.equal(r.calls[0].stage, 'blind');
  // the instruction was sent and the executor answered without merging: the lane is not awaited, and no origin moves
  assert.equal(awaitedAgent(eventsOf()), null);
  assert.equal(eventNames().includes('s2_review_base_merged'), false);
  setAgentRunner(null);
});

test('the map of a large first round is handed the same advanced base', async () => {
  const f = setup({ pipeline: WITH_MAP });
  await atFirstReview(f);
  await diverge(f);
  const calls = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { calls.push(o); const id = `${o.stage}-x`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
    riskMapSkipReason: () => null,
    cwdBusy: () => false,
  });
  await runReviewLoop();
  const map = calls.find((c) => c.stage === 'map');
  assert.ok(map, calls.map((c) => c.stage).join(','));
  assert.equal(map.base, reviewBaseOf(readLifecycle()));
  setAgentRunner(null);
  assert.ok(f);
});

test('a blind held back by another lane\'s running round still advances the origin', async () => {
  // two lanes in one repo: the other holds the blind slot
  const f = setup({ lanes: ['IDD-1', 'IDD-2'] });
  await atFirstReview(f);
  await diverge(f);
  const other = f.lanes['IDD-2'];
  await seedLifecycle('lane_open', 'IDD-2', {});
  await seedLifecycle('s2_start', 'IDD-2', { started_from_commit: git(other.path, 'rev-parse', 'HEAD') });
  await seedLifecycle('s2_result', 'IDD-2', { outcome: 'success' });
  await seedLifecycle('s2_review_started', 'IDD-2', { kind: 'blind', round: 1, run_ids: ['held'] });
  const status = { held: { state: 'running' } };
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async () => ({ runIds: ['x'] }),
    reviewRunStatus: (id) => status[id],
    cwdBusy: () => false,
  });
  await runReviewLoop();
  // the slot was full, so IDD-1's blind did not start, but its merge and origin record are written
  assert.equal(eventNames('IDD-1').includes('s2_review_started'), false);
  assert.equal(eventNames('IDD-1').includes('s2_review_base_merged'), true);
  assert.equal(reviewBaseOf(eventsOf()), lastOf('s2_review_base_merged').attrs.review_base);
  setAgentRunner(null);
  // the slot frees: the blind starts on the advanced base
  status.held = { state: 'done', reportJson: '/r.json', reportMd: '/r.md', findings: [] };
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o); const id = `${o.stage}-new`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
    cwdBusy: () => false,
  });
  await runReviewLoop();
  await runReviewLoop();
  const blind = started.find((c) => c.stage === 'blind');
  assert.ok(blind, JSON.stringify({ started, e1: eventNames('IDD-1'), e2: eventNames('IDD-2') }));
  assert.equal(blind.base, reviewBaseOf(eventsOf()));
  assert.equal(eventsOf('IDD-1').filter((e) => e.event === 's2_review_base_merged').length, 1, 'the origin was not advanced twice');
  setAgentRunner(null);
});

test('a start failure after the merge leaves the origin recorded for the next try', async () => {
  const f = setup();
  await atFirstReview(f);
  await diverge(f);
  let fail = true;
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async () => { if (fail) { fail = false; throw new Error('起動できません'); } return { runIds: ['b'] }; },
    reviewRunStatus: () => ({ state: 'running' }),
    cwdBusy: () => false,
  });
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_merged'), true);
  assert.equal(eventNames().includes('s2_review_run_failed'), true);
  // regardless of whether the blind ever ran, the origin is the merged base
  const rec = lastOf('s2_review_base_merged');
  assert.equal(reviewBaseOf(eventsOf()), rec.attrs.review_base);
  setAgentRunner(null);
});

const outboxLines = (f) => existsSync(join(f.state, 'outbox.jsonl'))
  ? readFileSync(join(f.state, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

test('an instruction that cannot be queued leaves the lane waiting, and the next pass sends it again', async () => {
  const f = setup();
  await atFirstReview(f);
  put(join(f.lane.path, 'app.txt'), 'lane\n');
  commit(f.lane.path, 'feat: lane');
  put(join(f.work, 'app.txt'), 'main\n');
  commit(f.work, 'chore: mainline move');
  // the envelope cannot be queued: the outbox path is a file, not a directory
  put(join(f.state, 'outbox'), 'not a directory');
  const r = fakeRunner();
  const res = await runReviewLoop();
  // the wait is recorded, the instruction is not, and the review does not begin
  assert.equal(lastOf('s2_review_base_conflict').attrs.awaiting, true);
  assert.equal(eventNames().includes('s2_review_base_instructed'), false);
  assert.equal(eventNames().includes('s2_review_base_skipped'), false);
  assert.equal(eventNames().includes('s2_review_run_failed'), false);
  assert.equal(eventNames().includes('s2_review_escalated'), false);
  assert.equal(startRetryWaiting(eventsOf()), false);
  assert.equal(r.calls.length, 0);
  assert.equal(res.errors.some((e) => e.iddId === 'IDD-1'), true);
  assert.deepEqual(reviewLoopState(eventsOf()), { state: 'awaiting_merge', round: 1 });
  assert.equal(awaitedAgent(eventsOf()), null, 'no instruction on record, so the executor is not awaited');
  // the cause is removed: the same lane is sent the instruction on the next pass, with no time advanced
  rmSync(join(f.state, 'outbox'), { force: true });
  await runReviewLoop();
  const outbox = outboxLines(f);
  assert.equal(outbox.length, 1);
  const body = readFileSync(join(f.state, 'outbox', `${outbox[0].envelope_id}.xml`), 'utf8');
  assert.match(body, /work-main/);
  assert.match(body, /app\.txt/);
  assert.equal(eventNames().includes('s2_review_base_instructed'), true);
  // an instructed wait is not instructed again, and a delivered one is not either
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(outboxLines(f).length, 1);
  put(join(f.state, 'outbox.jsonl'), outboxLines(f).map((o) => JSON.stringify({ ...o, delivered_at: new Date().toISOString() })).join('\n') + '\n');
  await runReviewLoop();
  assert.equal(outboxLines(f).length, 1);
  // the executor resolves the conflict after the instruction; the first blind begins
  git(f.lane.path, 'merge', '--no-edit', '-X', 'ours', 'work-main');
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  const started = fakeRunner();
  await runReviewLoop();
  assert.equal(started.calls[0].stage, 'blind');
  setAgentRunner(null);
});

test('a second conflict advances the origin past the mainline the executor already merged', async () => {
  const f = setup({ pipeline: EXTRAS });
  await atFirstReview(f);
  put(join(f.lane.path, 'app.txt'), 'lane\n');
  commit(f.lane.path, 'feat: lane');
  put(join(f.work, 'app.txt'), 'main\n');
  put(join(f.work, 'main-only.txt'), 'one\n');
  commit(f.work, 'chore: mainline one');
  const tip1 = mainTip(f);
  fakeRunner();
  await runReviewLoop();
  assert.equal(reviewLoopState(eventsOf()).state, 'awaiting_merge');
  assert.equal(outboxLines(f).length, 1);
  setAgentRunner(null);
  // the executor merges the mainline and resolves the file its own way
  git(f.lane.path, 'merge', '--no-edit', '-X', 'ours', 'work-main');
  put(join(f.lane.path, 'app.txt'), 'lane resolved\n');
  commit(f.lane.path, 'feat: resolve');
  const head = laneTip(f);
  // the mainline moves again: the same line changes and its own file is added
  put(join(f.work, 'app.txt'), 'main two\n');
  put(join(f.work, 'main-only-2.txt'), 'two\n');
  commit(f.work, 'chore: mainline two');
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  const r = fakeRunner();
  await runReviewLoop();
  // no second instruction, and the blind begins
  assert.equal(outboxLines(f).length, 1);
  assert.equal(r.calls[0]?.stage, 'blind');
  const blind = r.calls[0];
  // the origin carries the mainline the lane already has; the first mainline's file is not the lane's, the
  // resolved file is, and the second mainline's file is not shown as a deletion
  assert.equal(reviewBaseOf(readLifecycle()), blind.base);
  assert.doesNotThrow(() => git(f.lane.path, 'merge-base', '--is-ancestor', tip1, blind.base));
  assert.deepEqual(git(f.lane.path, 'diff', '--name-only', blind.base, head).split('\n').sort(), ['app.txt']);
  assert.equal(/^D\tmain-only-2\.txt$/m.test(git(f.lane.path, 'diff', '--name-status', blind.base, head)), false);
  // a pass again records no second origin
  const before = eventsOf().filter((e) => e.event === 's2_review_base_merged').length;
  await runReviewLoop();
  assert.equal(eventsOf().filter((e) => e.event === 's2_review_base_merged').length, before);
  assert.equal(reviewBaseOf(readLifecycle()), blind.base);
  setAgentRunner(null);
});

test('an origin advanced while the blind slot is full is the base the later pass reads', async () => {
  const f = setup({ lanes: ['IDD-1', 'IDD-2'] });
  await atFirstReview(f, 'IDD-1');
  // the other lane holds the blind slot
  await seedLifecycle('lane_open', 'IDD-2', {});
  await seedLifecycle('s2_start', 'IDD-2', { started_from_commit: git(f.lanes['IDD-2'].path, 'rev-parse', 'HEAD') });
  await seedLifecycle('s2_result', 'IDD-2', { outcome: 'success' });
  await seedLifecycle('s2_review_started', 'IDD-2', { kind: 'blind', round: 1, run_ids: ['held'] });
  put(join(f.lane.path, 'app.txt'), 'lane\n');
  commit(f.lane.path, 'feat: lane');
  put(join(f.work, 'app.txt'), 'main\n');
  put(join(f.work, 'main-only.txt'), 'one\n');
  commit(f.work, 'chore: mainline one');
  const status = { held: { state: 'running' } };
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o); const id = `${o.stage}-${started.length}`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
    cwdBusy: () => false,
  });
  await runReviewLoop();
  assert.equal(reviewLoopState(eventsOf('IDD-1')).state, 'awaiting_merge');
  // the executor merges and answers; the mainline moves again
  git(f.lane.path, 'merge', '--no-edit', '-X', 'ours', 'work-main');
  put(join(f.lane.path, 'app.txt'), 'lane resolved\n');
  commit(f.lane.path, 'feat: resolve');
  const head = laneTip(f);
  put(join(f.work, 'app.txt'), 'main two\n');
  commit(f.work, 'chore: mainline two');
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  // the slot is full: the origin moves but the blind does not start
  await runReviewLoop();
  assert.equal(eventNames('IDD-1').includes('s2_review_base_merged'), true);
  assert.equal(eventNames('IDD-1').includes('s2_review_started'), false);
  const base = reviewBaseOf(eventsOf('IDD-1'));
  // the slot frees: the blind starts on the recorded base
  status.held = { state: 'done', reportJson: '/r.json', reportMd: '/r.md', findings: [] };
  await runReviewLoop();
  await runReviewLoop();
  const blind = started.find((c) => c.stage === 'blind');
  assert.ok(blind, JSON.stringify({ started: started.map((c) => c.stage) }));
  assert.equal(blind.base, base);
  assert.equal(eventNames('IDD-1').filter((e) => e === 's2_review_base_merged').length, 1);
  assert.deepEqual(git(f.lane.path, 'diff', '--name-only', blind.base, head).split('\n').sort(), ['app.txt']);
  setAgentRunner(null);
});

test('a runtime without cwdBusy still advances the origin past the mainline the lane already merged', async () => {
  const f = setup();
  await atFirstReview(f);
  await diverge(f);
  git(f.lane.path, 'merge', '--no-edit', 'work-main');
  const tip1 = mainTip(f);
  // the mainline moves on past what the lane took in
  put(join(f.work, 'later.txt'), 'later\n');
  commit(f.work, 'chore: later');
  const head = laneTip(f);
  const r = fakeRunner({ cwdBusy: false });
  await runReviewLoop();
  assert.equal(eventNames().includes('s2_review_base_skipped'), true);
  assert.equal(r.calls[0].stage, 'blind');
  const blind = r.calls[0];
  assert.doesNotThrow(() => git(f.lane.path, 'merge-base', '--is-ancestor', tip1, blind.base));
  assert.deepEqual(git(f.lane.path, 'diff', '--name-only', blind.base, head).split('\n').sort(), ['lane.txt']);
  setAgentRunner(null);
});

test('the pre-review merge happens only before the first review', async () => {
  const f = setup();
  await atFirstReview(f);
  // the lane has reviewed once and reached the submit check
  await seedLifecycle('s2_review_started', 'IDD-1', { kind: 'blind', round: 1, head: laneTip(f), run_ids: ['b'] });
  await seedLifecycle('s2_review_converged', 'IDD-1', {});
  await seedLifecycle('s2_device_skipped', 'IDD-1', {});
  await seedLifecycle('s3_ready', 'IDD-1', {});
  // penne sends it back, and the mainline moves with a conflict
  await seedLifecycle('s4_verify_user_judgment_answered', 'IDD-1', { outcome: 'revise', instruction: 'x', by: 'penne' });
  put(join(f.lane.path, 'app.txt'), 'lane\n');
  commit(f.lane.path, 'feat: lane');
  put(join(f.work, 'app.txt'), 'main\n');
  put(join(f.work, 'other.txt'), 'other\n');
  commit(f.work, 'chore: mainline move');
  const head = laneTip(f);
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(laneTip(f), head, 'the lane head did not move');
  for (const name of ['s2_review_base_merged', 's2_review_base_conflict', 's2_review_base_skipped']) {
    assert.equal(eventNames().includes(name), false, name);
  }
  assert.equal(outboxLines(f).length, 0);
  assert.equal(r.calls[0].stage, 'blind');
  setAgentRunner(null);
  // the final review of a first pass does not merge either, even when the mainline conflicts
  const g = setup();
  await atFirstReview(g);
  const fixedHead = laneTip(g);
  await seedLifecycle('s2_review_started', 'IDD-1', { kind: 'blind', round: 1, head: fixedHead, run_ids: ['b'] });
  await seedLifecycle('s2_review_findings', 'IDD-1', { kind: 'blind', round: 1, files: ['/b.json'] });
  await seedLifecycle('s2_triage_done', 'IDD-1', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'x' }] });
  await seedLifecycle('s2_fix_sent', 'IDD-1', { round: 1, refs: ['F-1'] });
  await seedLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  await seedLifecycle('s2_confirm_started', 'IDD-1', { round: 1, run_id: 'c' });
  await seedLifecycle('s2_confirm_done', 'IDD-1', { round: 1, new_blocking: 0, unresolved_must: 0, unresolved_should: 0 });
  put(join(g.work, 'app.txt'), 'main\n');
  commit(g.work, 'chore: mainline move');
  const beforeFinal = laneTip(g);
  const q = fakeRunner();
  await runReviewLoop();
  assert.equal(laneTip(g), beforeFinal, 'the lane head did not move for the final review');
  assert.equal(eventNames('IDD-1').includes('s2_review_base_merged'), false);
  assert.equal(q.calls[0].stage, 'final');
  setAgentRunner(null);
});

// ---- IDD-072: the mainline taken in before the first blind is not the lane's change ----

const RISK_EXTRAS = '  review_blind: { roles: [v], first_round_extra: [o], high_risk_extra: [o] }\n  triage: { role: v }\n  confirm: { role: v }\n';
const REC1 = { idd_id: 'IDD-1', parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: 'https://github.com/test/project/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'feat: IDD-1', area: 'demo' };
const QA_MEDIUM = '---\nqa_schema: 5\nrisk: Medium\n---\n';

test('a mainline change to a declared path does not raise the lane at its first blind', async () => {
  const f = setup({ pipeline: RISK_EXTRAS, riskPaths: { auth: ['guard/'] } });
  const qa = planReviewInputs(REC1)[1];
  await atFirstReview(f);
  await diverge(f, { lane: { 'lane.txt': 'lane\n', [qa]: QA_MEDIUM }, main: { 'guard/x.ts': 'export const x = 1;\n' } });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].stage, 'blind');
  assert.deepEqual(r.calls[0].extras, ['first_round'], 'the merge took the mainline\'s declared path in, not the lane');
  assert.equal(lastOf('s2_review_started').attrs.risk_match, undefined);
  setAgentRunner(null);
});

test('the lane\'s own change to a declared path raises the first blind after the merge', async () => {
  const f = setup({ pipeline: RISK_EXTRAS, riskPaths: { auth: ['guard/'] } });
  const qa = planReviewInputs(REC1)[1];
  await atFirstReview(f);
  await diverge(f, { lane: { 'lane.txt': 'lane\n', [qa]: QA_MEDIUM, 'guard/lane.ts': 'export const lane = 1;\n' }, main: { 'main.txt': 'main\n' } });
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls[0].extras, ['first_round', 'high_risk']);
  assert.deepEqual(lastOf('s2_review_started').attrs.risk_match, { hits: [{ kind: 'auth', paths: ['guard/lane.ts'], total: 1 }] });
  setAgentRunner(null);
});

// ---- generated files made again in the pre-review merge (C-266-1 / C-266-2 / C-266-3) ----

const showFile = (cwd, rev, path) => execFileSync('git', ['show', `${rev}:${path}`], { cwd, encoding: 'utf8' });
const textOf = (f, name) => readFileSync(join(f.lane.path, name), 'utf8');
const parentsOf = (f, head) => git(f.lane.path, 'rev-list', '--parents', '-n', '1', head).split(' ').slice(1);
const conflictRecords = () => eventsOf().filter((e) => e.event === 's2_review_base_conflict');
const outboxLength = (f) => { try { return readFileSync(join(f.state, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

/** a lane and a mainline that both hold src.txt and the gen.txt built from it, the lane at the first review */
async function setupGen(generated = [GEN], pipeline = EXTRAS) {
  const f = setup({ pipeline, generated });
  seedGenerated(f.work, [f.lane.path]);
  await atFirstReview(f);
  return f;
}
/** the lane changes line 3 and builds its own, the mainline line 1: src.txt merges, gen.txt conflicts */
function bothBuild(f) {
  builds(f.lane.path, BOTTOM, 'feat: lane builds');
  builds(f.work, TOP, 'chore: mainline builds');
}
/** one pass of the review loop over the lane, with the heads it started from and the runner it was given */
async function runPass(f) {
  const before = { laneHead: laneTip(f), tip: mainTip(f) };
  const r = fakeRunner();
  await runReviewLoop();
  return { ...before, r, head: laneTip(f) };
}
/** the pass merged the mainline into the lane's head as a merge commit of the two */
function assertMerged(f, pass, label) {
  assert.deepEqual(parentsOf(f, pass.head), [pass.laneHead, pass.tip], label);
  assert.equal(lastOf('s2_review_base_merged').attrs.merge_commit, pass.head, label);
}
/** the pass left the branch where it was and put the executor to a conflict on `files` once */
function assertSentBack(f, pass, files, label) {
  assert.equal(pass.head, pass.laneHead, label);
  const rec = lastOf('s2_review_base_conflict');
  assert.deepEqual([rec.attrs.head, rec.attrs.mainline, rec.attrs.awaiting], [pass.laneHead, pass.tip, true], label);
  assert.deepEqual([...rec.attrs.files].sort(), files, label);
  assert.equal(outboxLength(f), 1, label);
  assert.equal(eventNames().includes('s2_review_base_merged'), false, label);
  return rec;
}

test('AC-001: a conflict on a generated file alone is made again from the merged sources, and the executor is not sent for it', async () => {
  const f = await setupGen();
  bothBuild(f);
  const pass = await runPass(f);
  assertMerged(f, pass);
  assert.equal(clean(f.lane.path), true);
  assert.equal(textOf(f, 'src.txt'), TOP_AND_BOTTOM);
  assert.equal(textOf(f, 'gen.txt'), genOf(TOP_AND_BOTTOM), 'the merge commit holds what the merged sources build');
  const rec = lastOf('s2_review_base_merged');
  assert.deepEqual([rec.attrs.by, rec.attrs.rebuild_failure], ['harness', undefined]);
  // no conflict, no instruction, no wait for the executor: the review begins on the merge
  for (const name of ['s2_review_base_conflict', 's2_review_base_instructed']) assert.equal(eventNames().includes(name), false, name);
  assert.equal(outboxLength(f), 0);
  assert.equal(pass.r.calls[0]?.stage, 'blind');
  assert.equal(pass.r.calls[0]?.base, reviewBaseOf(readLifecycle()));
  setAgentRunner(null);
});

test('AC-001: a generated file git merged without a conflict is still made again from the merged sources', async () => {
  const f = await setupGen();
  mainlineBuildsLaneEditsSource(f);
  const textual = git(f.work, 'merge-tree', '--write-tree', 'work-main', laneTip(f));
  assert.equal(showFile(f.work, textual, 'gen.txt'), genOf(TOP), 'git alone would have put a stale build into the lane');
  await runPass(f);
  assert.equal(textOf(f, 'gen.txt'), genOf(TOP_AND_BOTTOM));
  assert.equal(textOf(f, 'src.txt'), TOP_AND_BOTTOM);
  assert.equal(lastOf('s2_review_base_merged').attrs.rebuild_failure, undefined);
  assert.equal(outboxLength(f), 0);
  setAgentRunner(null);
});

test('AC-001: a merge that touches no generated file keeps the tree git made, even when the build there is stale', async () => {
  const f = setup({ pipeline: EXTRAS, generated: [GEN] });
  writeIn(f.work, { 'src.txt': SRC, 'gen.txt': 'NOT BUILT FROM SRC\n' }, 'chore: seed a stale build');
  git(f.lane.path, 'merge', '--ff-only', 'work-main');
  await atFirstReview(f);
  await diverge(f);
  await runPass(f);
  assert.equal(textOf(f, 'gen.txt'), 'NOT BUILT FROM SRC\n');
  assert.equal(lastOf('s2_review_base_merged').attrs.rebuild_failure, undefined);
  setAgentRunner(null);
});

test('AC-002: a source that conflicts goes to the executor once, whatever the generated file does, and nothing is merged', async () => {
  const f = await setupGen();
  builds(f.lane.path, TOP_OTHER);
  builds(f.work, TOP);
  const pass = await runPass(f);
  assert.equal(assertSentBack(f, pass, ['gen.txt', 'src.txt']).attrs.rebuild_failure, undefined, 'nothing was made again from conflict-marked sources');
  assert.equal(clean(f.lane.path), true);
  assert.equal(pass.r.calls.length, 0);
  // a second look does not send it again
  await runReviewLoop();
  assert.equal(outboxLength(f), 1);
  setAgentRunner(null);
});

test('AC-003: a rebuild that cannot be made sends a generated-only conflict to the executor, and says which side failed', async () => {
  const cases = [['exit 1', 'build'], ['true', 'build'], ['definitely-not-an-installed-tool-266 build', 'environment'], ['exit 127', 'environment']];
  for (const [command, cause] of cases) {
    const f = await setupGen([{ ...GEN, command }]);
    bothBuild(f);
    const rec = assertSentBack(f, await runPass(f), ['gen.txt'], command);
    assert.equal(rec.attrs.rebuild_failure?.cause, cause, command);
    assert.deepEqual(rec.attrs.rebuild_failure?.paths, ['gen.txt'], command);
    assert.ok(rec.attrs.rebuild_failure?.reason, command);
    setAgentRunner(null);
  }
});

test('AC-003: a conflict record already there for this head and mainline does not hide why the rebuild could not be made', async () => {
  const f = await setupGen([{ ...GEN, command: 'exit 127' }]);
  bothBuild(f);
  await appendLifecycle('s2_review_base_conflict', 'IDD-1', { head: laneTip(f), mainline: mainTip(f), files: ['gen.txt'], awaiting: true });
  fakeRunner();
  await runReviewLoop();
  assert.equal(conflictRecords().length, 2, 'the failure is written once, after the record without it');
  assert.deepEqual([conflictRecords().at(-1).attrs.rebuild_failure?.cause, conflictRecords().at(-1).attrs.rebuild_failure?.paths], ['environment', ['gen.txt']]);
  assert.equal(outboxLength(f), 1);
  // a later pass for the same failure does not write it again
  await runReviewLoop();
  assert.equal(conflictRecords().length, 2);
  assert.equal(outboxLength(f), 1);
  setAgentRunner(null);
});

test('AC-003: a rebuild that cannot be made leaves a merge git made as git made it, with the reason on the record', async () => {
  for (const [command, cause] of [['exit 1', 'build'], ['exit 127', 'environment']]) {
    const f = await setupGen([{ ...GEN, command }]);
    mainlineBuildsLaneEditsSource(f);
    const pass = await runPass(f);
    assertMerged(f, pass, command);
    assert.equal(textOf(f, 'gen.txt'), genOf(TOP), `${command}: the text merge, unbuilt`);
    const failure = lastOf('s2_review_base_merged').attrs.rebuild_failure;
    assert.deepEqual([failure?.cause, failure?.paths], [cause, ['gen.txt']], command);
    assert.equal(outboxLength(f), 0, command);
    assert.equal(pass.r.calls[0]?.stage, 'blind', 'the failure holds nothing back');
    setAgentRunner(null);
  }
});

test('AC-006: a repo that declares nothing sends a generated-only conflict to the executor, as before', async () => {
  const f = await setupGen(null);
  bothBuild(f);
  assert.equal(assertSentBack(f, await runPass(f), ['gen.txt']).attrs.rebuild_failure, undefined);
  // and a merge git made is kept as git made it: nothing is made again
  const g = await setupGen(null);
  mainlineBuildsLaneEditsSource(g);
  await runReviewLoop();
  assert.equal(textOf(g, 'gen.txt'), genOf(TOP));
  assert.equal(lastOf('s2_review_base_merged').attrs.rebuild_failure, undefined);
  setAgentRunner(null);
});

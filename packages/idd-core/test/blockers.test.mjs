import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { BLOCKER_STATE_TTL_MS, goBlockedReason, laneBlockerWait, laneLanded, lifecycleByLane, resetBlockerStateCache } from '../src/ledger/blockers.ts';
import { blockerResumeInstruction, runBlockerWaits } from '../src/plan/blockers.ts';
import { isReturnedResult, reviewLoopState } from '../src/ledger/review-loop.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { applyDecision } from '../src/ledger/write.ts';
import { readBacklog, readLifecycle } from '../src/ledger/read.ts';
import { openLaneForIssue } from '../src/intake/run.ts';
import { runAutoGo } from '../src/plan/auto-go.ts';

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
afterEach(() => {
  resetBlockerStateCache();
  if (saved.state === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved.state;
  if (saved.repos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved.repos;
});

const T0 = Date.parse('2026-10-18T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const ev = (idd, event, min, attrs = {}) => ({ event, idd_id: idd, at: at(min), attrs });

/** a Linear blocker: this engine has no tracker read for it, so its recorded state stands unless a lane landed */
const linearBlocker = (over = {}) => ({ ref: 'APP-9', title: 'the premise', url: 'https://linear.app/x/issue/APP-9', state: 'open', scope: 'APP', outOfScope: false, ...over });
/** a GitHub blocker: read through the tracker (injected in tests) */
const ghBlocker = (over = {}) => ({ ref: '#9', title: 'the premise', url: 'https://github.com/o/r/issues/9', state: 'open', scope: 'o/r', outOfScope: false, ...over });

const row = (idd, over = {}) => ({
  idd_id: idd, parent_id: null, created_at: at(0), linear_issue_url: null, gh_issue_url: null, pull_req_url: null,
  source_type: 'github', context: '', title: `lane ${idd}`, area: 'Demo', ...over,
});

/** a state with the given backlog rows and lifecycle events; repos.yaml knows no repo, so the area resolves to nothing */
function setup(rows, events) {
  const root = scratchDir('blockers-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: {} }));
  process.env.IDD_STATE_DIR = state; process.env.IDD_REPOS_FILE = join(root, 'repos.yaml');
  writeFileSync(join(state, 'backlog.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  return { state, root };
}

const lifecycleOf = (idd) => readLifecycle().filter((e) => e.idd_id === idd);
const outboxOf = (state) => (existsSync(join(state, 'outbox.jsonl')) ? readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

/** the blocked lane (IDD-2, from #3) and the lane of its blocker (IDD-1, from #9) */
const laneAndBlocker = (blocker = ghBlocker()) => [
  row('IDD-1', { gh_issue_url: 'https://github.com/o/r/issues/9', title: 'the premise' }),
  row('IDD-2', { gh_issue_url: 'https://github.com/o/r/issues/3', blockers: [blocker] }),
];

test('intake keeps the same-repo blockers on the lane (an out-of-scope one is not followed, none means no field)', async () => {
  setup([], []);
  const issue = {
    source: 'github', ref: '#3', title: 'T', url: 'https://github.com/o/r/issues/3', body: 'B', area: 'Demo', repo: 'o/r', primary: true, number: 3,
    blockers: [ghBlocker(), ghBlocker({ ref: '#5', url: 'https://github.com/other/repo/issues/5', scope: 'other/repo', outOfScope: true })],
    blockersTruncated: false,
  };
  const made = await openLaneForIssue(issue);
  assert.ok('added' in made);
  const rec = readBacklog().find((r) => r.idd_id === made.added);
  assert.deepEqual(rec.blockers.map((b) => b.ref), ['#9']);
  // a second Issue without dependencies carries no field at all (older rows look the same)
  const plain = await openLaneForIssue({ ...issue, ref: '#4', url: 'https://github.com/o/r/issues/4', number: 4, blockers: [] });
  assert.ok(!('blockers' in readBacklog().find((r) => r.idd_id === plain.added)));
});

test('a blocker whose lane landed in the mainline, or whose tracker says closed, holds nothing', () => {
  const rows = laneAndBlocker();
  // landed: the lane opened from #9 merged into the work side's mainline
  const landed = lifecycleByLane([ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's4_land_merged', 10, { merge_commit: 'abc' })]);
  assert.equal(laneBlockerWait(rows[1], { backlog: rows, byLane: landed }), null);
  assert.equal(laneLanded([ev('IDD-1', 'lane_close', 1, { merged_commit: 'abc' })]), true);
  assert.equal(laneLanded([ev('IDD-1', 'lane_close', 1, { outcome: 'aborted' })]), false);
  // closed on the tracker: read once, then kept for the TTL
  let reads = 0;
  const tracker = () => { reads += 1; return 'closed'; };
  const open = lifecycleByLane([ev('IDD-1', 'lane_open', 0)]);
  assert.equal(laneBlockerWait(rows[1], { backlog: rows, byLane: open, refresh: true, tracker, now: T0 }), null);
  assert.equal(laneBlockerWait(rows[1], { backlog: rows, byLane: open, refresh: true, tracker, now: T0 + 1000 }), null);
  assert.equal(reads, 1);
  // past the TTL the tracker is read again
  laneBlockerWait(rows[1], { backlog: rows, byLane: open, refresh: true, tracker, now: T0 + BLOCKER_STATE_TTL_MS + 1 });
  assert.equal(reads, 2);
});

test('an open blocker holds the lane with the lane it names; an unreadable tracker holds it as unknown', () => {
  const rows = laneAndBlocker();
  const byLane = lifecycleByLane([ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's1_ready', 1)]);
  const open = laneBlockerWait(rows[1], { backlog: rows, byLane, refresh: true, tracker: () => 'open', now: T0 });
  assert.deepEqual(open.items, [{ ref: '#9', title: 'the premise', url: 'https://github.com/o/r/issues/9', state: 'open', lane: 'IDD-1' }]);
  assert.match(open.reason, /着地していません（#9）/);
  resetBlockerStateCache();
  const unknown = laneBlockerWait(rows[1], { backlog: rows, byLane, refresh: true, tracker: () => null, now: T0 });
  assert.equal(unknown.items[0].state, 'unknown');
  assert.match(unknown.reason, /読めません（#9）/);
  // without a refresh and nothing kept, the state intake recorded stands
  resetBlockerStateCache();
  assert.equal(laneBlockerWait(rows[1], { backlog: rows, byLane }).items[0].state, 'open');
  const closedAtIntake = { ...rows[1], blockers: [ghBlocker({ state: 'closed' })] };
  assert.equal(laneBlockerWait(closedAtIntake, { backlog: [rows[0], closedAtIntake], byLane }), null);
  // an out-of-scope blocker is not followed
  assert.equal(laneBlockerWait({ ...rows[1], blockers: [ghBlocker({ outOfScope: true })] }, { backlog: rows, byLane }), null);
});

test('the GO is refused while a recorded blocker has not landed, by a person and by the engine alike', async () => {
  const atGo = (idd) => [ev(idd, 'lane_open', 0), ev(idd, 's1_ready', 1, { depth: 'shallow' }), ev(idd, 's1_plan_review_done', 2, { must: 0 })];
  // the blocker is a Linear Issue: no tracker read here, so only its lane's landing (or the recorded state) decides
  const rows = [
    row('IDD-1', { source_type: 'linear', linear_issue_url: 'https://linear.app/x/issue/APP-9', title: 'the premise' }),
    row('IDD-2', { gh_issue_url: 'https://github.com/o/r/issues/3', blockers: [linearBlocker()] }),
  ];
  const { state } = setup(rows, [ev('IDD-1', 'lane_open', 0), ...atGo('IDD-2')]);
  assert.equal(deriveStage(lifecycleOf('IDD-2')).decision, 'go');
  assert.match(goBlockedReason('IDD-2'), /GO できません.*APP-9/);
  const pressed = await applyDecision('s1_go', { iddId: 'IDD-2' });
  assert.equal(pressed.ok, false);
  assert.match(pressed.error, /blocker/);
  // the engine's automatic GO leaves the lane without an error line
  const auto = await runAutoGo();
  assert.deepEqual(auto.recorded, []);
  assert.deepEqual(auto.errors, []);
  assert.ok(!lifecycleOf('IDD-2').some((e) => e.event === 's1_go'));
  // the blocker's lane lands: the GO goes through
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8') + JSON.stringify(ev('IDD-1', 's4_land_merged', 5, { merge_commit: 'abc' })) + '\n');
  assert.equal(goBlockedReason('IDD-2'), null);
  assert.equal((await applyDecision('s1_go', { iddId: 'IDD-2' })).ok, true);
  // a lane without recorded blockers is never held
  assert.equal(goBlockedReason('IDD-1'), null);
});

test('a first result that returned without a change starts no review round', () => {
  const base = [ev('IDD-2', 'lane_open', 0), ev('IDD-2', 's1_go', 1), ev('IDD-2', 's2_start', 2)];
  const returned = ev('IDD-2', 's2_result', 3, { outcome: 'failed', changed_files: [], commit_count: 0 });
  assert.equal(isReturnedResult(returned), true);
  assert.equal(isReturnedResult(ev('IDD-2', 's2_result', 3, { outcome: 'failed', changed_files: ['a.ts'] })), false);
  assert.equal(isReturnedResult(ev('IDD-2', 's2_result', 3, { outcome: 'success', changed_files: [] })), false);
  assert.deepEqual(reviewLoopState([...base, returned]), { state: 'idle' });
  assert.equal(reviewLoopState([...base, ev('IDD-2', 's2_result', 3, { outcome: 'failed', changed_files: ['a.ts'] })]).state, 'start_blind');
  assert.equal(reviewLoopState([...base, ev('IDD-2', 's2_result', 3, { outcome: 'success', changed_files: [] })]).state, 'start_blind');
  // a return after the loop ran is read as before (a fix round's answer goes to its confirm)
  const inLoop = [...base, ev('IDD-2', 's2_result', 3, { outcome: 'success', changed_files: ['a.ts'] }), ev('IDD-2', 's2_fix_sent', 4), returned];
  assert.equal(reviewLoopState(inLoop).state, 'start_confirm');
});

test('a returned lane waits on its blocker, and is sent back through the S4 revise door once the blocker landed', async () => {
  const { state } = setup(laneAndBlocker(), [
    ev('IDD-1', 'lane_open', 0),
    ev('IDD-2', 'lane_open', 0), ev('IDD-2', 's1_go', 1), ev('IDD-2', 's2_start', 2),
    ev('IDD-2', 's2_result', 3, { outcome: 'failed', changed_files: [], commit_count: 0 }),
  ]);
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-2', executor_session_id: 'e1', worktree_path: join(state, 'wt'), branch: 'idd/IDD-2' }) + '\n');
  const first = await runBlockerWaits({ tracker: () => 'open', now: T0 });
  assert.deepEqual(first.waited, ['IDD-2']);
  assert.deepEqual(first.errors, []);
  const wait = lifecycleOf('IDD-2').at(-1);
  assert.equal(wait.event, 'blocked_by_dependency');
  assert.deepEqual(wait.attrs.depends_on, ['#9']);
  assert.deepEqual(wait.attrs.waiting_for, ['#9 the premise']);
  const stage = deriveStage(lifecycleOf('IDD-2'));
  assert.equal(stage.group, 'waiting');
  assert.equal(stage.blockedBy, '#9');
  // still waiting: nothing more is written, and no review starts
  const again = await runBlockerWaits({ tracker: () => 'open', now: T0 + BLOCKER_STATE_TTL_MS + 1 });
  assert.deepEqual(again, { waited: [], released: [], halted: [], errors: [] });
  assert.equal(lifecycleOf('IDD-2').filter((e) => e.event === 'blocked_by_dependency').length, 1);
  assert.equal(reviewLoopState(lifecycleOf('IDD-2')).state, 'idle');
  // the blocker's lane lands: the executor is sent back as an S4 revise sends it
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8') + JSON.stringify(ev('IDD-1', 's4_land_merged', 20, { merge_commit: 'abc' })) + '\n');
  const released = await runBlockerWaits({ tracker: () => 'open', now: T0 + 2 * BLOCKER_STATE_TTL_MS });
  assert.deepEqual(released.released, ['IDD-2']);
  assert.deepEqual(released.errors, []);
  const sent = lifecycleOf('IDD-2').at(-1);
  assert.equal(sent.event, 's4_verify_user_judgment_answered');
  assert.equal(sent.attrs.outcome, 'revise');
  assert.equal(sent.attrs.by, 'harness');
  assert.match(sent.attrs.instruction, /#9/);
  assert.match(sent.attrs.instruction, /merge/);
  assert.match(sent.attrs.instruction, /rebase 禁止/);
  const envelopes = outboxOf(state).filter((e) => e.idd_id === 'IDD-2');
  assert.deepEqual(envelopes.map((e) => e.type), ['lane_rejected']);
  const after = deriveStage(lifecycleOf('IDD-2'));
  assert.equal(after.group, 'impl');
  assert.equal(after.stageDone, 2);
  // the loop still starts nothing until the executor's new result
  assert.equal(reviewLoopState(lifecycleOf('IDD-2')).state, 'idle');
  // a later pass writes nothing more
  assert.deepEqual(await runBlockerWaits({ tracker: () => 'open', now: T0 + 3 * BLOCKER_STATE_TTL_MS }), { waited: [], released: [], halted: [], errors: [] });
});

test('a returned lane with no blocker left to wait for is handed to penne instead of being reviewed', async () => {
  const { state } = setup([row('IDD-3', { gh_issue_url: 'https://github.com/o/r/issues/3' })], [
    ev('IDD-3', 'lane_open', 0), ev('IDD-3', 's1_go', 1), ev('IDD-3', 's2_start', 2),
    ev('IDD-3', 's2_result', 3, { outcome: 'failed', changed_files: [], commit_count: 0 }),
  ]);
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-3', executor_session_id: 'e1', worktree_path: join(state, 'wt'), branch: 'idd/IDD-3' }) + '\n');
  const r = await runBlockerWaits({ tracker: () => 'open', now: T0 });
  assert.deepEqual(r.halted, ['IDD-3']);
  const halt = lifecycleOf('IDD-3').at(-1);
  assert.equal(halt.event, 'lane_stall_detected');
  assert.equal(halt.attrs.can_send_back, true);
  assert.match(halt.attrs.reason, /戻す条件で戻った/);
  const stage = deriveStage(lifecycleOf('IDD-3'));
  assert.equal(stage.decision, 'stuck');
  assert.equal(reviewLoopState(lifecycleOf('IDD-3')).state, 'idle');
  // nothing more on a later pass
  assert.deepEqual(await runBlockerWaits({ tracker: () => 'open', now: T0 }), { waited: [], released: [], halted: [], errors: [] });
});

test('an Issue read by number carries its dependencies with their state, and none when gh cannot list them', async () => {
  const { root } = setup([], []);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'gh.log');
  const dep = (repo, number, state) => ({ number, title: `blocker ${number}`, html_url: `https://github.com/${repo}/issues/${number}`, state, repository_url: `https://api.github.com/repos/${repo}` });
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const path = a.find((x) => x.startsWith('repos/')) ?? '';
if (/\\/dependencies\\/blocked_by$/.test(path)) {
  if (path.startsWith('repos/o/r/issues/3/')) { console.log(JSON.stringify(${JSON.stringify([dep('o/r', 9, 'open'), dep('o/r', 7, 'closed'), dep('x/y', 5, 'open')])})); process.exit(0); }
  process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1);
}
const m = /^repos\\/([^/]+\\/[^/]+)\\/issues\\/(\\d+)$/.exec(path);
if (!m) { process.stderr.write('unexpected gh ' + a.join(' ') + '\\n'); process.exit(2); }
console.log(JSON.stringify({ number: Number(m[2]), title: 'T', body: 'B', created_at: '2026-10-18T00:00:00Z', state: 'open', html_url: 'https://github.com/' + m[1] + '/issues/' + m[2], labels: [] }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    const { readIssue } = await import('../src/intake/github.ts');
    const read = readIssue('o/r', 3);
    assert.ok('issue' in read);
    assert.deepEqual(read.issue.blockers.map((b) => [b.number, b.repo, b.state]), [[9, 'o/r', 'open'], [7, 'o/r', 'closed'], [5, 'x/y', 'open']]);
    assert.equal(read.issue.blockersTruncated, false);
    // only GETs: the Issue, then its dependencies
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['api', '--method', 'GET'], ['api', '--method', 'GET']]);
    // a list gh cannot answer leaves the Issue with no dependency, and the Issue is still read
    const other = readIssue('o/r', 4);
    assert.ok('issue' in other);
    assert.deepEqual(other.issue.blockers, []);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('the word to the executor names the blockers and the mainline when the repo names one', () => {
  setup([], []);
  const word = blockerResumeInstruction('Demo', ['#9', '#10']);
  assert.match(word, /#9, #10/);
  assert.match(word, /本流を merge し（rebase 禁止）/);
});

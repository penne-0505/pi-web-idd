import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { answerOutcome, fixScope, reviewLoopState, reviewLoopLabel } from '../src/ledger/review-loop.ts';
import { answerOutcome as answerOutcomeReference, fixScope as fixScopeReference, reviewLoopState as reviewLoopStateReference } from '../src/ledger/review-loop-reference.ts';
import { reviewNextStep } from '../src/ledger/review-loop-next.ts';
import { nextStepReference } from '../src/ledger/review-loop-next-reference.ts';
import { parseRepos } from '../src/config/areas.ts';
import { tmpDir } from './helpers/tmp.mjs';

// The S2 loop of the APP-2251 bench (IDD-290, run 3) went round five times and never ran the repo's required checks:
// they ran only at the submit, 35 minutes after the loop had converged. A fix in the fourth round broke an existing P0
// test, and nobody knew until a person ran the tests by hand. A repo that turns `checks_before_converge` on runs its
// required checks at the lane's head before the loop converges: a check the lane made fail goes back to the executor
// as a must through the fix, and the loop goes on to its next round.

const ID = 'IDD-001';
const ev = (event, attrs = {}) => ({ event, idd_id: ID, at: '2026-11-13T00:00:00+09:00', attrs });
const AREA = 'o/Demo';

/** the launcher the loop asks to run the checks: the tests stand in for the detached run */
async function fakeLauncher(results = {}) {
  const mod = await import('../src/overlay/converge-checks.ts').catch(() => null);
  const launches = [];
  const restarts = [];
  const state = { status: 'running', rows: [], base: 'B0', error: '', busy: false, ...results };
  const basis = state.basis ? { basis: state.basis } : {};
  mod?.setConvergeCheckLauncher({
    start: (input) => {
      if (state.busy) return null;
      launches.push(input);
      return { id: `C${launches.length}`, lane: input.lane, status: 'running', head: input.head };
    },
    status: (lane, id) => ({ id, lane, status: state.status, rows: state.rows, base: state.base, error: state.error, ...basis, ...(state.waitingSince ? { waitingSince: state.waitingSince, holder: 'run X・pid 1' } : {}) }),
    restart: () => { if (state.busy) return false; state.status = 'running'; restarts.push(1); return true; },
  });
  return { launches, restarts, state, reset: () => mod?.setConvergeCheckLauncher(null) };
}

function setup({ on = true } = {}) {
  const state = tmpDir('idd-converge-checks-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), [
    'roles:',
    '  v: { model: x/v, report: review }',
    '  j: { model: x/j, report: triage }',
    'pipeline:',
    '  review_blind: { roles: [v] }',
    '  triage: { role: j }',
  ].join('\n') + '\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const repo = {
    upstream: join(state, 'u'), work: join(state, 'w'),
    checks: [{ name: 'test', command: 'true', required: true, failure_id_pattern: '^FAIL (.+)$' }],
    ...(on ? { checks_before_converge: true } : {}),
  };
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { [AREA]: repo } }));
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = tmpDir('idd-converge-checks-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'a@b']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'a']);
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'init']);
  const base = headOf(wt);
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'work']);
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: ID, parent_id: null, created_at: '2026-11-12T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: AREA }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: ID, executor_session_id: 'E1', worktree_path: wt }) + '\n');
  return { state, wt, base };
}

function headOf(wt) {
  return execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function seed(state, events) {
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function runner() {
  const started = [];
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o.stage); return { runIds: [`${o.stage}-${started.length}`] }; },
    reviewRunStatus: () => ({ state: 'running' }),
  });
  return started;
}

/** a standard-depth pass whose final review found nothing to fix: the loop is about to converge */
function convergingPass(base, head, { depth = true } = {}) {
  return [
    ev('lane_open'), ev('s1_ready', depth ? { depth: 'standard' } : {}), ev('s1_go'), ev('s2_start', { started_from_commit: base }), ev('s2_result', { outcome: 'success' }),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'], head, ...(depth ? { depth: 'standard', max_fix_rounds: 2, close_on: 'must' } : {}) }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b1.json'], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'blind', round: 1, report_md: '/t1.md', accepted: [], rejected: [], escalated_claims: [] }),
    ev('s2_review_started', { kind: 'final', round: 1, run_ids: ['F1'], head }),
    ev('s2_review_findings', { kind: 'final', round: 1, files: ['/f1.json'], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'final', round: 1, report_md: '/tf.md', accepted: [], rejected: [], escalated_claims: [] }),
  ];
}

/** what a run of the checks gives back: the test failed, and the public base did not have the failure */
const newFailure = [{
  name: 'test', status: 'fail', severity: 'blocking', exitCode: 1,
  failureIds: ['test/a_test.dart: login history'],
  detail: '00:12 +3 -1: test/a_test.dart: login history [E]\nSome tests failed.',
  baseline: { commit: 'B0', verdict: 'new', added: ['test/a_test.dart: login history'], shared: 0 },
}];
const preexisting = [{
  name: 'test', status: 'fail', severity: 'blocking', exitCode: 1,
  failureIds: ['test/b_test.dart: flaky'],
  detail: '00:12 +3 -1: test/b_test.dart: flaky [E]\nSome tests failed.',
  baseline: { commit: 'B0', verdict: 'preexisting', shared: 1 },
}];
const notCompared = [{
  name: 'test', status: 'fail', severity: 'blocking', exitCode: null, failureIdsUnread: 'signal',
  detail: 'killed',
  baseline: { verdict: 'unknown', reason: 'head の検査が signal で終わりました（exit なし）' },
}];

test('a repo that runs its checks before the loop converges does not converge before they ran: it starts them at the head', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = convergingPass(base, head);
  assert.equal(reviewLoopState(events).state, 'converge');
  seed(state, events);
  runner();
  const fake = await fakeLauncher();
  try {
    await runReviewLoop();
    const after = readLifecycle().slice(events.length);
    assert.ok(!after.some((e) => e.event === 's2_review_converged'), 'the loop does not converge before the checks ran');
    const started = after.find((e) => e.event === 's2_checks_started');
    assert.ok(started, 'the checks are started');
    assert.equal(started.attrs.head, head, 'at the lane head');
    assert.equal(fake.launches.length, 1);
    assert.equal(fake.launches[0].head, head);
    // the lane reads as checking while the run goes on, on the card and in the list
    const now = readLifecycle();
    assert.equal(reviewLoopState(now).state, 'running_checks');
    assert.equal(reviewLoopStateReference(now).state, 'running_checks');
    assert.equal(reviewLoopLabel(reviewLoopState(now)), '検査中');
    // a tick while the run goes on writes nothing more
    await runReviewLoop();
    assert.equal(readLifecycle().length, now.length);
  } finally { fake.reset(); }
});

test('a check the lane made fail goes back to the executor as a must through the fix, and the loop goes on to the next round', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = [...convergingPass(base, head), ev('s2_checks_started', { run_id: 'C1', head })];
  seed(state, events);
  runner();
  const fake = await fakeLauncher({ status: 'done', rows: newFailure });
  try {
    await runReviewLoop();
    const done = readLifecycle().at(-1);
    assert.equal(done.event, 's2_checks_done');
    assert.equal(done.attrs.outcome, 'new');
    assert.equal(done.attrs.head, head);
    assert.deepEqual(done.attrs.findings.map((f) => [f.ref, f.severity, f.action]), [['checks/test', 'must', 'fix']]);
    assert.match(done.attrs.findings[0].claim, /test/);
    assert.match(done.attrs.findings[0].fix, /login history/, 'the failure and the tail of the output go to the executor');
    const evs = readLifecycle();
    for (const read of [reviewLoopState, reviewLoopStateReference]) assert.deepEqual(read(evs), { state: 'send_fix', round: 1 });
    for (const read of [fixScope, fixScopeReference]) {
      const scope = read(evs);
      assert.equal(scope.source, 'checks');
      assert.deepEqual(scope.accepted.map((a) => a.ref), ['checks/test']);
    }
    await runReviewLoop();
    const fix = readLifecycle().at(-1);
    assert.equal(fix.event, 's2_fix_sent');
    assert.deepEqual(fix.attrs.refs, ['checks/test']);
    assert.equal(fix.attrs.source, 'checks');
    const outbox = readFileSync(join(state, 'outbox.jsonl'), 'utf8');
    assert.match(outbox, /"type":"review_fix"/);
    const envelope = readFileSync(join(state, 'outbox', `${fix.attrs.envelope_id}.xml`), 'utf8');
    assert.match(envelope, /login history/);
    assert.match(envelope, /ref="checks\/test" severity="must"/);
    // the executor's answer starts the next round's review, as any fix does
    const answered = [...readLifecycle(), ev('s2_result', { outcome: 'success' })];
    for (const read of [reviewLoopState, reviewLoopStateReference]) assert.deepEqual(read(answered), { state: 'start_blind', kind: 'blind', round: 2 });
  } finally { fake.reset(); }
});

test('a failure the public base has as well does not hold the loop: it converges at that head', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = [...convergingPass(base, head), ev('s2_checks_started', { run_id: 'C1', head })];
  seed(state, events);
  runner();
  const fake = await fakeLauncher({ status: 'done', rows: preexisting });
  try {
    await runReviewLoop();
    assert.equal(readLifecycle().at(-1).attrs.outcome, 'pass');
    assert.equal(reviewLoopState(readLifecycle()).state, 'converge');
    await runReviewLoop();
    const after = readLifecycle();
    assert.ok(after.some((e) => e.event === 's2_review_converged'), 'the loop converges');
    assert.equal(fake.launches.length, 0, 'the checks are not run again for the same head');
  } finally { fake.reset(); }
});

test('the checks\' record names the base the run compared with: the public base\'s tip when the run checked the submit\'s tree, the lane\'s base otherwise', async () => {
  for (const [basis, said, not] of [['public', /公開 base の先端 B0/, /分岐元/], [undefined, /lane の分岐元/, /公開 base/]]) {
    const { state, wt, base } = setup();
    const head = headOf(wt);
    const rows = [{ ...preexisting[0], baseline: { ...preexisting[0].baseline, commit: 'B0' } }];
    seed(state, [...convergingPass(base, head), ev('s2_checks_started', { run_id: 'C1', head })]);
    runner();
    const fake = await fakeLauncher({ status: 'done', rows, ...(basis ? { basis } : {}) });
    try {
      await runReviewLoop();
      const done = readLifecycle().at(-1);
      assert.equal(done.event, 's2_checks_done');
      assert.match(done.attrs.checks[0].phrase, said, JSON.stringify(done.attrs));
      assert.doesNotMatch(done.attrs.checks[0].phrase, not);
    } finally { fake.reset(); }
  }
});

test('a failure of a run that checked the head merged with the public base\'s tip tells the fix and the stop that the tip may carry commits the lane does not have', async () => {
  const note = /head を公開 base の先端 B01234567 と合わせた tree で落ちた。その先端には lane の作業ツリーに無い commit がありうるので、再現しないときは公開 base の先端（または作業本流）を lane に取り込んで確かめる/;
  for (const [basis, rows, step] of [['public', newFailure, 'fix'], ['public', notCompared, 'stop'], [undefined, newFailure, 'fix'], [undefined, notCompared, 'stop']]) {
    const { state, wt, base } = setup();
    const head = headOf(wt);
    seed(state, [...convergingPass(base, head), ev('s2_checks_started', { run_id: 'C1', head })]);
    runner();
    const fake = await fakeLauncher({ status: 'done', rows, base: 'B01234567890', ...(basis ? { basis } : {}) });
    try {
      await runReviewLoop();
      const done = readLifecycle().at(-1);
      assert.equal(done.event, 's2_checks_done');
      const said = step === 'fix' ? done.attrs.findings[0].fix : reviewLoopState(readLifecycle()).reason;
      if (step === 'stop') assert.equal(reviewLoopStateReference(readLifecycle()).reason, said, 'the two readings say the same stop');
      if (basis) assert.match(said, note, JSON.stringify(done.attrs));
      else assert.doesNotMatch(said, /合わせた tree/, 'a run on the head\'s own tree says nothing of the tip');
    } finally { fake.reset(); }
  }
});

test('a failure that cannot be compared goes to penne; an accept converges without running the checks again, a continue runs them again', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = [...convergingPass(base, head), ev('s2_checks_started', { run_id: 'C1', head })];
  seed(state, events);
  runner();
  const fake = await fakeLauncher({ status: 'done', rows: notCompared });
  try {
    await runReviewLoop();
    assert.equal(readLifecycle().at(-1).attrs.outcome, 'unknown');
    await runReviewLoop();
    const stop = readLifecycle().at(-1);
    assert.equal(stop.event, 's2_review_escalated');
    assert.match(stop.attrs.reason, /検査/);
    const stopped = readLifecycle();
    for (const read of [reviewLoopState, reviewLoopStateReference]) {
      assert.equal(read([...stopped, ev('s2_review_resumed', { decision: 'accept' })]).state, 'converge');
      assert.equal(read([...stopped, ev('s2_review_resumed', { decision: 'continue' })]).state, 'converge');
    }
    const accepted = [...stopped, ev('s2_review_resumed', { decision: 'accept' })];
    const at = { worktree: wt, base, head };
    for (const next of [reviewNextStep, nextStepReference]) {
      assert.equal(next(accepted, { checksOn: true, at }).event, 's2_review_converged', 'an accept settles the head');
      assert.equal(next([...stopped, ev('s2_review_resumed', { decision: 'continue' })], { checksOn: true, at }).stage, 'checks', 'a continue runs them again');
    }
  } finally { fake.reset(); }
});

test('a repo that does not turn the checks on converges as before', async () => {
  const { state, wt, base } = setup({ on: false });
  const events = convergingPass(base, headOf(wt));
  seed(state, events);
  runner();
  const fake = await fakeLauncher();
  try {
    await runReviewLoop();
    assert.ok(readLifecycle().some((e) => e.event === 's2_review_converged'));
    assert.equal(fake.launches.length, 0);
  } finally { fake.reset(); }
});

test('a new failure past the fix cap stops for penne; a continue sends the checks fix, an accept converges', () => {
  const head = 'H';
  const capped = [
    ...convergingPass('b', head).slice(0, 5),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'], head: 'h1', depth: 'standard', max_fix_rounds: 1, close_on: 'must' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: [], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'a', action: 'fix' }], rejected: [], escalated_claims: [] }),
    ev('s2_fix_sent', { round: 1, refs: ['1-blind/F-1'], envelope_id: 'e1', how_refs: [] }),
    ev('s2_result', { outcome: 'success' }),
    ev('s2_review_started', { kind: 'blind', round: 2, run_ids: ['B2'], head }),
    ev('s2_review_findings', { kind: 'blind', round: 2, files: [], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'blind', round: 2, accepted: [], rejected: [], escalated_claims: [] }),
    ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['F2'], head }),
    ev('s2_review_findings', { kind: 'final', round: 2, files: [], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'final', round: 2, accepted: [], rejected: [], escalated_claims: [] }),
    ev('s2_checks_started', { run_id: 'C1', head }),
    ev('s2_checks_done', { run_id: 'C1', head, outcome: 'new', checks: [], findings: [{ ref: 'checks/test', severity: 'must', claim: 'test が落ちた', fix: 'tail', action: 'fix' }] }),
  ];
  for (const read of [reviewLoopState, reviewLoopStateReference]) {
    const s = read(capped);
    assert.equal(s.state, 'escalated');
    assert.match(s.reason, /上限/);
    const stop = ev('s2_review_escalated', { reason: s.reason });
    assert.deepEqual(read([...capped, stop, ev('s2_review_resumed', { decision: 'continue' })]), { state: 'send_fix', round: 2 });
    assert.equal(read([...capped, stop, ev('s2_review_resumed', { decision: 'accept' })]).state, 'converge');
  }
  const continued = [...capped, ev('s2_review_escalated', { reason: 'r' }), ev('s2_review_resumed', { decision: 'continue', note: 'テストを直す' })];
  for (const read of [fixScope, fixScopeReference]) {
    const scope = read(continued);
    assert.equal(scope.source, 'checks');
    assert.deepEqual(scope.accepted.map((a) => a.ref), ['checks/test']);
    assert.equal(scope.note, 'テストを直す');
  }
  // the fix the continue sends is the checks' fix, and the next round's review starts after it even outside a depth
  const sent = [...continued, ev('s2_fix_sent', { round: 2, refs: ['checks/test'], envelope_id: 'e2', how_refs: [], source: 'checks' }), ev('s2_result', { outcome: 'success' })];
  for (const read of [reviewLoopState, reviewLoopStateReference]) assert.deepEqual(read(sent), { state: 'start_blind', kind: 'blind', round: 3 });
});

test('the checks fix outside a depth goes to a whole-diff round, not to a confirm of findings it did not send', () => {
  const events = [
    ...convergingPass('b', 'H', { depth: false }),
    ev('s2_checks_started', { run_id: 'C1', head: 'H' }),
    ev('s2_checks_done', { run_id: 'C1', head: 'H', outcome: 'new', checks: [], findings: [{ ref: 'checks/test', severity: 'must', claim: 'c', fix: 'f', action: 'fix' }] }),
    ev('s2_fix_sent', { round: 1, refs: ['checks/test'], envelope_id: 'e1', how_refs: [], source: 'checks' }),
    ev('s2_result', { outcome: 'success' }),
  ];
  for (const read of [reviewLoopState, reviewLoopStateReference]) assert.deepEqual(read(events), { state: 'start_blind', kind: 'blind', round: 2 });
});

test('the two readings agree on every step of the checks: start, wait, done, failed, busy', () => {
  const head = 'H';
  const at = { worktree: '/w', base: 'b', head };
  const base = convergingPass('b', head);
  const started = [...base, ev('s2_checks_started', { run_id: 'C1', head })];
  const cases = [
    [base, { checksOn: true, at }],
    [base, { checksOn: true, at, runs: [{ state: 'running', runIds: ['C1'] }] }],
    [base, { checksOn: false, at }],
    [started, { runs: [{ state: 'running' }] }],
    [started, { runs: [{ state: 'busy' }] }],
    [started, { runs: [{ state: 'failed', error: 'process gone' }] }],
    [started, { runs: [{ state: 'done' }], checkRows: [{ name: 'test', status: 'fail', verdict: 'new', phrase: 'この lane で新しく落ちた 1 件（x）', tail: 'x [E]', failures: ['x'] }], checkBase: 'B0' }],
    [started, { runs: [{ state: 'done' }], checkRows: [{ name: 'test', status: 'fail', verdict: 'preexisting', phrase: '元から', failures: ['y'] }] }],
    [started, { runs: [{ state: 'done' }], checkRows: [{ name: 'test', status: 'fail', verdict: 'unknown', phrase: '比べられない（signal）' }] }],
    [started, { runs: [{ state: 'done' }], checkRows: [{ name: 'test', status: 'fail', verdict: 'new', phrase: 'この lane で新しく落ちた 1 件（x）', tree_note: 'head を公開 base の先端 B0 と合わせた tree で落ちた', failures: ['x'] }], checkBase: 'B0' }],
    [started, { runs: [{ state: 'done' }], checkRows: [{ name: 'test', status: 'pass', tree_note: 'kept off a passing row' }] }],
    [started, { runs: [{ state: 'done' }], checkRows: [{ name: 'test', status: 'pass' }] }],
    [started, { runs: [{ state: 'done' }], checkRows: [{ name: 'setup', status: 'fail', phrase: '', tail: 'pub get failed' }] }],
  ];
  for (const [events, facts] of cases) {
    assert.deepEqual(reviewNextStep(events, facts), nextStepReference(events, facts), JSON.stringify(facts));
  }
  // a dead run stops for penne and is tried again by a continue
  const failed = [...started, ev('s2_checks_done', { run_id: 'C1', head, failed: true, error: 'process gone' })];
  for (const read of [reviewLoopState, reviewLoopStateReference]) {
    const s = read(failed);
    assert.equal(s.state, 'escalated');
    assert.deepEqual(s.retry, { state: 'converge' });
  }
});

test('the carried convergence: a final skipped for the checks, and a continue with nothing to fix, keep their reasons on the convergence', () => {
  const head = 'H';
  const at = { worktree: '/w', base: 'b', head };
  const base = convergingPass('b', head);
  const carried = { final_skipped: 'settled', head, settled_head: head };
  for (const next of [reviewNextStep, nextStepReference]) {
    const step = next(base, { checksOn: true, at, convergeAttrs: carried, runs: [{ state: 'running', runIds: ['C1'] }] });
    assert.equal(step.event, 's2_checks_started');
    assert.deepEqual(step.attrs.converge, carried);
  }
  const passed = [...base, ev('s2_checks_started', { run_id: 'C1', head, converge: carried }), ev('s2_checks_done', { run_id: 'C1', head, outcome: 'pass', checks: [] })];
  for (const next of [reviewNextStep, nextStepReference]) {
    const step = next(passed, { checksOn: true, at });
    assert.equal(step.event, 's2_review_converged');
    assert.deepEqual(step.attrs, { ...carried, checks_head: head });
  }
});

test('the setting is a boolean, kept beside the areas, and only a repo that writes true has it', () => {
  const repo = { upstream: '/u', work: '/w' };
  const on = parseRepos(JSON.stringify({ repos: { 'o/a': { ...repo, checks_before_converge: true }, 'o/b': repo } }));
  assert.deepEqual(on.convergeChecks, ['o/a']);
  assert.equal('checks_before_converge' in on.areas['o/a'], false, 'the area config keeps its hash');
  assert.deepEqual(on.areas['o/a'], parseRepos(JSON.stringify({ repos: { 'o/a': repo } })).areas['o/a']);
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'o/a': { ...repo, checks_before_converge: 'yes' } } })), /checks_before_converge/);
  assert.equal(parseRepos(JSON.stringify({ repos: { 'o/a': repo } })).convergeChecks, undefined);
});

test('the shipped config turns the checks on for daysai-flutter only', () => {
  const shipped = parseRepos(readFileSync(new URL('../../../config/repos.yaml', import.meta.url), 'utf8'));
  assert.deepEqual(shipped.convergeChecks, ['Dayseum/daysai-flutter']);
  assert.ok(existsSync(new URL('../../../config/repos.yaml', import.meta.url)));
});

test('a run the heavy checks kept out starts again as the same run, writing nothing; while they still hold it, nothing moves', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = [...convergingPass(base, head), ev('s2_checks_started', { run_id: 'C1', head })];
  seed(state, events);
  runner();
  const fake = await fakeLauncher({ status: 'busy', busy: true });
  try {
    const r1 = await runReviewLoop();
    assert.equal(readLifecycle().length, events.length, 'a wait writes nothing');
    assert.equal(fake.restarts.length, 0);
    assert.ok(!r1.advanced.some((a) => a.iddId === ID), 'a wait is no move, so the tick does not go round again for it');
    fake.state.busy = false;
    const r2 = await runReviewLoop();
    assert.equal(fake.restarts.length, 1, 'the run is started again once the heavy checks are free');
    assert.equal(readLifecycle().length, events.length, 'as the same run: nothing new on the ledger');
    assert.ok(r2.advanced.some((a) => a.iddId === ID && a.to === 'checks started'));
  } finally { fake.reset(); }
});

test('a run that waited for the heavy checks past its limit is put to penne with who holds them; an accept converges at that head, a continue waits again', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = [...convergingPass(base, head), ev('s2_checks_started', { run_id: 'C1', head })];
  seed(state, events);
  runner();
  const fake = await fakeLauncher({ status: 'busy', busy: true, waitingSince: new Date(Date.now() - 3 * 3600_000).toISOString() });
  try {
    await runReviewLoop();
    const done = readLifecycle().at(-1);
    assert.equal(done.event, 's2_checks_done');
    assert.equal(done.attrs.failed, true);
    assert.match(done.attrs.error, /重い検査の lock が \d+ 分空かない（待ちの上限 35 分、持ち主: run X・pid 1）/);
    await runReviewLoop();
    assert.equal(readLifecycle().at(-1).event, 's2_review_escalated');
    const stopped = readLifecycle();
    const at = { worktree: wt, base, head };
    for (const read of [reviewLoopState, reviewLoopStateReference]) assert.equal(read([...stopped, ev('s2_review_resumed', { decision: 'accept' })]).state, 'converge');
    for (const next of [reviewNextStep, nextStepReference]) {
      assert.equal(next([...stopped, ev('s2_review_resumed', { decision: 'accept' })], { checksOn: true, at }).event, 's2_review_converged', 'an accept answers for the head');
      assert.equal(next([...stopped, ev('s2_review_resumed', { decision: 'continue' })], { checksOn: true, at }).stage, 'checks', 'a continue starts them again');
    }
  } finally { fake.reset(); }
});

test('a final the loop skips goes through the checks first, and the convergence after them keeps the skip\'s reason', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = convergingPass(base, head).slice(0, 8);
  assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'final', round: 1 });
  seed(state, events);
  const started = runner();
  const fake = await fakeLauncher();
  try {
    await runReviewLoop();
    assert.deepEqual(started, [], 'the final review is skipped (the blind read the same head)');
    const check = readLifecycle().at(-1);
    assert.equal(check.event, 's2_checks_started', 'the skip does not converge before the checks ran');
    assert.ok(check.attrs.converge?.final_skipped, 'the skip\'s convergence is carried');
    assert.equal(check.attrs.converge.head, head);
    fake.state.status = 'done';
    fake.state.rows = [{ name: 'test', status: 'pass', severity: 'blocking' }];
    await runReviewLoop();
    await runReviewLoop();
    const converged = readLifecycle().at(-1);
    assert.equal(converged.event, 's2_review_converged');
    assert.equal(converged.attrs.final_skipped, check.attrs.converge.final_skipped);
    assert.equal(converged.attrs.checks_head, head);
  } finally { fake.reset(); }
});

test('the stuck card says where an answer to a stop over the checks takes the lane, as the loop then goes', () => {
  const env = { skipsFinal: () => false, deviceOn: false };
  const head = 'H';
  const base = [...convergingPass('b', head), ev('s2_checks_started', { run_id: 'C1', head })];
  const unknown = [...base, ev('s2_checks_done', { run_id: 'C1', head, outcome: 'unknown', checks: [{ name: 'test', status: 'fail', verdict: 'unknown', phrase: 'p' }] }), ev('s2_review_escalated', { reason: 'r' })];
  const failed = [...base, ev('s2_checks_done', { run_id: 'C1', head, failed: true, error: 'gone' }), ev('s2_review_escalated', { reason: 'r', retry_state: { state: 'converge' } })];
  for (const outcome of [answerOutcome, answerOutcomeReference]) {
    assert.deepEqual(outcome(unknown, { decision: 'continue' }, env), { to: 'checks' });
    assert.equal(outcome(unknown, { decision: 'accept' }, env)?.to, 'close');
    assert.deepEqual(outcome(failed, { decision: 'continue' }, env), { to: 'checks' });
    assert.equal(outcome(failed, { decision: 'accept' }, env)?.to, 'close');
  }
  const capped = [
    ...convergingPass('b', head).slice(0, 5),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'], head: 'h1', depth: 'standard', max_fix_rounds: 1, close_on: 'must' }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'a', action: 'fix' }], rejected: [], escalated_claims: [] }),
    ev('s2_fix_sent', { round: 1, refs: ['1-blind/F-1'] }), ev('s2_result'),
    ev('s2_checks_started', { run_id: 'C1', head }),
    ev('s2_checks_done', { run_id: 'C1', head, outcome: 'new', checks: [], findings: [{ ref: 'checks/test', severity: 'must', claim: 'c', action: 'fix' }] }),
  ];
  for (const outcome of [answerOutcome, answerOutcomeReference]) {
    const go = outcome(capped, { decision: 'continue' }, env);
    assert.equal(go?.to, 'fix');
    assert.deepEqual(go.refs, ['checks/test']);
  }
});

test('the checks a round the mainline\'s merge skipped held back come back to that round; an accept there does too, and keeps what they carried', () => {
  const head = 'H';
  const resume = { state: 'start_blind', kind: 'blind', round: 2 };
  const carried = { final_skipped: 'settled', head };
  const base = [...convergingPass('b', head), ev('s2_checks_started', { run_id: 'C1', head, resume_state: resume, converge: carried })];
  const passed = [...base, ev('s2_checks_done', { run_id: 'C1', head, outcome: 'pass', checks: [] })];
  const unknown = [...base, ev('s2_checks_done', { run_id: 'C1', head, outcome: 'unknown', checks: [] }), ev('s2_review_escalated', { reason: 'r' })];
  for (const read of [reviewLoopState, reviewLoopStateReference]) {
    assert.deepEqual(read(passed), resume);
    assert.deepEqual(read([...unknown, ev('s2_review_resumed', { decision: 'accept' })]), resume);
    assert.deepEqual(read([...unknown, ev('s2_review_resumed', { decision: 'continue' })]), resume);
  }
  // the start carries the state it holds back
  const at = { worktree: '/w', base: 'b', head };
  for (const next of [reviewNextStep, nextStepReference]) {
    const step = next(convergingPass('b', head), { checksOn: true, at, resumeState: resume, runs: [{ state: 'running', runIds: ['C2'] }] });
    assert.deepEqual(step.attrs.resume_state, resume);
  }
  // an accept on a stop over the checks writes the convergence they held back
  const plain = [...convergingPass('b', head), ev('s2_checks_started', { run_id: 'C1', head, converge: carried }), ev('s2_checks_done', { run_id: 'C1', head, outcome: 'unknown', checks: [] }), ev('s2_review_escalated', { reason: 'r' }), ev('s2_review_resumed', { decision: 'accept' })];
  for (const next of [reviewNextStep, nextStepReference]) {
    const step = next(plain, { checksOn: true, at });
    assert.equal(step.event, 's2_review_converged');
    assert.deepEqual(step.attrs, { ...carried, checks_accepted: head });
  }
});

test('a config that cannot be read does not let the loop converge without the checks: the step fails and is counted toward a stop', async () => {
  const { state, wt, base } = setup();
  const events = convergingPass(base, headOf(wt));
  seed(state, events);
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { Demo: { upstream: '/u', work: '/w' } } }));
  runner();
  const fake = await fakeLauncher();
  try {
    const r = await runReviewLoop();
    const after = readLifecycle().slice(events.length);
    assert.ok(!after.some((e) => e.event === 's2_review_converged'), 'no convergence without the checks');
    assert.equal(after.at(-1)?.event, 's2_review_run_failed');
    assert.match(String(after.at(-1).attrs.error), /owner\/name/);
    assert.ok(r.errors.some((e) => e.iddId === ID));
  } finally { fake.reset(); }
});

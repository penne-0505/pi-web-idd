import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchDir } from './helpers/scratch.mjs';

Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_ALLOW_PROTOCOL: 'file',
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); }
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

/** a state of its own: nothing under the repo's state is read or written */
function freshState(prefix = 'metrics-') {
  const root = scratchDir(prefix);
  const state = join(root, 'state');
  mkdirSync(state);
  const repos = join(root, 'repos.yaml');
  const roles = join(root, 'roles.yaml');
  put(repos, JSON.stringify({ repos: {} }));
  put(roles, 'pipeline:\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos, IDD_ROLES_FILE: roles, IDD_INTENT_DIR: join(root, 'intent') });
  return { root, state, repos, roles };
}

/**
 * A repo with a mainline commit, a lane commit and the merge commit a landing would make. `warnings.txt` is what the
 * increment command counts, so the mainline's and the lane's numbers are what the check compares.
 */
function repoFixture({ mainWarnings = 141, laneWarnings = 142, mainHasFile = true } = {}) {
  const { root, state, repos } = freshState('increment-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--initial-branch=main');
  if (mainHasFile) put(join(repo, 'warnings.txt'), String(mainWarnings));
  put(join(repo, 'app.txt'), 'one\n');
  commit(repo, 'chore: main');
  const mainTip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'idd/IDD-1');
  put(join(repo, 'warnings.txt'), String(laneWarnings));
  put(join(repo, 'app.txt'), 'two\n');
  commit(repo, 'feat: lane');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', 'main');
  git(repo, 'merge', '--no-ff', 'idd/IDD-1', '-m', 'Merge lane');
  const mergeCommit = git(repo, 'rev-parse', 'HEAD');
  put(repos, JSON.stringify({
    repos: {
      'demo/demo': {
        name: 'demo', upstream: join(root, 'upstream'), work: repo, public_base: 'main', work_base: 'main',
        remote: 'origin', copy: [], setup: [], checks: [],
      },
    },
  }));
  put(join(state, 'backlog.jsonl'), jsonl([{ idd_id: 'IDD-1', parent_id: null, created_at: '2026-10-13T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/1', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 1', area: 'demo/demo' }]));
  return { root, state, repos, repo, mainTip, head, mergeCommit };
}

/** the increment rows of one landing, measured in a copy of the merge commit the checks would read */
async function measure(f, increments, prep = { copy: [], setup: [], timeouts: {} }) {
  const { cutCopy } = await import('../src/overlay/gate.ts');
  const { dropCopy } = await import('../src/worktree/copies.ts');
  const { incrementChecks } = await import('../src/overlay/increment.ts');
  const copy = cutCopy(f.repo, f.mergeCommit, { area: 'demo/demo' });
  try {
    return await incrementChecks({
      repo: f.repo, area: 'demo/demo', mainTip: f.mainTip, mergedCopy: copy, increments, changed: [],
      prep,
    });
  } finally { dropCopy(copy, f.repo); }
}

/** a command that prints the number in warnings.txt (and may still exit non-zero, as eslint -f json does) */
function countCommand(exitCode = 0) {
  return [process.execPath, '-e', `const n = require('node:fs').readFileSync('warnings.txt', 'utf8').trim(); console.log(n); if (${exitCode}) process.exit(${exitCode});`];
}

const declarer = (over = {}) => ({ name: 'eslint-warnings', command: countCommand(), count: 'number', required: true, timeoutMinutes: 2, ...over });

const VALIDATE_SURVEY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'validate-survey.ts');
const hasDeno = spawnSync('deno', ['--version']).status === 0 && existsSync(VALIDATE_SURVEY);

/**
 * One lane with two landing rounds at one head: the test named `testName` failed and then passed, and the merge
 * commit carried fewer eslint warnings than the mainline.
 */
async function renderFixture({ testName = 'flaky one' } = {}) {
  const { state } = freshState('metrics-render-');
  const ev = (idd_id, event, at, attrs = {}) => ({ idd_id, event, at, attrs });
  put(join(state, 'backlog.jsonl'), jsonl([
    { idd_id: 'IDD-1', parent_id: null, created_at: '2026-10-13T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/1', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 1', area: 'demo/demo' },
  ]));
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl([
    ev('IDD-1', 'lane_open', '2026-10-13T00:00:00Z', { source_type: 'github', area: 'demo/demo' }),
    ev('IDD-1', 's1_ready', '2026-10-13T00:10:00Z'),
    ev('IDD-1', 's1_go', '2026-10-13T00:20:00Z'),
    ev('IDD-1', 'lane_close', '2026-10-13T01:10:00Z', { outcome: 'local' }),
  ]));
  const round = (id, at, checks) => ({
    id, lane: 'IDD-1', status: 'done', started_at: at, ended_at: at, wall_seconds: 120, cpu_seconds: 50,
    cpu_source: 'cgroup', head: 'head1', mainTip: 'tip1', mergeCommit: `merge-${id}`, signed: false,
    diff_lines: 100, checks, blocking: 0,
  });
  const rounds = [
    round('r1', '2026-10-13T02:00:00Z', [
      { name: 'test', status: 'fail', severity: 'blocking', detail: `[test-entry] 組 test が落ちました: 落ちたテスト 1 件\n  - ${testName}` },
    ]),
    round('r2', '2026-10-13T03:00:00Z', [
      { name: 'test', status: 'pass', severity: 'blocking' },
      { name: 'eslint-warnings', status: 'pass', severity: 'blocking', counts: { mainline: 141, merged: 138 } },
    ]),
  ];
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { readBacklog, readLifecycle } = await import('../src/ledger/read.ts');
  const view = await buildMetrics({
    since: '2026-10-12', until: '2026-10-18', rounds, consumption: [],
    lifecycle: readLifecycle(), backlog: readBacklog(),
    laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }),
  });
  const { formatMetricsTable, renderMetricsSurvey } = await import('../src/metrics/format.ts');
  return { view, terminal: formatMetricsTable(view).join('\n'), survey: renderMetricsSurvey(view) };
}

test('AC-001: a merge that adds a warning is stopped, and both counts are on the row', async () => {
  const f = repoFixture({ mainWarnings: 141, laneWarnings: 142 });
  const rows = await measure(f, [declarer()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].severity, 'blocking');
  assert.deepEqual(rows[0].counts, { mainline: 141, merged: 142, at: f.mainTip }, 'the numbers name the tip they were measured at');
  assert.match(rows[0].detail, /141/);
  assert.match(rows[0].detail, /142/);
});

test('AC-001: a merge with the same or fewer warnings passes, and a non-zero exit does not change the number', async () => {
  const sameFixture = repoFixture({ mainWarnings: 141, laneWarnings: 141 });
  const same = await measure(sameFixture, [declarer()]);
  assert.equal(same[0].status, 'pass');
  assert.deepEqual(same[0].counts, { mainline: 141, merged: 141, at: sameFixture.mainTip });
  const fewerFixture = repoFixture({ mainWarnings: 141, laneWarnings: 140 });
  const fewer = await measure(fewerFixture, [declarer()]);
  assert.equal(fewer[0].status, 'pass');
  assert.deepEqual(fewer[0].counts, { mainline: 141, merged: 140, at: fewerFixture.mainTip });
  // eslint -f json exits 1 when it found an error; the increment still reads the warnings it printed
  const exitsOneFixture = repoFixture({ mainWarnings: 141, laneWarnings: 141 });
  const exitsOne = await measure(exitsOneFixture, [declarer({ command: countCommand(1) })]);
  assert.equal(exitsOne[0].status, 'pass');
  assert.deepEqual(exitsOne[0].counts, { mainline: 141, merged: 141, at: exitsOneFixture.mainTip });
});

test('AC-001: a mainline count that cannot be measured stops the landing too', async () => {
  const f = repoFixture({ mainWarnings: 141, laneWarnings: 141, mainHasFile: false });
  const rows = await measure(f, [declarer()]);
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].severity, 'blocking');
  assert.equal(rows[0].counts, undefined);
  assert.match(rows[0].detail, /本流/);
});

test('AC-001: a non-required increment is reported without stopping the landing', async () => {
  const rows = await measure(repoFixture({ mainWarnings: 141, laneWarnings: 150 }), [declarer({ required: false })]);
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].severity, 'non-blocking');
});

test('AC-001: a value read out of no copy file is not kept in the increment failure', async () => {
  const f = repoFixture({ mainWarnings: 141, laneWarnings: 142 });
  // the copy is a JSON file: its values cannot be told apart, so nothing of the command's output may be kept
  put(join(f.repo, '.git', 'info', 'exclude'), 'secret.json\n');
  put(join(f.repo, 'secret.json'), '{"token":"s3cr3t-value-of-the-copy-file"}\n');
  const rows = await measure(
    f,
    [{ name: 'secret-count', command: ['bash', '-c', 'echo s3cr3t-value-of-the-copy-file'], count: 'number', required: true, timeoutMinutes: 2 }],
    { copy: ['secret.json'], setup: [], timeouts: {} },
  );
  assert.equal(rows[0].status, 'fail');
  assert.doesNotMatch(rows[0].detail, /s3cr3t-value-of-the-copy-file/, 'the output is not kept when a copy file is unreadable');
  assert.match(rows[0].detail, /出力を省きました/);
  assert.match(rows[0].detail, /secret\.json/);
});

test('AC-002: every landing round is kept after the next one, and a stopped round is not a checked one', async () => {
  const f = repoFixture({});
  const { runLandCheck } = await import('../src/overlay/land-check.ts');
  const { readLandRounds, saveLandRun, stopLandRun, readLandRun, closeDeadLandRun } = await import('../src/overlay/land-run.ts');
  const startRound = (id, lane, checks) => {
    const dir = join(f.state, 'overlay', 'land-run');
    mkdirSync(dir, { recursive: true });
    const specPath = join(dir, `${id}.spec.json`);
    const spec = {
      runId: id, lane, repo: f.repo, area: 'demo/demo', checks, changed: [], head: f.head, mainTip: f.mainTip,
      mergeCommit: f.mergeCommit, branch: 'idd/IDD-1', workBase: 'main', configKey: 'cfg', token: 'token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    put(specPath, JSON.stringify(spec));
    saveLandRun({
      id, lane, status: 'running', started_at: new Date().toISOString(), repo: f.repo, common: resolve(f.repo, '.git'),
      head: f.head, mainTip: f.mainTip, mergeCommit: f.mergeCommit, signed: false, spec, log: join(dir, `${id}.log`),
    });
    return specPath;
  };
  const noop = [{ name: 'noop', command: ['bash', '-c', 'true'], required: true }];
  const boom = [{ name: 'boom', command: ['bash', '-c', 'echo boom; exit 1'], required: false }];

  assert.equal(await runLandCheck(startRound('round1', 'IDD-1', noop)), 0);
  const first = readLandRounds('IDD-1');
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'done');
  assert.deepEqual(first[0].checks.map((c) => [c.name, c.status]), [['noop', 'pass']]);
  assert.ok(first[0].wall_seconds >= 0);
  assert.equal(typeof first[0].diff_lines, 'number', 'the lines the merge changed are recorded');
  const kept = JSON.stringify(first[0]);

  assert.equal(await runLandCheck(startRound('round2', 'IDD-1', boom)), 0);
  const both = readLandRounds('IDD-1');
  assert.equal(both.length, 2, 'the second round does not replace the first');
  assert.equal(JSON.stringify(both[0]), kept, 'the earlier round is not rewritten');
  assert.deepEqual(both[1].checks.map((c) => [c.name, c.status]), [['boom', 'fail']]);

  // stopped from outside: no checks and no result, so it is never counted as a checked round
  startRound('round3', 'IDD-2', noop);
  stopLandRun(readLandRun('IDD-2'), '署名済みの検査のために止めました');
  const stopped = readLandRounds('IDD-2');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].status, 'stopped');
  assert.deepEqual(stopped[0].checks, []);
  assert.equal(stopped[0].blocking, 0);

  // a run whose process went away keeps its round as a failure, not as a check that ran
  startRound('round4', 'IDD-3', noop);
  closeDeadLandRun(readLandRun('IDD-3'), { alive: () => false, now: Date.now() + 60_000 });
  const dead = readLandRounds('IDD-3');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].status, 'failed');
  assert.deepEqual(dead[0].checks, []);
});

test('AC-003: lane_open keeps the pipeline it opened under, and an older lane is not rewritten', async () => {
  const { roles, repos, state } = freshState('lane-open-');
  put(roles, [
    'pipeline:',
    '  planner: { role: planner, concurrency: 3, api_key: do-not-copy }',
    '  executor: { role: executor, concurrency: 4 }',
    'roles:',
    '  planner: { model: model-a }',
    '  executor: { model: model-b }',
    '',
  ].join('\n'));
  put(repos, JSON.stringify({
    repos: {
      'demo/demo': {
        name: 'demo', upstream: '/tmp/fixture-up', work: '/tmp/fixture-work', public_base: 'main', work_base: 'main',
        remote: 'origin', copy: [], setup: [], checks: [],
        issue_lane: { context: 'personal', source_type_priority: 'github' },
      },
    },
  }));
  const { openLaneForIssue } = await import('../src/intake/run.ts');
  const { readLifecycle } = await import('../src/ledger/read.ts');
  const issue = (n) => ({ source: 'github', ref: `#${n}`, title: `題名 ${n}`, url: `https://github.com/demo/demo/issues/${n}`, body: '本文', area: 'demo/demo', repo: 'demo', primary: true, number: n });

  const made = await openLaneForIssue(issue(1));
  assert.ok(made.added, JSON.stringify(made));
  const opened = () => readLifecycle().find((e) => e.idd_id === made.added && e.event === 'lane_open');
  const first = opened();
  assert.equal(first.attrs.pipeline.pipeline.planner.concurrency, 3);
  assert.equal(first.attrs.pipeline.pipeline.executor.concurrency, 4);
  assert.deepEqual(first.attrs.pipeline.models.planner, ['model-a']);
  assert.deepEqual(first.attrs.pipeline.models.executor, ['model-b']);
  assert.match(first.attrs.pipeline.key, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(first.attrs.pipeline).includes('do-not-copy'), false, 'a field naming a secret is not copied');
  const before = JSON.stringify(first.attrs);

  // the settings change; the lane that is already open keeps the copy it was opened with
  put(roles, 'pipeline:\n  planner: { role: planner, concurrency: 5 }\nroles:\n  planner: { model: model-c }\n');
  const second = await openLaneForIssue(issue(2));
  assert.ok(second.added, JSON.stringify(second));
  assert.equal(JSON.stringify(opened().attrs), before, 'an open lane is never rewritten');
  const next = readLifecycle().find((e) => e.idd_id === second.added && e.event === 'lane_open');
  assert.equal(next.attrs.pipeline.pipeline.planner.concurrency, 5);
  assert.deepEqual(next.attrs.pipeline.models.planner, ['model-c']);
  assert.notEqual(next.attrs.pipeline.key, first.attrs.pipeline.key);
  assert.ok(state);
});

test('AC-004: the period’s numbers come from the ledger, the rounds and the budget’s reader, grouped by settings', async () => {
  const { state, repos } = freshState('metrics-view-');
  // a git repo for the direct-commit count: one plain commit, one merged lane branch
  const repo = join(state, '..', 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--initial-branch=main');
  put(join(repo, 'a.txt'), 'one\n');
  commit(repo, 'chore: one');
  git(repo, 'checkout', '-b', 'idd/IDD-9');
  put(join(repo, 'b.txt'), 'two\n');
  commit(repo, 'feat: two');
  git(repo, 'checkout', 'main');
  put(join(repo, 'c.txt'), 'three\n');
  commit(repo, 'chore: three');
  git(repo, 'merge', '--no-ff', 'idd/IDD-9', '-m', 'Merge lane 9');
  put(repos, JSON.stringify({
    repos: {
      'demo/demo': { name: 'demo', upstream: '/tmp/up', work: repo, public_base: 'main', work_base: 'main', remote: 'origin', copy: [], setup: [], checks: [] },
    },
  }));
  const copyA = { pipeline: { planner: { role: 'planner', concurrency: 3 } }, models: { planner: ['model-a'] }, key: 'aaaaaaaaaaaaaaaa' };
  const copyB = { pipeline: { planner: { role: 'planner', concurrency: 7 } }, models: { planner: ['model-b'] }, key: 'bbbbbbbbbbbbbbbb' };
  const ev = (id, event, at, attrs = {}) => ({ idd_id: id, event, at, attrs });
  put(join(state, 'backlog.jsonl'), jsonl([
    { idd_id: 'IDD-1', parent_id: null, created_at: '2026-10-13T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/1', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 1', area: 'demo/demo' },
    { idd_id: 'IDD-2', parent_id: null, created_at: '2026-10-14T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/2', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 2', area: 'demo/demo' },
    // opened before the period: not in the table
    { idd_id: 'IDD-3', parent_id: null, created_at: '2026-09-01T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/3', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 3', area: 'demo/demo' },
    { idd_id: 'IDD-4', parent_id: null, created_at: '2026-10-15T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/4', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 4', area: 'demo/demo' },
  ]));
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl([
    ev('IDD-1', 'lane_open', '2026-10-13T00:00:00Z', { source_type: 'github', area: 'demo/demo', pipeline: copyA }),
    ev('IDD-1', 's1_ready', '2026-10-13T00:10:00Z'),
    ev('IDD-1', 's1_go', '2026-10-13T00:20:00Z'),
    ev('IDD-1', 's2_start', '2026-10-13T00:25:00Z'),
    ev('IDD-1', 's1_granularity_proposed', '2026-10-13T00:30:00Z'),
    ev('IDD-1', 's1_granularity_answered', '2026-10-13T00:35:00Z', { outcome: 'split' }),
    ev('IDD-1', 's2_fix_sent', '2026-10-13T00:40:00Z'),
    ev('IDD-1', 's2_review_escalated', '2026-10-13T00:45:00Z'),
    ev('IDD-1', 's4_verify_user_judgment_answered', '2026-10-13T00:50:00Z', { outcome: 'revise' }),
    ev('IDD-1', 's4_land_approved', '2026-10-13T01:00:00Z', { head: 'head1', signed: true }),
    ev('IDD-1', 'lane_close', '2026-10-13T01:10:00Z', { outcome: 'local' }),
    ev('IDD-2', 'lane_open', '2026-10-14T00:00:00Z', { source_type: 'github', area: 'demo/demo', pipeline: copyB }),
    ev('IDD-2', 'question_batch_asked', '2026-10-14T00:05:00Z', { questions: [{ question_id: 'q1' }] }),
    ev('IDD-2', 'question_batch_answered', '2026-10-14T00:35:00Z'),
    ev('IDD-2', 's1_ready', '2026-10-14T00:40:00Z'),
    // opened before the copy existed: the "no record" group
    ev('IDD-4', 'lane_open', '2026-10-15T00:00:00Z', { source_type: 'github', area: 'demo/demo' }),
    ev('IDD-4', 's1_ready', '2026-10-15T00:05:00Z'),
  ]));
  const round = (id, lane, head, status, checks, extra = {}) => ({
    id, lane, status, started_at: '2026-10-13T02:00:00Z', ended_at: '2026-10-13T02:04:00Z', wall_seconds: 240,
    cpu_seconds: 100, cpu_source: 'cgroup', head, mainTip: 'tip1', mergeCommit: `merge-${id}`, signed: false,
    repo, diff_lines: 100, checks, blocking: 0, ...extra,
  });
  const rounds = [
    round('r1', 'IDD-1', 'head1', 'done', [
      { name: 'typecheck', status: 'pass', severity: 'blocking' },
      { name: 'test', status: 'fail', severity: 'blocking', detail: '[test-entry] 組 test が落ちました: 落ちたテスト 1 件\n  - flaky one' },
    ]),
    round('r2', 'IDD-1', 'head1', 'done', [
      { name: 'typecheck', status: 'pass', severity: 'blocking' },
      { name: 'test', status: 'pass', severity: 'blocking' },
      { name: 'eslint-warnings', status: 'pass', severity: 'blocking', counts: { mainline: 141, merged: 141 } },
    ]),
    round('r3', 'IDD-1', 'head2', 'stopped', []),
    round('r4', 'IDD-2', 'head3', 'done', [
      { name: 'typecheck', status: 'fail', severity: 'blocking', detail: 'error TS1: boom' },
    ]),
  ];
  const consumption = [
    { at: '2026-10-13T00:30:00Z', unit: 'reply', lane: 'chat', idd_id: 'IDD-1', role: 'planner', model: 'openrouter/x/m', input: 100, output: 20, cache_read: 5, cache_write: 0, cost: 0.25 },
    { at: '2026-10-13T00:35:00Z', unit: 'reply', lane: 'chat-2', idd_id: 'IDD-1', role: 'planner', model: 'opencode-go/x/m', input: 50, output: 10, cache_read: 0, cache_write: 0, cost: 0.1 },
    { at: '2026-10-13T00:40:00Z', unit: 'attempt', lane: 'run-x', idd_id: 'IDD-1', role: 'executor', model: 'opencode-go/x/m', input: 200, output: 40, cache_read: 0, cache_write: 10, cost: 0.5 },
  ];
  const costs = { 'IDD-1': { total: 1.5, parts: [{ label: 'planner', cost: 1.0 }, { label: 'executor', cost: 0.5 }], subscription: [{ label: '修正 1', cost: 2 }] }, 'IDD-2': { total: 0.5, parts: [], subscription: [] }, 'IDD-4': { total: 0.25, parts: [], subscription: [] } };
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const view = await buildMetrics({
    since: '2026-10-12', until: '2026-10-18', rounds, consumption,
    lifecycle: [...(await import('../src/ledger/read.ts')).readLifecycle()],
    backlog: (await import('../src/ledger/read.ts')).readBacklog(),
    laneCostOf: async (iddId) => costs[iddId] ?? { total: 0, parts: [], subscription: [] },
  });

  assert.deepEqual(view.lanes.map((l) => l.iddId), ['IDD-1', 'IDD-2', 'IDD-4'], 'only the lanes opened in the period');
  const lane1 = view.lanes[0];
  // the cost is exactly what the budget's reader answered, split into budget and subscription
  assert.equal(lane1.cost.budget, 1.5);
  assert.equal(lane1.cost.subscription, 2);
  assert.equal(lane1.landed_lines, 100, 'the same merge is counted once, and the stopped round landed nothing');
  assert.equal(lane1.cost.per_1000_lines, 15);
  // role 別の USD と token
  // role と model の組ごとに数える: 同じ role が 2 つの model で走っても 1 行に畳まれない
  assert.deepEqual(lane1.cost.roles.map((r) => [r.role, r.model, r.usd, r.tokens.input]).sort(), [['executor', 'opencode-go/x/m', 0.5, 200], ['planner', 'opencode-go/x/m', 0.1, 50], ['planner', 'openrouter/x/m', 0.25, 100]]);
  // 段・関所・待ちに分かれた時間（1 つの区間は 1 つにだけ入る）
  const total = lane1.time.stage + lane1.time.gate + lane1.time.wait;
  assert.equal(Math.round(total * 100) / 100, 70, 'the whole record is covered by the three kinds');
  assert.ok(lane1.time.stage > 0, 'the machine stages are that kind');
  // a question a person answers is the gate's kind, in a lane of its own
  assert.ok(view.lanes[1].time.gate > 0, 'an answered question is a gate');
  assert.ok(view.lanes[1].gates.question > 0);
  // 取り込みの検査の回と、その時間と数
  assert.equal(lane1.checks.rounds, 2, 'a stopped round is not a checked round');
  assert.equal(lane1.checks.typecheck_failures, 0);
  assert.equal(lane1.checks.wall_seconds, 480);
  assert.equal(lane1.checks.cpu_seconds, 200);
  assert.equal(lane1.checks.eslint_warnings, 141);
  assert.equal(lane1.checks.eslint_delta, 0);
  assert.equal(view.lanes[1].checks.typecheck_failures, 1);
  // 粒度の量と差し戻し
  assert.deepEqual(lane1.granularity, { proposed: 1, split: 1, fix_sent: 1, escalated: 1, signed: 1 });
  assert.equal(lane1.sent_back, 1);
  // 同じ head で落ちて後の回で通った検査が揺れとして数えられる（起票の候補までで、起票はしない）
  assert.deepEqual(view.flaky.map((f) => [f.lane, f.check, f.test, f.count]), [['IDD-1', 'test', 'flaky one', 1]]);
  // 設定の群: 2 つの写しと、写しの無い「記録なし」
  assert.deepEqual(view.groups.map((g) => [g.settings_key, g.lanes.length]).sort(), [['aaaaaaaaaaaaaaaa', 1], ['bbbbbbbbbbbbbbbb', 1], ['none', 1]]);
  assert.equal(view.groups.find((g) => g.settings_key === 'none').settings, undefined);
  assert.deepEqual(view.groups.find((g) => g.settings_key === 'bbbbbbbbbbbbbbbb').settings.pipeline.planner.concurrency, 7);
  // 本流への直接 commit（merge は数えない）
  assert.deepEqual(view.direct_commits.map((d) => [d.area, d.commits]), [['demo/demo', 2]]);
  assert.equal(view.totals.lanes, 3);
  assert.equal(view.totals.cost.budget, 2.25);
});

test('AC-004: a merge checked twice lands its lines once, and a move of the mainline is another merge', async () => {
  const { state } = freshState('metrics-lines-');
  put(join(state, 'backlog.jsonl'), jsonl([
    { idd_id: 'IDD-1', parent_id: null, created_at: '2026-10-13T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/1', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 1', area: 'demo/demo' },
  ]));
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl([
    { idd_id: 'IDD-1', event: 'lane_open', at: '2026-10-13T00:00:00Z', attrs: { source_type: 'github', area: 'demo/demo' } },
  ]));
  const round = (id, at, head, mainTip, diff_lines) => ({
    id, lane: 'IDD-1', status: 'done', started_at: at, ended_at: at, wall_seconds: 60, head, mainTip,
    mergeCommit: `merge-${id}`, signed: false, diff_lines, checks: [{ name: 'typecheck', status: 'pass', severity: 'blocking' }], blocking: 0,
  });
  const rounds = [
    round('r1', '2026-10-13T02:00:00Z', 'head1', 'tip1', 100),
    // the same merge, run again: not another 100 lines
    round('r2', '2026-10-13T03:00:00Z', 'head1', 'tip1', 100),
    // the mainline moved, so the landing makes another merge commit with its own lines
    round('r3', '2026-10-13T04:00:00Z', 'head1', 'tip2', 60),
    round('r4', '2026-10-13T05:00:00Z', 'head2', 'tip1', 40),
    // stopped from outside: it landed nothing
    round('r5', '2026-10-13T06:00:00Z', 'head1', 'tip2', 60),
  ];
  rounds[4].status = 'stopped';
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { readBacklog, readLifecycle } = await import('../src/ledger/read.ts');
  const view = await buildMetrics({
    since: '2026-10-12', until: '2026-10-18', rounds, consumption: [],
    lifecycle: readLifecycle(), backlog: readBacklog(),
    laneCostOf: async () => ({ total: 2, parts: [], subscription: [] }),
  });
  const lane = view.lanes[0];
  assert.equal(lane.landed_lines, 200, 'the same merge once, the re-measured merge and the second head once each');
  assert.equal(lane.checks.rounds, 4, 'a stopped round is not a checked round');
  assert.equal(lane.cost.per_1000_lines, 10, 'the cost is per line landed, not per round run');
  assert.equal(view.totals.landed_lines, 200);
});

test('AC-006: the weekly survey has the four sections and the front matter the docs check wants', async () => {
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { renderMetricsSurvey, surveyPath } = await import('../src/metrics/format.ts');
  const view = await buildMetrics({
    since: '2026-10-12', until: '2026-10-18', rounds: [], consumption: [],
    lifecycle: (await import('../src/ledger/read.ts')).readLifecycle(),
    backlog: (await import('../src/ledger/read.ts')).readBacklog(),
    laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }),
  });
  const doc = renderMetricsSurvey(view);
  const path = surveyPath('2026-10-18');
  assert.equal(path, '_docs/survey/metrics/2026-42/survey.md');
  const order = ['## 問い', '## 条件', '## 結果', '## 確かめていないこと'].map((h) => doc.indexOf(h));
  assert.ok(order.every((i) => i > 0), 'every section is there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the sections are in order');
  for (const key of ['title:', 'status: active', 'created_at:', 'updated_at:', 'references: []', 'related_issues: []', 'related_prs: []']) {
    assert.ok(doc.includes(key), `the front matter carries ${key}`);
  }
  assert.match(doc, /Canonical path: _docs\/survey\/metrics\/2026-42\/survey\.md/);
  // the survey must not name the intent ledger's ids (the docs check reads them out)
  assert.doesNotMatch(doc, /\b(?:DEC|INV|AC)-\d/);
});

test('AC-004: a lane that removed warnings reads as a fall in the terminal table and in the survey', async () => {
  const { view, terminal, survey } = await renderFixture();
  assert.equal(view.lanes[0].checks.eslint_warnings, 138);
  assert.equal(view.lanes[0].checks.eslint_delta, -3);
  assert.match(terminal, /警告 138（-3）/);
  assert.match(survey, /\| 138（-3） \|/, 'the survey’s lane row carries the same signed change');
  assert.doesNotMatch(terminal, /\+-\d/, 'a fall is not written with two signs');
  assert.doesNotMatch(survey, /\+-\d/);
});

test('AC-004: a count taken over names the earlier tip and is not read as the newest round', async () => {
  const { state } = freshState('metrics-inherit-');
  put(join(state, 'backlog.jsonl'), jsonl([{ idd_id: 'IDD-1', parent_id: null, created_at: '2026-10-13T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/1', linear_issue_url: null, source_type: 'github', context: '', title: 'lane 1', area: 'demo/demo' }]));
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl([
    { idd_id: 'IDD-1', event: 'lane_open', at: '2026-10-13T00:00:00Z', attrs: { source_type: 'github', area: 'demo/demo' } },
  ]));
  const base = { id: 'r1', lane: 'IDD-1', status: 'done', started_at: '2026-10-13T02:00:00Z', ended_at: '2026-10-13T02:01:00Z', wall_seconds: 60, head: 'head1', mainTip: 'tip2222222', mergeCommit: 'merge-r1', signed: false, repo: 'demo/demo', diff_lines: 1, blocking: 0 };
  const row = (at) => ({ name: 'eslint-warnings', status: 'pass', severity: 'blocking', counts: { mainline: 141, merged: 141, ...(at ? { at } : {}) } });
  const inherit = { mainTip: 'tip1111111', mergeCommit: 'merge-tip1', checks: ['eslint-warnings'] };
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { readBacklog, readLifecycle } = await import('../src/ledger/read.ts');
  const viewOf = async (round) => buildMetrics({
    since: '2026-10-12', until: '2026-10-18', rounds: [round], consumption: [],
    lifecycle: readLifecycle(), backlog: readBacklog(), laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }),
  });
  // a count measured at the round's own tip is the round's own
  const fresh = (await viewOf({ ...base, checks: [row(base.mainTip)] })).lanes[0];
  assert.equal(fresh.checks.eslint_warnings, 141);
  assert.equal(fresh.checks.eslint_at, undefined);
  // a count taken over keeps the tip it was measured at, so the number is not read as the newest round's
  const carriedView = await viewOf({ ...base, inherit, checks: [row(inherit.mainTip)] });
  const carried = carriedView.lanes[0];
  assert.equal(carried.checks.eslint_warnings, 141);
  assert.equal(carried.checks.eslint_at, inherit.mainTip);
  const { formatMetricsTable, renderMetricsSurvey } = await import('../src/metrics/format.ts');
  const table = formatMetricsTable(carriedView).join('\n');
  const survey = renderMetricsSurvey(carriedView);
  assert.match(table, /警告 141（前回の本流 tip1111 の値）/, 'the lane row says which tip the number belongs to');
  assert.match(survey, /\| 141（前回の本流 tip1111 の値） \|/, 'so does the survey’s lane row');
  assert.match(survey, /141（IDD-1 の前回の本流 tip1111 の値）/, 'and the survey’s period line');
  assert.doesNotMatch(survey, /tip1111 の最新の回/);
});

test('AC-006: a flaky test name that carries a ledger id passes the survey check and stays readable', { skip: !hasDeno }, async () => {
  const name = 'AC-011: an unreachable door fails without touching the tree';
  const { survey } = await renderFixture({ testName: name });
  assert.ok(survey.includes(name), 'the name is kept as it is, so a person can find the test');
  // the survey's own validator must pass on the generated document, as check-docs would run it
  const dir = scratchDir('survey-fixture-');
  const fixturePath = '_docs/survey/metrics/2026-42/survey.md';
  put(join(dir, 'survey.md'), survey.replace('references: []', `fixture_path: ${fixturePath}\nreferences: []`));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DD_SCOPE_BASE'));
  const r = spawnSync('deno', ['run', '--allow-read', '--allow-env', '--allow-run=git', VALIDATE_SURVEY, '--fixture', 'survey.md'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

/**
 * A canary reading of two weeks: the week the table covers and the week before it. The values are chosen so one row
 * changes its length, one its time and its shape, one stays inside the noise, and one has no value before it.
 */
async function canaryFixture() {
  freshState('metrics-canary-');
  const { writeCanaryRecord } = await import('../src/canary/record.ts');
  const model = 'ollama-cloud/deepseek-v4.1-flash';
  const task = (id, kind, { chars, total_ms, structure = 'ok', error }) => ({
    id, kind, structure, output: 'x'.repeat(Math.min(chars, 20)), chars, total_ms, usd: 0.0001,
    tokens: { input: 591, output: 13, cacheRead: 0, cacheWrite: 0 },
    ...(error ? { error } : {}),
  });
  const write = (day, tasks) => writeCanaryRecord({ role: 'executor', model, thinking: 'high', day, at: `${day}T03:00:00+09:00`, tasks });
  write('2026-10-06', [
    task('read-exports', 'read', { chars: 400, total_ms: 1500 }),
    task('summarize', 'read', { chars: 100, total_ms: 1000 }),
    task('json-items', 'json', { chars: 100, total_ms: 1000 }),
    task('diff-fix', 'diff', { chars: 200, total_ms: 2000 }),
  ]);
  write('2026-10-13', [
    task('read-exports', 'read', { chars: 500, total_ms: 1600 }),
    task('summarize', 'read', { chars: 150, total_ms: 1500 }),
    task('json-items', 'json', { chars: 300, total_ms: 1200 }),
    task('diff-fix', 'diff', { chars: 250, total_ms: 5000, structure: 'fail' }),
  ]);
  const { canaryWindows, readCanaryRecords } = await import('../src/canary/record.ts');
  const windows = canaryWindows('2026-10-12', '2026-10-18');
  const canary = readCanaryRecords([...windows.current, ...windows.previous]);
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const view = await buildMetrics({
    since: '2026-10-12', until: '2026-10-18', canary,
    lifecycle: [], backlog: [], rounds: [], consumption: [],
    laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }),
  });
  const { formatMetricsTable, renderMetricsSurvey } = await import('../src/metrics/format.ts');
  return { view, terminal: formatMetricsTable(view).join('\n'), survey: renderMetricsSurvey(view) };
}

const canaryRow = (view, task) => view.canary.rows.find((row) => row.task === task);

test('canary AC-005: the week’s table marks a shape that failed and a length or time twice the week before', async () => {
  const { view, terminal, survey } = await canaryFixture();
  assert.equal(view.canary.rows.length, 4, 'every question the period answered has a row');
  assert.equal(view.canary.previous.since, '2026-10-05');
  assert.equal(view.canary.previous.until, '2026-10-11');

  const json = canaryRow(view, 'json-items');
  assert.deepEqual(json.marks, { structure: false, chars: true, total_ms: false }, 'a length three times the week before is marked');
  assert.equal(json.ratio.chars, 3);
  const diff = canaryRow(view, 'diff-fix');
  assert.deepEqual(diff.marks, { structure: true, chars: false, total_ms: true }, 'a failed shape and a time 2.5 times the week before are marked');
  assert.equal(diff.ratio.total_ms, 2.5);

  const quiet = canaryRow(view, 'summarize');
  assert.deepEqual(quiet.marks, { structure: false, chars: false, total_ms: false }, 'a change inside the noise is not marked');
  const fresh = canaryRow(view, 'read-exports');
  assert.deepEqual(fresh.marks, { structure: false, chars: false, total_ms: false }, 'a value with nothing before it is not marked');

  // the terminal table has the section, the values and the marks
  assert.match(terminal, /canary（role の model の観測/);
  assert.match(terminal, /前週 2026-10-05 〜 2026-10-11/);
  assert.match(terminal, /!fail/);
  assert.match(terminal, /×3/);
  assert.match(terminal, /×2\.5/);
  // the cost is shown for every row and never marked
  assert.match(terminal, /\$0\.0001/);
  assert.doesNotMatch(terminal, /!\$/, 'a cost is not marked');
  // the survey has its own section under 結果, with the same marks and the cost as a value only
  assert.match(survey, /### canary（role の model の観測）/);
  assert.match(survey, /\| !fail \|/);
  assert.match(survey, /!300 文字（前週 100 文字・×3）/);
  assert.match(survey, /\| 構造 \/ 所要時間 \|/);
  assert.match(survey, /\$0\.0001/);
  assert.doesNotMatch(survey, /!\$/, 'a cost is not marked in the survey either');
  // the canary's spend is its own: it is in none of the lane totals
  assert.equal(view.totals.cost.budget, 0);
  assert.equal(view.totals.lanes, 0);
});

test('canary AC-006: the survey with the canary’s section passes the survey check', { skip: !hasDeno }, async () => {
  const { survey } = await canaryFixture();
  const dir = scratchDir('survey-canary-fixture-');
  const fixturePath = '_docs/survey/metrics/2026-42/survey.md';
  put(join(dir, 'survey.md'), survey.replace('references: []', `fixture_path: ${fixturePath}\nreferences: []`));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DD_SCOPE_BASE'));
  const r = spawnSync('deno', ['run', '--allow-read', '--allow-env', '--allow-run=git', VALIDATE_SURVEY, '--fixture', 'survey.md'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  // the doc must not name the intent ledger's ids, as the docs check reads them out
  assert.doesNotMatch(survey, /\b(?:DEC|INV|AC)-\d/);
});

/**
 * Judgements of the review net: one lane whose `s2_triage_done` events hold findings of every fate. The September
 * round is not this week's and must stay out, though the lane itself opened long before the week.
 */
async function netFixture({ extra = [] } = {}) {
  const { state } = freshState('metrics-net-');
  const ev = (idd_id, event, at, attrs = {}) => ({ idd_id, event, at, attrs });
  put(join(state, 'backlog.jsonl'), jsonl([{ idd_id: 'IDD-1', parent_id: null, created_at: '2026-09-01T00:00:00Z', gh_issue_url: 'https://github.com/demo/demo/issues/1', linear_issue_url: null, source_type: 'github', context: '', title: 'IDD-1', area: 'demo/demo' }]));
  const from = (role) => [`1-blind-${role}-some-model-1a2b3c`];
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl([
    ev('IDD-1', 'lane_open', '2026-09-01T00:00:00Z', { source_type: 'github', area: 'demo/demo' }),
    ev('IDD-1', 's2_review_started', '2026-09-02T00:00:00Z', { kind: 'blind', round: 1, run_roles: ['blind-reviewer'] }),
    ev('IDD-1', 's2_triage_done', '2026-09-02T01:00:00Z', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'old', path: 'old.ts', action: 'fix', from: from('blind-reviewer'), reported_severity: 'must' }], rejected: [], escalated_claims: ['old'] }),
    ev('IDD-1', 's2_review_started', '2026-10-13T00:00:00Z', { kind: 'blind', round: 1, run_roles: ['blind-reviewer', 'blind-reviewer-final'] }),
    ev('IDD-1', 's2_triage_done', '2026-10-13T01:00:00Z', {
      kind: 'blind', round: 1,
      accepted: [
        { ref: 'F-1', severity: 'must', claim: 'a must', path: 'a.ts', action: 'fix', from: from('blind-reviewer'), reported_severity: 'must' },
        // an accepted should with no handling reads as a fix, as the loop reads it
        { ref: 'F-2', severity: 'should', claim: 'no action', path: 'b.ts', from: from('blind-reviewer'), reported_severity: 'should' },
        { ref: 'F-3', severity: 'should', claim: 'later', path: 'c.ts', action: 'followup', from: from('blind-reviewer'), reported_severity: 'should' },
        { ref: 'F-4', severity: 'nit', claim: 'never', path: 'd.ts', action: 'skip', from: from('blind-reviewer'), reported_severity: 'nit' },
        // the longest role in the name wins, and a weight the reviewer did not give is "no record"
        { ref: 'F-5', severity: 'should', claim: 'final', path: 'e.ts', action: 'followup', from: ['1-blind-blind-reviewer-final-deepseek-v4.1-flash-go-5b70e5'] },
        // a name no role of the round fits
        { ref: 'F-6', severity: 'nit', claim: 'who', path: 'f.ts', action: 'skip', from: ['1-blind-mystery-x-111111'], reported_severity: 'nit' },
      ],
      rejected: [{ claim: 'wrong', reason: 'no', from: from('blind-reviewer'), reported_severity: 'should' }, { claim: 'wrong too', reason: 'no' }],
      escalated_claims: ['to a person', 'to a person too'],
    }),
    ...extra,
  ]));
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { readBacklog, readLifecycle } = await import('../src/ledger/read.ts');
  const view = await buildMetrics({
    since: '2026-10-12', until: '2026-10-18', rounds: [], consumption: [],
    lifecycle: readLifecycle(), backlog: readBacklog(),
    laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }),
  });
  return { view };
}

const netCell = (view, role, weight) => view.net.fates.find((r) => r.role === role && r.weight === weight);

test('net AC-001: findings are counted by reviewer role and weight, the four fates add up, and a person’s decision stays outside', async () => {
  const { view } = await netFixture();
  assert.equal(view.lanes.length, 0, 'the lane opened before the week, so it is not in the cost table');
  assert.equal(view.net.judgements, 1, 'but this week’s judgement of it is in the net, and September’s is not');
  assert.equal(view.net.escalated, 2, 'escalated claims are a count of their own');
  const must = netCell(view, 'blind-reviewer', 'must');
  assert.deepEqual([must.total, must.accepted, must.followup, must.skip, must.rejected], [1, 1, 0, 0, 0]);
  const should = netCell(view, 'blind-reviewer', 'should');
  assert.deepEqual([should.total, should.accepted, should.followup, should.skip, should.rejected], [3, 1, 1, 0, 1], 'a should with no handling is accepted; a followup is not');
  const nit = netCell(view, 'blind-reviewer', 'nit');
  assert.deepEqual([nit.total, nit.accepted, nit.followup, nit.skip, nit.rejected], [1, 0, 0, 1, 0], 'skip is a fate of its own, apart from followup');
  const final = netCell(view, 'blind-reviewer-final', '記録なし');
  assert.deepEqual([final.total, final.followup], [1, 1], 'the longest role fits the name, and the missing weight is not filled from the judgement’s own');
  assert.equal(netCell(view, '記録なし', 'nit').skip, 1, 'a name no role fits is "no record"');
  assert.equal(netCell(view, '記録なし', '記録なし').rejected, 1, 'a rejected finding with neither a name nor a weight is in the "no record" group');
  for (const row of [...view.net.fates, ...view.net.weights]) assert.equal(row.accepted + row.followup + row.skip + row.rejected, row.total, `${row.role} ${row.weight}`);
  assert.equal(view.net.weights.reduce((a, r) => a + r.total, 0), 8, 'six accepted and two rejected, each counted once');
});

test('net AC-001: penne’s correction changes the fate and leaves the reviewer’s own weight', async () => {
  const resumed = { idd_id: 'IDD-1', event: 's2_review_resumed', at: '2026-10-13T02:00:00Z', attrs: { corrections: [{ ref: 'F-2', severity: 'should', action: 'skip', reason: 'penne' }] } };
  const { view } = await netFixture({ extra: [resumed] });
  const should = netCell(view, 'blind-reviewer', 'should');
  assert.deepEqual([should.total, should.accepted, should.followup, should.skip, should.rejected], [3, 0, 1, 1, 1], 'the corrected fix is now a skip');
});

test('net AC-001: the survey and the terminal table show each group with its shares and the escalated count apart', async () => {
  const { view } = await netFixture();
  const { formatMetricsTable, renderMetricsSurvey } = await import('../src/metrics/format.ts');
  const survey = renderMetricsSurvey(view);
  assert.match(survey, /### 網: 指摘の運命/);
  assert.match(survey, /\| blind-reviewer \| should \| 3 \| 1（33\.3%） \| 1（33\.3%） \| 0（0\.0%） \| 1（33\.3%） \|/);
  assert.match(survey, /人に上げた指摘は 2 件/);
  assert.match(formatMetricsTable(view).join('\n'), /人に上げた 2 件/);
});

const mustItem = (ref, path, claim) => ({ ref, severity: 'must', claim, path, action: 'fix' });
const triageAt = (round, at, accepted) => ({ idd_id: 'IDD-205', event: 's2_triage_done', at, attrs: { kind: 'blind', round, accepted, rejected: [], escalated_claims: [] } });
const fixSentAt = (at) => ({ idd_id: 'IDD-205', event: 's2_fix_sent', at, attrs: {} });

async function returnedIn(events, { since = '2026-10-12', until = '2026-10-18' } = {}) {
  const { buildReviewNet } = await import('../src/metrics/net.ts');
  const day = (at) => at.slice(0, 10);
  return buildReviewNet(new Map([['IDD-205', events]]), (at) => day(at) >= since && day(at) <= until).returned;
}

test('net AC-002: a must that comes back after a fix is one row, though its claim was rewritten each round', async () => {
  const path = 'packages/idd-core/src/plan/ledger-reads-reference.ts';
  const events = [
    triageAt(2, '2026-10-13T01:00:00Z', [
      mustItem('F-6', path, '終了イベントの比較用 TS 写しが実行側の MoonBit 出力を参照し、final_end_events の正しさを独立に確かめない。'),
      mustItem('F-1', path, 'README の見出しの綴りが揃っていない。'),
    ]),
    fixSentAt('2026-10-13T02:00:00Z'),
    triageAt(3, '2026-10-13T03:00:00Z', [mustItem('F-7', path, '退役終端の TS 参照が MoonBit runtime の一覧を import し、final_end_events の正しさを独立に確かめない。')]),
    fixSentAt('2026-10-13T04:00:00Z'),
    triageAt(4, '2026-10-13T05:00:00Z', [
      mustItem('F-8', path, 'retire の比較用 TS 写しが MoonBit runtime 由来の final_end_events を使い、独立に確かめない。'),
      // the same finding written twice in one round
      mustItem('F-9', path, 'retire の比較用 TS 写しが MoonBit runtime 由来の final_end_events を使い、独立して確かめられない。'),
      mustItem('F-2', path, 'README の見出しの綴りが揃っていないので、読み手が迷う。'),
    ]),
  ];
  const rows = await returnedIn(events);
  assert.equal(rows.filter((r) => /F-[89]$/.test(r.returned)).length, 1, 'F-8 and F-9 are one finding in one round');
  const chain = rows.find((r) => r.returned === '4-blind/F-8');
  assert.deepEqual([chain.lane, chain.previous, chain.via, chain.returns, chain.path], ['IDD-205', '2-blind/F-6', ['3-blind/F-7'], 2, path], 'F-6 → F-7 → F-8 is one row that names the first round and the last');
  assert.equal(rows.find((r) => r.returned === '4-blind/F-2')?.previous, '2-blind/F-1', 'a rewritten claim at the same path is still found');
  assert.equal(rows.length, 2, 'the two findings, and nothing else');
});

test('net AC-002: another finding in the same file, or a return with no fix between, is not a return', async () => {
  const path = 'src/a.ts';
  const first = triageAt(1, '2026-10-13T01:00:00Z', [mustItem('F-1', path, 'finishRegistration は await の前に読んだ state で登録済みの本数を判定する')]);
  const fix = fixSentAt('2026-10-13T02:00:00Z');
  const other = triageAt(2, '2026-10-13T03:00:00Z', [mustItem('F-1', path, 'load() が読み取り・解析の失敗をすべて空の state に潰し、壊れた file の鍵が消える')]);
  assert.deepEqual(await returnedIn([first, fix, other]), [], 'the same path alone is not the same finding');
  const again = triageAt(2, '2026-10-13T03:00:00Z', [mustItem('F-1', path, 'finishRegistration は await の前に読んだ state で登録済みの本数を判定するので壊れる')]);
  assert.deepEqual(await returnedIn([first, again]), [], 'no fix was sent between the two judgements');
  assert.equal((await returnedIn([first, fix, again])).length, 1);
  assert.deepEqual(await returnedIn([first, fix, again], { since: '2026-10-19', until: '2026-10-25' }), [], 'a return belongs to the week of the judgement it came back in');
  const should = triageAt(2, '2026-10-13T03:00:00Z', [{ ref: 'F-1', severity: 'should', claim: 'finishRegistration は await の前に読んだ state で登録済みの本数を判定するので壊れる', path, action: 'fix' }]);
  assert.deepEqual(await returnedIn([first, fix, should]), [], 'a should is not a must');
});

/** a repo with three lanes landed on the mainline on 2026-10-13, ready for the changes that come after them */
function leakRepo() {
  const { root, state, repos } = freshState('metrics-leak-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const run = (iso, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } }).trim();
  const save = (iso, message) => { run(iso, 'add', '.'); run(iso, 'commit', '-m', message); return run(iso, 'rev-parse', 'HEAD'); };
  run('2026-10-01T00:00:00+09:00', 'init', '--initial-branch=main');
  put(join(repo, 'base.txt'), 'base\n');
  save('2026-10-01T00:00:00+09:00', 'chore: base');
  const land = (n, iso, file, text) => {
    run(iso, 'checkout', '-b', `idd/IDD-${n}`);
    put(join(repo, file), text);
    save(iso, `feat: lane ${n}`);
    run(iso, 'checkout', 'main');
    run(iso, 'merge', '--no-ff', `idd/IDD-${n}`, '-m', `Merge lane ${n}`);
    return run(iso, 'rev-parse', 'HEAD');
  };
  const merges = [
    land(1, '2026-10-13T09:00:00+09:00', 'one.txt', 'one a\none b\none c\n'),
    land(2, '2026-10-13T10:00:00+09:00', 'two.txt', 'two a\ntwo b\n'),
    land(3, '2026-10-13T11:00:00+09:00', 'three.txt', 'three a\nthree b\n'),
  ];
  const registry = { 'demo/demo': { name: 'demo', upstream: join(root, 'upstream'), work: repo, public_base: 'main', work_base: 'main', remote: 'origin', copy: [], setup: [], checks: [] } };
  put(repos, JSON.stringify({ repos: registry }));
  const landed = (id, merge, issue) => [
    { idd_id: id, event: 'lane_open', at: '2026-10-13T00:00:00Z', attrs: { source_type: 'github', area: 'demo/demo' } },
    { idd_id: id, event: 's4_land_approved', at: '2026-10-13T00:30:00Z', attrs: { merge_commit: merge, close: { issue } } },
    { idd_id: id, event: 's4_land_merged', at: '2026-10-13T00:40:00Z', attrs: { merge_commit: merge, branch: `idd/${id}` } },
  ];
  put(join(state, 'backlog.jsonl'), jsonl([1, 2, 3].map((n) => ({ idd_id: `IDD-${n}`, parent_id: null, created_at: '2026-10-13T00:00:00Z', gh_issue_url: `https://github.com/demo/demo/issues/${100 + n}`, linear_issue_url: null, source_type: 'github', context: '', title: `lane ${n}`, area: 'demo/demo' }))));
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl(merges.flatMap((m, i) => landed(`IDD-${i + 1}`, m, 101 + i))));
  return { root, repo, repos, registry, run, save, merges };
}

async function leaksView(since = '2026-10-12', until = '2026-10-18') {
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { readBacklog, readLifecycle } = await import('../src/ledger/read.ts');
  return buildMetrics({
    since, until, rounds: [], consumption: [], lifecycle: readLifecycle(), backlog: readBacklog(),
    laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }),
  });
}

const leaksOfArea = (view) => view.net.leaks.find((a) => a.area === 'demo/demo').rows;

test('net AC-003: a direct fix of a landed lane’s lines is a leak and a revert always is; a chore, a lane’s merge and a late fix are not', async () => {
  const f = leakRepo();
  put(join(f.repo, 'one.txt'), 'one a\none B fixed\none c\n');
  const fix = f.save('2026-10-14T09:00:00+09:00', 'fix(one): 1 の 2 行目を直す（#555）');
  // a revert of lane 2: it names the commit it undoes
  f.run('2026-10-15T09:00:00+09:00', 'revert', '--no-edit', '-m', '1', f.merges[1]);
  const revert = f.run('2026-10-15T09:00:00+09:00', 'rev-parse', 'HEAD');
  // a chore that names nobody rewrites a line of lane 3
  put(join(f.repo, 'three.txt'), 'three CHANGED\nthree b\n');
  f.save('2026-10-16T09:00:00+09:00', 'chore: 3 をいじる');
  // another lane’s merge rewrites a line of lane 1: another lane’s work, not a direct change
  f.run('2026-10-16T12:00:00+09:00', 'checkout', '-b', 'idd/IDD-9');
  put(join(f.repo, 'one.txt'), 'one a\none B fixed\none C later\n');
  f.save('2026-10-16T12:00:00+09:00', 'fix: lane 9 が 1 の 3 行目を書き換える');
  f.run('2026-10-16T12:00:00+09:00', 'checkout', 'main');
  f.run('2026-10-16T12:00:00+09:00', 'merge', '--no-ff', 'idd/IDD-9', '-m', 'Merge lane 9');
  // a fix of lane 3’s own line more than 7 days after it landed
  put(join(f.repo, 'three.txt'), 'three CHANGED\nthree fixed late\n');
  f.save('2026-10-21T12:00:00+09:00', 'fix(three): 3 を直す');

  const rows = leaksOfArea(await leaksView('2026-10-12', '2026-10-25'));
  assert.deepEqual(rows.map((r) => [r.lane, r.fix, r.kind, r.date]), [['IDD-1', fix, 'fix', '2026-10-14'], ['IDD-2', revert, 'revert', '2026-10-15']]);
  assert.deepEqual(rows[0].files, ['one.txt']);
  assert.equal(rows[0].merge, f.merges[0]);
  assert.deepEqual(rows[0].issues, [555], 'the Issue the fix names is on the row');
  assert.deepEqual(rows[1].issues, []);
  // a leak is in the week of its fix, whenever the lane landed
  assert.deepEqual(leaksOfArea(await leaksView('2026-10-19', '2026-10-25')), []);
  assert.equal(leaksOfArea(await leaksView('2026-10-14', '2026-10-14')).length, 1);
});

test('net AC-003: one fix of several landings is a row in each, and one landing has one row per commit', async () => {
  const f = leakRepo();
  // two hunks in lane 1’s file and one in lane 2’s, all in one commit
  put(join(f.repo, 'one.txt'), 'one a2\none b\none c2\n');
  put(join(f.repo, 'two.txt'), 'two a\ntwo b2\n');
  const fix = f.save('2026-10-14T09:00:00+09:00', 'fix: 1 と 2 をまとめて直す');
  const rows = leaksOfArea(await leaksView());
  assert.deepEqual(rows.map((r) => [r.lane, r.fix === fix, r.files]), [['IDD-1', true, ['one.txt']], ['IDD-2', true, ['two.txt']]]);
  assert.equal(new Set(rows.map((r) => `${r.merge}${r.fix}`)).size, rows.length);
});

test('net AC-003: a direct change that only names a lane or its Issue counts, and a mention of another Issue does not', async () => {
  const f = leakRepo();
  put(join(f.repo, 'two.txt'), 'two a\ntwo b2\n');
  f.save('2026-10-14T09:00:00+09:00', 'docs(two): IDD-2 の 2 行目を書き直す');
  put(join(f.repo, 'three.txt'), 'three a2\nthree b\n');
  f.save('2026-10-14T10:00:00+09:00', 'docs(three): 3 の文面を整える（#999）');
  put(join(f.repo, 'one.txt'), 'one a\none b\none c3\n');
  f.save('2026-10-14T11:00:00+09:00', 'docs(one): 続きを書く（#101）');
  const rows = leaksOfArea(await leaksView());
  assert.deepEqual(rows.map((r) => [r.lane, r.kind]), [['IDD-1', 'named'], ['IDD-2', 'named']]);
  assert.deepEqual(rows.map((r) => r.issues), [[], []], 'the Issue the lane closed is how it was named, not a bug Issue');
});

test('net AC-003: a hotfix is a fix by its commit type, and a subject that only says hotfix is not', async () => {
  const f = leakRepo();
  put(join(f.repo, 'one.txt'), 'one a\none b2\none c\n');
  f.save('2026-10-14T09:00:00+09:00', 'docs: hotfix の手順を書き直す');
  put(join(f.repo, 'two.txt'), 'two a2\ntwo b\n');
  const hotfix = f.save('2026-10-14T10:00:00+09:00', 'hotfix(two): 2 の 1 行目を直す');
  const rows = leaksOfArea(await leaksView());
  assert.deepEqual(rows.map((r) => [r.lane, r.fix, r.kind]), [['IDD-2', hotfix, 'fix']]);
});

test('net AC-005: a repo whose clone cannot be read shows "unreadable" for the leaks, and the other sections are as before', async () => {
  const f = leakRepo();
  const registry = { 'demo/demo': { ...f.registry['demo/demo'], work: join(f.root, 'no-such-clone') } };
  put(f.repos, JSON.stringify({ repos: registry }));
  const view = await leaksView();
  assert.equal(leaksOfArea(view), null, 'unreadable is null, not an empty list');
  assert.equal(view.lanes.length, 3, 'the lanes’ own table is as before');
  assert.equal(view.direct_commits[0].commits, null);
  const { renderMetricsSurvey, formatMetricsTable } = await import('../src/metrics/format.ts');
  const survey = renderMetricsSurvey(view);
  assert.match(survey, /読めない（対象 repo の work の clone か git を読めなかった。0 件ではない）/);
  assert.doesNotMatch(survey, /この週に直された漏れはありません/);
  assert.match(survey, /\| IDD-1 \|/, 'the lane table is still there');
  assert.match(formatMetricsTable(view).join('\n'), /demo: 読めない/);
});

test('net AC-005: a blame that fails makes the leaks "unreadable", not none, and the other sections are as before', async () => {
  const f = leakRepo();
  put(join(f.repo, 'one.txt'), 'one a\none B fixed\none c\n');
  f.save('2026-10-14T09:00:00+09:00', 'fix(one): 1 の 2 行目を直す');
  const bin = scratchDir('metrics-git-wrapper-');
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  put(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = blame ] && exit 1; done\nexec ${real} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  let view;
  try {
    process.env.PATH = `${bin}:${path}`;
    view = await leaksView();
  } finally {
    process.env.PATH = path;
  }
  assert.equal(leaksOfArea(view), null, 'a failed blame is null, not an empty list');
  assert.equal(view.lanes.length, 3, 'the lanes’ own table is as before');
  const { renderMetricsSurvey } = await import('../src/metrics/format.ts');
  const survey = renderMetricsSurvey(view);
  assert.match(survey, /読めない（対象 repo の work の clone か git を読めなかった。0 件ではない）/);
  assert.doesNotMatch(survey, /この週に直された漏れはありません/);
  assert.equal(leaksOfArea(await leaksView()).length, 1, 'without the wrapper the same fixture has its row');
});

/** the lifecycle of a public side lane: pushed, a PR, merged; no merge commit anywhere in it */
function publicLane(id, head, extra = []) {
  return [
    { idd_id: id, event: 'lane_open', at: '2026-10-13T00:00:00Z', attrs: { source_type: 'github', area: 'demo/demo' } },
    { idd_id: id, event: 's4_pushed', at: '2026-10-13T00:20:00Z', attrs: { pushed_branch: `idd/${id}`, commit: head } },
    { idd_id: id, event: 's4_pr_created', at: '2026-10-13T00:21:00Z', attrs: { pr_number: 7, commit: head } },
    { idd_id: id, event: 's4_merged', at: '2026-10-13T00:40:00Z', attrs: { merged_at: '2026-10-13T00:39:00Z', merged_by: 'someone', pr_number: 7 } },
    ...extra,
  ];
}

test('net AC-003: a public side lane lands by its PR’s head, and a lane with both records is one landing', async () => {
  const f = leakRepo();
  put(join(f.repo, 'one.txt'), 'one a\none B fixed\none c\n');
  const fix1 = f.save('2026-10-14T09:00:00+09:00', 'fix(one): 1 の 2 行目を直す');
  put(join(f.repo, 'two.txt'), 'two A fixed\ntwo b\n');
  const fix2 = f.save('2026-10-14T10:00:00+09:00', 'fix(two): 2 の 1 行目を直す');
  put(join(f.repo, 'three.txt'), 'three a\nthree B fixed\n');
  f.save('2026-10-14T11:00:00+09:00', 'fix(three): 3 の 2 行目を直す');
  const state = join(f.root, 'state');
  // lane 1: public, merged 4 times in the ledger and pushed twice (the later push is the head); lane 2: both records;
  // lane 3: a squash, whose head is not on the mainline
  const head1 = f.run('2026-10-14T09:00:00+09:00', 'rev-parse', `${f.merges[0]}^2`);
  const head2 = f.run('2026-10-14T09:00:00+09:00', 'rev-parse', `${f.merges[1]}^2`);
  const events = [
    ...publicLane('IDD-1', 'deadbeef'.repeat(5), []),
    { idd_id: 'IDD-1', event: 's4_pushed', at: '2026-10-13T00:30:00Z', attrs: { pushed_branch: 'idd/IDD-1', commit: head1 } },
    ...[0, 1, 2, 3].map((n) => ({ idd_id: 'IDD-1', event: 's4_merged', at: `2026-10-13T00:4${n}:00Z`, attrs: { merged_at: '2026-10-13T00:39:00Z', pr_number: 7 } })),
    ...publicLane('IDD-2', head2),
    { idd_id: 'IDD-2', event: 's4_land_merged', at: '2026-10-13T00:50:00Z', attrs: { merge_commit: f.merges[1], branch: 'idd/IDD-2' } },
    ...publicLane('IDD-3', '1234567890'.repeat(4)),
  ];
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl(events));
  const view = await leaksView();
  const area = view.net.leaks.find((a) => a.area === 'demo/demo');
  assert.deepEqual(area.rows.map((r) => [r.lane, r.merge, r.fix]), [['IDD-1', f.merges[0], fix1], ['IDD-2', f.merges[1], fix2]], 'the merge is solved from the head; a lane with both is one row');
  assert.equal(area.unresolved, 1, 'the lane whose head is not on the mainline is counted, not folded into none');
  assert.equal(new Set(area.rows.map((r) => `${r.merge}${r.fix}`)).size, area.rows.length);
  const { renderMetricsSurvey, formatMetricsTable } = await import('../src/metrics/format.ts');
  assert.match(renderMetricsSurvey(view), /着地を解けなかった公開 lane: 1 件/);
  assert.match(formatMetricsTable(view).join('\n'), /着地を解けなかった公開 lane: 1 件/);
  assert.equal(area.rows.some((r) => r.lane === 'IDD-3'), false);
});

test('net AC-003: a public side lane whose lines were not rewritten has no row, and another lane’s fix is not its', async () => {
  const f = leakRepo();
  // lane 2’s line is rewritten; only lane 1 is a public lane, so lane 2 (a work side landing) is its own row and lane 1 has none
  put(join(f.repo, 'two.txt'), 'two A fixed\ntwo b\n');
  f.save('2026-10-14T10:00:00+09:00', 'fix(two): 2 の 1 行目を直す');
  const head1 = f.run('2026-10-14T09:00:00+09:00', 'rev-parse', `${f.merges[0]}^2`);
  const state = join(f.root, 'state');
  const kept = readFileSync(join(state, 'lifecycle-demo-demo.jsonl'), 'utf8').split('\n').filter((l) => l && !l.includes('"IDD-1"')).map((l) => JSON.parse(l));
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl([...publicLane('IDD-1', head1), ...kept]));
  const rows = leaksOfArea(await leaksView());
  assert.deepEqual(rows.map((r) => r.lane), ['IDD-2']);
});

test('net AC-006: a lane still open reads up to the newest record, not the machine’s clock; an explicit now wins', async () => {
  const f = leakRepo();
  const state = join(f.root, 'state');
  put(join(state, 'lifecycle-demo-demo.jsonl'), jsonl([
    { idd_id: 'IDD-1', event: 'lane_open', at: '2026-10-13T00:00:00Z', attrs: { source_type: 'github', area: 'demo/demo' } },
    { idd_id: 'IDD-1', event: 's1_plan_started', at: '2026-10-13T00:05:00Z', attrs: {} },
    { idd_id: 'IDD-2', event: 'lane_open', at: '2026-10-13T00:10:00Z', attrs: { source_type: 'github', area: 'demo/demo' } },
  ]));
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { readBacklog, readLifecycle } = await import('../src/ledger/read.ts');
  const { renderMetricsSurvey } = await import('../src/metrics/format.ts');
  const run = (extra = {}) => buildMetrics({
    since: '2026-10-12', rounds: [], consumption: [], lifecycle: readLifecycle(), backlog: readBacklog(),
    laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }), ...extra,
  });
  const realNow = Date.now;
  let a, b;
  try {
    Date.now = () => Date.parse('2026-11-01T00:00:00Z');
    a = await run();
    Date.now = () => Date.parse('2026-12-24T12:00:00Z');
    b = await run();
  } finally {
    Date.now = realNow;
  }
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(renderMetricsSurvey(a), renderMetricsSurvey(b));
  assert.equal(a.until, '2026-10-13', 'the default end of the period is the newest record’s day');
  const open = a.lanes.find((l) => l.iddId === 'IDD-1');
  assert.ok(open.time.stage + open.time.gate + open.time.wait <= 10 + 1e-6, 'the open lane’s time ends at the last record (00:10)');
  const later = await run({ now: Date.parse('2026-10-13T01:00:00Z'), until: '2026-10-18' });
  const laterOpen = later.lanes.find((l) => l.iddId === 'IDD-1');
  assert.ok(laterOpen.time.stage + laterOpen.time.gate + laterOpen.time.wait > open.time.stage + open.time.gate + open.time.wait, 'an explicit now is kept');
});

test('net AC-006: the same records give the same numbers twice, in the table and in the JSON', async () => {
  const f = leakRepo();
  put(join(f.repo, 'one.txt'), 'one a\none b2\none c\n');
  f.save('2026-10-14T09:00:00+09:00', 'fix: 1 を直す');
  const { renderMetricsSurvey } = await import('../src/metrics/format.ts');
  const a = await leaksView();
  const b = await leaksView();
  assert.equal(leaksOfArea(a).length, 1);
  assert.equal(JSON.stringify(a.net), JSON.stringify(b.net));
  assert.equal(renderMetricsSurvey(a), renderMetricsSurvey(b));
  const first = await netFixture();
  const second = await netFixture();
  assert.equal(JSON.stringify(first.view.net), JSON.stringify(second.view.net));
});

test('net AC-004: the survey with the net’s sections passes the survey check', { skip: !hasDeno }, async () => {
  const f = leakRepo();
  put(join(f.repo, 'one.txt'), 'one a\none b2\none c\n');
  f.save('2026-10-14T09:00:00+09:00', 'fix: 1 を直す');
  const { renderMetricsSurvey } = await import('../src/metrics/format.ts');
  const survey = renderMetricsSurvey(await leaksView());
  assert.match(survey, /### 網: 着地の後に直された漏れ/);
  const dir = scratchDir('survey-net-fixture-');
  put(join(dir, 'survey.md'), survey.replace('references: []', 'fixture_path: _docs/survey/metrics/2026-42/survey.md\nreferences: []'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DD_SCOPE_BASE'));
  const r = spawnSync('deno', ['run', '--allow-read', '--allow-env', '--allow-run=git', VALIDATE_SURVEY, '--fixture', 'survey.md'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('F-184-11: the production `count: eslint-json` is exercised, and the counted warnings reach the lane’s row', async () => {
  // the command prints eslint’s `-f json` document, one file with warnings.txt’s count and one with two, and exits 1 as
  // eslint does when it found an error
  const document = "JSON.stringify([{ filePath: '/x/a.ts', errorCount: 0, warningCount: n, messages: [] }, { filePath: '/x/b.ts', errorCount: 1, warningCount: 2, messages: [] }])";
  const command = [process.execPath, '-e', `const n = Number(require('node:fs').readFileSync('warnings.txt', 'utf8')); console.log(${document}); process.exit(1);`];
  const f = repoFixture({ mainWarnings: 5, laneWarnings: 4 });
  const rows = await measure(f, [declarer({ count: 'eslint-json', command })]);
  assert.equal(rows[0].status, 'pass');
  assert.deepEqual(rows[0].counts, { mainline: 7, merged: 6, at: f.mainTip }, 'the warnings of every file are summed');
  put(join(f.state, 'lifecycle-demo-demo.jsonl'), jsonl([{ idd_id: 'IDD-1', event: 'lane_open', at: '2026-10-13T00:00:00Z', attrs: { source_type: 'github', area: 'demo/demo' } }]));
  const round = {
    id: 'r1', lane: 'IDD-1', status: 'done', started_at: '2026-10-13T02:00:00Z', ended_at: '2026-10-13T02:01:00Z', wall_seconds: 60,
    head: f.head, mainTip: f.mainTip, mergeCommit: f.mergeCommit, signed: false, diff_lines: 1, blocking: 0,
    checks: [{ name: 'eslint-warnings', status: 'pass', severity: 'blocking', counts: rows[0].counts }],
  };
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const { readBacklog, readLifecycle } = await import('../src/ledger/read.ts');
  const view = await buildMetrics({
    since: '2026-10-12', until: '2026-10-18', rounds: [round], consumption: [],
    lifecycle: readLifecycle(), backlog: readBacklog(), laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }),
  });
  assert.equal(view.lanes[0].checks.eslint_warnings, 6);
  assert.equal(view.lanes[0].checks.eslint_delta, -1);
  const { formatMetricsTable, renderMetricsSurvey } = await import('../src/metrics/format.ts');
  assert.match(formatMetricsTable(view).join('\n'), /警告 6（-1）/);
  assert.match(renderMetricsSurvey(view), /\| 6（-1） \|/);
});

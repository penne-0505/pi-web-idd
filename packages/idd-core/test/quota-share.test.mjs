import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchDir } from './helpers/scratch.mjs';

const VALIDATE_SURVEY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'validate-survey.ts');
const hasDeno = spawnSync('deno', ['--version']).status === 0;

/** a state of its own, so nothing the fixture reads is the repo's */
function freshState() {
  const root = scratchDir('quota-share-');
  const state = join(root, 'state');
  mkdirSync(state);
  const files = { 'repos.yaml': JSON.stringify({ repos: {} }), 'roles.yaml': 'pipeline:\n' };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'intent') });
  return state;
}

const BASE = { harness: 'claude', contract: 'claude', model: 'sonnet', input: 10, output: 100, cache_read: 0, cache_write: 0 };

/** the rows of a table, one per line, each cut at its spaces */
const table = (text, row) => text.trim().split('\n').map((line) => row(line.trim().split(/\s+/)));

/**
 * Consumption rows, one per line: `time lane role[:model] cost [cache_read] [idd_id]`. An attempt of a stage's run
 * names its run in `lane`; a reply names its lane in `idd_id`. A row of another contract is told by `contract`.
 */
const rowsOf = (unit, text, contract = 'claude') => table(text, ([at, lane, role, cost, cache = '0', iddId = '']) => {
  const [name, model = 'sonnet'] = role.split(':');
  return { ...BASE, contract, harness: contract === 'claude' ? 'claude' : 'pi', unit, at, lane, role: name, model, cost: Number(cost), cache_read: Number(cache), ...(iddId ? { idd_id: iddId } : {}) };
});

/** lifecycle rows, one per line: `lane event time [kind] run,run` (`-` for no run) */
const eventsOf = (text) => table(text, ([lane, event, at, ...rest]) => {
  const runs = rest.pop();
  return { idd_id: lane, event, at, attrs: { ...(rest[0] ? { kind: rest[0] } : {}), ...(runs === '-' ? {} : { run_ids: runs.split(',') }) } };
});

const sessionOf = (iddId, key, id) => ({ idd_id: iddId, [key]: id, started_at: '2026-11-02T00:00:00Z', worktree_path: '', branch: '' });
const single = (consumption, executor = []) => ({ lifecycle: eventsOf('IDD-1 lane_open 2026-11-02T00:00:00Z -'), backlog: lanesOf('IDD-1'), sessions: { planner: [], executor }, consumption });
const lanesOf = (...ids) => ids.map((id) => ({ idd_id: id, title: `lane ${id}`, area: 'demo/demo' }));

/**
 * IDD-1 opened before the period and kept running into it; IDD-2 opened inside it. Every run of a stage is named by an
 * event of the lane that started it; `run-z` and `conv-x` are named by no record.
 */
function fixture() {
  const lifecycle = eventsOf(`
    IDD-1 lane_open 2026-10-20T00:00:00Z -
    IDD-1 s1_plan_review_started 2026-11-02T00:00:00Z run-plan-review
    IDD-1 s2_review_started 2026-11-02T01:00:00Z blind run-blind
    IDD-1 s2_review_started 2026-11-02T02:00:00Z final run-final
    IDD-1 fix_plan_started 2026-11-02T03:00:00Z run-fix-plan
    IDD-2 lane_open 2026-11-03T00:00:00Z -
    IDD-2 s2_shape_started 2026-11-03T01:00:00Z run-shape
  `);
  const sessions = {
    planner: [sessionOf('IDD-1', 'planner_session_id', 'conv-plan')],
    executor: [sessionOf('IDD-1', 'executor_session_id', 'conv-impl'), sessionOf('IDD-1', 'executor_session_id', 'conv-fix')],
  };
  const consumption = [
    // the same role in two stages: the role does not say the stage
    ...rowsOf('attempt', `
      2026-11-02T01:30:00Z run-blind blind-reviewer:opus 3 9000
      2026-11-02T02:30:00Z run-final blind-reviewer:opus 1 1000
      2026-11-02T00:30:00Z run-plan-review plan-reviewer-claude 0.5
      2026-11-02T03:30:00Z run-fix-plan fix-planner-claude-sonnet 0.5
      2026-11-03T01:30:00Z run-shape shape-judge-claude 0.25
      2026-11-04T04:00:00Z run-z triage-claude-sonnet 0.5
    `),
    // conversations: the lane is in `idd_id`, the stage is the session's
    ...rowsOf('reply', `
      2026-11-04T00:00:00Z conv-plan planner-claude 2 0 IDD-1
      2026-11-04T01:00:00Z conv-impl executor-claude-sonnet 4 0 IDD-1
      2026-11-04T02:00:00Z conv-fix executor-claude-sonnet 4 0 IDD-1
      2026-11-04T03:00:00Z conv-x executor-claude-sonnet 1 0 IDD-2
    `),
    // outside the subscription, and outside the period
    ...rowsOf('attempt', '2026-11-03T00:00:00Z run-blind blind-reviewer 50', 'ollama-cloud'),
    ...rowsOf('attempt', '2026-10-20T00:00:00Z run-blind blind-reviewer 99\n2026-11-12T00:00:00Z run-blind blind-reviewer 99'),
  ];
  return { lifecycle, backlog: lanesOf('IDD-1', 'IDD-2'), sessions, consumption };
}

async function build(f, extra = {}) {
  const { buildMetrics } = await import('../src/metrics/build.ts');
  return buildMetrics({
    since: '2026-11-01', until: '2026-11-10', rounds: [], now: Date.parse('2026-11-10T00:00:00Z'),
    consumption: f.consumption, lifecycle: f.lifecycle, backlog: f.backlog, sessions: f.sessions, reviewLanes: f.reviewLanes ?? [],
    laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }), ...extra,
  });
}

const sum = (rows, weight) => rows.reduce((a, r) => a + r.share[weight], 0);
/** each of the three cuts adds up to 1 under both weights */
const assertWhole = (quota) => {
  for (const cut of ['lanes', 'roles', 'stages']) {
    for (const weight of ['price', 'tokens']) assert.ok(Math.abs(sum(quota.cuts[cut], weight) - 1) < 1e-9, `${cut} / ${weight} adds up to 1`);
  }
};
const byLabel = (rows) => Object.fromEntries(rows.map((r) => [r.label, r]));
const usdOf = (rows) => Object.fromEntries(rows.map((r) => [r.label, r.tokens.usd]));

test('the three cuts each add up to 100% under both weights, and the denominator is the subscription’s rows of the period', async () => {
  freshState();
  const { quota } = await build(fixture());
  assert.equal(quota.rows, 10, 'a pi row, a row before the period and a row after it are not in it');
  assertWhole(quota);
  assert.equal(quota.total.usd, 3 + 1 + 0.5 + 0.5 + 0.25 + 2 + 4 + 4 + 1 + 0.5, 'the pi row’s $50 is not in the denominator');
});

test('a lane opened before the period shows with its consumption, and the lanes of the period are not changed', async () => {
  freshState();
  const view = await build(fixture());
  assert.deepEqual(view.lanes.map((l) => l.iddId), ['IDD-2'], 'the lane list is still cut by the day each lane opened');
  const lanes = byLabel(view.quota.cuts.lanes);
  assert.ok(lanes['IDD-1'], 'IDD-1 opened on 2026-10-20 and is in the share by what it used in the period');
  assert.equal(lanes['IDD-1'].title, 'lane IDD-1');
  // IDD-1: 3+1 (blind, final) + 0.5 + 0.5 + 2 + 4 + 4; the unnamed run is its own row
  assert.equal(lanes['IDD-1'].tokens.usd, 15);
  assert.equal(lanes['IDD-2'].tokens.usd, 1.25);
  const unplaced = view.quota.cuts.lanes.filter((r) => r.unplaced);
  assert.deepEqual(unplaced.map((r) => r.tokens.usd), [0.5]);
  assert.equal(view.quota.cuts.lanes.at(-1).unplaced, true, 'what no record places is the last row');
});

test('a lane with no consumption in the period is not a row of zero', async () => {
  freshState();
  const f = fixture();
  f.lifecycle.push(...eventsOf('IDD-3 lane_open 2026-11-05T00:00:00Z -'));
  f.backlog.push(...lanesOf('IDD-3'));
  const view = await build(f);
  assert.equal(view.quota.cuts.lanes.some((r) => r.label === 'IDD-3'), false);
  assert.ok(view.quota.cuts.lanes.every((r) => r.units > 0));
});

test('a stage comes from the record of the run, and one role in two stages stays two stages', async () => {
  freshState();
  const { quota } = await build(fixture());
  assert.deepEqual(usdOf(quota.cuts.stages.filter((r) => !r.unplaced)), {
    巡のレビュー: 3, 最後のレビュー: 1, 計画の査読: 0.5, 直しの計画: 0.5, 形の判断: 0.25, planner: 2, executor: 4, '修正 1': 4,
  });
  assert.equal(byLabel(quota.cuts.roles)['blind-reviewer / opus'].tokens.usd, 4, 'the role and model pair is one row over the stages it ran in');
});

test('a reply’s row names the conversation’s lane, so the stage is found through the lane the session ran in', async () => {
  freshState();
  const sessions = ['uuid-impl', 'uuid-fix'].map((id) => sessionOf('IDD-1', 'executor_session_id', id));
  const f = single(rowsOf('reply', `
    2026-11-02T00:10:00Z lane-a executor-claude-sonnet 2 0 IDD-1
    2026-11-02T01:10:00Z lane-b executor-claude-sonnet 1 0 IDD-1
    2026-11-02T02:10:00Z lane-c executor-claude-sonnet 1 0 IDD-1
  `), sessions);
  const lanes = { 'uuid-impl': 'lane-a', 'uuid-fix': 'lane-b' };
  const stages = usdOf((await build(f, { conversationLaneOf: (id) => lanes[id] ?? null })).quota.cuts.stages);
  assert.deepEqual(stages, { executor: 2, '修正 1': 1, 段の記録なし: 1 }, 'a conversation no session record names stays unplaced');
  assert.deepEqual(usdOf((await build(f)).quota.cuts.stages), { 段の記録なし: 4 }, 'with no way to tell the lane of a session, none is guessed');
});

test('what no record places is one row, and no stage is guessed from the role', async () => {
  freshState();
  const { quota } = await build(fixture());
  const unplaced = quota.cuts.stages.filter((r) => r.unplaced);
  assert.equal(unplaced.length, 1, 'one row, however many rows it gathers');
  assert.equal(unplaced[0].label, '段の記録なし');
  // the unknown run (triage) and the conversation no session names (conv-x)
  assert.deepEqual([unplaced[0].tokens.usd, unplaced[0].units], [1.5, 2]);
  assert.ok(!quota.cuts.stages.some((r) => /-claude|-reviewer|triage/.test(r.label)), 'no stage is named after a role');
});

const reviewLane = (id, history) => ({ id, repo: 'o/r', pr: 7, title: 'someone else’s PR', url: 'https://example.test/pull/7', created_at: '2026-11-02T00:00:00Z', history: history.map(([event, at, attrs]) => ({ event, at, attrs })) });

test('a PR review lane’s run is placed by the lane’s history, and only a run no record names stays unplaced', async () => {
  freshState();
  const f = fixture();
  f.reviewLanes = [reviewLane('REV-aa', [
    ['r_blind_started', '2026-11-05T01:00:00Z', { run_ids: ['run-rb1', 'run-rb2'] }],
    ['r_triage_started', '2026-11-05T02:00:00Z', { run_id: 'run-rt' }],
    ['r_map_started', '2026-11-05T00:30:00Z', { run_id: 'run-rmap' }],
  ])];
  f.consumption.push(...rowsOf('attempt', `
    2026-11-05T01:30:00Z run-rb1 blind-reviewer:opus 2
    2026-11-05T01:40:00Z run-rb2 blind-reviewer:opus 1
    2026-11-05T02:30:00Z run-rt triage-claude-sonnet 0.5
    2026-11-05T00:40:00Z run-rmap map-claude 0.25
    2026-11-05T03:00:00Z run-nobody triage-claude-sonnet 0.125
  `));
  const view = await build(f);
  const { quota } = view;
  const lanes = byLabel(quota.cuts.lanes);
  assert.equal(lanes['REV-aa'].tokens.usd, 3.75);
  assert.equal(lanes['REV-aa'].title, 'someone else’s PR', 'a review lane has no backlog row, its own title is read');
  assert.equal(usdOf(quota.cuts.stages)['巡のレビュー'], 3 + 3.75, 'the issue lane’s round reviews and the PR review lane’s are one stage');
  assert.deepEqual(quota.cuts.lanes.filter((r) => r.unplaced).map((r) => r.tokens.usd), [0.5 + 0.125], 'the unnamed run of before and the one no history names');
  assert.deepEqual(quota.cuts.stages.filter((r) => r.unplaced).map((r) => r.tokens.usd), [1.5 + 0.125]);
  assertWhole(quota);
  assert.deepEqual(view.lanes.map((l) => l.iddId), ['IDD-2'], 'a review lane is not in the list cut by lane_open');
});

test('a run the lifecycle names first keeps its lane over a review lane’s history', async () => {
  freshState();
  const f = single(rowsOf('attempt', '2026-11-05T01:30:00Z run-1 blind-reviewer:opus 2'));
  f.lifecycle.push(...eventsOf('IDD-1 s2_review_started 2026-11-05T01:00:00Z blind run-1'));
  f.reviewLanes = [reviewLane('REV-bb', [['r_blind_started', '2026-11-05T01:00:00Z', { run_ids: ['run-1'] }]])];
  assert.deepEqual((await build(f)).quota.cuts.lanes.map((r) => r.label), ['IDD-1']);
});

test('the review lanes are read from the state when the caller hands none, and only when the period has a row', async () => {
  const state = freshState();
  const run = (consumption) => build({ ...single(consumption), lifecycle: [], backlog: [] }, { reviewLanes: undefined });
  assert.equal((await run([])).quota.rows, 0);
  assert.equal(readdirSync(state).includes('reviews'), false, 'nothing to cut: the review lanes are not read, and no directory appears');
  // a row to cut with no review lane ever opened: the read finds none and makes no directory for them
  assert.equal((await run(rowsOf('attempt', '2026-11-05T02:30:00Z run-rt triage-claude-sonnet 1'))).quota.rows, 1);
  assert.equal(readdirSync(state).includes('reviews'), false, 'a read of the share leaves the state as it was');
  mkdirSync(join(state, 'reviews'));
  writeFileSync(join(state, 'reviews', 'REV-cc.json'), JSON.stringify(reviewLane('REV-cc', [['r_triage_started', '2026-11-05T02:00:00Z', { run_id: 'run-rt' }]])));
  const { quota } = await run(rowsOf('attempt', '2026-11-05T02:30:00Z run-rt triage-claude-sonnet 1'));
  assert.deepEqual(quota.cuts.lanes.map((r) => r.label), ['REV-cc']);
});

test('a session’s label is one assignment: every planner session, and an executor’s own then its fix rounds by lane', async () => {
  const { laneSessions } = await import('../src/plan/budget.ts');
  const ex = (idd, id) => ({ ...sessionOf(idd, 'executor_session_id', id), harness: 'claude' });
  assert.deepEqual(
    laneSessions([sessionOf('IDD-1', 'planner_session_id', 'p1'), sessionOf('IDD-2', 'planner_session_id', 'p2')], [ex('IDD-1', 'e1'), ex('IDD-2', 'e2'), ex('IDD-1', 'e3')]),
    [
      { label: 'planner', id: 'p1', harness: undefined },
      { label: 'planner', id: 'p2', harness: undefined },
      { label: 'executor', id: 'e1', harness: 'claude' },
      { label: 'executor', id: 'e2', harness: 'claude' },
      { label: '修正 1', id: 'e3', harness: 'claude' },
    ],
  );
});

test('a row heavy in cache reads has a smaller share by price than by tokens, and a row with none reads the same by both', async () => {
  freshState();
  // 1,000,000 cache-read tokens that cost little, against 1,000 plain tokens that cost more per token
  const [heavy, plain] = rowsOf('reply', `
    2026-11-02T00:00:00Z c1 heavy 1 1000000 IDD-1
    2026-11-02T00:00:00Z c2 plain 1 0 IDD-1
  `);
  const roles = byLabel((await build(single([{ ...heavy, input: 0, output: 0 }, { ...plain, input: 500, output: 500 }]))).quota.cuts.roles);
  assert.equal(roles['heavy / sonnet'].share.price, 0.5);
  assert.ok(roles['heavy / sonnet'].share.tokens > 0.99, 'by tokens the cache reads dominate');
  assert.ok(roles['plain / sonnet'].share.price > roles['plain / sonnet'].share.tokens);
  assert.equal(roles['heavy / sonnet'].tokens.cacheRead, 1_000_000, 'the row’s own token column says why');
  const even = [{ ...plain, role: 'a', input: 100, output: 100, cost: 1 }, { ...plain, role: 'b', input: 300, output: 300, cost: 3 }];
  for (const row of (await build(single(even))).quota.cuts.roles) assert.ok(Math.abs(row.share.price - row.share.tokens) < 1e-9, 'no cache read: the two agree');
});

test('a period with no subscription row says there is nothing to cut, and is not a table of zeros', async () => {
  freshState();
  const f = fixture();
  f.consumption = f.consumption.filter((r) => r.contract !== 'claude');
  const view = await build(f);
  assert.equal(view.quota.rows, 0);
  assert.deepEqual(view.quota.cuts, { lanes: [], roles: [], stages: [] });
  const { formatMetricsTable } = await import('../src/metrics/format.ts');
  assert.match(formatMetricsTable(view).join('\n'), /Claude の消費の行はありません（0% ではなく、割る消費が無い）/);
});

test('the same records give the same shares twice, and reading them writes nothing into the state', async () => {
  const state = freshState();
  const f = fixture();
  writeFileSync(join(state, 'lifecycle-demo-demo.jsonl'), `${f.lifecycle.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const snapshot = () => readdirSync(state, { recursive: true }).sort().map((p) => `${p}:${statSync(join(state, p)).isFile() ? readFileSync(join(state, p), 'utf8') : ''}`);
  const before = snapshot();
  const first = await build(f);
  const second = await build({ ...f, consumption: [...f.consumption].reverse() });
  for (const cut of ['lanes', 'stages']) {
    assert.deepEqual(second.quota.cuts[cut].map((r) => [r.label, r.share]), first.quota.cuts[cut].map((r) => [r.label, r.share]));
  }
  assert.deepEqual(snapshot(), before, 'no file of the state changed or appeared');
});

const seven = { start: '2026-11-06T10:00:00.000Z', end: '2026-11-13T10:00:00.000Z', first_at: '2026-11-06T01:00:00.000Z', last_at: '2026-11-10T09:00:00.000Z', from: 0.02, to: 0.68, rise: 0.66, observations: 58 };
const windows = (five = { observations: 0, unplaced: 0 }, week = { observations: 58, unplaced: 0, peak: seven }) => ({
  windows: [
    { window: 'five_hour', label: '5 時間の枠', ...five },
    { window: 'seven_day', label: '週上限', ...week },
  ],
});

test('the windows are handed in by the caller for the period the metrics resolved, and the core reads no file for them', async () => {
  freshState();
  const seen = [];
  const view = await build(fixture(), { quotaWindows: (period) => { seen.push(period); return windows(); } });
  assert.deepEqual(seen, [{ since: '2026-11-01', until: '2026-11-10' }]);
  assert.equal(view.quota.windows.windows[1].peak.rise, 0.66);
  assert.equal((await build(fixture())).quota.windows, undefined, 'no reader, no reading');
});

test('the terminal table writes both weights on each row, the windows apart, and "no observation" for a window with none', async () => {
  freshState();
  const view = await build(fixture(), { quotaWindows: () => windows() });
  const { formatMetricsTable } = await import('../src/metrics/format.ts');
  const text = formatMetricsTable(view).join('\n');
  const rows = text.split('\n').filter((l) => /^ {4}IDD-1 /.test(l));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /値段の比 \d+\.\d% \/ token 等倍 \d+\.\d%/);
  assert.match(rows[0], /cache 読 \d+（\d+\.\d%）/, 'the row’s cache reads are in the same line');
  assert.match(text, /合計 {2}値段の比 100\.0% \/ token 等倍 100\.0%/);
  assert.match(text, /5 時間の枠: 観測なし/);
  assert.match(text, /週上限: 一番上がった窓 2026-11-06 19:00 JST 〜 2026-11-13 19:00 JST {2}0\.02 → 0\.68（\+66 点） {2}観測 58 件/);
  assert.match(text, /propter の外の消費（penne の対話など）も混ざり/);
  assert.match(text, /消費の行の時刻（JST の日）で切る。lane を開いた日では切らない/);
  assert.match(text, /lane 側の設定置き場の run のものだけ/);
  // observations that cannot be placed are not "no observation", and the weekly table goes through the same line
  const unplaced = await build(fixture(), { quotaWindows: () => windows({ observations: 3, unplaced: 3 }) });
  assert.match(formatMetricsTable(unplaced).join('\n'), /5 時間の枠: 観測 3 件あるが、リセット時刻が無く窓に置けないので上昇は読めない/);
  assert.match((await import('../src/metrics/format.ts')).renderMetricsSurvey(unplaced), /- 5 時間の枠: 観測 3 件あるが、リセット時刻が無く窓に置けない/);
});

test('the weekly table has the share and the windows as sections of the result, and passes the survey check', { skip: !hasDeno }, async () => {
  freshState();
  const view = await build(fixture(), { quotaWindows: () => windows() });
  const { renderMetricsSurvey } = await import('../src/metrics/format.ts');
  const doc = renderMetricsSurvey(view);
  const heads = ['## 結果', '### Claude サブスクの按分', '### Claude の窓の実測', '## 確かめていないこと'].map((h) => doc.indexOf(h));
  assert.deepEqual([...heads].sort((a, b) => a - b), heads);
  assert.ok(heads[0] >= 0);
  assert.match(doc, /\| 合計 \| 100\.0% \| 100\.0% \|/);
  assert.doesNotMatch(doc, /\b(?:DEC|INV|AC)-\d/);
  const dir = scratchDir('quota-survey-');
  writeFileSync(join(dir, 'survey.md'), doc.replace('references: []', 'fixture_path: _docs/survey/metrics/2026-45/survey.md\nreferences: []'));
  const env = { ...process.env };
  delete env.DD_SCOPE_BASE;
  const checked = spawnSync('deno', ['run', '--allow-read', '--allow-env', '--allow-run=git', VALIDATE_SURVEY, '--fixture', 'survey.md'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
});

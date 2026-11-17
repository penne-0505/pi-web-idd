import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatMetricsTable, renderMetricsSurvey } from '../src/metrics/format.ts';
import { openState, sessionRow, writeRows } from './helpers/lane-ledger.mjs';

const DAY = '2026-10-13';

/**
 * A lane's rows from lines of `HH:MM[:SS] event key=value ...` (the ledger's own time is UTC, on one day). A value is
 * read as JSON when it is one; `stall=N` on the opening row is the watch's minutes the lane opened under.
 */
function laneRows(id, text) {
  return text.trim().split('\n').map((line) => {
    const [t, event, ...pairs] = line.trim().split(/\s+/);
    const attrs = Object.fromEntries(pairs.map((p) => {
      const [key, ...rest] = p.split('=');
      const raw = rest.join('=');
      try { return [key, JSON.parse(raw)]; } catch { return [key, raw]; }
    }));
    const { stall, ...own } = attrs;
    const open = event === 'lane_open' ? { source_type: 'github', area: 'demo/demo', ...(stall ? { pipeline: { pipeline: { stall_watch: { stall_minutes: stall } }, models: {}, key: 'k' } } : {}) } : {};
    return { idd_id: id, event, at: `${DAY}T${t.length === 5 ? `${t}:00` : t}Z`, attrs: { ...open, ...own } };
  });
}

/** the period's view over lanes given as `{ id: text }`, with the executor's session starts and the run records in the state */
async function viewOf(lanes, { sessions = [], runs = {}, landRuns = [], extra = {} } = {}) {
  const lifecycle = Object.entries(lanes).flatMap(([id, text]) => laneRows(id, text));
  const { state } = openState('metrics-hands-', lifecycle);
  const backlog = Object.keys(lanes).map((id) => ({ idd_id: id, area: 'demo/demo', title: id, context: '', created_at: `${DAY}T00:00:00Z` }));
  writeRows(state, 'executor-sessions.jsonl', ...sessions);
  for (const [id, record] of Object.entries(runs)) {
    mkdirSync(join(state, 'lanes', id), { recursive: true });
    writeFileSync(join(state, 'lanes', id, 'lane.json'), JSON.stringify(record));
  }
  const { saveLandRun } = await import('../src/overlay/land-run.ts');
  for (const rec of landRuns) saveLandRun(rec);
  const { buildMetrics } = await import('../src/metrics/build.ts');
  const options = { since: DAY, until: DAY, rounds: [], consumption: [], lifecycle, backlog, ...extra };
  return buildMetrics({ ...options, laneCostOf: async () => ({ total: 0, parts: [], subscription: [] }) });
}

/** the start of an executor's session of a lane, at a time of the day */
const session = (id, t) => sessionRow('executor', `s-${id}-${t}`, `${DAY}T${t}:00Z`, { idd_id: id });
const laneOf = (view, id) => view.lanes.find((l) => l.iddId === id);
const sides = (h) => [h.inside, h.outside, h.answer, h.unclassified];
const kindsOn = (h, side) => h.kinds.filter((k) => k.side === side).map((k) => `${k.kind} ${k.count}`);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not ${expected}`);

test('AC-001: the hands are counted by side, a mark decides whose a row is, and a kind no table names is its own count', async () => {
  const view = await viewOf({
    'IDD-1': `
      00:00 lane_open
      00:01 s1_go at_by=user
      00:02 s1_go at_by=auto
      00:03 s4_land_approved signed=true
      00:04 s4_land_approved
      00:04:30 s4_land_approved signed=false
      00:05 lane_budget_extended at_by=user
      00:06 s1_granularity_answered decision=single
      00:07 s2_review_resumed at_by=user decision=continue
      00:08 s2_review_resumed at_by=user decision=continue
      00:09 s2_review_resumed at_by=user decision=accept
      00:10 s2_interjection
      00:11 s3_reject
      00:12 s4_verify_user_judgment_answered by=harness
      00:13 s4_verify_user_judgment_answered
      00:14 s1_revise_requested at_by=user cause=purpose_withdrawn purpose_id=P-1
      00:15 lane_stall_resumed at_by=user
      00:16 question_batch_answered answered_by=router
      00:17 question_batch_answered
      00:18 priority_elevated elevated_by=user
      00:19 some_new_event at_by=user
      00:20 s3_ok at_by=auto
      00:21 some_quiet_event
      00:22 lane_close
    `,
    'IDD-2': `
      01:00 lane_open
      01:01 s2_review_resumed at_by=user decision=continue
      01:02 s0_requeue_go at_by=user
      01:02:10 s1_go
      01:02:20 s2_review_resumed decision=accept
      01:03 lane_close at_by=user
    `,
  });
  const one = laneOf(view, 'IDD-1').hands;
  assert.deepEqual(sides(one), [5, 8, 1, 2], 'a signed approval and one from before signing was required are inside; signed=false is a machine row');
  assert.deepEqual(kindsOn(one, 'outside'), [
    's2_review_resumed:continue 2', 'lane_stall_resumed 1', 's1_revise_requested 1', 's2_interjection 1',
    's2_review_resumed:accept 1', 's3_reject 1', 's4_verify_user_judgment_answered 1',
  ], 'the outside kinds, most counted first; a withdrawal’s send-back is one hand');
  assert.deepEqual(kindsOn(one, 'unclassified'), ['priority_elevated 1', 'some_new_event 1']);
  assert.deepEqual(sides(laneOf(view, 'IDD-2').hands), [1, 4, 0, 0], 'a GO and a decision from before `at_by` was written are a person’s; at_by=auto (IDD-1) is not');
  const total = view.totals.hands;
  assert.deepEqual(sides(total), [6, 12, 1, 2], 'the period is the lanes added up');
  assert.equal(total.kinds.find((k) => k.kind === 's2_review_resumed:continue').count, 3);
  assert.equal(total.kinds.reduce((a, k) => a + k.count, 0), 21);
});

test('AC-002: the table and the weekly table print the lane’s hands and its outside kinds from the same counts', async () => {
  const view = await viewOf({
    'IDD-1': `
      00:00 lane_open
      00:01 s2_review_resumed at_by=user decision=continue
      00:02 s2_review_resumed at_by=user decision=continue
      00:03 s2_interjection
      00:04 s1_go at_by=user
      00:05 lane_close
    `,
  });
  const table = formatMetricsTable(view).join('\n');
  assert.match(table, /手 内 1 \/ 外 3 \/ 回答 0 \/ 未分類 0  外の内訳 s2_review_resumed:continue 2 \/ s2_interjection 1/);
  assert.match(table, /人の手（台帳に残ったものだけ）: 内 1 \/ 外 3 \/ 回答 0 \/ 未分類 0/);
  const survey = renderMetricsSurvey(view);
  assert.match(survey, /\| IDD-1 \| 1 \| 3 \| 0 \| 0 \| s2_review_resumed:continue 2 \/ s2_interjection 1 \|/);
  assert.match(survey, /\| 人の手: 外 \| 3 \|/);
  assert.match(survey, /\| 外 \| `s2_review_resumed:continue` \| 2 \|/);
});

test('AC-003: a gate and a wait are no stop, a gap with a session or a run in it loses that time, and what is left counts whole', async () => {
  const view = await viewOf({
    // nothing runs for an hour at the plan: all of it is a stop; the GO gate and the wait for the slot are not
    'IDD-1': '00:00 lane_open\n01:00 s1_ready\n01:05 s1_plan_review_done must=0\n06:00 s1_go\n08:00 s2_start\n08:05 lane_close',
    // a planner's session began four minutes before the plan: the 196 before it stay, the 4 are the session's
    'IDD-2': '00:00 lane_open\n03:20 s1_ready\n03:25 lane_close',
    // a run covered all but ten minutes of the gap: what is left is under the watch's 45 and is no stop
    'IDD-3': '00:00 lane_open\n02:00 s1_plan_review_done must=3 run_ids=["run-a","run-gone"]\n02:01 lane_close',
    // the same gap with a run whose record is gone: not read as running
    'IDD-4': '00:00 lane_open\n02:00 s1_plan_review_done must=0 run_ids=["run-gone"]\n02:01 lane_close',
    // a session that began with the executor's start covers the long turn to the next row
    'IDD-5': '00:00 lane_open\n00:10 s1_ready\n00:20 s1_go\n00:25 s2_start\n07:00 s2_result\n07:05 lane_close',
    // a lane that opened with its own setting of 90 minutes: a 60-minute gap is not a stop
    'IDD-6': '00:00 lane_open stall=90\n01:00 s1_ready\n01:05 lane_close',
    // a setting of 0 is no setting: the default 45 minutes applies, so a 60-minute gap is a stop
    'IDD-7': '00:00 lane_open stall=0\n01:00 s1_ready\n01:05 lane_close',
    // a lane that ended in an abort or a drop is over: the hours to the ledger's newest row are no stop
    'IDD-8': '00:00 lane_open\n00:05 lane_abort',
    'IDD-9': '00:00 lane_open\n00:05 lane_drop',
    // a run only a review round's `whole_run_ids` names covers the gap as a `run_ids` one does: 10 minutes left is no stop (120 if it were not read)
    'IDD-10': '00:00 lane_open\n02:00 s2_review_started whole_run_ids=["run-a"]\n02:01 lane_close',
  }, {
    sessions: [session('IDD-2', '03:16'), session('IDD-5', '00:25')],
    runs: { 'run-a': { started_at: `${DAY}T00:00:00Z`, ended_at: `${DAY}T01:50:00Z` } },
  });
  assert.ok(laneOf(view, 'IDD-1').time.gate > 0, 'the fixture reaches the GO gate');
  assert.ok(laneOf(view, 'IDD-1').time.wait > 0, 'and the wait for the executor’s slot');
  // the minutes of IDD-1 … IDD-9 in order
  [60, 196, 0, 120, 0, 0, 60, 0, 0, 0].forEach((minutes, i) => near(laneOf(view, `IDD-${i + 1}`).silent.minutes, minutes));
  assert.equal(laneOf(view, 'IDD-1').silent.spans, 1);
  near(view.totals.silent.minutes, 60 + 196 + 120 + 60);
  assert.deepEqual([view.totals.silent.spans, view.totals.silent.from_watch], [4, 0], 'nothing here was a stop the watch recorded');
});

/** a landing check's record: running when it has no end, with the lane (or the batch's members) it checks */
const landRun = (lane, from, to, batch) => ({
  id: `land-${lane}`, lane, status: to ? 'done' : 'running', started_at: `${DAY}T${from}:00Z`, ...(to ? { ended_at: `${DAY}T${to}:00Z` } : {}),
  repo: '/r', common: '/r', head: 'h', mainTip: 'm', mergeCommit: 'c', signed: true, log: '', spec: { ...(batch ? { batch } : {}) },
});

test('AC-003: the time a landing check ran is no stop, whether it is running, ended in a round, or ran for a batch the lane is in', async () => {
  const gap = '00:00 lane_open\n01:00 s1_ready\n01:05 lane_close';
  const view = await viewOf({
    // a check still running covers the whole gap
    'IDD-1': gap,
    // a round that ended covers it too; the run's record was overwritten by a later round
    'IDD-2': gap,
    // the batch's check names this lane as a member
    'IDD-3': gap,
    // a check that covered 40 of the 60 minutes leaves 20: under the watch's 45
    'IDD-4': gap,
    // no check ran: the hour is a stop
    'IDD-5': gap,
  }, {
    landRuns: [landRun('IDD-1', '00:00'), landRun('batch-1', '00:00', '01:00', ['IDD-3'])],
    extra: { rounds: [
      { id: 'r2', lane: 'IDD-2', status: 'done', checks: [], started_at: `${DAY}T00:00:00Z`, ended_at: `${DAY}T01:00:00Z` },
      { id: 'r4', lane: 'IDD-4', status: 'failed', checks: [], started_at: `${DAY}T00:00:00Z`, ended_at: `${DAY}T00:40:00Z` },
    ] },
  });
  [0, 0, 0, 0, 60].forEach((minutes, i) => near(laneOf(view, `IDD-${i + 1}`).silent.minutes, minutes));
});

test('AC-003: the sessions the caller hands in are the ones whose time is taken out of a stop', async () => {
  const view = await viewOf({ 'IDD-1': '00:00 lane_open\n03:20 s1_ready\n03:25 lane_close' }, {
    extra: { sessions: { planner: [], executor: [session('IDD-1', '03:16')] } },
  });
  near(laneOf(view, 'IDD-1').silent.minutes, 196);
});

test('AC-001: an abort a card wrote before `idd ignore` closed a lane by itself is one outside hand', async () => {
  const view = await viewOf({ 'IDD-1': '00:00 lane_open\n00:05 lane_abort' });
  assert.deepEqual(sides(laneOf(view, 'IDD-1').hands), [0, 1, 0, 0]);
  assert.deepEqual(kindsOn(laneOf(view, 'IDD-1').hands, 'outside'), ['lane_abort 1']);
});

test('AC-004: a stop the watch recorded is counted once with the gap it overlaps, and one that does not read makes no stop', async () => {
  const view = await viewOf({
    // the record's own since is the gap's start: one stop, not two
    'IDD-1': `00:00 lane_open\n01:00 lane_stall_detected since="${DAY}T00:00:00Z"\n01:10 lane_stall_resumed at_by=user\n01:11 lane_close`,
    // an instruction has no since: it starts at the row before the watch's own send-back
    'IDD-2': '00:00 lane_open\n00:05 s2_result\n01:00 s4_verify_user_judgment_answered by=harness\n01:00:02 lane_stall_instructed\n01:10 lane_close',
    // a since that does not read makes no stop, and the session covers the gap
    'IDD-3': '00:00 lane_open\n01:00 lane_stall_detected since="not a time"\n01:00:30 lane_close',
    // a stop the watch recorded after a gap that a session covers: the watch's stop is still a stop, once
    'IDD-4': `00:00 lane_open\n02:00 lane_stall_detected since="${DAY}T01:00:00Z"\n02:00:30 lane_close`,
  }, { sessions: [session('IDD-3', '00:00'), session('IDD-4', '00:00')] });
  for (const [id, expected, spans] of [['IDD-1', 60, 1], ['IDD-2', 55 + 2 / 60, 1], ['IDD-3', 0, 0], ['IDD-4', 60, 1]]) {
    near(laneOf(view, id).silent.minutes, expected);
    assert.deepEqual([laneOf(view, id).silent.spans, laneOf(view, id).silent.from_watch], [spans, spans], id);
  }
  assert.deepEqual([view.totals.silent.spans, view.totals.silent.from_watch], [3, 3]);
  near(view.totals.silent.minutes, 60 + 55 + 2 / 60 + 60);
});

test('AC-005: the plan review’s rounds and each round’s must are the review rows, and a round that failed is a round with no must', async () => {
  const view = await viewOf({
    'IDD-1': '00:00 lane_open\n00:10 s1_plan_review_done must=6 should=2\n00:20 s1_plan_review_done failed=true\n00:30 s1_plan_review_done must=2\n00:40 s1_plan_review_done must=0\n00:41 lane_close',
    'IDD-2': '01:00 lane_open\n01:01 lane_close',
  });
  assert.deepEqual(laneOf(view, 'IDD-1').plan_review, { rounds: 4, must: [6, null, 2, 0] });
  assert.deepEqual(laneOf(view, 'IDD-2').plan_review, { rounds: 0, must: [] });
  assert.match(formatMetricsTable(view).join('\n'), /計画の査読 4 回（must 6 → 失敗 → 2 → 0）/);
  assert.match(renderMetricsSurvey(view), /\| 4 回 \| 6 → 失敗 → 2 → 0 \|/);
});

test('AC-001: a hand approval of the review card, the push approval and an ignore each fall inside or outside once', async () => {
  const view = await viewOf({
    'IDD-1': `
      00:00 lane_open
      00:01 s3_ok reviewer_notes=""
      00:02 s3_ok at_by=auto
      00:03 s4_push_approved head="abc"
      00:04 s1_defer
      00:05 lane_close outcome=aborted via=ignore
    `,
    'IDD-2': `
      01:00 lane_open
      01:01 s1_granularity_answered decision=approve
      01:02 lane_close outcome=aborted via=ignore
    `,
    'IDD-3': `
      02:00 lane_open
      02:01 lane_close outcome=merged
      02:02 lane_close outcome=local
    `,
  });
  assert.deepEqual(sides(laneOf(view, 'IDD-1').hands), [2, 2, 0, 0], 's3_ok by hand and the push are inside; the defer and the ignore are outside');
  assert.deepEqual(kindsOn(laneOf(view, 'IDD-1').hands, 'inside'), ['s3_ok 1', 's4_push_approved 1']);
  assert.deepEqual(sides(laneOf(view, 'IDD-2').hands), [1, 0, 0, 0], 'the close after an approved granularity is the same press as the answer');
  assert.deepEqual(sides(laneOf(view, 'IDD-3').hands), [0, 0, 0, 0], 'the engine’s own closes are no hand');
  assert.deepEqual(sides(view.totals.hands), [3, 2, 0, 0]);
});

test('AC-006: the weekly table says which hands it does not count and what an unmarked kind does not show', async () => {
  const view = await viewOf({ 'IDD-1': '00:00 lane_open\n00:01 s1_go at_by=user\n00:02 lane_close' });
  const survey = renderMetricsSurvey(view);
  for (const line of [
    /\| 人の手: 内（承認） \| 1 \|/,
    /\| 止まり \| 0 分/,
    /worktree への file の複製・サービスの停止・hotfix の commit・状態の手直しは、lane の外の操作で台帳に行を書く主体が無い/,
    /本流への直接 commit は、直接 commit の欄が別に数えていて、人の手には足していない/,
    /印の無い新しい種類の人の手は、宣言が無いと未分類にも出ない/,
  ]) assert.match(survey, line);
  assert.match(formatMetricsTable(view).join('\n'), /数えない手: worktree への file の複製/);
  assert.equal(renderMetricsSurvey(view), survey, 'the same records give the same table');
});

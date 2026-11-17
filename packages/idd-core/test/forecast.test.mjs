import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchDir } from './helpers/scratch.mjs';

import { buildForecast } from '../src/plan/forecast.ts';
import { fixCapReached } from '../src/ledger/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = Date.parse('2026-10-13T00:00:00Z');
const at = (m) => new Date(BASE + m * 60_000).toISOString();
const ev = (idd, event, m, attrs = {}) => ({ idd_id: idd, event, at: at(m), attrs });
const ROLES_WITH_REVIEW = 'pipeline:\n  plan_review: { role: reviewer }\n';

function setup(lanes, roles = '') {
  const root = scratchDir('forecast-');
  const state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), 'repos: {}\n');
  writeFileSync(join(root, 'roles.yaml'), roles);
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), lanes.map((l) => JSON.stringify({ idd_id: l.id, area: l.area ?? 'a', title: 't', context: '', created_at: at(0) })).join('\n') + '\n');
  const byArea = new Map();
  for (const lane of lanes) {
    const list = byArea.get(lane.area ?? 'a') ?? [];
    list.push(...lane.events);
    byArea.set(lane.area ?? 'a', list);
  }
  for (const [area, events] of byArea) writeFileSync(join(state, `lifecycle-${area}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { root, state };
}

const lane = (view, id) => {
  const found = view.lanes.find((l) => l.iddId === id);
  assert.ok(found, `${id} is in the forecast`);
  return found;
};
const mins = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

/** an open lane whose implementation started at 2 and whose first review and R2 are still ahead */
const implLane = (id) => ({ id, events: [ev(id, 'lane_open', 0), ev(id, 's1_go', 1), ev(id, 's2_start', 2)] });

/** a landed lane (approved, not yet closed): the stage it stands in is the landing itself */
const landLane = (id) => ({
  id,
  events: [
    ev(id, 'lane_open', 0), ev(id, 's2_start', 2), ev(id, 's2_result', 30),
    ev(id, 's2_review_started', 31, { kind: 'blind', round: 1, risk: 'Medium' }),
    ev(id, 's2_triage_done', 45, { kind: 'blind', round: 1, accepted: [] }),
    ev(id, 's2_review_converged', 46), ev(id, 's2_device_skipped', 47), ev(id, 's4_submit_started', 48),
    ev(id, 's4_land_approved', 60, { signed: true, head: 'h' }),
  ],
});

test('a lane before a gate gets the time to the gate and the gate itself (AC-014)', () => {
  const now = Date.parse(at(5));
  setup([
    { id: 'IDD-1', events: [ev('IDD-1', 'lane_open', 0)] },
    implLane('IDD-2'),
  ], ROLES_WITH_REVIEW);
  const view = buildForecast({ now });
  const plan = lane(view, 'IDD-1');
  assert.equal(plan.now.kind, 'stage');
  assert.equal(plan.now.stage, 'plan');
  assert.equal(plan.eta.stopsAt, 'go');
  // (plan 10 - 5 elapsed) + plan review 25 = 30
  assert.equal(mins(at(5), plan.eta.at), 30);
  const impl = lane(view, 'IDD-2');
  assert.equal(impl.eta.stopsAt, 'sign');
  // (impl 39 - 3) + review 16 + R2 2 = 54
  assert.equal(mins(at(5), impl.eta.at), 54);
  assert.deepEqual(impl.eta.remaining.map((r) => r.stage), ['impl', 'review', 'checks']);

  // without the plan review slot, the plan lane's forecast stops at the plan alone
  setup([{ id: 'IDD-1', events: [ev('IDD-1', 'lane_open', 0)] }], '');
  const bare = buildForecast({ now });
  assert.equal(mins(at(5), lane(bare, 'IDD-1').eta.at), 5);
  assert.deepEqual(lane(bare, 'IDD-1').eta.remaining.map((r) => r.stage), ['plan']);
});

test('a lane waiting at a gate gets no time, and the wait it has stood (AC-015)', () => {
  const now = Date.parse(at(40));
  setup([
    { id: 'IDD-1', events: [ev('IDD-1', 'lane_open', 0), ev('IDD-1', 'question_batch_asked', 10, { batch_id: 'b1' })] },
    { id: 'IDD-2', events: [ev('IDD-2', 'lane_open', 0), ev('IDD-2', 's4_submit_started', 20)] },
  ]);
  const view = buildForecast({ now });
  const question = lane(view, 'IDD-1');
  assert.equal(question.now.kind, 'gate');
  assert.equal(question.now.gate, 'question');
  assert.equal(question.now.elapsedMin, 30, 'counted from the oldest unanswered question');
  assert.equal(question.eta.at, null);
  const sign = lane(view, 'IDD-2');
  assert.equal(sign.now.kind, 'gate');
  assert.equal(sign.now.gate, 'sign');
  assert.equal(sign.now.elapsedMin, 20);
  assert.equal(sign.eta.at, null);
});

test('an approved lane gets the landing as its finish (AC-016)', () => {
  const now = Date.parse(at(61));
  setup([landLane('IDD-1')]);
  const view = buildForecast({ now });
  const l = lane(view, 'IDD-1');
  assert.equal(l.now.kind, 'stage');
  assert.equal(l.now.stage, 'land');
  assert.equal(l.now.elapsedMin, 1);
  assert.equal(l.eta.stopsAt, 'end');
  assert.equal(mins(at(61), l.eta.at), 0, 'the landing usual is 0, and it is never negative');
});

test('the remaining time of an overrun stage is zero, not negative (AC-017)', () => {
  const now = Date.parse(at(25));
  setup([{ id: 'IDD-1', events: [ev('IDD-1', 'lane_open', 0)] }]);
  const l = lane(buildForecast({ now }), 'IDD-1');
  assert.equal(l.now.elapsedMin, 25);
  assert.equal(l.eta.remaining[0].stage, 'plan');
  assert.equal(l.eta.remaining[0].minutes, 0);
  assert.equal(l.eta.at, at(25));
});

test('the first review adds no fix, and a fix adds its round (AC-018)', () => {
  const now = Date.parse(at(40));
  setup([
    {
      id: 'IDD-1',
      events: [
        ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30),
        ev('IDD-1', 's2_review_started', 31, { kind: 'blind', round: 1 }),
        ev('IDD-1', 's2_review_findings', 32, { kind: 'blind', round: 1 }),
      ],
    },
    {
      id: 'IDD-2',
      events: [
        ev('IDD-2', 'lane_open', 0), ev('IDD-2', 's2_start', 2), ev('IDD-2', 's2_result', 30),
        ev('IDD-2', 's2_review_started', 31, { kind: 'blind', round: 1 }),
        ev('IDD-2', 's2_triage_done', 32, { kind: 'blind', round: 1, accepted: [] }),
        ev('IDD-2', 's2_fix_sent', 35, { round: 1 }),
      ],
    },
  ]);
  const view = buildForecast({ now });
  const review = lane(view, 'IDD-1');
  assert.equal(review.now.stage, 'review');
  // (review 16 - 10) + R2 2 = 8
  assert.equal(mins(at(40), review.eta.at), 8);
  assert.deepEqual(review.eta.remaining.map((r) => r.stage), ['review', 'checks']);
  const fix = lane(view, 'IDD-2');
  assert.equal(fix.now.stage, 'fix');
  // (fix 34 - 5) + R2 2 = 31
  assert.equal(mins(at(40), fix.eta.at), 31);
});

test('a fix round at its pass cap is unknown (AC-019)', () => {
  setup([{
    id: 'IDD-1',
    events: [
      ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30),
      ev('IDD-1', 's2_review_started', 31, { kind: 'blind', round: 1, max_fix_rounds: 1 }),
      ev('IDD-1', 's2_triage_done', 32, { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c1' }] }),
      ev('IDD-1', 's2_fix_sent', 35, { round: 1 }),
    ],
  }]);
  const l = lane(buildForecast({ now: Date.parse(at(40)) }), 'IDD-1');
  assert.equal(l.eta.at, null);
  assert.equal(l.eta.unknown, 'fix_cap');
});

test('an order wait starts at the lane ahead it waits for (AC-020)', () => {
  setup([
    {
      id: 'IDD-1',
      events: [ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30), ev('IDD-1', 's2_order_waiting', 31, { opponents: [{ lane: 'IDD-2' }] })],
    },
    landLane('IDD-2'),
  ]);
  const view = buildForecast({ now: Date.parse(at(61)) });
  const ahead = lane(view, 'IDD-2');
  const waiter = lane(view, 'IDD-1');
  assert.equal(waiter.now.kind, 'wait');
  assert.equal(waiter.now.wait, 'order');
  assert.ok(ahead.eta.at, 'the lane ahead has a finish');
  // the waiter's review and R2 start at the lane ahead's finish: review 16 + R2 2
  assert.equal(mins(ahead.eta.at, waiter.eta.at), 18);
});

test('an order wait whose lane ahead stops at a gate is that lane\'s (AC-021)', () => {
  setup([
    {
      id: 'IDD-1',
      events: [ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30), ev('IDD-1', 's2_order_waiting', 31, { opponents: [{ lane: 'IDD-2' }] })],
    },
    { id: 'IDD-2', events: [ev('IDD-2', 'lane_open', 0), ev('IDD-2', 's4_submit_started', 20)] },
  ]);
  const waiter = lane(buildForecast({ now: Date.parse(at(40)) }), 'IDD-1');
  assert.equal(waiter.eta.at, null);
  assert.deepEqual(waiter.eta.via, { lane: 'IDD-2', stopsAt: 'sign' });
});

test('a dependency that cycles or points nowhere is unknown (AC-022)', () => {
  setup([
    {
      id: 'IDD-1',
      events: [ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30), ev('IDD-1', 's2_order_waiting', 31, { opponents: [{ lane: 'IDD-3' }] })],
    },
    {
      id: 'IDD-2',
      events: [ev('IDD-2', 'lane_open', 0), ev('IDD-2', 's2_start', 2), ev('IDD-2', 's2_result', 30), ev('IDD-2', 's2_order_waiting', 31, { opponents: [{ lane: 'IDD-3' }] })],
    },
    {
      id: 'IDD-3',
      events: [ev('IDD-3', 'lane_open', 0), ev('IDD-3', 's2_start', 2), ev('IDD-3', 's2_result', 30), ev('IDD-3', 's2_order_waiting', 31, { opponents: [{ lane: 'IDD-1' }] })],
    },
  ]);
  const view = buildForecast({ now: Date.parse(at(40)) });
  for (const id of ['IDD-1', 'IDD-2', 'IDD-3']) {
    const l = lane(view, id);
    assert.equal(l.eta.at, null, `${id} has no time`);
    assert.equal(l.eta.unknown, 'dependency');
  }
  // a lane waiting on an id that is not in the backlog is unknown too
  setup([{ id: 'IDD-9', events: [ev('IDD-9', 'lane_open', 0), ev('IDD-9', 's2_start', 2), ev('IDD-9', 's2_result', 30), ev('IDD-9', 's2_order_waiting', 31, { opponents: [{ lane: 'IDD-404' }] })] }]);
  assert.equal(lane(buildForecast({ now: Date.parse(at(40)) }), 'IDD-9').eta.unknown, 'dependency');
});

test('a machine stage past twice its p75 is an anomaly (AC-023)', () => {
  setup([implLane('IDD-1')]);
  // the implementation began at 2; the initial p75 is 70, so the line is 140 minutes of elapsed time
  assert.equal(lane(buildForecast({ now: Date.parse(at(2 + 139)) }), 'IDD-1').anomaly, false);
  assert.equal(lane(buildForecast({ now: Date.parse(at(2 + 141)) }), 'IDD-1').anomaly, true);
});

test('the anomaly line is never under ten minutes (AC-024)', () => {
  setup([{
    id: 'IDD-1',
    events: [
      ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30),
      ev('IDD-1', 's2_review_started', 31, { kind: 'blind', round: 1 }),
      ev('IDD-1', 's2_triage_done', 45, { kind: 'blind', round: 1, accepted: [] }),
      ev('IDD-1', 's2_review_converged', 46),
      ev('IDD-1', 's2_device_skipped', 47),
    ],
  }]);
  const now = (m) => buildForecast({ now: Date.parse(at(m)) });
  // the initial R2 and checks p75 is 3, so twice it is 6 and the floor of 10 stands
  const view = now(46 + 6);
  const l = lane(view, 'IDD-1');
  assert.equal(l.now.stage, 'checks');
  assert.equal(view.usual[0].stages.checks.threshold, 10);
  assert.equal(l.anomaly, false, '6 minutes is under the floor');
  assert.equal(lane(now(46 + 11), 'IDD-1').anomaly, true, '11 minutes is over it');
});

test('a gate and a wait never turn red (AC-025)', () => {
  const lanes = [
    { id: 'G-Q', events: [ev('G-Q', 'lane_open', 0), ev('G-Q', 'question_batch_asked', 1, { batch_id: 'b1' })] },
    { id: 'G-GO', events: [ev('G-GO', 'lane_open', 0), ev('G-GO', 's1_ready', 1), ev('G-GO', 's1_plan_review_done', 2, { must: 0, should: 0, sent_back: false })] },
    { id: 'G-SIGN', events: [ev('G-SIGN', 'lane_open', 0), ev('G-SIGN', 's4_submit_started', 1)] },
    { id: 'G-CARD', events: [ev('G-CARD', 'lane_open', 0), ev('G-CARD', 's3_ready', 1)] },
    { id: 'W-ORDER', events: [ev('W-ORDER', 'lane_open', 0), ev('W-ORDER', 's2_start', 2), ev('W-ORDER', 's2_result', 30), ev('W-ORDER', 's2_order_waiting', 31, { opponents: [{ lane: 'G-SIGN' }] })] },
    { id: 'W-DEP', events: [ev('W-DEP', 'lane_open', 0), ev('W-DEP', 's2_start', 2), ev('W-DEP', 'blocked_by_dependency', 30, { depends_on: ['G-SIGN'] })] },
    { id: 'W-OUT', events: [ev('W-OUT', 'lane_open', 0), ev('W-OUT', 's4_pr_created', 1, { pr_number: 7 })] },
    { id: 'W-QUOTA', events: [ev('W-QUOTA', 'lane_open', 0), ev('W-QUOTA', 'claude_quota_wait', 1, { stage: 'plan' })] },
    { id: 'W-SLOT', events: [ev('W-SLOT', 'lane_open', 0), ev('W-SLOT', 's1_go', 1)] },
  ];
  setup(lanes);
  const view = buildForecast({ now: Date.parse(at(1000)) });
  for (const l of view.lanes) assert.equal(l.anomaly, false, `${l.iddId} stands at a ${l.now.kind}`);
  assert.ok(view.lanes.every((l) => l.now.kind === 'gate' || l.now.kind === 'wait'));
});

test('an answered lane is back in its stage, bound for the GO gate (AC-034)', () => {
  setup([{ id: 'IDD-1', events: [ev('IDD-1', 'lane_open', 0), ev('IDD-1', 'question_batch_asked', 5, { batch_id: 'b1' }), ev('IDD-1', 'question_batch_answered', 25, { batch_id: 'b1' })] }]);
  const l = lane(buildForecast({ now: Date.parse(at(28)) }), 'IDD-1');
  assert.equal(l.now.kind, 'stage');
  assert.equal(l.now.stage, 'plan');
  assert.equal(l.now.elapsedMin, 8, 'the plan total so far: 5 before the question + 3 after the answer');
  assert.equal(l.eta.stopsAt, 'go');
});

test('a question in the implementation is a gate that turns no lane red (AC-035)', () => {
  setup([{ id: 'IDD-1', events: [ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's1_go', 1), ev('IDD-1', 's2_start', 2), ev('IDD-1', 'question_batch_asked', 12, { batch_id: 'b1' })] }]);
  const l = lane(buildForecast({ now: Date.parse(at(1000)) }), 'IDD-1');
  assert.equal(l.now.kind, 'gate');
  assert.equal(l.now.gate, 'question');
  assert.equal(l.anomaly, false);
  assert.equal(l.eta.at, null);
});

/** a lane waiting for its first review on the lane named in a recorded order wait */
const orderWaitLane = (id, opponent) => ({
  id,
  events: [
    ev(id, 'lane_open', 0), ev(id, 's2_start', 2), ev(id, 's2_result', 30),
    ev(id, 's2_order_waiting', 31, { opponents: [{ lane: opponent }] }),
  ],
});

test('an order wait on a lane still implementing waits on it, not on its own finish (AC-001)', () => {
  setup([orderWaitLane('IDD-1', 'IDD-2'), implLane('IDD-2')]);
  const view = buildForecast({ now: Date.parse(at(5)) });
  const ahead = lane(view, 'IDD-2');
  assert.equal(ahead.now.stage, 'impl');
  assert.equal(ahead.eta.stopsAt, 'sign');
  assert.ok(ahead.eta.at, 'the implementing lane has a time to its own signature');
  const waiter = lane(view, 'IDD-1');
  assert.equal(waiter.now.kind, 'wait');
  assert.equal(waiter.now.wait, 'order');
  assert.equal(waiter.eta.at, null, "the waiter does not cross the lane ahead's signature");
  assert.equal(waiter.eta.stopsAt, 'sign');
  assert.deepEqual(waiter.eta.via, { lane: 'IDD-2', stopsAt: 'sign' });
  assert.equal(waiter.eta.unknown, undefined);
  assert.deepEqual(waiter.eta.remaining.map((r) => r.stage), ['review', 'checks']);
});

test('a dependency wait on a lane still planning waits on its GO (AC-002)', () => {
  setup([
    {
      id: 'IDD-1',
      events: [
        ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2),
        ev('IDD-1', 'blocked_by_dependency', 5, { depends_on: ['IDD-2'] }),
      ],
    },
    { id: 'IDD-2', events: [ev('IDD-2', 'lane_open', 0)] },
  ]);
  const waiter = lane(buildForecast({ now: Date.parse(at(5)) }), 'IDD-1');
  assert.equal(waiter.now.wait, 'dependency');
  assert.equal(waiter.eta.at, null);
  assert.deepEqual(waiter.eta.via, { lane: 'IDD-2', stopsAt: 'go' });
  assert.equal(waiter.eta.unknown, undefined);
  assert.deepEqual(waiter.eta.remaining.map((r) => r.stage), ['impl', 'review', 'checks']);
});

test('a chain of waits never crosses a gate (AC-004)', () => {
  setup([orderWaitLane('IDD-1', 'IDD-2'), orderWaitLane('IDD-2', 'IDD-3'), landLane('IDD-3')]);
  const view = buildForecast({ now: Date.parse(at(61)) });
  const b = lane(view, 'IDD-2');
  assert.ok(b.eta.at, 'the lane waiting on the landing has a time');
  assert.equal(b.eta.stopsAt, 'sign');
  const a = lane(view, 'IDD-1');
  assert.equal(a.eta.at, null, 'the second wait does not add its stages past the first one\'s signature');
  assert.equal(a.eta.stopsAt, 'sign');
  assert.deepEqual(a.eta.via, { lane: 'IDD-2', stopsAt: 'sign' });
});

test('a send-back opens a round the pass cap it left does not bound (AC-005)', () => {
  setup([{
    id: 'IDD-1',
    events: [
      ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30),
      ev('IDD-1', 's2_review_started', 31, { kind: 'blind', round: 1, max_fix_rounds: 2 }),
      ev('IDD-1', 's2_triage_done', 32, { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c1' }] }),
      ev('IDD-1', 's2_fix_sent', 35, { round: 1 }),
      ev('IDD-1', 's2_result', 40),
      ev('IDD-1', 's2_confirm_started', 41, { round: 1 }),
      ev('IDD-1', 's2_confirm_done', 42, { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0 }),
      ev('IDD-1', 's2_review_started', 43, { kind: 'final', round: 2 }),
      ev('IDD-1', 's2_triage_done', 44, { kind: 'final', round: 2, accepted: [] }),
      ev('IDD-1', 's2_review_converged', 45),
      ev('IDD-1', 's2_device_skipped', 46),
      ev('IDD-1', 's4_submit_started', 47),
      ev('IDD-1', 's4_verify_started', 48),
      ev('IDD-1', 's4_verify_user_judgment_answered', 50, { outcome: 'revise' }),
      ev('IDD-1', 's2_result', 55),
      ev('IDD-1', 's2_review_started', 56, { kind: 'blind', round: 3, max_fix_rounds: 2 }),
      ev('IDD-1', 's2_review_findings', 57, { kind: 'blind', round: 3 }),
      ev('IDD-1', 's2_triage_done', 58, { kind: 'blind', round: 3, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c2' }] }),
      ev('IDD-1', 's2_fix_sent', 60, { round: 3 }),
    ],
  }]);
  const l = lane(buildForecast({ now: Date.parse(at(62)) }), 'IDD-1');
  assert.equal(l.now.stage, 'fix');
  assert.equal(l.now.elapsedMin, 2, 'the send-back round is the one running');
  assert.ok(l.eta.at, 'the cap the pass left behind is not a stop for the new round');
  assert.equal(l.eta.unknown, undefined);
});

test('the cap belongs to the round it was recorded for (AC-006)', () => {
  const ROLES_MAX1 = 'pipeline:\n  review_loop: { max_fix_rounds: 1 }\n';
  setup([{
    id: 'IDD-1',
    events: [
      ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30),
      ev('IDD-1', 's2_review_started', 31, { kind: 'blind', round: 1, max_fix_rounds: 1 }),
      ev('IDD-1', 's2_triage_done', 32, { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c1' }] }),
      ev('IDD-1', 's2_fix_sent', 35, { round: 1 }),
      ev('IDD-1', 's2_result', 40),
      ev('IDD-1', 's2_confirm_started', 41, { round: 1 }),
      ev('IDD-1', 's2_confirm_done', 42, { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0 }),
      ev('IDD-1', 's2_review_started', 43, { kind: 'final', round: 2 }),
      ev('IDD-1', 's2_triage_done', 44, { kind: 'final', round: 2, accepted: [] }),
      ev('IDD-1', 's2_review_converged', 45),
      ev('IDD-1', 's2_device_skipped', 46),
      ev('IDD-1', 's4_submit_started', 47),
      ev('IDD-1', 's4_pr_created', 48, { pr_number: 7 }),
      ev('IDD-1', 's4_review_comment_received', 60, { files: ['/f.md'] }),
      ev('IDD-1', 's2_triage_started', 61, { kind: 'feedback', round: 2 }),
      ev('IDD-1', 's2_triage_done', 62, { kind: 'feedback', round: 2, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c2' }] }),
      ev('IDD-1', 's2_fix_sent', 63, { round: 2 }),
    ],
  }], ROLES_MAX1);
  const l = lane(buildForecast({ now: Date.parse(at(65)) }), 'IDD-1');
  assert.equal(l.now.stage, 'fix');
  assert.ok(l.eta.at, 'the cap the first pass left behind does not bound the feedback pass');
  assert.equal(l.eta.unknown, undefined);

  // the lane-wide cap still stops a lane that has sent eight fixes
  const many = [
    ev('IDD-2', 'lane_open', 0), ev('IDD-2', 's2_start', 2), ev('IDD-2', 's2_result', 30),
    ev('IDD-2', 's2_review_started', 31, { kind: 'blind', round: 1 }),
  ];
  for (let i = 0; i < 8; i += 1) many.push(ev('IDD-2', 's2_fix_sent', 40 + i, { round: i + 1 }));
  setup([{ id: 'IDD-2', events: many }], ROLES_MAX1);
  const capped = lane(buildForecast({ now: Date.parse(at(65)) }), 'IDD-2');
  assert.equal(capped.now.stage, 'fix');
  assert.equal(capped.eta.at, null);
  assert.equal(capped.eta.unknown, 'fix_cap');
});

test('a lane back for PR feedback is not red under the R2 floor (AC-009)', () => {
  setup([{
    id: 'IDD-1',
    events: [
      ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30),
      ev('IDD-1', 's2_review_started', 31, { kind: 'blind', round: 1, max_fix_rounds: 2 }),
      ev('IDD-1', 's2_triage_done', 39, { kind: 'blind', round: 1, accepted: [] }),
      ev('IDD-1', 's2_review_converged', 40),
      ev('IDD-1', 's2_device_skipped', 41),
      ev('IDD-1', 's4_review_comment_received', 53, { files: ['/f.md'] }),
    ],
  }]);
  const l = lane(buildForecast({ now: Date.parse(at(64)) }), 'IDD-1');
  assert.equal(l.now.stage, 'review', 'the judgement on the comments is the first review, not R2');
  assert.ok(l.now.elapsedMin >= 11, 'it has stood there past the ten minute R2 floor');
  assert.equal(l.anomaly, false, 'the R2 floor does not turn it red');
});

test('a send-back right after the cap still gets a time, and the cap itself does not (AC-013)', () => {
  const twoFixes = [
    ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 30),
    ev('IDD-1', 's2_review_started', 31, { kind: 'blind', round: 1, max_fix_rounds: 2 }),
    ev('IDD-1', 's2_triage_done', 32, { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c1' }] }),
    ev('IDD-1', 's2_fix_sent', 35, { round: 1 }),
    ev('IDD-1', 's2_result', 40),
    ev('IDD-1', 's2_confirm_started', 41, { round: 1 }),
    ev('IDD-1', 's2_confirm_done', 42, { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0 }),
    ev('IDD-1', 's2_review_started', 43, { kind: 'final', round: 2 }),
    ev('IDD-1', 's2_triage_done', 44, { kind: 'final', round: 2, accepted: [{ ref: 'F-1', severity: 'must', action: 'fix', claim: 'c2' }] }),
    ev('IDD-1', 's2_fix_sent', 45, { round: 2 }),
  ];
  setup([{ id: 'IDD-1', events: twoFixes }]);
  const capped = lane(buildForecast({ now: Date.parse(at(47)) }), 'IDD-1');
  assert.equal(capped.now.stage, 'fix');
  assert.equal(capped.eta.at, null, 'without a send-back the round is the pass cap');
  assert.equal(capped.eta.unknown, 'fix_cap');

  const sentBack = [
    ...twoFixes,
    ev('IDD-1', 's2_result', 46),
    ev('IDD-1', 's2_confirm_started', 47, { round: 2 }),
    ev('IDD-1', 's2_confirm_done', 48, { round: 2, unresolved_must: 0, unresolved_should: 0, new_blocking: 0 }),
    ev('IDD-1', 's2_review_started', 49, { kind: 'final', round: 3 }),
    ev('IDD-1', 's2_triage_done', 50, { kind: 'final', round: 3, accepted: [] }),
    ev('IDD-1', 's2_review_converged', 51),
    ev('IDD-1', 's2_device_skipped', 52),
    ev('IDD-1', 's4_submit_started', 53),
    ev('IDD-1', 's4_verify_started', 54),
    ev('IDD-1', 's4_verify_user_judgment_answered', 56, { outcome: 'revise' }),
  ];
  setup([{ id: 'IDD-1', events: sentBack }]);
  const after = lane(buildForecast({ now: Date.parse(at(58)) }), 'IDD-1');
  assert.equal(after.now.stage, 'fix');
  assert.ok(after.eta.at, 'the send-back begins a round the pass cap does not bound');
  assert.equal(after.eta.unknown, undefined);

  const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'lifecycle-IDD-092.json'), 'utf8'));
  const cut = fixture.filter((e) => Date.parse(e.at) <= Date.parse('2026-10-06T07:37:58+09:00'));
  assert.equal(fixCapReached(cut, { forForecast: true }), null, 'the forecast reads no cap right after a send-back');
  assert.ok(fixCapReached(cut), 'the loop itself still reads the cap of the pass it left');
});

test('AC-049: a lane at its hand turn forecasts without throwing, and waits at a person\'s card', () => {
  setup([{
    id: 'IDD-1',
    events: [
      ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's1_go', 1), ev('IDD-1', 's2_start', 2), ev('IDD-1', 's2_result', 3),
      ev('IDD-1', 's2_review_started', 4, { kind: 'blind', round: 1, depth: 'standard', max_fix_rounds: 2, close_on: 'must' }),
      ev('IDD-1', 's2_triage_done', 5, { kind: 'blind', round: 1, accepted: [] }),
      ev('IDD-1', 's2_review_started', 6, { kind: 'kept', round: 1 }),
      ev('IDD-1', 's2_triage_done', 7, { kind: 'kept', round: 1, accepted: [] }),
      ev('IDD-1', 's2_review_escalated', 8, { reason: 'r' }),
      ev('IDD-1', 's2_review_resumed', 9, { decision: 'hand_fix' }),
    ],
  }]);
  const view = buildForecast({ now: Date.parse(at(10)) });
  const l = lane(view, 'IDD-1');
  assert.equal(l.now.kind, 'gate');
  assert.equal(l.now.gate, 'card');
  assert.equal(l.eta.at, null, 'a person\'s card is not predicted past');
});

// ---- IDD-133: the windows observation reaches the open lane's forecast ----

/** the runner's reading of the windows: a block while they hold, null when they let a lane start */
const windows = (block) => ({ deliver: async () => {}, quotaBlock: () => block });

test('an open lane waits for the windows in the forecast only while the observation holds it (AC-003)', () => {
  setup([{
    id: 'IDD-1',
    events: [ev('IDD-1', 'lane_open', 0), ev('IDD-1', 's1_go', 1), ev('IDD-1', 's2_start', 2), ev('IDD-1', 'claude_quota_wait', 20, { stage: 'executor', resets_at: 1 })],
  }]);
  const now = Date.parse(at(30));
  setAgentRunner(windows({ reason: 'windows', resetsAt: 1 }));
  const held = lane(buildForecast({ now }), 'IDD-1');
  assert.equal(held.now.kind, 'wait');
  assert.equal(held.now.wait, 'quota');
  assert.equal(held.eta.at, null, 'a wait gives no time');
  setAgentRunner(windows(null));
  const freed = lane(buildForecast({ now }), 'IDD-1');
  assert.equal(freed.now.kind, 'stage');
  assert.equal(freed.now.stage, 'impl');
  assert.ok(freed.eta.at, 'the implementation runs to its gate');
  setAgentRunner(null);
});

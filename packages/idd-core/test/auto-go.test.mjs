import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoGoDecision, runAutoGo } from '../src/plan/auto-go.ts';

const made = [];
const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved.state === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved.state;
  if (saved.repos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved.repos;
});

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: '2026-10-01T00:00:00Z', attrs });
const purpose = (over = {}) => ({ id: 'P-1', statement: 's', origin: 'O', status: 'proposed', raised: { by: { lane: 'IDD-1' }, at: '' }, ...over });
const choice = (over = {}) => ({ id: 'DEC-100', purpose: 'P-1', forms: {}, place: [{ kind: 'file', path: 'a.ts' }], why: '', anchored: '', free: '', status: 'active', origin: 'x', history: [], waives: [], ...over });
const base = { lane: 'IDD-1', events: [ev('s1_ready', { depth: 'shallow' }), ev('s1_plan_review_done', { must: 0 })], depth: 'shallow', purposes: [], choices: [], rows: [] };

test('a shallow lane with no marks is auto (AC-018)', () => {
  assert.deepEqual(autoGoDecision(base), { auto: true });
});

test('a shallow lane whose review still raised a must in the last allowed round is left to a person', () => {
  const round = [ev('s1_plan_review_started'), ev('s1_plan_review_done', { must: 1, sent_back: true }), ev('s1_ready', { depth: 'shallow' })];
  const events = [ev('s1_ready', { depth: 'shallow' }), ...round, ...round];
  const d = autoGoDecision({ ...base, events });
  assert.equal(d.auto, false);
  assert.match(d.reason, /査読/);
});

test('a lane whose planner asked a question is left to a person (AC-019)', () => {
  const input = { ...base, events: [...base.events, ev('question_batch_asked')] };
  const d = autoGoDecision(input);
  assert.equal(d.auto, false);
  assert.match(d.reason, /質問/);
});

test('a lane with an unconfirmed Purpose it raised is left to a person (AC-020)', () => {
  const d = autoGoDecision({ ...base, purposes: [purpose()] });
  assert.equal(d.auto, false);
  assert.match(d.reason, /Purpose/);
  // another lane's Purpose does not stop it
  assert.equal(autoGoDecision({ ...base, purposes: [purpose({ raised: { by: { lane: 'IDD-2' }, at: '' } })] }).auto, true);
  // one raised by a session outside the lane does not either
  assert.equal(autoGoDecision({ ...base, purposes: [purpose({ raised: { by: { session: 's1' }, at: '' } })] }).auto, true);
  // a confirmed Purpose does not either
  assert.equal(autoGoDecision({ ...base, purposes: [purpose({ status: 'active' })] }).auto, true);
});

test('a lane that would supersede a root or dir Choice is left to a person (AC-021)', () => {
  const dirChoice = choice({ place: [{ kind: 'dir', path: 'lib' }] });
  const rows = [{ event: 'choice_raised', at: '', repo: 'me/app', by: { lane: 'IDD-1' }, supersedes: [{ id: 'DEC-100', grounds: 'g' }] }];
  const d = autoGoDecision({ ...base, choices: [dirChoice], rows });
  assert.equal(d.auto, false);
  assert.match(d.reason, /Supersede/);
  // a file choice is not a stop
  const fileRows = [{ event: 'choice_raised', at: '', repo: 'me/app', by: { lane: 'IDD-1' }, supersedes: [{ id: 'DEC-100', grounds: 'g' }] }];
  assert.equal(autoGoDecision({ ...base, choices: [choice()], rows: fileRows }).auto, true);
  // another lane's supersede is not this lane's
  assert.equal(autoGoDecision({ ...base, choices: [dirChoice], rows: [{ ...rows[0], by: { lane: 'IDD-2' } }] }).auto, true);
});

test("AC-004: a row that points at a standing successor is the same gate", () => {
  const dirChoice = choice({ place: [{ kind: 'dir', path: 'lib' }] });
  const rows = [{ event: 'choice_superseded', at: '', repo: 'me/app', by: { lane: 'IDD-1' }, id: 'C-2-1', supersedes: [{ id: 'DEC-100', grounds: 'g' }] }];
  const d = autoGoDecision({ ...base, choices: [dirChoice], rows });
  assert.equal(d.auto, false);
  assert.match(d.reason, /Supersede/);
  // a file choice is not a stop
  assert.equal(autoGoDecision({ ...base, choices: [choice()], rows }).auto, true);
  // another lane's replacement is not this lane's
  assert.equal(autoGoDecision({ ...base, choices: [dirChoice], rows: [{ ...rows[0], by: { lane: 'IDD-2' } }] }).auto, true);
});

test('an old (docs) lane\'s impact row that changes a root or dir DEC\'s Why no longer stops the GO: the docs shape is retired (2026-10-22)', () => {
  const dirChoice = choice({ place: [{ kind: 'root', path: '/' }], status: 'unconfirmed' });
  const events = [ev('s1_ready', { depth: 'shallow', intent_impact: { rows: [{ id: 'DEC-100', effect: 'change_why', reason: 'r' }] } }), ev('s1_plan_review_done', { must: 0 })];
  assert.equal(autoGoDecision({ ...base, events, choices: [dirChoice] }).auto, true);
});

test('a plan that has not finished its review is left to a person (AC-022)', () => {
  // the slot was never declared: no done record
  assert.equal(autoGoDecision({ ...base, events: [ev('s1_ready', { depth: 'shallow' })] }).auto, false);
  // every run failed
  assert.equal(autoGoDecision({ ...base, events: [ev('s1_ready', { depth: 'shallow' }), ev('s1_plan_review_done', { failed: true })] }).auto, false);
  // one run finished: it may go
  assert.equal(autoGoDecision({ ...base, events: [ev('s1_ready', { depth: 'shallow' }), ev('s1_plan_review_done', { failed: true }), ev('s1_plan_review_done', { must: 0 })] }).auto, true);
});

test('a revised plan whose re-review failed is left to a person', () => {
  // a review of the plan from before penne sent it back does not stand in for the revised one
  const sentBack = [
    ev('s1_ready', { depth: 'shallow' }), ev('s1_plan_review_started', { run_ids: ['r1'] }), ev('s1_plan_review_done', { must: 0 }),
    ev('s1_revise_requested', { instruction: 'split the DEC' }), ev('s1_ready', { depth: 'shallow' }),
  ];
  assert.equal(autoGoDecision({ ...base, events: sentBack }).auto, false);
  // the re-review failing keeps it at a person, the earlier success notwithstanding
  const failedReReview = [...sentBack, ev('s1_plan_review_started', { run_ids: ['r2'] }), ev('s1_plan_review_done', { failed: true })];
  assert.equal(autoGoDecision({ ...base, events: failedReReview }).auto, false);
  // the re-review finishing clean lets it go
  assert.equal(autoGoDecision({ ...base, events: [...failedReReview, ev('s1_plan_review_done', { must: 0, should: 0 })] }).auto, true);
});

test('a plan the review loop sent back and the planner re-readied is left to a person', () => {
  // must findings went back to the planner; the plan changed at the re-ready, without a second review
  const events = [
    ev('s1_ready', { depth: 'shallow' }), ev('s1_plan_review_started', { run_ids: ['r1'] }),
    ev('s1_plan_review_done', { must: 1, sent_back: true }), ev('s1_ready', { depth: 'shallow' }),
  ];
  assert.equal(autoGoDecision({ ...base, events }).auto, false);
});

test('a standard, a deep and an undeclared lane are never auto (AC-023)', () => {
  for (const depth of ['standard', 'deep']) {
    const d = autoGoDecision({ ...base, depth });
    assert.equal(d.auto, false, depth);
  }
});

/** a lane waiting at GO whose ready declared a depth, with a worktree whose qa reads Low */
function setup({ depth = 'shallow', extra = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'idd-autogo-'));
  made.push(root);
  const state = join(root, 'state'); mkdirSync(state);
  const wt = join(root, 'wt'); mkdirSync(join(wt, '_docs/qa/Demo/idd-1'), { recursive: true });
  writeFileSync(join(wt, '_docs/qa/Demo/idd-1/qa.md'), '---\nrisk: Low\n---\n\nbody\n');
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: {} }));
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_REPOS_FILE = join(root, 'repos.yaml');
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'p1', worktree_path: wt }) + '\n');
  const events = [
    ev('lane_open'), ev('s1_ready', { depth }), ev('s1_plan_review_started', { run_ids: ['r'] }), ev('s1_plan_review_done', { must: 0 }),
    ...extra,
  ];
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state, wt };
}

function lifecycle(state) {
  const file = readdirSync(state).find((f) => f.startsWith('lifecycle-'));
  return readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('the engine records the GO of a shallow lane with at_by auto, once (AC-018)', async () => {
  const { state } = setup();
  const r = await runAutoGo();
  assert.deepEqual(r.recorded, ['IDD-1']);
  const go = lifecycle(state).find((e) => e.event === 's1_go');
  assert.equal(go.attrs.at_by, 'auto');
  assert.ok(go.attrs.reason);
  // a second run records nothing
  assert.deepEqual((await runAutoGo()).recorded, []);
  assert.equal(lifecycle(state).filter((e) => e.event === 's1_go').length, 1);
});

test('a question and a failed review keep the shallow lane at GO (AC-019, AC-022)', async () => {
  {
    const { state } = setup({ extra: [ev('question_batch_asked', { batch_id: 'b1' })] });
    assert.deepEqual((await runAutoGo()).recorded, []);
    assert.ok(!lifecycle(state).some((e) => e.event === 's1_go'));
  }
  {
    const root = mkdtempSync(join(tmpdir(), 'idd-autogo2-'));
    made.push(root);
    const state = join(root, 'state'); mkdirSync(state);
    const wt = join(root, 'wt'); mkdirSync(join(wt, '_docs/qa/Demo/idd-1'), { recursive: true });
    writeFileSync(join(wt, '_docs/qa/Demo/idd-1/qa.md'), '---\nrisk: Low\n---\n\nbody\n');
    writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: {} }));
    process.env.IDD_STATE_DIR = state; process.env.IDD_REPOS_FILE = join(root, 'repos.yaml');
    writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', title: 'T', area: 'Demo' }) + '\n');
    writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'p1', worktree_path: wt }) + '\n');
    writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('lane_open'), ev('s1_ready', { depth: 'shallow' }), ev('s1_plan_review_started', { run_ids: ['r'] }), ev('s1_plan_review_done', { failed: true })].map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.deepEqual((await runAutoGo()).recorded, []);
    assert.ok(!lifecycle(state).some((e) => e.event === 's1_go'));
  }
});

test('a standard lane is left at GO (AC-023)', async () => {
  const { state } = setup({ depth: 'standard' });
  assert.deepEqual((await runAutoGo()).recorded, []);
  assert.ok(!lifecycle(state).some((e) => e.event === 's1_go'));
});

test('the engine leaves a shallow lane whose revised plan failed its re-review at GO', async () => {
  const { state } = setup({ extra: [
    ev('s1_revise_requested', { instruction: 'split the DEC' }), ev('s1_ready', { depth: 'shallow' }),
    ev('s1_plan_review_started', { run_ids: ['r2'] }), ev('s1_plan_review_done', { failed: true, error: 'x' }),
  ] });
  assert.deepEqual((await runAutoGo()).recorded, []);
  assert.ok(!lifecycle(state).some((e) => e.event === 's1_go'));
});

/** a lane's own purpose column row, as the intent door writes it (the raiser is the record's own `by`) */
const purposeRow = (by, over = {}) => ({ event: 'purpose_raised', at: '2026-10-01T00:00:00Z', repo: 'Demo', by, id: 'P-1', statement: 'S', origin: 'O', status: 'proposed', ...over });

test('a shallow lane whose own Purpose waits for the GO stays at GO with no auto GO and no error (AC-020, AC-024, DEC-113-6)', async () => {
  const { state } = setup();
  writeFileSync(join(state, 'intent-Demo.jsonl'), JSON.stringify(purposeRow({ lane: 'IDD-1' })) + '\n');
  const r = await runAutoGo();
  assert.deepEqual(r.recorded, []);
  assert.deepEqual(r.errors, [], 'the write side is never reached: the engine reads the same proposals it must confirm');
  assert.ok(!lifecycle(state).some((e) => e.event === 's1_go'));
});

test('a Purpose raised by a session outside the lane does not hold the auto GO (AC-020, DEC-113-6)', async () => {
  const { state } = setup();
  writeFileSync(join(state, 'intent-Demo.jsonl'), JSON.stringify(purposeRow({ session: 's1' })) + '\n');
  const r = await runAutoGo();
  assert.deepEqual(r.recorded, ['IDD-1']);
  assert.deepEqual(r.errors, []);
  assert.equal(lifecycle(state).filter((e) => e.event === 's1_go').length, 1);
});

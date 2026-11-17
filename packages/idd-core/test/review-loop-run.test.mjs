import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { runReviewLoop, fixEnvelopeId } from '../src/plan/review-loop.ts';
import { lanesAwaitingCheck } from '../src/plan/review.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { appendLifecycle, queueEnvelope } from '../src/ledger/write.ts';
import { LANE_GATE_FILE, LANE_GATE_STALE_MS } from '../src/ledger/gate.ts';
import lockfile from 'proper-lockfile';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { REVIEW_LANE_LINE, normText } from '../src/plan/harness-norms.ts';
import { tmpDir } from './helpers/tmp.mjs';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });

function setup(pipelineYaml) {
  const state = tmpDir('idd-loop-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipelineYaml}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-loop-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

function worktreeOf(state) {
  return JSON.parse(readFileSync(join(state, 'executor-sessions.jsonl'), 'utf8').trim().split('\n')[0]).worktree_path;
}
function commitIn(wt, name = 'a.txt') {
  writeFileSync(join(wt, name), `${Date.now()}-${Math.random()}`);
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'fix']);
}
function headOf(wt) {
  return execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
test('without review slots the loop is skipped and the lane goes on to S3', async () => {
  setup('  executor: { role: r }\n');
  setAgentRunner({ deliver: async () => {} });
  assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), []);
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(reviewLoopState(readLifecycle()).state, 'done');
  assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), ['IDD-001']);
  setAgentRunner(null);
});

test('a converged lane stopped for its budget waits for penne before S3', async () => {
  setup('  executor: { role: r }\n');
  setAgentRunner({ deliver: async () => {} });
  await runReviewLoop();
  await runReviewLoop();
  assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), ['IDD-001']);
  await appendLifecycle('lane_over_budget', 'IDD-001', { cost: 5.2, limit: 5, parts: [] });
  assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), []);
  await appendLifecycle('lane_budget_extended', 'IDD-001', { limit: 10 });
  assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), ['IDD-001']);
  setAgentRunner(null);
});

test('one lap: blind → triage → fix to the executor → confirm → final → converge', async () => {
  const state = setup('  review_blind: { roles: [r, r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  // the delivery's plan is on record for this lane: no judging stage may be handed it (AC-010)
  const planPath = join(state, 'pipeline', 'fix-plan', 'IDD-001', 'E-1.md');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8') + [
    ev('fix_plan_started', { envelope_id: 'E-1', run_id: 'P-1' }),
    ev('fix_plan_done', { envelope_id: 'E-1', run_id: 'P-1', plan_path: planPath }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const started = [];
  const inputs = {};
  const norms = {};
  const iddNorms = {};
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      started.push(o.stage);
      inputs[o.stage] = o.inputs;
      norms[o.stage] = o.norms;
      iddNorms[o.stage] = o.iddNorms;
      const ids = o.stage === 'blind' || o.stage === 'final' ? [`${o.stage}-a`, `${o.stage}-b`] : [`${o.stage}-1`];
      for (const id of ids) status[id] = { state: 'running' };
      return { runIds: ids };
    },
    reviewRunStatus: (id) => status[id],
  });
  const step = () => runReviewLoop();
  const last = () => readLifecycle().at(-1).event;

  await step(); assert.equal(last(), 's2_review_started');
  assert.equal(deriveStage(readLifecycle()).blockedBy, 'レビュー中（1 巡目）');
  status['blind-a'] = { state: 'done', reportJson: '/a.json', reportMd: '/a.md', findings: [{ severity: 'must', path: 'a.ts', claim: 'x', evidence: '' }] };
  await step(); assert.equal(last(), 's2_review_started', 'waits for every blind run');
  status['blind-b'] = { state: 'failed', error: 'timeout' };
  await step(); assert.equal(last(), 's2_review_findings', 'a failed blind run does not block the round');
  await step(); assert.equal(last(), 's2_triage_started');
  status['triage-1'] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [
    { ref: 'F-1', verdict: 'accept', severity: 'must', claim: '購読が残る', path: 'a.ts', fix: '画面を離れたら購読が止まっていること' },
    { ref: 'F-2', verdict: 'accept', severity: 'should', claim: 'テストが検出しない', path: 'a_test.ts', fix: '退行で赤になること' },
    { ref: 'F-3', verdict: 'reject', severity: 'should', claim: '命名', reason: '規約どおり' },
    { ref: 'F-4', verdict: 'accept', severity: 'nit', claim: 'コメントの言い回し', path: 'a.ts' },
  ] };
  await step(); assert.equal(last(), 's2_triage_done');
  await step(); assert.equal(last(), 's2_fix_sent');
  const xml = readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');
  assert.match(readFileSync(join(state, 'outbox.jsonl'), 'utf8'), /"type":"review_fix"/);
  assert.match(xml, /画面を離れたら購読が止まっていること/);
  assert.doesNotMatch(xml, /命名/);
  assert.doesNotMatch(xml, /コメントの言い回し/, 'an accepted nit is recorded but not sent to the executor');
  await step(); assert.equal(last(), 's2_fix_sent', 'waits for the executor');
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  await step(); assert.equal(last(), 's2_confirm_started');
  status['confirm-1'] = { state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'F-1', resolved: true }, { ref: 'F-2', resolved: true }] };
  await step(); assert.equal(last(), 's2_confirm_done');
  // an S2 confirm checks only the must / should sent to the fix: it is handed that ref list, and the nit it leaves out is not unresolved
  assert.match(inputs.confirm[0], /confirm-1\.md$/);
  assert.deepEqual(inputs.confirm.slice(1), ['/t.md']);
  assert.deepEqual(readLifecycle().at(-1).attrs.unresolved_refs, []);
  assert.equal(readLifecycle().at(-1).attrs.unresolved_requests, undefined);
  await step(); assert.equal(last(), 's2_review_started');
  assert.equal(readLifecycle().at(-1).attrs.kind, 'final');
  status['final-a'] = { state: 'done', reportJson: '/f.json', reportMd: '/f.md', findings: [] };
  status['final-b'] = { state: 'done', reportJson: '/g.json', reportMd: '/g.md', findings: [] };
  await step(); await step();
  status['triage-1'] = { state: 'done', reportJson: '/t2.json', reportMd: '/t2.md', decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'should', claim: '実質 nit', fix: 'f' }] };
  await step(); await step();
  assert.equal(last(), 's2_review_converged');
  await step(); assert.equal(last(), 's2_device_skipped');
  assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), ['IDD-001']);
  assert.deepEqual(started, ['blind', 'triage', 'confirm', 'final', 'triage']);
  // every stage of the lane's own loop is told the harness's band line and its source-TODO point, as the definition writes them
  for (const stage of ['blind', 'triage', 'confirm', 'final']) {
    assert.deepEqual(norms[stage], [REVIEW_LANE_LINE, normText('todo-source')], stage);
    assert.ok(!inputs[stage].includes(planPath), `${stage} is not handed the plan the delivery wrote`);
    assert.ok(!inputs[stage].some((p) => p.includes('fix-plan')), `${stage} is not handed the plan's file`);
  }
  setAgentRunner(null);
});

test('an escalating triage raises a stuck card, and penne can continue with a note', async () => {
  const state = escalatingLane();
  setAgentRunner({ deliver: async () => {} });
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_escalated');
  assert.equal(deriveStage(readLifecycle()).decision, 'stuck');
  await appendLifecycle('s2_review_resumed', 'IDD-001', { decision: 'continue', note: '仕様は A 案で' });
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_fix_sent');
  const xml = readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');
  assert.match(xml, /仕様は A 案で/);
  setAgentRunner(null);
});

/** a lane whose round's triage left a claim for penne: the loop stops at the card */
function escalatingLane() {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8') + [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f' }, { ref: 'F-2', severity: 'should', claim: 'd', fix: 'g' }], escalated_claims: ['仕様が決まっていない'] }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}
const stops = () => readLifecycle().filter((e) => e.event === 's2_review_escalated');

test("AC-005: a stop is written once: the judge's notes after it make no new stop", async () => {
  escalatingLane();
  setAgentRunner({ deliver: async () => {} });
  await runReviewLoop();
  assert.equal(stops().length, 1);
  await seedLifecycle('s2_shape_started', 'IDD-001', { run_id: 'J1', round: 1, trigger: 'escalated' });
  await runReviewLoop();
  await seedLifecycle('s2_shape_judged', 'IDD-001', { run_id: 'J1', round: 1, trigger: 'escalated', recommendation: { choice: 'replan' } });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(stops().length, 1, 'the notes the judge left after the stop are not a new stop');
  assert.equal(readLifecycle().at(-1).event, 's2_shape_judged');
  setAgentRunner(null);
});

test("AC-006: a person's answer that lands while the tick is under way is not followed by a stop for the card it answered", async () => {
  const state = escalatingLane();
  setAgentRunner({ deliver: async () => {} });
  // the lane gate is held by the answer being written: the tick has read its rows and waits to write the stop
  const gate = join(state, LANE_GATE_FILE);
  writeFileSync(gate, '');
  const release = await lockfile.lock(gate, { stale: LANE_GATE_STALE_MS });
  const tick = runReviewLoop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await appendLifecycle('s2_review_resumed', 'IDD-001', { decision: 'continue', note: '仕様は A 案で' });
  await release();
  await tick;
  assert.equal(stops().length, 0, 'the stop the tick had decided on is not written after the answer');
  assert.equal(readLifecycle().at(-1).event, 's2_review_resumed', 'the answer is the last row');
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_fix_sent', 'the next step goes on from the answer');
  setAgentRunner(null);
});

test('a lane that resumed a stored fix sends the fix once, not on every tick', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  // the escalation carried the state the fix is sent from: the lane stopped while the fix went out, and penne's
  // continue put the lane back on that state
  for (const [event, attrs] of [
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f' }], rejected: [] }],
    ['s2_review_escalated', { reason: 'レビューの段を起動できない', retry_state: { state: 'send_fix', round: 2 } }],
    ['s2_review_resumed', { decision: 'continue', note: '続けて' }],
  ]) await seedLifecycle(event, 'IDD-001', attrs);
  setAgentRunner({ deliver: async () => {} });
  const fixes = () => readLifecycle().filter((e) => e.event === 's2_fix_sent');
  const envelopes = () => readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'review_fix');
  await runReviewLoop();
  assert.equal(fixes().length, 1, 'the resumed lane sends the fix it was stopped at');
  assert.deepEqual(fixes()[0].attrs.refs, ['F-1']);
  assert.equal(envelopes().length, 1, 'the fix goes out once');
  await runReviewLoop();
  assert.equal(fixes().length, 1, 'the fix is not sent again on the next tick');
  assert.equal(envelopes().length, 1, 'no second envelope goes out');
  setAgentRunner(null);
});

test('a fix whose record did not land is sent once, not on every tick', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  for (const [event, attrs] of [
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }],
    ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }],
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f' }], rejected: [] }],
  ]) await seedLifecycle(event, 'IDD-001', attrs);
  // the tick that sent the fix queued it and then failed before its record landed: the round's id is what the retry reads
  const id = fixEnvelopeId('IDD-001', 1);
  await queueEnvelope('IDD-001', 'review_fix', '<instruction>先に積んだ指示</instruction>', { envelopeId: id });
  setAgentRunner({ deliver: async () => {} });
  await runReviewLoop();
  const fixes = readLifecycle().filter((e) => e.event === 's2_fix_sent');
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].attrs.envelope_id, id, 'the record names the instruction already in the outbox');
  const rows = readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'review_fix');
  assert.equal(rows.length, 1, 'the retry does not stack a second instruction');
  assert.deepEqual(readdirSync(join(state, 'outbox')), [`${id}.xml`]);
  setAgentRunner(null);
});

test('a round after the lane went back to its plan sends its own fix, not the one the same round number sent before', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const round1 = (claim) => [
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }],
    ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }],
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim, fix: 'f' }], rejected: [] }],
  ];
  // the first plan's round 1 sent its fix; then penne sent the lane back to its plan and its rounds started again
  await seedLifecycle('s1_go', 'IDD-001', { at_by: 'user' });
  await seedLifecycle('s2_start', 'IDD-001', { executor_session_id: 's1' });
  await seedLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  for (const [event, attrs] of round1('前の計画の指摘')) await seedLifecycle(event, 'IDD-001', attrs);
  const before = await queueEnvelope('IDD-001', 'review_fix', '<instruction>前の計画の 1 巡目の指示</instruction>', { envelopeId: fixEnvelopeId('IDD-001', 1) });
  await seedLifecycle('s2_fix_sent', 'IDD-001', { round: 1, refs: ['1-blind/F-1'], envelope_id: before });
  await seedLifecycle('s1_replan_requested', 'IDD-001', { rounds: 1, at_by: 'user' });
  await seedLifecycle('s1_go', 'IDD-001', { at_by: 'user' });
  await seedLifecycle('s2_start', 'IDD-001', { executor_session_id: 's2' });
  await seedLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  for (const [event, attrs] of round1('作り直した計画の指摘')) await seedLifecycle(event, 'IDD-001', attrs);
  setAgentRunner({ deliver: async () => {} });
  await runReviewLoop();
  setAgentRunner(null);
  const fixes = readLifecycle().filter((e) => e.event === 's2_fix_sent');
  assert.equal(fixes.length, 2, 'the new round 1 records its own fix');
  const after = fixes.at(-1).attrs.envelope_id;
  assert.notEqual(after, before, 'the new round names another envelope than the one sent before the plan was redone');
  const rows = readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'review_fix');
  assert.deepEqual(rows.map((r) => r.envelope_id), [before, after], 'the new instruction is queued beside the old one');
  assert.match(readFileSync(join(state, 'outbox', `${after}.xml`), 'utf8'), /作り直した計画の指摘/, 'the new body carries the new round\'s findings');
});

test('queueing the same named envelope twice leaves one row and one body', async () => {
  const state = setup('  executor: { role: r }\n');
  const first = await queueEnvelope('IDD-001', 'review_fix', '<first/>', { envelopeId: 'fix-IDD-001-r1' });
  const second = await queueEnvelope('IDD-001', 'review_fix', '<second/>', { envelopeId: 'fix-IDD-001-r1' });
  assert.equal(first, 'fix-IDD-001-r1');
  assert.equal(second, first);
  assert.equal(readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(readdirSync(join(state, 'outbox')), ['fix-IDD-001-r1.xml']);
  assert.equal(readFileSync(join(state, 'outbox', 'fix-IDD-001-r1.xml'), 'utf8'), '<first/>', 'the body that was queued first stands');
});

test('a question on the final review with only nits accepted: penne\'s continue converges without a fix', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const nits = Array.from({ length: 5 }, (_, i) => ({ ref: `F-${i + 1}`, severity: 'nit', claim: `言い回し ${i + 1}`, path: 'a.py', fix: 'f' }));
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8') + [
    ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['f'] }),
    ev('s2_review_findings', { kind: 'final', round: 2, files: ['/f.json'] }),
    ev('s2_triage_started', { kind: 'final', round: 2, run_id: 't' }),
    ev('s2_triage_done', { kind: 'final', round: 2, accepted: nits, escalated_claims: ['既定値を変えるかは仕様次第'] }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  setAgentRunner({ deliver: async () => {} });
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_escalated');
  await appendLifecycle('s2_review_resumed', 'IDD-001', { decision: 'continue', note: '' });
  await runReviewLoop();
  const names = readLifecycle().map((e) => e.event);
  assert.equal(names.at(-1), 's2_review_converged');
  assert.ok(!names.includes('s2_fix_sent'), 'no fix round for nits');
  assert.ok(!existsSync(join(state, 'outbox')) || !readdirSync(join(state, 'outbox')).length, 'nothing is sent to the executor');
  setAgentRunner(null);
});

const liveRunner = () => {
  const started = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o.stage); const id = `${o.stage}-${started.length}`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  return { started, status, id: () => `${started.at(-1)}-${started.length}` };
};

test('a first blind judged within the limit with no fix converges without the final review of the same code', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const wt = worktreeOf(state);
  const r = liveRunner();
  await runReviewLoop();
  const blind = readLifecycle().at(-1);
  assert.equal(blind.event, 's2_review_started');
  assert.equal(blind.attrs.head, headOf(wt), 'the blind records the head it reads');
  r.status[r.id()] = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] };
  await runReviewLoop(); await runReviewLoop();
  r.status[r.id()] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'nit', claim: '言い回し', path: 'a.ts' }] };
  await runReviewLoop();
  await runReviewLoop();
  const last = readLifecycle().at(-1);
  assert.equal(last.event, 's2_review_converged');
  assert.match(String(last.attrs.final_skipped), /最後のレビュー/);
  assert.deepEqual(r.started, ['blind', 'triage']);
  setAgentRunner(null);
});

test('the final review still runs after a mapped first round, or when the code moved since the blind', async () => {
  for (const variant of ['mapped', 'moved']) {
    const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
    const wt = worktreeOf(state);
    const head = headOf(wt);
    const mapped = variant === 'mapped' ? { mapped_routes: 1, whole_run_ids: ['B'] } : {};
    for (const [event, attrs] of [['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B', 'P'], head, ...mapped }], ['s2_review_findings', { kind: 'blind', round: 1, files: [] }],
      ['s2_triage_started', { kind: 'blind', round: 1, run_id: 'T' }], ['s2_triage_done', { kind: 'blind', round: 1, accepted: [], rejected: [] }]]) await seedLifecycle(event, 'IDD-001', attrs);
    if (variant === 'moved') commitIn(wt);
    const r = liveRunner();
    await runReviewLoop();
    assert.equal(readLifecycle().at(-1).event, 's2_review_started', variant);
    assert.equal(readLifecycle().at(-1).attrs.kind, 'final', variant);
    assert.deepEqual(r.started, ['final'], variant);
    setAgentRunner(null);
  }
});

test('the device check of a converged lane is not handed the harness\'s rules over the repo\'s', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n  device_check: { role: r }\n');
  // the device stage runs only for a lane whose qa.md declares a judge and whose compare/ has pictures
  const wt = worktreeOf(state);
  const dir = join(wt, '_docs', 'qa', 'Demo', 'idd-001');
  mkdirSync(join(dir, 'compare'), { recursive: true });
  writeFileSync(join(dir, 'qa.md'), '- 全体: 画面が設計どおりに見える（判定: 絵を見る役）\n- AC-001: x\n');
  writeFileSync(join(dir, 'compare', 'home-impl.png'), 'x');
  writeFileSync(join(dir, 'compare', 'home-proto.png'), 'x');
  commitIn(wt, 'pictures.png');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8') + JSON.stringify(ev('s2_review_converged')) + '\n');
  const started = [];
  setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { started.push(o); return { runIds: ['D'] }; }, reviewRunStatus: () => ({ state: 'running' }) });
  await runReviewLoop();
  assert.deepEqual(started.map((o) => o.stage), ['device']);
  assert.equal(started[0].norms, undefined);
  assert.equal(started[0].iddNorms, undefined);
  setAgentRunner(null);
});

test('a lane with no worktree on record waits for a blind slot without counting a start failure', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  writeFileSync(join(state, 'backlog.jsonl'), readFileSync(join(state, 'backlog.jsonl'), 'utf8') + JSON.stringify({ idd_id: 'IDD-002', title: 'U', area: 'Demo', context: '' }) + '\n');
  // only the other lane has a worktree, and it holds the slot
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-002', executor_session_id: 'E2', worktree_path: '/nonexistent' }) + '\n');
  for (const [event, attrs] of [['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }], ['s2_review_findings', { kind: 'blind', round: 1, files: [] }], ['s2_triage_done', { kind: 'blind', round: 1, accepted: [], rejected: [] }]]) await seedLifecycle(event, 'IDD-001', attrs);
  for (const [event, attrs] of [['s1_go', {}], ['s2_start', {}], ['s2_result', {}], ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['X'] }]]) await seedLifecycle(event, 'IDD-002', attrs);
  setAgentRunner({ deliver: async () => {}, startReviewRun: async () => ({ runIds: ['Y'] }), reviewRunStatus: () => ({ state: 'running' }) });
  await runReviewLoop();
  assert.deepEqual(readLifecycle().filter((e) => e.idd_id === 'IDD-001' && e.event === 's2_review_run_failed').map((e) => e.attrs.error), []);
  setAgentRunner(null);
});

test('the final review runs after a first blind that only some roles finished', async () => {
  const state = setup('  review_blind: { roles: [r, r, r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const head = headOf(worktreeOf(state));
  for (const [event, attrs] of [['s2_review_started', { kind: 'blind', round: 1, run_ids: ['A', 'B', 'C'], head }], ['s2_review_findings', { kind: 'blind', round: 1, files: ['/c.json'], failed_runs: 2 }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 'T' }], ['s2_triage_done', { kind: 'blind', round: 1, accepted: [], rejected: [] }]]) await seedLifecycle(event, 'IDD-001', attrs);
  const r = liveRunner();
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_started');
  assert.equal(readLifecycle().at(-1).attrs.kind, 'final');
  assert.deepEqual(r.started, ['final']);
  setAgentRunner(null);
});

test('a second tick while one runs is skipped, and a broken plan review report does not stop the tick', async () => {
  setup('  executor: { role: r }\n');
  const { runTick } = await import('../src/plan/tick.ts');
  let release;
  setAgentRunner({ deliver: async () => {}, planReviewStatus: () => { throw new Error('bad json'); } });
  const lockfile = (await import('proper-lockfile')).default;
  const { stateDir } = await import('../src/paths.ts');
  writeFileSync(join(stateDir(), 'tick.lock'), '');
  release = await lockfile.lock(join(stateDir(), 'tick.lock'));
  assert.deepEqual(await runTick({ intake: false }), { skipped: 'another tick is running' });
  await release();
  const { runPlanReview } = await import('../src/plan/plan-review.ts');
  // a lane still in S1: the shared setup made one past GO, so start this one over
  writeFileSync(join(stateDir(), 'lifecycle-Demo.jsonl'), [ev('lane_open'), ev('s1_ready')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(stateDir(), 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  plan_review: { role: r }\n');
  await appendLifecycle('s1_plan_review_started', 'IDD-001', { run_id: 'L' });
  const res = await runPlanReview();
  assert.deepEqual(res.finished, ['IDD-001']);
  assert.equal(readLifecycle().at(-1).attrs.failed, true);
  setAgentRunner(null);
});

test('continue / accept are refused unless the lane is waiting for penne', async () => {
  setup('  review_blind: { roles: [r] }\n');
  const { applyDecision } = await import('../src/ledger/write.ts');
  const r = await applyDecision('s2_review_continue', { iddId: 'IDD-001', note: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /要判断ではありません/);
  assert.equal(readLifecycle().at(-1).event, 's2_result');
});

test('the leftovers of an S2 confirm are judged with the usual triage instructions', async () => {
  setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const started = [];
  setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { started.push(o); return { runIds: ['X'] }; }, reviewRunStatus: () => ({ state: 'running' }) });
  for (const [event, attrs] of [['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }], ['s2_review_findings', { kind: 'blind', round: 1, files: [] }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 'T' }], ['s2_triage_done', { kind: 'blind', round: 1, report_md: '/t.md', accepted: [{ ref: 'F-1', severity: 'must', claim: 'x', path: 'a.ts', fix: 'f' }], rejected: [] }],
    ['s2_fix_sent', { round: 1, refs: ['F-1'] }], ['s2_result', { outcome: 'success' }], ['s2_confirm_started', { round: 1, run_id: 'C' }],
    ['s2_confirm_done', { round: 1, files: ['/c.json'], unresolved_must: 1, unresolved_should: 0, new_blocking: 0, unresolved_refs: ['F-1'] }]]) await seedLifecycle(event, 'IDD-001', attrs);
  await runReviewLoop();
  assert.equal(started.at(-1).stage, 'triage');
  assert.deepEqual(started.at(-1).inputs.slice(0, 2), ['/c.json', '/t.md']);
  setAgentRunner(null);
});

// IDD-023 in small: the round-1 fix loosened a test, round 2 tightened it, round 3 asks to loosen it again
const quietLoop = [
  ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'] }], ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b1.json'] }],
  ['s2_triage_started', { kind: 'blind', round: 1, run_id: 'T1' }],
  ['s2_triage_done', { kind: 'blind', round: 1, report_md: '/t1.md', rejected: [], accepted: [
    { ref: 'F-1', severity: 'should', path: 'TODO.md', claim: 'R2 の負債が追跡されていない', fix: 'TODO に載っていること' },
    { ref: 'F-2', severity: 'should', path: 'tests/test_quiet.py', claim: '文言を literal で固定する test が文言の自由と食い違う', fix: '許された文言の変更で test が落ちないこと' },
    { ref: 'F-3', severity: 'nit', path: 'tests/test_quiet.py', claim: 'assert の範囲がずれる' },
  ] }],
  ['s2_fix_sent', { round: 1, refs: ['F-1', 'F-2'] }], ['s2_result', { outcome: 'success' }],
  ['s2_confirm_started', { round: 1, run_id: 'C1' }], ['s2_confirm_done', { round: 1, files: ['/c1.json'], unresolved_must: 0, unresolved_should: 0, new_blocking: 0, unresolved_refs: [] }],
  ['s2_review_started', { kind: 'final', round: 2, run_ids: ['B2'] }], ['s2_review_findings', { kind: 'final', round: 2, files: ['/b2.json'] }],
  ['s2_triage_started', { kind: 'final', round: 2, run_id: 'T2' }],
  ['s2_triage_done', { kind: 'final', round: 2, report_md: '/t2.md', rejected: [], accepted: [
    { ref: 'F-1', severity: 'should', path: 'tests/test_quiet.py', claim: 'all-passed test の検査が弱く退行を検知できない', fix: '1 行・件数・通過が判別できることを test が検知すること' },
    { ref: 'F-2', severity: 'should', path: 'tests/test_quiet.py', claim: 'WARN だけで rc=0 が検証されていない', fix: 'WARN だけなら rc=0 であることを確かめること' },
  ] }],
  ['s2_fix_sent', { round: 2, refs: ['F-1', 'F-2'] }], ['s2_result', { outcome: 'success' }],
  ['s2_confirm_started', { round: 2, run_id: 'C2' }], ['s2_confirm_done', { round: 2, files: ['/c2.json'], unresolved_must: 0, unresolved_should: 0, new_blocking: 0, unresolved_refs: [] }],
  ['s2_review_started', { kind: 'final', round: 3, run_ids: ['B3'] }], ['s2_review_findings', { kind: 'final', round: 3, files: ['/b3.json'] }],
];
const reversal = { ref: 'F-1', verdict: 'escalate', severity: 'should', path: 'tests/test_quiet.py', claim: '語彙 regex で文言を縛る', reason: '2 巡目の修正を打ち消す', reverts: { prior_ref: '2-final/F-1', prior: '通過が判別できることを test が確かめる', current: '特定の語の有無で合否を決めない' } };

async function toThirdTriage() {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  for (const [event, attrs] of quietLoop) await seedLifecycle(event, 'IDD-001', attrs);
  const started = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o); const id = `${o.stage}-${started.length}`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  return { state, started, status };
}

const outboxText = (state) => readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');

test('the triage is handed what earlier rounds sent to the fix, with refs it can point back to', async () => {
  const { started } = await toThirdTriage();
  await runReviewLoop();
  const t = started.at(-1);
  assert.equal(t.stage, 'triage');
  const history = t.inputs.find((p) => /triage-history/.test(p));
  assert.ok(history, 'a history of the earlier judgements is among the inputs');
  assert.deepEqual(t.inputs.slice(0, 1), ['/b3.json'], 'the findings still come first');
  const text = readFileSync(history, 'utf8');
  assert.match(text, /1-blind\/F-2（should）tests\/test_quiet\.py: 文言を literal で固定する/);
  assert.match(text, /2-final\/F-1（should）tests\/test_quiet\.py: all-passed test の検査が弱く/);
  assert.match(text, /1 行・件数・通過が判別できることを test が検知すること/, 'with the fix it was sent');
  assert.doesNotMatch(text, /assert の範囲がずれる/, 'an accepted nit was never fixed, so nothing can reverse it');
  setAgentRunner(null);
});

test('the first triage has no history to be handed', async () => {
  setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const started = [];
  setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { started.push(o); return { runIds: ['X'] }; }, reviewRunStatus: () => ({ state: 'running' }) });
  for (const [event, attrs] of quietLoop.slice(0, 2)) await seedLifecycle(event, 'IDD-001', attrs);
  await runReviewLoop();
  assert.equal(started.at(-1).stage, 'triage');
  assert.equal(started.at(-1).inputs.some((p) => /triage-history/.test(p)), false);
  setAgentRunner(null);
});

test('a reversal is not fixed: penne picks the boundary, and the fix and the next triage carry it', async () => {
  const { state, started, status } = await toThirdTriage();
  await runReviewLoop();
  const runId = `triage-${started.length}`;
  status[runId] = { state: 'done', reportJson: '/t3.json', reportMd: '/t3.md', decisions: [
    reversal,
    { ref: 'F-2', verdict: 'accept', severity: 'should', path: 'decision.md', claim: 'DEC に 2 巡目の test が無い', fix: '記録と test が一致すること' },
  ] };
  await runReviewLoop();
  const done = readLifecycle().at(-1);
  assert.equal(done.event, 's2_triage_done');
  assert.deepEqual(done.attrs.accepted.map((a) => a.ref), ['F-2'], 'the reversal is not accepted');
  assert.deepEqual(done.attrs.escalated_claims, []);
  assert.deepEqual(done.attrs.oscillations, [{ ref: 'F-1', severity: 'should', path: 'tests/test_quiet.py', claim: '語彙 regex で文言を縛る', reason: '2 巡目の修正を打ち消す', prior_ref: '2-final/F-1', prior: '通過が判別できることを test が確かめる', current: '特定の語の有無で合否を決めない' }]);
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_escalated');
  assert.match(deriveStage(readLifecycle()).blockedBy, /往復/);
  assert.equal(existsSync(join(state, 'outbox')) ? readdirSync(join(state, 'outbox')).length : 0, 0, 'nothing went to the executor');

  const { applyDecision } = await import('../src/ledger/write.ts');
  const refused = await applyDecision('s2_review_continue', { iddId: 'IDD-001', note: '' });
  assert.equal(refused.ok, false, 'a reversal left undecided is not sent back to the fix');
  assert.match(refused.error, /境目/);
  const ok = await applyDecision('s2_review_continue', { iddId: 'IDD-001', note: '', boundaries: [{ ref: 'F-1', choice: 'custom', text: '不変は「1 行・先頭が OK・全件数」の 3 点。ほかの語は自由' }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(readLifecycle().at(-1).attrs.boundaries, [{ ref: 'F-1', choice: 'custom', text: '不変は「1 行・先頭が OK・全件数」の 3 点。ほかの語は自由' }]);

  await runReviewLoop();
  const fix = readLifecycle().at(-1);
  assert.equal(fix.event, 's2_fix_sent');
  assert.deepEqual(fix.attrs.refs, ['F-2']);
  const xml = outboxText(state);
  assert.match(xml, /記録と test が一致すること/);
  assert.match(xml, /<boundary ref="F-1" reverts="2-final\/F-1"/);
  assert.match(xml, /不変は「1 行・先頭が OK・全件数」の 3 点/);
  assert.match(xml, /語彙 regex で文言を縛る/);

  // the next judgement reads penne's decision as the boundary to judge by
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  for (const [event, attrs] of [['s2_confirm_started', { round: 3, run_id: 'C3' }], ['s2_confirm_done', { round: 3, files: ['/c3.json'], unresolved_must: 0, unresolved_should: 0, new_blocking: 0, unresolved_refs: [] }],
    ['s2_review_started', { kind: 'final', round: 4, run_ids: ['B4'] }], ['s2_review_findings', { kind: 'final', round: 4, files: ['/b4.json'] }]]) await seedLifecycle(event, 'IDD-001', attrs);
  await runReviewLoop();
  const history = started.at(-1).inputs.find((p) => /triage-history/.test(p));
  const text = readFileSync(history, 'utf8');
  assert.match(text, /penne の決定/);
  assert.match(text, /3-final\/F-1.*語彙 regex で文言を縛る/);
  assert.match(text, /不変は「1 行・先頭が OK・全件数」の 3 点。ほかの語は自由/);
  assert.match(text, /3-final\/F-2（should）decision\.md/);
  setAgentRunner(null);
});

test('picking a side on the card writes that side as the decision; a note alone also lets the fix go on', async () => {
  const { started, status } = await toThirdTriage();
  await runReviewLoop();
  status[`triage-${started.length}`] = { state: 'done', reportJson: '/t3.json', reportMd: '/t3.md', decisions: [reversal] };
  await runReviewLoop();
  await runReviewLoop();
  const { applyDecision } = await import('../src/ledger/write.ts');
  const r = await applyDecision('s2_review_continue', { iddId: 'IDD-001', boundaries: [{ ref: 'F-1', choice: 'prior' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(readLifecycle().at(-1).attrs.boundaries, [{ ref: 'F-1', choice: 'prior', text: '通過が判別できることを test が確かめる' }]);
  const noted = await toThirdTriage();
  await runReviewLoop();
  noted.status[`triage-${noted.started.length}`] = { state: 'done', reportJson: '/t3.json', reportMd: '/t3.md', decisions: [reversal] };
  await runReviewLoop();
  await runReviewLoop();
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-001', note: '境目は DEC-062 に書いて決める' })).ok, true);
  // the note written in place of a side is the boundary of the reversal it answered
  assert.deepEqual(readLifecycle().at(-1).attrs.boundaries, [{ ref: 'F-1', choice: 'custom', text: '境目は DEC-062 に書いて決める' }]);
  setAgentRunner(null);
});

test('only an escalated finding with both positions is a reversal: a reject citing penne\'s boundary or an empty mark is judged as usual', async () => {
  const { started, status } = await toThirdTriage();
  await runReviewLoop();
  status[`triage-${started.length}`] = { state: 'done', reportJson: '/t3.json', reportMd: '/t3.md', decisions: [
    { ref: 'F-1', verdict: 'reject', severity: 'should', path: 'tests/test_quiet.py', claim: '語彙で縛る', reason: 'penne の決定に反する', reverts: { prior_ref: '2-final/F-1', prior: '厳しく', current: '緩く' } },
    { ref: 'F-2', verdict: 'accept', severity: 'nit', path: 'a.py', claim: '表記', reverts: { prior_ref: 'なし', prior: 'なし', current: 'なし' } },
    { ref: 'F-3', verdict: 'escalate', severity: 'should', path: 'b.py', claim: '仕様が決まらない', reason: 'r', reverts: { prior_ref: '1-blind/F-2', prior: '緩く', current: '' } },
  ] };
  await runReviewLoop();
  const done = readLifecycle().at(-1);
  assert.equal(done.event, 's2_triage_done');
  assert.equal(done.attrs.oscillations, undefined);
  assert.deepEqual(done.attrs.rejected.map((r) => r.ref), ['F-1']);
  assert.deepEqual(done.attrs.accepted.map((a) => a.ref), ['F-2']);
  assert.deepEqual(done.attrs.escalated_claims, ['仕様が決まらない（r）']);
  setAgentRunner(null);
});

test('a boundary penne decided is not asked again: the next round turns the same reversal down by it', async () => {
  const { started, status } = await toThirdTriage();
  await runReviewLoop();
  status[`triage-${started.length}`] = { state: 'done', reportJson: '/t3.json', reportMd: '/t3.md', decisions: [reversal] };
  await runReviewLoop();
  await runReviewLoop();
  const { applyDecision } = await import('../src/ledger/write.ts');
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-001', boundaries: [{ ref: 'F-1', choice: 'prior' }] })).ok, true);
  await runReviewLoop();
  for (const [event, attrs] of [['s2_result', { outcome: 'success' }], ['s2_confirm_started', { round: 3, run_id: 'C3' }], ['s2_confirm_done', { round: 3, files: ['/c3.json'], unresolved_must: 0, unresolved_should: 0, new_blocking: 0, unresolved_refs: [] }],
    ['s2_review_started', { kind: 'final', round: 4, run_ids: ['B4'] }], ['s2_review_findings', { kind: 'final', round: 4, files: ['/b4.json'] }]]) await seedLifecycle(event, 'IDD-001', attrs);
  await runReviewLoop();
  // the judge cites the boundary and still names the fix it would undo
  status[`triage-${started.length}`] = { state: 'done', reportJson: '/t4.json', reportMd: '/t4.md', decisions: [
    { ...reversal, verdict: 'reject', reason: 'penne の決定（通過が判別できることを確かめる）に反する' },
  ] };
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).attrs.oscillations, undefined);
  assert.equal(reviewLoopState(readLifecycle()).state, 'converge', 'not a second question about the same boundary');
  setAgentRunner(null);
});

test('a note to the executor after a stall is not handed to later judgements as penne\'s decision', async () => {
  const { started } = await toThirdTriage();
  const tri = (round, tag) => ['s2_triage_done', { kind: 'final', round, report_md: '/x.md', rejected: [], accepted: [1, 2].map((n) => ({ ref: `F-${n}`, severity: 'should', path: 'a.py', claim: `${tag}-${n}`, fix: 'f' })) }];
  for (const [event, attrs] of [tri(3, 'a'), ['s2_review_escalated', { reason: '受理済みの must / should が減らない' }], ['s2_review_resumed', { decision: 'continue', note: 'テストも足して' }],
    ['s2_fix_sent', { round: 3, refs: ['F-1', 'F-2'] }], ['s2_result', { outcome: 'success' }], ['s2_confirm_started', { round: 3, run_id: 'C3' }],
    ['s2_confirm_done', { round: 3, files: ['/c3.json'], unresolved_must: 0, unresolved_should: 0, new_blocking: 0, unresolved_refs: [] }],
    ['s2_review_started', { kind: 'final', round: 4, run_ids: ['B4'] }], ['s2_review_findings', { kind: 'final', round: 4, files: ['/b4.json'] }]]) await seedLifecycle(event, 'IDD-001', attrs);
  await runReviewLoop();
  const text = readFileSync(started.at(-1).inputs.find((p) => /triage-history/.test(p)), 'utf8');
  assert.match(text, /3-final\/F-1（should）a\.py: a-1/);
  assert.doesNotMatch(text, /## penne の決定/);
  assert.doesNotMatch(text, /テストも足して/);
  setAgentRunner(null);
});

async function toBoundaryFix(runner = {}) {
  const ctx = await toThirdTriage();
  await runReviewLoop();
  ctx.status[`triage-${ctx.started.length}`] = { state: 'done', reportJson: '/t3.json', reportMd: '/t3.md', decisions: [
    reversal, { ref: 'F-2', verdict: 'accept', severity: 'should', path: 'decision.md', claim: 'DEC に 2 巡目の test が無い', fix: '記録と test が一致すること' },
  ] };
  await runReviewLoop();
  await runReviewLoop();
  const { applyDecision } = await import('../src/ledger/write.ts');
  await applyDecision('s2_review_continue', { iddId: 'IDD-001', boundaries: [{ ref: 'F-1', choice: 'custom', text: '3 点だけ固定する' }] });
  await runReviewLoop();
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  await runReviewLoop();
  return ctx;
}

test('the confirm checks the fix made toward penne\'s boundary, and one it does not find made is not closed', async () => {
  const { started, status } = await toBoundaryFix();
  const c = started.at(-1);
  assert.equal(c.stage, 'confirm');
  const file = c.inputs.find((p) => /boundaries-3\.md/.test(p));
  assert.ok(file, 'the boundaries are handed to the confirm');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /F-1（should）tests\/test_quiet\.py: 語彙 regex で文言を縛る/);
  assert.match(text, /3 点だけ固定する/);
  assert.deepEqual(readLifecycle().at(-1).attrs.boundary_refs, ['F-1']);
  // the confirm reports only the accepted F-2: the boundary is not confirmed
  status[`confirm-${started.length}`] = { state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'F-2', resolved: true }] };
  await runReviewLoop();
  const done = readLifecycle().at(-1);
  assert.equal(done.event, 's2_confirm_done');
  assert.equal(done.attrs.unresolved_boundaries, 1);
  assert.deepEqual(done.attrs.unresolved_refs, ['F-1']);
  assert.equal(reviewLoopState(readLifecycle()).state, 'start_triage', 'a boundary not met is judged, not tolerated as the one should');
  setAgentRunner(null);
});

test('a boundary the confirm finds met lets the loop go on to the final blind', async () => {
  const { started, status } = await toBoundaryFix();
  status[`confirm-${started.length}`] = { state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'F-2', resolved: true }, { ref: 'F-1', resolved: true }] };
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).attrs.unresolved_boundaries, 0);
  assert.deepEqual(reviewLoopState(readLifecycle()), { state: 'start_blind', kind: 'final', round: 4 });
  setAgentRunner(null);
});

test('"go on as it is" records no boundary: the code keeps the earlier position, whatever side was picked', async () => {
  const { started, status } = await toThirdTriage();
  await runReviewLoop();
  status[`triage-${started.length}`] = { state: 'done', reportJson: '/t3.json', reportMd: '/t3.md', decisions: [reversal] };
  await runReviewLoop();
  await runReviewLoop();
  const { applyDecision } = await import('../src/ledger/write.ts');
  assert.equal((await applyDecision('s2_review_accept', { iddId: 'IDD-001', note: '今回の立場で', boundaries: [{ ref: 'F-1', choice: 'current' }] })).ok, true);
  assert.equal(readLifecycle().at(-1).attrs.boundaries, undefined);
  setAgentRunner(null);
});

test('the judgement\'s recommended handling is recorded on the accepted item, and a follow-up alone goes on to the final review', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  // the reports the finding was written in: the weight each reviewer gave it, which the judgement is never handed
  for (const [dir, severity] of [['1-blind-r-a1', 'must'], ['1-blind-s-b2', 'should']]) {
    const reportDir = join(state, 'pipeline', 'review', 'IDD-001', dir);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'report.json'), JSON.stringify({ findings: [{ severity, path: 'a.ts', claim: 'まれな穴', evidence: 'e', is_guess: false }] }));
  }
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { const id = `${o.stage}-1`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  const step = () => runReviewLoop();
  const last = () => readLifecycle().at(-1);
  await step(); // blind
  status['blind-1'] = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] };
  await step(); // findings
  await step(); // triage started
  status['triage-1'] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [
    { ref: 'F-1', verdict: 'accept', severity: 'should', claim: 'まれな穴', path: 'a.ts', fix: '条件を満たすこと', action: 'followup', from: ['1-blind-r-a1', '1-blind-s-b2'], reported_severity: 'nit' },
    { ref: 'F-2', verdict: 'reject', severity: 'should', claim: '範囲の外', reason: '別 issue', followup: true },
  ] };
  await step();
  const done = last();
  assert.equal(done.event, 's2_triage_done');
  assert.equal(done.attrs.accepted[0].action, 'followup');
  assert.equal(done.attrs.rejected[0].followup, true);
  // which reviewer runs the finding came from and the weight they gave it are kept for measuring the reviewers: the weight is
  // the harness's reading of the reports (the heaviest of the two), never what the judgement wrote beside the decision
  assert.deepEqual(done.attrs.accepted[0].from, ['1-blind-r-a1', '1-blind-s-b2']);
  assert.equal(done.attrs.accepted[0].reported_severity, 'must');
  assert.ok(!('from' in done.attrs.rejected[0]) && !('reported_severity' in done.attrs.rejected[0]), 'a decision without them records neither');
  // only a follow-up and a rejected item: nothing is sent to the fix, and the step after the judgement is the final review
  // (here the final review is skipped, the blind having read the same head with its judgement within the limit)
  await step();
  assert.equal(last().event, 's2_review_converged');
  assert.ok(!readLifecycle().some((e) => e.event === 's2_fix_sent'), 'no fix is sent for a follow-up alone');
  setAgentRunner(null);
});

test('an S2 confirm counts only the refs it was handed: a follow-up the confirm reports on is not unresolved', async () => {
  setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  for (const [event, attrs] of [
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }],
    ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 'T' }],
    ['s2_triage_done', { kind: 'blind', round: 1, report_md: '/t.md', accepted: [
      { ref: 'F-1', severity: 'should', claim: '直す', path: 'a.ts', fix: 'f', action: 'fix' },
      { ref: 'F-2', severity: 'should', claim: '次の変更に回す', path: 'b.ts', fix: 'g', action: 'followup' },
    ], rejected: [] }],
    ['s2_fix_sent', { round: 1, refs: ['F-1'] }],
    ['s2_result', { outcome: 'success' }],
    ['s2_confirm_started', { round: 1, run_id: 'C', scope_refs: ['F-1'] }],
  ]) await seedLifecycle(event, 'IDD-001', attrs);
  setAgentRunner({
    deliver: async () => {},
    reviewRunStatus: () => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'F-1', resolved: true }, { ref: 'F-2', resolved: false }] }),
  });
  await runReviewLoop();
  const done = readLifecycle().at(-1);
  assert.equal(done.event, 's2_confirm_done');
  assert.deepEqual(done.attrs.unresolved_refs, [], 'the follow-up outside the list is not this confirm\'s to report');
  assert.equal(done.attrs.unresolved_should, 0);
  setAgentRunner(null);
});

test('AC-002: a judgement reads the findings with the reviewer\'s how-to-fix taken out, and still names the run it came from', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  // the blind's own report, as the run wrote it: the findings carry the reviewer's plan for fixing each
  const dir = join(state, 'pipeline', 'review', 'IDD-001', '1-blind-r-a1');
  mkdirSync(dir, { recursive: true });
  const report = join(dir, 'report.json');
  writeFileSync(report, JSON.stringify({ findings: [{ severity: 'must', path: 'a.ts', line: 3, claim: '購読が残る', evidence: 'dispose が無い', is_guess: false, how: 'dispose を finally に置く' }], runs: [], clean: true, unreviewed: [], verdict: 'request-changes' }));
  const started = [];
  const status = { b1: { state: 'done', reportJson: report, reportMd: join(dir, 'report.md'), findings: [{ severity: 'must', path: 'a.ts', claim: '購読が残る', evidence: 'dispose が無い', how: 'dispose を finally に置く' }] } };
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o); status['t1'] = { state: 'running' }; return { runIds: ['t1'] }; },
    reviewRunStatus: (id) => status[id],
  });
  await seedLifecycle('s2_review_started', 'IDD-001', { kind: 'blind', round: 1, run_ids: ['b1'] });
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_findings');
  assert.deepEqual(readLifecycle().at(-1).attrs.files, [report], 'the record keeps the report the run wrote');
  await runReviewLoop();
  const seen = started.at(-1);
  assert.equal(seen.stage, 'triage');
  const input = seen.inputs[0];
  assert.ok(input.endsWith('.json'), input);
  assert.equal(basename(dirname(input)), '1-blind-r-a1', 'the copy sits in the run\'s own directory, so `from` still names the run');
  const text = readFileSync(input, 'utf8');
  assert.doesNotMatch(text, /"how"|dispose を finally に置く/, 'the reviewer\'s plan is not in the judgement\'s input');
  assert.match(text, /購読が残る/, 'the claim and the evidence stay');
  assert.match(text, /dispose が無い/);
  status.t1 = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: '購読が残る', path: 'a.ts', fix: '購読が止まっていること', from: ['1-blind-r-a1'], reported_severity: 'must' }] };
  await runReviewLoop();
  const done = readLifecycle().at(-1);
  assert.equal(done.event, 's2_triage_done');
  assert.doesNotMatch(JSON.stringify(done.attrs), /dispose を finally に置く/, 'the judgement\'s record holds no plan');
  assert.deepEqual(done.attrs.accepted[0].from, ['1-blind-r-a1'], 'from reads as it always did');
  setAgentRunner(null);
});

test('AC-003: only the findings the fix is sent for carry the reviewer\'s how-to-fix', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const dir = join(state, 'pipeline', 'review', 'IDD-001', '1-blind-r-a1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ findings: [
    { severity: 'must', path: 'a.ts', claim: '購読が残る', evidence: '', is_guess: false, how: 'dispose を finally に置く' },
    { severity: 'should', path: 'b.ts', claim: 'テストが退行を検出しない', evidence: '', is_guess: false, how: '赤になる assert を足す' },
    { severity: 'should', path: 'c.ts', claim: '命名が揃わない', evidence: '', is_guess: false, how: '規則の語に合わせる' },
    { severity: 'nit', path: 'd.ts', claim: '言い回しが固い', evidence: '', is_guess: false, how: '文を短くする' },
  ] }));
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { const id = `${o.stage}-1`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  const step = () => runReviewLoop();
  await step();
  status['blind-1'] = { state: 'done', reportJson: join(dir, 'report.json'), reportMd: join(dir, 'report.md'), findings: [] };
  await step();
  await step();
  status['triage-1'] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [
    { ref: 'F-1', verdict: 'accept', severity: 'must', claim: '購読が残る', path: 'a.ts', fix: '購読が止まっていること', from: ['1-blind-r-a1'] },
    // a should the judgement sends to a follow-up: its plan is never read
    { ref: 'F-2', verdict: 'accept', severity: 'should', claim: 'テストが退行を検出しない', path: 'b.ts', fix: '赤になること', action: 'followup', from: ['1-blind-r-a1'] },
    // a rejected finding: its plan is never read either
    { ref: 'F-3', verdict: 'reject', severity: 'should', claim: '命名が揃わない', path: 'c.ts', reason: '規約どおり', from: ['1-blind-r-a1'] },
    // an accepted nit: recorded, never sent
    { ref: 'F-4', verdict: 'accept', severity: 'nit', claim: '言い回しが固い', path: 'd.ts', from: ['1-blind-r-a1'] },
    // accepted and fixed, but this reviewer wrote no plan for it: it is sent without one
    { ref: 'F-5', verdict: 'accept', severity: 'must', claim: '入力の検証が無い', path: 'e.ts', fix: '空文字で落ちないこと', from: ['1-blind-r-a1'] },
  ] };
  await step();
  await step();
  const sent = readLifecycle().at(-1);
  assert.equal(sent.event, 's2_fix_sent');
  assert.deepEqual(sent.attrs.refs, ['F-1', 'F-5'], 'a follow-up, a reject and a nit are not sent');
  const xml = readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');
  const itemOf = (ref) => {
    const at = xml.indexOf(`<item ref="${ref}"`);
    return at < 0 ? '' : xml.slice(at, xml.indexOf('</item>', at) + '</item>'.length);
  };
  assert.match(itemOf('F-1'), /<how>dispose を finally に置く<\/how><\/item>$/);
  assert.doesNotMatch(xml, /赤になる assert を足す/, 'the follow-up\'s plan is not sent');
  assert.doesNotMatch(xml, /規則の語に合わせる/, 'the rejected finding\'s plan is not sent');
  assert.doesNotMatch(xml, /文を短くする/, 'the nit\'s plan is not sent');
  assert.match(itemOf('F-5'), /購読が残る|入力の検証が無い/);
  assert.doesNotMatch(itemOf('F-5'), /<how>/, 'a finding with no plan is sent without one');
  assert.match(xml, /how は、その指摘を出したレビューが書いた直し方/, 'the implementer is told to follow it, or to record why not');
  // the round keeps the count of findings that carried a plan, and the envelope the plan run and the cost are read by
  assert.deepEqual(sent.attrs.how_refs, ['F-1']);
  const row = JSON.parse(readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(sent.attrs.envelope_id, row.envelope_id, 'the fix names its own envelope');
  await appendLifecycle('fix_plan_started', 'IDD-001', { envelope_id: row.envelope_id, run_id: 'P-1' });
  const plan = readLifecycle().at(-1);
  assert.equal(plan.attrs.envelope_id, sent.attrs.envelope_id, 'the plan run of that round is tied to the fix by the envelope');
  setAgentRunner(null);
});

test('a fix sent with no plan anywhere carries no how and the round records none', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { const id = `${o.stage}-1`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  await runReviewLoop();
  status['blind-1'] = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] };
  await runReviewLoop();
  await runReviewLoop();
  // the judgement names a run whose report is not on disk (an older lane, a cleaned directory)
  status['triage-1'] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: '購読が残る', path: 'a.ts', fix: '購読が止まっていること', from: ['9-blind-r-old'] }] };
  await runReviewLoop();
  await runReviewLoop();
  const sent = readLifecycle().at(-1);
  assert.equal(sent.event, 's2_fix_sent');
  assert.deepEqual(sent.attrs.refs, ['F-1']);
  assert.deepEqual(sent.attrs.how_refs, [], 'no plan was found, so none is recorded');
  const xml = readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');
  assert.doesNotMatch(xml, /<how>/);
  assert.doesNotMatch(xml, /how は、その指摘を出したレビュー/, 'nothing tells the implementer to follow a plan that is not there');
  setAgentRunner(null);
});

/** the envelope of the round's fix, split by the item of each ref */
function fixItems(state) {
  const xml = readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');
  return { xml, itemOf: (ref) => {
    const at = xml.indexOf(`<item ref="${ref}"`);
    return at < 0 ? '' : xml.slice(at, xml.indexOf('</item>', at) + '</item>'.length);
  } };
}

/** run one blind → triage → fix lap on a report of the given findings and the decisions the judgement writes */
async function lapWith(state, findings, decisions) {
  const dir = join(state, 'pipeline', 'review', 'IDD-001', '1-blind-r-a1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ findings }));
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { const id = `${o.stage}-1`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  await runReviewLoop();
  status['blind-1'] = { state: 'done', reportJson: join(dir, 'report.json'), reportMd: join(dir, 'report.md'), findings: [] };
  await runReviewLoop();
  await runReviewLoop();
  status['triage-1'] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions };
  await runReviewLoop();
  await runReviewLoop();
  return readLifecycle().at(-1);
}

const PLAN_R = 'clear the cache at logout';
const PLAN_A = 'clear the cache when the permission changes';
const SHORT_R = 'cache key is not cleared on logout';
const LONG_A = 'cache key is not cleared on logout so a session survives a permission change';
/** the accepted claim above, reworded by the judgement: the words move, the characters mostly do not */
const LONG_A_REWORDED = 'cache key is never cleared at logout and a session survives the permission change';

/** a rejected finding and an accepted one, written at one path, the rejected claim only a part of the accepted one */
const besideOf = () => [
  { path: 'a.ts', claim: SHORT_R, how: PLAN_R },
  { path: 'a.ts', claim: LONG_A, how: PLAN_A },
];

function decisionsBeside(acceptedClaim) {
  return [
    { ref: 'F-1', verdict: 'accept', severity: 'must', claim: acceptedClaim, path: 'a.ts', fix: 'the key is cleared', from: ['1-blind-r-a1'] },
    { ref: 'F-2', verdict: 'reject', severity: 'should', claim: SHORT_R, path: 'a.ts', reason: '別の lane で直す', from: ['1-blind-r-a1'] },
  ];
}

test('AC-003: the plan beside a rejected finding is not handed to the accepted finding that reads like it', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const sent = await lapWith(state, besideOf(), decisionsBeside(LONG_A));
  assert.equal(sent.event, 's2_fix_sent');
  assert.deepEqual(sent.attrs.refs, ['F-1']);
  const { xml, itemOf } = fixItems(state);
  assert.match(itemOf('F-1'), new RegExp(`<how>${PLAN_A}</how></item>$`), 'the accepted finding keeps its own reviewer\'s plan');
  assert.doesNotMatch(itemOf('F-1'), new RegExp(PLAN_R), 'the rejected finding\'s plan is not handed to it');
  assert.doesNotMatch(xml, new RegExp(PLAN_R), 'a rejected finding\'s plan goes nowhere');
  assert.deepEqual(sent.attrs.how_refs, ['F-1']);
  setAgentRunner(null);
});

test('AC-003: a rejected finding\'s plan stays off an accepted finding whose claim the judgement rewrote', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const sent = await lapWith(state, besideOf(), decisionsBeside(LONG_A_REWORDED));
  assert.equal(sent.event, 's2_fix_sent');
  const { xml, itemOf } = fixItems(state);
  const item = itemOf('F-1');
  assert.match(item, new RegExp(`<how>${PLAN_A}</how></item>$`), 'a reworded claim keeps the plan of its own finding');
  assert.doesNotMatch(item, new RegExp(PLAN_R), 'the rejected finding\'s plan never rides a rewritten claim');
  assert.doesNotMatch(xml, new RegExp(PLAN_R));
  assert.deepEqual(sent.attrs.how_refs, ['F-1']);
  setAgentRunner(null);
});

test('AC-003: a reworded Japanese claim still carries the plan its reviewer wrote', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  // a Japanese claim has no word tokens at all, so only its characters can tell that the judgement reworded one finding
  const sent = await lapWith(
    state,
    [{ path: 'a.ts', claim: 'キャッシュの鍵がログアウトで消えない', how: 'ログアウトで鍵を捨てる' }],
    [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: 'キャッシュの鍵はログアウトの後に消えないまま残る', path: 'a.ts', fix: '鍵が消えていること', from: ['1-blind-r-a1'] }],
  );
  assert.equal(sent.event, 's2_fix_sent');
  const { itemOf } = fixItems(state);
  assert.match(itemOf('F-1'), /<how>ログアウトで鍵を捨てる<\/how><\/item>$/, 'the reworded claim keeps the plan of the finding it rewords');
  assert.deepEqual(sent.attrs.how_refs, ['F-1']);
  setAgentRunner(null);
});

test('AC-003: a reworded finding beside a rejected and a followed-up one keeps only its own plan', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  // three findings at one path, every claim reworded by the judgement: only the accepted one may carry a plan
  const findings = [
    { path: 'a.ts', claim: 'キャッシュの鍵がログアウトで消えない', how: 'ログアウトで鍵を捨てる' },
    { path: 'a.ts', claim: '入力の検証が無く空文字で落ちる', how: '空文字を弾く' },
    { path: 'a.ts', claim: 'ログの文面が古いまま', how: '今の文面に直す' },
  ];
  const decisions = [
    { ref: 'F-1', verdict: 'accept', severity: 'must', claim: 'キャッシュの鍵はログアウトの後に消えないまま残る', path: 'a.ts', fix: '鍵が消えていること', from: ['1-blind-r-a1'] },
    { ref: 'F-2', verdict: 'reject', severity: 'should', claim: '入力の検証が無く、空文字を入れると落ちる', path: 'a.ts', reason: '別の lane で直す', from: ['1-blind-r-a1'] },
    { ref: 'F-3', verdict: 'accept', severity: 'should', claim: 'ログの文面が古いまま残っている', path: 'a.ts', action: 'followup', from: ['1-blind-r-a1'] },
  ];
  const sent = await lapWith(state, findings, decisions);
  assert.equal(sent.event, 's2_fix_sent');
  const { xml, itemOf } = fixItems(state);
  assert.match(itemOf('F-1'), /<how>ログアウトで鍵を捨てる<\/how><\/item>$/, 'the accepted finding keeps its own plan');
  assert.doesNotMatch(xml, /空文字を弾く/, 'the rejected finding\'s plan goes nowhere');
  assert.doesNotMatch(xml, /今の文面に直す/, 'the followed-up finding\'s plan goes nowhere');
  assert.deepEqual(sent.attrs.how_refs, ['F-1']);
  setAgentRunner(null);
});

test('AC-003: two plans as close as each other bind neither, and the finding goes without one', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  // the same finding reported twice with two different plans: neither can claim it, so no plan rides (fail closed)
  const findings = [
    { path: 'a.ts', claim: 'キャッシュの鍵がログアウトで消えない', how: 'ログアウトで鍵を捨てる' },
    { path: 'a.ts', claim: 'キャッシュの鍵がログアウトで消えない', how: 'セッションを捨てる' },
  ];
  const decisions = [
    { ref: 'F-1', verdict: 'accept', severity: 'must', claim: 'キャッシュの鍵はログアウトの後に消えないまま残る', path: 'a.ts', fix: '鍵が消えていること', from: ['1-blind-r-a1'] },
  ];
  const sent = await lapWith(state, findings, decisions);
  assert.equal(sent.event, 's2_fix_sent');
  const { xml, itemOf } = fixItems(state);
  assert.doesNotMatch(itemOf('F-1'), /<how>/, 'a tie binds neither plan');
  assert.doesNotMatch(xml, /ログアウトで鍵を捨てる|セッションを捨てる/);
  assert.deepEqual(sent.attrs.how_refs, []);
  setAgentRunner(null);
});

test('AC-003: a judgement naming no report reads a plan only on an exact path and claim', async () => {
  const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const findings = [
    { path: 'a.ts', claim: '入力の検証が無い', how: '空文字を弾く' },
    { path: 'b.ts', claim: 'ログの文面が古い', how: '文面を直す' },
  ];
  // an older lane: the judgement writes no `from`, so the report is named nowhere
  const decisions = [
    { ref: 'F-1', verdict: 'accept', severity: 'must', claim: '入力の検証が無い', path: 'a.ts', fix: '空文字で落ちないこと' },
    { ref: 'F-2', verdict: 'accept', severity: 'must', claim: 'ログの文面がずっと古いまま', path: 'b.ts', fix: '今の文面であること' },
  ];
  const sent = await lapWith(state, findings, decisions);
  assert.equal(sent.event, 's2_fix_sent');
  const { itemOf } = fixItems(state);
  assert.match(itemOf('F-1'), /<how>空文字を弾く<\/how><\/item>$/, 'an exact path and claim finds the plan');
  assert.doesNotMatch(itemOf('F-2'), /<how>/, 'a merely similar claim is not guessed onto');
  assert.deepEqual(sent.attrs.how_refs, ['F-1']);
  setAgentRunner(null);
});

test('a lane with no review_blind slot skips the round after a conflict send-back too', async () => {
  const state = setup('  executor: { role: r }\n');
  setAgentRunner({ deliver: async () => {} });
  await runReviewLoop(); // the first blind is skipped, no review slot
  await runReviewLoop(); // the device check is skipped: done
  const head = headOf(worktreeOf(state));
  await seedLifecycle('s3_ready', 'IDD-001', {});
  await seedLifecycle('s3_check_conflict', 'IDD-001', { conflict_files: ['a.txt'] });
  await seedLifecycle('s4_submit_started', 'IDD-001', { head });
  await seedLifecycle('s4_verify_user_judgment_answered', 'IDD-001', { outcome: 'revise' });
  await seedLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  assert.equal(reviewLoopState(readLifecycle()).state, 'start_blind');
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_skipped', 'the round the conflict send-back moved on to is skipped, not started without a slot');
  assert.equal(reviewLoopState(readLifecycle()).state, 'start_device');
  setAgentRunner(null);
});

test('AC-008 / AC-010: the judgement is handed the work instruction when the lane has one, and not otherwise', async () => {
  const seed = (withPlan) => {
    const state = setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n');
    const wt = worktreeOf(state);
    if (withPlan) {
      mkdirSync(join(wt, '_docs/plan/Demo/idd-001'), { recursive: true });
      writeFileSync(join(wt, '_docs/plan/Demo/idd-001/plan.md'), '---\ntitle: t\n---\n');
    }
    const head = headOf(wt);
    writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [
      ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result'),
      ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'], head }),
      ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    return wt;
  };
  for (const withPlan of [true, false]) {
    seed(withPlan);
    const seen = [];
    setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { seen.push(o); return { runIds: ['t'] }; }, reviewRunStatus: () => ({ state: 'running' }) });
    await runReviewLoop();
    assert.equal(seen[0].stage, 'triage');
    const plan = seen[0].inputs.filter((p) => p.endsWith('_docs/plan/Demo/idd-001/plan.md'));
    assert.equal(plan.length, withPlan ? 1 : 0, `plan input withPlan=${withPlan}: ${seen[0].inputs.join(', ')}`);
    assert.equal(seen[0].hasPlan, withPlan ? true : undefined);
    setAgentRunner(null);
  }
});

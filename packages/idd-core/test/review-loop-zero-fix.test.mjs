import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop, stuckOutcomes } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { fixScope, reviewLoopState } from '../src/ledger/review-loop.ts';
import { fixScope as fixScopeReference, reviewLoopState as reviewLoopStateReference, sendsNothing } from '../src/ledger/review-loop-reference.ts';
import { reviewNextStep } from '../src/ledger/review-loop-next.ts';
import { nextStepReference } from '../src/ledger/review-loop-next-reference.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { tmpDir } from './helpers/tmp.mjs';

// Two idle turns of the S2 loop seen on the APP-2251 bench (IDD-290, run 3):
// 1. penne pressed "続ける" on the cap stop with corrections that left nothing for this change's fix, and the loop still
//    sent an empty fix (`s2_fix_sent` with no refs), woke the fix planner and the executor, and reviewed the same head again.
// 2. the round after that fix started on the head the round before it had read: nothing had changed.

const ID = 'IDD-001';
const ev = (event, attrs = {}) => ({ event, idd_id: ID, at: '2026-11-13T00:00:00+09:00', attrs });
const AREA = 'o/Demo';

function setup() {
  const state = tmpDir('idd-zero-fix-');
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
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { [AREA]: { upstream: join(state, 'u'), work: join(state, 'w') } } }));
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = tmpDir('idd-zero-fix-wt-');
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

function commit(wt, message) {
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', message]);
  return headOf(wt);
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

/** the depth-bearing pass of the bench lane, up to the judgement of its third round (the pass's cap is 2 fixes) */
function capPass(base, heads) {
  const started = (round, head) => ev('s2_review_started', {
    kind: 'blind', round, run_ids: [`B${round}`], head,
    ...(round === 1 ? { depth: 'standard', max_fix_rounds: 2, close_on: 'must' } : {}),
  });
  const judged = (round, accepted) => ev('s2_triage_done', { kind: 'blind', round, report_md: `/t${round}.md`, accepted, rejected: [], escalated_claims: [] });
  return [
    ev('lane_open'), ev('s1_ready', { depth: 'standard' }), ev('s1_go'), ev('s2_start', { started_from_commit: base }), ev('s2_result', { outcome: 'success' }),
    started(1, heads[0]), ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b1.json'], failed_runs: 0 }),
    judged(1, [{ ref: 'F-1', severity: 'must', claim: 'a', path: 'a.dart', fix: 'f', action: 'fix' }]),
    ev('s2_fix_sent', { round: 1, refs: ['1-blind/F-1'], envelope_id: 'fix-IDD-001-r1', how_refs: [] }),
    ev('s2_result', { outcome: 'success' }),
    started(2, heads[1]), ev('s2_review_findings', { kind: 'blind', round: 2, files: ['/b2.json'], failed_runs: 0 }),
    judged(2, [{ ref: 'F-1', severity: 'must', claim: 'b', path: 'a.dart', fix: 'f', action: 'fix' }]),
    ev('s2_fix_sent', { round: 2, refs: ['2-blind/F-1'], envelope_id: 'fix-IDD-001-r2', how_refs: [] }),
    ev('s2_result', { outcome: 'success' }),
    started(3, heads[2]), ev('s2_review_findings', { kind: 'blind', round: 3, files: ['/b3.json'], failed_runs: 0 }),
    judged(3, [
      { ref: 'F-1', severity: 'should', claim: 'c', path: 'a.dart', action: 'followup' },
      { ref: 'F-4', severity: 'must', claim: 'd', path: 'b.dart', fix: 'f', action: 'fix', fix_basis: 'halt' },
    ]),
  ];
}

const capStop = ev('s2_review_escalated', { reason: '修正が 2 巡に達した（この回の上限 2 巡）。境目を決めてください: 3-blind/F-4（must）d' });
/** the bench's answer: the must lowered and set aside, with a note that only says where the boundary lies */
const zeroContinue = ev('s2_review_resumed', {
  decision: 'continue',
  note: '境目: 確かめ直すきっかけは起動・前面復帰・画面の入口まで。',
  corrections: [{ ref: '3-blind/F-4', severity: 'should', action: 'skip', reason: '答えた範囲の外のきっかけを求めているため。' }],
  at_by: 'user',
});

test('a continue that leaves nothing for the fix sends no fix: the round goes to the final review, whose skip settles the same head', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = [...capPass(base, ['h1', 'h2', head]), capStop, zeroContinue];
  // both readings go where a blind judgement with nothing to fix goes: the final review (the standard depth runs it)
  assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'final', round: 3 });
  assert.deepEqual(reviewLoopStateReference(events), { state: 'start_blind', kind: 'final', round: 3 });

  seed(state, events);
  const started = runner();
  await runReviewLoop();
  const after = readLifecycle().slice(events.length);
  assert.ok(!after.some((e) => e.event === 's2_fix_sent'), 'no fix is sent');
  assert.deepEqual(started, [], 'nothing is started: the final of the head the third round read is skipped');
  const converged = after.at(-1);
  assert.equal(converged?.event, 's2_review_converged');
  assert.ok(converged.attrs.final_skipped, 'the final review decided the skip');
  assert.match(String(converged.attrs.reason), /直す対象が 0 件/, 'the convergence says no fix was sent');
  assert.equal(converged.attrs.fix_targets, 0);
  const outbox = join(state, 'outbox.jsonl');
  assert.ok(!existsSync(outbox) || !/"type":"review_fix"/.test(readFileSync(outbox, 'utf8')), 'no fix envelope is queued');
});

test('a continue with nothing to fix goes where the judgement goes without a stop: final → converge, device and PR feedback → done', () => {
  const judged = (kind, extra = {}) => [ev('s2_result'), ev('s2_review_started', { kind: kind === 'final' ? 'final' : 'blind', round: 1, head: 'H' }),
    ev('s2_triage_done', { kind, round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', action: 'fix' }], rejected: [], escalated_claims: [], ...extra }),
    ev('s2_review_escalated', { reason: '上限' }),
    ev('s2_review_resumed', { decision: 'continue', note: '境目', corrections: [{ ref: 'F-1', severity: 'should', action: 'skip', reason: 'r' }] })];
  for (const [kind, to] of [['final', 'converge'], ['device', 'done'], ['blind', 'start_blind'], ['confirm', 'start_blind']]) {
    assert.equal(reviewLoopState(judged(kind)).state, to, `fold: ${kind}`);
    assert.equal(reviewLoopStateReference(judged(kind)).state, to, `reference: ${kind}`);
  }
  // the convergence after a final judgement carries the reason; an accept does not
  const fin = judged('final');
  const step = reviewNextStep(fin, {});
  assert.equal(step.event, 's2_review_converged');
  assert.match(String(step.attrs.reason), /直す対象が 0 件/);
  assert.equal(step.attrs.fix_targets, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(nextStepReference(fin, {}))), JSON.parse(JSON.stringify(step)));
  // S4: feedback on the PR whose request was set aside ends the pass without touching the code
  const fb = [ev('s2_result'), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'), ev('s4_review_comment_received', { files: [] }),
    ev('s2_triage_done', { kind: 'feedback', accepted: [{ ref: 'C-1', severity: 'should', claim: 'c', action: 'fix' }], escalated_claims: [] }),
    ev('s2_review_escalated', { reason: 'r' }),
    ev('s2_review_resumed', { decision: 'continue', note: '', corrections: [{ ref: 'C-1', severity: 'should', action: 'skip', reason: 'r' }] })];
  assert.equal(reviewLoopState(fb).state, 'done');
  assert.equal(reviewLoopStateReference(fb).state, 'done');
});

test('on a High lane a continue with nothing to fix starts the final review, and the start says no fix was sent', () => {
  const pass = [
    ev('lane_open'), ev('s1_ready', { depth: 'standard' }), ev('s1_go'), ev('s2_start'), ev('s2_result', { outcome: 'success' }),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1', 'R1'], head: 'h1', depth: 'standard', max_fix_rounds: 2, close_on: 'must', extras: ['high_risk'], mapped_routes: 1, route_count: 1, whole_run_ids: ['B1'], run_labels: ['', 'r1'] }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: [], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', action: 'fix' }], rejected: [], escalated_claims: ['どこまで'] }),
    ev('s2_review_escalated', { reason: '判定が penne の判断を求めた指摘がある' }),
    ev('s2_review_resumed', { decision: 'continue', note: '', corrections: [{ ref: '1-blind/F-1', severity: 'should', action: 'skip', reason: 'r' }] }),
  ];
  assert.deepEqual(reviewLoopState(pass), { state: 'start_blind', kind: 'final', round: 1 });
  assert.deepEqual(reviewLoopStateReference(pass), { state: 'start_blind', kind: 'final', round: 1 });
  const policy = { highRiskWhen: 'last', extras: { first_round: 0, high_risk: 1 }, extraRoles: { first_round: [], high_risk: ['h'] } };
  const facts = { reviewOn: true, blindFits: true, at: { worktree: '/w', base: 'b', head: 'h1' }, policy, extras: ['high_risk'], runs: [{ state: 'started', runIds: ['F1'], runRoles: ['h'] }] };
  const step = reviewNextStep(pass, facts);
  assert.equal(step.event, 's2_review_started');
  assert.equal(step.attrs.kind, 'final');
  assert.equal(step.attrs.after_zero_fix, true);
  assert.match(String(step.attrs.after_zero_fix_reason), /直す対象が 0 件/);
  assert.deepEqual(JSON.parse(JSON.stringify(nextStepReference(pass, facts))), JSON.parse(JSON.stringify(step)));
});

test('a continue after the stop of a head the fix left carries the note that fix went with, and sends it again', () => {
  const asked = [ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, head: 'h1' }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: 'c', action: 'followup' }], rejected: [], escalated_claims: ['どちらの案か'] }),
    ev('s2_review_escalated', { reason: '判定が penne の判断を求めた指摘がある' }),
    ev('s2_review_resumed', { decision: 'continue', note: 'A 案で直す' }),
    ev('s2_fix_sent', { round: 1, refs: [], envelope_id: 'fix-IDD-001-r1', how_refs: [] }), ev('s2_result'),
    ev('s2_review_escalated', { reason: '手直しで head が変わらなかった（h1）' }),
    ev('s2_review_resumed', { decision: 'continue', note: '' })];
  assert.equal(reviewLoopState(asked).state, 'send_fix');
  assert.equal(reviewLoopStateReference(asked).state, 'send_fix');
  assert.equal(fixScope(asked).note, 'A 案で直す');
  assert.equal(fixScopeReference(asked).note, 'A 案で直す');
  // the answer's own note wins over the carried one
  const own = [...asked.slice(0, -1), ev('s2_review_resumed', { decision: 'continue', note: 'B 案にする' })];
  assert.equal(fixScope(own).note, 'B 案にする');
  assert.equal(fixScopeReference(own).note, 'B 案にする');
});

/** IDD-290 to its fourth round's fix: the cap stop answered with a continue, the fix sent, and the head it left unmoved */
function fourthRoundFix(head) {
  return [
    ...capPass('b', ['h1', 'h2', 'h3']), capStop, ev('s2_review_resumed', { decision: 'continue', note: '直す', at_by: 'user' }),
    ev('s2_fix_sent', { round: 3, refs: ['3-blind/F-4'], envelope_id: 'fix-IDD-001-r3', how_refs: [] }), ev('s2_result', { outcome: 'success' }),
    ev('s2_review_started', { kind: 'blind', round: 4, run_ids: ['B4'], head }), ev('s2_review_findings', { kind: 'blind', round: 4, files: [], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'blind', round: 4, accepted: [
      { ref: 'F-1', severity: 'should', claim: 'e', path: 'a.dart', fix: 'f', action: 'fix' },
      { ref: 'F-2', severity: 'must', claim: 'g', path: 'b.dart', fix: 'f', action: 'fix' },
    ], rejected: [], escalated_claims: [] }),
    ev('s2_review_escalated', { reason: '修正が 3 巡に達した' }), ev('s2_review_resumed', { decision: 'continue', note: '直す', at_by: 'user' }),
    ev('s2_fix_sent', { round: 4, refs: ['4-blind/F-1', '4-blind/F-2'], envelope_id: 'fix-IDD-001-r4', how_refs: [] }), ev('s2_result', { outcome: 'success' }),
    ev('s2_review_escalated', { reason: `手直しで head が変わらなかった（${head}）`, head }),
  ];
}
const setBothAside = ev('s2_review_resumed', { decision: 'continue', note: '', at_by: 'user', corrections: [
  { ref: '4-blind/F-1', severity: 'should', action: 'skip', reason: 'r' },
  { ref: '4-blind/F-2', severity: 'should', action: 'skip', reason: 'r' },
] });
const FINAL_FACTS = { reviewOn: true, blindFits: true, at: { worktree: '/w', base: 'b', head: 'h4' }, runs: [{ state: 'started', runIds: ['F1'] }] };

test('after the stop of a head the fix left, a continue that sets every finding aside sends no fix again: it goes where nothing to fix goes', () => {
  const events = [...fourthRoundFix('h4'), setBothAside];
  assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'final', round: 5 });
  assert.deepEqual(reviewLoopStateReference(events), { state: 'start_blind', kind: 'final', round: 5 });
  const step = reviewNextStep(events, FINAL_FACTS);
  assert.equal(step.event, 's2_review_started');
  assert.equal(step.attrs.after_zero_fix, true);
  assert.deepEqual(JSON.parse(JSON.stringify(nextStepReference(events, FINAL_FACTS))), JSON.parse(JSON.stringify(step)));
  // a continue that leaves a finding sends the fix again
  const keep = [...fourthRoundFix('h4'), ev('s2_review_resumed', { decision: 'continue', note: '', at_by: 'user' })];
  assert.equal(reviewLoopState(keep).state, 'send_fix');
  assert.equal(reviewLoopStateReference(keep).state, 'send_fix');
});

test('a final the zero-fix continue led to keeps its mark when its start failed and penne retried it', () => {
  const events = [...fourthRoundFix('h4'), setBothAside,
    ev('s2_review_escalated', { reason: 'レビューの段を起動できない', retry_state: { state: 'start_blind', kind: 'final', round: 5 } }),
    ev('s2_review_resumed', { decision: 'continue', note: '' })];
  assert.deepEqual(reviewLoopState(events), { state: 'start_blind', kind: 'final', round: 5 });
  const step = reviewNextStep(events, FINAL_FACTS);
  assert.equal(step.event, 's2_review_started');
  assert.equal(step.attrs.after_zero_fix, true);
  assert.deepEqual(JSON.parse(JSON.stringify(nextStepReference(events, FINAL_FACTS))), JSON.parse(JSON.stringify(step)));
  // a retry of a stage no zero-fix continue led to carries no mark
  const plain = [...fourthRoundFix('h4').slice(0, -1), ev('s2_review_escalated', { reason: 'x', retry_state: { state: 'start_blind', kind: 'final', round: 5 } }), ev('s2_review_resumed', { decision: 'continue', note: '' })];
  const unmarked = reviewNextStep(plain, FINAL_FACTS);
  assert.equal(unmarked.attrs.after_zero_fix, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(nextStepReference(plain, FINAL_FACTS))), JSON.parse(JSON.stringify(unmarked)));
});

test('the question the note answers is read from the last judgement that did not fail', () => {
  const events = [ev('s2_result'),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [], rejected: [], escalated_claims: ['どちらの案か'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, failed: true, error: 'x' }),
    ev('s2_review_resumed', { decision: 'continue', note: 'A 案で直す' })];
  assert.equal(sendsNothing(events), false);
});

test("penne's accept converges with no reason of its own, as before", () => {
  const events = [...capPass('b', ['h1', 'h2', 'h3']), capStop, ev('s2_review_resumed', { decision: 'accept', note: '', corrections: zeroContinue.attrs.corrections })];
  const step = reviewNextStep(events, {});
  assert.deepEqual(step, { leg: 'converge', action: 'write', event: 's2_review_converged', attrs: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(nextStepReference(events, {}))), step);
});

test('a continue that leaves a finding for the fix still sends it', () => {
  const events = [...capPass('b', ['h1', 'h2', 'h3']), capStop, ev('s2_review_resumed', { decision: 'continue', note: '直す', at_by: 'user' })];
  assert.equal(reviewLoopState(events).state, 'send_fix');
  assert.equal(reviewLoopStateReference(events).state, 'send_fix');
});

test('the stop card tells which findings a continue sends; a note answering a question still goes as the fix, one answering none does not', () => {
  const { wt, base } = setup();
  const head = headOf(wt);
  const stopped = [...capPass(base, ['h1', 'h2', head]), capStop];
  const sends = stuckOutcomes(ID, stopped);
  assert.equal(sends?.continue.to, 'fix');
  assert.deepEqual(sends?.continue.refs, ['3-blind/F-4']);
  // the judgement asked penne a question and nothing else is sent: her note is the instruction, and it still goes
  const asked = [...capPass(base, ['h1', 'h2', head]).slice(0, -1),
    ev('s2_triage_done', { kind: 'blind', round: 3, accepted: [{ ref: 'F-1', severity: 'should', claim: 'c', action: 'followup' }], rejected: [], escalated_claims: ['どこまで直すか'] }),
    ev('s2_review_escalated', { reason: '判定が penne の判断を求めた指摘がある' })];
  assert.equal(stuckOutcomes(ID, asked)?.continueWithNote.to, 'fix');
  assert.equal(reviewLoopState([...asked, ev('s2_review_resumed', { decision: 'continue', note: 'A 案で直す' })]).state, 'send_fix');
  // the same note on a stop that asked nothing answers no question: with nothing in the scope, no fix goes
  const noQuestion = [...stopped, ev('s2_review_resumed', { decision: 'continue', note: '境目だけ', corrections: zeroContinue.attrs.corrections })];
  assert.notEqual(reviewLoopState(noQuestion).state, 'send_fix');
  assert.equal(reviewLoopState(noQuestion).state, reviewLoopStateReference(noQuestion).state);
});

test('a fix that left the head where the last round read it does not start the next round on the same head', async () => {
  const { state, wt, base } = setup();
  const head = headOf(wt);
  const events = [
    ev('lane_open'), ev('s1_ready', { depth: 'standard' }), ev('s1_go'), ev('s2_start', { started_from_commit: base }), ev('s2_result', { outcome: 'success' }),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'], head, depth: 'standard', max_fix_rounds: 2, close_on: 'must' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b1.json'], failed_runs: 0 }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'a', path: 'a.dart', fix: 'f', action: 'fix' }], rejected: [], escalated_claims: [] }),
    ev('s2_fix_sent', { round: 1, refs: ['1-blind/F-1'], envelope_id: 'fix-IDD-001-r1', how_refs: [] }),
    ev('s2_result', { outcome: 'success' }),
  ];
  const at = { worktree: wt, base, head };
  // both readings stop for penne on the unmoved head, and say why
  const step = reviewNextStep(events, { reviewOn: true, blindFits: true, at });
  assert.equal(step.event, 's2_review_escalated');
  assert.match(String(step.attrs.reason), /手直しで head が変わらなかった/);
  assert.equal(step.attrs.retry_state, undefined, 'continuing sends the fix again rather than reviewing the same head');
  assert.deepEqual(JSON.parse(JSON.stringify(nextStepReference(events, { reviewOn: true, blindFits: true, at }))), JSON.parse(JSON.stringify(step)));
  // a head that moved starts the round as before
  const moved = reviewNextStep(events, { reviewOn: true, blindFits: true, at: { ...at, head: 'other' } });
  assert.notEqual(moved.event, 's2_review_escalated');

  seed(state, events);
  const started = runner();
  await runReviewLoop();
  const after = readLifecycle().slice(events.length);
  assert.ok(!after.some((e) => e.event === 's2_review_started'), 'the same head is not reviewed again');
  assert.equal(after.at(-1)?.event, 's2_review_escalated');
  assert.match(String(after.at(-1)?.attrs?.reason), /手直しで head が変わらなかった/);
  assert.deepEqual(started, []);

  // penne continues: the fix goes again, under the next round's envelope
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '', at_by: 'user' });
  await runReviewLoop();
  const sent = readLifecycle().filter((e) => e.event === 's2_fix_sent');
  assert.equal(sent.length, 2);
  assert.equal(sent.at(-1).attrs.envelope_id, 'fix-IDD-001-r2');
  // the executor commits this time: the round reads the new head
  commit(wt, 'fix');
  await appendLifecycle('s2_result', ID, { outcome: 'success' });
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_started');
  assert.equal(readLifecycle().at(-1).attrs.head, headOf(wt));
});

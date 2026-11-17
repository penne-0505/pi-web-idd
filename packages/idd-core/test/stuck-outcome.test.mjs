import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop, stuckOutcomes } from '../src/plan/review-loop.ts';
import { buildSubmitReview } from '../src/plan/ship.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewLoopState, settledHead } from '../src/ledger/review-loop.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { tmpDir } from './helpers/tmp.mjs';

// What the stuck card says each button does is read from the same transition that then runs: every case here
// takes the card's outcome, answers, runs the loop, and compares what the loop recorded.

const ID = 'IDD-001';
const ev = (event, attrs = {}) => ({ event, idd_id: ID, at: '2026-09-01T10:00:00+09:00', attrs });

function setup(pipelineYaml) {
  const state = tmpDir('idd-stuck-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipelineYaml}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-stuck-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: ID, parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: ID, executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state, wt, head };
}

const SLOTS = '  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n';
const DEVICE = `${SLOTS}  device_check: { role: r }\n`;

/** the files the device stage decides from: a qa.md whose 全体 line declares a judge, and a set of pictures in compare/ */
function readyDevice(wt, judge = '絵を見る役') {
  const dir = join(wt, '_docs', 'qa', 'Demo', 'idd-001');
  mkdirSync(join(dir, 'compare'), { recursive: true });
  writeFileSync(join(dir, 'qa.md'), `## Acceptance Criteria\n\n- 全体: 画面が設計どおりに見える（判定: ${judge}）\n- AC-001: x\n`);
  writeFileSync(join(dir, 'compare', 'home-impl.png'), 'x');
  writeFileSync(join(dir, 'compare', 'home-proto.png'), 'x');
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'pictures']);
}

async function add(list) {
  for (const [event, attrs] of list) await seedLifecycle(event, ID, attrs ?? {});
}

function runner() {
  const started = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o.stage); const id = `${o.stage}-${started.length}`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  return { started, status, last: () => `${started.at(-1)}-${started.length}` };
}

/**
 * What the loop did after penne's answer, in the card's terms: ticks until it sent a fix, started a stage, or
 * closed the review (and then started or skipped the device check), or stopped moving.
 */
async function actual() {
  const from = readLifecycle().length;
  for (let i = 0; i < 4; i += 1) {
    await runReviewLoop();
    const added = readLifecycle().slice(from);
    const fix = added.find((e) => e.event === 's2_fix_sent');
    if (fix) return { to: 'fix', refs: fix.attrs.refs };
    if (added.some((e) => e.event === 's2_review_converged') || reviewLoopState(readLifecycle()).state === 'done') {
      if (added.some((e) => e.event === 's2_device_started')) return { to: 'close', device: readLifecycle().slice(0, from).some((e) => e.event === 's2_device_started') ? 'again' : 'first' };
      if (reviewLoopState(readLifecycle()).state === 'done') return { to: 'close', device: 'none' };
      continue;
    }
    // a stage that started: which one, as recorded
    const started = added.find((e) => /_started$/.test(e.event));
    if (started) return { to: 'started', stage: started.event, ...(started.attrs.kind ? { kind: started.attrs.kind } : {}) };
  }
  return { to: 'none', state: reviewLoopState(readLifecycle()).state };
}

const pick = (o) => (o.to === 'fix' ? { to: 'fix', refs: o.refs } : o.to === 'close' ? { to: 'close', device: o.device } : { to: o.to });
/**
 * The card's outcome against what the loop recorded. "final" is the final review started; "retry" is the stage the
 * stop was over started again, which the caller names (`stage`, and `kind` for a review).
 */
const same = (card, got, retried) => {
  if (card.to === 'final') return assert.deepEqual(got, { to: 'started', stage: 's2_review_started', kind: 'final' });
  if (card.to === 'retry') return assert.deepEqual(got, { to: 'started', ...retried });
  assert.deepEqual(pick(card), got);
};

const blindQuestion = (head, accepted, extra = {}, findingsExtra = {}) => [
  ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'], ...(head ? { head } : {}), ...extra }],
  ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'], ...findingsExtra }],
  ['s2_triage_started', { kind: 'blind', round: 1, run_id: 't' }],
  ['s2_triage_done', { kind: 'blind', round: 1, accepted, escalated_claims: ['仕様が決まっていない'] }],
];
const nit = (ref, claim) => ({ ref, severity: 'nit', claim, path: 'a.ts', fix: 'f' });
const should = (ref, claim) => ({ ref, severity: 'should', claim, path: 'a.ts', fix: 'f' });
const must = (ref, claim) => ({ ref, severity: 'must', claim, path: 'a.ts', fix: 'f' });

test('continuing with a note goes to the fix the card names, and without one where the card says', async () => {
  for (const note of ['A 案で直す', '']) {
    const { head } = setup(SLOTS);
    await add(blindQuestion(head, [should('F-2', '境界の扱い'), nit('F-1', '言い回し')]));
    const r = runner();
    await runReviewLoop();
    assert.equal(readLifecycle().at(-1).event, 's2_review_escalated');
    const card = stuckOutcomes(ID, readLifecycle());
    const said = note ? card.continueWithNote : card.continue;
    if (note) {
      assert.deepEqual(pick(said), { to: 'fix', refs: ['F-2'] });
      assert.equal(said.note, true);
      assert.deepEqual(said.left, { accepted: 1, questions: 0, reversals: 0 }, 'the nit stays; the question went with the note');
    } else {
      // the blind read this very head and its judgement is within the limit: the final review is skipped
      assert.deepEqual(pick(said), { to: 'close', device: 'none' });
      assert.deepEqual(said.left, { accepted: 2, questions: 1, reversals: 0 });
    }
    await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note });
    same(said, await actual());
    setAgentRunner(null);
  }
});

test('a head the code moved from since the blind is not settled: the card says the final review runs, and it does', async () => {
  const { head, wt } = setup(SLOTS);
  await add(blindQuestion(head, [nit('F-1', '言い回し')]));
  writeFileSync(join(wt, 'x.txt'), 'moved');
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'moved']);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.equal(card.continue.to, 'final');
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual());
  setAgentRunner(null);
});

test('a blind some of whose roles ran on a fallback for Claude\'s windows is not a whole-diff read: the final review runs', async () => {
  const { head } = setup(SLOTS);
  const fallbacks = [{ role: 'opus', fallback: 'r', reason: 'window' }];
  await add(blindQuestion(head, [nit('F-1', '言い回し')], { fallbacks }));
  assert.equal(settledHead(readLifecycle()), undefined);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.equal(card.continue.to, 'final');
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual());
  setAgentRunner(null);
});

test('a blind a role switched out of mid-run is not a whole-diff read: the final review runs', async () => {
  const { head } = setup(SLOTS);
  // the role change lands on the round's closing record (a mid-run switch), not on its start
  const fallbacks = [{ role: 'opus', fallback: 'r', reason: 'timeout' }];
  await add(blindQuestion(head, [nit('F-1', '言い回し')], {}, { fallbacks }));
  assert.equal(settledHead(readLifecycle()), undefined);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.equal(card.continue.to, 'final');
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual());
  setAgentRunner(null);
});

test('a blind a role only switched provider in mid-run still counts as a whole-diff read: the final review is skipped', async () => {
  const { head } = setup(SLOTS);
  // role === fallback says the reader stayed the same, only the provider under it moved
  const fallbacks = [{ role: 'r', fallback: 'r', reason: 'provider fault', provider: 'openrouter' }];
  await add(blindQuestion(head, [nit('F-1', '言い回し')], {}, { fallbacks }));
  assert.equal(settledHead(readLifecycle()), head);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.deepEqual(pick(card.continue), { to: 'close', device: 'none' });
  setAgentRunner(null);
});

test('an answer to a stop over a stage that could not start retries it, and the judgement answered before stays on the submit card', async () => {
  setup(SLOTS);
  // a blind without a head on record: its final review is never skipped
  await add([
    ...blindQuestion(undefined, [nit('N-1', '命名の揺れ')]),
    ['s2_review_escalated', { reason: '判定が penne の判断を求めた指摘がある' }],
    ['s2_review_resumed', { decision: 'continue', note: '' }],
    ['s2_review_run_failed', { state: 'start_blind', error: 'disk' }], ['s2_review_run_failed', { state: 'start_blind', error: 'disk' }], ['s2_review_run_failed', { state: 'start_blind', error: 'disk' }],
    ['s2_review_escalated', { reason: 'レビューの段を起動できない: disk', retry_state: { state: 'start_blind', kind: 'final', round: 1 } }],
  ]);
  const r = runner();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.equal(card.continue.to, 'retry');
  assert.equal(card.continueWithNote.to, 'retry', 'a note does not turn a retry into a fix');
  assert.deepEqual(pick(card.accept), { to: 'close', device: 'none' });
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual(), { stage: 's2_review_started', kind: 'final' });
  assert.deepEqual(r.started, ['final']);
  // the final review closes the loop by itself
  r.status[r.last()] = { state: 'done', reportJson: '/f.json', reportMd: '/f.md', findings: [] };
  await runReviewLoop(); await runReviewLoop();
  r.status[r.last()] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'nit', claim: '空行', path: 'b.ts' }] };
  await runReviewLoop(); await runReviewLoop(); await runReviewLoop();
  assert.equal(reviewLoopState(readLifecycle()).state, 'done');
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'loop', 'the loop closed on its own final review; the retry decided nothing');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [
    ['nit', '空行'],
    ['nit', '命名の揺れ'],
    ['判断', '仕様が決まっていない（判定が penne の判断を求めた指摘。直す指示を出さずに進めた）'],
  ]);
  setAgentRunner(null);
});

test('going on after a stop at the device check closes the review and runs the device check again, as the card says', async () => {
  const { wt } = setup(DEVICE);
  readyDevice(wt);
  await add([
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['f'] }], ['s2_review_findings', { kind: 'final', round: 1, files: [] }],
    ['s2_triage_done', { kind: 'final', round: 1, accepted: [] }], ['s2_review_converged', {}],
    ['s2_device_started', { round: 1, run_id: 'D' }], ['s2_device_done', { round: 1, blocking: 2, files: ['/d.json'] }],
    ['s2_triage_started', { kind: 'device', round: 1, run_id: 'T' }],
    ['s2_triage_done', { kind: 'device', round: 1, accepted: [must('M-1', '再生が止まる'), must('M-2', '通知が残る')], escalated_claims: ['端末ごとの差か'] }],
  ]);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.deepEqual(pick(card.continue), { to: 'fix', refs: ['M-1', 'M-2'] });
  assert.deepEqual(pick(card.accept), { to: 'close', device: 'again' });
  assert.deepEqual(card.accept.left, { accepted: 2, questions: 1, reversals: 0 });
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  same(card.accept, await actual());
  r.status[r.last()] = { state: 'done', reportJson: '/d2.json', reportMd: '/d2.md', findings: [] };
  await runReviewLoop();
  assert.equal(reviewLoopState(readLifecycle()).state, 'done');
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'penne');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [
    ['must', '再生が止まる'], ['must', '通知が残る'],
    ['判断', '端末ごとの差か（判定が penne の判断を求めた指摘。直す指示を出さずに進めた）'],
  ]);
  setAgentRunner(null);
});

test('a question on PR feedback that accepted nothing: continuing leaves the code as it is and the submit card says penne closed it', async () => {
  setup(SLOTS);
  await add([
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['f'] }], ['s2_triage_done', { kind: 'final', round: 1, accepted: [nit('O-1', '前の巡の nit')] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}], ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }], ['s4_submit_started', {}], ['s4_pr_created', { pr_number: 7 }],
    ['s4_review_comment_received', { files: ['/fb.json'] }],
    ['s2_triage_started', { kind: 'feedback', round: 1, run_id: 'T' }],
    ['s2_triage_done', { kind: 'feedback', round: 1, accepted: [], escalated_claims: ['返信の要否'] }],
  ]);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.deepEqual(pick(card.continue), { to: 'close', device: 'none' });
  assert.deepEqual(pick(card.continueWithNote), { to: 'fix', refs: [] });
  assert.equal(card.continueWithNote.all, true);
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual());
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'penne', 'a continue that sent no fix closed the review as going on does');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [['判断', '返信の要否（判定が penne の判断を求めた指摘。直す指示を出さずに進めた）']], 'only this pass: the earlier pass\'s nit is not listed again');
  setAgentRunner(null);
});

test('continuing without a note on the final review\'s question closes the review: the submit card says penne closed it, with the question', async () => {
  setup(SLOTS);
  await add([
    ['s2_review_started', { kind: 'final', round: 2, run_ids: ['f'] }], ['s2_review_findings', { kind: 'final', round: 2, files: [] }],
    ['s2_triage_done', { kind: 'final', round: 2, accepted: [nit('F-1', '言い回し')], escalated_claims: ['既定値を変えるか'] }],
  ]);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.deepEqual(pick(card.continue), { to: 'close', device: 'none' });
  assert.deepEqual(card.continue, card.accept, 'continuing without a note does what going on does');
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual());
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'penne');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [
    ['nit', '言い回し'], ['判断', '既定値を変えるか（判定が penne の判断を求めた指摘。直す指示を出さずに進めた）'],
  ]);
  setAgentRunner(null);
});

test('the submit card reads a lane recorded by an earlier version from what was sent, not from the current transition', () => {
  // an earlier version sent an empty fix after a question over nits only; the loop then closed at its final review
  const e = [
    ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [nit('F-1', '言い回し'), nit('F-2', '空行')], escalated_claims: ['仕様が決まっていない'] }),
    ev('s2_review_escalated', { reason: 'q' }), ev('s2_review_resumed', { decision: 'continue', note: '' }),
    ev('s2_fix_sent', { round: 1, refs: [] }), ev('s2_result'), ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0, files: [] }),
    ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['f'] }), ev('s2_triage_done', { kind: 'final', round: 2, accepted: [nit('F-9', '空行')] }),
    ev('s2_review_converged'), ev('s2_device_skipped'),
  ];
  const review = buildSubmitReview(e);
  assert.equal(review.closedBy, 'loop');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [
    ['nit', '空行'], ['nit', '言い回し'],
    ['判断', '仕様が決まっていない（判定が penne の判断を求めた指摘。直す指示を出さずに進めた）'],
  ], 'the same words named again are listed once');
  // a question answered with a note that went with the fix was answered; the fix's refs say what was fixed
  const noted = e.map((x) => (x.event === 's2_review_resumed' ? ev('s2_review_resumed', { decision: 'continue', note: 'A 案で' }) : x.event === 's2_fix_sent' ? ev('s2_fix_sent', { round: 1, refs: ['F-1'] }) : x));
  assert.deepEqual(buildSubmitReview(noted).leftovers.map((l) => l.claim), ['空行']);
});

test('the judgements of an earlier pass and judgements penne did not answer are not picked up again', () => {
  const e = [
    ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [must('F-1', '落ちる'), nit('F-2', '言い回し')] }),
    ev('s2_fix_sent', { round: 1, refs: ['F-1'] }), ev('s2_result'), ev('s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0, files: [] }),
    ev('s2_review_started', { kind: 'final', round: 2, run_ids: ['f'] }), ev('s2_triage_done', { kind: 'final', round: 2, accepted: [] }),
    ev('s2_review_converged'), ev('s2_device_skipped'),
  ];
  const review = buildSubmitReview(e);
  assert.equal(review.closedBy, 'loop');
  assert.deepEqual(review.leftovers, [], 'as before: an unanswered judgement\'s nit is not listed');
});

// a runner whose judgements and confirms answer as the case needs
function scripted(answers) {
  const started = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      started.push(o.stage);
      const id = `${o.stage}-${started.length}`;
      status[id] = answers[o.stage]?.shift() ?? { state: 'done', reportJson: `/${id}.json`, reportMd: `/${id}.md`, findings: [], decisions: [], items: [] };
      return { runIds: [id] };
    },
    reviewRunStatus: (id) => status[id],
  });
  return started;
}
const decide = (ref, severity, claim, path = 'a.ts') => ({ ref, verdict: 'accept', severity, claim, path, fix: 'f' });
async function until(pred, max = 20) {
  for (let i = 0; i < max && !pred(); i += 1) await runReviewLoop();
}

test('a fix whose confirm never finished stays on the submit card as unconfirmed when penne goes on as it is', async () => {
  setup(SLOTS);
  scripted({
    blind: [{ state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] }],
    triage: [{ state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [decide('F-1', 'must', '購読が残る'), decide('F-2', 'nit', '言い回し')] }],
    confirm: [{ state: 'failed', error: 'timeout' }],
  });
  await until(() => readLifecycle().at(-1).event === 's2_fix_sent');
  assert.deepEqual(readLifecycle().at(-1).attrs.refs, ['F-1']);
  await appendLifecycle('s2_result', ID, { outcome: 'success' });
  await until(() => reviewLoopState(readLifecycle()).state === 'escalated' && readLifecycle().at(-1).event === 's2_review_escalated');
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_confirm_done').attrs.failed, true);
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  const review = buildSubmitReview(readLifecycle());
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [
    ['must', '購読が残る（修正に回したが、直ったかを確かめずに進めた）'],
    ['nit', '言い回し'],
  ]);
  setAgentRunner(null);
});

test('in an S4 pass a reviewer\'s request whose confirm failed stays on the submit card as unconfirmed', async () => {
  setup(SLOTS);
  await add([
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['f'] }], ['s2_triage_done', { kind: 'final', round: 1, accepted: [] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}], ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }], ['s4_submit_started', {}], ['s4_pr_created', { pr_number: 7 }],
    ['s4_review_comment_received', { files: ['/fb.json'] }],
  ]);
  scripted({
    feedback: [{ state: 'done', reportJson: '/fb-t.json', reportMd: '/fb-t.md', decisions: [decide('C-1', 'nit', '変数名を揃える', 'b.ts')] }],
    feedback_confirm: [{ state: 'failed', error: 'timeout' }],
  });
  await until(() => readLifecycle().at(-1).event === 's2_fix_sent');
  await appendLifecycle('s2_result', ID, { outcome: 'success' });
  await until(() => readLifecycle().at(-1).event === 's2_review_escalated');
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  assert.deepEqual(buildSubmitReview(readLifecycle()).leftovers.map((l) => [l.severity, l.claim]), [['nit', '変数名を揃える（修正に回したが、直ったかを確かめずに進めた）']]);
  setAgentRunner(null);
});

test('the same words on different files are two leftovers; the same words on the same file are one', async () => {
  setup(SLOTS);
  scripted({
    triage: [{ state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [decide('F-1', 'nit', '空行が多い', 'a.ts'), decide('F-2', 'nit', '空行が多い', 'b.ts'), decide('F-3', 'nit', '空行が多い', 'a.ts')] }],
  });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  assert.ok(readLifecycle().some((e) => e.event === 's2_review_converged'));
  assert.deepEqual(buildSubmitReview(readLifecycle()).leftovers.map((l) => [l.claim, l.path]), [['空行が多い', 'a.ts'], ['空行が多い', 'b.ts']]);
  setAgentRunner(null);
});

test('a stage stopped before a final review the loop then skips: the card says the review closes, as the loop does', async () => {
  const { head } = setup(SLOTS);
  // a blind judged within the limit on this head, then the final review could not start three times
  await add([
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'], head }], ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }],
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: [nit('F-1', '言い回し')] }],
    ['s2_review_run_failed', { state: 'start_blind', error: 'disk' }], ['s2_review_run_failed', { state: 'start_blind', error: 'disk' }], ['s2_review_run_failed', { state: 'start_blind', error: 'disk' }],
    ['s2_review_escalated', { reason: 'レビューの段を起動できない: disk', retry_state: { state: 'start_blind', kind: 'final', round: 1 } }],
  ]);
  const r = runner();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.deepEqual(pick(card.continue), { to: 'close', device: 'none' });
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual());
  setAgentRunner(null);
});

test('a device check that failed is run again on continue, as the card says', async () => {
  const { wt } = setup(DEVICE);
  readyDevice(wt);
  await add([
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['f'] }], ['s2_triage_done', { kind: 'final', round: 1, accepted: [] }], ['s2_review_converged', {}],
    ['s2_device_started', { round: 1, run_id: 'D' }], ['s2_device_done', { round: 1, failed: true, error: 'adb' }],
  ]);
  const r = runner();
  await runReviewLoop();
  const card = stuckOutcomes(ID, readLifecycle());
  assert.deepEqual(card.continue, { to: 'retry' });
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  same(card.continue, await actual(), { stage: 's2_device_started' });
  assert.deepEqual(r.started, ['device']);
  setAgentRunner(null);
});

const done = (extra = {}) => ({ state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [], ...extra });

test('A: going on from a stall, then a device check penne had run again: the submit card still says penne closed it', async () => {
  const { wt } = setup(DEVICE);
  readyDevice(wt);
  const same2 = [must('M-1', '購読が残る'), must('M-2', '通知が残る')];
  await add([
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }], ['s2_review_findings', { kind: 'blind', round: 1, files: [] }],
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: same2 }], ['s2_fix_sent', { round: 1, refs: ['M-1', 'M-2'] }], ['s2_result', {}],
    ['s2_confirm_done', { round: 1, unresolved_must: 2, unresolved_refs: ['M-1', 'M-2'], files: [] }], ['s2_triage_done', { kind: 'confirm', round: 1, accepted: same2 }],
    ['s2_fix_sent', { round: 2, refs: ['M-1', 'M-2'] }], ['s2_result', {}],
    ['s2_confirm_done', { round: 2, unresolved_must: 2, unresolved_refs: ['M-1', 'M-2'], files: [] }], ['s2_triage_done', { kind: 'confirm', round: 2, accepted: same2 }],
  ]);
  scripted({ device: [{ state: 'failed', error: 'adb' }, done()] });
  await runReviewLoop();
  assert.match(readLifecycle().at(-1).attrs.reason, /戻ってくる|減らない/);
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  await until(() => readLifecycle().at(-1).event === 's2_review_escalated');
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_device_done').attrs.failed, true);
  assert.deepEqual(stuckOutcomes(ID, readLifecycle()).continue, { to: 'retry' });
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'penne');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [['must', '購読が残る'], ['must', '通知が残る']]);
  setAgentRunner(null);
});

test('B: continuing without a note closed the review, and a later device judgement within the limit ended it: penne closed it', async () => {
  const { wt } = setup(DEVICE);
  readyDevice(wt);
  await add([
    ['s2_review_started', { kind: 'final', round: 2, run_ids: ['f'] }], ['s2_review_findings', { kind: 'final', round: 2, files: [] }],
    ['s2_triage_done', { kind: 'final', round: 2, accepted: [nit('F-1', '言い回し')], escalated_claims: ['既定値を変えるか'] }],
  ]);
  scripted({
    device: [done({ findings: [{ severity: 'should', path: 'a.ts', claim: '余白', evidence: '' }] })],
    triage: [done({ decisions: [decide('D-1', 'nit', '余白が 2px 広い', 'b.ts')] })],
  });
  await runReviewLoop();
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_triage_done').attrs.kind, 'device');
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'penne');
  setAgentRunner(null);
});

test('C: a confirm that found the fix not made, whose judgement then failed: going on lists the fix as found unfixed', async () => {
  setup(SLOTS);
  scripted({
    triage: [done({ decisions: [decide('M-1', 'must', '購読が残る'), decide('F-1', 'nit', '言い回し')] }), { state: 'failed', error: 'timeout' }],
    confirm: [done({ items: [{ ref: 'M-1', resolved: false }] })],
  });
  await until(() => readLifecycle().at(-1).event === 's2_fix_sent');
  await appendLifecycle('s2_result', ID, { outcome: 'success' });
  await until(() => readLifecycle().at(-1).event === 's2_review_escalated');
  assert.deepEqual(readLifecycle().findLast((e) => e.event === 's2_confirm_done').attrs.unresolved_refs, ['M-1']);
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_triage_done').attrs.failed, true);
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'penne');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [
    ['must', '購読が残る（確認で直っていないと分かった）'],
    ['nit', '言い回し'],
  ]);
  setAgentRunner(null);
});

test('a final review whose judgement failed, closed by going on as it is: the blind\'s unfixed findings stay listed', async () => {
  const { wt } = setup(SLOTS);
  scripted({ triage: [done({ decisions: [decide('N-1', 'nit', '言い回し')] }), { state: 'failed', error: 'timeout' }] });
  await until(() => readLifecycle().at(-1).event === 's2_triage_done');
  // the code moved since the blind, so the final review runs
  writeFileSync(join(wt, 'y.txt'), 'moved');
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'moved']);
  await until(() => readLifecycle().at(-1).event === 's2_review_escalated');
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_triage_done').attrs.kind, 'final');
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_triage_done').attrs.failed, true);
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.closedBy, 'penne');
  assert.deepEqual(review.leftovers.map((l) => [l.severity, l.claim]), [['nit', '言い回し']]);
  setAgentRunner(null);
});

const escalate = (ref, claim) => ({ ref, verdict: 'escalate', severity: 'should', claim, path: 'a.ts' });

test('after the loop converged on its own, continuing past a device judgement\'s question does not make penne the closer', async () => {
  const { wt } = setup(DEVICE);
  readyDevice(wt);
  scripted({
    device: [done({ findings: [{ severity: 'should', path: 'a.ts', claim: '余白', evidence: '' }] })],
    triage: [done(), done({ decisions: [decide('D-1', 'nit', '余白が 2px 広い', 'b.ts'), escalate('D-2', '端末ごとの差か')] })],
  });
  await until(() => readLifecycle().at(-1).event === 's2_review_escalated');
  assert.ok(readLifecycle().some((e) => e.event === 's2_review_converged'), 'the loop closed the review itself');
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_triage_done').attrs.kind, 'device');
  await appendLifecycle('s2_review_resumed', ID, { decision: 'continue', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  assert.equal(buildSubmitReview(readLifecycle()).closedBy, 'loop');
  setAgentRunner(null);
});

test('after the loop converged on its own, going on past a device check that failed does not make penne the closer', async () => {
  const { wt } = setup(DEVICE);
  readyDevice(wt);
  scripted({ device: [{ state: 'failed', error: 'adb' }, done()] });
  await until(() => readLifecycle().at(-1).event === 's2_review_escalated');
  assert.equal(readLifecycle().findLast((e) => e.event === 's2_device_done').attrs.failed, true);
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  assert.equal(buildSubmitReview(readLifecycle()).closedBy, 'loop');
  setAgentRunner(null);
});

test('an S4 pass whose judgement failed, closed by going on as it is, does not list the earlier pass\'s leftovers again', async () => {
  setup(SLOTS);
  await add([
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['f'] }], ['s2_triage_done', { kind: 'final', round: 1, accepted: [nit('O-1', '前の巡の nit')] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}], ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }], ['s4_submit_started', {}], ['s4_pr_created', { pr_number: 7 }],
    ['s4_review_comment_received', { files: ['/fb.json'] }],
  ]);
  scripted({ feedback: [{ state: 'failed', error: 'timeout' }] });
  await until(() => readLifecycle().at(-1).event === 's2_review_escalated');
  await appendLifecycle('s2_review_resumed', ID, { decision: 'accept', note: '' });
  await until(() => reviewLoopState(readLifecycle()).state === 'done');
  const review = buildSubmitReview(readLifecycle());
  assert.deepEqual(review.leftovers, []);
  assert.equal(review.closedBy, 'penne');
  setAgentRunner(null);
});

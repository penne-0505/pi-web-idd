import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runPrFeedback, runPrReplies, waitingOnPr } from '../src/plan/pr-feedback.ts';
import { runReviewLoop } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';

const PR = 'https://github.com/o/r/pull/7';

function setup() {
  const root = scratchDir('prfb-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n  review_blind: { roles: [r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const wt = join(root, 'wt');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'Demo', title: 'T', context: '', source_type: 'github' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  const at = (m) => new Date(Date.now() - (60 - m) * 60_000).toISOString();
  const events = [
    ['s1_go', {}], ['s2_start', { started_from_commit: head }], ['s2_result', { outcome: 'success' }],
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B1'] }], ['s2_review_findings', { kind: 'blind', round: 1, files: [] }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 'T0' }], ['s2_triage_done', { kind: 'blind', round: 1, accepted: [], rejected: [] }],
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['B2'] }], ['s2_review_findings', { kind: 'final', round: 1, files: [] }],
    ['s2_triage_started', { kind: 'final', round: 1, run_id: 'T1' }], ['s2_triage_done', { kind: 'final', round: 1, accepted: [], rejected: [] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}], ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }],
    ['s4_submit_started', {}], ['s4_pr_created', { pr_url: PR, pr_number: 7, commit: 'aaaaaaa1111' }],
  ];
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events.map(([event, attrs], i) => JSON.stringify({ idd_id: 'IDD-1', event, at: at(i), attrs })).join('\n') + '\n');
  return { state, wt };
}

const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1');
const thread = (id, body, t = 'T1') => ({ id, kind: 'thread', author: 'rev', body, url: `${PR}#${id}`, created_at: '', thread_id: t, path: 'a.ts', line: 3 });

function runner(over = {}) {
  const queued = [];
  const started = [];
  let items = [];
  const status = new Map();
  const r = {
    outboundStatus: (id) => (status.has(id) ? { status: status.get(id) } : { status: 'ready' }),
    deliver: async () => {},
    fetchPrFeedback: () => ({ author: 'penne', head: 'bbbb2222', items }),
    prStatus: () => ({ head: 'bbbb2222', state: 'OPEN', title: 't', url: PR }),
    queueOutbound: async (o) => { queued.push(o); return { id: `OUT-${queued.length}` }; },
    startReviewRun: async (o) => { started.push(o); return { runIds: [`RUN-${started.length}`] }; },
    reviewRunStatus: () => ({ state: 'running' }),
    ...over,
  };
  setAgentRunner(r);
  return { r, queued, started, setItems: (next) => { items = next; }, setStatus: (id, st) => status.set(id, st) };
}

test('a lane waiting on its PR takes in new feedback once, and only after the last batch was answered', async () => {
  setup();
  const { setItems } = runner();
  assert.equal(waitingOnPr(lane()), true);
  setItems([thread('C1', 'ここが壊れる'), { id: 'ci:test@bbbb2222', kind: 'ci', author: 'ci', body: 'test が失敗\nlog', url: '', created_at: '' }]);
  assert.deepEqual((await runPrFeedback()).recorded, [{ iddId: 'IDD-1', items: 2 }]);
  const rec = lane().filter((e) => e.event === 's4_review_comment_received');
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].attrs.items.map((i) => i.ref), ['C-1', 'C-2']);
  assert.match(readFileSync(rec[0].attrs.files[0], 'utf8'), /## C-1 インラインの指摘 · rev · a\.ts:3[\s\S]*ここが壊れる/);
  // the batch now goes to the triage, so the lane is no longer waiting and nothing more is polled
  assert.equal(reviewLoopState(lane()).state, 'start_triage');
  assert.equal(waitingOnPr(lane()), false);
  assert.equal((await runPrFeedback()).recorded.length, 0);
  setAgentRunner(null);
});

test('feedback with nothing accepted leaves the code alone and drafts the replies right away', async () => {
  setup();
  const { r, queued, setItems, setStatus } = runner();
  setItems([thread('C1', '命名を変えては'), { id: 'R1', kind: 'review', author: 'bot', body: '要約です', url: `${PR}#R1`, created_at: '' }, thread('C3', 'ついでに旧 API も', 'T3')]);
  await runPrFeedback();
  await appendLifecycle('s2_triage_started', 'IDD-1', { kind: 'feedback', round: 1, run_id: 'X' });
  await appendLifecycle('s2_triage_done', 'IDD-1', {
    kind: 'feedback', round: 1, accepted: [],
    rejected: [
      { ref: 'C-1', severity: 'nit', claim: '命名の変更', reason: '公開の API 名なので変えない' },
      { ref: 'C-2', severity: 'nit', claim: '要約', reason: '要約だけ', no_request: true },
      { ref: 'C-3', severity: 'should', claim: '旧 API の整理', reason: 'この PR の責務の外', followup: true },
    ],
    escalated_claims: [],
  });
  assert.equal(reviewLoopState(lane()).state, 'done');
  assert.equal(waitingOnPr(lane()), true, 'still waiting on the PR');
  // a new comment before these replies are drafted waits: it would take the place of this batch
  setItems([thread('C1', '命名を変えては'), thread('C9', 'もう 1 点', 'T9')]);
  assert.equal((await runPrFeedback()).recorded.length, 0);
  const drafted = await runPrReplies();
  assert.equal(drafted.queued.length, 1);
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  assert.deepEqual(replies.target, { repo: 'o/r', pr: 7, expectHead: 'bbbb2222' });
  // the summary asked for nothing, so it gets no reply; nothing is resolved without a fix
  assert.deepEqual(replies.parts.map((p) => [p.ref, p.resolve]), [['C-1', false], ['C-3', false]]);
  assert.match(replies.parts[0].draft, /直していません。公開の API 名/);
  assert.match(replies.parts[1].draft, /別の Issue で扱います/);
  const issue = queued.find((q) => q.kind === 'gh-issue');
  assert.equal(issue.title, '旧 API の整理');
  assert.match(issue.body, /#C3/);
  assert.equal((await runPrReplies()).queued.length, 0, 'drafted once');
  // while the card waits for penne, the new comment still waits: its fix would move the head the replies were drafted against
  assert.equal((await runPrFeedback()).recorded.length, 0);
  // a runner that cannot tell how the card stands waits as well
  const withStatus = r.outboundStatus;
  delete r.outboundStatus;
  assert.equal((await runPrFeedback()).recorded.length, 0);
  r.outboundStatus = withStatus;
  // once penne posted (or discarded) the replies, the new comment comes in on its own
  setStatus('OUT-1', 'discarded');
  const next = await runPrFeedback();
  assert.deepEqual(next.recorded, [{ iddId: 'IDD-1', items: 1 }]);
  assert.deepEqual(lane().filter((e) => e.event === 's4_review_comment_received').at(-1).attrs.items.map((i) => i.id), ['C9']);
  setAgentRunner(null);
});

test('accepted feedback is fixed whatever its severity, and the replies wait for the push that carries the fix', async () => {
  setup();
  const decisions = [
    { ref: 'C-1', verdict: 'accept', severity: 'nit', claim: '変数名が紛らわしい', path: 'a.ts', fix: '名前で役割が分かる' },
    { ref: 'C-2', verdict: 'accept', severity: 'must', claim: 'null で落ちる', path: 'b.ts', fix: 'null でも落ちない' },
  ];
  const { queued, started, setItems } = runner({ reviewRunStatus: () => ({ state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [], decisions }) });
  setItems([thread('C1', '名前が分かりにくい'), thread('C2', 'null で落ちます', 'T2')]);
  await runPrFeedback();
  await runReviewLoop();
  assert.equal(started[0].stage, 'feedback', 'the PR feedback has its own triage instructions');
  // its reasons go back to the reviewer as they are: the harness's rules over the repo's are not handed to it
  assert.equal(started[0].norms, undefined);
  assert.ok(started[0].inputs.some((p) => p.endsWith('feedback.md')));
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_triage_done');
  await runReviewLoop();
  const fix = lane().at(-1);
  assert.equal(fix.event, 's2_fix_sent');
  assert.deepEqual(fix.attrs.refs, ['C-1', 'C-2'], 'the nit a reviewer asked for is fixed too');
  const d = deriveStage(lane());
  assert.equal(d.group, 'impl');
  assert.equal((await runPrReplies()).queued.length, 0, 'no reply before the fix is pushed');
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  assert.equal(reviewLoopState(lane()).state, 'start_confirm', 'the entry blind is skipped');
  // the rest of the way: confirm, final blind, S3, the submit card and penne's push
  for (const [event, attrs] of [['s2_confirm_started', { round: 1, run_id: 'C' }], ['s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0 }],
    ['s2_review_started', { kind: 'final', round: 2, run_ids: ['F'] }], ['s2_review_findings', { kind: 'final', round: 2, files: [] }],
    ['s2_triage_started', { kind: 'final', round: 2, run_id: 'T' }], ['s2_triage_done', { kind: 'final', round: 2, accepted: [], rejected: [] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}]]) await seedLifecycle(event, 'IDD-1', attrs);
  assert.equal(reviewLoopState(lane()).state, 'done');
  assert.equal(waitingOnPr(lane()), false, 'a fix on its way to S3 is not a PR wait');
  for (const [event, attrs] of [['s3_ready', {}], ['s3_ok', { at_by: 'auto' }], ['s4_submit_started', {}], ['s4_pr_created', { pr_url: PR, pr_number: 7, commit: 'cccc3333dddd' }]]) await seedLifecycle(event, 'IDD-1', attrs);
  assert.equal(waitingOnPr(lane()), true);
  await runPrReplies();
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  assert.deepEqual(replies.parts.map((p) => [p.ref, p.resolve]), [['C-1', true], ['C-2', true]]);
  assert.match(replies.parts[1].draft, /直しました（cccc333）/);
  setAgentRunner(null);
});

test('a budget stop recorded while the lane only waited on its PR does not keep its feedback out', async () => {
  // waiting on a PR spends nothing, so the budget is judged again once the feedback makes the lane work
  setup();
  let polled = 0;
  runner({ fetchPrFeedback: () => { polled += 1; return { author: 'penne', head: 'h', items: [] }; } });
  await appendLifecycle('lane_over_budget', 'IDD-1', { cost: 6, limit: 5, parts: [] });
  await runPrFeedback();
  assert.equal(polled, 1);
  setAgentRunner(null);
});

test('a lane stopped for its budget while answering its feedback is not polled for more', async () => {
  setup();
  let polled = 0;
  runner({ fetchPrFeedback: () => { polled += 1; return { author: 'penne', head: 'h', items: [] }; } });
  await appendLifecycle('s4_review_comment_received', 'IDD-1', { repo: 'o/r', pr: 7, head: 'h', files: [], items: [] });
  await appendLifecycle('lane_over_budget', 'IDD-1', { cost: 6, limit: 5, parts: [] });
  await runPrFeedback();
  assert.equal(polled, 0);
  setAgentRunner(null);
});

/** from a lane waiting on its PR: the feedback came in, the triage accepted these, and the fix went to the executor */
async function fixedFeedback(decisions) {
  setup();
  const ctx = runner({ reviewRunStatus: () => ({ state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [], decisions }) });
  ctx.setItems([thread('C1', '名前が分かりにくい'), thread('C2', 'null で落ちます', 'T2')]);
  await runPrFeedback();
  await runReviewLoop();
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_fix_sent');
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  return { ...ctx, state: process.env.IDD_STATE_DIR };
}

const s4Decisions = [
  { ref: 'C-1', verdict: 'accept', severity: 'nit', claim: '変数名が紛らわしい', path: 'a.ts', fix: '名前で役割が分かる' },
  { ref: 'C-2', verdict: 'accept', severity: 'must', claim: 'null で落ちる', path: 'b.ts', fix: 'null でも落ちない' },
];

test('the confirm after a fix of PR feedback checks every accepted request by its ref, the nit included', async () => {
  const { r, started } = await fixedFeedback(s4Decisions);
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_confirm_started');
  const confirm = started.at(-1);
  assert.equal(confirm.stage, 'feedback_confirm', 'the PR feedback has its own confirm instructions');
  assert.equal(confirm.norms, undefined);
  const scope = confirm.inputs.find((p) => /confirm-\d+\.md$/.test(p));
  assert.ok(scope, 'the confirm is handed the list of refs to check');
  const text = readFileSync(scope, 'utf8');
  assert.match(text, /C-1/);
  assert.match(text, /C-2/);
  // the executor left the nit alone and the confirm did not report on it: that is not a resolved request
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'C-2', resolved: true }] });
  await runReviewLoop();
  const done = lane().at(-1);
  assert.equal(done.event, 's2_confirm_done');
  assert.deepEqual(done.attrs.unresolved_refs, ['C-1']);
  assert.equal(done.attrs.unresolved_requests, 1);
  assert.equal(reviewLoopState(lane()).state, 'start_triage', 'an unresolved request goes back to the fix, not on to the final blind');
  setAgentRunner(null);
});

test('an accepted nit a PR confirm finds unresolved goes back to the executor', async () => {
  const { r } = await fixedFeedback(s4Decisions);
  await runReviewLoop();
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'C-1', resolved: false }, { ref: 'C-2', resolved: true }] });
  await runReviewLoop();
  assert.equal(reviewLoopState(lane()).state, 'start_triage');
  // the triage of the confirm's leftovers accepts the nit again: in this pass it is fixed, not left on record
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/t.json', reportMd: '/t.md', findings: [], decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'nit', claim: 'C-1 の変数名が直っていない', path: 'a.ts', fix: '名前で役割が分かる' }] });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_triage_done');
  assert.equal(reviewLoopState(lane()).state, 'send_fix');
  await runReviewLoop();
  const fix = lane().at(-1);
  assert.equal(fix.event, 's2_fix_sent');
  assert.deepEqual(fix.attrs.refs, ['F-1']);
  // the next confirm checks the reviewer's requests again next to the leftover
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  const { started } = runner({ reviewRunStatus: () => ({ state: 'running' }) });
  await runReviewLoop();
  const scope = started.at(-1).inputs.find((p) => /confirm-\d+\.md$/.test(p));
  assert.match(readFileSync(scope, 'utf8'), /C-1[\s\S]*C-2[\s\S]*F-1/);
  setAgentRunner(null);
});

test('a reply does not say fixed for a request no confirm found resolved', async () => {
  const { r, queued } = await fixedFeedback(s4Decisions);
  await runReviewLoop();
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'C-1', resolved: false }, { ref: 'C-2', resolved: true }] });
  await runReviewLoop();
  // penne took the lane on as it stands (after an escalation), and pushed
  for (const [event, attrs] of [['s2_review_escalated', { reason: 'r' }], ['s2_review_resumed', { decision: 'accept' }], ['s2_review_converged', {}], ['s2_device_skipped', {}],
    ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }], ['s4_submit_started', {}], ['s4_pr_created', { pr_url: PR, pr_number: 7, commit: 'cccc3333dddd' }]]) await seedLifecycle(event, 'IDD-1', attrs);
  await runPrReplies();
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  const byRef = Object.fromEntries(replies.parts.map((p) => [p.ref, p]));
  assert.equal(byRef['C-1'].draft, '', 'penne writes the reply for a request that was not confirmed fixed');
  assert.equal(byRef['C-1'].resolve, false);
  assert.match(byRef['C-2'].draft, /直しました（cccc333）/);
  assert.equal(byRef['C-2'].resolve, true);
  setAgentRunner(null);
});

test('a reply does not say fixed when penne took the lane on before any confirm', async () => {
  const { queued } = await fixedFeedback(s4Decisions);
  for (const [event, attrs] of [['s2_review_escalated', { reason: 'r' }], ['s2_review_resumed', { decision: 'accept' }], ['s2_review_converged', {}], ['s2_device_skipped', {}],
    ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }], ['s4_submit_started', {}], ['s4_pr_created', { pr_url: PR, pr_number: 7, commit: 'cccc3333dddd' }]]) await seedLifecycle(event, 'IDD-1', attrs);
  await runPrReplies();
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  assert.deepEqual(replies.parts.map((p) => [p.ref, p.draft, p.resolve]), [['C-1', '', false], ['C-2', '', false]]);
  setAgentRunner(null);
});

test('a request the confirm did not report on reaches the triage of the leftovers as unresolved', async () => {
  const { r, started } = await fixedFeedback(s4Decisions);
  await runReviewLoop();
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'C-2', resolved: true }] });
  await runReviewLoop();
  const done = lane().at(-1);
  const missing = done.attrs.files.find((p) => /missing/.test(p));
  assert.ok(missing, 'the refs the confirm left out are written down for the triage');
  assert.match(readFileSync(missing, 'utf8'), /C-1（nit）[\s\S]*変数名が紛らわしい/);
  r.reviewRunStatus = () => ({ state: 'running' });
  await runReviewLoop();
  const triage = started.at(-1);
  assert.equal(lane().at(-1).event, 's2_triage_started');
  assert.ok(triage.inputs.includes(missing));
  setAgentRunner(null);
});

test('the leftovers of an S4 confirm are judged with the PR instructions, and their fix is sent as the reviewer\'s request', async () => {
  const { r, started, state } = await fixedFeedback(s4Decisions);
  await runReviewLoop();
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'C-1', resolved: false }, { ref: 'C-2', resolved: true }] });
  await runReviewLoop();
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/t.json', reportMd: '/t.md', findings: [], decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'nit', claim: 'C-1 の変数名が直っていない', path: 'a.ts', fix: '名前で役割が分かる' }] });
  await runReviewLoop();
  assert.equal(started.at(-1).stage, 'feedback_leftovers');
  assert.equal(started.at(-1).norms, undefined);
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_fix_sent');
  const outbox = join(state, 'outbox');
  const xml = readdirSync(outbox).map((f) => readFileSync(join(outbox, f), 'utf8')).join('\n');
  const last = xml.slice(xml.lastIndexOf('<task>'));
  assert.match(last, /PR にレビュアーから届いた指摘のうち、確認で直っていなかったもの/);
  assert.match(last, /<fix>名前で役割が分かる<\/fix>/);
  setAgentRunner(null);
});

test('a confirm started before its refs were listed still counts a request it did not report on as unresolved', async () => {
  const { r } = await fixedFeedback(s4Decisions);
  // an S4 confirm from before the list existed: no scope_refs, and its stage did not report nits
  await appendLifecycle('s2_confirm_started', 'IDD-1', { round: 1, run_id: 'OLD' });
  r.reviewRunStatus = () => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'C-2', resolved: true }] });
  await runReviewLoop();
  const done = lane().at(-1);
  assert.equal(done.event, 's2_confirm_done');
  assert.deepEqual(done.attrs.missing_refs, ['C-1']);
  assert.equal(reviewLoopState(lane()).state, 'start_triage');
  setAgentRunner(null);
});

test('a reviewer\'s request that reverses an earlier fix waits for penne, and its reply waits for the push that carries the boundary', async () => {
  setup();
  const decisions = [{ ref: 'C-1', verdict: 'escalate', severity: 'should', claim: '検査を緩めて', path: 'a.ts', reason: '前の巡の修正を打ち消す', reverts: { prior_ref: '1-final/F-1', prior: '検査を厳しく', current: '検査を緩く' } }];
  const { queued, setItems } = runner({ reviewRunStatus: () => ({ state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [], decisions }) });
  setItems([thread('C1', 'ここは緩めてほしい')]);
  await runPrFeedback();
  await runReviewLoop();
  await runReviewLoop();
  assert.deepEqual(lane().at(-1).attrs.oscillations.map((o) => o.prior_ref), ['1-final/F-1']);
  await runReviewLoop();
  assert.equal(reviewLoopState(lane()).state, 'escalated');
  assert.equal((await runPrReplies()).queued.length, 0, 'not while penne decides');
  const { applyDecision } = await import('../src/ledger/write.ts');
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-1', boundaries: [{ ref: 'C-1', choice: 'current' }] })).ok, true);
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_fix_sent');
  assert.equal((await runPrReplies()).queued.length, 0, 'the boundary is fixed and pushed first');
  // the PR confirm lists the boundary by its ref along with the accepted requests
  await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
  await runReviewLoop();
  assert.deepEqual(lane().at(-1).attrs.scope_refs, ['C-1']);
  assert.deepEqual(lane().at(-1).attrs.boundary_refs, ['C-1']);
  await appendLifecycle('s2_confirm_done', 'IDD-1', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0 });
  for (const [event, attrs] of [
    ['s2_review_started', { kind: 'final', round: 2, run_ids: ['F'] }], ['s2_review_findings', { kind: 'final', round: 2, files: [] }],
    ['s2_triage_started', { kind: 'final', round: 2, run_id: 'T' }], ['s2_triage_done', { kind: 'final', round: 2, accepted: [], rejected: [] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}], ['s3_ready', {}], ['s3_ok', { at_by: 'auto' }], ['s4_submit_started', {}], ['s4_pr_created', { pr_url: PR, pr_number: 7, commit: 'cccc3333dddd' }]]) await seedLifecycle(event, 'IDD-1', attrs);
  await runPrReplies();
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  // penne writes this reply: the triage did not decide it, penne did
  assert.deepEqual(replies.parts.map((p) => [p.ref, p.draft, p.resolve]), [['C-1', '', false]]);
  setAgentRunner(null);
});

test('a reversal penne closes with "go on as it is" still gets its reply card, and the next feedback comes in after it', async () => {
  setup();
  const decisions = [
    { ref: 'C-1', verdict: 'escalate', severity: 'should', claim: '検査を緩めて', path: 'a.ts', reason: '前の巡の修正を打ち消す', reverts: { prior_ref: '1-final/F-1', prior: '検査を厳しく', current: '検査を緩く' } },
    { ref: 'C-2', verdict: 'reject', severity: 'nit', claim: '命名の変更', reason: '公開の API 名なので変えない' },
  ];
  const { queued, setItems, setStatus } = runner({ reviewRunStatus: () => ({ state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [], decisions }) });
  setItems([thread('C1', 'ここは緩めてほしい'), thread('C2', '命名を変えては', 'T2')]);
  await runPrFeedback();
  await runReviewLoop();
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(reviewLoopState(lane()).state, 'escalated');
  const { applyDecision } = await import('../src/ledger/write.ts');
  assert.equal((await applyDecision('s2_review_accept', { iddId: 'IDD-1', note: '' })).ok, true);
  for (let i = 0; i < 4; i += 1) await runReviewLoop();
  assert.equal(reviewLoopState(lane()).state, 'done');
  assert.equal((await runPrReplies()).queued.length, 1, 'nothing was sent to the fix, so nothing waits for a push');
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  assert.deepEqual(replies.parts.map((p) => [p.ref, p.resolve]), [['C-1', false], ['C-2', false]]);
  assert.equal(replies.parts[0].draft, '', 'penne writes the reply to the reversal');
  assert.match(replies.parts[1].draft, /直していません。公開の API 名/);
  setStatus('OUT-1', 'discarded');
  setItems([thread('C1', 'ここは緩めてほしい'), thread('C2', '命名を変えては', 'T2'), thread('C9', 'もう 1 点', 'T9')]);
  assert.deepEqual((await runPrFeedback()).recorded, [{ iddId: 'IDD-1', items: 1 }]);
  setAgentRunner(null);
});

test('an accepted request penne leaves unfixed with "go on as it is" is not replied to as fixed, and does not wait for a push', async () => {
  setup();
  const decisions = [{ ref: 'C-1', verdict: 'accept', severity: 'must', claim: 'null で落ちる', path: 'b.ts', fix: 'null でも落ちない' }, { ref: 'C-2', verdict: 'escalate', severity: 'should', claim: '仕様が決まらない', reason: 'r' }];
  const { queued, setItems } = runner({ reviewRunStatus: () => ({ state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [], decisions }) });
  setItems([thread('C1', 'null で落ちます'), thread('C2', 'どちらの仕様？', 'T2')]);
  await runPrFeedback();
  for (let i = 0; i < 3; i += 1) await runReviewLoop();
  const { applyDecision } = await import('../src/ledger/write.ts');
  assert.equal((await applyDecision('s2_review_accept', { iddId: 'IDD-1', note: '' })).ok, true);
  for (let i = 0; i < 4; i += 1) await runReviewLoop();
  await runPrReplies();
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  assert.ok(replies);
  assert.deepEqual(replies.parts.map((p) => [p.ref, p.draft, p.resolve]), [['C-1', '', false], ['C-2', '', false]]);
  setAgentRunner(null);
});

test('after a continue the replies wait for the fix, even before the fix is recorded', async () => {
  setup();
  const decisions = [{ ref: 'C-1', verdict: 'escalate', severity: 'should', claim: '仕様が決まらない', reason: 'r' }];
  const { setItems } = runner({ reviewRunStatus: () => ({ state: 'done', reportJson: '/x.json', reportMd: '/x.md', findings: [], decisions }) });
  setItems([thread('C1', 'どちらの仕様？')]);
  await runPrFeedback();
  for (let i = 0; i < 3; i += 1) await runReviewLoop();
  const { applyDecision } = await import('../src/ledger/write.ts');
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-1', note: 'A 案で' })).ok, true);
  assert.equal(reviewLoopState(lane()).state, 'send_fix');
  assert.equal((await runPrReplies()).queued.length, 0, 'the fix about to be sent will move the head');
  await runReviewLoop();
  assert.equal(lane().at(-1).event, 's2_fix_sent');
  assert.equal((await runPrReplies()).queued.length, 0);
  setAgentRunner(null);
});

test('a follow-up and a skip accepted with no fix get their replies and one Issue card right after the judgement', async () => {
  setup();
  const { queued, setItems } = runner();
  setItems([thread('C1', '外の話なので別で'), thread('C2', '好みで見送って', 'T2')]);
  await runPrFeedback();
  await appendLifecycle('s2_triage_started', 'IDD-1', { kind: 'feedback', round: 1, run_id: 'X' });
  await appendLifecycle('s2_triage_done', 'IDD-1', {
    kind: 'feedback', round: 1,
    accepted: [
      { ref: 'C-1', severity: 'should', claim: '設定の掃除', reason: 'この PR の外', action: 'followup' },
      { ref: 'C-2', severity: 'nit', claim: '命名', reason: '好みなので見送る', action: 'skip' },
    ],
    rejected: [], escalated_claims: [],
  });
  assert.equal(reviewLoopState(lane()).state, 'done', 'no fix to send: the round closes as it is');
  const drafted = await runPrReplies();
  assert.equal(drafted.queued.length, 1);
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  const by = Object.fromEntries(replies.parts.map((p) => [p.ref, p]));
  assert.match(by['C-1'].draft, /この PR では直さず、別の Issue で扱います。この PR の外/);
  assert.match(by['C-2'].draft, /対応していません。好みなので見送る/);
  const issues = queued.filter((q) => q.kind === 'gh-issue');
  assert.equal(issues.length, 1, 'both kinds of follow-up are one card each; the skip gets none');
  assert.equal(issues[0].title, '設定の掃除');
  assert.match(issues[0].body, /## 背景\nこの PR の外/);
  assert.match(issues[0].body, /## 参照/);
  assert.match(issues[0].body, /元の指摘: /);
  setAgentRunner(null);
});

test('the reply follows the last judgement of each ref: a fix re-judged as skip answers as a skip', async () => {
  setup();
  const { queued, setItems } = runner();
  setItems([thread('C1', '直して'), thread('C2', 'こちらも', 'T2')]);
  await runPrFeedback();
  await appendLifecycle('s2_triage_started', 'IDD-1', { kind: 'feedback', round: 1, run_id: 'X' });
  await appendLifecycle('s2_triage_done', 'IDD-1', { kind: 'feedback', round: 1, accepted: [
    { ref: 'C-1', severity: 'should', claim: 'A を直す', action: 'fix' },
    { ref: 'C-2', severity: 'must', claim: 'B を直す', action: 'fix' },
  ], rejected: [], escalated_claims: [] });
  await appendLifecycle('s2_fix_sent', 'IDD-1', { refs: ['C-1', 'C-2'] });
  assert.equal((await runPrReplies()).queued.length, 0, 'the push has not happened yet');
  await appendLifecycle('s2_confirm_done', 'IDD-1', { round: 1, unresolved_refs: ['C-1'], unresolved_must: 0, unresolved_should: 1, unresolved_requests: 1, new_blocking: 0 });
  await appendLifecycle('s2_triage_done', 'IDD-1', { kind: 'confirm', round: 1, accepted: [
    { ref: 'C-1', severity: 'should', claim: 'A は見送る', action: 'skip', reason: '別の設計にする' },
  ], rejected: [], escalated_claims: [] });
  await appendLifecycle('s4_pr_created', 'IDD-1', { pr_url: PR, pr_number: 7, commit: 'cccc3333dddd' });
  const res = await runPrReplies();
  assert.equal(res.queued.length, 1, 'one card carries both replies');
  const replies = queued.find((q) => q.kind === 'gh-pr-replies');
  const by = Object.fromEntries(replies.parts.map((p) => [p.ref, p]));
  assert.match(by['C-1'].draft, /^対応していません。別の設計にする/, 'the leftovers judgement decides the reply');
  assert.match(by['C-2'].draft, /^B を直す を直しました（cccc333）。/);
  assert.equal(by['C-1'].resolve, false, 'a skip never closes the thread');
  assert.equal(by['C-2'].resolve, true);
  setAgentRunner(null);
});

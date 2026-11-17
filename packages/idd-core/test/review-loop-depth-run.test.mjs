import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { tmpDir } from './helpers/tmp.mjs';

// A depth-bearing lane's round, driven through the real loop: the table's role count, the whole-diff review after a
// fix, no confirm, the previous fixes handed to the judgement, the harm examples handed to the judgement and not to
// the reviewer, and the kept check after a fix-less judgement (DEC-113-2..8).

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });
const AREA = 'o/Demo';

/** `depth: null` declares none (a lane of the configured behaviour); `finalExtra` is review_blind.final_extra, left out when undefined */
function setup({ depth = 'standard', finalExtra } = {}) {
  const state = tmpDir('idd-depth-run-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), [
    'roles:',
    '  v: { model: x/v, report: review }',
    '  o: { model: x/o, report: review }',
    '  x: { model: x/x, report: review }',
    '  h: { model: x/h, report: review }',
    '  j: { model: x/j, report: triage }',
    '  r: { model: x/r, report: review }',
    'pipeline:',
    `  review_blind: { roles: [v, o], first_round_extra: [x], high_risk_extra: [h], high_risk_when: last${finalExtra ? `, final_extra: ${finalExtra}` : ''} }`,
    '  triage: { role: j }',
    '  device_check: { role: r }',
  ].join('\n') + '\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { [AREA]: { upstream: join(state, 'u'), work: join(state, 'w'), harm_examples: [{ harm: 3, example: 'engine が止まる' }] } } }));
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = tmpDir('idd-depth-run-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'a@b']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'a']);
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(join(wt, '_docs/qa/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, '_docs/qa/Demo/idd-001/qa.md'), '---\nrisk: Low\n---\n\nbody\n');
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'records']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: AREA }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [
    ev('lane_open'), ev('s1_ready', depth === null ? {} : { depth }), ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

function runner() {
  const calls = {};
  const status = {};
  const count = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls[o.stage] = [...(calls[o.stage] ?? []), o];
      count[o.stage] = (count[o.stage] ?? 0) + 1;
      const ids = [`${o.stage}-${count[o.stage]}`];
      for (const id of ids) status[id] = { state: 'running' };
      return { runIds: ids };
    },
    reviewRunStatus: (id) => status[id],
  });
  const done = (id, extra) => { status[id] = { state: 'done', reportJson: '/r.json', reportMd: '/r.md', ...extra }; };
  const running = () => Object.values(status).filter((s) => s.state === 'running').map((s) => s);
  return { calls, status, done, running, last: () => readLifecycle().at(-1).event };
}

test('a standard lane runs the table\'s roles, reads the whole diff after a fix, and has no confirm (AC-007, AC-009, AC-010)', async () => {
  const state = setup({ depth: 'standard' });
  const r = runner();
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_started');
  const started = readLifecycle().find((e) => e.event === 's2_review_started');
  assert.equal(started.attrs.depth, 'standard');
  assert.equal(started.attrs.max_fix_rounds, 2);
  assert.equal(started.attrs.close_on, 'must');
  // the table's two roles run, and the first-round extra does not (AC-007)
  assert.equal(r.calls.blind[0].roleCount, 2);
  assert.equal(r.calls.blind[0].extras, undefined);
  // the reviewer is handed no harm example (AC-041)
  assert.ok(!(r.calls.blind[0].inputs ?? []).some((p) => /harm-examples/.test(p)));

  // the review's findings, then a judgement that sends a must to the fix
  r.done('blind-1', { findings: [{ severity: 'must', path: 'a.ts', claim: 'x', evidence: '' }] });
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_findings');

  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_started');
  // the judgement is handed the repo's harm examples (AC-041)
  assert.ok(r.calls.triage[0].inputs.some((p) => /harm-examples/.test(p)));
  r.done('triage-1', { decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: '購読が残る', path: 'a.ts', fix: 'f' }] });
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_done');
  await runReviewLoop();
  assert.equal(r.last(), 's2_fix_sent');

  // the executor commits its fix and reports, and the next round is a review, not a confirm (AC-009, AC-010)
  const wt = JSON.parse(readFileSync(join(state, 'executor-sessions.jsonl'), 'utf8').trim().split('\n')[0]).worktree_path;
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'fix']);
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  const before = readLifecycle().length;
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_started');
  const next = readLifecycle().slice(before).find((e) => e.event === 's2_review_started');
  assert.equal(next.attrs.diff_scope, undefined, 'the whole diff is shown');
  assert.equal(next.attrs.kind, 'blind');
  assert.ok(!readLifecycle().some((e) => e.event === 's2_confirm_started'));

  // the judgement after the fix is handed no list of the previous fix to check ref by ref: a fix that did not hold is
  // found by the next blind, from the diff (AC-004). What the fix carried is in the history, with its round and kind
  r.done('blind-2', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_started');
  assert.ok(!r.calls.triage[1].inputs.some((p) => /prior-/.test(p)), r.calls.triage[1].inputs.join(', '));
  assert.ok(!existsSync(join(state, 'pipeline', 'review', 'IDD-001', 'prior-2-blind.md')));
  const historyText = readFileSync(join(state, 'pipeline', 'review', 'IDD-001', 'triage-history-2-blind.md'), 'utf8');
  assert.match(historyText, /1-blind\/F-1/);
  assert.match(historyText, /購読が残る/);
  // the reviewer is handed neither the previous findings nor the harm examples (AC-016, AC-041)
  assert.ok(!(r.calls.blind[1].inputs ?? []).some((p) => /prior-|harm-examples/.test(p)));
  setAgentRunner(null);
});

test('a should fix that names no harm is read back as a placed follow-up, and the file of a must is no reason either way (AC-027)', async () => {
  setup({ depth: 'standard' });
  const r = runner();
  await runReviewLoop();
  r.done('blind-1', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_started');
  r.done('triage-1', {
    decisions: [
      { ref: 'F-1', verdict: 'accept', severity: 'must', claim: 'must', path: 'a.ts', fix: 'f' },
      { ref: 'F-2', verdict: 'accept', severity: 'should', claim: 'same file', path: 'a.ts', fix: 'f', action: 'fix', impact: '購読が黙って残る' },
      { ref: 'F-3', verdict: 'accept', severity: 'should', claim: 'other file, small and in the intent', path: 'b.ts', fix: 'f', action: 'fix', impact: '文面が黙って欠ける' },
      { ref: 'F-4', verdict: 'accept', severity: 'should', claim: 'no harm named', path: 'a.ts', fix: 'f', action: 'fix' },
    ],
  });
  await runReviewLoop();
  const accepted = readLifecycle().filter((e) => e.event === 's2_triage_done').at(-1).attrs.accepted;
  assert.equal(accepted.find((a) => a.ref === 'F-2').action, 'fix');
  assert.equal(accepted.find((a) => a.ref === 'F-3').action, 'fix', 'a should in another file is fixed when it is small and in the intent');
  assert.equal(accepted.find((a) => a.ref === 'F-4').action, 'followup', 'a fix that names no harm is placed, even in the file of a must');
  assert.equal(accepted.find((a) => a.ref === 'F-4').claimed_action, 'fix');
  setAgentRunner(null);
});

test('a pass that begins after PR feedback records its depth at its first blind (AC-002)', async () => {
  setup({ depth: 'standard' });
  // a PR feedback pass ran and closed, and a send-back then asked for a new round
  const seeded = [
    ['s4_review_comment_received', { files: [] }],
    ['s2_triage_done', { kind: 'feedback', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', fix: 'f', action: 'fix' }] }],
    ['s2_fix_sent', { round: 1, refs: ['F-1'] }],
    ['s2_result', { outcome: 'success' }],
    ['s2_confirm_started', { round: 1, run_id: 'C' }],
    ['s2_confirm_done', { round: 1, unresolved_must: 0, unresolved_should: 0, new_blocking: 0, unresolved_refs: [] }],
    ['s2_review_started', { kind: 'final', round: 1, run_ids: ['f'] }],
    ['s2_review_findings', { kind: 'final', round: 1, files: [] }],
    ['s2_triage_done', { kind: 'final', round: 1, accepted: [] }],
    ['s2_review_converged', {}],
    ['s2_device_skipped', {}],
    ['s3_ready', {}],
    ['s4_verify_user_judgment_answered', { outcome: 'revise' }],
    ['s2_result', { outcome: 'success' }],
  ];
  for (const [event, attrs] of seeded) await seedLifecycle(event, 'IDD-001', attrs);
  runner();
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_started');
  const started = readLifecycle().at(-1);
  assert.equal(started.attrs.depth, 'standard', 'the new pass records its depth');
  assert.equal(started.attrs.max_fix_rounds, 2);
  assert.equal(started.attrs.close_on, 'must');
  setAgentRunner(null);
});

test('no judgement is handed the previous fixes, and a record that still carries `prior` is read without it (AC-004)', async () => {
  setup({ depth: 'deep' });
  const r = runner();
  // round 1 fixed a must; round 2 was written by a judgement that still carried it unresolved, and sent it again
  const seeded = [
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['b1'], depth: 'deep', max_fix_rounds: 3, close_on: 'must' }],
    ['s2_review_findings', { kind: 'blind', round: 1, files: [] }],
    ['s2_triage_started', { kind: 'blind', round: 1, run_id: 't1' }],
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: '購読が残る', path: 'a.ts', fix: 'f' }] }],
    ['s2_fix_sent', { round: 1, refs: ['1-blind/F-1'] }],
    ['s2_result', { outcome: 'success' }],
    ['s2_review_started', { kind: 'blind', round: 2, run_ids: ['b2'] }],
    ['s2_review_findings', { kind: 'blind', round: 2, files: [] }],
    ['s2_triage_started', { kind: 'blind', round: 2, run_id: 't2' }],
    ['s2_triage_done', { kind: 'blind', round: 2, accepted: [], prior: [{ ref: '1-blind/F-1' }] }],
    ['s2_review_started', { kind: 'final', round: 2, run_ids: ['f2'] }],
    ['s2_review_findings', { kind: 'final', round: 2, files: [] }],
  ];
  for (const [event, attrs] of seeded) await seedLifecycle(event, 'IDD-001', attrs);
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_started');
  assert.ok(!r.calls.triage[0].inputs.some((p) => /prior-/.test(p)), 'the judgement is handed no list of the previous fixes');
  // nothing of the fix is read back: the judgement that accepts nothing lets the round close
  r.done('triage-1', { decisions: [] });
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_done');
  assert.ok(!readLifecycle().at(-1).attrs.prior, 'the judgement writes no prior');
  setAgentRunner(null);
});

test('a kept check left by a lane from before R2 was removed starts no run: continuing it converges the round', async () => {
  const state = setup({ depth: 'standard' });
  const file = join(state, 'lifecycle-Demo.jsonl');
  const rows = readFileSync(file, 'utf8').trim().split('\n');
  rows.push(
    JSON.stringify(ev('s2_review_escalated', { reason: 'レビューがすべて失敗: kept boom', retry_state: { state: 'start_blind', kind: 'kept', round: 1 } })),
    JSON.stringify(ev('s2_review_resumed', { decision: 'continue', note: '' })),
  );
  writeFileSync(file, rows.join('\n') + '\n');
  const r = runner();
  await runReviewLoop();
  const last = readLifecycle().at(-1);
  assert.equal(last.event, 's2_review_converged');
  assert.match(String(last.attrs.kept_skipped), /R2/);
  assert.equal(r.calls.r2, undefined, 'no R2 run is started');
  setAgentRunner(null);
});

/** a fix-less judgement, then the last review judged clean: the lane's next step is what the depth table says comes after the final */
async function throughCleanFinal(r) {
  await runReviewLoop();
  r.done('blind-1', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  r.done('triage-1', { decisions: [] });
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_done');
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_started');
  assert.equal(readLifecycle().at(-1).attrs.kind, 'final');
  r.done('final-1', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  r.done('triage-2', { decisions: [] });
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_done');
  await runReviewLoop();
}

test('a fix-less judgement converges after the last review at every depth, with no kept check (AC-029)', async () => {
  for (const depth of ['shallow', 'standard', 'deep']) {
    setup({ depth });
    const r = runner();
    await throughCleanFinal(r);
    assert.equal(r.last(), 's2_review_converged', depth);
    assert.equal(r.calls.r2, undefined, `${depth}: no R2 run`);
    assert.ok(!readLifecycle().some((e) => e.event === 's2_review_started' && e.attrs?.kind === 'kept'), depth);
    setAgentRunner(null);
  }
});

// 2026-10-19 penne: the senior role's last review runs on every lane, whatever its Risk and depth. A depth-bearing lane
// takes it from the table (shallow and standard now say so); a lane with no declared depth takes it from
// review_blind.final_extra (`all`), whose `high` value is the behaviour before the key existed.

test('a standard lane whose Risk is not High runs the last review with the high-risk role alone, on the whole diff', async () => {
  setup({ depth: 'standard' });
  const r = runner();
  await runReviewLoop();
  r.done('blind-1', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  r.done('triage-1', { decisions: [] });
  await runReviewLoop();
  await runReviewLoop();
  // the blind judged the same tree clean, but the senior role has not read it: the final is not settled away (Risk is Low)
  const started = readLifecycle().at(-1);
  assert.equal(started.event, 's2_review_started');
  assert.equal(started.attrs.kind, 'final');
  assert.deepEqual(started.attrs.extras, ['high_risk']);
  assert.equal(started.attrs.risk, 'Low');
  assert.equal(started.attrs.diff_scope, undefined, 'the whole diff is shown: no earlier round was read by the senior role');
  assert.equal(r.calls.final.length, 1);
  assert.equal(r.calls.final[0].onlyHighRisk, true, 'the last review runs the high_risk_extra role alone');
  assert.deepEqual(r.calls.final[0].extras, ['high_risk']);
  assert.deepEqual(r.calls.final[0].noFallbackRoles, ['h'], 'the final waits for the senior role rather than its fallback');
  setAgentRunner(null);
});

test('a shallow lane runs the last review before it converges', async () => {
  setup({ depth: 'shallow' });
  const r = runner();
  await runReviewLoop();
  r.done('blind-1', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  r.done('triage-1', { decisions: [] });
  await runReviewLoop();
  await runReviewLoop();
  const started = readLifecycle().at(-1);
  assert.equal(started.event, 's2_review_started');
  assert.equal(started.attrs.kind, 'final');
  assert.deepEqual(started.attrs.extras, ['high_risk']);
  assert.equal(r.calls.final[0].onlyHighRisk, true);
  setAgentRunner(null);
});

test('with no declared depth, final_extra: all adds the high-risk role to a Low lane\'s final instead of settling it', async () => {
  setup({ depth: null, finalExtra: 'all' });
  const r = runner();
  await runReviewLoop();
  const blind = readLifecycle().at(-1);
  assert.equal(blind.attrs.kind, 'blind');
  assert.deepEqual(blind.attrs.extras, ['first_round'], 'the blind rounds add no high-risk role under last');
  r.done('blind-1', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  r.done('triage-1', { decisions: [] });
  await runReviewLoop();
  await runReviewLoop();
  const started = readLifecycle().at(-1);
  assert.equal(started.event, 's2_review_started', 'the same tree is not settled by a round the senior role did not read');
  assert.equal(started.attrs.kind, 'final');
  assert.deepEqual(started.attrs.extras, ['high_risk']);
  assert.equal(started.attrs.risk, 'Low');
  assert.deepEqual(r.calls.final[0].extras, ['high_risk']);
  setAgentRunner(null);
});

test('with no declared depth, final_extra: high (and the key left out) keeps the final to High lanes, as before', async () => {
  for (const finalExtra of ['high', undefined]) {
    setup({ depth: null, finalExtra });
    const r = runner();
    await runReviewLoop();
    r.done('blind-1', { findings: [] });
    await runReviewLoop();
    await runReviewLoop();
    r.done('triage-1', { decisions: [] });
    await runReviewLoop();
    await runReviewLoop();
    // a Low lane: the blind read this tree and judged it clean, so the final of the same code is skipped
    const last = readLifecycle().at(-1);
    assert.equal(last.event, 's2_review_converged', String(finalExtra));
    assert.match(String(last.attrs.final_skipped), /最後のレビュー/);
    assert.ok(!r.calls.final, 'no final ran');
    setAgentRunner(null);
  }
});

test('a depth-bearing final shows the whole diff when the senior role did not read the round it starts from', async () => {
  const state = setup({ depth: 'standard' });
  // the increment's scope is what can leave part of the diff unseen; the fixture's default is the whole diff
  writeFileSync(join(state, 'roles.yaml'), readFileSync(join(state, 'roles.yaml'), 'utf8') + '  review_final: { scope: increment }\n');
  const r = runner();
  await runReviewLoop();
  r.done('blind-1', { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  r.done('triage-1', { decisions: [] });
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_done');
  // the head moves after the round the final would start from: its increment would leave the earlier changes unseen
  const session = JSON.parse(readFileSync(join(state, 'executor-sessions.jsonl'), 'utf8').trim());
  execFileSync('git', ['-C', session.worktree_path, 'commit', '-q', '--allow-empty', '-m', 'chore: the head moved after the round']);
  await runReviewLoop();
  const started = readLifecycle().at(-1);
  assert.equal(started.event, 's2_review_started');
  assert.equal(started.attrs.kind, 'final');
  assert.equal(started.attrs.diff_scope, undefined, 'no round of this head was read by the senior role: the whole diff is shown');
  assert.deepEqual(started.attrs.extras, ['high_risk']);
  setAgentRunner(null);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveStage } from '../src/ledger/derive.ts';
import { runSubmitPrep } from '../src/plan/submit-prep.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { proposalPath, readProposal } from '../src/overlay/export.ts';
import { buildSubmitReview } from '../src/plan/ship.ts';

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });

test('a lane sent back from S4 re-enters the review loop, and its escalation shows as stuck', () => {
  const done = [ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_review_skipped'), ev('s2_device_skipped'), ev('s3_ready'), ev('s3_ok', { at_by: 'auto' }), ev('s4_submit_started')];
  assert.equal(deriveStage(done).decision, 'ship');
  const back = [...done, ev('s4_verify_user_judgment_answered'), ev('s2_result')];
  assert.equal(deriveStage(back).group, 'impl');
  assert.match(deriveStage(back).blockedBy ?? '', /レビュー/);
  const stuck = [...back, ev('s2_review_escalated', { reason: 'r' })];
  assert.equal(deriveStage(stuck).decision, 'stuck');
});

test('a converged lane passes S3 without the diff card; old lanes keep it', () => {
  const loop = [ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready')];
  assert.equal(deriveStage(loop).decision, undefined);
  assert.equal(deriveStage(loop).blockedBy, '提出の準備中');
  const legacy = [ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s3_ready')];
  assert.equal(deriveStage(legacy).decision, 'review');
});

function setup(pipeline, seed = () => {}) {
  const state = mkdtempSync(join(tmpdir(), 'idd-s3-'));
  temps.push(state);
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipeline}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  // no registered repo: the lane's fork point is its start commit
  writeFileSync(join(state, 'repos.yaml'), 'repos: {}\n');
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = mkdtempSync(join(tmpdir(), 'idd-s3-wt-'));
  temps.push(wt);
  execFileSync('git', ['init', '-q', wt]);
  seed(wt);
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result'), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready')].map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** insert a blind round whose judgement leaves one should for the follow-ups, before the lane converges */
function seedJudgement(claim = 'まれな穴', path = 'a.ts') {
  const file = join(process.env.IDD_STATE_DIR, 'lifecycle-Demo.jsonl');
  const evs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const at = evs.findIndex((e) => e.event === 's2_result');
  evs.splice(at + 1, 0,
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim, path, action: 'followup' }] }),
  );
  writeFileSync(file, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('S3 is recorded as passed and the lane moves to submit, with no R2 and no record of skipping one', async () => {
  setup('  executor: { role: r }\n');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.deepEqual(res.submitted, ['IDD-001']);
  const names = readLifecycle().map((e) => e.event);
  assert.ok(!names.some((n) => n.startsWith('s3_r2_') || n.startsWith('s3_kept_')), names.join(', '));
  assert.equal(readLifecycle().find((e) => e.event === 's3_ok').attrs.at_by, 'auto');
  setAgentRunner(null);
});

test('AC-001 / AC-002 / AC-004 / AC-005: follow-ups go on the lane, not the TODO or the branch', async () => {
  const TODO = '# TODO\n\n### Demo-Enhance-70: [Enhance] x\n\n- **ID**: Demo-Enhance-70\n- **Plan**: None\n';
  setup('  executor: { role: r }\n', (wt) => {
    mkdirSync(join(wt, 'scripts'), { recursive: true });
    writeFileSync(join(wt, 'scripts/check-docs.sh'), 'exit 0\n');
    writeFileSync(join(wt, 'TODO.md'), TODO);
  });
  const state = process.env.IDD_STATE_DIR;
  const wt = JSON.parse(readFileSync(join(state, 'executor-sessions.jsonl'), 'utf8')).worktree_path;
  // the intake names the TODO task, so the old code would have added Notes to it
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', title: 'T', context: 'Demo-Enhance-70 の続き', area: 'Demo' }) + '\n');
  seedJudgement();
  const git = (...a) => execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  saveProposal('prepared');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  setAgentRunner(null);
  assert.deepEqual(res.submitted, ['IDD-001']);
  assert.equal(readFileSync(join(wt, 'TODO.md'), 'utf8'), TODO, 'the TODO is untouched, named task or not');
  assert.equal(git('rev-parse', 'HEAD'), head, 'nothing is committed on the branch for the follow-ups');
  assert.equal(readProposal('IDD-001').status, 'prepared', 'the prepared submit is left as it was');
  const w = readLifecycle().find((e) => e.event === 's3_followups_written');
  assert.deepEqual(w.attrs.entries, [{ severity: 'should', claim: 'まれな穴', path: 'a.ts' }]);
  assert.equal(w.attrs.files, undefined);
  assert.equal(w.attrs.commit, undefined);
  assert.ok(!readLifecycle().some((e) => e.event === 's3_followups_not_written'));
});

test('a duplicate result after the loop finished does not restart it; a send-back from S4 does', () => {
  const pr = [ev('s1_go'), ev('s2_start'), ev('s2_result'), ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'), ev('s3_ok', { at_by: 'auto' }), ev('s4_submit_started'), ev('s4_pr_created', { pr_number: 7 })];
  assert.equal(deriveStage([...pr, ev('s2_result')]).group, 'waiting', 'a stray result keeps the PR wait');
  const back = [...pr, ev('s4_verify_user_judgment_answered'), ev('s2_result')];
  assert.equal(deriveStage(back).group, 'impl');
});

test('a held lane and a lane back in the loop are not moved to submit', async () => {
  setup('  executor: { role: r }\n');
  const { appendLifecycle } = await import('../src/ledger/write.ts');
  await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-001', {});
  await appendLifecycle('s2_result', 'IDD-001', {});
  setAgentRunner({ deliver: async () => {} });
  assert.deepEqual((await runSubmitPrep()).submitted, [], 'a send-back puts the lane back in the loop');
  setup('  executor: { role: r }\n');
  await appendLifecycle('s3_defer', 'IDD-001', {});
  assert.deepEqual((await runSubmitPrep()).submitted, []);
  setAgentRunner(null);
});

test('INV-2684: a send-back holds the submit prep until the executor answers and the loop converges again', async () => {
  const { appendLifecycle } = await import('../src/ledger/write.ts');
  // the engine's instruction and penne's own send-back leave the loop still `done`, so only the guard stops the lane;
  // without it s3_ok would be written and the submit card would open over the executor's work
  for (const [label, attrs] of [
    ['engine', { outcome: 'revise', instruction: 'x', by: 'harness', stall_causes: ['dirty'] }],
    ['penne', { outcome: 'revise', instruction: 'y' }],
  ]) {
    setup('  executor: { role: r }\n');
    await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-001', attrs);
    setAgentRunner({ deliver: async () => {} });
    const res = await runSubmitPrep();
    assert.deepEqual(res.submitted, [], `${label}: the card does not open`);
    const names = readLifecycle().map((e) => e.event);
    assert.ok(!names.includes('s3_ok'), `${label}: S3 does not pass`);
    assert.ok(!names.includes('s3_plan_archived'), `${label}: the plan is not archived`);
  }
  // the executor's result, the review converging and a new s3_ready: the next s3_ready is after the send-back and the lane resumes
  setup('  executor: { role: r }\n');
  await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-001', { outcome: 'revise', instruction: 'y' });
  for (const event of ['s2_result', 's2_review_converged', 's2_device_skipped', 's3_ready']) await appendLifecycle(event, 'IDD-001', {});
  setAgentRunner({ deliver: async () => {} });
  assert.deepEqual((await runSubmitPrep()).submitted, ['IDD-001'], 'the lane is not left stuck after the answer');
  assert.ok(readLifecycle().some((e) => e.event === 's3_ok'));
  setAgentRunner(null);
});

const saveProposal = (status, over = {}) => {
  const path = proposalPath('IDD-001');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ iddId: 'IDD-001', status, token: 't', expiresAt: new Date(Date.now() + 600_000).toISOString(), ...over }));
};

test('a reversal penne closed with "go on as it is" is listed on the submit card with what was left undecided', () => {
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '', attrs });
  const osc = { ref: 'F-1', severity: 'should', path: 't.py', claim: '語彙で縛る', prior_ref: '2-final/F-1', prior: '厳しく', current: '緩く' };
  const review = buildSubmitReview([
    ev('s2_result'), ev('s2_review_started', { kind: 'final', round: 3 }),
    ev('s2_triage_done', { kind: 'final', round: 3, accepted: [{ ref: 'F-2', severity: 'nit', claim: '表記', path: 'a.py' }], oscillations: [osc] }),
    ev('s2_review_escalated', { reason: '往復' }), ev('s2_review_resumed', { decision: 'accept', note: '' }), ev('s2_review_converged'),
  ]);
  assert.equal(review.closedBy, 'penne');
  assert.deepEqual(review.leftovers, [
    { severity: 'nit', claim: '表記', path: 'a.py' },
    { severity: 'should', claim: '語彙で縛る（2-final/F-1 の修正と往復。境目は決めず、今のコードのまま進めた）', path: 't.py' },
  ]);
});

test('AC-004 / AC-010: a conflict scope S3 with all its follow-ups already recorded records nothing more', async () => {
  setup('  executor: { role: r }\n');
  const state = process.env.IDD_STATE_DIR;
  const wt = JSON.parse(readFileSync(join(state, 'executor-sessions.jsonl'), 'utf8')).worktree_path;
  const git = (...a) => execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  const followup = { severity: 'should', claim: '既出の指摘', path: '_docs/a.md' };
  const evs = [
    ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'], head }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', ...followup, action: 'followup' }] }),
    // a record with no task, files or commit: the shape the lane writes now
    ev('s3_followups_written', { entries: [followup] }),
    ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'),
    ev('s3_check_conflict', { conflict_files: ['app.ts'] }), ev('s4_submit_started', { head }), ev('s4_verify_user_judgment_answered', { outcome: 'revise' }),
    ev('s2_result'), ev('s2_review_started', { kind: 'blind', round: 2, run_ids: ['B2'], head, diff_scope: 'conflict' }),
    ev('s2_review_findings', { kind: 'blind', round: 2, files: ['/b2.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 2, accepted: [] }),
    ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'),
  ];
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  await runSubmitPrep();
  const writes = readLifecycle().filter((e) => e.event === 's3_followups_written');
  assert.equal(writes.length, 1, 'the follow-up already recorded is not recorded again');
  assert.equal(git('rev-parse', 'HEAD'), head, 'nothing new is committed');
  assert.ok(readLifecycle().some((e) => e.event === 's3_ok'));
  setAgentRunner(null);
});

const PLAN_PATH = '_docs/plan/Demo/idd-001/plan.md';
const ARCHIVE_PATH = '_docs/archives/plan/Demo/idd-001/plan.md';
const seedPlan = (wt) => {
  mkdirSync(join(wt, '_docs/plan/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, PLAN_PATH), '---\ntitle: t\nstatus: active\n---\n\n## Tasks\n- `src/a.ts` — 直す\n');
};
const gitIn = (wt, ...a) => execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { encoding: 'utf8' }).trim();
const worktreeOf = () => JSON.parse(readFileSync(join(process.env.IDD_STATE_DIR, 'executor-sessions.jsonl'), 'utf8')).worktree_path;
const setupPlan = (pipeline, seed = seedPlan) => { setup(pipeline, seed); const wt = worktreeOf(); gitIn(wt, 'config', 'user.email', 'a@b'); gitIn(wt, 'config', 'user.name', 'a'); return wt; };

test('AC-013: the work instruction is archived as its own commit before S3 passes, and only once', async () => {
  const wt = setupPlan('  executor: { role: r }\n');
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  assert.ok(existsSync(join(wt, ARCHIVE_PATH)), 'the plan is in the archive');
  assert.ok(!existsSync(join(wt, PLAN_PATH)), 'the plan left the live place');
  const events = readLifecycle().map((e) => e.event);
  assert.ok(events.indexOf('s3_plan_archived') >= 0);
  assert.ok(events.indexOf('s3_plan_archived') < events.indexOf('s3_ok'), 'before S3 passes');
  const moved = gitIn(wt, 'rev-list', '--count', `${start}..HEAD`);
  assert.equal(moved, '1', 'the move is one commit and nothing else is committed');
  const files = gitIn(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.ok(files.every((f) => f === ARCHIVE_PATH || f === PLAN_PATH), 'the commit carries the plan paths alone');
  assert.ok(files.includes(ARCHIVE_PATH), 'the archived path is in the commit');
  assert.match(gitIn(wt, 'log', '--follow', '--format=%s', '--', ARCHIVE_PATH), /init/);
  // a second pass moves nothing more
  await runSubmitPrep();
  assert.equal(gitIn(wt, 'rev-list', '--count', `${start}..HEAD`), '1');
  assert.ok(readLifecycle().some((e) => e.event === 's3_ok'));
  setAgentRunner(null);
});

test('AC-023: a dirty worktree holds the lane; once clean the next tick moves the plan and goes on', async () => {
  const wt = setupPlan('  executor: { role: r }\n');
  writeFileSync(join(wt, 'scratch.txt'), 'x\n');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.match(res.errors[0].error, /未 commit の変更/);
  assert.ok(!readLifecycle().some((e) => e.event === 's3_ok'), 'the lane is held');
  const dirty = gitIn(wt, 'status', '--porcelain', '--untracked-files=all');
  rmSync(join(wt, 'scratch.txt'));
  assert.equal(dirty, '?? scratch.txt', 'nothing was moved or committed');
  await runSubmitPrep();
  assert.ok(existsSync(join(wt, ARCHIVE_PATH)));
  assert.ok(readLifecycle().some((e) => e.event === 's3_ok'));
  setAgentRunner(null);
});

test('AC-023: a failed move commit is undone and the next tick, with the cause gone, moves it', async () => {
  const wt = setupPlan('  executor: { role: r }\n');
  const hook = join(wt, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.match(res.errors[0].error, /archive へ移せませんでした/);
  assert.ok(!readLifecycle().some((e) => e.event === 's3_ok'), 'the lane is held');
  assert.equal(gitIn(wt, 'status', '--porcelain', '--untracked-files=all'), '', 'the move did not stay in the worktree');
  assert.equal(gitIn(wt, 'rev-parse', 'HEAD'), start, 'no commit was made');
  assert.ok(existsSync(join(wt, PLAN_PATH)), 'the plan is back where it was');
  rmSync(hook);
  await runSubmitPrep();
  assert.ok(existsSync(join(wt, ARCHIVE_PATH)));
  assert.ok(readLifecycle().some((e) => e.event === 's3_ok'));
  setAgentRunner(null);
});

test('AC-010: a lane with no plan commits nothing at S3 and reaches the card as before', async () => {
  setup('  executor: { role: r }\n');
  const wt = worktreeOf();
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  assert.equal(gitIn(wt, 'rev-parse', 'HEAD'), start, 'no commit for a lane with no plan');
  assert.ok(!readLifecycle().some((e) => e.event === 's3_plan_archived'));
  assert.ok(readLifecycle().some((e) => e.event === 's3_ok'));
  setAgentRunner(null);
});

test('AC-005: uncommitted changes that are only the lane records are committed before the plan is archived', async () => {
  const wt = setupPlan('  executor: { role: r }\n');
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  mkdirSync(join(wt, '_docs/qa/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, '_docs/qa/Demo/idd-001/qa.md'), 'qa\n');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.deepEqual(res.errors, []);
  const names = readLifecycle().map((e) => e.event);
  assert.ok(names.includes('s3_plan_archived'), 'the plan is archived');
  assert.ok(!names.includes('s3_plan_archive_failed'));
  assert.ok(existsSync(join(wt, ARCHIVE_PATH)));
  assert.ok(!existsSync(join(wt, PLAN_PATH)), 'the plan left the live place');
  // the records are their own commit, then the move; nothing else is committed
  assert.equal(gitIn(wt, 'rev-list', '--count', `${start}..HEAD`), '2');
  const recordCommit = gitIn(wt, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').filter(Boolean).sort();
  assert.deepEqual(recordCommit, ['_docs/qa/Demo/idd-001/qa.md']);
  assert.equal(gitIn(wt, 'status', '--porcelain', '--untracked-files=all'), '', 'the worktree is clean');
  setAgentRunner(null);
});

test('AC-005: a context document the executor appended is committed with the records and stays after the archive', async () => {
  const wt = setupPlan('  executor: { role: r }\n');
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  const contextPath = '_docs/context/Demo/idd-001/context.md';
  mkdirSync(join(wt, '_docs/context/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, contextPath), '# 事実\n\n- 計画役の事実\n\n## 実装中に足した事実\n\n- 実装役の事実\n');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.deepEqual(res.errors, []);
  assert.ok(readLifecycle().some((e) => e.event === 's3_plan_archived'), 'the plan is archived');
  assert.ok(existsSync(join(wt, ARCHIVE_PATH)) && !existsSync(join(wt, PLAN_PATH)), 'only the plan moved');
  assert.ok(existsSync(join(wt, contextPath)), 'the context document stays in the worktree');
  assert.match(readFileSync(join(wt, contextPath), 'utf8'), /実装役の事実/);
  // the append is the lane's record: it is committed on its own, before the move
  assert.equal(gitIn(wt, 'rev-list', '--count', `${start}..HEAD`), '2');
  const recordCommit = gitIn(wt, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').filter(Boolean).sort();
  assert.deepEqual(recordCommit, [contextPath]);
  assert.equal(gitIn(wt, 'status', '--porcelain', '--untracked-files=all'), '', 'the worktree is clean');
  setAgentRunner(null);
});

test('AC-006: a change outside the lane records still stops the archive and adds no commit', async () => {
  const wt = setupPlan('  executor: { role: r }\n');
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  mkdirSync(join(wt, '_docs/qa/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, '_docs/qa/Demo/idd-001/qa.md'), 'qa\n');
  writeFileSync(join(wt, 'scratch.txt'), 'x\n');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.match(res.errors[0].error, /未 commit の変更/);
  assert.ok(!readLifecycle().some((e) => e.event === 's3_ok'), 'the lane is held');
  assert.ok(readLifecycle().some((e) => e.event === 's3_plan_archive_failed'), 'the stop is on record as before');
  assert.equal(gitIn(wt, 'rev-parse', 'HEAD'), start, 'no commit was added, not even for the record-only changes');
  const dirty = gitIn(wt, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort();
  assert.deepEqual(dirty, ['?? _docs/qa/Demo/idd-001/qa.md', '?? scratch.txt']);
  assert.ok(existsSync(join(wt, PLAN_PATH)), 'the plan is still in the live place');
  setAgentRunner(null);
});

// ---------------------------------------------------------------- the plan-reference rewrite (AC-001..AC-005, AC-008..AC-013)

const REF_DECISION = '_docs/intent/Demo/idd-001/decision.md';
const REF_QA = '_docs/qa/Demo/idd-001/qa.md';
const REF_REFERENCE = '_docs/reference/Demo/idd-001/reference.md';
const REF_OTHER = '_docs/guide/Demo/other.md';

/**
 * The record check a repo without the real validator runs: it fails while the archived plan's live path is still
 * named in the records. The archive's rewrite is what lets the check pass.
 */
const brokenRefCheck = [
  'if [ -f _docs/archives/plan/Demo/idd-001/plan.md ] && grep -rq -- "_docs/plan/Demo/idd-001/plan.md" _docs/intent _docs/qa _docs/reference; then',
  '  echo "ERROR: _docs/intent/Demo/idd-001/decision.md: missing local link target" >&2',
  '  exit 1',
  'fi',
  '',
].join('\n');

/** a plan whose records name it in the four shapes the check follows: a `references` bullet, a one-line array, an inline link (root and relative) and a reference definition */
const seedPlanRefs = (wt) => {
  seedPlan(wt);
  mkdirSync(join(wt, 'scripts'), { recursive: true });
  writeFileSync(join(wt, 'scripts/check-docs.sh'), brokenRefCheck);
  mkdirSync(join(wt, '_docs/intent/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, REF_DECISION), ['---', 'title: d', 'references:', `  - "${PLAN_PATH}"`, '  - "_docs/qa/Demo/idd-001/qa.md"', '---', '', '# d', ''].join('\n'));
  mkdirSync(join(wt, '_docs/qa/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, REF_QA), ['---', 'title: q', `references: ["${PLAN_PATH}", "_docs/intent/Demo/idd-001/decision.md"]`, '---', '', '# q', ''].join('\n'));
  mkdirSync(join(wt, '_docs/reference/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, REF_REFERENCE), [
    '---', 'title: r', 'status: active', 'references:', '  - "_docs/intent/Demo/idd-001/decision.md"', '---', '', '# r', '',
    `[plan](${PLAN_PATH})`, '',
    '[plan-relative](../../../plan/Demo/idd-001/plan.md)', '',
    `[plan]: ${PLAN_PATH}`, '',
    'See [the plan][plan].', '',
  ].join('\n'));
  mkdirSync(join(wt, '_docs/guide/Demo'), { recursive: true });
  writeFileSync(join(wt, REF_OTHER), ['---', 'title: o', 'status: active', 'references:', '  - "_docs/intent/Demo/idd-001/decision.md"', '---', '', '# o', '', `[plan](${PLAN_PATH})`, ''].join('\n'));
};

const ARCHIVED_COMMIT_FILES = [ARCHIVE_PATH, REF_DECISION, REF_QA, REF_REFERENCE, REF_OTHER].sort();
const rewrittenFiles = () => { const e = readLifecycle().find((x) => x.event === 's3_plan_archived'); return Array.isArray(e?.attrs?.files) ? e.attrs.files.map(String) : []; };

const DOC_LINKS = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/validate-doc-links.ts');
const hasDeno = spawnSync('deno', ['--version']).status === 0 && existsSync(DOC_LINKS);

/** the repo's real doc-links validator, run in the temp repo as check-docs would run it */
function runDocLinks(cwd) {
  const r = spawnSync('deno', ['run', '--allow-read', '--allow-env', '--allow-run=git', DOC_LINKS], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** move the plan without rewriting the references, the way the harness did before this change */
function movePlanAlone(wt) {
  mkdirSync(dirname(join(wt, ARCHIVE_PATH)), { recursive: true });
  gitIn(wt, 'mv', PLAN_PATH, ARCHIVE_PATH);
  gitIn(wt, 'commit', '-q', '-m', 'docs(plan): 作業指示を archive へ移す');
}

test('AC-001 / AC-005: the archive commit rewrites the record references in the same commit', async () => {
  const wt = setupPlan('  executor: { role: r }\n', seedPlanRefs);
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.deepEqual(res.errors, []);
  assert.ok(readLifecycle().some((e) => e.event === 's3_plan_archived'));
  assert.equal(gitIn(wt, 'rev-list', '--count', `${start}..HEAD`), '1', 'the move and the rewrite are one commit and nothing else is committed');
  const files = gitIn(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ARCHIVED_COMMIT_FILES, 'the commit carries the plan paths and the rewritten records alone');
  const rewritten = rewrittenFiles().sort();
  assert.deepEqual(rewritten, [REF_DECISION, REF_QA, REF_REFERENCE, REF_OTHER].sort());
  for (const f of rewritten) {
    const text = readFileSync(join(wt, f), 'utf8');
    assert.ok(text.includes(ARCHIVE_PATH), `${f} points at the archive`);
    assert.ok(!text.includes(PLAN_PATH), `${f} no longer points at the live plan`);
  }
  assert.equal(gitIn(wt, 'status', '--porcelain', '--untracked-files=all'), '', 'the worktree is clean');
  setAgentRunner(null);
});

test('AC-002: the real doc-links check passes after the archive and fails when the references are left behind', { skip: !hasDeno }, async () => {
  const wt = setupPlan('  executor: { role: r }\n', seedPlanRefs);
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  const after = runDocLinks(wt);
  assert.equal(after.code, 0, after.out);
  setAgentRunner(null);
  // the same records with the plan moved and the references not rewritten: the check the fix is for still fails
  const other = setupPlan('  executor: { role: r }\n', seedPlanRefs);
  movePlanAlone(other);
  const before = runDocLinks(other);
  assert.notEqual(before.code, 0, before.out);
  assert.match(before.out, /missing local link target/);
});

const seedPlanRefsNarrow = (wt) => {
  seedPlanRefs(wt);
  writeFileSync(join(wt, REF_DECISION), [
    '---', 'title: d', 'references:', `  - "${PLAN_PATH}"`, '  - "_docs/plan/Other/x/plan.md"', '---', '', '# d', '',
    '```', `[fenced](${PLAN_PATH})`, '```', '',
  ].join('\n'));
  mkdirSync(join(wt, '_docs/plan/Other/x'), { recursive: true });
  writeFileSync(join(wt, '_docs/plan/Other/x/plan.md'), '---\ntitle: other\n---\n\n# other\n');
};

test('AC-003: only the lane\'s own plan path is rewritten; another plan and a fenced code block are left alone', async () => {
  const wt = setupPlan('  executor: { role: r }\n', seedPlanRefsNarrow);
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  const decision = readFileSync(join(wt, REF_DECISION), 'utf8');
  assert.ok(decision.includes(ARCHIVE_PATH), 'the lane plan link is rewritten');
  assert.ok(decision.includes('_docs/plan/Other/x/plan.md'), 'another plan is not');
  assert.ok(decision.includes(`[fenced](${PLAN_PATH})`), 'a fenced code block is not');
  assert.ok(readFileSync(join(wt, REF_OTHER), 'utf8').includes(ARCHIVE_PATH), 'a file the lane never named is rewritten too');
  setAgentRunner(null);
});

test('AC-004: a failed archive commit puts the rewritten records back with the move', async () => {
  const wt = setupPlan('  executor: { role: r }\n', seedPlanRefs);
  const hook = join(wt, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.match(res.errors[0].error, /archive へ移せませんでした/);
  assert.equal(gitIn(wt, 'status', '--porcelain', '--untracked-files=all'), '', 'the rewrites did not stay in the worktree');
  assert.equal(gitIn(wt, 'rev-parse', 'HEAD'), start, 'no commit was made');
  assert.ok(existsSync(join(wt, PLAN_PATH)), 'the plan is back where it was');
  assert.ok(!existsSync(join(wt, ARCHIVE_PATH)));
  assert.ok(readFileSync(join(wt, REF_DECISION), 'utf8').includes(PLAN_PATH), 'the reference is back to the live path');
  assert.ok(!readFileSync(join(wt, REF_DECISION), 'utf8').includes(ARCHIVE_PATH));
  rmSync(hook);
  await runSubmitPrep();
  assert.ok(existsSync(join(wt, ARCHIVE_PATH)));
  assert.ok(readFileSync(join(wt, REF_DECISION), 'utf8').includes(ARCHIVE_PATH));
  setAgentRunner(null);
});

test('AC-005: a lane whose records do not reference the plan commits the move alone', async () => {
  const wt = setupPlan('  executor: { role: r }\n');
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  assert.equal(gitIn(wt, 'rev-list', '--count', `${start}..HEAD`), '1');
  const files = gitIn(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
  assert.deepEqual(files, [ARCHIVE_PATH]);
  assert.ok(!existsSync(join(wt, PLAN_PATH)), 'the live plan is gone');
  assert.deepEqual(rewrittenFiles(), []);
  setAgentRunner(null);
});

const failedRewrites = () => readLifecycle().filter((e) => e.event === 's3_plan_archive_failed');

test('AC-008: a lane re-entering S3 fixes its references before S3 passes', async () => {
  const wt = setupPlan('  executor: { role: r }\n', seedPlanRefs);
  movePlanAlone(wt);
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  const events = readLifecycle().map((e) => e.event);
  assert.ok(events.includes('s3_plan_refs_fixed'), JSON.stringify(events));
  assert.ok(events.indexOf('s3_plan_refs_fixed') < events.indexOf('s3_ok'), 'fixed before S3 passes');
  assert.ok(readFileSync(join(wt, REF_DECISION), 'utf8').includes(ARCHIVE_PATH));
  setAgentRunner(null);
});

test('AC-012: the same archive reason is written once, a different one is written again', async () => {
  const wt = setupPlan('  executor: { role: r }\n', seedPlanRefs);
  writeFileSync(join(wt, 'scratch.txt'), 'x\n');
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  await runSubmitPrep();
  await runSubmitPrep();
  assert.equal(failedRewrites().length, 1, 'the same reason is not stacked');
  rmSync(join(wt, 'scratch.txt'));
  const hook = join(wt, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  await runSubmitPrep();
  assert.equal(failedRewrites().length, 2, 'a changed reason is written');
  rmSync(hook);
  setAgentRunner(null);
  // a success since the last S3 does not silence a new failure
  const other = setupPlan('  executor: { role: r }\n');
  await seedLifecycle('s3_plan_archived', 'IDD-001', { from: PLAN_PATH, to: ARCHIVE_PATH, commit: 'x' });
  writeFileSync(join(other, 'scratch.txt'), 'x\n');
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  assert.equal(failedRewrites().length, 1);
  setAgentRunner(null);
});

test('AC-011: an S3 repair that cannot go through is recorded and holds S3', async () => {
  const wt = setupPlan('  executor: { role: r }\n', seedPlanRefs);
  movePlanAlone(wt);
  // the archived plan's references cannot be fixed with an uncommitted change in the worktree
  writeFileSync(join(wt, 'scratch.txt'), 'x\n');
  setAgentRunner({ deliver: async () => {} });
  const res = await runSubmitPrep();
  assert.deepEqual(res.submitted, []);
  assert.ok(res.errors.some((e) => e.iddId === 'IDD-001' && /未 commit の変更/.test(e.error)), JSON.stringify(res.errors));
  const failed = failedRewrites();
  assert.equal(failed.length, 1, JSON.stringify(readLifecycle().map((e) => e.event)));
  assert.match(failed[0].attrs.reason, /未 commit の変更/);
  assert.ok(!readLifecycle().some((e) => e.event === 's3_ok'));
  setAgentRunner(null);
});


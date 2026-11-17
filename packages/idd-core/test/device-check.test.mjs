import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { buildSubmitReview } from '../src/plan/ship.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { overallLineOf } from '../src/intent/parse.ts';
import { deviceVerdict, compareDirOf } from '../src/plan/device-check.ts';
import { headCommit } from '../src/worktree/ensure.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { tmpDir } from './helpers/tmp.mjs';

// The device stage (pipeline.device_check) is the lane's overall judgement: who judges is the lane's own
// declaration (qa.md の全体の行), and the pictures in compare/ are the judging input. These tests walk the loop
// for each judge and for a picture set that is missing or stale.

const ID = 'IDD-001';
const AREA = 'Demo';
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ev = (event, attrs = {}) => ({ event, idd_id: ID, at: '2026-09-01T10:00:00+09:00', attrs });

function git(wt, args) {
  return execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8' }).trim();
}

function qaPath(wt) {
  return join(wt, '_docs', 'qa', AREA, 'idd-001', 'qa.md');
}

/**
 * A lane with an executor worktree, a qa.md whose 全体 line declares `judge`, and (optionally) two pictures in
 * compare/ committed at the head. `codeAfter` puts a code commit after the pictures, so they are not of the head.
 */
function setup({ device = true, judge = '絵を見る役', pictures = true, codeAfter = false } = {}) {
  const state = tmpDir('idd-device-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), [
    'roles:',
    '  r: { model: x/y, report: review }',
    '  j: { model: x/y, report: triage }',
    'pipeline:',
    '  review_blind: { roles: [r] }',
    '  triage: { role: j }',
    '  confirm: { role: r }',
    ...(device ? ['  device_check: { role: r }'] : []),
    '',
  ].join('\n'));
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-device-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const base = git(wt, ['rev-parse', 'HEAD']);
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: ID, parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'T', area: AREA }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: ID, executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: base }), ev('s2_result', { outcome: 'success' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const touch = () => execFileSync('git', ['-C', wt, 'add', '-A']);
  const commit = (message) => execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', message]);
  if (judge) {
    mkdirSync(join(wt, '_docs', 'qa', AREA, 'idd-001'), { recursive: true });
    writeFileSync(qaPath(wt), `## Acceptance Criteria\n\n- 全体: 画面が設計どおりに見える（判定: ${judge}）\n- AC-001: x\n`);
  }
  if (pictures) {
    mkdirSync(join(wt, '_docs', 'qa', AREA, 'idd-001', 'compare'), { recursive: true });
    writeFileSync(join(wt, '_docs', 'qa', AREA, 'idd-001', 'compare', 'home-impl.png'), 'x');
    writeFileSync(join(wt, '_docs', 'qa', AREA, 'idd-001', 'compare', 'home-proto.png'), 'x');
  }
  if (judge || pictures) { touch(); commit('pictures'); }
  if (codeAfter) { writeFileSync(join(wt, 'code.txt'), 'changed'); touch(); commit('code'); }
  return { state, wt, head: headCommit(wt) };
}

function runner() {
  const started = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => { started.push(o); const id = `run-${started.length}`; status[id] = { state: 'running' }; return { runIds: [id] }; },
    reviewRunStatus: (id) => status[id],
  });
  return { started, status, last: () => `run-${started.length}` };
}

const deviceStarted = () => readLifecycle().findLast((e) => e.event === 's2_device_started');
const deviceDone = () => readLifecycle().findLast((e) => e.event === 's2_device_done');
const deviceSkipped = () => readLifecycle().findLast((e) => e.event === 's2_device_skipped');

test('the 全体 line and its judge are read from qa.md', () => {
  assert.deepEqual(overallLineOf('- 全体: 画面が正しい（判定: 人。着地後に見る）\n- AC-001: x\n'), { text: '画面が正しい', judge: 'human', word: '人' });
  assert.deepEqual(overallLineOf('- 全体: 見比べる（判定: 絵を見る役）\n'), { text: '見比べる', judge: 'viewer', word: '絵を見る役' });
  assert.equal(overallLineOf('- 全体: 何か（判定: device_check）\n').judge, 'other');
  assert.equal(overallLineOf('- 全体: 判定者なし\n').judge, 'none');
  assert.equal(overallLineOf('- AC-001: x\n').judge, 'none');
});

test('AC-002: 判定者が絵を見る役なら、全体 1 文と compare/ の絵を役に渡し、must を判定と修正に回す', async () => {
  setup({ judge: '絵を見る役', pictures: true });
  const r = runner();
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_device_started');
  assert.equal(deviceStarted().attrs.judge, 'viewer');
  assert.equal(deviceStarted().attrs.pictures, 2);
  const inputs = r.started.at(-1).inputs;
  const statement = inputs.find((p) => /device-1\.md$/.test(p));
  assert.ok(statement, 'the overall statement is handed to the role');
  assert.match(readFileSync(statement, 'utf8'), /画面が設計どおりに見える/);
  assert.equal(inputs.filter((p) => /\.png$/.test(p)).length, 2, 'both pictures are handed to the role');
  assert.ok(inputs.some((p) => p.endsWith(join('compare', 'home-impl.png'))));
  // the role reports a must: it goes through the judgement and reaches the fix
  r.status[r.last()] = { state: 'done', reportJson: '/d.json', reportMd: '/d.md', findings: [{ severity: 'must', path: 'a.ts', claim: 'ボタンの位置が違う', evidence: '' }] };
  await runReviewLoop();
  assert.equal(deviceDone().attrs.blocking, 1);
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_triage_started');
  assert.equal(readLifecycle().at(-1).attrs.kind, 'device');
  r.status[r.last()] = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: 'ボタンの位置が違う', path: 'a.ts', fix: '設計どおりの位置', action: 'fix' }] };
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_triage_done');
  setAgentRunner(null);
});

test('AC-003: 絵を見る役の lane で絵が無ければ、役は走らず、満たさない must として判定に回る', async () => {
  const r = runner();
  setup({ judge: '絵を見る役', pictures: false });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_device_done');
  assert.equal(deviceDone().attrs.blocking, 1);
  assert.equal(deviceDone().attrs.judge, 'viewer');
  assert.match(deviceDone().attrs.findings[0].claim, /compare\/ に判定する画面の絵がありません/);
  assert.equal(readLifecycle().some((e) => e.event === 's2_device_started'), false, 'the role is not started with nothing to look at');
  assert.deepEqual(r.started, []);
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_triage_started');
  assert.equal(readLifecycle().at(-1).attrs.kind, 'device');
  setAgentRunner(null);
});

test('AC-003: 絵を見る役の lane で絵が head の画面と言えなければ、満たさない must として判定に回る', async () => {
  setup({ judge: '絵を見る役', pictures: true, codeAfter: true });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_device_done');
  assert.equal(deviceDone().attrs.blocking, 1);
  assert.match(deviceDone().attrs.findings[0].claim, /後に code が変わっています/);
  setAgentRunner(null);
});

test('AC-004: 判定者が人なら、絵があるときだけ役を起こし、指摘は修正に回らず提出前確認の card に並ぶ', async () => {
  const r = runner();
  setup({ judge: '人', pictures: true });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(deviceStarted().attrs.judge, 'human');
  r.status[r.last()] = {
    state: 'done', reportJson: '/d.json', reportMd: '/d.md',
    findings: [{ severity: 'must', path: 'a.ts', claim: 'ボタンの位置が違う', evidence: '' }, { severity: 'should', path: 'b.ts', claim: '余白が広い', evidence: '' }, { severity: 'nit', path: 'c.ts', claim: '文言', evidence: '' }],
  };
  await runReviewLoop();
  assert.equal(deviceDone().attrs.judge, 'human');
  assert.equal(reviewLoopState(readLifecycle()).state, 'done', 'a person judges: no judgement and no fix');
  assert.equal(readLifecycle().some((e) => e.event === 's2_triage_started'), false);
  const review = buildSubmitReview(readLifecycle());
  assert.equal(review.device.judge, 'human');
  assert.deepEqual(review.device.findings.map((f) => [f.severity, f.claim, f.path]), [['must', 'ボタンの位置が違う', 'a.ts'], ['should', '余白が広い', 'b.ts']]);
  setAgentRunner(null);
});

test('AC-004: 判定者が人で絵が無ければ、役を起こさず、理由が記録と card に残る', async () => {
  const r = runner();
  setup({ judge: '人', pictures: false });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_device_skipped');
  assert.match(deviceSkipped().attrs.reason, /人の lane で compare\/ に絵が無い/);
  assert.deepEqual(r.started, []);
  const review = buildSubmitReview(readLifecycle());
  assert.match(review.device.skipped, /compare\/ に絵が無い/);
  setAgentRunner(null);
});

test('AC-004: 判定者が人で絵が head の画面と言えなければ、card にそう出る', async () => {
  const r = runner();
  setup({ judge: '人', pictures: true, codeAfter: true });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(deviceStarted().attrs.judge, 'human');
  assert.match(deviceStarted().attrs.stale_reason, /後に code が変わっています/);
  r.status[r.last()] = { state: 'done', reportJson: '/d.json', reportMd: '/d.md', findings: [{ severity: 'must', path: 'a.ts', claim: '位置', evidence: '' }] };
  await runReviewLoop();
  const review = buildSubmitReview(readLifecycle());
  assert.match(review.device.stale, /後に code が変わっています/);
  setAgentRunner(null);
});

test('AC-005: 全体の行が無い lane は役を起こさず、理由を残す', async () => {
  const r = runner();
  setup({ judge: null, pictures: true });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_device_skipped');
  assert.match(deviceSkipped().attrs.reason, /全体の行か判定者が無い/);
  assert.deepEqual(r.started, []);
  assert.match(buildSubmitReview(readLifecycle()).device.skipped, /全体の行/);
  setAgentRunner(null);
});

test('AC-005: 人でも絵を見る役でもない判定者の lane は役を起こさず、理由を残す', async () => {
  const r = runner();
  setup({ judge: 'device_check', pictures: true });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_device_skipped');
  assert.match(deviceSkipped().attrs.reason, /判定者が「device_check」/);
  assert.deepEqual(r.started, []);
  setAgentRunner(null);
});

test('AC-005: device_check が未宣言の設定では役を起こさず、理由を残す', async () => {
  setup({ device: false, judge: '絵を見る役', pictures: true });
  await seedLifecycle('s2_review_converged', ID, {});
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_device_skipped');
  assert.match(deviceSkipped().attrs.reason, /未宣言/);
  setAgentRunner(null);
});

test('AC-005: qa.md の雛形が挙げる判定者の語は人と絵を見る役だけである', () => {
  const template = readFileSync(join(ROOT, '_docs', 'standards', 'templates', 'qa.md'), 'utf8');
  const line = template.split('\n').find((l) => /^-\s*全体:/.test(l));
  assert.ok(line, 'the template has an 全体 line');
  assert.match(line, /人/);
  assert.match(line, /絵を見る役/);
  assert.doesNotMatch(line, /device_check/);
});

test('AC-006: 画面と経過はこの段を実機の確認と呼ばない', () => {
  const files = [
    'packages/idd-engine/src/server/events-display.ts',
    'packages/idd-gui/src/strings.ts',
    'packages/idd-gui/src/inbox/viewmodel.ts',
    'packages/idd-core/src/ledger/review-loop.ts',
    'packages/idd-core/src/plan/review-loop.ts',
    'packages/idd-lane/src/review-runs.ts',
  ];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /実機確認/, `${rel} must not call this stage 実機確認`);
  }
});

test('deviceVerdict reads the judge and the pictures of the lane head', () => {
  const { wt } = setup({ judge: '絵を見る役', pictures: true });
  const verdict = deviceVerdict({ area: AREA, idd_id: ID }, { worktree: wt, head: headCommit(wt) });
  assert.equal(verdict.action, 'run');
  assert.equal(verdict.judge, 'viewer');
  assert.equal(verdict.pictures.length, 2);
  assert.ok(compareDirOf({ area: AREA, idd_id: ID }).endsWith(join('qa', AREA, 'idd-001', 'compare')));
  setAgentRunner(null);
});

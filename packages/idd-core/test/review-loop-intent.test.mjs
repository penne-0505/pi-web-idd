import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop, setRecordsCheckRunner, trunkCommand } from '../src/plan/review-loop.ts';
import { buildSubmitReview } from '../src/plan/ship.ts';
import { lanesAwaitingCheck } from '../src/plan/review.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { fixCapReached, MERGE_ONLY_SKIP_EVENT, reviewLoopState } from '../src/ledger/review-loop.ts';
import { reviewBaseOf } from '../src/ledger/base.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { awaitedAgent } from '../src/plan/watch.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { tmpDir } from './helpers/tmp.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let seq = 0;
const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-1', at: new Date(Date.parse('2026-10-01T00:00:00Z') + (seq += 1) * 1000).toISOString(), attrs });

const FINDING = { rule: 'round', id: 'IDD-1', reason: '巡（x まで）に Choice の新設・Re-anchor・Supersede・Waive がありません' };

/** a lane whose review has converged, in a repo that does or does not declare a records `intent` check */
function setup({ intent = true, run = true } = {}) {
  const command = run ? 'printf \'error round IDD-1: hole\\nerror 1 件、注記 0 件、印 0 件\\n\'; exit 1' : 'true';
  return setupWith({ intent, command });
}

/**
 * The same fixture with the records check's command chosen by the test; `trunk` is the work clone when it is not the
 * lane's worktree, and `land` cuts the work base `main` with a commit of its own for the lane to merge in.
 */
function setupWith({ intent = true, command = 'true', trunk, land = false } = {}) {
  seq = 0;
  const state = tmpDir('idd-records-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-records-wt-');
  // the branch is named: `land` cuts the work base `main` beside it and reads the lane's own name back
  git(wt, 'init', '-q', '-b', 'lane');
  writeFileSync(join(wt, 'overlay.manifest'), '_docs/\noverlay.manifest\n');
  mkdirSync(join(wt, '_docs'), { recursive: true });
  writeFileSync(join(wt, '_docs', 'q.md'), 'q\n');
  writeFileSync(join(wt, 'code.txt'), 'one\n');
  git(wt, 'add', '-A');
  git(wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'init');
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  let mainline = head;
  if (land) {
    // the lane's work base, with a commit of its own that the executor takes in without resolving anything
    const lane = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(wt, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(wt, 'mainline.txt'), 'main\n');
    git(wt, 'add', '-A');
    git(wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'mainline');
    mainline = git(wt, 'rev-parse', 'HEAD').trim();
    git(wt, 'checkout', '-q', lane);
  }
  const repos = join(state, 'repos.yaml');
  writeFileSync(repos, [
    'repos:',
    '  demo/repo:',
    `    upstream: ${wt}`,
    `    work: ${trunk ?? wt}`,
    '    work_base: main',
    '    public_base: main',
    ...(intent ? ['    checks:', `      - { name: intent, command: ${JSON.stringify(command)}, scope: records }`] : ['    checks: []']),
    '',
  ].join('\n'));
  process.env.IDD_REPOS_FILE = repos;
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'demo/repo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-demo-repo.jsonl'), [
    ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' }),
    // the review a land lane's head was read at: a skip is measured from the head a round recorded
    ...(land ? [ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'], head })] : []),
    ev('s2_review_converged', {}),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state, wt, head, mainline };
}

const lastEvent = () => readLifecycle().at(-1).event;
const lastOf = (name) => [...readLifecycle()].reverse().find((e) => e.event === name);
const envelopeOf = (state) => {
  const rows = readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.at(-1);
  return { row, xml: readFileSync(join(state, 'outbox', `${row.envelope_id}.xml`), 'utf8') };
};

test('AC-001: a converged lane takes the records check before S3; a repo without one goes on as before', async () => {
  const f = setup();
  setRecordsCheckRunner(async () => ({ outcome: 'clean' }));
  try {
    assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), [], 'the review has not reached S3 yet');
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_intent_checked');
    assert.equal(lastOf('s2_intent_checked').attrs.outcome, 'clean');
    assert.equal(reviewLoopState(readLifecycle()).state, 'done');
    assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), ['IDD-1'], 'S3 may run only after the check');
  } finally { setRecordsCheckRunner(null); }

  const g = setup({ intent: false });
  await runReviewLoop();
  assert.equal(lastEvent(), 's2_device_skipped');
  assert.ok(!readLifecycle().some((e) => e.event === 's2_intent_checked'), 'a repo without the check takes none');
  assert.deepEqual(lanesAwaitingCheck().map((r) => r.idd_id), ['IDD-1']);
});

test('AC-002: an error sends the lane back with the errors, without spending a fix round', async () => {
  const f = setup();
  setRecordsCheckRunner(async () => ({ outcome: 'errors', findings: [FINDING] }));
  try {
    await runReviewLoop();
  } finally { setRecordsCheckRunner(null); }
  assert.equal(lastEvent(), 's2_records_instructed');
  assert.equal(reviewLoopState(readLifecycle()).state, 'awaiting_records_fix');
  assert.equal(fixCapReached(readLifecycle()), null, 'the send-back is not a fix round');
  assert.equal(readLifecycle().filter((e) => e.event === 's2_fix_sent').length, 0);
  assert.equal(deriveStage(readLifecycle()).group, 'impl');
  assert.equal(awaitedAgent(readLifecycle()).role, 'executor', 'the lane reads as the executor turn');
  const { row, xml } = envelopeOf(f.state);
  assert.equal(row.type, 'lane_rejected');
  assert.equal(row.skip_fix_plan, undefined, 'the fix planner is not skipped');
  assert.match(xml, /round/);
  assert.match(xml, /Choice の新設・Re-anchor・Supersede・Waive/);
  assert.match(xml, /この差し戻しで開いた巡/);
});

test('AC-003: a records-only fix rechecks without a review round; code changed reopens the review', async () => {
  const f = setup();
  const sent = [];
  setRecordsCheckRunner(async () => { sent.push(1); return { outcome: 'errors', findings: [FINDING] }; });
  try {
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_records_instructed');
    // the executor commits a record only, then reports
    writeFileSync(join(f.wt, '_docs', 'q.md'), 'q fixed\n');
    git(f.wt, 'add', '-A');
    git(f.wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'records');
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_intent_checked');
    assert.equal(lastOf('s2_intent_checked').attrs.sent_back, false);
    assert.ok(!readLifecycle().some((e) => e.event === 's2_records_reopened'), 'records only: no review round');
    assert.equal(reviewLoopState(readLifecycle()).state, 'done');
  } finally { setRecordsCheckRunner(null); }

  const g = setup();
  setRecordsCheckRunner(async () => ({ outcome: 'errors', findings: [FINDING] }));
  try {
    await runReviewLoop();
    // the executor changes code outside the records place, then reports
    writeFileSync(join(g.wt, 'code.txt'), 'two\n');
    git(g.wt, 'add', '-A');
    git(g.wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'code');
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_records_reopened');
    assert.deepEqual(lastOf('s2_records_reopened').attrs.files, ['code.txt']);
    assert.equal(reviewLoopState(readLifecycle()).state, 'start_blind', 'the review rounds run again');
  } finally { setRecordsCheckRunner(null); }
});

test('AC-004: one send-back per convergence, and the same errors are not sent again', async () => {
  const f = setup();
  setRecordsCheckRunner(async () => ({ outcome: 'errors', findings: [FINDING] }));
  try {
    await runReviewLoop();
    assert.equal(readLifecycle().filter((e) => e.event === 's2_records_conflict').length, 1);
    // the executor answers without fixing the record
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_intent_checked');
    assert.equal(lastOf('s2_intent_checked').attrs.sent_back, false);
    assert.equal(readLifecycle().filter((e) => e.event === 's2_records_conflict').length, 1, 'the same errors are not sent again');
    assert.equal(reviewLoopState(readLifecycle()).state, 'done', 'the lane is not stopped by an error it cannot fix');
  } finally { setRecordsCheckRunner(null); }
});

test('AC-002: the same error with a changed diagnostic text is not sent back again', async () => {
  setup();
  const checks = [];
  setRecordsCheckRunner(async () => {
    checks.push(1);
    // the same rule and id, but the check's wording moved: it is the same error, not a new one
    return { outcome: 'errors', findings: checks.length === 1 ? [FINDING] : [{ ...FINDING, reason: '巡（x まで）に Choice の新設がありません' }] };
  });
  try {
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_records_instructed');
    // the executor answers without fixing the record
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(checks.length, 2, 'the check runs again for the answer');
    assert.equal(readLifecycle().filter((e) => e.event === 's2_records_conflict').length, 1, 'the same error is not sent back again');
    assert.equal(lastOf('s2_intent_checked').attrs.sent_back, false);
    assert.equal(reviewLoopState(readLifecycle()).state, 'done', 'the lane goes on instead of sending it back without end');
  } finally { setRecordsCheckRunner(null); }
});

test('AC-002: an error the lane was never told about goes back to the executor', async () => {
  setup();
  const checks = [];
  setRecordsCheckRunner(async () => {
    checks.push(1);
    return { outcome: 'errors', findings: checks.length === 1 ? [FINDING] : [{ rule: 'record', id: 'C-1', reason: '別の error' }] };
  });
  try {
    await runReviewLoop();
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(readLifecycle().filter((e) => e.event === 's2_records_conflict').length, 2, 'the new error is sent back');
    assert.equal(reviewLoopState(readLifecycle()).state, 'awaiting_records_fix', 'the lane waits for the executor');
  } finally { setRecordsCheckRunner(null); }
});

test('AC-004: the errors the check left are on the card the human decides', async () => {
  setup();
  setRecordsCheckRunner(async () => ({ outcome: 'errors', findings: [FINDING] }));
  try {
    await runReviewLoop();
    // the executor answers without fixing the record: the error stays, and the card says so
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_intent_checked');
    const review = buildSubmitReview(readLifecycle());
    assert.deepEqual(review.recordsErrors, [FINDING], 'the error the lane could not fix is on the card');
  } finally { setRecordsCheckRunner(null); }
});

test('AC-005: a check that cannot answer leaves the lane moving to S3, with the reason on record', async () => {
  const f = setup();
  setRecordsCheckRunner(async () => ({ outcome: 'unavailable', reason: '口を呼べませんでした' }));
  try {
    const r = await runReviewLoop();
    assert.equal(lastEvent(), 's2_intent_checked');
    assert.equal(lastOf('s2_intent_checked').attrs.outcome, 'unavailable');
    assert.match(lastOf('s2_intent_checked').attrs.reason, /口を呼べませんでした/);
    assert.ok(!readLifecycle().some((e) => e.event === 's2_records_conflict'));
    assert.equal(reviewLoopState(readLifecycle()).state, 'done');
    assert.deepEqual(r.errors, [], 'the check failing is not a stage failure');
    assert.deepEqual(lanesAwaitingCheck().map((x) => x.idd_id), ['IDD-1']);
  } finally { setRecordsCheckRunner(null); }
});

test('the repo command is run in the lane worktree and its error output is read', async () => {
  const f = setup();
  await runReviewLoop();
  assert.equal(lastEvent(), 's2_records_instructed');
  const { row, xml } = envelopeOf(f.state);
  assert.equal(row.type, 'lane_rejected');
  assert.equal(row.skip_fix_plan, undefined);
  assert.match(xml, /hole/);
  assert.match(xml, /round/);
});

test('a command that cannot answer is not read as a finding', async () => {
  const f = setupWith({ command: "printf '起点が見つかりません' >&2; exit 2" });
  await runReviewLoop();
  assert.equal(lastEvent(), 's2_intent_checked');
  assert.equal(lastOf('s2_intent_checked').attrs.outcome, 'unavailable');
  assert.match(lastOf('s2_intent_checked').attrs.reason, /起点が見つかりません/);
  assert.ok(!existsSync(join(f.state, 'outbox.jsonl')), 'an unanswerable check queues nothing');
});

// ---- IDD-194: the records send-back answered by the mainline merged in ----

const commitInWt = (wt, message) => {
  git(wt, 'add', '-A');
  git(wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', message);
  return git(wt, 'rev-parse', 'HEAD').trim();
};

test('AC-002: a records send-back answered by the mainline merged in rechecks the records, not the review', async () => {
  const f = setupWith({ land: true });
  const checks = [];
  const started = [];
  setRecordsCheckRunner(async () => { checks.push(1); return checks.length === 1 ? { outcome: 'errors', findings: [FINDING] } : { outcome: 'clean' }; });
  setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { started.push(o); return { runIds: ['r'] }; } });
  try {
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_records_instructed');
    // the executor fixes the record, then takes the mainline in without resolving a line by hand
    writeFileSync(join(f.wt, '_docs', 'q.md'), 'q fixed\n');
    commitInWt(f.wt, 'records');
    git(f.wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'merge', '-q', '--no-edit', 'main');
    const head = git(f.wt, 'rev-parse', 'HEAD').trim();
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(checks.length, 2, 'the records check runs again after the merge');
    assert.equal(lastEvent(), MERGE_ONLY_SKIP_EVENT, 'the skipped round stands after the verdict it was checked for');
    assert.equal(lastOf('s2_intent_checked').attrs.outcome, 'clean');
    assert.ok(!readLifecycle().some((e) => e.event === 's2_records_reopened'), 'no round is opened for the merge');
    assert.deepEqual(started, [], 'no review stage is started');
    const skip = lastOf(MERGE_ONLY_SKIP_EVENT);
    assert.deepEqual([skip.attrs.head, skip.attrs.merge, skip.attrs.mainline], [head, head, f.mainline]);
    assert.equal(skip.attrs.reviewed_head, f.head, 'the head the review last read is kept with the merge');
    assert.equal(reviewBaseOf(readLifecycle()), skip.attrs.review_base, 'the origin moved past the mainline');
    assert.equal(reviewLoopState(readLifecycle()).state, 'done', 'S3 may run');
  } finally { setRecordsCheckRunner(null); setAgentRunner(null); }
});

test('a records send-back answered by code beside the merge still opens the round', async () => {
  const f = setupWith({ land: true });
  const started = [];
  setRecordsCheckRunner(async () => ({ outcome: 'errors', findings: [FINDING] }));
  setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { started.push(o); return { runIds: ['r'] }; }, reviewRunStatus: () => ({ state: 'running' }) });
  try {
    await runReviewLoop();
    writeFileSync(join(f.wt, 'code.txt'), 'two\n');
    commitInWt(f.wt, 'code');
    git(f.wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'merge', '-q', '--no-edit', 'main');
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_records_reopened');
    assert.deepEqual(lastOf('s2_records_reopened').attrs.files, ['code.txt', 'mainline.txt']);
    assert.ok(!readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT), 'nothing is skipped');
    assert.equal(reviewLoopState(readLifecycle()).state, 'start_blind', 'the round runs again');
    assert.deepEqual(started, [], 'the round is the next tick to start');
  } finally { setRecordsCheckRunner(null); setAgentRunner(null); }
});

test('AC-002: a merge-only answer whose recheck finds a new error goes back to the executor, not past S3', async () => {
  const f = setupWith({ land: true });
  const brought = { rule: 'record', id: 'C-1', reason: '本流の merge が持ち込んだ error' };
  const checks = [];
  setRecordsCheckRunner(async () => {
    checks.push(1);
    return checks.length === 1 ? { outcome: 'errors', findings: [FINDING] } : { outcome: 'errors', findings: [FINDING, brought] };
  });
  const started = [];
  setAgentRunner({ deliver: async () => {}, startReviewRun: async (o) => { started.push(o); return { runIds: ['r'] }; } });
  try {
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_records_instructed');
    // the executor fixes the record, then takes the mainline in without resolving a line by hand
    writeFileSync(join(f.wt, '_docs', 'q.md'), 'q fixed\n');
    commitInWt(f.wt, 'records');
    git(f.wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'merge', '-q', '--no-edit', 'main');
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(checks.length, 2, 'the records check runs again after the merge');
    assert.equal(lastEvent(), 's2_records_instructed', 'the error the merge brought goes to the executor');
    assert.equal(readLifecycle().filter((e) => e.event === 's2_records_conflict').length, 2, 'a second send-back is made');
    assert.equal(reviewLoopState(readLifecycle()).state, 'awaiting_records_fix', 'the lane does not go on to S3');
    assert.ok(!readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT), 'no round is skipped for a head the check refuses');
    assert.ok(!readLifecycle().some((e) => e.event === 's2_records_reopened'), 'the merge opens no review round');
    assert.deepEqual(started, [], 'no review stage is started');
    const { row, xml } = envelopeOf(f.state);
    assert.equal(row.type, 'lane_rejected');
    assert.match(xml, /本流の merge が持ち込んだ error/);
  } finally { setRecordsCheckRunner(null); setAgentRunner(null); }
});

test('AC-004: a merge-only answer whose recheck finds only the errors already sent skips the round', async () => {
  const f = setupWith({ land: true });
  const checks = [];
  setRecordsCheckRunner(async () => { checks.push(1); return { outcome: 'errors', findings: [FINDING] }; });
  setAgentRunner({ deliver: async () => {}, startReviewRun: async () => ({ runIds: ['r'] }) });
  try {
    await runReviewLoop();
    writeFileSync(join(f.wt, '_docs', 'q.md'), 'q fixed\n');
    commitInWt(f.wt, 'records');
    git(f.wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'merge', '-q', '--no-edit', 'main');
    const head = git(f.wt, 'rev-parse', 'HEAD').trim();
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(checks.length, 2);
    assert.equal(lastEvent(), MERGE_ONLY_SKIP_EVENT);
    assert.equal(lastOf('s2_intent_checked').attrs.sent_back, false, 'the same error is not sent again');
    assert.equal(readLifecycle().filter((e) => e.event === 's2_records_conflict').length, 1);
    assert.equal(lastOf(MERGE_ONLY_SKIP_EVENT).attrs.head, head);
    assert.equal(reviewLoopState(readLifecycle()).state, 'done');
  } finally { setRecordsCheckRunner(null); setAgentRunner(null); }
});

test('AC-005: a records-only answer after the second send-back still moves the origin past the mainline', async () => {
  const f = setupWith({ land: true });
  const brought = { rule: 'record', id: 'C-1', reason: '本流の merge が持ち込んだ error' };
  let checks = 0;
  setRecordsCheckRunner(async () => {
    checks += 1;
    if (checks === 1) return { outcome: 'errors', findings: [FINDING] };
    if (checks === 2) return { outcome: 'errors', findings: [FINDING, brought] };
    return { outcome: 'clean' };
  });
  setAgentRunner({ deliver: async () => {}, startReviewRun: async () => ({ runIds: ['r'] }) });
  try {
    await runReviewLoop();
    writeFileSync(join(f.wt, '_docs', 'q.md'), 'q fixed\n');
    commitInWt(f.wt, 'records');
    git(f.wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'merge', '-q', '--no-edit', 'main');
    const merge = git(f.wt, 'rev-parse', 'HEAD').trim();
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(lastEvent(), 's2_records_instructed');
    // the executor answers the second send-back with records only: nothing outside the records place moves
    writeFileSync(join(f.wt, '_docs', 'q.md'), 'q fixed again\n');
    const head = commitInWt(f.wt, 'records again');
    await appendLifecycle('s2_result', 'IDD-1', { outcome: 'success' });
    await runReviewLoop();
    assert.equal(checks, 3, 'the check ran again for the answer');
    assert.equal(lastEvent(), MERGE_ONLY_SKIP_EVENT, 'the round is skipped for the head');
    const skip = lastOf(MERGE_ONLY_SKIP_EVENT);
    assert.deepEqual([skip.attrs.head, skip.attrs.merge, skip.attrs.reviewed_head], [head, merge, f.head]);
    assert.equal(reviewBaseOf(readLifecycle()), skip.attrs.review_base, 'the origin moved past the mainline');
    assert.equal(reviewLoopState(readLifecycle()).state, 'done', 'S3 may run');
  } finally { setRecordsCheckRunner(null); setAgentRunner(null); }
});

test('a relative program in the check is the trunk\'s; an absolute path or a PATH command stays', () => {
  // the repo's one shell line, as areas.ts hands it
  assert.deepEqual(trunkCommand(['bash', '-c', 'bin/idd intent check'], '/srv/trunk'), ['bash', '-c', "'/srv/trunk/bin/idd' intent check"]);
  assert.deepEqual(trunkCommand(['bash', '-c', '\n  ./bin/idd intent check --json\n'], '/srv/trunk'), ['bash', '-c', "\n  '/srv/trunk/bin/idd' intent check --json\n"]);
  assert.deepEqual(trunkCommand(['bash', '-c', 'bash scripts/check-docs.sh'], '/srv/trunk'), ['bash', '-c', 'bash scripts/check-docs.sh']);
  assert.deepEqual(trunkCommand(['bash', '-c', '/opt/idd/bin/idd intent check'], '/srv/trunk'), ['bash', '-c', '/opt/idd/bin/idd intent check']);
  assert.deepEqual(trunkCommand(['bash', '-c', 'X=a/b bin/idd intent check'], '/srv/trunk'), ['bash', '-c', 'X=a/b bin/idd intent check']);
  assert.deepEqual(trunkCommand(['bash', '-c', "'bin/idd' intent check"], '/srv/trunk'), ['bash', '-c', "'bin/idd' intent check"]);
  // a space in the trunk's path stays one word of the line
  assert.deepEqual(trunkCommand(['bash', '-c', 'bin/idd intent check'], "/srv/my trunk"), ['bash', '-c', "'/srv/my trunk/bin/idd' intent check"]);
  // argv form
  assert.deepEqual(trunkCommand(['bin/idd', 'intent', 'check'], '/srv/trunk'), ['/srv/trunk/bin/idd', 'intent', 'check']);
  assert.deepEqual(trunkCommand(['node', 'x.js'], '/srv/trunk'), ['node', 'x.js']);
  assert.deepEqual(trunkCommand([], '/srv/trunk'), []);
  assert.deepEqual(trunkCommand(['bash', '-c', 'bin/idd intent check'], undefined), ['bash', '-c', 'bin/idd intent check']);
});

test('the records check runs the trunk\'s program with the lane worktree as its cwd', async () => {
  const trunk = tmpDir('idd-records-trunk-');
  mkdirSync(join(trunk, 'bin'));
  // the program tells where it was run and where it lives: the lane's tree is read by the trunk's CLI
  writeFileSync(join(trunk, 'bin', 'check'), '#!/bin/sh\nprintf \'error cwd %s: program=%s\\n\' "$(pwd -P)" "$0"\nexit 1\n');
  chmodSync(join(trunk, 'bin', 'check'), 0o755);
  const f = setupWith({ command: 'bin/check', trunk });
  assert.ok(!existsSync(join(f.wt, 'bin', 'check')), 'the lane worktree holds no program of its own');
  await runReviewLoop();
  assert.equal(lastEvent(), 's2_records_instructed');
  const { xml } = envelopeOf(f.state);
  assert.match(xml, new RegExp(realpathSync(f.wt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(xml, new RegExp(`program=${join(trunk, 'bin', 'check').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { followupTaskId } from '../src/plan/followups.ts';
import { buildSubmitReview } from '../src/plan/ship.ts';

test('the intake ID is read from the title and the body the ledger kept, the first one it names', () => {
  assert.equal(followupTaskId({ title: '[Enhance] x', context: 'IddCore-Enhance-70 の続き' }), 'IddCore-Enhance-70');
  assert.equal(followupTaskId({ title: 'x', context: 'no id here' }), undefined);
});

test('an intake that names a lane-shaped TODO ID resolves the whole ID, not the bare task beside it', () => {
  assert.equal(followupTaskId({ title: 'x', context: 'IddCore-Bug-088-1 の続き' }), 'IddCore-Bug-088-1');
});

test('AC-007 / AC-009 / AC-011: the submit card lists recorded follow-ups, old notes and old failures', () => {
  const e = (event, attrs) => ({ event, idd_id: 'IDD-001', at: '', attrs });
  const review = buildSubmitReview([
    e('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
    // a record in the shape the lane writes now: no task, no files, no commit
    e('s3_followups_written', { entries: [{ severity: 'should', claim: '記録した', path: 'a.ts' }] }),
    // an old record: the task its note went to and the file it committed
    e('s3_followups_written', { entries: [{ severity: 'should', claim: '古い記録', path: 'old.ts', task: 'Demo-Enhance-70' }], files: ['TODO.md'], commit: 'abc' }),
    // an old failure stands until the item is recorded
    e('s3_followups_not_written', { entries: [{ severity: 'nit', claim: '書けなかった', failed: 'lock' }] }),
    // the same failure recorded again does not show twice
    e('s3_followups_not_written', { entries: [{ severity: 'nit', claim: '書けなかった', failed: 'lock' }] }),
  ]);
  assert.deepEqual(review?.followups.map((f) => [f.claim, f.task ?? f.failed]), [
    ['記録した', undefined],
    ['古い記録', 'Demo-Enhance-70'],
    ['書けなかった', 'lock'],
  ]);
});

/** a lane at the submit card; the caller seeds the record it wants */
function shipLane(events) {
  const state = mkdtempSync(join(tmpdir(), 'idd-fu-ship-'));
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  writeFileSync(join(state, 'repos.yaml'), 'repos: {}\n');
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: 'Demo-Enhance-70 の lane', title: '[Enhance] x', area: 'Demo' }) + '\n');
  const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '', attrs });
  const all = [
    ev('s1_go'), ev('s2_start', { started_from_commit: 'x'.repeat(40) }),
    ...events,
    ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'), ev('s3_r2_skipped'), ev('s3_ok'), ev('s4_submit_started'),
  ];
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), all.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

test('AC-011: a follow-up that was not recorded is recorded again on penne\'s word, and the retry is recorded', async () => {
  const state = shipLane([
    { event: 's2_review_started', idd_id: 'IDD-001', at: '', attrs: { kind: 'blind', round: 1, run_ids: ['B'] } },
    { event: 's2_triage_done', idd_id: 'IDD-001', at: '', attrs: { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: 'まれな穴が残る', path: 'a.ts', action: 'followup' }] } },
  ]);
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
  try {
    const { rerecordFollowups } = await import('../src/plan/submit-prep.ts');
    const { readLifecycle } = await import('../src/ledger/read.ts');
    const res = await rerecordFollowups('IDD-001');
    assert.equal(res.ok, true);
    assert.deepEqual(res.files, [], 'nothing is committed for the follow-ups');
    assert.equal(res.commit, '');
    const written = readLifecycle().find((e) => e.event === 's3_followups_written');
    assert.deepEqual(written?.attrs?.entries, [{ severity: 'should', claim: 'まれな穴が残る', path: 'a.ts' }]);
    assert.equal(written?.attrs?.retry, true);
    assert.equal(written?.attrs?.at_by, 'user');
    // a second try has nothing left to record
    const again = await rerecordFollowups('IDD-001');
    assert.equal(again.ok, true);
    assert.equal(again.already, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(state, { recursive: true, force: true });
  }
});

test('a lane still inside the review loop is not recorded on', async () => {
  const state = mkdtempSync(join(tmpdir(), 'idd-fu-early-'));
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
  try {
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
    writeFileSync(join(state, 'repos.yaml'), 'repos: {}\n');
    writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', context: 'Demo-Enhance-70 の lane', title: '[Enhance] x', area: 'Demo' }) + '\n');
    const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '', attrs });
    writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [
      ev('s1_go'), ev('s2_start', { started_from_commit: 'x'.repeat(40) }),
      ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }),
      ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: 'まれな穴が残る', path: 'a.ts', action: 'followup' }] }),
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const { rerecordFollowups } = await import('../src/plan/submit-prep.ts');
    const tooEarly = await rerecordFollowups('IDD-001');
    assert.equal(tooEarly.ok, false);
    assert.match(tooEarly.error, /提出前確認/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(state, { recursive: true, force: true });
  }
});

test('AC-011: a follow-up an earlier pass left unwritten is carried into the next record', async () => {
  const state = shipLane([
    { event: 's2_review_started', idd_id: 'IDD-001', at: '', attrs: { kind: 'blind', round: 1, run_ids: ['B'] } },
    { event: 's2_triage_done', idd_id: 'IDD-001', at: '', attrs: { kind: 'blind', round: 1, accepted: [] } },
    { event: 's3_followups_not_written', idd_id: 'IDD-001', at: '', attrs: { entries: [{ severity: 'should', claim: '前の通しで書けなかった', path: 'b.ts', failed: 'branch busy' }], reason: 'branch busy' } },
  ]);
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
  try {
    const { rerecordFollowups } = await import('../src/plan/submit-prep.ts');
    const { readLifecycle } = await import('../src/ledger/read.ts');
    const res = await rerecordFollowups('IDD-001');
    assert.equal(res.ok, true);
    const written = readLifecycle().filter((e) => e.event === 's3_followups_written').at(-1);
    assert.deepEqual(written.attrs.entries, [{ severity: 'should', claim: '前の通しで書けなかった', path: 'b.ts' }]);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(state, { recursive: true, force: true });
  }
});

test('AC-004: a follow-up the judgement did not decide on is recorded with how it came to be one', async () => {
  const state = shipLane([
    { event: 's2_review_started', idd_id: 'IDD-001', at: '', attrs: { kind: 'blind', round: 1, run_ids: ['B'] } },
    { event: 's2_triage_done', idd_id: 'IDD-001', at: '', attrs: { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: '直さなかった', path: 'a.ts' }] } },
  ]);
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
  try {
    const { rerecordFollowups } = await import('../src/plan/submit-prep.ts');
    const { readLifecycle } = await import('../src/ledger/read.ts');
    const res = await rerecordFollowups('IDD-001');
    assert.equal(res.ok, true);
    const written = readLifecycle().find((e) => e.event === 's3_followups_written');
    assert.deepEqual(written.attrs.entries, [{ severity: 'should', claim: '直さなかった', path: 'a.ts', source: 'unsent' }]);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(state, { recursive: true, force: true });
  }
});

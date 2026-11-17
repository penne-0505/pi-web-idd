import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSubmitPrep } from '../src/plan/submit-prep.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });

/** a converged lane at S3 whose judgement left one should for a follow-up, and whose repo has no TODO */
function setup() {
  const state = mkdtempSync(join(tmpdir(), 'idd-s3-findings-'));
  temps.push(state);
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(join(state, 'repos.yaml'), 'repos: {}\n');
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = mkdtempSync(join(tmpdir(), 'idd-s3-findings-wt-'));
  temps.push(wt);
  execFileSync('git', ['init', '-q', wt]);
  writeFileSync(join(wt, 'a.ts'), 'one\n');
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  const events = [
    ev('s1_go'),
    ev('s2_start', { started_from_commit: head }),
    ev('s2_review_started', { kind: 'blind', round: 1, head }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: [] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'should', claim: '記録と食い違う', path: 'a.ts', action: 'followup', line: 1 }] }),
    ev('s2_result'),
    ev('s2_review_converged'),
    ev('s2_device_skipped'),
    ev('s3_ready'),
  ];
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state };
}

test('AC-006 / AC-012: a lane with no TODO still records its follow-ups on the lane, and the finding still lands', async () => {
  const { state } = setup();
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  setAgentRunner(null);
  const evs = readLifecycle();
  const written = evs.find((e) => e.event === 's3_followups_written');
  assert.ok(written, 'the follow-up is recorded without a TODO to write it into');
  assert.deepEqual(written.attrs.entries, [{ severity: 'should', claim: '記録と食い違う', path: 'a.ts' }]);
  assert.equal(written.attrs.files, undefined, 'nothing is committed');
  assert.ok(!evs.some((e) => e.event === 's3_followups_not_written'), 'nothing can fail for want of a TODO');
  const file = readdirSync(state).find((f) => f.startsWith('work-'));
  assert.ok(file, 'the work column was written');
  const rows = readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const finding = rows.find((r) => r.event === 'finding_placed');
  assert.ok(finding, 'the finding is on record apart from the follow-up record');
  assert.equal(finding.lane, 'IDD-001');
  assert.equal(finding.path, 'a.ts');
  assert.deepEqual(finding.lines, [1, 1]);
  assert.equal(finding.severity, 'should');
});

test('AC-006: a lane whose executor worktree is gone still records its follow-ups', async () => {
  const { state } = setup();
  // the lane's worktree was removed: the follow-up record does not depend on it
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: join(state, 'gone') }) + '\n');
  setAgentRunner({ deliver: async () => {} });
  await runSubmitPrep();
  setAgentRunner(null);
  const evs = readLifecycle();
  const written = evs.find((e) => e.event === 's3_followups_written');
  assert.ok(written, 'the follow-up is recorded without a worktree');
  assert.deepEqual(written.attrs.entries, [{ severity: 'should', claim: '記録と食い違う', path: 'a.ts' }]);
  assert.ok(!evs.some((e) => e.event === 's3_followups_not_written'));
});

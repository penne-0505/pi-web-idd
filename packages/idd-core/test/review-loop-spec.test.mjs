import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReviewLoop } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { DEPTH_TABLE, MAX_SPEC } from '../src/plan/depth.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { tmpDir } from './helpers/tmp.mjs';

// The spec check a depth-bearing round starts beside its blinds, driven through the real loop: its count is the depth
// table's, it runs on every blind round and on the last review, it is handed the plan side and no earlier finding,
// and its report reaches the same judgement the blinds' reports do (C-223-2).

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });
const AREA = 'o/Demo';

function setup({ depth = 'standard' } = {}) {
  const state = tmpDir('idd-spec-run-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), [
    'roles:',
    '  v: { model: x/v, report: review }',
    '  o: { model: x/o, report: review }',
    '  h: { model: x/h, report: review }',
    '  s: { model: x/s, report: review }',
    '  j: { model: x/j, report: triage }',
    '  r: { model: x/r, report: review }',
    'pipeline:',
    '  review_blind: { roles: [v, o], high_risk_extra: [h], high_risk_when: last }',
    '  spec_check: { role: s }',
    '  triage: { role: j }',
    '  device_check: { role: r }',
  ].join('\n') + '\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { [AREA]: { upstream: join(state, 'u'), work: join(state, 'w') } } }));
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = tmpDir('idd-spec-run-wt-');
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

/** a runner that records what each start was asked for, and answers a spec check's run beside the blinds' */
function runner() {
  const calls = [];
  const status = {};
  let n = 0;
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls.push(o);
      n += 1;
      // a round that asks for its spec check gets the run ids of its blinds and then of the check, as the runner answers
      const blinds = o.stage === 'blind' || o.stage === 'final' ? (o.roleCount ?? 1) : 1;
      const ids = Array.from({ length: blinds }, (_, i) => `${o.stage}-${n}-${i}`);
      const labels = ids.map(() => '');
      if (o.spec) for (let i = 0; i < o.spec.count; i += 1) { ids.push(`${o.stage}-${n}-spec${i}`); labels.push('spec'); }
      for (const id of ids) status[id] = { state: 'running' };
      return { runIds: ids, runRoles: ids.map((id) => (id.includes('spec') ? 's' : 'v')), runLabels: labels };
    },
    reviewRunStatus: (id) => status[id],
  });
  const done = (id, extra) => { status[id] = { state: 'done', reportJson: `/${id}.json`, reportMd: `/${id}.md`, ...extra }; };
  return { calls, status, done, last: () => readLifecycle().at(-1).event };
}

test('the depth table starts one spec check at every depth, and the loop counts its copy beside the blinds', () => {
  for (const depth of ['shallow', 'standard', 'deep']) assert.equal(DEPTH_TABLE[depth].spec, 1, depth);
  assert.equal(MAX_SPEC, 1);
});

test('a depth-bearing round starts its spec check with the blinds, handed the plan side and no earlier finding (AC-002, AC-003)', async () => {
  setup({ depth: 'standard' });
  const r = runner();
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_started');
  assert.equal(r.calls.length, 1, 'the blinds and the spec check start in one call');
  const start = r.calls[0];
  assert.equal(start.stage, 'blind');
  assert.equal(start.roleCount, 2);
  assert.equal(start.spec.count, 1);
  // the plan side: the criteria and the decision of a docs lane (the runner opens the ones that exist)
  assert.ok(start.spec.inputs.some((p) => p.endsWith('_docs/qa/Demo/idd-001/qa.md')));
  assert.ok(start.spec.inputs.some((p) => p.endsWith('_docs/intent/Demo/idd-001/decision.md')));
  // and no finding, report or list of an earlier round
  for (const p of start.spec.inputs) assert.ok(!/report|confirm-|prior|triage-history|\.json$/.test(p), p);
  // the round's record names its runs, the spec check's labelled as such
  const started = readLifecycle().find((e) => e.event === 's2_review_started');
  assert.equal(started.attrs.run_ids.length, 3);
  assert.deepEqual(started.attrs.run_labels, ['', '', 'spec']);
});

test('the spec check\'s report reaches the same judgement as the blinds\' reports, without its how, weight, action and frequency (AC-002, AC-004)', async () => {
  const state = setup({ depth: 'standard' });
  const r = runner();
  await runReviewLoop();
  const [blind0, blind1, spec] = readLifecycle().find((e) => e.event === 's2_review_started').attrs.run_ids;
  const specReport = join(state, 'spec-report.json');
  writeFileSync(specReport, JSON.stringify({ findings: [{ severity: 'must', action: 'fix', frequency: '常時', how: 'a.ts を直す', path: 'a.ts', claim: '主な経路の AC を満たさない', evidence: 'e' }] }));
  r.done(blind0, { findings: [] });
  r.done(blind1, { findings: [] });
  r.done(spec, { findings: [], reportJson: specReport });
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_findings');
  const findings = readLifecycle().find((e) => e.event === 's2_review_findings');
  assert.deepEqual(findings.attrs.files, [`/${blind0}.json`, `/${blind1}.json`, specReport]);
  const state2 = reviewLoopState(readLifecycle());
  assert.equal(state2.state, 'start_triage');
  assert.deepEqual(state2.inputs, findings.attrs.files);
  // the judgement starts on all three of them
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_started');
  const triage = r.calls.find((c) => c.stage === 'triage');
  for (const id of [blind0, blind1]) assert.ok(triage.inputs.some((p) => p.includes(id)), id);
  // the spec check's report is read through the judgement's copy: the claim and the evidence stay, the rest is dropped
  const copy = triage.inputs.find((p) => /report-for-judgement/.test(p) && p.startsWith(state));
  assert.ok(copy, 'the spec report is handed as the judgement copy');
  const [finding] = JSON.parse(readFileSync(copy, 'utf8')).findings;
  assert.equal(finding.claim, '主な経路の AC を満たさない');
  assert.equal(finding.evidence, 'e');
  for (const dropped of ['how', 'severity', 'action', 'frequency']) assert.ok(!(dropped in finding), dropped);
});

test('a spec check that failed does not hold back the round, and blinds that all failed are not stood in for by it', async () => {
  setup({ depth: 'standard' });
  const r = runner();
  await runReviewLoop();
  const ids = readLifecycle().find((e) => e.event === 's2_review_started').attrs.run_ids;
  r.status[ids[0]] = { state: 'failed', error: 'b0' };
  r.status[ids[1]] = { state: 'failed', error: 'b1' };
  r.done(ids[2], { findings: [] });
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_escalated', 'a spec report alone is not a reviewed round');
});

test('a lane with no declared depth starts no spec check: its stage count is not changed by the new slot', async () => {
  setup({ depth: null });
  const r = runner();
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_started');
  assert.equal(r.calls[0].spec, undefined);
});

test('the last review of a depth-bearing lane starts its spec check beside the senior role (AC-002)', async () => {
  setup({ depth: 'standard' });
  const r = runner();
  await runReviewLoop();
  const ids = readLifecycle().find((e) => e.event === 's2_review_started').attrs.run_ids;
  for (const id of ids) r.done(id, { findings: [] });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(r.last(), 's2_triage_started');
  // the judgement accepts nothing, and the last review follows
  const triageId = Object.keys(r.status).find((id) => id.startsWith('triage-'));
  r.done(triageId, { decisions: [] });
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(r.last(), 's2_review_started');
  const finalStart = r.calls.filter((c) => c.stage === 'final');
  assert.equal(finalStart.length, 1);
  assert.equal(finalStart[0].onlyHighRisk, true);
  assert.equal(finalStart[0].spec.count, 1);
  const rec = readLifecycle().filter((e) => e.event === 's2_review_started').at(-1);
  assert.equal(rec.attrs.kind, 'final');
  assert.equal(rec.attrs.run_labels.at(-1), 'spec');
});

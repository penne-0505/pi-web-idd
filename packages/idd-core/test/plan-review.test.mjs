import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { deriveStage, planReviewMustUnconfirmed, planReviewPhase } from '../src/ledger/derive.ts';
import { planReviewEnvelope, runPlanReview } from '../src/plan/plan-review.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { applyDecision } from '../src/ledger/write.ts';
// the runtime's own fold, not a stand-in: the one the UI's runner hands the engine
import { mergePlanReviewFindings } from '../../idd-lane/src/plan-review.ts';
import { normText } from '../src/plan/harness-norms.ts';
import { tmpDir } from './helpers/tmp.mjs';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });

test('the GO card waits for the plan review, and for the planner when must / should went back to it', () => {
  const ready = [ev('lane_open'), ev('s1_ready')];
  assert.deepEqual([deriveStage(ready).group, deriveStage(ready).blockedBy], ['prep', 'plan 査読待ち']);
  const running = [...ready, ev('s1_plan_review_started', { run_id: 'L1' })];
  assert.equal(planReviewPhase(running).phase, 'running');
  assert.equal(deriveStage(running).blockedBy, 'plan 査読中');
  const found = [...running, ev('s1_plan_review_done', { must: 1, should: 0, nit: 2 })];
  assert.equal(planReviewPhase(found).phase, 'revising');
  assert.equal(deriveStage(found).group, 'prep');
  const reReady = [...found, ev('s1_ready')];
  assert.equal(planReviewPhase(reReady).phase, 'waiting', 'the planner\'s fix is reviewed before the GO card opens');
  assert.equal(deriveStage(reReady).decision, undefined);
  assert.equal(deriveStage(reReady).blockedBy, 'plan 査読待ち');
  const clean = [...running, ev('s1_plan_review_done', { must: 0, should: 0, nit: 3 })];
  assert.equal(deriveStage(clean).decision, 'go');
  const failed = [...running, ev('s1_plan_review_done', { failed: true, error: 'x' })];
  assert.equal(deriveStage(failed).decision, 'go');
  const skipped = [...ready, ev('s1_plan_review_skipped', { reason: 'r' })];
  assert.equal(deriveStage(skipped).decision, 'go');
  assert.equal(deriveStage([...reReady, ev('s1_go')]).group, 'impl');
});

function setupState(rolesYaml) {
  const state = tmpDir('idd-planrev-');
  process.env.IDD_STATE_DIR = state;
  const roles = join(state, 'roles.yaml');
  writeFileSync(roles, rolesYaml);
  process.env.IDD_ROLES_FILE = roles;
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('lane_open'), ev('s1_ready')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', planner_session_id: 'S1', worktree_path: '/wt/IDD-001' }) + '\n');
  return state;
}

test('runs the review once, records the counts, and sends must / should back to the planner', async () => {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr, concurrency: 1 }\n');
  const calls = [];
  let status = { state: 'running' };
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async (opts) => { calls.push(opts); return { runs: [{ runId: 'L1', role: 'pr', model: 'x/y' }] }; },
    planReviewStatus: () => status,
  });
  const first = await runPlanReview();
  assert.deepEqual(first.started, ['IDD-001']);
  assert.equal(calls[0].worktree, '/wt/IDD-001');
  assert.ok(calls[0].inputs.some((p) => p.endsWith('/decision.md')));
  // the planner took its identifiers from the harness's lane numbering and left the source TODO's fields alone, so the review is told both points
  assert.deepEqual(calls[0].norms, [normText('lane-ids'), normText('todo-source')]);
  assert.deepEqual((await runPlanReview()).finished, []);
  assert.equal(calls.length, 1);
  status = { state: 'done', reportMd: '/r.md', findings: [
    { severity: 'must', path: 'lib/a.dart', claim: '購読の deps が取り残される', evidence: 'l.12' },
    { severity: 'nit', path: '', claim: '言い回し', evidence: '' },
  ] };
  assert.deepEqual((await runPlanReview()).finished, ['IDD-001']);
  const started = readLifecycle().find((e) => e.event === 's1_plan_review_started');
  assert.deepEqual(started.attrs.run_ids, ['L1']);
  assert.deepEqual(started.attrs.runs, [{ run_id: 'L1', role: 'pr', model: 'x/y' }]);
  const done = readLifecycle().filter((e) => e.event === 's1_plan_review_done').pop();
  assert.equal(done.attrs.must, 1);
  assert.equal(done.attrs.nit, 1);
  assert.equal(done.attrs.sent_back, true);
  assert.equal(done.attrs.findings[0].source, 'pr');
  const outbox = readFileSync(join(state, 'outbox.jsonl'), 'utf8');
  assert.match(outbox, /plan_review_findings/);
  const xml = readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');
  assert.match(xml, /購読の deps が取り残される/);
  assert.doesNotMatch(xml, /言い回し/);
  setAgentRunner(null);
});

test('the review waits while the planner is still writing in its worktree after its ready, and starts once it is quiet', async () => {
  setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr, concurrency: 1 }\n');
  const calls = [];
  let busy = true;
  const asked = [];
  setAgentRunner({
    deliver: async () => {},
    cwdBusy: (cwd) => { asked.push(cwd); return busy; },
    startPlanReview: async (opts) => { calls.push(opts); return { runs: [{ runId: 'L1', role: 'pr', model: 'x/y' }] }; },
  });
  const held = await runPlanReview();
  assert.deepEqual(held.started, [], 'no review starts while the planner writes');
  assert.equal(calls.length, 0);
  assert.deepEqual(asked, ['/wt/IDD-001'], "the planner's worktree is the one asked about");
  assert.equal(readLifecycle().some((e) => e.event === 's1_plan_review_started'), false, 'the wait writes nothing');
  busy = false;
  assert.deepEqual((await runPlanReview()).started, ['IDD-001']);
  assert.equal(calls.length, 1);
  // once running, the review's own runs in the same worktree do not hold it
  busy = true;
  await runPlanReview();
  assert.equal(calls.length, 1, 'the running review is not started again');
  setAgentRunner(null);
});

test("a v2 lane's plan review is handed the lane's record shape and reads the plan report's drafts, not decision.md", async () => {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr, concurrency: 1 }\n');
  // the lane was planned after the switch-over: its ready carries the v2 mark, so its review must not read decision.md
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('lane_open'), ev('s1_ready', { records_shape: 'state' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const calls = [];
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async (opts) => { calls.push(opts); return { runs: [{ runId: 'L1', role: 'pr', model: 'x/y' }] }; },
  });
  assert.deepEqual((await runPlanReview()).started, ['IDD-001']);
  assert.equal(calls[0].recordsShape, 'state');
  // the v2 wording of the harness norm, and the report's drafts as the input instead of decision.md
  assert.deepEqual(calls[0].norms, [normText('todo-source', 'state')]);
  assert.equal(calls[0].inputs.some((p) => p.endsWith('/decision.md')), false, 'a v2 lane has no decision.md to review');
  assert.equal(calls[0].inputs.some((p) => p.endsWith('/qa.md')), true);
  setAgentRunner(null);
});

test('without a plan_review slot the review is skipped and the GO card opens', async () => {
  setupState('models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y }\npipeline:\n  planner: { role: p }\n');
  setAgentRunner({ deliver: async () => {}, startPlanReview: async () => { throw new Error('must not run'); } });
  assert.deepEqual((await runPlanReview()).skipped, ['IDD-001']);
  assert.equal(deriveStage(readLifecycle()).decision, 'go');
  setAgentRunner(null);
});

test("penne's send-back at the GO card goes to the planner, and the re-readied plan is reviewed again", () => {
  const reviewed = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_started', { run_id: 'L1' }), ev('s1_plan_review_done', { must: 0, should: 0, nit: 1 })];
  assert.equal(deriveStage(reviewed).decision, 'go');
  const sentBack = [...reviewed, ev('s1_revise_requested', { instruction: 'split the DEC' })];
  assert.equal(planReviewPhase(sentBack).phase, 'sent_back');
  assert.deepEqual([deriveStage(sentBack).group, deriveStage(sentBack).blockedBy], ['prep', 'penne の指示を反映中']);
  const reReady = [...sentBack, ev('s1_ready')];
  assert.equal(planReviewPhase(reReady).phase, 'waiting', 'the review before the send-back does not count');
  const running = [...reReady, ev('s1_plan_review_started', { run_id: 'L2' })];
  assert.equal(planReviewPhase(running).phase, 'running');
  const done = [...running, ev('s1_plan_review_done', { must: 0, should: 0, nit: 0 })];
  assert.equal(deriveStage(done).decision, 'go');
});

const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-001');
const doneOf = () => lane().filter((e) => e.event === 's1_plan_review_done').pop();
const outboxXml = (state) => readdirSync(join(state, 'outbox')).map((f) => readFileSync(join(state, 'outbox', f), 'utf8')).join('');

test('a slot with two roles starts one run per role and folds both reviews into one send-back and one GO card entry', async () => {
  const state = setupState('models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb], concurrency: 1 }\n');
  const status = { A: { state: 'running' }, B: { state: 'running' } };
  const merged = [];
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa', model: 'x/a' }, { runId: 'B', role: 'pb', model: 'x/b' }] }),
    planReviewStatus: (id) => status[id],
    mergeFindings: (lists) => { merged.push(lists); return mergePlanReviewFindings(lists); },
  });
  assert.deepEqual((await runPlanReview()).started, ['IDD-001']);
  const started = lane().find((e) => e.event === 's1_plan_review_started');
  assert.deepEqual(started.attrs.run_ids, ['A', 'B']);
  assert.deepEqual(started.attrs.runs.map((r) => [r.run_id, r.role, r.model]), [['A', 'pa', 'x/a'], ['B', 'pb', 'x/b']]);
  assert.deepEqual(planReviewPhase(lane()), { phase: 'running', runIds: ['A', 'B'] });

  status.A = { state: 'done', reportMd: '/a.md', findings: [
    { severity: 'must', path: 'lib/a.ts', claim: '購読が取り残される', evidence: 'l.3' },
    { severity: 'should', path: 'lib/b.ts', claim: '順序が逆になる', evidence: '' },
  ] };
  assert.deepEqual((await runPlanReview()).finished, [], 'waits for every run');
  status.B = { state: 'done', reportMd: '/b.md', findings: [
    { severity: 'should', path: 'lib/b.ts', claim: '順序が逆になる', evidence: '' },
    { severity: 'should', path: 'lib/c.ts', claim: 'index の前提が崩れる', evidence: '' },
  ] };
  assert.deepEqual((await runPlanReview()).finished, ['IDD-001']);
  assert.deepEqual(merged[0].map((l) => l.map((f) => f.source)), [['pa', 'pa'], ['pb', 'pb']]);
  const done = doneOf();
  assert.equal(done.attrs.failed, undefined);
  assert.deepEqual([done.attrs.must, done.attrs.should, done.attrs.nit], [1, 2, 0]);
  assert.deepEqual(done.attrs.findings.map((f) => [f.claim, f.source]), [['購読が取り残される', 'pa'], ['順序が逆になる', 'pa,pb'], ['index の前提が崩れる', 'pb']]);
  assert.deepEqual(done.attrs.runs.map((r) => [r.run_id, r.role, r.model, r.failed ?? false, r.must, r.should]), [['A', 'pa', 'x/a', false, 1, 1], ['B', 'pb', 'x/b', false, 0, 2]]);
  assert.deepEqual(done.attrs.reports.map((r) => [r.role, r.report_md]), [['pa', '/a.md'], ['pb', '/b.md']]);
  assert.equal(planReviewPhase(lane()).phase, 'revising');
  const xml = outboxXml(state);
  assert.match(xml, /購読が取り残される/);
  assert.doesNotMatch(xml, /index の前提が崩れる/, 'should does not go back to the planner');
  assert.doesNotMatch(xml, /順序が逆になる/, 'should does not go back to the planner');
  assert.match(xml, /\/a\.md/);
  assert.match(xml, /\/b\.md/);
  assert.equal((await runPlanReview()).started.length, 0, 'reviewed once: no second review');
  setAgentRunner(null);
});

test('one run that fails does not stop the review: the other run decides, and the failure is on record per run', async () => {
  setupState('models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb] }\n');
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa', model: 'x/a' }, { runId: 'B', role: 'pb', model: 'x/b' }] }),
    planReviewStatus: (id) => (id === 'A' ? { state: 'failed', error: 'provider 400' } : { state: 'done', reportMd: '/b.md', findings: [{ severity: 'nit', path: '', claim: '言い回し', evidence: '' }] }),
  });
  await runPlanReview();
  await runPlanReview();
  const done = doneOf();
  assert.equal(done.attrs.failed, undefined);
  assert.equal(done.attrs.nit, 1);
  assert.deepEqual(done.attrs.runs.map((r) => [r.role, r.failed ?? false, r.error ?? '']), [['pa', true, 'provider 400'], ['pb', false, '']]);
  assert.equal(deriveStage(lane()).decision, 'go');
  setAgentRunner(null);
});

test('a run that could not start is kept with the ones that did, and counts as failed', async () => {
  setupState('models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb] }\n');
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'B', role: 'pb', model: 'x/b' }], failed: [{ role: 'pa', model: 'x/a', error: 'spawn failed' }] }),
    planReviewStatus: () => ({ state: 'done', reportMd: '/b.md', findings: [] }),
  });
  await runPlanReview();
  const startedAttrs = lane().find((e) => e.event === 's1_plan_review_started').attrs;
  assert.deepEqual(startedAttrs.start_failed, [{ role: 'pa', model: 'x/a', error: 'spawn failed' }]);
  assert.equal(startedAttrs.failed_runs, undefined, 'failed_runs is the count on the done record only');
  await runPlanReview();
  const done = doneOf();
  assert.equal(done.attrs.failed, undefined);
  assert.equal(done.attrs.failed_runs, 1);
  assert.deepEqual(done.attrs.runs.map((r) => [r.role, r.failed ?? false]), [['pb', false], ['pa', true]]);
  setAgentRunner(null);
});

test('when every run fails the review is a failure, and the GO card still opens', async () => {
  setupState('models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb] }\n');
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa', model: 'x/a' }, { runId: 'B', role: 'pb', model: 'x/b' }] }),
    planReviewStatus: (id) => { if (id === 'A') return { state: 'failed', error: 'e-a' }; throw new Error('bad json'); },
  });
  await runPlanReview();
  await runPlanReview();
  const done = doneOf();
  assert.equal(done.attrs.failed, true);
  assert.match(done.attrs.error, /pa: e-a/);
  assert.match(done.attrs.error, /pb: .*bad json/);
  assert.equal(deriveStage(lane()).decision, 'go');
  setAgentRunner(null);
});

test('without a runtime fold the findings are listed as they came, must first', async () => {
  setupState('models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb] }\n');
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa' }, { runId: 'B', role: 'pb' }] }),
    planReviewStatus: (id) => ({ state: 'done', reportMd: `/${id}.md`, findings: [{ severity: id === 'A' ? 'nit' : 'must', path: '', claim: id, evidence: '' }] }),
  });
  await runPlanReview();
  await runPlanReview();
  assert.deepEqual(doneOf().attrs.findings.map((f) => [f.claim, f.source]), [['B', 'pb'], ['A', 'pa']]);
  setAgentRunner(null);
});

test('a review started before the runs were listed (one run_id) is still read and finished', async () => {
  setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr }\n');
  const { appendLifecycle } = await import('../src/ledger/write.ts');
  await appendLifecycle('s1_plan_review_started', 'IDD-001', { run_id: 'OLD', attempt: 1, model: 'x/y' });
  assert.deepEqual(planReviewPhase(lane()), { phase: 'running', runIds: ['OLD'] });
  setAgentRunner({ deliver: async () => {}, planReviewStatus: (id) => (id === 'OLD' ? { state: 'done', reportMd: '/old.md', findings: [] } : { state: 'failed', error: 'unknown' }) });
  assert.deepEqual((await runPlanReview()).finished, ['IDD-001']);
  const done = doneOf();
  assert.equal(done.attrs.failed, undefined);
  assert.deepEqual(done.attrs.runs.map((r) => [r.run_id, r.model]), [['OLD', 'x/y']]);
  setAgentRunner(null);
});

const P = '_docs/intent/Demo/t/decision.md';
const distinct = [
  { severity: 'must', path: P, claim: 'DEC-001 の Anchors に lib/a.ts の購読解除が無い', evidence: '' },
  { severity: 'should', path: P, claim: 'DEC-002 の Anchors に lib/b.ts の購読解除が無い', evidence: '' },
  { severity: 'should', path: P, claim: 'qa.md の AC-2 に失敗時の受け入れ条件が無い', evidence: '' },
  { severity: 'should', path: P, claim: 'qa.md の AC-3 に空のときの受け入れ条件が無い', evidence: '' },
];

test('one role: only its must goes back to the planner, and the should stays on the GO card', async () => {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr }\n');
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'L1', role: 'pr', model: 'x/y' }] }),
    planReviewStatus: () => ({ state: 'done', reportMd: '/r.md', findings: distinct }),
    mergeFindings: mergePlanReviewFindings,
  });
  await runPlanReview();
  await runPlanReview();
  const done = doneOf();
  assert.deepEqual([done.attrs.must, done.attrs.should], [1, 3]);
  assert.equal(done.attrs.sent_back, true);
  assert.equal(done.attrs.findings.length, 4);
  const xml = outboxXml(state);
  assert.ok(xml.includes(distinct[0].claim), 'the must goes back');
  for (const f of distinct.slice(1)) assert.ok(!xml.includes(f.claim), `should stays: ${f.claim}`);
  setAgentRunner(null);
});

test('a should-only review sends nothing back and opens the GO card', async () => {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr }\n');
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'L1', role: 'pr', model: 'x/y' }] }),
    planReviewStatus: () => ({ state: 'done', reportMd: '/r.md', findings: [
      { severity: 'should', path: '', claim: '順序が逆になる', evidence: '' },
      { severity: 'should', path: '', claim: 'index の前提が崩れる', evidence: '' },
    ] }),
  });
  await runPlanReview();
  await runPlanReview();
  const done = doneOf();
  assert.deepEqual([done.attrs.must, done.attrs.should], [0, 2]);
  assert.equal(done.attrs.sent_back, false);
  assert.equal(planReviewPhase(lane()).phase, 'reviewed');
  assert.equal(deriveStage(lane()).decision, 'go', 'the planner is not kept waiting');
  assert.ok(!existsSync(join(state, 'outbox.jsonl')), 'nothing goes back');
  setAgentRunner(null);
});

test('a record from before the sent_back field keeps must + should waiting for the planner', () => {
  const old = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 0, should: 1, nit: 0 })];
  assert.equal(planReviewPhase(old).phase, 'revising');
  const oldMust = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_done', { must: 1, should: 0, nit: 0 })];
  assert.equal(planReviewPhase(oldMust).phase, 'revising');
});

test('two roles: only what both runs raised is folded; one run keeps its own alike findings apart', async () => {
  const state = setupState('models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb] }\n');
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa' }, { runId: 'B', role: 'pb' }] }),
    planReviewStatus: (id) => ({ state: 'done', reportMd: `/${id}.md`, findings: id === 'A' ? distinct.slice(0, 2) : [distinct[0], distinct[3]] }),
    mergeFindings: mergePlanReviewFindings,
  });
  await runPlanReview();
  await runPlanReview();
  const done = doneOf();
  assert.deepEqual(done.attrs.findings.map((f) => [f.claim.slice(0, 7), f.source]).sort(), [['DEC-001', 'pa,pb'], ['DEC-002', 'pa'], ['qa.md の', 'pb']]);
  assert.deepEqual([done.attrs.must, done.attrs.should], [1, 2]);
  const xml = outboxXml(state);
  assert.equal(xml.split(distinct[0].claim).length - 1, 1);
  setAgentRunner(null);
});

const quotaReason = 'Claude の枠が止める閾値に達しているので lane を起動しません: 5 時間の枠 95%';

test('a role that ran on its fallback: the start keeps the run that ran and the fallback, and the two runs still fold', async () => {
  const state = setupState('models:\n  x-a:\n    model: x/a\n  x-d:\n    model: x/d\n  x-f:\n    model: x/f\nroles:\n  pa: { model: x-a }\n  deep: { model: x-d }\n  fb: { model: x-f }\npipeline:\n  plan_review: { roles: [pa, deep] }\n');
  const fallbacks = [{ role: 'deep', fallback: 'fb', reason: quotaReason }];
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa', model: 'x/a' }, { runId: 'F', role: 'fb', model: 'x/f' }], failed: [], fallbacks }),
    planReviewStatus: (id) => ({ state: 'done', reportMd: `/${id}.md`, findings: id === 'A' ? distinct.slice(0, 2) : [distinct[0]] }),
    mergeFindings: mergePlanReviewFindings,
  });
  await runPlanReview();
  const started = lane().find((e) => e.event === 's1_plan_review_started').attrs;
  assert.deepEqual(started.runs.map((r) => r.role), ['pa', 'fb']);
  assert.deepEqual(started.fallbacks, fallbacks);
  assert.equal(started.start_failed, undefined, 'a role on its fallback started: it is not a failure');
  await runPlanReview();
  const done = doneOf();
  assert.equal(done.attrs.failed_runs, undefined);
  assert.deepEqual(done.attrs.findings.map((f) => [f.claim.slice(0, 7), f.source]).sort(), [['DEC-001', 'pa,fb'], ['DEC-002', 'pa']]);
  assert.ok(outboxXml(state).includes('summary'), 'the send-back still asks for the three lines');
  setAgentRunner(null);
});

test('a fallback folded into a run already in the review leaves one run: nothing is folded, and nothing counts as failed', async () => {
  setupState('models:\n  x-a:\n    model: x/a\n  x-d:\n    model: x/d\nroles:\n  pa: { model: x-a }\n  deep: { model: x-d }\npipeline:\n  plan_review: { roles: [pa, deep] }\n');
  const fallbacks = [{ role: 'deep', fallback: 'pa', reason: quotaReason, folded: true }];
  let merged = 0;
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa', model: 'x/a' }], failed: [], fallbacks }),
    planReviewStatus: () => ({ state: 'done', reportMd: '/a.md', findings: [distinct[0], { ...distinct[0], claim: `${distinct[0].claim}。` }] }),
    mergeFindings: (lists) => { merged += 1; return mergePlanReviewFindings(lists); },
  });
  await runPlanReview();
  assert.deepEqual(lane().find((e) => e.event === 's1_plan_review_started').attrs.fallbacks, fallbacks);
  await runPlanReview();
  const done = doneOf();
  assert.equal(merged, 0);
  assert.equal(done.attrs.must, 2);
  assert.equal(done.attrs.failed_runs, undefined);
  assert.deepEqual(done.attrs.runs.map((r) => r.role), ['pa']);
  setAgentRunner(null);
});

test('a run that switched role while it ran leaves the switch on the record that closes the plan review', async () => {
  setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr }\n');
  const midRun = [
    { role: 'pr', fallback: 'api', kind: 'timeout', reason: '時間切れ' },
    { role: 'api', fallback: 'api-2', kind: 'provider', reason: 'provider 400' },
  ];
  let status = { state: 'running' };
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'L1', role: 'pr', model: 'x/y' }] }),
    planReviewStatus: () => status,
  });
  await runPlanReview();
  status = { state: 'done', reportMd: '/r.md', findings: [{ severity: 'nit', path: '', claim: '言い回し', evidence: '' }], fallbacks: midRun };
  await runPlanReview();
  // the closing record carries the switches, so the timeline and the decider see them as the S2 round's do
  assert.deepEqual(doneOf().attrs.fallbacks, midRun);
  setAgentRunner(null);
});

test('AC-004: the plan review is handed the context document next to the records, and the qa keeps its place', async () => {
  setupState('roles:\n  pr: { model: x/y }\npipeline:\n  plan_review: { role: pr }\n');
  const calls = [];
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async (opts) => { calls.push(opts); return { runs: [{ runId: 'L1', role: 'pr' }] }; },
  });
  await runPlanReview();
  assert.deepEqual(calls[0].inputs.slice(0, 3), [
    '_docs/intent/Demo/idd-001/decision.md',
    '_docs/qa/Demo/idd-001/qa.md',
    '_docs/reference/Demo/idd-001/reference.md',
  ], 'the intent and the qa stay where the other stages read them');
  assert.ok(calls[0].inputs.includes('_docs/context/Demo/idd-001/context.md'), calls[0].inputs.join(', '));
  setAgentRunner(null);
});

test('AC-008: a plan among the reviewer documents is handed as an input, and the send-back fixes the plan, not the records', async () => {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr }\n');
  const wt = tmpDir('idd-planrev-wt-');
  mkdirSync(join(wt, '_docs/plan/Demo/idd-001'), { recursive: true });
  writeFileSync(join(wt, '_docs/plan/Demo/idd-001/plan.md'), '---\ntitle: t\n---\n\n## Tasks\n- `src/a.ts` — 直す\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', planner_session_id: 'S1', worktree_path: wt }) + '\n');
  const calls = [];
  let status = { state: 'running' };
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async (opts) => { calls.push(opts); return { runs: [{ runId: 'L1', role: 'pr' }] }; },
    planReviewStatus: () => status,
  });
  await runPlanReview();
  assert.ok(calls[0].inputs.some((p) => p.endsWith('_docs/plan/Demo/idd-001/plan.md')), calls[0].inputs.join(', '));
  status = { state: 'done', reportMd: '/r.md', findings: [{ severity: 'must', path: '_docs/plan/Demo/idd-001/plan.md', claim: '順序が抜けている', evidence: '' }] };
  await runPlanReview();
  const xml = outboxXml(state);
  assert.match(xml, /作業の不足は plan.md/);
  assert.match(xml, /理由を plan.md に 1 文で残す。DEC は増やさない。/);
  setAgentRunner(null);
});

test('AC-010: without a plan the reviewer task is the old one and the send-back still asks for the records', async () => {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr }\n');
  let status = { state: 'running' };
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'L1', role: 'pr' }] }),
    planReviewStatus: () => status,
  });
  await runPlanReview();
  status = { state: 'done', reportMd: '/r.md', findings: [{ severity: 'must', path: '_docs/intent/Demo/idd-001/decision.md', claim: 'Why が無い', evidence: '' }] };
  await runPlanReview();
  const xml = outboxXml(state);
  assert.match(xml, /decision\.md \/ qa\.md を直す/);
  assert.doesNotMatch(xml, /作業の不足は plan\.md/);
  setAgentRunner(null);
});

// The plan review's role count follows the lane's depth (DEC-113-2): a shallow lane runs the slot's first role,
// standard and deep run as many as the table names. The lane's qa reads Low here, so the depth is the declared one.
test('AC-006: the plan review runs the depth table\'s roles, counted from the top', async () => {
  const savedRepos = process.env.IDD_REPOS_FILE;
  try {
    for (const [depth, expected] of [['shallow', 1], ['standard', 2], ['deep', 2]]) {
      const state = tmpDir('idd-planrev-depth-');
      process.env.IDD_STATE_DIR = state;
      const roles = join(state, 'roles.yaml');
      writeFileSync(roles, 'models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb], concurrency: 1 }\n');
      process.env.IDD_ROLES_FILE = roles;
      const wt = join(state, 'wt');
      mkdirSync(join(wt, '_docs/qa/Demo/idd-001'), { recursive: true });
      writeFileSync(join(wt, '_docs/qa/Demo/idd-001/qa.md'), '---\nrisk: Low\n---\n\nbody\n');
      writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
      writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('lane_open'), ev('s1_ready', { depth })].map((e) => JSON.stringify(e)).join('\n') + '\n');
      writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', planner_session_id: 'S1', worktree_path: wt }) + '\n');
      const calls = [];
      setAgentRunner({
        deliver: async () => {},
        startPlanReview: async (opts) => { calls.push(opts); return { runs: [{ runId: 'L1', role: 'pa', model: 'x/a' }] }; },
        planReviewStatus: () => ({ state: 'running' }),
      });
      await runPlanReview();
      assert.equal(calls.length, 1, depth);
      assert.equal(calls[0].roles, expected, depth);
    }
  } finally {
    if (savedRepos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = savedRepos;
    setAgentRunner(null);
  }
});

test('AC-028: a v2 lane\'s plan-review send-back points at the report\'s drafts, not decision.md', () => {
  const findings = [{ severity: 'must', path: 'src/a.ts', claim: 'why が因果ではない' }];
  const v2 = planReviewEnvelope('IDD-1', findings, [], { hasPlan: true, shape: 'state' });
  assert.match(v2, /計画の報告の草案/);
  assert.match(v2, /送り直す/);
  assert.doesNotMatch(v2, /decision\.md を直す/);
  const v1 = planReviewEnvelope('IDD-1', findings, [], { hasPlan: true });
  assert.match(v1, /意図の誤りや不足は decision\.md/);
  // AC-005: the fix goes by what the finding is about, with a plan or without; no path asks for a longer AC
  const noPlan = planReviewEnvelope('IDD-1', findings, [], { hasPlan: false, shape: 'state' });
  for (const text of [v2, noPlan]) assert.match(text, /AC の状態の不足は qa\.md、守る形は Choice の anchored か free.*AC に how を足さない/);
  assert.match(v2, /作業の不足は plan\.md/);
  assert.doesNotMatch(noPlan, /作業の不足は plan\.md/);
});

// F-198-10 / F-198-21: one role run by two models must stay apart on the record. A finding whose source is only
// the role cannot be traced back to the run that raised it, and the person weighing it reads the wrong reviewer.
test('a role run by two models names each finding by the role and the model', async () => {
  setupState('models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa:\n    - { model: x-a }\n    - { model: x-b }\npipeline:\n  plan_review: { role: pa, concurrency: 1 }\n');
  const status = { A: { state: 'running' }, B: { state: 'running' } };
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async () => ({ runs: [{ runId: 'A', role: 'pa', model: 'x/a' }, { runId: 'B', role: 'pa', model: 'x/b' }] }),
    planReviewStatus: (id) => status[id],
  });
  assert.deepEqual((await runPlanReview()).started, ['IDD-001']);
  status.A = { state: 'done', reportMd: '/a.md', findings: [{ severity: 'nit', path: 'lib/a.ts', claim: 'A の指摘', evidence: '' }] };
  status.B = { state: 'done', reportMd: '/b.md', findings: [{ severity: 'nit', path: 'lib/b.ts', claim: 'B の指摘', evidence: '' }] };
  assert.deepEqual((await runPlanReview()).finished, ['IDD-001']);
  const done = doneOf();
  assert.deepEqual(done.attrs.findings.map((f) => [f.claim, f.source]), [['A の指摘', 'pa/x/a'], ['B の指摘', 'pa/x/b']]);
  setAgentRunner(null);
});

// F-160-4: the Purposes a v2 lane's draft Choices join are written out and handed to the review's inputs. The
// wiring had no test: a change could drop the file and the review would decide without the lane's Purposes.
test('a v2 lane with a Purpose hands the purpose file to the review inputs', async () => {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr, concurrency: 1 }\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [
    ev('lane_open'),
    ev('s1_ready', { records_shape: 'state', plan_records: { choices: [{ purpose: 'P-1', forms: { chosen: '形' }, place: [{ path: 'src/a.ts', kind: 'file' }], why: 'w', anchored: 'a' }], existing: [] } }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(state, 'intent-Demo.jsonl'), JSON.stringify({ event: 'purpose_raised', at: '2026-10-01T00:00:00Z', repo: 'Demo', by: { lane: 'IDD-001' }, id: 'P-1', statement: 'S', origin: 'O', status: 'active' }) + '\n');
  const calls = [];
  setAgentRunner({
    deliver: async () => {},
    startPlanReview: async (opts) => { calls.push(opts); return { runs: [{ runId: 'L1', role: 'pr', model: 'x/y' }] }; },
  });
  assert.deepEqual((await runPlanReview()).started, ['IDD-001']);
  const purposes = calls[0].inputs.filter((p) => p.includes('lane-purposes'));
  assert.equal(purposes.length, 1, calls[0].inputs.join(', '));
  assert.equal(calls[0].inputs.some((p) => p.endsWith('/decision.md')), false, 'a v2 lane has no decision.md to review');
  assert.equal(calls[0].inputs.some((p) => p.endsWith('/qa.md')), true, 'the qa stays where the other stages read it');
  setAgentRunner(null);
});

const found = (must = 1) => ev('s1_plan_review_done', { must, should: 0, nit: 0, sent_back: must > 0 });
const round1 = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_started', { run_id: 'L1' }), found()];

test('after a must the planner re-readies, a second review runs, and the GO card waits for its result', () => {
  const reReady = [...round1, ev('s1_ready')];
  assert.equal(planReviewPhase(reReady).phase, 'waiting');
  const second = [...reReady, ev('s1_plan_review_started', { run_id: 'L2' })];
  // the last done is still the first review's: the second one running must not read as reviewed
  assert.equal(planReviewPhase(second).phase, 'running');
  assert.equal(deriveStage(second).decision, undefined);
  assert.equal(deriveStage(second).blockedBy, 'plan 査読中');
  const clean = [...second, ev('s1_plan_review_done', { must: 0, should: 0, nit: 0, sent_back: false })];
  assert.equal(planReviewPhase(clean).phase, 'reviewed');
  assert.equal(deriveStage(clean).decision, 'go');
});

test('a must left by the second review is revised once more, then the GO card opens and no third review runs', () => {
  const second = [...round1, ev('s1_ready'), ev('s1_plan_review_started', { run_id: 'L2' }), found()];
  assert.equal(planReviewPhase(second).phase, 'revising');
  const spent = [...second, ev('s1_ready')];
  assert.deepEqual(planReviewPhase(spent), { phase: 'reviewed', failed: false, actionable: 1 });
  assert.equal(deriveStage(spent).decision, 'go');
});

test("penne's send-back starts the count again, so the next ready runs the review once more", () => {
  const spent = [...round1, ev('s1_ready'), ev('s1_plan_review_started', { run_id: 'L2' }), found(), ev('s1_ready')];
  assert.equal(planReviewPhase(spent).phase, 'reviewed');
  const sentBack = [...spent, ev('s1_revise_requested', { instruction: 'x' }), ev('s1_ready')];
  assert.equal(planReviewPhase(sentBack).phase, 'waiting');
  const again = [...sentBack, ev('s1_plan_review_started', { run_id: 'L3' }), found(), ev('s1_ready')];
  assert.equal(planReviewPhase(again).phase, 'waiting', 'the first review since the send-back leaves room for a second');
});

test('a review that failed, or found only should, does not hold the GO card for another review', () => {
  const failed = [...round1.slice(0, 3), ev('s1_plan_review_done', { failed: true, error: 'x' }), ev('s1_ready')];
  assert.equal(deriveStage(failed).decision, 'go');
  const fine = [...round1.slice(0, 3), ev('s1_plan_review_done', { must: 0, should: 2, nit: 0, sent_back: false }), ev('s1_ready')];
  assert.equal(deriveStage(fine).decision, 'go');
});

function laneState(events) {
  const state = setupState('models:\n  x-y:\n    model: x/y\nroles:\n  pr: { model: x-y }\npipeline:\n  plan_review: { role: pr, concurrency: 1 }\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}
const goRows = () => readLifecycle().filter((e) => e.event === 's1_go');
// a GO over these events is refused without a reason and recorded with it
async function goNeedsReason(events, reason, name = '') {
  laneState(events);
  const refused = await applyDecision('s1_go', { iddId: 'IDD-001' });
  assert.equal(refused.ok, false, name);
  assert.match(refused.error, /理由/, name);
  assert.deepEqual(goRows(), [], name);
  const passed = await applyDecision('s1_go', { iddId: 'IDD-001', reason });
  assert.equal(passed.ok, true, `${name}: ${passed.error}`);
  assert.equal(goRows()[0].attrs.reason, reason, name);
}
const spentRounds = [...round1, ev('s1_ready'), ev('s1_plan_review_started', { run_id: 'L2' }), found(), ev('s1_ready')];

test('a GO over a must the rounds left is recorded only with its reason, and the reason stays on the record', async () => {
  laneState(spentRounds);
  const refused = await applyDecision('s1_go', { iddId: 'IDD-001' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /理由/);
  assert.deepEqual(goRows(), []);
  const blank = await applyDecision('s1_go', { iddId: 'IDD-001', reason: '   ' });
  assert.equal(blank.ok, false);
  assert.deepEqual(goRows(), []);
  const passed = await applyDecision('s1_go', { iddId: 'IDD-001', reason: '残りの must は別 lane の話と読んだ' });
  assert.equal(passed.ok, true, passed.error);
  assert.equal(goRows().length, 1);
  assert.equal(goRows()[0].attrs.reason, '残りの must は別 lane の話と読んだ');
});

test('a second review that failed or was skipped leaves the first must unconfirmed, so a GO still needs its reason', async () => {
  const afterMust = [...round1, ev('s1_ready'), ev('s1_plan_review_started', { run_id: 'L2' })];
  for (const [name, last] of [['failed', ev('s1_plan_review_done', { failed: true, error: 'x' })], ['skipped', ev('s1_plan_review_skipped', { reason: 'r' })]]) {
    await goNeedsReason([...afterMust, last, ev('s1_ready')], '査読が答えなかったが must は読んだ', name);
  }
  // a first review that failed has raised no must, so nothing is left unconfirmed
  laneState([...round1.slice(0, 3), ev('s1_plan_review_done', { failed: true, error: 'x' }), ev('s1_ready')]);
  const plain = await applyDecision('s1_go', { iddId: 'IDD-001' });
  assert.equal(plain.ok, true, plain.error);
});

test('a review skipped after a must was fixed cannot be asked again, so the GO card opens and the must needs a reason', async () => {
  const skip = ev('s1_plan_review_skipped', { reason: 'r' });
  const skipped = [...round1, ev('s1_ready'), skip];
  const phaseOf = (events) => planReviewPhase(events).phase;
  // the fix is waiting until the skip is recorded; the skip says the slot is not declared, so it ends the review
  assert.deepEqual([phaseOf(skipped.slice(0, -1)), deriveStage(skipped.slice(0, -1)).decision], ['waiting', undefined]);
  assert.deepEqual([phaseOf(skipped), deriveStage(skipped).decision, deriveStage(skipped).blockedBy], ['reviewed', 'go', undefined]);
  // the must nobody confirmed is still there, so the card asks for the reason
  assert.equal(planReviewMustUnconfirmed(skipped), true);
  // a round started after the skip is a review to wait for, running
  const second = [...skipped, ev('s1_plan_review_started', { run_id: 'L2' })];
  assert.deepEqual([phaseOf(second), phaseOf([...second, found(0)])], ['running', 'reviewed']);
  // a review that raised no must before it opens the card on the skip alone, with nothing to confirm
  const noMust = [ev('lane_open'), ev('s1_ready'), ev('s1_plan_review_started', { run_id: 'L1' }), found(0), ev('s1_ready'), skip];
  assert.deepEqual([phaseOf(noMust), deriveStage(noMust).decision, planReviewMustUnconfirmed(noMust)], ['reviewed', 'go', false]);
  // a GO over the skip is recorded only with its reason: the must is not passed in silence
  await goNeedsReason(skipped, '再査読の段が無いので must を読んで通す');
});

test('a GO with no must left asks for no reason, and the send-back stays open over a must the rounds left', async () => {
  laneState([...round1.slice(0, 3), ev('s1_plan_review_done', { must: 0, should: 1, nit: 0, sent_back: false }), ev('s1_ready')]);
  const r = await applyDecision('s1_go', { iddId: 'IDD-001' });
  assert.equal(r.ok, true, r.error);
  laneState(spentRounds);
  const back = await applyDecision('s1_revise', { iddId: 'IDD-001', instruction: '残りの must を直して' });
  assert.equal(back.ok, true, back.error);
  assert.equal(planReviewPhase(lane()).phase, 'sent_back');
});

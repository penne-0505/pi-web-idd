import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// IDD-074: under `review_blind.high_risk_when: last` the High role joins the final review, not the first blind.
// The loop reads the lane's Risk before it decides whether the final may be skipped, and a High final is only
// judged when the High role ran to the end. These tests drive the loop with fake runners and read the records.

import { runReviewLoop, stuckOutcomes } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { planReviewInputs } from '../src/plan/plan-review.ts';
import { tmpDir } from './helpers/tmp.mjs';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });
const REC = { idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' };
const gitIn = (wt, ...args) => execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { encoding: 'utf8' }).trim();
function commitIn(wt, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, name)), { recursive: true });
    writeFileSync(join(wt, name), text ?? `${Date.now()}-${Math.random()}`);
  }
  gitIn(wt, 'add', '-A');
  gitIn(wt, 'commit', '-q', '-m', 'c');
  return gitIn(wt, 'rev-parse', 'HEAD');
}

function setup(pipelineYaml, { seed, repos } = {}) {
  const state = tmpDir('idd-high-final-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-v:\n    model: x/v\n  x-o:\n    model: x/o\nroles:\n  v: { model: x-v }\n  o: { model: x-o }\npipeline:\n${pipelineYaml}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const reposFile = join(state, 'repos.yaml');
  const entries = Object.entries(repos ?? {});
  const declared = entries.length ? entries : [['Demo', undefined]];
  writeFileSync(reposFile, JSON.stringify({
    repos: Object.fromEntries(declared.map(([key, paths]) => [key, { github: 'o/r', upstream: '/tmp/u', work: '/tmp/w', ...(paths ? { risk_paths: paths } : {}) }])),
  }));
  process.env.IDD_REPOS_FILE = reposFile;
  const wt = tmpDir('idd-high-final-wt-');
  execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
  const start = commitIn(wt, { 'app.ts': 'export function greet() { return 1; }\n', ...(seed ?? {}) });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(REC) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: start }), ev('s2_result', { outcome: 'success' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state, wt, start };
}

/** a runner that records each start and returns one run per role the round runs (v, and o for an extra) */
function fakeRunner() {
  const calls = [];
  const status = {};
  let n = 0;
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls.push(o);
      const count = o.stage === 'blind' || o.stage === 'final' ? 1 + (o.extras?.length ? 1 : 0) : 1;
      const ids = [...Array(count)].map(() => `${o.stage}-${(n += 1)}`);
      const runRoles = [...Array(count)].map((_, i) => (i === 0 ? 'v' : 'o'));
      for (const id of ids) status[id] = { state: 'running' };
      return { runIds: ids, runRoles };
    },
    reviewRunStatus: (id) => status[id],
  });
  const finish = (st) => { for (const [id, s] of Object.entries(status)) if (s.state === 'running') status[id] = st(id); };
  return { calls, status, finish };
}

const last = () => readLifecycle().at(-1);
const REVIEW = (findings = []) => () => ({ state: 'done', reportJson: '/r.json', reportMd: '/r.md', findings });
const TRIAGE = (decisions) => () => ({ state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions });
const MUST = [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: '壊れる', path: 'app.ts', fix: '壊れないこと' }];

async function blindRound(r, decisions) {
  await runReviewLoop();
  r.finish(REVIEW());
  await runReviewLoop();
  await runReviewLoop();
  r.finish(TRIAGE(decisions));
  await runReviewLoop();
}
async function fixLap(r, wt, files) {
  await runReviewLoop();
  assert.equal(last().event, 's2_fix_sent');
  if (files) commitIn(wt, files);
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  await runReviewLoop();
  assert.equal(last().event, 's2_confirm_started');
  r.finish(() => ({ state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'F-1', resolved: true }] }));
  await runReviewLoop();
  assert.equal(last().event, 's2_confirm_done');
}

const NEW = '  review_blind: { roles: [v], first_round_extra: [o], high_risk_extra: [o], high_risk_when: last }\n  triage: { role: v }\n  confirm: { role: v }\n';
const NEW_FINAL = `${NEW}  review_final: { when: behaviour, scope: increment }\n`;
const QA_LOW = '---\nqa_schema: 5\nrisk: Low\n---\n# qa\n';

test('AC-001: the first blind of a High lane adds no High role but still records the Risk', async () => {
  const { wt } = setup(NEW);
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls[0].extras, ['first_round'], 'the High role stays off the first blind');
  const started = readLifecycle().find((e) => e.event === 's2_review_started');
  assert.equal(started.attrs.risk, 'unknown', 'no qa and no TODO Risk: the lane counts as high, and the read is on record');
  setAgentRunner(null);
  assert.ok(wt);
});

test('AC-003: a High lane whose blind accepted nothing still runs the final, whole and with the High role', async () => {
  const { wt } = setup(NEW_FINAL);
  const r = fakeRunner();
  await blindRound(r, []);
  await runReviewLoop();
  const final = r.calls.find((c) => c.stage === 'final');
  assert.ok(final, 'the final review ran');
  assert.deepEqual(final.extras, ['high_risk']);
  assert.equal(final.scope, undefined, 'the High role has not read the tree, so the whole diff is shown');
  const a = last();
  assert.deepEqual([a.event, a.attrs.kind], ['s2_review_started', 'final']);
  assert.ok(!readLifecycle().some((e) => e.event === 's2_review_converged' && e.attrs.final_skipped));
  setAgentRunner(null);
  assert.ok(wt);
});

test('AC-004: a records and tests fix runs the final; the Low lane under the same key skips it', async () => {
  const { wt } = setup(NEW_FINAL);
  let r = fakeRunner();
  await blindRound(r, MUST);
  await fixLap(r, wt, { '_docs/a.md': 'x', 'app.test.ts': 'x' });
  await runReviewLoop();
  assert.equal(last().event, 's2_review_started');
  assert.equal(last().attrs.kind, 'final');
  setAgentRunner(null);
  // a Low lane keeps the old conditions: a records-only fix skips the final on the settled head
  const qa = planReviewInputs(REC)[1];
  const low = setup(NEW_FINAL, { seed: { [qa]: QA_LOW } });
  r = fakeRunner();
  await blindRound(r, []);
  await runReviewLoop();
  assert.equal(last().event, 's2_review_converged', 'no accepted findings and no High role: the final is skipped');
  assert.ok(!r.calls.some((c) => c.stage === 'final'));
  setAgentRunner(null);
  assert.ok(wt && low.wt);
});

test('AC-005: the first final of a High lane that fixed shows the whole diff with the High role', async () => {
  const { wt, start } = setup(NEW_FINAL);
  const r = fakeRunner();
  await blindRound(r, MUST);
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 42; }\n' });
  await runReviewLoop();
  const final = r.calls.find((c) => c.stage === 'final');
  assert.deepEqual([final.extras, final.scope, final.base], [['high_risk'], undefined, start], 'the High role has not read the tree, so the whole diff');
  setAgentRunner(null);
});

test("AC-009: a fix after a High final gets the next final on the increment from that final's head", async () => {
  const { wt } = setup(NEW_FINAL);
  const r = fakeRunner();
  await blindRound(r, MUST);
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 10; }\n' });
  await runReviewLoop();
  const final1Head = last().attrs.head;
  r.finish(REVIEW());
  await runReviewLoop();
  await runReviewLoop();
  r.finish(TRIAGE(MUST));
  await runReviewLoop();
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 11; }\n' });
  await runReviewLoop();
  const finals = r.calls.filter((c) => c.stage === 'final');
  assert.equal(finals.length, 2);
  assert.deepEqual([finals[1].extras, finals[1].scope, finals[1].base], [['high_risk'], 'increment', final1Head]);
  setAgentRunner(null);
});

test('AC-006: under the new key the card says the final review runs for a High lane and closes for a Low lane', async () => {
  // a blind that read the current head, judged within the limit, with a question: the loop stopped for penne
  const question = (head) => [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'], head }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'nit', claim: '言い回し', path: 'a.ts' }], escalated_claims: ['仕様が決まっていない'] }),
  ];
  const high = setup(NEW);
  for (const e of question(high.start)) await appendLifecycle(e.event, 'IDD-001', e.attrs);
  const h = stuckOutcomes(REC, readLifecycle());
  assert.equal(h.continue.to, 'final', 'the High role has not read the tree: the final review runs');
  setAgentRunner(null);
  const qa = planReviewInputs(REC)[1];
  const low = setup(NEW, { seed: { [qa]: QA_LOW } });
  for (const e of question(low.start)) await appendLifecycle(e.event, 'IDD-001', e.attrs);
  const l = stuckOutcomes(REC, readLifecycle());
  assert.equal(l.continue.to, 'close', 'a Low lane reads the settled head as before and closes the review');
});

test('AC-014: a High final whose High run failed is not judged, and stops for a retry', async () => {
  setup(NEW);
  const r = fakeRunner();
  await blindRound(r, []);
  const ids = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      assert.deepEqual(o.noFallbackRoles, ['o'], 'the High role may not be swapped for a fallback');
      const a = `f${ids.length + 1}`; const b = `f${ids.length + 2}`;
      ids.push(a, b); status[a] = { state: 'running' }; status[b] = { state: 'running' };
      return { runIds: [a, b], runRoles: ['v', 'o'] };
    },
    reviewRunStatus: (id) => status[id],
  });
  await runReviewLoop();
  status[ids[0]] = { state: 'done', reportJson: '/f.json', reportMd: '/f.md', findings: [] };
  status[ids[1]] = { state: 'failed', error: 'boom' };
  await runReviewLoop();
  assert.equal(last().event, 's2_review_escalated');
  assert.match(last().attrs.reason, /High のレビュー/);
  assert.deepEqual(last().attrs.retry_state, { state: 'start_blind', kind: 'final', round: 1 });
  assert.ok(!readLifecycle().some((e) => e.event === 's2_review_findings' && e.attrs.kind === 'final'), 'the round was not judged');
  setAgentRunner(null);
});

const quotaErr = () => Object.assign(new Error('5 時間の枠が閾値に達している'), { code: 'claude_quota', resetsAt: Math.floor(Date.now() / 1000) + 3600 });

test('AC-012/AC-013: a High final held for the windows warns penne, retries itself, and a continue lets the fallback run', async () => {
  setup(NEW);
  const r = fakeRunner();
  await blindRound(r, []);
  const calls = [];
  const ids = [];
  const status = {};
  let refuse = true;
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls.push(o);
      if (refuse) throw quotaErr();
      const a = `q${ids.length + 1}`; ids.push(a); status[a] = { state: 'running' };
      return { runIds: [a], runRoles: ['o'] };
    },
    reviewRunStatus: (id) => status[id],
  });
  await runReviewLoop();
  assert.equal(last().event, 's2_review_escalated');
  assert.ok(last().attrs.quota_wait, 'the wait is on record, with the role and the reset time');
  assert.deepEqual(calls.at(-1).noFallbackRoles, ['o'], 'the High role waits instead of falling back');
  const card = stuckOutcomes(REC, readLifecycle());
  assert.deepEqual(card.continue, { to: 'retry', highFallback: true });
  // the loop tries again on its own when the windows open, without penne: the escalation is not re-recorded
  refuse = false;
  await runReviewLoop();
  assert.equal(last().event, 's2_review_started');
  assert.equal(last().attrs.high_allowed, undefined, 'the auto retry did not let the fallback run');
  assert.equal(readLifecycle().filter((e) => e.event === 's2_review_escalated' && e.attrs.quota_wait).length, 1, 'the wait is recorded once');
  setAgentRunner(null);
});

test('AC-013: a continue on the window wait runs the final with the fallback and marks it as penne-allowed', async () => {
  setup(NEW);
  const r = fakeRunner();
  await blindRound(r, []);
  const calls = [];
  const ids = [];
  const status = {};
  let refuse = true;
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls.push(o);
      if (refuse) throw quotaErr();
      const a = `c${ids.length + 1}`; ids.push(a); status[a] = { state: 'running' };
      return { runIds: [a], runRoles: ['o'] };
    },
    reviewRunStatus: (id) => status[id],
  });
  await runReviewLoop();
  refuse = false;
  await appendLifecycle('s2_review_resumed', 'IDD-001', { decision: 'continue', note: '' });
  await runReviewLoop();
  assert.equal(last().event, 's2_review_started');
  assert.equal(last().attrs.high_allowed, true, 'penne let the fallback run the final');
  assert.deepEqual(last().attrs.extras, ['high_risk']);
  assert.equal(calls.at(-1).noFallbackRoles, undefined, 'the fallback is allowed after the continue');
  setAgentRunner(null);
});

test('AC-020: an escalation that is not a window wait is left alone by the loop', async () => {
  setup(NEW);
  const r = fakeRunner();
  for (const [event, attrs] of [
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['b'] }],
    ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }],
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: [], escalated_claims: ['仕様が決まっていない'] }],
  ]) await appendLifecycle(event, 'IDD-001', attrs);
  await runReviewLoop();
  assert.equal(last().event, 's2_review_escalated');
  await runReviewLoop();
  assert.equal(last().event, 's2_review_escalated', 'no answer and no window wait: nothing starts');
  assert.ok(!r.calls.some((c) => c.stage === 'final'));
  setAgentRunner(null);
});

const CAP = '  review_blind: { roles: [v], first_round_extra: [o], high_risk_extra: [o], high_risk_when: last }\n  review_final: { when: behaviour, scope: increment }\n  review_loop: { max_fix_rounds: 2 }\n  triage: { role: v }\n  confirm: { role: v }\n';

test('AC-008/AC-010: the fix cap names the High final, and going on as it is converges', async () => {
  const { wt } = setup(CAP);
  const r = fakeRunner();
  const must = (n) => [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: `壊れる ${n}`, path: 'app.ts', fix: 'x' }];
  await blindRound(r, must(1));
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 2; }\n' });
  await runReviewLoop();
  r.finish(REVIEW());
  await runReviewLoop(); await runReviewLoop();
  r.finish(TRIAGE(must(2)));
  await runReviewLoop();
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 3; }\n' });
  await runReviewLoop();
  assert.deepEqual(r.calls.filter((c) => c.stage === 'final').map((c) => c.extras), [['high_risk'], ['high_risk']]);
  r.finish(REVIEW());
  await runReviewLoop(); await runReviewLoop();
  r.finish(TRIAGE(must(3)));
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(last().event, 's2_review_escalated');
  assert.match(last().attrs.reason, /High の最後のレビュー/, 'penne can read that the High final stopped the loop');
  assert.match(last().attrs.reason, /上限 2 巡/);
  await appendLifecycle('s2_review_resumed', 'IDD-001', { decision: 'accept', note: '' });
  await runReviewLoop();
  assert.ok(readLifecycle().some((e) => e.event === 's2_review_converged'), 'going on as it is converges at the cap');
  setAgentRunner(null);
});

const RISKY = { auth: ['guard/'] };

test('AC-002: under high_risk_when: last a conflict scope round still adds the High role', async () => {
  const f = setup(`${NEW}  review_loop: { after_merge: conflict }\n`);
  const { wt, start } = f;
  const reviewed = commitIn(wt, { 'app.ts': 'export function greet() { return "lane"; }\n' });
  gitIn(wt, 'checkout', '-q', '-b', 'trunk', start);
  const mainline = commitIn(wt, { 'other-lane.ts': 'export const other = 1;\n' });
  gitIn(wt, 'checkout', '-q', 'lane');
  for (const [event, attrs] of [
    ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B0'], head: reviewed }],
    ['s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }],
    ['s2_triage_done', { kind: 'blind', round: 1, accepted: [] }],
    ['s2_review_converged', {}], ['s2_device_skipped', {}], ['s3_ready', {}],
    ['s4_verify_user_judgment_answered', { outcome: 'revise', by: 'harness' }],
    ['s4_land_conflict', { branch: 'trunk', conflict_files: ['app.ts'], head: reviewed, main_tip: mainline }],
  ]) await appendLifecycle(event, 'IDD-001', attrs);
  gitIn(wt, 'merge', '-q', '--no-edit', 'trunk');
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, 'conflict');
  assert.deepEqual(r.calls[0].extras, ['high_risk'], 'a conflict round reads only the resolution, so no first-round role, but the High role stays');
  setAgentRunner(null);
});
test('AC-021: under the new key the blind records the declaration matching as the old key did', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(NEW, { seed: { [qa]: QA_LOW }, repos: { Demo: RISKY } });
  commitIn(wt, { 'guard/login.ts': 'export const login = 1;\n' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls[0].extras, ['first_round'], 'the lane is High through the declaration, but the new key keeps the High role off the blind');
  const a = last();
  assert.equal(a.attrs.risk, 'Low');
  assert.deepEqual(a.attrs.risk_match, { hits: [{ kind: 'auth', paths: ['guard/login.ts'], total: 1 }] });
  setAgentRunner(null);
});

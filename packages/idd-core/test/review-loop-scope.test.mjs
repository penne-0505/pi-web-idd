import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { EXECUTOR_WAIT_EVENT, runReviewLoop, setRecordsCheckRunner } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { reviewBaseOf } from '../src/ledger/base.ts';
import { planReviewInputs } from '../src/plan/plan-review.ts';
import { isBehaviourPath, laneRisk, mergeOnlyHead, RISK_MATCH_PATH_LIMIT } from '../src/plan/review-scope.ts';
import { MERGE_ONLY_SKIP_EVENT, reviewLoopState } from '../src/ledger/review-loop.ts';
import { buildSubmitReview } from '../src/plan/ship.ts';
import { reviewLoopState as referenceReviewLoopState } from '../src/ledger/review-loop-reference.ts';
import { unreviewedChange } from '../src/plan/reviewed-head.ts';
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
  const state = tmpDir('idd-scope-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-v:\n    model: x/v\n  x-o:\n    model: x/o\nroles:\n  v: { model: x-v }\n  o: { model: x-o }\npipeline:\n${pipelineYaml}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  // the repos file is written for every test: a declaration only when the test gives one, so a test never inherits
  // the checkout's own config/repos.yaml (which declares the real repo's paths)
  const reposFile = join(state, 'repos.yaml');
  const entries = Object.entries(repos ?? {});
  const declared = entries.length ? entries : [['Demo', undefined]];
  writeFileSync(reposFile, JSON.stringify({
    repos: Object.fromEntries(declared.map(([key, paths]) => [key, { github: 'o/r', upstream: '/tmp/u', work: '/tmp/w', ...(paths ? { risk_paths: paths } : {}) }])),
  }));
  process.env.IDD_REPOS_FILE = reposFile;
  const wt = tmpDir('idd-scope-wt-');
  execFileSync('git', ['init', '-q', '-b', 'lane', wt]);
  const start = commitIn(wt, { 'app.ts': 'export function greet() { return 1; }\n', ...(seed ?? {}) });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(REC) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: start }), ev('s2_result', { outcome: 'success' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { state, wt, start };
}

/** a runner that records what each start asked for; every run stays running until the test says otherwise */
function fakeRunner(extra = {}) {
  const calls = [];
  const status = {};
  let n = 0;
  const runner = {
    calls,
    status,
    busy: false,
    finish: (st) => {
      for (const [id, s] of Object.entries(status)) if (s.state === 'running') status[id] = st(id);
    },
  };
  setAgentRunner({
    deliver: async () => {},
    cwdBusy: () => runner.busy,
    startReviewRun: async (o) => {
      calls.push(o);
      const ids = o.stage === 'blind' || o.stage === 'final' ? [...Array(1 + (o.extras?.length ? 1 : 0))].map(() => `${o.stage}-${(n += 1)}`) : [`${o.stage}-${(n += 1)}`];
      for (const id of ids) status[id] = { state: 'running' };
      return { runIds: ids };
    },
    reviewRunStatus: (id) => status[id],
    ...extra,
  });
  return runner;
}

const last = () => readLifecycle().at(-1);
const REVIEW = (findings = []) => () => ({ state: 'done', reportJson: '/r.json', reportMd: '/r.md', findings });
const TRIAGE = (decisions) => () => ({ state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions });
const MUST = [{ ref: 'F-1', verdict: 'accept', severity: 'must', claim: '壊れる', path: 'app.ts', fix: '壊れないこと' }];

/** blind round → its triage accepting `decisions` */
async function blindRound(r, decisions) {
  await runReviewLoop(); // blind started
  r.finish(REVIEW());
  await runReviewLoop(); // findings
  await runReviewLoop(); // triage started
  r.finish(TRIAGE(decisions));
  await runReviewLoop(); // triage done
}

/** fix → executor commits `files` → confirm that finds everything resolved */
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

const BLIND_EXTRAS = '  review_blind: { roles: [v], first_round_extra: [o], high_risk_extra: [o] }\n  triage: { role: v }\n  confirm: { role: v }\n';

test('the first blind round adds the first round\'s extras, and a high-risk lane its own on the first blind and the first final only', async () => {
  const { wt } = setup(BLIND_EXTRAS);
  const r = fakeRunner();
  await blindRound(r, MUST);
  const blind = r.calls.find((c) => c.stage === 'blind');
  assert.deepEqual(blind.extras, ['first_round', 'high_risk'], 'no qa and no TODO Risk: the lane counts as high');
  const started = readLifecycle().find((e) => e.event === 's2_review_started');
  assert.deepEqual([started.attrs.extras, started.attrs.risk], [['first_round', 'high_risk'], 'unknown']);
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 2; }\n' });
  await runReviewLoop();
  const final1 = r.calls.filter((c) => c.stage === 'final')[0];
  assert.deepEqual(final1.extras, ['high_risk'], 'the first final of a high-risk lane adds its extras');
  r.finish(REVIEW());
  await runReviewLoop(); await runReviewLoop();
  r.finish(TRIAGE(MUST));
  await runReviewLoop();
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 3; }\n' });
  await runReviewLoop();
  const final2 = r.calls.filter((c) => c.stage === 'final')[1];
  assert.equal(final2.extras, undefined, 'every other round runs the slot\'s roles only');
  setAgentRunner(null);
});

test('a lane whose qa says Risk Low gets only the first round\'s extras; a TODO Risk is read when the qa has none', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: '---\nqa_schema: 5\nrisk: Low\n---\n# qa\n' } });
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls[0].extras, ['first_round']);
  assert.equal(readLifecycle().at(-1).attrs.risk, 'Low');
  setAgentRunner(null);
  // the TODO's Risk, for the task the intake names
  const todo = '## Tasks\n\n### Demo-Enhance-7: x\n\n- **ID**: Demo-Enhance-7\n- **Risk**: Critical\n\n### Demo-Enhance-8: y\n\n- **Risk**: Low\n';
  const dir = tmpDir('idd-risk-');
  writeFileSync(join(dir, 'TODO.md'), todo);
  assert.deepEqual(laneRisk({ ...REC, title: 'Demo-Enhance-7 を直す' }, dir), { high: true, risk: 'Critical', from: 'todo' });
  assert.deepEqual(laneRisk({ ...REC, title: 'Demo-Enhance-8 を直す' }, dir), { high: false, risk: 'Low', from: 'todo' });
  assert.deepEqual(laneRisk(REC, wt), { high: false, risk: 'Low', from: 'qa' });
});

/** the six-kind report table, with `touched` kinds saying yes */
const table = (...touched) => ['auth', 'authz', 'billing', 'permission', 'data_loss', 'secret'].map((kind) => ({ kind, touches: touched.includes(kind), reason: touched.includes(kind) ? `${kind} を変える。` : `${kind} を変えない。` }));

/** the lane's last ready recorded with a table (appended after the seeded events) */
function readyWithTable(state, rows) {
  appendFileSync(join(state, 'lifecycle-Demo.jsonl'), JSON.stringify(ev('s1_ready', { risk_table: rows })) + '\n');
}

test('a table row that says the lane touches a kind of harm raises a Medium qa to High, and the blind gets the high-risk extra', async () => {
  const qa = planReviewInputs(REC)[1];
  const { state, wt } = setup(BLIND_EXTRAS, { seed: { [qa]: '---\nqa_schema: 5\nrisk: Medium\n---\n# qa\n' } });
  readyWithTable(state, table('auth'));
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls[0].extras, ['first_round', 'high_risk']);
  assert.deepEqual(laneRisk(REC, wt), { high: true, risk: 'Medium', from: 'qa' });
  assert.equal(readLifecycle().find((e) => e.event === 's2_review_started').attrs.risk, 'Medium');
  setAgentRunner(null);
});

test('a table of not-touching rows never lowers a declared High, and neither does a ready without a table', async () => {
  const qa = planReviewInputs(REC)[1];
  const { state, wt } = setup(BLIND_EXTRAS, { seed: { [qa]: '---\nqa_schema: 5\nrisk: High\n---\n# qa\n' } });
  readyWithTable(state, table());
  assert.deepEqual(laneRisk(REC, wt), { high: true, risk: 'High', from: 'qa' });
  // an old ready (no table) keeps the qa's High as well
  assert.deepEqual(laneRisk({ ...REC, title: 'no-table' }, wt), { high: true, risk: 'High', from: 'qa' });
  // and a not-touching table does not turn a Medium qa into High
  writeFileSync(join(wt, qa), '---\nqa_schema: 5\nrisk: Medium\n---\n');
  assert.deepEqual(laneRisk(REC, wt), { high: false, risk: 'Medium', from: 'qa' });
});

test('a lane whose qa and TODO Risk cannot be read is High, and an all-clear table does not lower it', async () => {
  const { state, wt } = setup(BLIND_EXTRAS);
  assert.deepEqual(laneRisk(REC, wt), { high: true, risk: 'unknown', from: 'unknown' });
  readyWithTable(state, table());
  assert.deepEqual(laneRisk(REC, wt), { high: true, risk: 'unknown', from: 'unknown' });
});

test('without the extras keys every round runs the slot\'s roles, and a pass records no policy of its own', async () => {
  setup('  review_blind: { roles: [v] }\n  triage: { role: v }\n  confirm: { role: v }\n');
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].extras, undefined);
  const a = last().attrs;
  assert.deepEqual([a.extras, a.risk, a.max_fix_rounds, a.close_on], [undefined, undefined, undefined, undefined]);
  setAgentRunner(null);
});

test('the pass\'s first blind records the fix cap and the close condition, and its judgement is told to leave shoulds for later', async () => {
  const { state } = setup('  review_blind: { roles: [v] }\n  review_loop: { max_fix_rounds: 2, should_default: followup }\n  triage: { role: v }\n');
  let r = fakeRunner();
  await runReviewLoop();
  const started = readLifecycle().find((e) => e.event === 's2_review_started');
  assert.deepEqual([started.attrs.max_fix_rounds, started.attrs.close_on], [2, 'must']);
  // the pass keeps what it began with: roles.yaml changed halfway does not change its judgement's instruction
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-v:\n    model: x/v\nroles:\n  v: { model: x-v }\npipeline:\n  review_blind: { roles: [v] }\n  triage: { role: v }\n');
  r.finish(REVIEW());
  await runReviewLoop(); await runReviewLoop();
  assert.equal(r.calls.find((c) => c.stage === 'triage').shouldDefault, 'followup');
  setAgentRunner(null);
  setup('  review_blind: { roles: [v] }\n  review_loop: { max_fix_rounds: 8, should_default: fix }\n  triage: { role: v }\n');
  r = fakeRunner();
  await blindRound(r, []);
  const old = readLifecycle().find((e) => e.event === 's2_review_started');
  assert.deepEqual([old.attrs.max_fix_rounds, old.attrs.close_on], [undefined, undefined], 'the rollback values read as the old loop');
  assert.equal(r.calls.find((c) => c.stage === 'triage').shouldDefault, undefined);
  setAgentRunner(null);
});

test('the triage value records its close condition and cap, and reads a fix without a basis back as a follow-up', async () => {
  setup('  review_blind: { roles: [v] }\n  review_loop: { should_default: triage, max_should_fix: 2 }\n  triage: { role: v }\n  confirm: { role: v }\n');
  const r = fakeRunner();
  await blindRound(r, [
    { ref: 'F-1', verdict: 'accept', severity: 'should', claim: 'engine が止まる', path: 'app.ts', fix: '止まらないこと', action: 'fix', fix_basis: 'halt', impact: 'engine が止まる' },
    { ref: 'F-2', verdict: 'accept', severity: 'should', claim: '基準なしの勧め', path: 'app.ts', fix: 'f', action: 'fix', impact: 'engine が止まる' },
    { ref: 'F-3', verdict: 'accept', severity: 'should', claim: '害の文なし', path: 'app.ts', fix: 'f', action: 'fix', fix_basis: 'halt' },
  ]);
  const started = readLifecycle().find((e) => e.event === 's2_review_started');
  assert.deepEqual([started.attrs.close_on, started.attrs.max_should_fix], ['must_and_fix', 2]);
  const accepted = last().attrs.accepted;
  assert.deepEqual([accepted[0].action, accepted[0].fix_basis], ['fix', 'halt']);
  assert.deepEqual([accepted[1].action, accepted[1].claimed_action], ['followup', 'fix']);
  assert.deepEqual([accepted[2].action, accepted[2].claimed_action], ['followup', 'fix'], 'a fix with no harm written is read back too');
  // the one basis-shown fix keeps the pass open: the next step sends it to the fix
  await runReviewLoop();
  assert.equal(last().event, 's2_fix_sent');
  setAgentRunner(null);
});

test('a judgement recommending more fixes than its pass\'s cap stops for penne, and no fix is sent before the answer', async () => {
  setup('  review_blind: { roles: [v] }\n  review_loop: { should_default: triage, max_should_fix: 2 }\n  triage: { role: v }\n  confirm: { role: v }\n');
  const r = fakeRunner();
  const fixShould = (i) => ({ ref: `F-${i}`, verdict: 'accept', severity: 'should', claim: `害 ${i}`, path: 'app.ts', fix: 'f', action: 'fix', fix_basis: 'halt', impact: 'engine が止まる' });
  await blindRound(r, [fixShould(1), fixShould(2), fixShould(3)]);
  await runReviewLoop();
  assert.equal(last().event, 's2_review_escalated');
  assert.match(String(last().attrs.reason), /1 回の判定で fix を勧めた should が 3 件（この回の上限 2 件）。境目を決めてください/);
  assert.ok(!readLifecycle().some((e) => e.event === 's2_fix_sent'), 'no fix goes out before penne answers');
  await appendLifecycle('s2_review_resumed', 'IDD-001', { decision: 'continue', note: '' });
  await runReviewLoop();
  assert.equal(last().event, 's2_fix_sent', 'penne\'s continue sends the fix');
  setAgentRunner(null);
});

test('what counts as a behaviour file: not a record, not Markdown, not a test', () => {
  const overlay = ['_meta/', 'TODO.md', 'scripts/test-validators.ts'];
  for (const p of ['_docs/intent/a/decision.md', 'TODO.md', 'starter/TODO.md', 'README.md', 'lib/a.test.ts', 'packages/x/test/y.ts', 'app/tests/z.py', '_meta/scratch/x.ts', 'scripts/test-validators.ts']) {
    assert.equal(isBehaviourPath(p, overlay), false, p);
  }
  for (const p of ['lib/a.ts', 'packages/x/src/test-helpers.ts', 'config/roles.yaml', 'scripts/check.sh']) assert.equal(isBehaviourPath(p, overlay), true, p);
});

const FINAL = (extra) => `  review_blind: { roles: [v] }\n${extra}  triage: { role: v }\n  confirm: { role: v }\n`;

test('under review_final.when: behaviour a fix of records and tests only closes the loop without the final; a behaviour fix gets it', async () => {
  for (const [files, final] of [[{ '_docs/a.md': 'x', 'app.test.ts': 'x' }, false], [{ 'app.ts': 'export function greet() { return 9; }\n' }, true]]) {
    const { wt } = setup(FINAL('  review_final: { when: behaviour }\n'));
    const r = fakeRunner();
    await blindRound(r, MUST);
    await fixLap(r, wt, files);
    await runReviewLoop();
    if (final) {
      assert.equal(last().event, 's2_review_started');
      assert.equal(last().attrs.kind, 'final');
    } else {
      assert.equal(last().event, 's2_review_converged');
      assert.equal(last().attrs.final_skipped, '修正が挙動のファイルに触れていないので、最後のレビューを省いた');
      assert.ok(!r.calls.some((c) => c.stage === 'final'));
    }
    setAgentRunner(null);
  }
  // when: always (and the key left out) runs the final after a records-only fix as before
  for (const cfg of ['  review_final: { when: always }\n', '']) {
    const { wt } = setup(FINAL(cfg));
    const r = fakeRunner();
    await blindRound(r, MUST);
    await fixLap(r, wt, { '_docs/a.md': 'x' });
    await runReviewLoop();
    assert.equal(last().event, 's2_review_started', cfg || 'no key');
    assert.equal(last().attrs.kind, 'final');
    setAgentRunner(null);
  }
});

test('review_final.scope: increment shows the final only the fixes since the last round; whole shows the lane\'s whole change', async () => {
  for (const scope of ['increment', 'whole']) {
    const { wt, start } = setup(FINAL(`  review_final: { scope: ${scope} }\n`));
    const r = fakeRunner();
    await blindRound(r, MUST);
    const blindHead = readLifecycle().find((e) => e.event === 's2_review_started').attrs.head;
    await fixLap(r, wt, { 'app.ts': 'export function greet() { return 5; }\n' });
    await runReviewLoop();
    const final = r.calls.find((c) => c.stage === 'final');
    const a = last().attrs;
    if (scope === 'increment') {
      assert.deepEqual([final.base, final.scope, final.laneBase, final.merge], [blindHead, 'increment', start, undefined]);
      assert.deepEqual([a.diff_base, a.diff_scope], [blindHead, 'increment']);
    } else {
      assert.deepEqual([final.base, final.scope, final.laneBase], [start, undefined, undefined]);
      assert.deepEqual([a.diff_base, a.diff_scope], [undefined, undefined]);
    }
    setAgentRunner(null);
  }
});

/**
 * A lane that converged, was sent back for a conflict with the mainline, and merged the mainline in: the start, the
 * mainline's own commit, and the lane's head after the merge.
 */
async function conflictLane(pipelineYaml, { extraCommit = false } = {}) {
  const f = setup(pipelineYaml);
  const { wt, start } = f;
  const reviewed = commitIn(wt, { 'app.ts': 'export function greet() { return "lane"; }\n' });
  gitIn(wt, 'checkout', '-q', '-b', 'trunk', start);
  const mainline = commitIn(wt, { 'other-lane.ts': 'export const other = 1;\n' });
  gitIn(wt, 'checkout', '-q', 'lane');
  for (const e of [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B0'], head: reviewed }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'),
    ev('s4_verify_user_judgment_answered', { outcome: 'revise', by: 'harness' }),
    ev('s4_land_conflict', { branch: 'trunk', conflict_files: ['app.ts'], head: reviewed, main_tip: mainline }),
  ]) await appendLifecycle(e.event, 'IDD-001', e.attrs);
  gitIn(wt, 'merge', '-q', '--no-edit', 'trunk');
  const merge = gitIn(wt, 'rev-parse', 'HEAD');
  if (extraCommit) commitIn(wt, { 'app.ts': 'export function greet() { return "after"; }\n' });
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  return { ...f, reviewed, mainline, merge };
}

test('after a conflict merge the round reads only the resolved hunks, and the base takes the mainline in for good', async () => {
  const { wt, start, mainline, merge } = await conflictLane(`  review_blind: { roles: [v], first_round_extra: [o] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n`);
  const r = fakeRunner();
  await runReviewLoop();
  const call = r.calls[0];
  assert.equal(call.stage, 'blind');
  assert.deepEqual([call.scope, call.merge], ['conflict', merge]);
  assert.equal(call.extras, undefined, 'a conflict round reads only the resolution, so it adds no first-round role');
  const base = call.base;
  assert.deepEqual(gitIn(wt, 'rev-list', '--parents', '-n', '1', base).split(' ').slice(1), [start, mainline], 'the base is the start with the mainline merged in');
  assert.deepEqual(gitIn(wt, 'diff', '--name-only', base, merge).split('\n'), ['app.ts'], 'the mainline\'s own files are not the lane\'s');
  const a = last().attrs;
  assert.deepEqual([a.diff_scope, a.merge, a.review_base], ['conflict', merge, base]);
  assert.equal(reviewBaseOf(readLifecycle()), base, 'every later round and R2 diff against the new base');
  setAgentRunner(null);
});

test('a merge with other commits next to it moves the base but reads the whole diff; after_merge: whole keeps the old round', async () => {
  const mixed = await conflictLane(`  review_blind: { roles: [v] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n`, { extraCommit: true });
  let r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, undefined);
  assert.notEqual(r.calls[0].base, mixed.start);
  assert.equal(last().attrs.review_base, r.calls[0].base);
  assert.equal(last().attrs.diff_scope, undefined);
  setAgentRunner(null);
  const whole = await conflictLane(`  review_blind: { roles: [v] }\n  triage: { role: v }\n`);
  r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual([r.calls[0].scope, r.calls[0].merge, r.calls[0].base], [undefined, undefined, whole.start]);
  assert.equal(last().attrs.review_base, undefined);
  assert.equal(reviewBaseOf(readLifecycle()), whole.start);
  setAgentRunner(null);
});

test('a conflict round that closes without a fix skips the final; a later fix gets its increment against the merged head', async () => {
  const { wt, merge } = await conflictLane(`  review_blind: { roles: [v] }\n  review_final: { when: behaviour, scope: increment }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n  confirm: { role: v }\n`);
  const r = fakeRunner();
  await blindRound(r, MUST);
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return "fixed"; }\n' });
  await runReviewLoop();
  const final = r.calls.find((c) => c.stage === 'final');
  assert.deepEqual([final.scope, final.base], ['increment', merge], 'the increment starts at the head the conflict round read');
  setAgentRunner(null);
  const quiet = await conflictLane(`  review_blind: { roles: [v] }\n  review_final: { when: behaviour }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n`);
  const q = fakeRunner();
  await blindRound(q, []);
  await runReviewLoop();
  assert.equal(last().event, 's2_review_converged');
  assert.ok(!q.calls.some((c) => c.stage === 'final'));
  assert.ok(quiet.merge);
  setAgentRunner(null);
});


// ---- IDD-057: the conflict send-back's own head, the records-only commits, and the conflict scope round ----

/** a lane that converged, had the harness's records commits added, was sent back for a conflict at that head, and merged the mainline in */
async function recordsThenConflict(pipelineYaml, { seed, repos, secondMerge = false, lane = {}, main = {} } = {}) {
  const f = setup(pipelineYaml, { seed, repos });
  const { wt, start } = f;
  const reviewed = commitIn(wt, { 'app.ts': 'export function greet() { return "lane"; }\n', ...lane });
  const qa = commitIn(wt, { '_docs/qa/Demo/x/qa.md': '# qa\n' });
  const todo = commitIn(wt, { 'TODO.md': '# TODO\n' });
  gitIn(wt, 'checkout', '-q', '-b', 'trunk', start);
  const mainline = commitIn(wt, { 'other-lane.ts': 'export const other = 1;\n', ...main });
  gitIn(wt, 'checkout', '-q', 'lane');
  for (const e of [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B0'], head: reviewed }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'),
    ev('s4_verify_user_judgment_answered', { outcome: 'revise', by: 'harness' }),
    ev('s4_land_conflict', { branch: 'trunk', conflict_files: ['app.ts'], head: todo, main_tip: mainline }),
  ]) await appendLifecycle(e.event, 'IDD-001', e.attrs);
  gitIn(wt, 'merge', '-q', '--no-edit', 'trunk');
  const merge = gitIn(wt, 'rev-parse', 'HEAD');
  let merge2;
  if (secondMerge) {
    // the mainline moves on once more while the lane works: two merges sit on its first-parent line
    gitIn(wt, 'checkout', '-q', 'trunk');
    commitIn(wt, { 'third.ts': 'export const third = 1;\n' });
    gitIn(wt, 'checkout', '-q', 'lane');
    gitIn(wt, 'merge', '-q', '--no-edit', 'trunk');
    merge2 = gitIn(wt, 'rev-parse', 'HEAD');
  }
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  return { ...f, reviewed, qa, todo, mainline, merge, merge2 };
}

test('a conflict send-back counts from its own head, so the records commits after the round do not widen the scope', async () => {
  const { merge } = await recordsThenConflict(`  review_blind: { roles: [v], first_round_extra: [o] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n  confirm: { role: v }\n`);
  const r = fakeRunner();
  await runReviewLoop();
  const call = r.calls[0];
  assert.equal(call.stage, 'blind');
  assert.deepEqual([call.scope, call.merge], ['conflict', merge], 'the round sits on the send-back head, not the round head');
  assert.equal(call.extras, undefined, 'a conflict round adds no first-round extra');
  const a = last().attrs;
  assert.deepEqual([a.diff_scope, a.merge, a.round], ['conflict', merge, 2], 'the send-back moved the round number on');
  assert.equal(reviewBaseOf(readLifecycle()), call.base, 'the base took the mainline in for good');
  setAgentRunner(null);
});

test('a records-only commit after the merge leaves a conflict scope round on the same merge', async () => {
  for (const [name, files] of [
    ['TODO.md', { 'TODO.md': '# TODO\n\n- later record\n' }],
    ['README.md', { 'README.md': '# readme\n\n- later record\n' }],
  ]) {
    const { wt, merge } = await recordsThenConflict(`  review_blind: { roles: [v] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n  confirm: { role: v }\n`);
    commitIn(wt, files);
    const r = fakeRunner();
    await runReviewLoop();
    assert.deepEqual([r.calls[0].scope, r.calls[0].merge], ['conflict', merge], name);
    assert.equal(last().attrs.diff_scope, 'conflict', name);
    setAgentRunner(null);
  }
});

test('a behaviour or a test commit after the merge reads the whole diff, on the base the merge moved on', async () => {
  for (const [name, files] of [
    ['a behaviour file', { 'app.ts': 'export function greet() { return "after"; }\n' }],
    ['a test file', { 'app.test.ts': "import { greet } from './app.ts';\n" }],
  ]) {
    const { wt, start } = await recordsThenConflict(`  review_blind: { roles: [v] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n  confirm: { role: v }\n`);
    commitIn(wt, files);
    const r = fakeRunner();
    await runReviewLoop();
    assert.equal(r.calls[0].scope, undefined, name);
    assert.equal(last().attrs.diff_scope, undefined, name);
    assert.notEqual(r.calls[0].base, start, `${name}: the base still took the mainline in`);
    setAgentRunner(null);
  }
});

/** a lane sent back from the S3 check's conflict, as penne's send-back of the submit card is recorded */
async function s3CheckConflictLane(pipelineYaml, { cleanAfter = false, noHead = false } = {}) {
  const f = setup(pipelineYaml);
  const { wt, start } = f;
  const reviewed = commitIn(wt, { 'app.ts': 'export function greet() { return "lane"; }\n' });
  const records = commitIn(wt, { '_docs/qa/Demo/x/qa.md': '# qa\n' });
  gitIn(wt, 'checkout', '-q', '-b', 'trunk', start);
  const mainline = commitIn(wt, { 'other-lane.ts': 'export const other = 1;\n' });
  gitIn(wt, 'checkout', '-q', 'lane');
  for (const e of [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B0'], head: reviewed }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_review_converged'), ev('s2_device_skipped'), ev('s3_ready'),
    ev('s3_check_conflict', { conflict_files: ['app.ts'] }),
    ...(cleanAfter ? [ev('s3_check_clean', {})] : []),
  ]) await appendLifecycle(e.event, 'IDD-001', e.attrs);
  await seedLifecycle('s4_submit_started', 'IDD-001', noHead ? {} : { head: records });
  await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-001', { outcome: 'revise' });
  gitIn(wt, 'merge', '-q', '--no-edit', 'trunk');
  const merge = gitIn(wt, 'rev-parse', 'HEAD');
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  return { ...f, reviewed, records, mainline, merge };
}

test('the S3 check\'s conflict also counts from the card\'s head; a later clean check or a non-penne send-back is not a conflict send-back', async () => {
  const yaml = `  review_blind: { roles: [v] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n  confirm: { role: v }\n`;
  const fromCard = await s3CheckConflictLane(yaml);
  let r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, 'conflict');
  assert.equal(last().attrs.round, 2);
  setAgentRunner(null);
  // a clean check after the conflict: penne sent it back for something else, so no conflict scope
  const cleaned = await s3CheckConflictLane(yaml, { cleanAfter: true });
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, undefined);
  setAgentRunner(null);
  // no head on the card: the previous round's head is the origin
  const noHead = await s3CheckConflictLane(yaml, { noHead: true });
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, 'conflict');
  setAgentRunner(null);
  // the mainline's own behaviour file is not the lane's: the first-parent line holds only the merge
  assert.ok(fromCard.merge && cleaned.mainline && noHead.mainline);
});

test('two merges since the send-back read the whole diff, so the older resolution is not left unread', async () => {
  const { wt, start, merge2 } = await recordsThenConflict(`  review_blind: { roles: [v] }
  review_loop: { after_merge: conflict }
  triage: { role: v }
  confirm: { role: v }
`, { secondMerge: true });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, undefined, 'two merges are not the one the resolved hunks all sit in');
  assert.equal(last().attrs.diff_scope, undefined);
  assert.equal(last().attrs.merge, merge2, 'the base still takes the newest mainline in');
  assert.notEqual(r.calls[0].base, start);
  setAgentRunner(null);
  assert.ok(wt);
});

test('a conflict scope blind keeps only the high-risk extra, and a Risk Low lane gets none', async () => {
  const high = await recordsThenConflict(`${BLIND_EXTRAS}  review_loop: { after_merge: conflict }\n`);
  let r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls[0].extras, ['high_risk'], 'no qa and no TODO Risk: the lane counts as high');
  setAgentRunner(null);
  const qa = planReviewInputs(REC)[1];
  await recordsThenConflict(`${BLIND_EXTRAS}  review_loop: { after_merge: conflict }\n`, { seed: { [qa]: '---\nqa_schema: 5\nrisk: Low\n---\n# qa\n' } });
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].extras, undefined, 'a low-risk conflict round adds nothing');
  setAgentRunner(null);
  assert.ok(high.merge);
});

test('a conflict scope judgment is handed the follow-ups already written; a whole-diff one is not', async () => {
  await recordsThenConflict(`  review_blind: { roles: [v] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n  confirm: { role: v }\n`);
  await appendLifecycle('s3_followups_written', 'IDD-001', { entries: [{ severity: 'should', path: '_docs/a.md', claim: '既出の指摘' }] });
  const r = fakeRunner();
  await blindRound(r, MUST);
  const triage = r.calls.find((c) => c.stage === 'triage');
  const file = triage.inputs.find((p) => /existing-followups-2-blind[.]md$/.test(p));
  assert.ok(file, triage.inputs.join(', '));
  assert.match(readFileSync(file, 'utf8'), /_docs\/a[.]md: 既出の指摘/);
  setAgentRunner(null);
  // a whole-diff round is not handed the list
  setup(BLIND_EXTRAS.replace('first_round_extra: [o], ', ''));
  const plain = fakeRunner();
  await blindRound(plain, MUST);
  assert.equal(plain.calls.find((c) => c.stage === 'triage').inputs.some((p) => /existing-followups/.test(p)), false);
  setAgentRunner(null);
});

test('the Issue lane judgement is handed the lane\'s follow-up Issue drafts: none is said as none, and a runner that cannot read them hands no list', async () => {
  setup(BLIND_EXTRAS);
  const asked = [];
  /** one blind round under a runner with these extras: the judgement's inputs */
  const triageInputs = async (extra) => {
    setup(BLIND_EXTRAS);
    const r = fakeRunner(extra);
    await blindRound(r, MUST);
    setAgentRunner(null);
    return r.calls.find((c) => c.stage === 'triage').inputs;
  };
  const listOf = (inputs) => inputs.find((p) => /followup-issues-1-blind[.]md$/.test(p));
  // no draft: the file is still there and says so, so "no draft" is told apart from "no list"
  const none = await triageInputs({ laneFollowupDrafts: (id) => { asked.push(id); return []; } });
  assert.ok(listOf(none), none.join(', '));
  assert.match(readFileSync(listOf(none), 'utf8'), /^なし/m);
  assert.deepEqual(asked, ['IDD-001']);
  // a draft: its id, title, state and body reach the judgement
  const one = await triageInputs({ laneFollowupDrafts: () => [{ id: 'OUT-1', title: '旧い形を消す', body: '## 応急処置\n残す範囲と本来の直し方', status: 'ready' }] });
  const text = readFileSync(listOf(one), 'utf8');
  assert.match(text, /## OUT-1 旧い形を消す（ready）/);
  assert.match(text, /残す範囲と本来の直し方/);
  assert.doesNotMatch(text, /^なし/m);
  // a runner without the reader hands no list at all
  assert.equal((await triageInputs({})).some((p) => /followup-issues/.test(p)), false);
});

test('IDD-052 in small: two conflict send-backs give conflict scope rounds numbered 2 and 3, each reading only the resolution', async () => {
  const { wt, merge } = await recordsThenConflict(`  review_blind: { roles: [v], first_round_extra: [o] }
  review_loop: { after_merge: conflict }
  triage: { role: v }
  confirm: { role: v }
`);
  await appendLifecycle('s3_followups_written', 'IDD-001', { entries: [{ severity: 'should', path: '_docs/a.md', claim: '同じ指摘' }] });
  // round 2: the conflict scope round runs, and is recorded as such
  let r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls.at(-1).scope, 'conflict');
  assert.equal(last().attrs.round, 2);
  assert.equal(r.calls.at(-1).extras, undefined);
  setAgentRunner(null);
  // the round closes, and the harness adds the follow-up commit
  await appendLifecycle('s2_review_findings', 'IDD-001', { kind: 'blind', round: 2, files: ['/b2.json'] });
  await appendLifecycle('s2_triage_done', 'IDD-001', { kind: 'blind', round: 2, accepted: [] });
  await appendLifecycle('s2_review_converged', 'IDD-001', {});
  await appendLifecycle('s2_device_skipped', 'IDD-001', {});
  await appendLifecycle('s3_ready', 'IDD-001', {});
  const followup = commitIn(wt, { 'TODO.md': '# TODO\n\n- followup\n' });
  // the second conflict: the executor's own qa commit comes after the merge
  gitIn(wt, 'checkout', '-q', 'trunk');
  const mainline2 = commitIn(wt, { 'third.ts': 'export const third = 1;\n' });
  gitIn(wt, 'checkout', '-q', 'lane');
  await appendLifecycle('s4_verify_user_judgment_answered', 'IDD-001', { outcome: 'revise', by: 'harness' });
  await appendLifecycle('s4_land_conflict', 'IDD-001', { branch: 'trunk', conflict_files: ['app.ts'], head: followup, main_tip: mainline2 });
  gitIn(wt, 'merge', '-q', '--no-edit', 'trunk');
  const merge2 = gitIn(wt, 'rev-parse', 'HEAD');
  commitIn(wt, { '_docs/qa/Demo/x/qa.md': '# qa\n\nmore\n' });
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  // round 3: the second conflict scope round
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls.at(-1).scope, 'conflict');
  assert.equal(r.calls.at(-1).merge, merge2);
  assert.equal(last().attrs.round, 3);
  assert.equal(r.calls.at(-1).extras, undefined);
  // its judgement is handed the follow-up already written, so the same claim is not reported again
  r.finish(REVIEW([]));
  await runReviewLoop();
  await runReviewLoop();
  const triage = r.calls.find((c) => c.stage === 'triage');
  assert.ok(triage.inputs.some((p) => /existing-followups-3-blind[.]md$/.test(p)), triage.inputs.join(', '));
  assert.match(readFileSync(triage.inputs.find((p) => /existing-followups-3-blind[.]md$/.test(p)), 'utf8'), /_docs\/a[.]md: 同じ指摘/);
  setAgentRunner(null);
  assert.ok(merge && merge2 && followup);
});

test('AC-024: a work instruction beside the qa does not move the Risk', () => {
  const dir = tmpDir('idd-risk-plan-');
  const qa = planReviewInputs(REC)[1];
  mkdirSync(dirname(join(dir, qa)), { recursive: true });
  writeFileSync(join(dir, qa), '---\nqa_schema: 5\nrisk: Low\n---\n# qa\n');
  const before = laneRisk(REC, dir);
  mkdirSync(join(dir, '_docs/plan/Demo/idd-001'), { recursive: true });
  writeFileSync(join(dir, '_docs/plan/Demo/idd-001/plan.md'), '---\ntitle: t\n---\n');
  assert.deepEqual(laneRisk(REC, dir), before);
  assert.deepEqual(before, { high: false, risk: 'Low', from: 'qa' });
});

// ---- IDD-072: the lane's own change matched against the repo's declaration of dangerous paths ----

const RISKY = { auth: ['guard/'], data_loss: ['migrations/'] };
const QA_MEDIUM = '---\nqa_schema: 5\nrisk: Medium\n---\n# qa\n';

test('a Medium qa whose own change touches a declared path is read High, with the kinds and paths', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Demo: RISKY } });
  // a file deep under a declared directory is matched by its prefix, and one outside it is not
  commitIn(wt, { 'guard/deep/login.ts': 'export const login = 1;\n', 'app.ts': 'export function greet() { return 2; }\n' });
  const read = laneRisk(REC, wt);
  assert.equal(read.high, true);
  assert.equal(read.risk, 'Medium');
  assert.equal(read.from, 'qa');
  assert.deepEqual(read.match.hits, [{ kind: 'auth', paths: ['guard/deep/login.ts'], total: 1 }]);
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls.length, 1, 'the matching calls no model: the only start is the blind');
  assert.deepEqual(r.calls[0].extras, ['first_round', 'high_risk']);
  assert.equal(JSON.stringify(r.calls[0]).includes('guard/'), false, 'the matching is not handed to the reviewer');
  const started = last();
  assert.equal(started.event, 's2_review_started');
  assert.equal(started.attrs.risk, 'Medium', 'the declared value stays in the field it had');
  assert.deepEqual(started.attrs.risk_match, { hits: [{ kind: 'auth', paths: ['guard/deep/login.ts'], total: 1 }] });
  // no event was added for the matching: the lifecycle is exactly what the loop writes
  assert.deepEqual(readLifecycle().map((e) => e.event), ['s1_go', 's2_start', 's2_result', 's2_review_started']);
  setAgentRunner(null);
});

test('a Medium qa whose change misses the declaration stays as it was, and the round records no matching', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Demo: RISKY } });
  commitIn(wt, { 'app.ts': 'export function greet() { return 3; }\n' });
  assert.deepEqual(laneRisk(REC, wt), { high: false, risk: 'Medium', from: 'qa' });
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls[0].extras, ['first_round']);
  assert.equal(last().attrs.risk, 'Medium');
  assert.equal(last().attrs.risk_match, undefined);
  setAgentRunner(null);
});

test('a kind that matched many paths keeps a few of them and the count of all', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Demo: { data_loss: ['migrations/'] } } });
  const files = {};
  for (let i = 1; i <= 7; i += 1) files[`migrations/${String(i).padStart(2, '0')}.sql`] = `-- ${i}\n`;
  commitIn(wt, files);
  const hit = laneRisk(REC, wt).match.hits[0];
  assert.equal(hit.kind, 'data_loss');
  assert.equal(hit.paths.length, RISK_MATCH_PATH_LIMIT);
  assert.equal(hit.total, 7);
  setAgentRunner(null);
});

test('a removed file and the old side of a move count, since the changed names detect no rename', async () => {
  const qa = planReviewInputs(REC)[1];
  for (const [name, apply] of [
    ['削除', (wt) => { gitIn(wt, 'rm', '-q', 'guard/x.ts'); }],
    ['移動', (wt) => { mkdirSync(join(wt, 'other'), { recursive: true }); gitIn(wt, 'mv', 'guard/x.ts', 'other/x.ts'); }],
  ]) {
    const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM, 'guard/x.ts': 'x\n' }, repos: { Demo: { data_loss: ['guard/'] } } });
    apply(wt);
    commitIn(wt, {});
    assert.deepEqual(laneRisk(REC, wt).match.hits, [{ kind: 'data_loss', paths: ['guard/x.ts'], total: 1 }], name);
    setAgentRunner(null);
  }
});

test('a fix that first touches a declared path is matched at the first final', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Demo: RISKY } });
  commitIn(wt, { 'app.ts': 'export function greet() { return 4; }\n' });
  const r = fakeRunner();
  await blindRound(r, MUST);
  assert.equal(r.calls.find((c) => c.stage === 'blind').extras.includes('high_risk'), false);
  await fixLap(r, wt, { 'guard/fix.ts': 'export const fix = 1;\n' });
  await runReviewLoop();
  assert.deepEqual(r.calls.find((c) => c.stage === 'final').extras, ['high_risk']);
  assert.deepEqual(last().attrs.risk_match, { hits: [{ kind: 'auth', paths: ['guard/fix.ts'], total: 1 }] });
  setAgentRunner(null);
});

test('a fix after the first final that touches a declared path is matched at the next final, and added once', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Demo: RISKY } });
  commitIn(wt, { 'app.ts': 'export function greet() { return 5; }\n' });
  const r = fakeRunner();
  await blindRound(r, MUST);
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 6; }\n' });
  await runReviewLoop();
  const final1 = r.calls.filter((c) => c.stage === 'final')[0];
  assert.equal(final1.extras, undefined, 'nothing had touched a declared path yet');
  r.finish(REVIEW());
  await runReviewLoop(); await runReviewLoop();
  r.finish(TRIAGE(MUST));
  await runReviewLoop();
  await fixLap(r, wt, { 'guard/after.ts': 'export const after = 1;\n' });
  await runReviewLoop();
  const final2 = r.calls.filter((c) => c.stage === 'final')[1];
  assert.deepEqual(final2.extras, ['high_risk']);
  assert.deepEqual(last().attrs.risk_match, { hits: [{ kind: 'auth', paths: ['guard/after.ts'], total: 1 }] });
  setAgentRunner(null);
});

test('an increment final matches the lane\'s whole change, not only the fixes it is shown', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS + '  review_final: { scope: increment }\n', { seed: { [qa]: QA_MEDIUM }, repos: { Demo: RISKY } });
  commitIn(wt, { 'guard/impl.ts': 'export const impl = 1;\n' });
  const r = fakeRunner();
  await blindRound(r, MUST);
  // the fix touches a file outside the declaration: the increment alone would miss the implementation's path
  await fixLap(r, wt, { 'app.ts': 'export function greet() { return 7; }\n' });
  await runReviewLoop();
  const final = r.calls.find((c) => c.stage === 'final');
  assert.equal(final.scope, 'increment');
  assert.deepEqual(final.extras, ['high_risk']);
  assert.deepEqual(last().attrs.risk_match, { hits: [{ kind: 'auth', paths: ['guard/impl.ts'], total: 1 }] });
  setAgentRunner(null);
});

test('a mainline merge\'s declared path is not the lane\'s, and the lane\'s own declared path is', async () => {
  const qa = planReviewInputs(REC)[1];
  const yaml = '  review_blind: { roles: [v], high_risk_extra: [o] }\n  review_loop: { after_merge: conflict }\n  triage: { role: v }\n  confirm: { role: v }\n';
  const seed = { [qa]: QA_MEDIUM };
  // the mainline moved a declared path; the lane did not
  await recordsThenConflict(yaml, { seed, repos: { Demo: RISKY }, main: { 'guard/main.ts': 'export const main = 1;\n' } });
  let r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, 'conflict');
  assert.equal(r.calls[0].extras, undefined, 'the mainline\'s declared path is not matched');
  assert.equal(last().attrs.risk_match, undefined);
  setAgentRunner(null);
  // the lane itself moved the declared path
  await recordsThenConflict(yaml, { seed, repos: { Demo: RISKY }, lane: { 'guard/lane.ts': 'export const lane = 1;\n' } });
  r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].scope, 'conflict');
  assert.deepEqual(r.calls[0].extras, ['high_risk']);
  assert.deepEqual(last().attrs.risk_match, { hits: [{ kind: 'auth', paths: ['guard/lane.ts'], total: 1 }] });
  setAgentRunner(null);
});

test('a repo with no declaration for the lane\'s area is read exactly as before, without a diff', async () => {
  const qa = planReviewInputs(REC)[1];
  // the lane's own repo declares nothing
  let f = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM } });
  commitIn(f.wt, { 'guard/x.ts': 'x\n' });
  assert.deepEqual(laneRisk(REC, f.wt), { high: false, risk: 'Medium', from: 'qa' });
  // only another area declares the path
  f = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Other: { auth: ['guard/'] } } });
  commitIn(f.wt, { 'guard/x.ts': 'x\n' });
  assert.deepEqual(laneRisk(REC, f.wt), { high: false, risk: 'Medium', from: 'qa' });
  // no repos file at all
  rmSync(join(f.state, 'repos.yaml'), { force: true });
  assert.deepEqual(laneRisk(REC, f.wt), { high: false, risk: 'Medium', from: 'qa' });
  setAgentRunner(null);
});

test('a matching that cannot be answered is High, and never lowers the reading', async () => {
  const qa = planReviewInputs(REC)[1];
  const f = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Demo: RISKY } });
  // the origin commit is not in the repo: the comparison cannot be made
  assert.equal(laneRisk(REC, f.wt, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef').high, true);
  // a broken repos file is not "no declaration": it cannot be answered, so High
  writeFileSync(join(f.state, 'repos.yaml'), JSON.stringify({ repos: { Demo: { github: 'o/r', upstream: '/tmp/u', work: '/tmp/w', risk_paths: { nonsense: ['x'] } } } }));
  assert.equal(laneRisk(REC, f.wt).high, true);
  // an all-clear table does not lower a declared High, and a match never lowers one either
  const g = setup(BLIND_EXTRAS, { seed: { [qa]: '---\nqa_schema: 5\nrisk: High\n---\n' }, repos: { Demo: RISKY } });
  commitIn(g.wt, { 'app.ts': 'export function greet() { return 8; }\n' });
  assert.deepEqual(laneRisk(REC, g.wt), { high: true, risk: 'High', from: 'qa' });
  setAgentRunner(null);
});

test('every combination of declaration, table and matching stays at or above the declared Risk', async () => {
  const qa = planReviewInputs(REC)[1];
  for (const risk of ['Low', 'Medium', 'High']) {
    for (const rows of [undefined, 'touches']) {
      for (const hit of [false, true]) {
        const f = setup(BLIND_EXTRAS, { seed: { [qa]: `---\nqa_schema: 5\nrisk: ${risk}\n---\n` }, repos: { Demo: RISKY } });
        if (rows) readyWithTable(f.state, table(rows === 'touches' ? 'auth' : undefined));
        commitIn(f.wt, hit ? { 'guard/x.ts': 'x\n' } : { 'app.ts': 'export function greet() { return 9; }\n' });
        const read = laneRisk(REC, f.wt);
        const expected = risk === 'High' || rows === 'touches' || hit;
        assert.equal(read.high, expected, `${risk} / ${rows} / ${hit}`);
      }
    }
  }
  setAgentRunner(null);
});

test('a round that fails to start records no matching and no round', async () => {
  const qa = planReviewInputs(REC)[1];
  const { wt } = setup(BLIND_EXTRAS, { seed: { [qa]: QA_MEDIUM }, repos: { Demo: RISKY } });
  commitIn(wt, { 'guard/x.ts': 'x\n' });
  setAgentRunner({ deliver: async () => {}, startReviewRun: async () => { throw new Error('boom'); } });
  await runReviewLoop();
  assert.equal(readLifecycle().some((e) => e.event === 's2_review_started'), false);
  assert.equal(readLifecycle().some((e) => e.attrs?.risk_match), false);
  setAgentRunner(null);
});

// ---- IDD-194: a head that is only the mainline merged in goes on without a round ----

/** the repos file a land lane reads: the lane's own clone, whose work base is the branch `trunk` */
function landRepo(state, wt, intent = false) {
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({
    repos: { Demo: { github: 'o/r', upstream: '/tmp/u', work: wt, work_base: 'trunk', public_base: 'trunk', publish: false, ...(intent ? { checks: [{ name: 'intent', command: 'true', required: false, scope: 'records' }] } : {}) } },
  }));
}

/** a lane that changed one file, with a mainline commit on `trunk` beside it: what a merge of the mainline is made of */
function mergeFixture() {
  const f = setup(BLIND_EXTRAS);
  const { state, wt, start } = f;
  const reviewed = commitIn(wt, { 'app.ts': 'export function greet() { return "lane"; }\n' });
  gitIn(wt, 'checkout', '-q', '-b', 'trunk', start);
  const mainline = commitIn(wt, { 'other-lane.ts': 'export const other = 1;\n' });
  gitIn(wt, 'checkout', '-q', 'lane');
  landRepo(state, wt);
  return { ...f, reviewed, mainline };
}

test('AC-001: the judgement reads a merge only when git makes the same tree of its two parents', () => {
  // a merge git made by itself, with a records-only commit after it
  {
    const f = mergeFixture();
    gitIn(f.wt, 'merge', '-q', '--no-edit', 'trunk');
    const merge = gitIn(f.wt, 'rev-parse', 'HEAD');
    assert.deepEqual(mergeOnlyHead(f.wt, 'IDD-001', f.reviewed, merge), { merge, mainline: f.mainline });
    const records = commitIn(f.wt, { 'TODO.md': '# TODO\n' });
    assert.deepEqual(mergeOnlyHead(f.wt, 'IDD-001', f.reviewed, records), { merge, mainline: f.mainline }, 'records commits next to the merge do not change it');
  }

  // a line added by hand at the merge: nothing a review read, so no skip
  {
    const f = mergeFixture();
    gitIn(f.wt, 'merge', '-q', '--no-edit', '--no-commit', 'trunk');
    appendFileSync(join(f.wt, 'app.ts'), '// 手で足した行\n');
    gitIn(f.wt, 'add', '-A');
    gitIn(f.wt, 'commit', '-q', '--no-edit');
    assert.match(mergeOnlyHead(f.wt, 'IDD-001', f.reviewed, gitIn(f.wt, 'rev-parse', 'HEAD')).refusal, /手で解いた行/);
  }

  // a merge of another branch: its commits were reviewed nowhere, so the work base does not reach them
  {
    const f = mergeFixture();
    gitIn(f.wt, 'checkout', '-q', '-b', 'side', f.start);
    commitIn(f.wt, { 'side.ts': 'export const side = 1;\n' });
    gitIn(f.wt, 'checkout', '-q', 'lane');
    gitIn(f.wt, 'merge', '-q', '--no-edit', 'side');
    assert.match(mergeOnlyHead(f.wt, 'IDD-001', f.reviewed, gitIn(f.wt, 'rev-parse', 'HEAD')).refusal, /work_base から届く/);
  }

  // a commit of code next to the merge
  {
    const f = mergeFixture();
    gitIn(f.wt, 'merge', '-q', '--no-edit', 'trunk');
    const after = commitIn(f.wt, { 'app.ts': 'export function greet() { return "after"; }\n' });
    assert.match(mergeOnlyHead(f.wt, 'IDD-001', f.reviewed, after).refusal, /記録の置き場にない commit/);
  }

  // no work base to read: git cannot say, so the round runs
  {
    const f = setup(BLIND_EXTRAS);
    const lane = commitIn(f.wt, { 'app.ts': 'export function greet() { return "lane"; }\n' });
    gitIn(f.wt, 'checkout', '-q', '-b', 'trunk', f.start);
    commitIn(f.wt, { 'other-lane.ts': 'export const other = 1;\n' });
    gitIn(f.wt, 'checkout', '-q', 'lane');
    gitIn(f.wt, 'merge', '-q', '--no-edit', 'trunk');
    assert.match(mergeOnlyHead(f.wt, 'IDD-001', lane, gitIn(f.wt, 'rev-parse', 'HEAD')).refusal, /work_base から届く/);
  }
  setAgentRunner(null);
});

/**
 * A lane that converged, was sent back for a conflict with the mainline, and answered by merging it in: the reviewed
 * head, the mainline's commit, and the head the answer left (with what the executor did beside the merge).
 */
async function landLane({ hand = false, beside = false, branch = 'trunk', workBase = true, intent = false, still = 0, device = 'skipped' } = {}) {
  const f = setup(`  review_blind: { roles: [v] }\n  review_loop: { after_merge: conflict${still ? `, executor_still_seconds: ${still}` : ''} }\n  triage: { role: v }\n  confirm: { role: v }\n`);
  const { state, wt, start } = f;
  if (workBase) landRepo(state, wt, intent);
  const reviewed = commitIn(wt, { 'app.ts': 'export function greet() { return "lane"; }\n' });
  gitIn(wt, 'checkout', '-q', '-b', 'trunk', start);
  const mainline = commitIn(wt, { 'other-lane.ts': 'export const other = 1;\n' });
  if (branch !== 'trunk') {
    gitIn(wt, 'checkout', '-q', '-b', branch, start);
    commitIn(wt, { 'side.ts': 'export const side = 1;\n' });
  }
  gitIn(wt, 'checkout', '-q', 'lane');
  for (const e of [
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['B0'], head: reviewed }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: ['/b.json'] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [] }),
    ev('s2_review_converged'), device === 'done' ? ev('s2_device_done', { round: 1, blocking: 0, files: ['/d.json'] }) : ev('s2_device_skipped'), ev('s3_ready'),
    ev('s4_verify_user_judgment_answered', { outcome: 'revise', by: 'harness' }),
    ev('s4_land_conflict', { branch, conflict_files: ['app.ts'], head: reviewed, main_tip: mainline }),
  ]) await appendLifecycle(e.event, 'IDD-001', e.attrs);
  gitIn(wt, 'merge', '-q', '--no-edit', '--no-commit', branch);
  if (hand) {
    appendFileSync(join(wt, 'app.ts'), '// 手で足した行\n');
    gitIn(wt, 'add', '-A');
  }
  // a merge that was clean leaves no MERGE_HEAD behind: the commit is the merge either way
  gitIn(wt, 'commit', '-q', '--no-edit');
  const merge = gitIn(wt, 'rev-parse', 'HEAD');
  if (beside) commitIn(wt, { 'app.ts': 'export function greet() { return "after"; }\n' });
  await appendLifecycle('s2_result', 'IDD-001', { outcome: 'success' });
  return { ...f, reviewed, mainline, merge };
}

test('AC-003 / AC-004 / AC-005: a conflict send-back answered by the mainline merged in goes on to S3 without a round', async () => {
  const { state, wt, reviewed, mainline, merge } = await landLane();
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls, [], 'no review stage starts for a head that carries only the mainline');
  const skip = last();
  assert.equal(skip.event, MERGE_ONLY_SKIP_EVENT);
  assert.deepEqual([skip.attrs.head, skip.attrs.reviewed_head, skip.attrs.merge, skip.attrs.mainline], [merge, reviewed, merge, mainline]);
  assert.match(skip.attrs.reason, /本流の merge だけ/);
  assert.equal(reviewLoopState(readLifecycle()).state, 'done', 'S3 may run');
  // the origin moved on past the mainline, so what came with it is not the lane's change
  assert.equal(reviewBaseOf(readLifecycle()), skip.attrs.review_base);
  assert.deepEqual(gitIn(wt, 'rev-list', '--parents', '-n', '1', skip.attrs.review_base).split(' ').slice(1).length, 2, 'the origin is a merge of the base and the mainline');
  assert.deepEqual(gitIn(wt, 'diff', '--name-only', skip.attrs.review_base, merge).split('\n'), ['app.ts']);
  // the submit's gate reads the skipped head as reviewed
  assert.equal(unreviewedChange(readLifecycle(), wt, merge), null);
  assert.ok(state);
  setAgentRunner(null);
});

test('AC-004: the submit gate looks at the head the skipped round stood for', async () => {
  const { wt, merge, reviewed } = await landLane();
  const r = fakeRunner();
  await runReviewLoop();
  assert.deepEqual(r.calls, [], 'no review stage starts for a head that carries only the mainline');
  // a head the skipped round did not stand for: the gate holds the push and names the head it looked at
  const after = commitIn(wt, { 'app.ts': 'export function greet() { return "after"; }\n' });
  // the manifest keeps the overlay out of the comparison: `app.ts` is the lane's public side
  writeFileSync(join(wt, 'overlay.manifest'), 'other-lane.ts\n');
  const held = unreviewedChange(readLifecycle(), wt, after);
  assert.equal(held?.seen, merge, 'the head the skipped round stood for is the head the gate looks at');
  assert.notEqual(held?.seen, reviewed, 'the head the review before the merge is not the one');
  assert.match(held?.reason ?? '', /最後のレビューが見た/);
  setAgentRunner(null);
});

test('AC-004: the card shows the picture comparison of the head it submits', async () => {
  // the earlier round compared the pictures and its result is on the record
  const { merge } = await landLane({ intent: true, device: 'done' });
  fakeRunner();
  setRecordsCheckRunner(async () => ({ outcome: 'clean' }));
  try {
    await runReviewLoop();
    const evs = readLifecycle();
    const device = evs.find((e) => e.event === 's2_device_skipped' && e.attrs.head === merge);
    assert.ok(device, 'the head says that its picture comparison was not run');
    assert.match(device.attrs.reason, /この head では絵の見比べを回していない/);
    assert.equal(reviewLoopState(evs).state, 'done', 'the state is done after that record');
    // the card shows this head's comparison, not the earlier head's result
    const review = buildSubmitReview(evs);
    assert.match(review.device.skipped, /この head では絵の見比べを回していない/);
    assert.equal(review.device.blocking, undefined, "the earlier head's result is not this head's");
  } finally { setRecordsCheckRunner(null); }
  setAgentRunner(null);
});

test('AC-006: a resolution made by hand, a commit beside the merge and another branch still run the round', async () => {
  for (const [name, opts] of [
    ['a resolution by hand', { hand: true }],
    ['a commit beside the merge', { beside: true }],
    ['a merge of another branch', { branch: 'side' }],
    ['no work base', { workBase: false }],
  ]) {
    const f = await landLane(opts);
    const r = fakeRunner();
    await runReviewLoop();
    assert.equal(r.calls[0]?.stage, 'blind', name);
    assert.ok(!readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT), `${name}: nothing is recorded as skipped`);
    setAgentRunner(null);
    assert.ok(f.merge);
  }
});

test('a conflict scope round keeps its own shape: only the resolved hunks are read when the merge is the round', async () => {
  // after `after_merge: conflict`, a merge with a commit beside it reads the whole diff on the base the merge moved on
  const f = await landLane({ beside: true });
  const r = fakeRunner();
  await runReviewLoop();
  assert.equal(r.calls[0].stage, 'blind');
  assert.equal(r.calls[0].scope, undefined);
  assert.notEqual(r.calls[0].base, f.start, 'the base still takes the mainline in');
  setAgentRunner(null);
});

const FINDING = { rule: 'round', id: 'IDD-001', reason: '巡（x まで）に Choice の新設・Re-anchor・Supersede・Waive がありません' };

test('AC-003: a skipped merge-only round still takes the records check for the head it stands for', async () => {
  const { wt, merge } = await landLane({ intent: true });
  const r = fakeRunner();
  const seen = [];
  setRecordsCheckRunner(async (input) => { seen.push(input); return { outcome: 'clean' }; });
  try {
    await runReviewLoop();
    assert.deepEqual(r.calls, [], 'no review stage starts for a head that carries only the mainline');
    assert.equal(seen.length, 1, 'the check runs once, before S3 and before the skipped round is recorded');
    assert.equal(seen[0].worktree, wt, 'in the lane\'s own worktree');
    assert.ok(readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT), 'the round is still recorded as skipped');
    const evs = readLifecycle();
    const verdictAt = evs.findIndex((e) => e.event === 's2_intent_checked');
    const skipAt = evs.findIndex((e) => e.event === MERGE_ONLY_SKIP_EVENT);
    assert.ok(verdictAt >= 0 && skipAt > verdictAt, 'the verdict is on the record before the skipped round is');
    assert.deepEqual([evs[verdictAt].attrs.outcome, evs[verdictAt].attrs.head], ['clean', merge], 'the verdict speaks for the head the lane will submit');
    assert.equal(reviewLoopState(evs).state, 'done');
  } finally { setRecordsCheckRunner(null); }
  setAgentRunner(null);
});

test('AC-003: a skipped merge-only round the records check sends back goes to the records fix, not a fix round', async () => {
  await landLane({ intent: true });
  const r = fakeRunner();
  setRecordsCheckRunner(async () => ({ outcome: 'errors', findings: [FINDING] }));
  try {
    await runReviewLoop();
    assert.deepEqual(r.calls, [], 'the send-back of records is not a review round');
    const evs = readLifecycle();
    assert.ok(evs.some((e) => e.event === MERGE_ONLY_SKIP_EVENT), 'the skipped round stays on the record');
    assert.ok(evs.some((e) => e.event === 's2_records_conflict' && e.attrs.awaiting === true), 'the errors are sent back');
    assert.equal(reviewLoopState(evs).state, 'awaiting_records_fix');
    assert.equal(evs.some((e) => e.event === 's2_fix_sent'), false, 'the records send-back does not use the fix budget');
    // the send-back is written as the wait, the skipped round, then the instruction: the sequence a write of the
    // instruction that failed leaves is the wait and the skipped round alone, and it must not read as the review's end
    const instructed = evs.find((e) => e.event === 's2_records_instructed');
    assert.ok(instructed, 'the instruction is on the record of a send-back that went out');
    assert.equal(reviewLoopState(evs.filter((e) => e !== instructed)).state, 'awaiting_records_fix', 'without the instruction the skip above the wait waits for the executor');
  } finally { setRecordsCheckRunner(null); }
  setAgentRunner(null);
});

test('AC-003: the loop and the cross-check reading both refuse to close a review over an unanswered records wait', () => {
  // the write that cannot land leaves the wait (`s2_records_conflict`) and the skipped round, with no instruction
  const rows = (...events) => events.map((event) => ev(event, event === 's2_result' ? { outcome: 'success' } : {}));
  for (const c of [
    { name: 'the instruction never went out', seq: rows('s2_result', 's2_records_conflict', MERGE_ONLY_SKIP_EVENT), state: 'awaiting_records_fix' },
    { name: 'the instruction is on the record', seq: rows('s2_result', 's2_records_conflict', MERGE_ONLY_SKIP_EVENT, 's2_records_instructed'), state: 'awaiting_records_fix' },
    { name: 'the executor answered', seq: rows('s2_result', 's2_records_instructed', 's2_intent_checked', MERGE_ONLY_SKIP_EVENT), state: 'done' },
  ]) {
    assert.equal(reviewLoopState(c.seq).state, c.state, `${c.name}: the loop`);
    assert.equal(referenceReviewLoopState(c.seq).state, c.state, `${c.name}: the cross-check reading`);
  }
});

test('AC-003: the merge-only skip is judged on the head the executor has stopped at', async () => {
  // the executor's conversation is still answering: the stage waits and skips nothing yet
  const { merge } = await landLane({ intent: true, still: 1 });
  const r = fakeRunner();
  r.busy = true;
  const seen = [];
  setRecordsCheckRunner(async () => { seen.push(1); return { outcome: 'clean' }; });
  try {
    await runReviewLoop();
    assert.equal(last().event, EXECUTOR_WAIT_EVENT);
    assert.equal(readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT), false, 'nothing is skipped while the executor may still commit');
    assert.deepEqual(r.calls, [], 'and no review stage starts either');
    assert.deepEqual(seen, [], 'the records check waits with the judgement');
    r.busy = false;
    // the head and the report have to hold still for the policy's second before the judgement is made
    await new Promise((done) => setTimeout(done, 1200));
    await runReviewLoop();
    assert.ok(readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT && e.attrs.head === merge), 'the still head is the one judged');
    assert.equal(last().event, MERGE_ONLY_SKIP_EVENT, 'the skipped round stands after the verdict it was checked for');
    assert.equal([...readLifecycle()].reverse().find((e) => e.event === 's2_intent_checked')?.attrs.head, merge);

    // a commit beside the merge, made after the answer, is read by a round: the judgement is on the stopped head
    await landLane({ intent: true, still: 1, beside: true });
    const r2 = fakeRunner();
    r2.busy = true;
    await runReviewLoop();
    assert.equal(last().event, EXECUTOR_WAIT_EVENT);
    r2.busy = false;
    await new Promise((done) => setTimeout(done, 1200));
    await runReviewLoop();
    assert.equal(r2.calls[0]?.stage, 'blind', 'the commit the executor added after its report is read');
    assert.equal(readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT), false);
  } finally { setRecordsCheckRunner(null); }
  setAgentRunner(null);
});

test('AC-002: a write that fails right after the records check leaves the next tick to check again, not S3', async (t) => {
  // root writes through a file's own permissions, so the failure cannot be made there
  if (process.getuid?.() === 0) { t.skip('root では書き込みの失敗を作れません'); return; }
  const { state, merge } = await landLane({ intent: true });
  const r = fakeRunner();
  const seen = [];
  setRecordsCheckRunner(async () => { seen.push(1); return { outcome: 'clean' }; });
  const lifeFile = join(state, 'lifecycle-Demo.jsonl');
  chmodSync(lifeFile, 0o444);
  try {
    // the verdict's write is the first write after the check, and it fails: nothing of the skip is on the record
    await assert.rejects(runReviewLoop());
    const evs = readLifecycle();
    assert.deepEqual(r.calls, [], 'no review stage starts');
    assert.equal(seen.length, 1, 'the check ran once');
    assert.equal(evs.some((e) => e.event === MERGE_ONLY_SKIP_EVENT), false, 'the round is not recorded as skipped');
    assert.equal(evs.some((e) => e.event === 's2_intent_checked'), false, 'nor is a verdict that could not be written');
    assert.equal(reviewLoopState(evs).state, 'start_blind', 'the lane stays where the check was owed');
  } finally { chmodSync(lifeFile, 0o644); }
  try {
    await runReviewLoop();
    assert.equal(seen.length, 2, 'the next tick runs the records check again');
    const evs = readLifecycle();
    const verdictAt = evs.findIndex((e) => e.event === 's2_intent_checked');
    const skipAt = evs.findIndex((e) => e.event === MERGE_ONLY_SKIP_EVENT);
    assert.ok(verdictAt >= 0 && skipAt > verdictAt, 'the verdict is written before the skipped round');
    assert.deepEqual([evs[verdictAt].attrs.outcome, evs[verdictAt].attrs.head], ['clean', merge]);
    assert.equal(reviewLoopState(evs).state, 'done', 'S3 may run only after the check');
  } finally { setRecordsCheckRunner(null); setAgentRunner(null); }
});

test('a round the mainline\'s merge alone skips goes through the checks before the convergence first, and is skipped once they spoke for the head', async () => {
  const { state, wt, merge } = await landLane();
  const cfg = JSON.parse(readFileSync(join(state, 'repos.yaml'), 'utf8'));
  cfg.repos.Demo.checks_before_converge = true;
  cfg.repos.Demo.checks = [{ name: 'suite', command: 'true', required: true }];
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify(cfg));
  const { setConvergeCheckLauncher } = await import('../src/overlay/converge-checks.ts');
  const launches = [];
  const run = { status: 'running' };
  setConvergeCheckLauncher({
    start: (input) => { launches.push(input); return { id: 'C1' }; },
    status: (lane, id) => ({ id, lane, status: run.status, rows: [{ name: 'suite', status: 'pass', severity: 'blocking' }], base: 'B' }),
    restart: () => false,
  });
  const r = fakeRunner();
  try {
    await runReviewLoop();
    assert.deepEqual(r.calls, [], 'no review stage starts');
    const started = last();
    assert.equal(started.event, 's2_checks_started', 'the skip waits for the checks');
    assert.equal(started.attrs.head, merge);
    assert.equal(started.attrs.resume_state?.state, 'start_blind', 'and comes back to the round it held back');
    assert.ok(!readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT));
    run.status = 'done';
    await runReviewLoop();
    assert.equal(last().attrs.outcome, 'pass');
    assert.equal(reviewLoopState(readLifecycle()).state, 'start_blind');
    await runReviewLoop();
    assert.ok(readLifecycle().some((e) => e.event === MERGE_ONLY_SKIP_EVENT), 'the round is skipped once the checks spoke for the head');
    assert.ok(!readLifecycle().some((e) => e.event === 's2_review_converged' && readLifecycle().indexOf(e) > readLifecycle().indexOf(started)), 'no convergence is written in its place');
    assert.equal(launches.length, 1);
    assert.ok(wt);
  } finally {
    setConvergeCheckLauncher(null);
    setAgentRunner(null);
  }
});

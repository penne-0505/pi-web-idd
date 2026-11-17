import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deliverPending, pendingEnvelopes } from '../src/agent/outbox.ts';
import { runningExecutors } from '../src/plan/exec.ts';
import { runWatch } from '../src/plan/watch.ts';
import { laneCost, laneRunIds } from '../src/plan/budget.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { applyDecision, laneRejectedEnvelope, queueEnvelope } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewFixEnvelope } from '../src/plan/review-loop.ts';
import { tmpDir } from './helpers/tmp.mjs';

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', source_type: 'github', gh_issue_url: 'https://github.com/me/app/issues/1' };

const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

function setup(extra = [], opts = {}) {
  const state = tmpDir('idd-fix-');
  const wt = join(state, 'wt');
  mkdirSync(wt, { recursive: true });
  gitIn(wt, 'init', '-q');
  writeFileSync(join(wt, 'a.ts'), 'export const a = 1;\n');
  gitIn(wt, 'add', '-A');
  gitIn(wt, 'commit', '-q', '-m', 'base');
  const head = gitIn(wt, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(state, 'u'), work: join(state, 'w'), public_base: 'main' } } }));
  writeFileSync(join(state, 'roles.yaml'), opts.rolesYaml ?? (opts.fixPlan
    ? 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\n  fp: { model: x-y, report: fix_plan }\npipeline:\n  executor: { role: r }\n  fix_plan: { role: fp, concurrency: 1 }\n'
    : 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n'));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(state, 'repos.yaml'), IDD_ROLES_FILE: join(state, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: wt, branch: 'idd/IDD-1', harness: 'pi' }) + '\n');
  const events = [
    ['s1_go', {}],
    ['s2_start', { executor_session_id: 'E1', started_from_commit: opts.noBase ? '' : head }],
    ['s2_result', { outcome: 'success', changed_files: ['a.ts'], commit_count: 2, qa_verified: ['AC-1'], qa_unverified: ['AC-2'], side_findings: ['ついでの発見'] }],
    ...(opts.lifecycle ?? []),
    ...extra,
  ];
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), events.map(([event, attrs]) => JSON.stringify({ idd_id: 'IDD-1', event, at: new Date().toISOString(), attrs })).join('\n') + '\n');
  return { state, wt, head };
}

const sessionRows = () => readFileSync(join(process.env.IDD_STATE_DIR, 'executor-sessions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fixEnvelope = () => queueEnvelope('IDD-1', 'review_fix', reviewFixEnvelope('IDD-1', 2, [{ ref: 'C-1', severity: 'must', claim: 'null で落ちる', fix: 'null でも落ちない' }], undefined, 'review'));

test('a fix starts a new session in the lane worktree, stops the old one first, and carries the contract', async () => {
  const { wt } = setup();
  await fixEnvelope();
  const calls = { spawn: [], deliver: [], stop: [], discard: [], order: [] };
  setAgentRunner({
    spawn: async (o) => { calls.spawn.push(o); return { sessionId: 'E2', model: 'm', harness: 'pi' }; },
    deliver: async (id, text, opts) => { calls.order.push('deliver'); calls.deliver.push({ id, text, opts }); },
    stopSession: async (id) => { calls.order.push('stop'); calls.stop.push(id); },
    discard: async (id) => calls.discard.push(id),
  });
  const res = await deliverPending();
  assert.deepEqual(res.delivered.length, 1);
  assert.deepEqual(calls.spawn, [{ role: 'executor', cwd: wt, laneId: 'IDD-1' }]);
  assert.deepEqual(calls.stop, ['E1']);
  assert.equal(calls.deliver[0].id, 'E2');
  assert.equal(calls.deliver[0].opts.type, 'review_fix');
  assert.deepEqual(calls.order, ['stop', 'deliver'], 'the old session is stopped before the new one is handed the brief');
  // the brief is the executor's frame with the fix task and the recorded instruction
  const text = calls.deliver[0].text;
  for (const tag of ['norms', 'contract', 'configured-checks', 'lane-number', 'previous-result', 'accepted']) {
    assert.match(text, new RegExp(`<${tag}>`), `<${tag}> is in the fix brief`);
  }
  assert.match(text, /<unverified>AC-2<\/unverified>/);
  assert.match(text, /<changed-files>a\.ts<\/changed-files>/);
  assert.match(text, /<commits>2<\/commits>/);
  assert.match(text, /実装は前の session が worktree に commit 済みで、最初からやり直さない。/);
  assert.match(text, /<result>/, 'the executor callback is there');
  // the new session is on record in the same worktree and branch, and does not take an executor slot
  const rows = sessionRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].executor_session_id, 'E2');
  assert.equal(rows[1].kind, 'fix');
  assert.equal(rows[1].worktree_path, wt);
  assert.equal(rows[1].branch, 'idd/IDD-1');
  assert.equal(runningExecutors(), 0);
  setAgentRunner(null);
});

test('a send-back goes the same way, and its instruction reaches the new session', async () => {
  setup();
  await queueEnvelope('IDD-1', 'lane_rejected', ['  <task>', '    ユーザーが提出前の確認で差し戻した。instruction に沿って直し、commit する。', '  </task>', '  <instruction>型を揃える</instruction>'].join('\n'));
  const calls = { deliver: [] };
  setAgentRunner({
    spawn: async () => ({ sessionId: 'E9' }),
    deliver: async (id, text, opts) => calls.deliver.push({ id, text, opts }),
    stopSession: async () => {},
  });
  await deliverPending();
  assert.equal(calls.deliver[0].id, 'E9');
  assert.equal(calls.deliver[0].opts.type, 'lane_rejected');
  assert.match(calls.deliver[0].text, /<instruction>型を揃える<\/instruction>/);
  setAgentRunner(null);
});

test('a spawn that fails leaves the instruction pending and adds no session', async () => {
  setup();
  await fixEnvelope();
  const calls = { spawn: 0, deliver: 0 };
  setAgentRunner({
    spawn: async () => { calls.spawn += 1; throw new Error('spawn boom'); },
    deliver: async () => { calls.deliver += 1; },
    stopSession: async () => {},
  });
  await deliverPending();
  assert.equal(calls.spawn, 1);
  assert.equal(calls.deliver, 0);
  assert.equal(sessionRows().length, 1, 'no session was recorded');
  assert.equal(pendingEnvelopes().length, 1, 'the instruction stays pending');
  // the next delivery tries again, and this time it goes through
  setAgentRunner({
    spawn: async () => { calls.spawn += 1; return { sessionId: 'E2' }; },
    deliver: async () => { calls.deliver += 1; },
    stopSession: async () => {},
  });
  await deliverPending();
  assert.equal(calls.spawn, 2);
  assert.equal(calls.deliver, 1);
  assert.equal(pendingEnvelopes().length, 0);
  setAgentRunner(null);
});

test('a session that cannot be handed its brief is taken back, record and all, and the next delivery starts another', async () => {
  setup();
  await fixEnvelope();
  const calls = { spawn: [], deliver: [], discard: [] };
  let failDeliver = true;
  setAgentRunner({
    spawn: async (o) => { calls.spawn.push(o); return { sessionId: `E${calls.spawn.length + 1}` }; },
    deliver: async (id, text, opts) => { if (failDeliver) throw new Error('deliver boom'); calls.deliver.push({ id, opts }); },
    stopSession: async () => {},
    discard: async (id) => calls.discard.push(id),
  });
  await deliverPending();
  assert.deepEqual(calls.discard, ['E2']);
  assert.equal(sessionRows().length, 1, 'the record of the discarded session is gone');
  assert.equal(pendingEnvelopes().length, 1);
  failDeliver = false;
  await deliverPending();
  assert.equal(calls.spawn.length, 2);
  assert.equal(calls.deliver.at(-1).id, 'E3');
  assert.equal(pendingEnvelopes().length, 0);
  setAgentRunner(null);
});

test('while a fix is undelivered, a stopped previous session is not resumed', async () => {
  setup();
  await fixEnvelope();
  const calls = { deliver: [] };
  setAgentRunner({
    sessionStatus: async () => ({ state: 'stopped', cause: 'interrupted', at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    deliver: async (id, text, opts) => calls.deliver.push({ id, opts }),
  });
  await runWatch();
  assert.deepEqual(calls.deliver, [], 'the watch waits for the fix session instead of waking the old one');
  setAgentRunner(null);
});

test('the lane cost sums every executor session, the fix sessions included', async () => {
  const { state } = setup();
  writeFileSync(join(state, 'executor-sessions.jsonl'), [
    JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: join(state, 'wt'), branch: 'idd/IDD-1', harness: 'pi' }),
    JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E2', worktree_path: join(state, 'wt'), branch: 'idd/IDD-1', kind: 'fix', harness: 'pi' }),
  ].join('\n') + '\n');
  setAgentRunner({ sessionCost: async (id) => (id === 'E1' ? 1 : id === 'E2' ? 2 : 0) });
  const cost = await laneCost('IDD-1', readLifecycle());
  assert.equal(cost.total, 3, 'the implementation session and the fix session both count');
  setAgentRunner(null);
});

test('raising a lane\'s priority records it and sends no envelope', async () => {
  const { state } = setup();
  const res = await applyDecision('priority_elevated', { iddId: 'IDD-1', reason: 'urgent' });
  assert.equal(res.ok, true);
  assert.ok(readLifecycle().some((e) => e.event === 'priority_elevated'), 'the decision is on record');
  assert.equal(pendingEnvelopes().length, 0);
  assert.ok(!existsSync(join(state, 'outbox.jsonl')) || readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim() === '', 'nothing is queued for the agent');
  setAgentRunner(null);
});

/** a runtime that runs the one-off plan and the sessions the way the engine's runner would */
function planRunner({ planPath, planState = 'running' } = {}) {
  const calls = { start: [], status: [], spawn: [], deliver: [], stop: [], discard: [] };
  const states = new Map();
  if (planState !== 'running') states.set('R1', planState);
  return {
    calls, states,
    runner: {
      spawn: async (o) => { calls.spawn.push(o); return { sessionId: `E${calls.spawn.length + 1}` }; },
      deliver: async (id, text, opts) => { calls.deliver.push({ id, text, opts }); },
      stopSession: async (id) => { calls.stop.push(id); },
      discard: async (id) => { calls.discard.push(id); },
      startReviewRun: async (o) => { calls.start.push(o); const runId = `R${calls.start.length}`; states.set(runId, 'running'); return { runIds: [runId] }; },
      reviewRunStatus: (id) => {
        calls.status.push(id);
        const s = states.get(id) ?? 'running';
        if (s === 'running') return { state: 'running' };
        if (s === 'failed') return { state: 'failed', error: '整理の失敗' };
        return { state: 'done', reportJson: `${planPath}.json`, reportMd: planPath };
      },
      sessionCost: async () => 0,
    },
  };
}

const priorFix = [
  ['s2_review_started', { kind: 'blind', round: 1, run_ids: ['B'] }],
  ['s2_triage_done', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: 'c', path: 'a.ts', fix: 'f' }] }],
  ['s2_fix_sent', { round: 1, refs: ['F-1'] }],
  // the fix the envelope carries is the newest one on record, as `send_fix` writes it
  ['s2_triage_done', { kind: 'blind', round: 2, accepted: [{ ref: 'F-2', severity: 'must', claim: 'carried', path: 'b.ts', fix: 'g' }] }],
  ['s2_fix_sent', { round: 2, refs: ['F-2'] }],
];

test('a fix goes through the one-off plan run and is delivered with the plan attached (AC-001, AC-006, AC-013)', async () => {
  const { state, wt } = setup([], { fixPlan: true, lifecycle: priorFix });
  const planPath = join(state, 'plan.md');
  writeFileSync(planPath, '# 案\n直し方の段落。\n');
  // the lane's context document: the plan run reads the same file the executor appends to
  mkdirSync(join(wt, '_docs/context/app/idd-1'), { recursive: true });
  writeFileSync(join(wt, '_docs/context/app/idd-1/context.md'), '# 事実\n\n- 計画役の事実\n');
  await fixEnvelope();
  const f = planRunner({ planPath });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.start.length, 1, 'the plan run starts before the new session');
    assert.equal(f.calls.spawn.length, 0, 'the implementer is not woken yet');
    assert.equal(f.calls.deliver.length, 0);
    assert.equal(pendingEnvelopes().length, 1, 'the instruction waits for the plan');
    const o = f.calls.start[0];
    assert.equal(o.stage, 'fix_plan');
    assert.equal(o.worktree, wt, 'the run reads the lane worktree, not a copy');
    assert.ok(o.base && o.head, 'the run is handed the lane diff');
    assert.ok(o.norms.some((n) => n.includes('lane の中の連番')), 'the harness rules are handed to the run');
    assert.ok(o.inputs.some((p) => p.endsWith('-instruction.md')), 'the instruction is written where the run reads it');
    assert.ok(o.inputs.some((p) => p.endsWith('/decision.md')), 'the lane contract is an input');
    assert.ok(o.inputs.some((p) => p.endsWith('/qa.md')));
    assert.ok(o.inputs.some((p) => p.endsWith('_docs/context/app/idd-1/context.md')), 'the lane context document is an input');
    assert.ok(o.inputs.some((p) => p.includes('history')), 'the previous rounds are an input');
    const started = readLifecycle().filter((e) => e.event === 'fix_plan_started').pop();
    assert.equal(started.attrs.run_id, 'R1');
    assert.ok(laneRunIds(readLifecycle()).includes('R1'), 'the run counts in the lane (AC-013)');
    // a tick while the plan works starts nothing and delivers nothing
    await deliverPending();
    assert.equal(f.calls.start.length, 1);
    assert.equal(f.calls.deliver.length, 0);
    // the plan finishes: the next tick delivers the brief with the plan in its own section
    f.states.set('R1', 'done');
    await deliverPending();
    assert.equal(f.calls.deliver.length, 1);
    assert.equal(f.calls.deliver[0].opts.type, 'review_fix');
    assert.match(f.calls.deliver[0].text, /<fix-plan>/);
    assert.match(f.calls.deliver[0].text, /直し方の段落。/);
    assert.equal(pendingEnvelopes().length, 0);
    const done = readLifecycle().filter((e) => e.event === 'fix_plan_done').pop();
    assert.equal(done.attrs.plan_path, planPath);
    assert.ok(!done.attrs.failed);
  } finally { setAgentRunner(null); }
});

test('a lane without a context document starts the plan run without one (AC-003)', async () => {
  const { state } = setup([], { fixPlan: true, lifecycle: priorFix });
  const planPath = join(state, 'plan3.md');
  writeFileSync(planPath, '案 3\n');
  await fixEnvelope();
  const f = planRunner({ planPath });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.start.length, 1, 'the plan run still starts');
    assert.ok(!f.calls.start[0].inputs.some((p) => /[\\/]context[.]md$/.test(p)), f.calls.start[0].inputs.join(', '));
  } finally { setAgentRunner(null); }
});

test('a continue with a person\'s note goes through the plan and the note stays word for word (AC-002, AC-008)', async () => {
  const { state } = setup([], { fixPlan: true, lifecycle: priorFix });
  const planPath = join(state, 'plan2.md');
  writeFileSync(planPath, '案 2\n');
  await queueEnvelope('IDD-1', 'review_fix', reviewFixEnvelope('IDD-1', 2, [{ ref: 'C-1', severity: 'must', claim: 'c', fix: 'f' }], '人が書いた補足の文', 'review'));
  const f = planRunner({ planPath });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.deliver.length, 0, 'the person\'s note waits for the plan too');
    f.states.set('R1', 'done');
    await deliverPending();
    assert.match(f.calls.deliver[0].text, /<fix-plan>/);
    assert.match(f.calls.deliver[0].text, /<user-note>人が書いた補足の文<\/user-note>/, 'the person\'s words are kept as written');
  } finally { setAgentRunner(null); }
});

test('a send-back and a stall-watch instruction go through the plan too (AC-003, AC-004)', async () => {
  for (const instruction of ['ユーザーが提出前の確認で差し戻した', 'engine の番のまま進まなくなったので差し戻します']) {
    const { state } = setup([], { fixPlan: true });
    const planPath = join(state, 'p.md');
    writeFileSync(planPath, '案\n');
    await queueEnvelope('IDD-1', 'lane_rejected', laneRejectedEnvelope('IDD-1', instruction, false));
    const f = planRunner({ planPath });
    setAgentRunner(f.runner);
    try {
      await deliverPending();
      assert.equal(f.calls.start.length, 1, `${instruction}: the plan runs`);
      assert.equal(f.calls.deliver.length, 0, `${instruction}: delivery waits`);
      f.states.set('R1', 'done');
      await deliverPending();
      assert.equal(f.calls.deliver.length, 1, `${instruction}: it is delivered`);
      assert.match(f.calls.deliver[0].text, /<instruction>/);
      assert.match(f.calls.deliver[0].text, /<fix-plan>/);
    } finally { setAgentRunner(null); }
  }
});

test('a marked conflict-merge instruction reaches the implementer with no plan (AC-005)', async () => {
  setup([], { fixPlan: true });
  await queueEnvelope('IDD-1', 'lane_rejected', laneRejectedEnvelope('IDD-1', 'work 側の本流を merge して衝突を解き、commit してください。', false), { skipFixPlan: true });
  const f = planRunner({ planPath: '/nope' });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.start.length, 0, 'no plan run for a conflict merge');
    assert.equal(f.calls.deliver.length, 1, 'the instruction goes straight to the new session');
    assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
  } finally { setAgentRunner(null); }
});

test('AC-004: under the trial a fix that carries a how-to-fix skips the plan run; one without it, or a config without the key, keeps it', async () => {
  const yaml = (trial) => [
    'roles:',
    '  r: { model: x/y }',
    '  fp: { model: x/y, report: fix_plan }',
    'pipeline:',
    '  executor: { role: r }',
    '  fix_plan: { role: fp, concurrency: 1 }',
    ...(trial ? ['  review_loop: { fix_plan_skip_when_how: true }'] : []),
    '',
  ].join('\n');
  const withHow = (idd = 'IDD-1') => reviewFixEnvelope(idd, 2, [{ ref: 'C-1', severity: 'must', claim: 'null で落ちる', fix: 'null でも落ちない' }], undefined, 'review', [], 'docs', { 'C-1': '呼び出し側で null を通さない' });
  for (const [trial, how, plans] of [[true, true, 0], [true, false, 1], [false, true, 1]]) {
    const { state } = setup([], { rolesYaml: yaml(trial) });
    const planPath = join(state, 'p.md');
    writeFileSync(planPath, '案\n');
    await queueEnvelope('IDD-1', 'review_fix', how ? withHow() : reviewFixEnvelope('IDD-1', 2, [{ ref: 'C-1', severity: 'must', claim: 'null で落ちる', fix: 'null でも落ちない' }], undefined, 'review'));
    const f = planRunner({ planPath });
    setAgentRunner(f.runner);
    try {
      await deliverPending();
      assert.equal(f.calls.start.length, plans, `trial=${trial} how=${how}: the plan runs or not`);
      if (plans === 0) {
        assert.equal(f.calls.deliver.length, 1, `trial=${trial} how=${how}: the fix goes straight to the new session`);
        assert.match(f.calls.deliver[0].text, /<how>呼び出し側で null を通さない<\/how>/);
        assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
      } else {
        assert.equal(f.calls.deliver.length, 0, `trial=${trial} how=${how}: the delivery waits for the plan`);
        f.states.set('R1', 'done');
        await deliverPending();
        assert.equal(f.calls.deliver.length, 1, `trial=${trial} how=${how}: it is delivered`);
        assert.match(f.calls.deliver[0].text, /<fix-plan>/);
      }
    } finally { setAgentRunner(null); }
  }
});

test('AC-004: under the trial a conflict-merge instruction and a send-back without a how-to-fix still go as before', async () => {
  const trial = 'roles:\n  r: { model: x/y }\n  fp: { model: x/y, report: fix_plan }\npipeline:\n  executor: { role: r }\n  fix_plan: { role: fp, concurrency: 1 }\n  review_loop: { fix_plan_skip_when_how: true }\n';
  for (const [kind, plans] of [['lane_rejected', 1], ['conflict', 0]]) {
    const { state } = setup([], { rolesYaml: trial });
    const planPath = join(state, 'p.md');
    writeFileSync(planPath, '案\n');
    const instruction = kind === 'conflict' ? 'work 側の本流を merge して衝突を解き、commit してください。' : 'ユーザーが提出前の確認で差し戻した';
    await queueEnvelope('IDD-1', 'lane_rejected', laneRejectedEnvelope('IDD-1', instruction, false), kind === 'conflict' ? { skipFixPlan: true } : {});
    const f = planRunner({ planPath });
    setAgentRunner(f.runner);
    try {
      await deliverPending();
      assert.equal(f.calls.start.length, plans, `${kind}: the plan runs or not`);
      if (plans === 0) {
        assert.equal(f.calls.deliver.length, 1, `${kind}: it goes straight to the new session`);
        assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
      } else {
        f.states.set('R1', 'done');
        await deliverPending();
        assert.equal(f.calls.deliver.length, 1, `${kind}: it is delivered after the plan`);
        assert.match(f.calls.deliver[0].text, /<fix-plan>/);
      }
    } finally { setAgentRunner(null); }
  }
});

test('a plan run that failed is recorded and the instruction goes out without a plan (AC-011)', async () => {
  const { state } = setup([], { fixPlan: true });
  await fixEnvelope();
  const f = planRunner({ planPath: '/nope' });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    f.states.set('R1', 'failed');
    await deliverPending();
    assert.equal(f.calls.deliver.length, 1, 'the instruction is not held for a failed plan');
    assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
    const done = readLifecycle().filter((e) => e.event === 'fix_plan_done').pop();
    assert.equal(done.attrs.failed, true);
    assert.match(String(done.attrs.error), /整理の失敗/);
    const row = JSON.parse(readFileSync(join(state, 'outbox.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(row.error, undefined, 'the plan\'s failure is not the delivery\'s error');
  } finally { setAgentRunner(null); }
});

test('a plan run that cannot start is recorded and the instruction goes out without a plan (AC-011)', async () => {
  setup([], { fixPlan: true, noBase: true });
  await fixEnvelope();
  const f = planRunner({ planPath: '/nope' });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.start.length, 0, 'no run is started when the input cannot be built');
    assert.equal(f.calls.deliver.length, 1, 'the instruction goes out without a plan');
    assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
    const done = readLifecycle().filter((e) => e.event === 'fix_plan_done').pop();
    assert.equal(done.attrs.failed, true);
    assert.ok(String(done.attrs.error).includes('差分'));
  } finally { setAgentRunner(null); }
});

test('a delivery that fails after a finished plan re-delivers the same plan and starts no second run (AC-012)', async () => {
  const { state } = setup([], { fixPlan: true });
  const planPath = join(state, 'p.md');
  writeFileSync(planPath, '案\n');
  await fixEnvelope();
  const f = planRunner({ planPath });
  let failSpawn = false;
  const base = f.runner.spawn;
  f.runner.spawn = async (o) => { if (failSpawn) throw new Error('spawn boom'); return base(o); };
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    f.states.set('R1', 'done');
    failSpawn = true;
    await deliverPending();
    assert.equal(f.calls.deliver.length, 0, 'the handover failed');
    assert.equal(pendingEnvelopes().length, 1);
    failSpawn = false;
    await deliverPending();
    assert.equal(f.calls.start.length, 1, 'the plan is not started a second time');
    assert.equal(f.calls.deliver.length, 1);
    assert.match(f.calls.deliver[0].text, /<fix-plan>/);
    assert.equal(pendingEnvelopes().length, 0);
  } finally { setAgentRunner(null); }
});

test('a config without the plan slot delivers as before and starts nothing (AC-015)', async () => {
  setup();
  await fixEnvelope();
  const f = planRunner({ planPath: '/nope' });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.start.length, 0);
    assert.equal(f.calls.deliver.length, 1, 'the fix goes straight to the new session');
    assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
  } finally { setAgentRunner(null); }
});

test('the plan slot holds every lane to its concurrency: the extra instruction waits for the next tick (AC-019)', async () => {
  const { state, wt } = setup([], { fixPlan: true });
  const wt2 = join(state, 'wt2');
  mkdirSync(wt2, { recursive: true });
  gitIn(wt2, 'init', '-q');
  writeFileSync(join(wt2, 'a.ts'), 'export const a = 1;\n');
  gitIn(wt2, 'add', '-A');
  gitIn(wt2, 'commit', '-q', '-m', 'base');
  const head2 = gitIn(wt2, 'rev-parse', 'HEAD');
  const row = (id) => JSON.stringify({ idd_id: id, area: 'me/app', title: id, context: '', source_type: 'github', gh_issue_url: `https://github.com/me/app/issues/1` });
  writeFileSync(join(state, 'backlog.jsonl'), row('IDD-1') + '\n' + row('IDD-2') + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), [
    JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'E1', worktree_path: wt, branch: 'idd/IDD-1', harness: 'pi' }),
    JSON.stringify({ idd_id: 'IDD-2', executor_session_id: 'E2', worktree_path: wt2, branch: 'idd/IDD-2', harness: 'pi' }),
  ].join('\n') + '\n');
  appendFileSync(join(state, 'lifecycle-me-app.jsonl'), [
    JSON.stringify({ idd_id: 'IDD-2', event: 's1_go', at: new Date().toISOString(), attrs: {} }),
    JSON.stringify({ idd_id: 'IDD-2', event: 's2_start', at: new Date().toISOString(), attrs: { executor_session_id: 'E2', started_from_commit: head2 } }),
  ].join('\n') + '\n');
  await fixEnvelope();
  await queueEnvelope('IDD-2', 'review_fix', reviewFixEnvelope('IDD-2', 2, [{ ref: 'C-1', severity: 'must', claim: 'c', fix: 'f' }], undefined, 'review'));
  const f = planRunner({ planPath: join(state, 'p.md') });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.start.length, 1, 'only one plan runs at the slot\'s cap of 1');
    assert.equal(f.calls.deliver.length, 0, 'the second instruction waits, it is not delivered without a plan');
    assert.equal(pendingEnvelopes().length, 2);
    assert.equal(f.calls.start[0].iddId, 'IDD-1', 'the first queued lane gets the run');
    // the run finishes: the waiting instruction gets its own run on the next tick
    f.states.set('R1', 'done');
    await deliverPending();
    assert.equal(f.calls.start.length, 2, 'the waiting lane starts its plan once room frees');
    assert.equal(f.calls.deliver.length, 1, 'the first lane is delivered');
    assert.equal(pendingEnvelopes().length, 1);
    f.states.set('R2', 'done');
    await deliverPending();
    assert.equal(f.calls.deliver.length, 2);
    assert.equal(pendingEnvelopes().length, 0);
  } finally { setAgentRunner(null); }
});

test('an instruction that cannot be delivered is skipped and a bad input does not stop the pass (AC-020)', async () => {
  const { state } = setup([], { fixPlan: true, noBase: true });
  await fixEnvelope();
  const f = planRunner({ planPath: '/nope' });
  setAgentRunner(f.runner);
  try {
    // the plan input cannot be built: recorded as failed, and the instruction still reaches the session
    const res = await deliverPending();
    assert.equal(res.delivered.length, 1);
    assert.equal(f.calls.deliver.length, 1);
    // a second lane with no executor session: skipped, nothing thrown, and the queue goes on
    writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n' + JSON.stringify({ ...rec, idd_id: 'IDD-9', title: 'no session' }) + '\n');
    appendFileSync(join(state, 'lifecycle-me-app.jsonl'), JSON.stringify({ idd_id: 'IDD-9', event: 's2_start', at: new Date().toISOString(), attrs: {} }) + '\n');
    await queueEnvelope('IDD-9', 'review_fix', reviewFixEnvelope('IDD-9', 2, [{ ref: 'C-1', severity: 'must', claim: 'c', fix: 'f' }], undefined, 'review'));
    const before = f.calls.start.length;
    const second = await deliverPending();
    assert.equal(f.calls.start.length, before, 'no plan is started for a lane with no executor session');
    assert.ok(second.skipped.some((s) => s.reason === 'no executor session for lane'));
  } finally { setAgentRunner(null); }
});

test('a plan status that cannot be read is a failed plan and never stops the pass (AC-020)', async () => {
  const { state } = setup([], { fixPlan: true });
  await fixEnvelope();
  const f = planRunner({ planPath: join(state, 'p.md') });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    assert.equal(f.calls.start.length, 1, 'the plan run is started');
    // the runtime can no longer answer for the run: the read throws, and the pass still goes on
    f.runner.reviewRunStatus = () => { throw new Error('status boom'); };
    const res = await deliverPending();
    assert.equal(res.delivered.length, 1, 'the instruction reaches the implementer');
    assert.equal(f.calls.deliver.length, 1, 'it goes out with no plan rather than waiting');
    assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
    assert.equal(pendingEnvelopes().length, 0);
    const done = readLifecycle().filter((e) => e.event === 'fix_plan_done').pop();
    assert.equal(done.attrs.failed, true, 'the unreadable run is recorded as a failed plan');
    assert.match(String(done.attrs.error), /状態を読めません/);
  } finally { setAgentRunner(null); }
});

test('the plan reads the instruction alone, never the implementer\'s own orders (AC-006, AC-021)', async () => {
  const cases = [
    {
      kind: 'review_fix',
      envelope: () => reviewFixEnvelope('IDD-1', 2, [{ ref: 'C-1', severity: 'must', claim: 'null で落ちる', fix: 'null でも落ちない' }], '人が書いた補足', 'review'),
      keeps: [/<item /, /C-1/, /<user-note>人が書いた補足<\/user-note>/],
    },
    {
      kind: 'lane_rejected',
      envelope: () => laneRejectedEnvelope('IDD-1', '型を揃える', false),
      keeps: [/<instruction>型を揃える<\/instruction>/],
    },
  ];
  for (const c of cases) {
    const { state } = setup([], { fixPlan: true });
    await queueEnvelope('IDD-1', c.kind, c.envelope());
    const f = planRunner({ planPath: join(state, 'p.md') });
    setAgentRunner(f.runner);
    try {
      await deliverPending();
      const file = f.calls.start[0].inputs.find((p) => p.endsWith('-instruction.md'));
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /commit す/, `${c.kind}: the implementer's order to commit is not the plan's`);
      assert.doesNotMatch(text, /report result/, `${c.kind}: the implementer's callback is not the plan's`);
      assert.doesNotMatch(text, /<propter-system-message>|<task>|<callback>/, `${c.kind}: the plan reads the instruction, not the envelope's frame`);
      for (const keep of c.keeps) assert.match(text, keep, `${c.kind}: what the envelope asks is read as written`);
    } finally { setAgentRunner(null); }
  }
});

test("the plan reads the fixes before the envelope, so its own fix is not among them (AC-025, AC-026)", async () => {
  const { state } = setup([], { fixPlan: true });
  const lifeFile = join(state, 'lifecycle-me-app.jsonl');
  const appendAt = (event, at, attrs) => appendFileSync(lifeFile, JSON.stringify({ idd_id: 'IDD-1', event, at, attrs }) + '\n');
  // a fix an earlier round sent, then the fix this envelope carries
  appendAt('s2_review_started', '2026-10-14T23:00:00+09:00', { kind: 'blind', round: 1, run_ids: ['b'] });
  appendAt('s2_triage_done', '2026-10-14T23:10:00+09:00', { kind: 'blind', round: 1, accepted: [{ ref: 'F-1', severity: 'must', claim: '前の巡の直し', path: 'a.ts', fix: 'f' }] });
  appendAt('s2_fix_sent', '2026-10-14T23:20:00+09:00', { round: 1, refs: ['F-1'] });
  appendAt('s2_triage_done', '2026-10-15T00:10:00+09:00', { kind: 'blind', round: 2, accepted: [{ ref: 'F-2', severity: 'must', claim: '封筒が運ぶ直し', path: 'b.ts', fix: 'g' }] });
  appendAt('s2_fix_sent', '2026-10-15T00:20:00+09:00', { round: 2, refs: ['F-2'] });
  await fixEnvelope();
  const f = planRunner({ planPath: join(state, 'plan.md') });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    const history = f.calls.start[0].inputs.find((p) => p.includes('history'));
    assert.ok(history, f.calls.start[0].inputs.join(', '));
    const text = readFileSync(history, 'utf8');
    assert.match(text, /前の巡の直し/, "an earlier round's fix is in the list");
    assert.doesNotMatch(text, /封筒が運ぶ直し/, 'the fix this envelope carries is not');
    assert.match(text, /^# 前の巡までに修正に回した指摘と penne の決定/, "the heading is the planner's");
    assert.doesNotMatch(text, /reverts/, "the judgement's instruction is not written to the planner");
  } finally { setAgentRunner(null); }
});

test("a v2 lane's plan run reads the drawn Choices, the qa and the state norms (AC-027)", async () => {
  const { state } = setup([], { fixPlan: true });
  appendFileSync(join(state, 'lifecycle-me-app.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 's1_ready', at: '2026-10-15T00:00:00Z', attrs: { records_shape: 'state' } }) + '\n');
  const raised = { event: 'choice_raised', at: '2026-10-15T00:01:00Z', repo: 'me/app', by: { lane: 'IDD-1' }, id: 'C-1-1', purpose: 'P-1' };
  const body = { forms: { chosen: 'lane の形', rejected: [] }, place: [{ path: 'a.ts', kind: 'file' }], why: 'w', anchored: 'a', revisit: 'follow-up Issue #999', status: 'active' };
  writeFileSync(join(state, `intent-${encodeURIComponent('me/app')}.jsonl`), JSON.stringify({ ...raised, ...body }) + '\n');
  await fixEnvelope();
  const f = planRunner({ planPath: join(state, 'plan.md') });
  setAgentRunner(f.runner);
  try {
    await deliverPending();
    const o = f.calls.start[0];
    const choices = o.inputs.find((p) => p.includes('lane-choices'));
    assert.ok(choices, o.inputs.join(', '));
    assert.match(readFileSync(choices, 'utf8'), /lane の形/);
    // the follow-up Issue a stopgap's revisit points at reaches the judgement through the same file
    assert.match(readFileSync(choices, 'utf8'), /- revisit: follow-up Issue #999/);
    assert.ok(o.inputs.some((p) => p.endsWith('/qa.md')), 'the qa is an input');
    assert.ok(!o.inputs.some((p) => p.endsWith('/decision.md')), 'decision.md is not');
    assert.equal(o.recordsShape, 'state');
    assert.ok(o.norms.some((n) => n.includes('Choice')), o.norms.join('\n'));
    setAgentRunner(null);
  } finally { setAgentRunner(null); }
});

test("a send-back that says it is work beyond the lane says so to the plan too (AC-028)", async () => {
  for (const [beyond, marker] of [[true, true], [false, false]]) {
    const { state } = setup([], { fixPlan: true });
    await queueEnvelope('IDD-1', 'lane_rejected', laneRejectedEnvelope('IDD-1', '型を揃える', beyond));
    const f = planRunner({ planPath: join(state, 'plan.md') });
    setAgentRunner(f.runner);
    try {
      await deliverPending();
      const file = f.calls.start[0].inputs.find((p) => p.endsWith('-instruction.md'));
      const text = readFileSync(file, 'utf8');
      assert.equal(/lane の範囲を超える追加の作業/.test(text), marker, `beyond=${beyond}`);
      if (marker) assert.match(text, /契約（Choice か AC）に足してから直す/);
      // the implementer's own orders are never the plan's
      assert.doesNotMatch(text, /commit す/);
      assert.doesNotMatch(text, /report result/);
      setAgentRunner(null);
    } finally { setAgentRunner(null); }
  }
});

test("a plan run whose start cannot be recorded is stopped, and the instruction goes out without a plan (AC-029)", async () => {
  const { state } = setup([], { fixPlan: true });
  await fixEnvelope();
  const f = planRunner({ planPath: join(state, 'plan.md') });
  const stopped = [];
  f.runner.stopRun = async (id) => { stopped.push(id); };
  setAgentRunner(f.runner);
  const lifeFile = join(state, 'lifecycle-me-app.jsonl');
  chmodSync(lifeFile, 0o444);
  try {
    await deliverPending();
    assert.deepEqual(stopped, ['R1'], 'the started run is stopped');
    assert.equal(f.calls.deliver.length, 1, 'the instruction goes out without a plan');
    assert.doesNotMatch(f.calls.deliver[0].text, /<fix-plan>/);
  } finally {
    chmodSync(lifeFile, 0o644);
    setAgentRunner(null);
  }
});

test("AC-035: the additional-work envelope says the contract in the record's own words, not decision.md", () => {
  const envelope = laneRejectedEnvelope('IDD-1', '型を揃える', true);
  assert.match(envelope, /今の lane の範囲を超える追加の作業/);
  assert.match(envelope, /契約に足りない判断/);
  assert.match(envelope, /Choice か DEC/);
  assert.match(envelope, /契約（lane の記録の形に合わせて Choice か DEC と、AC）に足してから実装する/);
  assert.doesNotMatch(envelope, /decision\.md/);
  // a send-back that is not additional work carries no such line
  assert.doesNotMatch(laneRejectedEnvelope('IDD-1', '型を揃える', false), /追加の作業/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { humanLines, runReviewLoop, triageHistory } from '../src/plan/review-loop.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { reviewLoopState } from '../src/ledger/review-loop.ts';
import { tmpDir } from './helpers/tmp.mjs';

// What penne decided on a stuck card, in the answer's structured fields, reaches every later round's spec check.
//
// The rows are IDD-290's own (APP-2251 bench run3), cut just before round 4 started. On round 3's card penne went on
// and put 3-blind/F-4 off with a reason (the trigger asked for is outside what Q-290-retry answered). Round 4's and
// round 5's spec checks asked for the same retry on a page closing again: their brief had no line at all, and only the
// judgement's history carried the correction. The free note of the answer stays an instruction to the executor and is
// handed to no later reader (cadf31509). The blind is not handed any of this: it reads the diff, the rules and the
// overview only (DEC-113-5); the judgement keeps the line for it. A plan written again starts with no old line.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROWS = readFileSync(join(HERE, 'fixtures', 'review-human-lines', 'idd-290-to-round-4.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const ROUND3_NOTE = 'ページが閉じたことはきっかけにしない';
const ROUND2_NOTE = '計画の C-290-1 がすでに選んでいる';
const PUT_OFF_CLAIM = '別ページが閉じて割り込み可能になっても';
const CORRECTION_REASON = '答えた範囲（Q-290-retry: 起動・復帰・画面の入口）の外のきっかけを求めているため。';

test('the rows are the lane as it stood before round 4: the next step is round 4\'s blind', () => {
  const st = reviewLoopState(ROWS);
  assert.equal(st.state, 'start_blind');
  assert.equal(st.round, 4);
});

test('the judgement of the later rounds reads the correction as it did, and no note of the cards', () => {
  const history = triageHistory(ROWS);
  assert.ok(history);
  assert.match(history, /## penne の訂正\n\n- 3-blind\/F-4（should、見送る）/);
  assert.ok(history.includes(CORRECTION_REASON));
  for (const note of [ROUND3_NOTE, ROUND2_NOTE]) assert.ok(!history.includes(note), note);
  assert.doesNotMatch(history, /一言/);
  // byte for byte the history the real round 4's judgement was handed
  assert.equal(history, readFileSync(join(HERE, 'fixtures', 'review-human-lines', 'triage-history-4-blind.md'), 'utf8'));
});

test('the spec check is handed penne\'s lines: the findings put off or skipped, with their claim and reason, and no note and no other earlier finding', () => {
  const lines = humanLines(ROWS);
  assert.ok(lines);
  assert.match(lines, /3-blind\/F-4（should、見送る）/);
  assert.ok(lines.includes(PUT_OFF_CLAIM), 'the claim penne put off goes with its ref');
  assert.ok(lines.includes(CORRECTION_REASON));
  // the free notes stay with the executor they were written to (cadf31509)
  for (const note of [ROUND3_NOTE, ROUND2_NOTE]) assert.ok(!lines.includes(note), note);
  // the findings an earlier round sent to the fix are not penne's lines: the spec check is still not told them (C-223-2)
  for (const ref of ['1-blind/F-1', '1-blind/F-2', '1-blind/F-4', '2-blind/F-1', '2-blind/F-2']) assert.ok(!lines.includes(ref), ref);
});

test('a correction that sends a finding to the fix draws no line; a lane penne never answered has none', () => {
  const answer = ROWS.findLastIndex((e) => e.event === 's2_review_resumed');
  const toFix = ROWS.map((e, i) => (i === answer
    ? { ...e, attrs: { ...e.attrs, corrections: e.attrs.corrections.map((c) => ({ ...c, action: 'fix' })) } }
    : e));
  const lines = humanLines(toFix) ?? '';
  assert.ok(!lines.includes('3-blind/F-4'), lines);
  const firstStop = ROWS.findIndex((e) => e.event === 's2_review_escalated');
  assert.equal(humanLines(ROWS.slice(0, firstStop)), null);
});

// ---- through the real loop: the round after the answer starts its spec check with the lines among its inputs

const AREA = 'o/Demo';

function setup(extra = []) {
  const state = tmpDir('idd-human-lines-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), [
    'roles:',
    '  v: { model: x/v, report: review }',
    '  o: { model: x/o, report: review }',
    '  h: { model: x/h, report: review }',
    '  s: { model: x/s, report: review }',
    '  j: { model: x/j, report: triage }',
    'pipeline:',
    '  review_blind: { roles: [v, o], high_risk_extra: [h], high_risk_when: last }',
    '  spec_check: { role: s }',
    '  triage: { role: j }',
  ].join('\n') + '\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { [AREA]: { upstream: join(state, 'u'), work: join(state, 'w') } } }));
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  const wt = tmpDir('idd-human-lines-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'a@b']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'a']);
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'init']);
  const base = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'work']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-290', parent_id: null, created_at: '2026-11-12T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: AREA }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-290', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  // the lane's own rows, with the revs of this worktree in place of the lane's
  const revs = { '477f29289da7048494896f07aef9b7d3e6549e20': base };
  const rows = ROWS.map((e) => {
    const text = JSON.stringify(e).replaceAll('/home/penne/dev/00_meltly/work/wt/flutter/IDD-290', wt);
    const swapped = Object.entries(revs).reduce((t, [from, to]) => t.replaceAll(from, to), text);
    return JSON.parse(swapped);
  });
  // the executor's last head moved, so round 4 reads a head of its own
  rows.at(-1).attrs.head = head;
  for (const [event, attrs] of extra) rows.push({ event, idd_id: 'IDD-290', at: '2026-11-13T01:00:00+09:00', attrs: typeof attrs === 'function' ? attrs({ base, head }) : attrs });
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), rows.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

function runner() {
  const calls = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    startReviewRun: async (o) => {
      calls.push(o);
      const ids = Array.from({ length: o.roleCount ?? 1 }, (_, i) => `${o.stage}-${i}`);
      const labels = ids.map(() => '');
      if (o.spec) for (let i = 0; i < o.spec.count; i += 1) { ids.push(`${o.stage}-spec${i}`); labels.push('spec'); }
      for (const id of ids) status[id] = { state: 'running' };
      return { runIds: ids, runRoles: ids.map((id) => (id.includes('spec') ? 's' : 'v')), runLabels: labels };
    },
    reviewRunStatus: (id) => status[id] ?? { state: 'running' },
  });
  calls.done = (id) => { status[id] = { state: 'done', reportJson: `/${id}.json`, reportMd: `/${id}.md`, findings: [] }; };
  return calls;
}

test('round 4 of the real lane starts its spec check with penne\'s lines among its inputs, and its blinds with none', async () => {
  setup();
  const calls = runner();
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_started');
  const start = calls.find((c) => c.stage === 'blind');
  assert.ok(start?.spec, 'the round starts its spec check');
  const file = start.spec.inputs.find((p) => /human-lines-4-blind\.md$/.test(p));
  assert.ok(file, start.spec.inputs.join('\n'));
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(PUT_OFF_CLAIM));
  assert.ok(text.includes(CORRECTION_REASON));
  assert.ok(!text.includes(ROUND3_NOTE));
  // the blinds read what the round shows them: no human line among their inputs (DEC-113-5)
  assert.ok(!(start.inputs ?? []).some((p) => /human-lines/.test(p)), (start.inputs ?? []).join('\n'));
});

// ---- a plan written again: the lines drawn on the plan it replaced bind none of its rounds

/** the rows after round 3's answer, the lane sent back to its plan, planned and implemented again */
const REPLANNED = [
  ['s1_replan_requested', { rounds: 3, at_by: 'user' }],
  ['s1_ready', { depth: 'standard', records_shape: 'state' }],
  ['s1_go', { at_by: 'user' }],
  ['s2_start', ({ base }) => ({ executor_session_id: 'E2', started_from_commit: base })],
  ['s2_result', { outcome: 'success' }],
];
const rowsOf = (extra) => [...ROWS, ...extra.map(([event, attrs]) => ({ event, idd_id: 'IDD-290', at: '2026-11-13T01:00:00+09:00', attrs: typeof attrs === 'function' ? attrs({ base: 'b' }) : attrs }))];

test('after a return to the plan, neither the spec check\'s lines nor the judgement\'s history carries penne\'s old line (P0)', () => {
  const rows = rowsOf(REPLANNED.slice(0, 1));
  assert.equal(humanLines(rows), null);
  const history = triageHistory(rows) ?? '';
  assert.doesNotMatch(history, /## penne の訂正|## penne の決定/);
  assert.ok(!history.includes(PUT_OFF_CLAIM));
  // the same holds for the fix planner's copy of the history
  assert.ok(!(triageHistory(rows, 'fix_plan') ?? '').includes(PUT_OFF_CLAIM));
});

test('through the real loop, the first round of the plan written again hands the old line to no spec check and no judgement (P0)', async () => {
  setup(REPLANNED);
  const calls = runner();
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_review_started');
  const start = calls.find((c) => c.stage === 'blind');
  assert.equal(start.round, 1, 'the plan written again starts its rounds from 1');
  assert.ok(start.spec, 'the round starts its spec check');
  assert.ok(!start.spec.inputs.some((p) => /human-lines/.test(p)), start.spec.inputs.join('\n'));
  // the round's reports come in and its judgement starts
  for (const id of readLifecycle().filter((e) => e.event === 's2_review_started').at(-1).attrs.run_ids) calls.done(id);
  await runReviewLoop();
  await runReviewLoop();
  assert.equal(readLifecycle().at(-1).event, 's2_triage_started');
  const triage = calls.find((c) => c.stage === 'triage');
  const historyFile = triage.inputs.find((p) => /triage-history-/.test(p));
  const history = historyFile ? readFileSync(historyFile, 'utf8') : '';
  assert.doesNotMatch(history, /## penne の訂正|## penne の決定/);
  assert.ok(!history.includes(PUT_OFF_CLAIM));
});

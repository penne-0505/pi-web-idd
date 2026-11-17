import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { laneMissingMeans, runReviewLoop, writeMissingMeansFile } from '../src/plan/review-loop.ts';
import { parseMissingMeansMarkers } from '../src/config/pipeline.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { tmpDir } from './helpers/tmp.mjs';

const ev = (event, attrs = {}) => ({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs });

/** a lane whose first review can start: a backlog row, an executor session and a git worktree at the review base */
function setup(pipelineYaml) {
  const state = tmpDir('idd-means-loop-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${pipelineYaml}`);
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const wt = tmpDir('idd-means-wt-');
  execFileSync('git', ['init', '-q', wt]);
  execFileSync('git', ['-C', wt, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', parent_id: null, created_at: '2026-09-23T09:00:00+09:00', linear_issue_url: null, gh_issue_url: 'https://github.com/o/r/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'Demo' }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', executor_session_id: 'E1', worktree_path: wt }) + '\n');
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), [ev('s1_go'), ev('s2_start', { started_from_commit: head }), ev('s2_result', { outcome: 'success' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

const FIND = { run: 'blind-1', role: 'blind-reviewer', call: 'c1', path: 'compare/a.png', marker: 'image', tool: 'read', note: 'does not support images' };

test('parseMissingMeansMarkers keeps only marks bound to a tool and a result shape', () => {
  const marks = parseMissingMeansMarkers(`
pipeline:
  missing_means:
    markers:
      - id: no-terminal
        tool: bash
        prefix: "bash: "
        note: "command not found"
      - tool: read
        prefix: "Read image file ["
      - tool: bash
      - prefix: "no tool"
      - "not an object"
      - id: named
        tool: bash
        prefix: "x"
`);
  assert.deepEqual(marks, [
    { id: 'no-terminal', tool: 'bash', prefix: 'bash: ', note: 'command not found' },
    { id: 'marker-2', tool: 'read', prefix: 'Read image file [' },
    { id: 'named', tool: 'bash', prefix: 'x' },
  ]);
  assert.deepEqual(parseMissingMeansMarkers('pipeline: {}\n'), []);
  assert.deepEqual(parseMissingMeansMarkers(''), []);
});

test('a detection already handed to a judgement is not handed over again', () => {
  const state = tmpDir('idd-means-dedupe-');
  process.env.IDD_STATE_DIR = state;
  const past = { ...FIND, call: 'c0' };
  const events = [
    ev('s2_review_started', { run_ids: ['blind-1'] }),
    ev('s2_triage_started', { run_id: 'triage-1', missing_means: [past] }),
  ];
  const seen = [];
  setAgentRunner({
    deliver: async () => {},
    missingMeans: (opts) => { seen.push(opts); return [past, FIND]; },
  });
  const found = laneMissingMeans({ idd_id: 'IDD-001', area: 'Demo' }, events);
  assert.deepEqual(found, [FIND]);
  assert.ok(seen[0].ids.includes('blind-1'), 'the round\'s runs are read');
  setAgentRunner(null);
});

test('the configured marks are read from roles.yaml and handed to the record reader', () => {
  const state = tmpDir('idd-means-config-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  missing_means:\n    markers:\n      - id: no-terminal\n        tool: bash\n        prefix: "bash: "\n      - tool: bash\n`);
  const saved = process.env.IDD_ROLES_FILE;
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const seen = [];
  setAgentRunner({ deliver: async () => {}, missingMeans: (opts) => { seen.push(opts); return []; } });
  try {
    laneMissingMeans({ idd_id: 'IDD-001', area: 'Demo' }, [ev('s2_review_started', { run_ids: ['blind-1'] })]);
    assert.deepEqual(seen[0].markers, [{ id: 'no-terminal', tool: 'bash', prefix: 'bash: ' }]);
  } finally {
    if (saved === undefined) delete process.env.IDD_ROLES_FILE;
    else process.env.IDD_ROLES_FILE = saved;
    setAgentRunner(null);
  }
});

test('a runtime that cannot read the records leaves the judgement without detections', () => {
  const state = tmpDir('idd-means-broken-');
  process.env.IDD_STATE_DIR = state;
  const events = [ev('s2_review_started', { run_ids: ['blind-1'] })];
  setAgentRunner({ deliver: async () => {}, missingMeans: () => { throw new Error('records unreadable'); } });
  assert.deepEqual(laneMissingMeans({ idd_id: 'IDD-001', area: 'Demo' }, events), []);
  setAgentRunner({ deliver: async () => {} });
  assert.deepEqual(laneMissingMeans({ idd_id: 'IDD-001', area: 'Demo' }, events), []);
  setAgentRunner(null);
});

test('the judgement input carries how to weigh a detection', () => {
  const state = tmpDir('idd-means-file-');
  process.env.IDD_STATE_DIR = state;
  const file = writeMissingMeansFile('IDD-001', 1, 'blind', [FIND]);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /未確認と書いている/);
  assert.match(text, /must にしない/);
  assert.match(text, /見た根拠として扱わない/);
  assert.match(text, /compare\/a\.png/);
  assert.equal(writeMissingMeansFile('IDD-001', 1, 'blind', []), undefined);
});

test('the detections reach the judgement once and are kept on its starting record', async () => {
  setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n');
  const inputs = {};
  const ids = [];
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    missingMeans: (opts) => { ids.push(opts.ids); return opts.ids.includes('blind-1') ? [FIND] : []; },
    startReviewRun: async (o) => {
      inputs[o.stage] = (inputs[o.stage] ?? []).concat(o.inputs);
      const runIds = o.stage === 'blind' ? ['blind-1'] : [`${o.stage}-1`];
      for (const id of runIds) status[id] = { state: 'running' };
      return { runIds };
    },
    reviewRunStatus: (id) => status[id],
  });
  try {
    await runReviewLoop();
    status['blind-1'] = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [{ severity: 'must', path: 'a.ts', claim: 'x', evidence: '' }] };
    await runReviewLoop();
    await runReviewLoop();
    const events = readLifecycle();
    const triage = events.filter((e) => e.event === 's2_triage_started').at(-1);
    assert.ok(triage, 'the judgement started');
    assert.deepEqual(triage.attrs.missing_means, [FIND]);
    const blindInput = (inputs.blind ?? []).join('|');
    assert.doesNotMatch(blindInput, /missing-means-/);
    const meansFile = (inputs.triage ?? []).find((p) => /missing-means-/.test(p));
    assert.ok(meansFile, 'the judgement was handed the detection file');
    assert.match(readFileSync(meansFile, 'utf8'), /見た根拠として扱わない/);
  } finally {
    setAgentRunner(null);
  }
});

test('an unreadable record does not keep the judgement from starting', async () => {
  setup('  review_blind: { roles: [r] }\n  triage: { role: r }\n');
  const status = {};
  const inputs = {};
  setAgentRunner({
    deliver: async () => {},
    missingMeans: () => { throw new Error('records unreadable'); },
    startReviewRun: async (o) => {
      inputs[o.stage] = (inputs[o.stage] ?? []).concat(o.inputs);
      const runIds = o.stage === 'blind' ? ['blind-1'] : [`${o.stage}-1`];
      for (const id of runIds) status[id] = { state: 'running' };
      return { runIds };
    },
    reviewRunStatus: (id) => status[id],
  });
  try {
    await runReviewLoop();
    status['blind-1'] = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [{ severity: 'must', path: 'a.ts', claim: 'x', evidence: '' }] };
    await runReviewLoop();
    await runReviewLoop();
    const triage = readLifecycle().filter((e) => e.event === 's2_triage_started').at(-1);
    assert.ok(triage, 'the judgement started without the detection');
    assert.equal(triage.attrs.missing_means, undefined);
    assert.equal((inputs.triage ?? []).some((p) => /missing-means-/.test(p)), false);
  } finally {
    setAgentRunner(null);
  }
});

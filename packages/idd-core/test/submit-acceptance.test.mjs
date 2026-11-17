import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { buildSubmit } from '../src/plan/ship.ts';

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, intent: process.env.IDD_INTENT_DIR };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', GIT_ALLOW_PROTOCOL: 'file' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
let root;

function setup() {
  root = scratchDir('submit-acceptance-');
  const work = join(root, 'work'), state = join(root, 'state'), lane = join(root, 'lanes', 'IDD-1');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main');
  put(join(work, 'app.txt'), 'one\n'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'chore: base');
  git(work, 'worktree', 'add', '-q', '-b', 'idd/idd-1', lane, 'main');
  put(join(lane, 'app.txt'), 'changed\n'); git(lane, 'add', '-A'); git(lane, 'commit', '-qm', 'feat: work');
  put(join(lane, '_docs', 'qa', 'demo', 'idd-1', 'qa.md'), ['---', 'title: qa', '---', '', '## Acceptance Criteria', '', '- AC-001: 一つ目', '- AC-002: 二つ目', ''].join('\n'));
  git(lane, 'add', '-A'); git(lane, 'commit', '-qm', 'docs: qa');
  const repos = join(root, 'repos.yaml');
  writeFileSync(repos, JSON.stringify({ repos: { demo: { publish: false, github: 'test/demo', upstream: join(root, 'up'), work, work_base: 'main', public_base: 'main', lanes_root: join(root, 'lanes') } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos, IDD_INTENT_DIR: join(root, 'unused-intent') });
  writeFileSync(join(state, 'backlog.jsonl'), jsonl([{ idd_id: 'IDD-1', parent_id: null, created_at: '2026-10-13T00:00:00Z', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'demo' }]));
  writeFileSync(join(state, 'executor-sessions.jsonl'), jsonl([{ idd_id: 'IDD-1', executor_session_id: 'E1', started_at: '2026-10-13T00:00:00Z', worktree_path: lane, branch: 'idd/idd-1' }]));
  return { work, state, lane, repos };
}

function setRows(state, items) {
  writeFileSync(join(state, 'work-demo.jsonl'), jsonl(items.map((it, i) => ({ event: 'ac_reported', at: `2026-10-13T0${i + 1}:00:00Z`, repo: 'demo', lane: 'IDD-1', source: 'result', items: [it] }))));
}

const confirmedCheck = () => buildSubmit('IDD-1').checks.find((c) => c.label === '満たすべき条件がすべて確認済み');

test.afterEach(() => {
  for (const [k, v] of [['IDD_STATE_DIR', saved.state], ['IDD_REPOS_FILE', saved.repos], ['IDD_INTENT_DIR', saved.intent]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (root) { rmSync(root, { recursive: true, force: true }); root = null; }
});

test('AC-009: the submit check is ok when every AC is verified with evidence', () => {
  const f = setup();
  setRows(f.state, [
    { id: 'AC-001', status: 'verified', evidence: 'ran it' },
    { id: 'AC-002', status: 'verified', evidence: 'ran it too' },
  ]);
  assert.equal(confirmedCheck().ok, true);
});

test('AC-009: a covered AC makes the check not ok', () => {
  const f = setup();
  setRows(f.state, [
    { id: 'AC-001', status: 'verified', evidence: 'ran it' },
    { id: 'AC-002', status: 'covered' },
  ]);
  assert.equal(confirmedCheck().ok, false);
});

test('AC-009: an evidence-less verified does not count, even when the older progress file said so', () => {
  const f = setup();
  // the old overwriting progress file would have made both look confirmed: it is no longer the source
  writeFileSync(join(f.state, 'executor-progress-IDD-1.json'), JSON.stringify({ idd_id: 'IDD-1', updated_at: '2026-10-13T00:00:00Z', current_step: '', qa_status: [{ qa_id: 'AC-001', status: 'verified' }, { qa_id: 'AC-002', status: 'verified' }], recent_activity: [] }));
  setRows(f.state, [
    { id: 'AC-001', status: 'verified', evidence: 'ran it' },
    { id: 'AC-002', status: 'covered' },
  ]);
  assert.equal(confirmedCheck().ok, false);
});

test('AC-009: a report naming only some ACs still leaves the others confirmed', () => {
  const f = setup();
  setRows(f.state, [
    { id: 'AC-001', status: 'verified', evidence: 'ran it' },
    { id: 'AC-001', status: 'planned' },
    { id: 'AC-002', status: 'verified', evidence: 'ran it too' },
  ]);
  assert.equal(confirmedCheck().ok, false, 'the later report withdrew AC-001');
  setRows(f.state, [
    { id: 'AC-001', status: 'verified', evidence: 'ran it' },
    { id: 'AC-002', status: 'verified', evidence: 'ran it too' },
    { id: 'AC-002', status: 'verified', evidence: 'again' },
  ]);
  assert.equal(confirmedCheck().ok, true, 'a later report naming a subset changes nothing else');
});

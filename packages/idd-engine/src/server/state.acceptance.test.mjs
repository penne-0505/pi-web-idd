import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import { scratchDir } from '../../../idd-core/test/helpers/scratch.mjs';
import { register } from 'node:module';
register('./idd-core-alias.loader.mjs', import.meta.url);

const { buildState, buildLaneDetail } = await import('./state.ts');

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', GIT_ALLOW_PROTOCOL: 'file' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const ev = (event, attrs = {}) => ({ idd_id: 'IDD-1', event, at: '2026-10-13T00:00:00Z', attrs });
let root;

afterEach(() => {
  for (const [k, v] of [['IDD_STATE_DIR', saved.state], ['IDD_REPOS_FILE', saved.repos]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (root) { rmSync(root, { recursive: true, force: true }); root = null; }
});

function setup(items) {
  root = scratchDir('state-acceptance-');
  const work = join(root, 'work'), state = join(root, 'state'), lane = join(root, 'lanes', 'IDD-1');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main');
  put(join(work, 'app.txt'), 'one\n'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'chore: base');
  const start = git(work, 'rev-parse', 'HEAD');
  git(work, 'worktree', 'add', '-q', '-b', 'idd/idd-1', lane, 'main');
  put(join(lane, 'app.txt'), 'changed\n'); git(lane, 'add', '-A'); git(lane, 'commit', '-qm', 'feat: work');
  put(join(lane, '_docs', 'qa', 'demo', 'idd-1', 'qa.md'), ['---', 'title: qa', '---', '', '## Acceptance Criteria', '', '- AC-001: 一つ目', '- AC-002: 二つ目', ''].join('\n'));
  git(lane, 'add', '-A'); git(lane, 'commit', '-qm', 'docs: qa');
  const repos = join(root, 'repos.yaml');
  writeFileSync(repos, JSON.stringify({ repos: { demo: { publish: false, github: 'test/demo', upstream: join(root, 'up'), work, work_base: 'main', public_base: 'main', lanes_root: join(root, 'lanes') } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  writeFileSync(join(state, 'backlog.jsonl'), jsonl([{ idd_id: 'IDD-1', parent_id: null, created_at: '2026-10-13T00:00:00Z', linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: 'github', context: '', title: 'T', area: 'demo' }]));
  writeFileSync(join(state, 'executor-sessions.jsonl'), jsonl([{ idd_id: 'IDD-1', executor_session_id: 'E1', started_at: '2026-10-13T00:00:00Z', worktree_path: lane, branch: 'idd/idd-1' }]));
  writeFileSync(join(state, 'lifecycle-demo.jsonl'), jsonl([
    ev('lane_open'), ev('s1_ready'), ev('s1_go'), ev('s2_start', { started_from_commit: start }), ev('s2_done'), ev('s3_ready'),
  ]));
  writeFileSync(join(state, 'work-demo.jsonl'), jsonl(items.map((it, i) => ({ event: 'ac_reported', at: `2026-10-13T0${i + 1}:00:00Z`, repo: 'demo', lane: 'IDD-1', source: 'result', items: [it] }))));
  return { state, lane };
}

test('AC-010: the review card and the lane detail report the same criteria states', async () => {
  const f = setup([
    { id: 'AC-001', status: 'verified', evidence: 'ran it' },
    { id: 'AC-002', status: 'covered' },
  ]);
  const state = buildState({ now: new Date('2026-10-13T10:00:00Z') });
  const card = state.items.find((i) => i.iddId === 'IDD-1' && i.kind === 'review');
  assert.ok(card, 'the lane is at the review card');
  const detail = await buildLaneDetail('IDD-1');
  assert.ok(detail, 'the lane is listed');
  assert.deepEqual(card.criteria, detail.contract.criteria);
  assert.deepEqual(card.criteria.map((c) => c.state), ['done', 'doing']);
});

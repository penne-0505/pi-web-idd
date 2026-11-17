import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, it } from 'node:test';

import { scratchDir } from '../../../idd-core/test/helpers/scratch.mjs';
register('./idd-core-alias.loader.mjs', import.meta.url);

const { buildState } = await import('./state.ts');
const { saveLandForecast, pairKey } = await import('../../../idd-core/src/overlay/land.ts');

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const ev = (iddId, event, attrs = {}) => ({ idd_id: iddId, event, at: '2026-09-25T00:00:00Z', attrs });
let root;

afterEach(() => {
  for (const [k, v] of [['IDD_STATE_DIR', saved.state], ['IDD_REPOS_FILE', saved.repos]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** two lanes of one work clone, each with a landing card, and a saved forecast that pairs them */
function twoCards() {
  root = scratchDir('state-forecast-');
  const work = join(root, 'work');
  const state = join(root, 'state');
  const lanes = { 'IDD-1': join(root, 'lanes', 'IDD-1'), 'IDD-2': join(root, 'lanes', 'IDD-2') };
  mkdirSync(work);
  mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=work-main');
  put(join(work, 'app.txt'), 'one\n');
  put(join(work, 'other.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'base');
  for (const [id, path] of Object.entries(lanes)) {
    git(work, 'worktree', 'add', '-q', '-b', `idd/${id}`, path, 'work-main');
    put(join(path, 'app.txt'), `from ${id}\n`);
    git(path, 'add', '.');
    git(path, 'commit', '-qm', `feat: ${id}`);
  }
  const repos = join(root, 'repos.yaml');
  put(repos, JSON.stringify({ repos: { Demo: { github: 'test/project', upstream: join(root, 'upstream'), work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), publish: false } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  const backlog = Object.keys(lanes).map((id) => ({ idd_id: id, parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: `https://github.com/o/r/issues/${id.slice(-1)}`, pull_req_url: null, source_type: 'github', context: '', title: `T ${id}`, area: 'Demo' }));
  writeFileSync(join(state, 'backlog.jsonl'), jsonl(backlog));
  writeFileSync(join(state, 'executor-sessions.jsonl'), jsonl(Object.entries(lanes).map(([id, path]) => ({ idd_id: id, executor_session_id: `E-${id}`, started_at: '2026-09-25T00:00:00Z', worktree_path: path, branch: `idd/${id}` }))));
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), jsonl(Object.keys(lanes).flatMap((id) => [
    ev(id, 'lane_open'), ev(id, 's2_start'), ev(id, 's2_result'), ev(id, 's3_ready'), ev(id, 's3_ok'), ev(id, 's4_submit_started'),
  ])));
  const heads = Object.fromEntries(Object.entries(lanes).map(([id, path]) => [id, git(path, 'rev-parse', 'HEAD')]));
  const mainTip = git(work, 'rev-parse', 'refs/heads/work-main');
  saveLandForecast({
    repo: work, workBase: 'work-main', mainTip,
    heads,
    files: { 'IDD-1': ['app.txt'], 'IDD-2': ['app.txt'] },
    mainline: { 'IDD-1': { conflict: false, files: [] }, 'IDD-2': { conflict: false, files: [] } },
    pairs: { [pairKey('IDD-1', 'IDD-2')]: { conflict: true, files: ['app.txt'] } },
  });
  return { work, lanes };
}

it('the ship card carries the saved conflict forecast of its lane', () => {
  const f = twoCards();
  const item = buildState().items.find((i) => i.kind === 'ship' && i.iddId === 'IDD-1');
  assert.ok(item, 'the card is in the inbox');
  assert.deepEqual(item.conflictForecast.others, [{ lane: 'IDD-2', conflict: true, files: ['app.txt'] }]);
  assert.deepEqual(item.conflictForecast.mainline, { conflict: false, files: [] });
  // the second card is paired the other way
  const other = buildState().items.find((i) => i.kind === 'ship' && i.iddId === 'IDD-2');
  assert.deepEqual(other.conflictForecast.others, [{ lane: 'IDD-1', conflict: true, files: ['app.txt'] }]);
});

it('a forecast the mainline has moved past is not shown', async () => {
  const f = twoCards();
  assert.ok(buildState().items.find((i) => i.kind === 'ship' && i.iddId === 'IDD-1')?.conflictForecast);
  put(join(f.work, 'main.txt'), 'main\n');
  git(f.work, 'add', '.');
  git(f.work, 'commit', '-qm', 'mainline move');
  const item = buildState().items.find((i) => i.kind === 'ship' && i.iddId === 'IDD-1');
  assert.equal(item.conflictForecast, undefined);
});

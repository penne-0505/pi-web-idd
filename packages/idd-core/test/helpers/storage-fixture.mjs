import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpDir } from './tmp.mjs';

/**
 * A state directory for the storage tests. Every test builds its own, sets IDD_STATE_DIR and IDD_REPOS_FILE, and
 * never reads the real state. The repos file is written as JSON (valid YAML) so a test can hand in a storage
 * section and repo declarations without quoting YAML.
 */
export function storageState() {
  const state = tmpDir('idd-storage-');
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: {} }));
  return state;
}

export function writeRepos(state, { storage, repos = {} } = {}) {
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ ...(storage ? { storage } : {}), repos }));
  return join(state, 'repos.yaml');
}

/** a lifecycle file for one area */
export function writeLifecycle(state, area, events) {
  writeFileSync(join(state, `lifecycle-${area}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

export function backlog(state, rows) {
  writeFileSync(join(state, 'backlog.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

export function sessions(state, kind, rows) {
  writeFileSync(join(state, `${kind}-sessions.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

/** a bare git repo with one commit, and a lane worktree beside it */
export function gitRepo(prefix = 'idd-storage-repo-') {
  const root = tmpDir(prefix);
  const clone = join(root, 'clone');
  mkdirSync(clone, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', clone, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(clone, 'app.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const lanes = join(root, 'clone-lanes');
  mkdirSync(lanes, { recursive: true });
  const worktree = join(lanes, 'IDD-1');
  g('worktree', 'add', '-q', '-b', 'idd/idd-1', worktree);
  return { root, clone, lanes, worktree, git: g };
}

export function writeLaneJson(state, runId, extra = {}) {
  const dir = join(state, 'lanes', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lane.json'), JSON.stringify({ id: runId, status: 'done', started_at: '2026-09-01T00:00:00+09:00', ended_at: '2026-09-02T00:00:00+09:00', ...extra }));
  return dir;
}

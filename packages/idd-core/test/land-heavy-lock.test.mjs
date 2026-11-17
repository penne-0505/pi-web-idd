import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runLandCheck } from '../src/overlay/land-check.ts';
import { readLandRun, saveLandRun } from '../src/overlay/land-run.ts';
import { heavyLockHeld, takeHeavyLock } from '../src/overlay/heavy-lock.ts';
import { checksRunning } from '../src/overlay/git.ts';

// A landing's check (one lane's, or a batch's: both run as a land run) holds the repo's heavy-checks lock for its whole
// life, taken inside the overlay lock it cuts its copy under, so it never runs beside the checks before an S2 loop
// converges (which hold the heavy lock alone).

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let serial = 0;

function fixture(log, apart = true) {
  const root = scratchDir('land-heavy-');
  const repo = join(root, 'repo');
  mkdirSync(join(root, 'state'));
  mkdirSync(repo);
  sh(repo, 'init', '--initial-branch=main');
  sh(repo, 'config', 'user.email', 'a@b'); sh(repo, 'config', 'user.name', 'a');
  writeFileSync(join(repo, 'app.txt'), 'one\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-m', 'main');
  const mainTip = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'checkout', '-q', '-b', 'idd/IDD-1');
  writeFileSync(join(repo, 'app.txt'), 'two\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-m', 'lane');
  const head = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'checkout', '-q', 'main');
  sh(repo, 'merge', '--no-ff', 'idd/IDD-1', '-m', 'Merge lane');
  const registry = { name: 'demo', upstream: join(root, 'upstream'), work: repo, public_base: 'main', work_base: 'main', remote: 'origin', checks: [], ...(apart ? { checks_before_converge: true } : {}) };
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'demo/demo': registry } }));
  writeFileSync(join(root, 'roles.yaml'), 'pipeline:\n');
  Object.assign(process.env, { IDD_STATE_DIR: join(root, 'state'), IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'intent') });
  const checks = [{ name: 'suite', command: ['bash', '-c', `[ -d "$(git rev-parse --git-common-dir)/idd-heavy-checks.lock" ] && echo HEAVY >> ${JSON.stringify(log)}; true`], required: true, scope: 'public' }];
  return { root, repo, mainTip, head, mergeCommit: sh(repo, 'rev-parse', 'HEAD'), checks };
}

async function land(f, spec = {}) {
  serial += 1;
  const runId = `run-${serial}`;
  const full = {
    runId, lane: 'IDD-1', repo: f.repo, area: 'demo/demo', checks: f.checks, changed: [], head: f.head, mainTip: f.mainTip,
    mergeCommit: f.mergeCommit, branch: 'idd/IDD-1', workBase: 'main', configKey: 'k', token: 't',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...spec,
  };
  writeFileSync(join(f.root, `${runId}.spec.json`), JSON.stringify(full));
  saveLandRun({ id: runId, lane: 'IDD-1', status: 'running', started_at: new Date().toISOString(), repo: f.repo, common: '', head: f.head, mainTip: f.mainTip, mergeCommit: f.mergeCommit, signed: false, spec: full, log: '' });
  await runLandCheck(join(f.root, `${runId}.spec.json`));
  return readLandRun('IDD-1');
}

for (const [name, spec] of [['a lane\'s landing check', {}], ['a batch\'s landing check', { batch: ['IDD-1', 'IDD-2'] }]]) {
  test(`${name} runs its checks under the heavy-checks lock and lets it go at the end`, async () => {
    const log = join(scratchDir('land-heavy-log-'), 'runs');
    const f = fixture(log);
    const run = await land(f, spec);
    assert.equal(run.status, 'done', JSON.stringify(run));
    assert.equal(readFileSync(log, 'utf8').trim(), 'HEAVY');
    assert.equal(heavyLockHeld(f.repo), false);
    assert.equal(checksRunning(f.repo), false);
  });

  test(`${name} does not run beside the checks before a convergence: it waits, and ends as a run that could not run past its limit`, async () => {
    const log = join(scratchDir('land-heavy-log-'), 'runs');
    const f = fixture(log);
    const release = takeHeavyLock(f.repo, 'converge-run');
    process.env.IDD_HEAVY_WAIT_MS = '200';
    try {
      const run = await land(f, spec);
      assert.equal(run.status, 'failed');
      assert.match(run.error, /重い検査の lock が空かない/);
      assert.equal(existsSync(log), false, 'no check ran');
      assert.equal(checksRunning(f.repo), false, 'the overlay lock is not kept while it waits');
    } finally { release(); delete process.env.IDD_HEAVY_WAIT_MS; }
  });
}

test('a landing check of a repo that runs no checks before a convergence takes no heavy-checks lock: landing checks still run side by side up to their limit (C-144)', async () => {
  const log = join(scratchDir('land-heavy-log-'), 'runs');
  const f = fixture(log, false);
  const release = takeHeavyLock(f.repo, 'someone');
  try {
    const run = await land(f);
    assert.equal(run.status, 'done', JSON.stringify(run));
    assert.equal(readFileSync(log, 'utf8').trim(), 'HEAVY', 'it ran beside the other holder, as before');
  } finally { release(); }
});

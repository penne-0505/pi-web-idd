import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runChecks } from '../src/overlay/gate.ts';
import { tmpDir } from './helpers/tmp.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** run `fn` with a stale IDD_RISK_PATHS in the engine's own environment, and put the caller's back after */
async function withStaleDeclaration(fn) {
  const saved = process.env.IDD_RISK_PATHS;
  process.env.IDD_RISK_PATHS = JSON.stringify({ auth: ['stale/'] });
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.IDD_RISK_PATHS;
    else process.env.IDD_RISK_PATHS = saved;
  }
}

test('runChecks hands no lane declaration to a repo check', async () => {
  const work = tmpDir('idd-risk-env-');
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'a.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  const seen = join(work, 'seen.txt');
  await withStaleDeclaration(async () => {
    const rows = await runChecks(work, [{ name: 'env', command: ['bash', '-c', `printf %s "\${IDD_RISK_PATHS-unset}" > ${seen}`], required: true }]);
    assert.equal(rows[0].status, 'pass');
    assert.equal(readFileSync(seen, 'utf8'), 'unset');
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { heavyLockHeld, heavyLockPath, heavyOwner, OWNERLESS_MS, sweepHeavyLock, takeHeavyLock } from '../src/overlay/heavy-lock.ts';
import { tmpDir } from './helpers/tmp.mjs';

// The repo's heavy-checks lock (the checks before the S2 loop converges hold it alone; the submit takes it inside the
// overlay lock). Whoever meets it sweeps it first, whatever the lanes' records say.

function repo() {
  const dir = tmpDir('idd-heavy-lock-');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
const deadPid = () => Number(execFileSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).trim());

test('one holder at a time: a second take is refused until the first lets it go, and the owner names its run', () => {
  const r = repo();
  const release = takeHeavyLock(r, 'R1');
  assert.ok(release);
  assert.equal(takeHeavyLock(r, 'R2'), null);
  assert.equal(heavyOwner(r)?.run, 'R1');
  assert.equal(heavyOwner(r)?.pid, process.pid);
  assert.equal(heavyLockHeld(r), true, 'a live holder is not swept');
  release();
  assert.equal(heavyLockHeld(r), false);
  assert.ok(takeHeavyLock(r, 'R2'));
});

test('a lock whose holder is gone (kill -0) is let go by whoever meets it', () => {
  const r = repo();
  const path = heavyLockPath(r);
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: deadPid(), run: 'gone', at: new Date().toISOString() }));
  assert.equal(heavyLockHeld(r), false);
  assert.equal(existsSync(path), false);
  // the taker sweeps too
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: deadPid(), run: 'gone', at: new Date().toISOString() }));
  assert.ok(takeHeavyLock(r, 'R3'));
});

test('a lock with no owner written is taken as being made for a while, then let go', () => {
  const r = repo();
  const path = heavyLockPath(r);
  mkdirSync(path);
  sweepHeavyLock(r);
  assert.equal(existsSync(path), true, 'a fresh lock without an owner stays');
  assert.equal(takeHeavyLock(r, 'R4'), null);
  const old = (Date.now() - OWNERLESS_MS - 60_000) / 1000;
  utimesSync(path, old, old);
  assert.equal(heavyLockHeld(r), false, 'one older than the grace is let go');
});

test('letting go never removes a lock a sweeper gave to another holder meanwhile', () => {
  const r = repo();
  const release = takeHeavyLock(r, 'R5');
  const path = heavyLockPath(r);
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, run: 'other', at: new Date().toISOString() }));
  release();
  assert.equal(existsSync(path), true);
});

test('two sweepers at once never remove a lock that was taken again between the reading and the move', () => {
  const r = repo();
  const path = heavyLockPath(r);
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: deadPid(), run: 'gone', at: new Date().toISOString() }));
  let fresh;
  sweepHeavyLock(r, {
    between: () => {
      // another sweeper removes the stale lock, and a taker makes it again
      sweepHeavyLock(r);
      fresh = takeHeavyLock(r, 'R-new');
    },
  });
  assert.ok(fresh);
  assert.equal(heavyOwner(r)?.run, 'R-new', 'the lock taken again is still there, with its owner');
  assert.equal(heavyLockHeld(r), true);
  fresh();
});

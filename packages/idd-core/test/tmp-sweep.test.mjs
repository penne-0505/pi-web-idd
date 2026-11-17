import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sweepStaleTmp } from '../src/plan/tmp-sweep.ts';
import { tmpDir } from './helpers/tmp.mjs';

test('the sweep removes only idd- entries older than a day, and leaves everything else', () => {
  const root = tmpDir('idd-sweep-');
  const old = join(root, 'idd-loop-old');
  const fresh = join(root, 'idd-loop-new');
  const foreign = join(root, 'other-old');
  for (const d of [old, fresh, foreign]) { mkdirSync(join(d, 'inner'), { recursive: true }); writeFileSync(join(d, 'inner', 'f'), 'x'); }
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(old, twoDaysAgo, twoDaysAgo);
  utimesSync(foreign, twoDaysAgo, twoDaysAgo);

  assert.deepEqual(sweepStaleTmp(root), [old]);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(foreign), true);
});

test('the sweep of a temp dir that cannot be read does nothing and does not throw', () => {
  assert.deepEqual(sweepStaleTmp(join(tmpDir('idd-sweep-none-'), 'missing')), []);
});

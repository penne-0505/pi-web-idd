import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assertConfigDir, shippedConfig, skipReason } from './helpers/shipped-config.mjs';
import { tmpDir } from './helpers/tmp.mjs';

test('the helper config dir is the checkout config dir', () => {
  assertConfigDir(resolve(shippedConfig('roles.example.yaml'), '..'));
});

test('a dir without roles.example.yaml is refused instead of read as a missing overlay file', () => {
  const dir = tmpDir('idd-shipped-empty-');
  assert.throws(() => assertConfigDir(dir), (e) => e.message.includes(dir) && e.message.includes('config dir'));
  assert.throws(() => skipReason(dir, ['roles.yaml']), /config dir/);
});

test('a stripped copy skips with the path it could not read, and an example file is not counted', () => {
  const dir = tmpDir('idd-shipped-stripped-');
  writeFileSync(join(dir, 'roles.example.yaml'), 'roles: {}\n');
  assert.equal(skipReason(dir, ['roles.yaml']), `${join(dir, 'roles.yaml')} を読めません`);
  assert.equal(skipReason(dir, ['roles.yaml', 'modes.yaml']), `${join(dir, 'roles.yaml')}, ${join(dir, 'modes.yaml')} を読めません`);
  assert.equal(skipReason(dir, ['modes.example.yaml']), false);
  writeFileSync(join(dir, 'roles.yaml'), 'roles: {}\n');
  assert.equal(skipReason(dir, ['roles.yaml']), false);
});

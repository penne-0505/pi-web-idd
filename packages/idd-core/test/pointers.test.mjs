import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

import { checkoutRoot } from '../src/config/files.ts';
import { stateDir } from '../src/paths.ts';
import { installedPointers, namedStateDir, resolvePiBin, resolveStateDir, settlePointers } from '../src/install/pointers.ts';
import { tmpDir } from './helpers/tmp.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const put = (p, body) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); return p; };

/** a machine whose install.json points at `checkout` with the given state and pi */
function machine(checkout, { state, pi } = {}) {
  const home = tmpDir('idd-pointers-home-');
  const body = { schema: 1, checkout, version: 'v0', installed_at: '', ...(state ? { state_dir: state } : {}), ...(pi ? { pi_bin: pi } : {}) };
  put(join(home, '.config', 'idd', 'install.json'), `${JSON.stringify(body, null, 2)}\n`);
  return home;
}

test('the resolver reads env first, then the record of this checkout, then the default', () => {
  const checkout = tmpDir('idd-pointers-checkout-');
  const home = machine(checkout, { state: '/rec/state', pi: '/rec/pi' });
  assert.deepEqual(installedPointers(checkout, { HOME: home }), { stateDir: '/rec/state', piBin: '/rec/pi' });
  assert.equal(resolveStateDir({ checkout, env: { HOME: home } }), '/rec/state');
  assert.equal(resolvePiBin({ checkout, env: { HOME: home } }), '/rec/pi');
  assert.equal(resolveStateDir({ checkout, env: { HOME: home, IDD_STATE_DIR: '/given/state' } }), '/given/state');
  assert.equal(resolvePiBin({ checkout, env: { HOME: home, IDD_PI_BIN: '/given/pi' } }), '/given/pi');
  // a record that names another checkout is not this one's
  const other = tmpDir('idd-pointers-other-');
  assert.deepEqual(installedPointers(other, { HOME: home }), {});
  assert.equal(resolveStateDir({ checkout: other, env: { HOME: home } }), join(other, 'state'));
  assert.equal(namedStateDir({ checkout: other, env: { HOME: home } }), undefined);
  // no record at all
  assert.equal(resolveStateDir({ checkout, env: { HOME: tmpDir('idd-pointers-bare-') } }), join(checkout, 'state'));
});

test('a relative IDD_STATE_DIR is read against the cwd, and settlePointers hands children one absolute state and the recorded pi', () => {
  const checkout = tmpDir('idd-pointers-checkout-');
  const home = machine(checkout, { state: '/rec/state', pi: '/rec/pi' });
  const rel = relative(process.cwd(), join(tmpDir('idd-pointers-rel-'), 'st'));
  assert.equal(resolveStateDir({ checkout, env: { HOME: home, IDD_STATE_DIR: rel } }), resolve(process.cwd(), rel));
  const env = { HOME: home };
  const { stateDir } = settlePointers({ checkout, env });
  assert.equal(stateDir, '/rec/state');
  assert.equal(env.IDD_STATE_DIR, '/rec/state');
  assert.equal(env.IDD_PI_BIN, '/rec/pi');
  const named = { HOME: home, IDD_PI_BIN: '/mine/pi' };
  settlePointers({ checkout, env: named });
  assert.equal(named.IDD_PI_BIN, '/mine/pi', 'a pi the environment names is not replaced');
  const bare = { HOME: tmpDir('idd-pointers-bare-') };
  settlePointers({ checkout, env: bare });
  assert.equal(bare.IDD_STATE_DIR, join(checkout, 'state'));
  assert.equal('IDD_PI_BIN' in bare, false, 'a pi no one named stays unset');
});

/** run an entrance script with a fake `bun` that prints the pointers the entrance handed it, under exactly `env` */
function runEntrance(name, env) {
  const fakeBin = tmpDir('idd-pointers-bin-');
  writeFileSync(join(fakeBin, 'bun'), '#!/bin/sh\nprintf "%s|%s\\n" "$IDD_STATE_DIR" "${IDD_PI_BIN-unset}"\n');
  chmodSync(join(fakeBin, 'bun'), 0o755);
  const script = join(ROOT, 'bin', name);
  return spawnSync('bash', [script], { env: { PATH: `${fakeBin}:/usr/bin:/bin`, ...env }, encoding: 'utf8' });
}

for (const name of ['idd', 'idd-engine']) {
  test(`bin/${name} takes the install record's state and pi when the environment has none, and the env, the record, then gateway.env, then the default decide the rest`, () => {
    const home = machine(ROOT, { state: '/rec/state', pi: '/rec/pi' });
    const gateway = put(join(home, 'gateway.env'), 'IDD_STATE_DIR=/stale/file/state\nIDD_PI_BIN=/stale/file/pi\n');
    // the record beats a stale gateway.env line, as the unit and the wrapper do
    const direct = runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: gateway });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout.trim(), '/rec/state|/rec/pi');
    // a value the environment was given beats the record and the file
    const given = runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: gateway, IDD_STATE_DIR: '/env/state', IDD_PI_BIN: '/env/pi' });
    assert.equal(given.stdout.trim(), '/env/state|/env/pi');
    // one given and one recorded
    const half = runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: gateway, IDD_STATE_DIR: '/env/state' });
    assert.equal(half.stdout.trim(), '/env/state|/rec/pi');
  });

  test(`bin/${name} does not borrow a record of another checkout, and falls back to gateway.env and then its own state`, () => {
    const home = machine(tmpDir('idd-pointers-elsewhere-'), { state: '/rec/state', pi: '/rec/pi' });
    const none = runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: join(home, 'missing.env') });
    assert.equal(none.stdout.trim(), `${ROOT}/state|unset`);
    const gateway = put(join(home, 'gateway.env'), 'IDD_STATE_DIR=/from/file\n');
    assert.equal(runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: gateway }).stdout.trim(), '/from/file|unset');
    // a record the shell cannot read back (no such checkout, no fields, not a record) changes nothing
    for (const body of ['not json\n', '{}\n', '{ "checkout": "/no/such/dir", "state_dir": "/rec/state" }\n']) {
      const broken = tmpDir('idd-pointers-broken-');
      put(join(broken, '.config', 'idd', 'install.json'), body);
      assert.equal(runEntrance(name, { HOME: broken, IDD_GATEWAY_ENV: join(broken, 'missing.env') }).stdout.trim(), `${ROOT}/state|unset`, body);
    }
    // a record with a state and no pi names no pi
    const stateOnly = machine(ROOT, { state: '/rec/state' });
    assert.equal(runEntrance(name, { HOME: stateOnly, IDD_GATEWAY_ENV: join(stateOnly, 'missing.env') }).stdout.trim(), '/rec/state|unset');
  });
}

test('the shell and the TypeScript resolver answer the same for the same record', () => {
  for (const checkout of [ROOT, tmpDir('idd-pointers-elsewhere-')]) {
    const home = machine(checkout, { state: '/rec/state', pi: '/rec/pi' });
    const shell = runEntrance('idd', { HOME: home, IDD_GATEWAY_ENV: join(home, 'missing.env') }).stdout.trim();
    const env = { HOME: home };
    settlePointers({ checkout: checkoutRoot(), env });
    assert.equal(shell, `${env.IDD_STATE_DIR}|${env.IDD_PI_BIN ?? 'unset'}`, checkout);
  }
});

test('install refuses a state or pi path the shell could not read back from the record', async () => {
  const { runInstall } = await import('../src/install/install.ts');
  for (const bad of ['/a"b', '/a\\b']) {
    const res = runInstall({ home: tmpDir('idd-pointers-home-'), stateDir: bad, piBin: '/ok/pi' });
    assert.equal(res.ok, false, bad);
    assert.match(res.errors.join('\n'), /引用符・backslash・改行/, bad);
  }
});

/**
 * No file but the resolver decides where the state or the pi is. A new entrance that reads IDD_STATE_DIR / IDD_PI_BIN
 * itself, or builds `<root>/state` as a default, lands here and fails: it would bypass the install record.
 */
const SKIP_DIRS = new Set(['node_modules', 'test', 'fixtures', 'dist', '_build', 'bench', '.next', 'state', '_meta', '_docs', '.git']);
const SOURCE_FILE = /\.(ts|tsx|mjs|js|sh)$/;
/** the files that may name the pointers: the two resolvers, and what writes them into the record, the units and the wrapper */
const MAY_NAME_POINTERS = new Set([
  'packages/idd-core/src/install/pointers.ts',
  'bin/pointers.sh',
  'packages/idd-core/src/install/install.ts',
  'packages/idd-core/src/install/units.ts',
  'packages/idd-core/src/install/upgrade.ts',
  // forwards the already decided state to the transient unit it starts; it decides nothing
  'packages/idd-engine/src/server/gui-build.ts',
  'packages/idd-lane/src/tick-kick.ts',
  // a cross-check script that points the process at its own fixture state; it reads no pointer
  'packages/idd-fold/crosscheck.mjs',
  // the flags of `idd install`
  'packages/idd-cli/bin/idd.ts',
  // only comments and the table of variables of the old GUI tooling
  'bin/gateway-env.sh',
]);

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.endsWith('.test.mjs') || entry.endsWith('.test.ts')) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) sources(path, out);
    else if (SOURCE_FILE.test(entry) || dir === join(ROOT, 'bin')) out.push(path);
  }
  return out;
}

const codeLines = (text) => text.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => !/^\s*(\/\/|\*|\/\*|#)/.test(line));

test('only the resolver reads IDD_STATE_DIR or IDD_PI_BIN, or builds a default state', () => {
  const found = [];
  for (const top of ['bin', 'packages', 'lib', 'app', 'hooks', 'components']) {
    let files = [];
    try { files = sources(join(ROOT, top)); } catch { continue; }
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (MAY_NAME_POINTERS.has(rel)) continue;
      for (const [n, line] of codeLines(readFileSync(file, 'utf8'))) {
        if (/IDD_STATE_DIR|IDD_PI_BIN/.test(line) || /\b(join|resolve)\([^()]*,\s*['"`]state['"`]\s*\)/.test(line) || /\$\{?root\}?\/state/.test(line)) found.push(`${rel}:${n}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(found, [], 'these decide the state or the pi themselves; go through packages/idd-core/src/install/pointers.ts (TypeScript) or bin/pointers.sh (shell)');
});

const rewriteRecord = (home, checkout, body) => put(join(home, '.config', 'idd', 'install.json'), `${JSON.stringify({ schema: 1, checkout, version: 'v1', installed_at: '', ...body })}\n`);

test('a process keeps the pointers it first resolved when the install record is rewritten afterwards', () => {
  const checkout = tmpDir('idd-pointers-kept-');
  const home = machine(checkout, { state: '/first/state', pi: '/first/pi' });
  const env = { HOME: home };
  assert.equal(resolveStateDir({ checkout, env }), '/first/state');
  assert.equal(resolvePiBin({ checkout, env }), '/first/pi');
  rewriteRecord(home, checkout, { state_dir: '/second/state', pi_bin: '/second/pi' });
  assert.equal(resolveStateDir({ checkout, env }), '/first/state');
  assert.equal(resolvePiBin({ checkout, env }), '/first/pi');
  assert.deepEqual(installedPointers(checkout, env), { stateDir: '/first/state', piBin: '/first/pi' });
  // a value the environment gives is the process's own and is not kept
  assert.equal(resolveStateDir({ checkout, env: { ...env, IDD_STATE_DIR: '/given/state' } }), '/given/state');
});

test('stateDir() of a process does not move when the record at its HOME is rewritten', () => {
  const checkout = checkoutRoot();
  const home = machine(checkout, { state: '/first/state' });
  const saved = { HOME: process.env.HOME, IDD_STATE_DIR: process.env.IDD_STATE_DIR };
  delete process.env.IDD_STATE_DIR;
  process.env.HOME = home;
  try {
    assert.equal(stateDir(), '/first/state');
    rewriteRecord(home, checkout, { state_dir: '/second/state' });
    assert.equal(stateDir(), '/first/state');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the two entrances carry no state or pi of their own, only the calls to bin/pointers.sh', () => {
  for (const name of ['idd', 'idd-engine']) {
    const text = readFileSync(join(ROOT, 'bin', name), 'utf8');
    const code = codeLines(text).map(([, line]) => line).join('\n');
    assert.doesNotMatch(code, /\/state|IDD_STATE_DIR|IDD_PI_BIN/, name);
    assert.match(code, /apply_install_pointers/, name);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { configPath, userConfigDir } from '../src/config/files.ts';
import { areasPath, parseRepos, projectionConfigOf } from '../src/config/areas.ts';
import { key } from '../src/overlay/git.ts';
import { tmpDir } from './helpers/tmp.mjs';
import { shippedSkip } from './helpers/shipped-repos.mjs';

const IDD_FOLD_DIST = ['packages/idd-fold/dist/idd-fold.js', 'packages/idd-fold/dist/idd-fold.d.ts', 'packages/idd-fold/dist/moonbit.d.ts'];

/** a declaration kept beside the areas changes the hash of no area: a pending submit or landing keeps its validity */
function assertSameHashes(before, after, what) {
  for (const k of Object.keys(before.areas)) assert.equal(key(after.areas[k]), key(before.areas[k]), `${what} must not change the hash of ${k}`);
}

const ENV = ['IDD_REPOS_FILE', 'IDD_ROLES_FILE', 'IDD_MODES_FILE'];
function withoutEnv(fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  try { return fn(); } finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const put = (p, body) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); return p; };

test('the read order is env, then the checkout config, then ~/.config/idd', () => {
  withoutEnv(() => {
    const checkout = tmpDir('idd-cfg-checkout-');
    const home = tmpDir('idd-cfg-home-');
    const fromCheckout = put(join(checkout, 'config', 'roles.yaml'), 'roles: {}\n');
    const fromHome = put(join(home, '.config', 'idd', 'roles.yaml'), 'roles: {}\n');
    assert.equal(configPath('roles', { checkout, home }), fromCheckout, 'the checkout wins over the home');
    assert.equal(configPath('modes', { checkout, home }), join(home, '.config', 'idd', 'modes.yaml'), 'the home is used when the checkout has none');
    process.env.IDD_ROLES_FILE = '/tmp/explicit-roles.yaml';
    assert.equal(configPath('roles', { checkout, home }), '/tmp/explicit-roles.yaml', 'the environment wins over both');
    delete process.env.IDD_ROLES_FILE;
    // a cwd config is not read
    const cwd = tmpDir('idd-cfg-cwd-');
    put(join(cwd, 'config', 'roles.yaml'), 'roles: {}\n');
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      assert.equal(configPath('roles', { checkout: tmpDir('idd-cfg-empty-'), home }), fromHome, 'the cwd is not read');
    } finally {
      process.chdir(prev);
    }
  });
});

test('the core config helpers use the same order (areasPath / rolesPath)', () => {
  withoutEnv(() => {
    process.env.IDD_REPOS_FILE = '/tmp/r.yaml';
    assert.equal(areasPath(), '/tmp/r.yaml');
    delete process.env.IDD_REPOS_FILE;
  });
  const home = tmpDir('idd-cfg-home2-');
  assert.equal(userConfigDir(home), join(home, '.config', 'idd'));
});

test('the core reader returns the same risk_paths by kind, and refuses an unknown kind', () => {
  const file = parseRepos(`repos:
  Org/app:
    upstream: /u/app
    work: /w/app
    risk_paths:
      auth: [src/auth/]
      secret: [secrets.ts]
`);
  assert.deepEqual(file.riskPaths, { 'Org/app': { auth: ['src/auth/'], secret: ['secrets.ts'] } });
  assert.equal(file.areas['Org/app'].riskPaths, undefined, 'the declaration is not inside the area config');
  assert.throws(() => parseRepos(`repos:\n  Org/app:\n    upstream: /u/app\n    work: /w/app\n    risk_paths:\n      biling: [x]\n`), /Org\/app\.risk_paths\.biling/);
});

test('adding a declaration leaves another repo\'s area config and hash unchanged', () => {
  const base = `repos:
  Org/app:
    upstream: /u/app
    work: /w/app
    public_base: main
  Org/other:
    upstream: /u/other
    work: /w/other
    public_base: main
`;
  const before = parseRepos(base);
  const after = parseRepos(`${base}    risk_paths:
      data_loss: [src/migrations/]
`);
  assert.deepEqual(after.areas['Org/app'], before.areas['Org/app']);
  assert.equal(key(after.areas['Org/app']), key(before.areas['Org/app']));
  assert.deepEqual(after.riskPaths, { 'Org/other': { data_loss: ['src/migrations/'] } });
  assert.equal(before.riskPaths, undefined);
});

test('AC-021: a repo that writes no projection settings gets A and private, and any setting leaves every area hash alone', () => {
  const bare = parseRepos(`repos:
  Org/app:
    upstream: /u/app
    work: /w/app
    public_base: main
  Org/other:
    upstream: /u/other
    work: /w/other
    public_base: main
`);
  assert.deepEqual(projectionConfigOf('Org/app', bare), { projections: ['A'], visibility_default: 'private' });
  assert.deepEqual(projectionConfigOf('Org/missing', bare), { projections: ['A'], visibility_default: 'private' });

  const written = parseRepos(`repos:
  Org/app:
    upstream: /u/app
    work: /w/app
    public_base: main
    intent: { projections: [], visibility_default: public }
  Org/other:
    upstream: /u/other
    work: /w/other
    public_base: main
    intent: { projections: [B, C] }
`);
  assert.deepEqual(projectionConfigOf('Org/app', written), { projections: [], visibility_default: 'public' });
  assert.deepEqual(projectionConfigOf('Org/other', written), { projections: ['B', 'C'], visibility_default: 'private' });
  assert.equal(written.areas['Org/app'].intent, undefined, 'the settings stay outside the area config');
  assertSameHashes(bare, written, 'the settings');

  const head = 'repos:\n  Org/app:\n    upstream: /u/app\n    work: /w/app\n';
  assert.throws(() => parseRepos(`${head}    intent: { projections: [D] }\n`), /Org\/app\.intent\.projections/);
  assert.throws(() => parseRepos(`${head}    intent: { projections: A }\n`), /Org\/app\.intent\.projections/);
  assert.throws(() => parseRepos(`${head}    intent: { visibility_default: secret }\n`), /visibility_default/);
  assert.throws(() => parseRepos(`${head}    intent: { wat: 1 }\n`), /知らない欄/);
});

test('AC-005: generated_files is read per repo beside the areas, leaves every area hash alone, and a repo that writes none has none', () => {
  const head = 'repos:\n  Org/app:\n    upstream: /u/app\n    work: /w/app\n    public_base: main\n';
  const other = '  Org/other:\n    upstream: /u/other\n    work: /w/other\n    public_base: main\n';
  const before = parseRepos(`${head}${other}`);
  const after = parseRepos(`${head}    generated_files:
      - paths: [dist/app.js, dist/app.d.ts]
        command: "bash scripts/build.sh"
        timeout_minutes: 2
${other}`);
  assert.deepEqual(after.generatedFiles, { 'Org/app': [{ paths: ['dist/app.js', 'dist/app.d.ts'], command: ['bash', '-c', 'bash scripts/build.sh'], timeoutMinutes: 2 }] });
  assert.equal(before.generatedFiles, undefined, 'a file that declares none carries none');
  assert.equal(after.areas['Org/app'].generatedFiles, undefined, 'the declaration is not inside the area config');
  assertSameHashes(before, after, 'the declaration');
  // the limit has a default, and a list command is run as written
  const plain = parseRepos(`${head}    generated_files:\n      - { paths: [out.js], command: [make, out.js] }\n`);
  assert.deepEqual(plain.generatedFiles['Org/app'], [{ paths: ['out.js'], command: ['make', 'out.js'], timeoutMinutes: 5 }]);
  // a declaration read as something else is a config error, not a default
  const reads = (bad) => parseRepos(`${head}    generated_files:\n      ${bad}\n`);
  for (const bad of ['- { paths: [dist/], command: x }', '- { paths: [../out.js], command: x }', '- { paths: [/abs/out.js], command: x }', '- { paths: [], command: x }']) assert.throws(() => reads(bad), /paths/, bad);
  for (const [bad, pattern] of [
    ['- { paths: [out.js] }', /command/],
    ['- { paths: [out.js], command: x, timeout_minutes: 0 }', /timeout_minutes/],
    ['- { paths: [out.js], command: x, cwd: y }', /知らない欄/],
    ['- { paths: [out.js], command: x }\n      - { paths: [out.js], command: y }', /2 回書かれて/],
  ]) assert.throws(() => reads(bad), pattern, bad);
  assert.throws(() => parseRepos(`${head}    generated_files: dist/app.js\n`), /generated_files/);
});

test('AC-005: this repo declares the idd-fold dist as generated files, made again by the script the README names', { skip: shippedSkip }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const file = parseRepos(readFileSync(join(root, 'config', 'repos.yaml'), 'utf8'));
  const declared = file.generatedFiles['penne-0505/pi-web-idd'];
  assert.equal(declared.length, 1);
  assert.deepEqual(declared[0].paths, IDD_FOLD_DIST);
  assert.match(declared[0].command.join(' '), /scripts\/build-idd-fold-dist\.sh/);
  // the other repos of the file declare none
  assert.deepEqual(Object.keys(file.generatedFiles), ['penne-0505/pi-web-idd']);
});

test('AC-005: the script a declaration names builds the dist with moon, and the dist files are tracked', () => {
  // tracked files only, so a public checkout without config/repos.yaml runs this too
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  assert.match(readFileSync(join(root, 'scripts', 'build-idd-fold-dist.sh'), 'utf8'), /build --target js --release/);
  for (const path of IDD_FOLD_DIST) assert.ok(readFileSync(join(root, path)).length > 0, path);
});

test('bin/idd-engine ends with exec bun, so the runtime shim stays the main process', () => {
  const text = readFileSync(new URL('idd-engine', new URL('../../../bin/', import.meta.url)), 'utf8');
  const code = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  assert.match(code[code.length - 1], /^exec bun run /, 'the last code line must exec bun (a shell left as the main process makes the engine a grandchild)');
});

test('bin/idd and bin/idd-engine do not pin the settings files (the one order decides)', () => {
  const bin = new URL('../../../bin/', import.meta.url);
  for (const name of ['idd', 'idd-engine']) {
    const text = readFileSync(new URL(name, bin), 'utf8');
    assert.doesNotMatch(text, /IDD_ROLES_FILE=/, name);
    assert.doesNotMatch(text, /IDD_REPOS_FILE=/, name);
    assert.match(text, /apply_default_pointers/, name);
  }
});

/** run an entrance script with a fake `bun` that prints what the entrance handed it, under exactly `env` */
function runEntrance(name, env) {
  const fakeBin = tmpDir('idd-entrance-bin-');
  writeFileSync(join(fakeBin, 'bun'), '#!/bin/sh\nprintf "%s|%s|%s|%s|%s\\n" "$IDD_STATE_DIR" "$IDD_PI_BIN" "${KEY-unset}" "$IDD_ENGINE_PORT" "${IDD_RELOAD-unset}"\n');
  chmodSync(join(fakeBin, 'bun'), 0o755);
  const script = fileURLToPath(new URL(name, new URL('../../../bin/', import.meta.url)));
  return spawnSync('bash', [script], { env: { PATH: `${fakeBin}:/usr/bin:/bin`, ...env }, encoding: 'utf8' });
}

test('gateway.env does not override a value the environment already has, for either entrance', () => {
  const home = tmpDir('idd-entrance-home-');
  const file = put(join(home, 'gateway.env'), 'KEY=secret\nIDD_STATE_DIR=/from/file\nIDD_PI_BIN=/from/file/pi\nIDD_ENGINE_PORT=31000\nIDD_RELOAD=on\n');
  for (const name of ['idd', 'idd-engine']) {
    const res = runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: file, IDD_STATE_DIR: '/from/env', IDD_PI_BIN: '/from/env/pi', IDD_RELOAD: 'off' });
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    // the environment wins for the pointers and the reload; the file still gives what the environment lacks
    assert.equal(res.stdout.trim(), '/from/env|/from/env/pi|secret|31000|off', name);
  }
});

test('the defaults of the entrances apply only when neither the environment nor gateway.env has the value', () => {
  const home = tmpDir('idd-entrance-home-');
  const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  for (const name of ['idd', 'idd-engine']) {
    const none = runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: join(home, 'missing.env') });
    assert.equal(none.stdout.trim(), `${root}/state||unset|${name === 'idd-engine' ? '30144' : ''}|unset`, `${name}: no file, no environment`);
    const file = put(join(home, `${name}.env`), 'IDD_STATE_DIR=/from/file\n');
    const fromFile = runEntrance(name, { HOME: home, IDD_GATEWAY_ENV: file });
    assert.equal(fromFile.stdout.split('|')[0], '/from/file', `${name}: the file is read before the default`);
  }
});

test('gateway.env values with spaces, quotes and newlines reach the process as written, and a broken file stops the entrance', () => {
  const home = tmpDir('idd-entrance-home-');
  const file = put(join(home, 'gateway.env'), 'KEY="a b \'c\' $HOME\nsecond line"\n');
  const res = runEntrance('idd', { HOME: home, IDD_GATEWAY_ENV: file });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`|a b 'c' ${home}\nsecond line|`), res.stdout);
  const broken = put(join(home, 'broken.env'), 'KEY="never closed\n');
  const stopped = runEntrance('idd', { HOME: home, IDD_GATEWAY_ENV: broken });
  assert.notEqual(stopped.status, 0, 'a file that cannot be read does not let the entrance go on without its keys');
  assert.equal(stopped.stdout, '');
});

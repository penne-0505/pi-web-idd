import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { runInstall } from '../src/install/install.ts';
import { readLegacyWebOutputs, renderUnits } from '../src/install/units.ts';
import { BOTH_OUTPUTS, layOldScreenOutput, outputsLeft } from './helpers/old-screen.mjs';
import { tmpDir } from './helpers/tmp.mjs';

// the harness sets the settings-file overrides; this file tests install's own example copy, so clear them
for (const k of ['IDD_REPOS_FILE', 'IDD_ROLES_FILE', 'IDD_MODES_FILE']) delete process.env[k];

/** the commit the fake checkout's bundle is stamped with, which is also the head the fake runner answers */
const HEAD = 'a'.repeat(40);

/** a runner that records every call and answers the git / systemctl questions install asks */
function recorder(overrides = {}) {
  const calls = [];
  const answer = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (overrides[key]) return overrides[key];
    if (cmd === '/bin/sh') return { ok: true, stdout: '/usr/bin/tool\n', stderr: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { ok: true, stdout: `${HEAD}\n`, stderr: '' };
    if (cmd === 'git' && args[0] === 'describe') return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: '' };
  };
  return {
    calls,
    run(cmd, args, opts) { calls.push({ kind: 'run', cmd, args, opts }); },
    capture(cmd, args, opts) { calls.push({ kind: 'capture', cmd, args, opts }); return answer(cmd, args); },
  };
}

/** a checkout with the example settings and everything install checks for, so no heavy step runs */
function fakeCheckout() {
  const dir = tmpDir('idd-install-co-');
  for (const name of ['roles', 'repos', 'modes']) {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', `${name}.example.yaml`), `${name}: {}\n`);
  }
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  // the screen's bundle, stamped with the commit it was built from
  mkdirSync(join(dir, 'packages', 'idd-gui', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'idd-gui', 'dist', 'build.json'), `${JSON.stringify({ commit: HEAD })}\n`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'idd'), '#!/usr/bin/env bash\necho "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_docs/standards"\n');
  chmodSync(join(dir, 'bin', 'idd'), 0o755);
  return dir;
}

const placeSkills = () => ({ ok: true, source: '', agents: '', claude: '', installed: [], removed: [] });

test('install creates the settings place, examples, wrapper, units and install.json without heavy steps', () => {
  const home = tmpDir('idd-install-home-');
  const checkout = fakeCheckout();
  const runner = recorder();
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = 'fake-systemctl';
  try {
    const res = runInstall({ home, checkout, runner, placeSkills, path: '/usr/bin:/bin' });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    const configDir = join(home, '.config', 'idd');
    assert.ok(existsSync(configDir));
    assert.equal(statSync(configDir).mode & 0o777, 0o700, 'the settings place is 700');
    for (const name of ['roles', 'repos', 'modes']) {
      assert.equal(readFileSync(join(configDir, `${name}.yaml`), 'utf8'), `${name}: {}\n`);
    }
    assert.ok(existsSync(join(configDir, 'install.json')));
    assert.equal(JSON.parse(readFileSync(join(configDir, 'install.json'), 'utf8')).checkout, checkout);
    const wrapper = join(home, '.local', 'bin', 'idd');
    assert.ok(existsSync(wrapper));
    assert.equal(lstatSync(wrapper).isSymbolicLink(), false, 'the wrapper is not a symlink');
    assert.equal(statSync(wrapper).mode & 0o777, 0o755);
    assert.match(readFileSync(wrapper, 'utf8'), /exec ".*bin\/idd"/);
    for (const unit of ['idd-engine.service', 'idd-tick.service', 'idd-tick.timer']) {
      const p = join(home, '.config', 'systemd', 'user', unit);
      const text = readFileSync(p, 'utf8');
      assert.match(text, /# idd-install: managed/, unit);
      if (unit !== 'idd-tick.timer') assert.match(text, new RegExp(`WorkingDirectory=${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), unit);
    }
    assert.match(readFileSync(join(home, '.config', 'systemd', 'user', 'idd-engine.service'), 'utf8'), /ExecStart=.*bin\/idd-engine/);
    assert.equal(existsSync(join(home, '.config', 'systemd', 'user', 'idd-web.service')), false, 'no unit of its own for the screen: the engine serves it');
    assert.deepEqual(runner.calls.filter((c) => c.kind === 'run' && c.cmd === 'fake-systemctl'), [{ kind: 'run', cmd: 'fake-systemctl', args: ['--user', 'daemon-reload'], opts: undefined }], 'one daemon-reload, no enable/start');
    assert.equal(runner.calls.some((c) => c.kind === 'run' && c.cmd === 'npm'), false, 'no heavy step: node_modules and the screen\'s bundle exist');
    assert.ok(res.commands.some((c) => c.includes('enable --now idd-engine.service')));
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('install builds the screen\'s bundle when the checkout has none, and never builds the Next app', () => {
  const home = tmpDir('idd-install-home-');
  const checkout = fakeCheckout();
  rmSync(join(checkout, 'packages', 'idd-gui', 'dist'), { recursive: true });
  const runner = recorder();
  const res = runInstall({ home, checkout, runner, placeSkills, path: '/usr/bin:/bin' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const npm = runner.calls.filter((c) => c.kind === 'run' && c.cmd === 'npm').map((c) => c.args.join(' '));
  assert.deepEqual(npm, ['run build:gui']);
  assert.ok(res.steps.some((step) => step.includes('画面の bundle を build しました')));
});

test('install builds the screen\'s bundle again when its stamp is not the head, and does not succeed when that build fails', () => {
  const home = tmpDir('idd-install-home-');
  const checkout = fakeCheckout();
  writeFileSync(join(checkout, 'packages', 'idd-gui', 'dist', 'build.json'), `${JSON.stringify({ commit: 'b'.repeat(40) })}\n`);
  const runner = recorder();
  const res = runInstall({ home, checkout, runner, placeSkills, path: '/usr/bin:/bin' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(runner.calls.filter((c) => c.kind === 'run' && c.cmd === 'npm').map((c) => c.args.join(' ')), ['run build:gui']);

  const failing = recorder();
  failing.run = (cmd, args, opts) => { failing.calls.push({ kind: 'run', cmd, args, opts }); if (cmd === 'npm') throw new Error('build broke'); };
  const failed = runInstall({ home: tmpDir('idd-install-home-'), checkout, runner: failing, placeSkills, path: '/usr/bin:/bin' });
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.some((e) => e.includes('npm run build:gui に失敗しました')));
});

test('install never overwrites a key, a setting, a hand-written unit or an unmarked wrapper', () => {
  const home = tmpDir('idd-install-home-');
  const checkout = fakeCheckout();
  mkdirSync(join(home, '.config', 'idd'), { recursive: true });
  writeFileSync(join(home, '.config', 'idd', 'gateway.env'), 'KEY=1\n');
  writeFileSync(join(home, '.config', 'idd', 'repos.yaml'), 'mine: 1\n');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'idd-tick.service'), '[Service]\n# hand-written\n');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'idd'), '#!/bin/sh\necho mine\n');
  const runner = recorder();
  const res = runInstall({ home, checkout, runner, placeSkills, path: '/usr/bin:/bin' });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(readFileSync(join(home, '.config', 'idd', 'gateway.env'), 'utf8'), 'KEY=1\n');
  assert.equal(readFileSync(join(home, '.config', 'idd', 'repos.yaml'), 'utf8'), 'mine: 1\n');
  assert.match(readFileSync(join(home, '.config', 'systemd', 'user', 'idd-tick.service'), 'utf8'), /hand-written/);
  assert.equal(readFileSync(join(home, '.local', 'bin', 'idd'), 'utf8'), '#!/bin/sh\necho mine\n');
  const reasons = res.skipped.map((s) => `${s.path}:${s.reason}`).join(' ');
  assert.match(reasons, /gateway\.env|repos\.yaml/, 'the settings are reported as left alone');
  const unitSkip = res.skipped.find((s) => s.path.endsWith('idd-tick.service'));
  assert.ok(unitSkip, 'the hand-written unit is reported');
  assert.ok(unitSkip.existing.includes('hand-written') && unitSkip.proposed.includes('[Service]'), 'the difference is shown');
  // the other units were written, and a marked unit is rewritten on the next run
  assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'idd-engine.service')));
});

test('install stops, disables and removes the old screen\'s unit it wrote, and leaves a hand-written one', () => {
  const home = tmpDir('idd-install-home-');
  const checkout = fakeCheckout();
  const unitDir = unitDirOf(home);
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'idd-web.service'), '# idd-install: managed\n[Service]\nExecStart=next start\n');
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = 'fake-systemctl';
  try {
    const runner = recorder();
    const res = runInstall({ home, checkout, runner, placeSkills, path: '/usr/bin:/bin' });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(existsSync(join(unitDir, 'idd-web.service')), false, 'the unit install wrote is removed');
    const verbs = runner.calls.filter((c) => c.kind === 'run' && c.cmd === 'fake-systemctl').map((c) => c.args.join(' '));
    assert.deepEqual(verbs, ['--user stop idd-web.service', '--user disable idd-web.service', '--user daemon-reload']);

    const handHome = tmpDir('idd-install-home-');
    mkdirSync(unitDirOf(handHome), { recursive: true });
    writeFileSync(join(unitDirOf(handHome), 'idd-web.service'), '[Service]\n# hand-written\n');
    const handRunner = recorder();
    const kept = runInstall({ home: handHome, checkout, runner: handRunner, placeSkills, path: '/usr/bin:/bin' });
    assert.equal(kept.ok, true, JSON.stringify(kept.errors));
    assert.match(readFileSync(join(unitDirOf(handHome), 'idd-web.service'), 'utf8'), /hand-written/);
    assert.equal(handRunner.calls.some((c) => c.args?.includes('stop')), false);
    assert.ok(kept.steps.some((step) => step.includes('手書きの idd-web.service')));
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('a marked unit is rewritten, and the wrapper wakes the checkout CLI from another cwd', () => {
  const home = tmpDir('idd-install-home-');
  const checkout = fakeCheckout();
  const runner = recorder();
  runInstall({ home, checkout, runner, placeSkills, path: '/usr/bin:/bin' });
  const unit = join(home, '.config', 'systemd', 'user', 'idd-engine.service');
  writeFileSync(unit, `${readFileSync(unit, 'utf8')}\n# stale\n`);
  runInstall({ home, checkout, runner, placeSkills, path: '/usr/bin:/bin' });
  assert.doesNotMatch(readFileSync(unit, 'utf8'), /# stale/, 'a marked unit is rewritten');
  const wrapper = join(home, '.local', 'bin', 'idd');
  const other = tmpDir('idd-install-cwd-');
  const out = execFileSync(wrapper, ['rules', 'path'], { cwd: other, encoding: 'utf8' }).trim();
  assert.equal(out, join(checkout, '_docs', 'standards'));
});

test('the rendered units name the checkout and the ports, with only comments the manager accepts', () => {
  const units = renderUnits({ checkout: '/co', path: '/usr/bin:/bin' });
  assert.deepEqual(units.map((u) => u.name), ['idd-engine.service', 'idd-tick.service', 'idd-tick.timer']);
  const engine = units.find((u) => u.name === 'idd-engine.service').body;
  assert.match(engine, /ExecStart=\/co\/bin\/idd-engine/);
  assert.match(engine, /IDD_ENGINE_PORT=30144/);
  // the engine serves the screen on its own port: no unit of its own, no second port, and no copy of the inbox address
  assert.equal(units.some((u) => /30142|next start|IDD_INBOX_BASE_URL|idd-web/.test(u.body)), false);
  assert.equal(renderUnits({ checkout: '/co', path: '/usr/bin:/bin', enginePort: 39999 }).find((u) => u.name === 'idd-engine.service').body.includes('IDD_ENGINE_PORT=39999'), true);
  assert.match(units.find((u) => u.name === 'idd-tick.timer').body, /Unit=idd-tick\.service/);
});

/** the answers a checkout on a release tag gives to install's git questions */
const LOG_ORIGIN = 'git log --diff-filter=A --reverse --format=%H -- bin/gateway-env.sh';
const originAnswer = (sha) => ({ ok: true, stdout: `${sha}\n${'9'.repeat(40)}\n`, stderr: '' });
const onTag = {
  'git describe --tags --exact-match HEAD': { ok: true, stdout: 'v0.1.0\n', stderr: '' },
  'git rev-parse HEAD': { ok: true, stdout: 'f'.repeat(40) + '\n', stderr: '' },
  'git rev-parse --is-shallow-repository': { ok: true, stdout: 'false\n', stderr: '' },
  [LOG_ORIGIN]: originAnswer('b'.repeat(40)),
};
const POINTERS = { stateDir: '/srv/idd/state', piBin: '/opt/pi/bin/pi' };

const UNITS = ['idd-engine.service', 'idd-tick.service'];
const unitDirOf = (home) => join(home, '.config', 'systemd', 'user');
const readUnit = (home, unit) => readFileSync(join(unitDirOf(home), unit), 'utf8');
const readWrapper = (home) => readFileSync(join(home, '.local', 'bin', 'idd'), 'utf8');
const recordPathOf = (home) => join(home, '.config', 'idd', 'install.json');
const readRecord = (home) => JSON.parse(readFileSync(recordPathOf(home), 'utf8'));
const exists = (...parts) => existsSync(join(...parts));

/** one install run against a fresh or given home; the answers default to a checkout off a tag */
function install({ home = tmpDir('idd-install-home-'), checkout = fakeCheckout(), answers, ...options } = {}) {
  const res = runInstall({ home, checkout, runner: recorder(answers), placeSkills, path: '/usr/bin:/bin', ...options });
  return { home, checkout, res };
}

/** install succeeded, and every unit matches `pattern` */
function assertUnitsMatch(home, pattern) {
  for (const unit of UNITS) assert.match(readUnit(home, unit), pattern, unit);
}

function assertOk(res) {
  assert.equal(res.ok, true, JSON.stringify(res.errors));
}

test('on a tag, install writes the state and pi into the units and the wrapper, and into the record', () => {
  const { home, res } = install({ answers: onTag, ...POINTERS });
  assertOk(res);
  assertUnitsMatch(home, /^ExecStart=\/usr\/bin\/env IDD_STATE_DIR=\/srv\/idd\/state IDD_PI_BIN=\/opt\/pi\/bin\/pi /m);
  for (const unit of UNITS) assert.doesNotMatch(readUnit(home, unit), /IDD_(ROLES|REPOS|MODES)_FILE/, `${unit} neither sets nor unsets the settings files`);
  assert.match(readUnit(home, 'idd-engine.service'), /^ExecStart=\/usr\/bin\/env IDD_STATE_DIR=\S+ IDD_PI_BIN=\S+ IDD_RELOAD=off /m, 'a tag never replaces the engine');
  const wrapper = readWrapper(home);
  assert.match(wrapper, /export IDD_STATE_DIR='\/srv\/idd\/state'/);
  assert.match(wrapper, /export IDD_PI_BIN='\/opt\/pi\/bin\/pi'/);
  const record = readRecord(home);
  assert.equal(record.state_dir, '/srv/idd/state');
  assert.equal(record.pi_bin, '/opt/pi/bin/pi');
  assert.equal(record.pointers_commit, 'b'.repeat(40), 'the commit that first added the pointers, not the HEAD it was installed at');
});

test('on a tag, passing only one of the state and the pi stops without writing a unit or the wrapper', () => {
  for (const one of [{ stateDir: '/srv/idd/state' }, { piBin: '/opt/pi/bin/pi' }, {}]) {
    const { home, res } = install({ answers: onTag, ...one });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /両方/);
    assert.equal(exists(home, '.local', 'bin', 'idd'), false, 'no wrapper');
    assert.equal(exists(unitDirOf(home)), false, 'no unit');
    assert.equal(exists(recordPathOf(home)), false, 'no record');
  }
});

test('a relative path for the state or the pi is refused', () => {
  const { res } = install({ answers: onTag, stateDir: 'state', piBin: '/opt/pi/bin/pi' });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /--state-dir.*絶対/);
});

test('a re-run without the flags keeps the recorded pointers and the commit that carried them; a new value replaces the pointer only', () => {
  const { home, checkout } = install({ answers: onTag, ...POINTERS });
  const later = { ...onTag, 'git rev-parse HEAD': { ok: true, stdout: 'e'.repeat(40) + '\n', stderr: '' }, [LOG_ORIGIN]: originAnswer('c'.repeat(40)), [`git merge-base --is-ancestor ${'b'.repeat(40)} ${'e'.repeat(40)}`]: { ok: true, stdout: '', stderr: '' } };
  assertOk(install({ home, checkout, answers: later }).res);
  const kept = readRecord(home);
  assert.equal(kept.state_dir, '/srv/idd/state');
  assert.equal(kept.pointers_commit, 'b'.repeat(40), 'the commit is recorded once');
  assert.match(readUnit(home, 'idd-tick.service'), /IDD_STATE_DIR=\/srv\/idd\/state/);
  install({ home, checkout, answers: later, stateDir: '/srv/other/state' });
  const moved = readRecord(home);
  assert.equal(moved.state_dir, '/srv/other/state');
  assert.equal(moved.pi_bin, '/opt/pi/bin/pi', 'the pi that was not passed stays');
});

test('a recorded commit this checkout cannot reach is replaced by the commit that first added the pointers here, so the clone is not stuck below a floor it never had', () => {
  const { home, checkout } = install({ answers: { ...onTag, [LOG_ORIGIN]: originAnswer('a'.repeat(40)) }, ...POINTERS });
  // the git answer for the ancestor question is a failure by default: this clone does not hold 'a'
  assertOk(install({ home, checkout, answers: onTag }).res);
  const record = readRecord(home);
  assert.equal(record.pointers_commit, 'b'.repeat(40), 'not the HEAD, and not the commit this clone cannot reach');
  assert.equal(record.state_dir, '/srv/idd/state', 'the pointers themselves stay');
});

/** an install made before the record held the pointers: the units and the wrapper carry them, install.json does not */
function installedBeforeTheRecord(pointers) {
  const { home, checkout } = install(pointers);
  const record = readRecord(home);
  for (const key of ['state_dir', 'pi_bin', 'pointers_commit']) delete record[key];
  writeFileSync(recordPathOf(home), JSON.stringify(record));
  return { home, checkout, recordPath: recordPathOf(home) };
}

test('a bare re-install keeps the state and the pi the managed units and the wrapper already carry when the record has none', () => {
  const { home, checkout, recordPath } = installedBeforeTheRecord({ stateDir: '/srv/my state/100%$x', piBin: '/opt/pi/bin/pi' });
  assertOk(install({ home, checkout }).res);
  assertUnitsMatch(home, /"IDD_STATE_DIR=\/srv\/my state\/100%%\$\$x" IDD_PI_BIN=\/opt\/pi\/bin\/pi /);
  assert.match(readWrapper(home), /export IDD_STATE_DIR='\/srv\/my state\/100%\$x'/);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.state_dir, '/srv/my state/100%$x');
  assert.equal(record.pi_bin, '/opt/pi/bin/pi');
});

test('a value passed again replaces what the units carry', () => {
  const { home, checkout } = installedBeforeTheRecord(POINTERS);
  assertOk(install({ home, checkout, stateDir: '/srv/other/state' }).res);
  assert.match(readUnit(home, 'idd-tick.service'), /IDD_STATE_DIR=\/srv\/other\/state IDD_PI_BIN=\/opt\/pi\/bin\/pi /);
});

test('units that disagree on the state stop the install, naming which differ, before anything is written', () => {
  const { home, checkout, recordPath } = installedBeforeTheRecord(POINTERS);
  const tick = join(unitDirOf(home), 'idd-tick.service');
  const edited = readFileSync(tick, 'utf8').replace('IDD_STATE_DIR=/srv/idd/state', 'IDD_STATE_DIR=/srv/else/state');
  writeFileSync(tick, edited);
  const before = readFileSync(recordPath, 'utf8');
  const wrapperBefore = readWrapper(home);
  const { res } = install({ home, checkout });
  assert.equal(res.ok, false);
  const message = res.errors.join(' ');
  assert.match(message, /IDD_STATE_DIR/);
  assert.match(message, /\/srv\/else\/state: \S*idd-tick\.service）/);
  assert.match(message, /\/srv\/idd\/state: \S*idd-engine\.service/);
  assert.equal(readFileSync(tick, 'utf8'), edited, 'the unit is untouched');
  assert.equal(readFileSync(recordPath, 'utf8'), before, 'the record is untouched');
  assert.equal(readWrapper(home), wrapperBefore, 'the wrapper is untouched');
});

test('a hand-written unit carries nothing that install keeps', () => {
  const home = tmpDir('idd-install-home-');
  mkdirSync(unitDirOf(home), { recursive: true });
  writeFileSync(join(unitDirOf(home), 'idd-engine.service'), '[Service]\nExecStart=/usr/bin/env IDD_STATE_DIR=/srv/hand/state /x/bin/idd-engine\n');
  assertOk(install({ home }).res);
  assert.equal(readRecord(home).state_dir, undefined);
  assert.match(readUnit(home, 'idd-engine.service'), /IDD_STATE_DIR=\/srv\/hand\/state/, 'the hand-written unit is left as it was');
});

test('off a tag, both may be left out and the engine keeps the replacement it always had', () => {
  const { home, res } = install();
  assertOk(res);
  const engine = readUnit(home, 'idd-engine.service');
  assert.match(engine, /^ExecStart=\/\S+\/bin\/idd-engine$/m, 'no pointers, no env prefix');
  assert.doesNotMatch(engine, /IDD_RELOAD/);
  const record = readRecord(home);
  assert.equal(record.state_dir, undefined);
  assert.equal(record.pointers_commit, undefined);
});

test('the wrapper exports the recorded pointers only when the caller did not pass its own', () => {
  const checkout = fakeCheckout();
  // the fake bin/idd prints what it was started with
  writeFileSync(join(checkout, 'bin', 'idd'), '#!/usr/bin/env bash\necho "$IDD_STATE_DIR|$IDD_PI_BIN"\n');
  const { home } = install({ checkout, answers: onTag, ...POINTERS });
  const wrapper = join(home, '.local', 'bin', 'idd');
  const clean = { PATH: process.env.PATH, HOME: home };
  assert.equal(execFileSync(wrapper, [], { env: clean, encoding: 'utf8' }).trim(), '/srv/idd/state|/opt/pi/bin/pi');
  assert.equal(execFileSync(wrapper, [], { env: { ...clean, IDD_STATE_DIR: '/tmp/mine' }, encoding: 'utf8' }).trim(), '/tmp/mine|/opt/pi/bin/pi', 'a value that was passed comes first');
});

test('a path with a space or a percent is written so systemd reads it back unchanged', () => {
  const units = renderUnits({ checkout: '/co', path: '/usr/bin', stateDir: '/srv/my state/100%$x', piBin: '/opt/pi' });
  const engine = units.find((u) => u.name === 'idd-engine.service').body;
  assert.match(engine, /"IDD_STATE_DIR=\/srv\/my state\/100%%\$\$x"/);
});

/** the fake runner's answer for git: nothing under the outputs is tracked */
const UNTRACKED = { 'git ls-files -- .next next-env.d.ts': { ok: true, stdout: '', stderr: '' } };

/** install into a fresh home and a fake checkout that holds the old screen's output; `hold` may put more in either */
function installWithOldScreen(answers, hold = () => {}) {
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = 'fake-systemctl';
  try {
    const home = tmpDir('idd-install-home-');
    const checkout = fakeCheckout();
    layOldScreenOutput(checkout);
    hold(checkout, home);
    const res = runInstall({ home, checkout, runner: recorder(answers), placeSkills, path: '/usr/bin:/bin' });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    return { res, left: outputsLeft(checkout), said: (words, why = /./) => res.steps.some((s) => s.includes(words) && why.test(s)) };
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
}

test('install removes the old screen\'s build output, also with the unit it retires, and says so', () => {
  const managed = (checkout, home) => { mkdirSync(unitDirOf(home), { recursive: true }); writeFileSync(join(unitDirOf(home), 'idd-web.service'), '# idd-install: managed\n[Service]\nExecStart=next start\n'); };
  for (const hold of [undefined, managed]) {
    const { left, said } = installWithOldScreen(UNTRACKED, hold);
    assert.deepEqual(left, [], `with the unit: ${hold !== undefined}`);
    assert.ok(said('旧画面の build 出力を消しました', /\.next.*next-env\.d\.ts/));
  }
});

test('a checkout root that cannot be listed holds the build output, since a next.config could be in it', { skip: process.getuid?.() === 0 }, () => {
  const checkout = tmpDir('idd-install-co-');
  layOldScreenOutput(checkout);
  const runner = recorder(UNTRACKED);
  chmodSync(checkout, 0o111);
  try {
    const read = readLegacyWebOutputs(checkout, join(checkout, 'units'), runner);
    assert.deepEqual(read.present, BOTH_OUTPUTS);
    assert.match(read.heldBy ?? '', /root を読めない/);
    assert.equal(runner.calls.length, 0, 'it stops before asking git');
  } finally {
    chmodSync(checkout, 0o755);
  }
});

test('install keeps the build output while the old screen is still in the checkout, or git cannot say it is untracked, and says why', () => {
  const cases = [
    ['a package.json that depends on next', (checkout) => writeFileSync(join(checkout, 'package.json'), '{"devDependencies":{"next":"16.0.0"}}\n'), UNTRACKED, /package\.json が next に依存/],
    ['a next.config at the root', (checkout) => writeFileSync(join(checkout, 'next.config.mjs'), 'export default {};\n'), UNTRACKED, /next\.config\.mjs/],
    ['a hand-written idd-web.service', (checkout, home) => { mkdirSync(unitDirOf(home), { recursive: true }); writeFileSync(join(unitDirOf(home), 'idd-web.service'), '[Service]\n# hand-written\n'); }, UNTRACKED, /手書きの idd-web\.service/],
    ['files git tracks', undefined, { 'git ls-files -- .next next-env.d.ts': { ok: true, stdout: '.next/a.js\n', stderr: '' } }, /git が追跡している/],
    ['an answer git did not give', undefined, {}, /確かめられませんでした/],
  ];
  for (const [label, hold, answers, why] of cases) {
    const { left, said } = installWithOldScreen(answers, hold);
    assert.deepEqual(left, BOTH_OUTPUTS, `${label}: nothing is removed`);
    assert.ok(said('消しませんでした', why), label);
  }
});

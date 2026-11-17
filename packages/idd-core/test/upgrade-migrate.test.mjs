import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMigrate } from '../src/install/migrate.ts';
import { runUpgrade } from '../src/install/upgrade.ts';
import { readAppliedMigrations, writeInstallRecord, migrationsRecordPath, pointersOrigin } from '../src/install/records.ts';
import { defaultRunner } from '../src/install/proc.ts';
import { BOTH_OUTPUTS, layOldScreenOutput, outputsLeft } from './helpers/old-screen.mjs';
import { tmpDir } from './helpers/tmp.mjs';

for (const k of ['IDD_REPOS_FILE', 'IDD_ROLES_FILE', 'IDD_MODES_FILE']) delete process.env[k];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** a bare remote with v0.0.1 and v0.0.2, and a clone checked out at v0.0.1 (HEAD on a tag) */
function taggedRemote() {
  const root = tmpDir('idd-up-');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(seed, 'README.md'), '# x\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'v1');
  git(seed, 'tag', 'v0.0.1');
  writeFileSync(join(seed, 'README.md'), '# x2\n');
  git(seed, 'commit', '-qam', 'v2');
  git(seed, 'tag', 'v0.0.2');
  writeFileSync(join(seed, 'README.md'), '# x3\n');
  git(seed, 'commit', '-qam', 'after the tags');
  const bare = join(root, 'remote.git');
  git(root, 'clone', '-q', '--bare', seed, bare);
  const onTag = join(root, 'on-tag');
  git(root, 'clone', '-q', '--branch', 'v0.0.1', bare, onTag);
  const onBranch = join(root, 'on-branch');
  git(root, 'clone', '-q', bare, onBranch);
  return { root, bare, onTag, onBranch };
}

/** a fake systemctl that answers active or inactive, per the unit */
function fakeSystemctl(answer) {
  const dir = tmpDir('idd-up-bin-');
  const path = join(dir, 'systemctl');
  const code = answer === 'active' ? 0 : 3;
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do case "$a" in idd-engine.service|idd-web.service|idd-tick.timer) echo ${answer}; exit ${code};; esac; done\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

/** a fake systemctl that logs every call and answers `active` to is-active for the one unit it is told, `inactive` for the rest */
function loggingSystemctl(activeUnit) {
  const dir = tmpDir('idd-up-bin-');
  const path = join(dir, 'systemctl');
  const log = join(dir, 'calls.log');
  writeFileSync(path, `#!/bin/sh\necho "$*" >> ${log}\nif [ "$2" = is-active ]; then if [ "$3" = "${activeUnit}" ]; then echo active; exit 0; fi; echo inactive; exit 3; fi\nexit 0\n`);
  chmodSync(path, 0o755);
  return { path, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function recordingRunner(base = defaultRunner) {
  const calls = [];
  return {
    calls,
    run(cmd, args, opts) { calls.push({ kind: 'run', cmd, args }); return base.run(cmd, args, opts); },
    capture(cmd, args, opts) { calls.push({ kind: 'capture', cmd, args }); return base.capture(cmd, args, opts); },
  };
}

/** the commit a checkout's HEAD names: the fake runner answers it too, so a bundle stamped with it is current */
const headOf = (checkout) => git(checkout, 'rev-parse', 'HEAD');

/** a runner that records and runs nothing: for the stages where executing npm would be heavy */
function fakeRunner() {
  const calls = [];
  return {
    calls,
    run(cmd, args) { calls.push({ kind: 'run', cmd, args }); },
    capture(cmd, args, opts) {
      calls.push({ kind: 'capture', cmd, args });
      if (cmd === 'git' && args[0] === 'rev-parse') return { ok: true, stdout: `${headOf(opts.cwd)}\n`, stderr: '' };
      if (cmd === 'git' && args[0] === 'describe') return { ok: true, stdout: 'v0.0.1\n', stderr: '' };
      return { ok: false, stdout: '', stderr: '' };
    },
  };
}

/** what install wrote for a run clone: the pointers, and the first tag's commit as the commit that carried them */
const POINTERS = { state_dir: '/srv/idd/state', pi_bin: '/opt/pi/bin/pi' };
function recordPointers(home, checkout, extra = {}) {
  writeInstallRecord({ schema: 1, checkout, version: 'v0.0.1', installed_at: 'now', ...POINTERS, pointers_commit: git(checkout, 'rev-parse', 'v0.0.1'), ...extra }, home);
}

const recordFile = (home) => join(home, '.config', 'idd', 'install.json');
const readRecord = (home) => JSON.parse(readFileSync(recordFile(home), 'utf8'));
const unitDir = (home) => join(home, '.config', 'systemd', 'user');
const readUnit = (home, name) => readFileSync(join(unitDir(home), name), 'utf8');

/** the dependencies and the screen's bundle a checkout has once install's heavy stages ran */
function layBuild(checkout, commit = headOf(checkout)) {
  mkdirSync(join(checkout, 'node_modules'), { recursive: true });
  mkdirSync(join(checkout, 'packages', 'idd-gui', 'dist'), { recursive: true });
  writeFileSync(join(checkout, 'packages', 'idd-gui', 'dist', 'build.json'), `${JSON.stringify({ commit })}\n`);
}

/** a run clone on v0.0.1 whose record holds the pointers */
function cloneWithPointers() {
  const { onTag } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  recordPointers(home, onTag);
  return { onTag, home };
}

/** the same, with the heavy stages laid down */
function builtRunClone() {
  const clone = cloneWithPointers();
  layBuild(clone.onTag);
  return clone;
}

/** a spawnStage that records what was handed to the new version and succeeds */
const handOver = (spawned) => (b, args) => { spawned.push(args); return { ok: true, code: 0, stdout: '{}', stderr: '' }; };

const placeSkills = () => ({ ok: true, source: '', agents: '', claude: '', installed: [], removed: [] });

test('migrate applies the steps once, in order, and never twice', () => {
  const home = tmpDir('idd-mig-home-');
  const made = [];
  const one = { id: 'a', target: 'config', summary: 'a', apply: (ctx) => { made.push('a'); writeFileSync(join(ctx.home, 'a'), '1\n'); return { changed: true }; } };
  const two = { id: 'b', target: 'unit', summary: 'b', apply: () => { made.push('b'); return { changed: false, detail: 'なし' }; } };
  const first = runMigrate({ home, migrations: [one, two] });
  assert.equal(first.ok, true);
  assert.deepEqual(first.applied, ['a', 'b']);
  assert.deepEqual(made, ['a', 'b']);
  assert.deepEqual(readAppliedMigrations(home), ['a', 'b']);
  made.length = 0;
  const second = runMigrate({ home, migrations: [one, two] });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['a', 'b']);
  assert.deepEqual(made, [], 'nothing runs twice');
});

test('a partial record runs only the missing step; a failing step stops and is not recorded', () => {
  const home = tmpDir('idd-mig-home-');
  mkdirSync(join(home, '.config', 'idd'), { recursive: true });
  writeFileSync(migrationsRecordPath(home), JSON.stringify({ schema: 1, applied: ['a'] }));
  const made = [];
  const a = { id: 'a', target: 'config', summary: 'a', apply: () => { made.push('a'); return { changed: true }; } };
  const b = { id: 'b', target: 'config', summary: 'b', apply: () => { made.push('b'); return { changed: true }; } };
  assert.deepEqual(runMigrate({ home, migrations: [a, b] }).applied, ['b']);
  assert.deepEqual(made, ['b']);
  const home2 = tmpDir('idd-mig-home-');
  const fail = { id: 'x', target: 'state', summary: 'x', apply: () => { throw new Error('nope'); } };
  const after = { id: 'y', target: 'state', summary: 'y', apply: () => { made.push('y'); return { changed: true }; } };
  const res = runMigrate({ home: home2, migrations: [fail, after] });
  assert.equal(res.ok, false);
  assert.equal(res.failed.id, 'x');
  assert.deepEqual(res.applied, []);
  assert.deepEqual(readAppliedMigrations(home2), [], 'the failing step is not recorded');
  assert.equal(made.includes('y'), false, 'nothing after the failure runs');
});

test('re-running install leaves the migration record alone (INV-767)', () => {
  const home = tmpDir('idd-mig-home-');
  const a = { id: 'a', target: 'config', summary: 'a', apply: () => ({ changed: true }) };
  runMigrate({ home, migrations: [a] });
  writeInstallRecord({ schema: 1, checkout: '/co', version: 'v1', installed_at: 'now' }, home);
  assert.deepEqual(readAppliedMigrations(home), ['a']);
  assert.deepEqual(runMigrate({ home, migrations: [a] }).applied, []);
});

test('upgrade moves the checkout to the tag and hands the later stages to the new version bin', () => {
  const { onTag, home } = cloneWithPointers();
  const bin = fakeSystemctl('inactive');
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = bin;
  try {
    const spawned = [];
    const res = runUpgrade({ home, checkout: onTag, to: 'v0.0.2', runner: recordingRunner(), placeSkills, spawnStage: (b, args) => { spawned.push({ b, args }); return { ok: true, code: 0, stdout: '', stderr: '' }; } });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(git(onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.2');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].b, join(onTag, 'bin', 'idd'));
    assert.deepEqual(spawned[0].args, ['upgrade', '--here', '--reinstall'], 'a tag change tells the new process to lay the dependencies and build down again');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('upgrade stops on a dirty checkout and on a development checkout, changing nothing', () => {
  const { onTag, onBranch } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  const bin = fakeSystemctl('inactive');
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = bin;
  try {
    const dirty = recordingRunner();
    writeFileSync(join(onTag, 'README.md'), '# dirty\n');
    const d = runUpgrade({ home, checkout: onTag, to: 'v0.0.2', runner: dirty });
    assert.equal(d.blocked, 'dirty');
    assert.equal(git(onTag, 'rev-parse', 'HEAD'), git(onTag, 'rev-parse', 'v0.0.1'));
    assert.equal(dirty.calls.some((c) => c.args.includes('fetch')), false, 'no fetch on a dirty checkout');
    const dev = runUpgrade({ home, checkout: onBranch, to: 'v0.0.2', runner: recordingRunner() });
    assert.equal(dev.blocked, 'not-a-tag');
    assert.throws(() => git(onBranch, 'describe', '--tags', '--exact-match', 'HEAD'), 'the branch is not on a tag');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('upgrade --here --reinstall lays the dependencies and the screen\'s bundle down again; --here alone leaves them', () => {
  const { onTag, home } = cloneWithPointers();
  layBuild(onTag);
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    // both artifacts are present, so --here alone must not touch them (DEC-1522's guard for a dev checkout)
    const plain = fakeRunner();
    const kept = runUpgrade({ home, checkout: onTag, here: true, runner: plain, placeSkills });
    assert.equal(kept.ok, true, JSON.stringify(kept.errors));
    assert.equal(plain.calls.some((c) => c.cmd === 'npm'), false, '--here alone runs no npm step while both exist');
    // the tag-changing path tells the new process to reinstall: it runs even though both are present
    const forced = fakeRunner();
    const res = runUpgrade({ home, checkout: onTag, here: true, reinstall: true, runner: forced, placeSkills });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    const npm = forced.calls.filter((c) => c.cmd === 'npm').map((c) => c.args.join(' '));
    assert.deepEqual(npm, ['ci', 'run build:gui'], `npm ci and the bundle's build run again: ${npm.join(', ')}`);
    assert.ok(res.steps.some((s) => s.includes('入れ直しました')), 'the step says it laid them down again');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('upgrade builds the screen\'s bundle when it is missing or is not the checkout\'s head, and leaves a current one', () => {
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    const cases = [['none', null, true], ['an earlier commit', 'b'.repeat(40), true], ['the head', 'head', false]];
    for (const [label, commit, builds] of cases) {
      const { onTag, home } = cloneWithPointers();
      mkdirSync(join(onTag, 'node_modules'), { recursive: true });
      if (commit) layBuild(onTag, commit === 'head' ? undefined : commit);
      const runner = fakeRunner();
      const res = runUpgrade({ home, checkout: onTag, here: true, runner, placeSkills });
      assert.equal(res.ok, true, `${label}: ${JSON.stringify(res.errors)}`);
      const npm = runner.calls.filter((c) => c.cmd === 'npm').map((c) => c.args.join(' '));
      assert.deepEqual(npm, builds ? ['run build:gui'] : [], label);
    }
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('upgrade to the tag it is already on does not tell the new process to reinstall', () => {
  const { onTag, home } = cloneWithPointers();
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    const spawned = [];
    const res = runUpgrade({ home, checkout: onTag, to: 'v0.0.1', runner: recordingRunner(), placeSkills, spawnStage: (b, args) => { spawned.push(args); return { ok: true, code: 0, stdout: '', stderr: '' }; } });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.deepEqual(spawned[0], ['upgrade', '--here'], 'the installed version equals the target: nothing to lay down again');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('a retry after a failed tag change lays the dependencies down again', () => {
  const { onTag, home } = cloneWithPointers();
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    const firstArgs = [];
    const first = runUpgrade({ home, checkout: onTag, to: 'v0.0.2', runner: recordingRunner(), spawnStage: (b, args) => { firstArgs.push(args); return { ok: false, code: 1, stdout: JSON.stringify({ ok: false, errors: ['npm ci に失敗しました: boom'] }), stderr: '' }; } });
    assert.equal(first.ok, false);
    assert.ok(firstArgs[0].includes('--reinstall'));
    // the child failed after the checkout moved: HEAD is on the new tag while install.json still names the old one
    assert.equal(git(onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.2');
    assert.equal(JSON.parse(readFileSync(join(home, '.config', 'idd', 'install.json'), 'utf8')).version, 'v0.0.1');
    const retryArgs = [];
    const retry = runUpgrade({ home, checkout: onTag, runner: recordingRunner(), spawnStage: (b, args) => { retryArgs.push(args); return { ok: true, code: 0, stdout: '{}', stderr: '' }; } });
    assert.equal(retry.ok, true, JSON.stringify(retry.errors));
    assert.ok(retryArgs[0].includes('--reinstall'), 'install.json still names the old version, so the retry must reinstall');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('an upgrade that moves the checkout reinstalls even when install.json already names the target', () => {
  const { onTag } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  // a failed upgrade left the checkout on v0.0.2 while install.json still names v0.0.1; now roll back to v0.0.1
  git(onTag, 'checkout', '-q', 'v0.0.2');
  recordPointers(home, onTag);
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    const spawned = [];
    const res = runUpgrade({ home, checkout: onTag, to: 'v0.0.1', runner: recordingRunner(), placeSkills, spawnStage: handOver(spawned) });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(git(onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.1');
    assert.ok(spawned[0].includes('--reinstall'), 'the checkout moved, so the dependencies and the build must be laid down again');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('a failed new-version process reports the child result errors, even when its stderr is empty', () => {
  const { onTag, home } = cloneWithPointers();
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    const res = runUpgrade({ home, checkout: onTag, to: 'v0.0.2', runner: recordingRunner(), spawnStage: () => ({ ok: false, code: 1, stdout: `${JSON.stringify({ ok: false, errors: ['npm run build:gui に失敗しました: boom'] })}\n`, stderr: '' }) });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('npm run build:gui に失敗しました: boom')), `the child's errors reach the parent: ${res.errors.join(' / ')}`);
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('upgrade --here runs the stages without moving the tag, and a live unit stops both forms', () => {
  const { onTag, home } = builtRunClone();
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    const head = git(onTag, 'rev-parse', 'HEAD');
    const migrated = [];
    const migration = { id: 'm', target: 'config', summary: 'm', apply: () => { migrated.push('m'); return { changed: true }; } };
    const res = runUpgrade({ home, checkout: onTag, here: true, runner: recordingRunner(), placeSkills, migrations: [migration] });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(git(onTag, 'rev-parse', 'HEAD'), head, '--here does not move the checkout');
    assert.deepEqual(migrated, ['m'], 'the migration stage ran');
    assert.ok(existsSync(join(home, '.config', 'idd', 'install.json')));
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('active');
  try {
    const live = recordingRunner();
    const blocked = runUpgrade({ home, checkout: onTag, to: 'v0.0.2', runner: live });
    assert.equal(blocked.blocked, 'running-units');
    assert.deepEqual(blocked.units.sort(), ['idd-engine.service', 'idd-tick.timer', 'idd-web.service'], 'an old screen unit that is running without a unit of ours is held too');
    assert.ok(blocked.stopCommands.some((c) => c.includes('systemctl --user stop idd-engine.service')));
    assert.equal(live.calls.some((c) => c.args.includes('fetch')), false, 'no fetch while a unit is live');
    assert.equal(live.calls.some((c) => c.args.includes('checkout')), false);
    const hereLive = recordingRunner();
    const hereBlocked = runUpgrade({ home, checkout: onTag, here: true, runner: hereLive, placeSkills });
    assert.equal(hereBlocked.blocked, 'running-units', '--here is held too');
    assert.equal(hereLive.calls.some((c) => c.cmd === 'npm'), false, 'no npm ci / build while a unit is live');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('upgrade stops, disables and removes the old screen\'s unit that install wrote, and leaves a hand-written one running and refused', () => {
  const MARK = '# idd-install: managed';
  const { onTag, home } = builtRunClone();
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  try {
    // ours and running: the run itself stops it before npm ci could replace what it runs on
    const sys = loggingSystemctl('idd-web.service');
    process.env.IDD_SYSTEMCTL_BIN = sys.path;
    mkdirSync(unitDir(home), { recursive: true });
    writeFileSync(join(unitDir(home), 'idd-web.service'), `${MARK}\n[Service]\nExecStart=next start\n`);
    const res = runUpgrade({ home, checkout: onTag, here: true, runner: recordingRunner(), placeSkills });
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(existsSync(join(unitDir(home), 'idd-web.service')), false, 'the old unit is removed');
    const calls = sys.calls();
    const stopAt = calls.indexOf('--user stop idd-web.service');
    assert.ok(stopAt >= 0 && calls.indexOf('--user disable idd-web.service') > stopAt, `stopped, then disabled: ${calls.join(' | ')}`);
    assert.ok(calls.indexOf('--user daemon-reload') > calls.indexOf('--user disable idd-web.service'), 'daemon-reload after the removal');
    assert.ok(res.steps.some((step) => step.includes('idd-web.service') && step.includes('外しました')));
    assert.ok(existsSync(join(unitDir(home), 'idd-engine.service')), 'the engine unit is placed');

    // hand-written and running: not touched, and it holds the run (npm ci would break it)
    const handHome = tmpDir('idd-up-home-');
    recordPointers(handHome, onTag);
    mkdirSync(unitDir(handHome), { recursive: true });
    writeFileSync(join(unitDir(handHome), 'idd-web.service'), '[Service]\n# hand-written\n');
    const hand = loggingSystemctl('idd-web.service');
    process.env.IDD_SYSTEMCTL_BIN = hand.path;
    const held = runUpgrade({ home: handHome, checkout: onTag, here: true, runner: recordingRunner(), placeSkills });
    assert.equal(held.blocked, 'running-units');
    assert.deepEqual(held.units, ['idd-web.service']);
    assert.equal(existsSync(join(unitDir(handHome), 'idd-web.service')), true);
    assert.equal(hand.calls().some((c) => c.includes('stop') || c.includes('disable')), false);
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

test('upgrade --here that cannot place the skills fails, and still records the stages that went through', () => {
  const { onTag, home } = builtRunClone();
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl('inactive');
  try {
    const migrated = [];
    const migration = { id: 'm', target: 'config', summary: 'm', apply: () => { migrated.push('m'); return { changed: true }; } };
    const failing = () => ({ ok: false, source: '', agents: '', claude: '', installed: [], removed: [], error: 'the place is a symlink into a checkout' });
    const res = runUpgrade({ home, checkout: onTag, here: true, runner: recordingRunner(), placeSkills: failing, migrations: [migration] });
    assert.equal(res.ok, false, 'a skills failure is not an ok upgrade');
    assert.ok(res.errors.some((e) => e.includes('skills を置けませんでした') && e.includes('symlink')), JSON.stringify(res.errors));
    assert.deepEqual(migrated, ['m'], 'the stages after the skills still ran');
    assert.ok(existsSync(join(home, '.config', 'idd', 'install.json')), 'install.json records the version the stages laid down');
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
});

/** run `body` with IDD_SYSTEMCTL_BIN standing in for systemctl */
function withSystemctl(answer, body) {
  const prev = process.env.IDD_SYSTEMCTL_BIN;
  process.env.IDD_SYSTEMCTL_BIN = fakeSystemctl(answer);
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.IDD_SYSTEMCTL_BIN; else process.env.IDD_SYSTEMCTL_BIN = prev;
  }
}

test('one upgrade --to the previous tag moves back, when that tag holds the commit that carried the pointers', () => withSystemctl('inactive', () => {
  const { onTag } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  git(onTag, 'fetch', '-q', '--tags');
  git(onTag, 'checkout', '-q', 'v0.0.2');
  recordPointers(home, onTag, { version: 'v0.0.2' });
  const spawned = [];
  const res = runUpgrade({ home, checkout: onTag, to: 'v0.0.1', runner: recordingRunner(), spawnStage: handOver(spawned) });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(git(onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.1');
  assert.equal(spawned.length, 1, 'the later stages are handed over once');
}));

test('a tag that does not hold the commit that carried the pointers is refused with the checkout left where it was', () => withSystemctl('inactive', () => {
  const { onTag } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  git(onTag, 'fetch', '-q', '--tags');
  git(onTag, 'checkout', '-q', 'v0.0.2');
  // the pointers were first carried by v0.0.2, so v0.0.1 (before it) would drop to the run clone's own state
  recordPointers(home, onTag, { version: 'v0.0.2', pointers_commit: git(onTag, 'rev-parse', 'v0.0.2') });
  const runner = recordingRunner();
  const spawned = [];
  const res = runUpgrade({ home, checkout: onTag, to: 'v0.0.1', runner, spawnStage: handOver(spawned) });
  assert.equal(res.ok, false);
  assert.equal(res.blocked, 'below-floor');
  assert.match(res.errors.join(' '), /v0\.0\.1/);
  assert.equal(git(onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.2', 'the checkout did not move');
  assert.equal(runner.calls.some((c) => c.args.includes('checkout')), false);
  assert.deepEqual(spawned, [], 'nothing was handed to another version');
}));

/** a clone on v3 whose history is: v1 without the pointers mechanism, v2 that adds it, v3 after it */
function remoteWithMechanism() {
  const root = tmpDir('idd-up-mech-');
  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'bin'), { recursive: true });
  git(seed, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(seed, 'README.md'), '# x\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'v1');
  git(seed, 'tag', 'v1.0.0');
  writeFileSync(join(seed, 'bin', 'gateway-env.sh'), '# pointers\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'v2 adds the pointers mechanism');
  git(seed, 'tag', 'v2.0.0');
  const mechanism = git(seed, 'rev-parse', 'HEAD');
  writeFileSync(join(seed, 'README.md'), '# x3\n');
  git(seed, 'commit', '-qam', 'v3');
  git(seed, 'tag', 'v3.0.0');
  const bare = join(root, 'remote.git');
  git(root, 'clone', '-q', '--bare', seed, bare);
  const run = join(root, 'run');
  git(root, 'clone', '-q', '--branch', 'v3.0.0', bare, run);
  return { mechanism, run };
}

test('the floor is the commit that first added the pointers mechanism: the previous tag with it is reachable, one without it is refused', () => withSystemctl('inactive', () => {
  const { mechanism, run } = remoteWithMechanism();
  const home = tmpDir('idd-up-home-');
  assert.equal(pointersOrigin(run, defaultRunner), mechanism, 'not the HEAD the clone sits on');
  writeInstallRecord({ schema: 1, checkout: run, version: 'v3.0.0', installed_at: 'now', ...POINTERS, pointers_commit: pointersOrigin(run, defaultRunner) }, home);
  const refused = runUpgrade({ home, checkout: run, to: 'v1.0.0', runner: recordingRunner() });
  assert.equal(refused.blocked, 'below-floor');
  assert.equal(git(run, 'describe', '--tags', '--exact-match', 'HEAD'), 'v3.0.0', 'the checkout did not move');
  const spawned = [];
  const back = runUpgrade({ home, checkout: run, to: 'v2.0.0', runner: recordingRunner(), spawnStage: handOver(spawned) });
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  assert.equal(git(run, 'describe', '--tags', '--exact-match', 'HEAD'), 'v2.0.0');
  assert.equal(spawned.length, 1);
}));

test('no floor is recorded when git cannot name the commit that added the mechanism', () => {
  const { run } = remoteWithMechanism();
  const shallow = { ...defaultRunner, capture: (cmd, args, opts) => (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository' ? { ok: true, stdout: 'true\n', stderr: '' } : defaultRunner.capture(cmd, args, opts)) };
  assert.equal(pointersOrigin(run, shallow), null);
  const nothing = tmpDir('idd-up-mech-none-');
  git(nothing, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(nothing, 'a'), '1\n');
  git(nothing, 'add', '-A');
  git(nothing, 'commit', '-qm', 'no mechanism');
  assert.equal(pointersOrigin(nothing, defaultRunner), null);
});

test('a record with no commit for the pointers refuses to move rather than guess', () => withSystemctl('inactive', () => {
  const { onTag } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  recordPointers(home, onTag, { pointers_commit: undefined });
  const res = runUpgrade({ home, checkout: onTag, to: 'v0.0.2', runner: recordingRunner() });
  assert.equal(res.blocked, 'below-floor');
  assert.equal(git(onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.1');
}));

test('without the pointers in the record, upgrade stops before it moves or redraws anything', () => withSystemctl('inactive', () => {
  const { onTag } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  writeInstallRecord({ schema: 1, checkout: onTag, version: 'v0.0.1', installed_at: 'now' }, home);
  const moving = runUpgrade({ home, checkout: onTag, to: 'v0.0.2', runner: recordingRunner() });
  assert.equal(moving.blocked, 'no-pointers');
  assert.match(moving.errors.join(' '), /idd install/);
  assert.equal(git(onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.1');
  const runner = fakeRunner();
  const here = runUpgrade({ home, checkout: onTag, here: true, runner, placeSkills });
  assert.equal(here.blocked, 'no-pointers');
  assert.equal(runner.calls.some((c) => c.kind === 'run'), false, 'no npm, no daemon-reload');
  assert.equal(existsSync(join(home, '.config', 'systemd', 'user', 'idd-engine.service')), false, 'no unit was drawn');
}));

test('off a tag, upgrade --here without recorded pointers stops without redrawing the unit that carries them', () => withSystemctl('inactive', () => {
  const { onBranch } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  writeInstallRecord({ schema: 1, checkout: onBranch, version: 'abc1234', installed_at: 'now' }, home);
  mkdirSync(unitDir(home), { recursive: true });
  const unit = join(unitDir(home), 'idd-engine.service');
  const text = '# idd-install: managed\nExecStart=/usr/bin/env IDD_STATE_DIR=/srv/idd/state IDD_PI_BIN=/opt/pi/bin/pi /x/bin/idd-engine\n';
  writeFileSync(unit, text);
  const runner = recordingRunner();
  const res = runUpgrade({ home, checkout: onBranch, here: true, runner, placeSkills });
  assert.equal(res.blocked, 'no-pointers');
  assert.match(res.errors.join(' '), /IDD_STATE_DIR と IDD_PI_BIN/);
  assert.equal(runner.calls.some((c) => c.kind === 'run'), false, 'no npm, no daemon-reload');
  assert.equal(readFileSync(unit, 'utf8'), text, 'the unit keeps the values it carries');
}));

test('off a tag, upgrade --here with no pointers anywhere runs the later stages and draws units that carry none', () => withSystemctl('inactive', () => {
  const { onBranch } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  writeInstallRecord({ schema: 1, checkout: onBranch, version: 'abc1234', installed_at: 'now' }, home);
  layBuild(onBranch);
  const res = runUpgrade({ home, checkout: onBranch, here: true, placeSkills });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.blocked, undefined);
  assert.doesNotMatch(readUnit(home, 'idd-engine.service'), /IDD_STATE_DIR=|IDD_PI_BIN=|IDD_RELOAD=off/);
  assert.equal(readRecord(home).state_dir, undefined);
}));

test('off a tag, a unit carrying only one pointer the record lacks stops; a hand-written unit does not', () => withSystemctl('inactive', () => {
  const { onBranch } = taggedRemote();
  const home = tmpDir('idd-up-home-');
  writeInstallRecord({ schema: 1, checkout: onBranch, version: 'abc1234', installed_at: 'now', state_dir: '/srv/idd/state' }, home);
  mkdirSync(unitDir(home), { recursive: true });
  writeFileSync(join(unitDir(home), 'idd-engine.service'), '# idd-install: managed\nExecStart=/usr/bin/env IDD_STATE_DIR=/srv/idd/state IDD_PI_BIN=/opt/pi/bin/pi node x\n');
  const res = runUpgrade({ home, checkout: onBranch, here: true, placeSkills });
  assert.equal(res.blocked, 'no-pointers');
  assert.match(res.errors.join(' '), /IDD_PI_BIN/);
  assert.doesNotMatch(res.errors.join(' '), /IDD_STATE_DIR/);
  writeFileSync(join(unitDir(home), 'idd-engine.service'), '[Service]\nExecStart=/usr/bin/env IDD_STATE_DIR=/srv/idd/state IDD_PI_BIN=/opt/pi/bin/pi node x\n');
  const hand = runUpgrade({ home, checkout: onBranch, here: true, placeSkills });
  assert.equal(hand.blocked, undefined, 'a unit install did not write is never redrawn, so nothing is lost');
}));

test('a shallow clone without a floor is told to unshallow, and any other clone to run install again', () => withSystemctl('inactive', () => {
  const { bare, onTag, root } = taggedRemote();
  const shallow = join(root, 'shallow');
  git(root, 'clone', '-q', '--depth', '1', '--branch', 'v0.0.1', `file://${bare}`, shallow);
  for (const [checkout, expected] of [[shallow, /unshallow/], [onTag, /idd install を回し直して/]]) {
    const home = tmpDir('idd-up-home-');
    recordPointers(home, checkout, { pointers_commit: undefined });
    const res = runUpgrade({ home, checkout, to: 'v0.0.2', runner: recordingRunner() });
    assert.equal(res.blocked, 'below-floor');
    assert.match(res.errors.join(' '), expected);
    if (checkout === onTag) assert.doesNotMatch(res.errors.join(' '), /unshallow/);
  }
}));

test('upgrade --here redraws the units with the recorded pointers and keeps them in the record', () => withSystemctl('inactive', () => {
  const { onTag, home } = builtRunClone();
  const res = runUpgrade({ home, checkout: onTag, here: true, runner: fakeRunner(), placeSkills });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  for (const unit of ['idd-engine.service', 'idd-tick.service']) {
    assert.match(readUnit(home, unit), /IDD_STATE_DIR=\/srv\/idd\/state.*IDD_PI_BIN=\/opt\/pi\/bin\/pi/, unit);
  }
  assert.match(readUnit(home, 'idd-engine.service'), /IDD_RELOAD=off/, 'a unit drawn on a tag does not replace itself');
  const record = readRecord(home);
  assert.equal(record.state_dir, '/srv/idd/state');
  assert.equal(record.pi_bin, '/opt/pi/bin/pi');
  assert.equal(record.pointers_commit, git(onTag, 'rev-parse', 'v0.0.1'), 'the commit is install\'s, not rewritten by an upgrade');
}));

/** a run clone on v0.0.1 whose root holds the old screen's build output; `arrange` may change it further, `built` lays the dependencies and bundle (untracked, so not for a tag change) */
function cloneWithOldScreen(arrange = () => {}, { built = false } = {}) {
  const clone = built ? builtRunClone() : cloneWithPointers();
  layOldScreenOutput(clone.onTag);
  arrange(clone);
  return clone;
}
const upgradeTo = (clone, opts) => runUpgrade({ home: clone.home, checkout: clone.onTag, runner: recordingRunner(), placeSkills, spawnStage: handOver([]), ...opts });
const hasStep = (res, words, why = /./) => res.steps.some((s) => s.includes(words) && why.test(s));

test('upgrade --here removes the old screen\'s build output once the screen is gone, and says so', () => withSystemctl('inactive', () => {
  const clone = cloneWithOldScreen(undefined, { built: true });
  assert.match(git(clone.onTag, 'status', '--porcelain'), /\.next\//);
  const res = upgradeTo(clone, { here: true });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(outputsLeft(clone.onTag), []);
  assert.doesNotMatch(git(clone.onTag, 'status', '--porcelain'), /\.next|next-env/, 'what the screen built no longer shows as a change');
  assert.ok(hasStep(res, '旧画面の build 出力を消しました', /\.next.*next-env\.d\.ts/), res.steps.join('\n'));
}));

test('upgrade --here keeps the build output while the old screen is still in the checkout or its unit is hand-written, and says why', () => withSystemctl('inactive', () => {
  const cases = [
    ['a package.json that depends on next', ({ onTag }) => writeFileSync(join(onTag, 'package.json'), '{"dependencies":{"next":"16.0.0"}}\n'), /package\.json が next に依存/],
    ['a next.config at the root', ({ onTag }) => writeFileSync(join(onTag, 'next.config.ts'), 'export default {};\n'), /next\.config\.ts/],
    ['a hand-written idd-web.service', ({ home }) => { mkdirSync(unitDir(home), { recursive: true }); writeFileSync(join(unitDir(home), 'idd-web.service'), '[Service]\n# hand-written\n'); }, /手書きの idd-web\.service/],
  ];
  for (const [label, hold, why] of cases) {
    const clone = cloneWithOldScreen(hold, { built: true });
    const res = upgradeTo(clone, { here: true });
    assert.deepEqual(outputsLeft(clone.onTag), BOTH_OUTPUTS, `${label}: nothing is removed`);
    assert.ok(hasStep(res, '消しませんでした', why), `${label}: ${res.steps.join('\n')}`);
  }
}));

/** commit a file that holds the old screen on the checkout and tag the commit */
function commitScreen(onTag, file, content, tag) {
  writeFileSync(join(onTag, file), content);
  git(onTag, 'add', file);
  git(onTag, 'commit', '-qm', `the screen: ${file}`);
  git(onTag, 'tag', tag);
}
const NEXT_DEPENDENCY = '{"dependencies":{"next":"16.0.0"}}\n';

/** the checkout's tag depends on next (v0.0.1-screen) and so does the local tag `v0.0.3` it will move to, which also holds the screen's config */
function bothTagsHoldScreen({ onTag }) {
  commitScreen(onTag, 'package.json', NEXT_DEPENDENCY, 'v0.0.1-screen');
  commitScreen(onTag, 'next.config.ts', 'export default {};\n', 'v0.0.3');
  git(onTag, 'checkout', '-q', 'v0.0.1-screen');
}

test('an upgrade that changes the tag removes nothing when it stops on other work, on the old screen in the tag it moves to, or is refused for its tag or its floor', () => withSystemctl('inactive', () => {
  const cases = [
    ['other uncommitted work', ({ onTag }) => writeFileSync(join(onTag, 'README.md'), '# dirty\n'), 'dirty', 'v0.0.2', null],
    ['the old screen still in the tag it moves to', bothTagsHoldScreen, 'dirty', 'v0.0.3'],
    ['a hand-written idd-web.service', ({ home }) => { mkdirSync(unitDir(home), { recursive: true }); writeFileSync(join(unitDir(home), 'idd-web.service'), '[Service]\n# hand-written\n'); }, 'dirty', 'v0.0.2', /手書きの idd-web\.service/],
    ['not on a tag', ({ onTag }) => git(onTag, 'commit', '--allow-empty', '-qm', 'off the tag'), 'not-a-tag'],
    ['below the floor', ({ home, onTag }) => recordPointers(home, onTag, { pointers_commit: undefined }), 'below-floor'],
  ];
  for (const [label, arrange, blocked, to = 'v0.0.2', reason] of cases) {
    const clone = cloneWithOldScreen(arrange);
    const res = upgradeTo(clone, { to });
    assert.equal(res.blocked, blocked, `${label}: ${JSON.stringify(res)}`);
    // a stop on the output alone says why it stays; a stop on other work does not
    if (reason) assert.ok(hasStep(res, '未 commit の変更', reason), `${label}: ${res.steps.join('\n')}`);
    if (reason === null) assert.ok(!hasStep(res, '旧画面の build 出力を残す理由'), `${label}: ${res.steps.join('\n')}`);
    assert.deepEqual(outputsLeft(clone.onTag), BOTH_OUTPUTS, `${label}: nothing was removed`);
  }
}));

test('an upgrade that changes the tag is not stopped by the old screen\'s build output alone, whatever the checkout holds or shows of it, and removes it', () => withSystemctl('inactive', () => {
  const cases = [
    ['a checkout with nothing of the screen', () => {}],
    ['a tag that still depends on next, the tag moved to does not', ({ onTag }) => commitScreen(onTag, 'package.json', NEXT_DEPENDENCY, 'v0.0.1-screen')],
    ['a checkout that lists every file of an untracked dir', ({ onTag }) => git(onTag, 'config', 'status.showUntrackedFiles', 'all')],
  ];
  for (const [label, arrange] of cases) {
    const clone = cloneWithOldScreen(arrange);
    const res = upgradeTo(clone, { to: 'v0.0.2' });
    assert.equal(res.blocked, undefined, `${label}: ${JSON.stringify(res)}`);
    assert.equal(res.ok, true, `${label}: ${JSON.stringify(res.errors)}`);
    assert.equal(git(clone.onTag, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.0.2', label);
    assert.deepEqual(outputsLeft(clone.onTag), [], label);
    assert.doesNotMatch(git(clone.onTag, 'status', '--porcelain'), /\.next|next-env/, label);
    assert.ok(hasStep(res, '旧画面の build 出力を消しました'), `${label}: ${res.steps.join('\n')}`);
  }
}));

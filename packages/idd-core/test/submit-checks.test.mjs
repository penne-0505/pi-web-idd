import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { SHIPPED_REPOS, shippedSkip } from './helpers/shipped-repos.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { proposeForTests as propose, exportLane, readProposal, proposalPath, shipContentFor, laneLocations, baseReceiptPath } from '../src/overlay/export.ts';
import { proposeImport, reviewImport, importUpstream } from '../src/overlay/import.ts';
import { syncArea } from '../src/overlay/sync.ts';
import { parseRepos } from '../src/config/areas.ts';
import { key } from '../src/overlay/git.ts';
import { runChecks, blockingSummary } from '../src/overlay/gate.ts';
import { failureIdsOf, ranToEnd } from '../src/overlay/failure-ids.ts';
import { blockingFailures } from '../src/overlay/check-reason.ts';
import { nonBlockingFailures } from '../../../lib/idd-ui/check-warning.ts';
import { pushApproval } from './passkey-approval.mjs';
import { createChallenge } from '../src/passkey.ts';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const approveExport = (token, approval) => exportLane('IDD-1', token, pushApproval('IDD-1', approval));
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

/** a project with upstream / work clones and one lane; `extra` goes into its repos.yaml entry */
function setup(extra = {}) {
  process.chdir(original);
  const root = scratchDir('run-');
  const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n.env\nprep/\n'); put(join(work, 'app.txt'), 'one\n'); put(join(work, 'gone.txt'), 'bye\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'test'); git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  const areas = join(root, 'repos.yaml');
  const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' }, ...extra };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change' }) + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, executor_session_id: 'test-session' }) + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane };
}
const change = (f) => { put(join(f.lane.path, 'app.txt'), 'two\n'); commit(f.lane.path); };
const check = (p, name) => p.checks.find((c) => c.name === name);
const offered = (p) => { assert.ok(!p.error, p.error); return p; };
/** a change on the public main for the work branch to take in */
const publicMove = (f) => { put(join(f.upstream, 'external.txt'), 'their work\n'); git(f.upstream, 'add', '-A'); git(f.upstream, 'commit', '-m', 'external'); git(f.upstream, 'push', 'origin', 'main'); };
/** give the registered project a review_root under its fixture */
function reviewRoot(f) {
  const cfg = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  cfg.repos.demo.review_root = join(f.root, 'review');
  put(process.env.IDD_REPOS_FILE, JSON.stringify(cfg));
  return join(f.root, 'review', 'submit-checks');
}
/**
 * The fixture's worktrees that lie under the engine's submit-checks copy root. The copy is removed after a
 * check, so this must be empty; matching the review_root itself (not the bare words "review/submit-checks")
 * keeps the test readable when the whole suite runs inside such a copy.
 */
const submitCopyWorktrees = (work, place) => git(work, 'worktree', 'list')
  .split('\n')
  .map((l) => l.trim().split(/\s+/)[0])
  .filter((p) => p === place || p.startsWith(`${place}/`));

test('the repo setup runs in the snapshot before its checks, not in the lane, and neither sees the Linear key', async () => {
  const f = setup({ setup: ['test -z "${LINEAR_API_KEY:-}" && mkdir -p prep && echo ok > prep/ready'], checks: [{ name: 'prepared', command: 'test -f prep/ready && test -z "${LINEAR_API_KEY:-}"', required: true }] });
  change(f);
  process.env.LINEAR_API_KEY = 'lin_api_test';
  let p;
  try { p = offered(await propose('IDD-1')); } finally { delete process.env.LINEAR_API_KEY; }
  assert.equal(check(p, 'prepared').status, 'pass', JSON.stringify(p.checks));
  assert.equal(p.blocking, 0, JSON.stringify(p.checks));
  assert.equal(existsSync(join(f.lane.path, 'prep')), false);
});

test('the files named in copy come from the work clone into the snapshot, and their contents stay out of the record', async () => {
  const f = setup({ copy: ['.env', 'missing.env'], checks: [{ name: 'env', command: 'grep -q SECRET=s3cr3t .env', required: true }] });
  put(join(f.work, '.env'), 'SECRET=s3cr3t\n');
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'env').status, 'pass', JSON.stringify(p.checks));
  assert.doesNotMatch(readFileSync(proposalPath('IDD-1'), 'utf8'), /s3cr3t/);
});

test('a failed setup blocks the submission and runs none of the checks', async () => {
  const f = setup({ copy: ['.env'], setup: ['cat .env; echo broken >&2; exit 3'], checks: [{ name: 'after', command: 'true', required: true }] });
  put(join(f.work, '.env'), 'SECRET=s3cr3t\n');
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'setup').status, 'fail');
  assert.equal(check(p, 'setup').severity, 'blocking');
  assert.match(check(p, 'setup').detail, /broken/);
  assert.equal(check(p, 'after').status, 'skipped');
  assert.doesNotMatch(readFileSync(proposalPath('IDD-1'), 'utf8'), /s3cr3t/);
  assert.ok(p.blocking >= 1);
  assert.equal(approveExport(p.token).ok, false);
});

test('a direct export with no signature, or a nonce that was never checked, does not push', async () => {
  const f = setup();
  change(f);
  const p = offered(await propose('IDD-1'));
  // no signature at all
  const bare = exportLane('IDD-1', p.token, { message: 'feat: change' });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /署名/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing was pushed');
  // a challenge exists for exactly this content, but no signature over it was ever checked
  const content = shipContentFor('IDD-1', readProposal('IDD-1'), laneLocations('IDD-1'), { commitMessage: 'feat: change' });
  const { nonce } = createChallenge(content);
  const unchecked = exportLane('IDD-1', p.token, { message: 'feat: change', nonce });
  assert.equal(unchecked.ok, false);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing was pushed');
});

test('a setup that changes the submitted files blocks the submission', async () => {
  const f = setup({ setup: ['echo stray > stray.txt'], checks: [{ name: 'after', command: 'true', required: true }] });
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'setup').status, 'fail');
  assert.match(check(p, 'setup').detail, /stray\.txt/);
  assert.equal(check(p, 'after').status, 'skipped');
});

test('each check runs under its own timeout_minutes, and a check over it is cut with its processes', async () => {
  const f = setup({ checks: [
    { name: 'slow', command: 'sleep 20 & sleep 20; wait', required: true, timeout_minutes: 0.02 },
    { name: 'quick', command: 'sleep 1', required: true, timeout_minutes: 0.2 },
  ] });
  change(f);
  const started = Date.now();
  const p = offered(await propose('IDD-1'));
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`);
  assert.equal(check(p, 'slow').status, 'fail');
  assert.match(check(p, 'slow').detail, /時間の上限/);
  assert.equal(check(p, 'quick').status, 'pass', JSON.stringify(p.checks));
});

test('the snapshot is cut under the repo review_root and removed afterwards, with copies a dead process left', async () => {
  const where = join(scratchDir('where-'), 'out');
  const f = setup({ checks: [{ name: 'where', command: `pwd -P > ${JSON.stringify(where)}`, required: true }] });
  const place = reviewRoot(f);
  mkdirSync(place, { recursive: true });
  const stale = join(place, '999999-deadbeef');
  git(f.work, 'worktree', 'add', '--detach', stale, 'HEAD');
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'where').status, 'pass', JSON.stringify(p.checks));
  assert.ok(readFileSync(where, 'utf8').trim().startsWith(`${place}/`), readFileSync(where, 'utf8'));
  assert.deepEqual(readdirSync(place), []);
  assert.deepEqual(submitCopyWorktrees(f.work, place), []);
  assert.equal(readdirSync(join(f.state, 'overlay')).includes('checks') ? readdirSync(join(f.state, 'overlay', 'checks')).length : 0, 0);
});

test('the snapshot is removed even when a check locks it', async () => {
  const f = setup({ checks: [{ name: 'lock', command: 'git worktree lock --reason test "$PWD"', required: true }] });
  const place = reviewRoot(f);
  change(f);
  offered(await propose('IDD-1'));
  assert.deepEqual(readdirSync(place), []);
  assert.deepEqual(submitCopyWorktrees(f.work, place), []);
});

test('the checks get the files the submission changes from the public base, deletions left out', async () => {
  const out = join(scratchDir('changed-'), 'out');
  const f = setup({ checks: [{ name: 'changed', command: `tr '\\0' '\\n' < "$IDD_CHANGED_FILES" > ${JSON.stringify(out)}`, required: true }] });
  put(join(f.lane.path, 'app.txt'), 'two\n'); put(join(f.lane.path, 'lib/new file.dart'), 'void main() {}\n'); git(f.lane.path, 'rm', '-q', 'gone.txt'); commit(f.lane.path);
  const first = offered(await propose('IDD-1'));
  assert.equal(check(first, 'changed').status, 'pass', JSON.stringify(first.checks));
  assert.deepEqual(readFileSync(out, 'utf8').split('\n').filter(Boolean).sort(), ['app.txt', 'lib/new file.dart']);
  assert.equal(approveExport(first.token, { message: 'feat: first' }).ok, true);
  const saved = readProposal('IDD-1'); saved.status = 'complete'; writeFileSync(proposalPath('IDD-1'), JSON.stringify(saved));
  put(join(f.lane.path, 'second.txt'), 'more\n'); commit(f.lane.path);
  const next = offered(await propose('IDD-1'));
  assert.deepEqual(next.publish, ['second.txt']);
  assert.deepEqual(readFileSync(out, 'utf8').split('\n').filter(Boolean).sort(), ['app.txt', 'lib/new file.dart', 'second.txt']);
});

test('the values of a copied env file stay out of the record: trailing comments, text after a closing quote, escaped newlines', async () => {
  const env = [
    'API_KEY=abcdef123456 # prod key',
    'FRAG=hashfrag123456#frag',
    'QUOTED="zyxwvu987654" # comment',
    'PEM="-----BEGIN KEY-----\\nMIIEsecretbody1\\nMIIEsecretbody2\\n-----END KEY-----"',
    'MULTI="first-line-sec1',
    'second-line-sec2"',
    '',
  ].join('\n');
  const leak = 'cat .env; set -a; . ./.env; printf "%s\\n%s\\n%s\\n%s\\n" "$API_KEY" "$QUOTED" "$MULTI" "${FRAG%%#*}"; printf "%b\\n" "$PEM"; exit 1';
  const f = setup({ copy: ['.env'], checks: [{ name: 'leak', command: leak, required: true }] });
  put(join(f.work, '.env'), env);
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'leak').status, 'fail');
  const saved = readFileSync(proposalPath('IDD-1'), 'utf8');
  for (const secret of ['abcdef123456', 'hashfrag123456', 'zyxwvu987654', 'MIIEsecretbody1', 'MIIEsecretbody2', 'first-line-sec1', 'second-line-sec2']) assert.doesNotMatch(saved, new RegExp(secret), secret);
});

test('a copied file that is not an env file, or too large to read, keeps the whole output of a failure out of the record', async () => {
  const f = setup({ copy: ['secrets.json', 'big.env'], setup: ['cat secrets.json; tail -c 40 big.env; printf "%s-%s\\n" plain output; exit 3'], checks: [{ name: 'after', command: 'true', required: true }] });
  put(join(f.work, 'secrets.json'), '{"token": "jsonsecret999"}\n');
  put(join(f.work, 'big.env'), `${'A=x\n'.repeat(70_000)}TAIL=bigfilesecret888\n`);
  change(f);
  const p = offered(await propose('IDD-1'));
  const failed = check(p, 'setup');
  assert.equal(failed.status, 'fail');
  assert.match(failed.detail, /値を含みうる/);
  assert.doesNotMatch(failed.detail, /plain-output/);
  const saved = readFileSync(proposalPath('IDD-1'), 'utf8');
  assert.doesNotMatch(saved, /jsonsecret999/);
  assert.doesNotMatch(saved, /bigfilesecret888/);
});

test('a quoted value followed by more than a comment is taken as a file that cannot be read out', async () => {
  for (const line of [`KEY="abcdefgh"'ijklmnop'`, `KEY: 'it''s-a-secret-value'`]) {
    const f = setup({ copy: ['.env'], setup: ['printf "%s-%s\\n" plain output; exit 3'], checks: [{ name: 'after', command: 'true', required: true }] });
    put(join(f.work, '.env'), `${line}\n`);
    change(f);
    const failed = check(offered(await propose('IDD-1')), 'setup');
    assert.match(failed.detail, /値を含みうる/, line);
    assert.doesNotMatch(failed.detail, /plain-output/, line);
  }
});

test('no copy is cut when there is no check to run in it', async () => {
  const f = setup({ setup: ['exit 3'], checks: [{ name: 'docs', command: 'true', required: true, scope: 'records' }] });
  const place = reviewRoot(f);
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'setup'), undefined, JSON.stringify(p.checks));
  assert.equal(p.blocking, 0, JSON.stringify(p.checks));
  assert.equal(existsSync(place), false);
  // an import runs the records checks too: it cuts no copy only when the repo has no check at all
  const cfg = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  cfg.repos.demo.checks = [];
  put(process.env.IDD_REPOS_FILE, JSON.stringify(cfg));
  publicMove(f);
  assert.ok(!proposeImport('demo').error);
  const r = await reviewImport('demo');
  assert.equal(r.checks.find((c) => c.name === 'setup'), undefined, JSON.stringify(r.checks));
  assert.equal(existsSync(place), false);
});

test('a missing timeout(1) is named in the detail', async () => {
  const dir = scratchDir('no-timeout-');
  const saved = process.env.PATH;
  process.env.PATH = join(dir, 'empty');
  let r;
  try { [r] = await runChecks(dir, [{ name: 'x', command: ['true'], required: true }]); } finally { process.env.PATH = saved; }
  assert.equal(r.status, 'skipped');
  assert.match(r.detail, /timeout\(1\)/);
});


test('the checks of an import run in a prepared copy of the resolution under review_root, which is removed afterwards', async () => {
  const where = join(scratchDir('import-where-'), 'out');
  const f = setup({ copy: ['.env'], setup: ['mkdir -p prep && echo ok > prep/ready'], checks: [
    { name: 'prepared', command: `test -f prep/ready && grep -q SECRET=s3cr3t .env && pwd -P > ${JSON.stringify(where)}`, required: true, timeout_minutes: 1 },
    { name: 'changed', command: `grep -qz '^external.txt$' "$IDD_CHANGED_FILES"`, required: true },
  ] });
  put(join(f.work, '.env'), 'SECRET=s3cr3t\n');
  const place = reviewRoot(f);
  publicMove(f);
  const pending = proposeImport('demo');
  assert.ok(!pending.error, pending.error);
  const r = await reviewImport('demo');
  assert.ok(!r.error, r.error);
  assert.equal(r.checks.find((c) => c.name === 'prepared').status, 'pass', JSON.stringify(r.checks));
  assert.equal(r.checks.find((c) => c.name === 'changed').status, 'pass', JSON.stringify(r.checks));
  assert.ok(readFileSync(where, 'utf8').trim().startsWith(`${place}/`), readFileSync(where, 'utf8'));
  assert.equal(existsSync(join(pending.recovery, 'prep')), false, 'the setup does not run in the recovery itself');
  assert.equal(existsSync(join(f.work, 'prep')), false);
  assert.deepEqual(readdirSync(place), []);
  assert.deepEqual(submitCopyWorktrees(f.work, place), []);
  assert.equal(importUpstream('demo', r.token).ok, true);
});

test('an import whose setup fails is stopped, by sync too, without the copied values in what it reports', async () => {
  const f = setup({ copy: ['.env'], setup: ['cat .env; exit 3'], checks: [{ name: 'after', command: 'true', required: true }] });
  put(join(f.work, '.env'), 'SECRET=s3cr3t\n');
  const place = reviewRoot(f);
  publicMove(f);
  const head = git(f.work, 'rev-parse', 'HEAD');
  const r = await syncArea('demo');
  assert.equal(r.ok, false);
  assert.match(r.error, /setup/);
  assert.doesNotMatch(r.error, /s3cr3t/);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  const again = await reviewImport('demo');
  assert.equal(again.checks.find((c) => c.name === 'setup').status, 'fail');
  assert.equal(again.checks.find((c) => c.name === 'after').status, 'skipped');
  assert.doesNotMatch(JSON.stringify(again), /s3cr3t/);
  assert.equal(importUpstream('demo', again.token).ok, false);
  assert.deepEqual(readdirSync(place), []);
});

test('copy, setup and timeouts are read beside the area, so its config key does not move', async () => {
  const plain = parseRepos('repos:\n  o/p:\n    upstream: /u\n    work: /w\n    checks:\n      - { name: t, command: "true" }\n');
  const full = parseRepos('repos:\n  o/p:\n    upstream: /u\n    work: /w\n    copy: [.env]\n    setup: [make deps]\n    checks:\n      - { name: t, command: "true", timeout_minutes: 12 }\n');
  assert.equal(key(full.areas['o/p']), key(plain.areas['o/p']));
  assert.deepEqual(full.checkPrep['o/p'], { copy: ['.env'], setup: ['make deps'], timeouts: { t: 12 } });
  assert.deepEqual(plain.checkPrep['o/p'], { copy: [], setup: [], timeouts: {} });
  assert.throws(() => parseRepos('repos:\n  o/p:\n    upstream: /u\n    work: /w\n    checks:\n      - { name: t, command: "true", timeout_minutes: 0 }\n'), /timeout_minutes/);
});

/** the Flutter repo's checks as registered, run against a stand-in fvm that records what it was given */
function flutterCheck(name) {
  const text = readFileSync(SHIPPED_REPOS, 'utf8');
  const c = parseRepos(text).areas['Dayseum/daysai-flutter'].checks.find((x) => x.name === name);
  assert.ok(c, `no ${name} check`);
  return c.command;
}
function stubFvm(dir, body = '') {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  put(join(bin, 'fvm'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(join(dir, 'fvm-args'))}\n${body}\n`);
  chmodSync(join(bin, 'fvm'), 0o755);
  return bin;
}
const runIn = (cwd, argv, env) => {
  try { return { code: 0, out: execFileSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};

test('the Flutter format check formats only the changed .dart files and refuses to run without the list', { skip: shippedSkip }, async () => {
  const dir = scratchDir('flutter-');
  const bin = stubFvm(dir);
  const list = join(dir, 'changed'); writeFileSync(list, ['lib/a.dart', 'README.md', 'lib/b c.dart', ''].join('\0'));
  const cmd = flutterCheck('format');
  const env = { PATH: `${bin}:${process.env.PATH}` };
  assert.equal(runIn(dir, cmd, { ...env, IDD_CHANGED_FILES: list }).code, 0);
  const args = readFileSync(join(dir, 'fvm-args'), 'utf8').split('\n');
  assert.deepEqual(args.filter((a) => a.endsWith('.dart')), ['lib/a.dart', 'lib/b c.dart']);
  assert.ok(args.includes('--set-exit-if-changed') && args.includes('--output=none'), args.join(' '));
  const none = join(dir, 'none'); writeFileSync(none, '');
  assert.equal(runIn(dir, cmd, { ...env, IDD_CHANGED_FILES: none }).code, 0);
  const unset = { ...env }; const saved = process.env.IDD_CHANGED_FILES; delete process.env.IDD_CHANGED_FILES;
  try { assert.notEqual(runIn(dir, cmd, unset).code, 0); } finally { if (saved !== undefined) process.env.IDD_CHANGED_FILES = saved; }
});

test('the Flutter codegen and l10n checks compare the generated files before and after, so uncommitted outputs that regenerate the same pass', { skip: shippedSkip }, async () => {
  for (const [name, gen, other] of [['codegen', 'lib/model.g.dart', 'lib/other.freezed.dart'], ['l10n', 'lib/l10n/generated/app.dart', 'lib/l10n/generated/app_ja.dart']]) {
    const dir = scratchDir('flutter-');
    git(dir, 'init', '-q'); put(join(dir, gen), 'old\n'); put(join(dir, 'lib/main.dart'), 'x\n'); commit(dir);
    const cmd = flutterCheck(name);
    put(join(dir, gen), 'regenerated\n');
    const same = stubFvm(dir, `echo regenerated > ${gen}`);
    assert.equal(runIn(dir, cmd, { PATH: `${same}:${process.env.PATH}` }).code, 0, `${name}: uncommitted output that regenerates the same`);
    put(join(dir, other), 'untracked but current\n');
    const both = stubFvm(dir, `echo regenerated > ${gen}; echo 'untracked but current' > ${other}`);
    assert.equal(runIn(dir, cmd, { PATH: `${both}:${process.env.PATH}` }).code, 0, `${name}: untracked output that regenerates the same`);
    const drift = stubFvm(dir, `echo newer > ${gen}`);
    assert.notEqual(runIn(dir, cmd, { PATH: `${drift}:${process.env.PATH}` }).code, 0, `${name}: output that regeneration changes`);
  }
});

test('the Flutter codegen check fails on a generated file that is new or changed, and not on other files', { skip: shippedSkip }, async () => {
  const dir = scratchDir('flutter-');
  git(dir, 'init', '-q'); put(join(dir, 'lib/model.g.dart'), 'old\n'); put(join(dir, 'pubspec.lock'), 'a\n'); commit(dir);
  const cmd = flutterCheck('codegen');
  const quiet = stubFvm(dir, 'echo b > pubspec.lock');
  assert.equal(runIn(dir, cmd, { PATH: `${quiet}:${process.env.PATH}` }).code, 0);
  git(dir, 'checkout', '--', '.');
  const fresh = stubFvm(dir, 'echo new > lib/other.freezed.dart');
  assert.notEqual(runIn(dir, cmd, { PATH: `${fresh}:${process.env.PATH}` }).code, 0);
});

// --- the checks wait without holding the caller, and their reading does not change (DEC-2321 / DEC-2323) ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(20); }
  throw new Error('待ちが timeout しました');
}
/** a check command that marks that it started and then waits for the signal file */
const gateCommand = (started, signal) => ['bash', '-c', `touch ${JSON.stringify(started)}; while [ ! -f ${JSON.stringify(signal)} ]; do sleep 0.1; done`];
const gateShell = (started, signal) => `touch ${JSON.stringify(started)}; while [ ! -f ${JSON.stringify(signal)} ]; do sleep 0.1; done`;
/** run the check and assert a timer callback fired while it waited; resolves once the signal was given */
async function runsWhileWaiting(pending, started, signal) {
  await waitFor(() => existsSync(started));
  let ran = false;
  await new Promise((r) => setTimeout(() => { ran = true; r(); }, 30));
  assert.equal(ran, true, 'the event loop ran while the command waited');
  writeFileSync(signal, 'go');
  return pending;
}
const slowDir = (name) => { const dir = scratchDir(name); return { dir, started: join(dir, 'started'), signal: join(dir, 'signal') }; };

test('AC-005: a records check waits without holding the caller', async () => {
  const { started, signal } = slowDir('ac005-records-');
  const f = setup({ checks: [{ name: 'slow', command: gateCommand(started, signal), required: true, scope: 'records' }] });
  change(f);
  const p = offered(await runsWhileWaiting(propose('IDD-1'), started, signal));
  assert.equal(check(p, 'slow').status, 'pass');
});

test('AC-005: a public check waits without holding the caller', async () => {
  const { started, signal } = slowDir('ac005-public-');
  const f = setup({ checks: [{ name: 'slow', command: gateCommand(started, signal), required: true }] });
  change(f);
  const p = offered(await runsWhileWaiting(propose('IDD-1'), started, signal));
  assert.equal(check(p, 'slow').status, 'pass');
});

test('AC-005: a setup command waits without holding the caller', async () => {
  const { started, signal } = slowDir('ac005-setup-');
  const f = setup({ setup: [gateShell(started, signal)], checks: [{ name: 'after', command: 'true', required: true }] });
  change(f);
  const p = offered(await runsWhileWaiting(propose('IDD-1'), started, signal));
  assert.equal(p.checks.find((c) => c.name === 'setup')?.status, undefined);
  assert.equal(check(p, 'after').status, 'pass');
});

test('AC-005: an import check waits without holding the caller and still carries its checks and token', async () => {
  const { started, signal } = slowDir('ac005-import-');
  const f = setup({ checks: [{ name: 'slow', command: gateCommand(started, signal), required: true }] });
  publicMove(f);
  const pending = proposeImport('demo');
  assert.ok(!pending.error, pending.error);
  const r = await runsWhileWaiting(reviewImport('demo'), started, signal);
  assert.ok(!r.error, r.error);
  assert.ok(Array.isArray(r.checks), 'the checks came back');
  assert.ok(r.token, 'the token came back');
  assert.equal(r.checks.find((c) => c.name === 'slow').status, 'pass');
});

test('AC-010: a commit to the resolution during the import checks refuses the token at the accept', async () => {
  const { started, signal } = slowDir('ac010-import-');
  const f = setup({ checks: [{ name: 'slow', command: gateCommand(started, signal), required: true }] });
  publicMove(f);
  const pending = proposeImport('demo');
  assert.ok(!pending.error, pending.error);
  const pendingReview = reviewImport('demo');
  await waitFor(() => existsSync(started));
  // someone commits to the resolution while the checks run
  put(join(pending.recovery, 'extra.txt'), 'extra\n'); commit(pending.recovery);
  writeFileSync(signal, 'go');
  const r = await pendingReview;
  assert.ok(!r.error, r.error);
  assert.equal(importUpstream('demo', r.token).ok, false);
});

test('AC-009: a check whose output passes the cap is stopped and read as a failure', async () => {
  const dir = scratchDir('ac009-overflow-');
  const saved = process.env.IDD_GATE_OUTPUT_LIMIT;
  process.env.IDD_GATE_OUTPUT_LIMIT = '4096';
  let rows;
  try {
    rows = await runChecks(dir, [{ name: 'loud', command: ['bash', '-c', 'yes loud'], required: true }]);
  } finally {
    if (saved === undefined) delete process.env.IDD_GATE_OUTPUT_LIMIT; else process.env.IDD_GATE_OUTPUT_LIMIT = saved;
  }
  assert.equal(rows[0].status, 'fail');
  assert.match(rows[0].detail, /出力が上限を超えた/);
});

test('AC-009: the checks run one at a time in the configured order; a missing command is skipped and an inapplicable one is not run', async () => {
  const dir = scratchDir('ac009-order-');
  const order = join(dir, 'order.txt');
  const rows = await runChecks(dir, [
    { name: 'first', command: ['bash', '-c', `echo first-start >> ${JSON.stringify(order)}; sleep 0.3; echo first-end >> ${JSON.stringify(order)}`], required: true },
    { name: 'second', command: ['bash', '-c', `echo second-start >> ${JSON.stringify(order)}; echo second-end >> ${JSON.stringify(order)}`], required: true },
    { name: 'gone', command: ['idd-no-such-command-xyz'], required: true },
    { name: 'na', command: ['true'], required: false, applicable: false },
    { name: 'none', command: [], required: false },
  ]);
  assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), ['first-start', 'first-end', 'second-start', 'second-end']);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.gone.status, 'skipped');
  assert.equal(byName.na.status, 'not-applicable');
  assert.equal(byName.none.status, 'skipped');
});

test('AC-006: the repo commands go through one asynchronous wait, with no synchronous child process left', () => {
  const source = readFileSync(new URL('../src/overlay/gate.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bspawnSync\b|\bexecFileSync\b|\bexecSync\b/);
  assert.match(source, /\bspawn\(/);
});

// --- DEC-120-4: the engine's records checks are told which lane they run for, its public checks are not ---

/** the lane the records checks must name, and that the engine's own process environment must not leak into a public check */
async function withEngineLane(fn) {
  const saved = process.env.IDD_ID;
  process.env.IDD_ID = 'IDD-999';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.IDD_ID; else process.env.IDD_ID = saved;
  }
}

test('AC-007 / AC-009: a submit runs its records check as the lane and its public check with no lane, even when the engine has one', async () => {
  const recordsOut = join(scratchDir('submit-env-records-'), 'out');
  const publicOut = join(scratchDir('submit-env-public-'), 'out');
  const f = setup({ checks: [
    { name: 'records', command: `printf %s "\${IDD_ID-unset}" > ${JSON.stringify(recordsOut)}`, required: true, scope: 'records' },
    { name: 'public', command: `printf %s "\${IDD_ID-unset}" > ${JSON.stringify(publicOut)}`, required: true },
  ] });
  change(f);
  const p = offered(await withEngineLane(async () => propose('IDD-1')));
  assert.equal(check(p, 'records').status, 'pass', JSON.stringify(p.checks));
  assert.equal(check(p, 'public').status, 'pass', JSON.stringify(p.checks));
  assert.equal(readFileSync(recordsOut, 'utf8'), 'IDD-1');
  assert.equal(readFileSync(publicOut, 'utf8'), 'unset');
});

test('AC-008: an acceptance whose receipt names a lane runs its records check as that lane', async () => {
  const out = join(scratchDir('import-env-lane-'), 'out');
  const f = setup({ checks: [{ name: 'records', command: `printf %s "\${IDD_ID-unset}" > ${JSON.stringify(out)}`, required: true, scope: 'records' }] });
  publicMove(f);
  const pending = proposeImport('demo', { laneId: 'IDD-1' });
  assert.ok(!pending.error, pending.error);
  const r = await withEngineLane(async () => reviewImport('demo', { laneId: 'IDD-1' }));
  assert.ok(!r.error, r.error);
  assert.equal(readFileSync(out, 'utf8'), 'IDD-1');
});

test('AC-028: a repo-level acceptance names no lane, and the engine\'s own lane id does not leak into it', async () => {
  const out = join(scratchDir('import-env-area-'), 'out');
  const f = setup({ checks: [{ name: 'records', command: `printf %s "\${IDD_ID-unset}" > ${JSON.stringify(out)}`, required: true, scope: 'records' }] });
  publicMove(f);
  const pending = proposeImport('demo');
  assert.ok(!pending.error, pending.error);
  const r = await withEngineLane(async () => reviewImport('demo'));
  assert.ok(!r.error, r.error);
  assert.equal(readFileSync(out, 'utf8'), 'unset');
});

// --- a required check that fails at the lane's head is run again at the public base's tip (without the records) ---

/** the fixture's public base (and work branch) carries `fails.txt`, one failure id per line; the lane may add to it */
function baseFailing(extra = {}, ids = ['a']) {
  const f = setup(extra);
  put(join(f.work, 'fails.txt'), ids.map((x) => `${x}\n`).join(''));
  commit(f.work);
  put(join(f.upstream, 'fails.txt'), ids.map((x) => `${x}\n`).join('')); git(f.upstream, 'add', '-A'); git(f.upstream, 'commit', '-m', 'fails'); git(f.upstream, 'push', 'origin', 'main');
  git(f.lane.path, 'merge', '-q', '--no-edit', 'work-main');
  return f;
}
const PATTERN = '^FAIL (\\S+)$';
/**
 * A check that logs each run, does `before` (where `[ -f head.flag ]` tells the lane's head, which adds the flag, from
 * the public base), lists each line of fails.txt as `FAIL <copy path>/<id>`, and fails when there is any.
 */
const listing = (log, before = ':') => `echo run >> ${JSON.stringify(log)}; ${before}; while read -r t; do echo "FAIL $PWD/$t"; done < fails.txt; test ! -s fails.txt`;
const runs = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
const flagHead = (f) => { put(join(f.lane.path, 'head.flag'), 'x\n'); commit(f.lane.path); };
/** replace the fixture's checks in its registry */
function setChecks(checks) {
  const cfg = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  cfg.repos.demo.checks = checks;
  put(process.env.IDD_REPOS_FILE, JSON.stringify(cfg));
}
const keptResults = (f) => { const d = join(f.state, 'overlay', 'check-base'); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).length : 0; };

test('a required check that fails on the same failures at the public base does not hold the submit; one the lane adds does', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log), required: true, failure_id_pattern: PATTERN }] });
  change(f);
  const same = offered(await propose('IDD-1'));
  const row = check(same, 'suite');
  // read without the copy's own path, so the head and the base name the same failure
  assert.deepEqual(row.failureIds, ['a']);
  assert.equal(row.baseline?.verdict, 'preexisting', JSON.stringify(row));
  assert.equal(row.baseline.shared, 1);
  assert.equal(same.blocking, 0, JSON.stringify(same.checks));
  assert.equal(blockingFailures(same.checks).length, 0);
  assert.match(nonBlockingFailures(same.checks).map((w) => w.reason).join('\n'), /元から落ちている（公開 base の先端/);
  assert.match(blockingSummary(same.checks), /止めない失敗: suite/);
  put(join(f.lane.path, 'fails.txt'), 'a\nb\n'); commit(f.lane.path);
  const more = offered(await propose('IDD-1'));
  const added = check(more, 'suite');
  assert.equal(added.baseline?.verdict, 'new', JSON.stringify(added));
  assert.deepEqual(added.baseline.added, ['b']);
  assert.equal(more.blocking, 1);
  assert.match(blockingSummary(more.checks), /この lane で新しく落ちた 1 件（b。/);
  assert.match(blockingFailures(more.checks)[0].reason, /この lane で新しく落ちた/);
});

test('a check without failure_id_pattern, in a repo where another check has one, is not run at the public base: it holds, and says it cannot be compared', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log), required: true }, { name: 'named', command: 'true', required: true, failure_id_pattern: PATTERN }] });
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'suite').baseline?.verdict, 'unknown', JSON.stringify(check(p, 'suite')));
  assert.equal(p.blocking, 1);
  assert.equal(runs(log), 1, 'the head only');
  assert.match(blockingSummary(p.checks), /failure_id_pattern が無く識別子を比べられないので、元から落ちていても止まる/);
});

test('a repo with no failure_id_pattern at all compares nothing and says nothing of it', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log), required: true }] });
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'suite').baseline, undefined, JSON.stringify(check(p, 'suite')));
  assert.equal(p.blocking, 1);
  assert.equal(runs(log), 1);
  assert.doesNotMatch(blockingSummary(p.checks), /failure_id_pattern/);
});

test('a required check the lane breaks holds the submit, named as failing new in this lane', async () => {
  const f = setup({ checks: [{ name: 'suite', command: 'grep -q one app.txt || { echo "FAIL app"; exit 1; }', required: true, failure_id_pattern: PATTERN }] });
  change(f);
  const p = offered(await propose('IDD-1'));
  const row = check(p, 'suite');
  assert.equal(row.baseline?.verdict, 'new', JSON.stringify(row));
  assert.deepEqual(row.baseline.added, ['app']);
  assert.equal(p.blocking, 1);
  assert.match(blockingSummary(p.checks), /この lane で新しく落ちた 1 件（app）/);
});

test('a head failure that names no failure is not compared and holds, without a run at the public base', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}; echo broken; exit 1`, required: true, failure_id_pattern: PATTERN }] });
  change(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'suite').baseline?.verdict, 'unknown');
  assert.match(check(p, 'suite').baseline.reason, /head の出力に失敗の識別子がありません/);
  assert.equal(p.blocking, 1);
  assert.equal(runs(log), 1);
});

test('a run cut by its limit names no failure, even the ones it printed before it was cut', async () => {
  const dir = scratchDir('cut-');
  const [row] = await runChecks(dir, [{ name: 'suite', command: ['bash', '-c', 'echo "FAIL a"; sleep 20'], required: true }], { timeouts: { suite: 0.02 }, failureIds: { suite: { pattern: PATTERN } } });
  assert.equal(row.status, 'fail');
  assert.equal(row.failureIds, undefined);
  assert.equal(row.failureIdsUnread, 'cut');
  const [done] = await runChecks(dir, [{ name: 'suite', command: ['bash', '-c', 'echo "FAIL a"; exit 1'], required: true }], { failureIds: { suite: { pattern: PATTERN } } });
  assert.deepEqual(done.failureIds, ['a']);
  assert.equal(done.exitCode, 1);
});

test('M1: a head run ended by a signal (out of memory sends SIGKILL) is not read as failing at the public base: it holds', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log, '[ -f head.flag ] && { echo "FAIL a"; kill -9 $$; }'), required: true, failure_id_pattern: PATTERN }] });
  flagHead(f);
  const p = offered(await propose('IDD-1'));
  const row = check(p, 'suite');
  // timeout(1) ends itself with the command's signal, so no code comes back; a shell would say 137
  assert.ok(row.exitCode === null || row.exitCode >= 128, String(row.exitCode));
  assert.equal(row.failureIdsUnread, 'signal');
  assert.equal(row.baseline?.verdict, 'unknown', JSON.stringify(row));
  assert.match(row.baseline.reason, /head の検査が signal で終わりました/);
  assert.equal(p.blocking, 1);
});

test('a head run without the line its complete_pattern says a finished run prints is not compared, and holds', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log, '[ -f head.flag ] || echo DONE'), required: true, failure_id_pattern: PATTERN, complete_pattern: '^DONE$' }] });
  flagHead(f);
  const p = offered(await propose('IDD-1'));
  const row = check(p, 'suite');
  assert.equal(row.failureIdsUnread, 'incomplete');
  assert.equal(row.baseline?.verdict, 'unknown');
  assert.match(row.baseline.reason, /最後まで走った印（complete_pattern）がありません/);
  assert.equal(p.blocking, 1);
  // with the line at both, the same failures pass
  setChecks([{ name: 'suite', command: listing(log, 'echo DONE'), required: true, failure_id_pattern: PATTERN, complete_pattern: '^DONE$' }]);
  const done = offered(await propose('IDD-1'));
  assert.equal(check(done, 'suite').baseline?.verdict, 'preexisting', JSON.stringify(check(done, 'suite')));
});

test('a head and a public base that fail on the same failures with different exit codes are not compared', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: `${listing(log)} || { [ -f head.flag ] && exit 2; exit 1; }`, required: true, failure_id_pattern: PATTERN }] });
  flagHead(f);
  const p = offered(await propose('IDD-1'));
  const row = check(p, 'suite');
  assert.equal(row.baseline?.verdict, 'unknown', JSON.stringify(row));
  assert.match(row.baseline.reason, /終了コードが head（2）と公開 base（1）で違う/);
  assert.equal(p.blocking, 1);
});

test('a public base run that was cut, not run, changed the copy, ended by a signal or did not finish keeps no result, and holds', async () => {
  const cases = [
    { name: 'cut', extra: { checks: (log) => [{ name: 'suite', command: listing(log, '[ -f head.flag ] || sleep 20'), required: true, timeout_minutes: 0.05, failure_id_pattern: PATTERN }] }, why: /時間の上限で打ち切られました/ },
    { name: 'not run', extra: { setup: ['test -f head.flag'], checks: (log) => [{ name: 'suite', command: listing(log), required: true, failure_id_pattern: PATTERN }] }, why: /公開 base の複製の準備が失敗しました/ },
    { name: 'mutation', extra: { checks: (log) => [{ name: 'suite', command: listing(log, '[ -f head.flag ] || touch stray.txt'), required: true, failure_id_pattern: PATTERN }] }, why: /公開 base の検査が複製を変えました/ },
    { name: 'signal', extra: { checks: (log) => [{ name: 'suite', command: listing(log, '[ -f head.flag ] || kill -9 $$'), required: true, failure_id_pattern: PATTERN }] }, why: /公開 base の検査が signal で終わりました/ },
    { name: 'incomplete', extra: { checks: (log) => [{ name: 'suite', command: listing(log, '[ -f head.flag ] && echo DONE'), required: true, failure_id_pattern: PATTERN, complete_pattern: '^DONE$' }] }, why: /公開 base の出力に最後まで走った印/ },
  ];
  for (const c of cases) {
    const log = join(scratchDir('base-log-'), 'runs');
    const f = baseFailing({ ...(c.extra.setup ? { setup: c.extra.setup } : {}), checks: c.extra.checks(log) });
    flagHead(f);
    const p = offered(await propose('IDD-1'));
    const row = check(p, 'suite');
    assert.equal(row.baseline?.verdict, 'unknown', `${c.name}: ${JSON.stringify(row)}`);
    assert.match(row.baseline.reason, c.why, c.name);
    assert.equal(p.blocking, 1, c.name);
    assert.equal(keptResults(f), 0, `${c.name}: no result is kept`);
    const before = runs(log);
    offered(await propose('IDD-1'));
    // the public base is asked again (no setup at all when its preparation fails); a check of a head the submit already
    // checked runs everything again, kept results or not
    if (c.name !== 'not run') assert.equal(runs(log), before + 2, `${c.name}: the base runs again`);
  }
});

test('the public base\'s result is kept by its tree and the check\'s definition: the same is not run again, a changed command, pattern or tree is', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log), required: true, failure_id_pattern: PATTERN }] });
  change(f);
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 2, 'the head once and the base once');
  put(join(f.lane.path, 'app.txt'), 'three\n'); commit(f.lane.path);
  assert.equal(check(offered(await propose('IDD-1')), 'suite').baseline?.verdict, 'preexisting');
  assert.equal(runs(log), 3, 'the head is checked again, the base is not');
  setChecks([{ name: 'suite', command: `true; ${listing(log)}`, required: true, failure_id_pattern: PATTERN }]);
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 5, 'a changed command runs the base again');
  setChecks([{ name: 'suite', command: `true; ${listing(log)}`, required: true, failure_id_pattern: '^FAIL (\\S+)\\s*$' }]);
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 7, 'a changed pattern runs the base again');
  publicMove(f);
  const moved = offered(await propose('IDD-1'));
  assert.equal(runs(log), 9, 'a moved public base runs again');
  assert.equal(check(moved, 'suite').baseline.commit, git(f.upstream, 'rev-parse', 'HEAD'));
});

test('the public base is run under the repo\'s overlay lock, as the head is, and with no node_modules of the lane', async () => {
  const log = join(scratchDir('base-log-'), 'runs');
  const seen = join(scratchDir('base-seen-'), 'seen');
  const probe = `l="$(git rev-parse --git-common-dir)/idd-overlay.lock"; s=base; [ -f head.flag ] && s=head; { [ -d "$l" ] && echo "$s locked" || echo "$s free"; [ -e node_modules ] && echo "$s deps" || echo "$s nodeps"; } >> ${JSON.stringify(seen)}`;
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log, probe), required: true, failure_id_pattern: PATTERN }] });
  mkdirSync(join(f.lane.path, 'node_modules'));
  // the head's copy gets the lane's node_modules as a link, which `node_modules/` alone does not ignore
  put(join(f.lane.path, '.gitignore'), 'node_modules/\nnode_modules\n.env\nprep/\n');
  flagHead(f);
  const p = offered(await propose('IDD-1'));
  assert.ok(existsSync(seen), JSON.stringify(p.checks));
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n').sort(), ['base locked', 'base nodeps', 'head deps', 'head locked']);
});

test('failure_id_pattern and complete_pattern are kept beside the area, so its config key does not move; a field a check does not know is a config error', () => {
  const yaml = (c) => `repos:\n  o/p:\n    upstream: /u\n    work: /w\n    checks:\n      - ${c}\n`;
  const plain = parseRepos(yaml('{ name: t, command: "true" }'));
  const full = parseRepos(yaml('{ name: t, command: "true", failure_id_pattern: "^FAIL (.+)$", complete_pattern: "^DONE$" }'));
  assert.equal(key(full.areas['o/p']), key(plain.areas['o/p']));
  assert.deepEqual(full.failureIds, { 'o/p': { t: { pattern: '^FAIL (.+)$', complete: '^DONE$' } } });
  assert.equal(plain.failureIds, undefined);
  assert.throws(() => parseRepos(yaml('{ name: t, command: "true", failure_id: "x" }')), /知らない欄 failure_id/);
  assert.throws(() => parseRepos(yaml('{ name: t, command: "true", failure_id_pattern: "(" }')), /failure_id_pattern/);
  assert.throws(() => parseRepos(yaml('{ name: t, command: "true", failure_id_pattern: "x", complete_pattern: "(" }')), /complete_pattern/);
  assert.throws(() => parseRepos(yaml('{ name: t, command: "true", complete_pattern: "x" }')), /complete_pattern: failure_id_pattern と一緒に/);
  assert.throws(() => parseRepos(yaml('{ name: t, command: "true", scope: records, failure_id_pattern: "x" }')), /failure_id_pattern/);
});

test('the Flutter test check names its failed tests from the [E] lines, without the copy\'s path, and only from a run that printed its last line', { skip: shippedSkip }, () => {
  const rule = parseRepos(readFileSync(SHIPPED_REPOS, 'utf8')).failureIds?.['Dayseum/daysai-flutter']?.test;
  assert.ok(rule?.pattern && rule.complete, 'the shipped test check declares failure_id_pattern and complete_pattern');
  const copy = '/mnt/ct1/idd/review-wt/submit-checks/2639314-3c9187f554684fee';
  const failed = `${copy}/test/features/gen_common/presentation/viewmodels/on_generate_button_pressed_test.dart: onGenerateButtonPressed (実経路 + GenerationRequestLock) 画面が破棄されても onGenerate 完了時にロックは解放される`;
  const lines = [
    `00:03 +0: loading ${copy}/test/a_test.dart`,
    `00:04 +0 -1: loading ${copy}/test/broken_test.dart [E]`,
    '  Failed to load "test/broken_test.dart": compile error',
    `34:40 +34270 ~18 -1: ${failed}`,
    `34:40 +34270 ~18 -2: ${failed} [E]`,
    '  Expected: true',
    `34:41 +34271 ~18 -2: ${failed} [E]`,
    `34:42 +34271 ~18 -3: ${copy}/test/slow_test.dart: hangs - did not complete [E]`,
  ];
  // the end as run3 printed it (the expanded reporter of test_core), then its five-line summary
  const end = ['34:44 +34282 ~18 -3: Some tests failed.', '', 'Failing tests:', `  ${failed}`];
  const output = [...lines, ...end].join('\n');
  assert.deepEqual(failureIdsOf(output, rule.pattern, copy), [
    'loading test/broken_test.dart',
    failed.slice(copy.length + 1),
    'test/slow_test.dart: hangs',
  ]);
  assert.equal(ranToEnd(output, rule.complete, copy), true);
  assert.equal(ranToEnd(lines.join('\n'), rule.complete, copy), false, 'a run that died before its last line');
  for (const last of ['00:02 +3: All tests passed!', '00:02 +0 ~1: All tests skipped.', 'No tests ran.']) assert.equal(ranToEnd(last, rule.complete, copy), true, last);
  // colours from a terminal are taken out before the patterns are matched
  assert.deepEqual(failureIdsOf(`00:01 \u001b[32m+0\u001b[0m\u001b[31m -1\u001b[0m: ${copy}/test/x_test.dart: x \u001b[1m\u001b[31m[E]\u001b[0m`, rule.pattern, copy), ['test/x_test.dart: x']);
  assert.equal(ranToEnd('00:09 \u001b[32m+1\u001b[0m\u001b[31m -1\u001b[0m: \u001b[31mSome tests failed.\u001b[0m', rule.complete), true);
});

// The checks before the S2 loop converges (`checks_before_converge`): a run of their own at the lane's head, under the
// repo's overlay lock, compared with the lane's base, and kept by tree so the submit does not run them again.
const { runConvergeCheck } = await import('../src/overlay/converge-check-run.ts');
const { readConvergeRun, saveConvergeRun, repoChecksBusy, settleConvergeRun } = await import('../src/overlay/converge-checks.ts');
const { takeHeavyLock, heavyLockHeld, heavyLockPath } = await import('../src/overlay/heavy-lock.ts');
const { checksRunning } = await import('../src/overlay/git.ts');
/** turn the checks before the convergence on for the fixture's repo */
function convergeOn() {
  const cfg = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  cfg.repos.demo.checks_before_converge = true;
  put(process.env.IDD_REPOS_FILE, JSON.stringify(cfg));
}

/** run the checks before the convergence at the lane's head in this process, as the detached run does, and read the record */
async function convergeRun(f, checks, extra = {}) {
  const head = git(f.lane.path, 'rev-parse', 'HEAD');
  const base = git(f.lane.path, 'merge-base', head, 'work-main');
  const changed = git(f.lane.path, 'diff', '--name-only', '--diff-filter=d', base, head).split('\n').filter((n) => n && !n.startsWith('_docs/'));
  const runId = `R${Math.random().toString(36).slice(2, 8)}`;
  const spec = { runId, lane: 'IDD-1', area: 'demo', repo: f.lane.path, from: f.work, head, base, checks, changed, manifestPaths: ['_docs/', 'overlay.manifest', 'AGENTS.override.md'], ...extra };
  saveConvergeRun({ id: runId, lane: 'IDD-1', status: 'running', started_at: new Date().toISOString(), repo: f.lane.path, head, base, spec });
  const path = join(scratchDir('converge-spec-'), 'spec.json');
  writeFileSync(path, JSON.stringify(spec));
  await runConvergeCheck(path);
  return readConvergeRun('IDD-1');
}
const areaChecks = () => JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8')).repos.demo.checks.map((c) => ({ name: c.name, command: ['bash', '-c', c.command], required: c.required, scope: 'public' }));

test('the checks before the convergence run in a copy of the head under the repo\'s heavy-checks lock alone, compare a failure with the lane\'s base, and leave the lane alone', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const locks = `{ d="$(git rev-parse --git-common-dir)"; [ -d "$d/idd-heavy-checks.lock" ] && echo HEAVY >> ${JSON.stringify(`${log}.lock`)}; [ -d "$d/idd-overlay.lock" ] && echo OVERLAY >> ${JSON.stringify(`${log}.lock`)}; true; }`;
  const f = baseFailing({ checks: [{ name: 'suite', command: listing(log, locks), required: true, failure_id_pattern: PATTERN }] });
  put(join(f.lane.path, 'fails.txt'), 'a\nb\n'); commit(f.lane.path);
  const before = git(f.lane.path, 'status', '--porcelain');
  const run = await convergeRun(f, areaChecks());
  assert.equal(run.status, 'done', JSON.stringify(run));
  const row = run.rows.find((r) => r.name === 'suite');
  assert.equal(row.baseline?.verdict, 'new', JSON.stringify(row));
  assert.deepEqual(row.baseline.added, ['b'], 'the base already fails on a');
  assert.equal(runs(log), 2, 'the head and the lane\'s base once each');
  assert.deepEqual(readFileSync(`${log}.lock`, 'utf8').trim().split('\n'), ['HEAVY', 'HEAVY'], 'both ran under the heavy-checks lock, and no overlay lock was taken');
  assert.equal(heavyLockHeld(f.lane.path), false, 'the lock is let go afterwards');
  assert.equal(checksRunning(f.lane.path), false);
  assert.equal(git(f.lane.path, 'status', '--porcelain'), before, 'the lane\'s worktree is not touched');
});

test('a run of the checks before the convergence that finds the heavy-checks lock taken waits as busy and runs nothing', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}`, required: true }] });
  change(f);
  const release = takeHeavyLock(f.work, 'someone-else');
  try {
    assert.equal(repoChecksBusy(f.lane.path), true);
    const run = await convergeRun(f, areaChecks());
    assert.equal(run.status, 'busy');
    assert.ok(run.waiting_since, 'the wait is counted from the first busy');
    assert.equal(runs(log), 0);
  } finally { release(); }
  assert.equal(repoChecksBusy(f.lane.path), false);
});

test('the submit takes the heavy-checks lock inside the overlay lock while it runs the public checks, and waits while another holds it', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks: [{ name: 'suite', command: `[ -d "$(git rev-parse --git-common-dir)/idd-heavy-checks.lock" ] && echo HEAVY >> ${JSON.stringify(log)}; true`, required: true }] });
  change(f);
  offered(await propose('IDD-1'));
  assert.equal(readFileSync(log, 'utf8').trim(), 'HEAVY', 'the public check ran under the heavy-checks lock');
  assert.equal(heavyLockHeld(f.work), false, 'and let it go');
  put(join(f.lane.path, 'app.txt'), 'other\n'); commit(f.lane.path);
  const release = takeHeavyLock(f.work, 'converge-run');
  try {
    const held = await propose('IDD-1');
    assert.match(String(held.error), /検査が走っています/, JSON.stringify(held));
    assert.equal(readFileSync(log, 'utf8').trim(), 'HEAVY', 'nothing ran while another held the lock');
    assert.equal(checksRunning(f.work), false, 'the overlay lock is let go with the refusal');
  } finally { release(); }
});

test('a dead run of the checks before the convergence is closed as failed and its heavy-checks lock is let go', async () => {
  const f = setup({ checks: [{ name: 'suite', command: 'true', required: true }] });
  change(f);
  const dead = execFileSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).trim();
  const path = heavyLockPath(f.work);
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: Number(dead), run: 'R-dead', at: new Date().toISOString() }));
  saveConvergeRun({ id: 'R-dead', lane: 'IDD-1', status: 'running', started_at: new Date(Date.now() - 600_000).toISOString(), pid: Number(dead), repo: f.lane.path, head: 'h', base: 'b' });
  const run = settleConvergeRun('IDD-1', 'R-dead');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /process が消えました/);
  assert.equal(existsSync(path), false, 'the lock the dead run held is let go');
});

test('a check that names no failures is compared by whether it passes at the lane\'s base: passing there makes the failure the lane\'s, failing there too cannot be told', async () => {
  const f = setup({ checks: [{ name: 'lint', command: 'grep -q one app.txt', required: true }] });
  change(f);
  const made = (await convergeRun(f, areaChecks())).rows.find((r) => r.name === 'lint');
  assert.equal(made.baseline?.verdict, 'new', JSON.stringify(made));
  assert.match(blockingSummary([made]), /この lane で新しく落ちた/);
  const g = setup({ checks: [{ name: 'lint', command: 'false', required: true }] });
  change(g);
  const both = (await convergeRun(g, areaChecks())).rows.find((r) => r.name === 'lint');
  assert.equal(both.baseline?.verdict, 'unknown', JSON.stringify(both));
  assert.match(both.baseline.reason, /公開 base でも落ちる/);
  // the submit does not compare such a check and holds on it as before
  assert.equal(check(offered(await propose('IDD-1')), 'lint').baseline, undefined);
});

test('the submit reads the result the checks before the convergence kept for the same tree, definition and changed files, and does not run it again', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks_before_converge: true, checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}; echo "$(tr '\\0' ' ' < "$IDD_CHANGED_FILES")"`, required: true }] });
  change(f);
  const run = await convergeRun(f, areaChecks());
  assert.equal(run.rows.find((r) => r.name === 'suite').status, 'pass');
  assert.equal(runs(log), 1);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'suite').status, 'pass');
  assert.ok(check(p, 'suite').reused?.at, 'the row says it is a kept result');
  assert.match(check(p, 'suite').detail, /^S2 の検査の結果を使った/, 'the card\'s row says so');
  assert.equal(runs(log), 1, 'the submit did not run the check again');
  // a check of the same head again (the card's) runs everything again
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 2, 'a check of a head the submit already checked runs again');
  // a changed command is another check: its kept result is not read either
  const h = git(f.lane.path, 'rev-parse', 'HEAD');
  put(join(f.lane.path, 'app.txt'), 'four\n'); commit(f.lane.path);
  await convergeRun(f, areaChecks());
  assert.equal(runs(log), 3);
  setChecks([{ name: 'suite', command: `true; echo run >> ${JSON.stringify(log)}`, required: true }]);
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 4, 'a changed command is not read from the kept result');
  assert.notEqual(h, git(f.lane.path, 'rev-parse', 'HEAD'));
  setChecks([{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}; echo "$(tr '\\0' ' ' < "$IDD_CHANGED_FILES")"`, required: true }]);
  // a head with another tree runs again
  put(join(f.lane.path, 'app.txt'), 'three\n'); commit(f.lane.path);
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 5);
});

test('a repo that does not run its checks before the convergence never reads a kept result at the submit', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}`, required: true }] });
  change(f);
  await convergeRun(f, areaChecks());
  assert.equal(runs(log), 1);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'suite').reused, undefined);
  assert.equal(runs(log), 2, 'the submit ran it');
  convergeOn();
  put(join(f.lane.path, 'app.txt'), 'five\n'); commit(f.lane.path);
  await convergeRun(f, areaChecks());
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 3, 'with the setting on, the kept result is read');
});

test('a result that is the machine\'s, not the tree\'s, is not kept: a run cut by its limit is run again by the submit', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks_before_converge: true, checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}; [ -f again.flag ] || { touch again.flag 2>/dev/null; sleep 20; }`, required: true, timeout_minutes: 0.05 }] });
  change(f);
  const run = await convergeRun(f, areaChecks());
  const row = run.rows.find((r) => r.name === 'suite');
  assert.equal(row.status, 'fail');
  assert.equal(row.baseline?.verdict, 'unknown', 'a cut run is not compared at the base');
  assert.match(row.baseline.reason, /時間の上限/);
  assert.equal(runs(log), 1, 'the base is not run for a cut head');
  offered(await propose('IDD-1'));
  assert.equal(runs(log), 2, 'the cut run was not kept');
});

test('an import\'s checks run under the heavy-checks lock it takes inside the overlay lock, and wait while the checks before a convergence hold it', async () => {
  const log = join(scratchDir('import-heavy-'), 'runs');
  const f = setup({ checks: [{ name: 'suite', command: `[ -d "$(git rev-parse --git-common-dir)/idd-heavy-checks.lock" ] && echo HEAVY >> ${JSON.stringify(log)}; true`, required: true }] });
  publicMove(f);
  assert.ok(!proposeImport('demo').error);
  const release = takeHeavyLock(f.work, 'converge-run');
  try {
    const held = await reviewImport('demo');
    assert.match(String(held.error), /検査が走っています/, JSON.stringify(held));
    assert.equal(existsSync(log), false, 'no check ran beside the checks before a convergence');
    assert.equal(checksRunning(f.work), false, 'the overlay lock is let go with the refusal');
  } finally { release(); }
  const r = await reviewImport('demo');
  assert.ok(!r.error, r.error);
  assert.equal(readFileSync(log, 'utf8').trim(), 'HEAVY');
  assert.equal(heavyLockHeld(f.work), false);
});

test('the checks before a convergence do not start while a holder of the overlay lock marked it as checking', async () => {
  const f = setup({ checks: [{ name: 'suite', command: 'true', required: true }] });
  const { lock } = await import('../src/overlay/git.ts');
  const release = lock(f.work, { checks: true });
  try { assert.equal(repoChecksBusy(f.lane.path), true); } finally { release(); }
  assert.equal(repoChecksBusy(f.lane.path), false);
});

// The checks before the convergence run on the tree the submit checks: the public base's tip merged with the lane, built
// by the submit's own function, and compare a failure with that tip. Run 4 of the APP-2251 bench (IDD-291) checked the
// head's tree against the lane's base at S2 and the merged tree against the public tip at S4, and so ran the 35-minute
// Flutter test four times for one lane. While the public base stays where it was, the submit reads what S2 kept.

test('the checks before the convergence run on the tree the submit checks, so the submit reads their result even when the public base moved past the lane\'s base', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks_before_converge: true, checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}; [ -f external.txt ] && echo EXT >> ${JSON.stringify(`${log}.ext`)}; echo "$(tr '\\0' ' ' < "$IDD_CHANGED_FILES")"`, required: true }] });
  change(f);
  publicMove(f);
  const tip = git(f.upstream, 'rev-parse', 'HEAD');
  const run = await convergeRun(f, areaChecks());
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(run.basis, 'public', JSON.stringify(run));
  assert.equal(run.base, tip, 'a failure is compared with the public base\'s tip');
  assert.equal(readFileSync(`${log}.ext`, 'utf8').trim(), 'EXT', 'the checked tree carries the public base\'s change');
  assert.equal(runs(log), 1);
  // the run fetched into a ref space of its own: the refs the submit and the import move under the overlay lock are not touched
  const space = (name) => `refs/idd/${name}/${key('main')}`;
  assert.equal(git(f.lane.path, 'rev-parse', space('converge')), tip);
  assert.equal(git(f.upstream, 'rev-parse', space('converge')), tip);
  assert.equal(git(f.lane.path, 'for-each-ref', 'refs/idd/public'), '', 'the submit\'s ref is left alone');
  assert.equal(git(f.upstream, 'for-each-ref', 'refs/idd/public'), '');
  const p = offered(await propose('IDD-1'));
  assert.equal(run.tree, p.publicTree, 'the same tree as the submit');
  assert.ok(check(p, 'suite').reused?.at, JSON.stringify(check(p, 'suite')));
  assert.match(check(p, 'suite').detail, /^S2 の検査の結果を使った/);
  assert.equal(runs(log), 1, 'the submit did not run the check again');
});

test('a failure the checks before the convergence compared with the public base\'s tip is not run again by the submit, at the head or at the base', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = baseFailing({ checks_before_converge: true, checks: [{ name: 'suite', command: listing(log), required: true, failure_id_pattern: PATTERN }] });
  put(join(f.lane.path, 'fails.txt'), 'a\nb\n'); commit(f.lane.path);
  publicMove(f);
  const run = await convergeRun(f, areaChecks());
  const row = run.rows.find((r) => r.name === 'suite');
  assert.equal(row.baseline?.verdict, 'new', JSON.stringify(row));
  assert.deepEqual(row.baseline.added, ['b']);
  assert.equal(row.baseline.commit, git(f.upstream, 'rev-parse', 'HEAD'));
  assert.equal(runs(log), 2, 'the head and the public base once each');
  const p = offered(await propose('IDD-1'));
  const at = check(p, 'suite');
  assert.equal(at.baseline?.verdict, 'new', JSON.stringify(at));
  assert.deepEqual(at.baseline.added, ['b']);
  assert.equal(runs(log), 2, 'neither the head nor the public base ran again');
});

test('a public base that moved after the checks before the convergence is not read from their result: the submit runs again', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks_before_converge: true, checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}`, required: true }] });
  change(f);
  const run = await convergeRun(f, areaChecks());
  assert.equal(run.basis, 'public', JSON.stringify(run));
  publicMove(f);
  const p = offered(await propose('IDD-1'));
  assert.equal(check(p, 'suite').reused, undefined);
  assert.notEqual(run.tree, p.publicTree);
  assert.equal(runs(log), 2);
});

test('a public side that cannot be fetched leaves the checks before the convergence on the head\'s tree, compared with the lane\'s base', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks: [{ name: 'lint', command: `echo run >> ${JSON.stringify(log)}; grep -q one app.txt`, required: true }] });
  change(f);
  const url = git(f.upstream, 'remote', 'get-url', 'origin');
  git(f.upstream, 'remote', 'set-url', 'origin', join(f.root, 'nowhere.git'));
  try {
    const run = await convergeRun(f, areaChecks());
    assert.equal(run.status, 'done', JSON.stringify(run));
    assert.equal(run.basis, 'lane');
    assert.match(run.basis_note, /公開側/, JSON.stringify(run));
    const head = git(f.lane.path, 'rev-parse', 'HEAD');
    assert.equal(run.base, git(f.lane.path, 'merge-base', head, 'work-main'), 'compared with the lane\'s base');
    const row = run.rows.find((r) => r.name === 'lint');
    assert.equal(row.baseline?.verdict, 'new', 'a failure is still compared, never read as passing');
    assert.equal(runs(log), 2);
  } finally { git(f.upstream, 'remote', 'set-url', 'origin', url); }
});

test('a lane that conflicts with the public base\'s tip is checked on the head\'s tree against the lane\'s base: the conflict is the mainline merge\'s to take', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}; grep -q two app.txt`, required: true }] });
  change(f);
  put(join(f.upstream, 'app.txt'), 'three\n'); git(f.upstream, 'add', '-A'); git(f.upstream, 'commit', '-m', 'theirs'); git(f.upstream, 'push', 'origin', 'main');
  const run = await convergeRun(f, areaChecks());
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(run.basis, 'lane');
  assert.match(run.basis_note, /衝突/);
  assert.equal(run.rows.find((r) => r.name === 'suite').status, 'pass', 'the head\'s own tree');
});

test('a lane with a public branch is checked by the checks before the convergence on the tree its next submit checks, and the submit reads their result', async () => {
  const log = join(scratchDir('converge-log-'), 'runs');
  const f = setup({ checks_before_converge: true, checks: [{ name: 'suite', command: `echo run >> ${JSON.stringify(log)}; echo "$(tr '\\0' ' ' < "$IDD_CHANGED_FILES")"`, required: true }] });
  change(f);
  const first = offered(await propose('IDD-1'));
  assert.equal(approveExport(first.token, { message: 'feat: first' }).ok, true);
  const saved = readProposal('IDD-1'); saved.status = 'complete'; writeFileSync(proposalPath('IDD-1'), JSON.stringify(saved));
  assert.equal(runs(log), 1);
  // the public base moves on past the branch, and the lane adds to it
  publicMove(f);
  put(join(f.lane.path, 'second.txt'), 'more\n'); commit(f.lane.path);
  const run = await convergeRun(f, areaChecks());
  assert.equal(run.basis, 'public', JSON.stringify(run));
  assert.equal(run.base, git(f.upstream, 'rev-parse', 'origin/main'), 'compared with the public base\'s tip, not the branch');
  assert.equal(runs(log), 2);
  const next = offered(await propose('IDD-1'));
  assert.ok(next.targetTip, 'the submit goes over the lane\'s public branch');
  assert.equal(run.tree, next.publicTree, 'the same tree as the submit');
  assert.ok(check(next, 'suite').reused?.at, JSON.stringify(check(next, 'suite')));
  assert.equal(runs(log), 2, 'the submit did not run the check again');
});

test('a lane the submit would refuse, or that changes nothing on the public side, is checked on the head\'s tree against the lane\'s base', async () => {
  const runOf = async (f) => { const r = await convergeRun(f, areaChecks()); assert.equal(r.status, 'done', JSON.stringify(r)); return r; };
  // a public branch of the lane's name that was never adopted
  const a = setup({ checks: [{ name: 'suite', command: 'true', required: true }] });
  change(a);
  git(a.upstream, 'push', 'origin', `main:refs/heads/${a.lane.branch}`);
  const adopt = await runOf(a);
  assert.equal(adopt.basis, 'lane');
  assert.match(adopt.basis_note, /adopt/);
  // a lane that received its base (a stacked submit is not made yet)
  const b = setup({ checks: [{ name: 'suite', command: 'true', required: true }] });
  change(b);
  put(baseReceiptPath('IDD-1'), '{}');
  const stacked = await runOf(b);
  assert.equal(stacked.basis, 'lane');
  assert.match(stacked.basis_note, /base と同期した lane/);
  // nothing to put out on the public side
  const c = setup({ checks: [{ name: 'suite', command: 'true', required: true }] });
  const none = await runOf(c);
  assert.equal(none.basis, 'lane');
  assert.match(none.basis_note, /差分が無い/);
});

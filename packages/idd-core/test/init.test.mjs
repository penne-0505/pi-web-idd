import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { foldedPlace, ignoresCase, runInit } from '../src/init/init.ts';
import { readCheckList, renderCheckList } from '../src/init/checks-list.ts';
import { emptyTodo } from '../src/init/init.ts';
import { parseRepos } from '../src/config/areas.ts';
import { load as yamlLoad } from 'js-yaml';
import { tmpDir } from './helpers/tmp.mjs';

for (const k of ['IDD_REPOS_FILE', 'IDD_ROLES_FILE', 'IDD_MODES_FILE']) delete process.env[k];
// no author comes from the machine running the tests: git reads an empty global config here
process.env.GIT_CONFIG_GLOBAL = join(tmpDir('idd-init-gitconfig-'), 'config');
process.env.GIT_CONFIG_NOSYSTEM = '1';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** what the registration needs from a test unless it is the thing under test: labels, a check and an author */
const ready = { listLabels: () => ['idd-ready'], checks: ['node --test'], author: { name: 'Me', email: 'me@example.com' } };

function remote(files) {
  const root = tmpDir('idd-init-');
  const seed = join(root, 'seed'); mkdirSync(seed);
  git(seed, 'init', '-q', '--initial-branch=main');
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(seed, p, '..'), { recursive: true }); writeFileSync(join(seed, p), body); }
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'init');
  const bare = join(root, 'remote.git');
  git(root, 'clone', '-q', '--bare', seed, bare);
  writeFileSync(join(root, 'repos.yaml'), 'repos:\n');
  return { root, bare, repos: join(root, 'repos.yaml') };
}

test('repo init makes two clones, writes the record skeleton, and hands no package asset to the repo', () => {
  const r = remote({ 'README.md': '# app\n', 'AGENTS.md': '# App rules\nuse tabs\n', 'src/app.ts': 'export const a = 1;\n' });
  const upstream = join(r.root, 'upstream'); const work = join(r.root, 'work');
  const dry = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, dryRun: true, ...ready });
  assert.equal(dry.ok, true, 'a dry run with nothing in the way is a success');
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.blockers, []);
  assert.ok(dry.steps.length > 1, 'the planned steps are shown');
  assert.equal(existsSync(upstream), false, 'a dry run changes nothing');
  assert.equal(existsSync(work), false);
  assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n');
  const res = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, ...ready });
  assert.equal(res.dryRun, undefined);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(git(work, 'branch', '--show-current').trim(), 'work-main');
  // the package keeps its norms, validators and AGENTS files; the repo gets none of them
  for (const rel of ['_docs/standards', 'scripts', 'deno.json', '_meta/agent-workflows', '.agents', '.claude', '.codex', 'AGENTS.override.md', 'CLAUDE.local.md']) {
    assert.equal(existsSync(join(work, rel)), false, `${rel} is not written`);
  }
  // the record skeleton is there
  assert.ok(existsSync(join(work, 'TODO.md')));
  assert.ok(existsSync(join(work, '_docs', 'intent', '.gitkeep')));
  assert.ok(existsSync(join(work, 'docs-validators.json')));
  const manifest = readFileSync(join(work, 'overlay.manifest'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(manifest, ['_docs/', '_meta/', 'TODO.md', 'overlay.manifest', 'docs-template.lock.json', 'docs-validators.json']);
  // the lock names the package and the adoption point
  const lock = JSON.parse(readFileSync(join(work, 'docs-template.lock.json'), 'utf8'));
  assert.equal(lock.source, 'pi-web-idd');
  assert.equal(lock.adopted_base, git(upstream, 'rev-parse', 'HEAD').trim());
  // the scratch place is excluded, the work clone cannot push, and the registry names the package check
  assert.match(readFileSync(join(work, '.git', 'info', 'exclude'), 'utf8'), /^_meta\/scratch\/$/m);
  assert.match(readFileSync(join(work, '.git', 'hooks', 'pre-push'), 'utf8'), /push しない/);
  assert.equal(git(work, 'status', '--porcelain').trim(), '', 'the skeleton is committed');
  assert.throws(() => git(work, 'push', 'origin', 'work-main'), 'the work clone cannot push');
  const reg = parseRepos(readFileSync(r.repos, 'utf8')).areas['me/app'];
  assert.equal(reg.local_path, work);
  assert.equal(reg.upstream_path, upstream);
  assert.equal(reg.intake, true);
  assert.match((reg.checks ?? []).find((c) => c.scope === 'records').command.join(' '), /bin\/idd" rules check/);
  // the upstream's own AGENTS.md is left as it is
  assert.equal(readFileSync(join(work, 'AGENTS.md'), 'utf8'), '# App rules\nuse tabs\n');
  const again = runInit({ github: 'me/app', upstream: join(r.root, 'u2'), work: join(r.root, 'w2'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready });
  assert.match(again.blockers.join(' '), /登録済み/);
});

test('an existing clone with work in progress, or with records and no choice, stops before any change', () => {
  const r = remote({ 'README.md': '# app\n', 'src/app.ts': '// see DEC-001\nexport const a = 1;\n', '_docs/intent/x/decision.md': '### DEC-001: x\n' });
  const upstream = join(r.root, 'upstream');
  git(r.root, 'clone', '-q', r.bare, upstream);
  writeFileSync(join(upstream, 'dirty.txt'), 'x');
  const dirty = runInit({ github: 'me/app', upstream, work: join(r.root, 'work'), existing: true, reposFile: r.repos, skipCheck: true, ...ready });
  assert.match(dirty.blockers.join(' '), /未 commit/);
  execFileSync('rm', [join(upstream, 'dirty.txt')]);
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'local only');
  assert.match(runInit({ github: 'me/app', upstream, work: join(r.root, 'work'), existing: true, reposFile: r.repos, skipCheck: true, ...ready }).blockers.join(' '), /未 push/);
  git(upstream, 'reset', '-q', '--hard', 'origin/main');
  const noChoice = runInit({ github: 'me/app', upstream, work: join(r.root, 'work'), existing: true, reposFile: r.repos, skipCheck: true, ...ready });
  assert.match(noChoice.blockers.join(' '), /--records/);
  assert.equal(noChoice.inventory.decs, 1);
  assert.equal(existsSync(join(r.root, 'work')), false);
});

test('records keep stays in the overlay, drop removes them', () => {
  const r = remote({ 'README.md': '# app\n', '_docs/intent/x/decision.md': '### DEC-001: x\n' });
  const upstream = join(r.root, 'upstream');
  git(r.root, 'clone', '-q', r.bare, upstream);
  git(upstream, 'config', 'user.name', 'someone');
  git(upstream, 'config', 'user.email', 'someone@example.com');
  const keep = runInit({ github: 'me/app', upstream, work: join(r.root, 'work-keep'), existing: true, records: 'keep', reposFile: r.repos, skipCheck: true, ...ready, author: undefined });
  assert.ok(keep.ok, JSON.stringify(keep.blockers));
  assert.ok(existsSync(join(r.root, 'work-keep', '_docs/intent/x/decision.md')));
  const local = (k) => execFileSync('git', ['config', '--local', '--get', k], { cwd: join(r.root, 'work-keep'), encoding: 'utf8' }).trim();
  assert.equal(local('user.name'), 'someone', 'the upstream\'s identity carries over');
  writeFileSync(r.repos, 'repos:\n');
  const drop = runInit({ github: 'me/app', upstream, work: join(r.root, 'work-drop'), existing: true, records: 'drop', reposFile: r.repos, skipCheck: true, ...ready, author: undefined });
  assert.ok(drop.ok);
  assert.equal(existsSync(join(r.root, 'work-drop', '_docs/intent/x/decision.md')), false);
  assert.equal(existsSync(join(r.root, 'work-drop', '_docs/standards')), false, 'drop does not bring a standards copy back');
});

test('the TODO rules idd init copies define High as the six kinds of harm that cannot be undone', () => {
  const todo = emptyTodo(join(import.meta.dirname, '..', '..', '..'));
  const high = todo.split('\n').find((l) => /^- `High`/.test(l));
  assert.ok(high, 'a High bullet is written');
  for (const key of ['auth', 'authz', 'billing', 'permission', 'data_loss', 'secret']) assert.match(high, new RegExp(key));
  // compatibility, external APIs and CI/CD are Medium, not a High condition
  for (const word of ['外部 API', 'CI/CD', '互換性']) assert.doesNotMatch(high, new RegExp(word));
  const medium = todo.split('\n').find((l) => /^- `Medium`/.test(l));
  assert.match(medium, /外部 API/);
  assert.match(medium, /CI\/CD/);
});

test('references to decisions in code become a Backlog task numbered from the TODO counter', () => {
  const todo = '# Rules\n\n- **Current Max ID**: `Next ID No: 5`\n\n## Inbox\n\n## Backlog\n\n### Core-Feat-4: [Feat] x\n\n- **ID**: Core-Feat-4\n\n---\n\n## Ready\n\n## In Progress\n';
  const r = remote({ 'README.md': '# app\n', 'TODO.md': todo, 'src/a.ts': '// DEC-001\n// INV-002\n', 'src/b.py': '# DEC-003\n', 'scripts/validate-intent.mjs': 'const re = /DEC-001/;\n', '_docs/intent/x/decision.md': '### DEC-001: x\n' });
  const upstream = join(r.root, 'upstream');
  git(r.root, 'clone', '-q', r.bare, upstream);
  const keep = runInit({ github: 'me/app', upstream, work: join(r.root, 'work-keep'), existing: true, records: 'keep', reposFile: r.repos, skipCheck: true, ...ready });
  assert.ok(keep.ok, JSON.stringify(keep.blockers));
  const kept = readFileSync(join(r.root, 'work-keep', 'TODO.md'), 'utf8');
  assert.match(kept, /`Next ID No: 6`/);
  const backlog = kept.slice(kept.indexOf('\n## Backlog'), kept.indexOf('\n## Ready'));
  assert.match(backlog, /### Workflow-Chore-5: \[Chore\]/);
  assert.match(backlog, /`src\/a\.ts`（2）/);
  assert.match(backlog, /`src\/b\.py`（1）/);
  assert.doesNotMatch(backlog, /validate-intent/, "the template's own validators are not the project's code");
  assert.equal(keep.inventory.pointerComments, 3);
  assert.match(keep.warnings.join(' '), /Workflow-Chore-5/);
  assert.match(readFileSync(join(r.root, 'work-keep', '_docs/qa/Workflow/maintenance.md'), 'utf8'), /qa_schema: 5[\s\S]*## Rounds/);
});

const reg = (r, key = 'me/app') => parseRepos(readFileSync(r.repos, 'utf8')).areas[key];
const setupOf = (r, key = 'me/app') => yamlLoad(readFileSync(r.repos, 'utf8')).repos[key].setup;
const CI = 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: |\n          npm test\n          npx eslint . --max-warnings 0\n          echo "deploying ${{ github.sha }}"\n';

test('the Issue lane is declared by default with idd-ready, and a missing label or an opt-out shows in the result', () => {
  const r = remote({ 'README.md': '# app\n' });
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready, listLabels: () => ['bug'] });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  assert.equal(reg(r).intake, true);
  assert.deepEqual(reg(r).intake_filter.github_labels, ['idd-ready']);
  assert.equal(reg(r).source_type_priority, 'github');
  assert.deepEqual(res.prerequisites.intake, { declared: true, labels: ['idd-ready'], missingLabels: ['idd-ready'], labelCheck: 'checked' });
  assert.match(res.warnings.join('\n'), /ラベル idd-ready が GitHub の me\/app にありません/);
  // the label cannot be read: said so, and the registration still stands
  writeFileSync(r.repos, 'repos:\n');
  const blind = runInit({ github: 'me/app', upstream: join(r.root, 'u2'), work: join(r.root, 'w2'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready, listLabels: () => null });
  assert.ok(blind.ok);
  assert.equal(blind.prerequisites.intake.labelCheck, 'unchecked');
  // the label exists: no warning about it
  writeFileSync(r.repos, 'repos:\n');
  const fine = runInit({ github: 'me/app', upstream: join(r.root, 'u3'), work: join(r.root, 'w3'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready, issueLane: { labels: ['idd-ready', 'x'] }, listLabels: () => ['idd-ready', 'x'] });
  assert.deepEqual(fine.prerequisites.intake.missingLabels, []);
  assert.doesNotMatch(fine.warnings.join('\n'), /にありません/);
  // not taking Issues in is a choice the caller can make out loud
  writeFileSync(r.repos, 'repos:\n');
  const out = runInit({ github: 'me/app', upstream: join(r.root, 'u4'), work: join(r.root, 'w4'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready, issueLane: null });
  assert.ok(out.ok);
  assert.equal(reg(r).intake, false);
  assert.equal(out.prerequisites.intake.declared, false);
});

test('public checks come from the CI the repo declares; none found stops the registration before the work clone and the registry', () => {
  const r = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': CI });
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  const commands = reg(r).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1));
  assert.deepEqual(commands, ['npm test', 'npx eslint . --max-warnings 0'], 'install lines and CI-only lines are not checks');
  assert.ok(reg(r).checks.filter((c) => c.scope === 'public').every((c) => c.required));
  assert.ok(reg(r).checks.some((c) => c.scope === 'records'), 'the record check stays');
  assert.equal(res.prerequisites.publicChecks.state, 'found');
  assert.equal(res.prerequisites.publicChecks.checks[0].from, '.github/workflows/ci.yml');
  assert.match(res.warnings.join('\n'), /npm ci/);

  // the ecosystem entrance is read when there is no CI; the placeholder npm init writes is not a check
  const eco = remote({ 'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc --noEmit' } }), 'package-lock.json': '{}' });
  const ok = runInit({ github: 'me/eco', upstream: join(eco.root, 'u'), work: join(eco.root, 'w'), url: eco.bare, reposFile: eco.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.deepEqual(reg(eco, 'me/eco').checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['npm test', 'npm run lint', 'npm run typecheck']);
  assert.equal(ok.prerequisites.publicChecks.checks[2].from, 'package.json の scripts.typecheck');

  // nothing declared: stop, name the way out, write neither clone nor entry; the clone made for the look is removed
  const none = remote({ 'README.md': '# app\n', 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  const upstream = join(none.root, 'u'); const work = join(none.root, 'w');
  const stopped = runInit({ github: 'me/app', upstream, work, url: none.bare, reposFile: none.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(stopped.ok, false);
  assert.match(stopped.blockers.join(' '), /--check/);
  assert.equal(stopped.prerequisites.publicChecks.state, 'none');
  assert.equal(existsSync(work), false);
  assert.equal(existsSync(upstream), false, 'a clone made only for the look is not left behind');
  assert.equal(readFileSync(none.repos, 'utf8'), 'repos:\n');
  // a second try needs no --existing, and --check names the check
  const again = runInit({ github: 'me/app', upstream, work, url: none.bare, reposFile: none.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author, checks: ['python3 -m unittest'] });
  assert.ok(again.ok, JSON.stringify(again.blockers));
  assert.equal(again.prerequisites.publicChecks.state, 'given');
  assert.deepEqual(reg(none).checks.filter((c) => c.scope === 'public').map((c) => [c.name, c.command.at(-1)]), [['test', 'python3 -m unittest']]);

  // a stop on an existing clone leaves that clone alone, and an entry already in the registry stays
  const have = remote({ 'README.md': '# app\n' });
  const mine = join(have.root, 'mine');
  git(have.root, 'clone', '-q', have.bare, mine);
  writeFileSync(have.repos, 'repos:\n  me/other:\n    name: other\n    upstream: /x/u\n    work: /x/w\n');
  const kept = runInit({ github: 'me/app', upstream: mine, work: join(have.root, 'w'), existing: true, reposFile: have.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(kept.ok, false);
  assert.ok(existsSync(join(mine, '.git')));
  assert.equal(readFileSync(have.repos, 'utf8'), 'repos:\n  me/other:\n    name: other\n    upstream: /x/u\n    work: /x/w\n');
});

test('an npm repo without a lockfile gets a setup that leaves the check copy as the submission', () => {
  const r = remote({ 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'node --test' } }) });
  const upstream = join(r.root, 'u');
  const res = runInit({ github: 'me/app', upstream, work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  assert.deepEqual(res.prerequisites.publicChecks.setupHints, ['npm install --no-package-lock']);
  assert.deepEqual(setupOf(r), ['npm install --no-package-lock']);
  assert.ok(reg(r).checks.some((c) => c.scope === 'public'));
  // the setup runs in a detached copy of the upstream the way the check copy is cut, and must leave nothing untracked
  const copy = join(r.root, 'copy');
  git(upstream, 'worktree', 'add', '-q', '--detach', copy, 'HEAD');
  for (const command of setupOf(r)) execFileSync('bash', ['-c', command], { cwd: copy, stdio: 'ignore' });
  assert.equal(git(copy, 'status', '--porcelain', '--untracked-files=all').trim(), '', 'the setup does not write a lockfile into the copy');
  // the plain install is what wrote one
  execFileSync('bash', ['-c', 'npm install'], { cwd: copy, stdio: 'ignore' });
  assert.match(git(copy, 'status', '--porcelain', '--untracked-files=all'), /package-lock\.json/);
});

test('CI steps that run the repo\'s own scripts or toolchain commands are public checks, and a working-directory with spaces is quoted', () => {
  const ci = 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: node --test\n      - run: ./scripts/check-docs.sh\n      - run: bash scripts/fetch-check.sh\n      - run: swift test\n      - run: ./gradlew test\n  sub:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: my app\n    steps:\n      - run: npm test\n';
  const r = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': ci, 'scripts/check-docs.sh': '#!/bin/sh\n' });
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  const commands = reg(r).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1));
  assert.deepEqual(commands, ['node --test', './scripts/check-docs.sh', 'swift test', './gradlew test', "cd 'my app' && npm test"], 'a script the repo does not hold is not a check');
  // a script run after a `cd` is read from the directory it moved to, on a line of its own or chained
  const cdCi = 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cd pkg && ./scripts/check.sh\n      - run: cd missing && ./scripts/check.sh\n      - run: cd $X && ./scripts/check.sh\n      - run: |\n          cd pkg\n          ./scripts/lint.sh\n      - run: cd pkg && npm ci && ./scripts/test.sh\n';
  const moved = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': cdCi, 'pkg/scripts/check.sh': '#!/bin/sh\n', 'pkg/scripts/lint.sh': '#!/bin/sh\n', 'pkg/scripts/test.sh': '#!/bin/sh\n' });
  const movedRes = runInit({ github: 'me/app', upstream: join(moved.root, 'u'), work: join(moved.root, 'w'), url: moved.bare, reposFile: moved.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(movedRes.ok, JSON.stringify(movedRes.blockers));
  assert.deepEqual(reg(moved).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['cd pkg && ./scripts/check.sh', 'cd pkg && ./scripts/lint.sh', 'cd pkg && ./scripts/test.sh']);
  // nothing readable: the stop says it did not find one and points at --check
  const none = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./ci.sh\n' });
  const stopped = runInit({ github: 'me/app', upstream: join(none.root, 'u'), work: join(none.root, 'w'), url: none.bare, reposFile: none.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(stopped.ok, false);
  assert.match(stopped.blockers.join(' '), /見つけられませんでした[\s\S]*--check/);
});

test('an install chained to a check on one run line keeps the check, and the install goes to the check copy\'s setup', () => {
  const flow = (runs) => `name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${runs}`;
  const r = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow('      - run: npm ci && npm test\n      - run: npm ci; npx eslint .\n      - run: "echo \'a && b\' && npm ci"\n') });
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  const checks = reg(r).checks.filter((c) => c.scope === 'public');
  assert.deepEqual(checks.map((c) => c.command.at(-1)), ['npm test', 'npx eslint .']);
  assert.deepEqual(res.prerequisites.publicChecks.setupHints, ['npm ci']);
  // the install the CI runs first is the check copy's setup, so a first submission has what the check needs
  assert.deepEqual(setupOf(r), ['npm ci']);
  // a working-directory is carried to both the check and the install
  const sub = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow('      - working-directory: my app\n        run: npm ci && npm test\n') });
  const got = runInit({ github: 'me/app', upstream: join(sub.root, 'u'), work: join(sub.root, 'w'), url: sub.bare, reposFile: sub.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(got.ok, JSON.stringify(got.blockers));
  assert.deepEqual(reg(sub).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ["cd 'my app' && npm test"]);
  assert.deepEqual(got.prerequisites.publicChecks.setupHints, ["cd 'my app' && npm ci"]);
  assert.deepEqual(setupOf(sub), ["cd 'my app' && npm ci"]);
});

test('a check given with --check still gets the install the CI runs first as the check copy\'s setup', () => {
  const flow = (runs) => `name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${runs}`;
  const r = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow('      - run: npm ci\n      - run: npm test\n') });
  const args = (x, extra = {}) => ({ github: 'me/app', upstream: join(x.root, 'u'), work: join(x.root, 'w'), url: x.bare, reposFile: x.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author, checks: ['node --test'], ...extra });
  const dry = runInit(args(r, { dryRun: true }));
  assert.ok(dry.ok, JSON.stringify(dry.blockers));
  assert.deepEqual(dry.prerequisites.publicChecks.setupHints, ['npm ci']);
  const res = runInit(args(r));
  assert.ok(res.ok, JSON.stringify(res.blockers));
  assert.equal(res.prerequisites.publicChecks.state, 'given');
  assert.deepEqual(res.prerequisites.publicChecks.setupHints, ['npm ci']);
  assert.deepEqual(reg(r).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['node --test'], 'the CI check is not mixed in');
  assert.deepEqual(setupOf(r), ['npm ci']);
  // a CI with no install, or no CI, leaves the setup empty
  const bare = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow('      - run: npm test\n') });
  const none = runInit(args(bare));
  assert.ok(none.ok, JSON.stringify(none.blockers));
  assert.deepEqual(none.prerequisites.publicChecks.setupHints, []);
  assert.deepEqual(setupOf(bare) ?? [], []);
});

test('yarn test is a check and not an install, and a mention of a check as an argument is not a check', () => {
  const flow = (runs) => `name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${runs}`;
  const r = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow('      - run: yarn install --frozen-lockfile\n      - run: yarn --frozen-lockfile\n      - run: yarn test\n      - run: yarn run lint\n      - working-directory: web\n        run: yarn test\n      - run: echo npm test\n      - run: echo "run npm test" && echo tsc\n      - run: CI=1 npx eslint .\n') });
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  assert.deepEqual(reg(r).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['yarn test', 'yarn run lint', 'cd web && yarn test', 'CI=1 npx eslint .']);
  assert.deepEqual(res.prerequisites.publicChecks.setupHints, ['yarn install --frozen-lockfile', 'yarn --frozen-lockfile']);
  // a CI whose only run line mentions a check declares none: the registration stops
  const echo = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow('      - run: echo npm test\n') });
  const stopped = runInit({ github: 'me/app', upstream: join(echo.root, 'u'), work: join(echo.root, 'w'), url: echo.bare, reposFile: echo.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(stopped.ok, false);
  assert.match(stopped.blockers.join(' '), /--check/);
});

test('a cd on a line of its own in a multi-line run moves the later lines of that step only', () => {
  const flow = (runs) => `name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${runs}`;
  const body = '      - run: |\n          cd pkg\n          npm ci\n          npm test\n      - run: npx eslint .\n      - working-directory: web\n        run: |\n          cd \'my app\'\n          npm run lint\n      - run: |\n          cd $SOME\n          npm run typecheck\n';
  const r = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow(body) });
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  assert.deepEqual(reg(r).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['cd pkg && npm test', 'npx eslint .', "cd web && cd 'my app' && npm run lint"]);
  assert.deepEqual(res.prerequisites.publicChecks.setupHints, ['cd pkg && npm ci']);
  assert.deepEqual(setupOf(r), ['cd pkg && npm ci']);
});

test('an explicit opt-out of the Issue lane is not told to register again, and a bad registry entry leaves the existing clone author alone', () => {
  const r = remote({ 'README.md': '# app\n' });
  const out = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready, issueLane: null });
  assert.ok(out.ok);
  assert.doesNotMatch(out.warnings.join('\n'), /--issue-labels/);
  assert.match(out.warnings.join('\n'), /取り込まない設定にしました/);
  // a registry the new entry cannot join: the run fails and the clone's local author is not written
  const upstream = join(r.root, 'existing');
  git(r.root, 'clone', '-q', r.bare, upstream);
  writeFileSync(r.repos, 'repos:\n  other/x:\n    upstream: 1\n');
  assert.throws(() => runInit({ github: 'me/app2', upstream, work: join(r.root, 'w2'), existing: true, reposFile: r.repos, skipCheck: true, ...ready }));
  assert.throws(() => git(upstream, 'config', '--local', '--get', 'user.name'));
});

test('only a workflow that runs on a normal submission is a source of public checks', () => {
  const flow = (on, run) => `name: x\non: ${on}\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
  const r = remote({ 'README.md': '# app\n', '.github/workflows/a-nightly.yml': flow('\n  schedule:\n    - cron: "0 0 * * *"', 'npm run e2e && npm test'), '.github/workflows/b-ci.yml': flow('[push]', 'npx eslint .') });
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  assert.deepEqual(reg(r).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['npx eslint .']);
  // a map that also names a pull_request is taken; a schedule alone falls through to the ecosystem, and to a stop without one
  const map = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': flow('\n  pull_request:\n  schedule:\n    - cron: "0 0 * * *"', 'npm test') });
  const m = runInit({ github: 'me/app', upstream: join(map.root, 'u'), work: join(map.root, 'w'), url: map.bare, reposFile: map.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(m.ok, JSON.stringify(m.blockers));
  assert.deepEqual(reg(map).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['npm test']);
  const only = remote({ 'README.md': '# app\n', '.github/workflows/nightly.yml': flow('schedule', 'npm test') });
  const o = runInit({ github: 'me/app', upstream: join(only.root, 'u'), work: join(only.root, 'w'), url: only.bare, reposFile: only.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(o.ok, false);
  assert.match(o.blockers.join(' '), /--check/);
  const eco = remote({ 'package.json': '{"scripts":{"test":"node --test"}}', '.github/workflows/nightly.yml': flow('workflow_dispatch', 'npm run e2e') });
  const e = runInit({ github: 'me/app', upstream: join(eco.root, 'u'), work: join(eco.root, 'w'), url: eco.bare, reposFile: eco.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.ok(e.ok, JSON.stringify(e.blockers));
  assert.deepEqual(reg(eco).checks.filter((c) => c.scope === 'public').map((c) => c.command.at(-1)), ['npm test']);
});

test('a dry run on a fresh repo reads a throwaway clone, stops as the run does, and leaves nothing behind', () => {
  const r = remote({ 'README.md': '# app\n' });
  const upstream = join(r.root, 'u'); const work = join(r.root, 'w');
  const dry = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, dryRun: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(dry.ok, false, 'no check is declared, so the run would stop');
  assert.equal(dry.dryRun, true);
  assert.match(dry.blockers.join(' '), /--check/);
  assert.equal(dry.prerequisites.publicChecks.state, 'none');
  assert.equal(existsSync(upstream), false);
  assert.equal(existsSync(work), false);
  assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n');
  const real = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(real.ok, false, 'the run stops for the same reason');
  // a repo that declares a check passes the dry run, with the check shown
  const ok = remote({ 'package.json': '{"scripts":{"test":"node --test"}}' });
  const good = runInit({ github: 'me/app', upstream: join(ok.root, 'u'), work: join(ok.root, 'w'), url: ok.bare, reposFile: ok.repos, skipCheck: true, dryRun: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(good.ok, true, JSON.stringify(good.blockers));
  assert.equal(good.prerequisites.publicChecks.state, 'found');
  assert.equal(existsSync(join(ok.root, 'u')), false);
  // a source that cannot be cloned is a reason to stop, not a success
  const gone = runInit({ github: 'me/app', upstream: join(ok.root, 'u2'), work: join(ok.root, 'w2'), url: join(ok.root, 'nope.git'), reposFile: ok.repos, skipCheck: true, dryRun: true, ...ready });
  assert.equal(gone.ok, false);
  assert.match(gone.blockers.join(' '), /clone できない/);
  // an entry the registry parser would refuse is a reason to stop in a dry run as well, and it changes nothing
  const bad = remote({ 'package.json': '{"scripts":{"test":"node --test"}}' });
  const badArgs = { github: 'me/app', upstream: join(bad.root, 'u'), work: join(bad.root, 'w'), url: bad.bare, reposFile: bad.repos, name: 'a: b', skipCheck: true, listLabels: ready.listLabels, author: ready.author };
  const badDry = runInit({ ...badArgs, dryRun: true });
  assert.equal(badDry.ok, false);
  assert.match(badDry.blockers.join(' '), /config\/repos\.yaml に足す項目が不正/);
  assert.equal(existsSync(join(bad.root, 'u')), false);
  assert.equal(readFileSync(bad.repos, 'utf8'), 'repos:\n');
  assert.throws(() => runInit(badArgs), 'the run is stopped by the same entry');
});

test('the author of the published commits is read in the upstream clone, taken from flags when git has none, and missing keys stop the registration', () => {
  const r = remote({ 'README.md': '# app\n' });
  const upstream = join(r.root, 'u'); const work = join(r.root, 'w');
  const stopped = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, checks: ready.checks });
  assert.equal(stopped.ok, false);
  assert.match(stopped.blockers.join(' '), /user\.name と user\.email/);
  assert.deepEqual(stopped.prerequisites.author.missing, ['user.name', 'user.email']);
  assert.equal(existsSync(work), false);
  assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n');
  // one key from the flag, the other missing: only the missing one is named
  const half = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, checks: ready.checks, author: { name: 'Me' } });
  assert.deepEqual(half.prerequisites.author.missing, ['user.email']);
  assert.match(half.blockers.join(' '), /user\.email/);
  assert.doesNotMatch(half.blockers.join(' '), /user\.name/);
  // the flags are written to the upstream clone's local config, never to the global one
  const ok = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, ...ready });
  assert.ok(ok.ok, JSON.stringify(ok.blockers));
  assert.deepEqual([ok.prerequisites.author.state, ok.prerequisites.author.name, ok.prerequisites.author.email], ['given', 'Me', 'me@example.com']);
  assert.equal(git(upstream, 'config', '--local', '--get', 'user.email').trim(), 'me@example.com');
  assert.equal(git(work, 'config', '--local', '--get', 'user.name').trim(), 'Me');
  assert.equal(existsSync(process.env.GIT_CONFIG_GLOBAL), false, 'the global config is not created');
  // what git resolves outside the flags is used as it is and reported as git's
  const g = remote({ 'README.md': '# app\n' });
  const mine = join(g.root, 'mine');
  git(g.root, 'clone', '-q', g.bare, mine);
  execFileSync('git', ['config', '--local', 'user.name', 'Local'], { cwd: mine });
  execFileSync('git', ['config', '--local', 'user.email', 'local@example.com'], { cwd: mine });
  const found = runInit({ github: 'me/app', upstream: mine, work: join(g.root, 'w'), existing: true, reposFile: g.repos, skipCheck: true, listLabels: ready.listLabels, checks: ready.checks });
  assert.ok(found.ok, JSON.stringify(found.blockers));
  assert.equal(found.prerequisites.author.state, 'found');
  assert.deepEqual(found.prerequisites.author.from, { 'user.name': 'git', 'user.email': 'git' });
});

test('a dry run stops for the same reasons as the run, and changes nothing', () => {
  const r = remote({ 'README.md': '# app\n' });
  const upstream = join(r.root, 'u'); const work = join(r.root, 'w');
  const noAuthor = runInit({ github: 'me/app', upstream, work, url: r.bare, reposFile: r.repos, skipCheck: true, dryRun: true, listLabels: ready.listLabels, checks: ready.checks });
  assert.equal(noAuthor.ok, false, 'a reason to stop makes a dry run fail');
  assert.equal(noAuthor.dryRun, true);
  assert.match(noAuthor.blockers.join(' '), /user\.name/);
  const existing = join(r.root, 'mine');
  git(r.root, 'clone', '-q', r.bare, existing);
  const noCheck = runInit({ github: 'me/app', upstream: existing, work, existing: true, reposFile: r.repos, skipCheck: true, dryRun: true, listLabels: ready.listLabels, author: ready.author });
  assert.equal(noCheck.ok, false);
  assert.match(noCheck.blockers.join(' '), /--check/);
  assert.throws(() => git(existing, 'config', '--local', '--get', 'user.name'), 'a dry run writes no author');
  assert.equal(existsSync(work), false);
  assert.equal(existsSync(upstream), false);
  assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n');
});

test('a missing .gitignore is reported, and generated files are excluded in the clone without writing .gitignore', () => {
  const r = remote({ 'package.json': '{"scripts":{"test":"node --test"}}', 'tool.py': 'x = 1\n' });
  const work = join(r.root, 'w');
  const res = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work, url: r.bare, reposFile: r.repos, skipCheck: true, ...ready, checks: undefined });
  assert.ok(res.ok, JSON.stringify(res.blockers));
  assert.equal(res.prerequisites.gitignore.present, false);
  assert.ok(res.prerequisites.gitignore.excluded.includes('node_modules') && res.prerequisites.gitignore.excluded.includes('__pycache__/'));
  assert.match(res.warnings.join('\n'), /\.gitignore がありません/);
  assert.equal(existsSync(join(work, '.gitignore')), false, 'the public .gitignore is not written');
  mkdirSync(join(work, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(work, 'node_modules', 'pkg', 'i.js'), '');
  mkdirSync(join(work, '__pycache__')); writeFileSync(join(work, '__pycache__', 'tool.cpython-312.pyc'), '');
  writeFileSync(join(work, 'real.txt'), 'x');
  assert.deepEqual(git(work, 'status', '--porcelain', '-uall').trim().split('\n'), ['?? real.txt'], 'generated files are not offered to a commit');
  // a repo with a .gitignore of its own is not told it has none
  const withIgnore = remote({ 'package.json': '{}', '.gitignore': 'node_modules\n' });
  const has = runInit({ github: 'me/app', upstream: join(withIgnore.root, 'u'), work: join(withIgnore.root, 'w'), url: withIgnore.bare, reposFile: withIgnore.repos, skipCheck: true, ...ready });
  assert.equal(has.prerequisites.gitignore.present, true);
  assert.doesNotMatch(has.warnings.join('\n'), /\.gitignore がありません/);
});

test('the overview is carried in the result for the door, and a registration without one says P-1 was not made', () => {
  const r = remote({ 'README.md': '# app\n' });
  const none = runInit({ github: 'me/app', upstream: join(r.root, 'u'), work: join(r.root, 'w'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready });
  assert.equal(none.prerequisites.overview.state, 'none');
  assert.match(none.warnings.join('\n'), /概要（P-1）を渡していない/);
  writeFileSync(r.repos, 'repos:\n');
  const given = runInit({ github: 'me/app', upstream: join(r.root, 'u2'), work: join(r.root, 'w2'), url: r.bare, reposFile: r.repos, skipCheck: true, ...ready, overview: '  メモを取る小さな CLI  ' });
  assert.deepEqual(given.prerequisites.overview, { state: 'pending', statement: 'メモを取る小さな CLI' });
  assert.doesNotMatch(given.warnings.join('\n'), /概要（P-1）/);
});

/** a repo whose CI runs two checks after an install, and a throwaway place for the list */
function listed() {
  const r = remote({ 'README.md': '# app\n', '.github/workflows/ci.yml': CI });
  const base = { github: 'me/app', url: r.bare, reposFile: r.repos, skipCheck: true, listLabels: ready.listLabels, author: ready.author };
  const at = (name) => join(r.root, name);
  return {
    r, base, at,
    reg: () => reg(r),
    publicOf: () => reg(r).checks.filter((c) => c.scope === 'public'),
    /** a run into `u<tag>` and `w<tag>`, with what else the case needs */
    go: (extra, tag = '') => runInit({ ...base, upstream: at(`u${tag}`), work: at(`w${tag}`), ...extra }),
    /** a registry of its own, empty, so a second registration of the same repo is not a duplicate */
    registry: (name) => { writeFileSync(at(name), 'repos:\n'); return at(name); },
    writeList: (name, lines) => { writeFileSync(at(name), lines.join('\n') + '\n'); return at(name); },
  };
}

const succeeded = (res) => { assert.ok(res.ok, JSON.stringify(res.blockers)); return res; };
const stoppedOn = (res, why, label) => { assert.equal(res.ok, false, label); assert.match(res.blockers.join(' '), why, label); };

test('a dry run writes the checks and setup it would declare, each check with the file it was read from, and changes nothing else', () => {
  const { r, go, at, base } = listed();
  const res = succeeded(go({ dryRun: true, checksOut: at('list.yaml') }));
  const list = yamlLoad(readFileSync(at('list.yaml'), 'utf8'));
  assert.deepEqual(list.checks.map((c) => [c.command, c.from]), [['npm test', '.github/workflows/ci.yml'], ['npx eslint . --max-warnings 0', '.github/workflows/ci.yml']]);
  assert.deepEqual(list.setup, ['npm ci']);
  assert.match(res.steps.join('\n'), /検査と setup の一覧を書き出した/);
  assert.equal(existsSync(at('u')), false, 'no upstream');
  assert.equal(existsSync(at('w')), false, 'no work');
  assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n');
  // the entrance of an ecosystem is named as the place too
  const eco = remote({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}' });
  const ecoOut = join(eco.root, 'list.yaml');
  runInit({ ...base, github: 'me/eco', url: eco.bare, reposFile: eco.repos, upstream: join(eco.root, 'u'), work: join(eco.root, 'w'), dryRun: true, checksOut: ecoOut });
  assert.equal(yamlLoad(readFileSync(ecoOut, 'utf8')).checks[0].from, 'package.json の scripts.test');
  // an existing clone is read in place and left as it was
  const mine = at('mine');
  git(r.root, 'clone', '-q', r.bare, mine);
  const before = git(mine, 'status', '--porcelain');
  succeeded(go({ upstream: mine, existing: true, dryRun: true, checksOut: at('list2.yaml') }, '2'));
  assert.equal(git(mine, 'status', '--porcelain'), before);
  assert.ok(existsSync(at('list2.yaml')));
});

test('the list is not written over an existing file, inside a clone, or by a run that registers', () => {
  const { r, go, at } = listed();
  writeFileSync(at('mine.yaml'), 'checks: []\n');
  stoppedOn(go({ dryRun: true, checksOut: at('mine.yaml') }), /既にあります/);
  assert.equal(readFileSync(at('mine.yaml'), 'utf8'), 'checks: []\n', 'the file a person may have edited is left alone');
  stoppedOn(go({ dryRun: true, checksOut: join(at('u'), 'list.yaml') }), /外に書き出して/);
  stoppedOn(go({ checksOut: at('new.yaml') }), /--dry-run/);
  assert.equal(existsSync(at('new.yaml')), false);
  assert.equal(existsSync(at('w')), false);
  assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n');
});

test('the list is not written into the registry or into a clone reached through a symlink or a place not made yet', () => {
  const { r, base, go, at } = listed();
  // the registry that is not made yet: writing the list there would make the next registration stop on a YAML error
  const noRegistry = at('config/repos.yaml');
  stoppedOn(go({ reposFile: noRegistry, dryRun: true, checksOut: noRegistry }), /repos\.yaml/);
  assert.equal(existsSync(noRegistry), false);
  // a place under the registry file, which is not made yet: making its parent would turn the registry path into a directory
  const underRegistry = at('config2/repos.yaml');
  stoppedOn(go({ reposFile: underRegistry, dryRun: true, checksOut: join(underRegistry, 'checks.yaml') }), /repos\.yaml/);
  assert.equal(existsSync(underRegistry), false);
  const mine = at('mine');
  git(r.root, 'clone', '-q', r.bare, mine);
  symlinkSync(mine, at('link'));
  symlinkSync(at('w3'), at('wlink'));
  symlinkSync(at('nowhere.yaml'), at('dangling.yaml'));
  const before = git(mine, 'status', '--porcelain');
  const inClone = { upstream: mine, existing: true };
  const cases = [
    ['a symlink to the upstream', { ...inClone, checksOut: join(at('link'), 'list.yaml') }, /外に書き出して/],
    ['a symlink to the upstream under a parent not made yet', { ...inClone, checksOut: join(at('link'), 'sub', 'deeper', 'list.yaml') }, /外に書き出して/],
    ['a symlink to the work not made yet', { work: at('w3'), checksOut: join(at('wlink'), 'list.yaml') }, /外に書き出して/],
    ['the place the work clone is made under', { work: join(at('wparent'), 'w4'), checksOut: at('wparent') }, /外に書き出して/],
    ['a parent of the work not made yet', { work: join(at('wparent2'), 'deep', 'w5'), checksOut: at('wparent2') }, /外に書き出して/],
    ['a parent of the upstream not made yet', { upstream: join(at('uparent'), 'u2'), checksOut: at('uparent') }, /外に書き出して/],
    ['a link that dangles at the file itself', { checksOut: at('dangling.yaml') }, /既にあります/],
    ['a name that starts with two dots in the upstream', { ...inClone, checksOut: join(mine, '..cache', 'list.yaml') }, /外に書き出して/],
    ['a name that starts with two dots in the work', { ...inClone, work: at('wdots'), checksOut: join(at('wdots'), '..cache', 'list.yaml') }, /外に書き出して/],
  ];
  for (const [label, extra, why] of cases) stoppedOn(runInit({ ...base, upstream: at('u'), work: at('w2'), dryRun: true, ...extra }), why, label);
  for (const none of [join(mine, 'sub'), join(mine, '..cache'), at('w3'), at('wdots'), at('nowhere.yaml'), at('wparent'), at('wparent2'), at('uparent')]) assert.equal(existsSync(none), false, none);
  assert.equal(git(mine, 'status', '--porcelain'), before);
  // a place outside every protected path still works
  succeeded(go({ dryRun: true, checksOut: at('out/list.yaml') }));
  assert.ok(existsSync(at('out/list.yaml')));
});

test('a registration declares exactly the list it is given: a check added, a check dropped and a command corrected', () => {
  const { base, go, publicOf, reg: entry, writeList } = listed();
  const list = writeList('list.yaml', [
    'checks:',
    '  - name: unit',
    '    command: "npm run unit"',
    '    from: ".github/workflows/ci.yml"',
    '  - command: "make audit"',
    'setup:',
    '  - "npm ci --ignore-scripts"',
  ]);
  const res = succeeded(go({ checksFile: list }));
  // npm test was corrected, the eslint line was dropped, make audit was added by hand
  assert.deepEqual(publicOf().map((c) => [c.name, c.command.at(-1), c.required]), [['unit', 'npm run unit', true], ['test', 'make audit', true]]);
  assert.deepEqual(setupOf({ repos: base.reposFile }), ['npm ci --ignore-scripts']);
  assert.ok(entry().checks.some((c) => c.scope === 'records'), 'the record check stays');
  assert.deepEqual(res.prerequisites.publicChecks.checks.map((c) => c.from), ['.github/workflows/ci.yml', 'list.yaml で足した行']);
});

test('a dry run with a list reads it as the run would and does not write the list out again', () => {
  const { r, go, writeList } = listed();
  const res = succeeded(go({ dryRun: true, checksFile: writeList('list.yaml', ['checks:', '  - command: "npm run unit"', 'setup: []']) }));
  assert.equal(res.prerequisites.publicChecks.state, 'confirmed');
  assert.deepEqual(res.prerequisites.publicChecks.setupHints, []);
  assert.equal(existsSync(join(r.root, 'w')), false);
  assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n');
});

test('a registration without a list goes through and names the checks and setup nobody has gone over, and where to correct them', () => {
  const { r, go, registry } = listed();
  const res = succeeded(go({}));
  assert.deepEqual(res.blockers, []);
  const un = res.prerequisites.publicChecks.unconfirmed;
  assert.deepEqual(un.checks, ['test（npm test）', 'lint（npx eslint . --max-warnings 0）']);
  assert.deepEqual(un.setup, ['npm ci']);
  assert.ok(un.fix.includes(r.repos) && un.fix.includes('me/app'), 'the place to correct is the registry entry');
  const said = res.warnings.filter((w) => w.includes('確かめていません'));
  assert.equal(said.length, 1);
  assert.match(said[0], /npm test/);
  assert.match(said[0], /npm ci/);
  // a check named with --check is the user's own; the setup copied beside it is still unconfirmed
  const given = succeeded(go({ reposFile: registry('r2.yaml'), checks: ['npm run unit'] }, '2'));
  assert.deepEqual(given.prerequisites.publicChecks.unconfirmed.checks, []);
  assert.deepEqual(given.prerequisites.publicChecks.unconfirmed.setup, ['npm ci']);
  // a dry run says the same, and points at the list that confirms it
  const dry = go({ dryRun: true, reposFile: registry('r3.yaml') }, '3');
  assert.match(dry.prerequisites.publicChecks.unconfirmed.fix, /--checks-out/);
});

test('a registration with a list does not say anything is unconfirmed', () => {
  const { at, go, registry } = listed();
  go({ dryRun: true, checksOut: at('list.yaml') }, '0');
  const res = succeeded(go({ checksFile: at('list.yaml') }));
  assert.equal(res.prerequisites.publicChecks.state, 'confirmed');
  assert.equal('unconfirmed' in res.prerequisites.publicChecks, false);
  assert.doesNotMatch(res.warnings.join('\n'), /確かめていません|読み違い/);
  // the dry run that writes the list for the user to go over is not told it is unconfirmed either
  const dry = go({ reposFile: registry('r2.yaml'), dryRun: true, checksOut: at('list2.yaml') }, '2');
  assert.equal('unconfirmed' in dry.prerequisites.publicChecks, false);
  assert.doesNotMatch(dry.warnings.join('\n'), /確かめていません/);
});

test('a list that cannot be read stops the registration with the reason and writes neither the work clone nor the registry', () => {
  const { r, go, at, writeList } = listed();
  const unreadable = {
    missing: [null, /file がありません/],
    nocmd: [['checks:', '  - name: test', '    from: ci.yml'], /1 行目に command がありません/],
    empty: [['checks: []', 'setup: []'], /検査がありません/],
    extra: [['checks:', '  - command: npm test', '    required: false'], /知らない欄があります: required/],
    twice: [['checks:', '  - { name: a, command: npm test }', '  - { name: a, command: npm run lint }'], /name が重なっています/],
    bad: [['checks: ['], /YAML として読めません/],
    both: [['checks:', '  - command: npm test'], /同時に使えません/, { checks: ['npm test'] }],
  };
  for (const [label, [lines, why, more]] of Object.entries(unreadable)) {
    const checksFile = lines ? writeList(`${label}.yaml`, lines) : at('nope.yaml');
    stoppedOn(go({ checksFile, ...more }, `-${label}`), why, label);
    for (const left of [`w-${label}`, `u-${label}`]) assert.equal(existsSync(at(left)), false, `${label}: ${left} is not left`);
    assert.equal(readFileSync(r.repos, 'utf8'), 'repos:\n', `${label}: no registry`);
  }
  // a dry run stops for the same reason
  stoppedOn(go({ dryRun: true, checksFile: at('nope.yaml') }, 'd'), /file がありません/);
});

test('an empty list is rendered so that a line can be added under it, and the edited list reads back', () => {
  const text = renderCheckList({ checks: [], setup: [] });
  assert.doesNotMatch(text, /^(checks|setup): \[\]/m, 'a flow-style empty list takes no line under it');
  assert.match(text, /^checks:$/m);
  assert.match(text, /^setup:$/m);
  const dir = tmpDir('idd-checks-list-');
  const empty = join(dir, 'empty.yaml');
  writeFileSync(empty, text);
  const none = readCheckList(empty);
  assert.deepEqual('list' in none && none.list, { checks: [], setup: [] }, 'the untouched list reads as empty');
  const edited = join(dir, 'edited.yaml');
  writeFileSync(edited, text.replace(/^checks:$/m, 'checks:\n  - name: test\n    command: npm test\n    from: ci.yml').replace(/^setup:$/m, 'setup:\n  - npm ci'));
  const read = readCheckList(edited);
  assert.ok('list' in read, JSON.stringify(read));
  assert.deepEqual(read.list, { checks: [{ name: 'test', command: 'npm test', from: 'ci.yml' }], setup: ['npm ci'] });
});

test('two spellings of one place are the same place once its filesystem is known to ignore letter case', () => {
  const dir = tmpDir('idd-fold-');
  mkdirSync(join(dir, 'Upstream'));
  const folded = (p) => foldedPlace(p, true);
  assert.equal(folded(join(dir, 'upstream', 'out.yaml')), folded(join(dir, 'UPSTREAM', 'out.yaml')), 'a place not made yet compares by its folded spelling');
  assert.notEqual(foldedPlace(join(dir, 'upstream'), false), foldedPlace(join(dir, 'Upstream'), false), 'without the fold the spellings differ');
  assert.equal(foldedPlace(join(dir, 'Upstream'), false), join(realPathOf(dir), 'Upstream'), 'a filesystem that tells letters apart keeps the spelling');
  // the probe answers for the filesystem it is on: a directory and its other-case name are one inode only when case is ignored
  assert.equal(ignoresCase(join(dir, 'Upstream', 'new')), existsSync(join(dir, 'UPSTREAM')));
});

const realPathOf = (p) => realpathSync(p);

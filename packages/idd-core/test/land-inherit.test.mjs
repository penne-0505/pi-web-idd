import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { approveLand, landCheckedAt, landPath, landPlaceOf, prepareLand as prepareLandNow, readLand, ROOT_PLACE } from '../src/overlay/land.ts';
import { laneLocations } from '../src/overlay/export.ts';
import { landRunChecking, readLandRounds } from '../src/overlay/land-run.ts';
import { save } from '../src/overlay/git.ts';
import { buildSubmit } from '../src/plan/ship.ts';
import { runLand } from '../src/plan/land.ts';
import { parseRepos } from '../src/config/areas.ts';
import { landFailureCause } from '../src/overlay/land.ts';
import { landFailureCauseReference } from '../src/overlay/land-failure-reference.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { landApproved } from './passkey-approval.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file', IDD_LANE_SCOPE: 'off' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

/** a project with the work clone, its remote and an upstream clone, plus one lane; `extra` goes into the repos.yaml entry */
function setup(extra = {}, packages = null, files = null) {
  process.chdir(original);
  const root = scratchDir('land-inherit-');
  const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n'); put(join(work, 'app.txt'), 'one\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'test'); git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  if (packages) {
    for (const [dir, spec] of Object.entries(packages)) put(join(work, 'packages', dir, 'package.json'), `${JSON.stringify(spec)}\n`);
    commit(work, 'chore: the packages');
  }
  // code the lane starts from: a relative import into another package, written before the lane exists so neither side
  // counts it as a change of its own
  if (files) {
    for (const [file, text] of Object.entries(files)) put(join(work, file), text);
    commit(work, 'chore: the code');
  }
  const areas = join(root, 'repos.yaml');
  const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], publish: false, issue_lane: { context: 'personal', source_type_priority: 'github' }, ...extra };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', source_type: 'github', gh_issue_url: 'https://github.com/test/project/issues/7' }) + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, executor_session_id: 'test-session' }) + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane };
}

/**
 * The repo's checks as files that count their own runs: each appends one byte to its own file, outside the copies, so
 * a test can tell a check that ran from a result that was carried over.
 */
function countingChecks() {
  const at = scratchDir('land-inherit-marks-');
  const path = (name) => join(at, `${name}.log`);
  const read = (name) => { try { return readFileSync(path(name), 'utf8').length; } catch { return 0; } };
  return {
    checks: [
      { name: 'code', command: `printf x >> ${JSON.stringify(path('code'))}`, required: true },
      { name: 'records', command: `printf x >> ${JSON.stringify(path('records'))}`, required: true, scope: 'records' },
    ],
    increments: [
      { name: 'warns', command: `printf x >> ${JSON.stringify(path('warns'))}; echo 0`, count: 'number', required: true, timeout_minutes: 2 },
    ],
    counts: { code: () => read('code'), records: () => read('records'), warns: () => read('warns') },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(20); }
  throw new Error('待ちが timeout しました');
}
/** wait for the lane's landing check to end and answer the record it wrote (null when it wrote none) */
async function landSettled(id) {
  await waitFor(() => !landRunChecking(id));
  return readLand(id);
}
/** the preparation as a reader sees it: start the check and wait for the record it wrote, unless it wrote one itself */
async function prepareLand(id) {
  const res = await prepareLandNow(id);
  if (typeof res !== 'object' || res === null || !('checking' in res) || res.waiting) return res;
  return await landSettled(id);
}
/** put the lane at the submit card, as the engine's own records would */
async function atShip() {
  await seedLifecycle('lane_open', 'IDD-1', {});
  await seedLifecycle('s2_start', 'IDD-1', {});
  await seedLifecycle('s2_result', 'IDD-1', {});
  await seedLifecycle('s3_ready', 'IDD-1', {});
  await seedLifecycle('s3_ok', 'IDD-1', {});
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
}
const laneEvents = (id) => readLifecycle().filter((e) => e.idd_id === id);
const eventsOf = (id) => laneEvents(id).map((e) => e.event);
const mainTip = (f) => git(f.work, 'rev-parse', 'HEAD');
const headSha = (f) => git(f.lane.path, 'rev-parse', 'HEAD');
/** the lane changes a root file: its place is the file itself */
const change = (f) => { put(join(f.lane.path, 'app.txt'), 'two\n'); commit(f.lane.path, 'feat: change'); };
/** the mainline moves in a place the lane never touched, and its records move too (the records do not count) */
const moveElsewhere = (f) => { put(join(f.work, 'lib', 'other.txt'), 'other\n'); put(join(f.work, '_docs', 'notes', 'note.md'), 'a record\n'); commit(f.work, 'chore: mainline moves elsewhere'); };
/** the packages a fixture repo holds: the dir, the name it declares and the `@idd/*` packages it depends on */
const PACKAGES = {
  'idd-core': { name: '@idd/core', dependencies: {} },
  'idd-engine': { name: '@idd/engine', dependencies: { '@idd/core': '*' } },
  'idd-shared': { name: '@idd/shared', dependencies: {} },
  demo: { name: '@demo/demo', dependencies: { '@idd/shared': '*' } },
};
/** two packages nothing declares between them: they only read each other through the code */
const PACKAGES_READ = {
  'idd-core': { name: '@idd/core', dependencies: {} },
  'idd-fold': { name: '@idd/fold', dependencies: {} },
};
/** the fold imports the core by a relative path, the kind no `package.json` records */
const READ_EDGE = { [join('packages', 'idd-fold', 'src', 'fold.ts')]: 'import { x } from "../../idd-core/x.ts";\n' };
/** a change of one file in one package of a repo: a lane or the mainline */
const changeFile = (at, file, message) => { put(join(at, file), 'x\n'); commit(at, message); };
/** the lane changes a file inside one package: its place is that package, not the root */
const changeInPackage = (f) => { put(join(f.lane.path, 'packages', 'demo', 'lane.txt'), 'lane\n'); commit(f.lane.path, 'feat: a change in the package'); };
/** the mainline changes one file at the root of the tree, in a place of its own */
const moveRoot = (f, name, text) => { put(join(f.work, name), text); commit(f.work, `chore: mainline moves ${name}`); };
/** more declarations for the fixture's repo entry (`increments`, `setup`, ...), as penne would write them */
function declare(f, extra) {
  const path = process.env.IDD_REPOS_FILE;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(raw.repos.demo, extra);
  put(path, JSON.stringify(raw));
}
/** root-side code that reads a package: by a relative path, or by the name the package declares */
const ROOT_READ_PATH = { [join('lib', 'ui.ts')]: 'import { x } from "../packages/idd-core/x.ts";\n' };
const ROOT_READ_NAME = { [join('lib', 'ui.ts')]: 'import { x } from "@idd/core";\n' };

test('a changed path is judged by its package, its top-level dir or the root; a record has no place', () => {
  assert.equal(landPlaceOf('_docs/notes/note.md'), null, 'a record is not counted');
  assert.equal(landPlaceOf('_docs'), null);
  assert.equal(landPlaceOf('app.txt'), ROOT_PLACE, 'the root is one place, whichever file is touched');
  assert.equal(landPlaceOf('package.json'), ROOT_PLACE);
  assert.equal(landPlaceOf('lib/a.txt'), 'lib/', 'a top-level dir is one place');
  assert.equal(landPlaceOf('packages/idd-core/src/a.ts'), 'packages/idd-core/', 'a package is one place');
  assert.equal(landPlaceOf('packages/README.md'), 'packages/', 'a file directly under packages is not a package');
});

test('AC-001: a check at a moved tip carries the code side and the increment over and runs the records checks again', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks, increments: c.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  assert.deepEqual(first.checks.map((x) => x.name).sort(), ['code', 'records', 'warns']);
  assert.equal(c.counts.code(), 1);
  assert.equal(c.counts.records(), 1);
  assert.equal(c.counts.warns(), 2, 'the increment is measured on both sides');
  const firstTip = first.mainTip;
  const firstMerge = first.mergeCommit;
  // the mainline moves in another place, and lands another lane's records on the way
  moveElsewhere(f);
  const second = await prepareLand('IDD-1');
  assert.equal(second.mainTip, mainTip(f), 'the record is the check at the mainline as it is now');
  assert.notEqual(second.mainTip, firstTip);
  assert.notEqual(second.mergeCommit, firstMerge, 'the merge commit is the one of the new tip');
  assert.equal(git(f.work, 'rev-parse', `${second.mergeCommit}^1`), second.mainTip);
  assert.equal(git(f.work, 'rev-parse', `${second.mergeCommit}^2`), headSha(f));
  assert.equal(c.counts.code(), 1, 'the code check did not run again');
  assert.equal(c.counts.warns(), 2, 'the increment did not run again');
  assert.equal(c.counts.records(), 2, 'the records check ran at the new merge commit');
  // the record names the tip the carried results were run at, and the checks that came with them
  assert.equal(second.inherit.mainTip, firstTip);
  assert.equal(second.inherit.mergeCommit, firstMerge);
  assert.deepEqual(second.inherit.checks.map((x) => x.name).sort(), ['code', 'warns']);
  assert.deepEqual(second.checks.map((x) => x.name).sort(), ['code', 'records', 'warns']);
  assert.equal(second.checks.find((x) => x.name === 'records').status, 'pass');
  // the carried checks say which tip they were run at, so the card's list is not read as a full run at the new tip
  const carried = second.checks.find((x) => x.name === 'code');
  assert.equal(carried.status, 'pass');
  assert.match(carried.detail, new RegExp(firstTip.slice(0, 7)));
  assert.match(carried.detail, /前回の本流/);
  // the approval token and window are the ones an open card holds: the signature is over the same content
  assert.equal(second.token, first.token);
  assert.equal(second.expiresAt, first.expiresAt);
  // the run's own history tells the same about the round
  const round = readLandRounds('IDD-1').at(-1);
  assert.deepEqual(round.inherit.checks.sort(), ['code', 'warns']);
  assert.equal(round.inherit.mainTip, firstTip);
});

test('AC-001 / AC-002: a mainline move that touches only records does not stop a handover', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks, increments: c.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  put(join(f.work, '_docs', 'notes', 'other-lane.md'), 'another lane landed\n');
  commit(f.work, 'docs(records): another lane');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit?.mainTip, first.mainTip, JSON.stringify(second.inherit));
  assert.equal(c.counts.code(), 1);
  assert.equal(c.counts.records(), 2);
});

test('AC-002: a change in the same top-level dir or the same package runs every check again', async () => {
  const sameDir = countingChecks();
  const a = setup({ checks: sameDir.checks });
  put(join(a.lane.path, 'lib', 'lane.txt'), 'lane\n'); commit(a.lane.path, 'feat: a file in lib');
  const firstA = await prepareLand('IDD-1');
  put(join(a.work, 'lib', 'main.txt'), 'main\n'); commit(a.work, 'chore: another file in lib');
  const secondA = await prepareLand('IDD-1');
  assert.equal(secondA.inherit, undefined, 'the same top-level dir is the same place');
  assert.equal(sameDir.counts.code(), 2, 'the code check ran again');
  assert.equal(sameDir.counts.records(), 2);
  assert.notEqual(secondA.mainTip, firstA.mainTip);

  const samePackage = countingChecks();
  const b = setup({ checks: samePackage.checks });
  put(join(b.lane.path, 'packages', 'demo', 'lane.txt'), 'lane\n'); commit(b.lane.path, 'feat: a file in the package');
  const firstB = await prepareLand('IDD-1');
  put(join(b.work, 'packages', 'demo', 'main.txt'), 'main\n'); commit(b.work, 'chore: another file in the package');
  const secondB = await prepareLand('IDD-1');
  assert.equal(secondB.inherit, undefined, 'the same package is the same place');
  assert.equal(samePackage.counts.code(), 2);
  assert.notEqual(secondB.mainTip, firstB.mainTip);
});

test('AC-002: a mainline change to a root setting runs every check again, whichever place the lane changed', async () => {
  for (const [file, text] of [['eslint.config.mjs', 'export default [];\n'], ['package.json', '{"name":"demo"}\n']]) {
    const c = countingChecks();
    const f = setup({ checks: c.checks, increments: c.increments });
    changeInPackage(f);
    const first = await prepareLand('IDD-1');
    assert.equal(first.blocking, 0, JSON.stringify(first.checks));
    assert.equal(c.counts.code(), 1);
    moveRoot(f, file, text);
    const second = await prepareLand('IDD-1');
    assert.equal(second.inherit, undefined, `${file}: a root setting is read by every code check, whatever place the lane changed`);
    assert.notEqual(second.mainTip, first.mainTip);
    assert.equal(git(f.work, 'rev-parse', `${second.mergeCommit}^1`), second.mainTip);
    assert.equal(c.counts.code(), 2, `${file}: the code check ran again`);
    assert.equal(c.counts.records(), 2, `${file}: the records check ran again`);
    assert.equal(c.counts.warns(), 4, `${file}: the increment ran again`);
  }
});

test('AC-002: a package that depends on a changed package meets it, whichever side changed which', async () => {
  // the mainline changes the package the lane's package depends on
  const down = countingChecks();
  const f = setup({ checks: down.checks }, PACKAGES);
  changeFile(f.lane.path, join('packages', 'idd-engine', 'lane.txt'), 'feat: a change in the engine');
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  changeFile(f.work, join('packages', 'idd-core', 'main.txt'), 'chore: the core moves');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'the engine reads the core, so a change to the core meets the engine');
  assert.notEqual(second.mainTip, first.mainTip);
  assert.equal(down.counts.code(), 2, 'the code check ran again');
  assert.equal(down.counts.records(), 2);

  // the other way round: the mainline changes the package that depends on the lane's
  const up = countingChecks();
  const g = setup({ checks: up.checks }, PACKAGES);
  changeFile(g.lane.path, join('packages', 'idd-core', 'lane.txt'), 'feat: a change in the core');
  await prepareLand('IDD-1');
  changeFile(g.work, join('packages', 'idd-engine', 'main.txt'), 'chore: the engine moves');
  const secondG = await prepareLand('IDD-1');
  assert.equal(secondG.inherit, undefined, 'the engine depends on the core, so a change to the engine is read against the core');
  assert.equal(up.counts.code(), 2);
});

test("AC-002: a mainline change to a package the lane's package depends on runs every check again", async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks }, PACKAGES);
  changeFile(f.lane.path, join('packages', 'demo', 'lane.txt'), 'feat: a change in demo');
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  changeFile(f.work, join('packages', 'idd-shared', 'main.txt'), 'chore: the shared package moves');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'demo depends on the shared package');
  assert.notEqual(second.mainTip, first.mainTip);
  assert.equal(c.counts.code(), 2, 'the code check ran again');
  assert.equal(c.counts.records(), 2);
});

test('AC-002: a file directly under packages/ is read by every package, whichever side changed it', async () => {
  const a = countingChecks();
  const f = setup({ checks: a.checks }, PACKAGES);
  changeFile(f.lane.path, join('packages', 'demo', 'lane.txt'), 'feat: a change in demo');
  await prepareLand('IDD-1');
  changeFile(f.work, join('packages', 'README.md'), 'chore: the packages are listed differently');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'the mainline changed the dir every package is listed in');
  assert.equal(a.counts.code(), 2, 'the code check ran again');

  const b = countingChecks();
  const g = setup({ checks: b.checks }, PACKAGES);
  changeFile(g.lane.path, join('packages', 'README.md'), 'feat: the lane lists the packages differently');
  await prepareLand('IDD-1');
  changeFile(g.work, join('packages', 'demo', 'main.txt'), 'chore: a change in demo');
  const secondG = await prepareLand('IDD-1');
  assert.equal(secondG.inherit, undefined, 'the other way round: the lane changed the dir the package is listed in');
  assert.equal(b.counts.code(), 2);
});

test('AC-002: packages that read each other through a relative import meet, though nothing is declared', async () => {
  // the lane changes the package that imports the core; the mainline changes the core
  const down = countingChecks();
  const f = setup({ checks: down.checks }, PACKAGES_READ, READ_EDGE);
  changeFile(f.lane.path, join('packages', 'idd-fold', 'lane.txt'), 'feat: a change in the fold');
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  changeFile(f.work, join('packages', 'idd-core', 'main.txt'), 'chore: the core moves');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'the fold reads the core through an import no package.json declares');
  assert.notEqual(second.mainTip, first.mainTip);
  assert.equal(down.counts.code(), 2, 'the code check ran again');
  assert.equal(down.counts.records(), 2);

  // the other way round: the mainline changes the package the lane's package reads from
  const up = countingChecks();
  const g = setup({ checks: up.checks }, PACKAGES_READ, READ_EDGE);
  changeFile(g.lane.path, join('packages', 'idd-core', 'lane.txt'), 'feat: a change in the core');
  await prepareLand('IDD-1');
  changeFile(g.work, join('packages', 'idd-fold', 'main.txt'), 'chore: the fold moves');
  const secondG = await prepareLand('IDD-1');
  assert.equal(secondG.inherit, undefined, 'the core is read by the fold, so a change to the fold is read against the core');
  assert.equal(up.counts.code(), 2);

  // the control: without the import, two packages that declare nothing between them are carried over
  const control = countingChecks();
  const h = setup({ checks: control.checks }, PACKAGES_READ);
  changeFile(h.lane.path, join('packages', 'idd-fold', 'lane.txt'), 'feat: a change in the fold');
  const firstH = await prepareLand('IDD-1');
  changeFile(h.work, join('packages', 'idd-core', 'main.txt'), 'chore: the core moves');
  const secondH = await prepareLand('IDD-1');
  assert.equal(secondH.inherit?.mainTip, firstH.mainTip, 'with no import and no declaration the two packages do not meet');
  assert.equal(control.counts.code(), 1, 'the code check did not run again');
});

test('AC-002: an edge the new mainline tip added still meets the lane, though the checked tip had none', async () => {
  // the control: the mainline changes the core with no edge to demo, so the lane changing demo is carried over
  const control = countingChecks();
  const c = setup({ checks: control.checks }, PACKAGES);
  changeFile(c.lane.path, join('packages', 'demo', 'lane.txt'), 'feat: a change in demo');
  const firstC = await prepareLand('IDD-1');
  changeFile(c.work, join('packages', 'idd-core', 'main.txt'), 'chore: the core moves');
  const secondC = await prepareLand('IDD-1');
  assert.equal(secondC.inherit?.mainTip, firstC.mainTip, 'no edge at either tip: the two packages do not meet');
  assert.equal(control.counts.code(), 1, 'the code check did not run again');

  // a declaration the mainline adds at the new tip
  const declared = countingChecks();
  const f = setup({ checks: declared.checks }, PACKAGES);
  changeFile(f.lane.path, join('packages', 'demo', 'lane.txt'), 'feat: a change in demo');
  const first = await prepareLand('IDD-1');
  put(join(f.work, 'packages', 'idd-core', 'main.txt'), 'x\n');
  put(join(f.work, 'packages', 'idd-core', 'package.json'), `${JSON.stringify({ name: '@idd/core', dependencies: { '@idd/demo': '*' } })}\n`);
  commit(f.work, 'chore: the core starts using demo');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'the new tip made the core read demo, so the lane changing demo meets it');
  assert.notEqual(second.mainTip, first.mainTip);
  assert.equal(declared.counts.code(), 2, 'the code check ran again');
  assert.equal(declared.counts.records(), 2);

  // a relative import the mainline adds at the new tip
  const read = countingChecks();
  const g = setup({ checks: read.checks }, PACKAGES);
  changeFile(g.lane.path, join('packages', 'demo', 'lane.txt'), 'feat: a change in demo');
  await prepareLand('IDD-1');
  put(join(g.work, 'packages', 'idd-core', 'src', 'uses-demo.ts'), 'import { d } from "../../demo/src/d.ts";\nexport const u = d;\n');
  commit(g.work, 'chore: the core imports demo');
  const secondG = await prepareLand('IDD-1');
  assert.equal(secondG.inherit, undefined, 'the new tip made the core import demo, so the lane changing demo meets it');
  assert.equal(read.counts.code(), 2, 'the code check ran again');
});

test('AC-002: a lane change to a shared setting runs every check again, wherever the mainline moved', async () => {
  // the control: a lane change in its own place with the same mainline move is carried over
  const control = countingChecks();
  const base = setup({ checks: control.checks }, PACKAGES);
  changeInPackage(base);
  const firstBase = await prepareLand('IDD-1');
  moveElsewhere(base);
  const secondBase = await prepareLand('IDD-1');
  assert.equal(secondBase.inherit?.mainTip, firstBase.mainTip, JSON.stringify(secondBase.inherit));
  assert.equal(control.counts.code(), 1);
  for (const file of ['package.json', 'tsconfig.build.json', 'eslint.config.mjs', 'bun.lock', 'config/repos.yaml', join('packages', 'idd-lane', 'src', 'runner.ts')]) {
    const c = countingChecks();
    const f = setup({ checks: c.checks }, PACKAGES);
    changeFile(f.lane.path, file, `chore: a lane change to ${file}`);
    changeInPackage(f);
    const first = await prepareLand('IDD-1');
    assert.equal(first.blocking, 0, `${file}: ${JSON.stringify(first.checks)}`);
    moveElsewhere(f);
    const second = await prepareLand('IDD-1');
    assert.equal(second.inherit, undefined, `${file}: a shared setting is read by every code check`);
    assert.notEqual(second.mainTip, first.mainTip);
    assert.equal(c.counts.code(), 2, `${file}: the code check ran again`);
    assert.equal(c.counts.records(), 2, `${file}: the records check ran again`);
  }
});

test('AC-001: a mainline change to a root record alone does not stop a handover', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks, increments: c.increments });
  changeInPackage(f);
  const first = await prepareLand('IDD-1');
  moveRoot(f, 'TODO.md', '# TODO\n\n- [ ] a task\n');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit?.mainTip, first.mainTip, JSON.stringify(second.inherit));
  assert.equal(c.counts.code(), 1, 'a root record is read by the records checks only');
  assert.equal(c.counts.warns(), 2);
  assert.equal(c.counts.records(), 2);
});

test('AC-003: a failed, expired, other-head, other-settings or unreadable record is not carried over', async () => {
  const cases = [
    ['a failing blocking check', (rec) => ({ ...rec, checks: [{ name: 'code', status: 'fail', severity: 'blocking', detail: 'boom' }], blocking: 1 })],
    ['an expired record', (rec) => ({ ...rec, expiresAt: new Date(0).toISOString() })],
    ['another lane head', (rec) => ({ ...rec, head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })],
    ['other settings', (rec) => ({ ...rec, configKey: 'another-settings-key' })],
    ['a tip git cannot walk from', (rec) => ({ ...rec, mainTip: 'cafebabecafebabecafebabecafebabecafebabe' })],
  ];
  for (const [name, mutate] of cases) {
    const c = countingChecks();
    const f = setup({ checks: c.checks });
    change(f);
    const first = await prepareLand('IDD-1');
    save(landPath('IDD-1'), mutate(first));
    moveElsewhere(f);
    const second = await prepareLand('IDD-1');
    assert.equal(second.inherit, undefined, name);
    assert.equal(c.counts.code(), 2, `${name}: the code check ran again`);
    assert.equal(c.counts.records(), 2, `${name}: the records check ran again`);
  }
});

test('AC-004: the lifecycle line, the card and the tick read the same carried checks and tip', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks, increments: c.increments });
  await atShip();
  change(f);
  const first = await prepareLand('IDD-1');
  moveElsewhere(f);
  // the tick prepares the lane at the moved tip: its stage result carries the handover it decided
  const stage = await runLand();
  await landSettled('IDD-1');
  const second = readLand('IDD-1');
  assert.deepEqual(stage.inherited, [{ iddId: 'IDD-1', from: first.mainTip, checks: ['code', 'warns'] }]);
  assert.equal(eventsOf('IDD-1').includes('s4_land_inherit'), false, 'no name the timeline does not know');
  const line = laneEvents('IDD-1').filter((e) => e.event === 's4_land_recheck' && e.attrs?.inherit).at(-1);
  assert.ok(line, 'the lifecycle has the line');
  assert.equal(line.attrs.head, second.head);
  assert.equal(line.attrs.main_tip, second.mainTip);
  assert.equal(line.attrs.inherit.from_main_tip, first.mainTip);
  assert.equal(line.attrs.inherit.from_merge_commit, first.mergeCommit);
  assert.deepEqual([...line.attrs.inherit.inherited].sort(), ['code', 'warns']);
  assert.deepEqual(line.attrs.inherit.ran, ['records']);
  assert.match(line.attrs.reason, /前回の本流/);
  // the card reads the same record: its check list says which rows came from the earlier tip
  const view = buildSubmit('IDD-1');
  assert.equal(view.land.inherit.mainTip, line.attrs.inherit.from_main_tip);
  const cardCode = view.land.checks.find((x) => x.name === 'code');
  assert.match(cardCode.detail, new RegExp(first.mainTip.slice(0, 7)));
});

test('AC-005: the approval of a carried-over record moves the mainline to the new merge commit and closes the lane', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks, increments: c.increments });
  await atShip();
  change(f);
  const first = await prepareLand('IDD-1');
  moveElsewhere(f);
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit.mainTip, first.mainTip);
  // the mainline moves once more before penne signs: the pair is judged again from the tip the results were run at
  put(join(f.work, 'config', 'other.yaml'), 'x\n'); commit(f.work, 'chore: mainline moves again');
  const third = await prepareLand('IDD-1');
  assert.equal(third.inherit.mainTip, first.mainTip, 'the carried results still name the tip they were run at');
  assert.equal(third.inherit.mergeCommit, first.mergeCommit);
  const carried = third.checks.find((x) => x.name === 'code');
  assert.equal((carried.detail.match(/引き継ぎました/g) ?? []).length, 1, 'the mark is written once, not stacked');
  assert.equal(third.token, first.token);
  const res = await approveLand('IDD-1', third.token, landApproved('IDD-1'));
  assert.equal(res.ok, true, res.error);
  assert.equal(mainTip(f), third.mergeCommit, 'the mainline went to the merge commit the carried record is of');
  assert.equal(git(f.work, 'rev-parse', `${third.mergeCommit}^1`), third.mainTip);
  assert.ok(eventsOf('IDD-1').includes('lane_close'));
  assert.equal(readLand('IDD-1').status, 'complete');
});

test('AC-001: a repo with no records check runs no check again, and the record is still written by a run', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks.filter((x) => x.name !== 'records') });
  change(f);
  const first = await prepareLand('IDD-1');
  moveElsewhere(f);
  const started = await prepareLandNow('IDD-1');
  assert.ok('checking' in started, JSON.stringify(started));
  const second = await landSettled('IDD-1');
  assert.equal(second.inherit.mainTip, first.mainTip);
  assert.equal(git(f.work, 'rev-parse', `${second.mergeCommit}^1`), mainTip(f), 'the record is of the new tip');
  assert.deepEqual(second.checks.map((x) => x.name).sort(), ['code']);
  assert.equal(c.counts.code(), 1, 'the code check did not run');
  assert.equal(readLandRounds('IDD-1').at(-1).inherit.mainTip, first.mainTip, 'the round says what it took over');
  assert.ok(laneEvents('IDD-1').some((e) => e.event === 's4_land_recheck' && e.attrs?.inherit));
});

test('AC-002: code outside packages/ that reads a changed package is checked again with it', async () => {
  for (const [kind, files] of [['a relative import', ROOT_READ_PATH], ['an @idd name', ROOT_READ_NAME]]) {
    const c = countingChecks();
    const f = setup({ checks: c.checks }, PACKAGES, files);
    changeFile(f.lane.path, join('lib', 'lane.ts'), 'feat: a change in lib');
    const first = await prepareLand('IDD-1');
    assert.equal(first.blocking, 0, `${kind}: ${JSON.stringify(first.checks)}`);
    changeFile(f.work, join('packages', 'idd-core', 'main.txt'), 'chore: the core moves');
    const second = await prepareLand('IDD-1');
    assert.equal(second.inherit, undefined, `${kind}: lib reads the core, so a change to the core meets it`);
    assert.equal(c.counts.code(), 2, `${kind}: the code check ran again`);
    assert.equal(c.counts.records(), 2, `${kind}: the records check ran again`);

    // the control: the same two places with no read between them are carried over
    const control = countingChecks();
    const g = setup({ checks: control.checks }, PACKAGES);
    changeFile(g.lane.path, join('lib', 'lane.ts'), 'feat: a change in lib');
    const firstG = await prepareLand('IDD-1');
    changeFile(g.work, join('packages', 'idd-core', 'main.txt'), 'chore: the core moves');
    const secondG = await prepareLand('IDD-1');
    assert.equal(secondG.inherit?.mainTip, firstG.mainTip, `${kind}: with no read the two places do not meet`);
    assert.equal(control.counts.code(), 1, `${kind}: the code check did not run again`);
  }
});

test('AC-002: a declaration added after the check stops the handover', async () => {
  // an increment declared after the check ran: the record has no result for it
  const c = countingChecks();
  const f = setup({ checks: c.checks });
  change(f);
  const first = await prepareLand('IDD-1');
  assert.deepEqual(first.checks.map((x) => x.name).sort(), ['code', 'records']);
  declare(f, { increments: c.increments });
  assert.equal(first.configKey, readLand('IDD-1').configKey, 'the increment is not in the settings hash');
  moveElsewhere(f);
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'the record has no result for the increment the declarations added');
  assert.deepEqual(second.checks.map((x) => x.name).sort(), ['code', 'records', 'warns']);
  assert.equal(c.counts.code(), 2, 'the code check ran again');
  assert.equal(c.counts.warns(), 2, 'the new increment ran at the new merge commit');

  // a checkPrep changed after the check ran: the copy the results were made in is not the copy this group makes
  const p = countingChecks();
  const g = setup({ checks: p.checks });
  change(g);
  await prepareLand('IDD-1');
  declare(g, { setup: ['true'] });
  moveElsewhere(g);
  const secondG = await prepareLand('IDD-1');
  assert.equal(secondG.inherit, undefined, 'the copy is made ready differently than when the record was checked');
  assert.equal(p.counts.code(), 2, 'the code check ran again');
  assert.equal(p.counts.records(), 2);
});

test('AC-003: a declaration added without the mainline moving is no checked group the tick reuses', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks });
  await atShip();
  change(f);
  await prepareLand('IDD-1');
  declare(f, { increments: c.increments });
  assert.equal(landCheckedAt('IDD-1', laneLocations('IDD-1')), null, 'the record has no result for the new declaration');
  await runLand();
  const second = await landSettled('IDD-1');
  assert.deepEqual(second.checks.map((x) => x.name).sort(), ['code', 'records', 'warns']);
  assert.equal(c.counts.code(), 2, 'the tick checked the whole group again');
  assert.equal(c.counts.warns(), 2, 'the increment ran at this tip');
});

/** a root tsconfig that names the tree itself by `@/`: the alias the code writes instead of a relative path */
const ALIAS_TSCONFIG = { 'tsconfig.json': `${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } })}\n` };
/** the lane changes a file in one top-level dir, reading another by an alias */
const laneReadsByAlias = (f, dep = 'components/x') => { put(join(f.lane.path, 'app', 'lane.ts'), `import { x } from "@/${dep}";\nexport const y = x;\n`); commit(f.lane.path, 'feat: the app reads through the alias'); };
/** the mainline changes a file in another top-level dir, where the alias of the lane's read lands */
const mainMovesReadComponent = (f) => { put(join(f.work, 'components', 'x.ts'), 'export const x = 1;\n'); commit(f.work, 'chore: the component moves'); };

test('AC-002: a lane reading another place through a tsconfig alias meets the mainline change to that place', async () => {
  const c = countingChecks();
  const f = setup({ checks: c.checks }, null, ALIAS_TSCONFIG);
  laneReadsByAlias(f);
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  mainMovesReadComponent(f);
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'app/lane.ts reads components/x.ts through @/, so the two places meet');
  assert.notEqual(second.mainTip, first.mainTip);
  assert.equal(git(f.work, 'rev-parse', `${second.mergeCommit}^1`), second.mainTip);
  assert.equal(c.counts.code(), 2, 'the code check ran again');
  assert.equal(c.counts.records(), 2, 'the records check ran again');

  // the other way round: the lane changes the place the mainline's new code reads through the alias
  const up = countingChecks();
  const g = setup({ checks: up.checks }, null, ALIAS_TSCONFIG);
  changeFile(g.lane.path, join('components', 'x.ts'), 'feat: the component');
  await prepareLand('IDD-1');
  put(join(g.work, 'app', 'uses.ts'), 'import { x } from "@/components/x";\nexport const u = x;\n');
  commit(g.work, 'chore: the app reads the component through the alias');
  const secondG = await prepareLand('IDD-1');
  assert.equal(secondG.inherit, undefined, 'the mainline added the alias read at the new tip, so the two places meet');
  assert.equal(up.counts.code(), 2, 'the code check ran again');
  assert.equal(up.counts.records(), 2);

  // the control: the same two places with no alias read between them are carried over
  const control = countingChecks();
  const h = setup({ checks: control.checks }, null, ALIAS_TSCONFIG);
  changeFile(h.lane.path, join('app', 'lane.ts'), 'feat: a change in the app');
  const firstH = await prepareLand('IDD-1');
  mainMovesReadComponent(h);
  const secondH = await prepareLand('IDD-1');
  assert.equal(secondH.inherit?.mainTip, firstH.mainTip, 'with no read the two places do not meet');
  assert.equal(control.counts.code(), 1, 'the code check did not run again');
});

test('AC-002: an alias read that lands in a package meets a change to that package', async () => {
  const c = countingChecks();
  const files = { 'tsconfig.json': `${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } })}\n` };
  const f = setup({ checks: c.checks }, PACKAGES, files);
  laneReadsByAlias(f, 'packages/demo/src/d');
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  changeFile(f.work, join('packages', 'demo', 'main.txt'), 'chore: demo moves');
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'the alias read lands in packages/demo/, so the package meets app/');
  assert.equal(c.counts.code(), 2, 'the code check ran again');
  assert.equal(c.counts.records(), 2);
});

test('AC-002: an alias declared through an extends chain is read, and a tsconfig that cannot be read meets', async () => {
  // the base tsconfig holds the alias; the root takes it through `extends`
  const chain = {
    'tsconfig.base.json': `${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } })}\n`,
    'tsconfig.json': `${JSON.stringify({ extends: './tsconfig.base.json' })}\n`,
  };
  const c = countingChecks();
  const f = setup({ checks: c.checks }, null, chain);
  laneReadsByAlias(f);
  await prepareLand('IDD-1');
  mainMovesReadComponent(f);
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit, undefined, 'the alias is read through extends, so the two places meet');
  assert.equal(c.counts.code(), 2, 'the code check ran again');

  // a tsconfig that is not JSON is a revision whose aliases cannot be read: the sides are taken as meeting
  const bad = { 'tsconfig.json': 'not json\n' };
  const p = countingChecks();
  const g = setup({ checks: p.checks }, null, bad);
  laneReadsByAlias(g);
  await prepareLand('IDD-1');
  mainMovesReadComponent(g);
  const secondG = await prepareLand('IDD-1');
  assert.equal(secondG.inherit, undefined, 'an unreadable tsconfig is taken as meeting');
  assert.equal(p.counts.code(), 2, 'the code check ran again');
  assert.equal(p.counts.records(), 2);
});

/**
 * A lint check and the eslint-json increment that can answer it: both are one script that counts its own runs in a file
 * outside the copies and prints what an eslint would (`-f json`) for the tree it runs in. The lane's change (app.txt
 * holding `two`) is the merge side; the mainline copy never holds it. `shared` writes the field that lets the increment's
 * run answer the lint check.
 */
function eslintLike({ shared, merged = {}, mainline = {}, noise = '', pad = '', sleepMerged = 0, timeout = 2, strays = false, trail = '' } = {}) {
  const at = scratchDir('land-shared-marks-');
  const script = join(at, 'eslint.cjs');
  const log = (name) => join(at, `${name}.log`);
  const read = (name) => { try { return readFileSync(log(name), 'utf8').length; } catch { return 0; } };
  writeFileSync(script, `
const fs = require('node:fs');
const side = fs.readFileSync('app.txt', 'utf8').includes('two') ? ${JSON.stringify({ errors: 0, warnings: 0, ...merged })} : ${JSON.stringify({ errors: 0, warnings: 0, ...mainline })};
const isMerged = fs.readFileSync('app.txt', 'utf8').includes('two');
if (isMerged && ${sleepMerged}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${sleepMerged} * 1000);
if (isMerged && ${strays}) fs.writeFileSync('stray.txt', 'left behind\\n');
const messages = [];
for (let i = 0; i < side.errors; i += 1) messages.push({ severity: 2, line: 3, column: 5, ruleId: 'no-undef', message: 'x is not defined' });
for (let i = 0; i < side.warnings; i += 1) messages.push({ severity: 1, line: 9, column: 1, ruleId: 'no-unused-vars', message: 'y is unused' });
const json = JSON.stringify([{ filePath: process.cwd() + '/src/a.ts', errorCount: side.errors, warningCount: side.warnings, messages }]);
if (${JSON.stringify(noise)}) process.stderr.write(${JSON.stringify(noise)} + '\\n');
if (${JSON.stringify(pad)}) process.stdout.write(${JSON.stringify(pad)} + '\\n');
process.stdout.write(json + '\\n');
if (${JSON.stringify(trail)}) process.stdout.write(${JSON.stringify(trail)} + '\\n');
if (${JSON.stringify(pad)}) process.stdout.write('done in 1.2s\\n');
process.exit(side.errors ? 1 : 0);
`);
  const run = (name) => `printf x >> ${JSON.stringify(log(name))}; node ${JSON.stringify(script)}`;
  return {
    checks: [
      { name: 'code', command: `printf x >> ${JSON.stringify(log('code'))}`, required: true },
      { name: 'lint', command: run('lint'), required: true, ...(shared ? { land_from_increment: 'eslint-warnings' } : {}) },
      { name: 'records', command: `printf x >> ${JSON.stringify(log('records'))}`, required: true, scope: 'records' },
    ],
    increments: [{ name: 'eslint-warnings', command: run('eslint'), count: 'eslint-json', required: true, timeout_minutes: timeout }],
    counts: { code: () => read('code'), lint: () => read('lint'), eslint: () => read('eslint'), records: () => read('records') },
  };
}
const rowsOf = (record) => Object.fromEntries(record.checks.map((x) => [x.name, x]));

test('AC-001: a lint declared as answered by the increment runs eslint once in the merge commit, and both rows come out in the declared order', async () => {
  const e = eslintLike({ shared: true, merged: { warnings: 1 }, mainline: { warnings: 1 } });
  const f = setup({ checks: e.checks, increments: e.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  assert.deepEqual(first.checks.map((x) => x.name), ['code', 'lint', 'records', 'eslint-warnings'], 'the lint row keeps the place its own run would have had');
  assert.equal(e.counts.lint(), 0, 'the lint command did not run in the copy');
  assert.equal(e.counts.eslint(), 2, 'eslint ran once in the merge commit and once in the mainline');
  const rows = rowsOf(first);
  assert.equal(rows.lint.status, 'pass');
  assert.equal(rows.lint.severity, 'blocking');
  assert.equal(rows.lint.counts, undefined, 'only the increment row carries the numbers');
  assert.deepEqual(rows['eslint-warnings'].counts, { mainline: 1, merged: 1, at: first.mainTip });
});

test('AC-006: a repo that declares nothing runs the lint and the increment as it did, under the same rows', async () => {
  const e = eslintLike({ shared: false, merged: { warnings: 1 }, mainline: { warnings: 1 } });
  const f = setup({ checks: e.checks, increments: e.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  assert.equal(first.blocking, 0, JSON.stringify(first.checks));
  assert.deepEqual(first.checks.map((x) => x.name), ['code', 'lint', 'records', 'eslint-warnings']);
  assert.equal(e.counts.lint(), 1, 'the lint command ran');
  assert.equal(e.counts.eslint(), 2);
});

test('AC-002: an eslint error in the merge commit stops the landing at the lint row, with the error in its detail', async () => {
  const e = eslintLike({ shared: true, merged: { errors: 2, warnings: 1 }, mainline: { warnings: 1 } });
  const f = setup({ checks: e.checks, increments: e.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  const rows = rowsOf(first);
  assert.equal(rows.lint.status, 'fail');
  assert.equal(rows.lint.severity, 'blocking');
  assert.match(rows.lint.detail, /eslint のエラー 2 件/);
  assert.match(rows.lint.detail, /a\.ts:3:5 no-undef x is not defined/);
  assert.equal(rows['eslint-warnings'].status, 'pass', 'the warnings did not increase, so the increment row is not the one that stopped it');
  assert.equal(first.blocking, 1);
  assert.equal(e.counts.lint(), 0);
});

test('AC-003: more warnings than the mainline stop the landing at the increment row, with both numbers', async () => {
  const e = eslintLike({ shared: true, merged: { warnings: 3 }, mainline: { warnings: 1 } });
  const f = setup({ checks: e.checks, increments: e.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  const rows = rowsOf(first);
  assert.equal(rows.lint.status, 'pass', 'warnings are not errors');
  assert.equal(rows['eslint-warnings'].status, 'fail');
  assert.equal(rows['eslint-warnings'].severity, 'blocking');
  assert.deepEqual(rows['eslint-warnings'].counts, { mainline: 1, merged: 3, at: first.mainTip });
  assert.match(rows['eslint-warnings'].detail, /本流 1 \/ 取り込み 3（\+2）/);
  assert.equal(first.blocking, 1);
});

test('AC-001: a lint that was skipped because the preparation failed stays skipped, not read from the increment', async () => {
  const e = eslintLike({ shared: true, merged: { warnings: 0 }, mainline: { warnings: 0 } });
  const f = setup({ checks: e.checks, increments: e.increments, setup: ['exit 1'] });
  change(f);
  const first = await prepareLand('IDD-1');
  const rows = rowsOf(first);
  assert.equal(rows.setup.status, 'fail');
  assert.equal(rows.lint.status, 'skipped');
  assert.equal(rows.lint.detail, '準備に失敗したので回していません');
  assert.equal(first.checks.filter((x) => x.name === 'lint').length, 1);
  assert.equal(rows['eslint-warnings'].status, 'fail', 'the mainline side could not be measured');
  assert.equal(e.counts.lint(), 0);
});

test('a declaration of which check an increment answers, changed after the check, leaves no checked group to reuse or approve', async () => {
  const e = eslintLike({ shared: true, merged: { warnings: 1 }, mainline: { warnings: 1 } });
  const f = setup({ checks: e.checks, increments: e.increments });
  await atShip();
  change(f);
  await prepareLand('IDD-1');
  assert.ok(landCheckedAt('IDD-1', laneLocations('IDD-1')), 'the record is the checked group while the declaration is as it was');
  declare(f, { checks: e.checks.map((check) => Object.fromEntries(Object.entries(check).filter(([key]) => key !== 'land_from_increment'))) });
  assert.equal(landCheckedAt('IDD-1', laneLocations('IDD-1')), null, 'the lint row of the record was made by the increment, which the declaration no longer says');
  const res = await approveLand('IDD-1', readLand('IDD-1').token, landApproved('IDD-1'));
  assert.equal(res.ok, false, 'the approval is refused');
  assert.match(res.error, /宣言/);
});

test('a run that answers a check and leaves a file in the merge copy fails the landing at the mutation row', async () => {
  const e = eslintLike({ shared: true, merged: { warnings: 1 }, mainline: { warnings: 1 }, strays: true });
  const f = setup({ checks: e.checks, increments: e.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  const rows = rowsOf(first);
  assert.equal(rows['check-mutation']?.status, 'fail', JSON.stringify(first.checks));
  assert.equal(rows['check-mutation'].severity, 'blocking');
  assert.equal(first.blocking, 1);
  assert.equal(e.counts.lint(), 0);
});

test('AC-005: the shared run is measured again at every tip it is checked at, and a handover carries it with the tip it was measured at', async () => {
  const e = eslintLike({ shared: true, merged: { warnings: 1 }, mainline: { warnings: 1 } });
  const f = setup({ checks: e.checks, increments: e.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  assert.equal(e.counts.eslint(), 2);
  // the mainline moves where the lane never touched: the code side is carried, the lint row with it, at the first tip
  moveElsewhere(f);
  const second = await prepareLand('IDD-1');
  assert.equal(second.inherit.mainTip, first.mainTip);
  assert.equal(e.counts.eslint(), 2, 'the handover measured nothing');
  assert.equal(e.counts.lint(), 0);
  assert.deepEqual(second.checks.map((x) => x.name).sort(), ['code', 'eslint-warnings', 'lint', 'records']);
  assert.equal(rowsOf(second)['eslint-warnings'].counts.at, first.mainTip, 'the carried count names the tip it was measured at');
  // a root setting changes on the mainline: not a handover, so the mainline side is measured at the new tip
  moveRoot(f, 'package.json', '{"name":"demo"}\n');
  const third = await prepareLand('IDD-1');
  assert.equal(third.inherit, undefined);
  assert.equal(e.counts.eslint(), 4, 'both sides ran again');
  assert.equal(e.counts.lint(), 0);
  assert.equal(rowsOf(third)['eslint-warnings'].counts.at, third.mainTip);
});

test('AC-007: lines that are not eslint\'s JSON around the output do not make the count unreadable', async () => {
  for (const [where, extra] of [['stderr', { noise: 'warning: something leaked' }], ['stdout', { pad: '> eslint . -f json' }], ['both', { noise: '(node:1) ExperimentalWarning', pad: '> eslint . -f json' }]]) {
    const e = eslintLike({ shared: true, merged: { warnings: 2 }, mainline: { warnings: 2 }, ...extra });
    const f = setup({ checks: e.checks, increments: e.increments });
    change(f);
    const first = await prepareLand('IDD-1');
    const rows = rowsOf(first);
    assert.equal(first.blocking, 0, `${where}: ${JSON.stringify(first.checks)}`);
    assert.deepEqual(rows['eslint-warnings'].counts, { mainline: 2, merged: 2, at: first.mainTip }, where);
  }
});

test('AC-007: another JSON list printed after eslint\'s is not taken for its results', async () => {
  const land = async (e) => {
    const f = setup({ checks: e.checks, increments: e.increments });
    change(f);
    return prepareLand('IDD-1');
  };
  for (const trail of ['[]', '["x"]', '[1,2]', '[{"warningCount":0}]']) {
    const same = eslintLike({ shared: true, merged: { warnings: 2 }, mainline: { warnings: 2 }, trail });
    const first = await land(same);
    assert.deepEqual(rowsOf(first)['eslint-warnings'].counts, { mainline: 2, merged: 2, at: first.mainTip }, trail);
    assert.equal(first.blocking, 0, trail);
    const more = eslintLike({ shared: true, merged: { warnings: 3 }, mainline: { warnings: 1 }, trail });
    const grown = await land(more);
    assert.equal(rowsOf(grown)['eslint-warnings'].status, 'fail', trail);
    assert.deepEqual(rowsOf(grown)['eslint-warnings'].counts, { mainline: 1, merged: 3, at: grown.mainTip }, trail);
    const broken = eslintLike({ shared: true, merged: { errors: 2 }, mainline: {}, trail });
    const bad = await land(broken);
    assert.match(rowsOf(bad).lint.detail, /eslint のエラー 2 件/, trail);
  }
});

test('AC-008: an increment cut by its time limit reads as a time-out, which is the environment and not the change', async () => {
  const e = eslintLike({ shared: true, merged: { warnings: 1 }, mainline: { warnings: 1 }, sleepMerged: 6, timeout: 0.05 });
  const f = setup({ checks: e.checks, increments: e.increments });
  change(f);
  const first = await prepareLand('IDD-1');
  const rows = rowsOf(first);
  assert.equal(rows['eslint-warnings'].status, 'fail');
  assert.match(rows['eslint-warnings'].detail, /^時間の上限（0\.05 分）で打ち切りました/m, 'the reason is at the head of a line');
  assert.equal(rows.lint.status, 'fail');
  assert.match(rows.lint.detail, /^時間の上限（0\.05 分）で打ち切りました/m);
  const cause = landFailureCause(first, null);
  assert.equal(cause.kind, 'environment', JSON.stringify(cause));
  assert.deepEqual(JSON.parse(JSON.stringify(cause)), JSON.parse(JSON.stringify(landFailureCauseReference(first, null))));
});

test('the field that lets an increment answer a check is read from the check, and an older reading of the config still has the check as it was', () => {
  const base = { github: 'o/n', upstream: '/u', work: '/w' };
  const text = (check) => JSON.stringify({ repos: { 'o/n': { ...base, checks: [check], increments: [{ name: 'eslint-warnings', command: 'eslint . -f json' }] } } });
  const shared = parseRepos(text({ name: 'lint', command: 'npm run lint', land_from_increment: 'eslint-warnings' }));
  assert.deepEqual(shared.incrementShares, { 'o/n': { lint: 'eslint-warnings' } });
  assert.deepEqual(shared.areas['o/n'].checks, [{ name: 'lint', command: ['bash', '-c', 'npm run lint'], required: true, scope: 'public' }], 'the check list and so the settings hash do not carry the field');
  assert.equal(parseRepos(text({ name: 'lint', command: 'npm run lint' })).incrementShares, undefined);
  assert.throws(() => parseRepos(text({ name: 'lint', command: 'npm run lint', land_from_increment: 'nope' })), /increments に宣言されていません/);
  assert.throws(() => parseRepos(text({ name: 'lint', command: 'npm run lint', scope: 'records', land_from_increment: 'eslint-warnings' })), /記録の検査/);
});

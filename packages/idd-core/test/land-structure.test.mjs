import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchDir } from './helpers/scratch.mjs';
import { runLandCheck } from '../src/overlay/land-check.ts';
import { readLand } from '../src/overlay/land.ts';
import { readLandRounds, saveLandRun } from '../src/overlay/land-run.ts';

for (const [name, value] of Object.entries({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost' })) process.env[name] = value;

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function write(root, files) {
  for (const [name, text] of Object.entries(files)) {
    const at = join(root, name);
    // a file given as null is removed
    if (text === null) { rmSync(at, { force: true }); continue; }
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
  }
}

/**
 * A declaration whose command reads three counts out of the files `dup.txt`, `layer.txt` and `large.txt` of the tree it
 * is asked about, so a test sets each side's numbers by writing those files. Only the first two stop a landing.
 */
const READ_COUNTS = "const fs=require('fs');const n=(f)=>{try{return Number(fs.readFileSync(process.env.IDD_STRUCTURE_ROOT+'/'+f,'utf8'))}catch{return 0}};console.log(JSON.stringify({'duplicate-tokens':n('dup.txt'),'layer-violations':n('layer.txt'),'large-files':n('large.txt')}))";
const declaration = (over = {}) => JSON.stringify({ command: ['node', '-e', READ_COUNTS], blocking: ['duplicate-tokens', 'layer-violations'], ...over });
const counts = (dup = 0, layer = 0, large = 0) => ({ 'dup.txt': `${dup}`, 'layer.txt': `${layer}`, 'large.txt': `${large}` });
const declared = (numbers, over) => ({ 'config/structure.yaml': declaration(over), ...numbers });

let serial = 0;

/** a repo with a mainline commit, a lane commit and the merge commit a landing would make; the lane's files replace the mainline's */
function fixture({ main = {}, lane = {}, deps, copy = [], setup = () => [] } = {}) {
  const root = scratchDir('land-structure-');
  const repo = join(root, 'repo');
  mkdirSync(join(root, 'state'));
  mkdirSync(repo);
  const commitAll = (message) => {
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-m', message);
    return sh(repo, 'rev-parse', 'HEAD');
  };
  sh(repo, 'init', '--initial-branch=main');
  write(repo, { 'app.txt': 'one\n', ...main });
  const mainTip = commitAll('chore: main');
  sh(repo, 'checkout', '-b', 'idd/IDD-1');
  write(repo, { 'app.txt': 'two\n', ...lane });
  const head = commitAll('feat: lane');
  sh(repo, 'checkout', 'main');
  sh(repo, 'merge', '--no-ff', 'idd/IDD-1', '-m', 'Merge lane');
  const registry = { name: 'demo', upstream: join(root, 'upstream'), work: repo, public_base: 'main', work_base: 'main', remote: 'origin', copy, setup: setup(root), checks: [] };
  write(root, { 'repos.yaml': JSON.stringify({ repos: { 'demo/demo': registry } }), 'roles.yaml': 'pipeline:\n' });
  Object.assign(process.env, { IDD_STATE_DIR: join(root, 'state'), IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'intent') });
  return { root, repo, mainTip, head, mergeCommit: sh(repo, 'rev-parse', 'HEAD'), deps };
}

/** the landing check of the fixture's lane, run to its end: the land record and the round it wrote */
async function land(f, spec = {}) {
  serial += 1;
  const runId = `run-${serial}`;
  const full = {
    runId, lane: 'IDD-1', repo: f.repo, area: 'demo/demo', checks: [], changed: [], head: f.head, mainTip: f.mainTip,
    mergeCommit: f.mergeCommit, branch: 'idd/IDD-1', workBase: 'main', configKey: 'k', token: 't', deps: f.deps,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...spec,
  };
  write(f.root, { [`${runId}.spec.json`]: JSON.stringify(full) });
  saveLandRun({ id: runId, lane: 'IDD-1', status: 'running', started_at: new Date().toISOString(), repo: f.repo, common: '', head: f.head, mainTip: f.mainTip, mergeCommit: f.mergeCommit, signed: false, spec: full, log: '' });
  await runLandCheck(join(f.root, `${runId}.spec.json`));
  return { record: readLand('IDD-1'), round: readLandRounds('IDD-1').at(-1) };
}

function byName(record) {
  const rows = {};
  for (const check of record.checks) rows[check.name] = check;
  return rows;
}

test('AC-001 / AC-002: a merge that adds a duplicate is stopped, and the card and the record carry the same two numbers', async () => {
  const f = fixture({ main: declared(counts(10, 0)), lane: counts(12, 0) });
  const { record, round } = await land(f);
  const row = byName(record)['structure/duplicate-tokens'];
  assert.deepEqual([row.status, row.severity], ['fail', 'blocking']);
  assert.deepEqual(row.counts, { mainline: 10, merged: 12, at: f.mainTip });
  assert.match(row.detail, /本流 10 \/ 取り込み 12（\+2）/);
  assert.deepEqual([record.blocking, round.blocking], [1, 1]);
  const seen = round.structure;
  assert.deepEqual([seen.mainline['duplicate-tokens'], seen.merged['duplicate-tokens']], [row.counts.mainline, row.counts.merged], 'one measurement behind both');
  assert.deepEqual([seen.at, seen.source, seen.blocking], [f.mainTip, 'mainline', ['duplicate-tokens', 'layer-violations']]);
});

const MOVES = [
  ['more duplicates', counts(10), counts(12), 'structure/duplicate-tokens', 1],
  ['more layer violations', counts(5, 1), counts(5, 2), 'structure/layer-violations', 1],
  ['the same counts', counts(5, 1), counts(5, 1), null, 0],
  ['fewer counts', counts(5, 1), counts(3), null, 0],
  ['a recorded count alone rising', counts(4, 0, 2), counts(4, 0, 9), null, 0],
];
for (const [title, main, lane, stoppedAt, blocking] of MOVES) {
  test(`AC-002 / AC-003: ${title} ${blocking ? 'stop' : 'do not stop'} the merge`, async () => {
    const { record } = await land(fixture({ main: declared(main), lane }));
    assert.equal(record.blocking, blocking);
    assert.deepEqual(record.checks.filter((c) => c.status === 'fail').map((c) => c.name), stoppedAt ? [stoppedAt] : []);
    assert.deepEqual(record.checks.map((c) => c.name), ['structure/duplicate-tokens', 'structure/layer-violations'], 'a recorded count has no row');
  });
}

test('AC-003: the counts that are only recorded are on the round with both sides', async () => {
  const { round } = await land(fixture({ main: declared(counts(4, 0, 2)), lane: counts(4, 0, 9) }));
  assert.deepEqual([round.structure.mainline['large-files'], round.structure.merged['large-files']], [2, 9]);
});

test('AC-004: a repo with no declaration is neither measured nor stopped', async () => {
  const { record, round } = await land(fixture({ main: counts(1, 1), lane: counts(50, 50) }));
  assert.deepEqual([record.blocking, record.checks, round.structure], [0, [], undefined]);
});

const BOTH = ['structure/duplicate-tokens', 'structure/layer-violations'];
const UNTAKEN = {
  'a command that exits non-zero': [{ command: ['node', '-e', 'process.exit(3)'] }, /本流の先端の数を測れませんでした[^]*exit 3/],
  'a command that omits a blocking count': [{ command: ['node', '-e', "console.log(JSON.stringify({'large-files': 1}))"] }, /出てきませんでした/],
  'a command that prints no counts': [{ command: ['node', '-e', "console.log('fine')"] }, /JSON ではありません/],
  'a command that is not there': [{ command: ['no-such-command-here'] }, /見つかりません/],
};
for (const [title, [over, reason]] of Object.entries(UNTAKEN)) {
  test(`AC-004: ${title} stops the merge`, async () => {
    const { record } = await land(fixture({ main: { 'config/structure.yaml': declaration(over) } }));
    assert.equal(record.blocking, BOTH.length);
    for (const name of BOTH) assert.match(byName(record)[name].detail, reason);
  });
}

const LEAK = "console.log('printing hunter2-secret-value'); process.exit(1)";
const COPIED = { 'an env file': ['API_TOKEN=hunter2-secret-value\n', /伏せた値/], 'a file that is not an env file': ['{"token":"hunter2-secret-value"}\n', /値を含みうるので出力を省きました/] };
for (const [title, [text, shown]] of Object.entries(COPIED)) {
  test(`AC-004: a command that fails printing the value of ${title} copied by the repo leaves it out of the row and the record`, async () => {
    const f = fixture({ main: { '.gitignore': '.env\n', 'config/structure.yaml': declaration({ command: ['node', '-e', LEAK] }) }, copy: ['.env'] });
    write(f.repo, { '.env': text });
    const { record, round } = await land(f);
    assert.equal(record.blocking, BOTH.length);
    const seen = JSON.stringify([record.checks, round.structure]);
    assert.doesNotMatch(seen, /hunter2-secret-value/);
    assert.match(byName(record)['structure/duplicate-tokens'].detail, shown);
    assert.match(round.structure.failure, shown);
  });
}

test('AC-004: a declaration that cannot be read stops the merge on one row', async () => {
  const { record, round } = await land(fixture({ main: { 'config/structure.yaml': 'command: [node\nblocking: [a' } }));
  assert.equal(record.blocking, 1);
  assert.match(byName(record).structure.detail, /構造の宣言を読めませんでした/);
  assert.match(round.structure.failure, /YAML/);
});

test('AC-004: the mainline tip is graded by its own declaration, and the merge commit is read only when the mainline has none', async () => {
  // the lane rewrites the declaration to count nothing: the mainline's command still grades it
  const zeros = { command: ['node', '-e', "console.log(JSON.stringify({'duplicate-tokens':0,'layer-violations':0}))"] };
  const graded = byName((await land(fixture({ main: declared(counts(1, 0)), lane: declared(counts(7, 0), zeros) }))).record);
  assert.deepEqual([graded['structure/duplicate-tokens'].status, graded['structure/duplicate-tokens'].counts.merged], ['fail', 7]);
  // a lane that adds the first declaration is measured by it, on both sides
  const first = fixture({ main: counts(3, 0), lane: declared(counts(3, 1)) });
  const added = await land(first);
  assert.equal(added.round.structure.source, 'merged');
  assert.deepEqual(byName(added.record)['structure/layer-violations'].counts, { mainline: 0, merged: 1, at: first.mainTip });
});

test('AC-005: a landing that takes results over from an earlier tip still counts its own tree, and carries no structure row', async () => {
  const f = fixture({ main: declared(counts(10, 0)), lane: counts(12, 0) });
  const stale = { name: 'structure/duplicate-tokens', status: 'pass', severity: 'blocking', counts: { mainline: 10, merged: 10, at: 'earlier-tip' } };
  const code = { name: 'code', status: 'pass', severity: 'blocking', detail: '前回の本流 earlier の結果' };
  const { record, round } = await land(f, { inherit: { mainTip: 'earlier-tip', checks: [stale, code] } });
  assert.deepEqual(record.checks.map((c) => c.name), ['code', 'structure/duplicate-tokens', 'structure/layer-violations'], 'one structure row of each, from this landing');
  assert.deepEqual(byName(record)['structure/duplicate-tokens'].counts, { mainline: 10, merged: 12, at: f.mainTip });
  assert.deepEqual([record.blocking, round.structure.merged['duplicate-tokens']], [1, 12]);
});

test('AC-002 / AC-006: the real command counts a copied function in the merge commit, and the same tree twice the same', async () => {
  const tool = Object.fromEntries(['config/structure.yaml', 'packages/idd-core/src/config/structure.ts', 'packages/idd-core/src/metrics/structure.ts', 'packages/idd-core/src/metrics/structure-scan.ts'].map((file) => [file, readFileSync(join(CHECKOUT, file), 'utf8')]));
  const body = (name) => `export function ${name}(items: string[], limit: number): string[] {\n  const out: string[] = [];\n  for (const item of items) {\n    if (out.length >= limit) { break; }\n    out.push(item.trim().toLowerCase());\n  }\n  return out.filter((x) => x.length > 0);\n}\n`;
  const f = fixture({ main: { ...tool, '.gitignore': 'node_modules\n', 'lib/a.ts': body('first') }, lane: { 'lib/b.ts': body('second') }, deps: join(CHECKOUT, 'node_modules') });
  const once = await land(f);
  assert.equal(once.record.blocking, 1, JSON.stringify(once.record.checks));
  const dup = byName(once.record)['structure/duplicate-tokens'];
  assert.ok(dup.counts.merged > dup.counts.mainline, 'the copy is counted in the merge commit only');
  const twice = await land(f);
  assert.deepEqual([twice.round.structure.mainline, twice.round.structure.merged], [once.round.structure.mainline, once.round.structure.merged]);
});

test('AC-001: each side is its own commit\'s tree, whatever the checks\' setup left ignored in their copy', async () => {
  const ignored = { '.gitignore': 'dup.txt\n', 'layer.txt': '0', 'large.txt': '0' };
  const f = fixture({ main: declared({}, {}), lane: ignored, setup: (root) => [`echo 99 > dup.txt && echo ran > ${root}/ran`] });
  const { record, round } = await land(f);
  assert.ok(existsSync(join(f.root, 'ran')), 'the setup ran in the checks\' copy');
  assert.deepEqual([record.checks.filter((c) => c.status === 'fail'), round.structure.mainline['duplicate-tokens'], round.structure.merged['duplicate-tokens']], [[], 0, 0]);
});

test('AC-002: a count that is itself named failure is compared like any other, and a measurement that failed is still told apart', async () => {
  const named = { command: ['node', '-e', "console.log(JSON.stringify({failure: Number(require('fs').readFileSync(process.env.IDD_STRUCTURE_ROOT + '/dup.txt', 'utf8'))}))"], blocking: ['failure'] };
  const rows = [];
  for (const [before, after] of [[4, 4], [4, 6]]) {
    const { record, round } = await land(fixture({ main: declared(counts(before), named), lane: counts(after) }));
    rows.push([byName(record)['structure/failure'].counts.merged, record.blocking, round.structure.failure]);
  }
  assert.deepEqual(rows, [[4, 0, undefined], [6, 1, undefined]]);
  assert.equal((await land(fixture({ main: declared({}, { command: ['node', '-e', 'process.exit(3)'], blocking: ['failure'] }) }))).record.blocking, 1);
});

const WEAKENED = {
  'removes the declaration': [{ 'config/structure.yaml': null }, /消えています/],
  'drops a blocking count': [{ 'config/structure.yaml': declaration({ blocking: ['duplicate-tokens'] }) }, /layer-violations/],
  'breaks the declaration': [{ 'config/structure.yaml': 'command: [node\nblocking: [a' }, /読めません/],
};
for (const [title, [change, reason]] of Object.entries(WEAKENED)) {
  test(`AC-004: a merge that ${title} the mainline has is stopped, with the counts unchanged`, async () => {
    const f = fixture({ main: declared(counts(5, 0)), lane: change });
    const { record, round } = await land(f);
    assert.equal(record.blocking, 1);
    assert.match(byName(record).structure.detail, reason);
    assert.match(round.structure.failure, reason);
  });
}

// ---- the kind a row says it is, and the sides a count was lacking on (the readers never read the words) ----

const READ_OR_FAIL = "const fs=require('fs');let t='';try{t=fs.readFileSync(process.env.IDD_STRUCTURE_ROOT+'/dup.txt','utf8')}catch{}if(t.trim()==='boom')process.exit(3);console.log(JSON.stringify({'duplicate-tokens':Number(t)||0,'layer-violations':0}))";
const fails = { command: ['node', '-e', READ_OR_FAIL] };

test('a count that grew says it is one, with the command that counted it', async () => {
  const { record } = await land(fixture({ main: declared(counts(10, 0)), lane: counts(12, 0) }));
  const rows = byName(record);
  assert.deepEqual(rows['structure/duplicate-tokens'].structure, { kind: 'increase', command: ['node', '-e', READ_COUNTS] });
  assert.equal(rows['structure/layer-violations'].structure, undefined, 'a count that did not grow is a row that passed');
});

test('a count that only the merge commit\'s tree could not give lacks the merged side, and one only the mainline\'s could not give lacks the mainline side', async () => {
  const lane = await land(fixture({ main: declared(counts(10, 0), fails), lane: { 'dup.txt': 'boom' } }));
  const sidesOf = (record) => Object.values(byName(record)).map((row) => [row.structure.kind, row.structure.sides]);
  assert.deepEqual(sidesOf(lane.record).slice(0, 1), [['unmeasured', ['merged']]]);
  assert.deepEqual(lane.round.structure.mainline['duplicate-tokens'], 10, 'the mainline side was counted');
  const mainline = await land(fixture({ main: declared({ 'dup.txt': 'boom' }, fails), lane: counts(10, 0) }));
  assert.deepEqual(sidesOf(mainline.record).slice(0, 1), [['unmeasured', ['mainline']]]);
  const neither = await land(fixture({ main: { 'config/structure.yaml': declaration({ command: ['node', '-e', 'process.exit(3)'] }) } }));
  assert.deepEqual(sidesOf(neither.record), [['unmeasured', ['mainline', 'merged']], ['unmeasured', ['mainline', 'merged']]]);
});

test('a count the command did not print lacks the side it did not print it on', async () => {
  const omits = { command: ['node', '-e', "const fs=require('fs');const r=process.env.IDD_STRUCTURE_ROOT;const out={'layer-violations':0};if(!fs.existsSync(r+'/omit.txt'))out['duplicate-tokens']=1;console.log(JSON.stringify(out))"] };
  const { record } = await land(fixture({ main: declared({}, omits), lane: { 'omit.txt': 'x' } }));
  assert.deepEqual(byName(record)['structure/duplicate-tokens'].structure.sides, ['merged']);
});

test('a declaration that holds less says it is weakened, and one that cannot be read lacks the side it was read on', async () => {
  const weak = await land(fixture({ main: declared(counts(5, 0)), lane: { 'config/structure.yaml': declaration({ blocking: ['duplicate-tokens'] }) } }));
  assert.deepEqual(byName(weak.record).structure.structure, { kind: 'weakened', command: ['node', '-e', READ_COUNTS] });
  const unread = await land(fixture({ main: { 'config/structure.yaml': 'command: [node\nblocking: [a' } }));
  assert.deepEqual(byName(unread.record).structure.structure, { kind: 'unmeasured', sides: ['mainline'] });
});

test('a row leaves the command out when the values of the files the repo copies cannot be told apart from it', async () => {
  const f = fixture({ main: { '.gitignore': '.env\n', ...declared(counts(10, 0)) }, lane: counts(12, 0), copy: ['.env'] });
  write(f.repo, { '.env': '{"token":"hunter2-secret-value"}\n' });
  const { record } = await land(f);
  assert.deepEqual(byName(record)['structure/duplicate-tokens'].structure, { kind: 'increase' });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertHas, assertLanded, assertLeftOut, assertReach, assertUnasked, atShip, batchSetup, carry, change, changes, closeRunner, commit, conflicting, droppedOf, eventsOf, git, judge, keepsBoth, mainFile, mainTip, moveMainline, OK, press, pressAndCarry, reachable, shipLanes } from './helpers/batch-fixture.mjs';
import { GEN, SRC, generating, genOf } from './helpers/generated-fixture.mjs';
import { approveBatch, batchGroups, driveBatches, readBatch } from '../src/overlay/batch.ts';
import { readLandRounds } from '../src/overlay/land-run.ts';
import { lock, lockRefusal } from '../src/overlay/git.ts';

/** the batch's one check read the tree that went onto the mainline */
function assertOneCheckOnTip(group, f) {
  assert.equal(readLandRounds(group.id).length, 1);
  assert.equal(readLandRounds(group.id)[0].mergeCommit, mainTip(f));
}
/** IDD-2's own timeline holds the one conversion of `kind` with the files it touched, and the landed event carries it too */
function assertConvertedOn(kind, files) {
  const converted = eventsOf('IDD-2').filter((e) => e.event === 's4_land_batch_converted');
  assert.equal(converted.length, 1);
  assert.deepEqual(converted[0].attrs.files, files);
  assert.equal(eventsOf('IDD-2').filter((e) => e.event === 's4_land_batch_landed')[0].attrs.conversions[0].kind, kind);
  return converted[0];
}

test('AC-004: a conflict the judge shows keeps what both lanes decided lands without a hand, with the diff and the grounds recorded', async () => {
  const f = await conflicting();
  judge((input) => {
    // the judge is handed the files, the incoming lane's plan and the plan of the lane laid before it
    assertHas(input.files[0], { path: 'app.txt', ours: 'one\nfrom one\n', theirs: 'one\nfrom two\n' });
    assert.equal(input.files.length, 1);
    assert.match(input.files[0].marked, /<<<<<<</);
    assert.deepEqual([input.incoming.lane, ...input.earlier.map((s) => s.lane)], ['IDD-2', 'IDD-1']);
    assert.match(input.incoming.decided[0].text, /plan two/);
    assert.match(input.earlier[0].decided[0].text, /plan one/);
    return { ...keepsBoth(), rationale: '両方の lane が app.txt に 1 行ずつ足す。どちらの行も残す', files: [{ ...keepsBoth().files[0], why: '足す行が別で、並べても互いの意味を変えない' }] };
  });
  const { group, b } = await pressAndCarry();
  assertLanded(b);
  assertReach(f, f.ids);
  assert.equal(mainFile(f), 'one\nfrom one\nfrom two');
  // the check ran once, on the tree that holds the resolution
  assertOneCheckOnTip(group, f);
  // the batch's record and the lane's own record say what was changed and on what grounds
  assert.equal(b.conversions.length, 1);
  assertHas(b.conversions[0], { iddId: 'IDD-2', kind: 'resolved' });
  assert.deepEqual(b.conversions[0].files.map((x) => x.path), ['app.txt']);
  assert.match(b.conversions[0].files[0].diff, /-<<<<<<<|-=======|\+from two/);
  assert.match(b.conversions[0].rationale, /app\.txt: 足す行が別で/);
  assert.match(assertConvertedOn('resolved', ['app.txt']).attrs.rationale, /どちらの行も残す/);
});

test('AC-005: a conflict that cannot keep both lanes leaves that lane out with the reason; the rest land and the mainline is not stopped', async () => {
  const f = await conflicting();
  judge(changes('IDD-1 は app.txt の 2 行目を from one と決め、IDD-2 は from two と決めていて、1 行にしか収まらない'));
  const tip = mainTip(f);
  const { b } = await pressAndCarry();
  assertLanded(b, [['IDD-2', 'conflict']]);
  assert.match(b.dropped[0].reason, /app\.txt/);
  assert.match(b.dropped[0].reason, /1 行にしか収まらない/);
  assertReach(f, ['IDD-1', 'IDD-3'], ['IDD-2']);
  assert.notEqual(mainTip(f), tip);
  assert.equal(mainFile(f), 'one\nfrom one');
  assert.deepEqual(b.conversions, [], 'nothing was converted that was not shown to keep the meaning');
  // the reason is on the lane's own timeline, where its card reads it
  assert.match(eventsOf('IDD-2').filter((e) => e.event === 's4_land_batch_dropped')[0].attrs.reason, /1 行にしか収まらない/);
  assert.match(eventsOf('IDD-2').filter((e) => e.event === 's4_land_hold').at(-1).attrs.reason, /まとめた取り込みから外れました/);
  assert.equal(eventsOf('IDD-2').some((e) => e.event === 'lane_close'), false);
});

test('a resolution without grounds per file, or with a conflict mark left in it, is not taken', async () => {
  const keeps = (files, rationale = '両方残す') => ({ decision: 'keeps', rationale, files });
  const both = keepsBoth().files[0];
  for (const answer of [
    keeps([{ ...both, why: 'ok' }], ''),
    keeps([{ ...both, why: ' ' }]),
    keeps([]),
    keeps([{ ...both, content: '<<<<<<< ours\nfrom one\n=======\nfrom two\n>>>>>>> theirs\n', why: 'そのまま' }]),
  ]) {
    const f = await conflicting();
    judge(answer);
    const { b } = await pressAndCarry();
    assertLeftOut(f, b);
    assert.equal(reachable(f, 'IDD-1'), true, JSON.stringify(answer));
  }
});

test('with no judge available the conflicting lane is left out and the rest go in', async () => {
  const f = await conflicting();
  closeRunner();
  const { b } = await pressAndCarry();
  assertLeftOut(f, b);
  assert.match(b.dropped[0].reason, /役が使えない/);
  assertReach(f, ['IDD-1', 'IDD-3']);
});

test('a judge that throws leaves the lane out and does not stop the batch', async () => {
  const f = await conflicting();
  judge(() => { throw new Error('model が落ちました'); });
  const { b } = await pressAndCarry();
  assert.equal(b.phase, 'landed');
  assert.match(b.dropped[0].reason, /model が落ちました/);
  assert.equal(reachable(f, 'IDD-1'), true);
});

/** the judge answers keeping both, but is not asked: IDD-2 is left out naming `reason`, and the mainline holds the first lane's line only */
async function assertUnaskedLeftOut(f, why, reason) {
  const seen = judge(keepsBoth());
  const { b } = await pressAndCarry();
  assertUnasked(f, seen, b, why);
  assert.match(b.dropped[0].reason, reason);
  assert.equal(mainFile(f), 'one\nfrom one');
}

const textOf = (side) => side.decided.map((d) => d.text).join('\n');

/** the judge's input for two lanes that both add a line to app.txt, each with the `writes` of its own */
async function askedAbout(writes, setup = {}, afterShip = () => {}) {
  const f = await shipLanes({ 'IDD-1': { 'app.txt': 'one\nfrom one\n', ...writes[0] }, 'IDD-2': { 'app.txt': 'one\nfrom two\n', ...writes[1] } }, setup);
  afterShip(f);
  const seen = judge(changes());
  await pressAndCarry();
  assert.ok(seen.inputs[0], 'the judge was asked');
  return seen.inputs[0];
}

test('the judge reads the plan a lane had archived before the submit, with its acceptance criteria', async () => {
  const seen = await askedAbout([
    { '_docs/archives/plan/demo/idd-1/plan.md': '# archived plan one\n', '_docs/qa/demo/idd-1/qa.md': '# qa one\nAC-001 app.txt に 1 行足す\n' },
    { '_docs/archives/plan/demo/idd-2/plan.md': '# archived plan two\n', '_docs/qa/demo/idd-2/qa.md': '# qa two\nAC-001 app.txt に別の 1 行足す\n' },
  ]);
  assert.deepEqual(seen.incoming.decided.map((d) => d.path).sort(), ['_docs/archives/plan/demo/idd-2/plan.md', '_docs/qa/demo/idd-2/qa.md']);
  assert.match(textOf(seen.incoming), /archived plan two/);
  assert.match(textOf(seen.earlier[0]), /archived plan one/);
  assert.match(textOf(seen.earlier[0]), /AC-001 app\.txt に 1 行足す/);
});

test('after the mainline moved a shared intent file, the earlier lane\'s decided holds none of the older text', async () => {
  const shared = '_docs/intent/shared/intent.md';
  const seen = await askedAbout(
    [{ '_docs/plan/demo/idd-1/plan.md': '# plan one\n本文は app.txt に 1 行足す\n' }, { '_docs/plan/demo/idd-2/plan.md': '# plan two\n本文も app.txt に 1 行足す\n' }],
    { files: { 'app.txt': 'one\n', 'other.txt': 'one\n', [shared]: '# intent\n古い主張\n' } },
    // the mainline moves on after the lanes branched: the lanes still hold the older text of the file
    (f) => moveMainline(f, { [shared]: '# intent\n新しい主張\n' }),
  );
  assert.deepEqual(seen.earlier.map((s) => s.lane), ['IDD-1']);
  const earlier = seen.earlier[0].decided;
  assert.equal(earlier.some((d) => d.path === shared), false, earlier.map((d) => d.path).join(', '));
  assert.equal(earlier.some((d) => d.text.includes('古い主張')), false);
  assert.match(textOf(seen.earlier[0]), /plan one/);
});

test('the repo is not locked while the judge is awaited', async () => {
  const f = await conflicting();
  let lockedMeanwhile = null;
  judge(() => {
    // another operation on the same clone is not refused for the length of the judge's answer
    try { lock(f.work)(); lockedMeanwhile = false; } catch (e) { lockedMeanwhile = Boolean(lockRefusal(e)); }
    return keepsBoth();
  });
  const { b } = await pressAndCarry();
  assert.equal(lockedMeanwhile, false, 'the lock was free while the judge was awaited');
  assertLanded(b);
});

test('a lock that cannot be taken again after the judge answered drops no lane and makes no chain; the next pass lands them', async () => {
  const f = await conflicting();
  let release;
  const seen = judge(() => {
    // another operation takes the clone's lock while the judge is awaited, and keeps it past the answer
    release = lock(f.work);
    return keepsBoth();
  });
  const tip = mainTip(f);
  const [group] = batchGroups();
  const pressed = await press(approveBatch, group);
  assert.equal(pressed.ok, true, pressed.error);
  const held = readBatch(group.id);
  assert.equal(held.phase, 'chain');
  assert.deepEqual(held.dropped, [], 'the signed lanes are not dropped for the lock');
  assert.deepEqual(held.chain, [], 'no chain is made without the lock');
  assert.equal(mainTip(f), tip);
  assert.equal(eventsOf('IDD-2').some((e) => e.event === 's4_land_batch_dropped'), false);
  // the chain made again names its temporary commits anew (they carry the time), and git labels the conflict markers with those names
  await new Promise((resolve) => setTimeout(resolve, 1200));
  release();
  assertLanded(await carry(group.id));
  assert.equal(seen.asked, 1, 'the answer given before the refused lock was kept: the judge is not asked again');
  for (const id of f.ids) assert.equal(reachable(f, id), true, id);
});

test('what the judge was not shown whole is not taken as kept: a lane whose plan is over the limit is left out without asking', async () => {
  const f = await shipLanes({
    'IDD-1': { 'app.txt': 'one\nfrom one\n', '_docs/plan/demo/idd-1/plan.md': `# plan one\n${'決めたこと。'.repeat(5000)}\n` },
    'IDD-2': { 'app.txt': 'one\nfrom two\n', '_docs/plan/demo/idd-2/plan.md': '# plan two\n' },
  });
  await assertUnaskedLeftOut(f, 'the judge is not asked with part of what was decided left out', /IDD-1/);
});

test('two resolutions for one conflicted path are not taken: the lane is left out and the unverified text does not land', async () => {
  const f = await conflicting();
  judge({ ...keepsBoth(), files: [keepsBoth().files[0], { path: 'app.txt', content: 'one\nsomething else\n', why: '' }] });
  const { b } = await pressAndCarry();
  assertLeftOut(f, b);
  assert.equal(mainFile(f), 'one\nfrom one');
});

test('a decision text the lane deleted is not in the material: the lane is left out without asking, naming the path', async () => {
  const f = batchSetup({ ids: ['IDD-1', 'IDD-2'], checks: OK, files: { 'app.txt': 'one\n', '_docs/plan/demo/idd-2/plan.md': '# plan two\n決めたこと\n' } });
  change(f, 'IDD-1', { 'app.txt': 'one\nfrom one\n' });
  change(f, 'IDD-2', { 'app.txt': 'one\nfrom two\n' });
  rmSync(join(f.lanes['IDD-2'].path, '_docs/plan/demo/idd-2/plan.md'));
  commit(f.lanes['IDD-2'].path, 'chore: the plan is gone');
  for (const id of f.ids) await atShip(id);
  await assertUnaskedLeftOut(f, 'the judge is not asked with a decision text left out', /_docs\/plan\/demo\/idd-2\/plan\.md/);
});

/** each of the two lanes writes its own bytes to `path` (with its own mode when `modes` is given) and commits */
function writeBoth(f, path, contents, modes = []) {
  ['IDD-1', 'IDD-2'].forEach((id, i) => {
    const file = join(f.lanes[id].path, path);
    writeFileSync(file, contents[i]);
    if (modes[i]) chmodSync(file, modes[i]);
    commit(f.lanes[id].path, `feat: ${id}`);
  });
}

/** two lanes that both add the same script with different text; `modes` is each lane's mode for it */
async function scripts(modes) {
  const f = batchSetup({ ids: ['IDD-1', 'IDD-2'], checks: OK });
  writeBoth(f, 'run.sh', ['echo one\n', 'echo two\n'], modes);
  for (const id of f.ids) await atShip(id);
  return f;
}

const resolveScript = keepsBoth('run.sh', 'echo one\necho two\n');
const modeOf = (f) => git(f.work, 'ls-tree', 'work-main', 'run.sh').split(/\s/)[0];

test('a resolved executable file stays executable on the mainline', async () => {
  const f = await scripts([0o755, 0o755]);
  judge(resolveScript);
  const { b } = await pressAndCarry();
  assertLanded(b);
  assert.equal(reachable(f, 'IDD-2'), true);
  assert.equal(modeOf(f), '100755');
  assert.equal(mainFile(f, 'run.sh'), 'echo one\necho two');
});

test('a conflict whose two sides differ in mode is not resolved: the lane is left out without asking', async () => {
  const f = await scripts([0o755, 0o644]);
  const seen = judge(resolveScript);
  const { b } = await pressAndCarry();
  assertUnasked(f, seen, b);
  assert.match(b.dropped[0].reason, /mode/);
  assert.equal(modeOf(f), '100755');
});

test('a signed batch is found again after the area\'s work_base was changed, and the lanes whose destination changed are left out', async () => {
  const f = await conflicting();
  judge(changes());
  const [group] = batchGroups();
  // the lock is held across the press so the signed batch is still waiting when the configuration changes
  const release = lock(f.work);
  const pressed = await press(approveBatch, group);
  release();
  assert.equal(pressed.ok, true, pressed.error);
  assert.equal(readBatch(group.id).phase, 'chain');
  const file = process.env.IDD_REPOS_FILE;
  const conf = JSON.parse(readFileSync(file, 'utf8'));
  conf.repos.demo.work_base = 'work-main-moved';
  writeFileSync(file, JSON.stringify(conf));
  const passes = await driveBatches();
  assert.ok(passes.has(group.id), 'the batch of the old work_base is still driven');
  const b = readBatch(group.id);
  assert.equal(b.phase, 'stopped', JSON.stringify(b));
  assert.deepEqual(droppedOf(b), [['IDD-1', 'moved'], ['IDD-2', 'moved'], ['IDD-3', 'moved']]);
  assert.match(b.dropped[0].reason, /取り込み先が署名のときと変わりました/);
  assert.equal(reachable(f, 'IDD-1'), false);
});

/** the two lanes both change `path` (bytes) from the same base */
async function blobs(path, ours, theirs) {
  const f = batchSetup({ ids: ['IDD-1', 'IDD-2'], checks: OK, files: { 'app.txt': 'one\n', [path]: Buffer.from('base\n') } });
  writeBoth(f, path, [ours, theirs]);
  for (const id of f.ids) await atShip(id);
  return f;
}
const hashOf = (cwd, bytes) => execFileSync('git', ['hash-object', '--stdin'], { cwd, input: bytes, encoding: 'utf8' }).trim();

test('a conflict in a binary file is not handed to the judge: the lane is left out and the file is not written', async () => {
  const png = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, n]);
  const f = await blobs('logo.png', png(1), png(2));
  const seen = judge(keepsBoth('logo.png', 'x', '画像を選ぶ'));
  const { b } = await pressAndCarry();
  assertUnasked(f, seen, b);
  assert.match(b.dropped[0].reason, /logo\.png/);
  assert.match(b.dropped[0].reason, /binary/);
  assert.equal(git(f.work, 'rev-parse', 'work-main:logo.png'), hashOf(f.work, png(1)));
});

test('bytes that are not UTF-8 are not text: the lane is left out without asking', async () => {
  const f = await blobs('latin.txt', Buffer.from([0x61, 0xe9, 0x0a]), Buffer.from([0x62, 0xe9, 0x0a]));
  const seen = judge(changes('x'));
  const { b } = await pressAndCarry();
  assertUnasked(f, seen, b);
});

test('a text conflict goes to the judge and back as its bytes: CRLF, a byte order mark and non-ASCII text land unchanged', async () => {
  const ours = Buffer.from('﻿key=値\r\nfrom one\r\n', 'utf8');
  const theirs = Buffer.from('﻿key=値\r\nfrom two\r\n', 'utf8');
  const f = await blobs('conf.txt', ours, theirs);
  const want = Buffer.from('﻿key=値\r\nfrom one\r\nfrom two\r\n', 'utf8');
  judge((input) => {
    assert.equal(input.files[0].ours, ours.toString('utf8'));
    assert.equal(input.files[0].theirs, theirs.toString('utf8'));
    return keepsBoth('conf.txt', want.toString('utf8'));
  });
  const { b } = await pressAndCarry();
  assertLanded(b);
  assert.equal(execFileSync('git', ['show', 'work-main:conf.txt'], { cwd: f.work }).equals(want), true);
  assert.equal(git(f.work, 'rev-parse', 'work-main:conf.txt'), hashOf(f.work, want));
});

// ---- a generated file is made again at every step of the chain (C-261-5 / C-261-6 / C-261-7) ----

const BASE = { 'app.txt': 'one\n', 'other.txt': 'one\n', 'src.txt': SRC, 'gen.txt': genOf(SRC) };
const FIRST = 'alpha2\nbeta\ngamma\n', SECOND = 'alpha\nbeta\ngamma2\n', BOTH = 'alpha2\nbeta\ngamma2\n';

/** the generated file the mainline holds once both lanes' sources are in, as the file's text ends */
const BUILT_BOTH = genOf(BOTH).trimEnd();

/** two lanes that each change one line of src.txt and build their own gen.txt: the sources merge, gen.txt conflicts */
const buildingLanes = (setup = {}, more = {}) => shipLanes({
  'IDD-1': { 'src.txt': FIRST, 'gen.txt': genOf(FIRST), ...more['IDD-1'] },
  'IDD-2': { 'src.txt': SECOND, 'gen.txt': genOf(SECOND), ...more['IDD-2'] },
  'IDD-3': { 'third.txt': 'from three\n' },
}, { files: BASE, extra: { generated_files: [GEN] }, ...setup });

/** the two ways a rebuild is lost: the command, the cause it is sorted as, and the wording the lane is told in */
const FAILS = [['exit 1', 'build', /build を通りませんでした/], ['exit 127', 'environment', /この環境では作り直せませんでした/]];

/** IDD-2 is left out for a conflict and the other two lanes landed */
function assertConflictLeftOut(f, b) {
  assertLanded(b, [['IDD-2', 'conflict']]);
  assertReach(f, ['IDD-1', 'IDD-3'], ['IDD-2']);
}

/** the judge was told, apart from the files it decides on, which side failed to make gen.txt again, and why */
function assertToldWhy(input, cause) {
  assertHas(input.rebuildFailure, { cause, paths: ['gen.txt'] });
  assert.ok(input.rebuildFailure.reason);
}
/** the batch's record carries the failures of the steps that stand, each with a path and a reason, all of one cause */
function assertCarried(b, cause) {
  assert.ok(b.rebuildFailures.length >= 1 && b.rebuildFailures.every((x) => x.cause === cause && x.paths[0] === 'gen.txt' && x.reason), JSON.stringify(b.rebuildFailures));
}

/** the two building lanes carried to the end with the judge answering as `answer`: the repo's entry, the lanes' extra files, the batch */
async function carryBuilding(setup, more, answer) {
  const f = await buildingLanes(setup, more);
  const seen = judge(answer);
  return { f, seen, ...(await pressAndCarry()) };
}

test('AC-004: a conflict on a generated file alone keeps the lane in, is not asked of the judge, and is made again from the merged sources', async () => {
  const { f, seen, group, b } = await carryBuilding({}, {}, changes());
  assertLanded(b);
  assert.equal(seen.asked, 0, 'a generated file has no meaning for the judge to decide');
  assertReach(f, f.ids);
  assert.equal(mainFile(f, 'src.txt'), BOTH.trimEnd());
  assert.equal(mainFile(f, 'gen.txt'), BUILT_BOTH);
  // the one check read the tree that holds the rebuilt file
  assertOneCheckOnTip(group, f);
  // the record and the lane's own timeline say which file was made again and why, by path and ground (no diff)
  assert.equal(b.conversions.length, 1);
  assertHas(b.conversions[0], { iddId: 'IDD-2', kind: 'rebuilt' });
  assert.deepEqual(b.rebuildFailures, [], 'a rebuild that was made leaves no failure');
  assert.deepEqual(b.conversions[0].files, [{ path: 'gen.txt', diff: '' }]);
  assert.match(b.conversions[0].rationale, /生成物は源から決まる文面/);
  assert.equal(assertConvertedOn('rebuilt', ['gen.txt']).attrs.kind, 'rebuilt');
  // a step whose file the merge already had right is not recorded as a conversion
  assert.equal(eventsOf('IDD-1').some((e) => e.event === 's4_land_batch_converted'), false);
});

const MIXED = { 'IDD-1': { 'app.txt': 'one\nfrom one\n' }, 'IDD-2': { 'app.txt': 'one\nfrom two\n' } };
/** the judge's answer for app.txt and the generated gen.txt together, the latter with text that is not what the sources build */
const keepsBothAndGen = (gen) => {
  const answer = keepsBoth();
  return { ...answer, files: [...answer.files, { path: 'gen.txt', content: gen, why: '生成物は源に合わせる' }] };
};

test('AC-004: a step whose sources conflict too is judged on the sources only, and the lane is not dropped for want of an answer on the generated file', async () => {
  const { f, seen, b } = await carryBuilding({}, MIXED, keepsBoth());
  assertLanded(b);
  assert.equal(seen.asked, 1);
  assert.deepEqual(seen.inputs[0].files.map((x) => x.path), ['app.txt']);
  assertReach(f, f.ids);
  assert.equal(mainFile(f, 'app.txt'), 'one\nfrom one\nfrom two');
  assert.equal(mainFile(f, 'gen.txt'), BUILT_BOTH);
  // the sources are the judge's conversion, the generated file is read as a rebuilt one, by its path and why it was made again
  assert.deepEqual(b.conversions.map((c) => [c.iddId, c.kind]), [['IDD-2', 'resolved'], ['IDD-2', 'rebuilt']]);
  const [resolved, rebuilt] = b.conversions;
  assert.deepEqual(resolved.files.map((x) => x.path), ['app.txt']);
  assert.deepEqual(rebuilt.files, [{ path: 'gen.txt', diff: '' }]);
  assert.equal(seen.inputs[0].rebuildFailure, undefined, 'nothing failed when the judge was asked');
});

test('AC-006: a step whose sources and generated file both conflict is judged again with the failure when the file cannot be made again', async () => {
  for (const [command, cause, told] of FAILS) {
    const { f, seen, b } = await carryBuilding({ extra: generating(command) }, MIXED, (input) => (input.rebuildFailure ? keepsBothAndGen(`${genOf(BOTH)}\n`) : { ...keepsBoth(), rationale: 'first answer' }));
    assertLanded(b);
    assert.equal(seen.asked, 2, 'asked once for the sources, and again for the whole set once the file was found not to be made again');
    assert.equal(seen.inputs[0].rebuildFailure, undefined, 'nothing had failed when the judge was first asked');
    assert.deepEqual(seen.inputs[0].files.map((x) => x.path), ['app.txt']);
    assert.deepEqual(seen.inputs[1].files.map((x) => x.path).sort(), ['app.txt', 'gen.txt'], 'the set the old landing asked');
    assertToldWhy(seen.inputs[1], cause);
    assertReach(f, f.ids);
    assert.equal(mainFile(f, 'gen.txt'), BUILT_BOTH);
    // the first answer is not kept in the record, and the second answer's ground carries why the file was not made again
    assert.deepEqual(b.conversions.map((c) => [c.iddId, c.kind]), [['IDD-2', 'resolved']]);
    assert.equal(b.conversions[0].rationale.includes('first answer'), false);
    assert.match(b.conversions[0].rationale, told);
    assertCarried(b, cause);
  }
});

test('AC-006: when the second judgement of a mixed conflict changes, the lane is left out with the failure beside its reason', async () => {
  const { f, seen, b } = await carryBuilding({ extra: generating('exit 1') }, MIXED, (input) => (input.rebuildFailure ? changes('生成物は 1 つにできない') : keepsBoth()));
  assertConflictLeftOut(f, b);
  assert.equal(seen.asked, 2);
  assert.match(b.dropped[0].reason, /生成物は 1 つにできない/);
  assert.match(b.dropped[0].reason, /生成物（gen\.txt）を作り直せませんでした/);
});

test('AC-006: a generated conflict alone that cannot be made again sends the lane back, whatever the judge would keep', async () => {
  for (const [command, cause, told] of FAILS) {
    const { f, seen, b } = await carryBuilding({ extra: generating(command) }, {}, keepsBoth('gen.txt', `${genOf(BOTH)}\n`, '生成物は源から決まるので、両方の源に合わせて置く'));
    // the judge is not asked, and a text it would write for the file does not reach the mainline
    assertConflictLeftOut(f, b);
    assert.equal(seen.asked, 0);
    assert.deepEqual(b.conversions, []);
    // the lane left out is told which file and why it was not made again, and the card reads the failures of the steps that stand
    assert.match(b.dropped[0].reason, /生成物（gen\.txt）を作り直せませんでした/);
    assert.match(b.dropped[0].reason, told);
    assertCarried(b, cause);
    assert.equal(b.rebuildFailures.some((x) => x.iddId === 'IDD-1'), true, 'the step with no conflict went on as before and still says why');
  }
});

test('AC-006: a batch of a repo that declares nothing asks the judge about the generated file, as before', async () => {
  const { f, seen, b } = await carryBuilding({ extra: {} }, {}, changes());
  assertConflictLeftOut(f, b);
  assert.deepEqual(seen.inputs[0].files.map((x) => x.path), ['gen.txt']);
});

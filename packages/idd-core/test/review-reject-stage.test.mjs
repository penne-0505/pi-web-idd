import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { laneDiffAll, laneDiffFiles } from '../src/plan/review.ts';
import { laneStageSpans } from '../src/ledger/stages.ts';
import { tmpDir } from './helpers/tmp.mjs';

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
afterEach(() => {
  if (saved.state === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved.state;
  if (saved.repos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved.repos;
});

/** a fresh repo on `main` that commits as a fixed author */
function initRepo(repo) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  return git;
}

/** commit everything and return the new HEAD */
function commitAll(git, message) {
  git('add', '.');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

test('a rejected review is read as the implementation, which is what the card says it does', () => {
  const at = '2026-10-01T00:00:00Z';
  const ev = (event, attrs = {}, t = at) => ({ idd_id: 'IDD-1', event, at: t, attrs });
  const spans = laneStageSpans([
    ev('lane_open'), ev('s1_go', {}, '2026-10-01T00:01:00Z'), ev('s2_start', {}, '2026-10-01T00:02:00Z'),
    ev('s3_reject', { next_stage: 's2_retry', feedback: 'x' }, '2026-10-01T00:03:00Z'),
  ]);
  assert.equal(spans.at(-1).key, 'impl');
});

test('every changed file of a lane is read with its own diff, the lines a patch removed or kept and the ones it added', () => {
  const repo = tmpDir('idd-diff-all-');
  const git = initRepo(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repo, 'src', 'b.txt'), 'x\n-- dashes\ny\n');
  const base = commitAll(git, 'base');
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  writeFileSync(join(repo, 'src', 'b.txt'), 'x\ny\n');
  writeFileSync(join(repo, 'c.txt'), 'new\n');
  commitAll(git, 'work');

  assert.deepEqual(laneDiffFiles(repo, base), ['a.txt', 'c.txt', 'src/b.txt']);
  const all = laneDiffAll(repo, base);
  assert.deepEqual(all.map((d) => [d.file, d.fileIndex, d.fileTotal]), [['a.txt', 1, 3], ['c.txt', 2, 3], ['src/b.txt', 3, 3]]);
  const a = all[0];
  assert.deepEqual(a.before.filter((l) => l.marker === '-').map((l) => l.code), ['two']);
  assert.deepEqual(a.after.filter((l) => l.marker === '+').map((l) => l.code), ['TWO', 'four']);
  assert.deepEqual(all[1].after.map((l) => l.code), ['new'], 'a new file has only an after side');
  assert.equal(all[1].before.length, 0);
  // a removed line that begins with dashes is a line of the file, not a patch header
  assert.deepEqual(all[2].before.filter((l) => l.marker === '-').map((l) => l.code), ['-- dashes']);
  // a side is cut at the limit and says how much it left out
  const cut = laneDiffAll(repo, base, { maxLines: 1 });
  assert.equal(cut[0].after.length, 1);
  assert.equal(cut[0].omitted.after > 0, true);
  assert.deepEqual(laneDiffAll(repo, base, { maxFiles: 2 }).map((d) => d.file), ['a.txt', 'c.txt']);
});

test('a path git quotes in its header, or a repo that writes no a/ b/ prefix, still gets its own diff body', () => {
  const repo = tmpDir('idd-diff-quoted-');
  const git = initRepo(repo);
  writeFileSync(join(repo, 'plain.txt'), 'a\n');
  writeFileSync(join(repo, '日本 語.txt'), 'old\n');
  const base = commitAll(git, 'base');
  writeFileSync(join(repo, 'plain.txt'), 'a\nb\n');
  writeFileSync(join(repo, '日本 語.txt'), 'new\n');
  writeFileSync(join(repo, 'tab\there.txt'), 'x\n');
  commitAll(git, 'work');
  for (const prefix of ['false', 'true']) {
    git('config', 'diff.noprefix', prefix);
    const all = laneDiffAll(repo, base);
    assert.deepEqual(all.map((d) => d.file).sort(), ['plain.txt', 'tab\there.txt', '日本 語.txt'].sort());
    const by = Object.fromEntries(all.map((d) => [d.file, d]));
    assert.deepEqual(by['日本 語.txt'].after.map((l) => l.code), ['new'], `noprefix=${prefix}`);
    assert.deepEqual(by['日本 語.txt'].before.map((l) => l.code), ['old']);
    assert.deepEqual(by['tab\there.txt'].after.map((l) => l.code), ['x']);
    assert.deepEqual(by['plain.txt'].after.filter((l) => l.marker === '+').map((l) => l.code), ['b']);
  }
});

test('a diff larger than one MiB still reaches the review card, and a file git cannot give is told, not read as nothing', () => {
  const repo = tmpDir('idd-diff-large-');
  const git = initRepo(repo);
  writeFileSync(join(repo, 'seed.txt'), 's\n');
  const base = commitAll(git, 'base');
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
  // 4 files of about 400 KiB each: together over the 1 MiB that Node gives a child's stdout unless asked otherwise
  for (const n of names) writeFileSync(join(repo, n), Array.from({ length: n === 'd.txt' ? 100 : 6000 }, (_, i) => `${n} line ${i} ${'x'.repeat(50)}`).join('\n') + '\n');
  commitAll(git, 'work');
  assert.ok(execFileSync('git', ['diff', base], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).length > 1024 * 1024, 'the fixture is larger than the default limit');
  const all = laneDiffAll(repo, base);
  assert.deepEqual(all.map((d) => d.file), names);
  for (const d of all.slice(0, 3)) {
    assert.equal(d.after.length, 200, `${d.file}: a side is still cut at 200 lines`);
    assert.equal(d.omitted.after, 5800);
  }
  assert.equal(all[3].after.length, 100);
  // a limit too small even for the file list: the review is told, not handed an empty diff
  const unread = laneDiffAll(repo, base, { maxBuffer: 10 });
  assert.equal(unread.length, 1);
  assert.match(unread[0].after[0].code, /読めませんでした/);
  assert.ok(unread[0].unread, 'the notice says why, so a verdict is not given over it');
  // a limit that takes the list but not the whole patch: each file is read alone, and the one that does not fit says so
  const some = laneDiffAll(repo, base, { maxBuffer: 300 * 1024 });
  assert.deepEqual(some.map((d) => d.file), names);
  assert.ok(some.slice(0, 3).every((d) => d.after.length === 1 && /読めませんでした/.test(d.after[0].code)), 'a file that does not fit says so');
  assert.equal(some[3].after.length, 100, 'a file that fits is still shown');
});

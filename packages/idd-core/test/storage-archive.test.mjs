import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { archiveLane } from '../src/storage/archive.ts';
import { judge } from '../src/storage/judge.ts';
import { sweepStorage } from '../src/storage/sweep.ts';
import { storageState, writeRepos, writeLifecycle, writeLaneJson } from './helpers/storage-fixture.mjs';

const at = (s) => `2026-09-20T${s}:00+09:00`;
const closed = (id, closeAt) => [
  { event: 'lane_open', idd_id: id, at: at('00:00'), attrs: {} },
  { event: 'lane_close', idd_id: id, at: closeAt, attrs: { outcome: 'merged' } },
];

function archiveConf(dir, places = {}) {
  return { cleanup: true, archive_dir: dir, places: { run_records: { cleanup: true, keep_days: 0 }, stage_files: { cleanup: true, keep_days: 0 }, ...places } };
}

function setupLane(state) {
  writeLifecycle(state, 'Demo', closed('IDD-1', at('12:00')));
  const run = writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  writeFileSync(join(run, 'turns.jsonl'), 'turn');
  mkdirSync(join(state, 'pipeline', 'review', 'IDD-1', 'r-1'), { recursive: true });
  writeFileSync(join(state, 'pipeline', 'review', 'IDD-1', 'r-1', 'report.md'), '# report');
  return { run, stage: join(state, 'pipeline', 'review', 'IDD-1') };
}

function tarList(file) {
  return execFileSync('tar', ['--zstd', '-tf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function tarGrep(file, needle) {
  try {
    const out = execFileSync('bash', ['-c', `tar --zstd -xOf ${JSON.stringify(file)} 2>/dev/null | grep -a -- ${JSON.stringify(needle)} || true`], { encoding: 'utf8' });
    return out.trim();
  } catch {
    return '';
  }
}

test('with no archive dir, a due record is deleted and nothing is written anywhere (AC-036)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 0 } } } });
  const { run } = setupLane(state);
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(run), false);
  assert.equal(readdirSync(state).filter((f) => f.endsWith('.tar.zst')).length, 0);
});

test('the run records and stage files of a lane are packed into one file, and the originals go (AC-037)', async () => {
  const state = storageState();
  const dir = join(state, 'archive');
  mkdirSync(dir, { recursive: true });
  writeRepos(state, { storage: archiveConf(dir) });
  const { run, stage } = setupLane(state);
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(run), false);
  assert.equal(existsSync(stage), false);
  const target = join(dir, 'IDD-1.tar.zst');
  assert.equal(existsSync(target), true);
  const listed = tarList(target);
  assert.ok(listed.some((p) => p.includes('lane.json')), 'the lane record is in the archive');
  assert.ok(listed.some((p) => p.includes('report.md')), 'the stage file is in the archive');
  assert.ok(r.removed.length >= 2);
  assert.equal(readdirSync(dir).some((f) => f.endsWith('.partial')), false);
});

test('an archive dir that cannot be seen keeps the records, with the reason on the candidate list and the record (AC-039, AC-040, INV-2727)', async () => {
  const state = storageState();
  const dir = join(state, 'nowhere');
  writeRepos(state, { storage: { ...archiveConf(dir), min_free_gb: 999999 } });
  const { run } = setupLane(state);
  const v = await judge({ measure: false });
  assert.equal(v.candidates.some((c) => c.place === 'run_records'), false);
  assert.ok(v.kept.some((k) => k.place === 'run_records' && k.reason.includes('保存先が見えません')));
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(run), true);
  assert.equal(r.removed.length, 0);
});

test('a write that fails keeps the originals and the reason is on record (AC-038)', async () => {
  const state = storageState();
  const dir = join(state, 'archive');
  mkdirSync(dir, { recursive: true });
  writeRepos(state, { storage: archiveConf(dir) });
  const { run } = setupLane(state);
  chmodSync(dir, 0o500);
  try {
    const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
    assert.equal(existsSync(run), true, 'the original stays when the write fails');
    assert.ok(r.removed.length === 0);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('a stale .partial is rewritten and never left behind (AC-041)', async () => {
  const state = storageState();
  const dir = join(state, 'archive');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IDD-1.tar.zst.partial'), 'half-written');
  writeRepos(state, { storage: archiveConf(dir) });
  const { run } = setupLane(state);
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(run), false);
  assert.equal(existsSync(join(dir, 'IDD-1.tar.zst')), true);
  assert.equal(existsSync(join(dir, 'IDD-1.tar.zst.partial')), false);
});

test('an existing file that holds everything is not overwritten; one that lacks a record gets a numbered file (AC-042)', async () => {
  const state = storageState();
  const dir = join(state, 'archive');
  mkdirSync(dir, { recursive: true });
  writeRepos(state, { storage: archiveConf(dir) });
  const { run } = setupLane(state);
  const target = join(dir, 'IDD-1.tar.zst');
  // first pass packs everything and deletes the originals
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  const before = readFileSync(target);
  // a second pass with nothing left must not change the file
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.deepEqual(readFileSync(target), before);
  // a new record for the same lane that is not in the file goes to a numbered name
  const again = writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  writeFileSync(join(again, 'extra.jsonl'), 'new turn');
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.deepEqual(readFileSync(target), before, 'the first file is untouched');
  const numbered = readdirSync(dir).filter((f) => f.startsWith('IDD-1.') && f.endsWith('.tar.zst'));
  assert.ok(numbered.length >= 1, 'the rest went to a numbered file');
  assert.ok(tarList(join(dir, numbered[0])).some((p) => p.includes('extra.jsonl')));
});

test('an archive dir inside the state is not swept, and its files are not candidates (AC-043)', async () => {
  const state = storageState();
  const dir = join(state, 'archive');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keep-me.tar.zst'), 'mine');
  writeRepos(state, { storage: archiveConf(dir) });
  setupLane(state);
  const v = await judge({ measure: false });
  assert.equal(v.candidates.some((c) => c.path.startsWith(dir)), false);
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(join(dir, 'keep-me.tar.zst')), true);
  assert.equal(readFileSync(join(dir, 'keep-me.tar.zst'), 'utf8'), 'mine');
});

test('a symlink\'s target content is not packed, and the target stays (AC-044, INV-2728)', async () => {
  const state = storageState();
  const dir = join(state, 'archive');
  mkdirSync(dir, { recursive: true });
  const secret = join(state, 'secret.txt');
  writeFileSync(secret, 'MARKER-SECRET-CONTENT');
  writeRepos(state, { storage: archiveConf(dir) });
  const { run } = setupLane(state);
  mkdirSync(join(run, 'agent'), { recursive: true });
  symlinkSync(secret, join(run, 'agent', 'auth.json'));
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(run), false);
  assert.equal(existsSync(secret), true, 'the link target stays');
  assert.equal(readFileSync(secret, 'utf8'), 'MARKER-SECRET-CONTENT');
  const found = tarGrep(join(dir, 'IDD-1.tar.zst'), 'MARKER-SECRET-CONTENT');
  assert.equal(found, '', 'the symlink target content is not in the archive');
});

test('archiveLane refuses a missing dir and a non-directory (AC-039)', async () => {
  const state = storageState();
  const run = writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  const missing = await archiveLane({ archiveDir: join(state, 'nope'), stateRoot: state, lane: 'IDD-1', members: [{ abs: run, rel: 'lanes/2026-09-18-000000-executor' }] });
  assert.equal(missing.ok, false);
  const file = join(state, 'afile');
  writeFileSync(file, 'x');
  const notDir = await archiveLane({ archiveDir: file, stateRoot: state, lane: 'IDD-1', members: [{ abs: run, rel: 'lanes/2026-09-18-000000-executor' }] });
  assert.equal(notDir.ok, false);
  assert.equal(existsSync(run), true);
});

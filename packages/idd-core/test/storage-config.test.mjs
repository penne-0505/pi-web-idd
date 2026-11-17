import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRepos, readStorageConfig } from '../src/config/areas.ts';
import { parseStorage } from '../src/storage/config.ts';

function repos(extra = '') {
  return `
storage:
  cleanup: true
  min_free_gb: 5
  archive_dir: /mnt/drive/raw
  places:
    run_records: { cleanup: false, keep_days: 14 }
    build_outputs: { keep_hours: 3 }
repos:
  Demo:
    github: o/r
    upstream: /tmp/u
    work: /tmp/w
${extra}`;
}

test('a missing storage section is off with the plan defaults (AC-016)', () => {
  const saved = process.env.PROPTER_DISK_MIN_FREE_GB;
  delete process.env.PROPTER_DISK_MIN_FREE_GB;
  try {
    const cfg = parseStorage(undefined);
    assert.equal(cfg.cleanup, false);
    assert.equal(cfg.minFreeGb, 10);
    assert.equal(cfg.archiveDir, undefined);
    assert.equal(cfg.places.run_records.keepMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(cfg.places.build_outputs.keepMs, 6 * 60 * 60 * 1000);
    assert.equal(cfg.places.review_copies.keepMs, 0);
    assert.equal(cfg.places.run_records.cleanup, true);
  } finally {
    if (saved === undefined) delete process.env.PROPTER_DISK_MIN_FREE_GB; else process.env.PROPTER_DISK_MIN_FREE_GB = saved;
  }
});

test('a file with no repos and no storage reads as off (AC-016)', () => {
  const before = process.env.IDD_REPOS_FILE;
  process.env.IDD_REPOS_FILE = '/nonexistent/repos.yaml';
  try {
    assert.equal(readStorageConfig().cleanup, false);
  } finally {
    if (before === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = before;
  }
});

test('storage settings are read, and a period is moved by the setting (AC-018)', () => {
  const file = parseRepos(repos());
  const cfg = file.storage;
  assert.equal(cfg.cleanup, true);
  assert.equal(cfg.minFreeGb, 5);
  assert.equal(cfg.archiveDir, '/mnt/drive/raw');
  assert.equal(cfg.places.run_records.cleanup, false);
  assert.equal(cfg.places.run_records.keepMs, 14 * 24 * 60 * 60 * 1000);
  assert.equal(cfg.places.build_outputs.keepMs, 3 * 60 * 60 * 1000);
  // a place not written keeps its default
  assert.equal(cfg.places.stage_files.keepMs, 7 * 24 * 60 * 60 * 1000);
});

test('build_outputs is read, rejects an absolute path and a path escaping the root (AC-002)', () => {
  const file = parseRepos(repos('    build_outputs: [build, .dart_tool]\n'));
  assert.deepEqual(file.buildOutputs.Demo, ['build', '.dart_tool']);
  assert.throws(() => parseRepos(repos('    build_outputs: [/etc/passwd]\n')), /絶対 path/);
  assert.throws(() => parseRepos(repos('    build_outputs: [../outside]\n')), /外へ出る/);
  assert.throws(() => parseRepos(repos('    build_outputs: [build, 3]\n')), /文字列の一覧/);
});

test('an unknown key, a wrong type and a negative period are refused, not defaulted (AC-022)', () => {
  assert.throws(() => parseStorage({ cleanup: 'yes' }), /cleanup/);
  assert.throws(() => parseStorage({ nonsense: 1 }), /知らない欄/);
  assert.throws(() => parseStorage({ places: { run_records: { keep_days: -1 } } }), /0 以上/);
  assert.throws(() => parseStorage({ places: { run_records: { keep_days: 1, keep_hours: 2 } } }), /どちらか一方/);
  assert.throws(() => parseStorage({ places: { no_such_place: {} } }), /知らない置き場/);
  assert.throws(() => parseStorage({ archive_dir: 'relative/dir' }), /絶対 path/);
  assert.throws(() => parseStorage({ min_free_gb: -2 }), /0 以上/);
});

test('adding build_outputs leaves the area config byte for byte the same (AC-023)', () => {
  const without = parseRepos(repos());
  const withOutputs = parseRepos(repos('    build_outputs: [build]\n'));
  assert.deepEqual(withOutputs.areas.Demo, without.areas.Demo);
});

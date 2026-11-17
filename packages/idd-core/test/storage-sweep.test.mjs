import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { judge } from '../src/storage/judge.ts';
import { stillDeletable, sweepStorage } from '../src/storage/sweep.ts';
import { storageState, writeRepos, writeLifecycle, backlog, sessions, writeLaneJson, gitRepo } from './helpers/storage-fixture.mjs';

const at = (s) => `2026-09-20T${s}:00+09:00`;
const DAY = 24 * 60 * 60 * 1000;
const closed = (id, closeAt) => [
  { event: 'lane_open', idd_id: id, at: at('00:00'), attrs: {} },
  { event: 'lane_close', idd_id: id, at: closeAt, attrs: { outcome: 'merged' } },
];

function tree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      out.push(r);
      walk(p, r);
    }
  };
  walk(root, '');
  return out.sort();
}

function setupClosedRun(state) {
  writeLifecycle(state, 'Demo', closed('IDD-1', at('12:00')));
  const dir = writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  writeFileSync(join(dir, 'turns.jsonl'), 'x'.repeat(32));
  mkdirSync(join(dir, 'turns'));
  writeFileSync(join(dir, 'turns', 'a.jsonl'), 'y');
  return dir;
}

test('a sweep with the setting off deletes nothing, whatever the free space (AC-015, AC-020)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: false } });
  setupClosedRun(state);
  const before = tree(state);
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(r.removed.length, 0);
  assert.equal(r.reason, '片づけは OFF です');
  assert.deepEqual(tree(state), before);
});

test('a sweep without the tick lock deletes nothing (AC-034)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  setupClosedRun(state);
  const before = tree(state);
  const r = await sweepStorage({ lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(r.removed.length, 0);
  assert.equal(r.swept, false);
  assert.deepEqual(tree(state), before);
});

test('a due run record is deleted, the sweep is recorded with its lane, and only candidates are removed (AC-027, INV-2723)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 7 } } } });
  const dir = setupClosedRun(state);
  const now = Date.parse(at('12:00')) + 8 * DAY;
  const judged = await judge({ now, measure: false });
  const candidates = judged.candidates.filter((c) => c.place === 'run_records').map((c) => c.path);
  const r = await sweepStorage({ underLock: true, lowSpace: false, now });
  assert.deepEqual(r.removed.map((x) => x.path), candidates);
  assert.equal(existsSync(dir), false);
  const lines = readFileSync(join(state, 'storage-sweeps.jsonl'), 'utf8').split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.removed.length, 1);
  assert.equal(last.removed[0].lane, 'IDD-1');
  assert.ok(last.removed[0].bytes > 0, 'the record shows the bytes really removed, not a display cache');
});

test('an item inside its keep period is left, and low space deletes it (AC-019)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 7 } } } });
  const dir = setupClosedRun(state);
  const soon = Date.parse(at('12:00')) + 3 * DAY;
  let r = await sweepStorage({ underLock: true, lowSpace: false, now: soon });
  assert.equal(existsSync(dir), true);
  assert.ok(r.keptReason.some((k) => k.path === dir));
  r = await sweepStorage({ underLock: true, lowSpace: true, now: soon });
  assert.equal(existsSync(dir), false);
});

test('a place turned off leaves only its own place alone (AC-017)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: false }, cron_runs: { cleanup: true, keep_days: 0 } } } });
  const dir = setupClosedRun(state);
  writeFileSync(join(state, 'cron-run-old.json'), JSON.stringify({ cron_run_id: 'old', started_at: at('00:00'), completed_at: at('00:00') }));
  writeFileSync(join(state, 'cron-run-new.json'), JSON.stringify({ cron_run_id: 'new', started_at: at('10:00'), completed_at: at('10:00') }));
  const old = readFileSync(join(state, 'cron-run-new.json'), 'utf8');
  const r = await sweepStorage({ underLock: true, lowSpace: false, now: Date.parse(at('11:00')) });
  assert.equal(existsSync(dir), true, 'run_records is off');
  assert.equal(existsSync(join(state, 'cron-run-old.json')), false);
  assert.equal(readFileSync(join(state, 'cron-run-new.json'), 'utf8'), old);
  assert.ok(r.removed.every((x) => x.place === 'cron_runs'));
});

test('a review run copy is removed with git and its registration is gone, and cleaned is written last (AC-014)', async () => {
  const { clone } = gitRepo('idd-sweep-copy-');
  const state = storageState();
  const reviewRoot = join(state, 'review-wt');
  writeRepos(state, {
    storage: { cleanup: true, places: { review_copies: { cleanup: true, keep_days: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone, review_root: reviewRoot } },
  });
  // the runs cut their copies under the state's own review-wt, not the repo's review_root
  const place = join(state, 'pipeline', 'review-wt');
  const copy = join(place, 'IDD-1-1-blind-r-abc');
  mkdirSync(place, { recursive: true });
  execFileSync('git', ['-C', clone, 'worktree', 'add', '-q', '--detach', copy, 'HEAD']);
  const metaPath = join(state, 'pipeline', 'review-runs', 'RUN-1.json');
  mkdirSync(join(state, 'pipeline', 'review-runs'), { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ lane_id: 'RUN-1', stage: 'blind', role: 'r', copy, source: clone }));
  writeLaneJson(state, 'RUN-1', { status: 'done', started_at: at('00:00'), ended_at: at('01:00') });

  const r = await sweepStorage({ underLock: true, lowSpace: false, now: Date.parse(at('02:00')) });
  assert.equal(existsSync(copy), false);
  assert.ok(r.removed.some((x) => x.place === 'review_run_copies'));
  assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).cleaned, true);
  const list = execFileSync('git', ['-C', clone, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  assert.equal(list.includes(copy), false);
});

test('a review run copy is a candidate under the run copies place even when a review_root is declared (F-1)', async () => {
  const { clone } = gitRepo('idd-sweep-copy-place-');
  const state = storageState();
  const reviewRoot = join(state, 'review-wt');
  writeRepos(state, {
    storage: { cleanup: true, places: { review_copies: { cleanup: true, keep_days: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone, review_root: reviewRoot } },
  });
  const place = join(state, 'pipeline', 'review-wt');
  const copy = join(place, 'IDD-1-1-blind-r-abc');
  mkdirSync(place, { recursive: true });
  execFileSync('git', ['-C', clone, 'worktree', 'add', '-q', '--detach', copy, 'HEAD']);
  const metaPath = join(state, 'pipeline', 'review-runs', 'RUN-3.json');
  mkdirSync(join(state, 'pipeline', 'review-runs'), { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ lane_id: 'RUN-3', stage: 'blind', role: 'r', copy, source: clone }));
  writeLaneJson(state, 'RUN-3', { status: 'done', started_at: at('00:00'), ended_at: at('01:00') });

  const v = await judge({ now: Date.parse(at('02:00')), measure: false });
  assert.ok(v.candidates.some((c) => c.place === 'review_run_copies' && c.path === copy));
});

test('a review run copy outside the run copies place is kept with a reason (F-4)', async () => {
  const { clone } = gitRepo('idd-sweep-copy-out-');
  const state = storageState();
  const reviewRoot = join(state, 'review-wt');
  mkdirSync(reviewRoot, { recursive: true });
  writeRepos(state, {
    storage: { cleanup: true, places: { review_copies: { cleanup: true, keep_days: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone, review_root: reviewRoot } },
  });
  // a declared review_root is not where the runs cut their copies: a copy there is outside the place
  const outside = join(reviewRoot, 'IDD-1-1-blind-r-abc');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'x');
  const metaPath = join(state, 'pipeline', 'review-runs', 'RUN-2.json');
  mkdirSync(join(state, 'pipeline', 'review-runs'), { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ lane_id: 'RUN-2', stage: 'blind', role: 'r', copy: outside, source: 'IDD-1' }));
  writeLaneJson(state, 'RUN-2', { status: 'done', started_at: at('00:00'), ended_at: at('01:00') });
  const v = await judge({ now: Date.parse(at('02:00')), measure: false });
  assert.equal(v.candidates.filter((c) => c.place === 'review_run_copies').length, 0);
  assert.ok(v.kept.some((k) => k.place === 'review_run_copies' && k.path === outside && k.reason.includes('置き場の外')));
  const r = await sweepStorage({ underLock: true, lowSpace: false, now: Date.parse(at('02:00')) });
  assert.equal(r.removed.length, 0);
  assert.equal(existsSync(outside), true);
});

test('a review run record pointing at the place itself deletes nothing (F-4, AC-004, INV-2722)', async () => {
  const { clone } = gitRepo('idd-sweep-copy-self-');
  const state = storageState();
  const place = join(state, 'pipeline', 'review-wt');
  mkdirSync(place, { recursive: true });
  // another run's copy lives under the place: naming the place itself must not take it with it
  const inner = join(place, 'IDD-1-1-blind-r-abc');
  execFileSync('git', ['-C', clone, 'worktree', 'add', '-q', '--detach', inner, 'HEAD']);
  writeRepos(state, {
    storage: { cleanup: true, places: { review_copies: { cleanup: true, keep_days: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone } },
  });
  const metaPath = join(state, 'pipeline', 'review-runs', 'RUN-SELF.json');
  mkdirSync(join(state, 'pipeline', 'review-runs'), { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ lane_id: 'RUN-SELF', stage: 'blind', role: 'r', copy: place, source: clone }));
  writeLaneJson(state, 'RUN-SELF', { status: 'done', started_at: at('00:00'), ended_at: at('01:00') });
  const v = await judge({ now: Date.parse(at('02:00')), measure: false });
  assert.equal(v.candidates.filter((c) => c.place === 'review_run_copies').length, 0);
  assert.ok(v.kept.some((k) => k.place === 'review_run_copies' && k.path === place && k.reason.includes('置き場の外')));
  const r = await sweepStorage({ underLock: true, lowSpace: false, now: Date.parse(at('02:00')) });
  assert.equal(existsSync(place), true);
  assert.equal(existsSync(inner), true);
  assert.ok(!r.removed.some((x) => x.path === place));
});

test('an ad-hoc run record is swept on its own end, with no failure line every tick (F-3)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 0 } } } });
  const dir = writeLaneJson(state, '2026-09-18-000000-planner', { status: 'done', started_at: at('09:00'), ended_at: at('10:00') });
  const r = await sweepStorage({ underLock: true, lowSpace: false, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(dir), false);
  assert.ok(r.removed.some((x) => x.path === dir));
  const lines = readFileSync(join(state, 'storage-sweeps.jsonl'), 'utf8').split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.failed.length, 0);
});

test('a half-deleted run record is finished by the next sweep, and the ledger is untouched (AC-033, INV-2726)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { run_records: { cleanup: true, keep_days: 0 } } } });
  const dir = setupClosedRun(state);
  const before = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8');
  // the contents are gone but the evidence (lane.json) is still there: the record still names the run
  writeFileSync(join(dir, 'lane.json'), readFileSync(join(dir, 'lane.json'), 'utf8'));
  for (const n of readdirSync(dir)) if (n !== 'lane.json') execFileSync('rm', ['-rf', join(dir, n)]);
  const first = await judge({ measure: false });
  assert.ok(first.candidates.some((c) => c.path === dir), 'the remainder is a candidate again');
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(dir), false);
  assert.ok(r.removed.some((x) => x.path === dir));
  assert.equal(readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8'), before);
});

test('a stage file the ledger names is deleted but the ledger line stays, and the record still names it (AC-033)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { stage_files: { cleanup: true, keep_days: 0 } } } });
  writeLifecycle(state, 'Demo', [
    ...closed('IDD-1', at('12:00')),
    { event: 's2_result', idd_id: 'IDD-1', at: at('11:00'), attrs: { report: join(state, 'pipeline', 'review', 'IDD-1', 'x', 'report.md') } },
  ]);
  mkdirSync(join(state, 'pipeline', 'review', 'IDD-1', 'r-1'), { recursive: true });
  writeFileSync(join(state, 'pipeline', 'review', 'IDD-1', 'r-1', 'report.md'), '# report');
  const ledger = readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8');
  await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(join(state, 'pipeline', 'review', 'IDD-1')), false);
  assert.equal(readFileSync(join(state, 'lifecycle-Demo.jsonl'), 'utf8'), ledger);
});

test('the sweep never reaches for a trash program (AC-013)', async () => {
  const source = ['sweep.ts', 'judge.ts', 'archive.ts'].map((f) => readFileSync(join(process.cwd(), 'packages', 'idd-core', 'src', 'storage', f), 'utf8')).join('\n');
  assert.equal(/\bgio\b/.test(source), false);
  assert.equal(/['"]trash/.test(source), false);
  assert.equal(/Trash/.test(source), false);
});

test('an open lane is kept even with low space and a passed period (AC-020, INV-2724)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, min_free_gb: 999999, places: { run_records: { cleanup: true, keep_days: 0 } } } });
  writeLifecycle(state, 'Demo', [{ event: 'lane_open', idd_id: 'IDD-1', at: at('00:00'), attrs: {} }]);
  const dir = writeLaneJson(state, '2026-09-18-000000-executor', { idd_id: 'IDD-1', status: 'done' });
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(dir), true);
  assert.ok(r.failed.length === 0);
});

test('a cron record that does not say the run closed stays; a closed one goes (INV-2721)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { cron_runs: { cleanup: true, keep_days: 0 } } } });
  const closedPath = join(state, 'cron-run-closed.json');
  const openPath = join(state, 'cron-run-open.json');
  const newestPath = join(state, 'cron-run-newest.json');
  writeFileSync(closedPath, JSON.stringify({ cron_run_id: 'closed', started_at: at('00:00'), completed_at: at('00:00') }));
  // a record with a name and a date but no closure: the sweep must not delete on those alone
  writeFileSync(openPath, JSON.stringify({ cron_run_id: 'open', started_at: at('00:30') }));
  writeFileSync(newestPath, JSON.stringify({ cron_run_id: 'newest', started_at: at('10:00'), completed_at: at('10:00') }));
  utimesSync(closedPath, new Date(Date.parse(at('00:00'))), new Date(Date.parse(at('00:00'))));
  utimesSync(openPath, new Date(Date.parse(at('00:30'))), new Date(Date.parse(at('00:30'))));
  utimesSync(newestPath, new Date(Date.parse(at('10:00'))), new Date(Date.parse(at('10:00'))));

  const v = await judge({ now: Date.parse(at('11:00')), measure: false });
  assert.ok(v.candidates.some((c) => c.path === closedPath));
  assert.ok(v.kept.some((k) => k.path === openPath && k.reason.includes('記録にありません')), 'the record without completed_at is kept');

  const r = await sweepStorage({ underLock: true, lowSpace: false, now: Date.parse(at('11:00')) });
  assert.equal(existsSync(closedPath), false);
  assert.equal(existsSync(openPath), true);
  assert.ok(!r.removed.some((x) => x.path === openPath));
});

test('an outbox line without both ids does not stop the whole judgement (AC-027)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true, places: { outbox: { cleanup: true, keep_days: 0 } } } });
  writeLifecycle(state, 'Demo', closed('IDD-1', at('12:00')));
  mkdirSync(join(state, 'outbox'), { recursive: true });
  writeFileSync(join(state, 'outbox', 'OB-1.xml'), '<x/>');
  writeFileSync(join(state, 'outbox.jsonl'), [
    JSON.stringify({ envelope_id: 'OB-1', idd_id: 'IDD-1' }),
    JSON.stringify({ envelope_id: 'OB-2' }),
    JSON.stringify({ idd_id: 'IDD-1' }),
    '{ not json',
  ].join('\n') + '\n');

  // the judgement must not throw on the lines that name no lane
  const v = await judge({ now: Date.parse(at('23:00')), measure: false });
  assert.ok(v.candidates.some((c) => c.place === 'outbox' && c.path.endsWith('OB-1.xml')));
  const r = await sweepStorage({ underLock: true, lowSpace: true, now: Date.parse(at('23:00')) });
  assert.equal(existsSync(join(state, 'outbox', 'OB-1.xml')), false);
  assert.ok(r.removed.some((x) => x.path.endsWith('OB-1.xml')));
  // the pass is still recorded, even with the lines that named no lane in the file
  const lines = readFileSync(join(state, 'storage-sweeps.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  assert.ok(JSON.parse(lines[lines.length - 1]).removed.some((x) => x.path.endsWith('OB-1.xml')));
});

test('a place that is itself a symlink is judged by its real path (INV-2722)', async () => {
  const { clone } = gitRepo('idd-sweep-realplace-');
  const state = storageState();
  // the machine's state/pipeline/review-wt is a symlink: a copy inside its real dir must still be a candidate
  const realPlace = join(state, 'real-review-wt');
  mkdirSync(realPlace, { recursive: true });
  mkdirSync(join(state, 'pipeline'), { recursive: true });
  symlinkSync(realPlace, join(state, 'pipeline', 'review-wt'));
  writeRepos(state, {
    storage: { cleanup: true, places: { review_copies: { cleanup: true, keep_days: 0 } } },
    repos: { Demo: { github: 'o/r', upstream: clone, work: clone } },
  });
  const copy = join(realPlace, 'IDD-1-1-blind-r-abc');
  execFileSync('git', ['-C', clone, 'worktree', 'add', '-q', '--detach', copy, 'HEAD']);
  const metaPath = join(state, 'pipeline', 'review-runs', 'RUN-9.json');
  mkdirSync(join(state, 'pipeline', 'review-runs'), { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ lane_id: 'RUN-9', stage: 'blind', role: 'r', copy, source: clone }));
  writeLaneJson(state, 'RUN-9', { status: 'done', started_at: at('00:00'), ended_at: at('01:00') });

  const v = await judge({ now: Date.parse(at('02:00')), measure: false });
  assert.ok(v.candidates.some((c) => c.place === 'review_run_copies' && c.path === copy), 'the copy under the real place is a candidate');
  const r = await sweepStorage({ underLock: true, lowSpace: false, now: Date.parse(at('02:00')) });
  assert.equal(existsSync(copy), false);
  assert.ok(r.removed.some((x) => x.path === copy));
});

test('a record that went missing at the moment of deletion fails only that item (AC-027)', async () => {
  const state = storageState();
  writeRepos(state, { storage: { cleanup: true } });
  const path = join(state, 'review-wt', 'IDD-1-1-blind-r-abc');
  mkdirSync(path, { recursive: true });
  const meta = join(state, 'pipeline', 'review-runs', 'RUN-1.json');
  mkdirSync(join(state, 'pipeline', 'review-runs'), { recursive: true });
  writeFileSync(meta, '{ broken');
  const broken = { place: 'review_run_copies', path, bytes: 0, usedUpAt: at('00:00'), dueAt: at('00:00'), removal: 'git-worktree', evidence: { kind: 'review-run', path: meta } };
  const g = await stillDeletable(broken);
  assert.equal(g.ok, false);
  assert.match(g.reason, /確かめられません/);
  const missing = { ...broken, evidence: { kind: 'review-run', path: join(state, 'nope.json') } };
  const g2 = await stillDeletable(missing);
  assert.equal(g2.ok, false);
  assert.match(g2.reason, /確かめられません/);
  assert.equal(existsSync(path), true);
});

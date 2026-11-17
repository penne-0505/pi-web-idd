import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { reanchorPlaceFindings } from '../src/plan/place-findings.ts';

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', GIT_ALLOW_PROTOCOL: 'file' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const lines10 = (tag = 'L') => `${Array.from({ length: 10 }, (_, i) => `${tag}${i + 1}`).join('\n')}\n`;

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, lane: process.env.IDD_LANE_ROOT };

/**
 * A repo whose mainline carries a lane's finding, with the lane closed as merged. The finding points at line 5 of
 * a.ts at the commit it was placed. The caller then moves the mainline on, so the tick has a diff to place it by.
 */
function setup({ lines = [5, 5], path = 'a.ts' } = {}) {
  const root = scratchDir('place-findings-git-');
  const work = join(root, 'work');
  const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main');
  put(join(work, 'a.ts'), lines10());
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'chore: base');
  git(work, 'worktree', 'add', '-q', '-b', 'idd/idd-1', join(root, 'lane'), 'main');
  const placed = git(work, 'rev-parse', 'HEAD');
  put(join(state, 'repos.yaml'), JSON.stringify({ repos: { Demo: { github: 'test/demo', upstream: join(root, 'upstream'), work, work_base: 'main' } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(state, 'repos.yaml') });
  writeFileSync(join(state, 'lifecycle-Demo.jsonl'), jsonl([{ idd_id: 'IDD-001', event: 'lane_close', at: '2026-10-13T00:00:00Z', attrs: { outcome: 'merged' } }]));
  writeFileSync(join(state, 'work-Demo.jsonl'), jsonl([{ event: 'finding_placed', at: '2026-10-13T00:00:00Z', repo: 'Demo', lane: 'IDD-001', id: 'F-1-1', round: 1, path, lines, commit: placed, severity: 'should', claim: 'c' }]));
  return { root, work, state, placed };
}

const rowsOf = (state) => {
  const file = readdirSync(state).find((f) => f.startsWith('work-'));
  return readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

function move(work, text, message) {
  put(join(work, 'a.ts'), text);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', message);
  return git(work, 'rev-parse', 'HEAD');
}

test('AC-022: lines added above move the finding, a partly rewritten range is placed at its remaining lines', async () => {
  const f = setup();
  const tip = move(f.work, `NEW1\nNEW2\nNEW3\n${lines10()}`, 'feat: three lines above');
  await reanchorPlaceFindings();
  let moved = rowsOf(f.state).find((r) => r.event === 'finding_moved');
  assert.deepEqual(moved.lines, [8, 8]);
  assert.equal(moved.commit, tip);

  // a range of two lines with one of them rewritten keeps the other, at its new number
  const f2 = setup({ lines: [5, 6] });
  const tip2 = move(f2.work, `${'L1\nL2\nL3\n'}REPLACED\nL6\nL7\nL8\nL9\nL10\n`, 'feat: rewrite line 5');
  await reanchorPlaceFindings();
  moved = rowsOf(f2.state).find((r) => r.event === 'finding_moved');
  assert.deepEqual(moved.lines, [5, 5]);
  assert.equal(moved.commit, tip2);

  // a hunk that removes the range's first lines and adds fewer moves the survivors by its net change
  const f3 = setup({ lines: [5, 8] });
  const tip3 = move(f3.work, 'L1\nL2\nREPLACED\nL6\nL7\nL8\nL9\nL10\n', 'feat: collapse lines 3-5');
  await reanchorPlaceFindings();
  moved = rowsOf(f3.state).find((r) => r.event === 'finding_moved');
  assert.deepEqual(moved.lines, [4, 6]);
  assert.equal(moved.commit, tip3);

  // a hunk inside the range that adds lines moves the lines after it
  const f4 = setup({ lines: [5, 10] });
  move(f4.work, 'L1\nL2\nL3\nL4\nL5\nL6\nR1\nR2\nR3\nL8\nL9\nL10\n', 'feat: rewrite line 7 into three');
  await reanchorPlaceFindings();
  moved = rowsOf(f4.state).find((r) => r.event === 'finding_moved');
  assert.deepEqual(moved.lines, [5, 12]);
});

test('AC-022 (fix F-1): a pure insertion moves only the lines behind the line it follows', async () => {
  // an insertion right after the finding's only line leaves that line where it is
  const f = setup();
  move(f.work, 'L1\nL2\nL3\nL4\nL5\nNEW\nL6\nL7\nL8\nL9\nL10\n', 'feat: insert after the finding line');
  await reanchorPlaceFindings();
  let moved = rowsOf(f.state).find((r) => r.event === 'finding_moved');
  assert.deepEqual(moved.lines, [5, 5]);

  // an insertion after the range's first line moves the rest of the range by one
  const f2 = setup({ lines: [5, 7] });
  move(f2.work, 'L1\nL2\nL3\nL4\nL5\nNEW\nL6\nL7\nL8\nL9\nL10\n', 'feat: insert after the range start');
  await reanchorPlaceFindings();
  moved = rowsOf(f2.state).find((r) => r.event === 'finding_moved');
  assert.deepEqual(moved.lines, [5, 8]);

  // an insertion after the range's last line leaves the whole range where it is
  const f3 = setup({ lines: [5, 7] });
  move(f3.work, 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nNEW\nL8\nL9\nL10\n', 'feat: insert after the range end');
  await reanchorPlaceFindings();
  moved = rowsOf(f3.state).find((r) => r.event === 'finding_moved');
  assert.deepEqual(moved.lines, [5, 7]);
});

test('AC-023: rewriting or deleting every line of the range drops the finding with a reason', async () => {
  const f = setup();
  const tip = move(f.work, `L1\nL2\nL3\nL4\nREWRITTEN\nL6\nL7\nL8\nL9\nL10\n`, 'feat: rewrite');
  await reanchorPlaceFindings();
  let dropped = rowsOf(f.state).find((r) => r.event === 'finding_dropped');
  assert.equal(dropped.id, 'F-1-1');
  assert.ok(dropped.reason);
  assert.equal(dropped.by, 'engine');
  assert.equal(dropped.commit, undefined);
  assert.ok(tip);

  const f2 = setup();
  move(f2.work, 'L1\nL2\nL3\nL4\nL6\nL7\nL8\nL9\nL10\n', 'feat: delete line 5');
  await reanchorPlaceFindings();
  dropped = rowsOf(f2.state).find((r) => r.event === 'finding_dropped');
  assert.ok(dropped);
  assert.equal(dropped.id, 'F-1-1');
});

test('AC-024: a finding with no line survives a rewrite and drops only when its file is gone', async () => {
  const f = setup({ lines: null });
  move(f.work, `L1\nL2\nL3\nL4\nREWRITTEN\nL6\nL7\nL8\nL9\nL10\n`, 'feat: rewrite');
  await reanchorPlaceFindings();
  assert.equal(rowsOf(f.state).filter((r) => r.event === 'finding_dropped').length, 0);

  const f2 = setup({ lines: null });
  git(f2.work, 'rm', '-q', 'a.ts');
  git(f2.work, 'commit', '-qm', 'feat: delete the file');
  await reanchorPlaceFindings();
  const dropped = rowsOf(f2.state).find((r) => r.event === 'finding_dropped');
  assert.ok(dropped, 'the file is gone, so the whole-file finding drops');
  assert.equal(dropped.id, 'F-1-1');
});

test('AC-025: a commit the repo does not have leaves the finding as it is', async () => {
  const f = setup();
  const rows = rowsOf(f.state);
  rows[0].commit = '0'.repeat(40);
  writeFileSync(join(f.state, 'work-Demo.jsonl'), jsonl(rows));
  move(f.work, `NEW\n${lines10()}`, 'feat: move');
  const result = await reanchorPlaceFindings();
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.dropped, []);
  assert.equal(rowsOf(f.state).filter((r) => r.event === 'finding_moved' || r.event === 'finding_dropped').length, 0);
});

test('AC-026: the stage does not throw when a repo cannot be read', async () => {
  const f = setup();
  writeFileSync(join(f.state, 'repos.yaml'), JSON.stringify({ repos: { Demo: { github: 'test/demo', upstream: join(f.root, 'upstream'), work: join(f.root, 'missing'), work_base: 'main' } } }));
  await assert.doesNotReject(() => reanchorPlaceFindings());
  writeFileSync(join(f.state, 'repos.yaml'), '{ not yaml');
  await assert.doesNotReject(() => reanchorPlaceFindings());
});

test.after(() => {
  for (const [k, v] of [['IDD_STATE_DIR', saved.state], ['IDD_REPOS_FILE', saved.repos], ['IDD_LANE_ROOT', saved.lane]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

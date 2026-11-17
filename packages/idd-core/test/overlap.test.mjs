import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDeclarations, overlapsOf, overlapsForLane, overlapSection } from '../src/plan/overlap.ts';
import { executorBrief } from '../src/plan/exec.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { tmpDir } from './helpers/tmp.mjs';

const at = '2026-10-27T00:00:00Z';
const rec = (id, extra = {}) => ({ idd_id: id, area: 'me/app', title: `${id} の題`, context: '', created_at: at, ...extra });
const ev = (id, event, attrs = {}) => ({ idd_id: id, event, at, attrs });
const ready = (id, paths) => [ev(id, 'lane_open'), ev(id, 's1_ready', { intent_impact: { paths, candidate_count: 0, rows: [] } })];
const byLane = (...groups) => {
  const map = new Map();
  for (const e of groups.flat()) map.set(e.idd_id, [...(map.get(e.idd_id) ?? []), e]);
  return map;
};

test('the same path two open lanes declared is an overlap, listed from both sides', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2')];
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['a/x.ts', 'a/y.ts']), ready('IDD-2', ['a/x.ts'])));
  const forFirst = overlapsOf(decls, 'IDD-1');
  const forSecond = overlapsOf(decls, 'IDD-2');
  assert.deepEqual(forFirst.map((o) => [o.lane, o.provisional, o.hits]), [['IDD-2', false, [{ path: 'a/x.ts', other: 'a/x.ts', kind: 'same' }]]]);
  assert.deepEqual(forSecond.map((o) => [o.lane, o.hits.map((h) => h.path)]), [['IDD-1', ['a/x.ts']]]);
});

test('a dir and a path inside it overlap, with or without the slash', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2'), rec('IDD-3')];
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['components/idd/']), ready('IDD-2', ['components/idd/cards/index.tsx']), ready('IDD-3', ['components/idd'])));
  const hits = overlapsOf(decls, 'IDD-2');
  assert.deepEqual(hits.map((o) => [o.lane, o.hits[0].kind]), [['IDD-1', 'nested'], ['IDD-3', 'nested']]);
  assert.deepEqual(overlapsOf(decls, 'IDD-1').map((o) => o.lane), ['IDD-2', 'IDD-3']);
});

test('two files in the same dir overlap whatever the mainline holds; a top-level pair does not', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2')];
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['src/plan/overlap.ts', 'new-a.ts']), ready('IDD-2', ['src/plan/overlaps.ts', 'new-b.ts'])));
  assert.deepEqual(overlapsOf(decls, 'IDD-1').map((o) => o.hits), [[{ path: 'src/plan/overlap.ts', other: 'src/plan/overlaps.ts', kind: 'sibling' }]]);
  assert.deepEqual(overlapsOf(decls, 'IDD-2').map((o) => o.hits), [[{ path: 'src/plan/overlaps.ts', other: 'src/plan/overlap.ts', kind: 'sibling' }]]);
});

test('files of the same module but different dirs do not overlap', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2')];
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['src/a/one.ts']), ready('IDD-2', ['src/b/two.ts'])));
  assert.deepEqual(overlapsOf(decls, 'IDD-1'), []);
});

test('lanes of another area are not compared, though a relative path is the same', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2', { area: 'me/other' }), rec('IDD-3')];
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['README.md', 'a/x.ts']), ready('IDD-2', ['README.md', 'a/x.ts']), ready('IDD-3', ['a/x.ts'])));
  assert.deepEqual(overlapsOf(decls, 'IDD-1').map((o) => o.lane), ['IDD-3']);
  assert.deepEqual(overlapsOf(decls, 'IDD-2'), []);
});

test('a top-level file an Issue names in backquotes is a provisional place; prose words are not', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2', { context: '`README.md` を直す。e.g. v1.2 の話' }), rec('IDD-3', { context: '`./README.md` と `ok` を直す' })];
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['README.md']), [ev('IDD-2', 'lane_open')], [ev('IDD-3', 'lane_open')]));
  assert.deepEqual(decls.map((d) => [d.lane, d.paths]), [['IDD-1', ['README.md']], ['IDD-2', ['README.md']], ['IDD-3', ['README.md']]]);
  const [o] = overlapsOf(decls, 'IDD-1');
  assert.deepEqual([o.lane, o.provisional, o.hits], ['IDD-2', true, [{ path: 'README.md', other: 'README.md', kind: 'same' }]]);
});

test('a lane an end event closed is not an opponent, and a lane alone has none', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2'), rec('IDD-3')];
  const closed = [...ready('IDD-2', ['a/x.ts']), ev('IDD-2', 'lane_close', { outcome: 'merged' })];
  const stopped = [...ready('IDD-3', ['a/x.ts']), ev('IDD-3', 's1_defer', {})];
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['a/x.ts']), closed, stopped));
  assert.deepEqual(decls.map((d) => d.lane), ['IDD-1']);
  assert.deepEqual(overlapsOf(decls, 'IDD-1'), []);
  assert.deepEqual(overlapsOf(decls, 'IDD-9'), [], 'a lane with no declaration has nothing to share');
});

test('a lane with no declaration is read from the paths its Issue names, and the pair says so', () => {
  const backlog = [rec('IDD-1'), rec('IDD-2', { context: '`a/x.ts` を直す' }), rec('IDD-3', { context: '`a/x.ts` を直す' })];
  // IDD-3 planned an empty list: its Issue's text stands in for it too
  const decls = openDeclarations(backlog, byLane(ready('IDD-1', ['a/x.ts']), [ev('IDD-2', 'lane_open')], ready('IDD-3', [])));
  assert.deepEqual(decls.map((d) => [d.lane, d.provisional]), [['IDD-1', false], ['IDD-2', true], ['IDD-3', true]]);
  const found = overlapsOf(decls, 'IDD-1');
  assert.deepEqual(found.map((o) => [o.lane, o.provisional]), [['IDD-2', true], ['IDD-3', true]]);
  assert.match(overlapSection(found, 'executor', (s) => s).join('\n'), /仮/);
});

test('only the last ready is read, and the hits are capped with a count', () => {
  const many = Array.from({ length: 12 }, (_, i) => `d/f${i}.ts`);
  const backlog = [rec('IDD-1'), rec('IDD-2')];
  const first = [...ready('IDD-1', ['old/path.ts']), ev('IDD-1', 's1_ready', { intent_impact: { paths: many, candidate_count: 0, rows: [] } })];
  const decls = openDeclarations(backlog, byLane(first, ready('IDD-2', ['d/'])));
  const [o] = overlapsOf(decls, 'IDD-1');
  assert.equal(o.hits.length, 8);
  assert.equal(o.more, 4);
  assert.ok(!decls.find((d) => d.lane === 'IDD-1').paths.includes('old/path.ts'));
});

function setup(lanes) {
  const root = tmpDir('idd-overlap-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  writeFileSync(join(state, 'backlog.jsonl'), jsonl(lanes.map((l) => l.rec)));
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), jsonl(lanes.flatMap((l) => l.events)));
  const wt = join(root, 'wt'); mkdirSync(wt);
  return wt;
}

test('both briefs carry the open lane and the shared path; a lane with no overlap gets nothing', () => {
  const planner = rec('IDD-2', { context: '`a/x.ts` と `b/y.ts` を直す' });
  const wt = setup([
    { rec: rec('IDD-1', { title: '先に計画した lane' }), events: ready('IDD-1', ['a/x.ts']) },
    { rec: planner, events: [ev('IDD-2', 'lane_open')] },
    { rec: rec('IDD-3'), events: ready('IDD-3', ['c/z.ts']) },
    { rec: rec('IDD-4'), events: [...ready('IDD-4', ['a/x.ts']), ev('IDD-4', 'lane_close', { outcome: 'merged' })] },
  ]);
  const brief = plannerBrief(planner, undefined, wt);
  const block = brief.split('<overlapping-lanes')[1].split('</overlapping-lanes>')[0];
  assert.match(block, /count="1"/);
  assert.match(block, /IDD-1「先に計画した lane」/);
  assert.match(block, /a\/x\.ts/);
  assert.match(block, /仮/, 'the planner has declared nothing yet, so the pair is provisional');
  assert.doesNotMatch(block, /IDD-3|IDD-4/);

  const executed = rec('IDD-1', { title: '先に計画した lane' });
  const exec = executorBrief(executed, wt);
  const execBlock = exec.split('<overlapping-lanes')[1].split('</overlapping-lanes>')[0];
  assert.match(execBlock, /IDD-2「IDD-2 の題」（仮/, 'IDD-2 declared nothing: its Issue text names a/x.ts, so the pair is provisional');
  assert.match(execBlock, /a\/x\.ts/);
  assert.doesNotMatch(execBlock, /IDD-3|IDD-4/);
});

test('nothing is said when no open lane shares a place', () => {
  const lone = rec('IDD-1', { context: '`a/x.ts` を直す' });
  const wt = setup([
    { rec: lone, events: [ev('IDD-1', 'lane_open')] },
    { rec: rec('IDD-2'), events: ready('IDD-2', ['c/z.ts']) },
  ]);
  assert.doesNotMatch(plannerBrief(lone, undefined, wt), /overlapping-lanes/);
  assert.doesNotMatch(executorBrief(lone, wt), /overlapping-lanes/);
  assert.deepEqual(overlapsForLane(lone, [lone], []), []);
});

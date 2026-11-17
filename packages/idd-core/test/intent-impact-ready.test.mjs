import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentReady } from '../src/agent/inbound.ts';

const made = [];
const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved.state === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved.state;
  if (saved.repos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved.repos;
});

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', gh_issue_url: 'https://github.com/me/app/issues/1', created_at: '2026-09-24T00:00:00Z' };

const allClear = [
  { kind: 'auth', touches: false, reason: '認証を変えない。' },
  { kind: 'authz', touches: false, reason: '認可を変えない。' },
  { kind: 'billing', touches: false, reason: '課金を変えない。' },
  { kind: 'permission', touches: false, reason: '権限を変えない。' },
  { kind: 'data_loss', touches: false, reason: 'データを消さない。' },
  { kind: 'secret', touches: false, reason: '秘密を扱わない。' },
];

const counts = { iddId: 'IDD-1', decCount: 1, invCount: 0, qaCount: 1, referenceCount: 0, size: 'L', harm: 1, depth: 'deep', riskTable: allClear };

/** a lane whose planner worktree holds one existing DEC of another lane, anchored to src/x.ts */
function setup({ withRecords = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'idd-impact-'));
  made.push(root);
  const state = join(root, 'state'); mkdirSync(state);
  const worktree = join(root, 'wt'); mkdirSync(worktree);
  const qa = join(worktree, '_docs/qa/app/idd-1/qa.md');
  mkdirSync(join(worktree, '_docs/qa/app/idd-1'), { recursive: true });
  writeFileSync(qa, '---\nrisk: High\n---\n\nbody\n');
  if (withRecords) {
    const doc = join(worktree, '_docs/intent/app/other/decision.md');
    mkdirSync(join(worktree, '_docs/intent/app/other'), { recursive: true });
    writeFileSync(doc, '# other\n\n## Decisions\n\n### DEC-500: 他の lane の判断\n\n- **Why**: 壊さないため。\n- **Anchors**: `src/x.ts`\n');
  }
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'p1', started_at: '2026-09-25T00:00:00Z', worktree_path: worktree, branch: 'idd/idd-1' }) + '\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return { state, worktree };
}

function recorded(state) {
  const file = readdirSync(state).find((f) => f.startsWith('lifecycle-'));
  if (!file) return [];
  return readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 's1_ready');
}

const impact = (overrides = {}) => ({ paths: ['src/x.ts'], decisions: [{ id: 'DEC-500', effect: 'keep', reason: 'Why を保つ。' }], ...overrides });

test('a report without the impact is refused, and no ready is written (AC-006)', async () => {
  const { state } = setup();
  const r = await agentReady(counts);
  assert.equal(r.ok, false);
  assert.equal(recorded(state).length, 0);
});

test('the refusal carries how to pull the candidates and the shape to send (AC-008)', async () => {
  const { state } = setup();
  const r = await agentReady(counts);
  assert.match(r.error, /idd intent decisions/);
  assert.match(r.error, /--intent-impact/);
  assert.match(r.error, /"decisions"/);
  assert.match(r.error, /keep\|within_freedom\|change_why/);
  assert.equal(recorded(state).length, 0);
});

test('a malformed impact is refused: not an array, unknown effect, empty reason, duplicate id, unknown number (AC-006)', async () => {
  const { state } = setup();
  const cases = [
    impact({ decisions: 'none' }),
    impact({ decisions: [{ id: 'DEC-500', effect: 'maybe', reason: 'x' }] }),
    impact({ decisions: [{ id: 'DEC-500', effect: 'keep', reason: '  ' }] }),
    impact({ decisions: [{ id: 'DEC-500', effect: 'keep', reason: 'a' }, { id: 'DEC-500', effect: 'keep', reason: 'b' }] }),
    impact({ decisions: [{ id: 'DEC-999', effect: 'keep', reason: 'a' }] }),
    impact({ paths: 'src/x.ts' }),
  ];
  for (const c of cases) {
    const r = await agentReady({ ...counts, intentImpact: c });
    assert.equal(r.ok, false, JSON.stringify(c));
  }
  assert.equal(recorded(state).length, 0);
});

test('the engine counts the candidates from the paths and keeps the report (AC-007, AC-026)', async () => {
  const { state } = setup();
  const r = await agentReady({ ...counts, intentImpact: impact() });
  assert.deepEqual(r, { ok: true });
  const [ready] = recorded(state);
  assert.equal(ready.attrs.intent_impact.candidate_count, 1);
  assert.deepEqual(ready.attrs.intent_impact.paths, ['src/x.ts']);
  assert.equal(ready.attrs.intent_impact.rows[0].id, 'DEC-500');
  assert.equal(ready.attrs.intent_impact.rows[0].outside_candidates, undefined);
});

test('an empty list is accepted and recorded as such, with the candidate count (AC-007)', async () => {
  const { state } = setup();
  const r = await agentReady({ ...counts, intentImpact: { paths: [], decisions: [] } });
  assert.deepEqual(r, { ok: true });
  const [ready] = recorded(state);
  assert.equal(ready.attrs.intent_impact.candidate_count, 0);
  assert.deepEqual(ready.attrs.intent_impact.rows, []);
});

test('a DEC outside the candidates but present in the records is accepted, and marked (AC-007)', async () => {
  const { state } = setup();
  const r = await agentReady({ ...counts, intentImpact: { paths: ['src/other.ts'], decisions: [{ id: 'DEC-500', effect: 'within_freedom', reason: '範囲内で変える。' }] } });
  assert.deepEqual(r, { ok: true });
  const [ready] = recorded(state);
  assert.equal(ready.attrs.intent_impact.candidate_count, 0);
  assert.equal(ready.attrs.intent_impact.rows[0].outside_candidates, true);
});

test('a lane whose records cannot be read keeps a report as candidates 0, without checking numbers (AC-027)', async () => {
  const { state } = setup({ withRecords: false });
  const r = await agentReady({ ...counts, intentImpact: { paths: ['src/x.ts'], decisions: [{ id: 'DEC-999', effect: 'keep', reason: 'a' }] } });
  assert.deepEqual(r, { ok: true });
  const [ready] = recorded(state);
  assert.equal(ready.attrs.intent_impact.candidate_count, 0);
});

test('a lane with no worktree at all still accepts an impact report (AC-027)', async () => {
  const { state } = setup();
  rmSync(join(state, 'planner-sessions.jsonl'));
  const r = await agentReady({ ...counts, intentImpact: { paths: [], decisions: [] } });
  assert.deepEqual(r, { ok: true });
  assert.equal(recorded(state)[0].attrs.intent_impact.candidate_count, 0);
});

test('the lane\'s own new DEC is not among the candidates', async () => {
  const { state, worktree } = setup();
  const own = join(worktree, '_docs/intent/app/idd-1/decision.md');
  mkdirSync(join(worktree, '_docs/intent/app/idd-1'), { recursive: true });
  writeFileSync(own, '# own\n\n## Decisions\n\n### DEC-600: 自分の判断\n\n- **Anchors**: `src/x.ts`\n');
  const r = await agentReady({ ...counts, intentImpact: { paths: ['src/x.ts'], decisions: [] } });
  assert.deepEqual(r, { ok: true });
  const [ready] = recorded(state);
  // only the other lane's DEC counts
  assert.equal(ready.attrs.intent_impact.candidate_count, 1);
});

test('a report naming a superseded DEC is accepted, and the DEC is outside the candidates (AC-003)', async () => {
  const { worktree } = setup();
  const doc = join(worktree, '_docs/intent/app/other/decision.md');
  writeFileSync(doc, '# other\n\n## Decisions\n\n### DEC-500: 他の lane の判断\n\n- **Why**: 壊さないため。\n- **Anchors**: `src/x.ts`\n- **Superseded by**: DEC-501\n\n### DEC-501: 後継の判断\n\n- **Why**: 置き換えるため。\n- **Anchors**: `src/y.ts`\n');
  const r = await agentReady({ ...counts, intentImpact: impact() });
  assert.deepEqual(r, { ok: true });
  const [ready] = recorded(process.env.IDD_STATE_DIR);
  assert.equal(ready.attrs.intent_impact.candidate_count, 0);
  assert.equal(ready.attrs.intent_impact.rows[0].id, 'DEC-500');
  assert.equal(ready.attrs.intent_impact.rows[0].outside_candidates, true);
});

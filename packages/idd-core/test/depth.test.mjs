import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentReady } from '../src/agent/inbound.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { DEPTH_TABLE, combineDepth, depthFloor, recordedDepth } from '../src/plan/depth.ts';
import { laneDepth } from '../src/plan/depth-read.ts';

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
const touching = allClear.map((r) => (r.kind === 'auth' ? { ...r, touches: true, reason: '認証を変える。' } : r));

/**
 * A lane whose planner worktree holds a qa of the given risk, with the repo's declared dangerous paths when asked.
 * No git worktree is needed for the reading: the declaration is enough to raise the floor, and a repo with no
 * declaration reads the qa alone.
 */
function setup({ risk = 'Low', declared = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'idd-depth-'));
  made.push(root);
  const state = join(root, 'state'); mkdirSync(state);
  const worktree = join(root, 'wt'); mkdirSync(worktree);
  const qaDir = join(worktree, '_docs/qa/app/idd-1');
  mkdirSync(qaDir, { recursive: true });
  writeFileSync(join(qaDir, 'qa.md'), `---\nrisk: ${risk}\n---\n\nbody\n`);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({
    repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main', ...(declared ? { risk_paths: { authz: ['lib/idd-ui/decide-actions.ts'] } } : {}) } },
  }));
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n');
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'p1', started_at: '2026-09-25T00:00:00Z', worktree_path: worktree, branch: 'idd/idd-1' }) + '\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return { state, worktree };
}

function recordedReady(state) {
  const file = readdirSync(state).find((f) => f.startsWith('lifecycle-'));
  if (!file) return [];
  return readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 's1_ready');
}

/** the ready report's fixed parts, so a test adds only the depth fields it is about */
const base = (over = {}) => ({
  iddId: 'IDD-1', decCount: 1, invCount: 0, qaCount: 1, referenceCount: 0,
  size: 'S', harm: 1, depth: 'shallow', summary: { situation: 's', action: 'a', outcome: 'o' },
  riskTable: allClear, intentImpact: { paths: [], decisions: [] }, ...over,
});

test('depthFloor: the engine can only raise a declaration (AC-002)', () => {
  assert.equal(depthFloor({ size: 'S', harm: 1 }), 'shallow');
  assert.equal(depthFloor({ size: 'M', harm: 1 }), 'standard');
  assert.equal(depthFloor({ size: 'S', harm: 2 }), 'standard');
  assert.equal(depthFloor({ size: 'S', harm: 1, riskHigh: true }), 'deep');
  assert.equal(depthFloor({ size: 'S', harm: 1, touchesTable: true }), 'deep');
  assert.equal(depthFloor({ size: 'S', harm: 3 }), 'deep');
  assert.equal(depthFloor({ size: 'S', harm: 1, matchedPaths: true }), 'deep');
});

test('combineDepth: the record and the Risk are read deeper-wins, absent record reads standard (AC-004)', () => {
  assert.equal(combineDepth('shallow', true), 'deep');
  assert.equal(combineDepth('deep', false), 'deep');
  assert.equal(combineDepth(undefined, true), 'deep');
  assert.equal(combineDepth(undefined, false), 'standard');
  assert.equal(combineDepth('standard', false), 'standard');
});

test('the depth table carries the counts every stage reads (AC-002, AC-008, AC-011, AC-037)', () => {
  // 2026-10-19: every depth runs the senior role's last review (shallow and standard were `false`); 2026-10-22: the kept check went with R2
  assert.deepEqual(DEPTH_TABLE.shallow, { planReview: 1, blind: 1, spec: 1, finalReview: true, fixRounds: 1, autoGo: true, shape: 0 });
  assert.deepEqual(DEPTH_TABLE.standard, { planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 2, autoGo: false, shape: 0 });
  assert.deepEqual(DEPTH_TABLE.deep, { planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 3, autoGo: false, shape: 1 });
});

test('the ready keeps the depth, the size and the harm (AC-001)', async () => {
  const { state } = setup();
  const r = await agentReady(base({ size: 'M', harm: 2, depth: 'standard' }));
  assert.deepEqual(r, { ok: true });
  const [ready] = recordedReady(state);
  assert.equal(ready.attrs.depth, 'standard');
  assert.equal(ready.attrs.size, 'M');
  assert.equal(ready.attrs.harm, 2);
});

test('a declaration shallower than the floor is refused, and no ready is written (AC-002)', async () => {
  // the touching table: standard and shallow are both below the floor
  {
    const { state } = setup({ risk: 'High' });
    for (const depth of ['shallow', 'standard']) {
      const r = await agentReady(base({ riskTable: touching, depth, size: 'L', harm: 1 }));
      assert.equal(r.ok, false, depth);
      assert.match(r.error, /deep/);
    }
    assert.equal(recordedReady(state).length, 0);
    // deeper than the floor stands
    assert.deepEqual(await agentReady(base({ riskTable: touching, depth: 'deep', size: 'L', harm: 1 })), { ok: true });
  }
  // a High qa alone
  {
    const { state } = setup({ risk: 'High' });
    assert.equal((await agentReady(base({ depth: 'standard' }))).ok, false);
    assert.deepEqual(await agentReady(base({ depth: 'deep' })), { ok: true });
    assert.equal(recordedReady(state).length, 1);
  }
  // harm 3 alone
  {
    const { state } = setup();
    assert.equal((await agentReady(base({ harm: 3 }))).ok, false);
    assert.deepEqual(await agentReady(base({ harm: 3, depth: 'deep' })), { ok: true });
  }
  // a path that falls under the repo's declared dangerous paths
  {
    const { state } = setup({ declared: true });
    const impact = { paths: ['lib/idd-ui/decide-actions.ts'], decisions: [] };
    assert.equal((await agentReady(base({ intentImpact: impact, declared: true }))).ok, false);
    assert.deepEqual(await agentReady(base({ intentImpact: impact, depth: 'deep', declared: true })), { ok: true });
  }
  // a size that is not S, and a harm of 2, make the floor standard
  {
    const { state } = setup();
    assert.equal((await agentReady(base({ size: 'M', depth: 'shallow' }))).ok, false);
    assert.deepEqual(await agentReady(base({ size: 'M', depth: 'standard' })), { ok: true });
    assert.equal((await agentReady(base({ harm: 2, depth: 'shallow' }))).ok, false);
    assert.deepEqual(await agentReady(base({ harm: 2, depth: 'standard' })), { ok: true });
  }
});

test('a report without the depth fields is refused with the field names and the floor rule (AC-003)', async () => {
  const { state } = setup();
  const cases = [{ size: undefined }, { harm: undefined }, { depth: undefined }];
  for (const c of cases) {
    const r = await agentReady(base(c));
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.match(r.error, /--size/);
    assert.match(r.error, /--harm/);
    assert.match(r.error, /--depth/);
    assert.match(r.error, /deep/);
    assert.match(r.error, /standard/);
    assert.match(r.error, /shallow/);
  }
  assert.equal(recordedReady(state).length, 0);
});

test('the depth reader gives the record and the Risk the deeper of the two (AC-004)', async () => {
  // the record says shallow, the lane's qa says High: deep
  {
    const { state, worktree } = setup({ risk: 'High' });
    writeFileSync(join(state, 'lifecycle-me_app.jsonl'), `${JSON.stringify({ idd_id: 'IDD-1', event: 's1_ready', at: '2026-09-25T00:00:00Z', attrs: { depth: 'shallow' } })}\n`);
    assert.equal(laneDepth(rec, worktree), 'deep');
    assert.equal(laneDepthFromEventsFor(state), 'shallow');
  }
  // the record says deep, the lane's qa says Low: deep
  {
    const { state, worktree } = setup({ risk: 'Low' });
    writeFileSync(join(state, 'lifecycle-me_app.jsonl'), `${JSON.stringify({ idd_id: 'IDD-1', event: 's1_ready', at: '2026-09-25T00:00:00Z', attrs: { depth: 'deep' } })}\n`);
    assert.equal(laneDepth(rec, worktree), 'deep');
  }
  // no record: High reads deep, a readable Low reads standard
  {
    const { worktree } = setup({ risk: 'High' });
    assert.equal(laneDepth(rec, worktree), 'deep');
  }
  {
    const { worktree } = setup({ risk: 'Low' });
    assert.equal(laneDepth(rec, worktree), 'standard');
  }
});

/** the record-only reading, for a lane whose worktree cannot be read */
function laneDepthFromEventsFor(state) {
  const file = readdirSync(state).find((f) => f.startsWith('lifecycle-'));
  if (!file) return 'standard';
  const events = readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return recordedDepth(events) ?? 'standard';
}

test('the planner brief names the three fields and the floor conditions (AC-005)', () => {
  const block = plannerBrief(rec).split('<plan>')[1].split('</plan>')[0];
  assert.match(block, /--size/);
  assert.match(block, /--harm/);
  assert.match(block, /--depth/);
  assert.match(block, /shallow/);
  assert.match(block, /standard/);
  assert.match(block, /deep/);
  assert.match(block, /risk_paths/);
});

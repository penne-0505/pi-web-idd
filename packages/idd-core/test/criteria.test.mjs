import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { criterionKey, laneCriteria } from '../src/ledger/criteria.ts';
import { buildSubmit } from '../src/plan/ship.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';

const original = process.cwd();
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_ALLOW_PROTOCOL: 'file',
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); }

/** a result report as the executor's `report result` writes it to the lifecycle */
const result = (at, verified, unverified = []) => ({
  idd_id: 'IDD-1', event: 's2_result', at, attrs: { outcome: 'success', qa_verified: verified, qa_unverified: unverified },
});

/** the progress note the executor's `report progress` overwrites each time */
function putProgress(dir, qaStatus) {
  writeFileSync(join(dir, 'executor-progress-IDD-1.json'), JSON.stringify({
    idd_id: 'IDD-1', updated_at: '2026-01-01T00:00:00Z', current_step: '', qa_status: qaStatus, recent_activity: [],
  }));
}

/** a state dir of its own with one lane's progress note in it */
function noteProgress(qaStatus) {
  const dir = scratchDir('criteria-state-');
  process.env.IDD_STATE_DIR = dir;
  putProgress(dir, qaStatus);
  return dir;
}

/** a project with one lane, so `buildSubmit` reads a real worktree; the lane's qa.md carries `acs` */
function shipFixture() {
  process.chdir(original);
  const root = scratchDir('criteria-ship-');
  const work = join(root, 'demo-work'), remote = join(root, 'demo-remote.git'), upstream = join(root, 'demo-upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n');
  put(join(work, 'app.txt'), 'one\n');
  commit(work);
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', 'origin', 'main');
  git(root, 'clone', remote, upstream);
  git(upstream, 'config', 'user.name', 'test');
  git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n');
  put(join(work, 'AGENTS.override.md'), 'private rules');
  commit(work);
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: {
    github: 'test/demo', upstream, work, work_base: 'work-main', public_base: 'main',
    lanes_root: join(root, 'demo-lanes'), checks: [], publish: false,
    issue_lane: { context: 'personal', source_type_priority: 'github' },
  } } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: IDD-1', source_type: 'github', gh_issue_url: 'https://github.com/test/demo/issues/1' }) + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, executor_session_id: 's-IDD-1' }) + '\n');
  process.chdir(work);
  return { root, work, state, lane };
}

/** the lane's qa.md as a plan writes it: one line per criterion */
function putCriteria(f, ids) {
  const body = ['# QA', '', ...ids.map((id) => `- ${id}: the thing it checks`)].join('\n');
  put(join(f.lane.path, '_docs/qa/demo/idd-1/qa.md'), body + '\n');
  put(join(f.lane.path, 'app.txt'), 'two\n');
  commit(f.lane.path, 'feat: IDD-1');
}

const criteriaCheck = (view) => view.checks.find((c) => c.label === '満たすべき条件がすべて確認済み');

test('the submit check reads a result that confirms every criterion the plan names', async () => {
  const f = shipFixture();
  putCriteria(f, ['AC-001', 'AC-002', 'AC-003', 'AC-004']);
  // the last progress note touched two criteria; the result confirms all four
  putProgress(f.state, [{ qa_id: 'AC-001', status: 'verified' }, { qa_id: 'AC-002', status: 'in_progress' }]);
  await seedLifecycle('s2_result', 'IDD-1', { outcome: 'success', qa_verified: ['AC-001', 'AC-002', 'AC-003', 'AC-004'], qa_unverified: [] });
  // AC-001: a lane whose result confirms every criterion passes the check
  assert.equal(criteriaCheck(buildSubmit('IDD-1')).ok, true);
});

test('a fix round that names only some criteria keeps the confirmations before it', () => {
  const c = laneCriteria('IDD-1', [
    result('2026-01-01T00:00:00Z', ['AC-001', 'AC-002', 'AC-003', 'AC-004']),
    result('2026-01-02T00:00:00Z', ['AC-001', 'AC-002', 'AC-003']),
  ]);
  // AC-002: the fourth criterion is not named again, so it stays confirmed
  for (const id of ['AC-001', 'AC-002', 'AC-003', 'AC-004']) assert.equal(c.has(id), true, id);
});

test('a later result that leaves a criterion unconfirmed takes the confirmation back', () => {
  const first = laneCriteria('IDD-1', [result('2026-01-01T00:00:00Z', ['AC-001', 'AC-002', 'AC-003'])]);
  assert.equal(first.has('AC-003'), true, 'confirmed by the first result');
  const second = laneCriteria('IDD-1', [
    result('2026-01-01T00:00:00Z', ['AC-001', 'AC-002', 'AC-003']),
    result('2026-01-02T00:00:00Z', ['AC-001', 'AC-002'], ['AC-003']),
  ]);
  // AC-003: the later result puts the criterion back to unconfirmed
  assert.equal(second.has('AC-003'), false);
  const third = laneCriteria('IDD-1', [
    result('2026-01-01T00:00:00Z', ['AC-001', 'AC-002', 'AC-003']),
    result('2026-01-02T00:00:00Z', ['AC-001', 'AC-002'], ['AC-003']),
    result('2026-01-03T00:00:00Z', ['AC-003']),
  ]);
  assert.equal(third.has('AC-003'), true, 'a later result confirms it again');
});

test('a result that lists the same criterion as confirmed and unconfirmed leaves it unconfirmed', () => {
  const c = laneCriteria('IDD-1', [result('2026-01-01T00:00:00Z', ['AC-001', 'AC-002'], ['AC-002'])]);
  // AC-004: the unconfirmed list wins inside one result
  assert.equal(c.has('AC-001'), true);
  assert.equal(c.has('AC-002'), false);
});

test('a plan criterion no result names is not confirmed, and an empty plan never passes', async () => {
  const f = shipFixture();
  putCriteria(f, ['AC-001', 'AC-002', 'AC-003']);
  await seedLifecycle('s2_result', 'IDD-1', { outcome: 'success', qa_verified: ['AC-001', 'AC-002'], qa_unverified: [] });
  // AC-005: the third criterion is named nowhere
  assert.equal(criteriaCheck(buildSubmit('IDD-1')).ok, false);

  const empty = shipFixture();
  putCriteria(empty, []);
  await seedLifecycle('s2_result', 'IDD-1', { outcome: 'success', qa_verified: ['AC-001'], qa_unverified: [] });
  assert.equal(criteriaCheck(buildSubmit('IDD-1')).ok, false, 'a plan with no criteria cannot pass the check');
});

test('a lane with no result reads its confirmations and in-progress from the progress note', () => {
  noteProgress([
    { qa_id: 'AC-001', status: 'verified' },
    { qa_id: 'AC-002', status: 'in_progress' },
  ]);
  const c = laneCriteria('IDD-1', []);
  // AC-006: the note is the only report such a lane has
  assert.equal(c.has('AC-001'), true);
  assert.equal(c.stateOf('AC-002'), 'in_progress');
  assert.equal(c.stateOf('AC-003'), 'other');
});

test('a lane with a result does not count the progress note as a confirmation', () => {
  noteProgress([
    { qa_id: 'AC-001', status: 'verified' },
    { qa_id: 'AC-002', status: 'verified' },
    { qa_id: 'AC-003', status: 'in_progress' },
    { qa_id: 'AC-004', status: 'in_progress' },
  ]);
  const c = laneCriteria('IDD-1', [result('2026-01-01T00:00:00Z', ['AC-005'], ['AC-001'])]);
  // AC-007: the note's confirmations are not counted; a criterion the result does not name stays unconfirmed
  assert.equal(c.has('AC-001'), false);
  assert.equal(c.has('AC-002'), false);
  assert.equal(c.stateOf('AC-002'), 'other');
  assert.equal(c.has('AC-005'), true);
  // the note's in-progress marks still read as running
  assert.equal(c.stateOf('AC-003'), 'in_progress');
  assert.equal(c.stateOf('AC-004'), 'in_progress');
});

test('a two-digit report id names the same criterion as the plan id of the same number', () => {
  assert.equal(criterionKey('AC-01'), criterionKey('AC-001'));
  const c = laneCriteria('IDD-1', [result('2026-01-01T00:00:00Z', ['AC-01'])]);
  // AC-008: the number decides, and a different number stays a different criterion
  assert.equal(c.has('AC-001'), true);
  assert.equal(c.has('AC-010'), false);
});

test('a note entry whose qa_id is not a string is skipped, and the rest of the note is still read', () => {
  noteProgress([
    { qa_id: 'AC-001', status: 'verified' },
    { qa_id: 7, status: 'verified' },
    { qa_id: null, status: 'in_progress' },
    { status: 'verified' },
    null,
  ]);
  // F-1: the door stores whatever array the report sent, and one malformed entry must not throw or name a criterion
  const c = laneCriteria('IDD-1', []);
  assert.equal(c.has('AC-001'), true);
  assert.deepEqual(c.verifiedIds(), ['AC-1']);
  assert.equal(c.stateOf('AC-007'), 'other');
});

test('a malformed in-progress entry is skipped beside a result', () => {
  noteProgress([
    { qa_id: 'AC-002', status: 'in_progress' },
    { qa_id: 9, status: 'in_progress' },
    null,
  ]);
  const c = laneCriteria('IDD-1', [result('2026-01-01T00:00:00Z', ['AC-001'])]);
  // F-1: the entry the note marks in progress still runs; the rest of the result stands
  assert.equal(c.stateOf('AC-002'), 'in_progress');
  assert.equal(c.has('AC-001'), true);
  assert.deepEqual(c.verifiedIds(), ['AC-1']);
});

test('a lane whose work column carries evidence is read through the same fold as the card and the detail', () => {
  const dir = scratchDir('criteria-work-');
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo' }) + '\n');
  putProgress(dir, [{ qa_id: 'AC-009', status: 'verified' }]);
  writeFileSync(join(dir, 'work-demo.jsonl'), JSON.stringify(
    { event: 'ac_reported', at: '2026-01-01T00:00:00Z', repo: 'demo', lane: 'IDD-1', source: 'result', items: [{ id: 'AC-001', status: 'verified', evidence: 'ran it' }, { id: 'AC-002', status: 'covered' }] },
  ) + '\n');
  // the closing record reads through laneCriteria, and so does the card; both take the work column's evidence
  const c = laneCriteria('IDD-1', []);
  assert.equal(c.has('AC-001'), true);
  assert.deepEqual(c.verifiedIds(), ['AC-1']);
  assert.equal(c.stateOf('AC-002'), 'in_progress');
  assert.equal(c.has('AC-009'), false, 'the overwritten progress note is not the source once a work row exists');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { proposeForTests as propose, exportLane, proposalPath } from '../src/overlay/export.ts';
import { proposeImport } from '../src/overlay/import.ts';
import { syncArea } from '../src/overlay/sync.ts';
import { branchFor, parseRepos } from '../src/config/areas.ts';
import { pushApproval } from './passkey-approval.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const approveExport = (token, approval) => exportLane('IDD-1', token, pushApproval('IDD-1', approval));
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); }

const LINEAR = { source_type: 'linear', linear_issue_url: 'https://linear.app/org/issue/APP-2240', gh_issue_url: null };
const GITHUB = { source_type: 'github', linear_issue_url: null, gh_issue_url: 'https://github.com/test/project/issues/12' };

/**
 * A work clone with an overlay, a bare public remote and an upstream clone. `repo` adds fields to the
 * repos.yaml entry, `lane` to its issue_lane section, and `issue` to the lane's backlog record.
 */
function setup({ repo = {}, lane = {}, issue = GITHUB, identity = { name: 'Upstream Person', email: 'person@example.com' } } = {}) {
  process.chdir(original);
  const root = scratchDir('run-');
  const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n'); put(join(work, 'app.txt'), 'one\ntwo\nthree\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream);
  if (identity) { git(upstream, 'config', 'user.name', identity.name); git(upstream, 'config', 'user.email', identity.email); }
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  const areas = join(root, 'repos.yaml');
  const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], ...repo, issue_lane: { context: 'personal', source_type_priority: 'github', ...lane } };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', ...issue }) + '\n');
  const made = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: made.path, branch: made.branch, executor_session_id: 'test-session' }) + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane: made, config, areas };
}

/** a file the public side tracks at a path the work clone's manifest keeps private */
function publicTracks(f, path, branch = 'main') {
  git(f.upstream, 'fetch', '-q', 'origin');
  const from = git(f.upstream, 'branch', '-r', '--list', `origin/${branch}`) ? `origin/${branch}` : 'origin/main';
  git(f.upstream, 'checkout', '-q', '-B', branch, from);
  put(join(f.upstream, path), 'the team keeps this file\n'); commit(f.upstream, 'docs: team file');
  git(f.upstream, 'push', 'origin', branch);
  git(f.upstream, 'checkout', '-q', 'main');
}

test('a submit stops, naming the path, when the public side tracks a path the manifest keeps private', async () => {
  const f = setup();
  publicTracks(f, '_docs/guide.md');
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: change', body: 'body' });
  assert.ok(p.error, 'propose must not prepare a submit that deletes a public file');
  assert.match(p.error, /公開側/);
  assert.match(p.error, /_docs\/guide\.md/);
  // nothing reached the public side, and the team's file is still there
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  assert.equal(git(f.remote, 'show', 'main:_docs/guide.md'), 'the team keeps this file');
});

test('an import of the work branch stops when the public side tracks a path the manifest keeps private, and sync says why', async () => {
  const f = setup();
  publicTracks(f, 'AGENTS.override.md');
  const head = git(f.work, 'rev-parse', 'HEAD');
  const p = proposeImport('demo');
  assert.ok(p.error, 'the import must not take in a public file over a private one');
  assert.match(p.error, /公開側/);
  assert.match(p.error, /AGENTS\.override\.md/);
  const s = await syncArea('demo');
  assert.equal(s.ok, false);
  assert.match(s.error, /AGENTS\.override\.md/);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.work, 'show', 'HEAD:AGENTS.override.md'), 'private rules');
});

test('adopting a public branch stops when that branch tracks a path the manifest keeps private', async () => {
  const f = setup();
  publicTracks(f, '_docs/notes.md', 'someone/branch');
  const p = proposeImport('demo', { laneId: 'IDD-1', branch: 'someone/branch' });
  assert.ok(p.error);
  assert.match(p.error, /_docs\/notes\.md/);
});

test('the export commit carries the upstream clone\'s identity and the repo\'s message pattern', async () => {
  const f = setup({ repo: { commit_message: '{summary} ({linear_identifier})' }, issue: LINEAR });
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  // the drafted title may or may not carry the identifier already: the message has it once
  const p = await propose('IDD-1', { title: 'feat: 変更する (APP-2240)', body: 'body' });
  assert.ok(!p.error, p.error);
  assert.equal(p.commitMessage, 'feat: 変更する (APP-2240)');
  assert.deepEqual(p.author, { name: 'Upstream Person', email: 'person@example.com' });
  // the card starts from the repo's form, and the commit carries the message penne approves
  const e = approveExport(p.token, { message: p.commitMessage });
  assert.equal(e.ok, true, e.error);
  assert.equal(git(f.remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', e.commit), 'Upstream Person <person@example.com>|Upstream Person <person@example.com>|feat: 変更する (APP-2240)');

  const g = setup({ repo: { commit_message: '{summary} ({linear_identifier})' }, issue: LINEAR });
  put(join(g.lane.path, 'app.txt'), 'changed\n'); commit(g.lane.path);
  assert.equal((await propose('IDD-1', { title: 'fix: 直す', body: 'body' })).commitMessage, 'fix: 直す (APP-2240)');
});

test('without a message pattern the export commit keeps the PR title, still under the upstream identity', async () => {
  const f = setup();
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: exact title', body: 'body' });
  assert.ok(!p.error, p.error);
  assert.equal(p.commitMessage, 'feat: exact title');
  const e = approveExport(p.token, { message: p.commitMessage });
  assert.equal(e.ok, true, e.error);
  assert.equal(git(f.remote, 'log', '-1', '--format=%an <%ae>|%s', e.commit), 'Upstream Person <person@example.com>|feat: exact title');
});

test('an upstream clone without a git identity stops the submit with the reason', async () => {
  const f = setup({ identity: null });
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: change', body: 'body' });
  assert.ok(p.error);
  assert.match(p.error, /user\.name/);
});

test('a local completion (nothing to publish) needs no identity and no message', async () => {
  const f = setup({ identity: null, repo: { commit_message: '{title} ({linear_identifier})' } });
  put(join(f.lane.path, '_docs/intent/demo/idd-1/decision.md'), '### DEC-900: private\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: change', body: 'body' });
  assert.ok(!p.error, p.error);
  assert.equal(p.mode, 'local');
  assert.equal(p.author, undefined);
});

test('a message pattern that needs a value the lane lacks stops the submit', async () => {
  const f = setup({ repo: { commit_message: '{title} ({linear_identifier})' }, issue: GITHUB });
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: change', body: 'body' });
  assert.ok(p.error);
  assert.match(p.error, /linear_identifier/);
});

test('branch names: the repo\'s rule first, feature/ by default, and a lane keeps the branch it was made on', async () => {
  // an explicit rule, as waydroid_mpris and pi-web-idd write it
  let f = setup({ lane: { branch_name_pattern: 'idd/{idd_id}' } });
  assert.equal(f.lane.branch, 'idd/IDD-1');
  // an explicit rule with the Linear identifier and the GitHub number, each per source
  f = setup({ lane: { branch_name_pattern: { linear: 'feature/{linear_id}', github: 'gh/{issue_number}-{idd_id_lower}' } }, issue: LINEAR });
  assert.equal(f.lane.branch, 'feature/app-2240');
  f = setup({ lane: { branch_name_pattern: { linear: 'feature/{linear_id}', github: 'gh/{issue_number}-{idd_id_lower}' } }, issue: GITHUB });
  assert.equal(f.lane.branch, 'gh/12-idd-1');
  // no rule: feature/ with the Linear identifier, or the lane id in lower case
  f = setup({ issue: LINEAR });
  assert.equal(f.lane.branch, 'feature/app-2240');
  f = setup({ issue: GITHUB });
  assert.equal(f.lane.branch, 'feature/idd-1');
  assert.equal(branchFor('demo', 'IDD-1'), 'feature/idd-1');

  // a lane made under one rule keeps its branch after the rule changes
  f = setup({ lane: { branch_name_pattern: 'lane/{idd_id}' } });
  assert.equal(f.lane.branch, 'lane/IDD-1');
  put(f.areas, JSON.stringify({ repos: { demo: { ...f.config, issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  assert.deepEqual(ensureLaneWorktree('demo', 'IDD-1'), f.lane);
  assert.equal((await propose('IDD-1', { title: 'feat: change', body: 'body' })).branch, 'lane/IDD-1');
});

test('a branch rule that needs a value the lane lacks is refused, and an unknown value is a config error', async () => {
  const f = setup();
  put(f.areas, JSON.stringify({ repos: { demo: { ...f.config, issue_lane: { context: 'personal', source_type_priority: 'github', branch_name_pattern: 'feature/{linear_id}' } } } }));
  put(join(f.state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-2', area: 'demo', title: 'feat: other', ...GITHUB }) + '\n');
  assert.throws(() => ensureLaneWorktree('demo', 'IDD-2'), /linear_id/);
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'a/b': { upstream: '/u', work: '/w', issue_lane: { branch_name_pattern: 'feature/{jira}' } } } })), /\{jira\}/);
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'a/b': { upstream: '/u', work: '/w', commit_message: '{title} {oops}' } } })), /\{oops\}/);
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'a/b': { upstream: '/u', work: '/w', pr_linear_reference: 'mention' } } })), /pr_linear_reference/);
});

test('a lane for the same Linear Issue as a lane still in progress stops, saying whose branch it is', async () => {
  const f = setup({ issue: LINEAR });
  assert.equal(f.lane.branch, 'feature/app-2240');
  put(join(f.state, 'backlog.jsonl'), [{ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', ...LINEAR }, { idd_id: 'IDD-2', area: 'demo', title: 'feat: change', ...LINEAR }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  // with the earlier lane's worktree there or not, the branch is that lane's while it goes on
  const inProgress = (e) => /進行中の lane IDD-1/.test(e.message) && !/退役/.test(e.message);
  assert.throws(() => ensureLaneWorktree('demo', 'IDD-2'), inProgress);
  git(f.work, 'worktree', 'remove', f.lane.path);
  assert.throws(() => ensureLaneWorktree('demo', 'IDD-2'), inProgress);
});

test('a lane taken in again while the ended lane\'s worktree is still there stops until it is retired', async () => {
  const f = setup({ issue: LINEAR });
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 'lane_close', at: new Date().toISOString(), attrs: { outcome: 'aborted' } }) + '\n');
  put(join(f.state, 'backlog.jsonl'), [{ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', ...LINEAR }, { idd_id: 'IDD-2', area: 'demo', title: 'feat: change', ...LINEAR }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.throws(() => ensureLaneWorktree('demo', 'IDD-2'), (e) => /前の lane の worktree/.test(e.message) && e.message.includes(f.lane.path));
});

test('a lane taken in again after the earlier one was put on hold (s3_defer) starts on a fresh suffixed branch', async () => {
  const f = setup({ issue: LINEAR });
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: 'IDD-1', event: 's3_defer', at: new Date().toISOString() }) + '\n');
  git(f.work, 'worktree', 'remove', f.lane.path);
  put(join(f.state, 'backlog.jsonl'), [{ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', ...LINEAR }, { idd_id: 'IDD-2', area: 'demo', title: 'feat: change', ...LINEAR }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(ensureLaneWorktree('demo', 'IDD-2').branch, 'feature/app-2240-2');
});

function closeLane(f, iddId) {
  appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: iddId, event: 'lane_close', at: new Date().toISOString(), attrs: { outcome: 'aborted' } }) + '\n');
}
function backlog(f, ...recs) {
  put(join(f.state, 'backlog.jsonl'), recs.map((r) => JSON.stringify({ area: 'demo', title: 'feat: change', ...r })).join('\n') + '\n');
}

test('a lane taken in again after the earlier one ended starts on a fresh branch from the work branch, with a suffix', async () => {
  const f = setup({ issue: LINEAR });
  put(join(f.lane.path, 'abandoned.txt'), 'thrown away\n'); commit(f.lane.path);
  closeLane(f, 'IDD-1');
  git(f.work, 'worktree', 'remove', f.lane.path);
  put(join(f.work, 'newer.txt'), 'the work branch moved on\n'); commit(f.work);
  backlog(f, { idd_id: 'IDD-1', ...LINEAR }, { idd_id: 'IDD-2', ...LINEAR });
  const second = ensureLaneWorktree('demo', 'IDD-2');
  assert.equal(second.branch, 'feature/app-2240-2');
  assert.equal(git(second.path, 'rev-parse', 'HEAD'), git(f.work, 'rev-parse', 'work-main'), 'cut from the work branch now');
  assert.equal(git(second.path, 'ls-files', 'abandoned.txt'), '', 'nothing of the ended lane');
  // the same lane asks again before its session is recorded: the same worktree and branch
  assert.deepEqual(ensureLaneWorktree('demo', 'IDD-2'), second);
  // a third time, after the second lane ended too
  appendFileSync(join(f.state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-2', worktree_path: second.path, branch: second.branch, executor_session_id: 's2' }) + '\n');
  closeLane(f, 'IDD-2');
  git(f.work, 'worktree', 'remove', second.path);
  backlog(f, { idd_id: 'IDD-1', ...LINEAR }, { idd_id: 'IDD-2', ...LINEAR }, { idd_id: 'IDD-3', ...LINEAR });
  assert.equal(ensureLaneWorktree('demo', 'IDD-3').branch, 'feature/app-2240-3');
});

test('a branch no lane recorded (made before IDD) is taken as it is', async () => {
  const f = setup();
  git(f.work, 'branch', 'feature/app-2240', 'work-main');
  put(join(f.work, 'x.txt'), 'x\n'); commit(f.work);
  backlog(f, { idd_id: 'IDD-1', ...GITHUB }, { idd_id: 'IDD-2', ...LINEAR });
  const lane = ensureLaneWorktree('demo', 'IDD-2');
  assert.equal(lane.branch, 'feature/app-2240');
});

test('a branch held by a worktree outside the lanes is refused as someone else\'s work, not an earlier lane', async () => {
  const f = setup();
  const manual = join(f.root, 'manual');
  git(f.work, 'worktree', 'add', '-b', 'feature/app-2240', manual, 'work-main');
  backlog(f, { idd_id: 'IDD-1', ...GITHUB }, { idd_id: 'IDD-2', ...LINEAR });
  assert.throws(() => ensureLaneWorktree('demo', 'IDD-2'), (e) => e.message.includes(manual) && !/前の lane/.test(e.message) && /lane の置き場の外/.test(e.message));
});

test('a branch rule with nothing that differs between lanes is a config error', async () => {
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'a/b': { upstream: '/u', work: '/w', issue_lane: { branch_name_pattern: 'feature/fixed' } } } })), /lane ごとに違う値/);
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'a/b': { upstream: '/u', work: '/w', issue_lane: { branch_name_pattern: { linear: 'feature/{linear_id}', github: 'gh/one' } } } } })), /github.*lane ごとに違う値/);
});

test('a submit prepared before the author was part of it is not exported: it asks to be checked again', async () => {
  const f = setup();
  put(join(f.lane.path, 'app.txt'), 'changed\n'); commit(f.lane.path);
  const p = await propose('IDD-1', { title: 'feat: change', body: 'body' });
  assert.ok(!p.error, p.error);
  const saved = JSON.parse(readFileSync(proposalPath('IDD-1'), 'utf8'));
  delete saved.author; delete saved.commitMessage;
  writeFileSync(proposalPath('IDD-1'), JSON.stringify(saved));
  const e = approveExport(p.token, { message: 'feat: change' });
  assert.equal(e.ok, false);
  assert.match(e.error, /再確認/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

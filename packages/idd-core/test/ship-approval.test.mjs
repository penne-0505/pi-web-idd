import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { mergedGh } from './helpers/fake-gh.mjs';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { proposeForTests as propose, readProposal, proposalPath, custodyPath, exportLane } from '../src/overlay/export.ts';
import { buildSubmit, prepareSubmit, runShip, settlePushed } from '../src/plan/ship.ts';
import { deriveStage } from '../src/ledger/derive.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle, applyDecision } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { setAgentRunner } from '../src/agent/port.ts';
import { lock } from '../src/overlay/git.ts';
import { pushApproval, shipApproved } from './passkey-approval.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); }

function setup(checks = []) {
  process.chdir(original);
  setAgentRunner(null);
  const root = scratchDir('run-'); const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n'); put(join(work, 'app.txt'), 'one\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'Upstream Person'); git(upstream, 'config', 'user.email', 'person@example.com');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  const areas = join(root, 'repos.yaml'); const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks, issue_lane: { context: 'personal', source_type_priority: 'github' } };
  put(areas, JSON.stringify({ repos: { demo: config } })); Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lane = ensureLaneWorktree('demo', 'IDD-1');
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change' }) + '\n');
  put(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', worktree_path: lane.path, branch: lane.branch, executor_session_id: 'test-session' }) + '\n');
  process.chdir(work);
  return { root, work, remote, upstream, state, lane };
}

/**
 * A gh that keeps the repo's PRs in a file: `pr list` and `pr view` answer from it, `pr create` adds one,
 * `pr edit` changes one. Every call is logged. It is put both on IDD_GH_BIN and first on PATH. Flag files make
 * `pr list` (fail-list) or `pr create` (fail-create) fail.
 */
function fakeGh(root, prs = []) {
  const dir = join(root, 'gh'); mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.jsonl'), store = join(dir, 'prs.json');
  writeFileSync(store, JSON.stringify(prs));
  const bin = join(dir, 'gh');
  put(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const prs = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'));
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
// a passing failure of GitHub (the network) while the flag file is there
if (args[0] === 'pr' && args[1] === 'list' && fs.existsSync(${JSON.stringify(join(dir, 'fail-list'))})) { console.error('connection reset by peer'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify(prs.filter((p) => p.headRefName === at('--head') && p.state === 'OPEN').map((p) => ({ url: p.url, number: p.number, baseRefName: p.baseRefName }))));
  process.exit(0);
}
// GitHub refuses to make the PR (after the push went out) while the flag file is there
if (args[0] === 'pr' && args[1] === 'create' && fs.existsSync(${JSON.stringify(join(dir, 'fail-create'))})) { console.error('HTTP 502'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'create') {
  const number = prs.length + 1;
  const url = 'https://github.com/test/project/pull/' + number;
  prs.push({ number, url, headRefName: at('--head'), baseRefName: at('--base'), state: 'OPEN', title: at('--title'), body: at('--body') });
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(prs));
  console.log(url);
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const p = prs.find((x) => String(x.number) === args[2]);
  if (!p) { console.error('no pull request found'); process.exit(1); }
  console.log(JSON.stringify({ state: p.state, headRefOid: p.headRefOid ?? null, mergedAt: p.mergedAt ?? null, mergedBy: p.mergedBy ?? null }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'edit') {
  const p = prs.find((x) => String(x.number) === args[2]);
  if (at('--title') !== undefined) p.title = at('--title');
  if (at('--body') !== undefined) p.body = at('--body');
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(prs));
  process.exit(0);
}
console.error('unexpected gh ' + args.join(' '));
process.exit(1);
`);
  chmodSync(bin, 0o755);
  process.env.IDD_GH_BIN = bin;
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    prs: () => JSON.parse(readFileSync(store, 'utf8')),
  };
}

const edits = (gh) => gh.calls().filter((a) => a[0] === 'pr' && a[1] === 'edit');
const creates = (gh) => gh.calls().filter((a) => a[0] === 'pr' && a[1] === 'create');
const laneEvents = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1').map((e) => e.event);

async function submitPush() {
  const { runSubmitPush } = await import('../src/plan/submit-push.ts');
  return runSubmitPush();
}

const APPROVED = 'feat: 承認した commit';
/** the export and the ship, with the verified nonce for exactly the approval the test passes */
const approveExport = (token, approval) => exportLane('IDD-1', token, pushApproval('IDD-1', approval));
const approveShip = (token, approval) => runShip('IDD-1', token, shipApproved('IDD-1', approval));
/** penne approves the push on the card: its commit message, and a new PR's title and body for a lane that has no PR */
async function approve(extra = {}) {
  const view = buildSubmit('IDD-1');
  const token = view?.proposal?.token ?? readProposal('IDD-1')?.token;
  return approveShip(token, { commitMessage: APPROVED, ...(view?.existingPr ? {} : { pr: { title: 'feat: 題', body: '本文' } }), ...extra });
}

/** the tick checks the lane, and penne approves its push on the card */
async function pushApproved(extra = {}) {
  const tick = await submitPush();
  const done = await approve(extra);
  assert.equal(done.ok, true, `${done.error} / ${JSON.stringify(tick)}`);
  return { tick, done };
}

/** the push went out on penne's approval, but GitHub refused to make its PR: the submit waits pushed, with no PR */
async function pushedWithoutPr(f) {
  await submitPush();
  const flag = join(f.root, 'gh', 'fail-create');
  writeFileSync(flag, '');
  try {
    const r = await approve();
    assert.equal(r.ok, false);
  } finally { rmSync(flag, { force: true }); }
  assert.equal(readProposal('IDD-1').status, 'pushed');
}

test('submitting to a branch whose PR is open does not overwrite the PR title and body', async () => {
  const f = setup();
  const gh = fakeGh(f.root, [{ number: 5, url: 'https://github.com/test/project/pull/5', headRefName: f.lane.branch, baseRefName: 'main', state: 'OPEN', title: 'penne の題', body: 'penne が書いた本文' }]);
  await startSubmit(f, 'ours\n', 'fix: ours');
  const p = await propose('IDD-1', { title: 'feat: 下書きの題', body: '下書きの本文' });
  assert.ok(!p.error, p.error);
  const r = await approveShip(p.token, { commitMessage: 'fix: ours', pr: { title: 'feat: 下書きの題', body: '下書きの本文' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.prUrl, 'https://github.com/test/project/pull/5');
  assert.deepEqual(edits(gh), []);
  assert.deepEqual(creates(gh), []);
  assert.deepEqual(gh.prs()[0], { number: 5, url: 'https://github.com/test/project/pull/5', headRefName: f.lane.branch, baseRefName: 'main', state: 'OPEN', title: 'penne の題', body: 'penne が書いた本文' });
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'ours');
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('the tick only checks a submit, and the card\'s approval pushes it and makes the PR with exactly its text, once', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');

  const checked = await submitPush();
  assert.deepEqual(checked.ready, ['IDD-1'], JSON.stringify(checked));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing pushed before the approval');
  assert.ok(!laneEvents().includes('s4_pushed'));
  assert.deepEqual(creates(gh), []);
  assert.equal(deriveStage(readLifecycle()).decision, 'ship', 'the card waits for the approval');
  const view = buildSubmit('IDD-1');
  assert.equal(view.proposal?.status, 'prepared');

  const r = await approveShip(view.proposal.token, { commitMessage: APPROVED, pr: { title: 'feat: 承認した題', body: '承認した本文\n' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'ours');
  assert.equal(creates(gh).length, 1);
  assert.deepEqual(gh.prs().map((p) => ({ title: p.title, body: p.body, base: p.baseRefName, head: p.headRefName })), [{ title: 'feat: 承認した題', body: '承認した本文\n', base: 'main', head: f.lane.branch }]);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  // approving the same card again makes no second PR
  assert.equal((await approveShip(view.proposal.token, { commitMessage: APPROVED, pr: { title: 'feat: 承認した題', body: '承認した本文\n' } })).ok, true);
  assert.equal(creates(gh).length, 1);
});

test('a later revision is pushed to the open PR on its approval without touching its text, and the lane goes back to waiting on it', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'first\n', 'feat: first');
  await pushApproved({ pr: { title: 'feat: 題', body: '最初の本文' } });
  // penne edits the body on GitHub by hand
  const prs = gh.prs(); prs[0].body = 'penne が直した本文'; writeFileSync(join(f.root, 'gh', 'prs.json'), JSON.stringify(prs));

  await startSubmit(f, 'second\n', 'fix: second');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'first', 'not pushed before the approval');
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'second');
  assert.deepEqual(edits(gh), []);
  assert.equal(creates(gh).length, 1);
  assert.equal(gh.prs()[0].body, 'penne が直した本文');
  const created = readLifecycle().filter((e) => e.event === 's4_pr_created');
  assert.equal(created.length, 2);
  assert.equal(created[1].attrs.pr_url, 'https://github.com/test/project/pull/1');
  assert.equal(created[1].attrs.commit, git(f.remote, 'rev-parse', f.lane.branch));
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

/** the lane commits `text` to its app.txt and its submit starts */
async function startSubmit(f, text, message) {
  put(join(f.lane.path, 'app.txt'), text); commit(f.lane.path, message);
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
}

const tipOf = (f) => git(f.remote, 'rev-parse', f.lane.branch);
/** the lane's commit (and any `more` commits) goes out on approval as the first push; the public branch's tip is returned */
async function pushFirst(f, more = []) {
  await startSubmit(f, 'first\n', 'feat: first');
  for (const [name, message] of more) { put(join(f.lane.path, name), 'x\n'); commit(f.lane.path, message); }
  await pushApproved({ pr: { title: 'feat: 題', body: '最初の本文' } });
  return tipOf(f);
}
/** a second commit is checked and waits for approval; the card's token is returned */
async function startSecond(f) {
  await startSubmit(f, 'second\n', 'fix: second');
  await submitPush();
  return readProposal('IDD-1').token;
}
const parentsOf = (f, from, to) => git(f.remote, 'rev-list', '--parents', `${from}..${to}`).split('\n').map((l) => l.split(' '));
/** `fn` runs with a git in front on PATH that, just before any push, moves the remote branch through `tos` in turn */
async function whileGitMoves(f, tos, fn) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = scratchDir('shim-'); const shim = join(bin, 'git');
  const moves = tos.map((to) => `cp.execFileSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(f.remote)}, 'update-ref', 'refs/heads/${f.lane.branch}', ${JSON.stringify(to)}]);`).join(' ');
  put(shim, `#!${process.execPath}\nconst cp = require('node:child_process');\nconst a = process.argv.slice(2);\nif (a.includes('push')) { ${moves} }\nconst r = cp.spawnSync(${JSON.stringify(realGit)}, a, { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n`);
  chmodSync(shim, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

test('the first push is one commit over the public base and a later one is one commit over the previous push, never forced', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  // a forced replacement of the branch would be refused by the remote itself
  git(f.remote, 'config', 'receive.denyNonFastForwards', 'true');
  const baseTip = git(f.remote, 'rev-parse', 'main');
  const first = await pushFirst(f, [['extra.txt', 'feat: more']]);
  assert.deepEqual(parentsOf(f, baseTip, first).map((l) => l.slice(1)), [[baseTip]], 'the lane\'s two commits go out as one over the base');

  await startSecond(f);
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  const second = tipOf(f);
  assert.notEqual(second, first);
  assert.deepEqual(parentsOf(f, baseTip, second), [[second, first], [first, baseTip]]);
  assert.equal(creates(gh).length, 1);
});

test('a push is stopped, not forced, when the public branch moved since the check', async () => {
  const f = setup();
  fakeGh(f.root);
  const first = await pushFirst(f);
  const token = await startSecond(f);
  // someone pushes to the branch after the check
  git(f.upstream, 'fetch', 'origin'); git(f.upstream, 'checkout', '-B', 'moved', `origin/${f.lane.branch}`);
  put(join(f.upstream, 'other.txt'), 'theirs\n'); commit(f.upstream, 'fix: theirs'); git(f.upstream, 'push', 'origin', `moved:refs/heads/${f.lane.branch}`);
  const theirs = tipOf(f);
  const r = await approveShip(token, { commitMessage: APPROVED });
  assert.equal(r.ok, false);
  assert.equal(tipOf(f), theirs, 'the branch is as the other push left it');
  assert.notEqual(theirs, first);
});

test('a push is stopped when the public branch is rewound to an ancestor between the last look at its tip and the push', async () => {
  const f = setup();
  fakeGh(f.root);
  const ancestor = git(f.remote, 'rev-parse', `${await pushFirst(f)}^`);
  const token = await startSecond(f);
  // a git that moves the remote branch back just before it pushes: the tip was looked at (ls-remote) before this
  await whileGitMoves(f, [ancestor], async () => {
    const r = await approveShip(token, { commitMessage: APPROVED });
    assert.equal(r.ok, false);
  });
  assert.equal(tipOf(f), ancestor, 'the branch is as it was rewound, not advanced over');
});

test('a push is stopped when the checked target is not the tip the check saw, and the remote is left as it was', async () => {
  const f = setup();
  fakeGh(f.root);
  const first = await pushFirst(f);
  const ancestor = git(f.remote, 'rev-parse', `${first}^`);
  const token = await startSecond(f);
  // the tip the check saw and the target it fetched are two reads: here they differ
  const saved = JSON.parse(readFileSync(proposalPath('IDD-1'), 'utf8'));
  assert.equal(saved.targetTip, first);
  saved.target = ancestor; writeFileSync(proposalPath('IDD-1'), JSON.stringify(saved));
  const r = await approveShip(token, { commitMessage: APPROVED });
  assert.equal(r.ok, false);
  assert.equal(tipOf(f), first, 'nothing is pushed');
});

test('a branch that moves to another tip and back just before the push is only ever advanced over, never replaced', async () => {
  const f = setup();
  fakeGh(f.root);
  const first = await pushFirst(f);
  // a commit unrelated to the branch, kept on a branch of its own
  git(f.upstream, 'fetch', 'origin'); git(f.upstream, 'checkout', '-B', 'side', 'origin/main');
  put(join(f.upstream, 'side.txt'), 'side\n'); commit(f.upstream, 'fix: side'); git(f.upstream, 'push', 'origin', 'side:refs/heads/side');
  const side = git(f.remote, 'rev-parse', 'side');
  const token = await startSecond(f);
  await whileGitMoves(f, [side, first], () => approveShip(token, { commitMessage: APPROVED }));
  const tip = tipOf(f);
  assert.notEqual(tip, side, 'the unrelated tip is not what the branch is left at');
  git(f.remote, 'merge-base', '--is-ancestor', first, tip);
});

test('a submit whose checks do not pass is held once per head, not checked again on every tick', async () => {
  const f = setup();
  const counter = join(scratchDir('count-'), 'out');
  // the lane's change makes it fail (the lane's base passes it), so the failure is the lane's and holds the push
  const checks = [{ name: 'fails', command: [process.execPath, '-e', `const fs = require('node:fs'); if (fs.readFileSync('app.txt', 'utf8') === 'one\\n') process.exit(0); fs.appendFileSync(${JSON.stringify(counter)}, 'x'); process.exit(1)`], required: true }];
  // the areas file is written by setup; the check goes in after
  const areas = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  areas.repos.demo.checks = checks; writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify(areas));
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const r1 = await submitPush();
  assert.deepEqual(r1.held, ['IDD-1'], JSON.stringify(r1));
  const r2 = await submitPush();
  assert.deepEqual(r2.held, []);
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'the check ran once');
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  assert.deepEqual(gh.calls(), []);
  assert.equal(laneEvents().filter((e) => e === 's4_push_held').length, 1);
  // the card cannot approve a submit whose checks block it
  const refused = await approve();
  assert.equal(refused.ok, false);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

test('a submit whose required check fails on the same failures at the public base is not held, and the approval keeps it on the ledger', async () => {
  const f = setup();
  const areas = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  areas.repos.demo.checks = [{ name: 'suite', command: 'echo "FAIL old"; exit 1', required: true, failure_id_pattern: '^FAIL (.+)$' }];
  writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify(areas));
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const r1 = await submitPush();
  assert.deepEqual(r1.held, [], JSON.stringify(r1));
  assert.deepEqual(r1.ready, ['IDD-1'], JSON.stringify(r1));
  const row = readProposal('IDD-1').checks.find((c) => c.name === 'suite');
  assert.equal(row.baseline.verdict, 'preexisting', JSON.stringify(row));
  assert.equal(laneEvents().includes('s4_push_held'), false);
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  const approved = readLifecycle().filter((e) => e.event === 's4_push_approved').pop();
  assert.deepEqual(approved.attrs.failing_at_base, [{ check: 'suite', base: row.baseline.commit, failures: ['old'] }]);
  assert.equal(gh.prs().length, 1);
});

test('a card sent back after its push can be submitted again, and the next push goes to its PR on the approval', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'first\n', 'feat: first');
  await pushApproved();
  await startSubmit(f, 'fixed\n', 'fix: fixed');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal((await approve()).ok, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'fixed');
  assert.equal(creates(gh).length, 1);
});

test('a lane with a PR proposes a body update at any time, as a card against the PR text as it is now', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await appendLifecycle('s4_pr_created', 'IDD-1', { pr_url: 'https://github.com/test/project/pull/3', pr_number: 3, commit: 'x' });
  const materials = [];
  const revises = [];
  const queued = [];
  setAgentRunner({
    deliver: async () => {},
    prText: (repo, pr) => { assert.deepEqual([repo, pr], ['test/project', 3]); return { title: 'feat: 今の題', body: '今の本文\n' }; },
    draftPrText: async ({ material, revise }) => { materials.push(material); revises.push(revise); return { title: 'feat: 今の題', body: '直した本文\n', model: 'm' }; },
    queueOutbound: async (o) => { queued.push(o); return { id: 'OUT-1' }; },
  });
  const { proposePrBodyUpdate } = await import('../src/plan/pr-body.ts');
  const r = await proposePrBodyUpdate('IDD-1');
  assert.deepEqual(r, { ok: true, outboundId: 'OUT-1', drafted: true });
  assert.match(materials[0], /今の本文/);
  assert.deepEqual(revises, [true], 'a rewrite of the body that is up is asked as a revision: the new-draft checks do not apply');
  assert.deepEqual(queued, [{ kind: 'gh-pr-body', target: { repo: 'test/project', pr: 3, baseTitle: 'feat: 今の題', baseBody: '今の本文\n' }, title: 'feat: 今の題', body: '直した本文\n', source: 'IDD-1' }]);
  assert.ok(laneEvents().includes('s4_pr_body_proposed'));
  // the lane is still waiting on its PR
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  setAgentRunner(null);
});

test('a body update keeps the line that closes the Issue, whether the drafter or penne\'s text had it', async () => {
  const f = setup();
  fakeGh(f.root);
  put(join(f.state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', gh_issue_url: 'https://github.com/test/project/issues/7' }) + '\n');
  await startSubmit(f, 'ours\n', 'feat: ours');
  await appendLifecycle('s4_pr_created', 'IDD-1', { pr_url: 'https://github.com/test/project/pull/3', pr_number: 3, commit: 'x' });
  const queued = [];
  const runner = (now, drafted) => setAgentRunner({
    deliver: async () => {},
    prText: () => ({ title: 'feat: 今の題', body: now }),
    ...(drafted === undefined ? {} : { draftPrText: async () => ({ title: 'feat: 今の題', body: drafted, model: 'm' }) }),
    queueOutbound: async (o) => { queued.push(o); return { id: 'OUT-1' }; },
  });
  const { proposePrBodyUpdate } = await import('../src/plan/pr-body.ts');
  const sections = '## Summary\n\n直した\n\n## Test plan\n\n読んだ';
  // the drafter leaves the line out
  runner('今の本文\n', sections);
  assert.equal((await proposePrBodyUpdate('IDD-1')).ok, true);
  assert.equal(queued.at(-1).body, `Closes https://github.com/test/project/issues/7\n\n${sections}`);
  // no drafter, and the body on GitHub has lost the line: the card starts from the text with it
  runner('今の本文\n');
  assert.equal((await proposePrBodyUpdate('IDD-1')).ok, true);
  assert.equal(queued.at(-1).body, 'Closes https://github.com/test/project/issues/7\n\n今の本文');
  // a body that already closes the Issue is not doubled or reflowed
  runner('Closes #7\n\n今の本文\n', 'Closes #7\n\n直した本文\n');
  assert.equal((await proposePrBodyUpdate('IDD-1')).ok, true);
  assert.equal(queued.at(-1).body, 'Closes #7\n\n直した本文\n');
  runner('Closes #7\n\n今の本文\n');
  assert.equal((await proposePrBodyUpdate('IDD-1')).ok, true);
  assert.equal(queued.at(-1).body, 'Closes #7\n\n今の本文\n');
  setAgentRunner(null);
});

test('a merged PR of a lane with a GitHub Issue closes the lane without propter writing to the Issue', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  put(join(f.state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'demo', title: 'feat: change', gh_issue_url: 'https://github.com/test/project/issues/7' }) + '\n');
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'ff');
  const queued = [];
  setAgentRunner({ deliver: async () => {}, queueOutbound: async (o) => { queued.push(o); return { id: 'OUT-1' }; } });
  const { runClose } = await import('../src/plan/close.ts');
  await runClose();
  assert.ok(laneEvents().includes('s4_merged'));
  assert.deepEqual(queued, [], 'no card to close the Issue is queued after the merge');
  assert.deepEqual(gh.calls().filter((a) => a[0] === 'issue'), [], 'no gh issue call is made');
  setAgentRunner(null);
});

test('a lane without a PR has no body to update', async () => {
  setup();
  setAgentRunner({ deliver: async () => {}, prText: () => ({ title: '', body: '' }), queueOutbound: async () => ({ id: 'OUT-1' }) });
  const { proposePrBodyUpdate } = await import('../src/plan/pr-body.ts');
  const r = await proposePrBodyUpdate('IDD-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /PR がありません/);
  setAgentRunner(null);
});

test('a request from outside the card does not move a lane to the submit', async () => {
  const f = setup();
  fakeGh(f.root);
  put(join(f.lane.path, 'app.txt'), 'ours\n'); commit(f.lane.path, 'feat: ours');
  await seedLifecycle('s2_start', 'IDD-1', {});
  const r = await prepareSubmit('IDD-1', { title: 'feat: 題', body: '本文' }, { start: false });
  assert.match(r.error ?? '', /提出前確認の段にない/);
  assert.ok(!laneEvents().includes('s4_submit_started'));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

const RETRYABLE_REASON = '記録の検査（scripts/check-docs.sh）が通らないので commit していません';
const OLD_GAVE_UP = 'R2 の結果から 30 分たっても記録を commit できないので、記録せずに進めます（最後の理由: repo の overlay の lock が取られているので commit していません）';
async function r2Round(record) {
  await appendLifecycle('s3_ready', 'IDD-1', {});
  await appendLifecycle('s3_r2_started', 'IDD-1', { run_id: 'R2-1' });
  await appendLifecycle('s3_r2_done', 'IDD-1', record === 'failed' ? { run_id: 'R2-1', failed: true, error: 'boom' } : { run_id: 'R2-1', must: 0, should: 0, nit: 0, findings: [] });
  if (record && record !== 'failed') await appendLifecycle(record.event, 'IDD-1', { run_id: 'R2-1', ...record.attrs });
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
}

// R2 was removed (2026-10-22): a lane's past R2 events are still read, and none of them holds the push any more
for (const [name, record] of [
  ['R2 was skipped', null],
  ['R2 failed', 'failed'],
  ['the record cannot go in whatever is fixed', { event: 's3_r2_not_recorded', attrs: { reason: 'lane の差分に `R2: PENDING（Issue lane の S3 で実施）` の qa がありません' } }],
  ['the record stopped for a cause that could be fixed', { event: 's3_r2_not_recorded', attrs: { reason: RETRYABLE_REASON } }],
  ['the tick gave up on the record in the old wording, without gave_up', { event: 's3_r2_not_recorded', attrs: { reason: OLD_GAVE_UP } }],
]) {
  test(`a push is got ready and approved when ${name}`, async () => {
    const f = setup();
    fakeGh(f.root);
    put(join(f.lane.path, 'app.txt'), 'ours\n'); commit(f.lane.path, 'feat: ours');
    if (record === null) {
      await appendLifecycle('s3_ready', 'IDD-1', {});
      await appendLifecycle('s3_r2_skipped', 'IDD-1', { reason: 'pipeline.r2 が未宣言' });
      await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
      await seedLifecycle('s4_submit_started', 'IDD-1', {});
    } else await r2Round(record);
    const { tick } = await pushApproved();
    assert.deepEqual(tick.ready, ['IDD-1'], JSON.stringify(tick));
    assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'ours');
  });
}

// --- blind review round 1 ---

test('checking again a submit that was pushed and waits for its PR keeps it pushed, and the PR can still be made', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  const pushed = readProposal('IDD-1');
  // the CLI's propose, and the card's check, on the same head
  const cli = await prepareSubmit('IDD-1', { title: 'feat: 別の題', body: '別の本文' });
  assert.ok(!cli.error, cli.error);
  const card = await prepareSubmit('IDD-1', { title: 'feat: 別の題', body: '別の本文' }, { start: false });
  assert.ok(!card.error, card.error);
  const now = readProposal('IDD-1');
  assert.equal(now.status, 'pushed');
  assert.equal(now.mode, 'publish');
  assert.equal(now.token, pushed.token);
  const r = await approveShip(now.token, { pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(creates(gh).length, 2, 'the refused one and the one made now');
  assert.equal(gh.prs().length, 1);
  assert.ok(!laneEvents().includes('lane_close'));
});

test('a lane pushed before its PR and sent back with a fix only in the records still gets its PR, not a local completion', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  const tip = git(f.remote, 'rev-parse', f.lane.branch);
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.held, [], JSON.stringify(r));
  const p = readProposal('IDD-1');
  assert.equal(p.mode, 'publish');
  assert.equal(p.status, 'pushed');
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), tip, 'nothing new to push');
  const done = await approveShip(p.token, { pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(done.ok, true, done.error);
  assert.equal(gh.prs().length, 1);
  assert.ok(!laneEvents().includes('lane_close'));
});

test('a pushed branch with nothing new to publish is still read against the practice: the card says the titles were read, or that they could not be', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  // the repo declares a commit form after the push, and the lane is sent back with a fix only in the records
  const repos = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  repos.repos.demo.commit_convention = { types: ['feat', 'fix'], source: 'RULES.md' };
  writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify(repos));
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  // the fake gh answers the open PRs; a gh that also answers the merged ones stands in front of it
  const fakeList = join(f.root, 'gh', 'merged.json');
  writeFileSync(fakeList, JSON.stringify([{ title: 'Summary', author: { is_bot: false }, mergedAt: '2026-10-01T00:00:00Z' }]));
  const real = process.env.IDD_GH_BIN;
  process.env.IDD_GH_BIN = mergedGh(fakeList, real);
  try {
    await submitPush();
    const p = readProposal('IDD-1');
    assert.equal(p.mode, 'publish');
    assert.deepEqual(p.publish, [], 'nothing new to publish');
    assert.deepEqual(p.mergedTitles, ['Summary']);
    assert.ok(buildSubmit('IDD-1').checks.some((c) => /merge された PR/.test(c.label) && !c.ok), 'the title apart from the form is a line');
  } finally { process.env.IDD_GH_BIN = real; }
});

test('a PR-only approval whose text changed after the signature makes no PR', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  const p = readProposal('IDD-1');
  // pushedWithoutPr's own failed `pr create` is in the log, and its push approval and failed PR are in the
  // events: count from here, so only what this tampered approval adds is seen
  const before = creates(gh).length;
  const counts = (name) => laneEvents().filter((e) => e === name).length;
  const had = Object.fromEntries(['s4_push_approved', 's4_r2_overridden', 's4_ship_failed'].map((n) => [n, counts(n)]));
  // the signature is over this PR text; the head check is the signature's only, so the PR's gate is what compares
  const signed = shipApproved('IDD-1', { pr: { title: 'feat: 題', body: '本文' } });
  const r = await runShip('IDD-1', p.token, { pr: { title: 'feat: 別の題', body: '本文' }, nonce: signed.nonce });
  assert.equal(r.ok, false);
  assert.match(r.error, /中身/);
  assert.equal(creates(gh).length, before, 'no PR was made from text penne did not sign');
  assert.equal(readProposal('IDD-1').status, 'pushed');
  // a signature refusal is not a failed push: this approval added no record of one
  for (const event of ['s4_push_approved', 's4_r2_overridden', 's4_ship_failed']) assert.equal(counts(event), had[event], event);
});

test('a publishing submit with no approval at all is refused with no record of a failure', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const p = await propose('IDD-1', { title: 'feat: 下書きの題', body: '本文' });
  assert.ok(!p.error, p.error);
  // the way a bare POST with { iddId, token } arrives: no signature and no fields
  const r = await runShip('IDD-1', p.token);
  assert.equal(r.ok, false);
  assert.match(r.error, /署名/);
  for (const event of ['s4_push_approved', 's4_r2_overridden', 's4_ship_failed']) assert.equal(laneEvents().includes(event), false, event);
  assert.deepEqual(creates(gh), []);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  assert.equal(readProposal('IDD-1').status, 'prepared');
});

test('a lane whose branch was pushed, with no PR and no merge, is not completed locally', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  // an old record that says local
  const p = readProposal('IDD-1'); p.mode = 'local'; p.status = 'prepared'; writeFileSync(proposalPath('IDD-1'), JSON.stringify(p));
  const r = await approveShip(p.token);
  assert.equal(r.ok, false);
  assert.match(r.error, /PR/);
  assert.ok(!laneEvents().includes('lane_close'));
});

test('a resubmit whose PR was closed is pushed on its approval and waits at the card for a new PR, and the tick does not try it again on every pass', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'first\n', 'feat: first');
  await pushApproved();
  const prs = gh.prs(); prs[0].state = 'CLOSED'; writeFileSync(join(f.root, 'gh', 'prs.json'), JSON.stringify(prs));
  await startSubmit(f, 'second\n', 'fix: second');
  const r1 = await submitPush();
  assert.deepEqual(r1.ready, ['IDD-1'], JSON.stringify(r1));
  // the card shows a push to the lane's PR: approved with the commit message only, and no PR is made from text penne did not see
  const pushed = await approve();
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(pushed.noOpenPr, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'second');
  assert.equal(creates(gh).length, 1);
  const r2 = await submitPush();
  assert.deepEqual([r2.ready, r2.recorded, r2.held], [[], [], []], JSON.stringify(r2));
  assert.equal(deriveStage(readLifecycle()).decision, 'ship');
  const view = buildSubmit('IDD-1');
  assert.ok(view.pushed);
  const r = await approveShip(view.proposal.token, { pr: { title: 'feat: 新しい題', body: '新しい本文' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(creates(gh).length, 2);
});

test('a submit pushed before its PR counts as pushed only while the lane is at the head it pushed', async () => {
  const f = setup();
  fakeGh(f.root);
  const { submitPushed } = await import('../src/plan/submit-prep.ts');
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  assert.equal(submitPushed('IDD-1'), 'yes');
  put(join(f.lane.path, 'app.txt'), 'fixed\n'); commit(f.lane.path, 'fix: fixed');
  assert.equal(submitPushed('IDD-1'), 'no');
});

test('the CLI propose checks a lane without moving it to the submit unless asked with --start', async () => {
  const f = setup();
  fakeGh(f.root);
  put(join(f.lane.path, 'app.txt'), 'ours\n'); commit(f.lane.path, 'feat: ours');
  // a lane past S3 whose submit card is not up yet: only the submit's start may move it on
  for (const e of ['s2_start', 's2_result', 's3_ready', 's3_ok']) await seedLifecycle(e, 'IDD-1', {});
  const cli = (...args) => { try { return { status: 0, out: execFileSync(process.execPath, ['--experimental-strip-types', join(original, 'packages/idd-cli/bin/idd.ts'), 'propose', ...args], { cwd: f.work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IDD_LANE_SCOPE: 'off', IDD_NO_TICK_KICK: '1' } }) }; } catch (e) { return { status: e.status, out: String(e.stdout) }; } };
  const plain = cli('IDD-1');
  assert.notEqual(plain.status, 0);
  assert.ok(!laneEvents().includes('s4_submit_started'));
  const started = cli('IDD-1', '--start');
  assert.equal(started.status, 0, started.out);
  assert.ok(laneEvents().includes('s4_submit_started'));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'the CLI never pushes');
});


// --- blind review round 2 ---

/** a lane whose PR #1 is open after its first submit */
async function laneWithOpenPr(f, gh) {
  await startSubmit(f, 'first\n', 'feat: first');
  await pushApproved();
  assert.equal(creates(gh).length, 1);
}

/** a push penne approved that reached GitHub while the record kept `prepared` and the old custody (an error after the push, or a restart) */
async function pushWithoutSave(iddId) {
  const before = readFileSync(custodyPath(iddId), 'utf8');
  const p = await propose(iddId, { title: 'fix: 題', body: '本文' });
  assert.ok(!p.error, p.error);
  const e = exportLane(iddId, p.token, pushApproval(iddId, { message: 'fix: 承認した commit' }));
  assert.equal(e.ok, true, e.error);
  const rec = readProposal(iddId); rec.status = 'prepared'; writeFileSync(proposalPath(iddId), JSON.stringify(rec));
  writeFileSync(custodyPath(iddId), before);
  return e.commit;
}

test('a push that reached GitHub but was not saved is put on record by the tick even after it was held, with no new push, and the lane waits on its PR again', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  const commitOut = await pushWithoutSave('IDD-1');
  await appendLifecycle('s4_push_held', 'IDD-1', { head: git(f.lane.path, 'rev-parse', 'HEAD'), reason: 'push に失敗: network' });
  const r = await submitPush();
  assert.deepEqual(r.recorded, ['IDD-1'], JSON.stringify(r));
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), commitOut);
  assert.equal(JSON.parse(readFileSync(custodyPath('IDD-1'), 'utf8')).publicTip, commitOut);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.deepEqual(edits(gh), []);
});

test('the card\'s check puts on record a push that reached GitHub but was not saved, instead of stopping at the moved branch', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  await pushWithoutSave('IDD-1');
  const view = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!view.error, view.error);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.equal(creates(gh).length, 1);
});

test('a resubmit of a lane whose PR is open, with a fix only in the records, is recorded on that PR without a push or an approval, and waits on it, not completed locally', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  const tip = git(f.remote, 'rev-parse', f.lane.branch);
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.recorded, ['IDD-1'], JSON.stringify(r));
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), tip);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.ok(!laneEvents().includes('lane_close'));
  assert.deepEqual(edits(gh), []);
  assert.equal(creates(gh).length, 1);
});

test('N2: a branch that already carries the checked tree is recorded without an approval only because its public checks do not run, so no failure at the public base lets it through', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  // a required check that fails at the head and the public base alike, by the same failure
  const areas = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  areas.repos.demo.checks = [{ name: 'suite', command: 'echo "FAIL old"; exit 1', required: true, failure_id_pattern: '^FAIL (.+)$' }];
  writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify(areas));
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.recorded, ['IDD-1'], JSON.stringify(r));
  // the public side changes nothing, so the check is not applicable there: it is not compared, and nothing it found is let through
  const row = readProposal('IDD-1').checks.find((c) => c.name === 'suite');
  assert.equal(row.status, 'not-applicable', JSON.stringify(row));
  assert.equal(row.baseline, undefined);
});

test('a resubmit of a lane whose PR was closed, with a fix only in the records, waits for a new PR; it is not completed locally', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  const prs = gh.prs(); prs[0].state = 'CLOSED'; writeFileSync(join(f.root, 'gh', 'prs.json'), JSON.stringify(prs));
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  await submitPush();
  assert.equal(readProposal('IDD-1').mode, 'publish');
  assert.equal(deriveStage(readLifecycle()).decision, 'ship');
  const r = await approveShip(readProposal('IDD-1').token, { pr: { title: 'feat: 新しい題', body: '本文' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(creates(gh).length, 2);
});

test('a lane whose PR is open is not completed locally, whatever an old record says', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const p = await propose('IDD-1', { title: 't', body: 'b' });
  assert.ok(!p.error, p.error);
  const rec = readProposal('IDD-1'); rec.mode = 'local'; writeFileSync(proposalPath('IDD-1'), JSON.stringify(rec));
  const r = await approveShip(rec.token);
  assert.equal(r.ok, false);
  assert.match(r.error, /PR/);
  assert.ok(!laneEvents().includes('lane_close'));
});

test('a pushed submit shows as pushed only while the lane is at the head it pushed, and a newer head is checked by the tick and pushed on its approval', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'first\n', 'feat: first');
  await pushedWithoutPr(f);
  assert.ok(buildSubmit('IDD-1').pushed);
  put(join(f.lane.path, 'app.txt'), 'moved\n'); commit(f.lane.path, 'fix: moved');
  assert.equal(buildSubmit('IDD-1').pushed, undefined);
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'first');
  assert.equal((await approve()).ok, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'moved');
});


// --- blind review round 3 ---

const prsFile = (f) => join(f.root, 'gh', 'prs.json');
function setPr(f, gh, change) { const prs = gh.prs(); Object.assign(prs[0], change); writeFileSync(prsFile(f), JSON.stringify(prs)); }

/** someone merges PR #1 on GitHub: at the branch's tip, with the public base moved to it (a fast-forward), or past it (a squash while the base had moved on) */
function mergePr(f, gh, how = 'ff') {
  const tip = git(f.remote, 'rev-parse', f.lane.branch);
  if (how === 'ff') git(f.remote, 'update-ref', 'refs/heads/main', tip);
  else {
    git(f.upstream, 'fetch', 'origin');
    git(f.upstream, 'checkout', '-q', 'main'); git(f.upstream, 'reset', '-q', '--hard', 'origin/main');
    put(join(f.upstream, 'other.txt'), 'someone else\n'); commit(f.upstream, 'feat: other');
    git(f.upstream, 'checkout', `origin/${f.lane.branch}`, '--', 'app.txt'); commit(f.upstream, 'feat: first (#1)');
    git(f.upstream, 'push', 'origin', 'main');
  }
  setPr(f, gh, { state: 'MERGED', headRefOid: tip, mergedAt: '2026-09-26T00:00:00Z', mergedBy: { login: 'penne' } });
}

test('a lane whose PR was merged (fast-forward) while it fixed only its records is recorded as merged and goes to the reclaim, not left at the card', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'ff');
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.held, [], JSON.stringify(r));
  assert.ok(laneEvents().includes('s4_merged'));
  const d = deriveStage(readLifecycle());
  assert.equal(d.group, 'waiting');
  assert.equal(d.stageDone, 5);
  const { lanesAwaitingMerge } = await import('../src/plan/close.ts');
  assert.deepEqual(lanesAwaitingMerge().map((l) => l.rec.idd_id), ['IDD-1']);
  assert.equal(creates(gh).length, 1);
});

test('local completion of a lane whose PR was merged is not refused as a push without a PR: the lane goes on as a merged one', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'ff');
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const p = await propose('IDD-1', { title: 't', body: 'b' });
  assert.ok(!p.error, p.error);
  assert.equal(p.mode, 'local');
  const r = await approveShip(p.token);
  assert.equal(r.ok, true, r.error);
  assert.ok(laneEvents().includes('s4_merged'));
  // closed by the merge observation after the import, with the records reclaimed (runClose), as any merged lane
  const d = deriveStage(readLifecycle());
  assert.deepEqual([d.group, d.stageDone], ['waiting', 5]);
  const { lanesAwaitingMerge } = await import('../src/plan/close.ts');
  assert.deepEqual(lanesAwaitingMerge().map((l) => l.rec.idd_id), ['IDD-1']);
  assert.equal(creates(gh).length, 1);
});

test('a lane whose PR was squash-merged past a moved base, with a fix only in the records, gets no second PR from the merged branch', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'squash');
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  // the card's check, before the tick sees it: nothing to push, so the merge is found at once
  const view = await prepareSubmit('IDD-1', { title: 'feat: 題', body: '本文' }, { start: false });
  assert.ok(!view.error, view.error);
  assert.ok(laneEvents().includes('s4_merged'));
  assert.ok(!laneEvents().includes('s4_push_held'));
  const r = await approveShip(view.token, { pr: { title: 'feat: 新しい題', body: '本文' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(creates(gh).length, 1, 'no PR from the merged branch');
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('the tick finds the squash-merged PR of a lane that fixed only its records, and holds nothing', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'squash');
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'records only\n'); commit(f.lane.path, 'docs: records only');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.held, [], JSON.stringify(r));
  assert.ok(laneEvents().includes('s4_merged'));
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.equal(creates(gh).length, 1);
});

test('a lane whose PR was merged before a new public fix is not taken as merged: the fix is pushed on its approval and waits for a new PR, with the merge named', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'ff');
  await startSubmit(f, 'after merge\n', 'fix: after merge');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.ok(!laneEvents().includes('s4_merged'));
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  assert.equal(done.noOpenPr, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'after merge');
  const held = readLifecycle().filter((e) => e.event === 's4_push_held').pop();
  assert.match(held.attrs.reason, /merge 済み/);
  assert.equal(deriveStage(readLifecycle()).decision, 'ship');
  assert.equal(creates(gh).length, 1);
});

/** a lane that went through the S2 loop and S3, was pushed, and has PR #1 open */
async function loopLaneWithOpenPr(f, gh) {
  for (const e of ['s2_start', 's2_result', 's2_review_converged', 's2_device_skipped', 's3_ready']) await seedLifecycle(e, 'IDD-1', {});
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  await laneWithOpenPr(f, gh);
}

test('after the fix of the PR feedback converges, nothing is got ready or pushed before S3 runs again', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await loopLaneWithOpenPr(f, gh);
  const tip = git(f.remote, 'rev-parse', f.lane.branch);
  await appendLifecycle('s4_review_comment_received', 'IDD-1', { items: [], files: [] });
  await appendLifecycle('s2_fix_sent', 'IDD-1', { round: 1 });
  put(join(f.lane.path, 'app.txt'), 'fixed\n'); commit(f.lane.path, 'fix: feedback');
  for (const e of ['s2_result', 's2_review_converged', 's2_device_skipped']) await appendLifecycle(e, 'IDD-1', {});
  assert.notEqual(deriveStage(readLifecycle()).decision, 'ship');
  const r = await submitPush();
  assert.deepEqual([r.ready, r.held], [[], []], JSON.stringify(r));
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), tip, 'nothing pushed');
  // the inbox's check does not take it either
  const card = await prepareSubmit('IDD-1', { title: 'feat: 題', body: '本文' }, { start: false });
  assert.match(card.error ?? '', /提出前確認の段にない/);
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), tip);
  // S3 again: the submit opens anew, the tick gets it ready, and the approval pushes the fix to the PR
  await appendLifecycle('s3_ready', 'IDD-1', {});
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  const { startSubmit } = await import('../src/plan/ship.ts');
  assert.ok(await startSubmit('IDD-1'));
  assert.equal(laneEvents().filter((e) => e === 's4_submit_started').length, 2);
  const again = await submitPush();
  assert.deepEqual(again.ready, ['IDD-1'], JSON.stringify(again));
  assert.equal((await approve()).ok, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'fixed');
});

test('a submit already pushed at the lane\'s head whose past R2 record stopped is not held: its PR can be made', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  put(join(f.lane.path, 'app.txt'), 'ours\n'); commit(f.lane.path, 'feat: ours');
  await r2Round({ event: 's3_r2_not_recorded', attrs: { reason: RETRYABLE_REASON } });
  // pushed before the hold existed
  const p = await propose('IDD-1', { title: 'feat: 題', body: '本文' });
  assert.ok(!p.error, p.error);
  assert.equal(approveExport(p.token, { message: 'feat: 題' }).ok, true);
  assert.equal(readProposal('IDD-1').status, 'pushed');
  assert.equal('r2Hold' in buildSubmit('IDD-1'), false);
  const r = await approveShip(p.token, { pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(creates(gh).length, 1);
});

/** every lifecycle record moved an hour back, as if the tick came again much later */
function backdate(state) {
  for (const name of readdirSync(state).filter((n) => n.startsWith('lifecycle-') && n.endsWith('.jsonl'))) {
    const path = join(state, name);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); r.at = new Date(Date.parse(r.at) - 3600_000).toISOString(); return JSON.stringify(r); });
    writeFileSync(path, lines.join('\n') + '\n');
  }
}

test('a PR check after the approved push that fails for good is held once with its reason, not tried again every ten minutes', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  // the PR's base was changed on GitHub
  setPr(f, gh, { baseRefName: 'develop' });
  await startSubmit(f, 'second\n', 'fix: second');
  // the approval pushes, and the PR check after it fails
  await submitPush();
  const card = await approve();
  assert.match(card.error ?? '', /base/);
  assert.equal(readProposal('IDD-1').status, 'pushed');
  const lists = () => gh.calls().filter((a) => a[0] === 'pr' && a[1] === 'list').length;
  backdate(f.state);
  await submitPush();
  const after = lists();
  backdate(f.state);
  await submitPush();
  backdate(f.state);
  await submitPush();
  assert.equal(lists(), after, 'not tried again');
  const holds = readLifecycle().filter((e) => e.event === 's4_push_held');
  assert.equal(holds.length, 1);
  assert.match(holds[0].attrs.reason, /base/);
  const view = buildSubmit('IDD-1');
  assert.ok(view.pushed);
  assert.match(view.pushHeld ?? '', /base/);
});


// --- blind review round 4 ---

/** GitHub fails for a passing cause (the network) on `gh pr list` while this is on */
function failList(f, on) {
  const flag = join(f.root, 'gh', 'fail-list');
  if (on) writeFileSync(flag, '');
  else rmSync(flag, { force: true });
}

test('a PR check that fails for a passing cause right after the approved push is tried again ten minutes later by the tick, with no new push, and the lane goes back to waiting on its PR', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  await submitPush();
  failList(f, true);
  const approved = await approve();
  assert.equal(approved.ok, false);
  assert.match(approved.error ?? '', /connection reset/);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'second', 'the push went out');
  const names = laneEvents();
  assert.ok(names.lastIndexOf('s4_push_held') < names.lastIndexOf('s4_pushed'), 'nothing held after the push');
  const view = buildSubmit('IDD-1');
  assert.ok(view.pushed);
  assert.equal(view.pushHeld, undefined);
  assert.match(view.prCheckFailed ?? '', /connection reset/);
  failList(f, false);
  // within ten minutes GitHub is not asked again
  const lists = () => gh.calls().filter((a) => a[0] === 'pr' && a[1] === 'list').length;
  const before = lists();
  await submitPush();
  assert.equal(lists(), before);
  backdate(f.state);
  const tip = git(f.remote, 'rev-parse', f.lane.branch);
  const r2 = await submitPush();
  assert.deepEqual(r2.recorded, ['IDD-1'], JSON.stringify(r2));
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), tip, 'no new push');
  const created = readLifecycle().filter((e) => e.event === 's4_pr_created').pop();
  assert.equal(created.attrs.commit, tip);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.deepEqual(edits(gh), []);
});

test('a hold recorded after the push for a passing failure (by an earlier tick) does not stop the retry, and the card does not call it a failed push', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  await submitPush();
  failList(f, true);
  await approve();
  failList(f, false);
  await appendLifecycle('s4_push_held', 'IDD-1', { head: git(f.lane.path, 'rev-parse', 'HEAD'), reason: 'push に失敗: connection reset by peer' });
  const view = buildSubmit('IDD-1');
  assert.ok(view.pushed);
  assert.doesNotMatch(view.pushHeld ?? '', /push に失敗/);
  backdate(f.state);
  const r = await submitPush();
  assert.deepEqual(r.recorded, ['IDD-1'], JSON.stringify(r));
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

/** the public clone's upload-pack, counted: ls-remote and fetch against its remote go through it */
function watchRemote(f) {
  const log = join(f.root, 'upload-pack.log');
  const bin = join(f.root, 'upload-pack');
  put(bin, `#!/bin/sh\necho x >> ${JSON.stringify(log)}\nexec git upload-pack "$@"\n`); chmodSync(bin, 0o755);
  git(f.upstream, 'config', 'remote.origin.uploadpack', bin);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
}

test('building the card does not ask the remote whether a prepared submit reached it: it reads what the tick recorded', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  put(join(f.lane.path, 'app.txt'), 'second\n'); commit(f.lane.path, 'fix: second');
  await r2Round({ event: 's3_r2_not_recorded', attrs: { reason: RETRYABLE_REASON } });
  await pushWithoutSave('IDD-1');
  const asked = watchRemote(f);
  buildSubmit('IDD-1');
  assert.equal(asked(), 0, 'no ls-remote while the card is built');
  // the tick finds the push and records it; its follow-up waits for the public clone's lock
  const release = lock(f.upstream);
  try {
    await submitPush();
  } finally {
    release();
  }
  assert.equal(readProposal('IDD-1').status, 'prepared');
  assert.ok(laneEvents().includes('s4_push_unsaved'));
  const before = asked();
  const view = buildSubmit('IDD-1');
  assert.equal(asked(), before, 'no ls-remote while the card is built');
  assert.equal(view.pushHeld, undefined, 'a push on record holds nothing');
});

/** S3 on the lane's current head as a lane from before R2 was removed ran it (R2 looked at `seen`), with the R2 result recorded as a commit of the records only */
async function reviewedRound(f, { r2 = true } = {}) {
  const seen = git(f.lane.path, 'rev-parse', 'HEAD');
  await appendLifecycle('s3_ready', 'IDD-1', {});
  if (r2) {
    await appendLifecycle('s3_r2_started', 'IDD-1', { run_id: 'R2-1', base: 'unused', head: seen });
    await appendLifecycle('s3_r2_done', 'IDD-1', { run_id: 'R2-1', must: 0, should: 0, nit: 0, findings: [] });
    put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'R2 の結果\n'); commit(f.lane.path, 'docs: R2 の結果を記録');
    await appendLifecycle('s3_r2_recorded', 'IDD-1', { run_id: 'R2-1', files: ['_docs/qa/demo/x/qa.md'], commit: git(f.lane.path, 'rev-parse', 'HEAD') });
  } else await appendLifecycle('s3_r2_skipped', 'IDD-1', { reason: 'pipeline.r2 が未宣言' });
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  return seen;
}

test('the tick does not get a public change made after a past R2 without a stage of its own ready, and says why once', async () => {
  const f = setup();
  fakeGh(f.root);
  const { startSubmit } = await import('../src/plan/ship.ts');
  put(join(f.lane.path, 'app.txt'), 'reviewed\n'); commit(f.lane.path, 'feat: reviewed');
  const seen = await reviewedRound(f);
  // the executor goes on after R2, with no event that moves the stage
  put(join(f.lane.path, 'app.txt'), 'unreviewed\n'); commit(f.lane.path, 'fix: after R2');
  assert.ok(await startSubmit('IDD-1'));
  const r = await submitPush();
  assert.deepEqual([r.ready, r.held], [[], ['IDD-1']], JSON.stringify(r));
  assert.equal(readProposal('IDD-1'), null, 'not checked');
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing pushed');
  const held = readLifecycle().filter((e) => e.event === 's4_push_held').pop();
  assert.ok(held.attrs.reason.includes(seen.slice(0, 7)), held.attrs.reason);
  assert.match(buildSubmit('IDD-1').pushHeld ?? '', /レビューを経ていない/);
  assert.deepEqual((await submitPush()).held, [], 'held once for the head');
  // penne looks at the diff, checks it from the card, and the reason stays on the card next to the approval
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.match(buildSubmit('IDD-1').pushHeld ?? '', /レビューを経ていない/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

test('a commit of the records only after a past R2 (its own record) is got ready by the tick', async () => {
  const f = setup();
  fakeGh(f.root);
  const { startSubmit } = await import('../src/plan/ship.ts');
  put(join(f.lane.path, 'app.txt'), 'reviewed\n'); commit(f.lane.path, 'feat: reviewed');
  await reviewedRound(f);
  put(join(f.lane.path, '_docs/qa/demo/x/qa.md'), 'R2 の結果（追記）\n'); commit(f.lane.path, 'docs: 追記');
  assert.ok(await startSubmit('IDD-1'));
  const { tick } = await pushApproved();
  assert.deepEqual(tick.ready, ['IDD-1'], JSON.stringify(tick));
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'reviewed');
});

test('without an R2 in this S3, the tick compares with the head the submit was opened at', async () => {
  const f = setup();
  fakeGh(f.root);
  const { startSubmit } = await import('../src/plan/ship.ts');
  put(join(f.lane.path, 'app.txt'), 'reviewed\n'); commit(f.lane.path, 'feat: reviewed');
  const seen = await reviewedRound(f, { r2: false });
  assert.ok(await startSubmit('IDD-1'));
  assert.equal(readLifecycle().filter((e) => e.event === 's4_submit_started').pop().attrs.head, seen);
  put(join(f.lane.path, 'app.txt'), 'unreviewed\n'); commit(f.lane.path, 'fix: after the submit opened');
  const r = await submitPush();
  assert.deepEqual([r.ready, r.held], [[], ['IDD-1']], JSON.stringify(r));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});


// --- blind review round 5 ---

/** the area's settings change after the push (the same Git destination) */
function changeConfig(change) {
  const areas = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, 'utf8'));
  Object.assign(areas.repos.demo, change);
  writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify(areas));
}

test('a submit pushed and waiting for its PR whose settings changed since is not a dead end: the card says why, checks it again, and the PR can be made', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  const old = buildSubmit('IDD-1').proposal;
  assert.equal(old.status, 'pushed');
  changeConfig({ public_vocabulary_allow: ['lane'] });
  // the old record cannot make the PR any more
  assert.equal((await approveShip(old.token, { pr: { title: 'feat: 題', body: '本文' } })).ok, false);
  const view = buildSubmit('IDD-1');
  assert.ok(view.pushed);
  assert.match(view.recheck ?? '', /設定/, 'the card says why and offers the check again');
  // the card's check does not hand back the old record: it checks under the settings as they are now
  const card = await prepareSubmit('IDD-1', { title: 'feat: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.notEqual(card.token, old.token);
  assert.equal(buildSubmit('IDD-1').recheck, undefined);
  const r = await approveShip(card.token, { pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(gh.prs().length, 1);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('a lane with an open PR whose settings changed between the push and the PR check is held once, and the card\'s check records the push on its PR', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  await submitPush();
  failList(f, true);
  await approve();
  assert.equal(readProposal('IDD-1').status, 'pushed');
  failList(f, false);
  changeConfig({ public_vocabulary_allow: ['lane'] });
  backdate(f.state);
  const r = await submitPush();
  assert.deepEqual(r.held, ['IDD-1'], JSON.stringify(r));
  assert.match(buildSubmit('IDD-1').recheck ?? '', /設定/);
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.equal(creates(gh).length, 1);
  assert.equal(readLifecycle().filter((e) => e.event === 's4_pr_created').pop().attrs.commit, git(f.remote, 'rev-parse', f.lane.branch));
});

test('a lane whose PR was merged and its branch deleted, with a new public fix, is pushed on its approval with a new PR, not sent to a receive', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'squash');
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.lane.branch}`);
  await startSubmit(f, 'after merge\n', 'fix: after merge');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'not before the approval');
  // the card does not show a push to the merged PR: the push goes out on a new branch with a new PR
  const card = buildSubmit('IDD-1');
  assert.equal(card.existingPr, undefined);
  assert.deepEqual(card.branchGone, { pr: 1, merged: true });
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  assert.ok(!readLifecycle().some((e) => e.event === 's4_push_held' && /receive/.test(String(e.attrs?.reason ?? ''))));
  assert.ok(!laneEvents().includes('s4_merged'));
  // the fix went out on the branch again, over the public base that took the merge
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'after merge');
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:other.txt`), 'someone else');
  assert.equal(creates(gh).length, 2, 'a new PR for the fix after the merge, on the same approval');
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('the card\'s check of a lane whose PR was merged and its branch deleted gets the new fix ready over the public base, and the approval pushes it', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'ff');
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.lane.branch}`);
  await startSubmit(f, 'after merge\n', 'fix: after merge');
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  assert.equal((await approve()).ok, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'after merge');
  assert.equal(readProposal('IDD-1').status, 'complete');
  assert.equal(creates(gh).length, 2);
});

test('a branch gone with its PR closed unmerged is checked again as a new branch over the public base with the whole change, and pushed with a new PR on the approval', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  setPr(f, gh, { state: 'CLOSED' });
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.lane.branch}`);
  put(join(f.lane.path, 'other.txt'), 'after close\n'); commit(f.lane.path, 'fix: after close');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'not before the approval');
  const card = buildSubmit('IDD-1');
  assert.equal(card.existingPr, undefined);
  assert.deepEqual(card.branchGone, { pr: 1, merged: false });
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  // the whole change of the lane over the public base, not only what came after the closed push
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'first');
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:other.txt`), 'after close');
  assert.equal(git(f.remote, 'rev-parse', `${f.lane.branch}^`), git(f.remote, 'rev-parse', 'main'));
  assert.equal(creates(gh).length, 2);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('a branch gone whose PR was merged at another commit than the lane last pushed is still not submitted over the public base', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  setPr(f, gh, { state: 'MERGED', headRefOid: '0'.repeat(40), mergedAt: '2026-09-26T00:00:00Z' });
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.lane.branch}`);
  put(join(f.lane.path, 'other.txt'), 'after merge\n'); commit(f.lane.path, 'fix: after merge');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.held, ['IDD-1'], JSON.stringify(r));
  const held = readLifecycle().filter((e) => e.event === 's4_push_held').pop();
  assert.match(held.attrs.reason, /消えて/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});


// --- blind review round 6 (against the list of the entries to the push) ---

const custodyTip = () => JSON.parse(readFileSync(custodyPath('IDD-1'), 'utf8')).publicTip;

test('a push that reached GitHub unsaved, whose settings changed since, is taken as the lane\'s public tip by the tick, and the card\'s check records it on the PR', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  const out = await pushWithoutSave('IDD-1');
  changeConfig({ public_vocabulary_allow: ['lane'] });
  await submitPush();
  assert.equal(custodyTip(), out, 'the push is on record as the lane\'s public tip');
  assert.notEqual(readProposal('IDD-1').status, 'prepared');
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.equal(readLifecycle().filter((e) => e.event === 's4_pr_created').pop().attrs.commit, out);
  assert.deepEqual(edits(gh), []);
});

test('the card\'s check of a push that reached GitHub unsaved, whose settings changed since, checks it again instead of failing on the old token', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  const out = await pushWithoutSave('IDD-1');
  changeConfig({ public_vocabulary_allow: ['lane'] });
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(custodyTip(), out);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), out, 'nothing more to push');
});

test('a push that reached GitHub unsaved, after which the lane moved on, is taken as the public tip, and the new head is got ready by the tick and pushed over it on its approval', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  const out = await pushWithoutSave('IDD-1');
  put(join(f.lane.path, 'third.txt'), 'third\n'); commit(f.lane.path, 'fix: third');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal(custodyTip(), out);
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), out, 'nothing more before the approval');
  assert.equal((await approve()).ok, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:third.txt`), 'third');
  assert.equal(git(f.remote, 'rev-parse', `${f.lane.branch}^`), out, 'on top of the unsaved push');
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
  assert.deepEqual(edits(gh), []);
});

test('the card\'s check of a push that reached GitHub unsaved, after which the lane moved on, checks the new head instead of refusing it, and the approval pushes it', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  const out = await pushWithoutSave('IDD-1');
  put(join(f.lane.path, 'third.txt'), 'third\n'); commit(f.lane.path, 'fix: third');
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(git(f.remote, 'rev-parse', f.lane.branch), out);
  assert.equal((await approve()).ok, true);
  assert.equal(git(f.remote, 'rev-parse', `${f.lane.branch}^`), out);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:third.txt`), 'third');
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('a receive that takes in an unsaved push puts that submit away, and the lane is checked anew from the received tip', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  const out = await pushWithoutSave('IDD-1');
  put(join(f.lane.path, 'third.txt'), 'third\n'); commit(f.lane.path, 'fix: third');
  const { proposeImport, reviewImport, importUpstream } = await import('../src/overlay/import.ts');
  const pending = proposeImport('demo', { laneId: 'IDD-1' });
  assert.ok(!pending.error, pending.error);
  const reviewed = await reviewImport('demo', { laneId: 'IDD-1' });
  assert.ok(!reviewed.error, reviewed.error);
  assert.equal(importUpstream('demo', reviewed.token, { laneId: 'IDD-1' }).ok, true);
  assert.equal(custodyTip(), out);
  assert.equal(readProposal('IDD-1').status, 'complete', 'the unsaved push is not finished again with a head it no longer matches');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal((await approve()).ok, true);
  assert.equal(git(f.remote, 'rev-parse', `${f.lane.branch}^`), out);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:third.txt`), 'third');
});

test('without an R2 in this S3, a lane of the review loop compares with the head its last review looked at, not the head the submit was opened at', async () => {
  const f = setup();
  fakeGh(f.root);
  const { startSubmit } = await import('../src/plan/ship.ts');
  put(join(f.lane.path, 'app.txt'), 'reviewed\n'); commit(f.lane.path, 'feat: reviewed');
  const seen = git(f.lane.path, 'rev-parse', 'HEAD');
  await seedLifecycle('s2_start', 'IDD-1', {});
  await appendLifecycle('s2_result', 'IDD-1', {});
  await appendLifecycle('s2_review_started', 'IDD-1', { kind: 'blind', round: 1, run_ids: ['B-1'], head: seen });
  await appendLifecycle('s2_review_converged', 'IDD-1', {});
  // the executor goes on after the last review, before S3 opens the submit
  put(join(f.lane.path, 'app.txt'), 'unreviewed\n'); commit(f.lane.path, 'fix: after the last review');
  await reviewedRound(f, { r2: false });
  assert.ok(await startSubmit('IDD-1'));
  const r = await submitPush();
  assert.deepEqual([r.ready, r.held], [[], ['IDD-1']], JSON.stringify(r));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing pushed');
  const held = readLifecycle().filter((e) => e.event === 's4_push_held').pop();
  assert.ok(held.attrs.reason.includes(seen.slice(0, 7)), held.attrs.reason);
});


// --- push のたびの承認（penne の決定 2026-09-26: push は commit message をカードで承認したときだけ） ---

const remoteMessage = (f) => git(f.remote, 'log', '-1', '--format=%B', f.lane.branch);

test('without the card\'s approval nothing is pushed: the tick only checks and waits, and the export alone refuses to push', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const r1 = await submitPush();
  assert.deepEqual(r1.ready, ['IDD-1'], JSON.stringify(r1));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'the tick does not push');
  assert.ok(!laneEvents().includes('s4_pushed'));
  const saved = readProposal('IDD-1');
  assert.equal(saved.status, 'prepared');
  // the next ticks neither push nor check again
  const r2 = await submitPush();
  assert.deepEqual([r2.ready, r2.held], [[], []], JSON.stringify(r2));
  assert.equal(readProposal('IDD-1').token, saved.token);
  // the overlay export without an approved commit message pushes nothing
  const e = approveExport(saved.token);
  assert.equal(e.ok, false);
  assert.match(e.error, /承認/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  assert.deepEqual(creates(gh), []);
  // the card's approval pushes with the approved commit message and makes the PR with the approved text
  const done = await approveShip(saved.token, { commitMessage: 'feat: 承認した commit\n\n承認した説明', pr: { title: 'feat: 承認した題', body: '承認した本文' } });
  assert.equal(done.ok, true, done.error);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'ours');
  assert.equal(remoteMessage(f), 'feat: 承認した commit\n\n承認した説明');
  assert.deepEqual(gh.prs().map((p) => [p.title, p.body]), [['feat: 承認した題', '承認した本文']]);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('the card\'s check only checks: it pushes nothing, even when it asks to', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const view = await prepareSubmit('IDD-1', { title: 'feat: 題', body: '本文' }, { push: true, start: false });
  assert.ok(!view.error, view.error);
  assert.equal(view.status, 'prepared');
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

test('a new PR\'s card carries the drafted commit message with the drafted title and body, drafted once for the head', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const asked = [];
  setAgentRunner({
    deliver: async () => {},
    draftPrText: async () => ({ title: 'feat: 下書きの題', body: '下書きの本文', model: 'm' }),
    draftCommitMessage: async (o) => { asked.push(o); return { message: 'feat: 下書きの commit\n\n下書きの説明', model: 'm' }; },
  });
  try {
    const { runPrDrafts } = await import('../src/plan/pr-draft.ts');
    await runPrDrafts();
    await submitPush();
    await runPrDrafts();
    await submitPush();
  } finally { setAgentRunner(null); }
  assert.equal(asked.length, 1, 'drafted once for the head');
  assert.equal(asked[0].repo, 'test/project');
  assert.match(asked[0].material, /feat: ours/);
  assert.match(asked[0].material, /app\.txt/);
  const view = buildSubmit('IDD-1');
  assert.equal(view.pr.title, 'feat: 下書きの題');
  assert.equal(view.commit?.draft, 'feat: 下書きの commit\n\n下書きの説明');
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

test('a commit message that fails the vocabulary check cannot be approved, and neither can an empty one', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await submitPush();
  const token = readProposal('IDD-1').token;
  const pr = { title: 'feat: 題', body: '本文' };
  const flagged = await approveShip(token, { commitMessage: 'feat: DEC-001 の対応を lane で入れる', pr });
  assert.equal(flagged.ok, false);
  assert.match(flagged.error, /語彙/);
  const empty = await approveShip(token, { commitMessage: '  \n', pr });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /commit message/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing pushed');
  assert.deepEqual(creates(gh), []);
  // a word the repo allows passes
  changeConfig({ public_vocabulary_allow: ['lane'] });
  await submitPush();
  const again = await approveShip(readProposal('IDD-1').token, { commitMessage: 'feat: lane の表示を直す', pr });
  assert.equal(again.ok, true, again.error);
  assert.equal(remoteMessage(f), 'feat: lane の表示を直す');
});

test('a push to the lane\'s open PR is approved with its commit message, and goes to the PR without touching its text', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'first\n', 'feat: first');
  await submitPush();
  assert.equal((await approveShip(readProposal('IDD-1').token, { commitMessage: 'feat: first', pr: { title: 'feat: 題', body: '本文' } })).ok, true);
  await startSubmit(f, 'second\n', 'fix: second');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'first', 'not pushed before the approval');
  const view = buildSubmit('IDD-1');
  assert.equal(view.existingPr?.number, 1);
  assert.equal(view.branch.from, f.lane.branch);
  const done = await approveShip(view.proposal.token, { commitMessage: 'fix: 二つ目の直し' });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.prUrl, 'https://github.com/test/project/pull/1');
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'second');
  assert.equal(remoteMessage(f), 'fix: 二つ目の直し');
  assert.deepEqual(edits(gh), []);
  assert.equal(creates(gh).length, 1);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('a lane without a PR is not pushed on an approval that carries no PR text', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await submitPush();
  const r = await approveShip(readProposal('IDD-1').token, { commitMessage: 'feat: ours' });
  assert.equal(r.ok, false);
  assert.match(r.error, /PR/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  assert.deepEqual(creates(gh), []);
});

/** an R2 of this S3 that found `must` / `should` (the raw counts, before any judgement) */
async function r2Found(must, should) {
  const findings = [...Array(must).fill(0).map((_, i) => ({ severity: 'must', claim: `must の指摘 ${i + 1}`, path: 'app.txt' })), ...Array(should).fill(0).map((_, i) => ({ severity: 'should', claim: `should の指摘 ${i + 1}` }))];
  await appendLifecycle('s3_ready', 'IDD-1', {});
  await appendLifecycle('s3_r2_started', 'IDD-1', { run_id: 'R2-1' });
  await appendLifecycle('s3_r2_done', 'IDD-1', { run_id: 'R2-1', must, should, nit: 0, findings });
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
}

test('past R2 findings over the old limit no longer stop the push, and the card offers no R2 gate', async () => {
  const f = setup();
  fakeGh(f.root);
  put(join(f.lane.path, 'app.txt'), 'ours\n'); commit(f.lane.path, 'feat: ours');
  await r2Found(1, 2);
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1']);
  const view = buildSubmit('IDD-1');
  assert.equal('r2Gate' in view, false);
  const pushed = await approveShip(view.proposal.token, { commitMessage: 'feat: ours', pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'ours');
  assert.ok(!readLifecycle().some((e) => e.event === 's4_r2_overridden'));
});

test('sending the lane back from the submit takes it out of the submit, and its checked submit can no longer be pushed', async () => {
  const f = setup();
  fakeGh(f.root);
  put(join(f.lane.path, 'app.txt'), 'ours\n'); commit(f.lane.path, 'feat: ours');
  await r2Found(0, 2);
  await submitPush();
  const token = readProposal('IDD-1').token;
  const { applyDecision } = await import('../src/ledger/write.ts');
  const back = await applyDecision('s4_revise', { iddId: 'IDD-1', instruction: '指摘を直す: should の指摘 1 / should の指摘 2' });
  assert.equal(back.ok, true, back.error);
  assert.notEqual(deriveStage(readLifecycle()).decision, 'ship');
  const r = await approveShip(token, { commitMessage: 'feat: ours', pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(r.ok, false);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

test('the CLI does not push or make a PR: its export and ship send penne to the card', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const p = await propose('IDD-1', { title: 'feat: 題', body: '本文' });
  assert.ok(!p.error, p.error);
  for (const command of ['export', 'ship']) {
    let out;
    try {
      out = { status: 0, text: execFileSync(process.execPath, ['--experimental-strip-types', join(original, 'packages/idd-cli/bin/idd.ts'), command, 'IDD-1', p.token], { cwd: f.work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IDD_LANE_SCOPE: 'off', IDD_NO_TICK_KICK: '1' } }) };
    } catch (e) { out = { status: e.status, text: String(e.stdout) }; }
    assert.notEqual(out.status, 0, `${command}: ${out.text}`);
    assert.match(out.text, /カード/);
  }
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  assert.deepEqual(creates(gh), []);
});

test('penne\'s check before the tick still names a public change the review did not see, next to the approval', async () => {
  const f = setup();
  fakeGh(f.root);
  const { startSubmit } = await import('../src/plan/ship.ts');
  put(join(f.lane.path, 'app.txt'), 'reviewed\n'); commit(f.lane.path, 'feat: reviewed');
  const seen = await reviewedRound(f);
  put(join(f.lane.path, 'app.txt'), 'unreviewed\n'); commit(f.lane.path, 'fix: after R2');
  assert.ok(await startSubmit('IDD-1'));
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  const view = buildSubmit('IDD-1');
  assert.match(view.pushHeld ?? '', /レビューを経ていない/);
  assert.ok(view.pushHeld.includes(seen.slice(0, 7)));
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
  // the tick does not record it twice
  await submitPush();
  assert.equal(readLifecycle().filter((e) => e.event === 's4_push_held').length, 1);
});


// --- blind review round 7 (after the merge of the transition gate) ---

test('a submit pushed without its PR whose branch was deleted is not a dead end: the PR approval says the branch is gone, the card offers the check, and the check gets it ready as a new push', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await pushedWithoutPr(f);
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.lane.branch}`);
  const old = buildSubmit('IDD-1').proposal;
  const refused = await approveShip(old.token, { pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /消えて/);
  assert.doesNotMatch(refused.error, /更新されました|受け入れ/);
  const view = buildSubmit('IDD-1');
  assert.match(view.recheck ?? '', /消えて/, 'the card offers the check again');
  // the receive cannot fetch a branch that is gone: it says so instead of failing in git
  const { proposeImport } = await import('../src/overlay/import.ts');
  const receive = proposeImport('demo', { laneId: 'IDD-1' });
  assert.ok(receive.error);
  assert.match(receive.error, /消えて/);
  assert.doesNotMatch(receive.error, /couldn't find remote ref/);
  const card = await prepareSubmit('IDD-1', { title: 'feat: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(card.status, 'prepared');
  assert.notEqual(card.token, old.token);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'the check pushes nothing');
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'ours');
  assert.equal(gh.prs().length, 1);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('the pushed commit carries the upstream clone\'s identity and the message penne approved', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await submitPush();
  const done = await approve({ commitMessage: 'feat: 承認した message' });
  assert.equal(done.ok, true, done.error);
  assert.equal(git(f.remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%B', f.lane.branch), 'Upstream Person <person@example.com>|Upstream Person <person@example.com>|feat: 承認した message');
});

test('the commit message penne approved is recorded as the pushed commit carries it, trimmed the same way at both ends', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await submitPush();
  const done = await approve({ commitMessage: '\n\n  feat: 前に空行\n\n本文\n\n' });
  assert.equal(done.ok, true, done.error);
  const recorded = readLifecycle().filter((e) => e.event === 's4_push_approved').pop().attrs.commit_message;
  assert.equal(recorded, 'feat: 前に空行\n\n本文');
  assert.equal(remoteMessage(f), recorded);
});

test('a checked submit whose approval window ran out is checked again by the tick, with a new token', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const r1 = await submitPush();
  assert.deepEqual(r1.ready, ['IDD-1'], JSON.stringify(r1));
  const saved = readProposal('IDD-1');
  saved.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(proposalPath('IDD-1'), JSON.stringify(saved));
  const r2 = await submitPush();
  assert.deepEqual(r2.ready, ['IDD-1'], JSON.stringify(r2));
  const fresh = readProposal('IDD-1');
  assert.notEqual(fresh.token, saved.token);
  assert.ok(Date.parse(fresh.expiresAt) > Date.now());
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'the check pushes nothing');
});


// --- blind review round 8 ---

/** why a lane whose branch is gone is not put out again over the public base (propose's own explanation) */
const NOT_AGAIN = /公開本流の上に出し直しません/;

/** a submit pushed to the lane's PR whose check after the push failed; then GitHub merged the PR at another commit and deleted the branch */
async function pushedThenMergedElsewhere(f, gh) {
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  await submitPush();
  failList(f, true);
  assert.equal((await approve()).ok, false);
  failList(f, false);
  assert.equal(readProposal('IDD-1').status, 'pushed');
  setPr(f, gh, { state: 'MERGED', headRefOid: '0'.repeat(40), mergedAt: '2026-09-26T00:00:00Z' });
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.lane.branch}`);
}

test('checking again a pushed submit whose branch is gone and whose PR was merged at another commit says why it is not put out again, on the card and as the hold', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await pushedThenMergedElsewhere(f, gh);
  const checked = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.match(checked.error ?? '', NOT_AGAIN, `the check does not hand back the same push: ${JSON.stringify(checked).slice(0, 200)}`);
  const card = buildSubmit('IDD-1');
  assert.match(card.pushHeld ?? '', NOT_AGAIN, 'the card says why');
  const hold = readLifecycle().filter((e) => e.event === 's4_push_held').pop();
  assert.match(hold.attrs.reason, NOT_AGAIN);
  // checked again, the same reason is not written twice
  await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.equal(readLifecycle().filter((e) => e.event === 's4_push_held' && NOT_AGAIN.test(String(e.attrs?.reason))).length, 1);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing is pushed');
});

test('the tick that finds the pushed submit\'s branch gone, its PR merged at another commit, holds it with the same reason, not with an offer to put it out again', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await pushedThenMergedElsewhere(f, gh);
  backdate(f.state);
  await submitPush();
  const card = buildSubmit('IDD-1');
  assert.match(card.pushHeld ?? '', NOT_AGAIN);
  assert.doesNotMatch(card.pushHeld ?? '', /出し直す push をカードで承認できます/);
  assert.ok(card.recheck, 'penne can check it again once the branch or the PR is set right');
});

/** a lane pushed to its PR, which GitHub had closed: the push is held without an open PR (no_open_pr), and the lane moves on to a new head */
async function closedAfterPush(f, gh) {
  await laneWithOpenPr(f, gh);
  setPr(f, gh, { state: 'CLOSED' });
  await startSubmit(f, 'second\n', 'fix: second');
  await submitPush();
  assert.equal((await approve()).noOpenPr, true);
  await startSubmit(f, 'third\n', 'fix: third');
}

test('a lane whose PR was found closed after a push waits for the new PR\'s draft, and its card and commit message do not treat the closed PR as open', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await closedAfterPush(f, gh);
  const materials = [];
  setAgentRunner({
    deliver: async () => {},
    draftPrText: async () => ({ title: 'fix: 下書きの題', body: '下書きの本文', model: 'm' }),
    draftCommitMessage: async ({ material }) => { materials.push(material); return { message: 'fix: 下書きの commit', model: 'm' }; },
  });
  try {
    const waiting = await submitPush();
    assert.deepEqual(waiting.ready, [], `the tick waits for the new PR's draft: ${JSON.stringify(waiting)}`);
    const { runPrDrafts } = await import('../src/plan/pr-draft.ts');
    assert.deepEqual((await runPrDrafts()).drafted, ['IDD-1']);
    const r = await submitPush();
    assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
    const card = buildSubmit('IDD-1');
    assert.equal(card.existingPr, undefined, 'the closed PR is not offered as where the push goes');
    assert.equal(card.pr.title, 'fix: 下書きの題');
    assert.equal(card.head, git(f.lane.path, 'rev-parse', 'HEAD'));
    assert.ok(materials.length >= 1);
    assert.doesNotMatch(materials.at(-1), /次の版/);
  } finally { setAgentRunner(null); }
});

test('the approval of a push is recorded only once the export\'s checks under the lock passed', async () => {
  const f = setup();
  fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  // someone moves the public base after the check
  git(f.upstream, 'fetch', 'origin'); git(f.upstream, 'checkout', '-q', 'main'); git(f.upstream, 'reset', '-q', '--hard', 'origin/main');
  put(join(f.upstream, 'other.txt'), 'someone else\n'); commit(f.upstream, 'feat: other'); git(f.upstream, 'push', 'origin', 'main');
  const done = await approve();
  assert.equal(done.ok, false);
  assert.match(done.error ?? '', /公開本流が更新されました/);
  assert.ok(!laneEvents().includes('s4_push_approved'), 'no approval on record for a push that was refused');
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});


// --- blind review round 9 ---

/**
 * PR #1 was merged at the lane's first push (squash, past a moved base); penne approved a push of a fix after the merge
 * to the merged branch, which waits for a new PR; then GitHub deleted the branch
 */
async function pushedAfterMergeThenGone(f, gh) {
  await laneWithOpenPr(f, gh);
  mergePr(f, gh, 'squash');
  await startSubmit(f, 'after merge\n', 'fix: after merge');
  await submitPush();
  const pushed = await approve();
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(pushed.noOpenPr, true);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'after merge');
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.lane.branch}`);
}

test('the PR approval of a push made after the merge, whose branch was then deleted, offers to put it out again over the public base instead of stopping', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await pushedAfterMergeThenGone(f, gh);
  const old = buildSubmit('IDD-1').proposal;
  const refused = await approveShip(old.token, { pr: { title: 'fix: 題', body: '本文' } });
  assert.equal(refused.ok, false);
  assert.doesNotMatch(refused.error, NOT_AGAIN);
  assert.match(refused.error, /出し直す push をカードで承認できます/);
  assert.equal(creates(gh).length, 1);
});

test('a lane pushed again after its PR merged, whose branch was then deleted, is checked again as the change after the merge over the public base, and pushed with a new PR on the approval', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await pushedAfterMergeThenGone(f, gh);
  const card = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(card.status, 'prepared');
  assert.deepEqual(buildSubmit('IDD-1').branchGone, { pr: 1, merged: true });
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'the check pushes nothing');
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  // what the merged PR did not carry (the push after the merge), over the public base that took the merge
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'after merge');
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:other.txt`), 'someone else');
  assert.equal(git(f.remote, 'rev-parse', `${f.lane.branch}^`), git(f.remote, 'rev-parse', 'main'));
  assert.equal(creates(gh).length, 2);
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('the tick checks a newer head of a lane pushed again after its merge and then deleted, and the approval puts out both changes after the merge', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await pushedAfterMergeThenGone(f, gh);
  put(join(f.lane.path, 'third.txt'), 'third\n'); commit(f.lane.path, 'fix: third');
  await seedLifecycle('s4_submit_started', 'IDD-1', {});
  const r = await submitPush();
  assert.deepEqual(r.ready, ['IDD-1'], JSON.stringify(r));
  const done = await approve();
  assert.equal(done.ok, true, done.error);
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:app.txt`), 'after merge');
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:third.txt`), 'third');
  assert.equal(git(f.remote, 'show', `${f.lane.branch}:other.txt`), 'someone else');
  assert.equal(creates(gh).length, 2);
});

test('a branch gone whose PR merged at a commit the lane pushed, with no record that the merge came before the later push, is still not put out again', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await pushedAfterMergeThenGone(f, gh);
  // the records of the merge found after the push are gone (an older record): GitHub alone does not decide it
  for (const name of readdirSync(f.state).filter((n) => n.startsWith('lifecycle-') && n.endsWith('.jsonl'))) {
    const path = join(f.state, name);
    const kept = readFileSync(path, 'utf8').split('\n').filter(Boolean).filter((l) => { const r = JSON.parse(l); return !(r.event === 's4_push_held' && r.attrs?.no_open_pr); });
    writeFileSync(path, kept.join('\n') + '\n');
  }
  const checked = await prepareSubmit('IDD-1', { title: 'fix: 題', body: '本文' }, { start: false });
  assert.match(checked.error ?? '', NOT_AGAIN);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '');
});

// --- 2026-09-26 follow-ups: the commit message's vocabulary, and an old submit card after a send-back ---

test('a commit message with an English word of the workflow is pushed on its approval: only an ID or a Japanese word stops it', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  await submitPush();
  const pr = { title: 'feat: 題', body: '本文' };
  const token = readProposal('IDD-1').token;
  const stopped = await approveShip(token, { commitMessage: 'feat: 本 lane の範囲を直す', pr });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /本 lane/);
  const done = await approveShip(token, { commitMessage: 'feat(IllustCrop): overlay の位置を直す', pr });
  assert.equal(done.ok, true, done.error);
  assert.equal(remoteMessage(f), 'feat(IllustCrop): overlay の位置を直す');
  assert.equal(creates(gh).length, 1);
});

/** the lane's lifecycle, written by another process: penne's send-back of the submit (what `s4_revise` records) */
function sendBackScript(f) {
  const path = join(f.state, 'lifecycle-demo.jsonl');
  return `const d = new Date(); const p = (n) => String(n).padStart(2, '0'); const off = -d.getTimezoneOffset();
const at = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + (off >= 0 ? '+' : '-') + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
require('node:fs').appendFileSync(${JSON.stringify(path)}, JSON.stringify({ event: 's4_verify_user_judgment_answered', idd_id: 'IDD-1', at, attrs: { outcome: 'revise', instruction: '直す' } }) + '\\n');`;
}

test('an approval from a submit card of a lane penne sent back is refused, even at the same head with a check saved after the send-back, and nothing is pushed', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await startSubmit(f, 'ours\n', 'feat: ours');
  const sent = await applyDecision('s4_revise', { iddId: 'IDD-1', instruction: '直す' });
  assert.equal(sent.ok, true, sent.error);
  // a check that began before the send-back saves its submit after it: the executor has not committed yet
  const stale = await propose('IDD-1', { title: 'feat: 題', body: '本文' });
  assert.ok(!stale.error, stale.error);
  const r = await approveShip(stale.token, { commitMessage: APPROVED, pr: { title: 'feat: 題', body: '本文' } });
  assert.equal(r.ok, false, 'the old card cannot push');
  assert.match(r.error ?? '', /提出前確認/);
  assert.equal(git(f.remote, 'branch', '--list', f.lane.branch), '', 'nothing pushed');
  assert.deepEqual(creates(gh), []);
  assert.ok(!laneEvents().includes('s4_push_approved'), 'no approval recorded');
  assert.ok(!laneEvents().includes('s4_ship_failed'), 'the refusal of an old card is not a failed push');
});

test('a check from the submit card during which penne sent the lane back saves no submit', async () => {
  const f = setup();
  fakeGh(f.root);
  changeConfig({ checks: [{ name: 'sent back meanwhile', command: [process.execPath, '-e', sendBackScript(f)], required: true, scope: 'records' }] });
  await startSubmit(f, 'ours\n', 'feat: ours');
  const checked = await prepareSubmit('IDD-1', { title: 'feat: 題', body: '本文' }, { start: false });
  assert.ok('error' in checked, 'the check says it saved nothing: ' + JSON.stringify(checked).slice(0, 600));
  assert.match(checked.error, /段/);
  assert.equal(readProposal('IDD-1'), null, 'no submit saved for the card');
  assert.notEqual(deriveStage(readLifecycle()).decision, 'ship');
});

test('a check of the tick during which penne sent the lane back saves no submit and holds nothing', async () => {
  const f = setup();
  fakeGh(f.root);
  changeConfig({ checks: [{ name: 'sent back meanwhile', command: [process.execPath, '-e', sendBackScript(f)], required: true, scope: 'records' }] });
  await startSubmit(f, 'ours\n', 'feat: ours');
  const r = await submitPush();
  assert.deepEqual(r.ready, [], JSON.stringify(r));
  assert.equal(readProposal('IDD-1'), null, 'no submit saved for the card');
  assert.ok(!laneEvents().includes('s4_push_held'), 'a lane sent back is not held at a card it left');
});

test('a submit saved without asking the stage is for the tests only: the package does not export it, and no source outside the tests calls it', async () => {
  const index = readFileSync(join(original, 'packages/idd-core/src/index.ts'), 'utf8');
  assert.doesNotMatch(index, /\bpropose(ForTests)?\b/, 'the package exports the submit check only through the card and the tick (prepareSubmit, runSubmitPush)');
  const sources = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs'], { cwd: original, encoding: 'utf8' }).split('\n')
    .filter((f) => f && !/(^|\/)test\/|\.test\.|^scripts\//.test(f) && f !== 'packages/idd-core/src/overlay/export.ts');
  const callers = sources.filter((f) => /\bpropose(ForTests)?\s*\(/.test(readFileSync(join(original, f), 'utf8')));
  assert.deepEqual(callers, [], 'the card and the tick save a submit through proposeAdmitted, which asks the stage');
});

test('AC-013: the tick skips a lane whose lock is held for the checks, and takes it up once they end', async () => {
  const f = setup([{ name: 'ok', command: 'true', required: true }]);
  fakeGh(f.root);
  await startSubmit(f, 'two\n', 'feat: change');
  const release = lock(f.lane.path, { checks: true });
  let held;
  try { held = await submitPush(); } finally { release(); }
  assert.deepEqual(held.errors, [], JSON.stringify(held));
  assert.deepEqual(held.held, [], JSON.stringify(held));
  assert.equal(laneEvents().includes('s4_push_held'), false);
  assert.equal(laneEvents().includes('s4_ship_failed'), false);
  const after = await submitPush();
  assert.ok(after.ready.includes('IDD-1') || after.recorded.includes('IDD-1'), JSON.stringify(after));
});

test('AC-013: the tick does not record a lock refusal of the push follow-up as a failure, and takes the lane up once it ends', async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  await laneWithOpenPr(f, gh);
  await startSubmit(f, 'second\n', 'fix: second');
  await submitPush();
  // the push goes out, but the PR check after it fails for a passing cause, so the tick tries it again later
  failList(f, true);
  await approve();
  failList(f, false);
  backdate(f.state);
  const failures = () => laneEvents().filter((e) => e === 's4_ship_failed').length;
  const before = failures();
  // the follow-up now meets the repo's lock held for its checks
  const release = lock(f.lane.path, { checks: true });
  let refused;
  try { refused = await submitPush(); } finally { release(); }
  assert.deepEqual(refused.errors, [], JSON.stringify(refused));
  assert.deepEqual(refused.held, [], JSON.stringify(refused));
  assert.equal(refused.recorded.includes('IDD-1'), false, 'the lane is not recorded while the checks run');
  assert.equal(failures(), before, 'the lock refusal is not a failed push');
  assert.equal(laneEvents().includes('s4_push_held'), false, 'the lock refusal holds nothing');
  // once the checks end, the same pass finishes the follow-up and records the push on the PR
  const after = await submitPush();
  assert.deepEqual(after.recorded, ['IDD-1'], JSON.stringify(after));
  assert.equal(deriveStage(readLifecycle()).group, 'waiting');
});

test('AC-015: the lock refusal is a wait for the settle and for the approval, and leaves no failed push on record', async () => {
  for (const checks of [true, false]) {
    const f = setup();
    fakeGh(f.root);
    await startSubmit(f, 'two\n', 'feat: change');
    const p = await propose('IDD-1', { title: 'feat: 題', body: '本文' });
    assert.ok(!p.error, p.error);
    const release = lock(f.lane.path, checks ? { checks: true } : {});
    let settle, ship;
    try {
      settle = await settlePushed('IDD-1', p.token);
      ship = await runShip('IDD-1', p.token, shipApproved('IDD-1', { commitMessage: APPROVED, pr: { title: 'feat: 題', body: '本文' } }));
    } finally { release(); }
    const reason = checks ? /検査が走っています/ : /overlay 処理中/;
    assert.equal(settle.ok, false, JSON.stringify(settle));
    assert.match(settle.error, reason);
    assert.equal(ship.ok, false, JSON.stringify(ship));
    assert.match(ship.error, reason);
    assert.equal(laneEvents().includes('s4_ship_failed'), false);
    assert.equal(laneEvents().includes('s4_push_approved'), false);
  }
});

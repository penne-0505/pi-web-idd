import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { deriveStage } from '../src/ledger/derive.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { BASE_ADVANCED, currentBaseAdvance, forgetBaseAdvanceChecks, planTouchedPaths, runBaseAdvance } from '../src/plan/base-advance.ts';
import { runTick } from '../src/plan/tick.ts';
import { setAgentRunner } from '../src/agent/port.ts';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

const DECISION = ['### DEC-1: x', '', '- **What**: x', '- **Anchors**: `src/a.ts`（run）、`lib/dir/`', ''].join('\n');
const REFERENCE = '- `docs/notes.md` — 前提を見た\n';

const rec = (id) => ({ idd_id: id, parent_id: null, created_at: '2026-09-20T00:00:00+09:00', linear_issue_url: null, gh_issue_url: `https://github.com/t/p/issues/${Number(id.slice(-3))}`, pull_req_url: null, source_type: 'github', context: '', title: `T${id}`, area: 'demo' });
const ev = (id, event, attrs = {}) => ({ event, idd_id: id, at: '2026-09-20T10:00:00+09:00', attrs });
const laneOf = (id) => readLifecycle().filter((e) => e.idd_id === id);
const records = (id) => laneOf(id).filter((e) => e.event === BASE_ADVANCED);

/** a work clone on its work branch, and a lane cut from it waiting at GO with its plan written in its worktree */
function setup({ decision = DECISION, reference = REFERENCE, events = null, workBase = 'work-main' } = {}) {
  const root = scratchDir('adv-');
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=work-main');
  for (const f of ['src/a.ts', 'src/b.ts', 'lib/dir/c.ts', 'docs/notes.md', 'other.txt']) put(join(work, f), `${f}\n`);
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  const wt = join(root, 'lanes', 'IDD-001');
  git(work, 'worktree', 'add', '-q', '-b', 'idd/IDD-001', wt, 'work-main');
  if (decision !== null) put(join(wt, '_docs/intent/demo/idd-001/decision.md'), decision);
  if (reference !== null) put(join(wt, '_docs/reference/demo/idd-001/reference.md'), reference);
  put(join(wt, '_docs/qa/demo/idd-001/qa.md'), '- AC-001: x\n');
  git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'plan');
  put(join(root, 'repos.yaml'), JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: workBase, public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r, concurrency: 2 }\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml') });
  put(join(state, 'backlog.jsonl'), JSON.stringify(rec('IDD-001')) + '\n');
  const lane = events ?? [ev('IDD-001', 'lane_open'), ev('IDD-001', 's1_ready'), ev('IDD-001', 's1_plan_review_skipped')];
  put(join(state, 'lifecycle-demo.jsonl'), lane.map((e) => JSON.stringify(e)).join('\n') + '\n');
  put(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-001', planner_session_id: 'P1', worktree_path: wt, branch: 'idd/IDD-001' }) + '\n');
  /** a commit on the work branch, as another lane's merge would put it there */
  const advance = (file) => {
    put(join(work, file), `${file} ${Math.random()}\n`);
    git(work, 'add', '.'); git(work, 'commit', '-qm', `touch ${file}`);
    return git(work, 'rev-parse', 'work-main');
  };
  /** the work branch puts a file back as it was at the fork */
  const revert = (file) => {
    put(join(work, file), `${file}\n`);
    git(work, 'add', '.'); git(work, 'commit', '-qm', `revert ${file}`);
    return git(work, 'rev-parse', 'work-main');
  };
  const fork = git(wt, 'rev-parse', 'work-main');
  return { root, work, wt, state, advance, revert, fork };
}

test('the places a plan touches are the paths in its Anchors and its reference, made yet or not; a bare name counts only as a file at the top', () => {
  const { wt } = setup({ decision: DECISION.replace('`lib/dir/`', '`lib/dir/`、`AppTheme.primary`、`missing/x.ts`、`a.ts`、`other.txt`') });
  assert.deepEqual(planTouchedPaths({ ...rec('IDD-001') }, wt), { known: true, paths: ['docs/notes.md', 'lib/dir/', 'missing/x.ts', 'other.txt', 'src/a.ts'] });
});

test('a move of the work branch into the plan is recorded once, with the files, and a move elsewhere is not', async () => {
  const { advance, fork } = setup();
  advance('other.txt');
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  assert.deepEqual(records('IDD-001'), []);

  const to = advance('src/a.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  const [first] = records('IDD-001');
  assert.deepEqual(first.attrs, { from: fork, to, files: ['src/a.ts'], files_total: 1, known: true });

  // the same move is not recorded again, nor a further move that brings no new file into the plan
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  advance('other.txt');
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  assert.equal(records('IDD-001').length, 1);

  // a move that reaches another place of the plan is a new record, with every file it reached so far
  const to2 = advance('lib/dir/c.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.deepEqual(records('IDD-001')[1].attrs, { from: fork, to: to2, files: ['lib/dir/c.ts', 'src/a.ts'], files_total: 2, known: true });

  // the record does not move the lane: it still waits at GO
  assert.equal(deriveStage(laneOf('IDD-001')).decision, 'go');
});

test('a plan whose places cannot be read records any move, and says so', async () => {
  const { advance } = setup({ decision: '### DEC-1: x\n\n- **What**: x\n', reference: null });
  advance('other.txt');
  await runBaseAdvance();
  const [r] = records('IDD-001');
  assert.equal(r.attrs.known, false);
  assert.deepEqual(r.attrs.files, ['other.txt']);
});

test('only a lane waiting at GO is looked at, and a work branch that cannot be read records nothing', async () => {
  const prep = setup({ events: [ev('IDD-001', 'lane_open')] });
  prep.advance('src/a.ts');
  assert.deepEqual(await runBaseAdvance(), { recorded: [], errors: [] });

  const gone = setup({ workBase: 'no-such-branch' });
  gone.advance('src/a.ts');
  const r = await runBaseAdvance();
  assert.deepEqual(r.recorded, []);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(records('IDD-001'), []);
});

test('the GO card reads the record for the current plan only', async () => {
  const { advance } = setup();
  advance('src/a.ts');
  await runBaseAdvance();
  const view = currentBaseAdvance(laneOf('IDD-001'));
  assert.deepEqual(view.files, ['src/a.ts']);
  assert.equal(view.more, 0);
  assert.equal(view.known, true);

  // penne sends the plan back and the planner makes it again: the move it was sent back for is not shown again
  await seedLifecycle('s1_revise_requested', 'IDD-001', { instruction: '本流の変更を確かめて' });
  await appendLifecycle('s1_ready', 'IDD-001', {});
  await appendLifecycle('s1_plan_review_skipped', 'IDD-001', {});
  assert.equal(currentBaseAdvance(laneOf('IDD-001')), null);
  await runBaseAdvance();
  assert.equal(currentBaseAdvance(laneOf('IDD-001')), null);
  assert.equal(records('IDD-001').length, 1);
});

test('a long list of files is kept to its head and a count', async () => {
  const { advance, work } = setup({ decision: '### DEC-1: x\n\n- **Anchors**: `many/`\n', reference: null });
  for (let i = 0; i < 55; i += 1) put(join(work, 'many', `f${String(i).padStart(2, '0')}.ts`), 'x');
  advance('many/f00.ts');
  await runBaseAdvance();
  const [r] = records('IDD-001');
  // many/ is not in the lane yet: it is real in the commit the work branch moved to
  assert.equal(r.attrs.known, true);
  assert.equal(r.attrs.files.length, 50);
  assert.equal(r.attrs.files_total, 55);
  assert.equal(currentBaseAdvance(laneOf('IDD-001')).more, 5);
});

test('the tick records the move without running another pass for it', async () => {
  const { advance } = setup();
  setAgentRunner({ deliver: async () => {} });
  advance('src/a.ts');
  const r = await runTick({ intake: false });
  assert.deepEqual(r.baseAdvance, { recorded: ['IDD-001'], errors: [] });
  assert.equal(r.again, undefined);
  assert.equal(records('IDD-001').length, 1);
  const r2 = await runTick({ intake: false });
  assert.deepEqual(r2.baseAdvance, { recorded: [], errors: [] });
  setAgentRunner(null);
});

test('a plan whose places cannot be read is recorded once for its fork, however far the work branch moves on', async () => {
  const { advance } = setup({ decision: '### DEC-1: x\n\n- **What**: x\n', reference: null });
  advance('other.txt');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  advance('src/b.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  advance('lib/dir/c.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  assert.equal(records('IDD-001').length, 1);
  assert.equal(currentBaseAdvance(laneOf('IDD-001')).known, false);
});

test('a change the work branch takes back is taken off the card: the files are recorded again, and none left clears it', async () => {
  const { advance, revert } = setup();
  advance('src/a.ts');
  await runBaseAdvance();
  advance('lib/dir/c.ts');
  await runBaseAdvance();
  assert.deepEqual(currentBaseAdvance(laneOf('IDD-001')).files, ['lib/dir/c.ts', 'src/a.ts']);

  // back to the files of the first record: the card shows what is changed now, not the last record
  revert('lib/dir/c.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.deepEqual(currentBaseAdvance(laneOf('IDD-001')).files, ['src/a.ts']);
  assert.deepEqual((await runBaseAdvance()).recorded, []);

  // nothing of the plan changed any more: the card shows no move, once
  revert('src/a.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.equal(currentBaseAdvance(laneOf('IDD-001')), null);
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  assert.equal(records('IDD-001').length, 4);

  // a lane whose work branch never touched the plan has nothing to clear
  const other = setup();
  other.advance('other.txt');
  await runBaseAdvance();
  assert.deepEqual(records('IDD-001'), []);
});

test('the reference a plan keeps beside its decisions is read too, as the GO card reads it', () => {
  const { wt } = setup({ decision: '### DEC-1: x\n\n- **What**: x\n', reference: null });
  put(join(wt, '_docs/intent/demo/idd-001/reference.md'), REFERENCE);
  assert.deepEqual(planTouchedPaths({ ...rec('IDD-001') }, wt), { known: true, paths: ['docs/notes.md'] });
});

test('a path that is not ASCII is read as the file it names', async () => {
  const { advance, work } = setup({ decision: '### DEC-1: x\n\n- **Anchors**: `lib/dir/`、`many/`\n', reference: null });
  git(work, 'config', 'core.quotePath', 'true');
  advance('lib/dir/日本語.ts');
  await runBaseAdvance();
  assert.deepEqual(records('IDD-001').at(-1).attrs.files, ['lib/dir/日本語.ts']);

  // a place real only in the commit the work branch moved to, holding only such a file
  const only = setup({ decision: '### DEC-1: x\n\n- **Anchors**: `many/`\n', reference: null });
  git(only.work, 'config', 'core.quotePath', 'true');
  only.advance('many/日本語.ts');
  await runBaseAdvance();
  const [r] = records('IDD-001');
  assert.equal(r.attrs.known, true);
  assert.deepEqual(r.attrs.files, ['many/日本語.ts']);
});

/** the git commands the stage ran while `run` went, read through a git on PATH that notes each call */
async function gitCalls(run) {
  const dir = scratchDir('git-shim-');
  const log = join(dir, 'calls.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755);
  writeFileSync(log, '');
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await run();
  } finally {
    process.env.PATH = path;
  }
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  return calls;
}

test('after a send-back, a later change to a file the last plan was sent back for is shown on the new plan', async () => {
  const { advance } = setup();
  advance('src/a.ts');
  await runBaseAdvance();
  await seedLifecycle('s1_revise_requested', 'IDD-001', { instruction: '本流の変更を確かめて' });
  await appendLifecycle('s1_ready', 'IDD-001', {});
  await appendLifecycle('s1_plan_review_skipped', 'IDD-001', {});
  // the move penne sent the plan back for is not shown again
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  assert.equal(currentBaseAdvance(laneOf('IDD-001')), null);

  // a change made after it, into the same file, is one penne has not seen
  const to = advance('src/a.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  const view = currentBaseAdvance(laneOf('IDD-001'));
  assert.deepEqual(view.files, ['src/a.ts']);
  assert.equal(view.to, to);
  assert.deepEqual((await runBaseAdvance()).recorded, []);
});

test('a place the plan made again adds, changed by a move the last record did not list, is shown on the new plan', async () => {
  const onlyA = '### DEC-1: x\n\n- **Anchors**: `src/a.ts`\n';
  const { work, wt } = setup({ decision: onlyA, reference: null });
  // one move of the work branch changes both files; the plan names only src/a.ts, so the record lists that one
  put(join(work, 'src/a.ts'), 'a2\n'); put(join(work, 'src/b.ts'), 'b2\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'touch a and b');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.deepEqual(records('IDD-001')[0].attrs.files, ['src/a.ts']);

  // penne sends the plan back and the new plan adds src/b.ts; the work branch has not moved since
  await seedLifecycle('s1_revise_requested', 'IDD-001', { instruction: '本流の変更を確かめて' });
  put(join(wt, '_docs/intent/demo/idd-001/decision.md'), '### DEC-1: x\n\n- **Anchors**: `src/a.ts`、`src/b.ts`\n');
  await appendLifecycle('s1_ready', 'IDD-001', {});
  await appendLifecycle('s1_plan_review_skipped', 'IDD-001', {});
  // the change to src/b.ts was never on a card: the new plan's card shows it
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.deepEqual(currentBaseAdvance(laneOf('IDD-001')).files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual((await runBaseAdvance()).recorded, []);
});

test('a plan made again after a record cut to its head is shown the move again', async () => {
  const { advance, work } = setup({ decision: '### DEC-1: x\n\n- **Anchors**: `many/`\n', reference: null });
  for (let i = 0; i < 55; i += 1) put(join(work, 'many', `f${String(i).padStart(2, '0')}.ts`), 'x');
  advance('many/f00.ts');
  await runBaseAdvance();
  assert.equal(records('IDD-001')[0].attrs.files_total, 55);
  await seedLifecycle('s1_revise_requested', 'IDD-001', { instruction: '本流の変更を確かめて' });
  await appendLifecycle('s1_ready', 'IDD-001', {});
  await appendLifecycle('s1_plan_review_skipped', 'IDD-001', {});
  // the files past the head were never listed, so the record cannot say penne saw them
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.equal(currentBaseAdvance(laneOf('IDD-001')).more, 5);
});

test('within one plan, a further change to a file already listed is recorded with the commit it came in', async () => {
  const { advance } = setup();
  advance('src/a.ts');
  await runBaseAdvance();
  const to = advance('src/a.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.equal(records('IDD-001').at(-1).attrs.to, to);
  assert.equal(currentBaseAdvance(laneOf('IDD-001')).to, to);
});

test('a change past the listed head of a long list is not taken for the same move', async () => {
  const { advance, work } = setup({ decision: '### DEC-1: x\n\n- **Anchors**: `many/`\n', reference: null });
  for (let i = 0; i < 50; i += 1) put(join(work, 'many', `f${String(i).padStart(2, '0')}.ts`), 'x');
  advance('many/f51.ts');
  await runBaseAdvance();
  assert.equal(records('IDD-001')[0].attrs.files_total, 51);
  // the same head and the same count, but the file after the head is another one
  rmSync(join(work, 'many', 'f51.ts'));
  advance('many/f52.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.equal(records('IDD-001').length, 2);
});

test('a plan whose Anchors name only files it will make has places, and the work branch making one is a move into it', async () => {
  const { advance, wt } = setup({ decision: '### DEC-1: x\n\n- **Anchors**: `src/new.ts`、`newdir/`\n', reference: null });
  assert.deepEqual(planTouchedPaths({ ...rec('IDD-001') }, wt), { known: true, paths: ['newdir/', 'src/new.ts'] });
  advance('other.txt');
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  advance('src/new.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.deepEqual(records('IDD-001')[0].attrs.files, ['src/new.ts']);
  assert.equal(records('IDD-001')[0].attrs.known, true);
});

test('a path written with its symbol names the file, and a reference kept as a table or several paths a line is read', () => {
  const reference = ['| path | why |', '| --- | --- |', '| `lib/dir/c.ts` | 見た |', '- `src/b.ts` / `docs/notes.md` — `lib/why/x.ts` を読む前に見た', ''].join('\n');
  const { wt } = setup({ decision: '### DEC-1: x\n\n- **Anchors**: `src/a.ts#runTick`、`AppTheme.primary`\n', reference });
  assert.deepEqual(planTouchedPaths({ ...rec('IDD-001') }, wt), { known: true, paths: ['docs/notes.md', 'lib/dir/c.ts', 'src/a.ts', 'src/b.ts'] });
});

test('a path with brackets (a route of Next.js) is one path, not a glob cut to its parent', async () => {
  const anchors = '`app/api/x/[id]/route.ts`、`app/[...slug]/page.tsx`、`src/**/*.ts`';
  const { advance, wt } = setup({ decision: `### DEC-1: x\n\n- **Anchors**: ${anchors}\n`, reference: null });
  assert.deepEqual(planTouchedPaths({ ...rec('IDD-001') }, wt), { known: true, paths: ['app/[...slug]/page.tsx', 'app/api/x/[id]/route.ts', 'src/'] });
  // a sibling route is not the plan's place
  advance('app/api/x/[other]/route.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, []);
  advance('app/api/x/[id]/route.ts');
  assert.deepEqual((await runBaseAdvance()).recorded, ['IDD-001']);
  assert.deepEqual(records('IDD-001')[0].attrs.files, ['app/api/x/[id]/route.ts']);
});

test('a lane whose fork and work branch are where it was last looked at runs no git past rev-parse, and none lists a tree', async () => {
  const { advance } = setup();
  advance('src/a.ts');
  const first = await gitCalls(() => runBaseAdvance());
  assert.equal(records('IDD-001').length, 1);
  assert.ok(!first.includes('ls-tree'), first.join(' '));

  assert.deepEqual(await gitCalls(() => runBaseAdvance()), ['rev-parse']);
  // a move elsewhere is looked at once, then not again
  advance('other.txt');
  assert.ok(!(await gitCalls(() => runBaseAdvance())).includes('ls-tree'));
  assert.deepEqual(await gitCalls(() => runBaseAdvance()), ['rev-parse']);

  // a stage that starts afresh (the server restarted) reads the fork, finds the last record's commits, and goes no further
  forgetBaseAdvanceChecks();
  const fresh = setup();
  fresh.advance('src/a.ts');
  await runBaseAdvance();
  forgetBaseAdvanceChecks();
  assert.deepEqual(await gitCalls(() => runBaseAdvance()), ['rev-parse', 'merge-base']);
  assert.equal(records('IDD-001').length, 1);
});

test('the tick keeps why the move could not be read, lane by lane', async () => {
  setup({ workBase: 'no-such-branch' });
  setAgentRunner({ deliver: async () => {} });
  const r = await runTick({ intake: false });
  setAgentRunner(null);
  assert.equal(r.baseAdvance.errors.length, 1);
  assert.equal(r.baseAdvance.errors[0].iddId, 'IDD-001');
  assert.match(r.baseAdvance.errors[0].error, /作業本流 no-such-branch/);
});

test('AC-012: a place named only in the work instruction is a place the plan touches; without one nothing changes', () => {
  const plain = setup({ decision: '### DEC-1: x\n\n- **What**: x\n' });
  const before = planTouchedPaths({ ...rec('IDD-001') }, plain.wt);
  assert.deepEqual(before.paths, ['docs/notes.md'], 'the reference alone when there is no plan');

  put(join(plain.wt, '_docs/plan/demo/idd-001/plan.md'), '# plan\n\n## Tasks\n- `src/b.ts` — 直す\n');
  const after = planTouchedPaths({ ...rec('IDD-001') }, plain.wt);
  assert.deepEqual(after.paths, ['docs/notes.md', 'src/b.ts'], 'the plan adds its own places');
  assert.equal(after.known, true);
});

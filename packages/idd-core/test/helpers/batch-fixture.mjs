// Shared fixture for the batch landing tests (not a test file itself): a work clone with a mainline branch and a lane
// per Issue, a fake runner that records the Issue closes, and the loop that carries a signed batch to its end.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './scratch.mjs';
import { commit, git, put } from '../stacked-fixture.mjs';
import { ensureLaneWorktree } from '../../src/worktree/ensure.ts';
import { seedLifecycle } from '../seed-lifecycle.mjs';
import { runningLandRuns } from '../../src/overlay/land-run.ts';
import { approveBatch, batchGroups, driveBatch, forgetAnswersForTests, landBatchContentFor, readBatch, batchRunning } from '../../src/overlay/batch.ts';
import { readLifecycle } from '../../src/ledger/read.ts';
import { verifiedNonceFor } from '../passkey-approval.mjs';
import { setAgentRunner } from '../../src/agent/port.ts';

const original = process.cwd();
export { commit, git, put };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(pred, ms = 30_000) {
  for (const end = Date.now() + ms; !pred(); await sleep(20)) if (Date.now() > end) throw new Error('待ちが timeout しました');
}

/** a work clone with `ids` as lanes; `checks` are the repo's land checks, `files` the files the base holds */
export function batchSetup({ ids = ['IDD-1', 'IDD-2'], checks = [], files = { 'app.txt': 'one\n', 'other.txt': 'one\n' }, extra = {} } = {}) {
  process.chdir(original);
  forgetAnswersForTests();
  const root = scratchDir('idd-batch-');
  const state = join(root, 'state');
  mkdirSync(state);
  const [work, remote, upstream] = ['work', 'remote.git', 'upstream'].map((name) => join(root, name));
  mkdirSync(work);
  for (const [name, text] of Object.entries({ '.gitignore': 'node_modules/\n', ...files })) put(join(work, name), text);
  // [directory, ...git arguments]: the bare remote, the work clone's first commit on main, an upstream clone, then the work branch with its overlay
  const steps = [[root, 'init', '--bare', '--initial-branch=main', remote], [work, 'init', '--initial-branch=main']];
  for (const [cwd, ...args] of steps) git(cwd, ...args);
  commit(work);
  for (const [cwd, ...args] of [[work, 'remote', 'add', 'origin', remote], [work, 'push', 'origin', 'main'], [root, 'clone', remote, upstream], [upstream, 'config', 'user.name', 'test'], [upstream, 'config', 'user.email', 'test@localhost'], [work, 'checkout', '-b', 'work-main']]) git(cwd, ...args);
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n');
  put(join(work, 'AGENTS.override.md'), 'private rules');
  commit(work);
  const config = {
    github: 'test/demo', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'),
    checks, publish: false, issue_lane: { context: 'personal', source_type_priority: 'github' }, ...extra,
  };
  const areas = join(root, 'repos.yaml');
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  const lanes = {};
  const backlog = [];
  const sessions = [];
  ids.forEach((id, i) => {
    const lane = ensureLaneWorktree('demo', id);
    lanes[id] = lane;
    backlog.push({ idd_id: id, area: 'demo', title: `feat: ${id}`, source_type: 'github', gh_issue_url: `https://github.com/test/demo/issues/${i + 1}` });
    sessions.push({ idd_id: id, worktree_path: lane.path, branch: lane.branch, executor_session_id: `s-${id}` });
  });
  for (const [name, rows] of Object.entries({ backlog, 'executor-sessions': sessions })) put(join(state, `${name}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  process.chdir(work);
  return { root, work, state, lanes, ids };
}

export const laneTip = (f, id) => git(f.lanes[id].path, 'rev-parse', 'HEAD');
export const mainTip = (f) => git(f.work, 'rev-parse', 'refs/heads/work-main');
export function change(f, id, writes, message) {
  for (const [name, text] of Object.entries(writes)) put(join(f.lanes[id].path, name), text);
  commit(f.lanes[id].path, message ?? `feat: ${id}`);
}

/** a commit on the work clone's own mainline, the way another lane's landing moves it */
export function moveMainline(f, writes, message = 'chore: mainline moves') {
  for (const [name, text] of Object.entries(writes)) put(join(f.work, name), text);
  commit(f.work, message);
}

/** put a lane at the submit confirmation so a landing card counts it */
export async function atShip(id) {
  for (const event of ['lane_open', 's2_start', 's2_result', 's3_ready', 's3_ok', 's4_submit_started']) await seedLifecycle(event, id, {});
}

/** a runner whose `postOutbound` records every Issue close it is asked to post */
export function closeRunner(extra = {}) {
  const posted = [];
  setAgentRunner({
    async postOutbound(opts) { posted.push(opts); return { id: `OUT-${posted.length}`, status: 'posted' }; },
    async queueOutbound() { return { id: 'OUT-q' }; },
    ...extra,
  });
  return posted;
}

/** sign the batch card for `keep` (all lanes when omitted) and press it: the signature is a verified nonce for exactly the content */
export async function press(approveBatch, group, keep) {
  const ids = keep ?? group.lanes.map((l) => l.iddId);
  const nonce = verifiedNonceFor(landBatchContentFor(group, ids));
  // each lane goes with the head and the close the card (`group`) showed, as the screen's press does
  const lanes = group.lanes.filter((l) => ids.includes(l.iddId)).map((l) => ({ iddId: l.iddId, head: l.head, close: l.close ?? null }));
  return approveBatch({ batch: group.id, lanes, nonce });
}

/** carry the batch on, pass by pass, until it ends; the check it starts is waited for between passes */
export async function carry(id, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    await waitFor(() => runningLandRuns().length === 0);
    const b = readBatch(id);
    if (!batchRunning(b)) return b;
    if (Date.now() > end) throw new Error(`まとめた取り込みが終わりません: ${JSON.stringify(b)}`);
    await driveBatch(id);
  }
}

export const OK = [{ name: 'ok', command: 'true', required: true }];
export const eventsOf = (id) => readLifecycle().filter((e) => e.idd_id === id);
export const eventNames = (id) => eventsOf(id).map((e) => e.event);
export const reachable = (f, id) => { try { git(f.work, 'merge-base', '--is-ancestor', laneTip(f, id), mainTip(f)); return true; } catch { return false; } };
/** the lanes in `on` are on the mainline and the lanes in `off` are not */
export function assertReach(f, on, off = []) {
  for (const id of on) assert.equal(reachable(f, id), true, id);
  for (const id of off) assert.equal(reachable(f, id), false, id);
}
/** the lanes still waiting on a batch card */
export const waiting = () => batchGroups().flatMap((g) => g.lanes.map((l) => l.iddId));
/** press the card and see that the press was taken */
export async function pressOk(group, keep) {
  const pressed = await press(approveBatch, group, keep);
  assert.equal(pressed.ok, true, pressed.error);
  return pressed;
}
/** the judge was never asked and the lane is left out as unresolved */
export function assertUnasked(f, seen, b, why = 'the judge is not asked') {
  assert.equal(seen.asked, 0, why);
  assertLeftOut(f, b);
}
/** what the mainline holds in `path` */
export const mainFile = (f, path = 'app.txt') => git(f.work, 'show', `work-main:${path}`);
/** each field of `want` holds in `actual` (deeply) */
export function assertHas(actual, want) {
  for (const [key, value] of Object.entries(want)) assert.deepEqual(actual[key], value, key);
}
/** how many times `event` is on the lane's own timeline */
export const countOf = (id, event) => eventsOf(id).filter((e) => e.event === event).length;
/** the lane stays where it was: not on the mainline, not closed */
export function assertStays(f, id) {
  assert.equal(reachable(f, id), false, id);
  assert.equal(countOf(id, 'lane_close'), 0, id);
}
export const droppedOf = (b) => b.dropped.map((d) => [d.iddId, d.kind]);

/** `changes` maps each lane id to the files it writes; the lanes are all at the submit confirmation */
export async function shipLanes(changes, setup = {}) {
  const f = batchSetup({ ids: Object.keys(changes), checks: OK, ...setup });
  for (const [id, writes] of Object.entries(changes)) change(f, id, writes);
  for (const id of f.ids) await atShip(id);
  return f;
}

/** two lanes that both add a line right after the same line (`dir` holds each one's plan), and a third that touches only its own file */
export const conflicting = (dir = '_docs/plan') => shipLanes({
  'IDD-1': { 'app.txt': 'one\nfrom one\n', [`${dir}/demo/idd-1/plan.md`]: '# plan one\n本文は app.txt に 1 行足す\n' },
  'IDD-2': { 'app.txt': 'one\nfrom two\n', [`${dir}/demo/idd-2/plan.md`]: '# plan two\n本文も app.txt に 1 行足す\n' },
  'IDD-3': { 'third.txt': 'from three\n' },
});

/** press the one card (the lanes in `keep`, all when omitted) and carry it to its end */
export async function pressAndCarry({ keep, ms } = {}) {
  const [group] = batchGroups();
  await pressOk(group, keep);
  return { group, b: await carry(group.id, ms) };
}

/** the batch ended as landed, with exactly `dropped` ([lane, kind] pairs) left out */
export function assertLanded(b, dropped = []) {
  assert.equal(b.phase, 'landed', JSON.stringify(b));
  assert.deepEqual(droppedOf(b), dropped);
}

/** the lane is left out for `kind` and its head is not on the mainline */
export function assertLeftOut(f, b, kind = 'unresolved', id = 'IDD-2') {
  assert.deepEqual(droppedOf(b), [[id, kind]]);
  assert.equal(reachable(f, id), false);
}

/** the conflict judge, answering with `answer` (or what the function returns for its input); `asked` counts the questions */
export function judge(answer) {
  const seen = { asked: 0, inputs: [] };
  closeRunner({
    async resolveLandConflict(input) {
      seen.asked += 1;
      seen.inputs.push(input);
      return typeof answer === 'function' ? answer(input) : answer;
    },
  });
  return seen;
}

/** an answer that keeps both lanes' line */
export const keepsBoth = (path = 'app.txt', content = 'one\nfrom one\nfrom two\n', rationale = '両方の行を残す') => ({ decision: 'keeps', rationale, files: [{ path, content, why: '別の行を足す' }] });
export const changes = (reason = '見るだけ') => ({ decision: 'changes', reason });

// shared fixture of the stacked-lane tests (not a test file itself)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { proposeForTests as propose, exportLane, readProposal, proposalPath, custodyPath } from '../src/overlay/export.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { setLaneBase } from '../src/overlay/base.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { pushApproval } from './passkey-approval.mjs';
import { scratchDir } from './helpers/scratch.mjs';

const original = process.cwd();
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_ALLOW_PROTOCOL: 'file', IDD_LANE_SCOPE: 'off' });
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const approveExport = (token, approval) => exportLane('IDD-1', token, pushApproval('IDD-1', approval));
export function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
export function commit(cwd, message = 'chore: fixture') { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); }
export const at = () => new Date(Date.now() - 60_000).toISOString();
export function event(f, iddId, name, attrs = {}) { appendFileSync(join(f.state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: iddId, event: name, at: at(), attrs }) + '\n'); }

/** a work clone with the parent lane IDD-1 on work-main; the child IDD-2 is in the backlog without a worktree yet */
export function setup(extra = {}) {
  process.chdir(original);
  const root = scratchDir('run-'); const work = join(root, 'work'), remote = join(root, 'remote.git'), upstream = join(root, 'upstream'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(work, 'init', '--initial-branch=main');
  put(join(work, '.gitignore'), 'node_modules/\n'); put(join(work, 'app.txt'), 'one\ntwo\nthree\n'); put(join(work, 'other.txt'), 'a\nb\nc\n'); commit(work);
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'main'); git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'test'); git(upstream, 'config', 'user.email', 'test@localhost');
  git(work, 'checkout', '-b', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\nAGENTS.override.md\n'); put(join(work, 'AGENTS.override.md'), 'private rules'); commit(work);
  const areas = join(root, 'repos.yaml'); const config = { github: 'test/project', upstream, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github', branch_name_pattern: 'idd/{idd_id}' }, ...extra };
  put(areas, JSON.stringify({ repos: { demo: config } })); Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, 'unused') });
  put(join(state, 'backlog.jsonl'), ['IDD-1', 'IDD-2', 'IDD-3'].map((id) => JSON.stringify({ idd_id: id, area: 'demo', title: `feat: ${id}` })).join('\n') + '\n');
  const parent = ensureLaneWorktree('demo', 'IDD-1');
  session(state, 'IDD-1', parent);
  for (const id of ['IDD-1', 'IDD-2', 'IDD-3']) appendFileSync(join(state, 'lifecycle-demo.jsonl'), JSON.stringify({ idd_id: id, event: 'lane_open', at: at(), attrs: {} }) + '\n');
  process.chdir(work);
  // the agent runtime is beside the overlay steps (as in the web UI), with no session in any checkout
  setAgentRunner({ cwdBusy: () => false });
  return { root, work, remote, upstream, state, parent, config, areas };
}
export function session(state, iddId, lane) { appendFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: iddId, worktree_path: lane.path, branch: lane.branch, executor_session_id: `s-${iddId}` }) + '\n'); }
/** export the parent lane's current head to its public branch */
export async function publishParent(f) {
  const p = await propose('IDD-1', { title: 'feat: parent', body: 'parent\n' }); assert.ok(!p.error, p.error); assert.equal(p.blocking, 0, JSON.stringify(p.checks));
  // a push goes out only with the commit message approved on the card
  const r = approveExport(p.token, { message: 'feat: parent' }); assert.equal(r.ok, true, r.error);
  const saved = readProposal('IDD-1'); saved.status = 'complete'; writeFileSync(proposalPath('IDD-1'), JSON.stringify(saved));
  return JSON.parse(readFileSync(custodyPath('IDD-1'), 'utf8'));
}
/** the child lane stacked on the parent, its worktree cut, waiting at GO (no agent at work) */
export async function child(f) {
  const set = await setLaneBase('IDD-2', { lane: 'IDD-1' }, 'manual'); assert.ok(!('error' in set), set.error);
  const lane = ensureLaneWorktree('demo', 'IDD-2'); session(f.state, 'IDD-2', lane);
  atGo(f, 'IDD-2');
  return lane;
}
/** the lane waits at GO: its planner is done and nothing works in its worktree */
export function atGo(f, iddId) { event(f, iddId, 's1_ready'); event(f, iddId, 's1_plan_review_skipped'); }
export const baseEvents = (id) => readLifecycle().filter((e) => e.idd_id === id && e.event === 'lane_base_set');


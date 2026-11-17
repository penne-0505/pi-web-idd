import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { agentHold, heldPrText, readHolds } from '../src/agent/inbound.ts';
import { runPrDrafts } from '../src/plan/pr-draft.ts';
import { buildSubmit, tryOpenSubmit } from '../src/plan/ship.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { appendLifecycle } from '../src/ledger/write.ts';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** a lane two stages in (its executor was started), with a worktree one commit ahead of main */
function setup(events = ['lane_open', 's1_go', 's2_start']) {
  const root = scratchDir('boundary-hold-');
  const state = join(root, 'state'); mkdirSync(state);
  const wt = join(root, 'wt'); mkdirSync(wt);
  git(wt, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(wt, 'a.txt'), 'a\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'init');
  git(wt, 'checkout', '-q', '-b', 'idd/IDD-1');
  writeFileSync(join(wt, 'README.md'), '# x\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'docs: 公開ファイルを整える');
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const lane = (id) => JSON.stringify({ idd_id: id, area: 'me/app', title: `Lane ${id}`, context: '', gh_issue_url: 'https://github.com/me/app/issues/1' });
  writeFileSync(join(state, 'backlog.jsonl'), `${lane('IDD-1')}\n${lane('IDD-2')}\n`);
  writeFileSync(join(state, 'executor-sessions.jsonl'), `${JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'S1', worktree_path: wt, branch: 'idd/IDD-1' })}\n`);
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), events.map((e) => JSON.stringify({ idd_id: 'IDD-1', event: e, at, attrs: {} })).join('\n') + '\n');
  return { state, wt };
}

const names = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1').map((e) => e.event);

test('a held push is the executor\'s report: it is recorded once and the lane goes on to review', async () => {
  const { state } = setup();
  const held = await agentHold({ iddId: 'IDD-1', kind: 'push' });
  assert.equal(held.ok, true);
  assert.deepEqual(names().filter((n) => n === 's2_result'), ['s2_result']);
  const result = readLifecycle().find((e) => e.event === 's2_result');
  assert.equal(result.attrs.outcome, 'success');
  assert.deepEqual(result.attrs.qa_verified, [], 'a hold verifies nothing');
  // a second hold in the same round does not report again
  const again = await agentHold({ iddId: 'IDD-1', kind: 'push' });
  assert.equal(again.ok, true);
  assert.equal(names().filter((n) => n === 's2_result').length, 1);
  assert.equal(readHolds('IDD-1').length, 2);
  assert.ok(readFileSync(join(state, 'boundary-holds.jsonl'), 'utf8').includes('"kind":"push"'));
});

test('a held PR creation is the draft the submit card starts from, however late the submit started', async () => {
  setup();
  const held = await agentHold({ iddId: 'IDD-1', kind: 'pr-create', title: 'docs: keep the public files', body: 'Tidy the docs.\n\n- one\n- two' });
  assert.equal(held.ok, true);
  assert.deepEqual(heldPrText('IDD-1'), { title: 'docs: keep the public files', body: 'Tidy the docs.\n\n- one\n- two' });
  // the lane goes through review and S3 as it does after a report, and the submit starts after the hold: a draft
  // recorded at the hold would be older than that start and read as the draft of a submit that is over
  for (const e of ['s2_review_converged', 's2_device_skipped', 's3_ready']) await appendLifecycle(e, 'IDD-1', {});
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  assert.ok(!('error' in await tryOpenSubmit('IDD-1')), 'the submit card opens the way the tick opens it');
  assert.ok(names().indexOf('s4_submit_started') > names().indexOf('s2_result'));
  assert.ok(!names().includes('s4_pr_drafted'), 'the hold itself writes no draft');
  // the drafting stage asks the runner, and the runner answers with the held text (the engine's runner does this first)
  const asked = [];
  setAgentRunner({ deliver: async () => {}, draftPrText: async ({ lane }) => { asked.push(lane); return { ...heldPrText(lane), model: 'agent' }; } });
  await runPrDrafts();
  assert.deepEqual(asked, ['IDD-1']);
  const view = buildSubmit('IDD-1');
  assert.equal(view.pr.title, 'docs: keep the public files');
  // the agent's own text, as it was handed over: no Issue line is put in front, and the card says the line is missing
  assert.equal(view.pr.draftBody, 'Tidy the docs.\n\n- one\n- two');
  const notice = view.checks.find((c) => c.label === 'PR の本文に Issue の行が無い');
  assert.equal(notice?.ok, false);
  assert.match(notice.reason, /Issue を閉じる行が無いので、merge しても Issue は閉じません/);
});

test('a held body that already names the Issue shows no missing-line notice', async () => {
  setup();
  await agentHold({ iddId: 'IDD-1', kind: 'pr-create', title: 'docs: keep the public files', body: 'Closes https://github.com/me/app/issues/1\n\nTidy the docs.' });
  for (const e of ['s2_review_converged', 's2_device_skipped', 's3_ready']) await appendLifecycle(e, 'IDD-1', {});
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  await tryOpenSubmit('IDD-1');
  setAgentRunner({ deliver: async () => {}, draftPrText: async ({ lane }) => ({ ...heldPrText(lane), model: 'agent' }) });
  await runPrDrafts();
  const view = buildSubmit('IDD-1');
  assert.equal(view.pr.draftBody, 'Closes https://github.com/me/app/issues/1\n\nTidy the docs.');
  assert.ok(!view.checks.some((c) => c.label === 'PR の本文に Issue の行が無い'));
});

test('a held text answers the submit it was made for and no later one', async () => {
  setup();
  await agentHold({ iddId: 'IDD-1', kind: 'pr-create', title: 'docs: keep the public files', body: 'Tidy the docs.' });
  for (const e of ['s2_review_converged', 's2_device_skipped', 's3_ready']) await appendLifecycle(e, 'IDD-1', {});
  await appendLifecycle('s3_ok', 'IDD-1', { at_by: 'auto' });
  await tryOpenSubmit('IDD-1');
  assert.equal(heldPrText('IDD-1')?.title, 'docs: keep the public files', 'still the answer until a draft has been recorded');
  setAgentRunner({ deliver: async () => {}, draftPrText: async ({ lane }) => ({ ...heldPrText(lane), model: 'agent' }) });
  await runPrDrafts();
  assert.equal(readLifecycle().filter((e) => e.event === 's4_pr_drafted').length, 1);
  // the draft is the hold's answer: a submit that comes after it has no text of the agent's to start from
  assert.equal(heldPrText('IDD-1'), null);
  await new Promise((r) => setTimeout(r, 1100));
  // ... until the agent holds a new one
  await agentHold({ iddId: 'IDD-1', kind: 'pr-create', title: 'fix: the second round', body: 'Again.' });
  assert.deepEqual(heldPrText('IDD-1'), { title: 'fix: the second round', body: 'Again.' });
});

test('a PR creation without a title takes the report but leaves no draft', async () => {
  setup();
  assert.equal((await agentHold({ iddId: 'IDD-1', kind: 'pr-create' })).ok, true);
  assert.equal(heldPrText('IDD-1'), null);
  assert.ok(names().includes('s2_result'));
});

test('a lane that has not begun implementing, or is not a lane, is not held and nothing is written', async () => {
  setup(['lane_open', 's1_ready']);
  const early = await agentHold({ iddId: 'IDD-1', kind: 'push' });
  assert.equal(early.ok, false);
  const none = await agentHold({ iddId: 'IDD-9', kind: 'push' });
  assert.equal(none.ok, false);
  assert.deepEqual(names(), ['lane_open', 's1_ready']);
  assert.deepEqual(readHolds('IDD-1'), []);
});

test('the holds read back are the asking lane\'s own', async () => {
  const { state } = setup();
  appendFileSync(join(state, 'lifecycle-me-app.jsonl'), `${JSON.stringify({ idd_id: 'IDD-2', event: 's2_start', at: new Date().toISOString(), attrs: {} })}\n`);
  await agentHold({ iddId: 'IDD-1', kind: 'push' });
  await agentHold({ iddId: 'IDD-2', kind: 'push' });
  assert.deepEqual(readHolds('IDD-1').map((h) => h.idd_id), ['IDD-1']);
  assert.deepEqual(readHolds('IDD-2').map((h) => h.idd_id), ['IDD-2']);
});

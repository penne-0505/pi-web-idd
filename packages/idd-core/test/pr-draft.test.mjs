import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { runPrDrafts } from '../src/plan/pr-draft.ts';
import { buildSubmit } from '../src/plan/ship.ts';
import { draftCommitMessage } from '../src/plan/pr-draft.ts';
import { proposalPath } from '../src/overlay/export.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { draftedConventions } from '../src/overlay/conventions-read.ts';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function setup(backlog = { gh_issue_url: 'https://github.com/me/app/issues/1' }, repo = {}, events = ['lane_open', 's1_go', 's2_start', 's4_submit_started']) {
  const root = scratchDir('pr-draft-');
  const state = join(root, 'state'); mkdirSync(state);
  const wt = join(root, 'wt'); mkdirSync(wt);
  git(wt, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(wt, 'a.txt'), 'a\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'init');
  git(wt, 'checkout', '-q', '-b', 'idd/IDD-1');
  writeFileSync(join(wt, 'README.md'), '# x\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'docs: 公開ファイルを整える');
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main', ...repo } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', area: 'me/app', title: 'Keep the public files', context: '', ...backlog }) + '\n');
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'S1', worktree_path: wt, branch: 'idd/IDD-1' }) + '\n');
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), events.map((e) => (typeof e === 'string' ? { event: e, attrs: {} } : e)).map(({ event, attrs }) => JSON.stringify({ idd_id: 'IDD-1', event, at, attrs })).join('\n') + '\n');
  return { wt };
}

test('a lane at the submit card gets its PR title and body drafted once, and the card starts from them', async () => {
  setup();
  const materials = [];
  setAgentRunner({ deliver: async () => {}, draftPrText: async ({ repo, material, lane, revise }) => { materials.push({ repo, material, lane, revise }); return { title: 'docs: keep the public files', body: 'Closes #1\n\n- tidy the docs', model: 'm' }; } });
  const r = await runPrDrafts();
  assert.deepEqual(r.drafted, ['IDD-1']);
  assert.equal(materials[0].repo, 'me/app');
  assert.equal(materials[0].lane, 'IDD-1', 'the writer is told which lane it writes for');
  assert.equal(materials[0].revise, undefined, 'a new draft is not a revision: its checks apply');
  assert.match(materials[0].material, /issues\/1/);
  assert.match(materials[0].material, /README\.md/);
  assert.match(materials[0].material, /公開ファイルを整える/);
  await runPrDrafts();
  assert.equal(materials.length, 1, 'drafted once per submit');
  const view = buildSubmit('IDD-1');
  assert.equal(view.pr.title, 'docs: keep the public files');
  assert.equal(view.pr.draftBody, 'Closes #1\n\n- tidy the docs');
});

test('a failed draft is recorded and the card keeps the plain list', async () => {
  setup();
  setAgentRunner({ deliver: async () => {}, draftPrText: async () => { throw new Error('429'); } });
  const r = await runPrDrafts();
  assert.equal(r.errors.length, 1);
  assert.ok(readLifecycle().some((e) => e.event === 's4_pr_draft_failed'));
  await runPrDrafts();
  assert.equal(readLifecycle().filter((e) => e.event === 's4_pr_draft_failed').length, 1, 'not retried on every tick');
  assert.equal(buildSubmit('IDD-1').pr.draftBody, undefined);
});

test('a GitHub lane names its Issue with Closes; a Linear lane keeps its URL out of the PR body and the draft material', async () => {
  setup();
  assert.deepEqual(buildSubmit('IDD-1').pr.body.map((b) => b.text).filter((t) => t.startsWith('Closes')), ['Closes https://github.com/me/app/issues/1']);

  setup({ source_type: 'linear', gh_issue_url: null, linear_issue_url: 'https://linear.app/org/issue/APP-7' });
  const materials = [];
  setAgentRunner({ deliver: async () => {}, draftPrText: async ({ material }) => { materials.push(material); return { title: 'docs: x', body: 'y', model: 'm' }; } });
  const view = buildSubmit('IDD-1');
  assert.ok(!view.pr.body.some((b) => b.text.startsWith('Closes')));
  assert.ok(!JSON.stringify(view.pr.body).includes('linear.app'));
  await runPrDrafts();
  assert.equal(materials.length, 1);
  assert.doesNotMatch(materials[0], /linear\.app|APP-7|Issue:/);
});

test('a Linear lane names its Issue the way the repo writes it: a link, or Closes', async () => {
  const linear = { source_type: 'linear', gh_issue_url: null, linear_issue_url: 'https://linear.app/org/issue/APP-7' };
  setup(linear, { pr_linear_reference: 'link' });
  const materials = [];
  setAgentRunner({ deliver: async () => {}, draftPrText: async ({ material }) => { materials.push(material); return { title: 'docs: x (APP-7)', body: 'y', model: 'm' }; } });
  const linked = buildSubmit('IDD-1').pr.body;
  assert.equal(linked[0].text, '[APP-7](https://linear.app/org/issue/APP-7)');
  assert.ok(!linked.some((b) => b.text.startsWith('Closes')));
  await runPrDrafts();
  assert.match(materials[0], /<issue-url>https:\/\/linear\.app\/org\/issue\/APP-7<\/issue-url>/);
  // the Issue line is not read as one of the decisions
  assert.doesNotMatch(materials[0], /- \[APP-7\]/);

  setup(linear, { pr_linear_reference: 'closes' });
  assert.deepEqual(buildSubmit('IDD-1').pr.body.filter((b) => b.text.includes('linear.app')).map((b) => b.text), ['Closes https://linear.app/org/issue/APP-7']);
});

test('the Issue line in the body a PR goes out with (the card starts from it) follows the repo, not the drafter', async () => {
  const linear = { source_type: 'linear', gh_issue_url: null, linear_issue_url: 'https://linear.app/org/issue/APP-7' };
  const draftWith = (body) => setAgentRunner({ deliver: async () => {}, draftPrText: async () => ({ title: 'docs: x (APP-7)', body, model: 'm' }) });
  // link: a Closes the drafter wrote anyway is replaced by the link line
  setup(linear, { pr_linear_reference: 'link' });
  draftWith('Closes https://linear.app/org/issue/APP-7\n\n- y');
  await runPrDrafts();
  assert.equal(buildSubmit('IDD-1').pr.draftBody, '[APP-7](https://linear.app/org/issue/APP-7)\n\n- y');
  // a line that already names the Issue the precedent's way is kept, not doubled
  setup(linear, { pr_linear_reference: 'link' });
  draftWith('- 関連: [APP-7](https://linear.app/org/issue/APP-7)\n- y');
  await runPrDrafts();
  assert.equal(buildSubmit('IDD-1').pr.draftBody, '- 関連: [APP-7](https://linear.app/org/issue/APP-7)\n- y');
  // closes
  setup(linear, { pr_linear_reference: 'closes' });
  draftWith('- y');
  await runPrDrafts();
  assert.equal(buildSubmit('IDD-1').pr.draftBody, 'Closes https://linear.app/org/issue/APP-7\n\n- y');
  // no setting: nothing about the Linear Issue
  setup(linear);
  draftWith('- y');
  await runPrDrafts();
  assert.equal(buildSubmit('IDD-1').pr.draftBody, '- y');
  // a GitHub lane gets its Closes even when the drafter left it out
  setup();
  draftWith('- tidy the docs');
  await runPrDrafts();
  assert.equal(buildSubmit('IDD-1').pr.draftBody, 'Closes https://github.com/me/app/issues/1\n\n- tidy the docs');
});

test('the recorded draft already carries the Issue line in the repo\'s form, which is what the card and the PR start from', async () => {
  const { prDraftOf } = await import('../src/plan/ship.ts');
  const recorded = () => prDraftOf(readLifecycle().filter((e) => e.idd_id === 'IDD-1'));
  const sections = '## Summary\n\n- tidy the docs\n\n## Test plan\n\n- read it';
  const draftWith = (body) => setAgentRunner({ deliver: async () => {}, draftPrText: async () => ({ title: 'docs: keep the public files', body, model: 'm' }) });
  // a GitHub lane: Closes with the Issue, put before the template's sections, none of which is lost
  setup();
  draftWith(sections);
  await runPrDrafts();
  assert.deepEqual(recorded(), { title: 'docs: keep the public files', body: `Closes https://github.com/me/app/issues/1\n\n${sections}` });
  const linear = { source_type: 'linear', gh_issue_url: null, linear_issue_url: 'https://linear.app/org/issue/APP-7' };
  for (const [reference, line] of [['link', '[APP-7](https://linear.app/org/issue/APP-7)'], ['closes', 'Closes https://linear.app/org/issue/APP-7'], [undefined, null]]) {
    setup(linear, reference ? { pr_linear_reference: reference } : {});
    draftWith(sections);
    await runPrDrafts();
    assert.equal(recorded().body, line ? `${line}\n\n${sections}` : sections, `pr_linear_reference: ${reference}`);
  }
});

test('a lane without a draft starts the card from a body that closes the Issue', async () => {
  setup();
  setAgentRunner({ deliver: async () => {}, draftPrText: async () => { throw new Error('429'); } });
  await runPrDrafts();
  const view = buildSubmit('IDD-1');
  assert.equal(view.pr.draftBody, undefined);
  assert.equal(view.pr.body[0].text, 'Closes https://github.com/me/app/issues/1');
});

test('the drafter\'s material names the Issue only for reference', async () => {
  setup({ source_type: 'linear', gh_issue_url: null, linear_issue_url: 'https://linear.app/org/issue/APP-7' }, { pr_linear_reference: 'link' });
  const materials = [];
  setAgentRunner({ deliver: async () => {}, draftPrText: async ({ material }) => { materials.push(material); return { title: 'x', body: 'y', model: 'm' }; } });
  await runPrDrafts();
  assert.match(materials[0], /<issue-url>https:\/\/linear\.app/);
  assert.doesNotMatch(materials[0], /Closes/);
});


// --- blind review round 8: the lane's PR as the records have it ---

const PR = { event: 's4_pr_created', attrs: { pr_url: 'https://github.com/me/app/pull/3', pr_number: 3, commit: 'c1' } };
const withPr = (...after) => ['lane_open', 's1_go', 's2_start', 's4_submit_started', PR, ...after, 's4_submit_started'];
const drafting = (materials) => ({
  deliver: async () => {},
  draftPrText: async ({ material }) => { materials.push(material); return { title: 'fix: 新しい PR', body: '本文', model: 'm' }; },
  draftCommitMessage: async ({ material }) => { materials.push(material); return { message: 'fix: x', model: 'm' }; },
});

test('a lane whose PR is open gets no new PR text, and its push is written as the PR\'s next revision', async () => {
  const { wt } = setup(undefined, {}, withPr());
  const materials = [];
  setAgentRunner(drafting(materials));
  assert.deepEqual((await runPrDrafts()).drafted, []);
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  assert.equal(await draftCommitMessage('IDD-1', head, { commits: ['fix: x'], publish: ['a.txt'] }), 'drafted');
  assert.match(materials.at(-1), /PR #3 の次の版/);
});

for (const [why, after] of [
  ['was found not open after a push', { event: 's4_push_held', attrs: { head: 'h', reason: 'r', no_open_pr: true } }],
  ['had its branch found gone after a push', { event: 's4_ship_failed', attrs: { error: 'e', branch_gone: true } }],
]) {
  test(`a lane whose PR ${why} gets its new PR's text drafted, and its push is not written as the closed PR's next revision`, async () => {
    const { wt } = setup(undefined, {}, withPr(after));
    const materials = [];
    setAgentRunner(drafting(materials));
    assert.deepEqual((await runPrDrafts()).drafted, ['IDD-1']);
    assert.equal(buildSubmit('IDD-1').existingPr, undefined);
    const head = git(wt, 'rev-parse', 'HEAD').trim();
    await draftCommitMessage('IDD-1', head, { commits: ['fix: x'], publish: ['a.txt'] });
    assert.doesNotMatch(materials.at(-1), /次の版/);
    assert.match(materials.at(-1), /新しい PR/);
  });
}

test('a lane last checked while its branch was gone gets its new PR\'s text drafted', async () => {
  const { wt } = setup(undefined, {}, withPr());
  writeFileSync(proposalPath('IDD-1'), JSON.stringify({ iddId: 'IDD-1', status: 'prepared', head: git(wt, 'rev-parse', 'HEAD').trim(), branchGone: { tip: 'c1', merged: true, pr: 3 } }));
  const materials = [];
  setAgentRunner(drafting(materials));
  assert.deepEqual((await runPrDrafts()).drafted, ['IDD-1']);
});

test('a new PR after the closed one resets it: the lane waits on the new PR as open', async () => {
  setup(undefined, {}, withPr({ event: 's4_push_held', attrs: { head: 'h', reason: 'r', no_open_pr: true } }, { event: 's4_pr_created', attrs: { pr_url: 'https://github.com/me/app/pull/4', pr_number: 4 } }));
  setAgentRunner(drafting([]));
  assert.deepEqual((await runPrDrafts()).drafted, []);
  assert.equal(buildSubmit('IDD-1').existingPr?.number, 4);
});

test('the sections a draft read are recorded with each draft, for the card\'s first check to compare with', async () => {
  const { wt } = setup();
  const pr = [{ kind: 'pr', file: 'S.md', section: '## PR', hash: 'a'.repeat(64) }];
  const commit = [{ kind: 'commit', file: 'S.md', section: '## Commit', hash: 'b'.repeat(64) }];
  setAgentRunner({
    deliver: async () => {},
    draftPrText: async () => ({ title: 'fix: x', body: 'y', model: 'm', conventions: pr }),
    draftCommitMessage: async () => ({ message: 'fix: x', model: 'm', conventions: commit }),
  });
  await runPrDrafts();
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  await draftCommitMessage('IDD-1', head, { commits: ['fix: x'], publish: ['a.txt'] });
  const evs = readLifecycle().filter((e) => e.idd_id === 'IDD-1');
  assert.deepEqual(draftedConventions(evs, head), [...pr, ...commit]);
  // the commit draft is the head's own: another head reads only the round's PR draft
  assert.deepEqual(draftedConventions(evs, 'f'.repeat(40)), pr);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { listIntakeCandidates, runIntake } from '../src/intake/run.ts';
import { ignoreByRef } from '../src/intake/ignore-resolve.ts';
import { readBacklog, readLifecycle } from '../src/ledger/read.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';
import { runTick } from '../src/plan/tick.ts';
import lockfile from 'proper-lockfile';

const labelled = (number, extra = {}) => ({ number, labels: ['idd-ready'], state: 'open', ...extra });

/**
 * A gh that knows `issues` ({ 'owner/name': [{ number, labels, state, pr? }] }). `issue list` honours --label and
 * lists open Issues only; `api repos/<repo>/issues/<n>` answers like the REST API (a pull request carries
 * `pull_request`, a number the repo lacks is a 404). Every call is logged.
 */
function setup(issues = { 'a/one': [labelled(1)], 'a/two': [labelled(1)] }, repoNames = ['a/one', 'a/two']) {
  const root = scratchDir('run-');
  const state = join(root, 'state'); mkdirSync(state);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const data = join(root, 'issues.json'); writeFileSync(data, JSON.stringify(issues));
  const log = join(root, 'gh.log');
  const stub = join(bin, 'gh');
  writeFileSync(stub, `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const all = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
const shape = (repo, i) => ({ number: i.number, title: 'title ' + i.number + ' in ' + repo, body: 'body ' + i.number, createdAt: '2026-09-23T00:00:00Z' });
const blockerNodes = (repo, i) => (i.blockedBy ?? []).map((b) => {
  const r = b.repo ?? repo;
  const url = b.noUrl ? undefined : (b.url ?? (b.number === undefined ? undefined : 'https://github.com/' + r + '/issues/' + b.number));
  // gh 2.101 drops the repository field from the node; a test that wants it sets b.repository (DEC-1923)
  return { id: b.id ?? 'I_b_' + b.number, title: 'blocker ' + b.number, ...(b.number === undefined ? {} : { number: b.number }), ...(url === undefined ? {} : { url }), ...(b.state === undefined ? {} : { state: b.state }), ...(b.repository === undefined ? {} : { repository: { nameWithOwner: b.repository } }) };
});
if (a[0] === 'issue' && a[1] === 'list') {
  const repo = a[a.indexOf('--repo') + 1];
  if ((all.__failList ?? []).includes(repo)) { process.stderr.write('gh: Server Error (HTTP 502)\\n'); process.exit(1); }
  // the recorded answer of gh 2.101, returned as it is (the fixture already carries the filtered labels)
  if (all.__listRaw && all.__listRaw[repo]) { console.log(JSON.stringify(all.__listRaw[repo])); }
  else {
    const want = a.flatMap((x, k) => (x === '--label' ? [a[k + 1]] : []));
    const open = (all[repo] ?? []).filter((i) => !i.pr && i.state === 'open' && want.every((l) => i.labels.includes(l)));
    console.log(JSON.stringify(open.map((i) => ({ ...shape(repo, i), url: 'https://github.com/' + repo + '/issues/' + i.number, labels: i.labels.map((name) => ({ name })), blockedBy: { nodes: blockerNodes(repo, i), totalCount: i.blockedTotal ?? (i.blockedBy ?? []).length } }))));
  }
} else if (a[0] === 'api') {
  const m = /^repos\\/([^/]+\\/[^/]+)\\/issues\\/(\\d+)$/.exec(a.find((x) => x.startsWith('repos/')) ?? '');
  if (m && (all.__fail ?? []).includes(m[1])) { process.stderr.write('gh: Server Error (HTTP 502)\\n'); process.exit(1); }
  const i = m && (all[m[1]] ?? []).find((x) => x.number === Number(m[2]));
  if (!i) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  const s = shape(m[1], i);
  console.log(JSON.stringify({ number: s.number, title: s.title, body: s.body, created_at: s.createdAt, state: i.state,
    // a transferred Issue: gh follows the redirect and answers with the Issue where it is now
    html_url: i.movedTo ? 'https://github.com/' + i.movedTo.replace('#', '/issues/') : 'https://github.com/' + m[1] + (i.pr ? '/pull/' : '/issues/') + i.number,
    labels: i.labels.map((name) => ({ name })), ...(i.pr ? { pull_request: { url: 'x' } } : {}) }));
} else { process.stderr.write('unexpected gh ' + a.join(' ') + '\\n'); process.exit(2); }
`);
  chmodSync(stub, 0o755);
  const lane = { context: 'personal', source_type_priority: 'github', intake_filter: { github_labels: ['idd-ready'] } };
  const reposFile = join(root, 'repos.yaml');
  const repoEntries = Object.fromEntries(repoNames.map((r, k) => [r, { upstream: join(root, `u${k}`), work: join(root, `w${k}`), issue_lane: lane }]));
  writeFileSync(reposFile, JSON.stringify({ repos: repoEntries }));
  Object.assign(process.env, { IDD_REPOS_FILE: reposFile, IDD_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { calls, root, state, data, log };
}

test('a bare Issue number that several repos have is not taken in; owner/name#N picks one', async () => {
  setup();
  const bare = await runIntake({ issueRefs: [{ number: 1 }] });
  assert.deepEqual(bare.added, []);
  assert.match(bare.failures.map((f) => f.reason).join(' '), /a\/one.*a\/two/);
  const picked = await runIntake({ issueRefs: [{ repo: 'a/two', number: 1 }] });
  assert.equal(picked.added.length, 1);
  assert.deepEqual(readBacklog().map((r) => r.area), ['a/two']);
});

test('a GitHub Issue whose lane was landed into the work side is not taken in again unless named', async () => {
  setup({ 'a/one': [labelled(1)], 'a/two': [] });
  // a lane for a/one#1 that ended by landing into the work side's mainline (lane_close with the merge commit)
  writeFileSync(join(process.env.IDD_STATE_DIR, 'backlog.jsonl'),
    JSON.stringify({ idd_id: 'IDD-1', area: 'a/one', title: 't', source_type: 'github', gh_issue_url: 'https://github.com/a/one/issues/1' }) + '\n');
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lifecycle-a-one.jsonl'),
    JSON.stringify({ event: 'lane_open', idd_id: 'IDD-1', at: '2026-09-01T00:00:00+09:00', attrs: {} }) + '\n'
    + JSON.stringify({ event: 'lane_close', idd_id: 'IDD-1', at: '2026-09-02T00:00:00+09:00', attrs: { outcome: 'local', merged_commit: 'abc' } }) + '\n');
  const unnamed = await runIntake({});
  assert.deepEqual(unnamed.added, []);
  assert.match(unnamed.skipped.map((s) => s.reason).join(' '), /取り込みで閉じた/);
  const named = await runIntake({ issueRefs: [{ repo: 'a/one', number: 1 }] });
  assert.equal(named.added.length, 1);
});

test('a GitHub Issue without the intake label is taken in when named by number, and not when unnamed', async () => {
  const { calls } = setup({
    'a/one': [labelled(1), { number: 2, labels: [], state: 'open' }, { number: 3, labels: [], state: 'open', pr: true }, { number: 4, labels: [], state: 'closed' }],
    'a/two': [labelled(1)],
  });
  // unnamed: only the labelled Issues
  const list = await listIntakeCandidates();
  assert.deepEqual(list.candidates.map((c) => `${c.area}${c.ref}`).sort(), ['a/one#1', 'a/two#1']);
  const all = await runIntake();
  assert.deepEqual(readBacklog().map((r) => r.gh_issue_url).sort(), ['https://github.com/a/one/issues/1', 'https://github.com/a/two/issues/1']);
  assert.equal(all.added.length, 2);

  // named: #2 has no label; bare, only a/one has it
  const before = calls().length;
  const named = await runIntake({ issueRefs: [{ number: 2 }] });
  assert.deepEqual([named.unmatched, named.failures], [[], []]);
  assert.equal(named.added.length, 1);
  const rec = readBacklog().find((r) => r.idd_id === named.added[0]);
  assert.deepEqual([rec.gh_issue_url, rec.area, rec.title, rec.context], ['https://github.com/a/one/issues/2', 'a/one', 'title 2 in a/one', 'body 2']);
  // the named run reads the Issue itself, with GET, and lists nothing
  const namedCalls = calls().slice(before);
  assert.ok(namedCalls.length > 0);
  for (const c of namedCalls) {
    assert.equal(c[0], 'api');
    assert.deepEqual(c.slice(1, 3), ['--method', 'GET']);
  }
  // owner/name#N too
  const qualified = await runIntake({ issueRefs: [{ repo: 'a/one', number: 2 }] });
  assert.deepEqual(qualified.duplicates.map((d) => d.url), ['https://github.com/a/one/issues/2']);

  // a pull request, a closed Issue and a number no repo has are not Issues open for intake
  const others = await runIntake({ issueRefs: [{ repo: 'a/one', number: 3 }, { repo: 'a/one', number: 4 }, { number: 99 }] });
  assert.deepEqual([others.added, others.unmatched, others.failures], [[], [3, 4, 99], []]);
});

test('a named GitHub Issue whose lane closed comes back as a requeue of the old lane', async () => {
  setup({ 'a/one': [{ number: 5, labels: [], state: 'open' }], 'a/two': [] });
  const first = await runIntake({ issueRefs: [{ repo: 'a/one', number: 5 }] });
  const lane = first.added[0];
  await seedLifecycle('lane_close', lane, { outcome: 'abandoned' });
  const back = await runIntake({ issueRefs: [{ repo: 'a/one', number: 5 }] });
  assert.equal(back.added.length, 1);
  const opened = readLifecycle().find((e) => e.idd_id === back.added[0] && e.event === 'lane_open');
  assert.equal(opened.attrs.requeued_from, lane);
});

test('a repo gh cannot read is one failure line, and a bare number is not guessed from the repos that answered', async () => {
  setup({ 'a/one': [{ number: 2, labels: [], state: 'open' }], __fail: ['a/two'] });
  const bare = await runIntake({ issueRefs: [{ number: 2 }] });
  assert.deepEqual([bare.added, bare.unmatched], [[], []]);
  assert.deepEqual(bare.failures.map((f) => f.area), ['a/two']);
  assert.match(bare.failures[0].reason, /HTTP 502/);
  // owner/name#N reads that repo only; a repo that is not an intake repo names nothing
  const picked = await runIntake({ issueRefs: [{ repo: 'a/one', number: 2 }, { repo: 'b/none', number: 2 }] });
  assert.equal(picked.added.length, 1);
  assert.deepEqual([picked.unmatched, picked.failures], [[2], []]);
});

test('a GitHub Issue moved to another repo is not taken in as a lane of the repo it was named in', async () => {
  setup({ 'a/one': [{ number: 2, labels: [], state: 'open', movedTo: 'b/else#7' }, { number: 3, labels: [], state: 'open' }], 'a/two': [] });
  const r = await runIntake({ issueRefs: [{ repo: 'a/one', number: 2 }, { number: 2 }] });
  assert.deepEqual([r.added, r.unmatched, r.failures], [[], [2, 2], []]);
  assert.deepEqual(r.skipped.map((x) => x.ref), ['a/one#2', 'a/one#2']);
  assert.match(r.skipped[0].reason, /b\/else#7/);
  assert.deepEqual(readBacklog(), []);
  // the URL gh answers with is compared without case
  const same = await runIntake({ issueRefs: [{ repo: 'a/one', number: 3 }] });
  assert.equal(same.added.length, 1);
});

test('the URL gh answers with may differ from the named repo only in case', async () => {
  setup({ 'a/one': [{ number: 3, labels: [], state: 'open', movedTo: 'A/One#3' }], 'a/two': [] });
  const r = await runIntake({ issueRefs: [{ repo: 'a/one', number: 3 }] });
  assert.deepEqual([r.unmatched, r.skipped], [[], []]);
  assert.equal(r.added.length, 1);
});

test('a named ask and an ask for every Issue that meet in the tick queue both run', { timeout: 60_000 }, async () => {
  const issues = { 'a/one': [labelled(1), { number: 2, labels: [], state: 'open' }], 'a/two': [] };
  const urls = () => readBacklog().map((r) => r.gh_issue_url).sort();
  const want = ['https://github.com/a/one/issues/1', 'https://github.com/a/one/issues/2'];

  // a named ask was left while a tick ran; the next tick asks for every Issue
  setup(issues);
  process.env.IDD_LINEAR_KEY_FILE = '/nonexistent/linear-api-key'; delete process.env.LINEAR_API_KEY;
  writeFileSync(join(process.env.IDD_STATE_DIR, 'tick.again.intake'), JSON.stringify({ issueRefs: [{ repo: 'a/one', number: 2 }] }));
  const first = await runTick({});
  assert.deepEqual(urls(), want);
  assert.deepEqual(first.intake.unmatched, []);

  // the other way round: an ask for every Issue was left, the tick names one
  setup(issues);
  writeFileSync(join(process.env.IDD_STATE_DIR, 'tick.again.intake'), JSON.stringify({ all: true }));
  const second = await runTick({ issueRefs: [{ repo: 'a/one', number: 2 }] });
  assert.deepEqual(urls(), want);
  assert.equal(second.intake.added.length, 2);
});

test('one run for every Issue and a named one takes an Issue both find once, without a duplicate line', async () => {
  setup({ 'a/one': [labelled(1), { number: 2, labels: [], state: 'open' }], 'a/two': [] });
  const r = await runIntake({ all: true, issueRefs: [{ repo: 'a/one', number: 1 }, { repo: 'a/one', number: 2 }] });
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(readBacklog().map((b) => b.gh_issue_url).sort(), ['https://github.com/a/one/issues/1', 'https://github.com/a/one/issues/2']);
});

/** the tick's own lock, held as a running tick holds it */
async function holdTickLock() {
  const target = join(process.env.IDD_STATE_DIR, 'tick.lock');
  if (!existsSync(target)) writeFileSync(target, '');
  return lockfile.lock(target, { retries: 0, stale: 30 * 60 * 1000 });
}

const leftAsk = () => JSON.parse(readFileSync(join(process.env.IDD_STATE_DIR, 'tick.again.intake'), 'utf8'));

test('named asks left while a tick holds the lock are joined as named only, and the next tick takes just those', { timeout: 60_000 }, async () => {
  setup({ 'a/one': [labelled(1), { number: 2, labels: [], state: 'open' }, { number: 3, labels: [], state: 'open' }], 'a/two': [] });
  const release = await holdTickLock();
  assert.deepEqual(await runTick({ issueRefs: [{ repo: 'a/one', number: 2 }] }), { skipped: 'another tick is running' });
  assert.deepEqual(await runTick({ issueRefs: [{ repo: 'a/one', number: 3 }] }), { skipped: 'another tick is running' });
  const left = leftAsk();
  assert.equal(left.all, undefined);
  assert.deepEqual(left.issueRefs, [{ repo: 'a/one', number: 2 }, { repo: 'a/one', number: 3 }]);
  await release();

  const r = await runTick({ intake: false });
  assert.equal(r.intake.added.length, 2);
  // the labelled #1 is not taken in: no one asked for every Issue
  assert.deepEqual(readBacklog().map((b) => b.gh_issue_url).sort(), ['https://github.com/a/one/issues/2', 'https://github.com/a/one/issues/3']);
});

test('an ask for every Issue and a named ask left while a tick holds the lock are both kept, in either order', { timeout: 60_000 }, async () => {
  const want = ['https://github.com/a/one/issues/1', 'https://github.com/a/one/issues/2'];
  for (const order of [[{}, { issueRefs: [{ repo: 'a/one', number: 2 }] }], [{ issueRefs: [{ repo: 'a/one', number: 2 }] }, {}]]) {
    setup({ 'a/one': [labelled(1), { number: 2, labels: [], state: 'open' }], 'a/two': [] });
    const release = await holdTickLock();
    for (const ask of order) assert.deepEqual(await runTick(ask), { skipped: 'another tick is running' });
    const left = leftAsk();
    assert.equal(left.all, true);
    assert.deepEqual(left.issueRefs, [{ repo: 'a/one', number: 2 }]);
    await release();

    const r = await runTick({ intake: false });
    assert.equal(r.intake.added.length, 2);
    assert.deepEqual(readBacklog().map((b) => b.gh_issue_url).sort(), want);
  }
});

const holdsFile = () => join(process.env.IDD_STATE_DIR, 'intake-holds.json');
const readHolds = () => (existsSync(holdsFile()) ? JSON.parse(readFileSync(holdsFile(), 'utf8')).holds : []);
const latestRun = () => {
  const dir = process.env.IDD_STATE_DIR;
  const files = readdirSync(dir).filter((f) => f.startsWith('cron-run-') && f.endsWith('.json')).sort();
  return JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'));
};

test('an Issue with an open blocker in its own repo is held; the list reads blockedBy once and writes nothing', async () => {
  const { calls } = setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), labelled(2), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  // the plan is a read: it shows the hold and writes no file
  const list = await listIntakeCandidates();
  assert.equal(existsSync(holdsFile()), false);
  const one = list.candidates.find((c) => c.ref === '#1');
  assert.deepEqual(one.hold.blockers.map((b) => [b.ref, b.state]), [['#3', 'open']]);
  assert.equal(list.candidates.find((c) => c.ref === '#2').hold, undefined);

  const first = await runIntake({});
  assert.deepEqual(readBacklog().map((r) => r.gh_issue_url), ['https://github.com/a/one/issues/2']);
  assert.deepEqual(first.held.map((h) => h.ref), ['#1']);
  assert.deepEqual(readHolds().map((h) => h.ref), ['#1']);
  assert.deepEqual(latestRun().held.map((h) => h.ref), ['#1']);

  // every list call asked for blockedBy, and no candidate was read one by one
  const lists = calls().filter((c) => c[0] === 'issue' && c[1] === 'list');
  assert.ok(lists.length > 0);
  for (const c of lists) assert.ok(c[c.indexOf('--json') + 1].split(',').includes('blockedBy'));
  assert.deepEqual(calls().filter((c) => c[0] === 'issue' && c[1] === 'view'), []);
  assert.deepEqual(calls().filter((c) => c[0] === 'api'), []);

  // the blocker closes on the tracker: the next run takes the Issue in and the hold goes
  const { data } = setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), labelled(2), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  await runIntake({});
  const issues = JSON.parse(readFileSync(data, 'utf8'));
  issues['a/one'].find((i) => i.number === 1).blockedBy[0].state = 'CLOSED';
  writeFileSync(data, JSON.stringify(issues));
  const second = await runIntake({});
  assert.deepEqual(readBacklog().map((r) => r.gh_issue_url).sort(), [
    'https://github.com/a/one/issues/1', 'https://github.com/a/one/issues/2',
  ]);
  assert.deepEqual(readHolds(), []);
  assert.deepEqual(second.added.map((id) => readBacklog().find((r) => r.idd_id === id).gh_issue_url), ['https://github.com/a/one/issues/1']);
});

test('a blocker whose state the list did not carry is read once with its repo named', async () => {
  const { calls, data } = setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3 }] }), labelled(2), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  const first = await runIntake({});
  assert.deepEqual(first.held.map((h) => h.ref), ['#1']);
  const fills = calls().filter((c) => c[0] === 'api');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].find((x) => x.startsWith('repos/')), 'repos/a/one/issues/3');
  assert.deepEqual(fills[0].slice(1, 3), ['--method', 'GET']);

  const issues = JSON.parse(readFileSync(data, 'utf8'));
  issues['a/one'].find((i) => i.number === 3).state = 'closed';
  writeFileSync(data, JSON.stringify(issues));
  const second = await runIntake({});
  assert.equal(second.added.length, 1);
  assert.deepEqual(readHolds(), []);
});

test('a blocker whose state cannot be read holds the Issue; so does a list that read too few blockers', async () => {
  setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3 }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
    __fail: ['a/one'],
  });
  const unreadable = await runIntake({});
  assert.deepEqual(unreadable.added, []);
  assert.deepEqual(unreadable.held.map((h) => h.ref), ['#1']);
  assert.match(unreadable.held[0].reason, /読めませんでした/);

  setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'CLOSED' }], blockedTotal: 2 }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  const truncated = await runIntake({});
  assert.deepEqual(truncated.added, []);
  assert.deepEqual(truncated.held.map((h) => h.ref), ['#1']);
  assert.match(truncated.held[0].reason, /1 回で読める数/);
});

test('a blocker in another repo is not followed and is recorded; a repo name in another case is the same repo', async () => {
  const { calls } = setup({
    'a/one': [
      labelled(1, { blockedBy: [{ number: 9, repo: 'b/else', state: 'OPEN' }] }),
      labelled(2, { blockedBy: [{ number: 4, repo: 'A/One', state: 'OPEN' }] }),
      { number: 4, labels: [], state: 'open' },
    ],
    'a/two': [],
  });
  const r = await runIntake({});
  assert.deepEqual(readBacklog().map((x) => x.gh_issue_url), ['https://github.com/a/one/issues/1']);
  assert.deepEqual(r.ignoredBlockers.map((d) => [d.ref, d.blocker.ref, d.blocker.scope]), [['#1', '#9', 'b/else']]);
  assert.deepEqual(latestRun().ignored_blockers.map((d) => [d.ref, d.blocker.ref]), [['#1', '#9']]);
  assert.deepEqual(r.held.map((h) => h.ref), ['#2']);
  assert.deepEqual(calls().filter((c) => c[0] === 'api'), []);
  const list = await listIntakeCandidates();
  assert.deepEqual(list.ignoredBlockers.map((d) => d.blocker.ref), ['#9']);
});

// gh 2.101.0 が 2026-10-03 に返した #56 の応答（_docs/reference/pi-web-idd/idd-053/reference.md の写し。値は変えない）
const realIssueList2101 = [{
  blockedBy: {
    nodes: [{
      id: 'I_kwDOUBC9CM8AAAABUuB4iw',
      number: 54,
      state: 'OPEN',
      title: '会話 API（234）の follow-up: SSE の id、送信中の steer の順、起こし直しの model、停止の判定、INV-725 の置き換え',
      url: 'https://github.com/penne-0505/pi-web-idd/issues/54',
    }],
    totalCount: 1,
  },
  body: 'TODO IddCore-Feat-241 を実装する。受け入れ条件は TODO を正とする。会話 API（#51）は着地済み。この Issue は SSE の再接続を直す follow-up に依存する（blocked by で宣言）。\n\n- chat / idea の新規・再開・送信・停止・モデル切替が engine の `/api/conversations/*` 経由で動き、画面の見た目と操作は変えない。\n- GUI の package から pi SDK の依存を外し、`lib/rpc-manager.ts` と SDK 前提の経路を消す。build と test が通る。\n- 切替は環境変数で戻せる形にし、戻し方を qa に書く。\n- lane は build までとし、idd-web の再起動は着地後にハーネスの外で行う（GUI の再起動は同じ cgroup の lane を止めるため）。',
  createdAt: '2026-10-03T01:18:33Z',
  labels: [{ id: 'LA_kwDOUBC9CM8AAAACyY6lng', name: 'idd-ready', description: '拡張 IDD の取り込み対象', color: '0E8A16' }],
  number: 56,
  title: '既存 GUI の chat / idea を engine の会話 API 経由に替え、pi SDK の埋め込みを外す',
  url: 'https://github.com/penne-0505/pi-web-idd/issues/56',
}];

// DEC-1923: 実物の応答の形（blocker の node は id/number/state/title/url のみ、repository 無し）をそのまま置く
test('the recorded gh 2.101 answer holds #56 for its same-repo open blocker #54', async () => {
  setup({ __listRaw: { 'penne-0505/pi-web-idd': realIssueList2101 } }, ['penne-0505/pi-web-idd']);
  const r = await runIntake({});
  assert.deepEqual(r.held.map((h) => h.ref), ['#56']);
  assert.deepEqual(r.held[0].blockers.map((b) => [b.ref, b.state, b.scope]), [['#54', 'open', 'penne-0505/pi-web-idd']]);
  assert.match(r.held[0].reason, /開いた blocker があります/);
  assert.doesNotMatch(r.held[0].reason, /読めません/);
  assert.deepEqual(r.ignoredBlockers, []);
  assert.deepEqual(readBacklog(), []);
  // the plan reads the same answer: the hold shows and nothing is written
  const list = await listIntakeCandidates();
  assert.deepEqual(list.candidates.find((c) => c.ref === '#56').hold.blockers.map((b) => [b.ref, b.state, b.scope]), [['#54', 'open', 'penne-0505/pi-web-idd']]);
  assert.deepEqual(list.ignoredBlockers, []);
});

test('a blocker node the list did not place does not fall out of scope and holds', async () => {
  setup({
    'a/one': [
      labelled(1, { blockedBy: [{ state: 'CLOSED' }] }),
      labelled(2, { blockedBy: [{ number: 7, noUrl: true, state: 'CLOSED' }] }),
      labelled(3, { blockedBy: [{ repository: 'a/one', state: 'CLOSED' }] }),
      { number: 7, labels: [], state: 'open' },
    ],
    'a/two': [],
  });
  const r = await runIntake({});
  assert.deepEqual(r.held.map((h) => h.ref), ['#1', '#2', '#3']);
  for (const h of r.held) assert.match(h.reason, /^blocker を読めませんでした/);
  assert.deepEqual(r.ignoredBlockers, []);
  const refs = r.held.flatMap((h) => h.blockers.map((b) => b.ref));
  assert.deepEqual(refs, ['#?', '#7', '#?']);
  assert.ok(!refs.includes('#undefined'));
  assert.deepEqual(readBacklog(), []);
});

test('a blocker with a named repo but no url is still followed and holds the Issue', async () => {
  const { calls } = setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, repository: 'a/one', noUrl: true, state: 'OPEN' }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  const r = await runIntake({});
  assert.deepEqual(r.held.map((h) => h.ref), ['#1']);
  assert.deepEqual(r.held[0].blockers.map((b) => [b.ref, b.state, b.scope]), [['#3', 'open', 'a/one']]);
  assert.match(r.held[0].reason, /開いた blocker があります/);
  // the list carried the state, so no follow-up read ran
  assert.deepEqual(calls().filter((c) => c[0] === 'api'), []);
});

test('a blocker node without a number field takes its ref from the url number', async () => {
  setup({
    'a/one': [labelled(1, { blockedBy: [{ url: 'https://github.com/a/one/issues/3', state: 'OPEN' }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  const r = await runIntake({});
  assert.deepEqual(r.held.map((h) => h.ref), ['#1']);
  assert.deepEqual(r.held[0].blockers.map((b) => [b.ref, b.state, b.scope]), [['#3', 'open', 'a/one']]);
  assert.match(r.held[0].reason, /開いた blocker があります/);
});

test('a blocker whose repository and url disagree keeps the named repository for scope', async () => {
  setup({
    'a/one': [
      labelled(1, { blockedBy: [{ number: 9, repository: 'a/one', url: 'https://github.com/b/else/issues/9', state: 'OPEN' }] }),
      labelled(2, { blockedBy: [{ number: 9, repository: 'b/else', url: 'https://github.com/a/one/issues/9', state: 'OPEN' }] }),
      { number: 9, labels: [], state: 'open' },
    ],
    'a/two': [],
  });
  const r = await runIntake({});
  // #1's blocker names a/one, so it is followed and #1 waits; #2's names b/else, so #2 comes in
  assert.deepEqual(r.held.map((h) => h.ref), ['#1']);
  assert.deepEqual(r.held[0].blockers.map((b) => [b.ref, b.scope]), [['#9', 'a/one']]);
  assert.deepEqual(r.ignoredBlockers.map((d) => [d.ref, d.blocker.ref, d.blocker.scope]), [['#2', '#9', 'b/else']]);
  assert.deepEqual(readBacklog().map((x) => x.gh_issue_url), ['https://github.com/a/one/issues/2']);
});

test('a list that read too few blockers holds even when a node cannot be placed', async () => {
  setup({
    'a/one': [labelled(1, { blockedBy: [{ state: 'CLOSED' }], blockedTotal: 3 }), { number: 9, labels: [], state: 'open' }],
    'a/two': [],
  });
  const r = await runIntake({});
  assert.deepEqual(r.held.map((h) => h.ref), ['#1']);
  assert.match(r.held[0].reason, /1 回で読める数/);
});

test('the blocker judgement never reads a lane: a tracker-open blocker holds even after its lane landed', async () => {
  const { state } = setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: 'https://github.com/a/one/issues/3', pull_req_url: null, source_type: 'github', context: '', title: 'blocker', area: 'a/one' }) + '\n');
  writeFileSync(join(state, 'lifecycle-a-one.jsonl'), [
    JSON.stringify({ idd_id: 'IDD-1', event: 'lane_open', at: '2026-09-25T00:00:00Z', attrs: {} }),
    JSON.stringify({ idd_id: 'IDD-1', event: 'lane_close', at: '2026-09-26T00:00:00Z', attrs: { outcome: 'local', merged_commit: 'abc' } }),
  ].join('\n') + '\n');
  const r = await runIntake({});
  assert.deepEqual(r.held.map((h) => h.ref), ['#1']);
  assert.deepEqual(readBacklog().filter((b) => b.idd_id !== 'IDD-1'), []);
  assert.deepEqual(readLifecycle().filter((e) => e.idd_id !== 'IDD-1'), []);
});

test('a named Issue is taken in whatever its blocker; with all, only the filtered other is held', async () => {
  setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  const named = await runIntake({ issueRefs: [{ repo: 'a/one', number: 1 }] });
  assert.equal(named.added.length, 1);
  assert.deepEqual(named.held, []);
  assert.equal(existsSync(holdsFile()), false);

  setup({
    'a/one': [
      labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }),
      labelled(2, { blockedBy: [{ number: 3, state: 'OPEN' }] }),
      { number: 3, labels: [], state: 'open' },
    ],
    'a/two': [],
  });
  const both = await runIntake({ all: true, issueRefs: [{ repo: 'a/one', number: 2 }] });
  assert.deepEqual(both.added.map((id) => readBacklog().find((r) => r.idd_id === id).gh_issue_url), ['https://github.com/a/one/issues/2']);
  assert.deepEqual(both.held.map((h) => h.ref), ['#1']);
  assert.deepEqual(readHolds().map((h) => h.ref), ['#1']);
  assert.deepEqual(latestRun().held.map((h) => h.ref), ['#1']);
});

test('an Issue whose lane is open is a duplicate, not a dependency wait', async () => {
  const { state } = setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-1', parent_id: null, created_at: '2026-09-25T00:00:00Z', linear_issue_url: null, gh_issue_url: 'https://github.com/a/one/issues/1', pull_req_url: null, source_type: 'github', context: '', title: 'title 1 in a/one', area: 'a/one' }) + '\n');
  const r = await runIntake({});
  assert.deepEqual(r.duplicates.map((d) => d.iddId), ['IDD-1']);
  assert.deepEqual(r.held, []);
  assert.deepEqual(readHolds(), []);
  assert.deepEqual(latestRun().held, []);
  const list = await listIntakeCandidates();
  const c = list.candidates.find((x) => x.ref === '#1');
  assert.equal(c.alreadyInBacklog, 'IDD-1');
  assert.equal(c.hold, undefined);
});

test('a repo that cannot be read any more keeps its previous holds', async () => {
  const { data } = setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [labelled(1)],
  });
  await runIntake({});
  assert.deepEqual(readHolds().map((h) => h.ref), ['#1']);
  const issues = JSON.parse(readFileSync(data, 'utf8'));
  issues.__failList = ['a/one'];
  writeFileSync(data, JSON.stringify(issues));
  const failed = await runIntake({});
  assert.deepEqual(failed.failures.map((f) => f.area), ['a/one']);
  assert.deepEqual(readHolds().map((h) => h.ref), ['#1']);
  assert.ok(readBacklog().some((r) => r.gh_issue_url === 'https://github.com/a/two/issues/1'));
});

test('a held Issue can still be named for ignore, and is no longer held once ignored', async () => {
  setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  await runIntake({});
  assert.deepEqual(readHolds().map((h) => h.ref), ['#1']);
  const list = await listIntakeCandidates();
  assert.deepEqual(list.candidates.filter((c) => c.hold).map((c) => c.ref), ['#1']);
  const ignored = await ignoreByRef('ignore', '#1');
  assert.equal(ignored.ok, true, ignored.error);
  const after = await runIntake({});
  assert.deepEqual(readHolds(), []);
  assert.match(after.skipped.map((s) => s.reason).join(' '), /無視リスト/);
});

test('a held Issue is never sent to the duplicate detector', async () => {
  setup({
    'a/one': [labelled(1, { blockedBy: [{ number: 3, state: 'OPEN' }] }), labelled(2), { number: 3, labels: [], state: 'open' }],
    'a/two': [],
  });
  const asked = [];
  const r = await runIntake({ detector: async (incoming) => { asked.push(incoming.ref); return null; } });
  assert.deepEqual(asked, ['#2']);
  assert.deepEqual(r.held.map((h) => h.ref), ['#1']);
});

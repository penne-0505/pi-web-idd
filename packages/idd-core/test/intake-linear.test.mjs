import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { SHIPPED_REPOS, shippedSkip } from './helpers/shipped-repos.mjs';
import { listIntakeCandidates, parseIssueRef, runIntake } from '../src/intake/run.ts';
import { canonicalLinearUrl, createLinearClient, LINEAR_ENDPOINT } from '../src/intake/linear.ts';
import { branchFor, linearAreas, parseRepos, readAreas } from '../src/config/areas.ts';
import { key } from '../src/overlay/git.ts';
import { readBacklog, readLifecycle } from '../src/ledger/read.ts';
import { seedLifecycle } from './seed-lifecycle.mjs';

const KEY = 'lin_api_TESTSECRET_0123456789';

/** every GraphQL body any fake received, across all tests */
const sentBodies = [];

function node(identifier, state, extra = {}) {
  const team = identifier.split('-')[0];
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `title of ${identifier}`,
    description: `body of ${identifier}`,
    url: `https://linear.app/org/issue/${identifier}/title-of-${identifier.toLowerCase()}`,
    createdAt: '2026-09-25T00:00:00Z',
    updatedAt: '2026-09-25T00:00:00Z',
    team: { key: team },
    state: { name: state, ...(extra.stateType ? { type: extra.stateType } : {}) },
    labels: { nodes: (extra.labels ?? []).map((name) => ({ name })) },
    ...extra.override,
  };
}

/** a `blocks` relation as Linear carries it on the blocked side (the reverse of the blocker's own relation) */
function blocker(identifier, stateType, name = 'In Progress') {
  return { type: 'blocks', issue: node(identifier, name, { stateType }) };
}

/** a repo set that takes Linear Issues only, so a GitHub read does not muddy the counts */
const linearOnly = (teams = ['APP']) => ({ 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: teams } } } });

/** Linear's answer when an identifier names no Issue */
const notFound = { data: null, errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INVALID_INPUT', userPresentableMessage: 'Could not find referenced Issue.' } }] };

/**
 * A Linear that answers assignedIssues from `nodes`, honouring first/after like the real API, the unassigned list
 * from `unassigned`, and an Issue asked for by its identifier from `everyone` (every Issue in the workspace).
 */
function fakeLinear(nodes, respond, everyone = nodes, unassigned = []) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sentBodies.push(body);
    calls.push({ url, headers: init.headers, body });
    if (respond) return respond(body);
    if (body.variables.id !== undefined) {
      const found = everyone.find((n) => n.identifier === body.variables.id);
      return { ok: true, status: 200, json: async () => (found ? { data: { issue: found } } : notFound) };
    }
    const offset = body.variables.after ? Number(body.variables.after) : 0;
    const source = body.variables.teams !== undefined ? unassigned : nodes;
    const page = source.slice(offset, offset + body.variables.first);
    const next = offset + page.length;
    return {
      ok: true, status: 200,
      json: async () => (body.variables.teams !== undefined
        ? { data: { issues: { nodes: page, pageInfo: { hasNextPage: next < source.length, endCursor: String(next) } } } }
        : { data: { viewer: { assignedIssues: { nodes: page, pageInfo: { hasNextPage: next < source.length, endCursor: String(next) } } } } }),
    };
  };
  return { fetch, calls };
}

function setup({ repos, key = KEY } = {}) {
  const root = scratchDir('linear-');
  const state = join(root, 'state'); mkdirSync(state);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const ghLog = join(root, 'gh.log');
  const stub = join(bin, 'gh');
  writeFileSync(stub, `#!${process.execPath}\nconst a=process.argv.slice(2);const repo=a[a.indexOf('--repo')+1];require('fs').appendFileSync(${JSON.stringify(ghLog)},repo+'\\n');console.log(JSON.stringify([{number:1,title:'one in '+repo,url:'https://github.com/'+repo+'/issues/1',body:'',createdAt:'2026-09-23T00:00:00Z',labels:[{name:'idd-ready'}]}]));`);
  chmodSync(stub, 0o755);
  const clone = (n) => ({ upstream: join(root, `u-${n}`), work: join(root, `w-${n}`) });
  const reposFile = join(root, 'repos.yaml');
  writeFileSync(reposFile, JSON.stringify({
    repos: repos ?? {
      'a/gh': { ...clone('gh'), issue_lane: { context: 'personal', source_type_priority: 'github', intake_filter: { github_labels: ['idd-ready'] } } },
      'a/app': { ...clone('app'), issue_lane: { context: 'meltly', source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'] } } },
      'a/bac': { ...clone('bac'), issue_lane: { context: 'meltly', source_type_priority: 'linear', intake_filter: { linear_teams: ['bac'], linear_statuses: ['Todo', 'In Progress'] } } },
      'Dayseum/daysai-web': { ...clone('web') },
    },
  }));
  Object.assign(process.env, { IDD_REPOS_FILE: reposFile, IDD_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}`, IDD_LINEAR_KEY_FILE: join(root, 'no-such-key') });
  if (key) process.env.LINEAR_API_KEY = key; else delete process.env.LINEAR_API_KEY;
  const ghRepos = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { root, state, ghRepos };
}

function allStateText(state) {
  return readdirSync(state).map((f) => readFileSync(join(state, f), 'utf8')).join('\n');
}

const standard = () => [
  node('APP-1', 'Todo'),
  node('WEB-5', 'Todo'),
  node('BAC-2', 'In Progress'),
  node('APP-3', 'In Progress'),
];

test('assigned Issues are routed by team key; unknown teams and states outside the repo filter are skipped', async () => {
  const { ghRepos } = setup();
  const linear = fakeLinear(standard());
  const list = await listIntakeCandidates({ linearFetch: linear.fetch });

  assert.deepEqual(list.failures, []);
  assert.deepEqual(list.candidates.filter((c) => c.source === 'linear').map((c) => [c.ref, c.area, c.title]), [
    ['APP-1', 'a/app', 'title of APP-1'],
    ['BAC-2', 'a/bac', 'title of BAC-2'],
  ]);
  assert.deepEqual(list.skipped.map((s) => s.ref), ['WEB-5', 'APP-3']);
  assert.match(list.skipped[0].reason, /チーム WEB/);
  assert.match(list.skipped[1].reason, /状態 In Progress/);
  // one query for the union of the repos' states, sent to Linear with the key as the Authorization header
  assert.equal(linear.calls.length, 1);
  assert.equal(linear.calls[0].url, LINEAR_ENDPOINT);
  assert.equal(linear.calls[0].headers.Authorization, KEY);
  assert.deepEqual(linear.calls[0].body.variables.states.sort(), ['In Progress', 'Todo']);
  // a Linear-first repo without github_labels is not read on GitHub
  assert.deepEqual(ghRepos(), ['a/gh']);
  assert.ok(list.candidates.some((c) => c.source === 'github' && c.area === 'a/gh'));
});

test('pages are followed with the cursor, and the run stops at the limit with a failure line', async () => {
  setup();
  const nodes = Array.from({ length: 7 }, (_, i) => node(`APP-${i + 1}`, 'Todo'));
  const client = createLinearClient(KEY, { fetch: fakeLinear(nodes).fetch });
  const all = await client.listAssignedIssues({ states: ['Todo'], pageSize: 3 });
  assert.deepEqual(all.issues.map((i) => i.identifier), nodes.map((n) => n.identifier));
  assert.equal(all.truncated, false);

  const linear = fakeLinear(nodes);
  const capped = await listIntakeCandidates({ linearFetch: linear.fetch, linearLimit: 4 });
  assert.equal(capped.candidates.filter((c) => c.source === 'linear').length, 4);
  assert.match(capped.failures.map((f) => f.reason).join(' '), /上限 4 件/);
  assert.deepEqual(linear.calls.map((c) => [c.body.variables.first, c.body.variables.after]), [[4, null]]);
});

test('a run records the Linear URL without its slug, names the branch after the Linear identifier, and a second run is a duplicate', async () => {
  const { state } = setup();
  const first = await runIntake({ linearFetch: fakeLinear(standard()).fetch });
  const linearRecs = readBacklog().filter((r) => r.source_type === 'linear');
  assert.deepEqual(linearRecs.map((r) => [r.linear_issue_url, r.gh_issue_url, r.area, r.context]), [
    ['https://linear.app/org/issue/APP-1', null, 'a/app', 'body of APP-1'],
    ['https://linear.app/org/issue/BAC-2', null, 'a/bac', 'body of BAC-2'],
  ]);
  assert.equal(first.added.length, 3);
  assert.deepEqual(first.skipped.map((s) => s.ref), ['WEB-5', 'APP-3']);
  const opened = readLifecycle().filter((e) => e.event === 'lane_open' && e.attrs?.source_type === 'linear');
  assert.deepEqual(opened.map((e) => e.attrs.linear_identifier), ['APP-1', 'BAC-2']);
  // no branch rule on the repo: feature/ with the Linear identifier, which Linear's GitHub integration follows
  assert.equal(branchFor('a/app', linearRecs[0].idd_id), 'feature/app-1');

  // the title (and so the slug) changed on Linear: still the same Issue
  const renamed = standard().map((n) => (n.identifier === 'APP-1' ? { ...n, url: 'https://linear.app/org/issue/APP-1/a-new-title' } : n));
  const second = await runIntake({ linearFetch: fakeLinear(renamed).fetch });
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.duplicates.map((d) => d.url).filter((u) => u.includes('linear')).sort(), [
    'https://linear.app/org/issue/APP-1', 'https://linear.app/org/issue/BAC-2',
  ]);
  assert.ok(!allStateText(state).includes(KEY));
});

test('a Linear identifier names one Issue; one Linear has not is unmatched, one no repo takes is skipped', async () => {
  const { ghRepos } = setup();
  assert.deepEqual(parseIssueRef('app-12'), { identifier: 'APP-12' });
  assert.deepEqual(parseIssueRef('a/gh#3'), { repo: 'a/gh', number: 3 });
  const r = await runIntake({ issueRefs: [{ identifier: 'BAC-2' }, { identifier: 'WEB-5' }, { identifier: 'APP-999' }], linearFetch: fakeLinear(standard()).fetch });
  assert.equal(r.added.length, 1);
  assert.deepEqual(readBacklog().map((b) => b.linear_issue_url), ['https://linear.app/org/issue/BAC-2']);
  assert.deepEqual(r.unmatched, ['APP-999']);
  assert.deepEqual(r.skipped.map((s) => s.ref), ['WEB-5']);
  assert.match(r.skipped[0].reason, /チーム WEB/);
  // naming only Linear Issues does not read GitHub
  assert.deepEqual(ghRepos(), []);
});

test('a named Linear Issue is read by its identifier and taken in whatever its state, assignee and labels', async () => {
  setup({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'], linear_labels: ['idd-ready'] } } } } });
  // APP-50 is In Review, carries no label and is not assigned to the key's owner: the assigned list never has it
  const inReview = node('APP-50', 'In Review');
  const linear = fakeLinear([node('APP-1', 'Todo', { labels: ['idd-ready'] })], undefined, [inReview]);
  const r = await runIntake({ issueRefs: [{ identifier: 'APP-50' }], linearFetch: linear.fetch });
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.added.length, 1);
  const rec = readBacklog().find((b) => b.idd_id === r.added[0]);
  assert.deepEqual([rec.linear_issue_url, rec.linear_issue_id, rec.area, rec.context, rec.parent_id], [
    'https://linear.app/org/issue/APP-50', 'uuid-APP-50', 'a/app', 'body of APP-50', null,
  ]);
  const opened = readLifecycle().find((e) => e.idd_id === rec.idd_id && e.event === 'lane_open');
  assert.equal(opened.attrs.linear_identifier, 'APP-50');
  assert.equal(opened.attrs.requeued_from, undefined);
  // only the named Issue is asked for, with a query
  assert.equal(linear.calls.length, 1);
  assert.deepEqual(linear.calls[0].body.variables, { id: 'APP-50' });
  assert.match(linear.calls[0].body.query, /^query\s/);
  assert.doesNotMatch(linear.calls[0].body.query, /mutation|subscription/i);
});

test('unnamed, an unassigned or In Review Linear Issue is not taken in', async () => {
  setup();
  // APP-51 is assigned but In Review; APP-50 is In Review and not assigned
  const assigned = [node('APP-1', 'Todo'), node('APP-51', 'In Review')];
  const everyone = [...assigned, node('APP-50', 'In Review')];
  const list = await listIntakeCandidates({ linearFetch: fakeLinear(assigned, undefined, everyone).fetch });
  assert.deepEqual(list.candidates.filter((c) => c.source === 'linear').map((c) => c.ref), ['APP-1']);
  const linear = fakeLinear(assigned, undefined, everyone);
  const r = await runIntake({ linearFetch: linear.fetch });
  assert.deepEqual(readBacklog().filter((b) => b.source_type === 'linear').map((b) => b.linear_issue_url), ['https://linear.app/org/issue/APP-1']);
  assert.deepEqual(r.skipped.map((s) => s.ref), ['APP-51']);
  assert.match(r.skipped[0].reason, /状態 In Review/);
  // the run reads the assigned list, never one Issue by its identifier
  assert.ok(linear.calls.every((c) => c.body.variables.id === undefined));
});

test('a named Linear Issue: not found in any answer form is unmatched; other errors are one failure line without the key', async () => {
  setup();
  const answers = [
    async () => ({ ok: true, status: 200, json: async () => notFound }),
    async () => ({ ok: false, status: 400, json: async () => notFound }),
    async () => ({ ok: true, status: 200, json: async () => ({ data: { issue: null } }) }),
  ];
  for (const answer of answers) {
    const r = await runIntake({ issueRefs: [{ identifier: 'APP-7' }], linearFetch: fakeLinear([], answer).fetch });
    assert.deepEqual([r.added, r.unmatched, r.failures], [[], ['APP-7'], []]);
  }
  const failing = [
    async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: `Authentication required: ${KEY}` }] }) }),
    async () => ({ ok: false, status: 401, json: async () => ({}) }),
    async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ message: `bad ${KEY}`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }) }),
  ];
  for (const answer of failing) {
    const r = await runIntake({ issueRefs: [{ identifier: 'APP-7' }, { identifier: 'APP-8' }], linearFetch: fakeLinear([], answer).fetch });
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.failures.map((f) => f.area), ['linear']);
    // the identifiers left unread are named in the failure
    assert.match(r.failures[0].reason, /APP-7.*APP-8/);
    assert.ok(!JSON.stringify(r).includes(KEY));
  }
});

test('a named Linear Issue whose lane closed comes back as a requeue at once; unnamed, it waits for an update on Linear', async () => {
  setup();
  // APP-60 is assigned and Todo, so the unnamed run sees it too
  const nodes = () => [node('APP-60', 'Todo')];
  const first = await runIntake({ issueRefs: [{ identifier: 'APP-60' }], linearFetch: fakeLinear(nodes()).fetch });
  const lane = first.added[0];
  await seedLifecycle('lane_close', lane, { outcome: 'abandoned' });

  // unnamed: not touched on Linear since the close, so it is skipped
  const unnamed = await runIntake({ linearFetch: fakeLinear(nodes()).fetch });
  assert.deepEqual(readBacklog().filter((r) => unnamed.added.includes(r.idd_id) && r.source_type === 'linear'), []);
  assert.match(unnamed.skipped.find((s) => s.ref === 'APP-60').reason, new RegExp(lane));

  // named: taken in again without an update, as a requeue of the closed lane (it stops on the requeue card)
  const named = await runIntake({ issueRefs: [{ identifier: 'APP-60' }], linearFetch: fakeLinear(nodes()).fetch });
  assert.deepEqual(named.skipped, []);
  assert.equal(named.added.length, 1);
  assert.equal(readBacklog().find((r) => r.idd_id === named.added[0]).parent_id, lane);
  const opened = readLifecycle().find((e) => e.idd_id === named.added[0] && e.event === 'lane_open');
  assert.equal(opened.attrs.requeued_from, lane);

  // closed again: a run for every Issue together with the named one requeues it once, and does not list it as skipped
  await seedLifecycle('lane_close', named.added[0], { outcome: 'abandoned' });
  const both = await runIntake({ all: true, issueRefs: [{ identifier: 'APP-60' }], linearFetch: fakeLinear(nodes()).fetch });
  const requeued = readBacklog().filter((r) => both.added.includes(r.idd_id) && r.source_type === 'linear');
  assert.deepEqual(requeued.map((r) => r.parent_id), [named.added[0]]);
  assert.deepEqual(both.skipped.filter((x) => x.ref === 'APP-60'), []);
  assert.deepEqual(both.duplicates.filter((d) => d.url.includes('linear.app')), []);

  // the requeued lane is open: a later run of either kind sees a duplicate, not a new lane
  const later = await runIntake({ issueRefs: [{ identifier: 'APP-60' }], linearFetch: fakeLinear(nodes()).fetch });
  assert.deepEqual(later.added, []);
  assert.deepEqual(later.duplicates.map((d) => d.iddId), [requeued[0].idd_id]);
});

test('the key never appears in a failure, a result, the state files, or the console', async (t) => {
  const { state } = setup();
  const printed = [];
  for (const m of ['log', 'error', 'warn', 'info', 'debug']) t.mock.method(console, m, (...a) => printed.push(a.join(' ')));

  const answers = [
    async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ message: `bad key ${KEY}` }] }) }),
    async () => { throw new Error(`connect failed with Authorization: ${KEY}`); },
    async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: `Authentication required: ${KEY}` }] }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(KEY); } }),
  ];
  const reasons = [];
  for (const answer of answers) {
    const linear = fakeLinear([], answer);
    const listed = await listIntakeCandidates({ linearFetch: linear.fetch });
    const ran = await runIntake({ linearFetch: linear.fetch });
    for (const out of [listed, ran]) {
      const text = JSON.stringify(out);
      assert.ok(!text.includes(KEY), text);
      reasons.push(...out.failures.filter((f) => f.area === 'linear').map((f) => f.reason));
    }
  }
  assert.equal(reasons.length, 8);
  assert.match(reasons[0], /HTTP 401/);
  assert.match(reasons[2], /\[redacted\]/);
  assert.ok(!allStateText(state).includes(KEY));
  assert.ok(!printed.join('\n').includes(KEY));
  // the client object carries no key in what it exposes
  const client = createLinearClient(KEY, { fetch: fakeLinear([]).fetch });
  // (every method reads: none takes a document, so the fixed queries are all that can be sent)
  assert.deepEqual(Object.keys(client).sort(), ['getIssue', 'getSyncIssue', 'listAssignedIssues', 'listProjectIssues', 'listTeamProjects', 'listUnassignedIssues']);
  assert.ok(!JSON.stringify(client).includes(KEY));
});

test('without a key the Linear side is one failure line and GitHub intake goes on', async () => {
  const { root } = setup({ key: null });
  const linear = fakeLinear(standard());
  const list = await listIntakeCandidates({ linearFetch: linear.fetch });
  assert.equal(linear.calls.length, 0);
  assert.deepEqual(list.failures.map((f) => f.area), ['linear']);
  assert.match(list.failures[0].reason, /鍵がありません/);
  assert.ok(list.candidates.some((c) => c.source === 'github'));
  const ran = await runIntake({ linearFetch: linear.fetch });
  assert.equal(ran.added.length, 1);

  // the key file is read when LINEAR_API_KEY is not set
  const keyFile = join(root, 'linear-api-key');
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  process.env.IDD_LINEAR_KEY_FILE = keyFile;
  const withFile = fakeLinear(standard());
  const listed = await listIntakeCandidates({ linearFetch: withFile.fetch });
  assert.deepEqual(listed.failures, []);
  assert.equal(withFile.calls[0].headers.Authorization, KEY);
  writeFileSync(keyFile, '\n');
  const empty = await listIntakeCandidates({ linearFetch: withFile.fetch });
  assert.match(empty.failures.map((f) => f.reason).join(' '), /空です/);
});

test('the registry as committed takes no Meltly Linear Issue in by itself: a Meltly repo that reads Linear asks for a label, so only a named intake opens a lane', { skip: shippedSkip }, () => {
  process.env.IDD_REPOS_FILE = SHIPPED_REPOS;
  const meltly = ['Dayseum/daysai-flutter', 'Dayseum/daysai-web', 'Dayseum/daysai-management'];
  for (const area of linearAreas()) {
    if (!meltly.includes(area.repo)) continue;
    assert.ok(area.labels.length > 0, `${area.repo} は Linear を読むのに、自動の取り込みを止めるラベルの条件がありません`);
  }
  const areas = readAreas().areas;
  for (const repo of ['Dayseum/daysai-web', 'Dayseum/daysai-management']) {
    if (areas[repo]) assert.equal(areas[repo].intake, false, repo);
  }
});

test('the Meltly repos (no issue_lane) never take Linear Issues in, and Linear is not asked at all', async () => {
  // a key and assigned Issues exist, but no repo takes Linear Issues: nothing is sent
  const clone = (n) => ({ upstream: `/nonexistent/u-${n}`, work: `/nonexistent/w-${n}` });
  setup({
    repos: {
      'Dayseum/daysai-flutter': clone('f'),
      'Dayseum/Dayseum-main-server': clone('s'),
      'Dayseum/daysai-web': clone('w'),
    },
  });
  const linear = fakeLinear(standard());
  const list = await listIntakeCandidates({ linearFetch: linear.fetch });
  const ran = await runIntake({ linearFetch: linear.fetch });
  assert.equal(linear.calls.length, 0);
  assert.deepEqual([list.candidates, list.skipped, list.failures], [[], [], []]);
  assert.deepEqual([ran.added, ran.failures], [[], []]);
  assert.deepEqual(readBacklog(), []);
});

test('a team claimed by two repos is a config error; a Linear-first repo without teams is one failure line', async () => {
  const lane = (teams) => ({ source_type_priority: 'linear', intake_filter: { linear_teams: teams } });
  assert.throws(() => parseRepos(JSON.stringify({ repos: {
    'a/one': { upstream: '/u1', work: '/w1', issue_lane: lane(['APP']) },
    'a/two': { upstream: '/u2', work: '/w2', issue_lane: lane(['app']) },
  } })), /チーム APP/);
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'a/one': { upstream: '/u1', work: '/w1', issue_lane: { intake_filter: { linear_teams: 'APP' } } } } })), /文字列の一覧/);

  setup({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear' } } } });
  const linear = fakeLinear(standard());
  const list = await listIntakeCandidates({ linearFetch: linear.fetch });
  assert.equal(linear.calls.length, 0);
  assert.deepEqual(list.failures.map((f) => f.area), ['a/app']);
  assert.match(list.failures[0].reason, /linear_teams/);
});

test('linear_labels narrows the Issues a repo takes in', async () => {
  setup({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'], linear_labels: ['idd-ready'] } } } } });
  const nodes = [node('APP-1', 'Todo', { labels: ['idd-ready', 'bug'] }), node('APP-2', 'Todo', { labels: ['bug'] })];
  const list = await listIntakeCandidates({ linearFetch: fakeLinear(nodes).fetch });
  assert.deepEqual(list.candidates.map((c) => c.ref), ['APP-1']);
  assert.match(list.skipped[0].reason, /ラベル idd-ready/);
});

test('an Issue the list reads with an estimate and a priority carries them, and no lane records them', async () => {
  const { state } = setup();
  const nodes = [node('APP-1', 'Todo', { override: { estimate: 3, priority: 2 } }), node('APP-2', 'Todo')];
  const list = await listIntakeCandidates({ linearFetch: fakeLinear(nodes).fetch });
  assert.deepEqual(list.candidates.filter((c) => c.source === 'linear').map((c) => [c.ref, c.estimate, c.priority]), [
    ['APP-1', 3, 2],
    // an Issue without an estimate and with Linear's priority 0 has a value a person can read as «none»
    ['APP-2', null, 0],
  ]);
  // GitHub rows carry neither (the shape is the one intake always had)
  assert.equal('estimate' in list.candidates.find((c) => c.source === 'github'), false);

  await runIntake({ linearFetch: fakeLinear(nodes).fetch });
  const rec = readBacklog().find((b) => b.linear_issue_url === 'https://linear.app/org/issue/APP-1');
  assert.equal(rec.context, 'body of APP-1');
  assert.deepEqual(['estimate', 'priority'].filter((f) => f in rec), []);
  const opened = readLifecycle().find((e) => e.idd_id === rec.idd_id && e.event === 'lane_open');
  assert.deepEqual(['estimate', 'priority'].filter((f) => f in opened.attrs), []);
  assert.ok(!allStateText(state).includes('"estimate"'));
});

test('a label that says «not now» keeps an Issue out unnamed, but not when the Issue is named', async () => {
  setup({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'], linear_labels: ['idd-ready'], linear_exclude_labels: ['deferred'] } } } } });
  const nodes = [node('APP-1', 'Todo', { labels: ['idd-ready', 'deferred'] }), node('APP-2', 'Todo', { labels: ['idd-ready'] })];
  const list = await listIntakeCandidates({ linearFetch: fakeLinear(nodes).fetch });
  assert.deepEqual(list.candidates.filter((c) => c.source === 'linear').map((c) => c.ref), ['APP-2']);
  assert.deepEqual(list.skipped.map((s) => s.ref), ['APP-1']);
  assert.match(list.skipped[0].reason, /deferred/);
  const ran = await runIntake({ linearFetch: fakeLinear(nodes).fetch });
  assert.deepEqual(readBacklog().filter((b) => b.source_type === 'linear').map((b) => b.linear_issue_url), ['https://linear.app/org/issue/APP-2']);

  // naming the Issue is the person's own decision: the labels that say «not now» are not a condition of naming
  const named = await runIntake({ issueRefs: [{ identifier: 'APP-1' }], linearFetch: fakeLinear([], undefined, nodes).fetch });
  assert.deepEqual(named.skipped, []);
  assert.equal(named.added.length, 1);
});

test('a repo that asks for the unassigned takes them in under the same conditions; one that does not never reads them', async () => {
  const lanes = (extra) => ({ 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'], linear_labels: ['idd-ready'], linear_exclude_labels: ['deferred'], ...extra } } } });
  const assigned = [node('APP-1', 'Todo', { labels: ['idd-ready'] })];
  const unassignedNodes = [
    node('APP-2', 'Todo', { labels: ['idd-ready'] }),
    // the same conditions as an assigned Issue: state, the labels it must carry, the labels that say «not now»
    node('APP-3', 'In Progress', { labels: ['idd-ready'] }),
    node('APP-4', 'Todo'),
    node('APP-5', 'Todo', { labels: ['idd-ready', 'deferred'] }),
    // and a dependency holds it the same way
    node('APP-6', 'Todo', { labels: ['idd-ready'], override: { inverseRelations: { nodes: [blocker('APP-9', 'started')] } } }),
  ];

  setup({ repos: lanes({ linear_include_unassigned: true }) });
  const linear = fakeLinear(assigned, undefined, assigned, unassignedNodes);
  const ran = await runIntake({ linearFetch: linear.fetch });
  assert.deepEqual(readBacklog().filter((b) => b.source_type === 'linear').map((b) => b.linear_issue_url), [
    'https://linear.app/org/issue/APP-1',
    'https://linear.app/org/issue/APP-2',
  ]);
  assert.deepEqual(ran.held.map((h) => h.ref), ['APP-6']);
  assert.deepEqual(ran.skipped.map((s) => s.ref).sort(), ['APP-3', 'APP-4', 'APP-5']);
  // the unassigned read is one query, for this repo's team and states
  const calls = linear.calls.filter((c) => c.body.variables.teams !== undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.variables.teams, ['APP']);
  assert.deepEqual(calls[0].body.variables.states, ['Todo']);
  assert.match(calls[0].body.query, /^query\s/);
  assert.doesNotMatch(calls[0].body.query, /mutation|subscription/i);

  // without the setting the team is never asked for its unassigned Issues, and none is taken in
  setup({ repos: lanes({}) });
  const plain = fakeLinear(assigned, undefined, assigned, unassignedNodes);
  const listed = await listIntakeCandidates({ linearFetch: plain.fetch });
  assert.equal(plain.calls.filter((c) => c.body.variables.teams !== undefined).length, 0);
  assert.deepEqual(listed.candidates.filter((c) => c.source === 'linear').map((c) => c.ref), ['APP-1']);
  assert.deepEqual(listed.unassigned, []);
});

test('the listing shows the unassigned Issues a repo does not take in, apart from the lanes it would open', async () => {
  setup({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'] } } } } });
  const assigned = [node('APP-1', 'Todo')];
  const unassignedNodes = [node('APP-2', 'Todo', { override: { estimate: 5, priority: 1 } }), node('APP-3', 'In Progress')];

  const plain = fakeLinear(assigned, undefined, assigned, unassignedNodes);
  const without = await listIntakeCandidates({ linearFetch: plain.fetch });
  assert.equal(plain.calls.filter((c) => c.body.variables.teams !== undefined).length, 0);
  assert.deepEqual(without.unassigned, []);

  const asked = fakeLinear(assigned, undefined, assigned, unassignedNodes);
  const listed = await listIntakeCandidates({ linearFetch: asked.fetch, includeUnassigned: true });
  assert.deepEqual(listed.candidates.filter((c) => c.source === 'linear').map((c) => c.ref), ['APP-1']);
  assert.deepEqual(listed.unassigned.map((u) => [u.ref, u.area, u.estimate, u.priority]), [['APP-2', 'a/app', 5, 1]]);
  assert.deepEqual(asked.calls.filter((c) => c.body.variables.teams !== undefined).length, 1);

  // a run still takes neither of them in, whether the list asked for them or not
  const ran = await runIntake({ linearFetch: fakeLinear(assigned, undefined, assigned, unassignedNodes).fetch });
  assert.deepEqual(readBacklog().filter((b) => b.source_type === 'linear').map((b) => b.linear_issue_url), ['https://linear.app/org/issue/APP-1']);
  assert.deepEqual(ran.added.length, 1);

  // a repo that takes them in shows them as lanes-to-be, not apart
  setup({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'], linear_include_unassigned: true } } } } });
  const taken = await listIntakeCandidates({ linearFetch: fakeLinear(assigned, undefined, assigned, unassignedNodes).fetch, includeUnassigned: true });
  assert.deepEqual(taken.candidates.filter((c) => c.source === 'linear').map((c) => c.ref), ['APP-1', 'APP-2']);
  assert.deepEqual(taken.unassigned, []);
  const ignored = await listIntakeCandidates({ linearFetch: fakeLinear(assigned, undefined, assigned, unassignedNodes).fetch });
  assert.deepEqual(ignored.candidates.filter((c) => c.source === 'linear').map((c) => c.ref), ['APP-1', 'APP-2']);
});

test('a repo that writes none of the new fields keeps its intake_filter shape and hash; a wrong value is a config error', () => {
  const repos = (filter) => JSON.stringify({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: filter } } } });
  const before = parseRepos(repos({ linear_teams: ['APP'] }));
  assert.deepEqual(before.areas['a/app'].intake_filter, { linear_teams: ['APP'] });
  // writing `false` is the same as writing nothing: the field is not carried, and the hash does not move
  const explicitFalse = parseRepos(repos({ linear_teams: ['APP'], linear_include_unassigned: false }));
  assert.deepEqual(explicitFalse.areas['a/app'].intake_filter, { linear_teams: ['APP'] });
  assert.equal(key(explicitFalse.areas['a/app']), key(before.areas['a/app']));

  assert.throws(() => parseRepos(repos({ linear_include_unassigned: 'yes' })), /true か false/);
  assert.throws(() => parseRepos(repos({ linear_exclude_labels: 'deferred' })), /文字列の一覧/);
  assert.doesNotThrow(() => parseRepos(repos({ linear_teams: ['APP'], linear_exclude_labels: ['deferred'], linear_include_unassigned: true })));
});


test('a Linear Issue whose lane closed is not taken in again until it is updated on Linear after the close', async () => {
  setup();
  const nodes = () => [node('APP-1', 'Todo'), node('APP-2', 'Todo'), node('APP-3', 'Todo')];
  await runIntake({ linearFetch: fakeLinear(nodes()).fetch });
  const lanes = Object.fromEntries(readBacklog().filter((r) => r.source_type === 'linear').map((r) => [r.linear_issue_url.split('/').pop(), r.idd_id]));
  // every way a lane closes counts, whatever the outcome
  await seedLifecycle('lane_close', lanes['APP-1'], { outcome: 'merged' });
  await seedLifecycle('s1_defer', lanes['APP-2'], {});
  await seedLifecycle('lane_close', lanes['APP-3'], { outcome: 'abandoned' });

  // still Todo, not touched since: no new lane
  const again = await runIntake({ linearFetch: fakeLinear(nodes()).fetch });
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.skipped.map((s) => s.ref).sort(), ['APP-1', 'APP-2', 'APP-3']);
  assert.match(again.skipped.find((s) => s.ref === 'APP-1').reason, new RegExp(lanes['APP-1']));
  const listed = await listIntakeCandidates({ linearFetch: fakeLinear(nodes()).fetch });
  assert.deepEqual(listed.candidates.filter((c) => c.source === 'linear'), []);

  // APP-2 was updated on Linear after its lane closed: it comes back as a requeue of the old lane
  const later = new Date(Date.now() + 60_000).toISOString();
  const touched = nodes().map((n) => (n.identifier === 'APP-2' ? { ...n, updatedAt: later } : n));
  const back = await runIntake({ linearFetch: fakeLinear(touched).fetch });
  assert.equal(back.added.length, 1);
  const rec = readBacklog().find((r) => r.idd_id === back.added[0]);
  assert.equal(rec.linear_issue_url, 'https://linear.app/org/issue/APP-2');
  assert.equal(rec.parent_id, lanes['APP-2']);
});

test('a Linear request that never answers stops at the deadline with one failure line, and GitHub intake goes on', async () => {
  setup();
  const hang = fakeLinear([], () => new Promise(() => {}));
  const started = Date.now();
  const list = await listIntakeCandidates({ linearFetch: hang.fetch, linearTimeoutMs: 200 });
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(list.failures.map((f) => f.area), ['linear']);
  assert.match(list.failures[0].reason, /応答がありませんでした/);
  assert.ok(list.candidates.some((c) => c.source === 'github'));
  // the request carries the deadline for a fetch that honours it
  assert.ok(hang.calls.length === 1);

  // a body that never finishes stops too
  const stalled = fakeLinear([], async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  const ran = await runIntake({ linearFetch: stalled.fetch, linearTimeoutMs: 200 });
  assert.match(ran.failures.map((f) => f.reason).join(' '), /応答がありませんでした/);
  assert.equal(ran.added.length, 1);
});

test("Linear's own id is recorded and matches the Issue after it moves team (new identifier and URL)", async () => {
  setup();
  await runIntake({ linearFetch: fakeLinear([node('APP-1', 'Todo')]).fetch });
  const rec = readBacklog().find((r) => r.source_type === 'linear');
  assert.equal(rec.linear_issue_id, 'uuid-APP-1');
  assert.equal(readLifecycle().find((e) => e.idd_id === rec.idd_id && e.event === 'lane_open').attrs.linear_issue_id, 'uuid-APP-1');
  const moved = { ...node('BAC-9', 'Todo'), id: 'uuid-APP-1' };
  const again = await runIntake({ linearFetch: fakeLinear([moved]).fetch });
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.duplicates.filter((d) => d.url.includes('linear.app')).map((d) => [d.iddId, d.url]), [[rec.idd_id, 'https://linear.app/org/issue/BAC-9']]);
});

test('a backlog row without linear_issue_url (an older GitHub row) does not break the matching', async () => {
  const { state } = setup();
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', area: 'a/gh', title: 'old', context: '', gh_issue_url: 'https://github.com/a/other/issues/9' }) + '\n');
  const r = await runIntake({ linearFetch: fakeLinear(standard()).fetch });
  assert.deepEqual(r.failures, []);
  assert.equal(r.added.length, 3);
});

test('one spelling per Linear URL: scheme, host case, identifier case and the slug', () => {
  for (const u of [
    'https://linear.app/org/issue/APP-1',
    'https://linear.app/org/issue/app-1/some-title',
    'http://Linear.APP/org/issue/App-1?x=1',
    ' https://LINEAR.app/org/issue/APP-1#c ',
  ]) assert.equal(canonicalLinearUrl(u), 'https://linear.app/org/issue/APP-1', u);
  assert.equal(canonicalLinearUrl('https://github.com/a/b/issues/1'), 'https://github.com/a/b/issues/1');
  assert.equal(canonicalLinearUrl(undefined), '');
});

test('a field intake_filter does not know is a config error, not silently dropped', () => {
  const repos = (filter) => JSON.stringify({ repos: { 'a/one': { upstream: '/u', work: '/w', issue_lane: { intake_filter: filter } } } });
  assert.throws(() => parseRepos(repos({ github_label: ['idd-ready'] })), /知らない欄 github_label/);
  assert.throws(() => parseRepos(repos({ linear: { teams: ['APP'] } })), /知らない欄 linear/);
  assert.doesNotThrow(() => parseRepos(repos({ github_labels: ['x'], linear_teams: ['APP'], linear_statuses: ['Todo'], linear_labels: ['y'] })));
});

test('the committed registry stays valid', { skip: shippedSkip }, () => {
  assert.doesNotThrow(() => parseRepos(readFileSync(SHIPPED_REPOS, 'utf8')));
});

test('every document sent to Linear is a query; nothing that writes is ever built', async () => {
  assert.ok(sentBodies.length > 0);
  for (const body of sentBodies) {
    assert.match(body.query, /^query\s/);
    assert.doesNotMatch(body.query, /mutation|subscription/i);
  }
  // the module has no document text that could write, and no way to send a caller's document
  const src = readFileSync(resolve('packages/idd-core/src/intake/linear.ts'), 'utf8');
  const documents = [...src.matchAll(/`((?:query|mutation|subscription)[\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(documents.length >= 2);
  assert.ok(sentBodies.some((b) => b.variables.id !== undefined));
  for (const doc of documents) assert.match(doc, /^query\s/);
  const mod = await import('../src/intake/linear.ts');
  assert.deepEqual(Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort(), [
    'canonicalLinearUrl', 'createLinearClient', 'linearKeyPath', 'readLinearKey',
  ]);
});
const readHolds = () => {
  const path = join(process.env.IDD_STATE_DIR, 'intake-holds.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).holds : [];
};

test('a Linear blocker with a non-done state type holds the Issue, read in the same list query', async () => {
  setup({ repos: linearOnly() });
  const blocked = node('APP-1', 'Todo', { override: { inverseRelations: { nodes: [blocker('APP-9', 'started')] } } });
  const linear = fakeLinear([blocked, node('APP-2', 'Todo')]);
  const r = await runIntake({ linearFetch: linear.fetch });
  assert.deepEqual(readBacklog().map((b) => b.linear_issue_url), ['https://linear.app/org/issue/APP-2']);
  assert.deepEqual(r.held.map((h) => h.ref), ['APP-1']);
  assert.deepEqual(r.held[0].blockers.map((b) => [b.ref, b.state, b.scope]), [['APP-9', 'open', 'APP']]);
  assert.deepEqual(readHolds().map((h) => h.ref), ['APP-1']);
  // one query for the assigned list, and it carries the dependencies
  assert.equal(linear.calls.length, 1);
  assert.match(linear.calls[0].body.query, /inverseRelations/);
});

test('a Linear blocker is closed by its state type, not by the name a team gives the state', async () => {
  for (const [stateType, added] of [['completed', 2], ['canceled', 2], ['duplicate', 2], ['started', 1]]) {
    setup({ repos: linearOnly() });
    const blocked = node('APP-1', 'Todo', { override: { inverseRelations: { nodes: [blocker('APP-9', stateType, 'Shipped')] } } });
    const r = await runIntake({ linearFetch: fakeLinear([blocked, node('APP-2', 'Todo')]).fetch });
    assert.equal(r.added.length, added, stateType);
    assert.deepEqual(r.held.map((h) => h.ref), stateType === 'started' ? ['APP-1'] : []);
  }
  // a relation that is not `blocks` is not a dependency
  setup({ repos: linearOnly() });
  const related = node('APP-1', 'Todo', { override: { inverseRelations: { nodes: [{ type: 'related', issue: node('APP-9', 'In Progress', { stateType: 'started' }) }] } } });
  assert.equal((await runIntake({ linearFetch: fakeLinear([related]).fetch })).added.length, 1);
});

test('a Linear blocker in another repo / team is not followed, and is recorded', async () => {
  setup({ repos: { ...linearOnly(), 'a/bac': { upstream: '/u2', work: '/w2', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['BAC'] } } } } });
  const otherRepo = node('APP-1', 'Todo', { override: { inverseRelations: { nodes: [blocker('BAC-9', 'started')] } } });
  const noTeam = node('APP-2', 'Todo', { override: { inverseRelations: { nodes: [blocker('WEB-9', 'started')] } } });
  const r = await runIntake({ linearFetch: fakeLinear([otherRepo, noTeam]).fetch });
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.held, []);
  assert.deepEqual(r.ignoredBlockers.map((d) => [d.ref, d.blocker.ref, d.blocker.scope]).sort(), [['APP-1', 'BAC-9', 'BAC'], ['APP-2', 'WEB-9', 'WEB']]);
});

test('a relation connection that read too few holds the Issue even when the read ones are done', async () => {
  setup({ repos: linearOnly() });
  const blocked = node('APP-1', 'Todo', { override: { inverseRelations: { nodes: [blocker('APP-9', 'completed')], pageInfo: { hasNextPage: true } } } });
  const r = await runIntake({ linearFetch: fakeLinear([blocked]).fetch });
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.held.map((h) => h.ref), ['APP-1']);
  assert.match(r.held[0].reason, /1 回で読める数/);
});

test('naming a Linear Issue reads no dependencies', async () => {
  setup({ repos: linearOnly() });
  const linear = fakeLinear([], undefined, [node('APP-7', 'Todo')]);
  const r = await runIntake({ issueRefs: [{ identifier: 'APP-7' }], linearFetch: linear.fetch });
  assert.equal(r.added.length, 1);
  assert.equal(linear.calls.length, 1);
  assert.doesNotMatch(linear.calls[0].body.query, /inverseRelations/);
});

/** Linear's answer on 2026-10-16 when the assigned list asked for too many Issues in one page */
const tooComplex = () => ({ ok: false, status: 400, json: async () => ({ errors: [{ message: 'Query too complex', extensions: { code: 'BAD_USER_INPUT' } }] }) });

test('the default page width keeps the assigned list within the complexity limit', async () => {
  setup({ repos: linearOnly() });
  const nodes = Array.from({ length: 15 }, (_, i) => node(`APP-${i + 1}`, 'Todo'));
  // a Linear that refuses any page wider than 10 with the 400 the real API returned
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sentBodies.push(body);
    calls.push(body);
    if (body.variables.id !== undefined) throw new Error('the assigned list must not read one Issue by identifier');
    if (body.variables.first > 10) return tooComplex();
    const offset = body.variables.after ? Number(body.variables.after) : 0;
    const page = nodes.slice(offset, offset + body.variables.first);
    const next = offset + page.length;
    return {
      ok: true, status: 200,
      json: async () => ({ data: { viewer: { assignedIssues: { nodes: page, pageInfo: { hasNextPage: next < nodes.length, endCursor: String(next) } } } } }),
    };
  };

  const list = await listIntakeCandidates({ linearFetch: fetch });
  assert.deepEqual(list.failures, []);
  assert.equal(list.candidates.filter((c) => c.source === 'linear').length, 15);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.variables.first <= 10), JSON.stringify(calls.map((c) => c.variables.first)));
});

test('the default page width keeps the unassigned list within the complexity limit too', async () => {
  // the unassigned list reads the same fields and relations, so the same width is refused
  setup({ repos: { 'a/app': { upstream: '/u', work: '/w', issue_lane: { source_type_priority: 'linear', intake_filter: { linear_teams: ['APP'], linear_include_unassigned: true } } } } });
  const nodes = Array.from({ length: 15 }, (_, i) => node(`APP-${i + 1}`, 'Todo'));
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sentBodies.push(body);
    calls.push(body);
    if (body.variables.first > 10) return tooComplex();
    const offset = body.variables.after ? Number(body.variables.after) : 0;
    const page = nodes.slice(offset, offset + body.variables.first);
    const next = offset + page.length;
    const pageInfo = { hasNextPage: next < nodes.length, endCursor: String(next) };
    return {
      ok: true, status: 200,
      json: async () => (body.variables.teams !== undefined
        ? { data: { issues: { nodes: page, pageInfo } } }
        : { data: { viewer: { assignedIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
    };
  };

  const list = await listIntakeCandidates({ linearFetch: fetch, includeUnassigned: true });
  assert.deepEqual(list.failures, []);
  assert.equal(list.candidates.filter((c) => c.source === 'linear').length, 15);
  const unassignedCalls = calls.filter((c) => c.variables.teams !== undefined);
  assert.equal(unassignedCalls.length, 2);
  assert.ok(unassignedCalls.every((c) => c.variables.first <= 10), JSON.stringify(unassignedCalls.map((c) => c.variables.first)));
});

test('the intake cap stays at 100 Issues however wide the page is', async () => {
  setup({ repos: linearOnly() });
  const nodes = Array.from({ length: 150 }, (_, i) => node(`APP-${i + 1}`, 'Todo'));
  const linear = fakeLinear(nodes);
  const list = await listIntakeCandidates({ linearFetch: linear.fetch });
  assert.equal(list.candidates.filter((c) => c.source === 'linear').length, 100);
  assert.match(list.failures.map((f) => f.reason).join(' '), /上限 100 件/);
  assert.equal(linear.calls.length, 10);
  assert.ok(linear.calls.every((c) => c.body.variables.first <= 10));
});

test("a 400 names the status and Linear's own words, and a body that is not JSON is the status alone", async () => {
  setup({ repos: linearOnly() });
  const list = await listIntakeCandidates({ linearFetch: fakeLinear([], tooComplex).fetch });
  assert.deepEqual(list.failures.map((f) => f.area), ['linear']);
  assert.match(list.failures[0].reason, /HTTP 400/);
  assert.match(list.failures[0].reason, /Query too complex/);

  const named = await runIntake({ issueRefs: [{ identifier: 'APP-7' }], linearFetch: fakeLinear([], tooComplex).fetch });
  assert.deepEqual(named.added, []);
  assert.match(named.failures[0].reason, /HTTP 400/);
  assert.match(named.failures[0].reason, /Query too complex/);
  assert.match(named.failures[0].reason, /APP-7/);

  // a 400 whose body is not JSON leaves only the status
  const notJson = async () => ({ ok: false, status: 400, json: async () => { throw new Error('not json'); } });
  const bare = await listIntakeCandidates({ linearFetch: fakeLinear([], notJson).fetch });
  assert.equal(bare.failures[0].reason, 'Linear API: HTTP 400');
  const bareNamed = await runIntake({ issueRefs: [{ identifier: 'APP-7' }], linearFetch: fakeLinear([], notJson).fetch });
  assert.match(bareNamed.failures[0].reason, /HTTP 400/);
  assert.doesNotMatch(bareNamed.failures[0].reason, /Query too complex/);
});

test('a 400 whose message carries the key is redacted in the reason and nowhere else', async (t) => {
  const { state } = setup({ repos: linearOnly() });
  const printed = [];
  for (const m of ['log', 'error', 'warn', 'info', 'debug']) t.mock.method(console, m, (...a) => printed.push(a.join(' ')));
  const leaky = async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ message: `Query too complex (key ${KEY})` }] }) });
  const list = await listIntakeCandidates({ linearFetch: fakeLinear([], leaky).fetch });
  const named = await runIntake({ issueRefs: [{ identifier: 'APP-7' }], linearFetch: fakeLinear([], leaky).fetch });
  for (const out of [list, named]) {
    assert.ok(!JSON.stringify(out).includes(KEY), JSON.stringify(out));
    const reason = out.failures.find((f) => f.area === 'linear').reason;
    assert.match(reason, /HTTP 400/);
    assert.match(reason, /\[redacted\]/);
  }
  assert.ok(!allStateText(state).includes(KEY));
  assert.ok(!printed.join('\n').includes(KEY));
});

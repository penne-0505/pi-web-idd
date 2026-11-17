import assert from 'node:assert/strict';
import { test } from 'node:test';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';
import { ghOnPath } from './helpers/fake-gh.mjs';
import { commitManifest, GOOD_MANIFEST as GOOD, gitIn, registerRepos, workClone } from './helpers/work-clone.mjs';
import { listIntakeCandidates, runIntake } from '../src/intake/run.ts';
import { readBacklog } from '../src/ledger/read.ts';

const KEY = 'lin_api_TESTSECRET_0123456789';
/**
 * Repos named by `manifests` ({ name: manifest text | null (none) | 'no clone' }), each taking GitHub Issues
 * (a gh that has one Issue per repo) or, for those in `linear`, the Linear Issues of that team.
 */
function setup(manifests, { linear = {} } = {}) {
  const root = scratchDir('intake-manifest-');
  ghOnPath(`const a = process.argv.slice(2);
const m = /repos\\/([^/]+\\/[^/]+)/.exec(a.join(' '));
const repo = m ? m[1] : a[a.indexOf('--repo') + 1];
const url = 'https://github.com/' + repo + '/issues/1';
const i = { number: 1, title: 'one in ' + repo, url, html_url: url, body: '', created_at: '2026-09-23T00:00:00Z', createdAt: '2026-09-23T00:00:00Z', state: 'open', labels: [{ name: 'idd-ready' }] };
console.log(JSON.stringify(a[0] === 'api' ? i : [i]));`);
  const clones = {};
  const repos = Object.fromEntries(Object.entries(manifests).map(([name, manifest]) => {
    const work = manifest === 'no clone' ? join(root, `absent-${name}`) : (clones[name] = workClone(root, `w-${name}`, manifest));
    const [source, filter] = linear[name] ? ['linear', { linear_teams: [linear[name]] }] : ['github', { github_labels: ['idd-ready'] }];
    return [`a/${name}`, { upstream: join(root, `u-${name}`), work, work_base: 'work-main', public_base: 'main', issue_lane: { source_type_priority: source, intake_filter: filter } }];
  }));
  registerRepos(root, repos);
  process.env.LINEAR_API_KEY = KEY;
  process.env.IDD_LINEAR_KEY_FILE = join(root, 'no-key-file');
  return { clones };
}

/** a Linear that has the Issue APP-1 (assigned, Todo) and answers it by identifier too */
const linearApp = () => {
  const issue = { identifier: 'APP-1', title: 'app one', url: 'https://linear.app/o/issue/APP-1/x', team: { key: 'APP' }, state: { name: 'Todo' }, labels: { nodes: [] } };
  const answers = (asked) => {
    if (asked.id !== undefined) return { issue };
    const page = { nodes: asked.teams ? [] : [issue], pageInfo: { hasNextPage: false } };
    return asked.teams ? { issues: page } : { viewer: { assignedIssues: page } };
  };
  return { linearFetch: async (url, init) => ({ ok: true, status: 200, json: async () => ({ data: answers(JSON.parse(init.body).variables) }) }) };
};

const addedBy = async (opts) => (await runIntake(opts)).added.length;
const refusalOf = (failures, area) => failures.filter((f) => f.area === area).map((f) => f.reason);

test('a repo whose work base has no manifest is refused, in the list and in a run, and the others go on', async () => {
  setup({ bare: null, ready: GOOD });
  const listed = await listIntakeCandidates();
  assert.deepEqual(listed.candidates.map((c) => c.area), ['a/ready']);
  const [reason] = refusalOf(listed.failures, 'a/bare');
  assert.ok(reason, 'the list refuses a/bare');
  const run = await runIntake();
  assert.equal(run.added.length, 1);
  assert.deepEqual(readBacklog().map((r) => r.area), ['a/ready']);
  assert.deepEqual(refusalOf(run.failures, 'a/bare'), [reason]);
});

test('the refusal names the work base, the file and what to write, and no command that does not run for a registered repo', async () => {
  setup({ bare: null });
  const [reason] = refusalOf((await listIntakeCandidates()).failures, 'a/bare');
  for (const part of [/work-main/, /overlay\.manifest.*commit/, /_docs\/.*overlay\.manifest 自身の行/]) assert.match(reason, part);
  assert.doesNotMatch(reason, /idd repo (init|migrate)/);
});

test('a manifest that cannot be used is refused with its reason, and a fixed one opens the lane', async () => {
  const { clones } = setup({ bad: '_docs/\n/etc/passwd\n' });
  const first = await runIntake();
  assert.deepEqual(first.added, []);
  assert.deepEqual(readBacklog(), []);
  const [reason] = refusalOf(first.failures, 'a/bad');
  assert.match(reason, /2 行目 \/etc\/passwd/);
  assert.match(reason, /manifest 自身の除外が必要です/);
  commitManifest(clones.bad, GOOD);
  assert.equal(await addedBy(), 1);
});

test('a manifest that is a symlink is refused as one, and a regular file of the same name opens the lane', async () => {
  const { clones } = setup({ link: null });
  const dir = clones.link;
  symlinkSync('overlay.manifest', join(dir, 'overlay.manifest'));
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', 'link');
  const [reason] = refusalOf((await runIntake()).failures, 'a/link');
  assert.match(reason, /overlay\.manifest.*symlink/);
  gitIn(dir, 'rm', '-q', 'overlay.manifest');
  gitIn(dir, 'commit', '-qm', 'unlink');
  commitManifest(dir, GOOD);
  assert.equal(await addedBy(), 1);
});

test('the manifest is read from the work base, not from the working tree', async () => {
  const { clones } = setup({ bare: null });
  writeFileSync(join(clones.bare, 'overlay.manifest'), GOOD);
  assert.equal(refusalOf((await runIntake()).failures, 'a/bare').length, 1);
});

test('a repo with no work clone on this machine is not reported as missing a manifest', async () => {
  setup({ away: 'no clone', ready: GOOD });
  const listed = await listIntakeCandidates();
  assert.deepEqual(listed.failures, []);
  assert.deepEqual(listed.candidates.map((c) => c.area).sort(), ['a/away', 'a/ready']);
});

test('a named GitHub Issue of a repo without a manifest is refused once, and one with a manifest is taken in', async () => {
  const { clones } = setup({ bare: null, ready: GOOD });
  const refused = await runIntake({ issueRefs: [{ repo: 'a/bare', number: 1 }, { repo: 'a/bare', number: 2 }] });
  assert.deepEqual(refused.added, []);
  assert.equal(refusalOf(refused.failures, 'a/bare').length, 1);
  assert.deepEqual(readBacklog(), []);
  commitManifest(clones.bare, GOOD);
  assert.equal(await addedBy({ issueRefs: [{ repo: 'a/bare', number: 1 }] }), 1);
});

test('a Linear Issue named by identifier is refused when its repo has no manifest, listed or named', async () => {
  const { clones } = setup({ app: null }, { linear: { app: 'APP' } });
  const named = await runIntake({ issueRefs: [{ identifier: 'APP-1' }], ...linearApp() });
  assert.equal(named.added.length, 0);
  assert.match(refusalOf(named.failures, 'a/app')[0], /overlay\.manifest/);
  assert.match(named.skipped[0].reason, /a\/app/);
  const listed = await listIntakeCandidates(linearApp());
  assert.deepEqual(listed.candidates, []);
  assert.equal(refusalOf(listed.failures, 'a/app').length, 1);
  commitManifest(clones.app, GOOD);
  assert.equal(await addedBy({ issueRefs: [{ identifier: 'APP-1' }], ...linearApp() }), 1);
});

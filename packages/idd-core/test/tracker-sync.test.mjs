import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import { restoreStateEnv } from "./helpers/state-env.mjs";
import { parseRepos } from "../src/config/areas.ts";
import * as store from "../src/intent/store.ts";
import * as projects from "../src/intent/project-store.ts";
import { issueStatuses } from "../src/intent/project.ts";
import { createLinearClient } from "../src/intake/linear.ts";
import { createGithubReader } from "../src/sync/github.ts";
import { createLinearReader } from "../src/sync/linear.ts";
import { conflictId, normBody, planSync } from "../src/sync/plan.ts";
import { runTrackerSync, syncRepo, withRefused } from "../src/sync/run.ts";
import { trackerSyncOf } from "../src/sync/config.ts";
import { openConflicts, readBaseline, readConflicts, slug, syncDir } from "../src/sync/store.ts";
import { emptyBaseline } from "../src/sync/types.ts";

restoreStateEnv();

const REPO = "me/app";
const OTHER = "me/other";
const OUTSIDE = { session: "s1" };
const NOW = new Date("2026-10-28T10:00:00Z");

function setup() {
  const root = scratchDir("tracker-sync-");
  const state = join(root, "state");
  mkdirSync(state);
  const entry = (name) => ({ upstream: join(root, `${name}-u`), work: join(root, `${name}-w`), public_base: "main", tracker_sync: { target: "github" } });
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: { [REPO]: entry("app"), [OTHER]: entry("other") } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") });
  return { root, state };
}

async function activePurpose() {
  const r = await store.raisePurpose({ repo: REPO, actor: OUTSIDE, statement: "利用者が外の変化を受け取りたい。なぜなら 2 か所を見比べたくないから。", origin: "常設" });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

async function newProject(purpose, over = {}) {
  const r = await projects.raiseProject({ repo: REPO, actor: OUTSIDE, body: { name: "Alpha", purpose, done_when: "外の変化が見える", body: "A", ...over } });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

/**
 * A reader whose snapshot a test sets. Every property read on it is recorded, so a test can say the sync touched
 * nothing of the outside but `read`: the reader has no other door to be asked for.
 */
function fakeReader(initial, { onRead } = {}) {
  const touched = new Set();
  const calls = { read: 0 };
  const box = { snapshot: initial };
  const target = {
    tracker: "github",
    owns: (ref) => ref.startsWith("me/app#"),
    read: async (refs) => {
      calls.read += 1;
      if (onRead) await onRead(calls.read, refs);
      return structuredClone(box.snapshot);
    },
  };
  const reader = new Proxy(target, { get(t, key) { touched.add(String(key)); return t[key]; } });
  return { reader, touched, calls, box, deps: { readerFor: () => reader, now: () => NOW } };
}

const ext = (projectsList, issues = []) => ({ projects: projectsList, issues });
const extProject = (over = {}) => ({ id: "7", name: "alpha", body: "A", ...over });
const extIssue = (n, over = {}) => ({ ref: `me/app#${n}`, closed: false, projectId: "7", ...over });
const pair = (alpha, issues) => ext([extProject(alpha), extBeta()], issues);
const issuesOf = (id) => projects.projectStatuses(REPO, null).find((p) => p.id === id).issues;
const links = () => readBaseline(REPO).links;
/** a reader that shows `snapshot`, and the sync it has already run once */
async function synced(snapshot) {
  const fake = fakeReader(snapshot);
  await sync(fake);
  return fake;
}
const only = () => projects.projectStatuses(REPO, null)[0];
const extBeta = () => extProject({ id: "8", name: "beta", body: "" });
const sync = (fake) => syncRepo(REPO, { force: true }, fake.deps);
const edit = (id, patch, more = {}, actor = OUTSIDE) => projects.updateProject({ repo: REPO, actor, id, patch, ...more });
const attach = (id, issues, more = {}, actor = OUTSIDE) => projects.attachIssues({ repo: REPO, actor, id, issues, ...more });
const detach = (id, issues) => projects.detachIssues({ repo: REPO, actor: OUTSIDE, id, issues });

/** a repo set up with an active Purpose and one Project, "Alpha" */
async function begin() {
  setup();
  const purpose = await activePurpose();
  return { purpose, id: await newProject(purpose) };
}

/** `begin`, and a first sync against an outside whose milestone Alpha holds the Issues numbered */
async function begunWith(...numbers) {
  const { purpose, id } = await begin();
  return { purpose, id, fake: await synced(ext([extProject()], numbers.map((n) => extIssue(n)))) };
}

/** `begin` with a second Project, Beta, and a first sync against both milestones with the Issues numbered in Alpha's */
async function begunWithBeta(...numbers) {
  const { purpose, id } = await begin();
  const other = await newProject(purpose, { name: "Beta", body: "" });
  return { purpose, id, other, fake: await synced(pair({}, numbers.map((n) => extIssue(n)))) };
}

/** a repo with Alpha and Beta and nothing synced */
async function twoProjects() {
  setup();
  const purpose = await activePurpose();
  return { purpose, alpha: await newProject(purpose), beta: await newProject(purpose, { name: "Beta" }) };
}

test("AC-001: a body, a membership and a state only the outside changed come in without anyone's approval", async () => {
  const { id } = await begin();
  const fake = fakeReader(ext([extProject()]));
  let r = await sync(fake);
  assert.equal(r.error, undefined);
  assert.deepEqual(links(), { [id]: "7" }, "the pair is found by name when there is none");

  // the outside edits the description, files two Issues in the milestone and closes one
  fake.box.snapshot = ext([extProject({ body: "B\r\n外の人が書いた" })], [extIssue(1), extIssue(2, { closed: true })]);
  r = await sync(fake);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.conflicts, 0);
  const p = only();
  assert.equal(p.body, "B\n外の人が書いた", "propter's old value is replaced by the outside's");
  assert.deepEqual(p.issues, ["me/app#1", "me/app#2"]);
  assert.deepEqual(p.issueStatuses.map((i) => [i.issue, i.closed, i.via]), [["me/app#1", false, undefined], ["me/app#2", true, "external"]]);
  assert.equal(openConflicts([REPO]).length, 0, "no card is stacked for a change only the outside made");

  // the outside closes the other one: every Issue is closed and the Project becomes a candidate; the state stays
  fake.box.snapshot = ext([extProject({ body: "B\n外の人が書いた" })], [extIssue(1, { closed: true }), extIssue(2, { closed: true })]);
  await sync(fake);
  assert.equal(only().completionCandidate, true);
  assert.equal(only().state, "planned", "a candidate changes no state");

  // the outside takes Issue 1 out of the milestone: propter lets go of it
  fake.box.snapshot = ext([extProject({ body: "B\n外の人が書いた" })], [extIssue(1, { closed: true, projectId: null }), extIssue(2, { closed: true })]);
  await sync(fake);
  assert.deepEqual(only().issues, ["me/app#2"]);
});

test("AC-002: what only propter changed stays, and nothing is asked of the outside but a read", async () => {
  const { id, fake } = await begunWith(1);
  await attach(id, ["#1"]);
  await edit(id, { body: "propter で書き直した" });
  await projects.recordIssueState({ repo: REPO, actor: OUTSIDE, issue: "#1", closed: true });
  for (let i = 0; i < 2; i += 1) {
    const r = await sync(fake);
    assert.equal(r.intaken, 0);
    assert.equal(r.conflicts, 0);
    assert.equal(only().body, "propter で書き直した");
    assert.equal(only().issueStatuses[0].closed, true);
  }
  assert.deepEqual([...fake.touched].sort(), ["owns", "read"], "the sync asked the reader for nothing but reading");
});

test("AC-003: both sides changing the body or the membership is a conflict of three values, and either going back closes it", async () => {
  const { id, other, fake } = await begunWithBeta(1);
  assert.deepEqual(only().issues, ["me/app#1"]);

  // the body: propter says P, the outside says E, both last agreed on A
  await edit(id, { body: "P" });
  // the membership: propter moves the Issue to Beta, the outside to nowhere
  await attach(other, ["me/app#1"]);
  fake.box.snapshot = pair({ body: "E" }, [extIssue(1, { projectId: null })]);
  let r = await sync(fake);
  assert.equal(r.conflicts, 2);
  const open = readConflicts(REPO);
  const body = open.find((c) => c.unit === "project_body");
  assert.deepEqual([body.external, body.base, body.propter], ["E", "A", "P"]);
  const member = open.find((c) => c.unit === "issue_project");
  assert.match(member.external, /所属なし/);
  assert.match(member.base, new RegExp(id));
  assert.match(member.propter, new RegExp(other));
  const view = projects.projectStatuses(REPO, null);
  assert.equal(view.find((p) => p.id === id).body, "P", "neither value was taken");
  assert.deepEqual(issuesOf(other), ["me/app#1"]);
  assert.equal(openConflicts([REPO]).length, 2);

  // the outside goes back to propter's body: the body card closes; the membership one stays until its sides agree
  fake.box.snapshot = pair({ body: "P" }, [extIssue(1, { projectId: null })]);
  r = await sync(fake);
  assert.deepEqual(readConflicts(REPO).map((c) => c.unit), ["issue_project"]);
  // propter lets the Issue go too, so both are nowhere
  await detach(other, ["me/app#1"]);
  await sync(fake);
  assert.deepEqual(readConflicts(REPO), []);
  assert.equal(only().body, "P");
});

test("AC-004: a baseline that cannot be read stops that repo, never reads as empty, and the other repo goes on", async () => {
  setup();
  const purpose = await activePurpose();
  await newProject(purpose);
  const fake = fakeReader(ext([extProject({ body: "外の古い文" })]));
  mkdirSync(syncDir(), { recursive: true });
  for (const bad of [{ projectBody: [] }, { projectBody: "x" }, { issueClosed: { "me/app#1": "yes" } }, { links: { a: 1 } }, { repo: "me/other" }, [],
    { ...emptyBaseline(), version: 2 }, { ...emptyBaseline(), version: undefined }, { version: 1 },
    { version: 1, links: {}, projectBody: {}, issueProject: {} }]) {
    writeFileSync(join(syncDir(), `${slug(REPO)}.baseline.json`), JSON.stringify(bad));
    const r = await sync(fake);
    assert.match(r.error ?? "", /基準を読めません/, JSON.stringify(bad));
    assert.equal(only().body, "A", "propter's body is not replaced by the outside's older text");
  }
  writeFileSync(join(syncDir(), `${slug(REPO)}.baseline.json`), "{ not json");
  assert.match((await sync(fake)).error ?? "", /基準を読めません/);
  assert.equal(fake.calls.read, 0, "the outside is not even read");
  // the conflicts file is held to the same shape
  writeFileSync(join(syncDir(), `${slug(REPO)}.baseline.json`), JSON.stringify(emptyBaseline()));
  writeFileSync(join(syncDir(), `${slug(REPO)}.conflicts.json`), JSON.stringify({ not: "a list" }));
  assert.match((await sync(fake)).error ?? "", /ぶつかりの記録を読めません/);

  // one repo's stop does not stop another's sync
  writeFileSync(join(syncDir(), `${slug(REPO)}.baseline.json`), "{ not json");
  const results = await runTrackerSync({ force: true }, fake.deps);
  assert.equal(results.length, 2);
  assert.match(results.find((x) => x.repo === REPO).error ?? "", /基準/);
  assert.equal(results.find((x) => x.repo === OTHER).error, undefined);
  assert.equal(only().body, "A");
});

test("AC-003: a body a running lane changed and has not landed is propter's change, so the outside's text is not put over it", async () => {
  const { id, fake } = await begunWith();

  const lane = { lane: "IDD-9" };
  const wrote = await edit(id, { body: "lane の書いた文" }, {}, lane);
  assert.equal(wrote.ok, true, wrote.error);
  assert.equal(only().body, "A", "the lane has not landed, so nobody else sees its text");

  fake.box.snapshot = ext([extProject({ body: "外の文" })]);
  const r = await sync(fake);
  assert.equal(r.intaken, 0, "the outside's text was not taken in");
  assert.equal(r.conflicts, 1);
  const c = readConflicts(REPO)[0];
  assert.deepEqual([c.external, c.base, c.propter], ["外の文", "A", "lane の書いた文"]);
  assert.equal(only().body, "A", "no row was written over the lane's change");

  // a write that read the landed text is refused too, and the same write that read the lane's text is not
  const stale = await edit(id, { body: "外の文" }, { expectBody: "A" });
  assert.equal(stale.ok, false);
  const fresh = await edit(id, { body: "外の文" }, { expectBody: "lane の書いた文" });
  assert.equal(fresh.ok, true, fresh.error);
});

test("AC-003: an Issue a running lane moved away is put back by the sync as a row of its own, not taken for already there", async () => {
  const { alpha, beta } = await twoProjects();
  assert.equal((await attach(alpha, ["#1"])).ok, true);

  const lane = { lane: "IDD-9" };
  assert.equal((await attach(beta, ["#1"], {}, lane)).ok, true);
  assert.deepEqual(issuesOf(alpha), ["me/app#1"], "the lane has not landed, so the landed rows still say Alpha");

  // the sync read Beta (the lane's) as the owner and the outside says Alpha: the landed rows would call that already done
  const stale = await attach(alpha, ["#1"], { expectOwner: alpha });
  assert.equal(stale.ok, false, "a read of the landed owner is stale");
  const r = await attach(alpha, ["#1"], { expectOwner: beta });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.attached, ["me/app#1"], "a row was appended, not skipped as already");
  assert.deepEqual(r.already, []);
});

test("AC-005: propter changing while the outside is read is compared again, never overwritten", async () => {
  const { id } = await begin();
  await synced(ext([extProject()]));

  // the outside changed the body, and during the read a person edits it in propter
  let edited = false;
  const racing = fakeReader(ext([extProject({ body: "外の新しい文" })]), {
    onRead: async () => {
      if (edited) return;
      edited = true;
      await edit(id, { body: "読んでいる間に書いた文" });
    },
  });
  const r = await sync(racing);
  assert.equal(racing.calls.read, 2, "the outside is read again against propter's new state");
  assert.equal(only().body, "読んでいる間に書いた文", "the edit made during the read is not overwritten");
  assert.equal(r.conflicts, 1, "both changed, so it is compared as a conflict");

  // propter keeps moving for as long as the sync reads: the round is dropped and nothing is taken in
  const before = readBaseline(REPO);
  let n = 0;
  const busy = fakeReader(ext([extProject({ body: "また別の外の文" })]), {
    onRead: async () => { n += 1; await projects.updateProject({ repo: REPO, actor: OUTSIDE, id, patch: { body: `動き続ける ${n}` } }); },
  });
  const skipped = await sync(busy);
  assert.match(skipped.skipped ?? "", /次の同期に回します/);
  assert.equal(skipped.intaken, 0);
  assert.match(only().body, /^動き続ける/);
  assert.deepEqual(readBaseline(REPO), before, "the baseline did not move");
});

test("AC-005: a write names the value the compare read and is refused when propter moved since", async () => {
  const { purpose, id } = await begin();
  const stale = await edit(id, { body: "外" }, { expectBody: "別の文" });
  assert.equal(stale.ok, false);
  assert.equal(only().body, "A");
  assert.equal((await edit(id, { body: "外" }, { expectBody: "A" })).ok, true);
  const other = await newProject(purpose, { name: "Beta" });
  assert.equal((await attach(id, ["#1"], { expectOwner: other })).ok, false);
  assert.equal((await attach(id, ["#1"], { expectOwner: "" })).ok, true);
});

test("AC-003: a take-in refused because propter moved shows the conflict as it stands now, and never loses the card it had", async () => {
  const { id, fake } = await begunWith();
  await edit(id, { body: "P" });
  fake.box.snapshot = ext([extProject({ body: "E" })]);
  await sync(fake);
  assert.equal(readConflicts(REPO).length, 1);

  // the compare read propter's body as the baseline's (so only the outside changed), and it was P by the time of the write
  const input = { cfg: trackerSyncOf(REPO), baseline: readBaseline(REPO), ext: fake.box.snapshot, owns: fake.reader.owns };
  const stale = planSync({ repo: REPO, ...input, prop: { projects: [{ id, name: "Alpha", body: "A", issues: [] }], closed: () => false } });
  assert.equal(stale.intake.length, 1);
  assert.equal(stale.conflicts.length, 0);
  const cid = conflictId(REPO, "project_body", id);
  const kept = withRefused(REPO, stale, new Set([cid]), input);
  assert.deepEqual(kept.conflicts.map((c) => [c.id, c.external, c.base, c.propter]), [[cid, "E", "A", "P"]]);
  assert.equal(kept.compared.includes(cid), false, "a refused unit was not settled, so its card is not dropped");

  // a sync whose write is refused and finds no conflict now leaves the card as it was
  const same = withRefused(REPO, stale, new Set([cid]), { ...input, ext: ext([extProject({ body: "P" })]) });
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.uncertain, [cid]);
});

test("AC-005: a detach names the Project it read the Issue in and is refused when a running lane moved the Issue since", async () => {
  const { alpha, beta } = await twoProjects();
  await attach(alpha, ["#1"]);
  assert.equal((await attach(beta, ["#1"], {}, { lane: "IDD-9" })).ok, true);
  const refused = await projects.detachIssues({ repo: REPO, actor: OUTSIDE, id: alpha, issues: ["#1"], expectOwner: alpha });
  assert.equal(refused.ok, false, "the lane's move is a change the detach did not read");
  assert.deepEqual(issuesOf(alpha), ["me/app#1"]);
  assert.equal((await projects.detachIssues({ repo: REPO, actor: OUTSIDE, id: alpha, issues: ["#1"] })).ok, true, "a writer that read nothing keeps the old behaviour");
});

test("an Issue that moved to an outside Project propter has no pair for leaves its Project, and a card names that Project when propter moved it too", async () => {
  const { purpose, id } = await begin();
  const other = await newProject(purpose, { name: "Beta", body: "" });
  const stray = extProject({ id: "9", name: "stray", body: "" });
  const both = [extProject(), extBeta(), stray];
  const fake = await synced(ext(both, [extIssue(1), extIssue(2)]));
  await attach(other, ["me/app#2"]);
  fake.box.snapshot = ext(both, [extIssue(1, { projectId: "9" }), extIssue(2, { projectId: "9" })]);
  const r = await sync(fake);
  assert.deepEqual(issuesOf(id), [], "propter's old membership is not kept");
  assert.equal(projects.projectStatuses(REPO, null).length, 2, "the outside-only Project is not made");
  const card = readConflicts(REPO)[0];
  assert.deepEqual([readConflicts(REPO).length, card.subject, card.external], [1, "me/app#2", "未対の milestone（9）"]);
  assert.equal(r.conflicts, 1);
  await sync(fake);
  assert.deepEqual(issuesOf(other), ["me/app#2"], "a changed one stays, and a second sync takes nothing more in");
});

test("the Linear reader counts duplicate as closed and never takes a partial answer for a whole Issue", async () => {
  const answer = (issue, errors) => async () => ({ ok: true, status: 200, json: async () => ({ data: { issue }, ...(errors ? { errors } : {}) }) });
  const read = (fetch) => createLinearClient("k", { fetch }).getSyncIssue("APP-1");
  assert.equal((await read(answer({ identifier: "APP-1", state: { type: "duplicate" }, project: null }))).closed, true);
  await assert.rejects(read(answer({ identifier: "APP-1", state: { type: "started" }, project: null }, [{ message: "project resolver failed" }])), /project resolver failed/);
  assert.equal(await read(answer(null, [{ message: "Entity not found: Issue" }])), null);
  const snapshot = await createLinearReader("app", createLinearClient("k", { fetch: async (_u, init) => {
    const q = JSON.parse(init.body).query;
    const data = q.includes("TeamProjects") ? { teams: { nodes: [{ projects: { nodes: [], pageInfo: {} } }] } } : { issue: { identifier: "APP-1", state: { type: "started" }, project: null } };
    return { ok: true, status: 200, json: async () => ({ data, ...(q.includes("SyncIssue") ? { errors: [{ message: "boom" }] } : {}) }) };
  } })).read(["APP-1"]);
  assert.deepEqual([snapshot.issues, snapshot.unread], [[], ["APP-1"]], "an unread Issue is neither gone nor in no Project");
});

test("AC-006: the sync has no write to either tracker: no write path in the source, and the GitHub reader only reads", async () => {
  const dir = join(process.cwd(), "packages", "idd-core", "src", "sync");
  const source = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.doesNotMatch(source, /writeChange|grantWrite|resolveConflict|adapter\.write|requireGrant/);
  assert.doesNotMatch(source, /--method|"-f"|"-F"|\bPATCH\b|\bPOST\b|\bmutation\b/);
  const asked = [];
  const reader = createGithubReader("Me/App", async (args) => {
    asked.push(args);
    return args[1].startsWith("repos/Me/App/milestones")
      ? JSON.stringify([{ number: 3, title: "Alpha", description: "説明" }])
      : JSON.stringify([{ number: 1, state: "closed", milestone: { number: 3 } }, { number: 2, state: "open", milestone: null, pull_request: {} }]);
  });
  const snapshot = await reader.read([]);
  assert.deepEqual(snapshot.projects, [{ id: "3", name: "Alpha", body: "説明" }]);
  assert.deepEqual(snapshot.issues, [{ ref: "me/app#1", closed: true, projectId: "3" }], "a pull request is not an Issue");
  for (const args of asked) {
    assert.equal(args[0], "api");
    assert.equal(args.length, 2, "a path with its query and nothing else: no method, no field");
  }
});

test("the Linear reader asks only fixed query documents and returns the state and the Project of each Issue", async () => {
  const sent = [];
  const fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    sent.push({ query, variables });
    const data = query.includes("TeamProjects")
      ? { teams: { nodes: [{ projects: { nodes: [{ id: "p1", name: "Alpha", description: "説明", url: "u" }], pageInfo: { hasNextPage: false } } }] } }
      : query.includes("ProjectIssues")
        ? { project: { issues: { nodes: [{ identifier: "app-1", state: { type: "completed" }, project: { id: "p1" } }, { identifier: "APP-2", state: { type: "started" }, project: { id: "p1" } }], pageInfo: { hasNextPage: false } } } }
        : { issue: { identifier: "APP-9", state: { type: "canceled" }, project: null } };
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const reader = createLinearReader("app", createLinearClient("secret-key", { fetch }));
  const snapshot = await reader.read(["APP-9", "me/app#1"]);
  assert.deepEqual(snapshot.projects, [{ id: "p1", name: "Alpha", body: "説明", url: "u" }]);
  assert.deepEqual(snapshot.issues.map((i) => [i.ref, i.closed, i.projectId]), [["APP-1", true, "p1"], ["APP-2", false, "p1"], ["APP-9", true, null]]);
  assert.equal(sent.length, 3);
  for (const s of sent) assert.match(s.query, /^query\s/);
  assert.equal(reader.owns("APP-3"), true);
  assert.equal(reader.owns("OTHER-3"), false);
});

test("a Project is paired by name only while it has no pair, and the pair outlasts a rename of either side", async () => {
  const { id, fake } = await begunWith();
  assert.deepEqual(links(), { [id]: "7" });

  // the outside renames its Project and another one takes the old name, then propter renames its own: the pair never moves
  const renamed = (name) => ext([extProject({ name: "Renamed", body: "改名の後" }), extProject({ id: "9", name, body: "別の物" })]);
  const step = async (name) => {
    fake.box.snapshot = renamed(name);
    await sync(fake);
    assert.deepEqual(links(), { [id]: "7" });
  };
  await step("Alpha");
  assert.equal(only().body, "改名の後", "the pair followed the id, not the name");
  await edit(id, { name: "Gamma" });
  await step("Gamma");
  assert.equal(projects.projectStatuses(REPO, null).length, 1, "a Project only the outside has is not made in propter");
});

test("a name more than one Project holds does not pair, and the match is a whole name without regard to case", () => {
  const prop = { projects: [{ id: "PRJ-1", name: "Alpha", body: "", issues: [] }], closed: () => false };
  const plan = (extProjects, props = prop) => planSync({
    repo: REPO, cfg: { target: "github", intervalMinutes: 15 }, baseline: emptyBaseline(), ext: { projects: extProjects, issues: [] }, prop: props, owns: () => true,
  });
  assert.deepEqual(plan([{ id: "1", name: " ALPHA ", body: "" }]).settled.filter((p) => p.unit === "link"), [{ unit: "link", key: "PRJ-1", value: "1" }]);
  assert.deepEqual(plan([{ id: "1", name: "Alpha", body: "" }, { id: "2", name: "alpha", body: "" }]).settled.filter((p) => p.unit === "link"), []);
  assert.deepEqual(plan([{ id: "1", name: "Alpha 2", body: "" }]).settled.filter((p) => p.unit === "link"), [], "a part of a name is not a match");
  const twice = { projects: [prop.projects[0], { id: "PRJ-2", name: "alpha", body: "", issues: [] }], closed: () => false };
  assert.deepEqual(plan([{ id: "1", name: "Alpha", body: "" }], twice).settled.filter((p) => p.unit === "link"), [], "two of propter's with one name pair neither");
});

test("the outside's state ranks below a person's record and a landing, and is the one a lane cannot write", async () => {
  const issues = ["a", "b", "c", "d"];
  const at = { at: "t", by: { session: "s" } };
  const states = issueStatuses(
    { issues },
    {
      issueStates: [{ issue: "a", closed: false, ...at }],
      landed: new Map([["b", "IDD-1"]]),
      externalStates: [{ issue: "a", closed: true, ...at }, { issue: "b", closed: false, ...at }, { issue: "c", closed: true, ...at }, { issue: "d", closed: false, ...at }],
    },
  );
  assert.deepEqual(states.map((s) => [s.issue, s.closed, s.via]), [["a", false, undefined], ["b", true, "landing"], ["c", true, "external"], ["d", false, undefined]]);
  setup();
  const lane = await projects.recordExternalIssueState({ repo: REPO, actor: { lane: "IDD-7" }, issue: "#1", closed: true });
  assert.equal(lane.ok, false, "a lane cannot close an Issue of its own Project this way");
  assert.equal((await projects.recordExternalIssueState({ repo: REPO, actor: OUTSIDE, issue: "#1", closed: true })).ok, true);
});

test("the outside's description is compared whole: a mark in it hides nothing after it", () => {
  const text = "前の文\n<!-- propter:appendix -->\nその後ろの文";
  assert.equal(normBody(`  ${text.replace(/\n/g, "\r\n")}\n`), text);
  const prop = { projects: [{ id: "PRJ-1", name: "A", body: "前の文", issues: [] }], closed: () => false };
  const base = { ...emptyBaseline(), links: { "PRJ-1": "1" }, projectBody: { "PRJ-1": "前の文" } };
  const plan = planSync({ repo: REPO, cfg: { target: "github", intervalMinutes: 15 }, baseline: base, ext: { projects: [{ id: "1", name: "A", body: text }], issues: [] }, prop, owns: () => true });
  assert.deepEqual(plan.intake.map((o) => [o.op, o.value]), [["project_body", text]]);
});

test("the config reads tracker_sync beside the areas, refuses an unknown field, and needs a Linear team", () => {
  const entry = { upstream: "/u", work: "/w", public_base: "main" };
  const file = parseRepos(JSON.stringify({ repos: { "a/b": { ...entry, tracker_sync: { target: "github" } }, "c/d": { ...entry } } }));
  assert.deepEqual(file.trackerSync, { "a/b": { target: "github", intervalMinutes: 15 } });
  const plain = parseRepos(JSON.stringify({ repos: { "c/d": { ...entry } } }));
  assert.equal(plain.trackerSync, undefined, "a repo that writes none reads no outside");
  for (const bad of [{ target: "github", write: ["issue_state"] }, { target: "jira" }, { target: "linear" }, { target: "github", interval_minutes: 0 }, "github"]) {
    assert.throws(() => parseRepos(JSON.stringify({ repos: { "a/b": { ...entry, tracker_sync: bad } } })), /tracker_sync/, JSON.stringify(bad));
  }
  assert.deepEqual(parseRepos(JSON.stringify({ repos: { "a/b": { ...entry, tracker_sync: { target: "linear", linear_team: "app", interval_minutes: 30 } } } })).trackerSync["a/b"], { target: "linear", linearTeam: "APP", intervalMinutes: 30 });
  // the settings hash of the areas does not move for a repo that adds the field
  const a = parseRepos(JSON.stringify({ repos: { "a/b": { ...entry } } })).areas["a/b"];
  const b = parseRepos(JSON.stringify({ repos: { "a/b": { ...entry, tracker_sync: { target: "github" } } } })).areas["a/b"];
  assert.deepEqual(a, b);
});

test("the interval holds a tick's sync back, and a sync that was due runs", async () => {
  setup();
  const purpose = await activePurpose();
  await newProject(purpose);
  const fake = fakeReader(ext([extProject()]));
  assert.equal((await syncRepo(REPO, {}, fake.deps)).skipped, undefined);
  const again = await syncRepo(REPO, {}, fake.deps);
  assert.match(again.skipped ?? "", /分が経っていません/);
  assert.equal(fake.calls.read, 1);
  const later = { ...fake.deps, now: () => new Date(NOW.getTime() + 15 * 60_000 - 30_000) };
  assert.equal((await syncRepo(REPO, {}, later)).skipped, undefined, "a tick a little early for the timer's own delay still runs");
  assert.equal(fake.calls.read, 2);
});

test("the tick runs the sync as one of its stages, and a sync that fails stops no other stage", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  await newProject(purpose);
  // a `gh` that always fails: the real reader's only door to GitHub is this binary
  const gh = join(root, "gh");
  writeFileSync(gh, "#!/bin/sh\necho 'gh: 接続できません' >&2\nexit 1\n", { mode: 0o755 });
  const savedGh = process.env.IDD_GH_BIN;
  process.env.IDD_GH_BIN = gh;
  try {
    const { runTick } = await import("../src/plan/tick.ts");
    const result = await runTick({});
    assert.equal("skipped" in result, false);
    assert.deepEqual(result.trackerSync.map((x) => x.repo).sort(), [REPO, OTHER]);
    for (const x of result.trackerSync) assert.match(x.error ?? "", /接続できません/);
    assert.deepEqual(result.budget, { stopped: [], errors: 0 }, "the stages after it ran");
    assert.equal(only().body, "A");
    // a tick without the intake reads no outside
    const quiet = await runTick({ intake: false });
    assert.deepEqual(quiet.trackerSync, []);
  } finally {
    if (savedGh === undefined) delete process.env.IDD_GH_BIN;
    else process.env.IDD_GH_BIN = savedGh;
  }
});

test("the GitHub reader reads an Issue propter holds that the cut list did not show, one by one", async () => {
  const asked = [];
  const full = Array.from({ length: 100 }, (_, i) => ({ number: 1000 - i, state: "open", milestone: null }));
  const reader = createGithubReader("Me/App", async (args) => {
    asked.push(args[1]);
    const path = args[1];
    if (path.startsWith("repos/Me/App/milestones")) return JSON.stringify([{ number: 3, title: "Alpha", description: "" }]);
    if (path.startsWith("repos/Me/App/issues?")) return JSON.stringify(full);
    if (path === "repos/Me/App/issues/5") return JSON.stringify({ number: 5, state: "closed", milestone: { number: 3 } });
    if (path === "repos/Me/App/issues/6") throw new Error("gh: Not Found (HTTP 404)");
    if (path === "repos/Me/App/issues/7") throw new Error("gh: Bad Gateway (HTTP 502)");
    if (path === "repos/Me/App/issues/8") return JSON.stringify({ number: 8, state: "open", pull_request: {} });
    if (path === "repos/Me/App/issues/1000") throw new Error("a listed Issue is not asked for again");
    throw new Error(`unexpected ${path}`);
  });
  const snapshot = await reader.read(["me/app#5", "me/app#6", "me/app#7", "me/app#8", "me/app#1000", "other/x#2"]);
  assert.equal(snapshot.truncated, true, "the list stays reported as cut");
  assert.equal(snapshot.projectsTruncated, false);
  assert.deepEqual(snapshot.issues.find((i) => i.ref === "me/app#5"), { ref: "me/app#5", closed: true, projectId: "3" });
  assert.equal(snapshot.issues.some((i) => i.ref === "me/app#6"), false, "an Issue GitHub answers 404 for is left out: gone");
  assert.deepEqual(snapshot.unread, ["me/app#7", "me/app#8"], "a failed read and a pull request are unread, not gone");
  for (const path of asked) assert.doesNotMatch(path, /other\/x/);
  assert.equal(asked.filter((p) => /issues\/\d+$/.test(p)).length, 4);
});

test("an Issue beyond the cut list is compared, so an outside-only change reaches propter", async () => {
  const { id, fake } = await begunWith(1);
  assert.deepEqual(only().issues, ["me/app#1"]);
  // the list no longer shows #1 (cut), but the reader reads it by name and it is closed outside
  fake.box.snapshot = { ...ext([extProject()], [extIssue(1, { closed: true })]), truncated: true, projectsTruncated: false };
  const r = await sync(fake);
  assert.equal(r.error, undefined);
  assert.equal(fake.calls.read, 2);
  assert.equal(only().issueStatuses[0].closed, true);
  assert.equal(id, only().id);
});

test("an Issue that is gone outside is an outside change: propter at the baseline lets go of it, a changed one is a card showing it gone", async () => {
  const { id, other, fake } = await begunWithBeta(1, 2);
  assert.deepEqual(only().issues, ["me/app#1", "me/app#2"]);

  // #1 is deleted outside and propter did not touch it; #2 is deleted outside and propter moved it to Beta
  await attach(other, ["me/app#2"]);
  fake.box.snapshot = pair({}, []);
  let r = await sync(fake);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(issuesOf(id), [], "the gone Issue is no longer in the Project");
  assert.match(r.notes.join("\n"), /me\/app#1: 外で消えた/);
  const cards = readConflicts(REPO);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].subject, "me/app#2");
  assert.match(cards[0].external, /外で消えた/);
  assert.match(cards[0].base, new RegExp(id));
  assert.match(cards[0].propter, new RegExp(other));
  assert.deepEqual(issuesOf(other), ["me/app#2"], "propter's change stays");

  // an open card for a unit that conflicted before is redrawn with the outside gone
  fake.box.snapshot = pair({}, [extIssue(2, { projectId: null })]);
  await sync(fake);
  assert.match(readConflicts(REPO)[0].external, /所属なし/);
  fake.box.snapshot = pair({}, []);
  await sync(fake);
  assert.match(readConflicts(REPO)[0].external, /外で消えた/);

  // propter takes it out of every Project too: the baseline still has it in Alpha, so both sides changed and the card stays
  await detach(other, ["me/app#2"]);
  await sync(fake);
  const left = readConflicts(REPO);
  assert.deepEqual(left.map((c) => [c.subject, c.base.startsWith(id), c.propter]), [["me/app#2", true, "（所属なし）"]]);
  assert.match(left[0].external, /外で消えた/);

  // propter puts it back where the baseline had it: the outside's deletion stands alone, and it is taken in
  await attach(id, ["me/app#2"]);
  await sync(fake);
  assert.deepEqual(readConflicts(REPO), []);
  assert.deepEqual(issuesOf(id), []);
});

test("an Issue the reader could not read is not taken for gone, and its open card stays", async () => {
  setup();
  const purpose = await activePurpose();
  await newProject(purpose);
  const other = await newProject(purpose, { name: "Beta", body: "" });
  const both = [extProject(), extBeta()];
  const fake = await synced(ext(both, [extIssue(1)]));
  await attach(other, ["me/app#1"]);
  fake.box.snapshot = ext(both, [extIssue(1, { projectId: null })]);
  await sync(fake);
  assert.equal(readConflicts(REPO).length, 1);
  fake.box.snapshot = { ...ext(both, []), unread: ["me/app#1"] };
  const r = await sync(fake);
  assert.equal(readConflicts(REPO).length, 1, "nothing was seen that settles the card");
  assert.match(r.notes.join("\n"), /読めなかった/);
  assert.deepEqual(issuesOf(other), ["me/app#1"]);
});

test("a Project list that was cut short pairs nothing by name, and the first whole list pairs it", async () => {
  await begin();
  const cut = { ...ext([extProject()], []), truncated: true, projectsTruncated: true };
  const fake = fakeReader(cut);
  const r = await sync(fake);
  assert.deepEqual(links(), {}, "a same-named Project in view is not known to be the only one");
  assert.match(r.notes.join("\n"), /一覧が切れているので、名前では対にしません/);
  assert.equal(only().body, "A", "nothing of the outside came in through a pair that was never made");
  fake.box.snapshot = ext([extProject()], []);
  await sync(fake);
  assert.deepEqual(Object.values(links()), ["7"]);
});

test("a Project gone outside with a card on it is not paired again with a new same-named Project", async () => {
  const { id } = await begin();
  const fake = await synced(ext([extProject()], []));
  await edit(id, { body: "A 改" });
  fake.box.snapshot = ext([], []);
  await sync(fake);
  assert.deepEqual(readConflicts(REPO).map((c) => c.subject), [id]);
  fake.box.snapshot = ext([extProject({ id: "9", body: "別物" })], []);
  await sync(fake);
  assert.deepEqual(links(), { [id]: "7" }, "the pair a person has a card on is kept, and the new Project is not tied to it");
  assert.equal(only().body, "A 改");
});

test("a Project gone outside is an outside change: an unchanged one lets go of the pair, a changed one is a card showing it gone", async () => {
  const { purpose, id } = await begin();
  const other = await newProject(purpose, { name: "Beta", body: "B" });
  const fake = await synced(ext([extProject(), extProject({ id: "8", name: "beta", body: "B" })], [extIssue(1)]));
  assert.deepEqual(links(), { [id]: "7", [other]: "8" });

  // both milestones are deleted outside; propter changed Beta's text only
  await edit(other, { body: "B 改" });
  fake.box.snapshot = ext([], []);
  const r = await sync(fake);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(links(), { [other]: "8" }, "the unchanged Project let go of its pair");
  assert.match(r.notes.join("\n"), new RegExp(`${id}: 対の milestone が外で消えた`));
  const view = projects.projectStatuses(REPO, null);
  assert.equal(view.find((p) => p.id === id).body, "A", "propter's Project is untouched");
  assert.deepEqual(issuesOf(id), [], "its Issue, which propter did not move, leaves with the milestone");
  const cards = readConflicts(REPO);
  assert.deepEqual(cards.map((c) => c.subject), [other]);
  assert.match(cards[0].external, /外で消えた/);
  assert.deepEqual([cards[0].base, cards[0].propter], ["B", "B 改"]);

  // propter's text goes back to the baseline: the outside's change stands alone and the pair is let go
  await edit(other, { body: "B" });
  await sync(fake);
  assert.deepEqual(links(), {});
  assert.deepEqual(readConflicts(REPO), []);
});

test("a Project missing from a cut Project list is not taken for gone", async () => {
  const { id, fake } = await begunWith(1);
  fake.box.snapshot = { ...ext([], []), truncated: true, projectsTruncated: true };
  const r = await sync(fake);
  assert.deepEqual(links(), { [id]: "7" });
  assert.match(r.notes.join("\n"), /消えたとは扱いません/);
});

test("a Project gone outside takes the Issues propter left at the baseline out of it, with no card", async () => {
  const { id, fake } = await begunWith(1, 2);
  assert.deepEqual(issuesOf(id), ["me/app#1", "me/app#2"]);
  fake.box.snapshot = ext([], [extIssue(1, { projectId: null }), extIssue(2, { projectId: null })]);
  const r = await sync(fake);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(issuesOf(id), []);
  assert.deepEqual(readConflicts(REPO), []);
  assert.deepEqual(links(), {}, "the pair is let go");
  assert.equal(projects.projectStatuses(REPO, null).find((p) => p.id === id).body, "A", "propter's Project stays");
  assert.deepEqual(readBaseline(REPO).issueProject, { "me/app#1": "", "me/app#2": "" });
});

test("a card on an Issue moved off a gone Project keeps the pair and the last-in-step value until the sides agree", async () => {
  const { id, other, fake } = await begunWithBeta(1);
  assert.deepEqual(links(), { [id]: "7", [other]: "8" });

  // the milestone of Alpha is deleted outside, and propter moved the Issue to Beta meanwhile
  await attach(other, ["me/app#1"]);
  fake.box.snapshot = ext([extBeta()], [extIssue(1, { projectId: null })]);
  for (let i = 0; i < 2; i += 1) {
    const r = await sync(fake);
    assert.equal(r.error, undefined, r.error);
    const cards = readConflicts(REPO);
    assert.equal(cards.length, 1, `the card stays on sync ${i + 1}`);
    assert.match(cards[0].base, new RegExp(id));
    assert.match(cards[0].propter, new RegExp(other));
    assert.equal(links()[id], "7", "the pair is not let go while the card is open");
    assert.equal(readBaseline(REPO).issueProject["me/app#1"], id);
  }
  assert.deepEqual(issuesOf(other), ["me/app#1"]);

  // propter puts the Issue back where it was: nothing is left to compare and the pair goes
  await attach(id, ["me/app#1"]);
  await sync(fake);
  assert.deepEqual(readConflicts(REPO), []);
  assert.equal(links()[id], undefined);
});

test("an Issue the reader could not read keeps the pair of its gone Project", async () => {
  const { id, fake } = await begunWith(1);
  // the Issue is read as unread: not known to be gone, so the pair stays too
  fake.box.snapshot = { ...ext([], []), unread: ["me/app#1"] };
  await sync(fake);
  assert.equal(links()[id], "7", "an unread Issue of a gone Project holds the pair");
  assert.deepEqual(issuesOf(id), ["me/app#1"]);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

// The decide route asks for a tick after an approved push and after a check that passed: a test must not book the
// real systemd timer of the machine it runs on. Set before the route is imported.
process.env.IDD_TICK_KICK = "off";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { POST: decidePost } = await jiti.import("./decide.ts");
const { GET: stateGet } = await jiti.import("./state.ts");
const { readProposal, proposalPath, shipContentFor, laneLocations } = await jiti.import("../../../../packages/idd-core/src/overlay/export.ts");
const { prepareSubmit, localCompleteContentFor } = await jiti.import("../../../../packages/idd-core/src/plan/ship.ts");
const { readLifecycle } = await jiti.import("../../../../packages/idd-core/src/ledger/read.ts");
const { applyDecision } = await jiti.import("../../../../packages/idd-core/src/ledger/write.ts");
const { raiseProposal } = await jiti.import("../../../../packages/idd-core/src/intent/store.ts");
const { ensureLaneWorktree } = await jiti.import("../../../../packages/idd-core/src/worktree/ensure.ts");
const { getAgentRunner } = await jiti.import("../../../../packages/idd-core/src/index.ts");
const { createChallenge, createRegistrationOptions, finishRegistration } = await jiti.import("../../../../packages/idd-core/src/passkey.ts");
const { softwareAuthenticator } = await import("../../../../packages/idd-core/test/passkey-fixture.mjs");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";

Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@localhost", GIT_ALLOW_PROTOCOL: "file",
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = "chore: fixture") { git(cwd, "add", "."); git(cwd, "commit", "-m", message); }

const PR = { title: "feat: 題", body: "本文" };
const APPROVED = "feat: 承認した commit";

/** a repo that publishes, a lane at the submit card, and a fake gh: the same build as ship-approval.test.mjs */
function setup() {
  const root = scratchDir("run-"); const work = join(root, "work"), remote = join(root, "remote.git"), upstream = join(root, "upstream"), state = join(root, "state");
  mkdirSync(work); mkdirSync(state);
  git(root, "init", "--bare", "--initial-branch=main", remote); git(work, "init", "--initial-branch=main");
  put(join(work, ".gitignore"), "node_modules/\n"); put(join(work, "app.txt"), "one\n"); commit(work);
  git(work, "remote", "add", "origin", remote); git(work, "push", "origin", "main"); git(root, "clone", remote, upstream);
  git(upstream, "config", "user.name", "Upstream Person"); git(upstream, "config", "user.email", "person@example.com");
  git(work, "checkout", "-b", "work-main");
  put(join(work, "overlay.manifest"), "_docs/\noverlay.manifest\nAGENTS.override.md\n"); put(join(work, "AGENTS.override.md"), "private rules"); commit(work);
  const areas = join(root, "repos.json");
  const config = { github: "test/project", upstream, work, work_base: "work-main", public_base: "main", lanes_root: join(root, "lanes"), checks: [], issue_lane: { context: "personal", source_type_priority: "github" } };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, "unused") });
  const lane = ensureLaneWorktree("demo", "IDD-1");
  put(join(state, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", area: "demo", title: "feat: change" }) + "\n");
  put(join(state, "executor-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", worktree_path: lane.path, branch: lane.branch, executor_session_id: "test-session" }) + "\n");
  // a public change for the lane to submit: without one the submit is a local completion, which pushes nothing
  put(join(lane.path, "app.txt"), "ours\n"); commit(lane.path, "feat: ours");
  return { root, work, remote, upstream, state, lane };
}

/** a lane's own record, written straight to its lifecycle file: the fixture puts the lane at a stage, past the write gate */
const seed = (state, event, attrs = {}) => appendFileSync(join(state, "lifecycle-demo.jsonl"), JSON.stringify({ event, idd_id: "IDD-1", at: "2026-09-28T00:00:00Z", attrs }) + "\n");

/** a gh that keeps the repo's PRs in a file: `pr list` and `pr view` answer from it, `pr create` adds one. Every call is logged. */
function fakeGh(root, prs = []) {
  const dir = join(root, "gh"); mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.jsonl"), store = join(dir, "prs.json");
  writeFileSync(store, JSON.stringify(prs));
  const bin = join(dir, "gh");
  put(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const prs = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'));
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify(prs.filter((p) => p.headRefName === at('--head') && p.state === 'OPEN').map((p) => ({ url: p.url, number: p.number, baseRefName: p.baseRefName }))));
  process.exit(0);
}
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
console.error('unexpected gh ' + args.join(' '));
process.exit(1);
`);
  chmodSync(bin, 0o755);
  process.env.IDD_GH_BIN = bin;
  return { calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []), prs: () => JSON.parse(readFileSync(store, "utf8")) };
}
const creates = (gh) => gh.calls().filter((a) => a[0] === "pr" && a[1] === "create");

const request = (url, body) => new Request(`http://localhost${url}`, {
  method: body ? "POST" : "GET",
  headers: body ? { "Content-Type": "application/json" } : undefined,
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const laneEvents = () => readLifecycle().filter((e) => e.idd_id === "IDD-1").map((e) => e.event);
/** the lane's own record of one event, as the route left it */
const laneEvent = (event) => readLifecycle().filter((e) => e.idd_id === "IDD-1" && e.event === event).pop();

/** the push and the PR did not happen: no public branch, no `pr create`, and none of the push's own records */
function nothingHappened(f, gh) {
  assert.equal(git(f.remote, "branch", "--list", f.lane.branch), "", "no public branch");
  assert.deepEqual(creates(gh), [], "no PR was made");
  for (const event of ["s4_push_approved", "s4_r2_overridden", "s4_ship_failed", "s4_pushed", "s4_pr_created"]) {
    assert.equal(laneEvents().includes(event), false, event);
  }
}
const tickBooked = (f) => existsSync(join(f.state, "tick.again"));

// ---- the passkey signature: a software key registered in this test's state, signed over the approval's content ----

let key = null;
async function registerKey() {
  if (key) return key;
  key = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({ nonce, response: key.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID }), name: "test", localScreen: true });
  assert.equal(done.ok, true, done.error);
  return key;
}
/** the signature a correct approval would carry: over exactly the content the gate will rebuild from `approval` */
async function signShip(iddId, approval) {
  const auth = await registerKey();
  const saved = readProposal(iddId);
  const loc = laneLocations(iddId);
  const content = shipContentFor(iddId, saved, loc, approval);
  const { nonce, challenge } = createChallenge(content);
  return { nonce, assertion: auth.assertion({ challenge, origin: ORIGIN, rpId: RP_ID }) };
}
async function approve(iddId, token, approval) {
  return decidePost(request("/api/idd/decide", { action: "s4_verify_clean", payload: { iddId, token, ...approval } }));
}
/** the signature a local completion's approval carries: over exactly the content the gate will rebuild */
async function signLocal(iddId) {
  const auth = await registerKey();
  const saved = readProposal(iddId);
  const { nonce, challenge } = createChallenge(localCompleteContentFor(saved));
  return { nonce, assertion: auth.assertion({ challenge, origin: ORIGIN, rpId: RP_ID }) };
}

let savedEnv;
beforeEach(() => { savedEnv = {}; key = null; for (const k of ["IDD_STATE_DIR", "IDD_REPOS_FILE", "IDD_INTENT_DIR", "IDD_GH_BIN", "PATH"]) savedEnv[k] = process.env[k]; });
afterEach(() => { for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

// ---- the decisions the cookie used to guard are open ----

test("an ignore with no cookie still closes the lane, and the runner goes in before the stop", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "lane_open");
  seed(f.state, "s2_review_started", { run_ids: ["RUN-1"] });
  put(join(f.state, "lanes", "RUN-1", "lane.json"), JSON.stringify({ id: "RUN-1", role: "reviewer", model: "x/y", worktree: "/w", spec: "/s.yaml", report: join(f.state, "report"), status: "running", started_at: "2026-09-27T00:00:00Z" }));
  assert.equal(getAgentRunner(), null, "no runtime is installed yet");
  const res = await decidePost(request("/api/idd/decide", { action: "ignore", payload: { iddId: "IDD-1" } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.notEqual(getAgentRunner(), null, "the runner was put in before the write");
  assert.equal(laneEvents().includes("lane_close"), true, "the lane was closed with no cookie");
});

test("a redo whose Issue cannot be read again is refused, and the lane stays open", async () => {
  const f = setup();
  fakeGh(f.root);
  put(join(f.state, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", area: "demo", title: "feat: change", gh_issue_url: "https://github.com/test/project/issues/12" }) + "\n");
  seed(f.state, "lane_open");
  const bin = join(f.root, "gh-path"); mkdirSync(bin, { recursive: true });
  put(join(bin, "gh"), "#!/bin/sh\necho boom >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const res = await decidePost(request("/api/idd/decide", { action: "lane_redo", payload: { iddId: "IDD-1" } }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /読み直せません/);
  assert.equal(laneEvents().includes("lane_close"), false, "the lane stays open");
  assert.equal(readFileSync(join(f.state, "backlog.jsonl"), "utf8").trim().split("\n").length, 1, "no lane is opened");
});

test("the four actions that took a lane out are gone from the decision table", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "lane_open");
  for (const action of ["s1_defer", "lane_abort", "lane_drop", "delete"]) {
    const res = await decidePost(request("/api/idd/decide", { action, payload: { iddId: "IDD-1" } }));
    assert.equal(res.status, 400, action);
    assert.match((await res.json()).error, /未対応の action/, action);
  }
  assert.deepEqual(laneEvents(), ["lane_open"], "only the fixture's own record");
});

test("the reason a card sends with an ignore is what the lane's close records", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "lane_open");
  const res = await decidePost(request("/api/idd/decide", { action: "ignore", payload: { iddId: "IDD-1", reason: "取り込み直しを無視" } }));
  assert.equal(res.status, 200);
  const close = laneEvent("lane_close");
  assert.deepEqual([close.attrs.outcome, close.attrs.via, close.attrs.reason], ["aborted", "ignore", "取り込み直しを無視"]);
});

// AC-005: the granularity card's approval goes through the decide route, closes the lane, and puts its Issue on
// intake's ignore list. Nothing is written to GitHub: the children are for a person to open again from the record.
test("approving a granularity proposal closes the lane, ignores its Issue, and leaves the proposal readable", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  // the lane's own Issue, so the approval has something to put on intake's ignore list
  put(join(f.state, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", area: "demo", title: "feat: change", gh_issue_url: "https://github.com/test/project/issues/12" }) + "\n");
  seed(f.state, "lane_open");
  seed(f.state, "s1_granularity_proposed", { kind: "split", reason: "責務が 2 つ。", children: [{ title: "a", whole: "w", places: ["src/a.ts"], after: [] }] });
  const res = await decidePost(request("/api/idd/decide", { action: "granularity_approve", payload: { iddId: "IDD-1" } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(laneEvents().filter((e) => e === "s1_granularity_answered" || e === "lane_close"), ["s1_granularity_answered", "lane_close"]);
  const answer = laneEvent("s1_granularity_answered");
  assert.equal(answer.attrs.decision, "approve");
  assert.equal(answer.attrs.kind, "split");
  const close = laneEvent("lane_close");
  assert.equal(close.attrs.outcome, "aborted");
  assert.match(close.attrs.reason, /粒度の案（split）を承認/);
  assert.match(readFileSync(join(f.state, "intake-ignores.jsonl"), "utf8"), /issues\/12/);
  assert.deepEqual(gh.calls(), [], "nothing is written to GitHub");
});

test("an over-limit split is refused by the route and the lane stays open", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "lane_open");
  seed(f.state, "s1_granularity_proposed", { kind: "split", reason: "r", children: Array.from({ length: 5 }, (_, i) => ({ title: `c${i}`, whole: "w", places: ["src/a.ts"], after: [] })) });
  const res = await decidePost(request("/api/idd/decide", { action: "granularity_approve", payload: { iddId: "IDD-1" } }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /4 を超え/);
  assert.equal(laneEvents().includes("lane_close"), false, "the lane stays open for a re-slicing");
});

test("only the decide route calls runShip, and the ship API's route is gone", () => {
  const files = execFileSync("git", ["ls-files", "app", "lib", "packages"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const callers = files
    .filter((f) => !/\.test\./.test(f) && f !== "packages/idd-core/src/plan/ship.ts")
    .filter((f) => /\brunShip\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(callers, ["packages/idd-engine/src/routes/decide.ts"], "the push's approval has one entrance again");
  assert.equal(existsSync(join(ROOT, "app/api/idd/ship/route.ts")), false, "the ship API's route is gone");
});

// ---- the passkey gate ----

test("an approval with no signature is refused and nothing is pushed or made", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const res = await approve("IDD-1", card.token, { commitMessage: APPROVED, pr: PR });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /署名/);
  assert.equal(readProposal("IDD-1").status, "prepared", "the checked submit is untouched");
  nothingHappened(f, gh);
});

test("a publishing submit with only its token is refused, and leaves no record of a failure", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  // a bare POST with { iddId, token }: no signature, no fields, and still nothing goes out
  const res = await decidePost(request("/api/idd/decide", { action: "s4_verify_clean", payload: { iddId: "IDD-1", token: card.token } }));
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /署名/);
  assert.equal(readProposal("IDD-1").status, "prepared");
  nothingHappened(f, gh);
});

test("a signature over a changed commit message does not push", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const signed = await signShip("IDD-1", { commitMessage: APPROVED, pr: PR });
  const res = await approve("IDD-1", card.token, { commitMessage: "feat: 別の commit", pr: PR, ...signed });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /中身/);
  nothingHappened(f, gh);
});

test("a signature that was refused is used up: the same nonce cannot be reused", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const signed = await signShip("IDD-1", { commitMessage: APPROVED, pr: PR });
  // the first attempt carries another commit message, so the signature is refused, and the nonce is used up anyway
  const wrong = await approve("IDD-1", card.token, { commitMessage: "feat: 別の commit", pr: PR, ...signed });
  assert.equal(wrong.status, 400);
  // the same nonce with the content it was made for is refused too
  const again = await approve("IDD-1", card.token, { commitMessage: APPROVED, pr: PR, ...signed });
  assert.equal(again.status, 400);
  assert.match(String((await again.json()).error), /使い終え/);
  nothingHappened(f, gh);
});

test("a signature over a changed public tree does not push", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const signed = await signShip("IDD-1", { commitMessage: APPROVED, pr: PR });
  // the checked tree is replaced with another one (the top of the checked content) between the signature and the approval
  const rec = readProposal("IDD-1");
  writeFileSync(proposalPath("IDD-1"), JSON.stringify({ ...rec, publicTree: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }));
  try {
    const res = await approve("IDD-1", card.token, { commitMessage: APPROVED, pr: PR, ...signed });
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /中身/);
    nothingHappened(f, gh);
  } finally {
    writeFileSync(proposalPath("IDD-1"), JSON.stringify(rec));
  }
});

test("a signature over a changed PR title or body makes no PR, and for `new-pr` no push either", async () => {
  for (const change of [{ title: "feat: 別の題" }, { body: "別の本文" }]) {
    const f = setup();
    const gh = fakeGh(f.root);
    seed(f.state, "s4_submit_started");
    const card = await prepareSubmit("IDD-1", PR, { start: false });
    assert.ok(!card.error, card.error);
    const signed = await signShip("IDD-1", { commitMessage: APPROVED, pr: PR });
    const res = await approve("IDD-1", card.token, { commitMessage: APPROVED, pr: { ...PR, ...change }, ...signed });
    assert.equal(res.status, 400, JSON.stringify(change));
    assert.match(String((await res.json()).error), /中身/);
    nothingHappened(f, gh);
  }
});

test("one signature carries a push and the PR it makes", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const signed = await signShip("IDD-1", { commitMessage: APPROVED, pr: PR });
  const res = await approve("IDD-1", card.token, { commitMessage: APPROVED, pr: PR, ...signed });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(git(f.remote, "show", `${f.lane.branch}:app.txt`), "ours");
  assert.equal(creates(gh).length, 1);
  assert.equal(readsProposalTitle(), PR.title);
});

function readsProposalTitle() {
  return readProposal("IDD-1").pr.title;
}

test("a lane whose past R2 found more than the old limit is approved with the plain signature; an r2Override field is ignored (R2 removed 2026-10-22)", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "s3_ready");
  seed(f.state, "s3_r2_started", { run_id: "R2-1", base: "unused", head: "x" });
  seed(f.state, "s3_r2_done", { run_id: "R2-1", must: 1, should: 0, findings: [] });
  seed(f.state, "s3_ok");
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const plain = await signShip("IDD-1", { commitMessage: APPROVED, pr: PR });
  const ok = await approve("IDD-1", card.token, { commitMessage: APPROVED, pr: PR, r2Override: true, ...plain });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.equal(git(f.remote, "show", `${f.lane.branch}:app.txt`), "ours");
  assert.equal(laneEvents().includes("s4_r2_overridden"), false);
});

test("a local completion with no public change needs a signature, and then closes the lane", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  // only a private change: the public file goes back to the base, so the submit is a local completion
  put(join(f.lane.path, "app.txt"), "one\n");
  put(join(f.lane.path, "_docs/intent/demo/idd-1/decision.md"), "### DEC-900: private\n");
  commit(f.lane.path, "docs: private");
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  assert.equal(card.mode, "local");
  const main = git(f.work, "rev-parse", "HEAD");
  // no signature: refused, nothing reclaimed, no record of a completion
  const bare = await decidePost(request("/api/idd/decide", { action: "s4_verify_clean", payload: { iddId: "IDD-1", token: card.token } }));
  assert.equal(bare.status, 400, JSON.stringify(await bare.clone().json()));
  assert.match(String((await bare.json()).error), /署名/);
  assert.equal(git(f.work, "rev-parse", "HEAD"), main);
  assert.equal(laneEvents().includes("s4_local_completed"), false);
  assert.equal(laneEvents().includes("lane_close"), false);
  assert.deepEqual(creates(gh), []);
  // another lane's local completion signature does not fit this lane
  const auth = await registerKey();
  const wrong = createChallenge(localCompleteContentFor({ ...readProposal("IDD-1"), iddId: "IDD-2" }));
  const other = await decidePost(request("/api/idd/decide", { action: "s4_verify_clean", payload: { iddId: "IDD-1", token: card.token, nonce: wrong.nonce, assertion: auth.assertion({ challenge: wrong.challenge, origin: ORIGIN, rpId: RP_ID }) } }));
  assert.equal(other.status, 400, JSON.stringify(await other.clone().json()));
  assert.match(String((await other.json()).error), /中身/);
  assert.equal(git(f.work, "rev-parse", "HEAD"), main);
  // the signature over this lane's own content closes it
  const signed = await signLocal("IDD-1");
  const res = await decidePost(request("/api/idd/decide", { action: "s4_verify_clean", payload: { iddId: "IDD-1", token: card.token, ...signed } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.ok(laneEvents().includes("s4_local_completed"));
  assert.ok(laneEvents().includes("lane_close"));
  assert.notEqual(git(f.work, "rev-parse", "HEAD"), main);
  assert.deepEqual(creates(gh), [], "no PR");
  // the same approval pressed again after it went through is answered without a signature
  const again = await decidePost(request("/api/idd/decide", { action: "s4_verify_clean", payload: { iddId: "IDD-1", token: card.token } }));
  assert.equal(again.status, 200, JSON.stringify(await again.clone().json()));
});

test("a broken passkey state refuses a local completion and leaves the mainline", async () => {
  const f = setup();
  fakeGh(f.root);
  put(join(f.lane.path, "app.txt"), "one\n");
  put(join(f.lane.path, "_docs/intent/demo/idd-1/decision.md"), "### DEC-900: private\n");
  commit(f.lane.path, "docs: private");
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const signed = await signLocal("IDD-1");
  const main = git(f.work, "rev-parse", "HEAD");
  // the state is broken after the signature was made: the approval refuses rather than taking it for no keys
  mkdirSync(join(f.state, "passkey"), { recursive: true });
  writeFileSync(join(f.state, "passkey", "state.json"), "{ broken");
  const res = await decidePost(request("/api/idd/decide", { action: "s4_verify_clean", payload: { iddId: "IDD-1", token: card.token, ...signed } }));
  assert.equal(res.status, 400, JSON.stringify(await res.clone().json()));
  assert.match(String((await res.json()).error), /passkey の記録/);
  assert.equal(git(f.work, "rev-parse", "HEAD"), main);
  assert.equal(laneEvents().includes("s4_local_completed"), false);
  assert.equal(laneEvents().includes("lane_close"), false);
});

test("a submit's token is in the inbox state and a check's answer with no cookie", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const state = await (await stateGet(request("/api/idd/state"))).json();
  const item = state.items.find((i) => i.kind === "ship");
  assert.ok(item?.proposal, "the ship card is there");
  assert.equal(item.proposal.token, readProposal("IDD-1").token);
  const checked = await (await decidePost(request("/api/idd/decide", { action: "s4_prepare", payload: { iddId: "IDD-1", pr: PR } }))).json();
  assert.equal(checked.view.token, readProposal("IDD-1").token);
  assert.equal(tickBooked(f), false);
});

test("an approval of a lane penne sent back is refused, and nothing is pushed or made", async () => {
  const f = setup();
  const gh = fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  const card = await prepareSubmit("IDD-1", PR, { start: false });
  assert.ok(!card.error, card.error);
  const sent = await applyDecision("s4_revise", { iddId: "IDD-1", instruction: "直す" });
  assert.equal(sent.ok, true, sent.error);
  const signed = await signShip("IDD-1", { commitMessage: APPROVED, pr: PR });
  const res = await approve("IDD-1", card.token, { commitMessage: APPROVED, pr: PR, ...signed });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /提出前確認の段にない/);
  nothingHappened(f, gh);
});

test("a send-back and an answer go through under a broken passkey state", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "s4_submit_started");
  put(join(f.state, "pending-questions.jsonl"), JSON.stringify({ idd_id: "IDD-1", batch_id: "b1", asked_at: "2026-09-28T00:00:00Z", questions: [{ question_id: "q1", question: "どちらにしますか", context: "", options: [{ index: 1, label: "A" }] }] }) + "\n");
  mkdirSync(join(f.state, "passkey"), { recursive: true });
  writeFileSync(join(f.state, "passkey", "state.json"), "{ broken");
  const sendBack = await decidePost(request("/api/idd/decide", { action: "s4_revise", payload: { iddId: "IDD-1", instruction: "直す" } }));
  assert.equal(sendBack.status, 200, JSON.stringify(await sendBack.clone().json()));
  const answer = await decidePost(request("/api/idd/decide", { action: "answer", payload: { iddId: "IDD-1", batchId: "b1", questionId: "q1", selection: { index: 1 } } }));
  assert.equal(answer.status, 200, JSON.stringify(await answer.clone().json()));
});

test("a GO goes through under a broken passkey state", async () => {
  const f = setup();
  fakeGh(f.root);
  seed(f.state, "lane_open");
  seed(f.state, "s1_ready");
  seed(f.state, "s1_plan_review_skipped");
  mkdirSync(join(f.state, "passkey"), { recursive: true });
  writeFileSync(join(f.state, "passkey", "state.json"), "{ broken");
  const res = await decidePost(request("/api/idd/decide", { action: "s1_go", payload: { iddId: "IDD-1" } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
});

test("AC-027: answering a proposal sends the word to the open lane that raised it", async () => {
  const f = setup();
  fakeGh(f.root);
  const opened = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
  assert.equal(opened.ok, true, opened.error);
  const res = await decidePost(request("/api/idd/decide", { action: "proposal_approve", payload: { repo: "demo", proposal: opened.id } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const boxes = readFileSync(join(f.state, "outbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = boxes.at(-1);
  assert.equal(last.idd_id, "IDD-1");
  assert.equal(last.type, "info_update");
  const xml = readFileSync(join(f.state, "outbox", `${last.envelope_id}.xml`), "utf8");
  assert.match(xml, new RegExp(opened.id));
  assert.match(xml, /承認/);
  assert.match(xml, /idd intent risk/);
});

test("AC-027: a session's proposal and a closed lane's proposal send no word", async () => {
  const f = setup();
  fakeGh(f.root);
  const session = await raiseProposal({ repo: "demo", actor: { session: "s1" }, kind: "harm_example", reason: "r", body: { statement: "S", harm: 1 } });
  assert.equal(session.ok, true, session.error);
  const rejected = await decidePost(request("/api/idd/decide", { action: "proposal_reject", payload: { repo: "demo", proposal: session.id, reason: "今は要らない" } }));
  assert.equal(rejected.status, 200, JSON.stringify(await rejected.clone().json()));
  assert.equal(existsSync(join(f.state, "outbox.jsonl")), false, "a session's answer sends nothing");

  const lane = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 3 } });
  seed(f.state, "lane_close", { outcome: "aborted" });
  const ended = await decidePost(request("/api/idd/decide", { action: "proposal_approve", payload: { repo: "demo", proposal: lane.id } }));
  assert.equal(ended.status, 200, JSON.stringify(await ended.clone().json()));
  assert.equal(existsSync(join(f.state, "outbox.jsonl")), false, "a closed lane's answer sends nothing");
});

test("AC-027: an answer stands even when the word cannot be queued", async () => {
  const f = setup();
  fakeGh(f.root);
  const opened = await raiseProposal({ repo: "demo", actor: { lane: "IDD-1" }, kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } });
  // the outbox is a file, not a place: the envelope cannot be written
  writeFileSync(join(f.state, "outbox"), "not a place\n");
  const res = await decidePost(request("/api/idd/decide", { action: "proposal_approve", payload: { repo: "demo", proposal: opened.id } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(String(body.warning), /伝言/);
  const rows = readFileSync(join(f.state, "intent-demo.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.event === "harm_example_added").length, 1, "the answer was recorded");
});

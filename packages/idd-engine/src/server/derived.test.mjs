import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { execFileSync } from "node:child_process";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildStateWithCosts } = await import("./state.ts");
const { buildWork } = await import("./work.ts");
const { recordingDerived, replayDerived } = await import("./derived.ts");
const { derivedOverlay, derivationBusy, requestDerivation, startDerivedService, stopDerivedService } = await import("./derived-service.ts");
const { resetStaleness, setGuiStale } = await import("./staleness.ts");

const sleep = (n) => new Promise((r) => setTimeout(r, n));

/**
 * git, a lane's worktree and the lanes' spend are read by the derivation, not by the answer. These tests hold the
 * two halves to each other: the value the derivation found and the value the answer shows must be the same answer,
 * the answer must not follow git after the derivation was taken, and it must come back while a derivation is still
 * out. The clock and the engine's own memory are read by the answer itself, so they move under a held derivation.
 */

const saved = {
  state: process.env.IDD_STATE_DIR,
  repos: process.env.IDD_REPOS_FILE,
  intent: process.env.IDD_INTENT_DIR,
  tick: process.env.IDD_TICK_KICK,
};
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const ev = (event, at, attrs = {}) => ({ idd_id: "IDD-1", event, at, attrs });

let root;
afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos], ["IDD_INTENT_DIR", saved.intent], ["IDD_TICK_KICK", saved.tick]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  stopDerivedService();
  resetStaleness();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const SUBMIT_EVENTS = ["lane_open", "s1_ready", "s1_go", "s2_start", "s2_done", "s2_result", "s3_ready", "s3_ok", "s4_submit_started"];

/**
 * A lane at the submit card, with a real worktree that has a commit of its own: the card's checks are read from
 * that worktree by `git`, so an uncommitted file in it changes what a derivation finds.
 */
function laneAtSubmit(events = SUBMIT_EVENTS) {
  root = scratchDir("derived-");
  const work = join(root, "work"), remote = join(root, "remote.git"), upstream = join(root, "upstream"), state = join(root, "state"), lane = join(root, "lanes", "IDD-1");
  mkdirSync(work); mkdirSync(state);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(work, "init", "-q", "--initial-branch=main");
  put(join(work, "app.txt"), "one\n"); git(work, "add", "."); git(work, "commit", "-qm", "base");
  git(work, "remote", "add", "origin", remote); git(work, "push", "-q", "origin", "main");
  git(root, "clone", "-q", remote, upstream);
  git(work, "checkout", "-q", "-b", "work-main");
  git(work, "worktree", "add", "-q", "-b", "idd/IDD-1", lane, "work-main");
  put(join(lane, "app.txt"), "ours\n"); git(lane, "add", "."); git(lane, "commit", "-qm", "feat: ours");

  const repos = join(root, "repos.yaml");
  writeFileSync(repos, JSON.stringify({ repos: { demo: { github: "test/project", upstream, work, work_base: "work-main", public_base: "main", lanes_root: join(root, "lanes"), checks: [] } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos, IDD_INTENT_DIR: join(root, "intent") });
  writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-28T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "demo" }]));
  writeFileSync(join(state, "executor-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", executor_session_id: "E1", started_at: "2026-09-28T00:00:00Z", worktree_path: lane, branch: "idd/IDD-1" }]));
  writeFileSync(join(state, "planner-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", planner_session_id: "P1", started_at: "2026-09-28T00:00:00Z", worktree_path: lane }]));
  writeFileSync(join(state, "lifecycle-demo.jsonl"), jsonl(events.map((e) => ev(e, `2026-09-28T00:0${Math.min(events.indexOf(e), 9)}:00Z`))));
  return { work, state, lane, repos };
}

test("the answer equals the derivation taken at the same moment, and does not follow git after it (AC-003, AC-004)", async () => {
  const f = laneAtSubmit();
  const now = new Date("2026-09-28T05:00:00Z");
  const { deps, overlay } = recordingDerived();
  const derived = await buildStateWithCosts({ now }, deps);
  assert.ok(overlay.at, "the derivation landed");
  assert.ok(overlay.submit["IDD-1"], "the derivation reached the submit card");
  assert.equal(derived.items.find((i) => i.kind === "ship")?.iddId, "IDD-1");

  // the answer's side, from what the derivation found: the same answer as the whole derivation
  const replayed = await buildStateWithCosts({ now }, replayDerived(overlay));
  assert.deepEqual(replayed, derived);
  assert.deepEqual(buildWork({ now }, replayDerived(overlay)), buildWork({ now }, deps));
  assert.equal(buildWork({ now }, replayDerived(overlay)).done.some((d) => d.id === "IDD-1"), false, "an open lane is not one of the closed ones");

  // an uncommitted change in the lane's worktree: a new derivation sees it ...
  put(join(f.lane, "app.txt"), "uncommitted\n");
  const second = recordingDerived();
  const afterChange = await buildStateWithCosts({ now }, second.deps);
  const check = (s) => s.items.find((i) => i.kind === "ship")?.checks.find((c) => c.label.includes("未 commit"))?.ok;
  assert.equal(check(afterChange), false, "the new derivation sees the uncommitted change");
  assert.equal(check(derived), true);

  // ... and the answer does not: it reads what the derivation found, not git
  assert.deepEqual(await buildStateWithCosts({ now }, replayDerived(overlay)), derived);
});

test("the state door answers from the ledger while a derivation is still out (AC-003, AC-004)", async () => {
  const f = laneAtSubmit();
  const { deps, overlay } = recordingDerived();
  await buildStateWithCosts({}, deps);
  assert.ok(overlay.submit["IDD-1"]);

  // a runner that lands the first derivation and then never answers again: the next one stays out
  let landed = false;
  startDerivedService({
    runner: {
      start(next) { next.onOverlay(overlay); landed = true; },
      request() { /* never answers */ },
      stop() { /* nothing to stop */ },
    },
  });
  assert.equal(landed, true);
  requestDerivation();
  assert.equal(derivationBusy(), true, "the derivation is out");

  const { GET } = await import("../routes/state.ts");
  const before = await (await GET(new Request("http://localhost/api/idd/state"))).json();
  assert.equal(before.items.find((i) => i.kind === "ship")?.iddId, "IDD-1");

  // a judgment writes a row: the answer must show it now, without waiting for the derivation
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), JSON.stringify(ev("lane_wait_notified", "2026-09-28T06:00:00Z")) + "\n");
  const started = Date.now();
  const after = await (await GET(new Request("http://localhost/api/idd/state"))).json();
  const took = Date.now() - started;
  const card = after.items.find((i) => i.kind === "ship");
  assert.equal(card?.iddId, "IDD-1", "the card the derivation found is still there");
  assert.ok(card.waitNoticeAt, "the row the judgment wrote is in the answer");
  assert.ok(took < 2000, `the answer came back in ${took} ms while the derivation was out`);
  assert.equal(derivationBusy(), true, "the answer did not wait for the derivation");
  // what the derivation found for the card is what the answer still shows: it was not read again here
  assert.equal(card.head, overlay.submit["IDD-1"].head);
});

test("the state door returns no body when the content has not moved, and a new tag when it has (AC-005)", async () => {
  const f = laneAtSubmit();
  const { GET } = await import("../routes/state.ts");
  const at = "http://localhost/api/idd/state";

  const first = await GET(new Request(at));
  assert.equal(first.status, 200);
  const tag = first.headers.get("etag");
  assert.ok(tag, "the answer carries a tag");
  assert.ok((await first.text()).length > 0);

  const same = await GET(new Request(at, { headers: { "if-none-match": tag } }));
  assert.equal(same.status, 304);
  assert.equal(await same.text(), "", "no body when the content is the same");

  // a card penne answered: the content moves, so the tag must too
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), JSON.stringify(ev("s4_land_approved", new Date().toISOString())) + "\n");
  const moved = await GET(new Request(at, { headers: { "if-none-match": tag } }));
  assert.equal(moved.status, 200);
  assert.notEqual(moved.headers.get("etag"), tag);
});

test("the derivation runs in a child of its own and lands what it found (AC-004)", async () => {
  laneAtSubmit(["lane_open"]);
  startDerivedService();
  const deadline = Date.now() + 90_000;
  while (!derivedOverlay().at && Date.now() < deadline) await sleep(250);
  assert.ok(derivedOverlay().at, "the child answered with a derivation");
  assert.equal(derivationBusy(), false, "the derivation landed and nothing else is out");
});

test("the clock and the engine's own memory move under a held derivation (AC-006)", async () => {
  laneAtSubmit(["lane_open", "s1_ready", "s1_go", "s2_start"]);
  const { deps, overlay } = recordingDerived();
  await buildStateWithCosts({}, deps);
  const held = replayDerived(overlay);

  // the JST day the answer counts penne's answers in is the answer's own
  const day = await buildStateWithCosts({ now: new Date("2026-09-28T05:00:00Z") }, held);
  const other = await buildStateWithCosts({ now: new Date("2026-09-30T05:00:00Z") }, held);
  assert.deepEqual(day.answered.map((a) => a.kind), ["go"]);
  assert.deepEqual(other.answered, []);
  assert.equal(day.progress.done, 1);
  assert.equal(other.progress.done, 0);

  // the engine's staleness memory
  setGuiStale(true);
  assert.equal((await buildStateWithCosts({}, held)).gui.stale, true);
  setGuiStale(false);
  assert.equal((await buildStateWithCosts({}, held)).gui.stale, false);

  // which conversations are live right now
  const live = buildState({ liveSessions: new Set(["E1"]) }, held).lanes.find((l) => l.iddId === "IDD-1");
  const stalled = buildState({ liveSessions: new Set() }, held).lanes.find((l) => l.iddId === "IDD-1");
  assert.equal(live.activity, "live");
  assert.equal(stalled.activity, "stalled");
});

/** a lane whose planner has just re-readied it: the GO card's Choices are the ready's drafts, a ledger row */
function laneAtGo(plan) {
  root = scratchDir("derived-go-");
  const work = join(root, "work"), state = join(root, "state"), lane = join(root, "lanes", "IDD-1");
  mkdirSync(work); mkdirSync(state); mkdirSync(lane, { recursive: true });
  const repos = join(root, "repos.yaml");
  writeFileSync(repos, JSON.stringify({ repos: { demo: { github: "test/project", upstream: work, work, work_base: "main", public_base: "main", lanes_root: join(root, "lanes"), checks: [] } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos, IDD_INTENT_DIR: join(root, "intent") });
  writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-28T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "demo" }]));
  writeFileSync(join(state, "planner-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", planner_session_id: "P1", started_at: "2026-09-28T00:00:00Z", worktree_path: lane, records_shape: "state" }]));
  writeFileSync(join(state, "lifecycle-demo.jsonl"), jsonl([
    { ...ev("lane_open", "2026-09-28T00:00:00Z"), attrs: { area: "demo" } },
    { ...ev("s1_ready", "2026-09-28T00:01:00Z"), attrs: { records_shape: "state", plan_records: { choices: plan } } },
    ev("s1_plan_review_skipped", "2026-09-28T00:01:30Z"),
  ]));
  return { state, lane };
}

const draft = (chosen) => ({ forms: { chosen }, why: `${chosen} の why`, place: [{ path: "app.txt", kind: "file" }], purpose: "P-1" });

test("a re-ready written after the derivation is in the GO card the answer shows (AC-003)", async () => {
  const f = laneAtGo([draft("A の形")]);
  const { deps, overlay } = recordingDerived();
  const derived = await buildStateWithCosts({}, deps);
  assert.deepEqual(derived.items.find((i) => i.kind === "go")?.decisions.map((d) => d.text), ["A の形"]);

  // the planner re-readies the lane: a ledger row, written after the derivation was taken
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), [
    { ...ev("s1_ready", "2026-09-28T00:02:00Z"), attrs: { records_shape: "state", plan_records: { choices: [draft("B の形")] } } },
    ev("s1_plan_review_skipped", "2026-09-28T00:02:30Z"),
  ].map((r) => `${JSON.stringify(r)}\n`).join(""));

  const answer = await buildStateWithCosts({}, replayDerived(overlay));
  const fresh = await buildStateWithCosts({}, recordingDerived().deps);
  assert.deepEqual(answer.items.find((i) => i.kind === "go")?.decisions.map((d) => d.text), ["B の形"], "the card shows the Choices the ledger holds now");
  assert.deepEqual(answer.items.find((i) => i.kind === "go"), fresh.items.find((i) => i.kind === "go"));
});

test("a drafted commit written after the derivation is in the submit card the answer shows, and a past R2 adds no gate (AC-003)", async () => {
  const f = laneAtSubmit();
  const { deps, overlay } = recordingDerived();
  const derived = await buildStateWithCosts({}, deps);
  const before = derived.items.find((i) => i.kind === "ship");
  assert.ok(before, "the lane was at the submit card when the derivation ran");
  assert.equal(before.review, undefined);

  const head = git(f.lane, "rev-parse", "HEAD");
  const rows = [
    ev("s2_review_started", "2026-09-28T07:00:00Z"),
    { ...ev("s3_r2_done", "2026-09-28T07:01:00Z"), attrs: { must: 2, should: 0, nit: 0, findings: [{ severity: "must", claim: "x" }] } },
    { ...ev("s4_commit_drafted", "2026-09-28T07:02:00Z"), attrs: { head, message: "feat: ours" } },
  ];
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));

  const answer = await buildStateWithCosts({}, replayDerived(overlay));
  const card = answer.items.find((i) => i.kind === "ship");
  // R2 was removed (2026-10-22): its result in the ledger is read without a row or a gate on the card
  assert.equal(card.review?.r2, undefined);
  assert.equal(card.r2Gate, undefined);
  assert.equal(card.commit?.draft, "feat: ours", "the drafted commit is in the card");
  const fresh = await buildStateWithCosts({}, recordingDerived().deps);
  assert.deepEqual(card, fresh.items.find((i) => i.kind === "ship"));
});

test("a lane that moved to the submit card after the derivation is answered, not left out (AC-003)", async () => {
  const f = laneAtSubmit(SUBMIT_EVENTS.slice(0, -1));
  const { deps, overlay } = recordingDerived();
  const derived = await buildStateWithCosts({}, deps);
  assert.equal(derived.items.find((i) => i.kind === "ship"), undefined, "the lane was not at the submit card when the derivation ran");
  assert.equal("IDD-1" in overlay.submit, false, "the derivation took no submit reading for it");

  // the S3 opens the submit: the card appears from the answer's own reading of the lane, not from the derivation
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), `${JSON.stringify(ev("s4_submit_started", "2026-09-28T08:00:00Z"))}\n`);
  const answer = await buildStateWithCosts({}, replayDerived(overlay));
  const card = answer.items.find((i) => i.kind === "ship");
  assert.ok(card, "the card is not silently missing");
  assert.equal(card.head, git(f.lane, "rev-parse", "HEAD"), "the card is read from the lane's worktree");
  const fresh = await buildStateWithCosts({}, recordingDerived().deps);
  assert.deepEqual(card, fresh.items.find((i) => i.kind === "ship"));
});

test("a lane that closed after the derivation is in the Work answer, not left out (AC-003)", async () => {
  const f = laneAtSubmit(["lane_open"]);
  const { deps, overlay } = recordingDerived();
  const before = await buildStateWithCosts({}, deps);
  buildWork({}, deps);
  assert.equal(buildWork({}, replayDerived(overlay)).done.some((d) => d.id === "IDD-1"), false);

  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), `${JSON.stringify(ev("lane_close", "2026-09-28T09:00:00Z"))}\n`);
  const answer = buildWork({}, replayDerived(overlay));
  const row = answer.done.find((d) => d.id === "IDD-1");
  assert.ok(row, "the closed lane is not silently missing");
  assert.equal(row.decisions, 0, "its DEC count is read rather than left at nothing");
  assert.deepEqual(row, buildWork({}, recordingDerived().deps).done.find((d) => d.id === "IDD-1"));
  void before;
});

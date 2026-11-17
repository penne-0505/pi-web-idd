import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");
const { buildTimeline } = await import("./events-display.ts");

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@localhost" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const ev = (iddId, event, attrs = {}) => ({ idd_id: iddId, event, at: "2026-09-25T00:00:00Z", attrs });
let root;

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** a small work repo with one worktree per lane, and the state files buildState reads */
function laneRepo(ids) {
  root = scratchDir("state-order-wait-");
  const work = join(root, "work");
  const state = join(root, "state");
  const lanes = Object.fromEntries(ids.map((id) => [id, join(root, "lanes", id)]));
  mkdirSync(work);
  mkdirSync(state);
  git(work, "init", "-q", "--initial-branch=work-main");
  put(join(work, "app.txt"), "one\ntwo\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "base");
  for (const [id, path] of Object.entries(lanes)) {
    git(work, "worktree", "add", "-q", "-b", `idd/${id}`, path, "work-main");
    put(join(path, "app.txt"), `from ${id}\n`);
    git(path, "add", ".");
    git(path, "commit", "-qm", `feat: ${id}`);
  }
  const repos = join(root, "repos.yaml");
  put(repos, JSON.stringify({ repos: { Demo: { github: "test/project", upstream: join(root, "upstream"), work, work_base: "work-main", public_base: "main", lanes_root: join(root, "lanes"), publish: false } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  const backlog = ids.map((id) => ({ idd_id: id, parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: `https://github.com/o/r/issues/${id.slice(-1)}`, pull_req_url: null, source_type: "github", context: "", title: `T ${id}`, area: "Demo" }));
  writeFileSync(join(state, "backlog.jsonl"), jsonl(backlog));
  writeFileSync(join(state, "executor-sessions.jsonl"), jsonl(Object.entries(lanes).map(([id, path]) => ({ idd_id: id, executor_session_id: `E-${id}`, started_at: "2026-09-25T00:00:00Z", worktree_path: path, branch: `idd/${id}` }))));
  const heads = Object.fromEntries(Object.entries(lanes).map(([id, path]) => [id, git(path, "rev-parse", "HEAD")]));
  const write = (rows) => writeFileSync(join(state, "lifecycle-Demo.jsonl"), jsonl(rows));
  return { work, state, lanes, heads, write };
}

/** IDD-1 has a landing card; IDD-2 waits, before its first review, for IDD-1 to land */
function fixture() {
  const f = laneRepo(["IDD-1", "IDD-2"]);
  f.write([
    ...Object.keys(f.lanes).flatMap((id) => [ev(id, "lane_open"), ev(id, "s2_start"), ev(id, "s2_result")]),
    ...["s3_ready", "s3_ok", "s4_submit_started"].map((event) => ev("IDD-1", event)),
    ev("IDD-2", "s2_order_waiting", { head: f.heads["IDD-2"], since: "2026-09-25T00:00:00Z", opponents: [{ lane: "IDD-1", head: f.heads["IDD-1"], files: ["app.txt"] }] }),
  ]);
  return f;
}

it("the landing card names the lanes this landing would release", () => {
  const f = fixture();
  const item = buildState().items.find((i) => i.kind === "ship" && i.iddId === "IDD-1");
  assert.ok(item, "the landing card is in the inbox");
  assert.deepEqual(item.waitingLanes, [{ lane: "IDD-2", files: ["app.txt"], rank: 1 }]);
  // the waiting lane is in the waiting section, and its line carries its place
  const row = buildState().lanes.find((l) => l.iddId === "IDD-2");
  assert.equal(row.group, "waiting");
  assert.match(row.blockedBy, /1 番目/);
  assert.ok(f);
});

it("the waiting lane's detail carries the opponents and the files, and its timeline says waiting, released, exceeded", async () => {
  const f = fixture();
  const detail = await buildLaneDetail("IDD-2");
  assert.deepEqual(detail.orderWait, { opponents: [{ lane: "IDD-1", files: ["app.txt"] }], rank: 1 });
  const waited = detail.timeline.find((e) => /IDD-1 の取り込みを待っている/.test(e.detail ?? ""));
  assert.ok(waited, JSON.stringify(detail.timeline));
  assert.match(waited.detail, /app\.txt/);
  const lines = buildTimeline([
    ev("IDD-2", "s2_start"),
    ev("IDD-2", "s2_result"),
    ev("IDD-2", "s2_order_waiting", { head: "h", since: "2026-09-25T00:00:00Z", opponents: [{ lane: "IDD-1", head: "h1", files: ["app.txt"] }] }),
    ev("IDD-2", "s2_order_released", { since: "2026-09-25T00:00:00Z", head: "h", opponents: [{ lane: "IDD-1", head: "h1", files: ["app.txt"] }] }),
    ev("IDD-2", "s2_order_limit", { since: "2026-09-25T00:00:00Z", head: "h", opponents: [{ lane: "IDD-1", head: "h1", files: ["app.txt"] }] }),
  ]);
  const texts = lines.map((e) => e.detail ?? "").join("\n");
  assert.match(texts, /取り込みを待っている/);
  assert.match(texts, /取り込みで解けた/);
  assert.match(texts, /上限を超えた/);
  assert.ok(f);
});

it("a released wait no longer appears on the card", async () => {
  const f = fixture();
  // the wait is released and the check passed: the lane goes on to its first review, and the card loses the line
  const path = join(process.env.IDD_STATE_DIR, "lifecycle-Demo.jsonl");
  writeFileSync(path, jsonl([
    ...Object.keys(f.lanes).flatMap((id) => [ev(id, "lane_open"), ev(id, "s2_start"), ev(id, "s2_result")]),
    ...["s3_ready", "s3_ok", "s4_submit_started"].map((event) => ev("IDD-1", event)),
    ev("IDD-2", "s2_order_released", { since: "2026-09-25T00:00:00Z", head: "h" }),
    ev("IDD-2", "s2_order_passed", { head: "h" }),
  ]));
  const item = buildState().items.find((i) => i.kind === "ship" && i.iddId === "IDD-1");
  assert.equal(item.waitingLanes, undefined);
  assert.equal((await buildLaneDetail("IDD-2")).orderWait, undefined);
});

it("the place counts only the waiting lanes a lane collides with, never another chain", async () => {
  const f = laneRepo(["IDD-1", "IDD-2", "IDD-3", "IDD-4", "IDD-5", "IDD-6"]);
  const ship = (id) => ["s3_ready", "s3_ok", "s4_submit_started"].map((event) => ev(id, event));
  f.write([
    ...Object.keys(f.lanes).flatMap((id) => [ev(id, "lane_open"), ev(id, "s2_start"), ev(id, "s2_result")]),
    ...ship("IDD-1"), ...ship("IDD-5"),
    // A=IDD-2 waits on X=IDD-1; B=IDD-3 waits on A; D=IDD-4 waits in another chain on E=IDD-5
    ev("IDD-2", "s2_order_waiting", { head: f.heads["IDD-2"], since: "2026-09-25T00:00:00Z", opponents: [{ lane: "IDD-1", head: f.heads["IDD-1"], files: ["app.txt"] }] }),
    ev("IDD-3", "s2_order_waiting", { head: f.heads["IDD-3"], since: "2026-09-25T00:00:01Z", opponents: [{ lane: "IDD-2", head: f.heads["IDD-2"], files: ["app.txt"] }] }),
    ev("IDD-4", "s2_order_waiting", { head: f.heads["IDD-4"], since: "2026-09-25T00:00:00Z", opponents: [{ lane: "IDD-5", head: f.heads["IDD-5"], files: ["b.txt"] }] }),
    // IDD-6 was waiting and is released: it shows no place
    ev("IDD-6", "s2_order_released", { since: "2026-09-25T00:00:00Z", head: f.heads["IDD-6"], order_at: 1 }),
    ev("IDD-6", "s2_order_passed", { head: f.heads["IDD-6"], order_at: 2 }),
  ]);
  const state = buildState();
  const row = (id) => state.lanes.find((l) => l.iddId === id);
  assert.match(row("IDD-2").blockedBy, /1 番目/);
  assert.match(row("IDD-3").blockedBy, /2 番目/);
  assert.match(row("IDD-4").blockedBy, /1 番目/, "another chain is not counted");
  assert.doesNotMatch(row("IDD-6").blockedBy, /番目/, "a released lane shows no place");
  assert.equal((await buildLaneDetail("IDD-2")).orderWait.rank, 1);
  assert.equal((await buildLaneDetail("IDD-3")).orderWait.rank, 2);
  assert.equal((await buildLaneDetail("IDD-4")).orderWait.rank, 1);
  assert.equal((await buildLaneDetail("IDD-6")).orderWait, undefined);
  // the card for X names A with its place, and not the lane that only waits behind A
  const card = state.items.find((i) => i.kind === "ship" && i.iddId === "IDD-1");
  assert.deepEqual(card.waitingLanes, [{ lane: "IDD-2", files: ["app.txt"], rank: 1 }]);
});

it("a lane waiting on a waiting lane shows that lane's shorter place on the card", () => {
  const f = laneRepo(["IDD-1", "IDD-2", "IDD-3"]);
  f.write([
    ...Object.keys(f.lanes).flatMap((id) => [ev(id, "lane_open"), ev(id, "s2_start"), ev(id, "s2_result")]),
    ...["s3_ready", "s3_ok", "s4_submit_started"].map((event) => ev("IDD-1", event)),
    // Y=IDD-3 waits on X=IDD-1; A=IDD-2 waits on X and on Y, so A is second in X's chain
    ev("IDD-3", "s2_order_waiting", { head: f.heads["IDD-3"], since: "2026-09-25T00:00:00Z", opponents: [{ lane: "IDD-1", head: f.heads["IDD-1"], files: ["app.txt"] }] }),
    ev("IDD-2", "s2_order_waiting", { head: f.heads["IDD-2"], since: "2026-09-25T00:00:00Z", opponents: [{ lane: "IDD-1", head: f.heads["IDD-1"], files: ["app.txt"] }, { lane: "IDD-3", head: f.heads["IDD-3"], files: ["app.txt"] }] }),
  ]);
  const card = buildState().items.find((i) => i.kind === "ship" && i.iddId === "IDD-1");
  assert.ok(card.waitingLanes.some((w) => w.lane === "IDD-2" && w.rank === 2), JSON.stringify(card.waitingLanes));
  assert.ok(card.waitingLanes.some((w) => w.lane === "IDD-3" && w.rank === 1), JSON.stringify(card.waitingLanes));
});

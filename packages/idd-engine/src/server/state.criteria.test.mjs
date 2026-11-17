import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, intent: process.env.IDD_INTENT_DIR };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@localhost" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const ev = (event, attrs = {}) => ({ idd_id: "IDD-1", event, at: "2026-09-25T00:00:00Z", attrs });
let root;

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos], ["IDD_INTENT_DIR", saved.intent]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) { rmSync(root, { recursive: true, force: true }); root = undefined; }
});

/**
 * A lane at the review card, with its plan's criteria on its worktree, its progress note naming one criterion and
 * its result confirming all three. The card and the detail have to agree on the same lane.
 */
function reviewFixture() {
  root = scratchDir("state-criteria-");
  const work = join(root, "work"), lane = join(root, "lane"), state = join(root, "state");
  mkdirSync(work); mkdirSync(state);
  git(work, "init", "-q", "--initial-branch=work-main");
  put(join(work, "app.txt"), "one\n");
  git(work, "add", "."); git(work, "commit", "-qm", "base");
  const start = git(work, "rev-parse", "HEAD");
  git(work, "worktree", "add", "-q", "-b", "idd/IDD-1", lane, "work-main");
  put(join(lane, "_docs/qa/Demo/idd-1/qa.md"), ["# QA", "", "- AC-001: one", "- AC-002: two", "- AC-003: three", ""].join("\n"));
  put(join(lane, "app.txt"), "changed\n");
  git(lane, "add", "."); git(lane, "commit", "-qm", "feat: IDD-1");

  const repos = join(root, "repos.yaml");
  put(repos, JSON.stringify({ repos: { Demo: { github: "test/project", upstream: join(root, "upstream"), work, work_base: "work-main", public_base: "main", lanes_root: join(root, "lanes") } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos, IDD_INTENT_DIR: join(root, "unused") });
  writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" }]));
  writeFileSync(join(state, "executor-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", executor_session_id: "E1", started_at: "2026-09-25T00:00:00Z", worktree_path: lane, branch: "idd/IDD-1" }]));
  // the note touched one criterion only; the result that follows confirms all three
  writeFileSync(join(state, "executor-progress-IDD-1.json"), JSON.stringify({ idd_id: "IDD-1", updated_at: "2026-09-25T00:00:00Z", current_step: "", qa_status: [{ qa_id: "AC-001", status: "verified" }], recent_activity: [] }));
  writeFileSync(join(state, "lifecycle-Demo.jsonl"), jsonl([
    ev("lane_open"), ev("s2_start"),
    ev("s2_result", { outcome: "success", qa_verified: ["AC-001", "AC-002", "AC-003"], qa_unverified: [] }),
    ev("s3_ready"),
  ]));
  return { root, work, lane, state, start };
}

describe("a lane whose result confirmed every criterion", () => {
  it("shows every criterion as done on the review card", () => {
    reviewFixture();
    const card = buildState().items.find((i) => i.kind === "review" && i.iddId === "IDD-1");
    assert.ok(card, "the lane is at the review card");
    // AC-009: the partial note does not decide the list
    assert.deepEqual(card.criteria.map((c) => [c.id, c.state]), [["AC-001", "done"], ["AC-002", "done"], ["AC-003", "done"]]);
  });

  it("shows the same criteria as done on the lane's detail", async () => {
    reviewFixture();
    const lane = await buildLaneDetail("IDD-1");
    assert.ok(lane);
    // AC-009: the detail and the card read the same confirmed set
    assert.deepEqual(lane.contract.criteria.map((c) => [c.id, c.state]), [["AC-001", "done"], ["AC-002", "done"], ["AC-003", "done"]]);
  });
});

describe("a lane whose progress note carries a malformed entry", () => {
  it("still builds the review card from the result instead of failing", () => {
    const f = reviewFixture();
    writeFileSync(join(f.state, "executor-progress-IDD-1.json"), JSON.stringify({ idd_id: "IDD-1", updated_at: "2026-09-25T00:00:00Z", current_step: "", qa_status: [{ qa_id: 7, status: "verified" }, { status: "in_progress" }, null], recent_activity: [] }));
    // F-1: one malformed note entry must not make the whole state fail
    const card = buildState().items.find((i) => i.kind === "review" && i.iddId === "IDD-1");
    assert.ok(card, "the lane is still on the review card");
    assert.deepEqual(card.criteria.map((c) => [c.id, c.state]), [["AC-001", "done"], ["AC-002", "done"], ["AC-003", "done"]]);
  });
});

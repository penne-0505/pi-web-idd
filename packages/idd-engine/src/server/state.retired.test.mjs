import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildLaneDetail } = await import("./state.ts");

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@localhost" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const ev = (event, attrs = {}) => ({ idd_id: "IDD-1", event, at: "2026-09-25T00:00:00Z", attrs });
let root;

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("an ended lane whose worktree was retired", () => {
  it("still shows its plan and the files it changed, read from its branch", async () => {
    root = scratchDir("state-retired-");
    const work = join(root, "work"), state = join(root, "state");
    mkdirSync(work); mkdirSync(state);
    git(work, "init", "-q", "--initial-branch=work-main");
    put(join(work, "app.txt"), "one\n"); git(work, "add", "."); git(work, "commit", "-qm", "base");
    const start = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "-b", "idd/IDD-1");
    put(join(work, "_docs/intent/Demo/idd-1/decision.md"), "### DEC-900: plan kept on the branch\n");
    put(join(work, "_docs/qa/Demo/idd-1/qa.md"), "- AC-001: it works\n");
    put(join(work, "app.txt"), "changed\n"); git(work, "add", "."); git(work, "commit", "-qm", "lane work");
    git(work, "checkout", "-q", "work-main");

    const repos = join(root, "repos.yaml");
    writeFileSync(repos, JSON.stringify({ repos: { Demo: { github: "test/project", upstream: join(root, "upstream"), work, work_base: "work-main", public_base: "main", lanes_root: join(root, "lanes") } } }));
    Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
    const gone = join(root, "lanes", "IDD-1");
    writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" }]));
    writeFileSync(join(state, "executor-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", executor_session_id: "E1", started_at: "2026-09-25T00:00:00Z", worktree_path: gone, branch: "idd/IDD-1" }]));
    writeFileSync(join(state, "executor-progress-IDD-1.json"), JSON.stringify({ idd_id: "IDD-1", updated_at: "2026-09-25T00:00:00Z", current_step: "", qa_status: [], recent_activity: [] }));
    writeFileSync(join(state, "lifecycle-Demo.jsonl"), jsonl([
      ev("lane_open"), ev("s1_ready"), ev("s1_go"), ev("s2_start", { started_from_commit: start }),
      ev("lane_close", { outcome: "aborted" }), ev("lane_worktree_retired", { path: gone, branch: "idd/IDD-1" }),
    ]));

    const lane = await buildLaneDetail("IDD-1");
    assert.equal(lane.group, "closed");
    assert.deepEqual(lane.contract.decisions.map((d) => d.id), ["DEC-900"]);
    assert.deepEqual(lane.contract.criteria.map((c) => c.id), ["AC-001"]);
    assert.deepEqual(lane.work.files.map((f) => f.path).sort(), ["_docs/intent/Demo/idd-1/decision.md", "_docs/qa/Demo/idd-1/qa.md", "app.txt"]);
  });
});

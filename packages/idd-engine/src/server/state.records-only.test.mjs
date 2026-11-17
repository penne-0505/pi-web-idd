import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { RECORDS_ONLY_REASON } = await import("../../../idd-core/src/overlay/land.ts");

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

/**
 * one lane of a repo that does not publish, at its submit card. The work clone's manifest keeps `_docs/` private;
 * `files` is what the lane commits on top of the mainline
 */
function laneWith(files) {
  root = scratchDir("state-records-only-");
  const work = join(root, "work");
  const state = join(root, "state");
  const lanePath = join(root, "lanes", "IDD-1");
  mkdirSync(work);
  mkdirSync(state);
  git(work, "init", "-q", "--initial-branch=work-main");
  put(join(work, "app.txt"), "one\n");
  put(join(work, "overlay.manifest"), "_docs/\noverlay.manifest\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "base");
  git(work, "worktree", "add", "-q", "-b", "idd/IDD-1", lanePath, "work-main");
  for (const [path, text] of Object.entries(files)) put(join(lanePath, path), text);
  git(lanePath, "add", ".");
  git(lanePath, "commit", "-qm", "feat: lane");
  const repos = join(root, "repos.yaml");
  put(repos, JSON.stringify({ repos: { Demo: { github: "test/project", upstream: join(root, "upstream"), work, work_base: "work-main", public_base: "main", lanes_root: join(root, "lanes"), publish: false } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" }]));
  writeFileSync(join(state, "executor-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", executor_session_id: "E-1", started_at: "2026-09-25T00:00:00Z", worktree_path: lanePath, branch: "idd/IDD-1" }]));
  writeFileSync(join(state, "lifecycle-Demo.jsonl"), jsonl([
    ev("IDD-1", "lane_open"), ev("IDD-1", "s2_start"), ev("IDD-1", "s2_result"),
    ev("IDD-1", "s3_ready"), ev("IDD-1", "s3_ok"), ev("IDD-1", "s4_submit_started"),
  ]));
}

const ship = () => buildState().items.find((i) => i.kind === "ship" && i.iddId === "IDD-1");

describe("a lane that adds nothing public (records alone)", () => {
  it("reaches the submit card marked recordsOnly, with the refusal among the reasons it cannot be signed", () => {
    laneWith({ "_docs/plan/IDD-1.md": "# plan\n" });
    const item = ship();
    assert.ok(item, "the card is in the inbox");
    assert.deepEqual(item.recordsOnly, { reason: RECORDS_ONLY_REASON });
    assert.ok(item.blocked?.reasons.includes(RECORDS_ONLY_REASON), JSON.stringify(item.blocked));
  });

  it("is not marked when one public line goes with the records", () => {
    laneWith({ "_docs/plan/IDD-1.md": "# plan\n", "app.txt": "two\n" });
    const item = ship();
    assert.ok(item, "the card is in the inbox");
    assert.equal(item.recordsOnly, undefined);
    assert.equal(item.blocked, undefined);
  });
});

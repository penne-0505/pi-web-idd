import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");

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

/** one lane at its submit card, with `rounds` (review-round records) written after the S3's own events */
function laneWithRounds(rounds = []) {
  root = scratchDir("state-risk-match-");
  const work = join(root, "work");
  const state = join(root, "state");
  const lanePath = join(root, "lanes", "IDD-1");
  mkdirSync(work);
  mkdirSync(state);
  git(work, "init", "-q", "--initial-branch=work-main");
  put(join(work, "app.txt"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "base");
  git(work, "worktree", "add", "-q", "-b", "idd/IDD-1", lanePath, "work-main");
  put(join(lanePath, "app.txt"), "from lane\n");
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
    ...rounds,
  ]));
}

const ship = () => buildState().items.find((i) => i.kind === "ship" && i.iddId === "IDD-1");

describe("the last round's hit of the repo's dangerous-path declaration", () => {
  it("reaches the submit card and the lane detail, with the declared risk beside the kinds and paths", async () => {
    laneWithRounds([ev("IDD-1", "s2_review_started", {
      kind: "blind", round: 1, risk: "Medium",
      risk_match: { hits: [{ kind: "auth", paths: ["guard/x.ts", "guard/y.ts"], total: 3 }] },
    })]);
    const item = ship();
    assert.ok(item);
    const expected = { declared: "Medium", hits: [{ kind: "auth", label: "認証", paths: ["guard/x.ts", "guard/y.ts"], total: 3 }] };
    assert.deepEqual(item.riskMatch, expected);
    assert.deepEqual((await buildLaneDetail("IDD-1")).riskMatch, expected);
  });

  it("shows the last round that hit a declared path", async () => {
    laneWithRounds([
      ev("IDD-1", "s2_review_started", { kind: "blind", round: 1, risk: "Medium", risk_match: { hits: [{ kind: "auth", paths: ["guard/a.ts"], total: 1 }] } }),
      ev("IDD-1", "s2_review_started", { kind: "final", round: 1, risk: "High", risk_match: { hits: [{ kind: "data_loss", paths: ["migrations/01.sql"], total: 1 }] } }),
    ]);
    assert.deepEqual(ship().riskMatch, { declared: "High", hits: [{ kind: "data_loss", label: "データ損失", paths: ["migrations/01.sql"], total: 1 }] });
  });

  it("shows nothing on a lane whose rounds recorded no hit, or only old records without the field", async () => {
    laneWithRounds([ev("IDD-1", "s2_review_started", { kind: "blind", round: 1, risk: "Medium" })]);
    assert.equal(ship().riskMatch, undefined);
    assert.equal((await buildLaneDetail("IDD-1")).riskMatch, undefined);
  });
});

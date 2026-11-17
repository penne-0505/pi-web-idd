import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { RECORD, FINDINGS } = await jiti.import("./work.ts");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
});

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function setup() {
  const root = scratchDir("work-record-");
  made.push(root);
  const state = join(root, "state");
  const worktree = join(root, "wt");
  mkdirSync(state);
  mkdirSync(worktree);
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: { "me/app": { upstream: join(root, "u"), work: worktree, work_base: "main", public_base: "main" } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") });
  put(join(worktree, "_docs/qa/app/idd-1/qa.md"), "---\ntitle: qa\n---\n\n## Acceptance Criteria\n\n- AC-001: 一つ目\n");
  writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", area: "me/app", title: "T", source_type: "github", created_at: "2026-10-13T00:00:00Z" }]));
  writeFileSync(join(state, "executor-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", executor_session_id: "E1", started_at: "2026-10-13T00:00:00Z", worktree_path: worktree, branch: "idd/idd-1" }]));
  writeFileSync(join(state, "lifecycle-me-app.jsonl"), jsonl([
    { idd_id: "IDD-1", event: "s1_ready", at: "2026-10-13T01:00:00Z", attrs: { intent_impact: { paths: ["src/x.ts"], decisions: [], candidate_count: 0 } } },
    { idd_id: "IDD-1", event: "s2_result", at: "2026-10-13T02:00:00Z", attrs: { outcome: "success", qa_verified: ["AC-001"], qa_evidence: { "AC-001": "ran it" } } },
    { idd_id: "IDD-8", event: "lane_close", at: "2026-10-13T03:00:00Z", attrs: { outcome: "merged" } },
  ]));
  writeFileSync(join(state, "work-me%2Fapp.jsonl"), jsonl([
    { event: "finding_placed", at: "2026-10-13T04:00:00Z", repo: "me/app", lane: "IDD-1", id: "F-1-1", round: 1, path: "src/own.ts", lines: [2, 2], commit: "H1", severity: "should", claim: "自分の指摘" },
    { event: "finding_placed", at: "2026-10-13T04:00:00Z", repo: "me/app", lane: "IDD-8", id: "F-8-1", round: 1, path: "src/x.ts", lines: [3, 5], commit: "H2", severity: "nit", claim: "渡る指摘" },
    { event: "finding_placed", at: "2026-10-13T04:00:00Z", repo: "me/app", lane: "IDD-8", id: "F-8-2", round: 1, path: "src/x.ts", lines: [9, 9], commit: "H2", severity: "should", claim: "消えた指摘" },
    { event: "finding_dropped", at: "2026-10-13T05:00:00Z", repo: "me/app", id: "F-8-2", reason: "書き換わった", by: "engine" },
  ]));
  return { state, worktree };
}

const snapshot = (state) => readdirSync(state).sort().map((f) => `${f}\n${readFileSync(join(state, f), "utf8")}`).join("\n---\n");

test("AC-034: the record door returns the AC states, the log, the placed and the delivered findings", async () => {
  const { state } = setup();
  const res = RECORD(new Request("http://localhost/x"), { id: "IDD-1" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.lane, "IDD-1");
  assert.equal(body.acceptance[0].id, "AC-001");
  assert.equal(body.acceptance[0].statement, "一つ目");
  assert.equal(body.acceptance[0].status, "verified");
  assert.equal(body.acceptance[0].evidence, "ran it");
  assert.ok(body.log.length >= 2);
  assert.equal(body.findings.placed.length, 1);
  assert.equal(body.findings.placed[0].id, "F-1-1");
  assert.equal(body.findings.delivered.length, 1);
  assert.equal(body.findings.delivered[0].id, "F-8-1");
  assert.ok(!body.findings.delivered.some((f) => f.id === "F-8-2"), "a dropped finding is not delivered");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("AC-034: the findings door returns the open findings of a path and no dropped one", async () => {
  setup();
  const found = FINDINGS(new Request("http://localhost/x?repo=me%2Fapp&path=src/x.ts"));
  assert.equal(found.status, 200);
  const body = await found.json();
  assert.deepEqual(body.paths, ["src/x.ts"]);
  assert.deepEqual(body.findings.map((f) => f.id).sort(), ["F-8-1"]);
  assert.ok(!body.findings.some((f) => f.status === "dropped"));
});

test("AC-035: neither read door writes anything into the state", async () => {
  const { state } = setup();
  const before = snapshot(state);
  await (await Promise.resolve(RECORD(new Request("http://localhost/x"), { id: "IDD-1" }))).json();
  await (await Promise.resolve(FINDINGS(new Request("http://localhost/x?repo=me%2Fapp&path=src/x.ts")))).json();
  assert.equal(snapshot(state), before);
});

test("AC-036: an id the ledger does not have, or one that is not a lane id, is refused before any read", async () => {
  setup();
  assert.equal(RECORD(new Request("http://localhost/x"), { id: "IDD-999" }).status, 404);
  assert.equal(RECORD(new Request("http://localhost/x"), { id: "../etc/passwd" }).status, 404);
  assert.equal(RECORD(new Request("http://localhost/x"), { id: "REV-1" }).status, 404);
  assert.equal(FINDINGS(new Request("http://localhost/x?repo=nope&path=a.ts")).status, 404);
});

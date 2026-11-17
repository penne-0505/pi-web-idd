import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": root }, tsconfigPaths: true, interopDefault: true });
const { ensureAgentRunner } = await jiti.import(`${root}/packages/idd-engine/src/server/agent-runner.ts`);
const { getAgentRunner, stopLaneWork } = await jiti.import(`${root}/packages/idd-core/src/index.ts`);

let dir;
const saved = {};
beforeEach(() => {
  for (const k of ["IDD_STATE_DIR", "IDD_REPOS_FILE", "IDD_ROLES_FILE"]) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "idd-agent-runner-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
  writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({
    idd_id: "IDD-001", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null,
    gh_issue_url: "https://github.com/o/r/issues/12", pull_req_url: null, source_type: "github", context: "", title: "T", area: "demo",
  }) + "\n");
  // two runs of the lane: one still working, one that ended before the lane was taken out. A run that names no
  // process counts as working only inside the start grace, so the working one's start is now.
  const lane = (id, rec) => {
    mkdirSync(join(dir, "lanes", id), { recursive: true });
    writeFileSync(join(dir, "lanes", id, "lane.json"), JSON.stringify({ id, role: "reviewer", model: "x/y", worktree: "/w", spec: "/s.yaml", report: join(dir, "report"), started_at: "2026-09-27T00:00:00Z", ...rec }));
  };
  lane("RUN-1", { status: "running", started_at: new Date().toISOString() });
  lane("DONE-1", { status: "done", ended_at: "2026-09-27T01:00:00Z", exit: 0 });
  writeFileSync(join(dir, "lifecycle-demo.jsonl"), JSON.stringify({
    event: "s2_review_started", idd_id: "IDD-001", at: "2026-09-27T00:00:00Z", attrs: { run_ids: ["RUN-1", "DONE-1"] },
  }) + "\n");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const laneRecord = (id) => JSON.parse(readFileSync(join(dir, "lanes", id, "lane.json"), "utf8"));
const note = () => readFileSync(join(dir, "lifecycle-demo.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === "lane_work_stopped").pop();

test("the real runtime's stop ends a working run and leaves an ended one's record as it is", () => {
  ensureAgentRunner();
  const runner = getAgentRunner();
  assert.notEqual(runner, null);
  const doneBefore = readFileSync(join(dir, "lanes", "DONE-1", "lane.json"), "utf8");

  return stopLaneWork("IDD-001", { via: "ignore" }).then((r) => {
    // the run that was working reads as stopped, and the one that had ended is untouched (its record and its note)
    assert.deepEqual(r.runs, ["RUN-1"]);
    assert.equal(laneRecord("RUN-1").status, "stopped");
    assert.ok(laneRecord("RUN-1").ended_at, "the stopped run records when");
    assert.equal(readFileSync(join(dir, "lanes", "DONE-1", "lane.json"), "utf8"), doneBefore, "the ended run's record is not rewritten");
    assert.deepEqual([note().attrs.via, note().attrs.runs], ["ignore", ["RUN-1"]]);
  });
});

test("a plan review run that switched role while it ran keeps its switch on the status", () => {
  ensureAgentRunner();
  const report = join(dir, "planreview-report");
  const fallbacks = [
    { role: "reviewer", fallback: "reviewer-deep", kind: "timeout", reason: "x" },
    { role: "reviewer-deep", fallback: "api", kind: "provider", reason: "y" },
  ];
  mkdirSync(join(dir, "lanes", "PLANREV-1"), { recursive: true });
  writeFileSync(join(dir, "lanes", "PLANREV-1", "lane.json"), JSON.stringify({
    id: "PLANREV-1", role: "api", model: "x/api", worktree: "/w", spec: "/s.yaml", report, status: "done", fallbacks,
  }));
  writeFileSync(`${report}.json`, JSON.stringify({ findings: [{ severity: "nit", path: "", claim: "言い回し", evidence: "" }] }));

  const st = getAgentRunner().planReviewStatus("PLANREV-1");
  assert.equal(st.state, "done");
  // the mid-run switches reach the closing record's reader, as an S2 round's do
  assert.deepEqual(st.fallbacks, fallbacks);
  assert.deepEqual(st.findings, [{ severity: "nit", path: "", claim: "言い回し", evidence: "" }]);
});

test("the real runtime gives core the judge of the questions only while roles.yaml names it, and routes through the lane's one shot", async () => {
  ensureAgentRunner();
  const runner = getAgentRunner();
  const roles = join(dir, "routing-roles.yaml");
  process.env.IDD_ROLES_FILE = roles;
  writeFileSync(roles, "models:\n  m: { model: x/y }\nroles:\n  question-router: { model: m, thinking: high, report: free, budget_minutes: 5 }\npipeline:\n");
  assert.equal(runner.questionRouting(), null, "a roles.yaml without the key routes nothing");
  await assert.rejects(runner.routeQuestions({ lane: "IDD-001", batch: { idd_id: "IDD-001", batch_id: "B", asked_at: "x", questions: [] }, material: { choices: [], issue: "", worktree: dir } }), /question_routing/);
  writeFileSync(roles, "models:\n  m: { model: x/y }\nroles:\n  question-router: { model: m, thinking: high, report: free, budget_minutes: 5 }\npipeline:\n  question_routing: { role: question-router }\n");
  assert.deepEqual(runner.questionRouting(), { role: "question-router", model: "x/y" });
  assert.equal(typeof runner.kickTick, "function");
});

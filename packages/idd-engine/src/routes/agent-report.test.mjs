import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

process.env.IDD_TICK_KICK = "off";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { POST: resultPost } = await jiti.import("./agent-result.ts");
const { POST: progressPost } = await jiti.import("./agent-progress.ts");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const TOKEN = "test-agent-token";
const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  delete process.env.IDD_AGENT_TOKEN;
});

function setup() {
  const root = scratchDir("agent-report-");
  made.push(root);
  const state = join(root, "state"); mkdirSync(state);
  writeFileSync(join(state, "backlog.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", area: "me/app", title: "T", context: "", created_at: "2026-09-24T00:00:00Z" })}\n`);
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_AGENT_TOKEN: TOKEN });
  return { root, state };
}

const post = (path, body) => jiti.import(path).then(({ POST }) => POST(new Request("http://localhost/x", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
})));

const lifecycle = (state) => {
  const file = readdirSync(state).find((f) => f.startsWith("lifecycle-"));
  if (!file) return [];
  return readFileSync(join(state, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const workFile = (state) => readdirSync(state).find((f) => f.startsWith("work-"));
const workRows = (state) => {
  const file = workFile(state);
  return file ? readFileSync(join(state, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("AC-006: an evidence-less verified is accepted with a warning naming the drop and the shape", async () => {
  const { state } = setup();
  const res = await resultPost(new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ idd_id: "IDD-1", outcome: "success", changed_files: [], commit_count: 1, qa_verified: ["AC-001"], qa_unverified: [] }),
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.warning, /AC-001/);
  assert.match(body.warning, /--evidence/);
  // the result record stays, and the AC goes in as covered
  assert.ok(lifecycle(state).some((e) => e.event === "s2_result"));
  assert.deepEqual(workRows(state)[0].items, [{ id: "AC-001", status: "covered", downgraded: true }]);
});

test("AC-007: an old-shaped result (no evidence column) and a current progress both go through", async () => {
  const { state } = setup();
  const result = await resultPost(new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ idd_id: "IDD-1", outcome: "success", changed_files: ["a.ts"], commit_count: 1, qa_verified: ["AC-001"], qa_unverified: ["AC-002"] }),
  }));
  assert.equal(result.status, 200);
  assert.ok(lifecycle(state).some((e) => e.event === "s2_result" && e.attrs.qa_verified[0] === "AC-001"));

  const progress = await progressPost(new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ idd_id: "IDD-1", current_step: "implementing", qa_status: [{ qa_id: "AC-002", status: "in_progress" }], recent_activity: ["did a thing"] }),
  }));
  const body = await progress.json();
  assert.equal(progress.status, 200);
  assert.equal(body.ok, true);
  const states = workRows(state).flatMap((r) => r.items).map((i) => `${i.id}:${i.status}`);
  // an old result passes through; its evidence-less verified is recorded as covered (DEC-105-2)
  assert.ok(states.includes("AC-001:covered"));
  assert.ok(states.includes("AC-002:covered"));
});

test("a result with evidence adds the column and records verified", async () => {
  const { state } = setup();
  const res = await post("./agent-result.ts", { idd_id: "IDD-1", outcome: "success", changed_files: [], commit_count: 1, qa_verified: ["AC-001"], qa_unverified: [], qa_evidence: { "AC-001": "ran it" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.warning, undefined);
  assert.deepEqual(workRows(state)[0].items, [{ id: "AC-001", status: "verified", evidence: "ran it" }]);
  const recorded = lifecycle(state).find((e) => e.event === "s2_result");
  assert.deepEqual(recorded.attrs.qa_evidence, { "AC-001": "ran it" });
});

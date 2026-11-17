import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

process.env.IDD_TICK_KICK = "off";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { POST: readyPost } = await jiti.import("./agent-ready.ts");
const { foldPlaceFindings } = await jiti.import("../../../../packages/idd-core/src/plan/place-findings.ts");
const { readLifecycle } = await jiti.import("../../../../packages/idd-core/src/ledger/read.ts");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const TOKEN = "test-agent-token";
const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  delete process.env.IDD_AGENT_TOKEN;
});

const allClear = [
  { kind: "auth", touches: false, reason: "認証を変えない。" },
  { kind: "authz", touches: false, reason: "認可を変えない。" },
  { kind: "billing", touches: false, reason: "課金を変えない。" },
  { kind: "permission", touches: false, reason: "権限を変えない。" },
  { kind: "data_loss", touches: false, reason: "データを消さない。" },
  { kind: "secret", touches: false, reason: "秘密を扱わない。" },
];

function setup() {
  const root = scratchDir("ready-route-");
  made.push(root);
  const state = join(root, "state"); mkdirSync(state);
  const worktree = join(root, "wt"); mkdirSync(worktree);
  const doc = join(worktree, "_docs/intent/app/other/decision.md");
  mkdirSync(dirname(doc), { recursive: true });
  writeFileSync(doc, "# other\n\n## Decisions\n\n### DEC-500: 他の lane の判断\n\n- **Why**: 壊さないため。\n- **Anchors**: `src/x.ts`\n");
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: { "me/app": { upstream: join(root, "u"), work: join(root, "w"), public_base: "main" } } }));
  writeFileSync(join(state, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", area: "me/app", title: "T", context: "", created_at: "2026-09-24T00:00:00Z" }) + "\n");
  writeFileSync(join(state, "planner-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", planner_session_id: "p1", worktree_path: worktree, branch: "idd/idd-1" }) + "\n");
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_AGENT_TOKEN: TOKEN });
  return { root, state, worktree };
}

const request = (body) => new Request("http://localhost/api/idd/agent/ready", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
});

const base = {
  idd_id: "IDD-1",
  dec_count: 1,
  inv_count: 0,
  qa_count: 1,
  reference_count: 0,
  size: "L",
  harm: 1,
  depth: "deep",
  summary: { situation: "s", action: "a", outcome: "o" },
  risk_table: allClear,
};

const readies = (state) => {
  const file = readdirSync(state).find((f) => f.startsWith("lifecycle-"));
  if (!file) return [];
  return readFileSync(join(state, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === "s1_ready");
};

test("the door carries the impact report into the ready's record (AC-025)", async () => {
  const f = setup();
  const res = await readyPost(request({ ...base, intent_impact: { paths: ["src/x.ts"], decisions: [{ id: "DEC-500", effect: "keep", reason: "Why を保つ。" }] } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const [ready] = readies(f.state);
  assert.equal(ready.attrs.intent_impact.candidate_count, 1);
  assert.equal(ready.attrs.intent_impact.rows[0].id, "DEC-500");
  assert.deepEqual(ready.attrs.intent_impact.paths, ["src/x.ts"]);
});

test("a body without the field is refused and writes no ready (AC-025)", async () => {
  const f = setup();
  const res = await readyPost(request(base));
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /idd intent decisions/);
  assert.equal(readies(f.state).length, 0);
});

test("a body whose decisions are not an array is refused at the door (AC-025)", async () => {
  const f = setup();
  const res = await readyPost(request({ ...base, intent_impact: { paths: [], decisions: "none" } }));
  assert.equal(res.status, 400);
  assert.equal(readies(f.state).length, 0);
});

/** one open place finding of a merged lane, on the path the plan touches; written to the repo's work column */
function openFinding(state, id = "F-8-1") {
  writeFileSync(join(state, "work-me%2Fapp.jsonl"), `${JSON.stringify({ event: "finding_placed", at: "2026-10-13T00:00:00Z", repo: "me/app", lane: "IDD-8", id, round: 1, path: "src/x.ts", lines: [3, 3], commit: "H1", severity: "should", claim: "確認が無い" })}\n`);
  writeFileSync(join(state, "lifecycle-me-app.jsonl"), `${JSON.stringify({ idd_id: "IDD-8", event: "lane_close", at: "2026-10-13T02:00:00Z", attrs: { outcome: "merged" } })}\n`);
}

const workRows = (state) => {
  const file = readdirSync(state).find((f) => f.startsWith("work-"));
  return file ? readFileSync(join(state, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const impact = (paths) => ({ intent_impact: { paths, decisions: [] } });

test("AC-028: a plan whose touched path holds open findings is refused without a disposal for each", async () => {
  const f = setup();
  openFinding(f.state, "F-8-1");
  writeFileSync(join(f.state, "work-me%2Fapp.jsonl"), readFileSync(join(f.state, "work-me%2Fapp.jsonl"), "utf8") + `${JSON.stringify({ event: "finding_placed", at: "2026-10-13T00:30:00Z", repo: "me/app", lane: "IDD-8", id: "F-8-2", round: 1, path: "src/x.ts", lines: [9, 9], commit: "H1", severity: "nit", claim: "命名" })}\n`);
  const none = await readyPost(request({ ...base, ...impact(["src/x.ts"]) }));
  assert.equal(none.status, 400);
  assert.equal(readies(f.state).length, 0, "no ready is written when a finding is left undisposed");
  const one = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "fix" }] }));
  assert.equal(one.status, 400);
  const noReason = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "fix" }, { id: "F-8-2", action: "drop" }] }));
  assert.equal(noReason.status, 400);
  const bad = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "later" }] }));
  assert.equal(bad.status, 400);
});

test("AC-029: the refusal names the findings, the report shape and how to pull them again", async () => {
  const f = setup();
  openFinding(f.state);
  const res = await readyPost(request({ ...base, ...impact(["src/x.ts"]) }));
  assert.equal(res.status, 400);
  const error = String((await res.json()).error);
  assert.match(error, /F-8-1/);
  assert.match(error, /src\/x\.ts/);
  assert.match(error, /確認が無い/);
  assert.match(error, /"findings"/);
  assert.match(error, /"action":"fix"/);
  assert.match(error, /idd work findings/);
});

test("AC-028: a report disposing of every open finding passes and records the dispositions", async () => {
  const f = setup();
  openFinding(f.state);
  const res = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "fix" }, { id: "F-999", action: "fix" }] }));
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  assert.equal(readies(f.state).length, 1);
  const disposed = workRows(f.state).filter((r) => r.event === "finding_disposed");
  assert.equal(disposed.length, 1, "an id that is not open is ignored");
  assert.equal(disposed[0].id, "F-8-1");
  assert.equal(disposed[0].action, "fix");
  assert.equal(disposed[0].lane, "IDD-1");
});

test("AC-030: with no open finding the current report passes without a findings field", async () => {
  const f = setup();
  const res = await readyPost(request({ ...base, ...impact(["src/x.ts"]) }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(readies(f.state).length, 1);
  assert.equal(workRows(f.state).filter((r) => r.event === "finding_disposed").length, 0);
});

test("F-1: a lane that dropped a finding can send a fix for it later", async () => {
  const f = setup();
  openFinding(f.state);
  const dropped = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "drop", reason: "範囲の外" }] }));
  assert.equal(dropped.status, 200, JSON.stringify(await dropped.clone().json()));
  const again = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "fix" }] }));
  assert.equal(again.status, 200, JSON.stringify(await again.clone().json()));
  const disposed = workRows(f.state).filter((r) => r.event === "finding_disposed");
  assert.deepEqual(disposed.map((r) => [r.id, r.action]), [["F-8-1", "drop"], ["F-8-1", "fix"]]);
  const folded = foldPlaceFindings(workRows(f.state), readLifecycle(), "IDD-1").find((x) => x.id === "F-8-1");
  assert.equal(folded.status, "open", "the lane's later fix reopens what its own drop closed");
  assert.equal(folded.fixLane, "IDD-1");
  assert.equal(folded.disposedBy, undefined);
});

test("F-1: a refused report's drop is not recorded and does not block the next report", async () => {
  const f = setup();
  openFinding(f.state);
  writeFileSync(join(f.state, "work-me%2Fapp.jsonl"), readFileSync(join(f.state, "work-me%2Fapp.jsonl"), "utf8") + `${JSON.stringify({ event: "finding_placed", at: "2026-10-13T00:30:00Z", repo: "me/app", lane: "IDD-8", id: "F-8-2", round: 1, path: "src/x.ts", lines: [9, 9], commit: "H1", severity: "nit", claim: "命名" })}\n`);
  const refused = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "drop", reason: "範囲の外" }] }));
  assert.equal(refused.status, 400);
  assert.equal(workRows(f.state).filter((r) => r.event === "finding_disposed").length, 0, "a refused report records none of its drops");
  const ok = await readyPost(request({ ...base, ...impact(["src/x.ts"]), findings: [{ id: "F-8-1", action: "drop", reason: "範囲の外" }, { id: "F-8-2", action: "fix" }] }));
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.deepEqual(workRows(f.state).filter((r) => r.event === "finding_disposed").map((r) => [r.id, r.action]), [["F-8-1", "drop"], ["F-8-2", "fix"]]);
});

test("AC-006: the ready door carries the 1本 reason into the record, and refuses a report without it", async () => {
  const f = setup();
  const readyRows = () => readdirSync(f.state).filter((n) => n.startsWith("lifecycle-"))
    .flatMap((n) => readFileSync(join(f.state, n), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.event === "s1_ready");
  // a lane whose brief knows the rule made a granularity proposal; a split turned down to one lane is answered
  writeFileSync(join(f.state, "lifecycle-1.jsonl"), [
    JSON.stringify({ event: "s1_granularity_proposed", idd_id: "IDD-1", at: new Date().toISOString(), attrs: { kind: "split", reason: "責務が 2 つ。", children: [{ title: "a", whole: "w", places: ["src/x.ts"], after: [] }] } }),
    JSON.stringify({ event: "s1_granularity_answered", idd_id: "IDD-1", at: new Date().toISOString(), attrs: { decision: "single" } }),
  ].join("\n") + "\n");
  const missing = await readyPost(request({ ...base, ...impact(["src/x.ts"]) }));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /1本/);
  assert.equal(readyRows().length, 0);
  const ok = await readyPost(request({ ...base, ...impact(["src/x.ts"]), granularity_reason: "人が 1 本と決めた。" }));
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.equal(readyRows()[0].attrs.granularity_reason, "人が 1 本と決めた。");
});

test("AC-002: the ready door refuses a report while the granularity proposal waits on a person", async () => {
  const f = setup();
  writeFileSync(join(f.state, "lifecycle-1.jsonl"), `${JSON.stringify({ event: "s1_granularity_proposed", idd_id: "IDD-1", at: new Date().toISOString(), attrs: { kind: "split", reason: "r", children: [{ title: "a", whole: "w", places: ["src/x.ts"], after: [] }] } })}\n`);
  const res = await readyPost(request({ ...base, ...impact(["src/x.ts"]), granularity_reason: "r" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /答え/);
  assert.equal(readies(f.state).length, 0);
});

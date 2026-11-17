import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import { restoreStateEnv } from "./helpers/state-env.mjs";
import * as store from "../src/intent/store.ts";
import * as projects from "../src/intent/project-store.ts";
import {
  completionCandidate, foldProjects, issueRefOfRecord, issueStatuses, normalizeDecisionBody, normalizeIssueRef,
  normalizeProjectBody, normalizeProjectPatch,
} from "../src/intent/project.ts";
import { PROJECTION_MARK, projectRecords } from "../src/intent/projection.ts";
import { checkProjection, checkState } from "../src/intent/check.ts";
import { executorBrief, fixBrief } from "../src/plan/exec.ts";
import { plannerBrief } from "../src/plan/prep.ts";
import { buildEnvelope } from "../src/ledger/write.ts";
import { readLifecycle } from "../src/ledger/read.ts";

restoreStateEnv();

const REPO = "me/app";
const OUTSIDE = { session: "s1" };
const LANE = { lane: "IDD-7" };

function setup() {
  const root = scratchDir("intent-project-");
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: { [REPO]: { upstream: join(root, "u"), work: join(root, "w"), public_base: "main" } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") });
  const wt = join(root, "wt");
  mkdirSync(wt);
  return { root, state, wt };
}

const seedLifecycle = (state, rows) => appendFileSync(join(state, "lifecycle-test.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const seedBacklog = (state, rows) => appendFileSync(join(state, "backlog.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const backlogRow = (iddId, number, over = {}) => ({
  idd_id: iddId, parent_id: null, created_at: "2026-10-26T00:00:00Z", linear_issue_url: null, gh_issue_url: `https://github.com/me/app/issues/${number}`,
  pull_req_url: null, source_type: "github", context: "", title: `Issue ${number}`, area: REPO, ...over,
});

async function activePurpose(statement = "利用者がまとまりを持てるようにしたい。なぜなら Issue だけでは足りないから。") {
  const r = await store.raisePurpose({ repo: REPO, actor: OUTSIDE, statement, origin: "常設" });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

const projectBody = (purpose, over = {}) => ({ name: "まとまり", purpose, done_when: "利用者が一覧で完了を確かめられる", body: "# 見出しに見える行\n自由な文", ...over });
const decisionBody = (over = {}) => ({
  chosen: "状態の追記の列に持つ", why: "正本を Choice と同じ所に置くため", rejected: [{ form: "別のファイル", fails_because: "検査が二重になる" }], ...over,
});

async function newProject(purpose, over = {}, actor = OUTSIDE) {
  const r = await projects.raiseProject({ repo: REPO, actor, body: projectBody(purpose, over) });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

// ---- AC-001: the fields, the fold, the copy and its check ----

test("AC-001: a Project is raised with its fields and read back from the state", async () => {
  setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose, { state: "started" });
  assert.equal(id, "PRJ-1");
  const decided = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody() });
  assert.equal(decided.ok, true, decided.error);
  assert.equal(decided.decision, "PD-1-1");
  const [p] = projects.projectStatuses(REPO, null);
  assert.equal(p.name, "まとまり");
  assert.equal(p.purpose, purpose);
  assert.equal(p.doneWhen, "利用者が一覧で完了を確かめられる");
  assert.equal(p.state, "started");
  assert.equal(p.body, "# 見出しに見える行\n自由な文");
  assert.deepEqual(p.decisions.map((d) => [d.id, d.chosen, d.why, d.rejected]), [
    ["PD-1-1", "状態の追記の列に持つ", "正本を Choice と同じ所に置くため", [{ form: "別のファイル", fails_because: "検査が二重になる" }]],
  ]);
  assert.equal(p.document, "_docs/intent/app/PRJ-1.md");
  // the Purpose's sentence is read from the Purpose; the Project holds only its id
  assert.equal(JSON.stringify(p).includes("利用者がまとまりを持てるように"), false);
});

test("AC-001: the fields are checked before anything is written", async () => {
  setup();
  const purpose = await activePurpose();
  for (const [over, message] of [[{ name: "" }, /name/], [{ done_when: " " }, /done_when/], [{ state: "done" }, /state/]]) {
    const r = await projects.raiseProject({ repo: REPO, actor: OUTSIDE, body: projectBody(purpose, over) });
    assert.equal(r.ok, false);
    assert.match(r.error, message);
  }
  const noPurpose = await projects.raiseProject({ repo: REPO, actor: OUTSIDE, body: projectBody("P-99") });
  assert.match(noPurpose.error, /Purpose P-99 はありません/);
  const proposed = await store.raisePurpose({ repo: REPO, actor: LANE, statement: "案", origin: "lane" });
  const refused = await projects.raiseProject({ repo: REPO, actor: LANE, body: projectBody(proposed.id) });
  assert.match(refused.error, /active ではありません/);
  assert.equal(projects.projectStatuses(REPO, null).length, 0, "nothing was written by a refused call");
  assert.equal(normalizeProjectPatch({}).ok, false);
  assert.equal(normalizeDecisionBody({ chosen: "a", why: "b" }).ok, false, "no rejected form and no reason is refused");
  assert.equal(normalizeDecisionBody({ chosen: "a", why: "b", no_why_not: "捨てた形が無い" }).ok, true);
  assert.equal(normalizeProjectBody({ name: "n", purpose: "P-1", done_when: "d" }).ok, true);
});

test("AC-001: a change takes the last row for each field, and a decision is revised in place", async () => {
  setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose);
  const up = await projects.updateProject({ repo: REPO, actor: OUTSIDE, id, patch: { name: "改め", state: "paused", body: "" } });
  assert.equal(up.ok, true, up.error);
  const d = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody() });
  const second = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody({ chosen: "二つ目" }) });
  assert.equal(second.decision, "PD-1-2");
  const revised = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, decision: d.decision, body: decisionBody({ why: "直した理由" }) });
  assert.equal(revised.created, false);
  const [p] = projects.projectStatuses(REPO, null);
  assert.equal(p.name, "改め");
  assert.equal(p.state, "paused");
  assert.equal(p.body, "", "an emptied document is a change");
  assert.deepEqual(p.decisions.map((x) => [x.id, x.why]), [["PD-1-1", "直した理由"], ["PD-1-2", "正本を Choice と同じ所に置くため"]]);
  const missing = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, decision: "PD-1-9", body: decisionBody() });
  assert.match(missing.error, /PD-1-9/);
});

test("AC-001: the copy under _docs/intent carries the same content, is the same bytes every time, and a hand edit is found", async () => {
  setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose);
  await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody() });
  await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id, issues: ["#234", "me/app#235"] });
  const view = store.projectionViewFor(REPO);
  const file = view.files.find((f) => f.name === "PRJ-1.md");
  assert.ok(file, view.files.map((f) => f.name).join(","));
  assert.equal(file.content.split("\n")[0], PROJECTION_MARK);
  for (const piece of ["# PRJ-1: まとまり", "- state: planned", "利用者が一覧で完了を確かめられる", "### PD-1-1: 状態の追記の列に持つ", "正本を Choice と同じ所に置くため", "別のファイル", "- me/app#234", "- me/app#235"]) {
    assert.ok(file.content.includes(piece), `${piece}\n${file.content}`);
  }
  // a heading-looking line of the free text is escaped, so the only headings are the ones the drawing makes
  assert.ok(file.content.includes("\\# 見出しに見える行"));
  assert.deepEqual(file.content.split("\n").filter((l) => l.startsWith("# ")), ["# PRJ-1: まとまり"]);
  assert.equal(JSON.stringify(store.projectionViewFor(REPO).files), JSON.stringify(view.files), "the same state draws the same bytes");
  const overview = view.files.find((f) => f.name === "overview.md").content;
  assert.ok(overview.includes("## Project") && overview.includes("PRJ-1.md"));

  const list = (...names) => () => names.map((name) => ({ name, kind: "file" }));
  const files = view.files.filter((f) => f.name === "PRJ-1.md");
  const read = (content) => () => content;
  assert.deepEqual(checkProjection({ files, list: list("PRJ-1.md"), read: read(file.content) }), []);
  const edited = checkProjection({ files, list: list("PRJ-1.md"), read: read(file.content.replace("まとまり", "手で直した")) });
  assert.equal(edited.length, 1);
  assert.match(edited[0].reason, /写しが直されています/);
  assert.equal(edited[0].id, "PRJ-1.md");
  const gone = checkProjection({ files, list: list(), read: read(null) });
  assert.match(gone[0].reason, /写しがありません/);
});

test("AC-001: a repo with no Project draws what it always drew", () => {
  const withNone = projectRecords({ purposes: [{ id: "P-1", statement: "S", origin: "O", status: "active", raised: { by: OUTSIDE, at: "t" } }], choices: [] });
  const withEmpty = projectRecords({ purposes: [{ id: "P-1", statement: "S", origin: "O", status: "active", raised: { by: OUTSIDE, at: "t" } }], choices: [], projects: [] });
  assert.deepEqual(withEmpty, withNone);
  assert.equal(withNone.some((f) => f.content.includes("## Project")), false);
  assert.deepEqual(projectRecords({ purposes: [], choices: [], projects: [] }), []);
});

// ---- AC-002: belonging ----

test("AC-002: Issue refs come to one form whichever way they are written", () => {
  for (const [input, expected] of [
    ["https://github.com/Me/App/issues/234", "me/app#234"],
    ["me/app#234", "me/app#234"],
    ["#234", "me/app#234"],
    ["234", "me/app#234"],
    ["https://linear.app/team/issue/app-12/some-title", "APP-12"],
    ["app-12", "APP-12"],
  ]) {
    const r = normalizeIssueRef(input, "me/app");
    assert.deepEqual(r, { ok: true, value: expected }, input);
  }
  assert.equal(normalizeIssueRef("nonsense", "me/app").ok, false);
  assert.equal(normalizeIssueRef("12", "").ok, false, "a bare number needs a repo to be read in");
  assert.equal(issueRefOfRecord(backlogRow("IDD-1", 5)), "me/app#5");
  assert.equal(issueRefOfRecord({ gh_issue_url: null, linear_issue_url: "https://linear.app/t/issue/APP-9/x" }), "APP-9");
  assert.equal(issueRefOfRecord({ gh_issue_url: null, linear_issue_url: null }), null);
});

test("AC-002: an Issue is attached and detached, and belongs to one Project only", async () => {
  setup();
  const purpose = await activePurpose();
  const a = await newProject(purpose, { name: "A" });
  const b = await newProject(purpose, { name: "B" });
  const first = await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id: a, issues: ["#1", "#2", "APP-3"] });
  assert.deepEqual([first.attached, first.already, first.moved], [["me/app#1", "me/app#2", "APP-3"], [], []]);
  const again = await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id: a, issues: ["#1"] });
  assert.deepEqual([again.attached, again.already], [[], ["me/app#1"]]);
  const taken = await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id: b, issues: ["#2"] });
  assert.deepEqual(taken.moved, [{ issue: "me/app#2", from: a }]);
  const byId = Object.fromEntries(projects.projectStatuses(REPO, null).map((p) => [p.id, p.issues]));
  assert.deepEqual(byId, { [a]: ["me/app#1", "APP-3"], [b]: ["me/app#2"] });
  const detached = await projects.detachIssues({ repo: REPO, actor: OUTSIDE, id: a, issues: ["#1"] });
  assert.equal(detached.ok, true, detached.error);
  const notHere = await projects.detachIssues({ repo: REPO, actor: OUTSIDE, id: a, issues: ["#2"] });
  assert.match(notHere.error, /属していない/);
  assert.deepEqual(projects.projectStatuses(REPO, null).find((p) => p.id === a).issues, ["APP-3"]);
  const unknown = await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id: "PRJ-9", issues: ["#1"] });
  assert.match(unknown.error, /PRJ-9/);
});

test("AC-002: an Issue with no lane yet and an Issue whose lane has landed are both found by the same ref", async () => {
  const { state } = setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose);
  await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id, issues: ["#10", "#11"] });
  // #10 has a lane that landed and is closed; #11 has no lane at all
  seedBacklog(state, [backlogRow("IDD-10", 10)]);
  seedLifecycle(state, [{ event: "lane_close", idd_id: "IDD-10", at: "2026-10-26T01:00:00Z", attrs: { outcome: "merged" } }]);
  const landed = projects.projectOfLane(REPO, backlogRow("IDD-10", 10));
  assert.equal(landed?.id, id);
  assert.equal(projects.projectOfLane(REPO, { idd_id: "IDD-11", gh_issue_url: "https://github.com/me/app/issues/11", linear_issue_url: null })?.id, id, "a lane taken in later finds it as well");
  assert.equal(projects.projectOfLane(REPO, backlogRow("IDD-12", 12)), null, "an Issue that belongs nowhere");
  assert.equal(projects.projectOfLane(REPO, { idd_id: "IDD-13", gh_issue_url: null, linear_issue_url: null }), null, "a lane with no Issue");
});

test("AC-002: a lane's Project rows reach nobody else before the lane lands", async () => {
  const { state } = setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose, {}, LANE);
  await projects.attachIssues({ repo: REPO, actor: LANE, id, issues: ["#1"] });
  assert.equal(projects.projectStatuses(REPO, null).length, 0, "the outside sees nothing");
  assert.equal(projects.projectStatuses(REPO, { lane: "IDD-8" }).length, 0, "another lane sees nothing");
  assert.deepEqual(projects.projectStatuses(REPO, LANE).map((p) => [p.id, p.issues]), [[id, ["me/app#1"]]], "the lane sees its own");
  seedLifecycle(state, [{ event: "lane_close", idd_id: "IDD-7", at: new Date(Date.now() + 60_000).toISOString(), attrs: { outcome: "merged" } }]);
  assert.equal(projects.projectStatuses(REPO, null).length, 1, "the landing makes the rows everyone's");
  seedLifecycle(state, [{ event: "s1_defer", idd_id: "IDD-8", at: "2026-10-26T00:00:00Z", attrs: {} }]);
  const refused = await projects.raiseProject({ repo: REPO, actor: { lane: "IDD-8" }, body: projectBody(purpose) });
  assert.match(refused.error, /終わっている/);
});

// ---- AC-003: the brief ----

async function laneInProject(over = {}) {
  const ctx = setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose, { state: "started", ...over });
  await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id, issues: ["#1"] });
  seedLifecycle(ctx.state, [
    { event: "lane_open", idd_id: "IDD-1", at: "2026-10-26T00:00:00Z", attrs: {} },
    { event: "s1_ready", idd_id: "IDD-1", at: "2026-10-26T00:01:00Z", attrs: { records_shape: "state" } },
    { event: "s1_go", idd_id: "IDD-1", at: "2026-10-26T00:02:00Z", attrs: {} },
  ]);
  return { ...ctx, purpose, id };
}

const rec = { idd_id: "IDD-1", area: REPO, title: "T", context: "", gh_issue_url: "https://github.com/me/app/issues/1" };

test("AC-003: the brief of a lane in a Project carries its aim, state, decisions and document, and never its text", async () => {
  const { wt, id, purpose } = await laneInProject();
  await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody() });
  for (const [role, brief] of [["executor", executorBrief(rec, wt)], ["planner", plannerBrief(rec, undefined, wt, undefined, "state")]]) {
    const block = brief.split("<project ")[1]?.split("</project>")[0];
    assert.ok(block, `${role}: a <project> element`);
    assert.ok(block.startsWith(`id="${id}" state="started">`), block);
    assert.ok(block.includes("<name>まとまり</name>"), role);
    assert.ok(block.includes(`<purpose id="${purpose}">利用者がまとまりを持てるようにしたい。なぜなら Issue だけでは足りないから。</purpose>`), role);
    assert.ok(block.includes("<done-when>利用者が一覧で完了を確かめられる</done-when>"), role);
    assert.ok(block.includes("_docs/intent/app/PRJ-1.md"), role);
    assert.ok(block.includes("<chosen>状態の追記の列に持つ</chosen>") && block.includes("<why>正本を Choice と同じ所に置くため</why>"), role);
    assert.equal(brief.includes("自由な文"), false, `${role}: the free text is not copied`);
    assert.equal(brief.includes("見出しに見える行"), false, `${role}: the free text is not copied`);
    // the element sits inside the lane element
    assert.ok(brief.split("<lane>")[1].split("</lane>")[0].includes("<project "), role);
  }
  const fix = fixBrief(rec, wt, buildEnvelope("review_fix", "IDD-1", "  <task>直す</task>"));
  assert.ok(fix.includes(`<project id="${id}"`), "a fix round gets the same Project");
});

test("AC-003: decisions are capped: the first five with their reason, then headings, and moved ones are not repeated", async () => {
  const { wt, id } = await laneInProject();
  for (let n = 1; n <= 40; n += 1) {
    const r = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody({ chosen: `決定 ${n}`, why: `理由 ${n}` }) });
    assert.equal(r.ok, true, r.error);
  }
  const block = executorBrief(rec, wt).split("<project ")[1].split("</project>")[0];
  assert.ok(block.includes('<decisions count="40" shown="5">'), block);
  assert.equal((block.match(/<why>/g) ?? []).length, 5);
  assert.equal((block.match(/<decision id=/g) ?? []).length, 35, "five whole and thirty headings");
  assert.ok(block.includes("ほか 5 件"), "the rest is a count");
  assert.equal(block.includes("理由 6<"), false, "a heading carries no reason");
  const long = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, decision: "PD-1-1", body: decisionBody({ why: "あ".repeat(3000) }) });
  assert.equal(long.ok, true);
  const cutBlock = executorBrief(rec, wt).split("<project ")[1].split("</project>")[0];
  assert.ok(cutBlock.includes("…（全文は"), "a long reason is cut and says where the whole is");
});

test("AC-003: a lane outside every Project gets the brief it always got", async () => {
  const { wt } = await laneInProject();
  const other = { ...rec, idd_id: "IDD-2", gh_issue_url: "https://github.com/me/app/issues/2" };
  seedLifecycle(process.env.IDD_STATE_DIR, [{ event: "s1_ready", idd_id: "IDD-2", at: "2026-10-26T00:01:00Z", attrs: { records_shape: "state" } }]);
  const before = executorBrief(other, wt);
  assert.equal(before.includes("<project "), false);
  assert.equal(plannerBrief(other, undefined, wt, undefined, "state").includes("<project "), false);
  const purpose = await activePurpose("別の目的。");
  await newProject(purpose, { name: "無関係" });
  assert.equal(executorBrief(other, wt), before, "another Project changes nothing for a lane it does not hold");
});

test("AC-003: a docs-shape lane in a Project gets the Project in its planner and executor briefs too", async () => {
  const { wt, id } = await laneInProject();
  await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody() });
  const docs = { ...rec, idd_id: "IDD-3", gh_issue_url: "https://github.com/me/app/issues/3" };
  await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id, issues: ["#3"] });
  seedLifecycle(process.env.IDD_STATE_DIR, [{ event: "s1_ready", idd_id: "IDD-3", at: "2026-10-26T00:01:00Z", attrs: {} }]);
  for (const [role, brief] of [["executor", executorBrief(docs, wt)], ["planner", plannerBrief(docs, undefined, wt, undefined, "docs")]]) {
    const block = brief.split("<project ")[1]?.split("</project>")[0];
    assert.ok(block, `${role}: a <project> element in the old shape`);
    assert.ok(block.startsWith(`id="${id}" `) && block.includes("<chosen>状態の追記の列に持つ</chosen>"), role);
  }
});

test("AC-003: the briefs that carry no intent never reach the Project reader", () => {
  const dir = join(import.meta.dirname, "..", "src");
  const users = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(path, entry.name));
      else if (entry.name.endsWith(".ts") && readFileSync(join(path, entry.name), "utf8").includes("project-brief.ts")) users.push(entry.name);
    }
  };
  walk(dir);
  assert.deepEqual(users.sort(), ["exec.ts", "prep.ts"], "only the planner's and the executor's briefs read it");
});

// ---- AC-004: from a decision to a Choice ----

const choiceFile = (over = {}) => ({ place: [{ path: "packages/idd-core/src/intent/project.ts", kind: "file" }], anchored: "Project の本文と決定は状態だけから導ける", ...over });

async function promoted() {
  const ctx = setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose);
  const d = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody() });
  const r = await projects.promoteDecision({ repo: REPO, actor: LANE, id, decision: d.decision, body: choiceFile() });
  assert.equal(r.ok, true, r.error);
  return { ...ctx, purpose, id, decision: d.decision, choice: r.id };
}

test("AC-004: a decision moves into a Choice that carries its text, and the Project keeps only the pointer", async () => {
  const { id, decision, choice, purpose } = await promoted();
  assert.equal(choice, "C-7-1");
  const view = store.showRecord({ repo: REPO, actor: LANE, id: choice });
  assert.equal(view.ok, true, view.error);
  assert.equal(view.record.purpose, purpose, "the Project's Purpose is the default");
  assert.equal(view.record.forms.chosen, "状態の追記の列に持つ");
  assert.deepEqual(view.record.forms.rejected, [{ form: "別のファイル", fails_because: "検査が二重になる" }]);
  assert.equal(view.record.why, "正本を Choice と同じ所に置くため");
  const [p] = projects.projectStatuses(REPO, LANE);
  const d = p.decisions.find((x) => x.id === decision);
  assert.equal(d.movedTo, choice);
  assert.equal(d.why, undefined, "the body is no longer in the Project");
  assert.equal(d.rejected, undefined);
  assert.equal(d.chosen, "状態の追記の列に持つ", "the heading stays so the pointer reads");
  // the copy points at the Choice and carries no reason; the Choice's own section carries it
  const files = store.projectionViewFor(REPO, "IDD-7").files;
  const copy = files.find((f) => f.name === "PRJ-1.md").content;
  assert.ok(copy.includes(`### ${decision}: 状態の追記の列に持つ [→ ${choice}]`), copy);
  assert.ok(copy.includes(`${choice}（active）`), copy);
  assert.equal(copy.includes("正本を Choice と同じ所に置くため"), false);
  assert.equal(copy.includes("別のファイル"), false);
  assert.ok(files.find((f) => f.name === `${purpose}.md`).content.includes("正本を Choice と同じ所に置くため"));
  // the move is one row: the Choice and the pointer stand together
  const rows = readFileSync(store.intentColumnPath(REPO), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.event === "choice_raised").length, 1);
  assert.deepEqual(rows.find((r) => r.event === "choice_raised").from_decision, { project: id, decision });
  // outside the lane the move has not landed: the decision still holds its body
  const outside = projects.projectStatuses(REPO, null)[0].decisions[0];
  assert.equal(outside.movedTo, undefined);
  assert.equal(outside.why, "正本を Choice と同じ所に置くため");
});

test("AC-004: a decision moves once, a moved decision is not revised, and the Choice's own rules apply", async () => {
  const { id, decision } = await promoted();
  const again = await projects.promoteDecision({ repo: REPO, actor: LANE, id, decision, body: choiceFile() });
  assert.match(again.error, /既に Choice C-7-1 に移って/);
  const revise = await projects.setProjectDecision({ repo: REPO, actor: LANE, id, decision, body: decisionBody() });
  assert.match(revise.error, /移っています/);
  const other = await projects.setProjectDecision({ repo: REPO, actor: LANE, id, body: decisionBody({ chosen: "別の決定" }) });
  const noPlace = await projects.promoteDecision({ repo: REPO, actor: LANE, id, decision: other.decision, body: { anchored: "a" } });
  assert.match(noPlace.error, /place/);
  const noAnchored = await projects.promoteDecision({ repo: REPO, actor: LANE, id, decision: other.decision, body: { place: choiceFile().place } });
  assert.match(noAnchored.error, /anchored/);
  const overridden = await projects.promoteDecision({ repo: REPO, actor: LANE, id, decision: other.decision, body: choiceFile({ why: "書き直した", free: "自由" }) });
  assert.equal(overridden.ok, true, overridden.error);
  assert.equal(store.showRecord({ repo: REPO, actor: LANE, id: overridden.id }).record.why, "書き直した");
  const unknown = await projects.promoteDecision({ repo: REPO, actor: LANE, id, decision: "PD-1-99", body: choiceFile() });
  assert.match(unknown.error, /PD-1-99/);
});

test("AC-004: a decision that another lane moved and has not landed cannot be moved a second time", async () => {
  const { id, decision } = await promoted();
  const second = { lane: "IDD-8" };
  const again = await projects.promoteDecision({ repo: REPO, actor: second, id, decision, body: choiceFile() });
  assert.equal(again.ok, false);
  assert.match(again.error, /既に別の Choice/);
  assert.equal(again.error.includes("C-7-1"), false, "the other lane's Choice is not named");
  const rows = store.readRows(store.intentColumnPath(REPO));
  assert.equal(rows.filter((r) => r.event === "choice_raised").length, 1, "one Choice from the decision");
  const outside = await projects.promoteDecision({ repo: REPO, actor: OUTSIDE, id, decision, body: choiceFile() });
  assert.match(outside.error, /既に別の Choice/);
});

test("AC-004: a decision that another lane moved and has not landed cannot be revised, so no accepted revision is dropped", async () => {
  const { id, decision, choice, state } = await promoted();
  const decisionRows = () => store.readRows(store.intentColumnPath(REPO)).filter((r) => r.event === "project_decision_set").length;
  const before = decisionRows();
  const beforeAll = store.readRows(store.intentColumnPath(REPO)).length;
  assert.ok(before >= 1, "the decision row being counted exists");
  for (const actor of [{ lane: "IDD-8" }, OUTSIDE]) {
    const revised = await projects.setProjectDecision({ repo: REPO, actor, id, decision, body: decisionBody({ chosen: "直した形", why: "直した理由" }) });
    assert.equal(revised.ok, false);
    assert.match(revised.error, /別の Choice/);
    assert.equal(revised.error.includes("C-7-1"), false, "the other lane's Choice is not named");
  }
  assert.equal(decisionRows(), before, "a refused revision appends no decision row");
  assert.equal(store.readRows(store.intentColumnPath(REPO)).length, beforeAll, "a refused revision appends no row at all");
  // once the move has landed the decision points at the Choice and no revision body comes back
  seedLifecycle(state, [{ event: "lane_close", idd_id: "IDD-7", at: new Date(Date.now() + 60_000).toISOString(), attrs: { outcome: "merged" } }]);
  const landed = projects.projectStatuses(REPO, null)[0].decisions.find((d) => d.id === decision);
  assert.equal(landed.movedTo, choice);
  assert.equal(landed.why, undefined);
  assert.equal(landed.chosen, "状態の追記の列に持つ");
});

test("AC-004: a move by a lane that ended without landing does not block the decision for a later move or revision", async () => {
  const { id, decision, state } = await promoted();
  seedLifecycle(state, [{ event: "lane_close", idd_id: "IDD-7", at: new Date(Date.now() + 60_000).toISOString(), attrs: { outcome: "aborted" } }]);
  const revised = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, decision, body: decisionBody({ chosen: "直した形", why: "直した理由" }) });
  assert.equal(revised.ok, true, revised.error);
  const again = await projects.promoteDecision({ repo: REPO, actor: { lane: "IDD-8" }, id, decision, body: choiceFile() });
  assert.equal(again.ok, true, again.error);
  const rows = store.readRows(store.intentColumnPath(REPO));
  assert.equal(rows.filter((r) => r.event === "choice_raised").length, 2, "the earlier row stays: the column only appends");
  assert.match((await projects.promoteDecision({ repo: REPO, actor: { lane: "IDD-9" }, id, decision, body: choiceFile() })).error, /既に別の Choice/, "the running lane's move still blocks");
});

function stateCheck(actor) {
  const rows = store.readRows(store.intentColumnPath(REPO));
  const all = readLifecycle();
  const viewer = actor ? actor.lane : null;
  const events = viewer ? all.filter((e) => e.idd_id === viewer) : [];
  const states = store.laneStates(all);
  const folded = store.foldRows(rows, viewer, states);
  const { projects: seen } = store.foldProjectRows(rows, viewer, states);
  return checkState({ rows, folded, lane: viewer, events, projects: seen }).findings.filter((f) => f.rule.startsWith("project") || f.rule === "id-shape" || f.rule === "id-duplicate" || f.rule === "required");
}

test("AC-004: the check points at a decision whose Choice was superseded or dropped", async () => {
  const { id, decision, choice, state } = await promoted();
  seedLifecycle(state, [{ event: "lane_close", idd_id: "IDD-7", at: new Date(Date.now() + 60_000).toISOString(), attrs: { outcome: "merged" } }]);
  assert.deepEqual(stateCheck(null), [], "a standing target is no finding");
  const replaced = await store.supersede({
    repo: REPO, actor: OUTSIDE, ids: [choice], grounds: "形が変わった",
    body: { purpose: store.listRecords({ repo: REPO, actor: null, kind: "purposes" }).purposes[0].id, forms: { chosen: "新しい形", rejected: [{ form: "古い形", fails_because: "合わない" }] }, place: choiceFile().place, why: "w", anchored: "a" },
  });
  assert.equal(replaced.ok, true, replaced.error);
  const found = stateCheck(null);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].rule, "project-decision");
  assert.equal(found[0].id, decision);
  assert.equal(found[0].weight, "note");
  assert.match(found[0].reason, new RegExp(`${choice} は superseded です（後継 ${replaced.id}）`));
  // a lane that did not write the Project is told, not stopped
  assert.equal(stateCheck({ lane: "IDD-9" })[0].weight, "note");
  assert.ok(id);
});

test("AC-004: the check points at a decision whose Choice was dropped, and at a Project whose Purpose was retired", async () => {
  const ctx = setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose);
  const d = await projects.setProjectDecision({ repo: REPO, actor: OUTSIDE, id, body: decisionBody() });
  const moved = await projects.promoteDecision({ repo: REPO, actor: OUTSIDE, id, decision: d.decision, body: choiceFile({ status: "unconfirmed" }) });
  assert.equal(moved.ok, true, moved.error);
  const dropped = await store.dropChoice({ repo: REPO, actor: OUTSIDE, id: moved.id, grounds: "捨てる" });
  assert.equal(dropped.ok, true, dropped.error);
  const gone = stateCheck(null).find((f) => f.rule === "project-decision");
  assert.match(gone.reason, /dropped です/);
  assert.equal(gone.weight, "note");
  const retired = await store.retirePurpose({ repo: REPO, actor: OUTSIDE, id: purpose, grounds: "役目を終えた" });
  assert.equal(retired.ok, true, retired.error);
  assert.match(stateCheck(null).find((f) => f.rule === "project-purpose").reason, /retired/);
  assert.ok(ctx.root);
});

// ---- AC-005: the completion candidate ----

async function withIssues(refs) {
  const ctx = setup();
  const purpose = await activePurpose();
  const id = await newProject(purpose, { state: "started" });
  await projects.attachIssues({ repo: REPO, actor: OUTSIDE, id, issues: refs });
  return { ...ctx, purpose, id };
}

const candidate = (actor = null) => projects.projectStatuses(REPO, actor)[0];

test("AC-005: no Issue, or an Issue still open, is no candidate", async () => {
  const { state, purpose } = await withIssues(["#1", "#2"]);
  assert.equal(candidate().completionCandidate, false);
  assert.equal(candidate().closedCount, 0);
  await newProject(purpose, { name: "空" });
  assert.equal(projects.projectStatuses(REPO, null).find((p) => p.name === "空").completionCandidate, false, "a Project with no Issue is never a candidate");
  // one closed, one open
  seedBacklog(state, [backlogRow("IDD-1", 1), backlogRow("IDD-2", 2)]);
  seedLifecycle(state, [{ event: "s4_land_issue_close_posted", idd_id: "IDD-1", at: "2026-10-26T02:00:00Z", attrs: { issue: "https://github.com/me/app/issues/1" } }]);
  assert.equal(candidate().completionCandidate, false);
  assert.equal(candidate().closedCount, 1);
});

test("AC-005: every Issue closed by a landing makes the Project a candidate, and the state does not move", async () => {
  const { state } = await withIssues(["#1", "#2"]);
  seedBacklog(state, [backlogRow("IDD-1", 1), backlogRow("IDD-2", 2)]);
  seedLifecycle(state, [
    { event: "s4_land_issue_close_posted", idd_id: "IDD-1", at: "2026-10-26T02:00:00Z", attrs: { issue: "https://github.com/me/app/issues/1" } },
    { event: "s4_land_issue_close_posted", idd_id: "IDD-2", at: "2026-10-26T02:01:00Z", attrs: { issue: "https://github.com/me/app/issues/2" } },
  ]);
  const p = candidate();
  assert.equal(p.completionCandidate, true);
  assert.deepEqual(p.issueStatuses.map((i) => [i.issue, i.closed, i.via, i.lane]), [["me/app#1", true, "landing", "IDD-1"], ["me/app#2", true, "landing", "IDD-2"]]);
  assert.equal(p.state, "started", "the candidate changes no state");
});

test("AC-005: an Issue closed by hand or in Linear counts once a person records it, and an ignored Issue stays open until then", async () => {
  const { state, id } = await withIssues(["#1", "APP-5", "#3"]);
  seedBacklog(state, [backlogRow("IDD-1", 1), backlogRow("IDD-5", 5, { gh_issue_url: null, linear_issue_url: "https://linear.app/t/issue/APP-5/x", source_type: "linear" })]);
  // #1 landed with its close posted; APP-5 was closed in Linear (the lane closes nothing there); #3 was ignored and has no lane
  seedLifecycle(state, [
    { event: "s4_land_issue_close_posted", idd_id: "IDD-1", at: "2026-10-26T02:00:00Z", attrs: { issue: "https://github.com/me/app/issues/1" } },
    { event: "lane_close", idd_id: "IDD-5", at: "2026-10-26T02:01:00Z", attrs: { outcome: "merged" } },
  ]);
  assert.equal(candidate().completionCandidate, false, "a landed Linear lane is not a closed Issue until a person says so");
  assert.deepEqual(candidate().issueStatuses.filter((i) => !i.closed).map((i) => i.issue), ["APP-5", "me/app#3"]);
  const linear = await projects.recordIssueState({ repo: REPO, actor: OUTSIDE, issue: "app-5", closed: true });
  assert.equal(linear.issue, "APP-5");
  assert.equal(candidate().completionCandidate, false, "the ignored Issue still holds it back");
  const hand = await projects.recordIssueState({ repo: REPO, actor: OUTSIDE, issue: "#3", closed: true });
  assert.equal(hand.ok, true, hand.error);
  const done = candidate();
  assert.equal(done.completionCandidate, true);
  assert.deepEqual(done.issueStatuses.map((i) => [i.issue, i.via]), [["me/app#1", "landing"], ["APP-5", "recorded"], ["me/app#3", "recorded"]]);
  // a person who sees the Issue open again says so, and the record wins over the landing
  await projects.recordIssueState({ repo: REPO, actor: OUTSIDE, issue: "#1", closed: false });
  assert.equal(candidate().completionCandidate, false);
  assert.equal(candidate().issueStatuses[0].closed, false);
  assert.ok(id);
});

test("AC-005: only a person closes a Project or records a close, and a candidate completes only by that word", async () => {
  const { id } = await withIssues(["#1"]);
  const lane = await projects.recordIssueState({ repo: REPO, actor: LANE, issue: "#1", closed: true });
  assert.match(lane.error, /lane の外/);
  assert.equal(candidate().completionCandidate, false, "a lane cannot make its own Project a candidate");
  for (const state of ["completed", "canceled"]) {
    const refused = await projects.updateProject({ repo: REPO, actor: LANE, id, patch: { state } });
    assert.match(refused.error, /lane の外/, state);
  }
  await projects.recordIssueState({ repo: REPO, actor: OUTSIDE, issue: "#1", closed: true });
  assert.equal(candidate().state, "started");
  assert.equal(candidate().completionCandidate, true);
  const done = await projects.updateProject({ repo: REPO, actor: OUTSIDE, id, patch: { state: "completed" } });
  assert.equal(done.ok, true, done.error);
  assert.equal(candidate().state, "completed");
  assert.equal(candidate().completionCandidate, false, "a Project a person closed is no candidate any more");
  const reopen = await projects.updateProject({ repo: REPO, actor: LANE, id, patch: { state: "started" } });
  assert.match(reopen.error, /開き直せる/);
  const bad = await projects.recordIssueState({ repo: REPO, actor: OUTSIDE, issue: "#1", closed: "yes" });
  assert.match(bad.error, /closed/);
});

test("AC-005: the candidate rule on its own, over the Issue statuses", () => {
  const closed = { issue: "a", closed: true };
  const open = { issue: "b", closed: false };
  assert.equal(completionCandidate({ state: "started" }, []), false);
  assert.equal(completionCandidate({ state: "started" }, [closed]), true);
  assert.equal(completionCandidate({ state: "started" }, [closed, open]), false);
  assert.equal(completionCandidate({ state: "completed" }, [closed]), false);
  assert.equal(completionCandidate({ state: "canceled" }, [closed]), false);
  const statuses = issueStatuses({ issues: ["a", "b"] }, { issueStates: [{ issue: "b", closed: true, at: "t", by: OUTSIDE }], landed: new Map([["a", "IDD-1"]]) });
  assert.deepEqual(statuses.map((s) => [s.issue, s.closed, s.via]), [["a", true, "landing"], ["b", true, "recorded"]]);
});

test("the fold reads the rows it is handed and nothing else", () => {
  const at = "2026-10-26T00:00:00Z";
  const rows = [
    { event: "project_raised", at, repo: REPO, by: OUTSIDE, id: "PRJ-1", name: "n", purpose: "P-1", done_when: "d", state: "planned" },
    { event: "project_issue_attached", at, repo: REPO, by: OUTSIDE, id: "PRJ-1", issues: ["me/app#1"] },
    { event: "project_issue_attached", at, repo: REPO, by: OUTSIDE, id: "PRJ-9", issues: ["me/app#2"] },
    { event: "project_decision_set", at, repo: REPO, by: OUTSIDE, id: "PRJ-1", decision: "PD-1-1", chosen: "c", why: "w", rejected: [] },
    { event: "something_else", at, repo: REPO, by: OUTSIDE, id: "PRJ-1" },
  ];
  const { projects: folded } = foldProjects(rows);
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].issues, ["me/app#1"], "an attach to a Project that is not there is dropped");
  assert.equal(folded[0].decisions.length, 1);
});

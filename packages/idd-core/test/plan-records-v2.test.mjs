/**
 * The v2 lane's plan records: the shape of the report, the engine's target check, the automatic GO's stop on a
 * draft supersede, the write after the GO (once per operation, idempotent), and the executor's contract.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import * as store from "../src/intent/store.ts";
import { normalizePlanRecords, checkPlanRecords, planTargets, readyPlanRecordsOf, PLAN_RECORDS_SHAPE } from "../src/agent/intent-impact.ts";
import { normalizeChoiceBody, normalizePlace } from "../src/intent/records.ts";
import { NO_INV_RULE, PLANNER_IMPACT_RULE_V2 } from "../src/plan/prompt-text.ts";
import { autoGoDecision } from "../src/plan/auto-go.ts";
import { executorBrief } from "../src/plan/exec.ts";
import { plannerBrief } from "../src/plan/prep.ts";
import { laneIntent } from "../src/plan/lane-intent.ts";
import { writeLanePurposesFile } from "../src/plan/plan-review.ts";
import { writeAcStatesFile } from "../src/plan/review-loop.ts";

let savedState;
beforeEach(() => { savedState = process.env.IDD_STATE_DIR; });
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
});

const REPO = "me/app";

function setup() {
  const root = scratchDir("plan-records-v2-");
  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: { "me/app": { upstream: join(root, "u"), work: join(root, "w"), public_base: "main" } } }));
  process.env.IDD_REPOS_FILE = join(root, "repos.yaml");
  return { root, state };
}

const seed = (state, iddId, event, attrs = {}, at = new Date().toISOString()) =>
  appendFileSync(join(state, "lifecycle-test.jsonl"), `${JSON.stringify({ event, idd_id: iddId, at, attrs })}\n`);

const rows = () => (existsSync(store.intentColumnPath(REPO)) ? readFileSync(store.intentColumnPath(REPO), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function activePurpose() {
  const r = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "S", origin: "O" });
  assert.equal(r.ok, true, r.error);
  return r.id;
}

const draft = (over = {}) => ({
  purpose: "P-1",
  forms: { chosen: "保存の前に確認を挟む", rejected: [{ form: "確認を省く", fails_because: "取り消せない削除が残る" }] },
  place: [{ path: "src/save.ts", kind: "file" }],
  why: "取り消せない削除を防ぐため。",
  anchored: "削除は確認を通ってから起きる。",
  ...over,
});

test("AC-008: the report's shape is refused before it is sent when a draft or a disposal is malformed", () => {
  assert.match(normalizePlanRecords({ paths: [], choices: [{ purpose: "P-1" }], existing: [] }).error, /choices\[0\]/);
  assert.equal("report" in normalizePlanRecords({ paths: [], choices: [], existing: [] }), true, "an empty report is a report");
  assert.match(normalizePlanRecords({ paths: [], choices: [draft()], existing: [{ id: "DEC-1", effect: "nope" }] }).error, /effect/);
  assert.match(normalizePlanRecords({ paths: [], choices: [draft()], existing: [{ id: "DEC-1", effect: "drop" }] }).error, /grounds/);
  // a Supersede row must match a draft's supersedes.ids, both ways
  assert.match(normalizePlanRecords({ paths: [], choices: [draft()], existing: [{ id: "DEC-9", effect: "supersede" }] }).error, /supersedes/);
  const ok = normalizePlanRecords({ paths: ["src/save.ts"], choices: [draft({ supersedes: { ids: ["DEC-9"], grounds: "Purpose が変わった" } })], existing: [{ id: "DEC-9", effect: "supersede" }] });
  assert.equal("report" in ok, true, JSON.stringify(ok));
});

test("AC-009 / AC-010: a Choice the paths pull with no disposal is refused, and the refusal names it", async () => {
  setup();
  const purpose = await activePurpose();
  const raised = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft() } });
  assert.equal(raised.ok, true, raised.error);
  const records = normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing: [] });
  const checked = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...records.report });
  assert.equal("error" in checked, true);
  assert.match(checked.error, new RegExp(raised.id));
  assert.match(checked.error, /idd intent lookup/);
  // a disposal for it passes
  const disposed = normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing: [{ id: raised.id, effect: "keep", reason: "why を保つ" }] });
  assert.equal("report" in checkPlanRecords({ lane: "IDD-1", repo: REPO, ...disposed.report }), true);
});

test("AC-011 / AC-012: a draft on a retired Purpose or a root Choice is refused", async () => {
  setup();
  const purpose = await activePurpose();
  const retired = await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: purpose, grounds: "g" });
  assert.equal(retired.ok, true, retired.error);
  const records = normalizePlanRecords({ paths: ["src/save.ts"], choices: [draft({ purpose: "P-1" })], existing: [] });
  assert.match(checkPlanRecords({ lane: "IDD-1", repo: REPO, ...records.report }).error, /purpose P-1/);

  const active = await activePurpose();
  const root = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { ...draft({ purpose: active, place: [{ path: "/", kind: "root" }] }) } });
  assert.equal(root.ok, true, root.error);
  const sup = normalizePlanRecords({ paths: ["src/save.ts"], choices: [draft({ purpose: active, supersedes: { ids: [root.id], grounds: "g" } })], existing: [{ id: root.id, effect: "supersede" }] });
  assert.match(checkPlanRecords({ lane: "IDD-1", repo: REPO, ...sup.report }).error, /root-supersede/);
});

test("AC-016: the automatic GO stops when a draft would supersede a dir Choice", () => {
  const records = { choices: [draft({ supersedes: { ids: ["C-1"], grounds: "g" } })], existing: [{ id: "C-1", effect: "supersede" }] };
  const events = [
    { event: "s1_ready", idd_id: "IDD-1", at: "2026-10-14T00:00:00Z", attrs: { plan_records: records } },
    { event: "s1_plan_review_done", idd_id: "IDD-1", at: "2026-10-14T00:01:00Z", attrs: {} },
  ];
  const choices = [{ id: "C-1", place: [{ path: "src", kind: "dir" }] }];
  const stop = autoGoDecision({ lane: "IDD-1", events, depth: "shallow", purposes: [], choices, rows: [] });
  assert.equal(stop.auto, false);
  assert.match(stop.reason, /Supersede/);
  // without the draft supersede the same lane is automatic
  const auto = autoGoDecision({ lane: "IDD-1", events: [{ ...events[0], attrs: { plan_records: { choices: [], existing: [] } } }, events[1]], depth: "shallow", purposes: [], choices, rows: [] });
  assert.equal(auto.auto, true, JSON.stringify(auto));
});

test("AC-017 / AC-018: the write after the GO is once per operation, and a second call adds nothing", async () => {
  const { state } = setup();
  const purpose = await activePurpose();
  const raised = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft({ place: [{ path: "src/old.ts", kind: "file" }], status: "unconfirmed" }) } });
  assert.equal(raised.ok, true, raised.error);
  seed(state, "IDD-1", "s1_ready", { records_shape: "state" }, "2026-10-14T00:00:00Z");

  const input = {
    repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T00:00:00Z",
    choices: [draft()],
    existing: [{ id: raised.id, effect: "confirm" }],
  };
  const first = await store.writePlanRecords(input);
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.written, [`existing:${raised.id}`, "choice:0"]);
  const after = rows().length;
  const second = await store.writePlanRecords(input);
  assert.equal(second.ok, true, second.error);
  assert.equal(rows().length, after, "a second call writes nothing");
  assert.deepEqual(second.skipped, []);
});

test("AC-018 / AC-019: a partial column is completed, and a disposal the state no longer allows is skipped with its reason", async () => {
  const { state } = setup();
  const purpose = await activePurpose();
  const confirmed = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft({ place: [{ path: "src/a.ts", kind: "file" }], status: "unconfirmed" }) } });
  const dropped = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft({ place: [{ path: "src/b.ts", kind: "file" }], status: "unconfirmed" }) } });
  assert.equal(confirmed.ok && dropped.ok, true);
  seed(state, "IDD-1", "s1_ready", { records_shape: "state" }, "2026-10-14T00:00:00Z");

  // the first pass writes one operation only; the column is left with part of the work done
  const base = { repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T00:00:00Z", choices: [] };
  const out = await store.writePlanRecords({ ...base, existing: [{ id: confirmed.id, effect: "confirm" }] });
  assert.equal(out.ok, true, out.error);
  const after = rows().length;
  // by the second pass another lane has dropped the second Choice: its disposal can no longer be written
  await store.dropChoice({ repo: REPO, actor: { session: "s9" }, id: dropped.id, grounds: "移行時の記録で現物と合わない" });
  const rerun = await store.writePlanRecords({
    ...base,
    existing: [{ id: confirmed.id, effect: "confirm" }, { id: dropped.id, effect: "drop", grounds: "移行時の記録で現物と合わない" }],
  });
  assert.equal(rerun.ok, true, rerun.error);
  assert.equal(rerun.written.includes(`existing:${confirmed.id}`), true, "the already-written operation is not written twice");
  assert.equal(rerun.skipped.some((s) => s.op === `existing:${dropped.id}`), true, JSON.stringify(rerun.skipped));
  assert.equal(rerun.done, true);
});

test("AC-013 / AC-014 / AC-015: the ready carries the drafts, the intent reader shows them, and a redraft replaces them", async () => {
  const { state } = setup();
  const purpose = await activePurpose();
  seed(state, "IDD-1", "s1_ready", { records_shape: "state", plan_records: { choices: [draft()], existing: [] } }, "2026-10-14T00:00:00Z");
  const rec = { idd_id: "IDD-1", area: REPO, title: "T", context: "" };
  const before = laneIntent(rec, { events: [{ event: "s1_ready", idd_id: "IDD-1", at: "2026-10-14T00:00:00Z", attrs: { records_shape: "state", plan_records: { choices: [draft()], existing: [] } } }] });
  assert.equal(before.decisions.length, 1);
  assert.match(before.decisions[0].id, /（予定）/);
  assert.equal(before.decisions[0].text, "保存の前に確認を挟む");

  // a second ready replaces the first drafts whole
  const redraft = { purpose, forms: { chosen: "別の形", rejected: [{ form: "元の形", fails_because: "Purpose を満たさない" }] }, place: [{ path: "src/save.ts", kind: "file" }], why: "w", anchored: "a" };
  const events = [
    { event: "s1_ready", idd_id: "IDD-1", at: "2026-10-14T00:00:00Z", attrs: { records_shape: "state", plan_records: { choices: [draft()], existing: [] } } },
    { event: "s1_ready", idd_id: "IDD-1", at: "2026-10-14T00:05:00Z", attrs: { records_shape: "state", plan_records: { choices: [redraft], existing: [] } } },
  ];
  assert.equal(readyPlanRecordsOf(events).choices.length, 1);
  const after = laneIntent(rec, { events });
  assert.deepEqual(after.decisions.map((d) => d.text), ["別の形"]);
});

test("AC-020 / AC-021 / AC-022 / AC-023: the v2 executor's brief carries Choices and the declare-as-you-change rules, and no Round", async () => {
  const { state, root } = setup();
  const wt = join(root, "wt");
  mkdirSync(wt, { recursive: true });
  const purpose = await activePurpose();
  const rec = { idd_id: "IDD-1", area: REPO, title: "T", context: "TODO task: Workspace-Feat-1-1" };
  const withRevisit = draft({ purpose, revisit: "後続の Issue「旧い保存の経路を消す」で本来の形に直す" });
  seed(state, "IDD-1", "s1_ready", { records_shape: "state", plan_records: { choices: [withRevisit], existing: [] } }, "2026-10-14T00:00:00Z");
  seed(state, "IDD-1", "s1_go", {}, "2026-10-14T00:10:00Z");
  const written = await store.writePlanRecords({ repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T00:00:00Z", choices: [withRevisit], existing: [] });
  assert.equal(written.ok, true, written.error);
  const skippedDraft = { ...draft({ purpose, revisit: "後続の Issue「未記載の経路を消す」" }), forms: { chosen: "未記載の応急処置" } };
  const skipped = [{ op: "existing:DEC-1", reason: "もう unconfirmed ではない" }, { op: "choice", reason: "書けなかった", draft: skippedDraft }];
  seed(state, "IDD-1", "s2_plan_written", { written: written.written, skipped }, "2026-10-14T00:11:00Z");

  const brief = executorBrief(rec, wt);
  assert.match(brief, /<choices>/);
  // a written Choice's revisit and an unwritten draft's reach the executor, so a follow-up Issue already planned is seen
  assert.deepEqual([...brief.matchAll(/<revisit>(.*?)<\/revisit>/g)].map((m) => m[1]), ["後続の Issue「未記載の経路を消す」", "後続の Issue「旧い保存の経路を消す」で本来の形に直す"]);
  assert.doesNotMatch(brief, /_docs\/intent\/me\/idd-1\/decision\.md/);
  assert.doesNotMatch(brief, /R2: PENDING/);
  assert.doesNotMatch(brief, /Intent Delta/);
  assert.doesNotMatch(brief, /qa\.md の Round は/);
  assert.match(brief, /idd intent raise choice --file F\.json/);
  assert.match(brief, /idd intent waive --kind applied --choice ID/);
  assert.match(brief, /idd intent waive --kind no-choice --reason R/);
  // a lane's call must not carry --session: the CLI refuses it, and the lane's id already comes from the environment
  assert.doesNotMatch(brief, /idd intent raise choice --session/);
  assert.doesNotMatch(brief, /idd intent waive --session/);
  assert.match(brief, /後からまとめない/);
  assert.match(brief, /unwritten-records/);
  assert.match(brief, /existing:DEC-1/);
  assert.match(brief, /ファイルは Read で開く/);
  assert.match(brief, /idd intent check/);
  // the source-TODO deletion condition is the v2 one: a round declaration, the checks, and evidenced ACs (AC-033)
  assert.match(brief, /巡の宣言（Choice の記録か Waive）/);
  assert.doesNotMatch(brief, /Intent Delta のある QA round を書き/);
  // the v2 executor numbers no INV, and its writing rules name the Choice's chosen form instead of DEC / INV headings
  assert.ok(brief.includes(NO_INV_RULE), "the v2 executor is told not to number an INV");
  assert.match(brief, /Choice の forms\.chosen・AC の見出し/);
  assert.doesNotMatch(brief, /DEC \/ AC \/ INV の見出し/);
});

test("AC-003 / AC-004 / AC-005 / AC-006 / AC-007: the v2 planner's brief drops decision.md and hands over the Choices and the report shape", () => {
  const { root } = setup();
  const wt = join(root, "wt");
  mkdirSync(wt, { recursive: true });
  const rec = { idd_id: "IDD-1", area: REPO, title: "T", context: "`src/save.ts` の確認を外す" };
  const brief = plannerBrief(rec, undefined, wt, undefined, "state");
  assert.doesNotMatch(brief, /<decision /);
  assert.match(brief, /<existing-choices/);
  assert.match(brief, /<candidate-purposes/);
  assert.match(brief, /idd intent lookup/);
  assert.match(brief, /idd intent raise purpose/);
  assert.match(brief, /--qa-count N --reference-count N/);
  assert.doesNotMatch(brief, /--dec-count/);
  assert.match(brief, /ファイルは Read で開く/);
  assert.match(brief, /"choices"/);
  // the announced rejected-form item names the field the checker reads (F-1)
  assert.ok(brief.includes('"rejected":[{"form":"...","fails_because":"..."}]'), "the announced shape names the field the checker reads");
  // the v1 brief keeps its own shape
  const v1 = plannerBrief(rec, undefined, wt);
  assert.match(v1, /<decision /);
  assert.match(v1, /--dec-count N --inv-count N/);
});

test("F-1: the report shape the brief and the refusal announce names the field the checker reads", () => {
  const base = { purpose: "P-1", forms: { chosen: "C", rejected: [{ form: "F", fails_because: "x" }] }, place: [{ path: "src/a.ts", kind: "file" }], why: "w", anchored: "a" };
  assert.equal(normalizeChoiceBody(base).ok, true);
  assert.equal(normalizeChoiceBody({ ...base, forms: { chosen: "C", rejected: [{ form: "F", reason: "x" }] } }).ok, false, "the checker does not read `reason`");
  const fieldNames = (shape) => {
    const m = /"rejected":\[\{([^}]*)\}\]/.exec(shape);
    assert.ok(m, `no rejected item in: ${shape}`);
    return [...m[1].matchAll(/"([a-z_]+)"\s*:/g)].map((x) => x[1]).sort();
  };
  const catalog = readFileSync(join(import.meta.dirname, "..", "..", "..", "_meta", "prompt-catalog", "01-planner.md"), "utf8");
  const catalogLine = catalog.split("\n").find((l) => l.includes('"rejected"'));
  assert.ok(catalogLine, "the catalog carries the v2 report shape");
  for (const shape of [PLANNER_IMPACT_RULE_V2[0], PLAN_RECORDS_SHAPE, catalogLine]) assert.deepEqual(fieldNames(shape), ["fails_because", "form"]);
});

test("F-3: the judgement's AC states are read from the lane's qa.md in its worktree", () => {
  const { state, root } = setup();
  const wt = join(root, "wt");
  mkdirSync(join(wt, "_docs", "qa", "app", "idd-1"), { recursive: true });
  writeFileSync(join(wt, "_docs", "qa", "app", "idd-1", "qa.md"), ["# QA", "", "- AC-001: 受け入れ条件", "- AC-002: もう一つの条件", ""].join("\n"));
  writeFileSync(join(state, "executor-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", executor_session_id: "E1", worktree_path: wt }) + "\n");
  const rec = { idd_id: "IDD-1", area: REPO, title: "T", context: "" };
  const file = writeAcStatesFile(rec, 1, "blind", []);
  assert.ok(file, "the AC states file is written from the worktree's qa.md");
  const body = readFileSync(file, "utf8");
  assert.match(body, /AC-001 \[planned\]: 受け入れ条件/);
  assert.match(body, /AC-002 \[planned\]: もう一つの条件/);
});

test("F-4: a lane cannot re-anchor a root Choice through the plan report", async () => {
  setup();
  const purpose = await activePurpose();
  const rootChoice = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: draft({ purpose, place: [{ path: "/", kind: "root" }] }) });
  assert.equal(rootChoice.ok, true, rootChoice.error);
  const existing = [{ id: rootChoice.id, effect: "reanchor", place: [{ path: "src/save.ts", kind: "file" }] }];
  // the report gate refuses it, the same as a direct reanchor
  const records = normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing });
  assert.equal("report" in records, true, JSON.stringify(records));
  const checked = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...records.report });
  assert.equal("error" in checked, true);
  assert.match(checked.error, new RegExp(rootChoice.id));
  assert.match(checked.error, /Re-anchor/);
  // the post-GO write does not move the root either
  const written = await store.writePlanRecords({ repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T00:00:00Z", choices: [], existing });
  assert.equal(written.ok, true, written.error);
  assert.deepEqual(written.written, [], "no reanchor row is written");
  assert.equal(written.skipped.some((s) => s.op === `existing:${rootChoice.id}`), true, JSON.stringify(written.skipped));
});

test("AC-016: a skipped operation keeps its own body so the executor can make it itself", async () => {
  const { state } = setup();
  const purpose = await activePurpose();
  seed(state, "IDD-1", "s1_ready", { records_shape: "state" }, "2026-10-14T00:00:00Z");
  // a draft whose Purpose no longer exists is skipped, and the draft is kept as it was reported
  const bad = draft({ purpose: "P-999" });
  const out = await store.writePlanRecords({ repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T00:00:00Z", choices: [bad], existing: [] });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].op, "choice:0");
  assert.deepEqual(out.skipped[0].draft, bad);
  // a disposal the state no longer allows keeps its line
  const raised = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft() } });
  assert.equal(raised.ok, true, raised.error);
  const drop = { id: raised.id, effect: "drop", grounds: "移行時の記録で現物と合わない" };
  const dropped = await store.writePlanRecords({ repo: REPO, lane: "IDD-1", readyAt: "2020-01-01T00:00:00Z", choices: [], existing: [drop] });
  assert.equal(dropped.ok, true, dropped.error);
  assert.deepEqual(dropped.skipped[0].existing, drop);
});

test("AC-001 / AC-002: an unconfirmed Choice outside the touched files is moved by the report and by the write after the GO, and stays unconfirmed", async () => {
  const { state } = setup();
  const purpose = await activePurpose();
  const stale = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft({ place: [{ path: "src/old.ts", kind: "file" }], anchored: "旧の本文", status: "unconfirmed" }) } });
  assert.equal(stale.ok, true, stale.error);
  const existing = [{ id: stale.id, effect: "reanchor", place: [{ path: "src/new.ts", kind: "file" }] }];
  const records = normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing });
  assert.equal("report" in records, true, JSON.stringify(records));
  const checked = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...records.report });
  assert.equal("report" in checked, true, JSON.stringify(checked));
  seed(state, "IDD-1", "s1_ready", { records_shape: "state" }, "2026-10-14T00:00:00Z");
  const written = await store.writePlanRecords({ repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T00:00:00Z", choices: [], existing });
  assert.equal(written.ok, true, written.error);
  assert.deepEqual(written.written, [`existing:${stale.id}`]);
  const rec = store.showRecord({ repo: REPO, actor: { lane: "IDD-1" }, id: stale.id }).record;
  assert.equal(rec.status, "unconfirmed");
  assert.deepEqual(rec.place, [{ path: "src/", kind: "module", file: "src/new.ts" }]);
  assert.equal(rec.anchored, "旧の本文");
  assert.equal(rec.history.at(-1).event, "re-anchored");
  // an anchored on the row of an unconfirmed Choice is refused at the report and skipped at the write
  const anchoredRow = [{ id: stale.id, effect: "reanchor", place: [{ path: "src/other.ts", kind: "file" }], anchored: "新しい本文" }];
  const refused = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing: anchoredRow }).report });
  assert.equal("error" in refused, true);
  assert.match(refused.error, /place だけ/);
  const skipped = await store.writePlanRecords({ repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T01:00:00Z", choices: [], existing: anchoredRow });
  assert.equal(skipped.ok, true, skipped.error);
  assert.deepEqual(skipped.written, []);
  assert.equal(skipped.skipped.some((s) => /place だけ/.test(s.reason)), true, JSON.stringify(skipped.skipped));
});

test("AC-003: the report lets an unconfirmed Choice outside the touched files be moved, and refuses that on a touched file", async () => {
  setup();
  const purpose = await activePurpose();
  const target = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft({ place: [{ path: "src/save.ts", kind: "file" }], status: "unconfirmed" }) } });
  const outside = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft({ place: [{ path: "src/old.ts", kind: "file" }], status: "unconfirmed" }) } });
  assert.equal(target.ok && outside.ok, true, target.error ?? outside.error);
  // a Choice the paths pull is the lane's to judge: its exits are confirm / drop / supersede, not a move
  const asTarget = normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing: [{ id: target.id, effect: "reanchor", place: [{ path: "src/moved.ts", kind: "file" }] }] });
  const refused = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...asTarget.report });
  assert.equal("error" in refused, true);
  assert.match(refused.error, /confirm \/ drop \/ supersede/);
  // the same effect is accepted on the Choice outside the touched files, once the target has its own disposal
  const ok = normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing: [{ id: target.id, effect: "confirm" }, { id: outside.id, effect: "reanchor", place: [{ path: "src/moved.ts", kind: "file" }] }] });
  assert.equal("report" in ok, true, JSON.stringify(ok));
  assert.equal("report" in checkPlanRecords({ lane: "IDD-1", repo: REPO, ...ok.report }), true);
});

test("AC-006: the planner's rules and the report's refusal guide the unconfirmed re-anchor", async () => {
  const { root } = setup();
  const wt = join(root, "wt");
  mkdirSync(wt, { recursive: true });
  const brief = plannerBrief({ idd_id: "IDD-1", area: REPO, title: "T", context: "" }, undefined, wt, undefined, "state");
  assert.match(brief, /触るファイルに当たる unconfirmed は confirm \/ drop \/ supersede/);
  assert.match(brief, /触るファイルの外の unconfirmed/);
  assert.match(brief, /anchored を書かない/);

  const purpose = await activePurpose();
  const target = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, ...draft({ place: [{ path: "src/save.ts", kind: "file" }], status: "unconfirmed" }) } });
  const records = normalizePlanRecords({ paths: ["src/save.ts"], choices: [], existing: [{ id: target.id, effect: "reanchor", place: [{ path: "src/moved.ts", kind: "file" }] }] });
  const refused = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...records.report });
  assert.equal("error" in refused, true);
  assert.match(refused.error, /confirm \/ drop \/ supersede/);
  assert.match(refused.error, /触るファイルの外/);
});

test("AC-007: a reanchor row whose place is not Place-shaped is refused at the report with the row's number", () => {
  for (const place of [[null], [{ kind: "file" }], [{ path: "/abs.ts", kind: "file" }], [{}]]) {
    const out = normalizePlanRecords({ paths: [], choices: [], existing: [{ id: "DEC-1", effect: "reanchor", place }] });
    assert.equal("error" in out, true, JSON.stringify(place));
    assert.match(out.error, /existing\[0\]（DEC-1）/);
  }
  const anchoredOnly = normalizePlanRecords({ paths: [], choices: [], existing: [{ id: "DEC-1", effect: "reanchor", anchored: "a" }] });
  assert.equal("report" in anchoredOnly, true, JSON.stringify(anchoredOnly));
  const ok = normalizePlanRecords({ paths: [], choices: [], existing: [{ id: "DEC-1", effect: "reanchor", place: [{ path: "src/a.ts", kind: "file" }] }] });
  assert.equal("report" in ok, true, JSON.stringify(ok));
});

test("AC-006: the plan review input carries each draft Purpose's statement and whether the lane raised it", async () => {
  const { state } = setup();
  const active = await activePurpose();
  const proposed = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-1" }, statement: "実装役が人に聞き返さずに着手できる", origin: "O" });
  assert.equal(proposed.ok, true, proposed.error);
  seed(state, "IDD-1", "s1_ready", { records_shape: "state", plan_records: { choices: [draft({ purpose: active })], existing: [] } }, "2026-10-14T00:00:00Z");

  const file = writeLanePurposesFile({ idd_id: "IDD-1", area: REPO }, "test");
  assert.ok(file, "the file is drawn");
  const text = readFileSync(file, "utf8");
  // an existing active Purpose a draft joins: its statement, and no claim that the lane raised it
  assert.match(text, new RegExp(`## ${active}（active）`));
  assert.match(text, /- statement: S/);
  assert.match(text, /- 連なる草案: 1/);
  // the lane's own Purpose draft: marked as its own, before the GO
  assert.match(text, new RegExp(`## ${proposed.id}（この lane の案）`));
  assert.match(text, /実装役が人に聞き返さずに着手できる/);
});

test("AC-006: a lane with no draft and no Purpose draft gets no review input file", async () => {
  setup();
  assert.equal(writeLanePurposesFile({ idd_id: "IDD-1", area: REPO }, "test"), undefined);
});

test("AC-008: a Purpose row written before `by` existed stops neither the report, the proposal list, nor the automatic GO", async () => {
  setup();
  const at = "2026-10-14T00:00:00Z";
  // the column's older writers left `by` out: the row is still effective, with no raiser to read
  appendFileSync(store.intentColumnPath(REPO), `${JSON.stringify({ event: "purpose_raised", at, repo: REPO, id: "P-9", statement: "S", origin: "O", status: "proposed" })}\n`);
  assert.deepEqual(store.proposedPurposesForLane(REPO, "IDD-1"), []);
  const records = normalizePlanRecords({ paths: [], choices: [draft({ purpose: "P-9" })], existing: [] });
  const checked = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...records.report });
  assert.equal("error" in checked, true);
  assert.match(checked.error, /P-9/);
  const purposes = store.listRecords({ repo: REPO, actor: { lane: "IDD-1" } }).purposes;
  const decision = autoGoDecision({
    lane: "IDD-1", purposes, choices: [], rows: [], depth: "shallow",
    events: [
      { event: "s1_ready", idd_id: "IDD-1", at, attrs: {} },
      { event: "s1_plan_review_done", idd_id: "IDD-1", at, attrs: {} },
    ],
  });
  assert.equal(decision.auto, true, JSON.stringify(decision));
});

// ---- Issue #181: the planner disposes of the file marks and dir Places, not of a whole module ----

test("AC-005: the disposal targets are the file marks and the dir Places, and a many-marked Choice is a Re-anchor candidate", async () => {
  const { root } = setup();
  const purpose = await activePurpose();
  const raised = async (id, place) => {
    const r = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: { purpose, id, status: "unconfirmed", forms: { chosen: `形 ${id}`, rejected: [{ form: "B", fails_because: "x" }] }, place, why: `なぜ ${id}`, anchored: "x" } });
    assert.equal(r.ok, true, r.error);
    return r.id;
  };
  const own = await raised("DEC-1", [{ path: "src/a.ts", kind: "file" }]);
  const sibling = await raised("DEC-2", [{ path: "src/b.ts", kind: "file" }]);
  const onDir = await raised("DEC-3", [{ path: "src/", kind: "dir" }]);
  // three marks: two files and a symbol
  const manyMarks = await raised("DEC-4", [{ path: "src/x.ts", kind: "file", symbols: ["runTick", "tick"] }, { path: "src/y.ts", kind: "file" }]);

  // the lookup hands the whole module over (the injection needs it for the headings), but the disposal is narrower
  const looked = store.lookupChoices({ repo: REPO, actor: null, paths: ["src/a.ts"] });
  assert.equal(looked.some((c) => c.id === sibling), true, "the same module's other file is in the lookup");
  assert.deepEqual(planTargets(REPO, "IDD-1", ["src/a.ts"]).map((t) => t.id), [own, onDir]);

  // a report that disposes of the file's own Choice and the dir's Choice goes through, without the sibling
  const report = normalizePlanRecords({ paths: ["src/a.ts"], choices: [], existing: [{ id: own, effect: "confirm" }, { id: onDir, effect: "confirm" }] });
  assert.equal("report" in report, true, JSON.stringify(report));
  const checked = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...report.report });
  assert.equal("report" in checked, true, JSON.stringify(checked));
  // and a report that leaves the dir's Choice out is refused, naming it
  const missing = checkPlanRecords({ lane: "IDD-1", repo: REPO, ...normalizePlanRecords({ paths: ["src/a.ts"], choices: [], existing: [{ id: own, effect: "confirm" }] }).report });
  assert.equal("error" in missing, true);
  assert.match(missing.error, new RegExp(onDir));

  // the planner's envelope list marks the Choice whose marks have piled up, and not one with fewer
  const wt = join(root, "wt");
  mkdirSync(wt, { recursive: true });
  const rec = { idd_id: "IDD-1", area: REPO, title: "T", context: "`src/a.ts` と `src/x.ts` を変える" };
  const brief = plannerBrief(rec, undefined, wt, undefined, "state");
  assert.ok(brief.includes(`〔Re-anchor の候補: 印 4 件〕`), JSON.stringify(brief.match(/DEC-4[^\\n]*/)));
  assert.equal(/DEC-1 \S+: なぜ DEC-1〔Re-anchor/.test(brief), false, "one file mark is not a candidate");
  assert.equal(brief.includes(`DEC-2`), false, "the same module's other file is not in the planner's disposal list");
});

test("AC-001: the conversion row names no Choice, so a lane does not read another's record as its own", async () => {
  setup();
  const purpose = await activePurpose();
  // a Choice the lane's outside raised, on a Place written in the older file form
  const outside = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: draft({ purpose, place: [{ path: "src/save.ts", kind: "file" }] }) });
  assert.equal(outside.ok, true, outside.error);
  const converted = await store.recordPlacesModule(REPO, "IDD-1");
  assert.equal(converted.ok, true, converted.error);
  assert.equal(converted.written, true);

  const rec = { idd_id: "IDD-1", area: REPO, title: "T", context: "" };
  const events = [
    { event: "s1_ready", idd_id: "IDD-1", at: "2026-10-14T00:00:00Z", attrs: { records_shape: "state", plan_records: { choices: [], existing: [] } } },
    { event: "s1_go", idd_id: "IDD-1", at: "2026-10-14T00:10:00Z", attrs: {} },
  ];
  // the conversion changed no reading and no history, so the outside's Choice is not listed as this lane's
  const outsideRec = store.showRecord({ repo: REPO, actor: { lane: "IDD-1" }, id: outside.id }).record;
  assert.deepEqual(outsideRec.history.map((h) => h.event), ["created"]);
  assert.deepEqual(laneIntent(rec, { events }).decisions, []);

  // the lane's own raise is listed, and only that one
  const mine = await store.raiseChoice({ repo: REPO, actor: { lane: "IDD-1" }, body: draft({ purpose }) });
  assert.equal(mine.ok, true, mine.error);
  assert.deepEqual(laneIntent(rec, { events }).decisions.map((d) => d.id), [mine.id]);
});

test("AC-006: a draft's verification rides through the report into the raised Choice", async () => {
  setup();
  const purpose = await activePurpose();
  const report = normalizePlanRecords({ paths: [], choices: [draft({ purpose, verification: ["tests/save.test.mjs", "AC-006"] })], existing: [] });
  assert.equal("report" in report, true, JSON.stringify(report));
  assert.deepEqual(report.report.choices[0].verification, ["tests/save.test.mjs", "AC-006"]);

  const written = await store.writePlanRecords({ repo: REPO, lane: "IDD-1", readyAt: "2026-10-14T00:00:00Z", choices: report.report.choices, existing: [] });
  assert.equal(written.ok, true, written.error);
  const raised = rows().find((r) => r.event === "choice_raised");
  assert.deepEqual(raised.verification, ["tests/save.test.mjs", "AC-006"]);
  // the lane sees its own record before the merge
  const rec = store.showRecord({ repo: REPO, actor: { lane: "IDD-1" }, id: raised.id }).record;
  assert.deepEqual(rec.verification, ["tests/save.test.mjs", "AC-006"]);

  // a malformed verification is refused at the report, the same way a raise reads it
  assert.match(normalizePlanRecords({ paths: [], choices: [draft({ purpose, verification: [1] })], existing: [] }).error, /verification/);
});

test("AC-006: the reported shape shows verification as the draft's own field, not inside a Place", () => {
  const shapes = { PLANNER_IMPACT_RULE_V2: PLANNER_IMPACT_RULE_V2[0], PLAN_RECORDS_SHAPE };
  for (const [name, shape] of Object.entries(shapes)) {
    const place = /"place":\[(\{[^}]*\})\]/.exec(shape);
    assert.ok(place, `${name} shows a place item`);
    assert.equal(/"verification"/.test(place[1]), false, `${name} keeps verification out of the place item`);
    assert.match(shape, /"verification":\[/, `${name} shows verification where the report reads it`);
  }
  // and the position the shape shows is the one the checker reads
  assert.equal(normalizeChoiceBody({ ...draft(), verification: ["tests/x.test.mjs"] }).value.verification[0], "tests/x.test.mjs");
  assert.deepEqual(
    normalizePlace({ path: "src/", kind: "module", file: "src/y.ts", verification: ["tests/x.test.mjs"] }).value,
    { path: "src/", kind: "module", file: "src/y.ts" },
    "a verification written inside a place is not a Place field and is dropped",
  );
});

test("AC-002: a Choice on a file at the top of the tree keeps its mark, so another file does not pull it", async () => {
  setup();
  const purpose = await activePurpose();
  const raised = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: draft({ purpose, place: [{ path: "package.json", kind: "file" }] }) });
  assert.equal(raised.ok, true, raised.error);
  assert.deepEqual(store.showRecord({ repo: REPO, actor: null, id: raised.id }).record.place, [{ path: "/", kind: "module", file: "package.json" }]);

  // its own file is the subject; another file of the repo's own module is a heading, not a disposal
  assert.deepEqual(planTargets(REPO, "IDD-1", ["package.json"]).map((t) => t.id), [raised.id]);
  assert.deepEqual(planTargets(REPO, "IDD-1", ["README.md"]), []);

  // a Re-anchor of that Place keeps the mark instead of widening it to the whole repo
  const moved = await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: raised.id, place: [{ path: "/", kind: "module", file: "package.json" }] });
  assert.equal(moved.ok, true, moved.error);
  assert.deepEqual(store.showRecord({ repo: REPO, actor: null, id: raised.id }).record.place, [{ path: "/", kind: "module", file: "package.json" }]);
});

test("AC-006: a draft on a withdrawn proposal is refused, a new proposal is accepted, and the withdrawn one does not come back", async () => {
  setup();
  const raise = async (statement) => {
    const r = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-1" }, statement, origin: "O" });
    assert.equal(r.ok, true, r.error);
    return r.id;
  };
  // the lane reports a draft whose Choice names the proposal
  const checkDraft = (id) => checkPlanRecords({ lane: "IDD-1", repo: REPO, ...normalizePlanRecords({ paths: ["src/save.ts"], choices: [draft({ purpose: id })], existing: [] }).report });
  const taken = await raise("計画役の文");
  assert.equal("error" in checkDraft(taken), false, "the lane's own proposal is a valid purpose before the withdrawal");

  const withdrawn = await store.withdrawPurposeProposal({ repo: REPO, lane: "IDD-1", by: { session: "inbox" }, id: taken, grounds: "出典に無い" });
  assert.equal(withdrawn.ok, true, withdrawn.error);
  assert.match(checkDraft(taken).error, new RegExp(`${taken}.*withdrawn`));

  const renewed = await raise("立て直した文");
  assert.notEqual(renewed, taken);
  assert.equal("error" in checkDraft(renewed), false);
  assert.deepEqual(store.proposedPurposesForLane(REPO, "IDD-1").map((p) => p.id), [renewed]);
});

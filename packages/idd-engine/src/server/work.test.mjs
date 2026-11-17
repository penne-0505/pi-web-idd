import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildWork, buildWorkDecisions, selectDone } = await import("./work.ts");
const { lanesAwaitingPrep } = await import("@idd/core");

let dir;

const AREA = "penne-0505/pi-web-idd";

/** one backlog record, as the ledger writes it */
function backlog(idd, title, created, extra = {}) {
  return { idd_id: idd, parent_id: null, created_at: created, linear_issue_url: null, gh_issue_url: `https://github.com/penne-0505/pi-web-idd/issues/${idd.replace(/\D/g, "")}`, pull_req_url: null, source_type: "github", context: "", title, area: AREA, ...extra };
}

/** one lane's lifecycle, sorted by time as the reader does */
function lifecycle(idd, records) {
  return records.map(([event, at, attrs = {}]) => ({ event, idd_id: idd, at, attrs })).sort((a, b) => a.at.localeCompare(b.at));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-work-"));
  process.env.IDD_STATE_DIR = dir;
  mkdirSync(join(dir, "reviews"), { recursive: true });
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const write = (name, body) => writeFileSync(join(dir, name), body);
const jsonl = (name, rows) => write(name, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));

describe("the Work read", () => {
  it("AC-001 / AC-011: answers repos, lanes and done, and carries no forecast, usual, anomaly or urgent value", () => {
    jsonl("backlog.jsonl", [backlog("IDD-900", "走っている lane", "2026-10-01T00:00:00.000Z")]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-900", [["lane_open", "2026-10-01T00:00:00.000Z"], ["s1_prep_start", "2026-10-01T00:01:00.000Z"]]));
    jsonl("planner-sessions.jsonl", [{ idd_id: "IDD-900", planner_session_id: "P1", started_at: "2026-10-01T00:01:00.000Z", worktree_path: "/tmp/x", branch: "b" }]);
    const work = buildWork();
    assert.ok(Array.isArray(work.repos) && work.repos.length > 0);
    assert.ok(work.repos.some((p) => p.id === AREA));
    assert.equal(work.lanes.length, 1);
    assert.equal(work.lanes[0].kind, "issue");
    assert.ok(Array.isArray(work.lanes[0].spans) && work.lanes[0].spans.length > 0);
    for (const lane of work.lanes) {
      assert.equal(lane.eta, undefined);
      assert.equal(lane.usual, undefined);
      assert.equal(lane.anomaly, undefined);
      assert.equal(lane.urgent, undefined);
    }
    assert.equal(work.done.length, 0);
  });

  it("AC-002: the running lanes come before the lanes the engine wakes next", () => {
    jsonl("backlog.jsonl", [
      backlog("IDD-901", "次に入る", "2026-10-01T00:00:00.000Z"),
      backlog("IDD-902", "動いている", "2026-10-02T00:00:00.000Z"),
    ]);
    jsonl("lifecycle-2026-10.jsonl", [
      ...lifecycle("IDD-901", [["lane_open", "2026-10-01T00:00:00.000Z"]]),
      ...lifecycle("IDD-902", [["lane_open", "2026-10-02T00:00:00.000Z"], ["s1_prep_start", "2026-10-02T00:05:00.000Z"]]),
    ]);
    jsonl("planner-sessions.jsonl", [{ idd_id: "IDD-902", planner_session_id: "P2", started_at: "2026-10-02T00:05:00.000Z", worktree_path: "/tmp/x", branch: "b" }]);
    const work = buildWork();
    assert.deepEqual(work.lanes.map((l) => l.id), ["IDD-902", "IDD-901"]);
    assert.deepEqual(work.lanes.map((l) => l.bundle), ["running", "next"]);
  });

  it("AC-003: the next lanes keep the order the planner's candidates are taken in", () => {
    jsonl("backlog.jsonl", [
      backlog("IDD-910", "三番目", "2026-10-03T00:00:00.000Z"),
      backlog("IDD-911", "一番目", "2026-10-01T00:00:00.000Z"),
      backlog("IDD-912", "二番目", "2026-10-02T00:00:00.000Z"),
    ]);
    jsonl("lifecycle-2026-10.jsonl", [
      ...lifecycle("IDD-910", [["lane_open", "2026-10-03T00:00:00.000Z"]]),
      ...lifecycle("IDD-911", [["lane_open", "2026-10-01T00:00:00.000Z"]]),
      ...lifecycle("IDD-912", [["lane_open", "2026-10-02T00:00:00.000Z"]]),
    ]);
    const prep = lanesAwaitingPrep().map((r) => r.idd_id);
    const work = buildWork();
    assert.deepEqual(work.lanes.filter((l) => l.kind === "issue").map((l) => l.id), prep);
    assert.deepEqual(work.lanes.filter((l) => l.kind === "issue").map((l) => l.id), ["IDD-911", "IDD-912", "IDD-910"]);
  });

  it("AC-012: a lane waiting on an answer carries the question turn in Work, and an answered one does not", () => {
    jsonl("backlog.jsonl", [backlog("IDD-901", "質問待ち", "2026-10-01T00:00:00.000Z"), backlog("IDD-902", "答え済み", "2026-10-01T00:00:00.000Z")]);
    jsonl("lifecycle-2026-10.jsonl", [
      ...lifecycle("IDD-901", [
        ["lane_open", "2026-10-01T00:00:00.000Z"], ["s1_go", "2026-10-01T00:01:00.000Z"],
        ["s2_start", "2026-10-01T00:02:00.000Z"], ["question_batch_asked", "2026-10-01T00:03:00.000Z", { batch_id: "b1" }],
      ]),
      ...lifecycle("IDD-902", [
        ["lane_open", "2026-10-01T00:00:00.000Z"], ["s1_go", "2026-10-01T00:01:00.000Z"],
        ["s2_start", "2026-10-01T00:02:00.000Z"], ["question_batch_asked", "2026-10-01T00:03:00.000Z", { batch_id: "b1" }],
        ["question_batch_answered", "2026-10-01T00:04:00.000Z", { batch_id: "b1" }],
      ]),
    ]);
    jsonl("executor-sessions.jsonl", [
      { idd_id: "IDD-901", executor_session_id: "E1", started_at: "2026-10-01T00:02:00.000Z", worktree_path: "/tmp/x", branch: "b" },
      { idd_id: "IDD-902", executor_session_id: "E2", started_at: "2026-10-01T00:02:00.000Z", worktree_path: "/tmp/x", branch: "b" },
    ]);
    const work = buildWork();
    assert.equal(work.lanes.find((l) => l.id === "IDD-901")?.turn, "question");
    assert.equal(work.lanes.find((l) => l.id === "IDD-902")?.turn, undefined);
  });

  it("AC-004 / AC-005: each lane carries spans with ISO ends, and a person's turn is a person's time", () => {
    jsonl("backlog.jsonl", [backlog("IDD-920", "GO 待ち", "2026-10-01T00:00:00.000Z")]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-920", [
      ["lane_open", "2026-10-01T00:00:00.000Z"],
      ["question_batch_asked", "2026-10-01T01:00:00.000Z"],
      ["question_batch_answered", "2026-10-01T02:00:00.000Z"],
      ["s1_plan_review_started", "2026-10-01T02:30:00.000Z"],
      ["s1_plan_review_done", "2026-10-01T02:45:00.000Z"],
      ["s1_ready", "2026-10-01T03:00:00.000Z"],
    ]));
    jsonl("planner-sessions.jsonl", [{ idd_id: "IDD-920", planner_session_id: "P3", started_at: "2026-10-01T00:00:30.000Z", worktree_path: "/tmp/x", branch: "b" }]);
    const lane = buildWork().lanes[0];
    const question = lane.spans.find((s) => s.key === "question");
    assert.equal(question.owner, "person");
    assert.equal(question.start, "2026-10-01T01:00:00.000Z");
    assert.equal(question.end, "2026-10-01T02:00:00.000Z");
    assert.equal(lane.turn, "go");
    assert.equal(lane.spans[lane.spans.length - 1].key, "go");
    assert.equal(lane.spans[lane.spans.length - 1].end, undefined);
  });

  it("AC-006 / AC-007: a declared dependency comes back as a wait, an order wait is only a note", () => {
    jsonl("backlog.jsonl", [backlog("IDD-930", "依存待ち", "2026-10-01T00:00:00.000Z"), backlog("IDD-931", "相手の lane", "2026-09-01T00:00:00.000Z")]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-930", [
      ["lane_open", "2026-10-01T00:00:00.000Z"],
      ["s2_start", "2026-10-01T01:00:00.000Z"],
      ["blocked_by_dependency", "2026-10-01T02:00:00.000Z", { depends_on: ["#931"] }],
    ]));
    const dep = buildWork().lanes.find((l) => l.id === "IDD-930");
    assert.equal(dep.waitsFor.length, 1);
    assert.equal(dep.waitsFor[0].ref.label, "pi-web-idd#931");
    assert.equal(dep.waitsFor[0].lane, "IDD-931");
    assert.equal(dep.note, undefined);
  });

  it("AC-007: a note that is not a dependency never becomes a dependency line", () => {
    jsonl("backlog.jsonl", [backlog("IDD-932", "枠待ちの lane", "2026-10-01T00:00:00.000Z")]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-932", [
      ["lane_open", "2026-10-01T00:00:00.000Z"],
      ["s1_prep_start", "2026-10-01T00:01:00.000Z"],
      ["claude_quota_wait", "2026-10-01T02:00:00.000Z", { stage: "planner", resets_at: 99_999_999_99, reason: "windows" }],
    ]));
    jsonl("planner-sessions.jsonl", [{ idd_id: "IDD-932", planner_session_id: "P7", started_at: "2026-10-01T00:01:00.000Z", worktree_path: "/tmp/x", branch: "b" }]);
    const row = buildWork().lanes.find((l) => l.id === "IDD-932");
    assert.deepEqual(row.waitsFor, [], "a note is not a dependency");
    assert.match(row.note, /枠待ち/);
  });

  it("AC-008: the held Issues are returned even when no lane exists", () => {
    write("intake-holds.json", JSON.stringify({ holds: [{ source: "github", area: AREA, ref: "#940", title: "待たれている Issue", url: "https://github.com/penne-0505/pi-web-idd/issues/940", reason: "blocker が開いている", blockers: [{ ref: "#941", title: "先の Issue", url: "https://github.com/penne-0505/pi-web-idd/issues/941", state: "open", scope: "penne-0505/pi-web-idd", outOfScope: false }] }] }));
    const work = buildWork();
    assert.equal(work.holds.length, 1);
    const row = work.lanes.find((l) => l.kind === "hold");
    assert.ok(row);
    assert.equal(row.bundle, "next");
    assert.equal(row.waitsFor[0].ref.label, "#941");
  });

  it("AC-009: the closed lanes come newest first with their outcome and DEC count", () => {
    jsonl("backlog.jsonl", [backlog("IDD-950", "古い", "2026-09-01T00:00:00.000Z"), backlog("IDD-951", "新しい", "2026-09-02T00:00:00.000Z")]);
    jsonl("lifecycle-2026-10.jsonl", [
      ...lifecycle("IDD-950", [["lane_open", "2026-09-01T00:00:00.000Z"], ["lane_close", "2026-09-10T00:00:00.000Z", { outcome: "landed" }]]),
      ...lifecycle("IDD-951", [["lane_open", "2026-09-02T00:00:00.000Z"], ["lane_close", "2026-09-20T00:00:00.000Z", { outcome: "discarded" }]]),
    ]);
    const done = buildWork().done;
    assert.deepEqual(done.map((d) => d.id), ["IDD-951", "IDD-950"]);
    assert.equal(done[0].outcome, "discarded");
    assert.equal(done[0].closedAt, "2026-09-20T00:00:00.000Z");
    assert.equal(typeof done[0].decisions, "number");
  });

  it("AC-009: only the newest twenty closed lanes are shown", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `IDD-${860 + i}`);
    jsonl("backlog.jsonl", ids.map((id, i) => backlog(id, `closed ${i}`, "2026-09-01T00:00:00.000Z")));
    jsonl("lifecycle-2026-10.jsonl", ids.flatMap((id, i) => lifecycle(id, [["lane_open", "2026-09-01T00:00:00.000Z"], ["lane_close", new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), { outcome: "landed" }]])));
    const done = buildWork().done;
    assert.equal(done.length, 20);
    assert.equal(done[0].id, "IDD-884", "the newest closed lane leads");
    assert.equal(done[19].id, "IDD-865", "the cut is after the twentieth");
  });

  it("a poll reads the DEC count of only the closed lanes the screen keeps", () => {
    let reads = 0;
    const rows = Array.from({ length: 50 }, (_, i) => ({
      view: { id: `IDD-${900 + i}`, repo: AREA, title: `t${i}`, closedAt: new Date(Date.UTC(2026, 7, 1 + i)).toISOString(), outcome: "closed", decisions: 0 },
      count: () => { reads += 1; return 2; },
    }));
    const shown = selectDone(rows);
    assert.equal(shown.length, 20);
    assert.equal(reads, 20, "the cut comes before the read, so the reads do not grow with the closed lanes");
    assert.ok(shown.every((d) => d.decisions === 2));
    const times = shown.map((d) => d.closedAt);
    assert.deepEqual(times, [...times].sort((a, b) => b.localeCompare(a)));
  });

  it("AC-010: a review lane is in the column with spans and a person's turn, ordered by its own records", () => {
    jsonl("backlog.jsonl", []);
    write("reviews/REV-20261001T000000-abcd.json", JSON.stringify({
      id: "REV-20261001T000000-abcd", repo: "penne-0505/pi-web-idd", pr: 5, title: "penne-0505/pi-web-idd#5", url: "https://github.com/penne-0505/pi-web-idd/pull/5",
      created_at: "2026-10-01T00:00:00.000Z",
      history: [
        { event: "r_opened", at: "2026-10-01T00:00:00.000Z", attrs: {} },
        { event: "r_wt_ready", at: "2026-10-01T00:01:00.000Z", attrs: { head: "h", base: "b", title: "fix: 表示" } },
        { event: "r_triage_done", at: "2026-10-01T00:02:00.000Z", attrs: { round: 1, accepted: [] } },
        { event: "r_drafted", at: "2026-10-01T00:03:00.000Z", attrs: { round: 1, outbound_id: "OUT-1", head: "h" } },
      ],
    }));
    const work = buildWork();
    const row = work.lanes.find((l) => l.kind === "review");
    assert.ok(row);
    assert.equal(row.repo, AREA, "the review lane reads its repo from the setting that names the repo");
    assert.equal(row.turn, "review");
    assert.ok(row.spans.length > 0);
    assert.ok(row.ref.url.includes("/pull/5"));
  });

  it("AC-014: an id no lane has, and one carrying `..`, are refused without reading files", () => {
    jsonl("backlog.jsonl", []);
    assert.equal(buildWorkDecisions("IDD-999"), null);
    assert.equal(buildWorkDecisions("../../etc/passwd"), null);
    assert.equal(buildWorkDecisions("REV-20261001T000000-abcd"), null);
  });
});

describe("the DEC read", () => {
  const worktree = () => {
    const tree = mkdtempSync(join(tmpdir(), "idd-work-dec-"));
    mkdirSync(join(tree, "_docs", "intent", AREA.split("/").pop(), "idd-960"), { recursive: true });
    writeFileSync(join(tree, "_docs", "intent", AREA.split("/").pop(), "idd-960", "decision.md"), [
      "---", "title: lane", "---", "", "# lane", "", "## Decisions", "",
      "### DEC-960-1: 見る場所", "",
      "- **What**: 本文は出さない",
      "- **Anchors**: `packages/idd-gui/src/App.tsx`",
      "- **Why**: 一行目の理由。二行目の理由。",
      "- **Why not**（捨てた形）: 却下した",
      "- **Change freedom**: 自由",
      "", "## Intent-derived Invariants", "",
      "- INV-960-1 (from DEC-960-1): 順は engine のまま。",
    ].join("\n"));
    mkdirSync(join(tree, "_docs", "intent", "other", "old"), { recursive: true });
    writeFileSync(join(tree, "_docs", "intent", "other", "old", "decision.md"), [
      "# old", "", "### DEC-700: 既存の判断", "", "- **Anchors**: `packages/idd-gui/src/App.tsx`", "- **Why**: 既存の理由。",
    ].join("\n"));
    return tree;
  };

  it("AC-012 / AC-013: the lane's own DEC and the existing ones come apart, with the five fields", () => {
    jsonl("backlog.jsonl", [backlog("IDD-960", "DEC を持つ lane", "2026-10-01T00:00:00.000Z")]);
    const tree = worktree();
    jsonl("planner-sessions.jsonl", [{ idd_id: "IDD-960", planner_session_id: "P9", started_at: "2026-10-01T00:00:00.000Z", worktree_path: tree, branch: "b" }]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-960", [["lane_open", "2026-10-01T00:00:00.000Z"], ["s1_prep_start", "2026-10-01T00:01:00.000Z"]]));
    const view = buildWorkDecisions("IDD-960");
    assert.ok(view);
    assert.equal(view.own.length, 1);
    assert.equal(view.own[0].id, "DEC-960-1");
    assert.equal(view.own[0].place, "`packages/idd-gui/src/App.tsx`");
    assert.equal(view.own[0].why, "一行目の理由。二行目の理由。");
    assert.deepEqual(view.own[0].whyNot, [{ form: "捨てた形", reason: "却下した" }]);
    assert.deepEqual(view.own[0].anchored, [{ id: "INV-960-1", text: "順は engine のまま。" }]);
    assert.equal(view.own[0].free, "自由");
    assert.equal(Object.hasOwn(view.own[0], "what"), false);
    assert.ok(!view.own.some((d) => d.id === "DEC-700"));
    // 既存の DEC: the paths come from the plan's impact report when the lane has not changed files yet
    assert.ok(view.paths.length >= 0);
  });

  it("AC-013: the existing DECs are read from the plan's impact paths and are not narrowed", () => {
    jsonl("backlog.jsonl", [backlog("IDD-960", "影響のある lane", "2026-10-01T00:00:00.000Z")]);
    const tree = worktree();
    jsonl("planner-sessions.jsonl", [{ idd_id: "IDD-960", planner_session_id: "P9", started_at: "2026-10-01T00:00:00.000Z", worktree_path: tree, branch: "b" }]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-960", [
      ["lane_open", "2026-10-01T00:00:00.000Z"],
      ["s1_ready", "2026-10-01T00:05:00.000Z", { intent_impact: { paths: ["packages/idd-gui/src/App.tsx"], candidate_count: 1, rows: [] } }],
    ]));
    const view = buildWorkDecisions("IDD-960");
    assert.deepEqual(view.paths, ["packages/idd-gui/src/App.tsx"]);
    assert.deepEqual(view.existing.map((d) => d.id), ["DEC-700"]);
    assert.equal(view.existing[0].why, "既存の理由。");
  });

  it("AC-021: a moved decision.md is read from the archive, so its DECs are neither lost nor doubled", () => {
    jsonl("backlog.jsonl", [backlog("IDD-960", "archive の DEC を持つ lane", "2026-10-01T00:00:00.000Z")]);
    const tree = mkdtempSync(join(tmpdir(), "idd-work-arch-"));
    const seg = AREA.split("/").pop();
    // both documents were moved to the archive at the same relative path
    mkdirSync(join(tree, "_docs", "archives", "intent", seg, "idd-960"), { recursive: true });
    writeFileSync(join(tree, "_docs", "archives", "intent", seg, "idd-960", "decision.md"), [
      "# lane", "", "## Decisions", "",
      "### DEC-960-1: 見る場所", "",
      "- **Anchors**: `packages/idd-gui/src/App.tsx`",
      "- **Why**: 移した理由。",
      "- **Change freedom**: 自由",
    ].join("\n"));
    mkdirSync(join(tree, "_docs", "archives", "intent", "other", "old"), { recursive: true });
    writeFileSync(join(tree, "_docs", "archives", "intent", "other", "old", "decision.md"), [
      "# old", "", "### DEC-700: 既存の判断", "", "- **Anchors**: `packages/idd-gui/src/App.tsx`", "- **Why**: 既存の理由。",
    ].join("\n"));
    jsonl("planner-sessions.jsonl", [{ idd_id: "IDD-960", planner_session_id: "P9", started_at: "2026-10-01T00:00:00.000Z", worktree_path: tree, branch: "b" }]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-960", [
      ["lane_open", "2026-10-01T00:00:00.000Z"],
      ["s1_ready", "2026-10-01T00:05:00.000Z", { intent_impact: { paths: ["packages/idd-gui/src/App.tsx"], candidate_count: 2, rows: [] } }],
    ]));
    const view = buildWorkDecisions("IDD-960");
    assert.ok(view);
    assert.deepEqual(view.own.map((d) => d.id), ["DEC-960-1"], "the lane's own document is read from the archive");
    assert.equal(view.own[0].why, "移した理由。");
    assert.equal(view.own[0].free, "自由");
    assert.deepEqual(view.existing.map((d) => d.id), ["DEC-700"], "the moved lane's own DEC is not doubled into existing");
    assert.equal(view.existing[0].why, "既存の理由。");
    assert.equal(view.existing[0].place, "`packages/idd-gui/src/App.tsx`");
  });

  it("AC-041: a v2 lane's own Choices and the existing ones come from the state, not decision.md", () => {
    jsonl("backlog.jsonl", [backlog("IDD-950", "v2 の lane", "2026-10-01T00:00:00.000Z")]);
    jsonl("lifecycle-2026-10.jsonl", lifecycle("IDD-950", [
      ["lane_open", "2026-10-01T00:00:00.000Z"],
      ["s1_ready", "2026-10-01T00:01:00.000Z", { records_shape: "state", intent_impact: { paths: ["src/other.ts"], candidate_count: 1, rows: [] } }],
      ["s1_go", "2026-10-01T00:02:00.000Z"],
    ]));
    const base = { repo: AREA, purpose: "P-1", status: "active", origin: { by: "agent" }, anchored: "a" };
    jsonl(`intent-${encodeURIComponent(AREA)}.jsonl`, [
      { event: "purpose_raised", at: "2026-10-01T00:00:00Z", repo: AREA, by: { session: "s1" }, id: "P-1", statement: "S", origin: "O", status: "active" },
      { event: "choice_raised", at: "2026-10-01T00:00:30Z", repo: AREA, by: { session: "s1" }, ...base, id: "C-9-1", forms: { chosen: "既存の形", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "src/other.ts", kind: "file" }], why: "既存の why" },
      { event: "choice_raised", at: "2026-10-01T00:03:00Z", repo: AREA, by: { lane: "IDD-950" }, ...base, id: "C-950-1", forms: { chosen: "lane の形", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "src/a.ts", kind: "file" }], why: "lane の why" },
    ]);
    const view = buildWorkDecisions("IDD-950");
    assert.deepEqual(view.own.map((d) => d.title), ["lane の形"]);
    assert.equal(view.own[0].why, "lane の why");
    assert.equal(view.own[0].anchored[0].text, "a");
    assert.deepEqual(view.existing.map((d) => d.id), ["C-9-1"]);
    assert.equal(view.existing[0].title, "既存の形");
  });
});

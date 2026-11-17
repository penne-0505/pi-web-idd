import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;

function goCard(events, intentRows = []) {
  dir = mkdtempSync(join(tmpdir(), "idd-state-planrev-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" }) + "\n");
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), events.map(([event, attrs = {}]) => JSON.stringify({ idd_id: "IDD-1", event, at: "2026-09-25T00:00:00Z", attrs })).join("\n") + "\n");
  // a lane's own purpose column row: the raiser is the row's `by`, the same field the write side reads
  if (intentRows.length) writeFileSync(join(dir, "intent-Demo.jsonl"), intentRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return buildState().items.find((i) => i.kind === "go");
}

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the GO card's plan review", () => {
  it("names which role raised each finding, and which run broke", () => {
    const card = goCard([
      ["lane_open"], ["s1_ready"], ["s1_plan_review_started", { run_ids: ["A", "B"] }],
      ["s1_plan_review_done", {
        run_ids: ["A", "B"], must: 1, should: 0, nit: 0,
        findings: [{ severity: "must", path: "a.ts", claim: "購読が残る", source: "pa,pb" }],
        runs: [{ run_id: "A", role: "pa", model: "x/a", must: 1, should: 0, nit: 0 }, { run_id: "B", role: "pb", model: "x/b", failed: true, error: "provider 400" }],
      }],
      ["s1_ready"], ["s1_plan_review_started", { run_ids: ["A", "B"] }],
      ["s1_plan_review_done", {
        run_ids: ["A", "B"], must: 1, should: 0, nit: 0, sent_back: true,
        findings: [{ severity: "must", path: "a.ts", claim: "購読が残る", source: "pa,pb" }],
        runs: [{ run_id: "A", role: "pa", model: "x/a", must: 1, should: 0, nit: 0 }, { run_id: "B", role: "pb", model: "x/b", failed: true, error: "provider 400" }],
      }],
      ["s1_ready"],
    ]);
    assert.ok(card);
    assert.equal(card.planReview.state, "reviewed");
    assert.equal(card.planReview.addressed, undefined);
    assert.deepEqual(card.planReview.findings.map((f) => [f.claim, f.source]), [["購読が残る", "pa,pb"]]);
    assert.deepEqual(card.planReview.runs, [{ role: "pa", model: "x/a", failed: false }, { role: "pb", model: "x/b", failed: true, error: "provider 400" }]);
  });

  it("lists each round with its counts and its must / should, and asks for a reason once the rounds are spent", () => {
    const must = { severity: "must", path: "a.ts", claim: "購読が残る" };
    const should = { severity: "should", path: "b.ts", claim: "順序" };
    const nit = { severity: "nit", path: "", claim: "言い回し" };
    const card = goCard([
      ["lane_open"], ["s1_ready"], ["s1_plan_review_started", { run_ids: ["A"] }],
      ["s1_plan_review_done", { must: 1, should: 1, nit: 1, sent_back: true, findings: [must, should, nit] }],
      ["s1_ready"], ["s1_plan_review_started", { run_ids: ["B"] }],
      ["s1_plan_review_done", { must: 1, should: 0, nit: 0, sent_back: true, findings: [must] }],
      ["s1_ready"],
    ]);
    assert.ok(card);
    assert.deepEqual(card.planReview.rounds.map((r) => [r.must, r.should, r.nit]), [[1, 1, 1], [1, 0, 0]]);
    // a nit is a count only; the must / should a round left are listed
    assert.deepEqual(card.planReview.rounds[0].findings.map((f) => f.claim), ["購読が残る", "順序"]);
    assert.equal(card.planReview.needsReason, true);
  });

  it("opens the GO card after a clean second round with that round last, and no reason asked", () => {
    const card = goCard([
      ["lane_open"], ["s1_ready"], ["s1_plan_review_started", { run_ids: ["A"] }],
      ["s1_plan_review_done", { must: 1, should: 0, nit: 0, sent_back: true, findings: [{ severity: "must", path: "", claim: "c" }] }],
      ["s1_ready"], ["s1_plan_review_started", { run_ids: ["B"] }],
      ["s1_plan_review_done", { must: 0, should: 0, nit: 0, sent_back: false, findings: [] }],
    ]);
    assert.deepEqual(card.planReview.rounds.map((r) => r.must), [1, 0]);
    assert.equal(card.planReview.needsReason, undefined);
  });

  it("asks for the reason when the last review failed or was skipped after a round that raised a must", () => {
    const first = [
      ["lane_open"], ["s1_ready"], ["s1_plan_review_started", { run_ids: ["A"] }],
      ["s1_plan_review_done", { must: 1, should: 0, nit: 0, sent_back: true, findings: [{ severity: "must", path: "", claim: "c" }] }],
      ["s1_ready"], ["s1_plan_review_started", { run_ids: ["B"] }],
    ];
    const failed = goCard([...first, ["s1_plan_review_done", { failed: true, error: "x" }], ["s1_ready"]]);
    assert.equal(failed.planReview.state, "failed");
    assert.equal(failed.planReview.needsReason, true);
    const skipped = goCard([...first, ["s1_plan_review_skipped", { reason: "r" }], ["s1_ready"]]);
    assert.equal(skipped.planReview.state, "skipped");
    assert.equal(skipped.planReview.needsReason, true);
  });

  it("does not count a round from before penne's send-back", () => {
    const card = goCard([
      ["lane_open"], ["s1_ready"], ["s1_plan_review_started", { run_ids: ["A"] }], ["s1_plan_review_done", { must: 0, should: 0, nit: 0 }],
      ["s1_revise_requested", { instruction: "x" }], ["s1_ready"], ["s1_plan_review_started", { run_ids: ["B"] }], ["s1_plan_review_done", { must: 0, should: 1, nit: 0, sent_back: false, findings: [] }],
    ]);
    assert.equal(card.planReview.rounds.length, 1);
  });

  it("keeps the runs of a review whose every run failed", () => {
    const card = goCard([
      ["lane_open"], ["s1_ready"], ["s1_plan_review_started", { run_ids: ["A"] }],
      ["s1_plan_review_done", { failed: true, error: "pa: e", runs: [{ run_id: "A", role: "pa", failed: true, error: "e" }] }],
    ]);
    assert.equal(card.planReview.state, "failed");
    assert.deepEqual(card.planReview.runs, [{ role: "pa", failed: true, error: "e" }]);
  });

  it("reads a review recorded before the runs were listed", () => {
    const card = goCard([["lane_open"], ["s1_ready"], ["s1_plan_review_started", { run_id: "L" }], ["s1_plan_review_done", { run_id: "L", must: 0, should: 0, nit: 2, findings: [] }]]);
    assert.equal(card.planReview.state, "reviewed");
    assert.deepEqual(card.planReview.runs, []);
  });
});

describe("the GO card's depth", () => {
  it("shows the declared depth and why a shallow lane was left to a person (AC-024)", () => {
    const card = goCard([
      ["lane_open"], ["s1_ready", { depth: "shallow" }], ["question_batch_asked", { batch_id: "b1" }],
      ["s1_plan_review_started", { run_ids: ["A"] }], ["s1_plan_review_done", { must: 0 }],
    ]);
    assert.ok(card);
    assert.equal(card.depth, "shallow");
    assert.match(card.notAuto, /質問/);
  });

  it("shows a deeper lane's depth and no reason, since a person presses those GOes anyway (AC-024)", () => {
    const card = goCard([
      ["lane_open"], ["s1_ready", { depth: "deep" }],
      ["s1_plan_review_started", { run_ids: ["A"] }], ["s1_plan_review_done", { must: 0 }],
    ]);
    assert.equal(card.depth, "deep");
    assert.equal(card.notAuto, undefined);
  });

  it("shows why a shallow lane that raised a Purpose of its own was left to a person (AC-020, AC-024)", () => {
    const events = [
      ["lane_open"], ["s1_ready", { depth: "shallow" }],
      ["s1_plan_review_started", { run_ids: ["A"] }], ["s1_plan_review_done", { must: 0 }],
    ];
    const row = { event: "purpose_raised", at: "2026-09-25T00:00:00Z", repo: "Demo", by: { lane: "IDD-1" }, id: "P-2", statement: "S", origin: "O", status: "proposed" };
    assert.match(goCard(events, [row]).notAuto, /Purpose/);
    // a Purpose raised by a session outside the lane does not hold the GO
    assert.equal(goCard(events, [{ ...row, by: { session: "s1" } }]).notAuto, undefined);
  });
});

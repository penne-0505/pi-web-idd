import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { NOW, putLane, stateDirPerTest } = await import("../../test/fixtures/state-fixture.mjs");

// The stuck card of a stopped lane carries the shape judge's recommendation among the answers (C-252-3): the five
// answers are on the card, the recommendation sits in the same item, and a stop outside the review loop has none.

const fixture = stateDirPerTest("idd-state-shape-");
const put = (events) => putLane(fixture.dir, "IDD-1", "止まった lane", events);

const STOPPED = [
  ["lane_open"], ["s1_ready", { depth: "deep" }], ["s1_plan_review_done", { must: 0, should: 0, nit: 0 }], ["s1_go"], ["s2_start", { started_from_commit: "c0" }],
  ["s2_result", { outcome: "success", changed_files: ["a.ts"] }],
  ["s2_triage_done", { kind: "blind", round: 1, accepted: [{ severity: "must", path: "a.ts", claim: "x", action: "fix" }], escalated_claims: [] }],
  ["s2_review_escalated", { reason: "修正が上限に達した" }],
];
const RECOMMENDATION = { choice: "replan", reasons: [{ kind: "file", ref: "a.ts", text: "a.ts が名指された" }], shape: "持ち主を 1 つにする" };

const JUDGED = ["s2_shape_judged", { round: 1, trigger: "escalated", run_id: "J1", recommendation: RECOMMENDATION }];

const stuckOf = () => buildState({ now: NOW }).items.find((i) => i.kind === "stuck");

describe("the stuck card's recommendation", () => {
  it("AC-003: the card of a stopped lane carries the recommendation beside the five answers", () => {
    put([...STOPPED, JUDGED]);
    const item = stuckOf();
    assert.deepEqual(item.recommendation, RECOMMENDATION);
    assert.ok(item.onContinue && item.onContinueWithNote && item.onAccept && item.onHandFix && item.onReplan, "the four answers it always had, and the replan");
  });

  it("AC-009: a judge that did not run leaves the card with its answers and no recommendation", () => {
    put([...STOPPED, ["s2_shape_judged", { round: 1, trigger: "escalated", unavailable: true, reason: "枠" }]]);
    const item = stuckOf();
    assert.equal(item.recommendation, undefined);
    assert.ok(item.onContinue && item.onReplan);
    put(STOPPED);
    assert.equal(stuckOf().recommendation, undefined);
  });

  it("AC-003: a stop for the budget carries no recommendation", () => {
    put([...STOPPED, JUDGED, ["lane_over_budget", { cost: 12, limit: 10, parts: [] }]]);
    const item = stuckOf();
    assert.ok(item.budget);
    assert.equal(item.recommendation, undefined);
  });

  it("AC-003: an answered stop's recommendation does not reach the next card", () => {
    put([...STOPPED, JUDGED, ["s2_review_resumed", { decision: "continue" }]]);
    assert.equal(stuckOf()?.recommendation, undefined);
  });
});

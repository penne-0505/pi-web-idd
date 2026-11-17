/**
 * The submit review of a lane whose record still holds R2 and kept-check results from before R2 was removed
 * (2026-10-22): the review reads those events without error and shows no R2 row, and the rest of the card is
 * derived as for any lane.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSubmitReview } from "../src/plan/ship.ts";

const at = (n) => `2026-10-14T00:${String(n).padStart(2, "0")}:00Z`;
const keptTriage = (n, accepted) => ({ event: "s2_triage_done", idd_id: "IDD-1", at: at(n), attrs: { kind: "kept", accepted } });

test("a lane's past R2 and kept results are read without an R2 row on the card", () => {
  for (const shape of [{ records_shape: "state" }, {}]) {
    const review = buildSubmitReview([
      { event: "s1_ready", idd_id: "IDD-1", at: at(0), attrs: shape },
      { event: "s2_review_started", idd_id: "IDD-1", at: at(1), attrs: { kind: "kept" } },
      keptTriage(2, [{ ref: "F-1", severity: "must", claim: "記録に why が無い" }]),
      { event: "s3_kept_recorded", idd_id: "IDD-1", at: at(3), attrs: { run_id: "r1", files: ["a"], commit: "c" } },
      { event: "s3_r2_done", idd_id: "IDD-1", at: at(4), attrs: { must: 1, should: 2, nit: 0, findings: [] } },
      { event: "s3_r2_skipped", idd_id: "IDD-1", at: at(5), attrs: { reason: "記録が変わりません" } },
    ]);
    assert.equal("r2" in review, false);
    assert.ok(Array.isArray(review.followups));
  }
});

test("AC-006: the submit card carries the round's routes and their questions and harms, and the over-cap sign", () => {
  const routes = [
    { id: "R-1", paths: ["lib/a.dart", "lib/view.dart"], question: "見せている値と送る値が同じ", harms: ["shown_vs_sent"] },
    { id: "R-2", paths: ["lib/b.dart"], question: "判断が外に漏れない", harms: ["authority"] },
  ];
  const review = buildSubmitReview([
    { event: "s1_ready", idd_id: "IDD-1", at: at(0), attrs: {} },
    { event: "s2_map_done", idd_id: "IDD-1", at: at(1), attrs: { kind: "blind", round: 1, routes } },
    { event: "s2_review_started", idd_id: "IDD-1", at: at(2), attrs: { kind: "blind", round: 1, run_ids: ["a", "b", "c"], mapped_routes: 2, route_count: 2 } },
  ]);
  assert.equal(review.routes.count, 2);
  assert.equal(review.routes.overCap, false);
  assert.deepEqual(review.routes.items[0], { paths: ["lib/a.dart", "lib/view.dart"], question: "見せている値と送る値が同じ", harms: ["shown_vs_sent"] });
  // a round that brought more routes than the cap carries the over-cap sign: the lane itself is not stopped
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `R-${i + 1}`, paths: [`lib/r${i + 1}.dart`], question: `問い ${i + 1}`, harms: ["authority"] }));
  const over = buildSubmitReview([
    { event: "s1_ready", idd_id: "IDD-1", at: at(0), attrs: {} },
    { event: "s2_map_done", idd_id: "IDD-1", at: at(1), attrs: { kind: "blind", round: 1, routes: many } },
    { event: "s2_review_started", idd_id: "IDD-1", at: at(2), attrs: { kind: "blind", round: 1, run_ids: Array.from({ length: 9 }, (_, i) => `r${i}`), mapped_routes: 8, route_count: 9, routes_over_cap: true } },
  ]);
  assert.equal(over.routes.count, 9);
  assert.equal(over.routes.overCap, true);
});

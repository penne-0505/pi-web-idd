import { describe, expect, test } from "bun:test";

import { planReviewStartArgs } from "../src/server/agent-runner.ts";

/**
 * The port's caller sets the lane's record shape for a v2 lane's plan review. The engine's adapter must carry it to
 * `startPlanReviews`: rebuilding the options field by field once dropped `recordsShape` and sent a v1 task (which
 * asks about decision.md) to a v2 lane, so its draft Choices were never reviewed before the GO.
 */
describe("the plan review start the engine hands the lane", () => {
  test("carries a v2 lane's record shape, and every other field, to the lane", () => {
    const args = planReviewStartArgs({ iddId: "IDD-119", worktree: "/wt", inputs: ["c.md"], attempt: 2, roles: 2, norms: ["n"], iddNorms: ["i"], recordsShape: "state" });
    expect(args).toEqual({ iddId: "IDD-119", worktree: "/wt", inputs: ["c.md"], attempt: 2, roles: 2, norms: ["n"], iddNorms: ["i"], recordsShape: "state" });
  });

  test("leaves the record shape out for a v1 lane, and only what is absent", () => {
    const args = planReviewStartArgs({ iddId: "IDD-119", worktree: "/wt", inputs: ["d.md"], attempt: 1 });
    expect("recordsShape" in args).toBe(false);
    expect("roles" in args).toBe(false);
    expect("norms" in args).toBe(false);
    expect(args).toEqual({ iddId: "IDD-119", worktree: "/wt", inputs: ["d.md"], attempt: 1 });
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

const saved = process.env.IDD_STATE_DIR;
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
let dir;

function backlog(id) {
  return { idd_id: id, parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: `${id} の題名`, area: "Demo" };
}
const ev = (id, event, attrs = {}, at = "2026-09-25T00:00:00Z") => ({ idd_id: id, event, at, attrs });
const basis = (ref, claim) => ({ ref, severity: "should", claim, path: "a.ts", fix: "f", action: "fix", fix_basis: "halt", impact: "engine が止まる" });
const follow = (ref, claim) => ({ ref, severity: "should", claim, path: "b.ts", action: "followup" });

/** a lane whose one judgement accepted one basis-shown fix and one follow-up */
function laneEvents(id, at) {
  return [
    ev(id, "s2_result", {}, at),
    ev(id, "s2_review_started", { kind: "blind", round: 1, run_ids: ["B"], head: "h", close_on: "must_and_fix" }, at),
    ev(id, "s2_triage_done", { kind: "blind", round: 1, accepted: [basis(`${id}-F-1`, `${id} の害`), follow(`${id}-F-2`, `${id} の後続`)] }, at),
  ];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-should-fix-"));
  process.env.IDD_STATE_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("the lane-by-lane should / fix-recommended counts", () => {
  it("keeps the 20 latest lanes, sums them, and reads the ratio from the totals", () => {
    const ids = Array.from({ length: 21 }, (_, i) => `IDD-${i + 1}`);
    writeFileSync(join(dir, "backlog.jsonl"), jsonl(ids.map(backlog)));
    // lane 21 is the newest judgement; lane 1 (the oldest) falls outside the last 20
    const at = (i) => `2026-09-25T00:00:${String(i).padStart(2, "0")}Z`;
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl(ids.flatMap((id, i) => laneEvents(id, at(i + 1)))));
    const view = buildState().shouldFix;
    assert.equal(view.lanes.length, 20);
    assert.equal(view.lanes.some((r) => r.lane === "IDD-1"), false, "the oldest lane is left out");
    assert.equal(view.lanes[0].lane, "IDD-21", "the latest judgement comes first");
    assert.deepEqual(view.lanes[0], { lane: "IDD-21", accepted: 2, fix: 1, fixWithoutBasis: 0, at: at(21) });
    assert.deepEqual(view.total, { accepted: 40, fix: 20, fixWithoutBasis: 0, ratio: 0.5 });
  });

  it("counts a finding named again as one item, and a basis-shown fix wins over a read-back one", () => {
    writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1")]));
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
      ev("IDD-1", "s2_result", {}, "2026-09-25T00:00:01Z"),
      ev("IDD-1", "s2_review_started", { kind: "blind", round: 1, run_ids: ["B"], head: "h", close_on: "must_and_fix" }, "2026-09-25T00:00:01Z"),
      ev("IDD-1", "s2_triage_done", { kind: "blind", round: 1, accepted: [basis("F-1", "同じ指摘")] }, "2026-09-25T00:00:01Z"),
      // the final review names it again, this time read back as a follow-up: one item, still on the fix side
      ev("IDD-1", "s2_review_started", { kind: "final", round: 2, run_ids: ["F"], head: "h" }, "2026-09-25T00:00:02Z"),
      ev("IDD-1", "s2_triage_done", { kind: "final", round: 2, accepted: [{ ref: "F-2", severity: "should", claim: "同じ指摘", path: "a.ts", action: "followup", claimed_action: "fix" }] }, "2026-09-25T00:00:02Z"),
    ]));
    const view = buildState().shouldFix;
    assert.deepEqual(view.lanes[0], { lane: "IDD-1", accepted: 1, fix: 1, fixWithoutBasis: 0, at: "2026-09-25T00:00:02Z" });
    assert.equal(view.total.ratio, 1);
  });

  it("leaves out a lane whose only judgements are on PR feedback, and one with no judgement at all", () => {
    writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1"), backlog("IDD-2")]));
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
      ev("IDD-1", "s4_review_comment_received", { files: ["/f.md"] }, "2026-09-25T00:00:01Z"),
      ev("IDD-1", "s2_triage_done", { kind: "feedback", round: 1, accepted: [basis("C-1", "レビュアーの依頼")] }, "2026-09-25T00:00:01Z"),
      ev("IDD-2", "s1_go", {}, "2026-09-25T00:00:02Z"),
    ]));
    const view = buildState().shouldFix;
    assert.deepEqual(view.lanes, []);
    assert.deepEqual(view.total, { accepted: 0, fix: 0, fixWithoutBasis: 0 });
  });

  it("counts a read-back fix with no basis apart from the basis-shown ones", () => {
    writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1")]));
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
      ev("IDD-1", "s2_result", {}, "2026-09-25T00:00:01Z"),
      ev("IDD-1", "s2_review_started", { kind: "blind", round: 1, run_ids: ["B"], head: "h", close_on: "must_and_fix" }, "2026-09-25T00:00:01Z"),
      ev("IDD-1", "s2_triage_done", { kind: "blind", round: 1, accepted: [
        basis("F-1", "基準あり"), { ref: "F-2", severity: "should", claim: "基準なし", path: "b.ts", action: "followup", claimed_action: "fix" },
      ] }, "2026-09-25T00:00:01Z"),
    ]));
    const view = buildState().shouldFix;
    assert.deepEqual(view.lanes[0], { lane: "IDD-1", accepted: 2, fix: 1, fixWithoutBasis: 1, at: "2026-09-25T00:00:01Z" });
    assert.equal(view.total.ratio, 0.5);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { resetBlockerStateCache } = await import("../../../idd-core/src/ledger/blockers.ts");

let dir;

/** the blocker is a Linear Issue: the engine has no tracker read for it, so the recorded state stands unless its lane landed */
const blocker = (state = "open") => ({ ref: "APP-9", title: "the premise", url: "https://linear.app/x/issue/APP-9", state, scope: "APP", outOfScope: false });

const row = (idd, over = {}) => ({ idd_id: idd, parent_id: null, created_at: "2026-10-18T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: `lane ${idd}`, area: "Demo", ...over });
const ev = (idd, event, min, attrs = {}) => ({ idd_id: idd, event, at: new Date(Date.parse("2026-10-18T00:00:00Z") + min * 60_000).toISOString(), attrs });
const atGo = (idd) => [ev(idd, "lane_open", 0), ev(idd, "s1_ready", 1, { depth: "standard" }), ev(idd, "s1_plan_review_done", 2, { must: 0 })];

function state(rows, events) {
  dir = mkdtempSync(join(tmpdir(), "idd-state-blockers-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return buildState();
}

afterEach(() => {
  resetBlockerStateCache();
  delete process.env.IDD_STATE_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the GO card of a lane whose blocker has not landed", () => {
  it("shows what the lane waits for in place of the GO", () => {
    const s = state(
      [row("IDD-1", { source_type: "linear", linear_issue_url: "https://linear.app/x/issue/APP-9", title: "the premise" }), row("IDD-2", { gh_issue_url: "https://github.com/o/r/issues/3", blockers: [blocker()] })],
      [ev("IDD-1", "lane_open", 0), ...atGo("IDD-2")],
    );
    const go = s.items.find((i) => i.kind === "go" && i.iddId === "IDD-2");
    assert.ok(go, "the lane is at GO");
    assert.match(go.blockedBy.reason, /APP-9/);
    assert.deepEqual(go.blockedBy.items, [{ ref: "APP-9", title: "the premise", url: "https://linear.app/x/issue/APP-9", state: "open", lane: "IDD-1" }]);
  });

  it("is the usual GO card once the blocker's lane landed, and for a lane without recorded blockers", () => {
    const s = state(
      [row("IDD-1", { source_type: "linear", linear_issue_url: "https://linear.app/x/issue/APP-9" }), row("IDD-2", { gh_issue_url: "https://github.com/o/r/issues/3", blockers: [blocker()] }), row("IDD-3", { gh_issue_url: "https://github.com/o/r/issues/4" })],
      [ev("IDD-1", "lane_open", 0), ev("IDD-1", "s4_land_merged", 5, { merge_commit: "abc" }), ...atGo("IDD-2"), ...atGo("IDD-3")],
    );
    for (const id of ["IDD-2", "IDD-3"]) {
      const go = s.items.find((i) => i.kind === "go" && i.iddId === id);
      assert.ok(go, `${id} is at GO`);
      assert.equal(go.blockedBy, undefined);
    }
  });
});

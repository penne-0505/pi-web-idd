import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;

const held = (ref) => ({
  source: "github",
  area: "Demo",
  ref,
  title: `title ${ref}`,
  url: `https://github.com/o/r/issues/${ref.replace("#", "")}`,
  reason: "開いた blocker があります（#9）",
  blockers: [{ ref: "#9", title: "blocker", url: "https://github.com/o/r/issues/9", state: "open", scope: "o/r", outOfScope: false }],
});

function state({ backlog = true, holds } = {}) {
  dir = mkdtempSync(join(tmpdir(), "idd-state-holds-"));
  process.env.IDD_STATE_DIR = dir;
  if (backlog) {
    writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: "https://github.com/o/r/issues/3", pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" }) + "\n");
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), JSON.stringify({ idd_id: "IDD-1", event: "lane_open", at: "2026-09-25T00:00:00Z", attrs: {} }) + "\n");
  }
  if (holds !== undefined) writeFileSync(join(dir, "intake-holds.json"), typeof holds === "string" ? holds : JSON.stringify({ updated_at: "2026-09-26T00:00:00Z", holds }));
  return buildState();
}

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the dependency waits in the state", () => {
  it("shows the held Issues and their blockers next to the lanes", () => {
    const s = state({ holds: [held("#1")] });
    assert.deepEqual(s.holds.map((h) => [h.ref, h.reason]), [["#1", "開いた blocker があります（#9）"]]);
    assert.deepEqual(s.holds[0].blockers.map((b) => [b.ref, b.state]), [["#9", "open"]]);
  });

  it("shows them even when no lane exists (the early return)", () => {
    const s = state({ backlog: false, holds: [held("#1")] });
    assert.equal(s.lanes.length, 0);
    assert.deepEqual(s.holds.map((h) => h.ref), ["#1"]);
  });

  it("shows nothing for a missing or unreadable file", () => {
    assert.deepEqual(state({}).holds, []);
    assert.deepEqual(state({ holds: "{not json" }).holds, []);
  });
});

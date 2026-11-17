import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");

let dir;

/** three lanes taken in, the first one's planner running, and the planner capped at one */
function setup() {
  dir = mkdtempSync(join(tmpdir(), "idd-state-slotwait-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "roles.yaml"), "roles:\n  r: { model: x/y }\npipeline:\n  planner: { role: r, concurrency: 1 }\n");
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  const ids = ["IDD-1", "IDD-2", "IDD-3"];
  writeFileSync(join(dir, "backlog.jsonl"), ids.map((id, i) => JSON.stringify({ idd_id: id, parent_id: null, created_at: `2026-09-25T0${i}:00:00Z`, linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: id, area: "Demo" })).join("\n") + "\n");
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), ids.map((id, i) => JSON.stringify({ idd_id: id, event: "lane_open", at: `2026-09-25T0${i}:00:00Z`, attrs: {} })).join("\n") + "\n");
  writeFileSync(join(dir, "planner-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", planner_session_id: "P1", worktree_path: join(dir, "none") }) + "\n");
}

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_ROLES_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the waits for a stage's cap", () => {
  it("are on the heading of the group the stage's lanes are listed under", () => {
    setup();
    const prep = buildState().sections.find((s) => s.group === "prep");
    assert.equal(prep.running, 1);
    assert.equal(prep.cap, 1);
    assert.equal(prep.wait.count, 2);
    assert.ok(prep.wait.longestMin > 0);
    assert.equal(buildState().sections.find((s) => s.group === "impl").wait, undefined);
  });

  it("are on the detail of a lane held back, and not on the lane that holds the slot", async () => {
    setup();
    const held = await buildLaneDetail("IDD-3");
    assert.equal(held.slotWait.label, "下調べ");
    assert.equal(held.slotWait.cap, 1);
    assert.ok(held.slotWait.minutes > 0);
    assert.equal((await buildLaneDetail("IDD-1")).slotWait, undefined);
  });

  it("show the executor's count only on a lane that holds or waits for the executor's slot", async () => {
    setup();
    const lane = (id, evs) => appendFileSync(join(dir, "lifecycle-Demo.jsonl"), evs.map(([event, at, attrs = {}]) => JSON.stringify({ idd_id: id, event, at, attrs })).join("\n") + "\n");
    lane("IDD-2", [["s1_ready", "2026-09-25T03:00:00Z"], ["s1_go", "2026-09-25T03:10:00Z"], ["s2_start", "2026-09-25T03:20:00Z"], ["s2_result", "2026-09-25T04:00:00Z"]]);
    lane("IDD-3", [["s1_ready", "2026-09-25T03:00:00Z"], ["s1_go", "2026-09-25T03:10:00Z"]]);
    appendFileSync(join(dir, "executor-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-2", executor_session_id: "E2", worktree_path: join(dir, "none") }) + "\n");
    const inLoop = await buildLaneDetail("IDD-2");
    assert.equal(inLoop.group, "impl");
    assert.equal(inLoop.concurrency, undefined, "a lane in the review loop no longer holds the executor's slot");
    const awaiting = await buildLaneDetail("IDD-3");
    assert.equal(awaiting.concurrency.cap, 1);
  });

  it("leave the detail as it was when they cannot be counted", async () => {
    setup();
    // a broken review lane store: counting the waits fails, the detail does not
    writeFileSync(join(dir, "roles.yaml"), "roles:\n  r: { model: x/y }\npipeline:\n  planner: { role: r, concurrency: 1 }\n  review_blind: { roles: [r], concurrency: 1 }\n");
    writeFileSync(join(dir, "reviews"), "not a directory");
    const d = await buildLaneDetail("IDD-3");
    assert.equal(d.iddId, "IDD-3");
    assert.equal(d.slotWait, undefined);
    assert.equal(d.concurrency.cap, 1);
  });
});

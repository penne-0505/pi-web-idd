import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildLaneDetail, buildState } = await import("./state.ts");
const { readLifecycle, reviewRounds } = await import("@idd/core");

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
let dir;

const backlog = (id, title) => ({ idd_id: id, parent_id: null, created_at: "2026-10-01T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title, area: "Demo" });

function setup(events) {
  writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1", "巡の lane"), backlog("IDD-2", "記録なし")]));
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
    ...events.map((ev) => ({ idd_id: "IDD-1", ...ev })),
    { idd_id: "IDD-2", event: "lane_open", at: "2026-10-05T01:00:00Z", attrs: {} },
  ]));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-rounds-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  writeFileSync(process.env.IDD_ROLES_FILE, "roles:\n  r: { model: x/y }\npipeline:\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ev = (event, attrs = {}, at = "2026-10-05T02:00:00Z") => ({ event, at, attrs });

describe("the rounds of the review loop", () => {
  it("AC-003: the lane row and the lane detail return the same rows", async () => {
    setup([
      ev("s2_result", { outcome: "success" }),
      ev("s2_triage_done", { kind: "blind", round: 1, accepted: [{ ref: "F-1", severity: "must", claim: "m", path: "a.ts" }] }),
      ev("s2_fix_sent", { round: 1, refs: ["F-1"] }),
      ev("s2_confirm_done", { round: 1, unresolved_refs: [] }),
      ev("s2_triage_done", { kind: "final", round: 2, accepted: [] }),
    ]);
    const expected = reviewRounds(readLifecycle().filter((e) => e.idd_id === "IDD-1"));
    assert.deepEqual(expected.map((r) => [r.round, r.kind, r.must, r.open]), [[1, "blind", 1, 0], [2, "final", 0, 0]]);
    const row = buildState().lanes.find((l) => l.iddId === "IDD-1");
    assert.deepEqual(row.reviewRounds, expected);
    const detail = await buildLaneDetail("IDD-1");
    assert.deepEqual(detail.reviewRounds, expected);
  });

  it("AC-003: a lane with no review records gets an empty list", async () => {
    setup([ev("lane_open", {}, "2026-10-05T01:00:00Z")]);
    const row = buildState().lanes.find((l) => l.iddId === "IDD-2");
    assert.deepEqual(row.reviewRounds, []);
    const detail = await buildLaneDetail("IDD-2");
    assert.deepEqual(detail.reviewRounds, []);
  });
});

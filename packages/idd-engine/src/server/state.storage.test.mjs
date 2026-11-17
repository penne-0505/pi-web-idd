import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;
afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(minFreeGb, withLane) {
  dir = mkdtempSync(join(tmpdir(), "idd-state-storage-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
  writeFileSync(join(dir, "repos.yaml"), JSON.stringify({ storage: { cleanup: false, min_free_gb: minFreeGb }, repos: {} }));
  if (withLane) {
    writeFileSync(join(dir, "backlog.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "IDD-1", area: "Demo" })}\n`);
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", event: "lane_open", at: "2026-09-25T00:00:00Z", attrs: {} })}\n`);
  }
  return dir;
}

const cards = (state) => state.items.filter((i) => i.kind === "storage");

describe("the low-space card in the state", () => {
  it("is one card when the free space is below the threshold (AC-028)", () => {
    setup(999999, true);
    const found = cards(buildState());
    assert.equal(found.length, 1);
    assert.equal(found[0].iddId, undefined);
    assert.equal(found[0].cleanup, false);
    assert.equal(found[0].minFreeGb, 999999);
    assert.ok(found[0].freeBytes > 0);
    assert.ok(found[0].totalBytes >= found[0].freeBytes);
  });

  it("is there with the sweep off and with no lane at all (AC-028)", () => {
    setup(999999, false);
    // the early return when the backlog is empty still carries the card
    assert.equal(cards(buildState()).length, 1);
  });

  it("is gone once the space is back (AC-029)", () => {
    setup(0, true);
    assert.equal(cards(buildState()).length, 0);
  });
});

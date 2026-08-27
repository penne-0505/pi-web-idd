// Covers AC-001 / AC-002

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");

let dir;

function lane(iddId) {
  return {
    idd_id: iddId,
    parent_id: null,
    created_at: "2026-08-27T00:00:00Z",
    linear_issue_url: null,
    gh_issue_url: null,
    pull_req_url: null,
    source_type: "github",
    context: "",
    title: `${iddId} の題名`,
    area: "test-area",
  };
}

function envelope(envelopeId, iddId, extra = {}) {
  return {
    envelope_id: envelopeId,
    idd_id: iddId,
    type: "s2_start",
    queued_at: "2026-08-27T00:00:00Z",
    delivered_at: null,
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), [lane("IDD-1"), lane("IDD-2")].map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(
    join(dir, "outbox.jsonl"),
    [
      envelope("e1", "IDD-1"),
      envelope("e2", "IDD-1", { error: "no session for lane" }),
      envelope("e3", "IDD-2"),
      envelope("e4", "IDD-2"),
      envelope("e4", "IDD-2", { delivered_at: "2026-08-27T01:00:00Z" }),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("buildState undelivered", () => {
  it("returns the total of every delivered_at-null envelope (AC-001)", () => {
    const state = buildState();
    assert.deepEqual(state.undelivered, { total: 3, failed: 1 });
  });

  it("returns zero when there is no backlog (empty source)", () => {
    writeFileSync(join(dir, "backlog.jsonl"), "", "utf8");
    const state = buildState();
    assert.equal(state.source, "empty");
    assert.deepEqual(state.undelivered, { total: 0, failed: 0 });
  });
});

describe("buildLaneDetail undelivered", () => {
  it("returns only the count for that lane (AC-002)", () => {
    assert.deepEqual(buildLaneDetail("IDD-1")?.undelivered, { total: 2, failed: 1 });
    assert.deepEqual(buildLaneDetail("IDD-2")?.undelivered, { total: 1, failed: 0 });
  });

  it("returns null for an unknown lane", () => {
    assert.equal(buildLaneDetail("IDD-999"), null);
  });
});

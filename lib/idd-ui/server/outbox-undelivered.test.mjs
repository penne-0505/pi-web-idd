// Covers AC-005

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { countUndelivered, pendingEnvelopes } from "../../../packages/idd-core/src/agent/outbox.ts";

let dir;

function writeOutbox(records) {
  writeFileSync(join(dir, "outbox.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-outbox-"));
  process.env.IDD_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("pendingEnvelopes", () => {
  it("merges later records for the same envelope_id and drops delivered ones", () => {
    writeOutbox([
      { envelope_id: "e1", idd_id: "IDD-1", type: "t", queued_at: "2026-08-27T00:00:00Z", delivered_at: null },
      { envelope_id: "e1", delivered_at: "2026-08-27T01:00:00Z" },
      { envelope_id: "e2", idd_id: "IDD-1", type: "t", queued_at: "2026-08-27T00:10:00Z", delivered_at: null },
    ]);
    const pending = pendingEnvelopes();
    assert.deepEqual(pending.map((r) => r.envelope_id), ["e2"]);
  });

  it("merges a later error field into the pending record", () => {
    writeOutbox([
      { envelope_id: "e1", idd_id: "IDD-1", type: "t", queued_at: "2026-08-27T00:00:00Z", delivered_at: null },
      { envelope_id: "e1", error: "session not found" },
    ]);
    const pending = pendingEnvelopes();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].error, "session not found");
  });
});

describe("countUndelivered", () => {
  it("counts every delivered_at-null envelope and separates the ones with error", () => {
    writeOutbox([
      { envelope_id: "e1", idd_id: "IDD-1", type: "t", queued_at: "2026-08-27T00:00:00Z", delivered_at: null },
      { envelope_id: "e2", idd_id: "IDD-1", type: "t", queued_at: "2026-08-27T00:10:00Z", delivered_at: null, error: "boom" },
      { envelope_id: "e3", idd_id: "IDD-2", type: "t", queued_at: "2026-08-27T00:20:00Z", delivered_at: null },
      { envelope_id: "e4", idd_id: "IDD-2", type: "t", queued_at: "2026-08-27T00:30:00Z", delivered_at: null },
      { envelope_id: "e4", delivered_at: "2026-08-27T01:00:00Z" },
    ]);
    assert.deepEqual(countUndelivered(), { total: 3, failed: 1 });
    assert.deepEqual(countUndelivered("IDD-1"), { total: 2, failed: 1 });
    assert.deepEqual(countUndelivered("IDD-2"), { total: 1, failed: 0 });
    assert.deepEqual(countUndelivered("IDD-999"), { total: 0, failed: 0 });
  });

  it("returns zero when outbox.jsonl does not exist", () => {
    assert.deepEqual(countUndelivered(), { total: 0, failed: 0 });
  });
});

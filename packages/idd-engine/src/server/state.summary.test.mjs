import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");

const saved = process.env.IDD_STATE_DIR;
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const three = { situation: "購入の途中で残高が増えて見え、失敗しても戻らない。", action: "残高を増やすのを購入が確定した後にする。", outcome: "失敗した購入で残高が狂わなくなる。" };
const riskRows = (touches) => ["auth", "authz", "billing", "permission", "data_loss", "secret"].map((kind) => ({ kind, touches, reason: `${kind} の根拠。` }));
let dir;

function backlog(id) {
  return { idd_id: id, parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: `${id} の題名`, area: "Demo" };
}
const ev = (id, event, attrs = {}) => ({ idd_id: id, event, at: "2026-09-25T00:00:00Z", attrs });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-summary-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1"), backlog("IDD-2")]));
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
    ev("IDD-1", "s1_ready", { dec_count: 1, summary: three, risk_table: riskRows(true) }), ev("IDD-1", "s1_plan_review_skipped", { reason: "no slot" }),
    // the older form: a ready without the three lines
    ev("IDD-2", "s1_ready", { dec_count: 1 }), ev("IDD-2", "s1_plan_review_skipped", { reason: "no slot" }),
  ]));
});

afterEach(() => {
  if (saved === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("the planner's three plain lines", () => {
  it("reach the GO card and the lane detail", async () => {
    const go = buildState().items.find((i) => i.kind === "go" && i.iddId === "IDD-1");
    assert.deepEqual(go.summary, three);
    assert.deepEqual((await buildLaneDetail("IDD-1")).summary, three);
  });

  it("are absent when the ready came in the older form", async () => {
    const go = buildState().items.find((i) => i.kind === "go" && i.iddId === "IDD-2");
    assert.ok(go);
    assert.equal(go.summary, undefined);
    assert.equal((await buildLaneDetail("IDD-2")).summary, undefined);
  });
});

describe("the planner's six-kind table", () => {
  it("reaches the GO card and the lane detail as six labelled rows", async () => {
    const go = buildState().items.find((i) => i.kind === "go" && i.iddId === "IDD-1");
    assert.equal(go.riskTable.length, 6);
    assert.equal(go.riskTable[0].kind, "auth");
    assert.equal(go.riskTable[0].label, "認証");
    assert.equal(go.riskTable[0].touches, true);
    assert.equal(go.riskTable[0].reason, "auth の根拠。");
    assert.deepEqual((await buildLaneDetail("IDD-1")).riskTable, go.riskTable);
  });

  it("is absent on a lane whose ready came without one, not shown as all-clear", async () => {
    const go = buildState().items.find((i) => i.kind === "go" && i.iddId === "IDD-2");
    assert.equal(go.riskTable, undefined);
    assert.equal((await buildLaneDetail("IDD-2")).riskTable, undefined);
  });
});

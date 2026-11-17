/**
 * The granularity card the engine's Inbox builds: a split / merge proposal that has no answer yet is a lane on a
 * person's judgement, so the card must carry the kind, the reason, each child's whole sentence with its Places and
 * order, or the merge's target — and it must not offer an approval over the child limit.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;

function card(events) {
  dir = mkdtempSync(join(tmpdir(), "idd-state-granularity-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-127", parent_id: null, created_at: "2026-10-15T00:00:00Z", linear_issue_url: null, gh_issue_url: "https://github.com/me/app/issues/131", pull_req_url: null, source_type: "github", context: "", title: "粒度の案", area: "Demo" }) + "\n");
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), events.map(([event, attrs = {}]) => JSON.stringify({ idd_id: "IDD-127", event, at: "2026-10-15T00:00:00Z", attrs })).join("\n") + "\n");
  return buildState().items.find((i) => i.kind === "granularity");
}

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the granularity card", () => {
  it("shows the split's kind, reason, children, Places and order", () => {
    const item = card([
      ["lane_open"],
      ["s1_granularity_proposed", { kind: "split", reason: "責務が 2 つ。", children: [
        { title: "案の報告", whole: "依頼を書く前に案が出る。", places: ["src/a.ts"], after: [] },
        { title: "card", whole: "人が案を見て押せる。", places: ["lib/b.ts"], after: [0] },
      ] }],
    ]);
    assert.ok(item, "the lane is on a person's judgement");
    assert.equal(item.iddId, "IDD-127");
    assert.equal(item.title, "粒度の案", "the lane's title rides on the card");
    assert.equal(item.source?.url, "https://github.com/me/app/issues/131");
    assert.equal(item.appearedAt, "2026-10-15T00:00:00Z", "the card's time is when the lane came to this decision");
    assert.equal(item.proposal.kind, "split");
    assert.equal(item.proposal.reason, "責務が 2 つ。");
    assert.deepEqual(item.proposal.children.map((c) => [c.title, c.whole, c.places, c.after]), [
      ["案の報告", "依頼を書く前に案が出る。", ["src/a.ts"], []],
      ["card", "人が案を見て押せる。", ["lib/b.ts"], [0]],
    ]);
    assert.equal(item.proposal.approvable, true);
  });

  it("shows a merge's target, and takes an over-limit split as a re-slicing it cannot approve", () => {
    const merge = card([["lane_open"], ["s1_granularity_proposed", { kind: "merge", reason: "同じ起票。", merge_target: { ref: "me/app#12", title: "既存の起票" } }]]);
    assert.equal(merge.proposal.kind, "merge");
    assert.deepEqual(merge.proposal.mergeTarget, { ref: "me/app#12", title: "既存の起票" });
    assert.equal(merge.proposal.approvable, true);

    const many = Array.from({ length: 5 }, (_, i) => ({ title: `子 ${i + 1}`, whole: "w", places: ["src/a.ts"], after: [] }));
    const over = card([["lane_open"], ["s1_granularity_proposed", { kind: "split", reason: "r", children: many }]]);
    assert.equal(over.proposal.children.length, 5, "the proposal is taken as it was sent");
    assert.equal(over.proposal.approvable, false, "but never approvable as a split");
    assert.equal(over.proposal.limit, 4);
  });

  it("a single judgement and an answered proposal are no card", () => {
    assert.equal(card([["lane_open"], ["s1_granularity_proposed", { kind: "single", reason: "r" }]]), undefined);
    assert.equal(card([["lane_open"], ["s1_granularity_proposed", { kind: "split", reason: "r", children: [{ title: "a", whole: "w", places: ["src/a.ts"], after: [] }] }], ["s1_granularity_answered", { decision: "single" }]]), undefined);
  });
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-review-rows-"));
  process.env.IDD_STATE_DIR = dir;
  mkdirSync(join(dir, "reviews"), { recursive: true });
  // a review lane waiting on penne: it is listed beside the Issue lanes
  writeFileSync(join(dir, "reviews", "REV-20260924T051341-5aef.json"), JSON.stringify({
    id: "REV-20260924T051341-5aef", repo: "me/app", pr: 7, title: "me/app#7", url: "https://github.com/me/app/pull/7",
    created_at: "2026-09-24T05:00:00.000Z",
    history: [
      { event: "r_opened", at: "2026-09-24T05:00:00.000Z", attrs: {} },
      { event: "r_wt_ready", at: "2026-09-24T05:01:00.000Z", attrs: { head: "h", base: "b", title: "fix: スクロールを追従させる" } },
      { event: "r_triage_done", at: "2026-09-24T05:02:00.000Z", attrs: { round: 1, accepted: [] } },
      { event: "r_drafted", at: "2026-09-24T05:03:00.000Z", attrs: { round: 1, outbound_id: "OUT-1", head: "h" } },
    ],
  }));
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a review lane's row", () => {
  it("is titled PR レビュー, so someone else's PR is told apart from the S2 loop's review", () => {
    const state = buildState();
    assert.equal(state.source, "state");
    const row = state.lanes.find((l) => l.iddId.startsWith("REV-"));
    assert.ok(row);
    assert.equal(row.title, "PR レビュー: fix: スクロールを追従させる");
    assert.equal(row.blockedBy, "投稿カードの確認待ち");
  });
});

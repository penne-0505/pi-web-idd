import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { EVENT_META, REVIEW_EVENT_META, buildReviewTimeline, buildTimeline } = await import("./events-display.ts");
const { buildReviewLaneDetail } = await import("./review-detail.ts");

const at = "2026-09-25T10:00:00+09:00";

test("the end of a map reads the same on both lanes' timelines", () => {
  assert.equal(REVIEW_EVENT_META.r_map_done.kind, EVENT_META.s2_map_done.kind);
  assert.equal(REVIEW_EVENT_META.r_map_started.kind, EVENT_META.s2_map_started.kind);
});

test("a map dropped for a whole-diff blind that did not finish reads the same on both lanes' timelines", () => {
  assert.deepEqual(EVENT_META.s2_map_dropped, REVIEW_EVENT_META.r_map_dropped);
  const reason = "差分全体を読む blind が終わらなかったので、地図なしで起こし直す";
  const issue = JSON.stringify(buildTimeline([{ event: "s2_map_dropped", idd_id: "IDD-1", at, attrs: { kind: "blind", round: 1, reason } }]));
  assert.match(issue, /地図なしで起こし直し/);
  assert.match(issue, new RegExp(reason));
});

test("why a blind round went without a map shows on the timeline", () => {
  const issue = JSON.stringify(buildTimeline([{ event: "s2_review_started", idd_id: "IDD-1", at, attrs: { kind: "blind", round: 1, run_ids: ["a", "b"], map_skipped: "差分 12 行（閾値 1000 行未満）" } }]));
  assert.match(issue, /地図なし: 差分 12 行（閾値 1000 行未満）/);
  const review = JSON.stringify(buildReviewTimeline([{ event: "r_blind_started", at, attrs: { round: 1, run_ids: ["a"], map_skipped: "差分 5 行（閾値 1000 行未満）" } }]));
  assert.match(review, /地図なし: 差分 5 行（閾値 1000 行未満）/);
});

test("the wait for the executor to stop shows its reason on the timeline", () => {
  assert.equal(EVENT_META.s2_executor_waiting.kind, "warn");
  const waited = JSON.stringify(buildTimeline([{ event: "s2_executor_waiting", idd_id: "IDD-1", at, attrs: { reason: "実装役の会話が応答中", head: "0123456789abcdef" } }]));
  assert.match(waited, /実装役の終了待ち/);
  assert.match(waited, /実装役の会話が応答中/);
  assert.match(waited, /012345678/);
});

test("a route map dropped for a moved head shows both heads on the timeline", () => {
  assert.equal(EVENT_META.s2_map_head_moved.kind, "warn");
  const moved = JSON.stringify(buildTimeline([{ event: "s2_map_head_moved", idd_id: "IDD-1", at, attrs: { kind: "blind", round: 1, map_head: "aaaaaaaaaaaaaaaa", head: "bbbbbbbbbbbbbbbb" } }]));
  assert.match(moved, /経路を捨てて立て直し/);
  assert.match(moved, /aaaaaaaaa/);
  assert.match(moved, /bbbbbbbbb/);
});

test("a review lane lists its map among the reports of its stages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idd-map-detail-"));
  process.env.IDD_STATE_DIR = dir;
  mkdirSync(join(dir, "reviews"), { recursive: true });
  const id = "REV-20260925T010000-abcd";
  const r = join(dir, "pipeline", "review", id);
  writeFileSync(join(dir, "reviews", `${id}.json`), JSON.stringify({
    id, repo: "me/app", pr: 8, title: "me/app#8", url: "https://github.com/me/app/pull/8", created_at: at,
    history: [
      { event: "r_opened", at, attrs: {} },
      { event: "r_wt_ready", at, attrs: { path: "/wt", head: "h", base: "b", title: "t" } },
      { event: "r_map_started", at, attrs: { round: 1, run_id: "run-m", base: "b", head: "h" } },
      { event: "r_map_done", at, attrs: { round: 1, base: "b", head: "h", routes: [], report_md: join(r, "1-map-risk-mapper-abc/report.md") } },
      { event: "r_blind_started", at, attrs: { round: 1, run_ids: ["run-b"], head: "h" } },
    ],
  }));
  const d = await buildReviewLaneDetail(id);
  assert.deepEqual(d.reports.map((x) => [x.round, x.stage, x.label]), [[1, "map", "経路の地図"]]);
  delete process.env.IDD_STATE_DIR;
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildReviewLaneDetail, isReviewLaneId } = await import("./review-detail.ts");
const { REVIEW_EVENT_META } = await import("./events-display.ts");

let dir;
const ID = "REV-20260924T051341-5aef";
const HEAD1 = "009ae9e5699abfe744228a1c0afc3c2bf9cf3417";
const HEAD2 = "1111111111111111111111111111111111111111";

function history(state) {
  const at = (m) => `2026-09-24T05:${String(m).padStart(2, "0")}:00.000Z`;
  const r = join(state, "pipeline", "review", ID);
  return [
    { event: "r_opened", at: at(0), attrs: {} },
    { event: "r_wt_ready", at: at(1), attrs: { path: "/wt", head: HEAD1, base: "b".repeat(40), title: "fix: スクロールを追従させる" } },
    { event: "r_blind_started", at: at(2), attrs: { round: 1, run_ids: ["run-b1", "run-b2"], head: HEAD1 } },
    { event: "r_findings", at: at(10), attrs: { round: 1, files: [join(r, "1-blind-a/report.json"), join(r, "1-blind-b/report.json")] } },
    { event: "r_triage_started", at: at(11), attrs: { round: 1, run_id: "run-t1" } },
    { event: "r_triage_done", at: at(12), attrs: { round: 1, report_md: join(r, "1-triage/report.md"), accepted: [{ severity: "should", claim: "c" }], rejected: [], escalated: [] } },
    { event: "r_drafted", at: at(13), attrs: { round: 1, outbound_id: "OUT-1", head: HEAD1, suggested: "comment" } },
    { event: "r_posted", at: at(20), attrs: { round: 1, event: "comment", head: HEAD1, url: "https://github.com/me/app/pull/7#r" } },
    { event: "r_head_changed", at: at(30), attrs: { previous: HEAD1, head: HEAD2 } },
    { event: "r_confirm_started", at: at(31), attrs: { round: 2, run_id: "run-c2", base: HEAD1, head: HEAD2 } },
    { event: "r_confirm_done", at: at(35), attrs: { round: 2, files: [join(r, "2-confirm/report.json")], base: HEAD1, head: HEAD2 } },
    { event: "r_blind_started", at: at(36), attrs: { round: 2, run_ids: ["run-b3"], head: HEAD2 } },
    { event: "r_findings", at: at(40), attrs: { round: 2, files: [join(r, "2-blind/report.json")] } },
    { event: "r_triage_started", at: at(41), attrs: { round: 2, run_id: "run-t2" } },
    { event: "r_triage_done", at: at(42), attrs: { round: 2, report_md: join(r, "2-triage/report.md"), accepted: [], rejected: [], escalated: [] } },
    { event: "r_drafted", at: at(43), attrs: { round: 2, outbound_id: "OUT-2", head: HEAD2, suggested: "approve" } },
  ];
}

function writeRun(id, cost, harness) {
  mkdirSync(join(dir, "lanes", id), { recursive: true });
  writeFileSync(join(dir, "lanes", id, "lane.json"), JSON.stringify({ usage: { cost }, ...(harness ? { role_preset: { harness } } : {}) }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-review-detail-"));
  process.env.IDD_STATE_DIR = dir;
  mkdirSync(join(dir, "reviews"), { recursive: true });
  writeFileSync(join(dir, "reviews", `${ID}.json`), JSON.stringify({
    id: ID, repo: "me/app", pr: 7, title: "me/app#7", url: "https://github.com/me/app/pull/7",
    created_at: "2026-09-24T05:00:00.000Z", history: history(dir),
  }));
  mkdirSync(join(dir, "outbound"), { recursive: true });
  writeFileSync(join(dir, "outbound", "OUT-2.json"), JSON.stringify({
    id: "OUT-2", kind: "gh-pr-review", status: "ready", target: { repo: "me/app", pr: 7, expectHead: HEAD2, event: "approve" },
    title: "#7", draft: "d", created_at: "2026-09-24T05:43:00.000Z",
  }));
  writeRun("run-b1", 0.12);
  writeRun("run-b2", 0.1);
  writeRun("run-t1", 0.05);
  writeRun("run-c2", 0.2);
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("review lane detail", () => {
  it("is told apart from an Issue lane by its id", () => {
    assert.equal(isReviewLaneId(ID), true);
    assert.equal(isReviewLaneId("IDD-12"), false);
  });

  it("shows the PR, its number, link and the head it is looking at now", async () => {
    const d = await buildReviewLaneDetail(ID);
    assert.equal(d.kind, "review");
    assert.equal(d.title, "fix: スクロールを追従させる");
    assert.deepEqual({ repo: d.pr.repo, number: d.pr.number, url: d.pr.url, head: d.pr.head }, { repo: "me/app", number: 7, url: "https://github.com/me/app/pull/7", head: HEAD2 });
    // the PR's own base stays the base after a confirm; the head seen before the author's push is its own field
    assert.equal(d.pr.base, "b".repeat(40));
    assert.equal(d.pr.previousHead, HEAD1);
    assert.equal(d.phaseLabel, "投稿カードの確認待ち");
    assert.equal(d.group, "judge");
    assert.equal(d.rounds, 2);
  });

  it("lays out the course: intake, blind, triage, draft, post and the re-review", async () => {
    const d = await buildReviewLaneDetail(ID);
    const flat = JSON.stringify(d.timeline);
    for (const word of ["PR レビュー 開始", "blind 開始", "blind 完了", "判定 完了", "下書き", "投稿", "作者が更新（やり直し）", "対応の確認 完了"]) assert.ok(flat.includes(word), word);
    assert.doesNotMatch(flat, /"r_[a-z_]+"/);
    // milestones and penne's steps stay, the agents' moves between them fold
    assert.ok(d.timeline.some((e) => e.folded && e.folded > 1));
    assert.match(flat, /head 009ae9e56 → 111111111/);
  });

  it("shows the times of the course in Japan time", async () => {
    const d = await buildReviewLaneDetail(ID);
    // r_opened at 05:00Z
    assert.equal(d.timeline[0].time, "14:00");
  });

  it("says how long ago without a doubled '前'", async () => {
    const file = join(dir, "reviews", `${ID}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.history.push({ event: "r_resumed", at: new Date().toISOString(), attrs: {} });
    writeFileSync(file, JSON.stringify(rec));
    assert.equal((await buildReviewLaneDetail(ID)).since, "たった今");
    rec.history.push({ event: "r_resumed", at: new Date(Date.now() - 30 * 3600_000).toISOString(), attrs: {} });
    writeFileSync(file, JSON.stringify(rec));
    assert.equal((await buildReviewLaneDetail(ID)).since, "昨日");
    rec.history.push({ event: "r_resumed", at: new Date(Date.now() - 5 * 60_000).toISOString(), attrs: {} });
    writeFileSync(file, JSON.stringify(rec));
    assert.equal((await buildReviewLaneDetail(ID)).since, "5m 前");
  });

  it("points at each stage's report, per round", async () => {
    const d = await buildReviewLaneDetail(ID);
    assert.deepEqual(d.reports.map((r) => [r.round, r.stage, r.label]), [
      [1, "blind", "blind 1"], [1, "blind", "blind 2"], [1, "triage", "判定"],
      [2, "confirm", "対応の確認"], [2, "blind", "blind"], [2, "triage", "判定"],
    ]);
    // paths inside the state directory are shown relative to it
    assert.equal(d.reports[2].path, join("pipeline", "review", ID, "1-triage/report.md"));
  });

  it("adds up what its runs have cost so far", async () => {
    const d = await buildReviewLaneDetail(ID);
    assert.equal(d.cost.total, 0.47);
    assert.deepEqual(d.cost.parts.map((p) => p.label).sort(), ["run-b1", "run-b2", "run-c2", "run-t1"]);
    assert.deepEqual(d.cost.subscription, []);
  });

  it("keeps a Claude Code run's API-equivalent spend apart from the total, instead of dropping it", async () => {
    writeRun("run-b2", 0.9, "claude");
    const d = await buildReviewLaneDetail(ID);
    assert.equal(d.cost.total, 0.37);
    assert.deepEqual(d.cost.parts.map((p) => p.label).sort(), ["run-b1", "run-c2", "run-t1"]);
    assert.deepEqual(d.cost.subscription, [{ label: "run-b2", cost: 0.9 }]);
  });

  it("links the latest draft to its outbound card while the card is waiting", async () => {
    const d = await buildReviewLaneDetail(ID);
    assert.deepEqual(d.draft, { outboundId: "OUT-2", onCard: true, suggested: "Approve" });
    rmSync(join(dir, "outbound", "OUT-2.json"));
    assert.equal((await buildReviewLaneDetail(ID)).draft.onCard, false);
  });

  it("returns nothing for an unknown or malformed id", async () => {
    assert.equal(await buildReviewLaneDetail("REV-none"), null);
    assert.equal(await buildReviewLaneDetail("REV-../x"), null);
  });
});

describe("review lane timeline words", () => {
  it("cover every event a review lane records, so none shows up as its raw name", () => {
    const root = new URL("../../..", import.meta.url).pathname;
    const emitted = new Set(["r_opened"]);
    for (const f of readdirSync(root, { recursive: true })) {
      if (!/\.ts$/.test(f) || f.includes("node_modules") || f.includes("test")) continue;
      const p = join(root, f);
      if (!statSync(p).isFile()) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/appendReviewEvent\([^,]+,\s*"(r_[a-z_]+)"/g)) emitted.add(m[1]);
    }
    assert.ok(emitted.size > 10);
    assert.deepEqual([...emitted].filter((e) => !REVIEW_EVENT_META[e]).sort(), []);
  });
});

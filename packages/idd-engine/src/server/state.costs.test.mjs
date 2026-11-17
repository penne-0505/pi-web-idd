import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildLaneDetail, buildStateWithCosts } = await import("./state.ts");
const { clearCostCache, laneCost, readLifecycle, setAgentRunner, subscriptionTotal } = await import("@idd/core");

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
let dir;

const backlog = (id, title) => ({ idd_id: id, parent_id: null, created_at: "2026-10-01T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title, area: "Demo" });
const laneFile = (id, rec) => {
  mkdirSync(join(dir, "lanes", id), { recursive: true });
  writeFileSync(join(dir, "lanes", id, "lane.json"), JSON.stringify({ id, status: "done", started_at: "2026-10-05T00:00:00Z", ...rec }));
};

beforeEach(() => {
  clearCostCache();
  dir = mkdtempSync(join(tmpdir(), "idd-state-costs-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "roles.yaml"), "roles:\n  r: { model: x/y }\npipeline:\n");
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1", "コストの lane"), backlog("IDD-2", "pi の lane")]));
  writeFileSync(join(dir, "planner-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", planner_session_id: "P1", worktree_path: dir }]));
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
    { idd_id: "IDD-1", event: "lane_open", at: "2026-10-05T01:00:00Z", attrs: {} },
    { idd_id: "IDD-1", event: "s2_review_started", at: "2026-10-05T02:00:00Z", attrs: { run_ids: ["R1"] } },
    { idd_id: "IDD-2", event: "lane_open", at: "2026-10-05T01:00:00Z", attrs: {} },
  ]));
  setAgentRunner({
    sessionDailyCost: () => ({ cost: 1.5, daily: [{ day: "2026-10-05", cost: 1.5 }] }),
    sessionRecordFingerprint: () => "p1",
  });
});

afterEach(() => {
  setAgentRunner(null);
  rmSync(dir, { recursive: true, force: true });
});

const laneEvents = (id) => readLifecycle().filter((e) => e.idd_id === id);

describe("the lane row's cost", () => {
  it("AC-006 / INV-2242: equals the budget reader's total for the same records", async () => {
    laneFile("R1", { usage: { cost: 2 }, ended_at: "2026-10-05T10:00:00Z" });
    const state = await buildStateWithCosts({ now: new Date("2026-10-05T12:00:00Z") });
    const row = state.lanes.find((l) => l.iddId === "IDD-1");
    const cost = await laneCost("IDD-1", laneEvents("IDD-1"));
    assert.equal(row.cost.budget, cost.total);
    assert.equal(row.cost.subscription, subscriptionTotal(cost));
    assert.equal(row.cost.budget, 3.5);
  });

  it("AC-005: separates the subscription's part from the budget's", async () => {
    setAgentRunner({
      sessionDailyCost: () => ({ cost: 0.25, daily: [{ day: "2026-10-05", cost: 0.25 }] }),
      sessionRecordFingerprint: () => "p1",
    });
    laneFile("C1", { usage: { cost: 4 }, ended_at: "2026-10-05T10:00:00Z", role_preset: { harness: "claude" } });
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
      { idd_id: "IDD-1", event: "s2_review_started", at: "2026-10-05T02:00:00Z", attrs: { run_ids: ["C1"] } },
    ]));
    const state = await buildStateWithCosts({ now: new Date("2026-10-05T12:00:00Z") });
    const row = state.lanes.find((l) => l.iddId === "IDD-1");
    assert.equal(row.cost.budget, 0.25, "the subscription spend is not in the budget");
    assert.equal(row.cost.subscription, 4);
  });

  it("AC-005: a PR review lane's row carries it too", async () => {
    mkdirSync(join(dir, "reviews"), { recursive: true });
    writeFileSync(join(dir, "reviews", "REV-1.json"), JSON.stringify({
      id: "REV-1", repo: "o/r", pr: 7, title: "t", url: "https://github.com/o/r/pull/7", created_at: "2026-10-05T00:00:00Z",
      history: [{ event: "r_opened", at: "2026-10-05T00:00:00Z", attrs: {} }],
    }));
    const state = await buildStateWithCosts({ now: new Date("2026-10-05T12:00:00Z") });
    const row = state.lanes.find((l) => l.iddId === "REV-1");
    assert.ok(row, "the review lane is listed");
    assert.deepEqual(row.cost, { budget: 0, subscription: 0 });
  });
});

describe("the lane detail's spend", () => {
  it("AC-005: is on every lane, not only a Claude Code one, and the claude-only cost field stays conditional", async () => {
    laneFile("R1", { usage: { cost: 2 }, ended_at: "2026-10-05T10:00:00Z" });
    const pi = await buildLaneDetail("IDD-2");
    assert.deepEqual(pi.spend, { budget: 0, subscription: 0 });
    assert.equal(pi.cost, undefined, "a pi lane keeps no Claude Code cost section");
  });
});

describe("today's total", () => {
  it("AC-007: keeps only the JST day's spend, split from the subscription (a multi-day session counts only today's replies)", async () => {
    setAgentRunner({
      sessionDailyCost: () => ({ cost: 6, daily: [{ day: "2026-10-04", cost: 5 }, { day: "2026-10-05", cost: 1 }] }),
      sessionRecordFingerprint: () => "p1",
    });
    laneFile("R1", { usage: { cost: 2 }, ended_at: "2026-10-05T14:59:00Z" }); // 2026-10-05 23:59 JST
    laneFile("R2", { usage: { cost: 8 }, ended_at: "2026-10-03T15:00:00Z" }); // 2026-10-04 00:00 JST (not today)
    laneFile("C1", { usage: { cost: 3 }, ended_at: "2026-10-05T10:00:00Z", role_preset: { harness: "claude" } });
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
      { idd_id: "IDD-1", event: "s2_review_started", at: "2026-10-05T02:00:00Z", attrs: { run_ids: ["R1", "R2", "C1"] } },
      { idd_id: "IDD-2", event: "lane_open", at: "2026-10-05T01:00:00Z", attrs: {} },
    ]));
    const state = await buildStateWithCosts({ now: new Date("2026-10-05T15:00:00Z") }); // 2026-10-06 00:00 JST
    assert.equal(state.today.day, "2026-10-06");
    assert.equal(state.today.budget, 0, "nothing was spent on 10-06 JST");
    const before = await buildStateWithCosts({ now: new Date("2026-10-05T12:00:00Z") }); // 2026-10-05 21:00 JST
    assert.equal(before.today.day, "2026-10-05");
    assert.equal(before.today.budget, 3, "the session's 1 (of its 6, the rest was 10-04) and R1's 2 are on 10-05 JST, not R2's 8");
    assert.equal(before.today.subscription, 3, "the Claude Code run is the subscription's part");
  });
});

describe("costs are read once", () => {
  it("AC-008: a second state read does not read an unchanged session again", async () => {
    let calls = 0;
    setAgentRunner({
      sessionDailyCost: () => {
        calls += 1;
        return { cost: 1.5, daily: [{ day: "2026-10-05", cost: 1.5 }] };
      },
      sessionRecordFingerprint: () => "p1",
    });
    laneFile("R1", { usage: { cost: 2 }, ended_at: "2026-10-05T10:00:00Z" });
    const first = await buildStateWithCosts({ now: new Date("2026-10-05T12:00:00Z") });
    assert.equal(calls, 1);
    const second = await buildStateWithCosts({ now: new Date("2026-10-05T12:00:00Z") });
    assert.equal(calls, 1, "the unchanged session record is not read again");
    assert.equal(second.lanes.find((l) => l.iddId === "IDD-1").cost.budget, first.lanes.find((l) => l.iddId === "IDD-1").cost.budget);
  });
});

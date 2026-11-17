import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildLaneDetail, buildState } = await import("./state.ts");
const { buildReviewLaneDetail } = await import("./review-detail.ts");
const { claudeQuotaView, claudeRunsView, conversationView } = await import("./claude-view.ts");
const { plannerConcurrency, setAgentRunner } = await import("@idd/core");
const { conversationCost, isConversation } = await import("@idd/lane");

const TOKEN = "Zk3pQ9vT2mX8aL5nR1wE7yU4oI6sD0fG";
const ENV = ["IDD_STATE_DIR", "IDD_CLAUDE_CONFIG_DIR", "IDD_AGENT_TOKEN", "IDD_ROLES_FILE"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const assistant = (content) => ({ type: "assistant", message: { content } });
const future = Math.floor(Date.now() / 1000) + 3600;

let dir;

function backlog(id, title) {
  return { idd_id: id, parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title, area: "Demo" };
}

function laneRec(id, rec) {
  const d = join(dir, "lanes", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "lane.json"), JSON.stringify({ id, role: "planner-claude", model: "opus", worktree: "/wt/lane", spec: "", report: "", started_at: "2026-09-25T01:00:00.000Z", ...rec }));
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-claude-"));
  const cfg = join(dir, "claude-cfg");
  mkdirSync(cfg);
  // the roles these views read are this test's own, so the shipped config and the machine's ~/.config/idd are never read
  writeFileSync(join(dir, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nroles: {}\n`);
  Object.assign(process.env, { IDD_STATE_DIR: dir, IDD_CLAUDE_CONFIG_DIR: cfg, IDD_AGENT_TOKEN: TOKEN, IDD_ROLES_FILE: join(dir, "roles.yaml") });
  setAgentRunner({ sessionCost: async (id) => (isConversation(id) ? conversationCost(id) : 0.05) });

  writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1", "Claude の lane"), backlog("IDD-2", "pi の lane")]));
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
    { idd_id: "IDD-1", event: "s1_plan_review_done", at: "2026-09-25T01:30:00Z", attrs: { run_id: "R1", must: 0, should: 0, nit: 0 } },
  ]));
  writeFileSync(join(dir, "planner-sessions.jsonl"), jsonl([
    { idd_id: "IDD-1", planner_session_id: "S1", started_at: "2026-09-25T01:00:00Z", worktree_path: "/wt/lane", branch: "idd/IDD-1", harness: "claude" },
    { idd_id: "IDD-2", planner_session_id: "P2", started_at: "2026-09-25T01:00:00Z", worktree_path: "/wt/pi", branch: "idd/IDD-2", harness: "pi" },
  ]));

  // the planner's conversation: one reply done, one being written
  mkdirSync(join(dir, "pipeline", "conversations"), { recursive: true });
  writeFileSync(join(dir, "pipeline", "conversations", "S1"), "L1");
  const l1 = laneRec("L1", { mode: "conversation", status: "running", session_file: "S1", role_preset: { name: "planner-claude", harness: "claude" } });
  for (const d of ["turns", "sent", "inflight"]) mkdirSync(join(l1, d));
  writeFileSync(join(l1, "sent", "001-a.md"), `<idd-system-message>\n  <type>s1_prep_start</type>\n  <token>${TOKEN}</token>\n</idd-system-message>`);
  writeFileSync(join(l1, "inflight", "002-b.md"), "<idd-system-message>\n  <type>plan_review_findings</type>\n</idd-system-message>");
  writeFileSync(join(l1, "turns.jsonl"), jsonl([{ n: 1, message: "001-a.md", resume: false, started_at: "2026-09-25T01:00:00.000Z", ended_at: "2026-09-25T01:20:00.000Z", status: "done", reached: true, reported_cost: 0.2 }]));
  writeFileSync(join(l1, "turns", "1.jsonl"), jsonl([
    assistant([{ type: "tool_use", name: "Read", input: { file_path: "/wt/lane/lib/pay.ts" } }]),
    assistant([{ type: "tool_use", name: "Bash", input: { command: `curl -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:30142/api/idd/agent/ready` } }]),
    assistant([{ type: "text", text: `下調べを終えました（${TOKEN}）` }]),
  ]));
  writeFileSync(join(l1, "inflight.json"), JSON.stringify({ n: 2, message: "002-b.md", resume: true, started_at: "2026-09-25T01:40:00.000Z" }));
  writeFileSync(join(l1, "turns", "2.jsonl"), jsonl([assistant([{ type: "tool_use", name: "Edit", input: { file_path: "/wt/lane/_docs/intent/Demo/x/decision.md" } }])]));
  writeFileSync(join(l1, "conversation.lock"), JSON.stringify({ pid: process.pid, start: null, nonce: "n" }));

  // the plan review, a short stage on Claude Code
  const r1 = laneRec("R1", { role: "plan-reviewer", title: "plan review", status: "done", ended_at: "2026-09-25T01:29:00.000Z", usage: { input: 1, output: 1, cost: 0.61 }, role_preset: { name: "plan-reviewer", harness: "claude" } });
  writeFileSync(join(r1, "events.jsonl"), jsonl([assistant([{ type: "tool_use", name: "Read", input: { file_path: "/wt/lane/_docs/qa/Demo/x/qa.md" } }])]));

  writeFileSync(join(dir, "pipeline", "claude-quota.json"), JSON.stringify({ accounts: { [resolve(cfg)]: {
    status: "allowed", observed_at: "2026-09-25T01:40:00.000Z", lane: "L1",
    windows: { five_hour: { utilization: 0.42, resets_at: future }, seven_day: { utilization: 0.12, resets_at: future + 86400 }, seven_day_opus: { utilization: 0.9, resets_at: 1 } },
  } } }));
});

afterEach(() => {
  setAgentRunner(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("a Claude Code lane's detail", () => {
  it("shows the planner's conversation from the lane's own record: each reply, what was sent and what Claude did", async () => {
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set(["S1"]) });
    const planner = lane.claude.find((c) => c.label === "下調べ");
    assert.ok(planner);
    assert.equal(planner.running, true);
    assert.equal(planner.runningSince, "2026-09-25T01:40:00.000Z");
    const heads = planner.timeline.filter((r) => r.title.startsWith("応答")).map((r) => r.title);
    assert.deepEqual(heads, ["応答 1", "応答 2"]);
    assert.match(planner.timeline[0].detail, /下調べの指示/);
    assert.match(planner.timeline[0].detail, /\$0\.20/);
    assert.match(planner.timeline.find((r) => r.title === "応答 2").detail, /応答中/);
    const moves = planner.timeline.filter((r) => !r.title.startsWith("応答")).flatMap((r) => (r.items ?? [r]).map((i) => i.title));
    assert.ok(moves.includes("Read lib/pay.ts"));
    assert.ok(moves.some((m) => m.startsWith("Bash curl")));
    // the reply being written: its last moves, for the live strip
    assert.deepEqual(planner.recent, [{ kind: "tool", tool: "Edit", body: "_docs/intent/Demo/x/decision.md" }]);
  });

  it("lists every executor session in the order the lane started them", async () => {
    for (const [sid, laneId] of [["S2", "L2"], ["S3", "L3"]]) {
      writeFileSync(join(dir, "pipeline", "conversations", sid), laneId);
      const l = laneRec(laneId, { mode: "conversation", status: "idle", role_preset: { harness: "claude" } });
      mkdirSync(join(l, "turns"), { recursive: true });
      writeFileSync(join(l, "turns.jsonl"), jsonl([{ n: 1, message: "m.md", started_at: "2026-09-25T02:00:00.000Z", ended_at: "2026-09-25T02:01:00.000Z", status: "done", reached: true }]));
    }
    writeFileSync(join(dir, "executor-sessions.jsonl"), jsonl([
      { idd_id: "IDD-1", executor_session_id: "S2", started_at: "2026-09-25T02:00:00Z", worktree_path: "/wt/lane", branch: "idd/IDD-1", harness: "claude" },
      { idd_id: "IDD-1", executor_session_id: "S3", started_at: "2026-09-25T03:00:00Z", worktree_path: "/wt/lane", branch: "idd/IDD-1", kind: "fix", harness: "claude" },
    ]));
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set() });
    assert.deepEqual(lane.claude.map((c) => c.label), ["下調べ", "実装", "修正 1", "短い段"]);
  });

  it("a reply's cost that may carry an earlier reply's says so", () => {
    writeFileSync(join(dir, "pipeline", "conversations", "S8"), "L8");
    const l8 = laneRec("L8", { mode: "conversation", status: "idle", role_preset: { harness: "claude" } });
    mkdirSync(join(l8, "turns"));
    const t = (n, extra) => ({ n, message: `m${n}.md`, resume: n > 1, started_at: "2026-09-25T01:00:00.000Z", ended_at: "2026-09-25T01:01:00.000Z", reached: true, ...extra });
    writeFileSync(join(l8, "turns.jsonl"), jsonl([t(1, { status: "failed", error: "exit 1" }), t(2, { status: "done", reported_cost: 0.5 })]));
    const v = conversationView("実装", "S8", new Set());
    assert.match(v.timeline.find((r) => r.title === "応答 2").detail, /\$0\.50（前の応答の分を含む）/);
  });

  it("each reply's rows keep their keys across a poll, though its earlier moves come to be left out", () => {
    writeFileSync(join(dir, "pipeline", "conversations", "S7"), "L7");
    const l7 = laneRec("L7", { mode: "conversation", status: "idle", role_preset: { harness: "claude" } });
    mkdirSync(join(l7, "turns"));
    const t = (n) => ({ n, message: `m${n}.md`, resume: n > 1, started_at: "2026-09-25T01:00:00.000Z", ended_at: "2026-09-25T01:01:00.000Z", status: "done", reached: true });
    const moves = (k) => jsonl(Array.from({ length: k }, (_, i) => assistant([{ type: "text", text: `m${i}` }])));
    writeFileSync(join(l7, "turns.jsonl"), jsonl([t(1), t(2)]));
    writeFileSync(join(l7, "turns", "1.jsonl"), moves(2));
    writeFileSync(join(l7, "turns", "2.jsonl"), moves(3));
    const before = conversationView("実装", "S7", new Set()).timeline;
    // the next poll: reply 2 has grown past the cap of moves shown, so a row of left-out moves comes first
    writeFileSync(join(l7, "turns", "2.jsonl"), moves(200));
    const after = conversationView("実装", "S7", new Set()).timeline;
    const keyOf = (rows, title) => rows.find((r) => r.title === title)?.key;
    assert.ok(keyOf(before, "応答 2"));
    assert.equal(keyOf(after, "応答 2"), keyOf(before, "応答 2"));
    const movesOf2 = (rows) => rows[rows.findIndex((r) => r.title === "応答 2") + 1].key;
    assert.equal(movesOf2(after), movesOf2(before));
    assert.equal(new Set(after.map((r) => r.key)).size, after.length);
  });

  it("a short stage's row does not say its name twice when the run has no title of its own", () => {
    laneRec("B3", { role: "blind-reviewer", status: "done", ended_at: "2026-09-25T01:02:00.000Z", role_preset: { harness: "claude" } });
    const row = claudeRunsView(["B3"]).timeline[0];
    assert.equal(row.title, "blind-reviewer");
    assert.doesNotMatch(row.detail ?? "", /blind-reviewer/);
  });

  it("the per-model weekly window is named in words too", () => {
    writeFileSync(join(dir, "pipeline", "claude-quota.json"), JSON.stringify({ accounts: { [resolve(process.env.IDD_CLAUDE_CONFIG_DIR)]: {
      status: "allowed", observed_at: new Date().toISOString(), windows: { seven_day_opus: { utilization: 0.3, resets_at: future } },
    } } }));
    assert.equal(claudeQuotaView().windows[0].label, "週上限（Opus）");
  });

  it("reading a detail never creates the callback token", async () => {
    delete process.env.IDD_AGENT_TOKEN;
    await buildLaneDetail("IDD-1", { liveSessions: new Set(["S1"]) });
    assert.equal(existsSync(join(dir, "agent-token")), false);
  });

  it("never shows the callback token", async () => {
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set(["S1"]) });
    assert.doesNotMatch(JSON.stringify(lane), new RegExp(TOKEN));
  });

  it("lists a short stage's Claude Code run with what it did and its cost", async () => {
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set() });
    const runs = lane.claude.find((c) => c.label === "短い段");
    assert.ok(runs);
    assert.equal(runs.running, false);
    assert.equal(runs.timeline[0].title, "plan-reviewer");
    assert.match(runs.timeline[0].detail, /\$0\.61/);
    assert.deepEqual(runs.timeline[1]?.title ?? runs.timeline[0].items?.[0]?.title, "Read _docs/qa/Demo/x/qa.md");
  });

  it("a short stage whose supervisor died is not shown running", async () => {
    const dead = spawnSync("true").pid;
    laneRec("R1", { role: "plan-reviewer", title: "plan review", status: "running", supervisor_pid: dead, role_preset: { name: "plan-reviewer", harness: "claude" } });
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set() });
    const runs = lane.claude.find((c) => c.label === "短い段");
    assert.equal(runs.running, false);
    assert.match(runs.timeline[0].detail, /中断/);
  });

  it("parallel short stages stay running while any of them runs, though the last one started has ended", () => {
    const b1 = laneRec("B1", { role: "blind-a", title: "blind a", status: "running", supervisor_pid: process.pid, started_at: "2026-09-25T01:00:00.000Z", role_preset: { harness: "claude" } });
    writeFileSync(join(b1, "events.jsonl"), jsonl([assistant([{ type: "tool_use", name: "Read", input: { file_path: "/wt/lane/a.ts" } }])]));
    const b2 = laneRec("B2", { role: "blind-b", title: "blind b", status: "done", ended_at: "2026-09-25T01:02:00.000Z", started_at: "2026-09-25T01:00:01.000Z", role_preset: { harness: "claude" } });
    writeFileSync(join(b2, "events.jsonl"), jsonl([assistant([{ type: "text", text: "終わり" }])]));
    const runs = claudeRunsView(["B1", "B2"]);
    assert.equal(runs.running, true);
    assert.equal(runs.runningSince, "2026-09-25T01:00:00.000Z");
    assert.deepEqual(runs.recent, [{ kind: "tool", tool: "Read", body: "a.ts" }]);
  });

  it("while a message waits for its supervisor, the last reply's moves are not shown as the current ones", () => {
    writeFileSync(join(dir, "pipeline", "conversations", "S9"), "L9");
    const l9 = laneRec("L9", { mode: "conversation", status: "idle", role_preset: { harness: "claude" } });
    mkdirSync(join(l9, "turns"));
    writeFileSync(join(l9, "turns.jsonl"), jsonl([{ n: 1, message: "m.md", resume: false, started_at: "2026-09-25T01:00:00.000Z", ended_at: "2026-09-25T01:01:00.000Z", status: "done", reached: true }]));
    writeFileSync(join(l9, "turns", "1.jsonl"), jsonl([assistant([{ type: "text", text: "前の応答" }])]));
    const v = conversationView("実装", "S9", new Set(["S9"]));
    assert.equal(v.running, true);
    assert.deepEqual(v.recent, []);
  });

  it("shows the spend as the subscription's API equivalent, outside the budget, beside the windows' use", async () => {
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set(["S1"]) });
    assert.deepEqual(lane.cost.parts, []);
    assert.deepEqual(lane.cost.subscription, [{ label: "下調べ", cost: 0.2 }, { label: "R1", cost: 0.61 }]);
    assert.equal(lane.cost.total, 0);
    assert.deepEqual(lane.quota.windows.map((w) => [w.label, w.utilization]), [["5 時間の枠", 0.42], ["週上限", 0.12]]);
    assert.ok(lane.quota.windows[0].resets);
    assert.ok(lane.quota.observed);
    assert.equal(lane.quota.rejected, undefined);
    assert.equal(lane.agents.find((a) => a.role === "下調べ").harness, "claude");
  });

  it("leaves a pi lane as it was: no conversation, spend or windows", async () => {
    const lane = await buildLaneDetail("IDD-2", { liveSessions: new Set(["P2"]) });
    assert.equal(lane.claude, undefined);
    assert.equal(lane.cost, undefined);
    assert.equal(lane.quota, undefined);
    assert.equal(lane.agents[0].harness, undefined);
  });

  it("an unknown lane is none", async () => {
    assert.equal(await buildLaneDetail("IDD-999"), null);
  });
});

describe("a running lane's live signs", () => {
  it("say it is live, since when its stage runs, and how many lanes share the stage against the cap", async () => {
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set(["S1"]) });
    assert.equal(lane.activity, "live");
    assert.equal(lane.stageSince, "2026-09-25T01:00:00Z");
    assert.deepEqual(lane.concurrency, { label: "下調べ中", count: 2, cap: plannerConcurrency() });
  });

  it("count only the lanes running in the stage's slot, as its cap counts them: not the ones waiting for it", async () => {
    // IDD-3 waits for a planner slot (no session yet); a lane past its ready no longer holds one
    writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlog("IDD-1", "Claude の lane"), backlog("IDD-2", "pi の lane"), backlog("IDD-3", "待っている lane")]));
    const lane = await buildLaneDetail("IDD-1", { liveSessions: new Set(["S1"]) });
    assert.deepEqual(lane.concurrency, { label: "下調べ中", count: 2, cap: plannerConcurrency() });
    const prep = buildState().sections.find((x) => x.group === "prep");
    assert.equal(prep.count, 3);
    assert.equal(prep.running, 2);
  });

  it("a lane whose session is not running is not live, and a pi lane gets the same signs", async () => {
    const lane = await buildLaneDetail("IDD-2", { liveSessions: new Set() });
    assert.equal(lane.activity, "stalled");
    assert.equal(lane.stageSince, "2026-09-25T01:00:00Z");
    assert.equal(lane.concurrency.count, 2);
  });
});

describe("a review lane's Claude Code runs", () => {
  it("are shown with the windows' use beside the spend", async () => {
    const r = laneRec("B1", { role: "blind-reviewer-opus", title: "#7 blind", status: "done", ended_at: "2026-09-25T01:09:00.000Z", usage: { input: 1, output: 1, cost: 0.9 }, role_preset: { name: "blind-reviewer-opus", harness: "claude" } });
    writeFileSync(join(r, "events.jsonl"), jsonl([assistant([{ type: "text", text: "見ました" }])]));
    mkdirSync(join(dir, "reviews"), { recursive: true });
    writeFileSync(join(dir, "reviews", "REV-1.json"), JSON.stringify({
      id: "REV-1", repo: "me/app", pr: 7, title: "me/app#7", url: "https://github.com/me/app/pull/7", created_at: "2026-09-25T01:00:00.000Z",
      history: [{ event: "r_opened", at: "2026-09-25T01:00:00.000Z", attrs: {} }, { event: "r_blind_started", at: "2026-09-25T01:00:00.000Z", attrs: { round: 1, run_ids: ["B1"] } }],
    }));
    const lane = await buildReviewLaneDetail("REV-1");
    assert.ok(lane);
    const runs = lane.claude.find((c) => c.label === "短い段");
    assert.equal(runs.timeline[0].title, "blind-reviewer-opus");
    assert.deepEqual(lane.cost.subscription, [{ label: "B1", cost: 0.9 }]);
    assert.ok(lane.quota);
  });
});

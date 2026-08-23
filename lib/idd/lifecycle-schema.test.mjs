import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  LIFECYCLE_SCHEMA,
  ALL_LIFECYCLE_EVENT_NAMES,
  emitLifecycleLine,
  foldLifecycleLedger,
  foldLifecycleLedgerFull,
  deriveStage,
  isLifecycleEvent,
} = await jiti.import("./lifecycle-schema.ts");

const TS = "2026-08-23T09:00:00+09:00";

test("emit: unknown event fails", () => {
  const r = emitLifecycleLine({ event: "made_up", ts: TS, repo: "flutter", attrs: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown lifecycle event/);
});

test("emit: lane_open with all required attrs succeeds", () => {
  const r = emitLifecycleLine({
    event: "lane_open",
    ts: TS,
    repo: "flutter",
    attrs: {
      linear_issue_id: "APP-1710",
      worktree_branch: "feature/app-1710",
      worker: "pi:idd-fan-out",
    },
  });
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.line);
  assert.equal(parsed.type, "lifecycle_lane_open");
  assert.equal(parsed.ts, TS);
  assert.equal(parsed.repo, "flutter");
  assert.equal(parsed.linear_issue_id, "APP-1710");
});

test("emit: missing required attr fails with names listed", () => {
  const r = emitLifecycleLine({
    event: "lane_open",
    ts: TS,
    repo: "flutter",
    attrs: { linear_issue_id: "APP-1" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /missing required attr/);
  assert.match(r.error, /worktree_branch/);
  assert.match(r.error, /worker/);
});

test("emit: field order in output matches schema declaration", () => {
  const r = emitLifecycleLine({
    event: "s3_ready",
    ts: TS,
    repo: "flutter",
    attrs: {
      ac_coverage: "AC-1,AC-2",
      touched_paths: ["lib/foo.dart"],
      narrative: "done",
      linear_issue_id: "APP-1",
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(
    Object.keys(JSON.parse(r.line)),
    ["ts", "repo", "type", "linear_issue_id", "narrative", "touched_paths", "ac_coverage"],
  );
});

test("emit: unknown attrs are silently dropped", () => {
  const r = emitLifecycleLine({
    event: "lane_open",
    ts: TS,
    repo: "flutter",
    attrs: {
      linear_issue_id: "APP-1",
      worktree_branch: "feature/app-1",
      worker: "pi:x",
      garbage: "should-be-dropped",
      also_bogus: 42,
    },
  });
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.line);
  assert.equal("garbage" in parsed, false);
  assert.equal("also_bogus" in parsed, false);
});

test("emit: enum violation fails", () => {
  const r = emitLifecycleLine({
    event: "s1_ready",
    ts: TS,
    repo: "flutter",
    attrs: { linear_issue_id: "APP-1", clarity_verdict: "maybe" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not in \[clear, borderline\]/);
});

test("emit: attrs wins over attrsJson on key collision", () => {
  const r = emitLifecycleLine({
    event: "s3_ready",
    ts: TS,
    repo: "flutter",
    attrsJson: JSON.stringify({
      linear_issue_id: "APP-1",
      narrative: "from-json",
      touched_paths: ["a"],
    }),
    attrs: { narrative: "from-attr-wins" },
  });
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.line);
  assert.equal(parsed.narrative, "from-attr-wins");
  assert.deepEqual(parsed.touched_paths, ["a"]);
});

test("emit: attrsJson not valid JSON fails", () => {
  const r = emitLifecycleLine({
    event: "s1_ready",
    ts: TS,
    repo: "flutter",
    attrsJson: "{not json",
    attrs: { linear_issue_id: "APP-1", clarity_verdict: "clear" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
});

test("emit: attrsJson must be object (array rejected)", () => {
  const r = emitLifecycleLine({
    event: "s1_ready",
    ts: TS,
    repo: "flutter",
    attrsJson: JSON.stringify(["arr"]),
    attrs: { linear_issue_id: "APP-1", clarity_verdict: "clear" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be a JSON object/);
});

test("emit: all 13 events produce valid output when given required attrs", () => {
  const minimalAttrs = {
    lane_open: { linear_issue_id: "APP-1", worktree_branch: "feature/x", worker: "w" },
    s1_ready: { linear_issue_id: "APP-1", clarity_verdict: "clear" },
    s1_go: { linear_issue_id: "APP-1", user_decision: "go" },
    s1_defer: { linear_issue_id: "APP-1" },
    s2_start: { linear_issue_id: "APP-1", worker: "w" },
    s2_blocked: { linear_issue_id: "APP-1", blocker_narrative: "n" },
    s2_result: { linear_issue_id: "APP-1", result: "success" },
    s3_ready: { linear_issue_id: "APP-1", narrative: "n" },
    s3_ok: { linear_issue_id: "APP-1" },
    s3_reject: { linear_issue_id: "APP-1", reason: "r" },
    s4_submitted: { linear_issue_id: "APP-1", pr_number: "42", pr_url: "https://x" },
    s4_merged: { linear_issue_id: "APP-1" },
    lane_close: { linear_issue_id: "APP-1", close_reason: "merged" },
  };
  assert.equal(ALL_LIFECYCLE_EVENT_NAMES.length, Object.keys(minimalAttrs).length);
  for (const ev of ALL_LIFECYCLE_EVENT_NAMES) {
    const r = emitLifecycleLine({ event: ev, ts: TS, repo: "flutter", attrs: minimalAttrs[ev] });
    assert.equal(r.ok, true, `${ev} should emit; got ${!r.ok ? r.error : ""}`);
  }
});

test("deriveStage: static templates", () => {
  assert.equal(deriveStage({ type: "lifecycle_lane_open" }), "lane-open");
  assert.equal(deriveStage({ type: "lifecycle_s2_implementing" }), "unknown");
  assert.equal(deriveStage({ type: "lifecycle_s3_ready" }), "s3-ready");
  assert.equal(deriveStage({ type: "lifecycle_lane_close" }), "lane-close");
});

test("deriveStage: s1_ready fills clarity_verdict", () => {
  assert.equal(
    deriveStage({ type: "lifecycle_s1_ready", clarity_verdict: "clear" }),
    "s1-ready-clear",
  );
  assert.equal(
    deriveStage({ type: "lifecycle_s1_ready", clarity_verdict: "borderline" }),
    "s1-ready-borderline",
  );
});

test("deriveStage: s2_result fills result", () => {
  assert.equal(
    deriveStage({ type: "lifecycle_s2_result", result: "success" }),
    "s2-success",
  );
  assert.equal(
    deriveStage({ type: "lifecycle_s2_result", result: "failure" }),
    "s2-failure",
  );
});

test("isLifecycleEvent: valid record passes", () => {
  assert.equal(
    isLifecycleEvent({
      ts: TS,
      repo: "flutter",
      type: "lifecycle_lane_open",
      linear_issue_id: "APP-1",
    }),
    true,
  );
});

test("isLifecycleEvent: rejects non-lifecycle types and malformed", () => {
  assert.equal(isLifecycleEvent(null), false);
  assert.equal(isLifecycleEvent("string"), false);
  assert.equal(isLifecycleEvent({ type: "import", ts: TS, repo: "x" }), false);
  assert.equal(
    isLifecycleEvent({ type: "lifecycle_lane_open", ts: TS, repo: "x" }),
    false,
  );
  assert.equal(
    isLifecycleEvent({ type: "lifecycle_lane_open", ts: TS, repo: "x", linear_issue_id: "" }),
    false,
  );
});

function ev(type, extras = {}) {
  return { ts: TS, repo: "flutter", type, linear_issue_id: "APP-1", ...extras };
}

test("fold: empty input yields empty map", () => {
  assert.equal(foldLifecycleLedger([]).size, 0);
  assert.equal(foldLifecycleLedgerFull([]).size, 0);
});

test("fold: non-lifecycle events are ignored", () => {
  const events = [
    { ts: TS, repo: "flutter", type: "import", head: "abc" },
    { ts: TS, repo: "flutter", type: "export", feature: "x" },
    "garbage",
    null,
  ];
  assert.equal(foldLifecycleLedger(events).size, 0);
});

test("fold: last event wins for stage", () => {
  const events = [
    ev("lifecycle_lane_open", { worktree_branch: "feature/x", worker: "w1" }),
    ev("lifecycle_s1_ready", { clarity_verdict: "clear" }),
    ev("lifecycle_s1_go", { user_decision: "go" }),
    ev("lifecycle_s2_start", { worker: "w2" }),
  ];
  const lanes = foldLifecycleLedger(events);
  assert.equal(lanes.size, 1);
  const lane = lanes.get("APP-1");
  assert.equal(lane.stage, "s2-implementing");
  assert.equal(lane.worker, "w2");
  assert.equal(lane.worktree, "feature/x");
});

test("fold: retired lanes (last event = lane_close) excluded from active", () => {
  const events = [
    ev("lifecycle_lane_open", { worktree_branch: "feature/x", worker: "w" }),
    ev("lifecycle_s2_result", { result: "failure" }),
    ev("lifecycle_lane_close", { close_reason: "delete" }),
  ];
  assert.equal(foldLifecycleLedger(events).size, 0);
  const full = foldLifecycleLedgerFull(events);
  assert.equal(full.size, 1);
  assert.equal(full.get("APP-1").stage, "lane-close");
});

test("fold: multiple lanes distinguished by linear_issue_id", () => {
  const events = [
    ev("lifecycle_lane_open", { linear_issue_id: "APP-1", worktree_branch: "feature/a", worker: "w" }),
    ev("lifecycle_lane_open", { linear_issue_id: "APP-2", worktree_branch: "feature/b", worker: "w" }),
    ev("lifecycle_s2_start",  { linear_issue_id: "APP-1", worker: "w1" }),
  ];
  const lanes = foldLifecycleLedger(events);
  assert.equal(lanes.size, 2);
  assert.equal(lanes.get("APP-1").stage, "s2-implementing");
  assert.equal(lanes.get("APP-2").stage, "lane-open");
});

test("fold: worker carried only from lane_open / s2_start (not from s1_ready etc.)", () => {
  const events = [
    ev("lifecycle_lane_open", { worktree_branch: "feature/x", worker: "w1" }),
    ev("lifecycle_s1_ready", { clarity_verdict: "clear", worker: "should_not_win" }),
  ];
  const lane = foldLifecycleLedger(events).get("APP-1");
  assert.equal(lane.worker, "w1");
});

test("fold: since is the ts of the most recent event", () => {
  const t1 = "2026-08-23T09:00:00+09:00";
  const t2 = "2026-08-23T10:00:00+09:00";
  const events = [
    { ts: t1, repo: "flutter", type: "lifecycle_lane_open", linear_issue_id: "APP-1", worktree_branch: "b", worker: "w" },
    { ts: t2, repo: "flutter", type: "lifecycle_s1_ready", linear_issue_id: "APP-1", clarity_verdict: "clear" },
  ];
  assert.equal(foldLifecycleLedger(events).get("APP-1").since, t2);
});

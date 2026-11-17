import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { NOW, at, jsonl, putLane, stateDirPerTest } = await import("../../test/fixtures/state-fixture.mjs");

const fixture = stateDirPerTest("idd-state-answered-");
const put = (id, title, events) => putLane(fixture.dir, id, title, events);

function writeOutbound(rec) {
  mkdirSync(join(fixture.dir, "outbound"), { recursive: true });
  writeFileSync(join(fixture.dir, "outbound", `${rec.id}.json`), JSON.stringify({
    id: rec.id, kind: "gh-issue", target: {}, title: rec.title ?? "投稿", draft: "", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", ...rec,
  }));
}

describe("today's answered cards", () => {
  it("AC-009: lists the cards penne answered, with kind, lane and time, oldest first", () => {
    put("IDD-1", "答えた lane", [
      ["s1_go"],
      ["question_batch_answered", { batch_id: "B-1" }],
      ["s2_review_resumed", { decision: "continue" }],
      ["pending_review_resolved", { review_id: "IDD-9" }],
      ["s4_push_approved", { head: "abc" }],
      ["s4_land_approved", { head: "abc" }],
      ["s3_ok", { reviewer_notes: "" }],
    ]);
    const { answered } = buildState({ now: NOW });
    assert.deepEqual(answered.map((a) => [a.kind, a.iddId]), [
      ["go", "IDD-1"], ["question", "IDD-1"], ["stuck", "IDD-1"], ["duplicate", "IDD-1"], ["ship", "IDD-1"], ["ship", "IDD-1"], ["review", "IDD-1"],
    ]);
    assert.deepEqual(answered.map((a) => a.title), Array(7).fill("答えた lane"));
    assert.ok(answered.every((a) => a.at));
    const times = answered.map((a) => a.at);
    assert.deepEqual(times, [...times].sort(), "oldest first");
  });

  it("AC-007: the replan answer of a stopped lane is a stuck card penne answered", () => {
    put("IDD-1", "考え直す lane", [
      ["s2_review_escalated", { reason: "修正が上限に達した" }],
      ["s1_replan_requested", { rounds: 2, at_by: "user" }],
    ]);
    const state = buildState({ now: NOW });
    assert.deepEqual(state.answered.map((a) => [a.kind, a.iddId]), [["stuck", "IDD-1"]]);
    assert.equal(state.progress.done, state.answered.length);
  });

  it("AC-009: yesterday's records are left out", () => {
    put("IDD-1", "昨日", [
      ["s1_go"],
    ]);
    writeFileSync(join(fixture.dir, "lifecycle-Demo.jsonl"), jsonl([{ idd_id: "IDD-1", event: "s1_go", at: "2026-10-04T12:00:00Z", attrs: {} }]));
    assert.deepEqual(buildState({ now: NOW }).answered, []);
  });

  it("AC-011 / INV-2243: the harness's own records are not penne's answers", () => {
    put("IDD-1", "自動", [
      ["s3_ok", { at_by: "auto" }],
      ["s4_verify_user_judgment_answered", { outcome: "revise", by: "harness" }],
    ]);
    assert.deepEqual(buildState({ now: NOW }).answered, []);

    put("IDD-1", "手で答えた", [["s3_ok", { reviewer_notes: "ok" }]]);
    assert.deepEqual(buildState({ now: NOW }).answered.map((a) => a.kind), ["review"]);
  });

  it("AC-011: a lane taken out or started over counts as the card it stood at", () => {
    put("IDD-1", "無視", [
      ["lane_open"],
      ["s1_ready"],
      ["s1_plan_review_done", { must: 0, should: 0, nit: 0 }],
      ["lane_close", { outcome: "aborted", via: "ignore" }],
    ]);
    assert.deepEqual(buildState({ now: NOW }).answered.map((a) => [a.kind, a.iddId]), [["go", "IDD-1"]]);
  });

  it("AC-011: a question batch answered in one record is one card", () => {
    put("IDD-1", "質問", [
      ["question_batch_answered", { batch_id: "B-1" }],
    ]);
    assert.deepEqual(buildState({ now: NOW }).answered.map((a) => a.kind), ["question"]);
  });
});

describe("today's outbound answers", () => {
  it("AC-010: a post approved or discarded today is an answer; a waiting one is not", () => {
    put("IDD-1", "コストの lane", [["lane_open"]]);
    writeOutbound({ id: "OUT-1", title: "今日投稿", status: "posted", posted: { url: "u", at: at(2) } });
    writeOutbound({ id: "OUT-2", title: "今日破棄", status: "discarded", updated_at: at(3) });
    writeOutbound({ id: "OUT-3", title: "待っている", status: "ready" });
    writeOutbound({ id: "OUT-4", title: "昨日投稿", status: "posted", posted: { url: "u", at: "2026-10-04T12:00:00Z" } });
    const { answered } = buildState({ now: NOW });
    assert.deepEqual(answered.map((a) => [a.kind, a.title]), [["outbound", "今日投稿"], ["outbound", "今日破棄"]]);
  });
});

describe("the inbox progress", () => {
  it("AC-012: done matches the answered list, and open matches the cards in the state", () => {
    put("IDD-1", "答えた lane", [["s1_go"]]);
    const state = buildState({ now: NOW });
    assert.equal(state.progress.done, state.answered.length);
    assert.equal(state.progress.open, state.items.length);
  });

  it("AC-012: an empty backlog with only a post card still answers both", () => {
    writeFileSync(join(fixture.dir, "backlog.jsonl"), "");
    writeOutbound({ id: "OUT-1", title: "今日投稿", status: "posted", posted: { url: "u", at: at(2) } });
    writeOutbound({ id: "OUT-2", title: "待っている", status: "ready" });
    const state = buildState({ now: NOW });
    assert.equal(state.progress.done, 1);
    assert.equal(state.progress.open, state.items.length);
    assert.equal(state.progress.open, 1, "the waiting post is one card");
  });
});

describe("a batch the mechanism alone answered", () => {
  it("AC-006: is no answer of the day and is not in progress.done", () => {
    put("IDD-1", "仕組みが答えた lane", [["question_batch_answered", { batch_id: "B-1", answered_by: "router" }]]);
    const state = buildState({ now: NOW });
    assert.deepEqual(state.answered, []);
    assert.equal(state.progress.done, 0);
  });

  it("AC-006: is counted once a person answered any question of it (its close carries no mark)", () => {
    put("IDD-1", "人が答えた lane", [["question_batch_answered", { batch_id: "B-1" }]]);
    const state = buildState({ now: NOW });
    assert.deepEqual(state.answered.map((a) => a.kind), ["question"]);
    assert.equal(state.progress.done, 1);
  });

  it("AC-006: a mechanism batch beside a person's batch leaves only the person's in the count", () => {
    put("IDD-1", "二つの batch", [
      ["question_batch_answered", { batch_id: "B-1", answered_by: "router" }],
      ["question_batch_answered", { batch_id: "B-2" }],
    ]);
    assert.equal(buildState({ now: NOW }).progress.done, 1);
  });
});

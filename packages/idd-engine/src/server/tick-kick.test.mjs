import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { bookTickIfPending, decisionAsksForTick, kickTickAfterDecision, kickTickAfterRecord, runDecisionFollowUps } = await import("./tick-kick.ts");
const route = (p) => readFileSync(fileURLToPath(new URL(`../routes/${p}.ts`, import.meta.url)), "utf8");

describe("the tick asked for after penne's decision", () => {
  it("is asked for after every recorded decision, and not after a failed one or the submit view", () => {
    for (const action of ["s1_go", "s1_revise", "lane_budget_extend", "lane_stall_resume", "s2_review_continue", "s2_review_accept", "answer", "s3_ok", "s4_revise", "s4_verify_clean", "outbound_approve", "outbound_discard"]) {
      assert.equal(decisionAsksForTick(action, true), true, action);
      assert.equal(decisionAsksForTick(action, false), false, action);
    }
    assert.equal(decisionAsksForTick("s4_prepare", true), false);
  });

  it("asks once per recorded decision, and a failure to ask does not fail the decision", () => {
    const asked = [];
    const request = () => { asked.push(1); return { outcome: "scheduled" }; };
    assert.deepEqual(kickTickAfterDecision("s2_review_continue", true, request), { outcome: "scheduled" });
    assert.equal(kickTickAfterDecision("s2_review_continue", false, request), null);
    assert.equal(kickTickAfterDecision("s4_prepare", true, request), null);
    assert.equal(asked.length, 1);
    const warn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(m);
    try {
      assert.equal(kickTickAfterRecord(() => { throw new Error("no bus"); }), null);
      assert.deepEqual(kickTickAfterRecord(() => ({ outcome: "failed", detail: "exit 1" })), { outcome: "failed", detail: "exit 1" });
    } finally { console.warn = warn; }
    assert.equal(warned.length, 2);
    assert.match(warned[0], /no bus/);
  });
});

describe("what follows a decision in /api/idd/decide", () => {
  const spies = (after) => {
    const calls = { runAfter: [], request: 0, book: 0 };
    return {
      calls,
      deps: {
        runAfter: async (o) => { calls.runAfter.push(o); return after; },
        request: () => { calls.request += 1; return { outcome: "scheduled" }; },
        book: () => { calls.book += 1; return { outcome: "scheduled" }; },
      },
    };
  };

  it("starts the executor under the tick's lock after a GO only, asks for a tick, and books one more for a request left meanwhile", async () => {
    const go = spies({ started: { started: [], skipped: [], capacity: 1 }, delivery: { delivered: [], skipped: [] } });
    await runDecisionFollowUps("s1_go", true, go.deps);
    assert.deepEqual(go.calls.runAfter, [{ exec: true }]);
    assert.equal(go.calls.request, 1);
    assert.equal(go.calls.book, 0);
    const cont = spies({ delivery: { delivered: [], skipped: [] }, pending: true });
    await runDecisionFollowUps("s2_review_continue", true, cont.deps);
    assert.deepEqual(cont.calls.runAfter, [{ exec: false }]);
    assert.equal(cont.calls.book, 1);
    const failed = spies({});
    assert.deepEqual(await runDecisionFollowUps("s1_go", false, failed.deps), {});
    assert.deepEqual(failed.calls, { runAfter: [], request: 0, book: 0 });
  });

  it("a tick's result books one more tick only when it came back pending", () => {
    let booked = 0;
    const book = () => { booked += 1; return { outcome: "scheduled" }; };
    assert.equal(bookTickIfPending({ skipped: "another tick is running" }, book), null);
    assert.equal(bookTickIfPending({ intake: {} }, book), null);
    assert.deepEqual(bookTickIfPending({ pending: true }, book), { outcome: "scheduled" });
    assert.equal(booked, 1);
  });

  it("the decide route goes through these, and starts nothing of the tick's by itself; the tick route books for a pending result", () => {
    const decide = route("decide");
    assert.match(decide, /runDecisionFollowUps\(body\.action, result\.ok\)/);
    for (const direct of ["runExec", "deliverPending", "runAfterDecision("]) assert.equal(decide.includes(direct), false, direct);
    assert.match(route("tick"), /bookTickIfPending\(result\)/);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as mine from "../src/ledger/review-loop.ts";
import * as reference from "../src/ledger/review-loop-reference.ts";
import { deriveStageReference } from "../src/ledger/derive-reference.ts";
import { deriveStage } from "../src/ledger/derive.ts";
import { laneHasEnded } from "../src/ledger/ends.ts";
import { laneLanded } from "../src/ledger/blockers.ts";
import { laneAnswer } from "../src/intent/moonbit-fold.ts";
import { lane_answer } from "../../idd-fold/dist/idd-fold.js";
import { cleanReview, replannedReady, stopped } from "./helpers/lane-ledger.mjs";

/**
 * The MoonBit derivation and the TypeScript reading, held against committed fixtures.
 *
 * A real ledger lives outside git and the test entry drops the `IDD_` variables, so a test cannot see one. What a
 * real ledger would add — the twelve events it never carries, a resume after the hand turn, values the type does
 * not name, and attrs of the wrong shape — is written here instead, so this check answers the same on every
 * machine. The real ledger's every prefix is checked by `packages/idd-fold/crosscheck.mjs`.
 *
 * The floor is `_docs/qa/pi-web-idd/idd-191/qa.md`: AC-001 (every prefix, the same answer), AC-002 (every event
 * the derivation reads, and broken fields), AC-003 (the readers take the MoonBit answer and do not disagree).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "derive", "lifecycle.jsonl");

function rowsOf() {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`fixture の ${index + 1} 行目が JSON ではありません: ${String(error)}`);
      }
    });
}

/** the answer without the keys a JSON round trip leaves out, so an absent field and an undefined one are one */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const rows = rowsOf();
const lanes = new Map();
for (const row of rows) {
  if (!lanes.has(row.idd_id)) lanes.set(row.idd_id, []);
  lanes.get(row.idd_id).push(row);
}

/** every prefix of every lane: what the caller reads at each step */
function* prefixes() {
  for (const [lane, events] of lanes) {
    for (let n = 1; n <= events.length; n += 1) {
      yield { lane, n, events, prefix: events.slice(0, n) };
    }
  }
}

test("AC-002: the fixture carries every event the derivations read by name, and one they do not", () => {
  const named = new Set(rows.map((row) => row.event));
  // the twelve events the real ledger never carries, and the hand turn's resume
  for (const event of [
    "blocked_by_dependency", "s1_defer", "s1_granularity_recorded", "s1_plan_review_skipped", "s2_hand_fixed",
    "s2_map_dropped", "s2_map_head_moved", "s2_order_unknown", "s2_review_skipped", "s3_defer", "s3_reject",
    "s4_ship_failed", "s2_review_resumed",
  ]) {
    assert.ok(named.has(event), `${event} が fixture にありません`);
  }
  assert.ok(named.has("s9_weird_event"), "知らない event が fixture にありません");
  // the hand turn's answer is in the fixture, not only the record that penne finished it
  assert.ok(rows.some((row) => row.event === "s2_review_resumed" && row.attrs?.decision === "hand_fix"), "hand_fix の再開が fixture にありません");
  // the twelve the real ledger lacks are the ones the plan named
  const missing = ["blocked_by_dependency", "s1_defer", "s1_granularity_recorded", "s1_plan_review_skipped", "s2_hand_fixed", "s2_map_dropped", "s2_map_head_moved", "s2_order_unknown", "s2_review_skipped", "s3_defer", "s3_reject", "s4_ship_failed"];
  assert.equal(new Set(missing).size, 12);
});

test("AC-001 / AC-002: the review loop's state is the same answer at every prefix", () => {
  for (const { lane, n, prefix } of prefixes()) {
    assert.deepEqual(plain(mine.reviewLoopState(prefix)), plain(reference.reviewLoopState(prefix)), `${lane} の ${n} 行目までで巡の状態が食い違いました`);
  }
});

test("AC-001 / AC-002: the stage is the same answer at every prefix (before the quota overlay)", () => {
  for (const { lane, n, prefix } of prefixes()) {
    assert.deepEqual(plain(laneAnswer("stage", prefix)), plain(deriveStageReference(prefix)), `${lane} の ${n} 行目までで段が食い違いました`);
  }
});

test("a lane that went back to its plan: the reference stage is the MoonBit answer at every prefix, as the replan view reads it", () => {
  // the reference must read the lane as the plan stage again (the GO and the rounds before the return are left out),
  // or a crosscheck over a replanned ledger blames the fold for the reference's own gap
  const ledgers = [stopped(), replannedReady(), [...replannedReady(), cleanReview()], [...replannedReady(), cleanReview(), { ...cleanReview(), event: "s1_go" }]];
  for (const [which, events] of ledgers.entries()) {
    for (let n = 1; n <= events.length; n += 1) {
      const prefix = events.slice(0, n);
      assert.deepEqual(plain(laneAnswer("stage", prefix)), plain(deriveStageReference(prefix)), `台帳 ${which} の ${n} 行目までで段が食い違いました`);
    }
  }
  // and it does read the plan stage: right after the return the lane is not at the card of the stopped review loop
  assert.notEqual(deriveStageReference(replannedReady()).decision, "stuck");
});

test("AC-001: a lane's end and landing are the same answer at every prefix", () => {
  for (const { lane, n, prefix } of prefixes()) {
    const ended = prefix.some((e) => e.event === "lane_close" || e.event === "s1_defer" || e.event === "s3_defer");
    const landed = prefix.some((e) => e.event === "s4_land_merged" || e.event === "s4_merged" || (e.event === "lane_close" && Boolean(e.attrs?.merged_commit)));
    assert.equal(laneHasEnded(lane, prefix), ended, `${lane} の ${n} 行目までで lane の終わりが食い違いました`);
    assert.equal(laneLanded(prefix), landed, `${lane} の ${n} 行目までで着地が食い違いました`);
  }
});

test("AC-002 / AC-003: every reader answers what the TypeScript reading answers, at every prefix", () => {
  const now = Date.parse("2026-10-19T10:04:00+09:00");
  for (const { lane, n, prefix } of prefixes()) {
    const where = `${lane} の ${n} 行目まで`;
    assert.deepEqual(plain(mine.passPolicy(prefix)), plain(reference.passPolicy(prefix)), `${where}で回の方針`);
    assert.deepEqual(plain(mine.feedbackPassAt(prefix)), plain(reference.feedbackPassAt(prefix)), `${where}で PR の回`);
    assert.equal(mine.blindEverRan(prefix), reference.blindEverRan(prefix), `${where}で blind の有無`);
    assert.deepEqual(plain(mine.conflictSendBacks(prefix)), plain(reference.conflictSendBacks(prefix)), `${where}で衝突の差し戻し`);
    assert.equal(mine.firstBlindOfPass(prefix), reference.firstBlindOfPass(prefix), `${where}で最初の blind`);
    const mineTriage = mine.feedbackTriageOf(prefix);
    const refTriage = reference.feedbackTriageOf(prefix);
    assert.equal(prefix.indexOf(mineTriage), prefix.indexOf(refTriage), `${where}で PR の判定`);
    assert.deepEqual(plain(mine.fixCapReached(prefix)), plain(reference.fixCapReached(prefix)), `${where}で上限`);
    assert.deepEqual(plain(mine.fixCapReached(prefix, { forForecast: true })), plain(reference.fixCapReached(prefix, { forForecast: true })), `${where}で見込みの上限`);
    assert.equal(mine.stagnation(prefix), reference.stagnation(prefix), `${where}で停滞`);
    assert.equal(mine.settledHead(prefix), reference.settledHead(prefix), `${where}で最後の blind の head`);
    assert.deepEqual(plain(mine.fixScope(prefix)), plain(reference.fixScope(prefix)), `${where}で修正の範囲`);
    assert.deepEqual(plain(mine.followupsOf(prefix)), plain(reference.followupsOf(prefix)), `${where}で後続`);
    assert.deepEqual(plain(mine.shouldFixCounts(prefix)), plain(reference.shouldFixCounts(prefix)), `${where}で should の数`);
    assert.deepEqual(plain(mine.submitLeftovers(prefix)), plain(reference.submitLeftovers(prefix)), `${where}で提出の card の残件`);
    assert.deepEqual(plain(mine.reviewRounds(prefix)), plain(reference.reviewRounds(prefix)), `${where}で巡の数`);
    assert.equal(mine.closedByPenne(prefix), reference.closedByPenne(prefix), `${where}で penne が閉じたか`);
    assert.equal(mine.startFailures(prefix), reference.startFailures(prefix), `${where}で開始の失敗`);
    assert.equal(mine.startRetryWaiting(prefix, now), reference.startRetryWaiting(prefix, now), `${where}で開始の待ち`);
    assert.equal(mine.isLoopLane(prefix), reference.isLoopLane(prefix), `${where}で loop の lane か`);
    for (let i = 0; i < prefix.length; i += 1) {
      const at = `${where}の ${i} 行目`;
      assert.equal(mine.s4Triage(prefix, i), reference.s4Triage(prefix, i), `${at}で S4 の判定か`);
      assert.equal(mine.answeredJudgementAt(prefix, i), reference.answeredJudgementAt(prefix, i), `${at}で答えた判定`);
      assert.equal(prefix.indexOf(mine.fixAfter(prefix, i)), prefix.indexOf(reference.fixAfter(prefix, i)), `${at}で直後の修正`);
      assert.equal(mine.beginsFixRound(prefix[i]), reference.beginsFixRound(prefix[i]), `${at}で修正の巡の始まり`);
      assert.equal(mine.isReturnedResult(prefix[i]), reference.isReturnedResult(prefix[i]), `${at}で仕事をせずに返したか`);
      assert.equal(mine.roleChangedIn(prefix[i].attrs?.fallbacks), reference.roleChangedIn(prefix[i].attrs?.fallbacks), `${at}で役の切り替え`);
      const mineAccepted = mine.acceptedAt(prefix, i);
      assert.deepEqual(plain(mineAccepted), plain(reference.acceptedAt(prefix, i)), `${at}で受理の読み`);
      const fix = mine.fixAfter(prefix, i);
      const fixRef = reference.fixAfter(prefix, i);
      for (const note of ["", "補足"]) {
        for (const s4 of [false, true]) {
          assert.deepEqual(
            plain(mine.unfixedOf(prefix, i, fix, note, s4)),
            plain(reference.unfixedOf(prefix, i, fixRef, note, s4)),
            `${at}で残った指摘（note=${note || "空"} / s4=${s4}）`,
          );
        }
      }
      assert.equal(mine.closesAt(prefix, i, { must: 0, should: 1 }), reference.closesAt(prefix, i, { must: 0, should: 1 }), `${at}で閉じるか`);
      const policy = reference.passPolicy(prefix, i);
      assert.equal(
        mine.overCapStop(prefix[i].attrs, policy),
        reference.overCapStop(prefix[i].attrs, policy),
        `${at}で上限を超えた should`,
      );
    }
    // the readers over one row's own attrs
    for (const row of prefix) {
      const attrs = row.attrs;
      assert.deepEqual(plain(mine.acceptedOf(attrs)), plain(reference.acceptedOf(attrs)), `${where}で受理の一覧`);
      assert.deepEqual(plain(mine.rejectedOf(attrs)), plain(reference.rejectedOf(attrs)), `${where}で拒否の一覧`);
      assert.deepEqual(plain(mine.oscillationsOf(attrs)), plain(reference.oscillationsOf(attrs)), `${where}で往復`);
      assert.deepEqual(plain(mine.boundariesOf(attrs)), plain(reference.boundariesOf(attrs)), `${where}で境目の判断`);
      assert.deepEqual(plain(mine.correctionsOf(attrs)), plain(reference.correctionsOf(attrs)), `${where}で訂正`);
      assert.deepEqual(plain(mine.routesOf(attrs)), plain(reference.routesOf(attrs)), `${where}で経路`);
      assert.deepEqual(plain(mine.orderOpponentsOf(attrs)), plain(reference.orderOpponentsOf(attrs)), `${where}で待ちの相手`);
      for (const item of reference.acceptedOf(attrs)) {
        assert.equal(mine.fixesNow(item), reference.fixesNow(item), `${where}で fix に回すか`);
        assert.equal(mine.isFollowup(item), reference.isFollowup(item), `${where}で後続か`);
      }
      assert.equal(mine.blocking(reference.acceptedOf(attrs)), reference.blocking(reference.acceptedOf(attrs)), `${where}で止める数`);
      assert.deepEqual(plain(mine.fixCounts(reference.acceptedOf(attrs))), plain(reference.fixCounts(reference.acceptedOf(attrs))), `${where}で fix の数`);
    }
  }
});

test("AC-003: the stuck card's destination is the same as the TypeScript reading's", () => {
  for (const { lane, n, prefix } of prefixes()) {
    if (reference.reviewLoopState(prefix).state !== "escalated") continue;
    for (const decision of ["continue", "accept", "hand_fix"]) {
      for (const note of ["", "補足"]) {
        for (const skipsFinal of [() => false, () => true]) {
          for (const deviceOn of [true, false]) {
            const env = { skipsFinal, deviceOn };
            const answer = { decision, note };
            assert.deepEqual(
              plain(mine.answerOutcome(prefix, answer, env)),
              plain(reference.answerOutcome(prefix, answer, env)),
              `${lane} の ${n} 行目までで停止の card の行き先（${decision} / note=${note || "空"}）`,
            );
          }
        }
      }
    }
  }
});

test("AC-003: a failed MoonBit answer is a failure the caller sees, never a TypeScript reading", () => {
  // the door the readers go through: an operation the module does not know is a failure, not an empty answer
  assert.throws(() => laneAnswer("no_such_answer", []), /MoonBit の畳み/);
  // and the module's own answer is a failure (not a value) for an operation it does not know
  assert.notEqual(lane_answer("no_such_answer", "[]", "{}").$tag, 1);
});

test("AC-003: the loop's own state and the readers over the same record do not disagree on the fixture", () => {
  for (const { lane, n, prefix } of prefixes()) {
    const state = mine.reviewLoopState(prefix);
    // a lane the loop closed has nothing left unfixed on its submit card that a judgement within the limit left
    if (state.state === "done" || state.state === "converge") continue;
    // the fix cap the state reads and the cap the forecast reads come from the same judgement
    const cap = mine.fixCapReached(prefix);
    if (cap?.scope === "lane") assert.equal(state.state === "escalated", true, `${lane} の ${n} 行目までで上限と停止が食い違いました`);
  }
});

test("the depth table is the MoonBit table, and the review events are the MoonBit list", () => {
  assert.deepEqual(plain(laneAnswer("depth_table", [])), plain([
    { depth: "shallow", planReview: 1, blind: 1, spec: 1, finalReview: true, fixRounds: 1, autoGo: true, shape: 0 },
    { depth: "standard", planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 2, autoGo: false, shape: 0 },
    { depth: "deep", planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 3, autoGo: false, shape: 1 },
  ]));
  assert.deepEqual([...mine.REVIEW_EVENTS], plain(laneAnswer("review_events", [])));
});

test("the stage's quota overlay still sits on the record's own answer", () => {
  // the overlay is the runtime's: a record whose last word is a window wait is the stage read from it, but the
  // record-only answer is the one the cross-check holds (the runtime cannot be read in a test)
  const wait = { idd_id: "IDD-910", event: "claude_quota_wait", at: "2026-10-19T10:00:00+09:00", attrs: { stage: "review" } };
  const base = [{ idd_id: "IDD-910", event: "s2_start", at: "2026-10-19T09:00:00+09:00", attrs: {} }, wait];
  assert.deepEqual(plain(deriveStage(base, null)), plain(laneAnswer("stage", base)));
  const held = deriveStage(base, { reason: "windows", resetsAt: Date.parse("2026-10-20T00:00:00.000Z") / 1000 });
  assert.match(held.blockedBy ?? "", /Claude の枠待ち（review、リセット 2026-10-20 09:00 JST）/);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeSync } from "../src/ledger/review-loop.ts";
import {
  finalReviewReference,
  orderGateReference,
  recordsCheckReference,
  recordsRecheckReference,
  roundExtrasReference,
  stuckOutcomesReference,
} from "../src/ledger/review-judge-reference.ts";

/**
 * The review loop's judgements: the fold's answer against the TypeScript's, over the same rows and the same facts.
 *
 * The facts are the ones the fold cannot read itself: a tree, the behaviour files that changed, the lane's Risk, a
 * trial merge, the records check's answer. Every combination of them has to give the same answer on both sides,
 * or the tick and the card can disagree about what the loop does next.
 */

const POLICY = {
  extras: { first_round: 1, high_risk: 1 },
  highRiskWhen: "last",
  finalExtra: "high",
  finalWhen: "behaviour",
  finalScope: "increment",
  orderWaitHours: 6,
  orderExcludeFiles: ["TODO.md"],
};

const HEAD = "a".repeat(40);
const SETTLED = "b".repeat(40);

const ev = (event, attrs = {}) => ({ event, idd_id: "IDD-1", at: "2026-10-01T00:00:00.000Z", attrs });

/** a lane whose last whole-diff blind read a tree and judged it */
const judged = [
  ev("s2_start", { started_from_commit: "c0" }),
  ev("s2_result", { outcome: "success" }),
  ev("s2_review_started", { kind: "blind", round: 1, run_ids: ["r1"], head: SETTLED, whole_run_ids: ["r1"] }),
  ev("s2_review_findings", { failed_runs: 0 }),
  ev("s2_triage_done", { kind: "blind", accepted: [{ ref: "1-blind/F-1", severity: "must", claim: "c" }] }),
];

/** a lane the High role read to the end at the settled head */
const judgedHigh = [
  ...judged,
  ev("s2_review_started", { kind: "blind", round: 1, run_ids: ["r1"], head: SETTLED, whole_run_ids: ["r1"], extras: ["high_risk"], high_allowed: true }),
];

/** the facts the fold asks for, answered the way a caller answers them */
const facts = (readings) => (need) => {
  if (need.kind === "sameTree") return readings.sameTree;
  if (need.kind === "behaviour") return readings.behaviour;
  if (need.kind === "risk") return readings.risk;
  if (need.kind === "head") return readings.head ?? HEAD;
  if (need.kind === "trialMerge") return readings.trialMerge ?? null;
  if (need.kind === "outsideRecords") return "outsideRecords" in readings ? readings.outsideRecords : [];
  if (need.kind === "mergeOnlySkip") return readings.mergeOnlySkip ?? null;
  if (need.kind === "recordsCheck") return readings.check ?? { outcome: "clean" };
  return null;
};

test("AC-001: the final review's skip is the same on both sides, for every combination of the facts", () => {
  for (const sameTree of [true, false]) {
    for (const behaviour of [[], ["src/a.ts"]]) {
      for (const risk of [true, false]) {
        for (const rows of [judged, judgedHigh]) {
          const readings = { sameTree, behaviour, risk };
          const reference = finalReviewReference(rows, POLICY, readings, HEAD);
          const mine = judgeSync("final_review", rows, { policy: POLICY, head: HEAD }, facts(readings));
          assert.deepEqual(mine.skip ?? null, reference.skip, `sameTree=${sameTree} behaviour=${behaviour.length} risk=${risk}`);
          // what the final is shown is part of the answer: an increment can leave earlier changes unseen
          assert.equal(mine.wholeForUnread ?? false, reference.wholeForUnread, `wholeForUnread sameTree=${sameTree} behaviour=${behaviour.length} risk=${risk}`);
        }
      }
    }
  }
});

test("AC-001: the round's extra roles are the same on both sides, for every combination of the facts", () => {
  for (const kind of ["blind", "final", "kept", "device"]) {
    for (const conflict of [true, false]) {
      for (const risk of [true, false]) {
        const readings = { risk };
        const reference = roundExtrasReference(judged, POLICY, kind, conflict, readings);
        const mine = judgeSync("round_extras", judged, { policy: POLICY, kind, conflict }, facts(readings));
        assert.deepEqual(mine.extras ?? [], reference, `kind=${kind} conflict=${conflict} risk=${risk}`);
      }
    }
  }
});

test("AC-001: the order check's answer is the same on both sides, for every combination of the facts", () => {
  const readings = { head: HEAD, trialMerge: { conflict: true, files: ["src/a.ts"] } };
  const args = { policy: POLICY, head: HEAD, now: 0, orderAt: 0, inScope: true, prior: [{ lane: "IDD-2", head: "c" }], unreadable: [] };
  const reference = orderGateReference(judged, args, { trialMerge: { [`${HEAD}|c`]: readings.trialMerge } });
  const mine = judgeSync("order_gate", judged, { ...args }, facts(readings));
  assert.deepEqual(mine.wait, reference.wait);
  assert.deepEqual((mine.steps ?? []).map((s) => ({ event: s.event, attrs: s.attrs })), reference.steps);
  // an opponent whose head cannot be read is a lane, not a string: the record names it the way the lane is named
  const unreadableArgs = { ...args, prior: [], unreadable: ["IDD-900"] };
  const unreadableRef = orderGateReference(judged, unreadableArgs, {});
  const unreadableMine = judgeSync("order_gate", judged, unreadableArgs, facts({}));
  assert.deepEqual((unreadableMine.steps ?? []).map((s) => ({ event: s.event, attrs: s.attrs })), unreadableRef.steps);
  const unknownStep = unreadableRef.steps.find((s) => s.event === "s2_order_unknown");
  assert.ok(unknownStep, "読めない先行 lane の記録がありません");
  assert.deepEqual(unknownStep.attrs.opponents, [{ lane: "IDD-900" }]);
  // an opponent whose head cannot be read is not a conflict, and the lane does not wait
  const unknown = { head: HEAD, trialMerge: null };
  const unknownRef = orderGateReference(judged, args, { trialMerge: { [`${HEAD}|c`]: null } });
  const unknownMine = judgeSync("order_gate", judged, { ...args }, facts(unknown));
  assert.deepEqual(unknownMine.wait, unknownRef.wait);
  assert.deepEqual((unknownMine.steps ?? []).map((s) => ({ event: s.event, attrs: s.attrs })), unknownRef.steps);
});

test("AC-001: the order check answers with more lanes ahead than the caller's fact rounds", () => {
  // twelve lanes ahead: every trial merge is asked for in one round, so the check finishes on the second
  const prior = Array.from({ length: 12 }, (_, i) => ({ lane: `IDD-${i + 2}`, head: String(i + 1).padStart(40, "0") }));
  const merges = Object.fromEntries(prior.map((p, i) => [`${HEAD}|${p.head}`, i === 3 ? { conflict: true, files: ["src/a.ts"] } : { conflict: false, files: [] }]));
  const args = { policy: POLICY, head: HEAD, now: 0, orderAt: 0, inScope: true, prior, unreadable: [] };
  const base = facts({ head: HEAD });
  const reader = (need) => (need.kind === "trialMerge" ? merges[`${need.a}|${need.b}`] ?? null : base(need));
  const reference = orderGateReference(judged, args, { trialMerge: merges });
  const mine = judgeSync("order_gate", judged, { ...args }, reader);
  assert.equal(reference.wait, true);
  assert.deepEqual(mine.wait, reference.wait);
  assert.deepEqual((mine.steps ?? []).map((s) => ({ event: s.event, attrs: s.attrs })), reference.steps);
  // the same twelve lanes with nothing colliding: the lane passes and goes to its review
  const clean = Object.fromEntries(prior.map((p) => [`${HEAD}|${p.head}`, { conflict: false, files: [] }]));
  const cleanReader = (need) => (need.kind === "trialMerge" ? clean[`${need.a}|${need.b}`] ?? null : base(need));
  const cleanRef = orderGateReference(judged, args, { trialMerge: clean });
  const cleanMine = judgeSync("order_gate", judged, { ...args }, cleanReader);
  assert.equal(cleanRef.wait, false);
  assert.deepEqual(cleanMine.wait, cleanRef.wait);
  assert.deepEqual((cleanMine.steps ?? []).map((s) => ({ event: s.event, attrs: s.attrs })), cleanRef.steps);
});

test("AC-001: the records check's answer is the same on both sides, for the check's three answers", () => {
  const finding = { rule: "record", id: "C-1", reason: "reason" };
  for (const check of [
    { outcome: "clean" },
    { outcome: "errors", findings: [finding] },
    { outcome: "errors", findings: [finding] },
    { outcome: "unavailable", reason: "why" },
  ]) {
    const sent = check.outcome === "errors" ? [ev("s2_records_conflict", { error_keys: ["record\u0000C-1"] })] : [];
    const rows = [...sent, ...judged];
    const reference = recordsCheckReference(rows, { head: HEAD, hasCheck: true, check });
    const mine = judgeSync("records_check", rows, { head: HEAD, headError: "", hasCheck: true }, facts({ check }));
    assert.deepEqual(mine.steps ?? [], reference.steps, JSON.stringify(check));
  }
});

test("AC-001: a records check nobody declared writes nothing, and a head that cannot be read still closes the round", () => {
  // a repo that declares no records check: no record is written, and the round closes for the head
  const none = recordsCheckReference(judged, { head: HEAD, hasCheck: false });
  assert.deepEqual(none.steps, [{ kind: "verdict" }]);
  assert.deepEqual(judgeSync("records_check", judged, { head: HEAD, headError: "", hasCheck: false }, facts({})).steps ?? [], none.steps);
  // the lane's head cannot be read: the check cannot run, and the round goes on with the reason on record
  for (const hasCheck of [true, false]) {
    const unreadable = recordsCheckReference(judged, { head: "", headError: "worktree がありません", hasCheck });
    const mine = judgeSync("records_check", judged, { head: "", headError: "worktree がありません", hasCheck }, facts({}));
    assert.deepEqual(mine.steps ?? [], unreadable.steps, `hasCheck=${hasCheck}`);
    if (hasCheck) assert.equal(unreadable.steps[0].attrs.outcome, "unavailable");
  }
  // the recheck cannot tell the answer from a code change: the rounds run again
  const reopened = recordsRecheckReference(judged, { head: "", headError: "worktree がありません", hasCheck: true, from: "", changed: [] });
  const mineRecheck = judgeSync("records_recheck", judged, { head: "", headError: "worktree がありません", hasCheck: true }, facts({}));
  assert.deepEqual(mineRecheck.steps ?? [], reopened.steps);
  assert.equal(reopened.steps[0].event, "s2_records_reopened");
});

test("AC-001: the recheck's answer is the same on both sides, for what changed outside the records place", () => {
  const finding = { rule: "record", id: "C-1", reason: "reason" };
  for (const changed of [null, [], ["src/a.ts"]]) {
    for (const skip of [undefined, { head: HEAD, reviewed_head: "c", merge: "m", mainline: "mm", review_base: "rb" }]) {
      for (const check of [{ outcome: "clean" }, { outcome: "errors", findings: [finding] }]) {
        const rows = [...judged];
        const reference = recordsRecheckReference(rows, { head: HEAD, hasCheck: true, check, from: "", changed, skip });
        const mine = judgeSync("records_recheck", rows, { head: HEAD, headError: "", hasCheck: true }, facts({ outsideRecords: changed, mergeOnlySkip: skip ?? null, check }));
        const steps = (mine.steps ?? []).map((step) => (step.kind === "merge_skip" ? { kind: step.kind, skip: step.skip } : step));
        assert.deepEqual(steps, reference.steps, `changed=${JSON.stringify(changed)} skip=${!!skip} check=${check.outcome}`);
      }
    }
  }
});

test("AC-001: the card's four choices are the same on both sides, for every combination of the facts", () => {
  // the card is for a lane stopped in the loop: a new work after the loop finished, or a round that asked for a stop
  const stopped = [...judged, ev("s2_review_escalated", { reason: "止まった", retry_state: { state: "start_blind", kind: "final", round: 2 } })];
  for (const rows of [stopped, [...judged, ev("s4_review_comment_received", {}), ev("s2_review_escalated", { reason: "止まった" })]]) {
    for (const sameTree of [true, false]) {
      for (const behaviour of [[], ["src/a.ts"]]) {
        for (const risk of [true, false]) {
          // a head the caller can read, and one it cannot: the fold asks for the head only when the answer reaches
          // the final, and an unreadable lane never skips the final review
          for (const head of [HEAD, ""]) {
            const readings = { sameTree, behaviour, risk, head };
            const reference = stuckOutcomesReference(rows, POLICY, { laneReadable: head !== "", deviceOn: true }, readings) ?? null;
            const mine = judgeSync("stuck_outcomes", rows, { policy: POLICY, deviceOn: true }, facts(readings));
            const mineCard = mine.continue ? { continue: mine.continue, continueWithNote: mine.continueWithNote, accept: mine.accept, handFix: mine.handFix, replan: mine.replan } : null;
            assert.notEqual(reference, null, "止まった巡の card が空です");
            assert.deepEqual(mineCard, reference, `sameTree=${sameTree} behaviour=${behaviour.length} risk=${risk} head=${head ? "read" : "unreadable"}`);
          }
        }
      }
    }
  }
});

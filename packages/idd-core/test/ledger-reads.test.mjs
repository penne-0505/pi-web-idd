import assert from "node:assert/strict";
import { test } from "node:test";

import { FINAL_ENDS } from "../src/plan/close.ts";
import {
  awaitingMerge,
  closedLanes,
  laneEndedEvents,
  landedLanes,
  laneEnds,
  prDraftPick,
  retireKept,
  retirePick,
} from "../src/plan/ledger-reads.ts";
import {
  awaitingMergeReference,
  closedLanesReference,
  FINAL_ENDS_REFERENCE,
  LANE_ENDED_EVENTS_REFERENCE,
  landedLanesReference,
  laneEndsReference,
  prDraftPickReference,
  retireKeptReference,
  retirePickReference,
} from "../src/plan/ledger-reads-reference.ts";

// The ledger's remaining readings, as the running tick and intake ask for them. The answer is the MoonBit fold's;
// these tests hold it against the TypeScript reading over the same rows and the same facts, and pin the branches
// the stages depend on. That is the committed part of what the cross-check does against a real ledger
// (`packages/idd-fold/crosscheck.mjs`, C-205-6). The wall-clock behaviour of the stages is in `retire`, `pr-draft`
// and `intake`.

const at = (n) => `2026-10-24T0${n}:00:00.000Z`;
const row = (event, n, attrs = {}, idd = "IDD-1") => ({ event, idd_id: idd, at: at(n), attrs });

/** compare the fold's answer with the TypeScript reading over every prefix of the lane's rows */
function sameAtEveryPrefix(name, rows, facts = { path: "/w", reason: "session" }) {
  for (let n = 0; n <= rows.length; n += 1) {
    const prefix = rows.slice(0, n);
    assert.deepEqual(awaitingMerge(prefix), awaitingMergeReference(prefix), `${name}: the PR at ${n}`);
    assert.deepEqual(laneEnds(prefix), laneEndsReference(prefix), `${name}: the end at ${n}`);
    assert.equal(retirePick(prefix, facts), retirePickReference(prefix, facts), `${name}: the retirement at ${n}`);
    assert.equal(retireKept(prefix, facts), retireKeptReference(prefix, facts), `${name}: the kept at ${n}`);
    assert.equal(prDraftPick(prefix, { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: false }, () => ({ hasView: true, hasRepo: true })), prDraftPickReference(prefix, { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: false, hasView: true, hasRepo: true }), `${name}: the draft at ${n}`);
  }
}

test("the PR a lane waits on is the one its last submit left it on", () => {
  const rows = [
    row("lane_open", 1),
    row("s2_start", 2),
    row("s2_result", 3),
    row("s4_submit_started", 4),
    row("s4_pr_created", 5, { pr_number: 7, pr_url: "https://github.com/o/r/pull/7" }),
  ];
  assert.deepEqual(awaitingMerge(rows), { waiting: true, prNumber: 7, prUrl: "https://github.com/o/r/pull/7" });
  sameAtEveryPrefix("the PR", rows);
  // a push after the PR was created moves the lane on to the next submit
  assert.deepEqual(awaitingMerge([...rows, row("s4_pushed", 6)]), { waiting: false });
  // a PR found merged at the card is still a wait: the fix is only in the records
  assert.deepEqual(awaitingMerge([...rows, row("s4_merged", 6)]), { waiting: true, prNumber: 7, prUrl: "https://github.com/o/r/pull/7" });
  // a row without a number has none; a null number is 0, which the close can read
  assert.deepEqual(awaitingMerge([row("s4_pr_created", 1, { pr_url: "u" })]), { waiting: false });
  assert.deepEqual(awaitingMerge([row("s4_pr_created", 1, { pr_number: null })]), { waiting: true, prNumber: 0, prUrl: "" });
  const unreadable = [row("s4_pr_created", 1, { pr_number: "x" })];
  assert.deepEqual(awaitingMerge(unreadable), awaitingMergeReference(unreadable));
  sameAtEveryPrefix("an unreadable PR number", unreadable);
});

test("a lane's end is the same whether a final end closed it or penne took it out", () => {
  for (const outcome of ["merged", "local", "aborted", "dropped", "redone", undefined]) {
    const rows = [row("lane_open", 1), row("lane_close", 2, outcome === undefined ? {} : { outcome })];
    sameAtEveryPrefix(`a close of ${outcome}`, rows);
  }
  for (const event of ["s1_defer", "s3_defer"]) {
    sameAtEveryPrefix(event, [row("lane_open", 1), row(event, 2)]);
  }
});

test("the copy holds the ends itself, and a hold at S3 is not a final end", () => {
  // the lists the copy answers from are written in the copy: a fold that took the wrong end for a lane's makes the
  // comparisons below fail instead of both sides agreeing (C-206-1)
  assert.deepEqual([...FINAL_ENDS_REFERENCE], ["lane_close", "s1_defer"]);
  assert.deepEqual([...LANE_ENDED_EVENTS_REFERENCE], ["lane_close", "s1_defer", "s3_defer"]);
  // the running path's retire list is the fold's answer, so a fold that widened it to the hold at S3 would agree
  // with itself and clean up a held lane's worktree: the copy's list is the one this test was written from, and
  // comparing against it is what makes a wrong fold answer fail here instead of passing (the order means nothing)
  assert.deepEqual(
    [...FINAL_ENDS].sort(),
    [...FINAL_ENDS_REFERENCE].sort(),
    `退役の終わりの一覧: 畳み ${JSON.stringify([...FINAL_ENDS])} / 写し ${JSON.stringify([...FINAL_ENDS_REFERENCE])}`,
  );
  const hold = [row("lane_open", 1), row("s3_defer", 2)];
  // 保留 says the lane may be taken up again: its worktree stays, and penne did not take it out
  assert.deepEqual(laneEndsReference(hold), { finally: false, discarded: false });
  assert.equal(retirePickReference(hold, { hasWorktreePath: true, hasLocalPath: true, hasWorkBase: true, exists: true }), false);
  // intake reads the wider list: the hold still ends the lane there
  assert.equal(closedLanesReference(hold).has("IDD-1"), true);
});

test("the worktree is retired only when every fact the pass gathered is there", () => {
  const rows = [row("lane_open", 1), row("lane_close", 2, { outcome: "merged" })];
  const combos = [];
  for (const hasWorktreePath of [true, false]) {
    for (const hasLocalPath of [true, false]) {
      for (const hasWorkBase of [true, false]) {
        for (const exists of [true, false]) combos.push({ hasWorktreePath, hasLocalPath, hasWorkBase, exists });
      }
    }
  }
  for (const facts of combos) {
    assert.equal(retirePick(rows, facts), retirePickReference(rows, facts), JSON.stringify(facts));
  }
  // a hold at S3 says the lane may be taken up again
  assert.equal(retirePick([row("s3_defer", 1)], combos[0]), false);
  sameAtEveryPrefix("the retirement", rows, { ...combos[0], path: "/w", reason: "session" });
});

test("a kept record is written once for one path and one reason", () => {
  const rows = [row("lane_open", 1), row("lane_close", 2), row("lane_worktree_kept", 3, { path: "/w", reason: "session" })];
  assert.equal(retireKept(rows, { path: "/w", reason: "session" }), false);
  assert.equal(retireKept(rows, { path: "/w", reason: "dirty" }), true);
  assert.equal(retireKept(rows, { path: "/x", reason: "session" }), true);
  assert.equal(retireKept([row("lane_open", 1)], { path: "/w", reason: "session" }), true);
  sameAtEveryPrefix("the kept", rows, { path: "/w", reason: "session" });
});

test("the PR text is drafted only when the repo publishes, the runner drafts, and no PR is open", () => {
  const rows = [
    row("lane_open", 1),
    row("s4_submit_started", 2),
    row("s4_pr_draft_failed", 3, { error: "boom" }),
    row("s4_submit_started", 4),
  ];
  const readings = () => ({ hasView: true, hasRepo: true });
  const cases = [
    { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: false },
    { publishes: false, hasDraftRunner: true, hasPrDraft: false, openPr: false },
    { publishes: true, hasDraftRunner: false, hasPrDraft: false, openPr: false },
    { publishes: true, hasDraftRunner: true, hasPrDraft: true, openPr: false },
    { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: true },
  ];
  for (const facts of cases) {
    assert.equal(prDraftPick(rows, facts, readings), prDraftPickReference(rows, { ...facts, hasView: true, hasRepo: true }), JSON.stringify(facts));
  }
  // the view and the repo are read only once the cheaper readings have passed (C-200-2)
  let read = 0;
  const counted = () => {
    read += 1;
    return { hasView: true, hasRepo: true };
  };
  prDraftPick(rows, { publishes: false, hasDraftRunner: true, hasPrDraft: false, openPr: false }, counted);
  assert.equal(read, 0);
  prDraftPick(rows, { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: false }, counted);
  assert.equal(read, 1);
  // a failed draft before this submit does not stop the next one, one after it does
  const after = [row("lane_open", 1), row("s4_submit_started", 2), row("s4_pr_draft_failed", 3)];
  const facts = { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: false };
  assert.equal(prDraftPick(after, facts, readings), false);
  assert.equal(prDraftPick(after.slice(0, 2), facts, readings), true);
  sameAtEveryPrefix("the draft", rows);
});

test("intake leaves out the lanes that ended, and the ones whose Issue was landed", () => {
  const events = [
    row("lane_open", 1, {}, "IDD-1"),
    row("s1_defer", 2, {}, "IDD-1"),
    row("lane_close", 3, { merged_commit: "abc" }, "IDD-2"),
    row("lane_open", 4, {}, "IDD-2"),
    row("lane_close", 5, {}, "IDD-3"),
    row("s3_defer", 6, {}, "IDD-3"),
    row("lane_open", 7, {}, "IDD-4"),
  ];
  assert.deepEqual([...closedLanes(events)], [...closedLanesReference(events)]);
  assert.deepEqual([...landedLanes(events)], [...landedLanesReference(events)]);
  assert.deepEqual([...landedLanes(events)], ["IDD-2"]);
  // a row whose `at` is not a time is still a close, with no time
  const unreadable = [row("lane_open", 1), { event: "lane_close", idd_id: "IDD-9", at: "読めない", attrs: {} }];
  const mine = closedLanes(unreadable);
  const theirs = closedLanesReference(unreadable);
  assert.equal(mine.has("IDD-9"), true);
  assert.equal(Number.isNaN(mine.get("IDD-9")), true);
  assert.deepEqual([...mine.keys()], [...theirs.keys()]);
  assert.deepEqual(laneEndedEvents(), ["lane_close", "s1_defer", "s3_defer"]);
});

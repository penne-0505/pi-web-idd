import assert from "node:assert/strict";
import { test } from "node:test";

import { laneAnswer } from "../src/intent/moonbit-fold.ts";
import { preMergeReference } from "../src/plan/pre-merge-reference.ts";

// The mainline merge before a lane's first review, as the running tick asks for it. The answer is the MoonBit fold's;
// these tests pin the steps the tick's readers already depend on, and hold the fold against the TypeScript reading
// over the same rows and the same observations. That is the committed part of what the cross-check does against a real
// ledger (`packages/idd-fold/crosscheck.mjs`, C-205-5). The wall-clock behaviour of the merge is in `review-pre-merge`.

const LANE = "IDD-1";
const row = (event, attrs = {}) => ({ idd_id: LANE, event, at: "2026-10-23T10:00:00.000Z", attrs });

/** the rows of a lane whose executor has started, and whose review has not begun */
const atMerge = () => [row("lane_open"), row("s2_start", { started_from_commit: "base" }), row("s2_result")];

/** the observations of a lane whose merge is its own: a repo that does not publish, and a base it can read */
function factsOf(extra = {}) {
  return {
    "hasLocation||": true,
    "publishes||": false,
    "hasLocalPath||": true,
    "hasWorkBase||": true,
    "baseReadable||": true,
    "hasReviewBase||": true,
    "head||": "head",
    "mainTip||": "tip",
    "readError||": "",
    "ancestor||": { headHas: false, baseHas: false },
    "ancestorError||": "",
    "runnerPresent||": true,
    "busy||": false,
    "busyError||": "",
    ...extra,
  };
}

const LOCKED = { "call|lock_lane|merge": { held: true } };
const CONFLICTED = { "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, conflict: true, files: ["app.txt"] } };
const CLEAN = { "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, conflict: false, files: [], tree: "tree" } };

/**
 * The observations split as the caller keeps them: the readings it gathered, and the answers of the helpers the fold
 * calls. A helper's answer is not handed in before it is called, so the steps stay the fold's to name.
 */
function split(facts) {
  const plain = {};
  const answers = {};
  for (const [id, value] of Object.entries(facts)) (id.startsWith("call|") ? answers : plain)[id] = value;
  return { plain, answers };
}

/** one answer's steps run: a write joins the rows, a call's answer is kept under the fact it named */
function drive(ask, rows, facts) {
  const { plain, answers } = split(facts);
  const read = [...rows];
  const given = { ...plain };
  const trail = [];
  for (let round = 0; round < 24; round += 1) {
    const step = ask(read, { ...given });
    const list = step.steps ?? [step];
    for (const one of list) {
      trail.push(one);
      if (one.do === "action") return { trail, action: one.action, ...(one.error ? { error: one.error } : {}) };
      if (one.do === "write") {
        read.push(row(one.event, one.attrs ?? {}));
        if (one.action) return { trail, action: one.action };
        continue;
      }
      given[one.fact] = { result: answers[one.fact] ?? {}, keep: one.keep ?? {} };
    }
  }
  throw new Error("本流の取り込みの一歩が終わりませんでした");
}

/** the answer of the merge and of the TypeScript reading, over the same rows and the same observations */
function both(rows, facts) {
  const mine = drive((read, f) => laneAnswer("pre_merge", read, { facts: f }), rows, facts);
  const theirs = drive((read, f) => preMergeReference(read, f), rows, facts);
  assert.deepEqual(mine, theirs, "畳みと TS の読みが食い違いました");
  return mine;
}

const helpers = (trail) => trail.filter((step) => step.do === "call").map((step) => `${step.helper}|${step.site}`);
const writes = (trail) => trail.filter((step) => step.do === "write").map((step) => step.event);

test("AC-002: a repo that publishes is not this merge's, and a lane with no review origin neither", () => {
  assert.deepEqual(both(atMerge(), factsOf({ "publishes||": true })), { trail: [{ do: "action", action: "none" }], action: "none" });
  assert.deepEqual(both(atMerge(), factsOf({ "hasReviewBase||": false })), { trail: [{ do: "action", action: "none" }], action: "none" });
});

test("AC-001/AC-004: the merge moves the origin, merges, and answers merged", () => {
  const answer = both(atMerge(), factsOf({
    ...LOCKED, ...CLEAN,
    "call|review_base|merge": { reviewBase: "rb" },
    "call|merge_mainline|merge": {},
  }));
  assert.deepEqual(helpers(answer.trail), ["lock_lane|merge", "read_merge_state|merge", "review_base|merge", "merge_mainline|merge"]);
  assert.deepEqual(writes(answer.trail), []);
  assert.deepEqual(answer.trail.find((step) => step.helper === "merge_mainline").args, { head: "head", mainline: "tip", tree: "tree", reviewBase: "rb" });
  assert.equal(answer.action, "merged");
});

test("AC-004: a head that already carries the mainline moves only the review origin", () => {
  const facts = factsOf({
    "ancestor||": { headHas: true, baseHas: false },
    "call|review_base|head_has": { reviewBase: "rb" },
    "call|record_executor_merge|head_has": {},
  });
  const answer = both(atMerge(), facts);
  assert.deepEqual(helpers(answer.trail), ["review_base|head_has", "record_executor_merge|head_has"]);
  assert.deepEqual(answer.trail.find((step) => step.helper === "record_executor_merge").keep, { head: "head", mainline: "tip" });
  assert.equal(answer.action, "merged");
});

test("AC-004: a first conflict records the wait, sends the instruction, and leaves the lane awaiting", () => {
  const facts = factsOf({
    ...LOCKED, ...CONFLICTED,
    "call|conflict_envelope|conflict": { ok: true },
  });
  const answer = both(atMerge(), facts);
  assert.deepEqual(writes(answer.trail), ["s2_review_base_conflict", "s2_review_base_instructed"]);
  assert.deepEqual(helpers(answer.trail), ["lock_lane|merge", "read_merge_state|merge", "conflict_envelope|conflict"]);
  assert.deepEqual(answer.trail[2].attrs, { head: "head", mainline: "tip", files: ["app.txt"], awaiting: true });
  assert.deepEqual(answer.trail.at(-1).attrs, { head: "head", mainline: "tip", files: ["app.txt"] });
  assert.equal(answer.action, "awaiting");
});

test("AC-004: a conflict the executor was already put to advances the origin and lets the review go on", () => {
  const rows = [...atMerge(), row("s2_review_base_conflict", { head: "head", mainline: "tip", files: ["app.txt"], awaiting: true }), row("s2_review_base_instructed", { head: "head", mainline: "tip", files: ["app.txt"] })];
  const answer = both(rows, factsOf({ ...LOCKED, ...CONFLICTED, "call|advance_origin|conflict": {} }));
  assert.deepEqual(helpers(answer.trail), ["lock_lane|merge", "read_merge_state|merge", "advance_origin|conflict"]);
  assert.deepEqual(writes(answer.trail), []);
  assert.equal(answer.action, "proceed");
});

test("AC-004: an instruction that cannot be queued leaves the wait on record and the lane awaiting", () => {
  const answer = both(atMerge(), factsOf({
    ...LOCKED, ...CONFLICTED,
    "call|conflict_envelope|conflict": { error: "封筒が積めません" },
  }));
  assert.deepEqual(writes(answer.trail), ["s2_review_base_conflict"]);
  assert.equal(answer.action, "awaiting");
  assert.equal(answer.error, "解消の指示を積めませんでした: 封筒が積めません");
});

test("AC-002: a head that cannot be read writes the skip once, and the review goes on", () => {
  const facts = factsOf({ "head||": "", "readError||": "bad object" });
  const answer = both(atMerge(), facts);
  assert.deepEqual(writes(answer.trail), ["s2_review_base_skipped"]);
  assert.deepEqual(answer.trail[0].attrs, { reason: "レビュー前の merge に要る commit を読めません: bad object" });
  assert.equal(answer.action, "proceed");
  // the same head and mainline, read as nothing again: the skip is on record, so it is not written a second time
  const again = both([...atMerge(), row("s2_review_base_skipped", { reason: "レビュー前の merge に要る commit を読めません: bad object" })], facts);
  assert.deepEqual(again, { trail: [{ do: "action", action: "proceed" }], action: "proceed" });
});

test("AC-004: a mainline that cannot be read is the same one skip, never a write on every pass", () => {
  const answer = both(atMerge(), factsOf({ "mainTip||": "" }));
  assert.deepEqual(writes(answer.trail), ["s2_review_base_skipped"]);
  assert.deepEqual(answer.trail[0].attrs, { reason: "レビュー前の merge に要る commit を読めません: " });
  assert.equal(answer.action, "proceed");
});

test("AC-002: the merge's own readings each answer a skip with their reason", () => {
  const cases = [
    [{ "call|lock_lane|merge": { held: false, error: "取られています" } }, "lane の lock を取れません: 取られています"],
    [{ ...LOCKED, "call|read_merge_state|merge": { error: "index が壊れています" } }, "レビュー前の本流の merge に失敗しました: index が壊れています"],
    [{ ...LOCKED, "call|read_merge_state|merge": { clean: false } }, "lane に未 commit の変更があります"],
    [{ ...LOCKED, "call|read_merge_state|merge": { clean: true, onBranch: false } }, "lane の worktree が lane の branch にありません"],
    [{ ...LOCKED, "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: false } }, "lane の head が変わりました"],
    [{ ...LOCKED, "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, unreadable: true, mergeError: "boom" } }, "merge-tree が答えられません: boom"],
    [{ ...LOCKED, ...CLEAN, "call|review_base|merge": { error: "進めません" } }, "起点を進められません: 進めません"],
    [{ ...LOCKED, ...CLEAN, "call|review_base|merge": {}, "call|merge_mainline|merge": { error: "commit が作れません" } }, "レビュー前の本流の merge に失敗しました: commit が作れません"],
  ];
  for (const [extra, reason] of cases) {
    const answer = both(atMerge(), factsOf(extra));
    assert.deepEqual(writes(answer.trail), ["s2_review_base_skipped"], reason);
    assert.equal(answer.trail.at(-1).attrs.reason, reason);
    assert.equal(answer.action, "proceed");
  }
  // a reading the merge reads before git is the same: a failure changes the answer, never throws
  assert.equal(both(atMerge(), factsOf({ "ancestor||": null, "ancestorError||": "git が答えません" })).trail.at(-1).attrs.reason,
    "レビュー前の merge の要否を git が答えられません: git が答えません");
  assert.equal(both(atMerge(), factsOf({ "runnerPresent||": false })).trail.at(-1).attrs.reason,
    "agent の runtime が無いので、この worktree で session が動いていないか確かめられません");
});

test("AC-002: a lane at work in the worktree is left to finish, and its busy read failing is a skip", () => {
  assert.deepEqual(both(atMerge(), factsOf({ "busy||": true })), { trail: [{ do: "action", action: "busy" }], action: "busy" });
  const unread = both(atMerge(), factsOf({ "busyError||": "読めません" }));
  assert.equal(unread.trail.at(-1).attrs.reason, "worktree の session の有無を確かめられません: 読めません");
});

// ---- generated files made again before the first review (C-266-1 / C-266-2) ----

const GEN_CONFLICT = { "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, conflict: true, files: ["gen.txt"], tree: "marked", outputs: ["gen.txt"], generatedOnly: true } };
const GEN_TOUCHED = { "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, conflict: false, files: [], tree: "tree", outputs: ["gen.txt"], rebuild: true } };
const FAILURE = { cause: "build", reason: "コマンドが失敗しました", paths: ["gen.txt"] };
const MERGES = { "call|review_base|merge": { reviewBase: "rb" }, "call|merge_mainline|merge": {} };
const SENT = { "call|conflict_envelope|conflict": { ok: true } };
const REBUILDS = ["lock_lane|merge", "read_merge_state|merge", "rebuild_generated|merge", "review_base|merge", "merge_mainline|merge"];

/** the answer of a merge whose state is read as `state`, with the calls it makes answered as `calls` */
const run = (state, calls, rows = atMerge()) => both(rows, factsOf({ ...LOCKED, ...state, ...calls }));
const argsOf = (answer, helper) => answer.trail.find((step) => step.helper === helper)?.args;
const attrsOf = (answer, event) => answer.trail.find((step) => step.event === event)?.attrs;
/** the attrs of a conflict record for the generated file (or `files`) at this head and mainline */
const conflictAttrs = (awaiting, extra = {}, files = ["gen.txt"]) => ({ head: "head", mainline: "tip", files, awaiting, ...extra });
const conflictRow = (rebuild_failure) => row("s2_review_base_conflict", conflictAttrs(true, rebuild_failure ? { rebuild_failure } : {}));
const INSTRUCTED = row("s2_review_base_instructed", { head: "head", mainline: "tip", files: ["gen.txt"] });
const SENDS = ["s2_review_base_conflict", "s2_review_base_instructed"];

test("AC-001: a conflict on generated files alone is made again, then merged from the rebuilt tree without the executor", () => {
  const answer = run(GEN_CONFLICT, { "call|rebuild_generated|merge": { tree: "rebuilt" }, ...MERGES });
  assert.deepEqual(helpers(answer.trail), REBUILDS);
  assert.deepEqual(argsOf(answer, "rebuild_generated"), { tree: "marked", outputs: ["gen.txt"] });
  assert.deepEqual(argsOf(answer, "merge_mainline"), { head: "head", mainline: "tip", tree: "rebuilt", reviewBase: "rb" });
  assert.deepEqual(writes(answer.trail), []);
  assert.equal(answer.action, "merged");
});

test("AC-001: a merge that touched a generated file without a conflict is made again too, and one that touched none is not", () => {
  const answer = run(GEN_TOUCHED, { "call|rebuild_generated|merge": { tree: "rebuilt" }, ...MERGES });
  assert.deepEqual(helpers(answer.trail), REBUILDS);
  assert.equal(argsOf(answer, "merge_mainline").tree, "rebuilt");
  assert.equal(helpers(run(CLEAN, MERGES).trail).includes("rebuild_generated|merge"), false);
});

test("AC-002: a conflict with a source in it is the executor's as before, and nothing is made again", () => {
  const files = ["gen.txt", "src.txt"];
  const mixed = { "call|read_merge_state|merge": { ...CONFLICTED["call|read_merge_state|merge"], files, tree: "marked", generatedOnly: false, rebuild: true } };
  const answer = run(mixed, SENT);
  assert.deepEqual(helpers(answer.trail), ["lock_lane|merge", "read_merge_state|merge", "conflict_envelope|conflict"]);
  assert.deepEqual(writes(answer.trail), SENDS);
  assert.deepEqual(answer.trail[2].attrs, { head: "head", mainline: "tip", files, awaiting: true });
  assert.equal(answer.action, "awaiting");
});

test("AC-003: a rebuild that failed on a generated-only conflict puts the executor to it, with the failure on the record", () => {
  const failed = { "call|rebuild_generated|merge": { failure: FAILURE } };
  const answer = run(GEN_CONFLICT, { ...failed, ...SENT });
  assert.deepEqual(helpers(answer.trail), ["lock_lane|merge", "read_merge_state|merge", "rebuild_generated|merge", "conflict_envelope|conflict"]);
  assert.deepEqual(writes(answer.trail), SENDS);
  assert.deepEqual(attrsOf(answer, "s2_review_base_conflict"), conflictAttrs(true, { rebuild_failure: FAILURE }));
  assert.equal(answer.action, "awaiting");
  // a conflict the executor was already put to carries it on the record that lets the review go on
  const again = run(GEN_CONFLICT, { ...failed, "call|advance_origin|conflict": {} }, [...atMerge(), INSTRUCTED]);
  assert.deepEqual(attrsOf(again, "s2_review_base_conflict"), conflictAttrs(false, { rebuild_failure: FAILURE }));
});

test("AC-003: a conflict record already there stands for this rebuild failure only when it carries the same one", () => {
  const calls = (extra = {}) => ({ "call|rebuild_generated|merge": { failure: FAILURE }, ...SENT, ...extra });
  const ADVANCE = { "call|advance_origin|conflict": {} };
  // a record without the failure, or with another one, does not say why this rebuild could not be made: the failure is written once
  for (const earlier of [conflictRow(null), conflictRow({ ...FAILURE, cause: "environment" }), conflictRow({ ...FAILURE, paths: ["other.txt"] })]) {
    const answer = run(GEN_CONFLICT, calls(), [...atMerge(), earlier]);
    assert.deepEqual(writes(answer.trail), SENDS);
    assert.deepEqual(attrsOf(answer, "s2_review_base_conflict"), conflictAttrs(true, { rebuild_failure: FAILURE }));
  }
  // the same failure is on record already, whatever the reason's words: nothing is written again before the instruction
  assert.deepEqual(writes(run(GEN_CONFLICT, calls(), [...atMerge(), conflictRow({ ...FAILURE, reason: "別の tmp の path" })]).trail), ["s2_review_base_instructed"]);
  // an executor already put to the conflict: the failure goes on a record that lets the review go on, once
  const late = run(GEN_CONFLICT, calls(ADVANCE), [...atMerge(), conflictRow(null), INSTRUCTED]);
  assert.deepEqual(attrsOf(late, "s2_review_base_conflict"), conflictAttrs(false, { rebuild_failure: FAILURE }));
  assert.equal(late.action, "proceed");
  const done = run(GEN_CONFLICT, calls(ADVANCE), [...atMerge(), conflictRow(FAILURE), INSTRUCTED]);
  assert.deepEqual([writes(done.trail), done.action], [[], "proceed"]);
  // a conflict with no failure to say is written once, as before
  assert.deepEqual(writes(run(CONFLICTED, SENT, [...atMerge(), conflictRow(null)]).trail), ["s2_review_base_instructed"]);
});

test("AC-003: a rebuild that failed on a merge git made goes in as git made it, with the failure on the merge's record call", () => {
  const failure = { ...FAILURE, cause: "environment" };
  const answer = run(GEN_TOUCHED, { "call|rebuild_generated|merge": { failure }, ...MERGES });
  assert.deepEqual(argsOf(answer, "merge_mainline"), { head: "head", mainline: "tip", tree: "tree", reviewBase: "rb", rebuildFailure: failure });
  assert.deepEqual([writes(answer.trail), answer.action], [[], "merged"]);
});

test("AC-006: a conflict the caller did not read as generated-only is the executor's, whatever else it says", () => {
  const plain = { "call|read_merge_state|merge": { ...CONFLICTED["call|read_merge_state|merge"], files: ["gen.txt"], tree: "marked" } };
  const answer = run(plain, SENT);
  assert.equal(helpers(answer.trail).includes("rebuild_generated|merge"), false);
  assert.deepEqual(attrsOf(answer, "s2_review_base_conflict"), conflictAttrs(true));
});

test("AC-002: the merge asks for the readings it has not been given, in the fold's order", () => {
  const facts = factsOf();
  delete facts["busy||"];
  const mine = laneAnswer("pre_merge", atMerge(), { facts });
  const theirs = preMergeReference(atMerge(), facts);
  assert.deepEqual(mine, theirs);
  assert.deepEqual(mine.needs, [{ id: "busy||", kind: "busy", a: "", b: "" }]);
});

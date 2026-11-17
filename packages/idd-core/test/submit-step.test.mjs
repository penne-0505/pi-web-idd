import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeSync } from "../src/ledger/review-loop.ts";
import { submitStepReference } from "../src/plan/submit-step-reference.ts";
import { laneAnswer } from "../src/intent/moonbit-fold.ts";

// The push's next step, as the running tick asks for it. The answer is the MoonBit fold's; these tests pin the
// steps the tick's readers already depend on, and hold the fold against the TypeScript reading over the same rows
// and the same observations. That is the committed part of what the cross-check does against a real ledger
// (`packages/idd-fold/crosscheck.mjs`, C-202-1). The wall-clock behaviour of the stage is in `ship-approval`.

const HEAD = "a".repeat(40);
const SEEN = "b".repeat(40);
const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const row = (event, attrs = {}) => ({ event, idd_id: "IDD-1", at: "2026-10-23T10:00:00.000Z", attrs });

/** the rows of a lane at the submit card */
const atCard = () => [
  row("lane_open"), row("s2_start"), row("s2_result"), row("s3_ready"), row("s3_ok"), row("s4_submit_started"),
];

/** the observations of a lane with nothing in the way */
function factsOf(extra = {}) {
  const started = String(5);
  return {
    [`head|IDD-1|`]: HEAD,
    [`now|IDD-1|`]: NOW,
    [`proposal|IDD-1|`]: null,
    [`unsaved|IDD-1|`]: null,
    [`unsavedOutdated|IDD-1|`]: false,
    [`pr|IDD-1|`]: null,
    [`shipFailedAt|IDD-1|${started}`]: null,
    [`location|IDD-1|`]: true,
    [`outdated|IDD-1|`]: { reason: null, threw: false },
    [`unreviewed|IDD-1|`]: null,
    [`carries|IDD-1|`]: false,
    [`unpublished|IDD-1|`]: true,
    [`openPr|IDD-1|`]: false,
    [`runnerDraft|IDD-1|`]: false,
    [`prDraft|IDD-1|`]: null,
    [`prDraftFailed|IDD-1|${started}`]: false,
    [`submitView|IDD-1|`]: { title: "feat: 題", body: "- 本文" },
    [`gone|IDD-1|`]: null,
    ...extra,
  };
}

const saved = (extra = {}) => ({
  status: "prepared", head: HEAD, mode: "publish", blocking: 0,
  expiresAt: new Date(NOW + 3600_000).toISOString(), token: "T-1", ...extra,
});
const pr = { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" };
const keep = { id: "IDD-1", head: HEAD, hasPr: true, what: "PR の確認に失敗しました" };

/** the prefix, the observations, and what the reading outside the ledger says */
const cases = [
  ["nothing new", atCard(), factsOf()],
  ["a checked submit inside its window", atCard(), factsOf({ [`proposal|IDD-1|`]: saved(), })],
  ["a checked submit past its window", atCard(), factsOf({ [`proposal|IDD-1|`]: saved({ expiresAt: new Date(NOW - 1000).toISOString() }) })],
  ["a change the review did not see", atCard(), factsOf({ [`proposal|IDD-1|`]: saved(), [`unreviewed|IDD-1|`]: { reason: "レビューが見ていない", seen: SEEN } })],
  ["a push that reached the branch without its record", atCard(), factsOf({ [`unsaved|IDD-1|`]: { token: "U-1", head: HEAD } })],
  ["an unsaved push its token can no longer finish", atCard(), factsOf({ [`unsaved|IDD-1|`]: { token: "U-2", head: HEAD }, [`unsavedOutdated|IDD-1|`]: true })],
  ["the unsaved push put on record, read again", atCard(), factsOf({
    [`unsaved|IDD-1|`]: { token: "U-3", head: HEAD }, [`unsavedOutdated|IDD-1|`]: true,
    "call|record_unsaved_push|outdated": { keep: { id: "IDD-1" }, result: null },
    "call|settle_unsaved|outdated": { keep: { id: "IDD-1" }, result: null },
  })],
  ["the lock refusing the unsaved push's record", atCard(), factsOf({
    [`unsaved|IDD-1|`]: { token: "U-4", head: HEAD }, [`unsavedOutdated|IDD-1|`]: true,
    "err|record_unsaved_push|outdated": { error: "検査が走っています", lockRefused: true },
  })],
  ["a push waiting on its PR, the check failed a moment ago", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    [`shipFailedAt|IDD-1|5`]: new Date(NOW - 60_000).toISOString(),
  })],
  ["a push waiting on its PR, the check failed past the retry", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    [`shipFailedAt|IDD-1|5`]: new Date(NOW - 3600_000).toISOString(),
  })],
  ["the follow-up came back with the lock", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    "call|settle_pushed|retry": { keep, result: { ok: false, lockRefused: true, error: "検査が走っています" } },
  })],
  ["the PR was merged", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    "call|settle_pushed|retry": { keep, result: { ok: true, merged: true } },
  })],
  ["the push made no PR", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    "call|settle_pushed|retry": { keep, result: { ok: true, previousPr: { number: 7, state: "OPEN", headRefOid: SEEN } } },
  })],
  ["the earlier PR was merged before this push", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    "call|settle_pushed|retry": { keep, result: { ok: true, previousPr: { number: 7, state: "MERGED", headRefOid: SEEN } } },
  })],
  ["the failure after the push is the environment's", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    "call|settle_pushed|retry": { keep, result: { ok: false, permanent: true, error: "base が変わりました" } },
  })],
  ["the failure after the push is the change's", [...atCard(), row("s4_pushed", { commit: HEAD })], factsOf({
    [`proposal|IDD-1|`]: saved({ status: "pushed" }), [`pr|IDD-1|`]: pr,
    "call|settle_pushed|retry": { keep, result: { ok: false, error: "PR の確認に失敗しました" } },
  })],
  ["the check could not be made", atCard(), factsOf({ "err|propose_admitted|checked": { error: "connection reset", lockRefused: false } })],
  ["the check found nothing public to push", atCard(), factsOf({ "call|propose_admitted|checked": { keep: { id: "IDD-1" }, result: { status: "prepared", mode: "local", blocking: 0, token: "T-9" } } })],
  ["the check did not pass", atCard(), factsOf({ "call|propose_admitted|checked": { keep: { id: "IDD-1" }, result: { status: "prepared", mode: "publish", blocking: 2, token: "T-10", blockingSummary: "test が 2 件落ちた" } } })],
  ["the branch already carries the checked tree", atCard(), factsOf({ "call|propose_admitted|checked": { keep: { id: "IDD-1" }, result: saved({ token: "T-11" }) }, [`carriesOf|IDD-1|T-11`]: true })],
  ["the check made a new submit", atCard(), factsOf({ "call|propose_admitted|checked": { keep: { id: "IDD-1" }, result: saved({ token: "T-12" }) }, [`carriesOf|IDD-1|T-12`]: false })],
  ["the PR text is still being drafted", atCard(), factsOf({ [`runnerDraft|IDD-1|`]: true })],
  ["a PR merged with nothing public since", atCard(), factsOf({
    [`pr|IDD-1|`]: pr, [`unpublished|IDD-1|`]: false,
    "call|settle_merged_pr|merged": { keep: { id: "IDD-1" }, result: pr },
  })],
];

/** the fold's answer, with the observations it asked for read from the same dictionary */
function foldAnswer(events, facts) {
  return judgeSync("submit_step", events, { facts }, (need) => (need.id in facts ? facts[need.id] : null));
}

test("the fold answers the push's steps the TypeScript reading gives, over the same rows and observations", () => {
  for (const [where, events, facts] of cases) {
    const mine = foldAnswer(events, facts);
    const theirs = submitStepReference(events, facts);
    assert.deepEqual(JSON.parse(JSON.stringify(mine.steps ?? [])), JSON.parse(JSON.stringify(theirs.steps)), where);
  }
});

test("a checked submit inside its window is drafted for and left for the card", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(submitStepReference(atCard(), factsOf({ [`proposal|IDD-1|`]: saved() })).steps)), [
    { do: "call", helper: "draft_commit_message", site: "ready", fact: "call|draft_commit_message|ready", keep: { id: "IDD-1" }, args: { id: "IDD-1", head: HEAD, saved: saved() }, fatal: true, reread: false },
  ]);
});

test("a push that reached the branch without its record is put on record, and the ledger is read again", () => {
  const unsaved = { token: "U-3", head: HEAD };
  const first = foldAnswer(atCard(), factsOf({ [`unsaved|IDD-1|`]: unsaved, [`unsavedOutdated|IDD-1|`]: true })).steps;
  assert.deepEqual(JSON.parse(JSON.stringify(first)), [
    { do: "call", helper: "record_unsaved_push", site: "outdated", fact: "call|record_unsaved_push|outdated", keep: { id: "IDD-1" }, args: { id: "IDD-1", unsaved }, fatal: false, reread: false },
  ]);
  // the record is written: the settle follows, and the ledger is read again after it
  const second = foldAnswer(atCard(), factsOf({
    [`unsaved|IDD-1|`]: unsaved, [`unsavedOutdated|IDD-1|`]: true,
    "call|record_unsaved_push|outdated": { keep: { id: "IDD-1" }, result: null },
  })).steps;
  assert.deepEqual(JSON.parse(JSON.stringify(second)), [
    { do: "call", helper: "settle_unsaved", site: "outdated", fact: "call|settle_unsaved|outdated", keep: { id: "IDD-1" }, args: { id: "IDD-1" }, fatal: false, reread: true },
  ]);
});

test("a fold that cannot be read is a failure the caller sees", () => {
  assert.throws(() => laneAnswer("no_such_answer", []), /MoonBit の畳み/);
});

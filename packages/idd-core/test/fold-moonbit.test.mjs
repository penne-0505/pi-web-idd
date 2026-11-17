import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { foldRows, laneStates } from "../src/intent/store.ts";
import { boundaryText } from "../src/intent/moonbit-fold.ts";
import { foldRowsTs, laneStatesTs } from "../src/intent/fold-reference.ts";

/**
 * The MoonBit fold and the TypeScript fold, held against committed fixtures.
 *
 * A real ledger lives outside git and the test entry drops the `IDD_` variables, so a test cannot see one. What
 * a real ledger would add — the five events the real column happens never to carry, a row without `by`, an
 * unreadable `at`, a row written after its lane ended, the older Place forms — is written here instead, so this
 * check answers the same on every machine (C-186-4). The real ledger is checked by `packages/idd-fold/crosscheck.mjs`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "fold");

function rowsOf(name) {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${name} の ${index + 1} 行目が JSON ではありません: ${String(error)}`);
      }
    });
}

/** the answer without the keys a JSON round trip leaves out, so an absent field and an undefined one are one */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const lifecycle = rowsOf("lifecycle.jsonl");
const intent = rowsOf("intent.jsonl");

/** every viewer the comparison looks through: the lane's outside, every lane the lifecycle names, every raiser */
function viewersOf() {
  const lanes = new Set();
  for (const row of lifecycle) if (typeof row.idd_id === "string") lanes.add(row.idd_id);
  for (const row of intent) if (row.by && typeof row.by === "object" && typeof row.by.lane === "string") lanes.add(row.by.lane);
  return [null, ...[...lanes].sort()];
}

/** the events the fold reads by name; the fixture has to carry every one of them */
const INTENT_EVENTS = [
  "purpose_raised", "purpose_restated", "purpose_confirmed", "purpose_retired", "purpose_withdrawn",
  "choice_raised", "choice_superseded", "choice_reanchored", "places_moved", "places_module",
  "choice_confirmed", "choice_dropped", "waive", "harm_example_added",
];
/** the named fields of a view, to compare as one object */
const pick = (view, ...keys) => Object.fromEntries(keys.map((key) => [key, view[key]]));
const LIFECYCLE_EVENTS = ["lane_close", "s1_defer", "s3_defer", "s1_go"];

test("AC-002: the fixture carries every event the fold reads, and one it does not", () => {
  const seen = new Set(intent.map((row) => row.event));
  for (const event of INTENT_EVENTS) assert.ok(seen.has(event), `意図の列の fixture に ${event} がありません`);
  assert.ok([...seen].some((event) => !INTENT_EVENTS.includes(event)), "知らない event の行が fixture にありません");
  const seenLifecycle = new Set(lifecycle.map((row) => row.event));
  for (const event of LIFECYCLE_EVENTS) assert.ok(seenLifecycle.has(event), `lifecycle の fixture に ${event} がありません`);
  assert.ok([...seenLifecycle].some((event) => !LIFECYCLE_EVENTS.includes(event)), "知らない lifecycle の event が fixture にありません");
});

test("AC-002: both folds answer the same lane states for the fixture's lifecycle", () => {
  const mine = Object.fromEntries(laneStates(lifecycle));
  const reference = Object.fromEntries(laneStatesTs(lifecycle));
  assert.deepEqual(plain(mine), plain(reference));
  // the cases the fixture is there for: the earliest landing, three kinds of ending, the GO's purposes
  assert.equal(mine["IDD-1"].mergedAt, "2026-10-13T03:00:00.000Z");
  assert.equal(mine["IDD-1"].endedAt, "2026-10-13T03:00:00.000Z");
  assert.equal(mine["IDD-2"].mergedAt, "2026-10-13T04:00:00.000Z");
  assert.equal(mine["IDD-3"].mergedAt, undefined);
  assert.equal(mine["IDD-3"].endedAt, "2026-10-13T04:30:00.000Z");
  assert.equal(mine["IDD-4"].endedAt, "2026-10-13T02:00:00.000Z");
  assert.equal(mine["IDD-5"].endedAt, "2026-10-13T02:30:00.000Z");
  assert.deepEqual(mine["IDD-6"].purposes, [
    { id: "P-7", name: "別の名" },
    { id: "P-7", name: "三つ目" },
    { id: "P-9" },
  ]);
  // an event the lane state does not read still gives its lane an entry, as the TypeScript fold did
  assert.deepEqual(mine["IDD-7"], {});
  // the +09:00 landing is the same instant as 00:00Z
  assert.equal(mine["IDD-8"].mergedAt, "2026-10-13T09:00:00+09:00");
  // two `at`s that are not readable times are compared as strings, in the host's order: "aa" comes before "b"
  assert.equal(mine["IDD-10"].mergedAt, "aa");
  assert.equal(mine["IDD-10"].endedAt, "aa");
});

test("the copy takes the lane's end from its own list, the hold at S3 included", () => {
  const reference = Object.fromEntries(laneStatesTs(lifecycle));
  // closed, stopped at GO, held at S3: the three rows the copy's own list names give the lane its end
  assert.equal(reference["IDD-3"].endedAt, "2026-10-13T04:30:00.000Z");
  assert.equal(reference["IDD-4"].endedAt, "2026-10-13T02:00:00.000Z");
  assert.equal(reference["IDD-5"].endedAt, "2026-10-13T02:30:00.000Z");
  // a row the list does not name leaves the lane without one, as the fold's own list does
  assert.equal(reference["IDD-7"].endedAt, undefined);
});

test("AC-002: both folds answer the same records for every viewer of the fixture", () => {
  const states = laneStates(lifecycle);
  const statesTs = laneStatesTs(lifecycle);
  const viewers = viewersOf();
  assert.ok(viewers.length > 4, "比べる見る側が足りません");
  for (const viewer of viewers) {
    const mine = foldRows(intent, viewer, states);
    const reference = foldRowsTs(intent, viewer, statesTs);
    // one exception, C-191-4: a lone surrogate cannot be a MoonBit string, so the boundary carries U+FFFD where
    // the TypeScript keeps the code unit. Everything else has to agree exactly.
    assert.deepEqual(plain(mine), plain(boundaryText(reference)), `見る側 ${viewer ?? "（lane の外）"} で食い違いました`);
  }
});

test("AC-002 / C-191-4: a row with a lone surrogate still folds, and only its own words differ", () => {
  const states = laneStates(lifecycle);
  const statesTs = laneStatesTs(lifecycle);
  const mine = foldRows(intent, null, states);
  const reference = foldRowsTs(intent, null, statesTs);
  const mineText = JSON.stringify(mine);
  const referenceText = JSON.stringify(reference);
  assert.ok(mineText.includes("\ufffd"), "置き換えた文字が答えにありません");
  assert.ok(referenceText.includes("\\ud800"), "TS の答えに片割れのサロゲートがありません");
  // the row is not dropped: the Purpose it raised is there on both sides
  assert.ok(mine.purposes.some((purpose) => purpose.id === "P-24"));
  assert.equal(mine.purposes.find((purpose) => purpose.id === "P-24").statement.includes("\ufffd"), true);
});

test("AC-003 / AC-002: a withdrawn proposal is neither proposed nor active, and a person's sentence sits beside the planner's", () => {
  const states = laneStates(lifecycle);
  const lane = Object.fromEntries(foldRows(intent, "IDD-6", states).purposes.map((purpose) => [purpose.id, purpose]));
  // restated twice (the second with the same words changes nothing), then withdrawn; a later withdrawal is ignored
  assert.deepEqual(pick(lane["P-30"], "status", "grounds", "statement", "raised_statement", "restated"), {
    status: "withdrawn",
    grounds: "出典に無い",
    statement: "人の文 2",
    raised_statement: "計画役の文",
    restated: { by: { session: "inbox" }, at: "2026-10-13T05:03:00.000Z" },
  });
  // a withdrawal with no grounds still withdraws
  assert.deepEqual(pick(lane["P-31"], "status", "grounds"), { status: "withdrawn", grounds: undefined });
  // the lane's outside does not see an unmerged lane's proposal, so a person's row about it reaches nobody
  assert.equal(foldRows(intent, null, states).purposes.some((purpose) => purpose.id === "P-30"), false);
});

test("AC-002: the fixture's own readings are what the fold writes", () => {
  const states = laneStates(lifecycle);
  const outside = foldRows(intent, null, states);
  const purposes = Object.fromEntries(outside.purposes.map((purpose) => [purpose.id, purpose]));
  assert.equal(purposes["P-1"].statement, "記録は 1 つ");
  assert.equal(purposes["P-1"].name, "記録");
  assert.equal(purposes["P-1"].status, "retired");
  assert.equal(purposes["P-1"].grounds, "済んだ");
  // the sentence the raise wrote stays beside the one that replaced it; a withdrawal reaches a proposal only, so an
  // active Purpose stays as it was and an unknown id stays unknown
  assert.deepEqual(pick(purposes["P-2"], "statement", "origin", "raised_statement", "status", "restated"), {
    statement: "書き直した文",
    origin: "",
    raised_statement: "文だけ",
    status: "active",
    restated: { by: { session: "s-1" }, at: "2026-10-13T00:12:00.000Z" },
  });
  assert.equal(purposes["P-404"], undefined);
  // a row without `by` folds for everyone
  assert.equal(purposes["P-3"].statement, "by の無い行");
  // a row written by a lane after it merged reaches nobody; before the merge, everyone
  assert.equal(purposes["P-10"].statement, "取り込みの前の lane の行");
  assert.equal(purposes["P-11"], undefined);
  assert.equal(purposes["P-12"], undefined);

  const choices = Object.fromEntries(outside.choices.map((choice) => [choice.id, choice]));
  const lane = foldRows(intent, "IDD-6", states);
  const laneChoices = Object.fromEntries(lane.choices.map((choice) => [choice.id, choice]));
  assert.equal(choices["C-1"].status, "active");
  assert.equal(choices["C-1"].visibility, "public");
  assert.deepEqual(choices["C-1"].verification, ["AC-001"]);
  assert.deepEqual(choices["C-1"].waives, [
    { reason: "捨てた形が思い当たらない", by: { session: "s-1" }, at: "2026-10-13T00:50:00.000Z" },
  ]);
  // the raise's file Place is read as its module, and the re-anchor replaces the list as it is written
  assert.deepEqual(choices["C-1"].place, [
    { path: "packages/idd-fold/", kind: "module", file: "packages/idd-fold/fold.mbt" },
  ]);
  assert.equal(choices["C-2"].status, "active");
  assert.equal(choices["C-2"].history.length, 4);
  assert.equal(choices["C-4"].status, "dropped");
  assert.equal(choices["C-4"].history.at(-1).grounds, "要らない");
  assert.equal(choices["C-5"].status, "superseded");
  assert.equal(choices["C-5"].history.at(-1).successor, "C-6");
  assert.equal(choices["C-6"].status, "active");
  // a row that points at a standing successor closes the Choice and keeps both bodies
  assert.equal(choices["C-22"].status, "superseded");
  assert.equal(choices["C-22"].why, "閉じる why");
  assert.equal(choices["C-22"].history.at(-1).successor, "C-21");
  assert.equal(choices["C-22"].history.at(-1).grounds, "後継を指す置き換え");
  assert.equal(choices["C-21"].status, "active");
  assert.equal(choices["C-21"].why, "後継の why");
  // an unconfirmed Choice's re-anchor moves the Place and leaves the body alone; the lane's own confirmation
  // of it reaches nobody else until the lane merges
  assert.equal(choices["C-7"].status, "unconfirmed");
  assert.equal(laneChoices["C-7"].status, "active");
  assert.equal(choices["C-7"].anchored, "契約");
  assert.deepEqual(choices["C-7"].place, [{ path: "packages/", kind: "module" }]);
  // a row whose `at` cannot be read still folds
  assert.equal(choices["C-8"].purpose, "P-1");
  // a lane that landed at the unreadable ``aa`` keeps the row written at that same string, and drops the one
  // written at ``b``, which follows ``aa`` in the host's order
  assert.equal(purposes["P-13"], undefined);
  assert.equal(purposes["P-14"].statement, "読めない時どうしの境目の行");

  // the lane's own side sees what it raised, confirmed and replaced; the outside does not, because the lane
  // never merged
  const lanePurposes = Object.fromEntries(lane.purposes.map((purpose) => [purpose.id, purpose]));
  assert.equal(laneChoices["C-9"].status, "active");
  assert.equal(choices["C-9"], undefined);
  // the outside still holds the Choice the lane's row replaced, because that row is not effective there
  assert.equal(choices["C-1"].status, "active");
  // the proposal that only that lane sees is the one the GO named, and the confirmation made it active
  assert.equal(lanePurposes["P-7"].status, "active");
  assert.equal(lanePurposes["P-7"].name, "確かめた名");
  assert.equal(lanePurposes["P-8"].name, "自分の名");
  assert.equal(laneChoices["C-3"].visibility, "private");
  assert.equal(laneChoices["C-3"].history[0].at, "2026-09-01");

  // the lane's no-choice Waive is the lane's own until it merges
  // a hand-written row whose `choices` is not a list still folds as a Waive, with no choices
  assert.deepEqual(outside.waives.map((waive) => waive.kind), ["applied", "applied"]);
  assert.deepEqual(lane.waives.map((waive) => waive.kind), ["applied", "no-choice", "applied"]);
  assert.deepEqual(outside.harmExamples.map((example) => [example.id, example.harm, example.alwaysMust]), [
    ["H-1", 3, true],
  ]);
});

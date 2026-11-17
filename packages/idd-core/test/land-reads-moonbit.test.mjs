import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { currentLandApproval, lastLandHold } from "../src/overlay/land.ts";
import * as reference from "../src/overlay/land-reads-reference.ts";
import { laneAnswer } from "../src/intent/moonbit-fold.ts";
import { lane_answer } from "../../idd-fold/dist/idd-fold.js";

/**
 * The landing's three readings, folded in MoonBit and held against the TypeScript reading over committed fixtures.
 *
 * A real ledger lives outside git and the test entry drops the `IDD_` variables, so a test cannot see one. What a
 * real ledger rarely or never carries is written here instead: an approval without the signature's mark, an
 * approval without a close and with a broken one, each of the six events that take an approval back, the R2 events a
 * lane from before R2 was removed (2026-10-22) still carries, heads
 * missing from the three rows that carry one, an event no derivation knows, and attrs of the wrong shape. The real
 * ledger's every prefix is checked by `packages/idd-fold/crosscheck.mjs`.
 *
 * The floor is `_docs/qa/pi-web-idd/idd-195/qa.md`: AC-001 (every prefix, the same answer), AC-002 (the shapes a
 * real ledger does not carry, and an unsigned approval never read as one), AC-003 (the running path takes the
 * MoonBit answer, and a fold that cannot answer fails instead of answering in TypeScript).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "land", "lifecycle.jsonl");

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

/** every prefix of every lane: what a caller reads at each step */
function* prefixes() {
  for (const [lane, events] of lanes) {
    for (let n = 1; n <= events.length; n += 1) {
      yield { lane, n, prefix: events.slice(0, n) };
    }
  }
}

test("AC-002: the three readings answer the same in MoonBit and in the TypeScript reading, at every prefix", () => {
  let compared = 0;
  for (const { lane, n, prefix } of prefixes()) {
    const where = `${lane} の ${n} 行目まで`;
    assert.deepEqual(plain(laneAnswer("land_approval", prefix)), plain(reference.currentLandApprovalReference(prefix)), `${where}の取り込みの承認が食い違いました`);
    assert.equal(laneAnswer("land_hold", prefix), reference.lastLandHoldReference(prefix), `${where}の着地の待ちが食い違いました`);
    assert.deepEqual(plain(laneAnswer("reviewed_head", prefix)), plain(reference.reviewedHeadReference(prefix)), `${where}の見た head が食い違いました`);
    compared += 1;
  }
  assert.ok(compared >= 50, `比べた途中の列が少なすぎます: ${compared}`);
});

test("AC-002: the readers on the running path answer what the fold answers", () => {
  for (const { lane, n, prefix } of prefixes()) {
    const where = `${lane} の ${n} 行目まで`;
    assert.deepEqual(plain(currentLandApproval(prefix)), plain(laneAnswer("land_approval", prefix)), `${where}の承認が fold と食い違いました`);
    assert.equal(lastLandHold(prefix), laneAnswer("land_hold", prefix), `${where}の着地の待ちが fold と食い違いました`);
  }
});

test("AC-002: an approval without the signature's mark is read as no approval, by any entry", () => {
  let unmarked = 0;
  for (const { lane, n, prefix } of prefixes()) {
    const last = [...prefix].reverse().find((e) => e.event === "s4_land_approved");
    if (!last) continue;
    if (last.attrs?.signed === true) continue;
    unmarked += 1;
    const where = `${lane} の ${n} 行目まで`;
    // the fold, the reader the tick / the card / the screen all read, and the reading this file is held against
    assert.equal(laneAnswer("land_approval", prefix), null, `${where}: 印の無い承認が畳みで承認として読まれました`);
    assert.equal(currentLandApproval(prefix), null, `${where}: 印の無い承認が読み手で承認として読まれました`);
    assert.equal(reference.currentLandApprovalReference(prefix), null, `${where}: 印の無い承認が TS の読みで承認として読まれました`);
  }
  // the fixture carries the shapes a real ledger has: no mark at all, the word "true", and the number 1
  assert.ok(unmarked >= 3, `印の無い承認を通る途中の列が少なすぎます: ${unmarked}`);
});

test("AC-002: a signed approval carries its head, its place and the close the signature covered", () => {
  const lane = lanes.get("IDD-951");
  const signed = laneAnswer("land_approval", lane.slice(0, 4));
  assert.deepEqual(plain(signed), {
    head: "951a2",
    at: 3,
    close: { repo: "penne-0505/pi-web-idd", issue: 209, comment: "取り込みました", url: "" },
  });
  // a close that is an array, names no repo, or whose issue is not a whole number above 0, is not a close the tick may run
  for (const n of [6, 8, 10, 12]) {
    assert.notEqual(laneAnswer("land_approval", lane.slice(0, n)), null, `IDD-951 の ${n} 行目までが承認として読まれていません`);
    assert.equal(laneAnswer("land_approval", lane.slice(0, n))?.close, undefined, `IDD-951 の ${n} 行目までの close`);
  }
  // the approval older than a send-back is not in force
  assert.equal(laneAnswer("land_approval", lane.slice(0, 5)), null);
  assert.equal(laneAnswer("land_approval", lane.slice(0, 15)), null);
});

test("the R2 readings are gone from the fold, and a lane whose rows still hold R2 events folds the other readings", () => {
  for (const op of ["r2_record_hold", "r2_record_retryable"]) assert.throws(() => laneAnswer(op, [], { iddId: "IDD-952", reason: "" }), /MoonBit の畳み/);
  const lane = lanes.get("IDD-952");
  assert.ok(lane.some((row) => row.event.startsWith("s3_r2_")), "fixture の IDD-952 に R2 の event がありません");
  for (let n = 1; n <= lane.length; n += 1) {
    const prefix = lane.slice(0, n);
    assert.doesNotThrow(() => laneAnswer("land_hold", prefix));
    assert.doesNotThrow(() => laneAnswer("reviewed_head", prefix));
  }
});

test("AC-003: the running path folds in MoonBit, and a fold that cannot answer fails instead of answering in TypeScript", () => {
  for (const [file, ops] of [
    [join(HERE, "..", "src", "overlay", "land.ts"), ["land_approval", "land_hold"]],
    [join(HERE, "..", "src", "plan", "reviewed-head.ts"), ["reviewed_head"]],
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /from "\.\.\/(intent|\.\.\/intent)\/moonbit-fold\.ts"/, `${file} が MoonBit の畳みを読んでいません`);
    assert.doesNotMatch(source, /land-reads-reference/, `${file} が TS の写しを読んでいます`);
    for (const op of ops) assert.ok(source.includes(`"${op}"`), `${file} が ${op} を畳みに問い合わせていません`);
  }
  // a reading the module cannot answer is a failure, not a TypeScript answer
  assert.throws(() => laneAnswer("no_such_answer", []), /MoonBit の畳み/);
  assert.notEqual(lane_answer("no_such_answer", "[]", "").$tag, 1);
  // a row the fold was never handed is refused too: it does not fold what it has in its place
  assert.equal(lane_answer("land_approval", "999999999", "").$tag, 0);
});

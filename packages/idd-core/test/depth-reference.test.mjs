import assert from "node:assert/strict";
import { test } from "node:test";

import { DEPTH_TABLE } from "../src/plan/depth.ts";
import { DEPTH_TABLE_REFERENCE, DEPTH_TABLE_TS } from "../src/plan/depth-reference.ts";

/**
 * The copies' depth rows are the answer of the retired TypeScript, not the fold's current rows read back.
 *
 * `DEPTH_TABLE_REFERENCE` decides whether the copies run a last review at each depth (`review-loop-reference.ts`),
 * so a row taken from the fold would make the fold and the copy say the same thing about the last review and a fold
 * that lost it would show nothing (C-206-3). The two tables below fix where every row came from: the TS literal
 * before the migration, and that literal with the one decision penne took on 2026-10-19 (every depth runs the last
 * review). A change to either table has to be written here on purpose.
 */

const DEPTHS = ["shallow", "standard", "deep"];

test("the copy answers with the retired TS's rows, the 2026-10-19 last review included", () => {
  // 2026-10-19: every depth runs the senior role's last review (shallow and standard were `false`); 2026-10-22: the kept check went with R2
  assert.deepEqual(DEPTH_TABLE_REFERENCE.shallow, { planReview: 1, blind: 1, spec: 1, finalReview: true, fixRounds: 1, autoGo: true, shape: 0 });
  assert.deepEqual(DEPTH_TABLE_REFERENCE.standard, { planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 2, autoGo: false, shape: 0 });
  assert.deepEqual(DEPTH_TABLE_REFERENCE.deep, { planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 3, autoGo: false, shape: 1 });
});

test("the rows before the migration are kept as they were, the last review off below deep", () => {
  // the table `1c0e041c` removed from `plan/depth.ts`
  assert.deepEqual(DEPTH_TABLE_TS.shallow, { planReview: 1, blind: 1, finalReview: false, fixRounds: 1, autoGo: true });
  assert.deepEqual(DEPTH_TABLE_TS.standard, { planReview: 2, blind: 2, finalReview: false, fixRounds: 2, autoGo: false });
  assert.deepEqual(DEPTH_TABLE_TS.deep, { planReview: 2, blind: 2, finalReview: true, fixRounds: 3, autoGo: false });
});

test("the two tables differ at the one decided point and nowhere else", () => {
  const fields = ["planReview", "blind", "finalReview", "fixRounds", "autoGo"];
  const differences = [];
  for (const depth of DEPTHS) {
    for (const field of fields) {
      if (DEPTH_TABLE_REFERENCE[depth][field] !== DEPTH_TABLE_TS[depth][field]) differences.push(`${depth}.${field}`);
    }
  }
  assert.deepEqual(differences, ["shallow.finalReview", "standard.finalReview"]);
  // the deep row runs the last review on both sides: the decision moved nothing there
  assert.equal(DEPTH_TABLE_TS.deep.finalReview, true);
  assert.equal(DEPTH_TABLE_REFERENCE.deep.finalReview, true);
});

test("the copy's table is its own, not the running path's rows", () => {
  assert.notEqual(DEPTH_TABLE_REFERENCE, DEPTH_TABLE);
  for (const depth of DEPTHS) assert.notEqual(DEPTH_TABLE_REFERENCE[depth], DEPTH_TABLE[depth]);
  // the copy answers the same counts the running path does today; the comparison above is what keeps them apart
  assert.deepEqual({ ...DEPTH_TABLE_REFERENCE }, { ...DEPTH_TABLE });
});

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { foldRows, laneStates } from "../src/intent/store.ts";
import * as ledger from "../src/ledger/read.ts";
import * as bridge from "../src/intent/moonbit-fold.ts";
import { scratchDir } from "./helpers/scratch.mjs";
import { foldRowsTs, laneStatesTs } from "../src/intent/fold-reference.ts";
import * as fold from "../../idd-fold/dist/idd-fold.js";

/**
 * The door: the fold the engine, the CLI and the tests run is the MoonBit one, loaded from the JS committed with
 * its source (`packages/idd-fold/dist`), with no `moon` and no build step anywhere on the way (C-186-3). A failure
 * of that fold is a failure the caller sees; nothing quietly answers with a second fold written in TypeScript
 * (C-186-2).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "..", "src", "intent", "store.ts");

test("AC-003: the MoonBit fold loads from the committed JS without moon or a build", () => {
  for (const name of ["put_lifecycle", "put_intent", "lane_states", "fold_records"]) {
    assert.equal(typeof fold[name], "function", `dist の JS に ${name} がありません`);
  }
  // this run is a plain `node --experimental-strip-types`: no moon on the PATH, no build step
  assert.equal(process.env.MOON_HOME ?? undefined, undefined, "moon の置き場を指したままの run では、この確かめは意味を持ちません");
});

test("AC-003: the callers' door folds in MoonBit, never in the reference fold", () => {
  const source = readFileSync(STORE, "utf8");
  assert.match(source, /from "\.\/moonbit-fold\.ts"/, "store.ts が MoonBit の畳みを読んでいません");
  assert.doesNotMatch(source, /from "\.\/fold-reference\.ts"/, "store.ts が TS の畳みを読んでいます");
  assert.notEqual(foldRows, foldRowsTs);
  assert.notEqual(laneStates, laneStatesTs);
});

test("AC-003: a fold that cannot answer fails, and does not answer with something else", () => {
  // a row number the fold was never handed: the MoonBit side refuses, it does not fold what it has
  const refused = fold.lane_states("[999999999]");
  assert.equal(refused.$tag, 0, "無い行を名指したのに、答えを返しました");
  // and the callers' door is the same fold: the rows it folds are the ones it handed over
  const states = laneStates([]);
  assert.equal(states.size, 0);
  assert.deepEqual(foldRows([], null, states), { purposes: [], choices: [], waives: [], harmExamples: [] });
});

test("AC-003: the committed JS is the module's own answer, not a second reading", () => {
  const built = readFileSync(join(HERE, "..", "..", "idd-fold", "dist", "idd-fold.js"), "utf8");
  assert.match(built, /export \{/, "dist の JS が ES module ではありません");
  const types = readFileSync(join(HERE, "..", "..", "idd-fold", "dist", "idd-fold.d.ts"), "utf8");
  for (const name of ["put_lifecycle", "put_intent", "lane_states", "fold_records"]) {
    assert.ok(types.includes(name), `dist の型に ${name} がありません`);
  }
});

test("AC-005: a column that did not grow hands the fold nothing more over", () => {
  const state = scratchDir("fold-grow-");
  const lifecycle = join(state, "lifecycle-demo.jsonl");
  const write = () => writeFileSync(
    lifecycle,
    [
      '{"idd_id":"IDD-1","event":"s1_go","at":"2026-10-13T01:00:00.000Z","attrs":{"purposes":[]}}',
      '{"idd_id":"IDD-1","event":"lane_close","at":"2026-10-13T02:00:00.000Z","attrs":{"outcome":"merged"}}',
    ].join("\n") + "\n",
  );
  write();
  const { readLifecycle, resetJsonlCache } = ledger;
  const { rowsHandedOver } = bridge;
  const saved = process.env.IDD_STATE_DIR;
  process.env.IDD_STATE_DIR = state;
  try {
    resetJsonlCache();
    const first = rowsHandedOver().lifecycle;
    const states = laneStates(readLifecycle());
    const afterFirst = rowsHandedOver().lifecycle;
    assert.equal(afterFirst - first, 2, "最初の読みが 2 行を渡していません");
    assert.equal(states.get("IDD-1").mergedAt, "2026-10-13T02:00:00.000Z");
    // nothing moved: the same rows are not handed over again
    laneStates(readLifecycle());
    assert.equal(rowsHandedOver().lifecycle, afterFirst, "動いていない列の行をもう一度渡しています");
    // an appended row is the only thing handed over
    writeFileSync(
      lifecycle,
      [
        '{"idd_id":"IDD-1","event":"s1_go","at":"2026-10-13T01:00:00.000Z","attrs":{"purposes":[]}}',
        '{"idd_id":"IDD-1","event":"lane_close","at":"2026-10-13T02:00:00.000Z","attrs":{"outcome":"merged"}}',
        '{"idd_id":"IDD-2","event":"s3_defer","at":"2026-10-13T03:00:00.000Z","attrs":{}}',
      ].join("\n") + "\n",
    );
    const grown = laneStates(readLifecycle());
    assert.equal(rowsHandedOver().lifecycle, afterFirst + 1, "足された 1 行だけを渡していません");
    assert.equal(grown.get("IDD-2").endedAt, "2026-10-13T03:00:00.000Z");
  } finally {
    if (saved === undefined) delete process.env.IDD_STATE_DIR;
    else process.env.IDD_STATE_DIR = saved;
    resetJsonlCache();
  }
});

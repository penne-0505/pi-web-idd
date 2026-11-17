import assert from "node:assert/strict";
import { test } from "bun:test";

import { CUT_BY_OUTPUT, CUT_BY_TIME } from "../../idd-core/src/overlay/gate.ts";
import { earlierFailedOf, failedTestNames, withFailedTests } from "../../idd-core/src/overlay/failed-tests.ts";
import { failureSummary } from "../src/test-entry.ts";
import { BUN_SAME_NAME_IN_TWO_FILES, NODE_SPEC_FOUR_FAILED } from "./helpers/node-spec-output.ts";

// The names of the failed tests a landing run reads from a check's detail. The summary is the one test-entry writes, so
// the reader is held against the writer, not against a copy of its words.

const summary = (...names: string[]) => `ℹ fail ${names.length}\n${failureSummary("lane", names.map((n: string) => `(fail) ${n} [3ms]`).join("\n"))}`;

test("the names are read from the summary test-entry ends with", () => {
  assert.deepEqual(failedTestNames(summary("a test", "another test")), ["a test", "another test"]);
  assert.deepEqual(failedTestNames(`${"noise\n".repeat(5)}${summary("only")}`), ["only"]);
});

test("a node run with suites and a repeated name still names every failed test", () => {
  const names = failedTestNames(failureSummary("core", NODE_SPEC_FOUR_FAILED));
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4);
});

test("a bun test of one name in two files is two tests, and only the same file's one is the same test", () => {
  const names = failedTestNames(failureSummary("lane", BUN_SAME_NAME_IN_TWO_FILES));
  assert.deepEqual(names, ["s > same name (packages/x/a.test.ts)", "s > same name (packages/x/b.test.ts)"]);
  const moved = failedTestNames(failureSummary("lane", BUN_SAME_NAME_IN_TWO_FILES.replaceAll("b.test.ts", "c.test.ts")));
  assert.deepEqual(moved.filter((n: string) => names.includes(n)), ["s > same name (packages/x/a.test.ts)"]);
});

test("a summary that left names out, or a detail with none, names no test", () => {
  const many = Array.from({ length: 80 }, (_: unknown, i: number) => `test number ${i} ${"x".repeat(40)}`);
  assert.deepEqual(failedTestNames(summary(...many)), [], "a list that may be partial cannot show two rounds did not fail on the same test");
  assert.deepEqual(failedTestNames("✖ a test (2ms)\n  AssertionError"), []);
  assert.deepEqual(failedTestNames(""), []);
  assert.deepEqual(failedTestNames(undefined), []);
  assert.deepEqual(failedTestNames("[test-entry] 組 lane が時間で止められました: 経過 900 秒、終わったテスト 12 件"), []);
});

test("a run the harness cut names no test, whatever its output holds", () => {
  assert.deepEqual(failedTestNames(`${CUT_BY_TIME(15)}\n${summary("a")}`), []);
  assert.deepEqual(failedTestNames(`${CUT_BY_OUTPUT}\n${summary("a")}`), []);
});

test("a name is kept whole, so two long names with one start stay two tests", () => {
  const long = "あ".repeat(200);
  assert.deepEqual(failedTestNames(summary(`${long} 1`, `${long} 2`)), [`${long} 1`, `${long} 2`]);
});

test("only a failed row carries names, and the next round is compared with the rows that did", () => {
  const rows = withFailedTests([
    { name: "test:lane", status: "fail", severity: "blocking", detail: summary("a") },
    { name: "lint", status: "fail", severity: "blocking", detail: "1 error" },
    { name: "typecheck", status: "pass", severity: "blocking", detail: summary("not a failure") },
  ]);
  assert.deepEqual(rows.map((r) => r.failedTests), [["a"], undefined, undefined]);
  assert.deepEqual(earlierFailedOf(rows), [{ name: "test:lane", tests: ["a"] }]);
});

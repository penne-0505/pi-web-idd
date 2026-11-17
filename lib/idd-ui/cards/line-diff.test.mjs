import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { lineDiff } = await jiti.import("./line-diff.ts");

test("the lines taken out and put in are marked, the rest kept in order", () => {
  assert.deepEqual(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n"), [
    { op: "same", text: "a" },
    { op: "del", text: "b" },
    { op: "add", text: "B" },
    { op: "same", text: "c" },
    { op: "add", text: "d" },
  ]);
});

test("the same text has no change, and an empty body is all additions", () => {
  assert.ok(lineDiff("x\ny", "x\ny").every((l) => l.op === "same"));
  assert.deepEqual(lineDiff("", "x\ny"), [{ op: "add", text: "x" }, { op: "add", text: "y" }]);
});

test("a line ending in CRLF from GitHub is the same line as its LF form", () => {
  assert.ok(lineDiff("a\r\nb\r\n", "a\nb\n").every((l) => l.op === "same"));
});

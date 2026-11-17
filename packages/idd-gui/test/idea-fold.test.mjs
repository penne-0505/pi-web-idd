import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";

const { foldEntries } = await load("./src/chat/fold.ts");

const WRITE_RECORD = [
  { id: "a1", parentId: null, type: "message", message: { role: "assistant", timestamp: "t1", content: [{ type: "text", text: "書きます" }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "idea.md" } }] } },
  { id: "r1", parentId: "a1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: "ok", isError: false } },
  { id: "a2", parentId: "r1", type: "message", message: { role: "assistant", timestamp: "t2", content: [{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "idea.md", edits: [{ oldText: "", newText: "x" }] } }] } },
  { id: "r2", parentId: "a2", type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "edit", content: "ok", isError: false } },
  { id: "u2", parentId: "r2", type: "message", message: { role: "user", timestamp: "t3", content: "続き" } },
];
const MARK = { gate: 1, action: "approve", stage: "ゲート1" };

test("AC-035: the line is added after the position's items and separates the two tool bundles", () => {
  const atWrite = foldEntries(WRITE_RECORD, "u2", [{ entryId: "a1", mark: MARK }]);
  assert.deepEqual(atWrite.map((item) => item.kind), ["assistant", "tools", "gate", "tools", "user"]);
  // the first entry's result still lands in the bundle before the line
  const firstBundle = atWrite.find((item) => item.kind === "tools");
  assert.equal(firstBundle.calls.length, 1);
  assert.equal(firstBundle.calls[0].result, "ok");
  const secondBundle = atWrite[atWrite.length - 2];
  assert.equal(secondBundle.calls.length, 1);
  assert.equal(secondBundle.calls[0].toolCallId, "c2");
});

test("AC-035: a position on the following entry puts the line after both calls, before the next utterance", () => {
  const atEdit = foldEntries(WRITE_RECORD, "u2", [{ entryId: "a2", mark: MARK }]);
  assert.deepEqual(atEdit.map((item) => item.kind), ["assistant", "tools", "gate", "user"]);
  const bundle = atEdit.find((item) => item.kind === "tools");
  assert.deepEqual(bundle.calls.map((call) => call.toolCallId), ["c1", "c2"]);
  assert.equal(bundle.calls[0].result, "ok");
});

test("AC-008 / AC-035: a position that is not on the branch is drawn at the head", () => {
  const missing = foldEntries(WRITE_RECORD, "u2", [{ entryId: "nope", mark: MARK }]);
  assert.deepEqual(missing.map((item) => item.kind), ["gate", "assistant", "tools", "user"]);
  // no anchors at all: the column is the record's own, unchanged
  assert.deepEqual(foldEntries(WRITE_RECORD, "u2").map((item) => item.kind), ["assistant", "tools", "user"]);
});

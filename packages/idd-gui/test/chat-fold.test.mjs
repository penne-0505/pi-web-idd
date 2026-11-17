import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, branchEntries, bundleFailed, bundleNames, foldEntries, textOf } from "../src/chat/fold.ts";

/** one pi record, cut down to the fields the fold reads */
const ENTRIES = [
  { id: "a", parentId: null, type: "message", message: { role: "user", timestamp: "t1", content: "こんにちは" } },
  {
    id: "b",
    parentId: "a",
    type: "message",
    message: {
      role: "assistant",
      timestamp: "t2",
      content: [
        { type: "thinking", thinking: "まず調べる" },
        { type: "text", text: "調べます。" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "c2", name: "grep", arguments: { q: "x" } },
        { type: "text", text: "分かりました。" },
      ],
    },
  },
  { id: "c", parentId: "b", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: "中身", isError: false } },
  { id: "d", parentId: "c", type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "grep", content: "落ちた", isError: true } },
  { id: "e", parentId: "d", type: "compaction", summary: "まとめた" },
  { id: "f", parentId: "e", type: "custom_message", display: false, content: "隠す文脈" },
  { id: "g", parentId: "f", type: "custom_message", display: true, content: "見せる文脈" },
  { id: "h", parentId: "g", type: "model_change", model: "x" },
];

test("AC-016: a record whose toolResult is followed by an assistant keeps the tool bundle", () => {
  const record = [
    { id: "a", parentId: null, type: "message", message: { role: "user", timestamp: 1, content: "調べて" } },
    {
      id: "b",
      parentId: "a",
      type: "message",
      message: {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "調べます" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
    },
    { id: "c", parentId: "b", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: "中身", isError: false } },
    { id: "d", parentId: "c", type: "message", message: { role: "assistant", timestamp: 3, content: [{ type: "text", text: "分かりました" }] } },
  ];
  const items = foldEntries(record, "d");
  assert.deepEqual(items.map((item) => item.kind), ["user", "assistant", "tools", "assistant"]);
  const bundle = items.find((item) => item.kind === "tools");
  assert.equal(bundle.calls.length, 1, "a call before the final response is not dropped by that response");
  assert.equal(bundle.calls[0].result, "中身");
});

test("AC-023: a stream-built bundle is not dropped by a following assistant entry", () => {
  let items = [];
  items = applyEvent(items, { type: "tool_call", toolCallId: "c1", name: "read", args: { path: "a.ts" } });
  items = applyEvent(items, { type: "tool_result", toolCallId: "c1", name: "read", result: "中身", isError: false });
  items = applyEvent(items, { type: "entry", role: "assistant", message: { timestamp: 10, content: [{ type: "text", text: "分かりました" }] } });
  const bundle = items.find((item) => item.kind === "tools");
  assert.ok(bundle, "the stream's call survives the committed entry");
  assert.equal(bundle.calls[0].toolCallId, "c1");
  assert.equal(bundle.calls[0].result, "中身");
});

test("AC-024 / INV-116-2: a numeric timestamp folds the record and the stream's entry as one", () => {
  const record = [
    { id: "a", parentId: null, type: "message", message: { role: "user", timestamp: 100, content: "こんにちは" } },
    { id: "b", parentId: "a", type: "message", message: { role: "assistant", timestamp: 200, content: [{ type: "text", text: "やあ" }] } },
  ];
  let items = foldEntries(record, "b");
  // the replay delivers the same entries again: pi's times are numbers, and they still meet the record's
  items = applyEvent(items, { type: "entry", role: "user", message: record[0].message });
  items = applyEvent(items, { type: "entry", role: "assistant", message: record[1].message });
  assert.deepEqual(items.map((item) => item.text), ["こんにちは", "やあ"]);

  // a live preview of a message the record already holds is dropped, not drawn over the record
  const withPreview = applyEvent(items, { type: "text", delta: "や", contentIndex: 0 });
  const settled = applyEvent(withPreview, { type: "entry", role: "assistant", message: record[1].message });
  assert.deepEqual(settled.map((item) => item.text), ["こんにちは", "やあ"]);

  // an overlapping user entry leaves the assistant's in-progress delta alone (AC-025)
  const firstOnly = foldEntries([record[0]], "a");
  const streaming = applyEvent(firstOnly, { type: "text", delta: "前半", contentIndex: 0 });
  const afterUser = applyEvent(streaming, { type: "entry", role: "user", message: record[0].message });
  assert.deepEqual(afterUser.map((item) => item.text), ["こんにちは", "前半"]);
});

test("AC-014: people and the assistant's body come out in the record's order", () => {
  const items = foldEntries(ENTRIES, "h");
  const kinds = items.map((item) => item.kind);
  assert.deepEqual(kinds, ["user", "thinking", "assistant", "tools", "assistant", "compaction", "context"]);
  assert.equal(items[0].text, "こんにちは");
  assert.equal(items[2].text, "調べます。");
  assert.equal(items[4].text, "分かりました。");
});

test("AC-016 / AC-018: the calls of one turn become one bundle, with the failure visible", () => {
  const items = foldEntries(ENTRIES, "h");
  const bundle = items.find((item) => item.kind === "tools");
  assert.equal(bundle.calls.length, 2);
  assert.deepEqual(bundleNames(bundle.calls), ["read", "grep"]);
  assert.equal(bundleFailed(bundle.calls), true);
  assert.equal(bundle.calls[0].done, true);
  assert.equal(bundle.calls[0].result, "中身");
  assert.equal(bundle.calls[1].isError, true);
});

test("AC-015: only the branch from the leaf to the root is drawn", () => {
  const withBranch = [
    { id: "a", parentId: null, type: "message", message: { role: "user", timestamp: "t1", content: "根" } },
    { id: "b1", parentId: "a", type: "message", message: { role: "assistant", timestamp: "t2", content: [{ type: "text", text: "枝1" }] } },
    { id: "b2", parentId: "a", type: "message", message: { role: "assistant", timestamp: "t3", content: [{ type: "text", text: "枝2" }] } },
    { id: "z", parentId: "b2", type: "message", message: { role: "user", timestamp: "t4", content: "続き" } },
  ];
  const items = foldEntries(withBranch, "z");
  assert.deepEqual(items.map((item) => item.text), ["根", "枝2", "続き"]);
  assert.deepEqual(branchEntries(withBranch, "z").map((entry) => entry.id), ["a", "b2", "z"]);
});

test("AC-021: a hidden context utterance is left out and a shown one is drawn", () => {
  const items = foldEntries(ENTRIES, "h");
  const texts = items.map((item) => item.text);
  assert.equal(texts.includes("隠す文脈"), false);
  assert.equal(texts.includes("見せる文脈"), true);
  assert.equal(items.some((item) => item.kind === "context"), true);
});

test("a null leaf names no branch", () => {
  assert.deepEqual(foldEntries(ENTRIES, null), []);
});

test("AC-023: the stream builds the same shapes before anything is committed", () => {
  let items = [];
  items = applyEvent(items, { type: "text", delta: "考え", contentIndex: 0 });
  items = applyEvent(items, { type: "text", delta: "ます", contentIndex: 0 });
  items = applyEvent(items, { type: "thinking", delta: "内語", contentIndex: 1 });
  items = applyEvent(items, { type: "tool_call_delta", phase: "start", toolCallId: "x1", name: "read" });
  items = applyEvent(items, { type: "tool_call", toolCallId: "x1", name: "read", args: { path: "a" } });
  items = applyEvent(items, { type: "tool_progress", toolCallId: "x1", name: "read" });
  items = applyEvent(items, { type: "tool_result", toolCallId: "x1", name: "read", result: "ok", isError: false });
  const assistant = items.find((item) => item.kind === "assistant");
  assert.equal(assistant.text, "考えます");
  assert.equal(items.find((item) => item.kind === "thinking").text, "内語");
  const bundle = items.find((item) => item.kind === "tools");
  assert.equal(bundle.calls[0].done, true);
  assert.equal(bundle.calls[0].result, "ok");
});

test("AC-024: a streamed turn folded from its entries equals the record folded afterwards", () => {
  // what the stream delivers for one turn: the person's entry, the deltas, then the committed entries
  const live = [
    { type: "entry", role: "user", message: { role: "user", timestamp: "t1", content: "こんにちは" } },
    { type: "text", delta: "調べます。", contentIndex: 0 },
    { type: "entry", role: "assistant", message: ENTRIES[1].message },
    { type: "entry", role: "toolResult", message: ENTRIES[2].message },
    { type: "entry", role: "toolResult", message: ENTRIES[3].message },
  ];
  let items = [];
  for (const event of live) items = applyEvent(items, event);
  // the entry repeats what the delta already showed: the turn is not on screen twice
  assert.equal(items.filter((item) => item.kind === "assistant").length, 2, "the entry's two text blocks, not the delta plus them");
  const record = foldEntries(ENTRIES.slice(0, 4), "d");
  assert.deepEqual(
    items.map((item) => item.text),
    record.map((item) => item.text),
  );
  assert.equal(bundleNames(items.find((item) => item.kind === "tools").calls).length, 2);
});

test("textOf reads a string and pi's block list the same way", () => {
  assert.equal(textOf("a"), "a");
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(textOf(undefined), "");
});

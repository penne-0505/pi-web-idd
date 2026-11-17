import assert from "node:assert/strict";
import test from "node:test";

import { composerKey } from "../src/chat/keys.ts";
import { deleteIntent, listIntent, toggleArchived, toggleBookmark, togglePinned } from "../src/chat/intents.ts";

test("AC-028: Enter sends and Shift + Enter writes a line", () => {
  assert.equal(composerKey({ key: "Enter" }), "send");
  assert.equal(composerKey({ key: "Enter", shift: true }), "newline");
  assert.equal(composerKey({ key: "a" }), "none");
});

test("AC-029 / INV-116-4: a composing Enter never becomes a send", () => {
  assert.equal(composerKey({ key: "Enter", isComposing: true }), "none");
  assert.equal(composerKey({ key: "Enter", keyCode: 229 }), "none");
  assert.equal(composerKey({ key: "Enter", isComposing: true, shift: true }), "none");
});

test("AC-011 / INV-116-5: the first press only opens the confirm, the second calls the door once", () => {
  const first = deleteIntent({ confirming: null }, { kind: "remove", id: "c1" });
  assert.equal(first.remove, null, "a single press never calls the delete door");
  assert.equal(first.next.confirming, "c1");

  const second = deleteIntent(first.next, { kind: "remove", id: "c1" });
  assert.equal(second.remove, "c1");
  assert.equal(second.next.confirming, null);
});

test("AC-011: another row, Esc and elsewhere all drop the confirm", () => {
  const open = { confirming: "c1" };
  assert.deepEqual(deleteIntent(open, { kind: "remove", id: "c2" }), { next: { confirming: "c2" }, remove: null });
  assert.deepEqual(deleteIntent(open, { kind: "escape" }), { next: { confirming: null }, remove: null });
  assert.deepEqual(deleteIntent(open, { kind: "elsewhere" }), { next: { confirming: null }, remove: null });
});

test("AC-011 / INV-116-5: another row, a menu and any other press drop the confirm, and one press cannot remove", () => {
  const open = { menu: "c1", confirming: "c1" };
  assert.deepEqual(listIntent(open, { kind: "select", id: "c2" }), { next: { menu: "c1", confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "mark", id: "c1" }), { next: { menu: "c1", confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "menu", id: "c2" }), { next: { menu: "c2", confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "menu", id: "c1" }), { next: { menu: null, confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "archive" }), { next: { menu: "c1", confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "workspace" }), { next: { menu: "c1", confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "new-chat" }), { next: { menu: "c1", confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "elsewhere" }), { next: { menu: "c1", confirming: null }, remove: null });
  assert.deepEqual(listIntent(open, { kind: "escape" }), { next: { menu: null, confirming: null }, remove: null });

  // a first press on a row only opens the confirm
  const first = listIntent({ menu: "c1", confirming: null }, { kind: "delete", id: "c1" });
  assert.equal(first.remove, null);
  assert.equal(first.next.confirming, "c1");

  // after the confirm was dropped by another press, one press only opens it again
  const dropped = listIntent(open, { kind: "select", id: "c2" }).next;
  const once = listIntent(dropped, { kind: "delete", id: "c1" });
  assert.equal(once.remove, null, "a single press after a dropped confirm never removes");
  assert.equal(once.next.confirming, "c1");

  // only the second press on the same row carries the delete
  const twice = listIntent(once.next, { kind: "delete", id: "c1" });
  assert.equal(twice.remove, "c1");
  assert.deepEqual(twice.next, { menu: null, confirming: null });
});

test("AC-009: a mark toggle sends the new value of exactly one field", () => {
  assert.deepEqual(togglePinned("c1", false), { id: "c1", patch: { pinned: true } });
  assert.deepEqual(togglePinned("c1", true), { id: "c1", patch: { pinned: false } });
  assert.deepEqual(toggleArchived("c1", false), { id: "c1", patch: { archived: true } });
  assert.deepEqual(toggleBookmark("c1", [], "work"), { id: "c1", patch: { bookmarks: ["work"] } });
  assert.deepEqual(toggleBookmark("c1", ["work", "home"], "work"), { id: "c1", patch: { bookmarks: ["home"] } });
});

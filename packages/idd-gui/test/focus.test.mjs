import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

const { isTextEntry } = await load("./src/inbox/focus.ts");

test("an input, a textarea and a contenteditable are places the user writes", () => {
  assert.equal(isTextEntry({ tagName: "INPUT", isContentEditable: false }), true);
  assert.equal(isTextEntry({ tagName: "input", isContentEditable: false }), true);
  assert.equal(isTextEntry({ tagName: "TEXTAREA", isContentEditable: false }), true);
  assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true);
});

test("the card, a button and nothing have focus without the user writing", () => {
  assert.equal(isTextEntry({ tagName: "BUTTON", isContentEditable: false }), false);
  assert.equal(isTextEntry({ tagName: "ARTICLE", isContentEditable: false }), false);
  assert.equal(isTextEntry({ tagName: "BODY", isContentEditable: false }), false);
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry(undefined), false);
});

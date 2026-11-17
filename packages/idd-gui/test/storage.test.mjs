import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";
import { storage } from "./fixtures/items.mjs";

const { cardActions, intentForKey, EMPTY_CONTEXT } = await load("./src/inbox/keymap.ts");
const { requestFor } = await load("./src/inbox/requests.ts");
const { cardKindOf } = await load("./src/inbox/viewmodel.ts");
const { itemKey } = await load("./src/inbox/deck.ts");

test("the low-space card is a card the screen can handle, tied to no lane (AC-028)", () => {
  assert.equal(cardKindOf(storage), "generic", "it is drawn from the engine's answer, not set aside");
  assert.equal(itemKey(storage), "storage");
});

test("the low-space card offers only 'later', and that snoozes it (AC-028)", () => {
  const slots = cardActions(storage, EMPTY_CONTEXT);
  const used = slots.filter((s) => s.buttons.length > 0);
  assert.deepEqual(used.map((s) => s.position), ["later"]);
  assert.deepEqual(used[0].buttons[0].intent, { kind: "later" });
  // the key that slot is pressed with means the same
  assert.deepEqual(intentForKey(storage, { key: "ArrowDown" }, EMPTY_CONTEXT), { kind: "later" });
  assert.deepEqual(requestFor({ kind: "later" }, storage), { method: "POST", path: "/api/idd/snooze", body: { key: "storage" }, signature: "none" });
});

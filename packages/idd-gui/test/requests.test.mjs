import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";
import { go } from "./fixtures/items.mjs";

const { requestFor, unignoreRequest } = await load("./src/inbox/requests.ts");
const { itemKey } = await load("./src/inbox/deck.ts");

test("a dropped Issue comes back with unignore and its ref", () => {
  assert.deepEqual(unignoreRequest("#13"), { method: "POST", path: "/api/idd/intake/ignore", body: { action: "unignore", ref: "#13" }, signature: "none" });
});

test("waking a put-off card asks the snooze door to wake its key", () => {
  const snoozed = { ...go, snoozedUntil: "2026-10-05T13:00:00Z" };
  assert.deepEqual(requestFor({ kind: "wake" }, snoozed), { method: "POST", path: "/api/idd/snooze", body: { key: itemKey(snoozed), wake: true }, signature: "none" });
});

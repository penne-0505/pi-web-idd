import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./helpers.mjs";
import { inboxCardUrl } from "../../idd-core/src/agent/token.ts";

const { cardFromQuery, hashOfChat, initialScreen, screenStateFromHash } = await load("./src/screenHash.ts");
const { cardNamed, deck } = await load("./src/inbox/deck.ts");

test("AC-042: the hash names the conversation screen and the chosen conversation", () => {
  assert.deepEqual(screenStateFromHash("#chat"), { view: "chat", lane: null, all: false, chat: null });
  assert.deepEqual(screenStateFromHash("#chat/abc"), { view: "chat", lane: null, all: false, chat: "abc" });
  assert.equal(screenStateFromHash("#work").view, "work");
  assert.equal(screenStateFromHash("").view, "inbox");
  assert.equal(screenStateFromHash("#nonsense").view, "inbox");
  assert.equal(hashOfChat("abc"), "#chat/abc");
  assert.equal(hashOfChat(null), "#chat");
});

test("the URL a CLI answer returns opens the Inbox and brings the named card to the front, read the way the screen reads it", () => {
  // the producer (`inboxCardUrl`) and the reader (`cardFromQuery`, `initialScreen`, `cardNamed`) must mean one thing by `card`
  const NOW = Date.parse("2026-10-05T12:00:00Z");
  const items = [
    { kind: "go", iddId: "IDD-1", title: "t", decisions: [], criteria: [] },
    { kind: "outbound", iddId: "OUT-20260928T010203-ab12", title: "t" },
    { kind: "go", iddId: "IDD-3", title: "t", decisions: [], criteria: [], snoozedUntil: "2026-10-05T13:00:00Z" },
  ];
  const url = new URL(inboxCardUrl("OUT-20260928T010203-ab12"));
  assert.equal(url.pathname, "/gui/", "the engine serves the screen under /gui");
  assert.equal(initialScreen(url.search, url.hash).view, "inbox");
  const id = cardFromQuery(url.search);
  assert.equal(id, "OUT-20260928T010203-ab12");
  assert.equal(cardNamed(deck(items, NOW).front, id)?.kind, "outbound");
  // a card that is not in the front (put off by the engine) or not there is not found, and the Inbox stays as ordered
  assert.equal(cardNamed(deck(items, NOW).front, "IDD-3"), null);
  assert.equal(cardNamed(deck(items, NOW).front, "IDD-9"), null);
  // with no card named the URL opens the Inbox alone
  const plain = new URL(inboxCardUrl());
  assert.equal(cardFromQuery(plain.search), null);
  assert.equal(initialScreen(plain.search, plain.hash).view, "inbox");
});

import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";
import { allSupported, duplicate, go, proposalOverview, proposalSupersede, question, unsupportedFuture, unsupportedOutbound, unsupportedReview, unsupportedShip } from "./fixtures/items.mjs";

const { deck, everyCardShown, itemKey } = await load("./src/inbox/deck.ts");
const { cardKindOf } = await load("./src/inbox/viewmodel.ts");
const { decorate } = await import("./fixtures/items.mjs");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const card = (kind, iddId, extra = {}) => ({ kind, iddId, ...extra });

test("no kind is set aside as one the screen cannot handle: each is drawn, and the ones with no shape of their own are drawn generically", () => {
  // the deck holds no notion of an unsupported card any more (C-265-3)
  for (const item of [...allSupported, unsupportedShip, unsupportedOutbound, unsupportedReview, unsupportedFuture]) {
    assert.notEqual(cardKindOf(item), "unsupported", item.kind);
  }
  assert.equal(cardKindOf(unsupportedReview), "generic");
  assert.equal(cardKindOf(unsupportedFuture), "generic");
  assert.equal(cardKindOf(unsupportedShip), "submit");
  // a kind this screen never heard of is in the deck like any other, with what the engine answered for it
  assert.deepEqual(deck([unsupportedFuture], NOW).front.map((i) => i.kind), ["cosmic"]);
});

test("the cards the state returns are all somewhere in the deck or the sidebar", () => {
  const items = [
    card("question", "#1", { batchId: "b", askedTotal: 1, answeredCount: 0, open: [] }),
    card("go", "#2", { title: "t", decisions: [], criteria: [] }),
    card("ship", "#3", { title: "t" }),
    card("go", "#4", { title: "t", decisions: [], criteria: [], snoozedUntil: "2026-10-05T13:00:00Z" }),
    card("ship", "#5", { title: "t", sleptAt: "2026-10-01T00:00:00Z" }),
  ];
  const view = deck(items, NOW);
  assert.equal(everyCardShown(items, NOW), true);
  assert.equal(view.front.length + view.later.length + view.sleeping.length, items.length);
  assert.equal(view.front.length, 3);
  assert.equal(view.later.length, 1);
  assert.equal(view.sleeping.length, 1);
});

test("the badge counts the front including the cards drawn generically", () => {
  const view = deck([go, unsupportedReview, duplicate], NOW);
  assert.equal(view.count, 3);
});

test("a decided card stays hidden until a newer state brings it back", () => {
  const view = deck([go], NOW, [itemKey(go)]);
  assert.equal(view.front.length, 0);
  assert.equal(view.count, 0);
});

test("the front keeps the engine's own order otherwise", () => {
  const view = deck([question, go, duplicate], NOW);
  assert.deepEqual(view.front.map((i) => i.kind), ["question", "go", "duplicate"]);
});

test("AC-030 / INV-112-6: two proposals of one lane are two cards, and putting one off leaves the other", () => {
  const items = [proposalOverview, decorate({ ...proposalSupersede, snoozedUntil: "2026-10-05T13:00:00Z" })];
  assert.notEqual(itemKey(proposalOverview), itemKey(proposalSupersede));
  const view = deck(items, NOW);
  assert.deepEqual(view.front.map((i) => i.proposalId), ["PROP-1"]);
  assert.deepEqual(view.later.map((i) => i.proposalId), ["PROP-3"]);
  assert.equal(everyCardShown(items, NOW), true);
});

test("a card the person brought to the front from the sidebar comes first; the engine's order stays behind it", () => {
  const items = [go, question, duplicate];
  const before = deck(items, NOW).front.map((i) => i.iddId);
  const last = before[before.length - 1];
  const picked = deck(items, NOW, [], itemKey(items.find((i) => i.iddId === last))).front.map((i) => i.iddId);
  assert.equal(picked[0], last);
  assert.deepEqual(picked.slice(1), before.filter((id) => id !== last));
  // a key that is in no card leaves the order alone
  assert.deepEqual(deck(items, NOW, [], "nothing").front.map((i) => i.iddId), before);
});

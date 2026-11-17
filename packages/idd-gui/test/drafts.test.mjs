import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";
import { outboundReplies, shipNewPr } from "./fixtures/items.mjs";

const { applyDrafts, emptyDrafts, setOutboundField, setOutboundReply, setShipField, shipEntryOf, outboundEntryOf } = await load("./src/inbox/drafts.ts");
const { buildShipApproval, buildOutboundApproval, shipDraftFor, outboundDraftFor } = await load("./src/inbox/approval.ts");
const { shipCardKey } = await load("./src/engine/contract.ts");

test("a field penne edited survives a read that carries another draft", () => {
  let state = applyDrafts(emptyDrafts(), [shipNewPr]);
  state = setShipField(state, shipNewPr, "title", "編集した題");
  const next = { ...shipNewPr, proposal: { ...shipNewPr.proposal, pr: { title: "届いた題", body: "届いた本文" } } };
  state = applyDrafts(state, [next]);
  const entry = shipEntryOf(state, next);
  assert.equal(entry.draft.title, "編集した題");
  // the body was not touched, so it takes the fresh value
  assert.equal(entry.draft.body, "届いた本文");
});

test("a submit at a new head does not carry the edits of the old one", () => {
  let state = applyDrafts(emptyDrafts(), [shipNewPr]);
  state = setShipField(state, shipNewPr, "title", "編集した題");
  const moved = { ...shipNewPr, head: "b1b1b1b" };
  assert.notEqual(shipCardKey(moved), shipCardKey(shipNewPr));
  state = applyDrafts(state, [moved]);
  assert.equal(shipEntryOf(state, moved).draft.title, shipDraftFor(moved).title);
});

test("a card that is gone leaves no draft behind", () => {
  let state = applyDrafts(emptyDrafts(), [shipNewPr, outboundReplies]);
  state = setShipField(state, shipNewPr, "title", "x");
  state = applyDrafts(state, [outboundReplies]);
  assert.equal(Object.keys(state.ship).length, 0);
  assert.equal(Object.keys(state.outbound).length, 1);
});

test("an edited reply survives a read, and a fresh reply body replaces an untouched one", () => {
  let state = applyDrafts(emptyDrafts(), [outboundReplies]);
  state = setOutboundReply(state, outboundReplies, "store.ts:12", { body: "書き換えた", resolve: false });
  const next = { ...outboundReplies, replies: outboundReplies.replies.map((r) => ({ ...r, proposed: "新しく届いた" })) };
  state = applyDrafts(state, [next]);
  const entry = outboundEntryOf(state, next);
  assert.equal(entry.draft.replies[0].body, "書き換えた");
  assert.equal(entry.draft.replies[0].resolve, false);
  assert.equal(entry.draft.replies[1].body, "新しく届いた");
});

test("changing the sent content closes an open confirm (its key changes)", () => {
  const state = applyDrafts(emptyDrafts(), [shipNewPr]);
  const before = buildShipApproval(shipNewPr, shipEntryOf(state, shipNewPr).draft).confirmKey;
  const after = buildShipApproval(shipNewPr, { ...shipEntryOf(state, shipNewPr).draft, body: "別の本文" }).confirmKey;
  assert.notEqual(before, after);
});

test("an outbound draft's edits also change the confirm's identity", () => {
  const state = applyDrafts(emptyDrafts(), [outboundReplies]);
  const before = buildOutboundApproval(outboundReplies, outboundEntryOf(state, outboundReplies).draft).confirmKey;
  const edited = setOutboundField(state, outboundReplies, { event: "comment" });
  const after = buildOutboundApproval(outboundReplies, outboundEntryOf(edited, outboundReplies).draft).confirmKey;
  assert.equal(before, after, "the same kind of review keeps the same identity");
  const changed = buildOutboundApproval(outboundReplies, outboundEntryOf(state, outboundReplies).draft);
  assert.notEqual(changed.confirmKey, buildOutboundApproval(outboundReplies, { ...outboundDraftFor(outboundReplies), title: "題" }).confirmKey);
});

import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";
import { outboundBody, outboundIssue, outboundReplies, outboundRepliesOnePosted, outboundReview, outboundReviewApprove } from "./fixtures/items.mjs";

const { buildOutboundApproval, outboundDraftFor } = await load("./src/inbox/approval.ts");
const { EMPTY_CONTEXT, intentForKey, cardActions } = await load("./src/inbox/keymap.ts");

const CTX = { ...EMPTY_CONTEXT };

test("editing a reply and unchecking Resolve changes the approval's parts", () => {
  const draft = outboundDraftFor(outboundReplies);
  const edited = {
    ...draft,
    replies: draft.replies.map((r, i) => (i === 0 ? { ...r, body: "書き換えた返信", resolve: false } : r)),
  };
  const view = buildOutboundApproval(outboundReplies, edited);
  assert.equal(view.payload.parts[0].body, "書き換えた返信");
  assert.equal(view.payload.parts[0].resolve, false);
  assert.equal(view.ready, true);
});

test("a posted reply is not counted as one to post", () => {
  const view = buildOutboundApproval(outboundRepliesOnePosted, outboundDraftFor(outboundRepliesOnePosted));
  assert.equal(view.toPost, 1);
  assert.match(view.ask, /1 件返信/);
});

test("the review card's left key discards, and an Approve with an empty body may go while another kind may not", () => {
  const back = cardActions(outboundReview, CTX).find((s) => s.position === "back").buttons[0];
  assert.equal(back.label, "捨てる");
  // the engine says the discard cannot be taken back, so the press opens its confirm and the next press in it sends
  assert.equal(back.intent.kind, "confirm_open");
  const opened = intentForKey(outboundReview, { key: "ArrowLeft" }, CTX);
  assert.equal(opened.kind, "confirm_open");
  assert.equal(intentForKey(outboundReview, { key: "ArrowLeft" }, { ...CTX, confirm: opened.confirmKey }).kind, "outbound_discard");

  assert.equal(buildOutboundApproval(outboundReview, { ...outboundDraftFor(outboundReview), body: "" }).ready, false);
  const approve = buildOutboundApproval(outboundReviewApprove, outboundDraftFor(outboundReviewApprove));
  assert.equal(approve.ready, true);
  assert.equal(intentForKey(outboundReviewApprove, { key: "ArrowRight" }, CTX).kind, "confirm_open");
});

test("an issue whose title is empty cannot be approved", () => {
  const draft = { ...outboundDraftFor(outboundIssue), title: "" };
  const view = buildOutboundApproval(outboundIssue, draft);
  assert.equal(view.ready, false);
  assert.match(view.why, /題が空/);
  assert.equal(intentForKey(outboundIssue, { key: "ArrowRight" }, { ...CTX, outbound: draft }), null);
});

test("a PR body with no change cannot be approved", () => {
  const view = buildOutboundApproval(outboundBody, outboundDraftFor(outboundBody));
  assert.equal(view.bodyUnchanged, true);
  assert.equal(view.ready, false);
  assert.match(view.why, /差分がありません/);
});

test("the confirm shows the destination and every reply's full body and Resolve", () => {
  const draft = outboundDraftFor(outboundReplies);
  const view = buildOutboundApproval(outboundReplies, draft);
  const rows = view.confirmRows.map((r) => `${r.label}:${r.value}`).join("\n");
  assert.match(rows, /Review への返信/);
  for (const part of view.payload.parts) assert.ok(rows.includes(part.body), part.ref);
  assert.match(rows, /Resolve する/);
  const review = buildOutboundApproval(outboundReview, outboundDraftFor(outboundReview));
  const reviewRows = review.confirmRows.map((r) => `${r.label}:${r.value}`).join("\n");
  assert.match(reviewRows, /コメント/);
  assert.match(reviewRows, /needs-review を外す/);
});

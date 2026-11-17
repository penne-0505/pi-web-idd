import assert from "node:assert/strict";
import test from "node:test";
import { answered, load, signatureOf } from "./helpers.mjs";

const { buildBatchApproval, batchDraftFor } = await load("./src/inbox/approval.ts");
const { EMPTY_CONTEXT, intentForKey, cardActions } = await load("./src/inbox/keymap.ts");
const { applyDrafts, emptyDrafts, setBatchLane, batchDraftOf } = await load("./src/inbox/drafts.ts");
const { deck } = await load("./src/inbox/deck.ts");
const { cardKindOf } = await load("./src/inbox/viewmodel.ts");

const lane = (n, extra = {}) => ({
  iddId: `IDD-${n}`, title: `feat: lane ${n}`, head: `${String(n).repeat(40)}`, branch: `idd/IDD-${n}`,
  close: { repo: "test/demo", issue: n, comment: `#${n} を閉じます` }, ...extra,
});
const batch = (extra = {}) => answered({
  kind: "land-batch", iddId: "batch:abc", title: "work-main へまとめて取り込む（3 本）",
  repo: "/work", repoName: "test/demo", workBase: "work-main", lanes: [lane(1), lane(2), lane(3)], ...extra,
});
const CTX = { ...EMPTY_CONTEXT, keyCount: 1 };

test("the screen draws a batch card: it reads as a signing submit card", () => {
  assert.equal(cardKindOf(batch()), "submit");
  assert.deepEqual(deck([batch()], Date.now()).front.map((i) => i.kind), ["land-batch"]);
});

test("AC-001: the approval names the repo, the branch and every lane left on the card, in order", () => {
  const view = buildBatchApproval(batch(), batchDraftFor());
  assert.equal(view.ready, true);
  assert.equal(view.action, "land_batch_approve");
  assert.deepEqual(view.payload, { batch: "batch:abc", repo: "/work", workBase: "work-main", lanes: [1, 2, 3].map((n) => ({ iddId: `IDD-${n}`, head: String(n).repeat(40), close: { repo: "test/demo", issue: n, comment: `#${n} を閉じます` } })) }, "each lane carries the head and the whole close the card shows");
  const text = view.confirmRows.map((r) => `${r.label}: ${r.value}`).join("\n");
  for (const n of [1, 2, 3]) assert.match(text, new RegExp(`IDD-${n} .*${String(n).repeat(9)}`));
  assert.match(text, /Issue #2（test\/demo）を閉じる/);
});

test("AC-002: a lane taken off is not in the payload or the confirm, and putting it back restores it", () => {
  const item = batch();
  let drafts = applyDrafts(emptyDrafts(), [item]);
  drafts = setBatchLane(drafts, item, "IDD-2", true);
  const off = buildBatchApproval(item, batchDraftOf(drafts, item));
  assert.deepEqual(off.payload.lanes.map((l) => l.iddId), ["IDD-1", "IDD-3"]);
  assert.equal(off.confirmRows.some((r) => r.value.includes("IDD-2 feat")), false);
  assert.equal(off.confirmRows.find((r) => r.label === "外した lane")?.value, "IDD-2");
  // the signed content changes with it: the open confirm closes
  assert.notEqual(off.confirmKey, buildBatchApproval(item, batchDraftFor()).confirmKey);
  drafts = setBatchLane(drafts, item, "IDD-2", false);
  assert.deepEqual(buildBatchApproval(item, batchDraftOf(drafts, item)).payload.lanes.map((l) => l.iddId), ["IDD-1", "IDD-2", "IDD-3"]);
});

test("a read of the state keeps the lanes taken off and lets go of a lane the card no longer offers", () => {
  const item = batch();
  let drafts = setBatchLane(applyDrafts(emptyDrafts(), [item]), item, "IDD-3", true);
  drafts = applyDrafts(drafts, [item]);
  assert.deepEqual([...batchDraftOf(drafts, item).off], ["IDD-3"]);
  const fewer = batch({ lanes: [lane(1), lane(2)] });
  drafts = applyDrafts(drafts, [fewer]);
  assert.deepEqual([...batchDraftOf(drafts, fewer).off], []);
});

test("with every lane taken off, or while a signed batch is under way, nothing can be signed", () => {
  const item = batch();
  const none = buildBatchApproval(item, { off: new Set(["IDD-1", "IDD-2", "IDD-3"]) });
  assert.equal(none.ready, false);
  const running = batch({ running: { phase: "checking", lanes: ["IDD-1"], checking: true } });
  const view = buildBatchApproval(running, batchDraftFor());
  assert.equal(view.ready, false);
  assert.match(view.why, /検査しています/);
  const primary = cardActions(running, CTX).find((s) => s.position === "primary").buttons[0];
  assert.equal(primary.intent, null);
});

test("the right key opens the confirm, and the second press is the frozen signed approval", () => {
  const item = batch();
  const right = (ctx) => intentForKey(item, { key: "ArrowRight" }, ctx);
  assert.equal(right(CTX).kind, "confirm_open");
  const second = right({ ...CTX, confirmOpen: true });
  assert.equal(signatureOf(second, batch()), "passkey_or_pin");
  assert.equal(second.action, "land_batch_approve");
  assert.deepEqual(second.payload.lanes.map((l) => l.iddId), ["IDD-1", "IDD-2", "IDD-3"]);
  // no key registered: the right end does not open the confirm
  assert.equal(right({ ...EMPTY_CONTEXT, keyCount: 0 }), null);
});

test("the open confirm closes when the repo, the branch, a head or the whole close of a kept lane changes", () => {
  const key = (item, draft = batchDraftFor()) => buildBatchApproval(item, draft).confirmKey;
  const base = key(batch());
  assert.equal(key(batch()), base);
  const laneTwo = (over) => batch({ lanes: [lane(1), lane(2, over), lane(3)] });
  for (const changed of [
    batch({ repoName: "test/other" }), batch({ repo: "/work2" }), batch({ workBase: "work-main2" }),
    laneTwo({ head: "f".repeat(40) }), laneTwo({ title: "別の題" }), laneTwo({ close: { repo: "test/other", issue: 2, comment: "#2 を閉じます" } }), laneTwo({ close: { repo: "test/demo", issue: 2, comment: "別の一言" } }),
  ]) assert.notEqual(key(changed), base);
  // a lane taken off a close that changes does not move the key of the lanes that stay
  const off = { off: new Set(["IDD-2"]) };
  assert.equal(key(laneTwo({ close: { repo: "test/demo", issue: 2, comment: "別の一言" } }), off), key(batch(), off));
});

import assert from "node:assert/strict";
import test from "node:test";
import { answered, load } from "./helpers.mjs";
import { shipLand, shipLandConflict, shipLandPending, shipNewPr, shipNoCheck, shipR2Gate } from "./fixtures/items.mjs";

const { buildShipApproval, shipDraftFor } = await load("./src/inbox/approval.ts");
const { EMPTY_CONTEXT, intentForKey, cardActions } = await load("./src/inbox/keymap.ts");

const CTX = { ...EMPTY_CONTEXT };
const uncontrolled = answered({ ...shipLand, land: null });

test("the six destinations each show their own words, all signing", () => {
  const local = answered({ ...shipNewPr, proposal: { ...shipNewPr.proposal, mode: "local" }, commit: undefined });
  const prOnly = answered({ ...shipNewPr, pushed: { branch: "lane/142", commit: "a41c9e2" } });
  const pushToPr = answered({ ...shipNewPr, existingPr: { url: "u", number: 5 }, pushed: undefined });
  const recordOnPr = answered({ ...shipNewPr, pushed: { branch: "lane/142", commit: "a41c9e2" }, existingPr: { url: "u", number: 5 }, prCheckFailed: "PR の確認に失敗" });
  const cases = [
    [shipLand, "land", "署名して取り込む"],
    [local, "local", "署名して完了"],
    [shipNewPr, "new-pr", "署名して PR を作る"],
    [prOnly, "pr-only", "署名して PR を作る"],
    [pushToPr, "push-to-pr", "署名して push"],
    [recordOnPr, "record-on-pr", "署名して記録"],
  ];
  for (const [item, kind, label] of cases) {
    const view = buildShipApproval(item, shipDraftFor(item));
    assert.equal(view.kind, kind, kind);
    assert.equal(view.primaryLabel, label, kind);
    assert.equal(view.sign, true, kind);
  }
});

test("the first -> opens the confirm, and the confirm's rows carry the message, the title and the body", () => {
  assert.equal(intentForKey(shipNewPr, { key: "ArrowRight" }, CTX).kind, "confirm_open");
  const view = buildShipApproval(shipNewPr, shipDraftFor(shipNewPr));
  const rows = view.confirmRows.map((r) => `${r.label}:${r.value}`).join("\n");
  for (const text of [view.payload.commitMessage, view.payload.pr.title, view.payload.pr.body].map(String)) assert.ok(rows.includes(text), text);
});

test("the payload is built from the edited text, and the confirm key changes with it", () => {
  const edited = { ...shipDraftFor(shipNewPr), title: "別の題", body: "別の本文", commitMessage: "chore: 別" };
  const view = buildShipApproval(shipNewPr, edited);
  assert.equal(view.payload.pr.title, "別の題");
  assert.equal(view.payload.pr.body, "別の本文");
  assert.equal(view.payload.commitMessage, "chore: 別");
  assert.notEqual(view.confirmKey, buildShipApproval(shipNewPr, shipDraftFor(shipNewPr)).confirmKey);
});

test("a landing whose check cannot be offered, and one already approved, put no operation at the right end", () => {
  for (const item of [uncontrolled, shipLandPending, shipLandConflict]) {
    const view = buildShipApproval(item, shipDraftFor(item));
    assert.equal(view.primary, "none", item.iddId);
    assert.equal(view.why !== null, true);
    assert.equal(intentForKey(item, { key: "ArrowRight" }, CTX), null);
  }
});

test("the four card states that cannot be approved show the reason at the operation", () => {
  const noKey = { ...CTX, keyCount: 0 };
  for (const [item, ctx] of [[uncontrolled, CTX], [shipLandPending, CTX], [shipLandConflict, CTX], [shipNewPr, noKey]]) {
    const primary = cardActions(item, ctx).find((s) => s.position === "primary").buttons[0];
    assert.equal(primary.intent, null, item.iddId);
  }
});

test("an item that still carries an R2 gate is approved as the plain push, with no override in the payload", () => {
  const view = buildShipApproval(shipR2Gate, shipDraftFor(shipR2Gate));
  const plain = buildShipApproval(shipNewPr, shipDraftFor(shipNewPr));
  assert.equal(view.primary, "approve");
  assert.equal(view.primaryLabel, plain.primaryLabel);
  assert.equal("r2Override" in view.payload, false);
  const rows = view.confirmRows.map((r) => `${r.label}:${r.value}`).join("\n");
  assert.doesNotMatch(rows, /R2/);
});

test("the submit card still asks for a check when it cannot be approved yet", () => {
  const view = buildShipApproval(shipNoCheck, shipDraftFor(shipNoCheck));
  assert.equal(view.primary, "check");
  assert.equal(view.primaryLabel, "検査し直す");
  const intent = intentForKey(shipNoCheck, { key: "ArrowRight" }, CTX);
  assert.equal(intent.kind, "ship_check");
  assert.equal(intent.payload.iddId, "#143");
});

test("a records-only landing offers no signature and no check, and its send-back stays", () => {
  const reason = "記録だけの lane は merge できません（本流との差分が overlay.manifest の記録だけで、公開側に何も加えません）。前提待ちで戻った lane なら前提の着地後に差し戻して実装させ、実装の要らない lane なら無視して閉じてください";
  const item = answered({ ...shipLand, recordsOnly: { reason } });
  const view = buildShipApproval(item, shipDraftFor(item));
  assert.equal(view.primary, "none");
  assert.equal(view.sign, false);
  assert.equal(view.action, null);
  assert.equal(view.why, reason);
  assert.equal(intentForKey(item, { key: "ArrowRight" }, CTX), null);
  const slots = cardActions(item, CTX);
  assert.equal(slots.find((s) => s.position === "primary").buttons[0].intent, null);
  assert.deepEqual(slots.find((s) => s.position === "back").buttons[0].intent, { kind: "note_open" });
});

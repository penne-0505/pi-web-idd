/**
 * The screen draws and answers every card from the engine's own answer on it (`decision`): the operations that exist,
 * which are held and why, what they need and how they are signed. It derives none of that from the card's fields, holds
 * no list of the operations that leave the machine or need a signature, and sets no kind aside as one it cannot handle.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { answered, h, load, NOOP, readInbox, render, signatureOf, ui } from "./helpers.mjs";
import { AT, FOURTEEN as RAW_FOURTEEN } from "../../idd-engine/src/server/card-kinds.fixture.mjs";
import { go, shipNewPr, shipNoCheck, stuckLimit } from "./fixtures/items.mjs";

const { inboxVals, cardKindOf } = await load("./src/inbox/viewmodel.ts");
const { requestFor } = await load("./src/inbox/requests.ts");
const { buildShipApproval, shipDraftFor } = await load("./src/inbox/approval.ts");
const { cardActions, intentForKey, operationConfirmKey, EMPTY_CONTEXT } = await load("./src/inbox/keymap.ts");
const { InboxStore, receiptFor } = await load("./src/inbox/useDecide.ts");
const cards = await load("./src/components/inbox/InboxCards.tsx");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const NOW = Date.parse("2026-10-05T12:00:00Z");

const FOURTEEN = RAW_FOURTEEN.map((item) => answered({ appearedAt: AT, ...item }));

const front = async (item, over = {}) => inboxVals(ui(over), await readInbox([item], {}, NOW), NOOP);

test("AC-001: the fourteen kinds are each drawn with a card, a panel and a way to answer, and none is called unsupported", async () => {
  assert.equal(new Set(FOURTEEN.map((i) => i.kind)).size, 14);
  for (const item of FOURTEEN) {
    assert.notEqual(cardKindOf(item), "unsupported", item.kind);
    const vm = await front(item);
    assert.ok(vm.card, `${item.kind}: a card`);
    assert.ok(vm.panel, `${item.kind}: a panel`);
    const buttons = [...vm.actions.left, ...vm.actions.middle, ...vm.actions.right, ...(vm.actions.later ? [vm.actions.later] : [])];
    assert.ok(buttons.some((b) => !b.disabled && b.label), `${item.kind}: something the person can press`);
    // the screen sends the visitor nowhere else: no entrance to the current GUI is on any card
    assert.equal("oldGuiUrl" in vm.card, false, item.kind);
    assert.equal("canSkip" in vm.card, false, item.kind);
  }
});

test("AC-001: the four kinds the screen used to set aside are read from the materials and answered from the operations", async () => {
  const [, , granularity, , review, , , , , , storage, reload] = FOURTEEN;
  for (const item of [review, granularity, reload, storage]) {
    const vm = await front(item);
    assert.equal(vm.card.cardKind, "generic", item.kind);
    const html = render(h(cards.GenericCard, { card: vm.card, on: NOOP }));
    assert.doesNotMatch(html, /今の GUI/, item.kind);
    assert.doesNotMatch(html, /扱えない/, item.kind);
  }
  // the materials the engine gave are the rows of the card (a worded label for a key it knows, the key itself otherwise)
  const lowSpace = await front(storage);
  assert.ok(lowSpace.card.material.some((r) => r.value === "0.0G / 0.0G"), "the free space is read from the materials");
  const replacement = await front(reload);
  assert.ok(replacement.card.material.some((r) => r.value.includes("会話")), "the open conversations are read from the materials");

  // the review's three answers reach the engine as the engine named them, the line of text under the field it named
  const retry = requestFor({ kind: "operate", op: "reject_retry", text: "直して" }, review);
  assert.equal(retry.signature, "none");
  for (const [item, intent, action, payload] of [
    [review, { op: "reject_retry", text: "直して" }, "s3_reject", { iddId: "#1", nextStage: "s2_retry", feedback: "直して" }],
    [review, { op: "ok" }, "s3_ok", { iddId: "#1" }],
    [granularity, { op: "single" }, "granularity_single", { iddId: "#1" }],
  ]) assert.deepEqual(requestFor({ kind: "operate", ...intent }, item).body, { action, payload });
  // the replacement goes to the engine's reload door, not the decide door
  assert.equal(requestFor({ kind: "operate", op: "reload" }, reload).path, "/api/idd/reload");
  // a kind the engine adds later is drawn and answered with no change to the screen
  const future = answered({ kind: "cosmic", iddId: "#9", appearedAt: AT });
  const later = await front(future);
  assert.equal(later.card.cardKind, "generic");
  assert.equal(requestFor({ kind: "operate", op: "anything" }, future), null, "the engine named no such operation, so nothing is sent");
});

test("AC-002: a text-taking operation opens the card's one line first, and an empty required line sends nothing", () => {
  const [, , , , review] = FOURTEEN;
  const primary = (ctx) => cardActions(review, ctx).find((s) => s.position === "primary").buttons[0];
  // the first operation is the main one, and the engine says it cannot be taken back, so the press opens a confirm first
  assert.equal(primary(EMPTY_CONTEXT).intent.kind, "confirm_open");
  const back = (ctx) => cardActions(review, ctx).find((s) => s.position === "back").buttons;
  assert.deepEqual(back(EMPTY_CONTEXT)[0].intent, { kind: "note_open", op: "reject_retry" });
  assert.equal(back({ ...EMPTY_CONTEXT, noteOpen: true, note: "  " })[0].intent, null);
  assert.deepEqual(back({ ...EMPTY_CONTEXT, noteOpen: true, note: "直して" })[0].intent, { kind: "operate", op: "reject_retry", text: "直して" });
  assert.deepEqual(intentForKey(review, { key: "ArrowLeft" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "直して" }), { kind: "operate", op: "reject_retry", text: "直して" });
});

test("AC-002: an operation the engine holds is drawn held, with its reason, and no key promises it", async () => {
  const over = answered({ ...FOURTEEN[2], proposal: { ...FOURTEEN[2].proposal, approvable: false } });
  const primary = cardActions(over, EMPTY_CONTEXT).find((s) => s.position === "primary").buttons[0];
  assert.equal(primary.intent, null);
  assert.equal(primary.key, "", "no key is shown for a held operation");
  assert.match(primary.held, /上限/);
  assert.equal(intentForKey(over, { key: "ArrowRight" }, EMPTY_CONTEXT), null, "the key means nothing either");
  assert.equal(requestFor({ kind: "operate", op: "approve" }, over), null, "a held operation sends nothing even if an intent is made for it");
  const vm = await front(over);
  assert.match(vm.card.heldReason, /上限/);
  const html = render(h(cards.GenericCard, { card: vm.card, on: NOOP }));
  assert.match(html, /data-held-reason/);
  assert.equal(vm.actions.right[0].disabled, true);
});

test("AC-004: a GO the engine holds says why and promises no →; a GO sends the Purposes the answer named and no others", async () => {
  const held = answered({ ...go, intentPath: "_docs/intent/x/" });
  const vm = await front(held);
  assert.match(vm.card.heldReason, /契約/);
  assert.ok(!vm.actions.right[0].key, "no → is promised");
  assert.equal(intentForKey(held, { key: "ArrowRight" }, EMPTY_CONTEXT), null);
  // even when a reason is required, the held GO opens no line to write it in
  const needing = answered({ ...held, planReview: { state: "skipped", must: 0, should: 0, nit: 0, findings: [], needsReason: true } });
  assert.equal((await front(needing, { reasonOpen: true })).card.reason, undefined);

  const withPurposes = answered({ ...go, purposeProposals: [{ id: "P-1", statement: "一つ目", origin: "o" }] });
  const press = intentForKey(withPurposes, { key: "ArrowRight" }, EMPTY_CONTEXT);
  assert.deepEqual(press.purposes, [{ id: "P-1", statement: "一つ目" }]);
  // a Purpose added after the card was shown is not in the answer the press was made from
  const grown = answered({ ...withPurposes, purposeProposals: [...withPurposes.purposeProposals, { id: "P-2", statement: "後から足された", origin: "o" }] });
  assert.deepEqual(requestFor(press, grown).body.payload.purposes.map((p) => p.id), ["P-1"], "the press made from the card as shown names P-1 alone, and the later one is not added to it");
  const shrunk = answered({ ...withPurposes, purposeProposals: [] });
  assert.equal("purposes" in requestFor(press, shrunk).body.payload, false, "a Purpose the card no longer names is not confirmed");
});

test("AC-003: the screen holds no list of the operations that leave the machine or need a signature, and a signed one asks for its signature from the engine's answer", () => {
  for (const dir of ["packages/idd-gui/src", "lib/idd-ui"]) {
    const walk = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(d, e.name)] : []));
    for (const file of walk(dir)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const word of ["isOutboundAction", "OUTBOUND_ACTIONS", "SIGNED_LOCAL_ACTIONS", "PURPOSE_PROPOSAL_ACTIONS", "needsSignature", "signingIntent", "unclassifiedActions"]) {
        assert.equal(text.includes(word), false, `${file} must not carry ${word}`);
      }
    }
  }
  assert.equal(existsSync(join(ROOT, "lib/idd-ui/decide-actions.ts")), false, "the shared list is gone");
  assert.equal(signatureOf({ kind: "ship_approve", action: "s4_verify_clean", payload: {} }, shipNewPr), "passkey_or_pin");
  assert.equal(signatureOf({ kind: "outbound_discard" }, FOURTEEN[7]), "none");
  assert.equal(signatureOf({ kind: "proposal_approve" }, FOURTEEN[12]), "none");
  // the action of a request is the card's own operation: an intent that names another action cannot send it
  assert.equal(requestFor({ kind: "ship_approve", action: "land_batch_approve", payload: {} }, FOURTEEN[7]).body.action, "outbound_approve");
});

test("AC-002: the screen derives no operation from a field: the old guesses are gone from the source", () => {
  for (const file of ["packages/idd-gui/src/inbox/keymap.ts", "packages/idd-gui/src/inbox/viewmodel.ts", "packages/idd-gui/src/inbox/requests.ts", "packages/idd-gui/src/inbox/deck.ts", "packages/idd-gui/src/inbox/useDecide.ts", "packages/idd-gui/src/model/useModel.ts", "packages/idd-engine/src/gui-contract.ts"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const word of ["canGoAsIs", "stuckShape", "hasNoShape", "decide-actions", "SUPPORTED_KINDS", "isUnsupported", "unsupported_skip", "shipApproval,", "offersCheck"]) {
      assert.equal(text.includes(word), false, `${file} must not carry ${word}`);
    }
  }
});

test("AC-005: the submit approval's reservation is the engine's, and the screen only shows whether the text meets the conditions", () => {
  const item = answered({
    ...shipNewPr,
    head: "h1",
    proposal: { ...shipNewPr.proposal, head: "h1", blocking: 0, mode: "pr", expiresAt: "2999-01-01T00:00:00Z" },
  });
  const approve = item.decision.operations.find((o) => o.id === "approve");
  assert.deepEqual(approve.conditions.map((c) => c.id), ["fresh", "commit_message", "pr_title"]);
  const ok = shipDraftFor(item);
  const readiness = (draft, now = NOW) => buildShipApproval(item, draft, now);
  assert.equal(readiness(ok).ready, true);
  // the person's text decides the conditions the engine named
  assert.equal(readiness({ ...ok, title: "  " }).why, "PR の題名が空です");
  for (const [draft, now] of [[{ ...ok, title: "  " }, NOW], [{ ...ok, commitMessage: "" }, NOW], [ok, Date.parse("3000-01-01T00:00:00Z")]]) {
    assert.equal(readiness(draft, now).ready, false, JSON.stringify([draft.title, draft.commitMessage, now]));
  }
  // what the engine holds, no text can lift: the screen does not look for another reason to call it ready
  const held = answered({ ...item, head: "h2" });
  const heldView = buildShipApproval(held, ok, NOW);
  assert.equal(heldView.ready, false);
  assert.match(heldView.why, /commit が進みました/);
  assert.equal(heldView.primary === "approve", false);
  // a card the engine gave no approval for cannot be approved from the screen
  const bare = { ...item };
  delete bare.decision;
  assert.equal(buildShipApproval(bare, ok, NOW).ready, false);
  assert.equal(buildShipApproval(bare, ok, NOW).action, null);
  // the right end is the check when the approval cannot be given and the engine offers one
  assert.equal(buildShipApproval(shipNoCheck, shipDraftFor(shipNoCheck), NOW).primary, "check");
});

test("AC-005: the last word is the engine's gate: a ready view sends the approval to the signing path, and a held one sends nothing", async () => {
  const engine = (await import("./fake.mjs")).fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const held = answered({ ...stuckLimit, budget: { cost: 1, limit: 0, parts: [], subscription: [] } });
  store.apply({ seq: 1, state: { items: [held] } }, { resync: true });
  const before = engine.calls.length;
  await store.decide({ kind: "stuck_accept", note: "" }, held);
  assert.equal(engine.calls.length, before, "the engine named no accept for a budget stop, so the screen sends none");
});

// ---------------------------------------------------------------- the Purposes a GO confirms

const PURPOSES = [
  { id: "P-1", statement: "一つ目の文", origin: "計画役の案", name: "一つ目", raisedStatement: "元の文" },
  { id: "P-2", statement: "二つ目の文", origin: "計画役の案" },
];

test("F-1: a GO with Purpose proposals shows every sentence its press confirms, and the judgments the engine allows on each", async () => {
  const item = answered({ ...go, purposeProposals: PURPOSES });
  const vm = await front(item);
  assert.deepEqual(vm.card.purposes.map((p) => [p.id, p.statement, p.canRestate, p.canWithdraw]), [["P-1", "一つ目の文", true, true], ["P-2", "二つ目の文", true, true]]);
  assert.match(vm.card.purposes[0].history, /直す前.*元の文/);
  const html = render(h(cards.GoCard, { card: vm.card, on: NOOP }));
  for (const text of ["一つ目の文", "二つ目の文", "計画役の案"]) assert.match(html, new RegExp(text));
  assert.match(html, /data-go-purpose-restate="P-1"/);
  assert.match(html, /data-go-purpose-withdraw="P-2"/);
  // the GO press confirms exactly the Purposes the card shows
  const press = intentForKey(item, { key: "ArrowRight" }, EMPTY_CONTEXT);
  assert.deepEqual(press.purposes.map((p) => p.id), vm.card.purposes.map((p) => p.id));
  assert.deepEqual(press.purposes.map((p) => p.statement), vm.card.purposes.map((p) => p.statement));
  // the panel reads the same sentences
  assert.ok(vm.panel.sections.some((s) => s.rows.some((r) => r.label === "P-2" && r.value === "二つ目の文")));
});

test("F-1: a rewrite and a withdrawal of one Purpose are the engine's operations, name the Purpose, and leave the card where it is", async () => {
  const item = answered({ ...go, purposeProposals: PURPOSES });
  for (const [intent, payload] of [
    [{ kind: "purpose_restate", id: "P-1", statement: "直した文" }, { iddId: item.iddId, id: "P-1", statement: "直した文" }],
    [{ kind: "purpose_withdraw", id: "P-2", grounds: "出典に無い" }, { iddId: item.iddId, id: "P-2", grounds: "出典に無い" }],
  ]) {
    const sent = requestFor(intent, item);
    assert.deepEqual(sent.body, { action: intent.kind, payload });
    assert.equal(sent.keepsCard, true);
    assert.equal(sent.signature, "none");
  }
  // a Purpose the card does not show is not judged from it
  for (const [kind, field] of [["purpose_restate", "statement"], ["purpose_withdraw", "grounds"]]) assert.equal(requestFor({ kind, id: "P-9", [field]: "x" }, item), null, kind);
  // and a card whose answer names none offers none
  const bare = await front(answered({ ...go }));
  assert.equal(bare.card.purposes, undefined);
  assert.equal(requestFor({ kind: "purpose_restate", id: "P-1", statement: "x" }, answered({ ...go })), null);
});

test("F-1: a GO the engine holds still shows the sentences, and its GO stays unpressable", async () => {
  const held = answered({ ...go, intentPath: "_docs/intent/x/", purposeProposals: PURPOSES });
  const vm = await front(held);
  assert.deepEqual(vm.card.purposes.map((p) => p.id), ["P-1", "P-2"]);
  assert.match(vm.card.heldReason, /契約/);
  assert.equal(intentForKey(held, { key: "ArrowRight" }, EMPTY_CONTEXT), null);
});

// ---------------------------------------------------------------- an operation the engine cannot take back

test("F-2: an irreversible operation of a generic card goes through a confirm for exactly this answer and this line", async () => {
  const [, , , , review] = FOURTEEN;
  const ok = review.decision.operations.find((o) => o.id === "ok");
  assert.equal(ok.irreversible, true);
  const key = operationConfirmKey(ok, "");
  const primary = (ctx) => cardActions(review, ctx).find((s) => s.position === "primary").buttons[0].intent;
  assert.deepEqual(primary(EMPTY_CONTEXT), { kind: "confirm_open", confirmKey: key });
  assert.deepEqual(intentForKey(review, { key: "ArrowRight" }, EMPTY_CONTEXT), { kind: "confirm_open", confirmKey: key }, "the key opens the confirm, it sends nothing");
  // only a press made while the confirm for this very answer is open sends it
  assert.deepEqual(primary({ ...EMPTY_CONTEXT, confirm: key }), { kind: "operate", op: "ok" });
  assert.equal(primary({ ...EMPTY_CONTEXT, confirm: "op:ok:{}:" }).kind, "confirm_open", "a confirm opened over another answer sends nothing");
  assert.equal(primary({ ...EMPTY_CONTEXT, confirm: operationConfirmKey({ ...ok, confirmKey: "another" }, "") }).kind, "confirm_open", "the answer changed under the confirm");
  // the engine's key moves with what the person read: the review's material (a criterion, a diff line) is part of it
  const changedMaterial = answered({ ...review, criteria: [{ id: "AC-001", text: "別の条件", state: "todo" }] });
  assert.notEqual(changedMaterial.decision.operations.find((o) => o.id === "ok").confirmKey, ok.confirmKey, "a criterion that changed is another confirm");
  const changedDiff = answered({ ...review, diffs: [{ file: "a.ts", fileIndex: 1, fileTotal: 1, before: [], after: [{ marker: "+", code: "x" }] }] });
  assert.notEqual(changedDiff.decision.operations.find((o) => o.id === "ok").confirmKey, ok.confirmKey, "a diff that changed is another confirm");
  // the stage is drawn, says it is not a signature, and its approve sends the operation
  const sent = [];
  const vm = inboxVals(ui({ confirm: key }), await readInbox([review], {}, NOW), { ...NOOP, dispatch: (i) => sent.push(i) });
  assert.ok(vm.confirming, "the confirm stage is open");
  assert.equal(vm.confirming.sign, false);
  assert.equal(vm.confirming.rows[0].value, "通す");
  vm.confirming.approve.go();
  assert.deepEqual(sent, [{ kind: "operate", op: "ok" }]);
  vm.confirming.cancel.go();
  assert.deepEqual(sent.at(-1), { kind: "confirm_close" });
  // no confirm is drawn while none is open, and Esc closes the one that is
  assert.equal((await front(review)).confirming, null);
  assert.deepEqual(intentForKey(review, { key: "Escape" }, { ...EMPTY_CONTEXT, confirmOpen: true, confirm: key }), { kind: "confirm_close" });
  // a reversible operation needs none
  const retry = cardActions(review, { ...EMPTY_CONTEXT, noteOpen: true, noteOp: "reject_retry", note: "直して" }).find((s) => s.position === "back").buttons[0];
  assert.deepEqual(retry.intent, { kind: "operate", op: "reject_retry", text: "直して" });
  // the replacement that closes the open conversations is one too
  const reload = FOURTEEN[11];
  assert.equal(cardActions(reload, EMPTY_CONTEXT).find((s) => s.position === "primary").buttons[0].intent.kind, "confirm_open");
});

test("F-2: what an irreversible operation did stays on the screen as a line, whatever the operation is", () => {
  const [, , , , review] = FOURTEEN;
  assert.match(receiptFor({ kind: "operate", op: "ok" }, review), /通す/);
  assert.equal(receiptFor({ kind: "operate", op: "reject_retry", text: "x" }, review), null, "a reversible operation leaves no such line");
  assert.match(receiptFor({ kind: "operate", op: "reload" }, FOURTEEN[11]), /閉じて入れ替える/);
});

// ---------------------------------------------------------------- the line belongs to the operation that opened it

const { WORDS } = await load("./src/strings.ts");
const wordsOf = (id) => WORDS.card.generic.op(id);

test("F-3: Enter sends the operation that opened the line, with the line it needs, and never another that takes text", () => {
  const granularity = FOURTEEN[2];
  const names = (item) => item.decision.operations.filter((o) => o.input.kind === "text").map((o) => o.id);
  assert.deepEqual(names(granularity), ["reslice", "revise"]);
  const enter = (ctx) => intentForKey(granularity, { key: "Enter" }, { ...EMPTY_CONTEXT, noteOpen: true, ...ctx });
  // the person opened 直して返す (its text is required): an empty line sends nothing, and a written one sends that operation
  assert.equal(enter({ noteOp: "revise", note: "" }), null, "the required line is kept: Enter does not fall to the other operation");
  assert.deepEqual(enter({ noteOp: "revise", note: "直して" }), { kind: "operate", op: "revise", text: "直して" });
  // opened by 切り直しに返す, whose text is optional
  assert.deepEqual(enter({ noteOp: "reslice", note: "" }), { kind: "operate", op: "reslice" });
  assert.deepEqual(enter({ noteOp: "reslice", note: "3 本で" }), { kind: "operate", op: "reslice", text: "3 本で" });
  // no operation opened it and two take text: nothing is chosen for the person
  assert.equal(enter({ noteOp: null, note: "x" }), null);
  // the buttons open the line for their own operation, and a second button switches it instead of sending the first's line
  const buttons = (ctx) => cardActions(granularity, { ...EMPTY_CONTEXT, ...ctx }).flatMap((s) => s.buttons);
  const byOp = (ctx, op) => buttons(ctx).find((b) => b.label === wordsOf(op));
  assert.deepEqual(byOp({}, "revise").intent, { kind: "note_open", op: "revise" });
  assert.deepEqual(byOp({ noteOpen: true, noteOp: "revise", note: "直して" }, "reslice").intent, { kind: "note_open", op: "reslice" });
  assert.deepEqual(byOp({ noteOpen: true, noteOp: "revise", note: "直して" }, "revise").intent, { kind: "operate", op: "revise", text: "直して" });
  // the line of a card with one operation that takes text is that operation's, whichever opened it
  const review = FOURTEEN[4];
  assert.deepEqual(intentForKey(review, { key: "Enter" }, { ...EMPTY_CONTEXT, noteOpen: true, noteOp: "reject_retry", note: "直す" }), { kind: "operate", op: "reject_retry", text: "直す" });
  // the way back to the plan is the engine's own operation, with its own line: the screen sends the word the engine named
  assert.deepEqual(intentForKey(review, { key: "Enter" }, { ...EMPTY_CONTEXT, noteOpen: true, noteOp: "reject_rethink", note: "考え直して" }), { kind: "operate", op: "reject_rethink", text: "考え直して" });
  assert.deepEqual(requestFor({ kind: "operate", op: "reject_rethink", text: "考え直して" }, review).body, { action: "s3_reject", payload: { iddId: "#1", nextStage: "s1_rethink", feedback: "考え直して" } });
});

// ---------------------------------------------------------------- the review's files, read one at a time inside the card

test("AC-005: a review's changed files are read one at a time inside the card, and the next file is one press away", async () => {
  const files = [
    { file: "a.ts", fileIndex: 1, fileTotal: 2, before: [{ marker: "-", code: "old a" }], after: [{ marker: "+", code: "new a" }] },
    { file: "b.ts", fileIndex: 2, fileTotal: 2, before: [], after: [{ marker: "+", code: "new b" }] },
  ];
  const review = answered({ ...FOURTEEN[4], criteria: [{ id: "AC-001", text: "条件の本文", state: "todo" }], diffs: files });
  const vm = await front(review);
  assert.deepEqual(vm.card.diffs.map((d) => d.file), ["a.ts（1/2）", "b.ts（2/2）"], "every file of the engine's material is a file of the card");
  assert.equal(vm.card.material.some((r) => r.label === "差分の対象"), false, "the files are not rows: the card reads one at a time");
  assert.ok(vm.card.material.some((r) => r.value.includes("条件の本文")), "the criterion's words stay in the rows");
  const html = render(h(cards.GenericCard, { card: vm.card, on: NOOP }));
  assert.match(html, /a\.ts（1\/2）/);
  assert.match(html, /new a/);
  assert.doesNotMatch(html, /new b/, "the second file is not drawn beside the first");
  assert.match(html, /1 \/ 2 file/);
  assert.match(html, /data-diff-next/);
  // a review with no files to read draws no reader
  const none = await front(answered({ ...FOURTEEN[4], criteria: [] }));
  assert.equal(none.card.diffs, undefined);
});

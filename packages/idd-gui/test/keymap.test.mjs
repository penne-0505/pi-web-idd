import assert from "node:assert/strict";
import test from "node:test";
import { answered, load } from "./helpers.mjs";
import { duplicate, go, goBlocked, goWithPurposes, goWithoutContract, outboundReplies, proposalHarm, proposalOverview, proposalSupersede, question, requeue, shipNewPr, shipNoCheck, shipR2Gate, stuckBudget, stuckHalt, stuckHaltNoBack, stuckLimit, stuckOscillation, stuckStall, unsupportedReview, unsupportedShip } from "./fixtures/items.mjs";

const { cardActions, intentForKey, intentForScreen, screenCardActions, isIrreversible, notePlaceholder, EMPTY_CONTEXT } = await load("./src/inbox/keymap.ts");
const { requestFor: requestWithSignature } = await load("./src/inbox/requests.ts");
/** the request as the screen sends it: the part the tests compare is the path, the action and the payload; the signature is checked apart */
const requestFor = (intent, item) => {
  const request = requestWithSignature(intent, item);
  if (!request) return request;
  return { method: request.method, path: request.path, body: request.body };
};
const { WORDS } = await load("./src/strings.ts");

/**
 * A press that sends an operation the engine says cannot be taken back (and needs no signature) opens that operation's confirm
 * first and sends nothing; this is the intent the same press sends once that confirm is open.
 */
const afterConfirm = (item, press, ctx = EMPTY_CONTEXT) => {
  const first = intentForKey(item, press, ctx);
  assert.equal(first?.kind, "confirm_open", `${item.kind}: the press opens the confirm before it sends`);
  assert.equal(requestFor(first, item), null, "opening the confirm sends nothing");
  return intentForKey(item, press, { ...ctx, confirm: first.confirmKey });
};

/** the same press at the screen as a whole */
const afterConfirmScreen = (item, press, ctx = EMPTY_CONTEXT) => {
  const first = intentForScreen("inbox", item, press, ctx);
  assert.equal(first?.kind, "confirm_open");
  return intentForScreen("inbox", item, press, { ...ctx, confirm: first.confirmKey });
};

/** the intents of a slot's buttons as they are sent once each one's confirm is open, so a test can name what a button means */
const settledSlot = (item, position, ctx = EMPTY_CONTEXT) =>
  cardActions(item, ctx).find((s) => s.position === position).buttons.map((b, i) => (b.intent?.kind === "confirm_open"
    ? cardActions(item, { ...ctx, confirm: b.intent.confirmKey }).find((s) => s.position === position).buttons[i].intent
    : b.intent));

const SLOT_KEYS = {
  back: { key: "ArrowLeft", shift: false },
  read: { key: " ", shift: false },
  later: { key: "ArrowDown", shift: false },
  primary: { key: "ArrowRight", shift: false },
};

/** the press each shown key stands for, so a test can press exactly what a button displays */
const HINT_PRESS = {
  "←": { key: "ArrowLeft" },
  "⇧←": { key: "ArrowLeft", shift: true },
  "→": { key: "ArrowRight" },
  "⇧→": { key: "ArrowRight", shift: true },
  "␣": { key: " " },
  "↓": { key: "ArrowDown" },
};

const replan = { to: "plan" };
const recommendation = { choice: "replan", reasons: [{ kind: "round", ref: "1", text: "巡 1" }], shape: "組み直す" };
/** an oscillation card that can take the way back, with and without the judge's recommendation */
const replanBeside = answered({ ...stuckOscillation, onReplan: replan, recommendation });
const replanAlone = answered({ ...stuckOscillation, onReplan: replan });

test("every button's shown key means that button's intent, an open note included", () => {
  const items = [question, go, stuckLimit, stuckBudget, stuckStall, stuckOscillation, stuckHalt, stuckHaltNoBack, duplicate, requeue, unsupportedShip];
  // an open one-line input must not make a key send a decision the button does not show (F-1)
  const contexts = [
    ["no note", EMPTY_CONTEXT],
    ["note open", { ...EMPTY_CONTEXT, noteOpen: true, note: "書いた" }],
  ];
  for (const [name, ctx] of contexts) {
    for (const item of items) {
      for (const slot of cardActions(item, ctx)) {
        for (const [index, button] of slot.buttons.entries()) {
          // the second operation of a split shows no key of its own (聞く): there is nothing to press for it
          if (!button.key) continue;
          const press = HINT_PRESS[button.key];
          assert.ok(press, `no press for ${button.key}`);
          assert.deepEqual(intentForKey(item, press, ctx), button.intent, `${name}/${item.kind}/${slot.position}/${index}/${button.key}`);
        }
      }
    }
  }
});

test("the intents become the API calls the reference table lists", () => {
  const cases = [
    [question, { kind: "answer", questionId: "q1", selection: { index: 2 } }, "/api/idd/decide", { action: "answer", payload: { iddId: "#142", batchId: "b1", questionId: "q1", selection: { index: 2 } } }],
    [question, { kind: "answer", questionId: "q1", selection: { label: "その他" }, notes: "自由な答え" }, "/api/idd/decide", { action: "answer", payload: { iddId: "#142", batchId: "b1", questionId: "q1", selection: { label: "その他" }, notes: "自由な答え" } }],
    [go, { kind: "go_revise", instruction: "直す" }, "/api/idd/decide", { action: "s1_revise", payload: { iddId: "#142", instruction: "直す" } }],
    [go, { kind: "go_go" }, "/api/idd/decide", { action: "s1_go", payload: { iddId: "#142" } }],
    [stuckLimit, { kind: "stuck_ignore" }, "/api/idd/decide", { action: "ignore", payload: { iddId: "#147" } }],
    [stuckLimit, { kind: "stuck_accept", note: "n" }, "/api/idd/decide", { action: "s2_review_accept", payload: { iddId: "#147", note: "n" } }],
    [stuckLimit, { kind: "stuck_continue", note: "n" }, "/api/idd/decide", { action: "s2_review_continue", payload: { iddId: "#147", note: "n", boundaries: [] } }],
    [stuckLimit, { kind: "stuck_hand_fix" }, "/api/idd/decide", { action: "s2_review_hand_fix", payload: { iddId: "#147" } }],
    [replanBeside, { kind: "stuck_replan" }, "/api/idd/decide", { action: "s2_review_replan", payload: { iddId: "#147" } }],
    [answered({ ...stuckLimit, handTurn: true }), { kind: "stuck_hand_fixed" }, "/api/idd/decide", { action: "s2_hand_fixed", payload: { iddId: "#147" } }],
    [stuckBudget, { kind: "stuck_budget" }, "/api/idd/decide", { action: "lane_budget_extend", payload: { iddId: "#147" } }],
    [stuckStall, { kind: "stuck_resume", note: "" }, "/api/idd/decide", { action: "lane_stall_resume", payload: { iddId: "#147", note: "" } }],
    [duplicate, { kind: "duplicate_merge" }, "/api/idd/decide", { action: "merge", payload: { reviewId: "RV-1" } }],
    [duplicate, { kind: "duplicate_anyway" }, "/api/idd/decide", { action: "anyway_go", payload: { reviewId: "RV-1" } }],
    [requeue, { kind: "requeue_ignore" }, "/api/idd/decide", { action: "ignore", payload: { iddId: "#118", reason: "取り込み直しを無視" } }],
    [requeue, { kind: "requeue_go" }, "/api/idd/decide", { action: "s0_requeue_go", payload: { iddId: "#118" } }],
  ];
  for (const [item, intent, path, body] of cases) {
    assert.deepEqual(requestFor(intent, item), { method: "POST", path, body }, intent.kind);
  }
});

test("reading, picking and opening the input send nothing", () => {
  for (const intent of [{ kind: "read" }, { kind: "select", index: 1 }, { kind: "note_open" }, { kind: "ask_open" }, { kind: "note_close" }]) {
    assert.equal(requestFor(intent, go), null);
  }
});

test("a key becomes no card's decision while another screen is up", () => {
  // Work puts no card in front of the user, so the front card's keys must mean nothing there
  for (const item of [question, go, stuckLimit, duplicate, requeue, unsupportedShip]) {
    for (const press of Object.values(SLOT_KEYS)) {
      assert.equal(intentForScreen("work", item, press, EMPTY_CONTEXT), null, `${item.kind}/${press.key}`);
    }
    assert.equal(intentForScreen("chat", item, SLOT_KEYS.primary, EMPTY_CONTEXT), null);
  }
  // with the Inbox up, the screen's mapping is the card's own
  assert.deepEqual(intentForScreen("inbox", question, { key: "1" }, EMPTY_CONTEXT), { kind: "select", index: 1 });
  assert.deepEqual(intentForScreen("inbox", go, SLOT_KEYS.primary, EMPTY_CONTEXT), intentForKey(go, SLOT_KEYS.primary, EMPTY_CONTEXT));
  // no card at all maps to nothing, whatever the screen
  assert.equal(intentForScreen("inbox", null, SLOT_KEYS.primary, EMPTY_CONTEXT), null);
  assert.equal(intentForScreen("work", null, SLOT_KEYS.primary, EMPTY_CONTEXT), null);
});

test("a key with alt, ctrl or meta is the browser's shortcut, not a card's judgement", () => {
  const items = [question, go, proposalOverview, shipNewPr, outboundReplies, stuckLimit, stuckBudget, stuckStall, stuckOscillation, stuckHalt, duplicate, requeue, unsupportedShip];
  const modifiers = ["alt", "ctrl", "meta"];
  for (const item of items) {
    for (const [slot, press] of Object.entries(SLOT_KEYS)) {
      for (const mod of modifiers) {
        const held = { ...press, [mod]: true };
        assert.equal(intentForScreen("inbox", item, held, EMPTY_CONTEXT), null, `${item.kind}/${slot}/${mod}`);
        assert.equal(intentForKey(item, held, EMPTY_CONTEXT), null, `${item.kind}/${slot}/${mod}`);
      }
    }
    // Enter, Esc and the question digits are gated the same way
    for (const key of ["Enter", "Escape", "1"]) {
      for (const mod of modifiers) {
        assert.equal(intentForScreen("inbox", item, { key, [mod]: true }, { ...EMPTY_CONTEXT, noteOpen: true, note: "書いた" }), null, `${item.kind}/${key}/${mod}`);
      }
    }
  }
  // the two the finding names: alt+← (back) is not the lane's removal, cmd+→ (forward) is not a GO
  assert.equal(afterConfirm(stuckLimit, { key: "ArrowLeft" }).kind, "stuck_ignore");
  assert.equal(intentForKey(stuckLimit, { key: "ArrowLeft", alt: true }, EMPTY_CONTEXT), null);
  assert.deepEqual(intentForKey(go, { key: "ArrowRight" }, EMPTY_CONTEXT), { kind: "go_go" });
  assert.equal(intentForKey(go, { key: "ArrowRight", meta: true }, EMPTY_CONTEXT), null);
  // Shift is still the card's own spelling (⇧← is the accept), so it must not be gated with the browser keys
  assert.equal(afterConfirm(stuckLimit, { key: "ArrowLeft", shift: true }).kind, "stuck_accept");
});

test("later sends the engine's snooze key, and a card the engine gave no answer for sends none", () => {
  const snooze = requestFor({ kind: "later" }, go);
  assert.deepEqual(snooze, { method: "POST", path: "/api/idd/snooze", body: { key: "go:#142:2026-10-05T11:30:00Z" } });
  // every card the engine answered for can be put off; a card it gave no answer for has no operation to send
  assert.equal(requestFor({ kind: "later" }, unsupportedReview).path, "/api/idd/snooze");
  const unanswered = { ...go };
  delete unanswered.decision;
  assert.equal(requestFor({ kind: "later" }, unanswered), null);
});

test("the revise opens the input first, refuses an empty one, and sends what was written", () => {
  assert.deepEqual(intentForKey(go, { key: "ArrowLeft" }, { ...EMPTY_CONTEXT, noteOpen: false }), { kind: "note_open" });
  assert.equal(requestFor({ kind: "note_open" }, go), null);
  assert.equal(intentForKey(go, { key: "ArrowLeft" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "" }), null);
  const written = { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" };
  assert.deepEqual(intentForKey(go, { key: "Enter" }, written), { kind: "go_revise", instruction: "直す" });
  assert.deepEqual(intentForKey(go, { key: "ArrowLeft" }, written), { kind: "go_revise", instruction: "直す" });
  assert.deepEqual(intentForKey(go, { key: "Escape" }, written), { kind: "note_close" });
});

test("the accept is Shift + left, and only where the engine takes it", () => {
  assert.equal(afterConfirm(stuckLimit, { key: "ArrowLeft" }).kind, "stuck_ignore");
  assert.equal(afterConfirm(stuckLimit, { key: "ArrowLeft", shift: true }).kind, "stuck_accept");
  for (const item of [stuckBudget, stuckStall]) {
    assert.equal(intentForKey(item, { key: "ArrowLeft", shift: true }, EMPTY_CONTEXT), null);
  }
  const accept = cardActions(stuckLimit, EMPTY_CONTEXT).find((s) => s.position === "back").buttons[1];
  assert.equal(accept.key, "⇧←");
});

test("a free answer carries its body as the answer's notes", () => {
  const intent = intentForKey(question, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, note: "  自由な答え  " });
  assert.deepEqual(intent, { kind: "answer", questionId: "q1", selection: { label: "その他" }, notes: "自由な答え" });
  assert.deepEqual(requestFor(intent, question), {
    method: "POST",
    path: "/api/idd/decide",
    body: { action: "answer", payload: { iddId: "#142", batchId: "b1", questionId: "q1", selection: { label: "その他" }, notes: "自由な答え" } },
  });
  assert.equal(requestFor({ kind: "answer", questionId: "q1", selection: { label: "その他" } }, question).body.payload.notes, undefined);
});

test("an oscillation opens its note input first, refuses an empty one, and sends what was written", () => {
  assert.deepEqual(intentForKey(stuckOscillation, { key: "ArrowRight" }, EMPTY_CONTEXT), { kind: "note_open" });
  assert.equal(intentForKey(stuckOscillation, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "" }), null);
  assert.equal(intentForKey(stuckOscillation, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "補足" }).kind, "stuck_continue");
  const primary = cardActions(stuckOscillation, EMPTY_CONTEXT).find((s) => s.position === "primary").buttons[0];
  assert.equal(primary.intent.kind, "note_open");
});

test("an oscillation card offers 計画から考え直す beside its note input when the loop can take it, and no other stop does", () => {
  const backOf = (item) => settledSlot(item, "back").map((i) => i?.kind);
  // accepting and doing it by hand were always on a reversal's card, beside the way back to the plan
  assert.deepEqual(backOf(replanBeside), ["stuck_ignore", "stuck_accept", "stuck_hand_fix", "stuck_replan"]);
  assert.deepEqual(backOf(replanAlone), ["stuck_ignore", "stuck_accept", "stuck_hand_fix"], "no recommendation, the answers it always had");
  // the answers it always had stay: the note input first, an empty note refused
  assert.deepEqual(intentForKey(replanAlone, { key: "ArrowRight" }, EMPTY_CONTEXT), { kind: "note_open" });
  assert.deepEqual(backOf(stuckOscillation), ["stuck_ignore", "stuck_accept", "stuck_hand_fix"], "a stop outside the loop's reach has no way back to the plan");
  for (const item of [stuckBudget, stuckStall, stuckHalt, answered({ ...stuckLimit, handTurn: true })]) {
    assert.ok(!backOf({ ...item, onReplan: replan, recommendation }).includes("stuck_replan"), item.reason);
  }
});

test("the screen draws every stop's own answers, and the way back to the plan only where the engine named it", () => {
  const kindsOf = (item) => ["back", "read", "later", "primary"].flatMap((position) => settledSlot(item, position).map((i) => i?.kind));
  assert.ok(kindsOf(replanBeside).includes("stuck_replan"), "the screen draws the button the engine's answer offers");
  assert.equal(kindsOf(replanAlone).includes("stuck_replan"), false, "no recommendation, no replan button");
  assert.equal(kindsOf(stuckOscillation).includes("stuck_replan"), false, "no replan to take, no replan button");
  for (const item of [stuckBudget, stuckStall, stuckHalt]) {
    const kinds = kindsOf(answered({ ...item, onReplan: replan, recommendation }));
    assert.equal(kinds.includes("stuck_replan"), false, item.reason);
    // no stop is left with its skip alone: each draws what the engine answered for it
    assert.equal(kinds.includes("unsupported_skip"), false, item.reason);
    assert.ok(kinds.length > 1, item.reason);
  }
  // it is pressed, not slipped into: ← is the ignore, → opens the note, and the replan has no key
  assert.deepEqual(afterConfirmScreen(replanBeside, { key: "ArrowLeft" }), { kind: "stuck_ignore" });
  assert.deepEqual(intentForScreen("inbox", replanBeside, { key: "ArrowRight" }, EMPTY_CONTEXT), { kind: "note_open" });
});

test("while focus is in an input, letters and arrows do not move the card", () => {
  const ctx = { ...EMPTY_CONTEXT, focusInInput: true };
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowDown", " ", "1", "a", "Enter"]) {
    assert.equal(intentForKey(question, { key }, ctx), null, key);
  }
});

test("while writing in an open note, the arrows, digits and Shift+← stay in the input and Enter sends", () => {
  const writing = { noteOpen: true, note: "直す", selection: null, focusInInput: true };
  for (const press of [{ key: "ArrowLeft" }, { key: "ArrowRight" }, { key: "ArrowDown" }, { key: "1" }, { key: "ArrowLeft", shift: true }]) {
    assert.equal(intentForKey(go, press, writing), null, `${press.key}/${press.shift ?? false}`);
  }
  assert.deepEqual(intentForKey(go, { key: "Enter" }, writing), { kind: "go_revise", instruction: "直す" });
  assert.deepEqual(intentForKey(go, { key: "Escape" }, writing), { kind: "note_close" });
  // the second ← sends only while focus is on the card
  assert.deepEqual(intentForKey(go, { key: "ArrowLeft" }, { ...writing, focusInInput: false }), { kind: "go_revise", instruction: "直す" });
});

test("a held key sends one decision, not one per repeat", () => {
  for (const item of [question, go, stuckLimit, duplicate, requeue]) {
    assert.equal(intentForKey(item, { key: "ArrowRight", repeat: true }, EMPTY_CONTEXT), null, item.kind);
  }
  assert.equal(intentForKey(go, { key: "Enter", repeat: true }, { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" }), null);
});

test("a GO whose contract cannot be read sends no GO", () => {
  assert.equal(intentForKey(goWithoutContract, { key: "ArrowRight" }, EMPTY_CONTEXT), null);
  assert.equal(intentForKey(goWithoutContract, { key: "ArrowDown" }, EMPTY_CONTEXT).kind, "later");
  assert.equal(intentForKey(goWithoutContract, { key: "ArrowLeft" }, EMPTY_CONTEXT).kind, "note_open");
});

test("a halt card puts 差し戻す and 閉じる on the back slot and やり直す on the primary", () => {
  const slots = cardActions(stuckHalt, EMPTY_CONTEXT);
  const back = slots.find((s) => s.position === "back");
  assert.equal(back.buttons[0].label, "閉じる");
  assert.deepEqual(back.buttons.map((b) => b.intent.kind), ["confirm_open", "note_open"]);
  assert.deepEqual(settledSlot(stuckHalt, "back").map((i) => i.kind), ["stuck_ignore", "note_open"]);
  assert.deepEqual(slots.find((s) => s.position === "primary").buttons[0].intent, { kind: "stuck_resume", note: "" });
  // shift + left reaches 差し戻す, and it opens the note while none is written
  assert.deepEqual(intentForKey(stuckHalt, { key: "ArrowLeft", shift: true }, EMPTY_CONTEXT), { kind: "note_open" });
  // with the note written, 差し戻す sends it on ⇧←; the plain ← stays 閉じる, even after the input was opened
  const written = { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" };
  assert.deepEqual(intentForKey(stuckHalt, { key: "ArrowLeft", shift: true }, written), { kind: "stuck_send_back", instruction: "直す" });
  assert.deepEqual(afterConfirm(stuckHalt, { key: "ArrowLeft" }, written), { kind: "stuck_ignore" });
  assert.deepEqual(afterConfirm(stuckHalt, { key: "ArrowLeft" }), { kind: "stuck_ignore" });
});

test("F-1: once the one-line input is opened, ← still means the button it shows", () => {
  // a question's ← is 前の質問, so it moves between the open questions instead of sending the free answer the note holds
  const qNote = { ...EMPTY_CONTEXT, noteOpen: true, note: "自由な答え" };
  assert.deepEqual(intentForKey(question, { key: "ArrowLeft" }, qNote), { kind: "question_prev" });
  // the stuck cards' ← is lane を外す, not the note's continue/resume
  for (const item of [stuckLimit, stuckStall, stuckOscillation]) {
    const ctx = { ...EMPTY_CONTEXT, noteOpen: true, note: "補足" };
    assert.deepEqual(afterConfirm(item, { key: "ArrowLeft" }, ctx), { kind: "stuck_ignore" }, item.kind);
  }
  // the cards whose ← button is the note's own send still send it
  assert.deepEqual(intentForKey(go, { key: "ArrowLeft" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" }), { kind: "go_revise", instruction: "直す" });
  assert.deepEqual(afterConfirm(proposalOverview, { key: "ArrowLeft" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "今は要らない" }), { kind: "proposal_reject", reason: "今は要らない" });
  assert.deepEqual(intentForKey(stuckHalt, { key: "ArrowLeft", shift: true }, { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" }), { kind: "stuck_send_back", instruction: "直す" });
});

test("7-blind/F-1: 聞く opens a consultation whose Enter and → send no answer", () => {
  // 聞く is its own operation, not the answer input's open: with an option picked or not, its text is not an answer
  const read = cardActions(question, EMPTY_CONTEXT).find((s) => s.position === "read");
  const ask = read.buttons.find((b) => b.label === WORDS.card.back.ask);
  assert.deepEqual(ask.intent, { kind: "ask_open" });
  assert.equal(requestFor({ kind: "ask_open" }, question), null);

  // with 聞く's consultation open, neither the Enter key nor the → button turns what is written into an answer
  const consulting = { ...EMPTY_CONTEXT, noteOpen: true, askOpen: true, note: "この質問の前提を教えて" };
  assert.equal(intentForKey(question, { key: "Enter" }, consulting), null);
  assert.equal(intentForScreen("inbox", question, { key: "Enter" }, consulting), null);
  assert.equal(intentForKey(question, { key: "ArrowRight" }, consulting), null);
  const primary = screenCardActions(question, consulting).find((s) => s.position === "primary");
  assert.equal(primary.buttons[0].intent, null);

  // the answer's own input still sends: the gate is 聞く's input alone
  const answering = { ...EMPTY_CONTEXT, noteOpen: true, askOpen: false, note: "自由な答え" };
  assert.deepEqual(intentForKey(question, { key: "Enter" }, answering), { kind: "answer", questionId: "q1", selection: { label: "その他" }, notes: "自由な答え" });
});

test("8-final/F-1: an IME conversion's Enter is the input's own keypress, not a card's judgement", () => {
  // the Enter that ends a Japanese conversion carries isComposing (and, on older engines, keyCode 229): read as a
  // card's decision it would send the unfinished sentence as the answer / the continue / the revise
  const answering = { ...EMPTY_CONTEXT, noteOpen: true, note: "自由な答え" };
  assert.equal(intentForKey(question, { key: "Enter", isComposing: true }, answering), null);
  assert.equal(intentForScreen("inbox", question, { key: "Enter", isComposing: true }, answering), null);
  assert.equal(intentForKey(go, { key: "Enter", keyCode: 229 }, { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" }), null);
  assert.equal(intentForKey(stuckLimit, { key: "Enter", isComposing: true }, { ...EMPTY_CONTEXT, noteOpen: true, note: "補足" }), null);
  // the gate holds for the input's other keys too: Esc stays in the conversion, and a digit is not a pick
  assert.equal(intentForKey(go, { key: "Escape", isComposing: true }, { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" }), null);
  assert.equal(intentForKey(question, { key: "1", keyCode: 229 }, EMPTY_CONTEXT), null);
  assert.equal(intentForKey(question, { key: "ArrowRight", isComposing: true }, { ...EMPTY_CONTEXT, note: "自由な答え" }), null);
  // a plain Enter still sends, so only the composition itself is gated
  assert.deepEqual(intentForKey(go, { key: "Enter" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "直す" }), { kind: "go_revise", instruction: "直す" });
});

test("a halt with no executor session to send back leaves 差し戻す out", () => {
  assert.deepEqual(settledSlot(stuckHaltNoBack, "back").map((i) => i.kind), ["stuck_ignore"]);
  assert.equal(intentForKey(stuckHaltNoBack, { key: "ArrowLeft", shift: true }, EMPTY_CONTEXT), null);
  const primary = cardActions(stuckHaltNoBack, EMPTY_CONTEXT).find((s) => s.position === "primary");
  assert.deepEqual(primary.buttons[0].intent, { kind: "stuck_resume", note: "" });
});

test("the halt intents become lane_stall_resume and s4_revise", () => {
  assert.deepEqual(requestFor({ kind: "stuck_resume", note: "" }, stuckHalt), { method: "POST", path: "/api/idd/decide", body: { action: "lane_stall_resume", payload: { iddId: "#147", note: "" } } });
  assert.deepEqual(requestFor({ kind: "stuck_send_back", instruction: "直す" }, stuckHalt), { method: "POST", path: "/api/idd/decide", body: { action: "s4_revise", payload: { iddId: "#147", instruction: "直す" } } });
});

test("the first -> on a signing card opens the confirm and sends nothing; Esc closes it", () => {
  for (const item of [shipNewPr, outboundReplies]) {
    const intent = intentForKey(item, { key: "ArrowRight" }, EMPTY_CONTEXT);
    assert.equal(intent.kind, "confirm_open", item.kind);
    assert.equal(typeof intent.confirmKey, "string");
    assert.equal(requestFor(intent, item), null);
    assert.deepEqual(intentForKey(item, { key: "Escape" }, { ...EMPTY_CONTEXT, confirmOpen: true }), { kind: "confirm_close" });
  }
});

test("the second -> on a signing card is the approval that carries the frozen content", () => {
  const shipIntent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  assert.equal(shipIntent.kind, "ship_approve");
  assert.equal(shipIntent.action, "s4_verify_clean");
  assert.equal(typeof shipIntent.payload.iddId, "string");
  const outIntent = intentForKey(outboundReplies, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  assert.equal(outIntent.kind, "outbound_approve");
  assert.equal(outIntent.action, "outbound_approve");
});

test("the submit check, the send-back and the discard are sent without a signature", () => {
  const check = intentForKey(shipNoCheck, { key: "ArrowRight" }, EMPTY_CONTEXT);
  assert.equal(check.kind, "ship_check");
  assert.deepEqual(requestFor(check, shipNoCheck), { method: "POST", path: "/api/idd/decide", body: { action: "s4_prepare", payload: { iddId: "#143", pr: { title: "wip", body: "" } } } });

  // the send-back: <- opens the one line, Enter sends it
  assert.deepEqual(intentForKey(shipNewPr, { key: "ArrowLeft" }, EMPTY_CONTEXT), { kind: "note_open" });
  const written = { ...EMPTY_CONTEXT, noteOpen: true, note: "直して" };
  assert.deepEqual(intentForKey(shipNewPr, { key: "Enter" }, written), { kind: "ship_revise", instruction: "直して" });
  assert.deepEqual(requestFor({ kind: "ship_revise", instruction: "直して" }, shipNewPr), { method: "POST", path: "/api/idd/decide", body: { action: "s4_revise", payload: { iddId: "#142", instruction: "直して" } } });
  assert.equal(intentForKey(shipNewPr, { key: "Enter" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "  " }), null);

  const discard = afterConfirm(outboundReplies, { key: "ArrowLeft" });
  assert.deepEqual(requestFor(discard, outboundReplies), { method: "POST", path: "/api/idd/decide", body: { action: "outbound_discard", payload: { iddId: "#139" } } });
  assert.equal(requestFor({ kind: "later" }, shipNewPr).path, "/api/idd/snooze");
});

test("the submit card offers the engine's sub_todo beside the send-back, and its line is sent as the operation it was opened for", () => {
  const subTodo = shipNewPr.decision.operations.find((o) => o.id === "sub_todo");
  assert.equal(subTodo.action, "s4_sub_todo");
  const back = cardActions(shipNewPr, EMPTY_CONTEXT).find((s) => s.position === "back").buttons;
  assert.deepEqual(back.map((b) => [b.label, b.key]), [[WORDS.card.back.revise, "←"], [WORDS.card.back.subTodo, "⇧←"]]);
  // ⇧← opens the line for it, and a line written there goes to s4_sub_todo, never s4_revise
  assert.deepEqual(intentForKey(shipNewPr, { key: "ArrowLeft", shift: true }, EMPTY_CONTEXT), { kind: "note_open", op: "sub_todo" });
  const writing = { ...EMPTY_CONTEXT, noteOpen: true, noteOp: "sub_todo", note: "別の lane で直す" };
  const sent = intentForKey(shipNewPr, { key: "Enter" }, writing);
  assert.deepEqual(sent, { kind: "operate", op: "sub_todo", text: "別の lane で直す" });
  assert.deepEqual(requestFor(sent, shipNewPr), { method: "POST", path: "/api/idd/decide", body: { action: "s4_sub_todo", payload: { iddId: "#142", instruction: "別の lane で直す" } } });
  assert.equal(intentForKey(shipNewPr, { key: "Enter" }, { ...writing, note: " " }), null, "the instruction is required");
  // ← while the line is open for sub_todo turns it to the send-back instead of sending it there
  assert.deepEqual(intentForKey(shipNewPr, { key: "ArrowLeft" }, writing), { kind: "note_open", op: "revise" });
  assert.equal(notePlaceholder(shipNewPr, "sub_todo"), WORDS.card.note.subTodoPlaceholder);
});

test("the send-back from a submit that still carries an R2 gate is penne's note alone", () => {
  const written = { ...EMPTY_CONTEXT, noteOpen: true, note: "誤検知では" };
  const intent = intentForKey(shipR2Gate, { key: "Enter" }, written);
  assert.deepEqual(intent, { kind: "ship_revise", instruction: "誤検知では" });
});

test("while focus is in another editing field, no key moves the card, even with the one-line input open", () => {
  for (const item of [shipNewPr, outboundReplies]) {
    for (const noteOpen of [false, true]) {
      for (const key of ["Enter", "ArrowLeft", "ArrowRight", "ArrowDown", "Escape", "1"]) {
        const ctx = { ...EMPTY_CONTEXT, noteOpen, note: "書いた", focusInEditor: true };
        assert.equal(intentForKey(item, { key }, ctx), null, `${item.kind}/${key}/${noteOpen}`);
        assert.equal(intentForKey(item, { key, shift: true }, ctx), null, `${item.kind}/${key}/shift/${noteOpen}`);
      }
    }
  }
});

test("focus in the one-line input keeps Enter sending and Esc closing", () => {
  const writing = { ...EMPTY_CONTEXT, noteOpen: true, note: "直して", focusInInput: true };
  assert.deepEqual(intentForKey(shipNewPr, { key: "Enter" }, writing), { kind: "ship_revise", instruction: "直して" });
  assert.deepEqual(intentForKey(shipNewPr, { key: "Escape" }, writing), { kind: "note_close" });
  for (const press of [{ key: "ArrowLeft" }, { key: "ArrowRight" }, { key: "ArrowDown" }]) {
    assert.equal(intentForKey(shipNewPr, press, writing), null, press.key);
  }
});

test("the limit card offers もう 1 巡 / 今のまま受け入れる / 自分で直す, 計画から考え直す only beside the judge's recommendation, and the hand turn offers 直した alone (AC-048)", () => {
  const back = settledSlot(stuckLimit, "back").map((intent) => ({ intent }));
  assert.deepEqual(back.map((b) => b.intent?.kind), ["stuck_ignore", "stuck_accept", "stuck_hand_fix"], "a card the judge did not run for keeps the answers it always had");
  const recommended = answered({ ...stuckLimit, recommendation: { choice: "continue", reasons: [{ kind: "round", ref: "1", text: "巡 1" }] } });
  const five = settledSlot(recommended, "back").map((intent) => ({ intent }));
  assert.deepEqual(five.map((b) => b.intent?.kind), ["stuck_ignore", "stuck_accept", "stuck_hand_fix", "stuck_replan"]);
  assert.deepEqual(cardActions(recommended, EMPTY_CONTEXT).find((s) => s.position === "back").buttons.map((b) => b.label), ["lane を外す", "今のまま受け入れる", "自分で直す", "計画から考え直す"]);
  // the third button's shown key ⇧→ presses that button, not the primary's もう 1 巡
  assert.deepEqual(intentForKey(stuckLimit, { key: "ArrowRight", shift: true }, EMPTY_CONTEXT), { kind: "stuck_hand_fix" });
  assert.equal(intentForKey(stuckLimit, { key: "ArrowRight" }, EMPTY_CONTEXT).kind, "stuck_continue");
  const hand = answered({ ...stuckLimit, handTurn: true });
  const slots = cardActions(hand, EMPTY_CONTEXT);
  assert.deepEqual(slots.find((s) => s.position === "primary").buttons.map((b) => b.intent?.kind), ["stuck_hand_fixed"]);
  assert.deepEqual(settledSlot(hand, "back").map((i) => i?.kind), ["stuck_ignore"]);
});

test("AC-008: the GO press carries every proposed Purpose and the names typed for them", () => {
  assert.deepEqual(intentForKey(goWithPurposes, { key: "ArrowRight" }, EMPTY_CONTEXT), { kind: "go_go", purposes: [{ id: "P-2", statement: "夜でも文字が読める" }, { id: "P-3", statement: "OS の設定に追従する" }] });
  const named = { ...EMPTY_CONTEXT, goNames: { "P-2": "夜の可読性", "P-3": "   " } };
  assert.deepEqual(intentForKey(goWithPurposes, { key: "ArrowRight" }, named), { kind: "go_go", purposes: [{ id: "P-2", statement: "夜でも文字が読める", name: "夜の可読性" }, { id: "P-3", statement: "OS の設定に追従する" }] });
  assert.deepEqual(requestFor({ kind: "go_go", purposes: [{ id: "P-2", statement: "夜でも文字が読める", name: "夜の可読性" }, { id: "P-3", statement: "OS の設定に追従する" }] }, goWithPurposes), {
    method: "POST",
    path: "/api/idd/decide",
    body: { action: "s1_go", payload: { iddId: "#142", purposes: [{ id: "P-2", statement: "夜でも文字が読める", name: "夜の可読性" }, { id: "P-3", statement: "OS の設定に追従する" }] } },
  });
  // a lane with no proposal keeps the payload it always sent
  assert.deepEqual(requestFor({ kind: "go_go" }, go), { method: "POST", path: "/api/idd/decide", body: { action: "s1_go", payload: { iddId: "#142" } } });
});

test("AC-032 / AC-033: a proposal card approves, rejects behind a written reason, and is put off", () => {
  for (const item of [proposalOverview, proposalHarm, proposalSupersede]) {
    // with the approve's confirm open, → is the approve the confirm shows, sent by its id
    assert.deepEqual(afterConfirm(item, { key: "ArrowRight" }), { kind: "operate", op: "approve" }, item.proposalId);
    assert.deepEqual(requestFor({ kind: "operate", op: "approve" }, item), requestFor({ kind: "proposal_approve" }, item), item.proposalId);
    assert.deepEqual(intentForKey(item, { key: "ArrowLeft" }, EMPTY_CONTEXT), { kind: "note_open" }, item.proposalId);
    assert.equal(intentForKey(item, { key: "ArrowLeft" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "  " }), null, item.proposalId);
    const written = { ...EMPTY_CONTEXT, noteOpen: true, note: "今は要らない" };
    assert.deepEqual(afterConfirm(item, { key: "Enter" }, written), { kind: "proposal_reject", reason: "今は要らない" }, item.proposalId);
    assert.deepEqual(afterConfirm(item, { key: "ArrowLeft" }, { ...written, focusInInput: false }), { kind: "proposal_reject", reason: "今は要らない" }, item.proposalId);
    assert.equal(intentForKey(item, { key: "ArrowDown" }, EMPTY_CONTEXT).kind, "later", item.proposalId);
  }
  // while focus is in the input, no key moves the card
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "Enter"]) {
    assert.equal(intentForKey(proposalOverview, { key }, { ...EMPTY_CONTEXT, focusInInput: true }), null, key);
  }
  // whether a press cannot be taken back is the engine's answer on the operation it presses, not a list of intents
  assert.equal(isIrreversible({ kind: "proposal_approve" }, proposalOverview), true);
  assert.equal(isIrreversible({ kind: "proposal_reject", reason: "r" }, proposalOverview), true);
  assert.equal(isIrreversible({ kind: "later" }, proposalOverview), false);
  assert.equal(notePlaceholder(proposalOverview), WORDS.card.note.rejectPlaceholder);
  // a stop whose note the engine records as the answer to the judgement's question names its line the answer
  assert.equal(notePlaceholder({ ...stuckLimit, noteAnswersQuestion: true }), WORDS.card.note.answerPlaceholder);
  assert.equal(notePlaceholder(stuckLimit), WORDS.card.note.placeholder);
});

test("a GO card whose blocker has not landed offers nothing but reading and あとで: no key reaches the GO", () => {
  for (const ctx of [EMPTY_CONTEXT, { ...EMPTY_CONTEXT, noteOpen: true, note: "書いた" }]) {
    const slots = cardActions(goBlocked, ctx);
    const intents = slots.flatMap((s) => s.buttons.map((b) => b.intent?.kind ?? null));
    assert.deepEqual(intents.filter(Boolean).sort(), ["later", "read"]);
    assert.equal(intentForKey(goBlocked, { key: "ArrowRight" }, ctx), null);
    assert.equal(intentForKey(goBlocked, { key: "ArrowLeft" }, ctx), null);
    assert.equal(intentForKey(goBlocked, { key: "ArrowDown" }, ctx).kind, "later");
  }
  assert.equal(intentForKey(goBlocked, { key: "ArrowLeft", shift: true }, EMPTY_CONTEXT), null);
  // the usual GO card still has its GO, and can be stopped from the same card (⇧←, after its confirm)
  assert.equal(intentForKey(go, { key: "ArrowRight" }, EMPTY_CONTEXT).kind, "go_go");
  assert.deepEqual(requestFor(afterConfirm(go, { key: "ArrowLeft", shift: true }), go), { method: "POST", path: "/api/idd/decide", body: { action: "ignore", payload: { iddId: go.iddId } } });
});

test("AC-032: the proposal's two answers become the decide API's calls", () => {
  assert.deepEqual(requestFor({ kind: "proposal_approve" }, proposalOverview), {
    method: "POST", path: "/api/idd/decide",
    body: { action: "proposal_approve", payload: { repo: proposalOverview.repo, proposal: proposalOverview.proposalId } },
  });
  assert.deepEqual(requestFor({ kind: "proposal_reject", reason: "今は要らない" }, proposalHarm), {
    method: "POST", path: "/api/idd/decide",
    body: { action: "proposal_reject", payload: { repo: proposalHarm.repo, proposal: proposalHarm.proposalId, reason: "今は要らない" } },
  });
});

const goReason = answered({ ...go, planReview: { ...go.planReview, needsReason: true } });
const primaryOf = (item, ctx) => cardActions(item, ctx).find((s) => s.position === "primary").buttons[0];
const pressed = (item, key, ctx) => intentForKey(item, { key }, ctx);
const lineOpen = (reason, rest = {}) => ({ ...EMPTY_CONTEXT, reasonOpen: true, reason, ...rest });
const POST = (payload) => ({ method: "POST", path: "/api/idd/decide", body: { action: "s1_go", payload: { iddId: "#142", ...payload } } });

test("a GO that needs a reason opens its line on the first → and sends nothing while the line is empty", () => {
  assert.deepEqual(pressed(goReason, "ArrowRight", EMPTY_CONTEXT), { kind: "reason_open" });
  for (const kind of ["reason_open", "reason_close"]) assert.equal(requestFor({ kind }, goReason), null);
  for (const empty of ["", "   "]) {
    for (const key of ["ArrowRight", "Enter"]) assert.equal(pressed(goReason, key, lineOpen(empty)), null);
    assert.equal(primaryOf(goReason, lineOpen(empty)).intent, null);
  }
  assert.deepEqual(pressed(goReason, "Escape", lineOpen("")), { kind: "reason_close" });
});

test("a GO that needs a reason sends the reason it was given, and only then", () => {
  const written = lineOpen(" 残りの must は別 lane の話 ");
  const sent = { kind: "go_go", reason: "残りの must は別 lane の話" };
  for (const key of ["ArrowRight", "Enter"]) assert.deepEqual(pressed(goReason, key, written), sent);
  assert.deepEqual(primaryOf(goReason, written).intent, sent);
  assert.deepEqual(requestFor(sent, goReason), POST({ reason: "残りの must は別 lane の話" }));
  // the revise's line is still the ←'s own: it never carries the reason
  assert.deepEqual(pressed(goReason, "ArrowLeft", written), { kind: "note_open" });
});

test("while focus is in the reason line, Enter sends the reason written there and every arrow stays in the input", () => {
  const typing = (reason, rest = {}) => lineOpen(reason, { focusInInput: true, ...rest });
  const sent = { kind: "go_go", reason: "残りの must は別 lane の話" };
  assert.deepEqual(pressed(goReason, "Enter", typing(" 残りの must は別 lane の話 ")), sent);
  // the same intent as the primary button shows
  assert.deepEqual(primaryOf(goReason, typing(" 残りの must は別 lane の話 ")).intent, sent);
  for (const empty of ["", "   "]) assert.equal(pressed(goReason, "Enter", typing(empty)), null);
  // → (shifted or not) and the other arrows are the input's cursor, so a reason can still be corrected
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown"]) {
    assert.equal(pressed(goReason, key, typing("書いた")), null);
    assert.equal(intentForKey(goReason, { key, shift: true }, typing("書いた")), null);
  }
  // an IME conversion's Enter decides nothing
  assert.equal(intentForKey(goReason, { key: "Enter", isComposing: true }, typing("書いた")), null);
  // a GO that needs no reason has no reason line, so Enter and → in an input send nothing
  assert.equal(pressed(go, "ArrowRight", typing("書いた")), null);
  assert.equal(pressed(go, "Enter", typing("書いた")), null);
});

test("a read that adds a Purpose changes the card and its answer together: the press confirms only what the answer names", () => {
  const proposals = [{ id: "P-1", statement: "s", origin: "o" }];
  const withProposal = answered({ ...goReason, purposeProposals: proposals });
  const written = "書いた理由";
  // the GO confirms exactly the Purposes the engine's answer on the card names (DEC-112-1): a read that adds one changes
  // the card and its answer together, so the press never confirms a Purpose the card did not name
  for (const ctx of [lineOpen(written, { focusInInput: true }), lineOpen(written)]) {
    assert.deepEqual(intentForKey(withProposal, { key: "Enter" }, ctx), { kind: "go_go", purposes: [{ id: "P-1", statement: "s" }], reason: written });
  }
  assert.deepEqual(intentForScreen("inbox", withProposal, { key: "Escape" }, lineOpen(written)), { kind: "reason_close" });
  // an intent built from an earlier card names a Purpose the answer now on the card does not: the request drops it
  const stale = { kind: "go_go", reason: written, purposes: [{ id: "P-1", statement: "s" }, { id: "P-9", statement: "もう無い案" }] };
  assert.deepEqual(requestFor(stale, withProposal).body.payload.purposes, [{ id: "P-1", statement: "s" }]);
  assert.equal("purposes" in requestFor(stale, goReason).body.payload, false, "a card whose answer names none confirms none");
  // the same item before the read added the Purpose still sends
  for (const ctx of [lineOpen(written, { focusInInput: true }), lineOpen(written)]) {
    assert.deepEqual(intentForScreen("inbox", goReason, { key: "Enter" }, ctx), { kind: "go_go", reason: written });
  }
});

test("a GO that needs no reason keeps one → and a payload with no reason, whatever was written", () => {
  const unneeded = answered({ ...go, planReview: { ...go.planReview, needsReason: false } });
  for (const [item, ctx] of [[go, EMPTY_CONTEXT], [go, lineOpen("書いた")], [unneeded, EMPTY_CONTEXT]]) {
    assert.deepEqual(pressed(item, "ArrowRight", ctx), { kind: "go_go" });
  }
  assert.equal(pressed(go, "Escape", lineOpen("書いた")), null);
  assert.deepEqual(requestFor({ kind: "go_go" }, unneeded), POST({}));
});

test("with one of the GO's two lines open, Enter has one place to go", () => {
  // both open at once is a state the model never reaches (it closes the other line): here the revise's line wins, which is why
  const both = lineOpen("別 lane の話", { note: "直して", noteOpen: true });
  assert.equal(pressed(goReason, "Enter", both)?.kind, "go_revise");
  assert.deepEqual(pressed(goReason, "Enter", { ...both, noteOpen: false }), { kind: "go_go", reason: "別 lane の話" });
  assert.equal(pressed(goReason, "Enter", { ...both, reasonOpen: false })?.kind, "go_revise");
});

test("F-8: duplicate merge, requeue ignore and outbound discard are sent only through the confirm of the operation the engine says cannot be taken back", () => {
  const cases = [
    [duplicate, "duplicate_merge", "merge"],
    [requeue, "requeue_ignore", "ignore"],
    [outboundReplies, "outbound_discard", "discard"],
  ];
  for (const [item, kind, id] of cases) {
    const press = { key: "ArrowLeft" };
    const opened = intentForKey(item, press, EMPTY_CONTEXT);
    assert.equal(opened.kind, "confirm_open", kind);
    assert.equal(requestFor(opened, item), null, `${kind}: opening the confirm sends nothing`);
    assert.ok(opened.confirmKey.startsWith(`op:${id}:`), "the key is the engine's key of the operation");
    assert.equal(intentForKey(item, press, { ...EMPTY_CONTEXT, confirm: opened.confirmKey }).kind, kind);
    // a confirm opened over another answer is not this one: the press opens its own confirm again and sends nothing
    assert.equal(intentForKey(item, press, { ...EMPTY_CONTEXT, confirm: `${opened.confirmKey}x` }).kind, "confirm_open", kind);
    // the button carries the same gate as the key
    assert.equal(cardActions(item, EMPTY_CONTEXT).flatMap((s) => s.buttons).find((b) => b.key === "←").intent.kind, "confirm_open", kind);
  }
});

test("F-8: while an operation's confirm is open, → sends that operation and the card's own approval stays unconfirmed", () => {
  const opened = intentForKey(duplicate, { key: "ArrowLeft" }, EMPTY_CONTEXT);
  // → is anyway on this card, which the engine does not call irreversible; with the merge's confirm open it must not send that
  assert.deepEqual(intentForKey(duplicate, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirm: opened.confirmKey, confirmOpen: true }), { kind: "operate", op: "merge" });
  // an outbound card with the discard's confirm open is not in the approval's signing stage: → sends the discard, it does not sign
  const discard = intentForKey(outboundReplies, { key: "ArrowLeft" }, EMPTY_CONTEXT);
  assert.deepEqual(intentForKey(outboundReplies, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirm: discard.confirmKey, confirmOpen: true }), { kind: "operate", op: "discard" });
});

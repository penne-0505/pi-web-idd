/**
 * The stopped review card lists every finding the judgement accepted, and the refs a press sends to the fix are looked up in
 * the engine's declaration before the press: the screen holds no rule of what the fix takes (C-272-1, C-272-3). The card is
 * answered by the engine's own function, so the declaration the screen reads is the one the engine builds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { answered, h, load, NOOP, readInbox, render, ui } from "./helpers.mjs";
import { shipNewPr, stuckLimit } from "./fixtures/items.mjs";

const { inboxVals } = await load("./src/inbox/viewmodel.ts");
const { applyDrafts, emptyDrafts, setStuckPick, stuckPicksOf } = await load("./src/inbox/drafts.ts");
const { cardActions, intentForKey, operationConfirmKey } = await load("./src/inbox/keymap.ts");
const { requestFor } = await load("./src/inbox/requests.ts");
const { correctionsFor, sentRefs, stuckFindingsOf } = await load("./src/inbox/stuck-findings.ts");
const cards = await load("./src/components/inbox/InboxCards.tsx");

const NOW = Date.parse("2026-10-05T12:00:00Z");
/** a finding as the engine declares it: the handling it stands at, and which of the three the fix then takes */
const declared = (n, severity, action, extra = {}) => ({
  ref: `1-blind/F-${n}`, severity, claim: `ZZZ_${n}`, path: `${n}.ts`, action, inFix: action === "fix", ...extra,
  handlings: ["fix", "followup", "skip"].map((a) => ({
    action: a, severity: a !== "fix" && severity === "must" ? "should" : severity, inFix: a === "fix" && severity !== "nit", current: a === action,
  })),
});
/** a must the judgement wants fixed, a should it left for later, and a must a person already lowered and put off */
const ACCEPTED = [declared(1, "must", "fix"), declared(2, "should", "followup"), declared(3, "should", "followup", { judgedSeverity: "must" })];
const stuck = (over = {}) => answered({ ...stuckLimit, iddId: "#905", accepted: ACCEPTED, ...over });
const picksState = (item, picks) => Object.entries(picks).reduce((d, [ref, action]) => setStuckPick(d, item.iddId, ref, action), emptyDrafts());
const front = async (item, picks = {}) => inboxVals(ui({ drafts: picksState(item, picks) }), await readInbox([item], {}, NOW), NOOP);
const buttons = (item, picks, note = "") => cardActions(item, { noteOpen: false, note, selection: null, focusInInput: false, focusInEditor: false, confirmOpen: false, picks: stuckPicksOf(picksState(item, picks), item.iddId) }).flatMap((s) => s.buttons);
const continueIntent = (item, picks, note) => buttons(item, picks, note).find((b) => b.intent?.kind === "stuck_continue").intent;

test("AC-001: the card lists every accepted finding with its weight and handling, and the judged weight beside a lowered one", async () => {
  const vm = await front(stuck());
  const rows = vm.card.findings;
  assert.equal(rows.map((f) => `${f.claim} ${f.judged ?? "-"} ${f.severity} ${f.fixes}`).join(", "), "ZZZ_1 - must true, ZZZ_2 - should false, ZZZ_3 must should false");
  // any of them may be given another handling; the one it stands at is selected, and a must is put off by being lowered
  assert.equal(rows[1].options.map((o) => `${o.action}${o.selected ? "*" : ""}${o.goes ? "+" : ""}`).join(" "), "fix+ followup* skip");
  assert.equal(rows[0].options.map((o) => o.label).join(" / "), "この変更で直す / 後に回す（should） / 見送る（should）");
  const html = render(h(cards.StuckCard, { card: vm.card, on: NOOP }));
  assert.match(html, /ZZZ_2/);
  assert.match(html, /must → should/);
});

test("AC-003: the refs listed before the press are the refs the press sends, both read from the engine's declaration", async () => {
  const item = stuck();
  assert.equal((await front(item)).card.sends.refs.join(" "), "1-blind/F-1", "as the judgement left it");
  // pick F-2 to fix now and put the must F-1 off
  const picks = { "1-blind/F-2": "fix", "1-blind/F-1": "followup" };
  assert.equal((await front(item, picks)).card.sends.refs.join(" "), "1-blind/F-2");
  const body = requestFor(continueIntent(item, picks, "今は F-2 だけ"), item).body.payload;
  // the sent corrections name the finding put off with the note as the reason, and the one fixed now
  assert.equal(body.corrections.map((c) => `${c.ref} ${c.severity} ${c.action} ${c.reason}`).join(", "), "1-blind/F-1 should followup 今は F-2 だけ, 1-blind/F-2 should fix ");
  assert.equal(sentRefs(stuckFindingsOf(item), picks).join(" "), "1-blind/F-2");
  assert.equal(body.note, "今は F-2 だけ");
});

test("a continue that sends no fix says so, from the engine's count until penne picks and then from her picks, never with a note", async () => {
  const sendsOf = async (item, picks = {}, note = "") => (inboxVals(ui({ drafts: picksState(item, picks), note }), await readInbox([item], {}, NOW), NOOP)).card.sends;
  // as the record stands the engine counts what a continue sends
  assert.match((await sendsOf(stuck({ continueFixes: 0, accepted: [declared(2, "should", "followup")] }))).empty, /続けても手直しは送りません/);
  assert.doesNotMatch((await sendsOf(stuck({ continueFixes: 1 }))).empty, /手直しは送りません/);
  // a pick that leaves nothing for the fix
  const none = { "1-blind/F-1": "skip" };
  const picked = await sendsOf(stuck({ continueFixes: 1 }), none);
  assert.deepEqual(picked.refs, []);
  assert.match(picked.empty, /続けても手直しは送りません/);
  // a note may answer the judgement's question and go as the fix
  assert.doesNotMatch((await sendsOf(stuck({ continueFixes: 1 }), none, "A 案で直す")).empty, /手直しは送りません/);
  // a reversal still goes with its boundary, and a continue that retries a stage has no count
  const reversal = stuck({ continueFixes: 1, oscillations: [{ ref: "1-blind/F-9", claim: "c", priorRef: "0-blind/F-1", prior: "a", current: "b" }] });
  assert.doesNotMatch((await sendsOf(reversal, none)).empty, /手直しは送りません/);
  assert.doesNotMatch((await sendsOf(stuck(), none)).empty, /手直しは送りません/);
});

test("AC-005: a press with no pick sends no corrections, and a card that declares none sends none", async () => {
  const item = stuck();
  assert.equal("corrections" in requestFor(continueIntent(item, {}), item).body.payload, false);
  // picking the handling a finding already stands at is no correction
  assert.deepEqual(correctionsFor(stuckFindingsOf(item), { "1-blind/F-2": "followup" }, ""), []);
  const old = stuck({ accepted: undefined });
  assert.equal(old.decision.operations.find((o) => o.id === "continue").input.corrections, undefined);
  const stray = { kind: "stuck_continue", note: "n", corrections: [{ ref: "x", severity: "should", action: "skip", reason: "" }] };
  assert.equal("corrections" in requestFor(stray, old).body.payload, false, "an operation that declares no corrections sends none");
  const view = await front(old);
  // the narrower `open` is the old screen's list: it never stands in for the accepted findings the engine did not declare
  assert.ok(old.open.length > 0);
  assert.deepEqual(view.card.findings, []);
  assert.equal(view.card.sends, undefined);
});

const ctxOf = (item, picks, note, noteOpen = true, confirm = null) => ({ noteOpen, note, confirm, selection: null, focusInInput: false, focusInEditor: false, confirmOpen: false, picks: stuckPicksOf(picksState(item, picks), item.iddId) });
const intentOf = (item, picks, note, noteOpen, label) => cardActions(item, ctxOf(item, picks, note, noteOpen)).flatMap((s) => s.buttons).find((b) => b.label.includes(label))?.intent;

test("F-4: a must lowered to be put off needs its reason, and the reason is the one sent", () => {
  const item = stuck();
  const putOff = { "1-blind/F-1": "followup" };
  for (const label of ["もう 1 巡", "受け入れる"]) {
    // no line written: the line opens (or, when open, nothing is sent); no correction leaves without the ground
    assert.equal(intentOf(item, putOff, "", false, label)?.kind, "note_open", label);
    assert.equal(intentOf(item, putOff, "  ", true, label) ?? null, null, label);
  }
  const sent = intentOf(item, putOff, "今回の範囲外", true, "もう 1 巡");
  assert.equal(sent.kind, "stuck_continue");
  assert.equal(requestFor(sent, item).body.payload.corrections[0].reason, "今回の範囲外");
  // a should put off, or a must kept as a fix, needs no line
  assert.equal(intentOf(item, { "1-blind/F-2": "skip" }, "", false, "もう 1 巡").kind, "stuck_continue");
  assert.equal(intentOf(item, { "1-blind/F-1": "fix" }, "", false, "もう 1 巡").kind, "stuck_continue");
});

test("F-1: the confirmed accept sends the corrections the confirm showed, not a bare operate", async () => {
  const item = stuck();
  const picks = { "1-blind/F-2": "skip", "1-blind/F-1": "followup" };
  const note = "F-1 は今回の範囲外";
  const opened = intentOf(item, picks, note, true, "受け入れる");
  assert.equal(opened.kind, "confirm_open");
  const seen = [];
  const vm = inboxVals(ui({ drafts: picksState(item, picks), note, noteOpen: true, confirm: opened.confirmKey }), await readInbox([item], {}, NOW), { ...NOOP, dispatch: (i) => seen.push(i) });
  assert.ok(vm.confirming, "the confirm is open");
  vm.confirming.approve.go();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "stuck_accept");
  const payload = requestFor(seen[0], item).body.payload;
  assert.equal(payload.corrections.map((c) => `${c.ref} ${c.severity} ${c.action}`).join(", "), "1-blind/F-1 should followup, 1-blind/F-2 should skip");
  assert.equal(payload.corrections[0].reason, note);
  assert.equal(payload.note, note);
});

test("F-5: the findings scroll inside their own box and the sends stay outside it", async () => {
  const many = Array.from({ length: 40 }, (_, i) => declared(i + 10, "should", "followup"));
  const html = render(h(cards.StuckCard, { card: (await front(stuck({ accepted: many }))).card, on: NOOP }));
  const list = html.match(/<div data-finding-list[^>]*style="([^"]*)"/);
  assert.ok(list, "the list has its own box");
  assert.match(list[1], /overflow-y:auto/);
  assert.match(list[1], /max-height:\d+vh/);
  assert.ok(html.indexOf("data-finding-sends") > html.lastIndexOf("ZZZ_49"), "the sends follow the whole list, outside the scrolling box");
});

test("a pick is let go when its finding is no longer on the card, and a second pick of the same takes it off", () => {
  const item = stuck();
  const kept = applyDrafts(picksState(item, { "1-blind/F-2": "fix", "1-blind/F-9": "skip" }), [item]);
  assert.deepEqual(stuckPicksOf(kept, "#905"), { "1-blind/F-2": "fix" });
  assert.deepEqual(stuckPicksOf(applyDrafts(kept, []), "#905"), {}, "the card is gone");
  assert.deepEqual(stuckPicksOf(setStuckPick(kept, "#905", "1-blind/F-2", "fix"), "#905"), {});
});

test("a change of the picks opens a new confirm of the accept, so the confirm shows what is sent", () => {
  const item = stuck();
  const accept = (picks) => buttons(item, picks).find((b) => b.label.includes("受け入れる")).intent;
  const [a, b] = [accept({}), accept({ "1-blind/F-2": "skip" })];
  assert.equal(`${a.kind} ${b.kind}`, "confirm_open confirm_open");
  assert.notEqual(a.confirmKey, b.confirmKey);
});

test("AC-002: the submit card's leftovers and follow-ups show the weight the judgement gave beside the one a person set", async () => {
  const mark = (severity, claim, extra = {}) => ({ severity, claim, path: `${claim}.ts`, ...extra });
  const review = {
    fixRounds: 2, closedBy: "penne", rejected: [],
    leftovers: [mark("nit", "ZZZ_ASIDE", { judgedSeverity: "must", action: "skip" }), mark("should", "ZZZ_PLAIN")],
    followups: [mark("should", "ZZZ_PUT_OFF", { judgedSeverity: "must" })],
  };
  const vm = inboxVals(ui(), await readInbox([answered({ ...shipNewPr, review })], {}, NOW), NOOP);
  const rows = vm.panel.sections.flatMap((s) => s.rows ?? []).filter((r) => /ZZZ_/.test(r.value));
  assert.equal(rows.map((r) => r.label).join(" | "), "判定 must → nit ZZZ_ASIDE.ts | should ZZZ_PLAIN.ts | 判定 must → should ZZZ_PUT_OFF.ts");
});

/** a must whose declaration offers the fix at the lowered weight (what an older screen may send), beside putting it off */
const loweredFix = () => ({
  ...declared(1, "must", "fix"),
  handlings: [
    { action: "fix", severity: "should", inFix: true, current: false },
    { action: "followup", severity: "should", inFix: false, current: false },
  ],
});

test("F-1: a must lowered but still fixed is sent without a reason, and a must put off still needs one", () => {
  const item = stuck({ accepted: [loweredFix()] });
  const lowered = intentOf(item, { "1-blind/F-1": "fix" }, "", false, "もう 1 巡");
  assert.equal(lowered.kind, "stuck_continue");
  assert.equal(requestFor(lowered, item).body.payload.corrections.map((c) => `${c.severity} ${c.action} [${c.reason}]`).join(), "should fix []");
  assert.equal(intentOf(item, { "1-blind/F-1": "followup" }, "", false, "もう 1 巡")?.kind, "note_open");
});

const ENTER = { key: "Enter" };
const pressEnter = (item, picks, note, noteOp, confirm = null) => intentForKey(item, ENTER, { ...ctxOf(item, picks, note, true, confirm), noteOp });

test("F-2: Enter in the line the accept opened sends the accept with its corrections, never the continue", () => {
  const item = stuck();
  const picks = { "1-blind/F-1": "followup" };
  const note = "F-1 は今回の範囲外";
  // with no line the accept opens the line for itself
  const opener = buttons(item, picks).find((b) => b.label.includes("受け入れる")).intent;
  assert.deepEqual({ kind: opener.kind, op: opener.op }, { kind: "note_open", op: "accept" });
  // Enter there goes through the accept's confirm, and the confirmed Enter sends the accept with the corrections
  const first = pressEnter(item, picks, note, "accept");
  assert.equal(first.kind, "confirm_open");
  const sent = pressEnter(item, picks, note, "accept", first.confirmKey);
  assert.equal(sent.kind, "stuck_accept");
  assert.equal(requestFor(sent, item).body.payload.corrections[0].reason, note);
  // an empty line sends nothing for the accept either
  assert.equal(pressEnter(item, picks, "", "accept") ?? null, null);
  // the continue's own line stays the continue's
  const cont = pressEnter(item, picks, note, "continue", null);
  assert.notEqual(cont?.kind, "stuck_accept");
  assert.match(String(cont?.kind), /stuck_continue|confirm_open/);
});

test("F-3: a row's state follows the handling picked, and the current one when none is picked", async () => {
  const item = stuck();
  const states = async (picks) => (await front(item, picks)).card.findings.map((f) => f.state).join(" | ");
  const before = await states({});
  const after = await states({ "1-blind/F-2": "fix", "1-blind/F-1": "skip" });
  const [b1, b2] = before.split(" | ");
  const [a1, a2] = after.split(" | ");
  assert.notEqual(a1, b1, "F-1 put off no longer reads as fixed");
  assert.notEqual(a2, b2, "F-2 picked to fix no longer reads as left for later");
  assert.equal(a2, b1, "F-2 picked fix reads as F-1 did when it was fixed");
});

test("3-blind/F-1: no accept is offered or sent beside a finding picked to fix, and it returns when the pick is taken off", () => {
  const item = stuck();
  const has = (picks, label) => buttons(item, picks).some((b) => b.label.includes(label));
  assert.ok(has({}, "受け入れる"));
  assert.ok(has({ "1-blind/F-2": "skip" }, "受け入れる"), "a pick that is not a fix keeps the accept");
  assert.ok(has({ "1-blind/F-2": "followup" }, "受け入れる"));
  // F-1 already stands at fix: picking it still counts, so the accept does not slip through with no correction
  for (const picks of [{ "1-blind/F-2": "fix" }, { "1-blind/F-1": "fix" }]) {
    assert.ok(!has(picks, "受け入れる"));
    assert.ok(has(picks, "もう 1 巡"), "the continue is the one that goes to the fix");
    assert.equal(intentForKey(item, { key: "ArrowLeft", shift: true }, ctxOf(item, picks, "", false)) ?? null, null);
    // the accept's line and its confirm send nothing either, and never fall to the continue
    assert.equal(pressEnter(item, picks, "理由", "accept") ?? null, null);
    const accept = item.decision.operations.find((op) => op.id === "accept");
    const corrections = correctionsFor(stuckFindingsOf(item), picks, "理由");
    const confirm = operationConfirmKey(accept, corrections.length ? `理由\n${JSON.stringify(corrections)}` : "理由");
    assert.equal(intentForKey(item, { key: "ArrowRight" }, { ...ctxOf(item, picks, "理由", true, confirm), confirmOpen: true }) ?? null, null);
  }
});

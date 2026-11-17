/**
 * The Inbox's own wiring: the card, the right panel, the sidebar and the operation row are filled from the
 * engine's `/api/idd/state` answer alone. The tests drive the same store the screen drives (`InboxStore` with a
 * fetch stand-in), build the view model the components read, and render the components to static markup so the
 * printed words can be checked: a value the engine did not return must not appear, and the prototype's sample
 * words must not either.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch, settle, snapshot } from "./fake.mjs";
import { shipNewPr, shipLand, shipNoCheck } from "./fixtures/items.mjs";
import { answered, h, load, NOOP, readInbox, render, ui } from "./helpers.mjs";

const { inboxVals, cardKindOf, recommendedSelection, sendsConsultation } = await load("./src/inbox/viewmodel.ts");
const { InboxStore } = await load("./src/inbox/useDecide.ts");
const { emptyDrafts, applyDrafts, setShipField, setOutboundField, setOutboundReply, setGoReason } = await load("./src/inbox/drafts.ts");
const { cardActions, intentForKey, intentForScreen, screenCardActions, EMPTY_CONTEXT } = await load("./src/inbox/keymap.ts");
const { requestFor } = await load("./src/inbox/requests.ts");
const { operationsOf } = await load("./src/inbox/operations.ts");
const { deck } = await load("./src/inbox/deck.ts");
const cards = await load("./src/components/inbox/InboxCards.tsx");
const { CardActions } = await load("./src/components/inbox/CardActions.tsx");
const { InboxPanel } = await load("./src/components/panels/InboxPanel.tsx");
const { InboxSidebar } = await load("./src/components/shell/InboxSidebar.tsx");
const { Rail } = await load("./src/components/shell/Rail.tsx");
const { WORDS } = await load("./src/strings.ts");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const APPEARED = "2026-10-05T11:30:00Z";

const noop = () => {};

const readState = (items, extra = {}) => readInbox(items, extra, NOW);

/** run the store against one state answer and hand back the store with the engine it asked */
async function readStore(items, extra = {}) {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const read = store.read();
  engine.calls[0].respond(200, snapshot(items, extra));
  await read;
  return { store, engine };
}

/** ask the view model for the front card, with a dispatch spy */
async function frontModel(items, over = {}, extra = {}) {
  const state = await readState(items, extra);
  const seen = [];
  const vm = inboxVals(ui(over), state, { ...NOOP, dispatch: (intent) => seen.push(intent) });
  return { vm, seen, state };
}

/* ---- the engine's own items, with words the prototype never used ---- */

const qItem = answered({
  kind: "question",
  iddId: "#901",
  laneTitle: "ZZZ_LANE",
  batchId: "b1",
  askedTotal: 3,
  answeredCount: 1,
  source: { kind: "github", label: "ZZZ_REF", url: "https://example.test/901" },
  appearedAt: APPEARED,
  open: [
    {
      questionId: "q1",
      question: "ZZZ_QUESTION",
      facts: [{ label: "ZZZ_FACT_LABEL", value: "ZZZ_FACT_VALUE" }],
      options: [
        { index: 1, label: "ZZZ_OPTION_ONE", description: "ZZZ_OPTION_ONE_DESC", recommendation: "recommended", rationale: "ZZZ_OPTION_ONE_WHY" },
        { index: 2, label: "ZZZ_OPTION_TWO", recommendation: "acceptable" },
      ],
    },
  ],
});

const goItem = answered({
  kind: "go",
  iddId: "#902",
  title: "ZZZ_GO_LANE",
  source: { kind: "github", label: "ZZZ_GO_REF" },
  appearedAt: APPEARED,
  summary: { situation: "ZZZ_SITUATION", action: "ZZZ_ACTION", outcome: "ZZZ_OUTCOME" },
  decisions: [{ id: "01", text: "ZZZ_DECISION", why: "ZZZ_DECISION_WHY", source: "ZZZ_SOURCE" }],
  criteria: [{ id: "AC-01", text: "ZZZ_CRITERION" }],
});

const shipItem = answered({
  kind: "ship",
  iddId: "#903",
  laneTitle: "ZZZ_SHIP_LANE",
  title: "ZZZ_SHIP_LANE",
  appearedAt: APPEARED,
  head: "abc1234",
  branch: { from: "ZZZ_BRANCH_FROM", to: "ZZZ_BRANCH_TO", repo: "ZZZ_REPO" },
  pr: { title: "ZZZ_PR_TITLE", body: [{ text: "ZZZ_PR_BODY" }], commits: [], vocabAllow: [] },
  checks: [
    { label: "ZZZ_CHECK_OK", ok: true },
    { label: "ZZZ_CHECK_FAIL", ok: false },
  ],
  proposal: {
    mode: "publish",
    blocking: 0,
    pr: { title: "ZZZ_PR_TITLE", body: "ZZZ_PR_BODY" },
    token: "ZZZ_TOKEN",
    head: "abc1234",
    expiresAt: "2035-01-01T00:00:00Z",
    commitMessage: "ZZZ_COMMIT",
    checks: [{ name: "ZZZ_CHECK_OK", status: "pass", severity: "blocking" }],
    publish: [],
    held: [],
    destination: { fingerprint: "fp", label: "ZZZ_REPO" },
    branch: "ZZZ_BRANCH_FROM",
  },
  commit: { draft: "ZZZ_COMMIT" },
});

const outboundItem = answered({
  kind: "outbound",
  iddId: "#904",
  appearedAt: APPEARED,
  outKind: "gh-issue",
  targetLabel: "ZZZ_TARGET",
  title: "ZZZ_POST_TITLE",
  draft: "d",
  proposed: "ZZZ_POST_BODY",
  createdAt: APPEARED,
});

const reviewItem = answered({ ...outboundItem, outKind: "gh-pr-review", targetLabel: "ZZZ_PR", title: "", proposed: "ZZZ_REVIEW_BODY", event: "comment", labelRules: {} });

const stuckItem = answered({
  kind: "stuck",
  iddId: "#905",
  laneTitle: "ZZZ_STUCK_LANE",
  title: "ZZZ_STUCK_LANE",
  reason: "ZZZ_STUCK_REASON",
  source: { kind: "github", label: "ZZZ_STUCK_REF" },
  appearedAt: APPEARED,
  open: [{ severity: "must", claim: "ZZZ_FINDING", path: "ZZZ_PATH:1" }],
  escalated: [],
  oscillations: [],
  rejected: [{ claim: "ZZZ_REJECTED", reason: "ZZZ_REJECT_WHY" }],
  fixRounds: 4,
});

const duplicateItem = answered({
  kind: "duplicate",
  iddId: "#906",
  reviewId: "RV-1",
  source: { kind: "github", label: "ZZZ_DUP_REF" },
  appearedAt: APPEARED,
  incoming: { title: "ZZZ_INCOMING", ref: { kind: "github", label: "#906" } },
  existing: { title: "ZZZ_EXISTING", ref: { kind: "github", label: "#142" } },
  similarity: 0.5,
  reason: "ZZZ_DUP_REASON",
  shared: ["ZZZ_SHARED"],
});

const requeueItem = answered({
  kind: "requeue",
  iddId: "#907",
  laneTitle: "ZZZ_REQUEUE_LANE",
  title: "ZZZ_REQUEUE_LANE",
  from: "#907",
  source: { kind: "github", label: "ZZZ_REQUEUE_REF" },
  appearedAt: APPEARED,
  closed: { outcome: "ZZZ_CLOSED_OUTCOME", reason: "ZZZ_CLOSED_WHY", at: APPEARED },
  context: "ZZZ_REQUEUE_REASON",
});

const storageItem = answered({ kind: "storage", cleanup: false, minFreeGb: 10, freeBytes: 1, totalBytes: 2, topPlaces: [], candidateCount: 0, candidateBytes: 0, heldLanes: [] });
const proposalPlain = { kind: "proposal", proposalId: "P", proposalKind: "overview", repo: "r", before: [], after: [], reason: "w", from: {}, effect: "now", appearedAt: APPEARED };
const unknownItem = answered({ kind: "cosmic", iddId: "#999", appearedAt: APPEARED });

/* ---- AC-001: Inbox values come only from the engine's response ---- */

test("AC-001: the card's words are the engine's, and the prototype's samples never appear", async () => {
  const { vm } = await frontModel([qItem], {}, { answered: [{ kind: "question", iddId: "#901", title: "ZZZ_ANSWERED", at: APPEARED }], progress: { done: 2, open: 1 }, holds: [{ ref: "ZZZ_HOLD", title: "ZZZ_HOLD_TITLE", source: "github", at: APPEARED }], ignores: [{ ref: "ZZZ_IGNORE", title: "ZZZ_IGNORE_TITLE", source: "github", at: APPEARED, by: "user" }], lanes: [{ iddId: "ZZZ_LANE_ROW", title: "ZZZ_RUNNING", group: "impl", stageDone: 0, stageCurrent: null, elapsed: "" }] });
  assert.equal(vm.card.ask, "ZZZ_QUESTION");
  assert.equal(vm.card.lane, "#901 ZZZ_LANE");
  assert.deepEqual(vm.card.choices.map((c) => c.label), ["ZZZ_OPTION_ONE", "ZZZ_OPTION_TWO"]);
  assert.deepEqual(vm.card.choices.map((c) => c.badge), ["推奨", "可"]);

  const html = render(h(cards.QuestionCard, { card: vm.card, on: NOOP }));
  for (const engine of ["ZZZ_QUESTION", "ZZZ_OPTION_ONE", "ZZZ_LANE"]) assert.match(html, new RegExp(engine));
  for (const sample of ["設定ファイルの検証", "未知のキーを見つけたら", "警告だけ出して続ける", "3 / 5"]) assert.doesNotMatch(html, new RegExp(sample));

  // the panel carries the facts and the option descriptions the compact card leaves out
  const panelHtml = render(h(InboxPanel, { panel: vm.panel }));
  for (const engine of ["ZZZ_FACT_VALUE", "ZZZ_OPTION_ONE_DESC", "ZZZ_OPTION_ONE_WHY"]) assert.match(panelHtml, new RegExp(engine));

  // the sidebar: answered / holds / ignores / running all come from the same response
  const sidebar = render(h(InboxSidebar, { m: { goLanes: noop, inbox: vm } }));
  for (const engine of ["ZZZ_ANSWERED", "ZZZ_HOLD_TITLE", "ZZZ_IGNORE_TITLE", "ZZZ_RUNNING"]) assert.match(sidebar, new RegExp(engine));
  assert.doesNotMatch(sidebar, /インデックスの置き場所/);

  // the progress row: the engine's counts, never the prototype's "3 / 5"
  const { InboxProgress } = await load("./src/components/inbox/InboxProgress.tsx");
  const progress = render(h(InboxProgress, { progress: vm.progress }));
  assert.match(progress, /2 \/ 3/);
  assert.doesNotMatch(progress, /3 \/ 5/);
});

test("AC-001: a value the engine did not return stays empty", async () => {
  const bare = { kind: "go", iddId: "#908", title: "", appearedAt: APPEARED, decisions: [], criteria: [] };
  const { vm } = await frontModel([bare, qItem], {});
  assert.equal(vm.card.ask, "この計画で実装を始めますか");
  assert.deepEqual(vm.card.rows, []);
  const html = render(h(cards.GoCard, { card: vm.card, on: NOOP }));
  assert.doesNotMatch(html, /状況|やること|結果/);
});

test("AC-001: a failed read keeps the last picture and stops the card", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const first = store.read();
  engine.calls[0].respond(200, snapshot([qItem]));
  await first;
  const second = store.read();
  engine.calls[1].respond(500, { items: [] });
  await second;
  assert.equal(store.state.connection, "down");
  const vm = inboxVals(ui(), store.state, NOOP);
  assert.equal(vm.card.ask, "ZZZ_QUESTION");
  assert.equal(vm.down, true);
});

/* ---- AC-002: every kind takes its own card shape, and none falls off ---- */

test("AC-002: the twelve kinds take the reference table's shapes, and the rest are drawn generically, none set aside", () => {
  assert.equal(cardKindOf(qItem), "question");
  assert.equal(cardKindOf(goItem), "go");
  assert.equal(cardKindOf(shipItem), "submit");
  assert.equal(cardKindOf(outboundItem), "post");
  assert.equal(cardKindOf(reviewItem), "review");
  assert.equal(cardKindOf(stuckItem), "stuck");
  assert.equal(cardKindOf(duplicateItem), "duplicate");
  assert.equal(cardKindOf(requeueItem), "requeue");
  // the shapes that used to fall to "cannot handle this yet" are drawn from the engine's answer now
  assert.equal(cardKindOf(answered({ ...goItem, purposeProposals: [{ id: "P-1", statement: "s", origin: "o" }] })), "go");
  assert.equal(cardKindOf(answered({ ...stuckItem, budget: { cost: 1, limit: 0, parts: [], subscription: [] } })), "stuck");
  assert.equal(cardKindOf(answered({ ...proposalPlain })), "proposal");
  for (const generic of [
    answered({ kind: "review", iddId: "#1", appearedAt: APPEARED, target: { title: "t", ref: { kind: "lane", label: "#1" } }, criteria: [] }),
    answered({ kind: "granularity", iddId: "#1", title: "t", appearedAt: APPEARED, proposal: { kind: "split", reason: "r", approvable: true, limit: 4 } }),
    answered({ kind: "reload", iddId: "#1", title: "t", waiting: "conversations", open: [], requests: [], waitedMs: 0, appearedAt: APPEARED }),
    storageItem,
    unknownItem,
  ]) assert.equal(cardKindOf(generic), "generic", generic.kind);
});

test("AC-002: every card is in the deck or the sidebar, and a card the engine answered nothing for sends no judgement", async () => {
  const items = [qItem, goItem, shipItem, outboundItem, reviewItem, stuckItem, duplicateItem, requeueItem, storageItem, unknownItem];
  const view = deck(items, NOW, []);
  assert.equal(view.front.length + view.later.length + view.sleeping.length, items.length);
  assert.equal(view.count, items.length);

  // a kind the engine added: it is drawn, with the one thing it can do (put it off) and no judgement the screen invented
  const unknown = cardActions(unknownItem).flatMap((s) => s.buttons.map((b) => b.intent)).filter(Boolean);
  assert.deepEqual(unknown.map((i) => i.kind), ["read", "later"]);
  assert.equal(requestFor({ kind: "later" }, unknownItem).path, "/api/idd/snooze", "the engine named putting it off, so that is all the screen sends");
  assert.equal(operationsOf(unknownItem).filter((op) => op.door !== "snooze").length, 0, "no judgement is invented for it");
  // a card the engine did answer for can always be put off
  assert.equal(requestFor({ kind: "later" }, reviewItem).path, "/api/idd/snooze");

  // the low-space card keeps only "あとで", and that one really snoozes
  const later = cardActions(storageItem).flatMap((s) => s.buttons.map((b) => b.intent)).filter(Boolean);
  assert.deepEqual(later.map((i) => i.kind), ["later"]);
  assert.equal(requestFor(later[0], storageItem).path, "/api/idd/snooze");
});

/* ---- AC-003: a card's judgement reaches the engine the way the current GUI sends it ---- */

test("AC-003: a button dispatches the intent the keymap decided for that card", async () => {
  const cases = [qItem, goItem, stuckItem, duplicateItem, requeueItem, outboundItem, shipItem];
  for (const item of cases) {
    const { vm, seen } = await frontModel([item], {});
    const expected = cardActions(item)
      .flatMap((s) => s.buttons)
      .filter((b) => b.intent)
      .map((b) => b.intent.kind);
    const buttons = [...vm.actions.left, ...vm.actions.middle, ...vm.actions.right, ...(vm.actions.later ? [vm.actions.later] : [])];
    const dispatchable = buttons.filter((b) => !b.disabled);
    assert.equal(dispatchable.length, expected.length, `${item.kind}: one live button per keymap operation`);
    for (const button of dispatchable) button.go();
    assert.deepEqual(seen.map((i) => i.kind).sort(), expected.sort(), `${item.kind}: the buttons dispatch the keymap's intents`);
  }
});

test("AC-003: a refused decision keeps the card and leaves the reason over it", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([goItem]));
  await read;
  const decision = store.decide({ kind: "go_go" }, goItem);
  await new Promise((r) => setTimeout(r, 0));
  engine.last().respond(400, { ok: false, error: "ZZZ_REFUSED" });
  await decision;
  const vm = inboxVals(ui(), store.state, NOOP);
  assert.equal(vm.card.ask, "この計画で実装を始めますか");
  assert.match(vm.error.text, /ZZZ_REFUSED/);
});

/* ---- AC-004: the confirm shows the whole signed content, and closes when it changes ---- */

test("AC-004: the confirm stage lists every signed line before the passkey is asked", async () => {
  const seen = [];
  const state = await readState([shipItem]);
  const vm = inboxVals(ui(), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  assert.equal(vm.confirming, null);
  assert.ok(vm.actions.right[0], "a signing card has a right-end operation");
  vm.actions.right[0].go();
  assert.deepEqual(seen.map((i) => i.kind), ["confirm_open"]);
  const key = seen[0].confirmKey;

  const confirming = inboxVals(ui({ confirm: key }), state, NOOP);
  assert.ok(confirming.confirming, "the confirm is open");
  const labels = confirming.confirming.rows.map((r) => r.label);
  assert.ok(labels.includes("出し先"), "the destination is listed");
  assert.ok(confirming.confirming.rows.some((r) => r.value.includes("ZZZ_REPO")));
  // changing the draft's content changes the confirm key, so the stage closes
  const changed = setShipField(ui().drafts, shipItem, "body", "ZZZ_CHANGED_BODY");
  const vmChanged = inboxVals(ui({ confirm: key, drafts: changed }), state, NOOP);
  assert.equal(vmChanged.confirming, null);
});

test("AC-004: no key registered means no confirm and a registration note", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipItem]));
  await read;
  store.readPasskeys?.();
  const state = { ...store.state, sign: { read: true, count: 0, error: null } };
  const vm = inboxVals(ui(), state, NOOP);
  assert.equal(vm.needsRegister, true);
  assert.ok(vm.actions.right[0], "the card still shows the operation");
  assert.equal(vm.actions.right[0].disabled, true, "but it cannot open the confirm");
});

/* ---- AC-005: drafts survive a read, and the receipt line stays ---- */

test("AC-005: a draft survives a state read, and card and panel print the same body", async () => {
  let drafts = applyDrafts(emptyDrafts(), [shipItem]);
  drafts = setShipField(drafts, shipItem, "body", "ZZZ_EDITED_BODY");
  // a later read returns the engine's own body again; the touched field keeps penne's
  drafts = applyDrafts(drafts, [shipItem]);
  const state = await readState([shipItem]);
  const vm = inboxVals(ui({ drafts }), state, NOOP);
  const panelHtml = render(h(InboxPanel, { panel: vm.panel }));
  assert.match(panelHtml, /ZZZ_EDITED_BODY/, "the panel shows the edited body");
  // the card sends exactly that body: its confirm rows carry the edited text
  const key = vm.actions.right[0].disabled ? null : (() => {
    const seen = [];
    inboxVals(ui({ drafts }), state, { ...NOOP, dispatch: (i) => seen.push(i) }).actions.right[0].go();
    return seen[0]?.confirmKey ?? null;
  })();
  const confirming = inboxVals(ui({ drafts, confirm: key }), state, NOOP);
  assert.ok(confirming.confirming, "the confirm opens over the edited draft");
  assert.ok(confirming.confirming.rows.some((r) => r.value.includes("ZZZ_EDITED_BODY")), "the signed content is the edited body");
  assert.ok(confirming.confirming.rows.every((r) => !r.value.includes("ZZZ_PR_BODY")), "the engine's stale body is not signed");
});

test("AC-005: the receipt of a decision the engine cannot take back stays on the screen", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([stuckItem]));
  await read;
  const decision = store.decide({ kind: "stuck_ignore" }, stuckItem);
  await new Promise((r) => setTimeout(r, 0));
  engine.last().respond(200, { ok: true });
  await new Promise((r) => setTimeout(r, 0));
  engine.last().respond(200, snapshot([]));
  await decision;
  const vm = inboxVals(ui(), store.state, NOOP);
  assert.match(vm.receipt, /#905 を外しました/);
});

/* ---- F-112-7: the engine's undelivered warning is not dropped ---- */

test("F-112-7: a decision that went through but could not reach the lane keeps the engine's warning", async () => {
  const proposal = answered({ kind: "proposal", proposalId: "PROP-9", proposalKind: "overview", repo: "r", before: [], after: [], reason: "w", from: {}, effect: "now", appearedAt: APPEARED });
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([proposal]));
  await read;
  const decision = store.decide({ kind: "proposal_approve" }, proposal);
  await new Promise((r) => setTimeout(r, 0));
  engine.last().respond(200, { ok: true, warning: "ZZZ_UNDELIVERED" });
  await new Promise((r) => setTimeout(r, 0));
  engine.last().respond(200, snapshot([]));
  await decision;
  assert.match(store.state.receipt, /PROP-9 を承認しました/);
  assert.match(store.state.receipt, /ZZZ_UNDELIVERED/, "the undelivered warning stays on the screen");
});

/* ---- F-1: an item the screen has no card for takes the entrance, and sends nothing ---- */

test("F-1: a GO with a Purpose and a stop that ran out of budget are drawn with their own answers, none of them the screen's skip", async () => {
  const drawn = [
    answered({ ...goItem, purposeProposals: [{ id: "P-1", statement: "ZZZ_PROPOSAL", origin: "o" }] }),
    answered({ ...stuckItem, budget: { cost: 1, limit: 0, parts: [], subscription: [] } }),
    answered(proposalPlain),
  ];
  for (const item of drawn) {
    assert.notEqual(cardKindOf(item), "generic", item.kind);
    const kinds = screenCardActions(item).flatMap((s) => s.buttons.map((b) => b.intent?.kind).filter(Boolean));
    assert.equal(kinds.includes("unsupported_skip"), false, `${item.kind}: the screen's skip is gone`);
    // each button the engine named reaches the engine with the engine's own action, and no key promises a held one
    const { vm, seen } = await frontModel([item], {});
    const buttons = [...vm.actions.left, ...vm.actions.middle, ...vm.actions.right, ...(vm.actions.later ? [vm.actions.later] : [])];
    for (const button of buttons.filter((b) => !b.disabled)) button.go();
    assert.ok(seen.length >= 2, `${item.kind}: more than a skip is offered`);
  }
  // the low-space card is the one exception: it carries no judgement, but its あとで really snoozes
  assert.deepEqual(intentForScreen("inbox", storageItem, { key: "ArrowDown" }, EMPTY_CONTEXT), { kind: "later" });
  assert.equal(requestFor({ kind: "later" }, storageItem).path, "/api/idd/snooze");
});

/* ---- 7-blind/F-1: 聞く's input is a consultation, and it sends no answer ---- */

test("7-blind/F-1: 聞く's consultation input is drawn apart and its send reaches no answer", async () => {
  const state = await readState([qItem]);
  // 聞く's input names itself the consultation: the question's own words are not an answer's label or help
  const consulting = inboxVals(ui({ noteOpen: true, askOpen: true, note: "ZZZ_CONSULT" }), state, NOOP);
  const cardHtml = render(h(cards.QuestionCard, { card: consulting.card, on: NOOP }));
  assert.match(cardHtml, /相談/);
  assert.doesNotMatch(cardHtml, /自由な答え/);
  // the → button the row shows is disabled: with the consultation open, nothing turns what is written into an answer
  assert.equal(consulting.actions.right[0].disabled, true);
  // the answer's own input keeps its label and its send: the gate is 聞く's input alone
  const answering = inboxVals(ui({ noteOpen: true, note: "ZZZ_ANSWER" }), state, NOOP);
  const answerHtml = render(h(cards.QuestionCard, { card: answering.card, on: NOOP }));
  assert.match(answerHtml, /自由な答え/);
  assert.equal(answering.actions.right[0].disabled, false);
});

/* ---- F-2: the outbound card, the panel and the signature read the edited draft ---- */

test("F-2: an outbound edit shows in the card, the panel and the signed content, and survives a read", async () => {
  const state = await readState([outboundItem]);
  let drafts = applyDrafts(emptyDrafts(), [outboundItem]);
  drafts = setOutboundField(drafts, outboundItem, { body: "ZZZ_EDITED_POST" });
  // a later read returns the engine's own text again; the touched field keeps penne's
  drafts = applyDrafts(drafts, [outboundItem]);

  const vm = inboxVals(ui({ drafts }), state, NOOP);
  assert.equal(vm.card.body.text, "ZZZ_EDITED_POST", "the card shows the edited body");
  const cardHtml = render(h(cards.PostCard, { card: vm.card, on: NOOP }));
  assert.match(cardHtml, /ZZZ_EDITED_POST/);
  const bodySection = vm.panel.sections.find((s) => s.rows.some((r) => r.value.includes("ZZZ_EDITED_POST")));
  assert.ok(bodySection, "the panel carries the edited body");
  const panelHtml = render(h(InboxPanel, { panel: inboxVals(ui({ drafts, tab: bodySection.tab }), state, NOOP).panel }));
  assert.match(panelHtml, /ZZZ_EDITED_POST/, "the panel shows the edited body");
  assert.doesNotMatch(panelHtml, /ZZZ_POST_BODY/);

  // the confirm opens over the edited text, and it is what the signature would cover
  const seen = [];
  const withConfirm = inboxVals(ui({ drafts }), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  assert.ok(withConfirm.actions.right[0] && !withConfirm.actions.right[0].disabled, "the approval is offered");
  withConfirm.actions.right[0].go();
  assert.deepEqual(seen.map((i) => i.kind), ["confirm_open"]);
  const confirming = inboxVals(ui({ drafts, confirm: seen[0].confirmKey }), state, NOOP);
  assert.ok(confirming.confirming, "the confirm opens over the edited draft");
  assert.ok(confirming.confirming.rows.some((r) => r.value.includes("ZZZ_EDITED_POST")), "the signed body is the edited one");
  assert.ok(confirming.confirming.rows.every((r) => !r.value.includes("ZZZ_POST_BODY")), "the engine's stale body is not signed");
});

test("F-2: an edited reply shows in the card, the panel and the confirm", async () => {
  const repliesItem = {
    ...outboundItem,
    outKind: "gh-pr-replies",
    title: "",
    replies: [{ ref: "R1", label: "ZZZ_REPLY_LABEL", quote: "ZZZ_REPLY_QUOTE", proposed: "ZZZ_REPLY_BODY", resolve: false, posted: false }],
  };
  const state = await readState([repliesItem]);
  let drafts = applyDrafts(emptyDrafts(), [repliesItem]);
  drafts = setOutboundReply(drafts, repliesItem, "R1", { body: "ZZZ_EDITED_REPLY" });
  drafts = applyDrafts(drafts, [repliesItem]);

  const vm = inboxVals(ui({ drafts }), state, NOOP);
  assert.equal(vm.card.parts[0].body, "ZZZ_EDITED_REPLY", "the card shows the edited reply");
  const replySection = vm.panel.sections.find((s) => s.rows.some((r) => r.value.includes("ZZZ_EDITED_REPLY")));
  assert.ok(replySection, "the panel carries the edited reply");
  const panelHtml = render(h(InboxPanel, { panel: inboxVals(ui({ drafts, tab: replySection.tab }), state, NOOP).panel }));
  assert.match(panelHtml, /ZZZ_EDITED_REPLY/);
  assert.doesNotMatch(panelHtml, /ZZZ_REPLY_BODY/);

  const seen = [];
  const withConfirm = inboxVals(ui({ drafts }), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  withConfirm.actions.right[0].go();
  const confirming = inboxVals(ui({ drafts, confirm: seen[0].confirmKey }), state, NOOP);
  assert.ok(confirming.confirming.rows.some((r) => r.value.includes("ZZZ_EDITED_REPLY")), "the signed reply is the edited one");
});

/* ---- F-3: a question's one line carries a reason or the free answer ---- */

test("F-3: a question card opens its one-line input, and Enter or → sends the reason or the free answer", async () => {
  const state = await readState([qItem]);
  const vm = inboxVals(ui(), state, NOOP);
  assert.ok(vm.card.notePlaceholder, "the question card opens a one-line input");
  const html = render(h(cards.QuestionCard, { card: vm.card, on: NOOP }));
  assert.match(html, /data-note-input/, "the input is drawn");
  assert.match(html, /自由な答え/, "the label names the free answer");

  // no option picked: what is written becomes the answer itself (the engine's notes), on the button or on Enter
  const freeIntent = { kind: "answer", questionId: "q1", selection: { label: "その他" }, notes: "ZZZ_FREE" };
  assert.deepEqual(intentForKey(qItem, { key: "Enter" }, { ...EMPTY_CONTEXT, noteOpen: true, note: "ZZZ_FREE" }), freeIntent);
  const seen = [];
  const freeVm = inboxVals(ui({ note: "ZZZ_FREE", noteOpen: true }), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  freeVm.actions.right[0].go();
  assert.deepEqual(seen[0], freeIntent);
  assert.equal(requestFor(seen[0], qItem).body.payload.notes, "ZZZ_FREE");

  // an option picked: what is written is that option's reason
  const reasonSeen = [];
  const reasonVm = inboxVals(ui({ note: "ZZZ_REASON", noteOpen: true, selection: 2 }), state, { ...NOOP, dispatch: (i) => reasonSeen.push(i) });
  reasonVm.actions.right[0].go();
  assert.deepEqual(reasonSeen[0], { kind: "answer", questionId: "q1", selection: { index: 2 }, reason: "ZZZ_REASON" });
});

/* ---- 4th review: the accepted findings and the prototype's panel shapes ---- */

test("F-1: the reply's Resolve is the draft's own, in the card, the panel and the signed content", async () => {
  const repliesItem = {
    ...outboundItem,
    outKind: "gh-pr-replies",
    title: "",
    replies: [{ ref: "R1", label: "ZZZ_REPLY_LABEL", quote: "ZZZ_REPLY_QUOTE", proposed: "ZZZ_REPLY_BODY", resolve: false, posted: false }],
  };
  const state = await readState([repliesItem]);
  let drafts = applyDrafts(emptyDrafts(), [repliesItem]);
  // penne flips the toggle: the display must follow the draft, not the engine's own item
  drafts = setOutboundReply(drafts, repliesItem, "R1", { resolve: true });
  drafts = applyDrafts(drafts, [repliesItem]);

  const vm = inboxVals(ui({ drafts }), state, NOOP);
  assert.equal(vm.card.parts[0].resolve, true, "the card shows the draft's Resolve");
  const parts = vm.panel.sections.flatMap((s) => s.parts ?? []);
  assert.equal(parts[0].resolve, true, "the panel shows the draft's Resolve");
  const replies = vm.panel.sections.find((s) => s.parts?.length);
  const panelHtml = render(h(InboxPanel, { panel: inboxVals(ui({ drafts, tab: replies.tab }), state, NOOP).panel, on: NOOP }));
  assert.match(panelHtml, /data-panel-resolve="R1"/);

  // the signed content carries the same Resolve, and the engine's item never overrides it
  const seen = [];
  const withConfirm = inboxVals(ui({ drafts }), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  withConfirm.actions.right[0].go();
  const confirming = inboxVals(ui({ drafts, confirm: seen[0].confirmKey }), state, NOOP);
  const resolveRow = confirming.confirming.rows.find((r) => r.label.includes("Resolve"));
  assert.ok(resolveRow, "the confirm lists the Resolve");
  assert.match(resolveRow.value, /Resolve する/);
});

test("F-2: a reply body keeps its newlines in the card's editor and in the store", async () => {
  const repliesItem = {
    ...outboundItem,
    outKind: "gh-pr-replies",
    title: "",
    replies: [{ ref: "R1", label: "ZZZ_REPLY_LABEL", quote: "ZZZ_REPLY_QUOTE", proposed: "ZZZ_REPLY_BODY", resolve: false, posted: false }],
  };
  const state = await readState([repliesItem]);
  let drafts = applyDrafts(emptyDrafts(), [repliesItem]);
  drafts = setOutboundReply(drafts, repliesItem, "R1", { body: "ZZZ_LINE_ONE\nZZZ_LINE_TWO" });
  drafts = applyDrafts(drafts, [repliesItem]);

  const vm = inboxVals(ui({ drafts }), state, NOOP);
  assert.equal(vm.card.parts[0].body, "ZZZ_LINE_ONE\nZZZ_LINE_TWO");
  const html = render(h(cards.PostCard, { card: vm.card, on: NOOP }));
  assert.match(html, /<textarea/, "the reply is a multi-line editor, not a one-line input");
  assert.match(html, /ZZZ_LINE_ONE\nZZZ_LINE_TWO/, "the editor carries both lines");
});

test("the accept button on a limit stop shows 今のまま受け入れる and no key of its own", async () => {
  const { vm } = await frontModel([{ ...stuckItem }], {});
  assert.deepEqual(vm.actions.left.map((b) => b.label), ["lane を外す", "今のまま受け入れる"]);
  assert.deepEqual(vm.actions.left.map((b) => b.key), ["←", null], "the split's back side shows no key");
});

test("a question card carries 前の質問 · 背景を読む · 聞く, and the panel a tab per open question", async () => {
  const state = await readState([qItem]);
  const vm = inboxVals(ui(), state, NOOP);
  assert.deepEqual(vm.actions.left.map((b) => [b.key, b.label]), [["←", "前の質問"]]);
  assert.deepEqual(vm.actions.middle.map((b) => b.label), ["背景を読む", "聞く"]);
  assert.deepEqual(vm.actions.right.map((b) => b.label), ["次の質問"]);
  assert.equal(vm.panel.tabs.length, 1, "one tab per open question");
  assert.equal(vm.panel.tabs[0].label, "Q2");
  assert.equal(vm.panel.tabs[0].note, "ZZZ_QUESTION");
  assert.deepEqual(vm.panel.choices[0].description, "ZZZ_OPTION_ONE_DESC");
  assert.deepEqual(vm.panel.choices[0].rationale, "ZZZ_OPTION_ONE_WHY");
  const stepHtml = render(h(InboxPanel, { panel: vm.panel, on: NOOP }));
  assert.match(stepHtml, /Q2/);
  assert.match(stepHtml, /ZZZ_OPTION_ONE_DESC/);
});

test("an out-of-range question index points the card, the panel and the answer at the same question", async () => {
  const multi = {
    ...qItem,
    open: [
      { questionId: "q1", question: "ZZZ_FIRST", facts: [], options: [{ index: 1, label: "ZZZ_FIRST_OPTION" }] },
      { questionId: "q2", question: "ZZZ_SECOND", facts: [], options: [{ index: 1, label: "ZZZ_SECOND_OPTION" }] },
    ],
  };
  // a state read shrank the open list under an index that was picked for a longer one
  const state = await readState([multi]);
  const vm = inboxVals(ui({ question: 5 }), state, NOOP);
  assert.equal(vm.card.ask, "ZZZ_SECOND", "the card shows the question the panel shows");
  assert.deepEqual(vm.panel.tabs.map((t) => t.active), [false, true], "the panel marks the same question");
  assert.equal(vm.panel.tabs[1].note, "ZZZ_SECOND");
  assert.deepEqual(vm.panel.sections.map((s) => s.rows[0].value), ["ZZZ_SECOND"], "the panel's body is that question");
  assert.equal(vm.panel.choices[0].label, "ZZZ_SECOND_OPTION", "the panel's options are that question's");

  // the -> button and the Enter key build the answer for that same question, and the request carries its id
  const seen = [];
  const actVm = inboxVals(ui({ question: 5, noteOpen: true, note: "ZZZ_REASON" }), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  actVm.actions.right[0].go();
  assert.equal(seen[0].questionId, "q2", "the button's answer goes to the question the panel shows");
  const keyIntent = intentForKey(multi, { key: "Enter" }, { ...EMPTY_CONTEXT, question: 5, noteOpen: true, note: "ZZZ_REASON" });
  assert.equal(keyIntent.questionId, "q2", "the key's answer goes to the same question");
  assert.equal(requestFor(keyIntent, multi).body.payload.questionId, "q2");
});

test("a plain input stands on a GO and a stuck card, and the question keeps its own label", async () => {
  for (const item of [goItem, stuckItem]) {
    const { vm } = await frontModel([item], {});
    const html = render(h(vm.card.cardKind === "go" ? cards.GoCard : cards.StuckCard, { card: vm.card, on: NOOP }));
    assert.match(html, /data-note-input/, `${item.kind}: the input is drawn`);
    assert.doesNotMatch(html, /自由な答え/, `${item.kind}: the question's own label is not carried`);
    assert.doesNotMatch(html, /選択肢を外すと/, `${item.kind}: the question's own help is not carried`);
  }
});

test("a submit card's three cells draw the prototype's own shapes", async () => {
  const { vm } = await frontModel([shipNewPr], {});
  assert.deepEqual(vm.card.stats.map((s) => s.kind), ["rounds", "leftovers", "acceptance"]);
  assert.equal(vm.card.stats[0].rounds, 3, "the round count is the engine's");
  const html = render(h(cards.SubmitCard, { card: vm.card, on: NOOP }));
  assert.match(html, /R1/);
  assert.match(html, /後回し/);
  assert.match(html, /border-radius:50%/, "the acceptance cell is a ring");
});

test("AC-003: a stuck card shows the judge's recommendation with grounds, and none when the judge did not run", async () => {
  const recommendation = { choice: "replan", reasons: [{ kind: "file", ref: "a.ts", text: "a.ts が 2 巡続けて名指された" }, { kind: "round", ref: "2", text: "巡 2 も must が残った" }], shape: "持ち主を 1 つにする" };
  const withRec = (await frontModel([{ ...stuckItem, recommendation }], {})).vm;
  const section = withRec.panel.sections.find((s) => s.heading === WORDS.stuck.recommend);
  assert.ok(section, "the recommendation is a section of the card's panel");
  assert.deepEqual(section.rows.map((r) => [r.label, r.value]), [
    [WORDS.stuck.recommend, WORDS.stuck.recommendChoice.replan],
    ["a.ts", "a.ts が 2 巡続けて名指された"],
    ["R2", "巡 2 も must が残った"],
    [WORDS.stuck.recommendShape, "持ち主を 1 つにする"],
  ]);
  const without = (await frontModel([stuckItem], {})).vm;
  assert.equal(without.panel.sections.some((s) => s.heading === WORDS.stuck.recommend), false);
});

test("a stuck panel draws the round bands, and a submit panel the check command line", async () => {
  const stuck = (await frontModel([stuckItem], {})).vm;
  const progress = stuck.panel.sections.find((s) => s.rounds);
  assert.ok(progress, "the 経過 section carries the bands");
  assert.equal(progress.rounds[0].label, "R1");
  assert.equal(progress.rounds.length, stuckItem.fixRounds);
  assert.match(render(h(InboxPanel, { panel: stuck.panel, on: NOOP })), /R1/);

  const ship = (await frontModel([shipItem], {})).vm;
  const checks = ship.panel.sections.find((s) => s.checks);
  assert.ok(checks, "the 検査 section carries the checks");
  assert.equal(checks.checks[0].label, "ZZZ_CHECK_OK");
});

test("a submit card warns about the non-blocking checks the engine folded, and reads no record itself", async () => {
  const warnings = [{ name: "intent", reason: "error round IDD-153: 巡に Choice の新設・Re-anchor・Supersede・Waive がありません" }];
  const { vm } = await frontModel([{ ...shipLand, checkWarnings: warnings }], {});
  assert.deepEqual(vm.card.checkWarnings, warnings);
  const html = render(h(cards.SubmitCard, { card: vm.card, on: NOOP }));
  assert.match(html, /data-card-warnings/);
  assert.match(html, /intent: error round IDD-153/);
  assert.match(html, /このまま署名できます/);
  assert.doesNotMatch(html, /署名できない/);
  assert.ok(html.indexOf("data-card-warnings") < html.indexOf("typecheck"), "the warning comes before the check pills");

  // the screen draws the engine's value alone: a failed non-blocking check left on the record with no warning value stays unseen
  const record = { ...shipLand, land: { ...shipLand.land, checks: [{ name: "intent", status: "fail", severity: "non-blocking", detail: "error round IDD-153: 巡に Choice がありません" }] } };
  const plain = (await frontModel([record], {})).vm;
  assert.equal(plain.card.checkWarnings, undefined);
  assert.doesNotMatch(render(h(cards.SubmitCard, { card: plain.card, on: NOOP })), /data-card-warnings/);

  // the same card whose non-blocking checks passed draws no warning either
  const passed = (await frontModel([shipLand], {})).vm;
  assert.equal(passed.card.checkWarnings, undefined);
  assert.doesNotMatch(render(h(cards.SubmitCard, { card: passed.card, on: NOOP })), /data-card-warnings/);
});

/* ---- #156: the signing mark, the confirm gate, the recommended choice and the sidebar ---- */

/** the rail reads its badge off the Inbox model; the rest of the model is noise for the badge's test */
const railModel = (inbox, over = {}) => ({
  inbox,
  goInbox: noop,
  goLanes: noop,
  goChat: noop,
  rbInbox: "",
  rsInbox: "",
  rcInbox: "",
  rbLanes: "",
  rsLanes: "",
  rcLanes: "",
  rbChat: "",
  rsChat: "",
  rcChat: "",
  ...over,
});

/** the side of the operation row that can reach a signature, as it is drawn */
const rightPill = (html) => {
  const at = html.lastIndexOf("border-radius:999px");
  return html.slice(at);
};

test("AC-001: only the primary that reaches a signature wears the 藍の地と輪", async () => {
  const ship = (await frontModel([shipItem], {})).vm;
  const shipHtml = render(h(CardActions, { actions: ship.actions }));
  assert.match(rightPill(shipHtml), /background:var\(--sign\)/, "the approval is 藍");
  assert.match(rightPill(shipHtml), /border-radius:50%/, "and wears the ring");

  // a submit card whose primary only checks again signs nothing
  const check = (await frontModel([{ ...shipItem, proposal: undefined, checks: [{ label: "ZZZ_CHECK_OK", ok: true }] }], {})).vm;
  assert.equal(check.actions.right[0].label, "検査し直す");
  const checkHtml = render(h(CardActions, { actions: check.actions }));
  assert.doesNotMatch(rightPill(checkHtml), /background:var\(--sign\)/);
  assert.doesNotMatch(rightPill(checkHtml), /border-radius:50%/, "no ring on a non-signing primary");

  // the judgements that stay on this screen wear neither
  for (const item of [goItem, qItem, stuckItem, duplicateItem, requeueItem]) {
    const vm = (await frontModel([item], {})).vm;
    const html = render(h(CardActions, { actions: vm.actions }));
    assert.doesNotMatch(rightPill(html), /background:var\(--sign\)/, item.kind);
    assert.doesNotMatch(rightPill(html), /border-radius:50%/, item.kind);
  }
});

test("AC-001: the Passkey note is only over a card whose primary reaches a signature", async () => {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => NOW);
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipItem]));
  await read;
  const signable = { ...store.state, sign: { read: true, count: 0, error: null } };
  assert.equal(inboxVals(ui(), signable, NOOP).needsRegister, true);

  const qEngine = fakeFetch();
  const qStore = new InboxStore(qEngine.fetchFn, () => NOW);
  const qRead = qStore.read();
  qEngine.calls[0].respond(200, snapshot([qItem]));
  await qRead;
  const questionOnly = { ...qStore.state, sign: { read: true, count: 0, error: null } };
  assert.equal(inboxVals(ui(), questionOnly, NOOP).needsRegister, false, "a question needs no key");

  // a primary that only checks again does not need a key either
  const checkEngine = fakeFetch();
  const checkStore = new InboxStore(checkEngine.fetchFn, () => NOW);
  const checkRead = checkStore.read();
  checkEngine.calls[0].respond(200, snapshot([{ ...shipItem, proposal: undefined, checks: [{ label: "ZZZ_CHECK_OK", ok: true }] }]));
  await checkRead;
  assert.equal(inboxVals(ui(), { ...checkStore.state, sign: { read: true, count: 0, error: null } }, NOOP).needsRegister, false);
});

test("AC-002: a signed content that changed cannot be approved from the stage that is gone", async () => {
  const state = await readState([shipItem]);
  const seen = [];
  const open = inboxVals(ui(), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  assert.ok(open.actions.right[0] && !open.actions.right[0].disabled);
  open.actions.right[0].go();
  assert.deepEqual(seen.map((i) => i.kind), ["confirm_open"]);
  const key = seen[0].confirmKey;
  assert.ok(inboxVals(ui({ confirm: key }), state, NOOP).confirming, "the stage is drawn");

  // the draft changed under the open stage: the stage closes, and -> opens it again with the new content
  const changedDrafts = setShipField(ui().drafts, shipItem, "body", "ZZZ_CHANGED_BODY");
  const changed = inboxVals(ui({ confirm: key, drafts: changedDrafts }), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  assert.equal(changed.confirming, null, "the stage of the old content is not drawn");
  seen.length = 0;
  changed.actions.right[0].go();
  assert.deepEqual(seen.map((i) => i.kind), ["confirm_open"], "the changed content is not signed straight away");
  assert.notEqual(seen[0].confirmKey, key, "the reopened stage is about the new content");

  // an outbound card is gated the same way
  const outState = await readState([outboundItem]);
  const outSeen = [];
  const outOpen = inboxVals(ui(), outState, { ...NOOP, dispatch: (i) => outSeen.push(i) });
  outOpen.actions.right[0].go();
  const outKey = outSeen[0].confirmKey;
  const outDrafts = setOutboundField(ui().drafts, outboundItem, { body: "ZZZ_CHANGED_POST" });
  const outChanged = inboxVals(ui({ confirm: outKey, drafts: outDrafts }), outState, { ...NOOP, dispatch: (i) => outSeen.push(i) });
  assert.equal(outChanged.confirming, null);
  outSeen.length = 0;
  outChanged.actions.right[0].go();
  assert.deepEqual(outSeen.map((i) => i.kind), ["confirm_open"]);
});

test("F-1: with the confirm open, the card's primary and the stage's approve both sign", async () => {
  const state = await readState([shipItem]);
  const seen = [];
  const open = inboxVals(ui(), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  open.actions.right[0].go();
  const key = seen[0].confirmKey;
  seen.length = 0;

  // the stage is open: the card's right-end operation sends the frozen approval, not a second confirm
  const confirming = inboxVals(ui({ confirm: key }), state, { ...NOOP, dispatch: (i) => seen.push(i) });
  assert.ok(confirming.confirming, "the stage is drawn");
  const keyboard = intentForKey(shipItem, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  confirming.actions.right[0].go();
  assert.deepEqual(seen.map((i) => i.kind), ["ship_approve"], "the button signs, not reopens");
  assert.equal(seen[0].action, keyboard.action);
  assert.deepEqual(seen[0].payload, keyboard.payload, "the button sends the same frozen content as the key");

  // the stage's own approve presses the same operation
  seen.length = 0;
  confirming.confirming.approve.go();
  assert.deepEqual(seen.map((i) => i.kind), ["ship_approve"]);
  assert.equal(seen[0].action, keyboard.action);

  // the outbound card is gated the same way
  const outState = await readState([outboundItem]);
  const outSeen = [];
  const outOpen = inboxVals(ui(), outState, { ...NOOP, dispatch: (i) => outSeen.push(i) });
  outOpen.actions.right[0].go();
  const outKey = outSeen[0].confirmKey;
  outSeen.length = 0;
  const outConfirming = inboxVals(ui({ confirm: outKey }), outState, { ...NOOP, dispatch: (i) => outSeen.push(i) });
  outConfirming.actions.right[0].go();
  assert.deepEqual(outSeen.map((i) => i.kind), ["outbound_approve"]);
  outSeen.length = 0;
  outConfirming.confirming.approve.go();
  assert.deepEqual(outSeen.map((i) => i.kind), ["outbound_approve"]);
});

test("F-2: the submit panel shows each ran check's own detail, label and name apart", async () => {
  // the engine's two lists are different: the card's own acceptance lines carry a label, and the ran checks a name
  // with the line the engine ran. Each detail is read from the check it belongs to, never across the two (F-2).
  const real = {
    ...shipNewPr,
    checks: [
      { label: "作業ツリーに未 commit の変更が無い", ok: true },
      { label: "commit がある", ok: true },
      { label: "満たすべき条件がすべて確認済み", ok: true },
    ],
    proposal: {
      ...shipNewPr.proposal,
      checks: [
        { name: "typecheck", status: "pass", severity: "blocking", detail: "$ pnpm typecheck" },
        { name: "lint", status: "pass", severity: "blocking", detail: "$ pnpm lint" },
        { name: "e2e", status: "fail", severity: "blocking", detail: "config-reload.spec.ts が timeout" },
      ],
    },
  };
  const vm = (await frontModel([real], {})).vm;
  const sec = vm.panel.sections.find((s) => s.checks);
  assert.deepEqual(sec.checks.map((c) => c.label), ["typecheck", "lint", "e2e"], "the ran checks are the rows");
  assert.deepEqual(sec.checks.map((c) => c.detail), ["$ pnpm typecheck", "$ pnpm lint", "config-reload.spec.ts が timeout"]);
  assert.equal(sec.checks.find((c) => c.label === "e2e").ok, false);
  assert.equal(sec.checks.some((c) => c.label.includes("作業ツリー")), false, "a card line is not a ran check");

  // before any proposal the card's own lines stand, with no command to show
  const before = { ...real, proposal: undefined };
  const vmBefore = (await frontModel([before], {})).vm;
  const secBefore = vmBefore.panel.sections.find((s) => s.checks);
  assert.equal(secBefore.checks[0].label, "作業ツリーに未 commit の変更が無い");
  assert.equal(secBefore.checks[0].detail, "");
});

test("F-3: a next row sends wake only for a slept card whose ask has come", async () => {
  const second = { ...goItem, iddId: "#907", title: "ZZZ_SECOND", source: { kind: "github", label: "ZZZ_REF_2" } };
  const due = { ...goItem, iddId: "#908", title: "ZZZ_DUE", sleptAt: "2026-10-01T00:00:00Z", sleepStep: 1, sleepNoticeAt: "2026-10-04T00:00:00Z" };
  const state = await readState([goItem, second, due]);
  const woken = [];
  const vm = inboxVals(ui(), state, { ...NOOP, wake: (i) => woken.push(i.iddId) });
  assert.equal(vm.sidebar.next.length, 2, "the shown card is not in the next list");
  assert.equal(vm.sidebar.next[0].progress, 1, "the slept card whose ask has come");
  vm.sidebar.next[0].go();
  assert.deepEqual(woken, ["#908"], "a slept card whose ask has come is brought back");
  woken.length = 0;
  vm.sidebar.next[1].go();
  assert.deepEqual(woken, [], "a card already in the deck is not woken");
});

test("a next row that is already in the deck brings its card to the front in the screen alone", async () => {
  const second = { ...goItem, iddId: "#907", title: "ZZZ_SECOND", source: { kind: "github", label: "ZZZ_REF_2" } };
  const state = await readState([goItem, second]);
  const focused = [];
  const woken = [];
  const vm = inboxVals(ui(), state, { ...NOOP, wake: (i) => woken.push(i.iddId), focus: (i) => focused.push(i.iddId) });
  vm.sidebar.next[0].go();
  assert.deepEqual(focused, ["#907"], "the row's card is brought to the front");
  assert.deepEqual(woken, [], "nothing is sent to the engine");
});

test("AC-003: a question with exactly one recommendation opens with it chosen", async () => {
  const state = await readState([qItem]);
  const untouched = inboxVals(ui({ selection: undefined }), state, NOOP);
  assert.equal(untouched.card.choices.filter((c) => c.selected).length, 1);
  assert.equal(untouched.card.choices.find((c) => c.selected).index, 1, "the recommendation");
  assert.equal(untouched.card.noteLabel, WORDS.question.reasonFor(1));
  assert.equal(untouched.panel.noteInput.label, WORDS.question.reasonFor(1), "the panel's line carries the same label");

  // 2 recommendations or none: the screen picks nothing
  const two = { ...qItem, open: [{ ...qItem.open[0], options: [{ index: 1, label: "A", recommendation: "recommended" }, { index: 2, label: "B", recommendation: "recommended" }] }] };
  assert.equal(recommendedSelection(two, 0), null);
  assert.equal(recommendedSelection({ ...qItem, open: [{ ...qItem.open[0], options: [{ index: 1, label: "A" }] }] }, 0), null);
  const bareState = await readState([two]);
  assert.equal(inboxVals(ui({ selection: undefined }), bareState, NOOP).card.choices.filter((c) => c.selected).length, 0);

  // penne's own choice stands: taken off stays off, another pick stays picked (a read does not restore it)
  const off = inboxVals(ui({ selection: null }), state, NOOP);
  assert.equal(off.card.choices.filter((c) => c.selected).length, 0);
  assert.equal(off.card.noteLabel, WORDS.question.freeAnswer);
  const second = inboxVals(ui({ selection: 2 }), state, NOOP);
  assert.equal(second.card.choices.find((c) => c.selected).index, 2);
  assert.equal(second.card.noteLabel, WORDS.question.reasonFor(2));
  assert.equal(second.card.choices.find((c) => c.index === 1).selected, false);

  // the help stays on one line in the card and in the panel
  const cardHtml = render(h(cards.QuestionCard, { card: second.card, on: NOOP }));
  assert.match(cardHtml, /white-space:nowrap/);
  assert.match(cardHtml, /選択肢を外すと/);
  const panelHtml = render(h(InboxPanel, { panel: second.panel, on: NOOP }));
  assert.match(panelHtml, /white-space:nowrap/);
});

test("AC-004: the card's and the panel's one line are the same box and send the same talk on Enter", async () => {
  const state = await readState([qItem]);
  const asking = inboxVals(ui({ noteOpen: true, askOpen: true, note: "ZZZ_CONSULT" }), state, NOOP);
  const cardHtml = render(h(cards.QuestionCard, { card: asking.card, on: NOOP }));
  const panelHtml = render(h(InboxPanel, { panel: asking.panel, on: NOOP, consult: { active: true, heading: "相談", count: "相談 0", lines: [], empty: "", error: null, canPromote: false, promoting: false, promoteError: null, labels: { keep: "残す", back: "回答に戻る", open: "聞く" } } }));
  assert.match(cardHtml, /data-note-input/);
  assert.match(panelHtml, /data-note-input/, "the panel's line is the same box the screen's keys read");
  // the same words are in both
  assert.match(cardHtml, /ZZZ_CONSULT/);
  assert.match(panelHtml, /ZZZ_CONSULT/);

  // Enter while 聞く is open sends the talk; the IME conversion's Enter and every other press send nothing
  assert.equal(sendsConsultation(true, { key: "Enter" }), true);
  assert.equal(sendsConsultation(true, { key: "Enter", isComposing: true }), false);
  assert.equal(sendsConsultation(true, { key: "Enter", keyCode: 229 }), false);
  assert.equal(sendsConsultation(true, { key: "Enter", shiftKey: true }), false);
  assert.equal(sendsConsultation(true, { key: "a" }), false);
  assert.equal(sendsConsultation(false, { key: "Enter" }), false, "the answer's own Enter is the keymap's");
});

test("AC-006: the rail's badge is the Inbox count on every screen", async () => {
  const two = inboxVals(ui(), await readState([qItem, goItem]), NOOP);
  assert.equal(two.badge, 2);
  for (const view of ["inbox", "work", "chat"]) {
    const html = render(h(Rail, { m: railModel(two, { view }) }));
    assert.match(html, />2<\/span>/, `${view}: the badge is the engine's count`);
  }
  // a newer state read replaces the badge
  const one = inboxVals(ui(), await readState([qItem]), NOOP);
  assert.match(render(h(Rail, { m: railModel(one) })), />1<\/span>/);
});

test("AC-007: the stuck split puts the primary first, and the small fixes take their words", async () => {
  const stuck = (await frontModel([{ ...stuckItem }], {})).vm;
  assert.deepEqual(stuck.actions.right.map((b) => b.label), ["もう 1 巡", "自分で直す"], "the keyed side comes first; no recommendation, no replan");
  assert.equal(stuck.actions.right[0].key, "→");
  assert.equal(stuck.actions.right[1].key, null, "the split's key-less side shows no key");
  const recommended = (await frontModel([{ ...stuckItem, recommendation: { choice: "replan", reasons: [{ kind: "round", ref: "1", text: "巡 1" }], shape: "組み直す" } }], {})).vm;
  assert.deepEqual(recommended.actions.right.map((b) => b.label), ["もう 1 巡", "自分で直す", "計画から考え直す"]);
  assert.equal(recommended.actions.right[2].key, null, "the replan shows no key of its own");

  // the confirm's cancel is an operation word
  assert.equal(WORDS.sign.cancel, "やめる");

  // the duplicate asks about the existing lane's identifier, not its title
  const dup = (await frontModel([duplicateItem], {})).vm;
  assert.match(dup.card.ask, /#142/);
  assert.doesNotMatch(dup.card.ask, /ZZZ_EXISTING/);

  // the submit panel draws the engine's check detail
  const ship = (await frontModel([shipNewPr], {})).vm;
  const checks = ship.panel.sections.find((s) => s.checks);
  assert.equal(checks.checks.find((c) => c.label === "typecheck").detail, "$ pnpm typecheck");
});

test("AC-007: a card of a kind the screen has no shape for is drawn from the engine's answer, and sends the visitor nowhere else", async () => {
  const before = globalThis.location;
  try {
    for (const hostname of ["[::1]", "100.64.0.1"]) {
      globalThis.location = { protocol: "http:", hostname };
      const vm = (await frontModel([{ kind: "cosmic", iddId: "#999", appearedAt: APPEARED }], {})).vm;
      assert.equal("oldGuiUrl" in vm.card, false, "no entrance to the current GUI is offered");
      assert.equal(vm.card.cardKind, "generic");
      const html = render(h(cards.GenericCard, { card: vm.card, on: NOOP }));
      assert.doesNotMatch(html, /今の GUI/);
    }
  } finally {
    if (before === undefined) delete globalThis.location;
    else globalThis.location = before;
  }
});

test("AC-009: the sidebar keeps a long title on one line and shows its short identity", async () => {
  const long = { ...goItem, title: "ZZZ_LONG_TITLE_REPEATED_" + "あ".repeat(40) };
  const state = await readState([qItem, long], {
    ignores: [{ ref: "#133", title: "ZZZ_IGNORED_" + "い".repeat(40), source: "github", at: APPEARED, by: "user" }],
    holds: [{ ref: "#170", title: "ZZZ_HELD_" + "う".repeat(40), source: "github", at: APPEARED }],
  });
  const vm = inboxVals(ui(), state, NOOP);
  const html = render(h(InboxSidebar, { m: { goLanes: noop, inbox: vm } }));
  assert.match(html, /text-overflow:ellipsis/, "the long titles are cut, not wrapped");
  assert.match(html, /white-space:nowrap/);
  assert.match(html, /title="#902 ZZZ_LONG_TITLE_REPEATED_/, "the full title is on hover");
  assert.match(html, /#902/, "the next row shows the lane's short identity");
  assert.match(html, /#133/, "the ignore row shows its ref");
  assert.match(html, /今の GUI で開く|前に戻す|戻す/);
  assert.match(html, /width:28px;height:3px/, "the next row carries the wait bar");

  // the card's heading keeps its long lane on one line too, and its source link does not break
  const ship = (await frontModel([shipItem], {})).vm;
  const cardHtml = render(h(cards.SubmitCard, { card: ship.card, on: NOOP }));
  assert.match(cardHtml, /text-overflow:ellipsis/);
  assert.match(cardHtml, /white-space:nowrap/);
});

test("AC-010: a section with no row is not drawn at all", async () => {
  const empty = inboxVals(ui(), await readState([qItem]), NOOP);
  const emptyHtml = render(h(InboxSidebar, { m: { goLanes: noop, inbox: empty } }));
  for (const gone of ["次に来るもの", "後で", "依存待ち", "外した", "Running lanes", "今日答えたもの", WORDS.sidebar.none]) {
    assert.equal(emptyHtml.includes(gone), false, gone);
  }

  // one put-off card brings its section back, and it can be woken from there
  const later = { ...goItem, snoozedUntil: "2026-10-05T13:00:00Z" };
  const oneLater = inboxVals(ui(), await readState([qItem, later]), NOOP);
  const laterHtml = render(h(InboxSidebar, { m: { goLanes: noop, inbox: oneLater } }));
  assert.match(laterHtml, /後で/);
  assert.match(laterHtml, /前に戻す/);
});

test("a records-only submit card carries the one line 記録だけ（署名できません）and no signing primary", async () => {
  const reason = "記録だけの lane は merge できません（本流との差分が overlay.manifest の記録だけで、公開側に何も加えません）。前提待ちで戻った lane なら前提の着地後に差し戻して実装させ、実装の要らない lane なら無視して閉じてください";
  const { vm } = await frontModel([{ ...shipLand, recordsOnly: { reason } }], {});
  const row = vm.card.rows.find((r) => r.label === WORDS.ship.recordsOnly);
  assert.ok(row, "the mark is a row of the card");
  assert.equal(row.value, reason);
  assert.equal(vm.card.rows.filter((r) => r.value === reason).length, 1, "the refusal is said once");
  const primary = vm.actions.right[0];
  assert.equal(primary.disabled, true, "the right end sends nothing");
  assert.equal(primary.sign, false, "the right end wears no signing mark");
  const html = render(h(cards.SubmitCard, { card: vm.card, on: NOOP }));
  assert.match(html, /記録だけ（署名できません）/);
});

// ---- Issue #231: what the submit card says about what holds it, what is put off, what goes out, and when it was checked ----

const blockedBy = (checks, blocking = checks.filter((c) => c.severity === "blocking" && !["pass", "not-applicable"].includes(c.status)).length) =>
  ({ ...shipNewPr, proposal: { ...shipNewPr.proposal, blocking, checks } });

test("a submit card names each check that holds the signature, failed or not run, and says no count alone", async () => {
  const item = blockedBy([
    { name: "typecheck", status: "pass", severity: "blocking" },
    { name: "check-mutation", status: "fail", severity: "blocking", detail: "検査が提出内容を変更しました:\n M sandbox/__pycache__/a.pyc\n変えた path 1 件。うち追跡されたバイナリ（生成物）1 件: sandbox/__pycache__/a.pyc。追跡から外すか .gitignore に入れてください" },
    { name: "unittest", status: "skipped", severity: "blocking", detail: "準備に失敗したので回していません" },
    { name: "docs", status: "fail", severity: "non-blocking", detail: "check-docs: FAILED: x" },
  ]);
  const { vm } = await frontModel([item], {});
  const rows = vm.card.rows.filter((r) => r.label === WORDS.ship.blocking);
  assert.equal(rows.length, 2);
  assert.match(rows[0].value, /^check-mutation（変えた path 1 件。うち追跡されたバイナリ（生成物）1 件: sandbox\/__pycache__\/a\.pyc/);
  assert.equal(rows[1].value, "unittest（未実行: 準備に失敗したので回していません）");
  assert.equal(vm.card.rows.some((r) => /止める検査が/.test(r.value)), false, "no row says only how many");
  assert.equal(vm.card.rows.some((r) => r.label === "理由"), false, "the reason is the named rows, not a second line repeating them");
  const html = render(h(cards.SubmitCard, { card: vm.card, on: NOOP }));
  assert.match(html, /check-mutation/);
  assert.doesNotMatch(html, /typecheck（/, "a check that passed is not named as a stop");
  assert.equal(vm.actions.right[0].sign, false, "a card held by a check offers the check again, not a signature");
});

test("a landing card names the checks that hold its merge the same way, and one that held nothing says the other reason", async () => {
  const held = { ...shipLand, land: { ...shipLand.land, blocking: 1, checks: [{ name: "test", status: "fail", severity: "blocking", detail: "error boom\n2 failed" }] } };
  const { vm } = await frontModel([held], {});
  assert.deepEqual(vm.card.rows.filter((r) => r.label === WORDS.ship.blocking).map((r) => r.value), ["test（error boom）"]);
  const expired = { ...shipLand, land: { ...shipLand.land, expiresAt: "2020-01-01T00:00:00Z" } };
  const other = (await frontModel([expired], {})).vm;
  assert.equal(other.card.rows.some((r) => r.label === WORDS.ship.blocking), false);
  assert.match(other.card.rows.find((r) => r.label === "理由").value, /期限/);
});

test("the 後回し count holds the findings sent to a follow-up as well, and a rejected claim stays only a rejected one", async () => {
  const { vm } = await frontModel([shipNewPr], {});
  const cell = vm.card.stats.find((s) => s.kind === "leftovers");
  assert.equal(cell.leftovers, 2, "one accepted and not fixed, one sent to a follow-up");
  assert.equal(cell.rejected, 1);
  // IDD-213's last judgement: the .pyc finding went to a follow-up and one nit was rejected
  const idd213 = { ...shipNewPr, review: { ...shipNewPr.review, leftovers: [], followups: [{ severity: "should", claim: ".pyc を追跡している", path: "sandbox/__pycache__/a.pyc", task: "Sandbox-Chore-1" }], rejected: [{ claim: "nit", reason: "r" }] } };
  const both = (await frontModel([idd213], {})).vm.card.stats.find((s) => s.kind === "leftovers");
  assert.deepEqual([both.leftovers, both.rejected], [1, 1]);
  const none = (await frontModel([{ ...shipNewPr, review: { ...shipNewPr.review, leftovers: [], followups: [], rejected: [] } }], {})).vm.card.stats.find((s) => s.kind === "leftovers");
  assert.deepEqual([none.leftovers, none.rejected], [0, 0]);
  // the list of what went to the next change is still readable, on the review tab
  const panel = (await frontModel([idd213], {})).vm.panel;
  const section = panel.sections.find((s) => s.heading === WORDS.panels.heading.followups);
  assert.ok(section);
  assert.match(section.rows[0].value, /\.pyc を追跡している — TODO Sandbox-Chore-1 に記録/);
});

test("a card whose commit message is not drafted yet says it is being drafted, and shows no PR title as the message", async () => {
  const waiting = { ...shipNewPr, commit: { pending: true }, proposal: { ...shipNewPr.proposal, commitMessage: "Summary" }, pr: { ...shipNewPr.pr, title: "Summary" } };
  const { vm } = await frontModel([waiting], {});
  assert.equal(vm.card.rows.some((r) => r.label === WORDS.ship.label.commit), false, "no row presents a message");
  assert.match(vm.card.rows.find((r) => r.label === "理由").value, /下書きを作っている途中/);
  assert.equal(vm.actions.right[0].sign, false, "nothing is signed while there is no message to sign");
  // once the draft arrives, the card shows it as the message that goes out
  const drafted = (await frontModel([{ ...waiting, commit: { draft: "feat: change the app" } }], {})).vm;
  assert.equal(drafted.card.rows.find((r) => r.label === WORDS.ship.label.commit).value, "feat: change the app");
  // a failed draft leaves a message to go on with, and the card says it failed
  const failed = (await frontModel([{ ...waiting, commit: { failed: "no runner", start: "Summary" } }], {})).vm;
  assert.equal(failed.card.rows.find((r) => r.label === WORDS.ship.label.commit).value, "Summary");
  assert.match(failed.card.rows.find((r) => r.label === WORDS.ship.label.commitDraft).value, /下書きに失敗しました（no runner）/);
  // this card has no field to write or fix a message in, so neither row invites one
  const noEdit = /自分で書|直して/;
  assert.doesNotMatch(vm.card.rows.find((r) => r.label === "理由").value, noEdit);
  assert.doesNotMatch(failed.card.rows.find((r) => r.label === WORDS.ship.label.commitDraft).value, noEdit);
});

test("the line on the commit message's form is judged again on the message penne has, by the declared form", async () => {
  const convention = { types: ["feat", "fix", "docs", "chore"], scope: false, source: "CONTRIBUTING.md の Commit message" };
  const item = {
    ...shipNewPr,
    commitConvention: { convention, precedents: ["chore(idd): x", "feat: y"] },
    checks: [...shipNewPr.checks, { label: "commit message が規約に沿う", ok: true, reason: "server", key: "commit-convention" }],
  };
  const line = (vm) => vm.card.checks.find((c) => c.reason !== undefined);
  const drafted = line((await frontModel([{ ...item, commit: { draft: "feat: change the app" } }], {})).vm);
  assert.equal(drafted.ok, true);
  assert.match(drafted.reason, /直近の公開 commit 2 件のうち 1 件は宣言の形に沿っていません/);
  const bad = line((await frontModel([{ ...item, commit: { draft: "Summary" } }], {})).vm);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /1 行目「Summary」/);
  const html = render(h(cards.SubmitCard, { card: (await frontModel([{ ...item, commit: { draft: "Summary" } }], {})).vm.card, on: NOOP }));
  assert.match(html, /data-card-check-reasons/);
  assert.match(html, /CONTRIBUTING\.md の Commit message/);
  // a repo with no declaration has no such line at all
  const plain = (await frontModel([shipNewPr], {})).vm;
  assert.equal(plain.card.checks.some((c) => c.reason !== undefined), false);
  assert.doesNotMatch(render(h(cards.SubmitCard, { card: plain.card, on: NOOP })), /data-card-check-reasons/);
});

test("a check run again says when it ran and whether the result moved, even when it did not", async () => {
  const at = "2026-10-26T01:02:03Z";
  const same = { ...shipNewPr, proposal: { ...shipNewPr.proposal, checkedAt: at, sinceLast: { at: "2026-10-26T00:50:00Z", changed: false, changes: [] } } };
  const row = (vm) => vm.card.rows.find((r) => r.label === WORDS.ship.checked)?.value;
  const unchanged = row((await frontModel([same], {})).vm);
  assert.match(unchanged, /\d\d\/\d\d \d\d:\d\d に検査しました。前回（\d\d\/\d\d \d\d:\d\d）から結果は変わっていません/);
  const moved = row((await frontModel([{ ...same, proposal: { ...same.proposal, sinceLast: { at: "2026-10-26T00:50:00Z", changed: true, changes: ["e2e: fail → pass"] } } }], {})).vm);
  assert.match(moved, /から変わりました: e2e: fail → pass/);
  const first = row((await frontModel([{ ...same, proposal: { ...same.proposal, sinceLast: undefined } }], {})).vm);
  assert.match(first, /最初の検査です/);
  // a record that predates the time, and a card never checked, say nothing about it
  assert.equal(row((await frontModel([shipNewPr], {})).vm), undefined);
  assert.equal(row((await frontModel([shipNoCheck], {})).vm), undefined);
});

test("a landing card says when its checks ran and whether the result moved, and a landing from before the time says nothing", async () => {
  const row = (vm) => vm.card.rows.find((r) => r.label === WORDS.ship.checked)?.value;
  const at = "2026-10-26T01:02:03Z";
  const checked = { ...shipLand, land: { ...shipLand.land, checkedAt: at, sinceLast: { at: "2026-10-26T00:50:00Z", changed: false, changes: [] } } };
  assert.match(row((await frontModel([checked], {})).vm), /に検査しました。前回（\d\d\/\d\d \d\d:\d\d）から結果は変わっていません/);
  const moved = { ...checked, land: { ...checked.land, sinceLast: { at: "2026-10-26T00:50:00Z", changed: true, changes: ["test: fail → pass"] } } };
  assert.match(row((await frontModel([moved], {})).vm), /から変わりました: test: fail → pass/);
  assert.match(row((await frontModel([{ ...checked, land: { ...checked.land, sinceLast: undefined } }], {})).vm), /最初の検査です/);
  assert.equal(row((await frontModel([shipLand], {})).vm), undefined);
  // what the card may do is the record's own: the time and the comparison do not move the approval
  const before = (await frontModel([shipLand], {})).vm, after = (await frontModel([checked], {})).vm;
  assert.equal(after.actions.right[0].disabled, before.actions.right[0].disabled);
  assert.equal(after.actions.right[0].label, before.actions.right[0].label);
});

/* ---- the GO card's six fields: laid out in order from what the engine returned ---- */

const goText = {
  decide: "ZZZ_DECIDE？",
  recommend: { text: "ZZZ_RECOMMEND", basis: "記録", selfReported: false },
  outcomes: [
    { option: "GO", changes: "ZZZ_CHANGES_GO", reaches: "ZZZ_REACHES", reversible: "手間はかかるが戻せる" },
    { option: "計画を直させる", changes: "ZZZ_CHANGES_REVISE", reaches: "ZZZ_REACHES", reversible: "戻せる" },
  ],
  facts: [
    { text: "ZZZ_FACT_RECORD", source: "この lane の依頼", selfReported: false },
    { text: "ZZZ_FACT_SELF", source: "計画役の要約", selfReported: true },
  ],
  settled: [{ text: "ZZZ_SETTLED", source: "計画の査読の結果" }],
  links: [{ label: "計画", path: "_docs/plan/Demo/zzz/plan.md" }, { label: "ZZZ_ISSUE", path: "https://example.test/issues/1" }],
  by: "translated",
};

const goCardHtml = (vm) => render(h(cards.GoCard, { card: vm.card, on: NOOP }));
const goVm = async (item, ...rest) => (await frontModel([item], ...rest)).vm;
const markCount = (html) => (html.match(new RegExp(`>${WORDS.go.selfReported}<`, "g")) ?? []).length;
const blockedByOne = { items: [{ ref: "#120", title: "ZZZ_BLOCKER", state: "open" }] };

test("AC-001: the GO card shows the six fields in order, from the engine's words alone", async () => {
  const vm = await goVm({ ...goItem, text: goText }, {});
  assert.deepEqual(vm.card.fields.map((f) => f.key), ["decide", "recommend", "outcomes", "facts", "settled", "links"]);
  assert.deepEqual(vm.card.fields.map((f) => f.heading), [WORDS.go.fields.decide, WORDS.go.fields.recommend, WORDS.go.fields.outcomes, WORDS.go.fields.facts, WORDS.go.fields.settled, WORDS.go.fields.links]);
  assert.ok(vm.card.fields.every((f) => f.lines.length > 0 && f.lines.every((l) => l.text.trim())));
  assert.equal(vm.card.ask, "ZZZ_DECIDE？");
  const html = goCardHtml(vm);
  const order = ["ZZZ_DECIDE", "ZZZ_RECOMMEND", "ZZZ_CHANGES_GO", "ZZZ_FACT_RECORD", "ZZZ_SETTLED", "example.test"].map((w) => html.indexOf(w));
  assert.ok(order.every((n) => n >= 0), `every field is printed: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "from the top: the question first, the links last");
  // the reach and reversibility are the engine's words, and the card names them
  assert.match(html, /及ぶ範囲: ZZZ_REACHES/);
  assert.match(html, /後から戻せるか: 戻せる/);
});

const goWithRisk = { ...goItem, riskTable: [{ label: "ZZZ_RISK_LABEL", reason: "ZZZ_RISK_REASON" }], depth: "standard", notAuto: "ZZZ_NOT_AUTO", text: goText };

test("AC-006: beside the six fields the summary and the risk table wear the mark; the engine's own rows do not", async () => {
  const vm = await goVm(goWithRisk, {});
  const byLabel = (l) => vm.card.rows.find((r) => r.label === l);
  assert.equal(vm.card.rows.find((r) => r.value === "ZZZ_SITUATION").selfReported, true);
  assert.equal(byLabel(`${WORDS.go.risk} · ZZZ_RISK_LABEL`).selfReported, true);
  assert.equal(byLabel(WORDS.go.depth).selfReported, undefined);
  assert.equal(byLabel(WORDS.go.notAuto).selfReported, undefined);
  const html = goCardHtml(vm);
  assert.match(html, /ZZZ_SITUATION/);
  // the facts' self-reported line plus the summary's three rows and the risk row
  assert.equal(markCount(html), 1 + 3 + 1);
});

test("AC-001: a translated GO card keeps its Risk row, and the panel carries the Risk section", async () => {
  const vm = await goVm(goWithRisk, {});
  assert.ok(vm.card.rows.some((r) => r.label === `${WORDS.go.risk} · ZZZ_RISK_LABEL` && r.value === "ZZZ_RISK_REASON"));
  assert.match(goCardHtml(vm), /ZZZ_RISK_REASON/);
  const risk = vm.panel.sections.find((s) => s.heading === WORDS.go.risk);
  assert.ok(risk, "the panel has a Risk section");
  assert.deepEqual(risk.rows, [{ label: "ZZZ_RISK_LABEL", value: "ZZZ_RISK_REASON" }]);
  assert.equal(risk.tab, vm.panel.sections.find((s) => s.rows.some((r) => r.value === "ZZZ_SITUATION")).tab);
  const none = await goVm({ ...goItem, text: goText }, {});
  assert.ok(!none.panel.sections.some((s) => s.heading === WORDS.go.risk));
});

test("AC-001: the wait stays the first row and the Risk row follows it", async () => {
  const vm = await goVm({ ...goWithRisk, blockedBy: blockedByOne }, {});
  assert.equal(vm.card.rows[0].label, WORDS.go.waitingFor);
  assert.equal(vm.card.ask, "ZZZ_DECIDE？");
  const riskAt = vm.card.rows.findIndex((r) => r.label.startsWith(WORDS.go.risk));
  assert.ok(riskAt > 0);
});

test("AC-006: words that rest on an agent's own account wear the mark; the records' words do not", async () => {
  const vm = await goVm({ ...goItem, text: goText }, {});
  const lines = vm.card.fields.find((f) => f.key === "facts").lines;
  assert.deepEqual(lines.map((l) => l.selfReported), [false, true]);
  const html = goCardHtml(vm);
  // the facts' one line, and the planner's three summary rows under the question
  assert.equal(markCount(html), 1 + 3);
  const selfAt = html.indexOf("ZZZ_FACT_SELF");
  const markAt = html.lastIndexOf(WORDS.go.selfReported, selfAt);
  const recordAt = html.indexOf("ZZZ_FACT_RECORD");
  assert.ok(markAt > recordAt && markAt < selfAt, "the mark sits on the self-reported line only");
});

test("AC-003: the raw fields are drawn in the same six places and say they are raw", async () => {
  const vm = await goVm({ ...goItem, text: { ...goText, by: "raw" } }, {});
  assert.equal(vm.card.fields.length, 6);
  assert.equal(vm.card.fieldsRaw, true);
  assert.match(goCardHtml(vm), /記録の材料からそのまま組んだ/);
  const translated = await goVm({ ...goItem, text: goText }, {});
  assert.equal(translated.card.fieldsRaw, false);
});

test("AC-001: a GO card that waits on a landing shows the wait and the question, with all six fields", async () => {
  const vm = await goVm({ ...goItem, text: goText, blockedBy: blockedByOne }, {});
  assert.equal(vm.card.ask, "ZZZ_DECIDE？");
  assert.equal(vm.card.waiting, WORDS.go.waitingAsk(["#120"]));
  assert.deepEqual(vm.card.fields.map((f) => f.key), ["decide", "recommend", "outcomes", "facts", "settled", "links"]);
  const html = goCardHtml(vm);
  assert.ok(html.includes("#120 の着地を待っています"), "the wait is printed");
  assert.ok(html.includes("ZZZ_DECIDE"), "the question is printed too");
  const free = await goVm({ ...goItem, text: goText }, {});
  assert.equal(free.card.waiting, undefined);
});

test("AC-001: a GO card from an engine that sends no fields keeps the rows it had", async () => {
  const vm = await goVm(goItem, {});
  assert.equal(vm.card.fields, undefined);
  assert.ok(vm.card.rows.some((r) => r.value === "ZZZ_SITUATION"));
  assert.ok(vm.card.rows.every((r) => r.selfReported === undefined), "no mark where there are no fields");
});

/* ---- a GO the engine takes only with a reason ---- */

const needsReasonItem = { ...goItem, planReview: { state: "reviewed", must: 1, should: 0, nit: 0, findings: [{ severity: "must", claim: "ZZZ_MUST", path: "plan.md" }], needsReason: true } };
const reasonDrafts = (text, items = [needsReasonItem]) => setGoReason(applyDrafts(emptyDrafts(), items), "#902", text);
const OWED = /GO には通す理由が要ります/;

test("a GO that needs a reason says so on the card, and one that needs none does not", async () => {
  const needs = await goVm(needsReasonItem, {});
  const plain = await goVm(goItem, {});
  assert.deepEqual([needs.card.reasonNeeded, plain.card.reasonNeeded, plain.card.reason], [WORDS.go.needsReason, undefined, undefined]);
  assert.deepEqual([OWED.test(goCardHtml(needs)), OWED.test(goCardHtml(plain))], [true, false]);
});

test("a GO over a review that cannot be asked again says so and lists the must it left", async () => {
  const round = { state: "reviewed", must: 1, should: 0, nit: 0, findings: [{ severity: "must", claim: "ZZZ_LEFT_MUST", path: "plan.md" }, { severity: "should", claim: "ZZZ_SHOULD", path: "" }] };
  const skippedItem = {
    ...goItem,
    planReview: { state: "skipped", must: 0, should: 0, nit: 0, findings: [], note: "r", rounds: [round, { state: "skipped", must: 0, should: 0, nit: 0, findings: [] }], needsReason: true },
  };
  const skipped = await goVm(skippedItem, {});
  assert.equal(skipped.card.reasonNeeded, WORDS.go.needsReasonSkipped);
  assert.deepEqual(skipped.card.rows.filter((r) => r.label === WORDS.go.mustLeft), [{ label: WORDS.go.mustLeft, value: "ZZZ_LEFT_MUST（plan.md）" }]);
  const html = goCardHtml(skipped);
  assert.match(html, /再査読を起こせません/);
  assert.match(html, /ZZZ_LEFT_MUST/);
  assert.doesNotMatch(html, /ZZZ_SHOULD/);
  // the reason line is the same one a reviewed card carries
  assert.equal(skipped.card.reason.open, false);
  // a reviewed card keeps its own words and lists no must
  const reviewed = await goVm(needsReasonItem, {});
  assert.deepEqual([reviewed.card.reasonNeeded, reviewed.card.rows.some((r) => r.label === WORDS.go.mustLeft)], [WORDS.go.needsReason, false]);
});

test("the reason line shows the reason written for this lane once it is open", async () => {
  const closed = await goVm(needsReasonItem, {});
  assert.equal(closed.card.reason.open, false);
  assert.doesNotMatch(goCardHtml(closed), /data-reason-input/);
  const open = await goVm(needsReasonItem, { reasonOpen: true, drafts: reasonDrafts("書いた理由") });
  assert.deepEqual(open.card.reason, { open: true, value: "書いた理由", placeholder: WORDS.card.note.goReasonPlaceholder });
  assert.match(goCardHtml(open), /data-reason-input[^>]*value="書いた理由"/);
  // once the line is open the card no longer says → opens it: it says Enter sends the GO with the reason
  assert.equal(open.card.reasonNeeded, WORDS.go.needsReasonOpen);
  assert.match(open.card.reasonNeeded, /Enter/);
  assert.doesNotMatch(open.card.reasonNeeded, /→/);
  assert.match(closed.card.reasonNeeded, /→ で理由の欄を開く/);
  const skippedOpen = await goVm({ ...needsReasonItem, planReview: { ...needsReasonItem.planReview, state: "skipped" } }, { reasonOpen: true });
  assert.equal(skippedOpen.card.reasonNeeded, WORDS.go.needsReasonSkippedOpen);
});

test("a GO the engine holds opens no reason line even when the line was open, and says why it cannot be pressed", async () => {
  const held = { ...needsReasonItem, blockedBy: { reason: "ZZZ_BLOCKER", items: [{ ref: "#7", title: "t", url: "u", state: "open" }] } };
  const vm = await goVm(held, { reasonOpen: true, drafts: reasonDrafts("書いた理由") });
  assert.deepEqual([vm.card.reason, vm.card.reasonNeeded], [undefined, undefined]);
  assert.doesNotMatch(goCardHtml(vm), /data-reason-input/);
  // the card says why the GO is held, in the engine's words, and the GO button promises no key
  assert.equal(vm.card.heldReason, "ZZZ_BLOCKER");
  assert.match(goCardHtml(vm), /data-held-reason/);
  assert.ok(!vm.actions.right[0].key, "no key is promised for a held GO");
  assert.equal(vm.actions.right[0].disabled, true);
});

test("the reason written survives a read of the state, and the → after it sends the same reason", async () => {
  const written = "査読の must は別 lane で扱う";
  // the engine's state is read again: the same card arrives, and the reason is still there
  const drafts = applyDrafts(reasonDrafts(written), [{ ...needsReasonItem, title: "ZZZ_READ_AGAIN" }]);
  const after = await frontModel([needsReasonItem], { reasonOpen: true, drafts });
  after.vm.actions.right[0].go();
  assert.deepEqual([after.vm.card.reason.value, after.seen], [written, [{ kind: "go_go", reason: written }]]);
  // the card is gone: the reason goes with it
  assert.deepEqual(applyDrafts(drafts, []).goReasons, {});
});

test("the first → on a GO that needs a reason opens the line, and an empty line leaves the → unpressable", async () => {
  const closed = await frontModel([needsReasonItem], {});
  closed.vm.actions.right[0].go();
  const empty = await frontModel([needsReasonItem], { reasonOpen: true });
  assert.deepEqual([closed.seen, empty.vm.actions.right[0].disabled], [[{ kind: "reason_open" }], true]);
});

test("a GO that needs a reason reaches the engine as an s1_go that carries the reason", async () => {
  const { store, engine } = await readStore([needsReasonItem]);
  const decision = store.decide({ kind: "go_go", reason: "別 lane で扱う" }, needsReasonItem);
  await settle();
  assert.deepEqual([engine.last().path, engine.last().body], ["/api/idd/decide", { action: "s1_go", payload: { iddId: "#902", reason: "別 lane で扱う" } }]);
  engine.last().respond(400, { ok: false, error: "ZZZ_REFUSED" });
  await decision;
});

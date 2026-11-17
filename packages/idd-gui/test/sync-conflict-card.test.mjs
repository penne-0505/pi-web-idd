import assert from "node:assert/strict";
import test from "node:test";
import { answered, h, load, NOOP, readInbox, render, ui } from "./helpers.mjs";

const { inboxVals, cardKindOf } = await load("./src/inbox/viewmodel.ts");
const { cardActions, EMPTY_CONTEXT, screenCardActions } = await load("./src/inbox/keymap.ts");
const { requestFor } = await load("./src/inbox/requests.ts");
const { itemKey } = await load("./src/inbox/deck.ts");
const cards = await load("./src/components/inbox/InboxCards.tsx");
const { InboxPanel } = await load("./src/components/panels/InboxPanel.tsx");

const NOW = Date.parse("2026-10-28T12:00:00Z");

const conflict = answered({
  kind: "sync_conflict",
  repo: "me/app",
  conflictId: "CF-0123456789ab",
  unit: "project_body",
  subject: "PRJ-1",
  label: "PRJ-1 の本文",
  external: "ZZZ_EXTERNAL",
  base: "ZZZ_BASE",
  propter: "ZZZ_PROPTER",
  appearedAt: "2026-10-28T11:30:00Z",
});

const VALUES = ["ZZZ_EXTERNAL", "ZZZ_BASE", "ZZZ_PROPTER"];
const showsAll = (out, values) => { for (const v of values) assert.match(out, new RegExp(v)); };
/** the slots of the conflict card that carry a button, by the keymap's own listing `actions` */
const pressed = (actions) => actions(conflict, EMPTY_CONTEXT).filter((s) => s.buttons.length > 0);
const front = async (...items) => inboxVals(ui(), await readInbox(items, {}, NOW), NOOP);

test("a conflict is a card the screen can handle, tied to no lane", () => {
  assert.equal(cardKindOf(conflict), "sync_conflict");
  assert.equal(itemKey(conflict), "sync_conflict:CF-0123456789ab");
});

test("a conflict card shows the outside's value, the value both last agreed on and propter's, and offers only 'later'", async () => {
  const vm = await front(conflict);
  assert.equal(vm.card.cardKind, "sync_conflict");
  assert.deepEqual(vm.card.rows.map((r) => [r.label, r.value]), [
    [WORDS_LABELS().external, "ZZZ_EXTERNAL"], [WORDS_LABELS().base, "ZZZ_BASE"], [WORDS_LABELS().propter, "ZZZ_PROPTER"],
  ]);
  showsAll(render(h(cards.SyncConflictCard, { card: vm.card })), [...VALUES, "PRJ-1 の本文"]);
  showsAll(render(h(InboxPanel, { panel: vm.panel })), VALUES);

  assert.deepEqual(pressed(screenCardActions).map((s) => s.position), ["later"]);
  assert.deepEqual(pressed(cardActions).map((s) => s.buttons[0].intent), [{ kind: "later" }]);
  // the only request it can send is the snooze: nothing is asked for a signature and nothing is written outside
  assert.deepEqual(requestFor({ kind: "later" }, conflict), { method: "POST", path: "/api/idd/snooze", body: { key: "sync_conflict:CF-0123456789ab" }, signature: "none" });
});

test("an empty value is shown as empty, not left blank", async () => {
  const vm = await front(answered({ ...conflict, base: "" }));
  assert.equal(vm.card.rows[1].value, "（空）");
});

test("a conflict behind the front is told apart in the sidebar by its repo and subject", async () => {
  const first = answered({ ...conflict, conflictId: "CF-aaaaaaaaaaaa", subject: "PRJ-9", label: "PRJ-9 の本文" });
  const vm = await front(first, conflict);
  const [row] = vm.sidebar.next;
  assert.equal(row.num, "PRJ-1");
  assert.notEqual(row.num, "sync_conflict");
  assert.match(row.title, /me\/app/);
  assert.match(row.title, /PRJ-1 の本文/);
});

function WORDS_LABELS() {
  return { external: "外の今", base: "前回一致した値", propter: "propter の今" };
}

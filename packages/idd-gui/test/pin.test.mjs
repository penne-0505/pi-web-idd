/**
 * The PIN as the screen's second way to sign one card: the settings section's PIN row (set, change, clear, all on a
 * registered key's signature), the confirm stage's PIN field, and the Inbox hearing about a key or a PIN the sheet
 * got the engine to accept. The tests drive the same stores the screen drives, with a fetch stand-in and a stand-in
 * for the browser's credential store, and render the components to static markup. What must hold: the PIN is never
 * in a request or left in the screen's state, the next card asks for it again, and one signature-asking operation
 * of the sheet runs at a time.
 */
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, pbkdf2Sync, verify } from "node:crypto";
import test from "node:test";
import { fakeFetch, settle, snapshot } from "./fake.mjs";
import { h, load, render } from "./helpers.mjs";
import { shipNewPr } from "./fixtures/items.mjs";

const { InboxStore } = await load("./src/inbox/useDecide.ts");
const { SettingsStore } = await load("./src/settings/store.ts");
const { settingsVals } = await load("./src/settings/viewmodel.ts");
const { SettingsPasskeys } = await load("./src/components/settings/SettingsPasskeys.tsx");
const { inboxVals } = await load("./src/inbox/viewmodel.ts");
const { InboxView } = await load("./src/components/InboxView.tsx");
const { emptyDrafts } = await load("./src/inbox/drafts.ts");
const { intentForKey, EMPTY_CONTEXT } = await load("./src/inbox/keymap.ts");
const { buildShipApproval, shipDraftFor } = await load("./src/inbox/approval.ts");

const NOW = Date.parse("2026-10-18T12:00:00Z");
const PIN = "123456";
const PIN_PATH = "/api/idd/passkey/pin";
const REGISTER = "/api/idd/passkey/register";
const PENDING = "/api/idd/passkey/pending";
const CHALLENGE = "/api/idd/passkey/challenge";
const DECIDE = "/api/idd/decide";
const ITERATIONS = 1_000;
const SALT = "c2FsdHNhbHRzYWx0c2E";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const noop = () => {};
const UI = { spaceOpen: null, spaceDraft: null, spaceTouched: [], spaceMode: null, newOpen: false, newDraft: { id: "", name: "", memory: "none", references: "", instruction: "" }, newTouched: [] };
const NOOP = {
  focus: noop, note: noop, openNote: noop, closeNote: noop, select: noop, setTab: noop, setQuestion: noop,
  shipField: noop, outboundField: noop, outboundReply: noop, goName: noop, wake: noop, unignore: noop,
  retry: noop, clearReceipt: noop, dispatch: noop, openSettingsKey: noop, approvePin: noop,
};
const ui = (over = {}) => ({ noteOpen: false, askOpen: false, note: "", selection: null, question: 0, confirm: null, drafts: emptyDrafts(), tab: null, ...over });

function fakeCredentials(answer = { toJSON: () => ({ id: "signed", response: {} }) }) {
  const calls = { get: [], create: [] };
  return {
    calls,
    credentials: {
      async get(options) {
        calls.get.push(options);
        return answer;
      },
      async create(options) {
        calls.create.push(options);
        return { toJSON: () => ({ id: "created" }) };
      },
    },
  };
}

/** a fetch stand-in that marks the calls a test has answered, so a flow can answer only the new ones */
function settledFetch() {
  const engine = fakeFetch();
  const push = engine.calls.push.bind(engine.calls);
  engine.calls.push = (call) => {
    const respond = call.respond;
    call.respond = (...args) => {
      call.settled = true;
      return respond(...args);
    };
    return push(call);
  };
  return engine;
}

const pinAnswer = (over = {}) => ({ ok: true, configured: true, digits: 6, salt: SALT, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS }, lockedUntil: null, ...over });
const endOf = (engine) => engine.calls[engine.calls.length - 1];
/** wait until the flow's newest request is the one named (a path, or a path and a test of its body) */
const waitFor = async (engine, path, match = null) => {
  const hit = (call) => call?.path === path && (!match || match(call));
  for (let i = 0; i < 300 && !hit(endOf(engine)); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hit(endOf(engine)), true, `the ${path} request is made`);
};
const stepIs = (step) => (call) => call.body?.step === step;
const noBody = (call) => call.body === null;
const allText = (engine) => JSON.stringify(engine.calls.map((call) => ({ path: call.path, body: call.body })));
/** answer every call the flow has parked and the test has not answered yet */
async function answerRest(engine) {
  await settle();
  for (const call of engine.calls) {
    if (call.settled) continue;
    if (call.path === PENDING) call.respond(200, { ok: true, pending: [] });
    else if (call.path === `${REGISTER}?rpId=localhost`) call.respond(200, { ok: true, rpId: "localhost", registered: [] });
    else if (call.path === PIN_PATH) call.respond(200, pinAnswer({ configured: false, salt: undefined }));
  }
}

function settingsStore(engine, credentials) {
  const store = new SettingsStore(engine.fetchFn, { hostname: "localhost", credentials });
  const handlers = {
    toggleSkill: noop, setWebSearch: noop, setMcp: noop, chooseMode: noop, openSpace: noop, openNewSpace: noop,
    closeSpace: noop, setSpaceField: noop, saveSpace: noop, readStorage: noop,
    registerPasskey: () => void store.registerPasskey(),
    approvePending: (id) => void store.approvePending(id),
    setPin: (pin) => void store.setPin(pin),
    disablePin: () => void store.disablePin(),
  };
  return { store, handlers };
}

function section(store, handlers) {
  const view = settingsVals(store.state, UI, handlers);
  return render(h(SettingsPasskeys, { m: { secKey: true, set: view } }));
}

/** answer the three reads the passkeys section makes: the keys, the pending list and the PIN */
async function readSection(engine, store, pinBody = pinAnswer({ configured: false, salt: undefined })) {
  const keys = store.readPasskeys();
  const pin = store.readPin();
  await settle();
  engine.of(`${REGISTER}?rpId=localhost`).at(-1).respond(200, { ok: true, rpId: "localhost", registered: [{ id: "k1", name: "ENGINE_KEY", createdAt: "2026-10-18T10:00:00.000Z" }] });
  engine.of(PENDING).at(-1).respond(200, { ok: true, pending: [] });
  engine.of(PIN_PATH).at(-1).respond(200, pinBody);
  await Promise.all([keys, pin]);
}

// ---- the settings section: the PIN row beside the keys ----

test("the section shows the PIN beside the keys, unset at first, and offers setting it", async () => {
  const engine = settledFetch();
  const { store, handlers } = settingsStore(engine, fakeCredentials().credentials);
  await readSection(engine, store);
  const html = section(store, handlers);
  assert.match(html, /data-settings-pin/);
  assert.match(html, /未設定/);
  assert.match(html, /PIN を設定/);
  assert.doesNotMatch(html, /無効化/, "nothing to clear yet");
});

test("setting a PIN signs with a registered key, sends only the public half, and reaches the Inbox without a reload", async () => {
  const engine = settledFetch();
  const creds = fakeCredentials();
  const { store, handlers } = settingsStore(engine, creds.credentials);
  await readSection(engine, store);
  const before = store.state.passkeysRevision;

  const done = store.setPin(PIN);
  // the PIN's material is read first (to learn the strength), then the challenge is asked for
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer({ configured: false, salt: undefined }));
  await waitFor(engine, PIN_PATH, stepIs("options"));
  assert.equal(endOf(engine).body.step, "options");
  assert.equal(endOf(engine).body.op, "set");
  // the engine is asked for a challenge over the key the PIN derives: the PIN itself is not in the request
  assert.equal(typeof endOf(engine).body.publicKey, "string");
  assert.equal(endOf(engine).body.iterations, ITERATIONS);
  assert.doesNotMatch(allText(engine), new RegExp(PIN));
  endOf(engine).respond(200, { ok: true, nonce: "n1", challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await waitFor(engine, PIN_PATH, stepIs("finish"));
  assert.equal(creds.calls.get.length, 1, "the registered passkey signs the PIN operation");
  assert.equal(endOf(engine).body.step, "finish");
  assert.equal(endOf(engine).body.op, "set");
  assert.equal(endOf(engine).body.nonce, "n1");
  assert.doesNotMatch(allText(engine), new RegExp(PIN));
  endOf(engine).respond(200, { ok: true, configured: true });
  // the PIN is read again after the engine accepted it
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer());
  await done;

  assert.equal(store.state.passkeys.pin.configured, true);
  assert.equal(store.state.passkeys.result.kind, "pin-set");
  assert.equal(store.state.passkeysRevision, before + 1, "the Inbox is told the means changed (AC-006)");
  assert.doesNotMatch(JSON.stringify(store.state), new RegExp(PIN), "the PIN is not kept in the store");
  const html = section(store, handlers);
  assert.match(html, /設定済み/);
  assert.match(html, /PIN を変更/);
  assert.match(html, /無効化/);
});

test("the PIN row shows a stopped PIN as its reason, and a broken record is never 'unset'", async () => {
  const engine = settledFetch();
  const { store, handlers } = settingsStore(engine, fakeCredentials().credentials);
  await readSection(engine, store, pinAnswer({ lockedUntil: "2026-10-18T12:05:00.000Z" }));
  const html = section(store, handlers);
  assert.match(html, /止まっています/);
  assert.match(html, /2026-10-18 12:05/);

  const broken = settledFetch();
  const second = settingsStore(broken, fakeCredentials().credentials);
  const keys = second.store.readPasskeys();
  const pin = second.store.readPin();
  await settle();
  broken.of(`${REGISTER}?rpId=localhost`).at(-1).respond(200, { ok: true, rpId: "localhost", registered: [] });
  broken.of(PENDING).at(-1).respond(200, { ok: true, pending: [] });
  broken.of(PIN_PATH).at(-1).respond(500, { ok: false, error: "state を読めません" });
  await Promise.all([keys, pin]);
  const error = section(second.store, second.handlers);
  assert.match(error, /PIN の記録を読めません/);
  assert.match(error, /state を読めません/);
  assert.doesNotMatch(error, /未設定/);
});

test("disabling the PIN also needs the registered key's signature", async () => {
  const engine = settledFetch();
  const creds = fakeCredentials();
  const { store } = settingsStore(engine, creds.credentials);
  await readSection(engine, store, pinAnswer());
  const done = store.disablePin();
  await waitFor(engine, PIN_PATH, stepIs("options"));
  assert.equal(endOf(engine).body.op, "disable");
  endOf(engine).respond(200, { ok: true, nonce: "n2", challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await waitFor(engine, PIN_PATH, stepIs("finish"));
  assert.equal(endOf(engine).body.step, "finish");
  assert.equal(creds.calls.get.length, 1);
  endOf(engine).respond(200, { ok: true, configured: false });
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer({ configured: false, salt: undefined }));
  await done;
  assert.equal(store.state.passkeys.pin.configured, false);
  assert.equal(store.state.passkeys.result.kind, "pin-cleared");
});

test("one signature-asking operation of the sheet runs at a time, decided by the store and not the screen", async () => {
  const engine = settledFetch();
  const { store } = settingsStore(engine, fakeCredentials().credentials);
  await readSection(engine, store, pinAnswer());
  const registering = store.registerPasskey();
  await settle();
  // the registration has started: a PIN operation and a pending approval are both refused, and ask the engine nothing
  const before = engine.calls.length;
  assert.equal(await store.setPin(PIN), false);
  assert.equal(await store.disablePin(), false);
  assert.equal(await store.approvePending("p1"), false);
  assert.equal(engine.calls.length, before, "nothing reached the engine");
  // finish the registration so the test leaves nothing pending
  endOf(engine).respond(200, { ok: true, nonce: "r1", options: { challenge: "Y2hhbGxlbmdl", user: { id: "dXNlcg" } } });
  await waitFor(engine, REGISTER, stepIs("finish"));
  endOf(engine).respond(200, { ok: true });
  await answerRest(engine);
  await registering;
  assert.equal(store.state.passkeys.registering, false);
});

test("a PIN the engine refuses to set is shown as its reason, not as a PIN that was set", async () => {
  const engine = settledFetch();
  const creds = fakeCredentials();
  const { store, handlers } = settingsStore(engine, creds.credentials);
  await readSection(engine, store);
  const before = store.state.passkeysRevision;
  const REASON = "署名した中身が PIN の設定と違います。やり直してください";

  const done = store.setPin(PIN);
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer({ configured: false, salt: undefined }));
  await waitFor(engine, PIN_PATH, stepIs("options"));
  endOf(engine).respond(200, { ok: true, nonce: "n1", challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await waitFor(engine, PIN_PATH, stepIs("finish"));
  assert.equal(creds.calls.get.length, 1, "the registered passkey signed the operation");
  // the signature was made and the engine still refused: the PIN is not set
  endOf(engine).respond(400, { ok: false, error: REASON });
  // the PIN is read again whatever the answer, so the row shows the engine's own value
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer({ configured: false, salt: undefined }));
  assert.equal(await done, false);

  assert.equal(store.state.passkeys.result.kind, "failed", "a refused set is a failure, not a set PIN");
  assert.equal(store.state.passkeys.result.detail, REASON, "the notice carries the engine's reason");
  assert.equal(store.state.passkeys.pin.configured, false, "the row keeps the engine's value, not a PIN");
  assert.equal(store.state.passkeys.pin.setting, false, "the fields close after the press");
  assert.equal(store.state.passkeysRevision, before, "a refusal is not an accepted change (AC-006)");
  const html = section(store, handlers);
  assert.doesNotMatch(html, /PIN を設定しました/, "no success notice for a refusal");
  assert.match(html, new RegExp(REASON), "the reason is on the section");
  assert.match(html, /未設定/);
  assert.doesNotMatch(JSON.stringify(store.state), new RegExp(PIN), "the PIN is not kept in the store");

  // the gate is open again: the next signature-asking press reaches the engine
  const calls = engine.calls.length;
  const clearing = store.disablePin();
  await waitFor(engine, PIN_PATH, stepIs("options"));
  assert.equal(engine.calls.length > calls, true, "the store let the next press through");
  assert.equal(endOf(engine).body.op, "disable");
  endOf(engine).respond(400, { ok: false, error: "署名が取り消されました" });
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer({ configured: false, salt: undefined }));
  assert.equal(await clearing, false);
});

test("a PIN the engine refuses to clear stays set and the section says why", async () => {
  const engine = settledFetch();
  const { store, handlers } = settingsStore(engine, fakeCredentials().credentials);
  await readSection(engine, store, pinAnswer());
  const before = store.state.passkeysRevision;
  const REASON = "署名した中身が無効化と違います。やり直してください";

  const done = store.disablePin();
  await waitFor(engine, PIN_PATH, stepIs("options"));
  assert.equal(endOf(engine).body.op, "disable");
  endOf(engine).respond(200, { ok: true, nonce: "n2", challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await waitFor(engine, PIN_PATH, stepIs("finish"));
  // the engine read the finished operation and refused it: the PIN is still there
  endOf(engine).respond(200, { ok: false, error: REASON });
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer());
  assert.equal(await done, false);

  assert.equal(store.state.passkeys.result.kind, "failed", "a refused clear is a failure, not a cleared PIN");
  assert.equal(store.state.passkeys.result.detail, REASON);
  assert.equal(store.state.passkeys.pin.configured, true, "the PIN the engine still has is what the row shows");
  assert.equal(store.state.passkeysRevision, before, "a refusal is not an accepted change (AC-006)");
  const html = section(store, handlers);
  assert.doesNotMatch(html, /PIN を無効にしました/, "no success notice for a refusal");
  assert.match(html, new RegExp(REASON), "the reason is on the section");
  assert.match(html, /設定済み/);

  // the gate is open again: setting the PIN again reaches the engine
  const calls = engine.calls.length;
  const setting = store.setPin(PIN);
  await waitFor(engine, PIN_PATH, noBody);
  assert.equal(engine.calls.length > calls, true, "the store let the next press through");
  endOf(engine).respond(200, pinAnswer());
  await waitFor(engine, PIN_PATH, stepIs("options"));
  assert.equal(endOf(engine).body.op, "set");
  endOf(engine).respond(400, { ok: false, error: "署名が取り消されました" });
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer());
  assert.equal(await setting, false);
});

// ---- the confirm stage: the PIN signing this one card ----

async function approvingStore(engine) {
  const store = new InboxStore(engine.fetchFn, () => NOW, { credentials: fakeCredentials().credentials, hostname: "localhost" });
  const read = store.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const keys = store.readPasskeys();
  const pin = store.readPin();
  await settle();
  engine.of(`${REGISTER}?rpId=localhost`).at(-1).respond(200, { ok: true, rpId: "localhost", registered: [{ id: "k1", name: "key", createdAt: "" }] });
  engine.of(PIN_PATH).at(-1).respond(200, pinAnswer());
  await Promise.all([keys, pin]);
  return store;
}

test("the confirm stage's PIN signs the card's own challenge and posts no PIN", async () => {
  const engine = settledFetch();
  const store = await approvingStore(engine);
  assert.equal(store.state.sign.pin, true);

  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  assert.equal(intent.kind, "ship_approve");
  const approving = store.approveWithPin(intent, shipNewPr, PIN);
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer());
  await waitFor(engine, CHALLENGE);
  const challenge = endOf(engine).body;
  assert.equal(challenge.action, "s4_verify_clean");
  assert.equal(challenge.rpId, "localhost");
  endOf(engine).respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await waitFor(engine, DECIDE);
  const decided = endOf(engine).body;
  assert.equal(decided.action, "s4_verify_clean");
  // the content the challenge was made over is the one the confirm stage shows, and the PIN is in no request
  const { nonce, pinProof, ...rest } = decided.payload;
  assert.equal(nonce, "n1");
  assert.equal(typeof pinProof.signature, "string");
  assert.equal(decided.payload.assertion, undefined, "a PIN approval carries no passkey assertion");
  assert.deepEqual(rest, challenge.payload);
  assert.doesNotMatch(allText(engine), new RegExp(PIN));

  // the signature is over the challenge with the key the PIN derives: the engine's public half verifies it
  const seed = pbkdf2Sync(PIN, Buffer.from(SALT, "base64url"), ITERATIONS, 32, "sha256");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, spki.subarray(spki.length - 32)]), format: "der", type: "spki" });
  assert.equal(verify(null, Buffer.from("Y2hhbGxlbmdl", "utf8"), publicKey, Buffer.from(pinProof.signature, "base64url")), true);

  endOf(engine).respond(200, { ok: true });
  await settle();
  endOf(engine).respond(200, snapshot([]));
  await approving;
  assert.equal(store.state.snapshot.items.length, 0);
  assert.doesNotMatch(JSON.stringify(store.state), new RegExp(PIN), "the PIN is not kept by the Inbox");
});

test("the confirm stage draws the PIN field only when the engine says a PIN is set, and a new card starts empty", async () => {
  const engine = settledFetch();
  const store = await approvingStore(engine);
  const key = buildShipApproval(shipNewPr, shipDraftFor(shipNewPr)).confirmKey;
  const open = inboxVals(ui({ confirm: key }), store.state, NOOP);
  const html = render(h(InboxView, { m: { inbox: open } }));
  assert.match(html, /data-confirm-pin/);
  assert.match(html, /data-pin-input/);
  // the stage is closed between cards: the field and whatever was typed in it are gone with it (C-182-6)
  const closed = inboxVals(ui({ confirm: null }), store.state, NOOP);
  assert.doesNotMatch(render(h(InboxView, { m: { inbox: closed } })), /data-pin-input/);

  // no PIN set: the stage offers only the passkey
  const noPin = { ...store.state, sign: { ...store.state.sign, pin: false, pinError: null } };
  const withoutPin = inboxVals(ui({ confirm: key }), noPin, NOOP);
  assert.doesNotMatch(render(h(InboxView, { m: { inbox: withoutPin } })), /data-pin-input/);

  // a record that cannot be read is its reason in the stage, never a PIN the screen pretends to have
  const broken = { ...store.state, sign: { ...store.state.sign, pin: null, pinError: "state を読めません" } };
  const unreadable = inboxVals(ui({ confirm: key }), broken, NOOP);
  const shown = render(h(InboxView, { m: { inbox: unreadable } }));
  assert.match(shown, /PIN の記録を読めません/);
  assert.match(shown, /state を読めません/);
});

test("a PIN approval of another card's content is refused by the engine and the card stays where it was", async () => {
  const engine = settledFetch();
  const store = await approvingStore(engine);
  const intent = intentForKey(shipNewPr, { key: "ArrowRight" }, { ...EMPTY_CONTEXT, confirmOpen: true });
  const approving = store.approveWithPin(intent, shipNewPr, PIN);
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer());
  await waitFor(engine, CHALLENGE);
  endOf(engine).respond(200, { ok: true, required: true, registered: 1, nonce: "n1", challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await waitFor(engine, DECIDE);
  // the engine's gate refused the approval: nothing left the machine, and the card is still the one to decide
  endOf(engine).respond(400, { ok: false, error: "署名した中身と承認の中身が違います。承認をやり直してください" });
  await approving;
  assert.equal(store.state.hidden.length, 0, "the card was not taken as done");
  assert.match(Object.values(store.state.errors).join(" "), /中身が違います/);
});

test("a key registered and a PIN set in the sheet reach the Inbox without a reload (AC-006)", async () => {
  const engine = settledFetch();
  const inbox = new InboxStore(engine.fetchFn, () => NOW, { credentials: fakeCredentials().credentials, hostname: "localhost" });
  const read = inbox.read();
  engine.calls[0].respond(200, snapshot([shipNewPr]));
  await read;
  const keys = inbox.readPasskeys();
  const pin = inbox.readPin();
  await settle();
  engine.of(`${REGISTER}?rpId=localhost`).at(-1).respond(200, { ok: true, rpId: "localhost", registered: [] });
  engine.of(PIN_PATH).at(-1).respond(200, { ok: true, configured: false, digits: 6, lockedUntil: null });
  await Promise.all([keys, pin]);
  const key = buildShipApproval(shipNewPr, shipDraftFor(shipNewPr)).confirmKey;
  const before = inboxVals(ui({ confirm: key }), inbox.state, NOOP);
  assert.equal(before.needsRegister, true, "no key yet: the primary cannot open the confirm");
  assert.equal(before.actions.right[0].disabled, true, "the card's approval is stopped until a key exists");

  // the sheet registers the first key; the engine accepts it
  const sheet = settingsStore(engine, fakeCredentials().credentials);
  const registering = sheet.store.registerPasskey();
  await waitFor(engine, REGISTER, stepIs("options"));
  endOf(engine).respond(200, { ok: true, nonce: "r1", options: { challenge: "Y2hhbGxlbmdl", user: { id: "dXNlcg" } } });
  await waitFor(engine, REGISTER, stepIs("finish"));
  endOf(engine).respond(200, { ok: true });
  await answerRest(engine);
  await registering;
  assert.equal(sheet.store.state.passkeysRevision, 1);

  // the Inbox follows the revision exactly as the screen's effect does: it reads the means again, no reload
  const rereadKeys = inbox.readPasskeys();
  const rereadPin = inbox.readPin();
  await settle();
  engine.of(`${REGISTER}?rpId=localhost`).at(-1).respond(200, { ok: true, rpId: "localhost", registered: [{ id: "k1", name: "key", createdAt: "" }] });
  engine.of(PIN_PATH).at(-1).respond(200, pinAnswer());
  await Promise.all([rereadKeys, rereadPin]);
  const after = inboxVals(ui({ confirm: key }), inbox.state, NOOP);
  assert.equal(after.needsRegister, false, "the registered key clears the note");
  assert.equal(after.confirming.pin.configured, true, "the confirm stage offers the PIN the sheet set");

  // the sheet turns the PIN off; the Inbox reads again and the confirm stage stops offering it
  const clearing = sheet.store.disablePin();
  await waitFor(engine, PIN_PATH, stepIs("options"));
  endOf(engine).respond(200, { ok: true, nonce: "n9", challenge: "Y2hhbGxlbmdl", rpId: "localhost", allowCredentials: [{ id: "aXY" }] });
  await waitFor(engine, PIN_PATH, stepIs("finish"));
  endOf(engine).respond(200, { ok: true, configured: false });
  await waitFor(engine, PIN_PATH, noBody);
  endOf(engine).respond(200, pinAnswer({ configured: false, salt: undefined }));
  await clearing;
  assert.equal(sheet.store.state.passkeysRevision, 2);
  const finalPin = inbox.readPin();
  await settle();
  engine.of(PIN_PATH).at(-1).respond(200, pinAnswer({ configured: false, salt: undefined }));
  await finalPin;
  const cleared = inboxVals(ui({ confirm: key }), inbox.state, NOOP);
  assert.equal(cleared.confirming.pin.configured, false);
  assert.doesNotMatch(render(h(InboxView, { m: { inbox: cleared } })), /data-pin-input/);
});

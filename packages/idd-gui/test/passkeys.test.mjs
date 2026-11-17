/**
 * The settings sheet's passkeys section: the engine's key list, registering a key (the first one, and another one
 * with a registered key's proof), a tailnet page's registration that waits as pending, and approving that pending
 * key from the local screen. The tests drive the same store the screen drives (`SettingsStore` with a fetch
 * stand-in and a stand-in for the browser's credential store), build the view model the component reads, and
 * render the component to static markup: a row must be the engine's own answer, a list that could not be read must
 * be its reason and never "none registered", and the prototype's sample keys, its remove press and its list of the
 * operations that ask for a signature must not appear.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch, settle } from "./fake.mjs";
import { h, load, render } from "./helpers.mjs";
import { shipNewPr } from "./fixtures/items.mjs";

const { SettingsStore } = await load("./src/settings/store.ts");
const { settingsVals } = await load("./src/settings/viewmodel.ts");
const { SettingsPasskeys } = await load("./src/components/settings/SettingsPasskeys.tsx");
const { passkeysShown } = await load("./src/settings/passkeys.ts");
const { inboxVals } = await load("./src/inbox/viewmodel.ts");
const { InboxStore } = await load("./src/inbox/useDecide.ts");
const { emptyDrafts } = await load("./src/inbox/drafts.ts");
const { WORDS } = await load("./src/strings.ts");

const PENDING = "/api/idd/passkey/pending";
const APPROVE = "/api/idd/passkey/pending/approve";
const REGISTER = "/api/idd/passkey/register";

const UI = { spaceOpen: null, spaceDraft: null, spaceTouched: [], spaceMode: null, newOpen: false, newDraft: { id: "", name: "", memory: "none", references: "", instruction: "" }, newTouched: [] };

const noop = () => {};

/** an authenticator stand-in: what the browser was asked, and what it answers */
function fakeCredentials(answer = {}) {
  const calls = { get: [], create: [] };
  return {
    calls,
    credentials: {
      async create(options) {
        calls.create.push(options);
        return "create" in answer ? answer.create : { toJSON: () => ({ id: "created-key" }) };
      },
      async get(options) {
        calls.get.push(options);
        return "get" in answer ? answer.get : { toJSON: () => ({ id: "signed", response: {} }) };
      },
    },
  };
}

function newStore(engine, credentials, hostname = "localhost") {
  const store = new SettingsStore(engine.fetchFn, { hostname, credentials });
  const handlers = {
    toggleSkill: noop,
    setWebSearch: noop,
    setMcp: noop,
    chooseMode: noop,
    openSpace: noop,
    openNewSpace: noop,
    closeSpace: noop,
    setSpaceField: noop,
    saveSpace: noop,
    readStorage: noop,
    registerPasskey: () => void store.registerPasskey(),
    approvePending: (id) => void store.approvePending(id),
  };
  return { store, handlers };
}

/** the section's own markup, from the state the store holds */
function section(store, handlers) {
  const view = settingsVals(store.state, UI, handlers);
  return render(h(SettingsPasskeys, { m: { secKey: true, set: view } }));
}

/** answer the two list reads the store just asked for: the newest call of each door */
function answerLists(engine, keys, pending) {
  engine.calls.filter((call) => call.path.startsWith(`${REGISTER}?rpId=`)).at(-1).respond(keys.status ?? 200, keys.body);
  engine.of(PENDING).at(-1).respond(pending.status ?? 200, pending.body);
}

/** base64url of a byte string, so a challenge can be compared with what the page hands the browser */
const b64url = (text) => Buffer.from(text).toString("base64url");
const bytes = (buffer) => Buffer.from(new Uint8Array(buffer)).toString();

/* ---- AC-001: the section reads the engine's list every time it shows ---- */

test("F-1: the section shows only while the sheet is open on it, so reopening reads the lists again", () => {
  // shut on the same section: closing and reopening the sheet turns this false and then true again, which is
  // exactly what makes the effect ask the engine a second time without the section itself changing
  assert.equal(passkeysShown(false, "key"), false);
  assert.equal(passkeysShown(true, "key"), true);
  // the sheet is open on another section: the keys and the pending list are not on screen
  assert.equal(passkeysShown(true, "conv"), false);
  assert.equal(passkeysShown(false, "conv"), false);
});

test("AC-001: the section lists exactly the keys the engine returned, each with its date", async () => {
  const engine = fakeFetch();
  const { store, handlers } = newStore(engine, fakeCredentials().credentials);
  const read = store.readPasskeys();
  answerLists(engine, { body: { ok: true, rpId: "localhost", registered: [{ id: "k1", name: "ENGINE_KEY_ONE", createdAt: "2026-10-18T10:41:00.000Z" }] } }, { body: { ok: true, pending: [] } });
  await read;

  const html = section(store, handlers);
  assert.match(html, /ENGINE_KEY_ONE/);
  assert.match(html, /2026-10-18 10:41/);
  // the prototype's sample keys, the press that would remove a key, and the list of operations that sign: gone
  assert.doesNotMatch(html, /MacBook · Touch ID|iPhone · Face ID/);
  assert.doesNotMatch(html, /外す/);
  assert.doesNotMatch(html, /Require signing for/);
  assert.doesNotMatch(html, /署名を求める操作/);
});

test("AC-001: a key list that cannot be read is its reason, not a count and not \"none registered\"", async () => {
  const engine = fakeFetch();
  const { store, handlers } = newStore(engine, fakeCredentials().credentials);
  const read = store.readPasskeys();
  answerLists(engine, { status: 500, body: { ok: false, error: "state を読めません" } }, { body: { ok: true, pending: [] } });
  await read;

  const html = section(store, handlers);
  assert.match(html, /鍵の一覧を読めません/);
  assert.match(html, /state を読めません/);
  assert.doesNotMatch(html, /登録された鍵はありません/);
  assert.doesNotMatch(html, /最初の 1 本/);
});

test("AC-002: the first key of the local screen is registered on its own and joins the list", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials({ create: { toJSON: () => ({ id: "brand-new" }) } });
  const { store, handlers } = newStore(engine, creds.credentials);
  const registering = store.registerPasskey();
  await settle();

  const options = engine.of(REGISTER)[0];
  assert.deepEqual(options.body, { step: "options", rpId: "localhost" });
  options.respond(200, { ok: true, nonce: "n1", options: { challenge: b64url("chal"), rp: { id: "localhost", name: "pi-web" }, user: { id: b64url("user"), name: "penne" } } });
  await settle();

  assert.equal(creds.calls.create.length, 1);
  assert.equal(bytes(creds.calls.create[0].publicKey.challenge), "chal");
  assert.equal(bytes(creds.calls.create[0].publicKey.user.id), "user");
  // the first key is stored without a proof: the engine answers ok, and the section reads the lists again
  engine.of(REGISTER)[1].respond(200, { ok: true, credential: { id: "brand-new", name: "passkey 1", createdAt: "2026-10-18T10:41:00.000Z" }, registered: [] });
  await settle();
  answerLists(engine, { body: { ok: true, rpId: "localhost", registered: [{ id: "brand-new", name: "passkey 1", createdAt: "2026-10-18T10:41:00.000Z" }] } }, { body: { ok: true, pending: [] } });
  await registering;

  assert.equal(creds.calls.get.length, 0);
  const html = section(store, handlers);
  assert.match(html, /passkey 1/);
  assert.match(html, new RegExp(WORDS.settings.passkeys.registered));
});

test("AC-002: another key is registered only after a registered key signed over it", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials({ create: { toJSON: () => ({ id: "second-key" }) } });
  const { store, handlers } = newStore(engine, creds.credentials);
  const registering = store.registerPasskey();
  await settle();

  engine.of(REGISTER)[0].respond(200, { ok: true, nonce: "n1", options: { challenge: b64url("chal"), user: { id: b64url("user") } } });
  await settle();
  engine.of(REGISTER)[1].respond(400, { ok: false, needsProof: true, pending: true, error: "登録済みの passkey で署名してください", proof: { nonce: "p1", challenge: b64url("proof"), rpId: "localhost", allowCredentials: [{ id: b64url("key-one"), type: "public-key" }] } });
  await settle();

  assert.equal(creds.calls.get.length, 1);
  assert.equal(bytes(creds.calls.get[0].publicKey.challenge), "proof");
  assert.equal(creds.calls.get[0].publicKey.rpId, "localhost");
  assert.equal(bytes(creds.calls.get[0].publicKey.allowCredentials[0].id), "key-one");

  engine.of(REGISTER)[2].respond(200, { ok: true, credential: { id: "second-key", name: "passkey 2", createdAt: "2026-10-18T11:00:00.000Z" } });
  await settle();
  answerLists(engine, { body: { ok: true, rpId: "localhost", registered: [{ id: "key-one", name: "passkey 1", createdAt: "2026-10-18T10:41:00.000Z" }, { id: "second-key", name: "passkey 2", createdAt: "2026-10-18T11:00:00.000Z" }] } }, { body: { ok: true, pending: [] } });
  await registering;

  // the proof carries the engine's own nonce and the browser's assertion, and nothing else
  const proof = engine.of(REGISTER)[2].body.proof;
  assert.equal(proof.nonce, "p1");
  assert.equal(proof.assertion.id, "signed");
  const html = section(store, handlers);
  assert.match(html, /passkey 2/);
});

test("AC-002: a cancelled creation or a refused finish is the reason, and never a registered key", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials({ create: null });
  const { store, handlers } = newStore(engine, creds.credentials);
  const cancelled = store.registerPasskey();
  await settle();
  engine.of(REGISTER)[0].respond(200, { ok: true, nonce: "n1", options: { challenge: b64url("chal"), user: { id: b64url("user") } } });
  await settle();
  answerLists(engine, { body: { ok: true, rpId: "localhost", registered: [] } }, { body: { ok: true, pending: [] } });
  await cancelled;

  assert.equal(engine.of(REGISTER).length, 1, "a cancelled creation sends no finish");
  let html = section(store, handlers);
  assert.match(html, /登録が取り消されました/);
  assert.doesNotMatch(html, /passkey 1/);

  // the engine refusing the finish is shown as its reason, and the list is what it says it is
  const refusedEngine = fakeFetch();
  const refused = newStore(refusedEngine, fakeCredentials().credentials);
  const attempting = refused.store.registerPasskey();
  await settle();
  refusedEngine.of(REGISTER)[0].respond(200, { ok: true, nonce: "n2", options: { challenge: b64url("chal"), user: { id: b64url("user") } } });
  await settle();
  refusedEngine.of(REGISTER)[1].respond(400, { ok: false, error: "保留の登録が上限（5 件）に達しています" });
  await settle();
  answerLists(refusedEngine, { body: { ok: true, rpId: "localhost", registered: [] } }, { body: { ok: true, pending: [] } });
  await attempting;

  html = section(refused.store, refused.handlers);
  assert.match(html, /保留の登録が上限/);
  assert.doesNotMatch(html, /passkey 1/);
});

test("AC-003: a key a tailnet page added waits as pending and is not shown as registered", async () => {
  const engine = fakeFetch();
  // this page cannot sign over the new key: the engine names no registered key for the tailnet host
  const creds = fakeCredentials();
  const { store, handlers } = newStore(engine, creds.credentials, "tail1234.ts.net");
  const registering = store.registerPasskey();
  await settle();

  assert.deepEqual(engine.of(REGISTER)[0].body, { step: "options", rpId: "tail1234.ts.net" });
  engine.of(REGISTER)[0].respond(200, { ok: true, nonce: "n1", options: { challenge: b64url("chal"), user: { id: b64url("user") } } });
  await settle();
  engine.of(REGISTER)[1].respond(400, { ok: false, pending: true, needsProof: true, error: "登録済みの passkey で署名してください", proof: { nonce: "p1", challenge: b64url("proof"), rpId: "tail1234.ts.net", allowCredentials: [] } });
  await settle();

  // no browser prompt for a key this page cannot use, and the pending list is the local screen's alone
  assert.equal(creds.calls.get.length, 0);
  answerLists(engine, { body: { ok: true, rpId: "tail1234.ts.net", registered: [{ id: "key-one", name: "passkey 1", createdAt: "2026-10-18T10:41:00.000Z" }] } }, { status: 403, body: { ok: false, error: "保留の一覧は手元の画面からだけ読めます" } });
  await registering;

  const html = section(store, handlers);
  assert.match(html, /passkey 1/, "the registered key stays the engine's list");
  assert.doesNotMatch(html, /passkey 2/);
  assert.match(html, new RegExp(WORDS.settings.passkeys.pendingNotice));
  assert.match(html, /手元の画面で承認/);
  assert.match(html, /保留の一覧を読めません/);
  assert.match(html, /手元の画面からだけ読めます/);
});

test("AC-004: a pending key is shown with its name, its host and its deadline, and approved one at a time", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials();
  const { store, handlers } = newStore(engine, creds.credentials);
  const read = store.readPasskeys();
  answerLists(
    engine,
    { body: { ok: true, rpId: "localhost", registered: [{ id: b64url("key-one"), name: "passkey 1", createdAt: "2026-10-18T10:41:00.000Z" }] } },
    { body: { ok: true, pending: [{ id: "p1", name: "passkey 2", rpId: "tail1234.ts.net", createdAt: "2099-10-18T12:00:00.000Z", expiresAt: "2099-10-18T12:15:00.000Z", challenge: b64url("pending-chal") }] } },
  );
  await read;

  let html = section(store, handlers);
  assert.match(html, /passkey 2/);
  assert.match(html, /tail1234\.ts\.net の鍵/);
  assert.match(html, /期限 2099-10-18 12:15/);
  assert.match(html, /承認/);

  const approving = store.approvePending("p1");
  await settle();
  // the signature is over this row's own challenge, under the approving page's own host
  assert.equal(creds.calls.get.length, 1);
  assert.equal(bytes(creds.calls.get[0].publicKey.challenge), "pending-chal");
  assert.equal(creds.calls.get[0].publicKey.rpId, "localhost");
  // the registered keys are named as candidates: a key the browser cannot offer by discovery can still be chosen
  assert.deepEqual(creds.calls.get[0].publicKey.allowCredentials.map((entry) => Buffer.from(new Uint8Array(entry.id)).toString("base64url")), [b64url("key-one")]);

  const sent = engine.of(APPROVE)[0];
  assert.equal(sent.body.id, "p1");
  assert.equal(sent.body.assertion.id, "signed");
  sent.respond(200, { ok: true, credential: { id: "key-two", name: "passkey 2", createdAt: "2099-10-18T12:10:00.000Z" }, pending: [] });
  await settle();
  answerLists(
    engine,
    { body: { ok: true, rpId: "localhost", registered: [{ id: "key-one", name: "passkey 1", createdAt: "2026-10-18T10:41:00.000Z" }, { id: "key-two", name: "passkey 2", createdAt: "2026-10-18T12:10:00.000Z" }] } },
    { body: { ok: true, pending: [] } },
  );
  await approving;

  html = section(store, handlers);
  assert.match(html, new RegExp(WORDS.settings.passkeys.approved("passkey 2")));
  assert.match(html, /passkey 2/);
  assert.match(html, new RegExp(WORDS.settings.passkeys.pendingEmptyNote));
});

test("AC-004: a pending that expired or left the list is never signed", async () => {
  const engine = fakeFetch();
  const creds = fakeCredentials();
  const { store, handlers } = newStore(engine, creds.credentials);
  const read = store.readPasskeys();
  answerLists(
    engine,
    { body: { ok: true, rpId: "localhost", registered: [] } },
    { body: { ok: true, pending: [{ id: "p1", name: "passkey 2", rpId: "tail1234.ts.net", createdAt: "2020-01-01T09:00:00.000Z", expiresAt: "2020-01-01T09:15:00.000Z", challenge: b64url("old") }] } },
  );
  await read;

  const expired = store.approvePending("p1");
  await settle();
  assert.equal(creds.calls.get.length, 0, "an expired pending asks for no signature");
  answerLists(engine, { body: { ok: true, rpId: "localhost", registered: [] } }, { body: { ok: true, pending: [] } });
  await expired;
  assert.match(section(store, handlers), /期限は切れています/);

  const vanished = store.approvePending("p9");
  await settle();
  assert.equal(creds.calls.get.length, 0, "a row that left the list asks for no signature");
  answerLists(engine, { body: { ok: true, rpId: "localhost", registered: [] } }, { body: { ok: true, pending: [] } });
  await vanished;
  assert.match(section(store, handlers), /一覧に無い保留/);
});

/* ---- AC-005: the Inbox's unregistered note points at the settings section ---- */

const inboxUi = () => ({ noteOpen: false, askOpen: false, note: "", selection: null, question: 0, confirm: null, drafts: emptyDrafts(), tab: null });
const inboxNoop = { note: noop, openNote: noop, closeNote: noop, ask: noop, select: noop, setTab: noop, setQuestion: noop, shipField: noop, outboundField: noop, outboundReply: noop, goName: noop, wake: noop, focus: noop, unignore: noop, retry: noop, clearReceipt: noop, openSettingsKey: noop };

async function inboxStateWithNoKey() {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => Date.parse("2026-10-18T12:00:00Z"));
  const read = store.read();
  engine.calls[0].respond(200, { source: "state", stateDir: "/tmp", cron: null, sections: [], lanes: [], items: [shipNewPr], undelivered: { total: 0, failed: 0 }, ignores: [], holds: [] });
  await read;
  return store.state;
}

test("AC-005: the note opens the settings passkeys section and carries no link to the current GUI", async () => {
  const state = await inboxStateWithNoKey();
  const noKey = { ...state, sign: { read: true, count: 0, error: null } };

  let opened = 0;
  const vm = inboxVals(inboxUi(), noKey, { ...inboxNoop, openSettingsKey: () => { opened += 1; } });
  assert.equal(vm.needsRegister, true);
  assert.equal(vm.registerHere, true, "the local screen can register");
  vm.handlers.openSettingsKey();
  assert.equal(opened, 1);
  // the note carries no address: the old GUI is not the place to register any more
  assert.equal("registerUrl" in vm, false);
  assert.doesNotMatch(WORDS.sign.register, /今の GUI/);
  assert.match(WORDS.sign.register, /設定/);

  // a key list that cannot be read is not "no key": the note does not appear, and neither does the guidance
  const unreadable = { ...state, sign: { read: true, count: null, error: "読めません" } };
  assert.equal(inboxVals(inboxUi(), unreadable, inboxNoop).needsRegister, false);

  // another page cannot register the first key: it says where that has to be done instead
  const saved = globalThis.location;
  globalThis.location = { protocol: "https:", hostname: "tail1234.ts.net" };
  try {
    assert.equal(inboxVals(inboxUi(), noKey, inboxNoop).registerHere, false);
  } finally {
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  }
});

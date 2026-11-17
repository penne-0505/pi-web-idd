import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  approvalGateOpen,
  approvePendingRegistration,
  createChallenge,
  createRegistrationOptions,
  finishRegistration,
  listPasskeys,
  listPendingRegistrations,
  pageOriginAllowed,
  passkeyCount,
  passkeyCredentialIds,
  passkeyRpIds,
  verifyApprovalSignature,
} from '../src/passkey.ts';
import { softwareAuthenticator } from './passkey-fixture.mjs';

const TAILNET_ORIGIN = 'https://pc.example.ts.net:8443';
const TAILNET_RP_ID = 'pc.example.ts.net';
const LOCAL_ORIGIN = 'http://localhost:30142';
const LOCAL_RP_ID = 'localhost';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idd-passkey-tailnet-'));
  process.env.IDD_STATE_DIR = dir;
  delete process.env.IDD_PASSKEY_RP_ID;
  process.env.IDD_TAILNET_ORIGINS = TAILNET_ORIGIN;
});
afterEach(() => {
  delete process.env.IDD_TAILNET_ORIGINS;
});

const statePath = () => join(dir, 'passkey', 'state.json');
const readState = () => JSON.parse(readFileSync(statePath(), 'utf8'));

/** a key registered through the module's own flow, under the origin and RP ID given */
async function register(origin, rpId, name = 'key') {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions(rpId);
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin, rpId }), name, localScreen: true });
  assert.equal(done.ok, true, done.error);
  return auth;
}

const content = (n) => ({ kind: 'ship', iddId: 'IDD-1', publicTree: `tree-${n}`, commitMessage: `feat: ${n}`, pr: null });

/** a second key, added with an already registered key's word over the new key's ID, public key and RP ID */
async function registerMore(approver, approverOrigin, approverRpId, origin, rpId, name = 'key') {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions(rpId);
  const response = auth.registration({ challenge: String(options.challenge), origin, rpId });
  const refused = await finishRegistration({ nonce, response, name, localScreen: false });
  assert.equal(refused.needsProof, true, refused.error);
  const proof = approver.assertion({ challenge: refused.proof.challenge, origin: approverOrigin, rpId: approverRpId });
  const done = await finishRegistration({ nonce, response, name, localScreen: false, proof: { nonce: refused.proof.nonce, assertion: proof } });
  assert.equal(done.ok, true, done.error);
  return auth;
}

/** a tailnet registration that is refused for want of a registered key: the answer carries the pending challenge */
async function rawRegister(auth, name = 'phone key') {
  const { nonce, options } = createRegistrationOptions(TAILNET_RP_ID);
  const response = auth.registration({ challenge: String(options.challenge), origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID });
  const refused = await finishRegistration({ nonce, response, name, localScreen: false });
  return { refused, nonce, response };
}

async function startPending(auth, name = 'phone key') {
  const started = await rawRegister(auth, name);
  assert.equal(started.refused.ok, false);
  assert.equal(started.refused.needsProof, true);
  assert.equal(started.refused.pending, true);
  assert.ok(started.refused.proof?.challenge);
  return started;
}

test('the configured tailnet origin registers a key (after the local first key) and signs with it', async () => {
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const auth = await registerMore(local, LOCAL_ORIGIN, LOCAL_RP_ID, TAILNET_ORIGIN, TAILNET_RP_ID);
  const stored = readState().credentials.find((c) => c.rpId === TAILNET_RP_ID);
  assert.equal(stored.rpId, TAILNET_RP_ID, 'the key records the RP ID it was registered under');
  const ch = createChallenge(content(1));
  const checked = await verifyApprovalSignature({ nonce: ch.nonce, assertion: auth.assertion({ challenge: ch.challenge, origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID }), content: content(1) });
  assert.equal(checked.ok, true, checked.reason);
  assert.equal(approvalGateOpen(ch.nonce, content(1)).ok, true);
});

test('a tailnet registration with no key registered waits as pending, and a local key is what is taken first', async () => {
  // no key exists: the tailnet origin still does not register directly
  const phone = softwareAuthenticator();
  const tailnet = await rawRegister(phone, 'phone key');
  assert.equal(tailnet.refused.ok, false);
  assert.equal(tailnet.refused.pending, true);
  assert.equal(passkeyCount(), 0, 'no key was registered from the tailnet origin');
  assert.equal(listPendingRegistrations().length, 1);
  // the local screen registers the first key on its own
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  assert.equal(passkeyCount(), 1);
  assert.equal(readState().credentials[0].rpId, LOCAL_RP_ID);
  // and only now can the pending tailnet key be approved
  const pendingId = listPendingRegistrations()[0].id;
  const approved = await approvePendingRegistration(pendingId, local.assertion({ challenge: listPendingRegistrations()[0].challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }), true);
  assert.equal(approved.ok, true, approved.error);
  assert.equal(passkeyCount(), 2);
  assert.equal(listPendingRegistrations().length, 0);
});

test('confirming a registration with the same screen\'s proof removes its pending record', async () => {
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const phone = softwareAuthenticator();
  const { refused, nonce, response } = await rawRegister(phone, 'phone key');
  assert.equal(listPendingRegistrations().length, 1);
  const proof = local.assertion({ challenge: refused.proof.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  const added = await finishRegistration({ nonce, response, name: 'phone key', localScreen: true, proof: { nonce: refused.proof.nonce, assertion: proof } });
  assert.equal(added.ok, true, added.error);
  assert.equal(passkeyCount(), 2);
  // the pending record of the now-registered key is gone, so it cannot be approved a second time
  assert.equal(listPendingRegistrations().length, 0);
  const stored = readState();
  assert.equal(stored.pending.length, 0);
  assert.equal(stored.credentials.filter((c) => c.id === phone.credentialId).length, 1, 'the key is stored once');
});

test('an origin the settings do not name is refused for both registration and signature', async () => {
  await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  for (const origin of ['https://pc.example.ts.net:9443', 'http://pc.example.ts.net:8443', 'https://other.ts.net']) {
    const auth = softwareAuthenticator();
    const { nonce, options } = createRegistrationOptions(TAILNET_RP_ID);
    const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin, rpId: TAILNET_RP_ID }), name: 'x', localScreen: false });
    assert.equal(done.ok, false, origin);
    assert.match(String(done.error), /origin/);
  }
  // with no tailnet setting at all, the tailnet origin is not accepted either
  delete process.env.IDD_TAILNET_ORIGINS;
  assert.equal(passkeyRpIds().includes(TAILNET_RP_ID), false);
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions(TAILNET_RP_ID);
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID }), name: 'x', localScreen: false });
  assert.equal(done.ok, false);
  assert.match(String(done.error), /local|localhost/);
});

test('a key with no recorded RP ID reads as the local one and signs on either local port', async () => {
  const auth = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  // the field did not exist before this change: strip it the way an old record would not have it
  const state = readState();
  delete state.credentials[0].rpId;
  writeFileSync(statePath(), JSON.stringify(state));
  for (const origin of ['http://localhost:30142', 'http://localhost:30143']) {
    const ch = createChallenge(content(origin));
    const checked = await verifyApprovalSignature({ nonce: ch.nonce, assertion: auth.assertion({ challenge: ch.challenge, origin, rpId: LOCAL_RP_ID }), content: content(origin) });
    assert.equal(checked.ok, true, `${origin}: ${checked.reason}`);
  }
});

test('a key signs only under the RP ID it was registered with, and only its own keys are offered', async () => {
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const tailnet = await registerMore(local, LOCAL_ORIGIN, LOCAL_RP_ID, TAILNET_ORIGIN, TAILNET_RP_ID);
  assert.equal(passkeyCount(), 2);
  assert.equal(passkeyCredentialIds(LOCAL_RP_ID).includes(local.credentialId), true);
  assert.equal(passkeyCredentialIds(LOCAL_RP_ID).includes(tailnet.credentialId), false);
  assert.equal(passkeyCredentialIds(TAILNET_RP_ID).includes(tailnet.credentialId), true);
  // a localhost key cannot sign the tailnet origin, though that origin is accepted
  const ch = createChallenge(content(1));
  const crossed = await verifyApprovalSignature({ nonce: ch.nonce, assertion: local.assertion({ challenge: ch.challenge, origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID }), content: content(1) });
  assert.equal(crossed.ok, false);
  assert.match(crossed.reason, /localhost/);
  // a record whose RP ID was moved does not open the gate
  const state = readState();
  const target = state.credentials.find((c) => c.id === local.credentialId);
  target.rpId = TAILNET_RP_ID;
  writeFileSync(statePath(), JSON.stringify(state));
  const ch2 = createChallenge(content(2));
  const moved = await verifyApprovalSignature({ nonce: ch2.nonce, assertion: local.assertion({ challenge: ch2.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }), content: content(2) });
  assert.equal(moved.ok, false);
});

test('a verified registration without a proof is held pending, and the localhost key approves it', async () => {
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const phone = softwareAuthenticator();
  const { refused, nonce, response } = await startPending(phone);
  // the tailnet key is not a registered key yet, and it shows in the pending list with its challenge
  assert.equal(passkeyCount(), 1);
  const pending = listPendingRegistrations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rpId, TAILNET_RP_ID);
  assert.equal(pending[0].challenge, refused.proof.challenge);
  // the same screen can carry the proof back in the same registration call
  const proof = local.assertion({ challenge: refused.proof.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  const added = await finishRegistration({ nonce, response, name: 'phone key', localScreen: true, proof: { nonce: refused.proof.nonce, assertion: proof } });
  assert.equal(added.ok, true, added.error);
  assert.equal(passkeyCount(), 2);
  assert.equal(listPendingRegistrations().length, 0);
});

test('the approval door moves a pending key to the registered keys with a registered key of another RP ID', async () => {
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const phone = softwareAuthenticator();
  const { refused } = await startPending(phone);
  const pendingId = listPendingRegistrations()[0].id;
  const assertion = local.assertion({ challenge: refused.proof.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  const approved = await approvePendingRegistration(pendingId, assertion, true);
  assert.equal(approved.ok, true, approved.error);
  assert.equal(passkeyCount(), 2);
  assert.equal(listPendingRegistrations().length, 0);
  // the same assertion cannot approve a second time (its nonce is used up)
  const again = await approvePendingRegistration(pendingId, assertion, true);
  assert.equal(again.ok, false);
});

test('an expired or over-limit pending key is refused', async () => {
  await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  await startPending(softwareAuthenticator(), 'expiring');
  const state = readState();
  state.pending[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(statePath(), JSON.stringify(state));
  assert.deepEqual(listPendingRegistrations(), []);
  // five live pendings are the most; the sixth is refused
  for (let i = 0; i < 5; i += 1) await startPending(softwareAuthenticator(), `phone ${i}`);
  assert.equal(listPendingRegistrations().length, 5);
  const over = await rawRegister(softwareAuthenticator(), 'over');
  assert.equal(over.refused.ok, false);
  assert.equal(over.refused.pending, undefined);
  assert.match(String(over.refused.error), /上限/);
  assert.equal(listPendingRegistrations().length, 5);
});

test('a pending key cannot sign, and cannot approve another pending key', async () => {
  await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const first = softwareAuthenticator();
  const one = await startPending(first, 'first');
  const second = softwareAuthenticator();
  const two = await startPending(second, 'second');
  // a pending key is not registered: its signature over the pending challenge is refused
  const pendingId = listPendingRegistrations().find((p) => p.challenge === one.refused.proof.challenge).id;
  const refused = await approvePendingRegistration(pendingId, first.assertion({ challenge: one.refused.proof.challenge, origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID }), true);
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /登録されていない/);
  // its signature over another pending key's challenge is refused too, and the second stays pending
  const otherId = listPendingRegistrations().find((p) => p.challenge === two.refused.proof.challenge).id;
  const crossed = await approvePendingRegistration(otherId, first.assertion({ challenge: two.refused.proof.challenge, origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID }), true);
  assert.equal(crossed.ok, false);
  assert.equal(listPendingRegistrations().length, 2);
  // an approval challenge signed by the pending key does not open the gate
  const ch = createChallenge(content(1));
  const signed = await verifyApprovalSignature({ nonce: ch.nonce, assertion: first.assertion({ challenge: ch.challenge, origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID }), content: content(1) });
  assert.equal(signed.ok, false);
  assert.equal(approvalGateOpen(ch.nonce, content(1)).ok, false);
});

test('a pending key approved with the wrong challenge or a stranger key is refused', async () => {
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const phone = softwareAuthenticator();
  const one = await startPending(phone, 'phone');
  const id = listPendingRegistrations()[0].id;
  // the wrong challenge
  const otherChallenge = createChallenge(content(9));
  const wrong = await approvePendingRegistration(id, local.assertion({ challenge: otherChallenge.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }), true);
  assert.equal(wrong.ok, false);
  // a key that was never registered
  const stranger = softwareAuthenticator();
  const unregistered = await approvePendingRegistration(id, stranger.assertion({ challenge: one.refused.proof.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }), true);
  assert.equal(unregistered.ok, false);
  assert.equal(listPendingRegistrations().length, 1);
});

test('the page origin rule takes the local RP ID on any port and the tailnet origin exactly', () => {
  process.env.IDD_TAILNET_ORIGINS = TAILNET_ORIGIN;
  assert.equal(pageOriginAllowed('http://localhost:30142'), true);
  assert.equal(pageOriginAllowed('http://localhost:1'), true);
  assert.equal(pageOriginAllowed(TAILNET_ORIGIN), true);
  assert.equal(pageOriginAllowed('https://pc.example.ts.net:9443'), false);
  assert.equal(pageOriginAllowed('http://pc.example.ts.net:8443'), false);
  assert.equal(pageOriginAllowed(null), false);
  assert.deepEqual(listPasskeys().map((p) => p.name), []);
});

test('a registration a tailnet listener accepted is pending even when it declares localhost and no key exists', async () => {
  // no key exists, and the caller says the request reached the engine on a tailnet listener: whatever the
  // response's own origin claims, the first key is not taken here
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions(LOCAL_RP_ID);
  const response = auth.registration({ challenge: String(options.challenge), origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  const done = await finishRegistration({ nonce, response, name: 'phone key', localScreen: false, requestHost: 'localhost', requestOriginHost: 'localhost' });
  assert.equal(done.ok, false);
  assert.equal(done.pending, true);
  assert.equal(passkeyCount(), 0, 'no key was registered from the tailnet listener');
  assert.equal(listPendingRegistrations().length, 1);
  // the local listener registers the first key on its own, and can then approve the pending one
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const pending = listPendingRegistrations()[0];
  const approved = await approvePendingRegistration(pending.id, local.assertion({ challenge: pending.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }), true);
  assert.equal(approved.ok, true, approved.error);
  assert.equal(passkeyCount(), 2);
});

test('a registration is refused when the declared RP ID does not match the request host', async () => {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions(TAILNET_RP_ID);
  const response = auth.registration({ challenge: String(options.challenge), origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID });
  // the request's Origin names localhost while the response declares the tailnet RP ID
  const mismatchOrigin = await finishRegistration({ nonce, response, name: 'x', localScreen: false, requestOriginHost: 'localhost' });
  assert.equal(mismatchOrigin.ok, false);
  assert.match(String(mismatchOrigin.error), /合いません/);
  // the request's Host names the tailnet while the response declares the local RP ID
  const local = softwareAuthenticator();
  const localStart = createRegistrationOptions(LOCAL_RP_ID);
  const localResponse = local.registration({ challenge: String(localStart.options.challenge), origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID });
  const mismatchHost = await finishRegistration({ nonce: localStart.nonce, response: localResponse, name: 'x', localScreen: true, requestHost: TAILNET_RP_ID });
  assert.equal(mismatchHost.ok, false);
  assert.match(String(mismatchHost.error), /合いません/);
});

test('a pending record expires exactly when its approval proof does', async () => {
  await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const phone = softwareAuthenticator();
  const { refused } = await startPending(phone, 'phone');
  const state = readState();
  const pending = state.pending[0];
  assert.equal(pending.proof.nonce, refused.proof.nonce);
  // the same instant: a pending in the list always has a live proof, so it can always be approved
  assert.equal(pending.expiresAt, state.nonces[pending.proof.nonce].expiresAt);
});

test('removing the tailnet setting leaves the localhost key signing and refuses the tailnet origin', async () => {
  const local = await register(LOCAL_ORIGIN, LOCAL_RP_ID);
  const tailnetAuth = await registerMore(local, LOCAL_ORIGIN, LOCAL_RP_ID, TAILNET_ORIGIN, TAILNET_RP_ID);
  // the setting is removed: the tailnet key stays in the record but can no longer sign
  delete process.env.IDD_TAILNET_ORIGINS;
  const localChallenge = createChallenge(content(1));
  const localSigned = await verifyApprovalSignature({ nonce: localChallenge.nonce, assertion: local.assertion({ challenge: localChallenge.challenge, origin: LOCAL_ORIGIN, rpId: LOCAL_RP_ID }), content: content(1) });
  assert.equal(localSigned.ok, true, localSigned.reason);
  const state = readState();
  const tailnetKey = state.credentials.find((c) => c.rpId === TAILNET_RP_ID);
  assert.ok(tailnetKey);
  const ch = createChallenge(content(2));
  const refused = await verifyApprovalSignature({ nonce: ch.nonce, assertion: tailnetAuth.assertion({ challenge: ch.challenge, origin: TAILNET_ORIGIN, rpId: TAILNET_RP_ID }), content: content(2) });
  assert.equal(refused.ok, false);
  assert.match(String(refused.reason), /localhost/);
});

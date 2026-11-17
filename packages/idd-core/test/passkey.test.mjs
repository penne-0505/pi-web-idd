import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';

import { approvalGateOpen, consumeNonce, createChallenge, createRegistrationOptions, finishRegistration, listPasskeys, passkeyCount, verifyApprovalSignature } from '../src/passkey.ts';
import { softwareAuthenticator } from './passkey-fixture.mjs';

const ORIGIN = 'http://localhost:30142';
const RP_ID = 'localhost';

beforeEach(() => {
  process.env.IDD_STATE_DIR = mkdtempSync(join(tmpdir(), 'idd-passkey-'));
  delete process.env.IDD_PASSKEY_RP_ID;
});

/** a key registered through the module's own registration flow */
async function registered() {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID }), name: 'test key', localScreen: true });
  assert.equal(done.ok, true, done.error);
  return auth;
}

const content = (n) => ({ kind: 'ship', iddId: 'IDD-1', publicTree: `tree-${n}`, commitMessage: `feat: ${n}`, pr: null });

test('a signature is refused when the origin host is not the RP ID, and taken for any port of the RP ID', async () => {
  const auth = await registered();
  // 127.0.0.1 is not the RP ID: WebAuthn cannot sign under an IP address
  for (const origin of ['http://127.0.0.1:30142', 'http://localhost.example.com:30142', 'https://evil.test']) {
    const ch = createChallenge(content(origin));
    const refused = await verifyApprovalSignature({ nonce: ch.nonce, assertion: auth.assertion({ challenge: ch.challenge, origin, rpId: RP_ID }), content: content(origin) });
    assert.equal(refused.ok, false, origin);
    assert.match(refused.reason, /origin/);
    assert.equal(approvalGateOpen(ch.nonce, content(origin)).ok, false, 'the gate stays shut');
  }
  // the same RP ID on either port is taken
  for (const origin of ['http://localhost:30142', 'http://localhost:30143']) {
    const ch = createChallenge(content(origin));
    const taken = await verifyApprovalSignature({ nonce: ch.nonce, assertion: auth.assertion({ challenge: ch.challenge, origin, rpId: RP_ID }), content: content(origin) });
    assert.equal(taken.ok, true, `${origin}: ${taken.reason}`);
    assert.equal(approvalGateOpen(ch.nonce, content(origin)).ok, true);
  }
});

test('an expired nonce and a consumed one are both refused, and the gate stays shut', async () => {
  const auth = await registered();
  const signed = async (n) => {
    const ch = createChallenge(content(n));
    const checked = await verifyApprovalSignature({ nonce: ch.nonce, assertion: auth.assertion({ challenge: ch.challenge, origin: ORIGIN, rpId: RP_ID }), content: content(n) });
    assert.equal(checked.ok, true, checked.reason);
    return ch;
  };
  const expired = await signed(1);
  // the clock moved past its five minutes
  const { readFileSync, writeFileSync } = await import('node:fs');
  const path = join(process.env.IDD_STATE_DIR, 'passkey', 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.nonces[expired.nonce].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(path, JSON.stringify(state));
  assert.match((await verifyApprovalSignature({ nonce: expired.nonce, content: content(1) })).reason, /期限/);
  assert.equal(approvalGateOpen(expired.nonce, content(1)).ok, false);
  // a nonce the approval finished is used up
  const used = await signed(2);
  consumeNonce(used.nonce);
  assert.match((await verifyApprovalSignature({ nonce: used.nonce, content: content(2) })).reason, /使い終え/);
  assert.equal(approvalGateOpen(used.nonce, content(2)).ok, false);
});

test('another lane or another commit message does not open the same signature, and an unregistered key cannot sign', async () => {
  const auth = await registered();
  const ch = createChallenge(content(1));
  const checked = await verifyApprovalSignature({ nonce: ch.nonce, assertion: auth.assertion({ challenge: ch.challenge, origin: ORIGIN, rpId: RP_ID }), content: content(1) });
  assert.equal(checked.ok, true, checked.reason);
  // the same approval, its content changed: the hash was over the first content
  for (const other of [content(2), { ...content(1), iddId: 'IDD-2' }, { ...content(1), commitMessage: 'feat: other' }, { ...content(1), pr: { title: 't', body: 'b' } }]) {
    assert.match((await verifyApprovalSignature({ nonce: ch.nonce, content: other })).reason, /中身/);
    assert.equal(approvalGateOpen(ch.nonce, other).ok, false);
  }
  // a key that was never registered
  const stranger = softwareAuthenticator();
  const fresh = createChallenge(content(3));
  const refused = await verifyApprovalSignature({ nonce: fresh.nonce, assertion: stranger.assertion({ challenge: fresh.challenge, origin: ORIGIN, rpId: RP_ID }), content: content(3) });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /登録されていない/);
});

test('the first key registers on its own and a second one needs the first key\'s signature', async () => {
  const first = await registered();
  assert.deepEqual(listPasskeys().map((p) => p.name), ['test key']);
  const second = softwareAuthenticator();
  // the second registration without a proof is refused and stores nothing; the answer carries the challenge the
  // already registered key signs over the new key (its ID and public key)
  const one = createRegistrationOptions();
  const reg = second.registration({ challenge: String(one.options.challenge), origin: ORIGIN, rpId: RP_ID });
  const refused = await finishRegistration({ nonce: one.nonce, response: reg, name: 'second', localScreen: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.needsProof, true);
  assert.ok(refused.proof?.challenge, 'the proof challenge is in the answer');
  assert.deepEqual(listPasskeys().map((p) => p.name), ['test key'], 'no key was added');
  // with the first key's word over the new key, the same response stores it
  const proof = first.assertion({ challenge: refused.proof.challenge, origin: ORIGIN, rpId: RP_ID });
  const added = await finishRegistration({ nonce: one.nonce, response: reg, name: 'second', localScreen: true, proof: { nonce: refused.proof.nonce, assertion: proof } });
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(listPasskeys().map((p) => p.name), ['test key', 'second']);
});

test('a missing state file is a first run, not a broken one', () => {
  assert.deepEqual(listPasskeys(), []);
  assert.equal(passkeyCount(), 0);
});

test('a state file that is there but cannot be read is not taken as no keys, and is not overwritten', async () => {
  await registered();
  const statePath = join(process.env.IDD_STATE_DIR, 'passkey', 'state.json');
  // a registration challenge made while the state was readable
  const second = softwareAuthenticator();
  const started = createRegistrationOptions();
  const reg = second.registration({ challenge: String(started.options.challenge), origin: ORIGIN, rpId: RP_ID });
  // the file is broken (the way a hand edit that misses the JSON would)
  writeFileSync(statePath, '{ this is not json');
  const broken = readFileSync(statePath, 'utf8');
  // the keys are not seen as none: a read refuses instead of answering an empty list
  assert.throws(() => listPasskeys(), /passkey の記録/);
  assert.throws(() => passkeyCount(), /passkey の記録/);
  // the registration is refused and the file it could have overwritten is left alone
  const done = await finishRegistration({ nonce: started.nonce, response: reg, name: 'second', localScreen: true });
  assert.equal(done.ok, false);
  assert.ok(done.error);
  assert.equal(readFileSync(statePath, 'utf8'), broken);
  // the gate refuses, and consuming a nonce does not overwrite the file either
  assert.equal(approvalGateOpen(started.nonce, {}).ok, false);
  consumeNonce(started.nonce);
  assert.equal(readFileSync(statePath, 'utf8'), broken);
});

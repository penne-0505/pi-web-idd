import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentBaseUrl, inboxBaseUrl, inboxCardUrl } from '../src/agent/token.ts';

// the screen reads ?view=inbox&card=<id>: build the URL, then read it back the way the screen does
test('the inbox URL opens the inbox, and carries the card to bring to the front', () => {
  process.env.IDD_INBOX_BASE_URL = 'http://127.0.0.1:30144';
  try {
    const withCard = new URL(inboxCardUrl('OUT-20260928T010203-ab12'));
    assert.equal(withCard.pathname, '/gui/');
    assert.equal(withCard.searchParams.get('view'), 'inbox');
    assert.equal(withCard.searchParams.get('card'), 'OUT-20260928T010203-ab12');

    const withLane = new URL(inboxCardUrl('IDD-039'));
    assert.equal(withLane.searchParams.get('card'), 'IDD-039');

    const plain = new URL(inboxCardUrl());
    assert.equal(plain.searchParams.get('view'), 'inbox');
    assert.equal(plain.searchParams.get('card'), null);

    const blank = new URL(inboxCardUrl('  '));
    assert.equal(blank.searchParams.get('card'), null);
  } finally {
    delete process.env.IDD_INBOX_BASE_URL;
  }
});

test('the inbox URL is the engine\'s screen, apart from the API destination the CLI sends to', () => {
  process.env.IDD_AGENT_BASE_URL = 'http://127.0.0.1:30144';
  process.env.IDD_INBOX_BASE_URL = 'http://127.0.0.1:30144';
  try {
    assert.equal(new URL(inboxCardUrl()).origin, 'http://127.0.0.1:30144');
    assert.equal(agentBaseUrl(), 'http://127.0.0.1:30144');
    // changing where the API goes must not move the page a person opens
    process.env.IDD_AGENT_BASE_URL = 'http://127.0.0.1:9';
    assert.equal(new URL(inboxCardUrl()).origin, 'http://127.0.0.1:30144');
    // and it is the inbox's own variable that moves it
    process.env.IDD_INBOX_BASE_URL = 'http://127.0.0.1:30143/';
    assert.equal(new URL(inboxCardUrl()).origin, 'http://127.0.0.1:30143');
    assert.equal(inboxBaseUrl(), 'http://127.0.0.1:30143/gui');
  } finally {
    delete process.env.IDD_AGENT_BASE_URL;
    delete process.env.IDD_INBOX_BASE_URL;
  }
});

test('with nothing set the inbox is the screen the engine serves on its own port, whichever port that is', () => {
  const saved = { inbox: process.env.IDD_INBOX_BASE_URL, port: process.env.IDD_ENGINE_PORT };
  delete process.env.IDD_INBOX_BASE_URL;
  delete process.env.IDD_ENGINE_PORT;
  try {
    assert.equal(inboxBaseUrl(), 'http://127.0.0.1:30144/gui');
    assert.equal(inboxCardUrl('IDD-1'), 'http://127.0.0.1:30144/gui/?view=inbox&card=IDD-1');
    process.env.IDD_ENGINE_PORT = '39999';
    assert.equal(inboxBaseUrl(), 'http://127.0.0.1:39999/gui');
  } finally {
    if (saved.inbox !== undefined) process.env.IDD_INBOX_BASE_URL = saved.inbox;
    if (saved.port === undefined) delete process.env.IDD_ENGINE_PORT;
    else process.env.IDD_ENGINE_PORT = saved.port;
  }
});

test('the API destination defaults to the engine when neither variable says', () => {
  delete process.env.IDD_AGENT_BASE_URL;
  const saved = process.env.IDD_ENGINE_PORT;
  delete process.env.IDD_ENGINE_PORT;
  try {
    assert.equal(agentBaseUrl(), 'http://127.0.0.1:30144');
    process.env.IDD_ENGINE_PORT = '39999';
    assert.equal(agentBaseUrl(), 'http://127.0.0.1:39999');
  } finally {
    if (saved === undefined) delete process.env.IDD_ENGINE_PORT;
    else process.env.IDD_ENGINE_PORT = saved;
  }
});

test('an inbox on the configured tailnet origin is an origin the passkey accepts', async () => {
  const { pageOriginAllowed } = await import('../src/passkey.ts');
  process.env.IDD_INBOX_BASE_URL = 'https://pc.example.ts.net:8443';
  process.env.IDD_TAILNET_ORIGINS = 'https://pc.example.ts.net:8443';
  try {
    assert.equal(new URL(inboxCardUrl('IDD-1')).origin, 'https://pc.example.ts.net:8443');
    assert.equal(pageOriginAllowed(new URL(inboxCardUrl()).origin), true);
  } finally {
    delete process.env.IDD_INBOX_BASE_URL;
    delete process.env.IDD_TAILNET_ORIGINS;
  }
});

test('an inbox origin the settings do not name is not an origin the passkey accepts', async () => {
  const { pageOriginAllowed } = await import('../src/passkey.ts');
  process.env.IDD_INBOX_BASE_URL = 'https://other.example.ts.net';
  process.env.IDD_TAILNET_ORIGINS = 'https://pc.example.ts.net:8443';
  try {
    assert.equal(pageOriginAllowed(new URL(inboxCardUrl()).origin), false);
  } finally {
    delete process.env.IDD_INBOX_BASE_URL;
    delete process.env.IDD_TAILNET_ORIGINS;
  }
});

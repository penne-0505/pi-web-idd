import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionStopFrom } from '../src/agent/session-status.ts';

const at = '2026-09-23T14:52:34.161Z';
const entry = (role, stopReason, errorMessage) => JSON.stringify({ type: 'message', timestamp: at, message: { role, stopReason, errorMessage } });

test('the last turn of a stopped session is read from its record', () => {
  assert.deepEqual(sessionStopFrom([entry('user'), entry('assistant', 'error', '400: bad request')].join('\n')), { state: 'stopped', cause: 'error', error: '400: bad request', at });
  assert.equal(sessionStopFrom([entry('assistant', 'toolUse'), entry('toolResult')].join('\n')).cause, 'interrupted');
  assert.equal(sessionStopFrom(entry('assistant', 'toolUse')).cause, 'interrupted');
  assert.equal(sessionStopFrom([entry('assistant', 'stop'), '{"type":"custom"}'].join('\n')).cause, 'finished');
  assert.equal(sessionStopFrom('').state, 'unknown');
});

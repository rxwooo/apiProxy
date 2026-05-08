import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../src/shared/logger.js';

test('redact keeps diagnostic error messages visible', () => {
  assert.deepEqual(redact({ message: 'Unexpected server response: 404' }), {
    message: 'Unexpected server response: 404'
  });
});

test('redact hides credentials and prompt-bearing fields', () => {
  assert.deepEqual(
    redact({
      authorization: 'Bearer secret',
      relayToken: 'secret',
      messages: [{ role: 'user', content: 'private prompt' }],
      body: '{"secret":true}'
    }),
    {
      authorization: '[redacted]',
      relayToken: '[redacted]',
      messages: '[redacted]',
      body: '[redacted]'
    }
  );
});

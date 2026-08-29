import test from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorFingerprint } from '../lib/safeError.mjs';

test('error fingerprints keep diagnostic types without persisting private messages', () => {
  const error = Object.assign(
    new Error('Gmail failed on private-person@example.test: secret subject line'),
    { status: 503, code: 'ETIMEDOUT' },
  );
  assert.equal(safeErrorFingerprint(error), 'Error status=503 code=ETIMEDOUT');
});

test('arbitrary thrown values cannot become log content', () => {
  assert.equal(safeErrorFingerprint('private transcript text'), 'Error');
  assert.equal(safeErrorFingerprint({ name: 'bad name: private text', code: 'also private!' }), 'Error');
});

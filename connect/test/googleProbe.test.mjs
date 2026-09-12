// WHAT THE PROBE IS ALLOWED TO SAY.
//
// Onboarding's "your mail and calendar" screen asks Google for one message and
// renders the answer. The answer therefore crosses from a mailbox into a
// screen, and the only thing standing between those is this function's return
// value — so what it returns is the whole test.
//
// The failure it must not have is not an exception; it is a helpful one. The
// thrown message from gmailClient reads
//   Gmail messages.list failed: HTTP 403 {"error":{...}} — for owner@…
// and passing it through would put the account's address on the screen and in
// whatever the page does with it. The reason token is worth showing; the
// message it was cut out of is not.
//
// Seams rather than a live grant: the property under test is exactly the one a
// real Google account cannot demonstrate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { googleProbe } from '../lib/googleProbe.mjs';

const OWNER = 'owner@example.test';
const OTHER = 'second@example.test';

const account = (email) => ({ email, tokensPath: `/tmp/${email}.json`, scopes: [], stale: false });

function failing(status, body) {
  const error = new Error(
    `Gmail messages.list failed: HTTP ${status} ${body} — for ${OWNER}`
  );
  error.status = status;
  return error;
}

const reading = () => ({ listMessages: async () => ({ messages: [{ id: 'abc123' }] }) });

test('a grant that reads is reported as reading, and nothing about what it read', async () => {
  const out = await googleProbe({
    accountsForScope: () => [account(OWNER), account(OTHER)],
    accountsIncludingStale: () => [account(OWNER), account(OTHER)],
    makeClient: reading,
  });
  assert.deepEqual(out, { ok: true, accounts: 2, stale: 0, reading: 2, failures: [] });
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes(OWNER), 'no account address');
  assert.ok(!wire.includes('abc123'), 'no message id');
});

test('a consented token that Google refuses is amber with the status, not green', async () => {
  // THE WHOLE REASON THIS ROUTE EXISTS. The token file is on disk, so every
  // check that reads the disk says "connected". Google says 403.
  const out = await googleProbe({
    accountsForScope: () => [account(OWNER)],
    accountsIncludingStale: () => [account(OWNER)],
    makeClient: () => ({
      listMessages: async () => {
        throw failing(403, '{"error":{"errors":[{"reason":"insufficientPermissions"}],"code":403}}');
      },
    }),
  });
  assert.equal(out.reading, 0, 'the account is not reading, whatever the disk says');
  assert.deepEqual(out.failures, [{ status: 403, reason: 'insufficientPermissions' }]);
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes(OWNER), 'the address in the thrown message must not ride out on it');
  assert.ok(!wire.includes('HTTP 403 {'), 'nor the body it was cut from');
});

test('a body with no machine reason yields a null reason, never a slice of prose', async () => {
  const out = await googleProbe({
    accountsForScope: () => [account(OWNER)],
    accountsIncludingStale: () => [account(OWNER)],
    makeClient: () => ({
      listMessages: async () => { throw failing(500, 'Backend Error for owner@example.test'); },
    }),
  });
  assert.deepEqual(out.failures, [{ status: 500, reason: null }]);
});

test('a reason that is not a bare identifier is refused', async () => {
  // The pattern is an allowlist, not an extraction: a body that puts a
  // sentence, an address or markup where the token goes yields null.
  for (const body of [
    '{"reason":"contact owner@example.test for access"}',
    '{"reason":"<b>nope</b>"}',
    '{"reason":""}',
    `{"reason":"${'x'.repeat(200)}"}`,
  ]) {
    const out = await googleProbe({
      accountsForScope: () => [account(OWNER)],
      accountsIncludingStale: () => [account(OWNER)],
      makeClient: () => ({ listMessages: async () => { throw failing(403, body); } }),
    });
    const [failure] = out.failures;
    assert.ok(
      failure.reason === null || /^[A-Za-z][A-Za-z0-9_]{0,48}$/u.test(failure.reason),
      `accepted ${JSON.stringify(failure.reason)} from ${body.slice(0, 40)}`
    );
    assert.ok(!JSON.stringify(out).includes(OWNER));
  }
});

test('a transport failure reports 0, not a status Google never sent', async () => {
  const out = await googleProbe({
    accountsForScope: () => [account(OWNER)],
    accountsIncludingStale: () => [account(OWNER)],
    makeClient: () => ({ listMessages: async () => { throw new TypeError('fetch failed'); } }),
  });
  assert.deepEqual(out.failures, [{ status: 0, reason: null }]);
});

test('a dead grant is counted, not hidden', async () => {
  // accountsWithScope filters a stale account out entirely, so reporting only
  // its length would say "0 accounts" about a mailbox the owner can see they
  // signed into — and the screen would send them to sign in again with no
  // explanation of what happened to the one they have.
  const out = await googleProbe({
    accountsForScope: () => [account(OWNER)],
    accountsIncludingStale: () => [account(OWNER), account(OTHER)],
    makeClient: reading,
  });
  assert.equal(out.accounts, 1);
  assert.equal(out.stale, 1);
  assert.equal(out.reading, 1);
});

test('no accounts at all is a clean zero, not a failure', async () => {
  const out = await googleProbe({
    accountsForScope: () => [],
    accountsIncludingStale: () => [],
    makeClient: () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(out, { ok: true, accounts: 0, stale: 0, reading: 0, failures: [] });
});

// Gmail's per-user "Units per minute" quota trips mid-backfill on a large
// mailbox (reproduced live against a 52k-message account): apiGet must retry
// a 429, and a 403 whose body says the same thing, with full-jitter backoff —
// but a 403 that is a real permissions problem must still throw immediately,
// because retrying it only delays a failure the owner needs to see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailClient } from '../lib/gmailClient.mjs';

// A token that is nowhere near expiry, so accessToken() never triggers a
// refresh — refreshing is gcalClient.mjs's/gmailClient.mjs's own concern and
// out of scope for these rate-limit tests.
function tokenFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'gmail-client-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const tokensPath = join(secrets, 'google-tokens-test.json');
  writeFileSync(
    tokensPath,
    JSON.stringify({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
      obtained_at: Date.now(),
    }),
    { mode: 0o600 }
  );
  return tokensPath;
}

function client(t, { fetchImpl, sleep }) {
  const tokensPath = tokenFixture(t);
  return createGmailClient({ email: 'owner@example.test', tokensPath, fetchImpl, sleep });
}

const quotaBody = (reason = 'rateLimitExceeded') =>
  JSON.stringify({
    error: {
      code: 403,
      message:
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'",
      errors: [{ reason, domain: 'usageLimits' }],
    },
  });

const permissionsBody = JSON.stringify({
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    errors: [{ reason: 'insufficientPermissions', domain: 'global' }],
  },
});

test('a 403 quota body is retried and succeeds on the 3rd attempt', async (t) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return new Response(quotaBody(), { status: 403 });
    return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
  };
  const sleeps = [];
  const c = client(t, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  const result = await c.getMessage('m1');
  assert.deepEqual(result, { id: 'm1' });
  assert.equal(calls, 3, 'exactly 3 fetch calls: 2 failures then a success');
  assert.equal(sleeps.length, 2, 'one backoff sleep per retried failure');
});

test('a 403 insufficientPermissions throws immediately, never retried', async (t) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(permissionsBody, { status: 403 });
  };
  const c = client(t, {
    fetchImpl,
    sleep: async () => { throw new Error('must not sleep for a non-quota 403'); },
  });
  await assert.rejects(c.getMessage('m1'), /HTTP 403/u);
  assert.equal(calls, 1, 'a real permissions error must not be retried');
});

test('a Retry-After header is honored instead of the jittered backoff', async (t) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    }
    return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
  };
  const sleeps = [];
  const c = client(t, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  const result = await c.getMessage('m1');
  assert.deepEqual(result, { id: 'm1' });
  assert.deepEqual(sleeps, [2000], 'Retry-After: 2 must produce exactly a 2000ms wait, not a jittered one');
});

test('after 6 failed attempts the error propagates with status intact', async (t) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(quotaBody(), { status: 403 });
  };
  const c = client(t, { fetchImpl, sleep: async () => {} });
  await assert.rejects(c.getMessage('m1'), (err) => {
    assert.equal(err.status, 403, 'the original error shape keeps its status');
    return true;
  });
  assert.equal(calls, 6, 'exactly 6 attempts total, then give up');
});

test('userRateLimitExceeded and quotaExceeded reasons are treated the same as rateLimitExceeded', async (t) => {
  for (const reason of ['userRateLimitExceeded', 'quotaExceeded']) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 2) return new Response(quotaBody(reason), { status: 403 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const c = client(t, { fetchImpl, sleep: async () => {} });
    const result = await c.getMessage('m1');
    assert.deepEqual(result, { ok: true }, `reason ${reason} must be retried`);
    assert.equal(calls, 2);
  }
});

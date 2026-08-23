import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../daemon.mjs';
import { verifyHermesIdentity } from '../lib/checks.mjs';

// Why this file exists: with no HAZLIE_HERMES_URL in the shell, a hand-run
// `node run.mjs notion` once POSTed a corpus row at the DEFAULT port — held
// on this Mac by an unrelated dev server that answers 200 on /health. It
// only failed because that server happens to have no /ingest route. The two
// halves of the fix are a per-machine "hermesUrl" config key and an identity
// gate in run.mjs; both are covered here.

test('"hermesUrl" accepts an HTTP loopback origin', () => {
  const config = { hermesUrl: 'http://127.0.0.1:8789' };
  assert.deepEqual(validateConfig(config), config);
});

test('"hermesUrl" refuses everything the ingest client would refuse', () => {
  // Each of these, if accepted, becomes the address corpus rows are sent to.
  for (const bad of [
    'https://127.0.0.1:8789', // https implies a non-local trust model
    'http://192.168.1.20:8789', // a LAN host is not loopback
    'http://127.0.0.1:8789/ingest', // a path smuggles routing into config
    'http://user:pw@127.0.0.1:8789', // credentials in a URL end up in logs
    8789, // a bare port is a guess about the rest
    '',
  ]) {
    assert.throws(() => validateConfig({ hermesUrl: bad }), /hermesUrl/u, JSON.stringify(bad));
  }
});

const health = (status, body) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('verifyHermesIdentity passes only on hermes’ exact health answer', async () => {
  assert.deepEqual(await verifyHermesIdentity('http://127.0.0.1:1', { fetchImpl: health(200, { ok: true }) }), {
    ok: true,
  });
});

test('a 200 that is not hermes fails identity — liveness is not identity', async () => {
  // The squatter scenario: an unrelated app answering HTML with a 200.
  const verdict = await verifyHermesIdentity('http://127.0.0.1:1', {
    fetchImpl: health(200, '<!doctype html><html></html>'),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /non-Hermes body/u);
  assert.match(verdict.fix, /lsof/u);
});

test('a 200 carrying ok:true beside another key fails identity', async () => {
  // The regression the test above was NAMED for but never covered. While the
  // check was `body?.ok !== true`, this passed — so any service whose health
  // answer happens to include ok:true cleared the gate, and ok:true is the
  // likeliest shape for another health endpoint to return. The squatter does
  // not have to be malicious to defeat a check this loose.
  const verdict = await verifyHermesIdentity('http://127.0.0.1:1', {
    fetchImpl: health(200, { ok: true, service: 'vite' }),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /non-Hermes body/u);
});

test('near-miss health bodies all fail identity', async () => {
  for (const body of [{ ok: 'true' }, { ok: 1 }, { okay: true }, {}, [], null, '']) {
    const verdict = await verifyHermesIdentity('http://127.0.0.1:1', {
      fetchImpl: health(200, body),
    });
    assert.equal(verdict.ok, false, `should have failed: ${JSON.stringify(body)}`);
  }
});

test('a non-loopback base is refused without issuing the request', async () => {
  // Not "the request fails" — the request must never leave. verifyHermesIdentity
  // is the gate run.mjs and the daemon preflight call before sending rows, and
  // checkHermesStats spends the bearer on the same base.
  let called = false;
  const verdict = await verifyHermesIdentity('http://evil.example.com', {
    fetchImpl: async () => {
      called = true;
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.equal(called, false, 'no request may be issued to an off-box base');
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /is not loopback/u);
});

test('the identity probe refuses to follow redirects', async () => {
  // A loopback origin says where the request STARTS. Without redirect:'error'
  // a squatter answers 302 and picks where it ends.
  let init;
  await verifyHermesIdentity('http://127.0.0.1:1', {
    fetchImpl: async (_url, opts) => {
      init = opts;
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.equal(init?.redirect, 'error');
});

test('a non-200 fails identity even with a well-formed body', async () => {
  const verdict = await verifyHermesIdentity('http://127.0.0.1:1', {
    fetchImpl: health(503, { ok: true }),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /503/u);
});

test('an unreachable hermes names the base it tried', async () => {
  const verdict = await verifyHermesIdentity('http://127.0.0.1:1', {
    fetchImpl: async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /http:\/\/127\.0\.0\.1:1\/health unreachable \(ECONNREFUSED\)/u);
});

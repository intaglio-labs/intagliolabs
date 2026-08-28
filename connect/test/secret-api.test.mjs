// The native paste channel (lib/secretApi.mjs): the widget's in-panel
// walkthrough lands API keys here. Pure-decision tests, same style as the
// status channel's — no port, mkdtemp home, the write injected and spied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretResponse } from '../lib/secretApi.mjs';

const TOKEN = 'ab'.repeat(32); // 64 hex chars, the shape bearerAuthorized wants

function homeWithToken() {
  const home = mkdtempSync(join(tmpdir(), 'hz-secret-'));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, 'hermes-token.txt'), `${TOKEN}\n`, { mode: 0o600 });
  return home;
}

const auth = `Bearer ${TOKEN}`;

test('any Origin header is refused before auth is even considered', () => {
  const writes = [];
  const r = secretResponse({
    method: 'POST', origin: 'http://localhost:51788', authorization: auth,
    body: { p: 'granola', value: 'k'.repeat(20) },
    home: homeWithToken(), write: (...a) => writes.push(a),
  });
  assert.equal(r.status, 403);
  assert.equal(writes.length, 0);
});

test('missing, malformed and wrong bearers are one indistinguishable 401', () => {
  const home = homeWithToken();
  const writes = [];
  for (const bad of [undefined, 'Bearer nope', `Bearer ${'cd'.repeat(32)}`]) {
    const r = secretResponse({
      method: 'POST', authorization: bad,
      body: { p: 'granola', value: 'k'.repeat(20) },
      home, write: (...a) => writes.push(a),
    });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'unauthorized' });
  }
  assert.equal(writes.length, 0);
});

test('an unlisted sink is refused — the body must not choose filenames', () => {
  const writes = [];
  for (const p of ['mail', '../../evil', 'granola-api-key.txt', '', undefined]) {
    const r = secretResponse({
      method: 'POST', authorization: auth, body: { p, value: 'k'.repeat(20) },
      home: homeWithToken(), write: (...a) => writes.push(a),
    });
    assert.equal(r.status, 404, `sink ${JSON.stringify(p)} must 404`);
  }
  assert.equal(writes.length, 0);
});

test('a paste that cannot be a key is a 400, and nothing is written', () => {
  const home = homeWithToken();
  const writes = [];
  for (const value of ['', '   ', 'short', 'two\nlines', 'has a space in it', 'x'.repeat(600), 7]) {
    const r = secretResponse({
      method: 'POST', authorization: auth, body: { p: 'granola', value },
      home, write: (...a) => writes.push(a),
    });
    assert.equal(r.status, 400, `value ${JSON.stringify(value)} must 400`);
  }
  assert.equal(writes.length, 0);
});

test('a plausible key writes to the granola sink, trimmed, and is not echoed', () => {
  const writes = [];
  const r = secretResponse({
    method: 'POST', authorization: auth,
    body: { p: 'granola', value: '  gran-abc123XYZ_secret  ' },
    home: homeWithToken(), write: (...a) => writes.push(a),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { p: 'granola', connected: true });
  assert.deepEqual(writes, [['granola-api-key.txt', 'gran-abc123XYZ_secret']]);
  assert.ok(!JSON.stringify(r.body).includes('secret'), 'the value must never ride the reply');
});

test('GET is a 405 — this channel only ever accepts a paste', () => {
  const r = secretResponse({
    method: 'GET', authorization: auth, body: {},
    home: homeWithToken(), write: () => { throw new Error('must not write'); },
  });
  assert.equal(r.status, 405);
});

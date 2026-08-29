import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bridgeApiResponse, pendingBridgeQuestion } from '../lib/bridgeApi.mjs';

const TOKEN = 'ab'.repeat(32);

function freshHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-api-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const token = join(secrets, 'hermes-token.txt');
  writeFileSync(token, `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(token, 0o600);
  return home;
}

test('fresh installs can fetch web-login policy before Matrix exists', async (t) => {
  const home = freshHome(t);
  const query = new URLSearchParams({ p: 'messenger' });
  const res = await bridgeApiResponse({
    method: 'GET', authorization: `Bearer ${TOKEN}`, query, home,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.loginUrl, 'https://www.facebook.com/login/');
  assert.deepEqual(res.body.allowedHosts, ['facebook.com', 'messenger.com', 'meta.com']);
  assert.equal(res.body.sessionCookie, 'c_user');
});

test('fresh manual bridges report their policy instead of a Matrix error', async (t) => {
  const home = freshHome(t);
  const query = new URLSearchParams({ p: 'telegram' });
  const res = await bridgeApiResponse({
    method: 'GET', authorization: `Bearer ${TOKEN}`, query, home,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.allowedHosts, null);
  assert.equal(res.body.sessionCookie, null);
});

test('only a currently pending bridge question blocks a fresh login', () => {
  const bot = (body) => ({ from: 'bot', body });
  const you = (body) => ({ from: 'you', body });
  assert.equal(
    pendingBridgeQuestion([bot('Please enter your passcode'), you('1234'), bot('Logged out')]),
    null,
    'a historical X passcode is completed by the later logout response'
  );
  assert.equal(
    pendingBridgeQuestion([bot('Please enter your passcode')]),
    'Please enter your passcode'
  );
  assert.equal(
    pendingBridgeQuestion([bot('Please enter your passcode'), you('1234'), bot('Invalid passcode')]),
    'Please enter your passcode',
    'validation keeps the preceding question active'
  );
});

// ---- is there actually an engine behind this? ----
//
// This route answers 200 whether or not a bridge stack exists -- the GET falls
// back to policy-only so a fresh install can still render -- and native read
// that 200 as permission to open a login window. On 2026-08-29 it did exactly
// that on a machine with no homeserver: a real Meta password, a real harvested
// session, dropped. The policy fallback stays; it just has to SAY so now.

test('a fresh install still gets its policy, and is told the engine is down', async (t) => {
  const home = freshHome(t);
  const query = new URLSearchParams({ p: 'messenger' });
  const res = await bridgeApiResponse({
    method: 'GET', authorization: `Bearer ${TOKEN}`, query, home,
  });
  // Unchanged: policy renders without Matrix. This is the behaviour the
  // fallback exists for and it must not regress.
  assert.equal(res.status, 200);
  assert.equal(res.body.loginUrl, 'https://www.facebook.com/login/');
  assert.equal(res.body.connected, false);
  // New: and it no longer looks identical to a healthy stack.
  assert.equal(res.body.engine, 'down');
});

test('every platform reports an engine state, never undefined', async (t) => {
  const home = freshHome(t);
  for (const p of ['messenger', 'instagram', 'telegram']) {
    const res = await bridgeApiResponse({
      method: 'GET', authorization: `Bearer ${TOKEN}`, query: new URLSearchParams({ p }), home,
    });
    assert.ok(
      ['up', 'down', 'unknown'].includes(res.body.engine),
      `${p} answered engine=${String(res.body.engine)}`
    );
  }
});


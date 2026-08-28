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

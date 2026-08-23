// Tests for the social-bridge connect flow — the pure parts (platform table,
// panel rendering, cookie masking). The Matrix-relay functions need a live
// homeserver and are exercised end-to-end during setup, not here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, bridgeStatus } from '../lib/bridge.mjs';
import { renderBridgePage } from '../lib/bridgePage.mjs';

test('all platforms are defined with the fields the flow needs', () => {
  for (const id of ['messenger', 'instagram', 'twitter', 'telegram', 'discord', 'slack']) {
    const p = PLATFORMS[id];
    assert.ok(p, `${id} present`);
    assert.match(p.bot, /^@.+:hazlie\.local$/u);
    assert.ok(p.initial.length > 0);
    assert.ok(p.site.includes('.'));
  }
});

test('an unknown platform reads as not connected, never throws', () => {
  assert.deepEqual(bridgeStatus('nope'), { connected: false });
});

test('the panel renders the login surface when not connected', () => {
  const html = renderBridgePage(PLATFORMS.messenger, { token: 'T', transcript: [], begin: '!fb login facebook' });
  assert.match(html, /<title>Connect Messenger/u);
  assert.ok(html.includes('<textarea'), 'has a paste box');
  assert.ok(html.includes('Begin login'), 'has the begin button');
  assert.ok(html.includes('Copy as cURL'), 'has the cookie steps');
  assert.ok(html.includes('!fb login facebook'), 'begin command is the prefixed one');
  // No script: the panel must keep the strict CSP intact.
  assert.ok(!/<script/u.test(html), 'no script tags');
});

test('the connected panel says so and offers no paste box', () => {
  const html = renderBridgePage(PLATFORMS.instagram, {
    token: 'T',
    status: { connected: true, name: 'my.handle' },
  });
  assert.ok(html.includes('is linked'), 'reports linked');
  assert.ok(html.includes('my.handle'));
  assert.ok(!html.includes('<textarea'), 'no paste box once linked');
});

// The owner's pasted cookies must NEVER be echoed back into the page — a
// cURL/cookie blob in a "you" message is masked to a placeholder.
test('pasted cookies are masked in the transcript, not rendered back', () => {
  const secret = 'curl https://facebook.com -H "cookie: c_user=123; xs=abc; datr=xyz"';
  const html = renderBridgePage(PLATFORMS.messenger, {
    token: 'T',
    transcript: [
      { from: 'bot', body: 'Enter a JSON object with your cookies' },
      { from: 'you', body: secret },
    ],
  });
  assert.ok(!html.includes('c_user=123'), 'the cookie value must not appear');
  assert.ok(!html.includes('xs=abc'));
  assert.ok(html.includes('hidden here on purpose'), 'shows the masked placeholder');
  // The bot's own prompt is still shown.
  assert.ok(html.includes('Enter a JSON object'));
});

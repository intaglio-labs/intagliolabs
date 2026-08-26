// The web-login policy: one table, and it has to agree with itself.
//
// WHY THIS EXISTS. The decision "can this platform be linked by driving its real
// login page in an embedded webview" was written down three times — as
// `allowedSuffixes` hardcoded to Meta's four hosts in BridgeLogin.swift, as
// BRIDGE_FLOW in connections.js, and nowhere at all in connector-tile.js, which
// simply fired the web login for every bridge tile. They disagreed about four
// platforms. X had a login button and no matching host in the fence, so the
// window opened, its first navigation was cancelled, and it sat blank with no
// error while a cookie poll waited for a cookie that could never arrive.
//
// The policy now lives in PLATFORMS.webLogin and the widget enforces what the
// server sends. This file checks the table is coherent; widget/test/
// bridge-capabilities.test.mjs checks the widget side.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLATFORMS } from '../lib/bridge.mjs';

const entries = Object.entries(PLATFORMS);

test('every platform declares webLogin explicitly', () => {
  // Not optional. An absent key reads the same as null at runtime but means
  // "nobody decided", and this is exactly the decision that went unmade for
  // four platforms.
  const missing = entries.filter(([, p]) => !('webLogin' in p)).map(([id]) => id);
  assert.deepEqual(
    missing,
    [],
    `these platforms have no webLogin key — say null if the bridge takes a token ` +
      `or a phone code: ${missing.join(', ')}`
  );
});

test('a platform with a web login has hosts, a session cookie, and a reachable URL', () => {
  for (const [id, p] of entries) {
    if (!p.webLogin) continue;
    const { allowedHosts, sessionCookie } = p.webLogin;

    assert.ok(
      Array.isArray(allowedHosts) && allowedHosts.length > 0,
      `${id}: webLogin needs a non-empty allowedHosts — an empty fence cancels ` +
        `every navigation and produces a blank window`
    );
    for (const h of allowedHosts) {
      assert.ok(typeof h === 'string' && h.length > 0 && !h.startsWith('.') && !h.includes('/'),
        `${id}: "${h}" is not a bare host`);
    }
    assert.ok(
      typeof sessionCookie === 'string' && sessionCookie.length > 0,
      `${id}: webLogin needs the cookie name that means "logged in", or the poll ` +
        `never fires`
    );

    // THE ONE THAT CAUGHT X: the page the webview is pointed at must be inside
    // the fence that will judge it.
    const host = new URL(p.loginUrl).host;
    assert.ok(
      allowedHosts.some((h) => host === h || host.endsWith('.' + h)),
      `${id}: loginUrl host "${host}" is not covered by allowedHosts ` +
        `[${allowedHosts.join(', ')}] — the fence would cancel the first navigation`
    );

    // The harvest domain has to be real too, since it selects which cookies
    // get sent to the bridge.
    assert.ok(
      typeof p.cookieDomain === 'string' && p.cookieDomain.length > 0,
      `${id}: a cookie flow needs a cookieDomain to harvest from`
    );
  }
});

test('a platform without a web login is one that genuinely cannot use one', () => {
  // The honest half. Discord and Slack are token logins and Telegram is a phone
  // code; none can consume harvested cookies, so the answer is not a wider fence
  // but no embedded flow at all. If a platform lands here with a cookie-shaped
  // login command, somebody disabled a flow that should work.
  for (const [id, p] of entries) {
    if (p.webLogin) continue;
    const tokenOrPhone = /token|^login$/u.test(p.initial) || p.cookieDomain === null;
    assert.ok(
      tokenOrPhone,
      `${id}: webLogin is null but its login command is "${p.initial}" and it has a ` +
        `cookieDomain — that looks like a cookie flow, so either give it a webLogin ` +
        `or say here why it cannot have one`
    );
  }
});

test('the platforms that do have a web login are the ones we expect', () => {
  // A roster, so adding or removing one is a deliberate edit rather than a
  // side effect. Four cookie flows: LinkedIn joined 2026-08-25 when it stopped
  // being a hand-unzipped CSV export and became a bridge like the others.
  const withWeb = entries.filter(([, p]) => p.webLogin).map(([id]) => id).sort();
  assert.deepEqual(withWeb, ['instagram', 'linkedin', 'messenger', 'twitter']);
});

test('cookie format is declared per platform, and only LinkedIn wants a header', () => {
  // The shape the harvested cookies are sent in is the SERVER's call — Swift
  // enforces it and never decides it, same as allowedHosts. Pinned as a roster
  // because getting it wrong is silent: the Meta and X bridges name each cookie
  // as its own field, so a JSON object lands correctly there, while
  // mautrix-linkedin has ONE field wanting a raw Cookie header and receives an
  // empty value from that same JSON — a login that looks done and is not
  // (2026-08-25).
  const header = entries
    .filter(([, p]) => p.webLogin?.cookieFormat === 'header')
    .map(([id]) => id).sort();
  assert.deepEqual(header, ['linkedin']);
  for (const [id, p] of entries) {
    if (!p.webLogin) continue;
    const fmt = p.webLogin.cookieFormat ?? 'json';
    assert.ok(['json', 'header'].includes(fmt), `${id}: unknown cookieFormat ${fmt}`);
  }
});

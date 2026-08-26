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

test('a platform without a web login says why, in words', () => {
  // The honest half: no embedded flow must be a decision, not a gap.
  //
  // ~~This inferred the reason from the login command, passing anything whose
  // command matched /token|^login$/.~~ That heuristic was written when token
  // and phone were the only non-cookie flows, and it aged badly: Slack's real
  // flow is `login email`, which the pattern reads as cookie-shaped and
  // rejects, while a genuinely wrong `login-token` sailed through for months
  // because it contained the word "token" (2026-08-26). A sentence cannot be
  // satisfied by accident.
  for (const [id, p] of entries) {
    if (p.webLogin) continue;
    assert.ok(
      typeof p.noWebLogin === 'string' && p.noWebLogin.length > 12,
      `${id}: webLogin is null with no noWebLogin reason — say in one line what ` +
        `this platform signs in with instead, so the next reader knows whether ` +
        `it is a decision or an omission`
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

test('the field contract is declared per platform, and only LinkedIn has one', () => {
  // The shape the harvested cookies are sent in is the SERVER's call — Swift
  // enforces it and never decides it, same as allowedHosts. Pinned as a roster
  // because getting it wrong is silent: the Meta and X bridges name each cookie
  // as its own field, so a JSON object lands correctly there, while
  // mautrix-linkedin has ONE field wanting a raw Cookie header and receives an
  // empty value from that same JSON — a login that looks done and is not
  // (2026-08-25).
  const withFields = entries.filter(([, p]) => p.webLogin?.fields).map(([id]) => id).sort();
  assert.deepEqual(withFields, ['linkedin']);

  // Every field must be one the login window knows how to satisfy. A `header`
  // field additionally names the header to capture — without it the window
  // would wait forever for something it was never told to look for.
  for (const [id, p] of entries) {
    for (const f of p.webLogin?.fields ?? []) {
      assert.ok(f.id, `${id}: a field with no id`);
      assert.ok(['cookies', 'header'].includes(f.from), `${id}: unknown field source ${f.from}`);
      if (f.from === 'header') assert.ok(f.header, `${id}: header field ${f.id} names no header`);
    }
  }
});

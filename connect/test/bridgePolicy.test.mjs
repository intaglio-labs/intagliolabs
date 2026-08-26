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
import { readFileSync } from 'node:fs';

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLATFORMS, bridgeNeedsAppCredential } from '../lib/bridge.mjs';

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
    // TWO SHAPES OF WEB LOGIN, and each needs its own finish condition.
    // A HARVEST waits for a session cookie to appear. A FIELD login waits for
    // the values its `fields` contract names — Slack's window exists only to
    // let the person answer a CAPTCHA, and harvests no session at all, so
    // demanding a sessionCookie of it would be demanding the wrong thing.
    // What both must have is SOMETHING to wait for; a window with neither
    // never closes.
    const waitsForCookie = typeof sessionCookie === 'string' && sessionCookie.length > 0;
    const waitsForFields = Array.isArray(p.webLogin.fields) && p.webLogin.fields.length > 0;
    // The third shape: an APPROVAL window waits for nothing on purpose. The
    // person approves on the platform's own page and the bridge reports the
    // outcome itself, so the only way out is closing the window — which is
    // correct here and would be a hang anywhere else.
    assert.ok(
      waitsForCookie || waitsForFields || p.webLogin.approval === true,
      `${id}: webLogin waits for nothing — name the cookie that means "logged ` +
        `in", the fields the bridge asks for, or mark it approval: true`
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
    // get sent to the bridge — but only for the flows that harvest one.
    if (waitsForCookie) {
      assert.ok(
        typeof p.cookieDomain === 'string' && p.cookieDomain.length > 0,
        `${id}: a cookie flow needs a cookieDomain to harvest from`
      );
    }
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
  // ~~Slack was briefly here for its CAPTCHA and was withdrawn the same day:
  // slack.com/signin will not render in a WKWebView at all.~~ It renders; the
  // withdrawal was measured against two user-agent strings that had both aged
  // onto Slack's deprecated list, and the gate is server-side and keyed on
  // exactly that. Back on the roster 2026-08-26, with the evidence in
  // PLATFORMS.slack. FIFTH member, and the one whose window harvests no
  // cookies at all — it waits on a field.
  // Discord was briefly here as an approval window and was withdrawn the same
  // day: its approval is a QR the phone app scans, which needs no window.
  assert.deepEqual(withWeb, ['instagram', 'linkedin', 'messenger', 'slack', 'twitter']);
});

test('a login window may leave the platform only for that platform\'s own SSO', () => {
  // WIDENING THIS FENCE IS THE SERIOUS EDIT IN THIS FILE. It is the list of
  // hosts an in-app webview may navigate to while the owner is typing a
  // password into it, so it is pinned host by host: a new one has to be added
  // here on purpose, in the same commit, next to the reason.
  //
  // Slack's page offers Google and Apple alongside email, and until 2026-08-26
  // the fence cancelled both silently — a dead button with no error anywhere.
  // These four are what a fenceless probe measured the flows touching.
  const fences = Object.fromEntries(
    entries.filter(([, p]) => p.webLogin).map(([id, p]) => [id, [...p.webLogin.allowedHosts].sort()]));
  assert.deepEqual(fences.slack,
    ['accounts.google.com', 'accounts.youtube.com', 'appleid.apple.com', 'slack.com']);

  // Every other platform's window stays on the platform's own hosts. Said as an
  // assertion rather than a habit: an SSO detour is legitimate ONLY because the
  // platform's own login page offers it, and nothing else here does.
  for (const [id, hosts] of Object.entries(fences)) {
    if (id === 'slack') continue;
    for (const h of hosts) {
      assert.ok(!/google|apple|microsoft|okta/i.test(h),
        `${id}: identity-provider host ${h} in a fence that has no SSO button behind it`);
    }
  }

  // And every host in every fence is declared in the egress ledger, which is
  // where the owner reads what this software may contact. The tripwire in
  // connectors/test/egress.test.mjs scans source for URLs and does not catch a
  // bare hostname in an array, so this is the half of that rule it cannot see.
  const ledger = JSON.parse(readFileSync(new URL('../../ops/EGRESS.json', import.meta.url), 'utf8'));
  const declared = new Set(ledger.paths.map((e) => e.host));
  for (const [id, hosts] of Object.entries(fences)) {
    for (const h of hosts) {
      assert.ok(declared.has(h), `${id}: fence host ${h} is not declared in ops/EGRESS.json`);
    }
  }
});

test('the QR-window roster is exactly the platforms with no page to drive', () => {
  // A THIRD SHAPE, and it is not a webLogin: qrLogin means the window shows an
  // image the bridge posted and waits, with nothing navigated to and nothing
  // harvested. Pinned as a roster for the same reason webLogin is — turning it
  // on opens a window at someone, and that should be an edit you can see in a
  // diff rather than a truthy field that appeared.
  const withQr = entries.filter(([, p]) => p.qrLogin).map(([id]) => id).sort();
  assert.deepEqual(withQr, ['discord']);

  // The two are mutually exclusive by construction: a platform whose real
  // login page can be driven has no business showing a QR instead, and one
  // that has no such page cannot also declare hosts to fence.
  for (const [id, p] of entries) {
    assert.ok(!(p.qrLogin && p.webLogin),
      `${id}: declares both a web login and a QR window — one window, one flow`);
  }
});

test('the platforms on a non-bridgev2 schema are the ones we expect', () => {
  // bridgeStatus reads a bridge's own DB, and its default query is bridgev2's
  // (`user_login`). A platform on an older schema must override it, and
  // getting that wrong is INVISIBLE: the query throws, the read is best-effort,
  // and the exception comes back as "not connected". Discord spent its whole
  // existence in this repo reporting disconnected while logged in, portals
  // backfilling, because mautrix-discord predates bridgev2 (owner, 2026-08-26:
  // "doesn't seem like it actually worked" — it had).
  const overridden = entries.filter(([, p]) => p.statusSql).map(([id]) => id).sort();
  assert.deepEqual(overridden, ['discord']);

  // An override has to answer the same question the default does, or
  // bridgeStatus reads undefined and calls it an unnamed account.
  for (const [id, p] of entries) {
    if (!p.statusSql) continue;
    assert.match(p.statusSql, /\bAS remote_name\b/u,
      `${id}: statusSql must project a remote_name column — bridgeStatus reads ` +
        `row.remote_name and nothing else`);
  }
});

test('the app-credential roster, and what it answers', () => {
  // A platform declares `appCredential` when its bridge cannot start until
  // someone supplies a credential the PRODUCT may ship (widget/build.sh bakes
  // one in, ops/setup-bridges.sh writes it). Pinned as a roster because the
  // answer drives whether the card shows a paste walkthrough, and offering to
  // overwrite a working pair is worse than not offering at all.
  const withApp = entries.filter(([, p]) => p.appCredential).map(([id]) => id).sort();
  assert.deepEqual(withApp, ['telegram']);

  for (const [id, p] of entries) {
    if (!p.appCredential) continue;
    assert.ok(typeof p.appCredential.file === 'string' && p.appCredential.file.length > 0,
      `${id}: appCredential needs the config file to read`);
    assert.ok(p.appCredential.unset instanceof RegExp,
      `${id}: appCredential.unset must be a RegExp — it is matched against the file`);
  }

  // The four answers, because only the first one puts a paste box on screen
  // and the other three must not. "Cannot see the config" is deliberately
  // FALSE: guessing yes would ask someone to configure a bridge that may
  // already be working (owner, 2026-08-26).
  const home = mkdtempSync(join(tmpdir(), 'hz-appcred-'));
  mkdirSync(join(home, '.hazlie', 'matrix', 'telegram'), { recursive: true });
  const cfg = join(home, '.hazlie', 'matrix', 'telegram', 'config.yaml');

  // mautrix ships api_id 12345 as its example and refuses to start on it, so
  // that value is the "nobody configured this" signal — an empty key never
  // appears, which is why this matches a placeholder rather than emptiness.
  writeFileSync(cfg, 'network:\n  api_id: 12345\n  api_hash: "tbd"\n');
  assert.equal(bridgeNeedsAppCredential('telegram', { home }), true, 'placeholder → needs one');

  // A MADE-UP id on purpose. The real one is a credential, and Telegram
  // refuses logins made with any api_id it finds in public code — putting the
  // product's own into a fixture would break every install, which is the same
  // trap the note at PLATFORMS.telegram exists to warn about. Any number that
  // is not 12345 exercises this branch.
  writeFileSync(cfg, 'network:\n  api_id: 99999999\n  api_hash: "real"\n');
  assert.equal(bridgeNeedsAppCredential('telegram', { home }), false, 'configured → does not');

  assert.equal(bridgeNeedsAppCredential('telegram', { home: join(home, 'nope') }), false,
    'no config → false, not a guess');
  assert.equal(bridgeNeedsAppCredential('discord', { home }), false,
    'a platform that declares nothing is never asked for a credential');
});

test('the field contract is declared per platform, for the two that need one', () => {
  // The shape the harvested cookies are sent in is the SERVER's call — Swift
  // enforces it and never decides it, same as allowedHosts. Pinned as a roster
  // because getting it wrong is silent: the Meta and X bridges name each cookie
  // as its own field, so a JSON object lands correctly there, while
  // mautrix-linkedin has ONE field wanting a raw Cookie header and receives an
  // empty value from that same JSON — a login that looks done and is not
  // (2026-08-25).
  const withFields = entries.filter(([, p]) => p.webLogin?.fields).map(([id]) => id).sort();
  // Slack's is the other shape entirely: one `captcha` field and no cookie
  // harvest, because its window exists so a human can answer a challenge and
  // hand back the token that answering produced.
  assert.deepEqual(withFields, ['linkedin', 'slack']);

  // Every field must be one the login window knows how to satisfy. A `header`
  // field additionally names the header to capture — without it the window
  // would wait forever for something it was never told to look for.
  for (const [id, p] of entries) {
    for (const f of p.webLogin?.fields ?? []) {
      assert.ok(f.id, `${id}: a field with no id`);
      assert.ok(['cookies', 'header', 'captcha'].includes(f.from),
        `${id}: unknown field source ${f.from}`);
      if (f.from === 'header') assert.ok(f.header, `${id}: header field ${f.id} names no header`);
    }
  }
});

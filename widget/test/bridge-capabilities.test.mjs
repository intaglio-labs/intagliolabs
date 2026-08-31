// The bridge's capability map, checked against what the pages actually call.
//
// Every webview registers the same Bridge under the same handler name, so the
// dispatch used to switch on the message type alone: any page could call any
// action. Bridge.pageCapabilities is the compartment. This file is what keeps it
// honest, because a capability map is the kind of thing that is correct on the
// day it is written and wrong two features later — and both directions of drift
// are silent. A missing entry breaks a button; a stale entry quietly re-widens
// the surface it was added to narrow.
//
// It reads three sources and cross-checks them:
//   1. the `case "x":` labels in the Swift dispatch  — what exists
//   2. the <script> tags in each page's HTML          — which JS runs where
//   3. the hzPost('x') calls in that JS               — what each page asks for
//
// No Swift toolchain needed; this is a source scan, the same approach as
// connectors/test/egress.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');
const permissionsSwift = readFileSync(join(WIDGET, 'src', 'Permissions.swift'), 'utf8');
const bridgeLoginSwift = readFileSync(join(WIDGET, 'src', 'BridgeLogin.swift'), 'utf8');
const googleLoginSwift = readFileSync(join(WIDGET, 'src', 'GoogleLogin.swift'), 'utf8');
const connections = readFileSync(join(WIDGET, 'ui', 'connections.js'), 'utf8');
const connectorTile = readFileSync(join(WIDGET, 'ui', 'connector-tile.js'), 'utf8');
const bridgeUi = readFileSync(join(WIDGET, 'ui', 'bridge.js'), 'utf8');
const palette = readFileSync(join(WIDGET, 'ui', 'palette.css'), 'utf8');
const people = readFileSync(join(WIDGET, 'ui', 'people.js'), 'utf8');
// The shared tile/card both surfaces render from.
const tile = readFileSync(join(WIDGET, 'ui', 'connector-tile.js'), 'utf8');

// --- 1. what the dispatch handles -------------------------------------------
const dispatchCases = new Set(
  [...swift.matchAll(/^ {4}case "([A-Za-z]+)":/gmu)].map((m) => m[1])
);

// --- the declared map ------------------------------------------------------
function swiftStringList(block) {
  return [...block.matchAll(/"([A-Za-z-]+)"/gu)].map((m) => m[1]);
}

const sharedBlock = /static let sharedActions: Set<String> = \[([\s\S]*?)\]/u.exec(swift);
assert.ok(sharedBlock, 'Bridge.sharedActions not found — did the declaration move?');
const sharedActions = new Set(swiftStringList(sharedBlock[1]));

const capsBlock = /static let pageCapabilities: \[String: Set<String>\] = \[([\s\S]*?)\n {2}\]/u.exec(swift);
assert.ok(capsBlock, 'Bridge.pageCapabilities not found — did the declaration move?');
const declared = new Map();
for (const m of capsBlock[1].matchAll(/"([A-Za-z-]+)":\s*\[([\s\S]*?)\]/gu)) {
  declared.set(m[1], new Set(swiftStringList(m[2])));
}

// --- 2 + 3. what each page actually asks for -------------------------------
// The page's scripts come from its own <script> tags, which is the only record
// of what runs where. Reading a file's comments instead is how the map got
// people/ wrong the first time: connector-tile.js describes itself as shared,
// and the script tags show it is included by people.html.
function pagesFromHtml() {
  const uiDir = join(WIDGET, 'ui');
  const pages = new Map();
  for (const name of readdirSync(uiDir)) {
    if (!name.endsWith('.html')) continue;
    const html = readFileSync(join(uiDir, name), 'utf8');
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/gu)].map((m) => m[1]);
    pages.set(name.replace(/\.html$/u, ''), scripts);
  }
  return pages;
}

// Calls do not all spell themselves `hzPost('x')`, and assuming they did made
// the first version of this file pass VACUOUSLY for the ear page: ear-main.js
// contains zero literal hzPost calls, because it wraps it as
// `const post = (type, payload) => hzPost(type, payload)` and calls post('orbState').
// So the page with the microphone was the one page whose compartment nothing
// checked. Caught by asking why its call set was empty, which is the question
// the floor below now asks automatically.
//
// Three shapes are resolved, and anything left unresolved is REPORTED rather
// than skipped — a call this scanner cannot read is a capability it cannot
// verify, and silence there is what produced the hole.
function scanCalls(text) {
  const calls = new Set();
  const unresolved = [];

  // Local aliases that forward to hzPost: `const post = (a, b) => hzPost(a, b)`.
  const aliases = new Set(['hzPost']);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*?=>\s*hzPost\(/gu)) {
    aliases.add(m[1]);
  }
  const aliasGroup = [...aliases].join('|');

  // 1. A literal first argument, through hzPost or any alias of it.
  for (const m of text.matchAll(new RegExp(`\\b(?:${aliasGroup})\\(\\s*'([A-Za-z]+)'`, 'gu'))) {
    calls.add(m[1]);
  }
  // 2. The settings rows carry their action as `message: 'setSounds'` and are
  //    dispatched through a variable, so the literal never sits next to a call.
  for (const m of text.matchAll(/message:\s*'([A-Za-z]+)'/gu)) calls.add(m[1]);
  // 3. Anything else — a non-literal first argument this scanner cannot follow.
  for (const m of text.matchAll(new RegExp(`\\b(?:${aliasGroup})\\(\\s*([A-Za-z_$][\\w$]*)`, 'gu'))) {
    // The alias declarations themselves forward a parameter; not a call site.
    if (aliases.has(m[1]) || /^(type|payload)$/u.test(m[1])) continue;
    unresolved.push(m[1]);
  }
  return { calls, unresolved };
}

function callsIn(scripts) {
  const calls = new Set();
  const unresolved = new Set();
  for (const script of scripts) {
    let text;
    try {
      text = readFileSync(join(WIDGET, 'ui', script), 'utf8');
    } catch {
      continue; // a script served from elsewhere; nothing to read here
    }
    const found = scanCalls(text);
    for (const c of found.calls) calls.add(c);
    for (const u of found.unresolved) unresolved.add(`${script}: ${u}`);
  }
  return { calls, unresolved };
}

const pageScripts = pagesFromHtml();

test('every page can call everything it actually calls', () => {
  const denied = [];
  for (const [page, scripts] of pageScripts) {
    const allowed = declared.get(page);
    assert.ok(
      allowed,
      `ui/${page}.html exists but Bridge.pageCapabilities has no entry for "${page}" — ` +
        `every message from it would be refused.`
    );
    for (const call of callsIn(scripts).calls) {
      if (!dispatchCases.has(call)) continue; // handled below, separately
      if (sharedActions.has(call) || allowed.has(call)) continue;
      denied.push(`${page} calls ${call}`);
    }
  }
  assert.deepEqual(
    denied,
    [],
    `a page calls an action its compartment forbids, so the button silently ` +
      `errors:\n  ${denied.join('\n  ')}`
  );
});

// Scripts every page loads (bridge.js) say nothing about any ONE page, so the
// floor below must not count them. The first version did, and that made the
// floor vacuous: bridge.js contributes prefs and fitContent to every page, so no
// page could ever reach zero and the check could never fire. Found by trying to
// make it fire and watching it stay green — which is the only way to find out.
const sharedScripts = (() => {
  const lists = [...pageScripts.values()];
  if (lists.length === 0) return new Set();
  return new Set(lists[0].filter((sc) => lists.every((l) => l.includes(sc))));
})();

const ownScripts = (scripts) => scripts.filter((sc) => !sharedScripts.has(sc));

test('every page yields at least one readable call of its own', () => {
  // THE FLOOR, and this file needed one for the same reason the egress tripwire
  // did: a scanner that reads nothing passes everything. The ear page proved it
  // — its calls go through a wrapper, the scanner saw none, and its compartment
  // was unverified while the suite stayed green. Counted over the page's OWN
  // scripts, so a shared file cannot prop the number up.
  const silent = [];
  for (const [page, scripts] of pageScripts) {
    if (callsIn(ownScripts(scripts)).calls.size === 0) silent.push(page);
  }
  assert.deepEqual(
    silent,
    [],
    `these pages yielded no readable bridge calls of their own, so their ` +
      `compartment is ` +
      `asserted against nothing:\n  ${silent.join('\n  ')}\n` +
      `Either they genuinely call nothing (say so here) or the scanner cannot ` +
      `read how they call — which is the bug this test exists to prevent.`
  );
});

test('no page calls the bridge in a way this scanner cannot read', () => {
  // A dynamic first argument means a capability nobody can check statically.
  const KNOWN_DYNAMIC = new Set([
    'connections.js: message', // resolved via the `message: 'setX'` literals above
  ]);
  const surprises = [];
  for (const [page, scripts] of pageScripts) {
    for (const u of callsIn(scripts).unresolved) {
      if (!KNOWN_DYNAMIC.has(u)) surprises.push(`${page} → ${u}`);
    }
  }
  assert.deepEqual(
    surprises,
    [],
    `a bridge call is made through a variable this scanner cannot resolve, so ` +
      `the capability map cannot be checked against it:\n  ${surprises.join('\n  ')}\n` +
      `Either make the call site literal, or add it to KNOWN_DYNAMIC with why it is safe.`
  );
});

test('every declared capability is one the dispatch handles', () => {
  const ghosts = [];
  for (const [page, allowed] of declared) {
    for (const action of allowed) {
      if (!dispatchCases.has(action)) ghosts.push(`${page}: ${action}`);
    }
  }
  for (const action of sharedActions) {
    if (!dispatchCases.has(action)) ghosts.push(`sharedActions: ${action}`);
  }
  assert.deepEqual(
    ghosts,
    [],
    `the map grants actions the dispatch does not implement — either a rename ` +
      `left this behind, or the grant was always imaginary:\n  ${ghosts.join('\n  ')}`
  );
});

test('every dispatch case is reachable from some page', () => {
  // The other direction. An action no compartment grants is dead code that
  // looks live: it is handled, it is documented by its own case body, and
  // nothing can ever call it. Better to notice here than to debug a button.
  const granted = new Set(sharedActions);
  for (const allowed of declared.values()) for (const a of allowed) granted.add(a);
  const orphans = [...dispatchCases].filter((c) => !granted.has(c)).sort();
  assert.deepEqual(
    orphans,
    [],
    `these actions are handled but no page may call them:\n  ${orphans.join('\n  ')}\n` +
      `Grant them to a surface or delete the case.`
  );
});

test('every page in the map is a real page', () => {
  const real = new Set(pageScripts.keys());
  const phantom = [...declared.keys()].filter((p) => !real.has(p));
  assert.deepEqual(phantom, [], `the map names pages with no ui/<page>.html: ${phantom.join(', ')}`);
});

test('native web login carries every server-authored policy feature to the login window', () => {
  const block = /case "bridgeWebLogin":([\s\S]*?)\n {4}\/\/ ---- setup:/u.exec(swift)?.[1];
  assert.ok(block, 'bridgeWebLogin handler not found');

  for (const field of [
    'requiredCookies', 'cookieFormat', 'fields', 'approval', 'userAgent',
    'allowedFrameHosts', 'browserHandoff', 'storageUrl',
  ]) {
    assert.match(block, new RegExp(`begin\\["${field}"\\]`, 'u'), `${field} is read from server policy`);
    assert.match(block, new RegExp(`${field}: ${field}`, 'u'), `${field} is passed to BridgeLogin`);
    assert.match(bridgeLoginSwift, new RegExp(`\\b${field}:`, 'u'), `BridgeLogin accepts ${field}`);
  }
  assert.match(block, /begin\["qrLogin"\]/u, 'QR policy is handled by the native QR window');
});

test('model setup reinstalls both launch agents with the selected machine profile', () => {
  assert.match(swift, /Provision\.installAgent\("io\.intaglio\.llama-server"\)/u);
  assert.match(swift, /Provision\.installAgent\("io\.intaglio\.hermes"\)/u);
  assert.doesNotMatch(swift, /com\.hazlie\.(?:llama-server|hermes)/u);
});

// ~~The credential reassurance is middle-aligned.~~ It was, while the domain sat
// beside it at the same weight. The domain now carries the weight and the full
// foreground -- it is the one fact in this header worth reading -- and the
// reassurance moved to the opposite end, quieter, so the two do not compete and
// cannot collide as a domain grows.
test('the domain leads the header and the reassurance stays out of its way', () => {
  const block = /let host = makeLabel\(([\s\S]*?)view\.addSubview\(sub\)/u.exec(bridgeLoginSwift)?.[1];
  assert.ok(block, 'header block not found');
  assert.match(block, /font: monoBold, color: fg/u, 'the domain is the emphasised element');
  assert.match(block, /sub\.alignment = \.right/u, 'the reassurance sits opposite it');
  assert.match(block, /color: muted/u, 'and stays quieter than the domain');
});

// THE DOMAIN IS A SECURITY SURFACE, so what it claims must come from the live URL
// rather than from the platform we intended to open.
test('the login window shows a live, scheme-aware domain', () => {
  assert.match(bridgeLoginSwift, /func showHost\(_ url: URL\?\)/u, 'it reads a URL, so it can judge the scheme');
  assert.match(bridgeLoginSwift, /url\.scheme\?\.lowercased\(\) == "https"/u, 'it checks the scheme');
  assert.match(bridgeLoginSwift, /dropFirst\(4\)/u, 'www. is noise and is dropped');
  // didCommit is what makes it live: a login that hops hosts must rename it.
  assert.match(
    bridgeLoginSwift,
    /didCommit navigation[\s\S]{0,120}showHost\(webView\.url\)/u,
    'the domain must follow the page, or it is a claim that goes stale'
  );
  // ~~A lock glyph, then the whole url.~~ Both tried, both reverted: a lock is a
  // summary somebody has to be trusted for, and a full url in mono is a wall of
  // text that reads as less trustworthy in a window this size.
  assert.doesNotMatch(bridgeLoginSwift, /absoluteString/u, 'the full-url version is gone');
  assert.doesNotMatch(bridgeLoginSwift, /"🔒/u, 'the lock glyph is gone');
});

test('Google OAuth opens in the system browser, never an embedded webview', () => {
  assert.match(googleLoginSwift, /NSWorkspace\.shared\.open\(target\)/u);
  assert.doesNotMatch(googleLoginSwift, /^import WebKit$/mu);
  assert.doesNotMatch(googleLoginSwift, /WKWebView\s*\(/u);
  assert.doesNotMatch(googleLoginSwift, /\.customUserAgent\s*=/u);
});

test('Settings mounts its controls without the retired memory-review row', () => {
  assert.match(connections, /rows\.push\(settingRow\(/u);
  assert.match(connections, /rows\.push\(modelRow\(\)\)/u);
  assert.match(connections, /settings\.replaceChildren\(\.\.\.rows\)/u);
  assert.doesNotMatch(connections, /actionRow|what i have learned|openMemoryReview/u);
  assert.doesNotMatch(swift, /openMemoryReview/u);
});

// ~~People starts the same Google authorization action as Settings.~~ It did, and
// the shared behaviour is still the point -- it is just that both now say
// "coming soon" (owner, 2026-08-27). Sign-in reached a "Which Google account?"
// picker, a second small menu inside a panel where every other tile loads its
// login straight away, and an inconsistent flow for an unfinished connector is
// not worth keeping wired.
test('People and Settings park only unfinished connectors', () => {
  // Neither surface may start the flow from a tile any more.
  assert.ok(!/hzPost\('googleAuth'/u.test(people), 'the People ring must not start sign-in');
  assert.ok(
    !/startGoogleAuth\(\s*tip\.querySelector/u.test(connections),
    'the Settings tile press must not start sign-in'
  );
  // And both must actually SAY so, from the shared card and from Settings' own.
  assert.match(tile, /HZ_SOON_CONNECTORS\.has\(HZ_KIND\(src\.id\)\)[\s\S]{0,400}coming soon/u,
    'the shared card says it, which is what the People ring renders');
  assert.match(connections, /SOON_CONNECTORS\.has\(kindOf\(src\.id\)\)/u,
    'Settings uses the same unfinished-connector gate');
  assert.match(connections, /const renderSoon = \(\) => \{[\s\S]{0,300}coming soon/u,
    'and Settings says it too');
  assert.match(tile, /HZ_SOON_CONNECTORS = new Set\(\['mail'\]\)/u,
    'the shared card parks only Mail');
  assert.match(connections, /SOON_CONNECTORS = new Set\(\['mail'\]\)/u,
    'Settings parks only Mail');
  assert.doesNotMatch(tile, /HZ_SOON_CONNECTORS[^\n]*twitter/u, 'X ships in the shared tile');
  assert.doesNotMatch(connections, /SOON_CONNECTORS[^\n]*twitter/u, 'X ships in Settings');
  assert.doesNotMatch(tile, /HZ_SOON_CONNECTORS[^\n]*telegram/u, 'Telegram ships in the shared tile');
  assert.doesNotMatch(connections, /SOON_CONNECTORS[^\n]*telegram/u, 'Telegram ships in Settings');
});

test('Telegram starts a phone-and-code login on the first press on both surfaces', () => {
  assert.match(connections, /telegram:\s*\{\s*place: 'phone number'/u,
    'Settings declares Telegram as a phone conversation');
  assert.match(connections, /!started[\s\S]*autoBegun\.add\(src\.id\)[\s\S]*bridgeBegin/u,
    'Settings automatically begins a fresh Telegram conversation');
  assert.match(tile, /const telegramPhone = HZ_KIND\(src\.id\) === 'telegram'/u,
    'the shared card preserves Telegram phone-flow state after the first reply');
  assert.match(tile, /!transcript\.length && !hzAutoBegun\.has\(src\.id\)[\s\S]*startTelegram\(\)/u,
    'the shared card starts Telegram without a second begin-login press');
  assert.match(tile, /if \(data && data\.connected\)[\s\S]{0,220}hzAutoBegun\.delete\(src\.id\)/u,
    'a completed attempt releases the first-press guard for a later reconnect');
  assert.match(tile, /Keep the guard set while painting the failure[\s\S]{0,400}renderBridge\(\{ state: 'down' \}\)/u,
    'an unavailable bridge settles on a retry card instead of auto-starting forever');
  assert.match(tile, /hzPost\('bridgeCookies', \{ p: 'telegram', cookies: value \}\)/u,
    'the shared card relays phone, code, and password answers locally');
  assert.match(connections, /secretAnswer = secretPin \|\| \/\\bpassword\\b\/[iu]+\.test\(asked\)/u);
  assert.match(connections, /if \(secretAnswer && !multiline\)[\s\S]{0,120}box\.type = 'password'/u,
    'Settings masks Telegram two-step-verification passwords');
  assert.match(tile, /answer\.type = password \? 'password'/u,
    'the shared card masks Telegram two-step-verification passwords');
  assert.match(connections, /phoneAnswer[\s\S]{0,500}!box\.value\.startsWith\('\+'\)[\s\S]{0,160}box\.value = `\+1 /u,
    'Settings adds the US calling code when an ordinary phone number begins');
  assert.match(tile, /if \(phone\) answer\.addEventListener\('input'[\s\S]{0,300}!answer\.value\.startsWith\('\+'\)[\s\S]{0,160}answer\.value = `\+1 /u,
    'the shared card adds the US calling code while preserving explicit international codes');
});

test('X Chat passcode is a four-digit encrypted-DM step on both surfaces', () => {
  for (const [name, source] of [['Settings', connections], ['People', tile]]) {
    assert.match(source, /enter your 4-digit X Chat passcode/u, `${name} names the passcode`);
    assert.match(source, /not your X password or 2FA code/u, `${name} explains the credential`);
    assert.match(source, /type = 'password'/u, `${name} masks the passcode`);
    assert.match(source, /inputMode = 'numeric'/u, `${name} requests a numeric keyboard`);
    assert.match(source, /maxLength = 4/u, `${name} enforces the length`);
    assert.match(source, /\^\\d\{4\}\$/u, `${name} rejects an incomplete passcode`);
    assert.match(source, /bridgeCookies[^\n]*cookies: (val|value)/u, `${name} relays locally`);
  }
  assert.match(bridgeLoginSwift, /func showPasscode\(question: String/u,
    'the native login window owns the normal X passcode step');
  assert.match(bridgeLoginSwift, /NSSecureTextField/u, 'the native passcode stays masked');
  assert.match(bridgeLoginSwift, /"\^\[0-9\]\{4\}\$"/u, 'native rejects incomplete passcodes');
  assert.match(bridgeLoginSwift, /completeHarvest[\s\S]*afterHarvest\(json, self\)/u,
    'cookie harvest transitions into the local continuation without closing the window');
});

test('X resumes pending bridge state and reconciles asynchronous completion', () => {
  const nativeLogin = /case "bridgeWebLogin":([\s\S]*?)\n {4}\/\/ ---- setup:/u.exec(swift)?.[1];
  assert.ok(nativeLogin, 'native bridgeWebLogin handler is missing');
  assert.match(nativeLogin, /p == "twitter"[\s\S]*xPasscodeQuestion\(begin\)[\s\S]*BridgeLogin\.presentPasscode/u,
    'an already-pending X passcode opens natively on the first tile press');
  assert.match(nativeLogin, /let inlineX = p == "twitter"[\s\S]*afterHarvest[\s\S]*awaitXBridgeStep/u,
    'fresh X cookies remain in the login window until the bridge asks its follow-up');
  assert.match(nativeLogin, /afterHarvest: afterHarvest/u,
    'the X continuation is handed to the web-login controller');
  assert.doesNotMatch(connections, /resumeOrStartBridgeLogin/u,
    'Settings must not make a preliminary status request before the login action');
  assert.doesNotMatch(tile, /hzPost\('bridgeStatus'[\s\S]{0,300}beginWebLogin/u,
    'the shared tile must not make a preliminary status request before the login action');
  assert.match(tile, /function hzSettleCookieLogin/u);
  assert.match(tile, /function hzSettleBridgeAnswer/u);
  assert.match(tile, /data\.connected && !src\.connected[\s\S]*refresh\(\)/u);
});

test('a login launched from the non-activating Settings panel rises on its first click', () => {
  const presenter = /private func presentLoginWindow\(_ win: NSWindow\) \{([\s\S]*?)\n  \}/u
    .exec(bridgeLoginSwift)?.[1];
  assert.ok(presenter, 'the native login-window presenter is missing');
  assert.match(presenter, /NSApp\.activate\(ignoringOtherApps: true\)/u);
  assert.match(presenter, /DispatchQueue\.main\.async/u,
    'AppKit activation must get a run-loop turn before the final foreground pass');
  assert.match(presenter, /self\.window === win/u,
    'a superseded login window must never be raised later');
  assert.match(presenter, /win\.orderFrontRegardless\(\)/u,
    'the settled pass must not depend on the non-activating source panel');
  assert.ok((bridgeLoginSwift.match(/presentLoginWindow\(win\)/gu) || []).length >= 3,
    'web, QR, and local continuation surfaces use the first-click presenter');
  assert.match(bridgeLoginSwift, /installLocalBody[\s\S]*presentLoginWindow\(win\)/u,
    'the in-place passcode continuation remains in the foreground');
});

test('Settings focus refresh cannot detach a connector during its first click', () => {
  assert.match(connections, /window\.addEventListener\('focus', scheduleFocusRefresh\)/u,
    'focus schedules rather than immediately rebuilding the connector shelf');
  assert.match(connections, /document\.addEventListener\('pointerdown'[\s\S]{0,220}clearTimeout\(focusRefreshTimer\)/u,
    'the first pointer press pauses the scheduled focus refresh');
  assert.match(connections, /document\.addEventListener\('pointerup', finishSettingsPointer[\s\S]{0,180}pointercancel/u,
    'pointer completion releases the deferred refresh');
  assert.match(connections, /if \(settingsPointerDown\)[\s\S]{0,120}focusRefreshPending = true;[\s\S]{0,80}return;/u,
    'an already-running refresh cannot replace the pressed connector row');
  assert.match(connections, /requestAnimationFrame\(flushFocusRefresh\)/u,
    'the deferred repaint runs after the browser has emitted click');
});

test('only the current bridge prompt can block a fresh login window', () => {
  const block = bridgeUi.split('// BRIDGE-PENDING-STATE-BEGIN')[1]
    ?.split('// BRIDGE-PENDING-STATE-END')[0];
  assert.ok(block, 'shared pending-bridge-state helper is missing');
  const pendingQuestion = Function(`${block}\nreturn hzPendingBridgeQuestion;`)();
  const bot = (body) => ({ from: 'bot', body });
  const user = (body) => ({ from: 'user', body });

  assert.equal(
    pendingQuestion({ transcript: [bot('Please enter your passcode'), user('••••'), bot('Logged out')] }),
    null,
    'a completed historical passcode prompt must not consume the next tile press'
  );
  assert.equal(
    pendingQuestion({ transcript: [bot('Please enter your passcode')] }),
    'Please enter your passcode',
    'the current passcode prompt must still resume instead of opening a second login'
  );
  assert.equal(
    pendingQuestion({ transcript: [bot('Please enter your passcode'), user('••••'), bot('Invalid passcode')] }),
    'Please enter your passcode',
    'a validation error keeps the preceding prompt active'
  );
  assert.equal(
    pendingQuestion({ transcript: [bot('Please enter your passcode'), bot('Unknown command')] }),
    null,
    'an ended conversation must not revive an older prompt'
  );
  assert.equal(
    pendingQuestion({
      pendingQuestion: null,
      transcript: [bot('Please enter your passcode')],
    }),
    null,
    'an explicit current-service decision overrides the compatibility parser'
  );
  assert.match(connections, /const bridgeNeedsReply = \(data\) => !!hzPendingBridgeQuestion\(data\)/u);
  assert.match(tile, /const hzBridgeNeedsReply = \(data\) => !!hzPendingBridgeQuestion\(data\)/u);
});

// The machinery stays defined so restoring it is one block, not a rewrite.
test('the Google OAuth path is parked, not deleted', () => {
  assert.match(connections, /function showClientChoice/u);
  assert.match(connections, /function startGoogleAuth|const startGoogleAuth/u);
});

test('Settings offers the explicit WhatsApp opt-in returned by connector status', () => {
  const block = /if \(src\.disabled && src\.action === 'enable'\) \{([\s\S]*?)\n {4}\} else if/u
    .exec(connections)?.[1];
  assert.ok(block, 'disabled connector branch not found in Settings');
  assert.match(block, /enable\.textContent = 'connect'/u);
  assert.match(
    block,
    /hzPost\('setConnectorEnabled', \{ connector: src\.id, enabled: true \}\)/u
  );
  assert.match(block, /\.then\(refresh\)/u, 'successful opt-in repaints connector status');
});

test('Settings keeps every unconnected or still-importing connector ahead of connected caveats', () => {
  assert.match(connections, /const needsYou = \(s\) => !s\.connected \|\| s\.pending === true;/u);
  assert.doesNotMatch(connections, /const needsYou =[^;]*caveat/u);
});

test('Settings connector hints are anchored overlays, never a third panel', () => {
  assert.match(connections, /hzPlacePop\(hintHost, anchor\)/u);
  assert.doesNotMatch(connections, /extraWidth:\s*open\s*\?\s*248/u);
  assert.doesNotMatch(connections, /hintHost\.style\.height/u);
  assert.doesNotMatch(swift, /payload\["extraWidth"\]/u);
});

test('connector popovers grow inward from viewport edges and never clip', () => {
  const place = /function hzPlacePop\(host, anchor\) \{([\s\S]*?)\n\}/u.exec(bridgeUi)?.[1];
  assert.ok(place, 'shared popover placer not found');
  assert.match(place, /host\.style\.right = `\$\{right\}px`/u);
  assert.match(place, /host\.style\.left = 'auto'/u);
  assert.match(place, /host\.style\.left = `\$\{left\}px`/u);
  assert.match(place, /host\.style\.right = 'auto'/u);
  assert.match(place, /vw - right - 8/u);
  assert.match(place, /vw - left - 8/u);
  assert.match(palette, /\.hint-host\s*\{[\s\S]*?box-sizing: border-box;[\s\S]*?overflow-x: hidden;/u);
  assert.match(palette, /\.hint-host > \.hint\s*\{[\s\S]*?max-width: 100%/u);
});

test('connector cards use current privacy copy and connected bridge identity', () => {
  assert.match(connections, /const STAY = "data stored locally";/u);
  assert.match(connectorTile, /const HZ_STAY = "data stored locally";/u);
  assert.match(connections, /const isBridge = \(src\) => src\.action === 'bridge' \|\|/u);
  assert.match(connectorTile, /const HZ_IS_BRIDGE = \(src\) => src\.action === 'bridge' \|\|/u);
  assert.match(connectorTile, /if \(HZ_IS_BRIDGE\(src\)\)/u);
  assert.doesNotMatch(connectorTile, /acct\.textContent = `linked as/u);
});

test('Discord DMs stay automatic while servers are explicit checkbox opt-ins', () => {
  assert.match(bridgeUi, /DMs sync automatically · choose servers to add/u);
  assert.match(bridgeUi, /check\.type = 'checkbox'/u);
  assert.match(
    bridgeUi,
    /writeServer\(server\.id, enabled\)/u
  );
  assert.match(connections, /hzAppendDiscordServers\([\s\S]*?hzPost\('bridgeDiscordServer'/u);
  assert.match(connectorTile, /hzAppendDiscordServers\([\s\S]*?hzPost\('bridgeDiscordServer'/u);
  assert.match(palette, /\.discord-servers\s*\{[\s\S]*?max-height: 190px; overflow-y: auto/u);
});

test('local Apple-source status is reconciled in the app process that owns each grant', () => {
  const block = /private func reconcileLocalSourceStatus\([\s\S]*?\n {2}\}/u.exec(swift)?.[0] ?? '';
  assert.match(block, /Permissions\.accessibleLocalSources\(\)/u);
  assert.match(block, /source\["action"\] as\? String == "fda"/u);
  assert.match(block, /fixed\["connected"\] = true/u);
  assert.match(block, /fixed\["broken"\] = false/u);
});

test('Calendar and Contacts status follows their frameworks, not obsolete database probes', () => {
  const fda = /static func fullDiskAccessibleSources\([\s\S]*?\n {2}\}\n\n {2}\/\/\/ Every local/u
    .exec(permissionsSwift)?.[0] ?? '';
  const local = /static func accessibleLocalSources\([\s\S]*?\n {2}\}/u
    .exec(permissionsSwift)?.[0] ?? '';
  assert.doesNotMatch(fda, /"calendar"|"contacts"/u);
  assert.match(local, /if contacts\(\) == \.granted \{ sources\.insert\("contacts"\) \}/u);
  assert.match(local, /if calendar\(\) == \.granted \{ sources\.insert\("calendar"\) \}/u);
});

// The Settings panel must not wait on the network to say what is on disk.
//
// setupState carries two kinds of fact: local ones (the installed model tier, the
// voice tree, the static tier list) and one remote one (hermes' row count, an
// HTTP call). Bundling them meant the panel's "local model size" row waited for
// hermes — which is single-threaded and blocks for its whole boot warm, so the
// call timed out at 4s and the answer arrived seconds late despite having been on
// disk the entire time.
test('setupState answers from disk immediately, and fetches rows only when asked', () => {
  const block = /case "setupState":([\s\S]*?)case "modelDownload":/u.exec(swift)?.[1];
  assert.ok(block, 'setupState case not found');
  assert.match(
    block,
    /guard payload\["rows"\] as\? Bool == true else \{[\s\S]{0,120}reply\(webView, id, state\)/u,
    'the local state must be replied without waiting for the row count'
  );
  // And the slow path must still exist for the caller that needs it.
  assert.match(block, /rows \{ n, memory in/u, 'the row count is still available on request');
});

test('only the onboarding scenes pay for the row count', () => {
  const onboarding = readFileSync(join(WIDGET, 'ui/onboarding.js'), 'utf8');
  const connections = readFileSync(join(WIDGET, 'ui/connections.js'), 'utf8');
  assert.ok(
    !/hzPost\('setupState'\)/u.test(onboarding),
    'onboarding reads rows/memory, so every call there must ask for them'
  );
  assert.match(onboarding, /hzPost\('setupState', \{ rows: true \}\)/u);
  assert.ok(
    !/hzPost\('setupState', \{ rows: true \}\)/u.test(connections),
    'Settings never reads rows and must not wait for them'
  );
});

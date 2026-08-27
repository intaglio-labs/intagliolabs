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
const bridgeLoginSwift = readFileSync(join(WIDGET, 'src', 'BridgeLogin.swift'), 'utf8');
const googleLoginSwift = readFileSync(join(WIDGET, 'src', 'GoogleLogin.swift'), 'utf8');
const connections = readFileSync(join(WIDGET, 'ui', 'connections.js'), 'utf8');
const connectorTile = readFileSync(join(WIDGET, 'ui', 'connector-tile.js'), 'utf8');
const people = readFileSync(join(WIDGET, 'ui', 'people.js'), 'utf8');

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
    'allowedFrameHosts', 'storageUrl',
  ]) {
    assert.match(block, new RegExp(`begin\\["${field}"\\]`, 'u'), `${field} is read from server policy`);
    assert.match(block, new RegExp(`${field}: ${field}`, 'u'), `${field} is passed to BridgeLogin`);
    assert.match(bridgeLoginSwift, new RegExp(`\\b${field}:`, 'u'), `BridgeLogin accepts ${field}`);
  }
  assert.match(block, /begin\["qrLogin"\]/u, 'QR policy is handled by the native QR window');
});

test('model setup restarts the launch agents provisioning actually installs', () => {
  assert.match(swift, /Provision\.installAgent\("io\.intaglio\.llama-server"\)/u);
  assert.match(swift, /Provision\.kickstart\("io\.intaglio\.llama-server"\)/u);
  assert.match(swift, /Provision\.kickstart\("io\.intaglio\.hermes"\)/u);
  assert.doesNotMatch(swift, /com\.hazlie\.(?:llama-server|hermes)/u);
});

test('the credential reassurance stays middle-aligned in the native login header', () => {
  const block = /let sub = makeLabel\(\s*"your credentials stay local",([\s\S]*?)view\.addSubview\(sub\)/u
    .exec(bridgeLoginSwift)?.[1];
  assert.ok(block, 'credential reassurance label not found');
  assert.match(block, /sub\.alignment = \.center/u);
});

test('Google OAuth opens in the system browser, never an embedded webview', () => {
  assert.match(googleLoginSwift, /NSWorkspace\.shared\.open\(target\)/u);
  assert.doesNotMatch(googleLoginSwift, /^import WebKit$/mu);
  assert.doesNotMatch(googleLoginSwift, /WKWebView\s*\(/u);
  assert.doesNotMatch(googleLoginSwift, /\.customUserAgent\s*=/u);
});

test('People starts the same Google authorization action as Settings', () => {
  assert.match(people, /HZ_GOOGLE_AUTH\.has\(HZ_KIND\(src\.id\)\)/u);
  assert.match(people, /hzPost\('googleAuth', \{ flow: 'google' \}\)/u);
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

test('Settings keeps every unconnected connector ahead of connected caveats', () => {
  assert.match(connections, /const needsYou = \(s\) => !s\.connected;/u);
  assert.doesNotMatch(connections, /const needsYou =[^;]*caveat/u);
});

test('Settings connector hints are anchored overlays, never a third panel', () => {
  assert.match(connections, /hzPlacePop\(hintHost, anchor\)/u);
  assert.doesNotMatch(connections, /extraWidth:\s*open\s*\?\s*248/u);
  assert.doesNotMatch(connections, /hintHost\.style\.height/u);
  assert.doesNotMatch(swift, /payload\["extraWidth"\]/u);
});

test('connector cards use current privacy copy and connected bridge identity', () => {
  assert.match(connections, /const STAY = "data stored locally";/u);
  assert.match(connectorTile, /const HZ_STAY = "data stored locally";/u);
  assert.match(connections, /const isBridge = \(src\) => src\.action === 'bridge' \|\|/u);
  assert.match(connectorTile, /const HZ_IS_BRIDGE = \(src\) => src\.action === 'bridge' \|\|/u);
  assert.match(connectorTile, /if \(HZ_IS_BRIDGE\(src\)\)/u);
  assert.doesNotMatch(connectorTile, /acct\.textContent = `linked as/u);
});

test('FDA status is reconciled in the app process that owns the grant', () => {
  const block = /private func reconcileFullDiskStatus\([\s\S]*?\n {2}\}/u.exec(swift)?.[0] ?? '';
  assert.match(block, /Permissions\.fullDiskAccessibleSources\(\)/u);
  assert.match(block, /source\["action"\] as\? String == "fda"/u);
  assert.match(block, /fixed\["connected"\] = true/u);
  assert.match(block, /fixed\["broken"\] = false/u);
});

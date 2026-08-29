// The login window has to fit the page it loads, and has to stay ephemeral.
//
// Both pinned after the same report (owner, 2026-08-29): Facebook's login
// rendered as a blank page with the Meta mark and a broken image while
// Instagram's worked. Facebook's page declares no viewport meta, so WebKit lays
// it out at the desktop default and a 480pt window showed only its top-left
// corner. Nothing was blocked and no cookie was involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const login = readFileSync(join(WIDGET, 'src/BridgeLogin.swift'), 'utf8');
// CODE ONLY. These files explain what they replaced, in prose, naming the very
// APIs being asserted against -- so a scan over the raw text matches the
// comment describing the old behaviour and reports the bug it is pinning as
// still present. Strip line comments before asserting absence.
const loginCode = login
  .split('\n')
  .filter((l) => !/^\s*\/\//u.test(l))
  .join('\n');
const bridge = readFileSync(join(WIDGET, 'src/Bridge.swift'), 'utf8');

test('the window width is server-authored, not a Swift constant', () => {
  assert.match(bridge, /begin\["windowWidth"\] as\? Int/u,
    'Bridge.swift must read the width the platform table declares');
  assert.match(loginCode, /let W: CGFloat = windowWidth/u,
    'the window must actually use it — a policy that is read and ignored is worse than none');
});

test('a hostile width cannot open an unclosable window', () => {
  assert.match(bridge, /min\(max\(begin\["windowWidth"\] as\? Int \?\? 0, 0\), \d+\)/u,
    'the width must be clamped at both ends');
});

// The persistent-store exception could never have worked: the same platform set
// clearsWebsiteData, and finish() wiped allWebsiteDataTypes since epoch 0 on
// every exit including cancel — so the store was empty on arrival every time.
// It also emptied the app's SHARED default store, which belongs to every other
// webview in the process.
test('every login window is ephemeral, and none touches the shared default store', () => {
  assert.match(loginCode, /WKWebsiteDataStore\.nonPersistent\(\)/u);
  assert.doesNotMatch(loginCode, /WKWebsiteDataStore\.default\(\)/u,
    'a login webview must never use the process-wide website data store');
  assert.doesNotMatch(loginCode, /removeData\(ofTypes: WKWebsiteDataStore\.allWebsiteDataTypes/u,
    'nothing should need wiping once every store is ephemeral');
});

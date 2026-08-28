// Every connect control says where it is about to take you.
//
// Connecting a source is three different flows and cannot be one: Google refuses
// OAuth in an embedded webview, a QR code needs to be big enough for a phone
// camera, and an API key is one field that belongs in the panel. That is fine.
// What is not fine is a reader being unable to tell WHICH they are about to get
// — the same-looking button variously pasted a key in place, threw them into
// Chrome, or opened a second window over the panel.
//
// The contract:
//   ↗   leaves the app: browser, System Settings, another app
//   ⧉   opens a window belonging to this app
//   —   no marker: it happens right here
//
// A source scan, like bridge-capabilities.test.mjs — this drifts silently, one
// new button at a time, which is exactly how it got into the state it was in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['ui/connections.js', 'ui/connector-tile.js'];
const src = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(WIDGET, f), 'utf8')]));

// The bridge verbs, by what they actually do — read from Bridge.swift so this
// cannot drift from the native side either.
const bridge = readFileSync(join(WIDGET, 'src/Bridge.swift'), 'utf8');

const LEAVES_THE_APP = ['openFullDiskAccess', 'openExternal', 'openApp', 'openConnectLink', 'googleAuth'];
const OPENS_A_WINDOW = ['bridgeWebLogin'];

test('the verbs really do what the markers claim', () => {
  // googleAuth hands off to the browser rather than embedding — Google refuses
  // an embedded webview, so this is a constraint, not a preference.
  assert.match(
    readFileSync(join(WIDGET, 'src/GoogleLogin.swift'), 'utf8'),
    /NSWorkspace\.shared\.open/u,
    'googleAuth must hand off to the browser'
  );
  // bridgeWebLogin puts up a window of this app.
  const verb = bridge.slice(bridge.indexOf('case "bridgeWebLogin"'));
  assert.match(verb.slice(0, 3000), /BridgeLogin\.|presentQrLogin/u,
    'bridgeWebLogin must present an app window');
});

// Every button whose click fires one of the leaving verbs must carry ↗.
test('a control that leaves the app says so', () => {
  for (const [file, text] of Object.entries(src)) {
    for (const verb of LEAVES_THE_APP) {
      if (!text.includes(`hzPost('${verb}'`)) continue;
      // The label assigned nearest above each call site.
      const idx = text.indexOf(`hzPost('${verb}'`);
      const before = text.slice(Math.max(0, idx - 1200), idx);
      // BOTH QUOTE STYLES. The first cut of this matched only '...' and so
      // walked past `1 · open ${hint.link} ↗` -- a template literal that
      // already carried the marker -- to blame an unrelated button further up.
      const labels = [...before.matchAll(/\.textContent = (?:'([^']{2,60})'|`([^`]{2,60})`)/gu)]
        .map((m) => m[1] ?? m[2]);
      const last = labels.filter((l) => !l.endsWith('…')).pop();
      if (!last) continue;
      assert.ok(
        last.includes('↗'),
        `${file}: the control for ${verb} reads "${last}" — it leaves the app and must carry ↗`
      );
    }
  }
});

test('a control that opens an app window says so', () => {
  for (const [file, text] of Object.entries(src)) {
    for (const verb of OPENS_A_WINDOW) {
      if (!text.includes(`hzPost('${verb}'`)) continue;
      const idx = text.indexOf(`hzPost('${verb}'`);
      const before = text.slice(Math.max(0, idx - 1200), idx);
      // BOTH QUOTE STYLES. The first cut of this matched only '...' and so
      // walked past `1 · open ${hint.link} ↗` -- a template literal that
      // already carried the marker -- to blame an unrelated button further up.
      const labels = [...before.matchAll(/\.textContent = (?:'([^']{2,60})'|`([^`]{2,60})`)/gu)]
        .map((m) => m[1] ?? m[2]);
      const last = labels.filter((l) => !l.endsWith('…')).pop();
      if (!last) continue;
      assert.ok(
        last.includes('⧉'),
        `${file}: the control for ${verb} reads "${last}" — it opens a window and must carry ⧉`
      );
    }
  }
});

// The in-panel ones must NOT carry a marker, or the marker stops meaning anything.
test('a control that acts in place carries no marker', () => {
  for (const [file, text] of Object.entries(src)) {
    for (const m of text.matchAll(/\.textContent = '(connect|send)'/gu)) {
      assert.ok(!/[↗⧉]/u.test(m[1]), `${file}: "${m[1]}" acts in place and must carry no marker`);
    }
  }
});

// One busy word per category, rather than a new verb per call site.
test('busy labels are drawn from a small fixed set', () => {
  // "checking the local connection…" is status copy for an unavailable
  // bridge, not a fifth connect verb. Keep it explicit so this scan continues
  // to reject one-off labels while allowing the shared down-state wording.
  const allowed = new Set([
    'opening…',
    'connecting…',
    'sending…',
    'starting…',
    'checking the local connection…',
  ]);
  for (const [file, text] of Object.entries(src)) {
    for (const m of text.matchAll(/\.textContent = '([^']*…)'/gu)) {
      assert.ok(
        allowed.has(m[1]),
        `${file}: busy label "${m[1]}" is a new verb for an existing idea — use one of ${[...allowed].join(', ')}`
      );
    }
  }
});

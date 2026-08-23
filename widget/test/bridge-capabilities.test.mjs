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

function callsIn(scripts) {
  const calls = new Set();
  for (const script of scripts) {
    let text;
    try {
      text = readFileSync(join(WIDGET, 'ui', script), 'utf8');
    } catch {
      continue; // a script served from elsewhere; nothing to read here
    }
    for (const m of text.matchAll(/hzPost\(\s*'([A-Za-z]+)'/gu)) calls.add(m[1]);
    // The settings rows carry their action as `message: 'setSounds'` and are
    // dispatched dynamically, so the literal never appears next to hzPost.
    for (const m of text.matchAll(/message:\s*'([A-Za-z]+)'/gu)) calls.add(m[1]);
  }
  return calls;
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
    for (const call of callsIn(scripts)) {
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

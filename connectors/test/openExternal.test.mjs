// Every URL the web layer can hand to openExternal must be in Bridge.swift's
// allowlist.
//
// WHY THIS EXISTS. Bridge.swift gates openExternal on
// `allowedExternal.contains(urlString)` — an EXACT string match, by design, so
// a page cannot talk the native side into opening anything it likes. The cost
// of that design is that a link added on the page side and not the Swift side
// does not fail loudly: it replies "url not in allowlist" and the button simply
// does nothing.
//
// That happened. The Discord and Slack bridge login panels shipped with
// "how to find your token" links pointing at docs.mau.fi, which was not in the
// allowlist — so the one link the owner needs to finish a login they cannot
// finish without it was silently inert. It was found sideways, by the egress
// ledger tripwire failing on an undeclared host, not by anyone testing the
// link. This test is the direct check that should have caught it.
//
// It is deliberately the same shape as egress.test.mjs: read both sides, diff
// them, name the file. Cheap, and it fails on the commit that introduces the
// mismatch rather than whenever someone next clicks that button.
//
// WHAT IT CANNOT SEE: a URL assembled at runtime from parts. Both sides are
// scanned as literals, so `BASE + path` is invisible to it. If a link is ever
// built dynamically, this test will pass and the link may still be dead —
// prefer literals here for exactly that reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The pages that can post openExternal. Kept explicit rather than globbed so a
// new page has to be added here consciously.
const PAGES = ['widget/ui/connections.js', 'widget/ui/widget.js', 'widget/ui/chat.js'];

function allowlist() {
  const swift = readFileSync(join(REPO, 'widget/src/Bridge.swift'), 'utf8');
  const at = swift.indexOf('allowedExternal');
  assert.notEqual(at, -1, 'Bridge.swift no longer declares allowedExternal — has openExternal changed shape?');
  // The declaration through the end of its array literal.
  const close = swift.indexOf(']', at);
  const block = swift.slice(at, close === -1 ? at + 1200 : close);
  return new Set([...block.matchAll(/"([^"]+)"/gu)].map((m) => m[1]));
}

function urlsSentFrom(file) {
  let text;
  try {
    text = readFileSync(join(REPO, file), 'utf8');
  } catch {
    return []; // a page that does not exist yet is not a failure
  }
  const found = [];
  // openExternal payloads are written as `url: '...'` on every current caller.
  for (const m of text.matchAll(/url:\s*(['"])([^'"]+)\1/gu)) found.push(m[2]);
  return found;
}

test('every openExternal URL on the pages is in Bridge.swift’s allowlist', () => {
  const allowed = allowlist();
  const dead = [];
  for (const page of PAGES) {
    for (const url of urlsSentFrom(page)) {
      if (!allowed.has(url)) dead.push(`  ${url}\n    sent from ${page}`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    'These URLs would reply "url not in allowlist" and the button would do nothing.\n' +
      "Add each to allowedExternal in widget/src/Bridge.swift, exactly as written:\n\n" +
      `${dead.join('\n')}\n`
  );
});

test('the allowlist has no entry no page can send', () => {
  // The other direction. A leftover entry is not dangerous — nothing reaches it
  // without a page asking — but it is a permission granted for a reason that no
  // longer exists, and the allowlist is only meaningful while it is minimal.
  // Reported, not failed: a URL may legitimately be added a commit before the
  // page that uses it.
  const allowed = allowlist();
  const sent = new Set(PAGES.flatMap(urlsSentFrom));
  const orphans = [...allowed].filter((u) => !sent.has(u) && /^[a-z-]+:/u.test(u));
  if (orphans.length > 0) {
    console.warn(`Bridge.swift allows URLs no page sends: ${orphans.join(', ')}`);
  }
  assert.ok(true);
});

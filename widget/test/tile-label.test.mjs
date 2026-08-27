// A connector tile is named ONCE.
//
// This symptom has now arrived twice from two different sources. First `title`
// on the tile drew a native macOS tooltip underneath the custom `.tile-tip`, and
// the owner saw two "Discord"s; that was fixed by moving to `aria-label`, which
// names the tile for a screen reader and draws nothing. Then the hover label
// itself started doubling with the OPEN CARD — click Messenger, open its login
// window, close it without signing in, and focus returns to the tile, `focus`
// fires the same label as hover, and a bare "Messenger" lands on top of the
// Messenger card already on screen.
//
// Two rules, both scanned here because both regress silently and neither has a
// runtime check: the tile must not carry `title`, and the hover label must yield
// to its own card.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['ui/connections.js', 'ui/connector-tile.js'];
const src = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(WIDGET, f), 'utf8')]));

// The block that builds a tile: from where the row is made to where it is returned.
function tileBuilder(text) {
  const at = text.indexOf("row.className = 'row'");
  assert.ok(at > 0, 'could not find the tile builder');
  return text.slice(at, at + 1400);
}

test('a tile is named by aria-label, never by title', () => {
  for (const [file, text] of Object.entries(src)) {
    const block = tileBuilder(text);
    assert.match(block, /setAttribute\('aria-label'/u, `${file}: the tile needs an accessible name`);
    assert.ok(
      !/row\.title\s*=|setAttribute\('title'/u.test(block),
      `${file}: a title on the tile draws a NATIVE tooltip under the custom one — two labels`
    );
  }
});

test('the hover label yields to that tile’s own open card', () => {
  for (const [file, text] of Object.entries(src)) {
    // Both spellings: connections.js has `showTileTip`, connector-tile.js has
    // `hzShowTileTip`. A pattern that matched only one silently skipped the
    // other and then blamed it for the miss.
    const fn = text.slice(text.search(/function (?:hz)?[Ss]howTileTip\b/u));
    assert.ok(fn.length > 0, `${file}: no show-tip function found`);
    const body = fn.slice(0, 900);
    assert.match(
      body,
      /\.hint|openCard/u,
      `${file}: showTileTip must check for an open card — otherwise focus returning from a login window redraws the label over it`
    );
    assert.match(
      body,
      /dataset\.id === row\.dataset\.id/u,
      `${file}: it must compare ids, so hovering a DIFFERENT tile while a card is open still names that tile`
    );
  }
});

// The comparison above is meaningless unless both sides are stamped.
test('both the tile and its card carry the source id', () => {
  for (const [file, text] of Object.entries(src)) {
    assert.match(text, /row\.dataset\.id = src\.id/u, `${file}: the tile must stamp its id`);
    assert.match(text, /tip\.dataset\.id = src\.id/u, `${file}: the card must stamp its id`);
  }
});

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

// Pressing a bridge tile opens its login — it does not describe opening it.
//
// The press used to put up a card reading "— opening login…" and start the login
// behind it. The card was never the point: the login WINDOW is what the press is
// for. When the bridge stack is unreachable that card sat on the sentence for the
// full 22s bridgeCall timeout, describing something that was not happening.
//
// Settings settled this already — palette.css says so in its own words: the tile
// "becomes a spinner in place — the owner's ask, instead of opening the hint
// panel to a transitional 'opening login…'". The People ring never got it. This
// keeps them together.
test('a bridge press starts the login without a card', () => {
  const tileSrc = readFileSync(join(WIDGET, 'ui/connector-tile.js'), 'utf8');
  const block = /if \(HZ_IS_BRIDGE\(src\) && !src\.connected\) \{([\s\S]*?)\n {2}\}/u.exec(tileSrc)?.[1];
  assert.ok(block, 'the un-connected bridge path must be its own branch');
  assert.match(block, /hzPost\('bridgeWebLogin'/u, 'it goes straight to the login');
  assert.match(block, /hzSetBridgeWaiting\(src\.id, true, onBusy\)/u,
    'the TILE carries a source-level wait that survives repainting');
  // The card is built only where there is something to say.
  assert.ok(
    !/opening login…'\)/u.test(block),
    'no card may describe the wait — that is what the spinner is for'
  );
});

test('the People ring shows the wait on the tile, as Settings does', () => {
  const peopleSrc = readFileSync(join(WIDGET, 'ui/people.js'), 'utf8');
  assert.match(peopleSrc, /onBusy: \(on\) => row\.classList\.toggle\('logging-in', on\)/u);
  // The spinner rule is unscoped in palette.css, which people.html also loads —
  // so the ring gets the same look without a second copy of it.
  const palette = readFileSync(join(WIDGET, 'ui/palette.css'), 'utf8');
  assert.match(palette, /^\.row\.logging-in \.dot \{/mu, 'the rule must stay unscoped, or the ring loses it');
  const html = readFileSync(join(WIDGET, 'ui/people.html'), 'utf8');
  assert.match(html, /palette\.css/u, 'people.html must keep loading palette.css');
});

test('the waiting ring survives the login-window focus refresh until connected status renders', () => {
  const settings = readFileSync(join(WIDGET, 'ui/connections.js'), 'utf8');
  const shared = readFileSync(join(WIDGET, 'ui/connector-tile.js'), 'utf8');

  assert.match(settings, /const bridgeWaitingSources = new Set\(\)/u);
  assert.match(settings, /bridgeWaitingSources\.has\(src\.id\)[\s\S]*row\.classList\.add\('logging-in'\)/u,
    'a rebuilt Settings tile must inherit the source-level wait');
  assert.match(settings, /if \(src\.connected && !src\.pending\) bridgeWaitingSources\.delete\(src\.id\)/u,
    'only a connected, data-ready Settings payload turns the inherited wait into a check');
  assert.match(settings, /if \(!\(final && final\.connected\)\) setBridgeWaiting\(src\.id, false\)/u,
    'failed or cancelled Settings logins restore the resting dot');

  assert.match(shared, /const hzBridgeWaitingSources = new Set\(\)/u);
  assert.match(shared, /hzBridgeWaitingSources\.has\(src\.id\)[\s\S]*row\.classList\.add\('logging-in'\)/u,
    'a rebuilt shared tile must inherit the source-level wait');
  assert.match(shared, /if \(src\.connected && !src\.pending\) hzBridgeWaitingSources\.delete\(src\.id\)/u,
    'the People/shared tile changes to a check only from connected, data-ready status');
});

test('backend import-pending status keeps a connected bridge spinning instead of green', () => {
  const settings = readFileSync(join(WIDGET, 'ui/connections.js'), 'utf8');
  const shared = readFileSync(join(WIDGET, 'ui/connector-tile.js'), 'utf8');
  for (const [name, text] of [['Settings', settings], ['shared', shared]]) {
    assert.match(text, /src\.connected && !src\.pending \? ' on'/u,
      `${name}: pending authentication must not draw a green check`);
    assert.match(text, /src\.pending \|\| [\w.]+\.has\(src\.id\)/u,
      `${name}: backend pending must draw the waiting ring after a page refresh`);
  }
});

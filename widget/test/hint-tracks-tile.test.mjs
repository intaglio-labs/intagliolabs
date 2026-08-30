// The open connector card has to follow its tile.
//
// #grid is a ONE-LINE HORIZONTAL SCROLLER — .list is display:flex with
// overflow-x:auto and overflow-y:hidden — so most connector tiles are off screen
// at any moment, and pressing one runs
// row.scrollIntoView({inline:'nearest', behavior:'smooth'}). The card was placed
// once against the tile's rect and never again, so the smooth scroll slid the
// tile out from under its own card: the owner connected Instagram successfully
// and the card ended up floating over the activity panel with no tile beneath
// it ("the tab moved way to the right", 2026-08-29).
//
// A source scan, like connect-affordances.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(WIDGET, 'ui/connections.js'), 'utf8');
const css = readFileSync(join(WIDGET, 'ui/palette.css'), 'utf8');

test('the connector strip really is a horizontal scroller', () => {
  // If this stops being true the bug below cannot happen and the listener is
  // dead weight — so the premise is pinned, not assumed.
  const list = css.slice(css.indexOf('.list {'));
  assert.match(list.slice(0, 400), /overflow-x:\s*auto/u,
    '#grid (.list) must scroll sideways for the tracking to matter');
});

test('pressing a tile still scrolls it into view', () => {
  assert.match(js, /scrollIntoView\(\{[^}]*inline:\s*'nearest'/u,
    'the tapped tile must be brought on screen');
});

test('the card is re-placed on scroll, not only on content change', () => {
  // Match the name, not the signature: this pinned `= () =>` and broke the
  // moment the helper grew an options argument, which is the third time this
  // session a test has asserted on syntax where it meant behaviour.
  assert.match(js, /const placeOpenHint = /u,
    'placement must be callable from more than the mutation observer');
  const listener = js.match(/grid\.addEventListener\('scroll'[\s\S]{0,400}/u);
  assert.ok(listener, 'the strip needs a scroll listener');
  assert.match(listener[0], /placeOpenHint\(\)/u, 'scrolling must re-place the card');
  assert.match(listener[0], /passive:\s*true/u,
    'the listener only reads layout; blocking the scroll would make the gesture worse');
  assert.match(listener[0], /requestAnimationFrame/u,
    'a smooth scroll fires this many times a second and each call reads a rect');
});

test('the observer delegates rather than keeping its own copy', () => {
  // Two placement paths that can disagree is how the anchor-resolution rules
  // above get half-applied.
  assert.equal(
    (js.match(/hzPlacePop\(hintHost,\s*anchor\)/gu) || []).length,
    1,
    'exactly one place should call hzPlacePop with the resolved anchor'
  );
});

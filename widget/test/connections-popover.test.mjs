// The connector pop-over's placement contract. A card must never render
// unanchored: hzPlacePop's null-anchor guard silently skips positioning, so a
// card that reaches the live host without a live `.row.open` shows wherever
// its stale styles left it — clipped at the window edge, floating over the
// settings column (owner, 2026-08-26, after pressing x on Slack's card while
// a login promise was still in flight and a focus-refresh had rebuilt the
// shelf under it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const page = readFileSync(join(UI, 'connections.js'), 'utf8');

test('a login result whose tile was rebuilt is re-homed, never rendered unanchored', () => {
  // ~~"...is dropped, not re-homed", asserting `if (!row.isConnected) return;`.~~
  // The hazard was right and the remedy overshot (2026-08-26, same day). A
  // detached row is not evidence of a stale result: the FIRST press into an
  // unfocused panel detaches it every time, because that one click both
  // focuses the window — firing refresh, which rebuilds the shelf — and hits
  // the tile. Measured in a harness: one grid rebuild, row.isConnected false,
  // no card. That is the owner's "first tap does nothing, I have to press it
  // again", and it was true of every bridge tile.
  //
  // So the invariant this file exists to defend is unchanged — a card must
  // never reach the live host without a live anchor — and it is now met by
  // finding the tile that replaced this one rather than by throwing the
  // result away. Only a source that has genuinely left the payload drops.
  const show = /const showBridgePanel = \(data\) => \{([\s\S]*?)\n  \};/u.exec(page)?.[1] ?? '';
  assert.ok(show, 'showBridgePanel exists');
  assert.match(show, /row\.isConnected/u, 'still notices that its own row died');
  assert.match(show, /grid\.querySelector\(`\.row\[data-id="\$\{CSS\.escape\(src\.id\)\}"\]`\)/u,
    're-homes by the id both the old tile and its replacement carry');
  assert.match(show, /if \(!live\) return;/u,
    'a source that really is gone still drops rather than drawing unanchored');
  assert.match(show, /live\.classList\.add\('open'\)/u,
    'the LIVE row is what gets marked open — hzPlacePop anchors on it');
});

test('the pop-over resolves its anchor and refuses to render without one', () => {
  assert.match(page, /document\.querySelector\('#grid \.row\.open'\)/u);
  assert.match(page, /r\.dataset\.id === id/u,
    'falls back to the live row that owns the card, by the id both carry');
  assert.match(page, /if \(!anchor\) \{ hintHost\.replaceChildren\(\); return; \}/u,
    'an unplaceable pop-over closes instead of drawing unanchored');
});

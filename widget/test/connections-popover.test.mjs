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

test('a login result whose tile was rebuilt is dropped, not re-homed', () => {
  const show = /const showBridgePanel = \(data\) => \{([\s\S]*?)\n  \};/u.exec(page)?.[1] ?? '';
  assert.ok(show, 'showBridgePanel exists');
  assert.match(show, /if \(!row\.isConnected\) return;/u,
    'a dead closure must not append a card no document query can anchor');
});

test('the pop-over resolves its anchor and refuses to render without one', () => {
  assert.match(page, /document\.querySelector\('#grid \.row\.open'\)/u);
  assert.match(page, /r\.dataset\.id === id/u,
    'falls back to the live row that owns the card, by the id both carry');
  assert.match(page, /if \(!anchor\) \{ hintHost\.replaceChildren\(\); return; \}/u,
    'an unplaceable pop-over closes instead of drawing unanchored');
});

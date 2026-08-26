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

// SLACK'S WINDOW IS A STEP, NOT AN ENTRY POINT. The owner spent three
// screenshots inside a login window that nothing was waiting on: pressing the
// tile opened it before the bot had been told anything, so he signed into
// Slack's website in a private session while the bridge sat in a login started
// hours earlier. The window belongs partway through the conversation, at the
// moment the bot asks for a challenge it cannot ask for in a text box.
test('only a cookie login opens its window from the tile press', () => {
  const toggleBody = /if \(src\.action === 'bridge' && !src\.connected[\s\S]{0,120}?\) \{\n\s*openBridgeLogin\(\);/u
    .exec(page)?.[0] ?? '';
  assert.ok(toggleBody, 'the tile press still has a bridge branch');
  assert.match(toggleBody, /BRIDGE_FLOW\[kindOf\(src\.id\)\][\s\S]{0,40}=== 'cookie'/u,
    'a conversation flow must reach its card, not a window');
});

test('the challenge step offers the window, on two independent markers', () => {
  assert.match(page, /const wantsChallenge = \(\) => \{/u);
  assert.match(page, /captcha\|challenge/u, 'the bot names the challenge');
  assert.match(page, /Login URL:\|embedded/u,
    'and a second marker, so a stray sentence cannot summon a login window');
  assert.match(page, /answer the check/u);
});

// ONE PRESS MEANS "LOG ME IN". A card that opens on a `begin login` button is
// asking for the press that already happened (owner, 2026-08-26). The
// no-window bridges got this natively in d88e56c; Slack reaches its card by a
// different road and arrived at the same dead button.
test('a fresh conversation card begins its login itself, once', () => {
  assert.match(page, /const autoBegun = new Set\(\);/u, 'guarded by source id');
  assert.match(page, /autoBegun\.has\(src\.id\)[\s\S]{0,120}beginButton\('begin login'\)/u,
    'a second pass falls back to the button rather than beginning again');
  assert.match(page, /autoBegun\.add\(src\.id\);[\s\S]{0,220}hzPost\('bridgeBegin'/u,
    'the flag is set before the call, not after it');
  // begin's first act is `cancel`, so an unguarded auto-begin would cancel the
  // conversation it just opened on its own repaint.
  assert.match(page, /renderBridge repaints on every bot reply and\n\/\/ begin starts with `cancel`/u);
});

// THE BOT'S QUESTION IS NOT ITS LAST LINE. Slack answers an email address with
// two messages — the CAPTCHA sentence, then "Login URL: <…>" — so a matcher
// that read only the last one never fired, and the card showed no way to answer
// a question the bridge was actively holding (owner, 2026-08-26: "i'm just
// waiting for slack?"). Worse, askedFor() then read the silence as a finished
// conversation and offered `begin login`, whose first act is `cancel`.
test('a pending challenge is recognised across the bot two-line reply', () => {
  const fn = /const wantsChallenge = \(\) => \{([\s\S]*?)\n      \};/u.exec(page)?.[1] ?? '';
  assert.ok(fn, 'the matcher exists');
  assert.doesNotMatch(fn, /bot\[bot\.length - 1\]/u,
    'the last line is a URL, not the question');
  assert.match(fn, /slice\(-3\)/u, 'both markers are sought across the same window');
  assert.match(fn, /captcha\|challenge/u);
  assert.match(fn, /Login URL:\|embedded/u);
});

test('a pending challenge is never offered a begin-login beside it', () => {
  assert.match(page, /\} else if \(wantsChallenge\(\)\) \{[\s\S]{0,600}?appendTranscript\(\);/u,
    'the challenge branch runs before the no-prompt fallback');
  const order = page.indexOf('} else if (wantsChallenge())');
  const fallback = page.indexOf('} else if (!askedFor())');
  assert.ok(order > 0 && fallback > order,
    'the no-prompt fallback must come after, or it claims a live login');
});

// maskOwn — the credential masker for the bridge login transcript.
//
// It exists because the owner pastes a live session credential into that panel
// and the panel then re-renders what they typed. Anything it fails to mask is a
// full account credential displayed on screen.
//
// WHAT THIS FILE CAUGHT. maskOwn was exported "for testing" and never tested
// against more than the one shape it obviously caught. Measured 2026-08-22, it
// masked 3 of 7 realistic pastes: the two Meta platforms it was written for,
// plus any cURL command. X/Twitter (auth_token, ct0), Slack (xoxc, xoxd),
// Discord (bearer token) and Telegram (login code) all rendered VERBATIM —
// four live credentials on screen, in a panel shipped that same day.
//
// The cause was the shape this repo keeps producing: a closed list that was
// right when it was written. maskOwn matched a Meta-only set of cookie names,
// and four bridges had been added since, each authenticating with a token
// shape the list had never heard of. It also masked `login cookies` — the
// command that STARTS the flow — because that string contains "cookie", so the
// panel told the owner they had sent credentials at the moment they sent a
// command.
//
// FIXED at fe8a866e by inverting the default: everything the owner sends is
// masked unless it matches SAFE_COMMANDS. That is why the table below is now
// all-masked with a small readable set — a bridge added next year is covered
// on the day it lands, with nobody having to remember this file. The failure
// direction also inverted, from "a new credential leaks" to "a new command
// gets masked", which is the harmless one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { maskOwn } from '../lib/bridgePage.mjs';

const MASK = '‹sent — hidden here on purpose›';

// Realistic paste shapes, one per platform the connect page can link. Values
// are fabricated but the SHAPES are what each bridge's login actually asks for
// (connect/lib/bridge.mjs PLATFORMS, bridges/README.md).
const MASKED = {
  'messenger cookies': 'c_user=100001234567890; xs=abcdef; datr=zzzz',
  'instagram cookies': 'sessionid=1234%3Aabcd%3A26; ig_did=AAAA-BBBB',
  'x/twitter auth_token + ct0':
    'auth_token=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0; ct0=9f8e7d6c5b4a',
  'slack xoxc + xoxd': 'xoxc-1234567890-abcdefgh; xoxd-ZZZZaaaabbbbcccc',
  'discord bearer token': 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.FgHiJkLmNoPqRsTuVwXyZ',
  'telegram login code': '12345',
  'a phone number': '+1 415 555 0134',
  'a cURL command': "curl https://x.com/i/api/graphql -H 'cookie: auth_token=x'",
  'a long paste of anything': 'x'.repeat(141),
  'a bare unknown token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefgh.ijklmnop',
};

// The counter-pressure: the transcript has to stay useful. These are what the
// owner legitimately types, and masking them would blank the half of the
// conversation that shows what is happening.
const READABLE = ['login', 'login cookies', 'login-token', 'cancel', 'help', '!fb login'];

for (const [name, paste] of Object.entries(MASKED)) {
  test(`masks ${name}`, () => {
    assert.equal(maskOwn(paste), MASK, `${name} rendered verbatim — that is a credential on screen`);
  });
}

test('the commands the owner actually types stay readable', () => {
  for (const cmd of READABLE) {
    assert.equal(maskOwn(cmd), cmd, `"${cmd}" should stay readable`);
  }
});

test('an unknown short word is masked, not assumed safe', () => {
  // The whole point of the inversion. A Telegram login code is five digits and
  // a Discord token fragment can be short; length is not evidence of safety,
  // so anything outside the command allow-list is masked regardless of size.
  for (const unknown of ['12345', 'abc', 'yes', 'MTIzNDU2']) {
    assert.equal(maskOwn(unknown), MASK, `"${unknown}" must not read through`);
  }
});

test('a new platform is covered without anyone editing this file', () => {
  // The regression that the old closed-list design guaranteed: a credential
  // shape nobody has seen yet. Under the inverted default it masks by
  // construction, which is the property worth protecting.
  const invented = 'fnord_session=QQQQ-WWWW-EEEE; fnord_csrf=RRRR';
  assert.equal(maskOwn(invented), MASK);
});

test('empty and whitespace-only messages pass through untouched', () => {
  // Not secrets, and masking them would put a placeholder where the owner sees
  // nothing at all.
  for (const blank of ['', '   ']) {
    assert.equal(maskOwn(blank), blank);
  }
});

test('masking is decided per message, not per transcript', () => {
  // renderLog calls maskOwn on each `from: "you"` message independently, so a
  // secret must not un-mask by sitting next to plain text, and a command must
  // not get masked by sitting next to a secret.
  assert.equal(maskOwn('c_user=1; xs=2'), MASK);
  assert.equal(maskOwn('help'), 'help');
});

test('only the owner’s own messages go through maskOwn', () => {
  // renderLog (bridgePage.mjs:119) gates on `m.from === 'you'`. That gate is
  // now load-bearing in a way it was not before: under the inverted default
  // maskOwn masks nearly everything, so running the bridge bot's side through
  // it would blank the instructions the owner is reading. Pinned here because
  // "just mask everything" is the obvious wrong simplification.
  const botInstruction = 'Send me your cookies to continue. Paste the cURL command.';
  assert.equal(maskOwn(botInstruction), MASK, 'the bot side must never be passed to maskOwn');
});

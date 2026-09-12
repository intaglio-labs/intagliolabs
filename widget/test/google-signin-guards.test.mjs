// TWO WAYS SCREEN 3 SPENDS LIVE GMAIL READS IT WAS NEVER GIVEN.
//
// 1. The probe cap is per VISIT. enterGoogle reset the counter to zero but did
//    not stop the interval that was already running -- it self-terminates only
//    on a tick where the screen has changed -- so leaving screen 3 and coming
//    back inside the ten-minute window handed the SAME live interval a fresh
//    GOOGLE_PROBE_CAP. A few laps of the screen spent the budget several times
//    over, and every probe is a live Gmail read.
//
// 2. googleAuthRefusal inferred success from two absences: no `refused`, no
//    `state`. The success reply is `{ok: true, opened: true}` and today
//    GoogleLogin.present always supplies a `why` alongside a false -- which is
//    the only reason the inference has held. A `done(false, nil)` yields
//    `{ok: false, opened: false}` with neither field, the function answers
//    null, and the page starts ten minutes of polling against a browser that
//    never opened.
//
// The refusal test is RUN rather than scanned: googleAuthRefusal takes one
// object and touches nothing else on the page, so it can be lifted out of the
// file and called. The cap fix is a source scan, like the other widget tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(WIDGET, 'ui', 'onboarding.js'), 'utf8');

/// Code only: the comments in onboarding.js describe the very defects being
/// pinned here.
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//u.test(line))
  .join('\n');

/// A top-level `function name(...) { ... }`, matched on the closing brace in
/// column zero.
function declarationOf(name) {
  const re = new RegExp(`\\nfunction ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`, 'u');
  const m = re.exec(js);
  assert.ok(m, `${name}() not found in onboarding.js`);
  return { args: m[1], body: m[2] };
}

/// googleAuthRefusal, lifted out and made callable. It reads only its
/// argument, so nothing has to be stubbed for it -- which is what makes this a
/// behaviour test rather than another string search.
///
/// The `new Function` here compiles ONE named function out of a file in this
/// repository, read from disk beside the test. There is no interpolation and
/// no input from anywhere else; the only thing that can reach this compiler is
/// the code under test, which the test runner is running anyway.
function liftRefusal() {
  const { args, body } = declarationOf('googleAuthRefusal');
  // eslint-disable-next-line no-new-func
  return new Function(args, body);
}

test('a reply that says no browser opened is a refusal', () => {
  const refusal = liftRefusal();
  // The shape a future `GoogleLogin.present` done(false, nil) produces: the
  // native side saying in as many words that nothing opened, with no `why`.
  assert.ok(refusal({ ok: false, opened: false }),
    'ok:false / opened:false must be read as a refusal. Answering null here starts ten\n' +
    'minutes of live Gmail polling against a browser that never opened, and leaves the\n' +
    'screen saying "opening google in your browser…" until the owner gives up');
  assert.ok(refusal({ ok: true, opened: false }),
    'opened:false is the field that means no browser, whatever ok says');
  assert.ok(refusal({ ok: false, opened: true }),
    'ok:false is a refusal too -- the two fields are written together today, and a test\n' +
    'that only reads one of them re-opens the gap the moment they diverge');
});

test('a launched browser is still not a refusal', () => {
  const refusal = liftRefusal();
  assert.equal(refusal({ ok: true, opened: true }), null,
    'the success reply carries neither `refused` nor `state`; painting it amber would\n' +
    'accuse every working sign-in');
});

test('the two synthesised failures still speak in their own words', () => {
  const refusal = liftRefusal();
  assert.equal(refusal({ ok: false, opened: false, refused: 'no browser for that URL' }),
    'no browser for that URL',
    "GoogleLogin's own reason wins: it is the specific one, and the owner can act on it");
  assert.equal(refusal({ state: 'down', error: 'connect is not running' }),
    'connect is not running',
    "connect's error wins over the generic sentence for the same reason");
  assert.ok(refusal({ state: 'auth' }),
    'a bridgeCall state other than ok is a refusal even with no error text');
  assert.ok(refusal(null), 'no reply at all is a refusal');
});

test('re-entering screen 3 stops the poll before it hands out a new budget', () => {
  const { body } = declarationOf('enterGoogle');
  const source = code(body);
  const stop = source.indexOf('stopGooglePolling()');
  const reset = source.indexOf('googleProbes = 0');
  assert.ok(stop >= 0,
    'enterGoogle must stop any running poll. The interval outlives a visit -- it only\n' +
    'checks the screen on its next tick -- so resetting the counter under a live one\n' +
    'gives that same interval a second full GOOGLE_PROBE_CAP of live Gmail reads');
  assert.ok(reset > 0, 'enterGoogle must still reset the per-visit counter');
  assert.ok(stop < reset,
    'the stop comes first: resetting and then stopping would still be correct by\n' +
    'accident, but the order is the thing being pinned and the reverse reads as if the\n' +
    'reset belonged to the old interval');
});

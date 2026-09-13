// HOW MUCH OF A SPAWNED HELPER'S STDERR REACHES THE OWNER.
//
// connect reads ops/gcal-auth.mjs' stderr so a sign-in that will not start can
// say WHY -- the file, the mode, the fix -- instead of the generic sentence
// that named the one cause the owner had already ruled out (round-6 finding 4).
// What comes back is painted on the onboarding screen, so the rule about what
// may be repeated is load-bearing rather than tidy.
//
// The first cut was "everything after the last `gcal-auth: `", which dropped
// what came BEFORE the prefix and kept everything after it -- the opposite of
// the rule it was written for (round-7 finding 4). fail() calls
// process.exit(1), and node can still flush on the way out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { helperDiagnostic, HELPER_PREFIX } from '../lib/helperSays.mjs';

test('the helper is quoted, prefix stripped', () => {
  assert.equal(HELPER_PREFIX, 'gcal-auth: ');
  assert.equal(
    helperDiagnostic('gcal-auth: OAuth client "work" is not usable\n'),
    'OAuth client "work" is not usable'
  );
});

test('a multi-line message keeps the half it indented on purpose', () => {
  // Every multi-line fail() in gcal-auth.mjs indents its continuations by two
  // spaces, and they carry the actionable part: where to register a client,
  // what redirect_uri_mismatch means, which permission to revoke.
  const said = helperDiagnostic(
    'gcal-auth: no Google OAuth client is installed on this Mac.\n'
    + '  Register one at ~/.hazlie/secrets/google-client-<name>.json holding\n'
    + '  {"client_id": "...", "client_secret": "..."}\n'
  );
  assert.match(said, /^no Google OAuth client is installed on this Mac\./u);
  assert.match(said, /Register one at/u, 'the fix is the half worth having');
  assert.doesNotMatch(said, /\n/u, 'and it arrives as one line, for one line of screen');
});

test('what node writes on its way out is not part of the message', () => {
  // THE DISCRIMINATING CASE. A lazily emitted warning, an unhandled rejection,
  // a stack: written for nobody, and naming paths nobody chose to publish.
  const said = helperDiagnostic(
    'gcal-auth: no Google OAuth client is installed on this Mac.\n'
    + '  Register one at ~/.hazlie/secrets/google-client-<name>.json\n'
    + '(Use `node --trace-warnings ...` to show where the warning was created)\n'
    + 'Error: ENOENT\n'
    + '    at /Users/somebody/private/path/internal.mjs:41:11\n'
  );
  assert.match(said, /Register one at/u);
  assert.doesNotMatch(said, /trace-warnings/u, 'node starts at column zero: the message ended');
  assert.doesNotMatch(said, /somebody\/private\/path/u, 'and a stack frame is never quoted');
  assert.doesNotMatch(said, /ENOENT/u);
});

test('the indented stack frame of an unprefixed error cannot smuggle itself in', () => {
  // The stack's own frames ARE indented, so only the line that ends the
  // message matters: once an unindented line has closed it, nothing after it
  // is read at all.
  const said = helperDiagnostic(
    'gcal-auth: token exchange HTTP 400\n'
    + 'Error: boom\n'
    + '    at /Users/somebody/private/path/internal.mjs:41:11\n'
  );
  assert.equal(said, 'token exchange HTTP 400');
});

test('text with no prefix at all is not repeated', () => {
  assert.equal(helperDiagnostic('Error: boom\n    at /Users/somebody/x.mjs:1:1\n'), null);
  assert.equal(helperDiagnostic(''), null);
  assert.equal(helperDiagnostic(undefined), null);
  assert.equal(helperDiagnostic('gcal-auth: \n'), null, 'a prefix with nothing after it says nothing');
});

test('only the LAST thing the helper said is quoted', () => {
  // fail() is the last thing it does; the waiting-for-approval chatter above
  // it is not the reason it stopped.
  assert.equal(
    helperDiagnostic('gcal-auth: ignoring a stray callback\ngcal-auth: no callback within 15 minutes.\n'),
    'no callback within 15 minutes.'
  );
});

test('a helper that will not stop talking is cut off', () => {
  const said = helperDiagnostic(`gcal-auth: ${'x'.repeat(2_000)}\n`);
  assert.equal(said.length, 400, 'a diagnostic past a few hundred characters is not being read');
});

// THE PREFIX ONLY COUNTS AT THE START OF A LINE (round-8 finding 6).
//
// Searched across the whole buffer, the prefix could be found INSIDE an
// unprefixed line -- and node writes exactly that shape whenever the thing it
// failed on is a path with the helper's name in it. The stack frames that
// follow are indented, so the continuation rule then quoted those too: the
// absolute path to the owner's credential, plus two frames of node internals,
// onto their screen.
test('a prefix inside an error message does not open the quote', () => {
  const said = helperDiagnostic(
    'Error: ENOENT: no such file or directory, open gcal-auth: '
    + '/Users/rishab/.hazlie/secrets/google-client-work.json\n'
    + '    at Object.readFileSync (node:fs:441:20)\n'
    + '    at /Users/rishab/Desktop/Projects/intagliolabs/ops/gcal-auth.mjs:118:20\n'
  );
  assert.equal(said, null,
    'nothing on this stream was written for an owner, so nothing is repeated');
});

test('a real diagnostic is still found when node has talked around it', () => {
  // The counterweight: anchoring must not cost the message itself. The helper's
  // line is at column zero whatever surrounds it, because console.error writes
  // its own line.
  const said = helperDiagnostic(
    'Error: ENOENT, open gcal-auth: /Users/rishab/.hazlie/secrets/x.json\n'
    + '    at Object.readFileSync (node:fs:441:20)\n'
    + 'gcal-auth: OAuth client "work" is not usable: google client file must not be\n'
    + '  accessible by group or other users\n'
  );
  assert.match(said, /^OAuth client "work" is not usable/u);
  assert.match(said, /accessible by group or other users/u, 'continuations still count');
  assert.doesNotMatch(said, /\.hazlie\/secrets\/x\.json/u, 'and the stack above it does not');
  assert.doesNotMatch(said, /readFileSync/u);
});

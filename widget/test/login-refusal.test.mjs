// When a site refuses to render its own security step.
//
// Measured five times across four sessions (2026-08-30, and the raw rows are in
// ~/.hazlie/logs/bridge-login.log). Facebook's two-step verification page
// arrives fully server-rendered and displays nothing:
//
//   refused   kids 153-165  html ~2,480,000  vis 11   text ""  hidden 152
//   working   kids 90       html   ~326,000  vis 205  text present
//
// No crash, no hang, no blocked resource, no WebAuthn, no shadow DOM — Meta
// declines to show a security step in an embedded browser, the same posture that
// makes Google refuse OAuth in one. Five theories died before that, four by
// measurement, so the predicate below is pinned against the numbers that were
// actually observed rather than the story that sounded right.
//
// THE PREDICATE IS TESTED AS ARITHMETIC, not as source text. This session has had
// four tests match their own comments; re-implementing the rule here and running
// it against the recorded samples is the difference between checking behaviour
// and checking that a file contains a word.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const login = readFileSync(join(ROOT, 'widget/src/BridgeLogin.swift'), 'utf8');
const bridge = readFileSync(join(ROOT, 'widget/src/Bridge.swift'), 'utf8');
const connections = readFileSync(join(ROOT, 'widget/ui/connections.js'), 'utf8');

// The rule as implemented in looksRefused(), mirrored so the thresholds can be
// exercised against real samples.
const refused = (p) =>
  p.ready === 'complete' && p.x === 0 && p.shadow === 0 &&
  p.html >= 400_000 && p.kids >= 24 && p.vis <= 24 && p.vis * 8 <= p.kids;

// Verbatim from the log.
const FB_2FA = { ready: 'complete', x: 0, shadow: 0, html: 2483578, kids: 165, vis: 11 };
const FB_2FA_B = { ready: 'complete', x: 0, shadow: 0, html: 2479056, kids: 153, vis: 11 };
// x is a LENGTH now, never the characters: a login page's rendered copy is a
// masked phone number or an account hint on a second-factor screen, and this
// probe is written to a log file with no rotation and no delete path.
const FB_LOGIN = { ready: 'complete', x: 205, shadow: 0, html: 326634, kids: 90, vis: 205 };

test('it fires on every recorded refusal', () => {
  assert.equal(refused(FB_2FA), true);
  assert.equal(refused(FB_2FA_B), true);
});

test('it does not fire on the login page that works', () => {
  assert.equal(refused(FB_LOGIN), false, 'a working page must never be retired');
});

test('it does not fire on the shapes it would be wrong about', () => {
  // A React shell mid-mount: DOM is small because content has not arrived.
  assert.equal(refused({ ...FB_2FA, html: 40_000, kids: 12 }), false, 'mid-mount');
  // A legitimately minimal page: small, and its emptiness is honest.
  assert.equal(refused({ ...FB_2FA, html: 8_000, kids: 4 }), false, 'minimal page');
  // Still streaming.
  assert.equal(refused({ ...FB_2FA, ready: 'loading' }), false, 'not finished');
  // Shadow DOM explains empty innerText without any refusal.
  assert.equal(refused({ ...FB_2FA, shadow: 3 }), false, 'shadow root');
  // Text present is decisive on its own.
  assert.equal(refused({ ...FB_2FA, x: 42 }), false, 'renders text');
  // A big page where plenty IS laid out is not refusing anything.
  assert.equal(refused({ ...FB_2FA, vis: 140 }), false, 'plenty visible');
});

test('the sentinel cannot be mistaken for a credential blob', () => {
  const m = login.match(/browserHandoff = "([^"]+)"/u);
  assert.ok(m, 'the sentinel must be declared');
  const value = m[1];
  assert.throws(() => JSON.parse(value), 'must not parse as the json cookie format');
  assert.doesNotMatch(value, /=/u, 'must not read as a Cookie header pair');
});

test('the completion handler guards the sentinel before relaying anything', () => {
  // SCOPED TO THE CLOSURE. Bridge.swift POSTs to api/bridge/cookies from four
  // places; only the one inside this completion handler can ever receive the
  // sentinel. The manual-paste endpoint and the X continuation take a real
  // cookie jar from elsewhere — the latter because the refusal path claims
  // harvestStarted before showing the handoff, so completeHarvest, and therefore
  // afterHarvest, can no longer fire.
  const start = bridge.indexOf(') { cookiesJSON in');
  assert.ok(start > 0, 'the completion handler must exist');
  const block = bridge.slice(start, start + 4000);
  const at = block.indexOf('cookiesJSON == BridgeLogin.browserHandoff');
  const post = block.indexOf('json: ["p": p, "cookies": cookiesJSON]');
  assert.ok(at > 0, 'the guard must be inside the completion handler');
  assert.ok(post > 0, 'the relaying POST must be inside it too');
  assert.ok(at < post, 'the guard must come first, or the sentinel is relayed as a credential');
});

test('the handoff opens the connect page rather than restarting the login', () => {
  // begin's first act is to cancel, and the connect page has its own Begin
  // control; calling it here would cancel a login that is mid-conversation.
  const i = bridge.indexOf('let handoff: () -> Void');
  const j = bridge.indexOf('}', bridge.indexOf('reply(webView, id, opened', i));
  const block = bridge.slice(i, j);
  assert.match(block, /openConnectRoot\(\s*\n?\s*path: \.bridge/u);
  assert.doesNotMatch(block, /beginBridgeLogin/u, 'the handoff must not restart the login');
});

test('the owner is told something, not shown a dead end', () => {
  // showFailure renders a label and never finishes, so its only exit is the close
  // box, which reports cancelled — and cancelled renders as nothing.
  assert.match(connections, /browserLogin:/u, 'the state needs a notice');
  const line = connections.split('\n').find((l) => /^\s*browserLogin:/u.test(l));
  assert.match(line, /browser/iu);
  assert.match(line, /connect page/iu, 'it must say where they were sent');
});

// ---- do not advertise WebAuthn we cannot perform ----
//
// WKWebView in a non-browser app exposes window.PublicKeyCredential, so a site's
// feature detection passes and it routes to passkeys — then
// navigator.credentials.get() has no platform authenticator behind it. X did
// exactly that: twitter.com/i/u2f_bridge, titled "Passkey verification",
// rendering perfectly and promising a prompt that never comes (2026-08-30).
//
// The entitlement that would make it real is Apple-managed and browser-only, so
// the capability is not coming. Feature detection exists so a site can pick a
// method that works; the honest move is to stop claiming this one.

test('the login window does not advertise WebAuthn', () => {
  const code = login.split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
  assert.match(code, /delete window\.PublicKeyCredential/u,
    'a capability we cannot deliver must not pass feature detection');
  assert.match(code, /injectionTime: \.atDocumentStart/u,
    'it must be gone before the page reads it');
});

test('the opt-out is narrow: password credential APIs survive', () => {
  const code = login.split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
  // navigator.credentials also carries the password credential API that autofill
  // uses. Removing it wholesale would trade one dead end for another.
  assert.doesNotMatch(code, /delete navigator\.credentials/u,
    'only the WebAuthn flag goes, not the whole credentials API');
});

// THE MIRROR CAN DRIFT, AND IT JUST DID. The `refused` predicate above is a
// hand-copy of looksRefused(); running it against real samples proves the
// ARITHMETIC but says nothing about whether Swift still computes the same
// thing. On 2026-08-30 an edit script died on its fourth assertion after
// making three in-memory changes, wrote nothing, and the mirror was updated
// anyway — leaving JS comparing a number to Swift's String for a full test
// run, all green. These two tests are what would have caught that.

test('the mirrored predicate still matches looksRefused in Swift', () => {
  const body = login.match(/private func looksRefused[\s\S]*?\n  \}/u)?.[0];
  assert.ok(body, 'looksRefused must still exist to be mirrored');
  const code = body.split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
  for (const [what, re] of [
    ['ready complete', /\(o\["ready"\] as\? String\) == "complete"/u],
    ['x is a COUNT', /\(o\["x"\] as\? Int\) == 0/u],
    ['shadow zero', /\(o\["shadow"\] as\? Int\) == 0/u],
    ['html floor', /html >= 400_000/u],
    ['kids floor', /kids >= 24/u],
    ['vis ceiling', /vis <= 24/u],
    ['vis:kids ratio', /vis \* 8 <= kids/u],
  ]) assert.match(code, re, `${what}: the JS mirror above no longer matches Swift`);
});

test('the probe reports how much text rendered, never the text', () => {
  const probe = login.match(/"x:document\.body\?[^\n]*/u)?.[0];
  assert.ok(probe, 'the probe must still measure rendered text');
  assert.match(probe, /innerText\.trim\(\)\.length/u,
    'a length answers the only question asked of it');
  assert.doesNotMatch(probe, /slice\(/u,
    'a login window is a second factor; its rendered copy must not reach a log file');
  // The recheck used to log a raw prefix of this whole object, which carried the
  // earlier keys no matter what the last one held.
  assert.doesNotMatch(login, /recheck-recovered \\\(again\.prefix/u,
    'the recheck must log parsed numbers, not a slice of the probe JSON');
});

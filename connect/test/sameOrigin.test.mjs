import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin } from '../lib/origin.mjs';

// THE REGRESSION. `Referrer-Policy: no-referrer` — which this server sends for
// its own hardening — makes browsers serialize the Origin of a navigational
// form POST as the string "null". Rejecting that refused every genuine
// submission, while curl with a hand-written Origin passed. A test that only
// exercised the happy header set could not see it.
test('an opaque Origin is accepted when Sec-Fetch-Site says same-origin', () => {
  assert.equal(sameOrigin({ 'sec-fetch-site': 'same-origin', origin: 'null' }), true);
});

test('a normal same-origin browser POST is accepted', () => {
  assert.equal(
    sameOrigin({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:51788' }),
    true
  );
  assert.equal(sameOrigin({ 'sec-fetch-site': 'same-origin' }), true, 'Origin may be absent');
});

test('Sec-Fetch-Site decides when present — cross-site is refused however it is dressed', () => {
  for (const site of ['cross-site', 'same-site', 'none']) {
    assert.equal(sameOrigin({ 'sec-fetch-site': site, origin: 'http://localhost:51788' }), false, site);
    assert.equal(sameOrigin({ 'sec-fetch-site': site, origin: 'null' }), false, site);
  }
});

// The site header agreeing does not license a foreign Origin.
test('a foreign Origin is refused even with same-origin claimed', () => {
  assert.equal(
    sameOrigin({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example.com' }),
    false
  );
});

// Without the corroborating header, an opaque Origin proves nothing.
test('with no Sec-Fetch-Site, a null Origin is refused but a real local one passes', () => {
  assert.equal(sameOrigin({ origin: 'null' }), false);
  assert.equal(sameOrigin({ origin: 'http://127.0.0.1:51788' }), true);
  assert.equal(sameOrigin({ origin: 'https://evil.example.com' }), false);
  assert.equal(sameOrigin({}), true, 'no headers at all: curl and friends');
});

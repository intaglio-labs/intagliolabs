import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_TTL_MS,
  mintToken,
  revokeAll,
  revokeToken,
  validateToken,
} from '../lib/tokens.mjs';

function storePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'connect-tokens-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'nested', 'tokens.json');
}

test('the token store and its directory are owner-only', (t) => {
  const path = storePath(t);
  mintToken({ path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
});

test('a freshly minted token validates', (t) => {
  const path = storePath(t);
  const { token } = mintToken({ path });
  assert.equal(validateToken(token, { path }), true);
});

test('an unknown token never validates', (t) => {
  const path = storePath(t);
  mintToken({ path });
  assert.equal(validateToken('nope', { path }), false);
  assert.equal(validateToken('', { path }), false);
  assert.equal(validateToken(null, { path }), false);
});

// The link lives in a Messages thread forever; the credential must not.
test('a token stops validating once it expires', (t) => {
  const path = storePath(t);
  const now = 1_000_000;
  const { token } = mintToken({ path, now, ttlMs: 1000 });
  assert.equal(validateToken(token, { path, now: now + 999 }), true);
  assert.equal(validateToken(token, { path, now: now + 1001 }), false);
});

test('the default TTL is 24h', (t) => {
  const path = storePath(t);
  const now = 5_000_000;
  const { expiresAt } = mintToken({ path, now });
  assert.equal(expiresAt - now, DEFAULT_TTL_MS);
});

test('minting a new link revokes the previous one', (t) => {
  // The invariant that replaced "links accumulate for 24h". Nothing called
  // revokeToken or revokeAll in production, so every restart of the connect
  // agent added another live credential — fourteen were sitting in the log
  // when this was found. Re-minting is the unambiguous moment to close the
  // old door: the owner is asking for a new link right now, so the previous
  // one dying is exactly what they expect.
  const path = storePath(t);
  const first = mintToken({ path });
  assert.equal(first.superseded, 0, 'nothing to supersede on the first mint');
  assert.equal(validateToken(first.token, { path }), true);

  const second = mintToken({ path });
  assert.equal(second.superseded, 1, 'and it reports what it closed');
  assert.equal(validateToken(first.token, { path }), false, 'the old link is dead');
  assert.equal(validateToken(second.token, { path }), true, 'the new one works');
});

test('revokeToken kills the live link and is a no-op the second time', (t) => {
  const path = storePath(t);
  const { token } = mintToken({ path });
  assert.equal(revokeToken(token, { path }), true);
  assert.equal(validateToken(token, { path }), false);
  assert.equal(revokeToken(token, { path }), false, 'revoking twice is a no-op');
});

test('revokeAll closes every live link', (t) => {
  // Kept as the API for a future explicit "revoke access" control. With
  // supersession there is normally one live link, so this asserts the count it
  // actually closes rather than a number that supersession has made
  // impossible.
  const path = storePath(t);
  const { token } = mintToken({ path });
  assert.equal(revokeAll({ path }), 1);
  assert.equal(validateToken(token, { path }), false);
  assert.equal(revokeAll({ path }), 0, 'nothing left to close');
});

test('expired entries are pruned rather than accumulating', (t) => {
  const path = storePath(t);
  mintToken({ path, now: 0, ttlMs: 10 });
  const { token } = mintToken({ path, now: 100 });
  const store = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(store.tokens.length, 1, 'the dead entry should be gone');
  assert.equal(validateToken(token, { path, now: 100 }), true);
});

test('a corrupt store degrades to empty rather than throwing', (t) => {
  const path = storePath(t);
  mintToken({ path });
  writeFileSync(path, '{not json', { mode: 0o600 });
  assert.equal(validateToken('anything', { path }), false);
  // ...and minting still works, so onboarding is recoverable.
  const { token } = mintToken({ path });
  assert.equal(validateToken(token, { path }), true);
});

test('tokens are url-safe and unique', (t) => {
  const path = storePath(t);
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const { token } = mintToken({ path });
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    seen.add(token);
  }
  assert.equal(seen.size, 50);
});

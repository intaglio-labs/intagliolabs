// MORE THAN ONE OAUTH CLIENT, AND EACH GRANT REMEMBERS ITS OWN.
//
// Google will not renew a refresh token against a different client than the
// one that issued it. With a single client that never mattered and the answer
// was hardcoded in two files. The moment a second exists, "which client" stops
// being install configuration and becomes a property of each grant — and
// getting it wrong does not fail loudly at sign-in, it fails an hour later at
// the first refresh, on a mailbox that had been working.
//
// WHY TWO. An Internal client reaches only its own Workspace but never
// expires, needs no verification and has no cap. An External client reaches
// any Google account — including a personal one — and is capped at 100
// sensitive-scope logins for the LIFETIME of its project, never resettable,
// one spent per authorization. Sending every account through the External one
// would spend a finite, unrecoverable resource on accounts that did not need
// it (owner, 2026-08-26).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CLIENT, listGoogleClients, readGoogleClient } from '../lib/googleClients.mjs';

function box(t, { legacy = true, extra = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gclients-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  if (legacy) {
    writeFileSync(join(secrets, 'gcal-client-id.txt'), 'LEGACY-ID\n', { mode: 0o600 });
    writeFileSync(join(secrets, 'gcal-client-secret.txt'), 'LEGACY-SECRET\n', { mode: 0o600 });
  }
  for (const [name, body] of Object.entries(extra)) {
    writeFileSync(join(secrets, `google-client-${name}.json`), JSON.stringify(body), { mode: 0o600 });
  }
  return home;
}

test('the legacy pair IS the client named "default"', (t) => {
  // Not migrated, deliberately: it works, every existing grant was issued by
  // it, and rewriting a live credential to tidy a filename is how an install
  // stops being able to refresh.
  const home = box(t);
  const c = readGoogleClient(DEFAULT_CLIENT, { home });
  assert.equal(c.id, 'LEGACY-ID');
  assert.equal(c.secret, 'LEGACY-SECRET');
});

test('a grant with no client field resolves to the legacy pair', (t) => {
  // This is the whole backward-compatibility story. Tokens written before
  // clients were named carry no `client`, and the pair that issued them is
  // exactly what undefined must resolve to.
  const home = box(t);
  assert.equal(readGoogleClient(undefined, { home }).id, 'LEGACY-ID');
});

test('two clients resolve independently', (t) => {
  const home = box(t, { extra: {
    external: { client_id: 'EXT-ID', client_secret: 'EXT-SECRET', label: 'External' },
  } });
  assert.equal(readGoogleClient('default', { home }).id, 'LEGACY-ID');
  assert.equal(readGoogleClient('external', { home }).id, 'EXT-ID');
  assert.equal(readGoogleClient('external', { home }).secret, 'EXT-SECRET');
});

test('both are offered to a UI that must ask which to use', (t) => {
  const home = box(t, { extra: {
    external: { client_id: 'a', client_secret: 'b', label: 'External (any Google account)' },
  } });
  const names = listGoogleClients({ home });
  assert.deepEqual(names.map((c) => c.name), ['default', 'external']);
  assert.equal(names[1].label, 'External (any Google account)', 'the label is what a person reads');
});

test('an install with no legacy pair still lists its registered clients', (t) => {
  const home = box(t, { legacy: false, extra: {
    only: { client_id: 'a', client_secret: 'b' },
  } });
  const names = listGoogleClients({ home });
  assert.deepEqual(names.map((c) => c.name), ['only']);
  assert.equal(names[0].label, 'only', 'a missing label falls back to the name, not to blank');
});

test('a malformed client is skipped, not fatal', (t) => {
  // One bad credential must not cost the others their row — the account that
  // actually needed it is where the error belongs.
  const home = box(t, { extra: {
    good: { client_id: 'a', client_secret: 'b' },
    broken: { client_id: 'a' },
  } });
  assert.deepEqual(listGoogleClients({ home }).map((c) => c.name), ['default', 'good']);
});

test('an unknown client name throws rather than silently using the wrong one', (t) => {
  // Falling back here would pair a grant with a credential that cannot renew
  // it, and the failure would surface an hour later as a dead mailbox.
  const home = box(t);
  assert.throws(() => readGoogleClient('nope', { home }));
});

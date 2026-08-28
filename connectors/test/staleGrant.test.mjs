// A DEAD GOOGLE GRANT MUST ANNOUNCE ITSELF.
//
// The failure this closes is the quietest one a data connector has. A grant
// dies — revoked at myaccount.google.com, the account's password changed, or
// the OAuth client is still in Testing where Google expires refresh tokens
// after seven days — and nothing on disk changes. The token file still parses,
// still holds both tokens, still names its account. Every check that reads the
// filesystem says the mailbox is fine. The only way to learn otherwise is to
// ask Google and be refused, so the connector that gets refused is the one
// that has to write it down.
//
// Without that, the owner's experience is mail that stops arriving, with no
// error, no changed dot, and no way to find out short of suspecting it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GMAIL_SCOPE, accountsWithScope, accountsWithScopeIncludingStale,
  listGoogleAccounts, markGoogleAccountStale,
} from '../lib/googleAccounts.mjs';

function grant(t, { email = 'owner@example.com', scope = GMAIL_SCOPE } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'stale-grant-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const slug = email.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  const path = join(secrets, `google-tokens-${slug}.json`);
  writeFileSync(path, JSON.stringify({
    account_email: email, access_token: 'a', refresh_token: 'b',
    scope, obtained_at: 0, expires_in: 3600,
  }), { mode: 0o600 });
  return { home, path };
}

test('a healthy grant is usable and not marked', (t) => {
  const { home } = grant(t);
  assert.equal(accountsWithScope(GMAIL_SCOPE, { home }).length, 1);
  assert.equal(listGoogleAccounts({ home })[0].stale, null);
});

test('a refused grant stops being handed to connectors', (t) => {
  const { home, path } = grant(t);
  markGoogleAccountStale(path, 'Google refused the refresh token (invalid_grant)');
  // Re-presenting a refused refresh token every tick earns nothing but rate
  // limiting, and the owner has already been told.
  assert.equal(accountsWithScope(GMAIL_SCOPE, { home }).length, 0);
});

test('...but it is still LISTED, because a broken mailbox must ask to be fixed', (t) => {
  const { home, path } = grant(t);
  markGoogleAccountStale(path, 'Google refused the refresh token (invalid_grant)');
  const all = accountsWithScopeIncludingStale(GMAIL_SCOPE, { home });
  assert.equal(all.length, 1, 'hiding it is how a broken source becomes an invisible one');
  assert.equal(all[0].email, 'owner@example.com');
  assert.ok(all[0].stale && Number.isFinite(all[0].stale.since));
});

test('the tokens are kept, not cleared — the file is what remembers the account', (t) => {
  const { path } = grant(t);
  markGoogleAccountStale(path, 'invalid_grant');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.account_email, 'owner@example.com',
    'delete the file and the row vanishes instead of asking to be fixed');
  assert.equal(after.refresh_token, 'b');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'and it stays owner-only');
});

test('the FIRST failure is the one kept', (t) => {
  const { path } = grant(t);
  assert.equal(markGoogleAccountStale(path, 'first'), true);
  const since = JSON.parse(readFileSync(path, 'utf8')).stale.since;
  assert.equal(markGoogleAccountStale(path, 'second'), false, 'already recorded');
  const after = JSON.parse(readFileSync(path, 'utf8')).stale;
  assert.equal(after.since, since, 'when it broke must not drift forward on every retry');
  assert.equal(after.reason, 'first');
});

test('a fresh authorization clears the mark by overwriting the file', (t) => {
  const { home, path } = grant(t);
  markGoogleAccountStale(path, 'invalid_grant');
  assert.equal(accountsWithScope(GMAIL_SCOPE, { home }).length, 0);
  // ops/gcal-auth.mjs writes a whole new object; nothing has to remember to
  // clear the flag, which is the point of storing it in the file itself.
  writeFileSync(path, JSON.stringify({
    account_email: 'owner@example.com', access_token: 'a2', refresh_token: 'b2',
    scope: GMAIL_SCOPE, obtained_at: 0, expires_in: 3600,
  }), { mode: 0o600 });
  assert.equal(accountsWithScope(GMAIL_SCOPE, { home }).length, 1);
  assert.equal(listGoogleAccounts({ home })[0].stale, null);
});

test('marking a missing or unreadable file does not throw', (t) => {
  const { home } = grant(t);
  // The connector that discovers this is mid-run against other accounts;
  // turning a diagnosable problem into a crash would cost them their sync.
  assert.equal(markGoogleAccountStale(join(home, 'nope.json'), 'x'), false);
  const junk = join(home, '.hazlie', 'secrets', 'google-tokens-junk.json');
  writeFileSync(junk, '{oops', { mode: 0o600 });
  assert.equal(markGoogleAccountStale(junk, 'x'), false);
});

test('both Google clients record a refusal, not just log it', () => {
  // The diagnosis existed in gcalClient long before anything recorded it, and
  // it reached a daemon log rather than the owner. Pinned in both clients so
  // the next one added inherits the obligation.
  for (const f of ['gmailClient.mjs', 'gcalClient.mjs']) {
    const src = readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8');
    assert.match(src, /invalid_grant/u, `${f} must detect the dead-grant signal`);
    assert.match(src, /markGoogleAccountStale\(/u, `${f} must WRITE IT DOWN, not only throw`);
  }
});

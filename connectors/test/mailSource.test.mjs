// The mail connector, after it moved off IMAP.
//
// ~~This file tested a per-folder UID cursor guarded by UIDVALIDITY, an app
// password per mailbox, and resolveAccounts() reading mail.accounts[].~~ All
// three were IMAP's shape and none of them exists now (2026-08-26): Gmail's
// API has no folders and no UIDs, the credential is an OAuth grant rather than
// a password, and an authorized account IS a configured one.
//
// What carried over is the PROPERTY each of those tests was really defending,
// re-aimed at the mechanism that replaced it:
//
//   UIDVALIDITY discards the cursor  ->  the cursor advances only from rows
//                                        that actually ingested
//   secret file per mailbox          ->  token file per account, and an
//                                        address cannot escape its directory
//   needs() per-mailbox app password ->  needs() per-account grant
//
// The one thing that did NOT change is mailRows.mjs, which takes parsed fields
// rather than IMAP objects — so the adapter below is the new seam worth
// pinning, and the row builder keeps its own tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountSettings, createMailSource, gmailMessageToParsed } from '../sources/mail.mjs';
import { googleAccountSlug, googleTokensPath } from '../lib/googleAccounts.mjs';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

const msg = (headers, parts, internalDate = '1700000000000') => ({
  internalDate,
  payload: {
    mimeType: parts ? 'multipart/alternative' : 'text/plain',
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    ...(parts ? { parts } : { body: { data: b64url('plain body') } }),
  },
});

test('gmail headers are read case-insensitively, as the API returns them', () => {
  const p = gmailMessageToParsed(msg({
    'Message-ID': '<a@b>', From: 'x@y.co', TO: 'z@w.co', Subject: 'hi', Cc: 'c@d.co',
  }));
  assert.equal(p.messageId, '<a@b>');
  assert.equal(p.from, 'x@y.co');
  assert.equal(p.to, 'z@w.co', 'an all-caps header name must still be found');
  assert.equal(p.cc, 'c@d.co');
  assert.equal(p.subject, 'hi');
});

test('the timestamp comes from internalDate, not the Date header', () => {
  // A message with a wrong clock must not reorder the corpus. internalDate is
  // what Gmail itself sorts and filters by, so it is what the cursor compares.
  const p = gmailMessageToParsed(msg({ Date: 'Tue, 01 Jan 1990 00:00:00 +0000' }, null, '1700000000000'));
  assert.ok(p.date instanceof Date);
  assert.equal(p.date.getTime(), 1700000000000);
});

test('a message with no internalDate falls back to the Date header', () => {
  const m = msg({ Date: 'Tue, 01 Jan 1990 00:00:00 +0000' });
  delete m.internalDate;
  assert.equal(gmailMessageToParsed(m).date, 'Tue, 01 Jan 1990 00:00:00 +0000');
});

test('text/plain is preferred over text/html, and both decode from base64url', () => {
  const p = gmailMessageToParsed(msg({}, [
    { mimeType: 'text/html', body: { data: b64url('<p>html &amp; more</p>') } },
    { mimeType: 'text/plain', body: { data: b64url('the plain one') } },
  ]));
  assert.equal(p.text, 'the plain one', 'plain must win even when html comes first');
  assert.equal(p.textAsHtml, '<p>html &amp; more</p>');
});

test('an html-only message still yields a body for mailRows to strip', () => {
  const p = gmailMessageToParsed(msg({}, [
    { mimeType: 'text/html', body: { data: b64url('<p>only html</p>') } },
  ]));
  assert.equal(p.text, '');
  assert.equal(p.textAsHtml, '<p>only html</p>');
});

test('a nested multipart is walked, not just its top level', () => {
  // multipart/mixed wrapping multipart/alternative is the ordinary shape of a
  // message with an attachment; a shallow reader finds no body at all.
  const p = gmailMessageToParsed(msg({}, [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64url('nested plain') } },
    ] },
    { mimeType: 'application/pdf', body: { attachmentId: 'x' } },
  ]));
  assert.equal(p.text, 'nested plain');
});

test('a body-less message does not throw, it just has no text', () => {
  for (const junk of [undefined, null, {}, { payload: null }, { payload: { headers: null } }]) {
    const p = gmailMessageToParsed(junk);
    assert.equal(p.text, '');
    assert.equal(p.subject, null);
  }
});

test('settings fall back defaults -> per-account, and an unknown account still gets defaults', () => {
  const config = { mail: { backfillDays: 10, accounts: [{ user: 'A@Example.com', backfillDays: 90 }] } };
  assert.equal(accountSettings(config, 'a@example.com').backfillDays, 90, 'matched case-insensitively');
  assert.equal(accountSettings(config, 'other@example.com').backfillDays, 10, 'falls back to the mail default');
  assert.equal(accountSettings({}, 'x@y.co').backfillDays, 30, 'and to the built-in default');
  assert.ok(accountSettings({}, 'x@y.co').maxBodyBytes > 0);
});

test('needs() blocks only when NO account is authorized for mail', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mail-needs-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const src = createMailSource();
  const blocked = src.needs({ home });
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /gcal-auth|connect page/u, 'the message must say how to fix it');
});

test('an address cannot steer its token file out of the secrets directory', () => {
  // Same property the app-password filename had, on the credential that
  // replaced it: whatever an address contains, the file it names is [a-z0-9-].
  for (const evil of ['../../etc/passwd', 'a/../../b', 'x y@z.co', './../../root']) {
    const slug = googleAccountSlug(evil);
    assert.doesNotMatch(slug, /[/.]/u, `slug must not contain a separator or dot: ${slug}`);
    assert.ok(!googleTokensPath(evil, '/home').includes('..'));
    assert.ok(googleTokensPath(evil, '/home').startsWith('/home/.hazlie/secrets/'));
  }
});

test('two addresses that differ only in case are one account, not two', () => {
  // Gmail does not distinguish them, and two token files for one grant means
  // one of them silently goes stale.
  assert.equal(googleAccountSlug('A@Intaglio.IO'), googleAccountSlug('a@intaglio.io'));
});

// What the connect page renders for each source.
//
// Was role.test.mjs until 2026-08-22. Most of it tested the `role` machinery —
// which machine ran which connectors in a two-machine split — and went with it
// when the roles were removed. These four survived because none of them was
// ever about roles: they pin the shape of individual rows, and they kept
// failing for real reasons while the role tests only ever restated the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStatus } from '../lib/status.mjs';

function home(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'connect-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = join(dir, '.hazlie', 'connectors');
  mkdirSync(cfg, { recursive: true, mode: 0o700 });
  if (config !== undefined) {
    writeFileSync(join(cfg, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    chmodSync(join(cfg, 'config.json'), 0o600);
  }
  return dir;
}

// Replaces a pair of tests that asserted the link row rendered, and rendered as
// connected when the tunnel was up. `ops/tunnel.sh` was retired 2026-08-20 and
// the row went with it. This pins the absence so a future edit cannot
// reintroduce a row pointing at a script that is gone.
test('no link row is rendered', (t) => {
  const ids = readStatus({ home: home(t, {}) }).map((r) => r.id);
  assert.ok(!ids.includes('tunnel'), 'a link row came back');
});

// An install that still carries a `role` key must keep working. The daemon
// accepts and ignores it rather than throwing on an unknown key; the page must
// not treat it as meaningful either.
test('a leftover role key changes nothing', (t) => {
  const withRole = readStatus({ home: home(t, { role: 'hazlie' }) }).map((r) => r.id);
  const without = readStatus({ home: home(t, {}) }).map((r) => r.id);
  assert.deepEqual(withRole, without);
});

// The row has to follow the configured backend: checking the local store while
// the connector reads Google would report "connected" on the strength of a file
// the connector never opens — and on this seed the local store holds zero
// events for every Google calendar, so the page would be wrong both ways.
test('the calendar row follows the configured backend', (t) => {
  const googleHome = home(t, { calendar: { backend: 'google' } });
  const google = readStatus({ home: googleHome });
  const row = google.find((r) => r.id === 'calendar');
  assert.equal(row.connected, false, 'no tokens in a temp home');
  assert.match(row.detail, /authoriz/iu);
  assert.equal(row.action, 'gcal');

  grantMailbox(
    googleHome,
    'owner@example.com',
    [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' ')
  );
  const authorized = readStatus({ home: googleHome }).find((r) => r.id === 'calendar');
  assert.equal(authorized.connected, true, 'the per-account token store is the calendar truth');
  assert.equal(authorized.action, null);

  const local = readStatus({ home: home(t, { calendar: { backend: 'local' } }) });
  assert.equal(local.find((r) => r.id === 'calendar').action, 'fda');
});

// Files needs no credential and no network: it reads the local mirrors those
// services already maintain. "Connected" therefore means the folders exist.
test('the files row reports which cloud folders are actually present', (t) => {
  const dir = home(t, {});
  const rows = readStatus({ home: dir });
  const files = rows.find((r) => r.id === 'files');
  assert.equal(files.connected, false, 'a temp home has none of them');
  assert.match(files.detail, /no iCloud, Box or Dropbox/u);

  mkdirSync(join(dir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true });
  const withIcloud = readStatus({ home: dir }).find((r) => r.id === 'files');
  assert.equal(withIcloud.connected, true);
  assert.match(withIcloud.detail, /iCloud Drive/u);
  assert.doesNotMatch(withIcloud.detail, /Dropbox/u, 'only names folders that exist');
});

test('notion reports on the token file, which must be owner-only', (t) => {
  const dir = home(t, {});
  assert.equal(readStatus({ home: dir }).find((r) => r.id === 'notion').connected, false);

  const secrets = join(dir, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const token = join(secrets, 'notion-api-key.txt');
  writeFileSync(token, 'ntn_x', { mode: 0o644 });
  chmodSync(token, 0o644);
  assert.equal(
    readStatus({ home: dir }).find((r) => r.id === 'notion').connected,
    false,
    'a world-readable token is not a connected token'
  );
  chmodSync(token, 0o600);
  assert.equal(readStatus({ home: dir }).find((r) => r.id === 'notion').connected, true);
});

test('WhatsApp stays explicitly disconnected until Intaglio Labs enables it', (t) => {
  const dir = home(t, {});
  const store = join(dir, 'Library', 'Group Containers',
    'group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite');
  mkdirSync(join(store, '..'), { recursive: true });
  writeFileSync(store, 'WhatsApp owns this file');

  const marker = join(dir, '.hazlie', 'connectors', 'whatsapp.disabled');
  writeFileSync(marker, '', { mode: 0o600 });
  const disabled = readStatus({ home: dir }).find((r) => r.id === 'whatsapp');
  assert.equal(disabled.connected, false);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.action, 'enable');

  rmSync(marker);
  const enabled = readStatus({ home: dir }).find((r) => r.id === 'whatsapp');
  assert.equal(enabled.connected, true, 'the existing WhatsApp store is used only after consent');
});

// A mailbox is an OAuth GRANT now, not a config entry — so this seeds a token
// file rather than mail.accounts[]. The property under test is unchanged and
// still the one that matters: a `mail.disabled` marker must reach the mail rows
// however they came to exist. withDisabled() is mapped over every row, so this
// is really asking whether the id a grant produces still resolves to the "mail"
// connector; it would not if the row ids ever drifted.
function grantMailbox(
  dir,
  address,
  scope = 'https://www.googleapis.com/auth/gmail.readonly'
) {
  const secrets = join(dir, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const slug = address.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  writeFileSync(join(secrets, `google-tokens-${slug}.json`), JSON.stringify({
    account_email: address,
    access_token: 'x', refresh_token: 'y',
    scope,
    obtained_at: 0, expires_in: 3600,
  }), { mode: 0o600 });
}

test('shared connector disable markers apply to account and platform rows', (t) => {
  const dir = home(t, {});
  grantMailbox(dir, 'owner@example.com');
  const markerDir = join(dir, '.hazlie', 'connectors');
  writeFileSync(join(markerDir, 'mail.disabled'), '', { mode: 0o600 });
  writeFileSync(join(markerDir, 'matrix.disabled'), '', { mode: 0o600 });

  const rows = readStatus({ home: dir });
  const mail = rows.find((row) => row.id === 'mail:owner@example.com');
  assert.ok(mail, 'the grant must produce a mail row at all');
  assert.equal(mail.connected, false);
  assert.equal(mail.detail, 'turned off');
  assert.match(mail.fix, /mail\.disabled/u);

  for (const id of ['messenger', 'linkedin']) {
    const platform = rows.find((row) => row.id === id);
    assert.equal(platform.connected, false);
    assert.equal(platform.detail, 'turned off');
  }
});

// ~~"adding a mailbox never replaces a corrupt connectors config".~~ Removed in
// the merge (2026-08-26), and the catch behind it was RIGHT: addMailAccount as
// first written would silently overwrite a corrupt config.json, and this test
// was added to stop it. Both are gone because the function is — mail is an
// OAuth grant now, so the connect page no longer registers a mailbox in that
// file and nothing here writes it at all. A test for a writer that does not
// exist cannot fail in a way that means anything.

// The connect page's half of the same contract: a mailbox whose grant died
// must render as BROKEN and still offer the way back, not vanish.
test('a stale Google grant renders as broken, listed, and fixable', (t) => {
  const dir = home(t, {});
  grantMailbox(dir, 'owner@example.com');
  const tok = join(dir, '.hazlie', 'secrets', 'google-tokens-owner-example-com.json');
  const t0 = JSON.parse(readFileSync(tok, 'utf8'));
  writeFileSync(tok, JSON.stringify({ ...t0, stale: { since: 1, reason: 'invalid_grant' } }),
    { mode: 0o600 });

  const row = readStatus({ home: dir }).find((r) => r.id === 'mail:owner@example.com');
  assert.ok(row, 'a dead mailbox must still be drawn — hiding it is the silence this prevents');
  assert.equal(row.connected, false);
  assert.equal(row.broken, true, 'broken is what pins the tile to the front of the shelf');
  assert.match(row.detail, /sign in again/u);
  assert.equal(row.action, 'gcal', 'and the row must carry the way to fix it');
  assert.match(row.fix, /revoked|password|Testing/u, 'the fix text should name the likely causes');
});

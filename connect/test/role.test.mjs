import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRole, readStatus } from '../lib/status.mjs';

function home(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'connect-role-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = join(dir, '.hazlie', 'connectors');
  mkdirSync(cfg, { recursive: true, mode: 0o700 });
  if (config !== undefined) {
    writeFileSync(join(cfg, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    chmodSync(join(cfg, 'config.json'), 0o600);
  }
  return dir;
}

test('the role comes from the same config the daemon reads', (t) => {
  assert.equal(readRole({ home: home(t, { role: 'personal' }) }), 'personal');
  assert.equal(readRole({ home: home(t, { role: 'hazlie' }) }), 'hazlie');
});

// An install with no role is the single-machine one that already works.
test('a missing or unreadable config means hazlie, not personal', (t) => {
  assert.equal(readRole({ home: home(t, undefined) }), 'hazlie');
  assert.equal(readRole({ home: home(t, {}) }), 'hazlie');
  const dir = home(t, {});
  writeFileSync(join(dir, '.hazlie', 'connectors', 'config.json'), '{broken', { mode: 0o600 });
  assert.equal(readRole({ home: dir }), 'hazlie');
});

// One row, not six. The other sources belong to the other machine and would
// render as dead buttons here.
test('the personal role shows only Messages', (t) => {
  const rows = readStatus({ home: home(t, { role: 'personal' }) });
  assert.deepEqual(rows.map((r) => r.id), ['imessage']);
});

// Replaces a pair of tests that asserted the link row rendered, and rendered
// as connected when the tunnel was up. `ops/tunnel.sh` was retired 2026-08-20
// and the row went with it; this pins the absence across every role so a
// future edit cannot reintroduce a row pointing at a script that is gone.
test('no role renders a link row, on any machine', (t) => {
  for (const role of ['personal', 'hazlie', 'full', 'courier']) {
    const ids = readStatus({ home: home(t, { role }) }).map((r) => r.id);
    assert.ok(!ids.includes('tunnel'), `${role} still renders a link row`);
  }
});

test('the hazlie role shows the sources the Mini owns, and never imessage', (t) => {
  const ids = readStatus({ home: home(t, { role: 'hazlie' }) }).map((r) => r.id);
  assert.ok(ids.includes('calendar') && ids.includes('granola') && ids.includes('oura'));
  assert.ok(!ids.includes('imessage'), "the Mini has its own Apple ID, not the owner's history");
  assert.ok(!ids.includes('tunnel'), 'the Mini was what the tunnel pointed AT');
});

// The MacBook after the 2026-08-20 migration: it runs every connector, so the
// page has to show every source. This is the regression that motivated the
// `full` branch — before it, a full install fell through to hazlieStatus and
// the owner's three biggest sources were simply absent from their own page.
test('the full role shows every source, including the three Apple stores', (t) => {
  const ids = readStatus({ home: home(t, { role: 'full' }) }).map((r) => r.id);
  for (const id of ['imessage', 'photos', 'notes', 'files', 'calendar', 'granola', 'oura', 'notion']) {
    assert.ok(ids.includes(id), `${id} missing from the full page`);
  }
  assert.ok(!ids.includes('tunnel'), 'hermes is local now; there is no link to show');
});

test('the courier shows nothing, because it reads nothing', (t) => {
  assert.deepEqual(readStatus({ home: home(t, { role: 'courier' }) }), []);
});

// An unknown role must not silently become a reader-only or a read-everything
// page; it falls back to the single-machine install that already works.
test('an unrecognised role falls back to hazlie', (t) => {
  assert.equal(readRole({ home: home(t, { role: 'wat' }) }), 'hazlie');
});

// The row has to follow the configured backend. Checking the local store while
// the connector reads Google would report "connected" on the strength of a
// file the connector never opens — and on this seed the local store holds zero
// events for every Google calendar, so the page would be wrong both ways.
test('the calendar row follows the configured backend', (t) => {
  const google = readStatus({ home: home(t, { role: 'hazlie', calendar: { backend: 'google' } }) });
  const row = google.find((r) => r.id === 'calendar');
  assert.equal(row.connected, false, 'no tokens in a temp home');
  assert.match(row.detail, /authoriz/iu);
  assert.equal(row.action, 'gcal');

  const local = readStatus({ home: home(t, { role: 'hazlie', calendar: { backend: 'local' } }) });
  assert.equal(local.find((r) => r.id === 'calendar').action, 'fda');
});

// Files needs no credential and no network: it reads the local mirrors those
// services already maintain. "Connected" therefore means the folders exist.
test('the files row reports which cloud folders are actually present', (t) => {
  const dir = home(t, { role: 'full' });
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
  const dir = home(t, { role: 'full' });
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

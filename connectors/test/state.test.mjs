import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStateDb } from '../lib/state.mjs';
import { wipeLocalArtifacts } from '../retain.mjs';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-state-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('openStateDb enforces 0700 directory and 0600 file modes', (t) => {
  const dir = sandbox(t);
  const path = join(dir, 'private', 'state.db');
  const state = openStateDb(path);
  t.after(() => state.close());
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Hardened like hermes' own store: deleted cursors and contact names must
  // not stay legible in the free list or in a -wal sidecar.
  assert.equal(Number(state.db.prepare('PRAGMA secure_delete').get().secure_delete), 1);
  assert.equal(
    String(state.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(),
    'delete'
  );
});

test('openStateDb refuses a state directory that is not 0700', (t) => {
  const dir = sandbox(t);
  const loose = join(dir, 'loose');
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o755); // explicit: mkdir mode is filtered by umask
  assert.throws(() => openStateDb(join(loose, 'state.db')), /must have mode 0700/);
});

test('cursor round-trip: absent, set, overwrite', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  assert.equal(state.getCursor('imessage:rowid'), null);
  state.setCursor('imessage:rowid', '48213');
  assert.equal(state.getCursor('imessage:rowid'), '48213');
  state.setCursor('imessage:rowid', '48500');
  assert.equal(state.getCursor('imessage:rowid'), '48500');
  // One row per name — the upsert replaced, it did not accumulate.
  assert.equal(Number(state.db.prepare('SELECT count(*) AS n FROM cursor').get().n), 1);
});

test('cursor values must be pre-serialized strings', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  // Storing a number invites a lossy round-trip at the 2^53 boundary, so the
  // caller serializes; refusing here keeps the mistake at its source.
  assert.throws(() => state.setCursor('mail:uid', 42), /serialize before storing/);
  assert.throws(() => state.setCursor('', 'x'), /non-empty/);
});

test('deleteCursors wipes a connector namespace and nothing adjacent', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.setCursor('mail', 'root');
  state.setCursor('mail:INBOX:uidvalidity', '7');
  state.setCursor('mail:Sent:uid', '19');
  state.setCursor('mailx', 'must survive'); // prefix-adjacent, different connector
  assert.equal(state.deleteCursors('mail'), 3);
  assert.equal(state.getCursor('mail:INBOX:uidvalidity'), null);
  assert.equal(state.getCursor('mailx'), 'must survive');
});

test('recordRun lands a complete row, and counts default to zero', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.recordRun({
    connector: 'granola',
    startedTs: 1755500000000,
    finishedTs: 1755500002000,
    ok: true,
    ingested: 3,
    unchanged: 9,
  });
  state.recordRun({
    connector: 'oura',
    startedTs: 1755500003000,
    finishedTs: 1755500003500,
    ok: false,
    error: 'oura tokens file is missing',
  });
  const rows = state.db.prepare('SELECT * FROM run_log ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].connector, 'granola');
  assert.equal(Number(rows[0].ok), 1);
  assert.equal(Number(rows[0].ingested), 3);
  assert.equal(Number(rows[0].updated), 0);
  assert.equal(Number(rows[0].unchanged), 9);
  assert.equal(rows[0].error, null);
  assert.equal(Number(rows[1].ok), 0);
  assert.match(rows[1].error, /missing/);
  assert.throws(() => state.recordRun({ connector: 'x', startedTs: NaN, finishedTs: 1, ok: true }), /epoch ms/);
});

test('contacts upsert and resolve, with the kind set closed', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.upsertContacts([
    { identifier: '+14155550142', displayName: 'Casey', kind: 'phone' },
    { identifier: 'casey@example.com', displayName: 'Casey', kind: 'email' },
  ]);
  assert.deepEqual(state.resolveIdentifier('+14155550142'), { displayName: 'Casey', kind: 'phone' });
  assert.equal(state.resolveIdentifier('+10000000000'), null);
  // Re-upsert with a new name replaces in place.
  state.upsertContacts({ identifier: '+14155550142', displayName: 'Casey K', kind: 'phone' });
  assert.equal(state.resolveIdentifier('+14155550142').displayName, 'Casey K');
  assert.equal(Number(state.db.prepare('SELECT count(*) AS n FROM contact_ids').get().n), 2);
  assert.throws(
    () => state.upsertContacts({ identifier: 'x', displayName: 'y', kind: 'carrier-pigeon' }),
    /"kind" must be one of/
  );
});

test('a bad contact rejects the whole batch and writes none of it', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  assert.throws(
    () =>
      state.upsertContacts([
        { identifier: '+14155550101', displayName: 'Fine', kind: 'phone' },
        { identifier: '', displayName: 'Broken', kind: 'phone' },
      ]),
    /contacts\[1\]/
  );
  assert.equal(Number(state.db.prepare('SELECT count(*) AS n FROM contact_ids').get().n), 0);
});

test('contact avatar snapshots remove stale and deleted photos', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.replaceAvatars([
    { identifier: '+14155550101', jpeg: new Uint8Array([1, 2, 3]) },
    { identifier: '+14155550102', jpeg: new Uint8Array([4, 5, 6]) },
  ]);
  state.replaceAvatars([
    { identifier: '+14155550102', jpeg: new Uint8Array([7, 8, 9]) },
  ]);

  const rows = state.db.prepare(
    'SELECT identifier, jpeg FROM contact_avatars ORDER BY identifier'
  ).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].identifier, '+14155550102');
  assert.deepEqual([...rows[0].jpeg], [7, 8, 9]);

  state.replaceAvatars([]);
  assert.equal(Number(state.db.prepare('SELECT count(*) AS n FROM contact_avatars').get().n), 0);
});

test('a contacts purge removes names and private avatar bytes', (t) => {
  const dir = sandbox(t);
  const state = openStateDb(join(dir, 'state.db'));
  t.after(() => state.close());
  state.upsertContacts({
    identifier: 'person@example.com',
    displayName: 'Person',
    kind: 'email',
  });
  state.replaceAvatars({
    identifier: 'person@example.com',
    jpeg: new Uint8Array([1, 2, 3]),
  });

  wipeLocalArtifacts('contacts', { state, cacheDir: join(dir, 'cache') });
  assert.equal(Number(state.db.prepare('SELECT count(*) AS n FROM contact_ids').get().n), 0);
  assert.equal(Number(state.db.prepare('SELECT count(*) AS n FROM contact_avatars').get().n), 0);
});

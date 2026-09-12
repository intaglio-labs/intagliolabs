import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('an existing contact spine migrates to person_ref without losing rows', (t) => {
  const root = sandbox(t);
  const dir = join(root, 'private');
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, 'state.db');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE contact_ids(identifier TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'contacts', updated_ts INTEGER NOT NULL)");
  legacy.prepare('INSERT INTO contact_ids VALUES (?,?,?,?,?)').run('old@example.test', 'Old Contact', 'email', 'contacts', 1);
  legacy.close();
  chmodSync(path, 0o600);

  const state = openStateDb(path);
  t.after(() => state.close());
  const columns = new Set(state.db.prepare("SELECT name FROM pragma_table_info('contact_ids')").all().map((row) => row.name));
  assert.ok(columns.has('person_ref'));
  assert.equal(state.db.prepare('SELECT display_name FROM contact_ids WHERE identifier = ?').get('old@example.test').display_name, 'Old Contact');
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
  // ONE COUNT PER THING COUNTED: this connector's namespace, and the shared
  // walk rows (none here — mail took no part in a yearly walk in this fixture).
  assert.deepEqual(state.deleteCursors('mail'), { cursorsDeleted: 3, yearlyWalkReopened: 0 });
  assert.equal(state.getCursor('mail:INBOX:uidvalidity'), null);
  assert.equal(state.getCursor('mailx'), 'must survive');
});

// THE 2026-09-12 MAIL PURGE. `node run.mjs mail --purge` deleted 81,725 rows
// from hermes and left every scheduler-side key behind, because
// `yearly-backfill:connector:mail:done:<year>` is not in the `mail:` namespace.
// The re-pull fetched a few days forward and one unfinished history year; 2024,
// 2025 and 2026 were still marked done and would never have been fetched again.
// So this seeds two connectors and purges one: a key that survives here is a
// year that silently never comes back.
test('a purge forgets the scheduler’s progress too, and only this connector’s', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());

  // The exact shapes observed on the machine.
  state.setCursor('mail:someone@example.com:internalDate', '1757000000000');
  state.setCursor('mail:someone@example.com:history-year:2024:done', '1');
  state.setCursor('mail:someone@example.com:history-year:2024:has-older', '0');
  state.setCursor('mail:someone@example.com:history-year:2026:page', 'token');
  state.setCursor('yearly-backfill:connector:mail:done:2024', '1');
  state.setCursor('yearly-backfill:connector:mail:done:2025', '1');
  state.setCursor('yearly-backfill:connector:mail:done:2026', '1');
  state.setCursor('yearly-backfill:connector:mail:exhausted', '0');
  // A rolling ETA measurement, not progress: it describes the machine and
  // survives on purpose.
  state.setCursor('mail:history-slices-per-pass', '14');
  // Another connector, and the scheduler's own shared keys. Neither is this
  // purge's business.
  state.setCursor('imessage:history-year:2024:ceiling', '17');
  state.setCursor('yearly-backfill:connector:imessage:done:2024', '1');
  state.setCursor('yearly-backfill:year', '2024');
  state.setCursor('yearly-backfill:complete', '0');
  state.setCursor('yearly-backfill:barrier:people:done:2024', '1');

  // Eight in mail's own namespace, and the walk reopen counted separately:
  // the two global keys plus the current year's People barrier, because mail
  // was one of the sources that barrier was counting. Folding them into one
  // total was how a purge of ONE connector reported a number that described
  // rows belonging to nobody's namespace. See below.
  assert.deepEqual(state.deleteCursors('mail'), { cursorsDeleted: 8, yearlyWalkReopened: 2 });

  for (const gone of [
    'mail:someone@example.com:internalDate',
    'mail:someone@example.com:history-year:2024:done',
    'mail:someone@example.com:history-year:2024:has-older',
    'mail:someone@example.com:history-year:2026:page',
    'yearly-backfill:connector:mail:done:2024',
    'yearly-backfill:connector:mail:done:2025',
    'yearly-backfill:connector:mail:done:2026',
    'yearly-backfill:connector:mail:exhausted',
  ]) {
    assert.equal(state.getCursor(gone), null, `${gone} must not survive a purge`);
  }
  assert.equal(state.getCursor('mail:history-slices-per-pass'), '14',
    'the rolling slice measurement is about the machine, not the rows');
  for (const [kept, value] of [
    ['imessage:history-year:2024:ceiling', '17'],
    ['yearly-backfill:connector:imessage:done:2024', '1'],
    ['yearly-backfill:barrier:people:done:2024', '1'],
  ]) {
    assert.equal(state.getCursor(kept), value, `${kept} belongs to somebody else`);
  }
  // AND THE GLOBAL GATE IS NOT SOMEBODY ELSE'S. `yearly-backfill:complete` is
  // the barrier saying every history source has finished walking, and
  // yearlyBackfill.task() short-circuits on it for EVERY connector — so left
  // standing after mail's checkpoints are gone it means mail is never
  // scheduled to walk its history again: the rows come back forward-only and
  // the purged years stay purged. The saved year goes with it, because a walk
  // reopened at 1997 would not re-fetch the recent years either; absent reads
  // as the current year, which is where a re-walk starts.
  assert.equal(state.getCursor('yearly-backfill:complete'), null,
    'the barrier cannot still say the walk is finished');
  assert.equal(state.getCursor('yearly-backfill:year'), null,
    'and the reopened walk starts at the current year');
});

test('a purge of a source that never walked history leaves the barrier alone', (t) => {
  // The gate is this connector's OWN evidence, not a walksHistory flag the
  // caller would have to supply — run.mjs's purge path never loads the source
  // module. A connector with no yearly-backfill rows contributed nothing the
  // barrier could have been counting, so nothing about it is now untrue.
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.setCursor('notion:page-cursor', 'abc');
  state.setCursor('yearly-backfill:connector:imessage:done:2025', '1');
  state.setCursor('yearly-backfill:year', '2024');
  state.setCursor('yearly-backfill:complete', '1');

  assert.deepEqual(state.deleteCursors('notion'), { cursorsDeleted: 1, yearlyWalkReopened: 0 });
  assert.equal(state.getCursor('yearly-backfill:complete'), '1');
  assert.equal(state.getCursor('yearly-backfill:year'), '2024');
});

test('and the same is true through the helper --purge actually calls', (t) => {
  const dir = sandbox(t);
  const state = openStateDb(join(dir, 'state.db'));
  t.after(() => state.close());
  state.setCursor('mail:someone@example.com:internalDate', '1757000000000');
  state.setCursor('yearly-backfill:connector:mail:done:2025', '1');
  state.setCursor('yearly-backfill:connector:imessage:done:2025', '1');

  state.setCursor('yearly-backfill:complete', '1');
  state.setCursor('yearly-backfill:year', '2019');

  const { cursorsDeleted, yearlyWalkReopened } = wipeLocalArtifacts('mail', { state, cacheDir: join(dir, 'cache') });
  // Printed by run.mjs: the only way an operator tells a complete purge from
  // the old half of one is to see the number — and it has to be the number for
  // THIS connector, which is the two rows under `mail:` and
  // `yearly-backfill:connector:mail:`. The shared complete/year pair is the
  // walk reopen and is reported as itself.
  assert.equal(cursorsDeleted, 2);
  assert.equal(yearlyWalkReopened, 2);
  assert.equal(state.getCursor('yearly-backfill:connector:mail:done:2025'), null);
  assert.equal(state.getCursor('yearly-backfill:connector:imessage:done:2025'), '1');
  // The gate mail was counted in, through the helper --purge actually calls.
  assert.equal(state.getCursor('yearly-backfill:complete'), null);
  assert.equal(state.getCursor('yearly-backfill:year'), null);
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
    { identifier: '+14155550142', displayName: 'Casey', kind: 'phone', personRef: 'card-casey' },
    { identifier: 'casey@example.com', displayName: 'Casey', kind: 'email', personRef: 'card-casey' },
  ]);
  assert.deepEqual(state.resolveIdentifier('+14155550142'), { displayName: 'Casey', kind: 'phone' });
  assert.equal(state.resolveIdentifier('+10000000000'), null);
  // Re-upsert with a new name replaces in place.
  state.upsertContacts({ identifier: '+14155550142', displayName: 'Casey K', kind: 'phone' });
  assert.equal(state.resolveIdentifier('+14155550142').displayName, 'Casey K');
  assert.equal(Number(state.db.prepare('SELECT count(*) AS n FROM contact_ids').get().n), 2);
  assert.deepEqual(
    state.db.prepare('SELECT DISTINCT person_ref FROM contact_ids').all().map((row) => row.person_ref),
    ['card-casey']
  );
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

test('a full contact snapshot removes stale memberships but preserves calendar fallbacks', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.upsertContacts([
    { identifier: 'old@example.test', displayName: 'A Person', kind: 'email', personRef: 'card-a' },
    { identifier: 'keep@example.test', displayName: 'A Person', kind: 'email', personRef: 'card-a' },
    { identifier: 'invite@example.test', displayName: 'Invite Name', kind: 'email', source: 'calendar' },
  ]);

  state.replaceContacts([
    { identifier: 'keep@example.test', displayName: 'A Person', kind: 'email', personRef: 'card-a' },
    { identifier: 'new@example.test', displayName: 'A Person', kind: 'email', personRef: 'card-a' },
  ]);

  assert.equal(state.resolveIdentifier('old@example.test'), null);
  assert.deepEqual(state.resolveIdentifier('invite@example.test'), { displayName: 'Invite Name', kind: 'email' });
  assert.deepEqual(
    state.db.prepare('SELECT identifier, person_ref FROM contact_ids WHERE source = ? ORDER BY identifier')
      .all('contacts').map((row) => ({ ...row })),
    [
      { identifier: 'keep@example.test', person_ref: 'card-a' },
      { identifier: 'new@example.test', person_ref: 'card-a' },
    ]
  );
});

test('an invalid full contact snapshot is rejected before deleting the old one', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.replaceContacts({
    identifier: 'safe@example.test', displayName: 'Safe', kind: 'email', personRef: 'safe-card',
  });
  assert.throws(
    () => state.replaceContacts([{ identifier: '', displayName: 'Broken', kind: 'email' }]),
    /contacts\[0\]/
  );
  assert.deepEqual(state.resolveIdentifier('safe@example.test'), { displayName: 'Safe', kind: 'email' });
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

test('reopening the walk clears the barriers for the year the walk restarts at', (t) => {
  const dir = sandbox(t);
  const state = openStateDb(join(dir, 'state.db'));
  t.after(() => state.close());
  const wallYear = new Date().getFullYear();
  const walkYear = 2031; // any year the wall clock is not in

  state.setCursor('mail:someone@example.com:internalDate', '1757000000000');
  state.setCursor(`yearly-backfill:connector:mail:done:${walkYear}`, '1');
  state.setCursor('yearly-backfill:complete', '1');
  state.setCursor('yearly-backfill:year', String(walkYear));
  state.setCursor(`yearly-backfill:barrier:people:done:${walkYear}`, '1');
  state.setCursor(`yearly-backfill:barrier:people:done:${wallYear}`, '1');

  // ONE WALK, ONE CLOCK. yearlyBackfill resolves the walk's year through an
  // injected `now`; this read the wall clock, so under a test clock — or a
  // purge that straddles midnight on 31 December — it cleared the barriers for
  // a year the walk was not restarting at. advance() then steps past the year
  // it IS restarting at with its product phase still marked done.
  const { yearlyWalkReopened } = wipeLocalArtifacts('mail', {
    state,
    cacheDir: join(dir, 'cache'),
    now: () => new Date(walkYear, 5, 1).getTime(),
  });

  assert.equal(state.getCursor(`yearly-backfill:barrier:people:done:${walkYear}`), null,
    'the year the walk restarts at cannot still be marked done');
  assert.equal(state.getCursor(`yearly-backfill:barrier:people:done:${wallYear}`), '1',
    "and another year's finished work is not this purge's business");
  assert.equal(yearlyWalkReopened, 3, 'complete, year, and the one barrier for that year');
});

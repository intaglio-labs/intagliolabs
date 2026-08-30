// L5 step 2: claim.subject widens to ('owner','person') with
// subject_person_key, the v10 rebuild migration, and the bitemporal names
// (recorded_at, producer_version) in the pending API. The migration test
// builds a genuine v9-schema database file by hand — the rebuild path only
// runs against a table carrying the old CHECK, which a fresh openDb() never
// has, so exercising it any other way tests nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows, applyMemoryBatch, pendingClaims, decideClaim } from '../server/hermes.mjs';

const NOW = Date.now();

const RUN = {
  model: 'test-model', prompt_path: 'prompts/test.txt', prompt_sha: 'a'.repeat(64),
  params: {}, rows_in: 1, started_at: NOW,
};

function seedRow(db, text = 'lunch with jane next friday') {
  insertRows(db, [{ ts: NOW - 1000, source: 'imessage', entity_id: 'e:1', text,
    meta: { chat_handle: '+18085550100', is_from_me: true } }]);
  return Number(db.prepare('SELECT id FROM context ORDER BY id DESC LIMIT 1').get().id);
}

function apply(db, contextId, claim) {
  return applyMemoryBatch(db, { run: RUN, claims: [{
    kind: 'fact', text: 'a fact', source: { context_id: contextId, quote: 'lunch' }, ...claim,
  }] });
}

test('a person claim lands with its key; absent subject still means owner', () => {
  const db = openDb(':memory:');
  const id = seedRow(db);
  apply(db, id, { subject: 'person', subject_person_key: 'name:jane doe', text: 'jane prefers fridays' });
  apply(db, id, { text: 'the owner is busy fridays' }); // no subject field at all
  const rows = db.prepare('SELECT subject, subject_person_key FROM claim ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { subject: 'person', subject_person_key: 'name:jane doe' },
    { subject: 'owner', subject_person_key: null },
  ]);
});

test('the closed-field rules: person needs a key, owner refuses one, junk subjects bounce', () => {
  const db = openDb(':memory:');
  const id = seedRow(db);
  assert.throws(() => apply(db, id, { subject: 'person' }), /requires "subject_person_key"/);
  assert.throws(() => apply(db, id, { subject: 'person', subject_person_key: '  ' }), /requires "subject_person_key"/);
  assert.throws(() => apply(db, id, { subject_person_key: 'name:jane doe' }), /only accepted when subject/);
  assert.throws(() => apply(db, id, { subject: 'them' }), /"subject" must be/);
});

test('the schema CHECK holds even against a direct write', () => {
  const db = openDb(':memory:');
  seedRow(db);
  db.prepare("INSERT INTO distill_run(model, prompt_path, prompt_sha, params, rows_in, claims_out, status, started_at) VALUES ('m','p','s','{}',0,0,'complete',1)").run();
  const ins = db.prepare(
    'INSERT INTO claim(run_id, subject, subject_person_key, kind, text, created_at) VALUES (1, ?, ?, \'fact\', \'x\', 1)');
  assert.throws(() => ins.run('person', null), /CHECK/);
  assert.throws(() => ins.run('owner', 'name:jane doe'), /CHECK/);
});

test('pending names transaction time and producer version, and the lifecycle is the same one', () => {
  const db = openDb(':memory:');
  const id = seedRow(db);
  apply(db, id, { subject: 'person', subject_person_key: 'name:jane doe', text: 'jane prefers fridays' });
  const { claims } = pendingClaims(db);
  assert.equal(claims.length, 1);
  const c = claims[0];
  assert.equal(c.subject, 'person');
  assert.equal(c.subject_person_key, 'name:jane doe');
  assert.equal(c.recorded_at, c.created_at, 'recorded_at IS transaction time, named');
  assert.equal(c.producer_version, `${RUN.model}@${RUN.prompt_sha}`);
  // Same trust lifecycle: the person claim is decided through claim_decision
  // like any owner claim, no parallel machinery.
  decideClaim(db, { claim_id: c.id, action: 'accept' });
  assert.equal(pendingClaims(db).claims.length, 0);
});

// ---------------------------------------------------------------------------
// The v10 migration, against a real v9 database.
// ---------------------------------------------------------------------------

function buildV9Db(path) {
  const db = new DatabaseSync(path);
  // The v9-era tables the rebuild touches or checks, with the OLD claim CHECK.
  // distill_run carries its post-v8 shape because user_version=9 skips those
  // ALTER branches. context matches current SCHEMA (IF NOT EXISTS leaves it).
  db.exec(`
    CREATE TABLE context(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL,
      speaker TEXT, text TEXT NOT NULL, meta TEXT, entity_id TEXT, content_hash TEXT,
      store_changed_at INTEGER);
    CREATE TABLE distill_run(id INTEGER PRIMARY KEY, model TEXT NOT NULL, prompt_path TEXT NOT NULL,
      prompt_sha TEXT NOT NULL, params TEXT NOT NULL, from_changed_at INTEGER,
      through_changed_at INTEGER, through_id INTEGER, episode_hash TEXT,
      episode_context TEXT CHECK (episode_context IN ('off','on')),
      rows_in INTEGER NOT NULL DEFAULT 0, claims_out INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
      started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE claim(id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES distill_run(id) ON DELETE CASCADE,
      subject TEXT NOT NULL CHECK (subject = 'owner'),
      kind TEXT NOT NULL CHECK (kind IN ('fact','preference','constraint','plan','commitment')),
      text TEXT NOT NULL, observed_at INTEGER, valid_to INTEGER, p_claim REAL,
      created_at INTEGER NOT NULL);
    CREATE INDEX claim_run ON claim(run_id);
    CREATE TABLE claim_source(claim_id INTEGER NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
      context_id INTEGER NOT NULL REFERENCES context(id), source TEXT NOT NULL, entity_id TEXT,
      content_hash TEXT, quote TEXT NOT NULL, PRIMARY KEY (claim_id, context_id));
    CREATE TABLE claim_decision(id INTEGER PRIMARY KEY,
      claim_id INTEGER NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('accept','reject','retract')),
      actor TEXT NOT NULL CHECK (actor IN ('owner','system')), reason TEXT,
      created_at INTEGER NOT NULL);
    CREATE VIRTUAL TABLE claim_fts USING fts5(text, content='claim', content_rowid='id',
      tokenize='porter unicode61');
    CREATE TRIGGER claim_ai AFTER INSERT ON claim BEGIN
      INSERT INTO claim_fts(rowid, text) VALUES (new.id, new.text); END;
    INSERT INTO context(id, ts, source, text, store_changed_at)
      VALUES (1, ${NOW}, 'imessage', 'lunch with jane next friday', ${NOW});
    INSERT INTO distill_run(id, model, prompt_path, prompt_sha, params, rows_in, claims_out, status, started_at)
      VALUES (1, 'old-model', 'p', 'oldsha', '{}', 1, 1, 'complete', ${NOW});
    INSERT INTO claim(id, run_id, subject, kind, text, created_at)
      VALUES (7, 1, 'owner', 'preference', 'the owner prefers fridays', ${NOW});
    INSERT INTO claim_source(claim_id, context_id, source, quote)
      VALUES (7, 1, 'imessage', 'lunch');
    INSERT INTO claim_decision(claim_id, action, actor, created_at)
      VALUES (7, 'accept', 'owner', ${NOW});
    PRAGMA user_version = 9;
  `);
  db.close();
}

test('v10 rebuilds the claim table: rows, receipts, decisions and FTS all survive', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'claim-v10-')), 'context.db');
  buildV9Db(path);
  const db = openDb(path);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 11);
  // The pre-migration claim, receipt and decision, ids preserved.
  const old = { ...db.prepare('SELECT id, subject, subject_person_key, text FROM claim WHERE id = 7').get() };
  assert.deepEqual(old, { id: 7, subject: 'owner', subject_person_key: null, text: 'the owner prefers fridays' });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM claim_source WHERE claim_id = 7').get().n), 1,
    'the cascade the drop could have fired must NOT have emptied the receipts');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM claim_decision WHERE claim_id = 7').get().n), 1);
  // FTS still finds the old row, and the recreated trigger indexes new ones.
  const hit = (q) => Number(db.prepare('SELECT COUNT(*) AS n FROM claim_fts WHERE claim_fts MATCH ?').get(q).n);
  assert.equal(hit('fridays'), 1);
  const id = seedRow(db, 'lunch again');
  applyMemoryBatch(db, { run: RUN, claims: [{ kind: 'fact', text: 'jane likes ramen',
    subject: 'person', subject_person_key: 'name:jane doe',
    source: { context_id: id, quote: 'lunch' } }] });
  assert.equal(hit('ramen'), 1, 'claim_ai was recreated by the migration, not left for the next open');
  // The append-only guards were recreated in the SAME open, not left for the
  // next one: the first UPDATE after the rebuild must still bounce.
  assert.throws(() => db.prepare("UPDATE claim SET text = 'edited' WHERE id = 7").run(), /append-only/);
  // And the widened CHECK actually took.
  assert.throws(() => db.prepare(
    "INSERT INTO claim(run_id, subject, kind, text, created_at) VALUES (1, 'person', 'fact', 'x', 1)"
  ).run(), /CHECK/);
});

test('a pre-v9 database (no valid_to) migrates without bricking -- the v0.1.0 case', () => {
  // v0.1.0 shipped at SCHEMA_VERSION 6: claim table with the old CHECK and
  // no valid_to column. The rebuild runs before the v9 branch, so it must
  // supply the column itself or every open fails forever.
  const path = join(mkdtempSync(join(tmpdir(), 'claim-v10-')), 'context.db');
  buildV9Db(path);
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('ALTER TABLE claim DROP COLUMN valid_to');
  raw.exec('PRAGMA user_version = 6');
  raw.close();
  const db = openDb(path);
  assert.equal(db.prepare('SELECT text FROM claim WHERE id = 7').get().text, 'the owner prefers fridays');
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('claim') WHERE name='subject_person_key'").get().n), 1);
});

test('a mis-stamped database heals: v10 stamp, v9 table -- the production incident', () => {
  // The exact state found on the reference install 2026-08-29: something
  // stamped user_version 10 without rebuilding, and a stamp-trusting migrate
  // would skip the rebuild forever. The healer keys on the DDL instead.
  const path = join(mkdtempSync(join(tmpdir(), 'claim-v10-')), 'context.db');
  buildV9Db(path);
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 10');
  raw.close();
  const db = openDb(path);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('claim') WHERE name='subject_person_key'").get().n), 1,
    'the rebuild ran despite the lying stamp');
  assert.equal(db.prepare('SELECT text FROM claim WHERE id = 7').get().text, 'the owner prefers fridays');
});

test('a second open of a migrated database is a no-op, not a second rebuild', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'claim-v10-')), 'context.db');
  buildV9Db(path);
  openDb(path).close();
  const db = openDb(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM claim').get().n, 1);
});

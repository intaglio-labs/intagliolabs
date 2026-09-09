// The dev desk's /api/cards `changed` field (ui/devtools/review/serve.mjs)
// duplicates ui/server/relationship/lookup.mjs's newestWebChange query
// against its own read-only corpus handle, because the desk is a second
// process and cannot call the server's function directly. This test builds
// a minimal corpus and asserts the desk's copy of the predicate applies the
// SAME contradiction gate newestWebChange does: a pending contradiction
// (contradicts_anchor=1 or contradicts_anchor_unknown=1) is withheld, an
// accepted one is shown, and an ordinary change is shown regardless.
//
// This is the literal SQL from serve.mjs's changedClaimStmt (the /api/cards
// handler), kept in sync by hand -- if that predicate changes, this test's
// copy must change with it, same as any other "mirrors X exactly" duplicate
// this codebase already carries (see lookup.mjs's own comment on the
// original bug, lookup_log 4520 / "name:nikzad khani").
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE claim(id INTEGER PRIMARY KEY, subject TEXT, subject_person_key TEXT, text TEXT);
    CREATE TABLE claim_decision(id INTEGER PRIMARY KEY, claim_id INTEGER, action TEXT);
    CREATE TABLE claim_source(claim_id INTEGER, source TEXT, context_id INTEGER, quote TEXT);
    CREATE TABLE context(id INTEGER PRIMARY KEY);
    CREATE TABLE lookup_log(id INTEGER PRIMARY KEY, at INTEGER);
    CREATE TABLE person_lookup_change(
      claim_id INTEGER PRIMARY KEY, log_id INTEGER, kind TEXT, url TEXT, change_date TEXT,
      contradicts_anchor INTEGER, contradicts_anchor_unknown INTEGER
    );
  `);
  return db;
}

// Copied verbatim (predicate only) from serve.mjs's changedClaimStmt.
const CHANGED_CLAIM_SQL = `
  SELECT plc.claim_id AS claimId
  FROM person_lookup_change plc
  JOIN claim c ON c.id = plc.claim_id
  JOIN lookup_log ll ON ll.id = plc.log_id
  WHERE c.subject = 'person' AND c.subject_person_key = ?
    AND COALESCE(
      (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1),
      'pending'
    ) NOT IN ('reject', 'retract')
    AND (
      (COALESCE(plc.contradicts_anchor, 1) = 0 AND COALESCE(plc.contradicts_anchor_unknown, 1) = 0)
      OR (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1) = 'accept'
    )
  ORDER BY plc.claim_id DESC LIMIT 1`;

function seedClaim(db, { id, personKey = 'name:nikzad khani', contradictsAnchor = 0, contradictsAnchorUnknown = 0, decision = null }) {
  db.prepare(`INSERT INTO claim(id, subject, subject_person_key, text) VALUES (?, 'person', ?, 'x')`).run(id, personKey);
  db.prepare(`INSERT INTO lookup_log(id, at) VALUES (?, 0)`).run(id);
  db.prepare(
    `INSERT INTO person_lookup_change(claim_id, log_id, kind, url, contradicts_anchor, contradicts_anchor_unknown)
     VALUES (?, ?, 'move', 'https://x', ?, ?)`
  ).run(id, id, contradictsAnchor, contradictsAnchorUnknown);
  if (decision) db.prepare(`INSERT INTO claim_decision(claim_id, action) VALUES (?, ?)`).run(id, decision);
}

test('a pending contradiction is withheld from the desk\'s changed field, same as newestWebChange', () => {
  const db = freshDb();
  seedClaim(db, { id: 5031, contradictsAnchor: 1, decision: null });
  const row = db.prepare(CHANGED_CLAIM_SQL).get('name:nikzad khani');
  assert.equal(row, undefined);
});

test('a pending contradicts_anchor_unknown row is withheld too', () => {
  const db = freshDb();
  seedClaim(db, { id: 42, contradictsAnchorUnknown: 1, decision: null });
  const row = db.prepare(CHANGED_CLAIM_SQL).get('name:nikzad khani');
  assert.equal(row, undefined);
});

test('an accepted contradiction is shown -- it is the owner\'s word once accepted', () => {
  const db = freshDb();
  seedClaim(db, { id: 43, contradictsAnchor: 1, decision: 'accept' });
  const row = db.prepare(CHANGED_CLAIM_SQL).get('name:nikzad khani');
  assert.equal(row?.claimId, 43);
});

test('an ordinary (non-contradicting) pending change is shown', () => {
  const db = freshDb();
  seedClaim(db, { id: 44, contradictsAnchor: 0, contradictsAnchorUnknown: 0, decision: null });
  const row = db.prepare(CHANGED_CLAIM_SQL).get('name:nikzad khani');
  assert.equal(row?.claimId, 44);
});

test('a rejected contradiction is withheld, rejected or not -- reject/retract always excludes', () => {
  const db = freshDb();
  seedClaim(db, { id: 45, contradictsAnchor: 1, decision: 'reject' });
  const row = db.prepare(CHANGED_CLAIM_SQL).get('name:nikzad khani');
  assert.equal(row, undefined);
});

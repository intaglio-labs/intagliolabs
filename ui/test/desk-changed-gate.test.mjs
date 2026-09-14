// The dev desk's /api/cards `changed` field (ui/devtools/review/serve.mjs)
// duplicates ui/server/relationship/lookup.mjs's newestWebChange query
// against its own read-only corpus handle, because the desk is a second
// process and cannot call the server's function directly. This test builds
// a minimal corpus and asserts the desk's copy applies the SAME gate
// newestWebChange does.
//
// THE GATE IS NOW IN TWO PARTS, and only the first is SQL:
//
//   1. THE ANCHOR/DECISION PREDICATE, still SQL, still copied here verbatim
//      from serve.mjs's changedClaimStmt: a pending contradiction
//      (contradicts_anchor=1 or contradicts_anchor_unknown=1) is withheld,
//      an accepted one is shown, reject/retract always excludes. What
//      changed is `LIMIT 1` becoming `LIMIT 20` -- the query now selects
//      CANDIDATES and the caller walks them, because an uncorroborated
//      change arriving today must not hide a corroborated one from last
//      month.
//   2. THE CORROBORATION BAR, which is JS and is NOT mirrored: this test
//      imports the real webChangeServable, exactly as serve.mjs does. The
//      anchor gate was hand-mirrored once and drifted; corroboration is a
//      harder rule than that one was, so there is deliberately only one
//      implementation of it in the repo and every reader calls it.
//
// (See lookup.mjs's own comment on the original bug, lookup_log 4520 /
// "name:nikzad khani", and its corroboration section for why one search
// result stopped being enough.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { webChangeServable, parseLookupSources } from '../server/relationship/lookup.mjs';

const PROFILE = 'https://www.linkedin.com/in/nikzadkhani/';

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
      contradicts_anchor INTEGER, contradicts_anchor_unknown INTEGER,
      sources TEXT, corroboration INTEGER
    );
  `);
  return db;
}

// Copied verbatim (predicate and columns) from serve.mjs's changedClaimStmt.
const CHANGED_CLAIM_SQL = `
  SELECT plc.claim_id AS claimId, plc.change_date AS date,
         plc.contradicts_anchor AS contradictsAnchor,
         plc.contradicts_anchor_unknown AS contradictsAnchorUnknown,
         plc.sources AS sourcesJson, plc.corroboration AS corroboration,
         (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1) AS decision
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
  ORDER BY plc.claim_id DESC LIMIT 20`;

// The desk's whole gate: the SQL candidates, then the walk with the real
// servability function. Returns the claimId the desk would show, or null.
function deskChanged(db, personKey, { profileUrl = null } = {}) {
  for (const row of db.prepare(CHANGED_CLAIM_SQL).all(personKey)) {
    const servable = webChangeServable({
      corroboration: row.corroboration,
      sources: parseLookupSources(row.sourcesJson),
      date: row.date,
      contradictsAnchor: row.contradictsAnchor,
      contradictsAnchorUnknown: row.contradictsAnchorUnknown,
      decision: row.decision ?? null,
    }, { profileUrl });
    if (servable) return row.claimId;
  }
  return null;
}

// Two independent domains -- the ordinary shape of a servable change.
const TWO_DOMAINS = [
  { url: 'https://acme.example/news', quote: 'a', evidenceKind: 'snippet' },
  { url: 'https://techpress.example/x', quote: 'b', evidenceKind: 'snippet' },
];

function seedClaim(db, {
  id, personKey = 'name:nikzad khani', contradictsAnchor = 0, contradictsAnchorUnknown = 0,
  decision = null, sources = TWO_DOMAINS, corroboration = 2, date = null,
}) {
  db.prepare(`INSERT INTO claim(id, subject, subject_person_key, text) VALUES (?, 'person', ?, 'x')`).run(id, personKey);
  db.prepare(`INSERT INTO lookup_log(id, at) VALUES (?, 0)`).run(id);
  db.prepare(
    `INSERT INTO person_lookup_change(claim_id, log_id, kind, url, change_date,
       contradicts_anchor, contradicts_anchor_unknown, sources, corroboration)
     VALUES (?, ?, 'move', 'https://x', ?, ?, ?, ?, ?)`
  ).run(id, id, date, contradictsAnchor, contradictsAnchorUnknown,
    sources === null ? null : JSON.stringify(sources), corroboration);
  if (decision) db.prepare(`INSERT INTO claim_decision(claim_id, action) VALUES (?, ?)`).run(id, decision);
}

test('a pending contradiction is withheld from the desk\'s changed field, same as newestWebChange', () => {
  const db = freshDb();
  seedClaim(db, { id: 5031, contradictsAnchor: 1, decision: null });
  assert.equal(deskChanged(db, 'name:nikzad khani'), null);
});

test('a pending contradicts_anchor_unknown row is withheld too', () => {
  const db = freshDb();
  seedClaim(db, { id: 42, contradictsAnchorUnknown: 1, decision: null });
  assert.equal(deskChanged(db, 'name:nikzad khani'), null);
});

test('an accepted contradiction is shown -- it is the owner\'s word once accepted', () => {
  const db = freshDb();
  seedClaim(db, { id: 43, contradictsAnchor: 1, decision: 'accept' });
  assert.equal(deskChanged(db, 'name:nikzad khani'), 43);
});

test('an ordinary, CORROBORATED pending change is shown', () => {
  const db = freshDb();
  seedClaim(db, { id: 44, contradictsAnchor: 0, contradictsAnchorUnknown: 0, decision: null });
  assert.equal(deskChanged(db, 'name:nikzad khani'), 44);
});

test('a rejected contradiction is withheld, rejected or not -- reject/retract always excludes', () => {
  const db = freshDb();
  seedClaim(db, { id: 45, contradictsAnchor: 1, decision: 'reject' });
  assert.equal(deskChanged(db, 'name:nikzad khani'), null);
});

// --- the corroboration half, which the SQL cannot express -----------------

test('an uncorroborated pending change is withheld from the desk too', () => {
  const db = freshDb();
  // Clean anchor, clean decision, one domain. This passes the SQL predicate
  // and must still not become a card.
  seedClaim(db, {
    id: 46, corroboration: 1,
    sources: [{ url: 'https://acme.example/news', quote: 'a', evidenceKind: 'snippet' }],
  });
  assert.equal(deskChanged(db, 'name:nikzad khani'), null);
});

test('a pre-corroboration row (NULL count) is withheld from the desk', () => {
  const db = freshDb();
  seedClaim(db, { id: 47, corroboration: null, sources: null });
  assert.equal(deskChanged(db, 'name:nikzad khani'), null, 'nobody counted, so nothing may claim a count');
  // An accept still shows it -- the owner's word beats our count, here as in
  // newestWebChange.
  db.prepare(`INSERT INTO claim_decision(claim_id, action) VALUES (47, 'accept')`).run();
  assert.equal(deskChanged(db, 'name:nikzad khani'), 47);
});

test('the anchored profile with a date stands alone on the desk, without one it does not', () => {
  const db = freshDb();
  const sources = [{ url: PROFILE, quote: 'a', evidenceKind: 'title' }];
  seedClaim(db, { id: 48, corroboration: 1, sources, date: '2026-04' });
  assert.equal(deskChanged(db, 'name:nikzad khani', { profileUrl: PROFILE }), 48);
  // The same row, with no anchor for it to be the anchor of.
  assert.equal(deskChanged(db, 'name:nikzad khani', { profileUrl: null }), null);

  const undated = freshDb();
  seedClaim(undated, { id: 49, corroboration: 1, sources, date: null });
  assert.equal(deskChanged(undated, 'name:nikzad khani', { profileUrl: PROFILE }), null);
});

test('the desk WALKS: an uncorroborated newer row does not hide a corroborated older one', () => {
  const db = freshDb();
  seedClaim(db, { id: 50, corroboration: 2 });
  seedClaim(db, {
    id: 51, corroboration: 1,
    sources: [{ url: 'https://rumor.example/x', quote: 'r', evidenceKind: 'snippet' }],
  });
  // ORDER BY claim_id DESC puts 51 first; the walk keeps going.
  assert.equal(deskChanged(db, 'name:nikzad khani'), 50);
});

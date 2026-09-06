// The eligibility + ranking producer (producer.mjs): no model, one SQL
// statement's worth of gates plus a small JS ranking pass. These tests build
// a fixture directly on hermes' own schema (openDb(':memory:')) so every
// gate is exercised against the real tables the projection writes --
// people, person_active_days, person_identifiers, person_event_links,
// rm_suppression, rm_mute -- rather than a shape that merely looks like them.
//
// Each gate test is written so that removing the corresponding guard in
// producer.mjs turns its assertion from a pass into a failure -- not just an
// absence the test never checks:
//   - the cc-only person is asserted ABSENT and would appear if the
//     `authored` gate were dropped (their sent/received alone clear the
//     two-way-history gate).
//   - the romantic person is asserted ABSENT from 'any' mode and would
//     appear if the role exclusion were removed.
//   - the investor/founder people are asserted PRESENT in their own mode and
//     ABSENT from the other, so swapping or dropping the sub_roles check
//     fails in both directions.
//   - the future-meeting person is asserted ABSENT and would appear if the
//     veto join were removed (every other gate they clear cleanly).
//   - the quiet<180 person is asserted ABSENT and would appear if the
//     interval check were dropped or read the wrong clock.
//   - the ordering test asserts an exact array; swapping the sort's compare
//     order (or dropping any term of it) changes that array.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, openDb } from '../server/hermes.mjs';
import { eligiblePool, produceBatch, PRODUCER_VERSION, RANK_STRATEGY } from '../server/relationship/producer.mjs';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const day = (offsetDays) => new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);

function ensureSubRoles(db) {
  try { db.exec('ALTER TABLE people ADD COLUMN sub_roles TEXT'); } catch {}
}

function insertPerson(db, { key, name, role = 'friend', subRoles = null, sent, received, met = 0 }) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, NOW - 400 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY,
    sent, received, met, 0, sent + received, 0, role, '{}', null, NOW,
    JSON.stringify(subRoles ?? []));
}

function insertActiveDay(db, key, activeDay) {
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, activeDay);
}

// A message row this person actually authored (role 'counterparty', the
// direct-channel shape): the strongest "wrote to you" signal the projection
// persists, distinct from being merely cc'd or attending.
function insertAuthored(db, key, { ts = NOW - 200 * DAY, room = 0 } = {}) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', 'hi', '{}')"
  ).run(ts).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, ?, 1, 'conv')`
  ).run(key, ctxId, room ? 1 : 0);
}

// A cc row: present in the projection, never authored. Mirrors what an
// owner-cc'd or cc'd-by-someone-else mail participant actually gets.
function insertCcOnly(db, key) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'mail', 'fyi', '{}')"
  ).run(NOW - 200 * DAY).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'mail', 'cc', 0, 0, 0, 1, 'conv')`
  ).run(key, ctxId);
}

function insertFutureMeeting(db, key, email) {
  db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'calendar', 'future sync', ?)"
  ).run(NOW + 7 * DAY, JSON.stringify({ attendees: [{ email }] }));
  db.prepare('INSERT INTO person_identifiers(identifier, person_key) VALUES (?, ?)').run(email.toLowerCase(), key);
}

function buildFixture() {
  const db = openDb(':memory:');
  ensureSubRoles(db);

  // -- investor / founder mode gate ---------------------------------------
  insertPerson(db, { key: 'name:isabel investor', name: 'Isabel Investor', subRoles: ['investor'], sent: 20, received: 15 });
  insertAuthored(db, 'name:isabel investor');
  insertActiveDay(db, 'name:isabel investor', day(200));

  insertPerson(db, { key: 'name:frank founder', name: 'Frank Founder', subRoles: ['founder'], sent: 10, received: 10 });
  insertAuthored(db, 'name:frank founder');
  insertActiveDay(db, 'name:frank founder', day(190));

  // -- cc-only: two-way by raw counts, never authored ----------------------
  insertPerson(db, { key: 'name:carla ccperson', name: 'Carla CcPerson', sent: 5, received: 5 });
  insertCcOnly(db, 'name:carla ccperson');
  insertActiveDay(db, 'name:carla ccperson', day(200));

  // -- romantic: excluded only in 'any' mode -------------------------------
  insertPerson(db, { key: 'name:rita romantic', name: 'Rita Romantic', role: 'romantic', sent: 20, received: 20 });
  insertAuthored(db, 'name:rita romantic');
  insertActiveDay(db, 'name:rita romantic', day(200));

  // -- future meeting veto --------------------------------------------------
  insertPerson(db, { key: 'name:felix future', name: 'Felix Future', sent: 15, received: 15 });
  insertAuthored(db, 'name:felix future');
  insertActiveDay(db, 'name:felix future', day(200));
  insertFutureMeeting(db, 'name:felix future', 'felix@example.com');

  // -- quiet < 180 days -----------------------------------------------------
  insertPerson(db, { key: 'name:gina quiet', name: 'Gina Quiet', sent: 15, received: 15 });
  insertAuthored(db, 'name:gina quiet');
  insertActiveDay(db, 'name:gina quiet', day(10));

  // -- ordering: depth desc, then quiet desc --------------------------------
  insertPerson(db, { key: 'name:ord high', name: 'Ord High', sent: 30, received: 30, met: 0 }); // depth 60
  insertAuthored(db, 'name:ord high');
  insertActiveDay(db, 'name:ord high', day(300));

  insertPerson(db, { key: 'name:ord tie a', name: 'Ord TieA', sent: 10, received: 10, met: 10 }); // depth 50
  insertAuthored(db, 'name:ord tie a');
  insertActiveDay(db, 'name:ord tie a', day(250));

  insertPerson(db, { key: 'name:ord tie b', name: 'Ord TieB', sent: 25, received: 25, met: 0 }); // depth 50, lower quiet
  insertAuthored(db, 'name:ord tie b');
  insertActiveDay(db, 'name:ord tie b', day(190));

  insertPerson(db, { key: 'name:ord low', name: 'Ord Low', sent: 10, received: 10, met: 0 }); // depth 20
  insertAuthored(db, 'name:ord low');
  insertActiveDay(db, 'name:ord low', day(200));

  // -- suppressed / muted, for completeness against the anti-joins ---------
  insertPerson(db, { key: 'name:sam suppressed', name: 'Sam Suppressed', sent: 20, received: 20 });
  insertAuthored(db, 'name:sam suppressed');
  insertActiveDay(db, 'name:sam suppressed', day(200));
  db.prepare('INSERT INTO rm_suppression(person_key, created_at) VALUES (?, ?)').run('name:sam suppressed', NOW);

  insertPerson(db, { key: 'name:mia muted', name: 'Mia Muted', sent: 20, received: 20 });
  insertAuthored(db, 'name:mia muted');
  insertActiveDay(db, 'name:mia muted', day(200));
  db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, ?, ?, ?)')
    .run('name:mia muted', 'reconnect', NOW + 10 * DAY, NOW);

  return db;
}

function keysOf(pool) { return pool.map((p) => p.personKey); }

test('two-way-plus-authored people clear the pool; cc-only, romantic-in-any, future-meeting, and quiet<180 do not', () => {
  const db = buildFixture();
  const pool = eligiblePool(db, { mode: 'any', now: NOW });
  const keys = keysOf(pool);

  assert.ok(keys.includes('name:isabel investor'));
  assert.ok(keys.includes('name:frank founder'));
  assert.ok(!keys.includes('name:carla ccperson'), 'cc-only, never authored: excluded');
  assert.ok(!keys.includes('name:rita romantic'), 'romantic relationship: excluded from any mode');
  assert.ok(!keys.includes('name:felix future'), 'a future meeting vetoes the card');
  assert.ok(!keys.includes('name:gina quiet'), 'quiet 10 days is nowhere near the 180-day gate');
  assert.ok(!keys.includes('name:sam suppressed'), 'suppression removes the person entirely');
  assert.ok(!keys.includes('name:mia muted'), 'an active mute removes the person entirely');
});

test('mode=investor requires the investor sub_role; mode=founder requires founder', () => {
  const db = buildFixture();
  const investors = keysOf(eligiblePool(db, { mode: 'investor', now: NOW }));
  const founders = keysOf(eligiblePool(db, { mode: 'founder', now: NOW }));

  assert.ok(investors.includes('name:isabel investor'));
  assert.ok(!investors.includes('name:frank founder'), 'founder-tagged person excluded from investor mode');
  assert.ok(founders.includes('name:frank founder'));
  assert.ok(!founders.includes('name:isabel investor'), 'investor-tagged person excluded from founder mode');
});

test('mode=any admits the romantic-free pool; romantic is admitted under no mode', () => {
  const db = buildFixture();
  for (const mode of ['any', 'investor', 'founder']) {
    const keys = keysOf(eligiblePool(db, { mode, now: NOW }));
    assert.ok(!keys.includes('name:rita romantic'), `romantic excluded under mode=${mode}`);
  }
});

test('ranking: depth desc, then change (reserved, always 0), then quiet days desc', () => {
  const db = buildFixture();
  const pool = eligiblePool(db, { mode: 'any', now: NOW });
  const ordKeys = pool.map((p) => p.personKey).filter((k) => k.startsWith('name:ord '));
  assert.deepEqual(ordKeys, ['name:ord high', 'name:ord tie a', 'name:ord tie b', 'name:ord low'],
    'ord high (depth 60) > tie a (depth 50, quiet 250) > tie b (depth 50, quiet 190) > low (depth 20)');

  const high = pool.find((p) => p.personKey === 'name:ord high');
  assert.equal(high.depth, 60, 'depth = sent + received + 3*meetings');
  const tieA = pool.find((p) => p.personKey === 'name:ord tie a');
  assert.equal(tieA.depth, 50, '10 + 10 + 3*10');
  assert.equal(tieA.meetings, 10);
});

test('produceBatch writes a batch + snapshot in the shape hydrateCards reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-producer-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 10, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'founder' },
    peopleProjectionAutoRebuild: false, // the fixture writes `people` directly; no rebuild may overwrite it
  });
  try {
    const db = server.db;
    ensureSubRoles(db);
    insertPerson(db, { key: 'name:frank founder', name: 'Frank Founder', subRoles: ['founder'], sent: 10, received: 10 });
    insertAuthored(db, 'name:frank founder', { ts: NOW - 200 * DAY });
    insertActiveDay(db, 'name:frank founder', day(190));

    const base = `http://127.0.0.1:${server.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'e'.repeat(64)}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const refreshOut = await (await call('POST', '/admin/relationship/refresh')).json();
    assert.equal(refreshOut.started, true);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n), 1);
    const snap = db.prepare('SELECT * FROM rm_candidate_snapshot').get();
    assert.equal(snap.person_key, 'name:frank founder');
    assert.equal(snap.producer_version, PRODUCER_VERSION);
    assert.equal(snap.rank_strategy, RANK_STRATEGY);
    const evidence = JSON.parse(snap.evidence);
    assert.equal(evidence.mode, 'founder');
    assert.ok(Array.isArray(evidence.subRoles) && evidence.subRoles.includes('founder'));

    const cardOut = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(cardOut.card.name, 'Frank Founder');
    assert.ok(cardOut.card.sentence.includes('founder'));
    assert.equal(cardOut.card.producer_version, PRODUCER_VERSION);
  } finally {
    await server.close();
  }
});

test('GET /admin/relationship/pool serves the ranked pool without writing a snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-producer-pool-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 10, windowMs: 86_400_000 },
    peopleProjectionAutoRebuild: false,
  });
  try {
    const db = server.db;
    ensureSubRoles(db);
    insertPerson(db, { key: 'name:isabel investor', name: 'Isabel Investor', subRoles: ['investor'], sent: 20, received: 15 });
    insertAuthored(db, 'name:isabel investor');
    insertActiveDay(db, 'name:isabel investor', day(200));

    const base = `http://127.0.0.1:${server.port}`;
    const call = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${'e'.repeat(64)}` } });

    const out = await (await call('/admin/relationship/pool?mode=investor')).json();
    assert.equal(out.mode, 'investor');
    assert.equal(out.count, 1);
    assert.equal(out.rows[0].personKey, 'name:isabel investor');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n), 0,
      'the pool inspection route writes nothing');

    const bad = await call('/admin/relationship/pool?mode=nonsense');
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});

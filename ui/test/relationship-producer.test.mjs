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
import { mkdtempSync, rmSync } from 'node:fs';
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

// isAnonymousContact (people/map.mjs) is reused directly rather than
// re-derived, so the pool's anonymity gate matches map.mjs's own definition
// of "renders as a bare address" byte for byte -- a nameless `id:+1...`
// phone-number key is the exact repro that motivated the gate. Mutation
// check: dropping the `isAnonymousContact` call in producer.mjs's
// eligiblePool loop admits this person into the default-mode pool.
test('an anonymous (nameless) person is excluded from the pool by default, and included with includeAnonymous', () => {
  const db = buildFixture();
  insertPerson(db, { key: 'id:+15555550100', name: '', sent: 30, received: 30 });
  insertAuthored(db, 'id:+15555550100');
  insertActiveDay(db, 'id:+15555550100', day(200));

  const pool = keysOf(eligiblePool(db, { mode: 'any', now: NOW }));
  assert.ok(!pool.includes('id:+15555550100'), 'a bare phone-number person with no display name is excluded by default');

  const widened = keysOf(eligiblePool(db, { mode: 'any', now: NOW, includeAnonymous: true }));
  assert.ok(widened.includes('id:+15555550100'), 'includeAnonymous:true admits them');
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

test('GET /admin/relationship/pool excludes an anonymous contact by default; ?includeAnonymous=1 is desk-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-producer-anon-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 10, windowMs: 86_400_000 },
    peopleProjectionAutoRebuild: false,
  });
  try {
    const db = server.db;
    ensureSubRoles(db);
    insertPerson(db, { key: 'id:+15555550100', name: '', sent: 30, received: 30 });
    insertAuthored(db, 'id:+15555550100');
    insertActiveDay(db, 'id:+15555550100', day(200));

    const base = `http://127.0.0.1:${server.port}`;
    const call = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${'e'.repeat(64)}` } });

    const withoutFlag = await (await call('/admin/relationship/pool?mode=any')).json();
    assert.ok(!withoutFlag.rows.some((r) => r.personKey === 'id:+15555550100'),
      'the anonymous person is excluded from the ordinary pool view');

    const withFlag = await (await call('/admin/relationship/pool?mode=any&includeAnonymous=1')).json();
    assert.ok(withFlag.rows.some((r) => r.personKey === 'id:+15555550100'),
      '?includeAnonymous=1 (the desk-only override) admits them');
  } finally {
    await server.close();
  }
});

// A shared six-person, strictly-ranked fixture for the batch-depth and
// refill tests below: depth (sent+received, met=0) decreases monotonically
// across `${prefix} one`..`${prefix} six`, so "the top 5" and "the one left
// over" are each a single, unambiguous person key.
function insertRankedPeople(db, prefix) {
  const labels = ['one', 'two', 'three', 'four', 'five', 'six'];
  const counts = [100, 90, 80, 70, 60, 50];
  return labels.map((label, i) => {
    const key = `name:${prefix} ${label}`;
    insertPerson(db, { key, name: `${prefix} ${label}`, sent: counts[i], received: counts[i] });
    insertAuthored(db, key);
    insertActiveDay(db, key, day(200));
    return key;
  });
}

test('produceBatch writes a batch of 5 (the default depth) in rank order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-producer-depth-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 20, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  });
  try {
    const db = server.db;
    ensureSubRoles(db);
    const keys = insertRankedPeople(db, 'depth');

    const base = `http://127.0.0.1:${server.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'e'.repeat(64)}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const refreshOut = await (await call('POST', '/admin/relationship/refresh')).json();
    assert.equal(refreshOut.started, true);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n), 1);
    const batch = db.prepare('SELECT id, candidate_count FROM rm_candidate_batch ORDER BY id DESC LIMIT 1').get();
    assert.equal(batch.candidate_count, 5, 'default batch depth is 5, not the old 1');
    const snapshotKeys = db.prepare(
      'SELECT person_key FROM rm_candidate_snapshot WHERE batch_id = ? ORDER BY id'
    ).all(batch.id).map((r) => r.person_key);
    assert.deepEqual(snapshotKeys, keys.slice(0, 5),
      'the top 5 by depth, written in rank order; the sixth (lowest depth) is dropped by the cap');
  } finally {
    await server.close();
  }
});

test('GET /admin/relationship/card refills an exhausted queue, and never re-offers a judged person', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-producer-refill-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 20, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  });
  try {
    const db = server.db;
    ensureSubRoles(db);
    const keys = insertRankedPeople(db, 'refill');
    const leftover = keys[5]; // rank six: never in the first batch of 5

    // A person judged in the DISTANT past (dismissed 30 days ago, off a
    // snapshot also 30 days old) -- outside the 7-day recently-snapshotted
    // window, so only the separate "already judged" gate keeps them off the
    // pool. Given the top rank (depth 999), they would otherwise be the very
    // first card in the batch below: this is what makes dropping the
    // judged-exclusion (as opposed to the recently-snapshotted one) its own,
    // distinguishable failure.
    const oldJudgedKey = 'name:refill judged long ago';
    insertPerson(db, { key: oldJudgedKey, name: 'Judged Long Ago', sent: 500, received: 499 });
    insertAuthored(db, oldJudgedKey);
    insertActiveDay(db, oldJudgedKey, day(200));
    const oldBatchId = Number(db.prepare(
      'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, ?)'
    ).run(NOW - 30 * DAY, 1, 'open', null).lastInsertRowid);
    const oldSnapshotId = Number(db.prepare(
      'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(oldBatchId, oldJudgedKey, 'reconnect', 'old summary', '{}', PRODUCER_VERSION, RANK_STRATEGY, NOW - 30 * DAY).lastInsertRowid);
    db.prepare(
      'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(oldJudgedKey, 'reconnect', oldSnapshotId, 'dismissed', null, null, PRODUCER_VERSION, 'morning', NOW - 30 * DAY);

    const base = `http://127.0.0.1:${server.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'e'.repeat(64)}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const refreshOut = await (await call('POST', '/admin/relationship/refresh')).json();
    assert.equal(refreshOut.started, true);
    const firstBatchKeys = db.prepare(
      'SELECT person_key FROM rm_candidate_snapshot WHERE batch_id = (SELECT MAX(id) FROM rm_candidate_batch) ORDER BY id'
    ).all().map((r) => r.person_key);
    assert.ok(!firstBatchKeys.includes(oldJudgedKey),
      'a person judged 30 days ago is excluded even though their own snapshot is well outside the 7-day window -- ' +
      'this is the "already judged" gate specifically, not the "recently snapshotted" one');

    // Judge (dismiss) every card the first batch produced -- the top 5 of 6.
    const judged = new Set();
    for (let i = 0; i < 5; i++) {
      const out = await (await call('GET', '/admin/relationship/card')).json();
      assert.ok(out.card, `card ${i + 1} of 5`);
      assert.ok(!judged.has(out.card.personKey), 'never the same person twice within the first batch');
      judged.add(out.card.personKey);
      const ev = await call('POST', '/admin/relationship/event', {
        snapshot_id: out.card.snapshot_id, person_key: out.card.personKey, event: 'dismissed',
      });
      assert.equal(ev.status, 200);
    }
    assert.equal(judged.size, 5);
    assert.ok(!judged.has(leftover), 'rank six was never in the first batch');

    // Every card in the queue is now judged: the NEXT GET must refill
    // synchronously (a batch depth of 5 is exactly why a queue can now go
    // empty on one sitting) and serve rank six -- the only person left that
    // is neither judged (rm_card_event) nor recently snapshotted (within 7
    // days), both of which the other five now are.
    const refilled = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(refilled.card, 'the card route refills instead of answering null forever');
    assert.equal(refilled.card.personKey, leftover,
      'the refill serves the next-ranked person, never one already judged');
    assert.notEqual(refilled.card.personKey, oldJudgedKey, 'the long-ago-judged person stays excluded on refill too');
  } finally {
    await server.close();
  }
});

test('/people/sub-roles writes an owner override that the next projection read reflects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rel-subroles-home-'));
  const prevHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'rel-subroles-db-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    peopleProjectionAutoRebuild: false,
  });
  try {
    process.env.HOME = home;
    const base = `http://127.0.0.1:${server.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'e'.repeat(64)}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // A real, graph-derived person -- not a row poked into `people` directly
    // -- because /people/sub-roles finds its target through
    // materializedPeopleGraph, the same door /people/role uses. Three direct
    // messages clears the map's own hasRelationship floor.
    const handle = '+15555550199';
    await call('POST', '/ingest', [0, 1, 2].map((i) => ({
      ts: NOW - (200 - i) * DAY, source: 'imessage', entity_id: `imessage:subroles-${i}`,
      text: 'hello', meta: { chat_handle: handle, is_from_me: false },
    })));

    // A read BEFORE the override warms map.mjs's own yearCore memo -- the
    // scenario the ownerRoleStamp fix targets: without a sub-role term in
    // that stamp, this same memo could mask a later /people/sub-roles call
    // and rebuildPeopleCore would return the stale, pre-override core.
    const before = await (await call('GET', '/people/map')).json();
    const person = before.people.find((p) => p.key && p.key.length > 0);
    assert.ok(person, 'the ingested contact materializes as a person');
    assert.deepEqual(person.subRoles ?? [], [], 'no sub-role tag yet');

    const res = await call('POST', '/people/sub-roles', { personKey: person.key, subRoles: ['investor'] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, personKey: person.key, subRoles: ['investor'] });

    const after = await (await call('GET', '/people/map')).json();
    const updated = after.people.find((p) => p.key === person.key);
    assert.ok(updated, 'the person is still present after the override');
    assert.deepEqual(updated.subRoles, ['investor'], 'the next projection read reflects the override');

    // Validation: a value outside the closed three-role set must 400, and
    // must not have touched the config the 200 above already wrote.
    const bad = await call('POST', '/people/sub-roles', { personKey: person.key, subRoles: ['ceo'] });
    assert.equal(bad.status, 400);
    const unchanged = await (await call('GET', '/people/map')).json();
    assert.deepEqual(
      unchanged.people.find((p) => p.key === person.key).subRoles, ['investor'],
      'a rejected write leaves the prior override in place'
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    await server.close();
  }
});

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
import { OWE_PRODUCER_VERSION } from '../server/relationship/owe.mjs';

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

// The recently-offered cooldown fires off an actual 'shown' rm_card_event,
// never off a bare snapshot: a batch's five names are a queue and most are
// never served, so cooling down snapshotted-but-never-shown people would
// empty a small pool on refreshes nobody saw. Mutation check: reverting the
// gate in producer.mjs's poolSql back to reading rm_candidate_snapshot alone
// turns the first assertion below into a failure (the snapshot-only person
// would be excluded).
// ---- review finding 5: authored means authored TO YOU -------------------
// person_event_links.authored is also set on a GROUP row for whoever spoke
// in it, so somebody who has only ever talked in a thread the owner happens
// to be in used to clear the "has written to you" gate. Paired with
// met_in_person > 0 -- which counts a 200-attendee invite -- that produced a
// card for a person the owner has never exchanged a word with, with no
// quote at all (latestAuthoredContextId is room=0-only) and a tie sentence
// reading "0 messages and 1 meetings".
test('a group-thread-only speaker is not "authored to you", even with a meeting on the counter', () => {
  const db = openDb(':memory:');
  ensureSubRoles(db);

  // Their ONLY authored row is a room=1 (group) row, and their whole claim
  // on the pool is one met_in_person -- the big-invite case.
  insertPerson(db, { key: 'name:room only', name: 'Room Only', sent: 0, received: 0, met: 1 });
  insertAuthored(db, 'name:room only', { room: 1 });
  insertActiveDay(db, 'name:room only', day(200));

  // The control: identical, except the authored row is direct.
  insertPerson(db, { key: 'name:direct one', name: 'Direct One', sent: 0, received: 0, met: 1 });
  insertAuthored(db, 'name:direct one', { room: 0 });
  insertActiveDay(db, 'name:direct one', day(200));

  const keys = keysOf(eligiblePool(db, { mode: 'any', now: NOW }));
  assert.ok(!keys.includes('name:room only'),
    'speaking in a room the owner is also in is not writing to the owner');
  assert.ok(keys.includes('name:direct one'), 'the direct-row control still clears the gate');
});

// ---- review finding 11: cross-kind exclusion ----------------------------
// A person eligible for BOTH producers used to be offered twice -- an Owe
// card and a reconnect card, for the same silence -- and dismissing one kind
// gated only that kind. Whichever producer wrote them into its live queue
// first now holds them.
test('a person the Owe producer is holding in its live queue is excluded from the reconnect pool', () => {
  const db = openDb(':memory:');
  ensureSubRoles(db);
  insertPerson(db, { key: 'name:both kinds', name: 'Both Kinds', sent: 20, received: 20 });
  insertAuthored(db, 'name:both kinds', { room: 0 });
  insertActiveDay(db, 'name:both kinds', day(200));

  assert.ok(keysOf(eligiblePool(db, { mode: 'any', now: NOW })).includes('name:both kinds'),
    'sanity: reconnect wants them while nothing else has them');

  // An UNJUDGED owe snapshot in owe's latest batch -- never shown, so the
  // 7-day shown cooldown does not cover this case at all.
  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
  ).run(NOW - 1 * DAY, 'open').lastInsertRowid);
  db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    "VALUES (?, 'name:both kinds', 'owe', 'summary', '{\"mode\":null}', ?, 'owe-overdue-days', ?)"
  ).run(batchId, OWE_PRODUCER_VERSION, NOW - 1 * DAY);

  assert.ok(!keysOf(eligiblePool(db, { mode: 'any', now: NOW })).includes('name:both kinds'),
    'owe is holding them: one card at a time, per person');
  assert.ok(keysOf(eligiblePool(db, { mode: 'any', now: NOW, includeOffered: true })).includes('name:both kinds'),
    'the desk\'s pool view still shows them, like every other already-offered gate');

  // Judged: owe is done with them, so reconnect may have them.
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    "VALUES ('name:both kinds', 'owe', (SELECT MAX(id) FROM rm_candidate_snapshot), 'muted', NULL, NULL, ?, 'morning', ?)"
  ).run(OWE_PRODUCER_VERSION, NOW - 1 * DAY);
  assert.ok(keysOf(eligiblePool(db, { mode: 'any', now: NOW })).includes('name:both kinds'),
    'a consumed owe snapshot releases them');
});

test('the 7-day cooldown keys off a shown card, not a bare snapshot', () => {
  const db = buildFixture();
  const key = 'name:shown gate person';
  insertPerson(db, { key, name: 'Shown Gate Person', sent: 20, received: 20 });
  insertAuthored(db, key);
  insertActiveDay(db, key, day(200));

  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, ?)'
  ).run(NOW - 1 * DAY, 1, 'open', null).lastInsertRowid);
  const snapshotId = Number(db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(batchId, key, 'reconnect', 'summary', '{}', PRODUCER_VERSION, RANK_STRATEGY, NOW - 1 * DAY).lastInsertRowid);

  // A snapshot from 1 day ago with NO 'shown' event: still selected.
  assert.ok(keysOf(eligiblePool(db, { mode: 'any', now: NOW })).includes(key),
    'a snapshot alone, 1 day old, does not cool the person down');

  // The same person WITH a 'shown' event 1 day ago: excluded.
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(key, 'reconnect', snapshotId, 'shown', null, null, PRODUCER_VERSION, 'morning', NOW - 1 * DAY);
  assert.ok(!keysOf(eligiblePool(db, { mode: 'any', now: NOW })).includes(key),
    'a shown event 1 day ago cools the person down for 7 days');

  // A 'shown' event 30 days ago: outside the 7-day window, does not exclude.
  const key30 = 'name:shown gate person old';
  insertPerson(db, { key: key30, name: 'Shown Gate Person Old', sent: 20, received: 20 });
  insertAuthored(db, key30);
  insertActiveDay(db, key30, day(200));
  const batchId30 = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, ?)'
  ).run(NOW - 30 * DAY, 1, 'open', null).lastInsertRowid);
  const snapshotId30 = Number(db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(batchId30, key30, 'reconnect', 'summary', '{}', PRODUCER_VERSION, RANK_STRATEGY, NOW - 30 * DAY).lastInsertRowid);
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(key30, 'reconnect', snapshotId30, 'shown', null, null, PRODUCER_VERSION, 'morning', NOW - 30 * DAY);
  assert.ok(keysOf(eligiblePool(db, { mode: 'any', now: NOW })).includes(key30),
    'a shown event 30 days ago is outside the 7-day window and does not exclude');
});

// Kind-scoping (added alongside owe.mjs, the second producer): the judged
// gate must key on THIS producer's own kind, same as the mute gate already
// did. Mutation check: reverting either gate back to kind-agnostic turns one
// of the two assertions below into a failure.
test('the judged gate and the mute gate are both kind-scoped to reconnect', () => {
  const db = buildFixture();

  const dismissedOnOwe = 'name:dismissed on owe';
  insertPerson(db, { key: dismissedOnOwe, name: 'Dismissed On Owe', sent: 20, received: 20 });
  insertAuthored(db, dismissedOnOwe);
  insertActiveDay(db, dismissedOnOwe, day(200));
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(dismissedOnOwe, 'owe', null, 'dismissed', 'not-useful', null, 'owe-v1', 'morning', NOW - 1 * DAY);

  const dismissedOnReconnect = 'name:dismissed on reconnect';
  insertPerson(db, { key: dismissedOnReconnect, name: 'Dismissed On Reconnect', sent: 20, received: 20 });
  insertAuthored(db, dismissedOnReconnect);
  insertActiveDay(db, dismissedOnReconnect, day(200));
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(dismissedOnReconnect, 'reconnect', null, 'dismissed', 'not-useful', null, PRODUCER_VERSION, 'morning', NOW - 1 * DAY);

  const oweMuted = 'name:owe muted for reconnect check';
  insertPerson(db, { key: oweMuted, name: 'Owe Muted', sent: 20, received: 20 });
  insertAuthored(db, oweMuted);
  insertActiveDay(db, oweMuted, day(200));
  db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, ?, ?, ?)')
    .run(oweMuted, 'owe', NOW + 10 * DAY, NOW);

  const keys = keysOf(eligiblePool(db, { mode: 'any', now: NOW }));
  assert.ok(keys.includes(dismissedOnOwe), 'dismissed under kind=owe still reaches the reconnect pool');
  assert.ok(!keys.includes(dismissedOnReconnect), 'dismissed under kind=reconnect is excluded, as before');
  assert.ok(keys.includes(oweMuted), 'a mute scoped to kind=owe does not touch the reconnect pool');
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
    // THE MODE IS NOT A FACT ABOUT THE PERSON (surface review B finding 5).
    // The sentence used to read "Quiet 190 days · founder · ...", which on a
    // live card sat two rows above a "who they are" line saying something
    // else. The mode still travels -- on `servedMode` and in evidence, both
    // asserted above -- it just no longer poses as biography.
    assert.ok(!cardOut.card.sentence.includes('founder'), 'the owner\'s filter is not in the sentence');
    assert.equal(cardOut.servedMode, 'founder', 'the mode travels as provenance instead');
    assert.equal(cardOut.card.producer_version, PRODUCER_VERSION);
  } finally {
    await server.close();
  }
});

// Regression for the c509f3f Owe gate tightening: a batch written under an
// OLD producer_version (simulating a pre-reinstall DB still holding the
// junk card the tightened gates were meant to stop serving) must not be
// hydrated or served, and must not count as "already unjudged" either --
// the card route should refill Owe instead of waiting behind it forever.
test('hydrate skips a stale-version Owe batch and the next /card refills for owe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-owe-stale-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 10, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  });
  try {
    const db = server.db;
    // Seed exactly what hydrateCards would find on a restart against an
    // un-migrated-forward DB: one Owe batch, one snapshot, producer_version
    // a version this producer no longer runs, and no rm_card_event at all
    // (unjudged) -- the "junk card" from the bug report.
    const staleBatchId = Number(db.prepare(
      'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
    ).run(NOW, 'open').lastInsertRowid);
    db.prepare(
      'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
      "VALUES (?, 'name:stale owe', 'owe', 'stale summary', '{}', 'owe-v1', 'owe-overdue-days', ?)"
    ).run(staleBatchId, NOW);
    assert.notEqual('owe-v1', OWE_PRODUCER_VERSION, 'the seeded version really is stale relative to the live constant');

    const base = `http://127.0.0.1:${server.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'e'.repeat(64)}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const cardOut = await (await call('GET', '/admin/relationship/card')).json();
    assert.notEqual(cardOut.card?.personKey, 'name:stale owe',
      'the stale-version card is never served, no matter how the pool comes out');
    // Neither producer has any real fixture data, so both refills legitimately
    // find nothing -- the point here is that a refill was ATTEMPTED for owe
    // rather than the stale unjudged snapshot silently satisfying the queue
    // forever. Both eligibility-family producers write a batch row even on
    // zero candidates (see owe.mjs/producer.mjs), so a fresh batch per kind
    // proves the refill ran.
    assert.equal(cardOut.card, null);
    assert.equal(cardOut.reason, 'pool-exhausted');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n), 3,
      'the stale seed batch, plus one fresh (empty) refill attempt each for owe and reconnect');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_snapshot').get().n), 1,
      'the fresh refills found no candidates, so only the stale seeded snapshot still exists');
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
    // snapshot also 30 days old) -- outside the 7-day recently-shown
    // window, so only the separate "already judged" gate keeps them off the
    // pool. Given the top rank (depth 999), they would otherwise be the very
    // first card in the batch below: this is what makes dropping the
    // judged-exclusion (as opposed to the recently-shown one) its own,
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
      'this is the "already judged" gate specifically, not the "recently shown" one');

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
    // is neither judged (rm_card_event) nor recently shown (a 'shown'
    // rm_card_event within 7 days), both of which the other five now are.
    const refilled = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(refilled.card, 'the card route refills instead of answering null forever');
    assert.equal(refilled.card.personKey, leftover,
      'the refill serves the next-ranked person, never one already judged');
    assert.notEqual(refilled.card.personKey, oldJudgedKey, 'the long-ago-judged person stays excluded on refill too');
  } finally {
    await server.close();
  }
});

test('hydrateCards skips an empty latest batch and restores the last real one', async () => {
  // Reproduces the restart bug: hydrateCards used to load whatever batch row
  // was newest, even one produceBatch wrote with zero candidates (the mode's
  // pool exhausted). That silently dropped the two unjudged, already-shown
  // cards from the last REAL batch on every hermes restart, even though
  // their owner never judged them.
  const dir = mkdtempSync(join(tmpdir(), 'rel-hydrate-empty-'));
  const dbPath = join(dir, 'context.db');
  const opts = {
    port: 0, dbPath, llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 20, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  };
  const server = await start(opts);
  try {
    const db = server.db;
    ensureSubRoles(db);
    insertPerson(db, { key: 'name:real card', name: 'Real Card', sent: 50, received: 50 });
    insertAuthored(db, 'name:real card');
    insertActiveDay(db, 'name:real card', day(200));

    // A real, non-empty batch (produceBatch writes it directly -- no need to
    // go through the HTTP route for this fixture).
    const real = produceBatch(db, { mode: 'any', now: NOW });
    assert.equal(real.cards.length, 1);

    // A LATER, empty batch -- e.g. from a refill attempt against an
    // already-exhausted mode ('founder', with no founder in the fixture).
    // This is now the newest row in rm_candidate_batch.
    const empty = produceBatch(db, { mode: 'founder', now: NOW + 1000 });
    assert.equal(empty.cards.length, 0);
    const latestBatch = db.prepare('SELECT candidate_count FROM rm_candidate_batch ORDER BY id DESC LIMIT 1').get();
    assert.equal(latestBatch.candidate_count, 0, 'the empty batch really is the newest row');
  } finally {
    await server.close();
  }

  // Restart-equivalent: a fresh process (fresh in-memory holder) against the
  // same on-disk db. hydrateCards runs again, lazily, on the first request.
  const restarted = await start(opts);
  try {
    const base = `http://127.0.0.1:${restarted.port}`;
    const out = await (await fetch(base + '/admin/relationship/card', {
      headers: { Authorization: `Bearer ${'e'.repeat(64)}` },
    })).json();
    assert.ok(out.card, 'the card from the last REAL batch is served, not card:null');
    assert.equal(out.card.personKey, 'name:real card');
  } finally {
    await restarted.close();
  }
});

test('an exhausted pool does not write a batch per poll', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-refill-throttle-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 20, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  });
  try {
    const db = server.db;
    ensureSubRoles(db);
    // A small pool (2 people, both inside the default batch depth of 5) so
    // the FIRST refresh already exhausts it entirely once both are judged --
    // no lower-ranked leftover the way the depth/refill fixtures above have.
    insertPerson(db, { key: 'name:throttle one', name: 'Throttle One', sent: 40, received: 40 });
    insertAuthored(db, 'name:throttle one');
    insertActiveDay(db, 'name:throttle one', day(200));
    insertPerson(db, { key: 'name:throttle two', name: 'Throttle Two', sent: 30, received: 30 });
    insertAuthored(db, 'name:throttle two');
    insertActiveDay(db, 'name:throttle two', day(200));

    const base = `http://127.0.0.1:${server.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'e'.repeat(64)}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    await call('POST', '/admin/relationship/refresh');
    const batchesAfterRefresh = Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n);
    assert.equal(batchesAfterRefresh, 1);

    // Judge both cards so the pool is now fully exhausted.
    for (let i = 0; i < 2; i++) {
      const out = await (await call('GET', '/admin/relationship/card')).json();
      assert.ok(out.card, `card ${i + 1} of 2`);
      const ev = await call('POST', '/admin/relationship/event', {
        snapshot_id: out.card.snapshot_id, person_key: out.card.personKey, event: 'dismissed',
      });
      assert.equal(ev.status, 200);
    }

    // Five polls against the now-exhausted pool. The reconnect pool has
    // nothing left, so the FIRST poll's alternation (daily.mjs) also gives
    // Owe a turn -- its own pool is empty too (no owe fixture data here),
    // so it writes its own empty batch row exactly once, same as reconnect
    // does. Two producers, two new rows on that first poll; still not one
    // per poll thereafter -- that is the property this test protects.
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await (await call('GET', '/admin/relationship/card')).json());
    }
    for (const r of results) assert.equal(r.card, null, 'the pool really is exhausted -- no card to serve');

    const batchesAfterPolling = Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n);
    assert.equal(batchesAfterPolling, batchesAfterRefresh + 2,
      'exactly one new empty batch row per producer (owe, reconnect) across all five polls, not one per poll');

    // The first poll is the one that actually ran both producers and
    // discovered both pools empty; the later four are throttled (for BOTH
    // kinds) and never called either producer again -- that is what the
    // batch-row count above proves, and this asserts the throttled response
    // shape too.
    for (const r of results.slice(1)) {
      assert.equal(r.reason, 'pool-exhausted');
      assert.ok(Number.isFinite(r.retryAfterMs) && r.retryAfterMs > 0);
    }
  } finally {
    await server.close();
  }
});

test('an explicit refresh bypasses the refill throttle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-refresh-bypass-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: 'e'.repeat(64),
    relationshipCap: { max: 20, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  });
  try {
    const db = server.db;
    ensureSubRoles(db);
    insertPerson(db, { key: 'name:bypass one', name: 'Bypass One', sent: 40, received: 40 });
    insertAuthored(db, 'name:bypass one');
    insertActiveDay(db, 'name:bypass one', day(200));

    const base = `http://127.0.0.1:${server.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'e'.repeat(64)}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    await call('POST', '/admin/relationship/refresh');
    const out = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', {
      snapshot_id: out.card.snapshot_id, person_key: out.card.personKey, event: 'dismissed',
    });

    // Exhaust and arm the throttle (mirrors the previous test's first poll).
    const armed = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(armed.card, null);
    const throttled = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(throttled.reason, 'pool-exhausted', 'the throttle is now armed');
    const batchesBeforeRefresh = Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n);

    // An explicit refresh, called well within REFILL_RETRY_MS of the throttled
    // poll above, must still run produceBatch -- the owner asked directly.
    const refreshOut = await (await call('POST', '/admin/relationship/refresh')).json();
    assert.equal(refreshOut.started, true);
    const batchesAfterRefresh = Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n);
    assert.equal(batchesAfterRefresh, batchesBeforeRefresh + 1,
      'the explicit refresh wrote its own batch row, unthrottled');
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

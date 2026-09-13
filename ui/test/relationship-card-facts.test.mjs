// What the card reply SAYS about a person, after the owner-facing surface
// review (section C, findings 13/14/15/16). people.linkedin,
// last_from_them, last_from_owner, last_seen and the last small meeting
// were all already stored and none of them reached the card, so a fresh
// install's card showed the same two counts three times over and nothing
// about the person in front of the owner.
//
// The fixtures assert field by field on BOTH reply shapes (a peek and a
// serve): the old reply carries none of these keys, so every assertion here
// changes from a pass to a failure against it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, openDb } from '../server/hermes.mjs';
import { personCardFacts, personFacts, changedForCard } from '../server/relationship/cardFacts.mjs';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const TOKEN = 'f'.repeat(64);
const isoDay = (offsetDays) => new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);

function insertPerson(db, { key, name, role = 'friend', subRoles = [], sent, received, met = 0,
  linkedin = null, lastFromThem = NOW - 200 * DAY, lastFromOwner = NOW - 210 * DAY, lastSeen = NOW - 200 * DAY }) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, NOW - 400 * DAY, lastSeen, lastFromThem, lastFromOwner,
    sent, received, met, 0, sent + received, 0, role, '{}',
    linkedin === null ? null : JSON.stringify(linkedin), NOW, JSON.stringify(subRoles));
}

function insertAuthored(db, key, { ts, text, room = 0 } = {}) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, '{}')"
  ).run(ts, text).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, ?, 1, 'conv')`
  ).run(key, ctxId, room ? 1 : 0);
  return ctxId;
}

function insertActiveDay(db, key, day) {
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, day);
}

// A past calendar row small enough to count as the two of them in a room
// together, resolved through the same person_identifiers spine the
// future-meeting veto uses.
function insertPastMeeting(db, key, email, { daysAgo, attendees = null }) {
  db.prepare("INSERT INTO context(ts, source, text, meta) VALUES (?, 'calendar', 'coffee', ?)")
    .run(NOW - daysAgo * DAY, JSON.stringify({ attendees: attendees ?? [{ email }, { email: 'owner@example.com' }] }));
  db.prepare('INSERT OR IGNORE INTO person_identifiers(identifier, person_key) VALUES (?, ?)')
    .run(email.toLowerCase(), key);
}

// A quiet, reconnect-eligible person: two-way history past the depth floor,
// a direct authored row, and 200 days of silence.
function seedEligible(db, key, name, opts = {}) {
  insertPerson(db, { key, name, sent: 20, received: 20, ...opts });
  insertAuthored(db, key, { ts: NOW - 200 * DAY, text: opts.text ?? 'the deck is ready whenever you want to look' });
  insertActiveDay(db, key, isoDay(200));
}

function freshDb() {
  const db = openDb(':memory:');
  try { db.exec('ALTER TABLE people ADD COLUMN sub_roles TEXT'); } catch {}
  return db;
}

// --- C13/14/15: the person facts on the wire ------------------------------

const LINKEDIN = {
  position: 'Partner', company: 'Sequoia', industry: 'Venture Capital',
  connected_on: '01 Jun 2020', url: 'https://www.linkedin.com/in/partner', email: 'partner@example.com',
};

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-card-facts-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: { max: 10, windowMs: 86_400_000 },
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
    relationshipMemoryEngine: null,
    ownerConfigPath: join(dir, 'config.json'),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const get = async (path) => (await fetch(base + path, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  try {
    try { server.db.exec('ALTER TABLE people ADD COLUMN sub_roles TEXT'); } catch {}
    await fn({ get, db: server.db });
  } finally { await server.close(); }
}

test('the card reply carries who they are, who wrote last, and when they last met', async () => {
  await withServer(async ({ get, db }) => {
    const now = Date.now();
    const key = 'name:facts person';
    // Written against the CLOCK THE ROUTE USES (Date.now()), not the frozen
    // NOW above: lastMeetingDaysAgo is computed at serve time.
    db.prepare(
      `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
         sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
         linkedin, built_at, sub_roles)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(key, 'Facts Person', now - 900 * DAY, now - 200 * DAY, now - 200 * DAY, now - 230 * DAY,
      20, 20, 1, 0, 40, 0, 'friend', '{}', JSON.stringify(LINKEDIN), now, '[]');
    const ctxId = Number(db.prepare(
      "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, '{}')"
    ).run(now - 200 * DAY, 'the deck is ready whenever you want to look').lastInsertRowid);
    db.prepare(
      `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
       VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, 'conv')`
    ).run(key, ctxId);
    db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)')
      .run(key, new Date(now - 200 * DAY).toISOString().slice(0, 10));
    db.prepare("INSERT INTO context(ts, source, text, meta) VALUES (?, 'calendar', 'coffee', ?)")
      .run(now - 300 * DAY, JSON.stringify({ attendees: [{ email: 'facts@example.com' }, { email: 'owner@example.com' }] }));
    db.prepare('INSERT OR IGNORE INTO person_identifiers(identifier, person_key) VALUES (?, ?)')
      .run('facts@example.com', key);

    const peek = await get('/admin/relationship/card?peek=1');
    assert.equal(peek.card.personKey, key);
    assert.deepEqual(
      { ...peek.card.person, connectedOn: undefined },
      {
        title: 'Partner', company: 'Sequoia', industry: 'Venture Capital',
        url: 'https://www.linkedin.com/in/partner', connectedOn: undefined,
      },
      'the tease knows who they are too -- and never carries their email'
    );
    // A ms epoch like every other date on the card, not the csv's own string,
    // and asserted by the date it lands on rather than by a literal number so
    // the test does not depend on the machine's timezone.
    assert.equal(typeof peek.card.person.connectedOn, 'number');
    const connected = new Date(peek.card.person.connectedOn);
    assert.deepEqual([connected.getFullYear(), connected.getMonth(), connected.getDate()], [2020, 5, 1]);
    assert.equal(peek.card.quote, undefined, 'a peek still carries no receipt');
    assert.equal(peek.card.lastMeetingDaysAgo, 300);

    const served = await get('/admin/relationship/card');
    assert.equal(served.card.personKey, key);
    assert.deepEqual(served.card.person, peek.card.person, 'one shape, both replies');
    assert.equal(served.card.lastFromThem, now - 200 * DAY);
    assert.equal(served.card.lastFromOwner, now - 230 * DAY);
    assert.equal(served.card.lastSeen, now - 200 * DAY);
    assert.equal(served.card.lastMeetingDaysAgo, 300);
    assert.ok(served.card.lastFromThem > served.card.lastFromOwner,
      'the strongest reconnect signal: they wrote last, and the card can now say so');
  });
});

test('a person with no LinkedIn row and no meeting answers with nulls, not missing keys', async () => {
  await withServer(async ({ get, db }) => {
    const now = Date.now();
    const key = 'name:bare person';
    db.prepare(
      `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
         sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
         linkedin, built_at, sub_roles)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(key, 'Bare Person', now - 900 * DAY, now - 200 * DAY, now - 200 * DAY, null,
      20, 20, 0, 0, 40, 0, 'friend', '{}', null, now, '[]');
    const ctxId = Number(db.prepare(
      "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, '{}')"
    ).run(now - 200 * DAY, 'i am still thinking about that idea of yours').lastInsertRowid);
    db.prepare(
      `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
       VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, 'conv')`
    ).run(key, ctxId);
    db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)')
      .run(key, new Date(now - 200 * DAY).toISOString().slice(0, 10));

    const served = await get('/admin/relationship/card');
    assert.deepEqual(served.card.person,
      { title: null, company: null, industry: null, connectedOn: null, url: null });
    assert.equal(served.card.lastFromOwner, null);
    assert.equal(served.card.lastMeetingDaysAgo, null);
    assert.ok('lastMeetingDaysAgo' in served.card, 'null, never absent');
    assert.equal(served.card.changed, null);
  });
});

// --- unit cover for the two projections, away from the route --------------

test('a big invite is not a meeting: the last-meeting date uses the same gate as the veto', () => {
  const db = freshDb();
  const key = 'name:invite only';
  seedEligible(db, key, 'Invite Only');
  insertPastMeeting(db, key, 'invite@example.com', {
    daysAgo: 30,
    attendees: Array.from({ length: 40 }, (_, i) => ({ email: i === 0 ? 'invite@example.com' : `a${i}@example.com` })),
  });
  assert.equal(personCardFacts(db, key, { now: NOW }).lastMeetingDaysAgo, null,
    'a 40-person invite is not the two of you in a room');

  insertPastMeeting(db, key, 'invite@example.com', { daysAgo: 120 });
  assert.equal(personCardFacts(db, key, { now: NOW }).lastMeetingDaysAgo, 120,
    'the small one counts, even though it is older');
});

test('a declined invite is not a meeting either', () => {
  const db = freshDb();
  const key = 'name:declined';
  seedEligible(db, key, 'Declined Person');
  insertPastMeeting(db, key, 'declined@example.com', {
    daysAgo: 20,
    attendees: [{ email: 'declined@example.com', response: 'declined' }, { email: 'owner@example.com' }],
  });
  assert.equal(personCardFacts(db, key, { now: NOW }).lastMeetingDaysAgo, null);
});

test('personFacts: the csv date becomes an epoch, and anything unreadable becomes null', () => {
  const parsed = personFacts(JSON.stringify({
    position: 'Partner', company: 'Sequoia', industry: 'Venture Capital',
    connected_on: '01 Jun 2020', url: 'https://www.linkedin.com/in/partner',
    email: 'partner@example.com',
  }));
  assert.equal(typeof parsed.connectedOn, 'number');
  assert.equal(Object.hasOwn(parsed, 'email'), false, 'the card needs who they are, not how to reach them');

  // A row whose "Connected On" column the connector could not read either:
  // null, never NaN and never the raw string.
  assert.equal(personFacts(JSON.stringify({ position: 'P', connected_on: 'sometime in 2020' })).connectedOn, null);
  assert.equal(personFacts(JSON.stringify({ position: 'P' })).connectedOn, null);

  // Absent, empty, and unparseable LinkedIn all answer the same full shape.
  const empty = { title: null, company: null, industry: null, connectedOn: null, url: null };
  assert.deepEqual(personFacts(null), empty);
  assert.deepEqual(personFacts(''), empty);
  assert.deepEqual(personFacts('{not json'), empty);
  assert.deepEqual(personFacts(JSON.stringify({ position: '   ' })), empty, 'a blank column is not a title');
});

test('changedForCard counts its sources and drops a change with nothing to say', () => {
  assert.equal(changedForCard(null), null);
  assert.equal(changedForCard({ text: '   ', sources: [{ url: 'https://a.example' }] }), null);
  const out = changedForCard({
    text: 'Moved to Anthropic in March.', at: 1_700_000_000_000, date: '2026-03',
    sources: [{ url: 'https://a.example' }, { url: 'https://b.example' }], corroboration: 2,
  });
  assert.equal(out.sources, 2, 'a count, which is what the card renders');
  assert.equal(out.at, 1_700_000_000_000);
  assert.deepEqual(out.sourceUrls, ['https://a.example', 'https://b.example']);
});

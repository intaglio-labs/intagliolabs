// Hermes-owned materialized people identity.
//
// `context` remains the evidence ledger. These tables are a rebuildable local
// projection: one canonical person, their identifiers, why each identifier was
// connected, and prepared activity totals. Hermes is the only writer, so the
// projection changes in the same process that owns the corpus.

import { createHash } from 'node:crypto';
import {
  attachContentSignals,
  buildGraph,
  RELATIONSHIP_SOURCES,
} from './graph.mjs';
import { resolutionFingerprint } from './resolve.mjs';

const DAY = 86_400_000;
const PROJECTION_VERSION = 1;
const sourceSql = RELATIONSHIP_SOURCES.map((source) => `'${source.replaceAll("'", "''")}'`).join(',');

export const PEOPLE_PROJECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS people_projection_state(
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  source_revision      INTEGER NOT NULL DEFAULT 0,
  projected_revision   INTEGER NOT NULL DEFAULT -1,
  identity_fingerprint TEXT,
  projected_day        TEXT,
  built_at             INTEGER,
  people_count         INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO people_projection_state(id) VALUES(1);

CREATE TABLE IF NOT EXISTS people(
  person_key       TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  first_seen       INTEGER,
  last_seen        INTEGER,
  last_from_them   INTEGER,
  last_from_owner  INTEGER,
  sent             INTEGER NOT NULL,
  received         INTEGER NOT NULL,
  met_in_person    INTEGER NOT NULL,
  room_messages    INTEGER NOT NULL,
  direct_messages  INTEGER NOT NULL,
  meeting_notes    INTEGER NOT NULL,
  role             TEXT NOT NULL,
  roles_by_year    TEXT NOT NULL, /* canonical JSON object */
  linkedin         TEXT,          /* canonical JSON object or NULL */
  built_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS person_identifiers(
  identifier TEXT PRIMARY KEY,
  person_key TEXT NOT NULL REFERENCES people(person_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS person_identifiers_person ON person_identifiers(person_key);

CREATE TABLE IF NOT EXISTS identity_evidence(
  person_key    TEXT NOT NULL REFERENCES people(person_key) ON DELETE CASCADE,
  identifier    TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'source_observed','contacts_card','legacy_contact_name','calendar_identifier',
    'exact_identifier','exact_name_unambiguous','owner_confirmed'
  )),
  source        TEXT NOT NULL,
  confidence    REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  PRIMARY KEY(person_key, identifier, evidence_type, source)
);
CREATE INDEX IF NOT EXISTS identity_evidence_identifier ON identity_evidence(identifier);

CREATE TABLE IF NOT EXISTS person_channels(
  person_key TEXT NOT NULL REFERENCES people(person_key) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN (${sourceSql})),
  PRIMARY KEY(person_key, source)
);

CREATE TABLE IF NOT EXISTS person_activity(
  person_key TEXT NOT NULL REFERENCES people(person_key) ON DELETE CASCADE,
  ym         TEXT NOT NULL CHECK (ym GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  source     TEXT NOT NULL CHECK (source IN (${sourceSql})),
  sent       INTEGER NOT NULL DEFAULT 0,
  received   INTEGER NOT NULL DEFAULT 0,
  met        INTEGER NOT NULL DEFAULT 0,
  room       INTEGER NOT NULL DEFAULT 0,
  notes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(person_key, ym, source)
);
CREATE INDEX IF NOT EXISTS person_activity_period ON person_activity(ym, person_key);

CREATE TABLE IF NOT EXISTS person_active_days(
  person_key TEXT NOT NULL REFERENCES people(person_key) ON DELETE CASCADE,
  day        TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY(person_key, day)
);

CREATE TRIGGER IF NOT EXISTS people_context_ai
AFTER INSERT ON context
WHEN new.source IN (${sourceSql})
BEGIN
  UPDATE people_projection_state SET source_revision = source_revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS people_context_au
AFTER UPDATE ON context
WHEN old.source IN (${sourceSql}) OR new.source IN (${sourceSql})
BEGIN
  UPDATE people_projection_state SET source_revision = source_revision + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS people_context_ad
AFTER DELETE ON context
WHEN old.source IN (${sourceSql})
BEGIN
  UPDATE people_projection_state SET source_revision = source_revision + 1 WHERE id = 1;
END;
`;

const schemaReady = new WeakSet();
export function ensurePeopleProjectionSchema(db) {
  if (schemaReady.has(db)) return;
  db.exec(PEOPLE_PROJECTION_SCHEMA);
  schemaReady.add(db);
}

export function isProjectedPeopleSource(source) {
  return RELATIONSHIP_SOURCES.includes(source);
}

// Privacy deletion cannot leave a derived copy behind until the next search.
// Call inside the corpus deletion transaction so source rows and their people
// projection disappear atomically. The revision itself is preserved; marking
// projected_revision -1 makes the next reader rebuild from what remains.
export function clearPeopleProjection(db) {
  db.exec(
    'DELETE FROM identity_evidence; DELETE FROM person_identifiers; DELETE FROM person_channels; ' +
    'DELETE FROM person_activity; DELETE FROM person_active_days; DELETE FROM people; ' +
    'UPDATE people_projection_state SET projected_revision = -1, identity_fingerprint = NULL, ' +
    'projected_day = NULL, built_at = NULL, people_count = 0 WHERE id = 1;'
  );
}

function canonical(value) {
  if (value instanceof Set) return [...value].sort().map(canonical);
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, item]) => [key, canonical(item)]);
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value ?? null;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function contactRows(stateDb) {
  if (!stateDb) return [];
  let columns;
  try {
    columns = new Set(
      stateDb.prepare("SELECT name FROM pragma_table_info('contact_ids')").all().map((row) => row.name)
    );
  } catch (error) {
    if (/no such table/iu.test(String(error?.message ?? ''))) return [];
    throw error;
  }
  if (columns.size === 0) return [];
  // updated_ts is intentionally absent. A complete Contacts-framework scan
  // replaces the snapshot with a new write time even when its identity content
  // is byte-for-byte unchanged. Freshness depends on identity facts, not when
  // those same facts were observed again.
  const selected = ['identifier', 'display_name', 'kind', 'person_ref', 'source']
    .filter((column) => columns.has(column));
  return stateDb.prepare(`SELECT ${selected.join(', ')} FROM contact_ids ORDER BY identifier`).all()
    .map((row) => ({ ...row }));
}

export function peopleSpineFingerprint(stateDb) {
  return hashJson({ version: PROJECTION_VERSION, contacts: contactRows(stateDb) });
}

export function peopleIdentityFingerprint(stateDb, aliases, owner) {
  return hashJson({
    version: PROJECTION_VERSION,
    spine: peopleSpineFingerprint(stateDb),
    aliases: resolutionFingerprint(aliases),
    owner: {
      addresses: owner?.addresses ?? new Set(),
      names: owner?.names ?? [],
      keys: owner?.keys ?? new Set(),
      schools: owner?.schools ?? [],
      highSchools: owner?.highSchools ?? [],
      roles: owner?.roles ?? new Map(),
      rolesByYear: owner?.rolesByYear ?? new Map(),
    },
  });
}

function localDay(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function readPeopleProjection(db, { now = Date.now() } = {}) {
  ensurePeopleProjectionSchema(db);
  const people = new Map();
  for (const row of db.prepare('SELECT * FROM people ORDER BY person_key').all()) {
    const firstSeen = row.first_seen === null ? null : Number(row.first_seen);
    const lastSeen = row.last_seen === null ? null : Number(row.last_seen);
    const lastFromThem = row.last_from_them === null ? null : Number(row.last_from_them);
    const lastFromOwner = row.last_from_owner === null ? null : Number(row.last_from_owner);
    const sent = Number(row.sent);
    const received = Number(row.received);
    const directMessages = Number(row.direct_messages);
    const roomMessages = Number(row.room_messages);
    people.set(row.person_key, {
      key: row.person_key,
      name: row.display_name,
      identifiers: [],
      channels: [],
      channelCount: 0,
      messages: sent + received,
      sent,
      received,
      reciprocity: Math.max(sent, received) > 0
        ? Math.round((100 * Math.min(sent, received)) / Math.max(sent, received)) / 100
        : 0,
      metInPerson: Number(row.met_in_person),
      meetingNotes: Number(row.meeting_notes),
      roomMessages,
      directMessages,
      roomOnly: directMessages === 0 && roomMessages > 0,
      firstSeen,
      lastSeen,
      dormancyDays: lastFromThem === null ? null : Math.floor((now - lastFromThem) / DAY),
      relationshipDays: lastSeen === null || firstSeen === null ? 0 : Math.floor((lastSeen - firstSeen) / DAY),
      lastFromThem,
      lastFromOwner,
      timeline: [],
      activeDays: [],
      activity: [],
      linkedin: parseJson(row.linkedin, null),
      content: {},
      identityEvidence: [],
      role: row.role,
      rolesByYear: parseJson(row.roles_by_year, {}),
    });
  }

  for (const row of db.prepare('SELECT identifier, person_key FROM person_identifiers ORDER BY person_key, identifier').all()) {
    people.get(row.person_key)?.identifiers.push(row.identifier);
  }
  for (const row of db.prepare('SELECT person_key, source FROM person_channels ORDER BY person_key, source').all()) {
    people.get(row.person_key)?.channels.push(row.source);
  }
  for (const person of people.values()) person.channelCount = person.channels.length;

  const timeline = new Map();
  for (const row of db.prepare('SELECT * FROM person_activity ORDER BY person_key, ym, source').all()) {
    const person = people.get(row.person_key);
    if (!person) continue;
    const activity = {
      ym: row.ym,
      source: row.source,
      sent: Number(row.sent),
      received: Number(row.received),
      met: Number(row.met),
      room: Number(row.room),
      notes: Number(row.notes),
    };
    person.activity.push(activity);
    const key = `${row.person_key}\u0000${row.ym}`;
    let bucket = timeline.get(key);
    if (!bucket) {
      bucket = { ym: row.ym, sent: 0, received: 0, met: 0, room: 0, notes: 0, channels: new Set() };
      timeline.set(key, bucket);
      person.timeline.push(bucket);
    }
    bucket.sent += activity.sent;
    bucket.received += activity.received;
    bucket.met += activity.met;
    bucket.room += activity.room;
    bucket.notes += activity.notes;
    bucket.channels.add(activity.source);
  }
  for (const person of people.values()) {
    person.timeline = person.timeline.map((bucket) => ({ ...bucket, channels: [...bucket.channels].sort() }));
  }
  for (const row of db.prepare('SELECT person_key, day FROM person_active_days ORDER BY person_key, day').all()) {
    people.get(row.person_key)?.activeDays.push(row.day);
  }
  for (const row of db.prepare('SELECT * FROM identity_evidence ORDER BY person_key, identifier, evidence_type, source').all()) {
    people.get(row.person_key)?.identityEvidence.push({
      identifier: row.identifier,
      type: row.evidence_type,
      source: row.source,
      confidence: Number(row.confidence),
    });
  }
  return [...people.values()];
}

function comparable(graph) {
  return graph.map((person) => ({
    key: person.key,
    name: person.name,
    identifiers: [...(person.identifiers ?? [])].sort(),
    channels: [...(person.channels ?? [])].sort(),
    sent: person.sent,
    received: person.received,
    metInPerson: person.metInPerson,
    meetingNotes: person.meetingNotes ?? 0,
    roomMessages: person.roomMessages,
    directMessages: person.directMessages,
    firstSeen: person.firstSeen,
    lastSeen: person.lastSeen,
    lastFromThem: person.lastFromThem,
    lastFromOwner: person.lastFromOwner,
    role: person.role,
    rolesByYear: person.rolesByYear ?? {},
    linkedin: person.linkedin ?? null,
    activity: [...(person.activity ?? [])].sort((a, b) =>
      a.ym.localeCompare(b.ym) || a.source.localeCompare(b.source)
    ),
    activeDays: [...(person.activeDays ?? [])].sort(),
    evidence: [...(person.identityEvidence ?? [])].sort((a, b) =>
      a.identifier.localeCompare(b.identifier) || a.type.localeCompare(b.type) || a.source.localeCompare(b.source)
    ),
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function replaceProjection(db, graph, { revision, identityFingerprint, day, now }) {
  const insertPerson = db.prepare(
    'INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner, ' +
      'sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year, linkedin, built_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insertIdentifier = db.prepare('INSERT INTO person_identifiers(identifier, person_key) VALUES(?,?)');
  const insertEvidence = db.prepare(
    'INSERT INTO identity_evidence(person_key, identifier, evidence_type, source, confidence) VALUES(?,?,?,?,?)'
  );
  const insertChannel = db.prepare('INSERT INTO person_channels(person_key, source) VALUES(?,?)');
  const insertActivity = db.prepare(
    'INSERT INTO person_activity(person_key, ym, source, sent, received, met, room, notes) VALUES(?,?,?,?,?,?,?,?)'
  );
  const insertDay = db.prepare('INSERT INTO person_active_days(person_key, day) VALUES(?,?)');

  db.exec('BEGIN');
  try {
    db.exec(
      'DELETE FROM identity_evidence; DELETE FROM person_identifiers; DELETE FROM person_channels; ' +
      'DELETE FROM person_activity; DELETE FROM person_active_days; DELETE FROM people;'
    );
    for (const person of graph) {
      insertPerson.run(
        person.key, person.name, person.firstSeen ?? null, person.lastSeen ?? null,
        person.lastFromThem ?? null, person.lastFromOwner ?? null,
        person.sent ?? 0, person.received ?? 0, person.metInPerson ?? 0,
        person.roomMessages ?? 0, person.directMessages ?? 0, person.meetingNotes ?? 0,
        person.role ?? 'friend', JSON.stringify(canonical(person.rolesByYear ?? {})),
        person.linkedin ? JSON.stringify(canonical(person.linkedin)) : null, now
      );
      for (const identifier of [...new Set(person.identifiers ?? [])].sort()) {
        insertIdentifier.run(identifier, person.key);
      }
      for (const item of person.identityEvidence ?? []) {
        insertEvidence.run(person.key, item.identifier, item.type, item.source, item.confidence ?? 1);
      }
      for (const source of [...new Set(person.channels ?? [])].sort()) insertChannel.run(person.key, source);
      for (const activity of person.activity ?? []) {
        insertActivity.run(
          person.key, activity.ym, activity.source, activity.sent ?? 0, activity.received ?? 0,
          activity.met ?? 0, activity.room ?? 0, activity.notes ?? 0
        );
      }
      for (const activeDay of [...new Set(person.activeDays ?? [])].sort()) insertDay.run(person.key, activeDay);
    }

    const loaded = readPeopleProjection(db, { now });
    if (hashJson(comparable(loaded)) !== hashJson(comparable(graph))) {
      throw new Error('people projection verification failed');
    }
    db.prepare(
      'UPDATE people_projection_state SET projected_revision = ?, identity_fingerprint = ?, ' +
        'projected_day = ?, built_at = ?, people_count = ? WHERE id = 1'
    ).run(revision, identityFingerprint, day, now, graph.length);
    db.exec('COMMIT');
    return loaded;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function projectionState(db) {
  ensurePeopleProjectionSchema(db);
  return db.prepare('SELECT * FROM people_projection_state WHERE id = 1').get();
}

export function refreshPeopleProjection(
  contextDb,
  stateDb,
  { now = Date.now(), owner = { addresses: new Set(), names: [], keys: new Set() }, aliases = null, force = false } = {}
) {
  ensurePeopleProjectionSchema(contextDb);
  const state = projectionState(contextDb);
  const identityFingerprint = peopleIdentityFingerprint(stateDb, aliases, owner);
  const day = localDay(now);
  const fresh = !force
    && Number(state.projected_revision) === Number(state.source_revision)
    && state.identity_fingerprint === identityFingerprint
    && state.projected_day === day;
  if (fresh) return { graph: readPeopleProjection(contextDb, { now }), rebuilt: false };

  const graph = buildGraph(contextDb, stateDb, { now, owner, aliases });
  return {
    graph: replaceProjection(contextDb, graph, {
      revision: Number(state.source_revision), identityFingerprint, day, now,
    }),
    rebuilt: true,
  };
}

export function materializedPeopleGraph(
  contextDb,
  stateDb,
  { now = Date.now(), owner, aliases = null, sinceTs = null, contentSignals = null, force = false } = {}
) {
  // A custom time window is a different graph, not a filter over all-time
  // totals. Keep that uncommon path correct with the raw builder.
  if (sinceTs !== null && sinceTs !== undefined) {
    return buildGraph(contextDb, stateDb, { now, owner, aliases, sinceTs, contentSignals });
  }
  let graph;
  try {
    graph = refreshPeopleProjection(contextDb, stateDb, { now, owner, aliases, force }).graph;
  } catch {
    // The projection is an optimization over rebuildable data. A schema or
    // serialization failure must not turn a correct raw answer into no answer.
    return buildGraph(contextDb, stateDb, { now, owner, aliases, contentSignals });
  }
  if (contentSignals) {
    const idToKey = new Map(graph.flatMap((person) =>
      (person.identifiers ?? []).map((identifier) => [identifier, person.key])
    ));
    attachContentSignals(contextDb, graph, idToKey, contentSignals);
  }
  return graph;
}

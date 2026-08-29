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
import { buildPersonEventLinkBatch, buildPersonEventLinks } from './evidence.mjs';
import { resolutionFingerprint } from './resolve.mjs';

const DAY = 86_400_000;
const PROJECTION_VERSION = 4;
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

CREATE TABLE IF NOT EXISTS person_event_links(
  person_key      TEXT NOT NULL REFERENCES people(person_key) ON DELETE CASCADE,
  context_id      INTEGER NOT NULL REFERENCES context(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN (${sourceSql})),
  role            TEXT NOT NULL CHECK (role IN (
    'counterparty','speaker','sender','recipient','cc','attendee','declined',
    'organizer','profile','participant'
  )),
  authored        INTEGER NOT NULL CHECK (authored IN (0,1)),
  owner_authored  INTEGER NOT NULL CHECK (owner_authored IN (0,1)),
  room            INTEGER NOT NULL CHECK (room IN (0,1)),
  confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  conversation_key TEXT NOT NULL,
  PRIMARY KEY(person_key, context_id, role)
);
CREATE INDEX IF NOT EXISTS person_event_links_context ON person_event_links(context_id, person_key);
CREATE INDEX IF NOT EXISTS person_event_links_source_authored ON person_event_links(source, authored, context_id);
CREATE INDEX IF NOT EXISTS person_event_links_source_role ON person_event_links(source, role, context_id);
CREATE INDEX IF NOT EXISTS person_event_links_conversation ON person_event_links(person_key, conversation_key, context_id);

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

CREATE TABLE IF NOT EXISTS people_projection_dirty(
  context_id INTEGER NOT NULL,
  person_key TEXT NOT NULL DEFAULT '',
  operation  TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  PRIMARY KEY(context_id, person_key)
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
CREATE TRIGGER IF NOT EXISTS people_context_dirty_ai
AFTER INSERT ON context
WHEN new.source IN (${sourceSql})
BEGIN
  INSERT OR REPLACE INTO people_projection_dirty(context_id, person_key, operation)
  VALUES(new.id, '', 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS people_context_dirty_bu
BEFORE UPDATE ON context
WHEN old.source IN (${sourceSql}) OR new.source IN (${sourceSql})
BEGIN
  INSERT OR REPLACE INTO people_projection_dirty(context_id, person_key, operation)
  SELECT old.id, person_key, 'upsert' FROM person_event_links WHERE context_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS people_context_dirty_au
AFTER UPDATE ON context
WHEN old.source IN (${sourceSql}) OR new.source IN (${sourceSql})
BEGIN
  INSERT OR REPLACE INTO people_projection_dirty(context_id, person_key, operation)
  VALUES(new.id, '', 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS people_context_dirty_bd
BEFORE DELETE ON context
WHEN old.source IN (${sourceSql})
BEGIN
  INSERT OR REPLACE INTO people_projection_dirty(context_id, person_key, operation)
  SELECT old.id, person_key, 'delete' FROM person_event_links WHERE context_id = old.id;
END;
`;

const schemaReady = new WeakSet();
export function ensurePeopleProjectionSchema(db) {
  if (schemaReady.has(db)) return;
  db.exec(PEOPLE_PROJECTION_SCHEMA);
  const eventColumns = new Set(
    db.prepare("SELECT name FROM pragma_table_info('person_event_links')").all().map((row) => row.name)
  );
  if (!eventColumns.has('owner_authored')) {
    db.exec(
      'ALTER TABLE person_event_links ADD COLUMN owner_authored INTEGER NOT NULL DEFAULT 0 ' +
        'CHECK (owner_authored IN (0,1))'
    );
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS person_event_links_source_owner_authored ' +
      'ON person_event_links(source, owner_authored, context_id)'
  );
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
    'DELETE FROM people_projection_dirty; DELETE FROM person_event_links; DELETE FROM identity_evidence; DELETE FROM person_identifiers; DELETE FROM person_channels; ' +
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

function projectionWriters(db) {
  return {
    person: db.prepare(
    'INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner, ' +
      'sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year, linkedin, built_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ),
    identifier: db.prepare('INSERT INTO person_identifiers(identifier, person_key) VALUES(?,?)'),
    evidence: db.prepare(
      'INSERT INTO identity_evidence(person_key, identifier, evidence_type, source, confidence) VALUES(?,?,?,?,?)'
    ),
    channel: db.prepare('INSERT INTO person_channels(person_key, source) VALUES(?,?)'),
    event: db.prepare(
      'INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key) ' +
        'VALUES(?,?,?,?,?,?,?,?,?)'
    ),
    activity: db.prepare(
      'INSERT INTO person_activity(person_key, ym, source, sent, received, met, room, notes) VALUES(?,?,?,?,?,?,?,?)'
    ),
    day: db.prepare('INSERT INTO person_active_days(person_key, day) VALUES(?,?)'),
  };
}

function insertPeople(writers, graph, now) {
  for (const person of graph) {
    writers.person.run(
      person.key, person.name, person.firstSeen ?? null, person.lastSeen ?? null,
      person.lastFromThem ?? null, person.lastFromOwner ?? null,
      person.sent ?? 0, person.received ?? 0, person.metInPerson ?? 0,
      person.roomMessages ?? 0, person.directMessages ?? 0, person.meetingNotes ?? 0,
      person.role ?? 'friend', JSON.stringify(canonical(person.rolesByYear ?? {})),
      person.linkedin ? JSON.stringify(canonical(person.linkedin)) : null, now
    );
    for (const identifier of [...new Set(person.identifiers ?? [])].sort()) {
      writers.identifier.run(identifier, person.key);
    }
    for (const item of person.identityEvidence ?? []) {
      writers.evidence.run(person.key, item.identifier, item.type, item.source, item.confidence ?? 1);
    }
    for (const source of [...new Set(person.channels ?? [])].sort()) writers.channel.run(person.key, source);
    for (const activity of person.activity ?? []) {
      writers.activity.run(
        person.key, activity.ym, activity.source, activity.sent ?? 0, activity.received ?? 0,
        activity.met ?? 0, activity.room ?? 0, activity.notes ?? 0
      );
    }
    for (const activeDay of [...new Set(person.activeDays ?? [])].sort()) writers.day.run(person.key, activeDay);
  }
}

function insertEventLinks(writer, eventLinks) {
  for (const link of eventLinks) {
    writer.run(
      link.personKey, link.contextId, link.source, link.role,
      link.authored ? 1 : 0, link.ownerAuthored ? 1 : 0, link.room ? 1 : 0,
      link.confidence, link.conversationKey
    );
  }
}

function replaceProjection(db, graph, eventLinks, { revision, identityFingerprint, day, now }) {
  const writers = projectionWriters(db);

  db.exec('BEGIN');
  try {
    db.exec(
      'DELETE FROM person_event_links; DELETE FROM identity_evidence; DELETE FROM person_identifiers; DELETE FROM person_channels; ' +
      'DELETE FROM person_activity; DELETE FROM person_active_days; DELETE FROM people;'
    );
    insertPeople(writers, graph, now);
    insertEventLinks(writers.event, eventLinks);

    const loaded = readPeopleProjection(db, { now });
    if (hashJson(comparable(loaded)) !== hashJson(comparable(graph))) {
      throw new Error('people projection verification failed');
    }
    const storedLinks = Number(db.prepare('SELECT count(*) AS n FROM person_event_links').get().n);
    if (storedLinks !== eventLinks.length) throw new Error('people evidence projection verification failed');
    db.prepare(
      'UPDATE people_projection_state SET projected_revision = ?, identity_fingerprint = ?, ' +
        'projected_day = ?, built_at = ?, people_count = ? WHERE id = 1'
    ).run(revision, identityFingerprint, day, now, graph.length);
    db.exec('DELETE FROM people_projection_dirty');
    db.exec('COMMIT');
    return loaded;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))];
}

function contextIdsForPeople(db, personKeys) {
  const ids = [];
  for (let index = 0; index < personKeys.length; index += 500) {
    const chunk = personKeys.slice(index, index + 500);
    ids.push(...db.prepare(
      `SELECT DISTINCT context_id FROM person_event_links WHERE person_key IN (${chunk.map(() => '?').join(',')})`
    ).all(...chunk).map((row) => Number(row.context_id)));
  }
  return uniqueNumbers(ids);
}

function incrementallyRefreshProjection(
  db,
  stateDb,
  state,
  { now, owner, aliases, identityFingerprint, day }
) {
  const dirty = db.prepare(
    'SELECT context_id, person_key, operation FROM people_projection_dirty ORDER BY context_id, person_key'
  ).all();
  if (dirty.length === 0) return null;

  const existingGraph = readPeopleProjection(db, { now });
  const dirtyContextIds = uniqueNumbers(dirty.map((row) => row.context_id));
  const currentBatch = buildPersonEventLinkBatch(db, existingGraph, { owner, contextIds: dirtyContextIds });
  // A new identifier cannot be safely assigned using the old graph. Fall back
  // to the full identity rebuild, which may mint or merge a person.
  if (currentBatch.unresolved > 0) return null;

  const affected = new Set([
    ...dirty.map((row) => row.person_key).filter(Boolean),
    ...currentBatch.links.map((link) => link.personKey),
  ]);
  const affectedKeys = [...affected].sort();
  if (affectedKeys.length === 0) {
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM people_projection_dirty');
      db.prepare(
        'UPDATE people_projection_state SET projected_revision = ?, identity_fingerprint = ?, ' +
          'projected_day = ?, built_at = ? WHERE id = 1'
      ).run(Number(state.source_revision), identityFingerprint, day, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { graph: existingGraph, rebuilt: true, incremental: true };
  }

  const affectedContextIds = uniqueNumbers([
    ...contextIdsForPeople(db, affectedKeys),
    ...dirtyContextIds,
  ]);
  const partialGraph = buildGraph(db, stateDb, {
    now, owner, aliases, contextIds: affectedContextIds,
  }).filter((person) => affected.has(person.key));
  const partialKeys = new Set(partialGraph.map((person) => person.key));
  if (currentBatch.links.some((link) => !partialKeys.has(link.personKey))) return null;
  const eventLinks = buildPersonEventLinks(db, partialGraph, {
    owner, contextIds: affectedContextIds,
  }).filter((link) => affected.has(link.personKey));
  const writers = projectionWriters(db);

  db.exec('BEGIN');
  try {
    for (let index = 0; index < affectedKeys.length; index += 500) {
      const chunk = affectedKeys.slice(index, index + 500);
      db.prepare(`DELETE FROM people WHERE person_key IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
    }
    insertPeople(writers, partialGraph, now);
    insertEventLinks(writers.event, eventLinks);

    const loaded = readPeopleProjection(db, { now });
    const loadedAffected = loaded.filter((person) => affected.has(person.key));
    if (hashJson(comparable(loadedAffected)) !== hashJson(comparable(partialGraph))) {
      throw new Error('incremental people projection verification failed');
    }
    const storedLinks = affectedKeys.reduce((total, key) => total + Number(
      db.prepare('SELECT count(*) AS n FROM person_event_links WHERE person_key = ?').get(key).n
    ), 0);
    if (storedLinks !== eventLinks.length) {
      throw new Error('incremental people evidence projection verification failed');
    }
    db.prepare(
      'UPDATE people_projection_state SET projected_revision = ?, identity_fingerprint = ?, ' +
        'projected_day = ?, built_at = ?, people_count = ? WHERE id = 1'
    ).run(Number(state.source_revision), identityFingerprint, day, now, loaded.length);
    db.exec('DELETE FROM people_projection_dirty');
    db.exec('COMMIT');
    return { graph: loaded, rebuilt: true, incremental: true };
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

  const identityStable = !force
    && Number(state.projected_revision) >= 0
    && state.identity_fingerprint === identityFingerprint
    && state.projected_day === day;
  if (identityStable) {
    const incremental = incrementallyRefreshProjection(contextDb, stateDb, state, {
      now, owner, aliases, identityFingerprint, day,
    });
    if (incremental) return incremental;
  }

  const graph = buildGraph(contextDb, stateDb, { now, owner, aliases });
  const eventLinks = buildPersonEventLinks(contextDb, graph, { owner });
  return {
    graph: replaceProjection(contextDb, graph, eventLinks, {
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

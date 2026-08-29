import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { insertRows, openDb } from '../server/hermes.mjs';
import { buildGraph } from '../server/people/graph.mjs';
import {
  materializedPeopleGraph,
  projectionState,
  refreshPeopleProjection,
} from '../server/people/projection.mjs';

const NOW = Date.UTC(2027, 0, 1, 12);
const DAY = 86_400_000;
const owner = () => ({
  addresses: new Set(['owner@example.test']), names: ['Owner'], keys: new Set(),
  schools: [], highSchools: [], roles: new Map(), rolesByYear: new Map(),
});

function stateDb(rows = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE contact_ids(' +
      'identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, person_ref TEXT, source TEXT, updated_ts INTEGER)'
  );
  const insert = db.prepare('INSERT INTO contact_ids VALUES(?,?,?,?,?,?)');
  for (const row of rows) {
    insert.run(row.id, row.name, row.kind ?? 'email', row.ref ?? null, row.source ?? 'contacts', row.ts ?? NOW);
  }
  return db;
}

function coreShape(graph) {
  return graph.map((person) => ({
    key: person.key,
    name: person.name,
    identifiers: [...person.identifiers].sort(),
    channels: [...person.channels].sort(),
    sent: person.sent,
    received: person.received,
    met: person.metInPerson,
    notes: person.meetingNotes,
    timeline: person.timeline,
    activeDays: person.activeDays,
    role: person.role,
    rolesByYear: person.rolesByYear,
  })).sort((a, b) => a.key.localeCompare(b.key));
}

test('Hermes creates dedicated people projection tables and revisions participant writes', () => {
  const db = openDb(':memory:');
  const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const name of ['people', 'person_identifiers', 'identity_evidence', 'person_event_links', 'person_activity']) {
    assert.ok(tableNames.has(name), `${name} exists`);
  }
  assert.equal(Number(projectionState(db).source_revision), 0);
  insertRows(db, { ts: NOW, source: 'seed', entity_id: 'seed:1', text: 'fixture' });
  assert.equal(Number(projectionState(db).source_revision), 0, 'non-person rows do not dirty the graph');
  insertRows(db, {
    ts: NOW, source: 'imessage', entity_id: 'i:1', text: 'hi',
    meta: { chat_handle: '+15550100', is_from_me: false },
  });
  assert.equal(Number(projectionState(db).source_revision), 1);
});

test('a refresh materializes people, all card identifiers, evidence, and source activity', () => {
  const db = openDb(':memory:');
  const spine = stateDb([
    { id: '+15550100', name: 'Sam Lee', kind: 'phone', ref: 'card-sam' },
    { id: 'sam@one.test', name: 'Sam Lee', ref: 'card-sam' },
    { id: 'sam@two.test', name: 'Sam Lee', ref: 'card-sam' },
  ]);
  insertRows(db, [
    { ts: NOW - 2 * DAY, source: 'imessage', entity_id: 'i:1', text: 'hi', meta: { chat_handle: '+15550100', is_from_me: false } },
    { ts: NOW - DAY, source: 'granola', entity_id: 'g:1', text: 'notes', meta: { participants: [{ email: 'sam@one.test', name: 'Sam Lee' }] } },
  ]);

  const first = refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  assert.equal(first.rebuilt, true);
  assert.equal(first.graph.length, 1);
  assert.deepEqual(first.graph[0].identifiers, ['+15550100', 'sam@one.test', 'sam@two.test']);
  assert.equal(first.graph[0].meetingNotes, 1);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM people').get().n), 1);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM person_identifiers').get().n), 3);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM identity_evidence WHERE evidence_type = 'contacts_card'").get().n), 3);
  assert.deepEqual(
    db.prepare('SELECT source, notes FROM person_activity ORDER BY source').all().map((row) => ({ ...row })),
    [{ source: 'granola', notes: 1 }, { source: 'imessage', notes: 0 }]
  );
  assert.deepEqual(
    db.prepare(
      'SELECT source, role, authored, owner_authored, room, confidence FROM person_event_links ORDER BY source'
    ).all().map((row) => ({ ...row })),
    [
      { source: 'granola', role: 'participant', authored: 0, owner_authored: 0, room: 0, confidence: 1 },
      { source: 'imessage', role: 'counterparty', authored: 1, owner_authored: 0, room: 0, confidence: 1 },
    ]
  );

  const second = refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  assert.equal(second.rebuilt, false, 'an unchanged search reads the prepared graph');
  assert.deepEqual(coreShape(second.graph), coreShape(buildGraph(db, spine, { now: NOW, owner: owner() })));

  spine.prepare('UPDATE contact_ids SET updated_ts = ?').run(NOW + DAY);
  const observedAgain = refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  assert.equal(observedAgain.rebuilt, false,
    'observing the same Contacts snapshot again does not invalidate identity');
});

test('event links distinguish the person speaking from the owner speaking to them', () => {
  const db = openDb(':memory:');
  const spine = stateDb([{ id: '+15550100', name: 'Sam Lee', kind: 'phone', ref: 'card-sam' }]);
  insertRows(db, [
    {
      ts: NOW - 2 * DAY, source: 'imessage', entity_id: 'i:incoming', text: 'My next trip is soon.',
      meta: { chat_handle: '+15550100', is_from_me: false },
    },
    {
      ts: NOW - DAY, source: 'imessage', entity_id: 'i:outgoing', text: 'Have you planned another trip?',
      meta: { chat_handle: '+15550100', is_from_me: true },
    },
  ]);
  refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  assert.deepEqual(
    db.prepare(
      'SELECT c.entity_id, pel.authored, pel.owner_authored FROM person_event_links pel ' +
        'JOIN context c ON c.id = pel.context_id ORDER BY c.entity_id'
    ).all().map((row) => ({ ...row })),
    [
      { entity_id: 'i:incoming', authored: 1, owner_authored: 0 },
      { entity_id: 'i:outgoing', authored: 0, owner_authored: 1 },
    ]
  );
});

test('corpus writes incrementally rebuild only affected existing people', () => {
  const db = openDb(':memory:');
  const spine = stateDb([
    { id: '+15550100', name: 'Sam Lee', kind: 'phone', ref: 'card-sam' },
    { id: '+15550101', name: 'Alex Still', kind: 'phone', ref: 'card-alex' },
  ]);
  insertRows(db, [
    {
      ts: NOW - DAY, source: 'imessage', entity_id: 'i:1', text: 'one',
      meta: { chat_handle: '+15550100', is_from_me: false },
    },
    {
      ts: NOW - DAY, source: 'imessage', entity_id: 'i:alex', text: 'unchanged',
      meta: { chat_handle: '+15550101', is_from_me: false },
    },
  ]);
  refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  const before = projectionState(db);
  const alexBuiltAt = db.prepare("SELECT built_at FROM people WHERE display_name = 'Alex Still'").get().built_at;

  insertRows(db, {
    ts: NOW, source: 'imessage', entity_id: 'i:2', text: 'two',
    meta: { chat_handle: '+15550100', is_from_me: true },
  });
  assert.ok(Number(projectionState(db).source_revision) > Number(before.projected_revision));
  const refreshed = refreshPeopleProjection(db, spine, { now: NOW + 1000, owner: owner() });
  assert.equal(refreshed.rebuilt, true);
  assert.equal(refreshed.incremental, true);
  assert.equal(refreshed.graph.find((person) => person.name === 'Sam Lee').messages, 2);
  assert.equal(
    db.prepare("SELECT built_at FROM people WHERE display_name = 'Alex Still'").get().built_at,
    alexBuiltAt,
    'an unrelated person row was not rewritten'
  );
  assert.equal(Number(projectionState(db).source_revision), Number(projectionState(db).projected_revision));
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM people_projection_dirty').get().n), 0);
});

test('incremental deletion removes a person whose last source row disappeared', () => {
  const db = openDb(':memory:');
  const spine = stateDb([{ id: '+15550109', name: 'Delete Me', kind: 'phone', ref: 'card-delete' }]);
  insertRows(db, {
    ts: NOW - DAY, source: 'imessage', entity_id: 'i:delete', text: 'temporary',
    meta: { chat_handle: '+15550109', is_from_me: false },
  });
  refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  db.prepare("DELETE FROM context WHERE entity_id = 'i:delete'").run();
  const refreshed = refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  assert.equal(refreshed.incremental, true);
  assert.equal(refreshed.graph.length, 0);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM person_event_links').get().n), 0);
});

test('same-sized owner merge changes invalidate and rewrite canonical membership', () => {
  const db = openDb(':memory:');
  const spine = stateDb();
  insertRows(db, ['+15550100', '+15550101', '+15550102'].map((id, index) => ({
    ts: NOW - index * DAY,
    source: 'imessage', entity_id: `i:${index}`, text: 'hi',
    meta: { chat_handle: id, is_from_me: false },
  })));

  const firstAliases = new Map([['id:+15550100', 'id:+15550101']]);
  const first = refreshPeopleProjection(db, spine, { now: NOW, owner: owner(), aliases: firstAliases });
  assert.equal(first.graph.length, 2);
  assert.deepEqual(
    first.graph.find((person) => person.key === 'id:+15550101').identifiers.sort(),
    ['+15550100', '+15550101']
  );

  const secondAliases = new Map([['id:+15550101', 'id:+15550102']]);
  const second = refreshPeopleProjection(db, spine, { now: NOW, owner: owner(), aliases: secondAliases });
  assert.equal(second.rebuilt, true);
  assert.equal(second.graph.length, 2);
  assert.deepEqual(
    second.graph.find((person) => person.key === 'id:+15550102').identifiers.sort(),
    ['+15550101', '+15550102']
  );
});

test('search graph reads materialized rows and decorates requested content evidence', () => {
  const db = openDb(':memory:');
  const spine = stateDb([{ id: 'maya@example.test', name: 'Maya Vela', ref: 'card-maya' }]);
  insertRows(db, {
    ts: NOW - DAY, source: 'mail', entity_id: 'm:1', text: 'We want to invest in you.',
    meta: { from: ['maya@example.test'], to: ['owner@example.test'] },
  });
  const graph = materializedPeopleGraph(db, spine, {
    now: NOW, owner: owner(), contentSignals: { investor: /invest in you/giu },
  });
  assert.equal(graph[0].content.investor, 2, 'mail content is applied to the prepared identity');
  assert.equal(refreshPeopleProjection(db, spine, { now: NOW, owner: owner() }).rebuilt, false);
});

test('a failed replacement rolls back to the last good projection and search falls back raw', () => {
  const db = openDb(':memory:');
  const spine = stateDb([{ id: '+15550100', name: 'Sam Lee', kind: 'phone', ref: 'card-sam' }]);
  insertRows(db, {
    ts: NOW - DAY, source: 'imessage', entity_id: 'i:good', text: 'one',
    meta: { chat_handle: '+15550100', is_from_me: false },
  });
  refreshPeopleProjection(db, spine, { now: NOW, owner: owner() });
  const before = db.prepare('SELECT person_key, received FROM people').get();

  insertRows(db, {
    ts: NOW, source: 'imessage', entity_id: 'i:new', text: 'two',
    meta: { chat_handle: '+15550100', is_from_me: false },
  });
  db.exec(
    "CREATE TRIGGER fail_people_insert BEFORE INSERT ON people BEGIN " +
      "SELECT RAISE(ABORT, 'simulated projection write failure'); END"
  );
  assert.throws(
    () => refreshPeopleProjection(db, spine, { now: NOW, owner: owner() }),
    /simulated projection write failure/
  );
  assert.deepEqual({ ...db.prepare('SELECT person_key, received FROM people').get() }, { ...before },
    'the delete-and-replace transaction restored the last good rows');

  const fallback = materializedPeopleGraph(db, spine, { now: NOW, owner: owner() });
  assert.equal(fallback[0].received, 2, 'a projection failure does not cost the current raw answer');
});

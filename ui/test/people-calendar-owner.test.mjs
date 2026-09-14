// THE OWNER IS ON EVERY INVITATION THEY WERE SENT.
//
// graph.mjs drops owner addresses in the mail branch and owner addresses and
// names in the granola branch. The calendar branch dropped nothing: the
// attendee list and the organizer went straight into `add()`, so an address
// the owner has — a second account, an old company alias, whatever the
// invitation happened to be addressed to — was minted as a person with role
// 'organizer' or 'attendee'.
//
// The only self-suppression downstream is `!owner.keys.has(p.key)` at the end
// of buildGraph, and `owner.keys` holds identities the owner has EXPLICITLY
// marked. An alias nobody marked never reaches it. The visible cost is the
// onboarding progress table, whose "people you met" count is
// COUNT(DISTINCT person_key) over calendar attendee/organizer links: a
// calendar of solo events then reported people met and painted green.
//
// The fixture below is heterogeneous on purpose — a solo event, a real
// meeting, and the same alias arriving through mail — so "drop every calendar
// participant" and "drop none" both fail it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { buildGraph } from '../server/people/graph.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const DAY = 86_400_000;

// The owner's own addresses, as loadOwner() assembles them: the mail account
// plus the `ownerEmails` aliases the config lists. `keys` is empty, which is
// the ordinary case — marking an identity as yourself is a deliberate act.
const OWNER = {
  addresses: new Set(['owner@example.test', 'owner@old-co.test']),
  names: ['Owner Name'],
  keys: new Set(),
};

function emptySpine() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  return db;
}

function calendarCorpus() {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    // A SOLO EVENT. Focus block, dentist, flight — the owner is the whole
    // guest list, and the invitation still carries their address twice.
    {
      ts: NOW - 6 * DAY, source: 'calendar', entity_id: 'c:solo', text: '"focus" 9:00AM',
      meta: {
        start_ms: NOW - 6 * DAY,
        attendees: [{ email: 'owner@old-co.test', name: 'Owner Name' }],
        organizer: { email: 'owner@old-co.test', name: 'Owner Name' },
      },
    },
    // A REAL MEETING, where the owner is also on the list. The alias must go
    // and Dana must stay: a fix that dropped the whole branch passes the solo
    // case and loses every person the calendar knows.
    {
      ts: NOW - 3 * DAY, source: 'calendar', entity_id: 'c:real', text: '"partner sync" 2:00PM',
      meta: {
        start_ms: NOW - 3 * DAY,
        attendees: [
          { email: 'owner@old-co.test', name: 'Owner Name' },
          { email: 'dana@partner.test', name: 'Dana Reed' },
        ],
        organizer: { email: 'owner@example.test', name: 'Owner Name' },
      },
    },
  ]);
  return ctx;
}

const keysOf = (graph) => new Set(graph.flatMap((person) => person.identifiers ?? []));

test('a calendar of solo events mints nobody', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [{
    ts: NOW - DAY, source: 'calendar', entity_id: 'c:solo', text: '"focus" 9:00AM',
    meta: {
      start_ms: NOW - DAY,
      attendees: [{ email: 'owner@old-co.test', name: 'Owner Name' }],
      organizer: 'owner@old-co.test',
    },
  }]);
  const graph = buildGraph(ctx, emptySpine(), { now: NOW, owner: OWNER });
  assert.deepEqual(graph, [], 'the owner is not somebody the owner met');
});

test('the alias goes and the real attendee stays', () => {
  const graph = buildGraph(calendarCorpus(), emptySpine(), { now: NOW, owner: OWNER });
  const ids = keysOf(graph);
  assert.ok(ids.has('dana@partner.test'), 'the person who was actually in the room');
  assert.ok(!ids.has('owner@old-co.test'), 'the owner alias on the attendee list');
  assert.ok(!ids.has('owner@example.test'), 'and on the organizer field');
  assert.equal(graph.length, 1);
});

test('calendar now decides it the way mail already did', () => {
  // THE PARITY THIS FIX IS ABOUT. The same alias, the same owner, one through
  // each branch: if the two disagree the graph has two answers to "is this
  // me?", which is how the alias got in.
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    {
      ts: NOW - 2 * DAY, source: 'mail', entity_id: 'm:self', text: 'note to self',
      meta: { from: ['owner@old-co.test'], to: ['owner@example.test'] },
    },
    {
      ts: NOW - 2 * DAY, source: 'calendar', entity_id: 'c:self', text: '"hold" 4:00PM',
      meta: { start_ms: NOW - 2 * DAY, attendees: [{ email: 'owner@old-co.test' }] },
    },
  ]);
  assert.deepEqual(buildGraph(ctx, emptySpine(), { now: NOW, owner: OWNER }), [],
    'neither branch may mint the owner');
});

test('an address the owner has not claimed is still a person', () => {
  // The filter is the owner's CONFIGURED addresses and nothing cleverer. An
  // unrelated address that merely looks similar stays a person, because
  // guessing self-ness from the corpus is how a real contact disappears.
  const ctx = openDb(':memory:');
  insertRows(ctx, [{
    ts: NOW - DAY, source: 'calendar', entity_id: 'c:other', text: '"intro" 10:00AM',
    meta: {
      start_ms: NOW - DAY,
      attendees: [{ email: 'owner@another-co.test', name: 'Someone Else' }],
      organizer: { email: 'owner@example.test' },
    },
  }]);
  const graph = buildGraph(ctx, emptySpine(), { now: NOW, owner: OWNER });
  assert.deepEqual([...keysOf(graph)], ['owner@another-co.test']);
});

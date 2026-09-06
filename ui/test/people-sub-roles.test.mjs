// Tests for investor/founder/operator sub-role tags: the pure derivation
// (subRoles.mjs), and that the projection actually persists and serializes
// them (projection.mjs / graph.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseSync } from 'node:sqlite';

import { subRolesFor, subRolesFromPosition } from '../server/people/subRoles.mjs';
import { openDb, insertRows } from '../server/hermes.mjs';
import {
  ensurePeopleProjectionSchema,
  refreshPeopleProjection,
  readPeopleProjection,
} from '../server/people/projection.mjs';

const NOW = Date.UTC(2027, 0, 1, 12);

test('subRolesFromPosition covers each derivation rule and each exclusion', () => {
  const cases = [
    // Investor
    ['General Partner', ['investor']],
    ['Managing Partner', ['investor']],
    ['GP', ['investor']],
    ['Principal', ['investor']],
    ['Investor', ['investor']],
    ['Venture Partner', ['investor']],
    ['Angel Investor', ['investor']],
    ['Partner at Example Capital', ['investor']],
    ['Partner, Example Ventures', ['investor']],
    // Service-provider exclusion: same vocabulary, not an investor
    ['Financial Advisor', []],
    ['Wealth Manager', []],
    ['Insurance Broker', []],
    ['Mortgage Broker', []],
    ['Real Estate Broker', []],
    ['Senior Recruiter', []],
    // Bare "Partner" is ambiguous without firm-side words
    ['Partner', []],
    ['Partner, Example Law LLP', []],
    // Founder
    ['Founder', ['founder']],
    ['Co-Founder & CEO', ['founder']],
    ['Cofounder', ['founder']],
    ['Owner', ['founder']],
    ['Chief Executive Officer', ['founder']],
    // Founding <role> is not a founder
    ['Founding Engineer', []],
    ['Founding Designer', []],
    // Operator (only when neither founder nor investor matched)
    ['Head of Product', ['operator']],
    ['VP Engineering', ['operator']],
    ['Vice President, Sales'.replace(', Sales', ''), ['operator']],
    ['Director of Marketing', ['operator']],
    ['Chief Technology Officer', ['operator']],
    ['CTO', ['operator']],
    // Neither pattern
    ['Software Engineer', []],
  ];
  for (const [position, expected] of cases) {
    assert.deepEqual(subRolesFromPosition(position), expected, `position: ${position}`);
  }
});

test('a founder who is also an investor gets both tags', () => {
  assert.deepEqual(subRolesFromPosition('Founder & General Partner'), ['founder', 'investor']);
});

test('subRolesFromPosition is position-only: a bare "Partner" needs the firm words in the title itself', () => {
  // No company is available to this function, so an ambiguous "Partner" only
  // resolves off text that is actually in the title.
  assert.deepEqual(subRolesFromPosition('Partner'), []);
  assert.deepEqual(subRolesFromPosition('Partner at Example Capital'), ['investor']);
});

test('subRolesFor also resolves the ambiguous "Partner" title against the company field', () => {
  const lawyer = { key: 'p:1', linkedin: { position: 'Partner', company: 'Example Law LLP' } };
  assert.deepEqual(subRolesFor(lawyer), []);

  const vcPartner = { key: 'p:2', linkedin: { position: 'Partner', company: 'Example Capital' } };
  assert.deepEqual(subRolesFor(vcPartner), ['investor']);
});

test('subRolesFor: an owner override replaces the derived set entirely', () => {
  const person = { key: 'p:3', linkedin: { position: 'Software Engineer', company: 'Acme' } };
  assert.deepEqual(subRolesFor(person), [], 'derivation alone finds nothing here');

  const overrides = { 'p:3': ['founder', 'founder', 'investor'] };
  assert.deepEqual(subRolesFor(person, overrides), ['founder', 'investor'], 'override wins, deduped and sorted');

  // A Map works the same way as the plain object read from config.json.
  const mapOverrides = new Map([['p:3', ['operator']]]);
  assert.deepEqual(subRolesFor(person, mapOverrides), ['operator']);

  // Junk values outside the closed set are dropped, not passed through.
  assert.deepEqual(subRolesFor(person, { 'p:3': ['founder', 'bogus'] }), ['founder']);
});

test('subRolesFor: no override and no linkedin position derives nothing', () => {
  assert.deepEqual(subRolesFor({ key: 'p:4' }), []);
  assert.deepEqual(subRolesFor({ key: 'p:4', linkedin: null }), []);
});

test('the people projection persists and serializes sub_roles from a LinkedIn connection', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    {
      ts: NOW - 86_400_000, source: 'linkedin', entity_id: 'linkedin:conn:investor1', text: 'Jamie Fund — GP',
      meta: { kind: 'connection', name: 'Jamie Fund', position: 'General Partner', company: 'Acme Ventures', connected_on: '01 Jun 2020' },
    },
    {
      ts: NOW - 86_400_000, source: 'linkedin', entity_id: 'linkedin:conn:founder1', text: 'Robin Startup — Founder',
      meta: { kind: 'connection', name: 'Robin Startup', position: 'Co-Founder & CEO', company: 'Startup Co', connected_on: '01 Jun 2020' },
    },
    {
      ts: NOW - 86_400_000, source: 'linkedin', entity_id: 'linkedin:conn:eng1', text: 'Sam Eng — SWE',
      meta: { kind: 'connection', name: 'Sam Eng', position: 'Software Engineer', company: 'BigCo', connected_on: '01 Jun 2020' },
    },
  ]);

  const owner = {
    addresses: new Set(), names: [], keys: new Set(),
    schools: [], highSchools: [], roles: new Map(), rolesByYear: new Map(), subRoles: new Map(),
  };
  const { graph, rebuilt } = refreshPeopleProjection(db, null, { now: NOW, owner });
  assert.equal(rebuilt, true);

  const byName = new Map(graph.map((p) => [p.name, p]));
  assert.deepEqual(byName.get('Jamie Fund')?.subRoles, ['investor']);
  assert.deepEqual(byName.get('Robin Startup')?.subRoles, ['founder']);
  assert.deepEqual(byName.get('Sam Eng')?.subRoles, []);

  // And it round-trips through a fresh read of the projection tables, not just
  // the in-memory graph the refresh returned.
  const reloaded = readPeopleProjection(db, { now: NOW });
  const reloadedByName = new Map(reloaded.map((p) => [p.name, p]));
  assert.deepEqual(reloadedByName.get('Jamie Fund')?.subRoles, ['investor']);
  assert.deepEqual(reloadedByName.get('Robin Startup')?.subRoles, ['founder']);
});

test('ensurePeopleProjectionSchema migrates an old-shape people table (pre-dating sub_roles)', () => {
  // The exact people(...) shape that existed before sub-role tags, built by
  // hand rather than via ensurePeopleProjectionSchema itself, so this exercises
  // the migration path an already-deployed DB would actually hit.
  const db = new DatabaseSync(':memory:');
  // PEOPLE_PROJECTION_SCHEMA's triggers fire on the `context` table, so a
  // minimal one has to exist before ensurePeopleProjectionSchema can run --
  // exactly as it always does on a real install.
  db.exec('CREATE TABLE context(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL)');
  db.exec(`
    CREATE TABLE people(
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
      roles_by_year    TEXT NOT NULL,
      linkedin         TEXT,
      built_at         INTEGER NOT NULL
    );
  `);
  db.prepare(
    'INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner, ' +
      'sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year, linkedin, built_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('name:pre existing', 'Pre Existing', NOW, NOW, null, null, 0, 0, 0, 0, 0, 0, 'friend', '{}', null, NOW);

  ensurePeopleProjectionSchema(db);

  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('people')").all().map((row) => row.name));
  assert.ok(columns.has('sub_roles'), 'the migration added the column');

  const row = db.prepare('SELECT sub_roles FROM people WHERE person_key = ?').get('name:pre existing');
  assert.equal(row.sub_roles, '[]', 'the pre-existing row backfills to the empty-array default');

  // readPeopleProjection (the same reader replaceProjection verifies against)
  // parses that backfilled default without throwing.
  const loaded = readPeopleProjection(db, { now: NOW });
  assert.deepEqual(loaded.find((p) => p.key === 'name:pre existing')?.subRoles, []);
});

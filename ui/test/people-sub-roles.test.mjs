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
    // Bare "Principal" is ambiguous without fund-side words, same as "Partner"
    ['Principal', []],
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
    // "principal"/"partner" are weak on their own -- excluded engineering/
    // science titles, and a bare partner+principal combo with no fund-side
    // word anywhere in the title, are not investors
    ['Principal Scientist', []],
    ['Principal Software Engineer', []],
    ['Principal Data Scientist', []],
    ['Principal Consultant', []],
    ['Partner / Principal', []],
    // "investor relations" is a comms function, not an investor, even though
    // it contains the otherwise-unconditional word "investor"
    ['Investor Relations Consultant', []],
    // incubator/accelerator/university staff use founder/venture vocabulary
    // without being check-writers; the exclusion fires off the title itself
    ['Director, Founder and Venture Incubation', ['founder']],
    // A founder whose title is an excluded engineering/science "principal
    // <role>" keeps the founder tag; the investor read is still excluded
    ['Founder & Principal Engineer', ['founder']],
    // Bare "venture" needs a fund-side company or a strong title word; with
    // neither available position-only, it does not resolve to investor
    ['Venture Lead', []],
    // Founder

    ['Founder', ['founder']],
    ['Co-Founder & CEO', ['founder']],
    ['Cofounder', ['founder']],
    ['Owner', ['founder']],
    ['Chief Executive Officer', ['founder']],
    // Founding <role> is not a founder
    ['Founding Engineer', []],
    ['Founding Designer', []],
    // "owner" never counts as a founder word when it's really a delivery
    // title ("Product Owner" and its variants), regardless of company
    ['Product Owner', []],
    ['Technical Product Owner', []],
    ['Business Owner', []],
    ['Process Owner', []],
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

test('subRolesFor: bare "Principal" resolves off fund-side company words, same as "Partner"', () => {
  for (const company of ['Example Capital', 'Example Ventures', 'Example Fund']) {
    const person = { key: 'p:principal', linkedin: { position: 'Principal', company } };
    assert.deepEqual(subRolesFor(person), ['investor'], `company: ${company}`);
  }
});

test('subRolesFor: "Capital" next to a bank-like word is not fund-side', () => {
  // "Capital One", "Capital Markets" and "Capital Bank" are real banks, not
  // funds; a bare "Principal" or "Partner" there should not resolve to
  // investor purely off the word "Capital" in the company name.
  for (const company of ['Example Capital One', 'Example Capital Markets', 'Example Capital Bank', 'Example Bank Capital']) {
    const principal = { key: 'p:bank-principal', linkedin: { position: 'Principal', company } };
    assert.deepEqual(subRolesFor(principal), [], `principal at: ${company}`);
  }

  // The exclusion still wins regardless -- an engineering "principal <role>"
  // at a bank whose name contains "Capital" was never investor-eligible.
  const bankEngineer = { key: 'p:bank-eng', linkedin: { position: 'Principal Software Engineer', company: 'Example Capital Bank' } };
  assert.deepEqual(subRolesFor(bankEngineer), []);

  // A genuine fund word alongside a bank-like "Capital" phrase still counts.
  const fundAndBank = { key: 'p:fund-and-bank', linkedin: { position: 'Principal', company: 'Example Capital One Ventures' } };
  assert.deepEqual(subRolesFor(fundAndBank), ['investor']);
});

test('subRolesFor: "Venture Lead" needs a fund-side company to resolve, and gets one from "Ventures" or an angel platform', () => {
  const noCompany = { key: 'p:venture-lead-1', linkedin: { position: 'Venture Lead', company: 'Example Inc' } };
  assert.deepEqual(subRolesFor(noCompany), []);

  const atVentures = { key: 'p:venture-lead-2', linkedin: { position: 'Venture Lead', company: 'Example Ventures' } };
  assert.deepEqual(subRolesFor(atVentures), ['investor']);

  const atAngelPlatform = { key: 'p:venture-lead-3', linkedin: { position: 'Venture Lead', company: 'Example Angels' } };
  assert.deepEqual(subRolesFor(atAngelPlatform), ['investor']);
});

test('subRolesFor: "Venture Lead" resolves to investor at an investing-platform company like AngelList', () => {
  const person = { key: 'p:venture-lead-platform', linkedin: { position: 'Venture Lead', company: 'AngelList' } };
  assert.deepEqual(subRolesFor(person), ['investor']);
});

test('subRolesFor: an investing-platform company name alone does not make someone an investor', () => {
  const person = { key: 'p:pm-platform', linkedin: { position: 'Product Manager', company: 'AngelList' } };
  assert.deepEqual(subRolesFor(person), []);
});

test('subRolesFor: "Venture Lead" at an unrelated company whose name merely contains "Angeles" is not an investor', () => {
  const person = { key: 'p:venture-lead-la', linkedin: { position: 'Venture Lead', company: 'Los Angeles Housing Department' } };
  assert.deepEqual(subRolesFor(person), []);
});

test('subRolesFor: "Partner" at a company named "... Venture Partners" resolves to investor', () => {
  const person = { key: 'p:venture-partners', linkedin: { position: 'Partner', company: 'Example Venture Partners' } };
  assert.deepEqual(subRolesFor(person), ['investor']);
});

test('subRolesFor: "Partner / Principal" at a strategy-consulting firm is not an investor', () => {
  const person = { key: 'p:consulting', linkedin: { position: 'Partner / Principal', company: 'Example Strategy Consulting' } };
  assert.deepEqual(subRolesFor(person), []);
});

test('subRolesFor: "Investor Relations" is excluded regardless of company', () => {
  const person = { key: 'p:ir', linkedin: { position: 'Investor Relations Consultant', company: 'Example Capital' } };
  assert.deepEqual(subRolesFor(person), []);
});

test('subRolesFor: incubator/accelerator/university staff are not investors, even with venture/founder vocabulary', () => {
  const person = {
    key: 'p:incubator',
    linkedin: { position: 'Director, Founder and Venture Incubation', company: 'Example University Innovation Lab' },
  };
  assert.deepEqual(subRolesFor(person), ['founder']);

  // The exclusion also fires off the company field alone, for a title that
  // doesn't itself say "incubation".
  const staffer = { key: 'p:incubator-2', linkedin: { position: 'Venture Partner', company: 'Example Accelerator' } };
  assert.deepEqual(subRolesFor(staffer), []);
});

test('subRolesFor: a founder who is also a general/managing partner gets both tags regardless of company', () => {
  const person = {
    key: 'p:founder-gp',
    linkedin: { position: 'Co-Founder and Managing Partner', company: 'Example Seed Fund' },
  };
  assert.deepEqual(subRolesFor(person), ['founder', 'investor']);
});

test('subRolesFor: a founder whose title is an engineering "principal <role>" keeps founder but not investor', () => {
  const person = { key: 'p:founder-eng', linkedin: { position: 'Founder & Principal Engineer', company: 'Example Startup' } };
  assert.deepEqual(subRolesFor(person), ['founder']);
});

test('subRolesFor: bare "Investor" is unconditional, regardless of company', () => {
  const person = { key: 'p:investor', linkedin: { position: 'Investor', company: 'Example Inc' } };
  assert.deepEqual(subRolesFor(person), ['investor']);
});

test('subRolesFor: "Product Owner" and its variants are never founder, regardless of company', () => {
  for (const position of ['Product Owner', 'Technical Product Owner', 'Business Owner', 'Process Owner']) {
    const person = { key: 'p:product-owner', linkedin: { position, company: 'Example Enterprises LLC' } };
    assert.deepEqual(subRolesFor(person), [], `position: ${position}`);
  }
});

test('subRolesFor: a bare "Owner" is founder unless the company is a service-provider firm', () => {
  const signStudio = { key: 'p:owner-1', linkedin: { position: 'Owner', company: 'Example Sign Studio' } };
  assert.deepEqual(subRolesFor(signStudio), ['founder']);

  const enterprises = { key: 'p:owner-2', linkedin: { position: 'Owner', company: 'Example Enterprises LLC' } };
  assert.deepEqual(subRolesFor(enterprises), ['founder']);

  const consulting = { key: 'p:owner-3', linkedin: { position: 'Owner', company: 'Example Consulting, LLC' } };
  assert.deepEqual(subRolesFor(consulting), []);

  const realty = { key: 'p:owner-4', linkedin: { position: 'Owner', company: 'Example Realty Group' } };
  assert.deepEqual(subRolesFor(realty), []);
});

test('subRolesFor: a founder-shaped title at a staffing/consulting/recruiting/agency/realty firm is not a founder', () => {
  const consultant = { key: 'p:svc-1', linkedin: { position: 'Founder, Lead Consultant', company: 'Example Consulting, LLC' } };
  assert.deepEqual(subRolesFor(consultant), []);

  const staffing = { key: 'p:svc-2', linkedin: { position: 'Founder & CEO', company: 'Example Talent/Staffing Group' } };
  assert.deepEqual(subRolesFor(staffing), []);

  const recruiting = { key: 'p:svc-3', linkedin: { position: 'Co-Founder', company: 'Example Recruiting Partners' } };
  assert.deepEqual(subRolesFor(recruiting), []);

  const advisory = { key: 'p:svc-4', linkedin: { position: 'Founder', company: 'Example Advisory Services' } };
  assert.deepEqual(subRolesFor(advisory), []);
});

test('subRolesFor: a bare "CEO" at a fund-side company is investor, not founder', () => {
  const ceoAtFund = { key: 'p:ceo-fund', linkedin: { position: 'CEO', company: 'Example Capital' } };
  assert.deepEqual(subRolesFor(ceoAtFund), ['investor']);

  const chiefExecAtFund = { key: 'p:chief-exec-fund', linkedin: { position: 'Chief Executive Officer', company: 'Example Ventures' } };
  assert.deepEqual(subRolesFor(chiefExecAtFund), ['investor']);

  // A regular (non-fund) company keeps the founder read exactly as before.
  const ceoAtStartup = { key: 'p:ceo-startup', linkedin: { position: 'CEO', company: 'Example Startup Inc' } };
  assert.deepEqual(subRolesFor(ceoAtStartup), ['founder']);

  // An explicit "Founder" word alongside "CEO" keeps founder even at a
  // fund-named company -- the redirect only applies to a *bare* ceo/chief
  // executive officer with no founder word of its own.
  const founderCeoAtFund = { key: 'p:founder-ceo-fund', linkedin: { position: 'Founder & CEO', company: 'Example Capital' } };
  assert.deepEqual(subRolesFor(founderCeoAtFund), ['founder']);
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

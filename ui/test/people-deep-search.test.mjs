import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { answerPersonSearch } from '../server/people/search.mjs';
import { detectDeepPeopleQuery } from '../server/people/deepSearch.mjs';

const NOW = new Date(2027, 0, 1, 12).getTime();
const DAY = 86_400_000;

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  const insert = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name] of pairs) insert.run(id, name, id.includes('@') ? 'email' : 'phone', NOW);
  return db;
}

function owner(overrides = {}) {
  return {
    addresses: new Set(['owner@example.test']),
    names: ['Example Owner'],
    keys: new Set(),
    roles: new Map(),
    rolesByYear: new Map(),
    schools: [],
    highSchools: [],
    ...overrides,
  };
}

test('the three requested questions activate deep people search', () => {
  assert.equal(detectDeepPeopleQuery('Find the investors I met in LA about five years ago.', { now: NOW })?.kind, 'investor_place_time');
  assert.equal(detectDeepPeopleQuery('Does anyone from my high school work in tech?', { now: NOW })?.kind, 'school_tech');
  assert.equal(detectDeepPeopleQuery('Who would be down for Italy?', { now: NOW })?.kind, 'travel_interest');
  assert.equal(detectDeepPeopleQuery('what is my sleep average?', { now: NOW }), null);
});

test('Find the investors I met in LA about five years ago', () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['maya@sun.vc', 'Maya Vela'],
    ['nora@bay.vc', 'Nora Bay'],
    ['theo@old.vc', 'Theo Old'],
    ['eli@startup.test', 'Eli Founder'],
  ]);
  insertRows(ctx, [
    { ts: new Date(2019, 0, 1).getTime(), source: 'linkedin', entity_id: 'linkedin:conn:maya', text: 'Maya Vela — Partner', meta: { kind: 'connection', name: 'Maya Vela', position: 'Partner', company: 'Sunset Ventures', email: 'maya@sun.vc' } },
    { ts: new Date(2019, 0, 1).getTime(), source: 'linkedin', entity_id: 'linkedin:conn:nora', text: 'Nora Bay — Partner', meta: { kind: 'connection', name: 'Nora Bay', position: 'Partner', company: 'Bay Capital', email: 'nora@bay.vc' } },
    { ts: new Date(2018, 0, 1).getTime(), source: 'linkedin', entity_id: 'linkedin:conn:theo', text: 'Theo Old — Angel Investor', meta: { kind: 'connection', name: 'Theo Old', position: 'Angel Investor', company: 'Old Fund', email: 'theo@old.vc' } },
    { ts: new Date(2019, 0, 1).getTime(), source: 'linkedin', entity_id: 'linkedin:conn:eli', text: 'Eli Founder — CEO', meta: { kind: 'connection', name: 'Eli Founder', position: 'CEO', company: 'Startup', email: 'eli@startup.test' } },
    // The only candidate satisfying investor AND physical LA meeting AND time.
    { ts: new Date(2022, 5, 10).getTime(), source: 'calendar', entity_id: 'calendar:maya', text: 'Seed dinner', meta: { location: 'Los Angeles, CA', attendees: [{ email: 'maya@sun.vc', name: 'Maya Vela' }] } },
    // Right role and time, wrong place.
    { ts: new Date(2022, 5, 10).getTime(), source: 'calendar', entity_id: 'calendar:nora', text: 'Fund meeting', meta: { location: 'San Francisco, CA', attendees: [{ email: 'nora@bay.vc', name: 'Nora Bay' }] } },
    // Right role and place, wrong time.
    { ts: new Date(2020, 0, 10).getTime(), source: 'calendar', entity_id: 'calendar:theo', text: 'Coffee', meta: { location: 'LA, CA', attendees: [{ email: 'theo@old.vc', name: 'Theo Old' }] } },
    // Right place and time, not an investor.
    { ts: new Date(2022, 5, 10).getTime(), source: 'calendar', entity_id: 'calendar:eli', text: 'Founder meetup', meta: { location: 'Los Angeles', attendees: [{ email: 'eli@startup.test', name: 'Eli Founder' }] } },
  ]);

  const out = answerPersonSearch(ctx, spine, 'Find the investors I met in LA about five years ago.', { owner: owner(), now: NOW });
  assert.ok(out);
  assert.equal(out.count, 1);
  assert.match(out.text, /Maya Vela/u);
  assert.match(out.text, /Los Angeles/u);
  assert.match(out.text, /Jun 2022/u);
  assert.doesNotMatch(out.text, /Nora Bay|Theo Old|Eli Founder/u);
});

test('Does anyone from my high school work in tech?', () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['+15550000001', 'Casey Lin'], ['casey@acme.test', 'Casey Lin'],
    ['+15550000002', 'Alex Reed'], ['alex@books.test', 'Alex Reed'],
    ['+15550000003', 'Dana Tech'], ['dana@cloud.test', 'Dana Tech'],
  ]);
  insertRows(ctx, [
    { ts: NOW - 100 * DAY, source: 'imessage', entity_id: 'msg:casey-school', text: 'We both went to Lincoln High School, class of 2014.', meta: { chat_handle: '+15550000001', is_from_me: false } },
    { ts: NOW - 200 * DAY, source: 'linkedin', entity_id: 'linkedin:conn:casey', text: 'Casey Lin — Software Engineer', meta: { kind: 'connection', name: 'Casey Lin', email: 'casey@acme.test', position: 'Software Engineer', company: 'Acme Cloud' } },
    // Same school, but no current tech job.
    { ts: NOW - 100 * DAY, source: 'imessage', entity_id: 'msg:alex-school', text: 'I graduated from Lincoln High School too.', meta: { chat_handle: '+15550000002', is_from_me: false } },
    { ts: NOW - 200 * DAY, source: 'linkedin', entity_id: 'linkedin:conn:alex', text: 'Alex Reed — Accountant', meta: { kind: 'connection', name: 'Alex Reed', email: 'alex@books.test', position: 'Accountant', company: 'Books LLP' } },
    // Current tech job, but no shared-school evidence.
    { ts: NOW - 200 * DAY, source: 'linkedin', entity_id: 'linkedin:conn:dana', text: 'Dana Tech — Product Manager', meta: { kind: 'connection', name: 'Dana Tech', email: 'dana@cloud.test', position: 'Product Manager', company: 'Cloud Systems' } },
  ]);

  const schoolOwner = owner({ schools: ['Lincoln High School'], highSchools: ['Lincoln High School'] });
  const out = answerPersonSearch(ctx, spine, 'Does anyone from my high school work in tech?', { owner: schoolOwner, now: NOW });
  assert.ok(out);
  assert.equal(out.count, 1);
  assert.match(out.text, /Casey Lin/u);
  assert.match(out.text, /Software Engineer at Acme Cloud/u);
  assert.match(out.text, /Lincoln High School/u);
  assert.doesNotMatch(out.text, /Alex Reed|Dana Tech/u);
});

test('Who would be down for Italy?', () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['+15550000011', 'Jordan Kim'],
    ['+15550000012', 'Taylor Moss'],
    ['+15550000013', 'Morgan Lee'],
  ]);
  insertRows(ctx, [
    { ts: NOW - 40 * DAY, source: 'imessage', entity_id: 'msg:jordan', text: "I'd love to go to Italy this summer.", meta: { chat_handle: '+15550000011', is_from_me: false } },
    // A generic mention is not intent.
    { ts: NOW - 20 * DAY, source: 'imessage', entity_id: 'msg:taylor', text: 'Italy has a fascinating history.', meta: { chat_handle: '+15550000012', is_from_me: false } },
    // A later negative overrides an older positive.
    { ts: NOW - 200 * DAY, source: 'imessage', entity_id: 'msg:morgan-yes', text: "I'm down for Italy someday.", meta: { chat_handle: '+15550000013', is_from_me: false } },
    { ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'msg:morgan-no', text: "I can't go to Italy this year.", meta: { chat_handle: '+15550000013', is_from_me: false } },
    // The owner's own enthusiasm must not be attributed to the counterparty.
    { ts: NOW - 5 * DAY, source: 'imessage', entity_id: 'msg:taylor-owner', text: "I'd love to go to Italy.", meta: { chat_handle: '+15550000012', is_from_me: true } },
  ]);

  const out = answerPersonSearch(ctx, spine, 'Who would be down for Italy?', { owner: owner(), now: NOW });
  assert.ok(out);
  assert.equal(out.count, 1);
  assert.match(out.text, /Jordan Kim/u);
  assert.match(out.text, /likely interested/u);
  assert.match(out.text, /not a commitment/u);
  assert.doesNotMatch(out.text, /Taylor Moss|Morgan Lee/u);
});

test('my high school fails honestly when the owner profile has no school', () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([]);
  const out = answerPersonSearch(ctx, spine, 'Does anyone from my high school work in tech?', { owner: owner(), now: NOW });
  assert.equal(out.count, 0);
  assert.match(out.text, /don't know which high school/u);
});

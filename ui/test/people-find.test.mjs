// Finding a person. Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreMatch, rankPeople, rankAcrossYears, MATCH } from '../server/people/find.mjs';

const person = (key, name, over = {}) => ({
  key,
  name,
  messages: 100,
  identifiers: [],
  topics: [],
  ...over,
});

const ROWAN = person('name:rowan vance', 'Rowan Vance', { messages: 1200 });
const IMOGEN = person('name:imogen sale', 'Imogen Sale', { messages: 640 });
const STRANGER = person('id:+15550100', '+15550100', {
  messages: 4,
  identifiers: ['+15550100'],
});

test('a name matches by prefix, by word, and anywhere — in that order', () => {
  assert.equal(scoreMatch(ROWAN, 'Rowan Vance').score, MATCH.exactName);
  assert.equal(scoreMatch(ROWAN, 'row').score, MATCH.namePrefix);
  // How people actually look for a surname.
  assert.equal(scoreMatch(ROWAN, 'vance').score, MATCH.nameWord);
  assert.equal(scoreMatch(ROWAN, 'owan').score, MATCH.nameAnywhere);
  assert.equal(scoreMatch(ROWAN, 'zzz'), null, 'no match is null, not a zero');
});

// A bare includes() would match "vance" inside "Advance". Word starts are the
// difference between a search and a substring.
test('a word start is not the same as a substring', () => {
  const other = person('name:advance planning', 'Advance Planning');
  assert.equal(scoreMatch(other, 'vance').score, MATCH.nameAnywhere, 'still findable, but ranked below');
  assert.ok(scoreMatch(ROWAN, 'vance').score > scoreMatch(other, 'vance').score);
});

test('the handle is searchable, because it is often all you remember', () => {
  // A NAMED person searched by their number -- the real case. (An unnamed one
  // whose label IS their number matches as a name first, which is correct:
  // the thing on screen is what was typed.)
  const named = person('name:imogen sale', 'Imogen Sale', { identifiers: ['+15550100'] });
  const hit = scoreMatch(named, '5550100');
  assert.equal(hit.field, 'identifier');
  assert.equal(hit.score, MATCH.identifier);
  assert.equal(scoreMatch(STRANGER, '5550100').field, 'name', 'their label is the number');
});

// You can be reminded of a chip, but you typed a name box.
test('a topic matches, and never outranks a person', () => {
  const p = person('name:bella pivo', 'Bella Pivo', { topics: ['fundraising', 'recs'] });
  assert.equal(scoreMatch(p, 'fundraising').field, 'topic');
  const named = person('name:fundraising fred', 'Fundraising Fred');
  const ranked = rankPeople([p, named], 'fundraising');
  assert.equal(ranked[0].name, 'Fundraising Fred', 'the name wins over the chip');
});

test('accents and case do not hide a person', () => {
  const jose = person('name:jose ruiz', 'José Ruiz');
  assert.ok(scoreMatch(jose, 'jose'));
  assert.ok(scoreMatch(jose, 'JOSÉ'));
});

// Relationship weight breaks ties and ONLY ties: it can never lift a weaker
// match above a stronger one.
test('who you actually talk to breaks a tie', () => {
  const quiet = person('name:rowan quiet', 'Rowan Quiet', { messages: 2 });
  const ranked = rankPeople([quiet, ROWAN], 'rowan');
  assert.equal(ranked[0].name, 'Rowan Vance', 'same match quality, more history');
});

test('a busy stranger never outranks a real name match', () => {
  const busy = person('name:someone else', 'Someone Else', {
    messages: 500000,
    topics: ['rowan'],
  });
  const ranked = rankPeople([busy, ROWAN], 'rowan');
  assert.equal(ranked[0].name, 'Rowan Vance', 'a topic hit cannot beat a name, at any volume');
});

test('an empty query matches nobody rather than everybody', () => {
  assert.equal(scoreMatch(ROWAN, ''), null);
  assert.equal(scoreMatch(ROWAN, '   '), null);
  assert.deepEqual(rankPeople([ROWAN, IMOGEN], ''), []);
});

test('junk in the list does not take the search down', () => {
  assert.deepEqual(rankPeople(null, 'rowan'), []);
  const ranked = rankPeople([null, ROWAN, 'nope', undefined], 'rowan');
  assert.equal(ranked.length, 1);
});

// The reason this moved to the server: the answer must not depend on which tab
// is open.
test('searching crosses years and returns a person once, at their best', () => {
  const byYear = {
    2021: [person('name:rowan vance', 'Rowan Vance', { messages: 50 })],
    2026: [person('name:rowan vance', 'Rowan Vance', { messages: 1200 }), IMOGEN],
  };
  const out = rankAcrossYears(byYear, 'rowan');
  assert.equal(out.length, 1, 'one Rowan, not one per year');
  assert.equal(out[0].year, 2026, 'shown at the year he actually matters');
});

test('a person found only in an old year is still found', () => {
  const byYear = {
    2019: [person('name:old friend', 'Old Friend', { messages: 300 })],
    2026: [ROWAN],
  };
  const out = rankAcrossYears(byYear, 'old friend');
  assert.equal(out[0].name, 'Old Friend');
  assert.equal(out[0].year, 2019, 'and the result says which tab to open');
});

test('the result set is bounded', () => {
  const many = Array.from({ length: 300 }, (_, i) => person(`k${i}`, `Rowan ${i}`));
  assert.equal(rankPeople(many, 'rowan', { limit: 25 }).length, 25);
});

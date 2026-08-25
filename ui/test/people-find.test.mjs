// Finding a person. Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreMatch, rankPeople, rankAcrossYears, editDistance, MATCH } from '../server/people/find.mjs';

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

// ---- a name you nearly typed ----
test('edit distance counts a transposition once, and gives up early', () => {
  assert.equal(editDistance('kitten', 'sitting', 3), 3);
  // The commonest typo of all. Plain Levenshtein calls this 2 and puts it
  // outside a one-edit budget, which is why this is the Damerau variant.
  assert.equal(editDistance('rowna', 'rowan', 1), 1);
  assert.equal(editDistance('abc', 'abc', 1), 0);
  assert.ok(editDistance('abc', 'xyzzy', 1) > 1, 'gives up rather than computing a big answer');
});

test('a typo still finds the person', () => {
  const p = person('name:rowan vance', 'Rowan Vance');
  assert.equal(scoreMatch(p, 'rowna').field, 'fuzzy', 'transposed');
  assert.equal(scoreMatch(p, 'rowen').field, 'fuzzy', 'misspelled');
  assert.equal(scoreMatch(p, 'vanse').field, 'fuzzy', 'the surname too');
});

// Fuzzy is the tier most able to turn a search into a shrug, so the limits are
// pinned as hard as the behaviour.
test('fuzzy never fires on a query too short to mean anything', () => {
  const rob = person('name:rob nash', 'Rob Nash');
  assert.equal(scoreMatch(rob, 'ron'), null, 'three letters, one edit — that is not a search');
  assert.equal(scoreMatch(rob, 'rod'), null);
});

test('an exact reading of the name always beats a fuzzy one', () => {
  const exact = person('name:vance hill', 'Vance Hill');
  const typo = person('name:vanse holt', 'Vanse Holt', { messages: 99999 });
  const ranked = rankPeople([typo, exact], 'vance');
  assert.equal(ranked[0].name, 'Vance Hill', 'volume cannot lift a typo over a real match');
});

// ---- who you actually talked to about it ----
const stat = (messages, conversations) => new Map([['name:rowan vance|2025', { messages, conversations }]]);

test('a person is found by what you talked about, not just their name', () => {
  const p = person('name:rowan vance', 'Rowan Vance');
  assert.equal(scoreMatch(p, 'pickleball', { messages: 12, conversations: 4 }).field, 'content');
  assert.equal(scoreMatch(p, 'pickleball', { messages: 0, conversations: 0 }), null, 'no evidence is not a match');
  assert.equal(scoreMatch(p, 'pickleball', null), null);
});

// The exact thing find.mjs's header warned about when it argued against bm25.
test('typing a name is never outranked by someone who merely said that word', () => {
  const named = person('name:rowan vance', 'Rowan Vance', { messages: 5 });
  const talker = person('name:someone else', 'Someone Else', { messages: 90000 });
  const content = new Map([['name:someone else|2025', { messages: 400, conversations: 90 }]]);
  const ranked = rankPeople([talker, named], 'rowan', { content, year: 2025 });
  assert.equal(ranked[0].name, 'Rowan Vance');
});

test('content is ranked by conversations, not by message count', () => {
  const a = person('name:a burst', 'A Burst');
  const b = person('name:b spread', 'B Spread');
  const content = new Map([
    ['name:a burst|2025', { messages: 60, conversations: 1 }],  // one long thread
    ['name:b spread|2025', { messages: 12, conversations: 6 }], // a running subject
  ]);
  const ranked = rankPeople([a, b], 'pickleball', { content, year: 2025 });
  assert.equal(ranked[0].name, 'B Spread', 'six conversations beat one long thread');
});

test('messages break a tie inside an equal number of conversations', () => {
  const a = person('name:a one', 'A One');
  const b = person('name:b three', 'B Three');
  const content = new Map([
    ['name:a one|2025', { messages: 1, conversations: 1 }],
    ['name:b three|2025', { messages: 9, conversations: 1 }],
  ]);
  const ranked = rankPeople([a, b], 'tahoe', { content, year: 2025 });
  assert.equal(ranked[0].name, 'B Three', 'alphabetical order is not a ranking');
});

test('a subject lands on the year it was discussed, not the busiest year', () => {
  const byYear = {
    2021: [person('name:rowan vance', 'Rowan Vance', { messages: 8000 })], // the loud year
    2025: [person('name:rowan vance', 'Rowan Vance', { messages: 30 })],
  };
  const content = new Map([['name:rowan vance|2025', { messages: 14, conversations: 5 }]]);
  const out = rankAcrossYears(byYear, 'pickleball', { content });
  assert.equal(out.length, 1);
  assert.equal(out[0].year, 2025, 'the year the subject actually happened');
  assert.deepEqual(out[0].evidence, { messages: 14, conversations: 5, excerpt: null });
});

test('a row carries the evidence for what it claims', () => {
  const p = person('name:rowan vance', 'Rowan Vance');
  const [hit] = rankPeople([p], 'pickleball', { content: stat(12, 4), year: 2025 });
  assert.equal(hit.matchField, 'content');
  assert.deepEqual(hit.evidence, { messages: 12, conversations: 4, excerpt: null });
  // A name match has nothing to count, and must not invent something to show.
  const [byName] = rankPeople([p], 'rowan', { content: stat(12, 4), year: 2025 });
  assert.equal(byName.matchField, 'name');
});

// Tests for the corpus half of person search (people/content.mjs). Every
// fixture invented; the repo is public. The assertions pin counts and the two
// things that must never happen: text coming out, and an FTS operator in the
// query being treated as syntax.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows } from '../server/hermes.mjs';
import { contentMatches, ftsQuery, rowPersonId } from '../server/people/content.mjs';

const NOW = new Date(2025, 5, 1).getTime();
const DAY = 86_400_000;
const HANDLE = '+15550100';
const KEY = 'name:rowan vance';
const idToKey = new Map([[HANDLE, KEY]]);

const msg = (ts, text, over = {}) => ({
  ts, source: 'imessage', entity_id: `i:${ts}:${text.length}`, text,
  meta: { chat_handle: HANDLE, chat_guid: 'chat-1', is_from_me: false, ...over },
});

test('a query is data, never FTS syntax', () => {
  assert.equal(ftsQuery(''), null);
  assert.equal(ftsQuery('   '), null);
  // Bare, these would be operators or a syntax error inside MATCH.
  for (const q of ['AND', 'OR', 'NEAR', 'a*', '"', '(x', 'foo OR bar']) {
    const built = ftsQuery(q);
    if (built === null) continue;
    assert.ok(!/(^|\s)(AND|OR|NEAR)(\s|$)/u.test(built.replace(/"[^"]*"/gu, '')) || built.includes('"'),
      `every term must be quoted: ${built}`);
  }
  assert.equal(ftsQuery('pickleball'), '"pickleball" OR "pickleball"*');
  assert.equal(ftsQuery('farmers market'), '"farmers" AND "market"');
});

test('a single word matches by prefix, so half a word still finds it', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [msg(NOW, 'pickleball on saturday?')]);
  assert.equal(contentMatches(ctx, idToKey, 'pickle').stats.get(`${KEY}|2025`)?.messages, 1);
});

test('counts are per person AND per year', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    msg(new Date(2024, 1, 1).getTime(), 'pickleball again'),
    msg(NOW, 'pickleball today'),
    msg(NOW + DAY, 'more pickleball'),
  ]);
  const { stats } = contentMatches(ctx, idToKey, 'pickleball');
  assert.equal(stats.get(`${KEY}|2024`).messages, 1);
  assert.equal(stats.get(`${KEY}|2025`).messages, 2);
});

// The reason the ranking can lean on conversations at all.
test('one day of back-and-forth is one conversation, not six messages', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, Array.from({ length: 6 }, (_, i) =>
    msg(NOW + i * 60_000, `pickleball ${i}`)));
  const s = contentMatches(ctx, idToKey, 'pickleball').stats.get(`${KEY}|2025`);
  assert.equal(s.messages, 6);
  assert.equal(s.conversations, 1, 'a burst in one thread on one day is one conversation');
});

test('the same subject on separate days is separate conversations', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, Array.from({ length: 4 }, (_, i) =>
    msg(NOW + i * DAY, `pickleball week ${i}`)));
  const s = contentMatches(ctx, idToKey, 'pickleball').stats.get(`${KEY}|2025`);
  assert.equal(s.conversations, 4, 'a running subject, not one long thread');
});

test('a person outside the graph is not invented from a corpus hit', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [{ ...msg(NOW, 'pickleball'), meta: { chat_handle: '+15559999', is_from_me: false } }]);
  assert.equal(contentMatches(ctx, idToKey, 'pickleball').stats.size, 0);
});

test('nothing but numbers comes out', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [msg(NOW, 'pickleball at the secret address on maple street')]);
  const stat = contentMatches(ctx, idToKey, 'pickleball').stats.get(`${KEY}|2025`);
  assert.deepEqual(Object.keys(stat).sort(), ['conversations', 'messages']);
  assert.ok(!JSON.stringify(stat).includes('maple'), 'no text, ever');
});

test('a corpus with no FTS index degrades to contributing nothing', () => {
  const ctx = openDb(':memory:');
  ctx.exec('DROP TABLE context_fts');
  const out = contentMatches(ctx, idToKey, 'pickleball');
  assert.equal(out.stats.size, 0, 'content is one tier of four, not the whole query');
});

test('the row cap is reported rather than silently truncating', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, Array.from({ length: 12 }, (_, i) => msg(NOW + i * DAY, `pickleball ${i}`)));
  const out = contentMatches(ctx, idToKey, 'pickleball', { maxRows: 5 });
  assert.equal(out.capped, true);
  assert.equal(out.stats.get(`${KEY}|2025`).messages, 5);
});

// Attribution has to agree with the graph, or a hit credits the wrong person.
test('a one-to-one thread credits the counterparty in both directions', () => {
  assert.equal(rowPersonId({ source: 'imessage' }, { chat_handle: HANDLE, is_from_me: true }), HANDLE);
  assert.equal(rowPersonId({ source: 'imessage' }, { chat_handle: HANDLE, is_from_me: false }), HANDLE);
});

test('a group message credits its sender, and the owner speaks for nobody', () => {
  assert.equal(
    rowPersonId({ source: 'whatsapp' }, { is_group: true, sender_handle: '99@lid', is_from_me: false }),
    '99@lid'
  );
  assert.equal(
    rowPersonId({ source: 'whatsapp' }, { is_group: true, sender_handle: '99@lid', is_from_me: true }),
    null,
    'the owner in a group has no single counterparty'
  );
});

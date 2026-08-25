// Tests for the corpus half of person search (people/content.mjs). Every
// fixture invented; the repo is public. The assertions pin the counts, the
// bounds on the one excerpt a result may carry, and that an FTS operator in the
// query is treated as data rather than syntax.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows } from '../server/hermes.mjs';
import { contentMatches, ftsQuery, rowPersonId, trimExcerpt } from '../server/people/content.mjs';

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

// ---- the excerpt, and the bounds that make it safe to have ----
//
// The "counts only" rule was widened deliberately (owner, 2026-08-25) so a
// search result can show the line that put somebody in the list. These pin what
// the widening did NOT include.
test('one excerpt per person, from a row that matched, and never a transcript', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    msg(NOW, 'pickleball on saturday'),
    msg(NOW + 1000, 'pickleball again on sunday'),
    msg(NOW + 2000, 'unrelated chatter that matched nothing'),
  ]);
  const stat = contentMatches(ctx, idToKey, 'pickleball').stats.get(`${KEY}|2025`);
  assert.equal(stat.messages, 2, 'the non-matching row is not evidence');
  assert.equal(typeof stat.excerpt.text, 'string');
  assert.ok(stat.excerpt.text.includes('sunday'), 'the most recent match wins');
  assert.ok(!stat.excerpt.text.includes('unrelated'), 'only rows that matched');
  assert.deepEqual(Object.keys(stat.excerpt).sort(), ['fromMe', 'text', 'ts']);
});

test('an excerpt is capped however long the message is', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [msg(NOW, `pickleball ${'verylongword '.repeat(80)}`)]);
  const stat = contentMatches(ctx, idToKey, 'pickleball').stats.get(`${KEY}|2025`);
  assert.ok(stat.excerpt.text.length <= 140, `capped, got ${stat.excerpt.text.length}`);
});

test('an excerpt is one line — a message cannot bring its own layout', () => {
  assert.equal(trimExcerpt('hello\n\n   there\tfriend'), 'hello there friend');
});

test('a link is not a sentence', () => {
  // The first live run gave somebody an excerpt that was a bare event URL.
  assert.equal(trimExcerpt('https://example.com/e/a-very-long-event-slug'), null);
  assert.equal(trimExcerpt('come to (link) https://example.com/x on saturday'),
    'come to (link) (link) on saturday');
  assert.equal(trimExcerpt('  '), null);
  assert.equal(trimExcerpt(null), null);
});

test('an address is contact details, not the sentence', () => {
  assert.equal(trimExcerpt('mail rowan@example.com about saturday'), 'mail about saturday');
});

test('a person whose newest match is a bare link still gets a real line', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    msg(NOW, 'pickleball at the park on saturday'),
    msg(NOW + 1000, 'https://example.com/pickleball-signup-page'),
  ]);
  const stat = contentMatches(ctx, idToKey, 'pickleball').stats.get(`${KEY}|2025`);
  assert.ok(stat.excerpt.text.includes('park'), 'skipped past the link to the sentence');
});

test('who said it is recorded, because it changes what the line means', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [msg(NOW, 'pickleball on saturday', { is_from_me: true })]);
  assert.equal(contentMatches(ctx, idToKey, 'pickleball').stats.get(`${KEY}|2025`).excerpt.fromMe, true);
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

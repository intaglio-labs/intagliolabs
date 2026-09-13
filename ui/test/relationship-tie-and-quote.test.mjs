// The card's own words, after the owner-facing surface review (section B
// findings 5 and 6, section C finding 29). Every test here is a fixture
// where the old behaviour and the new one disagree on the same input:
//
//   B5   the tie sentence printed the owner's MODE ("Quiet 634 days ·
//        investor · ...") as though it were a fact about the person, while
//        the card's own role row two lines below said "friend". Fixture: a
//        founder-mode batch whose sentence must not contain "founder".
//   B6   "0 meetings" and "1 meetings", both seen live. Fixture: candidates
//        with 0, 1 and 3 meetings, one exact sentence each.
//   C29  the quote was the newest authored row with no substance test at
//        all, so run 3 shipped a card quoting "Heyo 100%!". Fixture: their
//        NEWEST message is an acknowledgement and an older one is real --
//        the old code quotes the ack, the new one quotes the older row.
//        Second fixture: nothing they ever wrote qualifies, so no quote at
//        all, which the page hides.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/hermes.mjs';
import { produceBatch, substantiveQuoteContextId, isSubstantiveQuote } from '../server/relationship/producer.mjs';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const isoDay = (offsetDays) => new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);

function insertPerson(db, { key, name, role = 'friend', subRoles = [], sent, received, met = 0,
  linkedin = null, lastFromThem = NOW - 200 * DAY, lastFromOwner = NOW - 210 * DAY, lastSeen = NOW - 200 * DAY }) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, NOW - 400 * DAY, lastSeen, lastFromThem, lastFromOwner,
    sent, received, met, 0, sent + received, 0, role, '{}',
    linkedin === null ? null : JSON.stringify(linkedin), NOW, JSON.stringify(subRoles));
}

function insertAuthored(db, key, { ts, text, room = 0 } = {}) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, '{}')"
  ).run(ts, text).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, ?, 1, 'conv')`
  ).run(key, ctxId, room ? 1 : 0);
  return ctxId;
}

function insertActiveDay(db, key, day) {
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, day);
}

// A quiet, reconnect-eligible person: two-way history past the depth floor,
// a direct authored row, and 200 days of silence.
function seedEligible(db, key, name, opts = {}) {
  insertPerson(db, { key, name, sent: 20, received: 20, ...opts });
  insertAuthored(db, key, { ts: NOW - 200 * DAY, text: opts.text ?? 'the deck is ready whenever you want to look' });
  insertActiveDay(db, key, isoDay(200));
}

function freshDb() {
  const db = openDb(':memory:');
  try { db.exec('ALTER TABLE people ADD COLUMN sub_roles TEXT'); } catch {}
  return db;
}

// --- B5 / B6: the tie sentence -------------------------------------------

test('the tie sentence states facts about the person, never the owner\'s mode', () => {
  const db = freshDb();
  seedEligible(db, 'name:mode free', 'Mode Free', { subRoles: ['founder'] });

  const { cards } = produceBatch(db, { mode: 'founder', now: NOW, limit: 5 });
  assert.equal(cards.length, 1);
  assert.ok(!cards[0].sentence.includes('founder'), `mode leaked into: ${cards[0].sentence}`);
  assert.equal(cards[0].evidence.mode, 'founder', 'the mode still travels in evidence');
});

test('counts are pluralised, and a zero count is left out rather than announced', () => {
  const db = freshDb();
  seedEligible(db, 'name:zero meetings', 'Zero Meetings', { sent: 11, received: 10, met: 0 });
  seedEligible(db, 'name:one meeting', 'One Meeting', { sent: 11, received: 10, met: 1 });
  seedEligible(db, 'name:three meetings', 'Three Meetings', { sent: 11, received: 10, met: 3 });
  seedEligible(db, 'name:one message', 'One Message', { sent: 1, received: 0, met: 2 });

  const byName = new Map(produceBatch(db, { mode: 'any', now: NOW, limit: 10 }).cards
    .map((c) => [c.name, c.sentence]));

  assert.equal(byName.get('Zero Meetings'), 'Quiet 200 days · you two have 21 messages');
  assert.equal(byName.get('One Meeting'), 'Quiet 200 days · you two have 21 messages and 1 meeting');
  assert.equal(byName.get('Three Meetings'), 'Quiet 200 days · you two have 21 messages and 3 meetings');
  assert.equal(byName.get('One Message'), 'Quiet 200 days · you two have 1 message and 2 meetings');
});

// --- C29: the quote floor -------------------------------------------------

test('a bare acknowledgement is never the quote when something older has substance', () => {
  const db = freshDb();
  const key = 'name:heyo';
  insertPerson(db, { key, name: 'Heyo Person', sent: 20, received: 20 });
  insertActiveDay(db, key, isoDay(200));

  const real = insertAuthored(db, key, {
    ts: NOW - 240 * DAY, text: 'i finally shipped the thing we talked about in march',
  });
  // Newer, and worthless: the exact card run 3 shipped, plus the emoji and
  // url-only lines that sit between real messages in a real thread.
  const ack = insertAuthored(db, key, { ts: NOW - 230 * DAY, text: 'Heyo 100%!' });
  insertAuthored(db, key, { ts: NOW - 220 * DAY, text: '👍👍👍👍👍👍👍👍👍👍👍👍👍' });
  insertAuthored(db, key, { ts: NOW - 210 * DAY, text: 'https://example.com/a/rather/long/article/path' });
  insertAuthored(db, key, { ts: NOW - 200 * DAY, text: 'ok ok thanks thanks haha 👍' });

  assert.equal(substantiveQuoteContextId(db, key), real,
    'the newest row WITH substance, not the newest row');
  assert.notEqual(substantiveQuoteContextId(db, key), ack);

  const { cards } = produceBatch(db, { mode: 'any', now: NOW, limit: 5 });
  assert.equal(cards[0].quoteContextId, real);
});

test('when nothing they wrote has substance, the card carries no quote at all', () => {
  const db = freshDb();
  const key = 'name:all acks';
  insertPerson(db, { key, name: 'All Acks', sent: 20, received: 20 });
  insertActiveDay(db, key, isoDay(200));
  for (const [i, text] of ['ok', 'thanks!', 'lol', 'sounds good', 'Heyo 100%!'].entries()) {
    insertAuthored(db, key, { ts: NOW - (250 - i) * DAY, text });
  }

  assert.equal(substantiveQuoteContextId(db, key), null);
  const { cards } = produceBatch(db, { mode: 'any', now: NOW, limit: 5 });
  assert.equal(cards.length, 1, 'the person is still a candidate; only the quote is missing');
  assert.equal(cards[0].quoteContextId, null);
});

test('the lookback is bounded: a real message further back than N authored rows is not reached', () => {
  const db = freshDb();
  const key = 'name:deep';
  insertPerson(db, { key, name: 'Deep Person', sent: 20, received: 20 });
  insertActiveDay(db, key, isoDay(200));
  const buried = insertAuthored(db, key, { ts: NOW - 300 * DAY, text: 'here is the actual substance of this thread' });
  for (let i = 0; i < 14; i += 1) {
    insertAuthored(db, key, { ts: NOW - (290 - i) * DAY, text: 'ok' });
  }
  assert.equal(substantiveQuoteContextId(db, key), null, '12 acks deep is a dead thread');
  assert.equal(substantiveQuoteContextId(db, key, { lookback: 40 }), buried, 'and the bound is the only reason');
});

test('the substance test: words, emoji, urls, acknowledgements', () => {
  assert.equal(isSubstantiveQuote('Heyo 100%!'), false, 'the run-3 quote: two words');
  assert.equal(isSubstantiveQuote('ok'), false);
  assert.equal(isSubstantiveQuote('   short   '), false, 'trimmed before measuring');
  assert.equal(isSubstantiveQuote('👍👍👍👍👍👍👍👍👍👍👍👍👍👍'), false, 'long enough, says nothing');
  assert.equal(isSubstantiveQuote('!!!!!!!!!!!!!!!!!!!!!!!!!!!!'), false);
  assert.equal(isSubstantiveQuote('https://example.com/a/very/long/path/indeed'), false, 'a url is not a quote');
  assert.equal(isSubstantiveQuote('THANKS SO MUCH, GOT IT!!!! haha'), false, 'case does not rescue an ack');
  assert.equal(isSubstantiveQuote('got it sounds good'), false);
  assert.equal(isSubstantiveQuote(null), false);
  assert.equal(isSubstantiveQuote('sounds good, i will send the deck friday'), true,
    'an ack word beside real content is real content');
  assert.equal(isSubstantiveQuote('congrats on the raise — see https://x.example'), true);
});

// THE FLOOR IS WORDS, NOT CHARACTERS (polish review finding 13). It was 24
// characters, which threw away ordinary short messages -- better cards than
// no card -- before the acknowledgement test they would have passed.
test('an ordinary short line is quotable; the floor counts words, not characters', () => {
  assert.equal(isSubstantiveQuote('Can you send the deck?'), true, '22 characters, and a real ask');
  assert.equal(isSubstantiveQuote("yes, let's do tuesday"), true, '21 characters, and a real answer');

  // What the floor is actually for: too few words to say anything, however
  // the characters are arranged.
  assert.equal(isSubstantiveQuote('congratulations!!!'), false, 'one word is not a quote');
  assert.equal(isSubstantiveQuote('absolutely enormous'), false, 'two words either');
  assert.equal(isSubstantiveQuote('a b c'), false, 'three tokens, nothing said');
});

// THE ACK LIST IS NOT A LIST OF BANNED WORDS (polish review finding 14).
// Several entries -- got, it, sounds, good, done, right -- are ordinary
// content words. The rule has always required EVERY word to be a listed one,
// so an ack word beside content was never rejected; what was unbounded is a
// message of ANY length built solely from listed words.
test('an ack word beside real content is content, at any length', () => {
  assert.equal(isSubstantiveQuote('i got it done, and it is really very good'), true);
  assert.equal(isSubstantiveQuote('thanks, that is really good news about the round'), true);
  assert.equal(isSubstantiveQuote('sounds good, i will send the deck friday'), true);
});

// The bound is on DISTINCT words, not on the word count: repetition does not
// make a message. Eight words and five ideas, all of them "yes", is still an
// acknowledgement -- a plain count of six would have let it through and a
// card would have quoted it.
test('the acknowledgement rule is bounded by how much is said, not how long it is', () => {
  assert.equal(isSubstantiveQuote('ok ok thanks thanks haha haha sure sure'), false,
    'eight words, five of them repeats');
  assert.equal(isSubstantiveQuote('yeah sure sounds good'), false);

  // Past the bound the rule lets go, which is the narrowing: seven different
  // acknowledgements in a row is somebody saying something, and the list is
  // not there to decide that it is not.
  assert.equal(isSubstantiveQuote('sounds good got it done thanks so much'), true,
    'seven distinct words is past where a word list gets to judge');
});


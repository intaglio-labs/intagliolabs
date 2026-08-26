// Tests for the people graph: resolution across channels and the arithmetic
// (counts, reciprocity, dormancy) that must be code's job, not a model's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { buildGraph } from '../server/people/graph.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const DAY = 86_400_000;

// A minimal spine: identifier -> display_name, the shape of contact_ids.
function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name, kind] of pairs) ins.run(id, name, kind ?? 'phone', NOW);
  return db;
}

test('the spine merges a phone and an email into one person', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'i:1', text: 'yo', meta: { chat_handle: '+18085550100', is_from_me: false } },
    { ts: NOW - 5 * DAY, source: 'mail', entity_id: 'm:1', text: 'hi', meta: { from: ['sam@work.com'], to: ['ay@austinyoshino.com'] } },
  ]);
  const spine = spineDb([['+18085550100', 'Sam Lee', 'phone'], ['sam@work.com', 'Sam Lee', 'email']]);
  const graph = buildGraph(ctx, spine, { now: NOW });
  const sam = graph.find((p) => p.name === 'Sam Lee');
  assert.ok(sam, 'one person, not two');
  assert.deepEqual(sam.channels, ['imessage', 'mail']);
  assert.equal(sam.messages, 2);
});

test('a person with no spine entry keys by raw identifier', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'whatsapp', entity_id: 'w:1', text: 'a', meta: { chat_handle: '+19995550000', is_from_me: false } },
    { ts: NOW - 2 * DAY, source: 'whatsapp', entity_id: 'w:2', text: 'b', meta: { chat_handle: '+19995550000', is_from_me: true } },
  ]);
  const graph = buildGraph(ctx, spineDb([]), { now: NOW });
  const p = graph.find((x) => x.identifiers.includes('+19995550000'));
  assert.ok(p);
  assert.equal(p.messages, 2);
  assert.equal(p.reciprocity, 1, 'one each way is fully reciprocal');
});

test('dormancy is days since THEY last messaged, and future events do not count', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 100 * DAY, source: 'imessage', entity_id: 'i:1', text: 'x', meta: { chat_handle: '+18085550100', is_from_me: false } },
    { ts: NOW - 3 * DAY, source: 'imessage', entity_id: 'i:2', text: 'y', meta: { chat_handle: '+18085550100', is_from_me: true } },
    // A FUTURE meeting with them — must not reset dormancy to negative.
    { ts: NOW + 30 * DAY, source: 'calendar', entity_id: 'c:1', text: 'sync', meta: { attendees: [{ email: 'sam@work.com', name: 'Sam Lee' }] } },
  ]);
  const spine = spineDb([['+18085550100', 'Sam Lee', 'phone'], ['sam@work.com', 'Sam Lee', 'email']]);
  const sam = buildGraph(ctx, spine, { now: NOW }).find((p) => p.name === 'Sam Lee');
  // They last messaged 100 days ago; the owner's later reply and the future
  // meeting do not count as them reaching out.
  assert.equal(sam.dormancyDays, 100);
  assert.equal(sam.metInPerson, 1);
});

test('lastSeen ignores future events regardless of row scan order', () => {
  // The seed used to take the FIRST scanned signal's ts unguarded, while
  // every later update applied ts <= now — and the feeding SELECT has no
  // ORDER BY, so a person whose future meeting happened to scan first kept a
  // future lastSeen and rendered as freshly active on the map. The future row
  // is inserted FIRST here to pin the guard on the seed itself.
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW + 30 * DAY, source: 'calendar', entity_id: 'c:1', text: 'sync', meta: { attendees: [{ email: 'sam@work.com', name: 'Sam Lee' }] } },
    { ts: NOW - 100 * DAY, source: 'imessage', entity_id: 'i:1', text: 'x', meta: { chat_handle: '+18085550100', is_from_me: false } },
    { ts: NOW - 3 * DAY, source: 'imessage', entity_id: 'i:2', text: 'y', meta: { chat_handle: '+18085550100', is_from_me: true } },
  ]);
  const spine = spineDb([['+18085550100', 'Sam Lee', 'phone'], ['sam@work.com', 'Sam Lee', 'email']]);
  const sam = buildGraph(ctx, spine, { now: NOW }).find((p) => p.name === 'Sam Lee');
  assert.equal(sam.lastSeen, NOW - 3 * DAY, 'the newest PAST signal, not the future meeting');
  assert.equal(sam.relationshipDays, 97, 'relationship span ends at the last real contact');

  // A person whose ONLY signal is still in the future has not been seen yet:
  // null, not a future timestamp the map would clamp to "seen today".
  const ctx2 = openDb(':memory:');
  insertRows(ctx2, [
    { ts: NOW + 10 * DAY, source: 'calendar', entity_id: 'c:9', text: 'intro', meta: { attendees: [{ email: 'jo@x.com', name: 'Jo Ito' }] } },
  ]);
  const jo = buildGraph(ctx2, spineDb([['jo@x.com', 'Jo Ito', 'email']]), { now: NOW }).find((p) => p.name === 'Jo Ito');
  assert.equal(jo.lastSeen, null);
  assert.equal(jo.relationshipDays, 0);
});

test('calendar co-attendance merges by attendee email and counts meetings', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 20 * DAY, source: 'calendar', entity_id: 'c:1', text: 'm1', meta: { attendees: [{ email: 'rishab@videa.com', name: 'Rishab Nayak' }] } },
    { ts: NOW - 10 * DAY, source: 'calendar', entity_id: 'c:2', text: 'm2', meta: { attendees: [{ email: 'rishab@videa.com', name: 'Rishab Nayak' }] } },
    { ts: NOW - 15 * DAY, source: 'imessage', entity_id: 'i:1', text: 'hey', meta: { chat_handle: '+15555550123', is_from_me: false } },
  ]);
  const spine = spineDb([['+15555550123', 'Rishab Nayak', 'phone'], ['rishab@videa.com', 'Rishab Nayak', 'email']]);
  const r = buildGraph(ctx, spine, { now: NOW }).find((p) => p.name === 'Rishab Nayak');
  assert.equal(r.metInPerson, 2);
  assert.ok(r.channels.includes('calendar') && r.channels.includes('imessage'));
});

test('a LinkedIn connection carries title/company and the dormancy of the tie', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: new Date(2018, 5, 1).getTime(), source: 'linkedin', entity_id: 'linkedin:conn:janedoe', text: 'Jane Doe — VP', meta: { kind: 'connection', name: 'Jane Doe', position: 'VP Eng', company: 'Acme', connected_on: '01 Jun 2018' } },
  ]);
  const jane = buildGraph(ctx, spineDb([]), { now: NOW }).find((p) => p.name === 'Jane Doe');
  assert.ok(jane, 'a lone LinkedIn connection is kept — it is a real tie');
  assert.equal(jane.linkedin.position, 'VP Eng');
  assert.equal(jane.linkedin.company, 'Acme');
});

test('the graph now keeps a single-message person (the >=2 bar is gone)', () => {
  // The graph deliberately stops pre-judging: a lone email creates a person,
  // so a single real email from a VC survives to be ranked. Automated one-offs
  // like this no-reply are dropped later by the RANKER's address filters, not
  // by the graph — that separation is the point of removing the >=2 bar.
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'mail', entity_id: 'm:1', text: 'receipt', meta: { from: ['no-reply@amazon.com'], to: ['ay@austinyoshino.com'] } },
  ]);
  const owner = { addresses: new Set(['ay@austinyoshino.com']), names: [] };
  const graph = buildGraph(ctx, spineDb([]), { now: NOW, owner });
  assert.ok(graph.find((p) => p.identifiers.includes('no-reply@amazon.com')), 'kept in the graph now');
});

test('owner-sent mail attributes the recipient, not the owner', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'mail', entity_id: 'm:1', text: 'a', meta: { from: ['ay@austinyoshino.com'], to: ['client@co.com'] } },
    { ts: NOW - 2 * DAY, source: 'mail', entity_id: 'm:2', text: 'b', meta: { from: ['client@co.com'], to: ['ay@austinyoshino.com'] } },
  ]);
  const owner = { addresses: new Set(['ay@austinyoshino.com']), names: [] };
  const p = buildGraph(ctx, spineDb([]), { now: NOW, owner }).find((x) => x.identifiers.includes('client@co.com'));
  assert.ok(p);
  assert.equal(p.sent, 1, 'the owner-sent one');
  assert.equal(p.received, 1);
});

// ── labels for people nobody named ───────────────────────────────────────────
import { namelike, readableId } from '../server/people/graph.mjs';

// `speaker` falls back to the handle when WhatsApp knows no name, so both of
// these arrive looking like labels. Letting either through makes an identifier
// somebody's display name.
test('an identifier is never mistaken for a name', () => {
  assert.equal(namelike('Kevin Wang'), true);
  assert.equal(namelike('11107305521405@lid'), false, 'a LID');
  assert.equal(namelike('+14047180236'), false, 'a phone number');
  assert.equal(namelike('(808) 555-0100'), false, 'a formatted one');
  assert.equal(namelike('ay@austinyoshino.com'), false, 'an address');
  assert.equal(namelike(''), false);
  assert.equal(namelike(null), false);
});

test('a name with digits or punctuation still reads as a name', () => {
  assert.equal(namelike('Bella Pivo'), true);
  assert.equal(namelike("O'Brien"), true);
  assert.equal(namelike('Jimmy Nguyen 2'), true);
});

// A LID cannot be traced back to a person even by the owner -- WhatsApp mints
// it so it cannot. Seventeen digits asks somebody to recognise a token.
test('an unnameable LID renders as what it is, not as digits', () => {
  assert.equal(readableId('11107305521405@lid'), 'WhatsApp contact');
});

// A phone number is unrecognisable too, but it is real and the owner can often
// place it. It stays.
test('a phone number survives, because it is something a person can place', () => {
  assert.equal(readableId('+14047180236'), '+14047180236');
  assert.equal(readableId('ay@austinyoshino.com'), 'ay@austinyoshino.com');
  assert.equal(readableId(''), null);
});

// WHERE THE NAME COMES FROM WHEN THE SPINE HAS NOTHING.
//
// These four exist because the code they cover was dead and nothing noticed:
// buildGraph selected `ts, source, entity_id, meta`, so `row.speaker` was
// always undefined and every name it was written to rescue was dropped. The
// fixtures could not have caught it either -- they created a `context` table
// with no speaker column at all.
test('a group sender is named by the speaker, not by their LID', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'whatsapp', entity_id: 'w:g1', text: 'hey all',
      speaker: 'Priya Raman',
      meta: { chat_handle: 'group@g.us', sender_handle: '99887766@lid', is_group: true, is_from_me: false } },
    { ts: NOW - 2 * DAY, source: 'whatsapp', entity_id: 'w:g2', text: 'again',
      speaker: 'Priya Raman',
      meta: { chat_handle: 'group@g.us', sender_handle: '99887766@lid', is_group: true, is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('99887766@lid'));
  assert.ok(p, 'the group sender is a person');
  assert.equal(p.name, 'Priya Raman', 'the LID is an identifier, never a display name');
});

test('a one-to-one chat takes its name from the chat, which is the counterparty', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'whatsapp', entity_id: 'w:1', text: 'hi',
      meta: { chat_handle: '+19995550000', chat_name: 'Dana Okafor', is_group: false, is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('+19995550000'));
  assert.equal(p.name, 'Dana Okafor');
});

// The one that makes the fix safe rather than just effective: in a one-to-one
// chat the id is the CHAT, so the speaker of an outbound row is the owner.
test('an outbound one-to-one message never names the counterparty after the owner', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'whatsapp', entity_id: 'w:1', text: 'sent this',
      speaker: 'The Owner',
      meta: { chat_handle: '+19995550001', is_group: false, is_from_me: true } },
    { ts: NOW - 2 * DAY, source: 'whatsapp', entity_id: 'w:2', text: 'their reply',
      meta: { chat_handle: '+19995550001', is_group: false, is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('+19995550001'));
  assert.ok(p);
  assert.notEqual(p.name, 'The Owner', 'the owner is not their own counterparty');
});

test('the spine still outranks a chat name', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'whatsapp', entity_id: 'w:1', text: 'hi',
      meta: { chat_handle: '+19995550002', chat_name: 'Mum', is_group: false, is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([['+19995550002', 'Adaeze Okafor', 'phone']]), { now: NOW })
    .find((x) => x.identifiers.includes('+19995550002'));
  assert.equal(p.name, 'Adaeze Okafor', 'Contacts is the better authority than a chat label');
});

// The organizer of a meeting is a person you met, and EventKit does not always
// repeat them in the attendee list.
test('a calendar organizer absent from the attendee list is still a person', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'calendar', entity_id: 'c:1', text: 'Design review',
      meta: { attendees: [{ email: 'guest@corp.com', name: 'Guest One' }],
              organizer: { email: 'chair@corp.com', name: 'Chair Person' } } },
  ]);
  const graph = buildGraph(ctx, spineDb([]), { now: NOW });
  const chair = graph.find((x) => x.identifiers.includes('chair@corp.com'));
  assert.ok(chair, 'the person who called the meeting is in the graph');
  assert.equal(chair.name, 'Chair Person');
});

// ---- a room is not a conversation ----
//
// 22.3% of iMessage rows are group threads, and until 2026-08-26 nothing here
// could tell: the branch that asked "is this a group" read meta.is_group, which
// only WhatsApp writes. These pin both halves of the fix -- the clocks stop
// ticking on room chatter, and the counts do NOT move while that happens.
const GROUP_GUID = 'any;+;chat90210';
const DIRECT_GUID = 'any;-;+15550444';

test('somebody speaking in a room has not reached out to you', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    // Their only inbound is a group post, two days ago.
    { ts: NOW - 2 * DAY, source: 'imessage', entity_id: 'g1', text: 'anyone free saturday',
      meta: { chat_guid: GROUP_GUID, handle: '+15550444', is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('+15550444'));
  assert.ok(p, 'they are still a person -- this is not a filter');
  assert.equal(p.messages, 0, 'but you have exchanged nothing with them');
  assert.equal(p.received, 0, 'they did not write to YOU');
  assert.equal(p.roomMessages, 1, 'what they did is counted as what it was');
  assert.equal(p.dormancyDays, null, 'and they have never reached out');
  assert.equal(p.roomOnly, true);
});

test('a direct message still starts the clock', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 2 * DAY, source: 'imessage', entity_id: 'd1', text: 'hey',
      meta: { chat_guid: DIRECT_GUID, handle: '+15550444', is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('+15550444'));
  assert.equal(p.dormancyDays, 2);
  assert.equal(p.roomOnly, false);
  assert.equal(p.directMessages, 1);
});

// WHAT SENT AND RECEIVED MEAN. reciprocity is documented as "do they write back
// -- 1.0 is a balanced two-way thread". Counting rooms made that read 1.0 for two
// people who had never addressed each other and merely posted the same number of
// times into the same group. Somebody answering in a group chat did not answer
// YOU, and these numbers now say so.
test('sent and received count what was addressed to you, rooms count separately', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 9 * DAY, source: 'imessage', entity_id: 'm1', text: 'in the room',
      meta: { chat_guid: GROUP_GUID, handle: '+15550444', is_from_me: false } },
    { ts: NOW - 8 * DAY, source: 'imessage', entity_id: 'm2', text: 'also the room',
      meta: { chat_guid: GROUP_GUID, handle: '+15550444', is_from_me: false } },
    { ts: NOW - 5 * DAY, source: 'imessage', entity_id: 'm3', text: 'direct to me',
      meta: { chat_guid: DIRECT_GUID, handle: '+15550444', is_from_me: false } },
    { ts: NOW - 4 * DAY, source: 'imessage', entity_id: 'm4', text: 'my reply',
      meta: { chat_guid: DIRECT_GUID, handle: '+15550444', is_from_me: true } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('+15550444'));
  // Two direct (one each way), two in a room.
  assert.equal(p.received, 1, 'only what they addressed to the owner');
  assert.equal(p.sent, 1);
  assert.equal(p.messages, 2, 'the exchange between the two of you');
  assert.equal(p.reciprocity, 1, 'one each way IS balanced — the rooms do not dilute it');
  assert.equal(p.roomMessages, 2, 'and the room volume is not lost, it is just not this');
  assert.equal(p.directMessages, 2);
  assert.equal(p.roomOnly, false);
  assert.equal(p.dormancyDays, 5, 'the clock uses the DIRECT message, not the newer room one');
});

// 656 live rows carry no chat_guid. They must keep behaving exactly as they did.
test('a row with no thread is credited as before, and asserts no room', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 3 * DAY, source: 'imessage', entity_id: 'u1', text: 'no guid here',
      meta: { handle: '+15550444', is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('+15550444'));
  assert.equal(p.messages, 1);
  assert.equal(p.dormancyDays, 3, 'unknown is credited as direct, so nothing moved');
  assert.equal(p.roomOnly, false);
  assert.equal(p.roomMessages, 0);
});

// The owner's own side of their own conversations: Apple does not record who an
// outbound message went to, so these were dropped and reciprocity was computed
// against a sent side missing most of its evidence.
test('an outbound message with no handle still finds its recipient', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 3 * DAY, source: 'imessage', entity_id: 'o1', text: 'sent, unaddressed',
      meta: { chat_guid: 'any;-;+15550444', is_from_me: true } },
    { ts: NOW - 2 * DAY, source: 'imessage', entity_id: 'o2', text: 'their reply',
      meta: { chat_guid: 'any;-;+15550444', handle: '+15550444', is_from_me: false } },
  ]);
  const p = buildGraph(ctx, spineDb([]), { now: NOW }).find((x) => x.identifiers.includes('+15550444'));
  assert.equal(p.sent, 1, 'the outbound row is no longer dropped');
  assert.equal(p.received, 1);
  assert.equal(p.reciprocity, 1, 'which is what makes reciprocity mean anything');
});

test('an unaddressed message in a ROOM does not invent a person', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'imessage', entity_id: 'g9', text: 'said to the room',
      meta: { chat_guid: 'any;+;chat488392016936725110', is_from_me: true } },
  ]);
  const g = buildGraph(ctx, spineDb([]), { now: NOW });
  assert.equal(g.length, 0, 'a room id must never become a person with a message count');
});

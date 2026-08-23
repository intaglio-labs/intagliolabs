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

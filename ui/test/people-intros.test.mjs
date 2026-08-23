// Tests for warm-intro paths: rooms, bridge-finding, and the honest negative.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb, insertRows } from '../server/hermes.mjs';
import { buildRooms, resolveTargets, findIntros, warmIntro } from '../server/people/intros.mjs';
import { buildGraph } from '../server/people/graph.mjs';
import { detectIntro } from '../server/people/search.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const DAY = 86_400_000;
const owner = { addresses: new Set(['ay@austinyoshino.com']), names: [] };

test('detectIntro pulls the target out of the phrasing', () => {
  assert.equal(detectIntro('how do i reach danny at lux'), 'danny at lux');
  assert.equal(detectIntro('warm intro to sequoia?'), 'sequoia');
  assert.equal(detectIntro('who can introduce me to a16z'), 'a16z');
  assert.equal(detectIntro('who are investors i talked to'), null, 'a need-search is not an intro');
});

test('a bridge is a warm contact who shared a room with the target', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    // An email thread with the owner, a close friend (barry), and the target VC (dana).
    { ts: NOW - 300 * DAY, source: 'mail', entity_id: 'm:1', text: 'intro thread', meta: { from: ['ay@austinyoshino.com'], to: ['barry@friend.com', 'dana@lux.vc'], cc: [] } },
    // Owner has a warm two-way history with barry so the intro is askable.
    ...Array.from({ length: 20 }, (_, i) => ({ ts: NOW - i * DAY, source: 'imessage', entity_id: `i:${i}`, text: 'hey', meta: { chat_handle: '+18085550100', is_from_me: i % 2 } })),
    { ts: NOW - 5 * DAY, source: 'mail', entity_id: 'm:2', text: 'x', meta: { from: ['barry@friend.com'], to: ['ay@austinyoshino.com'] } },
  ]);
  const spine = new DatabaseSync(':memory:');
  spine.exec("CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)");
  spine.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('+18085550100', 'Barry', 'phone', NOW);
  spine.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('barry@friend.com', 'Barry', 'email', NOW);
  const graph = buildGraph(ctx, spine, { owner, now: NOW });
  const res = warmIntro(ctx, graph, 'dana@lux.vc', { owner });
  assert.equal(res.found, true);
  assert.ok(res.bridges.some((b) => b.name === 'Barry'), 'Barry bridges to Dana');
});

test('no shared room means an honest empty path, not a guess', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'mail', entity_id: 'm:1', text: 'x', meta: { from: ['dana@lux.vc'], to: ['ay@austinyoshino.com'] } },
  ]);
  const spine = new DatabaseSync(':memory:');
  spine.exec("CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)");
  const graph = buildGraph(ctx, spine, { owner, now: NOW });
  const res = warmIntro(ctx, graph, 'dana@lux.vc', { owner });
  assert.equal(res.found, true);
  assert.equal(res.bridges.length, 0, 'nobody else was ever in a room with Dana');
});

test('a target you already know well returns "no intro needed", not bridges', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    // Owner has met the target many times and messaged a lot — a warm direct tie.
    ...Array.from({ length: 40 }, (_, i) => ({ ts: NOW - i * DAY, source: 'imessage', entity_id: `i:${i}`, text: 'hi', meta: { chat_handle: '+18085550100', is_from_me: i % 2 } })),
    ...Array.from({ length: 8 }, (_, i) => ({ ts: NOW - i * 5 * DAY, source: 'calendar', entity_id: `c:${i}`, text: 'meet', meta: { attendees: [{ email: 'vc@target.vc', name: 'Vic' }] } })),
  ]);
  const spine = new DatabaseSync(':memory:');
  spine.exec("CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)");
  spine.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('+18085550100', 'Vic', 'phone', NOW);
  spine.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('vc@target.vc', 'Vic', 'email', NOW);
  const graph = buildGraph(ctx, spine, { owner, now: NOW });
  const res = warmIntro(ctx, graph, 'vc@target.vc', { owner });
  assert.equal(res.alreadyWarm, true, 'you already know Vic — no intro needed');
});

test('a big group room is not counted as a bridge', () => {
  const ctx = openDb(':memory:');
  // A 20-person meeting with the target and a batch-mate — NOT a real intro path.
  const bigAttendees = Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@batch.com` }));
  bigAttendees.push({ email: 'vc@target.vc' }, { email: 'batchmate@batch.com' });
  insertRows(ctx, [
    { ts: NOW - 10 * DAY, source: 'calendar', entity_id: 'c:big', text: 'demo day', meta: { attendees: bigAttendees } },
    // batchmate has a warm tie to the owner otherwise
    ...Array.from({ length: 20 }, (_, i) => ({ ts: NOW - i * DAY, source: 'imessage', entity_id: `i:${i}`, text: 'hi', meta: { chat_handle: '+18085550200', is_from_me: i % 2 } })),
  ]);
  const spine = new DatabaseSync(':memory:');
  spine.exec("CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)");
  spine.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('+18085550200', 'Batchmate', 'phone', NOW);
  spine.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('batchmate@batch.com', 'Batchmate', 'email', NOW);
  const graph = buildGraph(ctx, spine, { owner, now: NOW });
  const res = warmIntro(ctx, graph, 'vc@target.vc', { owner });
  assert.ok(!res.bridges || res.bridges.every((b) => b.name !== 'Batchmate'), 'the 22-person demo day does not make batchmate a bridge');
});

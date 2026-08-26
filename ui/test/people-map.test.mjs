// The constellation data layer: clustering (work domain / LinkedIn company /
// personal), strength normalization, recency warmth, and counts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildMap, clusterOf } from '../server/people/map.mjs';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const owner = { addresses: new Set(['me@x.com']), names: ['Me'] };

test('clusterOf groups by LinkedIn company, then work domain, else personal', () => {
  assert.equal(clusterOf({ linkedin: { company: 'Acme' }, identifiers: [] }).label, 'Acme');
  assert.equal(clusterOf({ identifiers: ['a@acme-labs.com'] }).key, 'dom:acme-labs.com');
  assert.equal(clusterOf({ identifiers: ['a@acme-labs.com'] }).label, 'Acme Labs');
  // Freemail carries no group signal -> personal, not a gmail mega-cluster.
  assert.equal(clusterOf({ identifiers: ['a@gmail.com'] }).personal, true);
  assert.equal(clusterOf({ identifiers: ['+15551234'] }).personal, true);
});

function seed() {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  const rows = [
    // Two colleagues at acme.com -> one named cluster; recent AND two-way (the
    // owner both received from and replied to them), so they clear the
    // relationship floor. A one-way inbound would be a newsletter, not a person.
    [NOW - 5 * DAY, 'mail', 'm:1', null, JSON.stringify({ from: ['ann@acme.com'], to: ['me@x.com'] })],
    [NOW - 5 * DAY, 'mail', 'm:1b', null, JSON.stringify({ from: ['me@x.com'], to: ['ann@acme.com'] })],
    [NOW - 6 * DAY, 'mail', 'm:2', null, JSON.stringify({ from: ['bob@acme.com'], to: ['me@x.com'] })],
    [NOW - 6 * DAY, 'mail', 'm:2b', null, JSON.stringify({ from: ['me@x.com'], to: ['bob@acme.com'] })],
    // A personal gmail contact on iMessage (a personal channel clears the floor
    // on its own), gone dormant (>1y since inbound).
    [NOW - 800 * DAY, 'imessage', 'i:1', null, JSON.stringify({ chat_handle: 'old@gmail.com', is_from_me: false })],
  ];
  for (const r of rows) ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(...r);
  return ctx;
}

test('buildMap returns clusters, normalized strength, and warmth by recency', () => {
  const ctx = seed();
  const map = buildMap(ctx, null, { now: NOW, owner });

  assert.equal(map.counts.people, 3);
  // acme.com is a named cluster of 2; the gmail contact is personal.
  const acme = map.clusters.find((c) => c.key === 'dom:acme.com');
  assert.ok(acme && acme.size === 2);
  assert.ok(map.clusters.find((c) => c.key === 'personal' && c.personal));

  // Strength is normalized: the strongest person is 1.0.
  assert.equal(Math.max(...map.people.map((p) => p.strength)), 1);

  // The recent acme contacts burn warm; the dormant gmail one is dim.
  const ann = map.people.find((p) => p.name.includes('ann') || p.identifiers.includes('ann@acme.com'));
  const old = map.people.find((p) => p.identifiers.includes('old@gmail.com'));
  assert.ok(ann.warm > old.warm);
  assert.ok(old.warm <= 0.2);
});

test('a one-way inbound mail contact (newsletter-shaped) is not a star', () => {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  // Inbound only, never replied, never met, mail-only -> no relationship.
  ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(
    NOW - 5 * DAY, 'mail', 'n:1', null, JSON.stringify({ from: ['digest@somelist.com'], to: ['me@x.com'] }));
  const map = buildMap(ctx, null, { now: NOW, owner });
  assert.equal(map.counts.people, 0);
});

test('a WhatsApp @lid identifier is a personal contact, not a "Lid" company', () => {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  // A real WhatsApp person whose phone is hidden behind a LID. Two-way.
  ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(
    NOW - 2 * DAY, 'whatsapp', 'w:1', null, JSON.stringify({ chat_handle: '12345@lid', is_from_me: false }));
  const map = buildMap(ctx, null, { now: NOW, owner });
  assert.equal(map.counts.people, 1);
  assert.equal(map.people[0].cluster, 'personal');
  assert.ok(!map.clusters.some((c) => c.label === 'Lid'));
});

test('counts split active (recent) from dormant (>= 1y)', () => {
  const ctx = seed();
  const { counts } = buildMap(ctx, null, { now: NOW, owner });
  assert.ok(counts.active >= 2);   // the two acme contacts
  assert.ok(counts.dormant >= 1);  // the old gmail one
});

// ---- a room does not make somebody warm ----
//
// The dormancy fix left lastFromThem null for a room-only person, and buildMap
// then fell back to lastSeen -- which ticks on any activity, room included. So
// a group-only speaker who posted yesterday still came out at maximum warmth,
// and the constellation behaviour the fix was for stayed broken. Caught by
// codex on PR #17; this is the assertion that was missing.
test('a recent group post does not make a stranger look like a close friend', () => {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(
    NOW - DAY, 'imessage', 'g1', 'anyone free saturday',
    JSON.stringify({ chat_guid: 'any;+;chat70707', handle: '+15550777', is_from_me: false })
  );
  const map = buildMap(ctx, null, { now: NOW, owner });
  const p = map.people.find((x) => (x.identifiers ?? []).includes('+15550777'));
  assert.ok(p, 'they are on the map — this is not a filter');
  assert.equal(p.dormancyDays, null, 'they have never reached out');
  assert.equal(p.recencyDays, null, 'and yesterday in a room is not recency with them');
  assert.ok(p.warm < 1, `warmth must not be maximum, got ${p.warm}`);
});

test('a recent DIRECT message still makes somebody warm', () => {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(
    NOW - DAY, 'imessage', 'd1', 'hey',
    JSON.stringify({ chat_guid: 'any;-;+15550778', handle: '+15550778', is_from_me: false })
  );
  const p = buildMap(ctx, null, { now: NOW, owner }).people.find((x) => (x.identifiers ?? []).includes('+15550778'));
  assert.equal(p.recencyDays, 1);
  assert.equal(p.warm, 1, 'the fallback still works for real contact');
});

// ---- two clocks, and why there are two ----
//
// recencyDays answers "how warm is this relationship" and refuses the room.
// presenceDays answers "when did I last come across this person at all" and
// accepts it. The 467 room-only people on the live corpus are the entire
// difference, which is what lets a recency filter offer "in touch" without
// deleting the cohort the room work just made visible.
test('a room counts for presence and not for warmth', () => {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(
    NOW - DAY, 'imessage', 'g1', 'anyone free saturday',
    JSON.stringify({ chat_guid: 'any;+;chat70707', handle: '+15550999', is_from_me: false })
  );
  const p = buildMap(ctx, null, { now: NOW, owner }).people
    .find((x) => (x.identifiers ?? []).includes('+15550999'));
  assert.ok(p);
  assert.equal(p.recencyDays, null, 'a room is not contact');
  assert.ok(p.warm < 1, 'so it cannot make them warm');
  assert.equal(p.presenceDays, 1, 'but you did come across them yesterday');
  assert.equal(p.roomOnly, true);
});

test('a direct message drives both clocks', () => {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(
    NOW - 5 * DAY, 'imessage', 'd1', 'hey',
    JSON.stringify({ chat_guid: 'any;-;+15550998', handle: '+15550998', is_from_me: false })
  );
  const p = buildMap(ctx, null, { now: NOW, owner }).people
    .find((x) => (x.identifiers ?? []).includes('+15550998'));
  assert.equal(p.recencyDays, 5);
  assert.equal(p.presenceDays, 5, 'the two agree whenever there IS direct contact');
});

// The whole point: a filter built on recencyDays would drop every room-only
// person, because theirs is null by design.
test('presence is the only field a recency filter can honestly use', () => {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  const ins = ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)');
  ins.run(NOW - 2 * DAY, 'imessage', 'r1', 'in the room',
    JSON.stringify({ chat_guid: 'any;+;chatA', handle: '+15550111', is_from_me: false }));
  ins.run(NOW - 3 * DAY, 'imessage', 'd2', 'to me',
    JSON.stringify({ chat_guid: 'any;-;+15550222', handle: '+15550222', is_from_me: false }));
  const people = buildMap(ctx, null, { now: NOW, owner }).people;
  const byRecency = people.filter((p) => p.recencyDays != null && p.recencyDays < 365);
  const byPresence = people.filter((p) => p.presenceDays != null && p.presenceDays < 365);
  assert.equal(byRecency.length, 1, 'recency sees only the direct contact');
  assert.equal(byPresence.length, 2, 'presence sees both, which is what "in touch" means');
});

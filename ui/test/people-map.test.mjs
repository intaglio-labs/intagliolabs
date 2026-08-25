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

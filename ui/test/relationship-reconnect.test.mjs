// L5 step 6: the reconnect adapter -- the first suggester -- proves it walks
// through every gate built in steps 1-5: the control ranking, suppression
// and mute before ranking, the hard coverage gates, and the global cap at
// the one aggregation door.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { createRelationshipMemory } from '../server/relationship/service.mjs';
import { reconnectAdapter, RECONNECT_RULES_VERSION } from '../server/relationship/reconnect.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CAP = { max: 5, windowMs: 24 * HOUR };

function stateDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  db.exec('CREATE TABLE run_log (connector TEXT, ok INTEGER, finished_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name] of pairs) ins.run(id, name, 'phone', NOW);
  return db;
}

// Dormant Friend: 8 two-way messages, silent for ~200 days. Active Friend:
// recent traffic. Fresh Friend keeps the imessage source provably alive.
function fixture({ register = true } = {}) {
  const ctx = openDb(':memory:');
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({ ts: NOW - (300 - i * 12) * DAY, source: 'imessage', entity_id: `d:${i}`,
      text: 'x', meta: { chat_handle: '+15550001', is_from_me: i % 2 === 0 } });
    rows.push({ ts: NOW - (10 - i) * DAY, source: 'imessage', entity_id: `a:${i}`,
      text: 'y', meta: { chat_handle: '+15550002', is_from_me: i % 2 === 1 } });
  }
  rows.push({ ts: NOW - HOUR, source: 'imessage', entity_id: 'f:1', text: 'ok',
    meta: { chat_handle: '+15550003', is_from_me: true } });
  insertRows(ctx, rows);
  const svc = createRelationshipMemory({
    contextDb: ctx,
    stateDb: stateDb([['+15550001', 'Dormant Friend'], ['+15550002', 'Active Friend'],
      ['+15550003', 'Fresh Friend']]),
  });
  if (register) svc.registerSource(reconnectAdapter());
  return svc;
}

test('the adapter suggests the dormant person, with counted facts and no text', () => {
  const svc = fixture();
  const cands = svc.candidates({ now: NOW, cap: CAP });
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.equal(c.personKey, 'name:dormant friend');
  assert.equal(c.kind, 'reconnect');
  assert.equal(c.producer_version, RECONNECT_RULES_VERSION);
  assert.ok(c.evidence.dormancyDays >= 180 && c.evidence.messages === 8);
  assert.deepEqual(c.evidence.channels, ['imessage']);
  assert.ok(!JSON.stringify(c).includes("'x'"), 'no message text anywhere in a candidate');
  assert.match(c.summary, /quiet for \d+ days after 8 messages/);
});

test('suppression and mute are honored before ranking', () => {
  const svc = fixture();
  svc.controls.suppress('name:dormant friend', NOW);
  assert.deepEqual(svc.candidates({ now: NOW, cap: CAP }), [], 'suppressed: no candidate anywhere');
  svc.controls.unsuppress('name:dormant friend');
  svc.controls.mute({ personKey: 'name:dormant friend', kind: 'reconnect', untilAt: NOW + HOUR, now: NOW });
  assert.deepEqual(svc.candidates({ now: NOW, cap: CAP }), [], 'muted for the kind: same');
  // Two hours on: the mute expired and the source is still watchdog-fresh
  // (moving days ahead would fail the COVERAGE gate, not the mute -- the
  // gates compose, which is the point of this file).
  assert.equal(svc.candidates({ now: NOW + 2 * HOUR, cap: CAP }).length, 1, 'mute expiry restores');
});

test('the hard coverage gate: a pipe that cannot vouch for the window produces no claim', () => {
  // No fresh third-party row: the newest imessage row is 10 days old (Active
  // Friend), so the source is watchdog-stale and NOTHING may claim dormancy.
  const ctx = openDb(':memory:');
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({ ts: NOW - (300 - i * 12) * DAY, source: 'imessage', entity_id: `d:${i}`,
      text: 'x', meta: { chat_handle: '+15550001', is_from_me: i % 2 === 0 } });
  }
  insertRows(ctx, rows);
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: stateDb([['+15550001', 'Dormant Friend']]) });
  svc.registerSource(reconnectAdapter());
  assert.deepEqual(svc.candidates({ now: NOW, cap: CAP }), [],
    'a dormancy claim over a dead pipe is a claim about the pipe');
});

test('the global cap closes the aggregation door entirely', () => {
  const svc = fixture();
  const tight = { max: 1, windowMs: 24 * HOUR };
  assert.equal(svc.candidates({ now: NOW, cap: tight }).length, 1);
  svc.controls.recordEvent({ personKey: 'name:someone', kind: 'open_loop', event: 'shown',
    ruleVersion: 'v', now: NOW - HOUR });
  assert.deepEqual(svc.candidates({ now: NOW, cap: tight }), [],
    'one card shown, cap of one: nothing else offers itself');
  assert.deepEqual(svc.candidates({ now: NOW }), [],
    'no cap configured: the door does not open at all');
});

test('threshold overrides flow through to the control strategy', () => {
  const svc = fixture({ register: false });
  // Active Friend has 8 messages and last WROTE 4 days ago (dormancy runs on
  // their clock, not the owner's); a 3-day interval admits them, which is how
  // a gates-artifact override would land.
  svc.registerSource(reconnectAdapter({ intervalDays: 3, minMessages: 8, limit: 2 }));
  assert.throws(() => svc.registerSource(reconnectAdapter()), /already registered/);
  const keys = svc.candidates({ now: NOW, cap: CAP }).map((c) => c.personKey).sort();
  assert.ok(keys.includes('name:active friend'), 'override widened the window');
});

// L5 step 7: every pass through the aggregation door leaves an immutable
// record of what was offered -- including the passes that offered nothing
// and the passes the cap refused. Shadow mode's numbers are computed from
// these rows; a pass that leaves no row is a measurement that never
// happened.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { createRelationshipMemory } from '../server/relationship/service.mjs';
import { reconnectAdapter } from '../server/relationship/reconnect.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CAP = { max: 5, windowMs: 24 * HOUR };

function fixture() {
  const ctx = openDb(':memory:');
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({ ts: NOW - (300 - i * 12) * DAY, source: 'imessage', entity_id: `d:${i}`,
      text: 'x', meta: { chat_handle: '+15550001', is_from_me: i % 2 === 0 } });
  }
  rows.push({ ts: NOW - HOUR, source: 'imessage', entity_id: 'f:1', text: 'ok',
    meta: { chat_handle: '+15550003', is_from_me: true } });
  insertRows(ctx, rows);
  const state = new DatabaseSync(':memory:');
  state.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  state.exec('CREATE TABLE run_log (connector TEXT, ok INTEGER, finished_ts INTEGER)');
  state.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('+15550001', 'Dormant Friend', 'phone', NOW);
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state });
  svc.registerSource(reconnectAdapter());
  return { svc, ctx };
}

test('an offered candidate is snapshotted verbatim and linked back from its outcome', () => {
  const { svc, ctx } = fixture();
  const [c] = svc.candidates({ now: NOW, cap: CAP });
  assert.ok(Number.isInteger(c.snapshot_id));
  const snap = { ...ctx.prepare('SELECT * FROM rm_candidate_snapshot WHERE id = ?').get(c.snapshot_id) };
  assert.equal(snap.person_key, c.personKey);
  assert.equal(snap.kind, 'reconnect');
  assert.equal(snap.summary, c.summary);
  assert.deepEqual(JSON.parse(snap.evidence), c.evidence);
  assert.equal(snap.producer_version, c.producer_version);
  // The outcome event names the snapshot it belongs to.
  svc.controls.recordEvent({ personKey: c.personKey, kind: c.kind, event: 'shown',
    ruleVersion: c.producer_version, snapshotId: c.snapshot_id, now: NOW });
  const ev = ctx.prepare('SELECT snapshot_id FROM rm_card_event WHERE event = ?').get('shown');
  assert.equal(Number(ev.snapshot_id), c.snapshot_id);
});

test('a refused pass and an empty pass are rows, not absences', () => {
  const { svc, ctx } = fixture();
  svc.candidates({ now: NOW });                       // no cap: door closed
  svc.controls.suppress('name:dormant friend', NOW);
  svc.candidates({ now: NOW, cap: CAP });             // open, but nothing eligible
  const batches = ctx.prepare('SELECT gate, candidate_count, cap_config FROM rm_candidate_batch ORDER BY id')
    .all().map((r) => ({ ...r }));
  assert.deepEqual(batches, [
    { gate: 'cap-closed', candidate_count: 0, cap_config: null },
    { gate: 'open', candidate_count: 0, cap_config: JSON.stringify(CAP) },
  ]);
});

test('snapshots and batches are immutable in fact', () => {
  const { svc, ctx } = fixture();
  const [c] = svc.candidates({ now: NOW, cap: CAP });
  assert.throws(() => ctx.prepare("UPDATE rm_candidate_snapshot SET summary = 'nicer' WHERE id = ?").run(c.snapshot_id),
    /not a snapshot/);
  assert.throws(() => ctx.prepare('DELETE FROM rm_candidate_snapshot WHERE id = ?').run(c.snapshot_id),
    /not a snapshot/);
  assert.throws(() => ctx.prepare('UPDATE rm_candidate_batch SET candidate_count = 0').run(), /append-only/);
  assert.throws(() => ctx.prepare('DELETE FROM rm_candidate_batch').run(), /append-only/);
});

test('repeat rate is computable from the rows alone', () => {
  const { svc, ctx } = fixture();
  svc.candidates({ now: NOW, cap: CAP });
  svc.candidates({ now: NOW + HOUR, cap: CAP });
  const n = Number(ctx.prepare(
    "SELECT COUNT(*) AS n FROM rm_candidate_snapshot WHERE person_key = 'name:dormant friend'").get().n);
  assert.equal(n, 2, 'the same person offered twice is two snapshot rows -- the repeat-rate numerator');
});

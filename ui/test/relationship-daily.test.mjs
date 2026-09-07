// Alternation (daily.mjs): pickProducer's "whose turn is it" and
// produceDailyBatch's production/serving decision. Producers are stubbed
// here -- owe.mjs and producer.mjs each have their own gate tests -- so
// these tests exercise ONLY the alternation and per-kind-throttle logic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/hermes.mjs';
import { CARD_PRODUCERS, REFILL_RETRY_MS, pickProducer, produceDailyBatch } from '../server/relationship/daily.mjs';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;

function insertShown(db, { kind, createdAt }) {
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    "VALUES ('name:whoever', ?, NULL, 'shown', NULL, NULL, 'v1', 'morning', ?)"
  ).run(kind, createdAt);
}

function markJudged(db, snapshotId, event = 'dismissed') {
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    "VALUES ('name:whoever', 'x', ?, ?, NULL, NULL, 'v1', 'morning', ?)"
  ).run(snapshotId, event, NOW);
}

// rm_card_event.snapshot_id REFERENCES rm_candidate_snapshot(id), so a fake
// card needs a real (batch, snapshot) row underneath it, same as the
// producers themselves would write.
let cardSeq = 0;
function card(db, kind, overrides = {}) {
  cardSeq += 1;
  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
  ).run(NOW, 'open').lastInsertRowid);
  const snapshotId = Number(db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    "VALUES (?, ?, ?, 'summary', '{}', 'test-v1', 'test', ?)"
  ).run(batchId, `name:${kind}-${cardSeq}`, kind, NOW).lastInsertRowid);
  return { personKey: `name:${kind}-${cardSeq}`, name: 'X', kind, snapshot_id: snapshotId, ...overrides };
}

// A stub producer: returns `cards` (already-built, via the `card()` helper
// above) once, records how many times it was called, and reports a batchId
// so the caller can tell a real production happened.
function stubProducer(cardsToReturn) {
  let calls = 0;
  let nextBatchId = 100;
  const fn = (db, { now }) => {
    calls += 1;
    const cards = typeof cardsToReturn === 'function' ? cardsToReturn(calls) : cardsToReturn;
    return { batchId: nextBatchId++, cards };
  };
  fn.callCount = () => calls;
  return fn;
}

// ---- 12: pickProducer ----------------------------------------------------
test('pickProducer: none shown -> owe; owe shown recently -> reconnect; a tie -> CARD_PRODUCERS[0]', () => {
  assert.deepEqual([...CARD_PRODUCERS], ['owe', 'reconnect']);
  assert.equal(REFILL_RETRY_MS, 15 * 60_000);

  const dbNone = openDb(':memory:');
  assert.equal(pickProducer(dbNone, { now: NOW }), 'owe', 'nothing shown yet: control (owe) goes first');

  const dbOweFresh = openDb(':memory:');
  insertShown(dbOweFresh, { kind: 'owe', createdAt: NOW - 1 * DAY });
  assert.equal(pickProducer(dbOweFresh, { now: NOW }), 'reconnect',
    'owe was just shown; reconnect (never shown, i.e. older) goes next');

  const dbTie = openDb(':memory:');
  insertShown(dbTie, { kind: 'owe', createdAt: NOW - 5 * DAY });
  insertShown(dbTie, { kind: 'reconnect', createdAt: NOW - 5 * DAY });
  assert.equal(pickProducer(dbTie, { now: NOW }), 'owe', 'an exact tie resolves to CARD_PRODUCERS[0]');
});

// ---- 13: per-kind unjudged, not whole-queue -------------------------------
test('a 5-deep reconnect batch with 4 unjudged still yields an Owe card the next time it is owe\'s turn', () => {
  const db = openDb(':memory:');
  // reconnect was shown recently (its batch is fresh and mostly unjudged);
  // owe has never been shown, so pickProducer gives owe the turn.
  insertShown(db, { kind: 'reconnect', createdAt: NOW - 1 * DAY });

  const reconnectCards = [1, 2, 3, 4, 5].map(() => card(db, 'reconnect'));
  markJudged(db, reconnectCards[4].snapshot_id, 'dismissed'); // only the 5th is judged; 1-4 are unjudged
  const rel = { cards: reconnectCards, batch: { owe: null, reconnect: 999 }, refill: null };

  const oweProducer = stubProducer([card(db, 'owe')]);
  const policy = { producers: { owe: oweProducer, reconnect: stubProducer([]) } };

  const out = produceDailyBatch(db, policy, rel, { now: NOW });
  assert.equal(out.servingKind, 'owe', 'today\'s single whole-queue hasUnjudged would have starved owe here');
  assert.equal(oweProducer.callCount(), 1, 'owe actually produced -- it was not treated as already having unjudged cards');
});

// ---- 14: empty Owe falls through to reconnect in the same request --------
test('an empty Owe pool falls through to reconnect in the same request', () => {
  const db = openDb(':memory:');
  const rel = { cards: [], batch: { owe: null, reconnect: null }, refill: null };
  const reconnectProducer = stubProducer([card(db, 'reconnect')]);
  const policy = { producers: { owe: stubProducer([]), reconnect: reconnectProducer } };

  const out = produceDailyBatch(db, policy, rel, { now: NOW });
  assert.equal(out.servingKind, 'reconnect');
  assert.equal(reconnectProducer.callCount(), 1);
  assert.equal(rel.cards.length, 1);
  assert.equal(rel.cards[0].kind, 'reconnect');
});

// ---- 15: per-kind throttle isolation + shared pool-exhausted -------------
test('an empty Owe refill does not throttle reconnect; once both are empty, pool-exhausted with no further batches', () => {
  const db = openDb(':memory:');
  const rel = { cards: [], batch: { owe: null, reconnect: null }, refill: null };

  // Call 1: owe's pool is empty; reconnect's is not. Owe becomes throttled;
  // reconnect is untouched by that (independent per-kind state) and serves.
  const reconnectCard = card(db, 'reconnect');
  const oweProducer = stubProducer([]);
  const reconnectProducer = stubProducer((n) => (n === 1 ? [reconnectCard] : []));
  const policy = { producers: { owe: oweProducer, reconnect: reconnectProducer } };

  const out1 = produceDailyBatch(db, policy, rel, { now: NOW });
  assert.equal(out1.servingKind, 'reconnect', 'reconnect is not blocked by owe\'s own empty refill');
  assert.equal(oweProducer.callCount(), 1);
  assert.equal(reconnectProducer.callCount(), 1);
  assert.equal(rel.refill.owe.empty, true);
  assert.equal(rel.refill.reconnect.empty, false);

  // Judge the reconnect card that call 1 produced, so its own pool goes
  // empty too on the next attempt (simulated by the stub returning [] from
  // its second call onward).
  markJudged(db, reconnectCard.snapshot_id, 'dismissed');

  // Call 2, shortly after (well within REFILL_RETRY_MS): owe is throttled
  // (its own producer must NOT be called again); reconnect is NOT throttled
  // yet (its last refill was not empty), so its producer IS called, finds
  // nothing this time, and becomes throttled too.
  const now2 = NOW + 60_000;
  const out2 = produceDailyBatch(db, policy, rel, { now: now2 });
  assert.equal(out2.servingKind, null);
  assert.equal(out2.reason, 'pool-exhausted');
  assert.equal(oweProducer.callCount(), 1, 'owe stayed throttled -- its producer was not called a second time');
  assert.equal(reconnectProducer.callCount(), 2, 'reconnect was NOT throttled by owe\'s own empty state');
  assert.equal(rel.refill.reconnect.empty, true, 'reconnect is now also empty, and now throttled too');

  // Call 3, still within the window: BOTH are now throttled -- neither
  // producer is called again.
  const now3 = now2 + 60_000;
  const out3 = produceDailyBatch(db, policy, rel, { now: now3 });
  assert.equal(out3.servingKind, null);
  assert.equal(out3.reason, 'pool-exhausted');
  assert.equal(oweProducer.callCount(), 1, 'still not called again');
  assert.equal(reconnectProducer.callCount(), 2, 'still not called again -- both kinds are throttled independently');
});

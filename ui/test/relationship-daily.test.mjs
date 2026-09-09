// Alternation (daily.mjs): pickProducer's "whose turn is it" and
// produceDailyBatch's production/serving decision. Producers are stubbed
// here -- owe.mjs and producer.mjs each have their own gate tests -- so
// these tests exercise ONLY the alternation and per-kind-throttle logic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/hermes.mjs';
import {
  CARD_PRODUCERS, CONSUMING_EVENTS, REFILL_RETRY_MS,
  isSnapshotConsumed, liveQueuePersonKeys, pickProducer, produceDailyBatch,
} from '../server/relationship/daily.mjs';

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

// ---- 15b: policy.currentVersions voids a stale Owe card, leaves reconnect alone
// (hermes.mjs wires policy.currentVersions to {owe: OWE_PRODUCER_VERSION,
// reconnect: PRODUCER_VERSION}; here it's a plain stub so this file stays
// generic-alternation-only, per its own header comment.) A card already in
// rel.cards whose producer_version does not match currentVersions[kind] must
// not count as "already unjudged" -- but a kind whose version has not
// changed keeps behaving exactly as before.
test('a stale-version Owe card in the queue is not counted as unjudged; a fresh-version reconnect card still is', () => {
  const db = openDb(':memory:');
  // reconnect was shown recently so owe (never shown) goes first: P='owe', Q='reconnect'.
  insertShown(db, { kind: 'reconnect', createdAt: NOW - 1 * DAY });

  const staleOwe = card(db, 'owe', { producer_version: 'owe-v1' });
  const freshReconnect = card(db, 'reconnect', { producer_version: 'reconnect-current' });
  const rel = { cards: [staleOwe, freshReconnect], batch: { owe: null, reconnect: null }, refill: null };

  const oweProducer = stubProducer([]); // this round's pool happens to be empty too
  const reconnectProducer = stubProducer([card(db, 'reconnect')]);
  const policy = {
    producers: { owe: oweProducer, reconnect: reconnectProducer },
    currentVersions: { owe: 'owe-v2', reconnect: 'reconnect-current' },
  };

  const out = produceDailyBatch(db, policy, rel, { now: NOW });
  assert.equal(oweProducer.callCount(), 1,
    'the stale-version owe card did not satisfy hasUnjudgedOfKind -- a refill was attempted');
  assert.equal(reconnectProducer.callCount(), 0,
    'the fresh-version reconnect card DID satisfy hasUnjudgedOfKind -- no refill needed, unaffected by owe\'s version bump');
  assert.equal(out.servingKind, 'reconnect', 'owe produced nothing, so the request falls through to reconnect\'s unjudged card');
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


// ---- review findings 1/2: the CONSUMED model ------------------------------
// The queue's idea of "still owed to the owner" used to be "no accepted or
// dismissed row", which disagreed with the serve loop in two directions: a
// snapshot the owner MUTED stayed in the queue forever (the card's own "mute
// 30d" writes only a 'muted' row), and a card that cannot be served at all
// held its producer's turn. See the model comment in daily.mjs.

function insertEvent(db, snapshotId, event, createdAt = NOW) {
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    "VALUES ('name:whoever', 'x', ?, ?, NULL, NULL, 'v1', 'morning', ?)"
  ).run(snapshotId, event, createdAt);
}

test('a muted or suppressed snapshot is consumed; a shown or opened one is not', () => {
  assert.deepEqual([...CONSUMING_EVENTS], ['accepted', 'dismissed', 'muted', 'suppressed']);
  const db = openDb(':memory:');
  const live = card(db, 'owe');
  const shown = card(db, 'owe');
  const muted = card(db, 'owe');
  const suppressed = card(db, 'owe');
  insertEvent(db, shown.snapshot_id, 'shown');
  insertEvent(db, shown.snapshot_id, 'opened');
  insertEvent(db, muted.snapshot_id, 'muted');
  insertEvent(db, suppressed.snapshot_id, 'suppressed');

  assert.equal(isSnapshotConsumed(db, live.snapshot_id), false);
  assert.equal(isSnapshotConsumed(db, shown.snapshot_id), false,
    'showing a card is not the owner answering it');
  assert.equal(isSnapshotConsumed(db, muted.snapshot_id), true);
  assert.equal(isSnapshotConsumed(db, suppressed.snapshot_id), true);
});

test('a muted card no longer holds its kind\'s turn, and an unservable one does not either', () => {
  const db = openDb(':memory:');
  const mutedCard = card(db, 'owe');
  insertEvent(db, mutedCard.snapshot_id, 'muted');
  const deadCard = card(db, 'owe');

  const oweProducer = stubProducer([]);
  const policy = { producers: { owe: oweProducer, reconnect: stubProducer([]) } };
  const rel = { cards: [mutedCard, deadCard], batch: { owe: null, reconnect: null } };

  // Only the muted card is consumed; the other is refused by the caller's
  // own servability gate (its quote row is gone, say).
  const out = produceDailyBatch(db, policy, rel, { now: NOW });
  assert.equal(out.servingKind, 'owe',
    'with no servability gate supplied, the unconsumed dead card still counts as live');
  assert.equal(oweProducer.callCount(), 0, 'and it holds owe\'s turn: nothing was produced');

  const rel2 = { cards: [mutedCard, deadCard], batch: { owe: null, reconnect: null } };
  const policy2 = {
    producers: { owe: stubProducer([card(db, 'owe')]), reconnect: stubProducer([]) },
    servable: (c) => c.snapshot_id !== deadCard.snapshot_id,
  };
  const out2 = produceDailyBatch(db, policy2, rel2, { now: NOW });
  assert.equal(out2.servingKind, 'owe',
    'with the gate supplied, owe produced past both the muted and the unservable card');
  assert.equal(policy2.producers.owe.callCount(), 1);
});

test('liveQueuePersonKeys: the newest batch per mode, minus consumed, inside the window', () => {
  const db = openDb(':memory:');
  const batch = (createdAt, rows) => {
    const batchId = Number(db.prepare(
      'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, NULL)'
    ).run(createdAt, rows.length, 'open').lastInsertRowid);
    return rows.map(([personKey, mode]) => Number(db.prepare(
      'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
      "VALUES (?, ?, 'reconnect', 'summary', ?, 'v1', 'test', ?)"
    ).run(batchId, personKey, JSON.stringify({ mode }), createdAt).lastInsertRowid));
  };

  // Batches are inserted in time order, the way a running system writes
  // them (batch ids and created_at both increase).
  //
  // A batch older than the window comes first: the window is what stops a
  // permanently stale batch from wedging a person out of the other kind
  // forever.
  batch(NOW - 40 * DAY, [['name:ancient', 'any']]);
  // Then an 'any' batch and a NEWER 'investor' one: modes are queues, so the
  // investor batch must not hide the still-live 'any' one.
  const [anyLive, anyJudged] = batch(NOW - 2 * DAY, [['name:any live', 'any'], ['name:any judged', 'any']]);
  const [investorLive] = batch(NOW - 1 * DAY, [['name:investor live', 'investor']]);
  insertEvent(db, anyJudged, 'dismissed', NOW - 1 * DAY);

  const keys = liveQueuePersonKeys(db, 'reconnect', { now: NOW });
  assert.deepEqual([...keys].sort(), ['name:any live', 'name:investor live']);
  assert.ok(Number.isInteger(anyLive) && Number.isInteger(investorLive));
  assert.equal(liveQueuePersonKeys(db, 'owe', { now: NOW }).size, 0, 'kind-scoped');
});

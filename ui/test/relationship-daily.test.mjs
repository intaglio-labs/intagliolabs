// Alternation (daily.mjs): pickProducer's "whose turn is it" and
// produceDailyBatch's production/serving decision. Producers are stubbed
// here -- owe.mjs and producer.mjs each have their own gate tests -- so
// these tests exercise ONLY the alternation and per-kind-throttle logic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/hermes.mjs';
import {
  CARD_PRODUCERS, CONSUMING_EVENTS, REFILL_RETRY_MS,
  isSnapshotConsumed, isSnapshotFresh, isSnapshotLive, liveQueuePersonKeys, pickProducer, produceDailyBatch,
} from '../server/relationship/daily.mjs';
// A NAMESPACE IMPORT for the first-load window, deliberately: a named import of
// an export the module does not have is a LINK error, and that fails this whole
// file with one unhelpful line instead of letting the two tests below say what
// they actually found.
import * as daily from '../server/relationship/daily.mjs';

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
  assert.deepEqual([...CARD_PRODUCERS], ['owe', 'reconnect', 'ask']);
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
  assert.equal(pickProducer(dbTie, { now: NOW, kinds: ['owe', 'reconnect'] }), 'owe', 'an exact tie resolves to CARD_PRODUCERS[0]');
  // With the third producer in the policy (2026-09-21), the kind never shown
  // is the least recently shown and goes first; the tie-break still holds
  // between the two that were.
  assert.equal(pickProducer(dbTie, { now: NOW }), 'ask', 'never shown beats shown five days ago');
  insertShown(dbTie, { kind: 'ask', createdAt: NOW - 5 * DAY });
  assert.equal(pickProducer(dbTie, { now: NOW }), 'owe', 'a three-way tie resolves to CARD_PRODUCERS[0]');
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

// ---- review F findings 4 + 8: ONE definition of live -----------------------
// Every test below is a fixture where the old behaviour and the new one
// disagree. See daily.mjs's LIVE model block.

// A snapshot of `kind` whose row was written `ageDays` ago -- what a batch
// nothing has re-produced past looks like after a producer_version bump or an
// exhausted pool.
function agedCard(db, kind, ageDays, { mode = null, evidence = {} } = {}) {
  cardSeq += 1;
  const createdAt = NOW - ageDays * DAY;
  const personKey = `name:aged-${kind}-${cardSeq}`;
  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
  ).run(createdAt, 'open').lastInsertRowid);
  const snapshotId = Number(db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    "VALUES (?, ?, ?, 'summary', ?, 'test-v1', 'test', ?)"
  ).run(batchId, personKey, kind, JSON.stringify({ mode, ...evidence }), createdAt).lastInsertRowid);
  return { personKey, name: 'X', kind, snapshot_id: snapshotId, evidence: { mode, ...evidence } };
}

// Several snapshots in ONE batch -- the shape liveQueuePersonKeys' QUEUED
// clause reads (newest batch per (kind, mode)), so a fixture testing the
// other four clauses is not silently reduced to its last row.
function agedBatch(db, kind, ageDays, specs) {
  const createdAt = NOW - ageDays * DAY;
  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, NULL)'
  ).run(createdAt, specs.length, 'open').lastInsertRowid);
  return specs.map(({ mode = null, evidence = {} }) => {
    cardSeq += 1;
    const personKey = `name:aged-${kind}-${cardSeq}`;
    const snapshotId = Number(db.prepare(
      'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
      "VALUES (?, ?, ?, 'summary', ?, 'test-v1', 'test', ?)"
    ).run(batchId, personKey, kind, JSON.stringify({ mode, ...evidence }), createdAt).lastInsertRowid);
    return { personKey, name: 'X', kind, snapshot_id: snapshotId, evidence: { mode, ...evidence } };
  });
}

test('an 8-day-old unconsumed card no longer holds its kind\'s turn, and leaves rel.cards', () => {
  const db = openDb(':memory:');
  // owe goes first (nothing shown). Its only queued card is older than the
  // live window: the exclusion set had already let that person go, so if the
  // turn check still counted it, owe would sit on a card nobody can be
  // offered -- while Owe's own pool was free to produce.
  const stale = agedCard(db, 'owe', 8);
  const rel = { cards: [stale], batch: { owe: null, reconnect: null }, refill: null };
  const oweProducer = stubProducer([card(db, 'owe')]);
  const policy = { producers: { owe: oweProducer, reconnect: stubProducer([]) } };

  const out = produceDailyBatch(db, policy, rel, { now: NOW });
  assert.equal(out.servingKind, 'owe');
  assert.equal(oweProducer.callCount(), 1, 'the stale card did not hold owe\'s turn: a refill ran');
  assert.ok(!rel.cards.some((c) => c.snapshot_id === stale.snapshot_id),
    'and the stale card was pruned out of the in-process queue rather than served');
});

test('a card just inside the window still holds its turn (the window is the only thing that changed)', () => {
  const db = openDb(':memory:');
  const fresh = agedCard(db, 'owe', 6);
  const rel = { cards: [fresh], batch: { owe: null, reconnect: null }, refill: null };
  const oweProducer = stubProducer([card(db, 'owe')]);
  const policy = { producers: { owe: oweProducer, reconnect: stubProducer([]) } };

  const out = produceDailyBatch(db, policy, rel, { now: NOW });
  assert.equal(out.servingKind, 'owe');
  assert.equal(oweProducer.callCount(), 0, 'a fresh unconsumed card still holds the turn');
  assert.equal(rel.cards.length, 1, 'and is not pruned');
});

test('isSnapshotFresh / isSnapshotLive: the age half of the model', () => {
  const db = openDb(':memory:');
  const stale = agedCard(db, 'owe', 8);
  const fresh = agedCard(db, 'owe', 1);
  assert.equal(isSnapshotFresh(db, stale.snapshot_id, { now: NOW }), false);
  assert.equal(isSnapshotFresh(db, fresh.snapshot_id, { now: NOW }), true);
  assert.equal(isSnapshotLive(db, stale.snapshot_id, { now: NOW }), false,
    'unconsumed but stale is not live');
  assert.equal(isSnapshotLive(db, fresh.snapshot_id, { now: NOW }), true);
  insertEvent(db, fresh.snapshot_id, 'muted');
  assert.equal(isSnapshotLive(db, fresh.snapshot_id, { now: NOW }), false, 'fresh but consumed is not live either');
  assert.equal(isSnapshotFresh(db, null, { now: NOW }), true, 'an unknown snapshot id is never called stale');
});

test('liveQueuePersonKeys: the mode filter (finding 8) -- an off-mode card does not hold the other kind out', () => {
  const db = openDb(':memory:');
  const anyCard = agedCard(db, 'reconnect', 1, { mode: 'any' });
  const investorCard = agedCard(db, 'reconnect', 0, { mode: 'investor' });

  // No mode: both modes' newest batches count, which is what the cross-kind
  // exclusion used to do unconditionally.
  assert.deepEqual(
    [...liveQueuePersonKeys(db, 'reconnect', { now: NOW })].sort(),
    [anyCard.personKey, investorCard.personKey].sort()
  );
  // Scoped to the mode the route would actually serve from: the investor
  // card cannot be shown while rel.mode is 'any', so it must not block Owe.
  assert.deepEqual(
    [...liveQueuePersonKeys(db, 'reconnect', { now: NOW, mode: 'any' })],
    [anyCard.personKey]
  );
  assert.deepEqual(
    [...liveQueuePersonKeys(db, 'reconnect', { now: NOW, mode: 'investor' })],
    [investorCard.personKey]
  );
});

test('liveQueuePersonKeys: servability in SQL (finding 8) -- suppressed, muted, quote gone, claim rejected', () => {
  const db = openDb(':memory:');
  const ctx = (text) => Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, '{}')"
  ).run(NOW - DAY, text).lastInsertRowid);
  const goodCtx = ctx('still here');
  const doomedCtx = ctx('about to go');
  const runId = Number(db.prepare(
    "INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at) " +
    "VALUES ('m', 'p', 's', '{}', 'on', 1, 1, 'complete', ?, ?)"
  ).run(NOW - DAY, NOW - DAY).lastInsertRowid);
  const claim = (text) => Number(db.prepare(
    "INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, created_at) " +
    "VALUES (?, 'owner', NULL, 'commitment', ?, ?, ?)"
  ).run(runId, text, NOW - DAY, NOW - DAY).lastInsertRowid);
  const liveClaim = claim('I will send it');
  const rejectedClaim = claim('I will send the other thing');
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, 'reject', 'owner', NULL, ?)")
    .run(rejectedClaim, NOW - DAY);

  const [ok, quoteGone, claimRejected, claimGone, suppressed, muted] = agedBatch(db, 'reconnect', 1, [
    { mode: 'any', evidence: { quote_context_id: goodCtx, commitment_claim_id: liveClaim } },
    { mode: 'any', evidence: { quote_context_id: doomedCtx } },
    { mode: 'any', evidence: { commitment_claim_id: rejectedClaim } },
    { mode: 'any', evidence: { commitment_claim_id: 999_999 } },
    { mode: 'any' },
    { mode: 'any' },
  ]);
  db.prepare('DELETE FROM context WHERE id = ?').run(doomedCtx);
  db.prepare('INSERT INTO rm_suppression(person_key, created_at) VALUES (?, ?)').run(suppressed.personKey, NOW);
  db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, NULL, ?, ?)')
    .run(muted.personKey, NOW + 30 * DAY, NOW);

  const keys = liveQueuePersonKeys(db, 'reconnect', { now: NOW, mode: 'any' });
  assert.deepEqual([...keys], [ok.personKey],
    'a card that cannot be served does not hold a person out of the other kind');
  assert.ok(!keys.has(quoteGone.personKey), 'the quote row is gone: nothing to show');
  assert.ok(!keys.has(claimRejected.personKey), 'the commitment was rejected between produce and now');
  assert.ok(!keys.has(claimGone.personKey), 'the commitment claim itself is gone');
  assert.ok(!keys.has(suppressed.personKey));
  assert.ok(!keys.has(muted.personKey));
});

test('liveQueuePersonKeys: an expired mute lifts, and a kind-scoped mute stays scoped', () => {
  const db = openDb(':memory:');
  const [expired, otherKind] = agedBatch(db, 'reconnect', 1, [{ mode: 'any' }, { mode: 'any' }]);
  db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, NULL, ?, ?)')
    .run(expired.personKey, NOW - DAY, NOW - 10 * DAY);
  db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, ?, ?, ?)')
    .run(otherKind.personKey, 'owe', NOW + 30 * DAY, NOW);

  const keys = liveQueuePersonKeys(db, 'reconnect', { now: NOW, mode: 'any' });
  assert.deepEqual([...keys].sort(), [expired.personKey, otherKind.personKey].sort(),
    'a lapsed mute is not a block, and an owe-scoped mute says nothing about a reconnect card');
});

test('liveQueuePersonKeys: producerVersion and the caller\'s own servable gate', () => {
  const db = openDb(':memory:');
  const one = agedCard(db, 'reconnect', 1, { mode: 'any' });
  assert.equal(liveQueuePersonKeys(db, 'reconnect', { now: NOW, producerVersion: 'test-v1' }).size, 1);
  assert.equal(liveQueuePersonKeys(db, 'reconnect', { now: NOW, producerVersion: 'test-v2' }).size, 0,
    'a batch produced under rules already rejected is not a live queue');
  assert.equal(
    liveQueuePersonKeys(db, 'reconnect', { now: NOW, servable: (c) => c.personKey !== one.personKey }).size,
    0,
    'the caller\'s alias-folding gate refuses it too'
  );
  const seen = [];
  liveQueuePersonKeys(db, 'reconnect', { now: NOW, servable: (c) => { seen.push(c); return true; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].snapshot_id, one.snapshot_id);
  assert.equal(seen[0].kind, 'reconnect');
  assert.equal(seen[0].quoteContextId, null, 'decoded the same way hydrateCards decodes evidence');
});

// ---- the first load's own refill window ----------------------------------
//
// The quarter hour protects a steady-state machine: an empty pool a minute ago
// is almost certainly empty now, so re-running the producer per poll buys an
// empty batch. On a first load neither half holds -- the daemon's sprint is
// filling the pool while the owner watches the setup screen -- and on run 3 a
// fresh Mac was told to come back in 13.5 minutes about a pool that had just
// gained people.
test('the refill window is a minute until the first reconnect card has been shown', () => {
  const db = openDb(':memory:');
  assert.equal(daily.FIRST_LOAD_REFILL_RETRY_MS, 60_000);
  assert.equal(daily.refillRetryMsFor(db), daily.FIRST_LOAD_REFILL_RETRY_MS, 'nothing shown: still the first load');

  // An OWE card is not the end of it: the first load is about the pool the
  // sprint fills, and that is reconnect's.
  insertShown(db, { kind: 'owe', createdAt: NOW });
  assert.equal(daily.refillRetryMsFor(db), daily.FIRST_LOAD_REFILL_RETRY_MS);

  insertShown(db, { kind: 'reconnect', createdAt: NOW });
  assert.equal(daily.refillRetryMsFor(db), REFILL_RETRY_MS, 'one card served ends it, permanently');
});

test('a database that cannot answer keeps the long window', () => {
  // This is an optimisation for a state we can recognise; "could not tell" is
  // not that state, and guessing short would re-run a producer every minute
  // for the life of the process.
  const broken = { prepare() { throw new Error('no such table: rm_card_event'); } };
  assert.equal(daily.refillRetryMsFor(broken), REFILL_RETRY_MS);
});

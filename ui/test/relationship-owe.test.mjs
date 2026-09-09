// The Owe producer (owe.mjs): no model, one SQL statement per candidate
// shape (open-loop, expired-commitment) plus a small JS ranking pass. Built
// on hermes' own schema (openDb(':memory:')), same discipline as
// relationship-producer.test.mjs: every gate exercised against the real
// tables the projection and the distiller actually write.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/hermes.mjs';
import {
  isAskText, owePool, produceOweBatch,
  OWE_PRODUCER_VERSION, OWE_RANK_STRATEGY,
} from '../server/relationship/owe.mjs';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;

function insertPerson(db, { key, name, role = 'friend', sent, received, met = 0 }) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, NOW - 400 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY,
    sent, received, met, 0, sent + received, 0, role, '{}', null, NOW);
}

// A single message row: authored=1 is "from them", owner_authored=1 is "from
// the owner", room=1 is a group thread. Each call is its own context row, so
// an authored-then-owner-authored pair for the same person never collides on
// person_event_links' (person_key, context_id, role) primary key.
function insertMsg(db, key, { ts = NOW - 200 * DAY, text = 'hi', authored = 0, ownerAuthored = 0, room = 0, source = 'imessage' } = {}) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, ?, ?, '{}')"
  ).run(ts, source, text).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, ?, 'counterparty', ?, ?, ?, 1, 'conv')`
  ).run(key, ctxId, source, authored ? 1 : 0, ownerAuthored ? 1 : 0, room ? 1 : 0);
  return ctxId;
}

// OWE_MIN_OWNER_MESSAGES requires >= 2 owner-authored, room=0 rows for the
// person. Placed well before `before` (default: long before any ask in these
// fixtures) so it never trips a B2 "no owner reply after the ask" exclusion
// and, for open-loop fixtures, stays earlier than the "them" ask so the loop
// itself is not closed by it (open-loop requires last-owner ts < last-them ts).
function insertOwnerParticipation(db, key, { before = NOW - 300 * DAY } = {}) {
  insertMsg(db, key, { ts: before, text: 'checking in', ownerAuthored: 1 });
  insertMsg(db, key, { ts: before - 1 * DAY, text: 'hey', ownerAuthored: 1 });
}

function insertDistillRun(db, now = NOW) {
  return Number(db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context,
       rows_in, claims_out, status, started_at, ended_at)
     VALUES ('test-model', 'test/prompt.md', 'sha', '{}', 'on', 1, 1, 'complete', ?, ?)`
  ).run(now, now).lastInsertRowid);
}

function insertOwnerCommitmentClaim(db, { runId, text = 'I will send the deck', observedAt, validTo }) {
  return Number(db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'owner', NULL, 'commitment', ?, ?, ?, NULL, ?)`
  ).run(runId, text, observedAt, validTo, observedAt).lastInsertRowid);
}

function insertAskClaim(db, { runId, personKey, text = 'can you help me with this?' }) {
  return Number(db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'person', ?, 'fact', ?, NULL, NULL, NULL, ?)`
  ).run(runId, personKey, text, NOW).lastInsertRowid);
}

function acceptClaim(db, claimId, now = NOW) {
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, 'accept', 'owner', NULL, ?)").run(claimId, now);
}
function rejectClaim(db, claimId, now = NOW) {
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, 'reject', 'owner', NULL, ?)").run(claimId, now);
}

function insertClaimSource(db, { claimId, contextId, source = 'imessage', quote = 'quote' }) {
  db.prepare(
    'INSERT INTO claim_source(claim_id, context_id, source, entity_id, content_hash, quote) VALUES (?, ?, ?, NULL, NULL, ?)'
  ).run(claimId, contextId, source, quote);
}

function insertPageItem(db, { claimId, section = 'ask', builtAt = NOW }) {
  db.prepare('INSERT INTO person_page_item(claim_id, section, built_at) VALUES (?, ?, ?)').run(claimId, section, builtAt);
}

// A bare context row, with NO person_event_links row -- used for a page
// ask's own source context so the fixture exercises ONLY the B2 (page ask)
// path. A context that also carries an authored=1 link independently
// qualifies as an owe:open-loop candidate (a real, unrelated ask), which
// would make these tests unable to tell the two paths apart.
function insertContext(db, { ts = NOW, text = 'hi', source = 'imessage' } = {}) {
  return Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, ?, ?, '{}')"
  ).run(ts, source, text).lastInsertRowid);
}

function keysOf(pool) { return pool.map((c) => c.personKey); }

// ---- 1: isAskText -----------------------------------------------------
test('isAskText: ends in "?", 8..400 chars', () => {
  assert.ok(isAskText('can you help me?'));
  assert.ok(!isAskText('can you help me'), 'no trailing ? -- not a question');
  assert.ok(!isAskText('ok?'), 'under 8 chars');
  assert.ok(!isAskText('a'.repeat(401) + '?'), 'over 400 chars');
  assert.ok(!isAskText(null));
  assert.ok(!isAskText(undefined));
  assert.ok(isAskText('  can you help me?  '), 'trims before measuring');
});

// ---- 2: open-loop day-window gate --------------------------------------
test('owe:open-loop is present at 12 days, absent at 1 and 90', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:asked twelve', name: 'Asked Twelve', sent: 10, received: 10 });
  insertMsg(db, 'name:asked twelve', { ts: NOW - 12 * DAY, text: 'can you send that over?', authored: 1 });
  insertOwnerParticipation(db, 'name:asked twelve');

  insertPerson(db, { key: 'name:asked one', name: 'Asked One', sent: 10, received: 10 });
  insertMsg(db, 'name:asked one', { ts: NOW - 1 * DAY, text: 'can you send that over?', authored: 1 });

  insertPerson(db, { key: 'name:asked ninety', name: 'Asked Ninety', sent: 10, received: 10 });
  insertMsg(db, 'name:asked ninety', { ts: NOW - 90 * DAY, text: 'can you send that over?', authored: 1 });

  const pool = owePool(db, { now: NOW });
  const keys = keysOf(pool);
  assert.ok(keys.includes('name:asked twelve'), '12 days is inside [3,60]');
  assert.ok(!keys.includes('name:asked one'), '1 day is inside the reply-window grace period');
  assert.ok(!keys.includes('name:asked ninety'), '90 days is past the 60-day stale cutoff');

  const twelve = pool.find((c) => c.personKey === 'name:asked twelve');
  assert.equal(twelve.oweKind, 'owe:open-loop');
  assert.equal(twelve.overdueDays, 12);
});

// ---- 3: an owner reply after the ask removes the open loop -------------
test('an owner reply after the ask closes the open loop', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:replied to', name: 'Replied To', sent: 10, received: 10 });
  insertMsg(db, 'name:replied to', { ts: NOW - 12 * DAY, text: 'can you send that over?', authored: 1 });
  insertMsg(db, 'name:replied to', { ts: NOW - 5 * DAY, text: 'sent!', ownerAuthored: 1 });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(!keys.includes('name:replied to'), 'the owner already answered after the ask');
});

// ---- 4: cc-only (never authored) is never an open loop -----------------
test('a cc-only row (authored=0) never produces an open loop', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:cc only', name: 'Cc Only', sent: 10, received: 10 });
  insertMsg(db, 'name:cc only', { ts: NOW - 12 * DAY, text: 'can you send that over?', authored: 0 });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(!keys.includes('name:cc only'), 'never authored: not "them asking"');
});

// ---- 5: expired owner commitment, keyed to the counterparty -----------
test('an expired owner commitment produces a candidate keyed to the counterparty; a room=1 source does not', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);

  insertPerson(db, { key: 'name:commitment counterparty', name: 'Commitment Counterparty', sent: 10, received: 10 });
  const observedAt = NOW - 100 * DAY;
  const validTo = NOW - 20 * DAY;
  const claimId = insertOwnerCommitmentClaim(db, { runId, observedAt, validTo });
  acceptClaim(db, claimId, observedAt);
  const sourceCtx = insertMsg(db, 'name:commitment counterparty', { ts: observedAt, text: 'ok, will do', ownerAuthored: 1 });
  insertClaimSource(db, { claimId, contextId: sourceCtx, quote: 'ok, will do' });
  // Their own earlier message, before observedAt -- the quote the candidate resolves.
  const theirMsgCtx = insertMsg(db, 'name:commitment counterparty', { ts: observedAt - 1 * DAY, text: 'please send the deck', authored: 1 });
  // The commitment's own source counts as one owner-authored row; a second,
  // unrelated one clears OWE_MIN_OWNER_MESSAGES.
  insertMsg(db, 'name:commitment counterparty', { ts: observedAt - 50 * DAY, text: 'hey', ownerAuthored: 1 });

  const pool = owePool(db, { now: NOW });
  const cand = pool.find((c) => c.personKey === 'name:commitment counterparty');
  assert.ok(cand, 'the expired commitment reaches the counterparty');
  assert.equal(cand.oweKind, 'owe:expired-commitment');
  assert.equal(cand.overdueDays, 20);
  assert.equal(cand.commitmentClaimId, claimId);
  assert.equal(cand.quoteContextId, theirMsgCtx, 'the quote is their latest authored row before observedAt');

  // A second commitment whose only source link is room=1 (a group thread):
  // no single counterparty, so no candidate.
  insertPerson(db, { key: 'name:room commitment', name: 'Room Commitment', sent: 10, received: 10 });
  const roomObservedAt = NOW - 90 * DAY;
  const roomValidTo = NOW - 15 * DAY;
  const roomClaimId = insertOwnerCommitmentClaim(db, { runId, observedAt: roomObservedAt, validTo: roomValidTo, text: 'will follow up' });
  acceptClaim(db, roomClaimId, roomObservedAt);
  const roomCtx = insertMsg(db, 'name:room commitment', { ts: roomObservedAt, text: 'sounds good', ownerAuthored: 1, room: 1 });
  insertClaimSource(db, { claimId: roomClaimId, contextId: roomCtx, quote: 'sounds good' });

  const pool2 = owePool(db, { now: NOW });
  assert.ok(!keysOf(pool2).includes('name:room commitment'), 'a room=1 source produces no candidate');
});

// ---- 6: unanswered page ask ---------------------------------------------
test('a 20-day-unanswered page ask produces a candidate; a later owner reply or a rejected ask does not', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);

  insertPerson(db, { key: 'name:unanswered ask', name: 'Unanswered Ask', sent: 10, received: 10 });
  const askCtx = insertContext(db, { ts: NOW - 20 * DAY, text: 'can you make an intro?' });
  const claimId = insertAskClaim(db, { runId, personKey: 'name:unanswered ask' });
  insertClaimSource(db, { claimId, contextId: askCtx, quote: 'can you make an intro?' });
  insertPageItem(db, { claimId, section: 'ask' });
  insertOwnerParticipation(db, 'name:unanswered ask', { before: NOW - 40 * DAY });

  const pool = owePool(db, { now: NOW });
  const cand = pool.find((c) => c.personKey === 'name:unanswered ask');
  assert.ok(cand, 'a 20-day-old unanswered ask (>= the 14-day floor) is a candidate');
  assert.equal(cand.oweKind, 'owe:expired-commitment');
  assert.equal(cand.overdueDays, 20);
  assert.equal(cand.commitmentClaimId, claimId);

  // A later owner reply closes it.
  insertPerson(db, { key: 'name:answered ask', name: 'Answered Ask', sent: 10, received: 10 });
  const answeredAskCtx = insertContext(db, { ts: NOW - 20 * DAY, text: 'can you make an intro?' });
  const answeredClaimId = insertAskClaim(db, { runId, personKey: 'name:answered ask' });
  insertClaimSource(db, { claimId: answeredClaimId, contextId: answeredAskCtx, quote: 'can you make an intro?' });
  insertPageItem(db, { claimId: answeredClaimId, section: 'ask' });
  insertMsg(db, 'name:answered ask', { ts: NOW - 5 * DAY, text: 'yes, introduced you', ownerAuthored: 1 });

  // A rejected ask never counts.
  insertPerson(db, { key: 'name:rejected ask', name: 'Rejected Ask', sent: 10, received: 10 });
  const rejectedAskCtx = insertContext(db, { ts: NOW - 20 * DAY, text: 'can you make an intro?' });
  const rejectedClaimId = insertAskClaim(db, { runId, personKey: 'name:rejected ask' });
  insertClaimSource(db, { claimId: rejectedClaimId, contextId: rejectedAskCtx, quote: 'can you make an intro?' });
  insertPageItem(db, { claimId: rejectedClaimId, section: 'ask' });
  rejectClaim(db, rejectedClaimId);

  const pool2 = owePool(db, { now: NOW });
  const keys2 = keysOf(pool2);
  assert.ok(!keys2.includes('name:answered ask'), 'an owner reply after the ask closes it');
  assert.ok(!keys2.includes('name:rejected ask'), 'a rejected ask claim never becomes a candidate');
});

// ---- 7: suppression / mute / anonymous ---------------------------------
test('suppression, an owe-scoped mute, and an anonymous contact all exclude; a reconnect-scoped mute does not', () => {
  const db = openDb(':memory:');
  const mk = (key, name) => {
    insertPerson(db, { key, name, sent: 10, received: 10 });
    insertMsg(db, key, { ts: NOW - 12 * DAY, text: 'can you help with this?', authored: 1 });
    insertOwnerParticipation(db, key);
  };

  mk('name:owe suppressed', 'Owe Suppressed');
  db.prepare('INSERT INTO rm_suppression(person_key, created_at) VALUES (?, ?)').run('name:owe suppressed', NOW);

  mk('name:owe muted', 'Owe Muted');
  db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, ?, ?, ?)')
    .run('name:owe muted', 'owe', NOW + 10 * DAY, NOW);

  mk('name:reconnect muted', 'Reconnect Muted');
  db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, ?, ?, ?)')
    .run('name:reconnect muted', 'reconnect', NOW + 10 * DAY, NOW);

  insertPerson(db, { key: 'id:+15555550100', name: '', sent: 10, received: 10 });
  insertMsg(db, 'id:+15555550100', { ts: NOW - 12 * DAY, text: 'can you help with this?', authored: 1 });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(!keys.includes('name:owe suppressed'), 'suppression excludes');
  assert.ok(!keys.includes('name:owe muted'), 'a kind=owe mute excludes');
  assert.ok(keys.includes('name:reconnect muted'), 'a kind=reconnect mute does not touch the owe pool');
  assert.ok(!keys.includes('id:+15555550100'), 'an anonymous (nameless) contact is excluded');
});

// ---- 8: judged/shown cross-kind interaction -----------------------------
test('a reconnect-kind dismissal still reaches Owe; a shown card of ANY kind cools Owe down for 7 days', () => {
  const db = openDb(':memory:');
  const mk = (key, name) => {
    insertPerson(db, { key, name, sent: 10, received: 10 });
    insertMsg(db, key, { ts: NOW - 12 * DAY, text: 'can you help with this?', authored: 1 });
    insertOwnerParticipation(db, key);
  };

  mk('name:judged reconnect', 'Judged Reconnect');
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('name:judged reconnect', 'reconnect', null, 'dismissed', 'not-useful', null, 'reconnect-v1', 'morning', NOW - 1 * DAY);

  mk('name:shown reconnect recent', 'Shown Reconnect Recent');
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('name:shown reconnect recent', 'reconnect', null, 'shown', null, null, 'reconnect-v1', 'morning', NOW - 2 * DAY);

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(keys.includes('name:judged reconnect'), 'a dismissal under kind=reconnect does not bar Owe');
  assert.ok(!keys.includes('name:shown reconnect recent'), 'shown 2 days ago, any kind, cools every producer down for 7 days');
});

// ---- 8b: a stale-version judged card still excludes its person ----------
// The judged gate (rm_card_event by person_key + kind) has never keyed on
// producer_version -- it can't, the event row doesn't carry one. This test
// pins that: a snapshot written under an OLD OWE_PRODUCER_VERSION, then
// judged, must keep excluding its person from a POOL BUILT UNDER THE NEW
// VERSION, exactly as it would if the snapshot were current. The version
// bump in owe.mjs (c509f3f: anonymous-name/B2/owner-participation gates)
// voids the unjudged QUEUE a stale version produced; it must not un-void an
// owner's actual judgment.
test('a stale-version (owe-v1) judged snapshot still excludes its person from the current (owe-v2) pool', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:stale judged', name: 'Stale Judged', sent: 10, received: 10 });
  insertMsg(db, 'name:stale judged', { ts: NOW - 12 * DAY, text: 'can you help with this?', authored: 1 });
  insertOwnerParticipation(db, 'name:stale judged');

  assert.ok(keysOf(owePool(db, { now: NOW })).includes('name:stale judged'),
    'sanity: with no judgment yet, this person is a live Owe candidate');

  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
  ).run(NOW - 5 * DAY, 'open').lastInsertRowid);
  const snapshotId = Number(db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    "VALUES (?, 'name:stale judged', 'owe', 'old summary', '{}', 'owe-v1', 'owe-overdue-days', ?)"
  ).run(batchId, NOW - 5 * DAY).lastInsertRowid);
  assert.notEqual('owe-v1', OWE_PRODUCER_VERSION, 'the seeded version really is stale relative to the live constant');

  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('name:stale judged', 'owe', snapshotId, 'dismissed', 'not-useful', null, 'owe-v1', 'morning', NOW - 4 * DAY);

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(!keys.includes('name:stale judged'),
    'dismissed under the old version still bars them from today\'s (owe-v2) pool');
});

// ---- 9: no MIN_DEPTH floor ----------------------------------------------
test('a thin 4-message relationship still reaches the owe pool (no MIN_DEPTH floor)', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:thin owe', name: 'Thin Owe', sent: 2, received: 2 });
  insertMsg(db, 'name:thin owe', { ts: NOW - 12 * DAY, text: 'can you help with this?', authored: 1 });
  insertOwnerParticipation(db, 'name:thin owe');

  assert.ok(keysOf(owePool(db, { now: NOW })).includes('name:thin owe'));
});

// ---- 10: exact ranking ---------------------------------------------------
test('ranking: overdueDays desc, expired-commitment before open-loop, depth desc, personKey asc', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);

  // Two candidates tied at overdueDays=20: one open-loop, one expired-commitment.
  // Expired-commitment must sort first.
  insertPerson(db, { key: 'name:rank openloop20', name: 'Rank OpenLoop20', sent: 10, received: 10 });
  insertMsg(db, 'name:rank openloop20', { ts: NOW - 20 * DAY, text: 'can you help with this?', authored: 1 });
  insertOwnerParticipation(db, 'name:rank openloop20');

  insertPerson(db, { key: 'name:rank commit20', name: 'Rank Commit20', sent: 10, received: 10 });
  const c20 = insertOwnerCommitmentClaim(db, { runId, observedAt: NOW - 100 * DAY, validTo: NOW - 20 * DAY });
  acceptClaim(db, c20, NOW - 100 * DAY);
  const ctx20 = insertMsg(db, 'name:rank commit20', { ts: NOW - 100 * DAY, text: 'ok', ownerAuthored: 1 });
  insertClaimSource(db, { claimId: c20, contextId: ctx20, quote: 'ok' });
  insertMsg(db, 'name:rank commit20', { ts: NOW - 150 * DAY, text: 'hey', ownerAuthored: 1 });

  // Two open-loop candidates tied at overdueDays=30, differing depth: higher
  // depth (more messages) ranks first.
  insertPerson(db, { key: 'name:rank depth high', name: 'Rank Depth High', sent: 40, received: 40 });
  insertMsg(db, 'name:rank depth high', { ts: NOW - 30 * DAY, text: 'can you help with this?', authored: 1 });
  insertOwnerParticipation(db, 'name:rank depth high');
  insertPerson(db, { key: 'name:rank depth low', name: 'Rank Depth Low', sent: 5, received: 5 });
  insertMsg(db, 'name:rank depth low', { ts: NOW - 30 * DAY, text: 'can you help with this?', authored: 1 });
  insertOwnerParticipation(db, 'name:rank depth low');

  const pool = owePool(db, { now: NOW });
  const keys = keysOf(pool);
  assert.deepEqual(keys, [
    'name:rank depth high',
    'name:rank depth low',
    'name:rank commit20',
    'name:rank openloop20',
  ], 'overdueDays 30 (depth 80 then depth 10) before overdueDays 20 (commitment before open-loop)');
});

// ---- 11: produceOweBatch shape ------------------------------------------
test('produceOweBatch writes kind "owe", producer_version "owe-v1", evidence.owe_kind, mode null, and no source text in the summary', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:batch open loop', name: 'Batch Open Loop', sent: 10, received: 10 });
  const askText = 'can you send the secret file over?';
  insertMsg(db, 'name:batch open loop', { ts: NOW - 12 * DAY, text: askText, authored: 1 });
  insertOwnerParticipation(db, 'name:batch open loop');

  const { batchId, cards } = produceOweBatch(db, { now: NOW });
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.kind, 'owe');
  assert.equal(card.producer_version, OWE_PRODUCER_VERSION);
  assert.equal(card.rank_strategy, OWE_RANK_STRATEGY);
  assert.equal(card.evidence.owe_kind, 'owe:open-loop');
  assert.equal(card.evidence.mode, null);
  assert.ok(!card.sentence.includes(askText), 'the tie sentence is a template, never source text');

  const row = db.prepare('SELECT kind, producer_version FROM rm_candidate_snapshot WHERE id = ?').get(card.snapshot_id);
  assert.equal(row.kind, 'owe');
  assert.equal(row.producer_version, OWE_PRODUCER_VERSION);
  const batch = db.prepare('SELECT candidate_count FROM rm_candidate_batch WHERE id = ?').get(batchId);
  assert.equal(batch.candidate_count, 1);
});

// ---- 12: the bulk-sender fixture, excluded three independent ways --------
// The live junk this task exists to remove: id:+18447640222, display_name
// '+18447640222' (a bare phone number, and the key's own id: prefix
// stripped), role friend, sent 1 / received 236, an unanswered page 'ask'
// 1,173 days old -- an automated ticketing SMS service. Each of the three
// new gates (isAnonymousContact's phone-number rule, COMMITMENT_MAX_STALE_DAYS
// now applied to B2, and OWE_MIN_OWNER_MESSAGES) excludes it on its own;
// toggle the other two to "pass" in each variant to prove that gate is
// independently sufficient.
test('the bulk-sender fixture is excluded for three independent reasons', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);

  function makeAsk(personKey, { name, askDaysAgo, ownerMessages }) {
    insertPerson(db, { key: personKey, name, sent: 1, received: 236 });
    const askCtx = insertContext(db, { ts: NOW - askDaysAgo * DAY, text: 'can you help with this?' });
    const claimId = insertAskClaim(db, { runId, personKey });
    insertClaimSource(db, { claimId, contextId: askCtx, quote: 'can you help with this?' });
    insertPageItem(db, { claimId, section: 'ask' });
    // Well before the ask, so these never trip the "no owner reply after
    // the ask" exclusion.
    for (let i = 0; i < ownerMessages; i += 1) {
      insertMsg(db, personKey, { ts: NOW - (askDaysAgo + 50 + i) * DAY, text: 'hey', ownerAuthored: 1 });
    }
  }

  // Staleness alone: a real name and 2 owner messages, but the ask is 1,173
  // days old -- past the 180-day COMMITMENT_MAX_STALE_DAYS bound.
  makeAsk('id:stale only', { name: 'Stale Only', askDaysAgo: 1173, ownerMessages: 2 });

  // Owner-participation alone: a real name and a 20-day-old ask (inside the
  // window), but only 1 owner-authored message ever.
  makeAsk('id:thin only', { name: 'Thin Only', askDaysAgo: 20, ownerMessages: 1 });

  // Anonymous-contact alone: a bare-phone-number name, a 20-day-old ask, 2
  // owner messages.
  makeAsk('id:+18447640222 solo', { name: '+18447640222', askDaysAgo: 20, ownerMessages: 2 });

  // The real fixture: all three at once.
  makeAsk('id:+18447640222', { name: '+18447640222', askDaysAgo: 1173, ownerMessages: 1 });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(!keys.includes('id:stale only'), 'staleness alone excludes it');
  assert.ok(!keys.includes('id:thin only'), 'thin owner participation alone excludes it');
  assert.ok(!keys.includes('id:+18447640222 solo'), 'a bare-phone-number name alone excludes it');
  assert.ok(!keys.includes('id:+18447640222'), 'the real fixture, excluded three times over');
});

// ---- 13: a LinkedIn-keyed contact never written to is not an open loop ---
test('a LinkedIn-keyed contact with zero owner messages is not an open loop, even with a real name and a "?" line', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'id:liname:jane-doe-123', name: 'Jane Doe', sent: 0, received: 6 });
  insertMsg(db, 'id:liname:jane-doe-123', { ts: NOW - 12 * DAY, text: 'are you free to catch up sometime?', authored: 1 });
  // No owner-authored message at all: the owner has never written to her.

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(!keys.includes('id:liname:jane-doe-123'), 'zero owner-authored messages: not owed');
});

// ---- 14: a thin real exchange still counts as owed ------------------------
test('a person with 2 owner messages and an unanswered "?" 12 days ago is still an open loop', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:thin real exchange', name: 'Thin Real Exchange', sent: 2, received: 1 });
  insertOwnerParticipation(db, 'name:thin real exchange');
  insertMsg(db, 'name:thin real exchange', { ts: NOW - 12 * DAY, text: 'can you help with this?', authored: 1 });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(keys.includes('name:thin real exchange'), 'exactly 2 owner messages clears OWE_MIN_OWNER_MESSAGES');
});

// ---- 15: mail thread attribution (review finding 3) -----------------------
// threadKind() answers DIRECT for source='mail' (an email is not a room), so
// the projection writes a room=0 link for EVERY non-owner address on the
// message. B1's old `JOIN person_event_links ... room = 0` therefore turned
// one owner commitment into one overdue card per recipient of the thread. The
// counterparty must be the source row's SOLE non-owner participant.

// One mail context row plus a room=0 recipient link per person named in
// `recipientKeys` -- exactly the shape graph.mjs's mail branch writes.
function insertMailThread(db, { ts, recipientKeys, meta }) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'mail', ?, ?)"
  ).run(ts, '"re: the deck"\n\nwill send it over', JSON.stringify(meta)).lastInsertRowid);
  for (const key of recipientKeys) {
    db.prepare(
      `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
       VALUES (?, ?, 'mail', 'recipient', 0, 1, 0, 1, 'thread')`
    ).run(key, ctxId);
  }
  return ctxId;
}

function seedMailCommitment(db, { recipientKeys, meta }) {
  const observedAt = NOW - 100 * DAY;
  const runId = insertDistillRun(db);
  const claimId = insertOwnerCommitmentClaim(db, {
    runId, text: 'I will send the deck', observedAt, validTo: NOW - 20 * DAY,
  });
  acceptClaim(db, claimId, observedAt);
  const ctxId = insertMailThread(db, { ts: observedAt, recipientKeys, meta });
  insertClaimSource(db, { claimId, contextId: ctxId, source: 'mail', quote: 'will send it over' });
  return { claimId, ctxId };
}

test('one commitment on a three-recipient email produces NO candidate; the same commitment on a two-party email produces exactly one', () => {
  const db = openDb(':memory:');
  for (const [key, name] of [['name:mail a', 'Mail A'], ['name:mail b', 'Mail B'], ['name:mail c', 'Mail C']]) {
    insertPerson(db, { key, name, sent: 10, received: 10 });
    insertOwnerParticipation(db, key);
  }
  seedMailCommitment(db, {
    recipientKeys: ['name:mail a', 'name:mail b', 'name:mail c'],
    meta: { from: ['owner@example.com'], to: ['a@example.com', 'b@example.com', 'c@example.com'], cc: [] },
  });

  const keys = keysOf(owePool(db, { now: NOW }));
  for (const key of ['name:mail a', 'name:mail b', 'name:mail c']) {
    assert.ok(!keys.includes(key),
      `${key} is not owed a card for a commitment made to a whole thread (was: one card each)`);
  }

  // The same fixture with a single counterparty still attributes -- the gate
  // must narrow the fan-out, not close the path.
  const solo = openDb(':memory:');
  insertPerson(solo, { key: 'name:mail solo', name: 'Mail Solo', sent: 10, received: 10 });
  insertOwnerParticipation(solo, 'name:mail solo');
  seedMailCommitment(solo, {
    recipientKeys: ['name:mail solo'],
    meta: { from: ['owner@example.com'], to: ['solo@example.com'], cc: [] },
  });
  const soloCandidate = owePool(solo, { now: NOW }).find((c) => c.personKey === 'name:mail solo');
  assert.ok(soloCandidate, 'a two-party email still attributes the commitment');
  assert.equal(soloCandidate.oweKind, 'owe:expired-commitment');
});

test('a second recipient the projection never resolved into a person still blocks attribution', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:mail known', name: 'Mail Known', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:mail known');
  // ONE room=0 link (the only address that resolved) but THREE addresses on
  // the message: the link count alone would call this a private conversation.
  seedMailCommitment(db, {
    recipientKeys: ['name:mail known'],
    meta: {
      from: ['owner@example.com'],
      to: ['known@example.com'],
      cc: ['stranger@example.com'],
    },
  });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.ok(!keys.includes('name:mail known'),
    'a cc the contacts spine never resolved still makes this a group thread');
});

test('a commitment with two receipts is attributed once, through the receipt the claim was read from', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:receipt first', name: 'Receipt First', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:receipt first');
  insertPerson(db, { key: 'name:receipt second', name: 'Receipt Second', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:receipt second');

  const { claimId } = seedMailCommitment(db, {
    recipientKeys: ['name:receipt first'],
    meta: { from: ['owner@example.com'], to: ['first@example.com'], cc: [] },
  });
  // A SECOND receipt of the same sentence, in a different conversation. One
  // thing the owner said once must not become two people's overdue cards.
  // The first receipt still wins here, but under review F finding 7's rule
  // it wins because it is the latest receipt at or before the claim's own
  // observed_at (this one is a day AFTER it -- a later re-mention), not
  // because it was ingested first. See the two fixtures at the end of this
  // file where those two rules disagree.
  const secondCtx = insertMailThread(db, {
    ts: NOW - 99 * DAY,
    recipientKeys: ['name:receipt second'],
    meta: { from: ['owner@example.com'], to: ['second@example.com'], cc: [] },
  });
  insertClaimSource(db, { claimId, contextId: secondCtx, source: 'mail', quote: 'will send it over' });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.deepEqual(keys, ['name:receipt first'], 'one commitment, one candidate');
});

// ---------------------------------------------------------------------------
// Review F finding 7: WHICH RECEIPT ATTRIBUTES A COMMITMENT. It used to be
// MIN(context_id) -- the earliest-INGESTED source row, i.e. the connectors'
// backfill order, which says nothing about the commitment. Both fixtures
// below are cases where ingestion order and conversation order disagree, and
// the old rule lost a real card in each.
// ---------------------------------------------------------------------------

// One accepted, expired owner commitment with NO receipts yet -- the caller
// attaches whichever receipts the fixture is about, in whatever order it
// wants them ingested.
function seedBareCommitment(db, { observedAt, validTo = NOW - 20 * DAY }) {
  const runId = insertDistillRun(db);
  const claimId = insertOwnerCommitmentClaim(db, { runId, text: 'I will send the deck', observedAt, validTo });
  acceptClaim(db, claimId, observedAt);
  return claimId;
}

test('a commitment whose earliest-ingested receipt is a group email still attributes, through the 1:1 receipt', () => {
  const db = openDb(':memory:');
  for (const [key, name] of [['name:group a', 'Group A'], ['name:group b', 'Group B'], ['name:dm one', 'DM One']]) {
    insertPerson(db, { key, name, sent: 10, received: 10 });
    insertOwnerParticipation(db, key);
  }
  const observedAt = NOW - 100 * DAY;
  const claimId = seedBareCommitment(db, { observedAt });

  // INGESTED FIRST (lowest context id): the group thread the old MIN()
  // picked, which has no single counterparty -- so the whole card was lost.
  const groupCtx = insertMailThread(db, {
    ts: observedAt - 2 * DAY,
    recipientKeys: ['name:group a', 'name:group b'],
    meta: { from: ['owner@example.com'], to: ['a@example.com', 'b@example.com'], cc: [] },
  });
  insertClaimSource(db, { claimId, contextId: groupCtx, source: 'mail', quote: 'will send it over' });
  // INGESTED SECOND: a two-party DM, at or before observed_at, which names
  // exactly who is owed.
  const dmCtx = insertMailThread(db, {
    ts: observedAt - 1 * DAY,
    recipientKeys: ['name:dm one'],
    meta: { from: ['owner@example.com'], to: ['one@example.com'], cc: [] },
  });
  insertClaimSource(db, { claimId, contextId: dmCtx, source: 'mail', quote: 'will send it over' });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.deepEqual(keys, ['name:dm one'],
    'one card, attributed through the receipt that actually names a counterparty');
});

test('among two 1:1 receipts the one nearest the claim wins, not the one ingested first', () => {
  const db = openDb(':memory:');
  for (const [key, name] of [['name:older talk', 'Older Talk'], ['name:nearer talk', 'Nearer Talk']]) {
    insertPerson(db, { key, name, sent: 10, received: 10 });
    insertOwnerParticipation(db, key);
  }
  const observedAt = NOW - 100 * DAY;
  const claimId = seedBareCommitment(db, { observedAt });

  // Ingested FIRST but the OLDER conversation: MIN(context_id) chose this
  // one purely because the backfill reached it first.
  const olderCtx = insertMailThread(db, {
    ts: observedAt - 40 * DAY,
    recipientKeys: ['name:older talk'],
    meta: { from: ['owner@example.com'], to: ['older@example.com'], cc: [] },
  });
  insertClaimSource(db, { claimId, contextId: olderCtx, source: 'mail', quote: 'will send it over' });
  // Ingested SECOND, and the conversation the claim was read out of: the
  // latest receipt at or before observed_at.
  const nearerCtx = insertMailThread(db, {
    ts: observedAt - 1 * DAY,
    recipientKeys: ['name:nearer talk'],
    meta: { from: ['owner@example.com'], to: ['nearer@example.com'], cc: [] },
  });
  insertClaimSource(db, { claimId, contextId: nearerCtx, source: 'mail', quote: 'will send it over' });

  const keys = keysOf(owePool(db, { now: NOW }));
  assert.deepEqual(keys, ['name:nearer talk'], 'conversation order decides, not ingestion order');
});

test('a receipt AFTER observed_at is a later re-mention: only used when nothing precedes the claim', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:after only', name: 'After Only', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:after only');
  const observedAt = NOW - 100 * DAY;
  const claimId = seedBareCommitment(db, { observedAt });
  const ctx = insertMailThread(db, {
    ts: observedAt + 5 * DAY,
    recipientKeys: ['name:after only'],
    meta: { from: ['owner@example.com'], to: ['after@example.com'], cc: [] },
  });
  insertClaimSource(db, { claimId, contextId: ctx, source: 'mail', quote: 'will send it over' });

  assert.deepEqual(keysOf(owePool(db, { now: NOW })), ['name:after only'],
    'a claim is dropped only when NO receipt qualifies, never merely because none precedes it');
});

// ---------------------------------------------------------------------------
// Review F finding 12: the mail participant guard.
// ---------------------------------------------------------------------------

test('mail meta carrying raw header strings is counted, not silently skipped', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:header string', name: 'Header String', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:header string');
  // Three addresses on the message, written as the header string an
  // unnormalized import produces. The old Array.isArray read left the
  // address set EMPTY, so size 0 passed the "at most two" test and a whole
  // group thread was attributed to the one person the projection resolved.
  seedMailCommitment(db, {
    recipientKeys: ['name:header string'],
    meta: {
      from: 'Owner <owner@example.com>',
      to: 'Known <known@example.com>, Stranger <stranger@example.com>',
      cc: '',
    },
  });

  assert.deepEqual(keysOf(owePool(db, { now: NOW })), [],
    'a group thread is a group thread however its addresses were written down');
});

test('a bcc recipient makes the thread a group conversation too', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:bcc known', name: 'Bcc Known', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:bcc known');
  seedMailCommitment(db, {
    recipientKeys: ['name:bcc known'],
    meta: {
      from: ['owner@example.com'], to: ['known@example.com'], cc: [],
      bcc: ['silent@example.com'],
    },
  });

  assert.deepEqual(keysOf(owePool(db, { now: NOW })), [],
    'a bcc recipient read the message; they are a participant');
});

test('the owner under two of their own addresses is still one counterparty, given the owner addresses', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:owner alias', name: 'Owner Alias', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:owner alias');
  // Three addresses, but two of them are the owner's: an alias in cc, which
  // is what a forward or a list rewrite leaves behind. One real counterparty.
  seedMailCommitment(db, {
    recipientKeys: ['name:owner alias'],
    meta: {
      from: ['owner@example.com'], to: ['them@example.com'],
      cc: ['owner+alias@example.com'],
    },
  });

  assert.deepEqual(keysOf(owePool(db, { now: NOW })), [],
    'with no owner identity supplied the all-addresses count stands: over-strict, never wrong');
  assert.deepEqual(
    keysOf(owePool(db, {
      now: NOW,
      ownerAddresses: new Set(['owner@example.com', 'owner+alias@example.com']),
    })),
    ['name:owner alias'],
    'counting DISTINCT NON-OWNER addresses recovers the card'
  );
  // And the owner's own addresses do not turn a real group thread into a
  // private one.
  const group = openDb(':memory:');
  insertPerson(group, { key: 'name:owner alias group', name: 'Owner Alias Group', sent: 10, received: 10 });
  insertOwnerParticipation(group, 'name:owner alias group');
  seedMailCommitment(group, {
    recipientKeys: ['name:owner alias group'],
    meta: {
      from: ['owner@example.com'], to: ['them@example.com', 'stranger@example.com'],
      cc: ['owner+alias@example.com'],
    },
  });
  assert.deepEqual(
    keysOf(owePool(group, {
      now: NOW,
      ownerAddresses: new Set(['owner@example.com', 'owner+alias@example.com']),
    })),
    [],
    'two non-owner addresses is still a group thread'
  );
});

test('liveFilter narrows the cross-kind exclusion to the queue the route would serve', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:held offmode', name: 'Held Offmode', sent: 10, received: 10 });
  insertOwnerParticipation(db, 'name:held offmode');
  insertMsg(db, 'name:held offmode', { ts: NOW - 12 * DAY, text: 'can you send that over?', authored: 1 });

  // Reconnect is holding this person -- but in a mode the owner is not on,
  // so that card can never be served and must not block the Owe card
  // either (review F finding 8, from owe.mjs's side of it).
  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
  ).run(NOW - DAY, 'open').lastInsertRowid);
  db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    "VALUES (?, 'name:held offmode', 'reconnect', 'summary', ?, 'v1', 'test', ?)"
  ).run(batchId, JSON.stringify({ mode: 'investor' }), NOW - DAY);

  assert.deepEqual(keysOf(owePool(db, { now: NOW })), [],
    'unnarrowed, any live reconnect card in any mode holds the person');
  assert.deepEqual(
    keysOf(owePool(db, { now: NOW, liveFilter: { mode: 'any' } })),
    ['name:held offmode'],
    'narrowed to the mode the route serves, the off-mode card holds nothing'
  );
});

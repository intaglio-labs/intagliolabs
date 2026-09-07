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

// ---- 9: no MIN_DEPTH floor ----------------------------------------------
test('a thin 4-message relationship still reaches the owe pool (no MIN_DEPTH floor)', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:thin owe', name: 'Thin Owe', sent: 2, received: 2 });
  insertMsg(db, 'name:thin owe', { ts: NOW - 12 * DAY, text: 'can you help with this?', authored: 1 });

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

  insertPerson(db, { key: 'name:rank commit20', name: 'Rank Commit20', sent: 10, received: 10 });
  const c20 = insertOwnerCommitmentClaim(db, { runId, observedAt: NOW - 100 * DAY, validTo: NOW - 20 * DAY });
  acceptClaim(db, c20, NOW - 100 * DAY);
  const ctx20 = insertMsg(db, 'name:rank commit20', { ts: NOW - 100 * DAY, text: 'ok', ownerAuthored: 1 });
  insertClaimSource(db, { claimId: c20, contextId: ctx20, quote: 'ok' });

  // Two open-loop candidates tied at overdueDays=30, differing depth: higher
  // depth (more messages) ranks first.
  insertPerson(db, { key: 'name:rank depth high', name: 'Rank Depth High', sent: 40, received: 40 });
  insertMsg(db, 'name:rank depth high', { ts: NOW - 30 * DAY, text: 'can you help with this?', authored: 1 });
  insertPerson(db, { key: 'name:rank depth low', name: 'Rank Depth Low', sent: 5, received: 5 });
  insertMsg(db, 'name:rank depth low', { ts: NOW - 30 * DAY, text: 'can you help with this?', authored: 1 });

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

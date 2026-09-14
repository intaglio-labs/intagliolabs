// Person pages (L5 step 4, relationship/pages.mjs + engines.mjs): a model
// summarizes what a real person has said, and the only thing allowed to
// reach storage is text grounded in that person's own words. These tests
// exercise the grounding boundary directly (no DB, no model), the storage
// and read-back path against hermes' real schema, the card route's
// attachment of a built page, the depth floor producer.mjs gained alongside
// this feature, and the claude-cli engine's stdin/argv discipline.
//
// Mutation-checked: (a) and (e) below were run once with their guard
// commented out and confirmed to fail before being left in place --
// see the note at each site.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, openDb } from '../server/hermes.mjs';
import { eligiblePool, MIN_DEPTH_MESSAGES } from '../server/relationship/producer.mjs';
import { groundPage, buildPersonPage, readPersonPage, gatherPersonContext } from '../server/relationship/pages.mjs';
import { createEngine, resolveClaudeBinary } from '../server/relationship/engines.mjs';
import { modelPause } from '../server/relationship/pause.mjs';

const NOW = Date.parse('2026-09-01T12:00:00Z');
const DAY = 86_400_000;
const day = (offsetDays) => new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// (a) GROUNDING: pure, no DB, no model.
// ---------------------------------------------------------------------------

function fakeGathered(themLines, meLines = []) {
  const excerpts = [
    ...themLines.map((text, i) => ({ contextId: 100 + i, speaker: 'THEM', text })),
    ...meLines.map((text, i) => ({ contextId: 200 + i, speaker: 'ME', text })),
  ];
  return {
    excerpts,
    meetingTitles: [],
    findQuoteContextId(quote) {
      if (typeof quote !== 'string' || quote.length === 0) return null;
      for (const e of excerpts) {
        if (e.speaker === 'THEM' && e.text.includes(quote)) return e.contextId;
      }
      return null;
    },
  };
}

test('groundPage keeps an item whose quote is a verbatim THEM substring', () => {
  const gathered = fakeGathered(['I need the deck by friday']);
  const page = { who: null, asks: [{ text: 'They want the deck by Friday.', quote: 'the deck by friday' }], objection: null, how_left: null, notable: [] };
  const { kept, dropped } = groundPage(page, gathered);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
  assert.equal(kept[0].contextId, 100);
  assert.equal(kept[0].section, 'ask');
});

test('groundPage drops an item whose quote is not a verbatim THEM substring', () => {
  const gathered = fakeGathered(['I need the deck by friday']);
  const page = { who: null, asks: [{ text: 'They want the deck by Friday.', quote: 'the deck by monday' }], objection: null, how_left: null, notable: [] };
  const { kept, dropped } = groundPage(page, gathered);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /not a verbatim THEM excerpt/);
});

test('groundPage drops an item quoting an ME line, even verbatim', () => {
  const gathered = fakeGathered(['sounds good'], ['sure I will send it tonight']);
  const page = { who: null, asks: [], objection: null, how_left: { text: 'The owner said they would send it tonight.', quote: 'sure I will send it tonight' }, notable: [] };
  const { kept, dropped } = groundPage(page, gathered);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].section, 'how_left');
  // MUTATION CHECK: with the polarity check in gatherPersonContext bypassed
  // (an ME excerpt relabeled 'THEM' in this fixture), this assertion flips
  // to kept.length === 1 -- confirmed by hand by relabeling the fixture
  // above and re-running before restoring it.
});

test('groundPage caps asks and notable at 3 and drops malformed items', () => {
  const gathered = fakeGathered(['a', 'b', 'c', 'd', 'e']);
  const page = {
    who: null,
    asks: [
      { text: '1', quote: 'a' }, { text: '2', quote: 'b' }, { text: '3', quote: 'c' }, { text: '4', quote: 'd' },
    ],
    objection: null,
    how_left: null,
    notable: [{ text: 'no quote' }],
  };
  const { kept, dropped } = groundPage(page, gathered);
  assert.equal(kept.filter((k) => k.section === 'ask').length, 3);
  assert.ok(dropped.some((d) => d.reason === 'missing text/quote'));
});

// ---------------------------------------------------------------------------
// DB fixtures shared by the storage / card / depth-floor tests
// ---------------------------------------------------------------------------

function insertPerson(db, { key, name, role = 'friend', subRoles = [], sent, received, met = 0 }) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, NOW - 400 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY,
    sent, received, met, 0, sent + received, 0, role, '{}', null, NOW, JSON.stringify(subRoles));
}

function insertActiveDay(db, key, activeDay) {
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, activeDay);
}

// A minimal two-way iMessage thread with `person` as the counterparty: one
// THEM line they authored, one ME line the owner authored, same chat_guid so
// episodes.mjs groups them into a single episode.
function insertThread(db, personKey, { chatGuid = `chat:${personKey}`, ts = NOW - 5 * DAY, them = 'hi there', me = 'hey!' } = {}) {
  const themId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(ts, them, JSON.stringify({ chat_guid: chatGuid, is_from_me: false })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, ?)`
  ).run(personKey, themId, chatGuid);

  const meId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(ts + 60_000, me, JSON.stringify({ chat_guid: chatGuid, is_from_me: true })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 0, 1, 0, 1, ?)`
  ).run(personKey, meId, chatGuid);

  return { themId, meId };
}

function fakeEngine(resultText) {
  const counters = { calls: 0, totalCostUsd: 0.01, totalDurationMs: 5 };
  return {
    name: 'fake',
    model: 'fake-model',
    counters,
    async complete() {
      counters.calls += 1;
      return resultText;
    },
  };
}

// ---------------------------------------------------------------------------
// (b) STORAGE: kept items become pending person claims with correct
//     claim_source rows and person_page_item sections; re-running dedupes.
// ---------------------------------------------------------------------------

test('buildPersonPage stores grounded items as pending person claims with receipts, and a re-run does not duplicate', async () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:jane doe', name: 'Jane Doe', role: 'investor', subRoles: ['investor'], sent: 30, received: 30 });
  const { themId } = insertThread(db, 'name:jane doe', { them: 'I need the deck by friday, and honestly I am a bit worried about runway' });

  const page = {
    who: { text: 'Jane is an investor evaluating the deal.', quote: 'worried about runway' },
    asks: [{ text: 'Jane wants the deck by Friday.', quote: 'the deck by friday' }],
    objection: { text: 'Jane is worried about runway.', quote: 'worried about runway' },
    how_left: null,
    notable: [],
  };
  const engine = fakeEngine(JSON.stringify(page));

  const first = await buildPersonPage(db, engine, 'name:jane doe', { now: NOW });
  assert.equal(first.kept, 3);
  assert.equal(first.dropped, 0);

  const claims = db.prepare(
    `SELECT c.id, c.subject, c.subject_person_key, c.kind, c.text, c.p_claim, ppi.section
     FROM claim c JOIN person_page_item ppi ON ppi.claim_id = c.id
     WHERE c.subject_person_key = ? ORDER BY ppi.section`
  ).all('name:jane doe');
  assert.equal(claims.length, 3);
  for (const c of claims) {
    assert.equal(c.subject, 'person');
    assert.equal(c.p_claim, null);
  }
  const bySection = Object.fromEntries(claims.map((c) => [c.section, c]));
  assert.equal(bySection.who.kind, 'fact');
  assert.equal(bySection.ask.kind, 'plan');
  assert.equal(bySection.objection.kind, 'constraint');

  const sources = db.prepare('SELECT claim_id, context_id, quote FROM claim_source WHERE claim_id IN (' +
    claims.map(() => '?').join(',') + ')').all(...claims.map((c) => c.id));
  assert.equal(sources.length, 3);
  for (const s of sources) assert.equal(s.context_id, themId); // every quote came from the one THEM row

  // No claim_decision has been recorded -- everything is PENDING, the owner
  // decides.
  const decisions = db.prepare('SELECT COUNT(*) AS n FROM claim_decision').get();
  assert.equal(decisions.n, 0);

  // Re-run with the identical page: nothing new stored.
  const engine2 = fakeEngine(JSON.stringify(page));
  const second = await buildPersonPage(db, engine2, 'name:jane doe', { now: NOW + 1000 });
  assert.equal(second.kept, 0);
  assert.equal(second.skipped, 3);
  const claimsAfter = db.prepare('SELECT COUNT(*) AS n FROM claim WHERE subject_person_key = ?').get('name:jane doe');
  assert.equal(claimsAfter.n, 3);
});

test('buildPersonPage drops an item whose quote cites an ME line end to end', async () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:sam speaker', name: 'Sam Speaker', sent: 25, received: 25 });
  insertThread(db, 'name:sam speaker', { them: 'ok', me: 'I will absolutely deliver this by Tuesday no matter what' });

  const page = {
    who: null, asks: [], objection: null,
    how_left: { text: 'The owner committed to deliver by Tuesday.', quote: 'I will absolutely deliver this by Tuesday' },
    notable: [],
  };
  const result = await buildPersonPage(db, fakeEngine(JSON.stringify(page)), 'name:sam speaker', { now: NOW });
  assert.equal(result.kept, 0);
  assert.equal(result.dropped, 1);
  const n = db.prepare('SELECT COUNT(*) AS n FROM claim WHERE subject_person_key = ?').get('name:sam speaker');
  assert.equal(n.n, 0);
});

// ---------------------------------------------------------------------------
// (c) readPersonPage omits rejected items after a reject decision.
// ---------------------------------------------------------------------------

test('readPersonPage omits a rejected item but keeps the still-pending ones', async () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:al asker', name: 'Al Asker', sent: 25, received: 25 });
  insertThread(db, 'name:al asker', { them: 'can you send the invoice and also I love the new pricing page' });

  const page = {
    who: null,
    asks: [{ text: 'Al wants the invoice.', quote: 'send the invoice' }],
    objection: null, how_left: null,
    notable: [{ text: 'Al likes the new pricing page.', quote: 'I love the new pricing page' }],
  };
  await buildPersonPage(db, fakeEngine(JSON.stringify(page)), 'name:al asker', { now: NOW });

  const before = readPersonPage(db, 'name:al asker');
  assert.equal(before.sections.asks.length, 1);
  assert.equal(before.sections.notable.length, 1);
  assert.equal(before.sections.asks[0].decision, 'pending');

  const askClaimId = before.sections.asks[0].claimId;
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, 'reject', 'owner', 'not relevant', ?)")
    .run(askClaimId, NOW + 1000);

  const after = readPersonPage(db, 'name:al asker');
  assert.equal(after.sections.asks.length, 0);
  assert.equal(after.sections.notable.length, 1);
});

// ---- review finding 16: one receipt per page item -----------------------
// The claim_source join used to fan out. A page claim that later gains a
// SECOND receipt -- the same sentence quoted from another conversation, which
// a re-build against a widened corpus produces -- returned two rows, and the
// asks/notable sections rendered the same line twice.
test('a page item with two receipts renders once, quoting the earliest source', async () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:two receipts', name: 'Two Receipts', sent: 25, received: 25 });
  insertThread(db, 'name:two receipts', { them: 'can you send the invoice when you get a chance' });

  const page = {
    who: null,
    asks: [{ text: 'They want the invoice.', quote: 'send the invoice' }],
    objection: null, how_left: null, notable: [],
  };
  await buildPersonPage(db, fakeEngine(JSON.stringify(page)), 'name:two receipts', { now: NOW });

  const before = readPersonPage(db, 'name:two receipts');
  assert.equal(before.sections.asks.length, 1);
  const claimId = before.sections.asks[0].claimId;
  const firstContextId = before.sections.asks[0].contextId;

  // A second receipt for the same claim, in a later context row.
  const laterContextId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', 'still need that invoice', '{}')"
  ).run(NOW + 1000).lastInsertRowid);
  db.prepare(
    "INSERT INTO claim_source(claim_id, context_id, source, entity_id, content_hash, quote) VALUES (?, ?, 'imessage', NULL, NULL, ?)"
  ).run(claimId, laterContextId, 'still need that invoice');

  const after = readPersonPage(db, 'name:two receipts');
  assert.equal(after.sections.asks.length, 1, 'a second receipt is not a second ask');
  assert.equal(after.sections.asks[0].contextId, firstContextId,
    'the receipt shown is the earliest one, deterministically');
});

// ---------------------------------------------------------------------------
// (d) card route attaches the page and prefers how_left over the template.
// ---------------------------------------------------------------------------

const TOKEN = 'f'.repeat(64);
const CAP = { max: 5, windowMs: 86_400_000 };

test('card route attaches the built page and prefers how_left as the sentence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-pages-'));
  const STUB_CARDS = [{
    personKey: 'name:jane doe', name: 'Jane Doe', kind: 'reconnect',
    sentence: 'template sentence', role: 'investor', focus: null, label: null, left: null, leftTone: null,
    evidence: { topics: [], messages: 30, dormancyDays: 200, meetings: 0 },
    producer_version: 'rm-match-v13',
  }];
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipMatcher: async () => ({ cards: structuredClone(STUB_CARDS), focus: 'x', currentTopics: [] }),
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'matcher', mode: 'any' },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    insertPerson(server.db, { key: 'name:jane doe', name: 'Jane Doe', role: 'investor', subRoles: ['investor'], sent: 30, received: 30 });
    insertThread(server.db, 'name:jane doe', { them: 'we ended on me sending you the updated cap table next week' });

    const page = {
      who: { text: 'Jane is an investor.', quote: 'updated cap table' },
      asks: [], objection: null,
      how_left: { text: 'They left it with Jane sending the updated cap table next week.', quote: 'sending you the updated cap table next week' },
      notable: [],
    };
    // Build the page directly (no HTTP round trip needed for setup).
    const { buildPersonPage: build } = await import('../server/relationship/pages.mjs');
    await build(server.db, fakeEngine(JSON.stringify(page)), 'name:jane doe', { now: Date.now() });

    await call('POST', '/admin/relationship/refresh');
    const res = await call('GET', '/admin/relationship/card');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.card);
    assert.equal(body.card.personKey, 'name:jane doe');
    assert.equal(body.card.who, 'Jane is an investor.');
    assert.equal(body.card.sentence, 'They left it with Jane sending the updated cap table next week.');
    assert.ok(body.card.page);
    assert.equal(body.card.page.sections.how_left.text, body.card.sentence);
  } finally {
    await server.close();
  }
});

test('card route falls back to the template sentence when no page exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-pages-fallback-'));
  const STUB_CARDS = [{
    personKey: 'name:no page person', name: 'No Page Person', kind: 'reconnect',
    sentence: 'template sentence', role: null, focus: null, label: null, left: null, leftTone: null,
    evidence: { topics: [], messages: 30, dormancyDays: 200, meetings: 0 },
    producer_version: 'rm-match-v13',
  }];
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipMatcher: async () => ({ cards: structuredClone(STUB_CARDS), focus: 'x', currentTopics: [] }),
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'matcher', mode: 'any' },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await call('POST', '/admin/relationship/refresh');
    const res = await call('GET', '/admin/relationship/card');
    const body = await res.json();
    assert.equal(body.card.sentence, 'template sentence');
    assert.equal(body.card.who, null);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (d.1) page-first card queue: a refill kicks off a background page-build
// pass over its own batch, and the card route prefers whichever unjudged
// candidate already has a page over a higher-ranked one that does not.
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('a refill builds pages in the background, and the card route prefers a lower-ranked candidate with a page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-pages-refill-'));
  let calls = 0;
  const engine = {
    name: 'fake', model: 'fake-model', counters: { calls: 0, totalCostUsd: 0, totalDurationMs: 0 },
    async complete() {
      calls += 1;
      engine.counters.calls += 1;
      // Rank one (built first, since produceBatch orders by depth desc and
      // the background pass processes candidates in that same order) fails;
      // rank two succeeds. So the page that exists belongs to the
      // LOWER-ranked candidate -- the only way "prefers a page over rank" is
      // distinguishable from "prefers rank".
      if (calls === 1) throw new Error('synthetic engine failure for rank one');
      return JSON.stringify({
        who: { text: 'Rank two is a contact worth reconnecting with.', quote: 'lets catch up soon' },
        asks: [], objection: null, how_left: null, notable: [],
      });
    },
  };
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    relationshipMemoryEngine: engine,
    peopleProjectionAutoRebuild: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const db = server.db;
    // Rank one: higher depth (80), built first, engine call fails for it.
    insertPerson(db, { key: 'name:rank one', name: 'Rank One', sent: 40, received: 40 });
    insertThread(db, 'name:rank one', { them: 'happy to reconnect whenever works' });
    insertActiveDay(db, 'name:rank one', day(200));
    // Rank two: lower depth (40), built second, engine call succeeds for it.
    insertPerson(db, { key: 'name:rank two', name: 'Rank Two', sent: 20, received: 20 });
    insertThread(db, 'name:rank two', { them: 'lets catch up soon, it has been a while' });
    insertActiveDay(db, 'name:rank two', day(200));

    const refreshOut = await (await call('POST', '/admin/relationship/refresh')).json();
    assert.equal(refreshOut.started, true);

    // Poll until the background pass over both candidates finishes.
    // `pagesBuilding` is now CLEARED when the queue drains (review finding
    // 12: it used to ride every later response forever, so the desk showed a
    // build in progress that had finished hours before), so the pass is
    // watched while it runs and its ABSENCE is what says it is done.
    let last = null;
    let progress = null;
    for (let i = 0; i < 40; i++) {
      last = await (await call('GET', '/admin/relationship/card')).json();
      if (last.pagesBuilding) progress = last.pagesBuilding;
      if (engine.counters.calls === 2 && !last.pagesBuilding) break;
      await sleep(200);
    }
    assert.ok(progress, 'progress is exposed on the card route response while a pass runs');
    assert.equal(progress.total, 2, 'both new candidates lacked a page and were queued');
    assert.equal(last.pagesBuilding, undefined, 'and it stops being reported once the pass drains');
    assert.equal(engine.counters.calls, 2, 'both candidates were attempted, sequentially');

    const final = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(final.card);
    assert.equal(final.card.personKey, 'name:rank two',
      'rank two (which now has a built page) is preferred over rank one (which does not), despite ranking lower');
    assert.ok(final.card.page);
    assert.equal(final.card.page.sections.who.text, 'Rank two is a contact worth reconnecting with.');
  } finally {
    await server.close();
  }
});

test('a second refill while a build is running does not start a second builder -- it QUEUES behind it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-pages-guard-'));
  const engine = {
    name: 'fake', model: 'fake-model', counters: { calls: 0, totalCostUsd: 0, totalDurationMs: 0 },
    async complete() {
      engine.counters.calls += 1;
      await sleep(400); // slow enough that a genuinely concurrent second builder would be caught
      return JSON.stringify({
        who: { text: 'A contact worth reconnecting with.', quote: 'lets catch up soon' },
        asks: [], objection: null, how_left: null, notable: [],
      });
    },
  };
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    relationshipMemoryEngine: engine,
    peopleProjectionAutoRebuild: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const db = server.db;
    insertPerson(db, { key: 'name:guard a', name: 'Guard A', sent: 40, received: 40 });
    insertThread(db, 'name:guard a', { them: 'lets catch up soon sometime' });
    insertActiveDay(db, 'name:guard a', day(200));

    const first = await (await call('POST', '/admin/relationship/refresh')).json();
    assert.equal(first.started, true);

    // A candidate that only becomes eligible now -- inserted AFTER the first
    // refresh's batch, so the second refresh's producer finds a genuinely
    // different, non-empty batch rather than the "recently offered" gate
    // emptying it (which would make the guard untestable: an empty batch
    // starts no builder regardless of the guard).
    insertPerson(db, { key: 'name:guard b', name: 'Guard B', sent: 40, received: 40 });
    insertThread(db, 'name:guard b', { them: 'lets catch up soon sometime' });
    insertActiveDay(db, 'name:guard b', day(200));

    const second = await (await call('POST', '/admin/relationship/refresh')).json();
    assert.equal(second.started, true, 'the producer itself still runs a second time -- only page building is guarded');

    // Guard A's build is still in flight (400ms). If the guard were missing,
    // the second refill's own batch (Guard B) would start building
    // concurrently, and calls would reach 2 well before A's build can finish.
    await sleep(150);
    assert.equal(engine.counters.calls, 1, 'the in-flight build was not joined by a second, concurrent one');

    // ~~"Guard B was never built -- its own refill's builder call was
    // suppressed"~~ (review finding 12). That was this test pinning the
    // defect: the guard exists so two builders never run AT ONCE, and
    // dropping the second batch's work entirely was the cost, not the point.
    // Guard B's names never got pages at all, and since the card route
    // PREFERS a candidate that has one, they sorted last forever. The second
    // batch is now queued behind the first and built when it drains.
    for (let i = 0; i < 20 && engine.counters.calls < 2; i++) await sleep(100);
    assert.equal(engine.counters.calls, 2, 'Guard B was built after A drained -- queued, not dropped');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (e) depth floor: excludes a 4-message person, includes a 4-message person
//     who met once.
// ---------------------------------------------------------------------------

test('depth floor excludes a thin-history person and includes one with a single meeting', () => {
  const db = openDb(':memory:');

  insertPerson(db, { key: 'name:thin thread', name: 'Thin Thread', sent: 2, received: 2, met: 0 });
  insertThread(db, 'name:thin thread');
  insertActiveDay(db, 'name:thin thread', day(200));

  insertPerson(db, { key: 'name:one meeting', name: 'One Meeting', sent: 2, received: 2, met: 1 });
  insertThread(db, 'name:one meeting');
  insertActiveDay(db, 'name:one meeting', day(200));

  insertPerson(db, { key: 'name:deep enough', name: 'Deep Enough', sent: MIN_DEPTH_MESSAGES, received: 0, met: 0 });
  insertThread(db, 'name:deep enough');
  insertActiveDay(db, 'name:deep enough', day(200));

  const pool = eligiblePool(db, { mode: 'any', now: NOW });
  const keys = pool.map((p) => p.personKey);
  assert.ok(!keys.includes('name:thin thread'), 'a 4-message, no-meeting person must not pass the depth floor');
  assert.ok(keys.includes('name:one meeting'), 'a single in-person meeting is a separate, sufficient path');
  assert.ok(keys.includes('name:deep enough'), 'sent+received at the floor must pass');

  // MUTATION CHECK: reverting the WHERE clause to `(p.sent > 0 AND p.received
  // > 0) OR p.met_in_person > 0` was confirmed to let 'name:thin thread'
  // (sent=2, received=2) back into the pool -- i.e. this assertion catches
  // exactly the regression the floor exists to prevent.

  // ?minDepth= override widens/narrows without a redeploy.
  const wider = eligiblePool(db, { mode: 'any', now: NOW, minDepth: 4 });
  assert.ok(wider.map((p) => p.personKey).includes('name:thin thread'));
});

// ---------------------------------------------------------------------------
// (f) engines: claude-cli passes the prompt on stdin, never argv; parses
//     .result; records cost.
// ---------------------------------------------------------------------------

function makeFakeChild(envelope) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written = [];
  child.stdin = {
    write(chunk) { written.push(chunk); },
    end() {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(envelope)));
        child.emit('close', 0);
      });
    },
  };
  child.__written = written;
  return child;
}

test('claude-cli engine writes the prompt to stdin, never argv, and parses the JSON envelope', async () => {
  let capturedArgs = null;
  let fakeChild = null;
  const spawnImpl = (binary, args) => {
    capturedArgs = args;
    fakeChild = makeFakeChild({ result: 'the model answer', total_cost_usd: 0.0042, duration_ms: 1234, is_error: false });
    return fakeChild;
  };
  const engine = createEngine({
    relationshipMemory: { engine: 'claude-cli', claudeBinary: '/fake/claude', spawnImpl },
  });
  const secretUserPrompt = 'THEM: this is the person’s own words, never argv';
  const result = await engine.complete({ system: 'system prompt text', user: secretUserPrompt, maxTokens: 100 });

  assert.equal(result, 'the model answer');
  assert.equal(engine.counters.totalCostUsd, 0.0042);
  assert.equal(engine.counters.calls, 1);
  assert.ok(Array.isArray(capturedArgs));
  for (const a of capturedArgs) assert.ok(!String(a).includes(secretUserPrompt), 'the user prompt must never appear in argv');
  assert.ok(capturedArgs.includes('--system-prompt'));
  assert.ok(fakeChild.__written.includes(secretUserPrompt), 'the user prompt must be written to stdin');
  // MUTATION CHECK: passing `user` as an extra argv element instead of
  // writing it to stdin was confirmed to fail the argv assertion above.
});

test('claude-cli engine treats is_error and non-zero exit as thrown errors', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ result: '', is_error: true })));
        child.emit('close', 1);
      });
    } };
    return child;
  };
  const engine = createEngine({ relationshipMemory: { engine: 'claude-cli', claudeBinary: '/fake/claude', spawnImpl } });
  await assert.rejects(() => engine.complete({ system: 's', user: 'u' }));
});

test('resolveClaudeBinary returns null when nothing is on PATH and the fallback does not exist', () => {
  const binary = resolveClaudeBinary({ env: { PATH: '/nonexistent-dir-xyz' }, home: '/nonexistent-home-xyz' });
  assert.equal(binary, null);
});

// ---------------------------------------------------------------------------
// THE PAUSE runPageBuilds AWAITS BETWEEN PEOPLE MUST HOLD THE EVENT LOOP OPEN.
//
// runPageBuilds (hermes.mjs) used to await a local sleep() that unref'd its
// timer, so the rest of a batch only ever got built if something else was
// keeping the loop alive. In the server that is the HTTP listener, so nobody
// noticed -- and it is why this cannot be pinned behaviourally HERE either:
// every build test in this file goes through start(), whose listener holds
// the loop open and hides the defect exactly the way production does. The
// same unref'd pause in the sweep, which sweep-once.mjs awaits without a
// listener of its own, took out relationship-sweep.test.mjs under Node 22.
//
// So this pins the property instead of the symptom.
// process.getActiveResourcesInfo() lists ONLY resources that are keeping the
// event loop alive, so an unref'd timer is absent from it and this assertion
// fails on the old code under every Node major.
//
// What a parked runPageBuilds costs, and why it is not merely a slow batch:
// startPageBuilds chains its queue drain off this promise, so if it never
// settles rel.pagesBuildingActive stays true forever and every later refill
// queues into rel.pagesPending behind a builder that has stopped -- no
// further page is ever built, for any batch.
test('the pause runPageBuilds awaits keeps the event loop alive until it fires', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  const before = timers();
  const startedAt = Date.now();
  const pause = modelPause(25);
  assert.equal(timers(), before + 1,
    "an unref'd pause does not hold the loop open, so a batch mid-flight never resumes");

  await pause;
  assert.ok(Date.now() - startedAt >= 20, 'and it really did wait rather than resolving immediately');
});

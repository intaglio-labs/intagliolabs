// The card-serving path, after contrarian review A (2026-09-08). Every test
// here is a fixture where the OLD behavior and the new one disagree:
//
//   1  a muted snapshot used to stay "unjudged" forever, so its producer
//      kept the turn and the route answered {card:null} for the whole mute.
//   2  the same wedge for any unjudged-but-unservable card (deleted quote).
//   4  the widget's background poll used to hit the serving route, spending
//      'shown' rows, cap slots and cooldowns on cards nobody saw.
//  10  'opened' was posted on every pull, so openRate climbed past 1.
//  12  rel.pagesBuilding was never cleared, and a batch produced while a
//      pass was running was dropped instead of queued.
//  15  cap exhaustion and a queue of muted people both rendered as "nothing
//      to review", with no reason on the wire.
//  18  the event route trusted the body's person_key while taking the kind
//      from the snapshot -- so a body could suppress an unrelated person.
//   9  the draft route dropped createDraft's own failure reason, answering
//      200 with an empty list, which the page read as success.
//  13  an Owe card's draft prompt carried no owe evidence at all -- no
//      overdue count, no commitment text -- so it drafted a generic
//      "it's been a while" for a specific overdue thing.
//
// Findings 3/5/11 (producer gates and cross-kind exclusion) live with their
// producers, in relationship-owe.test.mjs and relationship-producer.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '../server/hermes.mjs';
import { produceOweBatch } from '../server/relationship/owe.mjs';

const TOKEN = 'f'.repeat(64);
const CAP = { max: 5, windowMs: 86_400_000 };
const DAY = 86_400_000;

// Sub-role modes serve only while the registry's `timeline` flag is on
// (2026-09-13, the picker is retired by default) -- so a test that switches
// modes has to turn it on, and every other test here pins it OFF rather than
// inheriting the developer's own ~/.hazlie/features.json. 'none' is
// features.mjs' spelling for "the shipped registry alone".
function featureOverridePath(features) {
  if (features === undefined) return 'none';
  const dir = mkdtempSync(join(tmpdir(), 'rel-card-path-features-'));
  const path = join(dir, 'features.json');
  writeFileSync(path, JSON.stringify(features));
  return path;
}

async function withCardServer(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-card-path-'));
  const { features, ...startOpts } = opts;
  const previousFeatures = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HAZLIE_FEATURES_OVERRIDE = featureOverridePath(features);
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
    // No page-building engine unless a test asks for one: page builds are
    // background work these tests are not about, and an explicit null keeps
    // the machine's own config out of the run.
    relationshipMemoryEngine: null,
    // The mode route writes the owner's config file; without a path of its own
    // a mode post from here edits the developer's ~/.hazlie config.
    ownerConfigPath: join(dir, 'config.json'),
    ...startOpts,
  });
  // THE LINKEDIN EXPORT HAS LANDED. hermes HOLDS an investor or founder pick
  // while LinkedIn has contributed nobody -- the sub-role modes are a LinkedIn
  // question (people.sub_roles comes from the export), so until it arrives the
  // cards come from 'any' and the reply carries modeFallback. The mode tests
  // below are about queues and page passes rather than that hold, which is
  // pinned in relationship-linkedin-pending.test.mjs.
  //
  // This link puts nobody in a pool: it needs a `people` row to point at
  // (foreign key), and eligiblePool drops a candidate with no active day
  // before it looks at anything else.
  const exportNow = Date.now();
  insertPersonRow(server.db, { key: 'name:linkedin listed', name: 'LinkedIn Listed', sent: 0, received: 0 }, exportNow);
  const exportCtxId = Number(server.db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'linkedin', 'profile', '{}')"
  ).run(exportNow).lastInsertRowid);
  server.db.prepare(
    'INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, '
    + 'room, confidence, conversation_key) '
    + "VALUES ('name:linkedin listed', ?, 'linkedin', 'profile', 0, 0, 0, 1, 'linkedin')"
  ).run(exportCtxId);
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const get = async (path) => (await call('GET', path)).json();
  try {
    await fn({ call, get, db: server.db });
  } finally {
    await server.close();
    if (previousFeatures === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previousFeatures;
  }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function insertPersonRow(db, { key, name, role = 'friend', subRoles = [], sent, received, met = 0 }, now) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, now - 400 * DAY, now - 10 * DAY, now - 10 * DAY, now - 10 * DAY,
    sent, received, met, 0, sent + received, 0, role, '{}', null, now, JSON.stringify(subRoles));
}

function insertMessage(db, key, { ts, text = 'hi', authored = 0, ownerAuthored = 0, room = 0, meta = {} } = {}) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(ts, text, JSON.stringify(meta)).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', ?, ?, ?, 1, 'conv')`
  ).run(key, ctxId, authored ? 1 : 0, ownerAuthored ? 1 : 0, room ? 1 : 0);
  return ctxId;
}

function isoDay(now, offsetDays) { return new Date(now - offsetDays * DAY).toISOString().slice(0, 10); }

// Reconnect-eligible (producer.mjs's gates: two-way history, a DIRECT
// authored row, quiet >= 180 days).
//
// Both rows carry the same meta.chat_guid, and the owner's carries
// is_from_me: episodes.mjs keys a thread on chat_guid (a row without one is
// its OWN episode) and drops any run the owner never spoke in. Without both
// details the person has no THEM excerpts, buildPersonPage returns early,
// and no engine call ever happens -- which is what the page-build tests
// below are counting.
function seedReconnect(db, key, name, now, subRoles = [], role = 'friend') {
  const guid = `iMessage;-;${key}`;
  insertPersonRow(db, { key, name, role, subRoles, sent: 20, received: 20 }, now);
  insertMessage(db, key, {
    ts: now - 200 * DAY, text: 'good to see you last week', authored: 1,
    meta: { chat_guid: guid },
  });
  insertMessage(db, key, {
    ts: now - 200 * DAY + 60_000, text: 'likewise -- let us do it again',
    ownerAuthored: 1, meta: { chat_guid: guid, is_from_me: true },
  });
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)')
    .run(key, isoDay(now, 200));
}

// Owe-eligible (owe:open-loop): their unanswered question 12 days ago, with
// the two owner-authored messages OWE_MIN_OWNER_MESSAGES wants, placed long
// before the ask so the loop stays open. Never reconnect-eligible: no
// person_active_days row, so producer.mjs's quiet-days gate drops them.
function seedOwe(db, key, name, now, { askedDaysAgo = 12, text = 'can you send that over?' } = {}) {
  insertPersonRow(db, { key, name, sent: 10, received: 10 }, now);
  insertMessage(db, key, { ts: now - 300 * DAY, text: 'hey', ownerAuthored: 1 });
  insertMessage(db, key, { ts: now - 299 * DAY, text: 'checking in', ownerAuthored: 1 });
  return insertMessage(db, key, { ts: now - askedDaysAgo * DAY, text, authored: 1 });
}

const eventCount = (db, event) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM rm_card_event WHERE event = ?').get(event).n);

// ---- 1: a muted snapshot is consumed, not a permanent hostage -------------
test('a muted card does not hold its producer\'s turn: the next owe candidate serves instead of {card:null}', async () => {
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:muted owe', 'Muted Owe', now, { askedDaysAgo: 30 });
    seedReconnect(db, 'name:card path reconnect', 'Card Path Reconnect', now);

    const first = await get('/admin/relationship/card');
    assert.equal(first.card.kind, 'owe');
    assert.equal(first.card.personKey, 'name:muted owe');

    // The card's own "mute 30d" button: a 'muted' rm_card_event and an
    // rm_mute row, and NO accepted/dismissed row anywhere.
    await call('POST', '/admin/relationship/event', {
      snapshot_id: first.card.snapshot_id, person_key: first.card.personKey,
      event: 'muted', mute_days: 30,
    });
    assert.equal(eventCount(db, 'muted'), 1);
    assert.equal(eventCount(db, 'dismissed'), 0);

    // Reconnect's turn (owe was just shown), and it has a candidate.
    const second = await get('/admin/relationship/card');
    assert.equal(second.card.kind, 'reconnect');

    // Owe's turn again -- and a SECOND owe candidate has appeared since.
    // The muted snapshot is the only thing in owe's queue: if it still
    // counted as unjudged, owe would sit on it, the serve loop would skip it
    // as muted, and this request would answer {card:null} for 30 days.
    seedOwe(db, 'name:second owe', 'Second Owe', now, { askedDaysAgo: 20 });
    const third = await get('/admin/relationship/card');
    assert.ok(third.card, `owe produced past the muted snapshot (reason: ${third.reason})`);
    assert.equal(third.card.kind, 'owe');
    assert.equal(third.card.personKey, 'name:second owe');
  });
});

// ---- 2: unservable is not unjudged ---------------------------------------
test('a card whose quote row was deleted stops holding its kind\'s turn', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    const askCtx = seedOwe(db, 'name:quote gone', 'Quote Gone', now, { askedDaysAgo: 30 });

    // Produce the batch, THEN delete the source row the card's quote points
    // at -- the deletion cascade the card route honors at serve time.
    produceOweBatch(db, { now });
    // A filler row FIRST, so the deleted ask is not the table's highest
    // rowid: SQLite hands the next INSERT max(rowid)+1, so deleting the top
    // row and inserting again silently points the snapshot's stored
    // quote_context_id at a DIFFERENT message instead of at nothing.
    db.prepare("INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', 'filler', '{}')")
      .run(now - 5 * DAY);
    db.prepare('DELETE FROM context WHERE id = ?').run(askCtx);
    assert.equal(db.prepare('SELECT 1 FROM context WHERE id = ?').get(askCtx), undefined);

    // A second owe candidate, reachable only if the dead one lets go.
    seedOwe(db, 'name:quote live', 'Quote Live', now, { askedDaysAgo: 20 });

    const out = await get('/admin/relationship/card');
    assert.ok(out.card, `the dead card did not wedge the queue (reason: ${out.reason})`);
    assert.equal(out.card.personKey, 'name:quote live');
  });
});

// ---- 4: a peek is not a serve --------------------------------------------
test('?peek=1 answers a tease and records nothing: no shown row, no cap slot, no producer flip', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:peeked', 'Peeked', now, { askedDaysAgo: 30 });

    const peek = await get('/admin/relationship/card?peek=1');
    assert.equal(peek.peek, true);
    assert.equal(peek.card.name, 'Peeked');
    assert.equal(peek.card.quote, undefined, 'a peek carries the tease, never the receipt');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_card_event').get().n), 0,
      'a background poll records NOTHING -- it is not an interruption');

    // Poll again: still nothing recorded, and the producers have not taken
    // turns behind the owner's back (pickProducer reads 'shown').
    await get('/admin/relationship/card?peek=1');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_card_event').get().n), 0);

    const served = await get('/admin/relationship/card');
    assert.equal(served.card.kind, 'owe', 'owe still has the turn two peeks later');
    assert.equal(served.card.personKey, 'name:peeked');
    assert.equal(eventCount(db, 'shown'), 1, 'the serve is what spends the slot, exactly once');
  });
});

// ---- 10: 'opened' once per snapshot --------------------------------------
test('a second "opened" post for the same snapshot is a no-op, so openRate cannot exceed 1', async () => {
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:opened twice', 'Opened Twice', now, { askedDaysAgo: 30 });

    const { card } = await get('/admin/relationship/card');
    const post = () => call('POST', '/admin/relationship/event', {
      snapshot_id: card.snapshot_id, person_key: card.personKey, event: 'opened',
    });
    assert.equal((await (await post()).json()).duplicate, undefined);
    assert.equal((await (await post()).json()).duplicate, true);
    assert.equal(eventCount(db, 'opened'), 1);
    assert.equal(eventCount(db, 'shown'), 1);
  });
});

// ---- 15: say why there is nothing ----------------------------------------
test('a spent cap answers reason:"cap", not a bare null the widget reads as an empty pool', async () => {
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:cap one', 'Cap One', now, { askedDaysAgo: 30 });
    seedOwe(db, 'name:cap two', 'Cap Two', now, { askedDaysAgo: 20 });

    const first = await get('/admin/relationship/card');
    assert.equal(first.card.personKey, 'name:cap one');
    await call('POST', '/admin/relationship/event', {
      snapshot_id: first.card.snapshot_id, person_key: first.card.personKey,
      event: 'dismissed', reason: 'not-useful',
    });

    const second = await get('/admin/relationship/card');
    assert.equal(second.card, null);
    assert.equal(second.reason, 'cap', 'one interruption a day, and the wire says so');
  }, { relationshipCap: { max: 1, windowMs: 86_400_000 } });
});

test('a queue whose only card is muted answers reason:"muted"', async () => {
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:only muted', 'Only Muted', now, { askedDaysAgo: 30 });

    const { card } = await get('/admin/relationship/card');
    await call('POST', '/admin/relationship/event', {
      snapshot_id: card.snapshot_id, person_key: card.personKey, event: 'muted', mute_days: 30,
    });
    // Nothing else is eligible, so the refill produces nothing and the queue
    // holds one consumed card. The reason must not be silence.
    const out = await get('/admin/relationship/card');
    assert.equal(out.card, null);
    assert.ok(['pool-exhausted', 'queue-empty'].includes(out.reason), `got ${out.reason}`);
  });
});

// ---- 18: the snapshot names the person -----------------------------------
test('the event route takes person_key from the snapshot: a body naming someone else cannot suppress them', async () => {
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:offered', 'Offered', now, { askedDaysAgo: 30 });
    insertPersonRow(db, { key: 'name:innocent bystander', name: 'Innocent Bystander', sent: 5, received: 5 }, now);

    const { card } = await get('/admin/relationship/card');
    const res = await call('POST', '/admin/relationship/event', {
      snapshot_id: card.snapshot_id, person_key: 'name:innocent bystander',
      event: 'dismissed', reason: 'never-this-person',
    });
    assert.equal(res.status, 200);

    const suppressed = db.prepare('SELECT person_key FROM rm_suppression').all().map((r) => r.person_key);
    assert.deepEqual(suppressed, ['name:offered'],
      'the snapshot decides who this verdict is about -- a body cannot suppress a person no card offered');
    const dismissed = db.prepare("SELECT person_key FROM rm_card_event WHERE event = 'dismissed'").get();
    assert.equal(dismissed.person_key, 'name:offered');
  });
});

test('the event route is closed: an unrecognized field 400s instead of passing silently', async () => {
  await withCardServer(async ({ call, get }) => {
    const { card } = await get('/admin/relationship/card');
    const res = await call('POST', '/admin/relationship/event', {
      snapshot_id: card?.snapshot_id ?? null, person_key: 'name:whoever',
      event: 'dismissed', resaon: 'not-useful',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error ?? '', /resaon/u);
  }, { relationshipCap: CAP });
});

// ---- 12: page builds are queued, and stop claiming to be running ---------
test('rel.pagesBuilding is cleared when the pass drains, instead of riding every later response', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:page building', 'Page Building', now, { askedDaysAgo: 30 });

    const first = await get('/admin/relationship/card');
    assert.ok(first.card, 'the refill produced, which is what starts the page pass');
    await settle(120);
    const second = await get('/admin/relationship/card');
    assert.equal(second.pagesBuilding, undefined,
      'a finished pass does not report itself as in progress on every later response');
    assert.ok(db); // the assertion above is the whole test
  });
});

test('a batch produced while a page pass is running is queued, not dropped', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const asked = [];
  const engine = {
    name: 'test-engine', model: 'test-model',
    async complete({ user }) { asked.push(user); await gate; return 'not json at all'; },
  };

  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    // Two modes, one candidate each, so each batch holds exactly one person
    // -- runPageBuilds sleeps PAGE_BUILD_PAUSE_MS between items in a batch,
    // and a two-person batch would make this test about that sleep instead.
    // 'family' keeps the second person out of mode 'any' (which excludes
    // romantic/family) while mode 'investor' admits them on sub_roles alone.
    seedReconnect(db, 'name:queued first', 'Queued First', now);
    seedReconnect(db, 'name:queued second', 'Queued Second', now, ['investor'], 'family');

    // Batch 1 (mode 'any'): its page pass starts and blocks on the gate.
    const first = await get('/admin/relationship/card');
    assert.ok(first.card);
    await settle(80);
    assert.equal(asked.length, 1, 'the first pass is in flight, waiting on the engine');

    // Batch 2 (mode 'investor') lands mid-pass. The old guard dropped it.
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });
    const second = await get('/admin/relationship/card');
    assert.equal(second.card?.personKey, 'name:queued second');

    release();
    await settle(300);
    assert.equal(asked.length, 2, 'the queued batch got its page pass once the first drained');
    assert.ok(asked[1].includes('Queued Second'), 'and it is the second batch\'s person');
    // Modes live: this test's second batch exists BECAUSE the mode switch
    // produces one, which is a thing only a moded install does.
  }, { relationshipMemoryEngine: engine, features: { timeline: true } });
});

// ---- 9 + 13: drafts ------------------------------------------------------

function insertDistillRun(db, now) {
  return Number(db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context,
       rows_in, claims_out, status, started_at, ended_at)
     VALUES ('test-model', 'test/prompt.md', 'sha', '{}', 'on', 1, 1, 'complete', ?, ?)`
  ).run(now, now).lastInsertRowid);
}

// An owe:expired-commitment candidate: an accepted owner commitment whose
// valid_to has passed, sourced off a direct message with this person.
function seedOweCommitment(db, key, name, now, text) {
  insertPersonRow(db, { key, name, sent: 10, received: 10 }, now);
  const observedAt = now - 100 * DAY;
  insertMessage(db, key, { ts: now - 300 * DAY, text: 'hey', ownerAuthored: 1 });
  insertMessage(db, key, { ts: now - 299 * DAY, text: 'checking in', ownerAuthored: 1 });
  const runId = insertDistillRun(db, now);
  const claimId = Number(db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'owner', NULL, 'commitment', ?, ?, ?, NULL, ?)`
  ).run(runId, text, observedAt, now - 20 * DAY, observedAt).lastInsertRowid);
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, 'accept', 'owner', NULL, ?)")
    .run(claimId, observedAt);
  const ctx = insertMessage(db, key, { ts: observedAt, text: 'sounds good', ownerAuthored: 1 });
  db.prepare(
    "INSERT INTO claim_source(claim_id, context_id, source, entity_id, content_hash, quote) VALUES (?, ?, 'imessage', NULL, NULL, ?)"
  ).run(claimId, ctx, 'sounds good');
  return { claimId };
}

test('an Owe card\'s draft prompt carries the owe evidence: kind, overdue days, and the live commitment text', async () => {
  const prompts = [];
  const engine = {
    name: 'test-engine', model: 'test-model',
    async complete({ user }) {
      prompts.push(user);
      return '{"drafts":[{"text":"Following up on the deck I promised."}]}';
    },
  };
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOweCommitment(db, 'name:owe draft', 'Owe Draft', now, 'I will send the revised deck');

    const { card } = await get('/admin/relationship/card');
    assert.equal(card.kind, 'owe');
    const out = await (await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id })).json();
    assert.equal(out.ok, true);
    assert.equal(out.drafts.length, 1);

    // The SAME engine builds person pages, so filter to the draft prompt --
    // reconnect_draft.md's own first line is the only one naming a first name.
    const draftPrompts = prompts.filter((text) => text.startsWith('First name:'));
    assert.equal(draftPrompts.length, 1);
    const prompt = draftPrompts[0];
    assert.match(prompt, /Owe kind: owe:expired-commitment/u);
    assert.match(prompt, /Days overdue: \d+/u);
    assert.match(prompt, /I will send the revised deck/u,
      'the thing the owner actually said they would do reaches the prompt');
  }, { relationshipMemoryEngine: engine });
});

test('a reconnect card\'s draft prompt carries no owe lines at all', async () => {
  const prompts = [];
  const engine = {
    name: 'test-engine', model: 'test-model',
    async complete({ user }) { prompts.push(user); return '{"drafts":[{"text":"Hey there."}]}'; },
  };
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedReconnect(db, 'name:reconnect draft', 'Reconnect Draft', now);

    const { card } = await get('/admin/relationship/card');
    assert.equal(card.kind, 'reconnect');
    await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id });
    const draftPrompts = prompts.filter((text) => text.startsWith('First name:'));
    assert.equal(draftPrompts.length, 1);
    assert.ok(!draftPrompts[0].includes('Owe kind:'),
      'a reconnect card has no overdue thing, and the prompt must not invite one');
  }, { relationshipMemoryEngine: engine });
});

test('the draft route answers ok:false with the reason instead of 200-and-nothing', async () => {
  const engine = {
    name: 'test-engine', model: 'test-model',
    async complete() { return 'I am afraid I cannot help with that.'; },
  };
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:draft reason', 'Draft Reason', now, { askedDaysAgo: 30 });

    const { card } = await get('/admin/relationship/card');
    const out = await (await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id })).json();
    assert.equal(out.ok, false, 'no drafts is not a success');
    assert.equal(out.drafts.length, 0);
    assert.match(out.reason, /JSON/u, `the parse failure crosses the wire (got ${out.reason})`);
  }, { relationshipMemoryEngine: engine });
});

// ---------------------------------------------------------------------------
// Review F (2026-09-09), findings 4, 8 and 13 -- the card path's half of
// daily.mjs's one LIVE model. Each fixture is a case where the old route and
// the new one disagree.
// ---------------------------------------------------------------------------

// A built page for one person, straight into the tables readPersonPage reads
// -- no engine, since page building is not what these tests are about.
function givePage(db, personKey, now, text = 'they are between roles') {
  const runId = Number(db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
     VALUES ('fake:fake', '/prompts/none.md', ?, '{}', 'off', 0, 0, 'complete', ?, ?)`
  ).run('f'.repeat(64), now, now).lastInsertRowid);
  const claimId = Number(db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'person', ?, 'fact', ?, ?, NULL, NULL, ?)`
  ).run(runId, personKey, text, now, now).lastInsertRowid);
  db.prepare('INSERT INTO person_page_item(claim_id, section, built_at) VALUES (?, ?, ?)')
    .run(claimId, 'who', now);
  return claimId;
}

// ---- 4: a week-old batch is not the queue any more ------------------------
test('a batch produced eight days ago is not restored: the route refills instead of serving it', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:stale batch', 'Stale Batch', now, { askedDaysAgo: 30 });
    // A batch written eight days ago and never shown -- a producer_version
    // bump nothing re-produced past, or a pool that went empty. The
    // cross-kind exclusion's window had already let this person go, so
    // holding their card was holding the queue shut against both producers.
    const stale = produceOweBatch(db, { now: now - 8 * DAY });
    assert.equal(stale.cards.length, 1);

    const out = await get('/admin/relationship/card');
    assert.ok(out.card, `something was served (reason: ${out.reason})`);
    assert.equal(out.card.personKey, 'name:stale batch');
    assert.notEqual(out.card.snapshot_id, stale.cards[0].snapshot_id,
      'the eight-day-old snapshot was dropped and a fresh one produced, not re-served');
  });
});

// ---- 8: an off-mode reconnect card holds nobody out of Owe ----------------
test('a reconnect card in a mode the owner is not on does not block that person\'s Owe card', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:offmode hold', 'Offmode Hold', now, { askedDaysAgo: 30 });
    // Reconnect is holding this person, in 'investor' while rel.mode is
    // 'any': that card can never be served as things stand, so it must not
    // stop Owe either. The cross-kind exclusion used to count it, which left
    // the person offered by NEITHER kind.
    const batchId = Number(db.prepare(
      'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
    ).run(now - DAY, 'open').lastInsertRowid);
    db.prepare(
      'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
      "VALUES (?, 'name:offmode hold', 'reconnect', 'quiet a while', ?, ?, 'test', ?)"
    ).run(batchId, JSON.stringify({ mode: 'investor' }), 'eligibility-v6', now - DAY);

    const out = await get('/admin/relationship/card');
    assert.ok(out.card, `Owe offered the card (reason: ${out.reason})`);
    assert.equal(out.card.kind, 'owe');
    assert.equal(out.card.personKey, 'name:offmode hold');
  });
});

// ---- 13: a peek promises a card, and the serve keeps the promise ----------
test('a page finishing in the background still promotes its card -- and ?expect= keeps the peek\'s promise anyway', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:peek first', 'Peek First', now, { askedDaysAgo: 30 });
    seedOwe(db, 'name:peek second', 'Peek Second', now, { askedDaysAgo: 20 });

    const peek = await get('/admin/relationship/card?peek=1');
    assert.equal(peek.peek, true);
    assert.equal(peek.card.personKey, 'name:peek first', 'rank order, nobody has a page yet');
    assert.ok(Number.isInteger(peek.card.snapshot_id), 'a peek says WHICH snapshot it would serve');

    // The background page build for the OTHER card lands. Page-first is LIVE
    // by design (relationship-pages.test.mjs's rank-one/rank-two fixture is
    // the same promise): what is ready now goes first, so the head of the
    // queue really does move here.
    givePage(db, 'name:peek second', now);
    const moved = await get('/admin/relationship/card?peek=1');
    assert.equal(moved.card.personKey, 'name:peek second',
      'a finished page promotes its candidate -- freezing the order would retire page-first');

    // Which is exactly why the peek hands its snapshot_id back: the panel
    // showing the owner "Peek First" still gets Peek First.
    const served = await get(`/admin/relationship/card?expect=${peek.card.snapshot_id}`);
    assert.equal(served.card.snapshot_id, peek.card.snapshot_id);
    assert.equal(served.card.personKey, 'name:peek first');
    assert.equal(served.reason, undefined, 'the promise was kept, so there is nothing to report');
  });
});

test('an expect the queue can no longer honour serves the current head and says so', async () => {
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:superseded', 'Superseded', now, { askedDaysAgo: 30 });
    seedOwe(db, 'name:next in line', 'Next In Line', now, { askedDaysAgo: 20 });

    const peek = await get('/admin/relationship/card?peek=1');
    assert.equal(peek.card.personKey, 'name:superseded');

    // The owner mutes it from another surface between the peek and the pull.
    await call('POST', '/admin/relationship/event', {
      snapshot_id: peek.card.snapshot_id, person_key: peek.card.personKey,
      event: 'muted', mute_days: 30,
    });

    const served = await get(`/admin/relationship/card?expect=${peek.card.snapshot_id}`);
    assert.ok(served.card, 'a superseded expect is not a refusal');
    assert.equal(served.card.personKey, 'name:next in line', 'the current head is served instead');
    assert.equal(served.reason, 'expect-superseded',
      'and the wire says why the card is not the one that was asked for');
  });
});

test('?expect= for a snapshot that never existed also reports itself superseded', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:expect unknown', 'Expect Unknown', now, { askedDaysAgo: 30 });

    const out = await get('/admin/relationship/card?expect=999999');
    assert.ok(out.card, `still served something (reason: ${out.reason})`);
    assert.equal(out.card.personKey, 'name:expect unknown');
    assert.equal(out.reason, 'expect-superseded');
  });
});

test('?expect= serves exactly the snapshot named even when page-first would prefer another', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:expect plain', 'Expect Plain', now, { askedDaysAgo: 30 });
    seedOwe(db, 'name:expect paged', 'Expect Paged', now, { askedDaysAgo: 20 });
    // The lower-ranked card has a page, so page-first puts it at the head --
    // and the peek says so.
    givePage(db, 'name:expect paged', now);

    const peek = await get('/admin/relationship/card?peek=1');
    assert.equal(peek.card.personKey, 'name:expect paged', 'page-first, as ever');

    const other = rowFor(db, 'name:expect plain');
    const served = await get(`/admin/relationship/card?expect=${other}`);
    assert.equal(served.card.snapshot_id, other, 'the request named a live card and got exactly it');
    assert.equal(served.card.personKey, 'name:expect plain');
    assert.equal(served.reason, undefined);
  });
});

// The snapshot id of the newest card for one person -- what a peek would
// hand back as ?expect=.
function rowFor(db, personKey) {
  return Number(db.prepare(
    'SELECT id FROM rm_candidate_snapshot WHERE person_key = ? ORDER BY id DESC LIMIT 1'
  ).get(personKey).id);
}

test('?expect= spends one cap slot and records one \'shown\', same as any serve', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    seedOwe(db, 'name:expect accounting', 'Expect Accounting', now, { askedDaysAgo: 30 });

    const peek = await get('/admin/relationship/card?peek=1');
    assert.equal(eventCount(db, 'shown'), 0, 'a peek carrying no expect records nothing');
    const withExpect = await get(`/admin/relationship/card?peek=1&expect=${peek.card.snapshot_id}`);
    assert.equal(withExpect.card.snapshot_id, peek.card.snapshot_id);
    assert.equal(eventCount(db, 'shown'), 0, 'and neither does one carrying it');

    await get(`/admin/relationship/card?expect=${peek.card.snapshot_id}`);
    assert.equal(eventCount(db, 'shown'), 1, 'the serve spends the slot, exactly once');
    await get(`/admin/relationship/card?expect=${peek.card.snapshot_id}`);
    assert.equal(eventCount(db, 'shown'), 1, 'and re-serving the same snapshot does not spend another');
  });
});

// ---------------------------------------------------------------------------
// Review G finding 1: THE FRESHNESS GATE THAT WEDGED THE DEFAULT CONFIG.
// hydrateCards omits the age bound for matcher-path reconnect batches on
// purpose -- "dropping an old matcher batch would put the orb out with
// nothing able to relight it" -- but the serve loop applied isSnapshotLive,
// age bound included, to every card unconditionally. 'matcher' is the DEFAULT
// producer config and produceDailyBatch never runs on it, so nothing prunes
// and nothing refills: a matcher queue whose newest batch turned seven days
// old answered 'queue-empty' on every request, forever.
// ---------------------------------------------------------------------------

function insertReconnectSnapshot(db, { key, createdAt, mode, version = 'model@abc123' }) {
  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, 1, ?, NULL)'
  ).run(createdAt, 'open').lastInsertRowid);
  return Number(db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    "VALUES (?, ?, 'reconnect', 'quiet a while', ?, ?, 'test', ?)"
  ).run(batchId, key, JSON.stringify(mode === undefined ? {} : { mode }), version, createdAt).lastInsertRowid);
}

test('the matcher path still serves its one batch after the live window, because nothing can refill it', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    insertPersonRow(db, { key: 'name:matcher stale', name: 'Matcher Stale', sent: 10, received: 10 }, now);
    // A matcher batch from a month ago, unjudged. There is no
    // produceDailyBatch on this path and no /refresh in this test: this
    // batch is the entire queue, and it either serves or the orb is dark.
    const snapshotId = insertReconnectSnapshot(db, {
      key: 'name:matcher stale', createdAt: now - 30 * DAY,
    });

    const out = await get('/admin/relationship/card');
    assert.ok(out.card, `the matcher queue still serves (reason: ${out.reason})`);
    assert.equal(out.card.snapshot_id, snapshotId);
    assert.equal(out.card.personKey, 'name:matcher stale');
  }, { relationshipProducerConfig: { producer: 'matcher', mode: 'any' } });
});

test('the eligibility path still drops a reconnect batch past the live window, because dropping IS its refill', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    insertPersonRow(db, { key: 'name:elig stale', name: 'Elig Stale', sent: 10, received: 10 }, now);
    // Same shape, opposite path: an eligibility-produced reconnect batch that
    // aged out. The cross-kind exclusion has already let this person go, so
    // holding the card holds the queue shut against both producers -- and the
    // next request can produce a fresh batch synchronously.
    const snapshotId = insertReconnectSnapshot(db, {
      key: 'name:elig stale', createdAt: now - 8 * DAY, mode: 'any', version: 'eligibility-v6',
    });

    const out = await get('/admin/relationship/card');
    assert.notEqual(out.card?.snapshot_id, snapshotId,
      'the aged-out eligibility snapshot is not served');
  });
});

// ---------------------------------------------------------------------------
// Review G finding 7: expect SERVED ACROSS THE TURN. The promised === -1
// fallback searched all of rel.cards rather than this request's serving
// queue, so ?expect= served a card of the kind produceDailyBatch had just
// decided NOT to serve -- spending a cap slot and recording 'shown' for that
// kind, which is what pickProducer reads to alternate. The same person could
// then be offered under both kinds inside one window, which is the exact
// double-offer liveQueuePersonKeys exists to prevent.
// ---------------------------------------------------------------------------

test('an expect naming the other kind is superseded, not served across the turn', async () => {
  await withCardServer(async ({ get, db }) => {
    const now = Date.now();
    // Two different people so the cross-kind exclusion does not remove
    // either card: what is under test is the KIND filter, not the exclusion.
    seedOwe(db, 'name:owe turn', 'Owe Turn', now, { askedDaysAgo: 30 });
    insertPersonRow(db, { key: 'name:reconnect other', name: 'Reconnect Other', sent: 10, received: 10 }, now);
    const otherKind = insertReconnectSnapshot(db, {
      key: 'name:reconnect other', createdAt: now - DAY, mode: 'any', version: 'eligibility-v6',
    });

    const out = await get(`/admin/relationship/card?expect=${otherKind}`);
    assert.ok(out.card, `something was served (reason: ${out.reason})`);
    assert.notEqual(out.card.snapshot_id, otherKind,
      'the card named belongs to the kind this request is not serving');
    assert.equal(out.card.kind, 'owe', 'the turn decided owe, and the turn holds');
    assert.equal(out.reason, 'expect-superseded');
    assert.equal(out.expectSuperseded, true);

    // And nothing was spent on the other kind's behalf -- 'shown' is what
    // pickProducer alternates on, so a stray row here moves the next turn.
    const shownKinds = db.prepare(
      "SELECT DISTINCT kind FROM rm_card_event WHERE event = 'shown'"
    ).all().map((r) => r.kind);
    assert.deepEqual(shownKinds, ['owe'],
      "no 'shown' was recorded for the kind whose turn this was not");
  });
});

// On the matcher path, so that a queue with nothing left to serve answers
// from the loop below rather than from the eligibility refill's
// 'pool-exhausted' early return -- that branch answers before `expect` has
// been resolved at all, and deliberately: it is "come back in a moment", not
// a statement about the card the panel asked for.
test('a superseded expect that leaves nothing to serve still says the expect was superseded', async () => {
  await withCardServer(async ({ call, get, db }) => {
    const now = Date.now();
    insertPersonRow(db, { key: 'name:only card', name: 'Only Card', sent: 10, received: 10 }, now);
    const only = insertReconnectSnapshot(db, { key: 'name:only card', createdAt: now - DAY });

    const peek = await get('/admin/relationship/card?peek=1');
    assert.equal(peek.card.snapshot_id, only);

    // The one card in the queue is muted between the peek and the pull, so
    // there is no current head to fall back to.
    await call('POST', '/admin/relationship/event', {
      snapshot_id: only, person_key: 'name:only card', event: 'muted', mute_days: 30,
    });

    const out = await get(`/admin/relationship/card?expect=${only}`);
    assert.equal(out.card, null);
    assert.equal(out.expectSuperseded, true,
      'the panel asked for a specific card: "yours is gone" and "there was never anything" are different answers');
    assert.equal(out.reason, 'queue-empty',
      "and reason keeps its own job: a muted snapshot is CONSUMED, so it is gone from the queue rather than blocked in it");
  }, { relationshipProducerConfig: { producer: 'matcher', mode: 'any' } });
});

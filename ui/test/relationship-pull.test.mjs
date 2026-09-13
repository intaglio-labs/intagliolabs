// THE CAP COUNTS INTERRUPTIONS, NOT CARDS (2026-09-13, owner decision).
//
// Before this, every card handed over counted against the daily cap. On the
// shipped one-a-day that made the day's single interruption also the day's
// single card: the owner rejected the one person they were offered -- wrong
// person, bad time, already texted them -- and the honest answer to "show me
// another" was "come back tomorrow". A rejection is an interruption that
// bought nothing, and the owner asking for another one is not the app
// interrupting again.
//
// So a rejection buys a PULL: `?pull=1` on the card route, up to
// PULLS_PER_DAY, served past a spent cap and recorded as `pulled` on its own
// 'shown' row so nothing downstream counts it as an interruption either. An
// accept ends the day whether it was pulled or not -- "will text them" is the
// outcome the card exists for.
//
// The matcher path is the stub here deliberately: it serves a fixed queue with
// no refill, so these tests are about the GATE and nothing else. The
// eligibility producer's own refill is pinned in relationship-producer and
// relationship-routes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openDb, start } from '../server/hermes.mjs';
import { PULLS_PER_DAY, createControls, startOfLocalDay } from '../server/relationship/controls.mjs';

const TOKEN = 'e'.repeat(64);
const ONE_A_DAY = { max: 1, windowMs: 86_400_000 };

// Five, so the fourth pull has something to be refused for: a refusal that is
// really an empty queue would pass a test written against a shorter one.
const QUEUE = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((name, i) => ({
  personKey: `name:${name}`, name: `${name[0].toUpperCase()}${name.slice(1)} Person`, kind: 'reconnect',
  sentence: 'Text them.', role: 'friend', focus: null, label: null, left: null, leftTone: null,
  evidence: { topics: [], messages: 40 - i, dormancyDays: 300 - i, meetings: 0, lastMeetingDaysAgo: null },
  producer_version: 'rm-match-v13',
}));

async function withCardServer(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-pull-'));
  // The modes are retired by default; nothing in this file is about them, and
  // 'none' keeps the run off the developer's own ~/.hazlie/features.json.
  const previousFeatures = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HAZLIE_FEATURES_OVERRIDE = 'none';
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipMatcher: async () => ({ cards: structuredClone(QUEUE), focus: 'x', currentTopics: [] }),
    relationshipCap: ONE_A_DAY,
    relationshipProducerConfig: { producer: 'matcher', mode: 'any' },
    relationshipMemoryEngine: null,
    ownerConfigPath: join(dir, 'config.json'),
    peopleProjectionAutoRebuild: false,
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const get = async (path) => (await call('GET', path)).json();
  const db = server.db;
  // One refresh, one batch, no refill: the matcher path only ever serves what
  // it was given.
  await call('POST', '/admin/relationship/refresh');
  await new Promise((r) => setTimeout(r, 60));
  const reject = (card) => call('POST', '/admin/relationship/event', {
    snapshot_id: card.snapshot_id, person_key: card.personKey, event: 'dismissed', reason: 'wrong-time',
  });
  const accept = (card) => call('POST', '/admin/relationship/event', {
    snapshot_id: card.snapshot_id, person_key: card.personKey, event: 'accepted',
  });
  try {
    await fn({ call, get, db, reject, accept });
  } finally {
    await server.close();
    if (previousFeatures === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previousFeatures;
  }
}

const shownRows = (db) => db.prepare(
  "SELECT person_key, pulled FROM rm_card_event WHERE event = 'shown' ORDER BY id"
).all().map((r) => ({ personKey: r.person_key, pulled: Number(r.pulled) }));

test('one interruption, then three pulls, then come back tomorrow', async () => {
  await withCardServer(async ({ get, db, reject }) => {
    const first = await get('/admin/relationship/card');
    assert.equal(first.card.personKey, 'name:alpha', 'the day opens with one interruption');
    assert.equal(first.pullsLeft, PULLS_PER_DAY, 'nothing has been pulled yet');

    // THE CAP IS STILL A CAP. An ordinary poll after the day's interruption is
    // spent gets exactly what it always got -- the pull is an ASK, and nothing
    // is served past the cap without one.
    await reject(first.card);
    const polled = await get('/admin/relationship/card');
    assert.equal(polled.card, null);
    assert.equal(polled.reason, 'cap');
    assert.equal(polled.retryAfterMs, undefined, 'an ordinary cap refusal is unchanged');

    const pulled = [];
    for (let i = 1; i <= PULLS_PER_DAY; i++) {
      const out = await get('/admin/relationship/card?pull=1');
      assert.ok(out.card, `pull ${i} was served (reason: ${out.reason})`);
      assert.equal(out.pullsLeft, PULLS_PER_DAY - i, `pull ${i} spends exactly one`);
      pulled.push(out.card.personKey);
      await reject(out.card);
    }
    assert.deepEqual(pulled, ['name:bravo', 'name:charlie', 'name:delta'],
      'each pull serves the NEXT candidate, not the one just rejected');

    const fourth = await get('/admin/relationship/card?pull=1');
    assert.equal(fourth.card, null, 'and echo is still queued, so this is the budget refusing, not an empty queue');
    assert.equal(fourth.reason, 'pulls-exhausted');
    assert.equal(fourth.pullsLeft, 0);
    assert.ok(fourth.retryAfterMs > 0 && fourth.retryAfterMs <= 86_400_000,
      `the refusal says when it lifts (${fourth.retryAfterMs} ms to local midnight)`);

    // THE DURABLE HALF. Four cards were handed over and ONE of them was an
    // interruption; a reader of this log a week later must be able to tell
    // them apart, which is the whole reason `pulled` is a column.
    assert.deepEqual(shownRows(db), [
      { personKey: 'name:alpha', pulled: 0 },
      { personKey: 'name:bravo', pulled: 1 },
      { personKey: 'name:charlie', pulled: 1 },
      { personKey: 'name:delta', pulled: 1 },
    ]);
  });
});

test('an accept ends the day, with pulls still in the budget', async () => {
  await withCardServer(async ({ get, reject, accept }) => {
    const first = await get('/admin/relationship/card');
    await reject(first.card);
    const second = await get('/admin/relationship/card?pull=1');
    assert.equal(second.card.personKey, 'name:bravo');
    assert.equal(second.pullsLeft, PULLS_PER_DAY - 1, 'two pulls still unspent');

    // "will text them" on a PULLED card. The day is done all the same: what
    // buys another look is a rejection, and this was not one.
    await accept(second.card);
    const after = await get('/admin/relationship/card?pull=1');
    assert.equal(after.card, null);
    assert.equal(after.reason, 'pulls-exhausted');
    assert.equal(after.pullsLeft, 0, 'the budget reads empty because the day is over, not because it was spent');
    assert.ok(after.retryAfterMs > 0);
  });
});

test("yesterday's pulls and yesterday's accept are yesterday's", async () => {
  await withCardServer(async ({ get, db, reject }) => {
    // The budget is a LOCAL CALENDAR DAY, not a rolling window. Written
    // straight into the log at a timestamp just before midnight: three pulls
    // and the accept that ended that day.
    const beforeMidnight = startOfLocalDay(Date.now()) - 1000;
    const ins = db.prepare(
      'INSERT INTO rm_card_event(person_key, kind, event, reason, note, rule_version, snapshot_id, pulled, time_band, created_at) ' +
      "VALUES (?, 'reconnect', ?, NULL, NULL, 'rm-match-v13', NULL, ?, 'night', ?)"
    );
    for (const who of ['name:one', 'name:two', 'name:three']) ins.run(who, 'shown', 1, beforeMidnight);
    ins.run('name:three', 'accepted', 0, beforeMidnight);

    const first = await get('/admin/relationship/card');
    assert.ok(first.card, 'yesterday spent no part of today');
    assert.equal(first.pullsLeft, PULLS_PER_DAY, 'a full budget, however yesterday went');
    await reject(first.card);
    const pulled = await get('/admin/relationship/card?pull=1');
    assert.ok(pulled.card, `today's first pull is served (reason: ${pulled.reason})`);
    assert.equal(pulled.pullsLeft, PULLS_PER_DAY - 1);
  });
});

test('a pull is a fallback, not a preference: an unspent cap pays first', async () => {
  // An owner who raised their cap keeps the cards they configured before a
  // rejection's allowance is touched -- so `pulled` never marks a row that was
  // inside the cap all along.
  await withCardServer(async ({ get, db, reject }) => {
    const first = await get('/admin/relationship/card');
    await reject(first.card);
    const second = await get('/admin/relationship/card?pull=1');
    assert.equal(second.card.personKey, 'name:bravo');
    assert.equal(second.pullsLeft, PULLS_PER_DAY, 'the second interruption paid for it, not the budget');
    assert.deepEqual(shownRows(db), [
      { personKey: 'name:alpha', pulled: 0 },
      { personKey: 'name:bravo', pulled: 0 },
    ]);

    // Now the cap really is spent, and the same request spends a pull.
    await reject(second.card);
    const third = await get('/admin/relationship/card?pull=1');
    assert.equal(third.card.personKey, 'name:charlie');
    assert.equal(third.pullsLeft, PULLS_PER_DAY - 1);
  }, { relationshipCap: { max: 2, windowMs: 86_400_000 } });
});

test('a peek asks whether a pull would be served, and spends nothing asking', async () => {
  await withCardServer(async ({ get, db, reject }) => {
    const first = await get('/admin/relationship/card');
    await reject(first.card);

    // The orb's ordinary poll still sees a spent cap.
    const plain = await get('/admin/relationship/card?peek=1');
    assert.equal(plain.card, null);
    assert.equal(plain.reason, 'cap');

    // The panel's question -- "is there another one behind the button" -- is
    // answered without pressing it: no 'shown' row, no budget spent.
    const teased = await get('/admin/relationship/card?peek=1&pull=1');
    assert.equal(teased.peek, true);
    assert.equal(teased.card.personKey, 'name:bravo');
    assert.equal(teased.pullsLeft, PULLS_PER_DAY, 'a peek is not a pull');
    assert.deepEqual(shownRows(db), [{ personKey: 'name:alpha', pulled: 0 }]);

    // And the serve behind it is the card that was teased.
    const served = await get('/admin/relationship/card?pull=1');
    assert.equal(served.card.personKey, 'name:bravo');
    assert.equal(served.pullsLeft, PULLS_PER_DAY - 1);
  });
});

test('anything but pull=1 is not a pull', async () => {
  await withCardServer(async ({ get, reject }) => {
    const first = await get('/admin/relationship/card');
    await reject(first.card);
    for (const query of ['pull=0', 'pull=true', 'pull=yes', 'pull']) {
      const out = await get(`/admin/relationship/card?${query}`);
      assert.equal(out.card, null, `?${query} must not serve past the cap`);
      assert.equal(out.reason, 'cap');
    }
  });
});

// --- THE DATABASE THAT PREDATES THE COLUMN ---------------------------------
//
// rm_card_event has been serving on the reference install since long before
// `pulled` existed, and CREATE TABLE IF NOT EXISTS is a no-op against a table
// that is already there -- so the column arrives by ALTER, healed on every
// open (hermes.mjs healCardEventColumns) rather than inside a version branch a
// mis-stamped database would skip. Without it the failure is not a startup
// error: it is the INSERT throwing at the moment a card is handed over.
test('an rm_card_event from before the column gains it on open, and still counts as an interruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-pull-heal-'));
  const dbPath = join(dir, 'context.db');
  const now = Date.now();

  const legacy = new DatabaseSync(dbPath);
  try {
    // The table exactly as it shipped, and a database stamped current -- the
    // shape a version branch could never reach again.
    legacy.exec(`
      CREATE TABLE rm_card_event(
        id           INTEGER PRIMARY KEY,
        person_key   TEXT NOT NULL,
        kind         TEXT NOT NULL,
        snapshot_id  INTEGER,
        event        TEXT NOT NULL,
        reason       TEXT,
        note         TEXT,
        rule_version TEXT NOT NULL,
        time_band    TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      INSERT INTO rm_card_event(person_key, kind, event, rule_version, time_band, created_at)
        VALUES ('name:before', 'reconnect', 'shown', 'rm-match-v13', 'morning', ${now - 1000});
      PRAGMA user_version = 14;
    `);
  } finally {
    legacy.close();
  }

  const db = openDb(dbPath);
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('rm_card_event')").all().map((c) => c.name);
    assert.ok(columns.includes('pulled'), 'the column is healed onto the existing table');
    const row = db.prepare("SELECT pulled FROM rm_card_event WHERE person_key = 'name:before'").get();
    assert.equal(Number(row.pulled), 0,
      'and the rows that predate it read as interruptions, which is what every one of them was');

    const controls = createControls(db);
    assert.equal(controls.underGlobalCap({ max: 1, windowMs: 86_400_000, now }), false,
      'so a one-a-day install that was already interrupted today is still capped');
    assert.equal(controls.pullsUsed({ now }), 0, 'and none of it reads as a pull');

    // The write side works against the healed table too -- the failure this
    // heal prevents is an INSERT, not a SELECT.
    controls.recordEvent({ personKey: 'name:after', kind: 'reconnect', event: 'shown',
      ruleVersion: 'rm-match-v13', pulled: true, now });
    assert.equal(controls.pullsUsed({ now }), 1);
  } finally {
    db.close();
  }
});

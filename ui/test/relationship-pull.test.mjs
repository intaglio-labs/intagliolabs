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
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, start } from '../server/hermes.mjs';
import {
  PULLS_PER_DAY, cardStats, createControls, msUntilLocalMidnight, startOfLocalDay,
} from '../server/relationship/controls.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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

// --- WHAT A PULL HAS TO BE BOUGHT WITH -------------------------------------

test('a pull nothing rejected is a poll that called itself something else', () => {
  // `?pull=1` is a query parameter on a loopback route, and serveAllowance used
  // to take the caller's word for it: any client sending it past a spent cap
  // got a card off a budget nothing earned, recorded `pulled`, and so uncounted
  // by the cap for ever after. The fixture is the reachable version of that --
  // the day's card was served, never judged, and then suppressed from the
  // settings surface, so it leaves the queue without a verdict and the next
  // candidate is at the head.
  return withCardServer(async ({ get, db }) => {
    const first = await get('/admin/relationship/card');
    assert.equal(first.card.personKey, 'name:alpha');
    db.prepare('INSERT INTO rm_suppression(person_key, created_at) VALUES (?, ?)')
      .run('name:alpha', Date.now());

    const asked = await get('/admin/relationship/card?pull=1');
    assert.equal(asked.card, null, 'bravo is queued and servable; what is missing is the rejection');
    assert.equal(asked.reason, 'cap', 'nothing was exhausted -- this is the ordinary cap answer');
    assert.equal(asked.pullsLeft, PULLS_PER_DAY, 'and the budget is untouched');
    assert.deepEqual(shownRows(db), [{ personKey: 'name:alpha', pulled: 0 }]);
  });
});

test('a mute is a rejection, and buys a pull like any other', async () => {
  // All four of the card's reject taps land as 'dismissed'; the card's own
  // "mute 30d" lands as 'muted'. Both are verdicts that produced nothing.
  await withCardServer(async ({ call, get, db }) => {
    const first = await get('/admin/relationship/card');
    await call('POST', '/admin/relationship/event', {
      snapshot_id: first.card.snapshot_id, person_key: first.card.personKey,
      event: 'muted', mute_days: 30,
    });
    const pulled = await get('/admin/relationship/card?pull=1');
    assert.equal(pulled.card?.personKey, 'name:bravo', `served (reason: ${pulled.reason})`);
    assert.deepEqual(shownRows(db), [
      { personKey: 'name:alpha', pulled: 0 },
      { personKey: 'name:bravo', pulled: 1 },
    ]);
  });
});

test("an accept nobody was interrupted for does not end the owner's day", async () => {
  // rm_card_event is reached by more than the card route: a review-only verdict
  // names no snapshot. Counting one as "the day had its outcome" silently
  // halved the feature on any install where something else writes an accept.
  await withCardServer(async ({ get, db, reject }) => {
    db.prepare(
      'INSERT INTO rm_card_event(person_key, kind, event, reason, note, rule_version, snapshot_id, pulled, time_band, created_at) '
      + "VALUES ('name:elsewhere', 'reconnect', 'accepted', NULL, NULL, 'rm-match-v13', NULL, 0, 'morning', ?)"
    ).run(Date.now());

    const first = await get('/admin/relationship/card');
    assert.equal(first.pullsLeft, PULLS_PER_DAY, 'a card was never offered for that row');
    await reject(first.card);
    const pulled = await get('/admin/relationship/card?pull=1');
    assert.equal(pulled.card?.personKey, 'name:bravo', `served (reason: ${pulled.reason})`);
  });
});

// --- THE CLOCK THE REFUSAL COUNTS DOWN TO ----------------------------------

test('retryAfterMs lands on the boundary the budget itself uses', async () => {
  await withCardServer(async ({ get, reject }) => {
    const first = await get('/admin/relationship/card');
    await reject(first.card);
    for (let i = 0; i < PULLS_PER_DAY; i++) {
      const out = await get('/admin/relationship/card?pull=1');
      await reject(out.card);
    }
    const refused = await get('/admin/relationship/card?pull=1');
    assert.equal(refused.reason, 'pulls-exhausted');

    // The same instant reads the same boundary: a reply counting down to a
    // 24h-from-now that the day's own count does not use would tell the owner
    // to come back at an hour when nothing changes.
    const at = Date.now();
    assert.ok(Math.abs(refused.retryAfterMs - msUntilLocalMidnight(at)) < 2000,
      `${refused.retryAfterMs} should be the wait to local midnight (${msUntilLocalMidnight(at)})`);
    assert.ok(startOfLocalDay(at + refused.retryAfterMs) > startOfLocalDay(at),
      'and it lands in the next local day, not 24 hours out');
  });
});

test('the local day starts when the date changes, even where midnight does not exist', () => {
  // America/Santiago moves its clocks AT midnight: on 2026-09-06 the local
  // times 00:00-00:59 never happen, so the first instant of that date is 01:00.
  // A boundary computed by arithmetic (or by trusting what an engine returns
  // for a local time that does not exist) puts that hour's rows on the wrong
  // side of the count.
  const previous = process.env.TZ;
  process.env.TZ = 'America/Santiago';
  try {
    const noon = new Date(2026, 8, 6, 12, 0, 0, 0).getTime();
    const start = startOfLocalDay(noon);
    assert.equal(new Date(start).getDate(), 6, 'the boundary is on the day it belongs to');
    assert.equal(new Date(start).getHours(), 1, 'which begins at 01:00 on this one day');
    assert.equal(new Date(start - 1).getDate(), 5, 'and the millisecond before it is yesterday');
    assert.equal(msUntilLocalMidnight(noon), new Date(2026, 8, 7, 0, 0, 0, 0).getTime() - noon,
      'the next boundary is the next date change, 12 hours on');

    const ordinary = new Date(2026, 8, 13, 12, 0, 0, 0).getTime();
    assert.equal(new Date(startOfLocalDay(ordinary)).getHours(), 0, 'every other day is plain midnight');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

// --- THE NUMBERS THE PROJECT READS OUT OF THE LOG --------------------------

test('cardStats tells an interruption from a pull', async () => {
  // The whole point of the column is that the two are different events, and
  // this is the one place the project reads numbers out of this log. A day that
  // used to contribute one 'shown' row can now contribute four.
  await withCardServer(async ({ get, db, reject }) => {
    const first = await get('/admin/relationship/card');
    await reject(first.card);
    const second = await get('/admin/relationship/card?pull=1');
    assert.ok(second.card);

    const { allTime } = cardStats(db, { now: Date.now() });
    assert.equal(allTime.reconnect.shown, 2, 'two cards were handed over');
    assert.equal(allTime.reconnect.shownInterrupt, 1, 'one of them interrupted the owner');
    assert.equal(allTime.reconnect.shownPulled, 1, 'the other one they asked for');
    assert.equal(allTime.owe.shown, 0);
    assert.equal(allTime.owe.shownInterrupt, 0);
    assert.equal(allTime.owe.shownPulled, 0);
  });
});

// --- THE ORDER THE SLOT IS SPENT IN ----------------------------------------
//
// A pull used to be recorded before the three gates that can still drop a card
// at serve time -- quote row deleted, claim deleted, claim rejected between
// produce and serve -- so a button press could spend the slot, start the
// person's seven-day cooldown, and answer "that's enough for today" having
// shown nothing.
//
// IT CANNOT BE REACHED FROM OUTSIDE, and that is why this test reads the source
// rather than the wire: cardBlockReason (which filters the queue moments
// earlier, in the same synchronous request) asks those three questions of the
// same three rows, so nothing but a concurrent writer can make the two answers
// differ, and this route never yields. The order is the invariant; assert the
// order.
test('the shown row is written after the receipt resolves, not before', () => {
  const source = readFileSync(join(here, '..', 'server', 'hermes.mjs'), 'utf8');
  const start = source.indexOf("url.pathname === '/admin/relationship/card'");
  const end = source.indexOf("url.pathname === '/admin/relationship/event'");
  assert.ok(start > 0 && end > start, 'found the card route');
  const route = source.slice(start, end);

  const gate = route.indexOf('serveAllowance({');
  const quote = route.indexOf('SELECT text FROM context WHERE id = ?');
  const claim = route.indexOf('SELECT action FROM claim_decision');
  const recorded = route.indexOf("event: 'shown'");
  assert.ok(gate > 0 && quote > 0 && claim > 0 && recorded > 0, 'found all four');
  assert.ok(gate < quote, 'the gate is asked before the work, so nothing is resolved for a card that cannot be served');
  assert.ok(quote < recorded && claim < recorded,
    'and the slot is spent only once the card has a receipt to show');
});

// --- WHAT THE VERDICT ITSELF SAYS ------------------------------------------
//
// The page draws "show me another" from the budget, and the verdict is the
// moment it needs the number: a rejection is what buys a pull, and an accept is
// what ends the day. Answering it here saves the page a request to the card
// route whose only purpose would be to be refused -- and stops it offering a
// button that is already spent.
test('the verdict reply carries the budget, duplicates included', async () => {
  await withCardServer(async ({ call, get }) => {
    const first = await get('/admin/relationship/card');
    const rejected = await (await call('POST', '/admin/relationship/event', {
      snapshot_id: first.card.snapshot_id, person_key: first.card.personKey,
      event: 'dismissed', reason: 'wrong-time',
    })).json();
    assert.deepEqual(rejected, { ok: true, pullsLeft: PULLS_PER_DAY },
      'a rejection spends no part of the budget -- the serve it buys does');

    const opened = await (await call('POST', '/admin/relationship/event', {
      snapshot_id: first.card.snapshot_id, person_key: first.card.personKey, event: 'opened',
    })).json();
    assert.equal(opened.pullsLeft, PULLS_PER_DAY, 'every reply from this route answers it');

    const second = await get('/admin/relationship/card?pull=1');
    assert.equal(second.pullsLeft, PULLS_PER_DAY - 1);
    const openedTwice = await (await call('POST', '/admin/relationship/event', {
      snapshot_id: second.card.snapshot_id, person_key: second.card.personKey, event: 'opened',
    })).json();
    assert.equal(openedTwice.pullsLeft, PULLS_PER_DAY - 1, 'the pulled serve is what spent one');

    // THE ACCEPT'S OWN REPLY ALREADY SAYS THE DAY IS OVER, rather than the page
    // learning it on the next poll with the button still on screen.
    const accepted = await (await call('POST', '/admin/relationship/event', {
      snapshot_id: second.card.snapshot_id, person_key: second.card.personKey, event: 'accepted',
    })).json();
    assert.deepEqual(accepted, { ok: true, pullsLeft: 0 });

    // And the retry of a verdict that already landed answers the same thing it
    // did the first time -- a duplicate that reported a full budget would put
    // the button back on a day that is done.
    const retried = await (await call('POST', '/admin/relationship/event', {
      snapshot_id: second.card.snapshot_id, person_key: second.card.personKey, event: 'accepted',
    })).json();
    assert.equal(retried.duplicate, true);
    assert.equal(retried.pullsLeft, 0);

    const dupOpened = await (await call('POST', '/admin/relationship/event', {
      snapshot_id: second.card.snapshot_id, person_key: second.card.personKey, event: 'opened',
    })).json();
    assert.equal(dupOpened.duplicate, true);
    assert.equal(dupOpened.pullsLeft, 0);
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

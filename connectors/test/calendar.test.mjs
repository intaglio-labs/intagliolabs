// The calendar source against the REAL hermes and a REAL fixture store — the
// seams under test are the SQLite read, the /ingest upsert, and the window
// reconciliation, so none of them is mocked. The fixture Calendar.sqlitedb is
// built in-test with the minimal real schema (exact table/column names from
// the measured dumps in ops/PROBES.md / ops/probes/probe-calendar-contacts.mjs)
// and mutated between runs the way Calendar.app would mutate the live store:
// edits, reschedules, cancellations.
//
// Tests run in file order on purpose: each one advances the same fixture and
// the same hermes corpus through one lifecycle step.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../../ui/server/hermes.mjs';
import { adminDeleteEntities, adminEntities, ingest } from '../lib/ingestClient.mjs';
import { APPLE_EPOCH_MS } from '../lib/appleTime.mjs';
import { createLogger } from '../lib/log.mjs';
import calendarSource, { createCalendarSource, scanWindow } from '../sources/calendar.mjs';

const TEST_LLAMA_KEY = 'a'.repeat(64);
const TEST_BEARER_TOKEN = 'c'.repeat(64);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

// A pinned "now" so the fixture's window membership is deterministic; the
// connector never reads the wall clock (ctx.now only).
const NOW = Date.UTC(2026, 7, 19, 17, 0, 0);

const appleSecs = (ms) => (ms - APPLE_EPOCH_MS) / 1000;
const idFor = (uid, slotMs) => `calendar:${uid}:${Math.floor(slotMs / 1000)}`;

// Local-day helpers mirroring the connector's all-day contract (Date-based so
// a DST-shifted day still lands on a real midnight in any test timezone).
function floorLocalMidnight(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function nextLocalMidnight(localMidnightMs) {
  const d = new Date(localMidnightMs);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// --- fixture events --------------------------------------------------------------
// E1 single timed event, E2 recurring with 3 occurrences, E3 all-day,
// E4 timed but outside the steady window (backfill-only).
const E1_START = NOW + 2 * DAY + 3 * HOUR;
const E1_END = E1_START + 30 * MINUTE;
const E2_BASE = NOW + 1 * DAY + 2 * HOUR;
const E2_STARTS = [E2_BASE, E2_BASE + 7 * DAY, E2_BASE + 14 * DAY];
const E2_RRULE = 'FREQ=WEEKLY;INTERVAL=1';
const E3_DAY = floorLocalMidnight(NOW + 3 * DAY);
const E3_END = E3_DAY + DAY;
const E4_START = NOW + 45 * DAY;
const E4_END = E4_START + HOUR;

const FIXTURE_SCHEMA = `
CREATE TABLE Calendar(
  ROWID INTEGER PRIMARY KEY,
  title TEXT
);
CREATE TABLE CalendarItem(
  ROWID INTEGER PRIMARY KEY,
  summary TEXT,
  all_day INTEGER,
  unique_identifier TEXT,
  rrule TEXT
);
CREATE TABLE OccurrenceCache(
  ROWID INTEGER PRIMARY KEY,
  day INTEGER,
  event_id INTEGER,
  calendar_id INTEGER,
  store_id INTEGER,
  occurrence_date REAL,
  occurrence_start_date REAL,
  occurrence_end_date REAL
);
`;

let dir;
let hermes;
let opts;
let fixturePath;
let fx; // writable handle the tests use to play Calendar.app
let log;
let source;

function insertOccurrence(db, { eventId, calendarId, startMs, endMs, slotMs = startMs }) {
  db.prepare(
    'INSERT INTO OccurrenceCache(day, event_id, calendar_id, store_id, occurrence_date, occurrence_start_date, occurrence_end_date) ' +
      'VALUES (?, ?, ?, 1, ?, ?, ?)'
  ).run(
    appleSecs(floorLocalMidnight(startMs)),
    eventId,
    calendarId,
    appleSecs(slotMs),
    appleSecs(startMs),
    appleSecs(endMs)
  );
}

function buildFixture(path) {
  const db = new DatabaseSync(path);
  db.exec(FIXTURE_SCHEMA);
  db.prepare('INSERT INTO Calendar(ROWID, title) VALUES (?, ?)').run(1, 'Work');
  db.prepare('INSERT INTO Calendar(ROWID, title) VALUES (?, ?)').run(2, 'Home');
  const item = db.prepare(
    'INSERT INTO CalendarItem(ROWID, summary, all_day, unique_identifier, rrule) VALUES (?, ?, ?, ?, ?)'
  );
  item.run(1, 'Dentist', 0, 'uid-single', null);
  item.run(2, 'Standup', 0, 'uid-standup', E2_RRULE);
  item.run(3, 'Anniversary', 1, 'uid-allday', null);
  item.run(4, 'Offsite', 0, 'uid-far', null);
  insertOccurrence(db, { eventId: 1, calendarId: 1, startMs: E1_START, endMs: E1_END });
  for (const startMs of E2_STARTS) {
    insertOccurrence(db, { eventId: 2, calendarId: 1, startMs, endMs: startMs + 15 * MINUTE });
  }
  insertOccurrence(db, { eventId: 3, calendarId: 2, startMs: E3_DAY, endMs: E3_END });
  insertOccurrence(db, { eventId: 4, calendarId: 1, startMs: E4_START, endMs: E4_END });
  return db;
}

function makeCtx({ backfill = false, ingestImpl } = {}) {
  return {
    state: {}, // the source is cursor-free; the daemon owns recordRun
    ingest: ingestImpl ?? ((rows) => ingest(rows, opts)),
    admin: {
      entities: (args) => adminEntities(args, opts),
      deleteEntities: (args) => adminDeleteEntities(args, opts),
    },
    config: {},
    cacheDir: join(dir, 'cache'),
    log,
    now: () => NOW,
    backfill,
  };
}

async function steadyEntityIds() {
  const { fromTs, toTs } = scanWindow(NOW, false);
  return (await adminEntities({ source: 'calendar', fromTs, toTs }, opts)).map((e) => e.entity_id);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'connectors-calendar-test-')); // mkdtemp dirs are 0700
  const tokenFile = join(dir, 'hermes-token.txt');
  writeFileSync(tokenFile, `${TEST_BEARER_TOKEN}\n`, { mode: 0o600 });
  hermes = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
  });
  opts = { baseUrl: `http://127.0.0.1:${hermes.port}`, tokenFile, backoffMs: 1 };
  log = createLogger({ path: join(dir, 'logs', 'connectors.log') });
  fixturePath = join(dir, 'Calendar.sqlitedb');
  fx = buildFixture(fixturePath);
  source = createCalendarSource({ candidates: [fixturePath] });
});

after(async () => {
  try {
    fx?.close();
  } catch {}
  log?.close();
  await hermes?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the default export satisfies the daemon source contract', () => {
  assert.equal(calendarSource.name, 'calendar');
  assert.equal(typeof calendarSource.needs, 'function');
  assert.equal(typeof calendarSource.run, 'function');
  assert.deepEqual(calendarSource.needs(), []);
});

test('scanWindow: steady −7d..+30d, backfill −90d..+60d', () => {
  assert.deepEqual(scanWindow(NOW, false), { fromTs: NOW - 7 * DAY, toTs: NOW + 30 * DAY });
  assert.deepEqual(scanWindow(NOW, true), { fromTs: NOW - 90 * DAY, toTs: NOW + 60 * DAY });
});

test('first steady scan ingests the window (5 rows) with the pinned row shape', async () => {
  const delivered = [];
  const recordingCtx = makeCtx({
    ingestImpl: (rows) => {
      delivered.push(...rows);
      return ingest(rows, opts);
    },
  });
  const counts = await source.run(recordingCtx);
  assert.deepEqual(counts, { ingested: 5, updated: 0, unchanged: 0, deleted: 0 });
  assert.equal(delivered.length, 5);

  const byId = new Map(delivered.map((r) => [r.entity_id, r]));
  // The far event sits outside the steady window and must not travel.
  assert.equal([...byId.keys()].some((id) => id.includes('uid-far')), false);

  // Timed single event: ts = start; start_ms/end_ms are the PINNED contract
  // the digest computes meeting-hours from.
  const dentist = byId.get(idFor('uid-single', E1_START));
  assert.ok(dentist, 'dentist row missing');
  assert.equal(dentist.source, 'calendar');
  assert.equal(dentist.ts, E1_START);
  assert.deepEqual(dentist.meta, {
    event_uid: 'uid-single',
    start_ms: E1_START,
    end_ms: E1_END,
    calendar: 'Work',
    all_day: false,
  });
  assert.match(dentist.text, /^"Dentist" .+ \(Work\)$/);
  assert.match(dentist.text, /2026/);

  // Recurring: one entity per occurrence, slot in the id, rrule in meta.
  for (const startMs of E2_STARTS) {
    const row = byId.get(idFor('uid-standup', startMs));
    assert.ok(row, `standup occurrence at ${startMs} missing`);
    assert.equal(row.ts, startMs);
    assert.equal(row.meta.rrule, E2_RRULE);
    assert.equal(row.meta.start_ms, startMs);
    assert.equal(row.meta.end_ms, startMs + 15 * MINUTE);
    assert.equal(row.meta.all_day, false);
  }

  // All-day: local day boundaries + all_day:true so the digest can EXCLUDE
  // it from meeting-hours; no rrule key when the store holds none.
  const anniversary = byId.get(idFor('uid-allday', E3_DAY));
  assert.ok(anniversary, 'all-day row missing');
  assert.equal(anniversary.ts, E3_DAY);
  const expectedEnd = floorLocalMidnight(E3_END) === E3_END ? E3_END : nextLocalMidnight(floorLocalMidnight(E3_END));
  assert.deepEqual(anniversary.meta, {
    event_uid: 'uid-allday',
    start_ms: E3_DAY,
    end_ms: expectedEnd,
    calendar: 'Home',
    all_day: true,
  });
  assert.match(anniversary.text, /^"Anniversary" all day .+ \(Home\)$/);
  assert.equal('rrule' in dentist.meta, false);

  // The snapshot is deleted after the scan — no lingering copy of the
  // household calendar in the cache dir.
  const leftovers = readdirSync(join(dir, 'cache', 'calendar')).filter((f) => f.includes('snapshot'));
  assert.deepEqual(leftovers, []);
});

test('re-running the same window is all-unchanged (upsert absorbs the rescan)', async () => {
  assert.deepEqual(await source.run(makeCtx()), { ingested: 0, updated: 0, unchanged: 5, deleted: 0 });
});

test('editing a summary lands as exactly one update', async () => {
  fx.prepare('UPDATE CalendarItem SET summary = ? WHERE unique_identifier = ?').run(
    'Dentist (rebooked)',
    'uid-single'
  );
  assert.deepEqual(await source.run(makeCtx()), { ingested: 0, updated: 1, unchanged: 4, deleted: 0 });
});

test('a rescheduled occurrence inserts the new entity and reconciliation deletes the old one', async () => {
  const oldStart = E2_STARTS[1];
  const newStart = oldStart + 2 * HOUR;
  fx.prepare(
    'UPDATE OccurrenceCache SET occurrence_date = ?, occurrence_start_date = ?, occurrence_end_date = ? ' +
      'WHERE event_id = 2 AND occurrence_date = ?'
  ).run(appleSecs(newStart), appleSecs(newStart), appleSecs(newStart + 15 * MINUTE), appleSecs(oldStart));

  assert.deepEqual(await source.run(makeCtx()), { ingested: 1, updated: 0, unchanged: 4, deleted: 1 });
  const ids = await steadyEntityIds();
  assert.ok(ids.includes(idFor('uid-standup', newStart)), 'moved occurrence missing');
  assert.equal(ids.includes(idFor('uid-standup', oldStart)), false, 'stale occurrence survived');
});

test('a cancelled event is deleted by reconciliation', async () => {
  fx.exec('DELETE FROM OccurrenceCache WHERE event_id = 3; DELETE FROM CalendarItem WHERE ROWID = 3;');
  assert.deepEqual(await source.run(makeCtx()), { ingested: 0, updated: 0, unchanged: 4, deleted: 1 });
  assert.equal((await steadyEntityIds()).includes(idFor('uid-allday', E3_DAY)), false);
});

test('a partial scan (ingest failure) performs NO deletions', async () => {
  // Calendar.app cancels the dentist appointment...
  fx.exec('DELETE FROM OccurrenceCache WHERE event_id = 1; DELETE FROM CalendarItem WHERE ROWID = 1;');
  // ...but this pass dies mid-delivery, so reconciliation must not run.
  const failingCtx = makeCtx({
    ingestImpl: async () => {
      throw Object.assign(new Error('injected: hermes fell over mid-delivery'), { status: 503 });
    },
  });
  await assert.rejects(source.run(failingCtx), /injected/);
  const ids = await steadyEntityIds();
  assert.equal(ids.length, 4, 'a failed scan deleted entities');
  assert.ok(ids.includes(idFor('uid-single', E1_START)), 'the cancelled-but-unscanned entity was deleted');
});

test('the next successful scan heals what the failed one could not', async () => {
  assert.deepEqual(await source.run(makeCtx()), { ingested: 0, updated: 0, unchanged: 3, deleted: 1 });
  assert.equal((await steadyEntityIds()).includes(idFor('uid-single', E1_START)), false);
});

test('backfill widens the window (−90d..+60d) and picks up the far event', async () => {
  assert.deepEqual(await source.run(makeCtx({ backfill: true })), {
    ingested: 1,
    updated: 0,
    unchanged: 3,
    deleted: 0,
  });
  const { fromTs, toTs } = scanWindow(NOW, true);
  const ids = (await adminEntities({ source: 'calendar', fromTs, toTs }, opts)).map((e) => e.entity_id);
  assert.ok(ids.includes(idFor('uid-far', E4_START)));
});

test('a steady scan never reconciles outside its own window', async () => {
  // The far event is invisible to a steady scan, but its ts sits outside the
  // steady window too — so reconciliation must leave it alone.
  assert.deepEqual(await source.run(makeCtx()), { ingested: 0, updated: 0, unchanged: 3, deleted: 0 });
  const { fromTs, toTs } = scanWindow(NOW, true);
  const ids = (await adminEntities({ source: 'calendar', fromTs, toTs }, opts)).map((e) => e.entity_id);
  assert.ok(ids.includes(idFor('uid-far', E4_START)), 'out-of-window entity was reconciled away');
});

test('a store missing a required table refuses loudly, naming the table', async () => {
  const badPath = join(dir, 'missing-table.sqlitedb');
  const bad = new DatabaseSync(badPath);
  bad.exec('CREATE TABLE Calendar(ROWID INTEGER PRIMARY KEY, title TEXT);');
  bad.exec('CREATE TABLE CalendarItem(ROWID INTEGER PRIMARY KEY, summary TEXT, all_day INTEGER, unique_identifier TEXT);');
  bad.close();
  const drifted = createCalendarSource({ candidates: [badPath] });
  await assert.rejects(drifted.run(makeCtx()), (error) => {
    assert.match(error.message, /"OccurrenceCache"/);
    assert.match(error.message, /schema drift/);
    assert.equal(error.status, 500);
    return true;
  });
});

test('a store missing a required column refuses loudly, naming table.column', async () => {
  const badPath = join(dir, 'missing-column.sqlitedb');
  const bad = new DatabaseSync(badPath);
  bad.exec(FIXTURE_SCHEMA.replace('unique_identifier TEXT,\n', ''));
  bad.close();
  const drifted = createCalendarSource({ candidates: [badPath] });
  await assert.rejects(drifted.run(makeCtx()), (error) => {
    assert.match(error.message, /"CalendarItem\.unique_identifier"/);
    assert.equal(error.status, 500);
    return true;
  });
  // Neither drift case wrote anything.
  assert.equal((await steadyEntityIds()).length, 3);
});

test('rrule is optional: a store without the column still scans (meta simply lacks it)', async () => {
  const path = join(dir, 'no-rrule.sqlitedb');
  const db = new DatabaseSync(path);
  db.exec(FIXTURE_SCHEMA.replace(',\n  rrule TEXT', ''));
  db.prepare('INSERT INTO Calendar(ROWID, title) VALUES (1, ?)').run('Side');
  db.prepare('INSERT INTO CalendarItem(ROWID, summary, all_day, unique_identifier) VALUES (1, ?, 0, ?)').run(
    'Solo',
    'uid-norrule'
  );
  const soloStart = NOW + 4 * DAY;
  insertOccurrence(db, { eventId: 1, calendarId: 1, startMs: soloStart, endMs: soloStart + HOUR });
  db.close();

  const delivered = [];
  const noRrule = createCalendarSource({ candidates: [path] });
  // Same source, different store: the three standup entities sit inside this
  // scan's window and are legitimately absent from this store's truth, so
  // reconciliation removes them — which doubles as proof the diff runs
  // against the full scanned window, not just the delivered batch.
  const counts = await noRrule.run(
    makeCtx({
      ingestImpl: (rows) => {
        delivered.push(...rows);
        return ingest(rows, opts);
      },
    })
  );
  assert.deepEqual(counts, { ingested: 1, updated: 0, unchanged: 0, deleted: 3 });
  assert.equal(delivered.length, 1);
  assert.equal('rrule' in delivered[0].meta, false);
  assert.equal(delivered[0].entity_id, idFor('uid-norrule', soloStart));
});

test('no readable store at any candidate path is a loud .status failure naming the FDA runbook', async () => {
  const absent = createCalendarSource({
    candidates: [join(dir, 'nope-primary.sqlitedb'), join(dir, 'nope-legacy.sqlitedb')],
  });
  await assert.rejects(absent.run(makeCtx()), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /Full Disk Access/);
    assert.match(error.message, /ops\/CONNECTORS\.md/);
    assert.match(error.message, /nope-primary\.sqlitedb/);
    assert.match(error.message, /nope-legacy\.sqlitedb/);
    return true;
  });
});

// Tests for the deterministic energy-audit digest. Every expected number in
// here is hand-computed from the fixture rows (they are the golden values the
// spec requires), and every date boundary is pinned to a fixed instant so the
// suite passes identically in any machine zone: the main fixtures pass an
// explicit zone ('Pacific/Honolulu', fixed UTC-10, no DST) and the DST cases
// pass 'America/New_York' — the injectable-zone design exists exactly so
// these tests need no TZ-env child process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import {
  computeAggregates,
  renderDigestLines,
  localDayKey,
  localDayStart,
} from '../server/vault/digest.mjs';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const HNL = 'Pacific/Honolulu';
const NY = 'America/New_York';

// now = 2026-08-19T10:00 in Honolulu (UTC-10). Yesterday (the spotlight day)
// is 2026-08-18; the 7-day window is 2026-08-12..2026-08-18; the prior week
// is 2026-08-05..2026-08-11.
const NOW = Date.UTC(2026, 7, 19, 20);
const WIN_START = Date.UTC(2026, 7, 12, 10); // 2026-08-12T00:00 HST
const WIN_END = Date.UTC(2026, 7, 19, 10); // 2026-08-19T00:00 HST (start of today)

// Epoch ms of local Honolulu wall time in August 2026.
function hst(day, hour = 0, minute = 0) {
  return Date.UTC(2026, 7, day, hour + 10, minute);
}

const H = 3_600_000;
const LONG_TITLE = 'B'.repeat(70); // first line longer than the 60-char cap

function seedMainFixture(db) {
  insertRows(db, [
    // --- calendar: windowed by meta.start_ms; ts mirrors start_ms ---
    { ts: hst(12, 9), source: 'calendar', text: 'standup', entity_id: 'calendar:c1:',
      meta: { start_ms: hst(12, 9), end_ms: hst(12, 9) + H } }, // 1.0 h on 08-12
    { ts: hst(14, 9), source: 'calendar', text: 'planning', entity_id: 'calendar:c2:',
      meta: { start_ms: hst(14, 9), end_ms: hst(14, 9) + 1.5 * H } }, // 1.5 h on 08-14
    { ts: hst(14, 13), source: 'calendar', text: 'review', entity_id: 'calendar:c3:',
      meta: { start_ms: hst(14, 13), end_ms: hst(14, 13) + 2.5 * H } }, // 2.5 h on 08-14
    { ts: hst(18, 0), source: 'calendar', text: 'offsite day', entity_id: 'calendar:c4:',
      meta: { start_ms: hst(18, 0), end_ms: hst(19, 0), all_day: true } }, // counted, no hours
    { ts: WIN_START, source: 'calendar', text: 'early sync', entity_id: 'calendar:c5:',
      meta: { start_ms: WIN_START, end_ms: WIN_START + 0.5 * H } }, // exact window start: IN
    { ts: WIN_END, source: 'calendar', text: 'today mtg', entity_id: 'calendar:c6:',
      meta: { start_ms: WIN_END, end_ms: WIN_END + H } }, // start of today: OUT
    { ts: WIN_START - 1, source: 'calendar', text: 'late mtg', entity_id: 'calendar:c7:',
      meta: { start_ms: WIN_START - 1, end_ms: WIN_START - 1 + H } }, // 1 ms early: OUT
    { ts: hst(15, 10), source: 'calendar', text: 'broken row', entity_id: 'calendar:c8:',
      meta: {} }, // in-window ts, no start_ms/end_ms: unreadable, reported

    // --- granola: 6 notes yesterday (title cap is 5), 1 mid-window, 1 old ---
    { ts: hst(18, 8, 0), source: 'granola', text: 'Note A\nbody', entity_id: 'granola:gA' },
    { ts: hst(18, 8, 1), source: 'granola', text: `${LONG_TITLE}\nbody`, entity_id: 'granola:gB' },
    { ts: hst(18, 8, 2), source: 'granola', text: 'Note C', entity_id: 'granola:gC' },
    { ts: hst(18, 8, 3), source: 'granola', text: 'Note D', entity_id: 'granola:gD' },
    { ts: hst(18, 8, 4), source: 'granola', text: 'Note E', entity_id: 'granola:gE' },
    { ts: hst(18, 8, 5), source: 'granola', text: 'Note F', entity_id: 'granola:gF' },
    { ts: hst(15, 9), source: 'granola', text: 'Retro', entity_id: 'granola:gRetro' },
    { ts: hst(4, 9), source: 'granola', text: 'Old note', entity_id: 'granola:gOld' },

    // --- sleep: window nights 08-12 (7.0 h), 08-14 (6.5 h), 08-18 (nap day:
    // two periods, 6 h + 0.5 h = 6.5 h); prior week 08-06 (8 h), 08-09 (7 h);
    // 08-04 sits outside both windows and must not count anywhere ---
    { ts: hst(12, 6), source: 'health', text: 'Slept 7 h.', entity_id: 'health:sleep:2026-08-12',
      meta: { day: '2026-08-12', total_sleep_duration: 25_200, average_hrv: 50 } },
    { ts: hst(14, 6), source: 'health', text: 'Slept 6.5 h.', entity_id: 'health:sleep:2026-08-14',
      meta: { day: '2026-08-14', total_sleep_duration: 23_400, average_hrv: 55 } },
    { ts: hst(18, 6), source: 'health', text: 'Slept 6.5 h with a nap.',
      entity_id: 'health:sleep:2026-08-18',
      meta: { day: '2026-08-18', records: [
        { total_sleep_duration: 21_600, average_hrv: 48 },
        { total_sleep_duration: 1_800 },
      ] } },
    { ts: hst(6, 6), source: 'health', text: 'Slept 8 h.', entity_id: 'health:sleep:2026-08-06',
      meta: { day: '2026-08-06', total_sleep_duration: 28_800, average_hrv: 60 } },
    { ts: hst(9, 6), source: 'health', text: 'Slept 7 h.', entity_id: 'health:sleep:2026-08-09',
      meta: { day: '2026-08-09', total_sleep_duration: 25_200, average_hrv: 40 } },
    { ts: hst(4, 6), source: 'health', text: 'Slept 10 h.', entity_id: 'health:sleep:2026-08-04',
      meta: { day: '2026-08-04', total_sleep_duration: 36_000, average_hrv: 99 } },

    // --- steps: 8000 + 12000 + 10000 over three window days -> avg 10000 ---
    { ts: hst(12, 23), source: 'health', text: '8000 steps.', entity_id: 'health:activity:2026-08-12',
      meta: { day: '2026-08-12', steps: 8_000 } },
    { ts: hst(15, 23), source: 'health', text: '12000 steps.', entity_id: 'health:activity:2026-08-15',
      meta: { day: '2026-08-15', steps: 12_000 } },
    { ts: hst(18, 23), source: 'health', text: '10000 steps.', entity_id: 'health:activity:2026-08-18',
      meta: { day: '2026-08-18', steps: 10_000 } },

    // --- imessage: exact ts window edges; 3 in, 2 out; mail: never ingested ---
    { ts: WIN_START, source: 'imessage', text: 'm1', entity_id: 'imessage:m1' },
    { ts: hst(13, 10), source: 'imessage', text: 'm2', entity_id: 'imessage:m2' },
    { ts: WIN_END - 1, source: 'imessage', text: 'm3', entity_id: 'imessage:m3' },
    { ts: WIN_END, source: 'imessage', text: 'm4-today', entity_id: 'imessage:m4' },
    { ts: hst(1, 12), source: 'imessage', text: 'm0-old', entity_id: 'imessage:m0' },
  ]);
}

test('localDayKey and localDayStart in a fixed-offset zone', () => {
  assert.equal(localDayKey(Date.UTC(2026, 7, 19, 9, 59), HNL), '2026-08-18');
  assert.equal(localDayKey(Date.UTC(2026, 7, 19, 10), HNL), '2026-08-19');
  assert.equal(localDayStart('2026-08-19', HNL), Date.UTC(2026, 7, 19, 10));
  assert.equal(localDayStart('2026-08-12', HNL), WIN_START);
});

test('localDayStart across both DST transitions (America/New_York, 2026)', () => {
  // Fall back: Nov 1 2026 is a 25-hour day. Its midnight is still EDT (UTC-4);
  // the next day's midnight is EST (UTC-5).
  assert.equal(localDayStart('2026-11-01', NY), Date.UTC(2026, 10, 1, 4));
  assert.equal(localDayStart('2026-11-02', NY), Date.UTC(2026, 10, 2, 5));
  // Spring forward: Mar 8 2026 is a 23-hour day.
  assert.equal(localDayStart('2026-03-08', NY), Date.UTC(2026, 2, 8, 5));
  assert.equal(localDayStart('2026-03-09', NY), Date.UTC(2026, 2, 9, 4));
});

test('computeAggregates validates its arguments and its database', () => {
  const db = openDb(':memory:');
  assert.throws(() => computeAggregates(db, { zone: HNL }), /\{now\}/);
  assert.throws(() => computeAggregates(db, { now: NOW, days: 0, zone: HNL }), /\{days\}/);
  db.close();
  const bare = new DatabaseSync(':memory:'); // no schema: not a hermes store
  assert.throws(() => computeAggregates(bare, { now: NOW, zone: HNL }), /context/);
  bare.close();
});

test('main fixture: every aggregate matches its hand-computed golden values', () => {
  const db = openDb(':memory:');
  seedMainFixture(db);
  const agg = computeAggregates(db, { now: NOW, days: 7, zone: HNL });

  assert.equal(agg.generatedDay, '2026-08-19');
  assert.deepEqual(agg.window.dayKeys, [
    '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15',
    '2026-08-16', '2026-08-17', '2026-08-18',
  ]);
  assert.equal(agg.window.startMs, WIN_START);
  assert.equal(agg.window.endMs, WIN_END);
  assert.equal(agg.prior.startKey, '2026-08-05');
  assert.equal(agg.prior.endKey, '2026-08-11');

  // calendar: c1,c2,c3,c4(all-day),c5 in; c6,c7 out; c8 unreadable.
  assert.equal(agg.calendar.ok, true);
  assert.equal(agg.calendar.meetings, 5);
  assert.equal(agg.calendar.meetingsPerDay, 5 / 7);
  assert.equal(agg.calendar.totalHours, 5.5); // 1 + 1.5 + 2.5 + 0.5
  assert.equal(agg.calendar.hoursPerDay, 5.5 / 7);
  assert.deepEqual(agg.calendar.busiest, { day: '2026-08-14', hours: 4 });
  assert.equal(agg.calendar.allDayCount, 1);
  assert.equal(agg.calendar.unreadable, 1);

  // granola: 7 notes in window (6 yesterday + Retro); titles capped at 5,
  // first line only, 60-char truncation.
  assert.equal(agg.granola.ok, true);
  assert.equal(agg.granola.meetings, 7);
  assert.equal(agg.granola.yesterdayCount, 6);
  assert.deepEqual(agg.granola.yesterdayTitles, [
    'Note A', 'B'.repeat(60), 'Note C', 'Note D', 'Note E',
  ]);

  // sleep: (25200 + 23400 + 23400) / 3 = 24000 s; prior (28800 + 25200) / 2
  // = 27000 s; the nap day sums its two periods; 08-04 counts nowhere.
  assert.equal(agg.sleep.ok, true);
  assert.equal(agg.sleep.nights, 3);
  assert.equal(agg.sleep.avgSeconds, 24_000);
  assert.equal(agg.sleep.lastNightSeconds, 23_400);
  assert.equal(agg.sleep.priorNights, 2);
  assert.equal(agg.sleep.priorAvgSeconds, 27_000);
  assert.equal(agg.sleep.deltaSeconds, -3_000);
  assert.equal(agg.sleep.unreadable, 0);

  // steps: (8000 + 12000 + 10000) / 3 = 10000; yesterday 10000.
  assert.equal(agg.steps.ok, true);
  assert.equal(agg.steps.daysWithData, 3);
  assert.equal(agg.steps.avgSteps, 10_000);
  assert.equal(agg.steps.yesterdaySteps, 10_000);

  // hrv: window (50 + 55 + 48) / 3 = 51; prior (60 + 40) / 2 = 50; the nap
  // day's hrv comes from the one period that carries it. 51/50 = 1.02 is
  // inside the ±3% band -> stable.
  assert.equal(agg.hrv.ok, true);
  assert.equal(agg.hrv.nights, 3);
  assert.equal(agg.hrv.avg, 51);
  assert.equal(agg.hrv.priorAvg, 50);
  assert.equal(agg.hrv.direction, 'stable');

  // comms: imessage in-window rows are exactly {WIN_START, mid, WIN_END-1};
  // mail has never ingested and must be MISSING, not zero.
  assert.equal(agg.imessage.ok, true);
  assert.equal(agg.imessage.count, 3);
  assert.equal(agg.imessage.perDay, 3 / 7);
  assert.equal(agg.mail.ok, false);
  assert.equal(agg.mail.reason, 'no mail rows have ever been ingested');

  db.close();
});

test('main fixture: renderDigestLines golden output', () => {
  const db = openDb(':memory:');
  seedMainFixture(db);
  const agg = computeAggregates(db, { now: NOW, days: 7, zone: HNL });
  assert.deepEqual(renderDigestLines(agg, { now: NOW }), [
    'Energy audit 2026-08-12..2026-08-18 (7 days), generated 2026-08-19',
    'calendar: 5 meetings (0.7/day), 0.8 h/day in meetings; busiest 2026-08-14 (4.0 h); ' +
      'all-day: 1 (excluded from hours); unreadable rows: 1',
    `granola: 7 notes in window; yesterday: "Note A", "${'B'.repeat(60)}", "Note C", ` +
      '"Note D", "Note E" (+1 more)',
    'sleep: avg 6.7 h/night over 3 nights; last night 6.5 h; -0.8 h vs prior week (avg 7.5 h)',
    'steps: avg 10000/day over 3 days; yesterday 10000',
    'hrv: avg 51 ms over 3 nights, stable vs prior week (avg 50 ms)',
    'imessage: 3 messages in window (0.4/day)',
    'MISSING: mail — no mail rows have ever been ingested',
  ]);
  db.close();
});

test('days=1 narrows the window to yesterday and the prior day', () => {
  const db = openDb(':memory:');
  seedMainFixture(db);
  const agg = computeAggregates(db, { now: NOW, days: 1, zone: HNL });
  assert.deepEqual(agg.window.dayKeys, ['2026-08-18']);
  assert.deepEqual(agg.prior.dayKeys, ['2026-08-17']);
  assert.equal(agg.calendar.meetings, 1); // only the all-day event is on 08-18
  db.close();
});

test('hrv trend direction: higher, lower, and both edges of the ±3% band', () => {
  const cases = [
    { win: 60, expect: 'higher' }, // 60/50 = 1.20
    { win: 40, expect: 'lower' }, // 40/50 = 0.80
    { win: 51.5, expect: 'stable' }, // 51.5/50 = 1.03: on the band edge
    { win: 48.5, expect: 'stable' }, // 48.5/50 = 0.97: on the band edge
  ];
  for (const { win, expect } of cases) {
    const db = openDb(':memory:');
    insertRows(db, [
      { ts: hst(18, 6), source: 'health', text: 'night', entity_id: 'health:sleep:2026-08-18',
        meta: { total_sleep_duration: 25_200, average_hrv: win } },
      { ts: hst(9, 6), source: 'health', text: 'night', entity_id: 'health:sleep:2026-08-09',
        meta: { total_sleep_duration: 25_200, average_hrv: 50 } },
    ]);
    const agg = computeAggregates(db, { now: NOW, days: 7, zone: HNL });
    assert.equal(agg.hrv.direction, expect, `window hrv ${win}`);
    db.close();
  }
});

test('a source that is active but quiet renders a real zero, never MISSING', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    { ts: hst(1, 12), source: 'imessage', text: 'old', entity_id: 'imessage:old' },
  ]);
  const agg = computeAggregates(db, { now: NOW, days: 7, zone: HNL });
  assert.equal(agg.imessage.ok, true);
  assert.equal(agg.imessage.count, 0);
  const lines = renderDigestLines(agg, { now: NOW });
  assert.ok(lines.includes('imessage: 0 messages in window (0.0/day)'));
  assert.ok(!lines.some((l) => l.startsWith('MISSING: imessage')));
  db.close();
});

test('an empty database reports every source as MISSING', () => {
  const db = openDb(':memory:');
  const agg = computeAggregates(db, { now: NOW, days: 7, zone: HNL });
  for (const key of ['calendar', 'granola', 'sleep', 'steps', 'hrv', 'imessage', 'mail']) {
    assert.equal(agg[key].ok, false, key);
  }
  const lines = renderDigestLines(agg, { now: NOW });
  assert.equal(lines.length, 8); // header + 7 MISSING lines
  assert.equal(lines[1], 'MISSING: calendar — no calendar rows have ever been ingested');
  assert.equal(lines[7], 'MISSING: mail — no mail rows have ever been ingested');
  db.close();
});

test('health rows without sleep entities: sleep and hrv MISSING, steps still ok', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    { ts: hst(18, 23), source: 'health', text: '5000 steps.',
      entity_id: 'health:activity:2026-08-18', meta: { steps: 5_000 } },
  ]);
  const agg = computeAggregates(db, { now: NOW, days: 7, zone: HNL });
  assert.equal(agg.sleep.ok, false);
  assert.match(agg.sleep.reason, /health:sleep/);
  assert.equal(agg.hrv.ok, false);
  assert.match(agg.hrv.reason, /health:sleep/);
  assert.equal(agg.steps.ok, true);
  assert.equal(agg.steps.daysWithData, 1);
  assert.equal(agg.steps.yesterdaySteps, 5_000);
  db.close();
});

test('unrecognized meta shapes report {ok:false}, never a guessed number', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    { ts: hst(18, 23), source: 'health', text: 'steps row',
      entity_id: 'health:activity:2026-08-18', meta: { stepCount: 5 } }, // wrong field name
    { ts: hst(18, 6), source: 'health', text: 'sleep row',
      entity_id: 'health:sleep:2026-08-18', meta: { minutes_asleep: 400 } }, // wrong shape
  ]);
  const agg = computeAggregates(db, { now: NOW, days: 7, zone: HNL });
  assert.equal(agg.steps.ok, false);
  assert.match(agg.steps.reason, /meta\.steps/);
  assert.equal(agg.sleep.ok, false);
  assert.match(agg.sleep.reason, /readable duration/);
  assert.equal(agg.hrv.ok, false);
  assert.match(agg.hrv.reason, /average_hrv/);
  db.close();
});

test('DST fall-back window: the 25-hour yesterday keeps its whole evening', () => {
  // now = 2026-11-02T12:00 EST. Yesterday (2026-11-01) is the fall-back day:
  // the window is 7 calendar days but 7*24+1 hours of real time.
  const now = Date.UTC(2026, 10, 2, 17);
  const db = openDb(':memory:');
  insertRows(db, [
    // 2026-11-01T23:30 EST — inside the extra hour's day, before EST midnight.
    { ts: Date.UTC(2026, 10, 2, 4, 30), source: 'calendar', text: 'late', entity_id: 'calendar:n1:',
      meta: { start_ms: Date.UTC(2026, 10, 2, 4, 30), end_ms: Date.UTC(2026, 10, 2, 5, 0) } },
    // 2026-11-02T00:00 EST — the start of today: excluded.
    { ts: Date.UTC(2026, 10, 2, 5), source: 'calendar', text: 'today', entity_id: 'calendar:n2:',
      meta: { start_ms: Date.UTC(2026, 10, 2, 5), end_ms: Date.UTC(2026, 10, 2, 6) } },
    // 01:30 in the repeated hour (second pass, already EST): still 2026-11-01.
    { ts: Date.UTC(2026, 10, 1, 5, 30), source: 'calendar', text: 'repeat', entity_id: 'calendar:n3:',
      meta: { start_ms: Date.UTC(2026, 10, 1, 5, 30), end_ms: Date.UTC(2026, 10, 1, 6, 30) } },
  ]);
  const agg = computeAggregates(db, { now, days: 7, zone: NY });
  assert.deepEqual(agg.window.dayKeys, [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
    '2026-10-30', '2026-10-31', '2026-11-01',
  ]);
  assert.equal(agg.window.startMs, Date.UTC(2026, 9, 26, 4)); // EDT midnight
  assert.equal(agg.window.endMs, Date.UTC(2026, 10, 2, 5)); // EST midnight
  assert.equal(agg.window.endMs - agg.window.startMs, 7 * 24 * H + H); // the extra hour
  assert.equal(agg.calendar.meetings, 2);
  assert.equal(agg.calendar.totalHours, 1.5);
  assert.equal(agg.calendar.busiest.day, '2026-11-01');
  db.close();
});

test('digest-once prints the digest from a read-only handle and writes nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'digest-'));
  chmodSync(tmp, 0o700); // openDb requires the parent directory be exactly 0700
  const dbPath = join(tmp, 'context.db');
  try {
    const db = openDb(dbPath);
    insertRows(db, [
      // An old imessage row: the source is active, so a real zero must render.
      { ts: Date.UTC(2020, 0, 1), source: 'imessage', text: 'old', entity_id: 'imessage:old' },
    ]);
    db.close();
    const before = readFileSync(dbPath);
    const run = spawnSync(process.execPath, [join('scripts', 'digest-once.mjs')], {
      cwd: uiDir,
      env: { ...process.env, HERMES_DB: dbPath },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^Energy audit \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} \(7 days\), generated \d{4}-\d{2}-\d{2}$/);
    assert.ok(lines.includes('imessage: 0 messages in window (0.0/day)'));
    assert.ok(lines.includes('MISSING: mail — no mail rows have ever been ingested'));
    // Never writes: the database bytes are untouched and no sidecar appeared.
    assert.deepEqual(readFileSync(dbPath), before);
    assert.deepEqual(readdirSync(tmp), ['context.db']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('digest-once refuses a missing database with a pointer at hermes setup', () => {
  const run = spawnSync(process.execPath, [join('scripts', 'digest-once.mjs')], {
    cwd: uiDir,
    env: { ...process.env, HERMES_DB: join(tmpdir(), 'digest-no-such-dir', 'context.db') },
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /context database not found/);
  assert.match(run.stderr, /hermes/);
});

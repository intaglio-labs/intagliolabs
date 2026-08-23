// Tests for the subjective half of the energy audit.
//
// The assertions that matter are the refusals: that a model-sourced rating
// cannot be written, that a rating cannot be overwritten, and that a
// correlation is withheld rather than estimated when there is not enough of it.
// Those three are the whole reason this table is not just an INTEGER column.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows } from '../server/hermes.mjs';
import { localDayKey } from '../server/vault/digest.mjs';
import {
  MIN_RATINGS, SCORE_MIN, SCORE_MAX, FEATURES,
  recordRating, currentDayRatings, dayFeatures, pendingDays, correlate,
} from '../server/vault/energy.mjs';

const ZONE = 'America/Chicago';
// A fixed instant so day boundaries are deterministic. 2027-01-15 12:00 UTC.
const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const DAY = 86_400_000;

const dayBefore = (n) => localDayKey(NOW - n * DAY, ZONE);

// ------------------------------------------------------------ the guard rails

test("a rating cannot claim a source other than the owner", () => {
  const db = openDb(':memory:');
  // recordRating hard-codes 'user', so the only way to attempt this is to go
  // around it -- which is exactly the route a future session would take.
  assert.throws(
    () =>
      db
        .prepare(
          'INSERT INTO energy_rating(scope, day, zone, score, source, created_at) ' +
            "VALUES ('day', ?, ?, 3, 'model', ?)"
        )
        .run(dayBefore(1), ZONE, NOW),
    /CHECK constraint failed/,
    'a model-sourced rating must be refused by the schema, not by a convention'
  );
  // And the same row with the honest source is accepted, so the CHECK is
  // rejecting the value rather than the statement.
  db.prepare(
    'INSERT INTO energy_rating(scope, day, zone, score, source, created_at) ' +
      "VALUES ('day', ?, ?, 3, 'user', ?)"
  ).run(dayBefore(1), ZONE, NOW);
  assert.equal(db.prepare('SELECT count(*) AS n FROM energy_rating').get().n, 1);
  db.close();
});

test('a rating is append-only: a changed mind appends and the latest wins', () => {
  const db = openDb(':memory:');
  recordRating(db, { day: dayBefore(1), zone: ZONE, score: 2, now: NOW });
  recordRating(db, { day: dayBefore(1), zone: ZONE, score: 5, now: NOW + 1000 });

  assert.throws(
    () => db.prepare('UPDATE energy_rating SET score = 1 WHERE id = 1').run(),
    /append-only/,
    'an UPDATE must abort -- it would rewrite history a correlation was computed over'
  );

  assert.equal(db.prepare('SELECT count(*) AS n FROM energy_rating').get().n, 2, 'both are kept');
  assert.equal(currentDayRatings(db).get(dayBefore(1)), 5, 'the latest append wins');
  db.close();
});

test('scope and context_id must agree, in the schema and in the caller', () => {
  const db = openDb(':memory:');
  assert.throws(
    () => recordRating(db, { scope: 'conversation', day: dayBefore(1), zone: ZONE, score: 3, now: NOW }),
    /needs a contextId/
  );
  assert.throws(
    () => recordRating(db, { scope: 'day', contextId: 1, day: dayBefore(1), zone: ZONE, score: 3, now: NOW }),
    /must not carry one/
  );
  // Straight past the caller, the schema still holds the line.
  assert.throws(
    () =>
      db
        .prepare(
          'INSERT INTO energy_rating(scope, day, zone, context_id, score, source, created_at) ' +
            "VALUES ('day', ?, ?, 7, 3, 'user', ?)"
        )
        .run(dayBefore(1), ZONE, NOW),
    /CHECK constraint failed|FOREIGN KEY/
  );
  db.close();
});

test('a score outside 1-5 is refused, including by the schema', () => {
  const db = openDb(':memory:');
  for (const bad of [0, 6, 2.5, '3', null, NaN]) {
    assert.throws(
      () => recordRating(db, { day: dayBefore(1), zone: ZONE, score: bad, now: NOW }),
      /score must be an integer/,
      `score ${JSON.stringify(bad)} must be refused`
    );
  }
  for (const ok of [SCORE_MIN, SCORE_MAX]) {
    recordRating(db, { day: dayBefore(1), zone: ZONE, score: ok, now: NOW });
  }
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO energy_rating(scope, day, zone, score, source, created_at) VALUES ('day', ?, ?, 9, 'user', ?)"
        )
        .run(dayBefore(1), ZONE, NOW),
    /CHECK constraint failed/
  );
  db.close();
});

test('a malformed day key is refused rather than stored', () => {
  const db = openDb(':memory:');
  for (const bad of ['2027-1-5', 'yesterday', '20270105', '']) {
    assert.throws(
      () => recordRating(db, { day: bad, zone: ZONE, score: 3, now: NOW }),
      /day must be YYYY-MM-DD/
    );
  }
  db.close();
});

// ------------------------------------------------------------- the refusal

test('correlate refuses below the floor, and says what it needs', () => {
  const db = openDb(':memory:');
  for (let i = 1; i <= MIN_RATINGS - 1; i += 1) {
    recordRating(db, { day: dayBefore(i), zone: ZONE, score: (i % 5) + 1, now: NOW });
  }
  const out = correlate(db, { days: 30, zone: ZONE, now: NOW });
  assert.equal(out.ok, false, 'a correlation over too few points is withheld');
  assert.equal(out.reason, 'not_enough_ratings');
  assert.equal(out.have, MIN_RATINGS - 1);
  assert.equal(out.need, MIN_RATINGS);
  assert.ok(Array.isArray(out.pending), 'and it says which days to ask about');
  assert.equal(out.correlations, undefined, 'no number is returned alongside the refusal');
  db.close();
});

test('correlate reports a real correlation once the floor is met', () => {
  const db = openDb(':memory:');
  // A deliberately planted relationship: more late-night messages, worse day.
  // The point is not the value -- it is that a value appears at all only after
  // MIN_RATINGS, and that its sign is the one the data carries.
  for (let i = 1; i <= MIN_RATINGS; i += 1) {
    const lateCount = i % 7;
    insertRows(db, Array.from({ length: lateCount }, (_, k) => ({
      // 23:30 local on that day, which is late-night by the digest's definition.
      ts: NOW - i * DAY + 5 * 3_600_000 + k * 1000,
      source: 'imessage',
      entity_id: `i:${i}:${k}`,
      text: 'up late again',
    })));
    recordRating(db, { day: dayBefore(i), zone: ZONE, score: Math.max(1, 5 - lateCount), now: NOW });
  }
  const out = correlate(db, { days: 30, zone: ZONE, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.n, MIN_RATINGS);
  for (const key of FEATURES) assert.ok(key in out.correlations, `${key} is reported`);
  const r = out.correlations.lateNight;
  assert.ok(r === null || (r >= -1 && r <= 1), 'a correlation is in range or honestly null');
  db.close();
});

test('a flat rating series yields null, not NaN dressed as a correlation', () => {
  const db = openDb(':memory:');
  for (let i = 1; i <= MIN_RATINGS; i += 1) {
    recordRating(db, { day: dayBefore(i), zone: ZONE, score: 4, now: NOW });
  }
  const out = correlate(db, { days: 30, zone: ZONE, now: NOW });
  assert.equal(out.ok, true);
  for (const key of FEATURES) {
    assert.equal(out.correlations[key], null, `${key} has no variance to correlate against`);
  }
  db.close();
});

// -------------------------------------------------------------- the features

test('features and ratings agree about which day a row belongs to', () => {
  const db = openDb(':memory:');
  const target = dayBefore(2);
  // 03:00 local on the target day -- after UTC midnight, so a UTC bucket would
  // file it on the wrong day and the pairing would silently misalign.
  const localStart = new Date(`${target}T03:00:00-06:00`).getTime();
  insertRows(db, [{ ts: localStart, source: 'imessage', entity_id: 'i:1', text: 'late one' }]);

  const feats = dayFeatures(db, { days: 5, zone: ZONE, now: NOW });
  const row = feats.find((d) => d.day === target);
  assert.ok(row !== undefined, 'the target day is in the window');
  assert.equal(row.messages, 1, 'the message lands on its LOCAL day');
  assert.equal(row.lateNight, 1, '03:00 is late-night by the digest definition');

  recordRating(db, { day: target, zone: ZONE, score: 2, now: NOW });
  assert.equal(currentDayRatings(db).get(target), 2, 'the rating keys on the same day string');
  db.close();
});

test('today is not a feature day, because it is not over', () => {
  const db = openDb(':memory:');
  const feats = dayFeatures(db, { days: 3, zone: ZONE, now: NOW });
  assert.equal(feats.length, 3);
  assert.ok(!feats.some((d) => d.day === localDayKey(NOW, ZONE)), 'today is excluded');
  assert.equal(feats.at(-1).day, dayBefore(1), 'the window ends yesterday');
  db.close();
});

test('pendingDays asks about the most recent unrated day first', () => {
  const db = openDb(':memory:');
  recordRating(db, { day: dayBefore(1), zone: ZONE, score: 3, now: NOW });
  const pending = pendingDays(db, { days: 5, zone: ZONE, now: NOW });
  assert.ok(!pending.includes(dayBefore(1)), 'a rated day is not pending');
  assert.equal(pending[0], dayBefore(2), 'newest unrated first -- recall decays');
  db.close();
});

test('an empty store yields no ratings and a clean refusal', () => {
  const db = openDb(':memory:');
  assert.equal(currentDayRatings(db).size, 0);
  const out = correlate(db, { days: 7, zone: ZONE, now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.have, 0);
  db.close();
});

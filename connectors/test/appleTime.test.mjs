import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLE_EPOCH_MS,
  appleAbsoluteSecondsToEpochMs,
  appleMessageDateToEpochMs,
} from '../lib/appleTime.mjs';

test('the Apple epoch constant is 2001-01-01T00:00:00Z', () => {
  assert.equal(APPLE_EPOCH_MS, Date.UTC(2001, 0, 1));
});

test('nanosecond-era message dates convert exactly', () => {
  // 2026-01-01T00:00:00Z is 1767225600000 Unix ms; in Apple nanoseconds that
  // is (1767225600000 - 978307200000) * 1e6.
  const unixMs = Date.UTC(2026, 0, 1);
  const appleNs = (unixMs - APPLE_EPOCH_MS) * 1e6;
  assert.equal(appleMessageDateToEpochMs(appleNs), unixMs);
  // Sub-millisecond nanosecond residue rounds rather than truncates.
  assert.equal(appleMessageDateToEpochMs(appleNs + 600_000), unixMs + 1);
});

test('seconds-era message dates (pre-10.13 rows in a migrated chat.db) convert exactly', () => {
  const unixMs = Date.UTC(2014, 5, 15, 12, 30, 45); // squarely in the seconds era
  const appleSeconds = (unixMs - APPLE_EPOCH_MS) / 1000;
  assert.equal(appleMessageDateToEpochMs(appleSeconds), unixMs);
});

test('the era sniff puts both real-world magnitudes on the right side of 1e12', () => {
  // A 2026 nanosecond value (~7.9e17) is unmistakably ns; a 2026 seconds
  // value (~7.9e8) is unmistakably seconds. Both eras of the SAME instant
  // must land on the same epoch ms.
  const unixMs = Date.UTC(2026, 7, 19, 9, 0, 0);
  const asNs = (unixMs - APPLE_EPOCH_MS) * 1e6;
  const asSeconds = (unixMs - APPLE_EPOCH_MS) / 1000;
  assert.ok(Math.abs(asNs) >= 1e12);
  assert.ok(Math.abs(asSeconds) < 1e12);
  assert.equal(appleMessageDateToEpochMs(asNs), unixMs);
  assert.equal(appleMessageDateToEpochMs(asSeconds), unixMs);
});

test('Core Data absolute seconds convert, including fractional seconds', () => {
  assert.equal(appleAbsoluteSecondsToEpochMs(0), APPLE_EPOCH_MS);
  // 686840400.5 s after the Apple epoch: fractional Core Data timestamps are
  // normal in the Calendar store.
  assert.equal(appleAbsoluteSecondsToEpochMs(686_840_400.5), APPLE_EPOCH_MS + 686_840_400_500);
});

test('non-finite input is refused loudly in both converters', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '123']) {
    assert.throws(() => appleMessageDateToEpochMs(bad), /finite number/, String(bad));
    assert.throws(() => appleAbsoluteSecondsToEpochMs(bad), /finite number/, String(bad));
  }
});

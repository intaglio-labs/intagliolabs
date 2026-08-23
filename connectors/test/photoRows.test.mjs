import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appleSecondsToMs,
  assetKind,
  assetText,
  assetToRow,
  coordinates,
} from '../lib/photoRows.mjs';
import { scanFloorSeconds } from '../sources/photos.mjs';

const asset = (extra = {}) => ({
  ZUUID: 'ABC-123',
  ZDATECREATED: (Date.parse('2026-08-18T12:00:00Z') - 978307200000) / 1000,
  ZKIND: 0,
  ZKINDSUBTYPE: 0,
  ZTRASHEDSTATE: 0,
  ZFILENAME: 'IMG_0001.HEIC',
  ...extra,
});

// Core Data is SECONDS since 2001; chat.db is NANOSECONDS. Sharing a helper
// between them would put every photo ~31,000 years in the future.
test('photo timestamps decode from Core Data seconds, not nanoseconds', () => {
  const ms = Date.parse('2026-08-18T12:00:00Z');
  assert.equal(appleSecondsToMs((ms - 978307200000) / 1000), ms);
  assert.ok(Number.isNaN(appleSecondsToMs(0)));
  assert.ok(Number.isNaN(appleSecondsToMs(null)));
});

test('screenshots are their own kind, not hidden inside photo', () => {
  assert.equal(assetKind({ ZKIND: 0, ZKINDSUBTYPE: 0 }), 'photo');
  assert.equal(assetKind({ ZKIND: 0, ZKINDSUBTYPE: 1 }), 'screenshot');
  assert.equal(assetKind({ ZKIND: 1 }), 'video');
});

// Photos writes sentinels rather than NULL for "no location". Treating them
// as real coordinates would cluster the owner's life on Null Island.
test('location sentinels are rejected, real coordinates kept', () => {
  assert.deepEqual(coordinates({ ZLATITUDE: 37.77, ZLONGITUDE: -122.41 }), { lat: 37.77, lng: -122.41 });
  assert.equal(coordinates({ ZLATITUDE: -180, ZLONGITUDE: -180 }), null);
  assert.equal(coordinates({ ZLATITUDE: 0, ZLONGITUDE: 0 }), null, 'Null Island is not a place you photographed');
  assert.equal(coordinates({ ZLATITUDE: 999, ZLONGITUDE: 0 }), null);
  assert.equal(coordinates({}), null);
});

test('a row carries what a later search needs', () => {
  const row = assetToRow(asset({ ZLATITUDE: 37.77, ZLONGITUDE: -122.41, ZFAVORITE: 1 }));
  assert.equal(row.source, 'photos');
  assert.equal(row.entity_id, 'photos:ABC-123');
  assert.equal(row.ts, Date.parse('2026-08-18T12:00:00Z'));
  assert.equal(row.meta.lat, 37.77);
  assert.equal(row.meta.favorite, true);
  assert.equal(row.speaker, null, 'a photo has no speaker');
});

// The owner deleted these. A corpus that resurrects them is worse than one
// that misses them.
test('trashed assets are never ingested', () => {
  assert.equal(assetToRow(asset({ ZTRASHEDSTATE: 1 })), null);
});

test('an asset with no uuid or no date is dropped rather than guessed at', () => {
  assert.equal(assetToRow(asset({ ZUUID: '' })), null);
  assert.equal(assetToRow(asset({ ZDATECREATED: 0 })), null);
});

// A blank text field is invisible to every query, which for a photo library
// would mean most of it.
test('a photo with no caption still gets findable text', () => {
  const row = assetToRow(asset());
  assert.ok(row.text.includes('photo'));
  assert.ok(row.text.includes('IMG_0001.HEIC'));
});

test('captions and descriptions are preferred over the fallback', () => {
  assert.equal(assetText({ kind: 'photo', title: 'Golden Gate', description: 'foggy' }), 'Golden Gate — foggy');
  assert.equal(assetText({ kind: 'photo', ocr: 'WHITEBOARD NOTES' }), 'WHITEBOARD NOTES');
});

test('the scan floor is in Core Data seconds and survives a corrupt cursor', () => {
  const resumed = scanFloorSeconds({ storedCursor: '777000000', backfill: false, nowMs: 0, backfillDays: 30 });
  assert.equal(resumed.seconds, 777000000);
  assert.equal(resumed.reason, 'cursor');
  assert.equal(
    scanFloorSeconds({ storedCursor: 'nonsense', backfill: false, nowMs: Date.now(), backfillDays: 30 }).reason,
    'no-cursor'
  );
  assert.equal(
    scanFloorSeconds({ storedCursor: '777000000', backfill: true, nowMs: Date.now(), backfillDays: 30 }).reason,
    'backfill'
  );
});

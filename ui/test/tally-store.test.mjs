// The topic scan kept on disk (people/tallyStore.mjs).
//
// What these pin is not "the cache works" but the two ways a derived store goes
// wrong: serving an answer for a corpus that has moved on, and serving one
// computed by software that no longer exists. Every fixture synthetic; the repo
// is public.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertRows } from '../server/hermes.mjs';
import { topicScan, topicTallies, signalSignature } from '../server/people/topics.mjs';
import {
  openTallyStore,
  readTallies,
  writeTallies,
  scanFingerprint,
} from '../server/people/tallyStore.mjs';

const HANDLE = '+15550100';
const Y = new Date(2025, 5, 1).getTime();
const DAY = 86_400_000;

const msg = (ts, text) => ({
  ts,
  source: 'imessage',
  entity_id: `e:${ts}:${text.length}`,
  text,
  meta: { chat_handle: HANDLE, is_from_me: false },
});

function tmpStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return openTallyStore(join(dir, 'tallies.db'));
}

function corpus() {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    msg(Y, 'want to grab coffee at that restaurant'),
    msg(Y + DAY, 'the term sheet and our seed round closed'),
    msg(Y + 2 * DAY, 'tahoe trip flights booked, hotel next'),
  ]);
  return ctx;
}

const shape = (by) =>
  [...by]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, d]) => `${k}|${JSON.stringify(d.taxonomy)}|${[...d.terms].sort()}|${[...d.pairs].sort()}|${[...d.countedIn].sort()}`)
    .join('\n');

test('a stored scan reads back as the same scan, down to the dedup set', (t) => {
  const ctx = corpus();
  const store = tmpStore(t);
  const print = scanFingerprint(ctx, { bucketBy: 'year', signature: signalSignature() });

  const scanned = topicScan(ctx, { bucketBy: 'year' });
  assert.ok(writeTallies(store, print, scanned));
  const loaded = readTallies(store, print);

  assert.ok(loaded, 'a matching fingerprint returns the store');
  assert.equal(shape(loaded), shape(scanned));
});

// The whole point. Each of these must make the store refuse to answer.
test('the fingerprint moves when the corpus does', (t) => {
  const ctx = corpus();
  const before = scanFingerprint(ctx);
  insertRows(ctx, [msg(Y + 3 * DAY, 'one more message about the lease')]);
  assert.notEqual(scanFingerprint(ctx), before, 'a row arrived');
});

test('the fingerprint moves when the episode index is re-cut', (t) => {
  const ctx = corpus();
  const before = scanFingerprint(ctx);
  // An episode index that was rebuilt: same rows, different cut. Conversation
  // identity is what a tally counts once, so this MUST invalidate -- a merged
  // row would be counted again under the new key.
  const ep = ctx.prepare(
    'INSERT INTO episode(source, thread_key, started_at, ended_at, row_count, owner_row_count, ' +
      'built_by, gap_ms, member_hash, settled_at, built_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  ep.run('imessage', 'chat:imessage:any;-;x', Y, Y + 1, 2, 1, 'gap-rule', 3600000, 'h1', Y + 2, Y + 3);
  ctx.exec('INSERT INTO episode_member(episode_id, context_id, line_no, quotable) VALUES (1, 1, 0, 0)');
  const withIndex = scanFingerprint(ctx);
  assert.notEqual(withIndex, before, 'an index appeared');
  ctx.exec('INSERT INTO episode_member(episode_id, context_id, line_no, quotable) VALUES (1, 2, 1, 0)');
  assert.notEqual(scanFingerprint(ctx), withIndex, 'a row joined an episode');
  ctx.exec('UPDATE episode SET ended_at = 99 WHERE id = 1');
  assert.notEqual(scanFingerprint(ctx), withIndex, 'a boundary moved');
});

// The summaries.db lesson: a store that survives the code that produced it.
test('editing what a topic MEANS invalidates the store', (t) => {
  const ctx = corpus();
  const store = tmpStore(t);
  const print = scanFingerprint(ctx, { signature: signalSignature() });
  assert.ok(writeTallies(store, print, topicScan(ctx, { bucketBy: 'year' })));

  const edited = scanFingerprint(ctx, { signature: 'a-different-set-of-patterns' });
  assert.notEqual(edited, print);
  assert.equal(readTallies(store, edited), null, 'counts alone cannot vouch for meaning');
});

test('a month scan and a year scan are not each other', () => {
  const ctx = corpus();
  assert.notEqual(scanFingerprint(ctx, { bucketBy: 'month' }), scanFingerprint(ctx, { bucketBy: 'year' }));
});

test('a half-written store is refused rather than served short', (t) => {
  const ctx = corpus();
  const store = tmpStore(t);
  const print = scanFingerprint(ctx);
  // Buckets present, fingerprint never committed: what a crash mid-write leaves.
  store.exec("INSERT INTO tally_bucket VALUES ('x|2025', '{}')");
  assert.equal(readTallies(store, print), null);
});

test('no store is a working scan, not a failure', () => {
  const ctx = corpus();
  const { docs } = topicTallies(ctx, new Map([[HANDLE, 'name:sam lee']]), { store: null });
  assert.equal(docs.get('name:sam lee|2025').taxonomy.travel, 1);
});

test('a store the scan can use produces the same tallies as one it cannot', (t) => {
  const ctx = corpus();
  const store = tmpStore(t);
  const idToKey = new Map([[HANDLE, 'name:sam lee']]);
  const cold = topicTallies(ctx, idToKey, { store, scanStamp: 'a' });
  const warm = topicTallies(ctx, idToKey, { store, scanStamp: 'b' }); // memo missed, disk hit
  assert.equal(shape(warm.byIdentifier), shape(cold.byIdentifier));
  assert.deepEqual(warm.docs.get('name:sam lee|2025').taxonomy, cold.docs.get('name:sam lee|2025').taxonomy);
});

// A conversation key is built from a chat guid or a handle. It is only ever
// tested for membership, and this file gets written to disk.
test('the cache holds no thread identifier in the clear', (t) => {
  const ctx = corpus();
  const store = tmpStore(t);
  topicTallies(ctx, new Map(), { store, scanStamp: 'z' });
  const dumped = store
    .prepare('SELECT payload FROM tally_bucket')
    .all()
    .map((r) => r.payload)
    .join('');
  assert.ok(dumped.length > 0, 'something was actually stored');
  assert.ok(!dumped.includes(HANDLE), 'no handle inside a payload');
  assert.ok(!dumped.includes('t:imessage'), 'no approximate conversation key either');
});

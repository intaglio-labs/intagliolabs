// Tests for the distill cache's deletion story.
//
// The property under test: a cached model answer about a row dies when the row
// does. Days 10–12 found the gap these pin — 308 cached answers no deletion
// path touched, in a directory Time Machine was backing up while ~/.hazlie sat
// excluded. The cache is keyed on content hash, so hermes can find a row's
// derivatives without holding anything but the hashes it was already deleting.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows, start } from '../server/hermes.mjs';
import { cacheKey } from '../server/memory/distill.mjs';
import { dropCachedDistillates, putCached, readCached } from '../server/memory/cache.mjs';

const TOKEN = 'e'.repeat(64);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'distill-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Point the module's default root at a temp dir for the duration of a test.
// cacheRoot() reads the env at call time, which exists exactly for this.
function overrideRoot(t, root) {
  const prev = process.env.HAZLIE_DISTILL_CACHE;
  process.env.HAZLIE_DISTILL_CACHE = root;
  t.after(() => {
    if (prev === undefined) delete process.env.HAZLIE_DISTILL_CACHE;
    else process.env.HAZLIE_DISTILL_CACHE = prev;
  });
}

test('a hash is dropped everywhere it appears — every prompt, every model', (t) => {
  const root = tempRoot(t);
  const H1 = '1'.repeat(64);
  const H2 = '2'.repeat(64);
  // The same row distilled under two prompts and two models: an old prompt's
  // answer about a deleted row is exactly as much residue as the current one's.
  putCached(cacheKey({ promptSha: SHA_A, model: 'm1', contentHash: H1 }), 'x', root);
  putCached(cacheKey({ promptSha: SHA_A, model: 'm2', contentHash: H1 }), 'x', root);
  putCached(cacheKey({ promptSha: SHA_B, model: 'm1', contentHash: H1 }), 'x', root);
  putCached(cacheKey({ promptSha: SHA_B, model: 'm1', contentHash: H2 }), 'x', root);

  assert.equal(dropCachedDistillates([H1], root), 3);
  assert.equal(readCached(cacheKey({ promptSha: SHA_B, model: 'm1', contentHash: H2 }), root), 'x');
  assert.equal(dropCachedDistillates([H1], root), 0, 'idempotent — nothing left to drop');
});

test('a hash that could be a path never becomes one', (t) => {
  const root = tempRoot(t);
  // A filename assembled from caller input is a traversal primitive the moment
  // the "hashes come from our own column" assumption slips. Hex-ish or it does
  // not become a path.
  for (const bad of ['../../etc/passwd', 'a/../b', 'x'.repeat(200), '', null, 42]) {
    assert.equal(dropCachedDistillates([bad], root), 0, JSON.stringify(bad));
  }
  assert.equal(dropCachedDistillates(['h'.repeat(64)], join(root, 'missing')), 0, 'missing root is 0, not a throw');
});

test('a failed unlink surfaces instead of reporting a clean delete', (t) => {
  // The catch used to swallow EVERY error under an ENOENT comment. A cache
  // subdirectory that lost its write bit (EACCES) meant the quote-bearing
  // file stayed on disk while the admin route answered success — the exact
  // opposite of "deleted means deleted". Only "already gone" is ignorable;
  // anything else throws so the caller's transaction rolls back.
  const root = tempRoot(t);
  const H = '3'.repeat(64);
  const key = cacheKey({ promptSha: SHA_A, model: 'm1', contentHash: H });
  putCached(key, 'x', root);
  const modelDir = dirname(join(root, key));
  chmodSync(modelDir, 0o500);
  assert.throws(() => dropCachedDistillates([H], root), /EACCES|EPERM/u);
  chmodSync(modelDir, 0o700);
  assert.equal(dropCachedDistillates([H], root), 1, 'and succeeds once the dir is writable again');
});

test('a content-changing upsert drops the old answer; an unchanged redelivery keeps it', (t) => {
  const root = tempRoot(t);
  overrideRoot(t, root);
  const db = openDb(':memory:');
  insertRows(db, { ts: 1, source: 'imessage', entity_id: 'i:1', text: 'i am vegetarian' });
  const oldHash = db.prepare("SELECT content_hash FROM context WHERE entity_id = 'i:1'").get().content_hash;
  const key = cacheKey({ promptSha: SHA_A, model: 'm', contentHash: oldHash });
  putCached(key, '{"claims":[]}');

  // Redelivering the identical row is the hourly case and must not touch it.
  insertRows(db, { ts: 1, source: 'imessage', entity_id: 'i:1', text: 'i am vegetarian' });
  assert.notEqual(readCached(key), null, 'an unchanged redelivery keeps the cache');

  insertRows(db, { ts: 1, source: 'imessage', entity_id: 'i:1', text: 'i eat fish now' });
  assert.equal(readCached(key), null, 'the edit killed the old answer');
  db.close();
});

test('purge and delete-entities unlink the cache through the real routes', async (t) => {
  const root = tempRoot(t);
  overrideRoot(t, root);
  const dir = mkdtempSync(join(tmpdir(), 'hermes-cache-test-'));
  const server = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64),
    bearerToken: TOKEN,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
  try {
    await post('/ingest', [
      { ts: 1, source: 'imessage', entity_id: 'i:1', text: 'i am vegetarian' },
      { ts: 2, source: 'notes', entity_id: 'n:1', text: 'call the dentist' },
    ]);
    // Read the server-computed hashes with a second read-only handle; the
    // journal mode is DELETE, so concurrent readers are fine.
    const reader = new DatabaseSync(join(dir, 'context.db'), { readOnly: true });
    const hashOf = (e) =>
      reader.prepare('SELECT content_hash FROM context WHERE entity_id = ?').get(e).content_hash;
    const keyI = cacheKey({ promptSha: SHA_A, model: 'm', contentHash: hashOf('i:1') });
    const keyN = cacheKey({ promptSha: SHA_A, model: 'm', contentHash: hashOf('n:1') });
    reader.close();
    putCached(keyI, 'x');
    putCached(keyN, 'x');

    const purged = await (await post('/admin/purge', { source: 'imessage' })).json();
    assert.equal(purged.deleted, 1);
    assert.equal(readCached(keyI), null, "the purged source's cached answer is gone");
    assert.equal(readCached(keyN), 'x', "the other source's is not");

    await post('/admin/delete-entities', { source: 'notes', entity_ids: ['n:1'] });
    assert.equal(readCached(keyN), null);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

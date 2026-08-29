import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  openPeopleSearchCache,
  peopleSearchCacheKey,
} from '../server/people/searchCache.mjs';
import { start } from '../server/hermes.mjs';

const TEST_LLAMA_KEY = 'a'.repeat(64);
const TEST_BEARER_TOKEN = 'c'.repeat(64);

test('people search cache keys reveal none of the request they fingerprint', () => {
  const input = { question: 'private person and private trip', evidence: 'private message text' };
  const key = peopleSearchCacheKey('judgment', input);
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(key, /private|person|trip|message/u);
  assert.notEqual(key, peopleSearchCacheKey('planning', input));
});

test('people search cache persists constrained output, expires it, and stays bounded', () => {
  const root = mkdtempSync(join(tmpdir(), 'people-search-cache-'));
  const path = join(root, 'cache.db');
  let clock = 1_000;
  try {
    const cache = openPeopleSearchCache(path, {
      now: () => clock, ttlMs: 100, maxEntries: 2,
    });
    assert.ok(cache);
    const privateInput = { prompt: 'a private question containing a private@example.invalid address' };
    const output = { matches: [{ person_id: 'p1', confidence: 0.8, support: { f1: ['e1'] } }] };
    assert.equal(cache.put('judgment', privateInput, output), true);
    assert.deepEqual(cache.get('judgment', privateInput), output);

    clock += 1;
    cache.put('judgment', { prompt: 'second' }, { matches: [] });
    clock += 1;
    cache.put('judgment', { prompt: 'third' }, { matches: [] });
    cache.close();

    const raw = readFileSync(path).toString('utf8');
    assert.doesNotMatch(raw, /private question|private@example/u, 'request input is never persisted');
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM people_search_cache').get().n, 2);
    db.close();

    const reopened = openPeopleSearchCache(path, { now: () => clock, ttlMs: 100, maxEntries: 2 });
    assert.deepEqual(reopened.get('judgment', { prompt: 'third' }), { matches: [] });
    clock += 101;
    assert.equal(reopened.get('judgment', { prompt: 'third' }), null);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict clear removes derived payload bytes immediately and they stay gone after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'people-search-cache-clear-'));
  const path = join(root, 'cache.db');
  const input = { question: 'synthetic private question' };
  const marker = 'Synthetic Erasure Person';
  try {
    const cache = openPeopleSearchCache(path);
    assert.ok(cache);
    cache.put('answer', input, { text: marker, sources: [], count: 1 });
    assert.ok(readFileSync(path).includes(marker), 'fixture proves the derived name reached disk');

    const staleGeneration = cache.generation();
    assert.equal(cache.clear(), 1);
    assert.equal(cache.get('answer', input), null);
    assert.equal(
      cache.put('answer', input, { text: marker, sources: [], count: 1 }, staleGeneration),
      false,
      'an inference started before deletion cannot repopulate the cache afterward'
    );
    assert.ok(!readFileSync(path).includes(marker), 'the derived name is physically absent');
    cache.close();

    const reopened = openPeopleSearchCache(path);
    assert.ok(reopened);
    assert.equal(reopened.get('answer', input), null, 'restart cannot revive erased data');
    assert.equal(
      reopened.clear(),
      0,
      'strict deletion is idempotent and still compacts an already-empty store'
    );
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every admin deletion route strictly clears the people search cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'people-search-admin-clear-'));
  const dbPath = join(root, 'context.db');
  const cachePath = `${dbPath}.people-search-cache`;
  let server = null;
  try {
    server = await start({
      port: 0,
      dbPath,
      llamaApiKey: TEST_LLAMA_KEY,
      bearerToken: TEST_BEARER_TOKEN,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const attempts = [
      ['/admin/people/clear', {}],
      ['/admin/retain', { source: 'notes', keep_days: 30 }],
      ['/admin/purge', { source: 'notes' }],
      ['/admin/delete-entities', { source: 'notes', entity_ids: ['notes:missing'] }],
    ];

    for (const [index, [route, body]] of attempts.entries()) {
      const marker = `Synthetic Route Erasure Person ${index}`;
      const input = { question: `synthetic route question ${index}` };
      const writer = openPeopleSearchCache(cachePath);
      assert.ok(writer);
      writer.put('answer', input, { text: marker, sources: [], count: 1 });
      writer.close();
      assert.ok(readFileSync(cachePath).includes(marker));

      const response = await fetch(base + route, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, route);
      assert.ok(!readFileSync(cachePath).includes(marker), `${route} left derived bytes behind`);
      const reader = new DatabaseSync(cachePath, { readOnly: true });
      assert.equal(
        Number(reader.prepare('SELECT count(*) AS n FROM people_search_cache').get().n),
        0,
        route
      );
      reader.close();
    }

    await server.close();
    server = await start({
      port: 0,
      dbPath,
      llamaApiKey: TEST_LLAMA_KEY,
      bearerToken: TEST_BEARER_TOKEN,
    });
    const restarted = new DatabaseSync(cachePath, { readOnly: true });
    assert.equal(
      Number(restarted.prepare('SELECT count(*) AS n FROM people_search_cache').get().n),
      0,
      'restart cannot revive a route-erased cache entry'
    );
    restarted.close();
  } finally {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cache that cannot be opened disables itself instead of breaking search', () => {
  const root = mkdtempSync(join(tmpdir(), 'people-search-cache-broken-'));
  try {
    const file = join(root, 'not-a-directory');
    const db = new DatabaseSync(file);
    db.close();
    assert.equal(openPeopleSearchCache(join(file, 'cache.db')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

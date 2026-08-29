// Bounded, derived cache for the local people-search model stages.
//
// Cache keys are SHA-256 digests of the complete input plus the stage and cache
// revision. The input can contain a question or evidence text, but only its
// digest is stored. Cached model payloads are schema-constrained; final answer
// payloads contain the same derived names/counts the authenticated reader would
// return, never source rows or message excerpts. The 0600 store stays beside
// the local corpus and nothing leaves the Mac.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PEOPLE_SEARCH_CACHE_REVISION = 1;
export const PEOPLE_SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PEOPLE_SEARCH_CACHE_MAX_ENTRIES = 512;

export function peopleSearchCacheKey(stage, input) {
  return createHash('sha256')
    .update(`r${PEOPLE_SEARCH_CACHE_REVISION}\0${String(stage)}\0${JSON.stringify(input)}`)
    .digest('hex');
}

export function openPeopleSearchCache(
  path,
  { now = () => Date.now(), ttlMs = PEOPLE_SEARCH_CACHE_TTL_MS, maxEntries = PEOPLE_SEARCH_CACHE_MAX_ENTRIES } = {}
) {
  if (!path) return null;
  let db = null;
  try {
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch {}
    }
    db = new DatabaseSync(path);
    if (path !== ':memory:') { try { chmodSync(path, 0o600); } catch {} }
    db.exec('PRAGMA busy_timeout = 4000');
    // A cached final answer can name people. Zero deleted cells, keep journals
    // beside the protected main file instead of in WAL sidecars, and keep a
    // deletion VACUUM's temporary pages in memory.
    db.exec('PRAGMA secure_delete = ON');
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec(
      'CREATE TABLE IF NOT EXISTS people_search_cache (' +
        'cache_key TEXT PRIMARY KEY, stage TEXT NOT NULL, payload TEXT NOT NULL, ' +
        'created_ms INTEGER NOT NULL, used_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS people_search_cache_expiry ON people_search_cache(expires_ms)');

    const read = db.prepare(
      'SELECT payload, expires_ms FROM people_search_cache WHERE cache_key = ? AND stage = ?'
    );
    const touch = db.prepare('UPDATE people_search_cache SET used_ms = ? WHERE cache_key = ?');
    const write = db.prepare(
      'INSERT INTO people_search_cache(cache_key, stage, payload, created_ms, used_ms, expires_ms) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET ' +
        'stage = excluded.stage, payload = excluded.payload, created_ms = excluded.created_ms, ' +
        'used_ms = excluded.used_ms, expires_ms = excluded.expires_ms'
    );
    const dropExpired = db.prepare('DELETE FROM people_search_cache WHERE expires_ms <= ?');
    const clearAll = db.prepare('DELETE FROM people_search_cache');
    const trim = db.prepare(
      'DELETE FROM people_search_cache WHERE cache_key IN (' +
        'SELECT cache_key FROM people_search_cache ORDER BY used_ms DESC, cache_key LIMIT -1 OFFSET ?)'
    );
    // Process-local fence for async model calls. A request captures this before
    // awaiting inference; clear() advances it before touching disk, so a call
    // that finishes after deletion cannot repopulate the erased store.
    let generation = 0;

    return Object.freeze({
      generation() {
        return generation;
      },
      get(stage, input) {
        try {
          const key = peopleSearchCacheKey(stage, input);
          const at = now();
          const row = read.get(key, stage);
          if (!row || Number(row.expires_ms) <= at) return null;
          const value = JSON.parse(row.payload);
          touch.run(at, key);
          return value;
        } catch {
          return null;
        }
      },
      put(stage, input, value, expectedGeneration = generation) {
        try {
          if (expectedGeneration !== generation) return false;
          if (!value || typeof value !== 'object') return false;
          const at = now();
          const key = peopleSearchCacheKey(stage, input);
          write.run(key, stage, JSON.stringify(value), at, at, at + ttlMs);
          dropExpired.run(at);
          trim.run(Math.max(1, Math.trunc(maxEntries)));
          return true;
        } catch {
          return false;
        }
      },
      // Unlike get/put, deletion is strict. An admin route must not report that
      // somebody was erased while a derived answer naming them remains here.
      // VACUUM rewrites the small bounded file after secure_delete zeroes the
      // freed cells, so payload text is gone from disk as well as from queries.
      clear() {
        generation += 1;
        const result = clearAll.run();
        db.exec('VACUUM');
        return Number(result.changes);
      },
      close() {
        try { db.close(); } catch {}
      },
    });
  } catch {
    // A cache miss costs model time; a damaged cache must never break search.
    try { db?.close(); } catch {}
    return null;
  }
}

// Search can tolerate a cache that failed to open; privacy deletion cannot.
// If no live cache handle exists, remove the inaccessible store and any SQLite
// sidecars instead. Every non-ENOENT failure is deliberately surfaced.
export function clearPeopleSearchCacheStorage(cache, path) {
  let cleared = 0;
  if (cache) cleared = cache.clear();
  if (!path || path === ':memory:') return cleared;

  const candidates = cache
    ? [`${path}-journal`, `${path}-wal`, `${path}-shm`]
    : [path, `${path}-journal`, `${path}-wal`, `${path}-shm`];
  for (const candidate of candidates) {
    try {
      unlinkSync(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return cleared;
}

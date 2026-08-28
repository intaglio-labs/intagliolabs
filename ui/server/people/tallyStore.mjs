// The topic scan, kept on disk between runs.
//
// WHY. The scan reads every message in the corpus and can take seconds, but
// it is a pure function of them (the person key and the name filter both moved
// to the fold, see topics.mjs). A pure function of data that did not change has
// a cached answer, which loads much faster. That is the
// difference between a cold start that says "loading" on every screen and one
// that has the chips before the window paints.
//
// ALL OR NOTHING, ON PURPOSE. This loads a whole scan or none of it; it never
// merges freshly-scanned rows into a stored result. That looks like a missed
// optimisation and is not:
//
//   a topic is counted ONCE PER CONVERSATION, and a conversation's identity is
//   an episode -- which is RE-CUT as messages arrive. A message landing in a
//   60-minute gap merges two episodes into one; a late arrival moves a
//   boundary. Either changes the key an already-counted row was counted under,
//   so a merged row would be counted a second time under the new key and the
//   chip would drift upward every ingest, silently and unrepeatably. Detecting
//   that per row costs more than the scan it saves.
//
// So the fingerprint below covers the episode index as well as the corpus, and
// any movement in either is a full rescan. The case this store is actually for
// is the common one: nothing changed since last time.
//
// NEVER A CONVERSATION KEY IN THE CLEAR. countedIn holds chat guids and handles
// for rows the episode index has not reached. They are only ever tested for
// set membership, so they are stored as truncated digests -- dedup works
// identically on a hash, and the cache file has no thread identifiers in it.
// (The bucket key still carries the identifier, because the fold has to resolve
// it against Contacts. This file sits beside context.db, inside the same
// ~/.hazlie directory and the same trust boundary, and never leaves the box.)

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Bump when the SHAPE or MEANING of a tally changes -- a new field, a different
// weighting, a change to what counts as a conversation. The signal patterns
// themselves are covered automatically by the fingerprint, so this is for
// everything a regex hash cannot see.
export const TALLY_REVISION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tally_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tally_bucket(doc_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
`;

// A short digest. Truncated to 88 bits, which over the ~17,000 conversation
// keys on this corpus is a collision probability around 1 in 10^-14 -- and a
// collision costs one uncounted topic hit, not a wrong answer.
export function digest(s) {
  return createHash('sha1').update(String(s)).digest('base64').slice(0, 15);
}

export function openTallyStore(path) {
  try {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 4000');
    db.exec(SCHEMA);
    return db;
  } catch {
    // A cache that cannot be opened is a cache that is not used. Never fatal.
    return null;
  }
}

// EVERYTHING THE SCAN READS, in one string.
//
// The corpus (count and high-water id, which together catch both arrivals and
// deletions) and the episode index (count, membership, and the newest boundary
// -- so a re-cut that happens to preserve the counts still moves the newest
// ended_at). Deliberately NOT `PRAGMA data_version`: that is a per-connection
// session counter and means nothing across a restart.
export function scanFingerprint(contextDb, { bucketBy = 'year', signature = '' } = {}) {
  const c = contextDb
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM context')
    .get();
  let ep = { n: 0, members: 0, newest: 0 };
  try {
    const e = contextDb
      .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(ended_at), 0) AS newest FROM episode')
      .get();
    const m = contextDb.prepare('SELECT COUNT(*) AS n FROM episode_member').get();
    ep = { n: Number(e.n) || 0, members: Number(m.n) || 0, newest: Number(e.newest) || 0 };
  } catch {
    ep = { n: 0, members: 0, newest: 0 };
  }
  return [
    `r${TALLY_REVISION}`,
    bucketBy,
    signature,
    `c${c.n}:${c.m}`,
    `e${ep.n}:${ep.members}:${ep.newest}`,
  ].join('|');
}

// The stored scan, or null when there isn't one for this exact fingerprint.
export function readTallies(store, fingerprint) {
  if (!store) return null;
  try {
    const got = store.prepare('SELECT v FROM tally_meta WHERE k = ?').get('fingerprint');
    if (!got || got.v !== fingerprint) return null;
    const byIdentifier = new Map();
    for (const row of store.prepare('SELECT doc_key, payload FROM tally_bucket').all()) {
      const p = JSON.parse(row.payload);
      byIdentifier.set(row.doc_key, {
        taxonomy: p.x ?? {},
        terms: new Map(p.t ?? []),
        pairs: new Map(p.p ?? []),
        countedIn: new Set(p.c ?? []),
      });
    }
    // An empty store for a non-empty corpus is a half-written cache, not an
    // answer. Rescanning is cheap next to being quietly wrong.
    return byIdentifier.size > 0 ? byIdentifier : null;
  } catch {
    return null;
  }
}

export function writeTallies(store, fingerprint, byIdentifier) {
  if (!store) return false;
  try {
    const ins = store.prepare('INSERT INTO tally_bucket(doc_key, payload) VALUES (?, ?)');
    store.exec('BEGIN IMMEDIATE');
    try {
      // The fingerprint goes in LAST. If anything below fails, the meta row is
      // absent or stale and readTallies refuses the whole store -- there is no
      // window where a partial write looks complete.
      store.exec('DELETE FROM tally_meta');
      store.exec('DELETE FROM tally_bucket');
      for (const [key, doc] of byIdentifier) {
        ins.run(
          key,
          JSON.stringify({
            x: doc.taxonomy,
            t: [...doc.terms],
            p: [...doc.pairs],
            c: [...doc.countedIn],
          })
        );
      }
      store.prepare('INSERT INTO tally_meta(k, v) VALUES (?, ?)').run('fingerprint', fingerprint);
      store.exec('COMMIT');
      // The write happens once and every run after it only reads, so without
      // this the WAL keeps a full second copy of the cache on disk forever.
      store.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      store.exec('ROLLBACK');
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

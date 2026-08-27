// Persisting episodes, and resolving who each one is WITH.
//
// Kept apart from episodes.mjs so the RULE stays pure and testable and the
// DATABASE work stays in one place. Nothing here decides a boundary; it writes
// down what the rule already decided.
//
// REBUILDABLE. Every row in both tables is derived from `context`. Dropping and
// rebuilding produces the identical state, which is why this can replace rather
// than merge: an episode is an index, not evidence. The evidence is still the
// context row, claim_source still points at a row, and no claim points here.

import { buildEpisodes, threadKeyFor, DEFAULT_GAP_MS } from './episodes.mjs';
import { isRoom } from './threadKind.mjs';

// Sources that have conversations. calendar/photos/files are events and
// artefacts, not exchanges -- they have no thread to cut and no author to quote.
export const EPISODE_SOURCES = Object.freeze(['imessage', 'whatsapp', 'notes']);

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

// Does this episode's THREAD belong to a room?
//
// Reads the episode's own thread_key (`chat:<source>:<guid>`) rather than any
// one member, because group-ness is a property of the conversation and not of
// who happened to speak in one window. Falls back to the first member's row when
// a caller passes an episode that has not been keyed yet.
function episodeIsRoom(episode) {
  const key = typeof episode?.thread_key === 'string' ? episode.thread_key : '';
  const cut = key.indexOf(':', key.indexOf(':') + 1);
  if (key.startsWith('chat:') && cut > 0) {
    const source = key.slice('chat:'.length, cut);
    return isRoom({ source }, { chat_guid: key.slice(cut + 1), chat_handle: key.slice(cut + 1) });
  }
  const first = episode?.members?.[0];
  return first ? isRoom(first.row ?? {}, safeMeta(first.row?.meta) ?? {}) : false;
}

// WHO THIS EPISODE IS WITH, or null.
//
// Only for a thread with exactly ONE counterparty across its whole span. A
// group chat gets null rather than a guess: "the owner and Sam agreed X" drawn
// from a nine-person thread is a claim about the wrong conversation, and the
// key exists to join episodes to a person, not to label them approximately.
//
// The key format matches people/graph.mjs rawKeyForId exactly -- `name:<norm>`
// when the contacts spine knows the handle, `id:<handle>` when it does not --
// so an episode and the people graph agree about who somebody is without this
// module needing to know how that graph is built.
export function counterpartyFor(episode, spine) {
  // A ROOM HAS NO COUNTERPARTY, however few people happened to speak in it.
  //
  // The handle test below is a proxy for "is this a group" -- more than one
  // voice means a room -- and it is a proxy that fails in the common case: 1,680
  // of 5,285 group episodes on the live store have exactly ONE non-owner
  // speaking inside their 60-minute window, so they were stamped with that
  // person's key as though the owner had been talking to them privately. 85
  // `plan` claims were distilled under that premise.
  //
  // Group-ness belongs to the THREAD, not to the window. thread_key already
  // carries the chat guid, so the question is answerable without adding a
  // column: episodes are rebuilt by REPLACE, so this needs no migration and no
  // backfill beyond the rebuild that already runs.
  if (episodeIsRoom(episode)) return null;

  const handles = new Set();
  for (const m of episode.members) {
    if (m.quotable === 1) continue; // the owner is not their own counterparty
    const meta = safeMeta(m.row?.meta);
    const h =
      (typeof meta?.handle === 'string' && meta.handle) ||
      (typeof meta?.sender_handle === 'string' && meta.sender_handle) ||
      (typeof m.row?.speaker === 'string' && m.row.speaker) ||
      null;
    if (h) handles.add(h.trim());
    if (handles.size > 1) return null; // more than one voice: a group
  }
  if (handles.size !== 1) return null;
  const handle = [...handles][0];
  const name = spine?.idToName?.get(handle);
  return name ? `name:${norm(name)}` : `id:${handle}`;
}

function safeMeta(meta) {
  if (meta === null || meta === undefined) return null;
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

// Bring the episode index up to date with context.
//
// WRITES ONLY THE DIFFERENCE. This used to DELETE both tables and reinsert
// every episode -- 36,978 episodes and 360,367 members -- to arrive, almost
// always, at exactly the rows that were already there. Two costs, and the
// second is the one that hurt:
//
//   the write itself, and
//   the LOCK. The corpus runs journal_mode=DELETE, so a writer excludes every
//   reader for the whole transaction, and hermes is single-threaded on top of
//   that. Measured against the live server while the distiller held the corpus:
//   94 SECONDS, during which the app answered nothing. The rebuild in isolation
//   is six.
//
// An episode's identity is its members, and `member_hash` already says so --
// episodeStore has always used it to recognise work across a rebuild, and it is
// unique across all 36,978 on this corpus. So the build runs in memory, off the
// lock, and only genuinely new episodes are inserted and genuinely gone ones
// deleted. A quiet corpus writes nothing at all.
//
// Ids therefore SURVIVE for episodes that did not change, which is a
// correctness property and not only a saving: distill_run joins on member_hash,
// people/topics.mjs counts one topic per conversation using the episode id, and
// both used to be invalidated wholesale by a rebuild that changed nothing.
// WHICH CONVERSATION EACH ROW BELONGS TO, written down.
//
// The rebuild's remaining cost was that it had to read every episodic row --
// 418,698 of them, ~3s and ~384MB -- just to discover which threads had moved,
// because a thread key is computed from `meta` and is not a column anything can
// filter on. This is that missing index: derived, rebuildable, and the only
// thing that makes "just the threads that changed" expressible as a query.
//
// Its own table rather than a column on `context`: the corpus is evidence and
// this is an index over it, the same separation `episode` already keeps. Drop it
// and the next pass rebuilds it.
const THREAD_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_thread(
  context_id INTEGER PRIMARY KEY REFERENCES context(id) ON DELETE CASCADE,
  thread_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_thread_key ON context_thread(thread_key);
CREATE TABLE IF NOT EXISTS context_thread_mark(
  one        INTEGER PRIMARY KEY CHECK (one = 1),
  changed_at INTEGER NOT NULL,
  context_id INTEGER NOT NULL
);
`;

// HOW FAR THE INDEX HAS READ, as a PAIR.
//
// The first cut of this used `id > MAX(context_id)` -- which cannot see an
// UPDATE. insertRows is SELECT-then-write: a row that changes keeps its id, so a
// message whose timestamp, thread metadata or content_hash is rewritten leaves
// every count identical and the watermark unmoved. The episode cut from the old
// version then stands for good. That is not hypothetical on this project: the
// history backfill was 405,952 rows of UPDATE, and map.mjs's own stamp comment
// says so.
//
// store_changed_at is the column for it -- "when HERMES last changed this row"
// -- and `context_changed(store_changed_at, id)` already indexes it. But it is
// NOT unique and not monotonic: a connector pass stamps every row it delivers
// with one value, and the distiller was measured losing 1,410 eligible rows
// (49% of what its watermark had covered) across 18,775 rows sharing 149
// distinct values. So the cursor is the same pair distill_run.through_id
// settled on, compared lexicographically.
function readMark(db) {
  const row = db.prepare('SELECT changed_at, context_id FROM context_thread_mark WHERE one = 1').get();
  return row ? { changedAt: Number(row.changed_at), id: Number(row.context_id) } : null;
}

function writeMark(db, mark) {
  db.prepare(
    'INSERT INTO context_thread_mark(one, changed_at, context_id) VALUES (1, ?, ?) ' +
      'ON CONFLICT(one) DO UPDATE SET changed_at = excluded.changed_at, context_id = excluded.context_id'
  ).run(mark.changedAt, mark.id);
}

/// The highest (store_changed_at, id) among the rows the index covers. NULL
/// store_changed_at reads as 0 -- the schema backfills it, and treating an
/// unstamped row as oldest means it is re-read rather than skipped.
function highestMark(db, holes) {
  const row = db
    .prepare(
      'SELECT COALESCE(store_changed_at, 0) AS changed_at, id FROM context ' +
        `WHERE source IN (${holes}) ORDER BY COALESCE(store_changed_at, 0) DESC, id DESC LIMIT 1`
    )
    .get(...EPISODE_SOURCES);
  return row ? { changedAt: Number(row.changed_at), id: Number(row.id) } : { changedAt: 0, id: 0 };
}

// What the index currently holds, for the passes that did not build all of it.
function indexTotals(db, now) {
  const t = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(settled_at <= ?), 0) AS s, ' +
        'COALESCE(SUM(counterparty_key IS NOT NULL), 0) AS c FROM episode'
    )
    .get(now);
  return {
    episodes: Number(t.n) || 0,
    settled: Number(t.s) || 0,
    withCounterparty: Number(t.c) || 0,
  };
}

function ensureThreadIndex(db) {
  db.exec(THREAD_INDEX_SCHEMA);
}

// The rows the index has not seen yet, keyed and recorded. Returns the thread
// keys they touch -- the set of conversations that need re-cutting.
function indexNewRows(db, holes, mark0) {
  // STRICTLY GREATER, on the PAIR. The tie-group hazard that made
  // distill_run.through_id a pair was a CAPPED pass: a LIMIT stopped it partway
  // through a group of rows sharing one store_changed_at, and the next pass
  // resumed past the rest. This scan has no cap -- it reads every row beyond the
  // mark in one go -- so a whole tie group always arrives together and strict
  // comparison loses nothing. Inclusive comparison instead re-read the boundary
  // row on every pass, which made `touched` never empty and defeated the
  // nothing-new path this exists to reach.
  const fresh = db
    .prepare(
      'SELECT id, source, meta, entity_id, COALESCE(store_changed_at, 0) AS changed_at FROM context ' +
        `WHERE source IN (${holes}) ` +
        '  AND (COALESCE(store_changed_at, 0) > ? ' +
        '       OR (COALESCE(store_changed_at, 0) = ? AND id > ?)) ' +
        'ORDER BY COALESCE(store_changed_at, 0), id'
    )
    .all(...EPISODE_SOURCES, mark0.changedAt, mark0.changedAt, mark0.id);
  const touched = new Set();
  const ins = db.prepare('INSERT OR REPLACE INTO context_thread(context_id, thread_key) VALUES (?, ?)');
  const prev = db.prepare('SELECT thread_key FROM context_thread WHERE context_id = ?');
  let mark = { changedAt: mark0.changedAt, id: mark0.id };
  for (const row of fresh) {
    const key = threadKeyFor(row);
    mark = { changedAt: Number(row.changed_at), id: Number(row.id) };
    if (!key) continue;
    // BOTH SIDES OF A MOVE. An updated row can land in a different conversation
    // than it was in -- its chat metadata is part of what an update rewrites --
    // and the thread it LEFT needs re-cutting just as much as the one it joined.
    // The old key is whatever the index held before this overwrites it, so it
    // has to be read first.
    const before = prev.get(row.id)?.thread_key;
    if (before && before !== key) touched.add(before);
    ins.run(row.id, key);
    touched.add(key);
  }
  return { touched, seen: fresh.length, mark };
}

// Is the index still a faithful picture of the corpus? Rows only ever arrive in
// normal operation, but hermes is also the corpus's sole DELETER -- a purge or a
// retention pass removes rows, and a watermark cannot see that. One count
// settles it, and a mismatch means a full pass rather than a guess.
function threadIndexIsWhole(db, holes) {
  const rows = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM context WHERE source IN (${holes})`).get(...EPISODE_SOURCES).n
  );
  const indexed = Number(db.prepare('SELECT COUNT(*) AS n FROM context_thread').get().n);

  // THE INDEX CANNOT REPORT ITS OWN LOSSES. context_thread cascades from
  // context, so deleting a row deletes its index entry too and the two counts
  // still agree -- while the EPISODE built from that row is still standing, now
  // one member short. episode_member cascades the same way, which is what makes
  // it detectable: an episode records the row_count it was cut with, so the
  // members that survive must still add up to it.
  const members = Number(db.prepare('SELECT COUNT(*) AS n FROM episode_member').get().n);
  const claimed = Number(db.prepare('SELECT COALESCE(SUM(row_count), 0) AS n FROM episode').get().n);

  return { whole: rows === indexed && members === claimed, rows, indexed, members, claimed };
}

export function rebuildEpisodes(
  db,
  { gapMs = DEFAULT_GAP_MS, now = Date.now(), spine = null, full = false } = {}
) {
  const holes = EPISODE_SOURCES.map(() => '?').join(',');

  // JUST THE CONVERSATIONS THAT MOVED, when the index can vouch for itself.
  //
  // A full pass reads every episodic row to find out which threads changed. With
  // context_thread that question is a query, so a quiet corpus reads nothing and
  // an ingest reads only the threads it touched. Everything below is a strict
  // narrowing of the full pass: same builder, same member_hash diff, restricted
  // to a set of threads. When anything is unclear -- no index yet, rows deleted
  // out from under it -- it falls through to the full pass rather than guessing.
  ensureThreadIndex(db);
  const whole = threadIndexIsWhole(db, holes);
  const mark = readMark(db);
  // No mark means an index built before this cursor existed: it cannot say what
  // it has read, so it is rebuilt rather than trusted.
  let indexWhole = whole.whole && whole.indexed > 0 && mark !== null;
  if (!full && whole.indexed > 0 && mark !== null) {
    const { touched, mark: advanced } = indexNewRows(db, holes, mark);
    writeMark(db, advanced);
    const after = threadIndexIsWhole(db, holes);
    if (after.whole) {
      if (touched.size === 0) {
        // The same shape a rebuild answers with. A caller reading `episodes`
        // must get the number of episodes, not a null meaning "I did not look".
        return { ...indexTotals(db, now), rows: after.rows, inserted: 0, deleted: 0, rekeyed: 0,
          scope: 'nothing-new' };
      }
      return rebuildThreads(db, [...touched], { gapMs, now, spine, totalRows: after.rows });
    }
    // The index and the corpus disagree: rows were removed. It is rebuilt below
    // as part of the full pass.
    indexWhole = false;
  }

  // Read and build BEFORE opening the transaction: this is the slow half and
  // none of it needs the write lock.
  const rows = db
    .prepare(
      // NO `text`. Cutting a conversation is arithmetic over timestamps and
      // thread keys -- nothing here reads a message body, and episodeLines
      // fetches text per episode for the distiller when it is actually needed.
      // Carrying it here materialised 418,698 message bodies to look at their
      // clocks: 507MB against 384MB, measured, for a field with zero readers in
      // this path.
      'SELECT id, ts, source, speaker, meta, entity_id, content_hash ' +
        `FROM context WHERE source IN (${holes}) ORDER BY id`
    )
    .all(...EPISODE_SOURCES);

  const episodes = buildEpisodes(rows, { gapMs, now });

  // The full pass has every row keyed already, so this is the cheapest possible
  // moment to write the index that lets the next one be narrow.
  // Plain INSERT: the table was just emptied, so there is nothing to replace and
  // the conflict check is pure cost.
  const insThreadFast = db.prepare(
    'INSERT INTO context_thread(context_id, thread_key) VALUES (?, ?)'
  );

  // What each episode is WITH, computed once. The old code called
  // counterpartyFor twice per episode -- once to store it and once again to
  // count it in the return -- which is 360,367 members walked and their meta
  // JSON parsed, twice.
  const keyFor = new Map();
  for (const ep of episodes) keyFor.set(ep.member_hash, counterpartyFor(ep, spine));

  const stored = new Map();
  for (const r of db.prepare('SELECT id, member_hash, counterparty_key FROM episode').all()) {
    stored.set(r.member_hash, r);
  }

  const insEp = db.prepare(
    'INSERT INTO episode(source, thread_key, started_at, ended_at, row_count, owner_row_count, ' +
      'counterparty_key, built_by, gap_ms, member_hash, settled_at, built_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insMem = db.prepare(
    'INSERT INTO episode_member(episode_id, context_id, line_no, quotable) VALUES (?, ?, ?, ?)'
  );
  const delEp = db.prepare('DELETE FROM episode WHERE id = ?');
  const setKey = db.prepare('UPDATE episode SET counterparty_key = ? WHERE id = ?');

  let inserted = 0;
  let deleted = 0;
  let rekeyed = 0;

  // THE INDEX IS REBUILT ONLY WHEN IT IS ACTUALLY BROKEN, and never inside the
  // episode transaction. Writing all 418,715 rows on every full pass added a
  // second bulk write to the one place that must be short -- measured at 158s
  // against the live server, worse than the whole thing was before it existed.
  if (!indexWhole) {
    db.exec('BEGIN');
    try {
      // The secondary index comes OFF for the bulk load and goes back on after.
      // Maintaining a b-tree per row across 418,715 inserts is most of the cost
      // of building this: 26s with it, a fraction of that without. The table is
      // empty of readers inside this transaction, so there is nothing to serve
      // from it meanwhile.
      db.exec('DROP INDEX IF EXISTS context_thread_key');
      db.exec('DELETE FROM context_thread');
      for (const row of rows) {
        const key = threadKeyFor(row);
        if (key) insThreadFast.run(row.id, key);
      }
      db.exec('CREATE INDEX IF NOT EXISTS context_thread_key ON context_thread(thread_key)');
      // The mark belongs to the same transaction as the rows it describes: an
      // index written without one, or with one that outran it, is worse than no
      // index at all.
      writeMark(db, highestMark(db, holes));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  db.exec('BEGIN');
  try {
    // Gone: an episode whose members were re-cut, or whose rows were removed.
    for (const [hash, row] of stored) {
      if (keyFor.has(hash)) continue;
      delEp.run(row.id); // episode_member cascades
      deleted += 1;
    }
    for (const ep of episodes) {
      const key = keyFor.get(ep.member_hash);
      const already = stored.get(ep.member_hash);
      if (already !== undefined) {
        // UNCHANGED CONTENT CAN STILL HAVE A NEW ANSWER. The counterparty is
        // resolved through the contacts spine, so an episode nobody touched
        // acquires a name the moment Contacts learns one. Cheap to check and
        // almost always a no-op, but skipping it would freeze every existing
        // episode at whatever the address book knew on the day it was cut.
        if ((already.counterparty_key ?? null) !== (key ?? null)) {
          setKey.run(key, already.id);
          rekeyed += 1;
        }
        continue;
      }
      const id = Number(
        insEp.run(
          ep.source,
          ep.thread_key,
          ep.started_at,
          ep.ended_at,
          ep.row_count,
          ep.owner_row_count,
          key,
          ep.built_by,
          ep.gap_ms,
          ep.member_hash,
          ep.settled_at,
          ep.built_at
        ).lastInsertRowid
      );
      for (const m of ep.members) insMem.run(id, m.context_id, m.line_no, m.quotable);
      inserted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // COUNTS ONLY. thread_key holds a chat guid and a chat guid holds a handle;
  // it must never be logged, and neither must a counterparty key.
  return {
    episodes: episodes.length,
    settled: episodes.filter((e) => e.settled).length,
    rows: rows.length,
    withCounterparty: [...keyFor.values()].filter((k) => k !== null).length,
    inserted,
    deleted,
    rekeyed,
    scope: 'full',
  };
}

// Re-cut exactly these threads, leaving every other conversation alone.
//
// The rows come from context_thread, so this reads only the threads named --
// and it reads ALL of their rows, not only the new ones, because a message
// landing in an existing conversation re-cuts it and the builder needs the
// whole thread to do that correctly.
function rebuildThreads(db, threadKeys, { gapMs, now, spine, totalRows }) {
  const holes = threadKeys.map(() => '?').join(',');
  const rows = db
    .prepare(
      'SELECT c.id, c.ts, c.source, c.speaker, c.meta, c.entity_id, c.content_hash ' +
        'FROM context c JOIN context_thread t ON t.context_id = c.id ' +
        `WHERE t.thread_key IN (${holes}) ORDER BY c.id`
    )
    .all(...threadKeys);

  const episodes = buildEpisodes(rows, { gapMs, now });
  const keyFor = new Map();
  for (const ep of episodes) keyFor.set(ep.member_hash, counterpartyFor(ep, spine));

  // Only what is stored FOR THESE THREADS may be deleted here. An episode of a
  // conversation nobody touched is not missing from `episodes` because it went
  // away -- it is missing because it was never rebuilt.
  const stored = new Map();
  for (const r of db
    .prepare(`SELECT id, member_hash, counterparty_key FROM episode WHERE thread_key IN (${holes})`)
    .all(...threadKeys)) {
    stored.set(r.member_hash, r);
  }

  const insEp = db.prepare(
    'INSERT INTO episode(source, thread_key, started_at, ended_at, row_count, owner_row_count, ' +
      'counterparty_key, built_by, gap_ms, member_hash, settled_at, built_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insMem = db.prepare(
    'INSERT INTO episode_member(episode_id, context_id, line_no, quotable) VALUES (?, ?, ?, ?)'
  );
  const delEp = db.prepare('DELETE FROM episode WHERE id = ?');
  const setKey = db.prepare('UPDATE episode SET counterparty_key = ? WHERE id = ?');

  let inserted = 0;
  let deleted = 0;
  let rekeyed = 0;
  db.exec('BEGIN');
  try {
    for (const [hash, row] of stored) {
      if (keyFor.has(hash)) continue;
      delEp.run(row.id);
      deleted += 1;
    }
    for (const ep of episodes) {
      const key = keyFor.get(ep.member_hash);
      const already = stored.get(ep.member_hash);
      if (already !== undefined) {
        if ((already.counterparty_key ?? null) !== (key ?? null)) {
          setKey.run(key, already.id);
          rekeyed += 1;
        }
        continue;
      }
      const id = Number(
        insEp.run(ep.source, ep.thread_key, ep.started_at, ep.ended_at, ep.row_count,
          ep.owner_row_count, key, ep.built_by, ep.gap_ms, ep.member_hash, ep.settled_at,
          ep.built_at).lastInsertRowid
      );
      for (const m of ep.members) insMem.run(id, m.context_id, m.line_no, m.quotable);
      inserted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // COUNTS ONLY, and the episode/settled totals are of the whole index rather
  // than of this slice, so a caller reading them means the same thing either way.
  return {
    ...indexTotals(db, now),
    rows: totalRows,
    inserted,
    deleted,
    rekeyed,
    scope: `threads:${threadKeys.length}`,
  };
}

// The episodes a distiller pass may read: settled, and not yet distilled at
// their current content.
//
// `member_hash` is the join to prior work rather than the episode id, so an
// episode rebuilt with a new id but identical content is still recognised as
// done -- which is what makes the rebuild-and-replace above safe to run on a
// timer.
export function pendingEpisodes(db, { now = Date.now(), limit = 40 } = {}) {
  return db
    .prepare(
      'SELECT e.* FROM episode e ' +
        'WHERE e.settled_at <= ? ' +
        '  AND NOT EXISTS (SELECT 1 FROM distill_run r WHERE r.episode_hash = e.member_hash) ' +
        'ORDER BY e.started_at LIMIT ?'
    )
    .all(now, limit);
}

// The rows of one episode, in line order, with their quotability.
export function episodeLines(db, episodeId) {
  return db
    .prepare(
      'SELECT m.line_no, m.quotable, c.id AS context_id, c.ts, c.source, c.speaker, c.text, c.content_hash ' +
        'FROM episode_member m JOIN context c ON c.id = m.context_id ' +
        'WHERE m.episode_id = ? ORDER BY m.line_no'
    )
    .all(episodeId);
}

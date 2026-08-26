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

import { buildEpisodes, DEFAULT_GAP_MS } from './episodes.mjs';
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

// Rebuild the episode index from context, in one transaction.
//
// REPLACE, not merge. An episode's identity is its members, and a message
// arriving late can move a boundary that a previous build already wrote --
// merging would leave two overlapping episodes claiming the same row, and
// episode_member(context_id, episode_id) is UNIQUE precisely so that cannot
// happen quietly. A full rebuild over 12,782 rows takes well under a second.
export function rebuildEpisodes(db, { gapMs = DEFAULT_GAP_MS, now = Date.now(), spine = null } = {}) {
  const holes = EPISODE_SOURCES.map(() => '?').join(',');
  const rows = db
    .prepare(
      'SELECT id, ts, source, speaker, text, meta, entity_id, content_hash ' +
        `FROM context WHERE source IN (${holes}) ORDER BY id`
    )
    .all(...EPISODE_SOURCES);

  const episodes = buildEpisodes(rows, { gapMs, now });

  const insEp = db.prepare(
    'INSERT INTO episode(source, thread_key, started_at, ended_at, row_count, owner_row_count, ' +
      'counterparty_key, built_by, gap_ms, member_hash, settled_at, built_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insMem = db.prepare(
    'INSERT INTO episode_member(episode_id, context_id, line_no, quotable) VALUES (?, ?, ?, ?)'
  );

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM episode_member');
    db.exec('DELETE FROM episode');
    for (const ep of episodes) {
      const key = counterpartyFor(ep, spine);
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
    withCounterparty: episodes.filter((e) => counterpartyFor(e, spine) !== null).length,
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

// The DISTILLER's source boundary: which corpus rows the claim pipeline is
// allowed to read.
//
// THIS IS AN ALLOWLIST AND IT IS ENFORCED IN CODE, not in a prompt, because a
// prompt sentence is advice and this is a rule. A source not named in INCLUDED
// cannot reach the distiller no matter what a caller passes, what a config
// says, or what a future row's `source` column happens to contain.
//
// SCOPE, CORRECTED 2026-08-22 — this header used to say "which corpus rows a
// model is allowed to read" and called itself "THE security boundary", full
// stop. That was true when it was written and stopped being true when the
// episodic shelf landed. `server/memory/episodic.mjs` is a SECOND read path
// with its own source list and its own caps, and it admits sources this file
// excludes — calendar, granola, health, notes, photos, files, and owner-sent
// imessage — under different reasoning: code picks the rows, code does the
// arithmetic, and everything rides the BEGIN NOTES envelope.
//
// So neither file is "the" boundary; there are two, and they differ on
// purpose. A reader who takes this header at its old word will conclude that a
// source excluded here cannot reach a model at all, which is wrong and is
// exactly the kind of over-stated absolute that makes the next person trust
// the wrong file. If the absolute is ever wanted back, the enforcement has to
// move into one shared module both paths call — the comment cannot do it.
//
// The exclusions are not squeamishness; each one removes a specific failure:
//
//   received imessage / mail  attacker-authored text. Anyone who can send the
//                             owner a message could otherwise write directly
//                             into the model's context. This is the single
//                             largest attack surface v1 removes STRUCTURALLY
//                             rather than by asking the model to be careful.
//   granola                   several speakers plus transcription uncertainty:
//                             a claim would be attributed to the owner on the
//                             strength of ASR that may have mixed two people.
//   photos / files            names, paths and timestamps. There are no claims
//                             in a filename, and 83k face detections carry
//                             inferred demographics that must never become
//                             assertions about people.
//   calendar / health         arithmetic. The digest computes these
//                             deterministically; asking a model to rediscover
//                             them trades a correct number for a plausible one.
//   hazlie_digest             model output must never be evidence for itself.
//                             Without this the system corroborates its own
//                             guesses and the loop closes on nothing.
//   seed                      fixtures are not memory.
//   notion                    one row, no live workspace run, and authorship is
//                             not represented in the schema yet.
//
// Included sources still carry a per-source PREDICATE, because "the owner's
// notes" is not the same set as "rows whose source is notes":
//
//   notes     body_undecoded IS NOT 1 -- 19 rows in the live corpus failed
//             typedstream decoding, and their text is a mangled fragment. A
//             claim drawn from one would quote bytes the owner never wrote.
//   imessage  is_from_me = 1 -- the whole point. A sent message can still
//             QUOTE somebody else, so this reduces the attack surface rather
//             than proving authorship, and the prompt is written knowing that.
//             AND the pinned Intaglio Labs thread is removed by chat_guid; see below.
//
// THE PINNED-THREAD EXCLUSION EXISTS BECAUSE THE LOOP CLOSED ONCE, FOR REAL.
// `hazlie_digest` is in EXCLUDED_SOURCES below and always was, but the energy
// digest never carried that source: the courier SENT it into the owner's
// pinned thread, the iMessage connector READ IT BACK OUT of chat.db, and it
// landed as an ordinary `source='imessage'` row with `is_from_me=1` -- owner-
// authored by every test this selector applies. Run 3 distilled it, two
// separate sends produced duplicate claims, the duplication read as
// corroboration, and six claims about the owner's own sleep and step counts
// were accepted on the strength of Intaglio Labs quoting itself. A source-name
// exclusion cannot catch that, because the delivery channel relabels the row
// on the way back in. Only the thread identity survives the round trip, so
// that is what this filters on.
//
// Scope, deliberately narrow: ONLY the pinned Intaglio Labs thread. The owner's other
// self-threads stay readable, because a note the owner texts themselves is
// real life data and dropping every self-addressed message to close this hole
// would cost more than the hole did.

import { pinnedThreadGuids } from '../../../connectors/lib/pinnedThread.mjs';

export { pinnedThreadGuids };

// source -> { predicate, why }. The predicate is a fragment over `context`,
// interpolated only from THIS object, never from a caller.
const INCLUDED = Object.freeze({
  notes: Object.freeze({
    // json_extract returns NULL when the key is absent, which is the ordinary
    // decoded case; `IS NOT 1` keeps NULL rows in, where `!= 1` would drop
    // every one of them. That difference is the whole selector.
    predicate: "COALESCE(json_extract(meta, '$.body_undecoded'), 0) IS NOT 1",
    why: 'owner-written, decoded body only',
  }),
  imessage: Object.freeze({
    predicate: "json_extract(meta, '$.is_from_me') IS 1",
    why: 'owner-sent only; a sent message may still quote someone else',
    // Bound parameters, never interpolated: a chat guid is attacker-adjacent
    // data (it contains a handle) and this is the one place a value from
    // outside this module reaches the SQL text.
    excludeByChatGuid: true,
  }),
});

export const INCLUDED_SOURCES = Object.freeze(Object.keys(INCLUDED));

// Named rather than merely "everything else", so a new source added to
// KNOWN_SOURCES without a decision here shows up in the test that pins this
// list instead of silently defaulting either way.
export const EXCLUDED_SOURCES = Object.freeze({
  mail: 'inbound: attacker-authored text',
  granola: 'multiple speakers plus transcription uncertainty',
  photos: 'metadata and inferred attributes, not claims',
  files: 'names, paths and timestamps, not claims',
  calendar: 'arithmetic the digest computes deterministically',
  health: 'arithmetic the digest computes deterministically',
  notion: 'no live workspace run; authorship not represented',
  // Connections are relationship METADATA and messages are third-party text —
  // the mail reasoning, twice over. People from LinkedIn reach the model as
  // names, dates and counts through the graph joins, never as claims and
  // never as their message text.
  linkedin: 'export metadata + third-party messages; joins read it, claims never do',
  whatsapp: 'third-party message text; joins read it as handles/counts, claims never do',
  // The bridged social platforms (connectors/sources/matrix.mjs), excluded on
  // exactly WhatsApp's reasoning and inheriting it deliberately: these are
  // other people's DMs, arriving continuously, and the graph wants them as
  // names, handles and counts while the model must never read the words.
  // Deciding this at the same commit that admits the sources is the point of
  // the test that failed when it was not — a new source with no decision is a
  // corpus the model reads by default.
  messenger: 'third-party message text; joins read it as handles/counts, claims never do',
  instagram: 'third-party message text; joins read it as handles/counts, claims never do',
  twitter: 'third-party message text; joins read it as handles/counts, claims never do',
  telegram: 'third-party message text; joins read it as handles/counts, claims never do',
  discord: 'third-party message text; joins read it as handles/counts, claims never do',
  slack: 'third-party message text; joins read it as handles/counts, claims never do',
  // RESERVED, NOT RETIRED — decided 2026-08-20 when the energy digest was
  // killed as a product surface. No row has ever carried this source (0 in the
  // live store, and the digest that closed the loop arrived as `imessage`
  // instead), so the honest options were "delete an unused name" or "keep a
  // decision already made". Kept: the name is the obvious one for any future
  // row holding Intaglio Labs' own output, and keeping the entry means whoever
  // writes that row inherits this exclusion instead of re-deciding it without
  // having read what happened on 2026-08-19. One unused string in three lists
  // is a cheaper failure mode than a name coming back free.
  hazlie_digest: 'model output must never be evidence for itself (reserved; never written)',
  seed: 'fixtures are not memory',
});

export const DEFAULT_FROM_DAYS = 30;
// A normal run's ceiling. Backfill raises it explicitly; there is deliberately
// no mode that means "scan whatever is there".
export const DEFAULT_ROW_CAP = 1500;
const DAY_MS = 86_400_000;

// The one query. Built entirely from INCLUDED, bound for every value.
//
// `excludedGuidCount` only ever contributes `?` placeholders -- the guids
// themselves are bound by selectRows and never reach this string.
export function selectionSql(excludedGuidCount = 0) {
  if (!Number.isInteger(excludedGuidCount) || excludedGuidCount < 0) {
    throw new Error('excludedGuidCount must be a non-negative integer');
  }
  const branches = INCLUDED_SOURCES.map((source) => {
    let predicate = INCLUDED[source].predicate;
    if (INCLUDED[source].excludeByChatGuid && excludedGuidCount > 0) {
      const holes = new Array(excludedGuidCount).fill('?').join(', ');
      // COALESCE, because a row with no chat_guid must stay IN. `NULL NOT IN
      // (...)` is NULL, which SQLite treats as false, and that would silently
      // drop every message the join failed to attach a chat to.
      predicate += ` AND COALESCE(json_extract(meta, '$.chat_guid'), '') NOT IN (${holes})`;
    }
    return `(source = '${source}' AND ${predicate})`;
  }).join(' OR ');
  // KEYSET PAGINATION over (store_changed_at, id), which is the pair this
  // already sorts by. It used to be `store_changed_at > ?` alone, on the stated
  // grounds that hermes assigns store_changed_at "strictly monotonically". IT
  // DOES NOT, and the live store is not close: 18,775 rows across 149 distinct
  // values, because a connector pass stamps every row it delivers with one
  // timestamp. Ties of ~100-200 rows are ordinary.
  //
  // What that cost: a capped pass took `limit` rows out of a tie group, the
  // caller advanced the cursor to that group's shared value, and the next pass
  // asked for a value strictly greater -- stepping over every remaining row in
  // the group, permanently. Measured on the live store before this fix: 37 runs
  // sent 1,480 rows while the watermark walked over 2,890 eligible ones. 1,410
  // rows, 49% of the corpus it had covered, were never read and never would be.
  //
  // The pair is unique (id is the primary key), so `>` on it is exact: no rows
  // skipped, none repeated, and no rewind-and-refetch dance like the one
  // connectors/sources/whatsapp.mjs needs for a cursor it does not control.
  // There the tie is in Apple's own column; here the sort key includes our own
  // primary key, so the ordering is total and the cursor can be exact.
  return (
    'SELECT id, ts, source, speaker, text, meta, entity_id, content_hash, store_changed_at ' +
    'FROM context ' +
    'WHERE (store_changed_at > ? OR (store_changed_at = ? AND id > ?)) ' +
    `AND ts >= ? AND (${branches}) ` +
    'ORDER BY store_changed_at, id LIMIT ?'
  );
}

// Rows the distiller may read, oldest cursor position first.
//
// THE CURSOR IS A PAIR: (sinceChangedAt, sinceId). store_changed_at alone is not
// unique -- see selectionSql -- so a cursor made of it alone either skips the
// rest of a tie group or re-reads it forever. The id breaks every tie exactly.
//
// sinceId defaults to 0, which is below every rowid, so a caller that knows only
// a timestamp gets the WHOLE group at that timestamp re-offered rather than
// silently dropped. That is the safe direction: re-reading a row costs a cache
// hit (cache.mjs keys on prompt+model+content), and re-proposing a claim the
// owner already decided is handled downstream.
export function selectRows(
  db,
  {
    sinceChangedAt = 0,
    sinceId = 0,
    fromDays = DEFAULT_FROM_DAYS,
    limit = DEFAULT_ROW_CAP,
    now = Date.now(),
    // Defaults to the live pinned thread. Pass [] only in a test that is
    // deliberately proving what happens without the exclusion.
    excludeChatGuids = null,
  } = {}
) {
  if (!Number.isFinite(sinceChangedAt) || sinceChangedAt < 0) {
    throw new Error('sinceChangedAt must be a non-negative number');
  }
  if (!Number.isInteger(sinceId) || sinceId < 0) {
    throw new Error('sinceId must be a non-negative integer');
  }
  if (!Number.isFinite(fromDays) || fromDays <= 0) throw new Error('fromDays must be positive');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const guids = excludeChatGuids ?? pinnedThreadGuids();
  if (!Array.isArray(guids) || guids.some((g) => typeof g !== 'string')) {
    throw new Error('excludeChatGuids must be an array of strings');
  }
  const rows = db
    .prepare(selectionSql(guids.length))
    .all(sinceChangedAt, sinceChangedAt, sinceId, now - fromDays * DAY_MS, ...guids, limit);
  // Belt and braces. If this ever fires, the SQL and the allowlist have
  // diverged, and the right outcome is a dead run rather than a quiet one.
  for (const row of rows) {
    if (!INCLUDED_SOURCES.includes(row.source)) {
      throw new Error(`selector returned an excluded source: ${row.source}`);
    }
  }
  return rows;
}

// What a run would read, per source, without reading any text. Used by
// --dry-run and by the review page's provenance line.
export function selectionCounts(db, opts = {}) {
  const counts = Object.fromEntries(INCLUDED_SOURCES.map((s) => [s, 0]));
  for (const row of selectRows(db, opts)) counts[row.source] += 1;
  return counts;
}

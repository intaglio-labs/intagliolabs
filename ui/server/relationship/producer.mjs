// The eligibility + ranking producer (L5 step 10, replacement pass): a
// deterministic pool-and-rank in place of matcher.mjs's local-model
// "infer the owner's focus, then find quiet people who overlap" pipeline.
// No model call anywhere in this file -- eligibility is a SQL gate set and
// ranking is arithmetic, both auditable without reading a single message.
//
// `eligiblePool` takes the raw context-db handle (not the relationship
// service) because every gate here is a fact already materialized by the
// people projection (people, person_active_days, person_activity,
// person_event_links) or derivable from the calendar rows in `context` via
// the same identifier spine the projection already resolved into
// person_identifiers -- no second identity resolution, no stateDb handle
// needed.
//
// GATES, and why each is shaped the way it is:
//
//  - two-way history OR a small meeting together. met_in_person > 0 is the
//    v1 stand-in for "reuse the calendar-adapter join" -- the full join
//    (attendee count <= CAL_GATES.maxAttendees, both present, per-meeting)
//    exists for the FUTURE-MEETING VETO below because that veto has no
//    column to fall back to, but the eligibility signal itself has one
//    (`people.met_in_person`) and the spec names it explicitly as
//    acceptable for v1. It is coarser than the calendar adapter's own gate
//    (it does not exclude large broadcasts from THIS count), a known and
//    documented gap, not an oversight.
//  - quiet >= RECONNECT_GATES.intervalDays on the DIRECT-MESSAGE clock,
//    MAX(person_active_days.day) -- never people.last_seen, which a single
//    calendar invite can refresh without either human saying a word to the
//    other.
//  - nothing scheduled: no future calendar row places them in a room with
//    the owner. Same join person_identifiers already carries (attendee
//    email -> canonical person_key, resolved once at projection time), same
//    attendee-count and declined-response exclusions calendarReconnect.mjs
//    applies, so a dead calendar pipe (no future rows at all) cannot
//    silently veto anyone -- the veto only ever fires off a row that
//    genuinely exists.
//  - authored to you at least once: person_event_links.authored is the
//    per-row signal graph.mjs actually sets to true only when THIS person
//    was the sender/speaker, never merely cc'd or an attendee -- unlike
//    people.last_from_them, which an email's every cc'd recipient shares
//    the instant anyone else on the thread receives mail, and would not
//    exclude a cc-only contact. authored=1 is the strongest such signal the
//    projection persists, so it is the one used here.
//  - not suppressed / muted, checked directly against rm_suppression and
//    rm_mute. This does not fold alias keys through the resolutions store
//    the way controls.mjs's isSuppressed/isMuted do (this function only
//    holds the context db, not a resolutions handle) -- a known narrowing
//    versus the service-backed gate, worth widening if this producer ever
//    needs to sit behind a merged identity.
//  - mode filter: sub_roles (from `people.sub_roles`, a canonical JSON
//    array) must contain the mode for 'investor'/'founder'; 'any' instead
//    excludes romantic/family, because those relationships got the reaction
//    the spec is answering (4 of 31 owner-graded matcher cards were people
//    the projection itself labels romantic).
//
// RANK: depth = sent + received + 3*meetings, then `change` (always 0 here
// -- the field is reserved for a future diff/lookup step and documented as
// such, not invented), then quiet days, all descending.

import { RECONNECT_GATES } from './reconnect.mjs';
import { CAL_GATES } from './calendarReconnect.mjs';

export const PRODUCER_VERSION = 'eligibility-v1';
export const RANK_STRATEGY = 'depth-change-quiet';
const DAY = 86_400_000;

// How long a person stays off the pool after a snapshot offers them, so a
// synchronous refill (the card route, on an empty queue) cannot re-offer the
// same handful of names it just wrote. Separate from rm_suppression/rm_mute
// (owner-driven, indefinite): this is a system-driven cooldown with no
// setting, so it is a plain constant rather than something read from config.
const RECENTLY_OFFERED_DAYS = 7;

function hasColumn(db, table, column) {
  return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
}

function parseSubRoles(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

// The one SQL statement: every set-membership gate (history, authored,
// future-meeting veto, suppression, mute, recently-offered) as a WHERE clause
// or an anti-join, so the only rows that ever reach JS are rows that already
// cleared every gate but the two that need date arithmetic (quiet days) or
// JSON-array membership (mode). Both of those are cheap over an already-small
// result.
//
// `includeOffered` skips the last gate only (recently judged or recently
// snapshotted): the desk's Pool tab wants to see everyone the other gates
// admit, offered or not, via ?includeOffered=1 on /admin/relationship/pool --
// but the ordinary batch-producing path (refresh, and the card route's
// synchronous refill) always applies it, or a refill could hand the owner
// back the same names their last batch just showed them.
function poolSql(db, { includeOffered = false } = {}) {
  const subRolesExpr = hasColumn(db, 'people', 'sub_roles') ? "COALESCE(p.sub_roles, '[]')" : "'[]'";
  return `
    WITH future_meetings AS (
      SELECT DISTINCT pi.person_key
      FROM context c
      JOIN json_each(c.meta, '$.attendees') je
      JOIN person_identifiers pi
        ON pi.identifier = lower(json_extract(je.value, '$.email'))
      WHERE c.source = 'calendar'
        AND c.ts > ?
        AND json_valid(c.meta)
        AND json_array_length(c.meta, '$.attendees') > 0
        AND json_array_length(c.meta, '$.attendees') <= ?
        AND COALESCE(lower(json_extract(je.value, '$.response')), '') != 'declined'
    ),
    authored AS (
      SELECT DISTINCT person_key FROM person_event_links WHERE authored = 1
    ),
    quiet AS (
      SELECT person_key, MAX(day) AS last_active_day FROM person_active_days GROUP BY person_key
    )
    SELECT
      p.person_key AS personKey, p.display_name AS name, p.role AS role,
      ${subRolesExpr} AS subRolesJson,
      p.sent AS sent, p.received AS received, p.met_in_person AS meetings,
      p.last_from_them AS lastFromThem, p.last_from_owner AS lastFromOwner,
      q.last_active_day AS lastActiveDay
    FROM people p
    LEFT JOIN quiet q ON q.person_key = p.person_key
    WHERE ((p.sent > 0 AND p.received > 0) OR p.met_in_person > 0)
      AND p.person_key IN (SELECT person_key FROM authored)
      AND p.person_key NOT IN (SELECT person_key FROM future_meetings)
      AND p.person_key NOT IN (SELECT person_key FROM rm_suppression)
      AND NOT EXISTS (
        SELECT 1 FROM rm_mute m
        WHERE (m.person_key IS NULL OR m.person_key = p.person_key)
          AND (m.kind IS NULL OR m.kind = 'reconnect')
          AND (m.person_key IS NOT NULL OR m.kind IS NOT NULL)
          AND m.until_at > ?
      )
      ${includeOffered ? '' : `
      AND p.person_key NOT IN (
        SELECT person_key FROM rm_card_event WHERE event IN ('accepted', 'dismissed')
      )
      AND p.person_key NOT IN (
        SELECT person_key FROM rm_candidate_snapshot WHERE created_at > ?
      )`}
  `;
}

export function eligiblePool(db, { mode, now = Date.now(), includeOffered = false } = {}) {
  const params = [now, CAL_GATES.maxAttendees, now];
  if (!includeOffered) params.push(now - RECENTLY_OFFERED_DAYS * DAY);
  const rows = db.prepare(poolSql(db, { includeOffered })).all(...params);

  const out = [];
  for (const row of rows) {
    if (row.lastActiveDay === null || row.lastActiveDay === undefined) continue;
    const quietDays = Math.floor((now - Date.parse(`${row.lastActiveDay}T00:00:00Z`)) / DAY);
    if (!Number.isFinite(quietDays) || quietDays < RECONNECT_GATES.intervalDays) continue;

    const subRoles = parseSubRoles(row.subRolesJson);
    if (mode === 'investor' || mode === 'founder') {
      if (!subRoles.includes(mode)) continue;
    } else {
      // mode 'any' (or unrecognized -- treated as 'any' rather than throwing,
      // since this is a read path and an unknown mode should show something
      // rather than nothing): exclude relationships the owner's own
      // projection already labels romantic or family.
      if (row.role === 'romantic' || row.role === 'family') continue;
    }

    const messages = row.sent + row.received;
    const depth = row.sent + row.received + 3 * row.meetings;
    const theyWroteLast = row.lastFromThem !== null &&
      (row.lastFromOwner === null || row.lastFromThem > row.lastFromOwner);

    out.push({
      personKey: row.personKey,
      name: row.name,
      subRoles,
      role: row.role,
      depth,
      change: 0, // reserved for the diff/lookup step; not computed yet
      quietDays,
      meetings: row.meetings,
      messages,
      theyWroteLast,
    });
  }

  out.sort((a, b) => b.depth - a.depth || b.change - a.change || b.quietDays - a.quietDays);
  return out;
}

// The latest context row FROM them, in a direct (non-room) channel -- the
// same "reference, not copied text" discipline matcher.mjs and hermes.mjs's
// snapshot writer use for quotes: this id is resolved against the live row
// at serve time, never copied here.
function latestAuthoredContextId(db, personKey) {
  const row = db.prepare(
    `SELECT c.id AS id FROM person_event_links pel
     JOIN context c ON c.id = pel.context_id
     WHERE pel.person_key = ? AND pel.authored = 1 AND pel.room = 0
     ORDER BY c.ts DESC LIMIT 1`
  ).get(personKey);
  return row ? Number(row.id) : null;
}

function tieSentence(mode, candidate) {
  return `Quiet ${candidate.quietDays} days · ${mode} · you two have ${candidate.messages} messages and ${candidate.meetings} meetings`;
}

// Writes rm_candidate_batch + rm_candidate_snapshot in exactly the shape
// hydrateCards (hermes.mjs) reads: summary is the template tie sentence
// above (no model), evidence carries quote_context_id/role/label/focus/left/
// leftTone (focus/label/left/leftTone all null here -- this producer makes
// no claim about any of them) plus messages/dormancyDays/meetings/topics,
// and the mode/depth/subRoles fields the widget's mode picker and future
// ranking passes will want.
export function produceBatch(db, { mode = 'any', now = Date.now(), limit = 5, includeOffered = false } = {}) {
  const pool = eligiblePool(db, { mode, now, includeOffered });
  const chosen = pool.slice(0, limit);

  const batchId = Number(db.prepare(
    'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, ?)'
  ).run(now, chosen.length, 'open', null).lastInsertRowid);

  const insSnap = db.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const cards = [];
  for (const candidate of chosen) {
    const quoteContextId = latestAuthoredContextId(db, candidate.personKey);
    const summary = tieSentence(mode, candidate);
    const evidence = {
      quote_context_id: quoteContextId,
      role: candidate.role,
      label: null,
      focus: null,
      left: null,
      leftTone: null,
      messages: candidate.messages,
      dormancyDays: candidate.quietDays,
      meetings: candidate.meetings,
      topics: [],
      mode,
      depth: candidate.depth,
      subRoles: candidate.subRoles,
    };
    const snapshotId = Number(insSnap.run(
      batchId, candidate.personKey, 'reconnect', summary, JSON.stringify(evidence),
      PRODUCER_VERSION, RANK_STRATEGY, now
    ).lastInsertRowid);
    cards.push({
      personKey: candidate.personKey, name: candidate.name, kind: 'reconnect',
      sentence: summary, quoteContextId, role: candidate.role, focus: null,
      label: null, left: null, leftTone: null,
      evidence: { messages: candidate.messages, dormancyDays: candidate.quietDays,
        meetings: candidate.meetings, topics: [], mode, depth: candidate.depth,
        subRoles: candidate.subRoles },
      producer_version: PRODUCER_VERSION, rank_strategy: RANK_STRATEGY,
      snapshot_id: snapshotId,
    });
  }

  return { batchId, cards, pool };
}

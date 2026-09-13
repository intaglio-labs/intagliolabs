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
//  - authored to you at least once, DIRECTLY: person_event_links.authored
//    is the per-row signal graph.mjs actually sets to true only when THIS
//    person was the sender/speaker, never merely cc'd or an attendee --
//    unlike people.last_from_them, which an email's every cc'd recipient
//    shares the instant anyone else on the thread receives mail, and would
//    not exclude a cc-only contact. authored=1 is the strongest such signal
//    the projection persists.
//
//    `AND room = 0` alongside it (v2, review finding 5): authored=1 is also
//    set on a GROUP row for its actual speaker, so somebody who has only
//    ever spoken in a group thread the owner is also in cleared this gate.
//    Combined with met_in_person > 0 -- which counts a 200-person invite --
//    that produced a card for a person the owner has never exchanged a word
//    with: no quote (latestAuthoredContextId is room=0-only, so it returned
//    null) and a tie sentence reading "0 messages and 1 meetings". owe.mjs's
//    own gates were already room=0 throughout; this brings the reconnect
//    producer in line with them.
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
import { liveQueuePersonKeys } from './daily.mjs';
import { CAL_GATES } from './calendarReconnect.mjs';
import { isAnonymousContact } from '../people/map.mjs';

// v2 (review finding 5 + 11): the authored gate is direct-message-only
// (room = 0), and a person the OTHER producer is currently holding in its
// live queue is excluded. A producer version is a promise about how a card
// was chosen; when the promise changes, the unjudged queue the old version
// produced is void -- see hermes.mjs's hydrateCards and daily.mjs's
// liveness check, both of which test a snapshot's producer_version against
// this constant.
export const PRODUCER_VERSION = 'eligibility-v2';
export const RANK_STRATEGY = 'depth-change-quiet';
const DAY = 86_400_000;

// How long a person stays off the pool after the owner was actually SHOWN
// their card (rm_card_event 'shown'), so a refill cannot hand back a name the
// owner just looked at and did not judge. Deliberately not "after a snapshot
// wrote them": a batch's five names are a queue, and four of them are never
// served before the next refresh replaces the batch. Cooling those down burned
// the whole investor pool (five people) on refreshes nobody saw -- the gate
// measures what reached the screen, not what the producer wrote. Judged
// people are excluded separately and indefinitely. Separate from rm_suppression/rm_mute
// (owner-driven, indefinite): this is a system-driven cooldown with no
// setting, so it is a plain constant rather than something read from config.
const RECENTLY_OFFERED_DAYS = 7;

// The floor below which a relationship does not make the pool at all, absent
// an in-person meeting. Added (L5 step 4 desk feedback) after the pool's own
// review surface made a 4-message tie visible for the first time -- two
// replies to a mailing-list blast is not a relationship the eligibility
// producer should be offering to reconnect on. `meetings >= 1` is still a
// separate, sufficient path: a single in-person meeting can outweigh a thin
// message count the same way `depth`'s `3*meetings` weighting already treats
// it as worth three messages. Overridable per-request via ?minDepth= on
// /admin/relationship/pool, for the desk to widen or narrow the view without
// a redeploy; the ordinary batch-producing path always uses the default.
export const MIN_DEPTH_MESSAGES = 20;

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
// `includeOffered` skips the last gate only (already judged or recently
// shown): the desk's Pool tab wants to see everyone the other gates
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
      -- room = 0: a group-thread speaker is not somebody who has written TO
      -- the owner. See the gate notes at the top of this file.
      SELECT DISTINCT person_key FROM person_event_links WHERE authored = 1 AND room = 0
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
    WHERE ((p.sent + p.received) >= ? OR p.met_in_person > 0)
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
        -- Kind-scoped on purpose (added alongside owe.mjs): a person judged
        -- under a DIFFERENT producer's kind (e.g. dismissed on an Owe card)
        -- must still reach the reconnect pool -- each producer's own judged
        -- history is its own gate. The shown-cooldown just below stays
        -- kind-agnostic: a card of any kind just shown is a real interruption
        -- either producer should let cool down before offering another.
        SELECT person_key FROM rm_card_event WHERE kind = 'reconnect' AND event IN ('accepted', 'dismissed')
      )
      AND p.person_key NOT IN (
        SELECT person_key FROM rm_card_event WHERE event = 'shown' AND created_at > ?
      )`}
  `;
}

export function eligiblePool(db, { mode, now = Date.now(), includeOffered = false, minDepth = MIN_DEPTH_MESSAGES, includeAnonymous = false } = {}) {
  const params = [now, CAL_GATES.maxAttendees, minDepth, now];
  if (!includeOffered) params.push(now - RECENTLY_OFFERED_DAYS * DAY);
  const rows = db.prepare(poolSql(db, { includeOffered })).all(...params);

  // CROSS-KIND EXCLUSION (review finding 11): a person the Owe producer is
  // currently holding in its live queue is not offered a reconnect card too
  // -- being offered twice for the same silence is the complaint, and
  // dismissing one kind gates only that kind. In JS rather than in poolSql
  // because the same set has to gate owe.mjs's own pool, which is not one
  // statement; the set is small and this loop already filters. Under
  // includeOffered (the desk's pool view) it is dropped like every other
  // already-offered gate.
  const heldByOwe = includeOffered ? new Set() : liveQueuePersonKeys(db, 'owe', { now });

  const out = [];
  for (const row of rows) {
    if (heldByOwe.has(row.personKey)) continue;
    if (row.lastActiveDay === null || row.lastActiveDay === undefined) continue;
    // A bare address (a phone number, an email, a raw `id:` key with no name
    // anywhere in the contacts spine) is not somebody the owner can be asked
    // to reconnect with by name -- map.mjs's own anonymity test, reused
    // rather than re-derived, so the two surfaces never disagree about who
    // counts as a real person. Desk-only escape hatch via ?includeAnonymous=1
    // on /admin/relationship/pool; the ordinary batch-producing path never
    // widens this.
    if (!includeAnonymous && isAnonymousContact({ name: row.name, key: row.personKey })) continue;
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
// at serve time, never copied here. Exported so owe.mjs's open-loop
// candidate can reuse the exact same "their latest authored message" query
// rather than re-deriving it.
export function latestAuthoredContextId(db, personKey) {
  const row = db.prepare(
    `SELECT c.id AS id FROM person_event_links pel
     JOIN context c ON c.id = pel.context_id
     WHERE pel.person_key = ? AND pel.authored = 1 AND pel.room = 0
     ORDER BY c.ts DESC LIMIT 1`
  ).get(personKey);
  return row ? Number(row.id) : null;
}

// THE QUOTE FLOOR (surface review C finding 29). Run 3 shipped a card whose
// entire evidence quote was "Heyo 100%!" -- the newest authored row, with no
// test of whether it said anything. A one-word quote makes the card look
// broken, so this walks back through their last QUOTE_LOOKBACK authored
// direct rows and takes the newest one with substance; when none of them has
// any, it returns null and the page hides the quote row, which is strictly
// better than quoting an emoji. What counts as substance is spelled out at
// isSubstantiveQuote below.
//
// Deliberately NOT folded into latestAuthoredContextId: owe.mjs's open-loop
// candidate asks that function for THE newest authored row precisely so it
// can test whether the last thing they said was a question left hanging. A
// substance filter there would walk past a closing "ok" and reopen a loop
// the "ok" closed.
const QUOTE_LOOKBACK = 12;

// THE FLOOR, AND WHY IT IS NOT 24 CHARACTERS (polish review finding 13). It
// was, and "Can you send the deck?" is 22 characters while "yes, let's do
// tuesday" is 21 -- both rejected before the acknowledgement test they would
// have passed, and both better cards than no quote at all. A character count
// was standing in for the test that actually matters, which is whether the
// message SAYS anything: three words carries a subject and a verb, and twelve
// characters is only there to stop three one-letter tokens from clearing it.
const QUOTE_MIN_WORDS = 3;
const QUOTE_MIN_CHARS = 12;

// A bare acknowledgement is not a quote, and there is NO LENGTH AT WHICH THAT
// STOPS BEING TRUE (polish review 2, finding 6). The rule was briefly capped
// at six distinct acknowledgements on the theory that past some number of
// them somebody must be saying something; "haha ok yes sure thanks cool nice"
// is seven, is nothing but acknowledgement, and cleared the cap straight onto
// a card. Piling up more ways to say yes does not add a thing to say.
//
// The words below are not banned words, and never were. The test requires
// EVERY word to be a listed one, so an acknowledgement beside real content is
// real content at any length -- "i got it done, and it is really very good"
// quotes fine, because "i", "and" and "is" are not acknowledgements. What the
// rule rejects is a message that is nothing else.

const ACK_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'okey', 'okie', 'yes', 'yep', 'yeah', 'yup', 'ya', 'no', 'nope',
  'thanks', 'thank', 'you', 'thx', 'ty', 'tysm', 'cheers', 'lol', 'lmao', 'haha', 'hah',
  'hehe', 'hi', 'hey', 'heyo', 'hello', 'yo', 'sup', 'got', 'it', 'sounds', 'good', 'great',
  'nice', 'cool', 'perfect', 'awesome', 'sure', 'np', 'nvm', 'done', 'same', 'true', 'word',
  'agreed', 'congrats', 'congratulations', 'wow', 'omg', 'bye', 'gotcha', 'right', 'exactly',
  'amazing', 'welcome', 'anytime', 'definitely', 'absolutely', 'totally', 'indeed',
  'so', 'much', 'very', 'really', 'too', 'oh', 'ah', 'aw', 'hmm', 'mm', 'yay', 'ha',
]);

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
const WORD_RE = /[\p{L}\p{N}]+/gu;

export function isSubstantiveQuote(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < QUOTE_MIN_CHARS) return false;

  // A line that is nothing but a link says nothing on a card. Stripping the
  // urls first also stops a long url from carrying an otherwise empty
  // message past the floors via its own letters.
  const withoutUrls = trimmed.replace(URL_RE, ' ');
  const words = withoutUrls.toLowerCase().match(WORD_RE) ?? [];
  // Fewer than three words, or none at all (url-only, emoji-only,
  // punctuation-only): nothing a card can quote. "Heyo 100%!" is two.
  if (words.length < QUOTE_MIN_WORDS) return false;

  return words.some((w) => !ACK_WORDS.has(w));
}

// The newest authored direct row that clears isSubstantiveQuote, looking
// back at most QUOTE_LOOKBACK rows. Same "reference, not copied text"
// discipline as latestAuthoredContextId: the id is what travels, and the
// text is re-read from the live row at serve time.
export function substantiveQuoteContextId(db, personKey, { lookback = QUOTE_LOOKBACK } = {}) {
  const rows = db.prepare(
    `SELECT c.id AS id, c.text AS text FROM person_event_links pel
     JOIN context c ON c.id = pel.context_id
     WHERE pel.person_key = ? AND pel.authored = 1 AND pel.room = 0
     ORDER BY c.ts DESC LIMIT ?`
  ).all(personKey, lookback);
  for (const row of rows) {
    if (isSubstantiveQuote(row.text)) return Number(row.id);
  }
  return null;
}

// THE TIE SENTENCE (surface review B findings 5 and 6). It used to print the
// owner's MODE between the two facts -- "Quiet 634 days · investor · ..." --
// which is the owner's own filter, not a fact about this person, and which
// contradicted the card's role row two lines below when the two disagreed.
// It also printed "0 meetings" and "1 meetings". Counts are pluralised and a
// zero count is left out of the sentence rather than announced: there is
// nothing to say about a meeting that never happened.
function countClause(n, singular) {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

function tieSentence(candidate) {
  const parts = [];
  if (candidate.messages > 0) parts.push(countClause(candidate.messages, 'message'));
  if (candidate.meetings > 0) parts.push(countClause(candidate.meetings, 'meeting'));
  const quiet = `Quiet ${countClause(candidate.quietDays, 'day')}`;
  // Both counts zero is reachable (the pool admits a meetings-only person,
  // and met_in_person can disagree with the calendar join): say the one true
  // thing rather than "you two have 0 messages".
  return parts.length === 0 ? quiet : `${quiet} · you two have ${parts.join(' and ')}`;
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
    const quoteContextId = substantiveQuoteContextId(db, candidate.personKey);
    const summary = tieSentence(candidate);
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

// The Owe producer (control arm alongside producer.mjs's eligibility
// reconnect producer): deterministic pool-and-rank, no model call anywhere in
// this file. Where the reconnect producer's reason to reach out is "you two
// have gone quiet", Owe's reason is narrower and more legible -- something is
// OUTSTANDING between the owner and this person, in one of two shapes:
//
//   owe:open-loop          they asked the owner something and the owner
//                          never wrote back.
//   owe:expired-commitment the owner said they would do something (a
//                          commitment claim, or an unanswered page "ask")
//                          and the date it was due has passed.
//
// Both kinds are counted facts plus references, same discipline as
// producer.mjs: a quote lands as quote_context_id and is resolved against the
// live row at serve time (see hermes.mjs's card route), never copied here.
//
// This producer's snapshot.kind is the single literal 'owe' -- the axis
// rm_mute and the judged/shown gates scope on -- with the finer distinction
// (open-loop vs expired-commitment) living ONLY in evidence.owe_kind. See
// daily.mjs for the alternation between this producer and producer.mjs's.

import { latestAuthoredContextId } from './producer.mjs';
import { isAnonymousContact } from '../people/map.mjs';

export const OWE_PRODUCER_VERSION = 'owe-v1';
export const OWE_RANK_STRATEGY = 'owe-overdue-days';
export const OWE_KINDS = Object.freeze(['owe:expired-commitment', 'owe:open-loop']);

export const OPEN_LOOP_MIN_DAYS = 3;
export const OPEN_LOOP_MAX_DAYS = 60;
export const PAGE_ASK_MIN_DAYS = 14;
export const COMMITMENT_MAX_STALE_DAYS = 180;
export const NOT_THIS_KIND_MUTE_DAYS = 90;

const DAY = 86_400_000;

// How long the person stays off the Owe pool after a 'shown' card of ANY
// kind (kind-agnostic, unlike the judged gate below) -- the same cooldown
// producer.mjs's poolSql applies, kept as its own constant here rather than
// imported so the two producers' gates can diverge on purpose without one
// file's tuning silently moving the other's.
const SHOWN_COOLDOWN_DAYS = 7;

// A message counts as an unanswered "ask" only if it reads like a question:
// ends in '?', long enough to be a real sentence and short enough that this
// isn't matching a whole forwarded thread. THEM is a render label; the DB
// equivalent this function is applied against is
// person_event_links.authored=1 AND room=0.
export function isAskText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  return t.endsWith('?') && t.length >= 8 && t.length <= 400;
}

function kindPriority(oweKind) {
  return oweKind === 'owe:expired-commitment' ? 0 : 1;
}

// A: owe:open-loop. The LAST thing on the direct-message clock (room=0) was
// them asking something, the owner never answered, and that silence is
// neither too fresh (give the owner a normal reply window) nor so old the
// thread has gone cold (a year-old unanswered text is not a live open loop).
// Deliberately NOT people.last_from_them/last_from_owner (cc contamination,
// per producer.mjs's own comment on that pair) and deliberately not
// service.openLoopFor/profile.mjs's openLoop -- this is its own, narrower
// direct-message-only definition.
const OPEN_LOOP_SQL = `
  WITH last_them AS (
    SELECT pel.person_key AS person_key, MAX(c.ts) AS ts
    FROM person_event_links pel
    JOIN context c ON c.id = pel.context_id
    WHERE pel.authored = 1 AND pel.room = 0
    GROUP BY pel.person_key
  ),
  last_owner AS (
    SELECT pel.person_key AS person_key, MAX(c.ts) AS ts
    FROM person_event_links pel
    JOIN context c ON c.id = pel.context_id
    WHERE pel.owner_authored = 1 AND pel.room = 0
    GROUP BY pel.person_key
  )
  SELECT p.person_key AS personKey, lt.ts AS askedAt
  FROM people p
  JOIN last_them lt ON lt.person_key = p.person_key
  LEFT JOIN last_owner lo ON lo.person_key = p.person_key
  WHERE (lo.ts IS NULL OR lo.ts < lt.ts)
    AND lt.ts <= ?
    AND lt.ts >= ?
`;

// B1: the owner's own expired commitment claim (subject='owner', kind
// 'commitment'), keyed to whichever person the claim's source context
// involves through a direct (room=0) link -- a commitment made IN a room
// (a group thread) has no single counterparty to owe it to, so it produces
// no candidate.
const B1_SQL = `
  SELECT cl.id AS claimId, cl.valid_to AS validTo, cl.observed_at AS observedAt,
         pel.person_key AS personKey
  FROM v_claim_accepted cl
  JOIN claim_source cs ON cs.claim_id = cl.id
  JOIN person_event_links pel ON pel.context_id = cs.context_id AND pel.room = 0
  WHERE cl.kind = 'commitment' AND cl.subject = 'owner'
    AND cl.valid_to IS NOT NULL AND cl.valid_to < ? AND cl.valid_to > ?
`;

// B2: a page "ask" item (person_page_item.section='ask') the owner has not
// answered -- the ask's own context is at least PAGE_ASK_MIN_DAYS old but not
// older than COMMITMENT_MAX_STALE_DAYS (the same staleness bound B1 applies
// to an expired owner commitment now applies here too: a page ask that old
// is the reconnect producer's "gone quiet" case, not an owed answer), its
// claim's latest decision (if any) is not a reject, and there is no
// owner-authored direct-message row for this person after the ask.
const B2_SQL = `
  SELECT cl.id AS claimId, cl.subject_person_key AS personKey, c.id AS contextId, c.ts AS askedAt
  FROM claim cl
  JOIN person_page_item ppi ON ppi.claim_id = cl.id AND ppi.section = 'ask'
  JOIN claim_source cs ON cs.claim_id = cl.id
  JOIN context c ON c.id = cs.context_id
  WHERE cl.subject = 'person'
    AND c.ts <= ?
    AND c.ts > ?
    AND (
      SELECT d.action FROM claim_decision d WHERE d.claim_id = cl.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1
    ) IS NOT 'reject'
    AND NOT EXISTS (
      SELECT 1 FROM person_event_links pel2
      JOIN context c2 ON c2.id = pel2.context_id
      WHERE pel2.person_key = cl.subject_person_key AND pel2.owner_authored = 1 AND pel2.room = 0 AND c2.ts > c.ts
    )
`;

// Has the OWNER actually written to this person more than once? Applied to
// both open-loop and expired-commitment candidates (see the "deliberate
// divergences" comment on owePool below for why this is not the same as a
// depth floor): a thin real exchange -- two owner messages and an unanswered
// question -- is still owed. What this excludes is the case with NO
// exchange at all in that direction: a LinkedIn-derived contact the owner
// has never written to, or written to exactly once, is not someone the
// owner "owes" anything to in the ordinary sense of the word, no matter how
// many messages arrived in the other direction (an automated ticketing
// service can send hundreds).
export const OWE_MIN_OWNER_MESSAGES = 2;

const OWNER_MESSAGE_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM person_event_links
  WHERE person_key = ? AND owner_authored = 1 AND room = 0
`;

// Exclusions shared by every owe candidate, evaluated once per pool build:
// permanent suppression, a mute scoped to this person and/or the 'owe' kind
// (a mute of a DIFFERENT kind, e.g. 'reconnect', does not touch this pool),
// and -- unless includeOffered widens the view, same escape hatch
// producer.mjs's own pool inspection route offers -- already judged under
// kind='owe' (indefinite) or shown any card at all within the last
// SHOWN_COOLDOWN_DAYS (kind-agnostic on purpose: a person who was just shown
// a reconnect card should not immediately also be shown an Owe card).
function buildExclusionChecker(db, { now, includeOffered }) {
  const suppressed = new Set(
    db.prepare('SELECT person_key FROM rm_suppression').all().map((r) => r.person_key)
  );
  const mutes = db.prepare('SELECT person_key, kind FROM rm_mute WHERE until_at > ?').all(now);
  const globalOweMute = mutes.some((m) => m.person_key === null && (m.kind === null || m.kind === 'owe'));
  const mutedPersons = new Set(
    mutes.filter((m) => m.person_key !== null && (m.kind === null || m.kind === 'owe')).map((m) => m.person_key)
  );
  let judged = new Set();
  let shownRecently = new Set();
  if (!includeOffered) {
    judged = new Set(
      db.prepare(
        "SELECT DISTINCT person_key FROM rm_card_event WHERE kind = 'owe' AND event IN ('accepted','dismissed')"
      ).all().map((r) => r.person_key)
    );
    shownRecently = new Set(
      db.prepare("SELECT DISTINCT person_key FROM rm_card_event WHERE event = 'shown' AND created_at > ?")
        .all(now - SHOWN_COOLDOWN_DAYS * DAY).map((r) => r.person_key)
    );
  }
  return (personKey) =>
    suppressed.has(personKey) || globalOweMute || mutedPersons.has(personKey) ||
    judged.has(personKey) || shownRecently.has(personKey);
}

// The pool: A (open-loop) and B (expired-commitment, B1+B2 unioned with one
// candidate per person -- the larger overdueDays wins) merged and ranked.
// Deliberate divergences from producer.mjs's eligiblePool, not oversights: no
// MIN_DEPTH floor (an outstanding ask or commitment matters regardless of how
// thin the relationship otherwise is), no future-meeting veto (an upcoming
// meeting is not a reason to stop owing an answer), and romantic/family are
// still excluded so the two producers stay comparable. In place of the depth
// floor there is a narrower, direction-specific one: OWE_MIN_OWNER_MESSAGES
// requires a two-way relationship the OWNER has actually participated in
// (at least two owner-authored, room=0 rows to this person), not a message
// count in either direction. That is deliberately a much lower bar than a
// depth floor -- "you have written to this person before, more than once" --
// so a thin real exchange with an unanswered question still clears it; what
// it excludes is a bulk sender the owner never wrote to (236 received
// messages, 1 sent, an old automated page ask) and a LinkedIn-derived contact
// the owner has at most written to once.
export function owePool(db, { now = Date.now(), includeOffered = false, includeAnonymous = false } = {}) {
  const excluded = buildExclusionChecker(db, { now, includeOffered });
  const peopleStmt = db.prepare(
    'SELECT display_name AS name, role AS role, sent AS sent, received AS received, met_in_person AS meetings FROM people WHERE person_key = ?'
  );
  const contextTextStmt = db.prepare('SELECT text FROM context WHERE id = ?');
  const ownerMessageCountStmt = db.prepare(OWNER_MESSAGE_COUNT_SQL);

  const out = [];

  function personRow(personKey) {
    return peopleStmt.get(personKey);
  }

  function hasOwnerParticipated(personKey) {
    return ownerMessageCountStmt.get(personKey).n >= OWE_MIN_OWNER_MESSAGES;
  }

  // --- A: owe:open-loop --------------------------------------------------
  const openLoopRows = db.prepare(OPEN_LOOP_SQL).all(now - OPEN_LOOP_MIN_DAYS * DAY, now - OPEN_LOOP_MAX_DAYS * DAY);
  for (const row of openLoopRows) {
    if (excluded(row.personKey)) continue;
    const quoteContextId = latestAuthoredContextId(db, row.personKey);
    if (quoteContextId === null) continue;
    const ctx = contextTextStmt.get(quoteContextId);
    if (!ctx || !isAskText(ctx.text)) continue;
    const person = personRow(row.personKey);
    if (!person) continue;
    if (!includeAnonymous && isAnonymousContact({ name: person.name, key: row.personKey })) continue;
    if (person.role === 'romantic' || person.role === 'family') continue;
    if (!hasOwnerParticipated(row.personKey)) continue;

    const overdueDays = Math.floor((now - row.askedAt) / DAY);
    out.push({
      personKey: row.personKey, name: person.name, role: person.role,
      oweKind: 'owe:open-loop', overdueDays, askedAt: row.askedAt,
      quoteContextId, commitmentClaimId: null, commitmentValidTo: null,
      messages: person.sent + person.received, meetings: person.meetings,
      depth: person.sent + person.received + 3 * person.meetings,
    });
  }

  // --- B: owe:expired-commitment (B1 union B2, one candidate per person) -
  const byPerson = new Map();
  function considerB(personKey, overdueDays, rest) {
    const existing = byPerson.get(personKey);
    if (!existing || overdueDays > existing.overdueDays) byPerson.set(personKey, { overdueDays, ...rest });
  }

  const b1Rows = db.prepare(B1_SQL).all(now, now - COMMITMENT_MAX_STALE_DAYS * DAY);
  for (const row of b1Rows) {
    const overdueDays = Math.floor((now - row.validTo) / DAY);
    let quoteContextId = null;
    if (row.observedAt !== null && row.observedAt !== undefined) {
      const q = db.prepare(
        `SELECT c.id AS id FROM person_event_links pel JOIN context c ON c.id = pel.context_id
         WHERE pel.person_key = ? AND pel.authored = 1 AND pel.room = 0 AND c.ts <= ?
         ORDER BY c.ts DESC LIMIT 1`
      ).get(row.personKey, row.observedAt);
      quoteContextId = q ? Number(q.id) : null;
    }
    considerB(row.personKey, overdueDays, {
      askedAt: row.validTo, quoteContextId,
      commitmentClaimId: Number(row.claimId), commitmentValidTo: Number(row.validTo),
    });
  }

  const b2Rows = db.prepare(B2_SQL).all(now - PAGE_ASK_MIN_DAYS * DAY, now - COMMITMENT_MAX_STALE_DAYS * DAY);
  for (const row of b2Rows) {
    const overdueDays = Math.floor((now - row.askedAt) / DAY);
    considerB(row.personKey, overdueDays, {
      askedAt: row.askedAt, quoteContextId: Number(row.contextId),
      commitmentClaimId: Number(row.claimId), commitmentValidTo: null,
    });
  }

  for (const [personKey, data] of byPerson) {
    if (excluded(personKey)) continue;
    const person = personRow(personKey);
    if (!person) continue;
    if (!includeAnonymous && isAnonymousContact({ name: person.name, key: personKey })) continue;
    if (person.role === 'romantic' || person.role === 'family') continue;
    if (!hasOwnerParticipated(personKey)) continue;

    out.push({
      personKey, name: person.name, role: person.role,
      oweKind: 'owe:expired-commitment', overdueDays: data.overdueDays, askedAt: data.askedAt,
      quoteContextId: data.quoteContextId, commitmentClaimId: data.commitmentClaimId,
      commitmentValidTo: data.commitmentValidTo,
      messages: person.sent + person.received, meetings: person.meetings,
      depth: person.sent + person.received + 3 * person.meetings,
    });
  }

  out.sort((a, b) =>
    b.overdueDays - a.overdueDays ||
    kindPriority(a.oweKind) - kindPriority(b.oweKind) ||
    b.depth - a.depth ||
    (a.personKey < b.personKey ? -1 : a.personKey > b.personKey ? 1 : 0)
  );
  return out;
}

function tieSentence(candidate) {
  return candidate.oweKind === 'owe:open-loop'
    ? `They asked you something ${candidate.overdueDays} days ago and you have not written back`
    : `You said you would, and that came due ${candidate.overdueDays} days ago`;
}

// Writes rm_candidate_batch + rm_candidate_snapshot in exactly the shape
// hydrateCards reads (kind='owe' -- the finer owe_kind rides in evidence
// only), mirroring producer.mjs's produceBatch. Zero-candidate passes are
// still written: a pass that finds nothing is a measurement, not a skip.
export function produceOweBatch(db, { now = Date.now(), limit = 5 } = {}) {
  const pool = owePool(db, { now });
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
    const summary = tieSentence(candidate);
    const sharedEvidence = {
      owe_kind: candidate.oweKind,
      overdueDays: candidate.overdueDays,
      askedAt: candidate.askedAt,
      commitment_claim_id: candidate.commitmentClaimId,
      commitment_valid_to: candidate.commitmentValidTo,
      messages: candidate.messages,
      meetings: candidate.meetings,
      depth: candidate.depth,
      topics: [],
      mode: null,
    };
    const evidence = {
      quote_context_id: candidate.quoteContextId,
      role: candidate.role,
      label: null, focus: null, left: null, leftTone: null,
      ...sharedEvidence,
    };
    const snapshotId = Number(insSnap.run(
      batchId, candidate.personKey, 'owe', summary, JSON.stringify(evidence),
      OWE_PRODUCER_VERSION, OWE_RANK_STRATEGY, now
    ).lastInsertRowid);
    cards.push({
      personKey: candidate.personKey, name: candidate.name, kind: 'owe',
      sentence: summary, quoteContextId: candidate.quoteContextId, role: candidate.role,
      focus: null, label: null, left: null, leftTone: null,
      evidence: sharedEvidence,
      producer_version: OWE_PRODUCER_VERSION, rank_strategy: OWE_RANK_STRATEGY,
      snapshot_id: snapshotId,
    });
  }

  return { batchId, cards, pool };
}

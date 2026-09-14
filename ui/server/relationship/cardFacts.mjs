// The per-person facts a card carries BESIDE its sentence and its quote
// (surface review C, findings 13/14/15). Every one of them was already a
// column the people projection writes and nothing ever read: the card on a
// fresh install showed the same two counts three times over and said nothing
// about the person in front of the owner.
//
// COUNTS AND DATES ONLY. Nothing here reads message text -- the card already
// carries exactly one quote, resolved from its live row at serve time, and
// this module must not become a second, ungated way for message bodies to
// reach the widget.
//
// ONE SHAPE, ONE PLACE. The card route answers in three shapes (a peek, a
// serve, and a one-off serve under a mode the owner did not pick) and the
// page reads the same field names off all three, so the shape is built here
// once rather than spelled out at each send site.

import { CAL_GATES } from './calendarReconnect.mjs';
import { parseConnectedOn } from '../../../connectors/lib/linkedinRows.mjs';

const DAY = 86_400_000;

// Always an object, never null: a renderer that has to test `person` AND
// `person.title` has two ways to get it wrong, and a person with no LinkedIn
// export row is the ordinary case rather than an error.
const NO_PERSON = Object.freeze({ title: null, company: null, industry: null, connectedOn: null, url: null });

function asMs(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
}

function asText(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// people.linkedin is the canonical JSON object graph.mjs builds from the
// owner's own Connections.csv export -- `position`, `company`, `industry`,
// `connected_on`, `url` (and an `email` this deliberately does not carry:
// the card needs who they are, not how to reach them).
//
// `connectedOn` reaches the page as a ms epoch, like every other date on the
// card, so the page formats one kind of thing. It is parsed by the
// CONNECTOR'S OWN parser rather than a second one written here: that same
// function already decided what timestamp the connection row was stored
// under (linkedinRows.mjs's `ts`), and two parsers for one csv column is how
// a card ends up a day off from the row it came from. An unparseable or
// missing date is null -- never Date.parse, which is engine-dependent on
// this shape and would land a NaN on the wire.
export function personFacts(linkedinJson) {
  if (typeof linkedinJson !== 'string' || linkedinJson.length === 0) return { ...NO_PERSON };
  let parsed = null;
  try { parsed = JSON.parse(linkedinJson); } catch { return { ...NO_PERSON }; }
  if (parsed === null || typeof parsed !== 'object') return { ...NO_PERSON };
  return {
    title: asText(parsed.position),
    company: asText(parsed.company),
    industry: asText(parsed.industry),
    connectedOn: parseConnectedOn(parsed.connected_on),
    url: asText(parsed.url),
  };
}

// The last time a calendar row put the two of them in a small room together,
// through the SAME spine and the SAME gates producer.mjs's future-meeting
// veto uses (person_identifiers for identity, attendee count <=
// CAL_GATES.maxAttendees, declined responses excluded) -- pointed backwards.
// Using the same gates matters: a card that says "you last met 8 months ago"
// off a 200-person all-hands, while the veto beside it refuses to count that
// same invite, would be two answers to one question.
//
// people.met_in_person is NOT the fallback here. It is a count, not a date,
// and it is deliberately coarser (see producer.mjs's gate notes); a card that
// cannot name when they last met should say nothing rather than guess.
const LAST_MEETING_SQL = `
  SELECT MAX(c.ts) AS lastMet
  FROM context c
  JOIN json_each(c.meta, '$.attendees') je
  JOIN person_identifiers pi
    ON pi.identifier = lower(json_extract(je.value, '$.email'))
  WHERE c.source = 'calendar'
    AND c.ts <= ?
    AND pi.person_key = ?
    AND json_valid(c.meta)
    AND json_array_length(c.meta, '$.attendees') > 0
    AND json_array_length(c.meta, '$.attendees') <= ?
    AND COALESCE(lower(json_extract(je.value, '$.response')), '') != 'declined'
`;

export function lastMeetingAt(db, personKey, { now = Date.now() } = {}) {
  let row = null;
  try {
    row = db.prepare(LAST_MEETING_SQL).get(now, personKey, CAL_GATES.maxAttendees);
  } catch {
    // A corpus with no calendar rows at all, or a pre-migration
    // person_identifiers: an unanswerable question, not a broken card.
    return null;
  }
  return asMs(row?.lastMet);
}

// THE PINNED SHAPE. Every field is present on every serve; a fact this
// corpus cannot answer is null, never absent, so the page never has to tell
// "no meeting" from "this build does not send meetings". The peek gets none
// of it -- see the card route's own note at the peek branch.
//
// A TIMESTAMP, NOT A DAY COUNT (polish review finding 11). This used to
// prefer matcher.mjs's `evidence.lastMeetingDaysAgo`, a number computed when
// the batch was PRODUCED and rendered as a distance from now when the card
// was SERVED -- so a snapshot served a week after it was produced read a week
// fresher than the truth, silently, and worse the longer a queue backed up.
// `lastMeetingAt` is an instant, which cannot go stale between the two, and
// the page subtracts it from its own clock.
//
// The produce-time evidence value is not consulted at all now, not even as a
// fallback for a corpus the live query cannot answer: a number wrong by an
// unknown amount is not a better answer than "we do not know when".
//
// `lastMeetingDaysAgo` stays on the wire for ONE RELEASE while the page moves
// to `lastMeetingAt`, derived from the same live instant right here so the
// two can never name different meetings. Delete it after that.
export function personCardFacts(db, personKey, { now = Date.now() } = {}) {
  let row;
  try {
    row = db.prepare(
      'SELECT linkedin, last_from_them, last_from_owner, last_seen FROM people WHERE person_key = ?'
    ).get(personKey);
  } catch {
    row = undefined;
  }
  const metAt = lastMeetingAt(db, personKey, { now });
  return {
    person: personFacts(row?.linkedin ?? null),
    lastFromThem: asMs(row?.last_from_them),
    lastFromOwner: asMs(row?.last_from_owner),
    lastSeen: asMs(row?.last_seen),
    lastMeetingAt: metAt,
    lastMeetingDaysAgo: metAt === null ? null : Math.max(0, Math.floor((now - metAt) / DAY)),
  };
}

// `changed` AS THE PAGE READS IT (surface review C finding 16). lookup.mjs's
// newestWebChange answers the desk as well as the card, and the two want
// different things from the same row: the desk wants the source LIST ("show
// me the two urls"), the card wants the COUNT ("2 sources"). Projecting here
// rather than reshaping newestWebChange keeps the desk's own view intact.
//
// `sources` IS THE COUNT ON THE CARD, and the list it used to be moves to
// `sourceUrls` -- one rename, once, rather than a renderer that has to know
// which of the two a field called `sources` means. `text`, `sources` and `at`
// are the pinned three the page always reads; url/kind/quote/date/
// corroboration ride along because a change worth showing usually wants its
// date ("she moved in March") and its receipt.
//
// A `changed` with no text is not a change: null, so the page hides the row
// rather than rendering an empty one.
export function changedForCard(changed) {
  if (changed === null || changed === undefined) return null;
  const text = asText(changed.text);
  if (text === null) return null;
  const sourceUrls = Array.isArray(changed.sources)
    ? changed.sources.map((source) => asText(source?.url)).filter((url) => url !== null)
    : [];
  return {
    text,
    sources: Array.isArray(changed.sources) ? changed.sources.length : 0,
    at: asMs(changed.at),
    sourceUrls,
    url: asText(changed.url),
    kind: asText(changed.kind),
    quote: asText(changed.quote),
    date: asText(changed.date),
    // asMs, like every other number here (polish review finding 19): a
    // hand-altered or pre-migration corroboration column reached Number()
    // directly, and the NaN that produces leaves this function as `null` only
    // because JSON.stringify happens to emit one. Nothing on the wire should
    // rest on that.
    corroboration: asMs(changed.corroboration),
  };
}

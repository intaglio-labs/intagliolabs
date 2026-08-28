// The people graph: every person the owner knows, resolved across channels,
// with a dormancy clock and the evidence behind them.
//
// This is the payoff of the connections build (deep message windows, calendar
// attendee emails, the LinkedIn export, the contacts spine, WhatsApp). Raw,
// it is six sources that each name people differently — a phone here, an email
// there, a LinkedIn slug, a display name in a meeting. This module collapses
// them into ONE person per human and attaches what the corpus knows.
//
// THE RULES ARE THE SAME AS THE EPISODIC SHELF, and for the same reason this
// feeds an experiment: CODE resolves people and CODE does the arithmetic
// (counts, dormancy, co-attendance). No model decides who is whom — identity
// is too consequential to hand a language model, exactly like a query.
//
// RESOLUTION, deliberately conservative (the spine must not become the
// project): two identifiers are the same person when the contacts spine maps
// them to the same display name, OR when they are literally the same string.
// A LinkedIn connection merges into that person only on an EXACT normalized
// name match or a shared email — never on fuzzy name similarity, because a
// wrong merge invents a relationship that is not there, which is worse than a
// split one the owner can eyeball.
//
// Reads two databases (context + the spine's state.db) and writes nothing.

// Whether a row happened in a room or in a conversation. Derived from the
// thread, never stored -- see memory/threadKind.mjs for why it is not a field.
import { threadKind, isRoom, counterpartyFromThread, GROUP } from '../memory/threadKind.mjs';
import { inferRelationshipRoleIndex } from './roles.mjs';

const DAY = 86_400_000;

// Calendar providers commonly expose a deeper synthetic history than any
// conversation connector (recurring birthdays are the classic case). Keep
// that context, but do not let it invent extra relationship years. The oldest
// real row from ANY other relationship connector is the shared backfill floor:
// if iMessage reaches nine years, Instagram seven and Calendar eleven, every
// relationship signal is read from the iMessage floor onward.
const NON_CALENDAR_RELATIONSHIP_SOURCES = Object.freeze([
  'imessage', 'whatsapp', 'messenger', 'instagram', 'twitter', 'telegram',
  'discord', 'slack', 'mail', 'linkedin',
]);

export function relationshipHistoryFloor(contextDb, now = Date.now()) {
  const placeholders = NON_CALENDAR_RELATIONSHIP_SOURCES.map(() => '?').join(',');
  const row = contextDb.prepare(
    `SELECT MIN(ts) AS oldest FROM context WHERE source IN (${placeholders}) AND ts <= ?`
  ).get(...NON_CALENDAR_RELATIONSHIP_SOURCES, now);
  if (row?.oldest === null || row?.oldest === undefined) return null;
  const oldest = Number(row?.oldest);
  return Number.isFinite(oldest) ? oldest : null;
}

function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// identifier (phone/email) -> canonical display name, from the spine.
// Is this string a NAME, or an identifier wearing one? `speaker` falls back to
// the handle when the store knows no name, so a WhatsApp LID
// ("11107305521405@lid") and a bare phone number both arrive looking like
// labels. Neither is one.
// What to show when nobody, anywhere, knows this person's name.
//
// A raw WhatsApp LID is seventeen digits and an @lid suffix. It is not a
// name, it is not recognisable, and it is not even a number the owner could
// look up -- WhatsApp mints it precisely so it cannot be traced back to one.
// Rendering it verbatim asks somebody to recognise an opaque token.
//
// A phone number is different: it is unrecognisable too, but it is REAL, and
// an owner can often place it. So numbers stay, formatted; only the LID gets
// replaced by an honest description of what it is.
export function readableId(identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0) return null;
  if (identifier.endsWith('@lid')) return 'WhatsApp contact';
  return identifier;
}

export function namelike(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 80) return false;
  if (v.includes('@')) return false; // an address or a LID, never a name
  if (/^\+?[0-9()\s.-]+$/u.test(v)) return false; // a phone number
  return /\p{L}/u.test(v); // has an actual letter in it
}

// THE SAME IDENTIFIER, WRITTEN TWO WAYS.
//
// Contacts and the message stores agree on E.164 for almost everything -- both
// sides of this corpus are overwhelmingly `+1XXXXXXXXXX` -- so the exact match
// below carries the load. This is for the tail that does not: a number typed
// into the address book with punctuation, an address stored with different
// case. Digits only, last ten, because a leading `+1` on one side and not the
// other is the common disagreement and ten digits is where a NANP number
// becomes unambiguous.
export function normIdentifier(identifier) {
  const v = String(identifier ?? '').trim();
  if (v.length === 0) return '';
  if (v.includes('@')) return v.toLowerCase();
  const digits = v.replace(/\D/gu, '');
  if (digits.length < 7) return ''; // a short code is not a person; never fold one
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function emptySpine() {
  return {
    idToName: new Map(),
    nameToIds: new Map(),
    looseIdToName: new Map(),
    nameFor() {
      return undefined;
    },
  };
}

export function loadSpine(stateDb) {
  if (!stateDb) return emptySpine();
  const map = new Map();
  const nameToIds = new Map();
  // Normalised identifier -> name, used ONLY when the exact lookup misses.
  const loose = new Map();
  const ambiguous = new Set();
  // AN EMPTY SPINE IS AN ANSWER, NOT AN ERROR CODE.
  //
  // This used to wrap the whole read in a catch that returned an empty spine for
  // ANY failure, on the reasoning that a fresh install has no contacts yet. That
  // is true and it is worth keeping -- but it made a transient failure
  // indistinguishable from a genuinely empty address book, and the two have
  // opposite consequences. With no spine, every person known only through
  // Contacts reverts to a raw handle AND their handles stop merging, so one
  // person becomes several with their messages split between them. Cached, that
  // is the whole app quietly wrong until something else moves the stamp.
  //
  // So: a missing table is still the valid empty case. Anything else -- a lock
  // held by the connector mid-upsert, an unreadable file -- is raised, because a
  // caller that cannot get names must be able to tell that it could not, rather
  // than serve a nameless graph as though it were the truth.
  let rows;
  try {
    rows = stateDb.prepare('SELECT identifier, display_name FROM contact_ids').all();
  } catch (error) {
    if (/no such table/iu.test(String(error?.message ?? ''))) return emptySpine();
    throw error;
  }
  {
    for (const r of rows) {
      map.set(r.identifier, r.display_name);
      const key = normName(r.display_name);
      if (!nameToIds.has(key)) nameToIds.set(key, { name: r.display_name, ids: [] });
      nameToIds.get(key).ids.push(r.identifier);

      const nid = normIdentifier(r.identifier);
      if (nid === '') continue;
      const seen = loose.get(nid);
      // TWO PEOPLE, ONE NORMALISED NUMBER. Ten digits is not globally unique --
      // two international numbers can share their last ten. Rather than pick
      // one and put the wrong name on somebody, the loose index forgets the key
      // entirely and that identifier falls back to the exact match or to no
      // name at all. Being unnamed is recoverable; being named as someone else
      // is not.
      if (seen !== undefined && normName(seen) !== normName(r.display_name)) {
        ambiguous.add(nid);
      } else if (seen === undefined) {
        loose.set(nid, r.display_name);
      }
    }
  }
  for (const nid of ambiguous) loose.delete(nid);
  return {
    idToName: map,
    nameToIds,
    looseIdToName: loose,
    /// The name Contacts has for this identifier, exact match first.
    nameFor(identifier) {
      const exact = map.get(identifier);
      if (exact !== undefined) return exact;
      const nid = normIdentifier(identifier);
      return nid === '' ? undefined : loose.get(nid);
    },
  };
}

// The shared direct/room rule for iMessage, WhatsApp, and every Matrix-backed
// social source. Incoming room rows belong to their actual sender; the owner's
// room rows belong to nobody in particular. Direct rows belong to the thread's
// counterparty in both directions.
function chatSignalsForRow(row, meta, ts) {
  const fromMe = meta.is_from_me === true || meta.is_from_me === 1;
  const speakerName = namelike(row.speaker) ? row.speaker : undefined;
  const room = isRoom(row, meta);
  if (threadKind(row, meta) === GROUP) {
    if (fromMe) return [];
    const sender = meta.sender_handle ?? meta.handle ?? null;
    return sender
      ? [{ id: sender, channel: row.source, ts, fromMe: false, name: speakerName, room }]
      : [];
  }
  // Apple omits the handle on most outbound one-to-one rows; the thread guid
  // recovers it only for iMessage. Matrix and WhatsApp write chat_handle.
  const id = meta.chat_handle ?? meta.handle ?? counterpartyFromThread(row, meta);
  if (!id) return [];
  // Never give a counterparty the owner's speaker name on an outbound row.
  const oneToOneName = (!fromMe && speakerName)
    || (namelike(meta.chat_name) ? meta.chat_name : undefined);
  return [{ id, channel: row.source, ts, fromMe, name: oneToOneName || undefined, room }];
}

// The identifier a row is "about" — the counterparty, never the owner. Returns
// { id, channel, ts, fromMe, name? } or null for rows with no person.
function personSignalsForRow(row, meta, owner) {
  const ts = Number(row.ts);
  switch (row.source) {
    case 'imessage':
    case 'whatsapp':
    case 'messenger':
    case 'instagram':
    case 'twitter':
    case 'telegram':
    case 'discord':
    case 'slack':
      return chatSignalsForRow(row, meta, ts);
    case 'mail': {
      // EVERY non-owner address on the email is counted, not just the first
      // (owner, 2026-08-21). A VC cc'd on an intro thread is exactly the
      // person the old first-address-only shortcut dropped. fromMe is whether
      // the owner sent it. Capped at 12 addresses so a mass blast does not
      // mint 200 people; the automated senders are filtered by the ranker.
      const from = Array.isArray(meta.from) ? meta.from[0] : null;
      const ownerSent = Boolean(from && isOwnerAddress(from, owner));
      const everyone = [
        ...(Array.isArray(meta.from) ? meta.from : []),
        ...(Array.isArray(meta.to) ? meta.to : []),
        ...(Array.isArray(meta.cc) ? meta.cc : []),
      ];
      const seen = new Set();
      const out = [];
      for (const addr of everyone) {
        if (typeof addr !== 'string') continue;
        const id = addr.toLowerCase();
        if (isOwnerAddress(id, owner) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, channel: 'mail', ts, fromMe: ownerSent });
        if (out.length >= 12) break;
      }
      return out;
    }
    case 'calendar': {
      const out = [];
      const seen = new Set();
      const add = (email, name) => {
        const id = String(email ?? '').toLowerCase();
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push({ id, channel: 'calendar', ts, fromMe: false, name: namelike(name) ? name : undefined });
      };
      for (const a of meta.attendees ?? []) add(a?.email, a?.name);
      // THE ORGANIZER IS A PERSON TOO, and EventKit does not always repeat them
      // in the attendee list. A private development corpus confirmed this could
      // omit the person who called the meeting, making that person the
      // one person it did not record. Deduped against the attendees, because
      // usually they ARE in both.
      const org = meta.organizer;
      add(typeof org === 'string' ? org : org?.email, typeof org === 'string' ? undefined : org?.name);
      return out;
    }
    case 'linkedin': {
      if (meta.kind === 'connection') {
        return [{ id: `linkedin:${row.entity_id.split(':').pop()}`, channel: 'linkedin', ts, fromMe: false,
                  name: meta.name, linkedin: {
                    position: meta.position,
                    company: meta.company,
                    connected_on: meta.connected_on,
                    email: meta.email,
                    industry: meta.industry,
                    education: meta.education,
                    schools: meta.schools,
                    school: meta.school,
                    high_school: meta.high_school,
                  } }];
      }
      if (meta.kind === 'message') {
        const id = meta.from && !isOwnerName(meta.from, owner) ? `liname:${normName(meta.from)}` : null;
        return id ? [{ id, channel: 'linkedin', ts, fromMe: false, name: meta.from }] : [];
      }
      // No `kind` means this is a Matrix bridge row.
      return chatSignalsForRow(row, meta, ts);
    }
    default:
      return [];
  }
}

// Owner-address / owner-name checks. Identity is INJECTED (see owner.mjs,
// loaded from the local config) so no personal data lives in this tracked
// file. `owner` is { addresses: Set<string>, names: string[] }.
function isOwnerAddress(a, owner) {
  return owner.addresses.has(String(a).toLowerCase());
}
function isOwnerName(n, owner) {
  const nk = normName(n);
  return owner.names.some((name) => normName(name) === nk);
}

// Content-signal vocabularies: code SCANS the corpus text for topic evidence
// and counts hits per person. The count is a number; the text never leaves
// this function and never reaches a model. This is how "did we talk about
// raising" becomes a rankable fact without breaking the rule that message
// content stays off the model — the same discipline the episodic shelf uses,
// applied to a graph query.
// HIGH-SPECIFICITY ONLY. The first cut included "deck", "round", "angel",
// "raise", "portfolio" — and family members lit up, because those words live
// in ordinary conversation ("raise the bar", "slide deck", "next round" of
// drinks). A private development corpus produced obvious family false positives.
// So the vocabulary is now terms that essentially ONLY occur when actually
// discussing a fundraise — multiword and jargon that casual talk does not use.
// This trades recall (a real investor thread that never said "term sheet" is
// missed) for precision (the list is investors, not everyone chatty), which is
// the right trade for a shortlist the owner will eyeball. The exact vocabulary
// is a knob the sealed-list experiment is meant to calibrate.
// DIRECTIONAL. The owner's definition of an investor is "someone I talked to
// about investing IN ME" — not generic fundraising chatter (that lit up
// founder friends commiserating about their own raises). So the vocabulary is
// phrases where the COUNTERPARTY is positioning to back the owner: "invest in
// you", "back your round", "send me your deck", "your traction/metrics/cap
// table" (an investor asking about the owner's numbers). Two founders trading
// "how's your raise going" does not match this.
// UNAMBIGUOUS AND DIRECTIONAL ONLY. The looser cut ("your metrics", "your
// revenue", "your runway") caught a business newsletter (Morning Brew scored
// 8) and founder peer-talk, because those phrases are everywhere. What
// remains is language that essentially only occurs when a COUNTERPARTY is
// moving to back the owner specifically — a sentence a friend or a newsletter
// does not write. Precision hard over recall; the sealed-list experiment
// calibrates the exact set.
export const CONTENT_SIGNALS = Object.freeze({
  investor:
    /\b(invest in (you|your company|your startup)|investing in (you|your company)|back your (round|raise|company)|write (you|your team) a check|put (money|capital) into your (round|company)|lead your (round|seed|raise)|join your round|come into your round|allocation in your round|send (me|us) your deck (to review|for)|term sheet for|our fund (would|is) invest|from our fund into|we want to invest in|interested in investing in you|wire (you the|the) (funds|money) for your)\b/giu,
});

// Attach per-person content-signal counts, from the message text of the
// sources whose text is real prose (message sources plus mail). Calendar
// titles and LinkedIn connection rows are not prose.
function addContentSignals(contextDb, people, keyResolver, signals) {
  const names = Object.keys(signals);
  if (names.length === 0) return;
  const rows = contextDb
    .prepare(
      "SELECT source, text, meta FROM context " +
        "WHERE source IN ('imessage','whatsapp','messenger','instagram','twitter'," +
        "'telegram','discord','slack','mail','linkedin') AND text IS NOT NULL"
    )
    .all();
  for (const row of rows) {
    let meta = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') ?? {};
    } catch {
      meta = {};
    }
    if (row.source === 'linkedin' && meta.kind && meta.kind !== 'message') continue;
    // Which person is this row's counterparty? Reuse the same id derivation,
    // but we only need the key, not a full signal.
    const fromMe = meta.is_from_me === true || meta.is_from_me === 1;
    let id;
    if (row.source === 'mail') {
      id = Array.isArray(meta.from) ? meta.from[0]?.toLowerCase() : null;
    } else if (threadKind(row, meta) === GROUP) {
      id = fromMe ? null : (meta.sender_handle ?? meta.handle ?? null);
    } else {
      id = meta.chat_handle ?? meta.handle ?? counterpartyFromThread(row, meta);
    }
    // ROOMS COUNT HERE, deliberately, and the opposite of the chips rule.
    //
    // This scan asks "does this PERSON talk about investor topics" -- a fact
    // about them, not about their relationship with the owner. Somebody
    // discussing a term sheet in a group said it; where they stood when they
    // said it does not make it less true of them. A chip is different, because a
    // chip claims to describe a conversation the two of you had.
    //
    // The `meta.is_group` test that used to sit here never fired for iMessage
    // (the key is WhatsApp-only), so groups have in fact been counted all along.
    // Rather than make a dead gate live and quietly drop 24.8% of the credited
    // rows off this scan -- which would push people off the investor list -- the
    // behaviour is kept and the intent is now written down.
    if (!id) continue;
    const key = keyResolver(id);
    const person = people.get(key);
    if (!person) continue;
    // Channel weight: a real investor emails or LinkedIn-DMs — term sheets,
    // intros, diligence live there, not in iMessage. So a directional hit in
    // mail or a LinkedIn message counts double, which is the owner's "email is
    // a good source, add LinkedIn messages" made concrete in the score.
    const weight = row.source === 'mail' || row.source === 'linkedin' ? 2 : 1;
    for (const name of names) {
      const m = row.text.match(signals[name]);
      if (m) person.content[name] = (person.content[name] ?? 0) + weight;
    }
  }
}

// Build the graph. Returns an array of person objects, each merging every
// channel that names them.
//
// `contentSignals` (default none) attaches code-counted topic evidence per
// person — pass CONTENT_SIGNALS or a subset to enable "did we talk about X".
//
// `sinceTs` (default null = all time) restricts the graph to rows at or after a
// timestamp — the People popup's timeframe selector (1 week … max) made
// concrete, so "initialize search" over the last year does not also mint a
// person from a single email eight years ago.
//
// `aliases` (default null) is the owner's VERIFIED merges: a Map from a resolved
// key to the canonical key it should collapse into. Applied AFTER the code's own
// conservative resolution, it is how a human answer ("yes, Mike and Michael are
// the same") folds back into the graph — the one place a merge the code refused
// to guess is allowed, because a person confirmed it. It never SPLITS (the code
// already errs toward splitting); it only unions keys the owner said are one.
export function buildGraph(
  contextDb,
  stateDb,
  { now = Date.now(), owner = { addresses: new Set(), names: [], keys: new Set() }, contentSignals = null,
    sinceTs = null, aliases = null } = {}
) {
  const spine = loadSpine(stateDb);
  const connectorFloor = relationshipHistoryFloor(contextDb, now);
  const lowerBound = [sinceTs, connectorFloor]
    .filter((value) => Number.isFinite(value))
    .reduce((latest, value) => Math.max(latest, value), -Infinity);
  const hasLowerBound = Number.isFinite(lowerBound);

  // canonical key -> person accumulator
  const people = new Map();
  const rawKeyForId = (id, name) => {
    // Spine name wins; then an exact-name LinkedIn/calendar match to a spine
    // person; then the raw id.
    const known = spine.nameFor(id);
    if (known !== undefined) return `name:${normName(known)}`;
    if (name) {
      const nk = normName(name);
      if (spine.nameToIds.has(nk)) return `name:${nk}`;
    }
    return `id:${id}`;
  };
  // The owner's confirmed merges fold in here: the code resolves a key, then an
  // alias (if any) redirects it to the canonical person. Chase one level of
  // indirection so an alias pointing at another aliased key still lands.
  const keyForId = (id, name) => {
    const raw = rawKeyForId(id, name);
    if (!aliases) return raw;
    let k = raw;
    for (let i = 0; i < 8 && aliases.has(k); i++) k = aliases.get(k);
    return k;
  };
  // A one-arg resolver for the content scan, which knows only the identifier.
  const keyForId2 = (id) => keyForId(id, null);

  const rows = contextDb
    .prepare(
      // `speaker` is in this list because it was missing from it, and its
      // absence made the name-recovery below dead code: signalsFor read
      // row.speaker, row.speaker was always undefined, and every WhatsApp
      // name it was written to rescue was discarded silently.
      "SELECT ts, source, speaker, entity_id, meta FROM context " +
        "WHERE source IN ('imessage','whatsapp','messenger','instagram','twitter'," +
        "'telegram','discord','slack','mail','calendar','linkedin')" +
        (hasLowerBound ? " AND ts >= ?" : "")
    )
    .all(...(hasLowerBound ? [lowerBound] : []));

  for (const row of rows) {
    let meta = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') ?? {};
    } catch {
      meta = {};
    }
    for (const sig of personSignalsForRow(row, meta, owner)) {
      const key = keyForId(sig.id, sig.name);
      if (!people.has(key)) {
        people.set(key, {
          key,
          names: new Set(),
          identifiers: new Set(),
          channels: new Set(),
          firstSeen: sig.ts,
          lastSeen: null,
          lastFromThem: null,
          sent: 0,
          received: 0,
          metInPerson: 0,
          roomMessages: 0,
          directMessages: 0,
          linkedin: null,
          content: {},
          timeline: new Map(),
          // Direct-message days, distinct from the monthly aggregate above.
          // Highlight streaks need actual calendar-day continuity; deriving it
          // from twelve non-empty months would call one message a month a
          // "streak" and cannot answer the year's longest day run.
          activeDays: new Set(),
          lastFromOwner: null,
        });
      }
      const p = people.get(key);
      p.identifiers.add(sig.id);
      p.channels.add(sig.channel);
      if (sig.name) p.names.add(sig.name);
      const spineName = spine.nameFor(sig.id);
      if (spineName !== undefined) p.names.add(spineName);
      // A calendar event is co-attendance, not contact — and it can be in the
      // FUTURE, which produced negative dormancy on the first live run. So
      // firstSeen spans everything, but lastSeen and the DORMANCY clock only
      // tick on signals that have actually happened (ts <= now). lastSeen is
      // seeded null above for the same reason: the SELECT has no ORDER BY, so
      // an unguarded seed let a future event stick as lastSeen whenever it
      // happened to be the person's first row scanned. A meeting on the
      // calendar is not them reaching out.
      const isMessage = sig.channel !== 'calendar' && !sig.linkedin;
      if (Number.isFinite(sig.ts)) {
        if (sig.ts < p.firstSeen) p.firstSeen = sig.ts;
        if (sig.ts <= now && (p.lastSeen === null || sig.ts > p.lastSeen)) p.lastSeen = sig.ts;
        // NOT IN A ROOM. "They reached out" has to mean they addressed the
        // owner; somebody posting in a group both happen to be in is not that.
        // Private testing found people whose clock was set entirely by room
        // chatter even though they had never sent a direct message, so their "they
        // reached out" history was other people's group threads. Dormancy feeds
        // the mentor band, constellation warmth and open-loop detection, so this
        // was three wrong answers from one wrong clock.
        if (isMessage && !sig.fromMe && !sig.room && sig.ts <= now
            && (p.lastFromThem === null || sig.ts > p.lastFromThem)) {
          p.lastFromThem = sig.ts;
        }
        // The owner's side of the same clock, for open-loop detection ("they
        // wrote last and I never answered"). Message channels only, like
        // lastFromThem -- a calendar invite neither opens nor closes a loop.
        // Same rule on the owner's side: answering in a group is not answering
        // this person, so it must not close an open loop with them.
        if (isMessage && sig.fromMe && !sig.room && sig.ts <= now
            && (p.lastFromOwner === null || sig.ts > p.lastFromOwner)) {
          p.lastFromOwner = sig.ts;
        }
      }
      // SENT AND RECEIVED MEAN DIRECT, because that is what every consumer of
      // them already assumes. reciprocity is documented as "do they write back --
      // 1.0 is a balanced two-way thread", and counting a room made that read
      // 1.0 for two people who have never addressed each other and merely posted
      // the same number of times into the same group. Somebody answering in a
      // group chat did not answer YOU.
      //
      // Room volume is not discarded, it is counted as itself. The two numbers
      // answer different questions and neither one is the other's approximation.
      if (sig.channel === 'calendar') p.metInPerson += 1;
      else if (sig.room) p.roomMessages += 1;
      else if (sig.fromMe) p.sent += 1;
      else p.received += 1;
      if (sig.channel !== 'calendar' && !sig.linkedin && !sig.room) p.directMessages += 1;
      // The activity TIMELINE: the same counts, bucketed by calendar month, so
      // downstream code (people/profile.mjs) can see WHEN a relationship lived
      // -- peak era, cadence, "active in 2020-2022" -- not just its lifetime
      // totals. Only signals that have already happened tick a bucket, the
      // same rule as the dormancy clock: a future meeting is not history yet.
      if (Number.isFinite(sig.ts) && sig.ts <= now) {
        const d = new Date(sig.ts);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        let bucket = p.timeline.get(ym);
        if (bucket === undefined) {
          bucket = { sent: 0, received: 0, met: 0, room: 0, channels: new Set() };
          p.timeline.set(ym, bucket);
        }
        // Connector provenance belongs to the same month as its activity.
        // A lifetime channel set cannot answer "who was on Instagram in
        // 2023" when that person only appeared there years later.
        bucket.channels.add(sig.channel);
        // Same split as the totals: the year view sums these, so a room counted
        // here would put the old number back on the one screen that shows it.
        if (sig.channel === 'calendar') bucket.met += 1;
        else if (sig.room) bucket.room += 1;
        else if (sig.fromMe) bucket.sent += 1;
        else bucket.received += 1;
        // A streak is reciprocal direct correspondence. Calendar attendance
        // and group chatter are valuable, but neither says the two people
        // exchanged a message on this day.
        if (isMessage && !sig.room) {
          p.activeDays.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        }
      }
      if (sig.linkedin) p.linkedin = sig.linkedin;
    }
  }

  // Content signals: code-counted topic evidence per person (never model-read).
  if (contentSignals) {
    addContentSignals(contextDb, people, keyForId2, contentSignals);
  }

  // Finalize: pick a display name, compute dormancy and a depth score.
  const graph = [...people.values()]
    // An explicitly marked self identity can be a non-email source ID. Email
    // aliases are removed while rows are read; this stable-key fallback makes
    // sure a person never survives as their own relationship card.
    .filter((p) => !owner?.keys?.has(p.key))
    .map((p) => {
      const messages = p.sent + p.received;
      // THE SPINE FIRST, because it is the only source that knows a name for
      // somebody who has never been named IN the data.
      //
      // p.names holds names carried by the events themselves -- a calendar
      // attendee, a LinkedIn profile. A message carries a HANDLE and never a
      // name, so for anyone known only through the address book that set is
      // empty and this fell through to the raw identifier. That is why the
      // timeline showed "owner@example.test" for a person whose own key was
      // already `name:example owner`: the key had resolved them through the
      // spine, and the label never asked.
      //
      // nameToIds keeps the ORIGINAL casing against the normalised key, so this
      // renders "Example Owner" rather than the flattened form the key carries.
      const fromSpine = p.key.startsWith('name:')
        ? spine.nameToIds.get(p.key.slice('name:'.length))?.name
        : null;
      const display =
        fromSpine ??
        [...p.names].sort((a, b) => b.length - a.length)[0] ??
        readableId([...p.identifiers][0]) ??
        p.key;
      return {
        // The canonical resolution key. Stable across rebuilds (derived from the
        // data, not the run), so the review queue's decisions key on it.
        key: p.key,
        name: display,
        identifiers: [...p.identifiers],
        channels: [...p.channels].sort(),
        channelCount: p.channels.size,
        messages,
        sent: p.sent,
        received: p.received,
        // Do they write back? min/max so the scale is intuitive: 1.0 is a
        // balanced two-way thread, 0 is a broadcast nobody answered. A bond
        // versus a megaphone.
        reciprocity:
          Math.max(p.sent, p.received) > 0
            ? Math.round((100 * Math.min(p.sent, p.received)) / Math.max(p.sent, p.received)) / 100
            : 0,
        metInPerson: p.metInPerson,
        // THE SECOND AXIS. messages/sent/received above are unchanged -- these
        // say how much of it was addressed to the owner and how much was said in
        // a room they also happened to be in. `roomOnly` is the case worth a
        // badge: 143 people have never sent a direct message and today render
        // identically to friends on every screen in the app.
        roomMessages: p.roomMessages,
        directMessages: p.directMessages,
        roomOnly: p.directMessages === 0 && p.roomMessages > 0,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        // The dormancy clock the whole build was for: days since THEY last
        // reached the owner (not since the owner last pinged them).
        dormancyDays: p.lastFromThem === null ? null : Math.floor((now - p.lastFromThem) / DAY),
        // 0, not negative nonsense, for a person whose only signals are still
        // in the future (lastSeen null).
        relationshipDays: p.lastSeen === null ? 0 : Math.floor((p.lastSeen - p.firstSeen) / DAY),
        // The raw clocks behind dormancy, exposed for open-loop detection
        // (profile.mjs): who spoke last, on a message channel, and when.
        lastFromThem: p.lastFromThem,
        lastFromOwner: p.lastFromOwner,
        // Month-bucketed activity, oldest first: [{ ym: 'YYYY-MM', sent,
        // received, met }]. The extraction layer's raw material.
        timeline: [...p.timeline.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ym, b]) => ({ ym, ...b, channels: [...b.channels].sort() })),
        activeDays: [...p.activeDays].sort(),
        linkedin: p.linkedin,
        content: p.content,
      };
    })
    // Drop the singletons that are almost always noise: a single email from a
    // no-reply, one calendar invite from a room. A person worth knowing about
    // shows up more than once OR across more than one channel.
    ;
  const inferredRoles = inferRelationshipRoleIndex(
    contextDb,
    new Map(graph.flatMap((person) => (person.identifiers ?? []).map((id) => [id, person.key]))),
    new Map(graph.map((person) => [person.key, person.name]))
  );
  return graph.map((person) => {
    const yearRoles = inferredRoles.rolesByYear.get(person.key) ?? new Map();
    const activeYears = new Set((person.timeline ?? []).map((bucket) => Number(String(bucket.ym).slice(0, 4))));
    const rolesByYear = {};
    for (const year of activeYears) {
      if (!Number.isInteger(year)) continue;
      // Manual corrections are scoped to the tab on which they were made.
      // With no message evidence in a calendar-only year, fall back only to
      // saved-name identity evidence (for example "Mother"), never to a role
      // inferred from some other year's conversation.
      rolesByYear[year] = owner?.rolesByYear?.get(String(year))?.get(person.key)
        ?? yearRoles.get(year)
        ?? inferredRoles.nameRoles.get(person.key)
        ?? 'friend';
    }
    return {
      ...person,
      role: owner?.roles?.get(person.key) ?? inferredRoles.roles.get(person.key) ?? 'friend',
      rolesByYear,
    };
  });
  // THE "≥2" EXISTENCE BAR IS GONE (owner, 2026-08-21). Every resolved person
  // is kept, even one with a single message on a single channel — a lone real
  // email from a VC used to be filtered as noise before ranking ever saw it,
  // and that is exactly the person a "find everyone from my past" sweep wants.
  // Automated one-offs are dropped later by the ranker's address filters, and
  // each need's own gate (investor identity/content) does the real filtering,
  // so the graph itself stops pre-judging who counts.
}

// IS THIS A ROOM OR A CONVERSATION? -- one answer, derived, shared by everything.
//
// WHY THIS EXISTS. Five places in this tree branch on `meta.is_group`, and
// exactly one connector writes it: WhatsApp. iMessage writes six meta keys
// (guid, chat_guid, is_from_me, handle, service, has_attachment) and is_group is
// not among them -- so every one of those branches is dead code across 99% of
// the corpus, and 80,481 group messages (22.3% of iMessage) travel the
// one-to-one path. The system cannot currently tell "I talked to Sam" from "Sam
// spoke in a room I was in", and several things that reach a screen quietly
// assume the former.
//
// The marker was there the whole time. An iMessage chat_guid is
// `<service>;<marker>;<id>`, and the marker is '+' for a room and '-' for a
// one-to-one. Measured on the live store: 279,183 '-' and 80,481 '+'.
//
// A WARNING FOR THE NEXT PERSON, because it cost a full investigation here: the
// service token is the literal string `any` on ALL 359,664 guid-bearing rows,
// not 'iMessage'. `LIKE 'iMessage;+;%'` matches ZERO rows and looks like a
// working filter. Split on ';' and read FIELD 1; never match the whole prefix.
//
// THREE-VALUED, NOT BOOLEAN. 656 iMessage rows (0.18%) carry no chat_guid at
// all, and there is no way to know what they were. A boolean would silently
// assign them a side. 'unknown' lets each caller decide, and the two decisions
// are different: for CREDIT it must behave exactly as today (as direct, so no
// count moves), and for an ASSERTION about a room it must never qualify. That
// asymmetry is the whole reason for the third value, and `isRoom` below is how
// callers get it right without thinking about it.
//
// DERIVED, NEVER STORED. Writing is_group into iMessage meta would change every
// affected row's content_hash, and hermes deletes every claim whose source hash
// moved -- 964 of 994 claims, today. It would also split the corpus into new
// rows that carry the key and 345,190 that do not, which is the exact failure
// being fixed, reintroduced one row at a time. A full scan derives it in ~0.2s.

export const GROUP = 'group';
export const DIRECT = 'direct';
export const UNKNOWN = 'unknown';

// WhatsApp's own marker, for the rows where the connector did not write the
// boolean: a group jid ends in the broadcast suffix, a personal one does not.
// Checked against the 3,190 rows that DO carry is_group -- the two agree on all
// of them, so this is a fallback and not a second opinion.
const WA_GROUP_SUFFIX = '@g.us';

export function threadKind(row, meta) {
  const source = row?.source;
  const m = meta ?? {};

  if (source === 'whatsapp') {
    if (typeof m.is_group === 'boolean') return m.is_group ? GROUP : DIRECT;
    if (m.is_group === 1 || m.is_group === 0) return m.is_group === 1 ? GROUP : DIRECT;
    const handle = typeof m.chat_handle === 'string' ? m.chat_handle : '';
    if (handle) return handle.endsWith(WA_GROUP_SUFFIX) ? GROUP : DIRECT;
    return UNKNOWN;
  }

  if (source === 'imessage') {
    const guid = typeof m.chat_guid === 'string' ? m.chat_guid : '';
    // FIELD 1, not a prefix match. See the warning above.
    const marker = guid.split(';')[1];
    if (marker === '+') return GROUP;
    if (marker === '-') return DIRECT;
    return UNKNOWN;
  }

  // Mail, calendar, notes, linkedin, files, photos: none of them is a room in
  // this sense. A calendar event has attendees, which is co-attendance and is
  // modelled separately; it is not a thread with a marker.
  return DIRECT;
}

// "May I state that this happened in a room?"
//
// The safe question, and the one nearly every caller actually wants. UNKNOWN is
// deliberately false here: an assertion about a room must be earned, and 656
// rows cannot earn it. Callers that instead want "may I credit this as a private
// conversation" should compare against GROUP explicitly, so that the unknown
// rows keep behaving exactly as they do today.
export function isRoom(row, meta) {
  return threadKind(row, meta) === GROUP;
}

// WHO AN OUTBOUND MESSAGE WAS SENT TO, when Apple did not say.
//
// `message.handle_id` is NULL on most outbound iMessage rows, so `meta.handle`
// -- the field every consumer reads to answer "who is this row with" -- is
// missing on 109,380 one-to-one rows the owner sent. Every one of them is
// currently dropped on the floor, which is most of the owner's own side of their
// own conversations.
//
// The counterparty was never actually missing: a one-to-one guid is
// `<service>;-;<their handle>`, and the third field IS that handle. Checked
// against the rows that DO carry one: it agrees on 210,505 and differs on 5
// (0.002%, and those five are handle-format drift, not a different person).
//
// THE TRAP, and it is the reason this lives behind the group test rather than
// beside it: a GROUP guid's third field is an opaque room id like
// `chat488392016936725110`. Deriving from it without checking the marker first
// would mint 351 rooms as people, complete with message counts, and they would
// be indistinguishable from real contacts. 21,644 group rows have no handle and
// would each have taken the bait. So this returns null for anything that is not
// unambiguously a one-to-one thread -- UNKNOWN included, since a row with no
// guid has no third field to read anyway.
export function counterpartyFromThread(row, meta) {
  if (threadKind(row, meta) !== DIRECT) return null;
  if (row?.source !== 'imessage') return null;
  const guid = typeof meta?.chat_guid === 'string' ? meta.chat_guid : '';
  const parts = guid.split(';');
  if (parts.length < 3) return null;
  // rejoin: nothing in practice contains a ';', but an id that did would be
  // silently truncated, and a truncated identity is a wrong one.
  const id = parts.slice(2).join(';').trim();
  return id.length > 0 ? id : null;
}

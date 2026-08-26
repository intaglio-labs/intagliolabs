// Turning a Matrix /sync page into hermes rows. Pure: events in, rows out, so
// the whole mapping is testable without a homeserver.
//
// The bridges put every DM into a portal room and speak for the other person
// through a GHOST user — @facebook_<id>, @twitter_<id>, one namespace per
// bridge, declared in that bridge's own registration.yaml (read from there,
// not guessed). Three kinds of sender can appear in a room and only two of
// them are message content:
//
//   @you:hazlie.local        the owner, sending — source of `is_from_me`
//   @<platform>_<id>         a ghost: the person on the other side
//   @<platform>bot           the bridge's own management bot — NEVER a row.
//                            Its rooms are the login conversations, so its
//                            "messages" are prompts, errors, and once the
//                            owner's pasted cookies. Ingesting those would put
//                            a credential in the corpus.
//
// The platform prefix is also the row's `source`, which is what makes these
// rows join the people graph the same way iMessage and WhatsApp do.

// localpart prefix → the source name the rest of the system already uses.
// `facebook` is the Messenger bridge's ghost prefix (mautrix-meta); the row
// says `messenger` because that is the id the status page and the people graph
// know it by.
export const GHOST_SOURCE = Object.freeze({
  facebook: 'messenger',
  instagram: 'instagram',
  twitter: 'twitter',
  telegram: 'telegram',
  discord: 'discord',
  slack: 'slack',
  // Same source name the CSV export used, deliberately: every people-graph
  // join that already reads `linkedin` keeps working when the rows start
  // arriving as DMs instead (owner, 2026-08-25).
  linkedin: 'linkedin',
});

const OWNER = '@you:hazlie.local';

/** `@facebook_123:hazlie.local` → { source: 'messenger', handle: 'facebook_123' } */
export function classifySender(mxid) {
  if (typeof mxid !== 'string' || !mxid.startsWith('@')) return null;
  const localpart = mxid.slice(1).split(':')[0];
  if (mxid === OWNER) return { kind: 'owner' };
  // A bot is `<platform>bot` exactly; a ghost is `<platform>_<id>`. Checked
  // before the ghost split so `@slackbot` can never be read as a ghost.
  for (const prefix of Object.keys(GHOST_SOURCE)) {
    if (localpart === `${prefix}bot`) return { kind: 'bot', source: GHOST_SOURCE[prefix] };
  }
  const cut = localpart.indexOf('_');
  if (cut <= 0) return null;
  const source = GHOST_SOURCE[localpart.slice(0, cut)];
  if (!source) return null;
  return { kind: 'ghost', source, handle: localpart };
}

/**
 * One timeline event → a row, or null.
 *
 * `names` maps mxid → display name (from the room's own members), so a row
 * carries the person's real name rather than a numeric ghost id. Falls back to
 * the handle, never to nothing.
 */
export function eventToRow(event, { roomId, names = new Map(), selfName = 'me' } = {}) {
  if (!event || event.type !== 'm.room.message') return null;
  const content = event.content ?? {};
  // Text only. Attachments arrive as m.image/m.file with a body that is just a
  // filename — a row of "IMG_2044.jpg" is noise the graph would count as a
  // message. Notices are bot chatter by definition.
  if (content.msgtype !== 'm.text') return null;
  const text = typeof content.body === 'string' ? content.body.trim() : '';
  if (!text) return null;
  const eventId = typeof event.event_id === 'string' ? event.event_id : '';
  const ts = Number(event.origin_server_ts);
  if (!eventId || !Number.isFinite(ts)) return null;

  const who = classifySender(event.sender);
  if (!who || who.kind === 'bot') return null; // login transcripts never ingest

  // WHOSE ROOM IS THIS. When the owner sends, the sender says nothing about
  // the platform — the room does. `partner` is the ghost this room belongs to,
  // resolved by the caller from the room's members.
  const partner = event.__partner ?? null;
  const source = who.kind === 'ghost' ? who.source : partner?.source;
  if (!source) return null; // an owner message in a room with no ghost: not a DM

  const fromMe = who.kind === 'owner';
  const handle = who.kind === 'ghost' ? who.handle : partner?.handle;
  const speaker = fromMe
    ? selfName
    : (names.get(event.sender) || handle || null);

  return {
    ts,
    source,
    entity_id: `${source}:${eventId}`,
    speaker,
    text,
    meta: {
      event_id: eventId,
      room_id: roomId,
      is_from_me: fromMe,
      is_group: Boolean(event.__isGroup),
      // The join key for the people spine, same role as WhatsApp's
      // chat_handle: who this conversation is WITH, not who spoke.
      chat_handle: partner?.handle ?? handle ?? null,
      ...(partner && names.get(partner.mxid) ? { chat_name: names.get(partner.mxid) } : {}),
    },
  };
}

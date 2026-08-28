// WhatsApp Desktop's ChatStorage.sqlite → hermes rows. Pure — no clock, no
// I/O — so every branch is assertable against a synthetic store.
//
// Schema facts, derived by ops/probes/probe-whatsapp.mjs:
//
//   ZWAMESSAGE      one row per message. ZTEXT (nullable — media has none),
//                   ZISFROMME, ZMESSAGEDATE (Apple-epoch SECONDS, like
//                   Contacts/Photos), ZFROMJID (sender on received messages),
//                   ZCHATSESSION → ZWACHATSESSION.Z_PK, ZGROUPMEMBER, ZSTANZAID
//                   (the WhatsApp message id, our entity key), ZMESSAGETYPE
//                   (0 = text), ZGROUPEVENTTYPE (>0 = "X joined", not a message).
//   ZWACHATSESSION  ZCONTACTJID ('<phone>@s.whatsapp.net' for 1:1,
//                   '<id>@g.us' for groups), ZPARTNERNAME (display),
//                   ZSESSIONTYPE.
//   ZWAGROUPMEMBER  ZMEMBERJID, ZCONTACTNAME/ZFIRSTNAME — who spoke in a group.
//
// A JID's node (before '@') is a phone number for s.whatsapp.net, which is
// why normalizing it to +E164 makes WhatsApp handles collide with iMessage
// handles and the contacts spine. `lid` and `broadcast` JIDs are not phone
// numbers and are kept verbatim.

const APPLE_EPOCH_MS = 978307200000;

export function appleSecondsToMs(sec) {
  // ABSENT INPUT MUST BE NaN, NOT THE EPOCH ITSELF.
  //
  // `Number(null)` and `Number('')` are both 0, and 0 apple-seconds is
  // 2001-01-01 — a plausible-looking date rather than an obvious failure. So a
  // message with a NULL ZMESSAGEDATE passed messageToRow's
  // `Number.isFinite(ts)` guard and was ingested, dated twenty-five years ago,
  // indistinguishable from a real row once it was in the store. A wrong date
  // that looks real is worse than no row.
  //
  // Latent rather than live when found (2026-08-22): the owner's store has 0
  // NULL and 0 zero timestamps. Fixed because the guard is supposed to catch
  // exactly this, and because WhatsApp Desktop prunes and rewrites its store,
  // so "no NULLs today" is not a property anything maintains.
  if (sec === null || sec === undefined || sec === '') return NaN;
  const n = Number(sec);
  return Number.isFinite(n) ? Math.round(n * 1000) + APPLE_EPOCH_MS : NaN;
}

// '18085550100@s.whatsapp.net' → '+18085550100' so it matches iMessage
// handles and the spine. Non-phone JIDs (@g.us, @lid, @broadcast) pass
// through as-is: they are real identifiers, just not phone numbers.
export function jidToHandle(jid) {
  const s = String(jid ?? '');
  const at = s.indexOf('@');
  if (at === -1) return s || null;
  const node = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (domain !== 's.whatsapp.net') return s;
  const digits = node.replace(/\D/gu, '');
  if (digits.length < 7) return s;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export function isRealMessage(row) {
  // NON-EMPTY ZTEXT IS THE WHOLE TEST. ZGROUPEVENTTYPE was assumed to flag
  // group events ("<person> added <person>") and it does NOT on this WhatsApp
  // version — value 2 is the ordinary value on real messages, so keying off
  // it dropped nearly every row on a private test store. Media rows carry no
  // ZTEXT and a caption-less photo is not a
  // claim, the same call the iMessage connector makes; a rare system line
  // that does carry text is harmless (excluded from claims anyway) and not
  // worth a fragile type table to chase.
  return typeof row?.ZTEXT === 'string' && row.ZTEXT.trim().length > 0;
}

// One db row (already joined to its session, and to a group member when the
// scan supplies one) → a hermes row, or null.
//
//   groupMember: { jid, name } | null — resolved by the caller from
//   ZWAGROUPMEMBER, because that join is per-row and the mapper stays pure.
export function messageToRow(row, { selfName = 'me', groupMember = null } = {}) {
  if (!isRealMessage(row)) return null;

  const stanza = typeof row?.ZSTANZAID === 'string' ? row.ZSTANZAID.trim() : '';
  // Fall back to the primary key when a message predates ZSTANZAID: still
  // stable within this store, which is all the entity id needs.
  const id = stanza || (row?.Z_PK != null ? `pk${row.Z_PK}` : '');
  if (!id) return null;

  const ts = appleSecondsToMs(row?.ZMESSAGEDATE);
  if (!Number.isFinite(ts)) return null;

  const fromMe = Number(row?.ZISFROMME ?? 0) === 1;
  const chatJid = typeof row?.chat_jid === 'string' ? row.chat_jid : null;
  const isGroup = chatJid?.endsWith('@g.us') ?? false;

  // Speaker: owner if from me; in a group the specific member; in 1:1 the
  // chat partner. Text attribution arriving with the data — the sanctioned
  // side of the no-voiceprints line, same as iMessage handles.
  let speaker;
  if (fromMe) speaker = selfName;
  else if (isGroup && groupMember) speaker = groupMember.name || jidToHandle(groupMember.jid);
  else speaker = jidToHandle(row?.ZFROMJID) ?? jidToHandle(chatJid) ?? null;

  return {
    ts,
    source: 'whatsapp',
    entity_id: `whatsapp:${id}`,
    speaker,
    text: row.ZTEXT.trim(),
    meta: {
      stanza_id: id,
      is_from_me: fromMe,
      is_group: isGroup,
      // The join key for the spine, normalized like every other handle.
      chat_handle: jidToHandle(chatJid),
      ...(typeof row?.chat_name === 'string' && row.chat_name ? { chat_name: row.chat_name } : {}),
      ...(isGroup && !fromMe && groupMember
        ? { sender_handle: jidToHandle(groupMember.jid) }
        : {}),
    },
  };
}

export function messagesToRows(dbRows, { selfName = 'me', memberFor = null } = {}) {
  const rows = [];
  let skipped = 0;
  for (const r of dbRows ?? []) {
    const gm = memberFor && r?.ZGROUPMEMBER != null ? memberFor(r.ZGROUPMEMBER) : null;
    const row = messageToRow(r, { selfName, groupMember: gm });
    if (row === null) skipped += 1;
    else rows.push(row);
  }
  return { rows, skipped };
}

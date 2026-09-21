// chat.db message → hermes context row. Pure: no I/O, no clock.
//
// Apple epoch: message.date is NANOSECONDS since 2001-01-01 on current macOS
// and EXCEEDS 2^53, so any statement touching it needs setReadBigInts(true) —
// the probe failed loudly on exactly this before the fix (ops/PROBES.md). Rows
// written by very old macOS versions still carry seconds; nine orders of
// magnitude separate the two encodings, so a threshold cannot misfile them.

import { messageText, hasAttachmentPlaceholder } from './attributedBody.mjs';

export const APPLE_EPOCH_MS = 978307200000;

export function appleDateToMs(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v === 0) return NaN;
  return v > 1e12 ? v / 1e6 + APPLE_EPOCH_MS : v * 1000 + APPLE_EPOCH_MS;
}

// item_type 0 is a real message. Everything else is a chat event — someone
// joined, someone left, the group name changed — and none of it is
// conversation. associated_message_type marks tapbacks and edits, which
// attach to another message rather than standing alone.
export function isRealMessage(row) {
  if (Number(row?.item_type ?? 0) !== 0) return false;
  if (Number(row?.associated_message_type ?? 0) !== 0) return false;
  return true;
}

// THE SELF-ECHO FILTER, and the reason this function exists.
//
// A self-thread records every message TWICE — once is_from_me=1 as this Mac
// sending, once is_from_me=0 as the account receiving, ~140 ms apart with
// identical text (measured 2026-08-19). Ingesting both would double every
// message Intaglio Labs ever sent, and any future inbound watcher that treats
// is_from_me=0 as "the owner said something" would answer its own digest
// forever. The received copy of an outbound message is an artefact of how
// Apple records self-sends, not a second event.
//
// Keyed on guid: the two copies carry DIFFERENT guids, so dedupe is by
// (text, chat, ~timestamp) rather than by id.
export function dropSelfEchoes(rows, { windowMs = 5000 } = {}) {
  const kept = [];
  const recentOutbound = [];
  for (const row of rows) {
    if (row.meta.is_from_me) {
      recentOutbound.push(row);
      kept.push(row);
      continue;
    }
    const echo = recentOutbound.some(
      (out) =>
        out.text === row.text &&
        out.meta.chat_guid === row.meta.chat_guid &&
        Math.abs(out.ts - row.ts) <= windowMs
    );
    if (!echo) kept.push(row);
  }
  return kept;
}

export function messageToRow(row, { selfName = 'me', excludeChatGuids = [] } = {}) {
  if (!isRealMessage(row)) return null;

  // The pinned Intaglio Labs thread never becomes a corpus row. SKIPPED, not
  // relabelled: the energy digest that closed this loop on 2026-08-19 was
  // relabel-proof, because the courier sent it and chat.db handed it back as
  // an ordinary owner-authored message. The only durable fact is which thread
  // it lives in, and the cheapest correct thing to do with a conversation
  // between the owner and Intaglio Labs is to not record it at all. Nothing
  // downstream has to be clever if the row never exists.
  const chatGuid = typeof row?.chat_guid === 'string' ? row.chat_guid : null;
  if (chatGuid !== null && excludeChatGuids.includes(chatGuid)) return null;

  const guid = typeof row?.guid === 'string' ? row.guid.trim() : '';
  if (!guid) return null;

  const ts = appleDateToMs(row?.date);
  if (!Number.isFinite(ts)) return null;

  const text = messageText({ text: row?.text, attributedBody: row?.attributedBody });
  // An attachment with no caption carries no text to reason over. Recording it
  // as an empty row would inflate every count the digest makes.
  if (typeof text !== 'string' || text.trim().length === 0) return null;

  const fromMe = Number(row?.is_from_me ?? 0) === 1;
  const handle = typeof row?.handle_id_value === 'string' ? row.handle_id_value : null;

  return {
    ts,
    source: 'imessage',
    entity_id: `imessage:${guid}`,
    // The sender's handle is text attribution arriving with the data — the
    // sanctioned side of the no-voiceprints line, same as granola's.
    speaker: fromMe ? selfName : handle,
    text: text.trim(),
    meta: {
      guid,
      chat_guid: typeof row?.chat_guid === 'string' ? row.chat_guid : null,
      is_from_me: fromMe,
      handle,
      service: typeof row?.service === 'string' ? row.service : null,
      ...(hasAttachmentPlaceholder(row?.attributedBody) ? { has_attachment: true } : {}),
      ...(typeof row?.reply_to_guid === 'string' && row.reply_to_guid
        ? { reply_to: row.reply_to_guid }
        : {}),
    },
  };
}

// TAPBACKS, TALLIED (ingestion round one, 2026-09-20). isRealMessage rejects
// every row with a nonzero associated_message_type, which is right for the
// corpus -- a heart on a message is not a message -- and wrong for the
// relationship: it is the cheapest warmth signal there is. Types 2000..2005
// are the six tapbacks being ADDED (love, like, dislike, laugh, emphasis,
// question); 3000..3005 are the same six being removed and are not counted.
// Counted per chat and direction, never stored as rows. Pure, for the test.
export const TAPBACK_ADD_MIN = 2000;
export const TAPBACK_ADD_MAX = 2005;
export function tallyReactions(dbRows) {
  const tallies = new Map();
  for (const r of dbRows ?? []) {
    const t = Number(r?.associated_message_type ?? 0);
    if (t < TAPBACK_ADD_MIN || t > TAPBACK_ADD_MAX) continue;
    const chat = typeof r?.chat_guid === 'string' && r.chat_guid ? r.chat_guid : null;
    if (!chat) continue;
    const key = `${chat}|${Number(r?.is_from_me ?? 0) === 1 ? 1 : 0}`;
    tallies.set(key, (tallies.get(key) ?? 0) + 1);
  }
  return tallies;
}

export function messagesToRows(dbRows, { selfName = 'me', excludeChatGuids = [] } = {}) {
  const mapped = [];
  let skipped = 0;
  for (const r of dbRows ?? []) {
    const row = messageToRow(r, { selfName, excludeChatGuids });
    if (row === null) skipped += 1;
    else mapped.push(row);
  }
  const kept = dropSelfEchoes(mapped);
  return { rows: kept, skipped: skipped + (mapped.length - kept.length) };
}

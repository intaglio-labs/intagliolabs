// An Apple Note → a hermes context row. Pure: no I/O, no clock.

import { decodeNoteBody } from './noteBody.mjs';

export const APPLE_EPOCH_MS = 978307200000;

// Core Data seconds since 2001 — the same encoding Photos uses, and NOT the
// nanoseconds chat.db uses.
export function appleSecondsToMs(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v === 0) return NaN;
  return v * 1000 + APPLE_EPOCH_MS;
}

// Apple derives a note's title from its first line, so title and body almost
// always begin with the same words. Repeating it would make every row start
// with a stutter and would weight that line twice in any later search.
export function composeText(title, body) {
  const t = typeof title === 'string' ? title.trim() : '';
  const b = typeof body === 'string' ? body.trim() : '';
  if (!b) return t;
  if (!t) return b;
  const firstLine = b.split('\n', 1)[0].trim();
  if (firstLine === t) return b;
  return `${t}\n\n${b}`;
}

export function noteToRow(row) {
  const id = typeof row?.ZIDENTIFIER === 'string' ? row.ZIDENTIFIER.trim() : '';
  if (!id) return null;

  // ts is the MODIFICATION time: a note's place in the timeline is when the
  // owner last worked on it, not when they first opened it. Creation is kept
  // in meta so the original date is not lost.
  const modified = appleSecondsToMs(row?.ZMODIFICATIONDATE1);
  const created = appleSecondsToMs(row?.ZCREATIONDATE1);
  const ts = Number.isFinite(modified) ? modified : created;
  if (!Number.isFinite(ts)) return null;

  const body = decodeNoteBody(row?.body);
  const title = typeof row?.ZTITLE1 === 'string' ? row.ZTITLE1.trim() : '';
  const text = composeText(title, body);
  // A note with neither a title nor a decodable body carries nothing to
  // search. Better absent than an empty row inflating every count.
  if (!text) return null;

  const folder = typeof row?.folder === 'string' ? row.folder.trim() : '';

  return {
    ts,
    source: 'notes',
    // A note has no speaker in the way a message does — but it does have an
    // author, and it is always the owner. Left null rather than inventing a
    // name the owner never typed.
    speaker: null,
    entity_id: `notes:${id}`,
    text,
    meta: {
      note_id: id,
      ...(title ? { title } : {}),
      ...(folder ? { folder } : {}),
      ...(Number.isFinite(created) ? { created_ms: created } : {}),
      ...(body ? { chars: body.length } : { body_undecoded: true }),
    },
  };
}

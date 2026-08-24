// Decode an Apple Notes body: gzip → protobuf → the note's text.
//
// ZICNOTEDATA.ZDATA is gzip (magic 1f8b), and node's zlib reads that with no
// dependency. What is inside is a protobuf, and this walks it properly rather
// than scraping printable runs out of the bytes.
//
// WHY A REAL WALK AND NOT A HEURISTIC. A first probe pulled the longest
// printable stretch out of the decompressed bytes, and it "worked" — six
// notes, six different results. But that approach cannot tell note text from
// a table cell, an attachment filename or a style run, so it silently mangles
// exactly the notes with the most structure. The photos OCR taught the same
// lesson more expensively: an extractor that returns SOMETHING for every
// input looks identical to one that returns the right thing, until you
// compare across inputs.
//
// The path through the message is document(2) → note(3) → noteText(2), each a
// length-delimited field. Only those three are followed; everything else is
// skipped by length, so an unknown field cannot derail the read.

import { gunzipSync } from 'node:zlib';

const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_LEN = 2;
const WIRE_32 = 5;

// Protobuf varints are little-endian 7-bit groups with a continuation bit.
// Bounded at 10 bytes: a longer run is corrupt, and without the bound a
// malformed blob spins here.
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  while (i < buf.length && i - pos < 10) {
    const byte = buf[i];
    result |= BigInt(byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) return { value: result, next: i };
    shift += 7n;
  }
  return null;
}

// Yields {field, wire, start, end} for each field at this level, skipping
// payloads it does not need. Returns null on a malformed run rather than
// throwing, because one bad note must not fail an ingest of 591.
export function* walkFields(buf, from = 0, to = buf.length) {
  let pos = from;
  while (pos < to) {
    const key = readVarint(buf, pos);
    if (key === null) return;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    pos = key.next;

    if (wire === WIRE_LEN) {
      const len = readVarint(buf, pos);
      if (len === null) return;
      const start = len.next;
      const end = start + Number(len.value);
      if (end > to) return;
      yield { field, wire, start, end };
      pos = end;
    } else if (wire === WIRE_VARINT) {
      const v = readVarint(buf, pos);
      if (v === null) return;
      yield { field, wire, value: v.value };
      pos = v.next;
    } else if (wire === WIRE_64) {
      pos += 8;
    } else if (wire === WIRE_32) {
      pos += 4;
    } else {
      return; // groups: not used by this format, and not worth guessing at
    }
  }
}

function firstLenField(buf, from, to, field) {
  for (const f of walkFields(buf, from, to)) {
    if (f.field === field && f.wire === WIRE_LEN) return f;
  }
  return null;
}

// Apple marks attachments with U+FFFC and breaks lines with U+2028/U+2029.
// Left in, the first renders as a box mid-sentence and the others break naive
// line handling downstream. Written as escapes, not literals: U+2028 IS a line
// terminator in JS source, so a literal one splits the regex across lines and
// the file stops parsing.
function normalize(text) {
  return text
    .replace(/\uFFFC/gu, '')
    .replace(/[\u2028\u2029]/gu, '\n')
    .replace(/\r\n?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function decodeNoteBody(blob, { maxChars = 20000 } = {}) {
  if (!blob) return null;
  const gz = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) return null;

  let buf;
  try {
    // Bounded like every other step in this parser: gzip reaches ~1000:1, so
    // without a ceiling a corrupt or hostile ZDATA of a few tens of MB
    // expands to tens of GB and kills the daemon before the maxChars cap
    // below ever runs — and the cursor would re-decode the same blob every
    // pass. 8 MiB is far above any real note; overflow throws
    // ERR_BUFFER_TOO_LARGE, which the catch turns into the null skip.
    buf = gunzipSync(gz, { maxOutputLength: 8 * 1024 * 1024 });
  } catch {
    return null;
  }

  // document(2) → note(3) → noteText(2)
  const document = firstLenField(buf, 0, buf.length, 2);
  if (!document) return null;
  const note = firstLenField(buf, document.start, document.end, 3);
  if (!note) return null;
  const noteText = firstLenField(buf, note.start, note.end, 2);
  if (!noteText) return null;

  const text = normalize(buf.subarray(noteText.start, noteText.end).toString('utf8'));
  if (!text) return null;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

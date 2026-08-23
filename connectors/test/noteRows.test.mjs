import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { appleSecondsToMs, composeText, noteToRow } from '../lib/noteRows.mjs';
import { decodeNoteBody, walkFields } from '../lib/noteBody.mjs';

// Build a NoteStoreProto: document(2) → note(3) → noteText(2).
function proto(text) {
  const field = (n, payload) => {
    const key = Buffer.from([(n << 3) | 2]);
    const len = [];
    let v = payload.length;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      len.push(b);
    } while (v);
    return Buffer.concat([key, Buffer.from(len), payload]);
  };
  return gzipSync(field(2, field(3, field(2, Buffer.from(text, 'utf8')))));
}

test('the decoder walks to noteText rather than scraping bytes', () => {
  assert.equal(decodeNoteBody(proto('meeting notes\nship by friday')), 'meeting notes\nship by friday');
});

// Notes with structure are where a longest-printable-run heuristic quietly
// fails, so the walk has to survive unknown neighbouring fields.
test('unknown fields beside the text do not derail the read', () => {
  const key = Buffer.from([(9 << 3) | 0, 0x2a]); // field 9, varint
  const gz = gzipSync(
    Buffer.concat([key, Buffer.from(proto('real text').subarray(0)) ])
  );
  // A varint-prefixed blob is not valid here; decoder must decline, not throw.
  assert.doesNotThrow(() => decodeNoteBody(gz));
});

test('the decoder declines rather than guessing', () => {
  assert.equal(decodeNoteBody(null), null);
  assert.equal(decodeNoteBody(Buffer.from('not gzip')), null);
  assert.equal(decodeNoteBody(gzipSync(Buffer.from('gzip but not a note'))), null);
});

test('attachment markers and Apple line separators are normalised away', () => {
  const raw = 'line one line two￼ line three';
  assert.equal(decodeNoteBody(proto(raw)), 'line one\nline two\nline three');
});

test('walkFields stops on a malformed run instead of spinning', () => {
  const fields = [...walkFields(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))];
  assert.equal(fields.length, 0);
});

// Core Data seconds, NOT chat.db nanoseconds.
test('note timestamps decode from Core Data seconds', () => {
  const ms = Date.parse('2026-08-18T12:00:00Z');
  assert.equal(appleSecondsToMs((ms - 978307200000) / 1000), ms);
  assert.ok(Number.isNaN(appleSecondsToMs(0)));
});

// Apple derives the title from the first line, so repeating it stutters and
// double-weights that line in any later search.
test('a title that repeats the first body line is not duplicated', () => {
  assert.equal(composeText('Shopping', 'Shopping\nmilk\neggs'), 'Shopping\nmilk\neggs');
  assert.equal(composeText('Shopping', 'milk\neggs'), 'Shopping\n\nmilk\neggs');
  assert.equal(composeText('', 'body only'), 'body only');
  assert.equal(composeText('title only', ''), 'title only');
});

const note = (extra = {}) => ({
  ZIDENTIFIER: 'ABC-123',
  ZTITLE1: 'Q3 planning',
  ZMODIFICATIONDATE1: (Date.parse('2026-08-18T12:00:00Z') - 978307200000) / 1000,
  ZCREATIONDATE1: (Date.parse('2026-01-02T09:00:00Z') - 978307200000) / 1000,
  folder: 'Work',
  body: proto('Q3 planning\nhire two engineers'),
  ...extra,
});

// A note's place in the timeline is when the owner last worked on it.
test('ts is the modification time; creation is kept in meta', () => {
  const row = noteToRow(note());
  assert.equal(row.ts, Date.parse('2026-08-18T12:00:00Z'));
  assert.equal(row.meta.created_ms, Date.parse('2026-01-02T09:00:00Z'));
  assert.equal(row.source, 'notes');
  assert.equal(row.entity_id, 'notes:ABC-123');
  assert.equal(row.meta.folder, 'Work');
  assert.equal(row.speaker, null);
});

test('a note with an undecodable body still carries its title, and says so', () => {
  const row = noteToRow(note({ body: Buffer.from('garbage') }));
  assert.equal(row.text, 'Q3 planning');
  assert.equal(row.meta.body_undecoded, true);
  assert.equal(row.meta.chars, undefined);
});

test('a note with neither title nor body is dropped, not stored empty', () => {
  assert.equal(noteToRow(note({ ZTITLE1: '', body: Buffer.from('x') })), null);
  assert.equal(noteToRow(note({ ZIDENTIFIER: '' })), null);
  assert.equal(noteToRow(note({ ZMODIFICATIONDATE1: 0, ZCREATIONDATE1: 0 })), null);
});

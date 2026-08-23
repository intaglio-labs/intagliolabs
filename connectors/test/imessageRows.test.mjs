import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAttributedBody, messageText } from '../lib/attributedBody.mjs';
import {
  appleDateToMs,
  dropSelfEchoes,
  isRealMessage,
  messageToRow,
  messagesToRows,
} from '../lib/imessageRows.mjs';
import { scanFloor } from '../sources/imessage.mjs';

// Build a minimal typedstream blob of the shape Messages writes.
function blob(text, { attachment = false } = {}) {
  const body = Buffer.from((attachment ? '￼' : '') + text, 'utf8');
  const head = Buffer.from('\x04\x0bstreamtyped\x81\x00\x00NSString\x01\x94\x84\x01', 'latin1');
  const len =
    body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.concat([Buffer.from([0x81]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(body.length); return b; })()]);
  return Buffer.concat([head, Buffer.from([0x2b]), len, body]);
}

// 97% of messages on the dev seed store text ONLY here. A reader trusting
// message.text captures 2% of the corpus and looks like it works.
test('the decoder reads short and long strings out of a typedstream blob', () => {
  assert.equal(decodeAttributedBody(blob('hello')), 'hello');
  const long = 'x'.repeat(900);
  assert.equal(decodeAttributedBody(blob(long)), long);
});

// U+FFFC marks an attachment; message.text omits it. Keeping it made the
// decoder disagree with text on 90 of 4000 real rows — a semantic bug, not a
// parsing one.
test('attachment placeholders are stripped, not stored mid-sentence', () => {
  assert.equal(decodeAttributedBody(blob('caption', { attachment: true })), 'caption');
  assert.equal(decodeAttributedBody(blob('', { attachment: true })), null, 'placeholder only → no text');
});

test('the decoder declines rather than guessing', () => {
  assert.equal(decodeAttributedBody(null), null);
  assert.equal(decodeAttributedBody(Buffer.alloc(0)), null);
  assert.equal(decodeAttributedBody(Buffer.from('no class name here')), null);
});

test('plain text wins when present, blob is the fallback', () => {
  assert.equal(messageText({ text: 'plain', attributedBody: blob('blob') }), 'plain');
  assert.equal(messageText({ text: '', attributedBody: blob('blob') }), 'blob');
  assert.equal(messageText({ text: null, attributedBody: null }), null);
});

// Nanoseconds since 2001, exceeding 2^53. Seconds-encoded rows from ancient
// macOS still exist; nine orders of magnitude separate them.
test('apple dates decode from both nanosecond and second encodings', () => {
  const ms = Date.parse('2026-08-18T12:00:00Z');
  const nanos = (ms - 978307200000) * 1e6;
  assert.equal(appleDateToMs(nanos), ms);
  assert.equal(appleDateToMs((ms - 978307200000) / 1000), ms);
  assert.ok(Number.isNaN(appleDateToMs(0)));
});

test('chat events and tapbacks are not conversation', () => {
  assert.equal(isRealMessage({ item_type: 0, associated_message_type: 0 }), true);
  assert.equal(isRealMessage({ item_type: 1 }), false, 'someone joined the group');
  assert.equal(isRealMessage({ item_type: 0, associated_message_type: 2000 }), false, 'tapback');
});

const raw = (extra = {}) => ({
  guid: 'G1',
  text: 'hi there',
  date: (Date.parse('2026-08-18T12:00:00Z') - 978307200000) * 1e6,
  is_from_me: 0,
  item_type: 0,
  associated_message_type: 0,
  handle_id_value: '+15555550123',
  chat_guid: 'iMessage;-;+15555550123',
  service: 'iMessage',
  ...extra,
});

test('a received message maps to a hermes row', () => {
  const row = messageToRow(raw());
  assert.equal(row.source, 'imessage');
  assert.equal(row.entity_id, 'imessage:G1');
  assert.equal(row.speaker, '+15555550123');
  assert.equal(row.text, 'hi there');
  assert.equal(row.meta.is_from_me, false);
});

test('an outbound message is attributed to the owner, not a handle', () => {
  const row = messageToRow(raw({ is_from_me: 1 }), { selfName: 'Austin' });
  assert.equal(row.speaker, 'Austin');
  assert.equal(row.meta.is_from_me, true);
});

// THE INGESTION HALF OF THE 2026-08-19 LOOP. The courier sent this text into
// the pinned thread, chat.db handed it back on the next scan, and it entered
// the corpus as an ordinary owner-authored message — which is exactly what it
// looks like at this layer. The fixture is the real specimen (live store id
// 12389) so the test can fail the way the system actually failed.
const DIGEST_SPECIMEN = [
  '📈 energy up',
  '— averaged 8.4h a night across 6 nights',
  '— slept 8h+ on 4 of 6 nights',
  '— 8,229 steps a day on average',
  '— HRV averaged 23ms',
].join('\n');

const PINNED = 'any;-;austiny808@gmail.com';

test('the pinned Hazlie thread never becomes a corpus row', () => {
  const digest = raw({ guid: 'D1', text: DIGEST_SPECIMEN, is_from_me: 1, chat_guid: PINNED });
  assert.equal(messageToRow(digest, { excludeChatGuids: [PINNED] }), null);

  // Both directions: the owner's own question to Hazlie is conversation with
  // Hazlie too, and `hz ask` would otherwise write every question into the
  // corpus the answer is drawn from.
  const question = raw({ guid: 'D2', text: 'hz ask what did i commit to', is_from_me: 1, chat_guid: PINNED });
  assert.equal(messageToRow(question, { excludeChatGuids: [PINNED] }), null);

  // Without the exclusion it sails through, which is the bug being pinned.
  assert.ok(messageToRow(digest, { excludeChatGuids: [] }) !== null);
});

test('messagesToRows counts pinned-thread messages as skipped, not ingested', () => {
  const rows = [
    raw({ guid: 'D1', text: DIGEST_SPECIMEN, is_from_me: 1, chat_guid: PINNED }),
    raw({ guid: 'K1', text: 'see you at six', is_from_me: 1, chat_guid: 'iMessage;-;+15555550123' }),
  ];
  const out = messagesToRows(rows, { excludeChatGuids: [PINNED] });
  assert.deepEqual(out.rows.map((r) => r.entity_id), ['imessage:K1']);
  assert.equal(out.skipped, 1);
});

test('an attachment with no caption is not an empty row', () => {
  assert.equal(messageToRow(raw({ text: '   ', attributedBody: null })), null);
  assert.equal(messageToRow(raw({ text: null, attributedBody: null })), null);
});

// THE SELF-ECHO TEST. A self-thread records every send twice — is_from_me=1
// and is_from_me=0, ~140 ms apart, identical text, different guids. Ingesting
// both doubles everything Hazlie ever sent.
test('the received copy of a self-sent message is dropped', () => {
  const t = Date.parse('2026-08-18T12:00:00Z');
  const out = { ts: t, text: 'digest', meta: { is_from_me: true, chat_guid: 'C' } };
  const echo = { ts: t + 140, text: 'digest', meta: { is_from_me: false, chat_guid: 'C' } };
  assert.deepEqual(dropSelfEchoes([out, echo]), [out]);
});

test('a genuine reply with the same words is NOT dropped', () => {
  const t = Date.parse('2026-08-18T12:00:00Z');
  const out = { ts: t, text: 'ok', meta: { is_from_me: true, chat_guid: 'C' } };
  // Same text, but hours later — a real message, not an echo.
  const later = { ts: t + 3_600_000, text: 'ok', meta: { is_from_me: false, chat_guid: 'C' } };
  assert.equal(dropSelfEchoes([out, later]).length, 2);
  // Same text and instant, but a different conversation.
  const other = { ts: t + 100, text: 'ok', meta: { is_from_me: false, chat_guid: 'OTHER' } };
  assert.equal(dropSelfEchoes([out, other]).length, 2);
});

test('messagesToRows counts what it dropped', () => {
  const { rows, skipped } = messagesToRows([raw(), raw({ guid: 'G2', item_type: 1 })]);
  assert.equal(rows.length, 1);
  assert.equal(skipped, 1);
});

// The cursor is Apple nanoseconds, above 2^53, so it must stay a string/BigInt
// and never round-trip through a JS number.
test('the scan floor resumes from the cursor and falls back to a date window', () => {
  const resumed = scanFloor({ storedCursor: '790000000000000000', backfill: false, nowMs: 0, backfillDays: 90 });
  assert.equal(resumed.appleNanos, 790000000000000000n);
  assert.equal(resumed.reason, 'cursor');

  const fresh = scanFloor({ storedCursor: undefined, backfill: false, nowMs: Date.parse('2026-08-19T00:00:00Z'), backfillDays: 1 });
  assert.equal(fresh.reason, 'no-cursor');
  assert.equal(typeof fresh.appleNanos, 'bigint');

  const forced = scanFloor({ storedCursor: '790000000000000000', backfill: true, nowMs: Date.parse('2026-08-19T00:00:00Z'), backfillDays: 1 });
  assert.equal(forced.reason, 'backfill', 'backfill ignores the cursor');
});

test('a corrupt cursor falls back to the window instead of resuming from garbage', () => {
  for (const bad of ['', 'abc', '12.5', null]) {
    assert.equal(
      scanFloor({ storedCursor: bad, backfill: false, nowMs: Date.parse('2026-08-19T00:00:00Z'), backfillDays: 1 }).reason,
      'no-cursor'
    );
  }
});

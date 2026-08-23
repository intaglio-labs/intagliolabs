import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampBody,
  mailEntityId,
  messageToRow,
  normalizeAddresses,
  normalizeMessageId,
  stripQuotedReply,
} from '../lib/mailRows.mjs';

const parsed = (extra = {}) => ({
  messageId: '<abc123@Mail.Example.COM>',
  date: new Date('2026-08-18T09:00:00Z'),
  from: { value: [{ address: 'Sender@Example.com' }] },
  to: { value: [{ address: 'me@here.io' }] },
  subject: 'Quarterly numbers',
  text: 'The numbers are attached.',
  ...extra,
});

// Only the local part is case-sensitive per RFC 5322. A server that rewrites
// the host case must not mint a second id for the same message.
test('the host part of a Message-ID is lowercased, the local part is not', () => {
  assert.equal(normalizeMessageId('<AbC@Mail.Example.COM>'), 'AbC@mail.example.com');
  assert.equal(normalizeMessageId('  <x@y.z>  '), 'x@y.z');
  assert.equal(normalizeMessageId('no-angle@brackets.com'), 'no-angle@brackets.com');
  assert.equal(normalizeMessageId(''), null);
  assert.equal(normalizeMessageId(null), null);
});

// Not decoration: drafts and some automated senders omit Message-ID entirely.
test('a message with no Message-ID falls back to account:folder:validity:uid', () => {
  assert.equal(
    mailEntityId({ messageId: null, account: 'a@b.co', folder: 'INBOX', uidValidity: 7, uid: 42 }),
    'mail:a@b.co:INBOX:7:42'
  );
  assert.equal(mailEntityId({ messageId: '<z@Q.com>' }), 'mail:z@q.com');
  // Neither an id nor enough to build a fallback → no id at all.
  assert.equal(mailEntityId({ messageId: null, account: 'a@b.co' }), null);
});

// An unstable recipient order would look like an edit and churn an update
// through hermes for a message that never changed.
test('addresses are lowercased, de-duplicated and sorted', () => {
  const value = { value: [{ address: 'Zed@X.com' }, { address: 'amy@x.com' }, { address: 'ZED@x.com' }] };
  assert.deepEqual(normalizeAddresses(value), ['amy@x.com', 'zed@x.com']);
  assert.deepEqual(normalizeAddresses(undefined), []);
});

test('the body cap counts bytes and never splits a character', () => {
  const ascii = clampBody('x'.repeat(100), 10);
  assert.equal(ascii.text.length, 10);
  assert.equal(ascii.truncated, true);

  // 'é' is 2 bytes: a naive character slice would overshoot the byte budget.
  const multi = clampBody('é'.repeat(50), 11);
  assert.ok(Buffer.from(multi.text, 'utf8').length <= 11);
  assert.ok(!multi.text.includes('�'), 'must not leave half a character');

  assert.deepEqual(clampBody('short', 100), { text: 'short', truncated: false });
});

test('quoted history is cut, because it is already ingested as its own message', () => {
  const body = 'My actual reply.\n\nOn Tue, someone wrote:\n> the whole prior thread';
  assert.equal(stripQuotedReply(body), 'My actual reply.');
  assert.equal(stripQuotedReply('Body\n\n--\nSignature block'), 'Body');
  assert.equal(stripQuotedReply('no quote here'), 'no quote here');
});

test('a normal message maps to a hermes row', () => {
  const row = messageToRow(parsed(), { account: 'me@here.io', folder: 'INBOX', uid: 9, uidValidity: '3' });
  assert.equal(row.source, 'mail');
  assert.equal(row.entity_id, 'mail:abc123@mail.example.com');
  assert.equal(row.ts, Date.parse('2026-08-18T09:00:00Z'));
  assert.equal(row.speaker, 'sender@example.com');
  assert.ok(row.text.startsWith('"Quarterly numbers"'));
  assert.deepEqual(row.meta.to, ['me@here.io']);
  assert.equal(row.meta.folder, 'INBOX');
  assert.equal(row.meta.uid, 9);
});

// A message that lands at "now" silently backdates the corpus toward scan time.
test('a message with no usable date is dropped, not stamped with now', () => {
  assert.equal(messageToRow(parsed({ date: undefined }), { account: 'a', folder: 'f', uid: 1, uidValidity: '1' }), null);
  assert.equal(messageToRow(parsed({ date: 'not a date' }), { account: 'a', folder: 'f', uid: 1, uidValidity: '1' }), null);
});

test('an un-keyable message is dropped rather than re-inserted every scan', () => {
  assert.equal(messageToRow(parsed({ messageId: null }), {}), null);
});

test('a subject-only message still produces a row', () => {
  const row = messageToRow(parsed({ text: '' }), { account: 'a', folder: 'f', uid: 1, uidValidity: '1' });
  assert.equal(row.text, '"Quarterly numbers"');
});

test('a message with neither subject nor body is labelled, not blank', () => {
  const row = messageToRow(parsed({ text: '', subject: '' }), { account: 'a', folder: 'f', uid: 1, uidValidity: '1' });
  assert.equal(row.text, '(no subject)');
});

test('truncation is recorded in meta so a short row is not mistaken for a short email', () => {
  const row = messageToRow(parsed({ text: 'y'.repeat(50_000) }), {
    account: 'a',
    folder: 'f',
    uid: 1,
    uidValidity: '1',
    maxBodyBytes: 100,
  });
  assert.equal(row.meta.truncated, true);
  const short = messageToRow(parsed(), { account: 'a', folder: 'f', uid: 1, uidValidity: '1' });
  assert.equal(short.meta.truncated, undefined);
});

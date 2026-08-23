// Tests for the WhatsApp row mapper, plus the source's capped-scan cursor
// rule (run against a synthetic store). Fixtures mirror the measured schema:
// Apple-epoch-second dates, phone JIDs at @s.whatsapp.net, group JIDs at
// @g.us, group events with ZGROUPEVENTTYPE, sender via ZFROMJID (1:1) or a
// resolved group member.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatStoragePath, createWhatsappSource } from '../sources/whatsapp.mjs';
import {
  appleSecondsToMs,
  jidToHandle,
  isRealMessage,
  messageToRow,
  messagesToRows,
} from '../lib/whatsappRows.mjs';

test('apple-second dates convert to epoch ms', () => {
  // 2001-01-01 is second 0.
  assert.equal(appleSecondsToMs(0), 978307200000);
  assert.equal(Number.isNaN(appleSecondsToMs('x')), true);
});

test('phone JIDs normalize to +E164; non-phone JIDs pass through', () => {
  assert.equal(jidToHandle('18085550100@s.whatsapp.net'), '+18085550100');
  assert.equal(jidToHandle('8085550100@s.whatsapp.net'), '+18085550100');
  assert.equal(jidToHandle('120363000000000000@g.us'), '120363000000000000@g.us');
  assert.equal(jidToHandle('abc@lid'), 'abc@lid');
});

test('non-empty text is the whole message test; media is skipped', () => {
  assert.equal(isRealMessage({ ZTEXT: 'hi' }), true);
  // ZGROUPEVENTTYPE=2 is the ordinary value on real messages on this version
  // (the reason keying off it dropped everything), so a texted row with it
  // set is still a message.
  assert.equal(isRealMessage({ ZTEXT: 'lunch?', ZGROUPEVENTTYPE: 2 }), true);
  assert.equal(isRealMessage({ ZTEXT: null }), false, 'media has no text');
  assert.equal(isRealMessage({ ZTEXT: '   ' }), false);
});

const base = {
  Z_PK: 1,
  ZTEXT: 'lunch tomorrow?',
  ZISFROMME: 0,
  ZMESSAGEDATE: 700000000,
  ZSTANZAID: 'STANZA1',
  ZGROUPEVENTTYPE: 0,
  ZFROMJID: '18085550100@s.whatsapp.net',
  chat_jid: '18085550100@s.whatsapp.net',
  chat_name: 'Sam',
};

test('a 1:1 received message maps, sender from the JID', () => {
  const row = messageToRow(base);
  assert.equal(row.source, 'whatsapp');
  assert.equal(row.entity_id, 'whatsapp:STANZA1');
  assert.equal(row.speaker, '+18085550100');
  assert.equal(row.meta.is_group, false);
  assert.equal(row.meta.chat_handle, '+18085550100', 'the spine join key');
  assert.equal(row.meta.is_from_me, false);
});

test('an owner-sent message is attributed to the owner', () => {
  const row = messageToRow({ ...base, ZISFROMME: 1 }, { selfName: 'Austin' });
  assert.equal(row.speaker, 'Austin');
  assert.equal(row.meta.is_from_me, true);
});

test('a group message resolves the specific member as speaker', () => {
  const row = messageToRow(
    { ...base, chat_jid: '12036@g.us', ZGROUPMEMBER: 9 },
    { groupMember: { jid: '18085550999@s.whatsapp.net', name: 'Rishab' } }
  );
  assert.equal(row.meta.is_group, true);
  assert.equal(row.speaker, 'Rishab');
  assert.equal(row.meta.sender_handle, '+18085550999');
});

test('a message with no stanza id falls back to the primary key', () => {
  const row = messageToRow({ ...base, ZSTANZAID: null, Z_PK: 42 });
  assert.equal(row.entity_id, 'whatsapp:pk42');
});

test('messagesToRows counts skips and resolves members through memberFor', () => {
  const members = { 9: { jid: '18085550999@s.whatsapp.net', name: 'Rishab' } };
  const out = messagesToRows(
    [
      base,
      { ...base, Z_PK: 2, ZSTANZAID: 'S2', ZTEXT: null }, // a media row, no text
      { ...base, Z_PK: 3, ZSTANZAID: 'S3', chat_jid: '12036@g.us', ZGROUPMEMBER: 9 },
    ],
    { selfName: 'Austin', memberFor: (pk) => members[pk] ?? null }
  );
  assert.equal(out.rows.length, 2);
  assert.equal(out.skipped, 1, 'the media row is skipped');
  assert.equal(out.rows[1].speaker, 'Rishab');
});

// --- the epoch unit, which was only ever asserted in a document -------------
//
// ZMESSAGEDATE is Apple-epoch SECONDS. That single fact decides the date on
// every WhatsApp message, and its only evidence was a line in ops/PROBES.md
// citing a probe script that had never been committed — so the conclusion
// survived and the working did not. `ops/probes/probe-whatsapp.mjs` now
// re-derives it against the real store; these tests are the half that runs on
// every commit.
//
// The wrong unit is not subtly wrong, which is what makes this checkable
// without the real database: reading seconds as milliseconds lands in 2001,
// as Unix seconds in 1995. The assertions below pin the correct reading and
// the distance to the wrong ones.

test('ZMESSAGEDATE is Apple-epoch seconds, and the wrong units are decades out', () => {
  // 2026-03-14T00:00:00Z expressed as Apple-epoch seconds.
  const appleSeconds = (Date.parse('2026-03-14T00:00:00Z') - 978_307_200_000) / 1000;

  const correct = appleSecondsToMs(appleSeconds);
  assert.equal(new Date(correct).toISOString().slice(0, 10), '2026-03-14');

  // The three readings the probe rejects, reproduced here so a future "fix"
  // that switches units fails loudly instead of silently re-dating the corpus.
  const asAppleMillis = appleSeconds + 978_307_200_000;
  const asUnixSeconds = appleSeconds * 1000;
  assert.equal(new Date(asAppleMillis).getUTCFullYear(), 2001, 'ms reading lands in 2001');
  assert.equal(new Date(asUnixSeconds).getUTCFullYear(), 1995, 'unix-seconds reading lands in 1995');
  assert.ok(
    correct - asAppleMillis > 20 * 365 * 86_400_000,
    'the units are decades apart — this is a decisive test, not a judgement call'
  );
});

test('a message from the live-store span converts to a plausible date', () => {
  // The observed span on the owner's machine, 2026-08-22: 2021-03-29 → today.
  // Both ends must read as real dates, not as 1970 or 33000.
  for (const day of ['2021-03-29', '2026-08-23']) {
    const sec = (Date.parse(`${day}T12:00:00Z`) - 978_307_200_000) / 1000;
    const ms = appleSecondsToMs(sec);
    assert.equal(new Date(ms).toISOString().slice(0, 10), day);
  }
});

test('a missing or non-numeric ZMESSAGEDATE is NaN, not epoch zero', () => {
  // The dangerous failure is a silent 1970 or 2001 timestamp, because a row
  // with a plausible-looking wrong date is indistinguishable from a real one
  // once it is in the store. NaN is loud; messageToRow drops it.
  for (const bad of [null, undefined, '', 'nope', {}, NaN]) {
    assert.equal(Number.isNaN(appleSecondsToMs(bad)), true, JSON.stringify(bad));
  }
});

// Cursor-test scaffolding: a synthetic store with the measured schema, and a
// run context that records deliveries and cursors in memory.
function createSyntheticStore(home) {
  const storePath = chatStoragePath(home);
  mkdirSync(dirname(storePath), { recursive: true });
  const db = new DatabaseSync(storePath);
  db.exec(`
    CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
    CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT, ZFIRSTNAME TEXT);
    CREATE TABLE ZWAMESSAGE (
      Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZISFROMME INTEGER, ZMESSAGEDATE INTEGER,
      ZFROMJID TEXT, ZSTANZAID TEXT, ZMESSAGETYPE INTEGER, ZGROUPEVENTTYPE INTEGER,
      ZGROUPMEMBER INTEGER, ZCHATSESSION INTEGER
    );
    INSERT INTO ZWACHATSESSION VALUES (1, '18085550100@s.whatsapp.net', 'Sam');
  `);
  return db;
}

function messageInserter(db) {
  return db.prepare(
    `INSERT INTO ZWAMESSAGE VALUES (?, ?, 0, ?, '18085550100@s.whatsapp.net', ?, 0, 0, NULL, 1)`
  );
}

function runContext(home) {
  const cursors = new Map();
  const delivered = new Set();
  const ctx = {
    home,
    cacheDir: join(home, 'cache'),
    backfill: false,
    config: { selfName: 'me' },
    now: () => Date.now(),
    log: { info() {}, warn() {} },
    state: {
      getCursor: (k) => cursors.get(k),
      setCursor: (k, v) => cursors.set(k, v),
    },
    ingest: async (rows) => {
      for (const r of rows) delivered.add(r.entity_id);
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    },
  };
  return { ctx, cursors, delivered };
}

// THE CAPPED-SCAN TIE. ZMESSAGEDATE is whole seconds, so the scan cap can cut
// a batch mid-second. The cursor is the max delivered date and the next scan
// is strict `>`, so without the one-second rewind on a capped scan the tied
// rows that did not fit under the LIMIT fell below the floor forever — silent
// loss, the same class files.mjs documents for its mtime cursor. This runs the
// real source against a synthetic store: 4999 distinct seconds, then three
// messages tied on one second, 5002 total against the 5000 cap.
test('a capped scan re-offers the boundary second instead of dropping the tie', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wa-cursor-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const db = createSyntheticStore(home);
  const ins = messageInserter(db);
  const TIE_SECOND = 999_999;
  db.exec('BEGIN');
  for (let i = 0; i < 4999; i += 1) ins.run(i + 1, `msg ${i}`, 1000 + i, `S${i}`);
  for (let i = 0; i < 3; i += 1) ins.run(5000 + i, `tied ${i}`, TIE_SECOND, `TIE${i}`);
  db.exec('COMMIT');
  db.close();

  const { ctx, cursors, delivered } = runContext(home);
  const source = createWhatsappSource({ home });
  await source.run(ctx); // capped at 5000, mid-tie
  await source.run(ctx); // the rewound cursor re-offers the boundary second

  assert.equal(delivered.size, 5002, 'every message lands, including the tie past the cap');
  assert.equal(
    cursors.get('whatsapp:max-date'),
    String(TIE_SECOND),
    'an uncapped scan advances to the max date as before'
  );
});

// THE BATCH-WIDE TIE. When every row of a capped batch shares one second, the
// one-second rewind re-selects the identical batch on every pass: the cursor
// never advances, the tie remainder never lands, and every message after the
// tie second is unreachable — a livelock, not just a loss. The escape is the
// uncapped refetch of the boundary second, so this pins two things the rewind
// alone cannot deliver: the cursor ADVANCES past the tie second on the first
// pass, and messages after it still arrive on the next.
test('a batch-wide tie finishes the second and advances instead of livelocking', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wa-tie-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const db = createSyntheticStore(home);
  const ins = messageInserter(db);
  const TIE_SECOND = 500_000;
  db.exec('BEGIN');
  // One more tied message than the 5000 cap, then five later ones.
  for (let i = 0; i < 5001; i += 1) ins.run(i + 1, `tied ${i}`, TIE_SECOND, `T${i}`);
  for (let i = 0; i < 5; i += 1) ins.run(6000 + i, `later ${i}`, 500_100 + i, `L${i}`);
  db.exec('COMMIT');
  db.close();

  const { ctx, cursors, delivered } = runContext(home);
  const source = createWhatsappSource({ home });

  await source.run(ctx); // capped, and the whole batch is one second
  assert.equal(delivered.size, 5001, 'the uncapped refetch lands the whole tie second in one pass');
  assert.equal(
    cursors.get('whatsapp:max-date'),
    String(TIE_SECOND),
    'the cursor advances past the finished second — pinned below it is the livelock'
  );

  await source.run(ctx); // progress: the messages after the tie second land
  assert.equal(delivered.size, 5006, 'messages after the tie second are reachable');
  assert.equal(cursors.get('whatsapp:max-date'), String(500_104));
});

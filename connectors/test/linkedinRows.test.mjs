// Tests for the LinkedIn export ingest and the CSV reader under it, plus the
// contacts spine's pure parts. Fixtures mimic the real export's quirks: the
// Notes: preamble before the header, quoted fields with commas, and message
// CONTENT with embedded newlines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { parseCsv, csvObjects } from '../lib/csv.mjs';
import {
  connectionsToRows,
  messagesToRows,
  parseConnectedOn,
  parseMessageDate,
} from '../lib/linkedinRows.mjs';
import { normalizePhone, normalizeEmail, readStore } from '../sources/contacts.mjs';

test('parseCsv handles quotes, escaped quotes, commas and newlines in fields', () => {
  const rows = parseCsv('a,"b,1","c""q""",d\n"multi\nline",2,,\n');
  assert.deepEqual(rows, [
    ['a', 'b,1', 'c"q"', 'd'],
    ['multi\nline', '2', '', ''],
  ]);
  assert.throws(() => parseCsv('"unterminated'), /unterminated/u);
});

const CONNECTIONS_FIXTURE = `Notes:
"When exporting your connection data, you may be missing information."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Sarah,Chen,https://www.linkedin.com/in/sarahchen,,Acme Robotics,"VP, Engineering",15 Aug 2021
Old,Timer,https://www.linkedin.com/in/oldtimer,old@example.com,,,03 Feb 2019
,,https://www.linkedin.com/in/nameless,,,Ghost Co,01 Jan 2020`;

test('connections: preamble skipped, dormancy clock kept, slug from URL', () => {
  const { rows, skipped } = connectionsToRows(CONNECTIONS_FIXTURE, { fallbackTs: 1000 });
  assert.equal(rows.length, 2);
  assert.equal(skipped, 1, 'a record with no name is skipped');
  const sarah = rows.find((r) => r.meta.name === 'Sarah Chen');
  assert.equal(sarah.entity_id, 'linkedin:conn:sarahchen');
  assert.equal(sarah.meta.position, 'VP, Engineering', 'quoted comma survives');
  assert.equal(new Date(sarah.ts).getFullYear(), 2021, 'Connected On IS the row time');
  const old = rows.find((r) => r.meta.name === 'Old Timer');
  assert.equal(new Date(old.ts).getFullYear(), 2019);
  assert.equal(old.meta.email, 'old@example.com');
});

const MESSAGES_FIXTURE = `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT
conv-1,,Sarah Chen,https://www.linkedin.com/in/sarahchen,Austin Yoshino,,2023-06-01 18:02:33 UTC,,"hey — long time!
would love to catch up"
conv-1,,Austin Yoshino,,Sarah Chen,,2023-06-01 19:10:00 UTC,,for sure
conv-2,,Ghost,,Austin Yoshino,,not a date,,dropped row`;

test('messages: multiline content, UTC dates, bad dates skipped', () => {
  const { rows, skipped } = messagesToRows(MESSAGES_FIXTURE);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 1);
  assert.match(rows[0].text, /long time!\nwould love/u);
  assert.equal(rows[0].speaker, 'Sarah Chen');
  assert.equal(rows[0].meta.conversation_id, 'conv-1');
  assert.notEqual(rows[0].entity_id, rows[1].entity_id);
});

test('date parsers refuse the shapes they do not own', () => {
  assert.equal(parseConnectedOn('15 Aug 2021') === null, false);
  assert.equal(parseConnectedOn('2021-08-15'), null);
  assert.equal(parseMessageDate('2023-06-01 18:02:33 UTC') === null, false);
  assert.equal(parseMessageDate('yesterday'), null);
});

test('the spine normalizers make identifiers collide with iMessage/mail keys', () => {
  assert.equal(normalizePhone('(415) 555-0142'), '+14155550142');
  assert.equal(normalizePhone('+1 555-555-0123'), '+15555550123');
  assert.equal(normalizePhone('911'), null, 'short codes are not people');
  assert.equal(normalizeEmail('  AY@AustinYoshino.com '), 'ay@austinyoshino.com');
  assert.equal(normalizeEmail('not-an-email'), null);
});

test('readStore reads the AddressBook shape and skips nameless records', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
    INSERT INTO ZABCDRECORD VALUES (1,'Sarah','Chen',NULL),(2,NULL,NULL,'Acme Robotics'),(3,NULL,NULL,NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1,'(808) 555-0100'),(3,'+1 555 000 1111');
    INSERT INTO ZABCDEMAILADDRESS VALUES (2,'OPS@Acme.example');
  `);
  const { entries } = readStore(db);
  db.close();
  assert.deepEqual(
    entries.sort((a, b) => a.identifier.localeCompare(b.identifier)),
    [
      { identifier: '+18085550100', displayName: 'Sarah Chen', kind: 'phone' },
      { identifier: 'ops@acme.example', displayName: 'Acme Robotics', kind: 'email' },
    ],
    'record 3 has no name and contributes nothing'
  );
});

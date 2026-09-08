import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { messagesToRows } from '../lib/linkedinRows.mjs';
import { eventToRow } from '../lib/matrixRows.mjs';
import { createLinkedinSource, defaultImportDir } from '../sources/linkedin.mjs';

const csv = [
  'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT',
  'conversation-1,,Owner Example,,Contact Example,2026-08-01 12:34:56 UTC,,Following up tomorrow',
].join('\n');

test('LinkedIn archive and live bridge copies of one message share an entity id', () => {
  const archived = messagesToRows(csv, { selfName: 'Owner Example' }).rows[0];
  const live = eventToRow({
    type: 'm.room.message',
    event_id: '$live-event',
    origin_server_ts: Date.UTC(2026, 7, 1, 12, 34, 56, 437),
    sender: '@you:hazlie.local',
    content: { msgtype: 'm.text', body: 'Following up tomorrow' },
    __partner: {
      source: 'linkedin',
      handle: 'linkedin_contact',
      mxid: '@linkedin_contact:hazlie.local',
    },
  }, {
    roomId: '!room:hazlie.local',
    selfName: 'Owner Example',
    names: new Map([['@linkedin_contact:hazlie.local', 'Contact Example']]),
  });

  assert.equal(archived.meta.is_from_me, true);
  assert.equal(archived.entity_id, live.entity_id);
});

test('the dedupe key keeps opposite message directions separate', () => {
  const fromOwner = messagesToRows(csv, { selfName: 'Owner Example' }).rows[0];
  const fromContact = messagesToRows(
    csv.replace('Owner Example,,Contact Example', 'Contact Example,,Owner Example'),
    { selfName: 'Owner Example' },
  ).rows[0];

  assert.notEqual(fromOwner.entity_id, fromContact.entity_id);
});

test('identical same-second messages in different conversations stay separate', () => {
  const first = messagesToRows(csv, { selfName: 'Owner Example' }).rows[0];
  const second = messagesToRows(
    csv.replace('Contact Example', 'Different Contact'),
    { selfName: 'Owner Example' },
  ).rows[0];

  assert.notEqual(first.entity_id, second.entity_id);
});

test('the archive source accepts a messages-only export and imports it locally', async () => {
  const home = mkdtempSync(join(tmpdir(), 'linkedin-hybrid-'));
  const importDir = defaultImportDir(home);
  mkdirSync(importDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(importDir, 'messages.csv'), csv, { mode: 0o600 });
  const source = createLinkedinSource({ home });
  const cursors = new Map();
  const ingested = [];

  assert.deepEqual(source.needs(), []);
  const result = await source.run({
    home,
    backfill: false,
    config: { selfName: 'Owner Example' },
    state: {
      getCursor: (key) => cursors.get(key),
      setCursor: (key, value) => cursors.set(key, value),
    },
    ingest: async (rows) => {
      ingested.push(...rows);
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    },
    log: { info() {} },
  });

  assert.equal(result.inserted, 1);
  assert.equal(ingested[0].meta.is_from_me, true);
});

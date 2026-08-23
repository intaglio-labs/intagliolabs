// The self-ingestion guard, which had no test and failed open.
//
// pinnedThreadGuids names the Messages thread Hazlie talks to the owner
// through. Every caller uses the result to EXCLUDE that thread — from
// ingestion (sources/imessage.mjs), from claim selection (memory/select.mjs)
// and from the episodic shelf (memory/episodic.mjs). It exists because of the
// 2026-08-19 self-ingestion incident, where Hazlie's own messages were read
// back in as household corpus.
//
// It used to `catch { return [] }` on every error, which made "nothing is
// pinned" and "I could not read the file" the same answer. A permissions
// change or a half-written config therefore turned all three guards off at
// once, silently — and the only telemetry, `excludedThreads: 0`, reads
// identically in both cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedThreadGuids } from '../lib/pinnedThread.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hz-pinned-'));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('a pinned thread comes back as a one-element list', () => {
  const p = join(tmp(), 'courier.json');
  writeFileSync(p, JSON.stringify({ commandChatGuid: 'iMessage;-;+15551234567' }));
  assert.deepEqual(pinnedThreadGuids({ configPath: p }), ['iMessage;-;+15551234567']);
});

test('no config file at all means nothing is pinned — that is a real answer', () => {
  // The one case where [] is correct: the owner has not set up the courier, so
  // there is no self-thread to exclude.
  const p = join(tmp(), 'absent.json');
  assert.deepEqual(pinnedThreadGuids({ configPath: p }), []);
});

test('a config with no commandChatGuid means nothing is pinned', () => {
  const p = join(tmp(), 'courier.json');
  writeFileSync(p, JSON.stringify({ somethingElse: true }));
  assert.deepEqual(pinnedThreadGuids({ configPath: p }), []);
});

test('a blank or non-string guid is not a thread', () => {
  for (const guid of ['', '   ', 42, null, {}]) {
    const p = join(tmp(), 'courier.json');
    writeFileSync(p, JSON.stringify({ commandChatGuid: guid }));
    assert.deepEqual(pinnedThreadGuids({ configPath: p }), [], JSON.stringify(guid));
  }
});

test('UNPARSEABLE config THROWS rather than reporting nothing pinned', () => {
  // The regression. A truncated write mid-save used to disable the guard and
  // look like a clean answer.
  const p = join(tmp(), 'courier.json');
  writeFileSync(p, '{"commandChatGuid": "iMessage;-;+1555');
  assert.throws(() => pinnedThreadGuids({ configPath: p }), /not valid JSON/u);
});

test('an unreadable config THROWS rather than reporting nothing pinned', {
  skip: process.getuid?.() === 0 ? 'root can read anything' : false,
}, () => {
  const p = join(tmp(), 'courier.json');
  writeFileSync(p, JSON.stringify({ commandChatGuid: 'iMessage;-;+15551234567' }));
  chmodSync(p, 0o000);
  assert.throws(() => pinnedThreadGuids({ configPath: p }), /unreadable/u);
  chmodSync(p, 0o600); // so the temp cleanup can remove it
});

test('the thrown error keeps the cause, so the reason is not lost', () => {
  const p = join(tmp(), 'courier.json');
  writeFileSync(p, 'not json at all');
  try {
    pinnedThreadGuids({ configPath: p });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error.cause, 'the underlying parse error must survive for the log');
  }
});

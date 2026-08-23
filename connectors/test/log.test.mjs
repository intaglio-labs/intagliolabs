// The log-redaction tripwire, which had no test at all until 2026-08-22.
//
// WHY THAT MATTERED. connectors/AGENTS.md § "The log never carries row content"
// is one of the load-bearing rules in this package: the corpus boundary is
// hermes' database, and a log line quoting a message re-creates that corpus in
// a second file with none of hermes' deletion discipline. lib/log.mjs enforces
// it by refusing a closed list of content-shaped field names. Deleting that
// check broke nothing — every test in the suite still passed — so the rule was
// protected by nobody noticing.
//
// The audit's phrasing for this class was "a binding line in an AGENTS.md must
// have an executable witness or it is advice."
//
// WHAT THIS CANNOT DO, stated up front because it is the more important half:
// the tripwire only sees TOP-LEVEL FIELD NAMES. It cannot see content nested
// inside an object, content in an array, content under an innocent name like
// `title` or `summary`, or an Error whose .message embeds a row value. Those
// are all still forbidden by the policy and still entirely unguarded by the
// code. The tests below therefore document that gap deliberately rather than
// leaving a green suite implying coverage that does not exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../lib/log.mjs';

const dirs = [];
function tmpLog(name = 'connectors.log') {
  const dir = mkdtempSync(join(tmpdir(), 'hz-log-'));
  dirs.push(dir);
  return join(dir, name);
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FORBIDDEN = ['text', 'body', 'subject', 'content', 'snippet', 'message', 'transcript', 'note'];

test('every forbidden field name is refused, on every level', () => {
  const log = createLogger({ path: tmpLog() });
  for (const field of FORBIDDEN) {
    for (const level of ['info', 'warn', 'error']) {
      assert.throws(
        () => log[level]('ingested', { [field]: 'the quick brown fox' }),
        /never carries row content/u,
        `${level}() accepted forbidden field "${field}"`
      );
    }
  }
  log.close();
});

test('the refusal is case-insensitive — Subject and BODY are the same leak', () => {
  // The check lowercases the key. Without that, a row spread into a log call
  // from a source whose column is `Subject` walks straight through.
  const log = createLogger({ path: tmpLog() });
  for (const field of ['Text', 'BODY', 'Subject', 'SnIpPeT', 'Transcript']) {
    assert.throws(() => log.info('ingested', { [field]: 'x' }), /never carries row content/u, field);
  }
  log.close();
});

test('permitted fields write one parseable JSON line with ts, level and event', () => {
  const path = tmpLog();
  const log = createLogger({ path });
  log.info('scan', { source: 'granola', ingested: 12, updated: 3, ms: 418 });
  log.close();
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.event, 'scan');
  assert.equal(row.level, 'info');
  assert.equal(row.source, 'granola');
  assert.equal(row.ingested, 12);
  assert.ok(!Number.isNaN(Date.parse(row.ts)), 'ts must be a real timestamp');
});

test('a refused write leaves NOTHING on disk — the throw is not after the writeSync', () => {
  // Ordering matters more than the throw does. If the check ran after the
  // write, every one of these tests would still pass while the content it
  // refuses sat in the file.
  const path = tmpLog();
  const log = createLogger({ path });
  assert.throws(() => log.info('ingested', { body: 'SHOULD-NEVER-APPEAR' }));
  log.close();
  const written = readFileSync(path, 'utf8');
  assert.equal(written.includes('SHOULD-NEVER-APPEAR'), false);
  assert.equal(written.trim(), '');
});

test('an empty or non-string event is refused', () => {
  const log = createLogger({ path: tmpLog() });
  for (const bad of ['', 42, null, undefined, {}]) {
    assert.throws(() => log.info(bad, { n: 1 }), /non-empty string/u, JSON.stringify(bad));
  }
  log.close();
});

test('a group- or other-readable log file is refused at open', () => {
  // The log holds ids, counts and error strings about the owner's sources. It
  // is not corpus, but it is not public either, and a pre-created 0644 file is
  // how it would quietly become so.
  const path = tmpLog('preexisting.log');
  writeFileSync(path, '');
  chmodSync(path, 0o644);
  assert.throws(() => createLogger({ path }), /group\/other readable/u);
});

test('close() makes further writes silent rather than throwing', () => {
  // Deliberate: a straggling timer firing after shutdown should not crash the
  // daemon on its way out. Asserted so nobody "fixes" it into a throw.
  const path = tmpLog();
  const log = createLogger({ path });
  log.close();
  assert.doesNotThrow(() => log.info('late', { n: 1 }));
  assert.equal(readFileSync(path, 'utf8').trim(), '');
});

test('DOCUMENTED GAP: the tripwire cannot see nested or renamed content', () => {
  // Not a wish list — this is what the code does today, pinned so the gap is
  // visible in the suite instead of being discovered in a log file. Every case
  // below is a POLICY VIOLATION that the CODE allows, because the check reads
  // top-level key names only.
  //
  // connectors/AGENTS.md is explicit that the policy "binds everything the
  // tripwire cannot see", so these paths are governed by review, not by code.
  // If this test ever starts failing, the tripwire got stronger and that is
  // good news — update it rather than reverting.
  const path = tmpLog();
  const log = createLogger({ path });

  // Nested under a permitted key.
  log.info('ingested', { row: { text: 'LEAKS-NESTED' } });
  // Inside an array.
  log.info('ingested', { rows: [{ body: 'LEAKS-ARRAY' }] });
  // Under an innocent name the closed list does not contain.
  log.info('ingested', { title: 'LEAKS-TITLE', summary: 'LEAKS-SUMMARY' });
  // An Error message carrying a row value — the run_log.error case
  // connectors/AGENTS.md calls out by name.
  log.error('failed', { err: String(new Error('parse failed on: LEAKS-ERRSTRING')) });
  log.close();

  const written = readFileSync(path, 'utf8');
  for (const leak of ['LEAKS-NESTED', 'LEAKS-ARRAY', 'LEAKS-TITLE', 'LEAKS-SUMMARY', 'LEAKS-ERRSTRING']) {
    assert.ok(written.includes(leak), `expected the known gap to let ${leak} through`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, runCounts } from '../lib/state.mjs';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-runcounts-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The bug this file exists for: six of the nine sources return `inserted`,
// and both recorders read only `ingested`. A files run that put 2,000 rows
// into hermes was logged as `ingested: 0`, which reads as a connector that
// did nothing.
test('a source that returns `inserted` is not recorded as having ingested nothing', () => {
  assert.equal(runCounts({ inserted: 2000, updated: 0, unchanged: 0 }).ingested, 2000);
});

test('a source that returns `ingested` is passed through unchanged', () => {
  assert.equal(runCounts({ ingested: 42 }).ingested, 42);
});

test('`ingested` wins when a source somehow reports both', () => {
  assert.equal(runCounts({ ingested: 7, inserted: 999 }).ingested, 7);
});

test('runCounts settles exactly the four columns run_log stores', () => {
  assert.deepEqual(runCounts({ inserted: 3, updated: 2, unchanged: 1, deleted: 4 }), {
    ingested: 3,
    updated: 2,
    unchanged: 1,
    deleted: 4,
  });
  // A source's own extra fields are the caller's business, not run_log's.
  assert.deepEqual(Object.keys(runCounts({ inserted: 1, remaining: 1831, capped: true })).sort(), [
    'deleted',
    'ingested',
    'unchanged',
    'updated',
  ]);
});

test('an empty or missing return is zeros, not undefined', () => {
  assert.deepEqual(runCounts(), { ingested: 0, updated: 0, unchanged: 0, deleted: 0 });
  assert.deepEqual(runCounts({}), { ingested: 0, updated: 0, unchanged: 0, deleted: 0 });
});

test('a zero insert count survives the ?? chain rather than falling through', () => {
  // `inserted: 0` must not be mistaken for "absent" and re-looked-up.
  assert.equal(runCounts({ ingested: 0, inserted: 500 }).ingested, 0);
});

test('the count reaches run_log through recordRun', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  state.recordRun({
    connector: 'files',
    startedTs: 1,
    finishedTs: 2,
    ok: true,
    ...runCounts({ inserted: 2000, remaining: 1831, capped: true }),
  });
  const row = state.db.prepare('SELECT connector, ingested FROM run_log ORDER BY id DESC').get();
  assert.equal(row.connector, 'files');
  assert.equal(row.ingested, 2000);
});

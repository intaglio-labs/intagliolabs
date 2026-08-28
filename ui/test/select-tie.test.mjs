// The cursor is a PAIR, and this is the bug that proved it has to be.
//
// store_changed_at was documented as "strictly monotonic" and used alone as the
// cursor. It is not: a connector pass stamps every row it delivers with one
// value, so large ties are ordinary. A private development corpus confirmed
// that the scalar cursor skipped a material share of eligible rows.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows } from '../server/hermes.mjs';
import { selectRows } from '../server/memory/select.mjs';

const OWNER = { is_from_me: 1 };

// One batch, one timestamp, n rows -- exactly what a connector pass produces.
let batchNo = 0;
function tiedBatch(d, n, { ts = Date.now() - 86_400_000 } = {}) {
  // Distinct entity ids per batch: (source, entity_id) is UNIQUE, so reusing
  // them makes a second batch UPSERT over the first instead of adding rows --
  // which is exactly what this fixture got wrong the first time.
  const b = (batchNo += 1);
  insertRows(
    d,
    Array.from({ length: n }, (_, i) => ({
      ts: ts + i, // event time varies; the INGEST stamp is what ties
      source: 'imessage',
      speaker: 'Owner',
      text: `message number ${i}`,
      meta: OWNER,
      entity_id: `imessage:tie:${b}:${i}`,
    }))
  );
}

// Walk the cursor the way distill-once.mjs does, and report what was seen.
function drain(d, { limit, passes = 50 }) {
  const seen = [];
  let since = 0;
  let sinceId = 0;
  for (let i = 0; i < passes; i += 1) {
    const rows = selectRows(d, { sinceChangedAt: since, sinceId, limit, excludeChatGuids: [] });
    if (rows.length === 0) break;
    seen.push(...rows.map((r) => r.id));
    const last = rows[rows.length - 1];
    since = Number(last.store_changed_at);
    sinceId = Number(last.id);
  }
  return seen;
}

test('a capped pass over a tie group does not step over the rest of it', () => {
  const d = openDb(':memory:');
  tiedBatch(d, 100); // one ingest stamp, 100 eligible rows
  const stamps = d.prepare('SELECT COUNT(DISTINCT store_changed_at) n FROM context').get().n;
  assert.equal(stamps, 1, 'the batch must actually tie, or this test proves nothing');

  const seen = drain(d, { limit: 40 }); // the real cap
  assert.equal(seen.length, 100, 'every tied row is eventually offered');
  assert.equal(new Set(seen).size, 100, 'and none of them twice');
});

test('the old single-column cursor is what lost them', () => {
  // Reproduces the defect against the same fixture, to show the fix is load
  // bearing rather than incidental: advance on store_changed_at ALONE.
  const d = openDb(':memory:');
  tiedBatch(d, 100);
  let since = 0;
  const seen = [];
  for (let i = 0; i < 50; i += 1) {
    // sinceId deliberately pinned at 0 -- the old behaviour, cursor = timestamp
    const rows = selectRows(d, { sinceChangedAt: since, sinceId: 0, limit: 40, excludeChatGuids: [] });
    if (rows.length === 0) break;
    const next = Number(rows[rows.length - 1].store_changed_at);
    if (next === since) break; // the old code would livelock here; it advanced past instead
    seen.push(...rows.map((r) => r.id));
    since = next;
  }
  assert.ok(seen.length < 100, 'the timestamp-only cursor cannot drain a tie group');
});

test('the pair advances exactly: no row repeats across passes', () => {
  const d = openDb(':memory:');
  tiedBatch(d, 30, { ts: Date.now() - 200_000 });
  tiedBatch(d, 30, { ts: Date.now() - 100_000 }); // a second batch, second stamp
  const seen = drain(d, { limit: 7 });
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen).size, 60, 'no duplicates across many small passes');
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'and they arrive in cursor order');
});

test('a tie wider than the cap still drains, one cap at a time', () => {
  const d = openDb(':memory:');
  tiedBatch(d, 205); // wider than any pass; the connectors need an escape hatch here
  const seen = drain(d, { limit: 40, passes: 100 });
  assert.equal(seen.length, 205, 'no livelock and no loss -- the id breaks every tie');
});

test('sinceId is validated, because a bad cursor silently skips rows', () => {
  const d = openDb(':memory:');
  assert.throws(() => selectRows(d, { sinceId: -1 }), /sinceId/);
  assert.throws(() => selectRows(d, { sinceId: 1.5 }), /sinceId/);
});

// A caller that knows only a timestamp -- every run recorded before schema v7 --
// must re-read that group rather than step over it.
test('a timestamp-only cursor re-offers its group instead of dropping it', () => {
  const d = openDb(':memory:');
  tiedBatch(d, 50);
  const all = selectRows(d, { sinceChangedAt: 0, sinceId: 0, limit: 50, excludeChatGuids: [] });
  const stamp = Number(all[0].store_changed_at);
  // Cursor from a pre-v7 run: the timestamp, and no id.
  const again = selectRows(d, { sinceChangedAt: stamp - 1, sinceId: 0, limit: 50, excludeChatGuids: [] });
  assert.equal(again.length, 50, 'the whole group comes back, none of it stepped over');
});

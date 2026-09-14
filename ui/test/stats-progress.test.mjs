// /stats' progress arithmetic and its cache, both of which were reporting
// confidently while being wrong in a way nothing downstream could see.
//
//   countSelectable  `pending` was selectRows({limit: 100000}).length — a
//                    hundred thousand rows decoded into objects and thrown
//                    away to take an array's length, on a polled route. The
//                    replacement must return the SAME number, cap and all.
//   invalidation     a purge deletes rows; the cached sweep and lookup blocks
//                    did not notice, and a block inside its TTL certifies
//                    itself as current (no staleMs), so /stats answered
//                    `rows: 0` beside numbers computed over the corpus that
//                    had just been removed.
//   the lost latch   `refreshing` is cleared only in a deferred timer's
//                    finally. If that timer never fires the block is frozen
//                    for the life of the process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertRows, start } from '../server/hermes.mjs';
import { countSelectable, selectRows, DEFAULT_ROW_CAP } from '../server/memory/select.mjs';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const TOKEN = 'a'.repeat(64);

// HETEROGENEOUS ON PURPOSE. A count that simply totalled `context` would agree
// with the old `.length` only on a corpus with one included source and no
// exclusions; every row below is here because some plausible wrong query
// disagrees about it.
//
//   notes, decoded      included
//   notes, undecoded    excluded by the per-source predicate, not by source
//   imessage from me    included
//   imessage from them  excluded by the per-source predicate
//   mail                excluded by source
//   calendar            excluded by source
//   an old row          outside the fromDays window
function seed(db) {
  const rows = [
    { ts: NOW - DAY, source: 'notes', speaker: 'owner', text: 'a decoded note', meta: {} },
    { ts: NOW - DAY, source: 'notes', speaker: 'owner', text: 'mangled', meta: { body_undecoded: 1 } },
    { ts: NOW - DAY, source: 'imessage', speaker: 'owner', text: 'sent', meta: { is_from_me: 1 } },
    { ts: NOW - DAY, source: 'imessage', speaker: 'them', text: 'received', meta: { is_from_me: 0 } },
    { ts: NOW - DAY, source: 'mail', speaker: 'them', text: 'inbound', meta: {} },
    { ts: NOW - DAY, source: 'calendar', speaker: 'them', text: 'invite', meta: {} },
    { ts: NOW - 400 * DAY, source: 'notes', speaker: 'owner', text: 'ancient', meta: {} },
  ];
  insertRows(db, rows.map((r) => ({ ...r, meta: JSON.stringify(r.meta) })));
}

test('countSelectable returns exactly what selectRows would have counted', () => {
  const db = openDb(':memory:');
  seed(db);
  // Every window the callers actually use, plus the boundaries.
  for (const opts of [
    { now: NOW },
    { now: NOW, fromDays: 3650, limit: 100000 },
    { now: NOW, fromDays: 3650, limit: DEFAULT_ROW_CAP },
    { now: NOW, fromDays: 1 },
    { now: NOW, fromDays: 3650, sinceChangedAt: 0, sinceId: 0 },
    { now: NOW, excludeChatGuids: [] },
  ]) {
    assert.equal(
      countSelectable(db, { excludeChatGuids: [], ...opts }),
      selectRows(db, { excludeChatGuids: [], ...opts }).length,
      `disagreed for ${JSON.stringify(opts)}`
    );
  }
  // Not vacuous: the fixture must actually select something, and must exclude
  // something too, or the two would agree on zero for the wrong reason.
  assert.ok(countSelectable(db, { now: NOW, fromDays: 3650, excludeChatGuids: [] }) > 0);
  assert.ok(
    countSelectable(db, { now: NOW, fromDays: 3650, excludeChatGuids: [] })
      < Number(db.prepare('SELECT count(*) AS n FROM context').get().n),
    'a plain COUNT(*) over context would be a different, larger number'
  );
  db.close();
});

test('the count keeps the limit, because the length it replaces was capped too', () => {
  const db = openDb(':memory:');
  seed(db);
  const opts = { now: NOW, fromDays: 3650, limit: 1, excludeChatGuids: [] };
  // THE PROPERTY THAT MAKES THIS A REPLACEMENT AND NOT AN IMPROVEMENT. The
  // array was capped by the selector's own LIMIT, so `.length` answered
  // min(population, limit). A caller reading "100000 pending" must keep
  // reading 100000 rather than suddenly seeing the true population.
  assert.equal(countSelectable(db, opts), 1);
  assert.equal(selectRows(db, opts).length, 1);
  assert.ok(countSelectable(db, { ...opts, limit: 100000 }) > 1, 'and the cap is a cap, not the answer');
  db.close();
});

test('countSelectable refuses the same bad arguments selectRows refuses', () => {
  const db = openDb(':memory:');
  for (const bad of [
    { limit: 0 }, { limit: 1.5 }, { fromDays: 0 }, { sinceId: -1 }, { sinceChangedAt: -1 },
    { excludeChatGuids: [7] },
  ]) {
    assert.throws(() => countSelectable(db, { now: NOW, ...bad }), `accepted ${JSON.stringify(bad)}`);
  }
  db.close();
});

// ----------------------------------------------------------- the /stats cache

async function withServer(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stats-cache-'));
  const server = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64),
    bearerToken: TOKEN,
    peopleProjectionAutoRebuild: false,
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try { await fn({ call, db: server.db }); } finally { await server.close(); }
}

test('a purge drops the corpus-derived blocks instead of certifying them fresh', async () => {
  await withServer(async ({ call, db }) => {
    insertRows(db, [{
      ts: Date.now(), source: 'imessage', speaker: 'owner',
      text: 'sent', meta: JSON.stringify({ is_from_me: 1 }),
    }]);
    const first = await (await call('GET', '/stats')).json();
    assert.ok(first.sweep, 'the sweep block is computed on the first request');
    const before = first.sweep.computedAt;

    // A cached block inside its TTL carries no staleMs at all, so a second
    // request cannot be told apart from the first by anything on the wire —
    // which is precisely why the purge has to do the invalidating.
    const second = await (await call('GET', '/stats')).json();
    assert.equal(second.sweep.computedAt, before, 'still cached, still silent about it');

    await call('POST', '/admin/purge', { source: 'imessage' });

    const after = await (await call('GET', '/stats')).json();
    assert.equal(after.rows, 0, 'the rows are gone');
    assert.ok(after.sweep.computedAt > before,
      'and sweep was recomputed rather than answering over the corpus that was deleted');
    assert.equal(after.sweep.staleMs, undefined,
      'recomputed, not served stale — a fresh value reports no age');
  });
});

test('a refresh that never lands does not freeze the block forever', () => {
  // THE LATCH CANNOT BE WEDGED BY WAITING, which is why the holder is a seam.
  // `refreshing` is cleared in the deferred timer's `finally`, so any timer
  // that fires clears it; the failure being guarded against is the timer that
  // never fires at all — an unref'd timer on a process winding down, a compute
  // that wedges, a fake-clock test. Written into the holder directly, because
  // that is the only way to produce the state the guard is for.
  const holder = {};
  let computed = 0;
  const ttlMs = 50;
  return withServer(async ({ call }) => {
    const first = await (await call('GET', '/stats')).json();
    assert.equal(computed, 1);
    const stamp = first.sweep.computedAt;

    // A latch taken out just now, over a block that is already due. The guard
    // must NOT fire here: two overlapping refreshes for an ordinary in-flight
    // one is the cost this whole mechanism exists to avoid.
    holder.sweep.computedAt = Date.now() - ttlMs * 10;
    holder.sweep.refreshing = true;
    holder.sweep.refreshStartedAt = Date.now();
    await (await call('GET', '/stats')).json();
    assert.equal(computed, 1, 'a refresh genuinely in flight is left alone');

    // The same latch, held for longer than two TTLs. That refresh is not
    // coming back, and without this the block is served from `stamp` for the
    // life of the process with a staleMs that only grows.
    holder.sweep.refreshStartedAt = Date.now() - ttlMs * (2 + 1);
    await (await call('GET', '/stats')).json();
    await new Promise((r) => setTimeout(r, 120));
    const last = await (await call('GET', '/stats')).json();
    assert.ok(computed > 1, 'a lost latch is broken and the block recomputes');
    assert.ok(last.sweep.computedAt > stamp, 'and the served value moved with it');
  }, {
    statsCacheTtlMs: ttlMs,
    statsCacheHolder: holder,
    statusProbes: {
      sweep: () => { computed += 1; return { probe: computed }; },
    },
  });
});

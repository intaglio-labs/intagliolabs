// ingestClient against the REAL hermes — the point of these tests is the
// seam, so nothing here mocks the server. A hermes instance from
// ui/server/hermes.mjs runs on an ephemeral port with a throwaway file DB
// and fixed test credentials, exactly as ui/test/hermes.test.mjs starts it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../ui/server/hermes.mjs';
import {
  adminCoverage,
  adminCompletePeopleYear,
  adminDeleteEntities,
  adminClearPeopleProjection,
  adminEntities,
  adminMaintain,
  adminPurge,
  adminRetain,
  canonicalLoopbackBase,
  ingest,
} from '../lib/ingestClient.mjs';

const TEST_LLAMA_KEY = 'a'.repeat(64);
const TEST_BEARER_TOKEN = 'c'.repeat(64);

let hermes;
let dir;
let opts; // {baseUrl, tokenFile} every call under test uses

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'connectors-ingest-test-')); // mkdtemp dirs are 0700
  const tokenFile = join(dir, 'hermes-token.txt');
  writeFileSync(tokenFile, `${TEST_BEARER_TOKEN}\n`, { mode: 0o600 });
  hermes = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
  });
  opts = { baseUrl: `http://127.0.0.1:${hermes.port}`, tokenFile, backoffMs: 1 };
});

after(async () => {
  await hermes?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// A fetch wrapper that records every request so batching and retry behavior
// are observable, then forwards to the real hermes.
function recordingFetch(record) {
  return async (url, init) => {
    const rows = init?.body ? JSON.parse(init.body) : undefined;
    record.push({
      url: String(url),
      bytes: init?.body ? Buffer.byteLength(init.body, 'utf8') : 0,
      rows: Array.isArray(rows) ? rows.length : rows === undefined ? 0 : 1,
    });
    return fetch(url, init);
  };
}

test('the base URL must be a loopback origin — corpus rows go nowhere else', async () => {
  assert.equal(canonicalLoopbackBase('http://localhost:8787/'), 'http://localhost:8787');
  for (const bad of [
    'http://192.168.1.20:8787',
    'https://127.0.0.1:8787', // https implies a non-local trust model
    'http://127.0.0.1:8787/path',
    'not a url',
  ]) {
    await assert.rejects(
      ingest([{ source: 'seed', text: 'x' }], { ...opts, baseUrl: bad }),
      /loopback/,
      bad
    );
  }
});

test('upsert observed end-to-end: redelivery of the same batch is all-unchanged', async () => {
  const batch = [
    {
      ts: 1755500000000,
      source: 'calendar',
      entity_id: 'calendar:e2e-1:20260819',
      text: 'standup occurrence',
      meta: { attendees: ['ari', 'zed'] }, // pre-sorted, per the client contract
    },
    {
      ts: 1755500001000,
      source: 'calendar',
      entity_id: 'calendar:e2e-2:20260819',
      text: 'design review occurrence',
    },
  ];
  assert.deepEqual(await ingest(batch, opts), { inserted: 2, updated: 0, unchanged: 0 });
  assert.deepEqual(await ingest(batch, opts), { inserted: 0, updated: 0, unchanged: 2 });
  // ...and an edit lands as an update, not a duplicate.
  const edited = [{ ...batch[0], text: 'standup occurrence (moved)' }];
  assert.deepEqual(await ingest(edited, opts), { inserted: 0, updated: 1, unchanged: 0 });
});

test('a single row travels without an array wrapper', async () => {
  assert.deepEqual(
    await ingest({ ts: 1755500002000, source: 'seed', text: 'bare object row' }, opts),
    { inserted: 1, updated: 0, unchanged: 0 }
  );
});

test('an empty batch makes no request at all', async () => {
  const record = [];
  assert.deepEqual(await ingest([], { ...opts, fetchImpl: recordingFetch(record) }), {
    inserted: 0,
    updated: 0,
    unchanged: 0,
  });
  assert.equal(record.length, 0);
});

test('more than 200 rows splits on the row cap', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    ts: 1755501000000 + i,
    source: 'seed',
    entity_id: `seed-rowcap-${i}`, // unkeyed sources may not carry ids; seed rows here use one so the rerun stays cheap
    text: `row-cap row ${i}`,
  }));
  const record = [];
  const counts = await ingest(rows, { ...opts, fetchImpl: recordingFetch(record) });
  assert.equal(counts.inserted + counts.unchanged, 250);
  assert.equal(record.length, 2);
  assert.deepEqual(record.map((r) => r.rows), [200, 50]);
});

test('a synthetic >512 KiB batch splits on the byte cap and every request stays under it', async () => {
  // Five rows of ~200 KiB serialize to ~1 MB total: the planner must cut at
  // two rows per request (three requests), and every request must stay under
  // both our 512 KiB cap and therefore hermes' 1 MiB body limit.
  const big = 'y'.repeat(200 * 1024);
  const rows = Array.from({ length: 5 }, (_, i) => ({
    ts: 1755502000000 + i,
    source: 'seed',
    entity_id: `seed-bytecap-${i}`,
    text: `${big}${i}`,
  }));
  const record = [];
  const counts = await ingest(rows, { ...opts, fetchImpl: recordingFetch(record) });
  assert.equal(counts.inserted + counts.unchanged, 5);
  assert.equal(record.length, 3);
  assert.deepEqual(record.map((r) => r.rows), [2, 2, 1]);
  for (const r of record) assert.ok(r.bytes <= 512 * 1024, `request of ${r.bytes} bytes over cap`);
});

test('a 413 splits the batch recursively until every row lands', async () => {
  // A hermes that rejects any multi-row body — synthetic, because the
  // planner normally keeps real requests far under the real 1 MiB cap.
  const record = [];
  const strictFetch = async (url, init) => {
    const rows = JSON.parse(init.body);
    record.push(rows.length);
    if (Array.isArray(rows) && rows.length > 1) {
      return new Response(JSON.stringify({ error: 'request body too large' }), { status: 413 });
    }
    return fetch(url, init);
  };
  const rows = Array.from({ length: 4 }, (_, i) => ({
    ts: 1755503000000 + i,
    source: 'seed',
    entity_id: `seed-413-${i}`,
    text: `413-split row ${i}`,
  }));
  const counts = await ingest(rows, { ...opts, fetchImpl: strictFetch });
  assert.equal(counts.inserted + counts.unchanged, 4);
  // [4] -> 413, [2]+[2] -> 413 each, then four singles land.
  assert.deepEqual(record, [4, 2, 1, 1, 2, 1, 1]);
});

test('an unsplittable 413 (single row) throws with .status 413', async () => {
  const always413 = async () =>
    new Response(JSON.stringify({ error: 'request body too large' }), { status: 413 });
  await assert.rejects(
    ingest([{ source: 'seed', text: 'x' }], { ...opts, fetchImpl: always413 }),
    (error) => {
      assert.equal(error.status, 413);
      assert.match(error.message, /single row/);
      return true;
    }
  );
});

test('503s are retried with backoff and the delivery still lands', async () => {
  let failures = 0;
  let attempts = 0;
  const flaky = async (url, init) => {
    attempts += 1;
    if (failures < 2) {
      failures += 1;
      return new Response(JSON.stringify({ error: 'draining' }), { status: 503 });
    }
    return fetch(url, init);
  };
  const counts = await ingest(
    [{ ts: 1755504000000, source: 'seed', entity_id: 'seed-503-1', text: 'retry survivor' }],
    { ...opts, fetchImpl: flaky }
  );
  assert.equal(counts.inserted + counts.unchanged, 1);
  assert.equal(attempts, 3);
});

test('a network-level failure is retried the same way', async () => {
  let threw = false;
  const dropsOnce = async (url, init) => {
    if (!threw) {
      threw = true;
      throw new TypeError('fetch failed'); // undici's connection-refused shape
    }
    return fetch(url, init);
  };
  const counts = await ingest(
    [{ ts: 1755504001000, source: 'seed', entity_id: 'seed-neterr-1', text: 'network retry survivor' }],
    { ...opts, fetchImpl: dropsOnce }
  );
  assert.equal(counts.inserted + counts.unchanged, 1);
});

test('retries exhaust into a thrown error carrying the last status', async () => {
  let attempts = 0;
  const dead = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: 'still draining' }), { status: 503 });
  };
  await assert.rejects(
    ingest([{ source: 'seed', text: 'x' }], { ...opts, fetchImpl: dead }),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /4 attempts/);
      return true;
    }
  );
  assert.equal(attempts, 4); // the first try plus three retries
});

test('a 400 throws with .status and hermes’ own detail, and is never retried', async () => {
  let attempts = 0;
  const counting = async (url, init) => {
    attempts += 1;
    return fetch(url, init);
  };
  await assert.rejects(
    ingest([{ source: 'seed' }], { ...opts, fetchImpl: counting }), // no text: hermes rejects the batch
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /ingest\[0\]/); // hermes names the failing row
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test('the token is re-read on every call, so a rotated file takes effect immediately', async () => {
  const rotatedFile = join(dir, 'rotated-token.txt');
  writeFileSync(rotatedFile, `${TEST_BEARER_TOKEN}\n`, { mode: 0o600 });
  const rotatedOpts = { ...opts, tokenFile: rotatedFile };
  const row = { ts: 1755504002000, source: 'seed', entity_id: 'seed-rotate-1', text: 'token rotation row' };
  assert.deepEqual(await ingest([row], rotatedOpts), { inserted: 1, updated: 0, unchanged: 0 });
  // Rotate to a well-formed but wrong token: the very next call must present
  // the NEW value (hermes answers 401), proving nothing was cached.
  writeFileSync(rotatedFile, `${'d'.repeat(64)}\n`, { mode: 0o600 });
  await assert.rejects(ingest([row], rotatedOpts), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
});

// --- /admin/* wrappers -------------------------------------------------------

test('adminRetain deletes only the old rows of the named source', async () => {
  const now = Date.now();
  const DAY = 86_400_000;
  await ingest(
    [
      { ts: now - 40 * DAY, source: 'mail', entity_id: 'mail:old-1', text: 'old mail row' },
      { ts: now - 1 * DAY, source: 'mail', entity_id: 'mail:new-1', text: 'recent mail row' },
    ],
    opts
  );
  // claims_deleted joined the response on 2026-08-20: retention now removes
  // the memory derived from the rows it deletes, in the same transaction, and
  // says how much. Zero here because this fixture distills nothing.
  assert.deepEqual(await adminRetain({ source: 'mail', keepDays: 30 }, opts), {
    deleted: 1,
    claims_deleted: 0,
  });
});

test('adminEntities returns ids and timestamps ONLY, windowed', async () => {
  const T = 1600000000000;
  await ingest(
    [
      {
        ts: T + 1000,
        source: 'granola',
        entity_id: 'granola:win-a',
        text: 'note a',
        speaker: 'parent',
        meta: { folder: 'work' },
      },
      { ts: T + 2000, source: 'granola', entity_id: 'granola:win-b', text: 'note b' },
      { ts: T + 9000, source: 'granola', entity_id: 'granola:win-late', text: 'outside the window' },
    ],
    opts
  );
  const entities = await adminEntities({ source: 'granola', fromTs: T, toTs: T + 5000 }, opts);
  assert.deepEqual(entities, [
    { entity_id: 'granola:win-a', ts: T + 1000 },
    { entity_id: 'granola:win-b', ts: T + 2000 },
  ]);
  // The reconciliation read must never widen: ids + timestamps and nothing
  // else may cross back into this process.
  for (const e of entities) assert.deepEqual(Object.keys(e).sort(), ['entity_id', 'ts']);
});

test('adminCoverage returns aggregate source receipts only', async () => {
  const body = await adminCoverage(opts);
  assert.ok(Array.isArray(body.sources));
  const granola = body.sources.find((row) => row.source === 'granola');
  assert.ok(granola.rows >= 3);
  assert.deepEqual(Object.keys(granola).sort(), [
    'conversations', 'newest_ts', 'oldest_ts', 'rows', 'source', 'years',
  ]);
  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes('granola:win-a'), false);
  assert.equal(encoded.includes('note a'), false);
});

test('adminDeleteEntities deletes the diff and chunks batches over 500', async () => {
  const T = 1500000000000;
  const ids = Array.from({ length: 501 }, (_, i) => `health:steps:2026-01-${i}`);
  const rows = ids.map((entity_id, i) => ({
    ts: T + i,
    source: 'health',
    entity_id,
    text: `synthetic health row ${i}`,
  }));
  const first = await ingest(rows, opts);
  assert.equal(first.inserted + first.unchanged, 501);
  const record = [];
  // Recording wrapper proves the wrapper split the 501 ids into two
  // hermes-legal calls rather than sending one 501-id body hermes rejects.
  const result = await adminDeleteEntities(
    { source: 'health', entityIds: ids },
    { ...opts, fetchImpl: recordingFetch(record) }
  );
  assert.deepEqual(result, { deleted: 501 });
  assert.equal(record.length, 2);
  assert.deepEqual(await adminEntities({ source: 'health', fromTs: T, toTs: T + 1000 }, opts), []);
});

test('adminPurge deletes the whole source and reports the inline maintenance', async () => {
  await ingest(
    [{ ts: 1755505000000, source: 'granola', entity_id: 'granola:purge-1', text: 'purge fodder' }],
    opts
  );
  const result = await adminPurge({ source: 'granola' }, opts);
  assert.equal(result.maintained, true);
  assert.ok(result.deleted >= 1);
  assert.deepEqual(await adminEntities({ source: 'granola' }, opts), []);
});

test('adminClearPeopleProjection round-trips without exposing rows', async () => {
  const result = await adminClearPeopleProjection(opts);
  assert.equal(typeof result.cleared, 'number');
  assert.deepEqual(Object.keys(result), ['cleared']);
});

test('adminCompletePeopleYear returns profile completion only', async () => {
  const result = await adminCompletePeopleYear({ year: 1900 }, opts);
  assert.equal(result.complete, true);
  assert.equal(result.year, 1900, 'the API accepts the coordinator history floor');
  assert.deepEqual(Object.keys(result).sort(), ['complete', 'profiles', 'state', 'year']);
});

test('adminMaintain round-trips', async () => {
  assert.deepEqual(await adminMaintain(opts), { maintained: true });
});

// The placeholder must be a name that can never become a real source. This
// test used 'notes' until notes became one, at which point it failed by
// succeeding — the premise had quietly evaporated.
test('an unknown source is hermes’ 400, surfaced with detail and unretried', async () => {
  await assert.rejects(adminRetain({ source: 'not-a-real-source', keepDays: 30 }, opts), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /unknown source/);
    return true;
  });
});

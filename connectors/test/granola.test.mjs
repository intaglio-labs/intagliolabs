// The granola connector, tested at both seams: the Granola API side is a
// fetchImpl-injected fixture (the real API is the owner's account — tests
// must not spend its rate budget or depend on its contents), while the
// hermes side is the REAL server from ui/server/hermes.mjs, because upsert
// counts and admin deletes are exactly the behavior worth proving.
//
// One deliberately-live exception at the bottom: a single
// GET /notes?page_size=1 smoke, gated on the key file existing, asserting
// only the measured envelope shape (counts and field types — never content).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../ui/server/hermes.mjs';
import { adminEntities, ingest } from '../lib/ingestClient.mjs';
import {
  createGranolaClient,
  createTokenBucket,
  defaultGranolaKeyPath,
  parseRetryAfterMs,
} from '../lib/granolaClient.mjs';
import {
  UPDATED_AFTER_CURSOR,
  buildNoteRow,
  chunkTranscript,
  createGranolaSource,
  extractTranscriptText,
} from '../sources/granola.mjs';
import { openStateDb } from '../lib/state.mjs';
import { createLogger } from '../lib/log.mjs';

const TEST_LLAMA_KEY = 'a'.repeat(64);
const TEST_BEARER_TOKEN = 'c'.repeat(64);

let dir;
let keyFile;
let hermes;
let hermesOpts;
const stateDbs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'connectors-granola-test-')); // mkdtemp dirs are 0700
  keyFile = join(dir, 'granola-api-key.txt');
  writeFileSync(keyFile, 'gr-test-key\n', { mode: 0o600 });
  const tokenFile = join(dir, 'hermes-token.txt');
  writeFileSync(tokenFile, `${TEST_BEARER_TOKEN}\n`, { mode: 0o600 });
  hermes = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
  });
  hermesOpts = { baseUrl: `http://127.0.0.1:${hermes.port}`, tokenFile, backoffMs: 1 };
});

after(async () => {
  for (const s of stateDbs) s.close();
  await hermes?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- fixtures -------------------------------------------------------------------

// An in-memory Granola API: honors page_size (capped at the fixture's own
// page size so pagination is exercised), updated_after filtering, offset
// cursors in the MEASURED envelope shape {notes, hasMore, cursor}, per-note
// detail, and per-note transcripts (404 when absent).
function makeGranolaFixture({ pageSize = 2 } = {}) {
  const fx = { notes: [], transcripts: new Map(), calls: [] };
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  fx.fetchImpl = async (href) => {
    const url = new URL(href);
    const params = Object.fromEntries(url.searchParams);
    fx.calls.push({ path: url.pathname, params, href });
    if (url.pathname === '/v1/notes') {
      let list = [...fx.notes];
      if (params.updated_after) {
        const after = Date.parse(params.updated_after);
        list = list.filter((n) => Date.parse(n.updated_at) > after);
      }
      const size = Math.min(Number(params.page_size ?? 30), pageSize);
      const offset = params.cursor ? Number(params.cursor.slice('off:'.length)) : 0;
      const page = list.slice(offset, offset + size);
      const hasMore = offset + size < list.length;
      return json(200, {
        notes: page.map((n) => ({
          id: n.id,
          object: 'note',
          title: n.title,
          owner: { name: 'Owner', email: 'owner@example.com' },
          created_at: n.created_at,
          updated_at: n.updated_at,
        })),
        hasMore,
        cursor: hasMore ? `off:${offset + size}` : '',
      });
    }
    const m = url.pathname.match(/^\/v1\/notes\/([^/]+)(\/transcript)?$/);
    if (m && m[2]) {
      const t = fx.transcripts.get(decodeURIComponent(m[1]));
      return t === undefined ? json(404, { error: 'no transcript' }) : json(200, t);
    }
    if (m) {
      const note = fx.notes.find((n) => n.id === decodeURIComponent(m[1]));
      return note === undefined ? json(404, { error: 'not found' }) : json(200, note);
    }
    return json(404, { error: 'unknown path' });
  };
  return fx;
}

function makeNote(id, { title, createdAt, updatedAt, summary, attendees, folder, event }) {
  return {
    id,
    object: 'note',
    title,
    created_at: createdAt,
    updated_at: updatedAt,
    summary_markdown: summary,
    attendees,
    folder,
    calendar_event: event,
  };
}

let stateCount = 0;
function freshState() {
  const s = openStateDb(join(dir, `state-${(stateCount += 1)}.db`));
  stateDbs.push(s);
  return s;
}

let logCount = 0;
function recordingLogger() {
  // The REAL logger (its forbidden-field tripwire must see every log call the
  // source makes), wrapped so tests can count events.
  const inner = createLogger({ path: join(dir, `log-${(logCount += 1)}.jsonl`) });
  const events = [];
  const wrap = (level) => (event, fields) => {
    events.push({ level, event, fields });
    inner[level](event, fields);
  };
  return { log: { info: wrap('info'), warn: wrap('warn'), error: wrap('error') }, events };
}

function stubIngest(recorded) {
  return async (rows) => {
    const list = Array.isArray(rows) ? rows : [rows];
    recorded.push(...list);
    return { inserted: list.length, updated: 0, unchanged: 0 };
  };
}

let cacheCount = 0;
function makeCtx({
  state, ingestFn, admin, config = {}, log, backfill = false, historyWindow,
  historyComplete = false,
}) {
  return {
    state,
    ingest: ingestFn,
    admin: admin ?? {
      deleteEntities: async () => {
        throw new Error('unexpected deleteEntities call');
      },
    },
    config,
    cacheDir: join(dir, `cache-${(cacheCount += 1)}`),
    log,
    now: Date.now,
    backfill,
    historyComplete,
    ...(historyWindow ? { history: true, historyWindow } : {}),
  };
}

function fakeClock(startMs = 1_000_000) {
  const sleeps = [];
  let t = startMs;
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

// --- pure transforms ------------------------------------------------------------

test('chunkTranscript: every chunk ≤ the byte cap, newline-preferring, lossless on line texts', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `spk_${i % 3}: ${'x'.repeat(80)} line ${i}`);
  const text = lines.join('\n');
  const chunks = chunkTranscript(text, 4096);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Buffer.byteLength(c, 'utf8') <= 4096);
  assert.equal(chunks.join('\n'), text); // newline splits lose nothing
  // A single oversize line hard-splits at code points instead of overflowing.
  const oversize = 'é'.repeat(5000); // 2 bytes per char: 10000 bytes
  const hard = chunkTranscript(oversize, 4096);
  assert.ok(hard.length >= 3);
  for (const c of hard) assert.ok(Buffer.byteLength(c, 'utf8') <= 4096);
  assert.equal(hard.join(''), oversize);
  assert.deepEqual(chunkTranscript('', 4096), []);
  assert.deepEqual(chunkTranscript('   \n \n', 4096), []); // whitespace-only is no transcript
});

test('extractTranscriptText tolerates the plausible payload shapes', () => {
  assert.equal(extractTranscriptText('plain text'), 'plain text');
  assert.equal(extractTranscriptText({ transcript: 'nested string' }), 'nested string');
  assert.equal(
    extractTranscriptText({ segments: [{ speaker: 'spk_1', text: 'hello' }, { text: 'unattributed' }] }),
    'spk_1: hello\nunattributed'
  );
  assert.equal(extractTranscriptText(null), '');
  assert.equal(extractTranscriptText({ something: 'else' }), '');
});

test('buildNoteRow: registry shape, sorted attendees, meeting-start ts, speaker null', () => {
  const detail = makeNote('na', {
    title: 'Weekly sync',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T11:00:00.000Z',
    summary: '## Notes\n- decided things',
    attendees: [{ name: 'Zed' }, { name: 'Ari' }, 'Mia', { email: 'no-name@example.com' }],
    folder: { name: 'Work' },
    event: { id: 'ev-a', start: { dateTime: '2026-08-10T09:30:00.000Z' } },
  });
  const row = buildNoteRow(detail, detail);
  assert.equal(row.entity_id, 'granola:na');
  assert.equal(row.source, 'granola');
  assert.equal(row.speaker, null);
  assert.equal(row.ts, Date.parse('2026-08-10T09:30:00.000Z')); // event start, not created_at
  assert.equal(
    row.text,
    'Weekly sync\nAttendees: Ari, Mia, Zed, no-name@example.com\n\n## Notes\n- decided things'
  );
  assert.deepEqual(row.meta, {
    note_id: 'na',
    updated_at: '2026-08-10T11:00:00.000Z',
    folder: 'Work',
    attendees: ['Ari', 'Mia', 'Zed', 'no-name@example.com'],
    participants: [
      { name: 'Ari' },
      { name: 'Mia' },
      { email: 'no-name@example.com' },
      { name: 'Zed' },
    ],
    calendar_event_id: 'ev-a',
  });
  // No calendar event → the note's created time carries the ts.
  const bare = makeNote('nb', {
    title: 'Ad-hoc chat',
    createdAt: '2026-08-11T08:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
    summary: 'quick summary',
  });
  const bareRow = buildNoteRow(bare, bare);
  assert.equal(bareRow.ts, Date.parse('2026-08-11T08:00:00.000Z'));
  assert.deepEqual(bareRow.meta.attendees, []);
  assert.deepEqual(bareRow.meta.participants, []);
  assert.equal(bareRow.meta.folder, null);
  assert.equal(bareRow.meta.calendar_event_id, null);
});

// --- client ---------------------------------------------------------------------

test('token bucket: a burst of 4 goes immediately, the 5th waits ~250 ms (fake clock)', async () => {
  const clock = fakeClock();
  const bucket = createTokenBucket({ now: clock.now, sleep: clock.sleep });
  for (let i = 0; i < 4; i += 1) await bucket.take();
  assert.deepEqual(clock.sleeps, []);
  await bucket.take();
  assert.equal(clock.sleeps.length, 1);
  assert.ok(clock.sleeps[0] >= 240 && clock.sleeps[0] <= 260, `slept ${clock.sleeps[0]} ms`);
});

test('429: Retry-After is honored (fake clock), then the retry succeeds', async () => {
  const clock = fakeClock();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: { 'retry-after': '3' },
      });
    }
    return new Response(JSON.stringify({ notes: [], hasMore: false, cursor: '' }), { status: 200 });
  };
  const client = createGranolaClient({
    keyFile,
    cacheDir: join(dir, `cache-${(cacheCount += 1)}`),
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
  const page = await client.listNotes();
  assert.equal(calls, 2);
  assert.ok(clock.sleeps.includes(3000), `sleeps ${JSON.stringify(clock.sleeps)} must include 3000`);
  assert.deepEqual(page, { notes: [], hasMore: false, cursor: '' });
});

test('429 forever: waits are bounded and the error carries .status 429', async () => {
  const clock = fakeClock();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'slow down' }), {
      status: 429,
      headers: { 'retry-after': '1' },
    });
  };
  const client = createGranolaClient({
    keyFile,
    cacheDir: join(dir, `cache-${(cacheCount += 1)}`),
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
  await assert.rejects(client.listNotes(), (error) => {
    assert.equal(error.status, 429);
    return true;
  });
  assert.equal(calls, 4); // the first try plus three Retry-After waits
  assert.equal(clock.sleeps.filter((ms) => ms === 1000).length, 3);
});

test('parseRetryAfterMs: delta-seconds, HTTP-date, and garbage', () => {
  const now = Date.parse('2026-08-19T00:00:00.000Z');
  assert.equal(parseRetryAfterMs('5', now), 5000);
  assert.equal(parseRetryAfterMs('Wed, 19 Aug 2026 00:00:02 GMT', now), 2000);
  assert.equal(parseRetryAfterMs('soonish', now), null);
  assert.equal(parseRetryAfterMs(undefined, now), null);
});

test('non-2xx answers throw .status errors that never quote the response body', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: 'secret meeting title leaked here' }), { status: 500 });
  const client = createGranolaClient({
    keyFile,
    cacheDir: join(dir, `cache-${(cacheCount += 1)}`),
    fetchImpl,
  });
  await assert.rejects(client.listNotes(), (error) => {
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes('leaked'), 'error message must not quote the body');
    return true;
  });
});

test('every raw response body is cached: sha256(url) name, 0600 file, 0700 dir', async () => {
  const fx = makeGranolaFixture();
  fx.notes.push(
    makeNote('nc', {
      title: 'Cache probe meeting',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      summary: 'cached',
    })
  );
  const cacheDir = join(dir, `cache-${(cacheCount += 1)}`, 'granola');
  const client = createGranolaClient({ keyFile, cacheDir, fetchImpl: fx.fetchImpl });
  const page = await client.listNotes({ pageSize: 5 });
  assert.equal(page.notes.length, 1);
  const href = fx.calls[0].href;
  const cachePath = join(cacheDir, `${createHash('sha256').update(href).digest('hex')}.json`);
  assert.ok(existsSync(cachePath), `expected cache file for ${href}`);
  assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')), page); // the raw body, verbatim
  // A different query = a different URL = a different cache file.
  await client.getNote('nc');
  const cached = fx.calls.map((c) =>
    join(cacheDir, `${createHash('sha256').update(c.href).digest('hex')}.json`)
  );
  assert.notEqual(cached[0], cached[1]);
  assert.ok(existsSync(cached[1]));
});

// --- source ---------------------------------------------------------------------

test('needs(): missing key file is named; a provisioned one clears it', async () => {
  const missing = createGranolaSource({ keyFile: join(dir, 'no-such-key.txt') });
  const needs = await missing.needs();
  assert.equal(needs.length, 1);
  assert.match(needs[0], /granola API key missing/);
  assert.deepEqual(await createGranolaSource({ keyFile }).needs(), []);
});

test('pagination stitches every page; rows follow the registry; the limitation is logged once', async () => {
  const fx = makeGranolaFixture({ pageSize: 2 });
  fx.notes.push(
    makeNote('n1', {
      title: 'Standup',
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      summary: 'daily sync summary',
      attendees: ['Zed', 'Ari'],
      event: { id: 'ev-1', start: { dateTime: '2026-08-01T08:45:00.000Z' } },
    }),
    makeNote('n2', {
      title: 'Design review',
      createdAt: '2026-08-02T09:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
      summary: 'design summary',
    }),
    makeNote('n3', {
      title: 'Retro',
      createdAt: '2026-08-03T09:00:00.000Z',
      updatedAt: '2026-08-03T10:00:00.000Z',
      summary: 'retro summary',
    })
  );
  const recorded = [];
  const { log, events } = recordingLogger();
  const source = createGranolaSource({ keyFile, fetchImpl: fx.fetchImpl });
  const ctx = makeCtx({ state: freshState(), ingestFn: stubIngest(recorded), log });
  const counts = await source.run(ctx);

  assert.deepEqual(counts, { ingested: 3, updated: 0, unchanged: 0, deleted: 0 });
  assert.deepEqual(
    recorded.map((r) => r.entity_id),
    ['granola:n1', 'granola:n2', 'granola:n3']
  );
  assert.equal(recorded[0].text, 'Standup\nAttendees: Ari, Zed\n\ndaily sync summary');
  assert.deepEqual(recorded[0].meta.attendees, ['Ari', 'Zed']); // pre-sorted for the content hash
  assert.equal(recorded[0].ts, Date.parse('2026-08-01T08:45:00.000Z'));
  for (const r of recorded) assert.equal(r.speaker, null);

  // Two list pages (2 + 1) stitched by the measured cursor field.
  const listCalls = fx.calls.filter((c) => c.path === '/v1/notes');
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[0].params.cursor, undefined);
  assert.equal(listCalls[1].params.cursor, 'off:2');
  assert.equal(
    listCalls[0].params.updated_after,
    new Date(new Date(Date.now()).getFullYear(), 0, 1).toISOString(),
    'a fresh steady lane starts at local New Year; the yearly history lane owns older notes'
  );

  // The summary-only API limitation is on the record exactly once per run.
  assert.equal(events.filter((e) => e.event === 'granola_summary_only').length, 1);
});

test('steady runs advance and use the updated_after cursor (max updated_at − 60 s)', async () => {
  const T1 = '2026-08-05T10:00:00.000Z';
  const T2 = '2026-08-05T11:30:00.000Z';
  const fx = makeGranolaFixture({ pageSize: 30 });
  fx.notes.push(
    makeNote('old', { title: 'Old note', createdAt: T1, updatedAt: T1, summary: 'old summary' }),
    makeNote('new', { title: 'New note', createdAt: T2, updatedAt: T2, summary: 'new summary' })
  );
  const state = freshState();
  const source = createGranolaSource({ keyFile, fetchImpl: fx.fetchImpl });
  const { log } = recordingLogger();

  const recordedFirst = [];
  await source.run(makeCtx({ state, ingestFn: stubIngest(recordedFirst), log }));
  assert.equal(recordedFirst.length, 2);
  const expectedCursor = new Date(Date.parse(T2) - 60_000).toISOString();
  assert.equal(state.getCursor(UPDATED_AFTER_CURSOR), expectedCursor);

  // Second run: the cursor rides the request, and only the note updated
  // inside the 60 s skew window (or later) comes back.
  const recordedSecond = [];
  await source.run(makeCtx({ state, ingestFn: stubIngest(recordedSecond), log }));
  const listCalls = fx.calls.filter((c) => c.path === '/v1/notes');
  assert.equal(listCalls.at(-1).params.updated_after, expectedCursor);
  assert.deepEqual(
    recordedSecond.map((r) => r.entity_id),
    ['granola:new']
  );

  // --backfill ignores the cursor and paginates everything again.
  const recordedBackfill = [];
  await source.run(makeCtx({ state, ingestFn: stubIngest(recordedBackfill), log, backfill: true }));
  assert.equal(fx.calls.filter((c) => c.path === '/v1/notes').at(-1).params.updated_after, undefined);
  assert.equal(recordedBackfill.length, 2);
});

test('yearly history ingests only the selected year and reports whether older notes exist', async () => {
  const fx = makeGranolaFixture({ pageSize: 1 });
  fx.notes.push(
    makeNote('older', {
      title: 'Older', createdAt: '2025-06-01T12:00:00.000Z',
      updatedAt: '2025-06-01T12:30:00.000Z', summary: 'older summary',
    }),
    makeNote('current', {
      title: 'Current', createdAt: '2026-03-01T12:00:00.000Z',
      updatedAt: '2026-03-01T12:30:00.000Z', summary: 'current summary',
    }),
  );
  const source = createGranolaSource({ keyFile, fetchImpl: fx.fetchImpl });
  const state = freshState();
  const recorded = [];
  const { log } = recordingLogger();
  const result = await source.run(makeCtx({
    state,
    ingestFn: stubIngest(recorded),
    log,
    historyWindow: {
      year: 2026,
      fromTs: new Date(2026, 0, 1).getTime(),
      toTs: new Date(2027, 0, 1).getTime(),
    },
  }));

  assert.deepEqual(recorded.map((row) => row.entity_id), ['granola:current']);
  assert.equal(result.historyDone, true);
  assert.equal(result.historyHasOlder, true);
  assert.equal(state.getCursor(UPDATED_AFTER_CURSOR), null, 'history never moves the forward cursor');
});

test('an old note edited today cannot bypass the year barrier', async () => {
  const fx = makeGranolaFixture({ pageSize: 30 });
  fx.notes.push(makeNote('old-edited', {
    title: 'Old but edited',
    createdAt: '2025-04-01T12:00:00.000Z',
    updatedAt: '2026-08-28T12:00:00.000Z',
    summary: 'edited summary',
  }));
  const state = freshState();
  const source = createGranolaSource({ keyFile, fetchImpl: fx.fetchImpl });
  const { log } = recordingLogger();
  const beforeBarrier = [];
  await source.run(makeCtx({ state, ingestFn: stubIngest(beforeBarrier), log }));
  assert.deepEqual(beforeBarrier, []);
  assert.equal(state.getCursor(UPDATED_AFTER_CURSOR), null,
    'the skipped update remains observable after the historical queue completes');

  const afterBarrier = [];
  await source.run(makeCtx({
    state,
    ingestFn: stubIngest(afterBarrier),
    log,
    historyComplete: true,
  }));
  assert.deepEqual(afterBarrier.map((row) => row.entity_id), ['granola:old-edited']);
});

test('hasMore without a cursor refuses loudly instead of looping', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ notes: [], hasMore: true, cursor: '' }), { status: 200 });
  const source = createGranolaSource({ keyFile, fetchImpl });
  const { log } = recordingLogger();
  await assert.rejects(
    source.run(makeCtx({ state: freshState(), ingestFn: stubIngest([]), log })),
    /hasMore but sent no cursor/
  );
});

test('note edit lands as updated:1 through the REAL hermes upsert', async () => {
  const fx = makeGranolaFixture({ pageSize: 30 });
  const note = makeNote('ne', {
    title: 'Budget meeting',
    createdAt: '2026-08-10T14:00:00.000Z',
    updatedAt: '2026-08-10T15:00:00.000Z',
    summary: 'first cut of the budget',
    attendees: ['Ari'],
  });
  fx.notes.push(note);
  const state = freshState();
  const { log } = recordingLogger();
  const source = createGranolaSource({ keyFile, fetchImpl: fx.fetchImpl });
  const ctx = () =>
    makeCtx({ state, ingestFn: (rows) => ingest(rows, hermesOpts), log });

  assert.deepEqual(await source.run(ctx()), { ingested: 1, updated: 0, unchanged: 0, deleted: 0 });
  // Redelivery inside the 60 s skew window is free: unchanged, not updated.
  assert.deepEqual(await source.run(ctx()), { ingested: 0, updated: 0, unchanged: 1, deleted: 0 });
  // A real edit (summary + updated_at) lands as an in-place update.
  note.summary_markdown = 'final budget, approved';
  note.updated_at = '2026-08-10T16:00:00.000Z';
  assert.deepEqual(await source.run(ctx()), { ingested: 0, updated: 1, unchanged: 0, deleted: 0 });
});

test('transcripts: ≤16 KiB chunk rows, and a shrunken transcript deletes its stale tail', async () => {
  const fx = makeGranolaFixture({ pageSize: 30 });
  const tsIso = '2026-07-01T09:00:00.000Z';
  const note = makeNote('nt', {
    title: 'Long recorded meeting',
    createdAt: tsIso,
    updatedAt: '2026-07-01T10:00:00.000Z',
    summary: 'covered a lot',
  });
  fx.notes.push(note);
  const longTranscript = {
    segments: Array.from({ length: 100 }, (_, i) => ({
      speaker: `spk_${i % 2}`,
      text: `${'x'.repeat(400)} segment ${i}`,
    })),
  };
  fx.transcripts.set('nt', longTranscript);
  const expectedChunks = chunkTranscript(extractTranscriptText(longTranscript));
  assert.ok(expectedChunks.length >= 3, 'fixture must force multiple chunks');

  const state = freshState();
  const { log } = recordingLogger();
  const source = createGranolaSource({ keyFile, fetchImpl: fx.fetchImpl });
  const admin = {
    deleteEntities: async (args) => {
      const { adminDeleteEntities } = await import('../lib/ingestClient.mjs');
      return adminDeleteEntities(args, hermesOpts);
    },
  };
  const ctx = () =>
    makeCtx({
      state,
      ingestFn: (rows) => ingest(rows, hermesOpts),
      admin,
      config: { granola: { includeTranscripts: true } },
      log,
    });

  const first = await source.run(ctx());
  assert.equal(first.ingested, 1 + expectedChunks.length);
  assert.equal(first.deleted, 0);
  assert.equal(state.getCursor('granola:chunks:nt'), String(expectedChunks.length));

  const ts = Date.parse(tsIso);
  const held = await adminEntities({ source: 'granola', fromTs: ts - 1000, toTs: ts + 1000 }, hermesOpts);
  const heldIds = held.map((e) => e.entity_id).sort();
  assert.deepEqual(
    heldIds,
    ['granola:nt', ...expectedChunks.map((_, n) => `granola:nt:t${n}`)].sort()
  );

  // The transcript shrinks to one chunk: the tail must be deleted, not haunt.
  fx.transcripts.set('nt', { segments: [{ speaker: 'spk_0', text: 'short wrap-up' }] });
  note.updated_at = '2026-07-01T11:00:00.000Z';
  const second = await source.run(ctx());
  assert.equal(second.deleted, expectedChunks.length - 1);
  assert.equal(second.updated >= 1, true); // t0 content changed, plus the note row
  assert.equal(state.getCursor('granola:chunks:nt'), '1');
  const after2 = await adminEntities({ source: 'granola', fromTs: ts - 1000, toTs: ts + 1000 }, hermesOpts);
  assert.deepEqual(
    after2.map((e) => e.entity_id).sort(),
    ['granola:nt', 'granola:nt:t0']
  );

  // A vanished transcript (404) means zero chunks — the last one goes too.
  fx.transcripts.delete('nt');
  note.updated_at = '2026-07-01T12:00:00.000Z';
  const third = await source.run(ctx());
  assert.equal(third.deleted, 1);
  assert.equal(state.getCursor('granola:chunks:nt'), '0');
  const after3 = await adminEntities({ source: 'granola', fromTs: ts - 1000, toTs: ts + 1000 }, hermesOpts);
  assert.deepEqual(after3.map((e) => e.entity_id), ['granola:nt']);
});

// --- live smoke -----------------------------------------------------------------

// The one sanctioned live call (owner-approved account): GET /notes?page_size=1,
// asserting the measured envelope and printing COUNTS ONLY — never a title,
// summary, or attendee. Skips cleanly when the key is not provisioned.
test(
  'live smoke: /notes?page_size=1 answers the measured envelope',
  { skip: existsSync(defaultGranolaKeyPath()) ? false : 'granola API key not provisioned' },
  async () => {
    const client = createGranolaClient({
      cacheDir: join(dir, 'cache-live', 'granola'),
      timeoutMs: 20_000,
    });
    const page = await client.listNotes({ pageSize: 1 });
    assert.ok(Array.isArray(page.notes), 'envelope field `notes` must be an array');
    assert.equal(typeof page.hasMore, 'boolean', 'envelope field `hasMore` must be a boolean');
    assert.ok('cursor' in page, 'envelope must carry `cursor`');
    assert.ok(page.notes.length <= 1);
    console.log(`granola live smoke: notes_page=${page.notes.length} hasMore=${page.hasMore}`);
  }
);

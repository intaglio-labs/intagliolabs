// Exhaustive hierarchical year summaries: every direct-message row enters one
// month-bounded reduction, unchanged months reuse their private derived cache,
// and the UI receives honest coverage plus a structured annual synthesis.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows, resolvePeopleSummariesPath, start } from '../server/hermes.mjs';
import {
  chunkRows, coverageForRows, gatherRows, summarizeYear, sampleRows,
  clearSummariesStorage, isSummarySource, MIN_ROWS, openSummariesDb,
  packChunkBatches, readCachedSummary, SUMMARY_REVISION, summaryStillValid,
} from '../server/people/summary.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const HANDLE = '+18085550100';
const LLAMA = { baseUrl: 'http://127.0.0.1:51780', apiKey: () => 'k' };

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name] of pairs) ins.run(id, name, 'phone', NOW);
  return db;
}

function msgRow(ts, text, fromMe = false, source = 'imessage') {
  return { ts, source, entity_id: `${source}:${ts}:${text}`, text, meta: { chat_handle: HANDLE, is_from_me: fromMe } };
}

function modelFetch(calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const schema = body.response_format?.json_schema?.name;
    calls.push({ url, body, schema });
    const chunk = {
      summary: 'Surf travel and project plans recurred.',
      themes: ['surf travel', 'project planning'], developments: ['Compared destinations'],
      patterns: ['Frequent planning'], open_loops: ['Choose dates'],
    };
    const ids = [...body.messages[1].content.matchAll(/^ID: (m\d+-p\d+)$/gmu)].map((match) => match[1]);
    const value = schema === 'relationship_summary_chunk' ? chunk
      : schema === 'relationship_summary_chunk_batch' ? {
        reductions: ids.map((id) => ({ id, ...chunk })),
      } : {
      overview: 'Surf travel and project planning shaped the year, with concrete destination comparisons and dates still open.',
      recurring_themes: ['Surf travel', 'Project planning'],
      relationship_evolution: ['Plans became more specific later in the year'],
      notable_moments: ['Compared destinations'],
      communication_patterns: ['Planning arrived in concentrated conversations'],
      open_loops: ['Choose dates'],
    };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) };
  };
}

test('thin input never reaches the model', async () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [msgRow(new Date(2026, 3, 1).getTime(), 'a single long-enough message about surfing')]);
  const spine = spineDb([[HANDLE, 'Sam Lee']]);
  let called = 0;
  const out = await summarizeYear(ctx, spine, {
    personKey: 'name:sam lee', year: 2026, now: NOW,
    owner: { addresses: new Set(), names: [] }, llama: LLAMA,
    fetchFn: async () => { called += 1; throw new Error('must not be called'); },
    summariesDb: openSummariesDb(':memory:'),
  });
  assert.equal(called, 0);
  assert.equal(out.text, null);
  assert.match(out.reason, /substantive messages/u);
});

test('every message reaches a monthly chunk exactly once', () => {
  const jan = new Date(2026, 0, 2).getTime();
  const feb = new Date(2026, 1, 2).getTime();
  const rows = [
    { ts: jan, source: 'imessage', fromMe: true, text: 'one' },
    { ts: jan + 1, source: 'imessage', fromMe: false, text: 'two' },
    { ts: jan + 2, source: 'imessage', fromMe: true, text: 'three' },
    { ts: feb, source: 'whatsapp', fromMe: false, text: 'four' },
  ];
  const chunks = chunkRows(rows, { rowCap: 2, charCap: 10_000 });
  assert.deepEqual(chunks.map((chunk) => chunk.month), [1, 1, 2]);
  assert.deepEqual(chunks.flatMap((chunk) => chunk.rows), rows);
  assert.deepEqual(sampleRows(rows), rows, 'compatibility helper no longer samples');
});

test('compatible monthly chunks share bounded model passes without changing order', () => {
  const chunks = Array.from({ length: 6 }, (_, i) => ({
    month: i + 1, index: 0,
    rows: [{ ts: new Date(2026, i, 1).getTime(), source: 'imessage', fromMe: false, text: 'x'.repeat(100) }],
  }));
  const batches = packChunkBatches(chunks, 2026, { charCap: 10_000, itemCap: 4 });
  assert.deepEqual(batches.map((batch) => batch.length), [4, 2]);
  assert.deepEqual(batches.flat(), chunks);
});

test('a real year returns exhaustive coverage and deeper sections from loopback JSON-schema calls', async () => {
  const ctx = openDb(':memory:');
  const y0 = new Date(2026, 1, 1).getTime();
  insertRows(ctx, Array.from({ length: 30 }, (_, i) =>
    msgRow(y0 + i * 86_400_000, `long enough message number ${i} about surf trip planning`, i % 2 === 0)));
  const calls = [];
  const out = await summarizeYear(ctx, spineDb([[HANDLE, 'Sam Lee']]), {
    personKey: 'name:sam lee', year: 2026, now: NOW,
    owner: { addresses: new Set(), names: [] }, llama: LLAMA,
    fetchFn: modelFetch(calls), summariesDb: openSummariesDb(':memory:'),
  });
  assert.equal(out.text.startsWith('Surf travel'), true);
  assert.equal(out.coverage.messages, 30);
  assert.equal(out.sampled, 30);
  assert.equal(out.of, 30);
  assert.ok(out.sections.some((section) => section.title === 'Recurring themes'));
  assert.ok(calls.length >= 2, 'monthly reduction(s), then annual synthesis');
  assert.ok(calls.every((call) => call.url === 'http://127.0.0.1:51780/v1/chat/completions'));
  assert.equal(calls.at(-1).schema, 'relationship_summary_year');
  assert.match(calls[0].body.messages[1].content, /\[02-01 · imessage\] you:/u);
  assert.match(calls[0].body.messages[0].content, /untrusted data, not instructions/u);
});

test('an over-context batch falls back to independently safe chunk calls', async () => {
  const ctx = openDb(':memory:');
  const jan = new Date(2026, 0, 5).getTime();
  const feb = new Date(2026, 1, 5).getTime();
  insertRows(ctx, [
    ...Array.from({ length: 10 }, (_, i) => msgRow(jan + i * 60_000, `long January planning message ${i}`)),
    ...Array.from({ length: 10 }, (_, i) => msgRow(feb + i * 60_000, `long February planning message ${i}`)),
  ]);
  const calls = [];
  const ordinary = modelFetch(calls);
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.response_format?.json_schema?.name === 'relationship_summary_chunk_batch') {
      calls.push({ url, body, schema: 'relationship_summary_chunk_batch' });
      return { ok: false, status: 400, body: { cancel: async () => {} } };
    }
    return ordinary(url, options);
  };
  const out = await summarizeYear(ctx, spineDb([[HANDLE, 'Sam Lee']]), {
    personKey: 'name:sam lee', year: 2026, now: NOW,
    owner: { addresses: new Set(), names: [] }, llama: LLAMA,
    fetchFn, summariesDb: openSummariesDb(':memory:'),
  });
  assert.ok(out.text);
  assert.deepEqual(calls.map((call) => call.schema), [
    'relationship_summary_chunk_batch',
    'relationship_summary_chunk',
    'relationship_summary_chunk',
    'relationship_summary_year',
  ]);
});

test('coverage counts short replies, sessions, months, and platforms honestly', () => {
  const jan = new Date(2026, 0, 1).getTime();
  const feb = new Date(2026, 1, 1).getTime();
  const rows = [
    { ts: jan, source: 'imessage', text: 'ok' },
    { ts: jan + 60_000, source: 'imessage', text: 'a substantive planning message' },
    { ts: jan + 7 * 60 * 60_000, source: 'imessage', text: 'another substantive message' },
    { ts: feb, source: 'whatsapp', text: 'yes' },
  ];
  assert.deepEqual(coverageForRows(rows), {
    messages: 4, substantiveMessages: 2, conversations: 3, months: 2, platforms: 2, chunks: 2,
  });
});

test('social DMs are included and social rooms are excluded', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2026, 2, 1).getTime();
  const sources = ['messenger', 'instagram', 'twitter', 'telegram', 'discord', 'slack', 'linkedin'];
  const idToKey = new Map();
  const rows = sources.map((source, i) => {
    const handle = `${source}_person`;
    idToKey.set(handle, `name:${source} person`);
    return {
      ts: y + i * 86_400_000, source, entity_id: `${source}:summary-direct`,
      text: `a substantive direct message about our ${source} project plans`,
      meta: { chat_handle: handle, is_group: false, is_from_me: i % 2 === 0 },
    };
  });
  rows.push({
    ts: y + 20 * 86_400_000, source: 'discord', entity_id: 'discord:summary-room',
    text: 'a substantive room message that must not enter a two-person summary',
    meta: { chat_handle: 'discord_room', sender_handle: 'discord_group_sender', is_group: true, is_from_me: false },
  });
  idToKey.set('discord_group_sender', 'name:discord group sender');
  insertRows(ctx, rows);
  for (const source of sources) {
    assert.equal(gatherRows(ctx, idToKey, `name:${source} person`, 2026).length, 1);
  }
  assert.deepEqual(gatherRows(ctx, idToKey, 'name:discord group sender', 2026), []);
});

test('unchanged month reductions are reused while a changed month and annual synthesis regenerate', async () => {
  const ctx = openDb(':memory:');
  const jan = new Date(2026, 0, 5).getTime();
  const feb = new Date(2026, 1, 5).getTime();
  insertRows(ctx, [
    ...Array.from({ length: 10 }, (_, i) => msgRow(jan + i * 60_000, `long January planning message ${i}`)),
    ...Array.from({ length: 10 }, (_, i) => msgRow(feb + i * 60_000, `long February planning message ${i}`)),
  ]);
  const calls = [];
  const sdb = openSummariesDb(':memory:');
  const opts = {
    personKey: 'name:sam lee', year: 2026, now: NOW,
    owner: { addresses: new Set(), names: [] }, llama: LLAMA,
    fetchFn: modelFetch(calls), summariesDb: sdb,
  };
  const spine = spineDb([[HANDLE, 'Sam Lee']]);
  const first = await summarizeYear(ctx, spine, opts);
  assert.equal(calls.length, 2, 'two compatible months share one reduction pass, then annual synthesis');
  const second = await summarizeYear(ctx, spine, opts);
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(calls.length, 2, 'exact evidence hit makes no model call');

  insertRows(ctx, [msgRow(feb + 20 * 60_000, 'a new substantive February message')]);
  await summarizeYear(ctx, spine, opts);
  assert.equal(calls.length, 4, 'January reused; February and annual synthesis regenerated');
  sdb.close();
});

test('a dense month is consolidated before the annual pass instead of overflowing it', async () => {
  const ctx = openDb(':memory:');
  const jan = new Date(2026, 0, 5).getTime();
  insertRows(ctx, Array.from({ length: 601 }, (_, i) =>
    msgRow(jan + i * 1000, `long dense-month planning message ${i}`, i % 2 === 0)));
  const calls = [];
  const out = await summarizeYear(ctx, spineDb([[HANDLE, 'Sam Lee']]), {
    personKey: 'name:sam lee', year: 2026, now: NOW,
    owner: { addresses: new Set(), names: [] }, llama: LLAMA,
    fetchFn: modelFetch(calls), summariesDb: openSummariesDb(':memory:'),
  });
  assert.equal(out.coverage.messages, 601);
  assert.equal(out.coverage.chunks, 2);
  assert.equal(calls.length, 3, 'two raw chunks share a pass, then one month consolidation and annual synthesis');
  assert.equal(calls.at(-1).schema, 'relationship_summary_year');
  const annualEvidence = calls.at(-1).body.messages[1].content;
  assert.equal((annualEvidence.match(/"month":"January"/gu) || []).length, 1,
    'the annual prompt receives one bounded record for the dense month');
});

test('cache validity is exact and the revision marks the exhaustive format', () => {
  assert.equal(SUMMARY_REVISION, 5);
  const fingerprint = 'a'.repeat(64);
  assert.equal(summaryStillValid(fingerprint, fingerprint), true);
  assert.equal(summaryStillValid(fingerprint, 'b'.repeat(64)), false);
  assert.equal(summaryStillValid(30, 30), false);
  assert.ok(MIN_ROWS >= 10);
});

test('privacy deletion physically clears derived summaries and chunk evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-privacy-'));
  const path = join(dir, 'summaries.db');
  const token = 'private-derived-summary-xylocarp';
  const db = openSummariesDb(path);
  db.prepare(
    'INSERT INTO summaries ' +
    '(person_key,year,text,rows_seen,generated_ms,code_rev,evidence_hash,coverage_json,sections_json) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('person', 2026, token, 20, 1, SUMMARY_REVISION, 'a'.repeat(64), '{}', '[]');
  db.prepare(
    'INSERT INTO summary_chunks ' +
    '(person_key,year,month,chunk_index,fingerprint,reduction_json,messages,generated_ms,code_rev) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('person', 2026, 1, 0, 'b'.repeat(64), JSON.stringify({ summary: token }), 20, 1, SUMMARY_REVISION);
  db.close();
  assert.equal(readFileSync(path).includes(token), true, 'fixture is physically present before deletion');
  assert.deepEqual(clearSummariesStorage(path), { cleared: 2 });
  const clean = openSummariesDb(path);
  assert.equal(clean.prepare('SELECT count(*) AS n FROM summaries').get().n, 0);
  assert.equal(clean.prepare('SELECT count(*) AS n FROM summary_chunks').get().n, 0);
  clean.close();
  assert.equal(readFileSync(path).includes(token), false, 'VACUUM removes the old prose from the database file');
  rmSync(dir, { recursive: true, force: true });
});

test('the derived summary store is owner-only, hardened, and refuses symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-hardening-'));
  const path = join(dir, 'summaries.db');
  const db = openSummariesDb(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
  assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'delete');
  assert.equal(db.prepare('PRAGMA temp_store').get().temp_store, 2);
  db.close();

  const link = join(dir, 'summary-link.db');
  symlinkSync(path, link);
  assert.throws(() => openSummariesDb(link), /owner-owned regular file/u);
  rmSync(dir, { recursive: true, force: true });
});

test('custom corpus paths never reuse the default profile summary store', () => {
  assert.equal(resolvePeopleSummariesPath({
    configuredDbPath: '/private/tmp/custom/context.db',
    resolvedDbPath: '/private/tmp/custom/context.db',
  }), '/private/tmp/custom/context.db.people-summaries');
  assert.equal(resolvePeopleSummariesPath({
    configuredDbPath: ':memory:', resolvedDbPath: ':memory:',
  }), ':memory:');
  assert.equal(resolvePeopleSummariesPath({
    explicitPath: '/private/tmp/test-summary.db',
    configuredDbPath: '/private/tmp/custom/context.db',
    resolvedDbPath: '/private/tmp/custom/context.db',
  }), '/private/tmp/test-summary.db');
});

test('stale-while-refresh reads only the derived summary payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-stale-'));
  const path = join(dir, 'summaries.db');
  const db = openSummariesDb(path);
  db.prepare(
    'INSERT INTO summaries ' +
    '(person_key,year,text,rows_seen,generated_ms,code_rev,evidence_hash,coverage_json,sections_json) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    'person', 2026, 'Cached relationship overview.', 20, 1, SUMMARY_REVISION,
    'a'.repeat(64), JSON.stringify({ messages: 20, months: 2 }),
    JSON.stringify([{ title: 'Recurring themes', items: ['Travel'] }]),
  );
  db.close();
  assert.deepEqual(readCachedSummary(path, 'person', 2026), {
    text: 'Cached relationship overview.',
    coverage: { messages: 20, months: 2 },
    sections: [{ title: 'Recurring themes', items: ['Travel'] }],
  });
  assert.equal(readCachedSummary(path, 'missing', 2026), null);
  rmSync(dir, { recursive: true, force: true });
});

test('only message sources invalidate relationship summaries', () => {
  assert.equal(isSummarySource('imessage'), true);
  assert.equal(isSummarySource('telegram'), true);
  assert.equal(isSummarySource('calendar'), false);
});

test('an idempotent message-source purge also physically clears derived summaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-route-purge-'));
  const dbPath = join(dir, 'context.db');
  const summariesPath = join(dir, 'summaries.db');
  const token = 'a'.repeat(64);
  const llamaKey = 'b'.repeat(64);
  const derived = openSummariesDb(summariesPath);
  derived.prepare(
    'INSERT INTO summaries ' +
    '(person_key,year,text,rows_seen,generated_ms,code_rev,evidence_hash,coverage_json,sections_json) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('person', 2026, 'Private derived prose.', 20, 1, SUMMARY_REVISION, 'c'.repeat(64), '{}', '[]');
  derived.close();

  const running = await start({
    port: 0, dbPath, peopleSummariesPath: summariesPath,
    bearerToken: token, llamaApiKey: llamaKey,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/admin/purge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'imessage' }),
    });
    assert.equal(response.status, 200);
    const clean = openSummariesDb(summariesPath);
    assert.equal(clean.prepare('SELECT count(*) AS n FROM summaries').get().n, 0);
    clean.close();
    assert.equal(readFileSync(summariesPath).includes('Private derived prose.'), false);
  } finally {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Tests for public lookup (L5 step 6): buildLookupQuery's input gate,
// parseLookupStream's stream-json reader, groundLookup's grounding rules
// (all pure, no DB), the DB half -- anchorsFor, lookupScope, lookupGate,
// storeLookup, lookupPerson, runLookupPass -- and the HTTP routes
// (/admin/relationship/lookup, /lookup/person, /lookups; /stats.lookup;
// the card's `changed` field).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openDb, start } from '../server/hermes.mjs';
import {
  buildLookupQuery, parseLookupStream, groundLookup,
  anchorsFor, lookupScope, lookupGate, storeLookup, lookupPerson, runLookupPass,
  LOOKUP_REFRESH_DAYS,
} from '../server/relationship/lookup.mjs';

const TOKEN = 'b'.repeat(64);

const NOW = Date.parse('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const day = (offsetDays) => new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);

// Same shape ui/test/relationship-producer.test.mjs and
// ui/test/relationship-sweep.test.mjs already build fixtures on: hermes' own
// in-memory schema (openDb(':memory:')), so every gate here runs against the
// real tables the projection writes rather than a shape that merely looks
// like them.
function insertPerson(db, {
  key, name, role = 'friend', subRoles = [], sent = 1, received = 0, met = 0, linkedin = null,
}) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, NOW - 400 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY,
    sent, received, met, 0, sent + received, 0, role, '{}',
    linkedin ? JSON.stringify(linkedin) : null, NOW, JSON.stringify(subRoles));
}

function insertActiveDay(db, key, activeDay) {
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, activeDay);
}

// A directly-authored message row: the strongest "wrote to you" signal
// eligiblePool's own SQL requires (see producer.mjs's poolSql).
function insertAuthored(db, key, { ts = NOW - 200 * DAY } = {}) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', 'hi', '{}')"
  ).run(ts).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, 'conv')`
  ).run(key, ctxId);
}

function fakeEngine(name, complete) {
  return { name, model: 'fake', counters: { calls: 0, totalCostUsd: 0, totalDurationMs: 0, errors: 0 }, complete };
}

// A minimal but real stream-json `type:'result'` line -- parseLookupStream
// only needs this one line to extract envelopeText and costUsd; the
// assistant/user tool_use/tool_result lines matter only when a test cares
// about searches/urls/resultText (covered above).
function fakeRawResult(envelope, { cost = 0.01 } = {}) {
  return JSON.stringify({ type: 'result', total_cost_usd: cost, is_error: false, result: JSON.stringify(envelope) }) + '\n';
}

const here = dirname(fileURLToPath(import.meta.url));
const REAL_STREAM_FIXTURE = readFileSync(join(here, 'fixtures', 'lookup-stream.txt'), 'utf8');

// --- buildLookupQuery --------------------------------------------------------

test('buildLookupQuery refuses an object whose getter could leak, without ever calling it', () => {
  // A genuine Proxy, wrapping a target whose 'name' property (an
  // ALLOWLISTED field name) is a real accessor that throws 'LEAKED' if
  // invoked. The input gate reads Object.getOwnPropertyDescriptors, whose
  // descriptor for an accessor property carries a `get` function, never a
  // `value` -- so the gate must refuse this BEFORE reading anchors.name (or
  // anything from it), on the descriptor shape alone.
  const target = {};
  Object.defineProperty(target, 'name', {
    get() { throw new Error('LEAKED'); },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(target, 'firm', {
    value: 'Acme', enumerable: true, configurable: true, writable: true,
  });
  const leaky = new Proxy(target, {});

  assert.throws(() => buildLookupQuery(leaky), /allowlisted public identifier/);
  // MUTATION CHECK: an implementation that reads `anchors.name` (or spreads
  // `anchors`) instead of reading `.value` off an already-fetched descriptor
  // would throw 'LEAKED' here instead of the allowlist message above --
  // confirmed by temporarily reading anchors.name directly, which does throw
  // 'LEAKED' rather than the allowlist error.
  assert.throws(() => { void leaky.name; }, /LEAKED/);
});

test('buildLookupQuery refuses a whole people row', () => {
  // The shape people/projection.mjs actually stores, not a fixture
  // buildLookupQuery would ever be handed correctly (anchorsFor, DB half,
  // builds a {name,firm,handle,profileUrl} object from these fields, never
  // passes the row itself) -- this is the "what if a caller got that step
  // wrong" test.
  const row = {
    person_key: 'p:jane', display_name: 'Jane Doe', role: 'business',
    sub_roles: '[]', linkedin: null,
  };
  assert.throws(() => buildLookupQuery(row), /allowlisted public identifier/);
});

test('buildLookupQuery returns null on a single anchor', () => {
  assert.equal(buildLookupQuery({ name: 'Jane Doe' }), null);
  assert.equal(buildLookupQuery({ firm: 'Acme' }), null, 'a firm with no name is not a person to look up');
});

test('buildLookupQuery never lets an email through', () => {
  assert.throws(() => buildLookupQuery({ name: 'jane@example.test', firm: 'Acme' }), /allowlisted public identifier/);
  assert.throws(() => buildLookupQuery({ name: 'Jane Doe', firm: 'sales@acme.test' }), /allowlisted public identifier/);
});

test('buildLookupQuery output contains only anchor values, char for char', () => {
  const result = buildLookupQuery({ name: 'Jane Doe', firm: 'Acme Corp', handle: null, profileUrl: undefined });
  assert.ok(result);
  assert.equal(result.query, '"Jane Doe" "Acme Corp"');
  assert.deepEqual(result.fieldsUsed, ['firm', 'name']);
  assert.equal(typeof result.queryHash, 'string');
  assert.equal(result.queryHash.length, 64);
});

test('buildLookupQuery drops a malformed handle/profileUrl rather than throwing, and still needs a second anchor', () => {
  assert.equal(
    buildLookupQuery({ name: 'Jane Doe', handle: 'not a handle!!', profileUrl: 'https://not-linkedin.test/x' }),
    null,
    'both format checks fail, so no second anchor survives'
  );
  const withGoodHandle = buildLookupQuery({ name: 'Jane Doe', handle: '@janedoe' });
  assert.ok(withGoodHandle);
  assert.ok(withGoodHandle.query.includes('@janedoe'));
});

// --- parseLookupStream --------------------------------------------------------

test('parseLookupStream reads a real captured transcript (one search)', () => {
  const observed = parseLookupStream(REAL_STREAM_FIXTURE);
  assert.equal(observed.searches, 1);
  assert.ok(observed.urls.has('https://www.sqlite.org/walformat.html'));
  assert.ok(observed.resultText.includes('Web search results for query'));
  assert.equal(typeof observed.costUsd, 'number');
  assert.ok(observed.costUsd > 0);
  assert.ok(typeof observed.envelopeText === 'string' && observed.envelopeText.length > 0);
});

// Modeled on the exact assistant tool_use / user tool_result line shapes in
// the real captured fixture above (ui/test/fixtures/lookup-stream.txt),
// duplicated for a second WebSearch call -- the real capture only ever made
// one search, and this is the shape a two-search pass takes.
function twoSearchStream() {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'Jane Doe Acme' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content:
        'Web search results for query: "Jane Doe Acme"\n\nLinks: [{"title":"Jane Doe - Acme","url":"https://acme.example/team/jane"}]\n\nJane Doe is VP of Engineering at Acme.\n\nREMINDER: cite sources' },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't2', name: 'WebSearch', input: { query: 'Jane Doe LinkedIn' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 't2', content:
        'Web search results for query: "Jane Doe LinkedIn"\n\nLinks: [{"title":"Jane Doe | LinkedIn","url":"https://www.linkedin.com/in/janedoe"}]\n\nJane Doe recently raised a seed round.\n\nREMINDER: cite sources' },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: '{"identity_confidence":"match","changes":[]}' },
    ] } }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.0512, is_error: false,
      result: '{"identity_confidence":"match","changes":[]}' }),
  ];
  return lines.join('\n');
}

test('parseLookupStream collects every URL the WebSearch tool returned, across two searches, plus cost', () => {
  const observed = parseLookupStream(twoSearchStream());
  assert.equal(observed.searches, 2);
  assert.deepEqual(
    [...observed.urls].sort(),
    ['https://acme.example/team/jane', 'https://www.linkedin.com/in/janedoe']
  );
  assert.equal(observed.costUsd, 0.0512);
  assert.ok(observed.resultText.includes('VP of Engineering'));
  assert.ok(observed.resultText.includes('raised a seed round'));
});

test('parseLookupStream fails closed when no Links array parses, and groundLookup then keeps nothing', () => {
  const brokenStream = [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'Jane Doe' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [
      // No "Links: [...]" segment at all -- an undocumented format change,
      // or a search that returned no results in whatever shape the model
      // saw. Either way this must contribute zero URLs, never guess one.
      { type: 'tool_result', tool_use_id: 't1', content: 'Web search results for query: "Jane Doe"\n\nNothing found.' },
    ] } }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.01, is_error: false,
      result: '{"identity_confidence":"match","changes":[{"kind":"role","text":"promoted","url":"https://acme.example/news","quote":"Nothing found."}]}' }),
  ].join('\n');

  const observed = parseLookupStream(brokenStream);
  assert.equal(observed.urls.size, 0, 'no Links array parsed anywhere, so the observed-URL allowlist is empty');

  const envelope = JSON.parse(observed.envelopeText);
  const { kept, dropped } = groundLookup(envelope, observed);
  assert.deepEqual(kept, []);
  assert.ok(dropped.length > 0);
});

// --- groundLookup -------------------------------------------------------------

function observedFixture({ urls = [], resultText = '' } = {}) {
  return { envelopeText: null, urls: new Set(urls), resultText, searches: 1, costUsd: 0.01 };
}

test('groundLookup drops a url the search never returned', () => {
  const observed = observedFixture({
    urls: ['https://acme.example/news'],
    resultText: 'Jane Doe was promoted to VP of Engineering in March.',
  });
  const envelope = {
    identity_confidence: 'match',
    changes: [{
      kind: 'role', text: 'Promoted to VP', quote: 'promoted to VP of Engineering',
      // A different, plausible-looking URL the search itself never returned.
      url: 'https://not-a-real-result.example/jane',
    }],
  };
  const { kept, dropped } = groundLookup(envelope, observed);
  assert.deepEqual(kept, []);
  assert.equal(dropped.length, 1);
});

test('groundLookup drops a quote that is not verbatim in the search results', () => {
  const observed = observedFixture({
    urls: ['https://acme.example/news'],
    resultText: 'Jane Doe was promoted to VP of Engineering in March.',
  });
  const envelope = {
    identity_confidence: 'match',
    changes: [{
      kind: 'role', text: 'Promoted to VP', url: 'https://acme.example/news',
      // Close, but not a verbatim substring -- composed rather than copied.
      quote: 'Jane Doe became VP of Engineering',
    }],
  };
  const { kept, dropped } = groundLookup(envelope, observed);
  assert.deepEqual(kept, []);
  assert.equal(dropped.length, 1);
});

test('groundLookup drops a non-https url and a denylisted host', () => {
  const observed = observedFixture({
    urls: ['http://acme.example/news', 'https://mail.google.com/mail/u/0/#inbox/xyz'],
    resultText: 'Jane Doe was promoted to VP of Engineering in March.',
  });
  const envelope = {
    identity_confidence: 'match',
    changes: [
      { kind: 'role', text: 'Promoted', url: 'http://acme.example/news', quote: 'promoted to VP of Engineering' },
      { kind: 'role', text: 'Promoted', url: 'https://mail.google.com/mail/u/0/#inbox/xyz', quote: 'promoted to VP of Engineering' },
    ],
  };
  const { kept, dropped } = groundLookup(envelope, observed);
  assert.deepEqual(kept, []);
  assert.equal(dropped.length, 2);
});

// DISAMBIGUATION CHECKPOINT: an "ambiguous" (or "no_match") verdict must
// yield zero changes, even when the model -- ignoring its own prompt --
// proposed some anyway. This is the check that keeps a common-name mismatch
// from ever becoming a claim about the wrong person.
test('groundLookup returns no changes on ambiguous, even when the envelope carries some', () => {
  const observed = observedFixture({
    urls: ['https://acme.example/news'],
    resultText: 'Jane Doe was promoted to VP of Engineering in March.',
  });
  const envelope = {
    identity_confidence: 'ambiguous',
    changes: [{
      kind: 'role', text: 'Promoted to VP', url: 'https://acme.example/news',
      quote: 'promoted to VP of Engineering',
    }],
  };
  const { kept, dropped } = groundLookup(envelope, observed);
  assert.deepEqual(kept, []);
  assert.ok(dropped.length > 0, 'the disregarded changes are recorded as dropped, not silently discarded');
});

test('groundLookup drops a kind outside the closed set and text over 200 characters', () => {
  const observed = observedFixture({
    urls: ['https://acme.example/news'],
    resultText: 'Jane Doe was promoted to VP of Engineering in March.'.repeat(5),
  });
  const tooLong = 'x'.repeat(201);
  const envelope = {
    identity_confidence: 'match',
    changes: [
      { kind: 'ssn', text: 'not a real kind', url: 'https://acme.example/news', quote: 'promoted to VP of Engineering' },
      { kind: 'role', text: tooLong, url: 'https://acme.example/news', quote: 'promoted to VP of Engineering' },
    ],
  };
  const { kept, dropped } = groundLookup(envelope, observed);
  assert.deepEqual(kept, []);
  assert.equal(dropped.length, 2);
});

// --- anchorsFor ---------------------------------------------------------------

test('anchorsFor reads firm and profileUrl off people.linkedin BY NAME, never spreading it', () => {
  const db = openDb(':memory:');
  insertPerson(db, {
    key: 'name:jane', name: 'Jane Doe',
    // people.linkedin carries an email too (conflict (c) in the design) --
    // anchorsFor must never let it leak into the anchors object.
    linkedin: { company: 'Acme Corp', url: 'https://www.linkedin.com/in/janedoe', email: 'jane@acme.test' },
  });
  const anchors = anchorsFor(db, 'name:jane');
  assert.equal(anchors.name, 'Jane Doe');
  assert.equal(anchors.firm, 'Acme Corp');
  assert.equal(anchors.profileUrl, 'https://www.linkedin.com/in/janedoe');
  assert.equal(anchors.handle, null);
  assert.ok(!('email' in anchors), 'the linkedin object is never spread into anchors');
});

// --- storeLookup ---------------------------------------------------------------

// 13: storeLookup writes a web context row, a PENDING person claim, a
// claim_source receipt, and a person_lookup_change row.
test('storeLookup writes a web context row, a pending claim, a receipt, and a person_lookup_change row', () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:jane', name: 'Jane Doe' });
  const distillRunId = Number(db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
     VALUES ('fake', 'x', 'x', '{}', 'off', 1, 0, 'running', ?, NULL)`
  ).run(NOW).lastInsertRowid);
  const runId = Number(db.prepare(
    `INSERT INTO person_lookup_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
       candidates, looked_up, model_calls, searches, proposed, dropped, cost_usd, skip_reason, status)
     VALUES (?, ?, NULL, 'trickle', 'fake', 1, 1, 1, 0, 0, 0, 0, 0, 0, NULL, 'running')`
  ).run(distillRunId, NOW).lastInsertRowid);
  const logId = Number(db.prepare(
    `INSERT INTO lookup_log(person_key, run_id, at, engine, query, query_hash, fields_used, searches, urls_seen,
       identity_confidence, changes_proposed, changes_dropped, cost_usd, status)
     VALUES ('name:jane', ?, ?, 'fake', '"Jane Doe" "Acme"', 'abc123', '["firm","name"]', 1, 1, 'match', 1, 0, 0.01, 'proposed')`
  ).run(runId, NOW).lastInsertRowid);

  const kept = [{
    kind: 'role', text: 'Promoted to VP of Engineering at Acme.',
    url: 'https://acme.example/news', quote: 'promoted to VP of Engineering', date: '2026-03',
  }];
  const result = storeLookup(db, { personKey: 'name:jane', kept, logId, distillRunId, now: NOW });
  assert.deepEqual(result, { stored: 1, skipped: 0 });

  const ctx = db.prepare("SELECT * FROM context WHERE source = 'web'").get();
  assert.ok(ctx, 'a web context row was written');
  assert.equal(ctx.text, 'promoted to VP of Engineering');
  assert.ok(ctx.entity_id.startsWith('web:'));
  assert.ok(ctx.content_hash, 'content_hash is computed, not left null');
  assert.ok(Number.isInteger(ctx.store_changed_at), 'store_changed_at is set, never NULL');

  const claim = db.prepare("SELECT * FROM claim WHERE subject_person_key = 'name:jane'").get();
  assert.ok(claim, 'a person claim was written');
  assert.equal(claim.subject, 'person');
  assert.equal(claim.kind, 'fact');
  assert.equal(claim.text, 'Promoted to VP of Engineering at Acme.');
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS n FROM claim_decision WHERE claim_id = ?').get(claim.id).n),
    0,
    'PENDING by construction: no claim_decision row'
  );

  const source = db.prepare('SELECT * FROM claim_source WHERE claim_id = ?').get(claim.id);
  assert.ok(source, 'a claim_source receipt was written');
  assert.equal(source.context_id, ctx.id);
  assert.equal(source.source, 'web');
  assert.equal(source.quote, 'promoted to VP of Engineering');

  const change = db.prepare('SELECT * FROM person_lookup_change WHERE claim_id = ?').get(claim.id);
  assert.ok(change, 'a person_lookup_change row was written');
  assert.equal(change.log_id, logId);
  assert.equal(change.kind, 'role');
  assert.equal(change.url, 'https://acme.example/news');
  assert.equal(change.change_date, '2026-03');
  assert.equal(change.applied_at, null);

  assert.equal(
    Number(db.prepare("SELECT COUNT(*) AS n FROM person_page_item WHERE claim_id = ?").get(claim.id).n),
    0,
    'no person_page_item row -- its section CHECK is closed to the five page sections'
  );
});

// --- lookupPerson ---------------------------------------------------------------

// 15: a person with only one anchor (a name, no firm/handle/profileUrl) is
// logged as 'no-anchors' WITHOUT ever calling the engine.
test('a no-second-anchor person is logged without a model call', async () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:owen', name: 'Owen Other' }); // no linkedin, no firm, no handle
  const distillRunId = Number(db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
     VALUES ('fake', 'x', 'x', '{}', 'off', 1, 0, 'running', ?, NULL)`
  ).run(NOW).lastInsertRowid);
  const runId = Number(db.prepare(
    `INSERT INTO person_lookup_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
       candidates, looked_up, model_calls, searches, proposed, dropped, cost_usd, skip_reason, status)
     VALUES (?, ?, NULL, 'trickle', 'fake', 1, 1, 1, 0, 0, 0, 0, 0, 0, NULL, 'running')`
  ).run(distillRunId, NOW).lastInsertRowid);

  let calls = 0;
  const engine = fakeEngine('fake', async () => { calls += 1; return fakeRawResult({ identity_confidence: 'match', changes: [] }); });

  const result = await lookupPerson(db, engine, { personKey: 'name:owen', tier: 'other' }, { runId, distillRunId, now: NOW });
  assert.equal(calls, 0, 'the engine must never be invoked for a person with no second anchor');
  assert.equal(result.calls, 0);
  assert.equal(result.status, 'no-anchors');

  const log = db.prepare("SELECT * FROM lookup_log WHERE person_key = 'name:owen'").get();
  assert.ok(log);
  assert.equal(log.status, 'no-anchors');
});

// --- lookupScope ---------------------------------------------------------------

// 16: lookupScope orders eligible before tagged before other.
test('lookupScope orders eligible before tagged before other', () => {
  const db = openDb(':memory:');

  // 'other': no subRoles, not in eligiblePool.
  insertPerson(db, { key: 'name:owen other', name: 'Owen Other', sent: 1, received: 0 });

  // 'tagged': a founder sub-role, but below eligiblePool's depth floor and
  // never authored -- so eligiblePool excludes them on its own gates.
  insertPerson(db, { key: 'name:tara tagged', name: 'Tara Tagged', subRoles: ['founder'], sent: 1, received: 0 });

  // 'eligible': clears every eligiblePool gate (depth >= 20, authored,
  // quiet >= 180 days, business relationship, no future meeting).
  insertPerson(db, { key: 'name:erin eligible', name: 'Erin Eligible', role: 'business', sent: 20, received: 15 });
  insertAuthored(db, 'name:erin eligible');
  insertActiveDay(db, 'name:erin eligible', day(200));

  const scope = lookupScope(db, { now: NOW });
  const order = scope.map((c) => c.personKey);
  assert.deepEqual(order, ['name:erin eligible', 'name:tara tagged', 'name:owen other']);
  assert.deepEqual(scope.map((c) => c.tier), ['eligible', 'tagged', 'other']);
});

// 16b: lookupScope over a large population computes eligiblePool's own query
// (producer.mjs's poolSql, fingerprinted below by its `future_meetings` CTE,
// which appears nowhere else) ONCE for the whole scan -- not once per person
// -- and completes well under the multi-minute hang this replaces. This is
// the regression test for the live-machine incident: POST
// /admin/relationship/lookup pinned the process at ~91% CPU for over ten
// minutes over 7,359 people because lookupTierFor (via lookupScope's old
// per-row loop) recomputed the entire eligible pool -- a multi-CTE query
// over people + calendar + links -- once per person.
test('lookupScope computes eligiblePool exactly once and stays fast over 1500 people', () => {
  const db = openDb(':memory:');

  for (let i = 0; i < 1500; i++) {
    const key = `name:person ${i}`;
    if (i % 10 === 0) {
      // A handful of genuinely eligible people (clears every eligiblePool
      // gate), so the pool query has real rows to filter, not an empty table.
      insertPerson(db, { key, name: `Person ${i}`, role: 'business', sent: 20, received: 15 });
      insertAuthored(db, key);
      insertActiveDay(db, key, day(200));
    } else if (i % 7 === 0) {
      // A handful tagged founder/investor, below eligiblePool's own gates --
      // exercises the 'tagged' branch of lookupTierFor.
      insertPerson(db, { key, name: `Person ${i}`, subRoles: ['founder'] });
    } else {
      insertPerson(db, { key, name: `Person ${i}` });
    }
  }

  let poolQueryPrepareCount = 0;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (typeof sql === 'string' && sql.includes('future_meetings')) poolQueryPrepareCount += 1;
    return originalPrepare(sql);
  };

  let scope;
  const startedAt = Date.now();
  try {
    scope = lookupScope(db, { now: NOW });
  } finally {
    db.prepare = originalPrepare;
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(scope.length, 1500);
  assert.equal(
    poolQueryPrepareCount, 1,
    `eligiblePool's own query should be prepared exactly once for the whole scan, not once per person (saw ${poolQueryPrepareCount})`
  );
  assert.ok(
    elapsedMs < 3000,
    `lookupScope over 1500 people should complete in well under 3s (took ${elapsedMs}ms)`
  );
});

// --- runLookupPass ---------------------------------------------------------------

// 17: once a due candidate has been looked up and its next_due_at pushed
// into the future, a second pass makes zero model calls.
test('a second runLookupPass makes zero model calls once nothing is due', async () => {
  const db = openDb(':memory:');
  insertPerson(db, { key: 'name:jane', name: 'Jane Doe', linkedin: { company: 'Acme Corp' } });

  let calls = 0;
  const engine = fakeEngine('fake', async () => { calls += 1; return fakeRawResult({ identity_confidence: 'match', changes: [] }); });

  const first = await runLookupPass(db, engine, {}, { budget: 1, now: NOW });
  assert.equal(first.status, 'complete');
  assert.equal(Number(first.model_calls), 1);
  assert.equal(calls, 1);

  const second = await runLookupPass(db, engine, {}, { budget: 1, now: NOW });
  assert.equal(second.status, 'skipped');
  assert.equal(second.skip_reason, 'no-due');
  assert.equal(Number(second.model_calls), 0);
  assert.equal(calls, 1, 'the engine was not called a second time');
});

// 18: an engine error HOLDS next_due_at; an ambiguous verdict ADVANCES it.
test('an engine error holds next_due_at; an ambiguous verdict advances it', async () => {
  const errDb = openDb(':memory:');
  insertPerson(errDb, { key: 'name:jane', name: 'Jane Doe', linkedin: { company: 'Acme Corp' } });
  const throwingEngine = fakeEngine('fake', async () => { throw new Error('boom'); });
  await runLookupPass(errDb, throwingEngine, {}, { budget: 1, now: NOW });
  const errState = errDb.prepare("SELECT * FROM person_lookup_state WHERE person_key = 'name:jane'").get();
  assert.ok(errState);
  assert.equal(errState.last_status, 'engine-error');
  assert.equal(Number(errState.next_due_at), NOW, 'held at "due now" rather than advanced, for a brand-new candidate');

  const ambDb = openDb(':memory:');
  insertPerson(ambDb, { key: 'name:tom', name: 'Tom Ambiguous', linkedin: { company: 'Acme Corp' } });
  const ambiguousEngine = fakeEngine('fake', async () => fakeRawResult({ identity_confidence: 'ambiguous', changes: [] }));
  await runLookupPass(ambDb, ambiguousEngine, {}, { budget: 1, now: NOW });
  const ambState = ambDb.prepare("SELECT * FROM person_lookup_state WHERE person_key = 'name:tom'").get();
  assert.ok(ambState);
  assert.equal(ambState.last_status, 'ambiguous');
  assert.equal(Number(ambState.next_due_at), NOW + LOOKUP_REFRESH_DAYS.other * DAY);
});

// --- lookupGate ---------------------------------------------------------------

// 19: lookupGate skips on battery<40 off AC, serious thermal, 90% of the
// daily call cap, and while a sweep (or a page build, or another lookup) is
// already running.
test('lookupGate skips on battery, thermal, quota, and while a sweep runs', () => {
  const db = openDb(':memory:');

  const offAc = lookupGate(db, {}, { onAc: false, battery: 20, engine: 'fake' });
  assert.equal(offAc.ok, false);
  assert.equal(offAc.reason, 'battery');
  const onAc = lookupGate(db, {}, { onAc: true, battery: 20, engine: 'fake' });
  assert.notEqual(onAc.reason, 'battery', 'battery is never a reason to skip while on AC power');

  const thermal = lookupGate(db, {}, { thermal: 'serious', engine: 'fake' });
  assert.equal(thermal.ok, false);
  assert.equal(thermal.reason, 'thermal');

  const busy = lookupGate(db, { sweepActive: true }, { engine: 'fake' });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'busy-model');

  const cap = 20; // LOOKUP_DAILY_CALL_CAP_DEFAULT
  const used = Math.ceil(cap * 0.9);
  db.prepare(
    `INSERT INTO person_lookup_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
       candidates, looked_up, model_calls, searches, proposed, dropped, cost_usd, skip_reason, status)
     VALUES (NULL, ?, ?, 'trickle', 'fake', 1, 1, 1, 1, ?, 0, 0, 0, 0, NULL, 'complete')`
  ).run(Date.now(), Date.now(), used);
  const quota = lookupGate(db, {}, { engine: 'fake' });
  assert.equal(quota.ok, false);
  assert.equal(quota.reason, 'quota');
});

// --- routes ---------------------------------------------------------------

function insertPersonRow(db, key, name, { linkedin = null } = {}) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, Date.now(), Date.now(), Date.now(), Date.now(), 1, 0, 0, 0, 1, 0, 'friend', '{}',
    linkedin ? JSON.stringify(linkedin) : null, Date.now(), '[]');
}

// A fake lookup engine returning a real stream-json `type:'result'` line --
// see fakeRawResult above for why one line is enough for parseLookupStream.
function fakeLookupEngine(onCall) {
  const counters = { calls: 0, totalCostUsd: 0, totalDurationMs: 0, errors: 0 };
  return {
    name: 'fake-lookup', model: 'fake', counters,
    async complete({ system, user }) {
      counters.calls += 1;
      counters.totalCostUsd += 0.02;
      const envelope = onCall ? onCall({ system, user }) : { identity_confidence: 'match', changes: [] };
      return fakeRawResult(envelope, { cost: 0.02 });
    },
  };
}

// 20: POST /admin/relationship/lookup/person jumps the ordinary tier/
// recency queue for one person (next_due_at forced to 0 regardless of
// schedule), but still honours the same daily call cap an ordinary pass
// respects.
test('POST /admin/relationship/lookup/person jumps the queue but honours the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-lookup-'));
  const engine = fakeLookupEngine();
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipLookupEngine: engine, peopleProjectionAutoRebuild: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const db = server.db;
    const key = 'name:jump the queue';
    insertPersonRow(db, key, 'Jump The Queue', { linkedin: { company: 'Acme Corp' } });
    // NOT due under the ordinary schedule: next_due_at is 100 days out.
    db.prepare(
      `INSERT INTO person_lookup_state(person_key, tier, anchors_hash, last_looked_at, next_due_at, last_status, lookups, proposals)
       VALUES (?, 'other', 'stale', ?, ?, 'empty', 1, 0)`
    ).run(key, Date.now(), Date.now() + 100 * 86_400_000);

    const result = await (await call('POST', '/admin/relationship/lookup/person', { personKey: key })).json();
    assert.equal(engine.counters.calls, 1, 'the engine WAS called even though next_due_at was far in the future');
    assert.ok(result.log, 'a log row is returned');
    assert.equal(result.log.personKey, key);
    assert.deepEqual(result.changes, []);

    // Now saturate the daily call cap and confirm the SAME route honours it.
    const cap = 20; // LOOKUP_DAILY_CALL_CAP_DEFAULT
    db.prepare(
      `INSERT INTO person_lookup_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
         candidates, looked_up, model_calls, searches, proposed, dropped, cost_usd, skip_reason, status)
       VALUES (NULL, ?, ?, 'trickle', 'fake', 1, 1, 1, 1, ?, 0, 0, 0, 0, NULL, 'complete')`
    ).run(Date.now(), Date.now(), Math.ceil(cap * 0.9));

    const capped = await (await call('POST', '/admin/relationship/lookup/person', { personKey: key })).json();
    assert.equal(engine.counters.calls, 1, 'the engine was not called a second time once the cap gate fires');
    assert.equal(capped.log, null);
    assert.deepEqual(capped.changes, []);
    assert.equal(capped.reason, 'quota');
  } finally {
    await server.close();
  }
});

// 21: /stats carries a lookup key with real (not estimated) cost; the card
// route carries `changed`, resolved live and null once the web row is gone.
test('/stats carries lookup with real cost; the card carries `changed`, null once the web row is deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-lookup-stats-'));
  const CAP = { max: 5, windowMs: 86_400_000 };
  const personKey = 'name:web change person';
  const STUB_CARDS = [{
    personKey, name: 'Web Change Person', kind: 'reconnect',
    sentence: 'Text them to catch up.',
    role: 'founder', focus: 'reconnecting', label: 'business',
    left: null, leftTone: null,
    evidence: { topics: [], messages: 10, dormancyDays: 300, meetings: 0, lastMeetingDaysAgo: null },
    producer_version: 'rm-match-v13',
  }];
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipMatcher: async () => ({ cards: structuredClone(STUB_CARDS), focus: 'x', currentTopics: [] }),
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'matcher', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const db = server.db;
    insertPersonRow(db, personKey, 'Web Change Person');

    // Build one lookup end to end via the real DB-half functions, exactly
    // the way runLookupPass would, so the log's cost_usd is a real number
    // /stats can sum.
    const distillRunId = Number(db.prepare(
      `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
       VALUES ('fake', 'x', 'x', '{}', 'off', 1, 0, 'running', ?, NULL)`
    ).run(Date.now()).lastInsertRowid);
    const runId = Number(db.prepare(
      `INSERT INTO person_lookup_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
         candidates, looked_up, model_calls, searches, proposed, dropped, cost_usd, skip_reason, status)
       VALUES (?, ?, NULL, 'trickle', 'fake', 1, 1, 1, 1, 0, 1, 0, 0, 0.0345, NULL, 'complete')`
    ).run(distillRunId, Date.now()).lastInsertRowid);
    const logId = Number(db.prepare(
      `INSERT INTO lookup_log(person_key, run_id, at, engine, query, query_hash, fields_used, searches, urls_seen,
         identity_confidence, changes_proposed, changes_dropped, cost_usd, status)
       VALUES (?, ?, ?, 'fake', '"Web Change Person" "Acme"', 'abc123', '["name"]', 1, 1, 'match', 1, 0, 0.0345, 'proposed')`
    ).run(personKey, runId, Date.now()).lastInsertRowid);

    const kept = [{
      kind: 'company', text: 'Now VP of Engineering at Acme.',
      url: 'https://acme.example/news', quote: 'now VP of Engineering', date: '2026-05',
    }];
    storeLookup(db, { personKey, kept, logId, distillRunId, now: Date.now() });

    const stats = await (await call('GET', '/stats')).json();
    assert.ok(stats.lookup, '/stats carries a lookup key');
    assert.equal(typeof stats.lookup.callCap, 'number');
    assert.ok(stats.lookup.costUsd24h >= 0.0345, '/stats.lookup.costUsd24h sums the real per-lookup cost_usd');

    await (await call('POST', '/admin/relationship/refresh')).json();
    await new Promise((r) => setTimeout(r, 50)); // refresh is fire-and-forget

    const before = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(before.card.name, 'Web Change Person');
    assert.ok(before.card.changed, 'the card carries `changed`');
    assert.equal(before.card.changed.url, 'https://acme.example/news');
    assert.equal(before.card.changed.kind, 'company');
    assert.equal(before.card.changed.quote, 'now VP of Engineering');
    assert.equal(before.card.changed.date, '2026-05');
    assert.notEqual(before.card.sentence, undefined, '`changed` never displaces `sentence`');

    // Delete the web row -- the receipt is gone, so `changed` must be gone.
    // `changed` is resolved fresh from the live row on every serve (never
    // cached with the rest of the card), so re-fetching the SAME
    // already-shown snapshot is enough to observe this -- no new refresh
    // needed.
    // claim_source references context(id) with no ON DELETE CASCADE (a
    // deliberate snapshot, not a live pointer -- see hermes.mjs's own
    // schema comment), so a real deletion path unlinks it first; this test
    // does the same rather than tripping the FK.
    db.prepare("DELETE FROM claim_source WHERE context_id IN (SELECT id FROM context WHERE source = 'web')").run();
    db.prepare("DELETE FROM context WHERE source = 'web'").run();
    const after = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(after.card.name, 'Web Change Person');
    assert.equal(after.card.changed, null, '`changed` is null once the web row is gone');
  } finally {
    await server.close();
  }
});

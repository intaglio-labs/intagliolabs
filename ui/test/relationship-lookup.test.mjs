// Tests for the pure half of public lookup (L5 step 6): buildLookupQuery's
// input gate, parseLookupStream's stream-json reader, and groundLookup's
// grounding rules. No DB in this file -- the DB half (anchorsFor,
// lookupScope, lookupGate, storeLookup, lookupPerson, runLookupPass,
// lookupStatus, lookupLogFor, newestWebChange) gets its own tests in a later
// commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildLookupQuery, parseLookupStream, groundLookup } from '../server/relationship/lookup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REAL_STREAM_FIXTURE = readFileSync(join(here, 'fixtures', 'lookup-stream.jsonl'), 'utf8');

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
// the real captured fixture above (ui/test/fixtures/lookup-stream.jsonl),
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

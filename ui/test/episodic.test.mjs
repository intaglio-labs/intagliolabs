// Tests for the episodic shelf.
//
// The regression set is the seven questions the L5 coverage run graded
// "data gap at every tier" (results/EXPERIMENT_L5_COVERAGE.md): a flight in
// calendar, sleep in oura, photos last weekend, and friends. Each gets a
// fixture proving the router picks the right window and sources and that the
// selected rows + computed lines actually carry the answer.
//
// The guard properties matter more than the happy paths: received messages
// never selected, the pinned thread never selected, hazlie_digest unreadable
// even if routed, and the model handed only labeled, capped lines.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows } from '../server/hermes.mjs';
import {
  routeQuestion,
  parseWindow,
  selectEpisodicRows,
  computeEpisodicStats,
  episodicLines,
  episodicContext,
  MAX_LINES,
} from '../server/memory/episodic.mjs';

// A fixed Friday, 2027-03-19 12:00 local — weekday math needs a known day.
const NOW = new Date(2027, 2, 19, 12, 0, 0).getTime();
const DAY = 86_400_000;
const PINNED = 'any;-;austiny808@gmail.com';
const opts = { excludeChatGuids: [PINNED] };

function db() {
  return openDb(':memory:');
}

// --- routing -----------------------------------------------------------------

test('a question with no episodic topic routes nowhere', () => {
  assert.equal(routeQuestion('what am I allergic to?', { now: NOW }), null);
  assert.equal(routeQuestion('who is rishab?', { now: NOW }), null);
});

test('topics pick sources; schedule questions look forward', () => {
  const sleep = routeQuestion('what was my worst night of sleep this month?', { now: NOW });
  assert.deepEqual(sleep.sources, ['health']);
  assert.ok(sleep.to <= NOW + DAY, 'health windows do not extend into the future');

  const fly = routeQuestion('when do I fly to Honolulu?', { now: NOW });
  assert.deepEqual(fly.sources, ['calendar']);
  assert.ok(fly.to > NOW + 60 * DAY, 'a flight question must see the future');
});

test('window phrases parse to real local-day boundaries', () => {
  // NOW is a Friday; "last tuesday" is three days back.
  const tue = parseWindow('what meetings did I have last tuesday?', { now: NOW });
  assert.equal(new Date(tue.from).getDay(), 2);
  assert.equal(tue.to - tue.from, DAY);
  assert.ok(NOW - tue.from < 7 * DAY, 'the most recent Tuesday, not an older one');

  const wk = parseWindow('photos from last weekend', { now: NOW });
  assert.equal(new Date(wk.from).getDay(), 6, 'weekend starts Saturday');
  assert.equal(wk.to - wk.from, 2 * DAY);

  const mo = parseWindow('how was august', { now: new Date(2027, 9, 5).getTime() });
  assert.equal(new Date(mo.from).getMonth(), 7);
  assert.equal(new Date(mo.from).getFullYear(), 2027, 'nearest august is this year when recent');
});

test('the modal "may" is not the month of May', () => {
  // `\b(?:in )?(may)\b` matched the modal and then SILENTLY replaced the
  // question's window with May — so the answer was composed from rows the
  // owner never asked about, and nothing in the response said so. The failure
  // was invisible precisely because parseWindow always returns a window.
  for (const q of [
    'what may i have missed?',
    'may i ask what happened',
    'this may be wrong',
    'it may have been in the notes',
  ]) {
    const w = parseWindow(q, { now: NOW });
    assert.match(w.why, /^default/u, `"${q}" must not resolve to a month`);
  }
});

test('"may" still means May when the sentence says so', () => {
  // The other half: the fix must not cost the real month. Evidence is a
  // preposition in front, `last`, or a number after.
  for (const q of ['what did i do in may', 'anything since may', 'may 3 plans', 'last may']) {
    const w = parseWindow(q, { now: NOW });
    assert.equal(w.why, 'may', `"${q}" should resolve to the month`);
  }
});

// --- the guard properties ----------------------------------------------------

test('received messages are never selected, whatever the row says', () => {
  const d = db();
  insertRows(d, [
    { ts: NOW - DAY, source: 'imessage', entity_id: 'i:recv', text: 'a very relevant received text about meetings', meta: { is_from_me: false, chat_guid: 'iMessage;-;+15550001' } },
    { ts: NOW - DAY, source: 'imessage', entity_id: 'i:sent', text: 'a sent text about the meeting', meta: { is_from_me: true, chat_guid: 'iMessage;-;+15550001' } },
  ]);
  const route = routeQuestion('what did I text about the meeting?', { now: NOW });
  const rows = selectEpisodicRows(d, route, opts);
  assert.deepEqual(rows.filter((r) => r.source === 'imessage').map((r) => r.entity_id), ['i:sent']);
});

test('the pinned Hazlie thread stays out of the episodic shelf too', () => {
  const d = db();
  insertRows(d, [
    { ts: NOW - DAY, source: 'imessage', entity_id: 'i:hz', text: 'hz ask about my messages', meta: { is_from_me: true, chat_guid: PINNED } },
  ]);
  const route = routeQuestion('what did I text this week?', { now: NOW });
  assert.equal(selectEpisodicRows(d, route, opts).length, 0);
});

test('a routed source outside the allowlist reads nothing', () => {
  const d = db();
  insertRows(d, [
    { ts: NOW - DAY, source: 'hazlie_digest', entity_id: 'h:1', text: 'sleep stats from the digest', meta: {} },
  ]);
  const route = routeQuestion('how did I sleep?', { now: NOW });
  route.sources.push('hazlie_digest'); // even a corrupted route
  assert.equal(selectEpisodicRows(d, route, opts).length, 0);
});

test('the envelope is capped and every line is labeled', () => {
  const d = db();
  insertRows(d, Array.from({ length: 120 }, (_, i) => ({
    ts: NOW - i * 3_600_000,
    source: 'notes',
    entity_id: `n:${i}`,
    text: `note number ${i} about notes and more notes`,
    meta: {},
  })));
  const ctx = episodicContext(d, 'what did I write in my notes this month?', { now: NOW, ...opts });
  assert.ok(ctx.lines.length <= MAX_LINES);
  for (const line of ctx.lines) assert.match(line, /^\[\d+\] \((computed, )?[a-z]+, /u);
});

// --- the seven regression questions -----------------------------------------

test('Q1: the flight is found in a FUTURE calendar row', () => {
  const d = db();
  insertRows(d, [
    { ts: NOW + 40 * DAY, source: 'calendar', entity_id: 'c:fly', text: '"HNL flight — HA12" 8:00AM (austin@intaglio.io)', meta: { start_ms: NOW + 40 * DAY, end_ms: NOW + 40 * DAY + 6 * 3_600_000 } },
    { ts: NOW - 2 * DAY, source: 'calendar', entity_id: 'c:x', text: '"standup" 9:00AM', meta: { start_ms: NOW - 2 * DAY, end_ms: NOW - 2 * DAY + 1_800_000 } },
  ]);
  const ctx = episodicContext(d, 'When do I fly to Honolulu?', { now: NOW, ...opts });
  assert.ok(ctx.rows.some((r) => r.entity_id === 'c:fly'), 'the future flight row is selected');
  // And the term ranking puts the flight-matching row first.
  assert.equal(ctx.rows[0].entity_id, 'c:fly');
});

test('Q4/Q10: worst night is computed, with its date', () => {
  const d = db();
  insertRows(d, [
    { ts: NOW - 10 * DAY, source: 'health', entity_id: 'h:1', text: 'Slept 6h 30m (score 70): 1h deep', meta: {} },
    { ts: NOW - 9 * DAY, source: 'health', entity_id: 'h:2', text: 'Slept 8h 02m (score 85): 1h deep', meta: {} },
    { ts: NOW - 8 * DAY, source: 'health', entity_id: 'h:3', text: 'Slept 9h 14m (score 93): 1h deep', meta: {} },
  ]);
  const ctx = episodicContext(d, 'what was the day I slept worst this month?', { now: NOW, ...opts });
  const stat = ctx.lines.find((l) => l.includes('(computed, health)'));
  assert.ok(stat, 'a computed sleep line exists');
  assert.match(stat, /worst 6h 30m on /u);
  assert.match(stat, /best 9h 14m on /u);
});

test('Q8/Q11: contacts appear as counts, never as their words', () => {
  const d = db();
  insertRows(d, [
    ...Array.from({ length: 5 }, (_, i) => ({ ts: NOW - i * DAY, source: 'imessage', entity_id: `i:a${i}`, text: `sent text ${i}`, meta: { is_from_me: true, chat_guid: 'iMessage;-;+15551111' } })),
    { ts: NOW - DAY, source: 'imessage', entity_id: 'i:b', text: 'one message', meta: { is_from_me: true, chat_guid: 'iMessage;-;+15552222' } },
  ]);
  const ctx = episodicContext(d, 'who did I text the most this month?', { now: NOW, ...opts });
  const stat = ctx.lines.find((l) => l.includes('(computed, imessage)'));
  assert.match(stat, /\+15551111 \(5\)/u);
  assert.match(stat, /\+15552222 \(1\)/u);
});

test('Q13: photos come back as per-day counts, not filename dumps', () => {
  const d = db();
  // NOW is Friday; last weekend = the 13th/14th.
  const sat = new Date(2027, 2, 13, 15, 0).getTime();
  insertRows(d, [
    ...Array.from({ length: 8 }, (_, i) => ({ ts: sat + i * 3_600_000, source: 'photos', entity_id: `p:${i}`, text: `(photo ${i}.png)`, meta: {} })),
  ]);
  const ctx = episodicContext(d, 'what was happening around the photos I took last weekend?', { now: NOW, ...opts });
  const stat = ctx.lines.find((l) => l.includes('(computed, photos)'));
  assert.match(stat, /8 photos across 1 days/u);
  assert.ok(!ctx.lines.some((l) => l.includes('.png')), 'filenames never reach the composer');
});

test('Q15: sleep-before-meetings gets BOTH health rows and calendar stats', () => {
  const d = db();
  insertRows(d, [
    { ts: NOW - 3 * DAY, source: 'health', entity_id: 'h:1', text: 'Slept 6h 00m (score 60): 1h deep', meta: {} },
    { ts: NOW - 2 * DAY, source: 'health', entity_id: 'h:2', text: 'Slept 8h 30m (score 90): 1h deep', meta: {} },
    { ts: NOW - 2 * DAY, source: 'calendar', entity_id: 'c:1', text: '"board prep" 9:00AM', meta: { start_ms: NOW - 2 * DAY, end_ms: NOW - 2 * DAY + 4 * 3_600_000 } },
    { ts: NOW - 2 * DAY + 5 * 3_600_000, source: 'calendar', entity_id: 'c:2', text: '"1:1" 2:00PM', meta: { start_ms: NOW - 2 * DAY + 5 * 3_600_000, end_ms: NOW - 2 * DAY + 6 * 3_600_000 } },
  ]);
  const ctx = episodicContext(d, 'how does my sleep look before heavy meeting days?', { now: NOW, ...opts });
  assert.deepEqual(ctx.sources, ['calendar', 'health']);
  assert.ok(ctx.lines.some((l) => l.includes('(computed, health)')));
  assert.ok(ctx.lines.some((l) => l.includes('(computed, calendar)')));
});

test('empty window means empty context, not an error', () => {
  const d = db();
  const ctx = episodicContext(d, 'how did I sleep last week?', { now: NOW, ...opts });
  assert.deepEqual(ctx.rows, []);
  assert.deepEqual(ctx.lines, []);
});

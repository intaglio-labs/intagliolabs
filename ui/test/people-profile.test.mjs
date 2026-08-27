// Tests for the extraction layer (people/profile.mjs): the month-bucketed
// timeline graph.mjs now emits, and the facts computed from it — peak era,
// cadence, open loops, window activity — plus the era filter in rank.mjs and
// the era parsing in search.mjs. All arithmetic is code's job; every number
// asserted here traces to seeded rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { buildGraph } from '../server/people/graph.mjs';
import {
  monthIndex,
  ymFromIndex,
  peakEra,
  activityInWindow,
  cadence,
  openLoop,
  eraLine,
} from '../server/people/profile.mjs';
import { scoreForNeed, MENTOR_NEED } from '../server/people/rank.mjs';
import { detectEraWindow, answerPersonSearch } from '../server/people/search.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const DAY = 86_400_000;

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name, kind] of pairs) ins.run(id, name, kind ?? 'phone', NOW);
  return db;
}

// A bare person in the graph's finalized shape, for the pure functions.
function person(overrides = {}) {
  return {
    timeline: [],
    lastFromThem: null,
    lastFromOwner: null,
    ...overrides,
  };
}

test('monthIndex and ymFromIndex round-trip across a year boundary', () => {
  assert.equal(ymFromIndex(monthIndex('2019-12')), '2019-12');
  assert.equal(ymFromIndex(monthIndex('2020-01')), '2020-01');
  assert.equal(monthIndex('2020-01') - monthIndex('2019-12'), 1);
});

test('the graph emits a month-bucketed timeline and the owner-side clock', () => {
  const ctx = openDb(':memory:');
  // Two months of conversation, then the owner replies once.
  const mar = new Date(2026, 2, 15).getTime();
  const apr = new Date(2026, 3, 10).getTime();
  insertRows(ctx, [
    { ts: mar, source: 'imessage', entity_id: 'i:1', text: 'a', meta: { chat_handle: '+18085550100', is_from_me: false } },
    { ts: mar + DAY, source: 'imessage', entity_id: 'i:2', text: 'b', meta: { chat_handle: '+18085550100', is_from_me: false } },
    { ts: apr, source: 'imessage', entity_id: 'i:3', text: 'c', meta: { chat_handle: '+18085550100', is_from_me: true } },
    // A FUTURE meeting must not tick a bucket — same rule as the dormancy clock.
    { ts: NOW + 30 * DAY, source: 'calendar', entity_id: 'c:1', text: 'sync', meta: { attendees: [{ email: 'sam@work.com', name: 'Sam Lee' }] } },
  ]);
  const spine = spineDb([['+18085550100', 'Sam Lee', 'phone'], ['sam@work.com', 'Sam Lee', 'email']]);
  const sam = buildGraph(ctx, spine, { now: NOW }).find((p) => p.name === 'Sam Lee');
  assert.deepEqual(sam.timeline, [
    { ym: '2026-03', sent: 0, received: 2, met: 0, room: 0 },
    { ym: '2026-04', sent: 1, received: 0, met: 0, room: 0 },
  ]);
  assert.equal(sam.lastFromOwner, apr, 'owner-side clock from the owner reply');
  assert.equal(sam.lastFromThem, mar + DAY);
});

test('peakEra finds the densest run and trims empty edge months', () => {
  // 2019: 3 quiet months, then a hot spring, then years of silence, then one
  // stray message — the peak must be the spring, not diluted by the stray.
  const timeline = [
    { ym: '2019-03', sent: 20, received: 25, met: 0, room: 0 },
    { ym: '2019-04', sent: 30, received: 35, met: 0, room: 0 },
    { ym: '2019-05', sent: 10, received: 15, met: 0, room: 0 },
    { ym: '2023-06', sent: 1, received: 0, met: 0, room: 0 },
  ];
  const peak = peakEra(timeline);
  assert.equal(peak.fromYm, '2019-03');
  assert.equal(peak.toYm, '2019-05', 'trimmed to active months, not a 6-month frame');
  assert.equal(peak.messages, 135);
  assert.equal(peak.share, 0.99, '135 of 136 lifetime messages');
});

test('peakEra is null for a calendar-only tie (no messages, nothing honest to say)', () => {
  assert.equal(peakEra([{ ym: '2020-01', sent: 0, received: 0, met: 3, room: 0 }]), null);
  assert.equal(peakEra([]), null);
});

test('activityInWindow counts messages, meetings and active months, inclusive ends', () => {
  const timeline = [
    { ym: '2020-01', sent: 2, received: 3, met: 1, room: 0 },
    { ym: '2020-06', sent: 0, received: 0, met: 2, room: 0 },
    { ym: '2023-01', sent: 5, received: 0, met: 0, room: 0 },
  ];
  const act = activityInWindow(timeline, '2020-01', '2022-12');
  assert.deepEqual(act, { messages: 5, met: 3, months: 2 });
  assert.equal(activityInWindow(timeline, '2021-01', '2022-12').messages, 0);
});

test('cadence: dormant, fading, active — measured against the peak run', () => {
  // Peak of 40 messages in mid-2020; silence since -> dormant.
  const dormant = person({ timeline: [{ ym: '2020-06', sent: 20, received: 20, met: 0, room: 0 }] });
  assert.equal(cadence(dormant, { now: NOW }).state, 'dormant');
  // A trickle now (2 messages against a 40-message peak) -> fading.
  const fading = person({
    timeline: [
      { ym: '2020-06', sent: 20, received: 20, met: 0, room: 0 },
      { ym: '2026-12', sent: 1, received: 1, met: 0, room: 0 },
    ],
  });
  assert.equal(cadence(fading, { now: NOW }).state, 'fading');
  // Recent months carry the peak itself -> active.
  const active = person({
    timeline: [
      { ym: '2026-11', sent: 10, received: 10, met: 0, room: 0 },
      { ym: '2026-12', sent: 10, received: 10, met: 0, room: 0 },
    ],
  });
  assert.equal(cadence(active, { now: NOW }).state, 'active');
});

test('openLoop: they wrote last and were never answered', () => {
  const waiting = person({ lastFromThem: NOW - 30 * DAY, lastFromOwner: NOW - 60 * DAY });
  assert.deepEqual(openLoop(waiting, { now: NOW }), { waitingDays: 30 });
  // The owner answered after them — no loop.
  const answered = person({ lastFromThem: NOW - 30 * DAY, lastFromOwner: NOW - 10 * DAY });
  assert.equal(openLoop(answered, { now: NOW }), null);
  // They texted this morning — not a debt yet.
  const fresh = person({ lastFromThem: NOW - 1 * DAY, lastFromOwner: null });
  assert.equal(openLoop(fresh, { now: NOW }), null);
  assert.equal(openLoop(person(), { now: NOW }), null);
});

test('eraLine reconstructs the memory: peak, went-quiet month, open loop', () => {
  const p = person({
    timeline: [
      { ym: '2018-10', sent: 40, received: 45, met: 0, room: 0 },
      { ym: '2019-02', sent: 30, received: 35, met: 0, room: 0 },
    ],
    lastFromThem: new Date(2019, 1, 20).getTime(),
    lastFromOwner: new Date(2019, 0, 5).getTime(),
  });
  const line = eraLine(p, { now: NOW });
  assert.match(line, /peak 2018–2019 \(150 messages\)/u);
  assert.match(line, /went quiet Feb 2019/u);
  assert.match(line, /they wrote last, unanswered/u);
  // No message history -> no line, not a fabricated one.
  assert.equal(eraLine(person(), { now: NOW }), null);
});

test('the activeWindow gate: outside the window scores zero, inside is named in reasons', () => {
  const p = {
    ...person({ timeline: [{ ym: '2021-05', sent: 30, received: 30, met: 1, room: 0 }] }),
    name: 'Ana',
    identifiers: ['ana@work.com'],
    channels: ['mail'],
    channelCount: 1,
    messages: 60,
    sent: 30,
    received: 30,
    reciprocity: 1,
    metInPerson: 1,
    dormancyDays: 400,
    relationshipDays: 300,
    linkedin: { position: 'Founder', company: 'X' },
    content: {},
  };
  const need = { ...MENTOR_NEED, activeWindow: ['2020-01', '2022-12'], dormancyBandDays: null };
  const inWindow = scoreForNeed(p, need);
  assert.ok(inWindow.score > 0);
  assert.ok(inWindow.reasons.some((r) => /in window: 60 messages, met 1×/u.test(r)));
  const miss = scoreForNeed(p, { ...need, activeWindow: ['2023-01', '2024-12'] });
  assert.equal(miss.score, 0);
  assert.deepEqual(miss.reasons, ['no contact inside the asked window']);
});

test('detectEraWindow parses ranges, single years, since, and years-ago', () => {
  assert.deepEqual(detectEraWindow('investors from 2020 to 2022', { now: NOW }), { fromYm: '2020-01', toYm: '2022-12' });
  assert.deepEqual(detectEraWindow('investors 2020-2022', { now: NOW }), { fromYm: '2020-01', toYm: '2022-12' });
  assert.deepEqual(detectEraWindow('between 2022 and 2020', { now: NOW }), { fromYm: '2020-01', toYm: '2022-12' });
  assert.deepEqual(detectEraWindow('mentors back in 2019', { now: NOW }), { fromYm: '2019-01', toYm: '2019-12' });
  assert.deepEqual(detectEraWindow('who do i know since 2024', { now: NOW }), { fromYm: '2024-01', toYm: '2027-01' });
  assert.deepEqual(detectEraWindow('mentors from 3 years ago', { now: NOW }), { fromYm: '2024-01', toYm: '2024-12' });
  assert.equal(detectEraWindow('who are investors i talked to', { now: NOW }), null);
});

test('an era-scoped search keeps the in-window investor and drops the out-of-window one', () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['+18085550100', 'Vic Capital', 'phone'],
    ['+18085550200', 'Old Money', 'phone'],
  ]);
  const in2021 = new Date(2021, 5, 1).getTime();
  const in2018 = new Date(2018, 5, 1).getTime();
  const investorText = 'we want to invest in you, sending a term sheet for the round';
  insertRows(ctx, [
    // Vic: an investor conversation squarely inside 2020–2022.
    ...Array.from({ length: 12 }, (_, i) => ({
      ts: in2021 + i * DAY,
      source: 'imessage',
      entity_id: `v:${i}`,
      text: i % 2 ? investorText : 'sounds good',
      meta: { chat_handle: '+18085550100', is_from_me: i % 3 === 0 },
    })),
    // Old Money: the same conversation, but entirely in 2018.
    ...Array.from({ length: 12 }, (_, i) => ({
      ts: in2018 + i * DAY,
      source: 'imessage',
      entity_id: `o:${i}`,
      text: i % 2 ? investorText : 'sounds good',
      meta: { chat_handle: '+18085550200', is_from_me: i % 3 === 0 },
    })),
  ]);
  const owner = { addresses: new Set(), names: [] };
  const out = answerPersonSearch(ctx, spine, 'which investors did i talk to from 2020 to 2022', { owner, now: NOW });
  assert.ok(out);
  assert.match(out.text, /2020–2022/u, 'the header names the window');
  assert.match(out.text, /Vic Capital/u);
  assert.doesNotMatch(out.text, /Old Money/u);
  // The same question with no era keeps both.
  const all = answerPersonSearch(ctx, spine, 'who are investors i talked to', { owner, now: NOW });
  assert.match(all.text, /Vic Capital/u);
  assert.match(all.text, /Old Money/u);
});

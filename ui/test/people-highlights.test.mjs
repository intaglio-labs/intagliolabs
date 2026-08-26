// The highlight cards make CLAIMS ("more than your next three combined",
// "quiet since 2023"), so the thing worth pinning is not that a card appears —
// it is that it never appears when its sentence would be false. Most of these
// are negative tests for that reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHighlights } from '../server/people/highlights.mjs';

// A month-bucketed timeline from 'YYYY-MM' strings, all inbound.
const tl = (...yms) => yms.map((ym) => ({ ym, sent: 0, received: 10, met: 0 }));

// An entry as buildYear ranks them.
function entry(key, messages, timeline, engagement = messages) {
  return { p: { key, name: key, timeline }, messages, met: 0, engagement };
}

const monthsOf = (year, from, to) => {
  const out = [];
  for (let m = from; m <= to; m += 1) out.push(`${year}-${String(m).padStart(2, '0')}`);
  return out;
};

// A fixed "now" so a live year is not read as if December had happened.
const NOW = Date.UTC(2026, 11, 20); // 2026-12-20
const kinds = (h) => h.map((c) => c.kind);
const find = (h, kind) => h.find((c) => c.kind === kind);

test('no entries yields no cards rather than empty ones', () => {
  assert.deepEqual(buildHighlights([], { year: 2026, now: NOW }), []);
  assert.deepEqual(buildHighlights(null, { year: 2026, now: NOW }), []);
});

test('the favorite is ranked by engagement and names the measured activity', () => {
  const runaway = buildHighlights([
    entry('a', 1000, tl('2026-01')),
    entry('b', 100, tl('2026-01')),
    entry('c', 100, tl('2026-01')),
    entry('d', 100, tl('2026-01')),
  ], { year: 2026, now: NOW });
  const card = find(runaway, 'person-of-the-year');
  assert.equal(card.label, 'favorite');
  assert.match(card.line, /1,000 messages — most engagement this year/);

  const engagementWins = buildHighlights([
    entry('chatty', 500, tl('2026-01'), 500),
    entry('met-often', 100, tl('2026-01'), 700),
  ], { year: 2026, now: NOW });
  assert.equal(find(engagementWins, 'person-of-the-year').name, 'met-often');
});

test('a person with no messages earns no card at all', () => {
  const h = buildHighlights([entry('a', 0, [])], { year: 2026, now: NOW });
  assert.equal(find(h, 'person-of-the-year'), undefined);
});

test('back from your past needs both a real gap and a real return', () => {
  const gapAndVolume = entry('returner', 500, tl('2022-03', '2022-04', '2026-05', '2026-06'));
  const h = buildHighlights([gapAndVolume], { year: 2026, now: NOW });
  assert.match(find(h, 'back-from-your-past').line, /quiet since 2022 — then 500 messages/);

  // Gap, but they sent almost nothing on return.
  const quietReturn = entry('q', 5, tl('2022-03', '2026-05'));
  assert.equal(find(buildHighlights([quietReturn], { year: 2026, now: NOW }), 'back-from-your-past'), undefined);

  // Volume, but only a one-year gap — that is a normal lull.
  const shortGap = entry('s', 500, tl('2025-03', '2026-05'));
  assert.equal(find(buildHighlights([shortGap], { year: 2026, now: NOW }), 'back-from-your-past'), undefined);

  // Never here before is NEW, not returned.
  const brandNew = entry('n', 500, tl('2026-01', '2026-02'));
  assert.equal(find(buildHighlights([brandNew], { year: 2026, now: NOW }), 'back-from-your-past'), undefined);
});

test('rising star requires being new this year and actually sticking around', () => {
  const stuck = entry('r', 300, tl(...monthsOf(2026, 3, 12)));
  const card = find(buildHighlights([stuck], { year: 2026, now: NOW }), 'rising-star');
  assert.match(card.line, /met in march — every month since/);

  // New, but showed up twice and vanished: not rising.
  const fizzled = entry('f', 300, tl('2026-03', '2026-04'));
  assert.equal(find(buildHighlights([fizzled], { year: 2026, now: NOW }), 'rising-star'), undefined);

  // Not new — has history before this year.
  const old = entry('o', 300, tl('2024-01', ...monthsOf(2026, 3, 12)));
  assert.equal(find(buildHighlights([old], { year: 2026, now: NOW }), 'rising-star'), undefined);
});

test('rising star counts the gaps honestly when they exist', () => {
  const patchy = entry('p', 300, tl('2026-03', '2026-05', '2026-08', '2026-11'));
  const card = find(buildHighlights([patchy], { year: 2026, now: NOW }), 'rising-star');
  assert.match(card.line, /met in march — 4 of the 10 months since/);
});

test('drifting needs a rhythm to have broken, and a long enough silence', () => {
  const drifted = entry('d', 400, tl(...monthsOf(2026, 1, 6)));
  assert.match(find(buildHighlights([drifted], { year: 2026, now: NOW }), 'drifting').line,
    /every month to june — quiet for 6 months since/);

  // Active recently: not drifting.
  const current = entry('c', 400, tl(...monthsOf(2026, 1, 12)));
  assert.equal(find(buildHighlights([current], { year: 2026, now: NOW }), 'drifting'), undefined);

  // Two scattered months is not a rhythm that broke.
  const sparse = entry('s', 400, tl('2026-01', '2026-02'));
  assert.equal(find(buildHighlights([sparse], { year: 2026, now: NOW }), 'drifting'), undefined);
});

test('a live year is not read as though December already happened', () => {
  // Same person, same data, but "now" is June. Active Jan..Jun is CURRENT in
  // June and drifting in December; reading a live year to its end would have
  // called every ongoing relationship drifted.
  const p = entry('d', 400, tl(...monthsOf(2026, 1, 6)));
  const inJune = buildHighlights([p], { year: 2026, now: Date.UTC(2026, 5, 20) });
  assert.equal(find(inJune, 'drifting'), undefined);
  const inDecember = buildHighlights([p], { year: 2026, now: NOW });
  assert.ok(find(inDecember, 'drifting'));
});

test('streak needs twelve consecutive months and must still be running in this year', () => {
  const long = entry('s', 900, tl(...monthsOf(2025, 1, 12), ...monthsOf(2026, 1, 6)));
  assert.match(find(buildHighlights([long], { year: 2026, now: NOW }), 'streak').line,
    /18 months unbroken since january 2025/);

  // A break resets the run: 6 + 6 is not 12.
  const broken = entry('b', 900, tl(...monthsOf(2025, 1, 6), ...monthsOf(2025, 8, 12), ...monthsOf(2026, 1, 1)));
  assert.equal(find(buildHighlights([broken], { year: 2026, now: NOW }), 'streak'), undefined);

  // A long streak that ENDED before this year is a fact about another year.
  const stale = entry('t', 900, tl(...monthsOf(2023, 1, 12)));
  assert.equal(find(buildHighlights([stale], { year: 2026, now: NOW }), 'streak'), undefined);
});

test('a thin year yields only the cards it can earn, in mock order', () => {
  // One ordinary person: a maximum exists, nothing else is true.
  const h = buildHighlights([entry('a', 40, tl('2026-02', '2026-03'))], { year: 2026, now: NOW });
  assert.deepEqual(kinds(h), ['person-of-the-year']);
});

test('a rich year can earn every card, and keeps them in mock order', () => {
  const h = buildHighlights([
    entry('top', 5000, tl(...monthsOf(2026, 1, 12))),
    entry('returner', 400, tl('2021-02', '2026-07')),
    entry('newcomer', 300, tl(...monthsOf(2026, 2, 12))),
    entry('fading', 350, tl(...monthsOf(2026, 1, 5)), 900),
    entry('steady', 200, tl(...monthsOf(2024, 6, 12), ...monthsOf(2025, 1, 12), ...monthsOf(2026, 1, 3))),
  ], { year: 2026, now: NOW });
  assert.deepEqual(kinds(h),
    ['person-of-the-year', 'back-from-your-past', 'rising-star', 'drifting', 'streak']);
  // Each card names someone, and never the same slot twice by accident.
  for (const c of h) assert.ok(c.name && c.key && c.line, `card ${c.kind} is incomplete`);
});

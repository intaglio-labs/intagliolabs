// THE YEAR'S HIGHLIGHT CARDS: the five claims the timeline can make about a
// year without a model — person of the year, a return from the past, a rising
// star, someone drifting, and the longest unbroken streak.
//
// Same rule as the rest of ui/server/people: CODE decides, no model. Every
// line these produce is arithmetic over the month-bucketed timeline
// (graph.mjs), so the owner can audit any card by counting.
//
// TWO RULES SHAPE EVERY FUNCTION HERE.
//
// 1. A card that cannot be earned is not shown. Each builder returns null
//    rather than a softened claim, and the page renders only what comes back
//    (owner, 2026-08-25). The design mock shows five cards; a real year often
//    supports two. Five cards where the data supports two is how a measurement
//    surface turns into decoration.
//
// 2. The line says what was actually measured. "More than your next three
//    combined" is only written when that comparison is true, and the fallback
//    is a different sentence rather than the same sentence hedged. The unit is
//    MONTHS everywhere, because months is the resolution the timeline has —
//    the mock says "214 weeks" and "every week since", and weeks are not
//    something this data can support, so it does not claim them.

// A return has to clear a real gap AND come back with something to show, or
// every long-tail acquaintance who sent one email is "back from your past".
const RETURN_GAP_YEARS = 2;
const RETURN_MIN_MESSAGES = 30;

// A rising star needs enough runway for "since" to mean anything: met at least
// this many months ago, and present in at least this many of the months since.
const RISING_MIN_MONTHS_SINCE = 3;
const RISING_MIN_ACTIVE = 3;

// Drifting needs an established rhythm to have broken. Fewer active months than
// this is not a rhythm, and a shorter silence than this is just a quiet stretch.
const DRIFT_MIN_ACTIVE_MONTHS = 3;
const DRIFT_MIN_SILENT_MONTHS = 2;

// A streak is only remarkable once it has survived a year of life happening.
const STREAK_MIN_MONTHS = 12;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const monthName = (m) => MONTHS[m - 1] ?? String(m);

// 'YYYY-MM' -> a single comparable integer, so "consecutive" is just "+1" and
// December-to-January needs no special case.
function monthIndex(ym) {
  return Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1);
}

function isActive(b) {
  return ((b.sent ?? 0) + (b.received ?? 0) + (b.met ?? 0)) > 0;
}

// The months of `year` this person was active in, ascending, 1-based.
function activeMonths(timeline, year) {
  const prefix = `${year}-`;
  const set = new Set();
  for (const b of timeline ?? []) {
    if (b.ym.startsWith(prefix) && isActive(b)) set.add(Number(b.ym.slice(5, 7)));
  }
  return [...set].sort((a, b) => a - b);
}

// How much of `year` has actually happened. Reading a live year as if December
// had already passed makes every current relationship look like it drifted in
// the autumn.
function lastMonthOf(year, now) {
  const d = new Date(now);
  return year === d.getFullYear() ? d.getMonth() + 1 : 12;
}

// Years before `year` in which this person was active at all.
function priorYears(timeline, year) {
  const set = new Set();
  for (const b of timeline ?? []) {
    if (!isActive(b)) continue;
    const y = Number(b.ym.slice(0, 4));
    if (y < year) set.add(y);
  }
  return [...set].sort((a, b) => a - b);
}

// The longest run of consecutive active months anywhere in the timeline.
function longestStreak(timeline) {
  const idx = [...new Set((timeline ?? []).filter(isActive).map((b) => monthIndex(b.ym)))]
    .sort((a, b) => a - b);
  let best = { len: 0, start: null, end: null };
  let runStart = null;
  for (let i = 0; i < idx.length; i += 1) {
    if (i === 0 || idx[i] !== idx[i - 1] + 1) runStart = idx[i];
    const len = idx[i] - runStart + 1;
    if (len > best.len) best = { len, start: runStart, end: idx[i] };
  }
  return best;
}

const fromIndex = (i) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- the five cards ----------------------------------------------------

// The most engaged person of the year. The only card that is a plain maximum,
// so it is the only one that is nearly always available.
function personOfTheYear(entries) {
  const top = entries[0];
  if (!top || top.messages <= 0) return null;
  // The mock's line ("more than your next three combined") is a CLAIM. Written
  // only when it holds; otherwise a different true sentence, never this one
  // softened.
  const nextThree = entries.slice(1, 4).reduce((n, e) => n + e.messages, 0);
  const line = entries.length > 1 && top.messages > nextThree
    ? `${top.messages.toLocaleString('en-US')} messages — more than your next three combined`
    : `${top.messages.toLocaleString('en-US')} messages — your most this year`;
  return { kind: 'person-of-the-year', label: 'person of the year', key: top.p.key, name: top.p.name, line };
}

// Someone who went quiet for years and came back this one.
function backFromYourPast(entries, year) {
  let best = null;
  for (const e of entries) {
    if (e.messages < RETURN_MIN_MESSAGES) continue;
    const prior = priorYears(e.p.timeline, year);
    if (!prior.length) continue; // never here before: new, not returned
    const lastPrior = prior[prior.length - 1];
    if (year - lastPrior < RETURN_GAP_YEARS) continue;
    if (!best || e.messages > best.e.messages) best = { e, lastPrior };
  }
  if (!best) return null;
  return {
    kind: 'back-from-your-past',
    label: 'back from your past',
    key: best.e.p.key,
    name: best.e.p.name,
    line: `quiet since ${best.lastPrior} — then ${best.e.messages.toLocaleString('en-US')} messages`,
  };
}

// Met this year and kept showing up.
function risingStar(entries, year, now) {
  const lastMonth = lastMonthOf(year, now);
  let best = null;
  for (const e of entries) {
    if (priorYears(e.p.timeline, year).length) continue; // not new
    const months = activeMonths(e.p.timeline, year);
    if (!months.length) continue;
    const first = months[0];
    const since = lastMonth - first + 1;
    if (since < RISING_MIN_MONTHS_SINCE || months.length < RISING_MIN_ACTIVE) continue;
    const score = months.length / since;
    if (!best || score > best.score || (score === best.score && e.messages > best.e.messages)) {
      best = { e, first, since, active: months.length, score };
    }
  }
  if (!best) return null;
  const every = best.active === best.since;
  return {
    kind: 'rising-star',
    label: 'rising star',
    key: best.e.p.key,
    name: best.e.p.name,
    line: every
      ? `met in ${monthName(best.first)} — every month since`
      : `met in ${monthName(best.first)} — ${best.active} of the ${plural(best.since, 'month')} since`,
  };
}

// Had a rhythm this year, then stopped.
function drifting(entries, year, now) {
  const lastMonth = lastMonthOf(year, now);
  let best = null;
  for (const e of entries) {
    const months = activeMonths(e.p.timeline, year);
    if (months.length < DRIFT_MIN_ACTIVE_MONTHS) continue;
    const lastActive = months[months.length - 1];
    const silent = lastMonth - lastActive;
    if (silent < DRIFT_MIN_SILENT_MONTHS) continue;
    if (!best || e.engagement > best.e.engagement) best = { e, lastActive, silent };
  }
  if (!best) return null;
  return {
    kind: 'drifting',
    label: 'drifting',
    key: best.e.p.key,
    name: best.e.p.name,
    line: `every month to ${monthName(best.lastActive)} — quiet for ${plural(best.silent, 'month')} since`,
  };
}

// The longest unbroken run, as long as it is still running in this year.
function streak(entries, year) {
  let best = null;
  for (const e of entries) {
    const s = longestStreak(e.p.timeline);
    if (s.len < STREAK_MIN_MONTHS) continue;
    // It has to touch THIS year, or it is a fact about some other year that
    // happens to involve someone in this list.
    if (Math.floor(s.end / 12) < year) continue;
    if (!best || s.len > best.s.len) best = { e, s };
  }
  if (!best) return null;
  const from = fromIndex(best.s.start);
  return {
    kind: 'streak',
    label: 'streak',
    key: best.e.p.key,
    name: best.e.p.name,
    line: `${plural(best.s.len, 'month')} unbroken since ${monthName(from.month)} ${from.year}`,
  };
}

/// Every card the year can actually earn, in the mock's order, nulls dropped.
/// `entries` is the year's people sorted by engagement desc, each
/// { p, messages, met, engagement } — the same rows buildYear ranks, BEFORE
/// its display cap, so a highlight can name someone past row 250.
export function buildHighlights(entries, { year, now = Date.now() } = {}) {
  if (!Array.isArray(entries) || !entries.length) return [];
  return [
    personOfTheYear(entries),
    backFromYourPast(entries, year),
    risingStar(entries, year, now),
    drifting(entries, year, now),
    streak(entries, year),
  ].filter(Boolean);
}

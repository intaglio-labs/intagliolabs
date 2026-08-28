// THE YEAR'S HIGHLIGHT CARDS: the five claims the timeline can make about a
// year without a model — a favorite, a reconnection, someone new, someone
// drifting, and a streak.
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

// ACTIVE IN WHICH SENSE? The two questions this file asks are different and the
// answer is not the same, so the caller says which it means.
//
// `withRoom: false` — did the two of us exchange anything this month? That is
// what a volume superlative is about.
// `withRoom: true`  — was this person AROUND this month? A group chat is being
// around. Silence and first-sight are about presence, not correspondence.
//
// This predicate predates the room split, so it summed sent+received+met and
// that WAS the whole story. Since rooms became their own number it is only the
// direct half, and every caller silently inherited "direct" whether it meant it
// or not — which is how the drifting card came to call somebody quiet for two
// months while they posted 113 times in shared group chats.
function isActive(b, { withRoom = false } = {}) {
  const direct = (b.sent ?? 0) + (b.received ?? 0) + (b.met ?? 0);
  return (withRoom ? direct + (b.room ?? 0) : direct) > 0;
}

// The months of `year` this person was active in, ascending, 1-based.
function activeMonths(timeline, year, opts) {
  const prefix = `${year}-`;
  const set = new Set();
  for (const b of timeline ?? []) {
    if (b.ym.startsWith(prefix) && isActive(b, opts)) set.add(Number(b.ym.slice(5, 7)));
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
// PRESENCE, so rooms count. This answers "have I come across this person
// before", and a year spent together in a group chat is emphatically yes --
// without it, somebody the owner has shared a room with since 2019 can be
// announced as newly "met in March".
function priorYears(timeline, year) {
  const set = new Set();
  for (const b of timeline ?? []) {
    if (!isActive(b, { withRoom: true })) continue;
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
//
// EACH OF THESE NOW RANKS RATHER THAN PICKS. The card still names one person —
// nothing about it changed — but the list itself marks everybody in a
// category's top five, so the ranking a builder was already computing in order
// to find its winner is returned instead of thrown away. One scan, two
// answers; the alternative was a second pass with the same predicates in it,
// which is two places to keep one definition of "drifting".
function favorites(entries) {
  return [...entries]
    .filter((e) => (e.engagement ?? 0) > 0)
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0));
}

function favoriteCard(ranked) {
  const top = ranked[0];
  if (!top) return null;
  const messages = top.messages ?? 0;
  const meetings = top.met ?? 0;
  const activity = meetings > 0
    ? `${messages.toLocaleString('en-US')} messages · ${plural(meetings, 'meeting')}`
    : `${messages.toLocaleString('en-US')} messages`;
  return {
    kind: 'person-of-the-year',
    // ~~"most engaged".~~ Renamed to "favorite" (owner, 2026-08-26). The card
    // still measures exactly what it measured — the year's maximum engagement,
    // see `line` — but "most engaged" described the arithmetic to the reader
    // instead of telling them what it means. The KIND is unchanged: it is the
    // key the page draws an icon from and the name the tests know it by.
    label: 'favorite',
    key: top.p.key,
    name: top.p.name,
    line: `${activity} — most engagement this year`,
  };
}

// Someone who went quiet for years and came back this one.
function reconnections(entries, year) {
  const out = [];
  for (const e of entries) {
    // MEASURED AGAINST WHAT IT MEANT. "Came back with something to show" was
    // tuned when `messages` included room volume; direct-only made the same
    // constant gate roughly a third as much traffic, and 87 person-years fell
    // under it that had cleared it before. Presence is the right quantity for a
    // card about somebody reappearing at all.
    if ((e.messages ?? 0) + (e.roomMessages ?? 0) < RETURN_MIN_MESSAGES) continue;
    const prior = priorYears(e.p.timeline, year);
    if (!prior.length) continue; // never here before: new, not returned
    const lastPrior = prior[prior.length - 1];
    if (year - lastPrior < RETURN_GAP_YEARS) continue;
    out.push({ e, lastPrior });
  }
  return out.sort((a, b) => b.e.messages - a.e.messages);
}

function reconnectedCard(ranked) {
  const best = ranked[0];
  if (!best) return null;
  return {
    kind: 'back-from-your-past',
    // ~~"reconnected after a gap".~~ Shortened (owner, 2026-08-26): the gap is
    // already spelled out underneath, in "quiet since YEAR — then N messages",
    // so the label was repeating the line below it.
    label: 'reconnected',
    key: best.e.p.key,
    name: best.e.p.name,
    line: `quiet since ${best.lastPrior} — then ${best.e.messages.toLocaleString('en-US')} messages`,
  };
}

// Met this year and kept showing up.
function risingStars(entries, year, now) {
  const lastMonth = lastMonthOf(year, now);
  const out = [];
  for (const e of entries) {
    if (priorYears(e.p.timeline, year).length) continue; // not new
    const months = activeMonths(e.p.timeline, year);
    if (!months.length) continue;
    const first = months[0];
    const since = lastMonth - first + 1;
    if (since < RISING_MIN_MONTHS_SINCE || months.length < RISING_MIN_ACTIVE) continue;
    const score = months.length / since;
    out.push({ e, first, since, active: months.length, score });
  }
  // Ties broken by volume, which is what the single-winner scan did too.
  return out.sort((a, b) => b.score - a.score || b.e.messages - a.e.messages);
}

function newCard(ranked) {
  const best = ranked[0];
  if (!best) return null;
  const every = best.active === best.since;
  return {
    kind: 'rising-star',
    // ~~"new this year".~~ "new" (owner, 2026-08-26): the card only ever
    // describes this year, and the line underneath names the month.
    label: 'new',
    key: best.e.p.key,
    name: best.e.p.name,
    line: every
      ? `met in ${monthName(best.first)} — every month since`
      : `met in ${monthName(best.first)} — ${best.active} of the ${plural(best.since, 'month')} since`,
  };
}

// Had a rhythm this year, then stopped.
function drifters(entries, year, now) {
  const lastMonth = lastMonthOf(year, now);
  const out = [];
  for (const e of entries) {
    // PRESENCE, not correspondence. Somebody posting in a group chat every week
    // has not gone quiet, and saying they have is a false statement about the
    // owner's own life. This card fired on exactly that: 41 direct messages in
    // June, then 52 and 61 in rooms across July and August, reported as "quiet
    // for 2 months".
    const months = activeMonths(e.p.timeline, year, { withRoom: true });
    if (months.length < DRIFT_MIN_ACTIVE_MONTHS) continue;
    const lastActive = months[months.length - 1];
    const silent = lastMonth - lastActive;
    if (silent < DRIFT_MIN_SILENT_MONTHS) continue;
    // "EVERY MONTH TO X" HAS TO BE TRUE. Nothing checked that the active months
    // were contiguous, so a person seen in January and June read as "every month
    // to june". The card either says the true thing or says a different one.
    const contiguous = months.length === lastActive - months[0] + 1;
    out.push({ e, lastActive, silent, contiguous, months });
  }
  return out.sort((a, b) => b.e.engagement - a.e.engagement);
}

function driftingCard(ranked) {
  const best = ranked[0];
  if (!best) return null;
  const lead = best.contiguous
    ? `every month to ${monthName(best.lastActive)}`
    : `${plural(best.months.length, 'month')} up to ${monthName(best.lastActive)}`;
  return {
    kind: 'drifting',
    // ~~"no recent contact".~~ "drifting" (owner, 2026-08-26), which is the
    // word the kind has always used and the thing the card actually measures:
    // a rhythm that stopped, not an absence of contact.
    label: 'drifting',
    key: best.e.p.key,
    name: best.e.p.name,
    line: `${lead} — quiet for ${plural(best.silent, 'month')} since`,
  };
}

// The longest unbroken run, as long as it is still running in this year.
function streaks(entries, year) {
  const out = [];
  for (const e of entries) {
    const s = longestStreak(e.p.timeline);
    if (s.len < STREAK_MIN_MONTHS) continue;
    // It has to touch THIS year, or it is a fact about some other year that
    // happens to involve someone in this list.
    if (Math.floor(s.end / 12) < year) continue;
    out.push({ e, s });
  }
  return out.sort((a, b) => b.s.len - a.s.len);
}

function streakCard(ranked) {
  const best = ranked[0];
  if (!best) return null;
  const from = fromIndex(best.s.start);
  return {
    kind: 'streak',
    // ~~"longest monthly streak".~~ "streak" (owner, 2026-08-26). The line
    // below carries the length and the month it started, so the label was
    // spending three words on what the sentence already said.
    label: 'streak',
    key: best.e.p.key,
    name: best.e.p.name,
    line: `${plural(best.s.len, 'month')} unbroken since ${monthName(from.month)} ${from.year}`,
  };
}

// How many people carry a category's mark in the list. Five, because the cards
// name one and a list where a third of the rows wear a trophy has stopped
// distinguishing anybody. Fewer qualify than that on a thin year, and the mark
// is simply rarer; the list never pads.
const TOP_N = 5;

/// Both answers from one scan: the cards, and who the list should mark.
///
/// `entries` is the year's people sorted by engagement desc, each
/// { p, messages, met, engagement } — the same rows buildYear ranks, BEFORE
/// its display cap, so a highlight can name someone past row 250.
///
/// Returns { cards, awards }. `cards` is what it always was: every card the
/// year can actually earn, in the mock's order, nulls dropped. `awards` is one
/// entry per category that HAS anybody, carrying its label and the keys of its
/// top five in rank order — the page joins it to the rows by key.
///
/// The label lives here and travels with the keys on purpose. It is the same
/// string the card shows, and a copy of it in the page is a second place to
/// forget when the owner renames one (which has now happened twice in a day).
export function buildYearAwards(entries, { year, now = Date.now() } = {}) {
  if (!Array.isArray(entries) || !entries.length) return { cards: [], awards: [] };
  const ranked = [
    { kind: 'person-of-the-year', list: favorites(entries), card: favoriteCard },
    { kind: 'back-from-your-past', list: reconnections(entries, year), card: reconnectedCard },
    { kind: 'rising-star', list: risingStars(entries, year, now), card: newCard },
    { kind: 'drifting', list: drifters(entries, year, now), card: driftingCard },
    { kind: 'streak', list: streaks(entries, year), card: streakCard },
  ];
  const cards = ranked.map((r) => r.card(r.list)).filter(Boolean);
  // Keyed off the CARD, not the list: a category whose winner could not be
  // written has no label to mark anybody with, and marking rows for a claim the
  // page never made is how a badge becomes unexplainable.
  const byKind = new Map(cards.map((c) => [c.kind, c.label]));
  const awards = ranked
    .filter((r) => byKind.has(r.kind) && r.list.length)
    .map((r) => ({
      kind: r.kind,
      label: byKind.get(r.kind),
      keys: r.list.slice(0, TOP_N).map((c) => (c.e ? c.e.p.key : c.p.key)),
    }));
  return { cards, awards };
}

/// The cards alone, for callers that want only them.
export function buildHighlights(entries, opts) {
  return buildYearAwards(entries, opts).cards;
}

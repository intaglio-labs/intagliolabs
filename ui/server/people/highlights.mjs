// THE YEAR'S HIGHLIGHT CARDS: the four claims the timeline can make about a
// year without a model — a favorite, someone new, a reconnection, and someone
// drifting. Streak remains a supporting measurement inside Favorites and
// Reconnected; it is no longer its own competing category.
//
// Same rule as the rest of ui/server/people: CODE decides, no model. Every
// line these produce is arithmetic over the month-bucketed timeline
// (graph.mjs), so the owner can audit any card by counting.
//
// TWO RULES SHAPE EVERY FUNCTION HERE.
//
// 1. A card that cannot be earned is not shown. Each builder returns null
//    rather than a softened claim, and the page renders only what comes back
//    (owner, 2026-08-25). The design mock shows four cards; a real year often
//    supports two. Four cards where the data supports two is how a measurement
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

// Two consecutive direct-contact days are the smallest honest "streak". A
// one-day exchange is activity, not a run.
const STREAK_MIN_DAYS = 2;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const monthName = (m) => MONTHS[m - 1] ?? String(m);

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

// The longest direct-contact run within ONE year. `activeDays` comes directly
// from graph.mjs's timestamped rows; month buckets are intentionally too coarse
// for a claim measured in days.
function longestDayStreak(activeDays, year) {
  const prefix = `${year}-`;
  const idx = [...new Set((activeDays ?? [])
    .filter((day) => typeof day === 'string' && day.startsWith(prefix))
    .map((day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000)))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let best = { len: 0, start: null, end: null, days: idx.length };
  let runStart = null;
  for (let i = 0; i < idx.length; i += 1) {
    if (i === 0 || idx[i] !== idx[i - 1] + 1) runStart = idx[i];
    const len = idx[i] - runStart + 1;
    if (len > best.len) best = { len, start: runStart, end: idx[i], days: idx.length };
  }
  return best;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const messageCount = (n) => {
  const count = Number(n) || 0;
  return `${count.toLocaleString('en-US')} message${count === 1 ? '' : 's'}`;
};

// ---- the four cards ----------------------------------------------------

// The most engaged person of the year. The only card that is a plain maximum,
// so it is the only one that is nearly always available.
//
// EACH OF THESE NOW RANKS RATHER THAN PICKS. The card shows the ranking's top
// three and the list marks everybody in the category's top ten, so the ranking
// a builder was already computing is returned instead of thrown away. One
// scan, two answers; the alternative was a second pass with the same predicates
// in it, which is two places to keep one definition of "drifting".
function favorites(entries) {
  return [...entries]
    .filter((e) => (e.engagement ?? 0) > 0)
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0));
}

function favoriteLine(entry, year) {
  const messages = entry.messages ?? 0;
  const streak = longestDayStreak(entry.p?.activeDays, year).len;
  const activity = messageCount(messages);
  return streak >= STREAK_MIN_DAYS ? `${activity}, ${streak} day streak` : activity;
}

function favoriteCard(ranked, year) {
  const top = ranked[0];
  if (!top) return null;
  return {
    kind: 'person-of-the-year',
    // ~~"most engaged".~~ Renamed to "favorites" (owner, 2026-08-27). The card
    // still measures exactly what it measured — the year's maximum engagement,
    // see `line` — but "most engaged" described the arithmetic to the reader
    // instead of telling them what it means. The KIND is unchanged: it is the
    // key the page draws an icon from and the name the tests know it by.
    label: 'favorites',
    key: top.p.key,
    name: top.p.name,
    line: favoriteLine(top, year),
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
    // The message count gets a returner through the eligibility gate, but the
    // card's line should show whether that return became a real renewed rhythm
    // rather than repeating raw volume. `activeDays` is direct correspondence
    // only, so a "day streak" is an honest claim about the two people.
    out.push({
      e,
      lastPrior,
      streak: longestDayStreak(e.p.activeDays, year),
      activeMonths: activeMonths(e.p.timeline, year, { withRoom: true }).length,
    });
  }
  return out.sort((a, b) => b.e.messages - a.e.messages);
}

function reconnectedLine(candidate) {
  const pickup = candidate.streak.len >= STREAK_MIN_DAYS
    ? `${candidate.streak.len}-day streak`
    : candidate.streak.days > 0
      ? plural(candidate.streak.days, 'active day')
      : plural(candidate.activeMonths, 'active month');
  return `quiet since ${candidate.lastPrior} — then ${pickup}`;
}

function reconnectedCard(ranked) {
  const best = ranked[0];
  if (!best) return null;
  return {
    kind: 'back-from-your-past',
    // ~~"reconnected after a gap".~~ Shortened (owner, 2026-08-26): the gap is
    // already spelled out underneath. The second half is the renewed cadence,
    // not a raw message total: it makes the return visible at a human scale.
    label: 'reconnected',
    key: best.e.p.key,
    name: best.e.p.name,
    line: reconnectedLine(best),
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

function newLine(candidate) {
  return `met in ${monthName(candidate.first)}, ${messageCount(candidate.e.messages)} since`;
}

function newCard(ranked) {
  const best = ranked[0];
  if (!best) return null;
  return {
    kind: 'rising-star',
    label: 'new here',
    key: best.e.p.key,
    name: best.e.p.name,
    line: newLine(best),
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
    out.push({ e, silent, months });
  }
  return out.sort((a, b) => b.e.engagement - a.e.engagement);
}

function driftingStat(candidate, { includeLabel = false } = {}) {
  const quiet = `quiet for ${plural(candidate.silent, 'month')}`;
  return includeLabel ? `drifting… ${quiet}` : quiet;
}

function driftingCard(ranked) {
  const best = ranked[0];
  if (!best) return null;
  return {
    kind: 'drifting',
    // ~~"no recent contact".~~ "drifting" (owner, 2026-08-26), which is the
    // word the kind has always used and the thing the card actually measures:
    // a rhythm that stopped, not an absence of contact.
    label: 'drifting',
    key: best.e.p.key,
    name: best.e.p.name,
    line: driftingStat(best),
  };
}

// The podium needs the same person-specific sentence the old one-winner card
// printed underneath its name. Keep those sentences on the server beside the
// ranking math: deriving them from the capped display rows would omit a quiet
// drifter or returner who legitimately ranks outside the ordinary page.
function cardPerson(kind, candidate, year) {
  const entry = candidate.e ?? candidate;
  let line = '';
  if (kind === 'person-of-the-year') line = favoriteLine(entry, year);
  else if (kind === 'back-from-your-past') line = reconnectedLine(candidate);
  else if (kind === 'rising-star') line = newLine(candidate);
  else if (kind === 'drifting') line = driftingStat(candidate);
  return { key: entry.p.key, name: entry.p.name, line };
}

// How many people carry a category's mark in the list. Every one of the four
// labels gets its own top ten; fewer qualify on a thin year and the list never
// pads or invents recipients.
const TOP_N = 10;

/// Both answers from one scan: the cards, and who the list should mark.
///
/// `entries` is the year's people sorted by engagement desc, each
/// { p, messages, met, engagement } — the same rows buildYear ranks, BEFORE
/// its display cap, so a highlight can name someone past row 250.
///
/// Returns { cards, awards }. `cards` is what it always was: every card the
/// year can actually earn, in the mock's order, nulls dropped. `awards` is one
/// entry per category that HAS anybody, carrying its label and the keys of its
/// top ten in rank order — the page joins it to the rows by key.
///
/// The label lives here and travels with the keys on purpose. It is the same
/// string the card shows, and a copy of it in the page is a second place to
/// forget when the owner renames one (which has now happened twice in a day).
export function buildYearAwards(entries, { year, now = Date.now() } = {}) {
  if (!Array.isArray(entries) || !entries.length) return { cards: [], awards: [] };
  const ranked = [
    { kind: 'person-of-the-year', list: favorites(entries), card: favoriteCard },
    { kind: 'rising-star', list: risingStars(entries, year, now), card: newCard },
    { kind: 'back-from-your-past', list: reconnections(entries, year), card: reconnectedCard },
    { kind: 'drifting', list: drifters(entries, year, now), card: driftingCard },
  ];
  const cards = ranked.map((r) => {
    const card = r.card(r.list, year, now);
    if (!card) return null;
    return {
      ...card,
      people: r.list.slice(0, 3).map((candidate) => cardPerson(r.kind, candidate, year)),
      count: Math.min(TOP_N, r.list.length),
    };
  }).filter(Boolean);
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
      // Row marks are not generic category labels. The number is computed on
      // the same per-year entry that earned the mark, so "favorite" tells the
      // reader exactly how many direct messages passed between them that year,
      // plus its supporting calendar-day run when one exists.
      detailByKey: Object.fromEntries(r.list.slice(0, TOP_N).map((c) => {
        const entry = c.e ?? c;
        const key = entry.p.key;
        if (r.kind === 'person-of-the-year') {
          return [key, favoriteLine(entry, year)];
        }
        if (r.kind === 'rising-star') {
          return [key, `new here · met in ${monthName(c.first)}, ${messageCount(entry.messages)} since`];
        }
        if (r.kind === 'drifting') {
          return [key, driftingStat(c, { includeLabel: true })];
        }
        return [key, byKind.get(r.kind)];
      })),
    }));
  return { cards, awards };
}

/// The cards alone, for callers that want only them.
export function buildHighlights(entries, opts) {
  return buildYearAwards(entries, opts).cards;
}

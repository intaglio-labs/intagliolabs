// The subjective half of the energy audit: the label, and what may be computed
// from it.
//
// digest.mjs computes five objective series over the corpus and every one of
// them is descriptive -- it can report that meetings were up and sleep was
// down, and it cannot report that one caused the other. This module holds the
// other input: what the owner says the day was actually like. Together they
// support an attribution; separately neither does.
//
// THE ORDER MATTERS, AND BUILDING IT THE OTHER WAY ROUND COSTS REAL TIME. Do
// the feature side first and you end up with a full table of computed features
// and no ratings -- every correlation withheld, nothing to withhold them from.
// The features were never the scarce input. The label is, and it decays: rating
// how last Tuesday felt is worse data than rating today, so the cost of building
// this late is paid in data quality that cannot be recovered afterwards.
//
// Zero dependencies, node built-ins only, and it works over any node:sqlite
// handle including a read-only one -- same contract as digest.mjs, whose day
// helpers and late-night definition are reused here rather than re-derived, so
// a rating and a feature always agree about which day they belong to.

import { isLateNightHour, localDayKey, localDayStart } from './digest.mjs';

// THE FLOOR. Below this many rated days, correlate() refuses and says so
// instead of returning a number.
//
// Not a statistical ceremony -- a guard against the specific failure that a
// correlation over three points is a lie that LOOKS like a product. It renders
// as "meetings drain you", reads as a finding, and is noise. Ported from the
// same floor was set elsewhere for the same reason, after watching a two-point
// "trend" render as confidently as a real one. Raise it on evidence; do not
// lower it to make an early screen look populated.
export const MIN_RATINGS = 14;

// 1..5, and deliberately not a slider. Five points is what a person can apply
// consistently to a whole day; eleven is what produces a spurious precision
// nobody can reproduce next week.
export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

const SCOPES = new Set(['day', 'conversation']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

function systemZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Every guard here is also a CHECK in the schema. Both, on purpose: the CHECK
// is what holds when a future caller bypasses this module, and these messages
// are what a caller can act on -- "score must be an integer 1-5" beats
// SQLITE_CONSTRAINT.
export function recordRating(db, { scope = 'day', day, zone, contextId = null, score, note = null, now = Date.now() } = {}) {
  if (!SCOPES.has(scope)) throw new Error(`recordRating: scope must be day|conversation, got ${JSON.stringify(scope)}`);
  const tz = zone ?? systemZone();
  const key = day ?? localDayKey(now, tz);
  if (!DAY_RE.test(key)) throw new Error(`recordRating: day must be YYYY-MM-DD, got ${JSON.stringify(key)}`);
  if (!Number.isInteger(score) || score < SCORE_MIN || score > SCORE_MAX) {
    throw new Error(`recordRating: score must be an integer ${SCORE_MIN}-${SCORE_MAX}, got ${JSON.stringify(score)}`);
  }
  if ((scope === 'conversation') !== (contextId !== null)) {
    throw new Error(
      "recordRating: a 'conversation' rating needs a contextId and a 'day' rating must not carry one"
    );
  }
  if (!Number.isFinite(now)) throw new Error('recordRating: {now} must be epoch milliseconds');

  // `source` is hard-coded, never a parameter. A caller cannot pass 'model'
  // here even by accident, and the schema CHECK refuses it if one tries by
  // another route. See the table comment in hermes.mjs for why this is the
  // load-bearing line in the whole feature.
  db.prepare(
    'INSERT INTO energy_rating(scope, day, zone, context_id, score, source, note, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, 'user', ?, ?)"
  ).run(scope, key, tz, contextId, score, note, Math.trunc(now));

  return { scope, day: key, zone: tz, contextId, score };
}

// THE CURRENT RATINGS, EACH CARRYING ITS ZONE. Reads the view so the "latest
// append wins" rule lives in one place.
//
// The zone is returned, not discarded, and that is a correctness requirement
// rather than tidiness. A day string is only a day once you know the zone it was
// recorded in: rate a day in America/Chicago, fly to Asia/Tokyo, and running the
// analysis there would pair that score against a UTC interval six hours off the
// one the owner was actually rating. The score is real data about a specific
// stretch of time, and the (day, zone) pair is what identifies that stretch.
export function currentRatings(db) {
  return db
    .prepare('SELECT day, zone, score FROM v_energy_rating_current ORDER BY day, zone')
    .all()
    .map((r) => ({ day: String(r.day), zone: String(r.zone), score: Number(r.score) }));
}

// Which day LABELS have a rating, in any zone. This is the right question for
// "should I ask about this day again?" -- the answer is no regardless of which
// zone the owner was in when they answered -- and the wrong one for pairing
// features, which needs the interval.
export function ratedDayLabels(db) {
  return new Set(currentRatings(db).map((r) => r.day));
}

// The objective side, per local day rather than aggregated over the window --
// a correlation needs the series, not the mean. Definitions deliberately match
// digest.mjs: a message is a context row from a comms source, a meeting is a
// calendar row with a numeric meta.start_ms, late-night is 22:00-05:00 local.
const COMMS_SOURCES = ['imessage', 'mail', 'whatsapp'];

function wallHour(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit' })
    .formatToParts(ms);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
}

// The next calendar label, by pure arithmetic on the label itself. Correct in
// every zone because it never touches an instant -- '2027-02-28' is followed by
// '2027-03-01' whatever the offset, and localDayStart() resolves each label to
// its real instant afterwards.
function nextDayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// The exact UTC half-open interval a (day, zone) pair denotes. Derived rather
// than stored: localDayStart() already resolves a label in a zone, including
// across a DST transition, so the boundaries are recoverable from what the
// rating records and cannot drift from it.
export function dayInterval(day, zone) {
  if (!DAY_RE.test(day)) throw new Error(`dayInterval: day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  return { startMs: localDayStart(day, zone), endMs: localDayStart(nextDayLabel(day), zone) };
}

// Features over one explicit interval, in one explicit zone. Every feature path
// goes through here, so a rating's features and a window's features are computed
// by the same code against the same definitions.
export function featuresForInterval(db, { startMs, endMs, zone }) {
  const out = { messages: 0, lateNight: 0, meetings: 0 };
  const placeholders = COMMS_SOURCES.map(() => '?').join(', ');
  for (const row of db
    .prepare(`SELECT ts FROM context WHERE source IN (${placeholders}) AND ts >= ? AND ts < ?`)
    .all(...COMMS_SOURCES, startMs, endMs)) {
    const ts = Number(row.ts);
    if (!Number.isFinite(ts)) continue;
    out.messages += 1;
    if (isLateNightHour(wallHour(ts, zone))) out.lateNight += 1;
  }
  for (const row of db
    .prepare("SELECT meta FROM context WHERE source = 'calendar'")
    .all()) {
    let meta;
    try {
      meta = JSON.parse(String(row.meta ?? 'null'));
    } catch {
      continue;
    }
    const startedAt = meta === null ? NaN : Number(meta.start_ms);
    if (!Number.isFinite(startedAt)) continue;
    if (startedAt >= startMs && startedAt < endMs) out.meetings += 1;
  }
  return out;
}

// Features for exactly what a rating was rating.
export function featuresForRating(db, { day, zone }) {
  const { startMs, endMs } = dayInterval(day, zone);
  return { day, zone, ...featuresForInterval(db, { startMs, endMs, zone }) };
}

// The `days` complete local days ending yesterday, oldest first -- same window
// convention as the digest, so the two never disagree about whether today counts
// (it does not; it is not over). Used for LISTING days, not for pairing: the
// window is in one analysis zone by construction, which is the right frame for
// "which days exist to ask about" and the wrong one for "what was this rating
// rating".
export function dayFeatures(db, { days = 30, zone, now = Date.now() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('dayFeatures: {days} must be an integer between 1 and 366');
  }
  if (!Number.isFinite(now)) throw new Error('dayFeatures: {now} must be epoch milliseconds');
  const tz = zone ?? systemZone();

  const labels = [];
  let cursor = localDayStart(localDayKey(now, tz), tz);
  for (let i = 0; i < days; i += 1) {
    const label = localDayKey(cursor - 1, tz);
    labels.unshift(label);
    cursor = localDayStart(label, tz);
  }

  return labels.map((day) => featuresForRating(db, { day, zone: tz }));
}

// Days that have features but no rating -- what the interface should ask for
// next. Newest first: recall decays, so the most recent unrated day is the one
// worth asking about. Compared on the LABEL, because a day already answered in
// another zone should not be asked again.
export function pendingDays(db, { days = 30, zone, now = Date.now() } = {}) {
  const rated = ratedDayLabels(db);
  return dayFeatures(db, { days, zone, now })
    .filter((d) => !rated.has(d.day))
    .reverse()
    .map((d) => d.day);
}

// Pearson r, returning null rather than a number when it is undefined. Zero
// variance in either series is the common case early on -- every day rated 4 --
// and NaN dressed as a correlation is exactly the kind of confidently-wrong
// output the digest's honesty rules exist to prevent.
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export const FEATURES = Object.freeze(['messages', 'lateNight', 'meetings']);

// The attribution, or an honest refusal. Never both, and never a number with a
// caveat attached -- a caveat is what gets dropped when the value is rendered.
//
// PAIRS EACH RATING WITH ITS OWN INTERVAL. The obvious implementation builds one
// window of features in the analysis zone and joins on the day string, and it is
// wrong: a score recorded in America/Chicago would be correlated against
// whatever six-hour-offset stretch that same label denotes wherever the analysis
// happens to run. Every rating therefore carries its zone and its features are
// recomputed over dayInterval(day, zone) -- so travelling changes nothing about
// what an existing rating means.
//
// `days` bounds how far back to look, in the analysis zone, which is only a
// cutoff on which ratings to include. It does not decide any rating's boundaries.
export function correlate(db, { days = 30, zone, now = Date.now() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('correlate: {days} must be an integer between 1 and 366');
  }
  const tz = zone ?? systemZone();
  const horizon = localDayStart(localDayKey(now, tz), tz) - days * 86_400_000;

  const paired = currentRatings(db)
    .map((r) => ({ ...r, ...dayInterval(r.day, r.zone) }))
    .filter((r) => r.endMs > horizon && r.startMs <= now)
    .map((r) => ({
      ...r,
      ...featuresForInterval(db, { startMs: r.startMs, endMs: r.endMs, zone: r.zone }),
    }));

  if (paired.length < MIN_RATINGS) {
    return {
      ok: false,
      reason: 'not_enough_ratings',
      have: paired.length,
      need: MIN_RATINGS,
      // What to do about it, because "not enough data" with no next step is
      // where a feature goes to die.
      pending: pendingDays(db, { days, zone: tz, now }).slice(0, 7),
    };
  }

  const scores = paired.map((r) => r.score);
  const correlations = {};
  for (const key of FEATURES) {
    correlations[key] = pearson(paired.map((r) => r[key]), scores);
  }
  // zones is reported because a series spanning two of them is a fact about the
  // data a reader should see, not a detail to smooth over.
  return {
    ok: true,
    n: paired.length,
    days,
    zones: [...new Set(paired.map((r) => r.zone))].sort(),
    correlations,
  };
}

// The subjective half of the energy audit: the label, and what may be computed
// from it.
//
// digest.mjs computes five objective series over the corpus and every one of
// them is descriptive -- it can report that meetings were up and sleep was
// down, and it cannot report that one caused the other. This module holds the
// other input: what the owner says the day was actually like. Together they
// support an attribution; separately neither does.
//
// THE ORDER MATTERS AND IT COST THE SIBLING PROJECT REAL TIME. The rig built
// the feature side first and ended up with 1,452 computed features and zero
// ratings -- every correlation withheld, nothing to withhold them from. The
// features were never the scarce input. The label is, and it decays: rating how
// last Tuesday felt is worse data than rating today, so the cost of building
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
// rig, which set the same floor for the same reason after watching a two-point
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

// day -> score, latest append winning. Reads the view so the "latest wins"
// rule lives in one place.
export function currentDayRatings(db) {
  const out = new Map();
  for (const r of db.prepare('SELECT day, score FROM v_energy_rating_current ORDER BY day').all()) {
    out.set(String(r.day), Number(r.score));
  }
  return out;
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

export function dayFeatures(db, { days = 30, zone, now = Date.now() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('dayFeatures: {days} must be an integer between 1 and 366');
  }
  if (!Number.isFinite(now)) throw new Error('dayFeatures: {now} must be epoch milliseconds');
  const tz = zone ?? systemZone();

  // The `days` complete local days ending yesterday, oldest first -- same
  // window convention as the digest, so the two never disagree about whether
  // today counts (it does not; it is not over).
  const todayKey = localDayKey(now, tz);
  const todayStart = localDayStart(todayKey, tz);
  const keys = [];
  let cursor = todayStart;
  for (let i = 0; i < days; i += 1) {
    const key = localDayKey(cursor - 1, tz);
    keys.unshift({ key, startMs: localDayStart(key, tz) });
    cursor = keys[0].startMs;
  }
  for (let i = 0; i < keys.length; i += 1) {
    keys[i].endMs = i + 1 < keys.length ? keys[i + 1].startMs : todayStart;
  }

  const blank = () => ({ messages: 0, lateNight: 0, meetings: 0 });
  const perDay = new Map(keys.map((d) => [d.key, blank()]));
  const windowStart = keys[0].startMs;
  const windowEnd = todayStart;
  const bucket = (ms) => {
    const d = keys.find((k) => ms >= k.startMs && ms < k.endMs);
    return d === undefined ? null : perDay.get(d.key);
  };

  const commsPlaceholders = COMMS_SOURCES.map(() => '?').join(', ');
  for (const row of db
    .prepare(`SELECT ts FROM context WHERE source IN (${commsPlaceholders}) AND ts >= ? AND ts < ?`)
    .all(...COMMS_SOURCES, windowStart, windowEnd)) {
    const ts = Number(row.ts);
    if (!Number.isFinite(ts)) continue;
    const b = bucket(ts);
    if (b === null) continue;
    b.messages += 1;
    if (isLateNightHour(wallHour(ts, tz))) b.lateNight += 1;
  }

  for (const row of db.prepare("SELECT meta FROM context WHERE source = 'calendar'").all()) {
    let meta;
    try {
      meta = JSON.parse(String(row.meta ?? 'null'));
    } catch {
      continue;
    }
    const startMs = meta === null ? NaN : Number(meta.start_ms);
    if (!Number.isFinite(startMs)) continue;
    const b = bucket(startMs);
    if (b !== null) b.meetings += 1;
  }

  return keys.map((d) => ({ day: d.key, ...perDay.get(d.key) }));
}

// Days that have features but no rating -- what the interface should ask for
// next. Newest first: recall decays, so the most recent unrated day is the one
// worth asking about.
export function pendingDays(db, { days = 30, zone, now = Date.now() } = {}) {
  const rated = currentDayRatings(db);
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
export function correlate(db, { days = 30, zone, now = Date.now() } = {}) {
  const rated = currentDayRatings(db);
  const features = dayFeatures(db, { days, zone, now });
  const paired = features.filter((d) => rated.has(d.day));

  if (paired.length < MIN_RATINGS) {
    return {
      ok: false,
      reason: 'not_enough_ratings',
      have: paired.length,
      need: MIN_RATINGS,
      // What to do about it, because "not enough data" with no next step is
      // where a feature goes to die.
      pending: pendingDays(db, { days, zone, now }).slice(0, 7),
    };
  }

  const scores = paired.map((d) => rated.get(d.day));
  const correlations = {};
  for (const key of FEATURES) {
    correlations[key] = pearson(paired.map((d) => d[key]), scores);
  }
  return { ok: true, n: paired.length, days, correlations };
}

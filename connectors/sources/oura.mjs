// The Oura connector (daemon name `oura`, hermes source `health` — the
// entity-id scheme names the data, not the vendor; the mapping lives in
// daemon.mjs CONNECTOR_HERMES_SOURCE). One row per metric per COMPLETED
// local day, entity `health:<metric>:<YYYY-MM-DD>`, plus one row per
// workout, entity `health:workout:<start_iso>`.
//
// Cursorless by design: every run re-polls a trailing window (steady 7 days;
// --backfill widens it to config.oura.backfillDays, default 90) because Oura
// recomputes daily summaries retroactively — the re-poll catches the
// corrections and hermes' entity upsert absorbs them as updated/unchanged.
// The `oura:last_polled_day` cursor recorded after each pass is
// observability, not control flow.
//
// Timezone: Oura's `day` strings ARE the user's local days — the ring's app
// computed them; we never re-derive a day from a timestamp. "Completed" is
// judged against ctx.now in this Mac's local zone, and today is NEVER
// written: an in-progress day would churn as `updated` on every poll for no
// reader benefit, so the fetch window simply ends at yesterday.
import { existsSync } from 'node:fs';
import {
  createOuraClient,
  defaultOuraClientIdPath,
  defaultOuraClientSecretPath,
  defaultOuraTokensPath,
} from '../lib/ouraClient.mjs';

export const STEADY_WINDOW_DAYS = 7;
export const DEFAULT_BACKFILL_DAYS = 90;

// The slice of Oura's collections this connector reads. daily_sleep is the
// nightly score; `sleep` is the per-period collection (multiple periods per
// day = naps, and average_hrv lives ONLY here); the rest are one summary per
// day, except workout (one record per workout).
const COLLECTIONS = Object.freeze([
  'daily_sleep',
  'sleep',
  'daily_readiness',
  'daily_activity',
  'daily_stress',
  'workout',
]);

const pad2 = (n) => String(n).padStart(2, '0');

// Local-zone day math via Date components, never via epoch±86400s: DST days
// are 23 or 25 hours long and epoch arithmetic lands on the wrong day twice
// a year. The Date constructor normalizes out-of-range components in the
// LOCAL zone, which is exactly the zone "completed local day" is defined in.
export function localDayString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function shiftLocalDay(day, deltaDays) {
  const [y, m, d] = day.split('-').map(Number);
  return localDayString(new Date(y, m - 1, d + deltaDays));
}

// ts for a daily metric row = the last millisecond of that local day, so the
// row sorts after everything that happened during the day it summarizes.
export function endOfLocalDayMs(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + 1).getTime() - 1;
}

// "1h 05m" / "32m". Minutes-first rounding so 3599 s reads 1h 00m, not
// 0h 60m.
function fmtDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

const finite = (v) => Number.isFinite(v);

// --- one compact human sentence per metric ---------------------------------
//
// The sentences ARE corpus text (registry: ops/CONNECTORS.md) — putting
// values in them is the point. They must never appear in logs.

function sleepSentence(daily, periods) {
  const sum = (key) => periods.reduce((acc, p) => acc + (finite(p?.[key]) ? p[key] : 0), 0);
  const total = sum('total_sleep_duration');
  const score = finite(daily?.score) ? daily.score : null;
  if (total === 0 && periods.length === 0) {
    return score !== null ? `Sleep score ${score}.` : 'Sleep recorded.';
  }
  let s = `Slept ${fmtDuration(total)}`;
  if (periods.length > 1) s += ` in ${periods.length} periods`;
  if (score !== null) s += ` (score ${score})`;
  const stages = [];
  const deep = sum('deep_sleep_duration');
  if (deep > 0) stages.push(`${fmtDuration(deep)} deep`);
  const rem = sum('rem_sleep_duration');
  if (rem > 0) stages.push(`${fmtDuration(rem)} REM`);
  const light = sum('light_sleep_duration');
  if (light > 0) stages.push(`${fmtDuration(light)} light`);
  const awake = sum('awake_time');
  if (awake > 0) stages.push(`${fmtDuration(awake)} awake`);
  return stages.length > 0 ? `${s}: ${stages.join(', ')}.` : `${s}.`;
}

function hrvSentence(values) {
  const avg = Math.round(values.reduce((a, v) => a + v, 0) / values.length);
  return values.length > 1
    ? `Average overnight HRV ${avg} ms across ${values.length} sleep periods.`
    : `Average overnight HRV ${avg} ms.`;
}

function readinessSentence(r) {
  let s = finite(r.score) ? `Readiness score ${r.score}` : 'Readiness recorded';
  if (finite(r.temperature_deviation)) {
    const t = Math.round(r.temperature_deviation * 100) / 100;
    s += `; body temperature ${t > 0 ? '+' : ''}${t}°C from baseline`;
  }
  return `${s}.`;
}

function activitySentence(a) {
  const clauses = [];
  if (finite(a.steps)) clauses.push(`${a.steps} steps`);
  if (finite(a.active_calories)) clauses.push(`${a.active_calories} active calories`);
  if (clauses.length === 0) {
    return finite(a.score) ? `Activity score ${a.score}.` : 'Activity summary recorded.';
  }
  let s = `Activity: ${clauses.join(', ')}`;
  if (finite(a.score)) s += ` (score ${a.score})`;
  return `${s}.`;
}

function stressSentence(st) {
  const spans = [];
  if (finite(st.stress_high)) spans.push(`${fmtDuration(st.stress_high)} high stress`);
  if (finite(st.recovery_high)) spans.push(`${fmtDuration(st.recovery_high)} recovery`);
  if (typeof st.day_summary === 'string' && st.day_summary) {
    return spans.length > 0 ? `Stress: ${st.day_summary} (${spans.join(', ')}).` : `Stress: ${st.day_summary}.`;
  }
  return spans.length > 0 ? `Stress: ${spans.join(', ')}.` : 'Stress summary recorded.';
}

function workoutSentence(w) {
  let s = `Workout: ${typeof w.activity === 'string' && w.activity ? w.activity : 'unlabeled'}`;
  if (typeof w.label === 'string' && w.label) s += ` (${w.label})`;
  const startMs = Date.parse(w.start_datetime);
  const endMs = Date.parse(w.end_datetime);
  if (finite(startMs) && finite(endMs) && endMs > startMs) s += `, ${fmtDuration((endMs - startMs) / 1000)}`;
  if (finite(w.calories)) s += `, ${w.calories} calories`;
  if (typeof w.intensity === 'string' && w.intensity) s += `, ${w.intensity} intensity`;
  return `${s}.`;
}

// --- aggregation ------------------------------------------------------------

function groupByDay(records) {
  const map = new Map();
  for (const rec of records) {
    // A record without a day string cannot be aggregated or identified;
    // dropping it here is defensive access, the same posture as the
    // meta-less daily_resilience records Oura ships.
    if (typeof rec?.day !== 'string' || !rec.day) continue;
    if (!map.has(rec.day)) map.set(rec.day, []);
    map.get(rec.day).push(rec);
  }
  return map;
}

// Pure: collections in, ingest rows out. Exported for the golden tests.
// Every `meta` is the raw Oura record(s) verbatim — including their Oura
// `id` and (when present) `meta.version`/`meta.updated_at` — so provenance
// and Oura's own freshness marker survive into the corpus; hermes' upsert is
// what absorbs Oura's retroactive recomputation.
export function buildRows(collections, todayLocalDay) {
  // Strict `<` keeps today out: Oura's day strings are the user's local
  // days, and YYYY-MM-DD compares correctly as a string.
  const completed = (rec) => typeof rec?.day === 'string' && rec.day < todayLocalDay;

  const dailySleepByDay = groupByDay((collections.daily_sleep ?? []).filter(completed));
  const periodsByDay = groupByDay((collections.sleep ?? []).filter(completed));
  const readinessByDay = groupByDay((collections.daily_readiness ?? []).filter(completed));
  const activityByDay = groupByDay((collections.daily_activity ?? []).filter(completed));
  const stressByDay = groupByDay((collections.daily_stress ?? []).filter(completed));

  const days = [...new Set([
    ...dailySleepByDay.keys(),
    ...periodsByDay.keys(),
    ...readinessByDay.keys(),
    ...activityByDay.keys(),
    ...stressByDay.keys(),
  ])].sort();

  const rows = [];
  const row = (metric, day, text, meta) => ({
    ts: endOfLocalDayMs(day),
    source: 'health',
    entity_id: `health:${metric}:${day}`,
    text,
    meta,
  });

  for (const day of days) {
    // Sleep periods are semantically a set; hermes keeps array order in its
    // content hash, so sort them (bedtime_start, then id) or a reordered
    // API response would read as an edit on every poll.
    const periods = (periodsByDay.get(day) ?? [])
      .slice()
      .sort(
        (a, b) =>
          String(a?.bedtime_start ?? '').localeCompare(String(b?.bedtime_start ?? '')) ||
          String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
      );
    const dailySleep = (dailySleepByDay.get(day) ?? [])[0] ?? null;

    if (dailySleep !== null || periods.length > 0) {
      rows.push(row('sleep', day, sleepSentence(dailySleep, periods), {
        daily_sleep: dailySleep,
        sleep_periods: periods,
      }));
    }

    const hrvValues = periods.map((p) => p?.average_hrv).filter(finite);
    if (hrvValues.length > 0) {
      rows.push(row('hrv', day, hrvSentence(hrvValues), { sleep_periods: periods }));
    }

    const readiness = (readinessByDay.get(day) ?? [])[0];
    if (readiness !== undefined) {
      rows.push(row('readiness', day, readinessSentence(readiness), { daily_readiness: readiness }));
    }

    const activity = (activityByDay.get(day) ?? [])[0];
    if (activity !== undefined) {
      rows.push(row('activity', day, activitySentence(activity), { daily_activity: activity }));
    }

    const stress = (stressByDay.get(day) ?? [])[0];
    if (stress !== undefined) {
      rows.push(row('stress', day, stressSentence(stress), { daily_stress: stress }));
    }
  }

  // Workouts: one row each, keyed and timestamped by the workout's own
  // start. The completed-day filter applies here too — a workout from today
  // simply lands on tomorrow's poll, which keeps the no-churn rule uniform.
  const skippedWorkoutIds = [];
  for (const w of (collections.workout ?? []).filter(completed)) {
    const startMs = Date.parse(w?.start_datetime);
    if (typeof w?.start_datetime !== 'string' || !finite(startMs)) {
      // No parseable start means no entity id and no ts; the Oura id is
      // safe to log (a UUID, not content).
      skippedWorkoutIds.push(w?.id ?? '(no id)');
      continue;
    }
    rows.push({
      ts: startMs,
      source: 'health',
      entity_id: `health:workout:${w.start_datetime}`,
      text: workoutSentence(w),
      meta: { workout: w },
    });
  }

  return { rows, skippedWorkoutIds };
}

// --- the source -------------------------------------------------------------

export default {
  name: 'oura',

  // The daemon calls this with no arguments before every run; the overrides
  // parameter exists only so tests can point at fixture paths. Sandbox mode
  // is deliberately NOT a way past this gate: needs() cannot see config (the
  // daemon does not pass it), and an unprovisioned oura source should wait
  // loudly, not poll Oura's sample data.
  async needs({ tokensPath, clientIdPath, clientSecretPath } = {}) {
    const missing = [];
    const tokens = tokensPath ?? defaultOuraTokensPath();
    if (!existsSync(tokens)) {
      missing.push(`oura tokens file missing at ${tokens}: run \`node ops/oura-auth.mjs\` (browser consent)`);
    }
    // Refresh needs the client credentials, and Oura access tokens are
    // short-lived — a connector that can poll but never refresh would stall
    // mid-flight instead of at this gate.
    for (const [path, label] of [
      [clientIdPath ?? defaultOuraClientIdPath(), 'oura client id'],
      [clientSecretPath ?? defaultOuraClientSecretPath(), 'oura client secret'],
    ]) {
      if (!existsSync(path)) {
        missing.push(`${label} file missing at ${path}: see ops/CONNECTORS.md, "The Oura connector"`);
      }
    }
    return missing;
  },

  async run(ctx) {
    const { state, ingest, config, log, now, backfill } = ctx;
    const sandboxConfigured = config?.oura?.sandbox === true;
    // ctx.fetchImpl and ctx.ouraTokensPath are test seams: the daemon and
    // run.mjs never set them, so production always gets the real fetch and
    // the real secrets paths.
    const client = createOuraClient({
      sandbox: sandboxConfigured,
      fetchImpl: ctx.fetchImpl,
      tokensPath: ctx.ouraTokensPath,
      log,
      now,
    });
    if (!sandboxConfigured && client.mode === 'sandbox') {
      // The client's tokens-absent → sandbox fallback is for smoke tests and
      // doctor probes. A poll pass that nobody explicitly pointed at the
      // sandbox must never write Oura's SAMPLE data into the corpus as real
      // health rows — that would be fabricated data under `source: health`.
      throw new Error(
        'oura tokens file is missing and sandbox mode was not configured: refusing to ingest ' +
          'sample data as real health rows. Run `node ops/oura-auth.mjs`, or set config.oura.sandbox=true in a test.'
      );
    }

    const windowDays = backfill
      ? (config?.oura?.backfillDays ?? DEFAULT_BACKFILL_DAYS)
      : STEADY_WINDOW_DAYS;
    const today = localDayString(new Date(now()));
    // end_date = yesterday: the API filters on `day`, so completed-day
    // exclusion happens server-side; buildRows re-filters defensively in
    // case a record's day disagrees with the window it was served for.
    const endDate = shiftLocalDay(today, -1);
    const startDate = shiftLocalDay(today, -windowDays);

    const collections = {};
    for (const name of COLLECTIONS) {
      // Sequential on purpose: six small requests per pass make concurrency
      // pointless, and one collection failing names itself in the error
      // instead of surfacing as an AggregateError.
      collections[name] = await client.fetchCollection(name, {
        start_date: startDate,
        end_date: endDate,
      });
    }

    const { rows, skippedWorkoutIds } = buildRows(collections, today);
    for (const id of skippedWorkoutIds) log.warn('oura_workout_skipped', { id });

    const counts = await ingest(rows);
    state.setCursor('oura:last_polled_day', endDate, now());
    log.info('oura_poll', {
      mode: client.mode,
      startDate,
      endDate,
      rows: rows.length,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
    });
    return {
      ingested: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
      deleted: 0,
    };
  },
};

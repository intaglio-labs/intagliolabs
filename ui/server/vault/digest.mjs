// The deterministic energy-audit digest: pure aggregation over the context
// table plus a fixed text rendering. NO model is involved anywhere in this
// file — every word in the output is either a number computed here or a trend
// word chosen by an explicit branch. This exact rendering is the fallback the
// future narrated digest degrades to, and the numbers block that digest must
// always include, so nothing here may become "roughly" or "approximately".
//
// Honesty rules, inherited from the repo's never-fabricate policy:
//   - a source that has NEVER ingested a row is REPORTED as {ok:false, reason}
//     and rendered as a MISSING line — never papered over as a zero;
//   - a source that HAS rows but simply had a quiet window renders real zeros;
//   - rows whose meta does not match the registry shape are counted as
//     unreadable and reported, never silently skipped or guessed at.
//
// Timezone design (documented per the digest contract): local-day boundaries
// are computed with Intl.DateTimeFormat against an IANA zone. The zone is an
// injectable parameter defaulting to the system zone — chosen over spawning a
// TZ-env child because a parameter is directly testable in-process, and the
// production caller (scripts/digest-once.mjs) simply omits it. Local midnight
// is found by fixed-point iteration on the zone offset, which converges across
// DST transitions; in a zone whose transition removes midnight itself (not the
// case for any US zone) the loop settles on the first instant of the day the
// zone actually has, which is the honest boundary.
//
// Zero dependencies: this is ui/ server-side code (node built-ins only), and
// it deliberately does not import hermes.mjs — it works over any node:sqlite
// handle (including a read-only one) so the digest can never accidentally
// hold a writable connection it does not need.

// --- local-day machinery ------------------------------------------------------

const formatterByZone = new Map();

function partsFormatter(zone) {
  let fmt = formatterByZone.get(zone);
  if (!fmt) {
    // hourCycle h23 (not hour12:false): some ICU builds render midnight as
    // hour "24" under hour12:false, which would corrupt the offset arithmetic.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterByZone.set(zone, fmt);
  }
  return fmt;
}

function wallParts(ms, zone) {
  const out = {};
  for (const { type, value } of partsFormatter(zone).formatToParts(ms)) out[type] = value;
  return out;
}

// Zone offset at instant `ms`: local wall clock minus UTC, in ms.
function zoneOffsetMs(ms, zone) {
  const p = wallParts(ms, zone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// 'YYYY-MM-DD' of the local day containing instant `ms`.
export function localDayKey(ms, zone) {
  const p = wallParts(ms, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

// Epoch ms of local midnight opening day `key` in `zone`. Fixed-point
// iteration: guess UTC midnight, correct by the offset observed at the guess,
// repeat — two passes suffice for a plain day, three across a DST shift.
export function localDayStart(key, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`localDayStart: bad day key ${JSON.stringify(key)}`);
  const wallMidnightAsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let t = wallMidnightAsUtc;
  for (let i = 0; i < 4; i++) {
    const next = wallMidnightAsUtc - zoneOffsetMs(t, zone);
    if (next === t) break;
    t = next;
  }
  return t;
}

// The `count` complete local days ending yesterday (relative to `now`),
// oldest first, each as {key, startMs, endMs}. Built by walking backward from
// the start of today, so every boundary is a real local midnight even when a
// day in the range is 23 or 25 hours long.
function completeDaysEndingYesterday(now, zone, count) {
  let end = localDayStart(localDayKey(now, zone), zone);
  const out = [];
  for (let i = 0; i < count; i++) {
    const key = localDayKey(end - 1, zone);
    const startMs = localDayStart(key, zone);
    out.unshift({ key, startMs, endMs: end });
    end = startMs;
  }
  return out;
}

// --- shared helpers -----------------------------------------------------------

function parseMeta(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sourceEverIngested(db, source) {
  return db.prepare('SELECT 1 AS one FROM context WHERE source = ? LIMIT 1').get(source) !== undefined;
}

function neverIngested(source) {
  return { ok: false, reason: `no ${source} rows have ever been ingested` };
}

// Trend direction with a ±3% dead band, chosen IN CODE so the renderer (and
// any future narrator) can only repeat it, never re-judge it.
function trendDirection(current, prior) {
  if (current === null || prior === null) return null;
  if (prior === 0) return current === 0 ? 'stable' : current > 0 ? 'higher' : 'lower';
  const ratio = current / prior;
  if (ratio > 1.03) return 'higher';
  if (ratio < 0.97) return 'lower';
  return 'stable';
}

// --- per-source aggregates ------------------------------------------------------

// calendar: windowed by meta.start_ms (the meeting's own time), not row ts —
// the digest asks when meetings HAPPENED. A row whose ts is in-window but
// whose meta lacks numeric start_ms/end_ms is unreadable: reported, and if
// nothing in the window is readable the whole aggregate is {ok:false} rather
// than a fabricated zero-meeting week.
function calendarAggregate(db, win) {
  if (!sourceEverIngested(db, 'calendar')) return neverIngested('calendar');
  const rows = db.prepare("SELECT ts, meta FROM context WHERE source = 'calendar'").all();
  const perDay = new Map(win.dayList.map((d) => [d.key, { count: 0, hours: 0 }]));
  let meetings = 0;
  let allDayCount = 0;
  let totalHours = 0;
  let unreadable = 0;
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const startMs = meta === null ? NaN : Number(meta.start_ms);
    const endMs = meta === null ? NaN : Number(meta.end_ms);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      const ts = Number(row.ts);
      if (ts >= win.startMs && ts < win.endMs) unreadable += 1;
      continue;
    }
    if (startMs < win.startMs || startMs >= win.endMs) continue;
    meetings += 1;
    const day = win.dayList.find((d) => startMs >= d.startMs && startMs < d.endMs);
    const bucket = perDay.get(day.key);
    bucket.count += 1;
    if (meta.all_day) {
      allDayCount += 1; // counted as a meeting, excluded from hours by spec
    } else {
      const hours = Math.max(0, endMs - startMs) / 3_600_000;
      bucket.hours += hours;
      totalHours += hours;
    }
  }
  if (meetings === 0 && unreadable > 0) {
    return {
      ok: false,
      reason: `calendar rows in window lack numeric meta.start_ms/end_ms (${unreadable} unreadable)`,
    };
  }
  // Busiest day by in-meeting hours; ties break to the higher count, then the
  // earlier day, so the answer is deterministic across runs.
  let busiest = null;
  for (const d of win.dayList) {
    const b = perDay.get(d.key);
    if (b.hours <= 0) continue;
    if (
      busiest === null ||
      b.hours > busiest.hours ||
      (b.hours === busiest.hours && b.count > busiest.count)
    ) {
      busiest = { day: d.key, hours: b.hours, count: b.count };
    }
  }
  return {
    ok: true,
    meetings,
    meetingsPerDay: meetings / win.days,
    totalHours,
    hoursPerDay: totalHours / win.days,
    busiest: busiest === null ? null : { day: busiest.day, hours: busiest.hours },
    allDayCount,
    unreadable,
  };
}

const MAX_YESTERDAY_TITLES = 5;
const TITLE_MAX_CHARS = 60;

// granola: note titles are the first line of row text, hard-truncated to 60
// chars. Titles DO belong in the digest — this text is destined for the owner
// and for a hazlie_digest row, not for a log.
function granolaAggregate(db, win, yesterday) {
  if (!sourceEverIngested(db, 'granola')) return neverIngested('granola');
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM context WHERE source = 'granola' AND ts >= ? AND ts < ?")
    .get(win.startMs, win.endMs);
  const yRows = db
    .prepare(
      "SELECT ts, text, entity_id FROM context WHERE source = 'granola' AND ts >= ? AND ts < ? " +
        'ORDER BY ts, entity_id'
    )
    .all(yesterday.startMs, yesterday.endMs);
  const titles = yRows
    .slice(0, MAX_YESTERDAY_TITLES)
    .map((r) => String(r.text).split('\n', 1)[0].slice(0, TITLE_MAX_CHARS));
  return { ok: true, meetings: Number(n), yesterdayCount: yRows.length, yesterdayTitles: titles };
}

// The accepted health meta shapes are a CLOSED set taken from the registry
// rule (ops/CONNECTORS.md: meta is the raw Oura record verbatim) and Oura API
// v2 field names. connectors/sources/oura.mjs now exists and writes the
// `sleep_periods` / `daily_activity` nesting handled below; anything outside
// this set is reported as unreadable rather than guessed at:
//   sleep duration  meta.total_sleep_duration (seconds, Oura sleep record),
//                   or meta.records[] each carrying total_sleep_duration —
//                   the multi-period (nap) form for a day with several
//                   sessions merged under one health:sleep:<day> entity;
//   hrv             meta.average_hrv (ms, Oura sleep record); on the records[]
//                   form, the mean of the periods that carry it;
//   steps           meta.steps (integer, Oura daily_activity record).
function sleepFactsFromMeta(meta) {
  if (meta !== null && Number.isFinite(meta.total_sleep_duration)) {
    return {
      seconds: meta.total_sleep_duration,
      hrv: Number.isFinite(meta.average_hrv) ? meta.average_hrv : null,
    };
  }
  // `records` is the Apple Health connector's array; `sleep_periods` is the
  // one Oura writes. Oura REPLACED that connector on 2026-08-19 without this
  // reader being taught the new key, so every health row ingested since then
  // was landing as "carries no readable duration". Summing across periods is
  // right in both shapes — a night split by an interruption is still one night.
  const periods = meta === null ? null : (meta.records ?? meta.sleep_periods);
  if (Array.isArray(periods)) {
    let seconds = 0;
    let found = false;
    const hrvs = [];
    for (const rec of periods) {
      if (rec === null || typeof rec !== 'object') continue;
      if (Number.isFinite(rec.total_sleep_duration)) {
        seconds += rec.total_sleep_duration;
        found = true;
      }
      if (Number.isFinite(rec.average_hrv)) hrvs.push(rec.average_hrv);
    }
    return { seconds: found ? seconds : null, hrv: mean(hrvs) };
  }
  return { seconds: null, hrv: null };
}

// Reads every health:sleep:<day> row once; sleep and hrv aggregates are both
// derived from the result so the two can never disagree about which nights
// exist. Day membership comes from the entity id's own <day> key (that key IS
// the night's identity per the registry), not from row ts.
function readSleepRows(db) {
  if (!sourceEverIngested(db, 'health')) return { missing: neverIngested('health') };
  const rows = db
    .prepare(
      "SELECT entity_id, meta FROM context WHERE source = 'health' AND entity_id LIKE 'health:sleep:%'"
    )
    .all();
  if (rows.length === 0) {
    return { missing: { ok: false, reason: 'health rows exist but none under health:sleep:<day>' } };
  }
  const byDay = new Map();
  for (const row of rows) {
    const day = String(row.entity_id).slice('health:sleep:'.length);
    byDay.set(day, sleepFactsFromMeta(parseMeta(row.meta)));
  }
  return { byDay };
}

function sleepAggregate(sleepRows, win, prior, yesterdayKey) {
  if (sleepRows.missing) return sleepRows.missing;
  const inRange = [...win.dayKeys, ...prior.dayKeys].filter((k) => sleepRows.byDay.has(k));
  const winSeconds = win.dayKeys
    .map((k) => sleepRows.byDay.get(k)?.seconds)
    .filter((s) => s !== null && s !== undefined);
  const priorSeconds = prior.dayKeys
    .map((k) => sleepRows.byDay.get(k)?.seconds)
    .filter((s) => s !== null && s !== undefined);
  const unreadable = inRange.filter((k) => sleepRows.byDay.get(k).seconds === null).length;
  if (inRange.length > 0 && winSeconds.length === 0 && priorSeconds.length === 0) {
    return {
      ok: false,
      reason: `health:sleep rows in range carry no readable duration (checked ${inRange.length})`,
    };
  }
  const avgSeconds = mean(winSeconds);
  const priorAvgSeconds = mean(priorSeconds);
  const lastNight = sleepRows.byDay.get(yesterdayKey)?.seconds ?? null;
  return {
    ok: true,
    nights: winSeconds.length,
    avgSeconds,
    // Night counts, not just the mean: an average of 7 h hides "four good
    // nights and three bad ones", which is the shape the energy audit is
    // actually looking for. 8 h and 6 h are the conventional good/short marks.
    nightsAtLeast8h: winSeconds.filter((s) => s >= 8 * 3600).length,
    nightsUnder6h: winSeconds.filter((s) => s < 6 * 3600).length,
    lastNightSeconds: lastNight,
    priorNights: priorSeconds.length,
    priorAvgSeconds,
    deltaSeconds:
      avgSeconds !== null && priorAvgSeconds !== null ? avgSeconds - priorAvgSeconds : null,
    unreadable,
  };
}

function hrvAggregate(sleepRows, win, prior) {
  if (sleepRows.missing) return sleepRows.missing;
  const inRange = [...win.dayKeys, ...prior.dayKeys].filter((k) => sleepRows.byDay.has(k));
  const winHrv = win.dayKeys
    .map((k) => sleepRows.byDay.get(k)?.hrv)
    .filter((v) => v !== null && v !== undefined);
  const priorHrv = prior.dayKeys
    .map((k) => sleepRows.byDay.get(k)?.hrv)
    .filter((v) => v !== null && v !== undefined);
  if (inRange.length > 0 && winHrv.length === 0 && priorHrv.length === 0) {
    return {
      ok: false,
      reason: `health:sleep rows in range carry no numeric average_hrv (checked ${inRange.length})`,
    };
  }
  const avg = mean(winHrv);
  const priorAvg = mean(priorHrv);
  return {
    ok: true,
    nights: winHrv.length,
    avg,
    priorNights: priorHrv.length,
    priorAvg,
    direction: trendDirection(avg, priorAvg),
  };
}

// steps: health:activity:<day> (Oura daily_activity) preferred; the
// health:steps:<day> spelling is accepted for the same day only when no
// activity row exists, so a connector that writes both cannot double-count.
function stepsAggregate(db, win, prior, yesterdayKey) {
  if (!sourceEverIngested(db, 'health')) return neverIngested('health');
  const rows = db
    .prepare(
      "SELECT entity_id, meta FROM context WHERE source = 'health' AND " +
        "(entity_id LIKE 'health:activity:%' OR entity_id LIKE 'health:steps:%')"
    )
    .all();
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'health rows exist but none under health:activity:<day> or health:steps:<day>',
    };
  }
  const byDay = new Map();
  for (const row of rows) {
    const id = String(row.entity_id);
    const fromActivity = id.startsWith('health:activity:');
    const day = id.slice(fromActivity ? 'health:activity:'.length : 'health:steps:'.length);
    const meta = parseMeta(row.meta);
    // Flat `meta.steps` is the Apple Health form; Oura nests the same integer
    // under `daily_activity`. Same reason as sleep_periods above — the Oura
    // connector landed after this reader was written.
    const rawSteps = meta === null ? null : (meta.steps ?? meta.daily_activity?.steps);
    const steps = Number.isFinite(rawSteps) && rawSteps >= 0 ? rawSteps : null;
    const existing = byDay.get(day);
    if (existing === undefined || (fromActivity && !existing.fromActivity)) {
      byDay.set(day, { steps, fromActivity });
    }
  }
  const rangeKeys = [...win.dayKeys, ...prior.dayKeys].filter((k) => byDay.has(k));
  const winSteps = win.dayKeys
    .map((k) => byDay.get(k)?.steps)
    .filter((v) => v !== null && v !== undefined);
  const unreadable = rangeKeys.filter((k) => byDay.get(k).steps === null).length;
  if (rangeKeys.length > 0 && winSteps.length === 0 && unreadable === rangeKeys.length) {
    return {
      ok: false,
      reason: `health activity rows in range carry no numeric meta.steps (checked ${rangeKeys.length})`,
    };
  }
  return {
    ok: true,
    daysWithData: winSteps.length,
    avgSteps: mean(winSteps),
    yesterdaySteps: byDay.get(yesterdayKey)?.steps ?? null,
    unreadable,
  };
}

// comms volume: counts only, windowed by row ts. The MISSING rule (simplest
// honest one): no rows for the source anywhere in the DB → the source has
// never ingested → MISSING; any row anywhere → the source is live and an
// empty window is a real, reportable zero.
// Late-night is 22:00–05:00 in the OWNER'S zone. Bucketing on the local hour
// rather than UTC is load-bearing: 23:30 in Honolulu is 09:30 UTC the next
// day, so a UTC bucket would file the owner's worst nights as mornings.
const LATE_NIGHT_FROM_H = 22;
const LATE_NIGHT_TO_H = 5;

export function isLateNightHour(hour) {
  return hour >= LATE_NIGHT_FROM_H || hour < LATE_NIGHT_TO_H;
}

function commsAggregate(db, source, win, zone) {
  if (!sourceEverIngested(db, source)) return neverIngested(source);
  const rows = db
    .prepare('SELECT ts, meta FROM context WHERE source = ? AND ts >= ? AND ts < ?')
    .all(source, win.startMs, win.endMs);

  let lateNight = 0;
  let outbound = 0;
  let outboundKnown = 0;
  for (const row of rows) {
    const ts = Number(row.ts);
    if (Number.isFinite(ts) && isLateNightHour(Number(wallParts(ts, zone).hour))) lateNight += 1;
    // is_from_me is recorded on imessage rows and not on mail. Counting
    // direction only where it exists keeps the share honest instead of
    // assuming every unflagged message was inbound.
    const meta = parseMeta(row.meta);
    if (meta !== null && typeof meta.is_from_me === 'boolean') {
      outboundKnown += 1;
      if (meta.is_from_me) outbound += 1;
    }
  }

  const count = rows.length;
  return {
    ok: true,
    count,
    perDay: count / win.days,
    lateNight,
    lateNightPerDay: lateNight / win.days,
    outbound: outboundKnown > 0 ? outbound : null,
    outboundShare: outboundKnown > 0 ? outbound / outboundKnown : null,
  };
}

// --- the two exports ------------------------------------------------------------

// Aggregates over the trailing `days` COMPLETE local days ending yesterday
// (yesterday itself is the spotlight day), compared where applicable against
// the `days` days immediately before that window.
export function computeAggregates(db, { now, days = 7, zone } = {}) {
  if (!Number.isFinite(now)) {
    throw new Error('computeAggregates: {now} is required (epoch milliseconds)');
  }
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('computeAggregates: {days} must be an integer between 1 and 366');
  }
  if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw new Error('computeAggregates: {db} must be an open node:sqlite database');
  }
  const tz = zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context'").get() ===
    undefined
  ) {
    throw new Error('not a hermes context store: no `context` table in this database');
  }

  const allDays = completeDaysEndingYesterday(now, tz, days * 2);
  const priorDays = allDays.slice(0, days);
  const windowDays = allDays.slice(days);
  const win = {
    days,
    dayList: windowDays,
    dayKeys: windowDays.map((d) => d.key),
    startKey: windowDays[0].key,
    endKey: windowDays[days - 1].key,
    startMs: windowDays[0].startMs,
    endMs: windowDays[days - 1].endMs,
  };
  const prior = {
    dayKeys: priorDays.map((d) => d.key),
    startKey: priorDays[0].key,
    endKey: priorDays[days - 1].key,
    startMs: priorDays[0].startMs,
    endMs: priorDays[days - 1].endMs,
  };
  const yesterday = windowDays[days - 1];

  const sleepRows = readSleepRows(db);

  return {
    zone: tz,
    generatedDay: localDayKey(now, tz),
    window: {
      days,
      startKey: win.startKey,
      endKey: win.endKey,
      startMs: win.startMs,
      endMs: win.endMs,
      dayKeys: win.dayKeys,
    },
    prior: {
      startKey: prior.startKey,
      endKey: prior.endKey,
      startMs: prior.startMs,
      endMs: prior.endMs,
      dayKeys: prior.dayKeys,
    },
    calendar: calendarAggregate(db, win),
    granola: granolaAggregate(db, win, yesterday),
    sleep: sleepAggregate(sleepRows, win, prior, yesterday.key),
    steps: stepsAggregate(db, win, prior, yesterday.key),
    hrv: hrvAggregate(sleepRows, win, prior),
    imessage: commsAggregate(db, 'imessage', win, tz),
    mail: commsAggregate(db, 'mail', win, tz),
  };
}

// --- rendering ------------------------------------------------------------------

function fmt1(x) {
  const r = Math.round(x * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
}

function fmtSigned1(x) {
  let r = Math.round(x * 10) / 10;
  if (Object.is(r, -0)) r = 0;
  return (r < 0 ? '' : '+') + r.toFixed(1);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function unreadableSuffix(n) {
  return n > 0 ? `; unreadable rows: ${n}` : '';
}

// One line per aggregate, MISSING lines at the end. Deterministic: same agg
// in, same lines out, and the only non-numeric judgment words are the trend
// directions computeAggregates already chose. Returns an array of strings.
//
// The signature accepts {now} per the digest contract, but every date in the
// output comes from agg — compute-time and render-time must never be able to
// disagree about what day it is.
export function renderDigestLines(agg, { now } = {}) { // `now` accepted, deliberately unused
  const lines = [];
  const missing = [];
  lines.push(
    `Energy audit ${agg.window.startKey}..${agg.window.endKey} ` +
      `(${plural(agg.window.days, 'day')}), generated ${agg.generatedDay}`
  );

  const cal = agg.calendar;
  if (!cal.ok) {
    missing.push(['calendar', cal.reason]);
  } else if (cal.meetings === 0) {
    lines.push(`calendar: no meetings in window${unreadableSuffix(cal.unreadable)}`);
  } else {
    let line =
      `calendar: ${plural(cal.meetings, 'meeting')} (${fmt1(cal.meetingsPerDay)}/day), ` +
      `${fmt1(cal.hoursPerDay)} h/day in meetings`;
    if (cal.busiest !== null) line += `; busiest ${cal.busiest.day} (${fmt1(cal.busiest.hours)} h)`;
    if (cal.allDayCount > 0) line += `; all-day: ${cal.allDayCount} (excluded from hours)`;
    line += unreadableSuffix(cal.unreadable);
    lines.push(line);
  }

  const gr = agg.granola;
  if (!gr.ok) {
    missing.push(['granola', gr.reason]);
  } else {
    let line = `granola: ${plural(gr.meetings, 'note')} in window; `;
    if (gr.yesterdayTitles.length === 0) {
      line += 'none yesterday';
    } else {
      line += `yesterday: ${gr.yesterdayTitles.map((t) => `"${t}"`).join(', ')}`;
      const more = gr.yesterdayCount - gr.yesterdayTitles.length;
      if (more > 0) line += ` (+${more} more)`;
    }
    lines.push(line);
  }

  const sl = agg.sleep;
  if (!sl.ok) {
    missing.push(['sleep', sl.reason]);
  } else if (sl.nights === 0) {
    lines.push(`sleep: no data in window${unreadableSuffix(sl.unreadable)}`);
  } else {
    let line = `sleep: avg ${fmt1(sl.avgSeconds / 3600)} h/night over ${plural(sl.nights, 'night')}; `;
    line += sl.lastNightSeconds !== null ? `last night ${fmt1(sl.lastNightSeconds / 3600)} h` : 'last night: no data';
    line +=
      sl.priorAvgSeconds !== null
        ? `; ${fmtSigned1(sl.deltaSeconds / 3600)} h vs prior week (avg ${fmt1(sl.priorAvgSeconds / 3600)} h)`
        : '; prior week: no data';
    line += unreadableSuffix(sl.unreadable);
    lines.push(line);
  }

  const st = agg.steps;
  if (!st.ok) {
    missing.push(['steps', st.reason]);
  } else if (st.daysWithData === 0) {
    lines.push(`steps: no data in window${unreadableSuffix(st.unreadable)}`);
  } else {
    let line = `steps: avg ${Math.round(st.avgSteps)}/day over ${plural(st.daysWithData, 'day')}; `;
    line += st.yesterdaySteps !== null ? `yesterday ${st.yesterdaySteps}` : 'yesterday: no data';
    line += unreadableSuffix(st.unreadable);
    lines.push(line);
  }

  const hv = agg.hrv;
  if (!hv.ok) {
    missing.push(['hrv', hv.reason]);
  } else if (hv.nights === 0) {
    lines.push('hrv: no data in window');
  } else {
    let line = `hrv: avg ${Math.round(hv.avg)} ms over ${plural(hv.nights, 'night')}`;
    line +=
      hv.priorAvg !== null
        ? `, ${hv.direction} vs prior week (avg ${Math.round(hv.priorAvg)} ms)`
        : '; prior week: no data';
    lines.push(line);
  }

  for (const source of ['imessage', 'mail']) {
    const c = agg[source];
    if (!c.ok) {
      missing.push([source, c.reason]);
    } else {
      lines.push(`${source}: ${plural(c.count, 'message')} in window (${fmt1(c.perDay)}/day)`);
    }
  }

  for (const [name, reason] of missing) lines.push(`MISSING: ${name} — ${reason}`);
  return lines;
}

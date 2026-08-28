// The calendar connector: scans Apple's Calendar store for the occurrences
// inside a rolling window and delivers one row per occurrence to hermes.
//
// Read mode is snapshotStore() — a measured decision, not a preference
// (ops/PROBES.md "per-consumer Apple-store read mode"): the store is small
// (~thousands of rows), so a Backup-API snapshot per scan costs well under a
// second, and the scan then reads a frozen private copy no Apple daemon is
// writing under us. Do not switch this to a persistent reader without
// re-measuring.
//
// We read Apple's OWN materialized occurrences (OccurrenceCache) rather than
// expanding RRULEs ourselves: re-implementing iCalendar recurrence expansion
// is exactly the kind of quiet divergence that puts a meeting in the digest
// on the wrong day. Apple already did the expansion; we copy its answer.
//
// Identity (the PROBES.md decision, measured on this macOS 27 seed):
//   entity_id = calendar:<CalendarItem.unique_identifier>:<occurrence epoch s>
// unique_identifier is the iCalendar/CalDAV UID (stable across device syncs
// and account resyncs; the local-row UUID was rejected because an account
// remove/re-add can reissue it). The suffix is OccurrenceCache.occurrence_date
// — the occurrence's SLOT in the series (iCalendar RECURRENCE-ID analogue) —
// rendered as Unix epoch seconds. occurrence_start_date is the actual,
// possibly moved, start: it belongs in meta, never in the id.
//
// The foreground source is CURSOR-FREE: every pass rescans the whole window
// and the entity upsert absorbs the overlap (redelivery lands as `unchanged`).
// A separate history cursor walks older year-sized windows in the background;
// it never delays the upcoming-calendar view.
// Upserts cannot express absence, so after each FULLY successful scan the
// pass reconciles: fetch the entity ids hermes holds for the scanned window
// (ids + timestamps only — corpus text never crosses back), diff against what
// the scan observed, delete the difference. A rescheduled occurrence moves
// instead of duplicating; a cancelled event cannot haunt tomorrow's digest.
// Reconciliation NEVER runs outside the scanned window, and never after a
// partial scan — a failed read aborting before the diff is what stands
// between "hermes was down for a minute" and a mass delete.
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readEvents, helperAvailable } from '../lib/apple-data.mjs';
import { APPLE_EPOCH_MS, appleAbsoluteSecondsToEpochMs } from '../lib/appleTime.mjs';
import { planReconcile } from '../lib/reconcile.mjs';
import {
  createGcalClient,
  defaultGcalClientIdPath,
  defaultGcalClientSecretPath,
  defaultGcalTokensPath,
} from '../lib/gcalClient.mjs';
import { eventsToRows } from '../lib/gcalRows.mjs';
import { snapshotStore } from '../lib/storeReader.mjs';

const DAY_MS = 86_400_000;

// Scan windows around "now": steady state looks a week back (late edits to
// just-passed events still land) and a month ahead (the digest's planning
// horizon); backfill widens both for a first run or a purge recovery.
const STEADY_WINDOW = Object.freeze({ backMs: 7 * DAY_MS, aheadMs: 30 * DAY_MS });
const BACKFILL_WINDOW = Object.freeze({ backMs: 90 * DAY_MS, aheadMs: 60 * DAY_MS });
const HISTORY_CURSOR_KEY = 'calendar:history-ceiling-ts';
const HISTORY_DONE_KEY = 'calendar:history-done';
const HISTORY_SLICE_MS = 365 * DAY_MS;
// Calendar data before 1900 is outside the practical range of EventKit and
// Google Calendar. This is deliberately far older than a user's account, so
// every history occurrence those providers can return is visited eventually.
const HISTORY_FLOOR_TS = Date.UTC(1900, 0, 1);

// The SQL prefilter selects on the RAW occurrence start, but the row's `ts`
// (and therefore the reconciliation window) is the all-day-adjusted start —
// local midnight can sit up to a day and a timezone offset away from the raw
// instant Apple stored. The prefilter therefore over-fetches by this slack
// and the precise ts ∈ [from, to] cut happens in JS, so the set of rows the
// scan observed and the set of rows reconciliation may delete are computed
// from the SAME boundary. Without the slack, an occurrence whose raw start
// falls just outside the window while its ts falls inside would be invisible
// to the scan but visible to the diff — and wrongly deleted.
const WINDOW_SLACK_MS = 2 * DAY_MS;

// The tables and columns one scan reads, probed via PRAGMA before any query.
// This machine runs a macOS prerelease seed: Apple-store schemas are probed,
// never assumed, and drift fails loudly naming exactly what moved instead of
// as an opaque SQL error. CalendarItem.rrule is optional by contract — when
// the column exists and is populated the value rides along in meta.
const REQUIRED_COLUMNS = Object.freeze({
  Calendar: Object.freeze(['title']),
  CalendarItem: Object.freeze(['summary', 'all_day', 'unique_identifier']),
  OccurrenceCache: Object.freeze([
    'event_id',
    'calendar_id',
    'occurrence_date',
    'occurrence_start_date',
    'occurrence_end_date',
  ]),
});

// Store resolution order, probed on this machine (ops/PROBES.md): modern
// macOS keeps the truth in the group container; the pre-container path is the
// legacy fallback.
export function storeCandidatePaths(home = homedir()) {
  return [
    join(home, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'),
    join(home, 'Library', 'Calendars', 'Calendar.sqlitedb'),
  ];
}

// WHO WAS THERE, normalised.
//
// Attendee emails are the one join key that reaches across platforms: they
// match the contacts spine's `email` identifiers, which is how a calendar
// event and a message thread resolve to the same person. A private development
// calendar confirmed that many events carry attendees with email addresses.
// The stored rows had carried none of it.
//
// The OWNER is dropped from the list (isMe) -- "who else was there" is the
// question, and the owner is in every one of their own events. The count of
// dropped-because-me is not kept: an event with only the owner is simply an
// event with no other attendees.
//
// Emails are lowercased to match normalizeEmail in contacts.mjs, or the join
// this exists for silently misses on case alone.
export function attendeesOf(occ) {
  const raw = Array.isArray(occ?.attendees) ? occ.attendees : [];
  const out = [];
  for (const a of raw) {
    if (a?.isMe === true) continue;
    const name = typeof a?.name === 'string' && a.name.trim() ? a.name.trim() : null;
    const email =
      typeof a?.email === 'string' && a.email.includes('@') ? a.email.trim().toLowerCase() : null;
    if (!name && !email) continue;
    const person = {};
    if (name) person.name = name;
    if (email) person.email = email;
    if (typeof a?.status === 'string') person.status = a.status;
    out.push(person);
  }
  // PRE-SORTED, and connectors/AGENTS.md names this exact field as the reason
  // the rule exists: hermes canonicalizes object KEY order for the content
  // hash but keeps ARRAY order, because it cannot know which arrays are sets.
  // EventKit does not promise a stable participant order, so an unsorted list
  // reads as an edit on every delivery -- the row's hash changes, hermes
  // treats an unchanged meeting as modified, and invalidateClaimsForChangedRow
  // retires claims that nothing about the meeting actually contradicted.
  //
  // Email first because it is the identity; name only breaks ties for the
  // participants who have no address.
  out.sort((a, b) =>
    (a.email ?? '').localeCompare(b.email ?? '') || (a.name ?? '').localeCompare(b.name ?? '')
  );
  return out;
}

// EVERY ATTENDEE IS ALSO AN IDENTITY, and the calendar is the only place many
// of them are named.
//
// A private development calendar confirmed that invitees can carry a name even
// when the address book does not. They are work contacts nobody ever saved. Without this
// the timeline shows them as raw email addresses, which is what
// "owner@example.test" was.
//
// Written at source 'calendar', which ranks BELOW 'contacts': a name the owner
// chose always beats a name an invite supplied, whichever connector ran last.
export function attendeeIdentities(occurrences) {
  const byEmail = new Map();
  for (const occ of Array.isArray(occurrences) ? occurrences : []) {
    const people = attendeesOf(occ);
    const organizer = attendeesOf({ attendees: occ?.organizer ? [occ.organizer] : [] });
    for (const p of [...people, ...organizer]) {
      if (!p.email || !p.name) continue;
      // First name wins, and events are walked oldest-first, so a person who
      // later changed how their name renders keeps one stable label rather than
      // flickering between them.
      if (!byEmail.has(p.email)) byEmail.set(p.email, p.name);
    }
  }
  return [...byEmail].map(([identifier, displayName]) => ({
    identifier,
    displayName,
    kind: 'email',
    source: 'calendar',
  }));
}

// THE SAME HARVEST, FROM ROWS INSTEAD OF OCCURRENCES.
//
// attendeeIdentities above reads EventKit occurrences, and EventKit is one of
// three backends. Google and the local sqlite path never entered it, so those
// installations kept rendering historical counterparties as raw addresses even
// though their event rows carry the same attendee names.
//
// Rows ARE the shared surface: every backend normalises into `meta.attendees`
// and `meta.organizer` with the same {email, name} shape before ingest, whether
// it came from buildRows or gcalRows.eventsToRows. So this adapts a row back
// into the shape attendeeIdentities already understands rather than growing a
// second definition of what an attendee is.
//
// EventKit keeps its separate WIDE read on top of this: rows are a narrow
// window by design (a week back, a month ahead) and its extra pass reaches six
// years. The other two get the narrow window, which is what they had access to
// anyway and is strictly more than the nothing they were harvesting before.
export function identitiesFromRows(rows) {
  return attendeeIdentities(
    (Array.isArray(rows) ? rows : []).map((row) => ({
      attendees: row?.meta?.attendees,
      organizer: row?.meta?.organizer,
    }))
  );
}

// Writing them down, wherever they came from. Count only in the log: an address
// in a log is an address in a log.
export function rememberIdentities(ctx, identities, backend) {
  if (!Array.isArray(identities) || identities.length === 0) return 0;
  if (typeof ctx?.state?.upsertContacts !== 'function') return 0;
  ctx.state.upsertContacts(identities);
  ctx.log?.info?.('calendar_identities', {
    connector: 'calendar',
    backend,
    people: identities.length,
  });
  return identities.length;
}

// How far back to look for NAMES, as distinct from rows. Wide and cheap: this
// read ingests nothing, and a person met in 2019 is still worth being able to
// name in 2026.
const IDENTITY_BACK_MS = 6 * 365 * DAY_MS;
const IDENTITY_AHEAD_MS = 365 * DAY_MS;
export function identityWindow(nowMs) {
  return { fromTs: nowMs - IDENTITY_BACK_MS, toTs: nowMs + IDENTITY_AHEAD_MS };
}

export function scanWindow(nowMs, backfill = false) {
  const { backMs, aheadMs } = backfill ? BACKFILL_WINDOW : STEADY_WINDOW;
  return { fromTs: nowMs - backMs, toTs: nowMs + aheadMs };
}

// `ceiling` is exclusive from the next (older) slice and inclusive in the
// current one. The overlap at that single instant is intentional: entity ids
// are stable, and overlap is safer than losing an event exactly on a boundary.
export function historyWindow(nowMs, storedCeiling) {
  const parsed = typeof storedCeiling === 'string' ? Number(storedCeiling) : NaN;
  const ceiling = Number.isFinite(parsed) && parsed > HISTORY_FLOOR_TS && parsed <= nowMs
    ? parsed
    : nowMs - BACKFILL_WINDOW.backMs;
  const fromTs = Math.max(HISTORY_FLOOR_TS, ceiling - HISTORY_SLICE_MS);
  return { fromTs, toTs: ceiling, doneAfter: fromTs === HISTORY_FLOOR_TS };
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

function epochMsToAppleSeconds(ms) {
  return (ms - APPLE_EPOCH_MS) / 1000;
}

// --- local-day arithmetic (all-day rows) ---------------------------------------
//
// All-day rows get ts/start_ms/end_ms pinned to LOCAL day boundaries plus
// all_day:true — a PINNED cross-agent contract: the digest computes
// meeting-hours from start_ms/end_ms and uses the flag to EXCLUDE all-day
// rows, so a birthday must never read as a 24-hour meeting. Date#setHours /
// setDate do the boundary math so a DST-shifted 23/25-hour day still lands on
// a real midnight.

function floorLocalMidnight(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function nextLocalMidnight(localMidnightMs) {
  const d = new Date(localMidnightMs);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// --- humanized text -------------------------------------------------------------
//
// A fixed locale, the process's local timezone: the text is for the household
// digest reader, and a stable format also keeps the content hash stable so a
// rescan lands as `unchanged` rather than churning on formatting.
const fmtDay = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const fmtTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function humanSpan({ allDay, startMs, endMs }) {
  if (allDay) {
    const lastDayMs = floorLocalMidnight(endMs - 1);
    return lastDayMs > startMs
      ? `all day ${fmtDay.format(startMs)} – ${fmtDay.format(lastDayMs)}`
      : `all day ${fmtDay.format(startMs)}`;
  }
  if (floorLocalMidnight(startMs) === floorLocalMidnight(endMs)) {
    return `${fmtDay.format(startMs)}, ${fmtTime.format(startMs)}–${fmtTime.format(endMs)}`;
  }
  return `${fmtDay.format(startMs)}, ${fmtTime.format(startMs)} – ${fmtDay.format(endMs)}, ${fmtTime.format(endMs)}`;
}

// --- the source -----------------------------------------------------------------

export function createCalendarSource({ candidates = storeCandidatePaths() } = {}) {
  // Snapshot whichever candidate store works, trying them in order. "Exists
  // but cannot be opened" and "does not exist" both mean trying the next
  // path: under TCC even stat can lie about what a later open will be
  // allowed to do, so attempting the snapshot IS the readability test.
  async function takeSnapshot(cacheDir) {
    const attempts = [];
    for (const path of candidates) {
      try {
        return { snapshotPath: await snapshotStore(path, cacheDir), storePath: path };
      } catch (error) {
        attempts.push(`${path} (${error?.message ?? error})`);
      }
    }
    throw statusError(
      403,
      `calendar store is not readable at any candidate path: ${attempts.join('; ')}. ` +
        'If the store exists, this is Full Disk Access attribution: the read only works when ' +
        'launchd spawns the granted binary ~/.hazlie/bin/node directly — see the FDA runbook ' +
        'in ops/CONNECTORS.md.'
    );
  }

  // PRAGMA-probe every table the scan touches before touching it. Returns
  // whether the optional rrule column exists.
  function probeSchema(db, storePath) {
    let hasRrule = false;
    for (const [table, needed] of Object.entries(REQUIRED_COLUMNS)) {
      // Table names come from our own constant above, never from input, so
      // interpolation into PRAGMA is safe (PRAGMA takes no ? params).
      const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
      if (columns.length === 0) {
        throw statusError(
          500,
          `calendar store schema drift (macOS seed?): required table "${table}" is missing ` +
            `from ${storePath}; re-probe with ops/probes/probe-calendar-contacts.mjs`
        );
      }
      const names = new Set(columns.map((c) => String(c.name)));
      for (const column of needed) {
        if (!names.has(column)) {
          throw statusError(
            500,
            `calendar store schema drift (macOS seed?): required column "${table}.${column}" ` +
              `is missing from ${storePath}; re-probe with ops/probes/probe-calendar-contacts.mjs`
          );
        }
      }
      if (table === 'CalendarItem') hasRrule = names.has('rrule');
    }
    return hasRrule;
  }

  function readOccurrences(db, { fromTs, toTs, hasRrule }) {
    const stmt = db.prepare(
      'SELECT oc.occurrence_date AS occurrenceDate, ' +
        'oc.occurrence_start_date AS occurrenceStart, ' +
        'oc.occurrence_end_date AS occurrenceEnd, ' +
        'ci.summary AS summary, ci.all_day AS allDay, ci.unique_identifier AS uid, ' +
        (hasRrule ? 'ci.rrule AS rrule, ' : '') +
        'cal.title AS calendarTitle ' +
        'FROM OccurrenceCache oc ' +
        'JOIN CalendarItem ci ON ci.ROWID = oc.event_id ' +
        'JOIN Calendar cal ON cal.ROWID = oc.calendar_id ' +
        'WHERE oc.occurrence_start_date >= ? AND oc.occurrence_start_date <= ? ' +
        'ORDER BY oc.occurrence_date, oc.event_id'
    );
    return stmt.all(
      epochMsToAppleSeconds(fromTs - WINDOW_SLACK_MS),
      epochMsToAppleSeconds(toTs + WINDOW_SLACK_MS)
    );
  }

  function buildRows(raw, { fromTs, toTs }) {
    const byId = new Map();
    let skipped = 0;
    for (const occ of raw) {
      // A row without a UID cannot carry a stable identity, and a row
      // without a start cannot be placed; both are store corruption we
      // count and step past rather than let one bad row starve the window.
      if (typeof occ.uid !== 'string' || occ.uid.length === 0 || occ.occurrenceStart === null) {
        skipped += 1;
        continue;
      }
      const rawStartMs = appleAbsoluteSecondsToEpochMs(occ.occurrenceStart);
      const rawEndMs =
        occ.occurrenceEnd === null ? rawStartMs : appleAbsoluteSecondsToEpochMs(occ.occurrenceEnd);
      const allDay = Boolean(occ.allDay);
      let startMs = rawStartMs;
      let endMs = rawEndMs;
      if (allDay) {
        startMs = floorLocalMidnight(rawStartMs);
        const endFloor = floorLocalMidnight(rawEndMs);
        endMs = endFloor === rawEndMs ? rawEndMs : nextLocalMidnight(endFloor);
        if (endMs <= startMs) endMs = nextLocalMidnight(startMs);
      }
      // ts is the (all-day-adjusted) start: the precise window cut happens
      // HERE, on ts, so the scan and the reconciliation diff agree on which
      // rows the window holds (see WINDOW_SLACK_MS above).
      if (startMs < fromTs || startMs > toTs) continue;
      // The id suffix is the occurrence SLOT (occurrence_date), not the
      // actual start — falling back to the start only if the slot is null.
      const slotSeconds = Math.floor(
        appleAbsoluteSecondsToEpochMs(occ.occurrenceDate ?? occ.occurrenceStart) / 1000
      );
      const entityId = `calendar:${occ.uid}:${slotSeconds}`;
      // A recurring master and a detached exception can share a UID; the
      // slot suffix splits every real case (measured in ops/PROBES.md). If a
      // seed ever emits two cache rows for one slot anyway, keeping the
      // first (the ORDER BY makes it deterministic) beats letting one batch
      // fight itself with an insert-then-update on the same id.
      if (byId.has(entityId)) {
        skipped += 1;
        continue;
      }
      const summary = typeof occ.summary === 'string' && occ.summary.length > 0 ? occ.summary : '(untitled)';
      const calendarTitle =
        typeof occ.calendarTitle === 'string' && occ.calendarTitle.length > 0
          ? occ.calendarTitle
          : '(untitled calendar)';
      const meta = {
        event_uid: occ.uid,
        start_ms: startMs,
        end_ms: endMs,
        calendar: calendarTitle,
        all_day: allDay,
      };
      if (typeof occ.rrule === 'string' && occ.rrule.length > 0) meta.rrule = occ.rrule;
      const people = attendeesOf(occ);
      if (people.length > 0) meta.attendees = people;
      const organizer = attendeesOf({ attendees: occ.organizer ? [occ.organizer] : [] })[0];
      if (organizer) meta.organizer = organizer;
      byId.set(entityId, {
        ts: startMs,
        source: 'calendar',
        entity_id: entityId,
        // Names ride in the TEXT as well as the meta, because the text is what
        // FTS5 indexes and the episodic shelf renders -- "who was at the
        // Tuesday review" is unanswerable if the people are only in JSON.
        // Bounded at four names so a 200-person invite does not become the row:
        // the meta keeps all of them for the join, the text carries enough to
        // recognise. Emails stay OUT of the text -- they are a join key, not
        // something to read back, and an address in an FTS index is an address
        // in every snippet that matches.
        text:
          `"${summary}" ${humanSpan({ allDay, startMs, endMs })} (${calendarTitle})` +
          (people.length > 0
            ? ` with ${people
                .slice(0, 4)
                .map((x) => x.name ?? '(unnamed)')
                .join(', ')}${people.length > 4 ? ` and ${people.length - 4} more` : ''}`
            : ''),
        meta,
      });
    }
    return { rows: [...byId.values()], skipped };
  }

  // EventKit backend. The reason this exists is PERMISSION, not capability: the
  // local backend below reads Calendar.sqlitedb directly, and that file is Full
  // Disk Access -- every file the owner has, to read their calendar. EventKit
  // has its own TCC permission scoped to exactly this data, and the app already
  // asks for it by name. Node cannot call EventKit, so a helper binary does and
  // answers in JSON (see lib/apple-data.mjs).
  //
  // Everything downstream is deliberately identical to the local path: the same
  // buildRows(), the same window, the same reconciliation. The helper emits
  // Apple absolute seconds, which is what the sqlite columns hold, so buildRows
  // cannot tell which backend fed it -- which is the point. Two definitions of
  // an entity id is how two backends stop agreeing about what is the same event.
  //
  // Like Google and unlike the local store, EventKit expands recurrences itself,
  // so there is no dependence on a lazily-populated occurrence cache.
  async function runEventKitBackend(ctx, window) {
    const occurrences = await readEvents(window);

    // THE IDENTITY WINDOW IS NOT THE ROW WINDOW.
    //
    // Rows are deliberately narrow -- a week back, a month ahead -- because the
    // calendar surface is about what is coming up. Names are not: a colleague
    // from two years ago is exactly who the timeline needs to label, and their
    // name costs nothing to keep. Harvesting only the row window gave 85 of the
    // 706 people this calendar knows.
    //
    // A separate wide read, ingesting nothing. EventKit answers it in about a
    // second for a decade, and the result is names and addresses only -- no
    // rows, no text, nothing that reaches a model.
    const idWindow = identityWindow(ctx.now());
    let identityOccurrences = occurrences;
    try {
      identityOccurrences = await readEvents(idWindow);
    } catch {
      // A failed wide read is not a failed run: fall back to the rows this
      // pass already has, which is what the narrow window would have given.
    }
    rememberIdentities(ctx, attendeeIdentities(identityOccurrences), 'eventkit');

    const { rows, skipped } = buildRows(occurrences, window);
    if (skipped > 0) {
      ctx.log.warn('calendar_rows_skipped', { connector: 'calendar', count: skipped });
    }
    const totals = await ctx.ingest(rows);

    const observed = new Set(rows.map((row) => row.entity_id));
    const held = await ctx.admin.entities({
      source: 'calendar',
      fromTs: window.fromTs,
      toTs: window.toTs,
    });
    // Same floor as the other two backends: an empty read can mean a revoked
    // grant or a calendar that failed to load, and the diff cannot tell either
    // from a genuinely cleared calendar.
    const plan = planReconcile({ observedIds: observed, held });
    let deleted = 0;
    if (plan.refuse) {
      ctx.log.warn('calendar_reconcile_refused', {
        connector: 'calendar',
        backend: 'eventkit',
        held: held.length,
        wouldDelete: plan.stale.length,
        reason: plan.refuse,
      });
    } else if (plan.stale.length > 0) {
      deleted = (await ctx.admin.deleteEntities({ source: 'calendar', entityIds: plan.stale }))
        .deleted;
    }

    ctx.log.info('calendar_scan', {
      connector: 'calendar',
      backend: 'eventkit',
      backfill: Boolean(ctx.backfill),
      windowFromTs: window.fromTs,
      windowToTs: window.toTs,
      occurrences: rows.length,
      inserted: totals.inserted,
      updated: totals.updated,
      unchanged: totals.unchanged,
      deleted,
    });
    return {
      ingested: totals.inserted,
      updated: totals.updated,
      unchanged: totals.unchanged,
      deleted,
    };
  }

  // Google backend. Shares the window, the ingest call and the reconciliation
  // with the local one; only the source of the occurrences differs. Google
  // expands recurrences server-side (singleEvents=true), so unlike the local
  // store there is no dependence on a lazily-populated cache.
  async function runGoogleBackend(ctx, window) {
    const client = (ctx.gcalClientFactory ?? createGcalClient)({ fetchImpl: ctx.fetchImpl });

    const calendars = await client.listCalendars();
    // `selected` is what the owner has ticked; deselected calendars are ones
    // they have chosen not to look at, and ingesting them would put work on
    // the audit that they do not consider theirs.
    //
    // `!== false` IS CORRECT, and stays. The 2026-08-22 audit flagged this as
    // inverted, reasoning that Google documents `selected` as defaulting to
    // false, so an omitted field ought to mean unticked. Measured against the
    // a private development account before changing it:
    //
    //   7 calendars returned by calendarList
    //   1 with `selected: true`
    //   0 with `selected: false`
    //   6 with the field ABSENT
    //
    // and every returned calendar had events. So the API omits
    // the field for calendars that are plainly in use, and `=== true` would
    // have cut ingestion from seven calendars to one — then handed
    // reconciliation six calendars' worth of suddenly-unobserved entities to
    // delete. The documented default and the served payload disagree; the
    // payload is what runs.
    //
    // If deselection ever needs to be honoured, the signal has to come from
    // somewhere that actually carries it, not from the absence of this field.
    const active = calendars.filter((c) => c.selected !== false && c.deleted !== true);

    const rows = [];
    let skipped = 0;
    // One calendar failing must not take the others down. Without this, a
    // single calendar the owner lost access to threw out of the whole pass on
    // EVERY poll — no rows ingested, no reconciliation, no recovery, and the
    // only symptom a repeating error. Calendar ingestion could freeze
    // indefinitely on one stale share.
    const failed = [];
    for (const calendar of active) {
      try {
        const events = await client.listEvents({
          calendarId: calendar.id,
          timeMinMs: window.fromTs,
          timeMaxMs: window.toTs,
        });
        const mapped = eventsToRows(events, {
          calendarTitle: calendar.summary,
          fallbackZone: calendar.timeZone,
        });
        rows.push(...mapped.rows);
        skipped += mapped.skipped;
      } catch (error) {
        // No calendar id, summary or title in the log — that names the owner's
        // calendars and their sharers (log policy, connectors/AGENTS.md). The
        // error MESSAGE is off-limits for the same reason: gcalClient labels
        // each request with the calendar id, which for Google is an email
        // address, and can echo the provider's response body. The HTTP status
        // is the structured fact, and it is enough to act on.
        failed.push(calendar.id);
        ctx.log.warn('calendar_list_failed', {
          connector: 'calendar',
          backend: 'google',
          status: error?.status ?? null,
        });
      }
    }

    // Two calendars can hold the same meeting (an invite the owner also put
    // on a personal calendar); the entity id is the same, so dedupe before
    // ingest rather than letting one batch insert-then-update itself.
    const byId = new Map();
    for (const row of rows) {
      if (byId.has(row.entity_id)) {
        skipped += 1;
        continue;
      }
      byId.set(row.entity_id, row);
    }
    const deduped = [...byId.values()];

    if (skipped > 0) {
      ctx.log.warn('calendar_rows_skipped', { connector: 'calendar', count: skipped });
    }

    // Names, from the rows this pass already built (identitiesFromRows explains
    // why rows and not occurrences).
    rememberIdentities(ctx, identitiesFromRows(deduped), 'google');
    const totals = await ctx.ingest(deduped);

    const observed = new Set(deduped.map((row) => row.entity_id));
    const held = await ctx.admin.entities({
      source: 'calendar',
      fromTs: window.fromTs,
      toTs: window.toTs,
    });
    // The floor, not a bare diff — see lib/reconcile.mjs. A Google pass can
    // return an empty page for reasons that are not "the calendar is empty":
    // an expired token surfacing as 200, a `selected` filter change, a
    // calendar the owner unshared. Without this, any of those deleted the
    // whole window and logged it as a successful cleanup.
    // A PARTIAL SCAN MAY NOT RECONCILE. Skipping a failed calendar keeps the
    // pass alive, but its events are then unobserved — and unobserved is
    // exactly what reconciliation deletes. Continuing past a failure without
    // this check would trade a frozen connector for a quiet deletion of the
    // rows belonging to whichever calendar broke.
    const plan =
      failed.length > 0
        ? { stale: [], refuse: `${failed.length} calendar(s) failed; window not fully observed` }
        : planReconcile({ observedIds: observed, held });
    let deleted = 0;
    if (plan.refuse) {
      ctx.log.warn('calendar_reconcile_refused', {
        connector: 'calendar',
        backend: 'google',
        held: held.length,
        wouldDelete: plan.stale.length,
        reason: plan.refuse,
      });
    } else if (plan.stale.length > 0) {
      deleted = (await ctx.admin.deleteEntities({ source: 'calendar', entityIds: plan.stale }))
        .deleted;
    }

    // Counts and window facts only — never a summary, a title or a time span
    // (log policy, connectors/AGENTS.md).
    ctx.log.info('calendar_scan', {
      connector: 'calendar',
      backend: 'google',
      backfill: Boolean(ctx.backfill),
      windowFromTs: window.fromTs,
      windowToTs: window.toTs,
      calendars: active.length,
      rows: deduped.length,
      skipped,
      deleted,
    });
    return { ...totals, deleted };
  }

  return {
    name: 'calendar',
    walksHistory: true,

    // Store readability is deliberately NOT pre-checked for the local
    // backend: FDA attributes per spawner, so a needs()-time stat can pass in
    // a context where the run's open would be denied (and vice versa). The
    // run itself is the honest probe and fails loudly with the runbook.
    //
    // The Google backend DOES have a real prerequisite, and it is worth
    // gating: without tokens the run would fail mid-flight after opening a
    // socket, instead of waiting quietly at the gate.
    needs({ config, tokensPath, clientIdPath, clientSecretPath } = {}) {
      if (config?.calendar?.backend !== 'google') return [];
      const missing = [];
      const tokens = tokensPath ?? defaultGcalTokensPath();
      if (!existsSync(tokens)) {
        missing.push(
          `gcal tokens file missing at ${tokens}: run \`node ops/gcal-auth.mjs\` (browser consent)`
        );
      }
      for (const [path, label] of [
        [clientIdPath ?? defaultGcalClientIdPath(), 'gcal client id'],
        [clientSecretPath ?? defaultGcalClientSecretPath(), 'gcal client secret'],
      ]) {
        if (!existsSync(path)) {
          missing.push(`${label} file missing at ${path}: run \`node ops/gcal-auth.mjs --help\``);
        }
      }
      return missing;
    },

    async run(ctx) {
      const isHistory = ctx.history === true;
      const window = isHistory
        ? historyWindow(ctx.now(), ctx.state.getCursor(HISTORY_CURSOR_KEY))
        : scanWindow(ctx.now(), Boolean(ctx.backfill));
      const finish = (result) => {
        if (!isHistory) return result;
        // The cursor moves only after the selected backend read, ingest, and
        // window-limited reconciliation all succeeded. Re-running a slice is
        // harmless; skipping one would permanently lose calendar history.
        if (window.doneAfter) ctx.state.setCursor(HISTORY_DONE_KEY, '1');
        else ctx.state.setCursor(HISTORY_CURSOR_KEY, String(window.fromTs));
        return { ...result, historyProgressed: true };
      };

      // Two backends, one at a time, never both. Both write `source:
      // 'calendar'` rows, and the reconciliation below deletes every held
      // entity in the window this pass did not observe — so running both
      // would have each delete the other's rows on alternate passes.
      // `calendar.backend` is the switch; there is deliberately no merge.
      if (ctx.config?.calendar?.backend === 'google') {
        return finish(await runGoogleBackend(ctx, window));
      }
      // EventKit is PREFERRED over the sqlite path when the helper is present,
      // because it is the same data for a far smaller grant -- so this is a
      // default rather than an opt-in. `backend: 'local'` forces the old path
      // for a machine where the helper cannot run; anything else falls through
      // to it anyway when the helper is missing, which is what keeps a backend
      // that has shipped for a while from disappearing under an upgrade.
      if (ctx.config?.calendar?.backend !== 'local' && helperAvailable()) {
        return finish(await runEventKitBackend(ctx, window));
      }

      const cacheDir = join(ctx.cacheDir, 'calendar');
      const { snapshotPath, storePath } = await takeSnapshot(cacheDir);

      let rows;
      let skipped;
      let db;
      try {
        // The snapshot is our own private 0600 copy, not a live Apple store,
        // so a plain read-only open is the whole story here.
        db = new DatabaseSync(snapshotPath, { readOnly: true });
        const hasRrule = probeSchema(db, storePath);
        ({ rows, skipped } = buildRows(readOccurrences(db, { ...window, hasRrule }), window));
      } finally {
        try {
          db?.close();
        } catch {}
        // The snapshot has served its scan; a lingering ~copy of the
        // household calendar in the cache dir is a liability, not a cache.
        rmSync(snapshotPath, { force: true });
      }
      if (skipped > 0) {
        ctx.log.warn('calendar_rows_skipped', { connector: 'calendar', count: skipped });
      }

      rememberIdentities(ctx, identitiesFromRows(rows), 'local');
      const totals = await ctx.ingest(rows);

      // Reconciliation — reached ONLY when the snapshot, the scan, and every
      // ingest batch above succeeded (anything thrown has already aborted the
      // pass), and confined to exactly the window the scan covered.
      const observed = new Set(rows.map((row) => row.entity_id));
      const held = await ctx.admin.entities({
        source: 'calendar',
        fromTs: window.fromTs,
        toTs: window.toTs,
      });
      // Same floor as the Google path — a local store snapshot can also come
      // back empty while succeeding (an unmounted volume, a permissions
      // change), and the diff cannot tell that from a cleared calendar.
      const plan = planReconcile({ observedIds: observed, held });
      let deleted = 0;
      if (plan.refuse) {
        ctx.log.warn('calendar_reconcile_refused', {
          connector: 'calendar',
          backend: 'local',
          held: held.length,
          wouldDelete: plan.stale.length,
          reason: plan.refuse,
        });
      } else if (plan.stale.length > 0) {
        deleted = (await ctx.admin.deleteEntities({ source: 'calendar', entityIds: plan.stale }))
          .deleted;
      }

      // Counts and window facts only — never a summary, a title, or a time
      // span string (log policy, connectors/AGENTS.md).
      ctx.log.info('calendar_scan', {
        connector: 'calendar',
        backfill: Boolean(ctx.backfill),
        windowFromTs: window.fromTs,
        windowToTs: window.toTs,
        occurrences: rows.length,
        inserted: totals.inserted,
        updated: totals.updated,
        unchanged: totals.unchanged,
        deleted,
      });

      // The daemon records this run (recordRun) from the counts we return.
      return finish({
        ingested: totals.inserted,
        updated: totals.updated,
        unchanged: totals.unchanged,
        deleted,
      });
    },
  };
}

export default createCalendarSource();

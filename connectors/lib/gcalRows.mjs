// Google Calendar event → hermes context row.
//
// The output shape is NOT a new format. It is byte-for-byte the shape
// connectors/sources/calendar.mjs already emits from the local store, because
// ui/server/vault/digest.mjs reads `meta.start_ms`, `meta.end_ms` and
// `meta.all_day` and must not learn that a second backend exists:
//
//   { ts, source: 'calendar', entity_id: 'calendar:<uid>:<slot-seconds>',
//     text, meta: { event_uid, start_ms, end_ms, calendar, all_day } }
//
// Pure — no clock, no I/O — so every branch below is assertable.

// Google returns all-day events as {date: 'YYYY-MM-DD'} and timed ones as
// {dateTime: ISO, timeZone}. The two are not interchangeable: a bare date has
// no instant until a zone is chosen, and choosing UTC would shift an all-day
// event onto the wrong local day for anyone west of Greenwich — which is
// every user of this system.
export function parseSlot(slot, { fallbackZone } = {}) {
  if (slot === null || typeof slot !== 'object') return { ms: NaN, allDay: false };
  if (typeof slot.dateTime === 'string') {
    return { ms: Date.parse(slot.dateTime), allDay: false };
  }
  if (typeof slot.date === 'string') {
    // Anchor a bare date at local midnight of the event's own zone. Without a
    // zone we fall back to the runtime's, which is the machine the owner
    // lives on — the same assumption the local-store connector makes.
    const zone = slot.timeZone ?? fallbackZone;
    return { ms: localMidnightMs(slot.date, zone), allDay: true };
  }
  return { ms: NaN, allDay: false };
}

// 'YYYY-MM-DD' → epoch ms at 00:00 in `zone`. Done by probing the offset that
// zone had at that instant rather than by string math, so DST transitions and
// historical offset changes cannot skew it.
function localMidnightMs(dateStr, zone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  const utcGuess = Date.UTC(y, m - 1, d);
  if (!zone) return new Date(y, m - 1, d).getTime();
  let ms = utcGuess;
  // Two passes converge: the first offset may itself be wrong across a DST
  // boundary, the second is computed at the corrected instant.
  for (let i = 0; i < 2; i += 1) {
    const offset = zoneOffsetMs(ms, zone);
    ms = utcGuess - offset;
  }
  return ms;
}

function zoneOffsetMs(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - ms;
}

function humanSpan({ allDay, startMs, endMs }) {
  if (allDay) return 'all day';
  const f = (ms) =>
    new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '');
  return `${f(startMs)}–${f(endMs)}`;
}

export function eventToRow(event, { calendarTitle, fallbackZone } = {}) {
  // Cancelled occurrences of a recurring series come back as tombstones; they
  // are the absence of a meeting, not a meeting, and must not be ingested.
  if (event?.status === 'cancelled') return null;

  const start = parseSlot(event?.start, { fallbackZone });
  const end = parseSlot(event?.end, { fallbackZone });
  if (!Number.isFinite(start.ms) || !Number.isFinite(end.ms)) return null;

  // iCalUID is stable across the series AND survives a move between
  // calendars, which `id` does not. The start-slot suffix is what separates
  // occurrences of one series — the same scheme the local-store connector uses.
  const uid = event.iCalUID ?? event.id;
  if (typeof uid !== 'string' || uid.length === 0) return null;

  const slotSeconds = Math.floor(start.ms / 1000);
  const summary =
    typeof event.summary === 'string' && event.summary.length > 0 ? event.summary : '(untitled)';
  const title =
    typeof calendarTitle === 'string' && calendarTitle.length > 0
      ? calendarTitle
      : '(untitled calendar)';

  return {
    ts: start.ms,
    source: 'calendar',
    entity_id: `calendar:${uid}:${slotSeconds}`,
    text: `"${summary}" ${humanSpan({ allDay: start.allDay, startMs: start.ms, endMs: end.ms })} (${title})`,
    meta: {
      event_uid: uid,
      start_ms: start.ms,
      end_ms: end.ms,
      calendar: title,
      all_day: start.allDay,
      ...(typeof event?.location === 'string' && event.location.trim()
        ? { location: event.location.trim() }
        : {}),
      // Who was actually in the room. Attendee emails were thrown away until
      // 2026-08-21, which made "who did I meet" answerable only by inference;
      // the email is the cleanest join key this corpus has (it matches mail
      // senders and, through the contacts spine, iMessage handles). Owner's
      // own entry is skipped — every event would carry it — and resource
      // rooms are skipped because a conference room is not a person.
      ...(Array.isArray(event?.attendees) && event.attendees.length > 0
        ? {
            // SORTED BY EMAIL, AND SORTED BEFORE THE SLICE.
            //
            // connectors/AGENTS.md: "pre-sort semantically-unordered arrays in
            // meta (attendees, recipients, categories)". Hermes canonicalizes
            // object KEY order for the content hash but preserves ARRAY order,
            // because it cannot know which arrays are sets. An attendee list is
            // a set, and Google returns it in no guaranteed order — so every
            // reshuffle read as an edit, fired
            // invalidateClaimsForChangedRow, and destroyed the claims the owner
            // had accepted about that meeting. granola.mjs, mailRows.mjs and
            // peopleRows.mjs all sort; this was the one that did not.
            //
            // Before the slice, not after: slicing an unordered list picks an
            // arbitrary 50, so a reshuffle changed WHICH attendees survived as
            // well as their order. Sorting first makes both stable.
            attendees: event.attendees
              .filter((a) => a?.self !== true && a?.resource !== true && typeof a?.email === 'string')
              .sort((x, y) => (x.email.toLowerCase() < y.email.toLowerCase() ? -1 : 1))
              .slice(0, 50)
              .map((a) => ({
                email: a.email.toLowerCase(),
                ...(typeof a.displayName === 'string' && a.displayName ? { name: a.displayName } : {}),
                ...(a.organizer === true ? { organizer: true } : {}),
                ...(typeof a.responseStatus === 'string' ? { response: a.responseStatus } : {}),
              })),
          }
        : {}),
    },
  };
}

// Declining a meeting is how you get time back; counting it as load would
// invert the signal the energy audit is built on.
export function ownerDeclined(event) {
  const self = (event?.attendees ?? []).find((a) => a?.self === true);
  return self?.responseStatus === 'declined';
}

export function eventsToRows(events, { calendarTitle, fallbackZone } = {}) {
  const byId = new Map();
  let skipped = 0;
  for (const event of events ?? []) {
    if (ownerDeclined(event)) {
      skipped += 1;
      continue;
    }
    const row = eventToRow(event, { calendarTitle, fallbackZone });
    if (row === null) {
      skipped += 1;
      continue;
    }
    // Deterministic on collision: keep the first, matching the local-store
    // connector's rule rather than letting one batch fight itself.
    if (byId.has(row.entity_id)) {
      skipped += 1;
      continue;
    }
    byId.set(row.entity_id, row);
  }
  return { rows: [...byId.values()], skipped };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToRow, eventsToRows, ownerDeclined, parseSlot } from '../lib/gcalRows.mjs';

const timed = (startIso, endIso, extra = {}) => ({
  id: 'evt1',
  iCalUID: 'uid-1@google.com',
  summary: 'Standup',
  start: { dateTime: startIso },
  end: { dateTime: endIso },
  ...extra,
});

// The contract with ui/server/vault/digest.mjs. If this drifts, the digest
// silently reads NaN and reports every event as unreadable — which is exactly
// how the Oura rows were invisible for a week.
test('a row is shape-compatible with the local-store connector', () => {
  const row = eventToRow(timed('2026-08-13T09:00:00-07:00', '2026-08-13T09:30:00-07:00'), {
    calendarTitle: 'Mtgs',
  });
  assert.equal(row.source, 'calendar');
  assert.equal(row.entity_id, `calendar:uid-1@google.com:${Math.floor(row.meta.start_ms / 1000)}`);
  assert.equal(row.ts, row.meta.start_ms);
  assert.deepEqual(Object.keys(row.meta).sort(), [
    'all_day',
    'calendar',
    'end_ms',
    'event_uid',
    'start_ms',
  ]);
  assert.equal(row.meta.calendar, 'Mtgs');
  assert.equal(row.meta.all_day, false);
  assert.equal(row.meta.end_ms - row.meta.start_ms, 30 * 60 * 1000);
});

test('the uid is iCalUID, which survives a move between calendars', () => {
  const row = eventToRow(timed('2026-08-13T09:00:00Z', '2026-08-13T10:00:00Z'), { calendarTitle: 'A' });
  assert.ok(row.entity_id.startsWith('calendar:uid-1@google.com:'));
  // id-only events still work; iCalUID is preferred, not required.
  const noUid = eventToRow(
    { id: 'raw-id', summary: 'x', start: { dateTime: '2026-08-13T09:00:00Z' }, end: { dateTime: '2026-08-13T10:00:00Z' } },
    { calendarTitle: 'A' }
  );
  assert.ok(noUid.entity_id.startsWith('calendar:raw-id:'));
});

// An all-day event anchored in UTC lands on the wrong local day for anyone
// west of Greenwich — i.e. every user of this system.
test('an all-day event anchors at local midnight, not UTC midnight', () => {
  const { ms, allDay } = parseSlot({ date: '2026-08-13', timeZone: 'America/Los_Angeles' });
  assert.equal(allDay, true);
  assert.equal(new Date(ms).toISOString(), '2026-08-13T07:00:00.000Z', 'PDT is UTC-7');
  const utcNaive = Date.parse('2026-08-13T00:00:00Z');
  assert.notEqual(ms, utcNaive);
});

test('all-day anchoring survives a DST boundary', () => {
  // 2026-11-01 is the US fall-back date; PST is UTC-8 after it.
  const { ms } = parseSlot({ date: '2026-11-02', timeZone: 'America/Los_Angeles' });
  assert.equal(new Date(ms).toISOString(), '2026-11-02T08:00:00.000Z');
});

test('a cancelled occurrence is not a meeting', () => {
  assert.equal(eventToRow({ ...timed('2026-08-13T09:00:00Z', '2026-08-13T10:00:00Z'), status: 'cancelled' }), null);
});

test('an event with no usable times is dropped, not ingested as NaN', () => {
  assert.equal(eventToRow({ id: 'x', start: {}, end: {} }), null);
  assert.equal(eventToRow({ id: 'x', start: { dateTime: 'not-a-date' }, end: { dateTime: 'nope' } }), null);
  assert.equal(eventToRow(null), null);
});

// Declining is how you get time back; counting it as load inverts the signal.
test('a meeting the owner declined is excluded', () => {
  const declined = timed('2026-08-13T09:00:00Z', '2026-08-13T10:00:00Z', {
    attendees: [{ email: 'other@x.com', responseStatus: 'accepted' }, { self: true, responseStatus: 'declined' }],
  });
  assert.equal(ownerDeclined(declined), true);
  const { rows, skipped } = eventsToRows([declined], { calendarTitle: 'A' });
  assert.equal(rows.length, 0);
  assert.equal(skipped, 1);
});

test("someone else's decline does not exclude the meeting", () => {
  const event = timed('2026-08-13T09:00:00Z', '2026-08-13T10:00:00Z', {
    attendees: [{ email: 'other@x.com', responseStatus: 'declined' }],
  });
  assert.equal(ownerDeclined(event), false);
  assert.equal(eventsToRows([event], { calendarTitle: 'A' }).rows.length, 1);
});

test('two occurrences of one series get distinct ids; a duplicate slot does not', () => {
  const a = timed('2026-08-13T09:00:00Z', '2026-08-13T09:30:00Z');
  const b = timed('2026-08-14T09:00:00Z', '2026-08-14T09:30:00Z');
  assert.equal(eventsToRows([a, b], { calendarTitle: 'A' }).rows.length, 2);
  const { rows, skipped } = eventsToRows([a, { ...a }], { calendarTitle: 'A' });
  assert.equal(rows.length, 1);
  assert.equal(skipped, 1);
});

test('an untitled event and an untitled calendar still render', () => {
  const row = eventToRow({ id: 'x', start: { dateTime: '2026-08-13T09:00:00Z' }, end: { dateTime: '2026-08-13T10:00:00Z' } });
  assert.ok(row.text.includes('(untitled)'));
  assert.equal(row.meta.calendar, '(untitled calendar)');
});

test('a physical event location survives into canonical metadata', () => {
  const row = eventToRow(timed('2026-08-13T09:00:00Z', '2026-08-13T10:00:00Z', {
    location: ' Los Angeles, CA ',
  }), { calendarTitle: 'Travel' });
  assert.equal(row.meta.location, 'Los Angeles, CA');
});

// --- meta.attendees is a SET, so its order must not carry information -------
// No test looked at meta.attendees at all until 2026-08-22, which is how the
// missing sort survived: hermes canonicalizes object key order for the content
// hash but preserves array order, so every reshuffle from Google read as an
// edit and destroyed the claims the owner had accepted about that meeting.

test('attendees are sorted by email, so a reshuffle is not an edit', () => {
  const attendees = [
    { email: 'Zed@example.com' },
    { email: 'ari@example.com' },
    { email: 'mia@example.com' },
  ];
  const opts = { calendarTitle: 'Mtgs' };
  const a = eventToRow(timed('2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', { attendees }), opts);
  const b = eventToRow(
    timed('2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', { attendees: [...attendees].reverse() }),
    opts
  );

  assert.deepEqual(
    a.meta.attendees.map((x) => x.email),
    ['ari@example.com', 'mia@example.com', 'zed@example.com']
  );
  assert.deepEqual(a.meta.attendees, b.meta.attendees, 'the same set must produce the same array');
  assert.equal(
    JSON.stringify(a.meta),
    JSON.stringify(b.meta),
    'identical meta means an identical content hash, so no spurious update'
  );
});

test('the 50-attendee cap keeps the SAME fifty regardless of input order', () => {
  // Sorting after the slice would have made a reshuffle change which
  // attendees survived, not just their order — a quieter version of the same
  // bug, and one that alters what the row says.
  const emails = Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, '0')}@example.com`);
  const opts = { calendarTitle: 'Mtgs' };
  const mk = (list) =>
    eventToRow(
      timed('2026-08-20T10:00:00Z', '2026-08-20T11:00:00Z', { attendees: list.map((email) => ({ email })) }),
      opts
    );
  const forward = mk(emails);
  const backward = mk([...emails].reverse());

  assert.equal(forward.meta.attendees.length, 50);
  assert.deepEqual(
    forward.meta.attendees.map((x) => x.email),
    backward.meta.attendees.map((x) => x.email)
  );
});

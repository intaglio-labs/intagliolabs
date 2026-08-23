// The maintenance window — when the blocking VACUUM is allowed to run.
//
// Two bugs, both about time rather than logic. The next window was computed by
// adding a flat 86,400,000 ms, which is not a local day across a DST
// transition; and the window was only ever checked when the timer was ARMED,
// never when it FIRED, so a machine that slept through 03:30 ran /admin/maintain
// whenever it happened to wake.
//
// The assertions below are deliberately timezone-independent: they check that
// the result lands at 03:30 on the following calendar day, which is true in
// every zone, rather than checking a millisecond count that is only true in one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { msUntilIdleWindow, isInsideIdleWindow } from '../retain.mjs';


// --- the maintenance window: DST, and firing late ---------------------------

test('the next window is a local DAY away, not 86,400,000 ms', () => {
  // The header promises local wall-clock. A flat 24h in milliseconds is not
  // that: a local day is 23 or 25 hours across a DST transition, so the
  // blocking VACUUM landed an hour off twice a year and stayed off.
  //
  // US spring-forward 2027 is Sunday 14 March. From 04:00 on the 13th, the
  // next 03:30 is 23 hours away, not 24.
  const beforeSpringForward = new Date(2027, 2, 13, 4, 0, 0).getTime();
  const ms = msUntilIdleWindow('03:30', beforeSpringForward);
  const landed = new Date(beforeSpringForward + ms);
  assert.equal(landed.getHours(), 3, 'must land at 03:xx local, whatever the day length');
  assert.equal(landed.getMinutes(), 30);
  assert.equal(landed.getDate(), 14, 'and on the next calendar day');
});

test('the next window survives autumn fall-back too', () => {
  // 25-hour day: 7 November 2027.
  const beforeFallBack = new Date(2027, 10, 6, 4, 0, 0).getTime();
  const ms = msUntilIdleWindow('03:30', beforeFallBack);
  const landed = new Date(beforeFallBack + ms);
  assert.equal(landed.getHours(), 3);
  assert.equal(landed.getMinutes(), 30);
  assert.equal(landed.getDate(), 7);
});

test('landing exactly on the minute schedules tomorrow, not a zero delay', () => {
  const exactly = new Date(2027, 5, 1, 3, 30, 0).getTime();
  const ms = msUntilIdleWindow('03:30', exactly);
  assert.ok(ms > 0, 'never zero — that would double-fire');
  assert.equal(new Date(exactly + ms).getDate(), 2);
});

test('isInsideIdleWindow accepts a slightly late fire and rejects a slept-through one', () => {
  // The point of the predicate: a timer a few minutes late is still the window;
  // a laptop that woke at 09:00 is not, and must not run a blocking VACUUM
  // while every connector is mid-poll.
  const at = (h, m) => new Date(2027, 5, 1, h, m, 0).getTime();
  assert.equal(isInsideIdleWindow('03:30', at(3, 30)), true, 'on time');
  assert.equal(isInsideIdleWindow('03:30', at(3, 55)), true, '25 minutes late is fine');
  assert.equal(isInsideIdleWindow('03:30', at(4, 29)), true, 'still inside the hour');
  assert.equal(isInsideIdleWindow('03:30', at(4, 31)), false, 'past the hour');
  assert.equal(isInsideIdleWindow('03:30', at(9, 0)), false, 'slept through the night');
  assert.equal(isInsideIdleWindow('03:30', at(3, 29)), false, 'not yet');
});

test('a malformed maintainHour is never "inside" the window', () => {
  // Fail closed: an unparseable config must not authorise a blocking VACUUM at
  // an arbitrary moment.
  for (const bad of ['25:00', 'nope', '', null, undefined, 330]) {
    assert.equal(isInsideIdleWindow(bad, Date.now()), false, JSON.stringify(bad));
  }
});

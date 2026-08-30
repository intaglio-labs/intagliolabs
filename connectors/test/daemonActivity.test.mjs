// What the Settings "activity" panel is allowed to claim.
//
// Both behaviours pinned here were reported by the owner looking at the live
// panel: it announced "~ 17.3 hrs left" while completely idle, and it listed
// sources for accounts that had never been connected. Neither was a rendering
// bug -- the daemon published both, and the panel drew what it was given.
//
// Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDaemon } from '../daemon.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The first source fires at 1s; each later one is staggered 10s behind it, so a
// test that needs a source to actually tick puts it first and waits once.
const FIRST_TICK_MS = 1_400;

const fakeState = (cursors = {}) => {
  const map = new Map(Object.entries(cursors));
  return {
    getCursor: (name) => map.get(name),
    setCursor: (name, value) => map.set(name, value),
    recordRun: () => {},
  };
};

const silent = { info() {}, warn() {}, error() {} };

const source = (name, missing = [], { walksHistory = false } = {}) => ({
  name,
  walksHistory,
  needs: async () => missing,
  run: async () => ({}),
});

// Drive a real daemon for one tick and hand back what it published.
async function publishedSnapshot(sources, cursors, { settleMs = FIRST_TICK_MS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hazlie-activity-'));
  const activityPath = join(dir, 'activity.json');
  const daemon = createDaemon({
    config: { retention: { maintainHour: '03:30' } },
    state: fakeState(cursors),
    log: silent,
    sources,
    ingestOpts: {},
    cacheDir: dir,
    activityPath,
  });
  try {
    daemon.start();
    await sleep(settleMs);
    return JSON.parse(readFileSync(activityPath, 'utf8'));
  } finally {
    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const DONE = { 'calendar:history-done': '1', 'matrix:history-done': '1' };

test('a source that cannot run is not queued as pending work', async () => {
  const snapshot = await publishedSnapshot(
    [source('granola', ['granola API key missing']), source('imessage')],
    DONE
  );
  const queued = snapshot.queue.map((task) => task.connector);
  // It is scheduled, it ticks, and it finds no credential -- forever. Showing it
  // told the owner they had work queued for an account they never connected.
  assert.ok(!queued.includes('granola'), `unprovisioned source still queued: ${queued.join()}`);
  // ...and the filter must not take the working sources with it.
  assert.ok(queued.includes('imessage'), `ready source dropped: ${queued.join()}`);
});

test('an idle daemon claims no time remaining', async () => {
  const snapshot = await publishedSnapshot([source('imessage')], DONE);
  // The horizon used to include the idle-window maintenance pass, so a daemon
  // with nothing to do reported most of a day of work left.
  assert.equal(snapshot.estimate, undefined, `idle daemon claimed: ${snapshot.estimate}`);
  assert.deepEqual(snapshot.backfill ?? [], []);
});

// The counterpart, so the fix above cannot be "delete the estimate".
test('real multi-pass backfill still reports a horizon', async () => {
  // The roster is sources.filter(walksHistory === true) — a connector only
  // enters the yearly backfill by declaring it, so a fixture that does not
  // declare it produces an empty roster and this test asserts against nothing.
  // That is a fixture bug, not a licence to relax the assertion.
  const snapshot = await publishedSnapshot([source('calendar', [], { walksHistory: true })], {
    'matrix:history-done': '1',
    'calendar:history-ceiling-ts': String(Date.UTC(2016, 0, 1)),
    'calendar:history-slices-per-pass': '1',
  });
  assert.match(String(snapshot.estimate), /^~ \d+\.\d hrs left$/);
  assert.deepEqual(snapshot.backfill, ['calendar']);
});

// A RESTART MUST NOT RE-ADVERTISE WORK THAT CANNOT RUN.
//
// notReady is filled inside runSource, so it is empty at startup while
// scheduleSource publishes immediately. Every daemon restart listed granola and
// mail as pending for up to a full first-run stagger before their own ticks
// corrected it — reported by the owner as "granola's started showing back up in
// the activity menu when it isnt connected". The filter was fine; it had nothing
// to filter on yet.
test('an unprovisioned source is absent from the very first published queue', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-restart-'));
  try {
    // Read the snapshot fast — well inside the 1s before any source first runs,
    // so this can only pass if readiness was evaluated at startup.
    const snapshot = await publishedSnapshot(
      [source('granola', ['granola API key missing']), source('imessage')],
      DONE,
      { settleMs: 600 }
    );
    const queued = snapshot.queue.map((t) => t.connector);
    assert.ok(!queued.includes('granola'),
      `an unprovisioned source was published before it ticked: ${queued.join()}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

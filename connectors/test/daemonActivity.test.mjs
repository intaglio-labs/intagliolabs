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

const source = (name, missing = []) => ({
  name,
  needs: async () => missing,
  run: async () => ({}),
});

// Drive a real daemon for one tick and hand back what it published.
async function publishedSnapshot(sources, cursors) {
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
    await sleep(FIRST_TICK_MS);
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
  const snapshot = await publishedSnapshot([source('imessage')], {
    'matrix:history-done': '1',
    'calendar:history-ceiling-ts': String(Date.UTC(2016, 0, 1)),
    'calendar:history-slices-per-pass': '1',
  });
  assert.match(String(snapshot.estimate), /^~ \d+\.\d hrs left$/);
  assert.deepEqual(snapshot.backfill, ['calendar']);
});

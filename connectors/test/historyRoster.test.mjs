// THE YEARLY BACKFILL AND THE SCHEDULER HAVE TO AGREE ON WHO IS RUNNING.
//
// The history barrier waits for every roster member to be classified before it
// moves the year, and only a SCHEDULED source is ever classified. So a history
// source the registry has switched off — `matrix` on every default install,
// because it follows the bridges feature — sat on the roster as a permanent
// unclassified member, and the yearly walk never left the current year for any
// of the others. Nothing logged it: from the outside the backfill simply stopped
// making progress.
//
// Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The daemon reads the feature registry at module scope, so the override has to
// be silenced BEFORE the import — a developer's ~/.hazlie/features.json with
// bridges on would otherwise schedule matrix and hide the deadlock this test is
// about. Dynamic import for that reason and no other.
process.env.HAZLIE_FEATURES_OVERRIDE = 'none';
const { createDaemon, DEFAULT_DISABLED_CONNECTORS } = await import('../daemon.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeState = (cursors = {}) => {
  const map = new Map(Object.entries(cursors));
  return {
    getCursor: (name) => map.get(name) ?? null,
    setCursor: (name, value) => map.set(name, String(value)),
    deleteCursor: (name) => map.delete(name),
    deleteCursors: (prefix) => {
      for (const key of [...map.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}:`)) map.delete(key);
      }
    },
    recordRun: () => {},
  };
};

const silent = { info() {}, warn() {}, error() {} };

const source = (name, { walksHistory = false } = {}) => ({
  name,
  walksHistory,
  needs: async () => [],
  run: async () => ({}),
});

async function publishedSnapshot(sources, cursors) {
  const dir = mkdtempSync(join(tmpdir(), 'hazlie-history-roster-'));
  const activityPath = join(dir, 'activity.json');
  const daemon = createDaemon({
    config: { retention: { maintainHour: '03:30' } },
    state: fakeState(cursors),
    log: silent,
    sources,
    ingestOpts: {},
    completePeopleYear: null,
    cacheDir: dir,
    activityPath,
  });
  try {
    daemon.start();
    await sleep(700); // the restart reconciliation runs before the first tick
    return JSON.parse(readFileSync(activityPath, 'utf8'));
  } finally {
    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a history source the registry disabled does not hold the barrier shut', async () => {
  // The premise, so a future registry change fails this test loudly rather than
  // making it pass for nothing: matrix is a history source that is NOT scheduled.
  assert.ok(DEFAULT_DISABLED_CONNECTORS.includes('matrix'),
    'with bridges off, matrix is hidden — that is the case this test exists for');
  const year = new Date().getFullYear();
  const snapshot = await publishedSnapshot(
    [source('imessage', { walksHistory: true }), source('matrix', { walksHistory: true })],
    { [`yearly-backfill:connector:imessage:done:${year}`]: '1' }
  );
  assert.equal(snapshot.backfillYear, year - 1,
    'the only scheduled history source finished this year, so the walk moves to the last one');
});

test('two scheduled history sources still wait for each other', async () => {
  // The discriminating half: the barrier is not simply gone. A second source
  // that IS scheduled and has not finished the year holds it exactly as before.
  const year = new Date().getFullYear();
  const snapshot = await publishedSnapshot(
    [source('imessage', { walksHistory: true }), source('calendar', { walksHistory: true })],
    { [`yearly-backfill:connector:imessage:done:${year}`]: '1' }
  );
  assert.equal(snapshot.backfillYear, year);
});

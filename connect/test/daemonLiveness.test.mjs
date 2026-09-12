// IS THAT DAEMON STILL RUNNING, asked the way the shelf asks it.
//
// registryDaemonView.test.mjs covers what the page does with the answer. This
// file covers the two ways the answer used to be wrong: a recycled pid read as
// a live daemon, and a freshness window that ignored the owner's configured
// intervals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAEMON_ACTIVITY_FRESH_MS,
  DEFAULT_INTERVAL_S,
  daemonActivityFreshMs,
  daemonRegistryState,
} from '../lib/status.mjs';
import { daemonLockIsLive, processStartedAt } from '../../connectors/lib/daemonLock.mjs';

function fakeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'intaglio-daemon-live-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true, mode: 0o700 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const activityPath = (home) => join(home, '.hazlie', 'connectors', 'activity.json');

function writeActivity(home, registryState) {
  writeFileSync(activityPath(home), JSON.stringify({ phase: 'waiting', queue: [], registryState }));
}

function backdate(home, ms) {
  const at = (Date.now() - ms) / 1000;
  utimesSync(activityPath(home), at, at);
}

function writeLock(home, lock) {
  writeFileSync(join(home, '.hazlie', 'connectors', 'daemon.lock'), JSON.stringify(lock));
}

test('a recycled pid is not the daemon that wrote the lock', (t) => {
  const home = fakeHome(t);
  writeActivity(home, 'missing');
  backdate(home, DAEMON_ACTIVITY_FRESH_MS * 10);
  // THE DISCRIMINATING PAIR. Both locks name a pid that is definitely alive —
  // this very test process — and differ only in when the lock says the daemon
  // started. A check that asks the kernel "does this pid exist" cannot tell
  // them apart, which is exactly how a hard-killed daemon's lock kept the
  // stale restart notice alive once macOS handed its number to something else.
  const began = processStartedAt(process.pid);
  assert.ok(Number.isFinite(began), 'the OS can say when this process started');

  writeLock(home, { pid: process.pid, token: 'a'.repeat(64), startedTs: began + 5_000 });
  assert.equal(daemonRegistryState({ home }), 'missing',
    'the process that wrote this lock is the process that is running');

  writeLock(home, { pid: process.pid, token: 'a'.repeat(64), startedTs: began - 86_400_000 });
  assert.equal(daemonRegistryState({ home }), null,
    'a lock written a day before this pid began is a lock from a dead daemon');
});

test('a lock with no startedTs is not evidence of a live daemon', (t) => {
  const home = fakeHome(t);
  writeActivity(home, 'invalid');
  backdate(home, DAEMON_ACTIVITY_FRESH_MS * 10);
  writeLock(home, { pid: process.pid, token: 'a'.repeat(64) });
  assert.equal(daemonRegistryState({ home }), null,
    'an older daemon cannot prove it is the one holding the pid');
});

test("a process this user may not signal is somebody else's", () => {
  const home = mkdtempSync(join(tmpdir(), 'intaglio-daemon-foreign-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true, mode: 0o700 });
  try {
    const startedTs = Date.now();
    writeLock(home, { pid: 4242, token: 'a'.repeat(64), startedTs });
    assert.equal(
      daemonLockIsLive({ home, state: () => 'alive', startedAt: () => startedTs - 1_000 }),
      true
    );
    // EPERM used to count as alive here. The daemon runs as the owner, so a
    // process the owner cannot signal is positive evidence it is NOT ours.
    assert.equal(
      daemonLockIsLive({ home, state: () => 'foreign', startedAt: () => startedTs - 1_000 }),
      false
    );
    // And an unanswerable start time goes quiet rather than vouching.
    assert.equal(
      daemonLockIsLive({ home, state: () => 'alive', startedAt: () => null }),
      false
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the freshness window follows the configured intervals', (t) => {
  const home = fakeHome(t);
  assert.equal(daemonActivityFreshMs({ home }), 2 * DEFAULT_INTERVAL_S * 1000,
    'no intervals block is the default window');

  // An owner who slows mail to two hours has a daemon that republishes every
  // two hours. The old hardcoded 30-minute window called that daemon dead.
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'config.json'),
    JSON.stringify({ intervals: { mail: 7_200, granola: 300 } })
  );
  assert.equal(daemonActivityFreshMs({ home }), 2 * 7_200 * 1000);

  writeActivity(home, 'invalid');
  backdate(home, DAEMON_ACTIVITY_FRESH_MS + 60_000);
  assert.equal(daemonRegistryState({ home }), 'invalid',
    'inside the cadence this install actually runs at, with no lock file at all');

  backdate(home, 2 * 7_200 * 1000 + 60_000);
  assert.equal(daemonRegistryState({ home }), null,
    'past even the slow cadence, it is still silence rather than a claim');
});

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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { daemonLockIsLive, forgetProcessStart, processStartedAt } from '../../connectors/lib/daemonLock.mjs';
import { CONNECTOR_NAMES } from '../../connectors/lib/connectorNames.mjs';

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

// THE REPUBLISH CADENCE IS THE FASTEST SOURCE, NOT THE SLOWEST.
//
// Every source's reschedule calls publishWaiting, so activity.json is rewritten
// whenever ANY connector ticks. The window took the MAXIMUM over the configured
// intervals, which reads one slowed connector as though it set the pace for the
// whole daemon (round-4 finding 13).
test('the freshness window follows the fastest connector, not the slowest', (t) => {
  const home = fakeHome(t);
  const configPath = join(home, '.hazlie', 'connectors', 'config.json');
  const setIntervals = (intervals) => writeFileSync(configPath, JSON.stringify({ intervals }));

  assert.equal(daemonActivityFreshMs({ home }), 2 * DEFAULT_INTERVAL_S * 1000,
    'no intervals block is the default window');

  // THE DISCRIMINATING CASE. One rarely-polled connector slowed to its
  // 86,400s ceiling, everything else left at the default. Under the max rule
  // this bought a 48-hour window on an install that still republishes every
  // fifteen minutes, so a daemon that died yesterday went on being quoted as
  // authoritative.
  setIntervals({ notion: 86_400 });
  assert.equal(daemonActivityFreshMs({ home }), 2 * DEFAULT_INTERVAL_S * 1000,
    'one slow connector does not widen the window: the others still tick');

  // Mixed, same reasoning: granola at five minutes is what sets the cadence,
  // and the floor keeps the window at the default rather than tightening to
  // 2 x 300s.
  setIntervals({ mail: 7_200, granola: 300 });
  assert.equal(daemonActivityFreshMs({ home }), 2 * DEFAULT_INTERVAL_S * 1000);

  // AND THE CASE THE WINDOW WAS WIDENED FOR IS STILL COVERED: when every
  // connector is slowed, the cadence really has moved and the window moves
  // with it.
  const everyConnector = Object.fromEntries(CONNECTOR_NAMES.map((name) => [name, 7_200]));
  setIntervals(everyConnector);
  assert.equal(daemonActivityFreshMs({ home }), 2 * 7_200 * 1000,
    'a whole-roster slowdown is a real cadence change');

  // 'ok', because the word is not incidental any more: a daemon that published
  // 'invalid' is running on ALL_OFF and scheduling no connector at all, so it
  // rewrites this file at no connector's cadence and gets the default window
  // whatever the intervals say. That is its own test, below.
  writeActivity(home, 'ok');
  backdate(home, DAEMON_ACTIVITY_FRESH_MS + 60_000);
  assert.equal(daemonRegistryState({ home }), 'ok',
    'inside the cadence this install actually runs at, with no lock file at all');

  backdate(home, 2 * 7_200 * 1000 + 60_000);
  assert.equal(daemonRegistryState({ home }), null,
    'past even the slow cadence, it is still silence rather than a claim');

  // Back to one slow connector: the same file age that was inside the
  // whole-roster window is outside this one, which is the whole point.
  setIntervals({ notion: 86_400 });
  assert.equal(daemonRegistryState({ home }), null,
    'a two-day-old file is not authoritative because notion polls daily');
});

// THE ROSTER IS THE CONNECTORS THIS INSTALL SCHEDULES (round-5 finding 4).
//
// The minimum was taken over all thirteen names with every unconfigured one
// counted at 900s, so on any install that does not configure all thirteen the
// minimum was 900 and the config could not move the answer at all: a
// derivation that always returns the constant it replaced.
//
// daemon.mjs schedules `sources` minus connectorsDisabledBy(FEATURES, ...), so
// the feature registry is what decides who republishes, and the same call
// answers it here.
function withFeatureOverride(t, home, features) {
  const path = join(home, '.hazlie', 'features.json');
  writeFileSync(path, JSON.stringify(features));
  const previous = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HAZLIE_FEATURES_OVERRIDE = path;
  t.after(() => {
    if (previous === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previous;
  });
}

test('an install whose registry leaves one connector running is sized by that connector', (t) => {
  const home = fakeHome(t);
  // THE DISCRIMINATING CASE, and the one from the finding: mail at an hour on
  // a machine where nothing else is scheduled to tick. Over the whole roster
  // the minimum is 900 (twelve names nobody configured), and the window comes
  // back at the default 30 minutes for a daemon that rewrites the file every
  // 60 -- so the freshness fast path is dead and every request pays for a `ps`.
  withFeatureOverride(t, home, {
    bridges: false, // and therefore matrix, which IS the bridges feature
    connectors: Object.fromEntries(
      CONNECTOR_NAMES.filter((name) => name !== 'matrix' && name !== 'mail')
        .map((name) => [name, false])
    ),
  });
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'config.json'),
    JSON.stringify({ intervals: { mail: 3_600 } })
  );
  assert.equal(daemonActivityFreshMs({ home }), 2 * 3_600 * 1000,
    'the one connector that ticks is the one that sets the cadence');

  // And a connector the registry switched off cannot widen it, however slow
  // its leftover interval says it would have been.
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'config.json'),
    JSON.stringify({ intervals: { mail: 3_600, notion: 86_400 } })
  );
  assert.equal(daemonActivityFreshMs({ home }), 2 * 3_600 * 1000,
    'notion is not scheduled, so its interval is not a cadence');
});

test('a registry that schedules nothing keeps the default window, not an infinite one', (t) => {
  const home = fakeHome(t);
  withFeatureOverride(t, home, {
    bridges: false,
    connectors: Object.fromEntries(
      CONNECTOR_NAMES.filter((name) => name !== 'matrix').map((name) => [name, false])
    ),
  });
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'config.json'),
    JSON.stringify({ intervals: { mail: 86_400 } })
  );
  // Math.min of nothing is Infinity, and an infinite window would make a dead
  // daemon's last word authoritative for ever. Nothing scheduled means nothing
  // rewrites the file, so there is no cadence to derive and the narrowest
  // answer this function has is the right one.
  assert.equal(daemonActivityFreshMs({ home }), DAEMON_ACTIVITY_FRESH_MS);
});

// A 2-SECOND SYNCHRONOUS `ps` DOES NOT BELONG ON A REQUEST PATH (round-4
// finding 12).
//
// daemonRegistryState reaches daemonLockIsLive -> processStartedAt whenever the
// activity file is stale, which is exactly the state an owner sits and polls,
// and execFileSync there blocks connect's event loop for every one of those
// requests. Freshness-first spared the healthy case; this spares the case that
// actually polls.
//
// THE OBSERVABLE IS THE STALENESS THE CACHE BUYS, because that is the only
// externally visible difference between one fork and none: a pid whose process
// has exited still answers from the window, and forgetProcessStart is the way
// back to the kernel. A process's start time never changes while it runs, so
// the window costs nothing else.
test('the process start probe answers from a window rather than forking per call', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const { pid } = child;
  forgetProcessStart(pid);

  const began = processStartedAt(pid);
  assert.ok(Number.isFinite(began), 'a live process has a start time');

  child.kill('SIGKILL');
  await once(child, 'exit');

  assert.equal(processStartedAt(pid), began,
    'inside the window the answer stands without asking the OS again');
  forgetProcessStart(pid);
  assert.equal(processStartedAt(pid), null,
    'and dropping the entry goes back to the kernel, which no longer knows that pid');
});

// THE DAEMON'S OWN READ OF THE REGISTRY, NOT A SECOND ONE (round-6 finding 13).
//
// connectors/daemon.mjs freezes FEATURES and DEFAULT_DISABLED_CONNECTORS at
// module scope; this file read the same registry per request. So an override
// edited under a running daemon moved connect's idea of who is scheduled and
// not the daemon's, and the two derived the same fact from different reads with
// nothing reconciling them.
//
// What the daemon actually did is already on disk: `registryState` is the word
// it read, and `queue` names the connectors it is scheduling right now.
test('a daemon that published a broken registry gets the default window, whatever the intervals say', (t) => {
  const home = fakeHome(t);
  // Every connector slowed to two hours: under the roster rule alone this is a
  // four-hour window. But ALL_OFF is what an unreadable registry answers, so
  // that daemon schedules nothing and rewrites this file at no connector's
  // cadence -- four hours of trusting a file from a daemon that may have died
  // three hours ago.
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'config.json'),
    JSON.stringify({ intervals: Object.fromEntries(CONNECTOR_NAMES.map((n) => [n, 7_200])) })
  );
  writeActivity(home, 'invalid');
  assert.equal(daemonActivityFreshMs({ home }), DAEMON_ACTIVITY_FRESH_MS);

  // And the same install whose daemon read the registry cleanly keeps its real
  // cadence: the collapse is about what the daemon said, not about the config.
  writeActivity(home, 'ok');
  assert.equal(daemonActivityFreshMs({ home }), 2 * 7_200 * 1000);
});

test('a connector the daemon is still queueing keeps its say after the override drops it', (t) => {
  const home = fakeHome(t);
  // The drift, in one machine: the owner switches everything except mail off in
  // the override while the daemon -- which froze its registry at start -- goes
  // on scheduling all of them. mail is slowed to two hours; the others still
  // tick at the default and still rewrite the file.
  withFeatureOverride(t, home, {
    bridges: false,
    connectors: Object.fromEntries(
      CONNECTOR_NAMES.filter((name) => name !== 'matrix' && name !== 'mail')
        .map((name) => [name, false])
    ),
  });
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'config.json'),
    JSON.stringify({ intervals: { mail: 7_200 } })
  );
  // No queue: the live registry is the only evidence, and it says mail alone.
  writeActivity(home, 'ok');
  assert.equal(daemonActivityFreshMs({ home }), 2 * 7_200 * 1000,
    'with nothing else to go on, the live registry still decides');

  // The daemon's own queue names imessage, which the override says is off. It
  // is ticking at the default, so the window must come back to the default --
  // not stay at four hours on the strength of a file the daemon never re-read.
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'activity.json'),
    JSON.stringify({
      phase: 'waiting',
      registryState: 'ok',
      queue: [{ connector: 'imessage', nextTs: Date.now() + 60_000 }],
    })
  );
  assert.equal(daemonActivityFreshMs({ home }), DAEMON_ACTIVITY_FRESH_MS,
    'a connector the daemon is still scheduling cannot be argued away by the override');

  // And a queue entry that is not a connector cannot invent a cadence.
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'activity.json'),
    JSON.stringify({
      phase: 'waiting',
      registryState: 'ok',
      queue: [{ connector: 'maintenance', nextTs: Date.now() + 60_000 }],
    })
  );
  assert.equal(daemonActivityFreshMs({ home }), 2 * 7_200 * 1000,
    'maintenance rides the same map and is not a connector');
});

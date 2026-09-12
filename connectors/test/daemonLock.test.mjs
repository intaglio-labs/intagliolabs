import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock, defaultDaemonLockPath } from '../daemon.mjs';
import { daemonLockIsLive } from '../lib/daemonLock.mjs';
// A NAMESPACE IMPORT for everything added since, deliberately: a named import of
// an export the module does not have yet is a LINK error, and that fails this
// whole file with one unhelpful line instead of letting each assertion below say
// what it actually found.
import * as daemonLock from '../lib/daemonLock.mjs';
const forgetProcessStart = (...args) => daemonLock.forgetProcessStart(...args);
const processStartedAt = (...args) => daemonLock.processStartedAt(...args);
const processStartCacheEntry = (...args) => daemonLock.processStartCacheEntry(...args);

const homes = [];
const fakeHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'intaglio-daemon-lock-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true, mode: 0o700 });
  homes.push(home);
  return home;
};
test.after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

test('a live connector daemon keeps the exclusive scheduler lock', () => {
  const home = fakeHome();
  const release = acquireDaemonLock({ home, pid: 101, isAlive: (pid) => pid === 101 });
  assert.equal(typeof release, 'function');
  assert.equal(existsSync(defaultDaemonLockPath(home)), true);
  assert.equal(acquireDaemonLock({ home, pid: 202, isAlive: (pid) => pid === 101 }), null);
  release();
  assert.equal(existsSync(defaultDaemonLockPath(home)), false);
});

test('a stale lock is replaced before a new daemon starts', () => {
  const home = fakeHome();
  const path = defaultDaemonLockPath(home);
  writeFileSync(path, JSON.stringify({ pid: 101, token: 'stale' }) + '\n', { mode: 0o600 });
  const release = acquireDaemonLock({ home, pid: 202, isAlive: () => false });
  assert.equal(typeof release, 'function');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 202);
  release();
});

// ONE DEFINITION OF THE LOCK, READ BY BOTH PACKAGES.
//
// connect/lib/status.mjs carried a byte-for-byte copy of processIsAlive and
// its own inline join() for the path, so the lock's format was described in
// two files and the copy read neither `startedTs` nor `token`. This is the
// tripwire on that: if the daemon ever grows its own private copy again, these
// identities stop matching.
test('the daemon and the connect page share one lock definition', async () => {
  const shared = await import('../lib/daemonLock.mjs');
  const daemon = await import('../daemon.mjs');
  assert.equal(daemon.defaultDaemonLockPath, shared.defaultDaemonLockPath,
    'the daemon re-exports the shared path rather than defining its own');

  const status = await import('../../connect/lib/status.mjs');
  // The freshness window connect derives is expressed in the daemon's own
  // default interval; two numbers that must agree, in two packages.
  assert.equal(status.DEFAULT_INTERVAL_S, daemon.DEFAULT_INTERVAL_S);
  assert.equal(status.DAEMON_ACTIVITY_FRESH_MS, 2 * daemon.DEFAULT_INTERVAL_S * 1000);
});

test('a foreign process holds its lock but never vouches for the daemon', () => {
  const home = fakeHome();
  const startedTs = Date.now();
  writeFileSync(
    defaultDaemonLockPath(home),
    JSON.stringify({ pid: 4242, token: 'ab'.repeat(32), startedTs }) + '\n',
    { mode: 0o600 }
  );
  // Acquisition must NOT steal a lock it cannot prove is dead...
  assert.equal(acquireDaemonLock({ home, pid: 99, isAlive: () => true }), null);
  // ...while the liveness question answers about OUR daemon, which runs as the
  // owner, so a process the owner may not signal is not it.
  assert.equal(
    daemonLockIsLive({ home, state: () => 'foreign', startedAt: () => startedTs - 1_000 }),
    false
  );
});

// ---------------------------------------------------------- the start-time memo

// A FAILURE IS NOT AN ANSWER, AND MUST NOT BE HELD LIKE ONE.
//
// processStartedAt memoises for ten seconds because it forks `ps` on a request
// path. The catch wrote its `null` into that cache exactly like a real reading,
// so one fork failure or one 2 s timeout reported a LIVE daemon as dead for the
// next ten seconds of requests — and connect's daemonRegistryState answers null
// for every one of them, which is the shelf going quiet about a healthy daemon.
test('a transient ps failure is not cached for as long as a real reading', () => {
  forgetProcessStart();
  let clock = 1_000_000;
  const now = () => clock;
  // A pid that cannot exist: `ps` answers nothing, which is the same shape as a
  // failure, so this exercises the null path without breaking a real process.
  const pid = 2 ** 22;

  assert.equal(processStartedAt(pid, { now }), null);
  clock += 2_000;
  // Past the failure window, this must ask again rather than serve the null.
  // Nothing observable changes about the ANSWER for a dead pid, so the memo
  // itself is what is asserted: a real reading would still be held here.
  const entry = processStartCacheEntry(pid);
  assert.ok(entry, 'the memo still exists; it is the window that changed');
  assert.equal(processStartedAt(pid, { now }), null);
  assert.equal(
    processStartCacheEntry(pid).at,
    clock,
    'a failed reading older than a second must be re-taken, not served'
  );

  // A real reading is still held for the full window.
  forgetProcessStart();
  const self = processStartedAt(process.pid, { now });
  assert.ok(Number.isFinite(self), 'this process has a start time');
  const takenAt = processStartCacheEntry(process.pid).at;
  clock += 5_000;
  assert.equal(processStartedAt(process.pid, { now }), self);
  assert.equal(
    processStartCacheEntry(process.pid).at,
    takenAt,
    'a good reading must not be re-forked five seconds later'
  );
});

// THE CLOCK SEAM HAD NO WAY IN. processStartedAt takes `now`, and the only
// production caller — daemonLockIsLive — passed nothing, so a supervisor that
// kills a daemon and starts another on a recycled pid inside the ten-second
// window read the dead process's start time for the live one.
test('daemonLockIsLive can move the clock the memo runs on', () => {
  const seen = [];
  const home = fakeHome();
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true });
  writeFileSync(
    defaultDaemonLockPath(home),
    JSON.stringify({ pid: process.pid, token: 'x'.repeat(32), startedTs: Date.now() }),
    { mode: 0o600 }
  );
  daemonLockIsLive({
    home,
    now: () => 424_242,
    state: () => 'alive',
    startedAt: (pid, options) => {
      seen.push(options);
      return 1;
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0]?.now, 'function', 'the seam has to reach the memo');
  assert.equal(seen[0].now(), 424_242);
});

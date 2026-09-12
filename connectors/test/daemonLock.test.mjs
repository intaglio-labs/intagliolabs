import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock, defaultDaemonLockPath } from '../daemon.mjs';
import { daemonLockIsLive } from '../lib/daemonLock.mjs';

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

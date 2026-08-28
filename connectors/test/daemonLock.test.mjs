import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock, defaultDaemonLockPath } from '../daemon.mjs';

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

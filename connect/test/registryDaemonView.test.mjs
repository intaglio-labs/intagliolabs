// TWO PROCESSES, ONE REGISTRY, AND THEY CAN DISAGREE.
//
// connectors/daemon.mjs resolves ops/features.json once at module scope; this
// page re-reads it per request. Repair a broken registry under a running daemon
// and the shelf's red line clears and every tile comes back — while the daemon
// still holds ALL_OFF and schedules nothing until it is restarted. The notice
// was then asserting a recovery that had not happened, which is worse than the
// outage it replaced: the owner stops looking.
//
// The daemon writes where it stands into the activity file it already
// maintains, and the status payload carries that beside its own answer. The
// shelf says "restart the app" instead of going quiet.
//
// Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAEMON_ACTIVITY_FRESH_MS, daemonRegistryState } from '../lib/status.mjs';
import { statusResponse } from '../lib/statusApi.mjs';

const TOKEN = 'cd'.repeat(32); // 64 hex chars, deliberately not a real secret

function fakeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'hz-daemon-view-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, 'hermes-token.txt'), `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(join(secrets, 'hermes-token.txt'), 0o600);
  return home;
}

function writeActivity(home, body) {
  const dir = join(home, '.hazlie', 'connectors');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'activity.json'), body);
}

test('no activity file is no claim about the daemon, not an alarm', (t) => {
  const home = fakeHome(t);
  assert.equal(daemonRegistryState({ home }), null,
    'a daemon that has not said where it stands must not paint the shelf red');
  writeActivity(home, 'not json at all');
  assert.equal(daemonRegistryState({ home }), null);
  writeActivity(home, JSON.stringify({ phase: 'waiting', registryState: 'nonesuch' }));
  assert.equal(daemonRegistryState({ home }), null, 'only the three known words count');
});

test('the daemon\'s own answer reaches the page', (t) => {
  const home = fakeHome(t);
  writeActivity(home, JSON.stringify({ phase: 'waiting', queue: [], registryState: 'invalid' }));
  assert.equal(daemonRegistryState({ home }), 'invalid');

  const { status, body } = statusResponse({ authorization: `Bearer ${TOKEN}`, home });
  assert.equal(status, 200);
  // THE DISCRIMINATING PAIR: this page reads a registry that is fine, and the
  // daemon is still running on one that was not. Without the second field the
  // payload says "ok" and the shelf goes quiet on a machine ingesting nothing.
  assert.equal(body.registryState, 'ok');
  assert.equal(body.daemonRegistryState, 'invalid');
  assert.equal(body.overrideState, 'none', 'no override in this fixture home');
});

test('an agreeing daemon adds nothing to say', (t) => {
  const home = fakeHome(t);
  writeActivity(home, JSON.stringify({ phase: 'waiting', queue: [], registryState: 'ok' }));
  const { body } = statusResponse({ authorization: `Bearer ${TOKEN}`, home });
  assert.equal(body.registryState, 'ok');
  assert.equal(body.daemonRegistryState, 'ok');
});

// ---------------------------------------------- and the daemon has to exist

// A FILE OUTLIVES THE PROCESS THAT WROTE IT.
//
// activity.json carries no liveness stamp of its own, so a daemon that exited
// — a missing config is exit 1, and so is a crash or a kill — leaves its last
// registryState behind. If that word was `missing` or `invalid`, the shelf then
// told the owner FOREVER that "the connector service is still running on the
// old feature registry — restart the app", about a process that is not running
// and that restarting the app does not silence. The whole value of the field is
// that it describes a RUNNING process.

function backdate(home, ms) {
  const path = join(home, '.hazlie', 'connectors', 'activity.json');
  const at = (Date.now() - ms) / 1000;
  utimesSync(path, at, at);
}

function writeLock(home, pid) {
  writeFileSync(
    join(home, '.hazlie', 'connectors', 'daemon.lock'),
    JSON.stringify({ pid, token: 'ab'.repeat(32), startedTs: Date.now() })
  );
}

test('a claim left behind by a daemon that exited is not a claim', (t) => {
  const home = fakeHome(t);
  writeActivity(home, JSON.stringify({ phase: 'waiting', queue: [], registryState: 'invalid' }));
  assert.equal(daemonRegistryState({ home }), 'invalid', 'freshly written, it still counts');

  backdate(home, DAEMON_ACTIVITY_FRESH_MS + 60_000);
  assert.equal(daemonRegistryState({ home }), null,
    'nothing wrote this recently and no daemon is holding the lock: say nothing');
  // AND SPECIFICALLY NOT A FOURTH WORD. connections.js alarms on any
  // daemonRegistryState that is not 'ok', so 'unknown' or 'stale' here would
  // trade a stale alarm for a permanent one.
  const { body } = statusResponse({ authorization: `Bearer ${TOKEN}`, home });
  assert.equal(body.daemonRegistryState, null);
});

test('a daemon that is actually running is believed however old its file is', (t) => {
  // An install with every connector switched off can go a long time without
  // republishing, and it is still the process that will schedule nothing until
  // it is restarted. The lock is the direct evidence, so it wins over the age.
  const home = fakeHome(t);
  writeActivity(home, JSON.stringify({ phase: 'waiting', queue: [], registryState: 'invalid' }));
  backdate(home, DAEMON_ACTIVITY_FRESH_MS * 10);
  writeLock(home, process.pid); // this test process: a pid that is definitely alive
  assert.equal(daemonRegistryState({ home }), 'invalid',
    'the disagreement is real and the owner has a restart to do');
});

test('a lock left by a dead process does not resurrect the claim', (t) => {
  const home = fakeHome(t);
  writeActivity(home, JSON.stringify({ phase: 'waiting', queue: [], registryState: 'missing' }));
  backdate(home, DAEMON_ACTIVITY_FRESH_MS + 60_000);
  // A pid that cannot be running: pid 1 is launchd, and the reader refuses
  // anything below 2 outright rather than asking the kernel about init.
  writeLock(home, 1);
  assert.equal(daemonRegistryState({ home }), null);
  // And a malformed lock is not evidence either.
  writeFileSync(join(home, '.hazlie', 'connectors', 'daemon.lock'), 'not json');
  assert.equal(daemonRegistryState({ home }), null);
});

test('an agreeing daemon that has since exited says nothing rather than ok', (t) => {
  // THE DISCRIMINATING PAIR for "just report a different word when it is
  // stale": the gate is about whether there is anything to report at all, so
  // it has to swallow 'ok' exactly as it swallows 'invalid'. A reader that
  // kept 'ok' would be asserting a healthy daemon on a machine with none.
  const home = fakeHome(t);
  writeActivity(home, JSON.stringify({ phase: 'waiting', queue: [], registryState: 'ok' }));
  backdate(home, DAEMON_ACTIVITY_FRESH_MS + 60_000);
  assert.equal(daemonRegistryState({ home }), null);
});

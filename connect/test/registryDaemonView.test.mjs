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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonRegistryState } from '../lib/status.mjs';
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

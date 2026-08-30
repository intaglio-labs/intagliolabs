// The native bridge runtime has to be reachable, not merely present.
//
// Four commits built it — pinned binaries fetched and hash-checked, libolm built
// from archived source, a Synapse venv on an embedded CPython, and a provisioner
// that runs all eight as ordinary processes. It was verified end to end on
// 2026-08-30: seven bridges plus Synapse with no Docker, three real social
// logins, thousands of messages ingested. And none of it was wired in — build.sh
// copied only the Docker scripts and Provision.swift shelled only the Docker
// provisioner, so the whole thing sat in the tree doing nothing.
//
// These assert the wiring, which is the part that silently rots.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildSh = readFileSync(join(ROOT, 'widget/build.sh'), 'utf8');
const provision = readFileSync(join(ROOT, 'widget/src/Provision.swift'), 'utf8');
const nativeSh = readFileSync(join(ROOT, 'ops/setup-bridges-native.sh'), 'utf8');

test('every script the native path needs ships in the bundle', () => {
  for (const f of ['setup-bridges-native.sh', 'build-libolm.sh', 'build-synapse.sh', 'fetch-bridges.mjs']) {
    assert.ok(buildSh.includes(f), `${f} is never copied into the app`);
  }
  // A copied-but-not-executable script fails at spawn with a permission error
  // that reads like something else entirely.
  for (const f of ['setup-bridges-native.sh', 'build-libolm.sh', 'build-synapse.sh']) {
    assert.match(buildSh, new RegExp(`chmod[\\s\\S]{0,200}${f.replace(/\./gu, '\\.')}`, 'u'),
      `${f} ships without an executable bit`);
  }
});

test('the Docker provisioner still ships as the fallback', () => {
  // The native path needs libolm built from archived source and ~305MB fetched;
  // a machine where either fails must still have a way through, and an install
  // already running containers must keep working.
  assert.ok(buildSh.includes('setup-bridges.sh'), 'the Docker script must remain');
});

test('Provision chooses by artifact, never by preference', () => {
  assert.match(provision, /setup-bridges-native\.sh/u, 'the native provisioner must be reachable');
  // .ready is written LAST by build-synapse.sh precisely so a half-built runtime
  // is distinguishable from a good one. Testing the directory would defeat that.
  assert.match(provision, /bridges\/synapse\/\.ready/u,
    'the choice must gate on the completion marker, not on a directory');
  assert.match(provision, /useNative[\s\S]{0,120}setup-bridges\.sh/u,
    'Docker must remain the fallback branch');
});

test('the native configs satisfy the hardening the Docker path is held to', () => {
  // checkBridgeHardening FAILs anything lower, and logging.min_level is a
  // privacy setting: its own words are "debug logs may contain message bodies".
  assert.match(nativeSh, /max_initial_messages = 2147483647/u, 'history must be uncapped');
  assert.match(nativeSh, /max_catchup_messages = 2147483647/u);
  assert.match(nativeSh, /logging\.min_level = \\"info\\"/u, 'logs must not record message bodies');
  assert.match(nativeSh, /forward_limits\.missed\.dm = -1/u, 'legacy bridge limits too');
});

test('native appservices bind loopback, which the container path could not', () => {
  // A container must bind every interface to be reachable across the compose
  // network; a native process does not, so seven listeners stop being reachable
  // from the LAN.
  assert.match(nativeSh, /appservice\.hostname = \\"127\.0\.0\.1\\"/u);
  assert.doesNotMatch(nativeSh, /appservice\.hostname = \\"0\.0\.0\.0\\"/u);
});

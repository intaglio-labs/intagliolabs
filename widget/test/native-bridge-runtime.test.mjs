// The native bridge runtime has to be reachable, not merely present.
//
// Four commits built it — pinned binaries fetched and hash-checked, libolm built
// from archived source, a Synapse venv on an embedded CPython, and a provisioner
// that runs all eight under launchd. It was verified end to end on 2026-08-30:
// seven bridges plus Synapse with no Docker, three real social logins, thousands
// of messages ingested. And none of it was wired in — build.sh copied only the
// Docker scripts and Provision.swift shelled only the Docker provisioner, so the
// whole thing sat in the tree doing nothing.
//
// It is now the ONLY path. Docker is deleted, so the tests that pinned the
// fallback's existence and ordering are gone; what replaces them is the check
// that nothing still reaches for it, and that the stack is supervised — with no
// container runtime underneath, `restart: unless-stopped` is not there to catch
// a crash any more.
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

test('nothing reaches for the container path any more', () => {
  assert.ok(!buildSh.includes('ops/setup-bridges.sh'),
    'build.sh must not copy a script that no longer exists');
  assert.ok(!provision.includes('setup-bridges.sh"'),
    'Provision must not name the deleted provisioner');
  assert.match(provision, /let scripts = \[nativeScript\]/u,
    'there is one provisioner, and the list should say so');
  for (const word of ['docker compose', 'dock.mau.dev', 'ghcr.io']) {
    assert.ok(!nativeSh.includes(word), `the native script still mentions ${word}`);
  }
});

test('the stack is supervised, because nothing else is left to do it', () => {
  // This script's header said "WHAT THIS DOES NOT DO: supervise" and that was
  // survivable only while Compose's `restart: unless-stopped` sat underneath.
  // A crashed bridge now stops that platform until launchd restarts it.
  assert.ok(buildSh.includes('io.intaglio.synapse.plist'), 'the synapse agent must ship');
  assert.ok(buildSh.includes('io.intaglio.bridge.plist'), 'the bridge agent template must ship');
  assert.match(nativeSh, /launchctl bootstrap/u, 'agents must actually be loaded');
  // COMMENTS STRIPPED FIRST. The script explains at length what it replaced,
  // and the word "nohup" appears in that explanation -- so matching the raw
  // file asserts the presence of a comment, not the absence of a behaviour.
  // That is the same mistake this branch has now made six times.
  const code = nativeSh.split('\n').filter((l) => !/^\s*#/u.test(l)).join('\n');
  assert.doesNotMatch(code, /\bnohup\b/u, 'an unsupervised child is what this replaced');
  // NOT "no pidfile anywhere" -- that was the first version of this assertion
  // and it was wrong: the script must still READ the old ones to retire an
  // install provisioned before launchd owned these processes. What must never
  // happen again is WRITING one, which is how the stack came to be untracked.
  assert.doesNotMatch(code, /echo \$! ?>/u, 'nothing may record a pid of its own');
  assert.match(code, /retire_pidfile_era/u,
    'the pre-launchd processes must be retired, or they keep the ports');
  for (const plist of ['io.intaglio.synapse.plist', 'io.intaglio.bridge.plist']) {
    const text = readFileSync(join(ROOT, 'ops', plist), 'utf8');
    assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/u, `${plist} must restart on crash`);
    assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/u, `${plist} must come back after a reboot`);
    assert.match(text, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/u,
      `${plist} without a throttle turns a broken config into a hot loop`);
  }
});

test('the native script can reach a working state by itself', () => {
  // There is no fallback left, so "it bootstraps itself" is the whole contract:
  // a first run on a stock Mac has no toolchain, and needs none.
  assert.match(nativeSh, /fetch-bridges\.mjs/u, 'it must fetch the binaries');
  assert.match(nativeSh, /build-synapse\.sh/u, 'and build the homeserver runtime');
  assert.match(nativeSh, /bridges\/lib\/libolm\.3\.dylib/u,
    'and take the libolm the bundle ships, since a stock Mac has no cmake');
});

test('the native configs satisfy the hardening checkBridgeHardening demands', () => {
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

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
import { existsSync, readFileSync } from 'node:fs';
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

test('the stack is supervised, by ONE agent that is honestly ours', () => {
  // This script's header said "WHAT THIS DOES NOT DO: supervise" and that was
  // survivable only while Compose's `restart: unless-stopped` sat underneath.
  // The first fix installed eight launchd agents, which supervised correctly
  // and put eight entries in the owner's Login Items naming binaries they never
  // installed: AssociatedBundleIdentifiers is only honoured when the job's
  // program shares a TEAM with the bundle it names, and the mautrix binaries
  // and Synapse's CPython are ad-hoc with no team at all.
  assert.ok(buildSh.includes('io.intaglio.bridges.plist'), 'the agent must ship');
  assert.ok(buildSh.includes('bridge-supervisor.mjs'), 'so must the supervisor it runs');
  const plist = readFileSync(join(ROOT, 'ops', 'io.intaglio.bridges.plist'), 'utf8');
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u, 'it must restart on crash');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u, 'and come back after a reboot');
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/u,
    'without a throttle a broken config is a hot loop');

  // THE POINT OF THE REWRITE: the agent's program must be the node we sign, not
  // a third-party binary. That team match is the whole reason this groups under
  // the app instead of announcing each bridge by filename.
  assert.match(plist, /<string>@HOME@\/\.hazlie\/bin\/node<\/string>/u,
    'the agent must run the signed node, or Login Items names the executable');
  // XML COMMENTS STRIPPED. The plist explains what it supervises, so "mautrix"
  // appears in its prose -- matching the raw file asserts the absence of a
  // sentence, not of a job program. Seventh time on this branch.
  const keys = plist.replace(/<!--[\s\S]*?-->/gu, '');
  assert.doesNotMatch(keys, /mautrix|synapse\.app/u,
    'no ad-hoc binary may be a launchd job program');

  // And exactly one agent, or the problem comes straight back.
  assert.ok(!existsSync(join(ROOT, 'ops', 'io.intaglio.bridge.plist')),
    'the per-bridge template must be gone');
  assert.ok(!existsSync(join(ROOT, 'ops', 'io.intaglio.synapse.plist')),
    'the per-synapse template must be gone');
});

test('the supervisor restarts children, with a floor on the rate', () => {
  const sup = readFileSync(join(ROOT, 'ops', 'bridge-supervisor.mjs'), 'utf8');
  assert.match(sup, /RESTART_FLOOR_MS = 60_000/u,
    'a process that cannot start must not respawn as fast as the loop allows');
  assert.match(sup, /child\.on\('exit'/u, 'a crashed child must be noticed');
  assert.match(sup, /process\.on\('SIGTERM'/u,
    'children are not in their own process group; a stop must be forwarded');
  assert.match(sup, /cwd,/u,
    "mautrix's relative log path needs a working directory or every bridge exits");
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

// The bridge-hardening probe, tested for the thing that matters: that it FIRES.
//
// What the bridges do with your message history is a published claim either
// way, and it lives in a GITIGNORED config file that bridges/README.md says to
// reapply by hand after any regeneration. This probe is what turns that from
// hopeful into checked, so a probe that silently passed would be worse than
// none: it would look like coverage. Every case below is a negative.
//
// Owner decision, Austin 2026-08-22: "all connections should pull bulk
// messages". So backfill ON is what these assert. The first version of this
// file asserted the opposite -- it enforced bridges/README.md's hardening,
// which the owner had not agreed to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBridgeHardening } from '../lib/checks.mjs';

// A home whose ~/.hazlie/matrix/<bridge>/config.yaml holds `body`.
function fakeHome(configs) {
  const home = mkdtempSync(join(tmpdir(), 'hazlie-bridge-'));
  for (const [bridge, body] of Object.entries(configs)) {
    const dir = join(home, '.hazlie', 'matrix', bridge);
    mkdirSync(dir, { recursive: true });
    if (body !== null) writeFileSync(join(dir, 'config.yaml'), body);
  }
  return home;
}

const CONFIGURED = `homeserver:
    address: http://synapse:8008
    domain: hazlie.local
    presence: false
appservice:
    as_token: SECRET_AS_TOKEN_SHOULD_NEVER_BE_REPORTED
    hs_token: SECRET_HS_TOKEN_SHOULD_NEVER_BE_REPORTED
backfill:
    enabled: true
    max_initial_messages: 2147483647
    max_catchup_messages: 2147483647
    threads:
        max_initial_messages: 2147483647
double_puppet:
    secrets: {}
logging:
    min_level: info
`;

const homes = [];
const withHome = (configs) => {
  const h = fakeHome(configs);
  homes.push(h);
  return h;
};
test.after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

test('a bridge matching owner intent passes', () => {
  const r = checkBridgeHardening(withHome({ meta: CONFIGURED }));
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /1 bridge config/u);
});

test('backfill DISABLED is a FAIL — the owner wants bulk history pulled', () => {
  const r = checkBridgeHardening(
    withHome({ meta: CONFIGURED.replace('enabled: true', 'enabled: false') })
  );
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /backfill\.enabled is false/u);
  assert.match(r.fix, /ops\/setup-bridges-native\.sh/u);
});

test('an enabled bridge with the old 10k cap still fails maximum-history policy', () => {
  const r = checkBridgeHardening(withHome({
    meta: CONFIGURED.replace('max_initial_messages: 2147483647', 'max_initial_messages: 10000'),
  }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /history is capped/u);
  assert.match(r.detail, /initial=10000/u);
});

test('a MISSING backfill key is reported, not assumed either way', () => {
  // The regeneration case the probe exists for: a fresh config.yaml carries no
  // decision at all. Absence must not read as agreement in either direction —
  // it is reported so a human sets it deliberately.
  const r = checkBridgeHardening(withHome({ meta: 'homeserver:\n    domain: hazlie.local\n' }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /backfill\.enabled is unset/u);
});

// mautrix-discord is the older bridge generation: no top-level `backfill:` at
// all, a per-chat-type message limit four levels down, and 0 meaning off. A
// two-level lookup reported it as unconfigured whatever its config said, which
// is a guard answering confidently about a file it could not read.
const DISCORD_LEGACY = `bridge:
    startup_private_channel_create_limit: 2147483647
    backfill:
        forward_limits:
            initial:
                dm: 2147483647
                channel: 2147483647
                thread: 2147483647
            missed:
                dm: -1
                channel: -1
                thread: -1
homeserver:
    presence: false
double_puppet:
    secrets: {}
logging:
    min_level: info
`;

test('discord’s legacy nested backfill layout is understood', () => {
  const r = checkBridgeHardening(withHome({ discord: DISCORD_LEGACY }));
  assert.equal(r.status, 'PASS');
});

test('discord with dm limit 0 is off, and says so in its own terms', () => {
  const r = checkBridgeHardening(
    withHome({ discord: DISCORD_LEGACY.replace('dm: 2147483647', 'dm: 0') })
  );
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /forward_limits\.initial\.dm is 0/u);
  assert.match(r.detail, /history is NOT being pulled/u);
});

test('discord is not maximum-history when any channel lane remains capped', () => {
  const r = checkBridgeHardening(withHome({
    discord: DISCORD_LEGACY.replace('channel: 2147483647', 'channel: 10000'),
  }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /history is capped/u);
});

test('discord is not maximum-history when startup creates only five private portals', () => {
  const r = checkBridgeHardening(withHome({
    discord: DISCORD_LEGACY.replace(
      'startup_private_channel_create_limit: 2147483647',
      'startup_private_channel_create_limit: 5'
    ),
  }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /private_portals=5/u);
  assert.match(r.detail, /history is capped/u);
});

test('a config with neither layout is reported, not assumed on', () => {
  const r = checkBridgeHardening(withHome({ mystery: 'homeserver:\n    presence: false\n' }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /history is NOT being pulled/u);
});

test('double puppeting turned on is a WARN — it could act as the owner', () => {
  // The one setting that actually governs whether read state can reach the
  // remote account. WARN not FAIL: it does not lose history, it changes
  // footprint.
  const r = checkBridgeHardening(
    withHome({
      meta: CONFIGURED.replace('secrets: {}', 'secrets:\n        hazlie.local: as_token:abc'),
    })
  );
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /double_puppet/u);
  assert.match(r.detail, /act as the owner/u);
});

test('debug bridge logging is a FAIL because request bodies can contain messages', () => {
  const r = checkBridgeHardening(
    withHome({ meta: CONFIGURED.replace('min_level: info', 'min_level: debug') })
  );
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /debug logs may contain message bodies/u);
  assert.match(r.fix, /logging\.min_level stays at info/u);
});

test('homeserver.presence is NOT checked — the key does not exist in these bridges', () => {
  // Guard against re-adding it. bridges/README.md tells you to set
  // homeserver.presence = false; verified 2026-08-22 that no bridge version
  // here has that key, and each drops it on the config rewrite it does at
  // startup. Warning about it produced a WARN nobody could ever clear, and a
  // check that cannot be satisfied trains people to ignore the ones beside it.
  const r = checkBridgeHardening(withHome({ meta: CONFIGURED }));
  assert.equal(r.status, 'PASS');
  assert.equal(/presence/u.test(r.detail), false);
});

test('every bridge is checked, not just the first', () => {
  const r = checkBridgeHardening(
    withHome({
      meta: CONFIGURED,
      instagram: CONFIGURED,
      twitter: CONFIGURED.replace('enabled: true', 'enabled: false'),
    })
  );
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /twitter/u);
});

test('the detail never quotes the config body — it holds tokens and cookies', () => {
  const r = checkBridgeHardening(
    withHome({ meta: CONFIGURED.replace('enabled: true', 'enabled: false') })
  );
  const said = `${r.detail} ${r.fix ?? ''}`;
  assert.equal(said.includes('SECRET_AS_TOKEN'), false);
  assert.equal(said.includes('SECRET_HS_TOKEN'), false);
});

test('a commented-out setting does not count as set', () => {
  const r = checkBridgeHardening(
    withHome({ meta: CONFIGURED.replace('    enabled: true', '    # enabled: true') })
  );
  assert.equal(r.status, 'FAIL');
});

test('no bridges configured is a pass, not a failure', () => {
  const r = checkBridgeHardening(withHome({}));
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /no bridge configs/u);
});

test('a bridge directory with no config.yaml yet is not counted', () => {
  const r = checkBridgeHardening(withHome({ meta: null }));
  assert.equal(r.status, 'PASS');
});

test('the probe never throws, whatever it finds', () => {
  assert.doesNotThrow(() => checkBridgeHardening(join(tmpdir(), 'definitely-not-a-home-xyz')));
  assert.doesNotThrow(() => checkBridgeHardening(withHome({ meta: '\0\0not yaml at all' })));
});

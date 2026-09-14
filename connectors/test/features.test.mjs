// The feature registry: defaults, the owner override, and what the daemon
// derives from both.
//
// The first test here is the one the repackaging plan actually asks for — "a
// test pins each flag so a future session cannot turn one on by accident". It
// reads the SHIPPED ops/features.json, not a fixture, because a fixture would
// pin a copy of the decision rather than the decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_OFF,
  readFeatureRegistry,
  CONNECTOR_FEATURE_NAMES,
  DEFAULT_REGISTRY_PATH,
  FEATURE_NAMES,
  connectorsDisabledBy,
  defaultOverridePath,
  enabledFeatureNames,
  mergeFeatures,
  optionalConnectors,
  parseRegistry,
  readFeatures,
} from '../lib/features.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempHome(overrideBody) {
  const home = mkdtempSync(join(tmpdir(), 'hz-features-'));
  if (overrideBody !== undefined) {
    mkdirSync(join(home, '.hazlie'), { recursive: true });
    writeFileSync(defaultOverridePath(home), overrideBody);
  }
  return home;
}

// --- the defaults, pinned ------------------------------------------------

// THE WHOLE POINT OF STAGE 1. Every surface the reconnection card does not need
// is off, and this test fails the moment one of them is true again. It is
// deliberately written as "none of these may be true" rather than as a deepEqual
// against a copied object: a deepEqual also fails when somebody ADDS a flag,
// which is not the thing worth stopping.
test('no non-card feature ships switched on', () => {
  const shipped = readFeatures({
    registryPath: DEFAULT_REGISTRY_PATH,
    overridePath: join(tempHome(), '.hazlie', 'features.json'), // no override
  });
  for (const name of FEATURE_NAMES) {
    assert.equal(shipped[name], false,
      `the "${name}" feature ships ON — stage 1 says every one of these defaults off`);
  }
});

// The card's own sources are the other half of the same decision: turning one of
// THESE off silently would starve the card, and this pins that direction too.
test('the sources the card is built from ship on, and the rest do not', () => {
  const shipped = readFeatures({ overridePath: join(tempHome(), 'none.json') });
  for (const name of ['imessage', 'mail', 'calendar', 'contacts', 'linkedin']) {
    assert.equal(shipped.connectors[name], true, `${name} is a participant source the card reads`);
  }
  for (const name of ['whatsapp', 'granola']) {
    assert.equal(shipped.connectors[name], 'optional',
      `${name} is offered, not required — and 'optional' is not a boolean in disguise`);
  }
  for (const name of ['notes', 'files', 'photos', 'notion', 'oura', 'health']) {
    assert.equal(shipped.connectors[name], false, `${name} is content-only or non-person`);
  }
});

test('the shipped registry names every key the loader knows about', () => {
  const shipped = parseRegistry(readFileSync(DEFAULT_REGISTRY_PATH, 'utf8'));
  assert.deepEqual(Object.keys(shipped.connectors).sort(), [...CONNECTOR_FEATURE_NAMES].sort());
  for (const name of FEATURE_NAMES) assert.equal(typeof shipped[name], 'boolean');
});

// --- failing closed ------------------------------------------------------

test('an unreadable registry is everything off, never everything on', () => {
  const problems = [];
  const got = readFeatures({
    registryPath: join(tempHome(), 'no-such-file.json'),
    overridePath: join(tempHome(), 'none.json'),
    onProblem: (r) => problems.push(r),
  });
  assert.deepEqual(got, ALL_OFF);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /everything is off/u);
});

test('a registry with the wrong version is everything off', () => {
  const home = tempHome();
  const bad = join(home, 'v2.json');
  writeFileSync(bad, JSON.stringify({ version: 2, features: { chat: true } }));
  const got = readFeatures({ registryPath: bad, overridePath: join(home, 'none.json') });
  assert.deepEqual(got, ALL_OFF);
});

test('a key the shipped registry forgot reads as off, not undefined', () => {
  const parsed = parseRegistry(JSON.stringify({ version: 1, features: { chat: true } }));
  assert.equal(parsed.chat, true);
  assert.equal(parsed.voice, false, 'an omitted feature must be false, not undefined');
  assert.equal(parsed.connectors.imessage, false, 'and so must an omitted connector');
});

// --- the owner override --------------------------------------------------

test('a partial override flips one flag and leaves the rest alone', () => {
  const home = tempHome(JSON.stringify({ chat: true }));
  const got = readFeatures({ overridePath: defaultOverridePath(home) });
  assert.equal(got.chat, true, 'the override must win over the shipped file');
  assert.equal(got.voice, false, 'and must not disturb a flag it did not mention');
  assert.equal(got.bridges, false);
  assert.equal(got.connectors.imessage, true, 'nor any connector');
  assert.equal(got.connectors.whatsapp, 'optional');
});

test('a partial override may change one connector without listing the others', () => {
  const home = tempHome(JSON.stringify({ connectors: { notes: true } }));
  const got = readFeatures({ overridePath: defaultOverridePath(home) });
  assert.equal(got.connectors.notes, true);
  assert.equal(got.connectors.photos, false);
  assert.equal(got.connectors.whatsapp, 'optional');
});

test('an unknown key is rejected with a message that names it', () => {
  assert.throws(() => mergeFeatures(ALL_OFF, { chatt: true }), /unknown feature "chatt"/u);
  assert.throws(() => mergeFeatures(ALL_OFF, { connectors: { slack: true } }),
    /unknown connector "slack"/u);
  assert.throws(() => mergeFeatures(ALL_OFF, { chat: 'yes' }),
    /feature "chat" must be true or false/u);
  assert.throws(() => mergeFeatures(ALL_OFF, { connectors: { notes: 'maybe' } }),
    /connector "notes" must be true, false or "optional"/u);
  assert.throws(() => mergeFeatures(ALL_OFF, { connectors: [] }),
    /"connectors" must be an object/u);
});

// AND THE REJECTION IS NOT FATAL. ~/.hazlie/connectors/config.json's closed-key
// assertion once killed the connector daemon outright on one unknown key. A
// developer's local override file must not be able to do that: the bad override
// is dropped, the SHIPPED registry still applies, and the reason is reported.
test('a bad override is discarded, the shipped registry survives, and it says why', () => {
  const home = tempHome(JSON.stringify({ chatt: true }));
  const problems = [];
  const got = readFeatures({
    overridePath: defaultOverridePath(home),
    onProblem: (r) => problems.push(r),
  });
  assert.equal(got.connectors.imessage, true, 'the shipped registry must still be in force');
  assert.equal(got.chat, false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /override ignored: unknown feature "chatt"/u);
});

test('an override that is not JSON at all is discarded the same way', () => {
  const home = tempHome('{ not json');
  const problems = [];
  const got = readFeatures({
    overridePath: defaultOverridePath(home),
    onProblem: (r) => problems.push(r),
  });
  assert.equal(got.connectors.imessage, true);
  assert.equal(problems.length, 1);
});

test('a missing override is silent — it is the normal case, not a problem', () => {
  const problems = [];
  readFeatures({
    overridePath: join(tempHome(), 'absent.json'),
    onProblem: (r) => problems.push(r),
  });
  assert.deepEqual(problems, []);
});

test('an override may carry a version field without being rejected for it', () => {
  const home = tempHome(JSON.stringify({ version: 1, voice: true }));
  const got = readFeatures({ overridePath: defaultOverridePath(home) });
  assert.equal(got.voice, true);
});

// --- what the daemon derives --------------------------------------------

const DAEMON_NAMES = [
  'imessage', 'calendar', 'mail', 'granola', 'oura', 'photos', 'notes',
  'contacts', 'notion', 'files', 'whatsapp', 'matrix', 'linkedin',
];

test('false connectors are disabled and optional ones are not', () => {
  const shipped = readFeatures({ overridePath: join(tempHome(), 'none.json') });
  const disabled = connectorsDisabledBy(shipped, DAEMON_NAMES);
  for (const name of ['oura', 'photos', 'notes', 'notion', 'files']) {
    assert.ok(disabled.includes(name), `${name} is dormant and must never be scheduled`);
  }
  // THE DISCRIMINATING HALF. 'optional' and false are different states, and a
  // loader that collapsed them would disable WhatsApp and Granola permanently —
  // the owner's Connect press would then have nothing to turn on.
  for (const name of ['whatsapp', 'granola']) {
    assert.ok(!disabled.includes(name),
      `${name} is 'optional', which means offered — not disabled`);
  }
  assert.deepEqual([...optionalConnectors(shipped, DAEMON_NAMES)].sort(), ['granola', 'whatsapp']);
  for (const name of ['imessage', 'mail', 'calendar', 'contacts', 'linkedin']) {
    assert.ok(!disabled.includes(name), `${name} is what the card is built from`);
  }
});

// MATRIX IS THE BRIDGES FEATURE, and it has no connector key of its own. A
// registry read that forgot this leaves the daemon polling a Synapse that
// provisioning no longer installs.
test('the matrix connector follows the bridges feature, not a connector key', () => {
  const off = readFeatures({ overridePath: join(tempHome(), 'none.json') });
  assert.ok(connectorsDisabledBy(off, DAEMON_NAMES).includes('matrix'),
    'bridges is off, so the Matrix bus must not be polled');

  const home = tempHome(JSON.stringify({ bridges: true }));
  const on = readFeatures({ overridePath: defaultOverridePath(home) });
  assert.ok(!connectorsDisabledBy(on, DAEMON_NAMES).includes('matrix'),
    'turning bridges on must bring its transport back with it');
});

test('a connector module with no registry entry is left alone, not switched off', () => {
  const shipped = readFeatures({ overridePath: join(tempHome(), 'none.json') });
  assert.ok(!connectorsDisabledBy(shipped, ['somethingNew']).includes('somethingNew'),
    'silently disabling a source somebody added is worse than listing it');
});

// --- logging -------------------------------------------------------------

test('the startup log carries names only, and marks the optional ones', () => {
  const shipped = readFeatures({ overridePath: join(tempHome(), 'none.json') });
  const names = enabledFeatureNames(shipped);
  assert.deepEqual(names, [
    'connector:imessage', 'connector:mail', 'connector:calendar',
    'connector:contacts', 'connector:linkedin',
    'connector:whatsapp?', 'connector:granola?',
  ]);
  for (const entry of names) assert.equal(typeof entry, 'string');
});

test('the registry resolves at the same relative path a bundle would use', () => {
  assert.equal(DEFAULT_REGISTRY_PATH, join(ROOT, 'ops', 'features.json'));
});

// --- numeric booleans ----------------------------------------------------

// `{"chat": 1}` IS NOT `{"chat": true}`, in either loader.
//
// JSON has a boolean type and this file requires it. The app's loader used
// `value as? Bool`, which accepts NSNumber 1 and 0 — so one override file
// switched chat ON in the app while the whole override was thrown away here,
// leaving hermes and the daemon reporting it off. Two processes, one file, two
// answers. Features.swift now checks CFBooleanGetTypeID; this is the node half
// of the same rule, said out loud so nobody relaxes it to `!!value`.
test('a numeric 1 or 0 is not a boolean, and takes the whole override down with it', () => {
  assert.throws(() => mergeFeatures(ALL_OFF, { chat: 1 }), /feature "chat" must be true or false/u);
  assert.throws(() => mergeFeatures(ALL_OFF, { chat: 0 }), /feature "chat" must be true or false/u);
  assert.throws(() => mergeFeatures(ALL_OFF, { connectors: { notes: 1 } }),
    /connector "notes" must be true, false or "optional"/u);
  assert.throws(() => mergeFeatures(ALL_OFF, { chat: 'true' }), /feature "chat"/u);
  // The discriminating half: a real boolean still works, and so does 'optional'.
  assert.equal(mergeFeatures(ALL_OFF, { chat: true }).chat, true);
  assert.equal(mergeFeatures(ALL_OFF, { connectors: { notes: true } }).connectors.notes, true);
  assert.equal(
    mergeFeatures(ALL_OFF, { connectors: { whatsapp: 'optional' } }).connectors.whatsapp,
    'optional'
  );

  // And a rejected override leaves the SHIPPED registry standing, rather than
  // failing all the way to ALL_OFF.
  const home = tempHome(JSON.stringify({ chat: 1 }));
  const problems = [];
  const features = readFeatures({
    overridePath: defaultOverridePath(home),
    onProblem: (reason) => problems.push(reason),
  });
  assert.equal(features.chat, false);
  assert.equal(features.connectors.imessage, true, 'the registry survives its override being wrong');
  assert.match(problems.join('\n'), /features override ignored: feature "chat"/u);
});

// --- why the answer is all-off -------------------------------------------

// A MISSING REGISTRY AND A BROKEN ONE ARE BOTH TOTAL OUTAGES, and neither used
// to be distinguishable downstream from an install where nothing is connected.
test('the registry says whether it was read, missing, or unreadable', () => {
  const home = tempHome();
  const ok = readFeatureRegistry({ overridePath: join(home, 'none.json') });
  assert.equal(ok.registryState, 'ok');
  assert.equal(ok.features.connectors.imessage, true);

  const missing = readFeatureRegistry({
    registryPath: join(home, 'no-such-features.json'),
    overridePath: join(home, 'none.json'),
  });
  assert.equal(missing.registryState, 'missing');
  assert.deepEqual(missing.features, ALL_OFF, 'and it is still everything off');

  const badPath = join(home, 'broken.json');
  writeFileSync(badPath, '{"version": 1, "features": {"nonesuch": true}}');
  const invalid = readFeatureRegistry({
    registryPath: badPath,
    overridePath: join(home, 'none.json'),
  });
  assert.equal(invalid.registryState, 'invalid');
  assert.deepEqual(invalid.features, ALL_OFF);

  writeFileSync(badPath, 'not json at all');
  assert.equal(
    readFeatureRegistry({ registryPath: badPath, overridePath: join(home, 'none.json') }).registryState,
    'invalid'
  );

  // A BAD OVERRIDE IS NOT A BAD REGISTRY. The registry was read; something the
  // owner wrote was ignored. Reporting that as an outage would send them to
  // reinstall over a typo in a file they are invited to edit.
  const withBadOverride = tempHome('{"nonesuch": true}');
  assert.equal(
    readFeatureRegistry({ overridePath: defaultOverridePath(withBadOverride) }).registryState,
    'ok'
  );
});

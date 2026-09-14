// THE ESCAPE HATCH HAS TO SAY WHEN IT MISSED.
//
// HAZLIE_FEATURES_OVERRIDE is the one knob a test — or a developer on a machine
// that cannot be rebuilt today — is allowed to turn, and it had two ways to do
// nothing quietly:
//
//   * `HAZLIE_FEATURES_OVERRIDE=` (empty), which is the spelling a CI wrapper
//     produces from an unset variable, fell through to the DEVELOPER'S
//     ~/.hazlie/features.json — un-hermeticizing precisely the tests that
//     variable exists to make hermetic;
//   * a typo'd path threw into the same catch as "no override here, which is
//     normal", so the loader reported a clean read of a file it never opened.
//
// So: empty means none, and a CONFIGURED override that cannot be read is
// reported — as `overrideState`, and through onProblem — while `registryState`
// stays what the SHIPPED registry deserves. A bad override is not a broken
// bundle and must never send the owner to reinstall over their own typo.
//
// Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_REGISTRY_PATH,
  defaultOverridePath,
  readFeatureRegistry,
  readFeatures,
} from '../lib/features.mjs';
import { featureRegistryStatus } from '../../connect/lib/status.mjs';

function homeWithOverride(t, body) {
  const home = mkdtempSync(join(tmpdir(), 'hz-override-state-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.hazlie'), { recursive: true });
  if (body !== undefined) writeFileSync(join(home, '.hazlie', 'features.json'), body);
  return home;
}

// THE DISCRIMINATING PAIR. The same fixture home holds an override that flips
// `bridges` on. Under `=none` and under `=` the answer must be the SHIPPED
// false; only an absent variable may fall through to the home file.
test('an empty HAZLIE_FEATURES_OVERRIDE is "no override", exactly like none', (t) => {
  const home = homeWithOverride(t, '{"bridges": true}');
  const path = join(home, '.hazlie', 'features.json');

  assert.equal(defaultOverridePath(home, { HAZLIE_FEATURES_OVERRIDE: '' }), null,
    'empty is the spelling a CI wrapper produces from an unset variable');
  assert.equal(defaultOverridePath(home, { HAZLIE_FEATURES_OVERRIDE: 'none' }), null);
  assert.equal(defaultOverridePath(home, {}), path, 'unset still means the owner override');

  assert.equal(
    readFeatures({
      registryPath: DEFAULT_REGISTRY_PATH,
      overridePath: defaultOverridePath(home, { HAZLIE_FEATURES_OVERRIDE: '' }),
    }).bridges,
    false,
    'an empty variable must not read the developer\'s home'
  );
  assert.equal(
    readFeatures({ registryPath: DEFAULT_REGISTRY_PATH, overridePath: defaultOverridePath(home, {}) }).bridges,
    true,
    'and the fixture really does flip bridges on, or the assertion above proves nothing'
  );
});

test('a configured override that is not there is reported, not silently skipped', (t) => {
  const home = homeWithOverride(t);
  const problems = [];
  const got = readFeatureRegistry({
    overridePath: join(home, 'typo.json'),
    overrideConfigured: true,
    onProblem: (reason) => problems.push(reason),
  });
  assert.equal(got.overrideState, 'missing');
  assert.equal(got.registryState, 'ok', 'the SHIPPED registry was read; the owner\'s file was not');
  assert.equal(got.features.connectors.imessage, true, 'and the shipped set still stands');
  assert.equal(problems.length, 1, problems.join('\n'));
});

test('a configured override that will not parse is invalid, and the registry is still ok', (t) => {
  const home = homeWithOverride(t, '{ not json');
  const problems = [];
  const got = readFeatureRegistry({
    overridePath: defaultOverridePath(home),
    onProblem: (reason) => problems.push(reason),
  });
  assert.equal(got.overrideState, 'invalid');
  assert.equal(got.registryState, 'ok');
  assert.equal(problems.length, 1, problems.join('\n'));
});

test('no override at all is "none", and stays silent — it is the normal case', (t) => {
  const home = homeWithOverride(t);
  const problems = [];
  const absent = readFeatureRegistry({
    overridePath: join(home, '.hazlie', 'features.json'),
    onProblem: (reason) => problems.push(reason),
  });
  assert.equal(absent.overrideState, 'none');
  assert.deepEqual(problems, []);

  const declined = readFeatureRegistry({ overridePath: null, onProblem: (r) => problems.push(r) });
  assert.equal(declined.overrideState, 'none');
  assert.deepEqual(problems, []);

  const read = readFeatureRegistry({
    overridePath: defaultOverridePath(homeWithOverride(t, '{"voice": true}')),
  });
  assert.equal(read.overrideState, 'ok');
  assert.equal(read.features.voice, true);
});

// `home` REACHES THE REGISTRY READ. status.mjs threaded `home` through every
// other row builder and then asked the registry with no arguments, so an
// alt-home install — and every temp-home test — was answered out of the
// developer's own ~/.hazlie. The override state is what makes that visible:
// this fixture's override is broken, and only a read that honours `home` can
// know it.
test('the connect status asks the registry about THIS home', (t) => {
  const home = homeWithOverride(t, '{"nonesuch": true}');
  const status = featureRegistryStatus({ home });
  assert.equal(status.registryState, 'ok', 'a bad override is not a broken bundle');
  assert.equal(status.overrideState, 'invalid',
    'read with no home this answers about the developer\'s machine instead');
});

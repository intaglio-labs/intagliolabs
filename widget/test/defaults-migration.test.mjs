// Carrying the owner's settings across the bundle rename.
//
// A source scan, like bridge-capabilities.test.mjs. The behaviour itself is
// verified functionally against real UserDefaults domains; what this pins is the
// part that rots silently — the LIST. UserDefaults is keyed on the bundle
// identifier, which moved from com.hazlie.widget to io.intaglio.widget, so every
// key the app remembers its owner by has to be named here or it is lost on the
// rename. A key added later and not added here fails nowhere: the owner just
// finds one more thing forgotten.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(join(WIDGET, 'src/DefaultsMigration.swift'), 'utf8');
const bridge = readFileSync(join(WIDGET, 'src/Bridge.swift'), 'utf8');
const main = readFileSync(join(WIDGET, 'src/main.swift'), 'utf8');

/// Code only. Several of these files describe the defect being pinned in the
/// comment beside the fix, so a naive scan finds the bug's own description.
const code = (text) => text
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\/\/)/u.test(line))
  .join('\n');

// Every "Hazlie…" defaults key the app actually reads or writes.
function keysBridgeUses() {
  const found = new Set();
  for (const m of bridge.matchAll(/=\s*"(Hazlie[A-Za-z]+)"/gu)) found.add(m[1]);
  return found;
}

test('every remembered setting is named in the carry-over list', () => {
  const used = keysBridgeUses();
  assert.ok(used.size >= 4, `expected several remembered keys, found ${[...used]}`);
  const missing = [...used].filter((k) => !migration.includes(`"${k}"`));
  assert.deepEqual(
    missing,
    [],
    `these keys are read by Bridge but would not survive the rename: ${missing.join(', ')}`
  );
});

test('the previous bundle identifier is the one that actually shipped', () => {
  assert.match(migration, /previousBundleID\s*=\s*"com\.hazlie\.widget"/u);
});

// The two properties that make it safe to call on every launch.
test('it runs once and never overwrites a value this app set', () => {
  assert.match(migration, /migratedKey/u, 'it must record that it ran');
  assert.match(
    migration,
    /if destination\.string\(forKey: migratedKey\) != nil \{ return 0 \}/u,
    'a second pass would put back a value the owner deliberately changed'
  );
  assert.match(
    migration,
    /if destination\.object\(forKey: key\) != nil \{ continue \}/u,
    'a value already set here was set by this app and wins'
  );
});

// Copying the whole domain would drag in Apple's own window-state and WebKit
// keys — inheriting somebody else's bugs along with the settings.
test('it names what it carries rather than copying the domain', () => {
  assert.ok(!/dictionaryRepresentation|persistentDomain\(forName/u.test(migration),
    'the carry-over must be an explicit list, not a bulk copy');
});

test('it runs before anything reads a setting, or writes the file it probes', () => {
  // CODE ONLY. These call sites are described in the comments around them, and
  // a raw scan finds the prose rather than the order — which is how a comment
  // naming the provisioning step can fail a test about the provisioning step.
  const launch = code(main).slice(code(main).indexOf('func applicationDidFinishLaunching'));
  const migrateAt = launch.indexOf('DefaultsMigration.runIfNeeded');
  const provisionAt = launch.indexOf('Provision.ensure');
  assert.ok(migrateAt > 0, 'the migration must run at launch');
  assert.ok(provisionAt < 0 || migrateAt < provisionAt,
    'it must run before provisioning, which reads settings — AND, since the\n' +
    'data-home probe below, before ensureConnectorDefaults() writes the very file\n' +
    'the probe asks about');
});

// TCC cannot be carried and the code must not pretend otherwise.
test('it says plainly what it cannot carry', () => {
  assert.match(migration, /TCC/u, 'the limit belongs in the file, not in a release note alone');
  assert.match(migration, /Full Disk Access|Contacts|Calendar/u);
});

// ------------------------------- the domain that outlived its own data home

// TAKE 1 OF THE FROM-SCRATCH OOBE, 2026-09-14. A `com.hazlie.widget` domain left
// by a pre-rename install met a freshly deleted ~/.hazlie. This file carried
// HazlieOnboarded out of it, the welcome flow never opened, and onboarding is
// the only writer of the owner's card settings — so hermes answered
// `no-cap-configured` for ever and the reconnect card, which is the product,
// never appeared. A defaults domain is a plist in ~/Library/Preferences; it
// outlives any number of deleted data homes, so "they are onboarded" is not a
// fact this file may carry on its own authority.
//
// The behaviour is verified functionally against real UserDefaults domains (see
// the live check in the report). What this pins is the part that rots silently:
// WHICH list each key is in, and that the gate exists at all.
const listOf = (name) => {
  const re = new RegExp(`static let ${name} = \\[([\\s\\S]*?)\\n  \\]`, 'u');
  const m = re.exec(migration);
  assert.ok(m, `${name} not found`);
  return code(m[1]).match(/"([^"]+)"/gu)?.map((s) => s.slice(1, -1)) ?? [];
};

test('a key that asserts setup is finished carries only with the data home', () => {
  const always = listOf('carried');
  const gated = listOf('carriedWithDataHome');

  // The flow's own completion, the scene to resume on, and the connectors
  // introduction. Carrying any of these with no data home skips a screen on a
  // machine where that screen has never produced anything.
  for (const key of ['HazlieOnboarded', 'HazlieOnboardingRevision',
                     'HazlieOnboardingStep', 'HazlieConnectorsIntro']) {
    assert.ok(gated.includes(key), `${key} must not carry without the data home`);
    assert.ok(!always.includes(key), `${key} must not be in the unconditional list`);
  }
  // The undelivered presses travel together or not at all: a launch budget
  // carried without the request it bounds shortens a NEW press's retry ladder.
  for (const key of ['HazlieCardDefaultsPending', 'HazlieCardModePending',
                     'HazlieCardModeLaunches']) {
    assert.ok(gated.includes(key), `${key} is residue of a flow this install re-runs`);
  }
  // A fact about a file that lived in the data home. Without that home it
  // refuses a real export on the strength of one that is gone.
  assert.ok(gated.includes('HazlieUnstampedImports'));

  // ...and the preferences, which describe how the app should LOOK and cost
  // nothing if they are wrong. These carry either way.
  for (const key of ['HazlieScale', 'HazlieMotion', 'HazlieMotionAnyway',
                     'HazlieSounds', 'HazlieMonthsView', 'HazliePerformanceMode',
                     'HazlieKeepMacAwake', 'HazlieHandheld',
                     'NSWindow Frame HazlieWidget']) {
    assert.ok(always.includes(key), `${key} is a preference and must always carry`);
    assert.ok(!gated.includes(key), `${key} must not be withheld from a familiar owner`);
  }
  // No key in both lists: the gated one would then carry unconditionally and
  // the split would be decorative.
  const both = gated.filter((k) => always.includes(k));
  assert.deepEqual(both, [], `named in both lists, so the gate does nothing: ${both.join(', ')}`);
});

test('the gate is a parameter, and the probe is the legacy install\'s own file', () => {
  const run = /static func runIfNeeded\(([\s\S]*?)\) -> Int \{([\s\S]*?)\n  \}/u.exec(migration);
  assert.ok(run, 'runIfNeeded not found');
  assert.match(run[1], /dataHomePresent: Bool/u,
    'the decision is injected, so it can be tested and so the timing is visible');
  assert.match(code(run[2]), /carried \+ \(dataHomePresent \? carriedWithDataHome : \[\]\)/u,
    'one loop over one list, chosen by the gate; two loops drift apart');
  // ~/.hazlie is path-based rather than bundle-keyed, so the pre-rename
  // install's home and this one's are the same directory — and the config file
  // is the thing that install produced.
  assert.match(code(migration), /static var legacyDataHomePresent: Bool/u);
  assert.match(code(migration), /\.hazlie\/connectors\/config\.json/u,
    'the probe must be the file the old install wrote, not a guess at the home');
  // Once is still once. An owner who re-runs onboarding must not have the old
  // answers pushed back over their new ones on the next launch.
  assert.match(code(run[2]), /destination\.set\(sourceName, forKey: migratedKey\)/u);
  const stamp = code(run[2]).indexOf('destination.set(sourceName, forKey: migratedKey)');
  assert.doesNotMatch(code(run[2]).slice(0, stamp), /if dataHomePresent \{[\s\S]*return/u,
    'the stamp must be reached on both paths');
});

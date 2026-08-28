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

test('it runs before anything reads a setting', () => {
  const launch = main.slice(main.indexOf('func applicationDidFinishLaunching'));
  const migrateAt = launch.indexOf('DefaultsMigration.runIfNeeded');
  const provisionAt = launch.indexOf('Provision.ensure');
  assert.ok(migrateAt > 0, 'the migration must run at launch');
  assert.ok(provisionAt < 0 || migrateAt < provisionAt,
    'it must run before provisioning, which reads settings');
});

// TCC cannot be carried and the code must not pretend otherwise.
test('it says plainly what it cannot carry', () => {
  assert.match(migration, /TCC/u, 'the limit belongs in the file, not in a release note alone');
  assert.match(migration, /Full Disk Access|Contacts|Calendar/u);
});

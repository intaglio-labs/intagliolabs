// THE BUNDLE'S IDENTIFIERS MUST MATCH THE FILES BUILD.SH ACTUALLY PRODUCES.
//
// WHY THIS EXISTS. A rename pass swept "Hazlie" -> "Intaglio Labs" across the
// tree on 2026-08-26 and caught two values in Info.plist that are not the
// product's name at all: CFBundleExecutable and CFBundleIconFile. Both name
// FILES. build.sh still wrote the binary to Contents/MacOS/Hazlie and the icon
// to Contents/Resources/Hazlie.icns, so the installed app declared an
// executable that did not exist.
//
// The failure is invisible until launch, and the build reports success all the
// way through — compile, sign, install — because every one of those steps is
// individually fine. What you get is LaunchServices refusing with "The
// application cannot be opened because its executable is missing", after the
// old copy has already been replaced. That is the class this closes: the
// product name may change as often as anyone likes, but these two strings are
// addresses, and an address has to point at something.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const plist = readFileSync(join(WIDGET, 'Info.plist'), 'utf8');
const build = readFileSync(join(WIDGET, 'build.sh'), 'utf8');

const plistValue = (key) => {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'u').exec(plist);
  assert.ok(m, `Info.plist has no ${key}`);
  return m[1];
};

test('CFBundleExecutable names the binary build.sh installs', () => {
  const declared = plistValue('CFBundleExecutable');
  // build.sh: cp build/<name> "$APP/Contents/MacOS/<name>"
  const m = /cp build\/(\S+) "\$APP\/Contents\/MacOS\/([^"]+)"/u.exec(build);
  assert.ok(m, 'build.sh no longer copies the binary in the shape this test reads');
  assert.equal(m[1], m[2], 'build.sh must copy the binary to its own name');
  assert.equal(
    declared, m[2],
    `Info.plist declares CFBundleExecutable "${declared}" but build.sh installs "${m[2]}" — ` +
    'the app will refuse to launch with "its executable is missing"'
  );
});

test('CFBundleIconFile names the icon build.sh installs', () => {
  const declared = plistValue('CFBundleIconFile');
  const m = /cp icon\/(\S+)\.icns "\$APP\/Contents\/Resources\/([^"]+)\.icns"/u.exec(build);
  assert.ok(m, 'build.sh no longer copies the icon in the shape this test reads');
  assert.equal(
    declared, m[2],
    `Info.plist declares CFBundleIconFile "${declared}" but build.sh installs "${m[2]}.icns"`
  );
});

test('the binary the scripts hunt is the binary the bundle declares', () => {
  // build.sh and uninstall.sh stop the running app with `pkill -x <name>`,
  // which matches the PROCESS name — and the process takes its name from the
  // executable file. A rename that missed these would leave both scripts
  // unable to quit the app they are replacing.
  const declared = plistValue('CFBundleExecutable');
  const uninstall = readFileSync(join(WIDGET, 'uninstall.sh'), 'utf8');
  for (const [name, text] of [['build.sh', build], ['uninstall.sh', uninstall]]) {
    for (const m of text.matchAll(/pk?grep -x (\S+)/gu)) {
      assert.equal(m[1], declared,
        `${name} hunts process "${m[1]}" but the bundle declares "${declared}"`);
    }
  }
});

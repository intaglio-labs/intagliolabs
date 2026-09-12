// A BEST-EFFORT STAMP WHOSE FAILURE WAS PERMANENT.
//
// The LinkedIn swap stamps the landed file's modification date to NOW, so
// linkedin.mjs' mtime cursor (`newestMtime <= stored` skips the scan) sees a
// new file, and puts the export's own date on the CREATION date so
// installedVintage can still answer "how old is the export sitting here".
//
// That stamp is best effort, and its comment says the cost of a failure is one
// skipped scan. It is not. A fresh copy carries the landing moment on BOTH
// dates, so a stamp that throws leaves installedVintage -- which takes the
// earlier of the two -- answering "now" for an export from last year. PASS ONE
// then refuses the owner's own file as "you already have a newer file", for
// ever, with no way past it but deleting the file by hand. One skipped scan is
// a cost; a flow that cannot be completed is not.
//
// So the failure has a fallback: the export's own date goes back on the
// modification date, and installedVintage's `min` makes the vintage honest
// again whichever half of the stamp landed.
//
// Source scan, like the other widget tests -- no Swift toolchain here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');

/// Comments out: the prose around the stamp names every symbol being pinned.
const code = (text) => text
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\/\/)/u.test(line))
  .join('\n');

/// The stamp and whatever follows it, up to the end of the swap loop's body.
function stampRegion() {
  const start = swift.indexOf('dates.contentModificationDate = Date()');
  assert.ok(start > 0, 'the swap must still stamp the modification date to the landing moment');
  const end = swift.indexOf('copied.append(entry.kind.name)', start);
  assert.ok(end > start, 'the stamp must still sit inside the swap loop');
  return code(swift.slice(start, end));
}

test('a stamp that throws is caught rather than discarded', () => {
  const region = stampRegion();
  assert.match(region, /\bcatch\b/u,
    'the stamp must be attempted with `do`/`catch`, not `try?`. A discarded failure is\n' +
    'a destination carrying the landing moment on both dates, which installedVintage\n' +
    'reads as "now"');
  assert.doesNotMatch(region, /try\? stamped\.setResourceValues\(dates\)/u,
    'the swallowing form is the defect: there is nowhere for the fallback to hang off it');
});

test('the fallback puts the export own date back where vintage is read from', () => {
  const region = stampRegion();
  const catchAt = region.indexOf('catch');
  const fallback = region.slice(catchAt);
  assert.match(fallback, /entry\.vintage/u,
    "the fallback must use the picked file's own date -- that IS the vintage, read from\n" +
    'the source file before the copy');
  assert.match(fallback, /contentModificationDate = vintage/u,
    'the vintage must land on the MODIFICATION date. installedVintage takes the earlier\n' +
    'of modification and creation, so the modification date is the one that can pull the\n' +
    'answer back off "now" whichever half of the failed stamp was applied');
  assert.match(fallback, /setResourceValues/u, 'the fallback must actually write the date');
});

test('installedVintage still reads the earlier of the two dates', () => {
  // The fallback above is only correct because of this: it relies on `min`
  // over the two dates rather than on knowing which half of the stamp failed.
  const start = swift.indexOf('private static func installedVintage(of url: URL) -> Date? {');
  assert.ok(start > 0, 'installedVintage must still exist under that name');
  const body = code(swift.slice(start, swift.indexOf('\n  }', start)));
  assert.match(body, /contentModificationDate/u, 'the modification date is one of the two');
  assert.match(body, /creationDate/u, 'the creation date is the other');
  assert.match(body, /\.min\(\)/u,
    'the earlier of the two is the vintage; a max, or either date alone, breaks the\n' +
    'fallback above and the hand-dropped-file case the comment describes');
});

test('the refusal this protects is still the one that reads it', () => {
  // PASS ONE: the "do not replace a newer file with an older one" guard. If it
  // ever stops going through installedVintage, the fallback above protects
  // nothing and this file should be re-read rather than silently kept green.
  const guard = /let existing = Bridge\.installedVintage\(of: destination\)/u;
  assert.match(swift, guard,
    'the newer-file refusal must still ask installedVintage how old the installed export\n' +
    'is, which is the question the fallback exists to keep answerable');
  // AND IT DOES NOT FIRE ON A DATE THE APP KNOWS IS MEANINGLESS (round-5
  // finding 22). Where the archive carried no date AND the stamp threw, both
  // dates are the moment the copy landed; refusing on that turned the owner's
  // own file away for good.
  assert.match(swift, /!Bridge\.unstampedImports\.contains\(kind\.name\)/u,
    'the one case the fallback cannot reach has to be excluded, not guessed at');
});

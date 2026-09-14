// "GRANTED" MUST MEAN A READ SUCCEEDED, AND NOTHING ELSE.
//
// Permissions.fullDisk() has no query API to call, so it attempts a protected
// read of ~/Library/Messages/chat.db and reports what happened. On a Mac where
// Messages has never been opened there is no chat.db, and that case used to
// return `.granted` — reasoning that a screen demanding a permission which
// buys nothing is just a wall. The reasoning was right and the word was wrong:
// "granted" travelled out through permissionState to the onboarding screen,
// painted a green row, started the reader, and left the first-load screen
// showing iMessage with zero rows and nothing anywhere saying why.
//
// So the enum has a third value and this file pins the three properties that
// make it worth having: the missing-file branch returns it, no caller quietly
// folds it back into a boolean, and the screen is told which app the grant
// would attach to (the 30 August bundle rename, see P1 in the design).
//
// Source scan, no toolchain — the same approach as bridge-capabilities.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WIDGET, 'src');
const read = (name) => readFileSync(join(SRC, name), 'utf8');

const permissions = read('Permissions.swift');
const bridge = read('Bridge.swift');
const watch = read('FullDiskWatch.swift');
const helper = read('FullDiskHelper.swift');

test('Status carries unavailable alongside the three real TCC answers', () => {
  const decl = /enum Status: String \{ case ([^}]*)\}/u.exec(permissions)?.[1] ?? '';
  const cases = decl.split(',').map((c) => c.trim()).filter(Boolean).sort();
  assert.deepEqual(cases, ['denied', 'granted', 'unavailable', 'undetermined']);
});

test('the missing-chat.db branch returns unavailable, never granted', () => {
  const body = /static func fullDisk\(\) -> Status \{([\s\S]*?)\n {2}\}/u.exec(permissions)?.[1];
  assert.ok(body, 'fullDisk() not found — did it move or change shape?');
  // The guard that fires when chat.db is absent.
  const missing = /guard FileManager\.default\.fileExists\(atPath: db\.path\) else \{([\s\S]*?)\n {4}\}/u
    .exec(body)?.[1];
  assert.ok(missing, 'the fileExists guard is gone');
  assert.match(missing, /return \.unavailable/u, 'an absent store is unavailable');
  assert.doesNotMatch(missing, /return \.granted/u, 'and must never be reported as a grant');
  // The read itself still decides the other two, so `granted` keeps meaning
  // "a byte came back".
  assert.match(body, /handle\.read\(upToCount: 1\)\) != nil \? \.granted : \.denied/u);
});

test('no caller collapses unavailable back into granted by accident', () => {
  // photos() is the ONE deliberate fold, because fullDisk() is only a proxy
  // there — the real photos probe is the Photos.sqlite read in
  // fullDiskAccessibleSources(), and a missing chat.db says nothing about a
  // photo library. It must say so explicitly rather than by omission.
  // It takes the disk answer rather than asking again — `all` has already
  // done that protected read, and doing it twice per poll doubled every tccd
  // denial on a machine that has said no — so the fold lives in photos(disk:).
  const photos = /static func photos\(disk: Status\) -> Status \{([\s\S]*?)\n {2}\}/u
    .exec(permissions)?.[1];
  assert.ok(photos, 'photos(disk:) not found');
  assert.match(photos, /disk == \.unavailable \? \.granted/u,
    'photos folds the third state deliberately and visibly');
  // And the map probes the disk once for both rows it answers from.
  const all = /static var all: \[String: String\] \{([\s\S]*?)\n {2}\}/u.exec(permissions)?.[1];
  assert.ok(all, 'Permissions.all not found');
  assert.equal((all.match(/fullDisk\(\)/gu) ?? []).length, 1,
    'one protected read per map: the fda row and the photos fold share it');

  // The full-disk edge detector acts on an actual successful read only.
  assert.match(watch, /guard now == \.granted, let before = lastKnown, before != \.granted/u,
    'only a transition INTO a real read respawns the daemon');

  // The drag card must not settle itself on "there is nothing here".
  assert.match(helper, /if disk == \.unavailable \{[\s\S]{0,400}fullDiskAccessibleSources\(\)\.isEmpty/u,
    'the card falls back to the other protected stores rather than calling absence a grant');
});

test('permissionState tells the page which bundle the grant attaches to', () => {
  const handler = /case "permissionState":([\s\S]*?)\n {4}case "/u.exec(bridge)?.[1];
  assert.ok(handler, 'permissionState handler not found');
  assert.match(handler, /"bundle": Bundle\.main\.bundleIdentifier/u);
});

test('every Swift switch over Permissions.Status handles all four cases', () => {
  // A `switch` on the enum with no default is exhaustive by the compiler, so
  // the risk is the other shape: a chain of == comparisons that treats the
  // enum as a boolean. Anything comparing to .granted must, somewhere in the
  // same file, also account for .unavailable.
  const offenders = [];
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith('.swift') || name === 'Permissions.swift') continue;
    const text = read(name);
    if (!/Permissions\.fullDisk\(\)/u.test(text)) continue;
    if (!/\.unavailable/u.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `these files read fullDisk() as a two-state answer:\n  ${offenders.join('\n  ')}`);
});

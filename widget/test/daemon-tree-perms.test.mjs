// THE PERMISSION CHECK THE DAEMON DIES ON, AND THE ONE PLACE THAT SATISFIES IT.
//
// connectors/lib/checks.mjs' `hazlie-tree-perms` is FATAL: ~/.hazlie and every
// directory in its TREE_DIRS must be exactly 0700, and any non-`fda-` FAIL
// throws before the daemon reads anything. It says so only in its own log.
//
// On the clean-machine retest a ~/.hazlie created by hand under umask 022
// landed at 755 and the reader was dead four starts in a row while onboarding
// waited for rows. The first fix chmod'ed the top directory only -- but the
// same `mkdir -p ~/.hazlie/connectors` lands BOTH at 755, and
// writeConnectorsConfigIfMissing does not re-attribute a directory that
// already exists, so the daemon went on dying on `connectors/ is 755` in
// exactly the scenario the fix was written for.
//
// This file pins the two halves of that argument:
//
//   the app reasserts the mode on every path the check inspects, which means
//   its list must BE checks.mjs' list -- read from checks.mjs here rather than
//   restated, so a directory added there and not in Connectors.swift fails
//   here instead of on someone's Mac;
//
//   and it does it without following a symlink, because chmod does and a
//   linked directory points at something this app does not own.
//
// Source scan, like the other widget tests -- no Swift toolchain here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const swift = readFileSync(join(ROOT, 'widget', 'src', 'Connectors.swift'), 'utf8');
const checks = readFileSync(join(ROOT, 'connectors', 'lib', 'checks.mjs'), 'utf8');

/// Comments out, because the prose in both files names the very directories
/// and calls being pinned; a naive `includes` would find the fix in the
/// paragraph describing the bug.
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\/\/)/u.test(line))
  .join('\n');

/// A Swift `func name(...) {` body, matched to the closing brace at its own
/// indentation. The assertions below are about what THESE functions do.
function swiftBody(signature) {
  const start = swift.indexOf(signature);
  assert.ok(start > 0, `${signature} must still exist under that name`);
  const end = swift.indexOf('\n  }', start);
  assert.ok(end > start, `the body of ${signature} must be findable`);
  return swift.slice(start, end);
}

/// The string literals of a `[...]` array, in order. Both quote styles: this
/// compares a JavaScript array against a Swift one.
function literals(text) {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"/gu)].map((m) => m[1] ?? m[2]);
}

test('the app reasserts 0700 on exactly the directories the check inspects', () => {
  const treeDirs = /const TREE_DIRS = \[([^\]]*)\]/u.exec(checks);
  assert.ok(treeDirs, 'checks.mjs must still declare TREE_DIRS as a literal array');
  const expected = literals(treeDirs[1]);
  assert.ok(expected.length > 0, 'TREE_DIRS must not be empty');

  const declared = /static let treeDirectories = \[([^\]]*)\]/u.exec(swift);
  assert.ok(declared,
    'Connectors.swift must declare treeDirectories; without it the app fixes the top\n'
    + 'directory only and the daemon still dies on a 755 child, silently');
  assert.deepEqual(literals(declared[1]), expected,
    'Connectors.treeDirectories must be checks.mjs TREE_DIRS exactly -- a directory in\n'
    + 'one list and not the other is a fatal check the app cannot satisfy');
});

test('the reassert runs before the daemon is launched', () => {
  const body = swiftBody('func start(bypassingThrottle: Bool = false) {');
  const reassert = body.indexOf('reassertTreePerms()');
  assert.ok(reassert > 0,
    'start() must reassert the tree permissions; the daemon reads them at startup');
  const run = body.indexOf('try p.run()');
  assert.ok(run > reassert,
    'the modes must be fixed BEFORE the child is spawned -- afterwards is one whole\n'
    + 'failed start later, and the start after that is behind the 60s throttle');
});

test('the reassert covers the root as well as the children', () => {
  const body = code(swiftBody('private func reassertTreePerms() {'));
  assert.match(body, /\.hazlie/u, 'the root ~/.hazlie must still be reasserted');
  assert.match(body, /Connectors\.treeDirectories/u,
    'the children must come from the pinned list, not from a second copy of it');
  assert.match(body, /0o700/u, 'the mode asserted must be 0700, which is what the check demands');
});

test('the reassert reads a symlink rather than chmod-ing through it', () => {
  const body = code(swiftBody('private func reassertTreePerms() {'));
  // attributesOfItem is lstat's answer: a linked directory reports as
  // .typeSymbolicLink and is skipped. setAttributes/chmod FOLLOWS the link,
  // so without this guard a models directory linked to an external disk has
  // the mode of whatever it points at changed by this app.
  assert.match(body, /attributesOfItem/u, 'the mode is read, not assumed');
  assert.match(body, /FileAttributeType\s*==\s*\.typeDirectory|\.typeDirectory/u,
    'only real directories may be chmod-ed');
  // RESOLVE TO ASK, NEVER TO ACT.
  //
  // ~~Nothing here may resolve a link at all.~~ Round-6 finding 3: the daemon's
  // own check uses statSync, which traverses, so refusing to look through the
  // link made the two disagree about a working install -- the reader ran and
  // screen 6 said it could not start. The rule that actually matters is the
  // second half of the old one: chmod FOLLOWS a link, so it may only ever be
  // called on a path that is not one. A link is reported, never written to.
  assert.match(body, /resolvingSymlinksInPath/u,
    'the target is what the daemon asks about, so it is what this must ask about');
  assert.doesNotMatch(body, /setAttributes\(\[\.posixPermissions: 0o700\], ofItemAtPath: target\)/u,
    'chmod through a link changes something on the other side that this app does not own');
  assert.match(body, /if isLink \{\n\s*blocked\.append/u,
    'a link whose target fails is NAMED rather than written to');
});

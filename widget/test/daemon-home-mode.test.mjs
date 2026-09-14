// The connectors daemon's hazlie-tree-perms check is FATAL when ~/.hazlie is
// wider than 0700, and it reports that only in its own log. On the first
// clean-machine run (2026-09-12) a ~/.hazlie created by hand as 755 left the
// reader dead four starts in a row while the first-load screen waited for rows.
// The app owns that directory, so Connectors.start() reasserts the mode before
// every spawn. This pins that the reassert sits on the spawn path, after the
// config guard and before the throttle, so it cannot be skipped by either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(ROOT, 'src', 'Connectors.swift'), 'utf8');

test('Connectors.start() reasserts 0700 on ~/.hazlie before spawning the daemon', () => {
  // The signature returns a StartOutcome now — six guards that used to return
  // silently, in front of a settings button the owner presses and watches. The
  // ORDERING this file pins is untouched by that.
  const start = /func start\(bypassingThrottle: Bool = false\) -> StartOutcome \{([\s\S]*?)\n  \}/u.exec(swift)?.[1];
  assert.ok(start, 'start() not found');
  const guardAt = start.indexOf('guard fm.fileExists(atPath: config.path)');
  // The chmod moved into reassertTreePerms when the fix grew to cover the
  // CHILDREN as well: the daemon's check is fatal on ~/.hazlie AND on each of
  // its TREE_DIRS, and one `mkdir -p ~/.hazlie/connectors` under umask 022
  // lands both at 755. What that function covers, and that its list is
  // checks.mjs' own, is pinned in daemon-tree-perms.test.mjs. The ordering --
  // after the config guard, before the spawn, so neither can skip it -- is
  // pinned here, which is what this file has always been about.
  const modeAt = start.indexOf('reassertTreePerms()');
  const spawnAt = start.indexOf('let p = Process()');
  assert.ok(guardAt >= 0 && modeAt >= 0 && spawnAt >= 0, 'guard, reassert and spawn must all be in start()');
  assert.ok(guardAt < modeAt && modeAt < spawnAt, 'the reassert sits between the config guard and the spawn');
});

test('the daemon still treats a wide ~/.hazlie as fatal, so the app-side reassert is load-bearing', () => {
  const checks = readFileSync(join(ROOT, '..', 'connectors', 'lib', 'checks.mjs'), 'utf8');
  assert.match(checks, /hazlie-tree-perms/u);
  // ~~/expected mode 0700 throughout/~~ — the literal became
  // `${TREE_MODE_TEXT}` when the octal moved into a shared constant, and this
  // line has been red since, for a spelling change rather than a behaviour one.
  // The two halves of the claim are asserted separately now: the check FAILS on
  // a wide tree, and the mode it demands is still 0700.
  assert.match(checks, /expected mode \$\{TREE_MODE_TEXT\} throughout/u);
  assert.match(checks, /const TREE_MODE = OWNER_ONLY_DIR_MODE;/u);
  const secrets = readFileSync(join(ROOT, '..', 'connectors', 'lib', 'secrets.mjs'), 'utf8');
  assert.match(secrets, /export const OWNER_ONLY_DIR_MODE = 0o700;/u,
    'if the tree stops being owner-only, the app-side reassert needs rewriting, not this test');
  assert.match(checks, /if \(problems\.length > 0\) \{\s*\n\s*return result\(\s*\n\s*name,\s*\n\s*FAIL,/u,
    'a wide tree must still be FATAL, not a warning');
});

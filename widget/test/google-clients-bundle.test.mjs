// THE OAUTH CLIENT SHIPS, AND IT NEVER GETS COMMITTED.
//
// Two rules that only make sense together. A first run has no
// ~/.hazlie/secrets, so onboarding's "sign in to google" button had no
// credential to sign in with and spawned a helper that exited without printing
// (clean-machine retest, 2026-09-12). build.sh therefore stages the build
// machine's registered clients into the bundle. But this repository is PUBLIC,
// and the same file inside a checkout is a Google project handed to anyone who
// clones it — the failure mode the Telegram api_id block a few lines above it
// already documents (Telegram bans a published api_id outright).
//
// So: the staging block exists, it can be turned off, it logs names and never
// contents, and .gitignore refuses the directory it reads from. A test that
// pinned only the first half would be a test that watched the credential ship
// and said nothing about where else it went.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const build = readFileSync(join(ROOT, 'widget', 'build.sh'), 'utf8');
const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
const registry = readFileSync(
  join(ROOT, 'connectors', 'lib', 'googleClients.mjs'),
  'utf8'
);

const staging =
  /if \[ "\$\{HAZLIE_SHIP_GOOGLE_CLIENTS:-1\}" = 0 \]; then([\s\S]*?)\nfi\n/u.exec(build)?.[1];

test('build.sh stages every registered client from the build machine', () => {
  assert.ok(staging, 'the google-client staging block is gone from build.sh');
  assert.match(staging, /\$HOME"?\/\.hazlie\/secrets\/google-client-\*\.json/u,
    'it reads the machine\'s own registry, not one fixed filename');
  assert.match(staging, /cp "\$gc" "\$BE\/ops\/google-clients\/"/u);
});

test('it lands where the registry looks, in the layout the bundle has', () => {
  // connectors/lib/../../ops/google-clients — the repo root's ops/ in a
  // checkout and Contents/Resources/backend/ops in the app. The same relative
  // path resolving in both layouts is the entire reason it goes under ops/,
  // beside features.json, rather than anywhere more obvious.
  assert.match(registry, /'\.\.',\s*'\.\.',\s*'ops',\s*'google-clients'/u,
    'the registry no longer resolves ../../ops/google-clients');
  assert.match(staging, /mkdir -p "\$BE\/ops\/google-clients"/u,
    'build.sh must write to the path the registry reads');
});

test('an unmatched glob is a skip, not a copy of a literal filename', () => {
  // `set -u` is on and an unmatched glob expands to itself; without the -f
  // test the build would try to copy a path with a `*` in it and die.
  assert.match(staging, /\[ -f "\$gc" \] \|\| continue/u);
});

test('a build can refuse to ship one', () => {
  assert.match(build, /HAZLIE_SHIP_GOOGLE_CLIENTS:-1/u, 'the switch defaults to shipping');
  assert.match(build, /google clients: staging skipped \(HAZLIE_SHIP_GOOGLE_CLIENTS=0\)/u);
});

test('the build log names the files and never opens them', () => {
  assert.match(staging, /basename "\$gc"/u, 'names are what a build log has to answer');
  // `cat`, `tr` and friends on a credential would put the secret in CI output.
  assert.doesNotMatch(staging, /\bcat\b|\btr -d\b|\bhead\b|\bgrep\b/u,
    'nothing in this block may read a client file\'s contents');
  assert.match(staging, /google clients: none on this machine/u,
    'a build without one says so rather than passing silently');
});

test('the bundle copy is readable by the app that has to read it', () => {
  // 0600 in ~/.hazlie, 0644 in the bundle. The registry reads bundled files
  // with a plain read for exactly this reason, and a 0600 copy inside an
  // installed .app would be a credential nothing could open.
  assert.match(staging, /chmod 644 "\$BE\/ops\/google-clients\//u);
  assert.match(registry, /readSecretJson/u, 'the secrets-dir path still goes through the gauntlet');
});

test('git refuses the directory and the filename, in a PUBLIC repo', () => {
  const lines = ignore.split('\n').map((l) => l.trim());
  assert.ok(lines.includes('ops/google-clients/'), '.gitignore must refuse the staging directory');
  assert.ok(lines.includes('google-client-*.json'),
    '.gitignore must refuse the filename anywhere, not only in that one directory');
});

test('no client credential is tracked in the repo right now', () => {
  // The ignore rule is a promise about the future; this is the check on the
  // present. An already-tracked file is not covered by .gitignore at all.
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  const hits = tracked
    .split('\n')
    .filter((f) => /google-client-.*\.json$/u.test(f) || f.startsWith('ops/google-clients/'));
  assert.deepEqual(hits, [], `a Google OAuth client is committed: ${hits.join(', ')}`);
});

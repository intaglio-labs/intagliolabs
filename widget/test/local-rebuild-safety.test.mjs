import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = readFileSync(join(WIDGET, 'build.sh'), 'utf8');
const stagedCheck = readFileSync(join(WIDGET, 'scripts', 'check-staged-connectors.mjs'), 'utf8');
const conflictCheck = join(WIDGET, 'scripts', 'check-file-provider-conflicts.sh');

test('a File Provider conflict stops the build before compilation or installation', () => {
  const guard = build.indexOf('FILE_PROVIDER_CONFLICTS=');
  const compile = build.indexOf('swiftc -O');
  const install = build.indexOf('ditto --norsrc --noextattr "$APP" "$DEST"');

  assert.ok(guard >= 0, 'build.sh must scan its packaged inputs for conflict-copy names');
  assert.ok(guard < compile, 'the conflict scan must run before Swift sees duplicate source files');
  assert.ok(guard < install, 'a conflicted checkout must never replace the installed app');
  const guardScript = readFileSync(conflictCheck, 'utf8');
  assert.match(guardScript, /-name '\* 2'/u,
    'the guard must recognize extensionless File Provider conflict copies');
  assert.match(guardScript, /-name '\* 2\.\*'/u,
    'the guard must recognize File Provider conflict copies with extensions');
  assert.match(build, /exit 1/u, 'the guard must fail closed');
});

test('the File Provider guard fires on a conflict copy and ignores a clean tree', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'intaglio-conflict-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'src');
  mkdirSync(source);
  writeFileSync(join(source, 'Widget.swift'), 'final class Widget {}\n');

  const clean = spawnSync('sh', [conflictCheck, source], { encoding: 'utf8' });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, '');

  writeFileSync(join(source, 'Widget 2.swift'), 'final class Widget {}\n');
  writeFileSync(join(source, '.gitignore 2'), 'build/\n');
  const conflicted = spawnSync('sh', [conflictCheck, source], { encoding: 'utf8' });
  assert.equal(conflicted.status, 1, 'a conflict copy must make the guard fail red');
  assert.match(conflicted.stdout, /Widget 2\.swift/u);
  assert.match(conflicted.stdout, /\.gitignore 2/u);
});

test('the staged connector roster is loaded before the installed app is replaced', () => {
  const roster = build.indexOf('STAGED CONNECTOR ROSTER');
  const install = build.indexOf('ditto --norsrc --noextattr "$APP" "$DEST"');

  assert.ok(roster >= 0, 'build.sh must execute the staged connector roster');
  assert.ok(roster < install, 'duplicate or malformed sources must fail before installation');
  assert.match(build, /check-staged-connectors\.mjs/u);
  assert.match(stagedCheck, /loadSources/u);
});

test('a local rebuild waits for Hermes and proves the connector child survives', () => {
  const restartServices = build.indexOf('for svc in io.intaglio.hermes');
  const waitForHermes = build.indexOf('WAIT FOR HERMES');
  const openApp = build.indexOf('open "$DEST"');
  const proveConnector = build.lastIndexOf('verify_connector_child');

  assert.ok(restartServices >= 0 && waitForHermes > restartServices,
    'Hermes readiness belongs after its launchd restart');
  assert.ok(openApp > waitForHermes, 'the app must not race Hermes startup');
  assert.ok(proveConnector > openApp, 'connector verification belongs after app launch');
  assert.match(build, /127\.0\.0\.1:51789\/health/u);
  assert.match(build, /connectors\/daemon\\\.mjs/u);
});

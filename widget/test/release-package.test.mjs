import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = readFileSync(join(WIDGET, 'release.sh'), 'utf8');
const build = readFileSync(join(WIDGET, 'build.sh'), 'utf8');
const workflow = readFileSync(join(WIDGET, '..', '.github', 'workflows', 'release.yml'), 'utf8');

test('packaging renders the Finder background outside the tracked source tree', () => {
  assert.match(release, /BG="\$DIST\/dmg-bg\.png"/u);
  assert.match(release, /make-dmg-bg\.swift "\$BG"/u);
  assert.doesNotMatch(
    release,
    /make-dmg-bg\.swift\s+icon\/dmg-bg\.png/u,
    'a release must not dirty its checkout after the provenance guard runs',
  );
});

test('release builds never reuse executable dependencies from the installed app', () => {
  assert.match(release, /HAZLIE_STAGE_DIR="\$PWD\/build"/u,
    'release.sh must identify release staging to build.sh');
  assert.match(
    build,
    /if \[ -z "\$\{HAZLIE_STAGE_DIR:-\}" \][\s\S]*?INSTALLED_CONNECTORS\/node_modules/u,
    'the installed dependency cache must be restricted to direct local builds'
  );
  assert.match(
    workflow,
    /npm ci --prefix connectors --ignore-scripts/u,
    'the clean release checkout must install locked connector dependencies before packaging'
  );
});

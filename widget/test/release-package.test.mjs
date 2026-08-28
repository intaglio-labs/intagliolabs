import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(WIDGET, '..');
const release = readFileSync(join(WIDGET, 'release.sh'), 'utf8');
const build = readFileSync(join(WIDGET, 'build.sh'), 'utf8');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const compose = readFileSync(join(ROOT, 'bridges', 'docker-compose.yml'), 'utf8');
const setupBridges = readFileSync(join(ROOT, 'ops', 'setup-bridges.sh'), 'utf8');
const prefetchBridges = readFileSync(join(ROOT, 'ops', 'prefetch-bridges.sh'), 'utf8');

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
  assert.match(
    workflow,
    /TELEGRAM_APP_CREDENTIAL: \$\{\{ secrets\.TELEGRAM_APP_CREDENTIAL \}\}/u,
    'release CI must receive Telegram credentials through a repository secret'
  );
  assert.match(
    workflow,
    /HZ_TELEGRAM_APP: \$\{\{ secrets\.TELEGRAM_APP_CREDENTIAL \}\}/u,
    'the secret must reach build.sh through its credential-only environment input'
  );
});

test('Telegram setup and prefetch use the same immutable image as runtime', () => {
  const image = /image:\s*(dock\.mau\.dev\/mautrix\/telegram@sha256:[a-f0-9]{64})/u
    .exec(compose)?.[1];
  assert.ok(image, 'the Telegram runtime image must be pinned by digest');
  assert.ok(setupBridges.includes(image), 'fresh config generation must use the runtime digest');
  assert.ok(prefetchBridges.includes(image), 'background prefetch must warm the runtime digest');
  assert.match(setupBridges, /\| \/usr\/bin\/sed -i '' -f - "\$M\/telegram\/config\.yaml"/u,
    'the Telegram API hash reaches sed over stdin rather than through process arguments');
});

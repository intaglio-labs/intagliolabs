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
const provision = readFileSync(join(WIDGET, 'src', 'Provision.swift'), 'utf8');
const privacy = readFileSync(join(ROOT, 'site', 'privacy', 'index.html'), 'utf8');

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

test('every bridge setup and prefetch image matches the immutable runtime image', () => {
  const runtimeImages = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  assert.ok(runtimeImages.length >= 8, 'expected Synapse plus every social bridge');
  for (const image of runtimeImages) {
    assert.match(image, /@sha256:[0-9a-f]{64}$/u, `${image} is mutable`);
    assert.ok(setupBridges.includes(image), `setup does not use runtime image ${image}`);
    assert.ok(prefetchBridges.includes(image), `prefetch does not use runtime image ${image}`);
  }
});

test('bridge setup requests maximum available history on every supported lane', () => {
  for (const key of [
    'max_initial_messages',
    'max_catchup_messages',
    'threads.max_initial_messages',
  ]) {
    assert.ok(setupBridges.includes(`.backfill.${key} = 2147483647`));
  }
  for (const kind of ['dm', 'channel', 'thread']) {
    assert.ok(setupBridges.includes(`.bridge.backfill.forward_limits.initial.${kind} = 2147483647`));
    assert.ok(setupBridges.includes(`.bridge.backfill.forward_limits.missed.${kind} = -1`));
  }
  assert.ok(setupBridges.includes('.bridge.startup_private_channel_create_limit = 2147483647'));
  assert.match(setupBridges, /DISCORD_NEEDS_PORTAL_REFRESH/u);
  assert.match(setupBridges, /docker compose restart mautrix-discord/u,
    'an existing running Discord bridge must reload the corrected bind-mounted config');
});

test('existing capped bridge installs receive one recoverable automatic reset', () => {
  assert.match(setupBridges, /\.full-history-reset-v1/u);
  assert.match(setupBridges, /backups\/full-history-v1-/u);
  assert.match(setupBridges, /docker compose stop/u,
    'SQLite databases must not be moved while bridge containers are writing');
  const migrationStop = setupBridges.match(/# its WAL is not a backup\.([\s\S]*?)backup_path\(\)/u)?.[1] ?? '';
  assert.doesNotMatch(migrationStop, /\|\| true/u,
    'a failed writer stop must abort before any SQLite file is moved');
  assert.match(setupBridges, /printf '%s\\n' "\$RESET_BACKUP" > "\$FULL_HISTORY_PENDING"/u,
    'an interrupted migration must resume into the same recovery backup');
  assert.match(setupBridges, /if \[ -e "\$dst" \][\s\S]*RESET_RETRY_BACKUP/u,
    'a retry must preserve, not overwrite, the original recovery copy');
  assert.match(setupBridges, /! -f "\$M\/owner-credentials\.json"[\s\S]*: > "\$FULL_HISTORY_MARKER"/u,
    'a partially completed fresh install must never be mistaken for a capped upgrade');
  assert.match(setupBridges, /social-reimport-v1\.pending/u,
    'the derived Hermes corpus must be purged with the source-side reset');
  assert.doesNotMatch(setupBridges, /rm\s+-[rRfF]*\s+[^\n]*homeserver\.db/u,
    'the old runtime must remain recoverable');
  assert.match(provision, /matrix\/owner-credentials\.json/u);
  assert.match(provision, /matrix\/\.full-history-reset-v1/u);
  assert.match(provision, /matrix\/\.full-history-reset-v1\.pending/u,
    'an interrupted migration must retry even after owner credentials moved');
  assert.match(provision, /ensureBridgeRuntime \{ _ in \}/u,
    'an existing runtime must apply the migration automatically on app launch');
  assert.match(provision, /if success \{ Connectors\.shared\.restart\(\) \}/u,
    'the daemon must consume its purge marker before indexing recreated rooms');
  assert.match(privacy, /backups\/full-history-v1-&lt;timestamp&gt;/u,
    'the public policy must disclose the recoverable copy and where it lives');
  assert.match(privacy, /maximum history each platform and local bridge make available/u,
    'the public policy must disclose the full-history product behavior');
  assert.doesNotMatch(privacy, /<strong>Mail \(Gmail\)<\/strong>[\s\S]{0,300}<td>30 days<\/td>/u);
});

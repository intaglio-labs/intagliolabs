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
const setupBridges = readFileSync(join(ROOT, 'ops', 'setup-bridges-native.sh'), 'utf8');
const prefetchBridges = readFileSync(join(ROOT, 'ops', 'prefetch-bridges.sh'), 'utf8');
const manifest = readFileSync(join(ROOT, 'bridges', 'native.json'), 'utf8');
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

// THE PINNING INVARIANT SURVIVED THE ENGINE CHANGE; ITS ARTIFACT DID NOT.
// These two tests compared setup and prefetch against docker-compose.yml's
// image digests. There are no images. The thing that must still be immutable
// is bridges/native.json's per-binary sha256, and the thing that must still be
// true is that setup and prefetch consume that one manifest rather than each
// reaching for its own copy of a version number.
test('every bridge binary is pinned by sha256 in one manifest', () => {
  const pins = [...manifest.matchAll(/"sha256":\s*"([0-9a-f]{64})"/gu)];
  assert.ok(pins.length >= 7, `expected a pin per bridge, found ${pins.length}`);
  assert.doesNotMatch(manifest, /"sha256":\s*""/u, 'an empty pin verifies nothing');
});

test('setup and prefetch fetch through the manifest, never a hardcoded URL', () => {
  for (const [what, text] of [['setup', setupBridges], ['prefetch', prefetchBridges]]) {
    assert.match(text, /fetch-bridges\.mjs/u, `${what} must go through the verifying fetcher`);
    assert.doesNotMatch(text, /https:\/\/github\.com\/mautrix/u,
      `${what} must not carry its own download URL beside the manifest's`);
  }
});

test('the Telegram API hash never reaches the process table', () => {
  assert.match(setupBridges, /-i '' -f - "\$M\/telegram\/config\.yaml"/u,
    'the Telegram API hash reaches sed over stdin rather than through process arguments');
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
  // DISCORD_NEEDS_PORTAL_REFRESH and its `docker compose restart` went with the
  // container engine: a bind-mounted config needed the container bounced to be
  // re-read, and there is no container. The native bridge reads its config from
  // disk at start and launchd restarts it, so the limits above are the whole
  // invariant now.
});

test('a native install is marked as needing no history migration', () => {
  // The capped-history migration -- back up, wipe, re-link, purge the derived
  // corpus -- lived only in the container provisioner and went with it. Nothing
  // here can be capped: this script has always written 2147483647, and a
  // container-era directory is refused rather than migrated.
  //
  // The MARKER is what has to survive, because Provision reads its absence as
  // "this install still needs the migration". Without it every launch of a
  // working install re-ran the entire bridge setup looking for a migration no
  // script could perform.
  assert.match(setupBridges, /FULL_HISTORY_MARKER="\$M\/\.full-history-reset-v1"/u);
  assert.match(setupBridges, /mark_history_uncapped/u);
  const owner = setupBridges.indexOf('# --- the owner');
  const mark = setupBridges.indexOf('\nmark_history_uncapped\n', owner);
  const creds = setupBridges.indexOf('owner-credentials.json', owner);
  assert.ok(mark > -1 && mark < creds,
    'the marker must be written before the credentials, or a run that dies between them loops forever');
  assert.doesNotMatch(setupBridges, /rm\s+-[rRfF]*\s+[^\n]*homeserver\.db/u,
    'the old runtime must remain recoverable');
  assert.match(provision, /let matrixRoot = hazlie\.appendingPathComponent\("matrix"\)/u,
    'one engine, one state root');
  assert.match(provision, /matrixRoot\.appendingPathComponent\("owner-credentials\.json"\)/u);
  assert.match(provision, /matrixRoot\.appendingPathComponent\("\.full-history-reset-v1"\)/u);
  assert.match(provision, /matrixRoot\.appendingPathComponent\("\.full-history-reset-v1\.pending"\)/u,
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

// THE POLICY TESTS MUST NOT DEPEND ON THE MACHINE THEY RUN ON.
//
// daemon.mjs reads ops/features.json AND ~/.hazlie/features.json at module
// scope, so every assertion about DEFAULT_DISABLED_CONNECTORS was really an
// assertion about the developer's home directory. The failure is not
// theoretical: `{"bridges":true}` there schedules matrix, which is exactly what
// daemonConfig.test.mjs pins as hidden — so that file went red on the one
// machine that had used the escape hatch the registry deliberately provides.
//
// This runs the pinned file in a child process whose HOME holds exactly that
// override. It passes only because HAZLIE_FEATURES_OVERRIDE=none is honoured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DEFAULT_REGISTRY_PATH, defaultOverridePath, readFeatures } from '../lib/features.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function homeWithOverride(body) {
  const home = mkdtempSync(join(tmpdir(), 'hz-hermetic-'));
  mkdirSync(join(home, '.hazlie'), { recursive: true });
  writeFileSync(join(home, '.hazlie', 'features.json'), body);
  return home;
}

test('the override path is injectable, and "none" means no override at all', () => {
  const home = homeWithOverride('{"bridges": true}');
  const path = join(home, '.hazlie', 'features.json');

  assert.equal(defaultOverridePath(home, {}), path, 'the default is still the owner override');
  assert.equal(defaultOverridePath(home, { HAZLIE_FEATURES_OVERRIDE: path }), path);
  assert.equal(defaultOverridePath(home, { HAZLIE_FEATURES_OVERRIDE: 'none' }), null);

  // And the loader honours both answers. The discriminating pair: the same
  // registry reads bridges ON through the override and OFF without it.
  assert.equal(
    readFeatures({ registryPath: DEFAULT_REGISTRY_PATH, overridePath: path }).bridges,
    true
  );
  assert.equal(
    readFeatures({ registryPath: DEFAULT_REGISTRY_PATH, overridePath: null }).bridges,
    false
  );
});

test('the pinned-policy tests pass under a home whose override flips bridges on', async () => {
  const home = homeWithOverride('{"bridges": true, "connectors": {"notes": true}}');
  // Inherit nothing that would mask the point: HOME is the fixture, and the
  // child sets its own HAZLIE_FEATURES_OVERRIDE from the file under test.
  const env = { ...process.env, HOME: home };
  delete env.HAZLIE_FEATURES_OVERRIDE;
  // NODE_TEST_CONTEXT is how the runner tells a child to report back through
  // its own channel; left set, the child's summary never reaches this stdout.
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await run(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-concurrency=1', join(HERE, 'daemonConfig.test.mjs')],
    { env, cwd: join(HERE, '..', '..') }
  );
  assert.match(stdout, /\n# fail 0\n/u, stdout.slice(-800));
});

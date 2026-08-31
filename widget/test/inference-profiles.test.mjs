import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readInferenceProfiles, selectInferenceProfile } from '../../ops/inference-profile.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const profiles = readInferenceProfiles();

test('machine profiles scale conservatively and never exceed tested concurrency', () => {
  assert.deepEqual(profiles.map((profile) => profile.id), ['compact', 'balanced', 'performance']);
  assert.equal(selectInferenceProfile({ memoryBytes: 8 * 1024 ** 3, cores: 8 }).id, 'compact');
  assert.equal(selectInferenceProfile({ memoryBytes: 16 * 1024 ** 3, cores: 8 }).id, 'balanced');
  assert.equal(selectInferenceProfile({ memoryBytes: 24 * 1024 ** 3, cores: 10 }).id, 'performance');
  for (const profile of profiles) {
    assert.ok(profile.contextSize <= 32768);
    assert.ok(profile.parallel >= 1 && profile.parallel <= 2);
    assert.ok(profile.summaryConcurrency >= 1 && profile.summaryConcurrency <= 2);
    if (profile.dualModelSummaries) assert.ok(profile.modelsMax >= 2);
  }
});

test('the app bundle and both launch agents consume the shared profile', () => {
  const build = readFileSync(join(REPO, 'widget', 'build.sh'), 'utf8');
  const provision = readFileSync(join(REPO, 'widget', 'src', 'Provision.swift'), 'utf8');
  const llama = readFileSync(join(REPO, 'ops', 'io.intaglio.llama-server.plist'), 'utf8');
  const hermes = readFileSync(join(REPO, 'ops', 'io.intaglio.hermes.plist'), 'utf8');
  assert.match(build, /inference-profiles\.json/u);
  assert.match(provision, /InferenceTuning\.selected/u);
  for (const placeholder of [
    '@LLAMA_CTX_SIZE@', '@LLAMA_PARALLEL@', '@LLAMA_BATCH_SIZE@',
    '@LLAMA_UBATCH_SIZE@', '@LLAMA_MODELS_MAX@',
  ]) assert.ok(llama.includes(placeholder));
  assert.ok(hermes.includes('@LLAMA_MAIN_MODEL@'));
  assert.ok(hermes.includes('@LLAMA_REDUCER_MODEL@'));
  assert.ok(hermes.includes('@SUMMARY_CONCURRENCY@'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readInferenceProfiles, selectInferenceProfile } from '../../ops/inference-profile.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const profiles = readInferenceProfiles();
const modelSetup = readFileSync(join(REPO, 'widget', 'src', 'ModelSetup.swift'), 'utf8');
const bridge = readFileSync(join(REPO, 'widget', 'src', 'Bridge.swift'), 'utf8');
const connectors = readFileSync(join(REPO, 'widget', 'src', 'Connectors.swift'), 'utf8');
const distiller = readFileSync(join(REPO, 'widget', 'src', 'Distiller.swift'), 'utf8');
const onboarding = readFileSync(join(REPO, 'widget', 'ui', 'onboarding.js'), 'utf8');
const connections = readFileSync(join(REPO, 'widget', 'ui', 'connections.js'), 'utf8');

test('machine profiles scale conservatively and never exceed tested concurrency', () => {
  assert.deepEqual(profiles.map((profile) => profile.id), ['compact', 'balanced', 'performance']);
  assert.equal(selectInferenceProfile({ memoryBytes: 8 * 1024 ** 3, cores: 8, gpuCores: 8 }).id, 'compact');
  assert.equal(selectInferenceProfile({ memoryBytes: 16 * 1024 ** 3, cores: 8, gpuCores: 8 }).id, 'balanced');
  assert.equal(selectInferenceProfile({ memoryBytes: 24 * 1024 ** 3, cores: 10, gpuCores: 16 }).id, 'performance');
  assert.equal(selectInferenceProfile({ memoryBytes: 24 * 1024 ** 3, cores: 10, gpuCores: 7 }).id, 'compact');
  assert.equal(selectInferenceProfile({ memoryBytes: 16 * 1024 ** 3, cores: 8, gpuCores: 0 }).id, 'balanced');
  for (const profile of profiles) {
    assert.ok(profile.contextSize <= 32768);
    assert.ok(profile.parallel >= 1 && profile.parallel <= 2);
    assert.ok(profile.summaryConcurrency >= 1 && profile.summaryConcurrency <= 2);
    if (profile.dualModelSummaries) assert.ok(profile.modelsMax >= 2);
    assert.ok(['4b', '8b'].includes(profile.modelTier));
  }
});

test('model quality follows hardware, not the performance toggle', () => {
  assert.equal(selectInferenceProfile({ memoryBytes: 8 * 1024 ** 3, cores: 8, gpuCores: 8 }).modelTier, '4b');
  assert.equal(selectInferenceProfile({ memoryBytes: 16 * 1024 ** 3, cores: 8, gpuCores: 8 }).modelTier, '8b');
  const setup = readFileSync(join(REPO, 'ops', 'setup-llm.sh'), 'utf8');
  assert.match(setup, /AUTO_MODEL_TIER/u);
  assert.match(setup, /--gpu-cores/u);
  assert.doesNotMatch(setup, /PowerBudget|god_mode|battery_saver/u);
  assert.match(modelSetup, /static var recommended: String \{ InferenceTuning\.selected\(\)\.modelTier \}/u);
  assert.match(bridge, /let tier = ModelSetup\.recommended/u);
  assert.match(onboarding, /hzPost\('modelDownload', \{\}\)/u);
  assert.doesNotMatch(connections, /local model size|modelRow|modelDownload/u);
});

test('automatic model changes are staged and activated only while idle', () => {
  assert.match(modelSetup, /HazlieAutomaticModelFingerprintV1/u);
  assert.match(modelSetup, /MachineCapabilities\.current/u);
  assert.match(modelSetup, /HZSourceCommit/u);
  assert.match(modelSetup, /Migration from the old manual picker/u);
  assert.match(bridge, /tierId: tier, activate: false/u);
  assert.match(bridge, /Connectors\.shared\.activeWorkLabel == nil/u);
  assert.match(bridge, /Connectors\.shared\.queuedWorkLabel == nil/u);
  assert.match(bridge, /Distiller\.shared\.activity == nil/u);
  assert.match(bridge, /ModelSetup\.activate\(tierId: tier\)/u);
  assert.match(bridge, /rollbackAutomaticModel/u);
  assert.doesNotMatch(bridge, /pauseAutomaticModelSupervisors\(\)[\s\S]{0,120}stageAutomaticModel/u);
  assert.match(bridge, /activateAutomaticModel[\s\S]{0,500}pauseAutomaticModelSupervisors\(\)/u);
  assert.match(bridge, /resumeAutomaticModelSupervisors/u);
  assert.match(connectors, /func pauseForModelMaintenance\(\)/u);
  assert.match(connectors, /guard !isRunning, !stopping, !modelMaintenancePaused/u);
  assert.match(distiller, /func pauseForModelMaintenance\(\)/u);
  assert.match(distiller, /guard !stopping, !modelMaintenancePaused/u);
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

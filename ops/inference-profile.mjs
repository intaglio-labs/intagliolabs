import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function readInferenceProfiles(path = join(here, 'inference-profiles.json')) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error('inference profile file is invalid');
  }
  return value.profiles;
}

export function selectInferenceProfile(
  { memoryBytes = 0, cores = 0, gpuCores = 0 } = {},
  profiles = readInferenceProfiles()
) {
  const memoryGB = Math.max(0, Number(memoryBytes) || 0) / (1024 ** 3);
  const cpuCores = Math.max(0, Math.floor(Number(cores) || 0));
  const graphicsCores = Math.max(0, Math.floor(Number(gpuCores) || 0));
  return profiles.reduce((selected, profile) => (
    memoryGB >= profile.minMemoryGB
      && cpuCores >= profile.minCores
      // Some Intel and virtual Macs do not publish a meaningful GPU core
      // count. Unknown must not masquerade as a weak GPU; RAM + CPU remain the
      // conservative fallback there.
      && (graphicsCores === 0 || graphicsCores >= (profile.minGPUCores || 0))
      ? profile : selected
  ), profiles[0]);
}

function flag(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const profile = selectInferenceProfile({
    memoryBytes: Number(flag('--memory-bytes') ?? 0),
    cores: Number(flag('--cores') ?? 0),
    gpuCores: Number(flag('--gpu-cores') ?? 0),
  });
  if (process.argv.includes('--tsv')) {
    process.stdout.write([
      profile.id, profile.contextSize, profile.parallel, profile.batchSize,
      profile.microBatchSize, profile.modelsMax, profile.modelTier,
    ].join('\t'));
  } else {
    process.stdout.write(`${JSON.stringify(profile)}\n`);
  }
}

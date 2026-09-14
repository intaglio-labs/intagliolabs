// ModelSetup.installed decides whether this Mac has weights by following the
// models/model.gguf symlink. link() writes that symlink RELATIVE ("<tier
// file>"), and Foundation resolves a relative path against the directory that
// CONTAINS a base URL with no trailing slash -- so `URL(fileURLWithPath: dest,
// relativeTo: modelDir)` looked for the weights one level above the models
// directory, found nothing, and the first clean-machine run (2026-09-12)
// provisioned every agent except the llama one. These pins keep the resolver
// on the right side of that, and keep the repair path that puts the agent back
// on an install that was provisioned while the resolver was wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = readFileSync(join(ROOT, 'src', 'ModelSetup.swift'), 'utf8');
const provision = readFileSync(join(ROOT, 'src', 'Provision.swift'), 'utf8');

test('a relative model link resolves inside the models directory, an absolute one as itself', () => {
  const installed = /static var installed: ModelTier\? \{([\s\S]*?)\n  \}/u.exec(model)?.[1];
  assert.ok(installed, 'installed not found');
  assert.doesNotMatch(installed, /relativeTo: modelDir/u,
    'relativeTo: on a directory URL without a trailing slash resolves against its parent');
  assert.match(installed, /dest\.hasPrefix\("\/"\)\s*\?\s*URL\(fileURLWithPath: dest\)\s*:\s*modelDir\.appendingPathComponent\(dest\)/u,
    'absolute as itself, relative as a child of modelDir');
});

test('an already-provisioned install with weights and no llama agent gets the agent back', () => {
  const ensure = /static func ensureBackend\(\) \{([\s\S]*?)\n  \}/u.exec(provision)?.[1];
  assert.ok(ensure, 'ensureBackend not found');
  const early = ensure.indexOf('guard !fm.fileExists(atPath: connectPlist.path) else {');
  // The repair moved behind a named function when it gained a lock and a
  // once-flag: two concurrent ensureBackend() calls both passed the "no plist"
  // test and interleaved installAgent's bootout/bootstrap pair. That guarding
  // is pinned in llama-repair-once.test.mjs; this file still pins that the
  // repair runs on the already-provisioned branch, before its return, which is
  // the branch a Mac with late-arriving weights takes.
  const repair = ensure.indexOf('repairLlamaAgent()');
  const ret = ensure.indexOf('return\n      }', early);
  assert.ok(early >= 0 && repair > early && ret > repair, 'the repair sits inside the already-provisioned branch, before its return');

  const body = /private static func repairLlamaAgent\(\) -> String\? \{([\s\S]*?)\n  \}/u.exec(provision)?.[1];
  assert.ok(body, 'repairLlamaAgent not found');
  assert.match(body, /ModelSetup\.isInstalled, !fm\.fileExists\(atPath: llamaPlist\.path\)/u,
    'weights present and no agent is still the condition the repair acts on');
  assert.match(body, /installAgent\("io\.intaglio\.llama-server"\)/u,
    'and installing that agent is still what it does');
});

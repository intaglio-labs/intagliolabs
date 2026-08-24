// The model tiers exist in two places. They must agree.
//
// ops/setup-llm.sh provisions a machine from a shell; widget/src/ModelSetup.swift
// provisions the same machine from onboarding. A person can run either, and some
// run one then the other — this branch already fixed a bug where the app wrote a
// secret the script then refused, because the two paths each looked correct
// alone. Repo, filename, byte count and sha256 are the same four facts twice, in
// two languages, with no compiler between them.
//
// So: read both and compare. If a model is bumped in the script and not in the
// app, this fails on that commit rather than on someone's install, where the
// symptom would be a downloaded file whose digest never matches and a screen
// that says "the download did not match its checksum" forever.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sh = readFileSync(join(REPO, 'ops', 'setup-llm.sh'), 'utf8');
const swift = readFileSync(join(REPO, 'widget', 'src', 'ModelSetup.swift'), 'utf8');

// --- the shell's two branches ------------------------------------------------
// if [[ "$MODEL_TIER" == 4B* ]]; then <4b block> else <8b block> fi
function shellTiers() {
  const block = /if \[\[ "\$MODEL_TIER" == 4B\* \]\]; then([\s\S]*?)else([\s\S]*?)\nfi/u.exec(sh);
  assert.ok(block, 'could not find the tier branch in setup-llm.sh — did it move?');
  const read = (text) => ({
    repo: /MODEL_REPO="([^"]+)"/u.exec(text)?.[1],
    file: /MODEL_FILE="([^"]+)"/u.exec(text)?.[1],
    bytes: Number(/MODEL_SIZE=(\d+)/u.exec(text)?.[1]),
    sha256: /MODEL_SHA256="([0-9a-f]{64})"/u.exec(text)?.[1],
  });
  return { '4b': read(block[1]), '8b': read(block[2]) };
}

// --- the Swift literals ------------------------------------------------------
function swiftTiers() {
  const out = {};
  for (const m of swift.matchAll(
    /ModelTier\(\s*id:\s*"([^"]+)"[\s\S]*?file:\s*"([^"]+)"[\s\S]*?repo:\s*"([^"]+)"[\s\S]*?bytes:\s*([0-9_]+)[\s\S]*?sha256:\s*"([0-9a-f]{64})"/gu
  )) {
    out[m[1]] = {
      file: m[2],
      repo: m[3],
      bytes: Number(m[4].replace(/_/gu, '')),
      sha256: m[5],
    };
  }
  return out;
}

const fromShell = shellTiers();
const fromSwift = swiftTiers();

test('both sources describe the same two tiers', () => {
  assert.deepEqual(Object.keys(fromSwift).sort(), ['4b', '8b']);
  assert.deepEqual(Object.keys(fromShell).sort(), ['4b', '8b']);
});

test('repo, file, size and checksum match exactly, per tier', () => {
  for (const id of ['4b', '8b']) {
    const a = fromShell[id];
    const b = fromSwift[id];
    for (const field of ['repo', 'file', 'bytes', 'sha256']) {
      assert.equal(
        b[field], a[field],
        `tier ${id}: ${field} differs — setup-llm.sh says ${JSON.stringify(a[field])}, ` +
          `ModelSetup.swift says ${JSON.stringify(b[field])}. Whichever is newer, ` +
          `update the other in the same commit.`
      );
    }
  }
});

test('every declared value is well formed', () => {
  // A guard against the regexes silently matching nothing and this whole file
  // passing on two empty objects.
  for (const [id, t] of Object.entries(fromSwift)) {
    assert.match(t.sha256, /^[0-9a-f]{64}$/u, `tier ${id}: sha256`);
    assert.ok(t.bytes > 1e9, `tier ${id}: byte count looks wrong (${t.bytes})`);
    assert.match(t.file, /\.gguf$/u, `tier ${id}: filename`);
    assert.ok(t.repo.includes('/'), `tier ${id}: repo`);
  }
});

test('the model host is the one the ledger declares', () => {
  // ModelSetup builds https://huggingface.co/<repo>/resolve/main/<file>. That
  // host is in ops/EGRESS.json as a model-asset; this pins the URL shape so a
  // future edit cannot quietly point the download somewhere undeclared.
  assert.match(swift, /https:\/\/huggingface\.co\/\\\(repo\)\/resolve\/main\/\\\(file\)/u,
    'the download URL is no longer huggingface.co — declare the new host in ops/EGRESS.json');
  const ledger = JSON.parse(readFileSync(join(REPO, 'ops', 'EGRESS.json'), 'utf8'));
  assert.ok(
    ledger.paths.some((p) => p.host === 'huggingface.co'),
    'huggingface.co is missing from the egress ledger'
  );
});

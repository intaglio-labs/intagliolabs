import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCUMENT_EXTS,
  extensionOf,
  isDataless,
  isSecretName,
  walkFiles,
} from '../lib/fileWalk.mjs';

function tree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'files-walk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Private development measurements confirmed that many cloud entries are
// dataless. Reading one downloads it.
test('dataless is blocks 0 with a real size, and nothing else', () => {
  assert.equal(isDataless({ blocks: 0, size: 24864 }), true);
  assert.equal(isDataless({ blocks: 72, size: 34820 }), false, 'a materialized file has blocks');
  assert.equal(isDataless({ blocks: 0, size: 0 }), false, 'an empty file is not online-only');
});

// iCloud Drive's Desktop and Documents are symlinks back into the home
// directory. Following them walks the whole home from inside a "cloud
// folder" scan, ingests everything twice, and escapes the configured root.
test('symlinks are never followed, to files or directories', (t) => {
  const dir = tree(t);
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.md'), 'should not be reached');
  const root = join(dir, 'root');
  mkdirSync(root);
  writeFileSync(join(root, 'real.md'), 'ok');
  symlinkSync(outside, join(root, 'Documents'));
  symlinkSync(join(outside, 'private.md'), join(root, 'link.md'));

  const skips = {};
  const names = [...walkFiles(root, { onSkip: (w) => (skips[w] = (skips[w] ?? 0) + 1) })].map(
    (e) => e.name
  );
  assert.deepEqual(names, ['real.md']);
  assert.equal(skips.symlink, 2);
});

test('dependency trees are skipped, or they bury the documents', (t) => {
  const dir = tree(t);
  mkdirSync(join(dir, 'node_modules', 'lodash'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'lodash', 'toString.js'), 'x');
  mkdirSync(join(dir, 'Contracts'));
  writeFileSync(join(dir, 'Contracts', 'agreement.md'), 'x');
  const names = [...walkFiles(dir)].map((e) => e.name);
  assert.deepEqual(names, ['agreement.md']);
});

// The owner's iCloud has a folder literally called "Secret Keys".
test('credential folders and credential filenames are never walked into', (t) => {
  const dir = tree(t);
  mkdirSync(join(dir, 'Secret Keys'));
  writeFileSync(join(dir, 'Secret Keys', 'aws.md'), 'x');
  writeFileSync(join(dir, 'server.pem'), 'x');
  writeFileSync(join(dir, '.env'), 'x');
  writeFileSync(join(dir, 'id_rsa'), 'x');
  writeFileSync(join(dir, 'notes.md'), 'x');
  assert.deepEqual([...walkFiles(dir)].map((e) => e.name), ['notes.md']);
});

test('secret filenames are matched whole, not by substring', () => {
  assert.equal(isSecretName('.env'), true);
  assert.equal(isSecretName('.env.local'), true);
  assert.equal(isSecretName('server.pem'), true);
  assert.equal(isSecretName('id_ed25519'), true);
  assert.equal(isSecretName('credentials.json'), true);
  // A document about keys is a document.
  assert.equal(isSecretName('environment-notes.md'), false);
  assert.equal(isSecretName('Keynote deck.pptx'), false);
});

test('extensions are lowercased and bounded', () => {
  assert.equal(extensionOf('Report.PDF'), 'pdf');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('Makefile'), '');
  assert.ok(DOCUMENT_EXTS.includes('pdf') && DOCUMENT_EXTS.includes('docx'));
});

test('an unreadable directory is one directory, not a failed run', (t) => {
  const dir = tree(t);
  writeFileSync(join(dir, 'a.md'), 'x');
  const locked = join(dir, 'locked');
  mkdirSync(locked, { mode: 0o000 });
  try {
    assert.deepEqual([...walkFiles(dir)].map((e) => e.name), ['a.md']);
  } finally {
    // Restored here rather than in an after hook: hooks run in registration
    // order, so the tmpdir cleanup registered by tree() would fire first and
    // fail on the unreadable directory.
    chmodSync(locked, 0o700);
  }
});

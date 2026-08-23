import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readHermesTokenFile,
  readSecretJson,
  readSecretLine,
} from '../lib/secrets.mjs';

const HEX_TOKEN = 'c'.repeat(64);

// mkdtemp directories are created 0700, which is exactly the parent mode the
// loader demands — each test that wants a failing parent loosens it itself.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-secrets-test-'));
  t.after(() => {
    chmodSync(dir, 0o700); // restore before rm in case a test loosened it
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('readSecretLine returns an owner-only one-line secret', (t) => {
  const dir = sandbox(t);
  const file = join(dir, 'granola-api-key.txt');
  writeFileSync(file, 'grn_live_abc123\n', { mode: 0o600 });
  assert.equal(readSecretLine(file, { label: 'Granola API key' }), 'grn_live_abc123');
});

test('readSecretLine rejects group/other-readable files', (t) => {
  const dir = sandbox(t);
  const file = join(dir, 'k.txt');
  writeFileSync(file, 'secret\n', { mode: 0o600 });
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    chmodSync(file, mode);
    assert.throws(
      () => readSecretLine(file, { label: 'test secret' }),
      /group or other users/,
      mode.toString(8)
    );
  }
});

test('readSecretLine rejects a symlink even to a valid secret', (t) => {
  const dir = sandbox(t);
  const real = join(dir, 'real.txt');
  const link = join(dir, 'link.txt');
  writeFileSync(real, 'secret\n', { mode: 0o600 });
  symlinkSync(real, link);
  assert.throws(() => readSecretLine(link, { label: 'test secret' }), /regular, non-symlink/);
});

test('readSecretLine rejects an 0600 file inside a directory others can rewrite', (t) => {
  const dir = sandbox(t);
  const file = join(dir, 'k.txt');
  writeFileSync(file, 'secret\n', { mode: 0o600 });
  chmodSync(dir, 0o770);
  assert.throws(() => readSecretLine(file, { label: 'test secret' }), /must have mode 0700/);
});

test('readSecretLine names the setup fix when the file is missing', (t) => {
  const dir = sandbox(t);
  assert.throws(
    () => readSecretLine(join(dir, 'absent.txt'), { label: 'Oura tokens', setupHint: 'run the oura setup flow' }),
    /Oura tokens file is missing.*run the oura setup flow/
  );
});

test('readSecretLine rejects empty and multi-line files', (t) => {
  const dir = sandbox(t);
  const empty = join(dir, 'empty.txt');
  const multi = join(dir, 'multi.txt');
  writeFileSync(empty, '\n', { mode: 0o600 });
  writeFileSync(multi, 'line one\nline two\n', { mode: 0o600 });
  assert.throws(() => readSecretLine(empty, { label: 'test secret' }), /is empty/);
  assert.throws(() => readSecretLine(multi, { label: 'test secret' }), /exactly one line/);
});

test('readSecretJson returns the parsed object when required keys are present', (t) => {
  const dir = sandbox(t);
  const file = join(dir, 'oura-tokens.json');
  writeFileSync(
    file,
    JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_at: 1766000000 }),
    { mode: 0o600 }
  );
  const tokens = readSecretJson(file, {
    label: 'Oura tokens',
    requiredKeys: ['access_token', 'refresh_token'],
  });
  assert.equal(tokens.access_token, 'at-1');
  assert.equal(tokens.refresh_token, 'rt-1');
});

test('readSecretJson names a missing required key instead of failing later at the API', (t) => {
  const dir = sandbox(t);
  const file = join(dir, 'oura-tokens.json');
  writeFileSync(file, JSON.stringify({ access_token: 'at-1' }), { mode: 0o600 });
  assert.throws(
    () =>
      readSecretJson(file, { label: 'Oura tokens', requiredKeys: ['access_token', 'refresh_token'] }),
    /missing required key "refresh_token"/
  );
  // Present-but-empty is the same failure as absent: a half-written token
  // file must not pass.
  writeFileSync(file, JSON.stringify({ access_token: 'at-1', refresh_token: '' }), { mode: 0o600 });
  assert.throws(
    () =>
      readSecretJson(file, { label: 'Oura tokens', requiredKeys: ['access_token', 'refresh_token'] }),
    /missing required key "refresh_token"/
  );
});

test('readSecretJson rejects malformed JSON and non-object JSON', (t) => {
  const dir = sandbox(t);
  const junk = join(dir, 'junk.json');
  const arr = join(dir, 'arr.json');
  writeFileSync(junk, '{not json', { mode: 0o600 });
  writeFileSync(arr, '["a"]', { mode: 0o600 });
  assert.throws(() => readSecretJson(junk, { label: 'Oura tokens' }), /not valid JSON/);
  assert.throws(() => readSecretJson(arr, { label: 'Oura tokens' }), /JSON object/);
});

test('readSecretJson runs the same permission gauntlet as the line reader', (t) => {
  const dir = sandbox(t);
  const file = join(dir, 'oura-tokens.json');
  writeFileSync(file, JSON.stringify({ access_token: 'x' }), { mode: 0o644 });
  assert.throws(() => readSecretJson(file, { label: 'Oura tokens' }), /group or other users/);
});

test('readHermesTokenFile validates the 64-hex shape hermes generates', (t) => {
  const dir = sandbox(t);
  const good = join(dir, 'hermes-token.txt');
  const bad = join(dir, 'not-hex.txt');
  writeFileSync(good, `${HEX_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(bad, 'not-a-token\n', { mode: 0o600 });
  assert.equal(readHermesTokenFile(good), HEX_TOKEN);
  assert.throws(() => readHermesTokenFile(bad), /256-bit hex/);
  // Uppercase hex is the wrong shape too: hermes compares the exact
  // generated lowercase value.
  const upper = join(dir, 'upper.txt');
  writeFileSync(upper, `${HEX_TOKEN.toUpperCase()}\n`, { mode: 0o600 });
  assert.throws(() => readHermesTokenFile(upper), /256-bit hex/);
});

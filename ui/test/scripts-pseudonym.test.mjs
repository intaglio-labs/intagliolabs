// ui/scripts/build-person-pages.mjs's per-line person pseudonym.
//
// The script's own header used to promise the hash was "never the real key".
// It was sha256(personKey) truncated to 8 hex chars, over a key space that IS
// the people table -- a few thousand legible "name:jane doe" strings -- so
// anyone holding a run's stdout and a list of names recovered every row by
// hashing the list. That is a lookup table, not a pseudonym. These tests pin
// the salt: same box, same grouping; different box, unrelated output; and the
// digest is no longer the bare hash of the key.
//
// The script never opens the database (ui/AGENTS.md: hermes is the sole
// writer), so it is exercised the way it really runs -- spawned, against a
// stub standing in for hermes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-person-pages.mjs');
const PERSON = 'name:jane doe';

function stubHermes() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/admin/relationship/pages/build')) {
      res.end(JSON.stringify({ kept: 1, dropped: 0, skipped: 0, rejected: 0, cost_usd: 0 }));
      return;
    }
    res.end(JSON.stringify({ page: null }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function run(saltPath, { port, tokenFile }) {
  return runRaw(saltPath, { port, tokenFile }).then(({ stdout }) => {
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
    const row = lines.find((l) => typeof l.personKey === 'string');
    if (!row) throw new Error(`no pseudonymised line in output:\n${stdout}`);
    return row.personKey;
  });
}

function runRaw(saltPath, { port, tokenFile }) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT, '--person', PERSON, '--force'],
      {
        env: {
          ...process.env,
          HERMES_TOKEN_FILE: tokenFile,
          HAZLIE_HERMES_URL: `http://127.0.0.1:${port}`,
          HAZLIE_PSEUDONYM_SALT_FILE: saltPath,
        },
        timeout: 30_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(new Error(`${err.message}\n${stderr}`), { stdout, stderr }));
        resolve({ stdout, stderr });
      }
    );
  });
}

test('the person pseudonym is salted from a per-machine secret, created 0600 on first use', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pseudonym-'));
  const tokenFile = join(dir, 'token.txt');
  writeFileSync(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const { server, port } = await stubHermes();
  t.after(() => server.close());

  const saltA = join(dir, 'salt-a.txt');
  const first = await run(saltA, { port, tokenFile });

  const salt = readFileSync(saltA, 'utf8').trim();
  assert.ok(salt.length >= 32, 'the salt file must be created with real entropy in it');
  assert.equal(statSync(saltA).mode & 0o777, 0o600, 'a secret readable by group or other is not a secret');

  // STABLE on the same box: the digest is only useful if two runs group the
  // same person's lines together.
  const second = await run(saltA, { port, tokenFile });
  assert.equal(second, first, 'the same salt file must produce the same pseudonym');

  // UNRELATED on a different box, which is the property the unsalted hash
  // never had: output alone no longer identifies anyone.
  const saltB = join(dir, 'salt-b.txt');
  const elsewhere = await run(saltB, { port, tokenFile });
  assert.notEqual(elsewhere, first, 'a different machine secret must not reproduce the same pseudonym');

  // THE DISCRIMINATOR. This is exactly what the old code printed.
  const unsalted = createHash('sha256').update(PERSON, 'utf8').digest('hex').slice(0, 8);
  assert.notEqual(first, unsalted, 'the bare hash of the key is a lookup table, not a pseudonym');
  assert.notEqual(elsewhere, unsalted);
});

test('a short/truncated salt file fails with a distinct, actionable message', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pseudonym-'));
  const tokenFile = join(dir, 'token.txt');
  writeFileSync(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const { server, port } = await stubHermes();
  t.after(() => server.close());

  const saltPath = join(dir, 'salt-short.txt');
  writeFileSync(saltPath, 'not-enough-entropy\n', { mode: 0o600 });

  await assert.rejects(
    runRaw(saltPath, { port, tokenFile }),
    (err) => {
      assert.match(err.stderr, /salt file too short/u);
      assert.match(err.stderr, new RegExp(saltPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.match(err.stderr, /delete it to regenerate/u);
      return true;
    }
  );
});

test('the run header prints the salt fingerprint once, and it tracks the salt file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pseudonym-'));
  const tokenFile = join(dir, 'token.txt');
  writeFileSync(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const { server, port } = await stubHermes();
  t.after(() => server.close());

  const saltA = join(dir, 'salt-a.txt');
  const { stdout: outA } = await runRaw(saltA, { port, tokenFile });
  const linesA = outA.trim().split('\n').map((l) => JSON.parse(l));
  const fingerprintLinesA = linesA.filter((l) => typeof l.salt === 'string');
  assert.equal(fingerprintLinesA.length, 1, 'the fingerprint must be printed exactly once per run');
  const fp = fingerprintLinesA[0].salt;
  assert.match(fp, /^[0-9a-f]{8}$/u);

  const saltText = readFileSync(saltA, 'utf8').trim();
  const expected = createHash('sha256').update(saltText, 'utf8').digest('hex').slice(0, 8);
  assert.equal(fp, expected, 'the fingerprint must be sha256(salt).slice(0, 8), not the salt itself');
  assert.doesNotMatch(outA, new RegExp(saltText, 'u'), 'the real salt must never reach stdout');

  // A different salt file must fingerprint differently, which is the whole
  // point: it is how a silently-changed salt shows up in a log diff.
  const saltB = join(dir, 'salt-b.txt');
  const { stdout: outB } = await runRaw(saltB, { port, tokenFile });
  const fpB = outB.trim().split('\n').map((l) => JSON.parse(l)).find((l) => typeof l.salt === 'string').salt;
  assert.notEqual(fpB, fp);
});

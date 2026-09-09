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

// ---------------------------------------------------------------------------
// Review F finding 16: THE ERROR BODY THE SCRIPTS ECHOED. sweep-once,
// lint-once and lookup-once printed hermes' entire error body under `body`.
// Hermes writes those messages for a human reading the desk and they quote
// the request back -- a findingKey, a person key, a rejected field's value.
// This stdout is the Distiller's log, which these scripts have no policy
// over, so a failed request now prints the status and one of the scripts'
// own static codes and nothing else.
// ---------------------------------------------------------------------------

const ONCE_SCRIPTS = [
  ['sweep-once.mjs', '/admin/relationship/sweep'],
  ['lint-once.mjs', '/admin/relationship/lint'],
  ['lookup-once.mjs', '/admin/relationship/lookup'],
];

// A hermes that refuses, with a body shaped exactly like badRequest's --
// carrying text no log should hold.
const LEAKY_ERROR = 'no lint finding "role_conflict:441:founder" for name:jane doe';

function refusingHermes(status, body) {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runOnce(script, { port, tokenFile }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(dirname(SCRIPT), script)],
      {
        env: { ...process.env, HERMES_TOKEN_FILE: tokenFile, HAZLIE_HERMES_URL: `http://127.0.0.1:${port}` },
        timeout: 30_000,
      },
      (err, stdout, stderr) => resolve({ stdout, stderr, code: err?.code ?? 0 })
    );
  });
}

function tokenFileFor() {
  const dir = mkdtempSync(join(tmpdir(), 'once-token-'));
  const path = join(dir, 'hermes-token.txt');
  writeFileSync(path, 'a'.repeat(64), { mode: 0o600 });
  return path;
}

for (const [script] of ONCE_SCRIPTS) {
  test(`${script} prints a status and a static code, never hermes' error text`, async () => {
    const { server, port } = await refusingHermes(400, { error: LEAKY_ERROR });
    const tokenFile = tokenFileFor();
    try {
      const { stdout, code } = await runOnce(script, { port, tokenFile });
      assert.equal(code, 1, 'a refused request is still a failed run');
      assert.ok(!stdout.includes('role_conflict:441'), `the finding key reached the log:\n${stdout}`);
      assert.ok(!stdout.includes('name:jane doe'), `a person key reached the log:\n${stdout}`);
      assert.ok(!stdout.includes('no lint finding'), `hermes' message reached the log:\n${stdout}`);
      const printed = JSON.parse(stdout.trim().split('\n').pop());
      assert.deepEqual(printed, { status: 400, code: 'bad-request' });
    } finally {
      server.close();
    }
  });
}

test('the printed code tells the three real failures apart', async () => {
  const tokenFile = tokenFileFor();
  for (const [status, expected] of [[401, 'unauthorized'], [404, 'no-such-route'], [500, 'server-error'],
    [418, 'unexpected-status']]) {
    const { server, port } = await refusingHermes(status, { error: LEAKY_ERROR });
    try {
      const { stdout } = await runOnce('lint-once.mjs', { port, tokenFile });
      const printed = JSON.parse(stdout.trim().split('\n').pop());
      assert.deepEqual(printed, { status, code: expected });
    } finally {
      server.close();
    }
  }
});

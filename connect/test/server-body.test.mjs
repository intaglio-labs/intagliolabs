// The server's body-read failure paths, tested over a real socket — because
// the bug they pin was invisible to any string-level test: readBody used to
// reject AND req.destroy() synchronously, so the 413 was written to a socket
// that was already gone and the client saw ECONNRESET instead of a status
// code (the trap ui/server/hermes.mjs documents on its readJson). And the
// memory handler's catch wrapped JSON.parse too, so malformed JSON from the
// review page's fetch was answered 413 "Too large.".
//
// The server is spawned with --port 0 (a kernel-assigned free port, never a
// production daemon's) and a scratch HOME, so its token store, status reads
// and logs all land in a throwaway directory.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mintToken } from '../lib/tokens.mjs';

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let home;
let child;
let port;
let token;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'connect-server-'));
  ({ token } = mintToken({ path: join(home, '.hazlie', 'connect', 'tokens.json') }));
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/u.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', () => reject(new Error('server exited before listening')));
    setTimeout(() => reject(new Error('server never reported listening')), 10_000).unref();
  });
});

after(() => {
  child?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

test('an oversized form post gets its 413 delivered, not a reset socket', async () => {
  // 16 KB against the 8 KB credential-form limit, well under the hard cap:
  // the server must drain the body and answer on a live connection.
  const res = await fetch(`http://127.0.0.1:${port}/c/${token}/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'claim_id=1&action=accept&pad=' + 'x'.repeat(16 * 1024),
  });
  assert.equal(res.status, 413);
  assert.equal(await res.text(), 'Too large.');
});

test('malformed JSON is a 400 bad decision, not a 413', async () => {
  // The page's fetch sends application/json; a parse failure is the caller's
  // bug, not a size problem, and the keyboard layer shows this text verbatim.
  const res = await fetch(`http://127.0.0.1:${port}/c/${token}/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad decision' });
});

test('the bridge channel answers over-limit bodies 413, not a reset or "bad json"', async () => {
  // Past its 64 KB limit but under the hard cap. readBody rejects before
  // bridgeApiResponse runs, so no bearer is needed and no bridge is touched.
  // 413, not 400: one try used to wrap readBody and JSON.parse together, so
  // an over-limit cookie paste was diagnosed as malformed JSON — the same
  // mislabel the memory route fixed, in mirror image.
  const res = await fetch(`http://127.0.0.1:${port}/api/bridge/cookies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"p":"' + 'x'.repeat(100 * 1024) + '"}',
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'too large' });
});

test('malformed JSON on the bridge channel is still 400 bad json', async () => {
  // The size/parse unbundling must not sweep parse failures into the 413.
  // Parse fails before bridgeApiResponse runs, so no bearer is needed.
  const res = await fetch(`http://127.0.0.1:${port}/api/bridge/cookies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad json' });
});

test('past a hard multiple of the cap the server hangs up rather than drains', async () => {
  // 8x the 64 KB bridge limit: the sender is not a mis-sized form, and the
  // honest answer is to stop reading. The client sees a dropped connection.
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/api/bridge/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"p":"' + 'x'.repeat(600 * 1024) + '"}',
    })
  );
});

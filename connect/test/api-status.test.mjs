import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusResponse } from '../lib/statusApi.mjs';
import { readStatus } from '../lib/status.mjs';

const TOKEN = 'ab'.repeat(32); // 64 hex chars, deliberately not a real secret

function fakeHome(t, { token = TOKEN } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'connect-api-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  if (token !== null) {
    writeFileSync(join(secrets, 'hermes-token.txt'), `${token}\n`, { mode: 0o600 });
    chmodSync(join(secrets, 'hermes-token.txt'), 0o600);
  }
  return home;
}

// ---- the decision, unit-tested without a port ----

test('a valid bearer gets the same truth the page renders', (t) => {
  const home = fakeHome(t);
  const { status, body } = statusResponse({ authorization: `Bearer ${TOKEN}`, home });
  assert.equal(status, 200);
  assert.deepEqual(body.sources, readStatus({ home }));
  assert.ok(body.sources.every((s) => typeof s.connected === 'boolean'));
});

test('any Origin header is refused, even with a valid bearer', (t) => {
  const home = fakeHome(t);
  for (const origin of ['http://localhost:51788', 'null', 'https://evil.example']) {
    const { status } = statusResponse({ origin, authorization: `Bearer ${TOKEN}`, home });
    assert.equal(status, 403, `origin ${origin} must be refused`);
  }
});

test('missing, malformed and wrong bearers all get the same 401', (t) => {
  const home = fakeHome(t);
  for (const authorization of [
    undefined,
    'Bearer ',
    `Bearer ${'z'.repeat(64)}`, // right length, not hex
    `Bearer ${'cd'.repeat(32)}`, // valid shape, wrong token
    `bearer ${TOKEN}`, // wrong scheme case
    TOKEN, // no scheme
  ]) {
    const { status, body } = statusResponse({ authorization, home });
    assert.equal(status, 401, `must reject: ${authorization}`);
    assert.deepEqual(body, { error: 'unauthorized' }, 'one indistinguishable response');
  }
});

test('a missing or malformed token file fails closed', (t) => {
  const noFile = fakeHome(t, { token: null });
  assert.equal(statusResponse({ authorization: `Bearer ${TOKEN}`, home: noFile }).status, 401);
  const badFile = fakeHome(t, { token: 'not-a-token' });
  assert.equal(statusResponse({ authorization: `Bearer ${TOKEN}`, home: badFile }).status, 401);
});

// ---- the wiring, tested against a real spawned server ----
//
// The handler's correctness says nothing about its reachability: the
// /c/<token> regex gate 404s unmatched paths, and the Host allowlist 403s
// before anything else runs — a Host 403 reads exactly like an auth failure.
// So these assertions go through a real socket.

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));

// `--port 0` and read back what the kernel gave us, rather than hardcoding
// 8798 and hoping. A fixed port makes a suite that fails when anything else on
// the machine happens to hold it, and fails again when two runs overlap — a
// flake that looks like a product bug. server.mjs prints the BOUND port on its
// listening line and derives ALLOWED_HOSTS from it, so this is now the same
// pattern hermes uses everywhere else (`start({ port: 0 })`).
let PORT = 0;

function startServer(t, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--port', '0'], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    t.after(() => child.kill());
    child.stdout.on('data', (chunk) => {
      const line = String(chunk);
      const m = line.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/u);
      if (m) {
        PORT = Number(m[1]);
        resolve(child);
        return;
      }
      if (line.includes('listening')) resolve(child);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited early: ${code}`)));
  });
}

function fetchStatus({ headers = {}, hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path: '/api/status', method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    if (hostHeader !== undefined) req.setHeader('host', hostHeader);
    req.on('error', reject);
    req.end();
  });
}

test('the route is reachable above the /c/ gate and end-to-end correct', async (t) => {
  const home = fakeHome(t);
  await startServer(t, home);

  const ok = await fetchStatus({ headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200, `expected 200, got ${ok.status}: ${ok.body}`);
  const parsed = JSON.parse(ok.body);
  assert.ok(Array.isArray(parsed.sources) && parsed.sources.length > 0);

  // A real Origin header on the wire, not just the unit-level shape.
  const browser = await fetchStatus({
    headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${PORT}` },
  });
  assert.equal(browser.status, 403);

  const noAuth = await fetchStatus();
  assert.equal(noAuth.status, 401);

  // Wrong Host is a rebinding refusal (403 before auth) — assert it so a
  // future failure here is not misread as bearer plumbing.
  const rebind = await fetchStatus({
    headers: { authorization: `Bearer ${TOKEN}` },
    hostHeader: 'evil.example:8798',
  });
  assert.equal(rebind.status, 403);

  // The bearer channel never emits CORS headers on any of these responses.
  for (const res of [ok, browser, noAuth, rebind]) {
    const cors = Object.keys(res.headers).filter((h) => h.startsWith('access-control-'));
    assert.deepEqual(cors, [], 'no CORS header may ever appear on this channel');
  }
});

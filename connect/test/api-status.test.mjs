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

function startGoogleAuth({ headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ flow: 'google' });
    const req = httpRequest(
      {
        host: '127.0.0.1', port: PORT, path: '/api/google-auth', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (c) => (responseBody += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
      }
    );
    req.on('error', reject);
    req.end(body);
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

  // Starting an OAuth helper is a side effect and therefore follows the same
  // native-only bearer contract. These fail before any child is spawned.
  const googleNoAuth = await startGoogleAuth();
  assert.equal(googleNoAuth.status, 401);
  assert.deepEqual(JSON.parse(googleNoAuth.body), { error: 'unauthorized' });
  const googleBrowser = await startGoogleAuth({
    headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${PORT}` },
  });
  assert.equal(googleBrowser.status, 403);
  assert.deepEqual(JSON.parse(googleBrowser.body), { error: 'browser channel refused' });
  const googleNative = await startGoogleAuth({
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(googleNative.status, 502, 'auth passes; the scratch home has no Google client credential');

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

// THE ONE ACTIONABLE SENTENCE ON THE MACHINE HAS TO REACH THE OWNER
// (round-6 finding 4).
//
// connectors/lib/googleClients.mjs composes a refusal naming the file, its mode
// and the fix -- and every route to a person ran through a pipe this server
// discarded. ops/gcal-auth.mjs printed it on stderr and exited; the spawn here
// was `stdio: ['ignore','pipe','ignore']`; the owner got "check that the Google
// client credential is installed" about a credential that is installed and
// merely 0644. The opposite of what the machine knew.
//
// Two ways it reaches them now, and this is the first: a client the reader
// refuses is refused HERE, before anything is spawned, with the reason.
test('a credential the reader refuses is refused with its own reason, not a generic 502', async (t) => {
  const home = fakeHome(t);
  const secrets = join(home, '.hazlie', 'secrets');
  // The failing input from the finding: the owner's own client, left
  // world-readable by a restore or an rsync under umask 022.
  const clientPath = join(secrets, 'google-client-work.json');
  writeFileSync(
    clientPath,
    JSON.stringify({ client_id: 'WORK-ID', client_secret: 'WORK-SECRET' }),
    { mode: 0o644 }
  );
  chmodSync(clientPath, 0o644);
  await startServer(t, home);

  // No client named in the body, so the route resolves "default" through the
  // registry -- and `work` is the only client this machine has.
  const out = await startGoogleAuth({ headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(out.status, 400, `expected a refusal, got ${out.status}: ${out.body}`);
  const { error } = JSON.parse(out.body);
  assert.match(error, /google-client-work\.json/u, 'the file the owner has to fix');
  assert.match(error, /group or other users/u, 'and what is wrong with it');
  assert.match(error, /0600/u, 'and the fix');
  assert.doesNotMatch(error, /WORK-SECRET|WORK-ID/u, 'and never the credential itself');
});

test('a helper that will not start says why, in the body the page paints', async (t) => {
  // The second way: nothing on this machine to sign in with at all. The helper
  // is spawned, fails, and prints its own sentence -- which is more specific
  // than the generic one this route used to answer with, and names what to do.
  const home = fakeHome(t);
  await startServer(t, home);
  const out = await startGoogleAuth({ headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(out.status, 502, `expected the helper to fail, got ${out.status}: ${out.body}`);
  const { error } = JSON.parse(out.body);
  assert.match(error, /no Google OAuth client is installed/u,
    'the helper said this on a stderr the server used to discard');
  assert.doesNotMatch(error, /^gcal-auth: /u, 'the process prefix is not a sentence for an owner');
});

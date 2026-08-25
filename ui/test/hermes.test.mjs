import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_ALLOWED_ORIGINS,
  KNOWN_SOURCES,
  defaultDbPath,
  defaultHermesTokenPath,
  insertRows,
  openDb,
  parseAllowedOrigins,
  readHermesToken,
  readLlamaApiKey,
  start,
} from '../server/hermes.mjs';

const TEST_LLAMA_KEY = 'a'.repeat(64);
const TEST_BEARER_TOKEN = 'c'.repeat(64);
const ALLOWED_ORIGIN = 'http://localhost:8081';

let hermes;
let base;
let dir;
// A second, file-backed server for the /admin/* lifecycle tests: purge must be
// able to prove physical cleanliness by scanning the database FILE, and its
// VACUUMs must not shift the row counts the ingest tests above assert on.
let admin;
let adminBase;
let adminDbPath;

// allowedOrigins is passed EXPLICITLY, and that is the point rather than
// boilerplate. DEFAULT_ALLOWED_ORIGINS is empty as of 2026-08-23, so a server
// started without this line trusts no browser origin at all -- which is the
// correct posture for a real install and the wrong one for the suite below,
// which deliberately exercises the browser channel. Naming it here means a test
// that uses ALLOWED_ORIGIN is testing a capability somebody switched on, not one
// it inherited from a default that outlived the app it was written for.
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-test-'));
  hermes = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
    allowedOrigins: ALLOWED_ORIGIN,
  });
  base = `http://127.0.0.1:${hermes.port}`;
  adminDbPath = join(dir, 'admin.db');
  admin = await start({
    port: 0,
    dbPath: adminDbPath,
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
    allowedOrigins: ALLOWED_ORIGIN,
  });
  adminBase = `http://127.0.0.1:${admin.port}`;
});

after(async () => {
  await hermes?.close();
  await admin?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The bearer channel: a token and deliberately NO Origin header.
const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_BEARER_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

const authedGet = (path) =>
  fetch(base + path, { headers: { Authorization: `Bearer ${TEST_BEARER_TOKEN}` } });

// /health no longer carries the row count, so this is the only oracle left that
// can observe an ingested row -- which is exactly why it needs auth.
const rowCount = async () => (await (await authedGet('/stats')).json()).rows;

test('health is unauthenticated and discloses no row count', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  // `rows` is a monotone counter over a household audio corpus: it reports when
  // the house is talking without disclosing a word. It must not come back.
  assert.equal('rows' in body, false);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('stats requires authentication and reports the row count', async () => {
  assert.equal((await fetch(`${base}/stats`)).status, 401);
  const res = await authedGet('/stats');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    rows: 0,
    // Ingesting rows and being able to ANSWER about them are different things,
    // and reporting only the first is what made a half-built memory look
    // finished — full database, zero claims, every question abstaining, and no
    // way to tell busy from broken. An empty store is 'idle': nothing read and
    // nothing waiting, so there is no progress to claim.
    memory: {
      claims: 0,
      // Distilled is not accepted. v_claim_accepted needs a claim_decision, and
      // retrieve.mjs reads that view and nothing else — so `review` is the count
      // standing between a claim and an answer, and it is reported separately
      // from `claims` because they were silently the same number for 119 claims.
      accepted: 0,
      review: 0,
      runs: 0, done: 0, pending: 0, total: 0, running: false, state: 'idle',
    },
  });
});

test('stats reports work still to do as "reading", not as an empty memory', async () => {
  // Its OWN store and server: this test writes a row, and the suite above asserts
  // an empty one. Sharing the database would make the pair order-dependent.
  const progressDb = join(dir, 'progress.db');
  const srv = await start({
    port: 0,
    dbPath: progressDb,
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
    allowedOrigins: ALLOWED_ORIGIN,
  });
  try {
    // One owner-authored note, nothing distilled — the exact state somebody is in
    // right after granting access, and the one the UI has to be able to name.
    const store = new DatabaseSync(progressDb);
    const now = Date.now();
    store
      .prepare(
        'INSERT INTO context(ts, source, speaker, text, meta, store_changed_at) ' +
          "VALUES (?, 'notes', 'me', 'a note the owner wrote', '{}', ?)"
      )
      .run(now, now);
    store.close();

    const res = await fetch(`http://127.0.0.1:${srv.port}/stats`, {
      headers: { Authorization: `Bearer ${TEST_BEARER_TOKEN}` },
    });
    const body = await res.json();
    assert.equal(body.rows, 1);
    assert.equal(body.memory.done, 0);
    assert.equal(body.memory.pending, 1, 'a row nobody has read yet is pending');
    assert.equal(body.memory.total, 1);
    assert.equal(body.memory.state, 'reading', 'pending work is "reading", never "idle"');
    assert.equal(body.memory.review, 0, 'nothing distilled yet, so nothing to review');
  } finally {
    await srv.close();
  }
});

// --- the new authorization rule -------------------------------------------
// No test named the old absent-Origin rule; four tests silently DEPENDED on it,
// which is how the hole survived. These four name it.

test('an Origin-less request with no token is rejected', async () => {
  const res = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'sneaky', text: 'no origin, no token' }),
  });
  assert.equal(res.status, 401);
  assert.equal(await rowCount(), 0);
});

test('an Origin-less request with a valid bearer token is accepted', async () => {
  const res = await authedGet('/stats');
  assert.equal(res.status, 200);
});

test('an Origin-less request with a wrong bearer token is rejected', async () => {
  for (const value of [
    `Bearer ${'d'.repeat(64)}`, // right shape, wrong token
    `Bearer ${TEST_BEARER_TOKEN.toUpperCase()}`, // hex must be lowercase
    `Bearer ${TEST_BEARER_TOKEN}extra`,
    `Bearer short`,
    TEST_BEARER_TOKEN, // no scheme
    '',
  ]) {
    const res = await fetch(`${base}/stats`, { headers: { Authorization: value } });
    assert.equal(res.status, 401, JSON.stringify(value));
  }
});

test('an allowlisted Origin is accepted with no token, and its Authorization is ignored', async () => {
  const bare = await fetch(`${base}/stats`, { headers: { Origin: ALLOWED_ORIGIN } });
  assert.equal(bare.status, 200);
  // Origin present means a browser sent it, so the token channel is not even
  // consulted -- a page cannot hold the token and must not be asked to.
  const withGarbage = await fetch(`${base}/stats`, {
    headers: { Origin: ALLOWED_ORIGIN, Authorization: 'Bearer nonsense' },
  });
  assert.equal(withGarbage.status, 200);
});

test('a non-allowlisted Origin is rejected even with a valid token', async () => {
  // Uniform 401 rather than 403: distinguishing "not allowlisted" from "no
  // credential" would report the contents of the allowlist to whoever asks.
  const res = await fetch(`${base}/stats`, {
    headers: {
      Origin: 'https://evil.example',
      Authorization: `Bearer ${TEST_BEARER_TOKEN}`,
    },
  });
  assert.equal(res.status, 401);
});

// --- removed routes --------------------------------------------------------

test('the corpus read routes and the unlaned model path are gone', async () => {
  for (const path of ['/search?q=waffle', '/recent?limit=3']) {
    const res = await authedGet(path);
    assert.equal(res.status, 410, path);
    assert.match((await res.json()).error, /removed/);
  }
  const unlaned = await post('/v1/chat/completions', { stream: true });
  assert.equal(unlaned.status, 410);
  // The message has to name the replacement or the next reader guesses.
  assert.match((await unlaned.json()).error, /lane\/local/);
});

// --- unchanged behaviour ---------------------------------------------------

test('default database path is private runtime state outside the repo', () => {
  assert.equal(
    defaultDbPath('/Users/example'),
    join('/Users/example', '.hazlie', 'context', 'context.db')
  );
});

test('default token path is private runtime state outside the repo', () => {
  assert.equal(
    defaultHermesTokenPath('/Users/example'),
    join('/Users/example', '.hazlie', 'secrets', 'hermes-token.txt')
  );
});

test('file-backed databases enforce private directory and file modes', {
  skip: process.platform === 'win32',
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hermes-mode-test-'));
  const dbPath = join(sandbox, 'private', 'context.db');
  const beforeUmask = process.umask();
  try {
    const db = openDb(dbPath);
    db.close();
    assert.equal(statSync(dirname(dbPath)).mode & 0o777, 0o700);
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
    assert.equal(process.umask(), beforeUmask);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('storage is hardened so deleted text does not survive in the free list', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hermes-harden-test-'));
  const db = openDb(join(sandbox, 'context.db'));
  try {
    // secure_delete only zeroes pages freed AFTER it is on, which is why the
    // one-time VACUUM is marked with user_version rather than skipped.
    assert.equal(Number(db.prepare('PRAGMA secure_delete').get().secure_delete), 1);
    // Asserted on a file-backed database specifically: an in-memory one always
    // reports journal_mode=memory and has no sidecar to worry about. The
    // sidecar is the whole point -- a -wal file would hold the same household
    // text at whatever mode SQLite chose, and openDb only chmods the main file.
    assert.equal(
      String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(),
      'delete'
    );
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8);
  } finally {
    db.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('in-memory databases are hardened too, minus what SQLite will not allow', () => {
  // The :memory: branch of openDb used to skip every hardening step. It cannot
  // take journal_mode=DELETE (SQLite forces `memory`), which is fine -- there is
  // no file to leave a sidecar beside.
  const db = openDb(':memory:');
  try {
    assert.equal(Number(db.prepare('PRAGMA secure_delete').get().secure_delete), 1);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8);
  } finally {
    db.close();
  }
});

test('secret loader rejects permissive files and accepts an owner-only key', {
  skip: process.platform === 'win32',
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hermes-key-test-'));
  const keyPath = join(sandbox, 'llama-api-key.txt');
  try {
    writeFileSync(keyPath, `${TEST_LLAMA_KEY}\n`, { mode: 0o600 });
    assert.equal(readLlamaApiKey(keyPath), TEST_LLAMA_KEY);
    chmodSync(keyPath, 0o644);
    assert.throws(() => readLlamaApiKey(keyPath), /group or other users/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('secret loader rejects an owner-only file in a directory anyone can rewrite', {
  skip: process.platform === 'win32',
}, () => {
  // The check the llama key loader never had. An 0600 file inside a
  // group-writable directory is not owner-only: whoever can write the
  // directory can replace the file with their own.
  const sandbox = mkdtempSync(join(tmpdir(), 'hermes-dir-test-'));
  const tokenPath = join(sandbox, 'hermes-token.txt');
  try {
    writeFileSync(tokenPath, `${TEST_BEARER_TOKEN}\n`, { mode: 0o600 });
    assert.equal(readHermesToken(tokenPath), TEST_BEARER_TOKEN);
    chmodSync(sandbox, 0o770);
    assert.throws(() => readHermesToken(tokenPath), /must have mode 0700/);
  } finally {
    chmodSync(sandbox, 0o700);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('secret loader rejects a symlink, a bad shape, and a missing file', {
  skip: process.platform === 'win32',
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hermes-secret-test-'));
  const real = join(sandbox, 'real.txt');
  const link = join(sandbox, 'link.txt');
  const junk = join(sandbox, 'junk.txt');
  try {
    writeFileSync(real, `${TEST_BEARER_TOKEN}\n`, { mode: 0o600 });
    // lstat, not stat: a symlink is rejected rather than followed to a target
    // whose own mode says nothing about who can retarget the link.
    symlinkSync(real, link);
    assert.throws(() => readHermesToken(link), /regular, non-symlink file/);
    writeFileSync(junk, 'not-a-key\n', { mode: 0o600 });
    assert.throws(() => readHermesToken(junk), /256-bit hex key/);
    assert.throws(
      () => readHermesToken(join(sandbox, 'absent.txt')),
      /is missing; run ops\/setup-llm\.sh/
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('CORS allowlist defaults to EMPTY and accepts configuration', () => {
  assert.deepEqual([...parseAllowedOrigins()], []);
  assert.deepEqual([...DEFAULT_ALLOWED_ORIGINS], []);
  assert.deepEqual(
    [...parseAllowedOrigins('http://localhost:9090, https://console.example')],
    ['http://localhost:9090', 'https://console.example']
  );
  assert.throws(
    () => parseAllowedOrigins('http://localhost:8081/not-an-origin'),
    /must be HTTP\(S\) origins/
  );
});

// The guard that has to FIRE, not merely pass on a tree that is already correct.
// Before 2026-08-23 a default install trusted http://localhost:8081 with no token,
// because the Expo dev app needed it -- and that app was deleted without the
// exemption being withdrawn. This test is what makes putting it back a red suite:
// a server configured with nothing must refuse the exact Origin that used to be
// a free pass, while the bearer channel keeps working through the same server.
test('a default server trusts NO browser origin, and still serves the bearer channel', async () => {
  const bare = await start({
    port: 0,
    dbPath: ':memory:',
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
  });
  try {
    const bareBase = `http://127.0.0.1:${bare.port}`;

    // The retired Expo origin: no longer a caller, no longer trusted.
    for (const origin of ['http://localhost:8081', 'http://127.0.0.1:8081']) {
      const res = await fetch(`${bareBase}/stats`, { headers: { Origin: origin } });
      assert.equal(res.status, 401, `${origin} must not authorize by Origin alone`);
      const cors = await fetch(`${bareBase}/stats`, { headers: { Origin: origin } });
      assert.equal(
        cors.headers.get('access-control-allow-origin'),
        null,
        `${origin} must not be reflected`
      );
    }

    // An Origin-less bearer caller is unaffected -- this is how the widget,
    // connect, the connectors daemon and the CLIs all arrive.
    const ok = await fetch(`${bareBase}/stats`, {
      headers: { Authorization: `Bearer ${TEST_BEARER_TOKEN}` },
    });
    assert.equal(ok.status, 200, 'the bearer channel must survive an empty allowlist');

    // And /health stays the one unauthenticated route.
    assert.equal((await fetch(`${bareBase}/health`)).status, 200);
  } finally {
    await bare.close();
  }
});

test('a configured CORS origin replaces rather than widens the defaults', async () => {
  const custom = await start({
    port: 0,
    dbPath: ':memory:',
    allowedOrigins: 'http://localhost:9090',
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
  });
  const customBase = `http://127.0.0.1:${custom.port}`;
  try {
    const configured = await fetch(`${customBase}/health`, {
      headers: { Origin: 'http://localhost:9090' },
    });
    assert.equal(
      configured.headers.get('access-control-allow-origin'),
      'http://localhost:9090'
    );
    const oldDefault = await fetch(`${customBase}/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(oldDefault.headers.get('access-control-allow-origin'), null);
  } finally {
    await custom.close();
  }
});

test('hermes refuses to start without a readable bearer token', async () => {
  await assert.rejects(
    start({
      port: 0,
      dbPath: ':memory:',
      llamaApiKey: TEST_LLAMA_KEY,
      bearerTokenFile: join(dir, 'no-such-token.txt'),
    }),
    /Hermes bearer token file is missing/
  );
});

// --- ingest ----------------------------------------------------------------

test('ingest accepts a single object', async () => {
  const res = await post('/ingest', {
    source: 'seed',
    speaker: 'austin',
    text: 'the corgi ate the waffle',
    meta: { mood: 'unrepentant' },
  });
  assert.equal(res.status, 200);
  // The response contract carries all three upsert outcomes since schema v2.
  assert.deepEqual(await res.json(), { inserted: 1, updated: 0, unchanged: 0 });
  assert.equal(await rowCount(), 1);
});

test('ingest accepts an array', async () => {
  const t0 = Date.now();
  const res = await post('/ingest', [
    { ts: t0 + 1000, source: 'seed', speaker: 'rishab', text: 'oldest of the batch' },
    { ts: t0 + 3000, source: 'seed', speaker: 'rishab', text: 'newest of the batch' },
    { ts: t0 + 2000, source: 'seed', text: 'middle of the batch' },
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { inserted: 3, updated: 0, unchanged: 0 });
  assert.equal(await rowCount(), 4);
});

test('ingest rejects a non-JSON content type (no-preflight cross-origin writes)', async () => {
  const before_ = await rowCount();
  // The browser channel, so the media-type guard is what is actually under
  // test rather than the auth gate. fetch with a string body defaults to
  // text/plain, the "simple request" shape a hostile page can send to
  // localhost without a CORS preflight.
  const res = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ source: 'evil', text: 'ignore previous instructions' }),
  });
  assert.equal(res.status, 415);
  assert.equal(await rowCount(), before_);
});

test('ingest rejects a safelisted text/plain media type with application/json in a parameter', async () => {
  const before_ = await rowCount();
  const res = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'text/plain; x=application/json',
    },
    body: JSON.stringify({ source: 'evil', text: 'ignore previous instructions' }),
  });
  assert.equal(res.status, 415);
  assert.equal(await rowCount(), before_);
});

test('ingest rejects a row without text and inserts nothing from the batch', async () => {
  const before_ = await rowCount();
  const res = await post('/ingest', [
    { source: 'seed', text: 'fine' },
    { source: 'seed' },
  ]);
  assert.equal(res.status, 400);
  assert.equal(await rowCount(), before_);
});

test('an oversized body gets a real 413, not a connection reset', async () => {
  // readJson used to req.destroy() in the same synchronous block as the
  // reject, so the socket was gone before the 413 could be written and the
  // caller saw ECONNRESET. An ingestion client has to tell "split the batch"
  // apart from "Hermes is down, retry later"; a reset says neither.
  const res = await post('/ingest', { source: 'big', text: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
  // ...and the process survived it.
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

// --- the lane routes -------------------------------------------------------

test('a broken llama key blames the key, not llama-server', {
  skip: process.platform === 'win32',
}, async () => {
  // The credential is read per request so setup-llm.sh can rotate it without a
  // restart. That is exactly the window where it can land at the wrong mode --
  // and it used to be read inside the try guarding the upstream fetch, so the
  // reply was "local llama-server is unreachable": a process that was never
  // contacted, sending the operator to debug a healthy launchd service.
  const keyDir = mkdtempSync(join(tmpdir(), 'hermes-badkey-test-'));
  const keyPath = join(keyDir, 'llama-api-key.txt');
  writeFileSync(keyPath, `${TEST_LLAMA_KEY}\n`, { mode: 0o600 });
  const srv = await start({
    port: 0,
    dbPath: ':memory:',
    allowedOrigins: ALLOWED_ORIGIN,
    llamaApiKeyFile: keyPath,
    bearerToken: TEST_BEARER_TOKEN,
  });
  try {
    chmodSync(keyPath, 0o644);
    const res = await fetch(`http://127.0.0.1:${srv.port}/lane/local/v1/chat/completions`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    const body = await res.json();
    assert.match(body.error, /group or other users/);
    assert.doesNotMatch(body.error, /unreachable/);
  } finally {
    await srv.close();
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test('the local lane proxies with server auth and streams; the cloud lane refuses', async () => {
  let upstreamRequests = 0;
  const upstreamAuth = [];
  let upstreamType = null;
  const upstream = createServer((req, res) => {
    upstreamRequests += 1;
    upstreamAuth.push(req.headers.authorization);
    upstreamType = req.headers['content-type'];
    req.once('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
    req.resume();
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const keyDir = mkdtempSync(join(tmpdir(), 'hermes-proxy-key-test-'));
  const keyPath = join(keyDir, 'llama-api-key.txt');
  writeFileSync(keyPath, `${TEST_LLAMA_KEY}\n`, { mode: 0o600 });
  const proxy = await start({
    port: 0,
    dbPath: ':memory:',
    allowedOrigins: ALLOWED_ORIGIN,
    llamaBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    llamaApiKeyFile: keyPath,
    bearerToken: TEST_BEARER_TOKEN,
  });
  const proxyBase = `http://127.0.0.1:${proxy.port}`;
  const LOCAL = '/lane/local/v1/chat/completions';
  try {
    const badOrigin = await fetch(proxyBase + LOCAL, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(badOrigin.status, 401);

    const disguisedPlaintext = await fetch(proxyBase + LOCAL, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'text/plain; x=application/json' },
      body: '{}',
    });
    assert.equal(disguisedPlaintext.status, 415);
    assert.equal(upstreamRequests, 0);

    // The cloud lane refuses before it can reach anything, and specifically
    // does NOT quietly fall through to the local model.
    const cloud = await fetch(proxyBase + '/lane/cloud/v1/chat/completions', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    assert.equal(cloud.status, 501);
    assert.equal(upstreamRequests, 0);

    const streamed = await fetch(proxyBase + LOCAL, {
      method: 'POST',
      headers: {
        // A page cannot influence what Hermes presents upstream: on the browser
        // channel Authorization is never read, and the llama key is injected
        // server-side regardless.
        Authorization: 'Bearer client-must-not-control-this',
        Origin: ALLOWED_ORIGIN,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ stream: true }),
    });
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(streamed.headers.get('cache-control'), 'no-store');
    assert.match(streamed.headers.get('content-type'), /^text\/event-stream/);
    assert.match(await streamed.text(), /data: \[DONE\]/);
    assert.equal(upstreamRequests, 1);
    assert.equal(upstreamAuth[0], `Bearer ${TEST_LLAMA_KEY}`);
    assert.equal(upstreamType, 'application/json');

    const rotatedKey = 'b'.repeat(64);
    writeFileSync(keyPath, `${rotatedKey}\n`, { mode: 0o600 });
    const afterRotation = await fetch(proxyBase + LOCAL, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    assert.equal(afterRotation.status, 200);
    await afterRotation.text();
    assert.equal(upstreamAuth[1], `Bearer ${rotatedKey}`);
  } finally {
    await proxy.close();
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(keyDir, { recursive: true, force: true });
  }
});

// --- CORS and transport ----------------------------------------------------

test('cross-origin from a non-local origin gets no CORS headers', async () => {
  const res = await fetch(`${base}/health`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('a local dev origin gets reflected CORS headers', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: ALLOWED_ORIGIN } });
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
});

test('a different localhost port is not allowed by the default CORS policy', async () => {
  const res = await fetch(`${base}/health`, {
    headers: { Origin: 'http://localhost:8082' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('preflight responses carry privacy headers and are never gated on auth', async () => {
  // Preflights never carry Authorization. Gating them would break every real
  // browser, which is why authorize() sits below the OPTIONS branch.
  const res = await fetch(`${base}/ingest`, {
    method: 'OPTIONS',
    headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
});

test('a .local mDNS origin gets no CORS headers', async () => {
  const res = await fetch(`${base}/health`, {
    headers: { Origin: 'http://printer.local' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('a malformed Host header gets a 400, not a dead server', async () => {
  // fetch normalizes Host, so speak raw HTTP; a space is a legal header value
  // that WHATWG URL refuses to parse as a hostname. This must stay a 400 and
  // not become a 401: the URL parse guard is what keeps the household's 24/7
  // memory process alive, and an auth check above it would silently retire it.
  const reply = await new Promise((resolve, reject) => {
    const sock = createConnection(hermes.port, '127.0.0.1', () => {
      sock.write('GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
  // The process survived: a normal request still answers.
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

// --- entity upsert (schema v2) ----------------------------------------------

const ftsHits = (db, term) =>
  Number(
    db
      .prepare('SELECT count(*) AS n FROM context_fts WHERE context_fts MATCH ?')
      .get(`"${term}"`).n
  );

test('redelivering the same entity batch is all-unchanged', async () => {
  const batch = [
    {
      ts: 1755500000000,
      source: 'seed',
      entity_id: 'test:up-1',
      text: 'first entity row',
      meta: { room: 'kitchen' },
    },
    {
      ts: 1755500001000,
      source: 'seed',
      entity_id: 'test:up-2',
      speaker: 'parent',
      text: 'second entity row',
    },
  ];
  const first = await post('/ingest', batch);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { inserted: 2, updated: 0, unchanged: 0 });
  const count = await rowCount();
  // A retry after a lost response is the whole point of the upsert: redelivery
  // must change nothing and say so.
  const second = await post('/ingest', batch);
  assert.deepEqual(await second.json(), { inserted: 0, updated: 0, unchanged: 2 });
  assert.equal(await rowCount(), count);
});

// --- the write path refuses what the delete path cannot handle -------------
// Four guards added 2026-08-22. Until then /ingest accepted rows that every
// /admin/* route would then refuse to touch, so "writable" and "deletable"
// were different predicates and the gap was invisible until someone needed to
// delete something.

test('an unknown source is refused — a row hermes could never delete', async () => {
  const res = await post('/ingest', { source: 'nope', text: 'x' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /unknown source/u);
});

test('an unknown field is refused, so a typo cannot become a duplicate insert', async () => {
  // The specific failure: `entityId` instead of `entity_id` used to be
  // dropped silently, taking the plain-insert branch on every poll and growing
  // one duplicate per delivery — with counts that read as healthy, because
  // `inserted` is exactly what an insert reports.
  const res = await post('/ingest', {
    source: 'seed',
    text: 'x',
    ts: 1755500900000,
    entityId: 'typo:1',
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /unknown field .*entityId/u);
});

test('a keyed row without ts is refused — it would delete its own accepted claims', async () => {
  // The footgun connectors/AGENTS.md warned about in prose and nothing
  // enforced: ts defaults to Date.now() and ts is in the content hash, so a
  // redelivered entity row hashed differently every time, read as an edit, and
  // took the owner's accepted claims and their decision history with it. Every
  // poll. Silently.
  const res = await post('/ingest', { source: 'seed', entity_id: 'keyed:no-ts', text: 'x' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /must carry/u);
});

test('two sources may share an entity_id without overwriting each other', async () => {
  // Entity ids are unique only WITHIN a source, and shapes like
  // `health:<metric>:<date>` collide easily. The upsert used to match on
  // entity_id alone, so the second source's delivery overwrote the first
  // source's row in place — destroying its accepted claims and leaving a row
  // its real owner could no longer delete, because /admin/delete-entities keys
  // on (source, entity_id).
  const ts = 1755500910000;
  const shared = 'collide:1';
  const a = await post('/ingest', { ts, source: 'notes', entity_id: shared, text: 'the notes row' });
  const b = await post('/ingest', { ts, source: 'files', entity_id: shared, text: 'the files row' });
  assert.deepEqual(await a.json(), { inserted: 1, updated: 0, unchanged: 0 });
  assert.deepEqual(
    await b.json(),
    { inserted: 1, updated: 0, unchanged: 0 },
    'the second source must INSERT its own row, not update the first source\'s'
  );

  // And each still redelivers as unchanged against its own row rather than
  // flip-flopping with the other.
  const again = await post('/ingest', { ts, source: 'notes', entity_id: shared, text: 'the notes row' });
  assert.deepEqual(await again.json(), { inserted: 0, updated: 0, unchanged: 1 });
});

test('a property-reordered payload hashes canonical and lands unchanged', async () => {
  const ts = 1755500002000;
  const original = {
    ts,
    source: 'seed',
    entity_id: 'test:canon-1',
    speaker: null,
    text: 'canonical row',
    meta: { a: 1, b: { c: 2, d: [3, 4] } },
  };
  // The same logical row: keys reordered at every depth, and the null speaker
  // simply missing -- null and absent must be the same absence.
  const reordered = {
    meta: { b: { d: [3, 4], c: 2 }, a: 1 },
    text: 'canonical row',
    entity_id: 'test:canon-1',
    source: 'seed',
    ts,
  };
  assert.deepEqual(await (await post('/ingest', original)).json(), {
    inserted: 1,
    updated: 0,
    unchanged: 0,
  });
  assert.deepEqual(await (await post('/ingest', reordered)).json(), {
    inserted: 0,
    updated: 0,
    unchanged: 1,
  });
});

test('an edited entity row is updated in place and FTS follows the new text', async () => {
  const ts = 1755500003000;
  const id = 'test:edit-1';
  await post('/ingest', { ts, source: 'seed', entity_id: id, text: 'the heliotrope condor nested' });
  assert.equal(ftsHits(hermes.db, 'heliotrope'), 1);
  const before_ = await rowCount();
  const res = await post('/ingest', {
    ts,
    source: 'seed',
    entity_id: id,
    text: 'the vermilion condor relocated',
  });
  assert.deepEqual(await res.json(), { inserted: 0, updated: 1, unchanged: 0 });
  // In place: same logical row, no duplicate.
  assert.equal(await rowCount(), before_);
  assert.equal(
    hermes.db.prepare('SELECT text FROM context WHERE entity_id = ?').get(id).text,
    'the vermilion condor relocated'
  );
  // The context_au trigger moved the index entry: findable under the new
  // text, and NOT under the old.
  assert.equal(ftsHits(hermes.db, 'vermilion'), 1);
  assert.equal(ftsHits(hermes.db, 'heliotrope'), 0);
});

test('rows without entity_id always insert and never collide', async () => {
  const row = { ts: 1755500004000, source: 'seed', text: 'identical unkeyed row' };
  assert.deepEqual(await (await post('/ingest', row)).json(), {
    inserted: 1,
    updated: 0,
    unchanged: 0,
  });
  assert.deepEqual(await (await post('/ingest', row)).json(), {
    inserted: 1,
    updated: 0,
    unchanged: 0,
  });
  const { n } = hermes.db
    .prepare("SELECT count(*) AS n FROM context WHERE text = 'identical unkeyed row'")
    .get();
  assert.equal(Number(n), 2);
});

test('a malformed entity_id rejects the whole batch and names the row', async () => {
  const before_ = await rowCount();
  for (const bad of [42, '', {}, ['x'], true]) {
    const res = await post('/ingest', [
      { source: 'seed', text: 'fine' },
      { source: 'seed', text: 'bad id', entity_id: bad },
    ]);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match((await res.json()).error, /ingest\[1\]: "entity_id"/);
  }
  assert.equal(await rowCount(), before_);
});

// --- v1 -> v2 migration ------------------------------------------------------

// The exact v1 shape, copied rather than imported: the point is to hand-build
// the database an OLD hermes.mjs left behind, not whatever today's SCHEMA
// happens to be.
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS context(
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  source  TEXT NOT NULL,
  speaker TEXT,
  text    TEXT NOT NULL,
  meta    TEXT
);
CREATE INDEX IF NOT EXISTS context_ts ON context(ts DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  text, content='context', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS context_ai AFTER INSERT ON context BEGIN
  INSERT INTO context_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS context_ad AFTER DELETE ON context BEGIN
  INSERT INTO context_fts(context_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS context_au AFTER UPDATE ON context BEGIN
  INSERT INTO context_fts(context_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO context_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

test('a v1 database migrates in place to v8 with its rows preserved', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hermes-migrate-test-'));
  const dbPath = join(sandbox, 'context.db');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(V1_SCHEMA);
    legacy
      .prepare('INSERT INTO context(ts, source, speaker, text, meta) VALUES (?, ?, ?, ?, ?)')
      .run(1700000000000, 'seed', 'parent', 'row from before the upsert era', null);
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();

    const db = openDb(dbPath);
    try {
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8);
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('context')")
        .all()
        .map((c) => c.name);
      assert.ok(columns.includes('entity_id'), 'entity_id column added');
      assert.ok(columns.includes('content_hash'), 'content_hash column added');
      assert.ok(columns.includes('store_changed_at'), 'store_changed_at column added');
      const index = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'context_entity'")
        .get();
      assert.ok(index, 'partial unique index exists');
      assert.match(index.sql, /UNIQUE/);
      assert.match(index.sql, /WHERE entity_id IS NOT NULL/);
      const row = db.prepare('SELECT * FROM context').get();
      assert.equal(row.text, 'row from before the upsert era');
      assert.equal(row.source, 'seed');
      assert.equal(Number(row.ts), 1700000000000);
      assert.equal(row.entity_id, null);
      // THE BACKFILL IS THE MIGRATION INSTANT, NOT `ts`. This row's ts is
      // 2023-11-14; had the backfill copied it, a distillation cursor would
      // start three years in the past and re-propose the whole corpus. The
      // live failure runs the other way and is worse: 46 rows in the real
      // corpus carry FUTURE ts values, up to ~2026-10-13, and a cursor seeded
      // from those skips every real write until the calendar catches up.
      assert.ok(
        Number(row.store_changed_at) > Number(row.ts),
        'store_changed_at must be the migration instant, not the event time'
      );
      assert.ok(
        Math.abs(Number(row.store_changed_at) - Date.now()) < 60_000,
        'backfilled within a minute of the migration'
      );
      const cursorIndex = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'context_changed'")
        .get();
      assert.ok(cursorIndex, 'the cursor index exists on the migrated file');
      const sourceTsIndex = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'context_source_ts'")
        .get();
      assert.ok(sourceTsIndex, 'the per-source time index exists on the migrated file');
      assert.match(sourceTsIndex.sql, /\(source, ts, entity_id\)/);
      // ...and the upsert machinery works on the migrated file.
      const entityRow = {
        ts: 1700000001000,
        source: 'seed',
        entity_id: 'seed:m1',
        text: 'post-migration entity row',
      };
      assert.deepEqual(insertRows(db, entityRow), { inserted: 1, updated: 0, unchanged: 0 });
      assert.deepEqual(insertRows(db, entityRow), { inserted: 0, updated: 0, unchanged: 1 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// --- admin lifecycle routes --------------------------------------------------
// These run against the dedicated file-backed `admin` server: purge proves
// physical cleanliness by scanning the database file, and its VACUUMs must not
// disturb the row counts the ingest tests assert on.

const adminPost = (path, body) =>
  fetch(adminBase + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_BEARER_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

const adminGet = (path) =>
  fetch(adminBase + path, { headers: { Authorization: `Bearer ${TEST_BEARER_TOKEN}` } });

test('every admin route refuses the browser channel with a 403', async () => {
  const attempts = [
    ['POST', '/admin/retain', { source: 'seed', keep_days: 30 }],
    ['POST', '/admin/purge', { source: 'seed' }],
    ['POST', '/admin/delete-entities', { source: 'seed', entity_ids: ['seed:x'] }],
    ['POST', '/admin/maintain', {}],
    ['GET', '/admin/entities?source=seed', undefined],
  ];
  for (const [method, path, body] of attempts) {
    // An allowlisted Origin -- a caller authorize() ACCEPTS as the browser
    // channel. The refusal under test is capability, not authentication.
    const res = await fetch(adminBase + path, {
      method,
      headers: {
        Origin: ALLOWED_ORIGIN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(res.status, 403, path);
    assert.match((await res.json()).error, /bearer-only/);
  }
});

// --- people routes ---------------------------------------------------------
// Phase 1's /people/* handlers read the whole corpus into a people map and
// WRITE the owner's merge decisions — bearer-only, exactly like /admin. The
// admin gate above has a test whose only job is to prove the 403 fires; the
// people gate gets the same, so a dispatch reorder or a loosened check cannot
// silently hand these routes to the browser channel.

test('every people route refuses the browser channel with a 403', async () => {
  const attempts = [
    ['POST', '/people/init', { days: 0 }],
    ['GET', '/people/review?days=0', undefined],
    ['GET', '/people/map', undefined],
    ['POST', '/people/decide', { verdict: 'skip', a: 'x', b: 'y' }],
  ];
  for (const [method, path, body] of attempts) {
    // An allowlisted Origin — a caller authorize() ACCEPTS as the browser
    // channel. The refusal under test is capability, not authentication.
    const res = await fetch(base + path, {
      method,
      headers: {
        Origin: ALLOWED_ORIGIN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(res.status, 403, path);
    assert.match((await res.json()).error, /bearer-only/);
    // A bearer token does not rescue the request: an Origin header makes it
    // the browser channel (authorize() reads Origin first), and the browser
    // channel is not entitled here no matter what else it carries.
    const both = await fetch(base + path, {
      method,
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(both.status, 403, `${path} with bearer+Origin`);
  }
});

test('people routes reject unknown fields, and the bearer channel answers', async (t) => {
  // Point HOME at a sandbox for the duration: the people handlers read
  // ~/.hazlie per request (owner config, connectors state, resolutions
  // store), and a test must not read or create anything under the real one.
  const home = mkdtempSync(join(tmpdir(), 'hermes-people-home-'));
  const prevHome = process.env.HOME;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;

  // {day: 30} (a typo for days) must 400, not silently build the all-time
  // map — the same closed-field discipline as every other write route.
  const typo = await post('/people/init', { day: 30 });
  assert.equal(typo.status, 400);
  assert.match((await typo.json()).error, /unknown field "day"/);

  const decideTypo = await post('/people/decide', { verdict: 'skip', a: 'x', b: 'y', note: 'hm' });
  assert.equal(decideTypo.status, 400);
  assert.match((await decideTypo.json()).error, /unknown field "note"/);

  // And the gate guards capability, not the feature: the bearer channel gets
  // a real review answer.
  const res = await fetch(base + '/people/review?days=0', {
    headers: { Authorization: `Bearer ${TEST_BEARER_TOKEN}` },
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(typeof out.people, 'number');
  assert.ok(Array.isArray(out.pairs));
});

test('admin operations validate source against the closed allowlist', async () => {
  // The probe must be a source that can never become real. This test once
  // probed with 'notes', which was unknown when it was written — then the
  // notes connector landed, 'notes' joined KNOWN_SOURCES, and the test went
  // red for reasons that had nothing to do with the allowlist.
  const res = await adminPost('/admin/retain', { source: 'no-such-source', keep_days: 30 });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  // The 400 must NAME the valid set, or a typo'd connector config becomes a
  // guessing game.
  for (const source of KNOWN_SOURCES) assert.match(error, new RegExp(source));
});

test('admin routes reject unknown fields rather than ignoring them', async () => {
  const res = await adminPost('/admin/maintain', { source: 'mail' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown field "source"/);
});

test('retain deletes only old rows of the named source', async () => {
  const now = Date.now();
  const DAY = 86_400_000;
  const seed = await adminPost('/ingest', [
    { ts: now - 40 * DAY, source: 'mail', entity_id: 'mail:old-1', text: 'old mail row' },
    { ts: now - 1 * DAY, source: 'mail', entity_id: 'mail:new-1', text: 'recent mail row' },
    { ts: now - 40 * DAY, source: 'granola', entity_id: 'granola:old-1', text: 'old granola row' },
  ]);
  assert.equal(seed.status, 200);
  const res = await adminPost('/admin/retain', { source: 'mail', keep_days: 30 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 1, claims_deleted: 0 });
  const left = admin.db
    .prepare('SELECT entity_id FROM context WHERE entity_id IS NOT NULL ORDER BY entity_id')
    .all()
    .map((r) => r.entity_id);
  // The other source's equally-old row and this source's recent row survive.
  assert.ok(left.includes('granola:old-1'));
  assert.ok(left.includes('mail:new-1'));
  assert.ok(!left.includes('mail:old-1'));
});

test('retain validates keep_days as an integer in 1..3650', async () => {
  for (const bad of [0, -3, 3651, 1.5, '30', null]) {
    const res = await adminPost('/admin/retain', { source: 'mail', keep_days: bad });
    assert.equal(res.status, 400, String(bad));
    assert.match((await res.json()).error, /keep_days/);
  }
});

test('purge deletes a source and physically cleans the index, immediately', async () => {
  const token = 'xylocarp';
  await adminPost('/ingest', [
    {
      ts: 1755000000000,
      source: 'granola',
      entity_id: 'granola:purge-1',
      text: `meeting notes about ${token} futures`,
    },
    { ts: 1755000001000, source: 'granola', text: `more ${token} discussion, unkeyed` },
  ]);
  assert.equal(ftsHits(admin.db, token), 2);
  const res = await adminPost('/admin/purge', { source: 'granola' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.maintained, true);
  // At least the two rows above; the retain test's surviving granola row may
  // also still be here, and purge means ALL of the source.
  assert.ok(body.deleted >= 2);
  assert.equal(
    Number(admin.db.prepare("SELECT count(*) AS n FROM context WHERE source = 'granola'").get().n),
    0
  );
  // Zero FTS matches, queried against context_fts directly...
  assert.equal(ftsHits(admin.db, token), 0);
  // ...and the token is gone from the database FILE, not merely tombstoned:
  // the rebuild rewrote the index's own pages and VACUUM under secure_delete
  // zeroed the freed ones. This is the assertion that makes "purged" purged.
  assert.ok(!readFileSync(adminDbPath).includes(token));
});

test('delete-entities requires source and entity_id to match as a pair', async () => {
  await adminPost('/ingest', [
    { ts: 1755000002000, source: 'calendar', entity_id: 'calendar:ev-1', text: 'standup occurrence' },
    { ts: 1755000003000, source: 'imessage', entity_id: 'imessage:msg-1', text: 'a message row' },
  ]);
  const res = await adminPost('/admin/delete-entities', {
    source: 'calendar',
    entity_ids: ['calendar:ev-1', 'imessage:msg-1'],
  });
  assert.equal(res.status, 200);
  // Only the pair matching on BOTH source and id is deleted.
  assert.deepEqual(await res.json(), { deleted: 1, claims_deleted: 0 });
  assert.equal(
    admin.db.prepare('SELECT source FROM context WHERE entity_id = ?').get('imessage:msg-1').source,
    'imessage'
  );
  assert.equal(
    Number(
      admin.db.prepare('SELECT count(*) AS n FROM context WHERE entity_id = ?').get('calendar:ev-1').n
    ),
    0
  );
});

test('delete-entities validates the batch shape', async () => {
  for (const [ids, why] of [
    [[], 'empty'],
    [Array.from({ length: 501 }, (_, i) => `calendar:x${i}`), 'over 500'],
    [['ok', 7], 'non-string member'],
  ]) {
    const res = await adminPost('/admin/delete-entities', { source: 'calendar', entity_ids: ids });
    assert.equal(res.status, 400, why);
  }
});

test('the entities endpoint returns entity_id and ts only, windowed', async () => {
  const T = 1600000000000; // a window far from every other fixture in this DB
  await adminPost('/ingest', [
    {
      ts: T + 1000,
      source: 'calendar',
      entity_id: 'calendar:win-a',
      text: 'occurrence a',
      speaker: 'parent',
      meta: { room: 'x' },
    },
    { ts: T + 2000, source: 'calendar', entity_id: 'calendar:win-b', text: 'occurrence b' },
    { ts: T + 9000, source: 'calendar', entity_id: 'calendar:win-late', text: 'outside the window' },
    { ts: T + 1500, source: 'calendar', text: 'unkeyed calendar row inside the window' },
    { ts: T + 1500, source: 'mail', entity_id: 'mail:win-1', text: 'other source inside the window' },
  ]);
  const res = await adminGet(`/admin/entities?source=calendar&from_ts=${T}&to_ts=${T + 5000}`);
  assert.equal(res.status, 200);
  const { entities } = await res.json();
  // ids + timestamps ONLY: no text, meta, speaker, or source may cross back.
  for (const e of entities) assert.deepEqual(Object.keys(e).sort(), ['entity_id', 'ts']);
  assert.deepEqual(entities, [
    { entity_id: 'calendar:win-a', ts: T + 1000 },
    { entity_id: 'calendar:win-b', ts: T + 2000 },
  ]);
});

test('the entities endpoint rejects unknown params and non-numeric bounds', async () => {
  assert.equal((await adminGet('/admin/entities?source=calendar&limit=5')).status, 400);
  assert.equal((await adminGet('/admin/entities?source=calendar&from_ts=abc')).status, 400);
  assert.equal((await adminGet('/admin/entities?source=nope')).status, 400);
});

test('the entities endpoint refuses to answer above the cap', async () => {
  const T = 1500000000000;
  const bulk = Array.from({ length: 5001 }, (_, i) => ({
    ts: T + i,
    source: 'health',
    entity_id: `health:steps:${i}`,
    text: `synthetic health row ${i}`,
  }));
  // Inserted directly: pushing 5001 rows through HTTP would only exercise the
  // body-size cap, which has its own test.
  assert.deepEqual(insertRows(admin.db, bulk), { inserted: 5001, updated: 0, unchanged: 0 });
  const over = await adminGet('/admin/entities?source=health');
  assert.equal(over.status, 413);
  assert.match((await over.json()).error, /narrow/);
  // A narrowed window under the cap answers normally.
  const under = await adminGet(`/admin/entities?source=health&from_ts=${T}&to_ts=${T + 99}`);
  assert.equal(under.status, 200);
  assert.equal((await under.json()).entities.length, 100);
});

test('maintain runs the physical cleanup and reports it', async () => {
  const res = await adminPost('/admin/maintain', {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { maintained: true });
});

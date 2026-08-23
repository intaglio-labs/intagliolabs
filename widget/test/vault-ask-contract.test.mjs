// The widget's consumer contract for POST /vault/ask — written by the
// frontend BEFORE the endpoint exists (MEMORY-PLAN Days 7-9), so whoever
// builds it can run this file against a live hermes and know the desktop
// widget will work. Until the route lands, every test skips with "route not
// built yet" rather than passing vacuously or failing noisily.
//
//   node --test 'widget/test/*.test.mjs'
//
// What the widget sends (Bridge.swift): a native URLSession request — NO
// Origin header (that absence selects hermes' bearer channel), bearer from
// ~/.hazlie/secrets/hermes-token.txt, body exactly {"utterance": "..."},
// client-side cap 2000 chars, 120s timeout, cancel via socket teardown.
//
// The expensive happy path (a real model answer) only runs when
// HZ_CONTRACT_LIVE=1 — everything else asserts auth and shape without
// touching llama.
// HERMETIC BY DEFAULT — changed 2026-08-22, and the reason matters.
//
// This file used to resolve BASE to the REAL launchd hermes on :8789 and read
// the owner's actual bearer out of ~/.hazlie/secrets. Running the widget suite
// therefore ran the full retrieve→compose path over the production context.db
// (339k rows of the owner's mail, messages and calendar), spent a real model
// call, and deliberately tore down a socket mid-request against the live
// process every connector writes through. A contract test is supposed to be
// the cheapest thing in the repo to run; this one was the most dangerous, and
// the practical result was that nobody dared run it — which means it protected
// nothing. A test people avoid is not a test.
//
// So the default now starts its own hermes on port 0 against a mkdtemp
// database with a test bearer, plus a stub llama on loopback so the model leg
// resolves without a model. Every assertion below is unchanged; only what they
// point at changed.
//
// HZ_CONTRACT_LIVE=1 restores the original behaviour — the real hermes, the
// real bearer, a real model call — because a smoke against the running service
// is genuinely worth having. It just has to be asked for.
//
// Importing hermes across the package line is deliberate: this is the widget's
// contract WITH hermes, so hermes is the thing under test, and spawning it as
// a subprocess to avoid one relative import would buy nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../ui/server/hermes.mjs';

const LIVE_MODE = process.env.HZ_CONTRACT_LIVE === '1';
const TEST_BEARER = 'c'.repeat(64);
const TEST_LLAMA_KEY = 'a'.repeat(64);

let HOST = '127.0.0.1';
let PORT = 8789;
let hermes = null;
let llamaStub = null;
let tmp = null;

function token() {
  if (!LIVE_MODE) return TEST_BEARER;
  return readFileSync(join(homedir(), '.hazlie', 'secrets', 'hermes-token.txt'), 'utf8').trim();
}

// Answers /v1/chat/completions in hermes' expected shape and nothing else, so
// the compose path can be exercised end to end without a model. It is NOT a
// model: it returns a fixed string, which is why the happy-path assertions
// below still only check SHAPE.
function startLlamaStub() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'stubbed answer', role: 'assistant' } }],
          model: 'stub',
          data: [{ id: 'stub' }],
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

before(async () => {
  if (LIVE_MODE) {
    const base = process.env.HERMES_BASE ?? 'http://127.0.0.1:8789';
    ({ hostname: HOST, port: PORT } = new URL(base));
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), 'hz-contract-'));
  llamaStub = await startLlamaStub();
  hermes = await start({
    port: 0,
    dbPath: join(tmp, 'context.db'),
    llamaApiKey: TEST_LLAMA_KEY,
    llamaBaseUrl: `http://127.0.0.1:${llamaStub.address().port}`,
    bearerToken: TEST_BEARER,
  });
  HOST = '127.0.0.1';
  PORT = hermes.port;
});

after(async () => {
  await hermes?.close();
  await new Promise((r) => (llamaStub ? llamaStub.close(r) : r()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function post(path, { body, headers = {}, timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest(
      {
        host: HOST, port: PORT, path, method: 'POST',
        headers: {
          ...(payload !== null ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Identity first — the port-8787 lesson. If 8789 isn't answering as hermes,
// every test below would be exercising a stranger.
async function hermesReady() {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: HOST, port: PORT, path: '/health', timeout: 3000 }, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => resolve({ status: r.statusCode, body: d.trim() }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
    return res.status === 200 && res.body === '{"ok":true}';
  } catch {
    return false;
  }
}

async function routeExists() {
  if (!(await hermesReady())) return false;
  const res = await post('/vault/ask', { body: { utterance: 'contract probe' }, headers: { authorization: `Bearer ${token()}` } });
  return res.status !== 404;
}

// The probe only applies to the live service, and it cannot run at module
// scope any more: in the default mode the server this file talks to is started
// by before(), which has not run yet when top-level await evaluates. Hermetic
// runs therefore skip nothing — we start hermes ourselves, so /vault/ask is
// there by construction. That is a real gain: the "route not built yet" skip
// dates from when this file was written ahead of the endpoint (MEMORY-PLAN
// Days 7-9), and the route has existed for a while, so on the owner's machine
// it was a skip that never fired and on anyone else's it silently greened the
// whole file.
const LIVE = LIVE_MODE ? await routeExists() : true;
const SKIP = LIVE
  ? false
  : { skip: 'HZ_CONTRACT_LIVE=1 but no hermes is answering on ' + `${HOST}:${PORT}` };

test('bearer channel: no Origin + valid bearer is accepted (not gated browser-only)', SKIP, async () => {
  const res = await post('/vault/ask', {
    body: { utterance: 'contract probe' },
    headers: { authorization: `Bearer ${token()}` },
  });
  // Anything but 401/403 proves the channel is open; 200 needs the model
  // and belongs to the LIVE test below.
  assert.ok(![401, 403].includes(res.status), `bearer channel refused: ${res.status} ${res.body}`);
});

test('a wrong bearer is 401, indistinguishable from missing', SKIP, async () => {
  const wrong = await post('/vault/ask', {
    body: { utterance: 'x' },
    headers: { authorization: `Bearer ${'ab'.repeat(32)}` },
  });
  const missing = await post('/vault/ask', { body: { utterance: 'x' } });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
});

test('a missing or empty utterance is a 4xx, never a model call', SKIP, async () => {
  for (const body of [{}, { utterance: '' }, { utterance: 42 }]) {
    const res = await post('/vault/ask', { body, headers: { authorization: `Bearer ${token()}` } });
    assert.ok(res.status >= 400 && res.status < 500, `bad utterance must 4xx: ${JSON.stringify(body)} → ${res.status}`);
  }
});

test('an oversized utterance does not 500', SKIP, async () => {
  const res = await post('/vault/ask', {
    body: { utterance: 'x'.repeat(4000) },
    headers: { authorization: `Bearer ${token()}` },
  });
  assert.ok(res.status < 500, `4000 chars → ${res.status}; cap it (VOICE-PLAN names 2000), don't crash`);
});

test('a client abort does not wedge the next request', SKIP, async () => {
  // The widget's Cancel is a socket teardown mid-request; per VOICE-PLAN
  // §3.6 the handler turns close into an AbortSignal on the llama call.
  await new Promise((resolve) => {
    const req = httpRequest(
      {
        host: HOST, port: PORT, path: '/vault/ask', method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      },
      () => {}
    );
    req.on('error', () => resolve()); // our own teardown surfaces here
    req.write(JSON.stringify({ utterance: 'what does my week look like?' }));
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 300);
  });
  const after = await post('/vault/ask', { body: { utterance: '' }, headers: { authorization: `Bearer ${token()}` } });
  assert.ok(after.status >= 400 && after.status < 500, `hermes wedged after abort: ${after.status}`);
});

test('LIVE: a real answer is buffered JSON of exactly {text, sources, usedRows}', 
  LIVE && process.env.HZ_CONTRACT_LIVE === '1' ? false : { skip: LIVE ? 'set HZ_CONTRACT_LIVE=1 to spend a model call' : '/vault/ask not built yet' },
  async (t) => {
    // With zero accepted claims every question abstains, and this test would
    // pass identically against a compose path that is completely broken —
    // the exact failure mode that shipped once. A check that cannot fail is
    // worse than no check, so skip LOUDLY rather than green-wash.
    const counts = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: HOST, port: PORT, path: '/admin/memory/counts', headers: { authorization: `Bearer ${token()}` } },
        (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d))); }
      );
      req.on('error', reject);
      req.end();
    });
    if (!counts.accepted) {
      t.skip('0 accepted claims — the compose path is unreachable; review claims at /c/<token>/memory first');
      return;
    }
    const res = await post('/vault/ask', {
      body: { utterance: 'how is my day looking?' },
      headers: { authorization: `Bearer ${token()}` },
      timeout: 120_000,
    });
    assert.equal(res.status, 200, res.body);
    assert.match(res.headers['content-type'] ?? '', /application\/json/, 'buffered JSON, not SSE — the endpoint is explicitly not streaming');
    const obj = JSON.parse(res.body);
    assert.equal(typeof obj.text, 'string');
    assert.ok(Array.isArray(obj.sources) && obj.sources.every((s) => typeof s === 'string'),
      'sources must be source NAMES — a row object here is a corpus-boundary breach');
    assert.equal(typeof obj.usedRows, 'number');
    // Accepted claims exist (checked above) and recall tops up
    // unconditionally, so a working compose path MUST have consulted rows.
    assert.ok(obj.usedRows > 0, 'usedRows must be > 0 when accepted claims exist — 0 means the compose path never ran');
    assert.deepEqual(Object.keys(obj).sort(), ['sources', 'text', 'usedRows'],
      'no extra fields: anything beyond {text, sources, usedRows} is surface the boundary must then defend');
  });

// ---------------------------------------------------------------------------
// EVERY BRANCH, ONE SHAPE.
//
// /vault/ask does not have one exit. Sync-status, person-search, abstention and
// the composed answer each build their own response object and return early, and
// until now exactly one of those was shape-checked -- inside the test named
// LIVE, which needs HZ_CONTRACT_LIVE=1 and a real model. On a normal run the
// contract was unasserted on every path.
//
// This is the seam worth guarding, because both of the sibling project's
// escaped crashes lived in it: the suite stopped at the retrieval call and the
// renderer downstream read two fields the query never selected. Nothing was
// wrong with the tests; they were short.
//
// What depends on the shape here, concretely:
//   Bridge.swift  obj["sources"] as? [String] ?? []   -- a wrong element type
//                 does not throw, it silently yields [] and the citation
//                 disappears with no error anywhere.
//   chat.js       data.sources.join(' · ')            -- objects would render
//                 as "[object Object]" in the panel.
//   chat.js       pending.textContent = data.text     -- a missing text reads
//                 as the literal string "undefined".
//
// None of those three fail loudly. That is the whole argument for asserting the
// shape on every branch rather than the one the happy path takes.
const ASK_KEYS = ['sources', 'text', 'usedRows'];

function assertAskShape(res, label) {
  assert.equal(res.status, 200, `${label}: ${res.body}`);
  assert.match(res.headers['content-type'] ?? '', /application\/json/u, `${label}: JSON`);
  const obj = JSON.parse(res.body);
  assert.deepEqual(
    Object.keys(obj).sort(),
    ASK_KEYS,
    `${label}: every branch returns exactly {text, sources, usedRows}`
  );
  assert.equal(typeof obj.text, 'string', `${label}: text is a string`);
  assert.ok(obj.text.length > 0, `${label}: text is never empty -- chat.js renders it directly`);
  assert.ok(Array.isArray(obj.sources), `${label}: sources is an array`);
  assert.ok(
    obj.sources.every((s) => typeof s === 'string'),
    `${label}: sources are STRINGS -- Swift's [String] cast fails silently on objects`
  );
  assert.equal(typeof obj.usedRows, 'number', `${label}: usedRows is a number`);
  assert.ok(Number.isFinite(obj.usedRows) && obj.usedRows >= 0, `${label}: usedRows is finite and >= 0`);
  return obj;
}

const ask = (utterance) =>
  post('/vault/ask', {
    body: { utterance },
    headers: { authorization: `Bearer ${token()}` },
  });

test('abstention returns the same shape as an answer, not a bare error', SKIP, async () => {
  // On an empty store the abstain branch fires before a model is involved.
  // It still has to look like every other answer to the panel rendering it.
  const obj = assertAskShape(await ask('what is my favourite film?'), 'abstain');
  assert.deepEqual(obj.sources, [], 'an abstention cites nothing');
  assert.equal(obj.usedRows, 0, 'and rests on no rows');
});

test('the sync-status branch returns the ask shape', SKIP, async () => {
  // Seeded through the sanctioned write path rather than a second database
  // handle -- hermes is the sole writer and a test should not be the exception
  // that proves it is not.
  const ingest = await post('/ingest', {
    body: [
      { source: 'imessage', entity_id: 'w:1', ts: Date.now() - 3_600_000, text: 'morning', speaker: 'Austin' },
      { source: 'imessage', entity_id: 'w:2', ts: Date.now() - 1_800_000, text: 'on my way', speaker: 'Austin' },
    ],
    headers: { authorization: `Bearer ${token()}` },
  });
  assert.equal(ingest.status, 200, `seed failed: ${ingest.body}`);

  // Freshness questions are answered by code from timestamps -- no model, no
  // claims. A distinct branch, and one a renderer sees just as often.
  for (const q of ['am i up to date?', 'is anything behind?']) {
    assertAskShape(await ask(q), `sync-status: ${q}`);
  }
});

test('a long-but-legal utterance still returns the ask shape', SKIP, async () => {
  // Just under the documented 2000-char client cap. The oversize test above
  // proves it does not 500; this proves the in-bounds case still answers in
  // contract rather than falling out of a branch that forgot a field.
  assertAskShape(await ask('what did i say about '.repeat(90).slice(0, 1900)), 'long utterance');
});

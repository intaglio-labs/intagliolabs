// The dev desk's CSRF fetch wrapper (ui/devtools/review/index.html).
//
// The page is one inline classic script -- one file, no module graph, no
// extra request -- so this test slices the wrapper out between the two
// marker comments in that file and evaluates it against a stub `window`.
// Everything it runs is the shipped source, byte for byte; only the
// platform around it is stubbed.
//
// Review G finding 10, both halves:
//
//   - methodOf/baseHeaders were added for `input instanceof Request`, but
//     the retry handed the SAME Request back to fetch. A Request's body is a
//     single-use stream that the first attempt disturbs, so the retry raised
//     a TypeError rather than retrying.
//   - a retry that still 403'd THREW from window.fetch, turning an answer
//     the wrapper had already received into a rejection. Every write site in
//     the desk does `if (!res.ok) throw new Error(await res.text())` inside
//     its own try/catch; one without a catch got an unhandled rejection
//     instead of an error banner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESK = join(dirname(fileURLToPath(import.meta.url)), '..', 'devtools', 'review', 'index.html');
const BEGIN = '// ---- BEGIN CSRF FETCH WRAPPER ----';
const END = '// ---- END CSRF FETCH WRAPPER ----';
const TOKEN = 'c'.repeat(64);

function loadWrapper(stubFetch) {
  const html = readFileSync(DESK, 'utf8');
  const from = html.indexOf(BEGIN);
  const to = html.indexOf(END);
  assert.ok(from !== -1 && to > from, 'the wrapper markers must still be in index.html');
  const source = html.slice(from, to);
  const window = { fetch: stubFetch };
  // The wrapper reads Headers/Request/Response off the global scope, which in
  // a browser is `window`; here they are Node's own, which are the same
  // implementations.
  const build = new Function('window', 'Headers', 'Request', 'Response', source);
  build(window, Headers, Request, Response);
  return window.fetch;
}

// A stub standing in for the desk server. `answer` decides each write's
// response; every write's URL, the CSRF header it carried, and THE BODY THAT
// ACTUALLY ARRIVED are recorded -- the body is the whole point, and reading
// it disturbs a Request exactly as a real fetch does.
function stubServer(answer) {
  const writes = [];
  let csrfFetches = 0;
  const fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/api/csrf')) {
      csrfFetches += 1;
      return new Response(JSON.stringify({ token: TOKEN }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    let body = null;
    if (typeof input !== 'string' && typeof input.text === 'function') body = await input.text();
    else if (init && init.body != null) body = String(init.body);
    writes.push({ url, body, csrf: new Headers(init?.headers).get('X-Hazlie-Csrf') });
    return answer(writes.length);
  };
  return { fetch, writes, csrfCount: () => csrfFetches };
}

const staleTokenRejection = () => new Response(
  JSON.stringify({ error: 'missing or bad X-Hazlie-Csrf header' }),
  { status: 403, headers: { 'Content-Type': 'application/json' } }
);
const accepted = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

test('a Request write whose token went stale is retried WITH ITS BODY', async () => {
  const server = stubServer((n) => (n === 1 ? staleTokenRejection() : accepted()));
  const fetch = loadWrapper(server.fetch);
  const payload = JSON.stringify({ claim_id: 7, action: 'accept' });

  const res = await fetch(new Request('http://desk.test/api/decide', {
    method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' },
  }));

  assert.equal(res.status, 200, 'the retry succeeded rather than raising a TypeError');
  assert.equal(server.writes.length, 2, 'one attempt, one retry');
  assert.equal(server.writes[1].body, payload,
    'the retry resent the whole body -- the first attempt consumed the original stream');
  assert.equal(server.writes[1].csrf, TOKEN, 'with the freshly minted token');
});

test('a plain URL + init write is retried the same way', async () => {
  const server = stubServer((n) => (n === 1 ? staleTokenRejection() : accepted()));
  const fetch = loadWrapper(server.fetch);
  const payload = JSON.stringify({ findingKey: 'k', resolution: 'ok' });

  const res = await fetch('/api/lint/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(server.writes.map((w) => w.body), [payload, payload]);
});

test('a retry that still 403s ANSWERS 403 rather than rejecting', async () => {
  const server = stubServer(() => staleTokenRejection());
  const fetch = loadWrapper(server.fetch);

  const res = await fetch('/api/decide', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  const text = await res.text();
  assert.match(text, /reload the desk/u,
    'and the message every write site already renders as a banner is in the body');
  assert.equal(server.writes.length, 2, 'retried exactly once, never in a loop');
});

test('a 403 that does not name the CSRF header is returned untouched', async () => {
  // guard.mjs's host and origin refusals are also 403 and must not be
  // mistaken for a stale token: no token re-fetch, no retry.
  const server = stubServer(() => new Response(
    JSON.stringify({ error: 'refused: Host is not loopback' }), { status: 403 }
  ));
  const fetch = loadWrapper(server.fetch);

  const res = await fetch('/api/decide', { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
  assert.equal(server.writes.length, 1, 'no retry for a refusal that is not about the token');
  assert.match(await res.text(), /Host is not loopback/u, 'and the real reason survives');
});

test('a GET never fetches a token and never carries the header', async () => {
  const server = stubServer(() => accepted());
  const fetch = loadWrapper(server.fetch);

  await fetch('/api/cards');
  assert.equal(server.csrfCount(), 0, 'a read needs no token');
  assert.equal(server.writes[0].csrf, null);
});

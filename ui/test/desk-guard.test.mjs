// The dev desk's request guard (ui/devtools/review/guard.mjs).
//
// The desk proxies eight WRITES to hermes with hermes' own bearer attached,
// and asks for no credential of its own. Binding to 127.0.0.1 stops another
// machine; it does nothing about another tab in the owner's browser, which
// reaches loopback as readily as the desk's own page does. Before this guard,
// any page could fire /api/lookup/person -- blind, and still spending the
// subscription, causing egress and writing pending claims about real people
// -- and a rebound hostname could read /api/pending (message bodies) and
// /api/cards (names and quotes).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeskGuard, CSRF_HEADER } from '../devtools/review/guard.mjs';

const PORT = 7311;
const req = (method, headers) => ({ method, headers });

test('a loopback GET addressed to this desk is allowed, with or without an Origin', () => {
  const { refuse } = createDeskGuard(PORT);
  assert.equal(refuse(req('GET', { host: `127.0.0.1:${PORT}` })), null);
  assert.equal(refuse(req('GET', { host: `localhost:${PORT}` })), null);
  assert.equal(
    refuse(req('GET', { host: `127.0.0.1:${PORT}`, origin: `http://localhost:${PORT}` })),
    null
  );
});

test('a DNS-rebound Host is refused, which is what closes the read half', () => {
  const { refuse } = createDeskGuard(PORT);
  // The browser sends the attacker's hostname in Host even once it resolves
  // to 127.0.0.1 -- so Host, not the socket's peer address, is the check.
  for (const host of ['evil.example.com', `evil.example.com:${PORT}`, `127.0.0.1:${PORT + 1}`, '']) {
    const out = refuse(req('GET', { host }));
    assert.ok(out, `Host ${JSON.stringify(host)} must be refused`);
    assert.equal(out.status, 403);
    assert.match(out.error, /127\.0\.0\.1/u);
  }
});

test('a cross-site Origin is refused even on a read', () => {
  const { refuse } = createDeskGuard(PORT);
  const out = refuse(req('GET', { host: `127.0.0.1:${PORT}`, origin: 'https://evil.example.com' }));
  assert.ok(out);
  assert.equal(out.status, 403);
  assert.match(out.error, /cross-origin/u);
});

test('a write with no CSRF token is refused; the desk\'s own token lets it through', () => {
  const { refuse, csrfToken } = createDeskGuard(PORT);
  const host = `127.0.0.1:${PORT}`;

  // THE ATTACK. A preflight-free cross-site POST arrives looking like this:
  // same Host (the browser fills it in), an Origin the attacker cannot forge,
  // and no header a cross-site fetch is allowed to add without a preflight.
  const bare = refuse(req('POST', { host }));
  assert.ok(bare, 'a write with no token must be refused');
  assert.equal(bare.status, 403);
  assert.match(bare.error, new RegExp(CSRF_HEADER, 'u'));

  assert.ok(refuse(req('POST', { host, [CSRF_HEADER]: 'wrong' })));
  assert.ok(refuse(req('POST', { host, [CSRF_HEADER]: `${csrfToken}x` })), 'a prefix is not a match');
  assert.equal(refuse(req('POST', { host, [CSRF_HEADER]: csrfToken })), null);
});

test('the token is per process and long enough to be unguessable', () => {
  const a = createDeskGuard(PORT).csrfToken;
  const b = createDeskGuard(PORT).csrfToken;
  assert.notEqual(a, b, 'two desks must not share a token');
  assert.ok(a.length >= 32);
  // And one desk's token is useless at another: the guard compares against
  // its own, not a shared constant.
  const second = createDeskGuard(PORT);
  assert.ok(second.refuse(req('POST', { host: `127.0.0.1:${PORT}`, [CSRF_HEADER]: a })));
});

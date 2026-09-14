// The dev desk's request guard. Lives beside serve.mjs, not under ui/server:
// that directory ships in the app bundle (widget/build.sh copies it
// wholesale) and this is a development-only concern -- the same reasoning
// support.mjs's placement already follows.
//
// Split out of serve.mjs so it can be tested: serve.mjs reads the hermes
// bearer, opens the corpus read-only and binds a port at import time, so
// nothing can import it to ask a question about one header.
//
// THE DESK IS A CONFUSED DEPUTY, AND BINDING TO 127.0.0.1 DOES NOT FIX IT.
//
// Every call serve.mjs proxies carries hermes' bearer, and the desk itself
// asks for nothing. Loopback binding stops another MACHINE
// reaching it; it does nothing about another PAGE in the owner's own browser,
// which reaches 127.0.0.1 as readily as this page does. Eight of the routes
// there are writes -- verdicts, decisions, sub-role overrides, a page build, a
// lookup pass that spends the subscription and causes egress -- and a
// cross-site `fetch('http://127.0.0.1:7311/api/lookup/person', {method:
// 'POST', ...})` with a preflight-free content type fires them all. The
// attacker cannot READ the response (no CORS headers, and none are wanted),
// which is exactly why this was invisible: it is blind, and it still spends
// the account and writes pending claims about real people.
//
// DNS rebinding is the read half of the same hole: a hostname the attacker
// controls, re-resolved to 127.0.0.1, makes the browser treat this origin as
// theirs and hands them /api/pending (message bodies) and /api/cards (names
// and quotes).
//
// Three checks, cheapest first:
//   1. HOST -- the request must be addressed to this server by a loopback
//      name. A rebound hostname arrives with ITS name in Host, so this one
//      check closes rebinding for reads and writes alike.
//   2. ORIGIN -- present and not ours means a cross-site caller. Same-origin
//      GETs send no Origin, and same-origin writes send ours.
//   3. A CSRF TOKEN on every write, minted per process, fetched once by the
//      page over an ordinary same-origin GET (which a cross-site script
//      cannot read the body of). Belt to the Origin check's braces.
//
// DEV ONLY, still. ui/devtools is in neither of widget/build.sh's copy lists,
// so none of this ships -- but "it is a dev tool" is not a reason to leave a
// write path in the owner's browser open to any tab they have.

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER = 'x-hazlie-csrf';

function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// createDeskGuard(port) -> { csrfToken, refuse }. One token per process: the
// desk has no sessions and no users, and a token that outlives the process
// would have to be stored somewhere.
export function createDeskGuard(port, { csrfToken = randomBytes(32).toString('hex') } = {}) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`createDeskGuard: port must be a positive integer, got ${port}`);
  }
  if (typeof csrfToken !== 'string' || csrfToken.length < 16) {
    throw new Error('createDeskGuard: csrfToken override must be a string of at least 16 characters');
  }
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`,
  ]);
  // Browsers omit the port from Host/Origin on the default HTTP port (80), so
  // a desk running there would refuse every request unless the bare host is
  // also allowed.
  if (port === 80) {
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('localhost');
    allowedHosts.add('[::1]');
    allowedOrigins.add('http://127.0.0.1');
    allowedOrigins.add('http://localhost');
    allowedOrigins.add('http://[::1]');
  }

  // Returns null when the request may proceed, else {status, error}.
  function refuse(req) {
    const host = String(req?.headers?.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return { status: 403, error: 'this desk answers only to 127.0.0.1/localhost on its own port' };
    }
    const origin = req?.headers?.origin;
    if (typeof origin === 'string' && origin.length > 0 && !allowedOrigins.has(origin.toLowerCase())) {
      return { status: 403, error: 'cross-origin request refused' };
    }
    const method = String(req?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD'
        && !sameSecret(req?.headers?.[CSRF_HEADER], csrfToken)) {
      return { status: 403, error: `missing or wrong ${CSRF_HEADER}; reload the desk` };
    }
    return null;
  }

  return { csrfToken, refuse };
}

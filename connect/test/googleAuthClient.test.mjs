// WHICH CLIENT THE BUTTON SIGNS IN WITH.
//
// POST /api/google-auth used to pass the literal string "default" straight to
// ops/gcal-auth.mjs, and "default" meant the two legacy files in
// ~/.hazlie/secrets. On a fresh install those do not exist, the helper exited
// before printing a URL, and the route answered its 502 — an honest answer to a
// question nobody had to ask, because the app ships a client of its own
// (clean-machine retest, 2026-09-12).
//
// "default" is not a client name here, it is "whichever one this install should
// use", and connectors/lib/googleClients.mjs answers that. The RESOLUTION is
// tested there, against real directories, in
// connectors/test/googleClientsBundled.test.mjs. What is pinned here is the
// wiring, which those tests cannot see:
//
//   * the route asks the registry BEFORE it validates membership — resolving
//     afterwards would 400 on a name the registry was about to supply, or
//     spawn the helper with "default" and land back on the 502;
//   * the resolved name, not the requested one, is what reaches the command
//     line;
//   * the bodies the page renders still carry no credential.
//
// Source-shaped rather than a live request, deliberately: exercising this route
// for real spawns the OAuth helper, which binds its fixed callback port and
// then waits fifteen minutes for a human. A test that did that would leave one
// behind on every run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(CONNECT, 'server.mjs'), 'utf8');

const route = /if \(url\.pathname === '\/api\/google-auth'\) \{([\s\S]*?)\n {4}return;/u.exec(
  server
)?.[1];

test('the route resolves "default" through the registry', () => {
  assert.ok(route, '/api/google-auth is gone, or no longer shaped like a route');
  assert.match(
    server,
    /import \{[^}]*defaultGoogleClient[^}]*\} from '\.\.\/connectors\/lib\/googleClients\.mjs';/u,
    'the resolver has to come from the one module that knows every place a client can live'
  );
  assert.match(route, /defaultGoogleClient\(\)/u);
});

test('it resolves BEFORE it checks membership, not after', () => {
  // The other order 400s on a name the registry was about to supply, or sends
  // the helper the literal "default" and lands back on the 502 this fixes.
  const resolved = route.indexOf('defaultGoogleClient()');
  const checked = route.indexOf('listGoogleClients()');
  assert.ok(resolved > -1 && checked > -1);
  assert.ok(resolved < checked, 'resolution must precede the membership check');
});

test('the RESOLVED name is what reaches the command line', () => {
  // `client` is the variable the spawn interpolates; a resolution written to
  // some other local would be a no-op that still passed the two tests above.
  assert.match(route, /client = asked;/u);
  assert.match(
    route,
    /spawn\(process\.execPath, \[scriptPath, '--print-url', '--client', client\]/u
  );
});

test('an empty client string is treated as "not named", not as a name', () => {
  // JSON.parse of `{"client":""}` yields a string, and a bare typeof check
  // would send the helper an empty --client argument.
  assert.match(route, /typeof body\.client === 'string' && body\.client \? body\.client : 'default'/u);
});

test('an unregistered name is still refused rather than passed through', () => {
  // This value becomes a command-line argument. Membership is the guarantee.
  assert.match(route, /no OAuth client named "\$\{asked\}"/u);
  assert.match(route, /send\(res, 400,/u);
});

test('nothing the page renders carries a credential', () => {
  // The three bodies this route can answer with, unchanged by the resolution
  // work: they name a fix, never a value.
  for (const body of [
    'the authorization helper is not installed beside this server',
    'the authorization helper did not start; check that the Google client credential is installed',
    'could not start the authorization helper',
  ]) {
    assert.ok(route.includes(body), `the route no longer answers with: ${body}`);
  }
  assert.doesNotMatch(route, /client_secret|clientSecret/u);
  assert.doesNotMatch(route, /\.secret\b/u, 'a resolved client\'s secret has no business here');
});
